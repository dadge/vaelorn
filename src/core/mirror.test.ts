/**
 * Miroir réseau (`GameSimulation.applyMirrorState`, docs/NET.md § 7.3) : un état reçu est validé puis copié sur place ;
 * la simulation miroir reste identique à la source ; un état invalide est rejeté SANS rien modifier.
 */
import { describe, expect, it } from 'vitest';
import { DemoPilot } from '../attract/DemoPilot';
import { LEVELS } from '../levels';
import { SIM_STEP_MS } from './constants';
import { makeTestLevel, makeTestRoom } from './levelValidation';
import { MIRROR_LIMITS, cloneJson, jsonProblem, validateMirrorState } from './mirror';
import { modeSimFlags } from '../entities/loopLogic';
import { createSimulation, type GameSimulation } from './simulation';
import type { ActionFrame, CharacterId, GameState, LevelDef, PlayerId, PlayerSetup, TickInputs } from './types';

const DT = SIM_STEP_MS;
const CHARS: CharacterId[] = ['david', 'aelith', 'brokk', 'mira'];

function setups(n: number): PlayerSetup[] {
  return Array.from({ length: n }, (_, i) => ({ id: i as PlayerId, characterId: CHARS[i], difficulty: 2 }));
}

function make(levelIndex: number, n: number, startRoomIndex?: number): GameSimulation {
  const level = LEVELS[levelIndex];
  return createSimulation({ levelId: level.id, players: setups(n), seed: 12345 + levelIndex, startRoomIndex }, level);
}

/** Simulation avec les options de PRODUCTION d'une partie réseau (équipement, butin, emplacement cœur, appel automatique : `modeSimFlags`, comme `GameScene`). */
function makeProd(levelIndex: number, n: number): GameSimulation {
  const level = LEVELS[levelIndex];
  return createSimulation({ levelId: level.id, players: setups(n), seed: 12345 + levelIndex, ...modeSimFlags({ tutorial: false, demo: false }) }, level);
}

/**
 * Sérialisation canonique pour comparer source et miroir : `normalizeGearState` (appliquée par le miroir) efface `loadout.ringKills` quand il vaut 0, alors que la
 * source l'écrit à 0 après un soin de l'anneau du vampire. Même sens pour tout le jeu (`?? 0`), aucun effet sur l'affichage : on ignore ce seul écart.
 */
function canon(sim: GameSimulation): string {
  const state = JSON.parse(sim.serialize()) as { players: Array<{ loadout?: { ringKills?: number } }> };
  for (const p of state.players) if (p.loadout && p.loadout.ringKills === 0) delete p.loadout.ringKills;
  return JSON.stringify(state);
}

/** Un pilote automatique par joueur, branché sur la simulation SOURCE (il ne lit que l'état). */
function pilots(sim: GameSimulation, n: number): DemoPilot[] {
  return Array.from({ length: n }, (_, i) => new DemoPilot(sim, { playerId: i as PlayerId, seed: 7 + i }));
}

function decide(ps: DemoPilot[], state: GameState): TickInputs {
  const inputs: TickInputs = {};
  ps.forEach((p, i) => {
    inputs[i as PlayerId] = p.decide(state);
  });
  return inputs;
}

/** Niveau de test : ${count} salles dont la sortie ne demande rien (la dernière est finale). */
function tinyLevel(count = 3): LevelDef {
  const rooms = Array.from({ length: count }, (_, i) =>
    makeTestRoom({ id: `r${i + 1}`, mechanisms: [], exit: { rect: { x: 9, y: 5, w: 2, h: 2 }, requires: [], ...(i === count - 1 ? { final: true } : {}) } }),
  );
  return makeTestLevel({ rooms, objectives: [0, 1, 2, 3].map((slot) => ({ id: `o${slot}`, slot, roomId: 'r1', kind: 'kills' as const, labelKey: `objective.test.o${slot}`, count: 1 })) });
}

function teleportToExit(sim: GameSimulation): void {
  sim.state.players.forEach((p, i) => {
    p.pos = { x: 10 * 16 + (i % 2) * 4, y: 6 * 16 + Math.floor(i / 2) * 4 };
  });
}

/** Ce que le réseau fait de l'état : JSON texte, puis analyse. */
function wire(state: GameState): GameState {
  return JSON.parse(JSON.stringify(state)) as GameState;
}

