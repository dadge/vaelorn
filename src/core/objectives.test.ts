import { TORCH_MAX_MS } from './constants';
import { describe, expect, it } from 'vitest';
import { TILE } from './constants';
import { makeTestLayout, makeTestRoom, makeTestLevel } from './levelValidation';
import { createRoomMechanisms } from './mechanisms';
import {
  allObjectivesDone,
  createObjectives,
  isObjectiveDone,
  isZoneOccupied,
  objectivesForPlayer,
  resetRoomObjectives,
  updateObjectives,
  type DeathRecord,
} from './objectives';
import type {
  LevelDef,
  MechanismState,
  ObjectiveState,
  PlateState,
  PlayerId,
  PlayerState,
  RoomDef,
  SimEvent,
} from './types';

function makePlayer(id: PlayerId, x = 20, y = 20): PlayerState {
  return {
    id,
    characterId: 'david',
    difficulty: 2,
    pos: { x, y },
    facing: 'down',
    hp: 100,
    maxHp: 100,
    status: 'alive',
    invulnMs: 0,
    attackCooldownMs: 0,
    attackAnimMs: 0,
    attackDir: 'down',
    revivingId: null,
    reviveProgressMs: 0,
    reviverId: null,
    keys: [],
    kills: 0,
    downCount: 0,
    prev: { attack: false, interact: false, revive: false },
    specialCooldownMs: 0,
    specialAnimMs: 0,
    torchMs: TORCH_MAX_MS,
    moving: false,
  };
}

const r1: RoomDef = makeTestRoom({
  id: 'r1',
  layout: makeTestLayout(16, 12),
  zones: [{ id: 'z1', rect: { x: 8, y: 6, w: 3, h: 3 } }],
  enemies: [
    { kind: 'slime', tile: [6, 3] },
    { kind: 'slime', tile: [7, 3] },
    { kind: 'bat', tile: [8, 3] },
  ],
  mechanisms: [
    { id: 'p1', type: 'plate', tile: [6, 4] },
    { id: 'p2', type: 'plate', tile: [7, 4], minPlayers: 3 },
  ],
});
const r2: RoomDef = makeTestRoom({ id: 'r2', exit: { rect: { x: 9, y: 5, w: 2, h: 2 }, requires: [], final: true } });

const level: LevelDef = makeTestLevel({
  rooms: [r1, r2],
  objectives: [
    { id: 'o0', slot: 0, roomId: 'r1', kind: 'mechanism', labelKey: 'objective.t.o0', mechanismId: 'p1' },
    { id: 'o1', slot: 1, roomId: 'r1', kind: 'zone', labelKey: 'objective.t.o1', zoneId: 'z1', seconds: 2 },
    { id: 'o2', slot: 2, roomId: 'r1', kind: 'kills', labelKey: 'objective.t.o2', count: 2, enemyKind: 'slime' },
    { id: 'o3', slot: 3, roomId: 'r2', kind: 'kills', labelKey: 'objective.t.o3', count: 1 },
  ],
});

const inZone = { x: 9.5 * TILE, y: 7.5 * TILE };

interface Ctx {
  objectives: ObjectiveState[];
  players: PlayerState[];
  mechanisms: MechanismState[];
  room: RoomDef;
  n: number;
}

function setup(n: number, room: RoomDef = r1): Ctx {
  return {
    objectives: createObjectives(level, n),
    players: Array.from({ length: n }, (_, i) => makePlayer(i as PlayerId)),
    mechanisms: createRoomMechanisms(room, n),
    room,
    n,
  };
}

function tick(c: Ctx, deaths: DeathRecord[] = [], dtMs = 1000 / 60): SimEvent[] {
  return updateObjectives({
    level,
    room: c.room,
    objectives: c.objectives,
    players: c.players,
    mechanisms: c.mechanisms,
    deaths,
    dtMs,
  });
}

const obj = (c: Ctx, id: string): ObjectiveState => c.objectives.find((o) => o.id === id)!;
const kill = (by: PlayerId | null, kind: DeathRecord['kind'] = 'slime', roomId = 'r1'): DeathRecord => ({ kind, byPlayer: by, roomId });

