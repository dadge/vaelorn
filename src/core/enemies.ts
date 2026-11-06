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
};

/**
 * Définition d'un type d'ennemi. Lance une erreur si le type est inconnu (donnée de niveau invalide).
 * @param kind type d'ennemi
 */
export function getEnemyDef(kind: EnemyKind): EnemyDef {
  const def = ENEMIES[kind];
  if (!def) throw new Error(`Ennemi inconnu : ${String(kind)}`);
  return def;
}
