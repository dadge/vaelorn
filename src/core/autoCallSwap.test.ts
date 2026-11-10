/**
 * APPEL APRÈS ÉCHANGE D'ACCESSOIRE : un joueur qui ÉCHANGE à la main (bouton A) un accessoire d'une autre sorte pose l'ancien à ses pieds (verrou 'leave') et un appel automatique part avec
 * l'icône de l'objet posé, aux mêmes conditions que pour un objet refusé (alliés vivants pour qui l'objet serait utile, mêmes délais, un déclenchement par couple joueur / objet).
 * Pas d'appel à l'éparpillement de l'équipement d'une chute (verrou 'life'), ni quand la chute dépose un cœur.
 * Aucune horloge réelle : tout passe par des pas fixes.
 */
import { describe, expect, it } from 'vitest';
import { gearLeftBy, stepAutoCalls } from './autoCall';
import { AUTO_CALL_COOLDOWN_MS, AUTO_CALL_DURATION_MS, GEAR_PICKUP_RADIUS, GEAR_TTL_MS } from './balance';
import { SIM_STEP_MS } from './constants';
import { gearIconFrameOf } from '../render/gearFx';
import { makeTestLayout, makeTestLevel, makeTestRoom } from './levelValidation';
import { createPlayerState, stepPlayerTimers, startCall } from './players';
import { createSimulation, GameSimulation } from './simulation';
import type { AccessoryKind, ActionFrame, CharacterId, GearDropState, GearItem, LevelDef, PlayerId, SimEvent, TickInputs } from './types';

const DT = SIM_STEP_MS;

function arena(): LevelDef {
  return makeTestLevel({
    rooms: [
      makeTestRoom({
        id: 'r1',
        layout: makeTestLayout(30, 20),
        playerSpawns: [[5, 5], [6, 5], [5, 6], [6, 6]],
        mechanisms: [],
        exit: { rect: { x: 27, y: 17, w: 2, h: 2 }, requires: [] },
      }),
      makeTestRoom({ id: 'r2', exit: { rect: { x: 9, y: 5, w: 2, h: 2 }, requires: [], final: true } }),
    ],
    objectives: [0, 1, 2, 3].map((slot) => ({ id: `o${slot}`, slot, roomId: 'r1', kind: 'kills' as const, labelKey: `objective.test.o${slot}`, count: 99 })),
  });
}

const CHARS: readonly CharacterId[] = ['david', 'mira', 'brokk', 'sandrine'];

function makeSim(n: number, opts: { autoCall?: boolean; seed?: number } = {}): GameSimulation {
  return createSimulation(
    {
      levelId: 'test',
      seed: opts.seed ?? 7,
      loot: false,
      gear: true,
      autoCall: opts.autoCall,
      heartSlot: true,
      players: Array.from({ length: n }, (_, i) => ({ id: i as PlayerId, characterId: CHARS[i], difficulty: 2 as const })),
    },
    arena(),
  );
}

const frame = (over: Partial<ActionFrame> = {}): ActionFrame => ({ moveX: 0, moveY: 0, attack: false, interact: false, revive: false, ...over });

function stepN(s: GameSimulation, n: number, inputs: TickInputs | ((i: number) => TickInputs) = {}): SimEvent[] {
  const all: SimEvent[] = [];
  for (let i = 0; i < n; i++) all.push(...s.step(DT, typeof inputs === 'function' ? inputs(i) : inputs));
  return all;
}

const acc = (kind: AccessoryKind, level: 1 | 2 | 3 = 1): GearItem => ({ slot: 'accessory', level, accessory: kind });

function putDrop(s: GameSimulation, item: GearItem, x: number, y: number): GearDropState {
  const id = s.state.nextGearDropId ?? 1;
  s.state.nextGearDropId = id + 1;
  const d: GearDropState = { id, item, pos: { x, y }, ttlMs: GEAR_TTL_MS, lockedFor: null, lockMode: 'life' };
  (s.state.room.gearDrops as GearDropState[]).push(d);
  return d;
}

