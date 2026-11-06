/**
 * « Cerveau » des bots de test : suivi de chemin, combat, esquive, relevage et regroupement.
 *
 * Tout est déterministe (aucun Math.random/Date.now) et ne produit que des `ActionFrame` : les bots ne touchent jamais
 * l'état de la simulation. `botKit.ts` (BotRun/BotPlayer) appelle ces fonctions ; les actions de `botActions.ts`
 * aussi.
 *
 * Conventions de mouvement : la simulation multiplie la vitesse du personnage par `min(1, norme(moveX, moveY))`. Un bot
 * peut donc atterrir PILE sur un point en réduisant l'amplitude du dernier pas (`distance / (vitesse × dt)`). Pour
 * tourner un personnage sans le déplacer on envoie une entrée minuscule (`NUDGE`) dans la direction voulue : le
 * `facing` change (axe dominant) mais le déplacement est de l'ordre de 0,05 px.
 */
import { DOWNED_THREAT_RADIUS, PLAYER_RADIUS, REVIVE_RANGE, SIM_STEP_MS, TILE } from '../core/constants';
import { canOccupy, projectileHitsWall, segmentBlocked } from '../core/collision';
import { getCharacter } from '../core/characters';
import { enemyRadius, meleeTargets } from '../core/combat';
import { ENEMIES } from '../core/enemies';
import { dirFromVec, dist, pointInTileRect } from '../core/geometry';
import type { ActionFrame, Dir, EnemyKind, EnemyState, PlayerState, Vec2 } from '../core/types';
import type { BackgroundFlags } from './botTypes';
import type { BotPlayer } from './botKit';
import {
  buildAvoidCost,
  buildNavMap,
  findPath,
  isPassable,
  nearestPassableTile,
  sweepClear,
  tileCenterOf,
  tileIndex,
  tileOfPx,
} from './pathfinding';

// ───────────────────────────── Constantes ─────────────────────────────

/** Amplitude (0..1) d'une entrée de « rotation sur place » : change le facing sans déplacer visiblement. */
export const NUDGE = 0.04;
/** Distance (px) en dessous de laquelle on tente d'abord la ligne droite (si libre) au lieu de planifier. */
const DIRECT_MAX_PX = 200;
/** Distance (px) d'atteinte d'un point de passage intermédiaire. */
const WAYPOINT_REACH_PX = 3;
/** Nombre de pas entre deux évaluations du lissage / de la ligne droite. */
const SMOOTH_EVERY_TICKS = 5;
/** Nombre de pas observés pour détecter un blocage. */
const STUCK_WINDOW_STEPS = 24;
/** Déplacement minimal (px) attendu sur la fenêtre de blocage. */
const STUCK_MIN_MOVE_PX = 1.0;
/** Durée (ms) pendant laquelle une tuile jugée bloquante est évitée par la replanification. */
const TEMP_BLOCK_MS = 2500;
/** Rayon (px) d'évitement des ennemis par le planificateur et surcoût maximal. */
const AVOID_RADIUS_PX = 40;
const AVOID_STRENGTH = 6;

// ───────────────────────────── Petits utilitaires ─────────────────────────────

const ZERO: Readonly<Vec2> = Object.freeze({ x: 0, y: 0 });

/** Frame vide complétée par `partial`. */
export function frameOf(partial: Partial<ActionFrame> = {}): ActionFrame {
  return { moveX: 0, moveY: 0, attack: false, interact: false, revive: false, ...partial };
}

function unit(v: Vec2): Vec2 {
  const l = Math.hypot(v.x, v.y);
  return l < 1e-9 ? { x: 0, y: 0 } : { x: v.x / l, y: v.y / l };
}

/** Distance (px) parcourue en UN pas à pleine amplitude par ce joueur. */
export function stepDistanceOf(player: PlayerState): number {
  return (getCharacter(player.characterId).speed * SIM_STEP_MS) / 1000;
}

/**
 * Vecteur de mouvement (norme ≤ 1) pour aller de `from` vers `to`. Si `slow` est vrai, la norme est réduite pour ne pas
 * dépasser la cible dans le pas (arrivée exacte).
 */
export function moveVector(from: Vec2, to: Vec2, stepDist: number, slow = true): Vec2 {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-9) return { x: 0, y: 0 };
  const amp = slow ? Math.min(1, d / Math.max(1e-6, stepDist)) : 1;
  return { x: (dx / d) * amp, y: (dy / d) * amp };
}

/** Distance d'un point à un segment [a, b]. */
function distPointSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const l2 = abx * abx + aby * aby;
  if (l2 < 1e-9) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / l2));
  return dist(p, { x: a.x + abx * t, y: a.y + aby * t });
}

/** Un ennemi vivant est-il à moins de `radius` px de `pos` ? */
export function enemyWithin(enemies: readonly EnemyState[], pos: Vec2, radius: number): boolean {
  for (const e of enemies) if (dist(e.pos, pos) <= radius) return true;
  return false;
}

// ───────────────────────────── Mémoire d'un bot ─────────────────────────────

