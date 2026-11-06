/**
 * Tuiles 16×16 des 3 thèmes de donjon (crypt, grove, citadel) : toutes OPAQUES et raccordables entre elles.
 *
 *  floor / floor_alt : sol (la variante alt ajoute fissure / terre / rune ; mêmes joints → raccord parfait)
 *  wall              : FACE d'un mur (à utiliser quand la tuile en dessous n'est pas un mur)
 *  wall_top          : DESSUS d'un mur (masse sombre : tuile dont le voisin du bas est aussi un mur / le vide)
 *  pillar            : pilier plein posé sur le sol (le fond de sol est inclus dans la frame)
 *  pit               : fosse (bloque les déplacements, pas les projectiles)
 *  void              : vide hors-salle (aplat sombre)
 */
import type { ZoneTheme } from '../../core/types';
import { THEME_PALETTES, type ThemePalette } from '../palettes';
import { Bitmap, hash2 } from './bitmap';

export const TILE_THEMES: readonly ZoneTheme[] = ['crypt', 'grove', 'citadel'];
export const TILE_KINDS = ['floor', 'floor_alt', 'wall', 'wall_top', 'pillar', 'pit', 'void'] as const;

type Tiles = Record<(typeof TILE_KINDS)[number], Bitmap>;

function solid(c: number): Bitmap {
  const b = new Bitmap(16, 16);
  b.rect(0, 0, 16, 16, c);
  return b;
}

/** Pose des pixels de bruit déterministes (texture) : n essais, couleur choisie parmi `cols`. */
function speckle(b: Bitmap, seed: number, n: number, cols: readonly number[], only?: number): void {
  for (let i = 0; i < n; i++) {
    const x = Math.floor(hash2(i, 1, seed) * 16);
    const y = Math.floor(hash2(i, 2, seed) * 16);
    if (only !== undefined && b.get(x, y) !== only) continue;
    b.set(x, y, cols[Math.floor(hash2(i, 3, seed) * cols.length)]);
  }
}

/** Dépose `src` (calque transparent) cerné d'un trait `edge` par-dessus `dst`. */
function stampOutlined(dst: Bitmap, src: Bitmap, edge: number): void {
  src.outline(edge);
  dst.blit(src, 0, 0);
}

/** Colonne de pierre vue de 3/4 (calque transparent) : socle, fût strié, chapiteau rond. */
function stoneColumn(p: ThemePalette): Bitmap {
  const col = new Bitmap(16, 16);
  col.box(4, 7, 11, 13, p.wallMid);
  col.vline(10, 7, 13, p.wallDark);
  col.vline(11, 7, 13, p.wallDark);
  col.vline(5, 8, 11, p.wallLight);
  col.vline(7, 9, 11, p.wallDark);
  col.box(3, 12, 12, 13, p.wallMid);
  col.hline(3, 12, 13, p.wallDark);
  col.hline(3, 5, 12, p.wallLight);
  col.ellipse(8, 7, 5.4, 4.2, p.wallLight);
  col.ellipse(8, 7.3, 3.8, 2.8, p.wallMid);
  col.hline(5, 8, 5, p.wallLight);
  col.set(10, 8, p.wallDark);
  return col;
}

// ───────────────────────────── Crypte : dalles de pierre bleu-gris, torches ─────────────────────────────

function cryptTiles(p: ThemePalette): Tiles {
  const slab = (alt: boolean): Bitmap => {
    const b = solid(p.floorMid);
    // grandes dalles : joints sur les bords bas/droit uniquement (raccord parfait)
    b.hline(0, 15, 15, p.floorDark);
    b.vline(15, 0, 15, p.floorDark);
    b.hline(1, 6, 0, p.floorLight);
    b.vline(0, 1, 5, p.floorLight);
    if (alt) {
      b.line(3, 2, 6, 4, p.floorDark);
      b.line(6, 4, 7, 6, p.floorDark);
      b.line(10, 10, 12, 12, p.floorDark);
      b.set(11, 13, p.floorDark);
      speckle(b, 41, 5, [p.floorLight, p.floorDark], p.floorMid);
    } else {
      speckle(b, 17, 4, [p.floorLight, p.floorDark], p.floorMid);
    }
    return b;
  };
  const wall = solid(p.wallMid);
  {
    // briques : 2 rangées + socle sombre au pied du mur
    const b = wall;
    b.hline(0, 15, 0, p.wallLight);
    b.hline(0, 15, 5, p.wallDark);
    b.hline(0, 15, 11, p.wallDark);
    b.vline(7, 1, 4, p.wallDark);
    b.vline(15, 1, 4, p.wallDark);
    b.vline(3, 6, 10, p.wallDark);
    b.vline(11, 6, 10, p.wallDark);
    b.hline(0, 6, 6, p.wallLight);
    b.hline(4, 10, 6, p.wallLight);
    b.hline(12, 15, 6, p.wallLight);
    b.hline(8, 14, 1, p.wallLight);
    b.rect(0, 12, 16, 4, p.wallDark);
    b.hline(0, 15, 12, p.wallTop);
    b.hline(0, 15, 15, p.wallTop);
    b.rect(0, 13, 16, 2, p.wallDark);
    for (const x of [2, 9, 13]) b.set(x, 13, p.wallMid);
  }
  const top = solid(p.wallTop);
  top.hline(0, 15, 0, p.wallDark);
  top.vline(0, 0, 15, p.wallDark);
  speckle(top, 77, 9, [p.wallDark], p.wallTop);
  speckle(top, 78, 3, [p.floorDark], p.wallTop);
  const pillar = slab(false);
  {
    const col = stoneColumn(p);
    stampOutlined(pillar, col, p.outline);
  }
  const pit = solid(p.void);
  pit.hline(0, 15, 0, p.wallTop);
  pit.hline(0, 15, 1, p.wallDark);
  speckle(pit, 5, 5, [p.floorDark], p.void);
  return { floor: slab(false), floor_alt: slab(true), wall, wall_top: top, pillar, pit, void: solid(p.void) };
}

