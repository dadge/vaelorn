/**
 * BUTIN DE VIE — nourriture laissée par les ennemis vaincus, adaptation au besoin, garantie anti-malchance, ramassage.
 *
 * Logique PURE et déterministe (aucun Phaser/DOM/Math.random/Date) : les tirages se font via une fonction `random()` fournie par
 * l'appelant (la simulation passe son PRNG DÉDIÉ au butin, voir `GameState.lootRngState` : le flux principal n'est jamais consommé).
 * Toutes les valeurs numériques vivent dans `balance.ts` ([B10]..[B17]).
 *
 * ── Règles (validées) ──
 *  1. Table par type d'ennemi (PV de base, `lootTierOf`) : faible / standard / costaud (`LOOT_TIERS`), cœur entier GARANTI pour un
 *     demi-boss (`isMiniBoss`), rien pour un boss final (`isBoss`) et pour un ennemi INVOQUÉ (`isSummonedEnemy` : vague `SUMMON_WAVE`).
 *  2. Besoin : multiplicateur de la SOMME des deux chances (`lootNeedMultiplier`, courbe `LOOT_NEED_POINTS`) selon les PV du joueur
 *     VIVANT le plus blessé (`mostWoundedFraction`) ; total plafonné à `LOOT_MAX_CHANCE` ; la répartition demi / entier est celle de la table.
 *  3. Anti-malchance : `dryKills` (morts ordinaires sans butin) >= `LOOT_PITY_DRY_KILLS` ET joueur le plus blessé sous
 *     `LOOT_PITY_HP_FRACTION` de ses PV ⇒ la mort suivante laisse AU MOINS un demi-cœur. Le compteur repart de 0 à chaque butin
 *     (et la simulation le remet à 0 à chaque début de salle).
 *  4. Un seul tirage `random()` par mort éligible (jamais pour un invoqué, un boss ou un demi-boss) : flux stable.
 */
import {
  LOOT_FULL_HEAL,
  LOOT_HALF_HEAL,
  LOOT_MAX_CHANCE,
  LOOT_NEED_POINTS,
  LOOT_PITY_DRY_KILLS,
  LOOT_PITY_HP_FRACTION,
  LOOT_TIERS,
  PICKUP_BLINK_MS,
  type LootTierId,
} from './balance';
import { SUMMON_WAVE } from './constants';
import { getEnemyDef, isBossKind, isMiniBossKind } from './enemies';
import type { EnemyKind, EnemyState, PickupKind, PickupState, PlayerState, Vec2 } from './types';

/** Palier de butin d'un type d'ennemi : palier ordinaire, demi-boss (cœur garanti) ou aucun (boss final). */
export type LootTier = LootTierId | 'miniBoss' | 'none';

/**
 * Palier de butin d'un type d'ennemi :
 *  - boss final (`isBoss`) → 'none' ; demi-boss (`isMiniBoss`) → 'miniBoss' ;
 *  - sinon selon les PV de base : <= 25 'weak', <= 40 'standard', au-delà 'tough'.
 * @throws Error si le type est inconnu (donnée de niveau invalide)
 */
export function lootTierOf(kind: EnemyKind): LootTier {
  const def = getEnemyDef(kind);
  if (isBossKind(kind)) return 'none';
  if (isMiniBossKind(kind)) return 'miniBoss';
  if (def.hp <= LOOT_TIERS.weak.maxBaseHp) return 'weak';
  if (def.hp <= LOOT_TIERS.standard.maxBaseHp) return 'standard';
  return 'tough';
}

/**
 * Cet ennemi a-t-il été INVOQUÉ en cours de combat (boss, vague de boss, invocation) ? La simulation les crée avec la vague `SUMMON_WAVE`
 * (-1, `EnemyAIContext.spawnEnemy`) ; les ennemis de niveau (vagues >= 0, embuscades) n'ont jamais cette valeur. Marqueur pur et sérialisé
 * (`EnemyState.wave`) : aucun champ supplémentaire.
 */
