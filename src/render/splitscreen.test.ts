import { describe, expect, it } from 'vitest';
import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import {
  SEPARATOR_PX,
  allLayoutRects,
  computeLayout,
  normalizePlayerCount,
  rectsOverlap,
  worldViewSize,
  zoomForPlayerCount,
} from './splitscreen';

describe('computeLayout', () => {
  for (const n of [1, 2, 3, 4]) {
    it(`${n} joueur(s) : aucun recouvrement, couverture totale de 1280x720`, () => {
      const layout = computeLayout(n);
      const rects = allLayoutRects(layout);
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          expect(rectsOverlap(rects[i], rects[j]), `rects ${i} et ${j}`).toBe(false);
        }
      }
      const area = rects.reduce((s, r) => s + r.w * r.h, 0);
      expect(area).toBe(GAME_WIDTH * GAME_HEIGHT);
      for (const r of rects) {
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.y).toBeGreaterThanOrEqual(0);
        expect(r.x + r.w).toBeLessThanOrEqual(GAME_WIDTH);
        expect(r.y + r.h).toBeLessThanOrEqual(GAME_HEIGHT);
        expect(r.w).toBeGreaterThan(0);
        expect(r.h).toBeGreaterThan(0);
      }
    });

    it(`${n} joueur(s) : un viewport par joueur et zoom entier`, () => {
      const layout = computeLayout(n);
      expect(layout.viewports).toHaveLength(n);
      for (const v of layout.viewports) {
        expect(Number.isInteger(v.zoom)).toBe(true);
        expect(v.zoom).toBe(layout.zoom);
      }
    });
  }

  it('couverture pixel par pixel (3 joueurs, panneau d\'équipe inclus)', () => {
    const layout = computeLayout(3);
    const grid = new Uint8Array(GAME_WIDTH * GAME_HEIGHT);
    for (const r of allLayoutRects(layout)) {
      for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) grid[y * GAME_WIDTH + x]++;
    }
    expect(grid.every((v) => v === 1)).toBe(true);
  });

  it('1 joueur : plein écran zoom 3, pas de séparateur', () => {
    const l = computeLayout(1);
    expect(l.viewports[0]).toEqual({ x: 0, y: 0, w: GAME_WIDTH, h: GAME_HEIGHT, zoom: 3 });
    expect(l.separators).toHaveLength(0);
    expect(l.teamPanel).toBeUndefined();
  });

  it('2 joueurs : moitiés côte à côte, zoom 3, séparateur vertical de 4 px', () => {
    const l = computeLayout(2);
    expect(l.zoom).toBe(3);
    expect(l.viewports[0].h).toBe(GAME_HEIGHT);
    expect(l.viewports[0].w).toBe(638);
    expect(l.viewports[1].x).toBe(642);
    expect(l.viewports[1].w).toBe(638);
    expect(l.separators).toEqual([{ x: 638, y: 0, w: SEPARATOR_PX, h: GAME_HEIGHT }]);
  });

  it('3 joueurs : 3 quadrants zoom 2 + panneau d\'équipe dans le 4e quadrant', () => {
    const l = computeLayout(3);
    expect(l.zoom).toBe(2);
    expect(l.viewports).toHaveLength(3);
    expect(l.teamPanel).toEqual({ x: 642, y: 362, w: 638, h: 358 });
    expect(l.viewports[2]).toMatchObject({ x: 0, y: 362 });
  });

  it('4 joueurs : 4 quadrants zoom 2, pas de panneau', () => {
    const l = computeLayout(4);
    expect(l.zoom).toBe(2);
    expect(l.viewports).toHaveLength(4);
    expect(l.teamPanel).toBeUndefined();
    expect(l.viewports[3]).toMatchObject({ x: 642, y: 362, w: 638, h: 358 });
  });

  it('les séparateurs mesurent bien 4 px d\'épaisseur', () => {
    for (const n of [2, 3, 4]) {
      for (const s of computeLayout(n).separators) expect(Math.min(s.w, s.h)).toBe(SEPARATOR_PX);
    }
  });

  it('un nombre de joueurs invalide est borné à 1..4', () => {
    expect(computeLayout(0).playerCount).toBe(1);
    expect(computeLayout(9).playerCount).toBe(4);
    expect(computeLayout(Number.NaN).playerCount).toBe(1);
    expect(normalizePlayerCount(2.9)).toBe(2);
  });

  it('une autre résolution reste couverte sans recouvrement', () => {
    const layout = computeLayout(4, 1281, 721);
    const rects = allLayoutRects(layout);
    expect(rects.reduce((s, r) => s + r.w * r.h, 0)).toBe(1281 * 721);
  });

  it('zoom et taille de la zone monde visible', () => {
    expect(zoomForPlayerCount(1)).toBe(3);
    expect(zoomForPlayerCount(2)).toBe(3);
    expect(zoomForPlayerCount(3)).toBe(2);
    expect(zoomForPlayerCount(4)).toBe(2);
    const vp = computeLayout(1).viewports[0];
    const s = worldViewSize(vp);
    expect(s.h).toBe(240);
    expect(s.w).toBeCloseTo(426.67, 1);
  });
});
