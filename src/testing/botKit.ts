/**
 * BOTKIT — bibliothèque de bots de test qui pilotent la VRAIE simulation (`GameSimulation`) en produisant des
 * `ActionFrame`, pour prouver qu'un niveau est terminable (à 1, 2, 3 ou 4 joueurs) sans rien simuler à côté.
 *
 * Aucun Phaser, aucun DOM, aucun `Math.random`/`Date.now` : mêmes options + même seed + mêmes scripts ⇒ même partie.
 *
 * ── Vue d'ensemble ──
 *  - `BotRun` : une partie (simulation + un `BotPlayer` par joueur). `run.stepOnce()` calcule la frame de chaque joueur
 *    (script, sinon comportements de fond) et avance d'un pas fixe. `runUntil(run, cond, maxMs)` boucle jusqu'à une condition.
 *  - Scripts PAR JOUEUR, exécutés en parallèle : chaque joueur a une file d'actions (`run.queue(id, ...)`,
 *    `run.queueForSlot(slot, ...)` qui replie le slot sur le joueur `slot % nbJoueurs` comme le jeu). Les actions
 *    (`goTo`, `standOn`, `pressInteract`, `pushBlock`, `attackUntilClear`, `pullLever`, `useKey`… voir `botActions.ts`) sont des
 *    machines à états pas à pas, sans promesses. En solo, les files des 4 slots s'ajoutent bout à bout dans l'ordre d'appel.
 *  - Comportements de FOND (par défaut activés) quand un joueur n'a pas d'action prioritaire : auto-combat (mêlée au contact,
 *    distance en s'alignant), auto-relevage d'un allié à terre, regroupement, esquive simple (voir `BackgroundOptions`).
 *  - Scripts de niveau : `roomScript(roomId, build)` + `runLevelScripts(run, scripts)` rejouent le script de chaque salle (et le
 *    reconstruisent après une défaite collective), avec un budget de temps, et renvoient un `LevelRunResult` (statistiques,
 *    message d'échec avec diagnostic).
 *  - Statistiques (`run.stats`, `formatStats(run)`) : temps de jeu simulé, nombre de fois à terre par joueur, PV perdus,
 *    relevages réussis, défaites collectives, par salle.
 *  - Diagnostic (`run.diagnose(raison)`, `diagnoseRun`) : rapport texte (salle, joueurs, ennemis, mécanismes, objectifs, derniers
 *    événements) à joindre aux messages d'échec (`expectUntil` le fait automatiquement).
 *
 * ── Exemple ──
 * ```ts
 * const run = new BotRun(level, { playerCount: 2 });
 * run.queue(0, goTo(run.mechTile('pa')), standOn(run.mechTile('pa'), { until: conds.mechActive('door') }));
 * run.queue(1, goTo(run.mechTile('pb')), standOn(run.mechTile('pb'), { until: conds.mechActive('door') }));
 * expectUntil(run, conds.mechActive('door'), 20000, 'la porte doit s’ouvrir');
 * ```
 *
 * Les nombres sont des pixels « monde » (1 tuile = 16 px) et des millisecondes de TEMPS DE JEU (pas de temps réel).
 */
import { SIM_STEP_MS, TILE } from '../core/constants';
import { CHARACTER_IDS } from '../core/characters';
import { tileCenter } from '../core/geometry';
import {
  createRoomMechanisms,
  isMechanismSolved,
  isRequirementMet,
  requiredPushers,
  type PixelRect,
} from '../core/mechanisms';
import { isObjectiveDone, isZoneOccupied } from '../core/objectives';
import { resolveSlot } from '../core/slots';
import { createSimulation, GameSimulation } from '../core/simulation';
import type {
  ActionFrame,
  CharacterId,
  Difficulty,
  Dir,
  EnemyState,
  GameState,
  GamePhase,
  LevelDef,
  MechanismDef,
  MechanismState,
  PlayerId,
  PlayerSetup,
  PlayerState,
  RoomDef,
  SimEvent,
  TickInputs,
  TileXY,
  Vec2,
} from '../core/types';
import {
  BrainMemory,
  PathFollower,
  decideBackground,
  frameOf,
} from './botBrain';
import {
  attackUntilClear,
  pushBlock,
  toExit,
} from './botActions';
import {
  DEFAULT_BACKGROUND,
  type ActionCtx,
  type ActionFailure,
  type ActionRunner,
  type ActionStatus,
  type BackgroundFlags,
  type BackgroundOptions,
  type BotAction,
  type Cond,
  type LoggedEvent,
  type PlayerRunStats,
  type RoomRunStats,
  type RunStats,
} from './botTypes';
import { diagnoseRun, formatStats } from './diagnostics';
import { buildNavMap, isPassable, type NavMap } from './pathfinding';

export * from './botTypes';
export * from './botActions';
export * from './novelBots';
export { PathFollower, decideCombat, decideRevive, decideBackground, decideEat, NUDGE } from './botBrain';
export type { FollowGoal, FollowResult, CombatRequest, CombatDecision } from './botBrain';
export * from './pathfinding';
export { diagnoseRun, formatStats } from './diagnostics';

// ───────────────────────────── Options ─────────────────────────────

/** Personnages par défaut (ordre des slots) : les 4 premiers de `CHARACTER_IDS` (personnages de la famille : mêlée et distance mélangées). */
export const DEFAULT_CHARACTERS: readonly CharacterId[] = CHARACTER_IDS.slice(0, 4);

