/**
 * Logique PURE du salon du multijoueur réseau (`NetLobbyScene`) : aucun Phaser, aucun DOM, aucune horloge.
 *
 * Ce module porte tout ce qui se teste sans navigateur :
 *  - la machine d'états de l'ÉCRAN (`NetLobbyState`) et son réducteur (`reduceNetLobby`) : choix hôte / invité, invitations WebRTC de l'hôte
 *    (UNE à la fois, l'une après l'autre : jusqu'à 3 invités au total), étapes de connexion de l'invité (collage du code, code de réponse, attente), messages affichés ;
 *  - les ACTIONS disponibles à chaque étape (`lobbyActions`) et leurs validations (lancer, inviter…) ;
 *  - les aides du salon : disponibilité des personnages selon l'état autoritaire (`LobbyState`), lignes des participants, niveau / difficulté ;
 *  - la validation d'un code collé (`checkPastedCode`), l'assainissement du nom, le code de salon BroadcastChannel (mode `?net=bc`) ;
 *  - les messages traduisibles (clé + paramètres) : refus de connexion avec les versions en présence, erreurs de signalisation, etc.
 *
 * Le salon lui-même (qui est connecté, qui est prêt, qui a quel personnage) est AUTORITAIRE côté hôte : ce module ne le décide pas, il le lit
 * (`LobbyState`, contrat `src/net/contracts.ts`). Voir docs/NET.md (§ 6 machines d'états, § 9 textes).
 */
import { CHARACTER_IDS } from '../core/characters';
import type { CharacterId, Difficulty } from '../core/types';
import { formatBuildLabel, type BuildInfo } from '../buildInfo';
import type { Language } from '../i18n/i18n';
import {
  NET,
  NET_BC_CHANNEL,
  noticeForClose,
  noticeKey,
  sanitizeNetName,
  type LobbySlot,
  type LobbyState,
  type NetClosedInfo,
  type NetNotice,
  type NetRole,
  type RtcSignalingErrorCode,
  type StartCheck,
} from '../net/contracts';

// ───────────────────────────── Constantes ─────────────────────────────

/** Clé `localStorage` du nom du joueur (mémorisé d'une partie à l'autre ; lecture / écriture toujours dans un try/catch côté scène). */
export const NET_NAME_STORAGE_KEY = 'vaelorn.net.name';

/** Nombre maximal d'invités (l'hôte occupe le premier des quatre emplacements). */
export const MAX_GUESTS = NET.MAX_PLAYERS - 1;

/** Longueur maximale du code de salon du mode BroadcastChannel (`?net=bc`). */
export const ROOM_CODE_MAX_CHARS = 12;

/** Codes d'erreur de signalisation connus (clé i18n `net.rtc.error.<code>`). */
export const RTC_ERROR_CODES: readonly RtcSignalingErrorCode[] = ['unsupported', 'badCode', 'wrongVersion', 'iceTimeout', 'failed', 'cancelled'];

/**
 * Clés i18n lues par la scène du salon en plus des messages (`net.notice.*`, `net.rtc.error.*`, `net.lobby.code.*`, `net.lobby.start.*`,
 * `net.lobby.error.*`) : un test vérifie qu'elles existent en français ET en anglais.
 */
