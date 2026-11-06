/**
 * IA des deux boss — logique pure (aucune dépendance à Phaser/DOM/Math.random/Date.now).
 *
 * Appelé par `updateEnemy` (ai.ts) pour les IA 'boss-golem' (Gorgrim, kind 'golem') et 'boss-morvane'
 * (Morvane, kind 'morvane'). N'accède qu'à `enemy` et au contexte `EnemyAIContext` ; le temps vient de `dtMs`,
 * le hasard de `ctx.random()`.
 *
 * ── Principes d'équité (1 à 4 joueurs) ──────────────────────────────────────────────────────────────────
 *  - TOUTE attaque commence par un mode 'windup' (télégraphe) d'au moins 600 ms (`MIN_BOSS_WINDUP_MS`) ;
 *    jamais de dégât sans avertissement. Les enchaînements (combos) re-télégraphent chaque coup.
 *  - Les boss ne ciblent QUE des joueurs vivants ; sans joueur vivant ils reviennent en 'idle' et annulent l'attaque.
 *  - Les invocations sont plafonnées (4 vivants max par boss, compté via `ctx.enemies`).
 *  - Plus il y a peu de joueurs vivants, plus les fenêtres de récupération sont longues (×1.2 à 1 joueur, ×1.1 à 2).
 *  - Changement de phase : rugissement de 1 s (mode 'recover', special ROAR) sans attaque.
 *
 * ── Phases (dérivées de hp/maxHp, monotones, `enemy.phase` : 0 = pas encore engagé, puis 1..3) ─────────
 *  Gorgrim  : phase 1 > 66 % ; phase 2 > 33 % ; phase 3 ≤ 33 %.
 *  Morvane  : phase 1 > 70 % ; phase 2 > 35 % ; phase 3 ≤ 35 %.
 *  `{type:'bossPhase'}` est émis à l'engagement (0 → 1) puis à chaque changement de phase.
 *
 * ── Machine à états (enemy.mode) ─────────────────────────────────────────────────────────────────────────
 *  'idle' (pas de cible) · 'chase' (marche/lévitation + choix d'attaque) · 'windup' (télégraphe) · 'attack'
 *  (exécution : projectiles / zone / charge) · 'recover' (fenêtre de vulnérabilité, ou rugissement) ·
 *  'teleport' (Morvane uniquement). Jamais 'stunned' (les boss ne sont ni repoussés ni étourdis).
 *
 * ── Clés `data` écrites pour le rendu (voir aussi ai.ts) ─────────────────────────────────────────────────
 *  special (ENEMY_SPECIALS), aimAngle (rad), windupTotalMs, telegraphRadius (px), telegraphLength (px),
 *  telegraphSpread (rad, éventail total), telegraphDist (px), activeTotalMs, teleportTotalMs, teleportToX/Y,
 *  teleportMoved, engaged.
 */
import { PLAYER_RADIUS } from './constants';
import { ENEMIES } from './enemies';
import { angleBetween, dirFromVec, dist, vecFromAngle } from './geometry';
import type { EnemyAIContext, EnemyKind, EnemyState, PlayerState } from './types';

// ───────────────────────────── Constantes publiques ─────────────────────────────

/**
 * Identifiants numériques de l'attaque annoncée/en cours (`enemy.data.special`), à l'usage du rendu.
 * 0 = attaque de base / aucune. Valeurs stables (ne pas renuméroter).
 */
export const ENEMY_SPECIALS = {
  NONE: 0,
  /** Araignée : bond rapide en ligne droite. */
  LEAP: 1,
  /** Chauve-souris : piqué. */
  DIVE: 2,
  /** Archer : tir de flèche. */
  SHOT: 3,
  /** Feu follet : salve d'orbes (éventail ou paire). */
  VOLLEY: 4,
  /** Gorgrim : frappe au sol (onde + anneau d'éclats). */
  SLAM: 5,
  /** Gorgrim : racines (lignes de projectiles). */
  ROOTS: 6,
  /** Boss : invocation de sbires. */
  SUMMON: 7,
  /** Gorgrim phase 3 : frappe au sol enchaînée, onde plus dense. */
  RAGE: 8,
  /** Morvane : éventail d'orbes. */
  FAN: 9,
  /** Morvane : anneau d'orbes. */
  RING: 10,
  /** Morvane phase 3 : spirale d'orbes. */
  SPIRAL: 11,
  /** Morvane phase 3 : charge en ligne droite. */
  CHARGE: 12,
  /** Téléportation (feu follet, Morvane). */
  TELEPORT: 13,
  /** Rugissement de changement de phase (aucune attaque). */
  ROAR: 14,
  /** Chevalier : coup lourd. */
  HEAVY: 15,
} as const;

