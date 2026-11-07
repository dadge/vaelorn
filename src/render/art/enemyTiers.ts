/**
 * Gabarit de sprite par type d'ennemi (PUR, aucune dépendance à Phaser) : table de RENDU uniquement, aucune règle de jeu.
 *
 *  - 'small' : ennemi standard 16×16, frames `enemy_<kind>_<0|1>` (le rendu fait flipX) ;
 *  - 'mini'  : demi-boss 32×32 (niveaux 4-6), frames `miniboss_<kind>_<0|1>` + `miniboss_<kind>_hurt` ;
 *  - 'boss'  : boss de fin 48×48, frames `boss_<kind>_<0|1>` + `boss_<kind>_hurt`.
 *
 * `ENEMY_SPRITES` est un `Record<EnemyKind, …>` : ajouter un `EnemyKind` sans l'ajouter ici est une erreur de compilation.
 * Tous les sprites restent à l'échelle 1:1 (DESIGN §4) : un demi-boss est dessiné en 32×32, jamais un 16×16 agrandi.
 */
import type { EnemyKind } from '../../core/types';

export type SpriteTier = 'small' | 'mini' | 'boss';

export interface EnemySpriteInfo {
  tier: SpriteTier;
  /** Côté (px) de la frame carrée. */
  size: 16 | 32 | 48;
  /** Préfixe des noms de frames. */
  prefix: 'enemy' | 'miniboss' | 'boss';
  /** Décalage vertical (px) du dessin par rapport au centre de l'ennemi (les pieds touchent le sol). */
  drawOffsetY: number;
  /** Distance (px) centre → pieds, pour le tri en profondeur, l'ombre et la barre de PV. `null` = rayon de l'ennemi. */
  footOffsetY: number | null;
  /** Échelle (x, y) de l'ombre ovale au sol. */
  shadowScale: [number, number];
  /** Opacité de base de l'ombre. */
  shadowAlpha: number;
}

const SMALL: EnemySpriteInfo = { tier: 'small', size: 16, prefix: 'enemy', drawOffsetY: -2, footOffsetY: null, shadowScale: [1, 1], shadowAlpha: 0.4 };
const MINI: EnemySpriteInfo = { tier: 'mini', size: 32, prefix: 'miniboss', drawOffsetY: -4, footOffsetY: 13, shadowScale: [1.9, 1.5], shadowAlpha: 0.34 };
const BOSS: EnemySpriteInfo = { tier: 'boss', size: 48, prefix: 'boss', drawOffsetY: -6, footOffsetY: 18, shadowScale: [2.8, 2.2], shadowAlpha: 0.3 };

export const ENEMY_SPRITES: Readonly<Record<EnemyKind, EnemySpriteInfo>> = {
  slime: SMALL,
  bat: SMALL,
  skeleton: SMALL,
  archer: SMALL,
  spider: SMALL,
  wisp: SMALL,
  knight: SMALL,
  golem: BOSS,
  morvane: BOSS,
  warden: MINI,
  frostqueen: BOSS,
  pyromancer: MINI,
  forgelord: BOSS,
  wraith: MINI,
  voidlord: BOSS,
};

/** Tous les types d'ennemis connus du rendu (ordre de la table). */
export const RENDERED_ENEMY_KINDS = Object.keys(ENEMY_SPRITES) as EnemyKind[];

/** Gabarit de sprite d'un ennemi ; un type inconnu (donnée corrompue) est rendu comme un petit ennemi. */
export function enemySpriteInfo(kind: string): EnemySpriteInfo {
  return (ENEMY_SPRITES as Readonly<Record<string, EnemySpriteInfo | undefined>>)[kind] ?? SMALL;
}

/** Gabarit (small | mini | boss) d'un type d'ennemi. */
export function spriteTier(kind: string): SpriteTier {
  return enemySpriteInfo(kind).tier;
}

/** Les types à frames « hurt » (demi-boss et boss) : silhouette de dégâts à la place de l'animation. */
export function hasHurtFrame(kind: string): boolean {
  return spriteTier(kind) !== 'small';
}

/** Types de boss de fin de niveau (sprite 48×48). */
export function isBossTier(kind: string): boolean {
  return spriteTier(kind) === 'boss';
}

/** Types de demi-boss (sprite 32×32). */
export function isMiniBossTier(kind: string): boolean {
  return spriteTier(kind) === 'mini';
}