// ───────────────────────────── Bosquet : herbe, terre, racines, mousse luisante ─────────────────────────────

function groveTiles(p: ThemePalette): Tiles {
  const grass = (alt: boolean): Bitmap => {
    const b = solid(p.floorMid);
    speckle(b, alt ? 301 : 101, alt ? 10 : 14, [p.floorDark, p.floorLight], p.floorMid);
    // touffes : petits « v » d'herbe clair
    const tufts: Array<[number, number]> = alt ? [[3, 4], [11, 11]] : [[4, 3], [10, 9], [2, 12]];
    for (const [x, y] of tufts) {
      b.set(x, y, p.floorLight);
      b.set(x + 2, y, p.floorLight);
      b.set(x + 1, y + 1, p.floorDark);
      b.set(x + 1, y, p.floorLight);
    }
    if (alt) {
      // plaque de terre avec cailloux et petit champignon luisant
      b.ellipse(8, 8, 4.6, 3.6, p.wallLight);
      b.ellipse(8, 8.6, 4.2, 2.6, p.wallMid);
      b.set(6, 7, p.wallLight);
      b.set(9, 9, p.wallDark);
      b.set(11, 8, p.wallDark);
      b.set(5, 9, p.wallDark);
      b.set(12, 13, p.accentDeep);
      b.set(12, 12, p.accent);
    }
    return b;
  };
  const wall = solid(p.wallMid);
  {
    // écorce : sillons verticaux, racines au pied
    const b = wall;
    for (const x of [2, 6, 10, 14]) b.vline(x, 0, 13, p.wallDark);
    for (const x of [3, 7, 11, 15]) b.vline(x, 0, 11, p.wallLight);
    for (const x of [1, 9]) b.vline(x, 3, 8, p.wallLight);
    for (const [x, y] of [[4, 5], [8, 8], [12, 4], [5, 10], [13, 9]] as const) b.set(x, y, p.wallDark);
    b.hline(0, 15, 0, p.wallLight);
    b.rect(0, 12, 16, 4, p.wallDark);
    for (const x of [0, 4, 8, 12]) {
      b.vline(x + 1, 12, 14, p.wallMid);
      b.set(x + 2, 12, p.wallMid);
    }
    b.hline(0, 15, 15, p.wallTop);
    b.set(5, 11, p.floorMid);
    b.set(6, 11, p.floorLight);
    b.set(12, 1, p.floorMid);
  }
  const top = solid(p.wallTop);
  {
    // canopée dense : bouquets de feuilles
    const leaf: Array<[number, number, number]> = [[3, 3, 3], [10, 2, 3.2], [7, 8, 3.4], [13, 9, 3], [2, 12, 3], [10, 13, 3]];
    for (const [x, y, r] of leaf) top.ellipse(x, y, r, r - 0.5, p.floorDark);
    for (const [x, y, r] of leaf) top.ellipse(x - 0.6, y - 0.7, r - 1.2, r - 1.5, p.floorMid);
    for (const [x, y] of leaf) top.set(Math.round(x - 1), Math.round(y - 1), p.floorLight);
    speckle(top, 9, 3, [p.accentDeep], p.wallTop);
  }
  const pillar = grass(false);
  {
    // souche / tronc : anneaux au sommet, écorce sur le flanc
    const t = new Bitmap(16, 16);
    t.box(3, 7, 12, 13, p.wallMid);
    for (const x of [4, 7, 10]) t.vline(x, 8, 13, p.wallDark);
    t.vline(5, 8, 12, p.wallLight);
    t.vline(12, 7, 13, p.wallDark);
    t.hline(3, 12, 13, p.wallDark);
    t.ellipse(8, 7, 5.4, 4.4, p.wallLight);
    t.ellipse(8, 7, 3.9, 3, p.wallMid);
    t.ellipse(8, 7, 2.2, 1.6, p.wallLight);
    t.set(8, 7, p.wallDark);
    t.set(11, 11, p.accent);
    t.set(11, 12, p.accentDeep);
    stampOutlined(pillar, t, p.outline);
  }
  const pit = solid(p.wallTop);
  {
    // mare putride : reflets verdâtres, bulles luisantes, berge de racines
    pit.rect(0, 0, 16, 2, p.wallDark);
    pit.hline(0, 15, 2, p.outline);
    for (const x of [1, 5, 9, 13]) pit.set(x, 1, p.wallMid);
    pit.hline(3, 8, 6, p.accentDeep);
    pit.hline(9, 13, 10, p.accentDeep);
    pit.hline(1, 4, 12, p.floorDark);
    pit.hline(7, 10, 5, p.floorDark);
    pit.set(11, 7, p.accent);
    pit.set(4, 9, p.accent);
    pit.set(12, 13, p.accent);
    pit.set(4, 10, p.accentDeep);
  }
  return { floor: grass(false), floor_alt: grass(true), wall, wall_top: top, pillar, pit, void: solid(p.void) };
}

