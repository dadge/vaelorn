/**
 * PILOTE AUTOMATIQUE du mode démo (« attract mode ») : `GameState` → `ActionFrame`. Module PUR et DÉTERMINISTE (aucun Phaser, aucun
 * DOM, aucun `Math.random` / `Date.now` : mêmes entrées + même graine ⇒ mêmes frames).
 *
 * Il ne TRICHE PAS : il ne lit que l'état du jeu et ne produit que des `ActionFrame`, exactement comme un joueur (stick + boutons).
 * Le but n'est pas de finir le niveau mais de MONTRER du mouvement et des combats pendant ~30 s :
 *  - il AVANCE vers la sortie de la salle par un plus court chemin sur la grille de tuiles (murs, piliers, fosses et portes /
 *    blocs fermés évités ; chemin mis en cache, recalculé seulement quand le décor change ou périodiquement quand il poursuit
 *    un ennemi) ;
 *  - il ATTAQUE les ennemis à portée (mêlée : se place à portée et frappe quand l'arc touche ; distance : s'aligne sur un axe,
 *    garde ses distances et tire quand la ligne est dégagée) ; si la sortie exige de vaincre tous les ennemis (`clear`), ou quand
 *    la salle semble bloquée, il les chasse tous ;
 *  - il utilise le SPÉCIAL quand il est prêt et qu'un ennemi est dans sa zone ;
 *  - il ne RÉSOUT PAS les énigmes (portes fermées, leviers, plaques…) : si la sortie ne s'ouvre pas, il patrouille dans la salle
 *    (cibles aléatoires déterministes) puis retente la sortie ;
 *  - il se DÉGAGE s'il ne progresse plus pendant ~2 s (cible intermédiaire aléatoire, ennemi inatteignable ignoré un moment) ;
 *  - mort d'équipe : la simulation redémarre la salle toute seule (comme en jeu normal) ; le pilote se réinitialise et repart.
 *
 * Les briques de chemin viennent de `src/testing/pathfinding.ts` (module pur de ~340 lignes, sans aucun code de test lourd) ; la
 * logique de combat est une version allégée de `src/testing/botBrain.ts` (sans `BotRun` ni `PathFollower`, qui ne seraient pas
 * embarqués proprement dans le bundle de production).
 */
import { SIM_STEP_MS, TILE } from '../core/constants';
import { getCharacter } from '../core/characters';
import { projectileHitsWall, segmentBlocked, type PixelRect } from '../core/collision';
import { enemyRadius, meleeTargets } from '../core/combat';
import { dirFromVec, dist, pointInTileRect } from '../core/geometry';
import type { RoomGrid } from '../core/grid';
import { createRng, nextRandom, type RngHolder } from '../core/rng';
import type { ActionFrame, EnemyState, GameState, PlayerId, PlayerState, RoomDef, SpecialDef, TileXY, Vec2 } from '../core/types';
import {
  buildNavMap,
  findPath,
  isPassable,
  nearestPassableTile,
  reachableTiles,
  sweepClear,
  tileCenterOf,
  tileOfPx,
  type NavMap,
} from '../testing/pathfinding';

// ───────────────────────────── Réglages ─────────────────────────────

