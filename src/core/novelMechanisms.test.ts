/**
 * Tests des 3 mécanismes inédits (niveaux 4-6) : statues jumelles, sablier partagé, pont de lumière.
 * Harnais direct sur `updateMechanisms` (comme mechanisms.test.ts) + quelques scénarios via `GameSimulation`.
 */
import { describe, expect, it } from 'vitest';
import { PLAYER_RADIUS, SIM_STEP_MS, TILE, TORCH_MAX_MS } from './constants';
import { RoomGrid } from './grid';
import { makeTestLayout, makeTestLevel, makeTestRoom, validateLevel } from './levelValidation';
import {
  areAllRequirementsMet,
  createRoomMechanisms,
  effectiveHourglassPeriodMs,
  hourglassLeverIndex,
  isMechanismSolved,
  isRequirementMet,
  isTileBlockedByMechanism,
  lightBridgeBearer,
  mechanismBlocksProjectile,
  mechanismSolidRects,
  rotateClockwise,
  statueRotationTarget,
  tileCenterPx,
  updateMechanisms,
  type Circle,
  type RequirementContext,
} from './mechanisms';
import { createSimulation } from './simulation';
import type {
  ActionFrame,
  BlockState,
  BrazierState,
  Dir,
  HourglassDef,
  HourglassState,
  LevelDef,
  LightBridgeState,
  MechanismDef,
  MechanismState,
  PlayerId,
  PlayerState,
  RoomDef,
  SimEvent,
  StatuePairDef,
  StatuePairState,
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
  enemyCircles?: Circle[];
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

  /** Un pas (ou `ticks` pas) ; l'appui d'interaction n'a lieu qu'au premier pas (front montant). */
  step(opts: StepOpts = {}, ticks = 1): SimEvent[] {
    const out: SimEvent[] = [];
    for (let i = 0; i < ticks; i++) {
      const interactPressed: Partial<Record<PlayerId, boolean>> = {};
      if (i === 0) for (const id of opts.press ?? []) interactPressed[id] = true;
      out.push(
        ...updateMechanisms({
          room: this.room,
          grid: this.grid,
          mechanisms: this.mechanisms,
          players: this.players,
          frames: opts.frames ?? {},
          interactPressed,
          dtMs: SIM_STEP_MS,
          aliveEnemyCount: 0,
          objectiveDone: () => false,
          zoneOccupied: () => false,
          enemyCircles: opts.enemyCircles,
        }),
      );
    }
    this.allEvents.push(...out);
    return out;
  }

  wait(ms: number, opts: StepOpts = {}): SimEvent[] {
    return this.step({ ...opts, press: [] }, Math.ceil(ms / SIM_STEP_MS - 1e-9));
  }

  /** Avance pas à pas jusqu'à `pred` (au plus `maxMs`) ; retourne les événements cumulés. */
  until(pred: () => boolean, maxMs: number, opts: StepOpts = {}): SimEvent[] {
    const out: SimEvent[] = [];
    for (let t = 0; t < maxMs && !pred(); t += SIM_STEP_MS) out.push(...this.step({ ...opts, press: [] }));
    return out;
  }

  get<T extends MechanismState>(id: string): T {
    const s = this.mechanisms.find((m) => m.id === id);
    if (!s) throw new Error(`mécanisme introuvable ${id}`);
    return s as T;
  }

  get solids() {
    return mechanismSolidRects(this.room, this.mechanisms);
  }

  get ctx(): RequirementContext {
    return {
      mechanisms: this.mechanisms,
      aliveEnemyCount: 0,
      objectiveDone: () => false,
      zoneOccupied: () => false,
    };
  }
}

function roomWith(mechanisms: MechanismDef[], over: Partial<RoomDef> = {}): RoomDef {
  return makeTestRoom({ layout: makeTestLayout(16, 12), mechanisms, ...over });
}

const tileRectOf = (t: TileXY) => ({ x: t[0] * TILE, y: t[1] * TILE, w: TILE, h: TILE });

// ───────────────────────────── Statues jumelles ─────────────────────────────

const STATUES: StatuePairDef = {
  id: 'sp',
  type: 'statuePair',
  statues: [
    { tile: [4, 4], standTile: [4, 6], facing: 'up' },
    { tile: [11, 4], standTile: [11, 6], facing: 'left' },
  ],
  targetDir: 'down',
};

