/**
 * Tests de la session INVITÉ face à un « faux hôte » qui écrit les messages à la main : prise de contact (hello, welcome, reject, délai),
 * salon (seq), lancement, envoi des entrées (cadence, OU des appuis, numéros), instantanés (le plus récent + tous les événements, ordre, intervalle),
 * ping / aller-retour, silence de l'hôte, départ, fin de partie, messages invalides.
 */
import { describe, expect, it } from 'vitest';
import type { GameState, SimEvent } from '../core/types';
import { emptyFrame } from '../input/mapping';
import { createClientSession, type ClientSession } from './clientSession';
import {
  FRAME_BIT,
  NET,
  NET_PROTOCOL_VERSION,
  noticeForClose,
  type ClientSessionOptions,
  type LobbyState,
  type NetClosedInfo,
  type Transport,
  type TransportState,
} from './contracts';
import { TEST_BUILD, TEST_LEVEL_COUNT, createFakeClock, type FakeClock } from './netTestKit';
import { createDecoder, createEncoder, type ProtocolMessage } from './protocol';
import { createLoopbackPair, type LoopbackPairEx } from './transportLoopback';

interface FakeHost {
  pair: LoopbackPairEx;
  client: ClientSession;
  clock: FakeClock;
  /** Messages reçus par l'hôte (décodés). */
  inbox: ProtocolMessage[];
  send(obj: unknown): void;
  sendText(text: string): void;
  /** Livre dans les deux sens (jusqu'à stabilité). */
  deliver(): void;
  closed: NetClosedInfo[];
}

function lobbyState(seq: number, over: Partial<LobbyState> = {}): LobbyState {
  return {
    seq,
    levelIndex: 0,
    levelCount: TEST_LEVEL_COUNT,
    slots: [
      { slot: 0, name: 'Hôte', isHost: true, connected: true, characterId: 'david', difficulty: 2, ready: false },
      { slot: 1, name: 'Moi', isHost: false, connected: true, characterId: 'sandrine', difficulty: 2, ready: false },
    ],
    ...over,
  };
}

const WELCOME = { t: 'welcome', proto: NET_PROTOCOL_VERSION, build: TEST_BUILD, levels: TEST_LEVEL_COUNT, slot: 1 };

function start(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    t: 'start',
    gid: 4242,
    you: 1,
    levelIndex: 0,
    seed: 99,
    players: [
      { id: 0, characterId: 'david', difficulty: 2, name: 'Hôte' },
      { id: 1, characterId: 'sandrine', difficulty: 2, name: 'Moi' },
    ],
    ...over,
  };
}

function snap(n: number, tick: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { t: 'snap', gid: 4242, n, tick, pc: 3, st: fakeState(tick), ev: [], ...over };
}

function fakeState(tick: number): GameState {
  return { version: 1, levelId: 'test', tick, timeMs: tick * 16.6, players: [] } as unknown as GameState;
}

const ev = (type: string, id = 0): SimEvent => ({ type, id }) as unknown as SimEvent;

function makeFakeHost(opts: Partial<ClientSessionOptions> = {}, limit?: number): FakeHost {
  const pair = createLoopbackPair();
  const clock = createFakeClock();
  const inbox: ProtocolMessage[] = [];
  const dec = createDecoder('toHost');
  pair.a.onMessage((t) => {
    const r = dec.decode(t, clock.now());
    if (r.kind === 'message') inbox.push(r.msg);
  });
  const enc = createEncoder(limit ?? pair.a.maxMessageChars);
  const client = createClientSession(pair.b, { name: 'Moi', build: TEST_BUILD, levelCount: TEST_LEVEL_COUNT, ...opts });
  const closed: NetClosedInfo[] = [];
  client.onClosed((i) => closed.push(i));
  const host: FakeHost = {
    pair,
    client,
    clock,
    inbox,
    closed,
    send: (obj) => {
      for (const t of enc.encode(obj as ProtocolMessage)) pair.a.send(t);
    },
    sendText: (text) => pair.a.send(text),
    deliver: () => {
      for (let i = 0; i < 10; i++) if (pair.flush() === 0) break;
    },
  };
  return host;
}

/** Faux hôte déjà « welcome » (client au salon). */
function lobbyHost(opts: Partial<ClientSessionOptions> = {}): FakeHost {
  const h = makeFakeHost(opts);
  h.client.update(h.clock.now());
  h.deliver();
  h.send({ ...WELCOME, levels: opts.levelCount ?? TEST_LEVEL_COUNT, lobby: lobbyState(1) }); // l'hôte annonce le même nombre de niveaux que l'invité
  h.deliver();
  return h;
}

