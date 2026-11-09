import { TORCH_MAX_MS } from './constants';
import { describe, expect, it } from 'vitest';
import { PLAYER_RADIUS, SIM_STEP_MS, TILE } from './constants';
import { RoomGrid } from './grid';
import { makeTestLayout, makeTestRoom } from './levelValidation';
import {
  areAllRequirementsMet,
  createRoomMechanisms,
  effectiveLeverWindowMs,
  isRequirementMet,
  mechanismBlocksProjectile,
  mechanismSolidRects,
  PUSH_THRESHOLD_MS,
  requiredPushers,
  tileCenterPx,
  updateMechanisms,
  type RequirementContext,
} from './mechanisms';
import type {
  ActionFrame,
  BlockState,
  DoorState,
  KeyState,
  LeverState,
  MechanismDef,
  MechanismState,
  PlateState,
  PlayerId,
  PlayerState,
  RoomDef,
  RuneState,
  SimEvent,
  SocketState,
  TickInputs,
  TileXY,
} from './types';

// ───────────────────────────── Harnais ─────────────────────────────

function makePlayer(id: PlayerId, tile: TileXY): PlayerState {
  const c = tileCenterPx(tile);
  return {
    id,
    characterId: 'david',
    difficulty: 2,
    pos: { x: c.x, y: c.y },
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
    callMs: 0,
    callCooldownMs: 0,
    moving: false,
    loadout: { boots: 0, protection: 0, artifact: 0, magic: 0, weapon: 0, accessory: null, buffs: [] },
  };
}

function mv(moveX: number, moveY: number): ActionFrame {
  return { moveX, moveY, attack: false, interact: false, revive: false };
}

interface StepOpts {
  press?: PlayerId[];
  frames?: TickInputs;
  aliveEnemyCount?: number;
  objectiveDone?: (id: string) => boolean;
  zoneOccupied?: (id: string) => boolean;
}

class Harness {
  readonly grid: RoomGrid;
  readonly mechanisms: MechanismState[];
  readonly players: PlayerState[];
  readonly allEvents: SimEvent[] = [];

  constructor(
    readonly room: RoomDef,
    readonly n: number,
  ) {
    this.grid = new RoomGrid(room.layout);
    this.mechanisms = createRoomMechanisms(room, n);
    this.players = Array.from({ length: n }, (_, i) => makePlayer(i as PlayerId, room.playerSpawns[i]));
  }

  put(id: PlayerId, tile: TileXY): void {
    const c = tileCenterPx(tile);
    this.players[id].pos = { x: c.x, y: c.y };
  }

  step(opts: StepOpts = {}, ticks = 1): SimEvent[] {
    const out: SimEvent[] = [];
    for (let i = 0; i < ticks; i++) {
      const interactPressed: Partial<Record<PlayerId, boolean>> = {};
      // la pression n'est envoyée que pendant le PREMIER pas (front montant)
      if (i === 0) for (const id of opts.press ?? []) interactPressed[id] = true;
      const ev = updateMechanisms({
        room: this.room,
        grid: this.grid,
        mechanisms: this.mechanisms,
        players: this.players,
        frames: opts.frames ?? {},
        interactPressed,
        dtMs: SIM_STEP_MS,
        aliveEnemyCount: opts.aliveEnemyCount ?? 0,
        objectiveDone: opts.objectiveDone ?? (() => false),
        zoneOccupied: opts.zoneOccupied ?? (() => false),
      });
      out.push(...ev);
    }
    this.allEvents.push(...out);
    return out;
  }

  /** Avance de `ms` millisecondes sans entrée. */
  wait(ms: number): SimEvent[] {
    return this.step({}, Math.ceil(ms / SIM_STEP_MS));
  }

  get<T extends MechanismState>(id: string): T {
    const s = this.mechanisms.find((m) => m.id === id);
    if (!s) throw new Error(`mécanisme introuvable ${id}`);
    return s as T;
  }
}

function roomWith(mechanisms: MechanismDef[], over: Partial<RoomDef> = {}): RoomDef {
  return makeTestRoom({ layout: makeTestLayout(16, 12), mechanisms, ...over });
}

// ───────────────────────────── Activation des mécanismes ─────────────────────────────

