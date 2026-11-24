/**
 * CONTRAT du multijoueur réseau (lot 1, prototype) : types, constantes et petites fonctions pures. Conception complète : docs/NET.md.
 *
 * Ce fichier est FIGÉ pour les trois lots d'implémentation (A : protocole / transports / sessions, B : cœur + scène de jeu, C : salon et menu) :
 * ils l'IMPORTENT, ne le redéfinissent pas et ne le modifient pas (un besoin de changement se signale dans « deviations » du compte rendu).
 *
 * Modèle (décisions actées) :
 *  - HÔTE AUTORITAIRE : l'hôte (joueur 0) exécute `GameSimulation` à 60 Hz avec ses entrées + celles des clients et diffuse l'état à 20 Hz ;
 *    les clients ne simulent pas : ils MIROIRENT l'état reçu (`GameSimulation.applyMirrorState`, lot B) et envoient leurs entrées ;
 *  - UN canal fiable et ordonné par client (messages JSON texte) ; messages longs fragmentés (`MsgFrag`) ;
 *  - trois `Transport` interchangeables : Loopback (tests), BroadcastChannel (développement, `?net=bc`), WebRTC DataChannel (signalisation manuelle).
 *
 * Aucune dépendance à Phaser ni au DOM ici ; aucune horloge (les sessions reçoivent `nowMs` de leur appelant).
 */
import type { BuildInfo } from '../buildInfo';
import type { ActionFrame, CharacterId, Difficulty, GameState, PlayerId, PlayerSetup, SimEvent, TickInputs } from '../core/types';
import type { GameSession } from '../render/session';
import type { Unsubscribe } from './NetAdapter';

// ───────────────────────────── Constantes ─────────────────────────────

/** Version du protocole : à incrémenter à toute modification INCOMPATIBLE des messages ; vérifiée à la connexion (`hello` / `reject`). */
export const NET_PROTOCOL_VERSION = 1;

/** Réglages du réseau. Valeurs de départ du prototype : à ajuster d'après les essais sur téléphones, jamais en dur ailleurs. */
export const NET = {
  /** 2 à 4 participants (hôte compris). */
  MAX_PLAYERS: 4,
  MIN_PLAYERS: 2,
  /** Un instantané tous les 3 pas de simulation (60 Hz) = 20 Hz. */
  SNAPSHOT_EVERY_TICKS: 3,
  /** Intervalle nominal (ms) entre deux instantanés (3 × 1000/60) : base de l'interpolation côté client. */
  SNAPSHOT_INTERVAL_MS: 50,
  /** Bornes (ms) de l'intervalle d'interpolation estimé par le client (moyenne mobile des intervalles d'arrivée). */
  INTERP_MIN_MS: 40,
  INTERP_MAX_MS: 120,
  /** Période minimale (ms) entre deux messages `input` d'un client (30 Hz) ; les appuis courts sont mémorisés (OU) entre deux envois. */
  INPUT_SEND_MS: 33,
  /** Une entrée distante plus vieille que ça (ms) est remplacée par une frame vide côté hôte (message perdu / client gelé : jamais d'attaque « collée »). */
  INPUT_STALE_MS: 250,
  /** Taille maximale (caractères) d'un message émis ; au-delà : fragmentation (`MsgFrag`). Sûr pour les piles DataChannel à 16 Ko (Safari, Firefox). */
  FRAGMENT_CHARS: 12000,
  /** Taille maximale (caractères) d'un message brut OU réassemblé ; au-delà : rejet avant `JSON.parse`. */
  MAX_MESSAGE_CHARS: 262144,
  /** Nombre maximal de fragments d'un message. */
  MAX_FRAGMENTS: 32,
  /** Une réassemblage incomplet plus vieux que ça (ms) est abandonné. */
  REASSEMBLY_TIMEOUT_MS: 3000,
  /** Seuil (octets) de `Transport.bufferedAmount` au-delà duquel l'hôte N'ENVOIE PAS d'instantané à ce client (jamais de file qui grossit). */
  BUFFERED_HIGH_WATER: 262144,
  /** Délai (ms) accordé à un invité pour envoyer `hello` après l'ouverture du canal. */
  HELLO_TIMEOUT_MS: 5000,
  /** Période (ms) des `ping` de l'hôte (salon et partie). */
  PING_INTERVAL_MS: 2000,
  /** Silence (ms, aucun message reçu) au bout duquel un pair est déclaré perdu. */
  PEER_TIMEOUT_MS: 6000,
  /** Côté invité en partie : sans instantané depuis ce délai (ms), la scène affiche « connexion instable » (la liaison n'est pas encore déclarée perdue). */
  STALL_WARN_MS: 1000,
  /** Événements de simulation mis en attente au plus (par client, côté hôte ET côté client) ; au-delà, les plus anciens sont jetés sauf `SIM_EVENTS_NEVER_DROPPED`. */
  MAX_PENDING_EVENTS: 512,
  /** Longueur maximale (points de code) du nom affiché d'un joueur. */
  NAME_MAX_CHARS: 16,
  /** Longueur maximale (caractères) d'un code d'invitation / de réponse collé. */
  CODE_MAX_CHARS: 4096,
  /** Messages mal formés tolérés d'un pair avant fermeture de sa liaison. */
  MAX_MALFORMED: 20,
  /** Cadences maximales acceptées d'un client (par seconde) ; les messages en trop sont ignorés. */
  MAX_INPUT_PER_SEC: 120,
  MAX_CHOICE_PER_SEC: 10,
} as const;