describe('applyMirrorState : miroir exact', () => {
  it('un état appliqué se sérialise à l\'identique de la source (instantané toutes les 3 pas, 3 joueurs, niveau 1)', () => {
    const src = make(0, 3);
    const mirror = make(0, 3);
    const identity = mirror.state;
    const ps = pilots(src, 3);
    const rooms = new Set<number>();
    for (let i = 0; i < 2400; i++) {
      src.step(DT, decide(ps, src.state));
      if (i % 3 === 2) {
        const r = mirror.applyMirrorState(wire(src.state));
        expect(r.ok, `pas ${i}`).toBe(true);
        expect(mirror.serialize()).toBe(src.serialize());
        rooms.add(src.state.roomIndex);
      }
    }
    expect(mirror.state).toBe(identity); // l'identité de `state` est conservée
    expect(src.state.tick).toBe(2400);
  });

  it('un état appliqué n\'est pas aliasé : modifier l\'objet reçu ensuite ne change pas le miroir', () => {
    const src = make(0, 2);
    const mirror = make(0, 2);
    const ps = pilots(src, 2);
    for (let i = 0; i < 90; i++) src.step(DT, decide(ps, src.state));
    const incoming = wire(src.state);
    expect(mirror.applyMirrorState(incoming).ok).toBe(true);
    const before = mirror.serialize();
    incoming.players[0].hp = -999;
    incoming.room.enemies.length = 0;
    incoming.room.mechanisms.length = 0;
    expect(mirror.serialize()).toBe(before);
  });

  it('source et miroir qui ont reçu le même état puis les mêmes entrées restent identiques sur 300 pas', () => {
    const src = make(0, 3);
    const ps = pilots(src, 3);
    for (let i = 0; i < 600; i++) src.step(DT, decide(ps, src.state));
    const mirror = make(0, 3);
    expect(mirror.applyMirrorState(wire(src.state)).ok).toBe(true);
    expect(mirror.serialize()).toBe(src.serialize());
    for (let i = 0; i < 300; i++) {
      const inputs = decide(ps, src.state);
      src.step(DT, inputs);
      mirror.step(DT, inputs);
      if (i % 10 === 9) expect(mirror.serialize(), `pas ${i}`).toBe(src.serialize());
    }
    expect(mirror.serialize()).toBe(src.serialize());
  });

  it('options de production (équipement, butin, cœur, appel) : miroir exact sur plusieurs niveaux et nombres de joueurs', () => {
    for (const [levelIndex, n] of [[0, 3], [1, 2], [2, 4]] as const) {
      const src = makeProd(levelIndex, n);
      const mirror = makeProd(levelIndex, n);
      const ps = pilots(src, n);
      for (let i = 0; i < 1500; i++) {
        src.step(DT, decide(ps, src.state));
        if (i % 3 === 2) {
          const r = mirror.applyMirrorState(wire(src.state));
          expect(r.ok, `niveau ${levelIndex + 1}, pas ${i}`).toBe(true);
          expect(canon(mirror), `niveau ${levelIndex + 1}, pas ${i}`).toBe(canon(src));
        }
      }
    }
  });

  it('anneau du vampire : un compteur à 0 chez la source (après un soin) est absent chez le miroir, sans autre différence', () => {
    const src = makeProd(0, 2);
    const mirror = makeProd(0, 2);
    src.step(DT, {});
    const p = src.state.players[0];
    p.loadout = { ...p.loadout, accessory: { kind: 'vampire', level: 3 }, ringKills: 0 } as typeof p.loadout;
    expect(mirror.applyMirrorState(wire(src.state)).ok).toBe(true);
    expect(mirror.serialize()).not.toBe(src.serialize());
    expect(canon(mirror)).toBe(canon(src));
    expect(mirror.state.players[0].loadout.accessory?.kind).toBe('vampire');
  });

  it('niveau à 40 ennemis (niveau 5, 4 joueurs) : miroir exact, état de pire cas accepté', () => {
    const src = make(4, 4);
    const mirror = make(4, 4);
    const ps = pilots(src, 4);
    for (let i = 0; i < 900; i++) {
      src.step(DT, decide(ps, src.state));
      if (i % 3 === 2) {
        expect(mirror.applyMirrorState(wire(src.state)).ok).toBe(true);
      }
    }
    expect(mirror.serialize()).toBe(src.serialize());
  });

  it('auto-miroir : appliquer à une simulation son propre état ne change pas la suite de la partie', () => {
    const a = make(1, 2);
    const b = make(1, 2);
    const ps = pilots(a, 2);
    for (let i = 0; i < 400; i++) {
      const inputs = decide(ps, a.state);
      a.step(DT, inputs);
      b.step(DT, inputs);
      if (i % 5 === 0) expect(b.applyMirrorState(JSON.parse(b.serialize())).ok).toBe(true);
    }
    expect(b.serialize()).toBe(a.serialize());
  });

  it('l\'ordre des clés de l\'état reçu est conservé (champ optionnel absent chez le miroir)', () => {
    const src = createSimulation({ levelId: LEVELS[0].id, players: setups(2), seed: 3, autoCall: false }, LEVELS[0]);
    const mirror = make(0, 2); // sans `autoCallDisabled`
    expect('autoCallDisabled' in mirror.state).toBe(false);
    expect(mirror.applyMirrorState(wire(src.state)).ok).toBe(true);
    expect(mirror.serialize()).toBe(src.serialize());
    // et dans l'autre sens : la clé disparaît quand l'état reçu ne l'a plus
    const plain = make(0, 2);
    expect(src.applyMirrorState(wire(plain.state)).ok).toBe(true);
    expect('autoCallDisabled' in src.state).toBe(false);
    expect(src.serialize()).toBe(plain.serialize());
  });
});