/** Durée minimale (ms) du télégraphe d'une attaque de boss. */
export const MIN_BOSS_WINDUP_MS = 600;
/** Nombre maximal d'invocations vivantes par boss. */
export const MAX_BOSS_MINIONS = 4;
/** Durée (ms) du rugissement de changement de phase. */
export const PHASE_ROAR_MS = 1000;
/** Rayon (px) de l'onde de choc proche de Gorgrim. */
export const GOLEM_SLAM_RADIUS = 52;
/** Durée totale (ms) d'une téléportation de Morvane (disparition + réapparition). */
export const MORVANE_TELEPORT_MS = 700;

// ───────────────────────────── Constantes internes ─────────────────────────────

const S = ENEMY_SPECIALS;
const FIRST_ENGAGE_DELAY_MS = 1200;
const COMBO_GAP_MS = 280;
const ROOT_LENGTH = 135;
const CHARGE_SPEED = 300;
const CHARGE_LENGTH = 140;
const GOLEM_APPROACH_DIST = 90;
const GOLEM_FORCE_ATTACK_MS = 2200;

type SeqEntry = readonly [special: number, combo: number];

const GOLEM_SEQ: Readonly<Record<number, readonly SeqEntry[]>> = {
  1: [[S.SLAM, 0]],
  2: [
    [S.SUMMON, 0],
    [S.ROOTS, 0],
    [S.SLAM, 0],
    [S.ROOTS, 0],
  ],
  3: [
    [S.RAGE, 1],
    [S.ROOTS, 0],
    [S.RAGE, 1],
    [S.SUMMON, 0],
  ],
};

const MORVANE_SEQ: Readonly<Record<number, readonly SeqEntry[]>> = {
  1: [
    [S.FAN, 0],
    [S.FAN, 1],
  ],
  2: [
    [S.SUMMON, 0],
    [S.RING, 0],
    [S.FAN, 0],
    [S.RING, 0],
    [S.FAN, 1],
  ],
  3: [
    [S.SPIRAL, 0],
    [S.CHARGE, 0],
    [S.FAN, 0],
    [S.RING, 0],
    [S.SPIRAL, 0],
    [S.SUMMON, 0],
  ],
};

interface AttackSpec {
  windupMs: number;
  activeMs: number;
  recoverMs: number;
  /** Fraction initiale du télégraphe pendant laquelle la visée suit la cible (le reste : visée verrouillée). */
  trackFrac: number;
  radius: number;
  length: number;
  spread: number;
}

// ───────────────────────────── Petits utilitaires ─────────────────────────────

