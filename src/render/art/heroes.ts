/**
 * Héros jouables : 8 personnages × (4 directions × 2 frames de marche + attaque) + frame « à terre ».
 * Tout est dessiné par code (gabarit corps 16×16 paramétré, voir heroKit.ts + accessoires de classe),
 * contour auto 1 px.
 *
 * Silhouettes volontairement exagérées pour rester lisibles à zoom 2 :
 *  david = casque à plumet rouge + épée + bouclier     sandrine = grand chapeau pointu + robe + bâton à orbe
 *  romain = petit, capuche pointue verte + lame        valentine = cape claire évasée + cheveux blonds + arc doré
 *  aelith = oreilles d'elfe + grand arc + natte        brokk = nain trapu à grande barbe + casque à cornes + hache
 *  grok = troll massif vert + massue cloutée           mira = capuche sombre, écharpe cramoisie, deux dagues
 *
 * La direction 'left' est le miroir de 'right'.
 */
import type { CharacterId, Dir } from '../../core/types';
import { EYE, HERO_COLORS, OUTLINE } from '../palettes';
import { Bitmap, CLEAR } from './bitmap';
import {
  AXE, BLADE, CLUB, DAGGER, Humanoid, SHIELD, STAFF, SWORD,
  bowBitmap, weapon, weaponPose,
  type Build, type HeroPose, type HeroView,
} from './heroKit';

export type { HeroPose, HeroView } from './heroKit';

export const HERO_IDS: readonly CharacterId[] = ['david', 'sandrine', 'romain', 'valentine', 'aelith', 'brokk', 'grok', 'mira'];
export const HERO_DIRS: readonly Dir[] = ['down', 'up', 'left', 'right'];

type HeroDraw = (h: Humanoid) => void;

// ───────────────────────────── David : guerrier ─────────────────────────────

const david: HeroDraw = (h) => {
  const { col, view } = h;
  const sword = weaponPose(h, 1, 0);
  if (view === 'up') weapon(h, SWORD, [2, 7], sword.k, sword.at);
  h.legs();
  h.torso();
  if (view !== 'right') {
    // tabard bleu, ceinture dorée, épaulières
    h.box(7, h.ty0 + 1, 8, h.ty1, col.cloak);
    h.put(7, h.ty1 + 1, col.cloak);
    h.put(8, h.ty1 + 1, col.cloakShade);
    h.hline(h.tx0, h.tx1, h.ty1 - 1, col.trim);
    if (view === 'down') h.put(7, h.ty1 - 1, col.trimShade);
    h.put(h.tx0, h.ty0, col.metal);
    h.put(h.tx1, h.ty0, col.metalShade);
  } else {
    h.box(h.tx0, h.ty0 + 1, h.tx1, h.ty1 - 2, col.cloak);
    h.hline(h.tx0, h.tx1, h.ty1 - 1, col.trim);
    h.put(h.cx, h.ty0, col.metal);
  }
  h.arms(col.main, col.skin);
  h.face();
  const { hx0, hx1, hy0, hy1 } = h;
  if (view === 'down') {
    // casque : dôme, joues, nasal, plumet
    h.hline(hx0, hx1, hy0, col.metal);
    h.hline(hx0, hx1, hy0 + 1, col.metal);
    h.hline(hx0, hx1, hy0 + 2, col.metalShade);
    h.vline(hx0, hy0 + 2, hy0 + 4, col.metalShade);
    h.vline(hx1, hy0 + 2, hy0 + 4, col.metalShade);
    h.vline(7, hy0 + 2, hy0 + 3, col.metal);
    h.vline(8, hy0 + 2, hy0 + 3, col.metalShade);
    h.clear(hx0, hy0);
    h.clear(hx1, hy0);
    h.put(hx0 + 1, hy0, col.metalShade);
    h.hline(hx0 + 2, hx1 - 2, hy0 - 1, col.glow);
    h.hline(hx0 + 3, hx1 - 3, hy0, col.glowShade);
  } else if (view === 'up') {
    h.box(hx0, hy0, hx1, hy1 - 1, col.metal);
    h.clear(hx0, hy0);
    h.clear(hx1, hy0);
    h.hline(hx0, hx1, hy1 - 1, col.metalShade);
    h.hline(hx0 + 1, hx1 - 1, hy1, col.skinShade);
    h.vline(7, hy0 - 1, hy1 - 1, col.glow);
    h.vline(8, hy0 - 1, hy1 - 1, col.glowShade);
  } else {
    h.box(hx0, hy0, hx1 - 1, hy0 + 1, col.metal);
    h.box(hx0, hy0 + 2, hx0 + 2, hy0 + 4, col.metalShade);
    h.hline(hx1 - 3, hx1 - 1, hy0 + 2, col.metalShade);
    h.clear(hx0, hy0);
    h.hline(hx0 + 1, hx1 - 2, hy0 - 1, col.glow);
    h.hline(hx0, hx0 + 2, hy0, col.glowShade);
    h.put(hx0 - 1, hy0 + 1, col.glow);
  }
  if (view === 'down') h.c.stamp(SHIELD, h.L, 1, h.ty0);
  if (view === 'up') h.c.stamp(SHIELD, h.L, 11, h.ty0);
  if (view !== 'up') weapon(h, SWORD, [2, 7], sword.k, sword.at);
};