describe('statues jumelles — création, rotation, résolution', () => {
  const room = roomWith([STATUES]);

  it('état initial : orientations de la définition, non résolue, aucune rotation', () => {
    const [st] = createRoomMechanisms(room, 2);
    expect(st).toEqual({
      id: 'sp',
      type: 'statuePair',
      waived: false,
      active: false,
      facings: ['up', 'left'],
      lastRotated: -1,
    });
  });

  it('waived (minPlayers > nbJoueurs) : les deux statues regardent targetDir, mécanisme résolu', () => {
    const r = roomWith([{ ...STATUES, minPlayers: 3 }]);
    const [st] = createRoomMechanisms(r, 2) as [StatuePairState];
    expect(st.waived).toBe(true);
    expect(st.active).toBe(true);
    expect(st.facings).toEqual(['down', 'down']);
    expect(isMechanismSolved(st)).toBe(true);
    const [real] = createRoomMechanisms(r, 3) as [StatuePairState];
    expect(real.waived).toBe(false);
    expect(real.facings).toEqual(['up', 'left']);
  });

  it('rotateClockwise : up → right → down → left → up', () => {
    const seq: Dir[] = ['up'];
    for (let i = 0; i < 4; i++) seq.push(rotateClockwise(seq[i]));
    expect(seq).toEqual(['up', 'right', 'down', 'left', 'up']);
  });

  it('un joueur sur le socle de la statue 0 fait pivoter la statue 1 (sens horaire) et pas la sienne', () => {
    const h = new Harness(room, 2);
    h.put(0, [4, 6]);
    const ev = h.step({ press: [0] });
    expect(h.get<StatuePairState>('sp').facings).toEqual(['up', 'up']);
    expect(h.get<StatuePairState>('sp').lastRotated).toBe(1);
    expect(ev).toContainEqual({ type: 'statueRotated', mechanismId: 'sp', index: 1, facing: 'up', playerId: 0 });
    h.step({ press: [0] });
    expect(h.get<StatuePairState>('sp').facings).toEqual(['up', 'right']);
    h.step({ press: [0] });
    expect(h.get<StatuePairState>('sp').facings).toEqual(['up', 'down']);
    expect(h.get<StatuePairState>('sp').active).toBe(false);
  });

  it('le socle de la statue 1 fait pivoter la statue 0', () => {
    const h = new Harness(room, 2);
    h.put(1, [11, 6]);
    const ev = h.step({ press: [1] });
    expect(h.get<StatuePairState>('sp').facings).toEqual(['right', 'left']);
    expect(h.get<StatuePairState>('sp').lastRotated).toBe(0);
    expect(ev).toContainEqual({ type: 'statueRotated', mechanismId: 'sp', index: 0, facing: 'right', playerId: 1 });
  });

  it('sans effet : hors socle, tuile voisine, joueur à terre, pas d\'appui', () => {
    const h = new Harness(room, 2);
    h.put(0, [4, 7]); // voisin du socle
    expect(h.step({ press: [0] })).toEqual([]);
    h.put(0, [4, 4]); // sur la statue elle-même (téléporté pour le test)
    expect(h.step({ press: [0] })).toEqual([]);
    h.put(0, [4, 6]);
    expect(h.step({})).toEqual([]); // pas d'appui : rien
    h.players[0].status = 'down';
    expect(h.step({ press: [0] })).toEqual([]);
    expect(h.get<StatuePairState>('sp').facings).toEqual(['up', 'left']);
    expect(statueRotationTarget(STATUES, h.get<StatuePairState>('sp'), h.players[0])).toBeNull();
  });

  it('la tuile du socle est la tuile logique floor(pos/TILE) : un décalage à l\'intérieur de la tuile compte, un pixel dehors non', () => {
    const h = new Harness(room, 2);
    h.players[0].pos = { x: 4 * TILE + 0.1, y: 6 * TILE + 15.9 };
    h.step({ press: [0] });
    expect(h.get<StatuePairState>('sp').facings[1]).toBe('up');
    h.players[0].pos = { x: 4 * TILE - 0.1, y: 6 * TILE + 8 };
    h.step({ press: [0] });
    expect(h.get<StatuePairState>('sp').facings[1]).toBe('up'); // inchangée
  });

  it('résolue quand les deux regardent targetDir : événements, verrouillage (plus de rotation), jeton d\'exigence', () => {
    const h = new Harness(room, 2);
    h.put(0, [4, 6]);
    h.put(1, [11, 6]);
    h.step({ press: [0] }, 1);
    h.step({ press: [0] }, 1);
    h.step({ press: [1] }, 1);
    expect(h.get<StatuePairState>('sp').active).toBe(false);
    const evs = [...h.step({ press: [0] }), ...h.step({ press: [1] })];
    const sp = h.get<StatuePairState>('sp');
    expect(sp.facings).toEqual(['down', 'down']);
    expect(sp.active).toBe(true);
    expect(evs).toContainEqual({ type: 'mechanismChanged', mechanismId: 'sp', active: true });
    expect(isRequirementMet('sp', h.ctx)).toBe(true);
    // verrouillée
    expect(h.step({ press: [0] })).toEqual([]);
    expect(h.step({ press: [1] })).toEqual([]);
    expect(h.get<StatuePairState>('sp').facings).toEqual(['down', 'down']);
    expect(h.get<StatuePairState>('sp').active).toBe(true);
  });

  it('1 joueur seul peut résoudre l\'énigme en alternant les deux socles ; idem à 2, 3 et 4 joueurs', () => {
    for (let n = 1; n <= 4; n++) {
      const h = new Harness(room, n);
      let guard = 0;
      while (!h.get<StatuePairState>('sp').active && guard++ < 20) {
        const f = h.get<StatuePairState>('sp').facings;
        const solver = h.players[(guard % n) as PlayerId];
        if (f[1] !== 'down') {
          h.put(solver.id, [4, 6]);
          h.step({ press: [solver.id] });
        } else {
          h.put(solver.id, [11, 6]);
          h.step({ press: [solver.id] });
        }
      }
      expect(h.get<StatuePairState>('sp').active, `n=${n}`).toBe(true);
      expect(guard).toBe(5);
    }
  });

  it('un seul joueur ne peut pas être sur les deux socles : deux joueurs agissent simultanément sur les deux statues', () => {
    const h = new Harness(room, 2);
    h.put(0, [4, 6]);
    h.put(1, [11, 6]);
    h.step({ press: [0, 1] });
    expect(h.get<StatuePairState>('sp').facings).toEqual(['right', 'up']);
  });

  it('une statue déjà orientée vers targetDir au départ est résolue dès la création', () => {
    const r = roomWith([{ ...STATUES, statues: [{ ...STATUES.statues[0], facing: 'down' }, { ...STATUES.statues[1], facing: 'down' }] }]);
    const [st] = createRoomMechanisms(r, 2);
    expect(st.active).toBe(true);
    expect(st.waived).toBe(false);
  });
});

describe('statues jumelles — solidité', () => {
  const room = roomWith([STATUES]);

  it('chaque statue est un solide d\'une tuile, même waived', () => {
    for (const waivedRoom of [room, roomWith([{ ...STATUES, minPlayers: 4 }])]) {
      const states = createRoomMechanisms(waivedRoom, 2);
      const rects = mechanismSolidRects(waivedRoom, states);
      expect(rects).toEqual([tileRectOf([4, 4]), tileRectOf([11, 4])]);
    }
  });

  it('isTileBlockedByMechanism / mechanismBlocksProjectile voient les statues, pas les socles', () => {
    const states = createRoomMechanisms(room, 2);
    expect(isTileBlockedByMechanism(room, states, 4, 4)).toBe(true);
    expect(isTileBlockedByMechanism(room, states, 11, 4)).toBe(true);
    expect(isTileBlockedByMechanism(room, states, 4, 6)).toBe(false);
    expect(mechanismBlocksProjectile(room, states, tileCenterPx([4, 4]), 0)).toBe(true);
    expect(mechanismBlocksProjectile(room, states, tileCenterPx([4, 6]), 2)).toBe(false);
  });

  it('un bloc poussé ne s\'engage pas sur une tuile de statue', () => {
    const r = roomWith([
      { id: 'b', type: 'block', tile: [5, 4] },
      { id: 'sp', type: 'statuePair', statues: [{ tile: [7, 5], standTile: [2, 8], facing: 'up' }, { tile: [12, 8], standTile: [13, 8], facing: 'left' }], targetDir: 'down' },
    ]);
    const h = new Harness(r, 2);
    const x = 5 * TILE - PLAYER_RADIUS - 1;
    h.players[0].pos = { x, y: 4 * TILE + 8 };
    h.players[1].pos = { x, y: 4 * TILE + 24 };
    h.step({ frames: { 0: mv(1, 0), 1: mv(1, 0) } }, 100);
    expect(h.get<BlockState>('b').tile).toEqual([5, 4]);
    expect(h.get<BlockState>('b').moving).toBeNull();
  });
});