export const NET_LOBBY_I18N_KEYS: readonly string[] = [
  'menu.net',
  'menu.net.hint',
  'net.lobby.title',
  'net.lobby.help',
  'net.lobby.defaultName',
  'net.lobby.name.label',
  'net.lobby.name.placeholder',
  'net.lobby.room.label',
  'net.lobby.room.placeholder',
  'net.lobby.host',
  'net.lobby.join',
  'net.lobby.back',
  'net.lobby.closeRoom',
  'net.lobby.closeRoom.confirm',
  'net.lobby.leaveRoom',
  'net.lobby.host.title',
  'net.lobby.guest.title',
  'net.lobby.players',
  'net.lobby.status.host',
  'net.lobby.status.ready',
  'net.lobby.status.choosing',
  'net.lobby.status.lost',
  'net.lobby.ping',
  'net.lobby.level',
  'net.lobby.character',
  'net.lobby.difficulty',
  'net.lobby.ready',
  'net.lobby.yes',
  'net.lobby.no',
  'net.lobby.locked',
  'net.lobby.start',
  'net.lobby.waitStart',
  'net.lobby.invite.title',
  'net.lobby.invite.button',
  'net.lobby.invite.chip',
  'net.lobby.invite.creating',
  'net.lobby.invite.ready',
  'net.lobby.invite.accepting',
  'net.lobby.invite.connected',
  'net.lobby.invite.failed',
  'net.lobby.invite.cancel',
  'net.lobby.invite.dismiss',
  'net.lobby.invite.code',
  'net.lobby.invite.answer',
  'net.lobby.invite.full',
  'net.lobby.copy',
  'net.lobby.paste',
  'net.lobby.validate',
  'net.lobby.copy.done',
  'net.lobby.copy.manual',
  'net.lobby.paste.manual',
  'net.lobby.join.code',
  'net.lobby.code.placeholder',
  'net.lobby.join.creating',
  'net.lobby.join.answer',
  'net.lobby.join.answerHint',
  'net.lobby.join.connecting',
  'net.lobby.join.retry',
  'net.lobby.bc.hostHint',
  'net.lobby.bc.room',
  'net.lobby.peerJoined',
  'net.lobby.peerLeft',
  'net.game.peerLost',
  'pad.menu.hint',
];

// ───────────────────────────── Messages affichés ─────────────────────────────

/** Message du salon : clé i18n + paramètres (traduit par la scène avec `t(key, params)`, donc suit la langue) ; `tone` donne la couleur. */
export interface LobbyMessage {
  key: string;
  params?: Record<string, string | number>;
  tone: 'info' | 'error';
}

/** Message correspondant à un `NetNotice` du contrat (fin de partie, refus, hôte perdu…) ; sans `tone` : information pour « niveau terminé », erreur sinon. */
export function messageFromNotice(notice: NetNotice, tone: 'info' | 'error' = notice.code === 'levelCompleted' ? 'info' : 'error'): LobbyMessage {
  return notice.params ? { key: noticeKey(notice.code), params: { ...notice.params }, tone } : { key: noticeKey(notice.code), tone };
}

/** Message d'une erreur de signalisation WebRTC (`net.rtc.error.<code>`). */
export function messageFromRtcError(code: RtcSignalingErrorCode): LobbyMessage {
  return { key: `net.rtc.error.${code}`, tone: 'error' };
}

/** Message d'un défaut de collage (`net.lobby.code.<erreur>`). */
export function messageFromCodeCheck(error: CodeError): LobbyMessage {
  return { key: `net.lobby.code.${error}`, tone: 'error' };
}

/** Message d'une raison de non-lancement (`net.lobby.start.<raison>`). */
export function messageFromStartReason(reason: StartBlock): LobbyMessage {
  return { key: `net.lobby.start.${reason}`, tone: 'error' };
}

function isRtcErrorCode(value: unknown): value is RtcSignalingErrorCode {
  return typeof value === 'string' && (RTC_ERROR_CODES as readonly string[]).includes(value);
}

/** Code d'erreur de signalisation porté par une exception (`RtcSignalingError.code`), ou null. */
export function rtcErrorCodeOf(err: unknown): RtcSignalingErrorCode | null {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code: unknown }).code;
    if (isRtcErrorCode(code)) return code;
  }
  return null;
}

/**
 * Message d'une exception levée à la connexion : erreur de signalisation (code connu), `timeout` du mode BroadcastChannel (aucun hôte sur ce salon),
 * `unsupported` (pas de BroadcastChannel / WebRTC), sinon un message générique. Jamais de texte venu de l'exception (elle n'est pas traduite).
 */
export function messageFromJoinError(err: unknown): LobbyMessage {
  const code = rtcErrorCodeOf(err);
  if (code) return messageFromRtcError(code);
  const text = err instanceof Error ? err.message : '';
  if (text === 'timeout') return { key: 'net.lobby.error.noHost', tone: 'error' };
  if (text === 'unsupported') return messageFromRtcError('unsupported');
  return { key: 'net.lobby.error.generic', tone: 'error' };
}

/**
 * Message affiché à l'invité quand sa session se ferme, avec les valeurs d'interpolation des refus :
 *  - `reject.build` : `host` / `you` = libellés de version (`formatBuildLabel`), pour voir la différence ;
 *  - `reject.levels` : `host` / `you` = nombres de niveaux ;
 *  - null pour un départ volontaire (`userLeft`).
 */
