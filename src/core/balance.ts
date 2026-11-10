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
 *  [B18] GEAR_BONUS ................ bonus des objets d'équipement par emplacement et niveau (I / II / III) : bottes, protection, artefact, magie, arme
 *  [B19] GEAR_CAPS ................. plafonds de l'ÉQUIPEMENT : vitesse +30 %, protection -30 %, spécial -35 %, relevage -50 % (les effets temporaires de vitesse s'y ajoutent, voir [B27])
 *  [B20] GEAR_BOW_* / GEAR_AXE_* ... arme : arc (distance ~190 px, 70 % du corps à corps, +15 % pour un tireur), hache (+35 % dégâts, attaque 20 % plus lente)
 *  [B21] GEAR_BUDGET_PER_PLAYER .... budget d'objets par salle = nombre de joueurs ; GEAR_ENEMY_WEIGHTS (costaud ×4, standard ×1, faible ×0,5)
 *  [B22] GEAR_LEVEL_WEIGHTS ........ niveaux tirés I 75 % / II 22 % / III 3 % ; GEAR_MINIBOSS_MIN_LEVEL (demi-boss : niveau II minimum)
 *  [B23] GEAR_SLOT_WEIGHTS ......... poids de tirage des emplacements (magie 0 en solo ; accessoire 12) ; GEAR_EMPTY_SLOT_FACTOR (×2)
 *  [B24] GEAR_TTL_MS / _BLINK_MS / _PICKUP_RADIUS / _SCATTER_RADIUS : durée au sol (20 s), clignotement (4 dernières s), rayon de ramassage et d'éparpillement
 *  [B25] GEAR_SEED_XOR ............. constante de dérivation de la graine du PRNG ISOLÉ de l'équipement (distinct de celui du butin de vie)
 *  [B26] ACCESSORY_BONUS ........... accessoires (6e emplacement) : lanterne (torche -30 / -50 / -70 %), aimant (rayon 50 / 80 / 120 px), cor de guerre (+20 / +30 / +40 % de vitesse aux alliés) ;
 *        ACCESSORY_KIND_WEIGHTS (tirage de la sorte, anneau du vampire rare), MAGNET_PULL_SPEED, HORN_DURATION_MS / HORN_RADIUS_PX, VAMPIRE_* (+1 PV tous les 3 ennemis tués)
 *  [B27] BUFF_* .................... bonus temporaires : potion de vitesse (+40 %), éclair de rage (+50 % dégâts) 8 s, étoile (invulnérabilité) 4 s ;
 *        BUFF_BUDGET_PER_PLAYER (~0,3 par héros et par salle), BUFF_KIND_WEIGHTS, BUFF_SPEED_TOTAL_CAP (plafond de TOUTES les sources de vitesse)
 *  [B28] AUTO_CALL_* ............... appel AUTOMATIQUE (objet laissé aux coéquipiers) : durée du signal (= celle de l'appel manuel, 3 s), délai de récupération
 *        propre au joueur (4 s, distinct de celui de l'appel manuel) et marge de ré-armement par couple (joueur, objet au sol)
 *
 * Les constantes de relevage (REVIVE_DURATION_MS, REVIVE_RANGE, REVIVE_THREAT_SLOW, DOWNED_THREAT_RADIUS) et
 * PLAYER_INVULN_MS vivent dans `constants.ts`.
 *
 * La difficulté n'affecte JAMAIS : les PV du joueur, le nombre d'ennemis, les mécanismes.
 */
import { CALL_DURATION_MS } from './constants';
import type { BasicGearSlot, CharacterDef, Difficulty } from './types';

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

// ───────────────────────── Équipement (bonus « à la Bubble Bobble ») ─────────────────────────

/**
 * [B18] Bonus des objets par emplacement et niveau (indice 0 = niveau I, 1 = II, 2 = III ; table de départ CONSERVÉE après calibrage par bots : budget de puissance +22 à +25 %
 * à la 4e salle, +75 à +92 % tout au niveau III, voir le README) :
 *  - boots      : vitesse de déplacement +10 / +20 / +30 % (Sandales / Bottes de cuir / Bottes ailées) ;
 *  - protection : dégâts reçus -10 / -20 / -30 % (Casque / Bouclier / Armure), appliqués APRÈS la difficulté et la résistance ;
 *  - artifact   : recharge du spécial -15 / -25 / -35 % (Amulette / Sablier / Orbe) ;
 *  - magic      : temps de relevage (de CELUI QUI RELÈVE) -20 / -35 / -50 % (Potion / Baguette / Chapeau de sorcier) ;
 *  - weapon     : fraction de dégâts EN PLUS de l'Épée (0,20) et de la Hache (0,35) ; l'Arc (niveau III) a ses constantes `GEAR_BOW_*`.
 */
export const GEAR_BONUS: Readonly<Record<BasicGearSlot, readonly [number, number, number]>> = {
  boots: [0.1, 0.2, 0.3],
  protection: [0.1, 0.2, 0.3],
  artifact: [0.15, 0.25, 0.35],
  magic: [0.2, 0.35, 0.5],
  weapon: [0.2, 0.35, 0],
};

/**
 * [B19] Plafonds des bonus de l'ÉQUIPEMENT PERMANENT (une seule source par famille : bottes, protection, artefact, magie). Les effets TEMPORAIRES de
 * vitesse (potion de vitesse, cor de guerre) s'ajoutent à celui des bottes, sous le plafond global `BUFF_SPEED_TOTAL_CAP` ([B27]).
 */
export const GEAR_CAPS = {
  /** Vitesse de déplacement : +30 %. */
  speed: 0.3,
  /** Réduction des dégâts reçus : -30 %. */
  protection: 0.3,
  /** Réduction de la recharge du spécial : -35 %. */
  special: 0.35,
  /** Réduction du temps de relevage : -50 %. */
  revive: 0.5,
} as const;

/** [B20] Hache (arme niveau II) : l'attaque est 20 % plus lente (délai entre deux attaques × 1,2). */
export const GEAR_AXE_COOLDOWN_MULT = 1.2;
/** [B20] Arc (arme niveau III) : portée (px) de l'attaque à distance d'un héros au corps à corps. */
export const GEAR_BOW_RANGE_PX = 190;
/** [B20] Arc : vitesse (px/s) du projectile « flèche » d'un héros au corps à corps (durée de vie = portée / vitesse). */
export const GEAR_BOW_ARROW_SPEED = 260;
/** [B20] Arc : rayon (px) de la flèche d'un héros au corps à corps. */
export const GEAR_BOW_ARROW_RADIUS = 3;
/** [B20] Arc : dégâts d'un héros au corps à corps = 70 % de son corps à corps. */
export const GEAR_BOW_MELEE_DAMAGE_MULT = 0.7;
/** [B20] Arc : +15 % de dégâts pour un héros qui tire déjà (Valentine : son tir est un projectile de soin, l'effet de soin est inchangé). */
export const GEAR_BOW_RANGED_BONUS = 0.15;

/** [B21] Budget d'objets d'équipement par salle de combat : 1 par joueur de la partie. */
export const GEAR_BUDGET_PER_PLAYER = 1;
/**
 * [B21] Poids d'un ennemi dans la répartition du budget restant (palier de butin de `lootTierOf`) : costaud ×4, standard ×1, faible ×0,5.
 * Chaque mort tire un objet avec la probabilité `budgetRestant × poids / sommeDesPoidsRestants` (ennemis vivants et apparitions en attente).
 */
export const GEAR_ENEMY_WEIGHTS: Readonly<Record<LootTierId, number>> = { weak: 0.5, standard: 1, tough: 4 };

/**
 * [B22] Poids de tirage du niveau I / II / III (somme = 100). Calibrage mesuré (README, « Équipement et bonus ») : 75 / 22 / 3 conservé ; ces chances pèsent peu sur la
 * puissance moyenne (tous les objets de niveau I donnent quasi la même puissance), elles règlent la rareté et la progression.
 */
export const GEAR_LEVEL_WEIGHTS: readonly [number, number, number] = [75, 22, 3];
/** [B22] Niveau minimal garanti de l'objet d'un demi-boss. */
export const GEAR_MINIBOSS_MIN_LEVEL = 2;

/**
 * [B23] Poids de départ du tirage de l'emplacement. `magic` est retiré (poids 0) quand il n'y a qu'UN joueur (relevage inutile) et son poids
 * est redistribué (le tirage est proportionnel).
 */
export const GEAR_SLOT_WEIGHTS: Readonly<Record<BasicGearSlot | 'accessory', number>> = {
  boots: 18,
  protection: 22,
  weapon: 18,
  artifact: 18,
  magic: 12,
  accessory: 12,
};
/** [B23] Un emplacement VIDE chez le joueur vivant le moins équipé pèse ×2 dans le tirage. */
export const GEAR_EMPTY_SLOT_FACTOR = 2;

/** [B24] Durée de vie (ms) d'un objet d'équipement au sol. */
export const GEAR_TTL_MS = 20_000;
/** [B24] Les `GEAR_BLINK_MS` dernières millisecondes, l'objet clignote (≤ 3 Hz, voir `render/gearFx.ts`). */
export const GEAR_BLINK_MS = 4_000;
/** [B24] Rayon de ramassage (px, centre à centre) d'un objet d'équipement. */
export const GEAR_PICKUP_RADIUS = 14;
/** [B24] Rayon (px) du cercle sur lequel l'équipement perdu est éparpillé autour du joueur tombé. */
export const GEAR_SCATTER_RADIUS = 20;

/** [B25] Constante XOR de la graine du PRNG ISOLÉ de l'équipement : `seedToState(seed ^ GEAR_SEED_XOR)` ("GEAR" en ASCII). */
export const GEAR_SEED_XOR = 0x47454152;

// ───────────────────────── Accessoires et bonus temporaires ─────────────────────────

/**
 * [B26] Bonus des accessoires par sorte et niveau (indice 0 = niveau I) :
 *  - lantern : fraction de consommation de la torche en MOINS (la torche des salles sombres s'use 30 / 50 / 70 % moins vite) ;
 *  - magnet  : rayon d'attraction (px) des cœurs ET des objets d'équipement au sol ;
 *  - warhorn : bonus de vitesse (fraction) donné aux alliés proches quand le porteur lance son APPEL (`HORN_DURATION_MS`).
 * L'anneau du vampire n'a pas de niveau variable : niveau III UNIQUEMENT (voir `VAMPIRE_*`).
 */
export const ACCESSORY_BONUS: Readonly<Record<'lantern' | 'magnet' | 'warhorn', readonly [number, number, number]>> = {
  lantern: [0.3, 0.5, 0.7],
  magnet: [50, 80, 120],
  warhorn: [0.2, 0.3, 0.4],
};

/** [B26] Poids de tirage de la sorte d'accessoire (l'anneau du vampire, niveau III seulement, est RARE : 7 %). */
export const ACCESSORY_KIND_WEIGHTS: Readonly<Record<'lantern' | 'magnet' | 'warhorn' | 'vampire', number>> = {
  lantern: 31,
  magnet: 31,
  warhorn: 31,
  vampire: 7,
};

/** [B26] Vitesse (px/s) à laquelle l'aimant tire un cœur ou un objet vers son porteur. */
export const MAGNET_PULL_SPEED = 110;
/** [B26] Durée (ms) du bonus de vitesse que le cor de guerre donne aux alliés proches (celle de l'appel). */
export const HORN_DURATION_MS = 3_000;
/** [B26] Rayon (px) autour de l'appelant dans lequel les alliés reçoivent le bonus du cor de guerre. */
export const HORN_RADIUS_PX = 160;
/** [B26] Anneau du vampire : +1 PV (`VAMPIRE_HEAL_HP`) tous les 3 ennemis tués (`VAMPIRE_KILLS_PER_HEAL`) ; seuls les ennemis NON invoqués comptent. */
export const VAMPIRE_HEAL_HP = 1;
export const VAMPIRE_KILLS_PER_HEAL = 3;

/** [B27] Durée (ms) des bonus temporaires « potion de vitesse » et « éclair de rage ». */
export const BUFF_DURATION_MS = 8_000;
/** [B27] Durée (ms) du bonus temporaire « étoile » (invulnérabilité). */
export const BUFF_STAR_DURATION_MS = 4_000;
/** [B27] Potion de vitesse : +40 % de vitesse de déplacement. */
export const BUFF_SPEED_BONUS = 0.4;
/** [B27] Éclair de rage : +50 % de dégâts infligés (attaque normale ET spécial). */
export const BUFF_RAGE_BONUS = 0.5;
/**
 * [B27] Plafond GLOBAL de la vitesse de déplacement : bottes (plafonnées à `GEAR_CAPS.speed`) + effet temporaire (potion de vitesse OU cor de guerre,
 * le plus fort des deux, jamais cumulés) ≤ +60 %.
 */
export const BUFF_SPEED_TOTAL_CAP = 0.6;
/** [B27] Budget (moyenne) de bonus temporaires par héros et par salle : le budget entier de la salle est floor(0,3 n) + (1 avec la probabilité du reste). */
export const BUFF_BUDGET_PER_PLAYER = 0.3;
/** [B27] Poids de tirage de la sorte de bonus temporaire (l'étoile est la plus rare). */
export const BUFF_KIND_WEIGHTS: Readonly<Record<'speed' | 'rage' | 'star', number>> = { speed: 40, rage: 40, star: 20 };

// ───────────────────────── Appel automatique (objet laissé aux coéquipiers) ─────────────────────────

/** [B28] Durée (ms) du signal d'appel AUTOMATIQUE : celle du signal de l'appel manuel (3 s), sans l'immobilisation. */
export const AUTO_CALL_DURATION_MS = CALL_DURATION_MS;
/**
 * [B28] Délai de récupération (ms) de l'appel AUTOMATIQUE d'un joueur, mesuré depuis son déclenchement : traverser une rangée d'objets ne fait pas clignoter
 * l'indicateur, et un signal en cours n'est jamais remplacé par un autre objet (le délai est supérieur à la durée du signal). Distinct du délai de l'appel manuel.
 */
export const AUTO_CALL_COOLDOWN_MS = 4_000;
/**
 * [B28] Marge (px) ajoutée au rayon de contact d'un objet pour le ré-armer : un joueur qui a déclenché un appel sur un objet ne le redéclenche qu'après
 * être sorti du rayon de contact + cette marge puis y être revenu (pas de va-et-vient au bord du rayon).
 */
export const AUTO_CALL_REARM_MARGIN = 4;

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
 * @param gearReduction réduction de l'équipement (fraction, plafonnée à `GEAR_CAPS.protection`, [B18]) appliquée APRÈS la difficulté et la résistance ; défaut 0
 */
export function damageToPlayer(
  rawDamage: number,
  character: ResistanceStat,
  victimDifficulty: Difficulty,
  gearReduction = 0,
): number {
  if (!(rawDamage > 0)) return 0;
  const gear = Math.min(GEAR_CAPS.protection, Math.max(0, Number.isFinite(gearReduction) ? gearReduction : 0));
  const scaled =
    rawDamage * difficultyMultipliers(victimDifficulty).enemyDamageMult * (1 - damageReductionFor(character)) * (1 - gear);
  return Math.max(MIN_DAMAGE, Math.round(scaled));
}
