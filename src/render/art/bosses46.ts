/**
 * Demi-boss 32×32 et boss 48×48 des niveaux 4 à 6 (dessinés par code, même technique « calques cerclés » que bosses.ts).
 *
 *  Demi-boss (`miniboss_<kind>_<0|1|hurt>`, 32×32) : warden (gardien de givre), pyromancer (pyromancien), wraith (spectre).
 *  Boss     (`boss_<kind>_<0|1|hurt>`,     48×48) : frostqueen (reine des glaces), forgelord (seigneur de la forge),
 *                                                     voidlord (seigneur du Vide).
 *
 * Toutes les couleurs viennent de palettes.ts (MINIBOSS_COLORS / BOSS_COLORS) ; échelle 1:1, aucun dégradé.
 */
import type { EnemyKind } from '../../core/types';
import { BOSS_COLORS, MINIBOSS_COLORS, OUTLINE } from '../palettes';
import { Bitmap, hash2 } from './bitmap';
import { layer, toHurt } from './bosses';

export const MINIBOSS_KINDS = ['warden', 'pyromancer', 'wraith'] as const satisfies readonly EnemyKind[];
export const BOSS46_KINDS = ['frostqueen', 'forgelord', 'voidlord'] as const satisfies readonly EnemyKind[];

// ───────────────────────────── Gardien de givre (32×32) ─────────────────────────────

function warden(step: number): Bitmap {
  const c = MINIBOSS_COLORS.warden;
  const out = new Bitmap(32, 32);
  const dy = step === 1 ? 1 : 0;
  const ice = { hi: c.iceHi, base: c.ice, shade: c.iceShade };
  const steel = { hi: c.ice, base: c.steel, shade: c.steelShade };
  // jambes
  layer(out, c.iceDeep, (b) => {
    b.box(9, 24, 14, 29 - (step === 1 ? 1 : 0), c.steelShade);
    b.box(18, 24, 23, 29 - (step === 0 ? 1 : 0), c.steelShade);
    b.hline(9, 14, 24, c.steel);
    b.hline(18, 23, 24, c.steel);
    b.hline(8, 14, 29 - (step === 1 ? 1 : 0), c.iceShade);
    b.hline(18, 24, 29 - (step === 0 ? 1 : 0), c.iceShade);
  });
  // torse cuirassé
  layer(out, c.iceDeep, (b) => {
    b.polygon([[8, 12 + dy], [24, 12 + dy], [22, 25], [10, 25]], c.ice);
    b.polygon([[8, 12 + dy], [14, 12 + dy], [13, 25], [10, 25]], c.iceHi);
    b.polygon([[24, 12 + dy], [20, 12 + dy], [20, 25], [22, 25]], c.iceShade);
    b.hline(10, 22, 22, c.iceShade);
    // gemme glacée au plastron
    b.shadedEllipse(16, 18 + dy, 2.6, 3, { hi: c.glowHi, base: c.glow, shade: c.iceShade });
  });
  // épaulières hérissées de pointes de glace
  for (const side of [-1, 1] as const) {
    const sx = side === -1 ? 7 : 25;
    layer(out, c.iceDeep, (b) => {
      b.polygon([[sx - 3, 11 + dy], [sx + side * 1, 4 + dy], [sx + 3, 11 + dy]], c.iceHi);
      b.polygon([[sx - 3, 11 + dy], [sx + side * 1, 4 + dy], [sx, 11 + dy]], c.glowHi);
      b.shadedEllipse(sx, 14 + dy, 4.6, 3.6, steel);
      b.hline(sx - 3, sx + 3, 12 + dy, c.iceHi);
    });
  }
  // heaume à cornes de glace, yeux luisants
  layer(out, c.iceDeep, (b) => {
    b.polygon([[11, 7 + dy], [8, 1 + dy], [13, 4 + dy]], c.iceHi);
    b.polygon([[21, 7 + dy], [24, 1 + dy], [19, 4 + dy]], c.iceHi);
    b.shadedEllipse(16, 8 + dy, 6, 5.6, steel);
    b.box(11, 8 + dy, 21, 10 + dy, c.iceDeep);
    b.box(12, 9 + dy, 14, 9 + dy, c.glow);
    b.box(18, 9 + dy, 20, 9 + dy, c.glow);
    b.set(13, 9 + dy, c.glowHi);
    b.set(19, 9 + dy, c.glowHi);
    b.hline(13, 19, 12 + dy, c.steelShade);
    b.hline(14, 18, 4 + dy, c.iceHi);
  });
  // bouclier de givre (gauche)
  layer(out, c.iceDeep, (b) => {
    b.polygon([[1, 14 + dy], [8, 14 + dy], [8, 24 + dy], [4.5, 28 + dy], [1, 24 + dy]], c.iceShade);
    b.polygon([[2, 15 + dy], [7, 15 + dy], [7, 23 + dy], [4.5, 26 + dy], [2, 23 + dy]], c.ice);
    b.polygon([[2, 15 + dy], [4.5, 15 + dy], [4.5, 26 + dy], [2, 23 + dy]], c.iceHi);
    b.set(5, 19 + dy, c.glow);
    b.set(4, 20 + dy, c.glowHi);
    b.set(5, 21 + dy, c.glow);
  });
  // marteau de glace (droite) : se lève sur la frame 1
  const hy = step === 1 ? -3 : 0;
  layer(out, c.iceDeep, (b) => {
    b.vline(26, 10 + hy + dy, 29, c.steelShade);
    b.vline(27, 10 + hy + dy, 29, c.steel);
    b.box(23, 5 + hy + dy, 29, 11 + hy + dy, c.ice);
    b.box(23, 5 + hy + dy, 29, 6 + hy + dy, c.iceHi);
    b.box(23, 10 + hy + dy, 29, 11 + hy + dy, c.iceShade);
    b.set(26, 8 + hy + dy, c.glow);
    b.set(27, 8 + hy + dy, c.glowHi);
  });
  return out.outline(OUTLINE);
}

