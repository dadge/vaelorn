/**
 * Calibrage LÉGER de l'ÉQUIPEMENT (suite normale, ~15 s) : budget de puissance en pur calcul, puis quelques simulations de bots courtes.
 *
 * Cas simulés (mesurés hors suite, voir README « Équipement et bonus », « calibrage mesuré ») :
 *  - le boss final du niveau 6 (salle « throne »), en SOLO, 8 graines, sans équipement / avec l'équipement TYPIQUE de la 4e salle / avec TOUT au niveau III ;
 *  - le budget d'objets de la salle « ashgate » du niveau 5 (une salle de combat qui dépense tout son budget), à 1 et à 4 joueurs.
 * Les bots sont un PROXY du joueur (pas d'esquive, l'arc ne leur sert pas à garder leurs distances) : les assertions sont volontairement LARGES (sens de
 * l'effet, invariants, bornes du budget), pas des valeurs exactes. Le calibrage complet (6 niveaux, 1 et 4 joueurs, >= 5 graines) est le script à la
 * demande `gearCalibration.long.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { CHARACTER_IDS } from '../core/characters';
import { GEAR_CAPS } from '../core/balance';
import { createGear } from '../core/gear';
import type { PlayerGear } from '../core/types';
import {
  aggregateGear,
  CALIB_LEVELS,
  expectedPower,
  FULL_GEAR,
  gearSummary,
  giveGear,
  measureGearRoom,
  powerIndex,
  TYPICAL_GEAR,
  type GearRoomResult,
} from './gearCalibration';

const SEEDS = [7, 11, 13, 17, 19, 23, 29, 31];
const level5 = CALIB_LEVELS.find((c) => c.no === 5)!;
const level6 = CALIB_LEVELS.find((c) => c.no === 6)!;
const gear = (over: Partial<PlayerGear>): PlayerGear => ({ ...createGear(), ...over });
const sum = (rs: readonly GearRoomResult[], f: (r: GearRoomResult) => number): number => rs.reduce((a, r) => a + f(r), 0);
/** PV perdus par tentative (une tentative = la première + une par défaite collective). */
const perAttempt = (rs: readonly GearRoomResult[]): number => sum(rs, (r) => r.hpLost) / sum(rs, (r) => r.wipes + 1);
/** Part du temps passée sous 50 % de PV (joueur vivant le plus blessé). */
const low = (rs: readonly GearRoomResult[]): number => sum(rs, (r) => r.lowSteps) / Math.max(1, sum(rs, (r) => r.steps));

describe('indice de puissance (pur calcul)', () => {
  it('sans équipement : 1 ; chaque pièce de défense, de vitesse ou de recharge augmente la puissance avec son niveau', () => {
    for (const id of CHARACTER_IDS) {
      expect(powerIndex(id, createGear())).toBe(1);
      for (const slot of ['boots', 'protection', 'artifact'] as const) {
        const p = [1, 2, 3].map((lv) => powerIndex(id, gear({ [slot]: lv })));
        expect(p[0]).toBeGreaterThan(1);
        expect(p[1]).toBeGreaterThan(p[0]);
        expect(p[2]).toBeGreaterThan(p[1]);
      }
    }
  });
  it('la magie (relevage) et l\'accessoire ne comptent pas dans la puissance de combat', () => {
    expect(powerIndex('david', gear({ magic: 3, accessory: { kind: 'magnet', level: 3 } }))).toBe(1);
  });
  it('budget : tout au niveau III donne ~+60 à +80 % (+90 % au plus pour un tireur, arc +15 % de dégâts), jamais le double', () => {
    for (const id of CHARACTER_IDS) {
      const p = powerIndex(id, FULL_GEAR);
      expect(p).toBeGreaterThanOrEqual(1.6);
      expect(p).toBeLessThanOrEqual(1.95);
    }
    expect(powerIndex('david', FULL_GEAR)).toBeLessThan(powerIndex('valentine', FULL_GEAR));
  });
  it('budget : l\'équipement typique de la 4e salle (3 pièces) donne ~+20 %', () => {
    expect(gearSummary(TYPICAL_GEAR as PlayerGear).pieces).toBe(3);
    const p = powerIndex('david', TYPICAL_GEAR);
    expect(p).toBeGreaterThan(1.15);
    expect(p).toBeLessThan(1.3);
  });
  it('budget attendu des tirages : ~+20 à +30 % à l\'entrée de la 4e salle (3 objets reçus), ~+35 à +45 % après 6 salles, sans atteindre le maximum', () => {
    for (const n of [1, 4]) {
      const at3 = expectedPower('david', 3, n, 1000);
      expect(at3).toBeGreaterThan(1.18);
      expect(at3).toBeLessThan(1.32);
      const at6 = expectedPower('david', 6, n, 1000);
      expect(at6).toBeGreaterThan(1.32);
      expect(at6).toBeLessThan(1.5);
      expect(at6).toBeLessThan(powerIndex('david', FULL_GEAR));
    }
  });
  it('plafonds : ceux de balance.ts (vitesse +30 %, protection -30 %, spécial -35 %) ne sont pas dépassés', () => {
    expect(GEAR_CAPS.protection).toBeLessThanOrEqual(0.3);
    expect(GEAR_CAPS.speed).toBeLessThanOrEqual(0.3);
    expect(GEAR_CAPS.special).toBeLessThanOrEqual(0.35);
  });
});

