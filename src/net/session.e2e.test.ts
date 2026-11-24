/**
 * Bout en bout sur Loopback : un hôte avec une VRAIE `GameSimulation` (60 Hz, entrées scriptées) et trois invités.
 * Les invités reçoivent des instantanés COHÉRENTS (état identique, au caractère près, à celui de l'hôte au même pas ; fragmenté au besoin),
 * tous les événements, et leurs entrées arrivent à la bonne frame, sur le bon joueur.
 */
import { describe, expect, it } from 'vitest';
import { SIM_STEP_MS } from '../core/constants';
import { createSimulation, type GameSimulation } from '../core/simulation';
import type { ActionFrame, GameState, PlayerId, SimEvent } from '../core/types';
import { modeSimFlags } from '../entities/loopLogic';
import { emptyFrame } from '../input/mapping';
import { getLevelByIndex } from '../levels';
import { NET, type NetStartInfo } from './contracts';
import { connectGuest, createFakeClock, createRig, createTestHost, pump, readyAll, type TestRig } from './netTestKit';

interface Game {
  rig: TestRig;
  info: NetStartInfo;
  sim: GameSimulation;
  /** JSON de l'état de l'hôte à chaque pas (clé = tick) pour les pas où un instantané est dû. */
  stateAt: Map<number, string>;
  /** Tous les événements de l'hôte depuis le début, dans l'ordre. */
  hostEvents: SimEvent[];
  /** Événements reçus par chaque invité. */
  guestEvents: SimEvent[][];
  /** Instantanés reçus par chaque invité (n, tick, JSON de l'état). */
  received: { n: number; tick: number; json: string; mask: number }[][];
  maxPending: number;
  maxStateChars: number;
}

function frame(over: Partial<ActionFrame> = {}): ActionFrame {
  return { ...emptyFrame(), special: false, call: false, heart: false, ...over };
}

function startGame(guests: number, levelIndex: number, roomOf?: (ids: string[]) => string, seed = 2026): Game {
  const rig = createRig(guests);
  pump(rig);
  rig.host.setLevel(levelIndex);
  readyAll(rig);
  const info = rig.host.startGame(seed);
  if (!info) throw new Error('startGame refusé');
  pump(rig);
  const level = getLevelByIndex(info.levelIndex);
  if (!level) throw new Error('niveau inconnu');
  const startRoomIndex = roomOf ? level.rooms.findIndex((r) => r.id === roomOf(level.rooms.map((x) => x.id))) : 0;
  const sim = createSimulation(
    {
      levelId: level.id,
      players: info.players.map((p) => ({ id: p.id, characterId: p.characterId, difficulty: p.difficulty })),
      seed: info.seed,
      startRoomIndex: Math.max(0, startRoomIndex),
      ...modeSimFlags({ tutorial: false, demo: false }),
    },
    level,
  );
  return {
    rig,
    info,
    sim,
    stateAt: new Map(),
    hostEvents: [],
    guestEvents: rig.guests.map(() => []),
    received: rig.guests.map(() => []),
    maxPending: 0,
    maxStateChars: 0,
  };
}

/**
 * Une frame de rendu à 60 Hz = un pas : entrées des invités → livraison → pas de l'hôte → instantané → livraison → lecture côté invité.
 * `scripts[i]` donne la frame locale de l'invité i (et `host` celle de l'hôte) en fonction du numéro de pas.
 */
function runFrames(g: Game, frames: number, scripts: ((k: number) => ActionFrame)[], host: (k: number) => ActionFrame = () => frame()): void {
  const { rig, sim } = g;
  for (let k = 0; k < frames; k++) {
    rig.clock.advance(SIM_STEP_MS);
    const now = rig.clock.now();
    rig.host.update(now);
    rig.guests.forEach((gu, i) => {
      gu.client.update(now);
      gu.client.sendInput(scripts[i]?.(k) ?? frame(), now);
    });
    for (const gu of rig.guests) gu.pair.flush(); // les entrées arrivent chez l'hôte
    const inputs = { ...rig.host.pollRemoteInputs(), 0: host(k) };
    const events = sim.step(SIM_STEP_MS, inputs);
    g.hostEvents.push(...events);
    rig.host.afterStep(sim.state, events);
    if (sim.state.tick % NET.SNAPSHOT_EVERY_TICKS === 0) {
      const json = JSON.stringify(sim.state);
      g.stateAt.set(sim.state.tick, json);
      g.maxStateChars = Math.max(g.maxStateChars, json.length);
    }
    g.maxPending = Math.max(g.maxPending, ...rig.guests.map((x) => x.pair.pending()));
    for (const gu of rig.guests) gu.pair.flush(); // les instantanés (fragments compris) arrivent chez les invités
    rig.guests.forEach((gu, i) => {
      const snap = gu.client.takeSnapshot();
      if (!snap) return;
      g.received[i].push({ n: snap.n, tick: snap.tick, json: JSON.stringify(snap.state), mask: snap.connectedMask });
      g.guestEvents[i].push(...snap.events);
    });
  }
}