const autoEvents = (ev: readonly SimEvent[]): Extract<SimEvent, { type: 'autoCallStarted' }>[] =>
  ev.filter((e): e is Extract<SimEvent, { type: 'autoCallStarted' }> => e.type === 'autoCallStarted');

/**
 * Scénario d'échange : le joueur 0 porte une lanterne et se tient sur un aimant posé au sol ; les alliés sont loin. Retourne la simulation après l'appui sur A (un pas).
 */
function swapScenario(n = 2, setup?: (s: GameSimulation) => void): { s: GameSimulation; events: SimEvent[]; old: GearItem } {
  const s = makeSim(n);
  stepN(s, 1);
  s.state.players.forEach((p, i) => (p.pos = { x: 100 + i * 150, y: 100 + i * 80 }));
  const p0 = s.state.players[0];
  p0.pos = { x: 100, y: 100 };
  p0.loadout.accessory = { kind: 'lantern', level: 1 };
  putDrop(s, acc('magnet'), 100, 100);
  setup?.(s);
  const events = stepN(s, 1, { 0: frame({ interact: true }) });
  return { s, events, old: acc('lantern') };
}

describe('échange manuel : appel avec l icône de l ancien accessoire', () => {
  it("l'ancien est posé aux pieds (verrou 'leave'), le nouveau équipé, et l'appel part dans le même pas avec le symbole de l'ancien objet", () => {
    const { s, events, old } = swapScenario();
    const p0 = s.state.players[0];
    expect(events.some((e) => e.type === 'gearSwapped' && e.playerId === 0)).toBe(true);
    expect(p0.loadout.accessory).toEqual({ kind: 'magnet', level: 1 });
    const dropped = (s.state.room.gearDrops as GearDropState[]).find((d) => d.item.accessory === 'lantern');
    expect(dropped).toBeDefined();
    expect(dropped!.lockedFor).toBe(0);
    expect(dropped!.lockMode).toBe('leave');
    const calls = autoEvents(events);
    expect(calls).toEqual([{ type: 'autoCallStarted', playerId: 0, icon: 'gear', to: [1] }]);
    expect(p0.autoCall).toEqual({ icon: 'gear', ref: `g${dropped!.id}`, ms: AUTO_CALL_DURATION_MS, to: [1], item: old });
    expect(gearIconFrameOf(p0.autoCall!.item!)).toBe('gear_icon_accessory_lantern_1'); // l'icône de l'objet POSÉ (l'ancien), pas du nouveau
  });

  it("même règles que l'objet refusé : sans gel, sans toucher à l'appel manuel, délai de 4 s propre au joueur, durée 3 s", () => {
    const { s } = swapScenario();
    const p0 = s.state.players[0];
    expect(p0.callMs).toBe(0);
    expect(p0.callCooldownMs).toBe(0);
    expect(p0.autoCallCooldownMs).toBeGreaterThan(AUTO_CALL_COOLDOWN_MS - 100);
    const x0 = p0.pos.x;
    stepN(s, 30, { 0: frame({ moveX: 1 }) }); // il marche pendant le signal (donc il quitte l'objet : le verrou tombe, aucun nouvel appel)
    expect(p0.pos.x).toBeGreaterThan(x0 + 10);
    stepN(s, 160);
    expect(p0.autoCall).toBeUndefined();
  });

  it('destinataires : alliés VIVANTS pour qui l objet posé est utile (équiper / améliorer) ; pas ceux qui portent un accessoire d une autre sorte (échange) ni le même en mieux', () => {
    const { events } = swapScenario(4, (s) => {
      const [, a1, a2, a3] = s.state.players;
      a1.loadout.accessory = null; // sans accessoire : « équiper »
      a2.loadout.accessory = { kind: 'magnet', level: 1 }; // une autre sorte : « échange » manuel, pas utile
      a3.loadout.accessory = { kind: 'lantern', level: 3 }; // la même en mieux : « ignorer »
    });
    expect(autoEvents(events)[0].to).toEqual([1]);
  });

  it('aucun allié utile = aucun appel (ni à terre, ni mieux équipé, ni autre sorte) ; solo : aucun appel', () => {
    const noUse = swapScenario(2, (s) => (s.state.players[1].loadout.accessory = { kind: 'magnet', level: 1 }));
    expect(autoEvents(noUse.events)).toEqual([]);
    expect(noUse.s.state.players[0].autoCall).toBeUndefined();
    const better = swapScenario(2, (s) => (s.state.players[1].loadout.accessory = { kind: 'lantern', level: 2 }));
    expect(autoEvents(better.events)).toEqual([]);
    const down = swapScenario(2, (s) => s.knockDown(1));
    expect(autoEvents(down.events)).toEqual([]);
    const solo = swapScenario(1);
    expect(autoEvents(solo.events)).toEqual([]);
    expect(solo.s.state.players[0].loadout.accessory).toEqual({ kind: 'magnet', level: 1 }); // l'échange a bien eu lieu
  });

  it('améliorer : un allié qui porte la même sorte à un niveau inférieur reçoit l appel', () => {
    const s = makeSim(2);
    stepN(s, 1);
    s.state.players[1].pos = { x: 300, y: 200 };
    const p0 = s.state.players[0];
    p0.pos = { x: 100, y: 100 };
    p0.loadout.accessory = { kind: 'lantern', level: 2 };
    s.state.players[1].loadout.accessory = { kind: 'lantern', level: 1 };
    putDrop(s, acc('magnet'), 100, 100);
    const ev = stepN(s, 1, { 0: frame({ interact: true }) });
    expect(autoEvents(ev)).toEqual([{ type: 'autoCallStarted', playerId: 0, icon: 'gear', to: [1] }]);
  });

  it('un seul déclenchement tant que le joueur reste dessus ; sorti puis revenu, plus rien (le verrou est levé, la décision vaut « échange »)', () => {
    const { s } = swapScenario();
    expect(autoEvents(stepN(s, 60 * 8))).toEqual([]); // reste sur l'ancien objet : pas de re-déclenchement
    const p0 = s.state.players[0];
    p0.pos = { x: 220, y: 100 };
    stepN(s, 30);
    p0.pos = { x: 100, y: 100 };
    expect(autoEvents(stepN(s, 60 * 6))).toEqual([]);
  });

  it('l allié prévenu peut prendre l ancien objet (équipé automatiquement) : le signal s arrête avec l objet', () => {
    const { s } = swapScenario();
    const p0 = s.state.players[0];
    const p1 = s.state.players[1];
    expect(p0.autoCall).toBeDefined();
    p1.pos = { x: 102, y: 100 };
    stepN(s, 2);
    expect(p1.loadout.accessory).toEqual({ kind: 'lantern', level: 1 });
    expect(p0.autoCall).toBeUndefined();
  });
});

