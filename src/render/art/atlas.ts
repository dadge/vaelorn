/**
 * Assemblage de l'atlas : packing « shelf » déterministe de bitmaps 0xRRGGBB en un RGBA unique.
 * PUR (aucun DOM) : testable sous Node.
 */
import { Bitmap, CLEAR } from './bitmap';

export interface FrameRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AtlasData {
  width: number;
  height: number;
  /** RGBA, 4 octets par pixel (alpha 0 ou 255 uniquement). */
  pixels: Uint8ClampedArray;
  frames: Record<string, FrameRect>;
}

/** Marge (px) laissée entre deux frames pour éviter les débordements du filtrage. */
export const ATLAS_MARGIN = 1;
/** Taille maximale d'un côté de l'atlas. */
export const ATLAS_MAX_SIZE = 1024;

function nextPow2(n: number): number {
  let p = 16;
  while (p < n) p *= 2;
  return p;
}

interface Layout {
  width: number;
  height: number;
  placed: Array<{ name: string; x: number; y: number }>;
}

function shelfPack(items: ReadonlyArray<{ name: string; w: number; h: number }>, width: number): Layout | null {
  const placed: Layout['placed'] = [];
  let x = 0;
  let y = 0;
  let shelfH = 0;
  for (const it of items) {
    const iw = it.w + ATLAS_MARGIN;
    const ih = it.h + ATLAS_MARGIN;
    if (iw > width) return null;
    if (x + iw > width) {
      x = 0;
      y += shelfH;
      shelfH = 0;
    }
    placed.push({ name: it.name, x, y });
    x += iw;
    shelfH = Math.max(shelfH, ih);
  }
  const height = nextPow2(y + shelfH);
  return { width, height, placed };
}

/**
 * Empaquette les frames (ordre : hauteur décroissante, puis largeur, puis nom → déterministe)
 * dans l'atlas de plus petite surface (côtés puissances de 2, ≤ ATLAS_MAX_SIZE).
 */
export function packAtlas(frames: Readonly<Record<string, Bitmap>>): AtlasData {
  const items = Object.entries(frames)
    .map(([name, bm]) => ({ name, w: bm.w, h: bm.h }))
    .sort((a, b) => b.h - a.h || b.w - a.w || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  let best: Layout | null = null;
  for (let width = 64; width <= ATLAS_MAX_SIZE; width *= 2) {
    const l = shelfPack(items, width);
    if (!l || l.height > ATLAS_MAX_SIZE) continue;
    const area = l.width * l.height;
    const bestArea = best ? best.width * best.height : Infinity;
    // plus petite surface ; à surface égale, le plus carré
    if (!best || area < bestArea || (area === bestArea && Math.max(l.width, l.height) < Math.max(best.width, best.height))) best = l;
  }
  if (!best) throw new Error('packAtlas: les frames ne tiennent pas dans ' + ATLAS_MAX_SIZE + '×' + ATLAS_MAX_SIZE);

  const pixels = new Uint8ClampedArray(best.width * best.height * 4);
  const out: Record<string, FrameRect> = {};
  for (const p of best.placed) {
    const bm = frames[p.name];
    out[p.name] = { x: p.x, y: p.y, w: bm.w, h: bm.h };
    for (let j = 0; j < bm.h; j++) {
      for (let i = 0; i < bm.w; i++) {
        const c = bm.px[j * bm.w + i];
        if (c === CLEAR) continue;
        const o = ((p.y + j) * best.width + (p.x + i)) * 4;
        pixels[o] = (c >> 16) & 255;
        pixels[o + 1] = (c >> 8) & 255;
        pixels[o + 2] = c & 255;
        pixels[o + 3] = 255;
      }
    }
  }
  return { width: best.width, height: best.height, pixels, frames: out };
}