describe('calibrage léger : boss final du niveau 6 en solo, sans / avec équipement', () => {
  const none: GearRoomResult[] = [];
  const typical: GearRoomResult[] = [];
  const full: GearRoomResult[] = [];

  it('joue les 8 graines des trois modes (toutes les salles sont validées)', () => {
    for (const seed of SEEDS) {
      none.push(measureGearRoom(level6, 1, seed, 'throne'));
      typical.push(measureGearRoom(level6, 1, seed, 'throne', { start: TYPICAL_GEAR }));
      full.push(measureGearRoom(level6, 1, seed, 'throne', { start: FULL_GEAR }));
    }
    for (const rs of [none, typical, full]) expect(rs.every((r) => r.cleared)).toBe(true);
  }, 90_000);

  it('invariant : le boss final ne laisse aucun objet, et rien n\'est ramassé', () => {
    for (const r of [...none, ...typical, ...full]) {
      expect(r.gearDrops).toBe(0);
      expect(r.picked).toBe(0);
    }
  });

  it('direction : avec l\'équipement typique, pas plus de défaites, moins de PV perdus par tentative et moins de temps sous 50 % de PV', () => {
    expect(sum(typical, (r) => r.wipes)).toBeLessThanOrEqual(sum(none, (r) => r.wipes));
    expect(perAttempt(typical)).toBeLessThan(perAttempt(none));
    expect(low(typical)).toBeLessThan(low(none));
  });

  it('pas trivial : avec l\'équipement typique ou tout au niveau III, le héros subit encore au moins 40 % des dégâts d\'avant et reste blessé', () => {
    expect(perAttempt(none)).toBeGreaterThan(0);
    expect(perAttempt(typical)).toBeGreaterThan(0.4 * perAttempt(none));
    expect(perAttempt(full)).toBeGreaterThan(0.4 * perAttempt(none));
    expect(low(none)).toBeGreaterThan(0);
    expect(low(typical)).toBeGreaterThan(0.2 * low(none));
    expect(low(full)).toBeGreaterThan(0.2 * low(none));
  });
});

describe('calibrage léger : budget d\'objets d\'une salle de combat', () => {
  it('niveau 5, salle « ashgate » : jamais plus d\'objets que de joueurs, et le budget est dépensé presque entièrement', () => {
    for (const n of [1, 4]) {
      const rs = [7, 11, 13, 17].map((seed) => measureGearRoom(level5, n, seed, 'ashgate', { drops: true }));
      expect(rs.every((r) => r.cleared)).toBe(true);
      for (const r of rs) {
        expect(r.combatRooms).toBe(1);
        expect(r.gearDrops).toBeLessThanOrEqual(n);
      }
      const perHero = sum(rs, (r) => r.gearDrops) / (rs.length * n);
      expect(perHero).toBeGreaterThan(0.7);
      expect(perHero).toBeLessThanOrEqual(1);
    }
  }, 90_000);
});

describe('outils de calibrage', () => {
  it('giveGear pose l\'équipement à tous les joueurs et active l\'équipement', () => {
    const run = level6.make(2, 7);
    expect(run.state.gearEnabled).toBe(false);
    giveGear(run, TYPICAL_GEAR);
    expect(run.state.gearEnabled).toBe(true);
    for (const p of run.state.players) expect(p.loadout).toMatchObject({ boots: 2, protection: 1, artifact: 1, weapon: 0, accessory: null });
  });
  it('aggregateGear : moyennes, durée sur les parties terminées seulement, objets par salle et par héros', () => {
    const base = {
      level: 6, players: 2, seed: 1, gear: true, rooms: 4, downs: 1, roomWipes: {}, roomDrops: {}, roomPlays: {}, bossWipes: 0, kills: 10, scattered: 0, picked: 3,
      lossEvents: 0, lostItems: 0, buffDrops: 0, buffsStarted: 0, steps: 100, lowSteps: 10, criticalSteps: 0, powerSum: 12, powerSamples: 10, snaps: [],
    };
    const a = aggregateGear([
      { ...base, completed: true, timeS: 100, wipes: 1, hpLost: 40, combatRooms: 2, gearDrops: 3 },
      { ...base, completed: false, timeS: 900, wipes: 3, hpLost: 60, combatRooms: 3, gearDrops: 5 },
    ]);
    expect(a.runs).toBe(2);
    expect(a.completed).toBe(1);
    expect(a.timeS).toBe(100);
    expect(a.wipes).toBe(2);
    expect(a.hpLostPerRoom).toBe(12.5);
    expect(a.dropsPerRoomPerHero).toBeCloseTo(8 / ((2 + 3) * 2), 6);
    expect(a.lowPct).toBeCloseTo(10, 6);
    expect(a.power).toBeCloseTo(1.2, 6);
  });
});
