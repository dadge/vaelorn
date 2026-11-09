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
 *  [B10] HP_PER_HEART .............. PV représentés par un cœur du HUD (10) ; LOOT_HALF_HEAL (5) / LOOT_FULL_HEAL (10) : valeur de la nourriture
 *  [B11] LOOT_TIERS ................ table de butin des ennemis tués par palier de PV de base (faible / standard / costaud)
 *  [B12] LOOT_NEED_POINTS .......... multiplicateur de probabilité selon les PV du joueur vivant le plus blessé (x0,5 / x1 / x2)
 *  [B13] LOOT_MAX_CHANCE ........... plafond de la probabilité totale de butin (90 %)
 *  [B14] LOOT_PITY_DRY_KILLS ....... garantie anti-malchance : morts sans butin (6) et seuil de PV (70 %) — LOOT_PITY_HP_FRACTION
 *  [B15] PICKUP_TTL_MS / _BLINK_MS / _RADIUS . vie (12 s), clignotement (3 dernières s) et rayon de ramassage (14 px) de la nourriture au sol
 *  [B16] LOOT_SEED_XOR ............. constante de dérivation de la graine du PRNG DÉDIÉ au butin (flux isolé)
 *  [B17] HEAL_CRYSTAL_HEAL ......... soin d'un cristal de soin (50 PV, usage unique) ; HEAL_CRYSTAL_RADIUS (contact) et distances mini de placement
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

// ───────────────────────── Sources de vie (butin, cristaux) ─────────────────────────

/** [B10] PV représentés par un cœur entier du HUD (source de vérité ; `render/hud.ts` la réexporte). */
export const HP_PER_HEART = 10;
/** [B10] Soin d'un demi-cœur de nourriture (PV). */
export const LOOT_HALF_HEAL = HP_PER_HEART / 2;
/** [B10] Soin d'un cœur entier de nourriture (PV). */
export const LOOT_FULL_HEAL = HP_PER_HEART;

/** Palier de butin d'un ennemi ordinaire (les demi-boss et les boss finaux ont leurs règles propres, voir `loot.ts`). */
export type LootTierId = 'weak' | 'standard' | 'tough';

/** Ligne de la table de butin : plafond de PV de base du palier et chances de demi-cœur / cœur entier (à besoin neutre ×1). */
export interface LootTierDef {
  /** Palier applicable aux ennemis dont les PV de base (`EnemyDef.hp`) sont <= à cette valeur (après les paliers précédents). */
  maxBaseHp: number;
  /** Probabilité d'un demi-cœur (5 PV). */
  half: number;
  /** Probabilité d'un cœur entier (10 PV). */
  full: number;
}

/**
 * [B11] Table de butin des ennemis ordinaires tués (non invoqués), par PV de base :
 *  - faible    (PV <= 25)       : rien 85 %, demi 12 %, entier 3 %  (slime, chauve-souris, feu follet)
 *  - standard  (PV 26 à 40)     : rien 76 %, demi 18 %, entier 6 %  (squelette, archer, araignée)
 *  - costaud   (PV > 40, hors boss) : rien 40 %, demi 40 %, entier 20 %  (chevalier)
 * Les demi-boss (`isMiniBoss`) laissent TOUJOURS un cœur entier ; les boss finaux (`isBoss`) et les ennemis invoqués : rien.
 * Gain moyen visé ≈ 1,5 PV par ennemi à besoin neutre.
 */
export const LOOT_TIERS: Readonly<Record<LootTierId, Readonly<LootTierDef>>> = {
  weak: { maxBaseHp: 25, half: 0.12, full: 0.03 },
  standard: { maxBaseHp: 40, half: 0.18, full: 0.06 },
  tough: { maxBaseHp: Infinity, half: 0.4, full: 0.2 },
};

/** Point de la courbe de besoin : fraction de PV du joueur le plus blessé → multiplicateur de la probabilité de butin. */
export interface LootNeedPoint {
  hpFraction: number;
  mult: number;
}

/**
 * [B12] Courbe de besoin (interpolation linéaire par morceaux, plafonnée aux extrémités), points triés par fraction de PV DÉCROISSANTE :
 * PV pleins (100 %) → ×0,5 ; 50 % → ×1 ; <= 30 % → ×2. S'applique à la SOMME des deux chances non nulles du palier ;
 * la répartition demi / entier reste celle de la table.
 */
export const LOOT_NEED_POINTS: readonly LootNeedPoint[] = [
  { hpFraction: 1, mult: 0.5 },
  { hpFraction: 0.5, mult: 1 },
  { hpFraction: 0.3, mult: 2 },
];

/** [B13] Plafond de la probabilité TOTALE de butin (après le multiplicateur de besoin). */
export const LOOT_MAX_CHANCE = 0.9;

/**
 * [B14] Garantie anti-malchance : après `LOOT_PITY_DRY_KILLS` morts consécutives (non invoquées, ennemis ordinaires) sans butin dans la salle,
 * la mort suivante laisse AU MOINS un demi-cœur si le joueur vivant le plus blessé est sous `LOOT_PITY_HP_FRACTION` de ses PV.
 * (Le compteur repart de zéro à chaque butin et à chaque début de salle.)
 * Interprétation de « au-delà de 6 » : le compteur ATTEINT 6 (6 morts sèches) ⇒ la 7e mort est garantie (`dryKills >= LOOT_PITY_DRY_KILLS`). La lecture
 * stricte (> 6, soit la 8e mort) reste possible : changer la valeur à 7 suffit (à valider avec David, voir TODO.md).
 */
export const LOOT_PITY_DRY_KILLS = 6;
export const LOOT_PITY_HP_FRACTION = 0.7;

/** [B15] Durée de vie (ms) de la nourriture au sol. */
export const PICKUP_TTL_MS = 12_000;
/** [B15] Les `PICKUP_BLINK_MS` dernières millisecondes de vie, le rendu fait clignoter l'objet. */
export const PICKUP_BLINK_MS = 3_000;
/** [B15] Rayon de ramassage (px, centre à centre) de la nourriture. */
export const PICKUP_RADIUS = 14;

/** [B16] Constante XOR de la graine du PRNG de butin : `seedToState(seed ^ LOOT_SEED_XOR)` ("LOOT" en ASCII). */
export const LOOT_SEED_XOR = 0x4c4f4f54;

/** [B17] PV rendus par un cristal de soin (plafonnés au manque du joueur) = 5 cœurs. */
export const HEAL_CRYSTAL_HEAL = 5 * HP_PER_HEART;
/** [B17] Rayon de contact (px) d'un cristal de soin. */
export const HEAL_CRYSTAL_RADIUS = 14;
/** [B17] Validation des niveaux : un cristal est à au moins ce nombre de tuiles de TOUT point d'arrivée des joueurs (pas trivial à atteindre). */
export const HEAL_CRYSTAL_MIN_SPAWN_TILES = 8;
/** [B17] Validation des niveaux : un cristal est à au moins ce nombre de tuiles de la position de départ de tout boss / demi-boss (hors zones de danger de départ). */
export const HEAL_CRYSTAL_MIN_BOSS_TILES = 17;

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