/** Mémoire à court terme du cerveau d'un bot (ciblage, esquive, regroupement). */
export class BrainMemory {
  /** Cible de combat courante (id d'ennemi) — évite de changer de cible à chaque pas. */
  targetId: number | null = null;
  /** Ennemis ignorés jusqu'à une date (id → temps de jeu en ms) : inatteignables, derrière un mur… */
  readonly skipUntil = new Map<number, number>();
  /** Temps cumulé d'esquive continue (ms). */
  dodgeMs = 0;
  /** Pas d'esquive possible avant cette date (borne la fraction du temps passée à esquiver). */
  dodgeBlockedUntil = -Infinity;
  /** Le bot est en train de rejoindre ses alliés (hystérésis du regroupement). */
  regrouping = false;

  /** Oublie tout (changement de salle). */
  reset(): void {
    this.targetId = null;
    this.skipUntil.clear();
    this.dodgeMs = 0;
    this.dodgeBlockedUntil = -Infinity;
    this.regrouping = false;
  }
}

// ───────────────────────────── Suivi de chemin ─────────────────────────────

/** But d'un déplacement. */
export interface FollowGoal {
  /** Point visé (px). */
  pos: Vec2;
  /** Arrivée quand la distance au point est ≤ tolerance (mode précis). */
  tolerance: number;
  /**
   * Mode « près de » : toute tuile dont le centre est à ≤ `near − 1,5` px de `pos` est un but valide, et l'arrivée est
   * déclarée à ≤ `near` px. Sert pour les portes (solides), leviers, joueurs à terre, ennemis.
   */
  near?: number;
  /** Surcoût de chemin autour des ennemis vivants (défaut false). */
  avoidEnemies?: boolean;
  /** Id d'un ennemi à ne pas éviter (la cible d'un combat). */
  ignoreEnemyId?: number;
  /** Période de replanification (ms) ; défaut : 400 si `avoidEnemies`, sinon aucune (seulement si l'environnement change). */
  replanMs?: number;
}

/** État d'un suivi de chemin. */
export type FollowStatus = 'arrived' | 'moving' | 'unreachable' | 'blocked';

/** Résultat d'un pas de suivi : statut et vecteur de mouvement (norme ≤ 1) à envoyer à la simulation. */
export interface FollowResult {
  status: FollowStatus;
  vec: Vec2;
}

/**
 * Suivi de chemin d'un bot : planification (Dijkstra 8-connexe sur la grille de tuiles, hors murs/fosses/portes
 * fermées/blocs, avec surcoût près des ennemis), lissage par lignes droites libres, replanification quand le décor
 * change (porte qui s'ouvre, bloc qui bouge), détection de blocage (tuile contournée, petit pas de côté, échec après
 * plusieurs blocages rapprochés).
 */
export class PathFollower {
  private path: Vec2[] = [];
  private idx = 0;
  private plannedAtMs = -Infinity;
  private plannedGoal: Vec2 | null = null;
  private plannedKey = '';
  private failedKey = '';
  private failedAtMs = -Infinity;
  private readonly temp = new Map<number, number>();
  private watchSteps = 0;
  private watchPos: Vec2 | null = null;
  private stuckTimes: number[] = [];
  private wiggleSteps = 0;
  private wiggleVec: Vec2 = { x: 0, y: 0 };
  private noDirectUntil = -Infinity;
  private lastEvalTick = -1000;
  private lastDirectClear = false;
  private lastSmoothTick = -1000;

  /** Oublie le chemin, les blocages et les tuiles évitées (changement de but, de salle). */
  reset(): void {
    this.path = [];
    this.idx = 0;
    this.plannedAtMs = -Infinity;
    this.plannedGoal = null;
    this.plannedKey = '';
    this.failedKey = '';
    this.failedAtMs = -Infinity;
    this.temp.clear();
    this.watchSteps = 0;
    this.watchPos = null;
    this.stuckTimes = [];
    this.wiggleSteps = 0;
    this.noDirectUntil = -Infinity;
    this.lastEvalTick = -1000;
    this.lastDirectClear = false;
    this.lastSmoothTick = -1000;
  }

  /** Marque le suivi comme « à l'arrêt » (l'appelant ne se déplace pas ce pas) : remet la détection de blocage à zéro. */
  idle(): void {
    this.watchSteps = 0;
    this.watchPos = null;
  }