// ───────────────────────────── Citadelle : obsidienne violette, cristaux cyan ─────────────────────────────

function citadelTiles(p: ThemePalette): Tiles {
  const tile = (alt: boolean): Bitmap => {
    const b = solid(p.floorMid);
    // grandes dalles 8×8 séparées de joints sombres
    b.hline(0, 15, 7, p.floorDark);
    b.hline(0, 15, 15, p.floorDark);
    b.vline(7, 0, 15, p.floorDark);
    b.vline(15, 0, 15, p.floorDark);
    b.hline(0, 5, 0, p.floorLight);
    b.vline(0, 1, 5, p.floorLight);
    b.hline(8, 13, 8, p.floorLight);
    b.vline(8, 9, 13, p.floorLight);
    b.set(1, 1, p.floorLight);
    if (alt) {
      // veine de cristal luisante dans la dalle
      b.line(10, 1, 12, 3, p.accentDeep);
      b.line(12, 3, 11, 5, p.accentDeep);
      b.set(12, 3, p.accent);
      b.set(3, 10, p.accentDeep);
      b.set(4, 11, p.accent);
      b.set(3, 12, p.accentDeep);
    } else {
      speckle(b, 55, 3, [p.floorDark, p.floorLight], p.floorMid);
    }
    return b;
  };
  const wall = solid(p.wallMid);
  {
    const b = wall;
    b.hline(0, 15, 0, p.wallLight);
    b.hline(0, 15, 5, p.wallDark);
    b.hline(0, 15, 11, p.wallDark);
    b.vline(5, 1, 4, p.wallDark);
    b.vline(13, 1, 4, p.wallDark);
    b.vline(1, 6, 10, p.wallDark);
    b.vline(9, 6, 10, p.wallDark);
    b.hline(6, 12, 1, p.wallLight);
    b.hline(10, 15, 6, p.wallLight);
    b.hline(2, 8, 6, p.wallLight);
    b.rect(0, 12, 16, 4, p.wallDark);
    b.hline(0, 15, 12, p.wallTop);
    b.hline(0, 15, 15, p.wallTop);
    // éclats de cristal incrustés
    b.set(3, 3, p.accent);
    b.set(3, 2, p.accentHi);
    b.set(3, 4, p.accentDeep);
    b.set(11, 8, p.accentDeep);
    b.set(12, 8, p.accent);
    b.set(10, 13, p.accentDeep);
  }
  const top = solid(p.wallTop);
  top.hline(0, 15, 0, p.wallDark);
  top.vline(0, 0, 15, p.wallDark);
  top.hline(2, 13, 2, p.wallDark);
  top.vline(2, 2, 13, p.wallDark);
  speckle(top, 66, 5, [p.wallDark], p.wallTop);
  top.set(8, 8, p.accentDeep);
  const pillar = tile(false);
  {
    const col = stoneColumn(p);
    col.ellipse(8, 7.3, 3.8, 2.8, p.wallDark);
    // cristal cyan au sommet
    col.polygon([[8, 2.4], [10.4, 7], [8, 9.6], [5.6, 7]], p.accent);
    col.polygon([[8, 2.4], [5.6, 7], [8, 9.6]], p.accentHi);
    col.polygon([[8, 2.4], [10.4, 7], [8, 9.6]], p.accentDeep);
    stampOutlined(pillar, col, p.outline);
  }
  const pit = solid(p.void);
  pit.hline(0, 15, 0, p.wallTop);
  pit.hline(0, 15, 1, p.wallDark);
  for (const [x, y] of [[3, 7], [11, 5], [7, 11], [13, 13], [2, 13]] as const) pit.set(x, y, p.accentDeep);
  pit.set(11, 5, p.accent);
  pit.set(3, 7, p.accent);
  return { floor: tile(false), floor_alt: tile(true), wall, wall_top: top, pillar, pit, void: solid(p.void) };
}

/** Frames `tile_<theme>_<kind>` des 3 thèmes. */
export function buildTileFrames(): Record<string, Bitmap> {
  const out: Record<string, Bitmap> = {};
  const makers: Record<ZoneTheme, (p: ThemePalette) => Tiles> = { crypt: cryptTiles, grove: groveTiles, citadel: citadelTiles };
  for (const theme of TILE_THEMES) {
    const tiles = makers[theme](THEME_PALETTES[theme]);
    for (const k of TILE_KINDS) out[`tile_${theme}_${k}`] = tiles[k];
  }
  return out;
}
