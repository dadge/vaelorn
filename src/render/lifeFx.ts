/**
 * Sources de vie — fonctions PURES de rendu (testées) : clignotement des 3 dernières secondes de la nourriture au sol, flottement,
 * clés i18n et couleurs des textes flottants, choix de frames. Aucune dépendance à Phaser : l'habillage vit dans `entities/LifeViews.ts`.
 */
import { LOOT_FULL_HEAL, LOOT_HALF_HEAL, PICKUP_BLINK_MS } from '../core/balance';
import type { PickupKind } from '../core/types';

/** Couleur du halo d'une nourriture (cœur entier : doré ; demi-cœur : argenté). */
export function pickupHaloColor(kind: PickupKind): number {
  return kind === 'full' ? 0xffe27a : 0xdfe8ff;
}

/** Frame d'atlas d'une nourriture. */
export function pickupFrame(kind: PickupKind): string {
  return kind === 'full' ? 'pickup_full' : 'pickup_half';
}

/** Opacité fixe d'une nourriture qui va disparaître quand l'utilisateur demande moins d'animation (`prefers-reduced-motion`) : pas de clignotement. */
export const PICKUP_REDUCED_ALPHA = 0.55;

/**
 * Opacité d'une nourriture au sol : 1 tant qu'il lui reste plus de `PICKUP_BLINK_MS` de vie ; ensuite elle clignote
 * (plein / presque éteint) à 2 Hz, puis à 3 Hz pendant la dernière seconde (jamais plus de 3 flashs par seconde : sûr pour la photosensibilité).
 * Avec `reducedMotion` : aucun clignotement, opacité fixe `PICKUP_REDUCED_ALPHA` pendant les 3 dernières secondes.
 * Dépend uniquement de `ttlMs`, du temps de jeu et de la préférence.
 */
export function pickupAlpha(ttlMs: number, timeMs: number, reducedMotion = false): number {
  if (!(ttlMs <= PICKUP_BLINK_MS)) return 1;
  if (reducedMotion) return PICKUP_REDUCED_ALPHA;
  const halfPeriodMs = ttlMs > 1000 ? 250 : 167;
  return Math.floor(Math.max(0, timeMs) / halfPeriodMs) % 2 === 0 ? 1 : 0.2;
}

/** Petit flottement vertical (px) d'une nourriture au sol, déphasé par son id ; nul avec `reducedMotion`. */
export function pickupBob(timeMs: number, id: number, reducedMotion = false): number {
  if (reducedMotion) return 0;
  return Math.sin(timeMs / 240 + id * 1.7) * 1.2;
}

/** Texte flottant d'un ramassage : la valeur nominale (« +½ ♥ » / « +♥ ») quand le soin est complet, sinon « +N PV » (soin plafonné au manque). */
export function pickupTextFor(kind: PickupKind, healed: number): { key: string; params?: { n: number } } {
  const nominal = kind === 'full' ? LOOT_FULL_HEAL : LOOT_HALF_HEAL;
  if (healed < nominal) return { key: 'loot.crystal.heal', params: { n: Math.max(0, Math.round(healed)) } };
  return { key: pickupTextKey(kind) };
}

/** Clé i18n du texte flottant du ramassage : « +½ ♥ » (demi-cœur) / « +♥ » (cœur entier). */
export function pickupTextKey(kind: PickupKind): string {
  return kind === 'full' ? 'loot.pickup.full' : 'loot.pickup.half';
}

/** Couleur du texte flottant du ramassage. */
export function pickupTextColor(kind: PickupKind): number {
  return kind === 'full' ? 0xff4058 : 0xff8fa0;
}

/** Couleur du halo et des étincelles d'un cristal de soin. */
export const CRYSTAL_HALO_COLOR = 0x5be3a0;

/** Frame d'un cristal de soin : vidé → `heal_crystal_used` ; sinon alternance des 2 frames d'éclat toutes les 450 ms. */
export function crystalFrame(used: boolean, timeMs: number): string {
  if (used) return 'heal_crystal_used';
  return Math.floor(Math.max(0, timeMs) / 450) % 2 === 0 ? 'heal_crystal_0' : 'heal_crystal_1';
}