// ───────────────────────────── Sandrine : magicienne ─────────────────────────────

const sandrine: HeroDraw = (h) => {
  const { col, view } = h;
  const staff = weaponPose(h, 1, 1);
  if (view === 'up') weapon(h, STAFF, [2, 8], staff.k, [staff.at[0], staff.at[1] + 1]);
  const sk = h.step;
  // robe évasée (remplace les jambes) + pieds qui dépassent en alternance
  if (view === 'right') {
    h.box(5, h.ty0, 9, h.ty1, col.main);
    h.vline(9, h.ty0 + 1, h.ty1, col.mainShade);
    h.hline(5, 9, 11, col.trim);
    h.hline(4, 10, 12, col.main);
    h.hline(4, 10, 13, col.main);
    h.hline(3, 10, 14, col.trim);
    h.put(sk === 0 ? 10 : 9, 14, col.boots);
    h.put(sk === 0 ? 11 : 10, 14, col.boots);
  } else {
    h.box(h.tx0, h.ty0, h.tx1, h.ty1, col.main);
    h.vline(h.tx1, h.ty0 + 1, h.ty1, col.mainShade);
    h.hline(4, 11, 12, col.main);
    h.hline(3, 12, 13, col.main);
    h.vline(11, 12, 13, col.mainShade);
    h.put(12, 13, col.mainShade);
    h.hline(3, 12, 14, col.trim);
    // pied avancé (rangée 14) et pied levé (rangée 13 de face, caché de dos)
    h.hline(sk === 0 ? 5 : 9, sk === 0 ? 6 : 10, 14, col.boots);
    if (view === 'down') h.hline(sk === 0 ? 9 : 5, sk === 0 ? 10 : 6, 13, col.boots);
    if (view === 'down') {
      h.hline(h.tx0 + 1, h.tx1 - 1, h.ty0 + 2, col.trim);
      h.hline(7, 8, h.ty0, col.skin);
      h.hline(7, 8, h.ty0 + 1, col.trim);
    }
  }
  h.arms(col.cloak, col.skin);
  const { hx0, hx1, hy0 } = h;
  if (view === 'right') {
    h.box(hx0, hy0 + 1, hx0 + 2, h.ty1 + 1, col.hair);
    h.vline(hx0, hy0 + 3, h.ty1 + 1, col.hairShade);
  }
  h.face();
  if (view === 'down') {
    h.hline(hx0 + 1, hx1 - 1, hy0, col.hair);
    h.vline(hx0, hy0, h.ty1 + 1, col.hair);
    h.vline(hx0 + 1, hy0 + 1, h.ty1 - 1, col.hair);
    h.vline(hx1, hy0, h.ty1 + 1, col.hair);
    h.vline(hx1 - 1, hy0 + 1, h.ty1 - 1, col.hair);
    h.vline(hx0, h.ty0 + 1, h.ty1 + 1, col.hairShade);
    h.vline(hx1, h.ty0 + 1, h.ty1 + 1, col.hairShade);
  } else if (view === 'up') {
    h.box(hx0, hy0, hx1, h.ty1 + 1, col.hair);
    h.clear(hx0, hy0);
    h.clear(hx1, hy0);
    h.vline(hx1, hy0 + 2, h.ty1 + 1, col.hairShade);
    h.hline(hx0 + 1, hx1 - 1, h.ty1 + 1, col.hairShade);
  } else {
    h.hline(hx0 + 1, hx1 - 1, hy0, col.hair);
  }
  // grand chapeau pointu : pointe courbée, bandeau doré, large bord
  h.hline(7, 9, hy0 - 3, col.cloak);
  h.hline(6, 9, hy0 - 2, col.cloak);
  h.put(10, hy0 - 2, col.cloakShade);
  h.put(4, hy0 - 1, col.cloakShade);
  h.hline(5, 10, hy0 - 1, col.trim);
  h.put(11, hy0 - 1, col.cloakShade);
  h.hline(3, 9, hy0, col.cloak);
  h.hline(10, 12, hy0, col.cloakShade);
  if (view !== 'up') weapon(h, STAFF, [2, 8], staff.k, staff.at);
};

// ───────────────────────────── Romain : éclaireur ─────────────────────────────

