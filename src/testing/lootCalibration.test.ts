/**
 * Calibrage LÉGER des sources de vie (suite normale, quelques secondes) : direction de l'effet sur un cas court et invariants.
 *
 * Cas : le boss final du niveau 6 (salle « throne »), en SOLO, joué seul par des bots (entrée en PV pleins, comme dans le jeu), avec et sans
 * sources de vie (nourriture + cristaux, brique de bot `eat`), sur 8 graines. Mesuré hors suite (voir README, « calibrage mesuré ») : sans sources
 * de vie les bots y subissent des défaites collectives, avec elles beaucoup moins. Les bots sont un PROXY (pas de vraie esquive).
 *
 * Les assertions sont volontairement LARGES (sens de l'effet et invariants, pas des valeurs exactes) : la simulation est déterministe, mais un
 * futur réglage d'équilibrage ne doit pas casser ce test sans raison. Le calibrage complet (6 niveaux, 1 et 4 joueurs, 10 à 20 graines) est
 * le script à la demande `lootCalibration.long.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { LOOT_NEED_POINTS } from '../core/balance';
import { aggregate, CALIB_LEVELS, enableLoot, measureRoom, type RoomCalibResult } from './lootCalibration';
import { BotRun } from './botKit';

const SEEDS = [7, 11, 13, 17, 19, 23, 29, 31];
const level6 = CALIB_LEVELS.find((c) => c.no === 6)!;

function sum(rs: readonly RoomCalibResult[], f: (r: RoomCalibResult) => number): number {
  return rs.reduce((a, r) => a + f(r), 0);
}

const off: RoomCalibResult[] = [];
const on: RoomCalibResult[] = [];

describe('calibrage léger : boss final du niveau 6 en solo, sans / avec sources de vie', () => {
  it('joue les 8 graines des deux modes (toutes les salles sont validées)', () => {
    for (const seed of SEEDS) {
      off.push(measureRoom(level6, 1, seed, 'throne', false));
      on.push(measureRoom(level6, 1, seed, 'throne', true));
    }
    expect(off.every((r) => r.cleared)).toBe(true);
    expect(on.every((r) => r.cleared)).toBe(true);
  }, 90_000);

  it('invariant : sans sources de vie, rien ne tombe, rien n\'est ramassé, aucun cristal', () => {
    for (const r of off) {
      expect(r.tally.drops).toBe(0);
      expect(r.tally.collected).toBe(0);
      expect(r.tally.crystalsUsed).toBe(0);
    }
  });

  it('invariant : avec sources de vie, des PV sont rendus, jamais plus que les PV perdus', () => {
    const healed = sum(on, (r) => r.tally.foodHealed + r.tally.crystalHealed);
    expect(healed).toBeGreaterThan(0);
    for (const r of on) expect(r.tally.foodHealed + r.tally.crystalHealed).toBeLessThanOrEqual(r.hpLost);
  });

  it('direction : pas plus de défaites collectives avec sources de vie, et moins de temps passé sous 50 % de PV', () => {
    expect(sum(on, (r) => r.wipes)).toBeLessThanOrEqual(sum(off, (r) => r.wipes));
    const low = (rs: RoomCalibResult[]): number => sum(rs, (r) => r.tally.lowSteps) / Math.max(1, sum(rs, (r) => r.tally.steps));
    expect(low(on)).toBeLessThan(low(off));
  });

  it('pas trivial : le héros subit autant de dégâts par tentative (les sources de vie font tenir, elles ne suppriment pas la menace)', () => {
    const perAttempt = (rs: RoomCalibResult[]): number => sum(rs, (r) => r.hpLost) / sum(rs, (r) => r.wipes + 1);
    expect(perAttempt(off)).toBeGreaterThan(0);
    expect(perAttempt(on)).toBeGreaterThan(0.7 * perAttempt(off));
  });
});

describe('outils de calibrage', () => {
  it('enableLoot active les sources de vie, recrée les cristaux et la brique eat', () => {
    const run = level6.make(1, 7, level6.level.rooms.findIndex((r) => r.id === 'throne'));
    expect(run.state.lootEnabled).toBe(false);
    expect(run.state.room.healCrystals).toEqual([]);
    enableLoot(run);
    expect(run.state.lootEnabled).toBe(true);
    expect(run.state.room.healCrystals?.length).toBeGreaterThan(0);
    expect(run.bots[0].opts.eat).toBe(true);
    const passive: BotRun = level6.make(1, 7);
    enableLoot(passive, { eat: false });
    expect(passive.bots[0].opts.eat).toBe(false);
  });

  it('aggregate : moyennes, durée sur les parties terminées seulement', () => {
    const base = {
      level: 6, players: 1, seed: 1, loot: true, rooms: 2, downs: 0, roomWipes: {}, roomHpLost: {},
      tally: { kills: 10, drops: 2, collected: 1, foodHealed: 5, crystalsUsed: 0, crystalHealed: 0, steps: 100, lowSteps: 10, criticalSteps: 0 },
    };
    const a = aggregate([
      { ...base, completed: true, timeS: 100, wipes: 1, hpLost: 40, bars: 1 },
      { ...base, completed: false, timeS: 900, wipes: 3, hpLost: 60, bars: 1 },
    ]);
    expect(a.runs).toBe(2);
    expect(a.completed).toBe(1);
    expect(a.timeS).toBe(100);
    expect(a.wipes).toBe(2);
    expect(a.hpLostPerRoom).toBe(25);
    expect(a.dropsPerKill).toBeCloseTo(0.2, 6);
    expect(a.lowPct).toBeCloseTo(10, 6);
  });

  it('la courbe de besoin de la table couvre bien 100 % -> 30 % de PV (garde-fou : le calibrage suppose cette forme)', () => {
    expect(LOOT_NEED_POINTS[0].hpFraction).toBe(1);
    expect(LOOT_NEED_POINTS[LOOT_NEED_POINTS.length - 1].mult).toBeGreaterThan(LOOT_NEED_POINTS[0].mult);
  });
});