export function isSummonedEnemy(enemy: Pick<EnemyState, 'wave'>): boolean {
  return enemy.wave === SUMMON_WAVE;
}

/** Fraction de PV (0..1) du joueur VIVANT le plus blessé ; 1 s'il n'y a aucun joueur vivant. */
export function mostWoundedFraction(players: readonly Pick<PlayerState, 'hp' | 'maxHp' | 'status'>[]): number {
  let min = 1;
  for (const p of players) {
    if (p.status !== 'alive' || !(p.maxHp > 0)) continue;
    const f = Math.max(0, Math.min(1, p.hp / p.maxHp));
    if (f < min) min = f;
  }
  return min;
}

/**
 * Multiplicateur de probabilité de butin selon la fraction de PV `hpFraction` (0..1) du joueur le plus blessé : interpolation linéaire par
 * morceaux de `LOOT_NEED_POINTS` (100 % → ×0,5 ; 50 % → ×1 ; <= 30 % → ×2), plafonnée aux extrémités. Valeur non finie : traitée comme PV pleins.
 */
export function lootNeedMultiplier(hpFraction: number): number {
  const pts = LOOT_NEED_POINTS;
  const f = Number.isFinite(hpFraction) ? hpFraction : 1;
  if (f >= pts[0].hpFraction) return pts[0].mult;
  const last = pts[pts.length - 1];
  if (f <= last.hpFraction) return last.mult;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (f <= a.hpFraction && f >= b.hpFraction) {
      const k = (a.hpFraction - f) / (a.hpFraction - b.hpFraction);
      return a.mult + (b.mult - a.mult) * k;
    }
  }
  return last.mult;
}

/** Chances effectives de butin d'un palier ordinaire : demi-cœur, cœur entier, et total (plafonné à `LOOT_MAX_CHANCE`). */
export interface LootChances {
  half: number;
  full: number;
  total: number;
}

/**
 * Chances effectives d'un palier ordinaire pour un multiplicateur de besoin `mult` : total = min(`LOOT_MAX_CHANCE`, (half + full) × mult), réparti
 * entre demi et entier dans les proportions de la table.
 */
export function lootChances(tier: LootTierId, mult: number): LootChances {
  const def = LOOT_TIERS[tier];
  const base = def.half + def.full;
  const total = base > 0 ? Math.min(LOOT_MAX_CHANCE, base * Math.max(0, mult)) : 0;
  const fullShare = base > 0 ? def.full / base : 0;
  return { half: total * (1 - fullShare), full: total * fullShare, total };
}

/** Entrées d'un tirage de butin. */
export interface LootRollInput {
  kind: EnemyKind;
  /** L'ennemi a été invoqué : aucun butin (anti-farm). */
  summoned: boolean;
  /** Fraction de PV (0..1) du joueur vivant le plus blessé (`mostWoundedFraction`). */
  hurtFraction: number;
  /** Morts ordinaires sans butin depuis le dernier butin / le début de salle. */
  dryKills: number;
  /** Tire un nombre dans [0,1) du PRNG dédié ; appelé AU PLUS UNE FOIS, seulement pour un ennemi ordinaire non invoqué. */
  random: () => number;
}

/** Résultat d'un tirage : l'objet laissé (ou null) et le nouveau compteur anti-malchance. */
export interface LootRollResult {
  drop: PickupKind | null;
  dryKills: number;
}

/**
 * Tire le butin d'un ennemi mort (voir l'en-tête du module).
 *  - invoqué / boss final : rien, compteur inchangé (aucun tirage) ;
 *  - demi-boss : cœur entier garanti, compteur remis à 0 (aucun tirage) ;
 *  - ennemi ordinaire : UN tirage. `r < full` → cœur entier ; `r < total` → demi-cœur ; sinon rien… sauf si la garantie anti-malchance
 *    s'applique (alors au moins un demi-cœur). Un butin remet le compteur à 0, une mort sans butin l'incrémente.
 */
