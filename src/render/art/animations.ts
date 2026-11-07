/**
 * Helpers PURS de noms de frames (aucune dépendance à Phaser) : traduisent un état de jeu en nom de frame
 * de l'atlas. Les scènes/entités ne composent jamais un nom à la main : elles passent par ici.
 */
import type { CharacterId, Dir, EnemyKind, TileGlyph, ZoneTheme } from '../../core/types';
import { hash2 } from './bitmap';
import { RUNE_NAMES } from './contract';
import { enemySpriteInfo } from './enemyTiers';

export type HeroAnimState = 'walk' | 'attack' | 'downed';
/** Types disposant de frames « hurt » (demi-boss 32×32 et boss 48×48). */
export type BossKind = Extract<EnemyKind, 'golem' | 'morvane' | 'warden' | 'frostqueen' | 'pyromancer' | 'forgelord' | 'wraith' | 'voidlord'>;

/** Normalise un compteur d'animation en 0 | 1. */
export function stepOf(n: number): 0 | 1 {
  return (((Math.floor(n) % 2) + 2) % 2) as 0 | 1;
}

/**
 * Frame d'un héros.
 *  - 'walk'   → hero_<id>_<dir>_<step>   (step 0|1 alterné pendant la marche, 0 à l'arrêt)
 *  - 'attack' → hero_<id>_<dir>_attack   (step ignoré)
 *  - 'downed' → hero_<id>_downed         (dir/step ignorés)
 */
export function heroFrame(characterId: CharacterId, dir: Dir, step: 0 | 1, state: HeroAnimState = 'walk'): string {
  if (state === 'downed') return `hero_${characterId}_downed`;
  if (state === 'attack') return `hero_${characterId}_${dir}_attack`;
  return `hero_${characterId}_${dir}_${step}`;
}

/**
 * Frame d'un ennemi (2 frames : step 0|1, pas de gauche/droite → flipX côté rendu).
 *  - ennemis standards : `enemy_<kind>_<step>` (16×16) ;
 *  - demi-boss (warden, pyromancer, wraith) : `miniboss_<kind>_<step>` (32×32) ;
 *  - boss (golem, morvane, frostqueen, forgelord, voidlord) : `boss_<kind>_<step>` (48×48).
 */
export function enemyFrame(kind: EnemyKind, step: number): string {
  return `${enemySpriteInfo(kind).prefix}_${kind}_${stepOf(step)}`;
}

/** Frame d'un demi-boss / boss ; `hurt` = silhouette de dégâts (flash) à la place de l'animation. */
export function bossFrame(kind: BossKind, step: number, hurt = false): string {
  const prefix = enemySpriteInfo(kind).prefix;
  return hurt ? `${prefix}_${kind}_hurt` : `${prefix}_${kind}_${stepOf(step)}`;
}

/** Part (0..1) de sols « alt » parmi les sols '.' (variété visuelle déterministe). */
export const FLOOR_ALT_RATIO = 0.18;

/**
 * Frame d'une tuile de grille.
 *  - '.'  → floor, ou floor_alt pour ~18 % des cases (choix déterministe selon x,y)
 *  - ','  → floor_alt
 *  - '#'  → wall (face) ; wall_top (dessus) si `below` (glyphe de la tuile SUD) est un mur, le vide, ou `null` (hors grille).
 *           Sans `below` : wall (face).
 *  - 'o' pilier, '~' fosse, ' ' vide.
 * Note : 'wall' = face visible quand la tuile du dessous est praticable ; 'wall_top' = masse de mur intérieure.
 */
export function tileFrame(theme: ZoneTheme, glyph: TileGlyph, x: number, y: number, below?: TileGlyph | null): string {
  switch (glyph) {
    case '#':
      return `tile_${theme}_${below === null || below === '#' || below === ' ' ? 'wall_top' : 'wall'}`;
    case 'o':
      return `tile_${theme}_pillar`;
    case '~':
      return `tile_${theme}_pit`;
    case ' ':
      return `tile_${theme}_void`;
    case ',':
      return `tile_${theme}_floor_alt`;
    default:
      return `tile_${theme}_${hash2(x, y, 4242) < FLOOR_ALT_RATIO ? 'floor_alt' : 'floor'}`;
  }
}

/** Frame d'un glyphe de rune (`sun|moon|star|eye|flame|wave`) ; symbole inconnu → cadre vide `rune_frame`. */
export function runeFrame(symbol: string): string {
  return RUNE_NAMES.includes(symbol) ? `rune_${symbol}` : 'rune_frame';
}

/** Frame de clé pour un slot (0..3, replié modulo 4) : `key_<slot>`. */
export function keyFrame(slot: number): string {
  return `key_${(((Math.floor(slot) % 4) + 4) % 4)}`;
}

/** Icône de clé 8×8 pour l'UI : `ui_key_<slot>`. */
export function uiKeyFrame(slot: number): string {
  return `ui_key_${(((Math.floor(slot) % 4) + 4) % 4)}`;
}

/** Arc d'épée d'une attaque de mêlée : `fx_slash_<dir>` (24×24). */
export function slashFrame(dir: Dir): string {
  return `fx_slash_${dir}`;
}

/** Projectile : `fx_<kind>` (8×8, orienté vers la droite → pivoter selon la vitesse). */
export function projectileFrame(kind: 'arrow' | 'bolt' | 'orb' | 'shard' | 'heal'): string {
  return `fx_${kind}`;
}