// ───────────────────────────── Sablier ─────────────────────────────

const HG: HourglassDef = {
  id: 'hg',
  type: 'hourglass',
  levers: [
    [3, 5],
    [13, 5],
  ],
  gate: [
    [8, 3],
    [8, 4],
    [8, 5],
    [8, 6],
  ],
  periodMs: 3000,
  closeStepMs: 500,
  displayTile: [8, 2],
};

describe('sablier — création et période effective', () => {
  const room = roomWith([HG]);

  it('état initial (non waived) : sable 0, herse entièrement fermée, inactif', () => {
    const [st] = createRoomMechanisms(room, 2);
    expect(st).toEqual({ id: 'hg', type: 'hourglass', waived: false, active: false, sandMs: 0, closedCount: 4, stepMs: 0, lastLever: -1 });
    expect(mechanismSolidRects(room, [st])).toEqual(HG.gate.map(tileRectOf));
  });

  it('waived : herse ouverte en permanence, sable plein (période effective) qui ne s\'écoule pas', () => {
    const r = roomWith([{ ...HG, minPlayers: 3 }]);
    const [st2] = createRoomMechanisms(r, 2) as [HourglassState];
    expect(st2).toMatchObject({ waived: true, active: true, sandMs: 3000, closedCount: 0 });
    const [st1] = createRoomMechanisms(r, 1) as [HourglassState];
    expect(st1.sandMs).toBe(6000);
    const h = new Harness(r, 2);
    h.wait(10_000);
    expect(h.get<HourglassState>('hg')).toMatchObject({ active: true, sandMs: 3000, closedCount: 0 });
    expect(h.solids).toEqual([]);
    expect(isRequirementMet('hg', h.ctx)).toBe(true);
    expect(h.allEvents).toEqual([]);
  });

  it('effectiveHourglassPeriodMs : × 2 en solo, ×1 sinon', () => {
    expect(effectiveHourglassPeriodMs(HG, 1)).toBe(6000);
    expect(effectiveHourglassPeriodMs(HG, 2)).toBe(3000);
    expect(effectiveHourglassPeriodMs(HG, 3)).toBe(3000);
    expect(effectiveHourglassPeriodMs(HG, 4)).toBe(3000);
  });
});

describe('sablier — retournement', () => {
  const room = roomWith([HG]);

  it('interact à portée d\'un levier : sable = période, herse rouverte d\'un coup, événements', () => {
    const h = new Harness(room, 2);
    h.put(0, [3, 5]);
    const ev = h.step({ press: [0] });
    expect(h.get<HourglassState>('hg')).toMatchObject({ active: true, sandMs: 3000, closedCount: 0, lastLever: 0 });
    expect(ev).toContainEqual({ type: 'hourglassFlipped', mechanismId: 'hg', leverIndex: 0, playerId: 0 });
    expect(ev).toContainEqual({ type: 'mechanismChanged', mechanismId: 'hg', active: true });
    expect(h.solids).toEqual([]);
    expect(isRequirementMet('hg', h.ctx)).toBe(true);
  });

  it('le second levier fonctionne aussi (leverIndex 1) ; hors de portée ou à terre : rien', () => {
    const h = new Harness(room, 2);
    h.put(1, [13, 7]); // à 2 tuiles
    expect(h.step({ press: [1] })).toEqual([]);
    h.put(1, [13, 5]);
    h.players[1].status = 'down';
    expect(h.step({ press: [1] })).toEqual([]);
    h.players[1].status = 'alive';
    const ev = h.step({ press: [1] });
    expect(ev).toContainEqual({ type: 'hourglassFlipped', mechanismId: 'hg', leverIndex: 1, playerId: 1 });
    expect(h.get<HourglassState>('hg').lastLever).toBe(1);
    expect(hourglassLeverIndex(HG, h.players[1])).toBe(1);
    expect(hourglassLeverIndex(HG, h.players[0])).toBe(-1);
  });

  it('un retournement avant la fin du sable remet le sable à la période sans jamais émettre hourglassEmpty', () => {
    const h = new Harness(room, 2);
    h.put(0, [3, 5]);
    h.step({ press: [0] });
    const ev = h.wait(2800, {});
    expect(h.get<HourglassState>('hg').sandMs).toBeGreaterThan(100);
    h.step({ press: [0] });
    expect(h.get<HourglassState>('hg').sandMs).toBe(3000);
    h.wait(2800);
    expect([...ev, ...h.allEvents].some((e) => e.type === 'hourglassEmpty')).toBe(false);
  });

  it('solo : sable = période × 2', () => {
    const h = new Harness(room, 1);
    h.put(0, [3, 5]);
    h.step({ press: [0] });
    expect(h.get<HourglassState>('hg').sandMs).toBe(6000);
    h.wait(3500);
    expect(h.get<HourglassState>('hg').active).toBe(true); // encore du sable après 3,5 s (il aurait fini à 3 s à 2 joueurs)
    h.wait(2600);
    expect(h.get<HourglassState>('hg').active).toBe(false);
  });

  it('un appui hors portée d\'un levier ne retourne rien même si le joueur est près de la herse', () => {
    const h = new Harness(room, 2);
    h.put(0, [8, 8]);
    expect(h.step({ press: [0] })).toEqual([]);
  });
});