export function noticeForClosure(info: NetClosedInfo, local: { build: BuildInfo; levels: number }, lang: Language): NetNotice | null {
  const base = noticeForClose(info);
  if (!base) return null;
  if (info.reason === 'rejected' && info.reject) {
    if (base.code === 'reject.build') {
      return { code: base.code, params: { host: formatBuildLabel(info.reject.hostBuild, lang), you: formatBuildLabel(local.build, lang) } };
    }
    if (base.code === 'reject.levels') {
      return { code: base.code, params: { host: info.reject.hostLevels, you: local.levels } };
    }
  }
  return base;
}

// ───────────────────────────── Validation des saisies ─────────────────────────────

export type CodeError = 'empty' | 'tooLong' | 'badChars';
export type CodeCheck = { ok: true; code: string } | { ok: false; error: CodeError };

/**
 * Valide un code d'invitation / de réponse COLLÉ : les blancs (espaces, retours à la ligne, espaces insécables, caractères de largeur nulle) sont ignorés,
 * le reste doit être non vide, tenir dans `NET.CODE_MAX_CHARS` et n'utiliser que l'alphabet base64url `[A-Za-z0-9_-]`. Le décodage proprement dit (somme de
 * contrôle, version, genre) est celui de la signalisation (`RtcSignalingError`) : ici seulement la forme.
 */
export function checkPastedCode(raw: string): CodeCheck {
  const code = (typeof raw === 'string' ? raw : '').replace(/[\s​-‍⁠﻿]+/gu, '');
  if (code.length === 0) return { ok: false, error: 'empty' };
  if (code.length > NET.CODE_MAX_CHARS) return { ok: false, error: 'tooLong' };
  if (!/^[A-Za-z0-9_-]+$/.test(code)) return { ok: false, error: 'badChars' };
  return { ok: true, code };
}

/** Nom assaini (mêmes règles que celles de l'hôte, `sanitizeNetName`) ; vide → `fallback` (nom par défaut traduit). */
export function normalizeName(raw: unknown, fallback: string): string {
  return sanitizeNetName(raw, fallback);
}

/** Stockage minimal (compatible `localStorage`). */
export interface NameStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Nom mémorisé, assaini ; `fallback` si rien (ou stockage indisponible : toute exception est avalée). */
export function loadStoredName(storage: NameStorage | null | undefined, fallback: string): string {
  try {
    const raw = storage?.getItem(NET_NAME_STORAGE_KEY);
    return normalizeName(raw, fallback);
  } catch {
    return fallback;
  }
}

/** Mémorise le nom (assaini) ; sans effet si le stockage est indisponible. */
export function storeName(storage: NameStorage | null | undefined, name: string, fallback: string): void {
  try {
    storage?.setItem(NET_NAME_STORAGE_KEY, normalizeName(name, fallback));
  } catch {
    /* stockage indisponible : sans gravité */
  }
}

/** Code de salon saisi (mode `?net=bc`) : minuscules, chiffres et lettres seulement, ≤ `ROOM_CODE_MAX_CHARS`. */
export function sanitizeRoomCode(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, ROOM_CODE_MAX_CHARS);
}

/** Nom du canal BroadcastChannel d'un code de salon : vide → le canal par défaut (`NET_BC_CHANNEL`), sinon `NET_BC_CHANNEL-<code>`. */
export function roomCodeToChannel(raw: unknown): string {
  const code = sanitizeRoomCode(raw);
  return code === '' ? NET_BC_CHANNEL : `${NET_BC_CHANNEL}-${code}`;
}

// ───────────────────────────── Machine d'états de l'écran ─────────────────────────────

/** Étape de l'écran : `choose` (héberger / rejoindre), `host` (salon de l'hôte), `join` (connexion de l'invité), `guest` (salon de l'invité). */
export type LobbyStep = 'choose' | 'host' | 'join' | 'guest';

/**
 * Phase de la connexion de l'invité (étape `join`) : `code` (WebRTC : coller le code d'invitation), `creating` (préparation de la réponse), `answer` (code de
 * réponse à donner à l'hôte), `connecting` (liaison ouverte, attente de l'accueil de l'hôte ; BroadcastChannel : recherche de l'hôte), `failed` (erreur ou refus).
 */
