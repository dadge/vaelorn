/**
 * Tests des primitives de bots pour les mécanismes inédits (`novelBots.ts`) sur des salles de test locales, à 1..4 joueurs.
 */
import { describe, expect, it } from 'vitest';
import { TILE } from '../core/constants';
import { isTileBlockedByMechanism } from '../core/mechanisms';
import { makeTestLevel, makeTestRoom, validateLevel } from '../core/levelValidation';
import type {
  HourglassState,
  LevelDef,
  LightBridgeState,
  MechanismDef,
  PlayerId,
  RoomDef,
  StatuePairState,
  TileXY,
} from '../core/types';
import {
  BotRun,
  conds,
  crossHourglass,
  escortLightBridge,
  expectUntil,
  flipHourglass,
  goTo,
  holdHourglass,
  hourglassGateOpen,
  nearestReachableTile,
  quarterTurnsBetween,
  relayHourglass,
  roomScript,
  runLevelScripts,
  solveStatuePair,
  statueSocketTile,
  type RoomScript,
} from './botKit';

// ───────────────────────────── Salles de test ─────────────────────────────

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

/** Niveau d'une salle finale avec 4 objectifs sur le mécanisme `objectiveId`. */
function oneRoomLevel(room: RoomDef, objectiveId: string): LevelDef {
  room.exit.final = true;
  return makeTestLevel({
    rooms: [room],
    objectives: [0, 1, 2, 3].map((slot) => ({
      id: `o${slot}`,
      slot,
      roomId: room.id,
      kind: 'mechanism' as const,
      labelKey: `objective.test.o${slot}`,
      mechanismId: objectiveId,
    })),
  });
}

const EXIT_RIGHT = { x: 15, y: 4, w: 2, h: 3 };
const exitDest = (id: PlayerId): TileXY => [15, 4 + (id % 3)];

// Statues jumelles : deux statues en haut, socles en dessous.
function statueLevel(over: Partial<MechanismDef> = {}): LevelDef {
  const sp = {
    id: 'sp',
    type: 'statuePair',
    statues: [
      { tile: [4, 3], standTile: [4, 5], facing: 'up' },
      { tile: [11, 3], standTile: [11, 5], facing: 'left' },
    ],
    targetDir: 'down',
    ...over,
  } as MechanismDef;
  const room = makeTestRoom({
    id: 'statues',
    layout: box(18, 10),
    playerSpawns: [[2, 6], [3, 6], [2, 7], [3, 7]],
    mechanisms: [sp],
    exit: { rect: EXIT_RIGHT, requires: [] },
  });
  return oneRoomLevel(room, 'sp');
}

// Sablier : mur vertical x=8 percé d'une herse de 3 tuiles ; leviers de part et d'autre.
const HOURGLASS_DEF: MechanismDef = {
  id: 'hg',
  type: 'hourglass',
  levers: [[5, 5], [11, 5]],
  gate: [[8, 4], [8, 5], [8, 6]],
  periodMs: 6000,
  closeStepMs: 700,
  displayTile: [7, 2],
};

function hourglassLevel(over: Partial<MechanismDef> = {}): LevelDef {
  const room = makeTestRoom({
    id: 'sand',
    layout: box(18, 10, (r) => {
      for (let y = 1; y <= 8; y++) r[y][8] = '#';
      for (const y of [4, 5, 6]) r[y][8] = '.';
    }),
    playerSpawns: [[2, 2], [3, 2], [2, 3], [3, 3]],
    mechanisms: [{ ...HOURGLASS_DEF, ...over } as MechanismDef],
    exit: { rect: EXIT_RIGHT, requires: [] },
  });
  return oneRoomLevel(room, 'hg');
}