describe('le verrou et l anti-spam ne bloquent pas l appel à tort', () => {
  it('gearLeftBy : verrou \'leave\' pour ce joueur vivant seulement (pas \'life\', pas un autre joueur, pas à terre)', () => {
    const a = createPlayerState({ id: 0, characterId: 'david', difficulty: 2 }, { x: 0, y: 0 });
    expect(gearLeftBy(a, { lockedFor: 0, lockMode: 'leave' })).toBe(true);
    expect(gearLeftBy(a, { lockedFor: 0, lockMode: 'life' })).toBe(false);
    expect(gearLeftBy(a, { lockedFor: 1, lockMode: 'leave' })).toBe(false);
    expect(gearLeftBy(a, { lockedFor: null, lockMode: 'leave' })).toBe(false);
    expect(gearLeftBy({ ...a, status: 'down' }, { lockedFor: 0, lockMode: 'leave' })).toBe(false);
  });

  it("un objet déjà signalé auparavant (anti-doublon) ne bloque pas le nouvel objet posé par l'échange (autre référence) ; le délai de récupération du joueur ne le retarde PAS : l'appel part dans le même pas", () => {
    const { s, events } = swapScenario(2, (st) => {
      const p0 = st.state.players[0];
      p0.autoCallSeen = ['g99'];
      p0.autoCallCooldownMs = 2500; // un appel d'objet vient de partir : délai en cours
    });
    const p0 = s.state.players[0];
    const ev = autoEvents(events);
    expect(ev).toHaveLength(1);
    expect(ev[0].icon).toBe('gear');
    expect(p0.autoCall?.icon).toBe('gear');
    expect(p0.autoCallSeen).toEqual([p0.autoCall!.ref]); // 'g99' n'existe plus au sol : oublié par le ré-armement
  });

  it("le joueur qui s'éloigne tout de suite après l'échange, en plein délai de récupération (4 s), a bien prévenu : l'appel est parti à l'instant du geste (il n'est plus perdu)", () => {
    const { s, events } = swapScenario(2, (st) => (st.state.players[0].autoCallCooldownMs = 3500));
    expect(autoEvents(events)).toHaveLength(1);
    const p0 = s.state.players[0];
    p0.pos = { x: 100 + GEAR_PICKUP_RADIUS + 30, y: 100 };
    stepN(s, 30);
    expect(p0.autoCall?.icon).toBe('gear'); // toujours montré aux alliés pendant ses 3 s
  });

  it("l'appel après échange REMPLACE un signal d'objet encore en cours (il est le plus récent) ; la référence de l'objet remplacé est oubliée pour qu'il puisse repartir", () => {
    const { s, events } = swapScenario(2, (st) => {
      const p0 = st.state.players[0];
      p0.autoCall = { icon: 'heart', ref: 'p7', ms: 1500, to: [1] };
      p0.autoCallSeen = ['p7'];
      p0.autoCallCooldownMs = 2500;
    });
    const p0 = s.state.players[0];
    expect(autoEvents(events)).toHaveLength(1);
    expect(p0.autoCall?.icon).toBe('gear');
    expect(p0.autoCallSeen).toEqual([p0.autoCall!.ref]); // 'p7' oublié
  });

  it("une croix en cours n'est jamais remplacée par l'appel de l'échange (plus urgente) : il part dès qu'elle est finie si le joueur est toujours sur l'objet", () => {
    const { s, events } = swapScenario(2, (st) => {
      const p0 = st.state.players[0];
      st.state.players[1].heart = 'full';
      p0.hp = p0.maxHp * 0.2;
    });
    const p0 = s.state.players[0];
    expect(events.some((e) => e.type === 'gearSwapped')).toBe(true);
    expect(p0.autoCall?.icon).toBe('cross');
    const ev = autoEvents(stepN(s, Math.ceil(3200 / DT)));
    expect(ev.map((e) => e.icon)).toEqual(['gear']);
  });

  it('un appel manuel en cours n est jamais interrompu : l appel de l échange part à sa fin si le joueur est toujours sur l objet', () => {
    // un appel manuel qui touche à sa fin (1,5 s restantes : le joueur n'est plus immobilisé, il peut échanger) ; l'appel de l'échange attend la fin du signal manuel
    const { s, events } = swapScenario(2, (st) => {
      startCall(st.state.players[0]);
      st.state.players[0].callMs = 1500;
    });
    const p0 = s.state.players[0];
    expect(events.some((e) => e.type === 'gearSwapped')).toBe(true);
    expect(autoEvents(events)).toEqual([]);
    expect(p0.autoCall).toBeUndefined();
    expect(p0.callMs).toBeGreaterThan(0);
    expect(autoEvents(stepN(s, Math.ceil(1600 / DT)))).toHaveLength(1);
  });

  it("écart accepté (TODO.md) : pendant un appel manuel en cours, un joueur qui quitte le rayon avant sa fin ne déclenche rien (verrou levé : aucun objet laissé)", () => {
    const { s } = swapScenario(2, (st) => {
      startCall(st.state.players[0]);
      st.state.players[0].callMs = 1500;
    });
    s.state.players[0].pos = { x: 100 + GEAR_PICKUP_RADIUS + 3, y: 100 };
    expect(autoEvents(stepN(s, Math.ceil(3200 / DT)))).toEqual([]);
  });

  it('pure : stepAutoCalls avec un objet verrouillé \'leave\' pour le joueur déclenche ; verrouillé \'life\' ne déclenche pas', () => {
    const a = createPlayerState({ id: 0, characterId: 'david', difficulty: 2 }, { x: 100, y: 100 });
    const b = createPlayerState({ id: 1, characterId: 'mira', difficulty: 2 }, { x: 400, y: 300 });
    const mkDrop = (mode: 'leave' | 'life'): GearDropState => ({ id: 5, item: acc('magnet'), pos: { x: 100, y: 100 }, ttlMs: GEAR_TTL_MS, lockedFor: 0, lockMode: mode });
    const life = stepAutoCalls([a, b], [], [mkDrop('life')], []);
    expect(autoEvents(life)).toEqual([]);
    for (const p of [a, b]) stepPlayerTimers(p, DT);
    const leave = stepAutoCalls([a, b], [], [mkDrop('leave')], []);
    expect(autoEvents(leave)).toEqual([{ type: 'autoCallStarted', playerId: 0, icon: 'gear', to: [1] }]);
  });
});