/** Nom du canal BroadcastChannel du mode développement (`?net=bc`). */
export const NET_BC_CHANNEL = 'vaelorn-net-dev';

// ───────────────────────────── Rôles, phases, raisons ─────────────────────────────

export type NetRole = 'host' | 'client';

/** Phase d'une session HÔTE. */
export type HostPhase = 'lobby' | 'playing' | 'closed';
/** Phase d'une session CLIENT. */
export type ClientPhase = 'connecting' | 'handshaking' | 'lobby' | 'playing' | 'closed';

/** Pourquoi l'hôte refuse un invité (`MsgReject`). Ordre des vérifications : protocole, build, niveaux, partie en cours, salon plein, message invalide. */
export type RejectReason = 'protocol' | 'build' | 'levels' | 'started' | 'full' | 'malformed';

/** Pourquoi une partie réseau se termine pour tous (`MsgEnd`) : la liaison reste ouverte, tout le monde retourne au salon. */
export type NetEndReason = 'levelCompleted' | 'hostQuit' | 'aborted';

/** Pourquoi une session CLIENT est fermée (côté invité). */
export type NetCloseReason =
  | 'userLeft' // l'invité a quitté
  | 'hostLeft' // l'hôte a fermé le salon proprement (`leave`)
  | 'hostLost' // l'hôte ne répond plus (silence > PEER_TIMEOUT_MS)
  | 'transportFailed' // le canal s'est fermé / a échoué
  | 'protocolError' // trop de messages invalides, état de jeu rejeté
  | 'rejected'; // refus à la connexion (voir `NetClosedInfo.reject`)

export interface RejectInfo {
  reason: RejectReason;
  /** Données de l'HÔTE, pour que l'invité puisse afficher la différence (« l'hôte est en v0.1.0 · a1b2c3d »). */
  hostProto: number;
  hostBuild: BuildInfo;
  hostLevels: number;
}

export interface NetClosedInfo {
  reason: NetCloseReason;
  /** Présent seulement avec `reason === 'rejected'`. */
  reject?: RejectInfo;
}

/** Code de message utilisateur (clé i18n : `net.notice.<code>`, voir `noticeKey`). */
export type NetNoticeCode =
  | 'levelCompleted'
  | 'hostQuit'
  | 'aborted'
  | 'hostLeft'
  | 'hostLost'
  | 'transportFailed'
  | 'protocolError'
  | 'reject.protocol'
  | 'reject.build'
  | 'reject.levels'
  | 'reject.started'
  | 'reject.full'
  | 'reject.malformed';

/** Message affiché à l'arrivée sur le salon ou le menu (JSON pur, passé de scène en scène). `params` : valeurs d'interpolation `{x}` de la chaîne traduite. */
export interface NetNotice {
  code: NetNoticeCode;
  params?: Record<string, string | number>;
}

/** Clé i18n du message (chaque code a une clé dans `net.fr.json` / `net.en.json`). */
export function noticeKey(code: NetNoticeCode): string {
  return `net.notice.${code}`;
}

/** Message correspondant à la fin d'une partie. */
export function noticeForEnd(reason: NetEndReason): NetNotice {
  return { code: reason };
}

/** Message correspondant à la fermeture d'une session client ; null pour un départ volontaire (`userLeft`, aucun message). */
export function noticeForClose(info: NetClosedInfo): NetNotice | null {
  switch (info.reason) {
    case 'userLeft':
      return null;
    case 'rejected':
      return { code: `reject.${info.reject?.reason ?? 'malformed'}` };
    default:
      return { code: info.reason };
  }
}

// ───────────────────────────── Transport ─────────────────────────────

export type TransportKind = 'loopback' | 'broadcast' | 'webrtc';
export type TransportState = 'connecting' | 'open' | 'closed';

/**
 * Canal FIABLE et ORDONNÉ de messages TEXTE entre deux pairs (hôte ↔ UN invité). Ne connaît ni JSON ni fragmentation (couche `protocol.ts`).
 * Les rappels sont appelés de façon asynchrone par rapport à `send` du pair (jamais depuis l'intérieur de `send`), sauf le Loopback en mode synchrone.
 * Un message est livré en entier ou pas du tout, dans l'ordre d'envoi.
 */
