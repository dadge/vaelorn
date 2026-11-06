/**
 * Décors 16×16 posés sur le sol (non bloquants sauf règle du niveau) :
 * torches (2 frames de flamme), statue, bannière, caisse, ossements, plante, cristal, panneau.
 */
import { DECOR_COLORS as D, OUTLINE, WHITE } from '../palettes';
import { Bitmap, CLEAR } from './bitmap';

function torch(step: number): Bitmap {
  const b = new Bitmap(16, 16);
  // manche de bois + applique de fer
  b.box(7, 9, 8, 14, D.wood);
  b.vline(7, 9, 14, D.woodHi);
  b.vline(8, 10, 14, D.woodShade);
  b.box(5, 8, 10, 9, D.iron);
  b.hline(5, 10, 8, D.ironHi);
  b.box(6, 7, 9, 7, D.iron);
  b.box(6, 13, 9, 14, D.iron);
  b.hline(6, 9, 13, D.ironHi);
  // flamme : se penche à gauche / à droite
  const lean = step === 0 ? -1 : 1;
  b.polygon([[5.4, 7], [8 + lean * 1.4, 1.2], [8 + lean * 0.4, 3.6], [10.6, 7]], D.flameDeep);
  b.polygon([[6.2, 7], [8 + lean * 0.8, 2.8], [9.8, 7]], D.flame);
  b.polygon([[7, 7], [8 + lean * 0.4, 4.6], [9, 7]], D.flameHi);
  return b.outline(OUTLINE);
}

function statue(): Bitmap {
  const b = new Bitmap(16, 16);
  // socle
  b.box(3, 12, 12, 14, D.stone);
  b.hline(3, 12, 12, D.stoneHi);
  b.hline(3, 12, 14, D.stoneShade);
  // jambes + corps de chevalier en pierre
  b.box(5, 9, 10, 11, D.stone);
  b.vline(10, 9, 11, D.stoneShade);
  b.box(4, 5, 11, 8, D.stone);
  b.hline(4, 11, 5, D.stoneHi);
  b.vline(11, 6, 8, D.stoneShade);
  b.box(5, 8, 10, 8, D.stoneShade);
  // casque
  b.box(6, 1, 9, 4, D.stoneHi);
  b.vline(9, 2, 4, D.stoneShade);
  b.hline(6, 9, 3, D.stoneDark);
  b.set(8, 0, D.stoneHi);
  // épée plantée devant
  b.vline(2, 5, 12, D.stoneHi);
  b.vline(3, 6, 11, D.stoneShade);
  b.hline(1, 4, 8, D.stoneShade);
  return b.outline(OUTLINE);
}

function banner(): Bitmap {
  const b = new Bitmap(16, 16);
  b.hline(2, 13, 1, D.gold);
  b.hline(2, 13, 2, D.goldShade);
  b.set(1, 1, D.gold);
  b.set(14, 1, D.gold);
  b.box(3, 3, 12, 11, D.banner);
  b.vline(12, 3, 11, D.bannerShade);
  b.vline(11, 4, 11, D.bannerShade);
  // pointes inférieures
  b.polygon([[3, 12], [7.5, 12], [5.5, 14.5], [3, 14.5]], D.banner);
  b.polygon([[8.5, 12], [12, 12], [12, 14.5], [10, 14.5]], D.bannerShade);
  b.polygon([[3, 11], [12, 11], [12, 12.5], [3, 12.5]], D.banner);
  // emblème : soleil brisé
  b.ellipse(7.5, 7, 2.6, 2.6, D.gold);
  b.ellipse(7.5, 7, 1.2, 1.2, D.banner);
  b.line(7.5, 3.5, 7.5, 4.6, D.gold);
  b.line(4, 7, 5, 7, D.gold);
  b.line(10, 7, 11, 7, D.gold);
  b.set(7, 6, D.goldShade);
  return b.outline(OUTLINE);
}

function crate(): Bitmap {
  const b = new Bitmap(16, 16);
  b.box(2, 3, 13, 14, D.wood);
  b.box(2, 3, 13, 4, D.woodHi);
  b.vline(13, 4, 14, D.woodShade);
  b.hline(2, 13, 14, D.woodShade);
  // planches
  b.hline(3, 12, 8, D.woodShade);
  b.hline(3, 12, 9, D.woodHi);
  // cadre de fer + croix de renfort
  b.frame(2, 3, 13, 14, D.iron);
  b.line(3, 4, 12, 13, D.woodShade);
  b.line(3, 13, 12, 4, D.woodShade);
  for (const [x, y] of [[3, 4], [12, 4], [3, 13], [12, 13]] as const) b.set(x, y, D.ironHi);
  return b.outline(OUTLINE);
}

