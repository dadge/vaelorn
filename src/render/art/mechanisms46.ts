/**
 * Art des mécanismes des niveaux 4 à 6 :
 *  - statues jumelles : `statuepair_<up|down|left|right>` (16×16, yeux et chevron cyan) et `statuepair_<dir>_lit` (résolu : vert) ;
 *    `statuepair_stand` = socle d'activation au sol (transparent aux angles) ;
 *  - sablier : `hourglass_<0..4>` (16×16, niveau de sable du haut : 0 vide … 4 plein), herse `gate_closed` (opaque) / `gate_open` ;
 *  - pont de lumière : `bridge_lit` (planches de lumière) et `bridge_dark` (abîme étoilé aux planches fantômes), 16×16 opaques ;
 *  - lanterne du porteur : `lantern_0`, `lantern_1` (8×8, flamme vacillante).
 * Style identique au reste de l'atlas : contour sombre 1 px, aplats, aucune transparence partielle.
 */
import type { Dir } from '../../core/types';
import { OUTLINE, PUZZLE_COLORS as P } from '../palettes';
import { Bitmap, type ColorMap } from './bitmap';

export const STATUE_DIRS: readonly Dir[] = ['up', 'down', 'left', 'right'];
/** Niveaux de sable du sablier (0 = vide … HOURGLASS_LEVELS = plein). */
export const HOURGLASS_LEVELS = 4;

// ───────────────────────────── Statues jumelles ─────────────────────────────

/** Pointe de flèche (triangle de 4 pixels) centrée en (cx, cy) pointant vers `dir`. */
function chevron(b: Bitmap, cx: number, cy: number, dir: Dir, color: number): void {
  const pts: Record<Dir, Array<[number, number]>> = {
    down: [[-1, -1], [0, -1], [1, -1], [0, 0]],
    up: [[0, -1], [-1, 0], [0, 0], [1, 0]],
    left: [[-1, 0], [0, -1], [0, 0], [0, 1]],
    right: [[1, 0], [0, -1], [0, 0], [0, 1]],
  };
  for (const [dx, dy] of pts[dir]) b.set(cx + dx, cy + dy, color);
}

function statue(dir: Dir, lit: boolean): Bitmap {
  const eye = lit ? P.eyeSolved : P.eyeLit;
  const b = new Bitmap(16, 16);
  // socle
  b.box(3, 12, 12, 14, P.statue);
  b.hline(3, 12, 12, P.statueHi);
  b.hline(3, 12, 14, P.statueShade);
  b.vline(12, 12, 14, P.statueShade);
  // corps : jambes, tronc, épaules
  b.box(5, 9, 10, 11, P.statueShade);
  b.box(4, 6, 11, 9, P.statue);
  b.hline(4, 11, 6, P.statueHi);
  b.vline(11, 7, 9, P.statueShade);
  b.hline(5, 10, 9, P.statueShade);
  // tête : décalée d'un pixel vers le côté regardé
  const hx = dir === 'left' ? 5 : dir === 'right' ? 7 : 6;
  b.box(hx, 1, hx + 3, 5, P.statueHi);
  b.vline(hx + 3, 2, 5, P.statueShade);
  b.hline(hx, hx + 3, 5, P.statueShade);
  b.set(hx, 1, P.statue);
  if (dir === 'down') {
    b.set(hx, 3, eye);
    b.set(hx + 2, 3, eye);
  } else if (dir === 'left') {
    b.set(hx, 3, eye);
    b.set(hx, 2, eye);
  } else if (dir === 'right') {
    b.set(hx + 3, 3, eye);
    b.set(hx + 3, 2, eye);
  } else {
    // de dos : capuche lisse, fente rune
    b.hline(hx + 1, hx + 2, 3, P.statueDeep);
  }
  // chevron lumineux sur la poitrine (la direction se lit même à zoom 2)
  chevron(b, 8, 7, dir, eye);
  // bras tendu dans la direction de gauche / droite
  if (dir === 'left') b.box(1, 7, 3, 8, P.statueShade);
  if (dir === 'right') b.box(12, 7, 14, 8, P.statueShade);
  return b.outline(OUTLINE);
}

