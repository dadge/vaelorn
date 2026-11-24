/**
 * Tests de la session HÔTE : arrivées (version, salon plein, partie commencée, double arrivée), salon (personnages uniques, niveau, départ, perte),
 * lancement, entrées distantes (dernière frame, péremption, perte, `seq`, cadence, appuis courts), instantanés (cadence, `n`, événements,
 * saturation), silence, fin de partie, fermeture. Les invités « réels » sont de vraies `ClientSession` ; les « bruts » écrivent des messages à la main.
 */
import { describe, expect, it } from 'vitest';
import type { GameState, SimEvent } from '../core/types';
import { emptyFrame } from '../input/mapping';
import {
  FRAME_BIT,
  NET,
  NET_PROTOCOL_VERSION,
  SIM_EVENTS_NEVER_DROPPED,
  packFrame,
  type LobbyState,
  type NetPeerEvent,
} from './contracts';
import {
  AFTER_TIMEOUT_MS,
  STEP_MS,
  TEST_BUILD,
  TEST_LEVEL_COUNT,
  advance,
  connectGuest,
  createFakeClock,
  createRig,
  createTestHost,
  pump,
  readyAll,
  startedRig,
  type FakeClock,
  type TestRig,
} from './netTestKit';
import { createDecoder, createEncoder, type ProtocolMessage } from './protocol';
import { createLoopbackPair, type LoopbackPairEx } from './transportLoopback';
import type { HostSession } from './hostSession';

// ───────────── Aides ─────────────

interface RawGuest {
  pair: LoopbackPairEx;
  inbox: ProtocolMessage[];
  send(obj: unknown): void;
  sendText(text: string): void;
}

/** Invité « brut » : on écrit les messages à la main ; ce que l'hôte lui envoie est décodé dans `inbox`. */
function rawGuest(host: HostSession, clock: FakeClock): RawGuest {
  const pair = createLoopbackPair();
  host.addGuest(pair.a);
  const inbox: ProtocolMessage[] = [];
  const dec = createDecoder('toGuest');
  pair.b.onMessage((t) => {
    const r = dec.decode(t, clock.now());
    if (r.kind === 'message') inbox.push(r.msg);
  });
  const enc = createEncoder(pair.b.maxMessageChars);
  return {
    pair,
    inbox,
    send: (obj) => {
      for (const t of enc.encode(obj as ProtocolMessage)) pair.b.send(t);
    },
    sendText: (text) => pair.b.send(text),
  };
}

function helloMsg(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { t: 'hello', proto: NET_PROTOCOL_VERSION, build: TEST_BUILD, levels: TEST_LEVEL_COUNT, name: 'Brut', ...over };
}

/** Met à jour l'hôte et livre les messages de ces invités bruts (quelques tours). */
function settleRaw(host: HostSession, clock: FakeClock, raws: RawGuest[], rounds = 6): void {
  for (let i = 0; i < rounds; i++) {
    host.update(clock.now());
    let n = 0;
    for (const r of raws) n += r.pair.flush();
    if (n === 0) break;
  }
}

function types(g: RawGuest): string[] {
  return g.inbox.map((m) => m.t);
}

function lobbyOf(rig: TestRig, i: number): LobbyState {
  const l = rig.guests[i].client.getLobby();
  if (!l) throw new Error('pas de salon');
  return l;
}

function fakeState(tick: number): GameState {
  return { version: 1, levelId: 'test', tick, timeMs: tick * STEP_MS, players: [] } as unknown as GameState;
}

const frameOf = (over: Partial<ReturnType<typeof emptyFrame>> = {}): ReturnType<typeof emptyFrame> => ({ ...emptyFrame(), special: false, call: false, heart: false, ...over });

// ───────────── Arrivées ─────────────

describe('hôte : salon initial et arrivées', () => {
  it('salon initial : l\'hôte seul, emplacement 0, pas prêt, premier niveau', () => {
    const host = createTestHost();
    const lobby = host.getLobby();
    expect(host.phase).toBe('lobby');
    expect(host.role).toBe('host');
    expect(lobby).toMatchObject({ seq: 0, levelIndex: 0, levelCount: TEST_LEVEL_COUNT });
    expect(lobby.slots).toHaveLength(1);
    expect(lobby.slots[0]).toMatchObject({ slot: 0, name: 'Hôte', isHost: true, connected: true, ready: false, difficulty: 2 });
    expect(host.connectedMask()).toBe(1);
  });

  it('le nom et le personnage de l\'hôte sont assainis / validés', () => {
    const h = createTestHost({ hostName: '<<>>', hostCharacter: 'mira' });
    expect(h.getLobby().slots[0].name).toBe('P1');
    expect(h.getLobby().slots[0].characterId).toBe('mira');
    const bad = createTestHost({ hostCharacter: 'pirate' as never });
    expect(bad.getLobby().slots[0].characterId).toBe('david');
  });

  it('un invité compatible : welcome, emplacement 1, salon cohérent des deux côtés, événement « joined »', () => {
    const rig = createRig(1);
    const events: NetPeerEvent[] = [];
    const lobbies: LobbyState[] = [];
    rig.host.onPeerEvent((e) => events.push(e));
    rig.host.onLobby((l) => lobbies.push(l));
    pump(rig);
    const client = rig.guests[0].client;
    expect(client.phase).toBe('lobby');
    expect(client.slot).toBe(1);
    expect(events).toEqual([{ type: 'joined', slot: 1, name: 'G1' }]);
    expect(lobbies).toHaveLength(1);
    expect(lobbyOf(rig, 0)).toEqual(rig.host.getLobby());
    expect(rig.host.getLobby().slots.map((s) => [s.slot, s.name, s.isHost])).toEqual([
      [0, 'Hôte', true],
      [1, 'G1', false],
    ]);
  });

  it('trois invités : emplacements 1, 2, 3 dans l\'ordre d\'arrivée ; personnages par défaut tous différents', () => {
    const rig = createRig(3);
    pump(rig);
    expect(rig.guests.map((g) => g.client.slot)).toEqual([1, 2, 3]);
    const chars = rig.host.getLobby().slots.map((s) => s.characterId);
    expect(new Set(chars).size).toBe(4);
    // tous voient le même salon
    for (let i = 0; i < 3; i++) expect(lobbyOf(rig, i)).toEqual(rig.host.getLobby());
    expect(rig.host.connectedMask()).toBe(0b1111);
  });

  it('un quatrième invité est refusé : salon complet', () => {
    const rig = createRig(3);
    pump(rig);
    const extra = connectGuest(rig.host, { name: 'Trop' });
    rig.guests.push(extra);
    pump(rig);
    expect(extra.client.phase).toBe('closed');
    expect(rig.host.getLobby().slots).toHaveLength(4);
    const closed: unknown[] = [];
    extra.client.onClosed((i) => closed.push(i));
    expect(closed[0]).toMatchObject({ reason: 'rejected', reject: { reason: 'full', hostProto: NET_PROTOCOL_VERSION, hostLevels: TEST_LEVEL_COUNT, hostBuild: TEST_BUILD } });
  });

  it('un invité parti libère son emplacement : le suivant prend le plus bas libre, les autres gardent le leur', () => {
    const rig = createRig(3);
    pump(rig);
    const events: NetPeerEvent[] = [];
    rig.host.onPeerEvent((e) => events.push(e));
    rig.guests[1].client.leave(); // emplacement 2
    pump(rig);
    expect(events).toEqual([{ type: 'left', slot: 2, name: 'G2' }]);
    expect(rig.host.getLobby().slots.map((s) => s.slot)).toEqual([0, 1, 3]);
    const late = connectGuest(rig.host, { name: 'Tard' });
    rig.guests.push(late);
    pump(rig);
    expect(late.client.slot).toBe(2);
    expect(rig.host.getLobby().slots.map((s) => s.slot)).toEqual([0, 1, 2, 3]);
  });

  it('un invité perdu (coupure du canal) en salon est retiré : événement « lost »', () => {
    const rig = createRig(2);
    pump(rig);
    const events: NetPeerEvent[] = [];
    rig.host.onPeerEvent((e) => events.push(e));
    rig.guests[0].pair.cut('wifi');
    expect(events).toEqual([{ type: 'lost', slot: 1, name: 'G1' }]);
    expect(rig.host.getLobby().slots.map((s) => s.slot)).toEqual([0, 2]);
    pump(rig);
    expect(lobbyOf(rig, 1).slots.map((s) => s.slot)).toEqual([0, 2]);
    expect(rig.guests[0].client.phase).toBe('closed');
  });

  it('les nombres de liaisons sont bornés : au-delà de 8, la nouvelle est fermée tout de suite', () => {
    const host = createTestHost();
    const clock = createFakeClock();
    const raws: RawGuest[] = [];
    for (let i = 0; i < 8; i++) raws.push(rawGuest(host, clock)); // 8 liaisons sans `hello`
    const ninth = createLoopbackPair();
    host.addGuest(ninth.a);
    expect(ninth.a.state).toBe('closed');
    // un transport déjà fermé n'est pas pris en charge
    const dead = createLoopbackPair();
    dead.a.close();
    host.addGuest(dead.a);
    expect(host.stats().peers).toHaveLength(0);
  });
});