// Pont de lumière : couloir d'une tuile de large (fosses de chaque côté) entre deux plateformes.
function bridgeLevel(over: Partial<MechanismDef> = {}): LevelDef {
  const tiles: TileXY[] = [6, 7, 8, 9, 10, 11].map((x) => [x, 5] as TileXY);
  const room = makeTestRoom({
    id: 'bridge',
    layout: box(18, 10, (r) => {
      for (let x = 6; x <= 11; x++) {
        for (let y = 1; y <= 8; y++) if (y !== 5) r[y][x] = '~';
      }
    }),
    playerSpawns: [[2, 4], [2, 5], [2, 6], [3, 5]],
    mechanisms: [{ id: 'br', type: 'lightBridge', tiles, lanternSlot: 1, radiusTiles: 2.5, ...over } as MechanismDef],
    exit: { rect: EXIT_RIGHT, requires: [] },
  });
  return oneRoomLevel(room, 'br');
}

const run1 = (level: LevelDef, n: number, scripts: RoomScript[], maxTotalMs = 150000) =>
  runLevelScripts(new BotRun(level, { playerCount: n }), scripts, { maxTotalMs, maxRoomMs: maxTotalMs });

// ───────────────────────────── Niveaux de test valides ─────────────────────────────

describe('salles de test locales', () => {
  it('sont valides pour validateLevel (n = 1..4)', () => {
    expect(validateLevel(statueLevel())).toEqual([]);
    expect(validateLevel(hourglassLevel())).toEqual([]);
    expect(validateLevel(bridgeLevel())).toEqual([]);
  });
});

// ───────────────────────────── Navigation : nouveaux solides ─────────────────────────────

describe('pathfinding des bots : statues, herse fermée, pont éteint sont des obstacles', () => {
  it('statues solides', () => {
    const run = new BotRun(statueLevel(), { playerCount: 2 });
    expect(run.isTilePassable(4, 3)).toBe(false);
    expect(run.isTilePassable(11, 3)).toBe(false);
    expect(run.isTilePassable(4, 5)).toBe(true); // socle praticable
  });

  it('herse fermée au départ, puis ouverte par le retournement', () => {
    const run = new BotRun(hourglassLevel(), { playerCount: 2 });
    for (const y of [4, 5, 6]) expect(run.isTilePassable(8, y)).toBe(false);
    expect(run.sim.solidRects()).toHaveLength(3);
    run.queue(0, flipHourglass('hg'));
    expectUntil(run, (r) => r.mechSolved('hg'), 10000, 'le sablier doit être retourné');
    for (const y of [4, 5, 6]) expect(run.isTilePassable(8, y)).toBe(true);
    // la tuile la plus proche accessible depuis la gauche, avant l'ouverture, est devant la herse
  });

  it('nearestReachableTile : devant la herse fermée / le pont éteint', () => {
    const run = new BotRun(hourglassLevel(), { playerCount: 2 });
    const t = nearestReachableTile(run, run.player(0).pos, [8, 5]);
    expect(t).toEqual([7, 5]);
    const run2 = new BotRun(bridgeLevel(), { playerCount: 2 });
    const t2 = nearestReachableTile(run2, run2.player(0).pos, [9, 5]);
    expect(t2[1]).toBe(5);
    expect(t2[0]).toBe(5); // dernière tuile accessible avant le pont éteint
  });
});

// ───────────────────────────── Statues jumelles ─────────────────────────────