export interface Transport {
  readonly kind: TransportKind;
  readonly state: TransportState;
  /** Octets en attente d'envoi (`RTCDataChannel.bufferedAmount`) ; 0 quand la pile ne le dit pas. */
  readonly bufferedAmount: number;
  /** Taille maximale (caractères) d'un message accepté par `send` (la fragmentation de `protocol.ts` s'y plie). */
  readonly maxMessageChars: number;
  /** @throws Error si le canal n'est pas `open` ou si le message dépasse `maxMessageChars`. */
  send(text: string): void;
  /** Abonne un rappel aux messages reçus. */
  onMessage(cb: (text: string) => void): Unsubscribe;
  /** Abonne un rappel aux changements d'état FUTURS (lire `state` pour l'état courant). Passage à `closed` : une seule fois, avec une raison lisible (journal, pas affichée). */
  onState(cb: (state: TransportState, reason?: string) => void): Unsubscribe;
  /** Ferme le canal (idempotent). */
  close(reason?: string): void;
}

export interface LoopbackOptions {
  /** Taille maximale d'un message (défaut `NET.FRAGMENT_CHARS` + marge d'enveloppe) : fait échouer les tests qui oublient de fragmenter. */
  maxMessageChars?: number;
  /** true : livraison synchrone à `send` ; false (défaut) : mise en file, livrée par `flush()` (tests déterministes d'ordre / de retard). */
  synchronous?: boolean;
}

/** Paire de transports en mémoire reliés l'un à l'autre (tests). */
export interface LoopbackPair {
  readonly a: Transport;
  readonly b: Transport;
  /** Livre les messages en file (dans les deux sens) ; retourne le nombre livré. Sans effet en mode synchrone. */
  flush(): number;
  /** Nombre de messages en file. */
  pending(): number;
  /** Simule une pile saturée : valeur renvoyée par `bufferedAmount` des deux extrémités. */
  setBufferedAmount(bytes: number): void;
  /** Simule une coupure franche (les deux extrémités passent à `closed`). */
  cut(reason?: string): void;
}

/** Hôte BroadcastChannel (développement) : les invités arrivent d'eux-mêmes, sans code à copier. */
export interface BroadcastHostLink {
  readonly channelName: string;
  /** Appelé pour chaque nouvel invité (un `Transport` point à point dédié, déjà ouvert). */
  onGuest(cb: (transport: Transport) => void): Unsubscribe;
  close(): void;
}

// ───────────────────────────── Signalisation WebRTC manuelle ─────────────────────────────

/** Erreurs de la signalisation manuelle (`RtcSignalingError.code`). */
export type RtcSignalingErrorCode =
  | 'unsupported' // pas de RTCPeerConnection
  | 'badCode' // code illisible, tronqué, mauvaise somme de contrôle ou mauvais genre (réponse collée à la place d'une invitation…)
  | 'wrongVersion' // code produit par une autre version du format
  | 'iceTimeout' // la collecte ICE n'a pas abouti dans le délai
  | 'failed' // la connexion pair à pair a échoué
  | 'cancelled';

/** Invitation créée par l'hôte pour UN invité. Un code par invité. */
export interface RtcHostInvite {
  /** Code d'invitation compact (alphabet base64url `[A-Za-z0-9_-]`, éventuellement groupé par des espaces ou retours à la ligne qui sont ignorés à la lecture ; JAMAIS `-` comme séparateur) ; exporté APRÈS la fin de la collecte ICE. */
  readonly code: string;
  /** Colle le code de réponse de l'invité ; résout avec le `Transport` OUVERT (rejette avec `RtcSignalingError`). */
  accept(answerCode: string): Promise<Transport>;
  cancel(): void;
}

export interface RtcHostSignaling {
  /** Crée une invitation (attend la fin de la collecte ICE avant de résoudre). */
  createInvite(): Promise<RtcHostInvite>;
}

/** Réponse produite par l'invité à partir d'un code d'invitation. */
export interface RtcGuestAnswer {
  /** Code de réponse à renvoyer à l'hôte (exporté après la collecte ICE). */
  readonly answerCode: string;
  /** Résout quand le canal est ouvert (l'hôte a collé la réponse). */
  readonly transport: Promise<Transport>;
  cancel(): void;
}

export interface RtcGuestSignaling {
  /** @throws RtcSignalingError (`badCode`, `wrongVersion`, `unsupported`, `iceTimeout`). */
  join(inviteCode: string): Promise<RtcGuestAnswer>;
}

export interface RtcOptions {
  /** Serveurs ICE (défaut : AUCUN, LAN uniquement). Surcharge de dépannage seulement. */
  iceServers?: { urls: string | string[] }[];
  /** Délai maximal (ms) de collecte ICE (défaut 4000). */
  iceTimeoutMs?: number;
}

// ───────────────────────────── Salon ─────────────────────────────

/** Choix d'un participant au salon. */
export interface LobbyChoice {
  characterId: CharacterId;
  difficulty: Difficulty;
  /** Prêt = personnage verrouillé (deux participants prêts n'ont jamais le même personnage). */
  ready: boolean;
}

