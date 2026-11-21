/**
 * TACTIQUES DE BOSS (« boss malins ») — logique pure (aucune dépendance à Phaser/DOM/Math.random/Date.now), appelée par `bosses.ts`.
 *
 * Un niveau active les tactiques PAR DONNÉE : `EnemySpawnDef.tactics` sur un boss ou demi-boss (validé par `levelValidation.ts`). La simulation recopie
 * alors le masque de bits dans `enemy.data.tact`. SANS ce drapeau rien de ce fichier n'est appelé : aucune clé `data` écrite, aucun tirage `ctx.random()`,
 * donc les niveaux sans tactiques (1-7, 9, tutoriel, démo) sont strictement identiques à l'octet. Ce fichier n'appelle JAMAIS `ctx.random()` (tout est déterministe) ;
 * seul `approach()` (bosses.ts, détour quand le boss est bloqué) en consomme, et uniquement pour un boss tactique.
 *
 * ── Les 6 tactiques (priorité décroissante ; code d'affichage `tactKind` = rang, bit = 1 << (rang - 1)) ──────────────────────────────────────
 *  1 guardDowned      « veilleur » : se poste à `GUARD_RING_PX` du joueur À TERRE le plus proche (au-delà de `DOWNED_THREAT_RADIUS` : le relevage n'est pas ralenti,
 *                     c'est un dissuasif de position, pas un blocage physique). Seule tactique qui peut PRÉEMPTER un autre but avant la fin de son verrou.
 *  2 campCrystal      « gardien de cristal » : se poste près d'UN SEUL cristal de soin intact (le plus proche du plus nécessiteux : joueur à terre, sinon vivant à ≤ 50 % de PV).
 *                     Ne le consomme, ne le verrouille ni ne le déplace jamais : les deux autres cristaux de la salle restent libres.
 *  3 heedCalls        « oreille » : converge sur un appelant vivant ET ISOLÉ (appel automatique croix / cœur / demi-cœur, ou appel manuel à ≤ 50 % de PV).
 *  4 interceptCarrier poursuit un porteur de cœur en réserve vivant ET ISOLÉ.
 *  5 seizeItems       « rapace » : se poste, immobile, sur le bonus le plus précieux (cœur entier > demi-cœur = bonus temporaire > équipement ; JAMAIS un objet à moins de `GUARD_RING_PX` d'un joueur
 *                     à terre, p. ex. son cœur rangé tombé à ses pieds : le boss serait sur lui et le relevage ralenti) ; un demi-cœur ou bonus temporaire
 *                     resté sous lui `SEIZE_DWELL_MS` est CONFISQUÉ (`itemSeized`, plafonné par salle). Jamais un cœur entier, un équipement ni un cristal. Un joueur qui
 *                     ramasse l'objet avant gagne (le ramassage précède la confiscation).
 *  6 huntWeak         « prédateur » : poursuit le joueur ISOLÉ le plus faible (≤ `HUNT_MAX_HP_FRAC` de ses PV).
 *  Code 7 : DÉSTABILISÉ (aucun but) ; code 0 : aucun but.
 *  Pour 3, 4 et 6 le boss remplace sa cible par la « victime » (approche ET visée du télégraphe) ; elle est toujours un joueur VIVANT (un joueur à terre n'est jamais achevé).
 *
 * ── Équité (contre-jeu garanti) ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
 *  - jamais pendant l'échauffement (`TACT_WARMUP_MS` après l'engagement) ; veille après un délai de réaction (`TACT_REACT_MS`) ;
 *  - chaque but a un BUDGET puis une RELÂCHE obligatoire (par nombre de joueurs VIVANTS, jamais par difficulté), un verrou anti-oscillation (`TACT_MIN_LOCK_MS`) ;
 *  - DÉSTABILISATION : perdre `TACT_BREAK_FRAC_*` × PV max × échelle en `TACT_BREAK_WINDOW_MS`, (PV retirés NORMALISÉS par la difficulté de l'attaquant : `combat.ts` accumule `tactAdj`, le seuil ne dépend jamais de la difficulté) ou TOUT spécial de héros qui touche
 *    (`CombatContext.disruptEnemy`, éventail d'Aelith compris ; le séisme de Brokk passe aussi par `stunEnemy`) ⇒ tous les buts coupés
 *    (`TACT_BREAK_COOL_MS` / `TACT_STUN_BREAK_MS`) ; le boss n'est toujours ni étourdi ni repoussé ;
 *  - abandon de la veille d'un joueur après `GUARD_GIVEUP_MS` de chute continue ; portée plafonnée (`TACT_REACH_PX`) ; boss bloqué (`TACT_STUCK_MS`) : but abandonné ;
 *  - les tactiques « victime » exigent un joueur ISOLÉ (aucun allié vivant à `ISOLATION_PX`) : une équipe groupée les neutralise ;
 *  - un boss lévitant (style 'hover') n'attaque pas tant qu'il n'a pas rejoint son ancre (`bosses.ts`) : sinon windup / attack / recover l'immobilisent et il n'arrive jamais ;
 *  - seules les phases 'chase' sont modifiées : fenêtres, télégraphes (≥ 600 ms), phases et téléportations de `bosses.ts` restent intacts.
 *
 * ── Clés `data` (nombres uniquement, écrites paresseusement, seulement avec `tact`) ──────────────────────────────────────────────────────────────
 *  tact (masque), tactInit, tactWarmMs, tactReactMs, tactBreakMs, tactKind (rendu), tactX/tactY (ancre, rendu), tactRef, tactLockMs, tactAgeMs, tactTravelMs, tactHpMark, tactAdj/tactAdjMark (dégâts normalisés par la difficulté de l'attaquant, écrits par `combat.ts`), tactWinMs,
 *  tactStuckMs, tactLastX/tactLastY/tactLastSet, tactCool1..tactCool6, tactDownId/tactDownMs, tactGiveUp (id + 1), tactSeizeMs, tactSeizeRef, tactSeizedCount, tactSeizeCoolMs.
 */