export function rollLoot(input: LootRollInput): LootRollResult {
  const { dryKills } = input;
  if (input.summoned) return { drop: null, dryKills };
  const tier = lootTierOf(input.kind);
  if (tier === 'none') return { drop: null, dryKills };
  if (tier === 'miniBoss') return { drop: 'full', dryKills: 0 };
  const chances = lootChances(tier, lootNeedMultiplier(input.hurtFraction));
  const r = input.random();
  let drop: PickupKind | null = null;
  if (r < chances.full) drop = 'full';
  else if (r < chances.total) drop = 'half';
  if (drop === null && dryKills >= LOOT_PITY_DRY_KILLS && input.hurtFraction < LOOT_PITY_HP_FRACTION) drop = 'half';
  return { drop, dryKills: drop === null ? dryKills + 1 : 0 };
}

/** PV rendus par un objet de nourriture : 5 (demi-cœur) ou 10 (cœur entier). */
export function pickupHealValue(kind: PickupKind): number {
  return kind === 'full' ? LOOT_FULL_HEAL : LOOT_HALF_HEAL;
}

/**
 * Ce joueur peut-il CONSOMMER un cœur / demi-cœur au sol ? Vrai s'il est vivant et blessé (PV < max) : aucun seuil, un seul PV manquant suffit (le soin est
 * alors plafonné au manque, `healAmountFor`). Faux : PV pleins ou à terre. Règle unique, partagée par le ramassage (`collectorFor`) et l'appel automatique.
 */
export function canConsumeHeart(p: Pick<PlayerState, 'hp' | 'maxHp' | 'status'>): boolean {
  return p.status === 'alive' && p.hp < p.maxHp;
}

/**
 * Soin effectif d'un joueur au contact d'une source de `value` PV : min(valeur, manque). 0 si le joueur n'est pas vivant ou a ses PV pleins
 * (la source n'est alors PAS consommée).
 */
export function healAmountFor(p: Pick<PlayerState, 'hp' | 'maxHp' | 'status'>, value: number): number {
  if (p.status !== 'alive') return 0;
  return Math.max(0, Math.min(value, p.maxHp - p.hp));
}

/**
 * Joueur qui ramasse une source en `pos` de rayon de contact `radius` : le joueur VIVANT blessé (PV < max) le plus proche dans le rayon
 * (égalité : plus petit id), ou null. Un joueur à terre ou aux PV pleins ne ramasse rien.
 */
export function collectorFor(players: readonly PlayerState[], pos: Vec2, radius: number): PlayerState | null {
  let best: PlayerState | null = null;
  let bestD = Infinity;
  const r2 = radius * radius;
  for (const p of players) {
    if (!canConsumeHeart(p)) continue;
    const dx = p.pos.x - pos.x;
    const dy = p.pos.y - pos.y;
    const d = dx * dx + dy * dy;
    if (d <= r2 && d < bestD) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

/**
 * Fait vieillir les objets de `pickups` de `dtMs` et retire les périmés (ttl <= 0). MUTE le tableau (suppression en place) ;
 * retourne les objets retirés. Les objets de ce pas sont conservés dans l'ordre.
 */
export function agePickups(pickups: PickupState[], dtMs: number): PickupState[] {
  const expired: PickupState[] = [];
  let w = 0;
  for (let i = 0; i < pickups.length; i++) {
    const p = pickups[i];
    p.ttlMs -= dtMs;
    if (p.ttlMs <= 1e-6) expired.push(p);
    else pickups[w++] = p;
  }
  pickups.length = w;
  return expired;
}

/** L'objet est-il dans sa phase de clignotement (`PICKUP_BLINK_MS` dernières ms de vie) ? Utilisé par le rendu (pur, testé). */
export function isPickupBlinking(p: Pick<PickupState, 'ttlMs'>): boolean {
  return p.ttlMs <= PICKUP_BLINK_MS;
}