/** Options de création d'une partie de bots. */
export interface BotRunOptions {
  /** Nombre de joueurs (1 à 4). */
  playerCount: number;
  /** Personnages par joueur (défaut : `DEFAULT_CHARACTERS`). */
  characters?: readonly CharacterId[];
  /** Difficulté par joueur (défaut : 2 = normal pour tous). */
  difficulties?: readonly Difficulty[];
  /** Graine du PRNG de la simulation (défaut 1). */
  seed?: number;
  /**
   * Salle de départ (défaut 0). Les salles précédentes sont déclarées validées et les objectifs qui leur appartiennent sont
   * marqués accomplis, pour pouvoir tester une salle isolée.
   */
  startRoomIndex?: number;
  /** Surcharge des options de fond de TOUS les joueurs (voir aussi `run.setBackground`). */
  background?: Partial<BackgroundOptions>;
  /**
   * Que faire quand une action échoue : 'clearQueue' (défaut) vide la file du joueur (il retombe sur les comportements de
   * fond) ; 'skip' passe à l'action suivante. Dans les deux cas l'échec est enregistré dans `run.failures`.
   */
  onActionFail?: 'clearQueue' | 'skip';
  /**
   * Sources de vie de la simulation (`SimConfig.loot`) : DÉFAUT FALSE pour les bots. Mesuré : avec les sources de vie actives, les bots existants
   * (qui ne les cherchent pas mais les traversent par hasard, PV < max) en ramassent des dizaines par niveau et leurs résultats (durées, défaites)
   * changeraient ; en les désactivant, les parties de bots sont strictement celles d'avant l'ajout des sources de vie. Pour mesurer le jeu réel :
   * `loot: true` (nourriture et cristaux au sol, ramassés par contact) et, pour qu'ils les cherchent, `background: { eat: true }` (voir `BackgroundOptions`).
   */
  loot?: boolean;
  /**
   * Équipement de la simulation (`SimConfig.gear`) : DÉFAUT FALSE pour les bots (même principe que `loot`) : les bots existants ne cherchent pas les objets mais
   * les traverseraient par hasard, ce qui changerait leurs résultats ; désactivé, leurs parties sont strictement celles d'avant l'ajout de l'équipement.
   * Pour mesurer le jeu réel : `gear: true` et, pour qu'ils les cherchent, `background: { pickGear: true }`.
   */
  gear?: boolean;
  /** Conserver les files d'actions quand une salle est (re)chargée (défaut false : elles sont vidées, leurs coordonnées n'ont plus de sens). */
  keepQueuesAcrossRooms?: boolean;
}

// ───────────────────────────── Contexte d'action ─────────────────────────────

class ActionContextImpl implements ActionCtx {
  elapsedMs = 0;
  consumed = false;
  failReason: string | null = null;

  constructor(
    readonly run: BotRun,
    readonly bot: BotPlayer,
    readonly frame: ActionFrame,
    readonly dtMs: number,
  ) {}

  get id(): PlayerId {
    return this.bot.id;
  }

  get player(): PlayerState {
    return this.bot.player;
  }

  set(partial: Partial<ActionFrame>): void {
    Object.assign(this.frame, partial);
    this.consumed = true;
  }

  useBackground(flags: Partial<BackgroundFlags> = {}): boolean {
    const f = decideBackground(this.bot, { combat: true, revive: true, regroup: false, ...flags });
    if (!f) return false;
    Object.assign(this.frame, f);
    this.consumed = true;
    return true;
  }

  fail(reason: string): 'failed' {
    this.failReason = reason;
    return 'failed';
  }
}

// ───────────────────────────── BotPlayer ─────────────────────────────

/**
 * Pilote d'UN joueur : file d'actions scriptées, action courante, comportements de fond, suivi de chemin.
 * Créé par `BotRun` (un par joueur) ; on le manipule via `run.queue(...)` en général.
 */
export class BotPlayer {
  /** Options des comportements de fond de ce joueur (mutables). */
  opts: BackgroundOptions;
  /** Suivi de chemin (partagé par les actions et les comportements de fond). */
  readonly follower = new PathFollower();
  /** Mémoire à court terme du combat / regroupement. */
  readonly mem = new BrainMemory();
  private queue: BotAction[] = [];
  private current: ActionRunner | null = null;
  private currentAction: BotAction | null = null;
  private elapsedMs = 0;

  constructor(
    readonly run: BotRun,
    readonly id: PlayerId,
    opts: BackgroundOptions,
  ) {
    this.opts = opts;
  }

  /** État vivant du joueur dans la simulation. */
  get player(): PlayerState {
    return this.run.sim.state.players[this.id];
  }

  /** Libellé de l'action en cours (null si aucune). */
  get currentLabel(): string | null {
    return this.currentAction ? this.currentAction.label : null;
  }

  /** Nombre d'actions en attente (hors action en cours). */
  get queued(): number {
    return this.queue.length;
  }

  /** Aucune action en cours ni en attente. */
  get isIdle(): boolean {
    return this.current === null && this.queue.length === 0;
  }

  /**
   * Disponible pour les comportements de fond « de groupe » (désignation du sauveteur) : file vide, ou action passive
   * (`wait`, `waitUntil`, `barrier`) en cours.
   */
  get backgroundEligible(): boolean {
    if (this.current === null) return this.queue.length === 0;
    return this.currentAction?.background === true;
  }

  /** Ajoute des actions à la fin de la file. */
  push(actions: readonly BotAction[]): void {
    for (const a of actions) this.queue.push(a);
  }

  /** Vide la file et abandonne l'action courante. */
  clear(): void {
    this.queue = [];
    this.current = null;
    this.currentAction = null;
    this.elapsedMs = 0;
    this.follower.reset();
  }

  /** Remise à zéro complète (changement de salle). */
  reset(): void {
    this.clear();
    this.mem.reset();
  }

  /**
   * Calcule la frame d'entrées de ce pas : exécute la file d'actions (les actions instantanées s'enchaînent dans le pas) ; si
   * aucune action ne prend la main, comportements de fond. Un joueur à terre ne fait rien (son script est gelé).
   */
  computeFrame(dtMs: number): ActionFrame {
    const frame = frameOf();
    const p = this.player;
    if (p.status !== 'alive') {
      this.follower.idle();
      return frame;
    }
    const ctx = new ActionContextImpl(this.run, this, frame, dtMs);
    for (let guard = 0; guard < 64; guard++) {
      if (this.current === null) {
        const next = this.queue.shift();
        if (!next) break;
        this.currentAction = next;
        this.current = next.create();
        this.elapsedMs = 0;
        this.follower.reset();
      }
      ctx.elapsedMs = this.elapsedMs;
      const status: ActionStatus = this.current.tick(ctx);
      if (status === 'running') {
        this.elapsedMs += dtMs;
        return frame;
      }
      if (status === 'failed') {
        this.run.recordFailure(this, this.currentAction?.label ?? '?', ctx.failReason ?? 'échec');
        ctx.failReason = null;
        if (this.run.onActionFail === 'clearQueue') {
          this.queue = [];
        }
      }
      this.current = null;
      this.currentAction = null;
      if (ctx.consumed) return frame;
    }
    if (!ctx.consumed && this.current === null) {
      const bg = decideBackground(this, { combat: true, revive: true, regroup: true });
      if (bg) Object.assign(frame, bg);
      else this.follower.idle();
    }
    return frame;
  }
}

