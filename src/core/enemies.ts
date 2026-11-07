/**
 * Définitions des ennemis (lecture seule — ne jamais muter `ENEMIES`).
 *
 * `hp` = PV de base ; la difficulté est appliquée côté dégâts reçus par ennemi (voir balance.damageToEnemy),
 * donc `EnemyState.maxHp = def.hp` pour tous les joueurs. `damage` = dégâts BRUTS (contact/attaque),
 * à passer à `applyDamageToPlayer`. Repère : un joueur moyen inflige ≈ 20-25 dégâts par coup.
 * Sprites : enemy_<kind>_<0|1> (16×16) ; boss_<kind>_<0|1> (48×48). Clé i18n : enemy.<kind>.
 */
import type { EnemyDef, EnemyKind } from './types';

/** Ordre canonique des ennemis. */
export const ENEMY_KINDS: readonly EnemyKind[] = [
  'slime',
  'bat',
  'skeleton',
  'archer',
  'spider',
  'wisp',
  'knight',
  'golem',
  'morvane',
  'warden',
  'frostqueen',
  'pyromancer',
  'forgelord',
  'wraith',
  'voidlord',
];

/** Définitions par type. */
export const ENEMIES: Readonly<Record<EnemyKind, EnemyDef>> = {
  slime: {
    kind: 'slime',
    nameKey: 'enemy.slime',
    hp: 24,
    damage: 8,
    speed: 28,
    radius: 6,
    ai: 'wander-chase',
    attackRange: 9,
    attackCooldownMs: 900,
    aggroRadius: 70,
    isBoss: false,
  },
  bat: {
    kind: 'bat',
    nameKey: 'enemy.bat',
    hp: 14,
    damage: 6,
    speed: 62,
    radius: 5,
    ai: 'erratic-flyer',
    attackRange: 8,
    attackCooldownMs: 700,
    aggroRadius: 90,
    isBoss: false,
  },
  skeleton: {
    kind: 'skeleton',
    nameKey: 'enemy.skeleton',
    hp: 36,
    damage: 12,
    speed: 38,
    radius: 7,
    ai: 'melee',
    attackRange: 14,
    attackCooldownMs: 1100,
    aggroRadius: 90,
    isBoss: false,
  },
  archer: {
    kind: 'archer',
    nameKey: 'enemy.archer',
    hp: 28,
    damage: 10,
    speed: 32,
    radius: 6,
    ai: 'ranged',
    attackRange: 110,
    attackCooldownMs: 1600,
    aggroRadius: 130,
    isBoss: false,
  },
  spider: {
    kind: 'spider',
    nameKey: 'enemy.spider',
    hp: 30,
    damage: 10,
    speed: 58,
    radius: 6,
    ai: 'melee',
    attackRange: 12,
    attackCooldownMs: 800,
    aggroRadius: 100,
    isBoss: false,
  },
  wisp: {
    kind: 'wisp',
    nameKey: 'enemy.wisp',
    hp: 24,
    damage: 12,
    speed: 34,
    radius: 5,
    ai: 'caster',
    attackRange: 100,
    attackCooldownMs: 2000,
    aggroRadius: 120,
    isBoss: false,
  },
  knight: {
    kind: 'knight',
    nameKey: 'enemy.knight',
    hp: 90,
    damage: 18,
    speed: 36,
    radius: 8,
    ai: 'melee',
    attackRange: 16,
    attackCooldownMs: 1400,
    aggroRadius: 110,
    isBoss: false,
  },
  // Boss niveau 2 : Gorgrim, golem de racines.
  golem: {
    kind: 'golem',
    nameKey: 'enemy.golem',
    hp: 700,
    damage: 25,
    speed: 30,
    radius: 20,
    ai: 'boss-golem',
    attackRange: 40,
    attackCooldownMs: 2200,
    aggroRadius: 400,
    isBoss: true,
  },
  // Boss final : Morvane (3 phases).
  morvane: {
    kind: 'morvane',
    nameKey: 'enemy.morvane',
    hp: 1400,
    damage: 22,
    speed: 40,
    radius: 18,
    ai: 'boss-morvane',
    attackRange: 90,
    attackCooldownMs: 1800,
    aggroRadius: 500,
    isBoss: true,
  },

  // ───────── Niveaux 4-6 : un demi-boss (isMiniBoss) et un boss de fin (isBoss) par niveau ─────────
  // Demi-boss niveau 4 : gardien de givre. Mêlée lourde, charge, coup de sol ; rage à 50 % (2 phases). ≈ 3 × le chevalier.
  warden: {
    kind: 'warden',
    nameKey: 'enemy.warden',
    hp: 270,
    damage: 16,
    speed: 40,
    radius: 12,
    ai: 'miniboss-warden',
    attackRange: 30,
    attackCooldownMs: 1500,
    aggroRadius: 220,
    isBoss: false,
    isMiniBoss: true,
  },
  // Boss final niveau 4 : la Reine du Givre (3 phases : éclats en éventail/anneau, glissade, téléportation, chauves-souris).
  frostqueen: {
    kind: 'frostqueen',
    nameKey: 'enemy.frostqueen',
    hp: 1600,
    damage: 20,
    speed: 44,
    radius: 18,
    ai: 'boss-frostqueen',
    attackRange: 110,
    attackCooldownMs: 1700,
    aggroRadius: 500,
    isBoss: true,
  },
  // Demi-boss niveau 5 : pyromancien. Garde ses distances, nova de feu, feux follets ; 2 phases.
  pyromancer: {
    kind: 'pyromancer',
    nameKey: 'enemy.pyromancer',
    hp: 320,
    damage: 14,
    speed: 36,
    radius: 10,
    ai: 'miniboss-pyromancer',
    attackRange: 140,
    attackCooldownMs: 1600,
    aggroRadius: 240,
    isBoss: false,
    isMiniBoss: true,
  },
  // Boss final niveau 5 : seigneur de la forge (3 phases : marteau/onde de choc, rafales de boules de feu, enrage).
  forgelord: {
    kind: 'forgelord',
    nameKey: 'enemy.forgelord',
    hp: 1900,
    damage: 24,
    speed: 38,
    radius: 20,
    ai: 'boss-forgelord',
    attackRange: 60,
    attackCooldownMs: 1800,
    aggroRadius: 500,
    isBoss: true,
  },
  // Demi-boss niveau 6 : spectre (volant). Disparaît / réapparaît, tirs sombres ; 2 phases.
  wraith: {
    kind: 'wraith',
    nameKey: 'enemy.wraith',
    hp: 380,
    damage: 16,
    speed: 46,
    radius: 10,
    ai: 'miniboss-wraith',
    attackRange: 120,
    attackCooldownMs: 1500,
    aggroRadius: 240,
    isBoss: false,
    isMiniBoss: true,
  },
  // Boss final niveau 6 : seigneur du Néant (4 phases : téléportation, spirales, anneaux, zones de danger, invocations).
  voidlord: {
    kind: 'voidlord',
    nameKey: 'enemy.voidlord',
    hp: 2000,
    damage: 17,
    speed: 42,
    radius: 18,
    ai: 'boss-voidlord',
    attackRange: 120,
    attackCooldownMs: 1600,
    aggroRadius: 500,
    isBoss: true,
  },
};