/** Faux hôte, partie lancée (client en jeu, joueur 1, gid 4242). */
function playingHost(opts: Partial<ClientSessionOptions> = {}): FakeHost {
  const h = lobbyHost(opts);
  h.send(start());
  h.deliver();
  return h;
}

/** Transport à état piloté à la main (WebRTC : « connecting » jusqu'au collage de la réponse). */
class ManualTransport implements Transport {
  readonly kind = 'webrtc' as const;
  readonly bufferedAmount = 0;
  readonly maxMessageChars = 15000;
  state: TransportState = 'connecting';
  sent: string[] = [];
  private stateCbs: ((s: TransportState, r?: string) => void)[] = [];
  send(text: string): void {
    if (this.state !== 'open') throw new Error('fermé');
    this.sent.push(text);
  }
  onMessage(): () => void {
    return () => undefined;
  }
  onState(cb: (s: TransportState, r?: string) => void): () => void {
    this.stateCbs.push(cb);
    return () => undefined;
  }
  close(): void {
    this.set('closed');
  }
  set(state: TransportState): void {
    this.state = state;
    for (const cb of this.stateCbs) cb(state);
  }
}

describe('invité : prise de contact', () => {
  it('hello part dès l\'ouverture du transport, avec la version, le build, le nombre de niveaux et le nom assaini', () => {
    const h = makeFakeHost({ name: '  Zoé <b> ' });
    expect(h.client.phase).toBe('handshaking');
    h.deliver();
    expect(h.inbox).toEqual([{ t: 'hello', proto: NET_PROTOCOL_VERSION, build: TEST_BUILD, levels: TEST_LEVEL_COUNT, name: 'Zoé b' }]);
  });

  it('transport pas encore ouvert (WebRTC) : connecting ; hello seulement à l\'ouverture', () => {
    const t = new ManualTransport();
    const c = createClientSession(t, { name: 'A', build: TEST_BUILD, levelCount: TEST_LEVEL_COUNT });
    expect(c.phase).toBe('connecting');
    expect(c.transportKind).toBe('webrtc');
    expect(t.sent).toEqual([]);
    // pas de délai de silence tant que la liaison n'est pas ouverte (copie du code : l'utilisateur prend son temps)
    c.update(0);
    c.update(10 * 60_000);
    expect(c.phase).toBe('connecting');
    t.set('open');
    expect(c.phase).toBe('handshaking');
    expect(t.sent).toHaveLength(1);
    expect(JSON.parse(t.sent[0])).toMatchObject({ t: 'hello', proto: NET_PROTOCOL_VERSION });
  });

  it('un transport fermé avant l\'ouverture : closed (transportFailed), notifié même à un abonné tardif', () => {
    const t = new ManualTransport();
    const c = createClientSession(t, { name: 'A', build: TEST_BUILD, levelCount: TEST_LEVEL_COUNT });
    t.set('closed');
    expect(c.phase).toBe('closed');
    const got: NetClosedInfo[] = [];
    c.onClosed((i) => got.push(i)); // abonnement APRÈS la fermeture : rappelé tout de suite
    expect(got).toEqual([{ reason: 'transportFailed' }]);
    // déjà fermé à la création
    const dead = new ManualTransport();
    dead.state = 'closed';
    const c2 = createClientSession(dead, { name: 'A', build: TEST_BUILD, levelCount: TEST_LEVEL_COUNT });
    expect(c2.phase).toBe('closed');
  });

  it('welcome : au salon, emplacement et salon mémorisés, abonnés prévenus', () => {
    const h = makeFakeHost();
    const seen: LobbyState[] = [];
    h.client.onLobby((l) => seen.push(l));
    h.deliver();
    expect(h.client.getLobby()).toBeNull();
    expect(h.client.slot).toBeNull();
    h.send({ ...WELCOME, slot: 2, lobby: lobbyState(5) });
    h.deliver();
    expect(h.client.phase).toBe('lobby');
    expect(h.client.slot).toBe(2);
    expect(h.client.getLobby()?.seq).toBe(5);
    expect(seen).toHaveLength(1);
    expect(h.client.gameId).toBeNull();
  });

  it('welcome d\'un hôte de build / niveaux / protocole différents : l\'invité refuse lui-même (vérification bilatérale)', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ build: { version: '0.2.0', commit: 'fff0000', date: '2026-12-01' } }, 'build'],
      [{ levels: TEST_LEVEL_COUNT + 3 }, 'levels'],
      [{ proto: NET_PROTOCOL_VERSION + 1 }, 'protocol'],
    ];
    for (const [over, reason] of cases) {
      const h = makeFakeHost();
      h.deliver();
      h.send({ ...WELCOME, ...over, lobby: lobbyState(1) });
      h.deliver();
      expect(h.client.phase).toBe('closed');
      expect(h.closed).toHaveLength(1);
      expect(h.closed[0]).toMatchObject({ reason: 'rejected', reject: { reason } });
      expect(noticeForClose(h.closed[0])).toEqual({ code: `reject.${reason}` });
      expect(h.client.getLobby()).toBeNull();
    }
  });

  it('reject : fermeture avec les données de l\'hôte, message traduisible, une seule notification', () => {
    const h = makeFakeHost();
    h.deliver();
    h.send({ t: 'reject', proto: NET_PROTOCOL_VERSION, build: { version: '0.2.0', commit: 'fff0000', date: '2026-12-01' }, levels: 12, reason: 'build' });
    h.pair.a.close(); // l'hôte ferme ensuite le canal
    h.deliver();
    expect(h.client.phase).toBe('closed');
    expect(h.closed).toEqual([
      { reason: 'rejected', reject: { reason: 'build', hostProto: NET_PROTOCOL_VERSION, hostBuild: { version: '0.2.0', commit: 'fff0000', date: '2026-12-01' }, hostLevels: 12 } },
    ]);
    expect(noticeForClose(h.closed[0])).toEqual({ code: 'reject.build' });
    expect(h.pair.b.state).toBe('closed');
  });

  it('reject d\'un autre protocole (forme différente) : lu avec indulgence', () => {
    const h = makeFakeHost();
    h.deliver();
    h.send({ t: 'reject', proto: NET_PROTOCOL_VERSION + 1, reason: 'protocol', inconnu: true });
    h.deliver();
    expect(h.closed[0]).toMatchObject({ reason: 'rejected', reject: { reason: 'protocol', hostProto: NET_PROTOCOL_VERSION + 1 } });
  });

  it('pas de réponse à hello dans HELLO_TIMEOUT_MS : hôte perdu', () => {
    const h = makeFakeHost();
    h.client.update(0);
    h.client.update(NET.HELLO_TIMEOUT_MS);
    expect(h.client.phase).toBe('handshaking');
    h.client.update(NET.HELLO_TIMEOUT_MS + 1);
    expect(h.client.phase).toBe('closed');
    expect(h.closed).toEqual([{ reason: 'hostLost' }]);
  });

  it('un hôte qui répond à temps n\'est pas déclaré perdu ; horloge qui démarre très haut : rien n\'expire', () => {
    const h = makeFakeHost();
    h.client.update(5_000_000);
    h.deliver();
    h.send({ ...WELCOME, lobby: lobbyState(1) });
    h.deliver();
    h.client.update(5_000_000 + 1000);
    expect(h.client.phase).toBe('lobby');
  });

  it('un message avant le welcome qui n\'est pas welcome / reject est compté comme invalide', () => {
    const h = makeFakeHost();
    h.deliver();
    h.send({ t: 'lobby', lobby: lobbyState(1), you: 1 });
    h.send(snap(1, 3));
    h.send(start());
    h.deliver();
    expect(h.client.phase).toBe('handshaking');
    expect(h.client.stats().malformed).toBe(3);
  });
});