// ───────────────────────────── BotRun ─────────────────────────────

/** Rendez-vous nommé (voir l'action `barrier`). */
export interface BarrierState {
  arrived: Set<PlayerId>;
  left: number;
}

function clampPlayers(n: number): number {
  return Math.max(1, Math.min(4, Math.floor(n)));
}

/** Prépare une simulation démarrant à la salle `index` (voir `BotRunOptions.startRoomIndex`). */
function jumpToRoom(sim: GameSimulation, level: LevelDef, index: number): GameSimulation {
  const st = JSON.parse(sim.serialize()) as GameState;
  const room = level.rooms[index];
  const n = st.playerCount;
  const spawns = room.playerSpawns.length > 0 ? room.playerSpawns : ([[1, 1]] as TileXY[]);
  st.roomIndex = index;
  st.room = {
    roomId: room.id,
    enemies: [],
    projectiles: [],
    mechanisms: createRoomMechanisms(room, n),
    spawnedSpawnIdx: [],
    elapsedMs: 0,
  };
  st.players.forEach((p, i) => {
    const sp = spawns[i % spawns.length];
    const c = tileCenter(sp[0], sp[1]);
    p.pos = { x: c.x, y: c.y };
  });
  const before = level.rooms.slice(0, index).map((r) => r.id);
  st.clearedRooms = before.slice();
  for (const o of st.objectives) {
    const def = level.objectives.find((d) => d.id === o.id);
    if (def && before.includes(def.roomId)) {
      o.done = true;
      o.progress = 1;
    }
  }
  st.phase = 'playing';
  st.phaseTimerMs = 0;
  return GameSimulation.restore(JSON.stringify(st), level);
}

/** Événements consignés dans le journal de diagnostic (les autres — coups, tirs — sont trop bavards). */
function describeEvent(e: SimEvent): string | null {
  switch (e.type) {
    case 'roomEntered':
      return `entrée salle ${e.roomId} (${e.reason})`;
    case 'playerHit':
      return `J${e.playerId + 1} perd ${e.damage} PV`;
    case 'playerDown':
      return `J${e.playerId + 1} À TERRE`;
    case 'reviveStarted':
      return `J${e.reviverId + 1} commence à relever J${e.targetId + 1}`;
    case 'reviveInterrupted':
      return `relevage de J${e.targetId + 1} interrompu (${e.reason})`;
    case 'playerRevived':
      return `J${e.playerId + 1} relevé par J${e.reviverId + 1}`;
    case 'teamWipe':
      return 'DÉFAITE COLLECTIVE';
    case 'enemyDied':
      return `ennemi #${e.enemyId} ${e.kind} meurt${e.byPlayer === null ? '' : ` (J${e.byPlayer + 1})`}`;
    case 'enemySpawned':
      return `ennemi #${e.enemyId} ${e.kind} apparaît`;
    case 'bossPhase':
      return `boss ${e.kind} phase ${e.phase}`;
    case 'mechanismChanged':
      return `mécanisme ${e.mechanismId} → ${e.active ? 'actif' : 'inactif'}`;
    case 'keyPicked':
      return `J${e.playerId + 1} ramasse la clé ${e.keyId}`;
    case 'doorOpened':
      return `porte ${e.doorId} ouverte`;
    case 'statueRotated':
      return `J${e.playerId + 1} fait pivoter la statue ${e.index} de ${e.mechanismId} → ${e.facing}`;
    case 'hourglassFlipped':
      return `J${e.playerId + 1} retourne le sablier ${e.mechanismId} (levier ${e.leverIndex})`;
    case 'hourglassEmpty':
      return `sablier ${e.mechanismId} VIDE`;
    case 'gateClosed':
      return `herse ${e.mechanismId} : ${e.closedCount} tuile(s) fermée(s)`;
    case 'runeProgress':
      return `runes ${e.mechanismId} : ${e.ok ? 'ok' : 'ERREUR'} (${e.progress})`;
    case 'objectiveCompleted':
      return `objectif ${e.objectiveId} accompli (J${e.playerId + 1})`;
    case 'roomCleared':
      return `salle ${e.roomId} validée`;
    case 'levelCompleted':
      return `niveau ${e.levelId} terminé`;
    default:
      return null;
  }
}

/**
 * Une partie de bots sur un niveau : la simulation réelle (`sim`) + un `BotPlayer` par joueur. Voir l'en-tête du fichier.
 */
export class BotRun {
  /** Simulation réelle pilotée (accès complet : `sim.state`, `sim.grid`, `sim.solidRects()`…). */
  readonly sim: GameSimulation;
  readonly level: LevelDef;
  readonly playerCount: number;
  /** Un pilote par joueur, indexé par `PlayerId`. */
  readonly bots: BotPlayer[];
  /** Statistiques cumulées (temps simulé, à terre, PV perdus, relevages, défaites collectives, par salle). */
  readonly stats: RunStats;
  /** Échecs d'actions de script (jamais silencieux : à vérifier dans les tests). */
  readonly failures: ActionFailure[] = [];
  /** Traces de debug des actions `say`. */
  readonly trace: string[] = [];
  /** Journal des événements récents (diagnostics). */
  readonly eventLog: LoggedEvent[] = [];
  /** Rendez-vous nommés en cours (action `barrier`). */
  readonly barriers = new Map<string, BarrierState>();
  /** Politique d'échec d'action (voir `BotRunOptions.onActionFail`). */
  onActionFail: 'clearQueue' | 'skip';
  /** Voir `BotRunOptions.keepQueuesAcrossRooms`. */
  keepQueuesAcrossRooms: boolean;
  /**
   * Compteur d'entrées de salle : 1 au départ, +1 à chaque salle suivante ou redémarrage (défaite collective). Sert à détecter
   * qu'il faut reconstruire les scripts.
   */
  roomEnterCount = 1;
  /** Dernière entrée de salle observée. */
  lastRoomEnter: { roomId: string; roomIndex: number; reason: 'start' | 'next' | 'restart'; timeMs: number };