const romain: HeroDraw = (h) => {
  const { col, view } = h;
  const blade = weaponPose(h, 1, 1);
  if (view === 'up') weapon(h, BLADE, [0, 4], blade.k, blade.at);
  h.legs();
  h.torso();
  h.hline(h.tx0, h.tx1, h.ty1 - 1, col.mainShade);
  h.hline(h.tx0, h.tx1, h.ty0, col.trim); // écharpe
  if (view === 'down') {
    h.put(h.tx1, h.ty0 + 1, col.trimShade);
    h.put(h.tx1, h.ty0 + 2, col.trimShade);
  } else if (view === 'up') {
    h.vline(h.tx0 + 1, h.ty0 + 1, h.ty0 + 3, col.trimShade);
  } else {
    h.vline(h.tx0, h.ty0 + 1, h.ty0 + 3, col.trimShade);
    h.put(h.tx0 - 1, h.ty0 + 2, col.trim);
  }
  h.arms(col.main, col.skin);
  const { hx0, hx1, hy0, hy1 } = h;
  h.face();
  // capuche verte pointue
  if (view === 'down') {
    h.box(hx0, hy0, hx1, hy0 + 2, col.cloak);
    h.vline(hx0, hy0 + 3, hy0 + 4, col.cloakShade);
    h.vline(hx1, hy0 + 3, hy0 + 4, col.cloakShade);
    h.hline(hx0 + 1, hx1 - 1, hy0 + 2, col.cloakShade);
    h.hline(hx0 + 2, hx1 - 2, hy0 + 1, col.cloak);
    h.clear(hx0, hy0);
    h.clear(hx1, hy0);
    h.hline(6, 9, hy0 - 1, col.cloak);
    h.hline(8, 10, hy0 - 2, col.cloak);
    h.put(11, hy0 - 2, col.cloakShade);
    h.put(9, hy0 - 1, col.cloakShade);
    h.put(hx0 + 1, hy0 + 2, col.hair);
    h.put(hx1 - 1, hy0 + 2, col.hair);
  } else if (view === 'up') {
    h.box(hx0, hy0, hx1, hy1, col.cloak);
    h.clear(hx0, hy0);
    h.clear(hx1, hy0);
    h.hline(hx0 + 1, hx1 - 1, hy1, col.cloakShade);
    h.hline(hx0, hx1, hy1 - 1, col.cloakShade);
    h.vline(hx1, hy0 + 1, hy1, col.cloakShade);
    h.hline(6, 9, hy0 - 1, col.cloak);
    h.hline(8, 10, hy0 - 2, col.cloak);
    h.put(11, hy0 - 2, col.cloakShade);
  } else {
    h.box(hx0, hy0, hx1 - 1, hy0 + 2, col.cloak);
    h.box(hx0, hy0 + 3, hx0 + 2, hy1, col.cloak);
    h.vline(hx0, hy0 + 3, hy1, col.cloakShade);
    h.hline(hx1 - 3, hx1 - 1, hy0 + 2, col.cloakShade);
    h.clear(hx0, hy0);
    h.hline(hx0 + 2, hx1 - 1, hy0 - 1, col.cloak);
    h.hline(hx1 - 1, hx1 + 1, hy0 - 2, col.cloak);
    h.put(hx1 + 2, hy0 - 2, col.cloakShade);
    h.put(hx0 - 1, hy0 + 3, col.cloak);
  }
  if (view !== 'up') weapon(h, BLADE, [0, 4], blade.k, blade.at);
};

// ───────────────────────────── Valentine : guérisseuse-archère ─────────────────────────────

