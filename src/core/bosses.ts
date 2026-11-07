/**
 * IA des boss et demi-boss — logique pure (aucune dépendance à Phaser/DOM/Math.random/Date.now).
 *
 * Appelé par `updateEnemy` (ai.ts) pour les IA 'boss-golem' (Gorgrim), 'boss-morvane', et celles des niveaux 4-6 :
 * 'miniboss-warden', 'boss-frostqueen', 'miniboss-pyromancer', 'boss-forgelord', 'miniboss-wraith', 'boss-voidlord'.
 * N'accède qu'à `enemy` et au contexte `EnemyAIContext` ; le temps vient de `dtMs`, le hasard de `ctx.random()`.
 * Les données propres à chaque type (spécifications d'attaques, séquences par phase, profil de déplacement,
 * invocations, téléportation) sont dans `bossData.ts` ; ce fichier est le moteur commun.
 *
 * ── Principes d'équité (1 à 4 joueurs) ──────────────────────────────────────────────────────────────────
 *  - TOUTE attaque commence par un mode 'windup' (télégraphe) d'au moins 600 ms (`MIN_BOSS_WINDUP_MS`) ;
 *    jamais de dégât sans avertissement. Les enchaînements (combos) re-télégraphent chaque coup.
 *  - Les boss ne ciblent QUE des joueurs vivants ; sans joueur vivant ils reviennent en 'idle' et annulent l'attaque.
 *  - Les invocations sont plafonnées PAR BOSS (`BossProfile.minions.cap`, 4 pour Gorgrim/Morvane/reine du givre, 3 pour
 *    le seigneur du Néant, 2 pour le pyromancien et le seigneur de la forge) : seuls les sbires invoqués par CE boss
 *    (`data.summoner` = id du boss) comptent.
 *  - Plus il y a peu de joueurs vivants, plus les fenêtres de récupération sont longues (×1.2 à 1 joueur, ×1.1 à 2).
 *  - Changement de phase : rugissement de 1 s (mode 'recover', special ROAR) sans attaque.
 *  - La difficulté (1-3) n'est JAMAIS lue ici : seuls les PV et dégâts changent (combat.ts / balance.ts).
 *
 * ── Phases (dérivées de hp/maxHp, monotones, `enemy.phase` : 0 = pas encore engagé, puis 1..N) ──────────
 *  Gorgrim  : 3 phases, seuils 66 % / 33 %.        Morvane    : 3 phases, 70 % / 35 %.
 *  Gardien de givre, pyromancien, spectre (demi-boss) : 2 phases, rage à 50 %.
 *  Reine du givre : 3 phases, 70 % / 40 %.          Seigneur de la forge : 3 phases, 70 % / 35 % (3e = enrage).
 *  Seigneur du Néant : 4 phases, 75 % / 50 % / 25 %.
 *  `{type:'bossPhase'}` est émis à l'engagement (0 → 1) puis à chaque changement de phase.
 *
 * ── Machine à états (enemy.mode) ─────────────────────────────────────────────────────────────────────────
 *  'idle' (pas de cible) · 'chase' (marche/lévitation + choix d'attaque) · 'windup' (télégraphe) · 'attack'
 *  (exécution : projectiles / zone / charge) · 'recover' (fenêtre de vulnérabilité, ou rugissement) ·
 *  'teleport' (boss téléporteurs). Jamais 'stunned' (les boss ne sont ni repoussés ni étourdis).
 *
 * ── Clés `data` écrites pour le rendu (voir aussi ai.ts) ─────────────────────────────────────────────────
 *  special (ENEMY_SPECIALS), aimAngle (rad), windupTotalMs, telegraphRadius (px), telegraphLength (px),
 *  telegraphSpread (rad, éventail total), telegraphDist (px), activeTotalMs, teleportTotalMs, teleportToX/Y,
 *  teleportMoved, engaged.
 *  Seigneur du Néant (special = VOIDZONE) : zoneCount (1..3), zoneX0/Y0 … zoneX2/Y2 (centres des zones de danger, px),
 *  zoneRadius (px). Pendant le télégraphe les zones suivent les joueurs puis se verrouillent ; pendant 'attack' elles
 *  restent dangereuses. `telegraphRadius`/`telegraphDist`/`aimAngle` décrivent la première zone (rendu minimal possible).
 *  Invoqués : `data.summoner` = id du boss invocateur.
 */