import { isHealerCharacter } from './autoCall';
import {
  CALL_HOLD_MS,
  CALL_RELIEF_MS,
  CAMP_MS,
  CAMP_RELIEF_MS,
  CARRIER_HOLD_MS,
  CARRIER_RELIEF_MS,
  CRYSTAL_HOLD_PAD_PX,
  CRYSTAL_NEED_FRAC,
  GUARD_GIVEUP_MS,
  GUARD_MS,
  GUARD_RELIEF_MS,
  GUARD_RING_PX,
  HUNT_HEALER_BONUS,
  HUNT_HOLD_MS,
  HUNT_MAX_HP_FRAC,
  HUNT_RELIEF_MS,
  ISOLATION_PX,
  SEIZE_COOL_MS,
  SEIZE_DWELL_MS,
  SEIZE_MAX_BOSS,
  SEIZE_MAX_MINI,
  SEIZE_POST_MS,
  SEIZE_RADIUS_PAD_PX,
  SEIZE_RELIEF_MS,
  TACT_ANCHOR_ARRIVE_PAD_PX,
  TACT_BREAK_COOL_MS,
  TACT_BREAK_FRAC_BOSS,
  TACT_BREAK_FRAC_MINI,
  TACT_BREAK_SCALE,
  TACT_BREAK_WINDOW_MS,
  TACT_MIN_LOCK_MS,
  TACT_REACH_PX,
  TACT_REACT_MS,
  TACT_SPEED_MULT,
  TACT_STUCK_MS,
  TACT_TRAVEL_MAX_MS,
  TACT_WARMUP_MS,
} from './balance';
import { ENEMIES } from './enemies';
import { dist } from './geometry';
import type { BossTacticId, EnemyAIContext, EnemyState, PlayerState, Vec2 } from './types';

// ───────────────────────────── Identifiants ─────────────────────────────

/** Les tactiques par ordre de priorité décroissante (rang + 1 = code d'affichage `tactKind`). */
export const TACTIC_IDS: readonly BossTacticId[] = ['guardDowned', 'campCrystal', 'heedCalls', 'interceptCarrier', 'seizeItems', 'huntWeak'];

/** Code d'affichage (`tactKind`) d'un boss déstabilisé. */
export const TACT_DAZED = 7;

/** Code d'affichage d'une tactique (1..6), 0 si inconnue. */
export function tacticKindOf(id: BossTacticId): number {
  return TACTIC_IDS.indexOf(id) + 1;
}

/** Masque de bits d'une liste de tactiques (inconnues ignorées ; doublons sans effet). */
export function tacticMask(ids: readonly BossTacticId[]): number {
  let m = 0;
  for (const id of ids) {
    const k = tacticKindOf(id);
    if (k > 0) m |= 1 << (k - 1);
  }
  return m;
}

