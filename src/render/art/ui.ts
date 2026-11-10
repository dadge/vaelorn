/**
 * Icônes d'interface 8×8 : cœurs (plein / demi / vide), coche, croix, croix médicale rouge (`ui_medcross`, demande de soins), crâne « à terre », étoile de l'attaque spéciale (`ui_special`).
 * (Les icônes de clé `ui_key_<n>` sont produites par mechanisms.ts : buildKeyIcons.)
 */
import { OUTLINE, UI_COLORS as U } from '../palettes';
import { Bitmap, type ColorMap } from './bitmap';

const HEART = [
  '.oo..oo.',
  'oHHooRRo',
  'oHRRRRRo',
  'oRRRRRSo',
  '.oRRRSo.',
  '..oRSo..',
  '...oo...',
];

const CHECK = [
  '......oo',
  '.....ogo',
  'oo..ogo.',
  'ogo.ogo.',
  '.ogogo..',
  '..ogo...',
  '...o....',
];

const CROSS = [
  'oo....oo',
  'ogo..ogo',
  '.ogooog.',
  '..oggo..',
  '..oggo..',
  '.ogooog.',
  'ogo..ogo',
  'oo....oo',
];

/** Croix MÉDICALE rouge 8×8 (deux barres), contour sombre et reflet blanc : symbole de la demande de soins (appel automatique `cross`), lisible sur disque clair comme sur tout fond. Aucun pixel semi-transparent. */
const MEDCROSS = [
  '..oooo..',
  '..oWRo..',
  'oooRRooo',
  'oWRRRRRo',
  'oRRRRRRo',
  'oooRRooo',
  '..oRRo..',
  '..oooo..',
];

const SKULL = [
  '..oooo..',
  '.obbbbo.',
  'obbbbbbo',
  'obooboso',
  'obbbbbso',
  '.obbbso.',
  '..obobo.',
  '..oooo..',
];

/** Étoile dorée de l'attaque spéciale (HUD) : à teinter en gris pendant la recharge. */
const SPECIAL = [
  '...oo...',
  '..oWgo..',
  '.ooWgoo.',
  'oWWWgggo',
  'oggggGGo',
  '.ooggGoo',
  '..ogGGo.',
  '...oo...',
];

function heart(kind: 'full' | 'half' | 'empty'): Bitmap {
  const full: ColorMap = { o: OUTLINE, H: U.heartHi, R: U.heart, S: U.heartShade };
  const empty: ColorMap = { o: OUTLINE, H: U.heartEmptyEdge, R: U.heartEmpty, S: U.heartEmptyEdge };
  if (kind === 'full') return Bitmap.fromRows(HEART, full);
  if (kind === 'empty') return Bitmap.fromRows(HEART, empty);
  // demi : moitié gauche pleine, moitié droite vide
  const a = Bitmap.fromRows(HEART, full);
  const e = Bitmap.fromRows(HEART, empty);
  for (let y = 0; y < 8; y++) for (let x = 4; x < 8; x++) a.set(x, y, e.get(x, y));
  return a;
}

/**
 * Cœur 8×7 de l'interface (plein / demi / vide), réutilisé par les cartouches de nourriture (`pickup_*`, `loot.ts`) : un seul dessin de cœur dans l'atlas.
 */
export function heartBitmap(kind: 'full' | 'half' | 'empty'): Bitmap {
  return heart(kind);
}

/** Frames d'interface 8×8. */
export function buildUiFrames(): Record<string, Bitmap> {
  const pad = (b: Bitmap): Bitmap => {
    const o = new Bitmap(8, 8);
    o.blit(b, 0, 0);
    return o;
  };
  return {
    ui_heart_full: pad(heart('full')),
    ui_heart_half: pad(heart('half')),
    ui_heart_empty: pad(heart('empty')),
    ui_check: pad(Bitmap.fromRows(CHECK, { o: OUTLINE, g: U.checkGreen })),
    ui_cross: pad(Bitmap.fromRows(CROSS, { o: OUTLINE, g: U.crossRed })),
    ui_medcross: pad(Bitmap.fromRows(MEDCROSS, { o: OUTLINE, W: U.white, R: U.medCross })),
    ui_down: pad(Bitmap.fromRows(SKULL, { o: OUTLINE, b: U.skull, s: U.skullShade })),
    ui_special: pad(Bitmap.fromRows(SPECIAL, { o: OUTLINE, W: U.white, g: U.keyGold, G: U.keyShade })),
  };
}