export type JoinPhase = 'code' | 'creating' | 'answer' | 'connecting' | 'failed';

/** État d'une invitation de l'hôte (WebRTC) : `creating` (collecte ICE), `ready` (code à envoyer), `accepting` (réponse collée, connexion), `connected`, `failed`. */
export type InviteStatus = 'creating' | 'ready' | 'accepting' | 'connected' | 'failed';

export interface InviteView {
  id: number;
  status: InviteStatus;
  /** Code d'invitation (statuts `ready` et `accepting`). */
  code: string | null;
  /** Erreur de signalisation (statut `failed`). */
  errorCode: RtcSignalingErrorCode | null;
}

export type NetTransportChoice = 'webrtc' | 'broadcast';

export interface NetLobbyState {
  transport: NetTransportChoice;
  step: LobbyStep;
  join: JoinPhase;
  /** Invitations de l'hôte (WebRTC), dans l'ordre de création. */
  invites: InviteView[];
  nextInviteId: number;
  /** Code de réponse de l'invité (phases `answer` et suivantes). */
  answerCode: string | null;
  message: LobbyMessage | null;
}

export type NetLobbyEvent =
  | { type: 'chooseHost' }
  | { type: 'chooseJoin' }
  /** Annule la connexion en cours et revient au choix (étape `join` seulement : les salons se quittent vers le menu). */
  | { type: 'back'; message?: LobbyMessage }
  | { type: 'inviteStarted' }
  | { type: 'inviteReady'; id: number; code: string }
  | { type: 'inviteAccepting'; id: number }
  | { type: 'inviteConnected'; id: number }
  | { type: 'inviteFailed'; id: number; error: RtcSignalingErrorCode }
  /** Code de réponse illisible ou d'une autre version : la signalisation n'a PAS consommé l'invitation, on la remet en `ready` (zone de réponse recollable) avec l'erreur. */
  | { type: 'inviteRetry'; id: number; error: RtcSignalingErrorCode }
  | { type: 'inviteDismissed'; id: number }
  | { type: 'joinSubmitted' }
  | { type: 'answerReady'; answerCode: string }
  | { type: 'joinConnecting' }
  | { type: 'joinFailed'; message: LobbyMessage }
  | { type: 'retry' }
  | { type: 'joined' }
  | { type: 'message'; message: LobbyMessage | null };

/** État initial : écran de choix. */
export function createNetLobbyState(transport: NetTransportChoice): NetLobbyState {
  return { transport, step: 'choose', join: 'code', invites: [], nextInviteId: 1, answerCode: null, message: null };
}

/**
 * État à l'arrivée d'un RETOUR de partie (`entry: 'return'`) : la session existe déjà, on retrouve directement le salon de son rôle, avec le message de fin de
 * partie (« Niveau terminé… »).
 */
export function createReturnState(transport: NetTransportChoice, role: NetRole, notice?: NetNotice): NetLobbyState {
  const base = createNetLobbyState(transport);
  return { ...base, step: role === 'host' ? 'host' : 'guest', message: notice ? messageFromNotice(notice, 'info') : null };
}

const ACTIVE_INVITE: readonly InviteStatus[] = ['creating', 'ready', 'accepting'];

/** Invitations en cours (collecte, code à envoyer, connexion) : elles occupent une place du salon. */
export function liveInvites(state: NetLobbyState): InviteView[] {
  return state.invites.filter((i) => ACTIVE_INVITE.includes(i.status));
}

/** Invitation affichée dans le panneau de saisie : la dernière en cours ou échouée (une invitation connectée ou écartée ne l'est plus). */
export function activeInvite(state: NetLobbyState): InviteView | null {
  for (let i = state.invites.length - 1; i >= 0; i--) {
    const inv = state.invites[i];
    if (ACTIVE_INVITE.includes(inv.status) || inv.status === 'failed') return inv;
  }
  return null;
}

/**
 * Invitations à montrer en pastilles : celles en cours ou échouées (une invitation « connectée » n'a plus rien à dire : l'invité est dans la liste des joueurs,
 * et s'il est parti la pastille serait périmée), les 3 dernières au plus pour ne jamais déborder du panneau.
 */
export function chipInvites(state: NetLobbyState): InviteView[] {
  return state.invites.filter((i) => i.status !== 'connected').slice(-3);
}