describe('solveStatuePair', () => {
  for (let n = 1; n <= 4; n++) {
    it(`résout la paire et termine le niveau à ${n} joueur(s)`, () => {
      const run = new BotRun(statueLevel(), { playerCount: n });
      const script = roomScript('statues', (r) => {
        const ids = solveStatuePair(r, 'sp');
        expect(ids).toEqual(n === 1 ? [0] : [0, 1]);
        r.queueExit();
      });
      const res = runLevelScripts(run, [script], { maxTotalMs: 90000, maxRoomMs: 90000 });
      expect(res.failure, res.failure ?? '').toBeNull();
      expect(res.completed).toBe(true);
      expect((run.mech('sp') as StatuePairState).facings).toEqual(['down', 'down']);
      expect(run.failures).toEqual([]);
    });
  }

  it('chaque joueur tient son socle : à 2 joueurs les deux statues tournent en parallèle', () => {
    const run = new BotRun(statueLevel(), { playerCount: 2 });
    solveStatuePair(run, 'sp', { waitSolved: false });
    expectUntil(run, conds.mechActive('sp'), 40000, 'paire non résolue');
    // le joueur 0 a pivoté la statue 1 (3 quarts de tour), le joueur 1 la statue 0 (2 quarts de tour)
    const rotations = run.eventLog.filter((e) => /fait pivoter/.test(e.text));
    expect(rotations.filter((e) => /J1 fait pivoter la statue 1/.test(e.text))).toHaveLength(quarterTurnsBetween('left', 'down'));
    expect(rotations.filter((e) => /J2 fait pivoter la statue 0/.test(e.text))).toHaveLength(quarterTurnsBetween('up', 'down'));
  });

  it('paire waived (minPlayers > nbJoueurs) : rien à faire, files libres immédiatement', () => {
    const run = new BotRun(statueLevel({ minPlayers: 2 }), { playerCount: 1 });
    solveStatuePair(run, 'sp');
    expectUntil(run, (r) => r.allIdle, 2000, 'les files devraient se vider aussitôt');
    expect(run.failures).toEqual([]);
  });

  it('statueSocketTile et validation du type', () => {
    const run = new BotRun(statueLevel(), { playerCount: 2 });
    expect(statueSocketTile(run, 'sp', 0)).toEqual([4, 5]);
    expect(statueSocketTile(run, 'sp', 1)).toEqual([11, 5]);
    expect(() => solveStatuePair(new BotRun(hourglassLevel(), { playerCount: 2 }), 'hg')).toThrow(/pas une paire de statues/);
  });

  it('un mauvais choix de joueurs (tous deux sur le même socle) n\'empêche pas la résolution en solo', () => {
    const run = new BotRun(statueLevel(), { playerCount: 1 });
    solveStatuePair(run, 'sp', { players: [0, 0] });
    expectUntil(run, conds.mechActive('sp'), 60000, 'paire non résolue en solo');
  });
});

// ───────────────────────────── Sablier ─────────────────────────────

