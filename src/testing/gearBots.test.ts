/**
 * Bots et équipement :
 *  - les bots existants jouent SANS équipement par défaut (`gear` faux) : leurs résultats sont strictement ceux d'avant l'ajout (même principe que `loot`) ;
 *  - la brique `pickGear` (option de fond, désactivée par défaut) : « ramasse l'équipement proche strictement meilleur », utilisée par la calibration ;
 *  - `enableGear` active l'équipement sur une partie déjà créée (fabriques des niveaux).
 */
import { describe, expect, it } from 'vitest';
import { TILE } from '../core/constants';
import { makeTestLayout, makeTestLevel, makeTestRoom } from '../core/levelValidation';
import type { GearItem, LevelDef, TileXY } from '../core/types';
import { attackUntilClear } from './botActions';
import { shotClear } from './botBrain';
import { BotRun, DEFAULT_BACKGROUND, runUntil } from './botKit';
import { CALIB_LEVELS, measureGearRoom } from './gearCalibration';
import { enableGear } from './lootCalibration';

function emptyLevel(): LevelDef {
  const room = makeTestRoom({
    id: 'r1',
    layout: makeTestLayout(40, 12),
    mechanisms: [],
    enemies: [],
    exit: { rect: { x: 36, y: 5, w: 2, h: 2 }, requires: [], final: true },
  });
  return makeTestLevel({ rooms: [room], objectives: [] });
}

const px = (t: TileXY): { x: number; y: number } => ({ x: (t[0] + 0.5) * TILE, y: (t[1] + 0.5) * TILE });

function drop(run: BotRun, t: TileXY, item: GearItem, lockedFor: 0 | 1 | null = null): void {
  const id = run.state.nextGearDropId ?? 1;
  run.state.nextGearDropId = id + 1;
  run.state.room.gearDrops?.push({ id, item, pos: px(t), ttlMs: 20_000, lockedFor, lockMode: 'life' });
}

describe('bots existants : sans équipement par défaut', () => {
  it('BotRun joue avec `gear` faux (aucun objet, budget 0) sauf demande explicite', () => {
    const legacy = new BotRun(emptyLevel(), { playerCount: 1 });
    expect(legacy.state.gearEnabled).toBe(false);
    expect(legacy.state.room.gearBudget).toBe(0);
    const real = new BotRun(emptyLevel(), { playerCount: 2, gear: true });
    expect(real.state.gearEnabled).toBe(true);
    expect(real.state.room.gearBudget).toBe(2);
  });
  it('la brique de ramassage est désactivée par défaut : un bot ne va pas chercher l\'équipement', () => {
    expect(DEFAULT_BACKGROUND.pickGear).toBe(false);
    const run = new BotRun(emptyLevel(), { playerCount: 1, gear: true });
    drop(run, [10, 6], { slot: 'boots', level: 3 });
    for (let i = 0; i < 600; i++) run.stepOnce();
    expect(run.state.room.gearDrops).toHaveLength(1);
    expect(run.player(0).loadout.boots).toBe(0);
  });
});

describe('brique « ramasse l\'équipement proche » (option pickGear)', () => {
  it('va chercher un objet strictement meilleur et l\'équipe', () => {
    const run = new BotRun(emptyLevel(), { playerCount: 1, gear: true, background: { pickGear: true } });
    drop(run, [8, 6], { slot: 'protection', level: 2 });
    const ok = runUntil(run, () => run.player(0).loadout.protection === 2, 15_000).ok;
    expect(ok).toBe(true);
    expect(run.state.room.gearDrops).toHaveLength(0);
  });
  it('ignore un objet qui ne serait pas ramassé (niveau égal) ou qui lui est verrouillé', () => {
    const run = new BotRun(emptyLevel(), { playerCount: 1, gear: true, background: { pickGear: true } });
    run.player(0).loadout.boots = 2;
    drop(run, [8, 6], { slot: 'boots', level: 2 });
    drop(run, [9, 6], { slot: 'weapon', level: 1 }, 0);
    for (let i = 0; i < 400; i++) run.stepOnce();
    expect(run.state.room.gearDrops).toHaveLength(2);
  });
  it('rayon de repérage : un objet trop loin n\'est pas cherché', () => {
    const run = new BotRun(emptyLevel(), { playerCount: 1, gear: true, background: { pickGear: true, gearRadius: 20 } });
    drop(run, [20, 6], { slot: 'weapon', level: 3 });
    for (let i = 0; i < 300; i++) run.stepOnce();
    expect(run.player(0).loadout.weapon).toBe(0);
  });
  it('enableGear : active l\'équipement et la brique sur une partie existante', () => {
    const run = new BotRun(emptyLevel(), { playerCount: 2 });
    expect(run.state.gearEnabled).toBe(false);
    enableGear(run);
    expect(run.state.gearEnabled).toBe(true);
    expect(run.state.room.gearBudget).toBe(2);
    drop(run, [8, 6], { slot: 'artifact', level: 1 });
    const ok = runUntil(run, () => run.player(0).loadout.artifact === 1 || run.player(1).loadout.artifact === 1, 15_000).ok;
    expect(ok).toBe(true);
  });
});

