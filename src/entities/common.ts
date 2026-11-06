/**
 * Éléments communs aux vues Phaser (entités, salle) : contexte partagé, profondeurs d'affichage.
 * Les vues LISENT GameState : aucune règle de jeu ici.
 */
import type Phaser from 'phaser';
import type { FxManager } from '../render/fx';
import type { ViewRig } from '../render/camera';

/** Tout ce dont une vue a besoin pour créer et enregistrer ses objets Phaser. */
export interface ViewContext {
  scene: Phaser.Scene;
  rig: ViewRig;
  fx: FxManager;
  /** Zoom entier de caméra (3 pour 1-2 joueurs, 2 pour 3-4). */
  zoom: number;
  playerCount: number;
}

/**
 * Profondeurs d'affichage (plus grand = devant). Les objets « debout » (héros, ennemis, blocs, décors, portes fermées)
 * sont triés par Y : `ySortDepth(y)`.
 */
export const DEPTH = {
  floor: 0,
  /** Marquages au sol : zones, cadres de runes, tuiles de sortie. */
  decal: 2,
  /** Plaques, réceptacles, portes ouvertes. */
  flat: 3,
  /** Anneau de couleur sous les héros. */
  ring: 5,
  shadow: 6,
  /** Base du tri par Y. */
  ySortBase: 10,
  /** Télégraphes d'attaque des ennemis. */
  telegraph: 4000,
} as const;

/** Profondeur d'un objet debout dont le « pied » est à l'ordonnée `footY` (px monde). */
export function ySortDepth(footY: number): number {
  return DEPTH.ySortBase + footY;
}

/** Bits de rendu communs aux objets qui disparaissent proprement. */
export interface Destroyable {
  destroy(): void;
}