describe('activation des mécanismes — plaques et portes', () => {
  const room = roomWith([
    { id: 'a', type: 'plate', tile: [4, 3] },
    { id: 'b', type: 'plate', tile: [8, 3] },
    { id: 'door', type: 'door', tiles: [[12, 5], [12, 6]], requires: ['a', 'b'] },
  ]);

  it('une plaque est active tant qu\'un joueur vivant est dessus, inactive une fois relâchée', () => {
    const h = new Harness(room, 2);
    h.step();
    expect(h.get<PlateState>('a').active).toBe(false);
    h.put(0, [4, 3]);
    const ev = h.step();
    expect(h.get<PlateState>('a').active).toBe(true);
    expect(h.get<PlateState>('a').pressedBy).toBe(0);
    expect(ev).toContainEqual({ type: 'mechanismChanged', mechanismId: 'a', active: true });
    h.put(0, [2, 2]);
    const ev2 = h.step();
    expect(h.get<PlateState>('a').active).toBe(false);
    expect(h.get<PlateState>('a').pressedBy).toBeNull();
    expect(ev2).toContainEqual({ type: 'mechanismChanged', mechanismId: 'a', active: false });
  });

  it('un joueur à terre n\'active pas une plaque', () => {
    const h = new Harness(room, 2);
    h.put(0, [4, 3]);
    h.players[0].status = 'down';
    h.step();
    expect(h.get<PlateState>('a').active).toBe(false);
  });

  it('une seule plaque ne suffit pas ; deux plaques simultanées ouvrent la porte ; elle reste ouverte ensuite', () => {
    const h = new Harness(room, 2);
    h.put(0, [4, 3]);
    h.step({}, 5);
    expect(h.get<DoorState>('door').open).toBe(false);
    h.put(1, [8, 3]);
    const ev = h.step();
    expect(h.get<DoorState>('door').open).toBe(true);
    expect(h.get<DoorState>('door').active).toBe(true);
    expect(ev).toContainEqual({ type: 'doorOpened', doorId: 'door' });
    // les deux quittent leurs plaques : la porte reste ouverte
    h.put(0, [2, 2]);
    h.put(1, [3, 2]);
    h.step({}, 10);
    expect(h.get<PlateState>('a').active).toBe(false);
    expect(h.get<PlateState>('b').active).toBe(false);
    expect(h.get<DoorState>('door').open).toBe(true);
  });

  it('une porte fermée est solide (une tuile par tuile) ; ouverte, elle ne l\'est plus', () => {
    const h = new Harness(room, 2);
    const rects = mechanismSolidRects(room, h.mechanisms);
    expect(rects).toEqual([
      { x: 12 * TILE, y: 5 * TILE, w: TILE, h: TILE },
      { x: 12 * TILE, y: 6 * TILE, w: TILE, h: TILE },
    ]);
    expect(mechanismBlocksProjectile(room, h.mechanisms, { x: 12 * TILE + 8, y: 5 * TILE + 8 })).toBe(true);
    expect(mechanismBlocksProjectile(room, h.mechanisms, { x: 3 * TILE, y: 3 * TILE })).toBe(false);
    h.put(0, [4, 3]);
    h.put(1, [8, 3]);
    h.step();
    expect(mechanismSolidRects(room, h.mechanisms)).toEqual([]);
    expect(mechanismBlocksProjectile(room, h.mechanisms, { x: 12 * TILE + 8, y: 5 * TILE + 8 })).toBe(false);
  });

  it('coop adaptative : à 1 joueur, la plaque minPlayers=2 est waived et une seule plaque ouvre la porte', () => {
    const adaptive = roomWith([
      { id: 'a', type: 'plate', tile: [4, 3] },
      { id: 'b', type: 'plate', tile: [8, 3], minPlayers: 2 },
      { id: 'door', type: 'door', tiles: [[12, 5]], requires: ['a', 'b'] },
    ]);
    const solo = new Harness(adaptive, 1);
    expect(solo.get<PlateState>('b').waived).toBe(true);
    expect(solo.get<PlateState>('b').active).toBe(true);
    solo.step({}, 3);
    expect(solo.get<DoorState>('door').open).toBe(false);
    solo.put(0, [4, 3]);
    solo.step();
    expect(solo.get<DoorState>('door').open).toBe(true);

    const duo = new Harness(adaptive, 2);
    expect(duo.get<PlateState>('b').waived).toBe(false);
    duo.put(0, [4, 3]);
    duo.step({}, 3);
    expect(duo.get<DoorState>('door').open).toBe(false);
  });

  it('une porte waived (minPlayers > nbJoueurs) est ouverte d\'office et non solide', () => {
    const r = roomWith([{ id: 'd', type: 'door', tiles: [[5, 5]], requires: ['nope'], minPlayers: 3 }]);
    const h = new Harness(r, 2);
    expect(h.get<DoorState>('d')).toMatchObject({ waived: true, open: true, active: true });
    expect(mechanismSolidRects(r, h.mechanisms)).toEqual([]);
    expect(new Harness(r, 3).get<DoorState>('d').open).toBe(false);
  });

  it('les portes s\'ouvrent en chaîne dans le même pas (porte exigeant une autre porte)', () => {
    const r = roomWith([
      { id: 'a', type: 'plate', tile: [4, 3] },
      { id: 'd1', type: 'door', tiles: [[10, 5]], requires: ['a'] },
      { id: 'd2', type: 'door', tiles: [[12, 5]], requires: ['d1'] },
    ]);
    const h = new Harness(r, 1);
    h.put(0, [4, 3]);
    h.step();
    expect(h.get<DoorState>('d1').open).toBe(true);
    expect(h.get<DoorState>('d2').open).toBe(true);
  });

  it('une porte exigeant "clear" attend aliveEnemyCount === 0', () => {
    const r = roomWith([
      { id: 'a', type: 'plate', tile: [4, 3] },
      { id: 'd', type: 'door', tiles: [[12, 5]], requires: ['clear'] },
    ]);
    const h = new Harness(r, 1);
    h.step({ aliveEnemyCount: 2 }, 3);
    expect(h.get<DoorState>('d').open).toBe(false);
    h.step({ aliveEnemyCount: 0 });
    expect(h.get<DoorState>('d').open).toBe(true);
  });
});

