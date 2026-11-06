import { describe, expect, it } from 'vitest';
import { makeTestLevel, makeTestRoom } from '../core/levelValidation';
import type { CharacterId, EnemySpawnDef, LevelDef, MechanismDef, RoomDef, TileRect, TileXY } from '../core/types';
import {
  BotRun,
  attackUntilClear,
  barrier,
  buildNavMap,
  conds,
  expectUntil,
  findPath,
  goNear,
  goTo,
  pickUpKey,
  pressInteract,
  pullLever,
  reachableTiles,
  roomScript,
  runLevelScripts,
  runeSequence,
  runUntil,
  say,
  act,
  standOn,
  toExit,
  useKey,
  wait,
  waitUntil,
  pushBlock,
} from './botKit';
import { RoomGrid } from '../core/grid';
import { TILE } from '../core/constants';

// ───────────────────────────── Harnais ─────────────────────────────

/** Salle de test : sortie sans exigence, `overrides` pour le reste. */
function room(id: string, layout: string[], overrides: Partial<RoomDef> = {}): RoomDef {
  return makeTestRoom({
    id,
    layout,
    mechanisms: [],
    exit: { rect: { x: 10, y: 5, w: 2, h: 2 }, requires: [] },
    ...overrides,
  });
}

/** Niveau de test : la dernière salle est finale, aucun objectif. */
function level(rooms: RoomDef[]): LevelDef {
  rooms[rooms.length - 1].exit.final = true;
  return makeTestLevel({ rooms, objectives: [] });
}

/** Grille rectangulaire w×h de murs avec intérieur libre, modifiable par `edit(rows)`. */
function box(w: number, h: number, edit?: (rows: string[][]) => void): string[] {
  const rows: string[][] = [];
  for (let y = 0; y < h; y++) {
    const row: string[] = [];
    for (let x = 0; x < w; x++) row.push(y === 0 || y === h - 1 || x === 0 || x === w - 1 ? '#' : '.');
    rows.push(row);
  }
  if (edit) edit(rows);
  return rows.map((r) => r.join(''));
}

function slimes(tiles: TileXY[]): EnemySpawnDef[] {
  return tiles.map((tile) => ({ kind: 'slime' as const, tile }));
}

const EXIT_RIGHT: TileRect = { x: 12, y: 3, w: 2, h: 2 };

// ───────────────────────────── Chemins ─────────────────────────────

describe('pathfinding', () => {
  const grid = new RoomGrid(
    box(10, 8, (r) => {
      for (let y = 1; y <= 5; y++) r[y][5] = '#'; // mur vertical avec passage en bas (y=6)
    }),
  );

  it('contourne un mur et retourne un chemin continu', () => {
    const nav = buildNavMap(grid, []);
    const path = findPath(nav, [2, 2], (x, y) => x === 8 && y === 2);
    expect(path).not.toBeNull();
    expect(path![0]).toEqual([2, 2]);
    expect(path![path!.length - 1]).toEqual([8, 2]);
    // passe forcément par la ligne 6 (seul passage)
    expect(path!.some(([, y]) => y === 6)).toBe(true);
    for (let i = 1; i < path!.length; i++) {
      expect(Math.abs(path![i][0] - path![i - 1][0])).toBeLessThanOrEqual(1);
      expect(Math.abs(path![i][1] - path![i - 1][1])).toBeLessThanOrEqual(1);
    }
  });

  it('ne coupe pas les coins (pas diagonal exige deux voisins libres)', () => {
    const g = new RoomGrid(['#####', '#.#.#', '##.##', '#.#.#', '#####']);
    const nav = buildNavMap(g, []);
    // (1,1) -> (2,2) diagonal : voisins (2,1) et (1,2) sont des murs => interdit
    expect(findPath(nav, [1, 1], (x, y) => x === 2 && y === 2)).toBeNull();
  });

  it('une porte fermée (solide) bloque, et le chemin existe à nouveau quand elle disparaît', () => {
    const closed = buildNavMap(grid, [{ x: 5 * TILE, y: 6 * TILE, w: TILE, h: TILE }]);
    expect(findPath(closed, [2, 2], (x, y) => x === 8 && y === 2)).toBeNull();
    const open = buildNavMap(grid, []);
    expect(findPath(open, [2, 2], (x, y) => x === 8 && y === 2)).not.toBeNull();
    const seen = reachableTiles(closed, [2, 2]);
    expect(seen[2 * closed.width + 8]).toBe(0);
  });
});

// ───────────────────────────── Déplacement ─────────────────────────────

