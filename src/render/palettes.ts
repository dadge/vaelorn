/**
 * Palettes du jeu (couleurs 0xRRGGBB). Pur : aucune dépendance à Phaser ni au DOM.
 *
 * Esprit visuel : contours sombres nets de 1 px, aplats (aucun dégradé, aucun pixel semi-transparent),
 * couleurs vives. Une palette de 8–12 couleurs par thème de donjon (crypt, grove, citadel),
 * une palette par héros, par ennemi et par famille (mécanismes, décors, FX, UI).
 *
 * Toute couleur utilisée par un sprite DOIT figurer ici : `ALL_PALETTE_COLORS` est la liste blanche
 * vérifiée par les tests (aucun pixel hors palette dans l'atlas).
 */
import { PLAYER_COLORS } from '../core/constants';
import type { CharacterId, EnemyKind, ZoneTheme } from '../core/types';

/** Contour sombre commun à tous les sprites (bleu-nuit presque noir). */
export const OUTLINE = 0x14121f;
/** Blanc pur (reflets, éclats, silhouettes de dégâts). */
export const WHITE = 0xffffff;

/** Convertit 0xRRGGBB en '#rrggbb' (CSS / debug). */
export function hex(c: number): string {
  return '#' + (c & 0xffffff).toString(16).padStart(6, '0');
}

/** Décompose 0xRRGGBB en [r, g, b]. */
export function rgb(c: number): [number, number, number] {
  return [(c >> 16) & 255, (c >> 8) & 255, c & 255];
}

// ───────────────────────────── Thèmes de donjon ─────────────────────────────

/** Palette d'un thème de donjon (≤ 12 valeurs distinctes, contour inclus). */
export interface ThemePalette {
  outline: number;
  /** Vide hors-salle et fond des fosses. */
  void: number;
  floorMid: number;
  floorDark: number;
  floorLight: number;
  wallMid: number;
  wallDark: number;
  wallLight: number;
  /** Dessus des murs (masse sombre). */
  wallTop: number;
  accent: number;
  accentHi: number;
  accentDeep: number;
}

export const THEME_PALETTES: Readonly<Record<ZoneTheme, ThemePalette>> = {
  // L1 : pierre bleu-gris, torches orange
  crypt: {
    outline: OUTLINE,
    void: 0x0b0912,
    floorMid: 0x4a5478,
    floorDark: 0x3a4262,
    floorLight: 0x5f6b96,
    wallMid: 0x6a78a6,
    wallDark: 0x3a4262,
    wallLight: 0x8f9ecb,
    wallTop: 0x262b44,
    accent: 0xff9a3c,
    accentHi: 0xffd36b,
    accentDeep: 0xb8451c,
  },
  // L2 : verts et ocres, racines, champignons lumineux
  grove: {
    outline: 0x101a12,
    void: 0x08100a,
    floorMid: 0x5f8a3c,
    floorDark: 0x486e30,
    floorLight: 0x8ab84e,
    wallMid: 0x6e4a2a,
    wallDark: 0x4a3220,
    wallLight: 0xa27440,
    wallTop: 0x23441f,
    accent: 0x7dffb0,
    accentHi: 0xe6fff0,
    accentDeep: 0x2fb87a,
  },
  // L3 : violets et noirs, cristaux cyan, rouge Morvane
  citadel: {
    outline: 0x120c20,
    void: 0x07040e,
    floorMid: 0x3c2e60,
    floorDark: 0x2c2148,
    floorLight: 0x58468f,
    wallMid: 0x4b3b7c,
    wallDark: 0x2c2148,
    wallLight: 0x7f68c0,
    wallTop: 0x191130,
    accent: 0x46e6ff,
    accentHi: 0xc8faff,
    accentDeep: 0x1b8cb4,
  },
  // L4 : cavernes de glace — bleus et blancs, sol givré, murs de glace, éclats cyan
  frost: {
    outline: 0x0c1830,
    void: 0x040a16,
    floorMid: 0x6a94c4,
    floorDark: 0x4f78a8,
    floorLight: 0xaed0ee,
    wallMid: 0xb4d8f4,
    wallDark: 0x6a94c4,
    wallLight: 0xeaf8ff,
    wallTop: 0x23406e,
    accent: 0x7af0ff,
    accentHi: 0xffffff,
    accentDeep: 0x3a90d8,
  },
  // L5 : forge volcanique — rouges, orange et noirs, sol de basalte, lave luisante
  ember: {
    outline: 0x1a0a0c,
    void: 0x0a0405,
    floorMid: 0x4a3a40,
    floorDark: 0x362a30,
    floorLight: 0x6a5560,
    wallMid: 0x7a3e34,
    wallDark: 0x3a2024,
    wallLight: 0x8a5448,
    wallTop: 0x1e1012,
    accent: 0xff7a1e,
    accentHi: 0xffd84a,
    accentDeep: 0xc2300e,
  },
  // L6 : abysse astral — violets et noirs, étoiles, sol cristallin
  void: {
    outline: 0x0a0618,
    void: 0x03020a,
    floorMid: 0x2a2258,
    floorDark: 0x161235,
    floorLight: 0x4a3f94,
    wallMid: 0x33298a,
    wallDark: 0x161235,
    wallLight: 0x8a6ee0,
    wallTop: 0x0f0b26,
    accent: 0xb48cff,
    accentHi: 0xffffff,
    accentDeep: 0x6a3cd0,
  },
};