  /**
   * Un pas de suivi vers `goal`. Ne mute rien d'autre que son propre état.
   * @returns statut ('arrived' : but atteint ; 'moving' : appliquer `vec` ; 'unreachable' : aucun chemin pour l'instant —
   *   l'appelant peut réessayer, le décor peut changer ; 'blocked' : bloqué physiquement à répétition) et vecteur de mouvement
   */
  follow(bot: BotPlayer, goal: FollowGoal): FollowResult {
    const run = bot.run;
    const p = bot.player;
    const now = run.timeMs;
    const tick = run.sim.state.tick;
    const stepDist = stepDistanceOf(p);
    const d = dist(p.pos, goal.pos);
    const arriveR = goal.near !== undefined ? goal.near : goal.tolerance;
    if (d <= arriveR) {
      this.idle();
      return { status: 'arrived', vec: { ...ZERO } };
    }

    // Petit pas de côté après un blocage.
    if (this.wiggleSteps > 0) {
      this.wiggleSteps--;
      return { status: 'moving', vec: { ...this.wiggleVec } };
    }

    // 1. Ligne droite libre ?
    if (now >= this.noDirectUntil && d <= DIRECT_MAX_PX) {
      let aim = goal.pos;
      if (goal.near !== undefined && d > 1e-6) {
        const k = Math.max(0, (d - goal.near * 0.85) / d);
        aim = { x: p.pos.x + (goal.pos.x - p.pos.x) * k, y: p.pos.y + (goal.pos.y - p.pos.y) * k };
      }
      if (tick - this.lastEvalTick >= SMOOTH_EVERY_TICKS) {
        this.lastEvalTick = tick;
        this.lastDirectClear = sweepClear(run.sim.grid, run.solids, p.pos, aim);
      }
      if (this.lastDirectClear && !(goal.avoidEnemies && this.segmentNearEnemy(bot, p.pos, aim, goal.ignoreEnemyId))) {
        this.path = [];
        return this.moving(bot, now, d, moveVector(p.pos, aim, stepDist, goal.near === undefined));
      }
    }

    // 2. Chemin planifié.
    const goalKey = `${Math.round(goal.pos.x / 8)},${Math.round(goal.pos.y / 8)},${goal.near ?? -1}`;
    const replanMs = goal.replanMs ?? (goal.avoidEnemies ? 400 : Infinity);
    const needPlan =
      this.path.length === 0 ||
      this.plannedKey !== run.solidsKey ||
      now - this.plannedAtMs >= replanMs ||
      (this.plannedGoal !== null && dist(goal.pos, this.plannedGoal) > 12);
    if (needPlan) {
      const failKey = `${run.solidsKey}|${goalKey}|${tileOfPx(p.pos).join(',')}`;
      if (this.failedKey === failKey && now - this.failedAtMs < 400) {
        this.idle();
        return { status: 'unreachable', vec: { ...ZERO } };
      }
      if (!this.plan(bot, goal, now)) {
        this.failedKey = failKey;
        this.failedAtMs = now;
        this.path = [];
        this.idle();
        return { status: 'unreachable', vec: { ...ZERO } };
      }
    }

    // 3. Avancer le long du chemin.
    const last = this.path.length - 1;
    while (this.idx < last && dist(p.pos, this.path[this.idx]) < WAYPOINT_REACH_PX) this.idx++;
    if (this.idx >= last && dist(p.pos, this.path[last]) < 1.5) {
      this.idle();
      return { status: 'arrived', vec: { ...ZERO } };
    }
    if (this.idx < last && tick - this.lastSmoothTick >= SMOOTH_EVERY_TICKS) {
      this.lastSmoothTick = tick;
      for (let j = Math.min(this.idx + 6, last); j > this.idx; j--) {
        if (sweepClear(run.sim.grid, run.solids, p.pos, this.path[j])) {
          this.idx = j;
          break;
        }
      }
    }
    const target = this.path[this.idx];
    return this.moving(bot, now, d, moveVector(p.pos, target, stepDist, this.idx >= last));
  }

  /** Résultat « en mouvement » : passe d'abord par la détection de blocage (qui peut imposer un pas de côté ou déclarer le blocage). */
  private moving(bot: BotPlayer, now: number, d: number, vec: Vec2): FollowResult {
    if (this.watchStuck(bot, now, d) === 'blocked') return { status: 'blocked', vec: { ...ZERO } };
    if (this.wiggleSteps > 0) {
      this.wiggleSteps--;
      return { status: 'moving', vec: { ...this.wiggleVec } };
    }
    return { status: 'moving', vec };
  }

  /** Détection de blocage : retourne 'blocked' après plusieurs blocages rapprochés, sinon réagit (replanification + pas de côté). */
  private watchStuck(bot: BotPlayer, now: number, d: number): 'ok' | 'blocked' {
    const p = bot.player;
    if (d < 2.5) {
      this.idle();
      return 'ok';
    }
    if (this.watchPos === null) {
      this.watchPos = { x: p.pos.x, y: p.pos.y };
      this.watchSteps = 0;
      return 'ok';
    }
    this.watchSteps++;
    if (this.watchSteps < STUCK_WINDOW_STEPS) return 'ok';
    const moved = dist(p.pos, this.watchPos);
    this.watchPos = { x: p.pos.x, y: p.pos.y };
    this.watchSteps = 0;
    if (moved >= STUCK_MIN_MOVE_PX) return 'ok';
    // Blocage détecté.
    this.stuckTimes = this.stuckTimes.filter((t) => now - t < 4000);
    this.stuckTimes.push(now);
    if (this.stuckTimes.length >= 4) {
      this.stuckTimes = [];
      this.path = [];
      return 'blocked';
    }
    const nav = bot.run.navMap();
    const wp = this.path[this.idx];
    if (wp) {
      const t = tileOfPx(wp);
      const own = tileOfPx(p.pos);
      if (!(t[0] === own[0] && t[1] === own[1]) && isPassable(nav, t[0], t[1])) {
        this.temp.set(tileIndex(nav, t[0], t[1]), now + TEMP_BLOCK_MS);
      }
    }
    this.path = [];
    this.noDirectUntil = now + 1000;
    const toward = wp ? unit({ x: wp.x - p.pos.x, y: wp.y - p.pos.y }) : { x: 1, y: 0 };
    const sign = this.stuckTimes.length % 2 === 0 ? 1 : -1;
    this.wiggleVec = { x: -toward.y * sign, y: toward.x * sign };
    this.wiggleSteps = 10;
    return 'ok';
  }