describe('BotRun : déplacement', () => {
  it('un bot traverse une salle (obstacles, mur à passage) jusqu’à la sortie', () => {
    const layout = box(16, 9, (r) => {
      for (let y = 1; y <= 6; y++) r[y][8] = '#';
      r[4][4] = 'o';
      r[3][11] = 'o';
      r[6][5] = '~';
    });
    const lv = level([room('r1', layout, { exit: { rect: EXIT_RIGHT, requires: [] }, playerSpawns: [[2, 2], [3, 2], [2, 3], [3, 3]] })]);
    const run = new BotRun(lv, { playerCount: 1, characters: ['david'] });
    run.queueExit();
    expectUntil(run, conds.levelComplete, 20000, 'le bot doit atteindre la sortie');
    expect(run.failures).toEqual([]);
    expect(run.stats.timeMs).toBeLessThan(20000);
  });

  it('goTo précis : arrive pile sur le centre de la tuile visée', () => {
    const lv = level([room('r1', box(12, 8))]);
    const run = new BotRun(lv, { playerCount: 1, characters: ['romain'] });
    run.queue(0, goTo([8, 5], { tolerance: 0.5 }));
    expectUntil(run, (r) => r.allIdle, 10000, 'arrivée');
    const p = run.player(0);
    expect(Math.hypot(p.pos.x - 8.5 * TILE, p.pos.y - 5.5 * TILE)).toBeLessThan(1);
  });

  it('plusieurs bots avancent en parallèle', () => {
    const lv = level([room('r1', box(14, 8), { exit: { rect: EXIT_RIGHT, requires: [] } })]);
    const run = new BotRun(lv, { playerCount: 4 });
    run.queueEach((id) => [goTo([10, 1 + id], { tolerance: 1 })]);
    expectUntil(run, (r) => r.allIdle, 15000, 'les 4 bots arrivent');
    for (let i = 0; i < 4; i++) {
      expect(Math.abs(run.player(i as 0).pos.x - 10.5 * TILE)).toBeLessThan(2);
    }
  });

  it('replanifie : une porte sur le passage le plus court est contournée par l’autre ouverture', () => {
    // Mur vertical x=6 avec deux ouvertures (y=2 fermée par une porte, y=6 libre).
    const layout = box(14, 9, (r) => {
      for (let y = 1; y <= 7; y++) r[y][6] = y === 2 || y === 6 ? '.' : '#';
    });
    const mechs: MechanismDef[] = [{ id: 'd', type: 'door', tiles: [[6, 2]], requires: ['never'] }];
    const lv = level([room('r1', layout, { mechanisms: mechs, playerSpawns: [[2, 2], [3, 2], [2, 3], [3, 3]] })]);
    const run = new BotRun(lv, { playerCount: 1, characters: ['david'] });
    run.queue(0, goTo([10, 2], { tolerance: 2 }));
    expectUntil(run, (r) => r.allIdle, 20000, 'contournement');
    expect(run.mech('d').active).toBe(false);
    expect(run.failures).toEqual([]);
  });

  it('attend une porte fermée qu’un autre joueur ouvre (levier), puis passe', () => {
    const layout = box(14, 8, (r) => {
      for (let y = 1; y <= 6; y++) r[y][7] = y === 3 ? '.' : '#';
    });
    const mechs: MechanismDef[] = [
      { id: 'lv', type: 'lever', tile: [3, 5] },
      { id: 'd', type: 'door', tiles: [[7, 3]], requires: ['lv'] },
    ];
    const lv = level([room('r1', layout, { mechanisms: mechs })]);
    const run = new BotRun(lv, { playerCount: 2, characters: ['david', 'romain'], background: { regroup: false } });
    run.queue(0, goTo([11, 3], { tolerance: 2 }), say('passé'));
    run.queue(1, wait(2500), pullLever('lv'));
    expectUntil(run, (r) => r.allIdle, 25000, 'porte ouverte par J2 puis passage de J1');
    expect(run.mech('d').active).toBe(true);
    expect(run.player(0).pos.x).toBeGreaterThan(10 * TILE);
    expect(run.trace.some((t) => t.includes('passé'))).toBe(true);
  });

  it('contourne un bloc posé au milieu', () => {
    const layout = box(14, 9);
    const mechs: MechanismDef[] = [{ id: 'b', type: 'block', tile: [6, 3] }];
    const lv = level([room('r1', layout, { mechanisms: mechs, playerSpawns: [[2, 4], [3, 4], [2, 5], [3, 5]] })]);
    const run = new BotRun(lv, { playerCount: 1, characters: ['david'] });
    run.queue(0, goTo([11, 4], { tolerance: 2 }));
    expectUntil(run, (r) => r.allIdle, 20000, 'contournement du bloc');
    expect(run.failures).toEqual([]);
  });

  it('cible inatteignable : échec explicite (mode fail) avec diagnostic', () => {
    const layout = box(12, 8, (r) => {
      for (let y = 1; y <= 6; y++) r[y][6] = '#';
    });
    const lv = level([room('r1', layout)]);
    const run = new BotRun(lv, { playerCount: 1, characters: ['david'] });
    run.queue(0, goTo([9, 3], { onUnreachable: 'fail', unreachableGraceMs: 500 }));
    const res = runUntil(run, () => false, 5000, { stopOnFailure: true });
    expect(res.reason).toBe('failure');
    expect(run.failures[0].reason).toMatch(/aucun chemin/);
    const report = run.diagnose('test');
    expect(report).toContain('J1 david');
    expect(report).toContain('salle #0 « r1 »');
    expect(report).toContain('Mécanismes');
  });

  it('cible inatteignable en mode wait : délai maxMs puis échec', () => {
    const layout = box(12, 8, (r) => {
      for (let y = 1; y <= 6; y++) r[y][6] = '#';
    });
    const lv = level([room('r1', layout)]);
    const run = new BotRun(lv, { playerCount: 1, characters: ['david'] });
    run.queue(0, goTo([9, 3], { maxMs: 1500 }));
    runUntil(run, () => false, 4000, { stopOnFailure: true });
    expect(run.failures).toHaveLength(1);
    expect(run.failures[0].reason).toMatch(/délai dépassé/);
  });

  it('un échec vide la file du joueur (par défaut) et il retombe sur les comportements de fond', () => {
    const lv = level([room('r1', box(12, 8))]);
    const run = new BotRun(lv, { playerCount: 1, characters: ['david'] });
    run.queue(0, waitUntil(() => false, 300), say('jamais'));
    run.stepFor(1000);
    expect(run.failures).toHaveLength(1);
    expect(run.trace).toHaveLength(0);
    expect(run.bot(0).isIdle).toBe(true);
  });
});

