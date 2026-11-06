/**
 * Ennemis standards (16×16, 2 frames d'animation, pas de frames gauche/droite : l'entité fait flipX).
 *   slime (blob vert qui s'écrase)   bat (chauve-souris, ailes haut/bas)   skeleton (squelette à épée rouillée)
 *   archer (bandit encapuchonné à arc)   spider (araignée à sablier rouge)   wisp (feu follet cyan)
 *   knight (chevalier maudit, bouclier doré, plumet magenta)
 * Chaque sprite est dessiné par code puis cerclé d'un contour sombre de 1 px.
 */
import type { EnemyKind } from '../../core/types';
import { ENEMY_COLORS, OUTLINE } from '../palettes';
import { Bitmap } from './bitmap';
import { bowBitmap } from './heroKit';

export const SMALL_ENEMY_KINDS = ['slime', 'bat', 'skeleton', 'archer', 'spider', 'wisp', 'knight'] as const satisfies readonly EnemyKind[];

function slime(step: number): Bitmap {
  const c = ENEMY_COLORS.slime;
  const b = new Bitmap(16, 16);
  if (step === 0) {
    b.shadedEllipse(8, 9.2, 6.2, 5.2, { hi: c.hi, base: c.base, shade: c.shade });
    b.hline(3, 12, 13, c.deep);
    b.hline(4, 11, 14, c.deep);
    // yeux
    b.box(5, 7, 6, 9, c.eye);
    b.box(9, 7, 10, 9, c.eye);
    b.set(6, 8, c.pupil);
    b.set(6, 9, c.pupil);
    b.set(10, 8, c.pupil);
    b.set(10, 9, c.pupil);
    b.set(5, 6, c.hi);
    b.hline(7, 8, 11, c.deep);
  } else {
    b.shadedEllipse(8, 10.4, 7, 4.2, { hi: c.hi, base: c.base, shade: c.shade });
    b.hline(2, 13, 13, c.deep);
    b.hline(3, 12, 14, c.deep);
    b.box(4, 8, 5, 10, c.eye);
    b.box(10, 8, 11, 10, c.eye);
    b.set(5, 9, c.pupil);
    b.set(5, 10, c.pupil);
    b.set(11, 9, c.pupil);
    b.set(11, 10, c.pupil);
    b.set(4, 7, c.hi);
    b.hline(7, 9, 11, c.deep);
    b.set(8, 12, c.deep);
  }
  return b.outline(OUTLINE);
}

function bat(step: number): Bitmap {
  const c = ENEMY_COLORS.bat;
  const b = new Bitmap(16, 16);
  if (step === 0) {
    // ailes levées
    b.polygon([[6, 8], [1, 3], [1, 8], [3, 7], [4, 10], [6, 10]], c.wing);
    b.polygon([[10, 8], [15, 3], [15, 8], [13, 7], [12, 10], [10, 10]], c.wing);
    b.polygon([[6, 9], [2, 7], [3, 9], [4, 10]], c.wingShade);
    b.polygon([[10, 9], [14, 7], [13, 9], [12, 10]], c.wingShade);
  } else {
    // ailes battues vers le bas
    b.polygon([[6, 8], [1, 9], [1, 13], [3, 11], [4, 13], [6, 11]], c.wing);
    b.polygon([[10, 8], [15, 9], [15, 13], [13, 11], [12, 13], [10, 11]], c.wing);
    b.polygon([[6, 9], [2, 10], [3, 12], [5, 11]], c.wingShade);
    b.polygon([[10, 9], [14, 10], [13, 12], [11, 11]], c.wingShade);
  }
  const y = step === 0 ? 8 : 7;
  b.shadedEllipse(8, y + 1.5, 3, 3.4, { hi: c.wing, base: c.body, shade: c.bodyDark });
  // oreilles
  b.set(6, y - 2, c.body);
  b.set(10, y - 2, c.body);
  b.set(6, y - 1, c.body);
  b.set(10, y - 1, c.body);
  // yeux rouges, crocs
  b.set(7, y + 1, c.eye);
  b.set(9, y + 1, c.eye);
  b.set(7, y + 3, c.fang);
  b.set(9, y + 3, c.fang);
  return b.outline(OUTLINE);
}