function patchInvite(state: NetLobbyState, id: number, from: readonly InviteStatus[], patch: Partial<InviteView>): NetLobbyState {
  const idx = state.invites.findIndex((i) => i.id === id);
  if (idx < 0 || !from.includes(state.invites[idx].status)) return state;
  const invites = state.invites.slice();
  invites[idx] = { ...invites[idx], ...patch };
  return { ...state, invites };
}

/**
 * Réducteur de l'écran : transition pure `(état, événement) → état`. Un événement hors de sa place (par exemple `inviteReady` pour une invitation qui n'est plus
 * `creating`, ou `answerReady` hors de la phase `creating`) est IGNORÉ : on rend l'état tel quel (même référence), ce qui absorbe les réponses tardives d'une
 * opération asynchrone annulée.
 */
export function reduceNetLobby(state: NetLobbyState, event: NetLobbyEvent): NetLobbyState {
  switch (event.type) {
    case 'chooseHost':
      if (state.step !== 'choose') return state;
      return { ...state, step: 'host', invites: [], message: null };
    case 'chooseJoin':
      if (state.step !== 'choose') return state;
      return { ...state, step: 'join', join: state.transport === 'webrtc' ? 'code' : 'connecting', answerCode: null, message: null };
    case 'back':
      if (state.step !== 'join') return state;
      return { ...createNetLobbyState(state.transport), message: event.message ?? null };
    case 'inviteStarted': {
      if (state.step !== 'host' || state.transport !== 'webrtc') return state;
      const invite: InviteView = { id: state.nextInviteId, status: 'creating', code: null, errorCode: null };
      // les échecs déjà lus sont écartés : une nouvelle invitation repart d'un panneau propre
      return { ...state, invites: [...state.invites.filter((i) => i.status !== 'failed'), invite], nextInviteId: state.nextInviteId + 1, message: null };
    }
    case 'inviteReady':
      return patchInvite(state, event.id, ['creating'], { status: 'ready', code: event.code });
    case 'inviteAccepting':
      return patchInvite(state, event.id, ['ready'], { status: 'accepting' });
    case 'inviteConnected': {
      const next = patchInvite(state, event.id, ['accepting'], { status: 'connected' });
      return next === state ? state : { ...next, message: null };
    }
    case 'inviteRetry': {
      const next = patchInvite(state, event.id, ['accepting'], { status: 'ready' });
      return next === state ? state : { ...next, message: messageFromRtcError(event.error) };
    }
    case 'inviteFailed': {
      const next = patchInvite(state, event.id, ACTIVE_INVITE, { status: 'failed', errorCode: event.error });
      return next === state ? state : { ...next, message: messageFromRtcError(event.error) };
    }
    case 'inviteDismissed': {
      const idx = state.invites.findIndex((i) => i.id === event.id);
      if (idx < 0 || state.invites[idx].status === 'connected') return state;
      return { ...state, invites: state.invites.filter((i) => i.id !== event.id) };
    }
    case 'joinSubmitted':
      if (state.step !== 'join' || state.join !== 'code') return state;
      return { ...state, join: 'creating', message: null };
    case 'answerReady':
      if (state.step !== 'join' || state.join !== 'creating') return state;
      return { ...state, join: 'answer', answerCode: event.answerCode, message: null };
    case 'joinConnecting':
      if (state.step !== 'join' || (state.join !== 'answer' && state.join !== 'creating')) return state;
      return { ...state, join: 'connecting', message: null };
    case 'joinFailed':
      if (state.step !== 'join') return state;
      return { ...state, join: 'failed', answerCode: null, message: event.message };
    case 'retry':
      if (state.step !== 'join' || state.join !== 'failed') return state;
      return { ...state, join: state.transport === 'webrtc' ? 'code' : 'connecting', answerCode: null, message: null };
    case 'joined':
      if (state.step !== 'join') return state;
      return { ...state, step: 'guest', join: 'code', answerCode: null, message: null };
    case 'message':
      if (state.message === event.message) return state;
      return { ...state, message: event.message };
    default:
      return state;
  }
}

/** Où va « retour » : `menu` (le salon ou le choix se quitte vers le menu, la session réseau est libérée) ou `choose` (annulation d'une connexion en cours). */
export function backOutcome(state: NetLobbyState): 'menu' | 'choose' {
  return state.step === 'join' ? 'choose' : 'menu';
}