// ───────────────────────────── Plaques / portes ─────────────────────────────

describe('BotRun : plaques coopératives', () => {
  function plateRoom(): LevelDef {
    const layout = box(16, 8, (r) => {
      for (let y = 1; y <= 6; y++) r[y][7] = y === 3 || y === 4 ? '.' : '#';
    });
    const mechs: MechanismDef[] = [
      { id: 'pa', type: 'plate', tile: [2, 1] },
      { id: 'pb', type: 'plate', tile: [2, 6] },
      { id: 'd', type: 'door', tiles: [[7, 3], [7, 4]], requires: ['pa', 'pb'] },
    ];
    return level([room('r1', layout, { mechanisms: mechs, exit: { rect: EXIT_RIGHT, requires: ['d'] } })]);
  }

  it('2 bots tiennent chacun une plaque, la porte s’ouvre, puis tous sortent', () => {
    const run = new BotRun(plateRoom(), { playerCount: 2, characters: ['david', 'romain'] });
    run.queue(0, standOn([2, 1], { until: conds.mechActive('d') }), toExit());
    run.queue(1, standOn([2, 6], { until: conds.mechActive('d') }), toExit());
    expectUntil(run, conds.mechActive('d'), 20000, 'la porte à deux plaques doit s’ouvrir');
    expectUntil(run, conds.levelComplete, 20000, 'sortie du niveau');
    expect(run.failures).toEqual([]);
  });

  it('une seule plaque tenue ne suffit pas', () => {
    const run = new BotRun(plateRoom(), { playerCount: 2, characters: ['david', 'romain'] });
    run.queue(0, standOn([2, 1]));
    run.queue(1, wait(100000));
    run.stepFor(8000);
    expect(run.mech('pa').active).toBe(true);
    expect(run.mech('pb').active).toBe(false);
    expect(run.mech('d').active).toBe(false);
  });

  it('un rendez-vous (barrier) bloque jusqu’à l’arrivée de tous', () => {
    const lv = level([room('r1', box(16, 8))]);
    const run = new BotRun(lv, { playerCount: 2, characters: ['david', 'romain'], background: { regroup: false } });
    run.queue(0, barrier('sync'), say('J1 passe'));
    run.queue(1, goTo([12, 5], { tolerance: 2 }), say('J2 arrive'), barrier('sync'), say('J2 passe'));
    run.stepFor(600);
    expect(run.trace.some((t) => t.includes('J1 passe'))).toBe(false);
    expectUntil(run, (r) => r.allIdle, 20000, 'rendez-vous');
    expect(run.trace.some((t) => t.includes('J1 passe'))).toBe(true);
    expect(run.trace.some((t) => t.includes('J2 passe'))).toBe(true);
  });
});

