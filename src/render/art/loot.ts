/**
 * Art des sources de vie (PROVISOIRE, généré par code) :
 *  - `pickup_half`, `pickup_full` (16×16) : nourriture au sol = SEULEMENT le cœur de l'interface (`heartBitmap`, réutilisé : un
 *    seul dessin de cœur), agrandi ×2 : demi-cœur (+5 PV) ou cœur entier (+10 PV), sans cadre ni fond ;
 *  - `heal_crystal_0`, `heal_crystal_1` (16×16) : cristal de soin émeraude sur socle de pierre, 2 frames d'éclat ;
 *    `heal_crystal_used` (16×16) : même cristal vidé (gris, sans éclat), après usage.
 * Le halo lumineux (FX_GLOW_KEY teinté) et le clignotement des 3 dernières secondes sont des effets de rendu (entities/LifeViews.ts, render/lifeFx.ts).
 * Style identique au reste de l'atlas : contour sombre 1 px, aplats, aucun pixel semi-transparent.
 */
import { LOOT_COLORS as L, OUTLINE } from '../palettes';
import { Bitmap } from './bitmap';
import { heartBitmap } from './ui';

/** Cœur de l'interface (8×7) agrandi ×2 (pixels carrés 2×2) et centré dans une frame 16×16 : aucun cadre, aucun fond. */
function pickup(full: boolean): Bitmap {
  const src = heartBitmap(full ? 'full' : 'half');
  const b = new Bitmap(16, 16);
  const ox = Math.floor((16 - src.w * 2) / 2);
  const oy = Math.floor((16 - src.h * 2) / 2);
  for (let y = 0; y < src.h; y++) {
    for (let x = 0; x < src.w; x++) {
      const c = src.get(x, y);
      if (c < 0) continue;
      b.set(ox + x * 2, oy + y * 2, c);
      b.set(ox + x * 2 + 1, oy + y * 2, c);
      b.set(ox + x * 2, oy + y * 2 + 1, c);
      b.set(ox + x * 2 + 1, oy + y * 2 + 1, c);
    }
  }
  return b;
}

/** Cristal : hexagone allongé (facette claire à gauche, sombre à droite) sur un petit socle de pierre ; `state` règle les couleurs et l'éclat. */
function crystal(state: 'a' | 'b' | 'used'): Bitmap {
  const used = state === 'used';
  const hi = used ? L.usedHi : L.crystalHi;
  const mid = used ? L.used : L.crystal;
  const shade = used ? L.usedShade : L.crystalShade;
  const deep = used ? L.usedShade : L.crystalDeep;
  const b = new Bitmap(16, 16);
  // socle
  b.ellipse(8, 13.4, 6, 2.2, L.baseShade);
  b.ellipse(8, 12.8, 5.2, 1.8, L.base);
  b.hline(4, 9, 12, L.baseHi);
  // corps
  b.polygon([[8, 0.6], [11.8, 4], [11.8, 10], [8, 13.2], [4.2, 10], [4.2, 4]], mid);
  b.polygon([[8, 0.6], [8, 13.2], [4.2, 10], [4.2, 4]], hi); // facette gauche claire
  b.polygon([[8, 0.6], [11.8, 4], [11.8, 10], [8, 13.2]], shade); // facette droite sombre
  b.polygon([[8, 3], [10.2, 5], [10.2, 9], [8, 11]], mid); // coeur de la gemme
  b.vline(8, 1, 12, deep); // arête centrale
  if (!used) {
    // éclat : petite croix blanche qui change de place entre les 2 frames
    const [sx, sy] = state === 'a' ? [6, 4] : [10, 7];
    b.set(sx, sy, L.spark);
    b.set(sx - 1, sy, L.spark);
    b.set(sx + 1, sy, L.spark);
    b.set(sx, sy - 1, L.spark);
    b.set(sx, sy + 1, L.spark);
  } else {
    // fissure : gemme vidée
    b.line(7, 4, 9, 8, L.usedShade);
  }
  return b.outline(OUTLINE);
}

/** Frames des sources de vie. */
export function buildLootFrames(): Record<string, Bitmap> {
  return {
    pickup_half: pickup(false),
    pickup_full: pickup(true),
    heal_crystal_0: crystal('a'),
    heal_crystal_1: crystal('b'),
    heal_crystal_used: crystal('used'),
  };
}