describe('brique « équipement » : accessoires et bonus temporaires', () => {
  it('va chercher un accessoire pour un emplacement vide, un bonus temporaire au sol, et ignore un accessoire d\'une autre sorte (échange manuel)', () => {
    const run = new BotRun(emptyLevel(), { playerCount: 1, gear: true, background: { pickGear: true } });
    drop(run, [8, 6], { slot: 'accessory', level: 1, accessory: 'magnet' });
    expect(runUntil(run, () => run.player(0).loadout.accessory?.kind === 'magnet', 15_000).ok).toBe(true);
    // accessoire d'une AUTRE sorte : jamais visé (il faudrait appuyer sur A) ; le bot ne bouge pas pour lui
    drop(run, [20, 6], { slot: 'accessory', level: 3, accessory: 'lantern' });
    for (let i = 0; i < 300; i++) run.stepOnce();
    expect(run.player(0).loadout.accessory).toEqual({ kind: 'magnet', level: 1 });
    expect(run.state.room.gearDrops).toHaveLength(1);
    // bonus temporaire au sol : ramassé
    const id = run.state.nextGearDropId ?? 1;
    run.state.nextGearDropId = id + 1;
    run.state.room.buffDrops?.push({ id, kind: 'speed', pos: px([12, 6]), ttlMs: 20_000 });
    expect(runUntil(run, () => run.player(0).loadout.buffs.some((b) => b.kind === 'speed'), 15_000).ok).toBe(true);
  });
});

