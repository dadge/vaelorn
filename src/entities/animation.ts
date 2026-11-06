/**
 * Aides d'animation PURES (aucune dépendance à Phaser) : choix de frames, clignotements, interpolation de position.
 * Les vues Phaser (PlayerView, EnemyView…) s'en servent pour rester de simples « lecteurs » de GameState.
 */
import type { Dir, EnemyState, PlayerState } from '../core/types';
import { enemyFrame, heroFrame, bossFrame, reviveFrame, stepOf } from '../render/art/animations';

/** Durée (ms) d'une frame de marche d'un héros. */
export const WALK_FRAME_MS = 140;
/** Durée (ms) d'une frame d'animation d'ennemi. */
export const ENEMY_FRAME_MS = 240;
/** Période (ms) du clignotement d'invulnérabilité. */
export const INVULN_BLINK_MS = 90;
/** Période (ms) de l'alternance blanc/rouge du télégraphe d'attaque. */
export const WINDUP_BLINK_MS = 100;
/** Durée (ms) du flash rouge d'un héros touché. */
export const HERO_HIT_FLASH_MS = 140;

export const COLOR_WHITE = 0xffffff;
export const COLOR_WARN_RED = 0xff3a3a;
export const COLOR_STUN = 0x9ab4ff;

/** Frame de marche 0|1 : alterne tant que le héros bouge, 0 à l'arrêt. */
export function walkStep(timeMs: number, moving: boolean): 0 | 1 {
  if (!moving) return 0;
  return stepOf(timeMs / WALK_FRAME_MS);
}

/** Frame d'animation (0|1) d'un ennemi ; `id` décale les ennemis entre eux pour éviter le « pas de l'oie ». */
export function enemyStep(timeMs: number, id: number): 0 | 1 {
  return stepOf(timeMs / ENEMY_FRAME_MS + id);
}

/** Vrai si le héros doit être dessiné pendant l'invulnérabilité (clignote ; toujours visible hors invulnérabilité). */
export function invulnVisible(invulnMs: number): boolean {
  if (!(invulnMs > 0)) return true;
  return Math.floor(invulnMs / INVULN_BLINK_MS) % 2 === 0;
}

/** Nom de la frame du héros pour son état courant (à terre / attaque / marche). */
export function heroFrameFor(p: PlayerState, timeMs: number): string {
  if (p.status === 'down') return heroFrame(p.characterId, p.facing, 0, 'downed');
  if (p.attackAnimMs > 0) return heroFrame(p.characterId, p.attackDir, 0, 'attack');
  return heroFrame(p.characterId, p.facing, walkStep(timeMs, p.moving), 'walk');
}

/** Vecteur unitaire d'une direction. */
export function dirVector(dir: Dir): { x: number; y: number } {
  switch (dir) {
    case 'up':
      return { x: 0, y: -1 };
    case 'down':
      return { x: 0, y: 1 };
    case 'left':
      return { x: -1, y: 0 };
    default:
      return { x: 1, y: 0 };
  }
}

/** Opacité de l'arc d'épée selon le temps d'animation restant (apparition franche, fondu à la fin). */
export function slashAlpha(attackAnimMs: number, totalMs: number): number {
  if (!(attackAnimMs > 0) || !(totalMs > 0)) return 0;
  const left = Math.min(1, attackAnimMs / totalMs);
  return Math.min(1, left * 1.8);
}

/** Frame (0..3) de l'effet de relevage, animée à ~8 Hz. */
export function reviveFxFrame(timeMs: number): string {
  return reviveFrame(Math.floor(timeMs / 120) % 4);
}

// ───────────────────────────── Interpolation de position ─────────────────────────────

/** Distance (px) au-delà de laquelle un déplacement est considéré comme une téléportation (pas d'interpolation). */
export const INTERP_TELEPORT_DISTANCE = 28;

/**
 * Interpolation de rendu entre deux pas de simulation : `push` à chaque nouvel état, `at(alpha)` à chaque frame
 * (alpha ∈ [0,1] = part du pas de simulation déjà écoulée). Les sauts (téléportation, nouvelle salle) ne sont pas lissés.
 */
export class PosInterp {
  px = 0;
  py = 0;
  cx = 0;
  cy = 0;
  /** Position interpolée courante (mise à jour par `at`). */
  x = 0;
  y = 0;