/** Un participant du salon (`slot` : emplacement 0..3 ; l'hôte occupe toujours le 0). */
export interface LobbySlot extends LobbyChoice {
  slot: PlayerId;
  name: string;
  isHost: boolean;
  /** false = liaison perdue (en salon, le participant est retiré ; en partie, son joueur reste immobile). */
  connected: boolean;
  /** Aller-retour (ms) mesuré par l'hôte, si connu. */
  pingMs?: number;
}

/** État AUTORITAIRE du salon (JSON pur), diffusé par l'hôte à chaque changement. */
export interface LobbyState {
  /** Compteur croissant : un client ignore un `lobby` de `seq` ≤ au dernier appliqué. */
  seq: number;
  /** Participants présents, triés par `slot` (l'hôte d'abord). */
  slots: LobbySlot[];
  /** Niveau choisi par l'hôte (indice 0-based). */
  levelIndex: number;
  levelCount: number;
}

export type StartCheck = { ok: true } | { ok: false; reason: 'needTwo' | 'notReady' };

/** Joueur de la partie : un `PlayerSetup` (ids CONTIGUS 0..n-1) et le nom affiché. */
export interface NetPlayer extends PlayerSetup {
  name: string;
}

/** Ce que reçoivent les scènes au lancement d'une partie (côté hôte : retour de `startGame` ; côté client : rappel `onStart`). */
export interface NetStartInfo {
  /** Identifiant de la partie (entier 32 bits tiré par l'hôte) ; porté par `input`, `snap` et `end` pour ignorer les messages d'une partie précédente. */
  gameId: number;
  /** Identifiant (0..n-1) du joueur de CET appareil. L'hôte vaut toujours 0. */
  localPlayerId: PlayerId;
  levelIndex: number;
  seed: number;
  players: NetPlayer[];
}

/** Champ `GameSession.net` : JSON pur, SANS objet vivant (le transport et les sessions sont dans `netRuntime`). */
export interface NetSessionInfo {
  role: NetRole;
  gameId: number;
  localPlayerId: PlayerId;
  transport: TransportKind;
  /** Graine de la partie (tirée par l'hôte, commune aux deux rôles : `GameScene` n'en tire PAS une en réseau). */
  seed: number;
  /** Nom de chaque joueur (index = PlayerId). */
  names: string[];
}

// ───────────────────────────── Messages ─────────────────────────────

/** Informations de compatibilité échangées à la connexion. */
export interface Compat {
  proto: number;
  build: BuildInfo;
  /** Nombre de niveaux de `LEVELS` (deux builds de même version peuvent différer sur ce point en développement). */
  levels: number;
}

/** Invité → hôte, premier message après l'ouverture du canal. */
export interface MsgHello extends Compat {
  t: 'hello';
  /** Nom affiché (assaini par `sanitizeNetName`). */
  name: string;
}

/** Hôte → invité : accepté. `slot` = emplacement provisoire de salon (l'identifiant de jeu définitif vient de `start`). */
export interface MsgWelcome extends Compat {
  t: 'welcome';
  slot: PlayerId;
  lobby: LobbyState;
}

/** Hôte → invité : refusé ; l'hôte ferme ensuite le canal. Porte les données de l'hôte (`Compat`). */
export interface MsgReject extends Compat {
  t: 'reject';
  reason: RejectReason;
}

/** Hôte → invités : état du salon (un message PAR invité : `you` = son emplacement). */
export interface MsgLobby {
  t: 'lobby';
  lobby: LobbyState;
  you: PlayerId;
}

/** Invité → hôte : choix du participant (l'hôte tranche et rediffuse `lobby` ; le client n'applique rien en local). */
export interface MsgChoice extends LobbyChoice {
  t: 'choice';
}

/** Hôte → invité (un message PAR invité) : la partie démarre. `you` = identifiant de jeu définitif (ids contigus 0..n-1, l'hôte = 0). */
export interface MsgStart {
  t: 'start';
  gid: number;
  you: PlayerId;
  levelIndex: number;
  seed: number;
  players: NetPlayer[];
}

/**
 * Invité → hôte : entrée « tenue » de son joueur (identité = le canal, JAMAIS un champ du message). Axes entiers −100..100 (centièmes),
 * `b` = masque de boutons (`FRAME_BIT`). `seq` croît à chaque message (détection de rejeu / ordre ; l'hôte ignore un `seq` ≤ au dernier).
 */
export interface MsgInput {
  t: 'input';
  gid: number;
  seq: number;
  x: number;
  y: number;
  b: number;
}

/**
 * Hôte → invité : instantané autoritaire (format 'full' : `GameState` entier, voir docs/NET.md § Mesures) + événements de simulation produits
 * depuis l'instantané PRÉCÉDENT envoyé À CE CLIENT (sons, FX, textes flottants). `n` croît de 1 à chaque instantané émis (par client : un saut = des
 * instantanés non envoyés pour cause de saturation) ; `pc` = masque des joueurs connectés (bit = identifiant de jeu).
 */