describe("pas d'appel à l'éparpillement d'une chute ni quand la chute dépose un cœur", () => {
  it("un joueur qui tombe avec son équipement et un cœur rangé : tout est éparpillé (verrou 'life'), AUCUN appel ; ses alliés loin ne sont pas prévenus", () => {
    const s = makeSim(2);
    stepN(s, 1);
    s.state.players[1].pos = { x: 400, y: 300 };
    const p0 = s.state.players[0];
    p0.pos = { x: 100, y: 100 };
    p0.loadout.accessory = { kind: 'lantern', level: 2 };
    p0.loadout.weapon = 2;
    p0.loadout.boots = 1;
    p0.heart = 'full';
    expect(s.knockDown(0)).toBe(true);
    const ev = stepN(s, 300);
    expect(ev.some((e) => e.type === 'gearLost')).toBe(true);
    expect(ev.some((e) => e.type === 'gearDropped' && e.scattered)).toBe(true);
    expect(ev.some((e) => e.type === 'pickupDropped')).toBe(true); // le cœur tombe au sol
    expect(autoEvents(ev)).toEqual([]);
    expect((s.state.room.gearDrops as GearDropState[]).every((d) => d.lockMode === 'life' && d.lockedFor === 0)).toBe(true);
  });

  it('l allié qui passe sur ces objets éparpillés garde la règle normale (objet refusé = appel du REFUSEUR ; objet utile = ramassé) : jamais un appel du joueur tombé', () => {
    const s = makeSim(2);
    stepN(s, 1);
    const p0 = s.state.players[0];
    const p1 = s.state.players[1];
    p0.pos = { x: 100, y: 100 };
    p1.pos = { x: 100, y: 100 };
    p0.loadout.weapon = 2;
    expect(s.knockDown(0)).toBe(true);
    const ev = stepN(s, 200);
    for (const e of autoEvents(ev)) expect(e.playerId).not.toBe(0);
  });
});