describe('hôte : vérification à la connexion', () => {
  it('protocole différent → reject « protocol » avec les données de l\'hôte, même si le reste du message est d\'une autre forme', () => {
    const host = createTestHost();
    const clock = createFakeClock();
    const g = rawGuest(host, clock);
    g.send({ t: 'hello', proto: NET_PROTOCOL_VERSION + 1, autre: 'forme' });
    settleRaw(host, clock, [g]);
    expect(g.inbox).toHaveLength(1);
    expect(g.inbox[0]).toMatchObject({ t: 'reject', reason: 'protocol', proto: NET_PROTOCOL_VERSION, levels: TEST_LEVEL_COUNT, build: TEST_BUILD });
    expect(host.getLobby().slots).toHaveLength(1);
  });

  it('build différent → « build » ; niveaux différents → « levels » ; chaque refus porte la version de l\'hôte', () => {
    const host = createTestHost();
    const clock = createFakeClock();
    for (const [over, reason] of [
      [{ build: { ...TEST_BUILD, commit: 'zzzzzzz' } }, 'build'],
      [{ build: { ...TEST_BUILD, version: '9.9.9' } }, 'build'],
      [{ build: { ...TEST_BUILD, date: '2000-01-01' } }, 'build'],
      [{ build: { version: TEST_BUILD.version, commit: null, date: null } }, 'build'],
      [{ levels: TEST_LEVEL_COUNT + 1 }, 'levels'],
    ] as const) {
      const g = rawGuest(host, clock);
      g.send(helloMsg(over));
      settleRaw(host, clock, [g]);
      expect(g.inbox[0], JSON.stringify(over)).toMatchObject({ t: 'reject', reason, build: TEST_BUILD });
    }
    expect(host.getLobby().slots).toHaveLength(1);
  });

  it('ordre des vérifications : protocole, puis build, puis niveaux, puis partie commencée, puis salon plein', () => {
    const rig = createRig(3);
    pump(rig);
    const clock = rig.clock;
    const both = rawGuest(rig.host, clock);
    both.send(helloMsg({ build: { ...TEST_BUILD, version: '2' }, levels: 1 }));
    const proto = rawGuest(rig.host, clock);
    proto.send({ t: 'hello', proto: 99, build: { ...TEST_BUILD, version: '2' }, levels: 1, name: 'x' });
    const lv = rawGuest(rig.host, clock);
    lv.send(helloMsg({ levels: 1 }));
    const full = rawGuest(rig.host, clock);
    full.send(helloMsg());
    settleRaw(rig.host, clock, [both, proto, lv, full]);
    expect(both.inbox[0]).toMatchObject({ reason: 'build' });
    expect(proto.inbox[0]).toMatchObject({ reason: 'protocol' });
    expect(lv.inbox[0]).toMatchObject({ reason: 'levels' });
    expect(full.inbox[0]).toMatchObject({ reason: 'full' });
    // partie commencée ET salon plein : « started » passe avant « full »
    readyAll(rig);
    expect(rig.host.startGame(1)).not.toBeNull();
    const started = rawGuest(rig.host, clock);
    started.send(helloMsg());
    settleRaw(rig.host, clock, [started]);
    expect(started.inbox[0]).toMatchObject({ reason: 'started' });
  });

  it('après un refus, la liaison est fermée au bout d\'un court délai (le temps que le message parte)', () => {
    const host = createTestHost();
    const clock = createFakeClock();
    host.update(clock.now());
    const g = rawGuest(host, clock);
    g.send(helloMsg({ levels: 1 }));
    settleRaw(host, clock, [g]);
    expect(g.pair.a.state).toBe('open');
    clock.advance(200);
    settleRaw(host, clock, [g]);
    expect(g.pair.a.state).toBe('open');
    clock.advance(200);
    settleRaw(host, clock, [g]);
    expect(g.pair.a.state).toBe('closed');
    expect(g.pair.b.state).toBe('closed');
  });

  it('premier message qui n\'est pas un hello (ou illisible) → reject « malformed »', () => {
    const host = createTestHost();
    const clock = createFakeClock();
    const a = rawGuest(host, clock);
    a.send({ t: 'input', gid: 1, seq: 1, x: 0, y: 0, b: 0 });
    const b = rawGuest(host, clock);
    b.sendText('pas du json');
    const c = rawGuest(host, clock);
    c.send({ t: 'hello', proto: NET_PROTOCOL_VERSION, build: 'x', levels: 9, name: 'n' });
    settleRaw(host, clock, [a, b, c]);
    for (const g of [a, b, c]) expect(g.inbox[0]).toMatchObject({ t: 'reject', reason: 'malformed' });
    expect(host.getLobby().slots).toHaveLength(1);
  });

  it('pas de hello à temps : liaison fermée, aucun emplacement pris, aucun événement', () => {
    const host = createTestHost();
    const clock = createFakeClock();
    const events: NetPeerEvent[] = [];
    host.onPeerEvent((e) => events.push(e));
    host.update(clock.now());
    const g = rawGuest(host, clock);
    clock.advance(NET.HELLO_TIMEOUT_MS - 1);
    settleRaw(host, clock, [g]);
    expect(g.pair.a.state).toBe('open');
    clock.advance(2);
    settleRaw(host, clock, [g]);
    expect(g.pair.a.state).toBe('closed');
    expect(events).toEqual([]);
    expect(host.getLobby().slots).toHaveLength(1);
  });

  it('double arrivée sur la même liaison : le second hello est ignoré (compté comme invalide), un seul emplacement', () => {
    const host = createTestHost();
    const clock = createFakeClock();
    const g = rawGuest(host, clock);
    g.send(helloMsg({ name: 'Un' }));
    g.send(helloMsg({ name: 'Deux' }));
    settleRaw(host, clock, [g]);
    expect(host.getLobby().slots.map((s) => s.name)).toEqual(['Hôte', 'Un']);
    expect(host.stats().malformed).toBe(1);
    expect(types(g)).toEqual(['welcome']);
  });

  it('deux liaisons du même nom : deux invités distincts (l\'identité est le canal)', () => {
    const host = createTestHost();
    const clock = createFakeClock();
    const a = rawGuest(host, clock);
    const b = rawGuest(host, clock);
    a.send(helloMsg({ name: 'Zoé' }));
    b.send(helloMsg({ name: 'Zoé' }));
    settleRaw(host, clock, [a, b]);
    expect(host.getLobby().slots.map((s) => s.slot)).toEqual([0, 1, 2]);
  });

  it('un nom vide ou piégé reçoit le nom neutre de l\'emplacement', () => {
    const host = createTestHost();
    const clock = createFakeClock();
    const g = rawGuest(host, clock);
    g.send(helloMsg({ name: '<>' }));
    settleRaw(host, clock, [g]);
    expect(host.getLobby().slots[1].name).toBe('P2');
  });
});

