/**
 * Art du système de torches / salles sombres :
 *  - `brazier_unlit`, `brazier_lit_0`, `brazier_lit_1` (16×16) : brasero de métal sur pied, éteint (bois non allumé) ou allumé (flamme animée) ;
 *  - `ui_torch_full`, `ui_torch_half`, `ui_torch_empty` (8×8) : icône de torche du HUD (combustible plein / moitié / vide) ;
 *  - `fx_ember_0`, `fx_ember_1`, `fx_ember_2` (8×8) : étincelles qui montent et retombent (3 étapes de vie).
 * Style identique au reste de l'atlas : contour sombre 1 px (sauf particules), aplats, aucune transparence partielle.
 */
import { DECOR_COLORS as D, LIGHT_COLORS as L, MECH_COLORS as M, OUTLINE } from '../palettes';
import { Bitmap, type ColorMap } from './bitmap';

/** Corps du brasero (vasque + pied), identique pour les 3 frames ; les '.' des rangées 8-9 sont comblés par le contenu. */
const BASE = [
  '................', // 0
  '................', // 1
  '................', // 2
  '................', // 3
  '................', // 4
  '................', // 5
  '................', // 6
  '.hhhhhhhhhhhhhh.', // 7 rebord
  '.h............d.', // 8
  '.i............d.', // 9
  '..iiiiiiiiiiid..', // 10 vasque
  '...hiiiiiiiid...', // 11
  '....iiiiiiid....', // 12
  '.....ddddid.....', // 13 pied
  '....dihddhid....', // 14
  '...ddd....ddd...', // 15
];

const BASE_COLORS: ColorMap = { h: M.ironHi, i: M.iron, d: M.ironDark };

/** Contenu de la vasque éteinte : bûches non brûlées sur des braises mortes. */
const UNLIT_FILL = [
  'cWWcaWWWcaWc',
  'acWWWcaWWWca',
];
const UNLIT_COLORS: ColorMap = { c: L.coal, a: L.ash, W: D.wood };

/** Contenu de la vasque allumée : lit de braises incandescentes. */
const LIT_FILL = [
  'DfYfDfYfDfYf',
  'fDfYYfDfYfDf',
];
const LIT_COLORS: ColorMap = { D: L.flameDeep, f: L.flame, Y: L.flameYellow };

function base(fill: readonly string[], colors: ColorMap): Bitmap {
  const b = Bitmap.fromRows(BASE, BASE_COLORS);
  b.stamp(fill.slice(0, 1), colors, 2, 8);
  b.stamp(fill.slice(1, 2), colors, 2, 9);
  return b;
}

function unlit(): Bitmap {
  const b = base(UNLIT_FILL, UNLIT_COLORS);
  // bout de bûches qui dépasse + une braise mourante
  b.box(4, 6, 5, 7, D.wood);
  b.set(4, 6, D.woodHi);
  b.box(9, 5, 10, 7, D.wood);
  b.set(9, 5, D.woodHi);
  b.set(10, 6, D.woodShade);
  b.set(10, 7, D.woodShade);
  b.set(7, 7, L.coalHi);
  b.set(7, 8, L.emberDull);
  b.set(11, 8, L.emberDull);
  return b.outline(OUTLINE);
}

/** Flamme : `lean` −1/+1 penche la pointe ; `tall` règle la hauteur (animation de respiration). */
function lit(step: 0 | 1): Bitmap {
  const b = base(LIT_FILL, LIT_COLORS);
  const lean = step === 0 ? -1 : 1;
  const tall = step === 0 ? 0 : 1;
  // lueur du lit de braises sur le rebord
  b.set(3, 7, L.flame);
  b.set(12, 7, L.flame);
  // flamme : 3 couches
  b.polygon([[2.6, 8], [4.2, 4.6 - tall], [6.2 + lean * 0.6, 3.2], [8 + lean * 3.4, 0.6 + tall * 0.4], [9.4 + lean * 0.8, 3], [11.4, 4.2], [13.4, 8]], L.flameDeep);
  b.polygon([[4.2, 8], [5.4, 5.4], [7.2 + lean * 0.6, 3.4], [8 + lean * 2.4, 1.6 + tall * 0.4], [9.2, 4], [10.6, 5.6], [11.8, 8]], L.flame);
  b.polygon([[5.6, 8], [6.8, 5.8], [8 + lean * 0.8, 3.6 - tall * 0.4], [9.2, 5.8], [10.4, 8]], L.flameYellow);
  b.polygon([[6.8, 8], [8 + lean * 0.4, 5.6], [9.2, 8]], L.flameCore);
  // étincelle qui s'échappe (varie d'une frame à l'autre)
  b.set(step === 0 ? 11 : 4, step === 0 ? 2 : 1, L.flameYellow);
  return b.outline(OUTLINE);
}

// ───────────────────────────── Icônes de torche du HUD (8×8) ─────────────────────────────

const ICON_COLORS: ColorMap = {
  o: OUTLINE,
  Y: L.flameYellow,
  g: L.flame,
  r: L.flameDeep,
  w: D.wood,
  W: D.woodHi,
  s: D.woodShade,
  i: M.ironHi,
  c: L.coal,
};

const TORCH_FULL = [
  '...oo...',
  '..oYYo..',
  '.ogYYgo.',
  '.orggro.',
  '..oiio..',
  '..oWso..',
  '..oWso..',
  '...oo...',
];

const TORCH_HALF = [
  '........',
  '...oo...',
  '..oYYo..',
  '..ogro..',
  '..oiio..',
  '..oWso..',
  '..oWso..',
  '...oo...',
];

const TORCH_EMPTY = [
  '........',
  '........',
  '........',
  '..ocso..',
  '..oiio..',
  '..oWso..',
  '..oWso..',
  '...oo...',
];

// ───────────────────────────── Braises (8×8) ─────────────────────────────

const EMBER_COLORS: ColorMap = { Y: L.flameYellow, W: L.flameCore, g: L.flame, r: L.flameDeep, f: L.sparkFade, e: L.emberDull };

/** Trois étapes d'une étincelle : vive (croix lumineuse), orange (point + éclat), mourante (points rouges épars). */
const EMBERS: readonly (readonly string[])[] = [
  [
    '........',
    '...g....',
    '..gWg...',
    '...g..Y.',
    '.....YWY',
    '..Y...Y.',
    '.YWY....',
    '..Y.....',
  ],
  [
    '........',
    '........',
    '...gg...',
    '..gYYg..',
    '..gYgr..',
    '...gr...',
    '.r....g.',
    '......r.',
  ],
  [
    '........',
    '........',
    '........',
    '...r....',
    '..rer...',
    '...r..f.',
    '.f......',
    '.....e..',
  ],
];

/** Frames de lumière : brasero (3), icônes de torche du HUD (3), braises (3). */
export function buildLightFrames(): Record<string, Bitmap> {
  const out: Record<string, Bitmap> = {
    brazier_unlit: unlit(),
    brazier_lit_0: lit(0),
    brazier_lit_1: lit(1),
    ui_torch_full: Bitmap.fromRows(TORCH_FULL, ICON_COLORS),
    ui_torch_half: Bitmap.fromRows(TORCH_HALF, ICON_COLORS),
    ui_torch_empty: Bitmap.fromRows(TORCH_EMPTY, ICON_COLORS),
  };
  EMBERS.forEach((rows, i) => {
    out[`fx_ember_${i}`] = Bitmap.fromRows(rows, EMBER_COLORS);
  });
  return out;
}
