/**
 * ÉQUILIBRAGE — toutes les formules et constantes d'ajustement du jeu (DESIGN.md §3).
 *
 * Logique pure. Pour régler la difficulté ressentie, on ne touche QU'À ce fichier (et aux stats de
 * `characters.ts` / `enemies.ts`). Les constantes sont numérotées pour que le README puisse y renvoyer.
 *
 *  [B1] BASE_HP .................... PV de base de tout joueur (50)
 *  [B2] HP_PER_RESISTANCE .......... PV gagnés par point de résistance (10)  → PV max = 50 + 10 × résistance
 *  [B3] REDUCTION_PER_RESISTANCE ... réduction de dégâts par point de résistance (0.02 = 2 %)
 *  [B4] MAX_DAMAGE_REDUCTION ....... plafond de la réduction (0.20 = 20 %)
 *  [B5] BASE_DAMAGE ................ dégâts de base d'un joueur sans force (6)
 *  [B6] DAMAGE_PER_STRENGTH ........ dégâts gagnés par point de force (2.5)  → base = (6 + 2.5 × force) × attack.damageMult
 *  [B7] MIN_DAMAGE ................. plancher des dégâts effectivement appliqués (1)
 *  [B8] DIFFICULTY_TABLE ........... multiplicateurs PV/dégâts ennemis par difficulté (par JOUEUR)
 *  [B9] REVIVE_INVULN_MS ........... invulnérabilité après un relevage (1500 ms)
 *
 * Les constantes de relevage (REVIVE_DURATION_MS, REVIVE_RANGE, REVIVE_THREAT_SLOW, DOWNED_THREAT_RADIUS) et
 * PLAYER_INVULN_MS vivent dans `constants.ts`.
 *
 * La difficulté n'affecte JAMAIS : les PV du joueur, le nombre d'ennemis, les mécanismes.
 */
import type { CharacterDef, Difficulty } from './types';

// ───────────────────────── Constantes d'équilibrage ─────────────────────────

/** [B1] PV de base d'un joueur. */
export const BASE_HP = 50;
/** [B2] PV supplémentaires par point de résistance. */
export const HP_PER_RESISTANCE = 10;
/** [B3] Réduction de dégâts (fraction) par point de résistance. */
export const REDUCTION_PER_RESISTANCE = 0.02;
/** [B4] Réduction de dégâts maximale (fraction). */
export const MAX_DAMAGE_REDUCTION = 0.2;
/** [B5] Dégâts de base à force 0. */
export const BASE_DAMAGE = 6;
/** [B6] Dégâts de base ajoutés par point de force. */
export const DAMAGE_PER_STRENGTH = 2.5;
/** [B7] Dégâts minimaux effectivement appliqués (après multiplicateurs). */
export const MIN_DAMAGE = 1;
/** [B9] Invulnérabilité (ms) accordée à un joueur relevé. */
export const REVIVE_INVULN_MS = 1500;

/** Multiplicateurs de difficulté appliqués aux ENNEMIS (du point de vue d'un joueur donné). */
export interface DifficultyMultipliers {
  /** Multiplicateur des PV ennemis : les dégâts infligés PAR ce joueur sont divisés par cette valeur. */
  enemyHpMult: number;
  /** Multiplicateur des dégâts ennemis : les dégâts reçus PAR ce joueur sont multipliés par cette valeur. */
  enemyDamageMult: number;
}

/** [B8] Table de difficulté : 1 facile, 2 normal, 3 difficile. */
export const DIFFICULTY_TABLE: Readonly<Record<Difficulty, Readonly<DifficultyMultipliers>>> = {
  1: { enemyHpMult: 0.7, enemyDamageMult: 0.6 },
  2: { enemyHpMult: 1.0, enemyDamageMult: 1.0 },
  3: { enemyHpMult: 1.4, enemyDamageMult: 1.5 },
};

// ───────────────────────── Formules ─────────────────────────

/** Statistiques de personnage nécessaires aux formules (un `CharacterDef` complet convient). */
export type ResistanceStat = Pick<CharacterDef, 'resistance'>;
export type StrengthStat = Pick<CharacterDef, 'strength' | 'attack'>;