function bones(): Bitmap {
  const b = new Bitmap(16, 16);
  // fémurs croisés
  b.line(2, 13, 13, 9, D.bone);
  b.line(2, 9, 13, 13, D.bone);
  b.line(2, 14, 13, 10, D.boneShade);
  for (const [x, y] of [[2, 13], [1, 12], [2, 9], [1, 10], [13, 9], [14, 10], [13, 13], [14, 12]] as const) b.set(x, y, D.bone);
  // crâne
  b.ellipse(8, 7, 3.6, 3.2, D.bone);
  b.box(6, 9, 10, 10, D.bone);
  b.set(10, 6, D.boneShade);
  b.set(10, 7, D.boneShade);
  b.box(6, 6, 7, 7, OUTLINE);
  b.box(9, 6, 10, 7, OUTLINE);
  b.set(8, 8, D.boneShade);
  b.hline(6, 10, 10, D.boneShade);
  b.set(7, 10, OUTLINE);
  b.set(9, 10, OUTLINE);
  return b.outline(OUTLINE);
}

function plant(): Bitmap {
  const b = new Bitmap(16, 16);
  // pot
  b.box(5, 10, 10, 14, D.pot);
  b.hline(4, 11, 10, D.potShade);
  b.hline(4, 11, 9, D.pot);
  b.vline(10, 11, 14, D.potShade);
  b.hline(5, 10, 14, D.potShade);
  // feuilles en éventail
  b.polygon([[7.5, 9], [2, 4], [4, 8]], D.leaf);
  b.polygon([[8.5, 9], [14, 4], [12, 8]], D.leaf);
  b.polygon([[7.5, 9], [5, 2], [8, 3]], D.leafHi);
  b.polygon([[8.5, 9], [11, 2], [8.5, 4]], D.leaf);
  b.polygon([[8, 9], [6.5, 4], [9.5, 4]], D.leafShade);
  b.line(8, 9, 5, 5, D.leafHi);
  b.line(8, 9, 11, 5, D.leafShade);
  // fleur
  b.ellipse(8, 3.2, 1.6, 1.6, D.bloom);
  b.set(8, 3, D.gold);
  return b.outline(OUTLINE);
}

function crystal(): Bitmap {
  const b = new Bitmap(16, 16);
  const shard = (cx: number, base: number, top: number, hw: number) => {
    b.polygon([[cx - hw, base], [cx - hw, top + hw], [cx, top], [cx + hw, top + hw], [cx + hw, base]], D.crystal);
    b.polygon([[cx - hw, base], [cx - hw, top + hw], [cx, top], [cx, base]], D.crystalHi);
    b.polygon([[cx, top], [cx + hw, top + hw], [cx + hw, base], [cx, base]], D.crystalShade);
    b.vline(cx + hw, top + hw + 1, base, D.crystalDeep);
  };
  shard(3.6, 13, 7, 2.2);
  shard(12.4, 13, 6, 2.2);
  shard(8, 14, 1.6, 2.8);
  b.set(7, 6, WHITE);
  b.set(7, 7, D.crystalHi);
  b.hline(3, 12, 14, D.crystalDeep);
  return b.outline(OUTLINE);
}

function sign(): Bitmap {
  const b = new Bitmap(16, 16);
  b.box(7, 9, 8, 14, D.wood);
  b.vline(7, 9, 14, D.woodHi);
  b.vline(8, 10, 14, D.woodShade);
  b.box(2, 2, 13, 9, D.wood);
  b.hline(2, 13, 2, D.woodHi);
  b.hline(2, 13, 9, D.woodShade);
  b.box(3, 3, 12, 8, D.parchment);
  b.hline(4, 11, 4, D.ink);
  b.hline(4, 9, 6, D.ink);
  b.hline(4, 10, 7, D.ink);
  b.set(12, 8, D.woodShade);
  b.set(2, 2, CLEAR);
  b.set(13, 2, CLEAR);
  return b.outline(OUTLINE);
}

/** Frames de décors. */
export function buildDecorFrames(): Record<string, Bitmap> {
  return {
    decor_torch_0: torch(0),
    decor_torch_1: torch(1),
    decor_statue: statue(),
    decor_banner: banner(),
    decor_crate: crate(),
    decor_bones: bones(),
    decor_plant: plant(),
    decor_crystal: crystal(),
    sign: sign(),
  };
}