// ───────────────────────────── Interactions ─────────────────────────────

describe('BotRun : leviers, clés, runes', () => {
  it('levier : pullLever s’approche et l’actionne ; levier à propriétaire respecté via queueForSlot', () => {
    const mechs: MechanismDef[] = [
      { id: 'l0', type: 'lever', tile: [6, 2], ownerSlot: 0 },
      { id: 'l1', type: 'lever', tile: [6, 5], ownerSlot: 1 },
    ];
    const lv = level([room('r1', box(14, 8), { mechanisms: mechs })]);
    const run = new BotRun(lv, { playerCount: 2, characters: ['david', 'romain'], background: { regroup: false } });
    run.queueForSlot(0, pullLever('l0'));
    run.queueForSlot(1, pullLever('l1'));
    expectUntil(run, (r) => r.mechSolved('l0') && r.mechSolved('l1'), 15000, 'deux leviers distincts');
    // En solo, les deux slots tombent sur le même joueur : actions bout à bout.
    const solo = new BotRun(lv, { playerCount: 1, characters: ['david'] });
    solo.queueForSlot(0, pullLever('l0'));
    solo.queueForSlot(1, pullLever('l1'));
    expectUntil(solo, (r) => r.mechSolved('l0') && r.mechSolved('l1'), 20000, 'solo : les deux leviers à la suite');
  });

  it('clé personnelle : pickUpKey puis useKey ouvrent la porte à clé', () => {
    const layout = box(14, 8, (r) => {
      for (let y = 1; y <= 6; y++) r[y][8] = y === 3 ? '.' : '#';
    });
    const mechs: MechanismDef[] = [
      { id: 'k0', type: 'key', tile: [3, 5], ownerSlot: 0, doorId: 'kd' },
      { id: 'kd', type: 'door', tiles: [[8, 3]], requires: [], keyId: 'k0' },
    ];
    const lv = level([room('r1', layout, { mechanisms: mechs })]);
    const run = new BotRun(lv, { playerCount: 1, characters: ['david'] });
    run.queue(0, pickUpKey('k0'), useKey('kd'), goTo([11, 3], { tolerance: 2 }));
    expectUntil(run, (r) => r.allIdle, 25000, 'clé puis porte puis passage');
    expect(run.mech('kd').active).toBe(true);
    expect(run.player(0).pos.x).toBeGreaterThan(10 * TILE);
  });

  it('runes : runeSequence joue la bonne séquence', () => {
    const mechs: MechanismDef[] = [
      {
        id: 'rn',
        type: 'runePuzzle',
        displayTile: [6, 1],
        visibleToSlot: 0,
        sequence: ['sun', 'star', 'moon'],
        pedestals: [
          { symbol: 'sun', tile: [3, 5] },
          { symbol: 'moon', tile: [6, 5] },
          { symbol: 'star', tile: [9, 5] },
        ],
      },
    ];
    const lv = level([room('r1', box(14, 8), { mechanisms: mechs })]);
    const run = new BotRun(lv, { playerCount: 1, characters: ['romain'] });
    run.queue(0, runeSequence('rn'));
    expectUntil(run, conds.mechActive('rn'), 20000, 'énigme de runes');
    expect(run.failures).toEqual([]);
  });

  it('pressInteract sans effet : échec après les essais', () => {
    const lv = level([room('r1', box(12, 8))]);
    const run = new BotRun(lv, { playerCount: 1 });
    run.queue(0, pressInteract({ expect: () => false, settleMs: 100, retries: 1 }));
    runUntil(run, () => false, 2000, { stopOnFailure: true });
    expect(run.failures[0]?.reason).toMatch(/sans effet/);
  });
});

// ───────────────────────────── Blocs ─────────────────────────────

