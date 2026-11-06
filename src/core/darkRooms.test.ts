import { describe, expect, it } from 'vitest';
import {
  LIGHT_FULL_TILES,
  ROOM_CLEAR_DELAY_MS,
  SIM_STEP_MS,
  TILE,
  TORCH_LOW_FRACTION,
  TORCH_MAX_MS,
  WIPE_RESTART_DELAY_MS,
} from './constants';
import {
  collectRequiredI18nKeys,
  makeTestDictionary,
  makeTestLayout,
  makeTestLevel,
  makeTestRoom,
  validateLevel,
} from './levelValidation';
import { createSimulation, GameSimulation } from './simulation';
import type {
  ActionFrame,
  BrazierState,
  CharacterId,
  LevelDef,
  MechanismDef,
  PlayerId,
  RoomDef,
  SimEvent,
  TickInputs,
  TileXY,
} from './types';

const DT = SIM_STEP_MS;

function frame(over: Partial<ActionFrame> = {}): ActionFrame {
  return { moveX: 0, moveY: 0, attack: false, interact: false, revive: false, ...over };
}

function centerOf(t: TileXY): { x: number; y: number } {
  return { x: (t[0] + 0.5) * TILE, y: (t[1] + 0.5) * TILE };
}

function setups(n: number, characterId: CharacterId = 'david') {
  return Array.from({ length: n }, (_, i) => ({ id: i as PlayerId, characterId, difficulty: 2 as const }));
}

/** Salle sombre valide : brasero allumé en [5,3] (près des spawns), plaque p1, sortie sans exigence. */
function darkRoom(id: string, over: Partial<RoomDef> = {}): RoomDef {
  return makeTestRoom({
    id,
    layout: makeTestLayout(16, 12),
    dark: true,
    mechanisms: [
      { id: 'p1', type: 'plate', tile: [6, 6] },
      { id: 'b1', type: 'brazier', tile: [5, 3], lit: true },
    ],
    exit: { rect: { x: 12, y: 5, w: 2, h: 2 }, requires: [] },
    ...over,
  });
}

function mkLevel(rooms: RoomDef[]): LevelDef {
  rooms[rooms.length - 1].exit.final = true;
  return makeTestLevel({ rooms });
}

function sim(level: LevelDef, n = 1): GameSimulation {
  return createSimulation({ levelId: level.id, players: setups(n), seed: 99 }, level);
}

function run(s: GameSimulation, ticks: number, inputs: TickInputs | ((i: number) => TickInputs) = {}): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < ticks; i++) out.push(...s.step(DT, typeof inputs === 'function' ? inputs(i) : inputs));
  return out;
}

const evTypes = (ev: readonly SimEvent[]): string[] => ev.map((e) => e.type);

// ───────────────────────────── Simulation : torches ─────────────────────────────

