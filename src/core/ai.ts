/**
 * IA des ennemis — logique pure (aucune dépendance à Phaser/DOM/Math.random/Date.now).
 *
 * La simulation appelle `createEnemyState` à l'apparition, `updateEnemy` à chaque pas fixe et `onEnemyHit`
 * quand un joueur touche l'ennemi. L'IA ne lit/écrit QUE l'`EnemyState` et le `EnemyAIContext` :
 *  - temps : `ctx.dtMs` uniquement ; hasard : `ctx.random()` uniquement ;
 *  - déplacement : `ctx.moveWithCollision` uniquement (chauve-souris, feu follet et Morvane passent `flying = true`,
 *    cf. note additive dans types.ts : les fosses ne les bloquent pas, les murs oui).
 *
 * ══════════════════════════════ MODES (`enemy.mode`) — à l'usage du RENDU ══════════════════════════════
 *  'idle'     pas de cible : errance douce (ou immobile pour les boss). Animation de marche lente.
 *  'chase'    cible acquise : poursuite / garde de distance / bonds (slime). Animation de marche normale.
 *  'windup'   TÉLÉGRAPHE d'une attaque (≥ 350 ms ennemis normaux, ≥ 600 ms boss). L'EnemyView doit FAIRE CLIGNOTER
 *             (teinte blanche/rouge alternée) l'ennemi et peut dessiner la zone annoncée. Progression :
 *             `p = 1 - modeTimerMs / data.windupTotalMs` (0 → 1). `data.special` identifie l'attaque annoncée
 *             (voir ENEMY_SPECIALS) ; `data.aimAngle` = direction visée (radians, 0 = droite, π/2 = bas).
 *  'attack'   exécution (dégâts / tir / bond / charge) : courte, `modeTimerMs` = temps restant
 *             (durée totale dans `data.activeTotalMs`). Frame « attaque » ou étirement.
 *  'recover'  fenêtre de VULNÉRABILITÉ après l'attaque (ou rugissement de boss si `data.special === ROAR`).
 *  'stunned'  étourdi par un coup (court, borné) : secousse / frame « hurt ».
 *  'teleport' disparition puis réapparition (feu follet, Morvane) : alpha = 0 → 1 selon `modeTimerMs` /
 *             `data.teleportTotalMs` (la 1re moitié s'efface à l'ancienne position, la 2de réapparaît à la nouvelle ;
 *             `data.teleportToX/Y` = destination, utilisable pour dessiner un portail d'arrivée).
 *
 * `enemy.hitFlashMs` (> 0 : flash blanc d'impact, décroissant) ; `enemy.facing` suit la direction de marche/visée
 * (les ennemis n'ont pas de frames gauche/droite : flipX côté rendu).
 *
 * ══════════════════════════════ CLÉS `data` UTILISÉES PAR LE RENDU ══════════════════════════════
 *  special          attaque annoncée/en cours (ENEMY_SPECIALS ; 0 = attaque de base ou aucune)
 *  aimAngle         direction visée en radians (windup/attack)
 *  windupTotalMs    durée totale du télégraphe courant (pour la progression)
 *  activeTotalMs    durée totale de la phase 'attack' courante
 *  telegraphRadius  rayon (px) de la zone annoncée (cercle autour du point d'impact), 0 si aucune
 *  telegraphDist    distance (px) du centre de la zone par rapport à l'ennemi dans la direction aimAngle
 *  telegraphLength  longueur (px) de la ligne annoncée (bond, charge, racines, éventail), 0 si aucune
 *  telegraphSpread  ouverture totale (radians) de l'éventail annoncé autour de aimAngle, 0 si aucune
 *  hop              slime : 1 en l'air (bond), 0 au sol (animation squash/stretch)
 *  teleportTotalMs / teleportToX / teleportToY / teleportMoved   voir 'teleport'
 *  engaged          boss / demi-boss : 1 une fois le combat engagé (barre de vie à afficher)
 *  zoneCount/zoneX0..2/zoneY0..2/zoneRadius   seigneur du Néant (special VOIDZONE) : cercles de la zone de danger (bosses.ts)
 *  Clés internes (kbx, kby, stunMs, stunImmuneMs, wanderMs, burstMs, strafeMs, seq, combo…) : ne pas utiliser.
 *
 * Pour les boss et demi-boss, `enemy.phase` vaut 0 avant l'engagement puis 1..N (N = 2 à 4, voir bosses.ts / bossData.ts).
 */
import { PLAYER_RADIUS } from './constants';
import { ENEMIES, isAnyBossKind, isFlyingKind } from './enemies';
import { angleBetween, clamp, dirFromVec, dist, vecFromAngle } from './geometry';
import { ENEMY_SPECIALS, updateBoss } from './bosses';
import type { EnemyAIContext, EnemyKind, EnemyState, PlayerState, Vec2 } from './types';

export { ENEMY_SPECIALS } from './bosses';

/** Modes de l'IA (voir la documentation en tête de fichier). */
export const ENEMY_MODES = ['idle', 'chase', 'windup', 'attack', 'recover', 'stunned', 'teleport'] as const;
export type EnemyMode = (typeof ENEMY_MODES)[number];

/** Clés `data` documentées pour le rendu (lecture seule côté vue). */
export const ENEMY_RENDER_DATA_KEYS = [
  'special',
  'aimAngle',
  'windupTotalMs',
  'activeTotalMs',
  'telegraphRadius',
  'telegraphDist',
  'telegraphLength',
  'telegraphSpread',
  'hop',
  'teleportTotalMs',
  'teleportToX',
  'teleportToY',
  'teleportMoved',
  'engaged',
  'zoneCount',
  'zoneX0',
  'zoneY0',
  'zoneX1',
  'zoneY1',
  'zoneX2',
  'zoneY2',
  'zoneRadius',
] as const;