// ───────────────────────────── Pyromancien (32×32) ─────────────────────────────

function pyromancer(step: number): Bitmap {
  const c = MINIBOSS_COLORS.pyromancer;
  const out = new Bitmap(32, 32);
  const sway = step === 1 ? 1 : 0;
  const bob = step === 1 ? -2 : 0;
  // robe évasée
  layer(out, c.robeDeep, (b) => {
    b.polygon([[10, 13], [22, 13], [27 + sway, 30], [5 - sway, 30]], c.robe);
    b.polygon([[10, 13], [14, 13], [11 - sway, 30], [5 - sway, 30]], c.robeHi);
    b.polygon([[22, 13], [19, 13], [21 + sway, 30], [27 + sway, 30]], c.robeShade);
    b.line(16, 20, 15, 30, c.robeShade);
    b.hline(11, 21, 20, c.gold);
    b.set(16, 20, c.fireHi);
    b.hline(5 - sway, 27 + sway, 29, c.fireDeep);
    for (const x of [8, 13, 18, 23]) b.set(x + sway, 30, c.robeDeep);
  });
  // capuche pointue, visage d'ombre aux yeux de braise
  layer(out, c.robeDeep, (b) => {
    b.polygon([[10, 9], [16, 0.6], [22, 9]], c.robe);
    b.polygon([[10, 9], [16, 0.6], [14, 9]], c.robeHi);
    b.shadedEllipse(16, 9, 6.4, 5.6, { hi: c.robeHi, base: c.robe, shade: c.robeShade });
    b.ellipse(16, 10, 3.9, 3.7, c.face);
    b.box(13, 9, 14, 10, c.fire);
    b.box(18, 9, 19, 10, c.fire);
    b.set(13, 9, c.fireHi);
    b.set(18, 9, c.fireHi);
    b.hline(14, 18, 13, c.robeShade);
  });
  // bâton (droite) surmonté d'une flamme
  layer(out, c.robeDeep, (b) => {
    b.vline(26, 8, 30, c.staff);
    b.vline(27, 8, 30, c.staffShade);
    b.hline(25, 28, 12, c.gold);
    b.polygon([[23.6, 7], [26.5, 0.6 + (step === 1 ? 1 : 0)], [29.4, 7]], c.fireDeep);
    b.polygon([[24.6, 7], [26.5, 2.4 + (step === 1 ? 1 : 0)], [28.4, 7]], c.fire);
    b.shadedEllipse(26.5, 6.4, 2.8, 2.8, { hi: c.fireHi, base: c.fire, shade: c.fireDeep });
  });
  // boule de feu tenue à gauche
  layer(out, c.robeDeep, (b) => {
    b.box(8, 16 + bob + 4, 10, 18 + bob + 4, c.robeShade);
    b.polygon([[3, 14 + bob], [6, 8 + bob], [9, 14 + bob]], c.fireDeep);
    b.polygon([[4.4, 14 + bob], [6, 10 + bob], [7.6, 14 + bob]], c.fire);
    b.shadedEllipse(6, 16 + bob, 3.6, 3.6, { hi: c.fireHi, base: c.fire, shade: c.fireDeep });
  });
  return out.outline(OUTLINE);
}