  // Contexte recalculé à chaque pas (lecture par les actions et le cerveau).
  /** Rectangles solides dynamiques courants (portes fermées, blocs). */
  solids: PixelRect[] = [];
  /** Empreinte des solides (change quand une porte s'ouvre ou qu'un bloc bouge : déclenche la replanification). */
  solidsKey = '';
  /** Ennemis vivants de la salle courante. */
  aliveEnemies: EnemyState[] = [];
  private nav: NavMap | null = null;
  private navKey = '';

  /**
   * @param level niveau à jouer (non muté)
   * @param opts options (nombre de joueurs, personnages, difficultés, graine, salle de départ…)
   * @throws Error si le niveau n'a aucune salle
   */
  constructor(level: LevelDef, opts: BotRunOptions) {
    const n = clampPlayers(opts.playerCount);
    this.level = level;
    this.playerCount = n;
    const chars = opts.characters ?? DEFAULT_CHARACTERS;
    const diffs = opts.difficulties ?? [];
    const players: PlayerSetup[] = Array.from({ length: n }, (_, i) => ({
      id: i as PlayerId,
      characterId: chars[i] ?? CHARACTER_IDS[i % CHARACTER_IDS.length],
      difficulty: diffs[i] ?? 2,
    }));
    let sim = createSimulation({ levelId: level.id, players, seed: opts.seed ?? 1, loot: opts.loot === true, gear: opts.gear === true, autoCall: false }, level); // appel automatique désactivé : purement informatif, les mesures ne changent pas
    const start = Math.max(0, Math.min(level.rooms.length - 1, Math.floor(opts.startRoomIndex ?? 0)));
    if (start > 0) sim = jumpToRoom(sim, level, start);
    this.sim = sim;
    this.onActionFail = opts.onActionFail ?? 'clearQueue';
    this.keepQueuesAcrossRooms = opts.keepQueuesAcrossRooms ?? false;
    const bg: BackgroundOptions = { ...DEFAULT_BACKGROUND, ...(opts.background ?? {}) };
    this.bots = players.map((_, i) => new BotPlayer(this, i as PlayerId, { ...bg }));
    this.stats = {
      timeMs: 0,
      wipes: 0,
      players: players.map((): PlayerRunStats => ({ downs: 0, hpLost: 0, revivesDone: 0, revivedTimes: 0, kills: 0 })),
      rooms: [],
    };
    this.lastRoomEnter = { roomId: sim.room.id, roomIndex: sim.state.roomIndex, reason: 'start', timeMs: 0 };
    this.ensureRoomStats(sim.state.roomIndex);
    this.refreshContext();
  }

  // ── Accès à l'état ──

  /** État de jeu courant (lecture seule). */
  get state(): GameState {
    return this.sim.state;
  }

  /** Temps de jeu simulé (ms). */
  get timeMs(): number {
    return this.sim.state.timeMs;
  }

  /** Pas de simulation utilisé (ms). */
  get dtMs(): number {
    return SIM_STEP_MS;
  }

  /** Salle courante. */
  get room(): RoomDef {
    return this.sim.room;
  }

  /** Index de la salle courante. */
  get roomIndex(): number {
    return this.sim.state.roomIndex;
  }

  /** Id de la salle courante. */
  get roomId(): string {
    return this.sim.room.id;
  }

  /** Phase de jeu courante. */
  get phase(): GamePhase {
    return this.sim.state.phase;
  }

  /** Le niveau est-il terminé ? */
  get levelComplete(): boolean {
    return this.sim.state.phase === 'levelComplete';
  }

  /** Nombre d'ennemis vivants. */
  get enemiesLeft(): number {
    return this.aliveEnemies.length;
  }

  /** État vivant du joueur `id`. */
  player(id: PlayerId): PlayerState {
    return this.sim.state.players[id];
  }

  /**
   * Joueur qui joue le slot `slot` : `resolveSlot(slot, nbJoueurs)` (= `slot % nbJoueurs`). Les clés, leviers à `ownerSlot`,
   * objectifs et vision du niveau sont définis par slot.
   */
  playerFor(slot: number): PlayerId {
    return resolveSlot(slot, this.playerCount);
  }

  /** État vivant du joueur qui joue le slot `slot`. */
  playerStateForSlot(slot: number): PlayerState {
    return this.player(this.playerFor(slot));
  }

  /** Joueurs vivants (debout). */
  alivePlayers(): PlayerState[] {
    return this.sim.state.players.filter((p) => p.status === 'alive');
  }

  /** Pilote du joueur `id`. */
  bot(id: PlayerId): BotPlayer {
    return this.bots[id];
  }

  /** Modifie les options de fond d'un joueur (ou de tous avec 'all'). */
  setBackground(target: PlayerId | 'all', patch: Partial<BackgroundOptions>): void {
    for (const b of this.bots) if (target === 'all' || b.id === target) b.opts = { ...b.opts, ...patch };
  }

  // ── Mécanismes ──

  /** État du mécanisme `id` de la salle courante. @throws Error si absent */
  mech(id: string): MechanismState {
    const st = this.sim.state.room.mechanisms.find((m) => m.id === id);
    if (!st) {
      const known = this.sim.room.mechanisms.map((m) => m.id).join(', ');
      throw new Error(`Mécanisme « ${id} » introuvable dans la salle ${this.roomId} (connus : ${known})`);
    }
    return st;
  }

  /** Définition du mécanisme `id` de la salle courante. @throws Error si absent */
  mechDef(id: string): MechanismDef {
    const def = this.sim.room.mechanisms.find((m) => m.id === id);
    if (!def) {
      const known = this.sim.room.mechanisms.map((m) => m.id).join(', ');
      throw new Error(`Mécanisme « ${id} » introuvable dans la salle ${this.roomId} (connus : ${known})`);
    }
    return def;
  }

  /**
   * Tuiles d'un mécanisme : celles de la porte, la tuile des autres (énigme de runes : tuile d'affichage). Mécanismes inédits :
   * statues jumelles = les 2 tuiles de statue ; sablier = tuiles des LEVIERS (le premier est `mechTile`) ; pont de lumière = tuiles
   * du pont. Pour les socles des statues, la herse ou le halo, lire `mechDef(id)` (voir les primitives de `novelBots.ts`).
   */
  mechTiles(id: string): TileXY[] {
    const def = this.mechDef(id);
    switch (def.type) {
      case 'door':
        return def.tiles.map((t) => [t[0], t[1]] as TileXY);
      case 'runePuzzle':
        return [[def.displayTile[0], def.displayTile[1]]];
      case 'statuePair':
        return def.statues.map((s) => [s.tile[0], s.tile[1]] as TileXY);
      case 'hourglass':
        return def.levers.map((t) => [t[0], t[1]] as TileXY);
      case 'lightBridge':
        return def.tiles.map((t) => [t[0], t[1]] as TileXY);
      default:
        return [[def.tile[0], def.tile[1]]];
    }
  }