describe('simulation : torches en salle sombre', () => {
  it('démarre avec les torches pleines ; la torche s\'use 1 ms par ms de jeu', () => {
    const s = sim(mkLevel([darkRoom('r1')]), 2);
    expect(s.state.players.map((p) => p.torchMs)).toEqual([TORCH_MAX_MS, TORCH_MAX_MS]);
    run(s, 60);
    for (const p of s.state.players) expect(p.torchMs).toBeCloseTo(TORCH_MAX_MS - 60 * DT, 4);
  });

  it('salle claire : aucune usure', () => {
    const s = sim(mkLevel([darkRoom('r1', { dark: false })]), 1);
    run(s, 120);
    expect(s.state.players[0].torchMs).toBe(TORCH_MAX_MS);
  });

  it('un joueur à terre ne consomme pas ; les vivants oui', () => {
    const s = sim(mkLevel([darkRoom('r1')]), 2);
    s.state.players[1].status = 'down';
    s.state.players[1].hp = 0;
    run(s, 30);
    expect(s.state.players[0].torchMs).toBeLessThan(TORCH_MAX_MS);
    expect(s.state.players[1].torchMs).toBe(TORCH_MAX_MS);
  });

  it('torchLow puis torchOut sont émis une seule fois', () => {
    const s = sim(mkLevel([darkRoom('r1')]), 1);
    const p = s.state.players[0];
    p.torchMs = TORCH_MAX_MS * TORCH_LOW_FRACTION + 3 * DT;
    const ev = run(s, 10);
    expect(ev.filter((e) => e.type === 'torchLow')).toHaveLength(1);
    p.torchMs = 2 * DT;
    const ev2 = run(s, 10);
    expect(ev2.filter((e) => e.type === 'torchOut')).toHaveLength(1);
    expect(p.torchMs).toBe(0);
    expect(run(s, 10).filter((e) => e.type === 'torchOut')).toHaveLength(0);
  });

  it('recharge au brasero allumé via interact (front montant) : torchRefueled', () => {
    const s = sim(mkLevel([darkRoom('r1')]), 1);
    const p = s.state.players[0];
    p.pos = centerOf([4, 3]);
    p.torchMs = 1000;
    run(s, 1); // premier pas (roomEntered…)
    const ev = run(s, 2, (i) => (i === 0 ? { 0: frame({ interact: true }) } : { 0: frame({ interact: true }) }));
    expect(ev).toContainEqual({ type: 'torchRefueled', playerId: 0, brazierId: 'b1' });
    expect(p.torchMs).toBeGreaterThan(TORCH_MAX_MS - 100);
    // bouton maintenu : pas de nouvelle recharge
    p.torchMs = 5000;
    expect(evTypes(run(s, 5, { 0: frame({ interact: true }) }))).not.toContain('torchRefueled');
  });

  it('allumer un brasero éteint via interact ; torche vide : impossible', () => {
    const room = darkRoom('r1', {
      mechanisms: [
        { id: 'p1', type: 'plate', tile: [6, 6] },
        { id: 'b1', type: 'brazier', tile: [5, 3], lit: true },
        { id: 'b2', type: 'brazier', tile: [8, 3] },
      ],
    });
    const s = sim(mkLevel([room]), 1);
    const p = s.state.players[0];
    p.pos = centerOf([7, 3]);
    p.torchMs = 0;
    run(s, 1);
    run(s, 3, { 0: frame({ interact: true }) });
    expect((s.state.room.mechanisms[2] as BrazierState).active).toBe(false);
    run(s, 2); // relâche
    p.torchMs = 5000;
    const ev = run(s, 2, { 0: frame({ interact: true }) });
    expect((s.state.room.mechanisms[2] as BrazierState).active).toBe(true);
    expect(ev).toContainEqual({ type: 'brazierLit', brazierId: 'b2', playerId: 0 });
    expect(s.lights().filter((l) => l.kind === 'brazier')).toHaveLength(2);
  });

  it('le brasero est solide : un joueur qui fonce dessus ne le traverse pas', () => {
    const s = sim(mkLevel([darkRoom('r1')]), 1);
    const p = s.state.players[0];
    p.pos = centerOf([2, 3]);
    run(s, 120, { 0: frame({ moveX: 1 }) });
    expect(p.pos.x).toBeLessThan(5 * TILE); // bloqué par le brasero en [5,3]
    expect(p.pos.x).toBeGreaterThan(4 * TILE);
  });

  it('attaque + interact tenus près d\'un brasero actionnable : l\'interaction prime sur l\'attaque', () => {
    const s = sim(mkLevel([darkRoom('r1')]), 1);
    const p = s.state.players[0];
    p.pos = centerOf([4, 3]);
    p.torchMs = 1000;
    run(s, 1);
    // Le nouvel appui (front montant) actionne le brasero sans attaquer ; un bouton ensuite maintenu attaque à nouveau.
    const ev = run(s, 1, { 0: frame({ interact: true, attack: true }) });
    expect(evTypes(ev)).not.toContain('playerAttack');
    expect(evTypes(ev)).toContain('torchRefueled');
  });

  it('salle suivante : torches pleines à l\'entrée', () => {
    const s = sim(mkLevel([darkRoom('r1'), darkRoom('r2')]), 2);
    run(s, 300);
    expect(s.state.players[0].torchMs).toBeLessThan(TORCH_MAX_MS);
    s.state.players.forEach((p, i) => {
      p.pos = { x: 12.5 * TILE + i * 4, y: 6 * TILE };
    });
    const ev = run(s, Math.ceil((ROOM_CLEAR_DELAY_MS + 200) / DT));
    expect(ev).toContainEqual(expect.objectContaining({ type: 'roomEntered', reason: 'next' }));
    expect(s.state.roomIndex).toBe(1);
    for (const p of s.state.players) expect(TORCH_MAX_MS - p.torchMs).toBeLessThan(TORCH_MAX_MS * 0.05);
    const afterEntry = s.state.players[0].torchMs;
    run(s, 10);
    expect(s.state.players[0].torchMs).toBeLessThan(afterEntry);
  });

  it('redémarrage après défaite : torches pleines', () => {
    const s = sim(mkLevel([darkRoom('r1')]), 1);
    run(s, 600);
    const p = s.state.players[0];
    expect(p.torchMs).toBeLessThan(TORCH_MAX_MS);
    p.hp = 0;
    p.status = 'down';
    p.torchMs = 10;
    run(s, Math.ceil((WIPE_RESTART_DELAY_MS + 300) / DT));
    expect(s.state.players[0].status).toBe('alive');
    expect(s.state.players[0].torchMs).toBeGreaterThan(TORCH_MAX_MS - 2000);
  });

  it('lights() : torches des joueurs + brasero allumé + décors torch', () => {
    const room = darkRoom('r1', { decor: [{ type: 'torch', tile: [2, 0] }] });
    const s = sim(mkLevel([room]), 2);
    const kinds = s.lights().map((l) => l.kind).sort();
    expect(kinds).toEqual(['brazier', 'decor', 'torch', 'torch']);
  });
});