// ───────────────────────────── Constantes ─────────────────────────────

const S = ENEMY_SPECIALS;
/** Un pas plus long que ça (onglet en arrière-plan…) est tronqué pour rester stable. */
const MAX_DT_MS = 100;
/** Délai (ms) avant la 1re attaque après avoir repéré un joueur (l'ennemi « s'alerte »). */
const ALERT_COOLDOWN_MS = 400;
/** Un ennemi garde sa cible tant qu'elle reste dans aggroRadius × ce facteur. */
const LOSE_TARGET_FACTOR = 1.4;
/** Constante de temps (ms) de la décroissance du recul. */
const KNOCKBACK_TAU_MS = 90;
/** Durée (ms) du flash blanc d'impact. */
const HIT_FLASH_MS = 140;
/** Après un étourdissement, l'ennemi ne peut pas être ré-étourdi pendant ce délai (ms) : borne le stun cumulé (≈ 27 %). */
const STUN_IMMUNE_AFTER_MS = 600;
/** Distance (px) max d'errance autour du point d'apparition. */
const WANDER_LEASH_PX = 70;

interface HitProfile {
  /** Facteur de recul (0 = aucun). */
  kb: number;
  /** Durée d'étourdissement (ms, 0 = jamais étourdi). */
  stunMs: number;
}

const HIT_PROFILES: Readonly<Record<EnemyKind, HitProfile>> = {
  slime: { kb: 1, stunMs: 220 },
  bat: { kb: 1.2, stunMs: 160 },
  skeleton: { kb: 0.7, stunMs: 180 },
  archer: { kb: 1, stunMs: 220 },
  spider: { kb: 1, stunMs: 160 },
  wisp: { kb: 1, stunMs: 200 },
  knight: { kb: 0, stunMs: 0 },
  golem: { kb: 0, stunMs: 0 },
  morvane: { kb: 0, stunMs: 0 },
  warden: { kb: 0, stunMs: 0 },
  frostqueen: { kb: 0, stunMs: 0 },
  pyromancer: { kb: 0, stunMs: 0 },
  forgelord: { kb: 0, stunMs: 0 },
  wraith: { kb: 0, stunMs: 0 },
  voidlord: { kb: 0, stunMs: 0 },
};

interface StrikeProfile {
  special: number;
  windupMs: number;
  activeMs: number;
  recoverMs: number;
  /** Fraction initiale du télégraphe pendant laquelle la visée suit la cible. */
  trackFrac: number;
  /** Vitesse (px/s) du bond/piqué pendant 'attack' (0 = pas de déplacement). */
  lungeSpeed: number;
  /** Rayon (px) de la zone de dégâts. */
  hitRadius: number;
  /** Décalage (px) du centre de la zone dans la direction visée. */
  hitOffset: number;
}

const STRIKES: Readonly<Partial<Record<EnemyKind, StrikeProfile>>> = {
  slime: { special: S.NONE, windupMs: 380, activeMs: 140, recoverMs: 650, trackFrac: 0.3, lungeSpeed: 0, hitRadius: 17, hitOffset: 0 },
  bat: { special: S.DIVE, windupMs: 360, activeMs: 280, recoverMs: 700, trackFrac: 0.7, lungeSpeed: 210, hitRadius: 8, hitOffset: 0 },
  skeleton: { special: S.NONE, windupMs: 450, activeMs: 160, recoverMs: 550, trackFrac: 0.5, lungeSpeed: 0, hitRadius: 14, hitOffset: 10.5 },
  spider: { special: S.LEAP, windupMs: 380, activeMs: 230, recoverMs: 600, trackFrac: 0.6, lungeSpeed: 190, hitRadius: 11, hitOffset: 0 },
  knight: { special: S.HEAVY, windupMs: 750, activeMs: 220, recoverMs: 800, trackFrac: 0.45, lungeSpeed: 0, hitRadius: 19, hitOffset: 12 },
  archer: { special: S.SHOT, windupMs: 520, activeMs: 120, recoverMs: 500, trackFrac: 0.6, lungeSpeed: 0, hitRadius: 0, hitOffset: 0 },
  wisp: { special: S.VOLLEY, windupMs: 600, activeMs: 150, recoverMs: 300, trackFrac: 0.5, lungeSpeed: 0, hitRadius: 0, hitOffset: 0 },
};

/** Durée totale (ms) de la téléportation d'un feu follet. */
const WISP_TELEPORT_MS = 450;

// ───────────────────────────── Utilitaires ─────────────────────────────