/** Boss de fin de niveau (golem, morvane, frostqueen, forgelord, voidlord) : plafond de dégâts 20 %/2 s, barre de boss. */
export const BOSS_KINDS: readonly EnemyKind[] = ENEMY_KINDS.filter((k) => ENEMIES[k].isBoss);
/** Demi-boss des niveaux 4-6 (warden, pyromancer, wraith) : plafond de dégâts plus doux, sortie 'clear' bloquée tant qu'ils vivent. */
export const MINI_BOSS_KINDS: readonly EnemyKind[] = ENEMY_KINDS.filter((k) => ENEMIES[k].isMiniBoss === true);
/** Types d'ennemis volants : les fosses ne les bloquent pas (voir `collision.ts`). */
export const FLYING_KINDS: readonly EnemyKind[] = ['bat', 'wisp', 'morvane', 'wraith', 'voidlord'];

/** Vrai si `kind` est un boss de fin de niveau (`isBoss`). Faux pour un type inconnu. */
export function isBossKind(kind: EnemyKind | string): boolean {
  return ENEMIES[kind as EnemyKind]?.isBoss === true;
}

/** Vrai si `kind` est un demi-boss (`isMiniBoss`, niveaux 4-6). Faux pour un type inconnu. */
export function isMiniBossKind(kind: EnemyKind | string): boolean {
  return ENEMIES[kind as EnemyKind]?.isMiniBoss === true;
}

/** Vrai pour un boss OU un demi-boss (IA de boss : jamais étourdi ni repoussé, aggro illimité une fois engagé, phases). */
export function isAnyBossKind(kind: EnemyKind | string): boolean {
  return isBossKind(kind) || isMiniBossKind(kind);
}

/** Vrai si `kind` vole (les fosses ne le bloquent pas). */
export function isFlyingKind(kind: EnemyKind | string): boolean {
  return (FLYING_KINDS as readonly string[]).includes(kind);
}

/**
 * Définition d'un type d'ennemi. Lance une erreur si le type est inconnu (donnée de niveau invalide).
 * @param kind type d'ennemi
 */
export function getEnemyDef(kind: EnemyKind): EnemyDef {
  const def = ENEMIES[kind];
  if (!def) throw new Error(`Ennemi inconnu : ${String(kind)}`);
  return def;
}