describe('createObjectives — mapping slot % nbJoueurs', () => {
  const owners = (n: number): PlayerId[] => createObjectives(level, n).map((o) => o.ownerId);

  it('1 joueur : tous les objectifs reviennent à J1', () => {
    expect(owners(1)).toEqual([0, 0, 0, 0]);
  });
  it('2 joueurs : slots 0,2 → J1 ; 1,3 → J2', () => {
    expect(owners(2)).toEqual([0, 1, 0, 1]);
  });
  it('3 joueurs : slot 3 → J1', () => {
    expect(owners(3)).toEqual([0, 1, 2, 0]);
  });
  it('4 joueurs : un objectif par joueur', () => {
    expect(owners(4)).toEqual([0, 1, 2, 3]);
  });
  it('état initial : non accompli, progression nulle, même ordre que le niveau', () => {
    const st = createObjectives(level, 4);
    expect(st.map((o) => o.id)).toEqual(['o0', 'o1', 'o2', 'o3']);
    expect(st.every((o) => !o.done && o.progress === 0)).toBe(true);
  });
});

describe('updateObjectives — mechanism', () => {
  it('accompli quand le mécanisme devient actif ; événement avec le propriétaire', () => {
    const c = setup(4);
    expect(tick(c)).toEqual([]);
    expect(obj(c, 'o0').done).toBe(false);
    (c.mechanisms[0] as PlateState).active = true;
    const ev = tick(c);
    expect(obj(c, 'o0')).toMatchObject({ done: true, progress: 1 });
    expect(ev).toEqual([{ type: 'objectiveCompleted', objectiveId: 'o0', playerId: 0 }]);
    expect(tick(c)).toEqual([]); // un seul événement
  });

  it('accompli d\'office si le mécanisme est waived (coop adaptative)', () => {
    const level2 = makeTestLevel({
      rooms: [r1, r2],
      objectives: [
        ...level.objectives.filter((o) => o.id !== 'o0'),
        { id: 'o0', slot: 0, roomId: 'r1', kind: 'mechanism', labelKey: 'x', mechanismId: 'p2' },
      ],
    });
    const mechanisms = createRoomMechanisms(r1, 2); // p2 : minPlayers 3 → waived à 2 joueurs
    const objectives = createObjectives(level2, 2);
    const ev = updateObjectives({ level: level2, room: r1, objectives, players: [makePlayer(0), makePlayer(1)], mechanisms, deaths: [], dtMs: 16 });
    expect(objectives.find((o) => o.id === 'o0')!.done).toBe(true);
    expect(ev).toContainEqual({ type: 'objectiveCompleted', objectiveId: 'o0', playerId: 0 });
  });

  it('un objectif ne progresse que dans sa salle', () => {
    const c = setup(4, r2);
    c.mechanisms = createRoomMechanisms(r2, 4);
    expect(tick(c)).toEqual([]);
    expect(obj(c, 'o0').done).toBe(false);
  });
});