/** Amplitude d'une entrée de « rotation sur place » : change le `facing` sans déplacer visiblement (même valeur que les bots de test). */
const NUDGE = 0.04;
/** Distance (px) en dessous de laquelle on tente d'abord la ligne droite (si libre). */
const DIRECT_MAX_PX = 200;
/** Distance (px) d'atteinte d'un point de passage intermédiaire. */
const WAYPOINT_REACH_PX = 3;
/** Nombre de pas entre deux évaluations du lissage / de la ligne droite. */
const SMOOTH_EVERY_TICKS = 5;
/** Distance (px) d'arrivée d'un but précis (sortie, patrouille). */
const ARRIVE_PX = 3;
/** Rayon (px) de prise de cible d'un héros de mêlée / maximum pour un héros à distance, quand rien n'impose de tout chasser. */
const ENGAGE_MELEE_PX = 120;
const ENGAGE_RANGED_MAX_PX = 180;
/** Distance (px) en dessous de laquelle un héros à distance recule pour garder ses distances. */
const KITE_DISTANCE_PX = 48;
/** Période (ms) de replanification du chemin vers un ennemi (il bouge) ; un but fixe n'est replanifié que si le décor change. */
const CHASE_REPLAN_MS = 250;
/** Durée (ms) pendant laquelle un ennemi inatteignable est ignoré. */
const SKIP_ENEMY_MS = 2500;
/** Durée (ms de jeu) sans progresser (hors combat et attente à la sortie) avant de se dégager, déplacement minimal (px) qui compte comme « progresser », durée (ms) d'un détour. */
const STUCK_TRIGGER_MS = 1800;
const STUCK_MIN_MOVE_PX = 8;
const DETOUR_MS = 2500;
/** Temps (ms) passé dans la zone de sortie fermée avant de patrouiller ; durée (ms) d'une patrouille avant de retenter la sortie. */
const EXIT_WAIT_MS = 1200;
const PATROL_MS = 6500;
/** Durée maximale (ms) vers UN point de patrouille avant d'en choisir un autre. */
const PATROL_LEG_MS = 4000;
/** Distance (en tuiles, Tchebychev) minimale / maximale d'un point de patrouille ou de détour. */
const PATROL_MIN_TILES = 4;
const DETOUR_MIN_TILES = 2;
const DETOUR_MAX_TILES = 6;

// ───────────────────────────── Types ─────────────────────────────

/**
 * Ce que le pilote lit du monde en plus de `GameState` : la grille et la définition de la salle COURANTES et les solides
 * dynamiques (portes fermées, blocs). `GameSimulation` satisfait directement cette interface.
 */
export interface PilotWorld {
  readonly grid: RoomGrid;
  readonly room: RoomDef;
  solidRects(): PixelRect[];
}

export interface DemoPilotOptions {
  /** Joueur piloté (défaut 0). */
  playerId?: PlayerId;
  /** Graine du générateur du pilote (patrouilles, détours ; défaut 1). Distincte de celle de la simulation. */
  seed?: number;
}

/** Diagnostics du pilote (tests, debug). */
export interface PilotStats {
  /** Nombre de chemins calculés. */
  plans: number;
  /** Blocages détectés (détours déclenchés). */
  stuck: number;
  /** Patrouilles lancées (sortie fermée ou inaccessible). */
  patrols: number;
  /** Pas pendant lesquels le pilote a attaqué. */
  attackSteps: number;
  /** Spéciaux déclenchés. */
  specials: number;
}

type Mode = 'exit' | 'patrol';
type FollowStatus = 'arrived' | 'moving' | 'unreachable';

interface FollowResult {
  status: FollowStatus;
  vec: Vec2;
}

const IDLE: Readonly<ActionFrame> = Object.freeze({ moveX: 0, moveY: 0, attack: false, interact: false, revive: false, special: false, call: false });

function frame(partial: Partial<ActionFrame> = {}): ActionFrame {
  return { moveX: 0, moveY: 0, attack: false, interact: false, revive: false, special: false, call: false, ...partial };
}

function unit(v: Vec2): Vec2 {
  const l = Math.hypot(v.x, v.y);
  return l < 1e-9 ? { x: 0, y: 0 } : { x: v.x / l, y: v.y / l };
}

/** Vecteur de mouvement (norme ≤ 1) de `from` vers `to` ; `slow` réduit la norme pour ne pas dépasser la cible dans le pas. */
function moveVector(from: Vec2, to: Vec2, stepDist: number, slow: boolean): Vec2 {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-9) return { x: 0, y: 0 };
  const amp = slow ? Math.min(1, d / Math.max(1e-6, stepDist)) : 1;
  return { x: (dx / d) * amp, y: (dy / d) * amp };
}

// ───────────────────────────── Pilote ─────────────────────────────

export class DemoPilot {
  private readonly world: PilotWorld;
  private readonly id: PlayerId;
  private readonly rng: RngHolder;
  readonly stats: PilotStats = { plans: 0, stuck: 0, patrols: 0, attackSteps: 0, specials: 0 };

  // salle courante
  private roomId = '';
  private lastRoomElapsed = Infinity;
  private nav: NavMap | null = null;
  private solids: PixelRect[] = [];
  private solidsKey = '';
  /** Tuiles atteignables depuis la tuile du héros (mis en cache par décor + tuile de départ). */
  private reach: Uint8Array | null = null;
  private reachKey = '';