// ───────────────────────────── Simulation : embuscades 'enter:' ─────────────────────────────

describe('simulation : embuscade enter:<zone>', () => {
  const ambushRoom = (): RoomDef =>
    darkRoom('r1', {
      zones: [{ id: 'z1', rect: { x: 10, y: 8, w: 3, h: 3 } }],
      enemies: [
        { kind: 'slime', tile: [14, 9], when: 'enter:z1' },
        { kind: 'slime', tile: [14, 10], when: 'enter:z1', minPlayers: 2 },
      ],
    });

  it('aucun ennemi tant que personne n\'entre dans la zone ; apparaît dès qu\'un joueur y entre', () => {
    const s = sim(mkLevel([ambushRoom()]), 2);
    run(s, 120);
    expect(s.state.room.enemies).toHaveLength(0);
    s.state.players[1].pos = centerOf([11, 9]);
    const ev = run(s, 2);
    expect(ev.filter((e) => e.type === 'enemySpawned')).toHaveLength(2);
    expect(s.state.room.enemies).toHaveLength(2);
    // une seule fois : sortir puis rentrer ne ré-apparaît rien
    s.state.players[1].pos = centerOf([2, 8]);
    run(s, 5);
    s.state.players[1].pos = centerOf([11, 9]);
    expect(run(s, 5).filter((e) => e.type === 'enemySpawned')).toHaveLength(0);
  });

  it('minPlayers respecté : à 1 joueur un seul ennemi', () => {
    const s = sim(mkLevel([ambushRoom()]), 1);
    s.state.players[0].pos = centerOf([11, 9]);
    run(s, 2);
    expect(s.state.room.enemies).toHaveLength(1);
  });

  it('un joueur à terre dans la zone ne déclenche pas l\'embuscade', () => {
    const s = sim(mkLevel([ambushRoom()]), 2);
    s.state.players[1].status = 'down';
    s.state.players[1].hp = 0;
    s.state.players[1].pos = centerOf([11, 9]);
    run(s, 30);
    expect(s.state.room.enemies).toHaveLength(0);
  });

  it('la sortie ne s\'ouvre pas tant que l\'embuscade en attente n\'est pas résolue (clear)', () => {
    const room = ambushRoom();
    room.exit.requires = ['clear'];
    const s = sim(mkLevel([room]), 1);
    expect(s.isExitOpen()).toBe(false); // l'ennemi en attente compte
  });

  it('zone inconnue : jamais déclenchée', () => {
    const room = darkRoom('r1', { enemies: [{ kind: 'slime', tile: [14, 9], when: 'enter:nope' }] });
    const s = sim(mkLevel([room]), 1);
    s.state.players[0].pos = centerOf([11, 9]);
    run(s, 30);
    expect(s.state.room.enemies).toHaveLength(0);
  });

  it('porte exigeant enter:<zone> via la simulation', () => {
    const room = darkRoom('r1', {
      zones: [{ id: 'z1', rect: { x: 8, y: 8, w: 2, h: 2 } }],
      mechanisms: [
        { id: 'p1', type: 'plate', tile: [6, 6] },
        { id: 'b1', type: 'brazier', tile: [5, 3], lit: true },
        { id: 'd', type: 'door', tiles: [[10, 4]], requires: ['enter:z1'] },
      ],
    });
    const s = sim(mkLevel([room]), 1);
    run(s, 5);
    expect(s.state.room.mechanisms[2]).toMatchObject({ type: 'door', open: false });
    s.state.players[0].pos = centerOf([8, 8]);
    run(s, 2);
    expect(s.state.room.mechanisms[2]).toMatchObject({ type: 'door', open: true });
  });
});