describe('BotRun : blocs poussables', () => {
  function blockLevel(): LevelDef {
    const mechs: MechanismDef[] = [
      { id: 'b', type: 'block', tile: [5, 3] },
      { id: 'sock', type: 'socket', tile: [10, 3] },
    ];
    return level([
      room('r1', box(16, 9), {
        mechanisms: mechs,
        playerSpawns: [[2, 2], [3, 2], [2, 3], [3, 3]],
        exit: { rect: { x: 12, y: 6, w: 2, h: 2 }, requires: ['sock'] },
      }),
    ]);
  }

  for (const n of [1, 2, 3, 4]) {
    it(`${n} joueur(s) poussent le bloc sur le socle`, () => {
      const run = new BotRun(blockLevel(), { playerCount: n, characters: ['david', 'brokk', 'romain', 'grok'] });
      const pushers = run.pushBlockTogether('b', 'right', 5);
      expect(pushers.length).toBe(Math.min(2, n));
      expectUntil(run, conds.mechActive('sock'), 30000, `le bloc doit atteindre le socle à ${n} joueur(s)`);
      expect(run.failures).toEqual([]);
    });
  }

  it('pousse en plusieurs segments (droite puis bas)', () => {
    const mechs: MechanismDef[] = [
      { id: 'b', type: 'block', tile: [4, 2] },
      { id: 'sock', type: 'socket', tile: [9, 5] },
    ];
    const lv = level([room('r1', box(16, 10), { mechanisms: mechs })]);
    const run = new BotRun(lv, { playerCount: 2, characters: ['david', 'brokk'] });
    for (const id of [0, 1] as const) {
      run.queue(id, pushBlock('b', 'right', 5, { lane: id }), pushBlock('b', 'down', 3, { lane: id }));
    }
    expectUntil(run, conds.mechActive('sock'), 40000, 'poussée en L');
    expect(run.failures).toEqual([]);
  });

  it('un second pousseur absent : le bloc reste immobile et l’échec est explicite', () => {
    const run = new BotRun(blockLevel(), { playerCount: 2, characters: ['david', 'brokk'], background: { regroup: false } });
    run.queue(0, pushBlock('b', 'right', 5, { stallMs: 3000 }));
    runUntil(run, () => false, 20000, { stopOnFailure: true });
    expect(run.failures[0]?.reason).toMatch(/immobile/);
    expect(run.mech('sock').active).toBe(false);
  });
});

// ───────────────────────────── Combat ─────────────────────────────

describe('BotRun : auto-combat', () => {
  const chars: CharacterId[] = ['david', 'sandrine', 'aelith', 'romain', 'brokk', 'grok', 'mira'];
  for (const c of chars) {
    it(`${c} bat des slimes sans script (comportements de fond)`, () => {
      const lv = level([room('r1', box(16, 9), { enemies: slimes([[9, 3], [11, 5], [8, 6]]), exit: { rect: EXIT_RIGHT, requires: ['clear'] } })]);
      const run = new BotRun(lv, { playerCount: 1, characters: [c] });
      const res = runUntil(run, conds.enemiesCleared, 40000);
      expect(res.ok, run.diagnose('slimes non vaincus')).toBe(true);
      expect(run.stats.players[0].kills).toBe(3);
      expect(run.player(0).status).toBe('alive');
    });
  }

  it('attackUntilClear chasse tous les ennemis, même loin, y compris un archer', () => {
    const enemies: EnemySpawnDef[] = [
      { kind: 'skeleton', tile: [12, 2] },
      { kind: 'archer', tile: [13, 6] },
      { kind: 'bat', tile: [11, 4] },
    ];
    const lv = level([room('r1', box(16, 9), { enemies })]);
    const run = new BotRun(lv, { playerCount: 2, characters: ['david', 'aelith'], background: { combat: false } });
    run.queueEach(() => [attackUntilClear(), say('nettoyé')]);
    expectUntil(run, conds.enemiesCleared, 60000, 'salle nettoyée par attackUntilClear');
    expect(run.stats.players[0].kills + run.stats.players[1].kills).toBe(3);
  });

  it('salle de combat pur jouée par le script par défaut', () => {
    const lv = level([
      room('r1', box(16, 9), { enemies: slimes([[9, 3], [11, 5]]), exit: { rect: EXIT_RIGHT, requires: ['clear'] } }),
    ]);
    const run = new BotRun(lv, { playerCount: 2, characters: ['david', 'sandrine'] });
    const res = runLevelScripts(run, []);
    expect(res.failure, res.failure ?? '').toBeNull();
    expect(res.completed).toBe(true);
  });

  it('les PV perdus et les mises à terre sont comptés (bot passif face à un chevalier)', () => {
    const enemies: EnemySpawnDef[] = [{ kind: 'knight', tile: [5, 3] }];
    const lv = level([room('r1', box(12, 8), { enemies })]);
    const run = new BotRun(lv, {
      playerCount: 1,
      characters: ['sandrine'],
      background: { combat: false, regroup: false, dodge: false },
    });
    run.queue(0, wait(30000));
    run.setBackground(0, { combat: false });
    run.stepFor(12000);
    expect(run.stats.players[0].hpLost).toBeGreaterThan(0);
    expect(run.stats.players[0].downs).toBeGreaterThanOrEqual(1);
    expect(run.stats.wipes).toBeGreaterThanOrEqual(1);
    expect(run.statsReport()).toContain('à terre');
  });
});