// ───────────────────────────── Salon : lecture de l'état autoritaire ─────────────────────────────

/** Participants connectés (l'hôte compris). */
export function connectedCount(lobby: LobbyState): number {
  return lobby.slots.filter((s) => s.connected).length;
}

/** Invités connectés (hors hôte). */
export function guestCount(lobby: LobbyState): number {
  return lobby.slots.filter((s) => s.connected && !s.isHost).length;
}

/**
 * Fermer le salon de l'hôte déconnecte tous les invités (et refaire les échanges de codes est long) : avec au moins un invité connecté, la sortie demande
 * une seconde validation (Échap / B / ligne « Fermer le salon » deux fois de suite).
 */
export function needsCloseConfirm(state: NetLobbyState, lobby: LobbyState | null): boolean {
  return state.step === 'host' && lobby !== null && guestCount(lobby) > 0;
}

/** Emplacement `slot` du salon, ou undefined. */
export function slotOf(lobby: LobbyState, slot: number | null | undefined): LobbySlot | undefined {
  return slot === null || slot === undefined ? undefined : lobby.slots.find((s) => s.slot === slot);
}

/** Personnages verrouillés (participants connectés ET prêts) par quelqu'un d'AUTRE que `exceptSlot` : indisponibles pour lui. */
export function takenCharacters(lobby: LobbyState, exceptSlot: number | null): Set<CharacterId> {
  const taken = new Set<CharacterId>();
  for (const s of lobby.slots) if (s.connected && s.ready && s.slot !== exceptSlot) taken.add(s.characterId);
  return taken;
}

export type CharacterAvailability = 'free' | 'mine' | 'taken';

/** Disponibilité de chaque personnage pour `localSlot` (grisé quand « pris » par un participant prêt). */
export function characterAvailability(lobby: LobbyState, localSlot: number | null): Record<CharacterId, CharacterAvailability> {
  const taken = takenCharacters(lobby, localSlot);
  const mine = slotOf(lobby, localSlot)?.characterId;
  const out = {} as Record<CharacterId, CharacterAvailability>;
  for (const id of CHARACTER_IDS) out[id] = taken.has(id) ? 'taken' : id === mine ? 'mine' : 'free';
  return out;
}

/** Premier personnage libre (ordre canonique) pour `localSlot`, ou null si tout est pris (impossible avec 4 participants et 8 personnages). */
export function firstFreeCharacter(lobby: LobbyState, localSlot: number | null): CharacterId | null {
  const taken = takenCharacters(lobby, localSlot);
  return CHARACTER_IDS.find((id) => !taken.has(id)) ?? null;
}

/**
 * Personnage suivant (`dir` = 1) ou précédent (-1) dans l'ordre canonique, en SAUTANT ceux qui sont pris par un participant prêt ; boucle. Retourne `current`
 * s'il n'y a pas d'autre personnage libre.
 */
export function stepCharacter(lobby: LobbyState, localSlot: number | null, current: CharacterId, dir: 1 | -1): CharacterId {
  const taken = takenCharacters(lobby, localSlot);
  const n = CHARACTER_IDS.length;
  const start = Math.max(0, CHARACTER_IDS.indexOf(current));
  for (let k = 1; k <= n; k++) {
    const candidate = CHARACTER_IDS[(((start + dir * k) % n) + n) % n];
    if (candidate === current) break;
    if (!taken.has(candidate)) return candidate;
  }
  return current;
}

/** Difficulté suivante / précédente (1 facile → 2 normal → 3 difficile), en boucle. */
export function stepDifficulty(current: Difficulty, dir: 1 | -1): Difficulty {
  const next = ((((current - 1 + dir) % 3) + 3) % 3) + 1;
  return next === 1 ? 1 : next === 2 ? 2 : 3;
}

/** Niveau suivant / précédent parmi `count`, en boucle ; `count` ≤ 0 → 0. */
export function stepLevelIndex(current: number, dir: 1 | -1, count: number): number {
  if (!Number.isInteger(count) || count <= 0) return 0;
  return (((Math.floor(current) + dir) % count) + count) % count;
}