// ───────────────────────────── Déterminisme / sérialisation ─────────────────────────────

describe('simulation : déterminisme et sérialisation avec torches', () => {
  const script = (i: number): TickInputs => ({
    0: frame({ moveX: Math.sin(i / 17), moveY: Math.cos(i / 23), interact: i % 90 < 3 }),
    1: frame({ moveX: Math.cos(i / 11), moveY: Math.sin(i / 29), interact: i % 120 < 3 }),
  });
  const level = (): LevelDef =>
    mkLevel([
      darkRoom('r1', {
        zones: [{ id: 'z1', rect: { x: 10, y: 8, w: 3, h: 3 } }],
        enemies: [{ kind: 'slime', tile: [14, 9], when: 'enter:z1' }],
        mechanisms: [
          { id: 'p1', type: 'plate', tile: [6, 6] },
          { id: 'b1', type: 'brazier', tile: [5, 3], lit: true },
          { id: 'b2', type: 'brazier', tile: [9, 3] },
        ],
      }),
    ]);

  it('même graine + mêmes entrées ⇒ états identiques (torchMs inclus)', () => {
    const a = sim(level(), 2);
    const b = sim(level(), 2);
    run(a, 900, script);
    run(b, 900, script);
    expect(a.serialize()).toBe(b.serialize());
    expect(a.state.players[0].torchMs).toBeLessThan(TORCH_MAX_MS);
  });

  it('snapshot/restore au milieu d\'une partie : la suite est identique', () => {
    const a = sim(level(), 2);
    run(a, 400, script);
    const snap = a.serialize();
    const parsed = JSON.parse(snap);
    expect(parsed.players[0].torchMs).toBe(a.state.players[0].torchMs);
    const b = GameSimulation.restore(snap, level());
    for (let i = 400; i < 800; i++) {
      a.step(DT, script(i));
      b.step(DT, script(i));
    }
    expect(b.serialize()).toBe(a.serialize());
  });
});

// ───────────────────────────── Validation de niveau ─────────────────────────────

