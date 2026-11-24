/**
 * Session de l'HÔTE (lot A) : salon, partie, instantanés, entrées distantes. Implémente `HostSessionApi` (contrat : `contracts.ts` ; états : docs/NET.md § 6.1).
 *
 * Principes :
 *  - AUCUN timer interne, AUCUNE horloge : la scène appelle `update(nowMs)` à chaque frame (salon et partie) ; tout délai (hello, silence, ping, entrée périmée)
 *    se calcule sur ce `nowMs`. Au PREMIER `update`, tous les horodatages déjà posés sont rebasés sur cette horloge (une horloge `performance.now()` ne
 *    commence pas à 0 : les arrivées antérieures au premier `update` ne doivent pas expirer d'un coup) ;
 *  - l'identité d'un joueur vient du CANAL (chaque invité a son `Transport`), jamais d'un champ du message ;
 *  - tout message entrant passe par `protocol.ts` (validation stricte) ; au-delà de `NET.MAX_MALFORMED` messages invalides, la liaison est fermée ;
 *  - un invité perdu pendant la partie reste dans la simulation (frame vide, `RemoteInputSource.setConnected(false)`) ; en salon il est retiré.
 *
 * Choix d'interprétation à connaître :
 *  - `NetPeerEvent.slot` est l'emplacement de SALON en salon, et l'identifiant de JEU pendant la partie ;
 *  - `n` (instantané) est incrémenté à CHAQUE instantané dû, envoyé ou non : un trou de numérotation côté invité = instantané sauté (canal saturé) ;
 *  - la graine de `startGame` est ramenée à un entier non signé 32 bits ; `NetStartInfo.seed` porte la valeur retenue (commune aux deux rôles) ;
 *  - `pollRemoteInputs()` rend une entrée pour CHAQUE invité de la partie (frame vide pour un invité perdu ou périmé) ; les boutons reçus entre deux appels
 *    sont combinés en OU (deux messages arrivés dans le même tour de boucle ne font pas perdre un appui court).
 */
import { CHARACTER_IDS } from '../core/characters';
import { sanitizeFrame } from '../core/simulation';
import type { ActionFrame, CharacterId, GameState, PlayerId, SimEvent, TickInputs } from '../core/types';
import { emptyFrame } from '../input/mapping';
import type { Unsubscribe } from './NetAdapter';
import { RemoteInputSource } from './RemoteInputSource';
import {
  FRAME_BIT,
  NET,
  NET_PROTOCOL_VERSION,
  compatibilityCheck,
  peerMask,
  sanitizeNetName,
  snapshotDue,
  unpackFrame,
  type Compat,
  type HostPhase,
  type HostSessionApi,
  type HostSessionOptions,
  type LobbyChoice,
  type LobbySlot,
  type LobbyState,
  type MsgHello,
  type NetEndReason,
  type NetPeerEvent,
  type NetPlayer,
  type NetStartInfo,
  type RejectReason,
  type StartCheck,
  type Transport,
} from './contracts';
import {
  appendEvents,
  createDecoder,
  createEncoder,
  defaultPlayerName,
  type MessageDecoder,
  type MessageEncoder,
  type MsgPingEx,
  type ProtocolMessage,
} from './protocol';

/** Délai (ms) entre l'envoi d'un `reject` et la fermeture de la liaison (laisse le temps au message de partir avant la coupure). */
const REJECT_CLOSE_DELAY_MS = 300;
/** Nombre maximal de liaisons simultanées (invités en attente de `hello` compris) : au-delà, la nouvelle liaison est fermée tout de suite. */
const MAX_LINKS = 8;
/** Fenêtre (ms) des limites de cadence. */
const RATE_WINDOW_MS = 1000;
const DEFAULT_DIFFICULTY = 2;

/** Statistiques légères (journal de recette : débit, saturation, aller-retour). */
export interface HostSessionStats {
  snapshotsSent: number;
  /** Instantanés dus mais non envoyés à un invité (canal saturé, trop gros). */
  snapshotsSkipped: number;
  /** Caractères émis en instantanés (somme des textes envoyés). */
  snapshotChars: number;
  /** Messages invalides reçus, tous invités confondus. */
  malformed: number;
  peers: { slot: PlayerId; name: string; connected: boolean; bufferedAmount: number; pingMs: number | null }[];
}