/**
 * Peut-on lancer ? Vue de l'interface : au moins 2 participants connectés, et tous les INVITÉS connectés prêts (l'hôte se met « prêt » tout seul au clic sur « Lancer »,
 * donc son état n'est pas exigé ici). La décision finale reste celle de `HostSessionApi.checkStart()` / `startGame`.
 */
export function hostStartCheck(lobby: LobbyState): StartCheck {
  if (connectedCount(lobby) < NET.MIN_PLAYERS) return { ok: false, reason: 'needTwo' };
  if (lobby.slots.some((s) => s.connected && !s.isHost && !s.ready)) return { ok: false, reason: 'notReady' };
  return { ok: true };
}

/** Raison de blocage du lancement (`StartCheck` refusé) ou personnage de l'hôte déjà pris. */
export type StartBlock = 'needTwo' | 'notReady' | 'characterTaken';

// ───────────────────────────── Lignes du salon ─────────────────────────────

export type ParticipantStatus = 'host' | 'ready' | 'choosing' | 'lost';

export interface ParticipantRow {
  slot: number;
  name: string;
  characterId: CharacterId;
  difficulty: Difficulty;
  /** Clé i18n du nom du personnage : `character.<id>.name`. */
  characterNameKey: string;
  status: ParticipantStatus;
  /** true pour l'appareil local (mis en évidence). */
  isLocal: boolean;
  /** Aller-retour arrondi (ms), ou null s'il est inconnu (l'hôte n'a pas de latence vers lui-même). */
  pingMs: number | null;
}

/** Lignes d'affichage de la liste des joueurs (triées par emplacement). */
export function participantRows(lobby: LobbyState, localSlot: number | null): ParticipantRow[] {
  return lobby.slots
    .slice()
    .sort((a, b) => a.slot - b.slot)
    .map((s) => ({
      slot: s.slot,
      name: s.name,
      characterId: s.characterId,
      difficulty: s.difficulty,
      characterNameKey: `character.${s.characterId}.name`,
      status: !s.connected ? 'lost' : s.isHost ? 'host' : s.ready ? 'ready' : 'choosing',
      isLocal: s.slot === localSlot,
      pingMs: s.isHost || s.pingMs === undefined || !Number.isFinite(s.pingMs) ? null : Math.max(0, Math.round(s.pingMs)),
    }));
}

/** Clé i18n du statut d'un participant (`net.lobby.status.<statut>`). */
export function statusKey(status: ParticipantStatus): string {
  return `net.lobby.status.${status}`;
}

// ───────────────────────────── Actions disponibles ─────────────────────────────

export type LobbyActionId =
  // choix
  | 'host'
  | 'join'
  // salon (hôte ou invité)
  | 'level'
  | 'character'
  | 'difficulty'
  | 'ready'
  | 'invite'
  | 'start'
  // connexion de l'invité
  | 'submitCode'
  | 'retry'
  // commun
  | 'back';

export interface LobbyAction {
  id: LobbyActionId;
  enabled: boolean;
  /** Pourquoi l'action est indisponible (message à afficher), le cas échéant. */
  blocked?: LobbyMessage;
}

export interface LobbyContext {
  /** État autoritaire du salon (hôte : `getLobby()` ; invité : `getLobby()` ou null avant l'accueil). */
  lobby: LobbyState | null;
  /** Emplacement de cet appareil dans le salon. */
  localSlot: number | null;
  /** WebRTC disponible dans ce navigateur (`isRtcSupported()`) ; sans effet en mode BroadcastChannel. */
  rtcSupported: boolean;
}

/** Peut-on créer une invitation ? WebRTC seulement, aucune invitation en cours, et au moins une place libre (invités connectés + invitations en cours < 3). */
export function canInvite(state: NetLobbyState, lobby: LobbyState | null): boolean {
  if (state.step !== 'host' || state.transport !== 'webrtc') return false;
  if (liveInvites(state).length > 0) return false;
  return (lobby ? guestCount(lobby) : 0) < MAX_GUESTS;
}

