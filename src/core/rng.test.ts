import { describe, expect, it } from 'vitest';
import { createRng, nextRandom, randomFn, randomInt, randomPick, randomRange, seedToState } from './rng';

function seq(seed: number, n: number): number[] {
  const h = createRng(seed);
  return Array.from({ length: n }, () => nextRandom(h));
}

describe('rng (mulberry32)', () => {
  it('même seed => même séquence', () => {
    expect(seq(42, 200)).toEqual(seq(42, 200));
  });

  it('seeds différentes => séquences différentes', () => {
    expect(seq(1, 20)).not.toEqual(seq(2, 20));
  });

  it('nextRandom reste dans [0, 1)', () => {
    const h = createRng(7);
    for (let i = 0; i < 5000; i++) {
      const v = nextRandom(h);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("l'état est restituable (snapshot / restore)", () => {
    const h = createRng(123);
    for (let i = 0; i < 17; i++) nextRandom(h);
    const snapshot = JSON.parse(JSON.stringify({ rngState: h.rngState })) as { rngState: number };
    const expected = Array.from({ length: 50 }, () => nextRandom(h));
    const restored = { rngState: snapshot.rngState };
    const actual = Array.from({ length: 50 }, () => nextRandom(restored));
    expect(actual).toEqual(expected);
  });

  it("mute bien holder.rngState et c'est un entier 32 bits", () => {
    const h = createRng(5);
    const before = h.rngState;
    nextRandom(h);
    expect(h.rngState).not.toBe(before);
    expect(Number.isInteger(h.rngState)).toBe(true);
    expect(h.rngState).toBeGreaterThanOrEqual(-(2 ** 31));
    expect(h.rngState).toBeLessThan(2 ** 31);
  });

  it('un GameState-like (objet avec rngState) fonctionne comme holder', () => {
    const gs = { rngState: seedToState(99), other: 1 };
    const v = nextRandom(gs);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(gs.other).toBe(1);
  });

  it('seedToState : déterministe, entier, gère les cas limites', () => {
    expect(seedToState(10)).toBe(seedToState(10));
    expect(seedToState(10)).not.toBe(seedToState(11));
    expect(Number.isInteger(seedToState(0))).toBe(true);
    expect(Number.isInteger(seedToState(-5.7))).toBe(true);
    expect(seedToState(NaN)).toBe(seedToState(0));
    expect(Number.isInteger(seedToState(2 ** 40 + 3))).toBe(true);
  });

  it('distribution plausible (moyenne ≈ 0.5, histogramme équilibré)', () => {
    const h = createRng(2024);
    const n = 20000;
    const bins = new Array(10).fill(0) as number[];
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const v = nextRandom(h);
      sum += v;
      bins[Math.floor(v * 10)]++;
    }
    expect(sum / n).toBeGreaterThan(0.48);
    expect(sum / n).toBeLessThan(0.52);
    for (const b of bins) {
      expect(b).toBeGreaterThan(n / 10 - 250);
      expect(b).toBeLessThan(n / 10 + 250);
    }
  });

  it('randomRange reste dans [min, max)', () => {
    const h = createRng(1);
    for (let i = 0; i < 2000; i++) {
      const v = randomRange(h, -3, 8);
      expect(v).toBeGreaterThanOrEqual(-3);
      expect(v).toBeLessThan(8);
    }
  });

  it('randomInt : bornes, couverture de toutes les valeurs, cas dégénérés sans consommation', () => {
    const h = createRng(3);
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const v = randomInt(h, 6);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(6);
      seen.add(v);
    }
    expect(seen.size).toBe(6);
    const before = h.rngState;
    expect(randomInt(h, 0)).toBe(0);
    expect(randomInt(h, -4)).toBe(0);
    expect(h.rngState).toBe(before);
  });

  it('randomPick choisit dans le tableau et lance sur tableau vide', () => {
    const h = createRng(8);
    const arr = ['a', 'b', 'c'] as const;
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(randomPick(h, arr));
    expect(seen.size).toBe(3);
    expect(() => randomPick(h, [])).toThrow(RangeError);
  });

  it('randomFn avance le même état que nextRandom', () => {
    const a = createRng(11);
    const b = createRng(11);
    const f = randomFn(a);
    expect([f(), f(), f()]).toEqual([nextRandom(b), nextRandom(b), nextRandom(b)]);
    expect(a.rngState).toBe(b.rngState);
  });
});
