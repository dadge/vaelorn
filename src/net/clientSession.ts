/**
 * Session d'un INVITÉ (lot A) : rejoint un hôte, suit le salon, envoie ses entrées, reçoit les instantanés. Implémente `ClientSessionApi`
 * (contrat : `contracts.ts` ; états : docs/NET.md § 6.2).
 *
 * Mêmes conventions de temps que l'hôte : AUCUN timer interne ; la scène appelle `update(nowMs)` à chaque frame (et `sendInput(frame, nowMs)`), tout délai
 * (réponse à `hello`, silence de l'hôte, cadence des entrées) se calcule sur cet `nowMs`. Au premier appel, les horodatages sont rebasés sur l'horloge de l'appelant.
 *
 * Points d'interprétation :
 *  - `hello` part dès que le transport est `open` (tout de suite s'il l'est déjà) ;
 *  - `onClosed` appelé APRÈS la fermeture (abonnement tardif) est rappelé tout de suite : une notification ne se perd jamais ;
 *  - `rttMs()` : l'invité ne peut pas mesurer seul un aller-retour avec un `ping` à sens unique ; l'hôte joint donc sa dernière mesure à chaque `ping`
 *    (champ facultatif `r`, voir `MsgPingEx`) ; avant la première, on retombe sur le `pingMs` de son emplacement dans le salon ;
 *  - `intervalMs` d'un instantané = moyenne mobile (8 derniers) des intervalles d'ARRIVÉE, chacun borné à `INTERP_MAX_MS` (une salve après un blocage
 *    ne fausse pas la moyenne), les intervalles nuls (même tour de boucle) étant ignorés ; le résultat est borné à [`INTERP_MIN_MS`, `INTERP_MAX_MS`].
 */
import type { ActionFrame, PlayerId, SimEvent } from '../core/types';
import type { Unsubscribe } from './NetAdapter';
import {
  NET,
  NET_PROTOCOL_VERSION,
  compatibilityCheck,
  packFrame,
  sanitizeNetName,
  type ClientPhase,
  type ClientSessionApi,
  type ClientSessionOptions,
  type Compat,
  type LobbyChoice,
  type LobbyState,
  type NetClosedInfo,
  type NetEndReason,
  type NetSnapshot,
  type NetStartInfo,
  type Transport,
} from './contracts';
import {
  appendEvents,
  createDecoder,
  createEncoder,
  type MessageDecoder,
  type MessageEncoder,
  type MsgPingEx,
  type ProtocolMessage,
} from './protocol';

/** Nombre d'intervalles d'arrivée retenus pour estimer `intervalMs`. */
const INTERVAL_SAMPLES = 8;

export interface ClientSessionStats {
  snapshotsReceived: number;
  /** Instantanés ignorés (plus anciens que le dernier appliqué, d'une autre partie). */
  snapshotsIgnored: number;
  malformed: number;
  intervalMs: number;
  rttMs: number | null;
}

export interface ClientSession extends ClientSessionApi {
  stats(): ClientSessionStats;
}