describe('activation des mécanismes — leviers', () => {
  const room = roomWith([
    { id: 'L1', type: 'lever', tile: [3, 3], ownerSlot: 0, windowMs: 1000 },
    { id: 'L2', type: 'lever', tile: [3, 8], ownerSlot: 1, windowMs: 1000 },
    { id: 'door', type: 'door', tiles: [[12, 5]], requires: ['L1', 'L2'] },
  ]);

  it('leviers à fenêtre : tous dans la fenêtre ⇒ la porte s\'ouvre', () => {
    const h = new Harness(room, 2);
    h.put(0, [3, 3]);
    h.put(1, [3, 8]);
    const ev = h.step({ press: [0] });
    expect(h.get<LeverState>('L1').active).toBe(true);
    expect(h.get<LeverState>('L1').remainingMs).toBeCloseTo(1000, 3);
    expect(ev).toContainEqual({ type: 'mechanismChanged', mechanismId: 'L1', active: true });
    h.wait(500);
    expect(h.get<DoorState>('door').open).toBe(false);
    h.step({ press: [1] });
    expect(h.get<DoorState>('door').open).toBe(true);
  });

  it('leviers trop espacés dans le temps ⇒ la porte reste fermée et le premier levier se désactive', () => {
    const h = new Harness(room, 2);
    h.put(0, [3, 3]);
    h.put(1, [3, 8]);
    h.step({ press: [0] });
    const ev = h.wait(1100);
    expect(h.get<LeverState>('L1').active).toBe(false);
    expect(ev).toContainEqual({ type: 'mechanismChanged', mechanismId: 'L1', active: false });
    h.step({ press: [1] });
    expect(h.get<LeverState>('L2').active).toBe(true);
    expect(h.get<DoorState>('door').open).toBe(false);
  });

  it('levier ownerSlot : seul le propriétaire (slot % nbJoueurs) peut l\'actionner', () => {
    const h = new Harness(room, 2);
    h.put(1, [3, 3]); // J2 près du levier de J1
    h.step({ press: [1] });
    expect(h.get<LeverState>('L1').active).toBe(false);
    h.put(0, [3, 3]);
    h.step({ press: [0] });
    expect(h.get<LeverState>('L1').active).toBe(true);
  });

  it('levier hors de portée ou sans appui : rien ne se passe', () => {
    const h = new Harness(room, 2);
    h.put(0, [3, 3]);
    h.step({}, 3); // pas de front montant
    expect(h.get<LeverState>('L1').active).toBe(false);
    h.put(0, [8, 3]); // loin
    h.step({ press: [0] });
    expect(h.get<LeverState>('L1').active).toBe(false);
  });

  it('la fenêtre est multipliée par ceil(nbLeviers / nbJoueurs) : à 1 joueur 2 leviers ⇒ 2000 ms', () => {
    const def = room.mechanisms[0];
    if (def.type !== 'lever') throw new Error('attendu un levier');
    expect(effectiveLeverWindowMs(room, 2, def)).toBe(1000);
    expect(effectiveLeverWindowMs(room, 1, def)).toBe(2000);

    const h = new Harness(room, 1);
    h.put(0, [3, 3]);
    h.step({ press: [0] });
    expect(h.get<LeverState>('L1').remainingMs).toBeCloseTo(2000, 3);
    h.wait(1500);
    h.put(0, [3, 8]);
    h.step({ press: [0] }); // J1 possède aussi le levier du slot 1 (1 % 1 = 0)
    expect(h.get<DoorState>('door').open).toBe(true);
  });

  it('un levier verrouillant (sans fenêtre) reste actif', () => {
    const r = roomWith([{ id: 'L', type: 'lever', tile: [3, 3] }]);
    const h = new Harness(r, 1);
    h.put(0, [3, 3]);
    h.step({ press: [0] });
    h.wait(5000);
    expect(h.get<LeverState>('L').active).toBe(true);
  });

  it('un levier minPlayers > nbJoueurs est waived (actif d\'office)', () => {
    const r = roomWith([{ id: 'L', type: 'lever', tile: [3, 3], minPlayers: 2 }]);
    expect(new Harness(r, 1).get<LeverState>('L')).toMatchObject({ waived: true, active: true });
  });
});