describe('sablier — écoulement et fermeture progressive', () => {
  const room = roomWith([HG]);

  function flipped(n = 2): Harness {
    const h = new Harness(room, n);
    h.put(0, [3, 5]);
    h.step({ press: [0] });
    h.put(0, [2, 8]); // loin de la herse
    return h;
  }

  it('le sable s\'écoule avec dtMs', () => {
    const h = flipped();
    h.wait(1000);
    expect(Math.abs(h.get<HourglassState>('hg').sandMs - 2000)).toBeLessThan(25);
  });

  it('sable à 0 : hourglassEmpty UNE fois, active=false, puis une tuile toutes les closeStepMs dans l\'ordre de gate', () => {
    const h = flipped();
    const empty: SimEvent[] = [];
    const closes: { at: number; count: number }[] = [];
    let t = 0;
    for (; t < 3000 + 4 * 500 + 800; t += SIM_STEP_MS) {
      const ev = h.step();
      empty.push(...ev.filter((e) => e.type === 'hourglassEmpty'));
      for (const e of ev) if (e.type === 'gateClosed') closes.push({ at: t, count: e.closedCount });
    }
    expect(empty).toHaveLength(1);
    expect(closes.map((c) => c.count)).toEqual([1, 2, 3, 4]);
    // premier fermeture ≈ 3000 + 500 ms ; espacement ≈ 500 ms
    expect(closes[0].at).toBeGreaterThan(3400);
    expect(closes[0].at).toBeLessThan(3650);
    for (let i = 1; i < closes.length; i++) {
      expect(closes[i].at - closes[i - 1].at).toBeGreaterThan(480);
      expect(closes[i].at - closes[i - 1].at).toBeLessThan(540);
    }
    const st = h.get<HourglassState>('hg');
    expect(st).toMatchObject({ active: false, sandMs: 0, closedCount: 4 });
    expect(h.solids).toEqual(HG.gate.map(tileRectOf));
    expect(h.allEvents).toContainEqual({ type: 'mechanismChanged', mechanismId: 'hg', active: false });
  });

  it('les tuiles fermées deviennent solides une à une (mechanismSolidRects, isTileBlockedByMechanism, projectiles)', () => {
    const h = flipped();
    h.until(() => h.get<HourglassState>('hg').closedCount === 2, 6000);
    expect(h.solids).toEqual([tileRectOf([8, 3]), tileRectOf([8, 4])]);
    expect(isTileBlockedByMechanism(room, h.mechanisms, 8, 3)).toBe(true);
    expect(isTileBlockedByMechanism(room, h.mechanisms, 8, 5)).toBe(false);
    expect(mechanismBlocksProjectile(room, h.mechanisms, tileCenterPx([8, 4]), 0)).toBe(true);
    expect(mechanismBlocksProjectile(room, h.mechanisms, tileCenterPx([8, 5]), 0)).toBe(false);
  });

  it('un joueur vivant sur une tuile de herse empêche sa fermeture (et celle des suivantes) tant qu\'il l\'occupe', () => {
    const h = flipped();
    h.put(0, [8, 4]); // sur la deuxième tuile
    h.until(() => h.get<HourglassState>('hg').sandMs === 0, 4000);
    h.wait(5000);
    const st = h.get<HourglassState>('hg');
    expect(st.closedCount).toBe(1); // tuile 0 fermée, tuile 1 occupée → attente
    expect(st.stepMs).toBe(0);
    expect(h.solids).toEqual([tileRectOf([8, 3])]);
    // il s'éloigne : la fermeture reprend dès le pas suivant (chrono à 0), puis tuile par tuile
    h.put(0, [6, 8]);
    h.step();
    expect(h.get<HourglassState>('hg').closedCount).toBe(2);
    h.wait(1200);
    expect(h.get<HourglassState>('hg').closedCount).toBe(4);
  });

  it('un disque qui déborde seulement sur la tuile compte comme occupant ; un contact tangent non', () => {
    const h = flipped();
    h.until(() => h.get<HourglassState>('hg').sandMs === 0, 4000);
    // joueur dans la colonne 7, tout près de la colonne 8 : déborde sur la tuile de herse 0 (8,3)
    h.players[0].pos = { x: 8 * TILE - PLAYER_RADIUS + 1, y: 3 * TILE + 8 };
    h.wait(3000);
    expect(h.get<HourglassState>('hg').closedCount).toBe(0);
    h.players[0].pos = { x: 8 * TILE - PLAYER_RADIUS, y: 3 * TILE + 8 }; // tangent
    h.step();
    expect(h.get<HourglassState>('hg').closedCount).toBe(1);
  });

  it('un ennemi (enemyCircles) sur une tuile de herse empêche sa fermeture', () => {
    const h = flipped();
    const c = tileCenterPx([8, 3]);
    const enemy: Circle = { x: c.x, y: c.y, r: 6 };
    h.until(() => h.get<HourglassState>('hg').sandMs === 0, 4000, { enemyCircles: [enemy] });
    h.wait(3000, { enemyCircles: [enemy] });
    expect(h.get<HourglassState>('hg').closedCount).toBe(0);
    h.step({ enemyCircles: [] });
    expect(h.get<HourglassState>('hg').closedCount).toBe(1);
  });

  it('un joueur à terre ne retarde pas la fermeture (document : seuls les joueurs VIVANTS comptent)', () => {
    const h = flipped();
    h.put(1, [8, 3]);
    h.players[1].status = 'down';
    h.until(() => h.get<HourglassState>('hg').closedCount >= 1, 6000);
    expect(h.get<HourglassState>('hg').closedCount).toBe(1);
  });

  it('un bloc sur une tuile de herse empêche sa fermeture', () => {
    const r = roomWith([HG, { id: 'b', type: 'block', tile: [7, 3] }]); // bloc 2×2 couvre (7..8, 3..4)
    const h = new Harness(r, 2);
    h.put(0, [3, 5]);
    h.step({ press: [0] });
    h.put(0, [2, 8]);
    h.until(() => h.get<HourglassState>('hg').sandMs === 0, 4000);
    h.wait(3000);
    expect(h.get<HourglassState>('hg').closedCount).toBe(0);
  });

  it('réouverture d\'un coup en cours de fermeture, avec chrono et sable remis', () => {
    const h = flipped();
    h.until(() => h.get<HourglassState>('hg').closedCount === 3, 8000);
    expect(h.solids).toHaveLength(3);
    h.put(1, [13, 5]);
    const ev = h.step({ press: [1] });
    const st = h.get<HourglassState>('hg');
    expect(st).toMatchObject({ active: true, sandMs: 3000, closedCount: 0, stepMs: 500, lastLever: 1 });
    expect(h.solids).toEqual([]);
    expect(ev).toContainEqual({ type: 'hourglassFlipped', mechanismId: 'hg', leverIndex: 1, playerId: 1 });
    // nouvel écoulement : hourglassEmpty est émis de nouveau
    const ev2 = h.until(() => h.get<HourglassState>('hg').sandMs === 0, 4000);
    expect(ev2.filter((e) => e.type === 'hourglassEmpty')).toHaveLength(1);
  });

  it('closeStepMs par défaut : 700 ms', () => {
    const r = roomWith([{ ...HG, closeStepMs: undefined }]);
    const h = new Harness(r, 2);
    h.put(0, [3, 5]);
    h.step({ press: [0] });
    h.put(0, [2, 8]);
    h.until(() => h.get<HourglassState>('hg').sandMs === 0, 4000);
    const t0 = h.allEvents.length;
    let t = 0;
    while (h.get<HourglassState>('hg').closedCount < 1 && t < 2000) {
      h.step();
      t += SIM_STEP_MS;
    }
    expect(t).toBeGreaterThan(680);
    expect(t).toBeLessThan(740);
    expect(h.allEvents.slice(t0).some((e) => e.type === 'gateClosed')).toBe(true);
  });

  it('relais : deux joueurs retournent le sablier à tour de rôle, la herse reste ouverte', () => {
    const h = new Harness(room, 2);
    let who = 0;
    for (let round = 0; round < 6; round++) {
      h.put(who as PlayerId, who === 0 ? [3, 5] : [13, 5]);
      h.step({ press: [who as PlayerId] });
      h.wait(2000); // avant la fin du sable (3000)
      expect(h.get<HourglassState>('hg').closedCount).toBe(0);
      who = 1 - who;
    }
    expect(h.allEvents.some((e) => e.type === 'hourglassEmpty')).toBe(false);
  });
});