describe('bot de mêlée armé : il se bat en tireur ([B34] : toute arme fait tirer de loin)', () => {
  const arena = (): LevelDef => {
    const room = makeTestRoom({
      id: 'r1',
      layout: makeTestLayout(30, 10),
      mechanisms: [],
      enemies: [{ kind: 'slime', tile: [22, 5] }, { kind: 'slime', tile: [24, 3] }],
      exit: { rect: { x: 27, y: 4, w: 2, h: 2 }, requires: ['clear'], final: true },
    });
    return makeTestLevel({ rooms: [room], objectives: [] });
  };

  for (const [weapon, kind] of [[1, 'wave'], [2, 'axe'], [3, 'arrow']] as const) {
    it(`David avec l'arme de niveau ${weapon} : tire des projectiles « ${kind} », ne frappe pas au corps à corps et vainc la salle`, () => {
      const run = new BotRun(arena(), { playerCount: 1, characters: ['david'], gear: true });
      run.player(0).loadout.weapon = weapon;
      run.queue(0, attackUntilClear());
      const seen = new Set<string>();
      for (let i = 0; i < 40 * 60 && run.aliveEnemies.length > 0; i++) {
        run.stepOnce();
        for (const p of run.state.room.projectiles) if (p.owner.type === 'player') seen.add(p.kind);
      }
      expect(run.aliveEnemies.length, run.diagnose('ennemis non vaincus')).toBe(0);
      expect([...seen]).toEqual([kind]);
      expect(run.player(0).status).toBe('alive');
      expect(run.stats.players[0].kills).toBe(2);
    });
  }

  it('sans arme : le même bot reste au corps à corps (aucun projectile de joueur)', () => {
    const run = new BotRun(arena(), { playerCount: 1, characters: ['david'], gear: true });
    run.queue(0, attackUntilClear());
    let shots = 0;
    for (let i = 0; i < 40 * 60 && run.aliveEnemies.length > 0; i++) {
      run.stepOnce();
      shots += run.state.room.projectiles.filter((p) => p.owner.type === 'player').length;
    }
    expect(run.aliveEnemies.length).toBe(0);
    expect(shots).toBe(0);
  });

  it('un tireur (Aelith) avec une épée garde sa flèche : jamais d\'onde', () => {
    const run = new BotRun(arena(), { playerCount: 1, characters: ['aelith'], gear: true });
    run.player(0).loadout.weapon = 1;
    run.queue(0, attackUntilClear());
    const seen = new Set<string>();
    for (let i = 0; i < 40 * 60 && run.aliveEnemies.length > 0; i++) {
      run.stepOnce();
      for (const p of run.state.room.projectiles) if (p.owner.type === 'player') seen.add(p.kind);
    }
    expect(run.aliveEnemies.length).toBe(0);
    expect([...seen]).toEqual(['arrow']);
  });

  /** Salle 30x10 avec une tuile de mur isolée en [10,3] (coin saillant) : sert à la ligne de tir et à l'alignement bloqué. */
  const cornerRoom = (enemy: [number, number]): LevelDef => {
    const layout = makeTestLayout(30, 10).map((r) => r.split(''));
    layout[3][10] = '#';
    const room = makeTestRoom({
      id: 'r1',
      layout: layout.map((r) => r.join('')),
      mechanisms: [],
      enemies: [{ kind: 'slime', tile: enemy }],
      exit: { rect: { x: 27, y: 4, w: 2, h: 2 }, requires: ['clear'], final: true },
    });
    return makeTestLevel({ rooms: [room], objectives: [] });
  };

  it('shotClear : le rayon MUR d\'un projectile de joueur est ramené à 2 px (comme le coeur) : une onde (rayon 6) ou une hache (rayon 5) rasant un coin à 3 px passent', () => {
    const run = new BotRun(cornerRoom([20, 7]), { playerCount: 1, characters: ['david'], gear: true });
    run.player(0).loadout.weapon = 1; // héros de mêlée ARMÉ (le seul cas concerné : les bots tireurs d'origine gardent le rayon complet, pour rester identiques)
    const bot = run.bots[0];
    // la tuile [10,3] occupe x 160..176, y 48..64 : un tir horizontal à y = 45 passe à 3 px de son bord haut
    const a = { x: 130, y: 45 };
    const b = { x: 200, y: 45 };
    expect(shotClear(bot, a, b, 2)).toBe(true);
    expect(shotClear(bot, a, b, 5)).toBe(true); // hache lancée
    expect(shotClear(bot, a, b, 6)).toBe(true); // onde d'épée
    // un vrai obstacle reste un obstacle, quel que soit le rayon
    expect(shotClear(bot, { x: 130, y: 56 }, { x: 200, y: 56 }, 6)).toBe(false);
    // sans arme (corps à corps) ou pour un tireur d'origine : rayon complet, comportement des bots inchangé
    run.player(0).loadout.weapon = 0;
    expect(shotClear(bot, a, b, 6)).toBe(false);
    const shooter = new BotRun(cornerRoom([20, 7]), { playerCount: 1, characters: ['aelith'], gear: true });
    expect(shotClear(shooter.bots[0], a, b, 6)).toBe(false);
  });

  for (const [weapon, kind] of [[1, 'wave'], [2, 'axe']] as const) {
    it(`bot armé (niveau ${weapon}, « ${kind} ») : un ennemi dans l'ombre d'un coin de mur (alignement qui pousse contre le mur) est atteint et vaincu`, () => {
      const run = new BotRun(cornerRoom([11, 8]), { playerCount: 1, characters: ['david'], gear: true });
      run.player(0).loadout.weapon = weapon;
      // départ collé au coin : s'aligner sur la colonne de l'ennemi (x + 24 px) pousse le bot contre le mur
      run.player(0).pos = { x: 152, y: 56 };
      run.queue(0, attackUntilClear({ maxMs: 90000 }));
      for (let i = 0; i < 60 * 60 && run.aliveEnemies.length > 0; i++) run.stepOnce();
      expect(run.aliveEnemies.length, run.diagnose('ennemi non vaincu')).toBe(0);
    });
  }

  it('salle vaste et clairsemée (niveau 4, « spire », ~22 ennemis au repos) : un bot armé de l\'onde, de la hache ou de l\'arc la nettoie sans rester figé contre un mur (< 190 s ; sans arme ~91 s)', () => {
    const calib = CALIB_LEVELS.find((c) => c.no === 4);
    if (!calib) throw new Error('niveau 4 absent de CALIB_LEVELS');
    for (const weapon of [1, 2, 3] as const) {
      const r = measureGearRoom(calib, 1, 7, 'spire', { start: { boots: 0, protection: 0, artifact: 0, magic: 0, weapon, accessory: null } });
      expect(r.cleared, `arme de niveau ${weapon} : salle non nettoyée`).toBe(true);
      expect(r.timeS, `arme de niveau ${weapon}`).toBeLessThan(190);
    }
  });
});