  /** Tuile principale d'un mécanisme (première tuile d'une porte ; coin haut-gauche d'un bloc ou d'un réceptacle 2×2). */
  mechTile(id: string): TileXY {
    return this.mechTiles(id)[0];
  }

  /** Centre en pixels d'un mécanisme (centre du carré 2×2 pour un bloc/réceptacle ; position courante pour un bloc). */
  mechPos(id: string): Vec2 {
    const def = this.mechDef(id);
    if (def.type === 'block') {
      const st = this.mech(id);
      if (st.type === 'block') return { x: st.pos.x + TILE, y: st.pos.y + TILE };
    }
    if (def.type === 'socket') return { x: (def.tile[0] + 1) * TILE, y: (def.tile[1] + 1) * TILE };
    const t = this.mechTile(id);
    return { x: (t[0] + 0.5) * TILE, y: (t[1] + 0.5) * TILE };
  }

  /**
   * Un mécanisme est-il résolu (actif/ouvert/rempli, ou neutralisé par `minPlayers`) ? Même règle que le jeton d'exigence
   * (`isMechanismSolved`) : sablier = sable restant > 0 ; pont de lumière = porteur vivant ; statues jumelles = résolues.
   */
  mechSolved(id: string): boolean {
    return isMechanismSolved(this.mech(id));
  }

  /** Exigence (jeton `Requirement` : id de mécanisme, 'clear', 'obj:<id>', 'zone:<id>') satisfaite maintenant ? */
  requirementMet(req: string): boolean {
    const s = this.sim.state;
    return isRequirementMet(req, {
      mechanisms: s.room.mechanisms,
      aliveEnemyCount: this.aliveEnemies.length + this.pendingSpawnCount(false),
      objectiveDone: (id) => isObjectiveDone(s.objectives, id),
      zoneOccupied: (id) => isZoneOccupied(s.objectives, this.level, this.sim.room, s.players, id),
    });
  }

  /** Les exigences (`requires`) de la porte `doorId` sont-elles toutes satisfaites ? */
  doorRequirementsMet(doorId: string): boolean {
    const def = this.mechDef(doorId);
    if (def.type !== 'door') throw new Error(`${doorId} n'est pas une porte`);
    return def.requires.every((r) => this.requirementMet(r));
  }

  /**
   * Nombre d'apparitions d'ennemis applicables à ce nombre de joueurs qui n'ont pas encore eu lieu.
   * @param imminentOnly ne compter que celles qui vont apparaître d'elles-mêmes : sans condition `when`, ou dont la condition
   *   `when` est DÉJÀ satisfaite (elles n'attendent plus que le pas suivant ou la fin de la vague précédente)
   */
  pendingSpawnCount(imminentOnly: boolean): number {
    const spawned = this.sim.state.room.spawnedSpawnIdx;
    let n = 0;
    this.sim.room.enemies.forEach((def, i) => {
      if (
        (def.minPlayers ?? 1) <= this.playerCount &&
        !spawned.includes(i) &&
        (!imminentOnly || def.when === undefined || this.requirementMet(def.when))
      ) {
        n++;
      }
    });
    return n;
  }

  /** Résumé court d'une liste d'ennemis (`#id type@tuile PV`), pour les messages d'erreur. */
  describeEnemies(list: readonly EnemyState[]): string {
    const parts = list.slice(0, 8).map((e) => `#${e.id} ${e.kind}@${Math.floor(e.pos.x / TILE)},${Math.floor(e.pos.y / TILE)} ${Math.round(e.hp)}PV`);
    return parts.join(', ') + (list.length > 8 ? ` … (+${list.length - 8})` : '');
  }

  // ── Sortie ──

  /**
   * Tuile de sortie assignée au joueur `playerId` : parmi les tuiles praticables de la zone de sortie de la salle courante,
   * la n-ième (n = id modulo leur nombre), pour répartir les joueurs. Valeur de repli : le centre du rectangle de sortie.
   */
  exitTile(playerId: PlayerId): TileXY {
    const r = this.sim.room.exit.rect;
    const grid = this.sim.grid;
    const list: TileXY[] = [];
    for (let ty = r.y; ty < r.y + r.h; ty++) {
      for (let tx = r.x; tx < r.x + r.w; tx++) {
        if (!grid.blocksMovement(tx, ty)) list.push([tx, ty]);
      }
    }
    if (list.length === 0) return [r.x + Math.floor(r.w / 2), r.y + Math.floor(r.h / 2)];
    return list[playerId % list.length];
  }

  /** Met dans la file de CHAQUE joueur « aller à la sortie et y rester » (`toExit`). */
  queueExit(): void {
    for (const b of this.bots) b.push(toExit());
  }

  // ── Files d'actions ──

  /** Ajoute des actions (ou des tableaux d'actions) à la fin de la file du joueur `id`. */
  queue(id: PlayerId, ...actions: (BotAction | readonly BotAction[])[]): void {
    this.bots[id].push(actions.flat());
  }

  /**
   * Ajoute des actions à la file du joueur qui joue le slot `slot` (`slot % nbJoueurs`). Avec moins de 4 joueurs, plusieurs
   * slots tombent sur le même joueur : leurs actions s'ajoutent bout à bout dans l'ordre d'appel.
   */
  queueForSlot(slot: number, ...actions: (BotAction | readonly BotAction[])[]): void {
    this.queue(this.playerFor(slot), ...actions);
  }

  /** Ajoute à la file de chaque joueur les actions produites par `make(playerId)`. */
  queueEach(make: (id: PlayerId) => BotAction | readonly BotAction[]): void {
    for (const b of this.bots) this.queue(b.id, make(b.id));
  }

  /** Vide la file (et abandonne l'action en cours) du joueur `id`, ou de tous. */
  clearQueue(id?: PlayerId): void {
    for (const b of this.bots) if (id === undefined || b.id === id) b.clear();
  }