describe('sablier — priorité d\'interaction', () => {
  it('statue > sablier : un appui sur un socle voisin d\'un levier de sablier fait pivoter la statue seulement', () => {
    const r = roomWith([
      STATUES,
      { ...HG, id: 'hg', levers: [[5, 6], [13, 5]] },
    ]);
    const h = new Harness(r, 2);
    h.put(0, [4, 6]); // socle de la statue 0 ; levier du sablier à 1 tuile
    const ev = h.step({ press: [0] });
    expect(ev.some((e) => e.type === 'statueRotated')).toBe(true);
    expect(ev.some((e) => e.type === 'hourglassFlipped')).toBe(false);
    expect(h.get<HourglassState>('hg').sandMs).toBe(0);
    // statue résolue (verrouillée) : l'appui passe au sablier
    const s = h.get<StatuePairState>('sp');
    s.facings = ['down', 'down'];
    s.active = true;
    const ev2 = h.step({ press: [0] });
    expect(ev2.some((e) => e.type === 'hourglassFlipped')).toBe(true);
  });

  it('levier > statue : un levier simple à portée du socle consomme l\'appui', () => {
    const r = roomWith([STATUES, { id: 'lv', type: 'lever', tile: [4, 7] }]);
    const h = new Harness(r, 2);
    h.put(0, [4, 6]);
    h.step({ press: [0] });
    expect(h.get<StatuePairState>('sp').facings).toEqual(['up', 'left']);
    expect(h.get<MechanismState>('lv').active).toBe(true);
  });

  it('sablier > brasero : l\'appui retourne le sablier et n\'allume pas le brasero voisin', () => {
    const r = roomWith([
      { ...HG, levers: [[6, 6], [13, 5]] },
      { id: 'br', type: 'brazier', tile: [6, 7] },
    ]);
    const h = new Harness(r, 2);
    h.put(0, [6, 6]);
    const ev = h.step({ press: [0] });
    expect(ev.some((e) => e.type === 'hourglassFlipped')).toBe(true);
    expect(ev.some((e) => e.type === 'brazierLit')).toBe(false);
    expect(h.get<BrazierState>('br').active).toBe(false);
  });
});

// ───────────────────────────── Pont de lumière ─────────────────────────────

const BRIDGE_TILES: TileXY[] = [
  [6, 5],
  [7, 5],
  [8, 5],
  [9, 5],
  [10, 5],
  [11, 5],
];

function bridgeRoom(over: Record<string, unknown> = {}): RoomDef {
  return roomWith([{ id: 'br', type: 'lightBridge', tiles: BRIDGE_TILES, lanternSlot: 1, radiusTiles: 2, ...over } as MechanismDef]);
}