describe('sablier : flipHourglass, holdHourglass, crossHourglass, relayHourglass', () => {
  it('flipHourglass : va au levier le plus proche et retourne le sablier ; la herse s\'ouvre', () => {
    const run = new BotRun(hourglassLevel(), { playerCount: 2 });
    run.queue(0, flipHourglass('hg'));
    expectUntil(run, (r) => hourglassGateOpen(r, 'hg'), 10000, 'herse non ouverte');
    expect((run.mech('hg') as HourglassState).lastLever).toBe(0);
  });

  it('crossHourglass sans personne pour tenir le sablier : le joueur attend devant la herse fermée', () => {
    const run = new BotRun(hourglassLevel(), { playerCount: 2 });
    run.queue(0, crossHourglass('hg', [15, 5]));
    run.stepFor(6000);
    expect(run.player(0).pos.x).toBeLessThan(8 * TILE);
    expect(run.player(0).pos.x).toBeGreaterThan(5 * TILE); // il s'est approché de la herse
    expect(run.failures).toEqual([]);
  });

  it('holdHourglass : le tenant garde la herse ouverte bien au-delà d\'une période, puis s\'arrête quand `until` est vrai', () => {
    const run = new BotRun(hourglassLevel(), { playerCount: 2 });
    run.queue(0, holdHourglass('hg', { until: (r) => r.timeMs > 20000 }));
    let minSandAfterFirst = Infinity;
    let flipped = false;
    while (run.timeMs < 21000 && !run.bot(0).isIdle) {
      run.stepOnce();
      const st = run.mech('hg') as HourglassState;
      if (st.sandMs > 0) flipped = true;
      if (flipped) {
        expect(st.closedCount, `t=${run.timeMs}`).toBe(0);
        minSandAfterFirst = Math.min(minSandAfterFirst, st.sandMs);
      }
    }
    expect(run.bot(0).isIdle).toBe(true);
    expect(minSandAfterFirst).toBeGreaterThan(0.3 * 6000); // retourné avant la fin (seuil 50 %, marge de réaction)
    expect(run.eventLog.filter((e) => /retourne le sablier/.test(e.text)).length).toBeGreaterThanOrEqual(3);
    expect(run.failures).toEqual([]);
  });

  for (let n = 1; n <= 4; n++) {
    it(`relayHourglass : tous les joueurs passent la herse et le niveau se termine à ${n} joueur(s), sans que le sable ne se vide`, () => {
      const run = new BotRun(hourglassLevel(), { playerCount: n });
      const script = roomScript('sand', (r) => {
        const ids = relayHourglass(r, 'hg', { dest: exitDest });
        expect(ids).toHaveLength(n);
        r.queueExit();
      });
      const res = runLevelScripts(run, [script], { maxTotalMs: 120000, maxRoomMs: 120000 });
      expect(res.failure, res.failure ?? '').toBeNull();
      expect(res.completed).toBe(true);
      expect(run.failures).toEqual([]);
      expect(run.eventLog.some((e) => /VIDE/.test(e.text))).toBe(false);
      expect(run.eventLog.some((e) => /herse hg/.test(e.text))).toBe(false); // aucune tuile fermée après l'ouverture
    });
  }

  it('solo : la période est doublée, retourner puis courir suffit même avec une période courte', () => {
    // période de 4 s ⇒ 8 s en solo ; la traversée (≈ 7 tuiles) tient largement
    const run = new BotRun(hourglassLevel({ periodMs: 4000 }), { playerCount: 1 });
    expectEffective(run, 8000);
    const res = runLevelScripts(
      run,
      [
        roomScript('sand', (r) => {
          relayHourglass(r, 'hg', { dest: exitDest });
          r.queueExit();
        }),
      ],
      { maxTotalMs: 60000, maxRoomMs: 60000 },
    );
    expect(res.failure, res.failure ?? '').toBeNull();
    expect(res.completed).toBe(true);
  });

  it('sablier waived (minPlayers 2 à 1 joueur) : la traversée est libre', () => {
    const run = new BotRun(hourglassLevel({ minPlayers: 2 }), { playerCount: 1 });
    const res = runLevelScripts(
      run,
      [
        roomScript('sand', (r) => {
          relayHourglass(r, 'hg', { dest: exitDest });
          r.queueExit();
        }),
      ],
      { maxTotalMs: 60000, maxRoomMs: 60000 },
    );
    expect(res.failure, res.failure ?? '').toBeNull();
    expect(res.completed).toBe(true);
  });

  it('relayHourglass : erreurs de configuration lisibles', () => {
    const run = new BotRun(hourglassLevel(), { playerCount: 2 });
    expect(() => relayHourglass(run, 'hg', { dest: [15, 5], toLever: 5 })).toThrow(/pas de levier 5/);
    expect(() => relayHourglass(run, 'hg', { dest: [15, 5], players: [] })).toThrow(/aucun participant/);
    expect(() => relayHourglass(run, 'hg', { dest: [15, 5], holder: 3 })).toThrow(/tenant/);
    expect(() => relayHourglass(new BotRun(statueLevel(), { playerCount: 2 }), 'sp', { dest: [15, 5] })).toThrow(/pas un sablier/);
  });

  it('diagnostic : le rapport décrit le sablier (sable, herse)', () => {
    const run = new BotRun(hourglassLevel(), { playerCount: 2 });
    const text = run.diagnose();
    expect(text).toMatch(/hg \(hourglass, leviers 5,5 11,5, herse 8,4 8,5 8,6\)/);
    expect(text).toMatch(/sable VIDE, herse 3\/3 fermée\(s\)/);
  });
});