/**
 * PV maximum d'un joueur : `50 + 10 × résistance`. Indépendant de la difficulté.
 * @param character personnage (seule `resistance` est lue)
 */
export function maxHpFor(character: ResistanceStat): number {
  return BASE_HP + HP_PER_RESISTANCE * character.resistance;
}

/**
 * Réduction de dégâts d'un joueur, en FRACTION (0..0.2) : `min(0.2, 0.02 × résistance)`.
 * @param character personnage (seule `resistance` est lue)
 */
export function damageReductionFor(character: ResistanceStat): number {
  return Math.min(MAX_DAMAGE_REDUCTION, REDUCTION_PER_RESISTANCE * Math.max(0, character.resistance));
}

/**
 * Dégâts BRUTS d'une attaque de joueur (avant la difficulté du joueur) : `(6 + 2.5 × force) × attack.damageMult`.
 * Non arrondi. C'est la valeur à stocker dans `ProjectileState.damage` ou à passer à `damageToEnemy`.
 * @param character personnage (`strength` et `attack.damageMult` sont lus)
 */
export function playerBaseDamage(character: StrengthStat): number {
  return (BASE_DAMAGE + DAMAGE_PER_STRENGTH * character.strength) * character.attack.damageMult;
}

/**
 * Dégâts BRUTS d'UN coup/UNE touche de l'attaque spéciale (avant la difficulté du joueur) :
 * `(6 + 2.5 × force) × special.damageMult` (SANS `attack.damageMult`). 0 si le personnage n'a pas de spécial.
 * À passer à `damageToEnemy` (difficulté de l'attaquant) ou à stocker dans `ProjectileState.damage`.
 * @param character personnage (`strength` et `special.damageMult` sont lus)
 */
export function playerSpecialDamage(character: Pick<CharacterDef, 'strength' | 'special'>): number {
  const mult = character.special?.damageMult ?? 0;
  return (BASE_DAMAGE + DAMAGE_PER_STRENGTH * character.strength) * mult;
}

/**
 * Multiplicateurs de la difficulté `d`. Une valeur invalide est traitée comme « normal » (2).
 */
export function difficultyMultipliers(d: Difficulty): DifficultyMultipliers {
  return DIFFICULTY_TABLE[d] ?? DIFFICULTY_TABLE[2];
}

/**
 * Dégâts effectivement retirés aux PV d'un ennemi quand un joueur de difficulté `attackerDifficulty` le frappe :
 * `brut ÷ multPV(diff)`, jamais < 1 (MIN_DAMAGE). Non arrondi (les PV ennemis peuvent être fractionnaires).
 * Si `rawDamage <= 0` (ex. attaque sans effet), retourne 0.
 * @param rawDamage dégâts bruts (voir `playerBaseDamage`)
 * @param attackerDifficulty difficulté du joueur qui attaque
 */
export function damageToEnemy(rawDamage: number, attackerDifficulty: Difficulty): number {
  if (!(rawDamage > 0)) return 0;
  return Math.max(MIN_DAMAGE, rawDamage / difficultyMultipliers(attackerDifficulty).enemyHpMult);
}

/**
 * Dégâts effectivement reçus par un joueur : `round(brut × multDégâts(diff) × (1 − réduction(résistance)))`, jamais < 1.
 * Si `rawDamage <= 0`, retourne 0.
 * @param rawDamage dégâts bruts de l'ennemi / du projectile (`EnemyDef.damage`…)
 * @param character personnage victime (résistance)
 * @param victimDifficulty difficulté du joueur victime
 */
export function damageToPlayer(
  rawDamage: number,
  character: ResistanceStat,
  victimDifficulty: Difficulty,
): number {
  if (!(rawDamage > 0)) return 0;
  const scaled =
    rawDamage * difficultyMultipliers(victimDifficulty).enemyDamageMult * (1 - damageReductionFor(character));
  return Math.max(MIN_DAMAGE, Math.round(scaled));
}