  private segmentNearEnemy(bot: BotPlayer, a: Vec2, b: Vec2, ignoreId?: number): boolean {
    for (const e of bot.run.aliveEnemies) {
      if (e.id === ignoreId) continue;
      if (distPointSegment(e.pos, a, b) < 26) return true;
    }
    return false;
  }

  private plan(bot: BotPlayer, goal: FollowGoal, now: number): boolean {
    const run = bot.run;
    const p = bot.player;
    for (const [k, until] of this.temp) if (until <= now) this.temp.delete(k);
    const nav = this.temp.size > 0 ? buildNavMap(run.sim.grid, run.solids, new Set(this.temp.keys())) : run.navMap();
    const start = tileOfPx(p.pos);
    let isGoal: (tx: number, ty: number) => boolean;
    let goalTile: [number, number] | null = null;
    if (goal.near !== undefined) {
      const r = Math.max(2, goal.near - 1.5);
      isGoal = (tx, ty) => Math.hypot((tx + 0.5) * TILE - goal.pos.x, (ty + 0.5) * TILE - goal.pos.y) <= r;
    } else {
      let gt = tileOfPx(goal.pos);
      const wasPassable = isPassable(nav, gt[0], gt[1]);
      if (!wasPassable) gt = nearestPassableTile(nav, gt) ?? gt;
      goalTile = wasPassable ? [gt[0], gt[1]] : null;
      const gx = gt[0];
      const gy = gt[1];
      isGoal = (tx, ty) => tx === gx && ty === gy;
    }
    let cost: Float32Array | null = null;
    if (goal.avoidEnemies) {
      const pts = run.aliveEnemies.filter((e) => e.id !== goal.ignoreEnemyId).map((e) => e.pos);
      cost = buildAvoidCost(nav, pts, AVOID_RADIUS_PX, AVOID_STRENGTH);
    }
    const tiles = findPath(nav, start, isGoal, { extraCost: cost });
    if (!tiles) return false;
    const wps = tiles.slice(1).map((t) => tileCenterOf(t));
    if (goal.near !== undefined) {
      if (wps.length === 0) wps.push(tileCenterOf(tiles[0]));
    } else if (goalTile) {
      if (wps.length === 0) wps.push({ x: goal.pos.x, y: goal.pos.y });
      else wps[wps.length - 1] = { x: goal.pos.x, y: goal.pos.y };
    } else if (wps.length === 0) {
      wps.push(tileCenterOf(tiles[0]));
    }
    this.path = wps;
    this.idx = 0;
    this.plannedAtMs = now;
    this.plannedGoal = { x: goal.pos.x, y: goal.pos.y };
    this.plannedKey = run.solidsKey;
    this.lastSmoothTick = -1000;
    return true;
  }
}

// ───────────────────────────── Esquive ─────────────────────────────

/**
 * Esquive simple : (1) un projectile ennemi qui va nous toucher dans < 0,5 s → pas de côté ; (2) un ennemi au corps à corps
 * en télégraphe d'attaque (`mode === 'windup'`) alors que notre attaque n'est pas prête → recul. L'esquive est bornée
 * (≈ 35 % du temps au maximum) pour ne jamais empêcher de combattre. Retourne un vecteur de mouvement de norme 1, ou null.
 */
export function computeDodge(bot: BotPlayer): Vec2 | null {
  const run = bot.run;
  const p = bot.player;
  const mem = bot.mem;
  const now = run.timeMs;
  if (p.invulnMs > 250 || now < mem.dodgeBlockedUntil) {
    mem.dodgeMs = Math.max(0, mem.dodgeMs - SIM_STEP_MS);
    return null;
  }
  const grid = run.sim.grid;
  const solids = run.solids;
  let vec: Vec2 | null = null;

  for (const pr of run.sim.state.room.projectiles) {
    if (pr.owner.type !== 'enemy') continue;
    const sp = Math.hypot(pr.vel.x, pr.vel.y);
    if (sp < 1) continue;
    const rel = { x: p.pos.x - pr.pos.x, y: p.pos.y - pr.pos.y };
    if (Math.hypot(rel.x, rel.y) > 90) continue;
    const t = (rel.x * pr.vel.x + rel.y * pr.vel.y) / (sp * sp);
    if (t < 0 || t > 0.5) continue;
    const closest = { x: rel.x - pr.vel.x * t, y: rel.y - pr.vel.y * t };
    if (Math.hypot(closest.x, closest.y) >= PLAYER_RADIUS + pr.radius + 3) continue;
    const n = { x: -pr.vel.y / sp, y: pr.vel.x / sp };
    const side = n.x * rel.x + n.y * rel.y >= 0 ? 1 : -1;
    for (const s of [side, -side]) {
      const cand = { x: n.x * s, y: n.y * s };
      if (canOccupy({ x: p.pos.x + cand.x * 10, y: p.pos.y + cand.y * 10 }, PLAYER_RADIUS, grid, solids)) {
        vec = cand;
        break;
      }
    }
    if (vec) break;
  }

  if (!vec && p.attackCooldownMs > 100) {
    for (const e of run.aliveEnemies) {
      if (e.mode !== 'windup') continue;
      const def = ENEMIES[e.kind];
      if (def.ai === 'ranged' || def.ai === 'caster' || def.isBoss) continue;
      const d = dist(e.pos, p.pos);
      if (d > def.attackRange + enemyRadius(e) + 12) continue;
      const away = unit({ x: p.pos.x - e.pos.x, y: p.pos.y - e.pos.y });
      if (away.x === 0 && away.y === 0) continue;
      if (canOccupy({ x: p.pos.x + away.x * 10, y: p.pos.y + away.y * 10 }, PLAYER_RADIUS, grid, solids)) {
        vec = away;
        break;
      }
    }
  }

  if (vec) {
    mem.dodgeMs += SIM_STEP_MS;
    if (mem.dodgeMs > 350) {
      mem.dodgeBlockedUntil = now + 700;
      mem.dodgeMs = 0;
    }
  } else {
    mem.dodgeMs = Math.max(0, mem.dodgeMs - SIM_STEP_MS);
  }
  return vec;
}