describe('pont de lumière — création et halo', () => {
  it('état initial : aucun porteur, tout éteint (donc solide), inactif', () => {
    const room = bridgeRoom();
    const [st] = createRoomMechanisms(room, 2);
    expect(st).toEqual({ id: 'br', type: 'lightBridge', waived: false, active: false, bearerId: null, lit: [false, false, false, false, false, false] });
    expect(mechanismSolidRects(room, [st])).toHaveLength(6);
  });

  it('les tuiles à ≤ radiusTiles × TILE du porteur sont éclairées, les autres sont solides', () => {
    const room = bridgeRoom();
    const h = new Harness(room, 2); // porteur = joueur 1 (lanternSlot 1)
    h.put(1, [8, 5]);
    const ev = h.step();
    const st = h.get<LightBridgeState>('br');
    expect(st.bearerId).toBe(1);
    expect(st.lit).toEqual([true, true, true, true, true, false]); // (6..10) à ≤ 32 px, 11 à 48 px
    expect(st.active).toBe(true);
    expect(ev).toContainEqual({ type: 'mechanismChanged', mechanismId: 'br', active: true });
    expect(h.solids).toEqual([tileRectOf([11, 5])]);
    expect(isTileBlockedByMechanism(room, h.mechanisms, 11, 5)).toBe(true);
    expect(isTileBlockedByMechanism(room, h.mechanisms, 8, 5)).toBe(false);
    expect(mechanismBlocksProjectile(room, h.mechanisms, tileCenterPx([11, 5]), 0)).toBe(true);
    expect(mechanismBlocksProjectile(room, h.mechanisms, tileCenterPx([9, 5]), 0)).toBe(false);
  });

  it('le halo suit le porteur ; il s\'éteint derrière lui', () => {
    const h = new Harness(bridgeRoom(), 2);
    h.put(1, [6, 5]);
    h.step();
    expect(h.get<LightBridgeState>('br').lit).toEqual([true, true, true, false, false, false]);
    h.put(1, [10, 5]);
    h.step();
    expect(h.get<LightBridgeState>('br').lit).toEqual([false, false, true, true, true, true]);
  });

  it('une tuile hors halo mais occupée par un joueur vivant reste éclairée ; elle s\'éteint quand il part', () => {
    const h = new Harness(bridgeRoom(), 2);
    h.put(1, [6, 5]);
    h.put(0, [11, 5]); // loin du halo
    h.step();
    expect(h.get<LightBridgeState>('br').lit).toEqual([true, true, true, false, false, true]);
    expect(h.get<LightBridgeState>('br').active).toBe(true);
    h.put(0, [2, 8]);
    h.step();
    expect(h.get<LightBridgeState>('br').lit[5]).toBe(false);
  });

  it('un joueur dont le seul éclairage est l\'occupation ne rend pas le pont actif (active = éclairé PAR le porteur)', () => {
    const h = new Harness(bridgeRoom(), 2);
    h.put(1, [2, 8]); // porteur loin du pont
    h.put(0, [8, 5]);
    h.step();
    const st = h.get<LightBridgeState>('br');
    expect(st.bearerId).toBe(1);
    expect(st.lit).toEqual([false, false, true, false, false, false]);
    expect(st.active).toBe(false);
    expect(isMechanismSolved(st)).toBe(true); // porteur vivant ⇒ exigence satisfaite
  });

  it('porteur à terre : le joueur vivant le plus proche reprend la lanterne (pas d\'impasse) ; le porteur à terre n\'éclaire pas', () => {
    const h = new Harness(bridgeRoom(), 2);
    h.put(1, [8, 5]);
    h.put(0, [7, 5]);
    h.step();
    expect(h.get<LightBridgeState>('br').bearerId).toBe(1);
    h.players[1].status = 'down';
    h.step();
    const st = h.get<LightBridgeState>('br');
    expect(st.bearerId).toBe(0); // J0 (vivant) reprend la lanterne
    expect(st.active).toBe(true);
    expect(st.lit).toEqual([true, true, true, true, false, false]); // halo de J0 en [7,5] : tuiles 6..9
    expect(isMechanismSolved(st)).toBe(true);
    expect(isRequirementMet('br', h.ctx)).toBe(true);
    // relevé : la lanterne revient à son porteur désigné
    h.players[1].status = 'alive';
    h.step();
    expect(h.get<LightBridgeState>('br').bearerId).toBe(1);
    expect(isRequirementMet('br', h.ctx)).toBe(true);
  });

  it('porteur tombé loin de l\'équipe : un suiveur resté sur le pont peut avancer (le halo le suit) et atteindre le porteur à terre', () => {
    const room = bridgeRoom({ radiusTiles: 2.5 });
    const h = new Harness(room, 2);
    h.put(1, [11, 5]); // porteur arrivé à l'autre bout
    h.put(0, [6, 5]); // suiveur au départ du pont
    h.step();
    h.players[1].status = 'down';
    for (let x = 6; x <= 10; x++) {
      h.put(0, [x, 5]);
      h.step();
      const st = h.get<LightBridgeState>('br');
      expect(st.bearerId, `suiveur en ${x}`).toBe(0);
      expect(isTileBlockedByMechanism(room, h.mechanisms, x + 1, 5), `tuile ${x + 1} praticable devant le suiveur`).toBe(false);
    }
  });

  it('porteur à terre : le plus proche gagne, égalité au plus petit id ; plus personne de vivant ⇒ aucun porteur, tout est éteint', () => {
    const near = new Harness(bridgeRoom(), 3);
    near.put(1, [8, 5]);
    near.put(0, [2, 8]);
    near.put(2, [10, 5]);
    near.players[1].status = 'down';
    near.step();
    expect(near.get<LightBridgeState>('br').bearerId).toBe(2);
    const tie = new Harness(bridgeRoom(), 3);
    tie.put(1, [8, 5]);
    tie.put(0, [6, 5]);
    tie.put(2, [10, 5]);
    tie.players[1].status = 'down';
    tie.step();
    expect(tie.get<LightBridgeState>('br').bearerId).toBe(0);
    const all = new Harness(bridgeRoom(), 2);
    all.put(1, [8, 5]);
    all.put(0, [7, 5]);
    all.step();
    all.players[0].status = 'down';
    all.players[1].status = 'down';
    const ev = all.step();
    const st = all.get<LightBridgeState>('br');
    expect(st.bearerId).toBeNull();
    expect(st.active).toBe(false);
    expect(st.lit.every((v) => !v)).toBe(true);
    expect(ev).toContainEqual({ type: 'mechanismChanged', mechanismId: 'br', active: false });
    expect(isMechanismSolved(st)).toBe(false);
    expect(isRequirementMet('br', all.ctx)).toBe(false);
  });

  it('lanternSlot % nbJoueurs (lanternSlot 3) pour 1..4 joueurs', () => {
    const expected: Record<number, PlayerId> = { 1: 0, 2: 1, 3: 0, 4: 3 };
    for (let n = 1; n <= 4; n++) {
      const room = bridgeRoom({ lanternSlot: 3 });
      const h = new Harness(room, n);
      h.step();
      expect(h.get<LightBridgeState>('br').bearerId, `n=${n}`).toBe(expected[n]);
      expect(lightBridgeBearer(room.mechanisms[0] as never, h.players)?.id).toBe(expected[n]);
    }
  });

  it('en solo, le seul joueur porte la lanterne et marche dans son propre halo', () => {
    const h = new Harness(bridgeRoom({ lanternSlot: 2 }), 1);
    h.put(0, [8, 5]);
    h.step();
    expect(h.get<LightBridgeState>('br').bearerId).toBe(0);
    expect(h.get<LightBridgeState>('br').active).toBe(true);
  });

  it('waived : pont toujours éclairé (aucune tuile solide), pas de porteur, résolu', () => {
    const room = bridgeRoom({ minPlayers: 3 });
    const h = new Harness(room, 2);
    h.step({}, 5);
    const st = h.get<LightBridgeState>('br');
    expect(st).toMatchObject({ waived: true, active: true, bearerId: null });
    expect(st.lit.every(Boolean)).toBe(true);
    expect(h.solids).toEqual([]);
    expect(isMechanismSolved(st)).toBe(true);
    expect(h.allEvents).toEqual([]);
    const real = new Harness(room, 3);
    real.step();
    expect(real.get<LightBridgeState>('br').waived).toBe(false);
  });

  it('aucune tuile ne piège un joueur : jamais de joueur vivant dont la tuile centrale est solide (marches aléatoires déterministes)', () => {
    for (let n = 1; n <= 4; n++) {
      const room = bridgeRoom({ lanternSlot: n - 1 });
      const h = new Harness(room, n);
      let seed = 12345 + n;
      const rnd = (): number => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 0x100000000;
      };
      for (let i = 0; i < 400; i++) {
        for (const p of h.players) {
          if (rnd() < 0.35) {
            const tx = 4 + Math.floor(rnd() * 10);
            const c = tileCenterPx([tx, 5]);
            p.pos = { x: c.x, y: c.y };
          }
          if (rnd() < 0.05) p.status = p.status === 'alive' ? 'down' : 'alive';
        }
        h.step();
        for (const p of h.players) {
          if (p.status !== 'alive') continue;
          const tx = Math.floor(p.pos.x / TILE);
          const ty = Math.floor(p.pos.y / TILE);
          expect(isTileBlockedByMechanism(room, h.mechanisms, tx, ty), `n=${n} i=${i} J${p.id} en ${tx},${ty}`).toBe(false);
        }
      }
    }
  });
});