// ───────────────────────────── Spectre (32×32) ─────────────────────────────

function wraith(step: number): Bitmap {
  const c = MINIBOSS_COLORS.wraith;
  const out = new Bitmap(32, 32);
  const dy = step === 1 ? 1 : 0;
  const t = step === 1 ? 1 : 0;
  // manteau en lambeaux, flottant
  layer(out, c.cloakDeep, (b) => {
    b.polygon(
      [[9, 11 + dy], [23, 11 + dy], [27, 26 + dy], [23, 24 + dy], [21, 30 - t], [18, 25 + dy], [16, 30 + t], [13, 25 + dy], [10, 30 - t], [8, 24 + dy], [5, 26 + dy]],
      c.cloak,
    );
    b.polygon([[9, 11 + dy], [13, 11 + dy], [10, 28 + dy], [5, 26 + dy]], c.cloakHi);
    b.polygon([[23, 11 + dy], [20, 11 + dy], [22, 27 + dy], [27, 26 + dy]], c.cloakShade);
    b.line(16, 18 + dy, 15, 26 + dy, c.cloakShade);
    b.line(12, 16 + dy, 11, 22 + dy, c.cloakShade);
  });
  // capuche creuse, regard spectral
  layer(out, c.cloakDeep, (b) => {
    b.shadedEllipse(16, 9 + dy, 7, 6.8, { hi: c.cloakHi, base: c.cloak, shade: c.cloakShade });
    b.polygon([[11, 5 + dy], [16, 0.6 + dy], [21, 5 + dy]], c.cloak);
    b.ellipse(16, 10 + dy, 4.4, 4.4, c.cloakDeep);
    b.box(12, 9 + dy, 14, 10 + dy, c.eye);
    b.box(18, 9 + dy, 20, 10 + dy, c.eye);
    b.set(12, 10 + dy, c.eyeDeep);
    b.set(20, 10 + dy, c.eyeDeep);
    b.set(16, 13 + dy, c.eyeDeep);
  });
  // faux (droite) tenue par une main d'os
  layer(out, c.cloakDeep, (b) => {
    b.vline(27, 3 + dy, 28 + dy, c.boneShade);
    b.polygon([[27, 2 + dy], [21, 1 + dy], [16, 5 + dy], [22, 4 + dy], [27, 7 + dy]], c.bone);
    b.polygon([[27, 2 + dy], [21, 1 + dy], [24, 4 + dy], [27, 5 + dy]], c.boneShade);
    b.box(25, 16 + dy, 28, 18 + dy, c.bone);
    b.set(25, 19 + dy, c.boneShade);
    b.set(27, 19 + dy, c.boneShade);
  });
  // main d'os gauche, doigts crochus
  layer(out, c.cloakDeep, (b) => {
    b.box(4, 17 + dy, 7, 18 + dy, c.bone);
    b.set(3, 19 + dy, c.bone);
    b.set(5, 19 + dy, c.bone);
    b.set(7, 19 + dy, c.boneShade);
    b.set(4, 20 + dy, c.boneShade);
  });
  return out.outline(OUTLINE);
}