// ───────────────────────────── Héros ─────────────────────────────

/**
 * Couleurs d'un héros. Les mêmes clés pour tous : le dessin (heroes.ts) choisit lesquelles employer.
 *  main = vêtement principal (torse) ; cloak = capuche / cape / chapeau / tabard ;
 *  trim = liserés, ceinture, bijoux ; metal = lames, casques ; wood = manches, arcs, bâtons ;
 *  glow = éclat magique ou plumet.
 */
export interface HeroColors {
  skin: number;
  skinShade: number;
  hair: number;
  hairShade: number;
  main: number;
  mainShade: number;
  cloak: number;
  cloakShade: number;
  trim: number;
  trimShade: number;
  pants: number;
  boots: number;
  metal: number;
  metalShade: number;
  wood: number;
  woodShade: number;
  glow: number;
  glowShade: number;
}

/** Couleur des yeux / détails sombres communs aux héros. */
export const EYE = 0x1b1530;

export const HERO_COLORS: Readonly<Record<CharacterId, HeroColors>> = {
  // Guerrier : acier, tabard bleu, plumet rouge
  david: {
    skin: 0xf0b98a, skinShade: 0xc98a62, hair: 0x7a4a2a, hairShade: 0x5a3420,
    main: 0x9fb2d0, mainShade: 0x6b7ea6, cloak: 0x3358b8, cloakShade: 0x233e86,
    trim: 0xf5c53d, trimShade: 0xbd8a1e, pants: 0x3b3f5c, boots: 0x5b3a22,
    metal: 0xe4ecf7, metalShade: 0x93a3c0, wood: 0x7a4a26, woodShade: 0x52301a,
    glow: 0xe8403a, glowShade: 0xa42a2e,
  },
  // Magicienne : robe violette, grand chapeau pointu, bâton à orbe cyan
  sandrine: {
    skin: 0xf4c9a0, skinShade: 0xcf9a74, hair: 0xd2602e, hairShade: 0x9a3e1c,
    main: 0x8a46d6, mainShade: 0x5a2ca0, cloak: 0x6a34b8, cloakShade: 0x42207c,
    trim: 0xffd24a, trimShade: 0xc9922a, pants: 0x5a2ca0, boots: 0x3d2466,
    metal: 0xe8dcff, metalShade: 0xb09ae0, wood: 0x9a6234, woodShade: 0x6a3f1e,
    glow: 0x66f2ff, glowShade: 0x2aa8d8,
  },
  // Éclaireur : capuche verte pointue, tunique cuir, écharpe orange, lame courte
  romain: {
    skin: 0xf0b98a, skinShade: 0xc98a62, hair: 0x5a3a22, hairShade: 0x3c2614,
    main: 0xb98a52, mainShade: 0x8a6236, cloak: 0x3fa65a, cloakShade: 0x2a7a42,
    trim: 0xff8a2a, trimShade: 0xc9561a, pants: 0x5e4128, boots: 0x3a2616,
    metal: 0xe3eaf2, metalShade: 0x9fabbd, wood: 0x7a4a26, woodShade: 0x52301a,
    glow: 0xffe27a, glowShade: 0xc9a63a,
  },
  // Guérisseuse-archère : cape claire, cheveux blonds, arc doré, étoile de soin rose
  valentine: {
    skin: 0xf6cfa8, skinShade: 0xd4a07c, hair: 0xf5d36a, hairShade: 0xc99e34,
    main: 0xf2a6c0, mainShade: 0xc7769a, cloak: 0xfaf3e6, cloakShade: 0xd2c7ae,
    trim: 0xf2c64a, trimShade: 0xbf8f27, pants: 0xb8895a, boots: 0x8a5a3a,
    metal: 0xf4f4f4, metalShade: 0xbfc4d0, wood: 0xe0a84a, woodShade: 0xa8702a,
    glow: 0xff7aa8, glowShade: 0xc94d7c,
  },
  // Elfe archère : oreilles pointues, cheveux argentés, tenue verte, grand arc
  aelith: {
    skin: 0xf6dcc0, skinShade: 0xd6ac8a, hair: 0xe8eef8, hairShade: 0xa9b6cc,
    main: 0x3f9a58, mainShade: 0x2a6e3e, cloak: 0x2a6e3e, cloakShade: 0x1c4c2c,
    trim: 0xd9b25a, trimShade: 0xa88638, pants: 0x6e5230, boots: 0x4a3520,
    metal: 0xdfe6ee, metalShade: 0x9fabbd, wood: 0xb07a44, woodShade: 0x70481e,
    glow: 0x8affc0, glowShade: 0x3fb87a,
  },
  // Nain tank : barbe orange, casque de fer, hache à deux lames
  brokk: {
    skin: 0xe8a47c, skinShade: 0xc07a58, hair: 0xe0702e, hairShade: 0xa8461a,
    main: 0x7a849e, mainShade: 0x4e566e, cloak: 0x8e98b2, cloakShade: 0x586079,
    trim: 0xe0a82e, trimShade: 0xa87518, pants: 0x5a3a24, boots: 0x33200f,
    metal: 0xdce2ee, metalShade: 0x8d97b0, wood: 0x8a5a30, woodShade: 0x5a3a1c,
    glow: 0xff9a3c, glowShade: 0xb8451c,
  },
  // Troll brute : peau verte, pagne, énorme massue cloutée
  grok: {
    skin: 0x78c052, skinShade: 0x4a9438, hair: 0x5a4632, hairShade: 0x362a1c,
    main: 0x8a5530, mainShade: 0x5e3720, cloak: 0x6e4a2a, cloakShade: 0x4a301a,
    trim: 0xf0e6c8, trimShade: 0xc4b48a, pants: 0x8a5530, boots: 0x5e3720,
    metal: 0xc4c8d4, metalShade: 0x8a8f9e, wood: 0xa2703e, woodShade: 0x6a4424,
    glow: 0xff5a3a, glowShade: 0xb02a1a,
  },
  // Maraudeuse : capuche sombre, yeux dorés, écharpe cramoisie, deux dagues
  mira: {
    skin: 0xe8b894, skinShade: 0xc08c6a, hair: 0x2a2036, hairShade: 0x181224,
    main: 0x4a4268, mainShade: 0x2c2646, cloak: 0x5a4690, cloakShade: 0x34285e,
    trim: 0xe0304f, trimShade: 0x9c1a35, pants: 0x2c2640, boots: 0x1f1b30,
    metal: 0xe6edf5, metalShade: 0x9aa8bd, wood: 0x6a4a3a, woodShade: 0x45301f,
    glow: 0xffe45a, glowShade: 0xc9a82a,
  },
};