describe('non-régression : un échange SANS allié utile ne change rien au jeu', () => {
  it('même graine avec et sans appel automatique : mêmes événements de jeu, mêmes flux aléatoires', () => {
    const run = (autoCall: boolean): GameSimulation => {
      const s = makeSim(2, { autoCall });
      stepN(s, 1);
      s.state.players[1].pos = { x: 300, y: 200 };
      const p0 = s.state.players[0];
      p0.pos = { x: 100, y: 100 };
      p0.loadout.accessory = { kind: 'lantern', level: 1 };
      putDrop(s, acc('magnet'), 100, 100);
      stepN(s, 1, { 0: frame({ interact: true }) });
      stepN(s, 600);
      return s;
    };
    const on = run(true);
    const off = run(false);
    const strip = (json: string): unknown => {
      const st = JSON.parse(json);
      delete st.autoCallDisabled;
      for (const p of st.players) {
        delete p.autoCall;
        delete p.autoCallCooldownMs;
        delete p.autoCallSeen;
        delete p.autoCallCross;
      }
      return st;
    };
    expect(strip(on.serialize())).toEqual(strip(off.serialize()));
    expect([on.state.rngState, on.state.lootRngState, on.state.gearRngState]).toEqual([off.state.rngState, off.state.lootRngState, off.state.gearRngState]);
    expect(on.state.players[0].loadout.accessory).toEqual({ kind: 'magnet', level: 1 });
  });
});