// ───────────────────────────── Reine des glaces (48×48) ─────────────────────────────

function frostqueen(step: number): Bitmap {
  const c = BOSS_COLORS.frostqueen;
  const out = new Bitmap(48, 48);
  const sway = step === 1 ? 2 : 0;
  const dy = step === 1 ? 1 : 0;
  // cape de givre déployée
  layer(out, c.capeDeep, (b) => {
    b.polygon([[13, 15], [35, 15], [44 + sway, 46], [4 - sway, 46]], c.cape);
    b.polygon([[13, 15], [18, 15], [10 - sway, 46], [4 - sway, 46]], c.gownShade);
    b.line(24, 22, 24, 46, c.capeDeep);
    b.line(24, 30, 36 + sway, 46, c.capeDeep);
    b.line(24, 30, 12 - sway, 46, c.capeDeep);
  });
  // robe de givre, frange de cristaux
  layer(out, c.gownDeep, (b) => {
    b.polygon([[17, 20 + dy], [31, 20 + dy], [37 + sway, 46], [11 - sway, 46]], c.gown);
    b.polygon([[17, 20 + dy], [22, 20 + dy], [19 - sway, 46], [11 - sway, 46]], c.gownHi);
    b.polygon([[31, 20 + dy], [28, 20 + dy], [30 + sway, 46], [37 + sway, 46]], c.gownShade);
    for (const x of [13, 18, 23, 28, 33]) {
      const xx = x + (x > 24 ? sway : -sway);
      b.polygon([[xx - 2, 44], [xx, 47], [xx + 2, 44]], c.gownHi);
    }
    // ceinture + gemme
    b.box(18, 29, 30, 31, c.gownDeep);
    b.hline(18, 30, 29, c.crownShade);
    b.box(22, 28, 26, 32, c.crown);
    b.box(23, 29, 25, 31, c.crownHi);
  });
  // buste
  layer(out, c.gownDeep, (b) => {
    b.polygon([[18, 16 + dy], [30, 16 + dy], [31, 29], [17, 29]], c.gown);
    b.polygon([[18, 16 + dy], [24, 16 + dy], [24, 29], [17, 29]], c.gownHi);
    b.line(24, 17 + dy, 24, 27, c.gownShade);
    b.hline(19, 29, 24, c.gownShade);
  });
  // épaulières d'éclats de glace
  for (const side of [-1, 1] as const) {
    const sx = side === -1 ? 14 : 34;
    layer(out, c.gownDeep, (b) => {
      b.polygon([[sx - 3, 18 + dy], [sx + side * 2, 9 + dy], [sx + 3, 18 + dy]], c.crown);
      b.polygon([[sx - 3, 18 + dy], [sx + side * 2, 9 + dy], [sx, 18 + dy]], c.crownHi);
      b.shadedEllipse(sx, 20 + dy, 5, 3.6, { hi: c.gownHi, base: c.gown, shade: c.gownShade });
    });
  }
  // longs cheveux de givre + visage + couronne
  layer(out, c.gownDeep, (b) => {
    b.polygon([[17, 8 + dy], [31, 8 + dy], [33, 26], [15, 26]], c.gownShade);
    b.polygon([[17, 8 + dy], [21, 8 + dy], [18, 26], [15, 26]], c.gown);
  });
  layer(out, c.gownDeep, (b) => {
    b.ellipse(24, 12 + dy, 5.4, 6.2, c.skin);
    b.polygon([[24, 6 + dy], [29, 10 + dy], [28, 17 + dy], [24, 18 + dy]], c.skinShade);
    b.ellipse(24, 12 + dy, 4.2, 5.6, c.skin);
    b.box(21, 11 + dy, 22, 12 + dy, c.eye);
    b.box(26, 11 + dy, 27, 12 + dy, c.eye);
    b.set(21, 11 + dy, c.crownHi);
    b.set(26, 11 + dy, c.crownHi);
    b.hline(23, 25, 15 + dy, c.skinShade);
    // couronne d'éclats
    b.hline(19, 29, 6 + dy, c.crownShade);
    b.hline(19, 29, 5 + dy, c.crown);
    b.polygon([[19, 5 + dy], [19.5, 0.6 + dy], [22, 5 + dy]], c.crown);
    b.polygon([[22.5, 5 + dy], [24, 0.2 + dy], [25.5, 5 + dy]], c.crownHi);
    b.polygon([[26, 5 + dy], [28.5, 0.6 + dy], [29, 5 + dy]], c.crown);
  });
  // sceptre de cristal (droite)
  layer(out, c.gownDeep, (b) => {
    b.vline(41, 11, 45, c.gownShade);
    b.vline(42, 11, 45, c.gownDeep);
    const top = 7 + dy;
    b.polygon([[41.5, top - 6], [45, top], [41.5, top + 6], [38, top]], c.crown);
    b.polygon([[41.5, top - 6], [38, top], [41.5, top + 6]], c.crownHi);
    b.polygon([[41.5, top - 6], [45, top], [41.5, top + 6]], c.crownShade);
    b.box(39, 24 + dy, 43, 26 + dy, c.skinShade);
  });
  // orbe de glace (gauche) qui flotte
  layer(out, c.gownDeep, (b) => {
    const oy = 27 - (step === 1 ? 2 : 0);
    b.shadedEllipse(7, oy, 4.4, 4.4, { hi: c.crownHi, base: c.crown, shade: c.crownShade });
    b.set(5, oy - 1, c.crownHi);
    b.set(8, oy + 2, c.gownDeep);
    b.box(6, oy + 5, 8, oy + 7, c.skinShade);
  });
  return out.outline(OUTLINE);
}