// ───────────────────────────── Ennemis et boss ─────────────────────────────

/** Palettes des ennemis (clés libres par ennemi : voir enemies.ts). Les boss : voir BOSS_COLORS. */
export const ENEMY_COLORS = {
  slime: { hi: 0xb8f59a, base: 0x62d44a, shade: 0x3a9e3a, deep: 0x24702c, eye: 0xffffff, pupil: EYE },
  bat: { wing: 0x9a62c8, wingShade: 0x6a3c98, body: 0x4e2c78, bodyDark: 0x341c54, eye: 0xff4a4a, fang: 0xffffff },
  skeleton: { bone: 0xeae6d2, boneShade: 0xb8b49c, boneDark: 0x7c7868, eye: 0xff6a3a, blade: 0xc4ccd8, bladeShade: 0x8590a6, hilt: 0x8a5a30 },
  archer: { hood: 0xb83a3a, hoodShade: 0x7c2428, face: 0x2a1a24, eye: 0xffe45a, cloth: 0x7a5a32, clothShade: 0x523a1e, bow: 0xb07a44, bowShade: 0x70481e, string: 0xf0f0f0 },
  spider: { body: 0x4a3860, bodyShade: 0x2c2040, leg: 0x6a5488, mark: 0xe0384a, eye: 0xff9a9a, fang: 0xffffff },
  wisp: { core: 0xffffff, hi: 0xb8f8ff, base: 0x5cdcf8, shade: 0x2a9ccc, deep: 0x1c6a9c, eye: EYE },
  knight: { steel: 0x8590b0, steelShade: 0x565f80, steelDark: 0x383e5c, steelLight: 0xc4cce4, plume: 0xc03a6a, plumeShade: 0x822448, shield: 0xe0b030, shieldShade: 0xa87a18, visor: 0xff4a4a },
} as const;