/** Impact (`step` 0..2) : `fx_hit_<step>`. */
export function hitFrame(step: number): string {
  return `fx_hit_${Math.max(0, Math.min(2, Math.floor(step)))}`;
}

/** Relevage (`step` 0..3) : `fx_revive_<step>`. */
export function reviveFrame(step: number): string {
  return `fx_revive_${Math.max(0, Math.min(3, Math.floor(step)))}`;
}

/** Plaque de pression : `plate_down` si pressée, sinon `plate_up`. */
export function plateFrame(active: boolean): string {
  return active ? 'plate_down' : 'plate_up';
}

/** Levier : `lever_on` / `lever_off`. */
export function leverFrame(active: boolean): string {
  return active ? 'lever_on' : 'lever_off';
}

/** Porte : `door_closed` / `door_open` (la sortie scellée utilise `door_sealed`). */
export function doorFrame(open: boolean): string {
  return open ? 'door_open' : 'door_closed';
}

/** Réceptacle 2×2 : `socket_filled` si actif, sinon `socket`. */
export function socketFrame(active: boolean): string {
  return active ? 'socket_filled' : 'socket';
}

/** Sortie : `exit_open` si les conditions sont remplies, sinon `exit_closed` (ou `door_sealed` si scellée). */
export function exitFrame(open: boolean, sealed = false): string {
  if (open) return 'exit_open';
  return sealed ? 'door_sealed' : 'exit_closed';
}

/** Torche animée : `decor_torch_<0|1>` ; `timeMs` pilote l'alternance (≈ 4 Hz). */
export function torchFrame(timeMs: number): string {
  return `decor_torch_${stepOf(timeMs / 250)}`;
}

/** Cœur de PV d'indice `index` : `ui_heart_full|half|empty` selon `hp` et le nombre de PV représentés par un cœur (`hpPerHeart`). */
export function heartFrame(index: number, hp: number, hpPerHeart: number): string {
  const rest = hp - index * hpPerHeart;
  if (rest >= hpPerHeart) return 'ui_heart_full';
  if (rest >= hpPerHeart / 2) return 'ui_heart_half';
  return 'ui_heart_empty';
}

/** Période (ms) d'une frame de flamme de brasero (≈ 5,5 Hz : vive, un peu plus nerveuse que la torche murale). */
export const BRAZIER_FRAME_MS = 180;

/** Brasero : `brazier_unlit` (éteint) ou `brazier_lit_<0|1>` (allumé, flamme animée selon `timeMs`). */
export function brazierFrame(lit: boolean, timeMs: number): string {
  if (!lit) return 'brazier_unlit';
  return `brazier_lit_${stepOf((Number.isFinite(timeMs) ? timeMs : 0) / BRAZIER_FRAME_MS)}`;
}

/**
 * Icône de torche du HUD selon la fraction de combustible restante (0..1, valeurs hors bornes/NaN tolérées) :
 * `ui_torch_full` (≥ 50 %), `ui_torch_half` (> 0 %), `ui_torch_empty` (torche éteinte).
 */
export function torchIconFrame(fraction: number): string {
  if (!Number.isFinite(fraction) || fraction <= 0) return 'ui_torch_empty';
  return fraction >= 0.5 ? 'ui_torch_full' : 'ui_torch_half';
}

/** Braise 8×8 selon l'avancement de sa vie `progress` 0..1 (0 = vive, 1 = mourante) : `fx_ember_0..2`. */
export function emberFrame(progress: number): string {
  const p = Number.isFinite(progress) ? Math.max(0, Math.min(0.9999, progress)) : 0;
  return `fx_ember_${Math.floor(p * 3)}`;
}

// ───────────────────────────── Mécanismes des niveaux 4-6 ─────────────────────────────

/** Statue jumelle regardant `dir` : `statuepair_<dir>` (yeux cyan) ou `statuepair_<dir>_lit` (puzzle résolu, vert). */
export function statueFrame(dir: Dir, solved: boolean): string {
  return `statuepair_${dir}${solved ? '_lit' : ''}`;
}

/** Nombre de niveaux de sable du sablier (frames `hourglass_0` … `hourglass_4`). */
export const HOURGLASS_SAND_LEVELS = 4;

/** Sablier selon la fraction de sable restante (0..1, hors bornes/NaN tolérés) : `hourglass_<0..4>` ; vide uniquement si fraction ≤ 0. */
export function hourglassFrame(fraction: number): string {
  const f = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
  const level = f <= 0 ? 0 : Math.max(1, Math.round(f * HOURGLASS_SAND_LEVELS));
  return `hourglass_${level}`;
}

/** Tuile de herse : `gate_closed` (barreaux) ou `gate_open` (relevée). */
export function gateFrame(closed: boolean): string {
  return closed ? 'gate_closed' : 'gate_open';
}

/** Tuile de pont de lumière : `bridge_lit` (planches de lumière) ou `bridge_dark` (abîme). */
export function bridgeFrame(lit: boolean): string {
  return lit ? 'bridge_lit' : 'bridge_dark';
}

/** Lanterne du porteur : `lantern_<0|1>`, vacille à ~7 Hz. */
export function lanternFrame(timeMs: number): string {
  return `lantern_${stepOf((Number.isFinite(timeMs) ? timeMs : 0) / 140)}`;
}
