import { describe, expect, it } from 'vitest';
import { TORCH_LOW_FRACTION, TORCH_MAX_MS } from '../core/constants';
import { showTorchHud, torchBarColor, torchBarWidth, torchBlinkAlpha, torchFraction, torchLevel } from './torchHud';

describe('torchFraction / torchLevel', () => {
  it('fraction bornée 0..1, jamais NaN', () => {
    expect(torchFraction(TORCH_MAX_MS)).toBe(1);
    expect(torchFraction(TORCH_MAX_MS / 2)).toBeCloseTo(0.5, 6);
    expect(torchFraction(-10)).toBe(0);
    expect(torchFraction(TORCH_MAX_MS * 3)).toBe(1);
    expect(torchFraction(Number.NaN)).toBe(0);
    expect(torchFraction(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('niveaux : pleine, faiblissante sous le seuil, éteinte à 0', () => {
    expect(torchLevel(TORCH_MAX_MS)).toBe('full');
    expect(torchLevel(TORCH_MAX_MS * TORCH_LOW_FRACTION)).toBe('full');
    expect(torchLevel(TORCH_MAX_MS * TORCH_LOW_FRACTION - 1)).toBe('low');
    expect(torchLevel(1)).toBe('low');
    expect(torchLevel(0)).toBe('empty');
    expect(torchLevel(-5)).toBe('empty');
  });
});

describe('barre et clignotement', () => {
  it('largeur proportionnelle, au moins 1 px tant qu il reste du combustible, 0 à vide', () => {
    expect(torchBarWidth(TORCH_MAX_MS, 42)).toBe(42);
    expect(torchBarWidth(TORCH_MAX_MS / 2, 42)).toBe(21);
    expect(torchBarWidth(1, 42)).toBe(1);
    expect(torchBarWidth(0, 42)).toBe(0);
  });

  it('couleurs distinctes selon le niveau', () => {
    const c = new Set([torchBarColor('full'), torchBarColor('low'), torchBarColor('empty')]);
    expect(c.size).toBe(3);
  });

  it('clignotement : stable (1) si pleine, borné et variable sinon', () => {
    expect(torchBlinkAlpha('full', 123)).toBe(1);
    for (const lvl of ['low', 'empty'] as const) {
      let min = 2;
      let max = -1;
      for (let t = 0; t < 2000; t += 10) {
        const a = torchBlinkAlpha(lvl, t);
        expect(a).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThanOrEqual(1);
        min = Math.min(min, a);
        max = Math.max(max, a);
      }
      expect(max - min).toBeGreaterThan(0.3);
    }
  });

  it('showTorchHud : seulement dans les salles sombres', () => {
    expect(showTorchHud({ dark: true })).toBe(true);
    expect(showTorchHud({ dark: false })).toBe(false);
    expect(showTorchHud({})).toBe(false);
  });
});