/**
 * Couleurs des demi-boss 32×32 (niveaux 4-6) : gardien de givre (warden), pyromancien, spectre (wraith).
 * Les frames sont `miniboss_<kind>_<0|1|hurt>`.
 */
export const MINIBOSS_COLORS = {
  warden: {
    iceHi: 0xeaf8ff, ice: 0xa4d4f4, iceShade: 0x5a90c8, iceDeep: 0x24467c,
    steel: 0x8296bc, steelShade: 0x4c5c84,
    glow: 0x7af0ff, glowHi: 0xffffff,
  },
  pyromancer: {
    robeHi: 0xe8553a, robe: 0xb02a22, robeShade: 0x74161a, robeDeep: 0x420c14,
    face: 0x1a0a14, fireHi: 0xffe27a, fire: 0xff8a1e, fireDeep: 0xe0401a,
    staff: 0x7a4a26, staffShade: 0x52301a, gold: 0xf5c53d,
  },
  wraith: {
    cloakHi: 0x8472cc, cloak: 0x4e3f96, cloakShade: 0x2e2460, cloakDeep: 0x1a1238,
    bone: 0xdcd4f0, boneShade: 0xa49cc4,
    eye: 0x9affd8, eyeDeep: 0x3fe0a8,
  },
} as const;

/** Couleurs des boss 48×48 (Gorgrim, golem de racines ; Morvane, seigneur déchu ; + boss des niveaux 4-6). */
export const BOSS_COLORS = {
  golem: {
    barkHi: 0xb0824c, bark: 0x7e5634, barkShade: 0x573820, barkDeep: 0x3a2414,
    mossHi: 0x9ad45a, moss: 0x5ea83a, mossShade: 0x3a7a2a,
    glow: 0xffb03a, glowHi: 0xfff0a0, glowDeep: 0xff6a1a,
    rootLight: 0x9a6a3a,
  },
  morvane: {
    robeHi: 0x6a4ca0, robe: 0x4a3478, robeShade: 0x2e2050, robeDeep: 0x1c1334,
    steelHi: 0xa8a2cc, steel: 0x6e6890, steelShade: 0x46426a,
    bone: 0xdcd4f0, boneShade: 0xa49cc4,
    red: 0xff3050, redShade: 0xb01830, redDeep: 0x6a1228, lining: 0xc02848,
    crystal: 0x46e6ff, crystalHi: 0xc8faff, crystalShade: 0x1b8cb4,
  },
  // Reine des glaces (niveau 4) : robe de givre, couronne d'éclats, sceptre de cristal
  frostqueen: {
    gownHi: 0xeaf8ff, gown: 0xa8d6f6, gownShade: 0x5f98d0, gownDeep: 0x23467e,
    skin: 0xe6f0fa, skinShade: 0xa8bcd8,
    crownHi: 0xffffff, crown: 0x7af0ff, crownShade: 0x3a90d8,
    cape: 0x3a5ca8, capeDeep: 0x1c2f66,
    eye: 0xff4a8a,
  },
  // Seigneur de la forge (niveau 5) : armure d'acier noir, fissures de lave, marteau
  forgelord: {
    ironHi: 0x7a6a78, iron: 0x4a3c4a, ironShade: 0x2e222e, ironDeep: 0x160f16,
    lavaHi: 0xffe27a, lava: 0xff8a1e, lavaDeep: 0xd0360e,
    horn: 0xd8cbb0, hornShade: 0x9c8d72,
    steelHi: 0xb4b0c0, steel: 0x7a7690,
  },
  // Seigneur du Vide (niveau 6) : robe étoilée, œil unique, éclats orbitaux
  voidlord: {
    robeHi: 0x5a46b8, robe: 0x32267c, robeShade: 0x1c1450, robeDeep: 0x0c0826,
    star: 0xffffff, starGold: 0xffe27a,
    coreHi: 0xf6e0ff, core: 0xd070ff, coreShade: 0x8a2ac0,
    shard: 0x9a8aff, shardShade: 0x5a46c0,
  },
} as const;