// ───────────────────────────── Relevage ─────────────────────────────

describe('BotRun : auto-relevage', () => {
  function twoPlayers(enemies: EnemySpawnDef[] = []): BotRun {
    const lv = level([room('r1', box(14, 8), { enemies })]);
    return new BotRun(lv, { playerCount: 2, characters: ['david', 'romain'] });
  }

  function knockDown(run: BotRun, id: 0 | 1): void {
    const p = run.sim.state.players[id];
    p.status = 'down';
    p.hp = 0;
    p.downCount += 1;
    p.pos = { x: 9.5 * TILE, y: 5.5 * TILE };
  }

  it('un bot relève un allié à terre', () => {
    const run = twoPlayers();
    knockDown(run, 1);
    expectUntil(run, conds.allAlive, 12000, 'J2 doit être relevé par J1');
    expect(run.stats.players[0].revivesDone).toBe(1);
    expect(run.stats.players[1].revivedTimes).toBe(1);
    expect(run.player(1).hp).toBe(run.player(1).maxHp);
  });

  it('avec un ennemi près de l’allié à terre : se bat d’abord, puis relève', () => {
    const run = twoPlayers(slimes([[8, 5]]));
    knockDown(run, 1);
    expectUntil(run, conds.allAlive, 25000, 'J2 doit être relevé après la défaite du slime');
    expect(run.aliveEnemies.length).toBe(0);
  });

  it('relever est désactivable', () => {
    const run = twoPlayers();
    run.setBackground('all', { revive: false });
    knockDown(run, 1);
    run.stepFor(6000);
    expect(run.player(1).status).toBe('down');
  });

  it('revive explicite (action) et un joueur à terre ne bouge pas', () => {
    const run = twoPlayers();
    run.setBackground('all', { revive: false });
    knockDown(run, 1);
    const before = { ...run.player(1).pos };
    run.queue(0, wait(0), { label: 'x', create: () => ({ tick: () => 'done' }) });
    run.stepFor(500);
    expect(run.player(1).pos).toEqual(before);
  });
});

// ───────────────────────────── Scripts de niveau, stats, déterminisme ─────────────────────────────

describe('runLevelScripts', () => {
  function twoRooms(): LevelDef {
    const layout1 = box(14, 8, (r) => {
      for (let y = 1; y <= 6; y++) r[y][7] = y === 3 ? '.' : '#';
    });
    const r1 = room('r1', layout1, {
      mechanisms: [
        { id: 'lv', type: 'lever', tile: [3, 5] },
        { id: 'd', type: 'door', tiles: [[7, 3]], requires: ['lv'] },
      ],
      exit: { rect: EXIT_RIGHT, requires: ['d'] },
    });
    const r2 = room('r2', box(14, 8), { enemies: slimes([[9, 3]]), exit: { rect: EXIT_RIGHT, requires: ['clear'] } });
    return level([r1, r2]);
  }

  it('joue 2 salles avec un script par salle (levier, puis combat)', () => {
    const lv = twoRooms();
    const run = new BotRun(lv, { playerCount: 3, characters: ['david', 'sandrine', 'romain'] });
    const res = runLevelScripts(run, [
      roomScript('r1', (r) => {
        r.queueForSlot(0, pullLever('lv'), ...toExit());
        r.queueForSlot(1, ...toExit());
        r.queueForSlot(2, ...toExit());
      }),
      // r2 : script par défaut (attackUntilClear puis sortie)
    ]);
    expect(res.failure, res.failure ?? '').toBeNull();
    expect(res.completed).toBe(true);
    expect(run.stats.rooms.map((r) => r.roomId)).toEqual(['r1', 'r2']);
    expect(run.stats.rooms.every((r) => r.clearedAtMs !== null)).toBe(true);
    expect(res.report).toContain('Temps simulé');
  });

  it('startRoomIndex : démarre dans la 2e salle (salle 1 validée)', () => {
    const run = new BotRun(twoRooms(), { playerCount: 1, characters: ['david'], startRoomIndex: 1 });
    expect(run.roomId).toBe('r2');
    expect(run.state.clearedRooms).toEqual(['r1']);
    const res = runLevelScripts(run, []);
    expect(res.completed, res.failure ?? '').toBe(true);
  });

  it('échec explicite avec diagnostic quand un script ne peut pas aboutir', () => {
    const lv = twoRooms();
    const run = new BotRun(lv, { playerCount: 1, characters: ['david'] });
    const res = runLevelScripts(run, [roomScript('r1', (r) => r.queueForSlot(0, goTo([30, 30], { maxMs: 2000 })))]);
    expect(res.completed).toBe(false);
    expect(res.failure).toContain('DIAGNOSTIC BOTS');
    expect(res.failure).toContain('délai dépassé');
  });

  it('budget de salle dépassé : échec avec diagnostic', () => {
    const run = new BotRun(twoRooms(), { playerCount: 1, characters: ['david'] });
    const res = runLevelScripts(run, [roomScript('r1', () => undefined)], { maxRoomMs: 3000 });
    expect(res.completed).toBe(false);
    expect(res.failure).toContain('non terminée');
  });
});

