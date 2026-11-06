import { describe, expect, it } from 'vitest';
import { PLAYER_COLORS } from '../core/constants';
import type { EnemyKind } from '../core/types';
import { hasFrame } from './art';
import { enemyFrame } from './art/animations';
import {
  CosmeticRng,
  damageNumberColor,
  damageNumberText,
  easeOutCubic,
  enemyDeathColor,
  fxFrameAt,
  fxLerp,
  fxProgress,
} from './fx';

describe('fxLerp / fxProgress / easeOutCubic', () => {
  it('interpole', () => {
    expect(fxLerp(0, 10, 0.25)).toBe(2.5);
    expect(fxLerp(5, 5, 0.9)).toBe(5);
  });
  it('progression bornée', () => {
    expect(fxProgress(-5, 100)).toBe(0);
    expect(fxProgress(50, 100)).toBe(0.5);
    expect(fxProgress(500, 100)).toBe(1);
    expect(fxProgress(10, 0)).toBe(1);
  });
  it('easeOutCubic : 0→0, 1→1, monotone, concave', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
    let prev = -1;
    for (let t = 0; t <= 1; t += 0.1) {
      const v = easeOutCubic(t);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutCubic(2)).toBe(1);
  });
});

describe('fxFrameAt', () => {
  const frames = ['a', 'b', 'c'];
  it('avance toutes les frameMs puis reste sur la dernière', () => {
    expect(fxFrameAt(frames, 0, 70)).toBe('a');
    expect(fxFrameAt(frames, 71, 70)).toBe('b');
    expect(fxFrameAt(frames, 150, 70)).toBe('c');
    expect(fxFrameAt(frames, 99999, 70)).toBe('c');
  });
  it('cas limites', () => {
    expect(fxFrameAt([], 10, 70)).toBe('');
    expect(fxFrameAt(frames, 500, 0)).toBe('a');
    expect(fxFrameAt(frames, -20, 70)).toBe('a');
  });
});

describe('damageNumber*', () => {
  it('entier ≥ 1, jamais NaN', () => {
    expect(damageNumberText(12.4)).toBe('12');
    expect(damageNumberText(0.2)).toBe('1');
    expect(damageNumberText(Number.NaN)).toBe('1');
    expect(damageNumberText(Infinity)).toBe('1');
  });
  it('couleur du joueur auteur, blanc sinon', () => {
    expect(damageNumberColor(null)).toBe(0xffffff);
    expect(damageNumberColor(2)).toBe(PLAYER_COLORS[2]);
  });
});

describe('enemyDeathColor', () => {
  it('définie pour tous les ennemis, et la frame de silhouette existe', () => {
    const kinds: EnemyKind[] = ['slime', 'bat', 'skeleton', 'archer', 'spider', 'wisp', 'knight', 'golem', 'morvane'];
    for (const k of kinds) {
      expect(enemyDeathColor(k)).toBeGreaterThan(0);
      expect(hasFrame(enemyFrame(k, 0))).toBe(true);
    }
  });
});

describe('CosmeticRng', () => {
  it('reste dans [0,1) et dans les bornes de range, déterministe', () => {
    const a = new CosmeticRng(42);
    const b = new CosmeticRng(42);
    for (let i = 0; i < 500; i++) {
      const v = a.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      expect(b.next()).toBe(v);
    }
    const r = new CosmeticRng(7);
    for (let i = 0; i < 200; i++) {
      const v = r.range(-3, 5);
      expect(v).toBeGreaterThanOrEqual(-3);
      expect(v).toBeLessThan(5);
    }
  });
  it('une graine nulle ne bloque pas le générateur', () => {
    const r = new CosmeticRng(0);
    const seen = new Set<number>();
    for (let i = 0; i < 20; i++) seen.add(r.next());
    expect(seen.size).toBeGreaterThan(5);
  });
});