const valentine: HeroDraw = (h) => {
  const { col, view } = h;
  const bow = bowBitmap(10, 2, col.wood, col.woodShade, col.trim, col.metal);
  // cape claire évasée derrière le corps, liseré doré
  if (view === 'down') {
    h.box(3, h.ty0, 12, 10, col.cloak);
    h.box(2, 11, 13, 13, col.cloak);
    h.vline(3, h.ty0 + 1, 10, col.trim);
    h.vline(12, h.ty0 + 1, 10, col.trim);
    h.vline(2, 11, 13, col.trim);
    h.vline(13, 11, 13, col.trim);
    h.hline(2, 13, 13, col.trim);
    h.vline(11, h.ty0, 12, col.cloakShade);
    h.clear(3, h.ty0);
    h.clear(12, h.ty0);
  } else if (view === 'up') {
    h.box(3, h.ty0 - 1, 12, 10, col.cloak);
    h.box(2, 11, 13, 14, col.cloak);
    h.hline(2, 13, 14, col.trim);
    h.vline(2, 11, 14, col.trim);
    h.vline(13, 11, 14, col.trim);
    h.vline(3, h.ty0 + 1, 10, col.trim);
    h.vline(12, h.ty0 + 1, 10, col.trim);
    h.vline(7, h.ty0 + 1, 13, col.cloakShade);
    h.vline(8, h.ty0 + 1, 13, col.cloakShade);
    h.vline(12, h.ty0, 13, col.cloakShade);
  } else {
    h.box(3, h.ty0, 7, 13, col.cloak);
    h.vline(3, h.ty0 + 1, 13, col.trim);
    h.hline(3, 7, 13, col.trim);
    h.vline(7, h.ty0 + 1, 12, col.cloakShade);
  }
  h.legs();
  // robe rose, ceinture dorée, jupe courte
  h.box(h.tx0, h.ty0, h.tx1, h.ty1, col.main);
  h.vline(h.tx1, h.ty0 + 1, h.ty1, col.mainShade);
  h.hline(h.tx0, h.tx1, h.ty1, col.trim);
  h.hline(h.tx0 - 1, h.tx1 + 1, h.ty1 + 1, col.main);
  h.put(h.tx1 + 1, h.ty1 + 1, col.mainShade);
  if (view === 'down') {
    // étoile de soin blanche et dorée sur la poitrine
    h.hline(7, 8, h.ty0 + 1, col.metal);
    h.hline(6, 9, h.ty0 + 2, col.metal);
    h.hline(7, 8, h.ty0 + 2, col.trim);
    h.hline(7, 8, h.ty0 + 3, col.metal);
  }
  h.arms(col.main, col.skin);
  const { hx0, hx1, hy0 } = h;
  if (view === 'right') {
    h.box(hx0 - 1, hy0 + 1, hx0 + 2, h.ty0 + 1, col.hair);
    h.vline(hx0 - 1, hy0 + 3, h.ty0 + 1, col.hairShade);
  }
  h.face();
  if (view === 'down') {
    h.hline(hx0 + 1, hx1 - 1, hy0, col.hair);
    h.hline(hx0, hx1, hy0 + 1, col.hair);
    h.hline(hx0, hx0 + 2, hy0 + 2, col.hair);
    h.hline(hx1 - 2, hx1, hy0 + 2, col.hair);
    h.vline(hx0, hy0 + 2, h.ty0, col.hair);
    h.vline(hx1, hy0 + 2, h.ty0, col.hair);
    h.put(hx0, h.ty0, col.hairShade);
    h.put(hx1, h.ty0, col.hairShade);
    h.put(7, hy0 + 1, col.glow); // gemme du diadème
    h.put(8, hy0 + 1, col.trim);
  } else if (view === 'up') {
    h.box(hx0, hy0, hx1, h.ty0 + 1, col.hair);
    h.clear(hx0, hy0);
    h.clear(hx1, hy0);
    h.hline(hx0, hx1, hy0 + 1, col.trim);
    h.vline(hx1, hy0 + 2, h.ty0 + 1, col.hairShade);
    h.hline(hx0 + 1, hx1 - 1, h.ty0 + 1, col.hairShade);
  } else {
    h.hline(hx0 + 1, hx1 - 1, hy0, col.hair);
    h.hline(hx0, hx1 - 1, hy0 + 1, col.hair);
    h.box(hx0, hy0 + 2, hx0 + 1, hy0 + 3, col.hair);
    h.hline(hx0 + 2, hx1 - 1, hy0 + 1, col.trim);
  }
  // arc doré côté gauche (écran)
  if (view === 'down') {
    if (h.attack) {
      h.c.blit(bow.rotate(1), 3, 11);
      h.vline(8, 10, 12, col.metal);
      h.put(8, 13, col.trim);
    } else h.c.blit(bow.flipH(), 1, 5);
  } else if (view === 'up') {
    if (h.attack) h.c.blit(bow.rotate(3), 3, 1);
    else h.c.blit(bow, 11, 5);
  } else if (h.attack) {
    h.c.blit(bow, 11, 3);
    h.hline(8, 12, 8, col.metal);
    h.put(13, 8, col.trim);
  } else h.c.blit(bow, 10, 5);
};

// ───────────────────────────── Aelith : elfe archère ─────────────────────────────

const aelith: HeroDraw = (h) => {
  const { col, view } = h;
  const bow = bowBitmap(14, 3, col.wood, col.woodShade, col.trim, col.metal);
  // carquois visible de dos
  if (view === 'up') {
    h.box(5, h.ty0 - 1, 6, h.ty1, col.wood);
    h.vline(5, h.ty0 - 1, h.ty1, col.woodShade);
    h.put(5, h.ty0 - 2, col.metal);
    h.put(6, h.ty0 - 3, col.metal);
    h.put(6, h.ty0 - 2, col.glow);
  }
  h.legs();
  h.torso();
  // mantelet vert foncé aux épaules, ceinture dorée
  if (view !== 'right') {
    h.hline(h.tx0 - 1, h.tx1 + 1, h.ty0, col.cloak);
    h.hline(h.tx0, h.tx1, h.ty0 + 1, col.cloak);
    h.hline(h.tx0, h.tx1, h.ty1 - 1, col.trim);
    if (view === 'down') {
      h.put(7, h.ty0 + 2, col.trim);
      h.put(8, h.ty0 + 2, col.trimShade);
    }
  } else {
    h.hline(h.tx0 - 1, h.tx1, h.ty0, col.cloak);
    h.hline(h.tx0, h.tx1, h.ty1 - 1, col.trim);
  }
  h.arms(col.main, col.skin);
  const { hx0, hx1, hy0, hy1 } = h;
  // natte argentée
  if (view === 'down') {
    h.vline(hx1 + 1, hy0 + 3, h.ty0 + 2, col.hair);
    h.vline(hx1 + 1, h.ty0 + 2, h.ty0 + 3, col.hairShade);
  } else if (view === 'up') {
    h.vline(7, hy1, h.ty1, col.hair);
    h.vline(8, hy1, h.ty1, col.hairShade);
  } else {
    h.vline(hx0 - 1, hy0 + 2, h.ty1, col.hair);
    h.vline(hx0 - 2, hy0 + 3, h.ty1 - 1, col.hairShade);
  }
  h.face();
  if (view === 'down') {
    h.hline(hx0 + 1, hx1 - 1, hy0, col.hair);
    h.hline(hx0, hx1, hy0 + 1, col.hair);
    h.hline(hx0, hx0 + 2, hy0 + 2, col.hair);
    h.hline(hx1 - 2, hx1, hy0 + 2, col.hair);
    h.put(7, hy0 + 2, col.hairShade);
    h.put(8, hy0 + 2, col.hairShade);
    h.put(hx0, hy0 + 3, col.hairShade);
    // oreilles pointues
    h.put(hx0 - 1, hy0 + 3, col.skin);
    h.put(hx0 - 2, hy0 + 2, col.skin);
    h.put(hx1 + 1, hy0 + 3, col.skin);
    h.put(hx1 + 2, hy0 + 2, col.skin);
  } else if (view === 'up') {
    h.box(hx0, hy0, hx1, hy1 - 1, col.hair);
    h.clear(hx0, hy0);
    h.clear(hx1, hy0);
    h.hline(hx0 + 1, hx1 - 1, hy1 - 1, col.hairShade);
    h.put(hx0 - 1, hy0 + 3, col.skin);
    h.put(hx0 - 2, hy0 + 2, col.skin);
    h.put(hx1 + 1, hy0 + 3, col.skin);
    h.put(hx1 + 2, hy0 + 2, col.skin);
    h.hline(hx0 + 1, hx1 - 1, hy0 + 1, col.trim);
  } else {
    h.hline(hx0 + 1, hx1 - 1, hy0, col.hair);
    h.hline(hx0, hx1 - 1, hy0 + 1, col.hair);
    h.box(hx0, hy0 + 2, hx0 + 2, hy0 + 3, col.hair);
    h.put(hx0 + 3, hy0 + 2, col.skin);
    h.put(hx0 + 2, hy0 + 3, col.skin);
    h.put(hx0 + 3, hy0 + 2, col.skinShade);
    h.put(hx0 + 4, hy0 + 1, col.skin);
    h.hline(hx0 + 1, hx1 - 1, hy0 + 1, col.trim);
  }
  // grand arc tenu à droite (écran)
  if (view === 'down') {
    if (h.attack) {
      h.c.blit(bow.rotate(1), 1, 11);
      h.vline(7, 10, 12, col.metal);
      h.put(7, 13, col.metal);
    } else h.c.blit(bow.flipH(), 11, 1);
  } else if (view === 'up') {
    if (h.attack) h.c.blit(bow.rotate(3), 1, 1);
    else h.c.blit(bow, 2, 1);
  } else if (h.attack) {
    h.c.blit(bow, 10, 1);
    h.hline(7, 12, 8, col.metal);
    h.put(13, 8, col.glow);
  } else h.c.blit(bow, 10, 1);
};