// ───────────────────────────── Combat ─────────────────────────────

/** Demande de combat. */
export interface CombatRequest {
  /**
   * 'chase' : se rapproche de la cible jusqu'à la portée efficace de son personnage puis attaque ;
   * 'inPlace' : ne se déplace pas (rotation sur place uniquement) et attaque ce qui est à portée.
   */
  mode: 'chase' | 'inPlace';
  /** Rayon (px) de prise de cible en mode 'chase' (défaut : `engageRadius` du bot ; Infinity accepté). */
  radius?: number;
  /** Ne combattre que cet ennemi (id). */
  forcedTargetId?: number | null;
  /** Autorise l'esquive (défaut : option `dodge` du bot). */
  dodge?: boolean;
  /** Ne viser que ces types d'ennemis (défaut : tous). */
  kinds?: readonly EnemyKind[];
}

/** Décision de combat d'un pas. */
export interface CombatDecision {
  frame: ActionFrame;
  /** Ennemi visé (-1 pour une esquive pure). */
  targetId: number;
}

function wallBetween(bot: BotPlayer, a: Vec2, b: Vec2): boolean {
  return segmentBlocked(a, b, bot.run.sim.grid, bot.run.solids);
}

/**
 * Un projectile de rayon `radius` peut-il aller de `a` à `b` sans toucher un mur, un pilier, une porte fermée ou un bloc ?
 * (les fosses n'arrêtent pas les projectiles). Plus strict que `segmentBlocked` : un tir rasant le coin d'un pilier est perdu.
 */
export function shotClear(bot: BotPlayer, a: Vec2, b: Vec2, radius: number): boolean {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const n = Math.max(1, Math.ceil(len / 2.5));
  const grid = bot.run.sim.grid;
  const solids = bot.run.solids;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    if (projectileHitsWall({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, radius, grid, solids)) return false;
  }
  return true;
}

/** Attaque de mêlée possible depuis la position/orientation actuelles sur au moins un ennemi de `list` dans la direction `dir` ? */
function canMeleeHit(bot: BotPlayer, list: readonly EnemyState[], dir: Dir): boolean {
  return meleeTargets(bot.player, list, bot.run.sim.grid, bot.run.solids, dir).length > 0;
}

function skipEnemy(bot: BotPlayer, e: EnemyState, ms: number): void {
  bot.mem.skipUntil.set(e.id, bot.run.timeMs + ms);
}

/**
 * Décide l'action de combat de ce pas. Retourne null s'il n'y a rien à combattre (ou rien d'atteignable).
 *
 * Mêlée : se place à `portée − 3 px` de la cible (centre à centre, rayon de l'ennemi compris), tourne face à elle
 * (entrée minuscule) et frappe quand `meleeTargets` confirme que l'arc touche. Distance : s'aligne sur un axe avec la cible
 * (écart perpendiculaire ≤ rayon ennemi + rayon projectile − 1,5), garde environ 85 % de la portée au maximum et tire quand la
 * ligne est dégagée (murs/portes/blocs ; les fosses n'arrêtent pas les projectiles). Cible inatteignable : ignorée 1,5 s.
 */