describe('activation des mécanismes — clés personnelles', () => {
  const room = roomWith([
    { id: 'k1', type: 'key', tile: [3, 3], ownerSlot: 0, doorId: 'd1' },
    { id: 'k2', type: 'key', tile: [3, 8], ownerSlot: 1, doorId: 'd2' },
    { id: 'd1', type: 'door', tiles: [[12, 3]], requires: [], keyId: 'k1' },
    { id: 'd2', type: 'door', tiles: [[12, 8]], requires: [], keyId: 'k2' },
  ]);

  it('le non-propriétaire ne ramasse pas la clé, le propriétaire oui', () => {
    const h = new Harness(room, 2);
    h.put(1, [3, 3]);
    h.step({}, 3);
    expect(h.get<KeyState>('k1').collected).toBe(false);
    expect(h.players[1].keys).toEqual([]);
    h.put(0, [3, 3]);
    const ev = h.step();
    expect(h.get<KeyState>('k1')).toMatchObject({ collected: true, holderId: 0, active: false });
    expect(h.players[0].keys).toEqual(['k1']);
    expect(ev).toContainEqual({ type: 'keyPicked', playerId: 0, keyId: 'k1' });
  });

  it('sans la clé la porte ne s\'ouvre pas, même exigences satisfaites et interaction à portée', () => {
    const h = new Harness(room, 2);
    h.put(0, [11, 3]);
    h.step({ press: [0] }, 2);
    expect(h.get<DoorState>('d1').open).toBe(false);
  });

  it('la clé n\'ouvre que SA porte, uniquement avec interaction à portée, et elle est consommée', () => {
    const h = new Harness(room, 2);
    h.put(0, [3, 3]);
    h.put(1, [3, 8]);
    h.step();
    expect(h.players[0].keys).toEqual(['k1']);
    expect(h.players[1].keys).toEqual(['k2']);

    // J1 près de la porte de J2 : rien
    h.put(0, [11, 8]);
    h.step({ press: [0] });
    expect(h.get<DoorState>('d2').open).toBe(false);
    // J2 (clé k2) près de la porte d1 : rien
    h.put(1, [11, 3]);
    h.step({ press: [1] });
    expect(h.get<DoorState>('d1').open).toBe(false);
    // J1 à portée de d1 mais sans appui : rien
    h.put(0, [11, 3]);
    h.step({}, 3);
    expect(h.get<DoorState>('d1').open).toBe(false);
    // J1 à portée de d1 avec appui : ouverture, clé consommée
    const ev = h.step({ press: [0] });
    expect(h.get<DoorState>('d1').open).toBe(true);
    expect(h.get<DoorState>('d2').open).toBe(false);
    expect(h.players[0].keys).toEqual([]);
    expect(h.get<KeyState>('k1').active).toBe(true);
    expect(ev).toContainEqual({ type: 'doorOpened', doorId: 'd1' });
    // J2 ouvre la sienne
    h.put(1, [11, 8]);
    h.step({ press: [1] });
    expect(h.get<DoorState>('d2').open).toBe(true);
    expect(h.players[1].keys).toEqual([]);
  });

  it('la porte à clé n\'accepte la clé que si ses autres exigences sont satisfaites', () => {
    const r = roomWith([
      { id: 'p', type: 'plate', tile: [6, 6] },
      { id: 'k', type: 'key', tile: [3, 3], ownerSlot: 0, doorId: 'd' },
      { id: 'd', type: 'door', tiles: [[12, 3]], requires: ['p'], keyId: 'k' },
    ]);
    const h = new Harness(r, 1);
    h.put(0, [3, 3]);
    h.step();
    h.put(0, [11, 3]);
    h.step({ press: [0] });
    expect(h.get<DoorState>('d').open).toBe(false);
    expect(h.players[0].keys).toEqual(['k']);
  });

  it('coop adaptative : à 1 joueur, les clés des slots 0 et 1 reviennent toutes deux à J1', () => {
    const h = new Harness(room, 1);
    h.put(0, [3, 3]);
    h.step();
    h.put(0, [3, 8]);
    h.step();
    expect(h.players[0].keys.sort()).toEqual(['k1', 'k2']);
  });

  it('clé minPlayers > nbJoueurs : waived, la porte s\'ouvre sans clé dès que les exigences sont remplies', () => {
    const r = roomWith([
      { id: 'k', type: 'key', tile: [3, 3], ownerSlot: 1, doorId: 'd', minPlayers: 2 },
      { id: 'd', type: 'door', tiles: [[12, 3]], requires: [], keyId: 'k' },
    ]);
    const h = new Harness(r, 1);
    expect(h.get<KeyState>('k').waived).toBe(true);
    h.step();
    expect(h.get<DoorState>('d').open).toBe(true);
  });
});