export interface MsgSnap {
  t: 'snap';
  gid: number;
  n: number;
  tick: number;
  pc: number;
  st: GameState;
  ev: SimEvent[];
}

/** Hôte → invités : la partie se termine pour tous ; tout le monde retourne au salon. */
export interface MsgEnd {
  t: 'end';
  gid: number;
  reason: NetEndReason;
}

/** Départ propre (dans les deux sens) ; suivi de la fermeture du canal. */
export interface MsgLeave {
  t: 'leave';
}

/** Hôte → invité : battement + mesure d'aller-retour (`ts` = horloge de l'hôte, renvoyée telle quelle). */
export interface MsgPing {
  t: 'ping';
  n: number;
  ts: number;
}

/** Invité → hôte : réponse à `ping` (mêmes `n` et `ts`). */
export interface MsgPong {
  t: 'pong';
  n: number;
  ts: number;
}

/**
 * Fragment d'un message trop long (dans les deux sens). Les fragments d'UN message sont émis à la suite, dans une même boucle synchrone, jamais entrelacés
 * avec d'autres messages ; `d` = tranche du JSON d'origine, `i` ∈ [0, n[, `id` croît à chaque message fragmenté (par émetteur).
 */
export interface MsgFrag {
  t: 'frag';
  id: number;
  i: number;
  n: number;
  d: string;
}

export type GuestToHostMessage = MsgHello | MsgChoice | MsgInput | MsgPong | MsgLeave | MsgFrag;
export type HostToGuestMessage = MsgWelcome | MsgReject | MsgLobby | MsgStart | MsgSnap | MsgEnd | MsgPing | MsgLeave | MsgFrag;
export type NetMessage = GuestToHostMessage | HostToGuestMessage;
export type NetMessageType = NetMessage['t'];

/** Types acceptés par l'HÔTE (venant d'un invité) / par un INVITÉ (venant de l'hôte) : tout autre type est un message invalide. */
export const GUEST_TO_HOST_TYPES = ['hello', 'choice', 'input', 'pong', 'leave', 'frag'] as const satisfies readonly NetMessageType[];
export const HOST_TO_GUEST_TYPES = ['welcome', 'reject', 'lobby', 'start', 'snap', 'end', 'ping', 'leave', 'frag'] as const satisfies readonly NetMessageType[];

// ───────────────────────────── Événements de simulation ─────────────────────────────

/**
 * Types d'événements de simulation acceptés dans `MsgSnap.ev` (tout autre type est écarté). Liste vérifiée À LA COMPILATION : ajouter un événement à `SimEvent`
 * sans l'ajouter ici fait échouer `tsc` (voir `MissingSimEventTypes`).
 */
export const SIM_EVENT_TYPES = [
  'roomEntered',
  'playerHit',
  'playerDown',
  'reviveStarted',
  'reviveInterrupted',
  'playerRevived',
  'teamWipe',
  'enemyHit',
  'enemyDied',
  'enemySpawned',
  'playerAttack',
  'projectileFired',
  'bossPhase',
  'bossTactic',
  'itemSeized',
  'mechanismChanged',
  'keyPicked',
  'doorOpened',
  'runeProgress',
  'objectiveCompleted',
  'roomCleared',
  'levelCompleted',
  'specialUsed',
  'specialReady',
  'brazierLit',
  'torchRefueled',
  'torchLow',
  'torchOut',
  'statueRotated',
  'hourglassFlipped',
  'hourglassEmpty',
  'gateClosed',
  'callStarted',
  'autoCallStarted',
  'pickupDropped',
  'pickupCollected',
  'crystalUsed',
  'heartStored',
  'heartUsed',
  'heartRefused',
  'heartLost',
  'gearDropped',
  'gearPicked',
  'gearRecoverable',
  'gearLost',
  'gearSwapped',
  'buffDropped',
  'buffStarted',
  'vampireHeal',
] as const satisfies readonly SimEvent['type'][];

/** Types d'événements de `SimEvent` absents de `SIM_EVENT_TYPES` : DOIT rester `never`. */
export type MissingSimEventTypes = Exclude<SimEvent['type'], (typeof SIM_EVENT_TYPES)[number]>;
const ALL_SIM_EVENT_TYPES_LISTED: [MissingSimEventTypes] extends [never] ? true : never = true;
void ALL_SIM_EVENT_TYPES_LISTED;

/** Événements qu'on ne jette JAMAIS quand une file déborde (ils pilotent l'interface : reconstruction de salle, fin de niveau, chutes). */
export const SIM_EVENTS_NEVER_DROPPED: readonly SimEvent['type'][] = ['roomEntered', 'levelCompleted', 'teamWipe', 'playerDown', 'playerRevived'];

// ───────────────────────────── Instantané reçu ─────────────────────────────