export function decideCombat(bot: BotPlayer, req: CombatRequest): CombatDecision | null {
  const p = bot.player;
  if (p.status !== 'alive') return null;
  const run = bot.run;
  const enemies = run.aliveEnemies;
  if (enemies.length === 0) {
    bot.mem.targetId = null;
    return null;
  }
  if (req.mode === 'inPlace') return decideInPlaceCombat(bot, req.forcedTargetId ?? null);

  const now = run.timeMs;
  const radius = req.radius ?? bot.opts.engageRadius;
  const forced = req.forcedTargetId ?? null;
  const cands: { e: EnemyState; d: number }[] = [];
  for (const e of enemies) {
    if (forced !== null && e.id !== forced) continue;
    if (req.kinds && !req.kinds.includes(e.kind)) continue;
    const skip = bot.mem.skipUntil.get(e.id);
    if (skip !== undefined && skip > now) continue;
    const d = dist(p.pos, e.pos);
    if (d > radius) continue;
    cands.push({ e, d });
  }
  if (cands.length === 0) return null;
  cands.sort((a, b) => a.d - b.d || a.e.id - b.e.id);
  // Fidélité à la cible : on garde la précédente si elle n'est pas beaucoup plus loin que la meilleure.
  const sticky = cands.findIndex((c) => c.e.id === bot.mem.targetId);
  if (sticky > 0 && cands[sticky].d <= cands[0].d * 1.3 + 8) {
    const [c] = cands.splice(sticky, 1);
    cands.unshift(c);
  }

  if ((req.dodge ?? bot.opts.dodge) === true) {
    const dv = computeDodge(bot);
    if (dv) return { frame: frameOf({ moveX: dv.x, moveY: dv.y }), targetId: -1 };
  }

  const def = getCharacter(p.characterId);
  for (let i = 0; i < Math.min(4, cands.length); i++) {
    const e = cands[i].e;
    const res = def.attack.kind === 'melee' ? engageMelee(bot, e) : engageRanged(bot, e);
    if (res) {
      bot.mem.targetId = e.id;
      return { frame: res, targetId: e.id };
    }
  }
  return null;
}

function engageMelee(bot: BotPlayer, e: EnemyState): ActionFrame | null {
  const p = bot.player;
  const run = bot.run;
  const atk = getCharacter(p.characterId).attack;
  const er = enemyRadius(e);
  const reach = Math.max(6, atk.range + er - 3);
  const d = dist(p.pos, e.pos);
  const delta = { x: e.pos.x - p.pos.x, y: e.pos.y - p.pos.y };

  if (d <= reach && !wallBetween(bot, p.pos, e.pos)) {
    bot.follower.idle();
    if (canMeleeHit(bot, [e], p.facing)) return frameOf({ attack: true });
    const v = unit(delta);
    const dirN = dirFromVec(v, p.facing);
    if (canMeleeHit(bot, [e], dirN)) return frameOf({ moveX: v.x * NUDGE, moveY: v.y * NUDGE, attack: true });
    // Dans la portée mais l'arc ne touche pas : on se rapproche un peu.
  }

  const r = bot.follower.follow(bot, {
    pos: e.pos,
    tolerance: 1,
    near: Math.max(8, reach * 0.9),
    avoidEnemies: false,
    replanMs: 200,
  });
  if (r.status === 'unreachable' || r.status === 'blocked') {
    skipEnemy(bot, e, 1500);
    return null;
  }
  if (r.status === 'arrived') {
    // Arrivé près de l'ennemi mais sans pouvoir le frapper (mur entre nous) : on l'ignore un moment.
    if (wallBetween(bot, p.pos, e.pos)) {
      skipEnemy(bot, e, 1500);
      return null;
    }
    const v = unit(delta);
    return frameOf({ moveX: v.x * NUDGE, moveY: v.y * NUDGE, attack: canMeleeHit(bot, [e], dirFromVec(v, p.facing)) });
  }
  const dir = dirFromVec(r.vec, p.facing);
  return frameOf({ moveX: r.vec.x, moveY: r.vec.y, attack: canMeleeHit(bot, run.aliveEnemies, dir) });
}

function engageRanged(bot: BotPlayer, e: EnemyState): ActionFrame | null {
  const p = bot.player;
  const atk = getCharacter(p.characterId).attack;
  const proj = atk.projectile;
  const pr = proj ? proj.radius : 3;
  const er = enemyRadius(e);
  const tol = Math.max(2, er + pr - 1.5);
  const maxShot = atk.range * 0.85;
  const stepDist = stepDistanceOf(p);
  const dx = e.pos.x - p.pos.x;
  const dy = e.pos.y - p.pos.y;
  const horiz = Math.abs(dy) <= Math.abs(dx);
  const perp = horiz ? dy : dx;
  const along = horiz ? dx : dy;
  const los = shotClear(bot, p.pos, e.pos, pr);

  if (los && Math.abs(perp) <= tol && Math.abs(along) <= maxShot) {
    bot.follower.idle();
    const s = along >= 0 ? 1 : -1;
    return frameOf(
      horiz ? { moveX: s * NUDGE, attack: true } : { moveY: s * NUDGE, attack: true },
    );
  }

  if (!los) {
    // Pas de ligne de tir : on s'approche (jusqu'à ~1 tuile) ; dès que la ligne se dégage, la branche de tir ci-dessus reprend.
    const r = bot.follower.follow(bot, {
      pos: e.pos,
      tolerance: 1,
      near: 14,
      avoidEnemies: false,
      replanMs: 250,
    });
    if (r.status === 'unreachable' || r.status === 'blocked') {
      skipEnemy(bot, e, 1500);
      return null;
    }
    if (r.status === 'arrived') {
      skipEnemy(bot, e, 1500);
      return null;
    }
    return frameOf({ moveX: r.vec.x, moveY: r.vec.y });
  }

  // Ligne dégagée : on s'aligne (axe perpendiculaire) et on règle la distance (axe du tir).
  const s = along >= 0 ? 1 : -1;
  let vAlong = 0;
  if (Math.abs(along) > maxShot * 0.9) vAlong = s;
  else if (Math.abs(along) < bot.opts.kiteDistance) vAlong = -s;
  let vPerp = 0;
  if (Math.abs(perp) > tol * 0.5) vPerp = Math.max(-1, Math.min(1, perp / Math.max(1e-6, stepDist)));
  const v = horiz ? { x: vAlong, y: vPerp } : { x: vPerp, y: vAlong };
  const n = Math.hypot(v.x, v.y);
  if (n < 1e-6) {
    // Aligné et à bonne distance mais hors de portée de tir exacte : on avance.
    return frameOf(horiz ? { moveX: s } : { moveY: s });
  }
  const k = n > 1 ? 1 / n : 1;
  return frameOf({ moveX: v.x * k, moveY: v.y * k });
}