/** Silhouette de dégâts des boss (`boss_<kind>_hurt`) : 4 niveaux de luminosité. */
export const HURT_COLORS = { white: 0xffffff, light: 0xffd0d0, mid: 0xff7a7a, dark: 0xc83a46 } as const;

// ───────────────────────────── Mécanismes, décors, FX, UI ─────────────────────────────

export const MECH_COLORS = {
  stoneHi: 0xb0b8d0,
  stone: 0x8890ac,
  stoneShade: 0x606888,
  stoneDark: 0x3e4462,
  plateLight: 0xeceef8,
  plateMid: 0xc0c6dc,
  iron: 0x5a6078,
  ironHi: 0x8a92ae,
  ironDark: 0x34384e,
  gold: 0xf5c53d,
  goldHi: 0xfff0a0,
  goldShade: 0xbd8a1e,
  wood: 0x8a5a30,
  woodHi: 0xb07a44,
  woodShade: 0x5e3a1c,
  red: 0xe0304f,
  redDeep: 0x8c1a34,
  green: 0x5be37d,
  greenDeep: 0x239a4a,
  cyan: 0x46e6ff,
  cyanHi: 0xc8faff,
  cyanDeep: 0x1b8cb4,
  purple: 0xa86aff,
  purpleDeep: 0x6a38c0,
  purpleDark: 0x2e1a5c,
  floorGlow: 0xfff6c8,
} as const;

/**
 * Mécanismes des niveaux 4-6 : statues jumelles (pierre givrée + yeux lumineux), sablier (verre, sable, bronze),
 * herse, pont de lumière (planches dorées sur abîme étoilé) et lanterne du porteur.
 */
export const PUZZLE_COLORS = {
  // statues
  statueHi: 0xdce6f4,
  statue: 0xa6b4cc,
  statueShade: 0x6c7a98,
  statueDeep: 0x3a4262,
  eyeLit: 0x7af0ff,
  eyeSolved: 0x7dffb0,
  // sablier
  glassHi: 0xe4f8ff,
  glass: 0xa4d8ec,
  glassShade: 0x5a98b8,
  sandHi: 0xffe08a,
  sand: 0xe8b44a,
  sandShade: 0xb07a22,
  frameGold: 0xc8902e,
  frameDark: 0x6a4818,
  // herse
  barHi: 0xa8b0c8,
  bar: 0x6a7290,
  barDark: 0x2c3048,
  // pont de lumière
  plankHi: 0xfffbe0,
  plank: 0xffe27a,
  plankShade: 0xe0a830,
  abyss: 0x0c0818,
  abyssMid: 0x1e1440,
  abyssStar: 0x8a7ad8,
  // lanterne
  lanternGlass: 0xffd86a,
  lanternCore: 0xfff6c8,
  lanternIron: 0x5a4a3a,
} as const;