/**
 * Actions de l'étape courante, dans l'ordre d'affichage. Chaque action dit si elle est activable et, sinon, pourquoi.
 *  - `choose` : héberger / rejoindre (indisponibles sans WebRTC en mode WebRTC), retour ;
 *  - `host` : niveau, personnage, difficulté, inviter (WebRTC), lancer (selon `hostStartCheck`), retour (= fermer le salon) ;
 *  - `join` : saisie du code (phase `code`), réessayer (phase `failed`), retour (= annuler) ;
 *  - `guest` : personnage, difficulté, prêt (ce dernier verrouille le personnage et la difficulté : on se remet « pas prêt » pour les changer), retour (= quitter).
 */
export function lobbyActions(state: NetLobbyState, ctx: LobbyContext): LobbyAction[] {
  switch (state.step) {
    case 'choose': {
      const unsupported = state.transport === 'webrtc' && !ctx.rtcSupported;
      const blocked = unsupported ? messageFromRtcError('unsupported') : undefined;
      return [
        { id: 'host', enabled: !unsupported, blocked },
        { id: 'join', enabled: !unsupported, blocked },
        { id: 'back', enabled: true },
      ];
    }
    case 'host': {
      const actions: LobbyAction[] = [
        { id: 'level', enabled: true },
        { id: 'character', enabled: true },
        { id: 'difficulty', enabled: true },
      ];
      if (state.transport === 'webrtc') {
        const full = ctx.lobby ? guestCount(ctx.lobby) >= MAX_GUESTS : false;
        actions.push({ id: 'invite', enabled: canInvite(state, ctx.lobby), blocked: full ? { key: 'net.lobby.invite.full', tone: 'info' } : undefined });
      }
      const check = ctx.lobby ? hostStartCheck(ctx.lobby) : ({ ok: false, reason: 'needTwo' } as StartCheck);
      actions.push({ id: 'start', enabled: check.ok, blocked: check.ok ? undefined : messageFromStartReason(check.reason) });
      actions.push({ id: 'back', enabled: true });
      return actions;
    }
    case 'join': {
      const actions: LobbyAction[] = [];
      if (state.transport === 'webrtc' && state.join === 'code') actions.push({ id: 'submitCode', enabled: true });
      if (state.join === 'failed') actions.push({ id: 'retry', enabled: true });
      actions.push({ id: 'back', enabled: true });
      return actions;
    }
    case 'guest': {
      const me = ctx.lobby ? slotOf(ctx.lobby, ctx.localSlot) : undefined;
      const locked = me?.ready === true;
      return [
        { id: 'character', enabled: !locked && me !== undefined },
        { id: 'difficulty', enabled: !locked && me !== undefined },
        { id: 'ready', enabled: me !== undefined },
        { id: 'back', enabled: true },
      ];
    }
    default:
      return [];
  }
}

/** Libellé court d'un niveau de la liste (« 3. Les Balcons ») : `name` est le nom déjà traduit, `null` → repli numéroté fourni par l'appelant. */
export function levelLabel(index: number, name: string | null, fallback: string): string {
  return `${index + 1}. ${name ?? fallback}`;
}

// ───────────────────────────── Géométrie des éléments DOM ─────────────────────────────

/** Rectangle en pixels LOGIQUES du jeu (canvas 1280 × 720). */
export interface LogicalRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Rectangle du canvas à l'écran (`getBoundingClientRect`). */
export interface CanvasBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface CssRect {
  left: number;
  top: number;
  width: number;
  height: number;
  /** Échelle logique → CSS (largeur du canvas / largeur logique). */
  scale: number;
}

/**
 * Convertit un rectangle logique en rectangle CSS superposé au canvas. `minW` / `minH` (px CSS) imposent une taille minimale tactile (par exemple 44 px) : le
 * rectangle grandit alors autour de son centre vertical (et vers la droite en largeur) mais reste dans le canvas. Largeur logique nulle → échelle 1.
 */
export function logicalToCss(rect: LogicalRect, box: CanvasBox, logicalWidth: number, opts: { minW?: number; minH?: number } = {}): CssRect {
  const scale = logicalWidth > 0 && box.width > 0 ? box.width / logicalWidth : 1;
  let width = rect.w * scale;
  let height = rect.h * scale;
  let left = box.left + rect.x * scale;
  let top = box.top + rect.y * scale;
  if (opts.minW !== undefined && width < opts.minW) width = opts.minW;
  if (opts.minH !== undefined && height < opts.minH) {
    top -= (opts.minH - height) / 2;
    height = opts.minH;
  }
  return { left, top, width, height, scale };
}