/** Socle d'activation : disque de pierre gravé d'un anneau de runes cyan. */
function statueStand(): Bitmap {
  const b = new Bitmap(16, 16);
  b.ellipse(8, 8.5, 7, 5.6, P.statueDeep);
  b.ellipse(8, 8.2, 6.1, 4.8, P.statueShade);
  b.ellipse(8, 8.2, 5, 3.9, P.statueDeep);
  b.ellipse(8, 8.2, 4.1, 3.1, P.statue);
  for (const [x, y] of [[8, 5], [8, 11], [4, 8], [12, 8]] as const) b.set(x, y, P.eyeLit);
  b.set(7, 7, P.statueHi);
  b.set(8, 8, P.eyeLit);
  return b.outline(OUTLINE);
}

// ───────────────────────────── Sablier et herse ─────────────────────────────

/** Intervalle [x0, x1] intérieur du verre pour chaque rangée y = 3..12 (haut : se rétrécit ; bas : s'élargit). */
const GLASS_SPAN: Readonly<Record<number, readonly [number, number]>> = {
  3: [4, 11],
  4: [5, 10],
  5: [6, 9],
  6: [7, 8],
  7: [7, 8],
  8: [7, 8],
  9: [6, 9],
  10: [5, 10],
  11: [4, 11],
  12: [4, 11],
};

function hourglass(level: number): Bitmap {
  const b = new Bitmap(16, 16);
  // verre
  for (let y = 3; y <= 12; y++) {
    const [x0, x1] = GLASS_SPAN[y];
    b.hline(x0, x1, y, P.glass);
    b.set(x0 - 1, y, P.glassShade);
    b.set(x1 + 1, y, P.glassShade);
    b.set(x0, y, P.glassHi);
  }
  // sable du haut : rangées empilées depuis le goulot (y = 7) vers le haut ; sable du bas depuis le fond (y = 12)
  const topRows = Math.round((level / HOURGLASS_LEVELS) * 5);
  const botRows = Math.round(((HOURGLASS_LEVELS - level) / HOURGLASS_LEVELS) * 5);
  for (let i = 0; i < topRows; i++) {
    const y = 7 - i;
    const [x0, x1] = GLASS_SPAN[y];
    b.hline(x0, x1, y, i === topRows - 1 ? P.sandHi : P.sand);
  }
  for (let i = 0; i < botRows; i++) {
    const y = 12 - i;
    const [x0, x1] = GLASS_SPAN[y];
    b.hline(x0, x1, y, i === botRows - 1 ? P.sandHi : P.sandShade);
  }
  if (topRows > 0 && botRows < 5) b.set(8, 8, P.sandHi);
  // cadre de bronze : chapeaux et montants
  b.box(2, 1, 13, 2, P.frameGold);
  b.hline(2, 13, 1, P.sandHi);
  b.hline(2, 13, 2, P.frameDark);
  b.box(2, 13, 13, 14, P.frameGold);
  b.hline(2, 13, 13, P.sandHi);
  b.hline(2, 13, 14, P.frameDark);
  b.vline(2, 3, 12, P.frameDark);
  b.vline(13, 3, 12, P.frameDark);
  return b.outline(OUTLINE);
}

/** Herse fermée : grille de fer sur fond sombre, opaque (tuile solide). */
function gateClosed(): Bitmap {
  const b = new Bitmap(16, 16);
  b.rect(0, 0, 16, 16, P.barDark);
  for (const x of [1, 5, 9, 13]) {
    b.vline(x, 0, 15, P.bar);
    b.vline(x + 1, 0, 15, P.barDark);
    b.set(x, 0, P.barHi);
    b.vline(x, 1, 13, P.barHi);
    // pointes en bas
    b.set(x, 15, P.barHi);
  }
  for (const y of [3, 10]) {
    b.hline(0, 15, y, P.bar);
    b.hline(0, 15, y + 1, P.barDark);
    b.set(0, y, P.barHi);
  }
  b.hline(0, 15, 0, P.bar);
  b.hline(0, 15, 15, P.barDark);
  return b;
}