/** Lecture sûre d'une clé `data` (0 si absente ou non finie). */
function gd(d: Record<string, number>, k: string): number {
  const v = d[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function faceAngle(enemy: EnemyState, angle: number): void {
  enemy.facing = dirFromVec(vecFromAngle(angle), enemy.facing);
}

function isFlying(kind: EnemyKind): boolean {
  return isFlyingKind(kind);
}

/** Déplace l'ennemi via la collision du contexte ; retourne la distance réellement parcourue. */
function moveEnemy(enemy: EnemyState, ctx: EnemyAIContext, dx: number, dy: number): number {
  if (!(Math.abs(dx) + Math.abs(dy) > 1e-9) || !Number.isFinite(dx) || !Number.isFinite(dy)) return 0;
  const np = ctx.moveWithCollision(enemy.pos, { x: dx, y: dy }, ENEMIES[enemy.kind].radius, isFlying(enemy.kind));
  if (!np || !Number.isFinite(np.x) || !Number.isFinite(np.y)) return 0;
  const moved = Math.hypot(np.x - enemy.pos.x, np.y - enemy.pos.y);
  enemy.pos.x = np.x;
  enemy.pos.y = np.y;
  return moved;
}

function clearTelegraph(d: Record<string, number>): void {
  d.special = S.NONE;
  d.telegraphRadius = 0;
  d.telegraphDist = 0;
  d.telegraphLength = 0;
  d.telegraphSpread = 0;
}

// ───────────────────────────── Création ─────────────────────────────

/**
 * Crée l'état d'un ennemi : PV = `ENEMIES[kind].hp`, mode 'idle', phase 0, cible -1, données de l'IA initialisées.
 * Le point d'apparition est mémorisé (`data.homeX/homeY`) pour limiter l'errance.
 * @param kind type d'ennemi
 * @param pos position de départ en pixels (copiée)
 * @param id identifiant unique d'entité
 * @param wave vague d'apparition
 * @throws Error si le type est inconnu
 */
export function createEnemyState(kind: EnemyKind, pos: Vec2, id: number, wave: number): EnemyState {
  const def = ENEMIES[kind];
  if (!def) throw new Error(`Ennemi inconnu : ${String(kind)}`);
  return {
    id,
    kind,
    pos: { x: pos.x, y: pos.y },
    facing: 'down',
    hp: def.hp,
    maxHp: def.hp,
    mode: 'idle',
    modeTimerMs: 0,
    attackCooldownMs: 0,
    hitFlashMs: 0,
    data: {
      kbx: 0,
      kby: 0,
      stunMs: 0,
      stunImmuneMs: 0,
      special: S.NONE,
      aimAngle: 0,
      windupTotalMs: 0,
      activeTotalMs: 0,
      telegraphRadius: 0,
      telegraphDist: 0,
      telegraphLength: 0,
      telegraphSpread: 0,
      hop: 0,
      hopMs: 0,
      hopAngle: 0,
      wanderMs: 0,
      wanderMoving: 0,
      wanderAngle: 0,
      burstMs: 0,
      burstAngle: 0,
      burstSpeed: 1,
      strafeMs: 0,
      strafeSign: 1,
      stuckMs: 0,
      detourMs: 0,
      detourSign: 1,
      fired: 0,
      shots: 0,
      engaged: 0,
      homeX: pos.x,
      homeY: pos.y,
    },
    phase: 0,
    targetId: -1,
    wave,
    dead: false,
  };
}

// ───────────────────────────── Coups reçus ─────────────────────────────

/**
 * À appeler par la simulation quand un joueur touche l'ennemi (les dégâts sont appliqués par ailleurs).
 *  - flash d'impact (`hitFlashMs`) pour tous ;
 *  - recul proportionnel aux dégâts bruts (nul pour le chevalier et les boss, faible pour le squelette) ;
 *  - étourdissement bref (160–220 ms) qui interrompt un télégraphe mais pas une attaque en cours ;
 *  - BORNE : après un étourdissement, `STUN_IMMUNE_AFTER_MS` (600 ms) d'immunité au stun (et recul réduit) :
 *    un ennemi frappé en continu reste attaquable, ne peut pas être enchaîné indéfiniment (≈ 27 % du temps étourdi
 *    au maximum) et peut quand même terminer un télégraphe entre deux étourdissements.
 *  - n'altère jamais la phase d'un boss.
 * @param enemy ennemi touché (muté : hitFlashMs, data, mode)
 * @param hitFrom position de la source du coup (px)
 * @param rawDamage dégâts bruts du coup (sert au recul)
 */
export function onEnemyHit(enemy: EnemyState, hitFrom: Vec2, rawDamage: number): void {
  if (enemy.dead) return;
  enemy.hitFlashMs = HIT_FLASH_MS;
  const prof = HIT_PROFILES[enemy.kind];
  if (!prof || (prof.kb <= 0 && prof.stunMs <= 0)) return;
  const d = enemy.data;
  const mode = enemy.mode;
  const canStun =
    prof.stunMs > 0 && gd(d, 'stunImmuneMs') <= 0 && gd(d, 'stunMs') <= 0 && mode !== 'attack' && mode !== 'teleport';

  if (prof.kb > 0) {
    let dx = enemy.pos.x - hitFrom.x;
    let dy = enemy.pos.y - hitFrom.y;
    let len = Math.hypot(dx, dy);
    if (!Number.isFinite(len) || len < 1e-6) {
      const f = enemy.facing === 'left' ? 1 : enemy.facing === 'right' ? -1 : 0;
      dx = f;
      dy = f === 0 ? (enemy.facing === 'up' ? 1 : -1) : 0;
      len = 1;
    }
    const raw = Number.isFinite(rawDamage) ? rawDamage : 0;
    const v0 = clamp(raw * 6, 40, 160) * prof.kb * (canStun ? 1 : 0.3);
    d.kbx = (dx / len) * v0;
    d.kby = (dy / len) * v0;
  }

  if (canStun) {
    d.stunMs = prof.stunMs;
    d.stunImmuneMs = prof.stunMs + STUN_IMMUNE_AFTER_MS;
    enemy.mode = 'stunned';
    enemy.modeTimerMs = prof.stunMs;
    clearTelegraph(d);
    d.fired = 0;
  }
}

/** Retard maximal (ms) imposé à l'attaque suivante d'un boss par un étourdissement de spécial (jamais d'immobilisation). */
const BOSS_STUN_DELAY_MAX_MS = 400;

/**
 * Étourdit un ennemi (attaque spéciale d'un joueur, ex. Séisme) pour `ms` millisecondes, indépendamment de l'immunité
 * post-étourdissement des coups normaux (mais pose une immunité courte pour éviter l'enchaînement infini).
 *  - ennemi normal : étourdi `ms` (télégraphe interrompu) ; le chevalier n'est étourdi que 60 % du temps ;
 *  - feu follet en téléportation : insensible ;
 *  - BOSS : jamais étourdi ni immobilisé ; son prochain déclenchement d'attaque est seulement retardé de `min(30 % × ms, 400 ms)`.
 * @param enemy ennemi (muté : mode, data.stunMs, data.stunImmuneMs, attackCooldownMs pour un boss)
 * @param ms durée voulue (ms)
 * @returns true si l'ennemi est effectivement étourdi
 */
export function stunEnemy(enemy: EnemyState, ms: number): boolean {
  if (enemy.dead || !(ms > 0) || !Number.isFinite(ms)) return false;
  const def = ENEMIES[enemy.kind];
  if (def && isAnyBossKind(def.kind)) {
    enemy.attackCooldownMs = Math.max(enemy.attackCooldownMs, Math.min(BOSS_STUN_DELAY_MAX_MS, ms * 0.3));
    return false;
  }
  if (enemy.mode === 'teleport') return false;
  const d = enemy.data;
  const dur = enemy.kind === 'knight' ? ms * 0.6 : ms;
  d.stunMs = Math.max(gd(d, 'stunMs'), dur);
  d.stunImmuneMs = Math.max(gd(d, 'stunImmuneMs'), dur + STUN_IMMUNE_AFTER_MS / 2);
  enemy.mode = 'stunned';
  enemy.modeTimerMs = d.stunMs;
  clearTelegraph(d);
  d.fired = 0;
  return true;
}

/**
 * Repousse un ennemi à la vitesse initiale `speed` (px/s, décroissance exponentielle) à l'opposé de `from`.
 * Sans effet sur les boss et le chevalier (profil de recul nul) ; le recul est modulé par le profil de l'ennemi.
 * @param enemy ennemi (muté : data.kbx / data.kby)
 * @param from origine de la poussée (px)
 * @param speed vitesse initiale (px/s)
 * @returns true si un recul a été appliqué
 */
export function knockEnemy(enemy: EnemyState, from: Vec2, speed: number): boolean {
  if (enemy.dead || !Number.isFinite(speed) || speed <= 0) return false;
  const prof = HIT_PROFILES[enemy.kind];
  if (!prof || prof.kb <= 0) return false;
  let dx = enemy.pos.x - from.x;
  let dy = enemy.pos.y - from.y;
  let len = Math.hypot(dx, dy);
  if (!Number.isFinite(len) || len < 1e-6) {
    dx = 0;
    dy = 1;
    len = 1;
  }
  enemy.data.kbx = (dx / len) * speed * prof.kb;
  enemy.data.kby = (dy / len) * speed * prof.kb;
  return true;
}

// ───────────────────────────── Ciblage ─────────────────────────────

function selectTarget(enemy: EnemyState, ctx: EnemyAIContext, aggro: number): PlayerState | null {
  let best: PlayerState | null = null;
  let bestD = Infinity;
  let cur: PlayerState | null = null;
  for (const p of ctx.players) {
    if (p.status !== 'alive') continue;
    const dd = dist(enemy.pos, p.pos);
    if (!Number.isFinite(dd)) continue;
    if (p.id === enemy.targetId) cur = p;
    if (dd < bestD) {
      bestD = dd;
      best = p;
    }
  }
  let chosen: PlayerState | null = null;
  if (cur) {
    const dc = dist(enemy.pos, cur.pos);
    if (dc <= aggro * LOSE_TARGET_FACTOR && (best === null || best === cur || bestD >= dc * 0.7 || bestD > aggro)) {
      chosen = cur;
    }
  }
  if (!chosen && best && bestD <= aggro) chosen = best;
  enemy.targetId = chosen ? chosen.id : -1;
  return chosen;
}

// ───────────────────────────── Comportements communs ─────────────────────────────

function applyKnockback(enemy: EnemyState, ctx: EnemyAIContext, dt: number): void {
  const d = enemy.data;
  const kx = gd(d, 'kbx');
  const ky = gd(d, 'kby');
  if (Math.abs(kx) + Math.abs(ky) < 2) {
    d.kbx = 0;
    d.kby = 0;
    return;
  }
  moveEnemy(enemy, ctx, (kx * dt) / 1000, (ky * dt) / 1000);
  const f = Math.exp(-dt / KNOCKBACK_TAU_MS);
  d.kbx = kx * f;
  d.kby = ky * f;
}

/** Retourne true si l'ennemi est encore étourdi (il ne fait rien d'autre ce pas). */
function tickStun(enemy: EnemyState, dt: number): boolean {
  const d = enemy.data;
  const s = gd(d, 'stunMs');
  if (s <= 0) {
    if (enemy.mode === 'stunned') {
      enemy.mode = 'idle';
      enemy.modeTimerMs = 0;
    }
    return false;
  }
  d.stunMs = s - dt;
  enemy.mode = 'stunned';
  enemy.modeTimerMs = Math.max(0, d.stunMs);
  if (d.stunMs <= 0) {
    d.stunMs = 0;
    enemy.mode = 'idle';
    enemy.modeTimerMs = 0;
    return false;
  }
  return true;
}

function enterIdle(enemy: EnemyState): void {
  if (enemy.mode !== 'idle') {
    enemy.mode = 'idle';
    enemy.modeTimerMs = 0;
    clearTelegraph(enemy.data);
    enemy.data.fired = 0;
    enemy.data.hop = 0;
  }
}

function engage(enemy: EnemyState, newlyAggro: boolean): void {
  if (enemy.mode === 'chase') return;
  if (enemy.mode === 'idle' && newlyAggro) {
    enemy.attackCooldownMs = Math.max(enemy.attackCooldownMs, ALERT_COOLDOWN_MS);
  }
  enemy.mode = 'chase';
  enemy.modeTimerMs = 0;
}

/** Errance douce autour du point d'apparition (pauses aléatoires, jamais au-delà de WANDER_LEASH_PX). */
function wander(enemy: EnemyState, ctx: EnemyAIContext, dt: number, speedMult: number, pauseChance: number): void {
  const d = enemy.data;
  const def = ENEMIES[enemy.kind];
  d.wanderMs = gd(d, 'wanderMs') - dt;
  if (d.wanderMs <= 0) {
    if (ctx.random() < pauseChance) {
      d.wanderMoving = 0;
      d.wanderMs = 600 + ctx.random() * 800;
    } else {
      d.wanderMoving = 1;
      const home = { x: gd(d, 'homeX'), y: gd(d, 'homeY') };
      d.wanderAngle =
        dist(enemy.pos, home) > WANDER_LEASH_PX
          ? angleBetween(enemy.pos, home) + (ctx.random() - 0.5) * 0.8
          : ctx.random() * Math.PI * 2;
      d.wanderMs = 700 + ctx.random() * 1100;
    }
  }
  if (gd(d, 'wanderMoving') === 1) {
    const step = (def.speed * speedMult * dt) / 1000;
    const a = gd(d, 'wanderAngle');
    const moved = moveEnemy(enemy, ctx, Math.cos(a) * step, Math.sin(a) * step);
    if (moved < step * 0.3) d.wanderMs = 0;
    faceAngle(enemy, a);
  }
}

/** Poursuite directe avec contournement simple (détour perpendiculaire si bloqué). */
function chaseStep(
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
  if (!(dd > stopDist)) {
    d.stuckMs = 0;
    return;
  }
  if (gd(d, 'detourMs') > 0) {
    d.detourMs = gd(d, 'detourMs') - dt;
    ang += (gd(d, 'detourSign') || 1) * 1.2;
  }
  const step = Math.min((speed * dt) / 1000, dd - stopDist);
  const moved = moveEnemy(enemy, ctx, Math.cos(ang) * step, Math.sin(ang) * step);
  if (moved < step * 0.25) {
    d.stuckMs = gd(d, 'stuckMs') + dt;
    if (d.stuckMs > 350 && gd(d, 'detourMs') <= 0) {
      d.detourMs = 700;
      d.detourSign = ctx.random() < 0.5 ? -1 : 1;
      d.stuckMs = 0;
    }
  } else {
    d.stuckMs = Math.max(0, gd(d, 'stuckMs') - dt * 2);
  }
}

/** Garde ses distances (archer, feu follet) : recule si trop près, avance si trop loin, sinon tourne autour. */
function keepDistance(
  enemy: EnemyState,
  ctx: EnemyAIContext,
  target: PlayerState,
  dt: number,
  near: number,
  far: number,
  speed: number,
): void {
  const d = enemy.data;
  const dd = dist(enemy.pos, target.pos);
  const toward = angleBetween(enemy.pos, target.pos);
  faceAngle(enemy, toward);
  d.strafeMs = gd(d, 'strafeMs') - dt;
  if (d.strafeMs <= 0) {
    d.strafeSign = ctx.random() < 0.5 ? -1 : 1;
    d.strafeMs = 1500 + ctx.random() * 1500;
  }
  const sign = gd(d, 'strafeSign') || 1;
  let ang = toward;
  let spd = speed;
  let retreating = false;
  if (dd < near) {
    ang = toward + Math.PI;
    spd = speed * 1.1;
    retreating = true;
  } else if (dd > far) {
    ang = toward;
  } else {
    ang = toward + (sign * Math.PI) / 2;
    spd = speed * 0.5;
  }
  const step = (spd * dt) / 1000;
  const moved = moveEnemy(enemy, ctx, Math.cos(ang) * step, Math.sin(ang) * step);
  if (moved < step * 0.3) {
    if (retreating) {
      // Dos au mur : on glisse sur le côté plutôt que de rester collé au joueur.
      const side = toward + (sign * Math.PI) / 2;
      moveEnemy(enemy, ctx, Math.cos(side) * step, Math.sin(side) * step);
    } else {
      d.strafeMs = 0;
    }
  }
}

/** Vol erratique par rafales (chauve-souris). `retreat` = s'éloigne de la cible. */
function batFly(
  enemy: EnemyState,
  ctx: EnemyAIContext,
  target: PlayerState | null,
  dt: number,
  speedMult: number,
  retreat: boolean,
): void {
  const d = enemy.data;
  const def = ENEMIES[enemy.kind];
  d.burstMs = gd(d, 'burstMs') - dt;
  if (d.burstMs <= 0) {
    d.burstMs = 250 + ctx.random() * 300;
    d.burstSpeed = 0.7 + ctx.random() * 0.8;
    const jitter = (ctx.random() - 0.5) * 2.2;
    if (target) {
      let base = angleBetween(enemy.pos, target.pos);
      const dd = dist(enemy.pos, target.pos);
      if (retreat || dd < 30) base += Math.PI;
      d.burstAngle = base + (retreat || dd < 30 ? jitter * 0.5 : jitter);
    } else {
      const home = { x: gd(d, 'homeX'), y: gd(d, 'homeY') };
      d.burstAngle =
        dist(enemy.pos, home) > WANDER_LEASH_PX * 1.3
          ? angleBetween(enemy.pos, home) + jitter * 0.4
          : jitter * Math.PI;
    }
  }
  const a = gd(d, 'burstAngle');
  const step = (def.speed * speedMult * (gd(d, 'burstSpeed') || 1) * dt) / 1000;
  const moved = moveEnemy(enemy, ctx, Math.cos(a) * step, Math.sin(a) * step);
  if (moved < step * 0.3) d.burstMs = 0;
  if (target) faceAngle(enemy, angleBetween(enemy.pos, target.pos));
  else faceAngle(enemy, a);
}

// ───────────────────────────── Frappes (windup → attack → recover) ─────────────────────────────

/** Distance centre à centre à laquelle l'ennemi déclenche son télégraphe. */
function strikeTrigger(kind: EnemyKind): number {
  const def = ENEMIES[kind];
  switch (kind) {
    case 'bat':
      return 52;
    case 'spider':
      return 46;
    case 'archer':
      return def.attackRange;
    case 'wisp':
      return def.attackRange * 0.95;
    default:
      return def.attackRange + def.radius + PLAYER_RADIUS;
  }
}

function beginWindup(enemy: EnemyState, target: PlayerState): void {
  const prof = STRIKES[enemy.kind];
  if (!prof) return;
  const d = enemy.data;
  enemy.mode = 'windup';
  enemy.modeTimerMs = prof.windupMs;
  d.windupTotalMs = prof.windupMs;
  d.special = prof.special;
  d.aimAngle = angleBetween(enemy.pos, target.pos);
  d.telegraphRadius = prof.hitRadius;
  d.telegraphDist = prof.hitOffset;
  d.telegraphLength = (prof.lungeSpeed * prof.activeMs) / 1000;
  d.telegraphSpread = enemy.kind === 'wisp' ? (gd(d, 'shots') % 2 === 0 ? 0.7 : 0.24) : 0;
  d.fired = 0;
  d.hop = 0;
  faceAngle(enemy, d.aimAngle);
}

function strikeCenter(enemy: EnemyState, prof: StrikeProfile): Vec2 {
  const a = gd(enemy.data, 'aimAngle');
  return { x: enemy.pos.x + Math.cos(a) * prof.hitOffset, y: enemy.pos.y + Math.sin(a) * prof.hitOffset };
}

/** Effet instantané au début de 'attack' : tir de projectiles ou coup de zone (une seule fois). */
function fireStrike(enemy: EnemyState, ctx: EnemyAIContext, prof: StrikeProfile): void {
  const def = ENEMIES[enemy.kind];
  const d = enemy.data;
  const aim = gd(d, 'aimAngle');
  const muzzle = vecFromAngle(aim, def.radius + 2);
  const origin = { x: enemy.pos.x + muzzle.x, y: enemy.pos.y + muzzle.y };
  switch (enemy.kind) {
    case 'archer': {
      const speed = 150;
      ctx.spawnProjectile({
        kind: 'arrow',
        pos: origin,
        vel: vecFromAngle(aim, speed),
        damage: def.damage,
        radius: 3,
        lifeMs: 1100,
        enemyId: enemy.id,
      });
      break;
    }
    case 'wisp': {
      const pattern = gd(d, 'shots') % 2;
      const offsets = pattern === 0 ? [-0.35, 0, 0.35] : [-0.12, 0.12];
      for (const off of offsets) {
        ctx.spawnProjectile({
          kind: 'orb',
          pos: origin,
          vel: vecFromAngle(aim + off, 70),
          damage: def.damage,
          radius: 4,
          lifeMs: 2400,
          enemyId: enemy.id,
        });
      }
      d.shots = gd(d, 'shots') + 1;
      break;
    }
    case 'bat':
    case 'spider':
      // Bond/piqué : les dégâts sont appliqués à chaque pas du déplacement (voir runStrike).
      break;
    default:
      ctx.damageCircle(strikeCenter(enemy, prof), prof.hitRadius, def.damage, enemy.id);
      break;
  }
}

function pickWispDest(enemy: EnemyState, ctx: EnemyAIContext, target: PlayerState): Vec2 | null {
  const r = ENEMIES[enemy.kind].radius;
  const m = r + 4;
  for (let i = 0; i < 10; i++) {
    const a = ctx.random() * Math.PI * 2;
    const rad = 55 + ctx.random() * 40;
    const p = {
      x: clamp(target.pos.x + Math.cos(a) * rad, m, Math.max(m, ctx.roomBounds.width - m)),
      y: clamp(target.pos.y + Math.sin(a) * rad, m, Math.max(m, ctx.roomBounds.height - m)),
    };
    if (ctx.canOccupy(p, r, true) && dist(p, target.pos) >= 40) return p;
  }
  return null;
}

function beginWispTeleport(enemy: EnemyState, ctx: EnemyAIContext, target: PlayerState): void {
  const d = enemy.data;
  clearTelegraph(d);
  enemy.mode = 'teleport';
  enemy.modeTimerMs = WISP_TELEPORT_MS;
  d.special = S.TELEPORT;
  d.teleportTotalMs = WISP_TELEPORT_MS;
  d.teleportMoved = 0;
  const dest = pickWispDest(enemy, ctx, target);
  d.teleportToX = dest ? dest.x : enemy.pos.x;
  d.teleportToY = dest ? dest.y : enemy.pos.y;
}

/**
 * Gère les modes 'windup' / 'attack' / 'recover' / 'teleport' des ennemis qui frappent. Retourne true si le mode
 * courant a été traité (l'appelant s'arrête là). Sans cible vivante à portée d'aggro, l'attaque est annulée (→ 'idle').
 */
function runStrike(enemy: EnemyState, ctx: EnemyAIContext, target: PlayerState | null, dt: number): boolean {
  const mode = enemy.mode;
  if (mode !== 'windup' && mode !== 'attack' && mode !== 'recover' && mode !== 'teleport') return false;
  const prof = STRIKES[enemy.kind];
  if (!prof || !target) {
    enterIdle(enemy);
    return false;
  }
  const def = ENEMIES[enemy.kind];
  const d = enemy.data;

  if (mode === 'windup') {
    enemy.modeTimerMs -= dt;
    const total = gd(d, 'windupTotalMs') || prof.windupMs;
    if (prof.trackFrac > 0 && enemy.modeTimerMs > total * (1 - prof.trackFrac)) {
      d.aimAngle = angleBetween(enemy.pos, target.pos);
    }
    faceAngle(enemy, gd(d, 'aimAngle'));
    if (enemy.modeTimerMs <= 0) {
      enemy.mode = 'attack';
      enemy.modeTimerMs = prof.activeMs;
      d.activeTotalMs = prof.activeMs;
      d.fired = 0;
    }
    return true;
  }

  if (mode === 'attack') {
    if (!gd(d, 'fired')) {
      d.fired = 1;
      enemy.attackCooldownMs = def.attackCooldownMs;
      fireStrike(enemy, ctx, prof);
    }
    if (prof.lungeSpeed > 0) {
      const a = gd(d, 'aimAngle');
      const step = (prof.lungeSpeed * dt) / 1000;
      moveEnemy(enemy, ctx, Math.cos(a) * step, Math.sin(a) * step);
      ctx.damageCircle(enemy.pos, prof.hitRadius, def.damage, enemy.id);
    }
    enemy.modeTimerMs -= dt;
    if (enemy.modeTimerMs <= 0) {
      enemy.mode = 'recover';
      enemy.modeTimerMs = prof.recoverMs;
      clearTelegraph(d);
      d.fired = 0;
    }
    return true;
  }

  if (mode === 'recover') {
    if (enemy.kind === 'bat') batFly(enemy, ctx, target, dt, 0.6, true);
    enemy.modeTimerMs -= dt;
    if (enemy.modeTimerMs <= 0) {
      enemy.modeTimerMs = 0;
      if (enemy.kind === 'wisp') beginWispTeleport(enemy, ctx, target);
      else enemy.mode = 'chase';
    }
    return true;
  }

  // 'teleport' (feu follet)
  enemy.modeTimerMs -= dt;
  const total = gd(d, 'teleportTotalMs') || WISP_TELEPORT_MS;
  if (!gd(d, 'teleportMoved') && enemy.modeTimerMs <= total / 2) {
    const x = gd(d, 'teleportToX');
    const y = gd(d, 'teleportToY');
    if (ctx.canOccupy({ x, y }, def.radius, true)) {
      enemy.pos.x = x;
      enemy.pos.y = y;
    }
    d.teleportMoved = 1;
  }
  if (enemy.modeTimerMs <= 0) {
    enemy.modeTimerMs = 0;
    enemy.mode = 'chase';
    clearTelegraph(d);
  }
  return true;
}

// ───────────────────────────── IA par famille ─────────────────────────────

function updateSlime(enemy: EnemyState, ctx: EnemyAIContext, target: PlayerState | null, dt: number, aggro: boolean): void {
  if (runStrike(enemy, ctx, target, dt)) return;
  const d = enemy.data;
  const def = ENEMIES[enemy.kind];
  if (target) engage(enemy, aggro);
  else enterIdle(enemy);

  if (target && enemy.attackCooldownMs <= 0 && dist(enemy.pos, target.pos) <= strikeTrigger('slime')) {
    beginWindup(enemy, target);
    return;
  }

  d.hopMs = gd(d, 'hopMs') - dt;
  if (gd(d, 'hop') === 1) {
    const a = gd(d, 'hopAngle');
    const step = (def.speed * 2.6 * dt) / 1000;
    const moved = moveEnemy(enemy, ctx, Math.cos(a) * step, Math.sin(a) * step);
    if (moved < step * 0.3) d.hopMs = Math.min(d.hopMs, 0);
    if (d.hopMs <= 0) {
      d.hop = 0;
      d.hopMs = target ? 420 + ctx.random() * 200 : 700 + ctx.random() * 600;
    }
  } else if (d.hopMs <= 0) {
    if (!target && ctx.random() < 0.4) {
      d.hopMs = 500 + ctx.random() * 500;
    } else {
      let a: number;
      if (target) {
        a = angleBetween(enemy.pos, target.pos) + (ctx.random() - 0.5) * 0.6;
      } else {
        const home = { x: gd(d, 'homeX'), y: gd(d, 'homeY') };
        a =
          dist(enemy.pos, home) > WANDER_LEASH_PX
            ? angleBetween(enemy.pos, home) + (ctx.random() - 0.5) * 0.8
            : ctx.random() * Math.PI * 2;
      }
      d.hop = 1;
      d.hopMs = 320;
      d.hopAngle = a;
      faceAngle(enemy, a);
    }
  }
}

function updateBat(enemy: EnemyState, ctx: EnemyAIContext, target: PlayerState | null, dt: number, aggro: boolean): void {
  if (runStrike(enemy, ctx, target, dt)) return;
  if (!target) {
    enterIdle(enemy);
    batFly(enemy, ctx, null, dt, 0.5, false);
    return;
  }
  engage(enemy, aggro);
  if (enemy.attackCooldownMs <= 0 && dist(enemy.pos, target.pos) <= strikeTrigger('bat')) {
    beginWindup(enemy, target);
    return;
  }
  batFly(enemy, ctx, target, dt, 1, false);
}

function updateMelee(enemy: EnemyState, ctx: EnemyAIContext, target: PlayerState | null, dt: number, aggro: boolean): void {
  if (runStrike(enemy, ctx, target, dt)) return;
  const def = ENEMIES[enemy.kind];
  if (!target) {
    enterIdle(enemy);
    wander(enemy, ctx, dt, 0.35, 0.4);
    return;
  }
  engage(enemy, aggro);
  const trigger = strikeTrigger(enemy.kind);
  if (enemy.attackCooldownMs <= 0 && dist(enemy.pos, target.pos) <= trigger) {
    beginWindup(enemy, target);
    return;
  }
  const stop = enemy.kind === 'spider' ? def.radius + PLAYER_RADIUS + 2 : trigger - 3;
  chaseStep(enemy, ctx, target, dt, def.speed, stop);
}

function updateRangedLike(
  enemy: EnemyState,
  ctx: EnemyAIContext,
  target: PlayerState | null,
  dt: number,
  aggro: boolean,
): void {
  if (runStrike(enemy, ctx, target, dt)) return;
  const def = ENEMIES[enemy.kind];
  if (!target) {
    enterIdle(enemy);
    wander(enemy, ctx, dt, enemy.kind === 'wisp' ? 0.4 : 0.35, enemy.kind === 'wisp' ? 0.2 : 0.4);
    return;
  }
  engage(enemy, aggro);
  const dd = dist(enemy.pos, target.pos);
  if (enemy.attackCooldownMs <= 0 && dd <= strikeTrigger(enemy.kind)) {
    beginWindup(enemy, target);
    return;
  }
  if (enemy.kind === 'wisp') keepDistance(enemy, ctx, target, dt, 45, def.attackRange * 0.9, def.speed);
  else keepDistance(enemy, ctx, target, dt, def.attackRange * 0.45, def.attackRange * 0.85, def.speed);
}

// ───────────────────────────── Point d'entrée ─────────────────────────────

/**
 * Un pas d'IA pour un ennemi. Distribue selon `ENEMIES[kind].ai` :
 * 'wander-chase' (slime), 'erratic-flyer' (chauve-souris), 'melee' (squelette, araignée, chevalier),
 * 'ranged' (archer), 'caster' (feu follet), 'boss-golem', 'boss-morvane' et les IA des niveaux 4-6
 * ('miniboss-warden', 'boss-frostqueen', 'miniboss-pyromancer', 'boss-forgelord', 'miniboss-wraith', 'boss-voidlord') (bosses.ts).
 *
 * Ordre : timers (flash, cooldown, immunité de stun) → recul → étourdissement → ciblage → IA.
 * Ciblage : joueur VIVANT le plus proche dans `aggroRadius` (jamais un joueur à terre) avec hystérésis (la cible est
 * conservée tant qu'elle est vivante et dans aggroRadius × 1.4, sauf si un autre joueur est nettement plus proche) ;
 * sans cible : 'idle'. Un boss ou demi-boss engagé n'a plus de limite d'aggro.
 * Mute : `enemy` uniquement (et appelle les effets du contexte : projectiles, invocations, dégâts, événements).
 * @param enemy ennemi à mettre à jour (ignoré s'il est mort)
 * @param ctx contexte fourni par la simulation (dtMs = pas fixe)
 */
export function updateEnemy(enemy: EnemyState, ctx: EnemyAIContext): void {
  if (enemy.dead) return;
  const def = ENEMIES[enemy.kind];
  if (!def) return;
  const dt = Number.isFinite(ctx.dtMs) ? clamp(ctx.dtMs, 0, MAX_DT_MS) : 0;
  if (!(dt > 0)) return;
  const d = enemy.data;

  enemy.hitFlashMs = Math.max(0, enemy.hitFlashMs - dt);
  enemy.attackCooldownMs = Math.max(0, enemy.attackCooldownMs - dt);
  d.stunImmuneMs = Math.max(0, gd(d, 'stunImmuneMs') - dt);

  applyKnockback(enemy, ctx, dt);
  if (tickStun(enemy, dt)) return;

  const hadTarget = enemy.targetId >= 0;
  const aggro = isAnyBossKind(def.kind) && gd(d, 'engaged') > 0 ? Infinity : def.aggroRadius;
  const target = selectTarget(enemy, ctx, aggro);
  const newlyAggro = target !== null && !hadTarget;

  switch (def.ai) {
    case 'wander-chase':
      updateSlime(enemy, ctx, target, dt, newlyAggro);
      break;
    case 'erratic-flyer':
      updateBat(enemy, ctx, target, dt, newlyAggro);
      break;
    case 'melee':
      updateMelee(enemy, ctx, target, dt, newlyAggro);
      break;
    case 'ranged':
    case 'caster':
      updateRangedLike(enemy, ctx, target, dt, newlyAggro);
      break;
    case 'boss-golem':
    case 'boss-morvane':
    case 'miniboss-warden':
    case 'boss-frostqueen':
    case 'miniboss-pyromancer':
    case 'boss-forgelord':
    case 'miniboss-wraith':
    case 'boss-voidlord':
      updateBoss(enemy, ctx, target, dt);
      break;
  }
}