describe('activation des mécanismes — blocs, réceptacles', () => {
  const blockAt = (tx: number) => tx * TILE;

  function pushFrames(dirX: number, dirY: number, ids: PlayerId[]): TickInputs {
    const f: TickInputs = {};
    for (const id of ids) f[id] = mv(dirX, dirY);
    return f;
  }

  /** Place deux pousseurs sur la face gauche du bloc en [5,4]. */
  function leftPushers(h: Harness, blockTile: TileXY = [5, 4]): void {
    const x = blockAt(blockTile[0]) - PLAYER_RADIUS - 1;
    h.players[0].pos = { x, y: blockTile[1] * TILE + 8 };
    h.players[1].pos = { x, y: blockTile[1] * TILE + 24 };
  }

  it('requiredPushers = min(playersRequired ?? 2, nbJoueurs)', () => {
    const def = { id: 'b', type: 'block' as const, tile: [5, 4] as TileXY };
    expect(requiredPushers(def, 1)).toBe(1);
    expect(requiredPushers(def, 2)).toBe(2);
    expect(requiredPushers(def, 4)).toBe(2);
    expect(requiredPushers({ ...def, playersRequired: 3 }, 4)).toBe(3);
    expect(requiredPushers({ ...def, playersRequired: 3 }, 2)).toBe(2);
  });

  it('1 pousseur ne suffit pas à 2 joueurs ; 2 pousseurs déplacent le bloc d\'UNE tuile', () => {
    const room = roomWith([{ id: 'b', type: 'block', tile: [5, 4] }]);
    const h = new Harness(room, 2);
    leftPushers(h);
    // un seul pousseur
    h.step({ frames: pushFrames(1, 0, [0]) }, 90);
    expect(h.get<BlockState>('b').tile).toEqual([5, 4]);
    expect(h.get<BlockState>('b').moving).toBeNull();
    // les deux pousseurs, jusqu'au début du mouvement
    let ticks = 0;
    while (h.get<BlockState>('b').moving === null && ticks++ < 100) h.step({ frames: pushFrames(1, 0, [0, 1]) });
    expect(ticks * SIM_STEP_MS).toBeGreaterThanOrEqual(PUSH_THRESHOLD_MS - SIM_STEP_MS * 2);
    expect(h.get<BlockState>('b').tile).toEqual([6, 4]);
    // pendant le mouvement, les pousseurs sont entraînés
    const x0 = h.players[0].pos.x;
    h.step({ frames: pushFrames(1, 0, [0, 1]) }, 10);
    expect(h.players[0].pos.x).toBeGreaterThan(x0);
    expect(h.get<BlockState>('b').pos.x).toBeGreaterThan(5 * TILE);
    expect(h.get<BlockState>('b').moving!.progress).toBeGreaterThan(0);
    // relâchement : le déplacement se termine exactement sur la tuile
    h.step({}, 60);
    const b = h.get<BlockState>('b');
    expect(b.moving).toBeNull();
    expect(b.tile).toEqual([6, 4]);
    expect(b.pos).toEqual({ x: 6 * TILE, y: 4 * TILE });
    // contact conservé pendant la poussée : l'écart pousseur/bloc est resté constant
    expect(h.players[0].pos.x).toBeLessThan(b.pos.x);
  });

  it('à 1 joueur, un seul pousseur suffit', () => {
    const room = roomWith([{ id: 'b', type: 'block', tile: [5, 4] }]);
    const h = new Harness(room, 1);
    h.players[0].pos = { x: 5 * TILE - PLAYER_RADIUS - 1, y: 4 * TILE + 16 };
    let ticks = 0;
    while (h.get<BlockState>('b').moving === null && ticks++ < 100) h.step({ frames: pushFrames(1, 0, [0]) });
    expect(h.get<BlockState>('b').tile).toEqual([6, 4]);
  });

  it('la poussée est continue : le bloc enchaîne les tuiles tant qu\'on pousse', () => {
    const room = roomWith([{ id: 'b', type: 'block', tile: [4, 4] }]);
    const h = new Harness(room, 2);
    leftPushers(h, [4, 4]);
    h.step({ frames: pushFrames(1, 0, [0, 1]) }, 140);
    expect(h.get<BlockState>('b').tile[0]).toBeGreaterThanOrEqual(7);
  });

  it('pousser dans des directions opposées (égalité) ne déplace pas le bloc', () => {
    const room = roomWith([{ id: 'b', type: 'block', tile: [5, 4] }]);
    const h = new Harness(room, 4);
    h.players[0].pos = { x: 5 * TILE - PLAYER_RADIUS - 1, y: 4 * TILE + 8 };
    h.players[1].pos = { x: 5 * TILE - PLAYER_RADIUS - 1, y: 4 * TILE + 24 };
    h.players[2].pos = { x: 7 * TILE + PLAYER_RADIUS + 1, y: 4 * TILE + 8 };
    h.players[3].pos = { x: 7 * TILE + PLAYER_RADIUS + 1, y: 4 * TILE + 24 };
    const frames: TickInputs = { 0: mv(1, 0), 1: mv(1, 0), 2: mv(-1, 0), 3: mv(-1, 0) };
    h.step({ frames }, 60);
    expect(h.get<BlockState>('b').tile).toEqual([5, 4]);
  });

  it('un bloc se pousse aussi vers le haut/bas (face haute)', () => {
    const room = roomWith([{ id: 'b', type: 'block', tile: [5, 4] }]);
    const h = new Harness(room, 2);
    h.players[0].pos = { x: 5 * TILE + 8, y: 4 * TILE - PLAYER_RADIUS - 1 };
    h.players[1].pos = { x: 5 * TILE + 24, y: 4 * TILE - PLAYER_RADIUS - 1 };
    let ticks = 0;
    while (h.get<BlockState>('b').moving === null && ticks++ < 100) h.step({ frames: pushFrames(0, 1, [0, 1]) });
    expect(h.get<BlockState>('b').tile).toEqual([5, 5]);
  });

  it('un bloc est bloqué par un mur', () => {
    const layout = makeTestLayout(16, 12).map((row, y) =>
      y === 4 || y === 5 ? row.slice(0, 7) + '#' + row.slice(8) : row,
    );
    const room = roomWith([{ id: 'b', type: 'block', tile: [5, 4] }], { layout });
    const h = new Harness(room, 2);
    leftPushers(h);
    h.step({ frames: pushFrames(1, 0, [0, 1]) }, 120);
    expect(h.get<BlockState>('b').tile).toEqual([5, 4]);
    expect(h.get<BlockState>('b').moving).toBeNull();
    expect(h.get<BlockState>('b').pos).toEqual({ x: 5 * TILE, y: 4 * TILE });
  });

  it('un bloc est bloqué par une fosse, une porte fermée, un autre bloc et un joueur non pousseur', () => {
    const pitLayout = makeTestLayout(16, 12).map((row, y) => (y === 5 ? row.slice(0, 7) + '~' + row.slice(8) : row));
    const pitRoom = roomWith([{ id: 'b', type: 'block', tile: [5, 4] }], { layout: pitLayout });
    const hp = new Harness(pitRoom, 2);
    leftPushers(hp);
    hp.step({ frames: pushFrames(1, 0, [0, 1]) }, 80);
    expect(hp.get<BlockState>('b').tile).toEqual([5, 4]);

    const doorRoom = roomWith([
      { id: 'b', type: 'block', tile: [5, 4] },
      { id: 'd', type: 'door', tiles: [[7, 5]], requires: ['never'] },
    ]);
    const hd = new Harness(doorRoom, 2);
    leftPushers(hd);
    hd.step({ frames: pushFrames(1, 0, [0, 1]) }, 80);
    expect(hd.get<BlockState>('b').tile).toEqual([5, 4]);

    const twoBlocks = roomWith([
      { id: 'b', type: 'block', tile: [5, 4] },
      { id: 'c', type: 'block', tile: [7, 4] },
    ]);
    const hb = new Harness(twoBlocks, 2);
    leftPushers(hb);
    hb.step({ frames: pushFrames(1, 0, [0, 1]) }, 80);
    expect(hb.get<BlockState>('b').tile).toEqual([5, 4]);

    const room = roomWith([{ id: 'b', type: 'block', tile: [5, 4] }]);
    const h3 = new Harness(room, 3);
    leftPushers(h3);
    h3.put(2, [7, 4]); // joueur planté dans la zone cible
    h3.step({ frames: pushFrames(1, 0, [0, 1]) }, 80);
    expect(h3.get<BlockState>('b').tile).toEqual([5, 4]);
    h3.put(2, [3, 9]); // il s'écarte : le bloc peut bouger
    h3.step({ frames: pushFrames(1, 0, [0, 1]) }, 20);
    expect(h3.get<BlockState>('b').tile).toEqual([6, 4]);
  });

  it('un ennemi dans la zone cible bloque le bloc (enemyCircles)', () => {
    const room = roomWith([{ id: 'b', type: 'block', tile: [5, 4] }]);
    const h = new Harness(room, 2);
    leftPushers(h);
    for (let i = 0; i < 60; i++) {
      updateMechanisms({
        room,
        grid: h.grid,
        mechanisms: h.mechanisms,
        players: h.players,
        frames: pushFrames(1, 0, [0, 1]),
        interactPressed: {},
        dtMs: SIM_STEP_MS,
        aliveEnemyCount: 1,
        objectiveDone: () => false,
        zoneOccupied: () => false,
        enemyCircles: [{ x: 7.5 * TILE, y: 4.5 * TILE, r: 6 }],
      });
    }
    expect(h.get<BlockState>('b').tile).toEqual([5, 4]);
  });

  it('les blocs sont solides (position interpolée)', () => {
    const room = roomWith([{ id: 'b', type: 'block', tile: [5, 4] }]);
    const h = new Harness(room, 2);
    expect(mechanismSolidRects(room, h.mechanisms)).toEqual([{ x: 5 * TILE, y: 4 * TILE, w: 32, h: 32 }]);
    expect(mechanismBlocksProjectile(room, h.mechanisms, { x: 6 * TILE, y: 5 * TILE })).toBe(true);
    expect(mechanismBlocksProjectile(room, h.mechanisms, { x: 4 * TILE, y: 5 * TILE }, 2)).toBe(false);
  });

  it('un socket devient actif quand un bloc occupe exactement ses 4 tuiles (et seulement à l\'arrêt)', () => {
    const room = roomWith([
      { id: 'b', type: 'block', tile: [5, 4] },
      { id: 's', type: 'socket', tile: [7, 4] },
    ]);
    const h = new Harness(room, 2);
    leftPushers(h);
    expect(h.get<SocketState>('s').active).toBe(false);
    // on pousse jusqu'à ce que la cible logique soit atteinte, puis on relâche
    let ticks = 0;
    while (h.get<BlockState>('b').tile[0] < 7 && ticks++ < 300) {
      h.step({ frames: pushFrames(1, 0, [0, 1]) });
      expect(h.get<SocketState>('s').active).toBe(false);
    }
    h.step({}, 60);
    expect(h.get<BlockState>('b').tile).toEqual([7, 4]);
    expect(h.get<SocketState>('s').active).toBe(true);
    expect(h.allEvents).toContainEqual({ type: 'mechanismChanged', mechanismId: 's', active: true });
  });

  it('un socket avec blockId n\'accepte que ce bloc', () => {
    const room = roomWith([
      { id: 'b1', type: 'block', tile: [5, 4] },
      { id: 'b2', type: 'block', tile: [9, 7] },
      { id: 's', type: 'socket', tile: [5, 4], blockId: 'b2' },
    ]);
    const h = new Harness(room, 2);
    h.step();
    expect(h.get<SocketState>('s').active).toBe(false); // b1 est dessus mais ce n'est pas le bon
    const room2 = roomWith([
      { id: 'b1', type: 'block', tile: [5, 4] },
      { id: 's', type: 'socket', tile: [5, 4], blockId: 'b1' },
    ]);
    const h2 = new Harness(room2, 2);
    h2.step();
    expect(h2.get<SocketState>('s').active).toBe(true);
  });

  it('un socket minPlayers > nbJoueurs est waived (actif d\'office)', () => {
    const room = roomWith([
      { id: 'b', type: 'block', tile: [5, 4] },
      { id: 's', type: 'socket', tile: [9, 7], minPlayers: 3 },
    ]);
    const h = new Harness(room, 2);
    h.step();
    expect(h.get<SocketState>('s')).toMatchObject({ waived: true, active: true });
  });

  it('un bloc posé sur une plaque l\'active (pressedBy = "block")', () => {
    const room = roomWith([
      { id: 'b', type: 'block', tile: [5, 4] },
      { id: 'p', type: 'plate', tile: [7, 4] },
      { id: 'door', type: 'door', tiles: [[12, 5]], requires: ['p'] },
    ]);
    const h = new Harness(room, 2);
    leftPushers(h);
    h.step();
    expect(h.get<PlateState>('p').active).toBe(false);
    let ticks = 0;
    while (h.get<BlockState>('b').tile[0] < 6 && ticks++ < 100) h.step({ frames: pushFrames(1, 0, [0, 1]) });
    h.step({}, 60);
    expect(h.get<PlateState>('p').active).toBe(true);
    expect(h.get<PlateState>('p').pressedBy).toBe('block');
    expect(h.get<DoorState>('door').open).toBe(true);
  });
});