function skeleton(step: number): Bitmap {
  const c = ENEMY_COLORS.skeleton;
  const L = { b: c.bone, s: c.boneShade, d: c.boneDark, e: c.eye, m: c.blade, M: c.bladeShade, h: c.hilt };
  const b = new Bitmap(16, 16);
  b.stamp(
    [
      '................',
      '.....bbbbbb.....',
      '....bbbbbbbb....',
      '....bddbbddb....',
      '....bdebbedb....',
      '.....bbbbbb.....',
      '.....bsbsbb.....',
      '......bbbb...m..',
      '....bbbbbbbb.m..',
      '....b.bsbb.bhm..',
      '....b.bddb.bhm..',
      '....b.bsbb.bhM..',
      '.....bbbbbb.hh..',
    ],
    L,
    0,
    0,
  );
  // jambes en alternance
  if (step === 0) {
    b.box(6, 13, 6, 14, c.bone);
    b.set(5, 14, c.boneShade);
    b.box(9, 13, 9, 13, c.bone);
    b.set(10, 13, c.boneShade);
  } else {
    b.box(9, 13, 9, 14, c.bone);
    b.set(10, 14, c.boneShade);
    b.box(6, 13, 6, 13, c.bone);
    b.set(5, 13, c.boneShade);
  }
  return b.outline(OUTLINE);
}

function archer(step: number): Bitmap {
  const c = ENEMY_COLORS.archer;
  const L = { r: c.hood, R: c.hoodShade, f: c.face, e: c.eye, c: c.cloth, C: c.clothShade, w: c.bow, W: c.bowShade, s: c.string };
  const b = new Bitmap(16, 16);
  b.stamp(
    [
      '................',
      '.......rr.......',
      '.....rrrrr......',
      '....rrrrrrr.....',
      '....rRffffR.....',
      '....rfeffeR.....',
      '....rRffffR.....',
      '.....RrrrrR.....',
      '....cccccccc....',
      '....cCcccccC....',
      '....cCccccC.....',
      '.....cccccc.....',
    ],
    L,
    0,
    0,
  );
  b.box(6, 12, 7, step === 0 ? 14 : 13, c.clothShade);
  b.box(9, 12, 10, step === 0 ? 13 : 14, c.clothShade);
  b.set(6, step === 0 ? 14 : 13, c.hoodShade);
  // arc tendu sur le côté
  const bow = bowBitmap(11, 2, c.bow, c.bowShade, c.bowShade, c.string);
  b.blit(bow.flipH(), 11, 3);
  return b.outline(OUTLINE);
}

function spider(step: number): Bitmap {
  const c = ENEMY_COLORS.spider;
  const b = new Bitmap(16, 16);
  const legs: Array<[number, number, number, number]> =
    step === 0
      ? [[6, 8, 1, 5], [6, 9, 1, 9], [6, 10, 2, 13], [7, 11, 5, 14], [10, 8, 15, 5], [10, 9, 15, 9], [10, 10, 14, 13], [9, 11, 11, 14]]
      : [[6, 8, 1, 7], [6, 9, 2, 11], [6, 10, 3, 14], [7, 11, 6, 14], [10, 8, 15, 7], [10, 9, 14, 11], [10, 10, 13, 14], [9, 11, 10, 14]];
  for (const [x0, y0, x1, y1] of legs) b.line(x0, y0, x1, y1, c.leg);
  b.shadedEllipse(8, 9.5, 3.6, 3.6, { hi: c.leg, base: c.body, shade: c.bodyShade });
  b.shadedEllipse(8, 6, 2.4, 2.2, { hi: c.leg, base: c.body, shade: c.bodyShade });
  // sablier rouge
  b.set(8, 9, c.mark);
  b.set(7, 10, c.mark);
  b.set(8, 10, c.mark);
  b.set(9, 10, c.mark);
  b.set(8, 11, c.mark);
  // yeux, crocs
  b.set(7, 5, c.eye);
  b.set(9, 5, c.eye);
  b.set(7, 7, c.fang);
  b.set(9, 7, c.fang);
  return b.outline(OUTLINE);
}