// ───────────── Salon ─────────────

describe('hôte : salon (choix, niveau, démarrage)', () => {
  it('un choix d\'invité est arbitré par l\'hôte puis rediffusé à tous (l\'invité n\'applique rien en local)', () => {
    const rig = createRig(2);
    pump(rig);
    const before = rig.guests[0].client.getLobby();
    rig.guests[0].client.sendChoice({ characterId: 'mira', difficulty: 3, ready: false });
    expect(rig.guests[0].client.getLobby()).toEqual(before); // rien tant que l'hôte n'a pas répondu
    pump(rig);
    const slot = rig.host.getLobby().slots[1];
    expect(slot).toMatchObject({ characterId: 'mira', difficulty: 3, ready: false });
    expect(lobbyOf(rig, 0)).toEqual(rig.host.getLobby());
    expect(lobbyOf(rig, 1)).toEqual(rig.host.getLobby());
  });

  it('deux participants prêts n\'ont jamais le même personnage', () => {
    const rig = createRig(2);
    pump(rig);
    rig.host.setLocalChoice({ characterId: 'brokk', ready: true });
    rig.guests[0].client.sendChoice({ characterId: 'brokk', difficulty: 2, ready: true }); // même personnage que l'hôte prêt
    pump(rig);
    const s1 = rig.host.getLobby().slots[1];
    expect(s1.characterId).toBe('brokk'); // le choix de personnage est accepté...
    expect(s1.ready).toBe(false); // ...mais pas « prêt »
    // il change de personnage et se déclare prêt
    rig.guests[0].client.sendChoice({ characterId: 'grok', difficulty: 2, ready: true });
    pump(rig);
    expect(rig.host.getLobby().slots[1]).toMatchObject({ characterId: 'grok', ready: true });
    // l'hôte ne peut pas non plus prendre le personnage d'un invité prêt
    rig.host.setLocalChoice({ characterId: 'grok', ready: true });
    expect(rig.host.getLobby().slots[0]).toMatchObject({ characterId: 'grok', ready: false });
    // redevenir « pas prêt » est toujours possible
    rig.guests[0].client.sendChoice({ characterId: 'grok', difficulty: 2, ready: false });
    pump(rig);
    expect(rig.host.getLobby().slots[1].ready).toBe(false);
    // l'invariant tient sur tout le salon
    rig.host.setLocalChoice({ characterId: 'grok', ready: true });
    const ready = rig.host.getLobby().slots.filter((s) => s.ready).map((s) => s.characterId);
    expect(new Set(ready).size).toBe(ready.length);
  });

  it('un invité peut changer de personnage tant qu\'il n\'est pas prêt, même vers celui d\'un participant non prêt', () => {
    const rig = createRig(1);
    pump(rig);
    rig.host.setLocalChoice({ characterId: 'aelith', ready: false });
    rig.guests[0].client.sendChoice({ characterId: 'aelith', difficulty: 1, ready: false });
    pump(rig);
    expect(rig.host.getLobby().slots.map((s) => s.characterId)).toEqual(['aelith', 'aelith']);
  });

  it('un choix identique ne provoque aucune diffusion', () => {
    const rig = createRig(1);
    pump(rig);
    const seen: number[] = [];
    rig.host.onLobby((l) => seen.push(l.seq));
    const cur = rig.host.getLobby().slots[1];
    rig.guests[0].client.sendChoice({ characterId: cur.characterId, difficulty: cur.difficulty, ready: cur.ready });
    rig.host.setLocalChoice({});
    pump(rig);
    expect(seen).toEqual([]);
  });

  it('seq du salon : strictement croissant à chaque changement', () => {
    const rig = createRig(1);
    pump(rig);
    const seqs: number[] = [rig.host.getLobby().seq];
    rig.host.onLobby((l) => seqs.push(l.seq));
    rig.host.setLocalChoice({ characterId: 'mira' });
    rig.host.setLocalChoice({ ready: true });
    rig.host.setLevel(2);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    expect(seqs).toHaveLength(4);
  });

  it('choix invalides venant du fil : ignorés et comptés, jamais appliqués', () => {
    const host = createTestHost();
    const clock = createFakeClock();
    const g = rawGuest(host, clock);
    g.send(helloMsg());
    settleRaw(host, clock, [g]);
    const before = host.getLobby();
    g.send({ t: 'choice', characterId: 'pirate', difficulty: 2, ready: true });
    g.send({ t: 'choice', characterId: 'david', difficulty: 9, ready: true });
    g.send({ t: 'choice', characterId: 'david', difficulty: 2, ready: 'oui' });
    settleRaw(host, clock, [g]);
    expect(host.getLobby()).toEqual(before);
    expect(host.stats().malformed).toBe(3);
  });

  it('cadence des choix plafonnée : le surplus d\'une même seconde est ignoré', () => {
    const host = createTestHost();
    const clock = createFakeClock();
    host.update(0);
    const g = rawGuest(host, clock);
    g.send(helloMsg());
    settleRaw(host, clock, [g]);
    const chars = ['sandrine', 'romain', 'valentine', 'aelith', 'brokk', 'grok', 'mira', 'david'] as const;
    for (let i = 0; i < 20; i++) g.send({ t: 'choice', characterId: chars[i % 8], difficulty: 1 + (i % 3), ready: false });
    settleRaw(host, clock, [g]);
    // 10 acceptés (index 0..9) : le dernier choix pris en compte est celui d'indice 9
    expect(host.getLobby().slots[1].characterId).toBe(chars[9 % 8]);
    // une seconde plus tard, ça repasse
    clock.advance(1100);
    g.send({ t: 'choice', characterId: 'mira', difficulty: 1, ready: false });
    settleRaw(host, clock, [g]);
    expect(host.getLobby().slots[1].characterId).toBe('mira');
  });

  it('setLevel : borné, remet tout le monde à « pas prêt », diffusé ; sans effet s\'il ne change rien', () => {
    const rig = createRig(1);
    pump(rig);
    readyAll(rig);
    expect(rig.host.getLobby().slots.every((s) => s.ready)).toBe(true);
    rig.host.setLevel(4);
    expect(rig.host.getLobby().levelIndex).toBe(4);
    expect(rig.host.getLobby().slots.every((s) => !s.ready)).toBe(true);
    pump(rig);
    expect(lobbyOf(rig, 0).levelIndex).toBe(4);
    const seq = rig.host.getLobby().seq;
    rig.host.setLevel(4);
    rig.host.setLevel(-1);
    rig.host.setLevel(TEST_LEVEL_COUNT);
    rig.host.setLevel(1.5);
    rig.host.setLevel(Number.NaN);
    expect(rig.host.getLobby().levelIndex).toBe(4);
    expect(rig.host.getLobby().seq).toBe(seq);
  });

  it('checkStart : needTwo seul, notReady si un participant n\'est pas prêt, ok sinon', () => {
    const rig = createRig(2);
    expect(rig.host.checkStart()).toEqual({ ok: false, reason: 'needTwo' });
    pump(rig);
    expect(rig.host.checkStart()).toEqual({ ok: false, reason: 'notReady' });
    rig.host.setLocalChoice({ characterId: 'david', ready: true });
    rig.guests[0].client.sendChoice({ characterId: 'sandrine', difficulty: 2, ready: true });
    pump(rig);
    expect(rig.host.checkStart()).toEqual({ ok: false, reason: 'notReady' }); // le second invité n'est pas prêt
    rig.guests[1].client.sendChoice({ characterId: 'romain', difficulty: 2, ready: true });
    pump(rig);
    expect(rig.host.checkStart()).toEqual({ ok: true });
    expect(rig.host.startGame(5)).not.toBeNull();
  });

  it('startGame refusé (null) si pas prêt, ou si ce n\'est plus le salon', () => {
    const rig = createRig(1);
    pump(rig);
    expect(rig.host.startGame(1)).toBeNull();
    expect(rig.host.phase).toBe('lobby');
    readyAll(rig);
    expect(rig.host.startGame(1)).not.toBeNull();
    expect(rig.host.startGame(1)).toBeNull();
  });

  it('les ids de jeu sont contigus au lancement même si un invité du milieu est parti', () => {
    const rig = createRig(3);
    pump(rig);
    rig.guests[1].client.leave(); // emplacement 2 parti : restent 1 et 3
    pump(rig);
    const alive = [rig.guests[0], rig.guests[2]];
    rig.host.setLocalChoice({ characterId: 'david', ready: true });
    alive[0].client.sendChoice({ characterId: 'sandrine', difficulty: 1, ready: true });
    alive[1].client.sendChoice({ characterId: 'romain', difficulty: 3, ready: true });
    pump(rig);
    const starts: { you: number; ids: number[] }[] = [];
    alive.forEach((g) => g.client.onStart((s) => starts.push({ you: s.localPlayerId, ids: s.players.map((p) => p.id) })));
    const info = rig.host.startGame(77);
    pump(rig);
    expect(info).not.toBeNull();
    expect(info?.localPlayerId).toBe(0);
    expect(info?.players.map((p) => [p.id, p.characterId, p.difficulty, p.name])).toEqual([
      [0, 'david', 2, 'Hôte'],
      [1, 'sandrine', 1, 'G1'],
      [2, 'romain', 3, 'G3'],
    ]);
    expect(starts).toEqual([
      { you: 1, ids: [0, 1, 2] },
      { you: 2, ids: [0, 1, 2] },
    ]);
    expect(alive[1].client.slot).toBe(2); // l'identifiant de jeu définitif remplace l'emplacement de salon
  });

  it('identifiant de partie déterministe : formule du contrat, différent à chaque partie même avec la même graine', () => {
    const { rig, info } = startedRig(1, 12345);
    const expected = (Math.imul(12345 ^ 0x5bd1e995, 0x9e3779b1) + 0) >>> 0;
    expect(info.gameId).toBe(expected);
    expect(info.seed).toBe(12345);
    rig.host.endGame('aborted');
    pump(rig);
    readyAll(rig);
    const second = rig.host.startGame(12345);
    expect(second?.gameId).toBe((Math.imul(12345 ^ 0x5bd1e995, 0x9e3779b1) + 1) >>> 0);
    expect(second?.gameId).not.toBe(info.gameId);
  });

  it('la graine est ramenée à un entier non signé 32 bits, commune à l\'hôte et aux invités', () => {
    for (const [given, kept] of [
      [-1, 0xffffffff],
      [1.9, 1],
      [2 ** 32 + 5, 5],
      [Number.NaN, 0],
      [Number.POSITIVE_INFINITY, 0],
    ] as const) {
      const rig = createRig(1);
      pump(rig);
      readyAll(rig);
      const seeds: number[] = [];
      rig.guests[0].client.onStart((s) => seeds.push(s.seed));
      const info = rig.host.startGame(given);
      pump(rig);
      expect(info?.seed, String(given)).toBe(kept);
      expect(seeds, String(given)).toEqual([kept]);
    }
  });

  it('une fois la partie commencée : choix et niveau sont ignorés', () => {
    const { rig } = startedRig(1);
    const before = rig.host.getLobby();
    rig.host.setLevel(3);
    rig.host.setLocalChoice({ characterId: 'mira' });
    rig.guests[0].client.sendChoice({ characterId: 'mira', difficulty: 3, ready: false }); // la session invité l'ignore hors salon
    pump(rig);
    expect(rig.host.getLobby().levelIndex).toBe(before.levelIndex);
    expect(rig.host.getLobby().slots.map((s) => s.characterId)).toEqual(before.slots.map((s) => s.characterId));
  });
});