describe('activation des mécanismes — runes', () => {
  const room = roomWith([
    {
      id: 'rp',
      type: 'runePuzzle',
      displayTile: [7, 2],
      visibleToSlot: 0,
      sequence: ['moon', 'sun', 'star'],
      pedestals: [
        { symbol: 'sun', tile: [3, 8] },
        { symbol: 'moon', tile: [7, 8] },
        { symbol: 'star', tile: [11, 8] },
      ],
    },
    { id: 'door', type: 'door', tiles: [[12, 3]], requires: ['rp'] },
  ]);
  const sun: TileXY = [3, 8];
  const moon: TileXY = [7, 8];
  const star: TileXY = [11, 8];

  function press(h: Harness, who: PlayerId, at: TileXY): SimEvent[] {
    h.put(who, at);
    return h.step({ press: [who] });
  }

  it('la bonne séquence résout l\'énigme (progression + événements) et ouvre la porte liée', () => {
    const h = new Harness(room, 2);
    expect(press(h, 1, moon)).toContainEqual({ type: 'runeProgress', mechanismId: 'rp', progress: 1, ok: true });
    expect(h.get<RuneState>('rp').progress).toBe(1);
    expect(h.get<RuneState>('rp').lastPedestal).toBe(1);
    press(h, 0, sun);
    expect(h.get<RuneState>('rp').active).toBe(false);
    const ev = press(h, 1, star);
    expect(h.get<RuneState>('rp')).toMatchObject({ progress: 3, active: true });
    expect(ev).toContainEqual({ type: 'mechanismChanged', mechanismId: 'rp', active: true });
    expect(h.get<DoorState>('door').open).toBe(true);
    // définitif : appuyer ensuite ne change plus rien
    press(h, 0, sun);
    expect(h.get<RuneState>('rp')).toMatchObject({ progress: 3, active: true });
  });

  it('un mauvais ordre remet la progression à zéro avec un flash d\'erreur qui s\'estompe', () => {
    const h = new Harness(room, 2);
    press(h, 0, moon);
    press(h, 0, sun);
    expect(h.get<RuneState>('rp').progress).toBe(2);
    const ev = press(h, 0, sun); // mauvais : attendu 'star'
    expect(ev).toContainEqual({ type: 'runeProgress', mechanismId: 'rp', progress: 0, ok: false });
    expect(h.get<RuneState>('rp').progress).toBe(0);
    expect(h.get<RuneState>('rp').errorFlashMs).toBeGreaterThan(0);
    expect(h.get<RuneState>('rp').active).toBe(false);
    h.wait(1000);
    expect(h.get<RuneState>('rp').errorFlashMs).toBe(0);
    // on peut recommencer
    press(h, 0, moon);
    press(h, 0, sun);
    press(h, 0, star);
    expect(h.get<RuneState>('rp').active).toBe(true);
  });

  it('pas d\'effet hors de portée d\'un piédestal ou sans appui', () => {
    const h = new Harness(room, 1);
    h.put(0, moon);
    h.step({}, 5);
    expect(h.get<RuneState>('rp').progress).toBe(0);
    press(h, 0, [7, 4]);
    expect(h.get<RuneState>('rp').progress).toBe(0);
    expect(h.get<RuneState>('rp').errorFlashMs).toBe(0);
  });

  it('une énigme waived est résolue d\'office', () => {
    const r = roomWith([
      {
        id: 'rp',
        type: 'runePuzzle',
        displayTile: [7, 2],
        visibleToSlot: 0,
        sequence: ['sun'],
        pedestals: [{ symbol: 'sun', tile: [3, 8] }],
        minPlayers: 2,
      },
    ]);
    expect(new Harness(r, 1).get<RuneState>('rp')).toMatchObject({ waived: true, active: true, progress: 1 });
  });
});