describe('invité : salon', () => {
  it('lobby : appliqué seulement si seq plus grand ; emplacement mis à jour par `you`', () => {
    const h = lobbyHost();
    const seen: number[] = [];
    h.client.onLobby((l) => seen.push(l.seq));
    h.send({ t: 'lobby', lobby: lobbyState(2, { levelIndex: 3 }), you: 2 });
    h.send({ t: 'lobby', lobby: lobbyState(2, { levelIndex: 5 }), you: 2 }); // même seq : ignoré
    h.send({ t: 'lobby', lobby: lobbyState(1, { levelIndex: 6 }), you: 2 }); // plus ancien : ignoré
    h.send({ t: 'lobby', lobby: lobbyState(7, { levelIndex: 7 }), you: 3 });
    h.deliver();
    expect(seen).toEqual([2, 7]);
    expect(h.client.getLobby()?.levelIndex).toBe(7);
    expect(h.client.slot).toBe(3);
  });

  it('un salon mal formé est refusé et ne change rien', () => {
    const h = lobbyHost();
    h.send({ t: 'lobby', lobby: { ...lobbyState(9), slots: [] }, you: 1 });
    h.send({ t: 'lobby', lobby: lobbyState(9, { levelIndex: 99 }), you: 1 });
    h.deliver();
    expect(h.client.getLobby()?.seq).toBe(1);
    expect(h.client.stats().malformed).toBe(2);
  });

  it('sendChoice : envoie le choix (au salon seulement)', () => {
    const h = makeFakeHost();
    h.deliver();
    h.client.sendChoice({ characterId: 'mira', difficulty: 1, ready: true });
    h.deliver();
    expect(h.inbox.map((m) => m.t)).toEqual(['hello']); // pas encore au salon : ignoré
    h.send({ ...WELCOME, lobby: lobbyState(1) });
    h.deliver();
    h.client.sendChoice({ characterId: 'mira', difficulty: 1, ready: true });
    h.deliver();
    expect(h.inbox[1]).toEqual({ t: 'choice', characterId: 'mira', difficulty: 1, ready: true });
  });
});