// ───────────────────────────── Exigences / sérialisation ─────────────────────────────

describe('exigences et sérialisation JSON', () => {
  const room = roomWith([STATUES, HG, ...(bridgeRoom().mechanisms as MechanismDef[])]);

  it('jetons : statuePair = résolue ; sablier = sable > 0 ; pont = porteur vivant', () => {
    const h = new Harness(room, 2);
    h.step();
    expect(areAllRequirementsMet(['sp', 'hg', 'br'], h.ctx)).toBe(false);
    expect(isRequirementMet('hg', h.ctx)).toBe(false);
    expect(isRequirementMet('br', h.ctx)).toBe(true); // porteur (J2) vivant
    h.put(0, [3, 5]);
    h.step({ press: [0] });
    expect(isRequirementMet('hg', h.ctx)).toBe(true);
    h.wait(3100);
    expect(isRequirementMet('hg', h.ctx)).toBe(false);
  });

  it('l\'état est du JSON pur : structuredClone / JSON.parse(JSON.stringify) identiques, et la reprise donne la même suite', () => {
    const run = (): { h: Harness; log: SimEvent[] } => {
      const h = new Harness(room, 3);
      h.put(0, [4, 6]);
      h.put(1, [3, 5]);
      h.put(2, [11, 5]);
      h.step({ press: [0] });
      h.step({ press: [1] });
      h.wait(3500);
      return { h, log: h.allEvents };
    };
    const a = run();
    const b = run();
    expect(a.h.mechanisms).toEqual(b.h.mechanisms);
    expect(a.log).toEqual(b.log);
    expect(structuredClone(a.h.mechanisms)).toEqual(a.h.mechanisms);
    expect(JSON.parse(JSON.stringify(a.h.mechanisms))).toEqual(a.h.mechanisms);
    // reprise depuis une copie JSON : même évolution
    const copy = JSON.parse(JSON.stringify(a.h.mechanisms)) as MechanismState[];
    const h2 = new Harness(room, 3);
    h2.mechanisms.splice(0, h2.mechanisms.length, ...copy);
    h2.players.forEach((p, i) => (p.pos = { ...a.h.players[i].pos }));
    a.h.wait(2000);
    h2.wait(2000);
    expect(h2.mechanisms).toEqual(a.h.mechanisms);
  });
});

// ───────────────────────────── Intégration GameSimulation ─────────────────────────────