/** Tactiques d'un masque, par ordre de priorité. */
export function tacticsOfMask(mask: number): BossTacticId[] {
  return TACTIC_IDS.filter((_, i) => (mask & (1 << i)) !== 0);
}

// ───────────────────────────── Utilitaires ─────────────────────────────

function gd(d: Record<string, number>, k: string): number {
  const v = d[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Le boss a-t-il des tactiques ? */
export function isTactical(enemy: EnemyState): boolean {
  return gd(enemy.data, 'tact') > 0;
}

/** Le boss a-t-il cette tactique ? */
export function hasTactic(enemy: EnemyState, id: BossTacticId): boolean {
  const k = tacticKindOf(id);
  return k > 0 && (gd(enemy.data, 'tact') & (1 << (k - 1))) !== 0;
}

function aliveCount(ctx: EnemyAIContext): number {
  let n = 0;
  for (const p of ctx.players) if (p.status === 'alive') n++;
  return n;
}

/** Indice (1..4) dans les tableaux « par joueurs vivants ». */
function aliveIdx(ctx: EnemyAIContext): number {
  return Math.min(4, Math.max(1, aliveCount(ctx)));
}

function hpFrac(p: PlayerState): number {
  return p.maxHp > 0 ? p.hp / p.maxHp : 1;
}

/** Joueur isolé : aucun allié vivant à `ISOLATION_PX` ou moins. */
function isolated(ctx: EnemyAIContext, p: PlayerState): boolean {
  for (const o of ctx.players) {
    if (o.id === p.id || o.status !== 'alive') continue;
    if (dist(o.pos, p.pos) <= ISOLATION_PX) return false;
  }
  return true;
}

function playerById(ctx: EnemyAIContext, id: number): PlayerState | null {
  for (const p of ctx.players) if (p.id === id) return p;
  return null;
}

function setKind(enemy: EnemyState, ctx: EnemyAIContext, kind: number): void {
  if (gd(enemy.data, 'tactKind') === kind) return;
  enemy.data.tactKind = kind;
  ctx.emit({ type: 'bossTactic', enemyId: enemy.id, kind });
}

/** Budget (ms) d'un but selon le nombre de joueurs vivants. */
export function tacticBudgetMs(kind: number, alive: number): number {
  const a = Math.min(4, Math.max(1, alive));
  switch (kind) {
    case 1:
      return GUARD_MS[a];
    case 2:
      return CAMP_MS[a];
    case 3:
      return CALL_HOLD_MS;
    case 4:
      return CARRIER_HOLD_MS;
    case 5:
      return SEIZE_POST_MS;
    default:
      return HUNT_HOLD_MS;
  }
}

/** Relâche (ms) obligatoire après un but. */
export function tacticReliefMs(kind: number, alive: number): number {
  const a = Math.min(4, Math.max(1, alive));
  switch (kind) {
    case 1:
      return GUARD_RELIEF_MS[a];
    case 2:
      return CAMP_RELIEF_MS[a];
    case 3:
      return CALL_RELIEF_MS;
    case 4:
      return CARRIER_RELIEF_MS;
    case 5:
      return SEIZE_RELIEF_MS;
    default:
      return HUNT_RELIEF_MS;
  }
}

/** Seuil (PV perdus en `TACT_BREAK_WINDOW_MS`) de déstabilisation du boss. */
export function tacticBreakThreshold(enemy: EnemyState, alive: number): number {
  const def = ENEMIES[enemy.kind];
  const frac = def && def.isBoss ? TACT_BREAK_FRAC_BOSS : TACT_BREAK_FRAC_MINI;
  return frac * enemy.maxHp * TACT_BREAK_SCALE[Math.min(4, Math.max(1, alive))];
}

/**
 * Déstabilise un boss tactique pour `ms` (spécial de héros qui touche, `stunEnemy`). Sans effet s'il n'a pas de tactiques.
 * Le boss n'est toujours ni étourdi ni repoussé : seuls ses buts tactiques sont coupés (au prochain pas).
 */
export function breakTactics(enemy: EnemyState, ms: number): void {
  if (!isTactical(enemy) || !(ms > 0)) return;
  enemy.data.tactBreakMs = Math.max(gd(enemy.data, 'tactBreakMs'), ms);
}

// ───────────────────────────── But tactique ─────────────────────────────

/** But tactique courant, recalculé à chaque pas à partir des données (reconstructible après un `restore`). */
export interface TacticalGoal {
  /** Code d'affichage 1..6. */
  kind: number;
  /** Point visé (ancre, ou position de la victime). */
  pos: Vec2;
  /** Distance (px) à laquelle le boss se tient de `pos` (ancre). */
  hold: number;
  /** Victime (joueur vivant) qui remplace la cible du boss ; null pour une ancre. */
  victim: PlayerState | null;
  /** Vrai : le boss va se POSTER sur `pos` (veille, cristal, bonus) ; faux : il poursuit `victim`. */
  anchor: boolean;
  /** Vrai : à portée de l'ancre un boss volant/lévitant orbite lentement (anneau) ; faux : il reste immobile. */
  orbit: boolean;
}

interface Candidate {
  ref: number;
  pos: Vec2;
  hold: number;
  victim: PlayerState | null;
  anchor: boolean;
  orbit: boolean;
}

/** Joueur « nécessiteux » pour un cristal : à terre (le plus petit id), sinon vivant à ≤ `CRYSTAL_NEED_FRAC` de PV (le plus bas). */
function neediest(ctx: EnemyAIContext): PlayerState | null {
  let down: PlayerState | null = null;
  for (const p of ctx.players) if (p.status === 'down' && (!down || p.id < down.id)) down = p;
  if (down) return down;
  let low: PlayerState | null = null;
  for (const p of ctx.players) {
    if (p.status !== 'alive' || hpFrac(p) > CRYSTAL_NEED_FRAC) continue;
    if (!low || hpFrac(p) < hpFrac(low) || (hpFrac(p) === hpFrac(low) && p.id < low.id)) low = p;
  }
  return low;
}

function pickNearest(enemy: EnemyState, list: readonly PlayerState[]): PlayerState | null {
  let best: PlayerState | null = null;
  let bestD = Infinity;
  for (const p of list) {
    const dd = dist(enemy.pos, p.pos);
    if (dd < bestD || (dd === bestD && best && p.id < best.id)) {
      best = p;
      bestD = dd;
    }
  }
  return best;
}

function victimCandidate(p: PlayerState | null, enemy: EnemyState): Candidate | null {
  if (!p) return null;
  if (dist(enemy.pos, p.pos) > TACT_REACH_PX) return null;
  return { ref: p.id, pos: { x: p.pos.x, y: p.pos.y }, hold: 0, victim: p, anchor: false, orbit: false };
}

/**
 * Candidat d'une tactique : `ref` = référence du but courant à revalider (null = choisir le meilleur) ; `forNew` : vrai pour un NOUVEAU but (le délai de réaction de la veille
 * s'applique alors). Renvoie null si la tactique ne s'applique pas (conditions, portée).
 */
function candidate(kind: number, enemy: EnemyState, ctx: EnemyAIContext, ref: number | null, forNew: boolean): Candidate | null {
  const d = enemy.data;
  const alive = aliveCount(ctx);
  switch (kind) {
    case 1: {
      const giveUp = gd(d, 'tactGiveUp');
      const downs = ctx.players.filter((p) => p.status === 'down' && p.id + 1 !== giveUp && (ref === null || p.id === ref));
      const best = pickNearest(enemy, downs);
      if (!best) return null;
      if (forNew && gd(d, 'tactReactMs') < TACT_REACT_MS) return null;
      if (dist(enemy.pos, best.pos) > TACT_REACH_PX) return null;
      return { ref: best.id, pos: { x: best.pos.x, y: best.pos.y }, hold: GUARD_RING_PX, victim: null, anchor: true, orbit: true };
    }
    case 2: {
      const w = ctx.world;
      if (!w || w.crystals.length === 0) return null;
      const needy = neediest(ctx);
      if (!needy) return null;
      let best: { idx: number; pos: Vec2 } | null = null;
      let bestD = Infinity;
      for (const c of w.crystals) {
        if (ref !== null && c.idx !== ref) continue;
        const dd = dist(c.pos, needy.pos);
        if (dd < bestD || (dd === bestD && best && c.idx < best.idx)) {
          best = { idx: c.idx, pos: c.pos };
          bestD = dd;
        }
      }
      if (!best) return null;
      if (dist(enemy.pos, best.pos) > TACT_REACH_PX) return null;
      return { ref: best.idx, pos: { x: best.pos.x, y: best.pos.y }, hold: ENEMIES[enemy.kind].radius + CRYSTAL_HOLD_PAD_PX, victim: null, anchor: true, orbit: true };
    }
    case 3: {
      if (alive < 2) return null;
      const list = ctx.players.filter((p) => {
        if (p.status !== 'alive' || (ref !== null && p.id !== ref)) return false;
        const calling = (p.autoCall !== undefined && p.autoCall.ms > 0 && p.autoCall.icon !== 'gear') || (p.callMs > 0 && hpFrac(p) <= CRYSTAL_NEED_FRAC);
        return calling && isolated(ctx, p);
      });
      return victimCandidate(pickNearest(enemy, list), enemy);
    }
    case 4: {
      if (alive < 2) return null;
      const list = ctx.players.filter((p) => p.status === 'alive' && p.heart !== undefined && (ref === null || p.id === ref) && isolated(ctx, p));
      return victimCandidate(pickNearest(enemy, list), enemy);
    }
    case 5: {
      const w = ctx.world;
      if (!w || w.items.length === 0) return null;
      let best: { ref: number; pos: Vec2; value: number; dd: number } | null = null;
      for (const it of w.items) {
        if (ref !== null && it.ref !== ref) continue;
        const dd = dist(enemy.pos, it.pos);
        if (dd > TACT_REACH_PX) continue;
        // jamais se poster sur un objet tombé AUX PIEDS d'un joueur à terre (cœur rangé, équipement éparpillé) : le boss serait dans `DOWNED_THREAT_RADIUS` et le relevage
        // ralenti à ×0,35. En deçà de l'anneau de veille (GUARD_RING_PX) l'objet est laissé aux héros.
        if (ctx.players.some((p) => p.status === 'down' && dist(p.pos, it.pos) < GUARD_RING_PX)) continue;
        if (!best || it.value > best.value || (it.value === best.value && (dd < best.dd || (dd === best.dd && it.ref < best.ref)))) {
          best = { ref: it.ref, pos: it.pos, value: it.value, dd };
        }
      }
      if (!best) return null;
      return { ref: best.ref, pos: { x: best.pos.x, y: best.pos.y }, hold: 4, victim: null, anchor: true, orbit: false };
    }
    case 6: {
      if (alive < 2) return null;
      let best: PlayerState | null = null;
      let bestScore = Infinity;
      for (const p of ctx.players) {
        if (p.status !== 'alive' || (ref !== null && p.id !== ref) || p.invulnMs > 0 || !isolated(ctx, p)) continue;
        const f = hpFrac(p);
        const healer = alive >= 3 && HUNT_HEALER_BONUS > 0 && isHealerCharacter(p);
        if (f > HUNT_MAX_HP_FRAC && !healer) continue;
        const score = f - (healer ? HUNT_HEALER_BONUS : 0);
        if (score < bestScore || (score === bestScore && best && p.id < best.id)) {
          best = p;
          bestScore = score;
        }
      }
      return victimCandidate(best, enemy);
    }
    default:
      return null;
  }
}

/** Distance de tenue (px) d'une tactique d'ancre. */
function holdOf(kind: number, enemy: EnemyState): number {
  return kind === 1 ? GUARD_RING_PX : kind === 2 ? ENEMIES[enemy.kind].radius + CRYSTAL_HOLD_PAD_PX : 4;
}

/** Remet à zéro la mesure de perte de PV de la fenêtre (PV courants + cumul de normalisation par la difficulté). */
function markLoss(enemy: EnemyState): void {
  enemy.data.tactHpMark = enemy.hp;
  enemy.data.tactAdjMark = gd(enemy.data, 'tactAdj');
}

function cooldownKey(kind: number): string {
  return `tactCool${kind}`;
}

/** Abandonne le but courant : relâche `coolMs` pour cette tactique. */
function release(enemy: EnemyState, ctx: EnemyAIContext, coolMs: number): void {
  const d = enemy.data;
  const kind = gd(d, 'tactKind');
  if (kind >= 1 && kind <= 6) d[cooldownKey(kind)] = Math.max(gd(d, cooldownKey(kind)), coolMs);
  d.tactRef = 0;
  d.tactLockMs = 0;
  d.tactAgeMs = 0;
  d.tactTravelMs = 0;
  d.tactStuckMs = 0;
  d.tactLastSet = 0;
  if (gd(d, 'tactBreakMs') <= 0) setKind(enemy, ctx, 0);
}

// ───────────────────────────── Minuteries (tous les modes) ─────────────────────────────

/**
 * Minuteries et surveillance des tactiques : appelé à CHAQUE pas de `updateBoss` (tous les modes) d'un boss tactique avec une cible. Fait tourner l'échauffement, les relâches,
 * le délai de réaction et l'abandon de la veille, mesure la perte de PV (déstabilisation) et applique la déstabilisation en attente (`breakTactics`).
 */
export function tacticsTick(enemy: EnemyState, ctx: EnemyAIContext, dt: number): void {
  const d = enemy.data;
  if (gd(d, 'tactInit') === 0) {
    d.tactInit = 1;
    d.tactWarmMs = TACT_WARMUP_MS;
    markLoss(enemy);
    d.tactWinMs = 0;
  }
  d.tactWarmMs = Math.max(0, gd(d, 'tactWarmMs') - dt);
  for (let k = 1; k <= 6; k++) {
    const c = gd(d, cooldownKey(k));
    if (c > 0) d[cooldownKey(k)] = Math.max(0, c - dt);
  }
  d.tactLockMs = Math.max(0, gd(d, 'tactLockMs') - dt);
  const kind = gd(d, 'tactKind');
  if (kind >= 1 && kind <= 6) {
    // le budget ne compte que le temps POSTÉ près de l'ancre (ou la poursuite d'une victime) ; le trajet a son propre plafond
    const anchorKind = kind === 1 || kind === 2 || kind === 5;
    const arrived = !anchorKind || dist(enemy.pos, { x: gd(d, 'tactX'), y: gd(d, 'tactY') }) <= holdOf(kind, enemy) + TACT_ANCHOR_ARRIVE_PAD_PX;
    if (arrived) d.tactAgeMs = gd(d, 'tactAgeMs') + dt;
    else d.tactTravelMs = gd(d, 'tactTravelMs') + dt;
  }
  if (enemy.mode !== 'chase') {
    d.tactStuckMs = 0;
    d.tactLastSet = 0;
  }

  // joueurs à terre : délai de réaction, abandon après une chute trop longue
  let tracked: PlayerState | null = null;
  const giveUp = gd(d, 'tactGiveUp');
  for (const p of ctx.players) if (p.status === 'down' && p.id + 1 !== giveUp && (!tracked || p.id < tracked.id)) tracked = p;
  if (giveUp > 0) {
    const gp = playerById(ctx, giveUp - 1);
    if (!gp || gp.status !== 'down') d.tactGiveUp = 0;
  }
  if (tracked) {
    d.tactReactMs = gd(d, 'tactReactMs') + dt;
    if (gd(d, 'tactDownId') !== tracked.id + 1) {
      d.tactDownId = tracked.id + 1;
      d.tactDownMs = 0;
    } else {
      d.tactDownMs = gd(d, 'tactDownMs') + dt;
      if (d.tactDownMs >= GUARD_GIVEUP_MS) {
        d.tactGiveUp = tracked.id + 1;
        d.tactDownId = 0;
        d.tactDownMs = 0;
      }
    }
  } else {
    d.tactReactMs = 0;
    d.tactDownId = 0;
    d.tactDownMs = 0;
  }

  // déstabilisation par les dégâts (mesurée seulement quand un but est actif) : PV perdus NORMALISÉS (`combat.ts` accumule `tactAdj` = écart entre les PV retirés et les dégâts
  // équivalents « difficulté normal » : le seuil ne dépend donc jamais de la difficulté de l'attaquant)
  d.tactWinMs = gd(d, 'tactWinMs') + dt;
  const lost = gd(d, 'tactHpMark') - enemy.hp + (gd(d, 'tactAdj') - gd(d, 'tactAdjMark'));
  if (lost < 0) {
    markLoss(enemy);
  } else if (kind >= 1 && kind <= 6 && lost >= tacticBreakThreshold(enemy, aliveCount(ctx)) && gd(d, 'tactBreakMs') <= 0) {
    d.tactBreakMs = TACT_BREAK_COOL_MS;
    markLoss(enemy);
    d.tactWinMs = 0;
  }
  if (d.tactWinMs >= TACT_BREAK_WINDOW_MS) {
    d.tactWinMs = 0;
    markLoss(enemy);
  }

  // déstabilisation en cours : aucun but, code 7 ; à la fin, retour au code 0
  const breaking = gd(d, 'tactBreakMs');
  if (breaking > 0) {
    if (kind >= 1 && kind <= 6) {
      d.tactRef = 0;
      d.tactLockMs = 0;
      d.tactAgeMs = 0;
      d.tactTravelMs = 0;
      d.tactStuckMs = 0;
      d.tactLastSet = 0;
    }
    setKind(enemy, ctx, TACT_DAZED);
    d.tactBreakMs = Math.max(0, breaking - dt);
    if (d.tactBreakMs <= 0) setKind(enemy, ctx, 0);
  }
}

/** Cible suivie (victime) d'un boss tactique pendant un télégraphe : un joueur vivant, ou null. */
export function tacticVictim(enemy: EnemyState, ctx: EnemyAIContext): PlayerState | null {
  const kind = gd(enemy.data, 'tactKind');
  if (kind !== 3 && kind !== 4 && kind !== 6) return null;
  const p = playerById(ctx, gd(enemy.data, 'tactRef'));
  return p && p.status === 'alive' ? p : null;
}

// ───────────────────────────── Choix du but (mode 'chase') ─────────────────────────────

/**
 * But tactique du pas courant (mode 'chase' d'un boss tactique, APRÈS `tacticsTick`). Valide le but en cours (budget, référence, portée, blocage), laisse
 * `guardDowned` préempter, réévalue dans l'ordre de priorité quand il n'y a pas de but ou que le verrou est écoulé, puis publie `tactKind` / `tactX` / `tactY` pour le rendu.
 * Renvoie null : aucun but (comportement normal du boss).
 */
export function tacticsGoal(enemy: EnemyState, ctx: EnemyAIContext, dt: number): TacticalGoal | null {
  const d = enemy.data;
  const mask = gd(d, 'tact');
  if (gd(d, 'tactBreakMs') > 0 || gd(d, 'tactWarmMs') > 0) return null;
  const alive = aliveCount(ctx);
  let kind = gd(d, 'tactKind');
  let cur: Candidate | null = null;

  if (kind >= 1 && kind <= 6) {
    // blocage : un boss qui n'avance plus vers son ancre abandonne
    const anchorKind = kind === 1 || kind === 2 || kind === 5;
    if (anchorKind) {
      const ax = gd(d, 'tactX');
      const ay = gd(d, 'tactY');
      const hold = holdOf(kind, enemy);
      if (dist(enemy.pos, { x: ax, y: ay }) > hold + 12 && gd(d, 'tactLastSet') > 0) {
        const moved = Math.hypot(enemy.pos.x - gd(d, 'tactLastX'), enemy.pos.y - gd(d, 'tactLastY'));
        const expected = (ENEMIES[enemy.kind].speed * TACT_SPEED_MULT * dt) / 1000;
        d.tactStuckMs = moved < expected * 0.25 ? gd(d, 'tactStuckMs') + dt : Math.max(0, gd(d, 'tactStuckMs') - dt * 2);
      } else {
        d.tactStuckMs = 0;
      }
      d.tactLastX = enemy.pos.x;
      d.tactLastY = enemy.pos.y;
      d.tactLastSet = 1;
    }
    if (gd(d, 'tactStuckMs') > TACT_STUCK_MS) {
      release(enemy, ctx, tacticReliefMs(kind, alive) / 2);
      kind = 0;
    } else if (gd(d, 'tactTravelMs') > TACT_TRAVEL_MAX_MS) {
      release(enemy, ctx, tacticReliefMs(kind, alive) / 2);
      kind = 0;
    } else if (gd(d, 'tactAgeMs') >= tacticBudgetMs(kind, alive)) {
      release(enemy, ctx, tacticReliefMs(kind, alive));
      kind = 0;
    } else {
      cur = candidate(kind, enemy, ctx, gd(d, 'tactRef'), false);
      if (!cur) {
        release(enemy, ctx, 500);
        kind = 0;
      }
    }
  }

  // préemption : la veille d'un joueur à terre interrompt un autre but (jamais pendant sa relâche)
  if (cur && kind > 1 && gd(d, 'tactLockMs') > 0 && (mask & 1) !== 0 && gd(d, cooldownKey(1)) <= 0) {
    const g = candidate(1, enemy, ctx, null, true);
    if (g) {
      d[cooldownKey(kind)] = Math.max(gd(d, cooldownKey(kind)), tacticReliefMs(kind, alive) / 2);
      cur = g;
      kind = 1;
      acquire(enemy, ctx, 1, g);
    }
  }

  // réévaluation : pas de but, ou verrou écoulé
  if (!cur || gd(d, 'tactLockMs') <= 0) {
    for (let k = 1; k <= 6; k++) {
      if ((mask & (1 << (k - 1))) === 0 || gd(d, cooldownKey(k)) > 0) continue;
      const c = candidate(k, enemy, ctx, k === kind && cur ? cur.ref : null, k !== kind);
      if (!c) continue;
      if (k === kind && cur && c.ref === cur.ref) {
        d.tactLockMs = TACT_MIN_LOCK_MS;
        cur = c;
      } else {
        acquire(enemy, ctx, k, c);
        cur = c;
        kind = k;
      }
      break;
    }
  }

  if (!cur || kind < 1) return null;
  d.tactX = cur.pos.x;
  d.tactY = cur.pos.y;
  return { kind, pos: cur.pos, hold: cur.hold, victim: cur.victim, anchor: cur.anchor, orbit: cur.orbit };
}

function acquire(enemy: EnemyState, ctx: EnemyAIContext, kind: number, c: Candidate): void {
  const d = enemy.data;
  d.tactRef = c.ref;
  d.tactAgeMs = 0;
  d.tactTravelMs = 0;
  d.tactLockMs = TACT_MIN_LOCK_MS;
  d.tactStuckMs = 0;
  d.tactLastSet = 0;
  setKind(enemy, ctx, kind);
}

// ───────────────────────────── Confiscation (rapace) ─────────────────────────────

/** Objet confiscable sous un boss : référence (id × 4 + code), sorte, position. */
export interface SeizeObject {
  ref: number;
  kind: 'heart' | 'buff';
  pos: Vec2;
}

/**
 * Pas de la confiscation d'un boss « rapace » (appelé par la simulation APRÈS les ramassages des joueurs : un objet disputé n'est jamais confisqué) : un objet confiscable resté
 * sous le boss (distance <= rayon + `SEIZE_RADIUS_PAD_PX`) pendant `SEIZE_DWELL_MS` est rendu à la simulation (qui le retire et émet `itemSeized`). Plafond par salle,
 * délai entre deux confiscations, jamais pendant une déstabilisation.
 * @returns la référence de l'objet à confisquer, ou null
 */
export function seizeTick(enemy: EnemyState, dt: number, objects: readonly SeizeObject[]): number | null {
  const d = enemy.data;
  if ((gd(d, 'tact') & (1 << (tacticKindOf('seizeItems') - 1))) === 0) return null;
  d.tactSeizeCoolMs = Math.max(0, gd(d, 'tactSeizeCoolMs') - dt);
  const def = ENEMIES[enemy.kind];
  const cap = def && def.isMiniBoss ? SEIZE_MAX_MINI : SEIZE_MAX_BOSS;
  if (gd(d, 'tactSeizedCount') >= cap || gd(d, 'tactBreakMs') > 0) {
    d.tactSeizeMs = 0;
    d.tactSeizeRef = 0;
    return null;
  }
  const reach = (def ? def.radius : 10) + SEIZE_RADIUS_PAD_PX;
  let best: SeizeObject | null = null;
  let bestD = Infinity;
  for (const o of objects) {
    const dd = dist(enemy.pos, o.pos);
    if (dd > reach) continue;
    if (dd < bestD || (dd === bestD && best && o.ref < best.ref)) {
      best = o;
      bestD = dd;
    }
  }
  if (!best || gd(d, 'tactSeizeCoolMs') > 0) {
    d.tactSeizeMs = 0;
    d.tactSeizeRef = 0;
    return null;
  }
  if (gd(d, 'tactSeizeRef') !== best.ref + 1) {
    d.tactSeizeRef = best.ref + 1;
    d.tactSeizeMs = 0;
  }
  d.tactSeizeMs = gd(d, 'tactSeizeMs') + dt;
  if (d.tactSeizeMs < SEIZE_DWELL_MS) return null;
  d.tactSeizedCount = gd(d, 'tactSeizedCount') + 1;
  d.tactSeizeCoolMs = SEIZE_COOL_MS;
  d.tactSeizeMs = 0;
  d.tactSeizeRef = 0;
  return best.ref;
}
