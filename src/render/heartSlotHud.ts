/**
 * EMPLACEMENT CŒUR — logique PURE du rendu du HUD (testée) : quelle frame et quelle teinte pour l'emplacement d'un joueur. Aucune dépendance à Phaser : l'habillage vit dans `hud.ts`.
 *
 *  - plein : le cœur ou le demi-cœur rangé, avec les MÊMES frames que les cœurs de PV de l'interface (`ui_heart_full` / `ui_heart_half`, dessin de `art/ui.ts`) ;
 *  - vide : silhouette de cœur atténuée (même teinte que les emplacements d'équipement vides) ;
 *  - aucun clignotement : l'aspect ne dépend que du contenu de l'emplacement.
 */
import type { PickupKind } from '../core/types';

/** Teinte d'un emplacement cœur vide (la même que celle des emplacements d'équipement vides). */
export const HEART_SLOT_EMPTY_TINT = 0x9a96b8;
/** Opacité de la silhouette d'un emplacement cœur vide. */
export const HEART_SLOT_EMPTY_ALPHA = 0.32;
/** Couleur du liseré de l'emplacement (discret ; celle du cadre des emplacements d'équipement). */
export const HEART_SLOT_BORDER_COLOR = 0x6c6a8e;

/** Aspect d'un emplacement cœur. */
export interface HeartSlotView {
  /** Frame de l'atlas (`ui_heart_full` | `ui_heart_half`). */
  frame: string;
  /** Teinte (null = aucune : couleurs d'origine). */
  tint: number | null;
  alpha: number;
  /** Vrai si l'emplacement est vide. */
  empty: boolean;
}

/** Aspect de l'emplacement pour un contenu donné (`undefined` = vide ; valeur inconnue = vide). */
export function heartSlotView(kind: PickupKind | undefined): HeartSlotView {
  if (kind === 'full') return { frame: 'ui_heart_full', tint: null, alpha: 1, empty: false };
  if (kind === 'half') return { frame: 'ui_heart_half', tint: null, alpha: 1, empty: false };
  return { frame: 'ui_heart_full', tint: HEART_SLOT_EMPTY_TINT, alpha: HEART_SLOT_EMPTY_ALPHA, empty: true };
}

/** Couleur du liseré quand un cœur rangé PEUT servir (le joueur est blessé) : rappel fixe et discret, jamais clignotant. */
export const HEART_SLOT_READY_BORDER_COLOR = 0xffd27a;

/** Liseré de l'emplacement : doré (fixe) si un cœur est rangé ET que le joueur est blessé (B a un effet), sinon le liseré discret habituel. */
export function heartSlotBorderColor(kind: PickupKind | undefined, wounded: boolean): number {
  return (kind === 'full' || kind === 'half') && wounded ? HEART_SLOT_READY_BORDER_COLOR : HEART_SLOT_BORDER_COLOR;
}

/** Signature du contenu et du rappel (le HUD ne redessine que si elle change). */
export function heartSlotSignature(kind: PickupKind | undefined, wounded = false): string {
  const k = kind === 'full' || kind === 'half' ? kind : '-';
  return wounded ? k + '!' : k;
}

/** Libellé du rappel de bouton : la lettre / touche, suivie d'un « ½ » quand l'emplacement contient un DEMI-cœur (distinction lisible même quand l'icône est minuscule : écran réduit, 4 joueurs). */
export function heartSlotHintText(label: string, kind: PickupKind | undefined): string {
  return kind === 'half' ? label + '½' : label;
}