  // mode de navigation
  private mode: Mode = 'exit';
  private modeSinceMs = 0;
  private exitWaitMs = 0;
  private patrolGoal: Vec2 | null = null;
  private patrolLegSinceMs = 0;

  // suivi de chemin
  private path: Vec2[] = [];
  private pathIdx = 0;
  private plannedAtMs = -Infinity;
  private plannedGoal: Vec2 | null = null;
  private plannedKey = '';
  private failedKey = '';
  private failedAtMs = -Infinity;
  private lastEvalTick = -1000;
  private lastDirectClear = false;
  private lastSmoothTick = -1000;

  // combat
  private targetId: number | null = null;
  private readonly skipUntil = new Map<number, number>();
  private lastSpecial = false;

  // déblocage
  private watchPos: Vec2 | null = null;
  private watchMs = 0;
  private detour: { goal: Vec2; untilMs: number } | null = null;

  /**
   * @param world monde piloté (la simulation : `sim`)
   * @param opts joueur et graine
   */
  constructor(world: PilotWorld, opts: DemoPilotOptions = {}) {
    this.world = world;
    this.id = opts.playerId ?? 0;
    this.rng = createRng(opts.seed ?? 1);
  }

  // ───────────── Point d'entrée ─────────────

  /**
   * Calcule les entrées du pas courant à partir de l'état du jeu.
   * @param state état courant de la simulation (lecture seule)
   * @returns une frame d'entrées neuve (le pilote n'en garde aucune référence)
   */
  decide(state: GameState): ActionFrame {
    const p = state.players[this.id];
    this.syncRoom(state);
    if (!p || p.status !== 'alive' || state.phase !== 'playing') {
      this.lastSpecial = false;
      this.watchPos = null;
      return { ...IDLE };
    }
    const now = state.timeMs;
    const enemies = state.room.enemies.filter((e) => !e.dead && e.hp > 0);
    this.refreshSolids();

    let out: ActionFrame | null = null;

    // 1. détour (déblocage) : prioritaire sur tout, sauf s'il vient de se terminer
    if (this.detour) {
      if (now >= this.detour.untilMs) {
        this.detour = null;
      } else {
        const r = this.follow(p, state, this.detour.goal, undefined, Infinity);
        if (r.status === 'moving') out = frame({ moveX: r.vec.x, moveY: r.vec.y });
        else this.detour = null; // arrivé ou inaccessible
      }
    }

    // 2. combat
    if (!out) {
      const target = this.pickTarget(p, enemies, now);
      if (target) out = this.engage(p, state, target, enemies, now);
    }

    // 3. navigation (sortie / patrouille)
    if (!out) out = this.navigate(p, state, now);

    // 4. spécial (se superpose : bouton distinct)
    this.applySpecial(p, enemies, out);

    // 5. déblocage
    this.watchStuck(p, out, now);

    if (out.attack) this.stats.attackSteps++;
    return out;
  }

  /** Oublie tout (nouvelle partie / nouvelle salle) : garde les statistiques et le générateur. */
  reset(): void {
    this.nav = null;
    this.solidsKey = '';
    this.mode = 'exit';
    this.modeSinceMs = 0;
    this.exitWaitMs = 0;
    this.patrolGoal = null;
    this.patrolLegSinceMs = 0;
    this.reach = null;
    this.reachKey = '';
    this.resetPath();
    this.failedKey = '';
    this.failedAtMs = -Infinity;
    this.targetId = null;
    this.skipUntil.clear();
    this.lastSpecial = false;
    this.watchPos = null;
    this.watchMs = 0;
    this.detour = null;
  }

  // ───────────── Salle et décor ─────────────

  /** Détecte l'entrée dans une salle (suivante ou redémarrage après mort d'équipe) et réinitialise le pilote. */
  private syncRoom(state: GameState): void {
    const elapsed = state.room.elapsedMs;
    if (state.room.roomId !== this.roomId || elapsed < this.lastRoomElapsed) {
      this.roomId = state.room.roomId;
      this.reset();
      this.modeSinceMs = state.timeMs;
    }
    this.lastRoomElapsed = elapsed;
  }