describe('une même interaction n\'est consommée que par un mécanisme', () => {
  it('lever > rune : un appui à portée des deux n\'actionne que le levier', () => {
    const r = roomWith([
      { id: 'L', type: 'lever', tile: [5, 5] },
      {
        id: 'rp',
        type: 'runePuzzle',
        displayTile: [7, 2],
        visibleToSlot: 0,
        sequence: ['sun'],
        pedestals: [{ symbol: 'sun', tile: [6, 5] }],
      },
    ]);
    const h = new Harness(r, 1);
    h.players[0].pos = { x: 5.5 * TILE + 2, y: 5.5 * TILE };
    h.step({ press: [0] });
    expect(h.get<LeverState>('L').active).toBe(true);
    expect(h.get<RuneState>('rp').progress).toBe(0);
  });
});

// ───────────────────────────── Exigences ─────────────────────────────

describe('isRequirementMet / areAllRequirementsMet', () => {
  const room = roomWith([
    { id: 'p', type: 'plate', tile: [4, 3] },
    { id: 'w', type: 'plate', tile: [5, 3], minPlayers: 3 },
  ]);
  const mechanisms = createRoomMechanisms(room, 2);
  const make = (over: Partial<RequirementContext> = {}): RequirementContext => ({
    mechanisms,
    aliveEnemyCount: 0,
    objectiveDone: () => false,
    zoneOccupied: () => false,
    ...over,
  });

  it("'clear' dépend du nombre d'ennemis vivants", () => {
    expect(isRequirementMet('clear', make({ aliveEnemyCount: 0 }))).toBe(true);
    expect(isRequirementMet('clear', make({ aliveEnemyCount: 3 }))).toBe(false);
  });

  it("'obj:<id>' interroge objectiveDone", () => {
    const ctx = make({ objectiveDone: (id) => id === 'o1' });
    expect(isRequirementMet('obj:o1', ctx)).toBe(true);
    expect(isRequirementMet('obj:o2', ctx)).toBe(false);
  });

  it("'zone:<id>' interroge zoneOccupied", () => {
    const ctx = make({ zoneOccupied: (id) => id === 'z1' });
    expect(isRequirementMet('zone:z1', ctx)).toBe(true);
    expect(isRequirementMet('zone:z2', ctx)).toBe(false);
  });

  it('un id de mécanisme : actif ou waived ⇒ vrai ; inactif ou inconnu ⇒ faux', () => {
    expect(isRequirementMet('p', make())).toBe(false);
    expect(isRequirementMet('w', make())).toBe(true);
    expect(isRequirementMet('inconnu', make())).toBe(false);
    (mechanisms[0] as PlateState).active = true;
    expect(isRequirementMet('p', make())).toBe(true);
    (mechanisms[0] as PlateState).active = false;
  });

  it('areAllRequirementsMet : conjonction (liste vide ⇒ vrai)', () => {
    expect(areAllRequirementsMet([], make())).toBe(true);
    expect(areAllRequirementsMet(['clear', 'w'], make())).toBe(true);
    expect(areAllRequirementsMet(['clear', 'p'], make())).toBe(false);
    expect(areAllRequirementsMet(['clear', 'obj:x'], make({ objectiveDone: () => true }))).toBe(true);
  });
});

describe('déterminisme', () => {
  it('mêmes entrées ⇒ mêmes états et événements', () => {
    const room = roomWith([
      { id: 'b', type: 'block', tile: [5, 4] },
      { id: 'p', type: 'plate', tile: [7, 4] },
    ]);
    const run = (): string => {
      const h = new Harness(room, 2);
      h.players[0].pos = { x: 5 * TILE - PLAYER_RADIUS - 1, y: 4 * TILE + 8 };
      h.players[1].pos = { x: 5 * TILE - PLAYER_RADIUS - 1, y: 4 * TILE + 24 };
      h.step({ frames: { 0: mv(1, 0), 1: mv(1, 0) } }, 120);
      return JSON.stringify([h.mechanisms, h.players, h.allEvents]);
    };
    expect(run()).toBe(run());
  });
});