function gd(d: Record<string, number>, k: string): number {
  const v = d[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function faceAngle(enemy: EnemyState, angle: number): void {
  enemy.facing = dirFromVec(vecFromAngle(angle), enemy.facing);
}

function aliveCount(ctx: EnemyAIContext): number {
  let n = 0;
  for (const p of ctx.players) if (p.status === 'alive') n++;
  return n;
}

/** Fenêtres de récupération plus généreuses quand peu de joueurs sont en vie. */
function easeFactor(ctx: EnemyAIContext): number {
  const n = aliveCount(ctx);
  return n <= 1 ? 1.2 : n === 2 ? 1.1 : 1;
}

/**
 * Phase de boss dérivée des PV : 1..3 (jamais 0). Gorgrim : seuils 66 % / 33 % ; Morvane : 70 % / 35 %.
 * À exactement le seuil, la phase supérieure est atteinte.
 * @param kind 'golem' ou 'morvane' (tout autre type retourne 1)
 * @param hp PV courants
 * @param maxHp PV max
 */
export function bossPhaseFor(kind: EnemyKind, hp: number, maxHp: number): number {
  const ratio = maxHp > 0 && Number.isFinite(hp) ? hp / maxHp : 1;
  const [t2, t3] = kind === 'morvane' ? [0.7, 0.35] : [0.66, 0.33];
  if (ratio > t2) return 1;
  if (ratio > t3) return 2;
  return 3;
}

function clearTelegraph(d: Record<string, number>): void {
  d.special = S.NONE;
  d.telegraphRadius = 0;
  d.telegraphLength = 0;
  d.telegraphSpread = 0;
  d.telegraphDist = 0;
}

// ───────────────────────────── Spécifications d'attaques ─────────────────────────────

function rootLanes(phase: number): readonly number[] {
  return phase >= 3 ? [-0.48, -0.24, 0, 0.24, 0.48] : [-0.28, 0, 0.28];
}

function fanLanes(phase: number): number[] {
  const n = phase >= 3 ? 7 : 5;
  const step = 0.24;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((i - (n - 1) / 2) * step);
  return out;
}

function spreadOf(lanes: readonly number[]): number {
  return lanes.length > 1 ? lanes[lanes.length - 1] - lanes[0] : 0;
}

function golemSpec(special: number, phase: number): AttackSpec {
  switch (special) {
    case S.SLAM:
      return {
        windupMs: phase >= 2 ? 850 : 900,
        activeMs: 250,
        recoverMs: phase >= 2 ? 1200 : 1400,
        trackFrac: 0,
        radius: GOLEM_SLAM_RADIUS,
        length: 0,
        spread: 0,
      };
    case S.RAGE:
      return { windupMs: 750, activeMs: 250, recoverMs: 1000, trackFrac: 0, radius: GOLEM_SLAM_RADIUS, length: 0, spread: 0 };
    case S.ROOTS:
      return {
        windupMs: phase >= 3 ? 700 : 800,
        activeMs: 700,
        recoverMs: phase >= 3 ? 900 : 1200,
        trackFrac: 0.6,
        radius: 0,
        length: ROOT_LENGTH,
        spread: spreadOf(rootLanes(phase)),
      };
    default:
      return { windupMs: 900, activeMs: 300, recoverMs: 1100, trackFrac: 0, radius: 40, length: 0, spread: 0 };
  }
}

function morvaneSpec(special: number, phase: number): AttackSpec {
  switch (special) {
    case S.RING:
      return { windupMs: 800, activeMs: 200, recoverMs: phase >= 3 ? 800 : 1000, trackFrac: 0, radius: 0, length: 0, spread: 0 };
    case S.SPIRAL:
      return { windupMs: 800, activeMs: 2400, recoverMs: 1300, trackFrac: 0.5, radius: 0, length: 0, spread: 0 };
    case S.CHARGE:
      return { windupMs: 900, activeMs: 450, recoverMs: 1200, trackFrac: 0.7, radius: 0, length: CHARGE_LENGTH, spread: 0 };
    case S.SUMMON:
      return { windupMs: 900, activeMs: 300, recoverMs: 1000, trackFrac: 0, radius: 40, length: 0, spread: 0 };
    default: {
      // FAN
      return {
        windupMs: 750,
        activeMs: 200,
        recoverMs: phase >= 3 ? 800 : 1000,
        trackFrac: 0.6,
        radius: 0,
        length: 130,
        spread: spreadOf(fanLanes(phase)),
      };
    }
  }
}

function specFor(enemy: EnemyState, special: number): AttackSpec {
  const phase = Math.min(3, Math.max(1, enemy.phase));
  return enemy.kind === 'morvane' ? morvaneSpec(special, phase) : golemSpec(special, phase);
}

// ───────────────────────────── Projectiles ─────────────────────────────

function shoot(
  ctx: EnemyAIContext,
  enemy: EnemyState,
  kind: 'shard' | 'orb',
  angle: number,
  speed: number,
  lifeMs: number,
  damage: number,
): void {
  const o = vecFromAngle(angle, ENEMIES[enemy.kind].radius * 0.8);
  ctx.spawnProjectile({
    kind,
    pos: { x: enemy.pos.x + o.x, y: enemy.pos.y + o.y },
    vel: vecFromAngle(angle, speed),
    damage,
    radius: 4,
    lifeMs,
    enemyId: enemy.id,
  });
}

function ring(
  ctx: EnemyAIContext,
  enemy: EnemyState,
  kind: 'shard' | 'orb',
  count: number,
  offset: number,
  speed: number,
  lifeMs: number,
  damage: number,
): void {
  for (let i = 0; i < count; i++) shoot(ctx, enemy, kind, offset + (i * Math.PI * 2) / count, speed, lifeMs, damage);
}

// ───────────────────────────── Invocations ─────────────────────────────

function minionKinds(enemy: EnemyState): readonly EnemyKind[] {
  return enemy.kind === 'morvane' ? ['skeleton', 'wisp'] : ['spider'];
}

function minionsAlive(enemy: EnemyState, ctx: EnemyAIContext): number {
  const kinds = minionKinds(enemy);
  let n = 0;
  for (const e of ctx.enemies) if (!e.dead && e.hp > 0 && kinds.includes(e.kind)) n++;
  return n;
}

function canSummon(enemy: EnemyState, ctx: EnemyAIContext): boolean {
  const limit = enemy.phase >= 3 ? 1 : MAX_BOSS_MINIONS - 2;
  return minionsAlive(enemy, ctx) <= limit;
}

function summon(enemy: EnemyState, ctx: EnemyAIContext): void {
  const d = enemy.data;
  const kind: EnemyKind =
    enemy.kind === 'morvane' ? (gd(d, 'summonToggle') % 2 === 0 ? 'skeleton' : 'wisp') : 'spider';
  d.summonToggle = gd(d, 'summonToggle') + 1;
  const want = Math.min(2, MAX_BOSS_MINIONS - minionsAlive(enemy, ctx));
  const mdef = ENEMIES[kind];
  const flying = kind === 'wisp';
  const base = ctx.random() * Math.PI * 2;
  for (let i = 0; i < want; i++) {
    const a0 = base + i * Math.PI;
    for (let t = 0; t < 6; t++) {
      const a = a0 + t * 0.5;
      const v = vecFromAngle(a, ENEMIES[enemy.kind].radius + 16);
      const pos = { x: enemy.pos.x + v.x, y: enemy.pos.y + v.y };
      if (ctx.canOccupy(pos, mdef.radius, flying)) {
        ctx.spawnEnemy(kind, pos);
        break;
      }
    }
  }
}

// ───────────────────────────── Déplacements ─────────────────────────────

function isFlyingBoss(enemy: EnemyState): boolean {
  return enemy.kind === 'morvane';
}

function moveBoss(enemy: EnemyState, ctx: EnemyAIContext, dx: number, dy: number): number {
  if (!(Math.abs(dx) + Math.abs(dy) > 1e-9)) return 0;
  const np = ctx.moveWithCollision(enemy.pos, { x: dx, y: dy }, ENEMIES[enemy.kind].radius, isFlyingBoss(enemy));
  if (!np || !Number.isFinite(np.x) || !Number.isFinite(np.y)) return 0;
  const moved = Math.hypot(np.x - enemy.pos.x, np.y - enemy.pos.y);
  enemy.pos.x = np.x;
  enemy.pos.y = np.y;
  return moved;
}

/** Marche vers la cible avec contournement simple d'un obstacle (détour perpendiculaire temporaire). */
function approach(
  enemy: EnemyState,
  ctx: EnemyAIContext,
  target: PlayerState,
  dt: number,
  speed: number,
  stopDist: number,
): void {
  const d = enemy.data;
  const dd = dist(enemy.pos, target.pos);
  let ang = angleBetween(enemy.pos, target.pos);
  faceAngle(enemy, ang);
  if (dd <= stopDist) {
    d.stuckMs = 0;
    return;
  }
  if (gd(d, 'detourMs') > 0) {
    d.detourMs = gd(d, 'detourMs') - dt;
    ang += (gd(d, 'detourSign') || 1) * 1.2;
  }
  const step = Math.min((speed * dt) / 1000, dd - stopDist);
  const moved = moveBoss(enemy, ctx, Math.cos(ang) * step, Math.sin(ang) * step);
  if (moved < step * 0.25) {
    d.stuckMs = gd(d, 'stuckMs') + dt;
    if (d.stuckMs > 500 && gd(d, 'detourMs') <= 0) {
      d.detourMs = 700;
      d.detourSign = ctx.random() < 0.5 ? -1 : 1;
      d.stuckMs = 0;
    }
  } else {
    d.stuckMs = Math.max(0, gd(d, 'stuckMs') - dt * 2);
  }
}

// ───────────────────────────── Machine à états commune ─────────────────────────────

function abortToIdle(enemy: EnemyState): void {
  const d = enemy.data;
  enemy.mode = 'idle';
  enemy.modeTimerMs = 0;
  clearTelegraph(d);
  d.comboLeft = 0;
  d.comboPending = 0;
  d.teleportNext = 0;
  d.chaseMs = 0;
}

function startWindup(enemy: EnemyState, target: PlayerState, special: number, combo: number): void {
  const d = enemy.data;
  const spec = specFor(enemy, special);
  const windup = Math.max(MIN_BOSS_WINDUP_MS, spec.windupMs);
  enemy.mode = 'windup';
  enemy.modeTimerMs = windup;
  d.windupTotalMs = windup;
  d.special = special;
  d.aimAngle = angleBetween(enemy.pos, target.pos);
  d.telegraphRadius = spec.radius;
  d.telegraphLength = spec.length;
  d.telegraphSpread = spec.spread;
  d.telegraphDist = 0;
  d.comboLeft = combo;
  d.chaseMs = 0;
  faceAngle(enemy, d.aimAngle);
}

function startAttack(enemy: EnemyState, ctx: EnemyAIContext): void {
  const d = enemy.data;
  const special = gd(d, 'special');
  const spec = specFor(enemy, special);
  enemy.mode = 'attack';
  enemy.modeTimerMs = spec.activeMs;
  d.activeTotalMs = spec.activeMs;
  d.emitMs = 0;
  d.emitCount = 0;
  const def = ENEMIES[enemy.kind];
  const aim = gd(d, 'aimAngle');
  const phase = Math.min(3, Math.max(1, enemy.phase));
  switch (special) {
    case S.SLAM:
    case S.RAGE: {
      ctx.damageCircle(enemy.pos, GOLEM_SLAM_RADIUS, def.damage, enemy.id);
      const second = special === S.RAGE && gd(d, 'strike') >= 1;
      const count = special === S.RAGE ? (second ? 20 : 14) : phase >= 2 ? 14 : 12;
      const offset = second ? Math.PI / count : 0;
      ring(ctx, enemy, 'shard', count, offset, phase >= 3 ? 105 : 95, 1400, def.damage * 0.5);
      break;
    }
    case S.SUMMON:
      summon(enemy, ctx);
      break;
    case S.FAN: {
      for (const off of fanLanes(phase)) shoot(ctx, enemy, 'orb', aim + off, phase >= 3 ? 95 : 85, 2600, def.damage * 0.55);
      break;
    }
    case S.RING: {
      const count = phase >= 3 ? 20 : 16;
      const toggle = gd(d, 'ringToggle') % 2;
      d.ringToggle = gd(d, 'ringToggle') + 1;
      ring(ctx, enemy, 'orb', count, toggle === 1 ? Math.PI / count : 0, 70, 3200, def.damage * 0.5);
      break;
    }
    case S.SPIRAL:
      d.spiralStart = aim;
      d.spiralDir = gd(d, 'spiralToggle') % 2 === 0 ? 1 : -1;
      d.spiralToggle = gd(d, 'spiralToggle') + 1;
      break;
    default:
      break;
  }
}

/** Émissions continues / mouvements pendant le mode 'attack' (racines, spirale, charge). */
function stepAttack(enemy: EnemyState, ctx: EnemyAIContext, dt: number): void {
  const d = enemy.data;
  const special = gd(d, 'special');
  const def = ENEMIES[enemy.kind];
  const aim = gd(d, 'aimAngle');
  const phase = Math.min(3, Math.max(1, enemy.phase));
  if (special === S.ROOTS) {
    d.emitMs = gd(d, 'emitMs') - dt;
    for (let guard = 0; guard < 3 && d.emitMs <= 0 && gd(d, 'emitCount') < 7; guard++) {
      for (const off of rootLanes(phase)) shoot(ctx, enemy, 'shard', aim + off, 130, 1000, def.damage * 0.45);
      d.emitCount = gd(d, 'emitCount') + 1;
      d.emitMs += 100;
    }
  } else if (special === S.SPIRAL) {
    d.emitMs = gd(d, 'emitMs') - dt;
    for (let guard = 0; guard < 3 && d.emitMs <= 0 && gd(d, 'emitCount') < 26; guard++) {
      const a = gd(d, 'spiralStart') + gd(d, 'spiralDir') * gd(d, 'emitCount') * 0.42;
      shoot(ctx, enemy, 'orb', a, 75, 2800, def.damage * 0.45);
      shoot(ctx, enemy, 'orb', a + Math.PI, 75, 2800, def.damage * 0.45);
      d.emitCount = gd(d, 'emitCount') + 1;
      d.emitMs += 90;
    }
  } else if (special === S.CHARGE) {
    const step = (CHARGE_SPEED * dt) / 1000;
    moveBoss(enemy, ctx, Math.cos(aim) * step, Math.sin(aim) * step);
    ctx.damageCircle(enemy.pos, def.radius + 4, def.damage, enemy.id);
  }
}

function finishAttack(enemy: EnemyState, ctx: EnemyAIContext): void {
  const d = enemy.data;
  const special = gd(d, 'special');
  const spec = specFor(enemy, special);
  clearTelegraph(d);
  enemy.mode = 'recover';
  if (gd(d, 'comboLeft') > 0) {
    d.comboLeft = gd(d, 'comboLeft') - 1;
    d.comboPending = 1;
    d.comboSpecial = special;
    d.strike = gd(d, 'strike') + 1;
    enemy.modeTimerMs = COMBO_GAP_MS;
  } else {
    d.comboPending = 0;
    d.strike = 0;
    d.teleportNext = enemy.kind === 'morvane' ? 1 : 0;
    enemy.modeTimerMs = spec.recoverMs * easeFactor(ctx);
    enemy.attackCooldownMs = Math.max(enemy.attackCooldownMs, 300);
  }
}

// ───────────────────────────── Choix de l'attaque ─────────────────────────────

interface Pick {
  special: number;
  combo: number;
  nextSeq: number;
}

function pickAttack(enemy: EnemyState, ctx: EnemyAIContext): Pick {
  const table = enemy.kind === 'morvane' ? MORVANE_SEQ : GOLEM_SEQ;
  const seq = table[Math.min(3, Math.max(1, enemy.phase))] ?? table[1];
  const start = Math.max(0, Math.floor(gd(enemy.data, 'seq')));
  for (let i = 0; i < seq.length; i++) {
    const idx = (start + i) % seq.length;
    const [special, combo] = seq[idx];
    if (special === S.SUMMON && !canSummon(enemy, ctx)) continue;
    return { special, combo, nextSeq: idx + 1 };
  }
  // Toutes les entrées étaient des invocations impossibles : repli sur la première attaque non-invocation.
  const fallback = seq.find((e) => e[0] !== S.SUMMON) ?? seq[0];
  return { special: fallback[0], combo: fallback[1], nextSeq: start + 1 };
}

// ───────────────────────────── Téléportation (Morvane) ─────────────────────────────

function pickArenaPoint(
  enemy: EnemyState,
  ctx: EnemyAIContext,
  target: PlayerState,
): { x: number; y: number } | null {
  const r = ENEMIES[enemy.kind].radius;
  const margin = r + 12;
  const w = ctx.roomBounds.width;
  const h = ctx.roomBounds.height;
  if (!(w > margin * 2) || !(h > margin * 2)) return null;
  let best: { x: number; y: number } | null = null;
  let bestScore = Infinity;
  for (let i = 0; i < 14; i++) {
    const p = { x: margin + ctx.random() * (w - margin * 2), y: margin + ctx.random() * (h - margin * 2) };
    if (!ctx.canOccupy(p, r, true)) continue;
    let ok = true;
    for (const pl of ctx.players) {
      if (pl.status === 'alive' && dist(p, pl.pos) < 56) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const score = Math.abs(dist(p, target.pos) - 110) + (dist(p, enemy.pos) < 30 ? 80 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

function startTeleport(enemy: EnemyState, ctx: EnemyAIContext, target: PlayerState): void {
  const d = enemy.data;
  clearTelegraph(d);
  enemy.mode = 'teleport';
  enemy.modeTimerMs = MORVANE_TELEPORT_MS;
  d.special = S.TELEPORT;
  d.teleportTotalMs = MORVANE_TELEPORT_MS;
  d.teleportMoved = 0;
  d.teleportNext = 0;
  d.crowdMs = 0;
  const dest = pickArenaPoint(enemy, ctx, target);
  d.teleportToX = dest ? dest.x : enemy.pos.x;
  d.teleportToY = dest ? dest.y : enemy.pos.y;
}

function stepTeleport(enemy: EnemyState, ctx: EnemyAIContext, target: PlayerState, dt: number): void {
  const d = enemy.data;
  enemy.modeTimerMs -= dt;
  const total = gd(d, 'teleportTotalMs') || MORVANE_TELEPORT_MS;
  if (!gd(d, 'teleportMoved') && enemy.modeTimerMs <= total / 2) {
    let x = gd(d, 'teleportToX');
    let y = gd(d, 'teleportToY');
    const r = ENEMIES[enemy.kind].radius;
    let valid = ctx.canOccupy({ x, y }, r, true);
    for (const pl of ctx.players) {
      if (valid && pl.status === 'alive' && dist({ x, y }, pl.pos) < 40) valid = false;
    }
    if (!valid) {
      const alt = pickArenaPoint(enemy, ctx, target);
      if (alt) {
        x = alt.x;
        y = alt.y;
        valid = true;
      }
    }
    if (valid) {
      enemy.pos.x = x;
      enemy.pos.y = y;
    }
    d.teleportMoved = 1;
  }
  if (enemy.modeTimerMs <= 0) {
    clearTelegraph(d);
    enemy.mode = 'chase';
    enemy.modeTimerMs = 0;
    enemy.attackCooldownMs = Math.max(enemy.attackCooldownMs, 450);
  }
}

// ───────────────────────────── Mouvement « chase » spécifique ─────────────────────────────

function morvaneHover(enemy: EnemyState, ctx: EnemyAIContext, target: PlayerState, dt: number): void {
  const d = enemy.data;
  const def = ENEMIES[enemy.kind];
  const mult = enemy.phase >= 3 ? 1.25 : enemy.phase === 2 ? 1.1 : 1;
  const speed = def.speed * mult;
  const dd = dist(enemy.pos, target.pos);
  const ang = angleBetween(enemy.pos, target.pos);
  faceAngle(enemy, ang);
  d.strafeMs = gd(d, 'strafeMs') - dt;
  if (d.strafeMs <= 0) {
    d.strafeSign = ctx.random() < 0.5 ? -1 : 1;
    d.strafeMs = 1800 + ctx.random() * 1800;
  }
  const sign = gd(d, 'strafeSign') || 1;
  let moveAng = ang;
  let spd = speed;
  if (dd > 125) {
    moveAng = ang;
  } else if (dd < 70) {
    moveAng = ang + Math.PI;
  } else {
    moveAng = ang + (sign * Math.PI) / 2;
    spd = speed * 0.6;
  }
  const step = (spd * dt) / 1000;
  const moved = moveBoss(enemy, ctx, Math.cos(moveAng) * step, Math.sin(moveAng) * step);
  if (moved < step * 0.3) d.strafeMs = 0; // bloqué : on change de sens au prochain pas
  // Trop collé au joueur trop longtemps : se téléporte ailleurs.
  d.crowdMs = dd < 40 ? gd(d, 'crowdMs') + dt : 0;
}

// ───────────────────────────── Point d'entrée ─────────────────────────────

function changePhase(enemy: EnemyState, ctx: EnemyAIContext, phase: number): void {
  const d = enemy.data;
  const first = enemy.phase === 0;
  enemy.phase = phase;
  ctx.emit({ type: 'bossPhase', enemyId: enemy.id, kind: enemy.kind, phase });
  d.seq = 0;
  d.strike = 0;
  d.comboLeft = 0;
  d.comboPending = 0;
  d.teleportNext = 0;
  clearTelegraph(d);
  if (first) {
    enemy.mode = 'chase';
    enemy.modeTimerMs = 0;
    enemy.attackCooldownMs = Math.max(enemy.attackCooldownMs, FIRST_ENGAGE_DELAY_MS);
  } else {
    enemy.mode = 'recover';
    enemy.modeTimerMs = PHASE_ROAR_MS;
    d.special = S.ROAR;
    d.windupTotalMs = PHASE_ROAR_MS;
    enemy.attackCooldownMs = Math.max(enemy.attackCooldownMs, 500);
  }
}

/**
 * Un pas d'IA de boss. Appelé par `updateEnemy` (ai.ts) après la préparation commune (timers, cible).
 * Muté : `enemy` (pos, mode, phase, data, cooldown…) ; effets : `ctx.spawnProjectile`, `ctx.spawnEnemy`,
 * `ctx.damageCircle`, `ctx.emit`.
 * @param enemy boss ('golem' ou 'morvane')
 * @param ctx contexte de la simulation
 * @param target joueur vivant le plus proche, ou null s'il n'y en a aucun (le boss repasse en 'idle')
 * @param dt pas de temps assaini (ms, > 0)
 */
export function updateBoss(enemy: EnemyState, ctx: EnemyAIContext, target: PlayerState | null, dt: number): void {
  const d = enemy.data;
  if (!target) {
    if (enemy.mode !== 'idle') abortToIdle(enemy);
    return;
  }
  d.engaged = 1;
  const phase = bossPhaseFor(enemy.kind, enemy.hp, enemy.maxHp);
  if (phase > enemy.phase) changePhase(enemy, ctx, phase);
  const def = ENEMIES[enemy.kind];

  switch (enemy.mode) {
    case 'windup': {
      enemy.modeTimerMs -= dt;
      const total = gd(d, 'windupTotalMs') || MIN_BOSS_WINDUP_MS;
      const spec = specFor(enemy, gd(d, 'special'));
      if (spec.trackFrac > 0 && enemy.modeTimerMs > total * (1 - spec.trackFrac)) {
        d.aimAngle = angleBetween(enemy.pos, target.pos);
      }
      faceAngle(enemy, gd(d, 'aimAngle'));
      if (enemy.modeTimerMs <= 0) startAttack(enemy, ctx);
      return;
    }
    case 'attack': {
      stepAttack(enemy, ctx, dt);
      enemy.modeTimerMs -= dt;
      if (enemy.modeTimerMs <= 0) finishAttack(enemy, ctx);
      return;
    }
    case 'recover': {
      enemy.modeTimerMs -= dt;
      if (enemy.modeTimerMs > 0) return;
      enemy.modeTimerMs = 0;
      if (gd(d, 'comboPending') > 0) {
        d.comboPending = 0;
        startWindup(enemy, target, gd(d, 'comboSpecial'), gd(d, 'comboLeft'));
      } else if (enemy.kind === 'morvane' && gd(d, 'teleportNext') > 0) {
        startTeleport(enemy, ctx, target);
      } else {
        clearTelegraph(d);
        enemy.mode = 'chase';
      }
      return;
    }
    case 'teleport':
      if (enemy.kind === 'morvane') {
        stepTeleport(enemy, ctx, target, dt);
        return;
      }
      enemy.mode = 'chase';
      return;
    default:
      break;
  }

  // 'idle' / 'chase' / valeur inattendue : on (re)devient 'chase'.
  if (enemy.mode !== 'chase') {
    enemy.mode = 'chase';
    enemy.attackCooldownMs = Math.max(enemy.attackCooldownMs, 600);
  }

  if (enemy.kind === 'golem') {
    const mult = enemy.phase >= 3 ? 1.5 : enemy.phase === 2 ? 1.15 : 1;
    const dd = dist(enemy.pos, target.pos);
    d.chaseMs = gd(d, 'chaseMs') + dt;
    approach(enemy, ctx, target, dt, def.speed * mult, def.radius + PLAYER_RADIUS + 16);
    if (enemy.attackCooldownMs <= 0) {
      const pick = pickAttack(enemy, ctx);
      if (pick.special === S.SUMMON || dd <= GOLEM_APPROACH_DIST || gd(d, 'chaseMs') >= GOLEM_FORCE_ATTACK_MS) {
        d.seq = pick.nextSeq;
        d.strike = 0;
        startWindup(enemy, target, pick.special, pick.combo);
      }
    }
    return;
  }

  // Morvane : lévite, attaque dès que le délai est écoulé, se téléporte si on la colle trop longtemps.
  morvaneHover(enemy, ctx, target, dt);
  if (gd(d, 'crowdMs') > 1500 && enemy.attackCooldownMs > 0) {
    startTeleport(enemy, ctx, target);
    return;
  }
  if (enemy.attackCooldownMs <= 0) {
    const pick = pickAttack(enemy, ctx);
    d.seq = pick.nextSeq;
    d.strike = 0;
    startWindup(enemy, target, pick.special, pick.combo);
  }
}