/**
 * Instantané tel que le client le remet à la scène (`ClientSessionApi.takeSnapshot`). L'enveloppe est validée par `protocol.ts` ; la FORME de `state` ne l'est que
 * superficiellement (objet, `version` 1, `levelId` en chaîne) : la validation complète est celle de `GameSimulation.applyMirrorState` (lot B).
 */
export interface NetSnapshot {
  /** Compteur `n` du DERNIER instantané reçu. */
  n: number;
  tick: number;
  /** Masque des joueurs connectés (bit = identifiant de jeu). */
  connectedMask: number;
  state: GameState;
  /** Événements de TOUS les instantanés reçus depuis le dernier `takeSnapshot`, dans l'ordre (déjà filtrés sur `SIM_EVENT_TYPES`, bornés à `NET.MAX_PENDING_EVENTS`). */
  events: SimEvent[];
  /** Instant (`nowMs` de la session) de réception du dernier instantané. */
  receivedAtMs: number;
  /** Intervalle estimé (ms) entre instantanés (moyenne mobile bornée par `NET.INTERP_MIN_MS`..`INTERP_MAX_MS`) : dénominateur de l'`alpha` d'interpolation. */
  intervalMs: number;
}

// ───────────────────────────── API des sessions (consommée par les scènes) ─────────────────────────────

/** Événement de pair vu par l'hôte (toasts, journal). */
export interface NetPeerEvent {
  type: 'joined' | 'left' | 'lost';
  slot: PlayerId;
  name: string;
}

export interface HostSessionOptions {
  hostName: string;
  build: BuildInfo;
  levelCount: number;
  transportKind: TransportKind;
  /** Personnage initial de l'hôte (défaut : premier personnage libre). */
  hostCharacter?: CharacterId;
}

export interface ClientSessionOptions {
  name: string;
  build: BuildInfo;
  levelCount: number;
}

/**
 * Session de l'HÔTE (implémentée par le lot A, `createHostSession`). Aucun timer interne : l'appelant (scène) appelle `update(nowMs)` à chaque frame
 * (salon ET partie) ; toute échéance (délai de `hello`, silence, `ping`, expiration d'entrée) se calcule sur cet `nowMs`.
 * La session SURVIT aux parties : après `endGame`, on revient au salon avec les mêmes liaisons.
 */
export interface HostSessionApi {
  readonly role: 'host';
  readonly phase: HostPhase;
  readonly transportKind: TransportKind;

  // ── Salon ──
  getLobby(): LobbyState;
  onLobby(cb: (lobby: LobbyState) => void): Unsubscribe;
  onPeerEvent(cb: (e: NetPeerEvent) => void): Unsubscribe;
  /** Choix du joueur hôte (emplacement 0) ; l'unicité des personnages est arbitrée comme pour les invités. */
  setLocalChoice(choice: Partial<LobbyChoice>): void;
  setLevel(levelIndex: number): void;
  /** Prend en charge la liaison d'un invité (BroadcastChannel : appelé pour chaque `onGuest` ; WebRTC : avec le `Transport` rendu par `RtcHostInvite.accept`). */
  addGuest(transport: Transport): void;
  checkStart(): StartCheck;
  /**
   * Démarre la partie : envoie `start` à chaque invité, passe en `playing` et retourne les données de lancement ; null si `checkStart()` n'est pas ok ou si la phase n'est pas `lobby`.
   * La graine vient de la SCÈNE (qui peut tirer l'aléa) ; l'identifiant de partie est DÉTERMINISTE (testable) : `(Math.imul(seed ^ 0x5bd1e995, 0x9e3779b1) + nombreDeParties) >>> 0`
   * (`nombreDeParties` = parties déjà lancées par cette session), donc deux parties successives n'ont jamais le même `gid` même avec la même graine.
   */
  startGame(seed: number): NetStartInfo | null;

  // ── Partie ──
  /** Entrées courantes des invités CONNECTÉS, par identifiant de jeu (l'hôte n'y figure pas) ; entrée périmée (`INPUT_STALE_MS`) ou invité perdu = frame vide. */
  pollRemoteInputs(): TickInputs;
  /** À appeler après CHAQUE pas de simulation avec les événements du pas ; la session accumule et émet un instantané tous les `SNAPSHOT_EVERY_TICKS` pas. */
  afterStep(state: GameState, events: readonly SimEvent[]): void;
  /** Termine la partie pour tous (`end`), revient au salon (choix remis à « pas prêt » ; après `levelCompleted`, niveau suivant présélectionné). */
  endGame(reason: NetEndReason): void;
  /** Masque des joueurs connectés (bit = identifiant de jeu de la partie en cours). */
  connectedMask(): number;

  update(nowMs: number): void;
  /** Quitte : envoie `leave` aux invités et ferme toutes les liaisons (idempotent). */
  close(): void;
}

/** Session d'un INVITÉ (lot A, `createClientSession`). Mêmes conventions de temps que l'hôte. */
export interface ClientSessionApi {
  readonly role: 'client';
  readonly phase: ClientPhase;
  /** Emplacement de salon (après `welcome`), puis identifiant de jeu définitif (après `start`) ; null avant. */
  readonly slot: PlayerId | null;
  readonly gameId: number | null;
  readonly transportKind: TransportKind;