describe('updateObjectives — zone', () => {
  it('cumule dt/1000/seconds tant que le propriétaire vivant est dans la zone, puis accompli', () => {
    const c = setup(4);
    c.players[1].pos = { ...inZone };
    tick(c, [], 500);
    expect(obj(c, 'o1').progress).toBeCloseTo(0.25, 6);
    expect(obj(c, 'o1').done).toBe(false);
    tick(c, [], 500);
    expect(obj(c, 'o1').progress).toBeCloseTo(0.5, 6);
    const ev = tick(c, [], 1000);
    expect(obj(c, 'o1')).toMatchObject({ done: true, progress: 1 });
    expect(ev).toContainEqual({ type: 'objectiveCompleted', objectiveId: 'o1', playerId: 1 });
  });

  it('le temps est cumulatif : sortir de la zone met en pause sans remettre à zéro', () => {
    const c = setup(4);
    c.players[1].pos = { ...inZone };
    tick(c, [], 1000);
    c.players[1].pos = { x: 20, y: 20 };
    tick(c, [], 5000);
    expect(obj(c, 'o1').progress).toBeCloseTo(0.5, 6);
    c.players[1].pos = { ...inZone };
    tick(c, [], 1000);
    expect(obj(c, 'o1').done).toBe(true);
  });

  it('un autre joueur dans la zone ne compte pas ; un propriétaire à terre non plus', () => {
    const c = setup(4);
    c.players[0].pos = { ...inZone };
    tick(c, [], 3000);
    expect(obj(c, 'o1').progress).toBe(0);
    c.players[1].pos = { ...inZone };
    c.players[1].status = 'down';
    tick(c, [], 3000);
    expect(obj(c, 'o1').progress).toBe(0);
  });

  it('à 1 joueur, J1 possède l\'objectif de zone du slot 1', () => {
    const c = setup(1);
    c.players[0].pos = { ...inZone };
    tick(c, [], 2000);
    expect(obj(c, 'o1').done).toBe(true);
  });

  it('isZoneOccupied reflète la présence EN CE MOMENT du propriétaire', () => {
    const c = setup(4);
    expect(isZoneOccupied(c.objectives, level, r1, c.players, 'o1')).toBe(false);
    c.players[1].pos = { ...inZone };
    expect(isZoneOccupied(c.objectives, level, r1, c.players, 'o1')).toBe(true);
    c.players[1].status = 'down';
    expect(isZoneOccupied(c.objectives, level, r1, c.players, 'o1')).toBe(false);
    c.players[1].status = 'alive';
    expect(isZoneOccupied(c.objectives, level, r2, c.players, 'o1')).toBe(false); // autre salle
    expect(isZoneOccupied(c.objectives, level, r1, c.players, 'o0')).toBe(false); // pas une zone
    expect(isZoneOccupied(c.objectives, level, r1, c.players, 'inconnu')).toBe(false);
  });
});

describe('updateObjectives — kills', () => {
  it('compte les morts du propriétaire (filtre enemyKind, salle) jusqu\'à count', () => {
    const c = setup(4);
    tick(c, [kill(2, 'bat')]); // mauvais type
    expect(obj(c, 'o2').progress).toBe(0);
    tick(c, [kill(1, 'slime')]); // mauvais joueur
    expect(obj(c, 'o2').progress).toBe(0);
    tick(c, [kill(null, 'slime')]); // pas de tueur joueur
    expect(obj(c, 'o2').progress).toBe(0);
    tick(c, [kill(2, 'slime', 'r2')]); // mauvaise salle
    expect(obj(c, 'o2').progress).toBe(0);
    expect(tick(c, [kill(2)])).toEqual([]);
    expect(obj(c, 'o2').progress).toBe(0.5);
    const ev = tick(c, [kill(2)]);
    expect(obj(c, 'o2')).toMatchObject({ done: true, progress: 1 });
    expect(ev).toEqual([{ type: 'objectiveCompleted', objectiveId: 'o2', playerId: 2 }]);
  });

  it('plusieurs morts dans le même pas sont toutes comptées (plafonné à count)', () => {
    const c = setup(4);
    const ev = tick(c, [kill(2), kill(2), kill(2)]);
    expect(obj(c, 'o2').done).toBe(true);
    expect(ev).toHaveLength(1);
  });

  it('sans filtre enemyKind tout ennemi compte', () => {
    const c = setup(4, r2);
    c.mechanisms = createRoomMechanisms(r2, 4);
    tick(c, [kill(3, 'knight', 'r2')]);
    expect(obj(c, 'o3').done).toBe(true);
  });

  it('coop adaptative : à 2 joueurs, l\'objectif du slot 2 appartient à J1 (les kills de J2 ne comptent pas)', () => {
    const c = setup(2);
    expect(obj(c, 'o2').ownerId).toBe(0);
    tick(c, [kill(1), kill(1)]);
    expect(obj(c, 'o2').done).toBe(false);
    tick(c, [kill(0), kill(0)]);
    expect(obj(c, 'o2').done).toBe(true);
  });

  it('à 1 joueur, J1 accomplit plusieurs objectifs à la fois', () => {
    const c = setup(1);
    (c.mechanisms[0] as PlateState).active = true;
    c.players[0].pos = { ...inZone };
    const ev = tick(c, [kill(0), kill(0)], 2000);
    expect(obj(c, 'o0').done && obj(c, 'o1').done && obj(c, 'o2').done).toBe(true);
    expect(ev.map((e) => (e.type === 'objectiveCompleted' ? e.objectiveId : ''))).toEqual(['o0', 'o1', 'o2']);
  });
});