// ───────────────────────────── Brokk : nain tank ─────────────────────────────

const brokk: HeroDraw = (h) => {
  const { col, view } = h;
  const axe = weaponPose(h, view === 'right' ? 3 : 1, 2);
  if (view === 'up') weapon(h, AXE, [1, 7], axe.k, axe.at);
  h.legs();
  h.torso();
  h.hline(h.tx0, h.tx1, h.ty1 - 1, col.trim);
  if (view !== 'right') {
    h.put(h.tx0, h.ty0, col.metal);
    h.put(h.tx1, h.ty0, col.metalShade);
  }
  h.arms(col.main, col.skin);
  const { hx0, hx1, hy0, hy1 } = h;
  const mid = Math.floor((hx0 + hx1) / 2);
  h.face();
  if (view === 'down') {
    // casque rond à bandeau doré, cornes
    h.hline(hx0 + 1, hx1 - 1, hy0, col.cloak);
    h.hline(hx0, hx1, hy0 + 1, col.trim);
    h.put(hx0 + 1, hy0, col.metal);
    h.put(hx0 + 2, hy0, col.metal);
    h.put(hx1 - 1, hy0, col.cloakShade);
    h.put(hx0, hy0 - 1, col.metal);
    h.put(hx1, hy0 - 1, col.metalShade);
    h.put(hx0 - 1, hy0 - 2, col.metal);
    h.put(hx1 + 1, hy0 - 2, col.metalShade);
    // visage
    h.hline(hx0 + 1, hx1 - 1, hy0 + 2, col.skin);
    h.put(hx0 + 2, hy0 + 2, EYE);
    h.put(hx1 - 2, hy0 + 2, EYE);
    h.put(hx0, hy0 + 2, col.hair);
    h.put(hx1, hy0 + 2, col.hairShade);
    // grande barbe orange tressée
    h.hline(hx0, hx1, hy0 + 3, col.hair);
    h.put(mid, hy0 + 3, col.skin);
    h.put(mid + 1, hy0 + 3, col.skin);
    h.hline(hx0, hx1, hy0 + 4, col.hair);
    h.hline(hx0 + 1, hx1 - 1, hy0 + 5, col.hair);
    h.hline(hx0 + 1, hx1 - 1, hy0 + 6, col.hair);
    h.hline(hx0 + 2, hx1 - 2, hy0 + 7, col.hair);
    h.vline(hx1 - 1, hy0 + 4, hy0 + 6, col.hairShade);
    h.put(hx1, hy0 + 4, col.hairShade);
    h.vline(mid, hy0 + 5, hy0 + 7, col.hairShade);
    h.put(mid, hy0 + 8, col.hairShade);
    h.put(mid + 1, hy0 + 8, col.hairShade);
  } else if (view === 'up') {
    h.box(hx0, hy0, hx1, hy1, col.cloak);
    h.clear(hx0, hy0);
    h.clear(hx1, hy0);
    h.hline(hx0, hx1, hy0 + 1, col.trim);
    h.hline(hx0 + 1, hx1 - 1, hy1, col.cloakShade);
    h.vline(hx1, hy0 + 2, hy1, col.cloakShade);
    h.put(hx0, hy0 - 1, col.metal);
    h.put(hx1, hy0 - 1, col.metalShade);
    h.put(hx0 - 1, hy0 - 2, col.metal);
    h.put(hx1 + 1, hy0 - 2, col.metalShade);
    h.box(hx0 + 1, hy1 + 1, hx1 - 1, hy1 + 3, col.hair);
    h.hline(hx0 + 1, hx1 - 1, hy1 + 3, col.hairShade);
  } else {
    h.hline(hx0, hx1 - 1, hy0, col.cloak);
    h.hline(hx0, hx1 - 1, hy0 + 1, col.trim);
    h.box(hx0, hy0 + 2, hx0 + 2, hy1, col.cloak);
    h.vline(hx0, hy0 + 2, hy1, col.cloakShade);
    h.put(hx0 + 2, hy0 - 1, col.metal);
    h.put(hx0 + 1, hy0 - 2, col.metal);
    h.hline(hx0 + 3, hx1 - 2, hy0 + 2, col.skin);
    h.put(hx1 - 1, hy0 + 2, EYE);
    h.box(hx0 + 3, hy0 + 3, hx1, hy1 + 2, col.hair);
    h.hline(hx0 + 3, hx1, hy1 + 2, col.hairShade);
    h.vline(hx0 + 3, hy0 + 3, hy1 + 2, col.hairShade);
  }
  if (view !== 'up') weapon(h, AXE, [1, 7], axe.k, axe.at);
};