// ───────────── Entrées distantes ─────────────

describe('hôte : entrées distantes', () => {
  it('la dernière frame reçue est tenue à chaque pas, au bon identifiant de jeu', () => {
    const { rig } = startedRig(3);
    const f1 = frameOf({ moveX: 1, moveY: -0.5, attack: true });
    const f3 = frameOf({ moveY: 1, interact: true, special: true });
    rig.guests[0].client.sendInput(f1, rig.clock.now());
    rig.guests[2].client.sendInput(f3, rig.clock.now());
    pump(rig);
    for (let step = 0; step < 5; step++) {
      const inputs = rig.host.pollRemoteInputs();
      expect(Object.keys(inputs).sort()).toEqual(['1', '2', '3']);
      expect(inputs[1]).toEqual(f1);
      expect(inputs[2]).toEqual(frameOf()); // le deuxième invité n'a rien envoyé : frame vide
      expect(inputs[3]).toEqual(f3);
      expect(inputs[0]).toBeUndefined(); // l'hôte n'y figure pas
    }
  });

  it('l\'identité vient du canal : un invité ne peut pas piloter un autre joueur', () => {
    const { rig } = startedRig(2);
    // le message ne contient aucun champ d'identité exploitable : même avec des champs en trop, seul le canal compte
    const raw = rig.guests[0].pair.b;
    const gid = rig.guests[0].client.gameId as number;
    raw.send(JSON.stringify({ t: 'input', gid, seq: 1, x: 100, y: 0, b: 1, player: 2, id: 2, slot: 2 }));
    pump(rig);
    const inputs = rig.host.pollRemoteInputs();
    expect(inputs[1]?.moveX).toBe(1);
    expect(inputs[2]).toEqual(frameOf());
  });

  it('les axes sont quantifiés au centième et les boutons repris tels quels (aller-retour du fil)', () => {
    const { rig } = startedRig(1);
    const f = frameOf({ moveX: 0.333, moveY: -0.999, revive: true, call: true, heart: true });
    rig.guests[0].client.sendInput(f, rig.clock.now());
    pump(rig);
    const got = rig.host.pollRemoteInputs()[1];
    expect(got).toEqual(frameOf({ moveX: 0.33, moveY: -1, revive: true, call: true, heart: true }));
  });

  it('entrée périmée (> INPUT_STALE_MS) : frame vide, jamais d\'attaque « collée »', () => {
    const { rig } = startedRig(1);
    rig.guests[0].client.sendInput(frameOf({ attack: true, moveX: 1 }), rig.clock.now());
    pump(rig);
    expect(rig.host.pollRemoteInputs()[1]?.attack).toBe(true);
    advance(rig, NET.INPUT_STALE_MS);
    expect(rig.host.pollRemoteInputs()[1]?.attack).toBe(true); // pile à la limite : encore tenue
    advance(rig, 20);
    const stale = rig.host.pollRemoteInputs()[1];
    expect(stale).toEqual(frameOf());
    // une nouvelle entrée la remet en service
    rig.guests[0].client.sendInput(frameOf({ moveY: 1 }), rig.clock.now());
    pump(rig);
    expect(rig.host.pollRemoteInputs()[1]?.moveY).toBe(1);
  });

  it('une entrée régulière (30 Hz) garde la frame vivante bien au-delà de 250 ms', () => {
    const { rig } = startedRig(1);
    for (let i = 0; i < 60; i++) {
      rig.guests[0].client.sendInput(frameOf({ moveX: 1 }), rig.clock.now());
      advance(rig, 33);
      expect(rig.host.pollRemoteInputs()[1]?.moveX).toBe(1);
    }
  });

  it('invité perdu en partie : frame vide, masque mis à jour, le joueur reste dans la partie ; événement « lost »', () => {
    const { rig } = startedRig(2);
    const events: NetPeerEvent[] = [];
    rig.host.onPeerEvent((e) => events.push(e));
    rig.guests[0].client.sendInput(frameOf({ attack: true }), rig.clock.now());
    pump(rig);
    expect(rig.host.connectedMask()).toBe(0b0111);
    rig.guests[0].pair.cut('wifi');
    expect(events).toEqual([{ type: 'lost', slot: 1, name: 'G1' }]); // identifiant de jeu pendant la partie
    expect(rig.host.connectedMask()).toBe(0b0101);
    const inputs = rig.host.pollRemoteInputs();
    expect(inputs[1]).toEqual(frameOf());
    expect(Object.keys(inputs).sort()).toEqual(['1', '2']);
    expect(rig.host.getLobby().slots.find((s) => s.slot === 1)?.connected).toBe(false);
    expect(rig.host.phase).toBe('playing');
    // l'autre invité continue
    rig.guests[1].client.sendInput(frameOf({ moveX: -1 }), rig.clock.now());
    pump(rig);
    expect(rig.host.pollRemoteInputs()[2]?.moveX).toBe(-1);
  });

  it('un invité qui quitte proprement en partie : événement « left », frame vide', () => {
    const { rig } = startedRig(2);
    const events: NetPeerEvent[] = [];
    rig.host.onPeerEvent((e) => events.push(e));
    rig.guests[1].client.leave();
    pump(rig);
    expect(events).toEqual([{ type: 'left', slot: 2, name: 'G2' }]);
    expect(rig.host.pollRemoteInputs()[2]).toEqual(frameOf());
  });

  it('un nouvel invité en partie est refusé (started) : pas de reconnexion dans le lot 1', () => {
    const { rig } = startedRig(2);
    const late = connectGuest(rig.host, { name: 'Retour' });
    rig.guests.push(late);
    pump(rig);
    const closed: unknown[] = [];
    late.client.onClosed((i) => closed.push(i));
    expect(closed[0]).toMatchObject({ reason: 'rejected', reject: { reason: 'started' } });
  });

  /** Partie avec un invité BRUT (messages écrits à la main). */
  function rawGame(): { host: HostSession; clock: FakeClock; g: RawGuest; gid: number } {
    const host = createTestHost();
    const clock = createFakeClock();
    host.update(0);
    const g = rawGuest(host, clock);
    g.send(helloMsg());
    settleRaw(host, clock, [g]);
    g.send({ t: 'choice', characterId: 'sandrine', difficulty: 2, ready: true });
    host.setLocalChoice({ characterId: 'david', ready: true });
    settleRaw(host, clock, [g]);
    const info = host.startGame(9);
    if (!info) throw new Error('pas de partie');
    settleRaw(host, clock, [g]);
    return { host, clock, g, gid: info.gameId };
  }

  it('seq : un numéro rétrograde ou répété est ignoré', () => {
    const { host, clock, g, gid } = rawGame();
    g.send({ t: 'input', gid, seq: 5, x: 100, y: 0, b: 0 });
    settleRaw(host, clock, [g]);
    expect(host.pollRemoteInputs()[1]?.moveX).toBe(1);
    g.send({ t: 'input', gid, seq: 5, x: -100, y: 0, b: 0 });
    g.send({ t: 'input', gid, seq: 3, x: -100, y: 0, b: 0 });
    g.send({ t: 'input', gid, seq: 0, x: -100, y: 0, b: 0 });
    settleRaw(host, clock, [g]);
    expect(host.pollRemoteInputs()[1]?.moveX).toBe(1);
    g.send({ t: 'input', gid, seq: 6, x: -100, y: 0, b: 0 });
    settleRaw(host, clock, [g]);
    expect(host.pollRemoteInputs()[1]?.moveX).toBe(-1);
    expect(host.stats().malformed).toBe(0); // simples doublons : rien d'anormal
  });

  it('une entrée d\'une autre partie (gid) ou envoyée avant le lancement est ignorée', () => {
    const { host, clock, g, gid } = rawGame();
    g.send({ t: 'input', gid: gid + 1, seq: 1, x: 100, y: 0, b: 1 });
    g.send({ t: 'input', gid: 0, seq: 2, x: 100, y: 0, b: 1 });
    settleRaw(host, clock, [g]);
    expect(host.pollRemoteInputs()[1]).toEqual(frameOf());
    // avant le lancement : une autre session hôte, en salon
    const lobbyHost = createTestHost();
    const c2 = createFakeClock();
    const g2 = rawGuest(lobbyHost, c2);
    g2.send(helloMsg());
    g2.send({ t: 'input', gid: 1, seq: 1, x: 100, y: 0, b: 1 });
    settleRaw(lobbyHost, c2, [g2]);
    expect(lobbyHost.pollRemoteInputs()).toEqual({});
    expect(lobbyHost.stats().malformed).toBe(0);
  });

  it('valeurs hors bornes : jamais d\'ActionFrame hors bornes, le message est compté comme invalide', () => {
    const { host, clock, g, gid } = rawGame();
    const evil: Record<string, unknown>[] = [
      { x: 1000, y: 0, b: 0 },
      { x: 0, y: -101, b: 0 },
      { x: 0, y: 0, b: 64 },
      { x: 0, y: 0, b: -1 },
      { x: 0.5, y: 0, b: 0 },
      { x: 'a', y: 0, b: 0 },
      { x: null, y: 0, b: 0 },
      { x: 1e308, y: 0, b: 0 },
    ];
    evil.forEach((e, i) => g.send({ t: 'input', gid, seq: 10 + i, ...e }));
    settleRaw(host, clock, [g]);
    expect(host.pollRemoteInputs()[1]).toEqual(frameOf());
    expect(host.stats().malformed).toBe(evil.length);
    // le JSON d'un NaN / Infinity devient null : refusé aussi
    g.sendText('{"t":"input","gid":' + gid + ',"seq":99,"x":NaN,"y":0,"b":0}');
    settleRaw(host, clock, [g]);
    expect(host.pollRemoteInputs()[1]).toEqual(frameOf());
  });

  it('cadence plafonnée : au-delà de MAX_INPUT_PER_SEC messages par seconde, le surplus est ignoré', () => {
    const { host, clock, g, gid } = rawGame();
    for (let i = 1; i <= 150; i++) g.send({ t: 'input', gid, seq: i, x: i % 100, y: 0, b: 0 });
    settleRaw(host, clock, [g], 20);
    // seuls les NET.MAX_INPUT_PER_SEC premiers sont pris en compte (le x du 120e)
    expect(host.pollRemoteInputs()[1]?.moveX).toBeCloseTo((NET.MAX_INPUT_PER_SEC % 100) / 100);
    clock.advance(1100);
    settleRaw(host, clock, [g]);
    g.send({ t: 'input', gid, seq: 151, x: 77, y: 0, b: 0 });
    settleRaw(host, clock, [g]);
    expect(host.pollRemoteInputs()[1]?.moveX).toBeCloseTo(0.77);
  });

  it('appui court : deux messages (appui puis relâché) reçus dans le même tour ne perdent pas l\'appui', () => {
    const { host, clock, g, gid } = rawGame();
    g.send({ t: 'input', gid, seq: 1, x: 0, y: 0, b: FRAME_BIT.attack | FRAME_BIT.special });
    g.send({ t: 'input', gid, seq: 2, x: 0, y: 0, b: 0 });
    settleRaw(host, clock, [g]);
    const first = host.pollRemoteInputs()[1];
    expect(first).toMatchObject({ attack: true, special: true });
    const second = host.pollRemoteInputs()[1];
    expect(second).toEqual(frameOf()); // l'appui n'est vu qu'une fois
  });

  it('trop de messages invalides : la liaison de l\'invité est fermée (« lost »)', () => {
    const host = createTestHost();
    const clock = createFakeClock();
    const g = rawGuest(host, clock);
    g.send(helloMsg());
    settleRaw(host, clock, [g]);
    const events: NetPeerEvent[] = [];
    host.onPeerEvent((e) => events.push(e));
    for (let i = 0; i < NET.MAX_MALFORMED; i++) g.sendText('{{{');
    settleRaw(host, clock, [g]);
    expect(g.pair.a.state).toBe('open'); // exactement MAX_MALFORMED : toléré
    g.sendText('{{{');
    settleRaw(host, clock, [g]);
    expect(g.pair.a.state).toBe('closed');
    expect(events).toEqual([{ type: 'lost', slot: 1, name: 'Brut' }]);
    expect(host.getLobby().slots).toHaveLength(1);
  });

  it('messages du mauvais sens (snap, welcome…) envoyés par un invité : comptés, sans effet', () => {
    const { host, clock, g } = rawGame();
    g.send({ t: 'snap', gid: 1, n: 1, tick: 3, pc: 1, st: { version: 1, levelId: 'x' }, ev: [] });
    g.send({ t: 'start', gid: 1, you: 0, levelIndex: 0, seed: 1, players: [] });
    g.send({ t: 'ping', n: 1, ts: 1 });
    settleRaw(host, clock, [g]);
    expect(host.stats().malformed).toBe(3);
    expect(host.phase).toBe('playing');
  });
});