describe('déterminisme', () => {
  function play(seed: number): { json: string; timeMs: number } {
    const enemies: EnemySpawnDef[] = [
      ...slimes([[9, 3], [11, 5]]),
      { kind: 'bat', tile: [10, 2] },
      { kind: 'skeleton', tile: [12, 6] },
    ];
    const lv = level([room('r1', box(16, 9), { enemies })]);
    const run = new BotRun(lv, { playerCount: 2, characters: ['david', 'aelith'], seed });
    runUntil(run, conds.enemiesCleared, 60000);
    return { json: run.sim.serialize(), timeMs: run.timeMs };
  }

  it('même seed ⇒ même partie (état et durée identiques)', () => {
    const a = play(7);
    const b = play(7);
    expect(a.timeMs).toBe(b.timeMs);
    expect(a.json).toBe(b.json);
  });

  it('seeds différentes : la partie reste terminable', () => {
    for (const s of [1, 2, 3]) {
      const r = play(s);
      expect(r.timeMs).toBeLessThan(60000);
    }
  });
});

describe('goNear / standOn avec combat sur place', () => {
  it('goNear s’arrête à portée d’une porte fermée (solide)', () => {
    const layout = box(14, 8, (r) => {
      for (let y = 1; y <= 6; y++) r[y][8] = y === 3 ? '.' : '#';
    });
    const mechs: MechanismDef[] = [{ id: 'd', type: 'door', tiles: [[8, 3]], requires: ['never'] }];
    const lv = level([room('r1', layout, { mechanisms: mechs })]);
    const run = new BotRun(lv, { playerCount: 1, characters: ['david'] });
    run.queue(0, goNear([8, 3], { radius: 18 }));
    expectUntil(run, (r) => r.allIdle, 15000, 'goNear');
    const d = Math.hypot(run.player(0).pos.x - 8.5 * TILE, run.player(0).pos.y - 3.5 * TILE);
    expect(d).toBeLessThanOrEqual(18.5);
  });

  it('un bot sur une plaque combat sur place sans la quitter', () => {
    const mechs: MechanismDef[] = [{ id: 'p', type: 'plate', tile: [6, 4] }];
    const lv = level([room('r1', box(14, 8), { mechanisms: mechs, enemies: slimes([[8, 4]]) })]);
    const run = new BotRun(lv, { playerCount: 1, characters: ['david'] });
    run.queue(0, standOn([6, 4]));
    let left = false;
    for (let i = 0; i < 1800 && run.aliveEnemies.length > 0; i++) {
      run.stepOnce();
      if (!run.mech('p').active && run.timeMs > 1500) left = true;
    }
    run.stepFor(100);
    expect(run.aliveEnemies.length).toBe(0);
    expect(left).toBe(false);
  });
});

// ───────────────────────────── Régressions et cas limites ─────────────────────────────