/** Couleurs des glyphes de runes (une couleur vive par symbole). */
export const RUNE_COLORS = {
  sun: 0xffd24a,
  moon: 0xbcd0ff,
  star: 0xfff4a0,
  eye: 0xff5ac8,
  flame: 0xff8a2a,
  wave: 0x4ac8ff,
  dark: 0x2a2440,
  mid: 0x4a4468,
} as const;

export const DECOR_COLORS = {
  wood: 0x8a5a30,
  woodHi: 0xb07a44,
  woodShade: 0x5e3a1c,
  flame: 0xff9a3c,
  flameHi: 0xffe27a,
  flameDeep: 0xe0501e,
  iron: 0x5a6078,
  ironHi: 0x8a92ae,
  stone: 0x8890ac,
  stoneHi: 0xb0b8d0,
  stoneShade: 0x606888,
  stoneDark: 0x3e4462,
  banner: 0xc02848,
  bannerShade: 0x82182e,
  gold: 0xf5c53d,
  goldShade: 0xbd8a1e,
  bone: 0xeae6d2,
  boneShade: 0xb8b49c,
  leaf: 0x4fbf4a,
  leafHi: 0x9ae660,
  leafShade: 0x2a7a32,
  pot: 0xb8643a,
  potShade: 0x7c3e22,
  bloom: 0xff7aa8,
  crystal: 0x46e6ff,
  crystalHi: 0xc8faff,
  crystalShade: 0x1b8cb4,
  crystalDeep: 0x2a56a8,
  parchment: 0xf0e2b0,
  ink: 0x4a3420,
} as const;

export const FX_COLORS = {
  white: WHITE,
  slashHi: 0xf4f8ff,
  slashMid: 0xb8cbff,
  slashLow: 0x7e92d8,
  arrowShaft: 0xb07a44,
  arrowHead: 0xe3eaf2,
  arrowFeather: 0xf0f0f0,
  boltHi: 0xe8ffff,
  bolt: 0x66f2ff,
  boltShade: 0x2aa8d8,
  orbHi: 0xffe8ff,
  orb: 0xe05aff,
  orbShade: 0x8a2ac0,
  shardHi: 0xe8e0ff,
  shard: 0x9a8aff,
  shardShade: 0x5a46c0,
  healHi: 0xeaffef,
  heal: 0x5be37d,
  healShade: 0x239a4a,
  hitHi: 0xffffff,
  hit: 0xffe27a,
  hitLow: 0xff9a3c,
  reviveHi: 0xffffff,
  revive: 0xfff08a,
  reviveGreen: 0x7dffb0,
  reviveDeep: 0x2fb87a,
  shadow: OUTLINE,
} as const;

export const UI_COLORS = {
  heartHi: 0xffb0bc,
  heart: 0xff4058,
  heartShade: 0xc0243c,
  heartEmpty: 0x4a3452,
  heartEmptyEdge: 0x2a1c34,
  checkGreen: 0x5be37d,
  crossRed: 0xff5a5a,
  skull: 0xeae6d2,
  skullShade: 0xb8b49c,
  keyGold: 0xf5c53d,
  keyShade: 0xbd8a1e,
  white: WHITE,
} as const;

/**
 * Lumière / obscurité : braseros, icônes de torche du HUD, braises (fx_ember_*), et couleurs du voile d'obscurité
 * (`DARK_*` ne figurent PAS dans l'atlas : le voile est dessiné par `src/render/darkness.ts`).
 */
/**
 * Sources de vie (nourriture au sol, cristaux de soin) : la nourriture réutilise le cœur de l'interface (UI_COLORS, sans cadre) ; le halo
 * (or = cœur entier, argent = demi-cœur) est un effet de rendu ; cristal de soin vert émeraude sur socle de pierre (vert = soin, distinct du cristal décoratif cyan),
 * version « vidée » grise une fois utilisé. Placeholders : à remplacer par de vrais sprites (voir docs/SPRITES.md).
 */
export const LOOT_COLORS = {
  spark: 0xffffff,
  crystalHi: 0xd8ffe8,
  crystal: 0x4fe39a,
  crystalShade: 0x1fa56a,
  crystalDeep: 0x147a52,
  baseHi: 0xa8a6c0,
  base: 0x6e6c88,
  baseShade: 0x4a4862,
  usedHi: 0x9aa8b2,
  used: 0x6b7a86,
  usedShade: 0x46525c,
} as const;