  /** Tous les joueurs n'ont-ils plus ni action en cours ni action en attente ? */
  get allIdle(): boolean {
    return this.bots.every((b) => b.isIdle);
  }

  /**
   * Met dans la file des pousseurs `pushBlock` pour un bloc : autant de pousseurs que requis
   * (`requiredPushers(def, nbJoueurs)`), pris dans `playerIds` (défaut : les premiers joueurs vivants), chacun sur sa voie.
   * @returns ids des joueurs mis à contribution
   * @throws Error si moins de pousseurs que nécessaire sont disponibles
   */
  pushBlockTogether(blockId: string, dir: Dir, tiles: number, playerIds?: readonly PlayerId[]): PlayerId[] {
    const def = this.mechDef(blockId);
    if (def.type !== 'block') throw new Error(`${blockId} n'est pas un bloc`);
    const need = requiredPushers(def, this.playerCount);
    const pool = playerIds ?? this.alivePlayers().map((p) => p.id);
    if (pool.length < need) throw new Error(`Le bloc ${blockId} exige ${need} pousseur(s), seulement ${pool.length} disponible(s)`);
    const chosen = pool.slice(0, Math.max(need, 1));
    chosen.forEach((id, i) => this.queue(id, pushBlock(blockId, dir, tiles, { lane: i })));
    return chosen;
  }

  /** Rendez-vous nommé (créé au besoin). */
  barrierFor(name: string): BarrierState {
    let b = this.barriers.get(name);
    if (!b) {
      b = { arrived: new Set(), left: 0 };
      this.barriers.set(name, b);
    }
    return b;
  }

  /** Ajoute une trace de debug (voir l'action `say`). */
  addTrace(id: PlayerId, label: string): void {
    this.trace.push(`[${(this.timeMs / 1000).toFixed(1)}s] J${id + 1}: ${label}`);
    if (this.trace.length > 200) this.trace.shift();
  }

  /** Enregistre l'échec d'une action (appelé par `BotPlayer`). */
  recordFailure(bot: BotPlayer, label: string, reason: string): void {
    this.failures.push({ timeMs: this.timeMs, playerId: bot.id, roomId: this.roomId, label, reason });
    this.pushLog(`ÉCHEC J${bot.id + 1} ${label} : ${reason}`);
  }

  // ── Pas de simulation ──

  /**
   * Plan de navigation de la salle courante (grille + solides dynamiques courants), mis en cache tant que le décor ne change pas.
   * Ne tient pas compte des ennemis ni des tuiles évitées temporairement (voir `PathFollower`).
   */
  navMap(): NavMap {
    const key = `${this.roomEnterCount}|${this.solidsKey}`;
    if (!this.nav || this.navKey !== key) {
      this.nav = buildNavMap(this.sim.grid, this.solids);
      this.navKey = key;
    }
    return this.nav;
  }

  /** La tuile (tx,ty) est-elle praticable maintenant (hors ennemis) ? */
  isTilePassable(tx: number, ty: number): boolean {
    return isPassable(this.navMap(), tx, ty);
  }

  /** Recalcule le contexte lu par les bots (solides, ennemis). Appelé automatiquement ; à appeler après avoir muté `sim.state` à la main. */
  refreshContext(): void {
    this.solids = this.sim.solidRects();
    this.solidsKey = this.solids.map((r) => `${r.x.toFixed(2)},${r.y.toFixed(2)},${r.w},${r.h}`).join('|');
    this.aliveEnemies = this.sim.state.room.enemies.filter((e) => !e.dead && e.hp > 0);
  }

  /**
   * Avance la partie d'UN pas fixe (`SIM_STEP_MS`). La frame de chaque joueur est calculée par son pilote (action scriptée,
   * sinon comportements de fond) ; `frames` permet de FORCER la frame de certains joueurs pour ce pas (elle remplace celle du pilote).
   * @returns événements du pas
   */
  stepOnce(frames?: TickInputs): SimEvent[] {
    this.refreshContext();
    const inputs: TickInputs = {};
    for (const b of this.bots) inputs[b.id] = b.computeFrame(SIM_STEP_MS);
    if (frames) for (const k of Object.keys(frames)) inputs[Number(k) as PlayerId] = frames[Number(k) as PlayerId];
    const events = this.sim.step(SIM_STEP_MS, inputs);
    this.afterStep(events, SIM_STEP_MS);
    this.refreshContext();
    return events;
  }

  /** Avance de `ms` ms de temps de jeu (arrondi au nombre de pas supérieur). @returns nombre de pas effectués */
  stepFor(ms: number): number {
    const n = Math.max(0, Math.ceil(ms / SIM_STEP_MS - 1e-9));
    for (let i = 0; i < n; i++) this.stepOnce();
    return n;
  }

  private ensureRoomStats(roomIndex: number): RoomRunStats {
    let r = this.stats.rooms.find((x) => x.roomIndex === roomIndex);
    if (!r) {
      const n = this.playerCount;
      r = {
        roomId: this.level.rooms[roomIndex].id,
        roomIndex,
        entries: 1,
        timeMs: 0,
        clearedAtMs: null,
        wipes: 0,
        downs: new Array<number>(n).fill(0),
        hpLost: new Array<number>(n).fill(0),
        revivesDone: new Array<number>(n).fill(0),
        kills: new Array<number>(n).fill(0),
      };
      this.stats.rooms.push(r);
    }
    return r;
  }

  private pushLog(text: string): void {
    this.eventLog.push({ timeMs: this.timeMs, text });
    if (this.eventLog.length > 160) this.eventLog.shift();
  }

