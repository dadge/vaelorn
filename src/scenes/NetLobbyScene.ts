/**
 * NetLobbyScene : salon du MULTIJOUEUR RÉSEAU (un joueur par appareil, hôte autoritaire : docs/NET.md). Rendu mince : toute la logique (machine d'états de
 * l'écran, actions disponibles, validations, lecture du salon) est PURE et testée dans `src/render/netLobbyLogic.ts` ; les sessions réseau sont celles du contrat
 * (`src/net/contracts.ts`, rangées dans `src/net/netRuntime.ts`).
 *
 * ÉTAPES (`NetLobbyState.step`) :
 *  - `choose` : nom du joueur, puis « Héberger » ou « Rejoindre » ;
 *  - `host` : salon de l'hôte (joueurs connectés avec personnage, état et latence ; niveau, personnage, difficulté ; « Lancer » dès 2 joueurs prêts). WebRTC : « Inviter
 *    un joueur » crée un code d'invitation (copier / envoyer), l'hôte colle le code de réponse de l'invité (un code par invité, jusqu'à 3). `?net=bc` : les invités
 *    arrivent seuls ;
 *  - `join` : l'invité colle le code d'invitation, reçoit un code de réponse à donner à l'hôte, puis attend la connexion (BroadcastChannel : recherche de l'hôte) ;
 *  - `guest` : salon de l'invité (personnage, difficulté, « Prêt »), attente du lancement par l'hôte.
 *
 * TRANSPORT : `?net=bc` (mode de développement, deux FENÊTRES du même navigateur) → BroadcastChannel, sans copier-coller (code de salon facultatif) ; sinon WebRTC
 * DataChannel à signalisation manuelle. Les zones de texte et les boutons Copier / Coller / Valider sont de vrais éléments DOM superposés au canvas (`netLobbyDom.ts`) :
 * le presse-papiers et le clavier virtuel d'un téléphone l'exigent ; ils sont retirés (avec leurs écouteurs) à la fermeture de la scène.
 *
 * SESSIONS : créées ici (`createHostSession` / `createClientSession`), rangées dans `netRuntime` et PARTAGÉES avec `GameScene`, qui les lit ; elles survivent aux
 * parties (retour au salon : entrée `return`, mêmes liaisons). Elles sont libérées (`clearNetRuntime`) en quittant le multijoueur. Aucun minuteur interne : la scène appelle
 * `update(performance.now())` des sessions à chaque image.
 *
 * LANCEMENT : l'hôte tire la graine (`Date.now` / `Math.random` sont permis dans une scène, jamais dans `src/core`), `startGame(seed)` ; chaque invité reçoit `start`.
 * Tous démarrent `GameScene` avec `sessionFromNetStart(...)` (champ `GameSession.net`). Aucune sauvegarde n'est lue ni écrite ici.
 *
 * Commandes : clavier / manette / manette virtuelle tactile (MenuNavigator : haut / bas, gauche / droite pour modifier, A / Entrée pour valider, B / Échap pour revenir) et
 * souris / toucher sur les lignes. Quand un champ de saisie a le focus, le clavier ne pilote plus le salon (la manette si).
 */
import Phaser from 'phaser';
import { CHARACTERS } from '../core/characters';
import { GAME_WIDTH } from '../core/constants';
import { getBuildInfo } from '../buildInfo';
import { getLanguage, t } from '../i18n/i18n';
import { MenuNavigator, inputManager } from '../input';
import type { MenuAction } from '../input';
import { LEVELS, getLevelByIndex } from '../levels';
import {
  NET,
  parseNetTransportParam,
  sessionFromNetStart,
  type ClientSessionApi,
  type HostSessionApi,
  type LobbyState,
  type NetClosedInfo,
  type NetNotice,
  type NetStartInfo,
  type RtcGuestAnswer,
  type RtcHostInvite,
  type RtcHostSignaling,
  type Transport,
  type TransportKind,
  type NetRole,
} from '../net/contracts';
import { createClientSession } from '../net/clientSession';
import { createHostSession } from '../net/hostSession';
import { connectBroadcastGuest, createBroadcastHost } from '../net/transportBroadcast';
import { createRtcGuestSignaling, createRtcHostSignaling, isRtcSupported } from '../net/rtcSignaling';
import { clearNetRuntime, createClientRuntime, createHostRuntime, getClientSession, getHostSession, getNetRuntime, setNetRuntime } from '../net/netRuntime';
import {
  activeInvite,
  chipInvites,
  backOutcome,
  checkPastedCode,
  needsCloseConfirm,
  createNetLobbyState,
  createReturnState,
  levelLabel,
  loadStoredName,
  lobbyActions,
  messageFromCodeCheck,
  messageFromJoinError,
  messageFromNotice,
  messageFromRtcError,
  messageFromStartReason,
  noticeForClosure,
  normalizeName,
  participantRows,
  reduceNetLobby,
  rtcErrorCodeOf,
  roomCodeToChannel,
  sanitizeRoomCode,
  slotOf,
  statusKey,
  stepCharacter,
  stepDifficulty,
  stepLevelIndex,
  storeName,
  takenCharacters,
  type LobbyAction,
  type LobbyActionId,
  type LobbyMessage,
  type NetLobbyEvent,
  type NetLobbyState,
  type NetTransportChoice,
} from '../render/netLobbyLogic';
import { SCENE_KEYS, type GameSceneData, type MenuSceneData, type NetLobbySceneData } from '../render/session';
import { PANEL_STYLES, UI_THEME, beginScene, bindLanguage, createDawnBackground, createPanel, createText, css, drawArrow, playerColor, transitionTo, type DecorHandle } from '../render/ui';
import { NetLobbyDom, copyToClipboard, readFromClipboard, type DomButtonSpec, type DomFieldSpec } from './netLobbyDom';

// ───────────────────────────── Géométrie (pixels logiques 1280 × 720) ─────────────────────────────

const LEFT_X = 40;
const LEFT_W = 580;
const RIGHT_X = 660;
const RIGHT_W = 580;
/**
 * Largeur des lignes du bas de la colonne droite, ancrées à gauche de la colonne : sur téléphone paysage 16:9 (ex. 667 × 375), la manette tactile (boutons X / A / B / Y)
 * occupe le coin bas droit ; mesuré, le bouton X commence vers x logique 992, donc ces lignes s'arrêtent à 660 + 320 = 980.
 */
const BOTTOM_W = 320;
/** Délai (ms) du second appui qui confirme la fermeture du salon de l'hôte. */
const CLOSE_CONFIRM_MS = 3000;
const ROW_H = 46;
const ROW_STEP = 54;
const PLAYER_ROW_H = 48;
const PLAYER_ROW_STEP = 52;
const MESSAGE_Y = 664;
const HINT_Y = 700;
/** Durée (ms) d'affichage d'un message d'information (copie réussie, joueur arrivé…). */
const INFO_MESSAGE_MS = 5000;
/** Durée (ms) du fondu avant de lancer la partie (court : l'hôte et les invités démarrent ensemble). */
const LAUNCH_FADE_MS = 120;
/** Délai (ms) accordé à un invité BroadcastChannel pour trouver l'hôte. */
const BC_JOIN_TIMEOUT_MS = 5000;

