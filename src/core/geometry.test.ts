import { describe, expect, it } from 'vitest';
import { TILE } from './constants';
import {
  angleBetween,
  angleDiff,
  circleOverlap,
  clamp,
  dirFromVec,
  dirVec,
  dist,
  distSq,
  isInArc,
  length,
  lerp,
  normalize,
  normalizeAngle,
  oppositeDir,
  pointInTileRect,
  tileCenter,
  tileOf,
  tileToPx,
  vecFromAngle,
} from './geometry';
import type { Dir } from './types';

const DIRS: Dir[] = ['up', 'down', 'left', 'right'];

describe('geometry : vecteurs de base', () => {
  it('dist / distSq / length', () => {
    expect(dist({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(distSq({ x: 1, y: 1 }, { x: 4, y: 5 })).toBe(25);
    expect(length({ x: -6, y: 8 })).toBe(10);
  });

  it('normalize : unitaire, et le vecteur nul reste nul', () => {
    const n = normalize({ x: 3, y: 4 });
    expect(n.x).toBeCloseTo(0.6);
    expect(n.y).toBeCloseTo(0.8);
    expect(normalize({ x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
  });

  it('clamp / lerp', () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
    expect(clamp(2, 0, 3)).toBe(2);
    expect(lerp(10, 20, 0.25)).toBe(12.5);
  });
});

describe('geometry : directions', () => {
  it('dirVec et oppositeDir sont cohérents', () => {
    for (const d of DIRS) {
      const v = dirVec(d);
      const o = dirVec(oppositeDir(d));
      expect(v.x + o.x).toBe(0);
      expect(v.y + o.y).toBe(0);
      expect(oppositeDir(oppositeDir(d))).toBe(d);
    }
    expect(dirVec('up')).toEqual({ x: 0, y: -1 });
    expect(dirVec('right')).toEqual({ x: 1, y: 0 });
  });

  it('dirFromVec : axe dominant, fallback sur vecteur nul', () => {
    expect(dirFromVec({ x: 5, y: 1 }, 'up')).toBe('right');
    expect(dirFromVec({ x: -5, y: 1 }, 'up')).toBe('left');
    expect(dirFromVec({ x: 1, y: 5 }, 'left')).toBe('down');
    expect(dirFromVec({ x: 1, y: -5 }, 'left')).toBe('up');
    expect(dirFromVec({ x: 0, y: 0 }, 'left')).toBe('left');
  });

  it('dirFromVec : diagonale parfaite garde le fallback compatible', () => {
    expect(dirFromVec({ x: 1, y: 1 }, 'down')).toBe('down');
    expect(dirFromVec({ x: 1, y: 1 }, 'right')).toBe('right');
    expect(dirFromVec({ x: 1, y: 1 }, 'up')).toBe('right');
    expect(dirFromVec({ x: -1, y: -1 }, 'left')).toBe('left');
  });

  it('dirFromVec(dirVec(d)) = d', () => {
    for (const d of DIRS) expect(dirFromVec(dirVec(d), 'up')).toBe(d);
  });
});

describe('geometry : cercles et tuiles', () => {
  it('circleOverlap', () => {
    expect(circleOverlap({ x: 0, y: 0 }, 5, { x: 8, y: 0 }, 5)).toBe(true);
    expect(circleOverlap({ x: 0, y: 0 }, 5, { x: 10, y: 0 }, 5)).toBe(false); // tangents
    expect(circleOverlap({ x: 0, y: 0 }, 5, { x: 20, y: 0 }, 5)).toBe(false);
  });

  it('pointInTileRect : bords gauche/haut inclus, droite/bas exclus', () => {
    const r = { x: 2, y: 3, w: 2, h: 1 };
    expect(pointInTileRect({ x: 2 * TILE, y: 3 * TILE }, r)).toBe(true);
    expect(pointInTileRect({ x: 4 * TILE - 0.01, y: 4 * TILE - 0.01 }, r)).toBe(true);
    expect(pointInTileRect({ x: 4 * TILE, y: 3 * TILE }, r)).toBe(false);
    expect(pointInTileRect({ x: 2 * TILE, y: 4 * TILE }, r)).toBe(false);
    expect(pointInTileRect({ x: 2 * TILE - 1, y: 3 * TILE }, r)).toBe(false);
  });

  it('tileCenter / tileToPx / tileOf sont cohérents', () => {
    expect(tileToPx(3, 2)).toEqual({ x: 3 * TILE, y: 2 * TILE });
    expect(tileCenter(3, 2)).toEqual({ x: 3.5 * TILE, y: 2.5 * TILE });
    expect(tileOf(tileCenter(7, 9))).toEqual([7, 9]);
    expect(tileOf({ x: 0, y: 0 })).toEqual([0, 0]);
    expect(tileOf({ x: TILE - 0.01, y: TILE })).toEqual([0, 1]);
    expect(tileOf({ x: -0.5, y: -0.5 })).toEqual([-1, -1]);
  });
});

describe('geometry : angles et arcs', () => {
  it('angleBetween / vecFromAngle (0 = droite, π/2 = bas)', () => {
    const o = { x: 10, y: 10 };
    expect(angleBetween(o, { x: 20, y: 10 })).toBeCloseTo(0);
    expect(angleBetween(o, { x: 10, y: 20 })).toBeCloseTo(Math.PI / 2);
    expect(angleBetween(o, { x: 10, y: 0 })).toBeCloseTo(-Math.PI / 2);
    const v = vecFromAngle(Math.PI / 2, 4);
    expect(v.x).toBeCloseTo(0);
    expect(v.y).toBeCloseTo(4);
    expect(vecFromAngle(0)).toEqual({ x: 1, y: 0 });
  });

  it('normalizeAngle / angleDiff gèrent le passage ±π', () => {
    expect(normalizeAngle(3 * Math.PI)).toBeCloseTo(Math.PI);
    expect(normalizeAngle(-3 * Math.PI / 2)).toBeCloseTo(Math.PI / 2);
    expect(angleDiff(Math.PI - 0.1, -Math.PI + 0.1)).toBeCloseTo(0.2);
  });

  it('isInArc : devant dans la portée', () => {
    const o = { x: 0, y: 0 };
    const facing = 0; // droite
    expect(isInArc(o, facing, { x: 15, y: 0 }, 24, 100)).toBe(true);
  });

  it('isInArc : derrière ou hors portée', () => {
    const o = { x: 0, y: 0 };
    expect(isInArc(o, 0, { x: -15, y: 0 }, 24, 100)).toBe(false);
    expect(isInArc(o, 0, { x: 30, y: 0 }, 24, 100)).toBe(false);
  });

  it('isInArc : bord de l\'arc (±50° pour 100°)', () => {
    const o = { x: 0, y: 0 };
    const at = (deg: number) => vecFromAngle((deg * Math.PI) / 180, 15);
    expect(isInArc(o, 0, at(45), 24, 100)).toBe(true);
    expect(isInArc(o, 0, at(55), 24, 100)).toBe(false);
    expect(isInArc(o, 0, at(-45), 24, 100)).toBe(true);
    expect(isInArc(o, 0, at(-55), 24, 100)).toBe(false);
  });

  it('isInArc : le rayon de la cible élargit portée et tolérance angulaire', () => {
    const o = { x: 0, y: 0 };
    // centre à 30 px : hors portée 24 pour un point, touché pour une cible de rayon 8
    expect(isInArc(o, 0, { x: 30, y: 0 }, 24, 100, 0)).toBe(false);
    expect(isInArc(o, 0, { x: 30, y: 0 }, 24, 100, 8)).toBe(true);
    // à 60° (hors arc ±50°) : un point n'est pas touché, une grosse cible proche l'est
    const t = vecFromAngle((60 * Math.PI) / 180, 14);
    expect(isInArc(o, 0, t, 24, 100, 0)).toBe(false);
    expect(isInArc(o, 0, t, 24, 100, 6)).toBe(true);
  });

  it("isInArc : une cible qui recouvre l'origine est touchée; arc 360 = cercle", () => {
    const o = { x: 5, y: 5 };
    expect(isInArc(o, 0, { x: 5, y: 5 }, 10, 60, 0)).toBe(true);
    expect(isInArc(o, 0, { x: -3, y: 5 }, 12, 360, 0)).toBe(true);
    expect(isInArc(o, 0, { x: -30, y: 5 }, 12, 360, 0)).toBe(false);
  });

  it('isInArc : angle de visée du haut (-π/2)', () => {
    const o = { x: 50, y: 50 };
    expect(isInArc(o, -Math.PI / 2, { x: 50, y: 40 }, 20, 90, 4)).toBe(true);
    expect(isInArc(o, -Math.PI / 2, { x: 50, y: 60 }, 20, 90, 4)).toBe(false);
  });
});