// ───────────────────────────── Seigneur de la forge (48×48) ─────────────────────────────

function forgelord(step: number): Bitmap {
  const c = BOSS_COLORS.forgelord;
  const out = new Bitmap(48, 48);
  const dy = step === 1 ? 1 : 0;
  const iron = { hi: c.ironHi, base: c.iron, shade: c.ironShade };
  // jambes massives
  layer(out, c.ironDeep, (b) => {
    b.shadedEllipse(18, 40, 5.8, 6.6, iron);
    b.shadedEllipse(30, 40, 5.8, 6.6, iron);
    b.box(12, 44, 22, 46, c.ironShade);
    b.box(26, 44, 36, 46, c.ironShade);
    b.hline(12, 22, 44, c.ironHi);
    b.hline(26, 36, 44, c.ironHi);
    b.set(18, 40, c.lavaDeep);
    b.set(30, 40, c.lavaDeep);
  });
  // torse large, cœur de lave
  layer(out, c.ironDeep, (b) => {
    b.polygon([[9, 16 + dy], [39, 16 + dy], [35, 38], [13, 38]], c.iron);
    b.polygon([[9, 16 + dy], [17, 16 + dy], [16, 38], [13, 38]], c.ironHi);
    b.polygon([[39, 16 + dy], [33, 16 + dy], [33, 38], [35, 38]], c.ironShade);
    // fissures de lave
    b.line(19, 19 + dy, 22, 24 + dy, c.lavaDeep);
    b.line(29, 20 + dy, 26, 25 + dy, c.lavaDeep);
    b.line(20, 33, 24, 30, c.lavaDeep);
    b.line(28, 33, 24, 30, c.lavaDeep);
    b.shadedEllipse(24, 26 + dy, 4.4, 4.8, { hi: c.lavaHi, base: c.lava, shade: c.lavaDeep });
    // ceinture de forge
    b.box(13, 34, 35, 36, c.ironShade);
    b.hline(13, 35, 34, c.lava);
    b.hline(13, 35, 35, c.lavaDeep);
    b.set(24, 35, c.lavaHi);
  });
  // épaulières hérissées
  for (const side of [-1, 1] as const) {
    const sx = side === -1 ? 8 : 40;
    layer(out, c.ironDeep, (b) => {
      b.shadedEllipse(sx, 19 + dy, 6.6, 5, iron);
      b.polygon([[sx - 4, 15 + dy], [sx + side * 1, 7 + dy], [sx + 4, 15 + dy]], c.iron);
      b.polygon([[sx - 4, 15 + dy], [sx + side * 1, 7 + dy], [sx, 15 + dy]], c.ironHi);
      b.set(sx, 20 + dy, c.lava);
    });
  }
  // casque à cornes, visière de braise
  layer(out, c.ironDeep, (b) => {
    b.polygon([[18, 9 + dy], [11, 8 + dy], [8, 1 + dy], [13, 5 + dy], [18, 6 + dy]], c.horn);
    b.polygon([[30, 9 + dy], [37, 8 + dy], [40, 1 + dy], [35, 5 + dy], [30, 6 + dy]], c.horn);
    b.polygon([[18, 9 + dy], [11, 8 + dy], [9, 3 + dy], [14, 7 + dy]], c.hornShade);
    b.polygon([[30, 9 + dy], [37, 8 + dy], [39, 3 + dy], [34, 7 + dy]], c.hornShade);
    b.shadedEllipse(24, 11 + dy, 7.4, 6.8, iron);
    b.box(18, 10 + dy, 30, 13 + dy, c.ironDeep);
    b.box(19, 11 + dy, 22, 12 + dy, c.lava);
    b.box(26, 11 + dy, 29, 12 + dy, c.lava);
    b.set(20, 11 + dy, c.lavaHi);
    b.set(27, 11 + dy, c.lavaHi);
    b.hline(21, 27, 15 + dy, c.ironShade);
  });
  // bras gauche + poing
  layer(out, c.ironDeep, (b) => {
    b.shadedEllipse(5, 29 + dy, 3.4, 7, iron);
    b.shadedEllipse(5, 38, 4.4, 3.4, { hi: c.steelHi, base: c.steel, shade: c.ironShade });
    b.set(5, 38, c.lavaDeep);
  });
  // marteau de forge (droite) : se lève sur la frame 1
  const hy = step === 1 ? -3 : 0;
  layer(out, c.ironDeep, (b) => {
    b.vline(42, 10 + hy, 41, c.ironShade);
    b.vline(43, 10 + hy, 41, c.iron);
    b.box(36, 2 + hy, 45, 10 + hy, c.steel);
    b.box(36, 2 + hy, 45, 3 + hy, c.steelHi);
    b.box(36, 9 + hy, 45, 10 + hy, c.ironShade);
    b.hline(37, 44, 6 + hy, c.lava);
    b.set(41, 6 + hy, c.lavaHi);
    b.set(42, 6 + hy, c.lavaHi);
    b.box(40, 24 + dy, 45, 27 + dy, c.ironShade);
  });
  return out.outline(OUTLINE);
}