// ───────────────────────────── Objets vivants hors scène ─────────────────────────────

/**
 * Invitations WebRTC de l'hôte : objets vivants qui survivent à la scène (la session hôte survit aux parties) mais qui n'ont aucune place dans `GameSession`
 * (JSON pur). Créé à l'ouverture du salon WebRTC, libéré avec la session (`clearNetRuntime`) ou au lancement d'une partie (invitations en attente annulées).
 */
interface LiveHostLink {
  signaling: RtcHostSignaling | null;
  invites: Map<number, RtcHostInvite>;
}
let liveHost: LiveHostLink | null = null;

function cancelPendingInvites(): void {
  if (!liveHost) return;
  for (const invite of liveHost.invites.values()) {
    try {
      invite.cancel();
    } catch {
      /* déjà annulée */
    }
  }
  liveHost.invites.clear();
}

function disposeLiveHost(): void {
  cancelPendingInvites();
  liveHost = null;
}

/** Stockage local, ou null s'il est indisponible (mode privé, stockage bloqué…). */
function localStore(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

// ───────────────────────────── Lignes ─────────────────────────────

/** Ligne du salon : bouton (`action`), choix à flèches (`choice`) ou simple affichage (`info`, non sélectionnable). */
interface RowSpec {
  id: LobbyActionId | 'info';
  kind: 'action' | 'choice' | 'info';
  x: number;
  y: number;
  w: number;
  label: string;
  value?: string;
  enabled: boolean;
  color?: number;
  /** Message affiché quand on valide une ligne indisponible (pourquoi). */
  blocked?: LobbyMessage;
  left?: () => void;
  right?: () => void;
  confirm?: () => void;
}

interface RowView {
  spec: RowSpec;
  normal: Phaser.GameObjects.Graphics;
  selected: Phaser.GameObjects.Graphics;
  disabled: Phaser.GameObjects.Graphics;
  label: Phaser.GameObjects.Text;
  value: Phaser.GameObjects.Text | null;
}

/** Réduit `text` pour tenir dans `maxWidth` (jamais agrandi). */
function fit(text: Phaser.GameObjects.Text, content: string, maxWidth: number): void {
  text.setText(content);
  text.setScale(text.width > maxWidth ? maxWidth / text.width : 1);
}

export class NetLobbyScene extends Phaser.Scene {
  private entry: NetLobbySceneData = { entry: 'menu' };
  private state: NetLobbyState = createNetLobbyState('webrtc');
  private dom: NetLobbyDom | null = null;
  private nav!: MenuNavigator;
  private bg!: DecorHandle;
  /** Objets Phaser du rendu courant (détruits et recréés à chaque rendu). */
  private objects: Phaser.GameObjects.GameObject[] = [];
  private rows: RowView[] = [];
  private selectedId = '';
  /** Le rendu doit être refait à la prochaine image (état de l'écran, salon, langue). */
  private dirty = true;
  private name = '';
  private defaultName = '';
  private roomCode = '';
  private rtcSupported = true;
  /** Instant (horloge `performance.now`) où le message d'information s'efface (+Infinity : il reste jusqu'au prochain événement). */
  private messageUntil = Number.POSITIVE_INFINITY;
  private unsubs: Array<() => void> = [];
  private starting = false;
  /** Instant (`performance.now`) jusqu'auquel un second appui sur « fermer le salon » est accepté (l'hôte avec des invités connectés). */
  private closeArmedUntil = 0;
  private closed = false;
  /** Jeton de la connexion d'invité en cours : une réponse asynchrone d'une tentative annulée porte un ancien jeton et est ignorée. */
  private joinToken = 0;
  private pendingAnswer: RtcGuestAnswer | null = null;
  /** Dernier `seq` de salon pour lequel on a tenté de remettre l'hôte « prêt » (évite toute boucle). */
  private lastEnsureSeq = -1;

  constructor() {
    super(SCENE_KEYS.NetLobby);
  }

  init(data?: NetLobbySceneData): void {
    this.entry = data ?? { entry: 'menu' };
    this.closed = false;
    this.starting = false;
    this.joinToken = 0;
    this.pendingAnswer = null;
    this.lastEnsureSeq = -1;
    this.objects = [];
    this.rows = [];
    this.unsubs = [];
    this.selectedId = '';
    this.dirty = true;
    this.messageUntil = Number.POSITIVE_INFINITY;
    this.roomCode = '';
    this.defaultName = t('net.lobby.defaultName');
    this.name = loadStoredName(localStore(), this.defaultName);
    try {
      this.rtcSupported = isRtcSupported();
    } catch {
      this.rtcSupported = false;
    }
    const wanted: NetTransportChoice = typeof window !== 'undefined' ? parseNetTransportParam(window.location.search) : 'webrtc';

    const rt = getNetRuntime();
    const alive = rt !== null && ((rt.host !== null && rt.host.phase !== 'closed') || (rt.client !== null && rt.client.phase !== 'closed'));
    if (this.entry.entry === 'return' && rt && alive) {
      const kind = (rt.host ?? rt.client)?.transportKind;
      this.state = createReturnState(kind === 'broadcast' ? 'broadcast' : 'webrtc', rt.role, this.entry.notice);
      this.messageUntil = this.state.message ? performance.now() + INFO_MESSAGE_MS : Number.POSITIVE_INFINITY;
    } else {
      // Arrivée depuis le menu, ou retour dont la session a disparu : on repart d'un salon propre.
      if (rt) clearNetRuntime();
      disposeLiveHost();
      this.state = createNetLobbyState(wanted);
      if (this.entry.notice) this.state = reduceNetLobby(this.state, { type: 'message', message: messageFromNotice(this.entry.notice, 'error') });
    }
  }

  create(): void {
    beginScene(this);
    this.cameras.main.setBackgroundColor(UI_THEME.bg);
    this.prepareInput();
    this.bg = createDawnBackground(this, { dim: 0.45 });
    this.nav = new MenuNavigator();
    try {
      this.dom = new NetLobbyDom(this.game.canvas);
    } catch {
      this.dom = null; // pas de DOM : le salon se pilote sans zones de saisie (tests, environnement sans document)
    }
    bindLanguage(this, () => {
      this.dirty = true;
    });
    this.events.once('shutdown', () => this.cleanup());
    this.events.once('destroy', () => this.cleanup());

    const host = getHostSession();
    if (host) {
      this.bindHost(host);
      this.ensureHostReady(host, host.getLobby());
    }
    const client = getClientSession();
    if (client) this.bindClient(client);
    this.render();
    this.dirty = false;
  }

  update(time: number): void {
    this.bg.update(time);
    const now = performance.now();
    getHostSession()?.update(now);
    getClientSession()?.update(now);

    // L'invité passe au salon dès que l'hôte l'a accueilli (le salon autoritaire est connu).
    if (this.state.step === 'join') {
      const client = getClientSession();
      if (client && client.getLobby()) this.dispatch({ type: 'joined' });
    }
    if (this.state.message && this.state.message.tone === 'info' && now >= this.messageUntil) this.dispatch({ type: 'message', message: null });
    if (this.dirty) {
      this.dirty = false;
      this.render();
    }
    this.dom?.layout();
    if (this.starting) return;
    for (const intent of this.nav.pollMenu()) {
      if (intent.source === 'keyboard' && this.dom?.hasFocus()) continue; // le joueur tape : le clavier ne pilote pas le menu
      this.onAction(intent.action);
    }
  }

  // ───────────────────────────── Cycle de vie ─────────────────────────────

  /** Appareils : le salon se pilote par les périphériques bruts (comme les menus), aucune attribution de joueur. */
  private prepareInput(): void {
    inputManager.attach();
    inputManager.clearAssignments();
    inputManager.setPlayer1Gamepad(false);
    inputManager.setPlayerCount(1);
  }

  private cleanup(): void {
    if (this.closed) return;
    this.closed = true;
    this.unbind();
    this.dom?.destroy();
    this.dom = null;
    this.objects = [];
    this.rows = [];
  }

  private unbind(): void {
    const offs = this.unsubs;
    this.unsubs = [];
    for (const off of offs) {
      try {
        off();
      } catch {
        /* déjà désabonné */
      }
    }
  }

  /** Applique un événement à la machine d'états de l'écran ; demande un nouveau rendu si l'état a changé. */
  private dispatch(event: NetLobbyEvent): void {
    const previous = this.state;
    this.state = reduceNetLobby(previous, event);
    if (this.state === previous) return;
    if (this.state.message !== previous.message) {
      this.messageUntil = this.state.message && this.state.message.tone === 'info' ? performance.now() + INFO_MESSAGE_MS : Number.POSITIVE_INFINITY;
    }
    this.dirty = true;
  }

  private info(key: string, params?: Record<string, string | number>): void {
    this.dispatch({ type: 'message', message: params ? { key, params, tone: 'info' } : { key, tone: 'info' } });
  }

  private fail(message: LobbyMessage): void {
    this.dispatch({ type: 'message', message });
  }

  /** Quitte le multijoueur : libère la session réseau (envoie `leave`) et retourne au menu, avec un message éventuel. */
  private leaveToMenu(notice?: NetNotice): void {
    if (this.starting) return;
    this.starting = true;
    this.commitName();
    this.dom?.destroy(); // les zones de saisie ne restent pas affichées pendant le fondu
    this.dom = null;
    this.unbind();
    this.joinToken++;
    clearNetRuntime();
    disposeLiveHost();
    const data: MenuSceneData = notice ? { notice } : {};
    transitionTo(this, SCENE_KEYS.Menu, data, 200);
  }

  private commitName(): void {
    this.name = normalizeName(this.name, this.defaultName);
    storeName(localStore(), this.name, this.defaultName);
  }

  // ───────────────────────────── Lecture de l'état autoritaire ─────────────────────────────

  private currentLobby(): LobbyState | null {
    return getHostSession()?.getLobby() ?? getClientSession()?.getLobby() ?? null;
  }

  private localSlot(): number | null {
    if (getHostSession()) return 0;
    return getClientSession()?.slot ?? null;
  }

  // ───────────────────────────── Hôte ─────────────────────────────

  private openHost(): void {
    this.commitName();
    const kind: TransportKind = this.state.transport === 'broadcast' ? 'broadcast' : 'webrtc';
    let host: HostSessionApi | null = null;
    try {
      host = createHostSession({ hostName: this.name, build: getBuildInfo(), levelCount: LEVELS.length, transportKind: kind });
      let extra: () => void;
      if (kind === 'broadcast') {
        const link = createBroadcastHost(roomCodeToChannel(this.roomCode));
        const session = host;
        const off = link.onGuest((transport) => session.addGuest(transport));
        extra = () => {
          off();
          link.close();
        };
      } else {
        liveHost = { signaling: null, invites: new Map() };
        extra = disposeLiveHost;
      }
      setNetRuntime(createHostRuntime(host, extra));
    } catch (err) {
      try {
        host?.close();
      } catch {
        /* déjà fermée */
      }
      disposeLiveHost();
      this.fail(messageFromJoinError(err));
      return;
    }
    this.bindHost(host);
    this.dispatch({ type: 'chooseHost' });
    this.ensureHostReady(host, host.getLobby());
  }

  private bindHost(host: HostSessionApi): void {
    this.unsubs.push(
      host.onLobby((lobby) => {
        this.dirty = true;
        this.ensureHostReady(host, lobby);
      }),
      host.onPeerEvent((e) => {
        if (e.type === 'joined') this.info('net.lobby.peerJoined', { name: e.name });
        else if (e.type === 'left') this.info('net.lobby.peerLeft', { name: e.name });
        else this.info('net.game.peerLost', { name: e.name });
      }),
    );
  }

  /**
   * L'hôte est « prêt » d'office (son personnage est verrouillé dès qu'il le choisit : les invités le voient grisé). Un changement de niveau, de personnage ou de
   * difficulté le remet « pas prêt » côté session : on le remet prêt, UNE fois par version du salon (jamais de boucle), sauf si son personnage est déjà pris.
   */
  private ensureHostReady(host: HostSessionApi, lobby: LobbyState): void {
    const me = slotOf(lobby, 0);
    if (!me || me.ready || this.lastEnsureSeq === lobby.seq) return;
    this.lastEnsureSeq = lobby.seq;
    if (takenCharacters(lobby, 0).has(me.characterId)) return;
    host.setLocalChoice({ ready: true });
  }

  /** « Lancer » : l'hôte se met prêt, la session tranche (`checkStart`), la graine est tirée ICI (une scène peut tirer l'aléa). */
  private startGame(): void {
    const host = getHostSession();
    if (!host || this.starting || host.phase !== 'lobby') return;
    host.setLocalChoice({ ready: true });
    const me = slotOf(host.getLobby(), 0);
    if (me && !me.ready) {
      this.fail(messageFromStartReason('characterTaken'));
      return;
    }
    const check = host.checkStart();
    if (!check.ok) {
      this.fail(messageFromStartReason(check.reason));
      return;
    }
    const seed = (Date.now() ^ Math.floor(Math.random() * 0x100000000)) >>> 0;
    const info = host.startGame(seed);
    if (!info) {
      this.fail({ key: 'net.lobby.error.generic', tone: 'error' });
      return;
    }
    this.launch(info, 'host', host.transportKind);
  }

  /** Démarre `GameScene` avec la session réseau (hôte : retour de `startGame` ; invité : rappel `onStart`). */
  private launch(info: NetStartInfo, role: NetRole, transport: TransportKind): void {
    if (this.starting || this.closed) return;
    this.starting = true;
    this.commitName();
    cancelPendingInvites(); // les invitations non abouties ne servent plus : la partie a commencé
    this.dom?.destroy();
    this.dom = null;
    this.prepareInput();
    const data: GameSceneData = { session: sessionFromNetStart(info, role, transport) };
    transitionTo(this, SCENE_KEYS.Game, data, LAUNCH_FADE_MS);
  }

  // ───────────────────────────── Invitations WebRTC (hôte) ─────────────────────────────

  private async startInvite(): Promise<void> {
    if (!liveHost) liveHost = { signaling: null, invites: new Map() };
    const link = liveHost;
    const before = this.state.invites.length;
    this.dispatch({ type: 'inviteStarted' });
    if (this.state.invites.length === before) return; // refusée par la machine d'états (pas en WebRTC, ou une invitation est déjà en cours)
    const id = this.state.invites[this.state.invites.length - 1].id;
    try {
      link.signaling ??= createRtcHostSignaling();
      const invite = await link.signaling.createInvite();
      const stillWanted = !this.closed && this.state.invites.some((i) => i.id === id && i.status === 'creating');
      if (!stillWanted) {
        invite.cancel();
        return;
      }
      link.invites.set(id, invite);
      this.dispatch({ type: 'inviteReady', id, code: invite.code });
    } catch (err) {
      if (!this.closed) this.dispatch({ type: 'inviteFailed', id, error: rtcErrorCodeOf(err) ?? 'failed' });
    }
  }

  private async acceptInvite(id: number): Promise<void> {
    const raw = this.dom?.getValue(`inviteAnswer${id}`) ?? '';
    const check = checkPastedCode(raw);
    if (!check.ok) {
      this.fail(messageFromCodeCheck(check.error));
      return;
    }
    const invite = liveHost?.invites.get(id);
    if (!invite || this.state.invites.find((i) => i.id === id)?.status !== 'ready') return; // double clic : une seule acceptation
    this.dispatch({ type: 'inviteAccepting', id });
    try {
      const transport: Transport = await invite.accept(check.code);
      liveHost?.invites.delete(id);
      const host = getHostSession();
      if (!host || host.phase === 'closed') {
        transport.close();
        return;
      }
      host.addGuest(transport);
      if (!this.closed) this.dispatch({ type: 'inviteConnected', id });
    } catch (err) {
      const code = rtcErrorCodeOf(err) ?? 'failed';
      if (code === 'badCode' || code === 'wrongVersion') {
        // la signalisation n'a pas consommé l'invitation (code tronqué par un copier-coller, etc.) : on la garde et l'hôte peut recoller
        if (!this.closed) this.dispatch({ type: 'inviteRetry', id, error: code });
        return;
      }
      // échec définitif : on libère la connexion (RTCPeerConnection, DataChannel, collecte ICE) avant d'oublier l'invitation
      liveHost?.invites.delete(id);
      try {
        invite.cancel();
      } catch {
        /* déjà annulée */
      }
      if (!this.closed) this.dispatch({ type: 'inviteFailed', id, error: code });
    }
  }

  /** Annule ou écarte une invitation (WebRTC) : la connexion en préparation est abandonnée. */
  private dismissInvite(id: number): void {
    const invite = liveHost?.invites.get(id);
    liveHost?.invites.delete(id);
    try {
      invite?.cancel();
    } catch {
      /* déjà annulée */
    }
    this.dispatch({ type: 'inviteDismissed', id });
  }

  // ───────────────────────────── Invité ─────────────────────────────

  private onChooseJoin(): void {
    this.commitName();
    this.dispatch({ type: 'chooseJoin' });
    if (this.state.step === 'join' && this.state.transport === 'broadcast') this.startBroadcastJoin();
  }

  /** BroadcastChannel (développement) : recherche d'un hôte sur le canal du code de salon. */
  private startBroadcastJoin(): void {
    const token = ++this.joinToken;
    let pending: Promise<Transport>;
    try {
      pending = connectBroadcastGuest(roomCodeToChannel(this.roomCode), BC_JOIN_TIMEOUT_MS);
    } catch (err) {
      this.dispatch({ type: 'joinFailed', message: messageFromJoinError(err) });
      return;
    }
    pending.then(
      (transport) => {
        if (token !== this.joinToken || this.closed) {
          transport.close();
          return;
        }
        this.attachClient(transport);
      },
      (err: unknown) => {
        if (token === this.joinToken && !this.closed) this.dispatch({ type: 'joinFailed', message: messageFromJoinError(err) });
      },
    );
  }

  /** WebRTC : valide le code collé, produit le code de réponse, puis attend que l'hôte le colle (le canal s'ouvre alors tout seul). */
  private async submitJoinCode(): Promise<void> {
    const check = checkPastedCode(this.dom?.getValue('joinCode') ?? '');
    if (!check.ok) {
      this.fail(messageFromCodeCheck(check.error));
      return;
    }
    this.commitName();
    const token = ++this.joinToken;
    this.dispatch({ type: 'joinSubmitted' });
    try {
      const answer = await createRtcGuestSignaling().join(check.code);
      if (token !== this.joinToken || this.closed) {
        answer.cancel();
        return;
      }
      this.pendingAnswer = answer;
      this.dispatch({ type: 'answerReady', answerCode: answer.answerCode });
      const transport = await answer.transport;
      if (token !== this.joinToken || this.closed) {
        transport.close();
        return;
      }
      this.pendingAnswer = null;
      this.attachClient(transport, () => answer.cancel());
    } catch (err) {
      if (token === this.joinToken && !this.closed) {
        this.pendingAnswer = null;
        this.dispatch({ type: 'joinFailed', message: messageFromJoinError(err) });
      }
    }
  }

  /** Crée la session invité sur le transport ouvert (le `hello` part tout seul) et la range dans `netRuntime`. */
  private attachClient(transport: Transport, extraDispose?: () => void): void {
    const client = createClientSession(transport, { name: this.name, build: getBuildInfo(), levelCount: LEVELS.length });
    setNetRuntime(createClientRuntime(client, extraDispose));
    this.bindClient(client);
    this.dispatch({ type: 'joinConnecting' });
  }

  private bindClient(client: ClientSessionApi): void {
    this.unsubs.push(
      client.onLobby(() => {
        this.dirty = true;
      }),
      client.onStart((info) => this.launch(info, 'client', client.transportKind)),
      client.onClosed((info) => this.onClientClosed(info)),
    );
  }

  /** Session invité fermée : refus ou échec pendant la connexion = on reste sur l'écran avec le message ; salon quitté = retour au menu avec le message. */
  private onClientClosed(info: NetClosedInfo): void {
    if (this.starting || this.closed) return;
    const notice = noticeForClosure(info, { build: getBuildInfo(), levels: LEVELS.length }, getLanguage());
    if (this.state.step === 'join') {
      this.unbind();
      this.joinToken++;
      clearNetRuntime();
      this.dispatch({ type: 'joinFailed', message: notice ? messageFromNotice(notice, 'error') : messageFromRtcError('failed') });
      return;
    }
    this.leaveToMenu(notice ?? undefined);
  }

  /** Abandonne la connexion en cours (retour au choix) : réponses tardives ignorées (jeton), session et réponse WebRTC libérées. */
  private cancelJoin(): void {
    this.joinToken++;
    this.unbind();
    const answer = this.pendingAnswer;
    this.pendingAnswer = null;
    try {
      answer?.cancel();
    } catch {
      /* déjà annulée */
    }
    if (getNetRuntime()) clearNetRuntime();
  }

  private goBack(): void {
    if (backOutcome(this.state) === 'menu') {
      if (needsCloseConfirm(this.state, this.currentLobby())) {
        const now = performance.now();
        if (now > this.closeArmedUntil) {
          this.closeArmedUntil = now + CLOSE_CONFIRM_MS;
          this.info('net.lobby.closeRoom.confirm');
          return;
        }
      }
      this.leaveToMenu();
      return;
    }
    this.cancelJoin();
    this.dispatch({ type: 'back' });
  }

  // ───────────────────────────── Entrées ─────────────────────────────

  private onAction(action: MenuAction): void {
    const rows = this.rows.filter((r) => r.spec.kind !== 'info');
    if (action === 'back') {
      this.goBack();
      return;
    }
    if (rows.length === 0) return;
    const idx = Math.max(
      0,
      rows.findIndex((r) => r.spec.id === this.selectedId),
    );
    const cur = rows[idx];
    switch (action) {
      case 'up':
      case 'down': {
        const next = rows[(idx + (action === 'down' ? 1 : rows.length - 1)) % rows.length];
        this.selectedId = next.spec.id;
        this.applySelection();
        break;
      }
      case 'left':
        this.activate(cur, 'left');
        break;
      case 'right':
        this.activate(cur, 'right');
        break;
      case 'confirm':
        this.activate(cur, 'confirm');
        break;
      default:
        break;
    }
  }

  /** Valide ou modifie une ligne ; une ligne indisponible explique pourquoi. */
  private activate(row: RowView | undefined, how: 'left' | 'right' | 'confirm'): void {
    if (!row || this.starting) return;
    const spec = row.spec;
    if (!spec.enabled) {
      if (how === 'confirm' && spec.blocked) this.fail(spec.blocked);
      return;
    }
    if (how === 'left') (spec.left ?? undefined)?.();
    else if (how === 'right') (spec.right ?? undefined)?.();
    else if (spec.confirm) spec.confirm();
    else (spec.right ?? undefined)?.();
  }

  // ───────────────────────────── Actions du salon ─────────────────────────────

  private hostChangeLevel(dir: 1 | -1): void {
    const host = getHostSession();
    const lobby = host?.getLobby();
    if (!host || !lobby) return;
    host.setLevel(stepLevelIndex(lobby.levelIndex, dir, lobby.levelCount));
  }

  private hostChangeCharacter(dir: 1 | -1): void {
    const host = getHostSession();
    const lobby = host?.getLobby();
    const me = lobby ? slotOf(lobby, 0) : undefined;
    if (!host || !lobby || !me) return;
    const next = stepCharacter(lobby, 0, me.characterId, dir);
    if (next !== me.characterId) host.setLocalChoice({ characterId: next, ready: false }); // `ensureHostReady` le remet prêt
  }

  private hostChangeDifficulty(dir: 1 | -1): void {
    const host = getHostSession();
    const me = host ? slotOf(host.getLobby(), 0) : undefined;
    if (!host || !me) return;
    host.setLocalChoice({ difficulty: stepDifficulty(me.difficulty, dir), ready: false });
  }

  private guestChoose(change: 'character' | 'difficulty' | 'ready', dir: 1 | -1): void {
    const client = getClientSession();
    const lobby = client?.getLobby();
    const me = lobby ? slotOf(lobby, client?.slot) : undefined;
    if (!client || !lobby || !me) return;
    if (change === 'ready') {
      client.sendChoice({ characterId: me.characterId, difficulty: me.difficulty, ready: !me.ready });
      return;
    }
    if (me.ready) return; // verrouillé : on se remet « pas prêt » pour changer
    if (change === 'character') client.sendChoice({ characterId: stepCharacter(lobby, client.slot, me.characterId, dir), difficulty: me.difficulty, ready: false });
    else client.sendChoice({ characterId: me.characterId, difficulty: stepDifficulty(me.difficulty, dir), ready: false });
  }

  private copyField(fieldId: string): void {
    const el = this.dom?.field(fieldId);
    if (!el) return;
    void copyToClipboard(el.value, el).then((result) => {
      if (!this.closed) this.info(result === 'copied' ? 'net.lobby.copy.done' : 'net.lobby.copy.manual');
    });
  }

  private pasteInto(fieldId: string): void {
    void readFromClipboard().then((text) => {
      if (this.closed || !this.dom) return;
      if (text !== null && text.trim().length > 0) {
        this.dom.setValue(fieldId, text);
      } else {
        this.info('net.lobby.paste.manual');
        this.dom.focus(fieldId);
      }
    });
  }

  // ───────────────────────────── Rendu ─────────────────────────────

  private render(): void {
    for (const o of this.objects) o.destroy();
    this.objects = [];
    this.rows = [];
    const fields: DomFieldSpec[] = [];
    const buttons: DomButtonSpec[] = [];
    const s = this.state;
    const lobby = this.currentLobby();
    const ctx = { lobby, localSlot: this.localSlot(), rtcSupported: this.rtcSupported };
    const actions = lobbyActions(s, ctx);
    const action = (id: LobbyActionId): LobbyAction | undefined => actions.find((a) => a.id === id);

    this.track(createText(this, GAME_WIDTH / 2, 34, t('net.lobby.title'), { size: 'lg', color: UI_THEME.accent, origin: [0.5, 0.5], align: 'center' }));
    const subtitle = s.step === 'host' ? t('net.lobby.host.title') : s.step === 'guest' ? t('net.lobby.guest.title') : '';
    if (subtitle) this.track(createText(this, GAME_WIDTH / 2, 72, subtitle, { size: 'md', color: UI_THEME.textDim, origin: [0.5, 0.5], align: 'center' }));

    const rowSpecs: RowSpec[] = [];
    switch (s.step) {
      case 'choose':
        this.renderChoose(action, rowSpecs, fields);
        break;
      case 'host':
        this.renderHost(lobby, action, rowSpecs, fields, buttons);
        break;
      case 'join':
        this.renderJoin(action, rowSpecs, fields, buttons);
        break;
      case 'guest':
        this.renderGuest(lobby, action, rowSpecs);
        break;
    }
    for (const spec of rowSpecs) this.rows.push(this.createRow(spec));

    if (s.message) {
      this.track(
        createText(this, GAME_WIDTH / 2, MESSAGE_Y, t(s.message.key, s.message.params), {
          size: 'sm',
          color: s.message.tone === 'error' ? UI_THEME.bad : UI_THEME.accent,
          origin: [0.5, 0.5],
          align: 'center',
          wrapWidth: 1000,
        }),
      );
    }
    this.track(createText(this, GAME_WIDTH / 2, HINT_Y, t('pad.menu.hint'), { size: 'sm', color: UI_THEME.textDim, origin: [0.5, 0.5], align: 'center' }));

    if (!this.rows.some((r) => r.spec.id === this.selectedId && r.spec.kind !== 'info')) {
      this.selectedId = this.rows.find((r) => r.spec.kind !== 'info' && r.spec.enabled)?.spec.id ?? this.rows.find((r) => r.spec.kind !== 'info')?.spec.id ?? '';
    }
    this.applySelection();
    this.dom?.sync(fields, buttons);
  }

  private track<T extends Phaser.GameObjects.GameObject>(o: T): T {
    this.objects.push(o);
    return o;
  }

  // ── Étape « choix » ──

  private renderChoose(action: (id: LobbyActionId) => LobbyAction | undefined, rows: RowSpec[], fields: DomFieldSpec[]): void {
    this.track(createText(this, GAME_WIDTH / 2, 150, t('net.lobby.help'), { size: 'sm', color: UI_THEME.textDim, origin: [0.5, 0.5], align: 'center', wrapWidth: 900, lineSpacing: 4 }));
    const bc = this.state.transport === 'broadcast';
    // Un champ DOM fait au moins 44 px CSS de haut : sur un petit écran il déborde de son rectangle logique, d'où l'écart entre l'étiquette et le champ.
    let y = 206;
    this.track(createText(this, 390, y, t('net.lobby.name.label'), { size: 'sm', color: UI_THEME.accent }));
    fields.push({ id: 'name', kind: 'input', rect: { x: 390, y: y + 34, w: 500, h: 46 }, value: this.name, placeholder: t('net.lobby.name.placeholder'), label: t('net.lobby.name.label'), maxLength: NET.NAME_MAX_CHARS, onInput: (v) => (this.name = v) });
    y += 104;
    if (bc) {
      this.track(createText(this, 390, y, t('net.lobby.room.label'), { size: 'sm', color: UI_THEME.accent }));
      fields.push({ id: 'room', kind: 'input', rect: { x: 390, y: y + 34, w: 500, h: 46 }, value: this.roomCode, placeholder: t('net.lobby.room.placeholder'), label: t('net.lobby.room.label'), maxLength: 12, onInput: (v) => (this.roomCode = sanitizeRoomCode(v)) });
      y += 104;
    }
    y += 8;
    const host = action('host');
    const join = action('join');
    rows.push({ id: 'host', kind: 'action', x: 390, y, w: 500, label: t('net.lobby.host'), enabled: host?.enabled !== false, blocked: host?.blocked, confirm: () => this.openHost() });
    rows.push({ id: 'join', kind: 'action', x: 390, y: y + ROW_STEP, w: 500, label: t('net.lobby.join'), enabled: join?.enabled !== false, blocked: join?.blocked, confirm: () => this.onChooseJoin() });
    rows.push({ id: 'back', kind: 'action', x: 390, y: y + ROW_STEP * 2, w: 500, label: t('net.lobby.back'), enabled: true, confirm: () => this.goBack() });
    if (host && !host.enabled && host.blocked) {
      this.track(createText(this, GAME_WIDTH / 2, y + ROW_STEP * 3 + 8, t(host.blocked.key, host.blocked.params), { size: 'sm', color: UI_THEME.bad, origin: [0.5, 0], align: 'center', wrapWidth: 900 }));
    }
  }

  // ── Étape « salon de l'hôte » ──

  private renderHost(lobby: LobbyState | null, action: (id: LobbyActionId) => LobbyAction | undefined, rows: RowSpec[], fields: DomFieldSpec[], buttons: DomButtonSpec[]): void {
    this.renderPlayers(lobby);
    const me = lobby ? slotOf(lobby, 0) : undefined;
    let y = 100;
    rows.push({
      id: 'level',
      kind: 'choice',
      x: RIGHT_X,
      y,
      w: RIGHT_W,
      label: t('net.lobby.level'),
      value: this.levelName(lobby?.levelIndex ?? 0),
      enabled: true,
      left: () => this.hostChangeLevel(-1),
      right: () => this.hostChangeLevel(1),
    });
    y += ROW_STEP;
    rows.push({
      id: 'character',
      kind: 'choice',
      x: RIGHT_X,
      y,
      w: RIGHT_W,
      label: t('net.lobby.character'),
      value: me ? t(CHARACTERS[me.characterId].nameKey) : '',
      color: playerColor(0),
      enabled: me !== undefined,
      left: () => this.hostChangeCharacter(-1),
      right: () => this.hostChangeCharacter(1),
    });
    y += ROW_STEP;
    rows.push({
      id: 'difficulty',
      kind: 'choice',
      x: RIGHT_X,
      y,
      w: RIGHT_W,
      label: t('net.lobby.difficulty'),
      value: t(`menu.difficulty.${me?.difficulty ?? 2}`),
      color: playerColor(0),
      enabled: me !== undefined,
      left: () => this.hostChangeDifficulty(-1),
      right: () => this.hostChangeDifficulty(1),
    });
    y += ROW_STEP;

    const webrtc = this.state.transport === 'webrtc';
    const invite = action('invite');
    if (webrtc) {
      rows.push({
        id: 'invite',
        kind: 'action',
        x: RIGHT_X,
        y,
        w: RIGHT_W,
        label: t('net.lobby.invite.button'),
        enabled: invite?.enabled === true,
        blocked: invite?.blocked,
        confirm: () => void this.startInvite(),
      });
      this.renderInvitePanel(fields, buttons);
    } else {
      const room = this.roomCode ? `${t('net.lobby.bc.room', { room: this.roomCode })}\n\n` : '';
      this.track(createText(this, RIGHT_X + 10, y + 6, `${room}${t('net.lobby.bc.hostHint')}`, { size: 'sm', color: UI_THEME.textDim, wrapWidth: RIGHT_W - 20, lineSpacing: 4 }));
    }

    const start = action('start');
    if (start && !start.enabled && start.blocked) {
      this.track(createText(this, RIGHT_X + BOTTOM_W / 2, 498, t(start.blocked.key, start.blocked.params), { size: 'sm', color: UI_THEME.textDim, origin: [0.5, 0.5], align: 'center', wrapWidth: BOTTOM_W }));
    }
    rows.push({ id: 'start', kind: 'action', x: RIGHT_X, y: 520, w: BOTTOM_W, label: t('net.lobby.start'), enabled: start?.enabled === true, blocked: start?.blocked, confirm: () => this.startGame() });
    rows.push({ id: 'back', kind: 'action', x: RIGHT_X, y: 520 + ROW_STEP, w: BOTTOM_W, label: t('net.lobby.closeRoom'), enabled: true, confirm: () => this.goBack() });
  }

  /** Panneau d'invitation WebRTC (colonne gauche, sous la liste des joueurs) : une invitation active à la fois, les autres en simples lignes d'état. */
  private renderInvitePanel(fields: DomFieldSpec[], buttons: DomButtonSpec[]): void {
    const x = LEFT_X;
    const w = LEFT_W;
    // Les éléments DOM font au moins 44 px CSS de haut (toucher) : sur un petit écran ils dépassent leur rectangle logique, d'où les marges verticales généreuses.
    this.track(createText(this, x, 326, t('net.lobby.invite.title'), { size: 'md', color: UI_THEME.accent, origin: [0, 0.5] }));
    const chips = chipInvites(this.state)
      .map((inv) => t('net.lobby.invite.chip', { n: inv.id, status: t(`net.lobby.invite.${inv.status}`) }))
      .join('   ');
    if (chips) this.track(createText(this, x + 6, 352, chips, { size: 'sm', color: UI_THEME.textDim, wrapWidth: w - 12 }));
    const active = activeInvite(this.state);
    if (!active) return;
    const cancelLabel = active.status === 'failed' ? t('net.lobby.invite.dismiss') : t('net.lobby.invite.cancel');
    buttons.push({ id: `inviteCancel${active.id}`, label: cancelLabel, rect: { x: x + w - 150, y: 306, w: 150, h: 40 }, onClick: () => this.dismissInvite(active.id) });
    if (active.status === 'creating') {
      this.track(createText(this, x + 6, 392, t('net.lobby.invite.creating'), { size: 'sm', color: UI_THEME.textDim }));
      return;
    }
    if (active.status === 'failed') return;
    const code = `inviteCode${active.id}`;
    const answer = `inviteAnswer${active.id}`;
    const busy = active.status === 'accepting';
    this.track(createText(this, x + 6, 376, t('net.lobby.invite.code'), { size: 'sm', color: UI_THEME.text }));
    fields.push({ id: code, kind: 'textarea', rect: { x, y: 398, w: 410, h: 80 }, value: active.code ?? '', readOnly: true, label: t('net.lobby.invite.code') });
    buttons.push({ id: `${code}Copy`, label: t('net.lobby.copy'), rect: { x: x + 420, y: 398, w: 160, h: 80 }, onClick: () => this.copyField(code) });
    this.track(createText(this, x + 6, 488, t('net.lobby.invite.answer'), { size: 'sm', color: UI_THEME.text }));
    fields.push({ id: answer, kind: 'textarea', rect: { x, y: 510, w: 280, h: 80 }, value: '', readOnly: busy, label: t('net.lobby.invite.answer') });
    buttons.push({ id: `${answer}Paste`, label: t('net.lobby.paste'), rect: { x: x + 290, y: 510, w: 130, h: 80 }, enabled: !busy, onClick: () => this.pasteInto(answer) });
    buttons.push({ id: `${answer}Ok`, label: t('net.lobby.validate'), rect: { x: x + 430, y: 510, w: 150, h: 80 }, enabled: !busy, onClick: () => void this.acceptInvite(active.id) });
    if (busy) this.track(createText(this, x + 6, 600, t('net.lobby.invite.accepting'), { size: 'sm', color: UI_THEME.accent }));
  }

  // ── Étape « connexion de l'invité » ──

  private renderJoin(action: (id: LobbyActionId) => LobbyAction | undefined, rows: RowSpec[], fields: DomFieldSpec[], buttons: DomButtonSpec[]): void {
    const s = this.state;
    const cx = GAME_WIDTH / 2;
    const backRow = (y: number): void => {
      rows.push({ id: 'back', kind: 'action', x: 390, y, w: 500, label: t('net.lobby.back'), enabled: true, confirm: () => this.goBack() });
    };
    this.track(createText(this, cx, 72, t('net.lobby.join'), { size: 'md', color: UI_THEME.textDim, origin: [0.5, 0.5], align: 'center' }));

    if (s.join === 'code' && s.transport === 'webrtc') {
      this.track(createText(this, 140, 120, t('net.lobby.join.code'), { size: 'md', color: UI_THEME.text }));
      fields.push({ id: 'joinCode', kind: 'textarea', rect: { x: 140, y: 164, w: 1000, h: 150 }, value: '', placeholder: t('net.lobby.code.placeholder'), label: t('net.lobby.join.code') });
      buttons.push({ id: 'joinPaste', label: t('net.lobby.paste'), rect: { x: 140, y: 334, w: 220, h: 56 }, onClick: () => this.pasteInto('joinCode') });
      buttons.push({ id: 'joinOk', label: t('net.lobby.validate'), rect: { x: 380, y: 334, w: 220, h: 56 }, enabled: action('submitCode')?.enabled === true, onClick: () => void this.submitJoinCode() });
      backRow(520);
      return;
    }
    if (s.join === 'creating') {
      this.track(createText(this, cx, 300, t('net.lobby.join.creating'), { size: 'md', color: UI_THEME.accent, origin: [0.5, 0.5], align: 'center' }));
      backRow(520);
      return;
    }
    if (s.join === 'answer' && s.answerCode) {
      this.track(createText(this, 140, 120, t('net.lobby.join.answer'), { size: 'md', color: UI_THEME.text }));
      fields.push({ id: 'joinAnswer', kind: 'textarea', rect: { x: 140, y: 164, w: 1000, h: 150 }, value: s.answerCode, readOnly: true, label: t('net.lobby.join.answer') });
      buttons.push({ id: 'joinCopy', label: t('net.lobby.copy'), rect: { x: 140, y: 334, w: 220, h: 56 }, onClick: () => this.copyField('joinAnswer') });
      this.track(createText(this, cx, 440, t('net.lobby.join.answerHint'), { size: 'sm', color: UI_THEME.textDim, origin: [0.5, 0.5], align: 'center', wrapWidth: 900 }));
      backRow(520);
      return;
    }
    if (s.join === 'failed') {
      rows.push({ id: 'retry', kind: 'action', x: 390, y: 400, w: 500, label: t('net.lobby.join.retry'), enabled: true, confirm: () => this.retryJoin() });
      backRow(400 + ROW_STEP);
      return;
    }
    // connecting (WebRTC : liaison ouverte, accueil attendu ; BroadcastChannel : recherche de l'hôte)
    this.track(createText(this, cx, 300, t('net.lobby.join.connecting'), { size: 'md', color: UI_THEME.accent, origin: [0.5, 0.5], align: 'center' }));
    backRow(520);
  }

  private retryJoin(): void {
    this.dispatch({ type: 'retry' });
    if (this.state.step === 'join' && this.state.join === 'connecting' && this.state.transport === 'broadcast') this.startBroadcastJoin();
  }

  // ── Étape « salon de l'invité » ──

  private renderGuest(lobby: LobbyState | null, action: (id: LobbyActionId) => LobbyAction | undefined, rows: RowSpec[]): void {
    this.renderPlayers(lobby);
    const slot = this.localSlot();
    const me = lobby ? slotOf(lobby, slot) : undefined;
    const color = playerColor(slot ?? 1);
    let y = 100;
    rows.push({ id: 'info', kind: 'info', x: RIGHT_X, y, w: RIGHT_W, label: t('net.lobby.level'), value: this.levelName(lobby?.levelIndex ?? 0), enabled: true });
    y += ROW_STEP;
    const character = action('character');
    rows.push({
      id: 'character',
      kind: 'choice',
      x: RIGHT_X,
      y,
      w: RIGHT_W,
      label: t('net.lobby.character'),
      value: me ? t(CHARACTERS[me.characterId].nameKey) : '',
      color,
      enabled: character?.enabled === true,
      left: () => this.guestChoose('character', -1),
      right: () => this.guestChoose('character', 1),
    });
    y += ROW_STEP;
    const difficulty = action('difficulty');
    rows.push({
      id: 'difficulty',
      kind: 'choice',
      x: RIGHT_X,
      y,
      w: RIGHT_W,
      label: t('net.lobby.difficulty'),
      value: t(`menu.difficulty.${me?.difficulty ?? 2}`),
      color,
      enabled: difficulty?.enabled === true,
      left: () => this.guestChoose('difficulty', -1),
      right: () => this.guestChoose('difficulty', 1),
    });
    y += ROW_STEP;
    const ready = action('ready');
    rows.push({
      id: 'ready',
      kind: 'choice',
      x: RIGHT_X,
      y,
      w: RIGHT_W,
      label: t('net.lobby.ready'),
      value: me?.ready ? t('net.lobby.yes') : t('net.lobby.no'),
      color,
      enabled: ready?.enabled === true,
      left: () => this.guestChoose('ready', -1),
      right: () => this.guestChoose('ready', 1),
      confirm: () => this.guestChoose('ready', 1),
    });
    y += ROW_STEP;
    if (me?.ready) this.track(createText(this, RIGHT_X + RIGHT_W / 2, y + 6, t('net.lobby.locked'), { size: 'sm', color: UI_THEME.textDim, origin: [0.5, 0], align: 'center', wrapWidth: RIGHT_W }));
    this.track(createText(this, RIGHT_X + BOTTOM_W / 2, 470, t('net.lobby.waitStart'), { size: 'md', color: UI_THEME.accent, origin: [0.5, 0.5], align: 'center', wrapWidth: BOTTOM_W }));
    rows.push({ id: 'back', kind: 'action', x: RIGHT_X, y: 520 + ROW_STEP, w: BOTTOM_W, label: t('net.lobby.leaveRoom'), enabled: true, confirm: () => this.goBack() });
  }

  // ── Liste des joueurs ──

  private renderPlayers(lobby: LobbyState | null): void {
    this.track(createText(this, LEFT_X, 100 - 18, t('net.lobby.players'), { size: 'md', color: UI_THEME.accent, origin: [0, 0.5] }));
    if (!lobby) return;
    const rows = participantRows(lobby, this.localSlot());
    rows.forEach((row, i) => {
      const y = 100 + i * PLAYER_ROW_STEP;
      this.track(createPanel(this, LEFT_X, y, LEFT_W, PLAYER_ROW_H, row.isLocal ? PANEL_STYLES.selected : PANEL_STYLES.default));
      const g = this.track(this.add.graphics());
      g.fillStyle(playerColor(row.slot), 1);
      g.fillRect(LEFT_X + 14, y + PLAYER_ROW_H / 2 - 9, 18, 18);
      const lost = row.status === 'lost';
      const name = this.track(createText(this, LEFT_X + 44, y + PLAYER_ROW_H / 2, '', { size: 'md', color: lost ? UI_THEME.disabled : UI_THEME.text, origin: [0, 0.5] }));
      fit(name, row.name, 190);
      const character = this.track(createText(this, LEFT_X + 246, y + PLAYER_ROW_H / 2, '', { size: 'sm', color: lost ? UI_THEME.disabled : UI_THEME.textDim, origin: [0, 0.5] }));
      fit(character, t(row.characterNameKey), 130);
      if (row.pingMs !== null && !lost) {
        this.track(createText(this, LEFT_X + LEFT_W - 128, y + PLAYER_ROW_H / 2, t('net.lobby.ping', { ms: row.pingMs }), { size: 'sm', color: UI_THEME.textDim, origin: [1, 0.5], align: 'right' }));
      }
      const statusColor = row.status === 'ready' ? UI_THEME.good : lost ? UI_THEME.bad : row.status === 'host' ? UI_THEME.accent : UI_THEME.textDim;
      this.track(createText(this, LEFT_X + LEFT_W - 14, y + PLAYER_ROW_H / 2, t(statusKey(row.status)), { size: 'sm', color: statusColor, origin: [1, 0.5], align: 'right' }));
    });
  }

  private levelName(index: number): string {
    const level = getLevelByIndex(index);
    return levelLabel(index, level ? t(level.nameKey) : null, t('result.level', { n: index + 1 }));
  }

  // ── Lignes sélectionnables ──

  private createRow(spec: RowSpec): RowView {
    const { x, y, w } = spec;
    const h = ROW_H;
    const normal = createPanel(this, 0, 0, w, h, PANEL_STYLES.default);
    const selected = createPanel(this, 0, 0, w, h, PANEL_STYLES.selected);
    const disabled = createPanel(this, 0, 0, w, h, PANEL_STYLES.disabled);
    const isAction = spec.kind === 'action';
    const label = createText(this, isAction ? w / 2 : 20, h / 2, '', {
      size: 'md',
      color: spec.color ?? UI_THEME.text,
      origin: isAction ? [0.5, 0.5] : [0, 0.5],
      align: isAction ? 'center' : 'left',
    });
    fit(label, spec.label, isAction ? w - 40 : 200);
    const children: Phaser.GameObjects.GameObject[] = [normal, selected, disabled, label];
    let value: Phaser.GameObjects.Text | null = null;
    if (spec.kind !== 'action' && spec.value !== undefined) {
      const cx = 20 + 200 + (w - 240) / 2;
      value = createText(this, cx, h / 2, '', { size: 'md', color: UI_THEME.accent, origin: [0.5, 0.5], align: 'center' });
      fit(value, spec.value, w - 300);
      children.push(value);
      if (spec.kind === 'choice') {
        const arrows = this.add.graphics();
        drawArrow(arrows, 20 + 200 + 8, h / 2, 'left', 5, UI_THEME.accent);
        drawArrow(arrows, w - 14, h / 2, 'right', 5, UI_THEME.accent);
        children.push(arrows);
      }
    }
    const container = this.add.container(x, y, children);
    this.objects.push(container);
    if (spec.kind !== 'info') {
      const zone = this.add.zone(0, 0, w, h).setOrigin(0, 0);
      container.add(zone);
      zone.setInteractive({ useHandCursor: spec.enabled });
      zone.on('pointerover', () => {
        if (this.starting) return;
        this.selectedId = spec.id;
        this.applySelection();
      });
      zone.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
        if (this.starting) return;
        this.selectedId = spec.id;
        this.applySelection();
        const row = this.rows.find((r) => r.spec.id === spec.id);
        if (spec.kind === 'action') {
          this.activate(row, 'confirm');
          return;
        }
        if (spec.confirm && pointer.x - x > 20 + 200) {
          this.activate(row, 'confirm');
          return;
        }
        this.activate(row, pointer.x - x < w / 2 + 40 ? 'left' : 'right');
      });
    }
    return { spec, normal, selected, disabled, label, value };
  }

  private applySelection(): void {
    for (const r of this.rows) {
      const on = r.spec.id === this.selectedId && r.spec.kind !== 'info';
      const enabled = r.spec.enabled;
      r.normal.setVisible(enabled && !on);
      r.selected.setVisible(enabled && on);
      r.disabled.setVisible(!enabled);
      r.label.setColor(css(!enabled ? UI_THEME.disabled : (r.spec.color ?? (on ? UI_THEME.accent : UI_THEME.text))));
      r.value?.setColor(css(enabled ? UI_THEME.accent : UI_THEME.disabled));
    }
  }
}

