import { describe, expect, it } from 'vitest';
import {
  canOccupy,
  circleIntersectsRect,
  moveCircle,
  projectileHitsWall,
  resolveOverlap,
  segmentBlocked,
  type PixelRect,
} from './collision';
import { RoomGrid } from './grid';

/**
 *  x:  0         1
 *      0123456789012345 (tuiles de 16 px)
 */
const LAYOUT = [
  '##########', // y=0
  '#........#', // y=1
  '#...o....#', // y=2  pilier en (4,2) : x 64..80, y 32..48
  '#....~...#', // y=3  fosse en (5,3)  : x 80..96, y 48..64
  '#........#', // y=4
  '##########', // y=5
];
const grid = new RoomGrid(LAYOUT);
const R = 5;

describe('circleIntersectsRect', () => {
  const rect: PixelRect = { x: 10, y: 10, w: 10, h: 10 };
  it('détecte un chevauchement et ignore le contact tangent', () => {
    expect(circleIntersectsRect(15, 15, 3, rect)).toBe(true);
    expect(circleIntersectsRect(5, 15, 5, rect)).toBe(false); // tangent exact
    expect(circleIntersectsRect(5, 15, 5.01, rect)).toBe(true);
  });
  it('gère le coin (distance au coin, pas à la boîte englobante)', () => {
    expect(circleIntersectsRect(7, 7, 4, rect)).toBe(false); // dist coin ≈ 4.24
    expect(circleIntersectsRect(7, 7, 4.3, rect)).toBe(true);
  });
});

describe('canOccupy', () => {
  it('accepte le sol libre et refuse murs, piliers, fosses et vide', () => {
    expect(canOccupy({ x: 40, y: 24 }, R, grid)).toBe(true);
    expect(canOccupy({ x: 18, y: 24 }, R, grid)).toBe(false); // mur gauche : x-r = 13 < 16
    expect(canOccupy({ x: 21, y: 24 }, R, grid)).toBe(true); // x-r = 16 : tangent
    expect(canOccupy({ x: 72, y: 40 }, R, grid)).toBe(false); // pilier
    expect(canOccupy({ x: 88, y: 56 }, R, grid)).toBe(false); // fosse
    expect(canOccupy({ x: -20, y: 24 }, R, grid)).toBe(false); // hors grille
  });
  it('tient compte des solides dynamiques (porte fermée, bloc)', () => {
    const door: PixelRect = { x: 32, y: 16, w: 16, h: 16 };
    expect(canOccupy({ x: 40, y: 24 }, R, grid, [door])).toBe(false);
    expect(canOccupy({ x: 40, y: 24 }, R, grid, [])).toBe(true);
  });
  it('refuse les positions non finies', () => {
    expect(canOccupy({ x: NaN, y: 24 }, R, grid)).toBe(false);
    expect(canOccupy({ x: 40, y: Infinity }, R, grid)).toBe(false);
  });
});