  /** Recalcule les solides dynamiques ; reconstruit le plan de navigation seulement quand ils changent (porte qui s'ouvre, bloc). */
  private refreshSolids(): void {
    const solids = this.world.solidRects();
    let key = '';
    for (const r of solids) key += `${r.x.toFixed(1)},${r.y.toFixed(1)},${r.w},${r.h}|`;
    this.solids = solids;
    if (!this.nav || key !== this.solidsKey) {
      this.solidsKey = key;
      this.nav = buildNavMap(this.world.grid, solids);
      this.reach = null;
    }
  }

  private resetPath(): void {
    this.path = [];
    this.pathIdx = 0;
    this.plannedAtMs = -Infinity;
    this.plannedGoal = null;
    this.plannedKey = '';
    this.lastEvalTick = -1000;
    this.lastDirectClear = false;
    this.lastSmoothTick = -1000;
  }

  // ───────────── Suivi de chemin ─────────────

  /**
   * Un pas vers `goal`. `near` : mode « près de » (arrive à ≤ near px, toute tuile à portée est un but valide) ; sinon arrivée précise.
   * `replanMs` : période de replanification (Infinity = seulement si le décor ou le but change).
   */
  private follow(p: PlayerState, state: GameState, goal: Vec2, near: number | undefined, replanMs: number): FollowResult {
    const nav = this.nav as NavMap;
    const now = state.timeMs;
    const tick = state.tick;
    const stepDist = (getCharacter(p.characterId).speed * SIM_STEP_MS) / 1000;
    const d = dist(p.pos, goal);
    const arriveR = near !== undefined ? near : ARRIVE_PX;
    if (d <= arriveR) return { status: 'arrived', vec: { x: 0, y: 0 } };

    // ligne droite libre ?
    if (d <= DIRECT_MAX_PX) {
      let aim = goal;
      if (near !== undefined && d > 1e-6) {
        const k = Math.max(0, (d - near * 0.85) / d);
        aim = { x: p.pos.x + (goal.x - p.pos.x) * k, y: p.pos.y + (goal.y - p.pos.y) * k };
      }
      if (tick - this.lastEvalTick >= SMOOTH_EVERY_TICKS) {
        this.lastEvalTick = tick;
        this.lastDirectClear = sweepClear(this.world.grid, this.solids, p.pos, aim);
      }
      if (this.lastDirectClear) {
        this.path = [];
        return { status: 'moving', vec: moveVector(p.pos, aim, stepDist, near === undefined) };
      }
    }

    // chemin planifié (mis en cache)
    const needPlan =
      this.path.length === 0 ||
      this.plannedKey !== this.solidsKey ||
      now - this.plannedAtMs >= replanMs ||
      (this.plannedGoal !== null && dist(goal, this.plannedGoal) > 12);
    if (needPlan) {
      const failKey = `${this.solidsKey}|${Math.round(goal.x / 8)},${Math.round(goal.y / 8)},${near ?? -1}|${tileOfPx(p.pos).join(',')}`;
      if (this.failedKey === failKey && now - this.failedAtMs < 600) return { status: 'unreachable', vec: { x: 0, y: 0 } };
      if (!this.plan(p, goal, near, now, nav)) {
        this.failedKey = failKey;
        this.failedAtMs = now;
        this.path = [];
        return { status: 'unreachable', vec: { x: 0, y: 0 } };
      }
    }

    const last = this.path.length - 1;
    while (this.pathIdx < last && dist(p.pos, this.path[this.pathIdx]) < WAYPOINT_REACH_PX) this.pathIdx++;
    if (this.pathIdx >= last && dist(p.pos, this.path[last]) < 1.5) return { status: 'arrived', vec: { x: 0, y: 0 } };
    if (this.pathIdx < last && tick - this.lastSmoothTick >= SMOOTH_EVERY_TICKS) {
      this.lastSmoothTick = tick;
      for (let j = Math.min(this.pathIdx + 6, last); j > this.pathIdx; j--) {
        if (sweepClear(this.world.grid, this.solids, p.pos, this.path[j])) {
          this.pathIdx = j;
          break;
        }
      }
    }
    return { status: 'moving', vec: moveVector(p.pos, this.path[this.pathIdx], stepDist, this.pathIdx >= last && near === undefined) };
  }