function expectEffective(run: BotRun, ms: number): void {
  run.queue(0, flipHourglass('hg'));
  expectUntil(run, (r) => r.mechSolved('hg'), 10000, 'retournement solo');
  const st = run.mech('hg') as HourglassState;
  expect(st.sandMs).toBeGreaterThan(ms - 2500);
  expect(st.sandMs).toBeLessThanOrEqual(ms);
  run.clearQueue();
}

// ───────────────────────────── Pont de lumière ─────────────────────────────

describe('escortLightBridge', () => {
  /** Joue `n` joueurs sur le pont en vérifiant à chaque pas qu'aucun joueur vivant n'est pris dans une tuile solide. */
  function playBridge(n: number, over: Partial<MechanismDef> = {}): BotRun {
    const run = new BotRun(bridgeLevel(over), { playerCount: n });
    run.queue(0, []); // (files vides) — les scripts sont posés ci-dessous
    escortLightBridge(run, 'br', { dest: exitDest });
    run.queueExit();
    let steps = 0;
    while (!run.levelComplete && run.timeMs < 120000) {
      run.stepOnce();
      steps++;
      for (const p of run.alivePlayers()) {
        const tx = Math.floor(p.pos.x / TILE);
        const ty = Math.floor(p.pos.y / TILE);
        expect(isTileBlockedByMechanism(run.room, run.state.room.mechanisms, tx, ty), `n=${n} J${p.id + 1} piégé en ${tx},${ty} (pas ${steps})`).toBe(false);
      }
    }
    return run;
  }

  for (let n = 1; n <= 4; n++) {
    it(`le porteur guide les autres : traversée complète et niveau terminé à ${n} joueur(s)`, () => {
      const run = playBridge(n);
      expect(run.levelComplete, run.diagnose('pont non traversé')).toBe(true);
      expect(run.failures).toEqual([]);
      const br = run.mech('br') as LightBridgeState;
      expect(br.bearerId).toBe(run.playerFor(1));
    });
  }

  it('lanternSlot 3 à 4 joueurs : le joueur 4 porte la lanterne', () => {
    const run = playBridge(4, { lanternSlot: 3 });
    expect(run.levelComplete, run.diagnose()).toBe(true);
    expect((run.mech('br') as LightBridgeState).bearerId).toBe(3);
  });

  it('pont waived (minPlayers 2 à 1 joueur) : traversée libre', () => {
    const run = playBridge(1, { minPlayers: 2 });
    expect(run.levelComplete, run.diagnose()).toBe(true);
  });

  it('sans escorte, un non-porteur ne peut pas traverser : aucun chemin vers l\'autre rive', () => {
    const run = new BotRun(bridgeLevel(), { playerCount: 2 });
    // J2 (porteur, lanternSlot 1) reste à l'écart ; J1 tente la traversée
    run.queue(0, goTo([15, 5], { onUnreachable: 'fail', unreachableGraceMs: 800 }));
    run.stepFor(4000);
    expect(run.failures.some((f) => /aucun chemin/.test(f.reason))).toBe(true);
    expect(run.player(0).pos.x).toBeLessThan(7 * TILE);
  });

  it('erreurs de configuration lisibles', () => {
    const run = new BotRun(bridgeLevel(), { playerCount: 2 });
    expect(() => escortLightBridge(run, 'br', { dest: [15, 5], players: [0] })).toThrow(/porteur/);
    expect(() => escortLightBridge(run, 'br', { dest: [15, 5], route: [] })).toThrow(/route vide/);
    expect(() => escortLightBridge(new BotRun(hourglassLevel(), { playerCount: 2 }), 'hg', { dest: [15, 5] })).toThrow(/pas un pont de lumière/);
  });

  it('diagnostic : le rapport décrit le pont (porteur, tuiles éclairées)', () => {
    const run = new BotRun(bridgeLevel(), { playerCount: 2 });
    run.stepOnce();
    const text = run.diagnose();
    expect(text).toMatch(/br \(lightBridge, pont 6,5 7,5 8,5 9,5 10,5 11,5 \(lanterne slot 1, rayon 2.5\)\)/);
    expect(text).toMatch(/porteur J2/);
  });
});
