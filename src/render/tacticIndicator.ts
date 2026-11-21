/**
 * INDICATEUR DES TACTIQUES DE BOSS (« boss malins ») — géométrie PURE (aucune dépendance Phaser) : traduit les clés `data.tact*` d'un boss tactique (voir `core/tactics.ts`) en formes à dessiner
 * par `EnemyView.ts` avec de simples primitives Graphics (aucun atlas).
 *
 * Ce que le joueur voit (lisible sans la couleur : chaque tactique a sa FORME) :
 *  - une icône au-dessus du boss : anneau (veille d'un joueur à terre), losange (garde d'un cristal), croix (écoute un appel), triangle (poursuit un porteur de cœur),
 *    carré (se poste sur un bonus), chevron (traque le plus faible) ; icône grisée avec des étoiles quand le boss est DÉSTABILISÉ (aucun but) ;
 *  - une ligne pointillée du boss vers sa cible et un anneau qui pulse à l'ancre ;
 *  - rien du tout pour un boss sans tactiques ou sans but (aucune forme, aucune allocation).
 * Teintes : violet (veille), cyan (cristal), rouge (appel), orange (porteur de cœur), or (bonus), rose (proie), gris (déstabilisé).
 */
import type { BossTacticId } from '../core/types';

/** Formes d'icône (une par tactique + l'état déstabilisé). */
export type TacticIcon = 'ring' | 'diamond' | 'cross' | 'triangle' | 'square' | 'chevron' | 'dazed';

export type TacticShape =
  | { kind: 'icon'; icon: TacticIcon; x: number; y: number; size: number; color: number; alpha: number }
  | { kind: 'stars'; x: number; y: number; r: number; phase: number; color: number }
  | { kind: 'dashed'; x0: number; y0: number; x1: number; y1: number; color: number; alpha: number }
  | { kind: 'anchor'; x: number; y: number; r: number; color: number; alpha: number };

/** Code d'affichage d'un boss déstabilisé (`tactics.ts` : TACT_DAZED). */
export const TACTIC_DAZED_KIND = 7;

const ICONS: Readonly<Record<number, TacticIcon>> = { 1: 'ring', 2: 'diamond', 3: 'cross', 4: 'triangle', 5: 'square', 6: 'chevron', 7: 'dazed' };
const COLORS: Readonly<Record<number, number>> = { 1: 0xb06cff, 2: 0x40e0ff, 3: 0xff4a4a, 4: 0xff9a3c, 5: 0xffd23c, 6: 0xff5aa0, 7: 0x9a9aa8 };
const NAMES: Readonly<Record<number, BossTacticId | 'dazed'>> = {
  1: 'guardDowned',
  2: 'campCrystal',
  3: 'heedCalls',
  4: 'interceptCarrier',
  5: 'seizeItems',
  6: 'huntWeak',
  7: 'dazed',
};

/** Teinte (0xRRGGBB) d'un code d'affichage (1..7) ; blanc pour un code inconnu. */
export function tacticColor(kind: number): number {
  return COLORS[kind] ?? 0xffffff;
}

/** Forme d'icône d'un code d'affichage (1..7), ou null (0 / inconnu). */
export function tacticIcon(kind: number): TacticIcon | null {
  return ICONS[kind] ?? null;
}

/** Identifiant de la tactique d'un code d'affichage (1..6), 'dazed' (7), ou null. */
export function tacticNameOf(kind: number): BossTacticId | 'dazed' | null {
  return NAMES[kind] ?? null;
}

/** Clé i18n du libellé d'un code d'affichage (`tactic.label.<id>` / `tactic.label.dazed`), ou null. */
export function tacticLabelKey(kind: number): string | null {
  const n = tacticNameOf(kind);
  return n === null ? null : `tactic.label.${n}`;
}

function num(v: number | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Les 7 clés de libellé (parité fr/en testée) : 6 tactiques + déstabilisé. */
export const TACTIC_LABEL_KEYS: readonly string[] = [1, 2, 3, 4, 5, 6, 7].map((k) => `tactic.label.${NAMES[k]}`);

/**
 * Formes de l'indicateur d'un boss tactique, centrées sur sa position de rendu (x, y) ; `headY` = distance (px) de l'icône au-dessus de (x, y) ; `timeMs` anime la pulsation.
 * Retourne [] si le boss n'a aucun but ni déstabilisation (`tactKind` absent ou 0) : un boss sans tactiques ne dessine jamais rien.
 */
export function tacticShapes(data: Readonly<Record<string, number>>, x: number, y: number, headY: number, timeMs: number): TacticShape[] {
  const kind = Math.floor(num(data.tactKind));
  const icon = tacticIcon(kind);
  if (icon === null) return [];
  const color = tacticColor(kind);
  const out: TacticShape[] = [];
  const pulse = 0.5 + 0.5 * Math.sin(timeMs / 180);
  if (kind === TACTIC_DAZED_KIND) {
    out.push({ kind: 'icon', icon, x, y: y - headY, size: 5, color, alpha: 0.7 });
    out.push({ kind: 'stars', x, y: y - headY - 5, r: 7, phase: timeMs / 260, color: 0xffe27a });
    return out;
  }
  out.push({ kind: 'icon', icon, x, y: y - headY, size: 5 + pulse, color, alpha: 0.95 });
  const ax = num(data.tactX);
  const ay = num(data.tactY);
  if (ax !== 0 || ay !== 0) {
    out.push({ kind: 'dashed', x0: x, y0: y, x1: ax, y1: ay, color, alpha: 0.45 + 0.25 * pulse });
    out.push({ kind: 'anchor', x: ax, y: ay, r: 6 + 4 * pulse, color, alpha: 0.5 + 0.4 * pulse });
  }
  return out;
}