describe('invité : lancement et fin de partie', () => {
  it('start : en jeu avec l\'identifiant de jeu définitif ; onStart reçoit tout', () => {
    const h = lobbyHost();
    const starts: unknown[] = [];
    h.client.onStart((s) => starts.push(s));
    const three = [
      { id: 0, characterId: 'david', difficulty: 2, name: 'Hôte' },
      { id: 1, characterId: 'sandrine', difficulty: 2, name: 'Autre' },
      { id: 2, characterId: 'romain', difficulty: 3, name: 'Moi' },
    ];
    h.send(start({ you: 2, gid: 777, levelIndex: 4, seed: 31337, players: three }));
    h.deliver();
    expect(h.client.phase).toBe('playing');
    expect(h.client.slot).toBe(2);
    expect(h.client.gameId).toBe(777);
    expect(starts).toEqual([
      {
        gameId: 777,
        localPlayerId: 2,
        levelIndex: 4,
        seed: 31337,
        players: three,
      },
    ]);
  });

  it('start invalide (niveau hors des niveaux de l\'invité, deux fois, hors salon) : ignoré', () => {
    const h = lobbyHost({ levelCount: 3 });
    h.send(start({ levelIndex: 3 }));
    h.deliver();
    expect(h.client.phase).toBe('lobby');
    h.send(start({ levelIndex: 2 }));
    h.send(start({ gid: 5, levelIndex: 1 })); // déjà en jeu : refusé
    h.deliver();
    expect(h.client.gameId).toBe(4242);
    expect(h.client.stats().malformed).toBe(2);
  });

  it('end : retour au salon, onEnd, la liaison reste ouverte ; un end d\'une autre partie est ignoré', () => {
    const h = playingHost();
    const ends: string[] = [];
    h.client.onEnd((r) => ends.push(r));
    h.send({ t: 'end', gid: 1, reason: 'aborted' });
    h.deliver();
    expect(h.client.phase).toBe('playing');
    h.send({ t: 'end', gid: 4242, reason: 'levelCompleted' });
    h.deliver();
    expect(ends).toEqual(['levelCompleted']);
    expect(h.client.phase).toBe('lobby');
    expect(h.client.gameId).toBeNull();
    expect(h.pair.b.state).toBe('open');
    // un instantané retardataire après la fin est ignoré sans bruit
    h.send(snap(5, 15));
    h.deliver();
    expect(h.client.takeSnapshot()).toBeNull();
    expect(h.client.stats().malformed).toBe(0);
    // et on peut rejouer
    h.send({ t: 'lobby', lobby: lobbyState(2), you: 1 });
    h.send(start({ gid: 4243 }));
    h.deliver();
    expect(h.client.phase).toBe('playing');
    expect(h.client.gameId).toBe(4243);
  });

  it('end hors partie : ignoré', () => {
    const h = lobbyHost();
    const ends: string[] = [];
    h.client.onEnd((r) => ends.push(r));
    h.send({ t: 'end', gid: 4242, reason: 'hostQuit' });
    h.deliver();
    expect(ends).toEqual([]);
  });
});