/** Herse relevée : seuls les bas des barreaux dépassent du linteau (le sol reste visible). */
function gateOpen(): Bitmap {
  const b = new Bitmap(16, 16);
  b.hline(0, 15, 0, P.bar);
  b.hline(0, 15, 1, P.barDark);
  for (const x of [1, 5, 9, 13]) {
    b.vline(x, 2, 3, P.bar);
    b.set(x, 4, P.barHi);
  }
  for (const [x, y] of [[0, 15], [15, 15]] as const) b.set(x, y, P.barDark);
  return b;
}

// ───────────────────────────── Pont de lumière ─────────────────────────────

/** Planches de lumière dorées posées sur l'abîme : opaque, raccordable entre tuiles. */
function bridgeLit(): Bitmap {
  const b = new Bitmap(16, 16);
  b.rect(0, 0, 16, 16, P.abyssMid);
  for (const y0 of [0, 4, 8, 12]) {
    b.box(0, y0, 15, y0 + 2, P.plank);
    b.hline(0, 15, y0, P.plankHi);
    b.hline(0, 15, y0 + 2, P.plankShade);
    b.hline(0, 15, y0 + 3, P.abyss);
    // clous lumineux
    b.set(1, y0 + 1, P.plankHi);
    b.set(14, y0 + 1, P.plankHi);
  }
  // joints décalés d'une planche à l'autre
  b.vline(7, 1, 1, P.plankShade);
  b.vline(10, 5, 5, P.plankShade);
  b.vline(5, 9, 9, P.plankShade);
  b.vline(9, 13, 13, P.plankShade);
  return b;
}

/** Abîme étoilé : les planches ne sont que des fantômes (contours faibles) tant que le pont n'est pas éclairé. */
function bridgeDark(): Bitmap {
  const b = new Bitmap(16, 16);
  b.rect(0, 0, 16, 16, P.abyss);
  for (const y0 of [0, 4, 8, 12]) {
    b.hline(0, 15, y0, P.abyssMid);
    b.hline(0, 15, y0 + 2, P.abyssMid);
  }
  for (const [x, y] of [[3, 1], [11, 5], [6, 9], [13, 13], [2, 14], [9, 2]] as const) b.set(x, y, P.abyssStar);
  b.set(11, 5, P.plankHi);
  b.set(3, 1, P.plankHi);
  return b;
}

// ───────────────────────────── Lanterne (8×8) ─────────────────────────────

const LANTERN_COLORS: ColorMap = { o: OUTLINE, i: P.lanternIron, G: P.lanternGlass, C: P.lanternCore };

const LANTERN_0 = [
  '..oooo..',
  '.oiiiio.',
  'oiGGGGio',
  'oiGCCGio',
  'oiGCCGio',
  'oiGGGGio',
  '.oiiiio.',
  '..oooo..',
];
const LANTERN_1 = [
  '..oooo..',
  '.oiiiio.',
  'oiGCCGio',
  'oiCCCCio',
  'oiGCCGio',
  'oiGGGGio',
  '.oiiiio.',
  '..oooo..',
];

/** Frames des mécanismes des niveaux 4-6 (statues, sablier, herse, pont de lumière, lanterne). */
export function buildMechanism46Frames(): Record<string, Bitmap> {
  const out: Record<string, Bitmap> = {
    statuepair_stand: statueStand(),
    gate_closed: gateClosed(),
    gate_open: gateOpen(),
    bridge_lit: bridgeLit(),
    bridge_dark: bridgeDark(),
    lantern_0: Bitmap.fromRows(LANTERN_0, LANTERN_COLORS),
    lantern_1: Bitmap.fromRows(LANTERN_1, LANTERN_COLORS),
  };
  for (const d of STATUE_DIRS) {
    out[`statuepair_${d}`] = statue(d, false);
    out[`statuepair_${d}_lit`] = statue(d, true);
  }
  for (let l = 0; l <= HOURGLASS_LEVELS; l++) out[`hourglass_${l}`] = hourglass(l);
  return out;
}