import { PLAYER_RADIUS } from './constants';
import { ENEMIES, isFlyingKind } from './enemies';
import { angleBetween, angleDiff, clamp, dirFromVec, dist, vecFromAngle } from './geometry';
import {
  BOSS_PROFILES,
  ENEMY_SPECIALS,
  GOLEM_SLAM_RADIUS,
  MAX_BOSS_MINIONS,
  fanLanesFor,
  type AttackSpec,
  type BossProfile,
  type BossProjectile,
  type SeqEntry,
} from './bossData';
import type { EnemyAIContext, EnemyKind, EnemyState, PlayerState, Vec2 } from './types';

export { ENEMY_SPECIALS, GOLEM_SLAM_RADIUS, MAX_BOSS_MINIONS };

// ───────────────────────────── Constantes publiques ─────────────────────────────

/** Durée minimale (ms) du télégraphe d'une attaque de boss. */
export const MIN_BOSS_WINDUP_MS = 600;
/** Durée (ms) du rugissement de changement de phase. */
export const PHASE_ROAR_MS = 1000;
/** Durée totale (ms) d'une téléportation de Morvane (disparition + réapparition). */
export const MORVANE_TELEPORT_MS = 700;

// ───────────────────────────── Constantes internes ─────────────────────────────

const S = ENEMY_SPECIALS;
const FIRST_ENGAGE_DELAY_MS = 1200;
const COMBO_GAP_MS = 280;
const CHARGE_SPEED = 300;
const ROOT_SALVOS = 7;
const PANIC_CROWD_MS = 700;
const CROWD_TELEPORT_MS = 1500;
const VOID_ZONE_MAX = 3;

/** Profil de repli (type inconnu) : celui de Gorgrim. */
const FALLBACK_PROFILE = BOSS_PROFILES.golem as BossProfile;