describe('bout en bout : hôte + 3 invités sur Loopback (vraie simulation)', () => {
  it('les invités reçoivent des instantanés identiques à l\'état de l\'hôte, tous les événements, à 20 Hz', () => {
    const g = startGame(3, 3, undefined, 7);
    const level = getLevelByIndex(3);
    expect(level).toBeDefined();
    const script = (i: number) => (k: number): ActionFrame =>
      frame({ moveX: Math.cos((k + i * 40) / 25), moveY: Math.sin((k + i * 40) / 25), attack: (k + i * 10) % 17 < 9, special: k % 211 === 0 });
    runFrames(g, 900, [script(1), script(2), script(3)], (k) => frame({ moveX: Math.sin(k / 30), moveY: Math.cos(k / 30), attack: k % 9 < 5 }));

    expect(g.sim.state.tick).toBe(900);
    for (let i = 0; i < 3; i++) {
      const got = g.received[i];
      expect(got.length).toBe(300); // 900 pas / 3 = 300 instantanés, aucun perdu
      // numérotation et ticks croissants
      got.forEach((s, k) => {
        expect(s.n).toBe(k + 1);
        expect(s.tick).toBe((k + 1) * 3);
        // état identique, au caractère près, à celui de l'hôte à ce pas
        expect(s.json).toBe(g.stateAt.get(s.tick));
        expect(s.mask).toBe(0b1111);
      });
      // aucun événement perdu ni dupliqué, même ordre
      expect(g.guestEvents[i].map((e) => JSON.stringify(e))).toEqual(g.hostEvents.map((e) => JSON.stringify(e)));
    }
    expect(g.hostEvents.length).toBeGreaterThan(20); // on a bien joué quelque chose
    expect(g.rig.host.stats().snapshotsSent).toBe(900);
    expect(g.rig.host.stats().snapshotsSkipped).toBe(0);
    expect(g.rig.guests.every((x) => x.client.stats().malformed === 0)).toBe(true);
  });

  it('un grand état (salle chargée, 4 joueurs) est fragmenté en plusieurs messages et arrive intact', () => {
    const g = startGame(3, 4, () => 'emberhold', 99);
    const attackAll = () => frame({ attack: true, moveX: 0.3 });
    runFrames(g, 600, [attackAll, attackAll, attackAll], () => frame({ attack: true }));
    expect(g.maxStateChars).toBeGreaterThan(NET.FRAGMENT_CHARS); // l'état dépasse un fragment
    expect(g.maxPending).toBeGreaterThan(1); // ...donc plusieurs messages en file dans une même frame
    for (let i = 0; i < 3; i++) {
      expect(g.received[i].length).toBe(200);
      for (const s of g.received[i]) expect(s.json).toBe(g.stateAt.get(s.tick));
    }
  });

  it('les entrées de chaque invité arrivent au bon joueur et à la bonne frame', () => {
    const g = startGame(3, 0, undefined, 5);
    const start = g.sim.state.players.map((p) => ({ x: p.pos.x, y: p.pos.y }));
    // invité 1 (joueur 1) : à droite ; invité 2 (joueur 2) : en bas ; invité 3 (joueur 3) : immobile
    runFrames(g, 30, [() => frame({ moveX: 1 }), () => frame({ moveY: 1 }), () => frame()]);
    const now = g.sim.state.players;
    expect(now[1].pos.x).toBeGreaterThan(start[1].x + 10);
    expect(Math.abs(now[1].pos.y - start[1].y)).toBeLessThan(1);
    expect(now[2].pos.y).toBeGreaterThan(start[2].y + 10);
    expect(Math.abs(now[2].pos.x - start[2].x)).toBeLessThan(1);
    expect(now[3].pos.x).toBeCloseTo(start[3].x, 5);
    expect(now[3].pos.y).toBeCloseTo(start[3].y, 5);
  });

  it('une entrée envoyée à la frame k est prise en compte au pas de la frame k (sans retard réseau) ou k+1 (un tour de retard)', () => {
    for (const latency of [0, 1]) {
      // l'invité est relié par une paire à retard (latencyFlushes)
      const clock = createFakeClock();
      const host = createTestHost();
      const gu = connectGuest(host, { name: 'G', loopback: { latencyFlushes: latency } });
      const r: TestRig = { clock, host, guests: [gu] };
      pump(r);
      readyAll(r);
      const info = host.startGame(1);
      expect(info).not.toBeNull();
      for (let i = 0; i < 6; i++) {
        r.clock.advance(1);
        host.update(r.clock.now());
        gu.client.update(r.clock.now());
        gu.pair.flush();
      }
      // frame k : l'invité appuie sur « attaque »
      const seenAt: boolean[] = [];
      for (let k = 0; k < 6; k++) {
        r.clock.advance(SIM_STEP_MS * 3); // un envoi à chaque frame (cadence 33 ms ≥ 3 pas)
        const now = r.clock.now();
        host.update(now);
        gu.client.update(now);
        gu.client.sendInput(frame({ attack: k === 2 }), now);
        gu.pair.flush();
        seenAt.push(host.pollRemoteInputs()[1]?.attack === true);
      }
      expect(seenAt.indexOf(true)).toBe(2 + latency);
      expect(seenAt.filter(Boolean)).toHaveLength(1);
    }
  });

  it('un invité qui se déconnecte en cours de partie : sa frame devient vide, les autres continuent de recevoir des instantanés cohérents', () => {
    const g = startGame(3, 0, undefined, 11);
    runFrames(g, 120, [() => frame({ moveX: 1 }), () => frame({ moveX: -1 }), () => frame({ moveY: 1 })]);
    const before = g.sim.state.players[2].pos.x;
    g.rig.guests[1].pair.cut('wifi'); // joueur 2 perdu
    runFrames(g, 120, [() => frame({ moveX: 1 }), () => frame({ moveX: -1 }), () => frame({ moveY: 1 })]);
    // le joueur 2 s'est arrêté (frame vide) mais reste dans la simulation
    expect(g.sim.state.players).toHaveLength(4);
    expect(Math.abs(g.sim.state.players[2].pos.x - before)).toBeLessThan(40); // glisse au plus un peu (impulsions éventuelles), ne marche plus
    expect(g.rig.host.connectedMask()).toBe(0b1011);
    const last = g.received[0][g.received[0].length - 1];
    expect(last.mask).toBe(0b1011);
    expect(last.json).toBe(g.stateAt.get(last.tick));
    expect(g.received[2][g.received[2].length - 1].json).toBe(g.stateAt.get(last.tick));
    expect(g.received[1].length).toBeLessThan(g.received[0].length); // l'invité coupé n'a plus rien reçu
  });

  it('la contre-pression dégrade en douceur : instantanés sautés, état reçu toujours cohérent, événements jamais perdus', () => {
    const g = startGame(3, 0, undefined, 3);
    const script = () => frame({ attack: true, moveX: 0.5 });
    runFrames(g, 120, [script, script, script], () => frame({ attack: true }));
    // l'invité 0 est saturé pendant 2 s
    g.rig.guests[0].pair.setBufferedAmount(NET.BUFFERED_HIGH_WATER * 2);
    const sentBefore = g.received[0].length;
    runFrames(g, 120, [script, script, script], () => frame({ attack: true }));
    expect(g.received[0].length).toBe(sentBefore); // rien reçu pendant la saturation
    g.rig.guests[0].pair.setBufferedAmount(0);
    runFrames(g, 120, [script, script, script], () => frame({ attack: true }));
    const got = g.received[0];
    expect(got.length).toBe(sentBefore + 40);
    // le premier instantané après la saturation montre un trou de numérotation
    expect(got[sentBefore].n - got[sentBefore - 1].n).toBe(41);
    for (const s of got) expect(s.json).toBe(g.stateAt.get(s.tick));
    // les événements de la période saturée sont arrivés (aucun perdu par rapport à l'hôte)
    expect(g.guestEvents[0].map((e) => JSON.stringify(e))).toEqual(g.hostEvents.map((e) => JSON.stringify(e)));
    // les autres invités n'ont pas été gênés
    expect(g.received[1].length).toBe(120);
  });

  it('fin de partie puis nouvelle partie : les mêmes liaisons rejouent, instantanés de la partie suivante seulement', () => {
    const g = startGame(2, 0, undefined, 21);
    runFrames(g, 30, [() => frame(), () => frame()]);
    const firstGid = g.info.gameId;
    g.rig.host.endGame('levelCompleted');
    pump(g.rig);
    expect(g.rig.guests.every((x) => x.client.phase === 'lobby')).toBe(true);
    expect(g.rig.host.getLobby().levelIndex).toBe(1);
    readyAll(g.rig);
    const second = g.rig.host.startGame(21);
    pump(g.rig);
    expect(second?.gameId).not.toBe(firstGid);
    expect(g.rig.guests.every((x) => x.client.phase === 'playing' && x.client.gameId === second?.gameId)).toBe(true);
    // un instantané tardif de la première partie ne passe pas
    g.rig.host.afterStep({ version: 1, levelId: 'x', tick: 3 } as unknown as GameState, []);
    pump(g.rig);
    expect(g.rig.guests[0].client.takeSnapshot()?.tick).toBe(3);
  });

  it('identifiants de joueurs : l\'invité i joue le joueur i et reçoit son identifiant de jeu au lancement', () => {
    const g = startGame(3, 0, undefined, 1);
    const ids = g.rig.guests.map((x) => x.client.slot);
    expect(ids).toEqual([1, 2, 3] satisfies PlayerId[]);
    expect(g.info.players.map((p) => p.characterId)).toEqual(['david', 'sandrine', 'romain', 'valentine']);
  });
});

