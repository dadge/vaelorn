import { describe, expect, it } from 'vitest';
import {
  DIFFICULTY_TABLE,
  damageReductionFor,
  damageToEnemy,
  damageToPlayer,
  difficultyMultipliers,
  maxHpFor,
  playerBaseDamage,
} from './balance';
import { CHARACTER_LIST, getCharacter } from './characters';
import type { Difficulty } from './types';

describe('balance : PV et réduction', () => {
  it('maxHpFor = 50 + 10 × résistance', () => {
    expect(maxHpFor({ resistance: 1 })).toBe(60);
    expect(maxHpFor({ resistance: 10 })).toBe(150);
    expect(maxHpFor(getCharacter('david'))).toBe(140);
    expect(maxHpFor(getCharacter('sandrine'))).toBe(70);
  });

  it('damageReductionFor = 2 % × résistance, plafonné à 20 %', () => {
    expect(damageReductionFor({ resistance: 1 })).toBeCloseTo(0.02);
    expect(damageReductionFor({ resistance: 5 })).toBeCloseTo(0.1);
    expect(damageReductionFor({ resistance: 10 })).toBeCloseTo(0.2);
    expect(damageReductionFor({ resistance: 15 })).toBeCloseTo(0.2);
  });

  it('les PV max sont croissants avec la résistance', () => {
    for (let r = 1; r < 10; r++) {
      expect(maxHpFor({ resistance: r + 1 })).toBeGreaterThan(maxHpFor({ resistance: r }));
    }
  });
});

describe('balance : dégâts de base du joueur', () => {
  it('playerBaseDamage = (6 + 2.5 × force) × damageMult', () => {
    const fake = { strength: 8, attack: { damageMult: 1 } } as Parameters<typeof playerBaseDamage>[0];
    expect(playerBaseDamage(fake)).toBeCloseTo(26);
    const half = { strength: 4, attack: { damageMult: 0.5 } } as Parameters<typeof playerBaseDamage>[0];
    expect(playerBaseDamage(half)).toBeCloseTo(8);
  });

  it('la dégâts moyen de chaque personnage reste dans une fourchette raisonnable', () => {
    for (const c of CHARACTER_LIST) {
      const d = playerBaseDamage(c);
      expect(d).toBeGreaterThan(5);
      expect(d).toBeLessThan(45);
    }
  });

  it('les personnages « de poids lourd » frappent plus fort par coup', () => {
    expect(playerBaseDamage(getCharacter('grok'))).toBeGreaterThan(playerBaseDamage(getCharacter('mira')));
    expect(playerBaseDamage(getCharacter('sandrine'))).toBeGreaterThan(playerBaseDamage(getCharacter('valentine')));
  });
});

describe('balance : difficulté', () => {
  it('table conforme à DESIGN.md', () => {
    expect(DIFFICULTY_TABLE[1]).toEqual({ enemyHpMult: 0.7, enemyDamageMult: 0.6 });
    expect(DIFFICULTY_TABLE[2]).toEqual({ enemyHpMult: 1, enemyDamageMult: 1 });
    expect(DIFFICULTY_TABLE[3]).toEqual({ enemyHpMult: 1.4, enemyDamageMult: 1.5 });
  });

  it('difficultyMultipliers : valeur invalide => normal', () => {
    expect(difficultyMultipliers(3)).toEqual({ enemyHpMult: 1.4, enemyDamageMult: 1.5 });
    expect(difficultyMultipliers(9 as unknown as Difficulty)).toEqual({ enemyHpMult: 1, enemyDamageMult: 1 });
  });

  it('damageToEnemy = brut / multPV, jamais < 1', () => {
    expect(damageToEnemy(14, 2)).toBeCloseTo(14);
    expect(damageToEnemy(14, 1)).toBeCloseTo(20); // 14 / 0.7
    expect(damageToEnemy(14, 3)).toBeCloseTo(10); // 14 / 1.4
    expect(damageToEnemy(0.2, 3)).toBe(1);
    expect(damageToEnemy(0, 2)).toBe(0);
  });

  it('damageToEnemy croît quand la difficulté baisse (les ennemis ont « plus de PV » en difficile)', () => {
    expect(damageToEnemy(20, 1)).toBeGreaterThan(damageToEnemy(20, 2));
    expect(damageToEnemy(20, 2)).toBeGreaterThan(damageToEnemy(20, 3));
  });

  it('damageToPlayer = round(brut × multDégâts × (1 − réduction)), jamais < 1', () => {
    const tank = { resistance: 10 }; // -20 %
    const squishy = { resistance: 2 }; // -4 %
    expect(damageToPlayer(10, tank, 2)).toBe(8);
    expect(damageToPlayer(10, tank, 3)).toBe(12); // 10 × 1.5 × 0.8
    expect(damageToPlayer(10, tank, 1)).toBe(5); // 10 × 0.6 × 0.8 = 4.8 → 5
    expect(damageToPlayer(10, squishy, 2)).toBe(10); // 9.6 → 10
    expect(damageToPlayer(1, tank, 1)).toBe(1); // 0.48 → plancher 1
    expect(damageToPlayer(0, tank, 2)).toBe(0);
  });

  it('damageToPlayer est monotone en difficulté et en résistance', () => {
    const c = { resistance: 4 };
    expect(damageToPlayer(20, c, 1)).toBeLessThan(damageToPlayer(20, c, 2));
    expect(damageToPlayer(20, c, 2)).toBeLessThan(damageToPlayer(20, c, 3));
    expect(damageToPlayer(20, { resistance: 10 }, 2)).toBeLessThan(damageToPlayer(20, { resistance: 1 }, 2));
  });
});