describe('invité : envoi des entrées', () => {
  const frame = (over: Partial<ReturnType<typeof emptyFrame>> = {}) => ({ ...emptyFrame(), ...over });

  it('aucune entrée envoyée hors partie', () => {
    const h = lobbyHost();
    h.client.sendInput(frame({ moveX: 1 }), 0);
    h.deliver();
    expect(h.inbox.filter((m) => m.t === 'input')).toEqual([]);
  });

  it('le premier appel envoie tout de suite ; ensuite au plus un message par INPUT_SEND_MS', () => {
    const h = playingHost();
    h.client.sendInput(frame({ moveX: 1 }), 1000);
    h.client.sendInput(frame({ moveX: 1 }), 1010);
    h.client.sendInput(frame({ moveX: 1 }), 1032);
    h.deliver();
    expect(h.inbox.filter((m) => m.t === 'input')).toHaveLength(1);
    h.client.sendInput(frame({ moveX: 1 }), 1033);
    h.deliver();
    expect(h.inbox.filter((m) => m.t === 'input')).toHaveLength(2);
  });

  it('jamais plus d\'un message par pas simulé, même appelé à 1 kHz (seq strictement croissant)', () => {
    const h = playingHost();
    for (let t = 0; t < 1000; t++) h.client.sendInput(frame({ moveY: -1 }), t);
    h.deliver();
    const inputs = h.inbox.filter((m): m is Extract<ProtocolMessage, { t: 'input' }> => m.t === 'input');
    expect(inputs.length).toBeLessThanOrEqual(Math.ceil(1000 / NET.INPUT_SEND_MS));
    expect(inputs.length).toBeGreaterThan(25);
    const seqs = inputs.map((m) => m.seq);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    expect(inputs.every((m) => m.gid === 4242 && m.y === -100 && m.x === 0)).toBe(true);
  });

  it('un appui court entre deux envois n\'est pas perdu (OU des boutons) ; les axes prennent la dernière valeur', () => {
    const h = playingHost();
    h.client.sendInput(frame(), 0); // envoyé
    h.client.sendInput(frame({ moveX: -1, attack: true }), 10); // appui court...
    h.client.sendInput(frame({ moveX: 0.5 }), 20); // ...relâché
    h.client.sendInput(frame({ moveX: 0.25, special: true }), 25);
    h.client.sendInput(frame({ moveX: 0.5 }), 40); // envoi : OU de tout depuis le dernier envoi
    h.deliver();
    const inputs = h.inbox.filter((m): m is Extract<ProtocolMessage, { t: 'input' }> => m.t === 'input');
    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toMatchObject({ x: 50, b: FRAME_BIT.attack | FRAME_BIT.special });
    // l'appui n'est envoyé qu'une fois
    h.client.sendInput(frame(), 80);
    h.deliver();
    expect(h.inbox.filter((m) => m.t === 'input')[2]).toMatchObject({ b: 0 });
  });

  it('une valeur non finie dans la frame locale part en 0 (jamais de NaN sur le fil)', () => {
    const h = playingHost();
    h.client.sendInput(frame({ moveX: Number.NaN, moveY: Number.POSITIVE_INFINITY }), 0);
    h.deliver();
    expect(h.inbox.filter((m) => m.t === 'input')[0]).toMatchObject({ x: 0, y: 0 });
  });

  it('une horloge qui recule ne bloque pas l\'envoi', () => {
    const h = playingHost();
    h.client.sendInput(frame(), 5000);
    h.client.sendInput(frame(), 100);
    h.deliver();
    expect(h.inbox.filter((m) => m.t === 'input')).toHaveLength(2);
  });

  it('la numérotation repart de 1 à chaque partie', () => {
    const h = playingHost();
    h.client.sendInput(frame(), 0);
    h.client.sendInput(frame(), 100);
    h.send({ t: 'end', gid: 4242, reason: 'aborted' });
    h.send({ t: 'lobby', lobby: lobbyState(2), you: 1 });
    h.send(start({ gid: 9 }));
    h.deliver();
    h.client.sendInput(frame(), 500);
    h.deliver();
    const inputs = h.inbox.filter((m): m is Extract<ProtocolMessage, { t: 'input' }> => m.t === 'input');
    expect(inputs.map((m) => [m.gid, m.seq])).toEqual([
      [4242, 1],
      [4242, 2],
      [9, 1],
    ]);
  });
});