function profileOf(kind: EnemyKind): BossProfile {
  return BOSS_PROFILES[kind] ?? FALLBACK_PROFILE;
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

/** Phase courante bornée à [1, nombre de phases du profil]. */
function clampPhase(enemy: EnemyState, profile: BossProfile): number {
  return Math.min(profile.thresholds.length + 1, Math.max(1, enemy.phase));
}

/**
 * Phase de boss dérivée des PV : 1..N (jamais 0), N = nombre de phases du type (2 à 4). À exactement le seuil, la phase
 * supérieure est atteinte. Seuils : voir `bossData.ts` (golem 66/33 %, morvane 70/35 %, demi-boss 50 %, reine du givre 70/40 %,
 * seigneur de la forge 70/35 %, seigneur du Néant 75/50/25 %). Un type sans profil est traité comme Gorgrim.
 * @param kind type de boss / demi-boss
 * @param hp PV courants
 * @param maxHp PV max
 */
export function bossPhaseFor(kind: EnemyKind, hp: number, maxHp: number): number {
  const ratio = maxHp > 0 && Number.isFinite(hp) ? hp / maxHp : 1;
  let phase = 1;
  for (const t of profileOf(kind).thresholds) if (!(ratio > t)) phase++;
  return phase;
}

function clearTelegraph(d: Record<string, number>): void {
  d.special = S.NONE;
  d.telegraphRadius = 0;
  d.telegraphLength = 0;
  d.telegraphSpread = 0;
  d.telegraphDist = 0;
  d.zoneCount = 0;
}

function specFor(enemy: EnemyState, special: number): AttackSpec {
  const profile = profileOf(enemy.kind);
  return profile.spec(special, clampPhase(enemy, profile), Math.max(0, Math.floor(gd(enemy.data, 'strike'))));
}

function lanesOf(spec: AttackSpec): number[] {
  const n = Math.max(1, Math.floor(spec.count ?? 1));
  return n > 1 ? fanLanesFor(n, spec.spread / (n - 1)) : [0];
}

function offsetPoint(p: Vec2, angle: number, len: number): Vec2 {
  return { x: p.x + Math.cos(angle) * len, y: p.y + Math.sin(angle) * len };
}

// ───────────────────────────── Projectiles ─────────────────────────────

function shootFrom(
  ctx: EnemyAIContext,
  enemy: EnemyState,
  origin: Vec2,
  kind: BossProjectile,
  angle: number,
  speed: number,
  lifeMs: number,
  damage: number,
): void {
  ctx.spawnProjectile({
    kind,
    pos: { x: origin.x, y: origin.y },
    vel: vecFromAngle(angle, speed),
    damage,
    radius: 4,
    lifeMs,
    enemyId: enemy.id,
  });
}

function shoot(
  ctx: EnemyAIContext,
  enemy: EnemyState,
  kind: BossProjectile,
  angle: number,
  speed: number,
  lifeMs: number,
  damage: number,
): void {
  shootFrom(ctx, enemy, offsetPoint(enemy.pos, angle, ENEMIES[enemy.kind].radius * 0.8), kind, angle, speed, lifeMs, damage);
}

/** Anneau de `count` projectiles. `gap` > 0 : on retire les voies à moins de `gap` rad de la visée et de son opposé. */
function ring(
  ctx: EnemyAIContext,
  enemy: EnemyState,
  kind: BossProjectile,
  count: number,
  offset: number,
  speed: number,
  lifeMs: number,
  damage: number,
  aim = 0,
  gap = 0,
): void {
  for (let i = 0; i < count; i++) {
    const a = offset + (i * Math.PI * 2) / count;
    if (gap > 0 && (angleDiff(a, aim) < gap || angleDiff(a, aim + Math.PI) < gap)) continue;
    shoot(ctx, enemy, kind, a, speed, lifeMs, damage);
  }
}

/** Anneau de projectiles partant d'un point quelconque (onde de choc du marteau). */
function ringAt(
  ctx: EnemyAIContext,
  enemy: EnemyState,
  origin: Vec2,
  kind: BossProjectile,
  count: number,
  speed: number,
  lifeMs: number,
  damage: number,
): void {
  for (let i = 0; i < count; i++) shootFrom(ctx, enemy, origin, kind, (i * Math.PI * 2) / count, speed, lifeMs, damage);
}

// ───────────────────────────── Invocations ─────────────────────────────

/** Sbires vivants invoqués par CE boss (marqués `data.summoner`). */
function minionsAlive(enemy: EnemyState, ctx: EnemyAIContext): number {
  let n = 0;
  for (const e of ctx.enemies) if (!e.dead && e.hp > 0 && e.data.summoner === enemy.id) n++;
  return n;
}

function canSummon(enemy: EnemyState, ctx: EnemyAIContext, profile: BossProfile): boolean {
  const m = profile.minions;
  if (!m) return false;
  const alive = minionsAlive(enemy, ctx);
  return alive <= m.gate(clampPhase(enemy, profile)) && alive < m.cap;
}

function summon(enemy: EnemyState, ctx: EnemyAIContext, profile: BossProfile): void {
  const m = profile.minions;
  if (!m) return;
  const d = enemy.data;
  const kind = m.kinds[gd(d, 'summonToggle') % m.kinds.length];
  d.summonToggle = gd(d, 'summonToggle') + 1;
  const want = Math.min(m.perCast, m.cap - minionsAlive(enemy, ctx));
  const mdef = ENEMIES[kind];
  const flying = isFlyingKind(kind);
  const base = ctx.random() * Math.PI * 2;
  for (let i = 0; i < want; i++) {
    const a0 = base + i * Math.PI;
    for (let t = 0; t < 6; t++) {
      const a = a0 + t * 0.5;
      const v = vecFromAngle(a, ENEMIES[enemy.kind].radius + 16);
      const pos = { x: enemy.pos.x + v.x, y: enemy.pos.y + v.y };
      if (ctx.canOccupy(pos, mdef.radius, flying)) {
        const id = ctx.spawnEnemy(kind, pos);
        if (id >= 0) {
          const minion = ctx.enemies.find((e) => e.id === id);
          if (minion) minion.data.summoner = enemy.id;
        }
        break;
      }
    }
  }
}

// ───────────────────────────── Déplacements ─────────────────────────────

function moveBoss(enemy: EnemyState, ctx: EnemyAIContext, dx: number, dy: number): number {
  if (!(Math.abs(dx) + Math.abs(dy) > 1e-9)) return 0;
  const np = ctx.moveWithCollision(enemy.pos, { x: dx, y: dy }, ENEMIES[enemy.kind].radius, profileOf(enemy.kind).flying);
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

function speedMult(enemy: EnemyState, profile: BossProfile): number {
  const m = profile.speedMults;
  return m[Math.min(m.length, clampPhase(enemy, profile)) - 1] ?? 1;
}

// ───────────────────────────── Zones de danger (seigneur du Néant) ─────────────────────────────

/**
 * Pose les cercles de la zone de danger : un par joueur vivant le plus proche (jusqu'à `spec.count`), les cercles
 * restants (peu de joueurs vivants) sont décalés autour du joueur le plus proche. Écrit zoneCount, zoneX0..2, zoneY0..2, zoneRadius
 * et la zone annoncée principale (telegraphRadius/telegraphDist/aimAngle).
 */
function placeZones(enemy: EnemyState, ctx: EnemyAIContext, spec: AttackSpec): void {
  const d = enemy.data;
  const alive = ctx.players
    .filter((p) => p.status === 'alive')
    .map((p) => ({ p, dd: dist(enemy.pos, p.pos) }))
    .sort((a, b) => a.dd - b.dd || a.p.id - b.p.id);
  if (alive.length === 0) return;
  const n = Math.min(VOID_ZONE_MAX, Math.max(1, Math.floor(spec.count ?? 2)));
  const w = ctx.roomBounds.width;
  const h = ctx.roomBounds.height;
  const margin = spec.radius * 0.5;
  const base = alive[0].p.pos;
  const toBase = angleBetween(enemy.pos, base);
  for (let i = 0; i < n; i++) {
    const p = i < alive.length ? alive[i].p.pos : offsetPoint(base, toBase + (i % 2 === 0 ? 1.1 : -1.1), 44);
    d[`zoneX${i}`] = clamp(p.x, margin, Math.max(margin, w - margin));
    d[`zoneY${i}`] = clamp(p.y, margin, Math.max(margin, h - margin));
  }
  d.zoneCount = n;
  d.zoneRadius = spec.radius;
  const z0 = { x: gd(d, 'zoneX0'), y: gd(d, 'zoneY0') };
  d.aimAngle = angleBetween(enemy.pos, z0);
  d.telegraphRadius = spec.radius;
  d.telegraphDist = dist(enemy.pos, z0);
}

function zoneDamage(enemy: EnemyState, ctx: EnemyAIContext, mult: number): void {
  const d = enemy.data;
  const def = ENEMIES[enemy.kind];
  const n = Math.min(VOID_ZONE_MAX, Math.floor(gd(d, 'zoneCount')));
  for (let i = 0; i < n; i++) {
    ctx.damageCircle({ x: gd(d, `zoneX${i}`), y: gd(d, `zoneY${i}`) }, gd(d, 'zoneRadius'), def.damage * mult, enemy.id);
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

function startWindup(enemy: EnemyState, ctx: EnemyAIContext, target: PlayerState, special: number, combo: number): void {
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
  d.telegraphDist = spec.dist ?? 0;
  d.zoneCount = 0;
  d.comboLeft = combo;
  d.chaseMs = 0;
  if (special === S.VOIDZONE) placeZones(enemy, ctx, spec);
  faceAngle(enemy, d.aimAngle);
}

function startAttack(enemy: EnemyState, ctx: EnemyAIContext, profile: BossProfile): void {
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
  const direct = def.damage * (spec.dmg ?? 1);
  const pDmg = def.damage * (spec.projDmg ?? 0.5);
  const proj = spec.proj ?? 'orb';
  switch (special) {
    case S.SLAM:
    case S.RAGE: {
      ctx.damageCircle(offsetPoint(enemy.pos, aim, spec.dist ?? 0), spec.radius, direct, enemy.id);
      const count = spec.count ?? 0;
      if (count > 0) {
        const second = special === S.RAGE && gd(d, 'strike') >= 1;
        ring(ctx, enemy, proj, count, second ? Math.PI / count : 0, spec.projSpeed ?? 95, spec.projLife ?? 1400, pDmg);
      }
      break;
    }
    case S.HEAVY:
      ctx.damageCircle(offsetPoint(enemy.pos, aim, spec.dist ?? 0), spec.radius, direct, enemy.id);
      break;
    case S.SHOCKWAVE: {
      const impact = offsetPoint(enemy.pos, aim, spec.dist ?? 0);
      ctx.damageCircle(impact, spec.radius, direct, enemy.id);
      ringAt(ctx, enemy, impact, proj, spec.count ?? 14, spec.projSpeed ?? 100, spec.projLife ?? 900, pDmg);
      break;
    }
    case S.NOVA:
      ctx.damageCircle(enemy.pos, spec.radius, direct, enemy.id);
      ring(ctx, enemy, proj, spec.count ?? 12, 0, spec.projSpeed ?? 60, spec.projLife ?? 2400, pDmg);
      break;
    case S.SUMMON:
      summon(enemy, ctx, profile);
      break;
    case S.FIREBALL:
      // Rafale (interval défini) : émise pas à pas par stepAttack ; sinon éventail instantané.
      if (spec.interval === undefined) {
        for (const off of lanesOf(spec)) shoot(ctx, enemy, proj, aim + off, spec.projSpeed ?? 100, spec.projLife ?? 2200, pDmg);
      }
      break;
    case S.FAN:
    case S.DARKBOLT:
      for (const off of lanesOf(spec)) shoot(ctx, enemy, proj, aim + off, spec.projSpeed ?? 85, spec.projLife ?? 2600, pDmg);
      break;
    case S.RING:
    case S.BLIZZARD: {
      const count = spec.count ?? 16;
      const toggle = gd(d, 'ringToggle') % 2;
      d.ringToggle = gd(d, 'ringToggle') + 1;
      ring(ctx, enemy, proj, count, toggle === 1 ? Math.PI / count : 0, spec.projSpeed ?? 70, spec.projLife ?? 3200, pDmg, aim, spec.gap ?? 0);
      break;
    }
    case S.SPIRAL:
      d.spiralStart = aim;
      d.spiralDir = gd(d, 'spiralToggle') % 2 === 0 ? 1 : -1;
      d.spiralToggle = gd(d, 'spiralToggle') + 1;
      break;
    case S.VOIDZONE:
      zoneDamage(enemy, ctx, direct / def.damage);
      d.emitMs = spec.interval ?? 350;
      break;
    default:
      break;
  }
}

/** Émissions continues / mouvements pendant le mode 'attack' (racines, spirale, rafale, charge, glissade, zones). */
function stepAttack(enemy: EnemyState, ctx: EnemyAIContext, dt: number): void {
  const d = enemy.data;
  const special = gd(d, 'special');
  const def = ENEMIES[enemy.kind];
  const spec = specFor(enemy, special);
  const aim = gd(d, 'aimAngle');
  const proj = spec.proj ?? 'orb';
  const pDmg = def.damage * (spec.projDmg ?? 0.5);
  if (special === S.ROOTS) {
    d.emitMs = gd(d, 'emitMs') - dt;
    for (let guard = 0; guard < 3 && d.emitMs <= 0 && gd(d, 'emitCount') < ROOT_SALVOS; guard++) {
      for (const off of lanesOf(spec)) shoot(ctx, enemy, proj, aim + off, spec.projSpeed ?? 130, spec.projLife ?? 1000, pDmg);
      d.emitCount = gd(d, 'emitCount') + 1;
      d.emitMs += spec.interval ?? 100;
    }
  } else if (special === S.SPIRAL) {
    const interval = spec.interval ?? 90;
    const arms = Math.max(1, Math.floor(spec.arms ?? 2));
    d.emitMs = gd(d, 'emitMs') - dt;
    for (let guard = 0; guard < 3 && d.emitMs <= 0 && gd(d, 'emitCount') < (spec.count ?? 26); guard++) {
      const a = gd(d, 'spiralStart') + gd(d, 'spiralDir') * gd(d, 'emitCount') * (spec.step ?? 0.42);
      for (let k = 0; k < arms; k++) {
        shoot(ctx, enemy, proj, a + (k * Math.PI * 2) / arms, spec.projSpeed ?? 75, spec.projLife ?? 2800, pDmg);
      }
      d.emitCount = gd(d, 'emitCount') + 1;
      d.emitMs += interval;
    }
  } else if (special === S.FIREBALL && spec.interval !== undefined) {
    d.emitMs = gd(d, 'emitMs') - dt;
    for (let guard = 0; guard < 3 && d.emitMs <= 0 && gd(d, 'emitCount') < (spec.count ?? 6); guard++) {
      const sweep = Math.sin(gd(d, 'emitCount') * 0.9) * (spec.spread / 2);
      shoot(ctx, enemy, proj, aim + sweep, spec.projSpeed ?? 105, spec.projLife ?? 2400, pDmg);
      d.emitCount = gd(d, 'emitCount') + 1;
      d.emitMs += spec.interval;
    }
  } else if (special === S.CHARGE || special === S.SLIDE) {
    const step = ((spec.speed ?? CHARGE_SPEED) * dt) / 1000;
    moveBoss(enemy, ctx, Math.cos(aim) * step, Math.sin(aim) * step);
    ctx.damageCircle(enemy.pos, def.radius + 4, def.damage * (spec.dmg ?? 1), enemy.id);
    if (special === S.SLIDE) {
      d.emitMs = gd(d, 'emitMs') - dt;
      for (let guard = 0; guard < 2 && d.emitMs <= 0; guard++) {
        shoot(ctx, enemy, proj, aim + Math.PI / 2, spec.projSpeed ?? 60, spec.projLife ?? 900, pDmg);
        shoot(ctx, enemy, proj, aim - Math.PI / 2, spec.projSpeed ?? 60, spec.projLife ?? 900, pDmg);
        d.emitMs += spec.interval ?? 140;
      }
    }
  } else if (special === S.VOIDZONE) {
    d.emitMs = gd(d, 'emitMs') - dt;
    for (let guard = 0; guard < 2 && d.emitMs <= 0; guard++) {
      zoneDamage(enemy, ctx, 0.5);
      d.emitMs += spec.interval ?? 350;
    }
  }
}

function finishAttack(enemy: EnemyState, ctx: EnemyAIContext, profile: BossProfile): void {
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
    d.teleportNext = profile.teleportAfter?.(clampPhase(enemy, profile), special) ? 1 : 0;
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

function pickAttack(enemy: EnemyState, ctx: EnemyAIContext, profile: BossProfile): Pick {
  const seq: readonly SeqEntry[] = profile.seq[clampPhase(enemy, profile)] ?? profile.seq[1];
  const start = Math.max(0, Math.floor(gd(enemy.data, 'seq')));
  for (let i = 0; i < seq.length; i++) {
    const idx = (start + i) % seq.length;
    const [special, combo] = seq[idx];
    if (special === S.SUMMON && !canSummon(enemy, ctx, profile)) continue;
    return { special, combo, nextSeq: idx + 1 };
  }
  // Toutes les entrées étaient des invocations impossibles : repli sur la première attaque non-invocation.
  const fallback = seq.find((e) => e[0] !== S.SUMMON) ?? seq[0];
  return { special: fallback[0], combo: fallback[1], nextSeq: start + 1 };
}

// ───────────────────────────── Téléportation ─────────────────────────────

function pickArenaPoint(
  enemy: EnemyState,
  ctx: EnemyAIContext,
  target: PlayerState,
  flying: boolean,
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
    if (!ctx.canOccupy(p, r, flying)) continue;
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

function startTeleport(enemy: EnemyState, ctx: EnemyAIContext, target: PlayerState, profile: BossProfile): void {
  const d = enemy.data;
  const total = profile.teleportMs ?? MORVANE_TELEPORT_MS;
  clearTelegraph(d);
  enemy.mode = 'teleport';
  enemy.modeTimerMs = total;
  d.special = S.TELEPORT;
  d.teleportTotalMs = total;
  d.teleportMoved = 0;
  d.teleportNext = 0;
  d.crowdMs = 0;
  const dest = pickArenaPoint(enemy, ctx, target, profile.flying);
  d.teleportToX = dest ? dest.x : enemy.pos.x;
  d.teleportToY = dest ? dest.y : enemy.pos.y;
}

function stepTeleport(enemy: EnemyState, ctx: EnemyAIContext, target: PlayerState, dt: number, profile: BossProfile): void {
  const d = enemy.data;
  enemy.modeTimerMs -= dt;
  const total = gd(d, 'teleportTotalMs') || profile.teleportMs || MORVANE_TELEPORT_MS;
  if (!gd(d, 'teleportMoved') && enemy.modeTimerMs <= total / 2) {
    let x = gd(d, 'teleportToX');
    let y = gd(d, 'teleportToY');
    const r = ENEMIES[enemy.kind].radius;
    let valid = ctx.canOccupy({ x, y }, r, profile.flying);
    for (const pl of ctx.players) {
      if (valid && pl.status === 'alive' && dist({ x, y }, pl.pos) < 40) valid = false;
    }
    if (!valid) {
      const alt = pickArenaPoint(enemy, ctx, target, profile.flying);
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

/** Lévitation / garde de distance : se rapproche si > far, recule si < near, sinon orbite à 60 % de la vitesse. */
function hoverMove(enemy: EnemyState, ctx: EnemyAIContext, target: PlayerState, dt: number, profile: BossProfile): void {
  const d = enemy.data;
  const def = ENEMIES[enemy.kind];
  const hv = profile.hover ?? { near: 70, far: 125 };
  const speed = def.speed * speedMult(enemy, profile);
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
  if (dd > hv.far) {
    moveAng = ang;
  } else if (dd < hv.near) {
    moveAng = ang + Math.PI;
  } else {
    moveAng = ang + (sign * Math.PI) / 2;
    spd = speed * 0.6;
  }
  const step = (spd * dt) / 1000;
  const moved = moveBoss(enemy, ctx, Math.cos(moveAng) * step, Math.sin(moveAng) * step);
  if (moved < step * 0.3) d.strafeMs = 0; // bloqué : on change de sens au prochain pas
  // Trop collé au joueur trop longtemps : téléportation ou attaque de panique.
  d.crowdMs = dd < (profile.crowdDist ?? 40) ? gd(d, 'crowdMs') + dt : 0;
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
 * Un pas d'IA de boss / demi-boss. Appelé par `updateEnemy` (ai.ts) après la préparation commune (timers, cible).
 * Muté : `enemy` (pos, mode, phase, data, cooldown…) ; effets : `ctx.spawnProjectile`, `ctx.spawnEnemy`,
 * `ctx.damageCircle`, `ctx.emit`.
 * @param enemy boss ou demi-boss (kinds : golem, morvane, warden, frostqueen, pyromancer, forgelord, wraith, voidlord)
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
  const profile = profileOf(enemy.kind);
  d.engaged = 1;
  const phase = bossPhaseFor(enemy.kind, enemy.hp, enemy.maxHp);
  if (phase > enemy.phase) changePhase(enemy, ctx, phase);
  const def = ENEMIES[enemy.kind];
  const canTeleport = profile.teleportAfter !== undefined || profile.crowdTeleport === true;

  switch (enemy.mode) {
    case 'windup': {
      enemy.modeTimerMs -= dt;
      const total = gd(d, 'windupTotalMs') || MIN_BOSS_WINDUP_MS;
      const special = gd(d, 'special');
      const spec = specFor(enemy, special);
      if (spec.trackFrac > 0 && enemy.modeTimerMs > total * (1 - spec.trackFrac)) {
        if (special === S.VOIDZONE) placeZones(enemy, ctx, spec);
        else d.aimAngle = angleBetween(enemy.pos, target.pos);
      }
      faceAngle(enemy, gd(d, 'aimAngle'));
      if (enemy.modeTimerMs <= 0) startAttack(enemy, ctx, profile);
      return;
    }
    case 'attack': {
      stepAttack(enemy, ctx, dt);
      enemy.modeTimerMs -= dt;
      if (enemy.modeTimerMs <= 0) finishAttack(enemy, ctx, profile);
      return;
    }
    case 'recover': {
      enemy.modeTimerMs -= dt;
      if (enemy.modeTimerMs > 0) return;
      enemy.modeTimerMs = 0;
      if (gd(d, 'comboPending') > 0) {
        d.comboPending = 0;
        startWindup(enemy, ctx, target, gd(d, 'comboSpecial'), gd(d, 'comboLeft'));
      } else if (profile.teleportAfter && gd(d, 'teleportNext') > 0) {
        startTeleport(enemy, ctx, target, profile);
      } else {
        clearTelegraph(d);
        enemy.mode = 'chase';
      }
      return;
    }
    case 'teleport':
      if (canTeleport) {
        stepTeleport(enemy, ctx, target, dt, profile);
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

  if (profile.style === 'brute') {
    const dd = dist(enemy.pos, target.pos);
    d.chaseMs = gd(d, 'chaseMs') + dt;
    approach(enemy, ctx, target, dt, def.speed * speedMult(enemy, profile), def.radius + PLAYER_RADIUS + (profile.stopPad ?? 16));
    if (enemy.attackCooldownMs <= 0) {
      const pick = pickAttack(enemy, ctx, profile);
      const trigger = profile.triggerDist ? profile.triggerDist(pick.special) : 90;
      if (dd <= trigger || gd(d, 'chaseMs') >= (profile.forceMs ?? 2200)) {
        d.seq = pick.nextSeq;
        d.strike = 0;
        startWindup(enemy, ctx, target, pick.special, pick.combo);
      }
    }
    return;
  }

  // Style 'hover' : lévite / garde ses distances, attaque dès que le délai est écoulé, se téléporte ou panique si on le colle.
  hoverMove(enemy, ctx, target, dt, profile);
  if (profile.crowdTeleport && gd(d, 'crowdMs') > CROWD_TELEPORT_MS && enemy.attackCooldownMs > 0) {
    startTeleport(enemy, ctx, target, profile);
    return;
  }
  if (profile.panicSpecial !== undefined && gd(d, 'crowdMs') > PANIC_CROWD_MS && enemy.attackCooldownMs <= 0) {
    d.strike = 0;
    startWindup(enemy, ctx, target, profile.panicSpecial, 0);
    return;
  }
  if (enemy.attackCooldownMs <= 0) {
    const pick = pickAttack(enemy, ctx, profile);
    d.seq = pick.nextSeq;
    d.strike = 0;
    startWindup(enemy, ctx, target, pick.special, pick.combo);
  }
}