export function createClientSession(transport: Transport, options: ClientSessionOptions): ClientSession {
  const local: Compat = { proto: NET_PROTOCOL_VERSION, build: options.build, levels: options.levelCount };
  const encoder: MessageEncoder = createEncoder(transport.maxMessageChars);
  const decoder: MessageDecoder = createDecoder('toGuest');

  let phase: ClientPhase = 'connecting';
  let slot: PlayerId | null = null;
  let gameId: number | null = null;
  let lobby: LobbyState | null = null;
  let closedInfo: NetClosedInfo | null = null;
  let malformed = 0;

  let nowMs = 0;
  let clockStarted = false;
  let handshakeSinceMs = 0;
  let lastRecvMs = 0;
  /** Un message est arrivé depuis le dernier `update` : `lastRecvMs` est alors recalé sur l'horloge fraîche (cf. `update`). */
  let recvPending = false;

  // partie
  let lastN = -1;
  let lastTick = -1;
  let latest: { n: number; tick: number; pc: number; st: NetSnapshot['state'] } | null = null;
  let fresh = false;
  let pendingEvents: SimEvent[] = [];
  let receivedAtMs = 0;
  let prevArrivalMs: number | null = null;
  let intervalSamples: number[] = [];
  let intervalMs: number = NET.SNAPSHOT_INTERVAL_MS;
  let received = 0;
  let ignored = 0;
  let rtt: number | null = null;

  // entrées
  let inputSeq = 0;
  let lastSentAt: number | null = null;
  let latchBits = 0;
  let lastX = 0;
  let lastY = 0;

  const lobbyCbs = new Set<(lobby: LobbyState) => void>();
  const startCbs = new Set<(start: NetStartInfo) => void>();
  const endCbs = new Set<(reason: NetEndReason) => void>();
  const closedCbs = new Set<(info: NetClosedInfo) => void>();
  const unsubs: Unsubscribe[] = [];

  function safeCall<T>(cbs: Iterable<(arg: T) => void>, arg: T): void {
    for (const cb of Array.from(cbs)) {
      try {
        cb(arg);
      } catch (e) {
        console.error('[net] rappel de session en erreur', e);
      }
    }
  }

  function send(msg: ProtocolMessage): void {
    if (transport.state !== 'open') return;
    try {
      for (const text of encoder.encode(msg)) transport.send(text);
    } catch {
      // canal fermé : `onState` le traitera
    }
  }

  function closeWith(info: NetClosedInfo): void {
    if (phase === 'closed') return;
    phase = 'closed';
    closedInfo = info;
    for (const u of unsubs.splice(0)) u();
    transport.close(info.reason);
    latest = null;
    fresh = false;
    pendingEvents = [];
    safeCall(closedCbs, info);
    lobbyCbs.clear();
    startCbs.clear();
    endCbs.clear();
    closedCbs.clear();
  }

  function sendHello(): void {
    if (phase !== 'connecting') return;
    phase = 'handshaking';
    handshakeSinceMs = nowMs;
    send({ t: 'hello', ...local, name: sanitizeNetName(options.name, '') });
  }

  function observeClock(now: number): void {
    if (!Number.isFinite(now)) return;
    if (!clockStarted) {
      clockStarted = true;
      nowMs = now;
      handshakeSinceMs = now;
      lastRecvMs = now;
      return;
    }
    if (now > nowMs) nowMs = now;
  }

  function countMalformed(): void {
    malformed++;
    if (malformed > NET.MAX_MALFORMED) closeWith({ reason: 'protocolError' });
  }

  function pushIntervalSample(arrivalMs: number): void {
    if (prevArrivalMs !== null) {
      const dt = arrivalMs - prevArrivalMs;
      if (dt > 0) {
        intervalSamples.push(Math.min(dt, NET.INTERP_MAX_MS));
        if (intervalSamples.length > INTERVAL_SAMPLES) intervalSamples.shift();
        const mean = intervalSamples.reduce((a, b) => a + b, 0) / intervalSamples.length;
        intervalMs = Math.max(NET.INTERP_MIN_MS, Math.min(NET.INTERP_MAX_MS, mean));
      }
    }
    prevArrivalMs = arrivalMs;
  }

  function applyLobby(l: LobbyState, you: PlayerId): void {
    if (lobby && l.seq <= lobby.seq) return;
    lobby = l;
    if (phase === 'lobby') slot = you;
    safeCall(lobbyCbs, l);
  }

  function onText(text: string): void {
    if (phase === 'closed') return;
    // pas de `lastRecvMs = nowMs` ici : `nowMs` n'avance que dans `update` (boucle de rendu), périmé après une suspension de l'affichage
    recvPending = true;
    const r = decoder.decode(text, nowMs);
    if (r.kind === 'partial') return;
    if (r.kind === 'invalid') {
      countMalformed();
      return;
    }
    handle(r.msg);
  }

  function handle(msg: ProtocolMessage): void {
    switch (msg.t) {
      case 'welcome':
        if (phase !== 'handshaking') return countMalformed();
        {
          // vérification bilatérale (décision 5) : l'invité refuse aussi un hôte de version différente, même si l'hôte a omis le contrôle
          const why = compatibilityCheck(msg, local);
          if (why !== null) {
            closeWith({ reason: 'rejected', reject: { reason: why, hostProto: msg.proto, hostBuild: msg.build, hostLevels: msg.levels } });
            return;
          }
        }
        phase = 'lobby';
        slot = msg.slot;
        lobby = msg.lobby;
        safeCall(lobbyCbs, msg.lobby);
        return;
      case 'reject':
        if (phase !== 'handshaking') return countMalformed();
        closeWith({ reason: 'rejected', reject: { reason: msg.reason, hostProto: msg.proto, hostBuild: msg.build, hostLevels: msg.levels } });
        return;
      case 'lobby':
        if (phase !== 'lobby' && phase !== 'playing') return countMalformed();
        applyLobby(msg.lobby, msg.you);
        return;
      case 'start': {
        if (phase !== 'lobby' || msg.levelIndex >= options.levelCount) return countMalformed();
        phase = 'playing';
        gameId = msg.gid;
        slot = msg.you;
        lastN = -1;
        lastTick = -1;
        latest = null;
        fresh = false;
        pendingEvents = [];
        prevArrivalMs = null;
        intervalSamples = [];
        intervalMs = NET.SNAPSHOT_INTERVAL_MS;
        inputSeq = 0;
        lastSentAt = null;
        latchBits = 0;
        safeCall(startCbs, { gameId: msg.gid, localPlayerId: msg.you, levelIndex: msg.levelIndex, seed: msg.seed, players: msg.players });
        return;
      }
      case 'snap': {
        if (phase === 'lobby') return; // retardataire d'une partie déjà terminée
        if (phase !== 'playing') return countMalformed();
        if (msg.gid !== gameId || msg.n <= lastN || msg.tick < lastTick) {
          ignored++;
          return;
        }
        lastN = msg.n;
        lastTick = msg.tick;
        pushIntervalSample(nowMs);
        latest = { n: msg.n, tick: msg.tick, pc: msg.pc, st: msg.st };
        fresh = true;
        receivedAtMs = nowMs;
        received++;
        appendEvents(pendingEvents, msg.ev);
        return;
      }
      case 'end': {
        if (phase !== 'playing' || msg.gid !== gameId) return;
        phase = 'lobby';
        gameId = null;
        latest = null;
        fresh = false;
        pendingEvents = [];
        safeCall(endCbs, msg.reason);
        return;
      }
      case 'ping': {
        const ping = msg as MsgPingEx;
        if (ping.r !== undefined) rtt = ping.r;
        send({ t: 'pong', n: ping.n, ts: ping.ts });
        return;
      }
      case 'leave':
        closeWith({ reason: 'hostLeft' });
        return;
      default:
        // `hello`, `choice`, `input`, `pong` ne vont pas dans ce sens (le décodeur les refuse déjà)
        countMalformed();
    }
  }

  // ───────────── Branchement au transport ─────────────

  unsubs.push(transport.onMessage(onText));
  unsubs.push(
    transport.onState((state) => {
      if (state === 'open') sendHello();
      else if (state === 'closed') closeWith({ reason: 'transportFailed' });
    }),
  );
  if (transport.state === 'open') sendHello();
  else if (transport.state === 'closed') closeWith({ reason: 'transportFailed' });

  // ───────────── API ─────────────

  const api: ClientSession = {
    role: 'client',
    get phase(): ClientPhase {
      return phase;
    },
    get slot(): PlayerId | null {
      return slot;
    },
    get gameId(): number | null {
      return gameId;
    },
    transportKind: transport.kind,

    getLobby: () => lobby,

    onLobby(cb) {
      lobbyCbs.add(cb);
      return () => {
        lobbyCbs.delete(cb);
      };
    },

    onStart(cb) {
      startCbs.add(cb);
      return () => {
        startCbs.delete(cb);
      };
    },

    onEnd(cb) {
      endCbs.add(cb);
      return () => {
        endCbs.delete(cb);
      };
    },

    onClosed(cb) {
      if (closedInfo) {
        safeCall([cb], closedInfo); // déjà fermée : on rappelle tout de suite (une notification ne se perd pas)
        return () => undefined;
      }
      closedCbs.add(cb);
      return () => {
        closedCbs.delete(cb);
      };
    },

    sendChoice(choice: LobbyChoice): void {
      if (phase !== 'lobby') return;
      send({ t: 'choice', characterId: choice.characterId, difficulty: choice.difficulty, ready: choice.ready });
    },

    sendInput(frame: ActionFrame, now: number): void {
      observeClock(now);
      if (phase !== 'playing' || gameId === null || !Number.isFinite(now)) return;
      const packed = packFrame(frame);
      latchBits |= packed.b;
      lastX = packed.x;
      lastY = packed.y;
      // jamais plus d'un message par `INPUT_SEND_MS` (≥ un pas simulé) ; les appuis courts sont combinés (OU) entre deux envois
      if (lastSentAt !== null && now >= lastSentAt && now - lastSentAt < NET.INPUT_SEND_MS) return;
      lastSentAt = now;
      send({ t: 'input', gid: gameId, seq: ++inputSeq, x: lastX, y: lastY, b: latchBits });
      latchBits = 0;
    },

    takeSnapshot(): NetSnapshot | null {
      if (!fresh || !latest) return null;
      const snap: NetSnapshot = {
        n: latest.n,
        tick: latest.tick,
        connectedMask: latest.pc,
        state: latest.st,
        events: pendingEvents,
        receivedAtMs,
        intervalMs,
      };
      pendingEvents = [];
      fresh = false;
      return snap;
    },

    rttMs(): number | null {
      if (rtt !== null) return rtt;
      const mine = lobby?.slots.find((s) => s.slot === slot);
      return mine?.pingMs ?? null;
    },

    update(now: number): void {
      if (phase === 'closed') return;
      observeClock(now);
      if (recvPending) {
        // le silence se mesure à la granularité des `update` : un message reçu pendant une suspension de l'affichage compte comme reçu MAINTENANT
        lastRecvMs = nowMs;
        recvPending = false;
      }
      decoder.expire(nowMs);
      if (phase === 'handshaking') {
        if (nowMs - handshakeSinceMs > NET.HELLO_TIMEOUT_MS) closeWith({ reason: 'hostLost' });
      } else if (phase === 'lobby' || phase === 'playing') {
        if (nowMs - lastRecvMs > NET.PEER_TIMEOUT_MS) closeWith({ reason: 'hostLost' });
      }
    },

    leave(): void {
      if (phase === 'closed') return;
      if (phase !== 'connecting') send({ t: 'leave' });
      closeWith({ reason: 'userLeft' });
    },

    stats(): ClientSessionStats {
      return { snapshotsReceived: received, snapshotsIgnored: ignored, malformed, intervalMs, rttMs: api.rttMs() };
    },
  };
  return api;
}