// ───────────── Instantanés ─────────────

describe('hôte : instantanés', () => {
  /** Avance l'hôte de `steps` pas, en appelant afterStep avec un état factice ; `eventsAt` donne les événements d'un pas. */
  function stepHost(rig: TestRig, from: number, steps: number, eventsAt: (tick: number) => SimEvent[] = () => []): number {
    let tick = from;
    for (let i = 0; i < steps; i++) {
      tick++;
      rig.host.afterStep(fakeState(tick), eventsAt(tick));
    }
    return tick;
  }

  const ev = (type: string, id = 0): SimEvent => ({ type, id }) as unknown as SimEvent;

  it('un instantané tous les 3 pas (20 Hz), avec un compteur n qui croît de 1', () => {
    const { rig } = startedRig(2);
    stepHost(rig, 0, 30);
    pump(rig);
    const stats = rig.host.stats();
    expect(stats.snapshotsSent).toBe(10 * 2);
    expect(stats.snapshotsSkipped).toBe(0);
    for (const g of rig.guests) {
      const snap = g.client.takeSnapshot();
      expect(snap).toMatchObject({ n: 10, tick: 30 });
      expect(snap?.state).toEqual(fakeState(30));
      expect(g.client.stats().snapshotsReceived).toBe(10);
    }
  });

  it('aucun instantané entre deux multiples de 3 ; aucun sans invité connecté', () => {
    const { rig } = startedRig(1);
    stepHost(rig, 0, 2);
    pump(rig);
    expect(rig.guests[0].client.takeSnapshot()).toBeNull();
    stepHost(rig, 2, 1);
    pump(rig);
    expect(rig.guests[0].client.takeSnapshot()?.tick).toBe(3);
    // hors partie : afterStep sans effet
    const lobbyHost = createTestHost();
    lobbyHost.afterStep(fakeState(3), [ev('enemyHit')]);
    expect(lobbyHost.stats().snapshotsSent).toBe(0);
  });

  it('les événements des pas écoulés partent avec l\'instantané, dans l\'ordre, une seule fois', () => {
    const { rig } = startedRig(2);
    stepHost(rig, 0, 3, (t) => [ev('enemyHit', t)]); // pas 1, 2, 3
    stepHost(rig, 3, 3, (t) => [ev('enemyDied', t), ev('roomCleared', t)]); // pas 4, 5, 6
    pump(rig);
    const snap = rig.guests[0].client.takeSnapshot();
    expect(snap?.tick).toBe(6);
    // l'invité n'a pas appelé takeSnapshot entre-temps : il reçoit les événements des DEUX instantanés
    expect(snap?.events.map((e) => (e as unknown as { id: number }).id)).toEqual([1, 2, 3, 4, 4, 5, 5, 6, 6]);
    stepHost(rig, 6, 3);
    pump(rig);
    expect(rig.guests[0].client.takeSnapshot()?.events).toEqual([]); // pas de répétition
  });

  it('événements accumulés PAR invité : un invité saturé les garde jusqu\'au prochain envoi, les autres non', () => {
    const { rig } = startedRig(2);
    rig.guests[0].pair.setBufferedAmount(NET.BUFFERED_HIGH_WATER + 1);
    stepHost(rig, 0, 3, (t) => [ev('enemyHit', t)]);
    pump(rig);
    const g0 = rig.guests[0].client;
    const g1 = rig.guests[1].client;
    expect(g0.takeSnapshot()).toBeNull(); // saturé : rien envoyé
    expect(g1.takeSnapshot()?.events).toHaveLength(3);
    expect(rig.host.stats().snapshotsSkipped).toBe(1);
    // la saturation passe : l'instantané suivant porte les événements des deux périodes
    rig.guests[0].pair.setBufferedAmount(0);
    stepHost(rig, 3, 3, (t) => [ev('enemyDied', t)]);
    pump(rig);
    const late = g0.takeSnapshot();
    expect(late?.events.map((e) => e.type)).toEqual(['enemyHit', 'enemyHit', 'enemyHit', 'enemyDied', 'enemyDied', 'enemyDied']);
    expect(late?.n).toBe(2); // n compte les instantanés dus : le trou (n = 1 sauté) est visible
    expect(g1.takeSnapshot()?.n).toBe(2);
    expect(g1.stats().snapshotsReceived).toBe(2);
    expect(g0.stats().snapshotsReceived).toBe(1);
  });

  it('contre-pression : la file de messages en attente ne grossit jamais sur un canal saturé', () => {
    const { rig } = startedRig(1);
    rig.guests[0].pair.setBufferedAmount(NET.BUFFERED_HIGH_WATER * 2);
    const before = rig.guests[0].pair.pending();
    stepHost(rig, 0, 300);
    expect(rig.guests[0].pair.pending()).toBe(before);
    expect(rig.host.stats().snapshotsSkipped).toBe(100);
    expect(rig.host.stats().peers[0].bufferedAmount).toBe(NET.BUFFERED_HIGH_WATER * 2);
    // pile à la limite : on envoie encore
    rig.guests[0].pair.setBufferedAmount(NET.BUFFERED_HIGH_WATER);
    stepHost(rig, 300, 3);
    expect(rig.guests[0].pair.pending()).toBeGreaterThan(before);
  });

  it('débordement de la file d\'événements : on jette les plus anciens mais jamais ceux qui pilotent l\'interface', () => {
    const { rig } = startedRig(1);
    rig.guests[0].pair.setBufferedAmount(NET.BUFFERED_HIGH_WATER + 1);
    // un événement indispensable au début, puis un flot de jetables
    rig.host.afterStep(fakeState(1), [ev('roomEntered', 1)]);
    for (let t = 2; t <= 40 * 3; t++) rig.host.afterStep(fakeState(t), Array.from({ length: 20 }, (_, i) => ev('enemyHit', t * 100 + i)));
    rig.host.afterStep(fakeState(121), [ev('levelCompleted', 9999)]);
    rig.guests[0].pair.setBufferedAmount(0);
    for (let t = 122; t <= 123; t++) rig.host.afterStep(fakeState(t), []);
    pump(rig);
    const snap = rig.guests[0].client.takeSnapshot();
    expect(snap).not.toBeNull();
    expect(snap?.events.length).toBeLessThanOrEqual(NET.MAX_PENDING_EVENTS);
    const kinds = new Set(snap?.events.map((e) => e.type));
    for (const never of ['roomEntered', 'levelCompleted']) expect(SIM_EVENTS_NEVER_DROPPED).toContain(never);
    expect(kinds.has('roomEntered')).toBe(true);
    expect(kinds.has('levelCompleted')).toBe(true);
    // les jetables conservés sont les plus RÉCENTS
    const hits = snap?.events.filter((e) => e.type === 'enemyHit') ?? [];
    expect((hits[hits.length - 1] as unknown as { id: number }).id).toBe(120 * 100 + 19);
  });

  it('masque des joueurs connectés dans chaque instantané', () => {
    const { rig } = startedRig(2);
    stepHost(rig, 0, 3);
    pump(rig);
    expect(rig.guests[0].client.takeSnapshot()?.connectedMask).toBe(0b111);
    rig.guests[1].pair.cut('wifi');
    stepHost(rig, 3, 3);
    pump(rig);
    expect(rig.guests[0].client.takeSnapshot()?.connectedMask).toBe(0b011);
  });

  it('un état trop gros pour le protocole est sauté sans exception', () => {
    const { rig } = startedRig(1);
    const huge = { ...fakeState(3), pad: 'x'.repeat(NET.MAX_MESSAGE_CHARS) } as unknown as GameState;
    expect(() => rig.host.afterStep(huge, [])).not.toThrow();
    expect(rig.host.stats().snapshotsSkipped).toBe(1);
    pump(rig);
    expect(rig.guests[0].client.takeSnapshot()).toBeNull();
  });

  it('l\'envoi vers un canal fermé n\'explose pas', () => {
    const { rig } = startedRig(1);
    rig.guests[0].pair.a.close();
    expect(() => stepHost(rig, 0, 3)).not.toThrow();
  });

  it('un état volumineux est fragmenté et arrive entier', () => {
    const { rig } = startedRig(1);
    const big = { ...fakeState(3), pad: 'azerty"\\'.repeat(5000) } as unknown as GameState;
    rig.host.afterStep(fakeState(1), []);
    rig.host.afterStep(fakeState(2), []);
    rig.host.afterStep(big, []);
    expect(rig.guests[0].pair.pending()).toBeGreaterThan(3);
    pump(rig);
    expect(JSON.stringify(rig.guests[0].client.takeSnapshot()?.state)).toBe(JSON.stringify(big));
  });
});