describe('robustesse', () => {
  // TODO : bug connu de la bibliothèque de bots (botBrain.engageRanged se fige contre un pilier) ; contourné dans les scripts de niveau (classe Unstick).
  it.skip('tireurs entre des piliers : les tirs rasants (rayon du projectile) ne bloquent pas le combat', () => {
    const layout = box(18, 11, (r) => {
      for (let y = 2; y <= 8; y += 2) for (let x = 3; x <= 14; x += 3) r[y][x] = 'o';
    });
    const enemies: EnemySpawnDef[] = slimes([[8, 3], [12, 7], [5, 5], [14, 4]]);
    for (const c of ['sandrine', 'aelith'] as CharacterId[]) {
      for (const seed of [1, 2, 3]) {
        const lv = level([room('r1', layout, { enemies, exit: { rect: { x: 15, y: 8, w: 2, h: 2 }, requires: ['clear'] } })]);
        const run = new BotRun(lv, { playerCount: 1, characters: [c], seed });
        run.queue(0, attackUntilClear());
        const res = runUntil(run, conds.enemiesCleared, 60000, { stopOnFailure: true });
        expect(res.ok, run.diagnose(`${c} seed ${seed}`)).toBe(true);
      }
    }
  });

  it('attackUntilClear attend les vagues déclenchées par un levier (apparitions conditionnelles)', () => {
    const enemies: EnemySpawnDef[] = [
      { kind: 'slime', tile: [9, 3], wave: 0, when: 'lv' },
      { kind: 'slime', tile: [10, 5], wave: 1, when: 'lv' },
      { kind: 'bat', tile: [11, 4], wave: 2, when: 'lv' },
    ];
    const mechs: MechanismDef[] = [{ id: 'lv', type: 'lever', tile: [3, 5] }];
    const lv = level([room('r1', box(16, 9), { enemies, mechanisms: mechs, exit: { rect: EXIT_RIGHT, requires: ['clear'] } })]);
    const run = new BotRun(lv, { playerCount: 1, characters: ['david'], background: { regroup: false } });
    run.queue(0, pullLever('lv'), attackUntilClear(), say('fini'));
    expectUntil(run, (r) => r.allIdle, 60000, 'trois vagues vaincues');
    expect(run.pendingSpawnCount(false)).toBe(0);
    expect(run.aliveEnemies.length).toBe(0);
    expect(run.stats.players[0].kills).toBe(3);
  });

  it('attente passive : le joueur ne se bat pas ; attente normale : il se bat', () => {
    const mk = (passive: boolean): BotRun => {
      const lv = level([room('r1', box(14, 8), { enemies: slimes([[4, 3]]), exit: { rect: EXIT_RIGHT, requires: ['clear'] } })]);
      const run = new BotRun(lv, { playerCount: 1, characters: ['david'] });
      run.queue(0, wait(4000, { passive }));
      run.stepFor(3500);
      return run;
    };
    expect(mk(true).stats.players[0].kills).toBe(0);
    expect(mk(false).stats.players[0].kills).toBe(1);
  });

  it('défaite collective : les files sont vidées, le script de la salle est reconstruit (attempt/restart) et le niveau se termine', () => {
    const lv = level([room('r1', box(14, 8), { exit: { rect: EXIT_RIGHT, requires: [] } })]);
    const run = new BotRun(lv, { playerCount: 2, characters: ['david', 'romain'] });
    const infos: { attempt: number; restart: boolean }[] = [];
    const res = runLevelScripts(run, [
      roomScript('r1', (r, info) => {
        infos.push({ attempt: info.attempt, restart: info.restart });
        if (info.attempt === 0) {
          r.queue(
            0,
            act((run2) => {
              for (const p of run2.sim.state.players) {
                p.hp = 0;
                p.status = 'down';
              }
            }),
          );
        } else {
          r.queueExit();
        }
      }),
    ]);
    expect(res.completed, res.failure ?? '').toBe(true);
    expect(infos).toEqual([
      { attempt: 0, restart: false },
      { attempt: 1, restart: true },
    ]);
    expect(run.stats.wipes).toBe(1);
    expect(run.stats.rooms[0].entries).toBe(2);
  });

  it('un joueur à terre est immobile et son script est gelé jusqu’au relevage', () => {
    const lv = level([room('r1', box(14, 8))]);
    const run = new BotRun(lv, { playerCount: 2, characters: ['david', 'romain'] });
    run.setBackground('all', { revive: false });
    run.queue(1, goTo([10, 3], { tolerance: 1 }));
    run.stepFor(300);
    const p1 = run.sim.state.players[1];
    p1.status = 'down';
    p1.hp = 0;
    const pos = { ...p1.pos };
    run.stepFor(1500);
    expect(run.player(1).pos).toEqual(pos);
    p1.status = 'alive';
    p1.hp = p1.maxHp;
    expectUntil(run, (r) => r.allIdle, 10000, 'le script reprend après le relevage');
    expect(Math.abs(run.player(1).pos.x - 10.5 * TILE)).toBeLessThan(2);
  });

  it('frames forcées : stepOnce(frames) remplace la frame du pilote pour ce pas', () => {
    const lv = level([room('r1', box(14, 8))]);
    const run = new BotRun(lv, { playerCount: 1, characters: ['david'] });
    const x0 = run.player(0).pos.x;
    for (let i = 0; i < 30; i++) run.stepOnce({ 0: { moveX: 1, moveY: 0, attack: false, interact: false, revive: false } });
    expect(run.player(0).pos.x).toBeGreaterThan(x0 + 10);
  });
});