describe('validateLevel : braseros, salles sombres, enter:', () => {
  const ok = (rooms: RoomDef[]): string[] => validateLevel(mkLevel(rooms));
  const has = (errs: string[], frag: string): boolean => errs.some((e) => e.includes(frag));

  it('une salle sombre correcte est valide', () => {
    expect(ok([darkRoom('r1')])).toEqual([]);
  });

  it('brasero seul = mécanisme coopératif suffisant ; brasero minPlayers 2 seul ne l\'est pas à 1 joueur', () => {
    const only = darkRoom('r1', { mechanisms: [{ id: 'b1', type: 'brazier', tile: [5, 3], lit: true }], exit: { rect: { x: 12, y: 5, w: 2, h: 2 }, requires: ['b1'] } });
    const lvl = makeTestLevel({
      rooms: [only],
      objectives: [0, 1, 2, 3].map((slot) => ({ id: `o${slot}`, slot, roomId: 'r1', kind: 'mechanism' as const, labelKey: `objective.test.o${slot}`, mechanismId: 'b1' })),
    });
    lvl.rooms[0].exit.final = true;
    expect(validateLevel(lvl)).toEqual([]);
    const two = darkRoom('r1', { mechanisms: [{ id: 'b1', type: 'brazier', tile: [5, 3], lit: true, minPlayers: 2 }] });
    expect(has(ok([two]), 'aucun mécanisme coopératif')).toBe(true);
  });

  it('salle sombre sans brasero lit:true : erreur', () => {
    const r = darkRoom('r1', { mechanisms: [{ id: 'p1', type: 'plate', tile: [6, 6] }, { id: 'b1', type: 'brazier', tile: [5, 3] }] });
    expect(has(ok([r]), 'sans brasero allumé')).toBe(true);
    const none = darkRoom('r1', { mechanisms: [{ id: 'p1', type: 'plate', tile: [6, 6] }] });
    expect(has(ok([none]), 'sans brasero allumé')).toBe(true);
  });

  it('salle claire sans brasero : aucune exigence de lumière', () => {
    const r = makeTestRoom({ id: 'r1', dark: false });
    expect(ok([r])).toEqual([]);
  });

  it('spawns trop loin de toute lumière : erreur ; un décor torch proche suffit', () => {
    const far = darkRoom('r1', {
      layout: makeTestLayout(24, 12),
      mechanisms: [{ id: 'p1', type: 'plate', tile: [6, 6] }, { id: 'b1', type: 'brazier', tile: [20, 3], lit: true }],
    });
    const errs = ok([far]);
    expect(has(errs, 'départ non éclairé')).toBe(true);
    expect(errs.filter((e) => e.includes('départ non éclairé'))).toHaveLength(4);
    const withTorch = darkRoom('r1', {
      layout: makeTestLayout(24, 12),
      mechanisms: [{ id: 'p1', type: 'plate', tile: [6, 6] }, { id: 'b1', type: 'brazier', tile: [20, 3], lit: true }],
      decor: [{ type: 'torch', tile: [3, 0] }],
    });
    expect(has(ok([withTorch]), 'départ non éclairé')).toBe(false);
  });

  it('limite exacte : spawn à LIGHT_FULL_TILES du brasero accepté, au-delà refusé', () => {
    const mk = (bx: number) =>
      darkRoom('r1', {
        layout: makeTestLayout(24, 12),
        playerSpawns: [[2, 3], [2, 3], [2, 3], [2, 3]],
        mechanisms: [{ id: 'p1', type: 'plate', tile: [6, 6] }, { id: 'b1', type: 'brazier', tile: [bx, 3], lit: true }],
      });
    expect(has(ok([mk(2 + LIGHT_FULL_TILES)]), 'départ non éclairé')).toBe(false);
    expect(has(ok([mk(2 + LIGHT_FULL_TILES + 1)]), 'départ non éclairé')).toBe(true);
  });

  it('brasero allumé inatteignable depuis les spawns : erreur', () => {
    const layout = makeTestLayout(16, 12).map((row, y) => (y > 0 && y < 11 ? row.slice(0, 9) + '#' + row.slice(10) : row));
    const r = darkRoom('r1', {
      layout,
      mechanisms: [{ id: 'p1', type: 'plate', tile: [6, 6] }, { id: 'b1', type: 'brazier', tile: [13, 3], lit: true }, { id: 'b0', type: 'brazier', tile: [5, 3] }],
    });
    const errs = ok([r]);
    expect(has(errs, 'brasero "b1"') || has(errs, 'brazier "b1"')).toBe(true);
    expect(has(errs, 'aucun brasero allumé accessible')).toBe(true);
  });

  it('brasero posé sur un mur / hors grille / sur un spawn / une porte : erreurs', () => {
    expect(has(ok([darkRoom('r1', { mechanisms: [{ id: 'p1', type: 'plate', tile: [6, 6] }, { id: 'b1', type: 'brazier', tile: [0, 0], lit: true }, { id: 'b2', type: 'brazier', tile: [5, 3], lit: true }] })]), 'brazier "b1"')).toBe(true);
    expect(has(ok([darkRoom('r1', { mechanisms: [{ id: 'p1', type: 'plate', tile: [6, 6] }, { id: 'b1', type: 'brazier', tile: [99, 3], lit: true }, { id: 'b2', type: 'brazier', tile: [5, 3], lit: true }] })]), 'hors de la grille')).toBe(true);
    expect(has(ok([darkRoom('r1', { mechanisms: [{ id: 'p1', type: 'plate', tile: [6, 6] }, { id: 'b1', type: 'brazier', tile: [2, 2], lit: true }] })]), 'recouvre')).toBe(true);
    const onDoor = darkRoom('r1', { mechanisms: [{ id: 'p1', type: 'plate', tile: [6, 6] }, { id: 'b1', type: 'brazier', tile: [5, 3], lit: true }, { id: 'd', type: 'door', tiles: [[5, 3]], requires: ['p1'] }] });
    expect(has(ok([onDoor]), 'recouvre la porte')).toBe(true);
  });

  it('brasero sur un ennemi : erreur', () => {
    const r = darkRoom('r1', { enemies: [{ kind: 'slime', tile: [5, 3] }] });
    expect(has(ok([r]), 'recouvre le brasero')).toBe(true);
  });

  it('brasero solide : il ne doit pas condamner un couloir', () => {
    // mur vertical en x=9 avec une seule ouverture en [9,5] ; un brasero sur l'ouverture isole la sortie
    const layout = makeTestLayout(16, 12).map((row, y) => (y > 0 && y < 11 && y !== 5 ? row.slice(0, 9) + '#' + row.slice(10) : row));
    const sealed = darkRoom('r1', {
      layout,
      mechanisms: [{ id: 'p1', type: 'plate', tile: [6, 6] }, { id: 'b1', type: 'brazier', tile: [5, 3], lit: true }, { id: 'b2', type: 'brazier', tile: [9, 5] }],
    });
    expect(has(ok([sealed]), 'zone de sortie inatteignable')).toBe(true);
    const open = darkRoom('r1', {
      layout,
      mechanisms: [{ id: 'p1', type: 'plate', tile: [6, 6] }, { id: 'b1', type: 'brazier', tile: [5, 3], lit: true }, { id: 'b2', type: 'brazier', tile: [7, 5] }],
    });
    expect(ok([open])).toEqual([]);
  });

  it('ownerSlot, lightRadiusTiles, ids dupliqués', () => {
    const slot = darkRoom('r1', { mechanisms: [{ id: 'p1', type: 'plate', tile: [6, 6] }, { id: 'b1', type: 'brazier', tile: [5, 3], lit: true, ownerSlot: 9 }] });
    expect(has(ok([slot]), 'ownerSlot')).toBe(true);
    const rad = darkRoom('r1', { mechanisms: [{ id: 'p1', type: 'plate', tile: [6, 6] }, { id: 'b1', type: 'brazier', tile: [5, 3], lit: true, lightRadiusTiles: 0 }] });
    expect(has(ok([rad]), 'lightRadiusTiles')).toBe(true);
    const dup = darkRoom('r1', { mechanisms: [{ id: 'p1', type: 'plate', tile: [6, 6] }, { id: 'b1', type: 'brazier', tile: [5, 3], lit: true }, { id: 'b1', type: 'brazier', tile: [8, 3] }] });
    expect(has(ok([dup]), 'dupliqué')).toBe(true);
  });

  it('une porte exigeant des braseros éteints est satisfiable si les braseros sont atteignables', () => {
    const mech: MechanismDef[] = [
      { id: 'p1', type: 'plate', tile: [6, 6] },
      { id: 'b1', type: 'brazier', tile: [5, 3], lit: true },
      { id: 'b2', type: 'brazier', tile: [5, 8] },
      { id: 'b3', type: 'brazier', tile: [9, 8], minPlayers: 3 },
      { id: 'd', type: 'door', tiles: [[11, 5], [11, 6]], requires: ['b2', 'b3'] },
    ];
    const r = darkRoom('r1', { mechanisms: mech, exit: { rect: { x: 12, y: 5, w: 2, h: 2 }, requires: ['d'] } });
    expect(ok([r])).toEqual([]);
  });

  it('enter:<zoneId> : zone existante OK, inexistante = erreur (when, requires de porte, sortie)', () => {
    const zones = [{ id: 'z1', rect: { x: 10, y: 8, w: 3, h: 3 } }];
    const good = darkRoom('r1', {
      zones,
      enemies: [{ kind: 'slime', tile: [14, 9], when: 'enter:z1' }],
      mechanisms: [
        { id: 'p1', type: 'plate', tile: [6, 6] },
        { id: 'b1', type: 'brazier', tile: [5, 3], lit: true },
        { id: 'd', type: 'door', tiles: [[11, 2]], requires: ['enter:z1'] },
      ],
      exit: { rect: { x: 12, y: 5, w: 2, h: 2 }, requires: ['enter:z1'] },
    });
    expect(ok([good])).toEqual([]);
    const badWhen = darkRoom('r1', { zones, enemies: [{ kind: 'slime', tile: [14, 9], when: 'enter:zz' }] });
    expect(has(ok([badWhen]), 'zone inexistante "zz"')).toBe(true);
    const badDoor = darkRoom('r1', {
      mechanisms: [
        { id: 'p1', type: 'plate', tile: [6, 6] },
        { id: 'b1', type: 'brazier', tile: [5, 3], lit: true },
        { id: 'd', type: 'door', tiles: [[11, 2]], requires: ['enter:zz'] },
      ],
    });
    expect(has(ok([badDoor]), 'porte "d" requires "enter:zz"')).toBe(true);
    const badExit = darkRoom('r1', { exit: { rect: { x: 12, y: 5, w: 2, h: 2 }, requires: ['enter:zz'] } });
    expect(has(ok([badExit]), 'exit.requires "enter:zz"')).toBe(true);
  });

  it('collectRequiredI18nKeys : labelKey d\'un brasero requise', () => {
    const r = darkRoom('r1', {
      mechanisms: [{ id: 'p1', type: 'plate', tile: [6, 6] }, { id: 'b1', type: 'brazier', tile: [5, 3], lit: true, labelKey: 'brazier.test.label' }],
    });
    const lvl = mkLevel([r]);
    expect(collectRequiredI18nKeys(lvl).some((k) => k.key === 'brazier.test.label')).toBe(true);
    const dict = makeTestDictionary(lvl);
    expect(validateLevel(lvl, { dictionaries: { fr: dict } })).toEqual([]);
    delete dict['brazier.test.label'];
    expect(validateLevel(lvl, { dictionaries: { fr: dict } }).some((e) => e.includes('brazier.test.label'))).toBe(true);
  });
});

