/**
 * Boss 48×48 : Gorgrim (golem de racines, niveau 2) et Morvane (seigneur déchu, niveau 3).
 * Chaque boss : 2 frames d'animation (`boss_<kind>_<0|1>`) + silhouette de dégâts (`boss_<kind>_hurt`).
 * Dessinés par code : formes ombrées « cel-shading » en calques, chaque calque cerclé d'un trait sombre interne,
 * puis contour 1 px commun.
 */
import { BOSS_COLORS, HURT_COLORS, OUTLINE, rgb } from '../palettes';
import { Bitmap, CLEAR, hash2 } from './bitmap';

export const BOSS_KINDS = ['golem', 'morvane'] as const;

/** Dessine un calque 48×48, le cerne d'un trait interne `edge` puis le superpose à `dst`. */
function layer(dst: Bitmap, edge: number, draw: (b: Bitmap) => void): void {
  const b = new Bitmap(dst.w, dst.h);
  draw(b);
  b.outline(edge);
  dst.blit(b, 0, 0);
}

/** Texture d'écorce : quelques traits sombres verticaux déterministes sur les pixels `base`. */
function bark(b: Bitmap, base: number, dark: number, seed: number): void {
  for (let y = 0; y < b.h; y++) {
    for (let x = 0; x < b.w; x++) {
      if (b.get(x, y) !== base) continue;
      if (hash2(x >> 1, y >> 2, seed) < 0.16 && hash2(x, y, seed + 7) < 0.7) b.set(x, y, dark);
    }
  }
}

function golem(step: number): Bitmap {
  const c = BOSS_COLORS.golem;
  const out = new Bitmap(48, 48);
  const wood = { hi: c.barkHi, base: c.bark, shade: c.barkShade };
  const moss = { hi: c.mossHi, base: c.moss, shade: c.mossShade };
  const dy = step === 1 ? 1 : 0; // le torse s'affaisse
  const arm = step === 1 ? 3 : 0; // les bras se lèvent avant de frapper

  // jambes-racines
  layer(out, c.barkDeep, (b) => {
    b.shadedEllipse(17, 39.5, 5.6, 7, wood);
    b.shadedEllipse(31, 39.5, 5.6, 7, wood);
    for (const [x0, y0, x1, y1] of [[12, 44, 8, 46], [15, 46, 13, 47], [20, 45, 24, 47], [28, 45, 24, 47], [33, 46, 35, 47], [36, 44, 40, 46]] as const) {
      b.line(x0, y0, x1, y1, c.bark);
      b.line(x0, y0 - 1, x1, y1 - 1, c.barkShade);
    }
    bark(b, c.bark, c.barkShade, 3);
  });
  // torse massif
  layer(out, c.barkDeep, (b) => {
    b.shadedEllipse(24, 25 + dy, 13.8, 12.2, wood);
    bark(b, c.bark, c.barkShade, 11);
    // fissures incandescentes
    const crack: Array<[number, number]> = [[22, 19], [24, 23], [21, 27], [24, 31], [22, 34]];
    for (let i = 0; i + 1 < crack.length; i++) {
      b.line(crack[i][0], crack[i][1] + dy, crack[i + 1][0], crack[i + 1][1] + dy, c.glowDeep);
    }
    for (const [x, y] of crack) b.set(x, y + dy, c.glow);
    b.set(24, 23 + dy, c.glowHi);
    b.set(24, 31 + dy, c.glowHi);
    b.line(29, 24 + dy, 31, 29 + dy, c.glowDeep);
    b.set(30, 27 + dy, c.glow);
    // mousse sur les épaules et le dos
    b.shadedEllipse(15, 17 + dy, 4.6, 2.8, moss);
    b.shadedEllipse(33, 18 + dy, 4.6, 2.8, moss);
    b.shadedEllipse(24, 15 + dy, 3.6, 2, moss);
    for (const [x, y] of [[13, 20], [15, 21], [34, 21], [32, 22], [20, 17]] as const) b.set(x, y + dy, c.moss);
    b.set(13, 21 + dy, c.mossShade);
    b.set(35, 22 + dy, c.mossShade);
  });
  // tête : ramure de racines, yeux ardents, bouche de racines
  layer(out, c.barkDeep, (b) => {
    for (const [x0, y0, x1, y1] of [[19, 6, 16, 2], [17, 4, 13, 4], [29, 6, 32, 2], [31, 4, 35, 4], [24, 5, 24, 1]] as const) {
      b.line(x0, y0 + dy, x1, y1 + dy, c.bark);
    }
    for (const [x, y] of [[16, 1], [13, 3], [32, 1], [35, 3], [24, 1]] as const) b.set(x, y + dy, c.moss);
    b.set(15, 2 + dy, c.mossHi);
    b.set(33, 2 + dy, c.mossHi);
    b.shadedEllipse(24, 11 + dy, 7.6, 6.6, wood);
    bark(b, c.bark, c.barkShade, 5);
    b.hline(17, 21, 9 + dy, c.barkDeep);
    b.hline(27, 31, 9 + dy, c.barkDeep);
    b.box(18, 10 + dy, 22, 12 + dy, c.barkDeep);
    b.box(26, 10 + dy, 30, 12 + dy, c.barkDeep);
    b.box(19, 11 + dy, 21, 11 + dy, c.glow);
    b.box(27, 11 + dy, 29, 11 + dy, c.glow);
    b.set(20, 11 + dy, c.glowHi);
    b.set(28, 11 + dy, c.glowHi);
    b.set(20, 10 + dy, c.glowDeep);
    b.set(28, 10 + dy, c.glowDeep);
    b.hline(20, 28, 16 + dy, c.barkDeep);
    for (const x of [21, 23, 25, 27]) b.set(x, 17 + dy, c.barkDeep);
    b.set(22, 16 + dy, c.rootLight);
    b.set(26, 16 + dy, c.rootLight);
  });
  // bras puissants et poings
  for (const side of [-1, 1] as const) {
    const ax = side === -1 ? 8 : 40;
    layer(out, c.barkDeep, (b) => {
      b.shadedEllipse(ax, 26 - arm + dy, 5.8, 10.5, wood);
      b.shadedEllipse(ax, 38.5 - arm, 6.2, 6, wood);
      bark(b, c.bark, c.barkShade, side === -1 ? 21 : 22);
      b.shadedEllipse(ax, 17 - arm + dy, 4, 2.4, moss);
      // phalanges
      b.line(ax - 4, 40 - arm, ax - 4, 43 - arm, c.barkDeep);
      b.line(ax, 41 - arm, ax, 44 - arm, c.barkDeep);
      b.line(ax + 4, 40 - arm, ax + 4, 43 - arm, c.barkDeep);
      b.set(ax, 30 - arm + dy, c.glowDeep);
      b.set(ax + side, 31 - arm + dy, c.glow);
    });
  }
  return out.outline(OUTLINE);
}

