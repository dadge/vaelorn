/**
 * Barres de vie des demi-boss ET des boss (logique PURE, aucune dépendance à Phaser) : quels ennemis ont une barre, dans quel
 * ordre, avec quel nom (nameKey de l'EnemyDef), quelle proportion et quelle couleur. Le rendu (overlay.ts) ne fait que dessiner.
 */
import type { EnemyDef, EnemyState } from '../core/types';
import { isBossKind, isMiniBossKind } from '../core/enemies';

/** Nombre maximal de barres empilées à l'écran. */
export const MAX_BOSS_BARS = 3;

export type BossBarTier = 'boss' | 'mini';

export interface BossBarEntry {
  enemyId: number;
  kind: string;
  /** Clé i18n du nom (EnemyDef.nameKey, sinon `enemy.<kind>`). */
  nameKey: string;
  tier: BossBarTier;
  /** Proportion de PV 0..1. */
  ratio: number;
  phase: number;
}

/** Définition lue dans une table (type inconnu → undefined). */
export type EnemyDefLookup = (kind: string) => Pick<EnemyDef, 'nameKey' | 'isBoss' | 'isMiniBoss'> | undefined;

/** Proportion de PV (0..1), jamais NaN. */
export function hpRatio(e: Pick<EnemyState, 'hp' | 'maxHp'>): number {
  if (!(e.maxHp > 0) || !Number.isFinite(e.hp)) return 0;
  return Math.max(0, Math.min(1, e.hp / e.maxHp));
}

/**
 * Palier d'un ennemi vis-à-vis de la barre : 'boss' (EnemyDef.isBoss ou sprite 48×48), 'mini' (EnemyDef.isMiniBoss ou sprite 32×32),
 * sinon null (ennemi normal : pas de barre globale). La définition prime ; à défaut, le gabarit de sprite.
 */
export function bossBarTier(kind: string, def?: Pick<EnemyDef, 'isBoss' | 'isMiniBoss'>): BossBarTier | null {
  if (def) {
    if (def.isBoss) return 'boss';
    if (def.isMiniBoss) return 'mini';
    return null;
  }
  return isBossKind(kind) ? 'boss' : isMiniBossKind(kind) ? 'mini' : null;
}

/**
 * Entrées de barres de vie : boss d'abord, puis demi-boss, à ordre d'apparition (id) égal ; ennemis morts ou à 0 PV exclus ;
 * au plus `max`. `lookup` fournit les EnemyDef (ex. `(k) => ENEMIES[k]`).
 */
export function bossBarEntries(enemies: readonly EnemyState[], lookup: EnemyDefLookup, max: number = MAX_BOSS_BARS): BossBarEntry[] {
  const out: BossBarEntry[] = [];
  for (const e of enemies) {
    if (e.dead || !(e.hp > 0)) continue;
    const def = lookup(e.kind);
    const tier = bossBarTier(e.kind, def);
    if (!tier) continue;
    out.push({ enemyId: e.id, kind: e.kind, nameKey: def?.nameKey ?? `enemy.${e.kind}`, tier, ratio: hpRatio(e), phase: e.phase });
  }
  out.sort((a, b) => (a.tier === b.tier ? a.enemyId - b.enemyId : a.tier === 'boss' ? -1 : 1));
  return out.slice(0, Math.max(0, max));
}

/** Couleur de remplissage d'une barre : rouge de boss (plus vive par phase), ambre pour un demi-boss. */
export function bossBarColor(tier: BossBarTier, phase: number): number {
  if (tier === 'mini') return phase >= 1 ? 0xffa23a : 0xe0902e;
  return phase >= 2 ? 0xff3050 : phase === 1 ? 0xe0504f : 0xe0304f;
}

/** Couleur de la bordure d'une barre. */
export function bossBarFrameColor(tier: BossBarTier): number {
  return tier === 'boss' ? 0xff6a6a : 0xffc060;
}

/** Signature d'un ensemble d'entrées (changement de noms/ordre → texte à rafraîchir). */
export function bossBarSignature(entries: readonly BossBarEntry[]): string {
  return entries.map((e) => `${e.enemyId}:${e.nameKey}:${e.tier}`).join('|');
}