// ───────────── Silence, ping, horloge ─────────────

describe('hôte : silence, ping et horloge', () => {
  it('les pings sont répondus : personne n\'est déclaré perdu tant que les invités répondent', () => {
    const rig = createRig(2);
    pump(rig);
    for (let i = 0; i < 40; i++) advance(rig, 1000);
    expect(rig.host.getLobby().slots).toHaveLength(3);
    expect(rig.guests.every((g) => g.client.phase === 'lobby')).toBe(true);
  });

  it('l\'aller-retour mesuré apparaît dans le salon (pingMs) et dans les statistiques', () => {
    const rig = createRig(1);
    pump(rig);
    // un ping part à la première période ; sa réponse arrive 40 ms plus tard
    rig.clock.advance(NET.PING_INTERVAL_MS);
    rig.host.update(rig.clock.now());
    for (const g of rig.guests) g.pair.flush(); // le ping arrive chez l'invité, son pong est mis en file
    rig.clock.advance(40);
    rig.host.update(rig.clock.now());
    for (const g of rig.guests) g.pair.flush(); // le pong arrive chez l'hôte
    expect(rig.host.stats().peers[0].pingMs).toBe(40);
    // le salon portant `pingMs` repart à la période suivante
    advance(rig, NET.PING_INTERVAL_MS);
    expect(lobbyOf(rig, 0).slots[1].pingMs).toBe(40); // la mesure diffusée à la période suivante
    expect(rig.host.getLobby().slots[1].pingMs).toBeTypeOf('number');
  });

  it('un pong invalide (numéro inconnu, horloge du futur, rejeu) est sans effet', () => {
    const host = createTestHost();
    const clock = createFakeClock();
    host.update(0);
    const g = rawGuest(host, clock);
    g.send(helloMsg());
    settleRaw(host, clock, [g]);
    clock.advance(100);
    settleRaw(host, clock, [g]); // premier ping n°1 à t = 0 (déjà envoyé à l'arrivée du premier update)
    g.send({ t: 'pong', n: 99, ts: 0 });
    g.send({ t: 'pong', n: 1, ts: 5000 });
    settleRaw(host, clock, [g]);
    expect(host.stats().peers[0].pingMs).toBeNull();
    g.send({ t: 'pong', n: 1, ts: 0 });
    settleRaw(host, clock, [g]);
    expect(host.stats().peers[0].pingMs).toBe(100);
    g.send({ t: 'pong', n: 1, ts: 50 }); // rejeu du même numéro
    settleRaw(host, clock, [g]);
    expect(host.stats().peers[0].pingMs).toBe(100);
  });

  it('silence d\'un invité en salon : retiré après PEER_TIMEOUT_MS (« lost »)', () => {
    const host = createTestHost();
    const clock = createFakeClock();
    host.update(0);
    const g = rawGuest(host, clock);
    g.send(helloMsg());
    settleRaw(host, clock, [g]);
    const events: NetPeerEvent[] = [];
    host.onPeerEvent((e) => events.push(e));
    clock.advance(NET.PEER_TIMEOUT_MS);
    settleRaw(host, clock, [g]);
    expect(events).toEqual([]);
    clock.advance(1);
    settleRaw(host, clock, [g]);
    expect(events).toEqual([{ type: 'lost', slot: 1, name: 'Brut' }]);
    expect(host.getLobby().slots).toHaveLength(1);
    expect(g.pair.a.state).toBe('closed');
  });

  it('affichage suspendu plus longtemps que PEER_TIMEOUT_MS : un message arrivé pendant la suspension compte, l\'invité n\'est pas perdu', () => {
    const host = createTestHost();
    const clock = createFakeClock();
    host.update(0);
    const g = rawGuest(host, clock);
    g.send(helloMsg());
    settleRaw(host, clock, [g]);
    const events: NetPeerEvent[] = [];
    host.onPeerEvent((e) => events.push(e));
    // la boucle de rendu (donc `update`) est suspendue 10 s ; le canal, lui, vit : un pong arrive
    clock.advance(NET.PEER_TIMEOUT_MS + 4000);
    g.send({ t: 'pong', n: 1, ts: 0 });
    g.pair.flush();
    host.update(clock.now());
    expect(events).toEqual([]);
    expect(host.getLobby().slots).toHaveLength(2);
    // le silence réel, lui, est toujours détecté
    clock.advance(NET.PEER_TIMEOUT_MS + 1);
    host.update(clock.now());
    expect(events).toEqual([{ type: 'lost', slot: 1, name: 'Brut' }]);
  });

  it('silence en partie : l\'invité est déclaré perdu, joueur immobile, partie continue', () => {
    const { rig } = startedRig(2);
    // l'invité 0 ne répond plus : on le « gèle » en ne le mettant plus à jour ni en livrant ses messages
    rig.clock.advance(AFTER_TIMEOUT_MS);
    rig.host.update(rig.clock.now());
    rig.guests[1].client.update(rig.clock.now());
    // (les deux invités sont silencieux ici : aucun pong livré)
    expect(rig.host.connectedMask()).toBe(0b001);
    expect(rig.host.phase).toBe('playing');
    expect(rig.host.pollRemoteInputs()[1]).toEqual(frameOf());
    expect(rig.host.pollRemoteInputs()[2]).toEqual(frameOf());
  });

  it('le premier update rebase les horodatages : une horloge qui démarre très haut ne fait rien expirer', () => {
    const host = createTestHost();
    const clock = createFakeClock();
    const g = rawGuest(host, clock);
    g.send(helloMsg());
    g.pair.flush(); // le hello est traité AVANT tout update (horodatages posés à 0)
    expect(host.getLobby().slots).toHaveLength(2);
    clock.set(987_654_321);
    host.update(clock.now());
    expect(host.getLobby().slots).toHaveLength(2);
    expect(g.pair.a.state).toBe('open');
  });

  it('update avec une horloge non finie est ignoré', () => {
    const host = createTestHost();
    expect(() => host.update(Number.NaN)).not.toThrow();
    expect(() => host.update(Number.POSITIVE_INFINITY)).not.toThrow();
  });
});