  private afterStep(events: readonly SimEvent[], dt: number): void {
    const s = this.sim.state;
    this.stats.timeMs = s.timeMs;
    let room = this.ensureRoomStats(s.roomIndex);
    for (const e of events) {
      const text = describeEvent(e);
      if (text) this.pushLog(text);
      switch (e.type) {
        case 'roomEntered': {
          if (e.reason === 'start') break;
          this.roomEnterCount++;
          this.lastRoomEnter = { roomId: e.roomId, roomIndex: e.roomIndex, reason: e.reason, timeMs: s.timeMs };
          room = this.ensureRoomStats(e.roomIndex);
          room.entries++;
          if (!this.keepQueuesAcrossRooms) for (const b of this.bots) b.reset();
          this.barriers.clear();
          break;
        }
        case 'playerHit':
          this.stats.players[e.playerId].hpLost += e.damage;
          room.hpLost[e.playerId] += e.damage;
          break;
        case 'playerDown':
          this.stats.players[e.playerId].downs++;
          room.downs[e.playerId]++;
          break;
        case 'playerRevived':
          this.stats.players[e.reviverId].revivesDone++;
          this.stats.players[e.playerId].revivedTimes++;
          room.revivesDone[e.reviverId]++;
          break;
        case 'teamWipe':
          this.stats.wipes++;
          room.wipes++;
          break;
        case 'enemyDied':
          if (e.byPlayer !== null) {
            this.stats.players[e.byPlayer].kills++;
            room.kills[e.byPlayer]++;
          }
          break;
        case 'roomCleared': {
          const done = this.stats.rooms.find((x) => x.roomId === e.roomId);
          if (done && done.clearedAtMs === null) done.clearedAtMs = s.timeMs;
          break;
        }
        default:
          break;
      }
    }
    room.timeMs += dt;
  }

  // ── Diagnostic ──

  /**
   * Rapport texte lisible de l'état de la partie (salle, joueurs, ennemis, mécanismes, objectifs, sortie, échecs, derniers
   * événements). À joindre aux messages d'échec.
   */
  diagnose(reason?: string): string {
    return diagnoseRun(this, reason);
  }

  /** Tableau texte des statistiques (voir `formatStats`). */
  statsReport(): string {
    return formatStats(this);
  }
}

// ───────────────────────────── Conditions prêtes à l'emploi ─────────────────────────────

/**
 * Conditions courantes pour `runUntil`, `waitUntil`, `standOn({ until })`… (fabriques de `Cond`, sauf `levelComplete`).
 */
export const conds = {
  /** La salle d'index ≥ `index` est atteinte (`state.roomIndex`). */
  roomReached: (index: number): Cond => (run) => run.state.roomIndex >= index,
  /** La salle `roomId` est la salle courante. */
  inRoom: (roomId: string): Cond => (run) => run.roomId === roomId,
  /** Le niveau est terminé (`state.phase === 'levelComplete'`). */
  levelComplete: ((run) => run.state.phase === 'levelComplete') as Cond,
  /** La phase de jeu est `phase`. */
  phaseIs: (phase: GamePhase): Cond => (run) => run.state.phase === phase,
  /** Le mécanisme est actif/ouvert/rempli ou neutralisé. */
  mechActive: (id: string): Cond => (run) => run.mechSolved(id),
  /** Le mécanisme n'est ni actif ni neutralisé. */
  mechInactive: (id: string): Cond => (run) => !run.mechSolved(id),
  /** Plus aucun ennemi vivant (apparitions en attente ignorées). */
  enemiesCleared: ((run) => run.aliveEnemies.length === 0) as Cond,
  /** Le joueur `id` est debout. */
  playerAlive: (id: PlayerId): Cond => (run) => run.player(id).status === 'alive',
  /** Tous les joueurs sont debout. */
  allAlive: ((run) => run.sim.state.players.every((p) => p.status === 'alive')) as Cond,
  /** Toutes ces exigences (`Requirement`) sont satisfaites. */
  requirements: (reqs: readonly string[]): Cond => (run) => reqs.every((r) => run.requirementMet(r)),
  /** L'objectif personnel `id` est accompli. */
  objectiveDone: (id: string): Cond => (run) => isObjectiveDone(run.state.objectives, id),
  /** Au moins `count` ennemis tués au total (tous joueurs) depuis le début de la partie. */
  killsAtLeast: (count: number): Cond => (run) => run.stats.players.reduce((a, p) => a + p.kills, 0) >= count,
};

// ───────────────────────────── Boucles d'exécution ─────────────────────────────

/** Options de `runUntil`. */
export interface RunUntilOptions {
  /** S'arrêter dès qu'une action de script échoue (défaut false). */
  stopOnFailure?: boolean;
}

/** Résultat de `runUntil`. */
export interface RunUntilResult {
  /** La condition est devenue vraie. */
  ok: boolean;
  /** Pourquoi la boucle s'est arrêtée. */
  reason: 'predicate' | 'timeout' | 'failure';
  /** Temps de jeu simulé écoulé pendant l'appel (ms). */
  elapsedMs: number;
  /** Temps de jeu total à la fin (ms). */
  timeMs: number;
}

/**
 * Avance la partie pas à pas jusqu'à ce que `predicate(run)` soit vrai (testé AVANT chaque pas, donc immédiatement si déjà
 * vrai), au plus `maxMs` ms de temps de jeu.
 * @param run partie
 * @param predicate condition d'arrêt
 * @param maxMs temps de jeu maximal (ms)
 * @param opts options
 */
export function runUntil(run: BotRun, predicate: Cond, maxMs: number, opts: RunUntilOptions = {}): RunUntilResult {
  const start = run.timeMs;
  const failuresAtStart = run.failures.length;
  const result = (ok: boolean, reason: RunUntilResult['reason']): RunUntilResult => ({
    ok,
    reason,
    elapsedMs: run.timeMs - start,
    timeMs: run.timeMs,
  });
  for (;;) {
    if (predicate(run)) return result(true, 'predicate');
    if (run.timeMs - start >= maxMs - 1e-6) return result(false, 'timeout');
    if (opts.stopOnFailure && run.failures.length > failuresAtStart) return result(false, 'failure');
    run.stepOnce();
  }
}

/**
 * Comme `runUntil` (s'arrête aussi à la première action échouée) mais LÈVE une erreur lisible, diagnostic complet inclus, si la
 * condition n'est pas atteinte. Pratique dans les tests.
 * @param label ce qui était attendu (début du message d'erreur)
 * @returns temps de jeu écoulé (ms)
 * @throws Error avec le rapport de `run.diagnose`
 */
export function expectUntil(run: BotRun, predicate: Cond, maxMs: number, label: string): number {
  const res = runUntil(run, predicate, maxMs, { stopOnFailure: true });
  if (!res.ok) {
    const why = res.reason === 'failure' ? 'une action de script a échoué' : `délai de ${maxMs} ms dépassé`;
    throw new Error(`${label} — ${why}\n${run.diagnose(why)}`);
  }
  return res.elapsedMs;
}

// ───────────────────────────── Scripts de niveau ─────────────────────────────