// ───────────────────────────── Grok : troll brute ─────────────────────────────

const grok: HeroDraw = (h) => {
  const { col, view } = h;
  const club = weaponPose(h, 0, 1);
  if (view === 'up') weapon(h, CLUB, [2, 6], club.k, club.at);
  h.legs({ pants: col.skin, boots: col.boots });
  h.torso(col.skin, col.skinShade);
  if (view === 'down') {
    // pectoraux, sangle de cuir en bandoulière, pagne
    h.hline(h.tx0 + 2, h.tx0 + 4, h.ty0 + 2, col.skinShade);
    h.hline(h.tx1 - 4, h.tx1 - 2, h.ty0 + 2, col.skinShade);
    h.line(h.tx0 + 1, h.ty0, h.tx1 - 2, h.ty1 - 2, col.main);
    h.line(h.tx0 + 2, h.ty0, h.tx1 - 1, h.ty1 - 2, col.mainShade);
    h.box(5, h.ty1 - 1, 10, h.ty1 + 1, col.main);
    h.hline(5, 10, h.ty1 + 1, col.mainShade);
    h.hline(5, 10, h.ty1 - 1, col.trim);
    h.put(7, h.ty1 - 1, col.metal);
  } else if (view === 'up') {
    h.line(h.tx0 + 1, h.ty0, h.tx1 - 2, h.ty1 - 2, col.main);
    h.hline(h.tx0, h.tx1, h.ty1 - 1, col.main);
    h.hline(h.tx0, h.tx1, h.ty1, col.mainShade);
  } else {
    h.hline(h.tx0, h.tx1, h.ty1 - 1, col.main);
    h.hline(h.tx0, h.tx1, h.ty1, col.mainShade);
    h.line(h.tx0, h.ty0, h.tx1 - 1, h.ty1 - 2, col.main);
  }
  // bras épais (2 px) aux poings cerclés d'os
  if (view !== 'right') {
    h.box(h.tx0 - 2, h.ty0, h.tx0 - 1, h.ty1 - 1, col.skin);
    h.box(h.tx1 + 1, h.ty0, h.tx1 + 2, h.ty1 - 1, col.skin);
    h.vline(h.tx0 - 1, h.ty0 + 1, h.ty1 - 1, col.skinShade);
    h.vline(h.tx1 + 2, h.ty0 + 1, h.ty1 - 1, col.skinShade);
    h.hline(h.tx0 - 2, h.tx0 - 1, h.ty1 - 3, col.trim);
    h.hline(h.tx1 + 1, h.tx1 + 2, h.ty1 - 3, col.trim);
  } else {
    const ax = h.cx + (h.attack ? 1 : h.step === 0 ? 1 : -1);
    h.box(ax, h.ty0, ax + 1, h.ty1 - 1, col.skin);
    h.vline(ax + 1, h.ty0 + 1, h.ty1 - 1, col.skinShade);
    h.hline(ax, ax + 1, h.ty1 - 3, col.trim);
  }
  const { hx0, hx1, hy0, hy1 } = h;
  h.face();
  if (view === 'down') {
    // crête de cheveux, arcade, yeux rouges, défenses
    h.hline(hx0 + 1, hx1 - 1, hy0, col.hair);
    h.hline(hx0 + 2, hx1 - 2, hy0 - 1, col.hair);
    h.hline(hx0, hx1, hy0 + 1, col.skinShade);
    h.put(hx0 + 1, hy0 + 1, col.hairShade);
    h.put(hx1 - 1, hy0 + 1, col.hairShade);
    h.put(hx0 + 1, hy0 + 2, col.glow);
    h.put(hx1 - 1, hy0 + 2, col.glow);
    h.put(hx0 + 2, hy0 + 2, col.skin);
    h.put(hx1 - 2, hy0 + 2, col.skin);
    h.hline(hx0 + 1, hx1 - 1, hy0 + 3, col.skinShade);
    h.put(hx0 + 1, hy0 + 3, col.trim);
    h.put(hx1 - 1, hy0 + 3, col.trim);
    h.put(hx0 + 1, hy0 + 2, col.glow);
    h.put(hx1 - 1, hy0 + 2, col.glow);
  } else if (view === 'up') {
    h.box(hx0, hy0, hx1, hy1, col.hair);
    h.clear(hx0, hy0);
    h.clear(hx1, hy0);
    h.hline(hx0 + 1, hx1 - 1, hy1, col.skinShade);
    h.hline(hx0 + 2, hx1 - 2, hy0 - 1, col.hair);
    h.vline(hx1, hy0 + 1, hy1, col.hairShade);
  } else {
    h.hline(hx0 + 1, hx1 - 1, hy0, col.hair);
    h.hline(hx0 + 1, hx1 - 2, hy0 - 1, col.hair);
    h.box(hx0, hy0 + 1, hx0 + 1, hy0 + 2, col.hair);
    h.hline(hx0 + 2, hx1, hy0 + 1, col.skinShade);
    h.put(hx1 - 1, hy0 + 2, col.glow);
    h.put(hx1 - 1, hy0 + 3, col.trim);
    h.put(hx1 + 1, hy0 + 3, col.skin);
    h.put(hx1 + 1, hy0 + 2, col.skinShade);
  }
  if (view !== 'up') weapon(h, CLUB, [2, 6], club.k, club.at);
};