function morvane(step: number): Bitmap {
  const c = BOSS_COLORS.morvane;
  const out = new Bitmap(48, 48);
  const sway = step === 1 ? 2 : 0;
  const dy = step === 1 ? 1 : 0;

  // cape déployée, doublure cramoisie
  layer(out, c.robeDeep, (b) => {
    b.polygon([[14, 14], [34, 14], [41 + sway, 45], [7 - sway, 45]], c.robe);
    b.polygon([[14, 16], [20, 16], [16 - sway, 45], [7 - sway, 45]], c.lining);
    b.polygon([[34, 16], [28, 16], [32 + sway, 45], [41 + sway, 45]], c.lining);
    b.polygon([[14, 17], [17, 17], [13 - sway, 45], [10 - sway, 45]], c.redShade);
    b.polygon([[34, 17], [31, 17], [35 + sway, 45], [38 + sway, 45]], c.redShade);
    // plis de la cape
    b.line(24, 30, 22, 45, c.robeShade);
    b.line(24, 30, 27 + sway, 45, c.robeShade);
    // lambeaux du bas
    for (const x of [10, 16, 22, 28, 34, 40]) b.set(x + (x > 24 ? sway : -sway), 46, c.robeDeep);
  });
  // robe et corps
  layer(out, c.robeDeep, (b) => {
    b.polygon([[17, 18 + dy], [31, 18 + dy], [34, 40], [14, 40]], c.robe);
    b.polygon([[17, 18 + dy], [21, 18 + dy], [19, 40], [14, 40]], c.robeHi);
    b.polygon([[31, 18 + dy], [28, 18 + dy], [29, 40], [34, 40]], c.robeShade);
    // ceinture + gemme
    b.box(16, 33, 32, 35, c.steelShade);
    b.hline(16, 32, 33, c.steel);
    b.box(22, 32, 26, 36, c.steel);
    b.box(23, 33, 25, 35, c.red);
    b.set(23, 33, c.redShade);
    b.set(24, 34, c.crystalHi);
  });
  // plastron
  layer(out, c.robeDeep, (b) => {
    b.polygon([[18, 17 + dy], [30, 17 + dy], [31, 31 + dy], [17, 31 + dy]], c.steel);
    b.polygon([[18, 17 + dy], [24, 17 + dy], [24, 31 + dy], [17, 31 + dy]], c.steelHi);
    b.polygon([[30, 17 + dy], [27, 17 + dy], [28, 31 + dy], [31, 31 + dy]], c.steelShade);
    b.line(24, 18 + dy, 24, 30 + dy, c.steelShade);
    b.box(22, 21 + dy, 26, 25 + dy, c.red);
    b.box(23, 22 + dy, 25, 24 + dy, c.redShade);
    b.set(23, 22 + dy, c.red);
    b.set(22, 21 + dy, c.crystalHi);
    b.hline(19, 29, 28 + dy, c.steelShade);
  });
  // épaulières à pointes
  for (const side of [-1, 1] as const) {
    const sx = side === -1 ? 14 : 34;
    layer(out, c.robeDeep, (b) => {
      b.shadedEllipse(sx, 19 + dy, 5, 3.6, { hi: c.steelHi, base: c.steel, shade: c.steelShade });
      b.polygon([[sx - 3, 17 + dy], [sx, 10 + dy], [sx + 3, 17 + dy]], c.steel);
      b.polygon([[sx - 3, 17 + dy], [sx, 10 + dy], [sx, 17 + dy]], c.steelHi);
      b.set(sx, 20 + dy, c.red);
    });
  }
  // tête : heaume sombre, visière, cornes d'os
  layer(out, c.robeDeep, (b) => {
    b.polygon([[17, 9 + dy], [14, 1 + dy], [16, 2 + dy], [19, 6 + dy]], c.bone);
    b.polygon([[31, 9 + dy], [34, 1 + dy], [32, 2 + dy], [29, 6 + dy]], c.bone);
    b.polygon([[17, 9 + dy], [14, 1 + dy], [15, 5 + dy], [18, 8 + dy]], c.boneShade);
    b.polygon([[31, 9 + dy], [34, 1 + dy], [33, 5 + dy], [30, 8 + dy]], c.boneShade);
    b.shadedEllipse(24, 11 + dy, 6.6, 6.4, { hi: c.steelHi, base: c.steel, shade: c.steelShade });
    b.box(18, 10 + dy, 30, 13 + dy, c.robeDeep);
    b.hline(19, 29, 10 + dy, c.robeShade);
    // yeux rouges
    b.box(20, 11 + dy, 22, 12 + dy, c.red);
    b.box(26, 11 + dy, 28, 12 + dy, c.red);
    b.set(21, 11 + dy, c.crystalHi);
    b.set(27, 11 + dy, c.crystalHi);
    // couronne
    b.hline(19, 29, 5 + dy, c.bone);
    for (const x of [19, 22, 26, 29]) b.set(x, 4 + dy, c.bone);
    b.set(24, 3 + dy, c.red);
    b.set(24, 4 + dy, c.bone);
    b.hline(21, 27, 15 + dy, c.steelShade);
  });
  // bâton cristallin (droite) et orbe maléfique (gauche)
  layer(out, c.robeDeep, (b) => {
    b.vline(40, 9, 44, c.robeShade);
    b.vline(41, 9, 44, c.robeDeep);
    b.hline(39, 42, 20 + dy, c.steel);
    const top = 8 + (step === 1 ? 1 : 0);
    b.polygon([[40.5, top - 7], [44, top], [40.5, top + 6], [37, top]], c.crystal);
    b.polygon([[40.5, top - 7], [37, top], [40.5, top + 6]], c.crystalHi);
    b.polygon([[40.5, top - 7], [44, top], [40.5, top + 6]], c.crystalShade);
    b.set(39, top - 1, c.crystalHi);
    // main griffue
    b.box(38, 21 + dy, 42, 23 + dy, c.steelShade);
  });
  layer(out, c.robeDeep, (b) => {
    const oy = 25 - (step === 1 ? 2 : 0);
    b.shadedEllipse(7, oy, 4.2, 4.2, { hi: c.red, base: c.redShade, shade: c.redDeep });
    b.set(5, oy - 2, c.crystalHi);
    b.set(6, oy - 2, c.crystalHi);
    b.box(6, oy + 5, 8, oy + 7, c.steelShade);
  });
  return out.outline(OUTLINE);
}

/** Silhouette de dégâts : même forme, 4 niveaux de luminosité clair → rouge (le contour est conservé). */
function toHurt(src: Bitmap): Bitmap {
  const out = src.clone();
  out.recolor((col) => {
    if (col === OUTLINE) return OUTLINE;
    const [r, g, b] = rgb(col);
    const lum = 0.3 * r + 0.59 * g + 0.11 * b;
    if (lum > 170) return HURT_COLORS.white;
    if (lum > 110) return HURT_COLORS.light;
    if (lum > 60) return HURT_COLORS.mid;
    return HURT_COLORS.dark;
  });
  return out;
}

/** Frames boss 48×48 : `boss_<kind>_<0|1>` et `boss_<kind>_hurt`. */
export function buildBossFrames(): Record<string, Bitmap> {
  const out: Record<string, Bitmap> = {};
  const draw: Record<(typeof BOSS_KINDS)[number], (step: number) => Bitmap> = { golem, morvane };
  for (const kind of BOSS_KINDS) {
    const f0 = draw[kind](0);
    out[`boss_${kind}_0`] = f0;
    out[`boss_${kind}_1`] = draw[kind](1);
    out[`boss_${kind}_hurt`] = toHurt(f0);
  }
  void CLEAR;
  return out;
}