  getLobby(): LobbyState | null;
  onLobby(cb: (lobby: LobbyState) => void): Unsubscribe;
  /** Appelé à la réception de `start` (la scène de salon lance alors la partie). */
  onStart(cb: (start: NetStartInfo) => void): Unsubscribe;
  /** Appelé à la réception de `end` (retour au salon ; la liaison reste ouverte). */
  onEnd(cb: (reason: NetEndReason) => void): Unsubscribe;
  /** Appelé UNE fois quand la session se ferme (refus, hôte perdu, départ…). */
  onClosed(cb: (info: NetClosedInfo) => void): Unsubscribe;
  sendChoice(choice: LobbyChoice): void;

  /** Entrée du joueur local, à appeler à CHAQUE frame de rendu : la session cadence (`INPUT_SEND_MS`) et mémorise les appuis courts (OU des boutons entre deux envois). */
  sendInput(frame: ActionFrame, nowMs: number): void;
  /** Dernier instantané reçu depuis le dernier appel (avec TOUS les événements accumulés), ou null s'il n'y en a pas de nouveau. */
  takeSnapshot(): NetSnapshot | null;
  /** Aller-retour (ms) mesuré par les `ping` de l'hôte (réponse `pong`), ou null. */
  rttMs(): number | null;

  update(nowMs: number): void;
  /** Quitte proprement (`leave`, fermeture). Idempotent. */
  leave(): void;
}

// ───────────────────────────── Miroir côté invité ─────────────────────────────

/**
 * Résultat de `GameSimulation.applyMirrorState(state)` (lot B) : l'état reçu est VALIDÉ en entier avant toute écriture (rien n'est modifié en cas d'échec),
 * puis copié sur place (l'identité de `sim.state` est conservée). `roomChanged` : l'indice de salle a changé (la grille de la salle est reconstruite ; la scène
 * reconstruit alors ses vues). En cas d'échec la scène quitte la partie avec le message `protocolError`.
 */
export type MirrorApplyResult = { ok: true; roomChanged: boolean } | { ok: false; reason: string };

// ───────────────────────────── Fabriques (surface publique du lot A) ─────────────────────────────

/** `src/net/hostSession.ts` exporte `createHostSession` de ce type. */
export type CreateHostSession = (options: HostSessionOptions) => HostSessionApi;
/** `src/net/clientSession.ts` exporte `createClientSession` de ce type (le transport est DÉJÀ ouvert ou en cours d'ouverture ; `hello` part dès qu'il est `open`). */
export type CreateClientSession = (transport: Transport, options: ClientSessionOptions) => ClientSessionApi;
/** `src/net/transportLoopback.ts` exporte `createLoopbackPair` de ce type. */
export type CreateLoopbackPair = (options?: LoopbackOptions) => LoopbackPair;
/** `src/net/transportBroadcast.ts` exporte `createBroadcastHost` de ce type. Sans BroadcastChannel : lève `Error('unsupported')`. */
export type CreateBroadcastHost = (channelName?: string) => BroadcastHostLink;
/** `src/net/transportBroadcast.ts` exporte `connectBroadcastGuest` de ce type : annonce l'invité sur le canal et résout avec le `Transport` ouvert dès que l'hôte répond ; rejette (`Error('timeout')`) au bout de `timeoutMs` (défaut 5000) sans hôte. */
export type ConnectBroadcastGuest = (channelName?: string, timeoutMs?: number) => Promise<Transport>;
/** `src/net/rtcSignaling.ts` exporte `createRtcHostSignaling` / `createRtcGuestSignaling` de ces types, la classe `RtcSignalingError` (champ `code`) et `isRtcSupported()`. */
export type CreateRtcHostSignaling = (options?: RtcOptions) => RtcHostSignaling;
export type CreateRtcGuestSignaling = (options?: RtcOptions) => RtcGuestSignaling;

// ───────────────────────────── Entrées sur le fil ─────────────────────────────

/** Bits de `MsgInput.b`. `special`, `call` et `heart` sont explicites (jamais « absents »). */
export const FRAME_BIT = { attack: 1, interact: 2, revive: 4, special: 8, call: 16, heart: 32 } as const;
/** Masque de tous les boutons. */
export const FRAME_BITS_ALL = 63;

export interface PackedFrame {
  x: number;
  y: number;
  b: number;
}

/** Quantifie un axe sur [-100, 100] (centièmes) ; non fini → 0. */
export function quantizeAxis(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.round(Math.max(-1, Math.min(1, v)) * 100);
}