describe('intégration GameSimulation', () => {
  const press = (): ActionFrame => ({ moveX: 0, moveY: 0, attack: false, interact: true, revive: false });
  const idle = (): ActionFrame => ({ moveX: 0, moveY: 0, attack: false, interact: false, revive: false });

  function simFor(mechanisms: MechanismDef[], n: number, over: Partial<RoomDef> = {}) {
    const room = roomWith(mechanisms, {
      exit: { rect: { x: 13, y: 8, w: 2, h: 2 }, requires: [] },
      ...over,
    });
    room.exit.final = true;
    const level: LevelDef = makeTestLevel({ rooms: [room], objectives: [] });
    const sim = createSimulation(
      { levelId: level.id, seed: 1, players: Array.from({ length: n }, (_, i) => ({ id: i as PlayerId, characterId: 'david' as const, difficulty: 2 as const })) },
      level,
    );
    sim.step(SIM_STEP_MS, {});
    return sim;
  }

  const teleport = (sim: ReturnType<typeof simFor>, id: PlayerId, tile: TileXY): void => {
    const c = tileCenterPx(tile);
    sim.state.players[id].pos = { x: c.x, y: c.y };
  };

  /** Un appui d'interaction (front montant) puis relâchement. */
  const tap = (sim: ReturnType<typeof simFor>, id: PlayerId): SimEvent[] => {
    const a = sim.step(SIM_STEP_MS, { [id]: press() });
    const b = sim.step(SIM_STEP_MS, { [id]: idle() });
    return [...a, ...b];
  };

  it('statues : rotation via la simulation, statue solide pour les joueurs, aucune attaque sur le front montant', () => {
    const sim = simFor([STATUES], 2);
    teleport(sim, 0, [4, 6]);
    teleport(sim, 1, [11, 6]);
    const frame: ActionFrame = { moveX: 0, moveY: 0, attack: true, interact: true, revive: false };
    const ev = sim.step(SIM_STEP_MS, { 0: frame });
    expect(ev.some((e) => e.type === 'statueRotated')).toBe(true);
    expect(ev.some((e) => e.type === 'playerAttack')).toBe(false); // l'appui actionne un mécanisme : pas d'attaque
    sim.step(SIM_STEP_MS, { 0: idle() });
    for (let i = 0; i < 2; i++) tap(sim, 0);
    for (let i = 0; i < 2; i++) tap(sim, 1);
    const st = sim.state.room.mechanisms[0] as StatuePairState;
    expect(st.facings).toEqual(['down', 'down']);
    expect(st.active).toBe(true);
    // la statue est solide : un joueur qui marche dessus s'arrête devant
    const walker = sim.state.players[0];
    teleport(sim, 0, [2, 4]);
    for (let i = 0; i < 200; i++) sim.step(SIM_STEP_MS, { 0: { moveX: 1, moveY: 0, attack: false, interact: false, revive: false } });
    expect(walker.pos.x).toBeLessThan(4 * TILE - PLAYER_RADIUS + 0.5);
  });

  it('sablier : herse fermée au départ, ouverte par le retournement, refermée progressivement, ne piège personne', () => {
    const sim = simFor([HG], 2, { playerSpawns: [[2, 2], [3, 2], [2, 3], [3, 3]] });
    const hg = (): HourglassState => sim.state.room.mechanisms[0] as HourglassState;
    expect(hg().closedCount).toBe(4);
    expect(sim.solidRects()).toHaveLength(4);
    // flip depuis le levier A
    teleport(sim, 0, [3, 5]);
    const ev = tap(sim, 0);
    expect(ev.some((e) => e.type === 'hourglassFlipped')).toBe(true);
    expect(hg().closedCount).toBe(0);
    expect(sim.solidRects()).toHaveLength(0);
    // le joueur 1 traverse la herse
    teleport(sim, 1, [6, 4]);
    for (let i = 0; i < 90; i++) sim.step(SIM_STEP_MS, { 1: { moveX: 1, moveY: 0, attack: false, interact: false, revive: false } });
    expect(sim.state.players[1].pos.x).toBeGreaterThan(9 * TILE);
    // le joueur 0 reste dans la herse (tuile 8,5) : elle ne se ferme pas sur lui
    teleport(sim, 0, [8, 5]);
    for (let i = 0; i < 60 * 8; i++) sim.step(SIM_STEP_MS, {});
    expect(hg().sandMs).toBe(0);
    expect(hg().closedCount).toBe(2); // tuiles 0 (8,3) et 1 (8,4) fermées ; la 3e (8,5) est occupée
    const p0 = sim.state.players[0];
    expect(Math.floor(p0.pos.x / TILE)).toBe(8);
    expect(Math.floor(p0.pos.y / TILE)).toBe(5);
    // il sort ; la herse se referme complètement et devient infranchissable
    for (let i = 0; i < 40; i++) sim.step(SIM_STEP_MS, { 0: { moveX: -1, moveY: 0, attack: false, interact: false, revive: false } });
    for (let i = 0; i < 60 * 3; i++) sim.step(SIM_STEP_MS, { 0: idle() });
    expect(hg().closedCount).toBe(4);
    teleport(sim, 0, [6, 4]);
    for (let i = 0; i < 120; i++) sim.step(SIM_STEP_MS, { 0: { moveX: 1, moveY: 0, attack: false, interact: false, revive: false } });
    expect(sim.state.players[0].pos.x).toBeLessThan(8 * TILE);
  });

  it('pont de lumière : on ne traverse que dans le halo du porteur ; un disque qui déborde sur une tuile éteinte est extrait', () => {
    const layout = makeTestLayout(16, 12);
    const bridge = [6, 7, 8, 9, 10, 11].map((x) => [x, 5] as TileXY);
    const mech: MechanismDef = { id: 'br', type: 'lightBridge', tiles: bridge, lanternSlot: 1, radiusTiles: 2.2 };
    const sim = simFor([mech], 2, { layout, playerSpawns: [[2, 5], [3, 5], [2, 6], [3, 6]] });
    const br = (): LightBridgeState => sim.state.room.mechanisms[0] as LightBridgeState;
    const right = (): ActionFrame => ({ moveX: 1, moveY: 0, attack: false, interact: false, revive: false });
    // le porteur (J2) reste en [3,5] : J1 avance mais se heurte à la première tuile éteinte (halo : x ≤ 3 + 2.2 tuiles)
    teleport(sim, 0, [4, 5]);
    teleport(sim, 1, [3, 5]);
    for (let i = 0; i < 200; i++) sim.step(SIM_STEP_MS, { 0: right() });
    expect(br().bearerId).toBe(1);
    const stuckX = sim.state.players[0].pos.x;
    expect(stuckX).toBeLessThan(8 * TILE); // la tuile 8 est hors du halo (3,5)+2.2 tuiles : centre à 5,5 tuiles
    // J2 avance pas à pas, J1 suit : ils traversent tout le pont
    for (let i = 0; i < 900; i++) {
      const bearer = sim.state.players[1];
      const lead = sim.state.players[0];
      const wantBearer = bearer.pos.x < 13 * TILE ? 1 : 0;
      const wantFollower = lead.pos.x < bearer.pos.x + 20 ? 1 : 0;
      sim.step(SIM_STEP_MS, {
        0: { moveX: wantFollower, moveY: 0, attack: false, interact: false, revive: false },
        1: { moveX: wantBearer, moveY: 0, attack: false, interact: false, revive: false },
      });
    }
    expect(sim.state.players[1].pos.x).toBeGreaterThan(12 * TILE);
    expect(sim.state.players[0].pos.x).toBeGreaterThan(11 * TILE);
    // extraction : J1 à cheval sur la frontière de deux tuiles du pont, tout éteint sauf son occupation
    teleport(sim, 1, [2, 8]);
    sim.state.players[0].pos = { x: 8 * TILE - 2, y: 5 * TILE + 8 }; // centre tuile 7, déborde de 7 px sur la tuile 8
    sim.step(SIM_STEP_MS, { 0: idle() });
    const p = sim.state.players[0];
    expect(Math.floor(p.pos.x / TILE)).toBe(7); // reste sur sa tuile (éclairée par son occupation)
    expect(p.pos.x).toBeLessThanOrEqual(8 * TILE - PLAYER_RADIUS + 0.05); // extrait de la tuile 8 devenue solide
  });

  it('résolution complète à 1, 2, 3 et 4 joueurs : les socles sont atteignables (alternance)', () => {
    for (let n = 1; n <= 4; n++) {
      const sim = simFor([STATUES], n);
      const st = (): StatuePairState => sim.state.room.mechanisms[0] as StatuePairState;
      let guard = 0;
      while (!st().active && guard++ < 12) {
        const id = (guard % n) as PlayerId;
        teleport(sim, id, st().facings[1] !== 'down' ? [4, 6] : [11, 6]);
        tap(sim, id);
      }
      expect(st().active, `n=${n}`).toBe(true);
    }
  });

  it('validateLevel accepte une salle mêlant les trois mécanismes (tuiles, socles, herse, pont)', () => {
    const room = roomWith(
      [
        { ...STATUES, statues: [{ tile: [4, 3], standTile: [4, 5], facing: 'up' }, { tile: [12, 3], standTile: [12, 5], facing: 'left' }] },
        { ...HG, gate: [[8, 8], [8, 9]], levers: [[5, 8], [11, 8]], displayTile: [8, 7] },
        { id: 'br', type: 'lightBridge', tiles: [[6, 6], [7, 6]], lanternSlot: 0, radiusTiles: 3 },
      ],
      { exit: { rect: { x: 13, y: 8, w: 2, h: 2 }, requires: ['sp'] } },
    );
    room.exit.final = true;
    const level = makeTestLevel({ rooms: [room], objectives: [] });
    // objectifs requis par le validateur : un par slot, sur un mécanisme existant
    level.objectives = [0, 1, 2, 3].map((slot) => ({ id: `o${slot}`, slot, roomId: room.id, kind: 'mechanism' as const, labelKey: `objective.test.o${slot}`, mechanismId: 'sp' }));
    expect(validateLevel(level)).toEqual([]);
  });
});
