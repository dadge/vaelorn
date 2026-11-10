/**
 * Torche personnelle : logique PURE de l'interface (jauge, niveau d'alerte, clignotement, couleurs).
 * Aucune dépendance à Phaser : testée sous Node. Le HUD (hud.ts) et le panneau d'équipe s'en servent.
 */
import { TORCH_LOW_FRACTION } from '../core/constants';
import { torchFuelFraction } from '../core/light';
import type { RoomDef } from '../core/types';

/** Niveau d'alerte d'une torche : pleine, faiblissante (< TORCH_LOW_FRACTION), éteinte (0). */
export type TorchLevel = 'full' | 'low' | 'empty';

/**
 * Fraction de combustible 0..1 (bornée ; jamais NaN) : la MÊME que celle qui fixe le rayon de la lumière de la torche
 * (`torchRadiusPx`, core/light.ts), donc la jauge et la lumière décroissent ensemble.
 */
export function torchFraction(torchMs: number): number {
  return torchFuelFraction(torchMs);
}

/** Niveau d'alerte pour un combustible donné. */
export function torchLevel(torchMs: number): TorchLevel {
  const f = torchFraction(torchMs);
  if (f <= 0) return 'empty';
  return f < TORCH_LOW_FRACTION ? 'low' : 'full';
}

/** Les icônes et jauges de torche ne s'affichent que dans les salles sombres. */
export function showTorchHud(room: Pick<RoomDef, 'dark'>): boolean {
  return room.dark === true;
}

/** Couleur de la barre de torche selon le niveau (ambre / orange / rouge). */
export function torchBarColor(level: TorchLevel): number {
  switch (level) {
    case 'full':
      return 0xffc24a;
    case 'low':
      return 0xff7a2a;
    default:
      return 0xff3a3a;
  }
}

/**
 * Opacité (0..1) du clignotement de la jauge : stable à 1 quand la torche est pleine, clignotement lent quand elle
 * faiblit, clignotement rapide quand elle est éteinte. Pure fonction du temps.
 */
export function torchBlinkAlpha(level: TorchLevel, timeMs: number): number {
  if (level === 'full') return 1;
  const period = level === 'low' ? 700 : 380;
  const s = 0.5 + 0.5 * Math.sin((timeMs / period) * Math.PI * 2);
  return level === 'low' ? 0.55 + 0.45 * s : 0.3 + 0.7 * s;
}

/** Largeur (px) de la partie remplie d'une barre de `fullW` pixels : au moins 1 px tant qu'il reste du combustible. */
export function torchBarWidth(torchMs: number, fullW: number): number {
  const f = torchFraction(torchMs);
  if (f <= 0) return 0;
  return Math.max(1, Math.round(fullW * f));
}