describe('applyMirrorState : changement de salle, mort d\'équipe, fin de niveau', () => {
  it('changement de salle : roomChanged, grille reconstruite, puis plus de changement', () => {
    const src = make(0, 2, 1);
    const mirror = make(0, 2);
    expect(mirror.state.roomIndex).toBe(0);
    const gridBefore = mirror.grid;
    const r = mirror.applyMirrorState(wire(src.state));
    expect(r).toEqual({ ok: true, roomChanged: true });
    expect(mirror.state.roomIndex).toBe(1);
    expect(mirror.room.id).toBe(src.room.id);
    expect(mirror.grid).not.toBe(gridBefore);
    expect(mirror.grid.width).toBe(src.grid.width);
    expect(mirror.grid.height).toBe(src.grid.height);
    expect(mirror.serialize()).toBe(src.serialize());
    expect(mirror.applyMirrorState(wire(src.state))).toEqual({ ok: true, roomChanged: false });
    // la grille reconstruite est bien celle de la salle : mêmes déplacements que la source
    const ps = pilots(src, 2);
    for (let i = 0; i < 240; i++) {
      const inputs = decide(ps, src.state);
      src.step(DT, inputs);
      mirror.step(DT, inputs);
    }
    expect(mirror.serialize()).toBe(src.serialize());
  });

  it('un vrai passage de salle en cours de partie est suivi par le miroir', () => {
    const level = tinyLevel();
    const src = createSimulation({ levelId: level.id, players: setups(2), seed: 5 }, level);
    const mirror = createSimulation({ levelId: level.id, players: setups(2), seed: 5 }, level);
    let changes = 0;
    for (let i = 0; i < 400; i++) {
      if (i === 30) teleportToExit(src);
      src.step(DT, {});
      if (i % 3 === 2) {
        const r = mirror.applyMirrorState(wire(src.state));
        expect(r.ok).toBe(true);
        if (r.ok && r.roomChanged) changes++;
        expect(mirror.serialize()).toBe(src.serialize());
      }
    }
    expect(src.state.roomIndex).toBeGreaterThanOrEqual(1);
    expect(changes).toBeGreaterThanOrEqual(1);
    expect(mirror.state.roomIndex).toBe(src.state.roomIndex);
    expect(mirror.room.id).toBe(src.room.id);
  });

  it('mort d\'équipe (phase wipe) puis redémarrage de la salle', () => {
    const src = make(0, 2);
    const mirror = make(0, 2);
    const none: TickInputs = {};
    for (let i = 0; i < 30; i++) src.step(DT, none);
    expect(src.knockDown(0)).toBe(true);
    expect(src.knockDown(1)).toBe(true);
    let sawWipe = false;
    let sawRestart = false;
    for (let i = 0; i < 400; i++) {
      const ev = src.step(DT, none);
      if (src.state.phase === 'wipe') sawWipe = true;
      if (ev.some((e) => e.type === 'roomEntered' && e.reason === 'restart')) sawRestart = true;
      if (i % 3 === 2) {
        expect(mirror.applyMirrorState(wire(src.state)).ok).toBe(true);
        expect(mirror.serialize()).toBe(src.serialize());
      }
    }
    expect(sawWipe).toBe(true);
    expect(sawRestart).toBe(true);
  });

  it('fin de niveau (phase levelComplete) : état accepté et identique', () => {
    const level = tinyLevel(1);
    const src = createSimulation({ levelId: level.id, players: setups(2), seed: 5 }, level);
    const mirror = createSimulation({ levelId: level.id, players: setups(2), seed: 5 }, level);
    for (const o of src.state.objectives) {
      o.done = true;
      o.progress = 1;
    }
    teleportToExit(src);
    let completed = false;
    for (let i = 0; i < 300; i++) {
      const ev = src.step(DT, {});
      if (ev.some((e) => e.type === 'levelCompleted')) completed = true;
      if (i % 3 === 2) {
        expect(mirror.applyMirrorState(wire(src.state)).ok).toBe(true);
        expect(mirror.serialize()).toBe(src.serialize());
      }
    }
    expect(completed).toBe(true);
    expect(mirror.state.phase).toBe('levelComplete');
  });
});