/** Frame d'entrée → octets du fil. */
export function packFrame(f: ActionFrame): PackedFrame {
  let b = 0;
  if (f.attack) b |= FRAME_BIT.attack;
  if (f.interact) b |= FRAME_BIT.interact;
  if (f.revive) b |= FRAME_BIT.revive;
  if (f.special === true) b |= FRAME_BIT.special;
  if (f.call === true) b |= FRAME_BIT.call;
  if (f.heart === true) b |= FRAME_BIT.heart;
  return { x: quantizeAxis(f.moveX), y: quantizeAxis(f.moveY), b };
}

/** Octets du fil → frame d'entrée ; null si une valeur n'est pas un entier dans sa plage (message à rejeter). */
export function unpackFrame(x: unknown, y: unknown, b: unknown): ActionFrame | null {
  if (typeof x !== 'number' || typeof y !== 'number' || typeof b !== 'number') return null;
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(b)) return null;
  if (x < -100 || x > 100 || y < -100 || y > 100 || b < 0 || b > FRAME_BITS_ALL) return null;
  return {
    moveX: x / 100,
    moveY: y / 100,
    attack: (b & FRAME_BIT.attack) !== 0,
    interact: (b & FRAME_BIT.interact) !== 0,
    revive: (b & FRAME_BIT.revive) !== 0,
    special: (b & FRAME_BIT.special) !== 0,
    call: (b & FRAME_BIT.call) !== 0,
    heart: (b & FRAME_BIT.heart) !== 0,
  };
}

// ───────────────────────────── Petites fonctions pures ─────────────────────────────

/** Deux builds sont compatibles s'ils ont la même version, le même hash de commit et la même date (un build sans git a `commit`/`date` à null des deux côtés). */
export function buildsCompatible(a: BuildInfo, b: BuildInfo): boolean {
  return a.version === b.version && a.commit === b.commit && a.date === b.date;
}

/** Vérification de compatibilité faite par l'hôte au `hello` : première raison de refus (protocole, puis build, puis niveaux), ou null si tout concorde. */
export function compatibilityCheck(remote: Compat, local: Compat): RejectReason | null {
  if (remote.proto !== local.proto) return 'protocol';
  if (!buildsCompatible(remote.build, local.build)) return 'build';
  if (remote.levels !== local.levels) return 'levels';
  return null;
}

/** Un instantané est-il dû à ce numéro de pas ? (20 Hz : un pas sur 3.) */
export function snapshotDue(tick: number): boolean {
  return Number.isInteger(tick) && tick > 0 && tick % NET.SNAPSHOT_EVERY_TICKS === 0;
}

/** Le joueur `id` est-il connecté d'après le masque `pc` ? */
export function peerConnected(mask: number, id: number): boolean {
  return Number.isInteger(id) && id >= 0 && id < NET.MAX_PLAYERS && (mask & (1 << id)) !== 0;
}

/** Masque `pc` de la liste des joueurs connectés. */
export function peerMask(connected: readonly number[]): number {
  let m = 0;
  for (const id of connected) if (Number.isInteger(id) && id >= 0 && id < NET.MAX_PLAYERS) m |= 1 << id;
  return m;
}

/** Nom d'affichage assaini : lettres, chiffres, espace et `-_.'` seulement, espaces fusionnés, ≤ `NAME_MAX_CHARS` points de code ; vide ou non-chaîne → `fallback`. */
export function sanitizeNetName(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const cleaned = raw.replace(/[^\p{L}\p{N} _.'-]/gu, '').replace(/\s+/g, ' ').trim();
  const cut = Array.from(cleaned).slice(0, NET.NAME_MAX_CHARS).join('').trim();
  return cut.length > 0 ? cut : fallback;
}

/**
 * `GameSession` d'une partie réseau, construite à partir des données de lancement (côté hôte : retour de `startGame` ; côté invité : rappel `onStart`).
 * Mêmes champs que la session locale (`players` = `PlayerSetup` seuls, ids contigus 0..n-1) + `net`. Aucune sauvegarde, aucune reprise : ni `startRoomIndex`,
 * ni équipement de départ, ni `completedLevelIds`.
 */
export function sessionFromNetStart(info: NetStartInfo, role: NetRole, transport: TransportKind): GameSession {
  const n = info.players.length;
  return {
    playerCount: n,
    players: info.players.map((p) => ({ id: p.id, characterId: p.characterId, difficulty: p.difficulty })),
    levelIndex: info.levelIndex,
    stats: { timeMs: 0, downs: Array.from({ length: n }, () => 0), kills: Array.from({ length: n }, () => 0) },
    net: { role, gameId: info.gameId, localPlayerId: info.localPlayerId, transport, seed: info.seed, names: info.players.map((p) => p.name) },
  };
}

/** Transport du salon selon l'URL : `?net=bc` → BroadcastChannel (deux onglets, sans signalisation) ; sinon WebRTC à signalisation manuelle. */
export function parseNetTransportParam(search: string): 'webrtc' | 'broadcast' {
  try {
    return new URLSearchParams(search).get('net') === 'bc' ? 'broadcast' : 'webrtc';
  } catch {
    return 'webrtc';
  }
}