export interface HostSession extends HostSessionApi {
  stats(): HostSessionStats;
}

interface RateWindow {
  startMs: number;
  count: number;
}

interface Peer {
  transport: Transport;
  encoder: MessageEncoder;
  decoder: MessageDecoder;
  unsubs: Unsubscribe[];
  /** `pending` : pas encore de `hello` accepté ; `joined` : au salon / en partie ; `rejecting` : refusé, fermeture programmée ; `gone` : retiré. */
  state: 'pending' | 'joined' | 'rejecting' | 'gone';
  slot: PlayerId;
  name: string;
  choice: LobbyChoice;
  /** false = liaison perdue (en partie, le joueur reste immobile). */
  connected: boolean;
  /** Horodatage de l'ajout (délai du `hello`). */
  sinceMs: number;
  lastRecvMs: number;
  /** Un message est arrivé depuis le dernier `update` : `lastRecvMs` est alors recalé sur l'horloge fraîche (cf. `update`). */
  recvPending: boolean;
  closeAtMs: number | null;
  malformed: number;
  pingMs: number | null;
  /** Identifiant de jeu (0..n-1) pendant la partie. */
  gameId: PlayerId | null;
  source: RemoteInputSource | null;
  lastInputAtMs: number;
  inputSeq: number;
  /** OU des boutons reçus depuis le dernier `pollRemoteInputs`. */
  latchBits: number;
  inputWin: RateWindow;
  choiceWin: RateWindow;
  snapN: number;
  pendingEvents: SimEvent[];
  lastPongN: number;
}