describe('persistance et réinitialisation', () => {
  it('un objectif accompli le reste (mécanisme relâché, zone quittée, autre salle)', () => {
    const c = setup(4);
    (c.mechanisms[0] as PlateState).active = true;
    c.players[1].pos = { ...inZone };
    tick(c, [], 2500);
    expect(obj(c, 'o0').done && obj(c, 'o1').done).toBe(true);
    (c.mechanisms[0] as PlateState).active = false;
    c.players[1].pos = { x: 20, y: 20 };
    tick(c, [], 1000);
    expect(obj(c, 'o0').done && obj(c, 'o1').done).toBe(true);
    // changement de salle
    c.room = r2;
    c.mechanisms = createRoomMechanisms(r2, 4);
    tick(c, [], 1000);
    expect(obj(c, 'o0').done && obj(c, 'o1').done).toBe(true);
    expect(obj(c, 'o1').progress).toBe(1);
  });

  it('resetRoomObjectives remet à zéro uniquement les objectifs NON accomplis de la salle donnée', () => {
    const c = setup(4);
    (c.mechanisms[0] as PlateState).active = true;
    c.players[1].pos = { ...inZone };
    tick(c, [kill(2)], 1000); // o0 fait, o1 à 0.5, o2 à 0.5
    expect(obj(c, 'o0').done).toBe(true);
    expect(obj(c, 'o1').progress).toBeCloseTo(0.5, 6);
    expect(obj(c, 'o2').progress).toBe(0.5);
    obj(c, 'o3').progress = 0.7; // objectif d'une autre salle
    resetRoomObjectives(c.objectives, level, 'r1');
    expect(obj(c, 'o0')).toMatchObject({ done: true, progress: 1 });
    expect(obj(c, 'o1')).toMatchObject({ done: false, progress: 0 });
    expect(obj(c, 'o2')).toMatchObject({ done: false, progress: 0 });
    expect(obj(c, 'o3').progress).toBe(0.7);
    // après reset, le comptage de kills repart de zéro
    tick(c, [kill(2)]);
    expect(obj(c, 'o2').progress).toBe(0.5);
  });
});

describe('requêtes', () => {
  it('isObjectiveDone / allObjectivesDone', () => {
    const c = setup(4);
    expect(isObjectiveDone(c.objectives, 'o0')).toBe(false);
    expect(isObjectiveDone(c.objectives, 'inconnu')).toBe(false);
    expect(allObjectivesDone(c.objectives)).toBe(false);
    c.objectives.forEach((o) => {
      o.done = true;
    });
    expect(isObjectiveDone(c.objectives, 'o0')).toBe(true);
    expect(allObjectivesDone(c.objectives)).toBe(true);
    expect(allObjectivesDone([])).toBe(true);
  });

  it('objectivesForPlayer retourne définition + état dans l\'ordre du niveau', () => {
    const two = createObjectives(level, 2);
    expect(objectivesForPlayer(two, level, 0).map((e) => e.def.id)).toEqual(['o0', 'o2']);
    expect(objectivesForPlayer(two, level, 1).map((e) => e.def.id)).toEqual(['o1', 'o3']);
    expect(objectivesForPlayer(two, level, 2)).toEqual([]);
    const one = createObjectives(level, 1);
    const entries = objectivesForPlayer(one, level, 0);
    expect(entries.map((e) => e.state.id)).toEqual(['o0', 'o1', 'o2', 'o3']);
    expect(entries[1].def.kind).toBe('zone');
  });
});