  /** Calcule le chemin (Dijkstra 8-connexe sur la grille de tuiles) ; false si le but est inaccessible. */
  private plan(p: PlayerState, goal: Vec2, near: number | undefined, now: number, nav: NavMap): boolean {
    this.stats.plans++;
    const start = tileOfPx(p.pos);
    let isGoal: (tx: number, ty: number) => boolean;
    let goalTilePrecise = false;
    if (near !== undefined) {
      const r = Math.max(2, near - 1.5);
      isGoal = (tx, ty) => Math.hypot((tx + 0.5) * TILE - goal.x, (ty + 0.5) * TILE - goal.y) <= r;
    } else {
      let gt = tileOfPx(goal);
      const passable = isPassable(nav, gt[0], gt[1]);
      if (!passable) gt = nearestPassableTile(nav, gt) ?? gt;
      goalTilePrecise = passable;
      const gx = gt[0];
      const gy = gt[1];
      isGoal = (tx, ty) => tx === gx && ty === gy;
    }
    const tiles = findPath(nav, start, isGoal);
    if (!tiles) return false;
    const wps = tiles.slice(1).map((t) => tileCenterOf(t));
    if (near !== undefined) {
      if (wps.length === 0) wps.push(tileCenterOf(tiles[0]));
    } else if (goalTilePrecise) {
      if (wps.length === 0) wps.push({ x: goal.x, y: goal.y });
      else wps[wps.length - 1] = { x: goal.x, y: goal.y };
    } else if (wps.length === 0) {
      wps.push(tileCenterOf(tiles[0]));
    }
    this.path = wps;
    this.pathIdx = 0;
    this.plannedAtMs = now;
    this.plannedGoal = { x: goal.x, y: goal.y };
    this.plannedKey = this.solidsKey;
    this.lastSmoothTick = -1000;
    return true;
  }

  // ───────────── Navigation : sortie, patrouille ─────────────

  private navigate(p: PlayerState, state: GameState, now: number): ActionFrame {
    const room = this.world.room;

    if (this.mode === 'patrol' && now - this.modeSinceMs >= PATROL_MS) this.setMode('exit', now);

    if (this.mode === 'exit') {
      if (pointInTileRect(p.pos, room.exit.rect)) {
        // dans la zone de sortie : attend qu'elle s'ouvre (ou que la salle se termine), puis patrouille
        this.exitWaitMs += SIM_STEP_MS;
        if (this.exitWaitMs >= EXIT_WAIT_MS) this.setMode('patrol', now);
        return frame();
      }
      this.exitWaitMs = 0;
      const goalTile = this.exitGoalTile(p, room);
      if (goalTile) {
        const r = this.follow(p, state, tileCenterOf(goalTile), undefined, Infinity);
        if (r.status === 'moving') return frame({ moveX: r.vec.x, moveY: r.vec.y });
        if (r.status === 'arrived') return frame();
      }
      // sortie inaccessible (porte fermée…) : patrouille ; un décor qui change la rendra peut-être accessible
      this.setMode('patrol', now);
    }

    // patrouille : cibles aléatoires déterministes
    if (!this.patrolGoal || now - this.patrolLegSinceMs >= PATROL_LEG_MS) this.pickPatrolGoal(p, now);
    if (this.patrolGoal) {
      const r = this.follow(p, state, this.patrolGoal, undefined, Infinity);
      if (r.status === 'moving') return frame({ moveX: r.vec.x, moveY: r.vec.y });
      this.patrolGoal = null; // arrivé ou inaccessible : une autre cible au prochain pas
    }
    return frame();
  }

  /** Tuiles atteignables depuis la tuile du héros (plan de navigation courant), mises en cache tant que ni le décor ni la tuile ne changent. */
  private reachable(p: PlayerState): Uint8Array {
    const t = tileOfPx(p.pos);
    const key = `${this.solidsKey}|${t[0]},${t[1]}`;
    if (!this.reach || key !== this.reachKey) {
      this.reach = reachableTiles(this.nav as NavMap, t);
      this.reachKey = key;
    }
    return this.reach;
  }

  private tileReached(reach: Uint8Array, tx: number, ty: number): boolean {
    const nav = this.nav as NavMap;
    return tx >= 0 && ty >= 0 && tx < nav.width && ty < nav.height && reach[ty * nav.width + tx] === 1;
  }