// ───────────────────────────── Mira : maraudeuse ─────────────────────────────

const mira: HeroDraw = (h) => {
  const { col, view } = h;
  h.legs();
  h.torso(col.main, col.mainShade);
  h.hline(h.tx0, h.tx1, h.ty1 - 1, col.mainShade);
  if (view === 'down') h.put(7, h.ty1 - 1, col.metal);
  h.arms(col.main, col.skin);
  const { hx0, hx1, hy0, hy1 } = h;
  h.face();
  if (view === 'down') {
    // capuche sombre, visage dans l'ombre, yeux dorés
    h.box(hx0, hy0, hx1, hy1, col.cloak);
    h.clear(hx0, hy0);
    h.clear(hx1, hy0);
    h.clear(hx0, hy1);
    h.clear(hx1, hy1);
    h.box(hx0 + 1, hy0 + 2, hx1 - 1, hy0 + 4, col.mainShade);
    h.hline(hx0 + 1, hx1 - 1, hy0 + 1, col.cloakShade);
    h.put(hx0 + 1, hy0 + 3, col.glow);
    h.put(hx1 - 1, hy0 + 3, col.glow);
    h.vline(hx0, hy0 + 2, hy1 - 1, col.cloakShade);
    h.vline(hx1, hy0 + 2, hy1 - 1, col.cloakShade);
    h.hline(hx0 + 1, hx1 - 1, hy0, col.cloakShade);
    h.hline(hx0 + 2, hx1 - 2, hy0 - 1, col.cloak);
    h.put(hx1 - 1, hy0 - 1, col.cloak);
    h.put(hx1 - 1, hy0 - 1, col.cloakShade);
    // écharpe cramoisie qui flotte
    h.hline(h.tx0 - 1, h.tx1 + 1, h.ty0, col.trim);
    h.vline(h.tx0 - 1, h.ty0, h.ty0 + 4, col.trim);
    h.vline(h.tx0 - 2, h.ty0 + 2, h.ty0 + 4, col.trimShade);
    h.put(h.tx0 - 2, h.ty0 + 5, col.trimShade);
  } else if (view === 'up') {
    h.box(hx0, hy0, hx1, hy1, col.cloak);
    h.clear(hx0, hy0);
    h.clear(hx1, hy0);
    h.hline(hx0 + 1, hx1 - 1, hy1, col.cloakShade);
    h.vline(hx1, hy0 + 1, hy1, col.cloakShade);
    h.vline(7, hy0 + 1, hy1, col.cloakShade);
    h.hline(hx0 + 2, hx1 - 2, hy0 - 1, col.cloak);
    h.put(hx1 - 1, hy0 - 1, col.cloak);
    h.hline(h.tx0 - 1, h.tx1 + 1, h.ty0, col.cloak);
    h.hline(h.tx0, h.tx1, h.ty0 + 1, col.cloakShade);
    h.vline(h.tx0, h.ty0 + 2, h.ty0 + 6, col.trim);
    h.vline(h.tx0 - 1, h.ty0 + 3, h.ty0 + 5, col.trimShade);
  } else {
    h.box(hx0, hy0, hx1 - 1, hy1, col.cloak);
    h.put(hx1, hy0 + 1, col.cloak);
    h.clear(hx0, hy0);
    h.box(hx1 - 3, hy0 + 2, hx1, hy1 - 1, col.mainShade);
    h.put(hx1 - 1, hy0 + 3, col.glow);
    h.hline(hx0, hx1 - 1, hy0 + 1, col.cloakShade);
    h.vline(hx0, hy0 + 2, hy1, col.cloakShade);
    h.hline(hx0 + 2, hx1 - 1, hy0 - 1, col.cloak);
    h.put(hx0 + 1, hy0, col.cloak);
    h.hline(h.tx0 - 1, h.tx1, h.ty0, col.trim);
    h.vline(h.tx0 - 1, h.ty0, h.ty0 + 4, col.trim);
    h.vline(h.tx0 - 2, h.ty0 + 1, h.ty0 + 3, col.trimShade);
  }
  // deux dagues
  const dagger = (x: number, y: number, k: number) => weapon(h, DAGGER, [0, 4], k, [x, y]);
  if (!h.attack) {
    if (view === 'right') {
      const [hx, hy] = h.hand();
      dagger(hx, hy, 2);
      dagger(hx + 1, hy - 3, 1);
    } else {
      dagger(h.tx0 - 1, h.ty1 - 1, 2);
      dagger(h.tx1 + 1, h.ty1 - 1, 2);
    }
  } else if (view === 'down') {
    dagger(h.tx0 - 1, h.ty1 - 1, 2);
    dagger(h.tx1 + 1, h.ty1 - 1, 2);
    h.put(h.tx0 - 1, h.ty1 + 3, col.metal);
    h.put(h.tx1 + 1, h.ty1 + 3, col.metal);
  } else if (view === 'up') {
    dagger(h.tx0 - 1, h.ty0, 0);
    dagger(h.tx1 + 1, h.ty0, 0);
  } else {
    const [hx, hy] = h.hand();
    dagger(hx, hy - 1, 1);
    dagger(hx - 1, hy + 2, 1);
  }
};