function wisp(step: number): Bitmap {
  const c = ENEMY_COLORS.wisp;
  const b = new Bitmap(16, 16);
  const lean = step === 0 ? -1 : 1;
  // flamme : pointe qui oscille
  b.polygon([[5, 8], [8 + lean * 2, 1], [8 + lean, 4], [11, 8]], c.base);
  b.polygon([[6, 8], [8 + lean, 3], [8, 5], [10, 8]], c.hi);
  b.shadedEllipse(8, 9.6, 4.6, 4.6, { hi: c.hi, base: c.base, shade: c.shade });
  // queue ondulée
  b.hline(5, 11, 13, c.shade);
  if (step === 0) {
    b.set(5, 14, c.deep);
    b.set(8, 14, c.deep);
    b.set(11, 14, c.deep);
    b.set(6, 13, c.deep);
    b.set(10, 13, c.deep);
  } else {
    b.set(6, 14, c.deep);
    b.set(9, 14, c.deep);
    b.set(7, 13, c.deep);
    b.set(11, 13, c.deep);
  }
  // visage et cœur lumineux
  b.box(6, 8, 6, 9, c.eye);
  b.box(10, 8, 10, 9, c.eye);
  b.set(8, 11, c.eye);
  b.set(7, 6, c.core);
  b.set(8, 6, c.core);
  return b.outline(OUTLINE);
}

function knight(step: number): Bitmap {
  const c = ENEMY_COLORS.knight;
  const b = new Bitmap(16, 16);
  // plumet magenta
  b.polygon([[6, 3], [4, 1], [9, 1], [11, 3]], c.plume);
  b.hline(5, 9, 2, c.plumeShade);
  // casque, visière
  b.box(5, 3, 10, 8, c.steel);
  b.vline(10, 3, 8, c.steelShade);
  b.hline(5, 10, 8, c.steelShade);
  b.hline(6, 9, 6, c.visor);
  b.hline(5, 10, 5, c.steelDark);
  b.set(5, 3, c.steelLight);
  b.hline(6, 7, 3, c.steelLight);
  // torse + épaulières
  b.box(4, 9, 11, 12, c.steel);
  b.vline(11, 9, 12, c.steelShade);
  b.hline(5, 11, 12, c.steelShade);
  b.hline(4, 5, 9, c.steelLight);
  b.hline(7, 8, 10, c.steelDark);
  b.hline(4, 11, 11, c.steelDark);
  // bouclier doré à gauche (écran), épée à droite
  b.box(0, 8, 4, 13, c.shield);
  b.hline(1, 3, 14, c.shield);
  b.vline(4, 8, 13, c.shieldShade);
  b.hline(0, 4, 13, c.shieldShade);
  b.set(2, 10, c.steelDark);
  b.set(2, 11, c.steelDark);
  b.set(1, 11, c.steelDark);
  b.set(3, 11, c.steelDark);
  b.vline(13, 4, 10, c.steelLight);
  b.vline(14, 5, 10, c.steelShade);
  b.hline(12, 14, 11, c.shield);
  // jambes en alternance
  b.box(5, 13, 7, step === 0 ? 14 : 13, c.steelDark);
  b.box(9, 13, 11, step === 0 ? 13 : 14, c.steelDark);
  return b.outline(OUTLINE);
}

const DRAWERS: Record<(typeof SMALL_ENEMY_KINDS)[number], (step: number) => Bitmap> = {
  slime,
  bat,
  skeleton,
  archer,
  spider,
  wisp,
  knight,
};

/** Frames `enemy_<kind>_<0|1>` des 7 ennemis standards. */
export function buildEnemyFrames(): Record<string, Bitmap> {
  const out: Record<string, Bitmap> = {};
  for (const kind of SMALL_ENEMY_KINDS) {
    out[`enemy_${kind}_0`] = DRAWERS[kind](0);
    out[`enemy_${kind}_1`] = DRAWERS[kind](1);
  }
  return out;
}