  /** L'ennemi est-il atteignable (sa tuile ou une tuile voisine est accessible) ? Un ennemi volant au-dessus d'une fosse compte par ses voisines. */
  private enemyReachable(reach: Uint8Array, e: EnemyState): boolean {
    const t = tileOfPx(e.pos);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (this.tileReached(reach, t[0] + dx, t[1] + dy)) return true;
    return false;
  }

  private setMode(mode: Mode, now: number): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.modeSinceMs = now;
    this.exitWaitMs = 0;
    this.patrolGoal = null;
    this.resetPath();
    if (mode === 'patrol') this.stats.patrols++;
  }

  /** Tuile atteignable de la zone de sortie la plus proche de son centre (null si aucune : porte fermée, zone isolée). */
  private exitGoalTile(p: PlayerState, room: RoomDef): TileXY | null {
    const reach = this.reachable(p);
    const r = room.exit.rect;
    const cx = r.x + (r.w - 1) / 2;
    const cy = r.y + (r.h - 1) / 2;
    let best: TileXY | null = null;
    let bestD = Infinity;
    for (let ty = r.y; ty < r.y + r.h; ty++) {
      for (let tx = r.x; tx < r.x + r.w; tx++) {
        if (!this.tileReached(reach, tx, ty)) continue;
        const d = Math.hypot(tx - cx, ty - cy);
        if (d < bestD) {
          bestD = d;
          best = [tx, ty];
        }
      }
    }
    return best;
  }

  /** Tuiles atteignables à une distance (Tchebychev) de `[minTiles, maxTiles]` de la position du joueur. */
  private reachableCandidates(p: PlayerState, minTiles: number, maxTiles: number): TileXY[] {
    const nav = this.nav as NavMap;
    const start = tileOfPx(p.pos);
    const seen = this.reachable(p);
    const out: TileXY[] = [];
    for (let ty = 0; ty < nav.height; ty++) {
      for (let tx = 0; tx < nav.width; tx++) {
        if (seen[ty * nav.width + tx] !== 1) continue;
        const c = Math.max(Math.abs(tx - start[0]), Math.abs(ty - start[1]));
        if (c >= minTiles && c <= maxTiles) out.push([tx, ty]);
      }
    }
    return out;
  }

  private pickPatrolGoal(p: PlayerState, now: number): void {
    this.patrolLegSinceMs = now;
    this.patrolGoal = null;
    const cands = this.reachableCandidates(p, PATROL_MIN_TILES, 64);
    if (cands.length === 0) return;
    const t = cands[Math.floor(nextRandom(this.rng) * cands.length) % cands.length];
    this.patrolGoal = tileCenterOf(t);
    this.resetPath();
  }

  // ───────────── Combat ─────────────

  /** Rayon de prise de cible : illimité si la sortie exige de tout vaincre ou en patrouille (la salle semble bloquée). */
  private engageRadius(p: PlayerState): number {
    const room = this.world.room;
    if (this.mode === 'patrol' || room.exit.requires.includes('clear')) return Infinity;
    const atk = getCharacter(p.characterId).attack;
    return atk.kind === 'melee' ? ENGAGE_MELEE_PX : Math.min(ENGAGE_RANGED_MAX_PX, atk.range * 0.85);
  }

  private pickTarget(p: PlayerState, enemies: readonly EnemyState[], now: number): EnemyState | null {
    if (enemies.length === 0) {
      this.targetId = null;
      return null;
    }
    const radius = this.engageRadius(p);
    const reach = this.reachable(p);
    const cands: { e: EnemyState; d: number }[] = [];
    for (const e of enemies) {
      const skip = this.skipUntil.get(e.id);
      if (skip !== undefined && skip > now) continue;
      const d = dist(p.pos, e.pos);
      if (d > radius) continue;
      if (!this.enemyReachable(reach, e)) continue; // derrière une porte fermée, un mur, une fosse : inutile de chercher un chemin
      cands.push({ e, d });
    }
    if (cands.length === 0) {
      this.targetId = null;
      return null;
    }
    cands.sort((a, b) => a.d - b.d || a.e.id - b.e.id);
    // fidélité à la cible précédente si elle n'est pas beaucoup plus loin que la meilleure
    const sticky = cands.findIndex((c) => c.e.id === this.targetId);
    const chosen = sticky > 0 && cands[sticky].d <= cands[0].d * 1.3 + 8 ? cands[sticky] : cands[0];
    this.targetId = chosen.e.id;
    return chosen.e;
  }

  private engage(p: PlayerState, state: GameState, e: EnemyState, enemies: readonly EnemyState[], now: number): ActionFrame | null {
    const atk = getCharacter(p.characterId).attack;
    const res = atk.kind === 'melee' ? this.engageMelee(p, state, e, enemies) : this.engageRanged(p, state, e);
    if (!res) this.skipUntil.set(e.id, now + SKIP_ENEMY_MS);
    return res;
  }

  private canMeleeHit(p: PlayerState, list: readonly EnemyState[], dir: PlayerState['facing']): boolean {
    return meleeTargets(p, list, this.world.grid, this.solids, dir).length > 0;
  }

  private engageMelee(p: PlayerState, state: GameState, e: EnemyState, enemies: readonly EnemyState[]): ActionFrame | null {
    const atk = getCharacter(p.characterId).attack;
    const reach = Math.max(6, atk.range + enemyRadius(e) - 3);
    const d = dist(p.pos, e.pos);
    const delta = { x: e.pos.x - p.pos.x, y: e.pos.y - p.pos.y };
    const wall = segmentBlocked(p.pos, e.pos, this.world.grid, this.solids);

    if (d <= reach && !wall) {
      if (this.canMeleeHit(p, [e], p.facing)) return frame({ attack: true });
      const v = unit(delta);
      if (this.canMeleeHit(p, [e], dirFromVec(v, p.facing))) return frame({ moveX: v.x * NUDGE, moveY: v.y * NUDGE, attack: true });
      // dans la portée mais l'arc ne touche pas : on se rapproche un peu
    }
    const r = this.follow(p, state, e.pos, Math.max(8, reach * 0.9), CHASE_REPLAN_MS);
    if (r.status === 'unreachable') return null;
    if (r.status === 'arrived') {
      if (wall) return null; // arrivé mais un mur nous sépare
      const v = unit(delta);
      return frame({ moveX: v.x * NUDGE, moveY: v.y * NUDGE, attack: this.canMeleeHit(p, [e], dirFromVec(v, p.facing)) });
    }
    const dir = dirFromVec(r.vec, p.facing);
    return frame({ moveX: r.vec.x, moveY: r.vec.y, attack: this.canMeleeHit(p, enemies, dir) });
  }

  /** Un projectile de rayon `radius` peut-il aller de `a` à `b` sans toucher mur, pilier, porte fermée ni bloc (les fosses ne l'arrêtent pas) ? */
  private shotClear(a: Vec2, b: Vec2, radius: number): boolean {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.ceil(len / 2.5));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      if (projectileHitsWall({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, radius, this.world.grid, this.solids)) return false;
    }
    return true;
  }

  private engageRanged(p: PlayerState, state: GameState, e: EnemyState): ActionFrame | null {
    const atk = getCharacter(p.characterId).attack;
    const pr = atk.projectile ? atk.projectile.radius : 3;
    const tol = Math.max(2, enemyRadius(e) + pr - 1.5);
    const maxShot = atk.range * 0.85;
    const stepDist = (getCharacter(p.characterId).speed * SIM_STEP_MS) / 1000;
    const dx = e.pos.x - p.pos.x;
    const dy = e.pos.y - p.pos.y;
    const horiz = Math.abs(dy) <= Math.abs(dx);
    const perp = horiz ? dy : dx;
    const along = horiz ? dx : dy;
    const los = this.shotClear(p.pos, e.pos, pr);

    if (los && Math.abs(perp) <= tol && Math.abs(along) <= maxShot) {
      // aligné, ligne dégagée, à portée : on tire en se tournant sur place
      const s = along >= 0 ? 1 : -1;
      return frame(horiz ? { moveX: s * NUDGE, attack: true } : { moveY: s * NUDGE, attack: true });
    }
    if (!los) {
      // pas de ligne de tir : on s'approche ; dès qu'elle se dégage, la branche de tir ci-dessus reprend
      const r = this.follow(p, state, e.pos, 14, CHASE_REPLAN_MS);
      if (r.status !== 'moving') return null;
      return frame({ moveX: r.vec.x, moveY: r.vec.y });
    }
    // ligne dégagée : on s'aligne (axe perpendiculaire) et on règle la distance (axe du tir)
    const s = along >= 0 ? 1 : -1;
    let vAlong = 0;
    if (Math.abs(along) > maxShot * 0.9) vAlong = s;
    else if (Math.abs(along) < KITE_DISTANCE_PX) vAlong = -s;
    let vPerp = 0;
    if (Math.abs(perp) > tol * 0.5) vPerp = Math.max(-1, Math.min(1, perp / Math.max(1e-6, stepDist)));
    const v = horiz ? { x: vAlong, y: vPerp } : { x: vPerp, y: vAlong };
    const n = Math.hypot(v.x, v.y);
    if (n < 1e-6) return frame(horiz ? { moveX: s } : { moveY: s });
    const k = n > 1 ? 1 / n : 1;
    return frame({ moveX: v.x * k, moveY: v.y * k });
  }

  // ───────────── Spécial ─────────────

  /** Spéciaux qui visent devant le héros (cône, éventail, ruée, nova décalée) : il faut lui faire face. */
  private static isDirectional(kind: SpecialDef['kind']): boolean {
    return kind === 'fireNova' || kind === 'arrowFan' || kind === 'dash' || kind === 'smash';
  }

  /**
   * Déclenche le spécial quand il est prêt et qu'un ennemi est dans sa zone (avec ligne de vue ; face à lui pour les spéciaux
   * directionnels). Le bouton est « pulsé » : appuyé UN pas, relâché le suivant (la simulation détecte le front montant).
   */
  private applySpecial(p: PlayerState, enemies: readonly EnemyState[], out: ActionFrame): void {
    const def = getCharacter(p.characterId).special;
    let want = false;
    if (def && p.specialCooldownMs <= 0 && enemies.length > 0) {
      const directional = DemoPilot.isDirectional(def.kind);
      const reachPx = def.kind === 'fireNova' || def.kind === 'arrowFan' ? def.range : Math.max(def.radius, def.kind === 'dash' ? def.range * 0.8 : 0) + 8;
      for (const e of enemies) {
        const d = dist(p.pos, e.pos);
        if (d > reachPx + enemyRadius(e)) continue;
        if (def.kind === 'dash' && d < 20) continue; // déjà au contact : la ruée ne servirait à rien
        if (segmentBlocked(p.pos, e.pos, this.world.grid, this.solids)) continue;
        if (directional && dirFromVec({ x: e.pos.x - p.pos.x, y: e.pos.y - p.pos.y }, p.facing) !== p.facing) continue;
        want = true;
        break;
      }
    }
    if (this.lastSpecial) {
      this.lastSpecial = false; // relâche : le prochain appui sera un nouveau front montant
      out.special = false;
    } else if (want) {
      this.lastSpecial = true;
      out.special = true;
      this.stats.specials++;
    }
  }

  // ───────────── Déblocage ─────────────

  /**
   * Si le héros ne progresse plus (moins de `STUCK_MIN_MOVE_PX` en ~2 s) alors qu'il ne combat pas et n'attend pas à la sortie
   * (mur, pilier, ennemi inaccessible, aller-retour…), il ignore sa cible un moment et part vers un point intermédiaire aléatoire
   * (déterministe) avant de reprendre son objectif.
   */
  private watchStuck(p: PlayerState, out: ActionFrame, now: number): void {
    const exempt = out.attack || p.specialAnimMs > 0 || pointInTileRect(p.pos, this.world.room.exit.rect);
    if (exempt || !this.watchPos || dist(p.pos, this.watchPos) >= STUCK_MIN_MOVE_PX) {
      this.watchPos = { x: p.pos.x, y: p.pos.y };
      this.watchMs = 0;
      return;
    }
    this.watchMs += SIM_STEP_MS;
    if (this.watchMs < STUCK_TRIGGER_MS) return;
    this.watchMs = 0;
    this.stats.stuck++;
    if (this.targetId !== null) this.skipUntil.set(this.targetId, now + SKIP_ENEMY_MS * 2);
    this.resetPath();
    this.failedKey = '';
    const cands = this.reachableCandidates(p, DETOUR_MIN_TILES, DETOUR_MAX_TILES);
    if (cands.length > 0) {
      const t = cands[Math.floor(nextRandom(this.rng) * cands.length) % cands.length];
      this.detour = { goal: tileCenterOf(t), untilMs: now + DETOUR_MS };
    }
  }
}