interface HeroDef {
  build: Build;
  draw: HeroDraw;
}

const HEROES: Record<CharacterId, HeroDef> = {
  david: { build: { headW: 8, headH: 6, torsoW: 6, torsoH: 4, legH: 3, overlap: 0 }, draw: david },
  sandrine: { build: { headW: 6, headH: 4, torsoW: 6, torsoH: 4, legH: 3, overlap: 0 }, draw: sandrine },
  romain: { build: { headW: 8, headH: 6, torsoW: 6, torsoH: 4, legH: 2, overlap: 0 }, draw: romain },
  valentine: { build: { headW: 8, headH: 6, torsoW: 6, torsoH: 4, legH: 2, overlap: 0 }, draw: valentine },
  aelith: { build: { headW: 6, headH: 6, torsoW: 4, torsoH: 5, legH: 3, overlap: 0 }, draw: aelith },
  brokk: { build: { headW: 8, headH: 5, torsoW: 8, torsoH: 4, legH: 2, overlap: 1, shiftX: -2 }, draw: brokk },
  grok: { build: { headW: 6, headH: 5, torsoW: 10, torsoH: 5, legH: 3, overlap: 0, legW: 4 }, draw: grok },
  mira: { build: { headW: 6, headH: 6, torsoW: 4, torsoH: 4, legH: 3, overlap: 0 }, draw: mira },
};

/** Dessine une pose d'un héros (SANS contour) : vue avant / arrière / côté droit. */
function drawRaw(id: CharacterId, view: HeroView, pose: HeroPose): Bitmap {
  const def = HEROES[id];
  const h = new Humanoid(HERO_COLORS[id], view, pose, def.build);
  def.draw(h);
  return h.c;
}

/** Sprite 16×16 d'un héros avec contour (direction 'left' = miroir de 'right'). */
export function drawHero(id: CharacterId, dir: Dir, pose: HeroPose): Bitmap {
  const view: HeroView = dir === 'left' ? 'right' : dir;
  const bm = drawRaw(id, view, pose);
  const out = dir === 'left' ? bm.flipH() : bm;
  return out.outline(OUTLINE);
}

/** Frame « à terre » : le héros de face couché sur le côté (corps pivoté), posé au sol. */
export function drawDowned(id: CharacterId): Bitmap {
  const body = drawRaw(id, 'down', 0).rotate(1);
  let minX = 16, maxX = -1, maxY = -1;
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      if (body.get(x, y) === CLEAR) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  const dx = Math.round(8 - (minX + maxX + 1) / 2);
  return body.shifted(dx, 14 - maxY).outline(OUTLINE);
}

/** Nom de frame d'une pose de héros. */
export function heroFrameName(id: CharacterId, dir: Dir, pose: HeroPose): string {
  return pose === 'attack' ? `hero_${id}_${dir}_attack` : `hero_${id}_${dir}_${pose}`;
}

/** Toutes les frames de héros (nom → bitmap). */
export function buildHeroFrames(): Record<string, Bitmap> {
  const out: Record<string, Bitmap> = {};
  for (const id of HERO_IDS) {
    for (const dir of HERO_DIRS) {
      out[heroFrameName(id, dir, 0)] = drawHero(id, dir, 0);
      out[heroFrameName(id, dir, 1)] = drawHero(id, dir, 1);
      out[heroFrameName(id, dir, 'attack')] = drawHero(id, dir, 'attack');
    }
    out[`hero_${id}_downed`] = drawDowned(id);
  }
  return out;
}