describe('invité : instantanés', () => {
  it('takeSnapshot : null sans nouveauté ; sinon le plus récent état avec TOUS les événements, dans l\'ordre ; une seule fois', () => {
    const h = playingHost();
    expect(h.client.takeSnapshot()).toBeNull();
    h.client.update(100);
    h.send(snap(1, 3, { ev: [ev('enemyHit', 1), ev('enemyHit', 2)] }));
    h.deliver();
    h.client.update(150);
    h.send(snap(2, 6, { ev: [ev('enemyDied', 3)] }));
    h.send(snap(3, 9, { ev: [ev('roomCleared', 4), ev('levelCompleted', 5)] }));
    h.deliver();
    const s = h.client.takeSnapshot();
    expect(s).toMatchObject({ n: 3, tick: 9, connectedMask: 3 });
    expect(s?.state).toEqual(fakeState(9));
    expect(s?.events.map((e) => (e as unknown as { id: number }).id)).toEqual([1, 2, 3, 4, 5]);
    expect(h.client.takeSnapshot()).toBeNull();
    // les événements suivants ne répètent pas les précédents
    h.send(snap(4, 12, { ev: [ev('enemyHit', 6)] }));
    h.deliver();
    expect(h.client.takeSnapshot()?.events.map((e) => (e as unknown as { id: number }).id)).toEqual([6]);
  });

  it('ignore les instantanés anciens, répétés, d\'une autre partie, ou dont le tick recule ; leurs événements ne comptent pas', () => {
    const h = playingHost();
    h.send(snap(5, 15, { ev: [ev('enemyHit', 1)] }));
    h.send(snap(5, 15, { ev: [ev('enemyHit', 2)] })); // répété
    h.send(snap(4, 12, { ev: [ev('enemyHit', 3)] })); // plus ancien
    h.send(snap(6, 9, { ev: [ev('enemyHit', 4)] })); // n plus grand mais tick qui recule
    h.send(snap(7, 21, { gid: 1, ev: [ev('enemyHit', 5)] })); // autre partie
    h.deliver();
    const s = h.client.takeSnapshot();
    expect(s).toMatchObject({ n: 5, tick: 15 });
    expect(s?.events).toHaveLength(1);
    expect(h.client.stats()).toMatchObject({ snapshotsReceived: 1, snapshotsIgnored: 4 });
  });

  it('les événements de type inconnu sont écartés dès la réception', () => {
    const h = playingHost();
    h.send(snap(1, 3, { ev: [ev('enemyHit', 1), { type: 'piratage', id: 2 }, ev('roomEntered', 3)] }));
    h.deliver();
    expect(h.client.takeSnapshot()?.events.map((e) => e.type)).toEqual(['enemyHit', 'roomEntered']);
  });

  it('file d\'événements bornée à MAX_PENDING_EVENTS, sans jamais perdre les événements qui pilotent l\'interface', () => {
    const h = playingHost();
    h.send(snap(1, 3, { ev: [ev('roomEntered', -1)] }));
    for (let n = 2; n < 40; n++) h.send(snap(n, n * 3, { ev: Array.from({ length: 30 }, (_, i) => ev('enemyHit', n * 100 + i)) }));
    h.send(snap(40, 120, { ev: [ev('levelCompleted', -2)] }));
    h.deliver();
    const s = h.client.takeSnapshot();
    expect(s?.events.length).toBeLessThanOrEqual(NET.MAX_PENDING_EVENTS);
    expect(s?.events.some((e) => e.type === 'roomEntered')).toBe(true);
    expect(s?.events.some((e) => e.type === 'levelCompleted')).toBe(true);
    const hits = s?.events.filter((e) => e.type === 'enemyHit') ?? [];
    expect((hits[hits.length - 1] as unknown as { id: number }).id).toBe(39 * 100 + 29); // les plus récents sont conservés
  });

  it('un instantané fragmenté en plusieurs messages est réassemblé', () => {
    const h = makeFakeHost({}, 800);
    h.client.update(0);
    h.deliver();
    h.send({ ...WELCOME, lobby: lobbyState(1) });
    h.send(start());
    const big = { ...fakeState(3), pad: 'abc"def\\'.repeat(900) };
    h.send(snap(1, 3, { st: big }));
    expect(h.pair.pending()).toBeGreaterThan(8);
    h.deliver();
    expect(JSON.stringify(h.client.takeSnapshot()?.state)).toBe(JSON.stringify(big));
  });

  it('un instantané dont l\'enveloppe est invalide est refusé (compté), l\'état précédent reste', () => {
    const h = playingHost();
    h.send(snap(1, 3));
    h.send(snap(2, 6, { st: { levelId: 'x' } })); // pas de version
    h.send(snap(3, 9, { st: 'texte' }));
    h.send(snap(4, 12, { ev: 'non' }));
    h.deliver();
    expect(h.client.takeSnapshot()).toMatchObject({ n: 1, tick: 3 });
    expect(h.client.stats().malformed).toBe(3);
  });

  describe('intervalle estimé entre instantanés', () => {
    function feed(h: FakeHost, gaps: number[], start = 1000): void {
      let t = start;
      let n = 0;
      let tick = 0;
      for (const gap of gaps) {
        t += gap;
        n++;
        tick += 3;
        h.client.update(t);
        h.send(snap(n, tick));
        h.deliver();
      }
    }

    it('valeur initiale : l\'intervalle nominal (50 ms)', () => {
      const h = playingHost();
      h.client.update(0);
      h.send(snap(1, 3));
      h.deliver();
      expect(h.client.takeSnapshot()?.intervalMs).toBe(NET.SNAPSHOT_INTERVAL_MS);
    });

    it('moyenne des intervalles d\'arrivée', () => {
      const h = playingHost();
      feed(h, [50, 50, 50, 50, 50, 50]);
      expect(h.client.takeSnapshot()?.intervalMs).toBeCloseTo(50, 5);
      const h2 = playingHost();
      feed(h2, [0, 60, 80, 60, 80, 60, 80]);
      expect(h2.client.takeSnapshot()?.intervalMs).toBeCloseTo(70, 5);
    });

    it('bornée à [INTERP_MIN_MS, INTERP_MAX_MS]', () => {
      const slow = playingHost();
      feed(slow, [100, 100, 100, 100, 100]);
      expect(slow.client.takeSnapshot()?.intervalMs).toBe(NET.INTERP_MAX_MS - 20 >= 100 ? 100 : NET.INTERP_MAX_MS);
      const slower = playingHost();
      feed(slower, [500, 500, 500, 500]);
      expect(slower.client.takeSnapshot()?.intervalMs).toBe(NET.INTERP_MAX_MS);
      const fast = playingHost();
      feed(fast, [10, 10, 10, 10, 10]);
      expect(fast.client.takeSnapshot()?.intervalMs).toBe(NET.INTERP_MIN_MS);
    });

    it('une salve d\'instantanés dans le même tour (après un blocage) ne fausse pas la moyenne', () => {
      const h = playingHost();
      feed(h, [50, 50, 50, 50]);
      // blocage de 2 s puis 6 instantanés dans le même tour de boucle
      h.client.update(1000 + 200 + 2000);
      for (let i = 0; i < 6; i++) h.send(snap(5 + i, 15 + 3 * i));
      h.deliver();
      const s = h.client.takeSnapshot();
      expect(s?.intervalMs).toBeLessThan(NET.INTERP_MAX_MS);
      expect(s?.intervalMs).toBeGreaterThanOrEqual(NET.INTERP_MIN_MS);
      expect(s?.n).toBe(10);
    });

    it('receivedAtMs : l\'heure de réception du dernier instantané', () => {
      const h = playingHost();
      h.client.update(1234);
      h.send(snap(1, 3));
      h.deliver();
      expect(h.client.takeSnapshot()?.receivedAtMs).toBe(1234);
    });
  });
});