/** Combat sans déplacement : frappe/tire sur ce qui est à portée en pivotant sur place. */
function decideInPlaceCombat(bot: BotPlayer, forced: number | null): CombatDecision | null {
  const p = bot.player;
  const run = bot.run;
  const def = getCharacter(p.characterId);
  const atk = def.attack;
  const list = run.aliveEnemies
    .filter((e) => forced === null || e.id === forced)
    .map((e) => ({ e, d: dist(p.pos, e.pos) }))
    .sort((a, b) => a.d - b.d || a.e.id - b.e.id);
  for (const { e, d } of list) {
    const er = enemyRadius(e);
    if (atk.kind === 'melee' ? wallBetween(bot, p.pos, e.pos) : !shotClear(bot, p.pos, e.pos, atk.projectile ? atk.projectile.radius : 3)) continue;
    if (atk.kind === 'melee') {
      if (d > atk.range + er - 1) continue;
      if (canMeleeHit(bot, [e], p.facing)) return { frame: frameOf({ attack: true }), targetId: e.id };
      const v = unit({ x: e.pos.x - p.pos.x, y: e.pos.y - p.pos.y });
      if (canMeleeHit(bot, [e], dirFromVec(v, p.facing))) {
        return { frame: frameOf({ moveX: v.x * NUDGE, moveY: v.y * NUDGE, attack: true }), targetId: e.id };
      }
    } else {
      const pr = atk.projectile ? atk.projectile.radius : 3;
      const tol = Math.max(2, er + pr - 1.5);
      const dx = e.pos.x - p.pos.x;
      const dy = e.pos.y - p.pos.y;
      const maxShot = atk.range * 0.85;
      if (Math.abs(dy) <= tol && Math.abs(dx) <= maxShot) {
        return { frame: frameOf({ moveX: (dx >= 0 ? 1 : -1) * NUDGE, attack: true }), targetId: e.id };
      }
      if (Math.abs(dx) <= tol && Math.abs(dy) <= maxShot) {
        return { frame: frameOf({ moveY: (dy >= 0 ? 1 : -1) * NUDGE, attack: true }), targetId: e.id };
      }
    }
  }
  return null;
}

// ───────────────────────────── Relevage ─────────────────────────────

/**
 * Relevage automatique d'un allié à terre. Un seul bot « disponible » (sans action scriptée prioritaire) est désigné :
 * le plus proche de l'allié à terre. Il rejoint l'allié (à ≤ REVIVE_RANGE − 3 px) et maintient `revive` jusqu'au relevage.
 * Conditions : aucun ennemi dans `reviveSafeRadius` autour de l'allié à terre ; le bot n'est pas en danger critique
 * (PV < `criticalHpFrac` avec un ennemi à < 50 px). Un relevage déjà commencé est maintenu (sauf danger critique : le
 * bot se bat alors). Retourne null si rien à faire.
 */
export function decideRevive(bot: BotPlayer): ActionFrame | null {
  const o = bot.opts;
  const p = bot.player;
  if (!o.revive || p.status !== 'alive') return null;
  const run = bot.run;
  const players = run.sim.state.players;
  const downed = players.filter((t) => t.id !== p.id && t.status === 'down');
  if (downed.length === 0) return null;
  const critical = p.hp / p.maxHp < o.criticalHpFrac && enemyWithin(run.aliveEnemies, p.pos, 50);
  if (critical) return null;

  if (p.revivingId !== null) {
    const t = players.find((q) => q.id === p.revivingId);
    if (t && t.status === 'down') return frameOf({ revive: true });
  }

  downed.sort((a, b) => dist(p.pos, a.pos) - dist(p.pos, b.pos) || a.id - b.id);
  for (const t of downed) {
    if (t.reviverId !== null && t.reviverId !== p.id) continue;
    if (enemyWithin(run.aliveEnemies, t.pos, o.reviveSafeRadius)) continue;
    // Désignation du sauveteur : le bot disponible le plus proche.
    let best: BotPlayer | null = null;
    let bestD = Infinity;
    for (const b of run.bots) {
      const bp = b.player;
      if (bp.status !== 'alive' || !b.opts.revive || !b.backgroundEligible || bp.revivingId !== null) continue;
      const dd = dist(bp.pos, t.pos);
      if (dd < bestD) {
        bestD = dd;
        best = b;
      }
    }
    if (best !== null && best.id !== p.id && p.revivingId === null) continue;
    const d = dist(p.pos, t.pos);
    if (d <= REVIVE_RANGE - 2) {
      bot.follower.idle();
      return frameOf({ revive: true });
    }
    const r = bot.follower.follow(bot, { pos: t.pos, tolerance: 1, near: REVIVE_RANGE - 3, avoidEnemies: true });
    if (r.status === 'unreachable' || r.status === 'blocked') continue;
    if (r.status === 'arrived') return frameOf({ revive: true });
    return frameOf({ moveX: r.vec.x, moveY: r.vec.y, revive: d <= REVIVE_RANGE });
  }
  return null;
}

