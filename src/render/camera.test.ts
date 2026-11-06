import { describe, expect, it } from 'vitest';
import {
  CAMERA_SNAP_DISTANCE,
  clampCameraAxis,
  edgeIndicator,
  followFactor,
  snapToScreenPixel,
  stepCameraCenter,
} from './camera';

describe('clampCameraAxis', () => {
  it('borne le centre pour que la vue reste dans la salle', () => {
    // vue 200, salle 500 → centre ∈ [100, 400]
    expect(clampCameraAxis(0, 200, 500)).toBe(100);
    expect(clampCameraAxis(250, 200, 500)).toBe(250);
    expect(clampCameraAxis(999, 200, 500)).toBe(400);
  });

  it('centre la salle quand elle est plus petite (ou égale) à la vue', () => {
    expect(clampCameraAxis(0, 300, 200)).toBe(100);
    expect(clampCameraAxis(1000, 300, 200)).toBe(100);
    expect(clampCameraAxis(50, 200, 200)).toBe(100);
  });

  it('ne produit jamais NaN', () => {
    expect(clampCameraAxis(Number.NaN, 200, 500)).toBe(250);
    expect(Number.isFinite(clampCameraAxis(Infinity, 200, 500))).toBe(true);
  });
});

describe('snapToScreenPixel', () => {
  it('aligne sur multiples de 1/zoom', () => {
    expect(snapToScreenPixel(10.2, 3)).toBeCloseTo(10.3333, 3);
    expect(snapToScreenPixel(10.2, 2)).toBe(10);
    expect(snapToScreenPixel(10.3, 2)).toBe(10.5);
    expect(snapToScreenPixel(7.7, 1)).toBe(8);
  });
  it('zoom invalide → valeur inchangée', () => {
    expect(snapToScreenPixel(3.3, 0)).toBe(3.3);
  });
});

describe('followFactor', () => {
  it('vaut 0 sans temps, 0.5 à la demi-vie, tend vers 1', () => {
    expect(followFactor(0)).toBe(0);
    expect(followFactor(70, 70)).toBeCloseTo(0.5, 6);
    expect(followFactor(10000, 70)).toBeGreaterThan(0.999);
  });
  it('est indépendant du découpage du temps', () => {
    const one = followFactor(32, 70);
    const two = 1 - (1 - followFactor(16, 70)) * (1 - followFactor(16, 70));
    expect(one).toBeCloseTo(two, 9);
  });
});

describe('stepCameraCenter', () => {
  const view = { w: 200, h: 100 };
  const room = { w: 800, h: 400 };

  it('rejoint la cible sans la dépasser', () => {
    const cur = { x: 300, y: 200 };
    for (let i = 0; i < 300; i++) stepCameraCenter(cur, { x: 400, y: 220 }, 16, view, room, 3);
    expect(cur.x).toBeCloseTo(400, 1);
    expect(cur.y).toBeCloseTo(220, 1);
  });

  it('snap : placement immédiat, borné', () => {
    const cur = { x: 0, y: 0 };
    stepCameraCenter(cur, { x: 5, y: 5 }, 16, view, room, 3, true);
    expect(cur).toEqual({ x: 100, y: 50 });
  });

  it('cible très lointaine → saut', () => {
    const cur = { x: 100, y: 50 };
    stepCameraCenter(cur, { x: 100 + CAMERA_SNAP_DISTANCE + 50, y: 50 }, 16, view, room, 3);
    expect(cur.x).toBe(100 + CAMERA_SNAP_DISTANCE + 50);
  });

  it('état initial NaN → saut sur la cible', () => {
    const cur = { x: Number.NaN, y: Number.NaN };
    stepCameraCenter(cur, { x: 400, y: 200 }, 16, view, room, 2);
    expect(cur).toEqual({ x: 400, y: 200 });
  });

  it('salle plus petite que la vue : centrée en permanence', () => {
    const cur = { x: 0, y: 0 };
    stepCameraCenter(cur, { x: 10, y: 10 }, 16, { w: 400, h: 300 }, { w: 200, h: 100 }, 3, true);
    expect(cur).toEqual({ x: 100, y: 50 });
  });
});

describe('edgeIndicator', () => {
  it('cible dans la vue → invisible', () => {
    const e = edgeIndicator(10, -20, 600, 300);
    expect(e.visible).toBe(false);
  });

  it('cible à droite → indicateur sur le bord droit (moins la marge)', () => {
    const e = edgeIndicator(900, 0, 600, 300, 10);
    expect(e.visible).toBe(true);
    expect(e.x).toBeCloseTo(600 - 10, 5);
    expect(e.y).toBeCloseTo(150, 5);
    expect(e.angle).toBeCloseTo(0, 5);
  });

  it('cible en haut à gauche → coin, dans la vue', () => {
    const e = edgeIndicator(-1000, -1000, 600, 300, 10);
    expect(e.visible).toBe(true);
    expect(e.x).toBeGreaterThanOrEqual(10 - 1e-6);
    expect(e.y).toBeGreaterThanOrEqual(10 - 1e-6);
    expect(e.x).toBeLessThanOrEqual(590 + 1e-6);
    expect(e.y).toBeLessThanOrEqual(290 + 1e-6);
  });

  it('cible en bas → indicateur sur le bord bas', () => {
    const e = edgeIndicator(0, 500, 600, 300, 10);
    expect(e.visible).toBe(true);
    expect(e.y).toBeCloseTo(290, 5);
    expect(e.x).toBeCloseTo(300, 5);
  });
});