// ───────────── Fin de partie, fermeture ─────────────

describe('hôte : fin de partie et fermeture', () => {
  it('endGame : end envoyé à tous, retour au salon, choix remis à « pas prêt », mêmes personnages', () => {
    const { rig } = startedRig(2);
    const reasons: string[] = [];
    rig.guests.forEach((g) => g.client.onEnd((r) => reasons.push(r)));
    rig.host.endGame('hostQuit');
    expect(rig.host.phase).toBe('lobby');
    pump(rig);
    expect(reasons).toEqual(['hostQuit', 'hostQuit']);
    expect(rig.guests.every((g) => g.client.phase === 'lobby')).toBe(true);
    const lobby = rig.host.getLobby();
    expect(lobby.slots.every((s) => !s.ready)).toBe(true);
    expect(lobby.slots.map((s) => s.characterId)).toEqual(['david', 'sandrine', 'romain']);
    expect(lobby.levelIndex).toBe(0);
    expect(lobbyOf(rig, 0)).toEqual(lobby);
    expect(rig.guests[0].client.slot).toBe(1); // l'emplacement de salon est rétabli par le salon rediffusé
  });

  it('après « levelCompleted » le niveau suivant est présélectionné (borné au dernier)', () => {
    const { rig } = startedRig(1);
    rig.host.endGame('levelCompleted');
    expect(rig.host.getLobby().levelIndex).toBe(1);
    pump(rig);
    readyAll(rig);
    rig.host.setLevel(TEST_LEVEL_COUNT - 1);
    readyAll(rig);
    rig.host.startGame(1);
    rig.host.endGame('levelCompleted');
    expect(rig.host.getLobby().levelIndex).toBe(TEST_LEVEL_COUNT - 1);
  });

  it('endGame hors partie : sans effet', () => {
    const rig = createRig(1);
    pump(rig);
    const seq = rig.host.getLobby().seq;
    rig.host.endGame('aborted');
    expect(rig.host.getLobby().seq).toBe(seq);
    expect(rig.host.phase).toBe('lobby');
  });

  it('un invité perdu pendant la partie est retiré du salon au retour ; les autres rejouent avec les mêmes liaisons', () => {
    const { rig } = startedRig(2);
    rig.guests[0].pair.cut('wifi');
    rig.host.endGame('aborted');
    pump(rig);
    expect(rig.host.getLobby().slots.map((s) => s.slot)).toEqual([0, 2]);
    expect(rig.host.checkStart()).toEqual({ ok: false, reason: 'notReady' });
    rig.host.setLocalChoice({ characterId: 'david', ready: true });
    rig.guests[1].client.sendChoice({ characterId: 'romain', difficulty: 2, ready: true });
    pump(rig);
    const again = rig.host.startGame(4);
    pump(rig);
    expect(again?.players.map((p) => p.id)).toEqual([0, 1]);
    expect(rig.guests[1].client.slot).toBe(1);
    expect(rig.guests[1].client.phase).toBe('playing');
  });

  it('les entrées d\'une partie précédente ne passent pas dans la suivante (gid différent)', () => {
    const { rig, info } = startedRig(1, 5);
    const oldGid = info.gameId;
    rig.host.endGame('aborted');
    pump(rig);
    readyAll(rig);
    const second = rig.host.startGame(5);
    pump(rig);
    expect(second?.gameId).not.toBe(oldGid);
    rig.guests[0].pair.b.send(JSON.stringify({ t: 'input', gid: oldGid, seq: 1, x: 100, y: 0, b: 1 }));
    pump(rig);
    expect(rig.host.pollRemoteInputs()[1]).toEqual(frameOf());
    rig.guests[0].client.sendInput(frameOf({ moveX: 1 }), rig.clock.now());
    pump(rig);
    expect(rig.host.pollRemoteInputs()[1]?.moveX).toBe(1);
  });

  it('close : leave aux invités (hostLeft), liaisons fermées, idempotent, plus de réaction ensuite', () => {
    const rig = createRig(2);
    pump(rig);
    const closed: string[] = [];
    rig.guests.forEach((g) => g.client.onClosed((i) => closed.push(i.reason)));
    rig.host.close();
    rig.host.close();
    expect(rig.host.phase).toBe('closed');
    pump(rig);
    expect(closed).toEqual(['hostLeft', 'hostLeft']);
    expect(rig.guests.every((g) => g.pair.a.state === 'closed' && g.pair.b.state === 'closed')).toBe(true);
    // une session fermée ne fait plus rien
    rig.host.update(rig.clock.now() + 99999);
    rig.host.setLevel(3);
    rig.host.setLocalChoice({ characterId: 'mira' });
    expect(rig.host.startGame(1)).toBeNull();
    expect(rig.host.pollRemoteInputs()).toEqual({});
    const late = createLoopbackPair();
    rig.host.addGuest(late.a);
    expect(late.a.state).toBe('closed');
  });

  it('close en pleine partie : les invités reçoivent hostLeft', () => {
    const { rig } = startedRig(1);
    const closed: string[] = [];
    rig.guests[0].client.onClosed((i) => closed.push(i.reason));
    rig.host.close();
    pump(rig);
    expect(closed).toEqual(['hostLeft']);
  });

  it('les abonnés qui lèvent une exception ne cassent pas la session', () => {
    const rig = createRig(1);
    rig.host.onLobby(() => {
      throw new Error('abonné bogué');
    });
    rig.host.onPeerEvent(() => {
      throw new Error('abonné bogué');
    });
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...a: unknown[]): void => void errors.push(a);
    try {
      expect(() => pump(rig)).not.toThrow();
      expect(rig.guests[0].client.phase).toBe('lobby');
    } finally {
      console.error = original;
    }
    expect(errors.length).toBeGreaterThan(0);
  });

  it('désabonnement : plus de rappel', () => {
    const rig = createRig(1);
    const got: number[] = [];
    const off = rig.host.onLobby((l) => got.push(l.seq));
    pump(rig);
    off();
    rig.host.setLevel(2);
    expect(got).toHaveLength(1);
  });

  it('packFrame / unpackFrame : les boutons du fil correspondent à FRAME_BIT', () => {
    expect(packFrame(frameOf({ attack: true, heart: true })).b).toBe(FRAME_BIT.attack | FRAME_BIT.heart);
  });
});