  constructor(x = 0, y = 0) {
    this.reset(x, y);
  }

  /** Place directement les positions précédente et courante. */
  reset(x: number, y: number): void {
    this.px = this.cx = this.x = x;
    this.py = this.cy = this.y = y;
  }

  /** Nouvelle position issue d'un pas de simulation. */
  push(x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (Math.abs(x - this.cx) > INTERP_TELEPORT_DISTANCE || Math.abs(y - this.cy) > INTERP_TELEPORT_DISTANCE) {
      this.px = x;
      this.py = y;
    } else {
      this.px = this.cx;
      this.py = this.cy;
    }
    this.cx = x;
    this.cy = y;
  }

  /** Position interpolée pour `alpha` ∈ [0,1] ; met à jour et retourne `this` (lire `x`/`y`). */
  at(alpha: number): this {
    const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
    this.x = this.px + (this.cx - this.px) * a;
    this.y = this.py + (this.cy - this.py) * a;
    return this;
  }
}

// ───────────────────────────── Aspect d'un ennemi ─────────────────────────────

/** Aspect visuel d'un ennemi à un instant donné (objet réutilisable : `computeEnemyVisual` le remplit). */
export interface EnemyVisual {
  frame: string;
  flipX: boolean;
  /** Teinte « remplissage » (silhouette unie) ou -1 si aucune : flash de dégâts, télégraphe d'attaque. */
  tintFill: number;
  /** Teinte multiplicative (0xffffff = aucune). */
  tint: number;
  alpha: number;
  /** Décalage de dessin (px) : tremblement du télégraphe, élan de l'attaque. */
  offsetX: number;
  offsetY: number;
  /** L'ennemi est-il en train de télégraphier une attaque ? */
  windup: boolean;
}

export function createEnemyVisual(): EnemyVisual {
  return { frame: '', flipX: false, tintFill: -1, tint: COLOR_WHITE, alpha: 1, offsetX: 0, offsetY: 0, windup: false };
}

/** Vrai si le type d'ennemi est un boss (sprite 48×48, jamais retourné). */
export function isBossKind(kind: string): boolean {
  return kind === 'golem' || kind === 'morvane';
}

/**
 * Calcule l'aspect d'un ennemi (modes d'IA : 'idle','chase','windup','attack','recover','stunned','teleport').
 *  - windup  : clignote blanc/rouge + léger tremblement (télégraphe) ;
 *  - hit     : silhouette blanche (ou frame `boss_<kind>_hurt` pour les boss) ;
 *  - stunned : teinte bleutée, ballant ;
 *  - teleport: quasi transparent ;
 *  - attack  : élan vers le haut d'un pixel.
 * `out` est rempli et retourné (aucune allocation).
 */
export function computeEnemyVisual(e: EnemyState, timeMs: number, out: EnemyVisual): EnemyVisual {
  const boss = isBossKind(e.kind);
  const hurt = e.hitFlashMs > 0;
  out.frame = boss && hurt ? bossFrame(e.kind as 'golem' | 'morvane', 0, true) : enemyFrame(e.kind, enemyStep(timeMs, e.id));
  out.flipX = !boss && e.facing === 'left';
  out.tintFill = -1;
  out.tint = COLOR_WHITE;
  out.alpha = 1;
  out.offsetX = 0;
  out.offsetY = 0;
  out.windup = false;

  switch (e.mode) {
    case 'windup': {
      out.windup = true;
      const on = Math.floor(timeMs / WINDUP_BLINK_MS) % 2 === 0;
      out.tintFill = on ? COLOR_WHITE : COLOR_WARN_RED;
      out.offsetX = on ? 0.6 : -0.6;
      break;
    }
    case 'stunned':
      out.tint = COLOR_STUN;
      out.alpha = 0.85;
      out.offsetY = Math.sin(timeMs / 90) * 0.8;
      break;
    case 'teleport':
      out.alpha = 0.3;
      break;
    case 'attack':
      out.offsetY = -1;
      break;
    default:
      break;
  }
  // le flash de dégâts l'emporte sur la teinte de mode (les boss utilisent leur frame « hurt » à la place)
  if (hurt && !boss) out.tintFill = COLOR_WHITE;
  return out;
}