describe('invité : ping, aller-retour, silence, départ', () => {
  it('ping → pong immédiat avec les mêmes n et ts', () => {
    const h = lobbyHost();
    h.send({ t: 'ping', n: 7, ts: 123456.5 });
    h.deliver();
    expect(h.inbox.filter((m) => m.t === 'pong')).toEqual([{ t: 'pong', n: 7, ts: 123456.5 }]);
  });

  it('rttMs : null au départ, puis la dernière mesure de l\'hôte (champ r du ping), à défaut le pingMs du salon', () => {
    const h = lobbyHost();
    expect(h.client.rttMs()).toBeNull();
    h.send({ t: 'lobby', lobby: lobbyState(2, { slots: lobbyState(2).slots.map((s) => (s.slot === 1 ? { ...s, pingMs: 31 } : s)) }), you: 1 });
    h.deliver();
    expect(h.client.rttMs()).toBe(31);
    h.send({ t: 'ping', n: 1, ts: 0, r: 45 });
    h.deliver();
    expect(h.client.rttMs()).toBe(45);
    h.send({ t: 'ping', n: 2, ts: 0, r: -5 }); // invalide : ignoré
    h.deliver();
    expect(h.client.rttMs()).toBe(45);
    expect(h.client.stats().rttMs).toBe(45);
  });

  it('silence de l\'hôte : perdu au bout de PEER_TIMEOUT_MS ; chaque message reçu repousse l\'échéance', () => {
    const h = lobbyHost();
    h.client.update(0);
    h.client.update(NET.PEER_TIMEOUT_MS - 100);
    h.send({ t: 'ping', n: 1, ts: 0 });
    h.deliver();
    h.client.update(NET.PEER_TIMEOUT_MS + 500);
    expect(h.client.phase).toBe('lobby');
    h.client.update(NET.PEER_TIMEOUT_MS + 500 + NET.PEER_TIMEOUT_MS + 1);
    expect(h.client.phase).toBe('closed');
    expect(h.closed).toEqual([{ reason: 'hostLost' }]);
    expect(noticeForClose(h.closed[0])).toEqual({ code: 'hostLost' });
  });

  it('affichage suspendu plus longtemps que PEER_TIMEOUT_MS : un message arrivé pendant la suspension compte, l\'hôte n\'est pas perdu', () => {
    const h = playingHost();
    h.client.update(0);
    // aucun `update` pendant 10 s (téléphone verrouillé) ; l'hôte, lui, continue d'écrire
    h.clock.advance(NET.PEER_TIMEOUT_MS + 4000);
    h.send({ t: 'ping', n: 1, ts: 0 });
    h.deliver();
    h.client.update(h.clock.now());
    expect(h.client.phase).toBe('playing');
    expect(h.closed).toEqual([]);
    // le vrai silence reste détecté
    h.client.update(h.clock.now() + NET.PEER_TIMEOUT_MS + 1);
    expect(h.closed).toEqual([{ reason: 'hostLost' }]);
  });

  it('silence en partie : hôte perdu aussi', () => {
    const h = playingHost();
    h.client.update(0);
    h.client.update(NET.PEER_TIMEOUT_MS + 1);
    expect(h.closed).toEqual([{ reason: 'hostLost' }]);
  });

  it('coupure franche du canal : transportFailed', () => {
    const h = playingHost();
    h.pair.cut('wifi');
    expect(h.closed).toEqual([{ reason: 'transportFailed' }]);
  });

  it('leave de l\'hôte : hostLeft (sans attendre la fermeture du canal)', () => {
    const h = lobbyHost();
    h.send({ t: 'leave' });
    h.pair.a.close();
    h.deliver();
    expect(h.closed).toEqual([{ reason: 'hostLeft' }]);
  });

  it('leave() : envoie leave, ferme le canal, notifie userLeft une fois, idempotent ; plus aucune entrée ensuite', () => {
    const h = playingHost();
    h.client.leave();
    h.client.leave();
    h.deliver();
    expect(h.closed).toEqual([{ reason: 'userLeft' }]);
    expect(noticeForClose(h.closed[0])).toBeNull(); // départ volontaire : aucun message
    expect(h.inbox.some((m) => m.t === 'leave')).toBe(true);
    expect(h.pair.a.state).toBe('closed');
    h.client.sendInput(emptyFrame(), 0);
    h.client.sendChoice({ characterId: 'david', difficulty: 2, ready: true });
    h.client.update(1e9);
    expect(h.client.takeSnapshot()).toBeNull();
    expect(h.client.phase).toBe('closed');
  });

  it('trop de messages invalides : protocolError', () => {
    const h = lobbyHost();
    for (let i = 0; i < NET.MAX_MALFORMED; i++) h.sendText('{{{');
    h.deliver();
    expect(h.client.phase).toBe('lobby');
    h.sendText('{{{');
    h.deliver();
    expect(h.closed).toEqual([{ reason: 'protocolError' }]);
    expect(noticeForClose(h.closed[0])).toEqual({ code: 'protocolError' });
  });

  it('messages du mauvais sens envoyés par l\'hôte (input, hello…) : comptés', () => {
    const h = lobbyHost();
    h.send({ t: 'input', gid: 1, seq: 1, x: 0, y: 0, b: 0 });
    h.send({ t: 'hello', proto: 1 });
    h.send({ t: 'pong', n: 1, ts: 1 });
    h.deliver();
    expect(h.client.stats().malformed).toBe(3);
  });

  it('après fermeture, plus aucun rappel ni état ne change', () => {
    const h = lobbyHost();
    const lobbies: number[] = [];
    h.client.onLobby((l) => lobbies.push(l.seq));
    h.client.leave();
    h.send({ t: 'lobby', lobby: lobbyState(9), you: 1 });
    h.deliver();
    expect(lobbies).toEqual([]);
  });

  it('les abonnés qui lèvent une exception ne cassent pas la session', () => {
    const h = lobbyHost();
    h.client.onLobby(() => {
      throw new Error('abonné bogué');
    });
    const original = console.error;
    console.error = (): void => undefined;
    try {
      h.send({ t: 'lobby', lobby: lobbyState(3), you: 1 });
      expect(() => h.deliver()).not.toThrow();
    } finally {
      console.error = original;
    }
    expect(h.client.getLobby()?.seq).toBe(3);
  });
});