// ───────────────────────────── Seigneur du Vide (48×48) ─────────────────────────────

function voidlord(step: number): Bitmap {
  const c = BOSS_COLORS.voidlord;
  const out = new Bitmap(48, 48);
  const sway = step === 1 ? 2 : 0;
  const dy = step === 1 ? 1 : 0;
  // robe étoilée, lambeaux d'abîme
  layer(out, c.robeDeep, (b) => {
    b.polygon([[15, 16 + dy], [33, 16 + dy], [42 + sway, 45], [6 - sway, 45]], c.robe);
    b.polygon([[15, 16 + dy], [21, 16 + dy], [13 - sway, 45], [6 - sway, 45]], c.robeHi);
    b.polygon([[33, 16 + dy], [29, 16 + dy], [34 + sway, 45], [42 + sway, 45]], c.robeShade);
    b.line(24, 24 + dy, 22 - sway, 45, c.robeShade);
    b.line(24, 24 + dy, 28 + sway, 45, c.robeShade);
    for (const x of [8, 14, 20, 26, 32, 38]) b.polygon([[x - 2, 44], [x + (x > 24 ? sway : -sway), 47], [x + 2, 44]], c.robe);
    // champ d'étoiles
    for (let i = 0; i < 40; i++) {
      const x = 8 + Math.floor(hash2(i, 5, 646) * 32);
      const y = 20 + Math.floor(hash2(i, 6, 646) * 24);
      if (b.get(x, y) === c.robe || b.get(x, y) === c.robeShade) b.set(x, y, i % 5 === 0 ? c.starGold : c.star);
    }
  });
  // éclats d'épaules
  for (const side of [-1, 1] as const) {
    const sx = side === -1 ? 13 : 35;
    layer(out, c.robeDeep, (b) => {
      b.polygon([[sx - 3, 20 + dy], [sx + side * 4, 9 + dy], [sx + 3, 19 + dy]], c.shard);
      b.polygon([[sx - 3, 20 + dy], [sx + side * 4, 9 + dy], [sx, 19 + dy]], c.coreHi);
      b.shadedEllipse(sx, 21 + dy, 5, 3.6, { hi: c.robeHi, base: c.robe, shade: c.robeShade });
    });
  }
  // couronne d'éclats orbitaux
  layer(out, c.robeDeep, (b) => {
    for (const [x, h, w] of [[16, 5, 2], [20, 8, 2], [24, 9, 2], [28, 8, 2], [32, 5, 2]] as const) {
      b.polygon([[x - w, 9 + dy], [x, 9 - h + dy], [x + w, 9 + dy]], x === 24 ? c.coreHi : c.shard);
    }
  });
  // capuche et œil unique
  layer(out, c.robeDeep, (b) => {
    b.shadedEllipse(24, 13 + dy, 8, 7.4, { hi: c.robeHi, base: c.robe, shade: c.robeShade });
    b.ellipse(24, 14 + dy, 5.4, 5, c.robeDeep);
    b.ellipse(24, 14 + dy, 4.2, 3, c.coreHi);
    b.ellipse(24, 14 + dy, 2.4, 2.4, c.core);
    b.set(24, 14 + dy, c.robeDeep);
    b.set(23, 13 + dy, c.coreHi);
    b.hline(21, 27, 17 + dy, c.robeShade);
  });
  // mains levées portant des orbes
  for (const side of [-1, 1] as const) {
    const ox = side === -1 ? 6 : 42;
    layer(out, c.robeDeep, (b) => {
      const oy = 29 - (step === (side === -1 ? 1 : 0) ? 3 : 0);
      b.shadedEllipse(ox, oy, 4.6, 4.6, { hi: c.coreHi, base: c.core, shade: c.coreShade });
      b.set(ox - 1, oy - 1, c.star);
      b.box(ox - 1, oy + 5, ox + 1, oy + 7, c.robeShade);
      // éclats en orbite
      b.polygon([[ox + side * 1, oy - 10], [ox + side * 1 + 2, oy - 8], [ox + side * 1, oy - 6], [ox + side * 1 - 2, oy - 8]], c.shard);
    });
  }
  return out.outline(OUTLINE);
}

const MINI_DRAW: Record<(typeof MINIBOSS_KINDS)[number], (step: number) => Bitmap> = { warden, pyromancer, wraith };
const BOSS_DRAW: Record<(typeof BOSS46_KINDS)[number], (step: number) => Bitmap> = { frostqueen, forgelord, voidlord };

/** Frames `miniboss_<kind>_<0|1|hurt>` (32×32) et `boss_<kind>_<0|1|hurt>` (48×48) des niveaux 4-6. */
export function buildBoss46Frames(): Record<string, Bitmap> {
  const out: Record<string, Bitmap> = {};
  for (const kind of MINIBOSS_KINDS) {
    const f0 = MINI_DRAW[kind](0);
    out[`miniboss_${kind}_0`] = f0;
    out[`miniboss_${kind}_1`] = MINI_DRAW[kind](1);
    out[`miniboss_${kind}_hurt`] = toHurt(f0);
  }
  for (const kind of BOSS46_KINDS) {
    const f0 = BOSS_DRAW[kind](0);
    out[`boss_${kind}_0`] = f0;
    out[`boss_${kind}_1`] = BOSS_DRAW[kind](1);
    out[`boss_${kind}_hurt`] = toHurt(f0);
  }
  return out;
}