/** Informations passées à un script de salle quand il est (re)construit. */
export interface RoomScriptInfo {
  room: RoomDef;
  roomIndex: number;
  /** Numéro de tentative dans cette salle (0 = première entrée, 1 = après une défaite collective…). */
  attempt: number;
  /** Cette construction suit un redémarrage de la salle (défaite collective). */
  restart: boolean;
}

/** Fonction qui remplit les files d'actions des joueurs pour une salle (via `run.queue*`). Appelée à chaque entrée dans la salle. */
export type RoomScriptBuilder = (run: BotRun, info: RoomScriptInfo) => void;

/** Script d'une salle. */
export interface RoomScript {
  /** Id de la salle visée ('*' : script par défaut pour les salles sans script propre). */
  roomId: string;
  build: RoomScriptBuilder;
  /** Budget de temps de jeu (ms) par tentative dans cette salle (défaut : `LevelRunOptions.maxRoomMs`). */
  maxMs?: number;
}

/**
 * Déclare le script d'une salle : `build(run, info)` met les actions dans la file des joueurs
 * (ex. `run.queueForSlot(0, goTo(run.mechTile('lv1')), ...)`, `run.queueExit()` à la fin).
 * @param roomId id de la salle
 * @param build construction des files (appelée à chaque entrée dans la salle, y compris après une défaite)
 * @param opts budget de temps spécifique à cette salle
 */
export function roomScript(roomId: string, build: RoomScriptBuilder, opts: { maxMs?: number } = {}): RoomScript {
  return { roomId, build, maxMs: opts.maxMs };
}

/**
 * Script par défaut : chaque joueur chasse les ennemis (`attackUntilClear`) puis va à la sortie. Suffisant pour une salle de
 * combat pur ; les salles à mécanismes ont besoin d'un script dédié.
 */
export const defaultRoomScript: RoomScript = roomScript('*', (run) => {
  run.queueEach(() => [attackUntilClear(), ...toExit()]);
});

/** Options de `runLevelScripts`. */
export interface LevelRunOptions {
  /** Budget total de temps de jeu (ms, défaut 900000 = 15 min). */
  maxTotalMs?: number;
  /** Budget par tentative dans une salle (ms, défaut 180000 = 3 min), si le script n'a pas le sien. */
  maxRoomMs?: number;
  /** Nombre maximal de défaites collectives tolérées dans UNE salle avant d'abandonner (défaut 3). */
  maxWipesPerRoom?: number;
  /** Abandonner dès qu'une action de script échoue (défaut true). */
  failFast?: boolean;
  /** Script des salles sans script propre (défaut : `defaultRoomScript`). `strict: true` lève une erreur à la place. */
  fallback?: RoomScript;
  /** Salle sans script ⇒ échec (défaut false). */
  strict?: boolean;
}

/** Résultat de `runLevelScripts`. */
export interface LevelRunResult {
  /** Le niveau a été terminé (`phase === 'levelComplete'`). */
  completed: boolean;
  /** Message d'échec complet (cause + diagnostic), null si réussi. */
  failure: string | null;
  /** Temps de jeu simulé total (ms). */
  timeMs: number;
  stats: RunStats;
  /** Statistiques mises en forme (`formatStats`). */
  report: string;
}

/**
 * Joue un niveau salle par salle avec des scripts : à chaque entrée dans une salle (première fois, salle suivante,
 * redémarrage après défaite collective) les files sont vidées et le script de la salle reconstruit ; la boucle s'arrête quand
 * le niveau est terminé, ou sur échec (action échouée avec `failFast`, budget de salle/total dépassé, trop de défaites).
 * Le message d'échec contient le diagnostic complet : l'inclure tel quel dans l'assertion du test.
 * @param run partie de bots (jamais démarrée de préférence)
 * @param scripts scripts par salle
 * @param opts budgets et politique d'échec
 */
export function runLevelScripts(run: BotRun, scripts: readonly RoomScript[], opts: LevelRunOptions = {}): LevelRunResult {
  const maxTotal = opts.maxTotalMs ?? 900000;
  const maxRoomDefault = opts.maxRoomMs ?? 180000;
  const maxWipes = opts.maxWipesPerRoom ?? 3;
  const failFast = opts.failFast ?? true;
  const fallback = opts.fallback ?? defaultRoomScript;
  const startTime = run.timeMs;
  const attempts = new Map<string, number>();
  let builtFor = -1;
  let roomStart = run.timeMs;
  let roomBudget = maxRoomDefault;
  let failuresSeen = run.failures.length;
  let failure: string | null = null;

  const finish = (): LevelRunResult => ({
    completed: failure === null && run.levelComplete,
    failure,
    timeMs: run.timeMs,
    stats: run.stats,
    report: formatStats(run),
  });

  while (!run.levelComplete) {
    if (run.timeMs - startTime > maxTotal) {
      failure = `budget total de ${maxTotal} ms dépassé\n${run.diagnose('budget total dépassé')}`;
      return finish();
    }
    if (run.roomEnterCount !== builtFor) {
      builtFor = run.roomEnterCount;
      const roomId = run.roomId;
      const attempt = attempts.get(roomId) ?? 0;
      attempts.set(roomId, attempt + 1);
      if (attempt > maxWipes) {
        failure = `trop de défaites collectives dans la salle ${roomId} (${attempt})\n${run.diagnose('trop de défaites collectives')}`;
        return finish();
      }
      let script = scripts.find((s) => s.roomId === roomId);
      if (!script) {
        if (opts.strict) {
          failure = `aucun script pour la salle ${roomId}\n${run.diagnose('script manquant')}`;
          return finish();
        }
        script = fallback;
      }
      run.clearQueue();
      script.build(run, { room: run.room, roomIndex: run.roomIndex, attempt, restart: attempt > 0 });
      roomStart = run.timeMs;
      roomBudget = script.maxMs ?? maxRoomDefault;
      failuresSeen = run.failures.length;
    }
    if (failFast && run.failures.length > failuresSeen) {
      const f = run.failures[run.failures.length - 1];
      failure = `action échouée (J${f.playerId + 1} ${f.label}) : ${f.reason}\n${run.diagnose(f.reason)}`;
      return finish();
    }
    if (run.timeMs - roomStart > roomBudget) {
      failure = `salle ${run.roomId} non terminée après ${roomBudget} ms\n${run.diagnose('budget de salle dépassé')}`;
      return finish();
    }
    run.stepOnce();
  }
  return finish();
}