describe('moveCircle', () => {
  it('se déplace librement dans le sol dégagé et ne mute pas ses arguments', () => {
    const pos = { x: 40, y: 24 };
    const delta = { x: 10, y: 5 };
    const out = moveCircle(pos, delta, R, grid);
    expect(out).toEqual({ x: 50, y: 29 });
    expect(pos).toEqual({ x: 40, y: 24 });
    expect(delta).toEqual({ x: 10, y: 5 });
  });

  it("s'arrête au contact d'un mur (sans le traverser)", () => {
    const out = moveCircle({ x: 120, y: 24 }, { x: 60, y: 0 }, R, grid);
    expect(out.x).toBeLessThanOrEqual(139 + 1e-9);
    expect(out.x).toBeGreaterThan(138.9);
    expect(out.y).toBe(24);
  });

  it('glisse le long du mur sur l’axe libre', () => {
    const out = moveCircle({ x: 130, y: 30 }, { x: 50, y: 10 }, R, grid);
    expect(out.x).toBeLessThanOrEqual(139 + 1e-9);
    expect(out.y).toBeCloseTo(40, 6);
  });

  it('ne tunnelle pas à très grande vitesse (déplacement de 1000 px en un pas)', () => {
    const out = moveCircle({ x: 40, y: 24 }, { x: 1000, y: 0 }, R, grid);
    expect(out.x).toBeLessThanOrEqual(139 + 1e-9);
    expect(canOccupy(out, R, grid)).toBe(true);
    const back = moveCircle({ x: 100, y: 24 }, { x: -1000, y: -1000 }, R, grid);
    expect(canOccupy(back, R, grid)).toBe(true);
    expect(back.x).toBeGreaterThanOrEqual(21 - 1e-9);
    expect(back.y).toBeGreaterThanOrEqual(21 - 1e-9);
  });

  it('contourne l’angle d’un pilier sans se coincer', () => {
    // Au-dessus du pilier (haut y=32), marche vers la droite en descendant légèrement : bloqué en y, libre en x.
    const out = moveCircle({ x: 58, y: 26 }, { x: 30, y: 3 }, R, grid);
    expect(out.x).toBeCloseTo(88, 6);
    expect(out.y).toBeLessThan(28); // freiné par le pilier, repart une fois dépassé
    expect(canOccupy(out, R, grid)).toBe(true);
  });

  it('avance en diagonale le long d’un couloir sans s’arrêter dans les coins', () => {
    let p = { x: 24, y: 24 };
    for (let i = 0; i < 120; i++) p = moveCircle(p, { x: 1.2, y: 1.2 }, R, grid);
    // arrivé au fond du couloir bas-droite : coin intérieur (139, 59)
    expect(p.x).toBeCloseTo(139, 1);
    expect(p.y).toBeCloseTo(75, 1); // sol jusqu'à y = 80 (mur en y=80) → centre max 75
  });

  it('est bloqué par une porte fermée et par un bloc (solides dynamiques)', () => {
    const door: PixelRect = { x: 96, y: 16, w: 16, h: 64 };
    const out = moveCircle({ x: 40, y: 24 }, { x: 100, y: 0 }, R, grid, [door]);
    expect(out.x).toBeLessThanOrEqual(91 + 1e-9);
    expect(out.x).toBeGreaterThan(90.9);
    const block: PixelRect = { x: 32, y: 16, w: 32, h: 32 };
    const out2 = moveCircle({ x: 24, y: 24 }, { x: 40, y: 0 }, R, grid, [block]);
    expect(out2.x).toBeLessThanOrEqual(27 + 1e-9);
  });

  it('extrait un disque pris dans un solide au lieu de le figer', () => {
    const block: PixelRect = { x: 32, y: 16, w: 32, h: 32 };
    const out = moveCircle({ x: 40, y: 24 }, { x: 0, y: 0 }, R, grid, [block]);
    expect(canOccupy(out, R, grid, [block])).toBe(true);
    const out2 = moveCircle({ x: 40, y: 24 }, { x: 3, y: 0 }, R, grid, [block]);
    expect(canOccupy(out2, R, grid, [block])).toBe(true);
  });

  it('ignore un delta non fini et conserve une position non finie', () => {
    expect(moveCircle({ x: 40, y: 24 }, { x: NaN, y: 3 }, R, grid)).toEqual({ x: 40, y: 27 });
    const bad = moveCircle({ x: NaN, y: 24 }, { x: 3, y: 3 }, R, grid);
    expect(Number.isNaN(bad.x)).toBe(true);
  });

  it('est déterministe', () => {
    const a = moveCircle({ x: 33.3, y: 41.7 }, { x: 12.34, y: -5.6 }, R, grid);
    const b = moveCircle({ x: 33.3, y: 41.7 }, { x: 12.34, y: -5.6 }, R, grid);
    expect(a).toEqual(b);
  });
});

describe('resolveOverlap', () => {
  it('ne bouge pas un disque libre', () => {
    expect(resolveOverlap({ x: 40, y: 24 }, R, grid)).toEqual({ x: 40, y: 24 });
  });
  it('éjecte un disque enfoncé dans un mur', () => {
    const out = resolveOverlap({ x: 17, y: 24 }, R, grid);
    expect(canOccupy(out, R, grid)).toBe(true);
  });
});

describe('projectileHitsWall', () => {
  it('est arrêté par murs, piliers et hors-salle, mais pas par les fosses', () => {
    expect(projectileHitsWall({ x: 40, y: 24 }, 3, grid)).toBe(false);
    expect(projectileHitsWall({ x: 14, y: 24 }, 3, grid)).toBe(true); // mur
    expect(projectileHitsWall({ x: 72, y: 40 }, 3, grid)).toBe(true); // pilier
    expect(projectileHitsWall({ x: 88, y: 56 }, 3, grid)).toBe(false); // fosse
    expect(projectileHitsWall({ x: -5, y: 24 }, 3, grid)).toBe(true); // vide
    expect(projectileHitsWall({ x: NaN, y: 24 }, 3, grid)).toBe(true);
  });
  it('est arrêté par les portes fermées et les blocs (solides)', () => {
    const door: PixelRect = { x: 32, y: 16, w: 16, h: 16 };
    expect(projectileHitsWall({ x: 40, y: 24 }, 3, grid, [door])).toBe(true);
    expect(projectileHitsWall({ x: 40, y: 24 }, 3, grid, [])).toBe(false);
  });
  it('traite un rayon nul comme un point', () => {
    expect(projectileHitsWall({ x: 16, y: 24 }, 0, grid)).toBe(false); // bord gauche de la tuile (1,1) = sol
    expect(projectileHitsWall({ x: 15.9, y: 24 }, 0, grid)).toBe(true);
  });
});

describe('segmentBlocked', () => {
  it('détecte un mur ou une porte entre deux points, pas une fosse', () => {
    expect(segmentBlocked({ x: 30, y: 24 }, { x: 60, y: 24 }, grid)).toBe(false);
    expect(segmentBlocked({ x: 60, y: 40 }, { x: 90, y: 40 }, grid)).toBe(true); // traverse le pilier
    expect(segmentBlocked({ x: 85, y: 40 }, { x: 85, y: 70 }, grid)).toBe(false); // traverse la fosse
    const door: PixelRect = { x: 48, y: 16, w: 16, h: 16 };
    expect(segmentBlocked({ x: 30, y: 24 }, { x: 80, y: 24 }, grid, [door])).toBe(true);
  });
});