/** Relevage sans déplacement : un allié à terre est-il à portée ? Si oui, maintient `revive`. */
export function decideReviveInPlace(bot: BotPlayer): ActionFrame | null {
  const p = bot.player;
  if (p.status !== 'alive') return null;
  const run = bot.run;
  for (const t of run.sim.state.players) {
    if (t.id === p.id || t.status !== 'down') continue;
    if (t.reviverId !== null && t.reviverId !== p.id) continue;
    if (dist(p.pos, t.pos) <= REVIVE_RANGE - 2) {
      const critical = p.hp / p.maxHp < bot.opts.criticalHpFrac && enemyWithin(run.aliveEnemies, p.pos, 50);
      if (critical) return null;
      return frameOf({ revive: true });
    }
  }
  return null;
}

// ───────────────────────────── Regroupement ─────────────────────────────

/**
 * Regroupement : un bot inactif éloigné de plus de `regroupRadius` du plus proche allié vivant le rejoint (jusqu'à environ
 * 55 % de ce rayon : hystérésis). Aucun regroupement quand le bot se tient dans la zone de sortie de la salle.
 */
export function decideRegroup(bot: BotPlayer): ActionFrame | null {
  const o = bot.opts;
  const p = bot.player;
  if (!o.regroup || p.status !== 'alive') return null;
  const run = bot.run;
  if (pointInTileRect(p.pos, run.sim.room.exit.rect)) {
    bot.mem.regrouping = false;
    return null;
  }
  let ally: PlayerState | null = null;
  let ad = Infinity;
  for (const q of run.sim.state.players) {
    if (q.id === p.id || q.status !== 'alive') continue;
    const d = dist(p.pos, q.pos);
    if (d < ad) {
      ad = d;
      ally = q;
    }
  }
  if (!ally) return null;
  const stopR = o.regroupRadius * 0.55;
  if (ad <= stopR || (!bot.mem.regrouping && ad <= o.regroupRadius)) {
    bot.mem.regrouping = false;
    bot.follower.idle();
    return null;
  }
  bot.mem.regrouping = true;
  const r = bot.follower.follow(bot, { pos: ally.pos, tolerance: 1, near: stopR, avoidEnemies: true });
  if (r.status === 'moving') return frameOf({ moveX: r.vec.x, moveY: r.vec.y });
  if (r.status === 'arrived') bot.mem.regrouping = false;
  return null;
}

// ───────────────────────────── Agrégation ─────────────────────────────

/**
 * Comportements de fond d'un bot, par ordre de priorité : (1) relevage en cours (maintenu) ; (2) auto-combat sur les
 * ennemis dans `engageRadius` ; (3) relevage d'un allié à terre ; (4) regroupement. Seuls les comportements activés
 * dans `flags` ET dans `bot.opts` sont évalués. Retourne null si aucun n'agit.
 */
export function decideBackground(bot: BotPlayer, flags: BackgroundFlags): ActionFrame | null {
  const o = bot.opts;
  const p = bot.player;
  if (p.status !== 'alive') return null;
  if (flags.revive && o.revive && p.revivingId !== null) {
    const r = decideRevive(bot);
    if (r) return r;
  }
  if (flags.combat && o.combat) {
    const c = decideCombat(bot, { mode: 'chase', radius: o.engageRadius });
    if (c) return c.frame;
  }
  if (flags.revive && o.revive) {
    const r = decideRevive(bot);
    if (r) return r;
  }
  if (flags.regroup && o.regroup) {
    const g = decideRegroup(bot);
    if (g) return g;
  }
  return null;
}

/**
 * Comportement « sur place » (pour `standOn`) : relevage d'un allié à portée, sinon combat sans déplacement.
 * Ne bouge jamais le bot (hors rotation imperceptible).
 */
export function decideInPlace(bot: BotPlayer): ActionFrame | null {
  const p = bot.player;
  if (p.status !== 'alive') return null;
  const c = decideCombat(bot, { mode: 'inPlace' });
  if (c) return c.frame;
  return decideReviveInPlace(bot);
}

/** Rayon de menace d'un ennemi sur un joueur à terre (réexport pratique pour les diagnostics). */
export const DOWNED_THREAT_PX = DOWNED_THREAT_RADIUS;