export function createHostSession(options: HostSessionOptions): HostSession {
  const local: Compat = { proto: NET_PROTOCOL_VERSION, build: options.build, levels: options.levelCount };
  const hostName = sanitizeNetName(options.hostName, defaultPlayerName(0));
  const levelCount = Math.max(1, Math.floor(options.levelCount));

  let phase: HostPhase = 'lobby';
  let nowMs = 0;
  let clockStarted = false;
  let lobbySeq = 0;
  let levelIndex = 0;
  let gamesStarted = 0;
  let gameId: number | null = null;
  let hostChoice: LobbyChoice = {
    characterId: options.hostCharacter && CHARACTER_IDS.includes(options.hostCharacter) ? options.hostCharacter : CHARACTER_IDS[0],
    difficulty: DEFAULT_DIFFICULTY,
    ready: false,
  };
  let lastPingAt: number | null = null;
  let pingN = 0;
  let pingDirty = false;

  const peers: Peer[] = [];
  const lobbyCbs = new Set<(lobby: LobbyState) => void>();
  const peerCbs = new Set<(e: NetPeerEvent) => void>();
  const stats = { snapshotsSent: 0, snapshotsSkipped: 0, snapshotChars: 0, malformed: 0 };

  // ───────────── Utilitaires ─────────────

  function safeCall<T>(cbs: Iterable<(arg: T) => void>, arg: T): void {
    for (const cb of Array.from(cbs)) {
      try {
        cb(arg);
      } catch (e) {
        console.error('[net] rappel de session en erreur', e);
      }
    }
  }

  function joinedPeers(): Peer[] {
    return peers.filter((p) => p.state === 'joined');
  }

  function liveJoined(): Peer[] {
    return peers.filter((p) => p.state === 'joined' && p.connected);
  }

  function sendTo(peer: Peer, msg: ProtocolMessage): void {
    if (peer.transport.state !== 'open') return;
    try {
      for (const text of peer.encoder.encode(msg)) peer.transport.send(text);
    } catch {
      // canal fermé ou message trop gros : l'état du transport (`onState`) traitera la perte
    }
  }

  function usedSlots(): Set<number> {
    const s = new Set<number>([0]);
    for (const p of joinedPeers()) s.add(p.slot);
    return s;
  }

  function freeSlot(): PlayerId | null {
    const used = usedSlots();
    for (let s = 1; s < NET.MAX_PLAYERS; s++) if (!used.has(s)) return s as PlayerId;
    return null;
  }

  function firstFreeCharacter(): CharacterId {
    const taken = new Set<CharacterId>([hostChoice.characterId]);
    for (const p of joinedPeers()) taken.add(p.choice.characterId);
    return CHARACTER_IDS.find((c) => !taken.has(c)) ?? CHARACTER_IDS[0];
  }

  function buildSlots(): LobbySlot[] {
    const slots: LobbySlot[] = [{ slot: 0, name: hostName, isHost: true, connected: true, ...hostChoice }];
    for (const p of joinedPeers().sort((a, b) => a.slot - b.slot)) {
      const s: LobbySlot = { slot: p.slot, name: p.name, isHost: false, connected: p.connected, ...p.choice };
      if (p.pingMs !== null) s.pingMs = p.pingMs;
      slots.push(s);
    }
    return slots;
  }

  function currentLobby(): LobbyState {
    return { seq: lobbySeq, slots: buildSlots(), levelIndex, levelCount };
  }

  /** Une nouvelle version du salon : incrémente `seq`, prévient chaque invité (sauf `except`) et les abonnés locaux. */
  function commitLobby(except?: Peer): void {
    lobbySeq++;
    const lobby = currentLobby();
    for (const p of liveJoined()) {
      if (p === except) continue;
      sendTo(p, { t: 'lobby', lobby, you: p.slot });
    }
    safeCall(lobbyCbs, lobby);
  }

  function emitPeer(type: NetPeerEvent['type'], peer: Peer): void {
    safeCall(peerCbs, { type, slot: phase === 'playing' && peer.gameId !== null ? peer.gameId : peer.slot, name: peer.name });
  }

  /** Arbitre un choix : le personnage et la difficulté sont toujours acceptés ; « prêt » est refusé si un AUTRE participant prêt a déjà ce personnage. */
  function arbitrate(slot: PlayerId, requested: LobbyChoice): LobbyChoice {
    let ready = requested.ready;
    if (ready) {
      const others: LobbyChoice[] = [];
      if (slot !== 0) others.push(hostChoice);
      for (const p of joinedPeers()) if (p.slot !== slot) others.push(p.choice);
      if (others.some((o) => o.ready && o.characterId === requested.characterId)) ready = false;
    }
    return { characterId: requested.characterId, difficulty: requested.difficulty, ready };
  }

  function sameChoice(a: LobbyChoice, b: LobbyChoice): boolean {
    return a.characterId === b.characterId && a.difficulty === b.difficulty && a.ready === b.ready;
  }

  function resetReady(): void {
    hostChoice = { ...hostChoice, ready: false };
    for (const p of joinedPeers()) p.choice = { ...p.choice, ready: false };
  }

  function overWindow(w: RateWindow, max: number): boolean {
    if (nowMs - w.startMs >= RATE_WINDOW_MS || nowMs < w.startMs) {
      w.startMs = nowMs;
      w.count = 0;
    }
    w.count++;
    return w.count > max;
  }

  // ───────────── Liaisons ─────────────

  function newPeer(transport: Transport): Peer {
    return {
      transport,
      encoder: createEncoder(transport.maxMessageChars),
      decoder: createDecoder('toHost'),
      unsubs: [],
      state: 'pending',
      slot: 1,
      name: '',
      choice: { characterId: CHARACTER_IDS[0], difficulty: DEFAULT_DIFFICULTY, ready: false },
      connected: true,
      sinceMs: nowMs,
      lastRecvMs: nowMs,
      recvPending: false,
      closeAtMs: null,
      malformed: 0,
      pingMs: null,
      gameId: null,
      source: null,
      lastInputAtMs: nowMs,
      inputSeq: -1,
      latchBits: 0,
      inputWin: { startMs: nowMs, count: 0 },
      choiceWin: { startMs: nowMs, count: 0 },
      snapN: 0,
      pendingEvents: [],
      lastPongN: 0,
    };
  }

  function detach(peer: Peer): void {
    for (const u of peer.unsubs.splice(0)) u();
  }

  /** Retire une liaison jamais admise (pas de `hello`, refus) : aucun événement. */
  function discard(peer: Peer): void {
    if (peer.state === 'gone') return;
    peer.state = 'gone';
    detach(peer);
    const i = peers.indexOf(peer);
    if (i >= 0) peers.splice(i, 1);
    peer.transport.close('discarded');
  }

  /** Un invité admis disparaît (`left` : départ propre ; `lost` : silence, canal fermé, trop de messages invalides). */
  function dropJoined(peer: Peer, type: 'left' | 'lost'): void {
    if (peer.state !== 'joined' || !peer.connected) return;
    detach(peer);
    peer.connected = false;
    peer.source?.setConnected(false);
    peer.latchBits = 0;
    peer.transport.close(type);
    if (phase === 'lobby') {
      peer.state = 'gone';
      const i = peers.indexOf(peer);
      if (i >= 0) peers.splice(i, 1);
      emitPeer(type, peer);
      commitLobby();
    } else {
      emitPeer(type, peer);
    }
  }

  function rejectPeer(peer: Peer, reason: RejectReason): void {
    sendTo(peer, { t: 'reject', ...local, reason });
    peer.state = 'rejecting';
    peer.closeAtMs = nowMs + REJECT_CLOSE_DELAY_MS;
  }

  function countMalformed(peer: Peer): void {
    stats.malformed++;
    peer.malformed++;
    if (peer.state === 'joined' && peer.malformed > NET.MAX_MALFORMED) dropJoined(peer, 'lost');
    else if (peer.state === 'pending') rejectPeer(peer, 'malformed');
  }

  function onText(peer: Peer, text: string): void {
    if (phase === 'closed' || peer.state === 'gone' || peer.state === 'rejecting') return;
    // pas de `lastRecvMs = nowMs` ici : `nowMs` n'avance que dans `update` (boucle de rendu), périmé après une suspension de l'affichage
    peer.recvPending = true;
    const r = peer.decoder.decode(text, nowMs);
    if (r.kind === 'partial') return;
    if (r.kind === 'invalid') {
      countMalformed(peer);
      return;
    }
    handle(peer, r.msg);
  }

  function handle(peer: Peer, msg: ProtocolMessage): void {
    if (peer.state === 'pending') {
      // avant l'admission, seul `hello` est attendu (un `leave` est toléré)
      if (msg.t === 'hello') handleHello(peer, msg);
      else if (msg.t === 'leave') discard(peer);
      else countMalformed(peer);
      return;
    }
    switch (msg.t) {
      case 'hello':
        countMalformed(peer); // double arrivée sur la même liaison
        break;
      case 'choice':
        handleChoice(peer, { characterId: msg.characterId, difficulty: msg.difficulty, ready: msg.ready });
        break;
      case 'input':
        handleInput(peer, msg.gid, msg.seq, msg.x, msg.y, msg.b);
        break;
      case 'pong':
        handlePong(peer, msg.n, msg.ts);
        break;
      case 'leave':
        dropJoined(peer, 'left');
        break;
      default:
        countMalformed(peer); // un type du sens hôte → invité n'arrive jamais ici (le décodeur le refuse déjà)
    }
  }

  function handleHello(peer: Peer, hello: MsgHello): void {
    if (phase === 'closed') return;
    let reason: RejectReason | null = compatibilityCheck(hello, local);
    if (!reason && phase === 'playing') reason = 'started';
    const slot = freeSlot();
    if (!reason && slot === null) reason = 'full';
    if (reason || slot === null) {
      rejectPeer(peer, reason ?? 'full');
      return;
    }
    peer.state = 'joined';
    peer.slot = slot;
    peer.name = sanitizeNetName(hello.name, defaultPlayerName(slot));
    peer.choice = { characterId: firstFreeCharacter(), difficulty: DEFAULT_DIFFICULTY, ready: false };
    peer.connected = true;
    lobbySeq++;
    sendTo(peer, { t: 'welcome', ...local, slot, lobby: currentLobby() });
    // les AUTRES participants reçoivent le même état (même `seq`) ; le nouveau l'a déjà dans `welcome`
    const lobby = currentLobby();
    for (const p of liveJoined()) if (p !== peer) sendTo(p, { t: 'lobby', lobby, you: p.slot });
    emitPeer('joined', peer);
    safeCall(lobbyCbs, lobby);
  }

  function handleChoice(peer: Peer, requested: LobbyChoice): void {
    if (phase !== 'lobby') return;
    if (overWindow(peer.choiceWin, NET.MAX_CHOICE_PER_SEC)) return;
    const next = arbitrate(peer.slot, requested);
    if (sameChoice(next, peer.choice)) return;
    peer.choice = next;
    commitLobby();
  }

  function handleInput(peer: Peer, gid: number, seq: number, x: number, y: number, b: number): void {
    // une entrée d'une partie précédente ou d'avant le lancement n'est pas une erreur : on l'ignore
    if (phase !== 'playing' || gid !== gameId || peer.source === null || !peer.connected) return;
    if (seq <= peer.inputSeq) return;
    if (overWindow(peer.inputWin, NET.MAX_INPUT_PER_SEC)) return;
    const frame = unpackFrame(x, y, b);
    if (!frame) {
      countMalformed(peer);
      return;
    }
    peer.inputSeq = seq;
    peer.lastInputAtMs = nowMs;
    peer.latchBits |= b;
    peer.source.push(sanitizeFrame(frame));
  }

  function handlePong(peer: Peer, n: number, ts: number): void {
    if (n <= peer.lastPongN || n > pingN || ts > nowMs) return;
    peer.lastPongN = n;
    const rtt = Math.round(Math.max(0, Math.min(60000, nowMs - ts)));
    if (peer.pingMs !== rtt) {
      peer.pingMs = rtt;
      pingDirty = true;
    }
  }

  function rebaseClock(now: number): void {
    for (const p of peers) {
      p.sinceMs = now;
      p.lastRecvMs = now;
      p.lastInputAtMs = now;
      p.inputWin.startMs = now;
      p.choiceWin.startMs = now;
      if (p.closeAtMs !== null) p.closeAtMs = now + REJECT_CLOSE_DELAY_MS;
    }
  }

  // ───────────── API ─────────────

  const api: HostSession = {
    role: 'host',
    get phase(): HostPhase {
      return phase;
    },
    transportKind: options.transportKind,

    getLobby: currentLobby,

    onLobby(cb) {
      lobbyCbs.add(cb);
      return () => {
        lobbyCbs.delete(cb);
      };
    },

    onPeerEvent(cb) {
      peerCbs.add(cb);
      return () => {
        peerCbs.delete(cb);
      };
    },

    setLocalChoice(choice: Partial<LobbyChoice>): void {
      if (phase !== 'lobby') return;
      const requested: LobbyChoice = {
        characterId: choice.characterId !== undefined && CHARACTER_IDS.includes(choice.characterId) ? choice.characterId : hostChoice.characterId,
        difficulty: choice.difficulty === 1 || choice.difficulty === 2 || choice.difficulty === 3 ? choice.difficulty : hostChoice.difficulty,
        ready: typeof choice.ready === 'boolean' ? choice.ready : hostChoice.ready,
      };
      const next = arbitrate(0, requested);
      if (sameChoice(next, hostChoice)) return;
      hostChoice = next;
      commitLobby();
    },

    setLevel(index: number): void {
      if (phase !== 'lobby' || !Number.isInteger(index) || index < 0 || index >= levelCount || index === levelIndex) return;
      levelIndex = index;
      resetReady();
      commitLobby();
    },

    addGuest(transport: Transport): void {
      if (phase === 'closed' || transport.state === 'closed' || peers.length >= MAX_LINKS) {
        transport.close(phase === 'closed' ? 'hostClosed' : 'refused');
        return;
      }
      const peer = newPeer(transport);
      peers.push(peer);
      peer.unsubs.push(transport.onMessage((text) => onText(peer, text)));
      peer.unsubs.push(
        transport.onState((state) => {
          if (state !== 'closed' || peer.state === 'gone') return;
          if (peer.state === 'joined') dropJoined(peer, 'lost');
          else discard(peer);
        }),
      );
    },

    checkStart(): StartCheck {
      const live = liveJoined();
      if (1 + live.length < NET.MIN_PLAYERS) return { ok: false, reason: 'needTwo' };
      if (!hostChoice.ready || live.some((p) => !p.choice.ready)) return { ok: false, reason: 'notReady' };
      return { ok: true };
    },

    startGame(seed: number): NetStartInfo | null {
      if (phase !== 'lobby' || !api.checkStart().ok) return null;
      const normSeed = Number.isFinite(seed) ? Math.trunc(seed) >>> 0 : 0;
      const gid = (Math.imul(normSeed ^ 0x5bd1e995, 0x9e3779b1) + gamesStarted) >>> 0;
      gamesStarted++;
      const guests = liveJoined().sort((a, b) => a.slot - b.slot);
      const players: NetPlayer[] = [{ id: 0, characterId: hostChoice.characterId, difficulty: hostChoice.difficulty, name: hostName }];
      guests.forEach((p, i) => {
        const id = (i + 1) as PlayerId;
        p.gameId = id;
        players.push({ id, characterId: p.choice.characterId, difficulty: p.choice.difficulty, name: p.name });
      });
      gameId = gid;
      phase = 'playing';
      for (const p of guests) {
        p.source = new RemoteInputSource(p.gameId as PlayerId);
        p.lastInputAtMs = nowMs;
        p.inputSeq = -1;
        p.latchBits = 0;
        p.snapN = 0;
        p.pendingEvents = [];
        sendTo(p, { t: 'start', gid, you: p.gameId as PlayerId, levelIndex, seed: normSeed, players });
      }
      return { gameId: gid, localPlayerId: 0, levelIndex, seed: normSeed, players };
    },

    pollRemoteInputs(): TickInputs {
      const out: TickInputs = {};
      if (phase !== 'playing') return out;
      for (const p of joinedPeers()) {
        if (p.gameId === null || p.source === null) continue;
        let frame: ActionFrame;
        if (!p.connected || nowMs - p.lastInputAtMs > NET.INPUT_STALE_MS) {
          // invité perdu, ou plus de nouvelle depuis trop longtemps : jamais d'attaque « collée »
          p.source.reset();
          p.latchBits = 0;
          frame = emptyFrame();
        } else {
          frame = p.source.poll();
          // boutons reçus depuis le dernier appel (OU) : un appui court n'est jamais perdu
          const bits = p.latchBits;
          if (bits & FRAME_BIT.attack) frame.attack = true;
          if (bits & FRAME_BIT.interact) frame.interact = true;
          if (bits & FRAME_BIT.revive) frame.revive = true;
          if (bits & FRAME_BIT.special) frame.special = true;
          if (bits & FRAME_BIT.call) frame.call = true;
          if (bits & FRAME_BIT.heart) frame.heart = true;
          p.latchBits = 0;
        }
        out[p.gameId] = sanitizeFrame(frame);
      }
      return out;
    },

    afterStep(state: GameState, events: readonly SimEvent[]): void {
      if (phase !== 'playing' || gameId === null) return;
      const live = liveJoined();
      if (events.length > 0) for (const p of live) appendEvents(p.pendingEvents, events);
      if (!snapshotDue(state.tick) || live.length === 0) return;

      const pc = api.connectedMask();
      const stJson = JSON.stringify(state);
      for (const p of live) {
        p.snapN++;
        if (p.transport.bufferedAmount > NET.BUFFERED_HIGH_WATER) {
          stats.snapshotsSkipped++; // canal saturé : on ne grossit pas la file ; les événements restent en attente
          continue;
        }
        const json = `{"t":"snap","gid":${gameId},"n":${p.snapN},"tick":${state.tick},"pc":${pc},"st":${stJson},"ev":${JSON.stringify(p.pendingEvents)}}`;
        let texts: string[];
        try {
          texts = p.encoder.encodeJson(json);
        } catch {
          stats.snapshotsSkipped++; // trop gros pour le protocole : on le saute
          continue;
        }
        if (p.transport.state !== 'open') continue;
        try {
          for (const t of texts) {
            p.transport.send(t);
            stats.snapshotChars += t.length;
          }
        } catch {
          stats.snapshotsSkipped++;
          continue;
        }
        stats.snapshotsSent++;
        p.pendingEvents = [];
      }
    },

    endGame(reason: NetEndReason): void {
      if (phase !== 'playing' || gameId === null) return;
      const gid = gameId;
      for (const p of liveJoined()) sendTo(p, { t: 'end', gid, reason });
      phase = 'lobby';
      gameId = null;
      for (const p of peers.slice()) {
        if (p.state === 'joined' && !p.connected) {
          p.state = 'gone';
          peers.splice(peers.indexOf(p), 1);
        }
        p.gameId = null;
        p.source = null;
        p.pendingEvents = [];
        p.latchBits = 0;
      }
      resetReady();
      if (reason === 'levelCompleted') levelIndex = Math.min(levelIndex + 1, levelCount - 1);
      commitLobby();
    },

    connectedMask(): number {
      if (phase === 'playing') {
        const ids: number[] = [0];
        for (const p of joinedPeers()) if (p.connected && p.gameId !== null) ids.push(p.gameId);
        return peerMask(ids);
      }
      return peerMask([0, ...liveJoined().map((p) => p.slot)]);
    },

    update(now: number): void {
      if (phase === 'closed' || !Number.isFinite(now)) return;
      if (!clockStarted) {
        clockStarted = true;
        rebaseClock(now);
      }
      nowMs = now;
      for (const p of peers.slice()) {
        if (p.state === 'gone') continue;
        if (p.recvPending) {
          // le silence se mesure à la granularité des `update` : un message reçu pendant une suspension de l'affichage compte comme reçu MAINTENANT
          p.lastRecvMs = now;
          p.recvPending = false;
        }
        if (p.state === 'rejecting') {
          if (p.closeAtMs !== null && now >= p.closeAtMs) discard(p);
          continue;
        }
        p.decoder.expire(now);
        if (p.state === 'pending') {
          if (now - p.sinceMs > NET.HELLO_TIMEOUT_MS) discard(p);
        } else if (p.connected && now - p.lastRecvMs > NET.PEER_TIMEOUT_MS) {
          dropJoined(p, 'lost');
        }
      }
      if (lastPingAt === null || now - lastPingAt >= NET.PING_INTERVAL_MS) {
        lastPingAt = now;
        if (phase === 'lobby' && pingDirty) {
          pingDirty = false;
          commitLobby(); // les `pingMs` mesurés partent avec le salon (au plus une fois par période)
        }
        pingN++;
        for (const p of liveJoined()) {
          const ping: MsgPingEx = { t: 'ping', n: pingN, ts: now };
          if (p.pingMs !== null) ping.r = p.pingMs;
          sendTo(p, ping);
        }
      }
    },

    close(): void {
      if (phase === 'closed') return;
      phase = 'closed';
      for (const p of peers.splice(0)) {
        const wasJoined = p.state === 'joined' && p.connected;
        p.state = 'gone';
        detach(p);
        if (wasJoined) sendTo(p, { t: 'leave' });
        p.transport.close('hostClosed');
      }
      lobbyCbs.clear();
      peerCbs.clear();
    },

    stats(): HostSessionStats {
      return {
        ...stats,
        peers: joinedPeers().map((p) => ({
          slot: p.slot,
          name: p.name,
          connected: p.connected,
          bufferedAmount: p.transport.bufferedAmount,
          pingMs: p.pingMs,
        })),
      };
    },
  };
  return api;
}