describe('applyMirrorState : états invalides rejetés sans rien modifier', () => {
  function fixture(): { src: GameSimulation; mirror: GameSimulation; good: GameState } {
    const src = make(0, 2);
    const ps = pilots(src, 2);
    for (let i = 0; i < 120; i++) src.step(DT, decide(ps, src.state));
    const mirror = make(0, 2);
    expect(mirror.applyMirrorState(wire(src.state)).ok).toBe(true);
    return { src, mirror, good: wire(src.state) };
  }

  const cases: [string, (s: GameState) => unknown][] = [
    ['mauvais niveau', (s) => ({ ...s, levelId: 'ailleurs' })],
    ['mauvaise version', (s) => ({ ...s, version: 2 })],
    ['players vide', (s) => ({ ...s, players: [] })],
    ['mauvais nombre de joueurs', (s) => ({ ...s, players: [s.players[0]], playerCount: 1 })],
    ['playerCount incohérent', (s) => ({ ...s, playerCount: 3 })],
    ['roomIndex hors plage', (s) => ({ ...s, roomIndex: 99 })],
    ['roomIndex négatif', (s) => ({ ...s, roomIndex: -1 })],
    ['roomIndex non entier', (s) => ({ ...s, roomIndex: 0.5 })],
    ['room d\'une autre salle', (s) => ({ ...s, room: { ...s.room, roomId: 'autre' } })],
    ['NaN injecté (position)', (s) => ({ ...s, players: [{ ...s.players[0], pos: { x: Number.NaN, y: 1 } }, s.players[1]] })],
    ['Infinity injecté (PV)', (s) => ({ ...s, players: [{ ...s.players[0], hp: Number.POSITIVE_INFINITY }, s.players[1]] })],
    ['null à la place d\'un nombre', (s) => ({ ...s, players: [{ ...s.players[0], hp: null }, s.players[1]] })],
    ['personnage inconnu', (s) => ({ ...s, players: [{ ...s.players[0], characterId: 'sorcier' }, s.players[1]] })],
    ['identifiant de joueur incohérent', (s) => ({ ...s, players: [s.players[1], s.players[0]] })],
    ['phase inconnue', (s) => ({ ...s, phase: 'dormir' })],
    ['mécanismes tronqués', (s) => ({ ...s, room: { ...s.room, mechanisms: [] } })],
    ['trop d\'ennemis', (s) => ({ ...s, room: { ...s.room, enemies: Array.from({ length: MIRROR_LIMITS.MAX_ENEMIES + 1 }, (_, i) => ({ ...(s.room.enemies[0] ?? {}), id: i })) } })],
    ['objectif inconnu', (s) => ({ ...s, objectives: [{ id: 'fantome', ownerId: 0, done: false, progress: 0 }] })],
    ['état absent', () => null],
    ['état tableau', () => []],
    ['état chaîne', () => 'abc'],
  ];
  for (const [name, mutate] of cases) {
    it(name, () => {
      const { mirror, good } = fixture();
      const before = mirror.serialize();
      const r = mirror.applyMirrorState(mutate(good));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
      expect(mirror.serialize()).toBe(before);
    });
  }

  it('ennemi de type inconnu, donnée d\'ennemi non numérique, projectile inconnu', () => {
    const { src, mirror } = fixture();
    // fabrique un état avec un ennemi : on en pose un à la main dans la source
    const e = { id: 9999, kind: 'slime', pos: { x: 40, y: 40 }, facing: 'down', hp: 10, maxHp: 10, mode: 'idle', modeTimerMs: 0, attackCooldownMs: 0, hitFlashMs: 0, data: {}, phase: 0, targetId: -1, wave: 0, dead: false };
    src.state.room.enemies.push(e as never);
    const before = mirror.serialize();
    for (const bad of [{ ...e, kind: 'dragon' }, { ...e, data: { a: 'x' } }, { ...e, dead: 'non' }, { ...e, pos: null }, 5]) {
      const s = wire(src.state);
      s.room.enemies[s.room.enemies.length - 1] = bad as never;
      expect(mirror.applyMirrorState(s).ok).toBe(false);
      expect(mirror.serialize()).toBe(before);
    }
    const s = wire(src.state);
    s.room.projectiles.push({ id: 1, kind: 'meteor', owner: { type: 'enemy', id: 1 }, pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 }, damage: 1, radius: 1, lifeMs: 1, pierce: false, hitIds: [] } as never);
    expect(mirror.applyMirrorState(s).ok).toBe(false);
    expect(mirror.serialize()).toBe(before);
    // l'ennemi valide, lui, est accepté
    expect(mirror.applyMirrorState(wire(src.state)).ok).toBe(true);
    expect(mirror.serialize()).toBe(src.serialize());
  });

  it('clé __proto__ dans l\'état reçu : rejetée, et le prototype n\'est jamais touché', () => {
    const { mirror, good } = fixture();
    const before = mirror.serialize();
    const hostile = JSON.parse(JSON.stringify(good).replace('"version":1', '"version":1,"__proto__":{"polluted":true}')) as unknown;
    const r = mirror.applyMirrorState(hostile);
    expect(r.ok).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((mirror.state as unknown as Record<string, unknown>).polluted).toBeUndefined();
    expect(mirror.serialize()).toBe(before);
  });

  it('un objet reçu trop profond ou trop gros est rejeté', () => {
    expect(jsonProblem({ a: { b: { c: { d: { e: { f: { g: { h: { i: { j: { k: { l: { m: 1 } } } } } } } } } } } } })).not.toBeNull();
    expect(jsonProblem(Array.from({ length: MIRROR_LIMITS.MAX_NODES + 1 }, () => 1))).not.toBeNull();
    expect(jsonProblem({ f: () => 1 })).not.toBeNull();
    expect(jsonProblem({ u: undefined })).not.toBeNull();
    expect(jsonProblem({ ok: [1, 'a', true, null, { x: 1.5 }] })).toBeNull();
  });

  it('validateMirrorState : un état valide passe, cloneJson fait une copie profonde', () => {
    const { good } = fixture();
    expect(validateMirrorState(good, LEVELS[0], 2)).toBeNull();
    expect(validateMirrorState(good, LEVELS[0], 3)).not.toBeNull();
    expect(validateMirrorState(good, LEVELS[1], 2)).not.toBeNull();
    const c = cloneJson(good);
    expect(c).toEqual(good);
    expect(c).not.toBe(good);
    expect(c.players[0]).not.toBe(good.players[0]);
    expect(c.room.enemies).not.toBe(good.room.enemies);
  });
});

describe('non-régression : le chemin local ne dépend pas du miroir', () => {
  it('createSimulation + step ne changent pas (deux parties identiques, une seule jamais mirorée)', () => {
    const a = make(2, 3);
    const b = make(2, 3);
    const pa = pilots(a, 3);
    const pb = pilots(b, 3);
    for (let i = 0; i < 600; i++) {
      const fa: Partial<Record<PlayerId, ActionFrame>> = decide(pa, a.state);
      const fb: Partial<Record<PlayerId, ActionFrame>> = decide(pb, b.state);
      a.step(DT, fa);
      b.step(DT, fb);
    }
    expect(a.serialize()).toBe(b.serialize());
  });
});
