/**
 * Zone RÉSERVÉE à la minicarte, au centre de l'écran partagé (PUR : aucune dépendance à Phaser ni au DOM).
 *
 * Contrat partagé entre le HUD (aucun texte permanent dans cette zone) et la minicarte (elle y tient entièrement) :
 *  - 2, 3 et 4 joueurs : rectangle centré sur le centre de l'écran (milieu du séparateur vertical, croisement des
 *    séparateurs à 3-4 joueurs) ;
 *  - 1 joueur (ou invité réseau : une seule vue plein écran) : aucune zone centrale (`null`) ; la carte se place alors
 *    elle-même sur le bord droit (voir `miniMap.ts`).
 * La taille est proportionnelle à l'écran logique (300 x 200 px à 1280 x 720).
 */
import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import type { ScreenRect, SplitLayout } from './splitscreen';

/** Part de la largeur / de la hauteur de l'écran occupée par la zone centrale. */
export const MAP_ZONE_WIDTH_RATIO = 0.235;
export const MAP_ZONE_HEIGHT_RATIO = 0.278;

/** Rectangle écran de la zone réservée à la carte, ou `null` quand il n'y a qu'une vue (pas de centre partagé). */
export function mapZone(layout: SplitLayout, width: number = GAME_WIDTH, height: number = GAME_HEIGHT): ScreenRect | null {
  if (layout.playerCount < 2) return null;
  const w = Math.round(width * MAP_ZONE_WIDTH_RATIO);
  const h = Math.round(height * MAP_ZONE_HEIGHT_RATIO);
  return { x: Math.round((width - w) / 2), y: Math.round((height - h) / 2), w, h };
}