export const LIGHT_COLORS = {
  /** Charbon éteint / bois calciné. */
  coal: 0x2a1c26,
  coalHi: 0x4a2a30,
  /** Cendre froide. */
  ash: 0x7a7284,
  /** Reste de braise rougeoyante (brasero éteint, torche vide). */
  emberDull: 0x9a3220,
  /** Flammes (cœur blanc-jaune, jaune, orange, rouge profond). */
  flameCore: 0xfff6c8,
  flameYellow: 0xffe27a,
  flame: 0xff9a3c,
  flameDeep: 0xe0501e,
  /** Étincelle froide qui retombe (dernière frame de braise). */
  sparkFade: 0xc86a3a,
} as const;

/** Voile d'obscurité (hors atlas) : noir bleuté quasi opaque + teintes chaudes des lueurs. */
export const DARK_COLORS = {
  veil: 0x070a1a,
  /** Opacité du voile (le complément laisse deviner très faiblement le décor hors lumière). */
  veilAlpha: 0.94,
  glowBrazier: 0xff9a3c,
  glowDecor: 0xffa648,
  glowTorch: 0xffc46a,
} as const;

/** Couleurs des 4 slots (clés, marqueurs) : reprend PLAYER_COLORS + une teinte sombre dérivée. */
export const SLOT_COLORS: readonly number[] = PLAYER_COLORS;

/** Assombrit une couleur (facteur 0..1) — utilisé pour dériver les teintes sombres des slots. */
export function darken(c: number, f: number): number {
  const [r, g, b] = rgb(c);
  return (Math.round(r * f) << 16) | (Math.round(g * f) << 8) | Math.round(b * f);
}

/** Éclaircit une couleur (mélange vers le blanc, facteur 0..1). */
export function lighten(c: number, f: number): number {
  const [r, g, b] = rgb(c);
  return (Math.round(r + (255 - r) * f) << 16) | (Math.round(g + (255 - g) * f) << 8) | Math.round(b + (255 - b) * f);
}

/** Teinte sombre d'un slot (ombre des clés / gemmes). */
export const SLOT_SHADES: readonly number[] = PLAYER_COLORS.map((c) => darken(c, 0.62));
/** Teinte claire d'un slot (reflets). */
export const SLOT_LIGHTS: readonly number[] = PLAYER_COLORS.map((c) => lighten(c, 0.55));

// ───────────────────────────── Liste blanche ─────────────────────────────

function collect(obj: unknown, out: Set<number>): void {
  if (typeof obj === 'number') {
    out.add(obj);
  } else if (Array.isArray(obj)) {
    for (const v of obj) collect(v, out);
  } else if (obj && typeof obj === 'object') {
    for (const v of Object.values(obj as Record<string, unknown>)) collect(v, out);
  }
}

/** Toutes les couleurs autorisées dans l'atlas (aucun pixel ne doit en sortir). */
export const ALL_PALETTE_COLORS: ReadonlySet<number> = (() => {
  const s = new Set<number>();
  collect(
    [THEME_PALETTES, HERO_COLORS, ENEMY_COLORS, MINIBOSS_COLORS, BOSS_COLORS, HURT_COLORS, MECH_COLORS, PUZZLE_COLORS, RUNE_COLORS, DECOR_COLORS, FX_COLORS, UI_COLORS, LIGHT_COLORS, LOOT_COLORS, SLOT_SHADES, SLOT_LIGHTS, PLAYER_COLORS, OUTLINE, WHITE, EYE],
    s,
  );
  return s;
})();

/** Nombre de couleurs distinctes d'un thème (contrat : ≤ 12). */
export function themeColorCount(theme: ZoneTheme): number {
  const s = new Set<number>();
  collect(THEME_PALETTES[theme], s);
  return s.size;
}

/** Clés d'ennemis disposant d'une palette (les boss ont BOSS_COLORS). */
export type SmallEnemyKind = Extract<EnemyKind, 'slime' | 'bat' | 'skeleton' | 'archer' | 'spider' | 'wisp' | 'knight'>;
