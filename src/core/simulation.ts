/**
 * SIMULATION — cœur du jeu : pure, déterministe, sérialisable (aucune dépendance à Phaser/DOM/Math.random/Date.now).
 *
 * `GameSimulation` possède un `GameState` (JSON pur) et l'avance d'UN pas fixe à chaque appel de `step(dtMs, inputs)`.
 * Le LevelDef est passé explicitement (le core ne dépend pas de src/levels).
 *
 * ── Ordre documenté d'un pas ──
 *  (a) timers joueurs (`stepPlayerTimers`) ; torches : en phase 'playing' et salle `dark`, chaque joueur VIVANT consomme son
 *      combustible (`stepPlayerTorch` → torchLow / torchOut) ; toute entrée de salle (start/next/restart) remplit les torches ;
 *      les braseros (allumer / recharger, événements brazierLit / torchRefueled) sont gérés par `updateMechanisms` ;
 *      le jeton 'enter:<zoneId>' (embuscades) = joueur vivant dans la ZoneDef ; `lights()` expose les sources de lumière ;
 *  (b) arbitrage de l'action de chaque joueur : relevage (revive tenu + allié à terre à portée) > interaction (front montant
 *      sur un mécanisme interactif à portée) > attaque (tenu). Un sauveteur est immobile et n'attaque pas.
 *      APPEL : un joueur IMMOBILISÉ par son appel (`isCallFrozen`) est exclu de tout l'arbitrage (ni relevage, ni interaction, ni
 *      attaque, ni spécial). Sinon, un front montant de `ActionFrame.call` lance l'appel (`startCalls`, événement `callStarted`) si le
 *      joueur est vivant, ne relève personne (relevage prioritaire : un appel pendant un relevage est ignoré), n'appelle pas déjà,
 *      que son délai de récupération est écoulé et que la phase est 'playing' ; l'appui d'appel prime sur attaque/spécial/interaction
 *      de ce même pas (l'immobilisation commence tout de suite ; ces appuis sont perdus, pas rejoués) ; seuls les NOUVEAUX
 *      déclenchements sont bloqués : un spécial déjà lancé continue (coups différés de la Danse des lames en (d)) ;
 *  (c) mouvements des joueurs : vitesse × min(1, norme du stick), facing, collisions (grille + portes fermées + blocs) ;
 *      les joueurs à terre ou immobilisés par leur appel sont immobiles (et ne poussent pas de bloc) ; ceux à terre ne bloquent personne ;
 *  (d) attaques des joueurs (mêlée instantanée / projectiles) ; puis ATTAQUES SPÉCIALES : coups différés des spéciaux en cours
 *      (Danse des lames), puis déclenchement des spéciaux sur front montant de `ActionFrame.special` (joueur vivant, ne relevant
 *      pas, recharge écoulée) → événement `specialUsed` ; `specialReady` est émis en (a) quand la recharge atteint 0 ;
 *  (e) relevage (`updateRevive`) → reviveStarted / reviveInterrupted / playerRevived ;
 *  (f) mécanismes (`updateMechanisms`, y compris statues jumelles / sablier / pont de lumière : leurs tuiles solides sont reprises
 *      par `solidRects()` dès le pas suivant et `ejectPlayersFromSolids` extrait un joueur dont le disque déborde sur une tuile qui
 *      vient de s'éteindre/fermer), `aliveEnemyCount` comptant aussi les apparitions encore en attente (jeton 'clear') ;
 *  (g) apparitions d'ennemis (vagues, `when`, `minPlayers`) ; chaque `EnemySpawnDef` n'apparaît qu'une fois ;
 *  (h) IA des ennemis (`updateEnemy`) ;
 *  (i) projectiles et impacts ;
 *  (j) morts d'ennemis (enemyDied, kills du tueur, retrait) ;
 *  (k) objectifs personnels (`updateObjectives`) ;
 *  (l) sortie de salle : exigences de sortie satisfaites ET tous les joueurs vivants (≥ 1) dans `exit.rect` ⇒ phase
 *      'roomCleared' (événement roomCleared) puis, après ROOM_CLEAR_DELAY_MS, salle suivante (roomEntered 'next') ;
 *      salle finale (`exit.final`, et tous les objectifs accomplis) ⇒ phase 'levelComplete' (levelCompleted) ;
 *  (m) mort d'équipe : teamWipe, phase 'wipe', puis après WIPE_RESTART_DELAY_MS redémarrage AUTOMATIQUE de la salle
 *      courante (roomEntered 'restart') : PV pleins, ennemis/mécanismes/clés recréés, objectifs de la salle remis à zéro,
 *      kills remis à zéro, salles validées conservées ;
 *  (n) mémoire des entrées (fronts montants) mise à jour.
 *
 * Hors phase 'playing' ('roomCleared', 'levelComplete', 'wipe') : les joueurs peuvent bouger, les ennemis et projectiles
 * continuent d'animer, mais plus aucun dégât, attaque, mécanisme, apparition ni objectif ne se déclenche.
 *
 * Les ennemis ne peuvent jamais achever un joueur à terre (`applyDamageToPlayer` ignore les joueurs `down`), mais le comptent
 * comme « menace » (ralentit le relevage, `DOWNED_THREAT_RADIUS`).
 *
 * Détails de conception :
 *  - les entrées d'un joueur absent du map sont une frame vide ; NaN est ignoré (0), moveX/moveY bornés à [-1, 1] ;
 *  - ennemis invoqués en cours de combat (`EnemyAIContext.spawnEnemy`) : vague `SUMMON_WAVE` (-1) — ils comptent pour
 *    'clear' mais ne retardent pas les vagues suivantes ; limite globale `MAX_ALIVE_ENEMIES` ;
 *  - à l'arrivée dans une salle suivante ou après un redémarrage, les joueurs bénéficient de `ROOM_ENTER_INVULN_MS` d'invulnérabilité ;
 *    les joueurs vivants conservent leurs PV d'une salle à l'autre (seuls les joueurs à terre sont relevés à PV pleins) ;
 *  - après un redémarrage, `player.kills` est remis à zéro (voir `resetPlayersForRoom`) ;
 *  - le spécial démarre PRÊT ; tout chargement/redémarrage de salle le remet PRÊT (recharge à 0, sans événement `specialReady`) ;
 *  - appel : `callMs` (signal restant, ≤ CALL_DURATION_MS) et `callCooldownMs` (≤ CALL_COOLDOWN_MS, décompté depuis l'appui) décroissent
 *    avec les autres timers (a). Immobile tant que `callMs > CALL_DURATION_MS - CALL_FREEZE_MS`. Annulé si l'appelant tombe à terre ;
 *    tout (re)démarrage de salle (start / next / restart, donc défaite collective incluse) remet les deux à 0. Un joueur qui appelle reste
 *    vulnérable, sa torche continue de s'user et il compte normalement pour les zones d'objectif et de sortie.
 */
import {
  DOWNED_THREAT_RADIUS,
  INTERACT_RANGE,
  PLAYER_RADIUS,
  TORCH_MAX_MS,
  REVIVE_RANGE,
  ROOM_CLEAR_DELAY_MS,
  SIM_STEP_MS,
  WIPE_RESTART_DELAY_MS,
} from './constants';
import { createEnemyState, knockEnemy, onEnemyHit, stunEnemy, updateEnemy } from './ai';
import { getCharacter } from './characters';
import { canOccupy, moveCircle, resolveOverlap, type PixelRect } from './collision';
import {
  damagePlayersInCircle,
  enemyRadius,
  MAX_PROJECTILES,
  performPlayerAttack,
  performPlayerSpecial,
  stepProjectiles,
  stepSpecialEffects,
  type CombatContext,
} from './combat';
import { getEnemyDef, isAnyBossKind, isFlyingKind } from './enemies';
import { dirFromVec, distSq, pointInTileRect, tileCenter } from './geometry';
import { RoomGrid } from './grid';
import { lightSources, type LightSource } from './light';
import {
  areAllRequirementsMet,
  brazierAction,
  createRoomMechanisms,
  hourglassLeverIndex,
  isRequirementMet,
  mechanismSolidRects,
  statueRotationTarget,
  tileCenterPx,
  updateMechanisms,
  type RequirementContext,
} from './mechanisms';
import {
  allObjectivesDone,
  createObjectives,
  isObjectiveDone,
  isZoneOccupied,
  resetRoomObjectives,
  updateObjectives,
  type DeathRecord,
} from './objectives';
import {
  createPlayerState,
  isRescuing,
  isTeamWiped,
  resetPlayersForRoom,
  reviveAllDowned,
  stepPlayerTimers,
  isCallFrozen,
  canStartCall,
  startCall,
  cancelCall,
  stepPlayerTorch,
  updateRevive,
} from './players';
import { nextRandom, seedToState } from './rng';
import { resolveSlot } from './slots';
import type {
  ActionFrame,
  EnemyAIContext,
  EnemyKind,
  EnemyState,
  GameState,
  IGameSimulation,
  LevelDef,
  PlayerId,
  PlayerSetup,
  PlayerState,
  ProjectileKind,
  RoomDef,
  RoomState,
  SimConfig,
  SimEvent,
  TickInputs,
  Vec2,
} from './types';

// ───────────────────────────── Constantes ─────────────────────────────

/** Nombre maximal d'ennemis vivants simultanément dans une salle (apparitions et invocations). */
export const MAX_ALIVE_ENEMIES = 40;
/** Invulnérabilité (ms) accordée aux joueurs à l'arrivée dans une nouvelle salle ou après un redémarrage. */
export const ROOM_ENTER_INVULN_MS = 600;
/** Vague attribuée aux ennemis invoqués par l'IA (ne retardent pas les vagues suivantes, comptent pour 'clear'). */
export const SUMMON_WAVE = -1;
// Types d'ennemis volants (fosses non bloquantes, voir `collision.ts`) : `isFlyingKind` (enemies.ts).

/** Durée maximale (ms) d'un pas : un `dtMs` plus grand est tronqué (le rendu doit appeler `step` plusieurs fois). */
export const MAX_STEP_MS = 100;

// ───────────────────────────── Utilitaires ─────────────────────────────

/** Frame d'entrées assainie : NaN → 0, axes bornés à [-1, 1] (±Infinity → ±1), booléens stricts. Frame absente = frame vide. */
export function sanitizeFrame(f: ActionFrame | undefined): ActionFrame {
  if (!f) return { moveX: 0, moveY: 0, attack: false, interact: false, revive: false, special: false, call: false };
  const axis = (v: number): number => (Number.isNaN(v) ? 0 : Math.max(-1, Math.min(1, v)));
  return {
    moveX: axis(f.moveX),
    moveY: axis(f.moveY),
    attack: f.attack === true,
    interact: f.interact === true,
    revive: f.revive === true,
    special: f.special === true,
    call: f.call === true,
  };
}

/**
 * Normalise la liste de joueurs d'une configuration : tri par id, au plus 4 joueurs, ids ramenés à 0..n-1 s'ils ne sont
 * pas déjà contigus (la coop adaptative repose sur `slot % nbJoueurs`).
 * @throws Error si la liste est vide
 */
function normalizeSetups(players: readonly PlayerSetup[]): PlayerSetup[] {
  if (players.length === 0) throw new Error('SimConfig.players ne doit pas être vide');
  const sorted = players.slice().sort((a, b) => a.id - b.id).slice(0, 4);
  const contiguous = sorted.every((p, i) => p.id === i);
  return sorted.map((p, i) => ({ ...p, id: (contiguous ? p.id : i) as PlayerId }));
}

function spawnPixels(room: RoomDef): Vec2[] {
  const out = room.playerSpawns.map((t) => tileCenter(t[0], t[1]));
  return out.length > 0 ? out : [tileCenter(1, 1)];
}

function newRoomState(room: RoomDef, playerCount: number): RoomState {
  return {
    roomId: room.id,
    enemies: [],
    projectiles: [],
    mechanisms: createRoomMechanisms(room, playerCount),
    spawnedSpawnIdx: [],
    elapsedMs: 0,
  };
}

// ───────────────────────────── Simulation ─────────────────────────────

/** Résultat de l'arbitrage d'action d'un pas (par joueur). */
interface Arbitration {
  /** Joueurs qui relèvent (ou tentent de relever) : immobiles, sans attaque ni interaction. */
  reviving: Set<PlayerId>;
  /** Front montant d'interaction arbitré. */
  interactPressed: Partial<Record<PlayerId, boolean>>;
  /** Joueurs qui attaquent ce pas. */
  attacking: Set<PlayerId>;
  /** Joueurs dont le bouton de spécial vient d'être pressé (front montant) ce pas. */
  special: Set<PlayerId>;
  /** Joueurs dont l'appel est lancé CE pas (front montant accepté : vivant, libre, délai écoulé). */
  call: Set<PlayerId>;
}

/**
 * Simulation complète d'une partie (1 à 4 joueurs) sur un niveau. Implémente `IGameSimulation`.
 * Créer via `createSimulation(config, level)` ou `GameSimulation.restore(snapshot, level)`.
 */
export class GameSimulation implements IGameSimulation {
  /** État courant (JSON pur). Lecture seule côté appelant (les tests peuvent le muter pour préparer un scénario). */
  readonly state: GameState;
  readonly level: LevelDef;
  private roomGrid: RoomGrid;
  private pending: SimEvent[];
  private lastEvents: SimEvent[] = [];

  /** @internal Utiliser `createSimulation` ou `GameSimulation.restore`. */
  constructor(state: GameState, level: LevelDef, pendingEvents: SimEvent[] = []) {
    this.state = state;
    this.level = level;
    this.roomGrid = new RoomGrid(level.rooms[state.roomIndex].layout);
    this.pending = pendingEvents;
  }

  /**
   * Reconstruit une simulation depuis un snapshot (`serialize()`). La suite d'états produite est strictement identique à
   * celle de la simulation d'origine.
   * @param snapshotJson JSON produit par `serialize()`
   * @param level niveau correspondant (même `id` que celui du snapshot)
   * @throws Error si le snapshot est invalide ou ne correspond pas au niveau
   */
  static restore(snapshotJson: string, level: LevelDef): GameSimulation {
    let parsed: GameState;
    try {
      parsed = JSON.parse(snapshotJson) as GameState;
    } catch {
      throw new Error('Snapshot de simulation illisible (JSON invalide)');
    }
    if (
      !parsed ||
      parsed.version !== 1 ||
      !Array.isArray(parsed.players) ||
      parsed.players.length === 0 ||
      !parsed.room ||
      typeof parsed.roomIndex !== 'number'
    ) {
      throw new Error('Snapshot de simulation invalide');
    }
    if (parsed.levelId !== level.id) {
      throw new Error(`Le snapshot (${parsed.levelId}) ne correspond pas au niveau ${level.id}`);
    }
    if (!level.rooms[parsed.roomIndex]) throw new Error('Snapshot : salle inconnue dans ce niveau');
    // Compatibilité : un ancien snapshot n'a pas les champs d'appel (ajoutés après coup) → valeurs par défaut.
    for (const p of parsed.players) {
      if (typeof p.callMs !== 'number' || !Number.isFinite(p.callMs)) p.callMs = 0;
      if (typeof p.callCooldownMs !== 'number' || !Number.isFinite(p.callCooldownMs)) p.callCooldownMs = 0;
      if (p.prev && typeof p.prev.call !== 'boolean') p.prev.call = false;
    }
    return new GameSimulation(parsed, level);
  }

  // ── Accès ──

  /** Définition de la salle courante. */
  get room(): RoomDef {
    return this.level.rooms[this.state.roomIndex];
  }

  /** Grille statique de la salle courante (reconstruite à chaque changement de salle). */
  get grid(): RoomGrid {
    return this.roomGrid;
  }

  /** Nombre de joueurs de la partie (1..4). */
  get playerCount(): number {
    return this.state.playerCount;
  }

  /** Rectangles pixels solides dynamiques : une tuile par porte fermée + les blocs (position interpolée). */
  solidRects(): PixelRect[] {
    return mechanismSolidRects(this.room, this.state.room.mechanisms);
  }

  /** Événements produits par le dernier appel à `step` (pour le HUD/les sons). */
  getEvents(): readonly SimEvent[] {
    return this.lastEvents;
  }

  /** Snapshot JSON du `GameState`. */
  serialize(): string {
    return JSON.stringify(this.state);
  }

  /**
   * La sortie de la salle courante est-elle ouverte ? (exigences satisfaites ; pour la salle finale, tous les objectifs
   * accomplis en plus). Utile au rendu de la porte scellée.
   */
  isExitOpen(): boolean {
    const exit = this.room.exit;
    if (!areAllRequirementsMet(exit.requires, this.requirementContext())) return false;
    return !this.isFinalRoom() || allObjectivesDone(this.state.objectives);
  }

  /** La salle courante termine-t-elle le niveau ? (`exit.final`, ou dernière salle du niveau) */
  private isFinalRoom(): boolean {
    return this.room.exit.final === true || this.state.roomIndex >= this.level.rooms.length - 1;
  }

  // ── Pas de simulation ──

  /**
   * Avance la simulation d'UN pas. Voir l'en-tête du fichier pour l'ordre des opérations.
   * @param dtMs durée du pas (ms) ; recommandé : `SIM_STEP_MS`. Tronquée à `MAX_STEP_MS` ; ≤ 0 ou non finie : aucun effet.
   * @param inputs entrées tenues de chaque joueur (absent = frame vide)
   * @returns événements produits (y compris ceux de l'entrée dans la salle initiale lors du premier pas)
   */
  step(dtMs: number, inputs: TickInputs): SimEvent[] {
    const events = this.pending;
    this.pending = [];
    this.lastEvents = events;
    if (!(dtMs > 0) || !Number.isFinite(dtMs)) return events;
    const dt = Math.min(dtMs, MAX_STEP_MS);
    const s = this.state;
    const players = s.players;

    s.tick += 1;
    s.timeMs += dt;
    s.phaseTimerMs += dt;
    s.room.elapsedMs += dt;

    const frames: Partial<Record<PlayerId, ActionFrame>> = {};
    for (const p of players) frames[p.id] = sanitizeFrame(inputs[p.id]);
    const frameOf = (p: PlayerState): ActionFrame => frames[p.id] as ActionFrame;

    // (a) timers (+ `specialReady` quand la recharge du spécial atteint 0)
    const specialAnimBefore = new Map<PlayerId, number>();
    for (const p of players) {
      const cdBefore = p.specialCooldownMs;
      specialAnimBefore.set(p.id, p.specialAnimMs);
      stepPlayerTimers(p, dt);
      if (cdBefore > 0 && p.specialCooldownMs <= 0) events.push({ type: 'specialReady', playerId: p.id });
      // torche : ne s'use que dans une salle sombre, pour les joueurs vivants, en phase 'playing'
      if (s.phase === 'playing') events.push(...stepPlayerTorch(p, dt, this.room.dark === true));
    }

    // (b) arbitrage des actions
    const arb = this.arbitrate(frameOf);
    this.startCalls(arb, events);

    // (c) mouvements
    this.movePlayers(frameOf, arb, dt);

    const killers = new Map<number, PlayerId>();
    const cctx = this.makeCombatContext(events, killers);

    // (d) attaques, puis spéciaux
    if (s.phase === 'playing') {
      for (const p of players) {
        if (arb.attacking.has(p.id)) performPlayerAttack(cctx, p);
      }
      for (const p of players) stepSpecialEffects(cctx, p, specialAnimBefore.get(p.id) ?? 0);
      for (const p of players) {
        if (arb.special.has(p.id) && !isRescuing(p)) performPlayerSpecial(cctx, p);
      }
    }

    // (e) relevage
    events.push(
      ...updateRevive(
        players,
        (id) => arb.reviving.has(id),
        (downed) => this.enemyThreatNear(downed),
        dt,
      ),
    );

    // (f) mécanismes
    if (s.phase === 'playing') {
      const mechFrames: Partial<Record<PlayerId, ActionFrame>> = {};
      for (const p of players) {
        const f = frameOf(p);
        mechFrames[p.id] = arb.reviving.has(p.id) || isCallFrozen(p) ? { ...f, moveX: 0, moveY: 0 } : f;
      }
      const req = this.requirementContext();
      events.push(
        ...updateMechanisms({
          room: this.room,
          grid: this.roomGrid,
          mechanisms: s.room.mechanisms,
          players,
          frames: mechFrames,
          interactPressed: arb.interactPressed,
          dtMs: dt,
          aliveEnemyCount: req.aliveEnemyCount,
          objectiveDone: req.objectiveDone,
          zoneOccupied: req.zoneOccupied,
          zoneEntered: req.zoneEntered,
          enemyCircles: s.room.enemies
            .filter((e) => !e.dead)
            .map((e) => ({ x: e.pos.x, y: e.pos.y, r: enemyRadius(e) })),
        }),
      );
      this.ejectPlayersFromSolids();
    }
    cctx.solids = this.solidRects(); // un bloc a pu bouger : l'IA et les projectiles voient les solides à jour

    // (g) apparitions
    if (s.phase === 'playing') this.spawnPending(events);

    // (h) IA ennemie
    this.updateEnemies(dt, events, cctx);

    // (i) projectiles
    stepProjectiles(cctx, dt);

    // (j) morts
    const deaths = this.collectDeaths(events, killers);

    // (k) objectifs
    if (s.phase === 'playing') {
      events.push(
        ...updateObjectives({
          level: this.level,
          room: this.room,
          objectives: s.objectives,
          players,
          mechanisms: s.room.mechanisms,
          deaths,
          dtMs: dt,
          roomCleared: this.aliveEnemies().length + this.pendingSpawnCount() === 0 && s.room.elapsedMs > 0,
        }),
      );
    }

    // (l) sortie de salle
    if (s.phase === 'playing') this.checkExit(events);

    // (m) mort d'équipe et transitions de phase
    this.updatePhases(events);

    // (n) mémoire des entrées
    for (const p of players) {
      const f = frameOf(p);
      p.prev.attack = f.attack;
      p.prev.interact = f.interact;
      p.prev.revive = f.revive;
      p.prev.special = f.special === true;
      p.prev.call = f.call === true;
      if (p.status !== 'alive') cancelCall(p); // garde-fou : un joueur à terre n'appelle pas (quelle que soit la cause de la chute)
    }
    return events;
  }

  // ── (b) Arbitrage ──

  /** Un allié à terre à portée de `p` que `p` peut relever (libre, ou déjà relevé par `p`) ? */
  private downedAllyInReach(p: PlayerState): boolean {
    for (const t of this.state.players) {
      if (t.id === p.id || t.status !== 'down') continue;
      if (t.reviverId !== null && t.reviverId !== p.id) continue;
      if (distSq(t.pos, p.pos) <= REVIVE_RANGE * REVIVE_RANGE) return true;
    }
    return false;
  }

  /** Un mécanisme interactif (levier, piédestal de runes, porte à clé détenue, brasero, socle de statue, levier de sablier) est-il à portée de `p` ? */
  private interactableNear(p: PlayerState): boolean {
    const n = this.state.playerCount;
    const states = this.state.room.mechanisms;
    for (const def of this.room.mechanisms) {
      const st = states.find((m) => m.id === def.id);
      if (!st || (st.waived && def.type !== 'brazier')) continue;
      switch (def.type) {
        case 'lever':
          if (st.type !== 'lever' || st.active) break;
          if (def.ownerSlot !== undefined && resolveSlot(def.ownerSlot, n) !== p.id) break;
          if (Math.hypot(p.pos.x - tileCenterPx(def.tile).x, p.pos.y - tileCenterPx(def.tile).y) <= INTERACT_RANGE) return true;
          break;
        case 'runePuzzle':
          if (st.type !== 'runePuzzle' || st.active) break;
          if (def.pedestals.some((ped) => distSq(p.pos, tileCenterPx(ped.tile)) <= INTERACT_RANGE * INTERACT_RANGE)) return true;
          break;
        case 'door':
          if (st.type !== 'door' || st.open || def.keyId === undefined || !p.keys.includes(def.keyId)) break;
          if (!areAllRequirementsMet(def.requires, this.requirementContext())) break;
          if (def.tiles.some((t) => distSq(p.pos, tileCenterPx(t)) <= INTERACT_RANGE * INTERACT_RANGE)) return true;
          break;
        case 'brazier':
          if (st.type === 'brazier' && brazierAction(def, st, p, n) !== null) return true;
          break;
        case 'statuePair':
          if (st.type === 'statuePair' && statueRotationTarget(def, st, p) !== null) return true;
          break;
        case 'hourglass':
          if (st.type === 'hourglass' && hourglassLeverIndex(def, p) >= 0) return true;
          break;
        default:
          break;
      }
    }
    return false;
  }

  /**
   * Arbitre le bouton d'action de chaque joueur : relevage > interaction > attaque.
   *  - relevage : `revive` tenu ET (déjà en train de relever OU allié à terre libre à portée) ;
   *  - interaction : front montant de `interact`, sans relevage ;
   *  - attaque : `attack` tenu, sans relevage, et sans interaction possible à portée quand `interact` est tenu aussi
   *    (touche d'action unique du clavier) ; uniquement en phase 'playing'.
   */
  private arbitrate(frameOf: (p: PlayerState) => ActionFrame): Arbitration {
    const arb: Arbitration = { reviving: new Set(), interactPressed: {}, attacking: new Set(), special: new Set(), call: new Set() };
    const playing = this.state.phase === 'playing';
    for (const p of this.state.players) {
      if (p.status !== 'alive') continue;
      const f = frameOf(p);
      // Immobilisé par son appel : ni relevage, ni interaction, ni attaque, ni spécial (le signal, lui, continue).
      if (isCallFrozen(p)) continue;
      if (f.revive && (isRescuing(p) || this.downedAllyInReach(p))) {
        arb.reviving.add(p.id);
        continue;
      }
      if (!playing) continue;
      // Appel : front montant, joueur libre (délai écoulé, pas d'appel en cours). Il prime sur le reste du pas (immobilisation immédiate).
      if (f.call === true && p.prev.call !== true && canStartCall(p)) {
        arb.call.add(p.id);
        continue;
      }
      if (f.special === true && p.prev.special !== true) arb.special.add(p.id);
      const pressed = f.interact && !p.prev.interact;
      if (pressed) arb.interactPressed[p.id] = true;
      // L'attaque n'est supprimée que sur le front montant qui actionne réellement un mécanisme : un bouton maintenu
      // continue d'attaquer, un nouvel appui près d'un levier l'actionne sans attaquer.
      if (f.attack && !(pressed && this.interactableNear(p))) arb.attacking.add(p.id);
    }
    return arb;
  }

  /** Lance les appels acceptés par l'arbitrage (`callMs`, `callCooldownMs`) et émet `callStarted`. */
  private startCalls(arb: Arbitration, events: SimEvent[]): void {
    for (const p of this.state.players) {
      if (!arb.call.has(p.id)) continue;
      startCall(p);
      events.push({ type: 'callStarted', playerId: p.id });
    }
  }

  // ── (c) Mouvements ──

  private movePlayers(frameOf: (p: PlayerState) => ActionFrame, arb: Arbitration, dt: number): void {
    const solids = this.solidRects();
    for (const p of this.state.players) {
      if (p.status !== 'alive' || arb.reviving.has(p.id) || isCallFrozen(p)) {
        p.moving = false;
        continue;
      }
      const f = frameOf(p);
      const norm = Math.hypot(f.moveX, f.moveY);
      if (norm < 1e-6) {
        p.moving = false;
        continue;
      }
      const amplitude = Math.min(1, norm);
      const speed = getCharacter(p.characterId).speed * amplitude;
      const k = (speed * dt) / 1000 / norm;
      p.facing = dirFromVec({ x: f.moveX, y: f.moveY }, p.facing);
      const before = p.pos;
      const next = moveCircle(before, { x: f.moveX * k, y: f.moveY * k }, PLAYER_RADIUS, this.roomGrid, solids);
      if (Number.isFinite(next.x) && Number.isFinite(next.y)) {
        p.moving = Math.hypot(next.x - before.x, next.y - before.y) > 1e-4;
        p.pos = next;
      } else {
        p.moving = false;
      }
    }
  }

  /** Après les mécanismes (un bloc a pu bouger), extrait d'un solide les joueurs qui s'y trouveraient encore. */
  private ejectPlayersFromSolids(): void {
    const solids = this.solidRects();
    if (solids.length === 0) return;
    for (const p of this.state.players) {
      if (!canOccupy(p.pos, PLAYER_RADIUS, this.roomGrid, solids)) {
        p.pos = resolveOverlap(p.pos, PLAYER_RADIUS, this.roomGrid, solids);
      }
    }
  }

  // ── Combat / contextes ──

  private makeCombatContext(events: SimEvent[], killers: Map<number, PlayerId>): CombatContext {
    const sim = this;
    return {
      room: this.state.room,
      players: this.state.players,
      grid: this.roomGrid,
      solids: this.solidRects(),
      events,
      nextId: () => sim.allocId(),
      onEnemyHit: (enemy, from, raw) => onEnemyHit(enemy, from, raw),
      killers,
      get damageEnabled(): boolean {
        return sim.state.phase === 'playing';
      },
      onPlayerDowned: () => sim.checkTeamWipe(events),
      stunEnemy: (enemy, ms) => {
        stunEnemy(enemy, ms);
      },
      knockEnemy: (enemy, from, speed) => {
        knockEnemy(enemy, from, speed);
      },
    };
  }

  private allocId(): number {
    const id = this.state.nextEntityId;
    this.state.nextEntityId = id + 1;
    return id;
  }

  /** Un ennemi vivant menace-t-il ce joueur à terre ? (centre à centre ≤ DOWNED_THREAT_RADIUS) */
  private enemyThreatNear(downed: PlayerState): boolean {
    const r2 = DOWNED_THREAT_RADIUS * DOWNED_THREAT_RADIUS;
    for (const e of this.state.room.enemies) {
      if (e.dead || e.hp <= 0) continue;
      if (distSq(e.pos, downed.pos) <= r2) return true;
    }
    return false;
  }

  // ── Exigences ──

  private aliveEnemies(): EnemyState[] {
    return this.state.room.enemies.filter((e) => !e.dead && e.hp > 0);
  }

  /** Apparitions applicables à ce nombre de joueurs qui n'ont pas encore eu lieu. */
  private pendingSpawnCount(): number {
    const spawned = this.state.room.spawnedSpawnIdx;
    let n = 0;
    this.room.enemies.forEach((def, i) => {
      if ((def.minPlayers ?? 1) <= this.state.playerCount && !spawned.includes(i)) n++;
    });
    return n;
  }

  private requirementContext(): RequirementContext {
    const s = this.state;
    return {
      mechanisms: s.room.mechanisms,
      aliveEnemyCount: this.aliveEnemies().length + this.pendingSpawnCount(),
      objectiveDone: (id) => isObjectiveDone(s.objectives, id),
      zoneOccupied: (id) => isZoneOccupied(s.objectives, this.level, this.room, s.players, id),
      zoneEntered: (id) => this.isZoneEntered(id),
    };
  }

  /** Un joueur VIVANT se trouve-t-il dans la `ZoneDef` `zoneId` de la salle courante ? (jeton 'enter:<zoneId>') */
  private isZoneEntered(zoneId: string): boolean {
    const zone = (this.room.zones ?? []).find((z) => z.id === zoneId);
    if (!zone) return false;
    return this.state.players.some((p) => p.status === 'alive' && pointInTileRect(p.pos, zone.rect));
  }

  /**
   * Sources de lumière de la salle courante (torches des joueurs, braseros allumés, décors torch d'une salle sombre) :
   * `lightSources(state, room)`. À n'utiliser pour le rendu du noir que si `room.dark === true`.
   */
  lights(): LightSource[] {
    return lightSources(this.state, this.room);
  }

  // ── (g) Apparitions ──

  /**
   * Fait apparaître les ennemis dont les conditions sont réunies :
   *  - `minPlayers` ≤ nombre de joueurs ;
   *  - vague k > 0 : toutes les apparitions applicables des vagues < k ont eu lieu ET leurs ennemis sont vaincus ;
   *  - `when` satisfait ;
   *  - moins de `MAX_ALIVE_ENEMIES` ennemis vivants.
   */
  private spawnPending(events: SimEvent[]): void {
    const s = this.state;
    const room = this.room;
    const n = s.playerCount;
    const req = this.requirementContext();
    const spawned = s.room.spawnedSpawnIdx;
    const alive = this.aliveEnemies();
    const waveOf = (i: number): number => Math.max(0, room.enemies[i].wave ?? 0);

    const wavesBelowDefeated = (k: number): boolean => {
      for (let j = 0; j < room.enemies.length; j++) {
        if ((room.enemies[j].minPlayers ?? 1) > n) continue;
        if (waveOf(j) < k && !spawned.includes(j)) return false;
      }
      return !alive.some((e) => e.wave >= 0 && e.wave < k);
    };

    for (let i = 0; i < room.enemies.length; i++) {
      const def = room.enemies[i];
      if (spawned.includes(i) || (def.minPlayers ?? 1) > n) continue;
      const wave = waveOf(i);
      if (wave > 0 && !wavesBelowDefeated(wave)) continue;
      if (def.when !== undefined && !isRequirementMet(def.when, req)) continue;
      if (alive.length >= MAX_ALIVE_ENEMIES) continue;
      const pos = tileCenter(def.tile[0], def.tile[1]);
      const enemy = createEnemyState(def.kind, pos, this.allocId(), wave);
      s.room.enemies.push(enemy);
      alive.push(enemy);
      spawned.push(i);
      events.push({ type: 'enemySpawned', enemyId: enemy.id, kind: enemy.kind, pos: { x: pos.x, y: pos.y } });
    }
  }

  // ── (h) IA ──

  private makeAIContext(dt: number, events: SimEvent[], cctx: CombatContext, aliveList: EnemyState[]): EnemyAIContext {
    const sim = this;
    const s = this.state;
    const grid = this.roomGrid;
    return {
      dtMs: dt,
      players: s.players,
      enemies: aliveList,
      random: () => nextRandom(s),
      canOccupy: (pos, radius, flying) => canOccupy(pos, radius, grid, cctx.solids, flying === true),
      moveWithCollision: (pos, delta, radius, flying) => moveCircle(pos, delta, radius, grid, cctx.solids, flying === true),
      spawnProjectile(p: {
        kind: ProjectileKind;
        pos: Vec2;
        vel: Vec2;
        damage: number;
        radius: number;
        lifeMs: number;
        pierce?: boolean;
        enemyId: number;
      }): void {
        if (s.phase !== 'playing' || s.room.projectiles.length >= MAX_PROJECTILES) return;
        const values = [p.pos.x, p.pos.y, p.vel.x, p.vel.y, p.damage, p.radius, p.lifeMs];
        if (!values.every(Number.isFinite)) return;
        const proj = {
          id: sim.allocId(),
          kind: p.kind,
          owner: { type: 'enemy' as const, id: p.enemyId },
          pos: { x: p.pos.x, y: p.pos.y },
          vel: { x: p.vel.x, y: p.vel.y },
          damage: p.damage,
          radius: p.radius,
          lifeMs: p.lifeMs,
          pierce: p.pierce === true,
          hitIds: [] as number[],
        };
        s.room.projectiles.push(proj);
        events.push({ type: 'projectileFired', projectileId: proj.id, kind: proj.kind, pos: { x: proj.pos.x, y: proj.pos.y } });
      },
      spawnEnemy(kind: EnemyKind, pos: Vec2): number {
        if (s.phase !== 'playing' || aliveList.length >= MAX_ALIVE_ENEMIES) return -1;
        if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return -1;
        const radius = getEnemyDef(kind).radius;
        const at = sim.findFreeSpot(pos, radius, cctx.solids, isFlyingKind(kind));
        if (!at) return -1;
        const enemy = createEnemyState(kind, at, sim.allocId(), SUMMON_WAVE);
        s.room.enemies.push(enemy);
        aliveList.push(enemy);
        events.push({ type: 'enemySpawned', enemyId: enemy.id, kind, pos: { x: at.x, y: at.y } });
        return enemy.id;
      },
      damageCircle(center: Vec2, radius: number, damage: number): void {
        if (!Number.isFinite(center.x) || !Number.isFinite(center.y) || !(radius > 0)) return;
        damagePlayersInCircle(cctx, center, radius, damage);
      },
      roomBounds: { width: grid.pixelWidth, height: grid.pixelHeight },
      emit: (e: SimEvent) => {
        events.push(e);
      },
    };
  }

  /** Cherche une position libre pour un disque : la position demandée, puis 8 directions à 1, 2 puis 3 diamètres. */
  private findFreeSpot(pos: Vec2, radius: number, solids: readonly PixelRect[], flying: boolean): Vec2 | null {
    const grid = this.roomGrid;
    if (canOccupy(pos, radius, grid, solids, flying)) return { x: pos.x, y: pos.y };
    for (let ring = 1; ring <= 3; ring++) {
      for (let k = 0; k < 8; k++) {
        const a = (k * Math.PI) / 4;
        const cand = { x: pos.x + Math.cos(a) * radius * 2 * ring, y: pos.y + Math.sin(a) * radius * 2 * ring };
        if (canOccupy(cand, radius, grid, solids, flying)) return cand;
      }
    }
    return null;
  }

  private updateEnemies(dt: number, events: SimEvent[], cctx: CombatContext): void {
    const snapshot = this.aliveEnemies();
    const aliveList = snapshot.slice();
    const ctx = this.makeAIContext(dt, events, cctx, aliveList);
    for (const e of snapshot) {
      if (e.dead || e.hp <= 0) continue;
      const px = e.pos.x;
      const py = e.pos.y;
      updateEnemy(e, ctx);
      if (!Number.isFinite(e.pos.x) || !Number.isFinite(e.pos.y)) e.pos = { x: px, y: py };
      if (!Number.isFinite(e.hp)) e.hp = 0;
    }
  }

  // ── (j) Morts ──

  private collectDeaths(events: SimEvent[], killers: Map<number, PlayerId>): DeathRecord[] {
    const s = this.state;
    const deaths: DeathRecord[] = [];
    const remaining: EnemyState[] = [];
    for (const e of s.room.enemies) {
      if (!e.dead && e.hp > 0) {
        remaining.push(e);
        continue;
      }
      const byPlayer = killers.get(e.id) ?? null;
      events.push({ type: 'enemyDied', enemyId: e.id, kind: e.kind, pos: { x: e.pos.x, y: e.pos.y }, byPlayer });
      if (byPlayer !== null) {
        const killer = s.players.find((p) => p.id === byPlayer);
        if (killer) killer.kills += 1;
      }
      deaths.push({ kind: e.kind, byPlayer, roomId: s.room.roomId });
    }
    s.room.enemies = remaining;
    return deaths;
  }

  // ── (l) Sortie ──

  private checkExit(events: SimEvent[]): void {
    const s = this.state;
    const room = this.room;
    const alive = s.players.filter((p) => p.status === 'alive');
    if (alive.length === 0) return;
    if (!alive.every((p) => pointInTileRect(p.pos, room.exit.rect))) return;
    if (!this.isExitOpen()) return;
    if (!s.clearedRooms.includes(room.id)) s.clearedRooms.push(room.id);
    events.push({ type: 'roomCleared', roomId: room.id });
    if (this.isFinalRoom()) {
      s.phase = 'levelComplete';
      s.phaseTimerMs = 0;
      events.push({ type: 'levelCompleted', levelId: this.level.id });
    } else {
      s.phase = 'roomCleared';
      s.phaseTimerMs = 0;
    }
  }

  // ── (m) Mort d'équipe, transitions ──

  /** Déclenche la phase 'wipe' si tous les joueurs sont à terre (une seule fois). */
  private checkTeamWipe(events: SimEvent[]): void {
    const s = this.state;
    if (s.phase !== 'playing' || !isTeamWiped(s.players)) return;
    events.push({ type: 'teamWipe' });
    s.phase = 'wipe';
    s.phaseTimerMs = 0;
  }

  private updatePhases(events: SimEvent[]): void {
    const s = this.state;
    this.checkTeamWipe(events);
    if (s.phase === 'wipe' && s.phaseTimerMs >= WIPE_RESTART_DELAY_MS) {
      this.loadRoom(s.roomIndex, 'restart', events);
    } else if (s.phase === 'roomCleared' && s.phaseTimerMs >= ROOM_CLEAR_DELAY_MS) {
      this.loadRoom(s.roomIndex + 1, 'next', events);
    }
  }

  /**
   * Charge (ou recharge) une salle : état de salle neuf (ennemis, projectiles, mécanismes, apparitions), joueurs aux positions
   * de départ, clés vidées, phase 'playing', événement `roomEntered`, apparitions de la vague 0.
   *  - 'start'   : première salle ;
   *  - 'next'    : joueurs à terre relevés à PV pleins (`reviveAllDowned`), les autres gardent leurs PV ;
   *  - 'restart' : PV pleins pour tous, kills remis à zéro, objectifs non accomplis de la salle remis à zéro.
   */
  private loadRoom(index: number, reason: 'start' | 'next' | 'restart', events: SimEvent[]): void {
    const s = this.state;
    const room = this.level.rooms[index];
    if (!room) return;
    const spawns = spawnPixels(room);
    if (reason === 'restart') {
      resetPlayersForRoom(s.players, spawns, { resetKills: true });
      resetRoomObjectives(s.objectives, this.level, room.id);
    } else {
      reviveAllDowned(s.players);
      s.players.forEach((p, i) => {
        const sp = spawns[i % spawns.length];
        p.pos = { x: sp.x, y: sp.y };
        p.keys = [];
        p.moving = false;
        p.attackCooldownMs = 0;
        p.attackAnimMs = 0;
      });
    }
    // Salle de boss ou de demi-boss : après un redémarrage, les spéciaux ne sont pas prêts d'emblée (moitié de la recharge).
    const bossRoom = room.enemies.some((e) => isAnyBossKind(e.kind));
    for (const p of s.players) {
      const spCd = getCharacter(p.characterId).special?.cooldownMs ?? 0;
      p.specialCooldownMs = reason === 'restart' && bossRoom ? Math.round(spCd / 2) : 0;
      p.specialAnimMs = 0;
      p.torchMs = TORCH_MAX_MS; // torche pleine à l'entrée de chaque salle (start / next / restart)
      p.callMs = 0; // appel et délai remis à zéro à l'entrée de chaque salle (start / next / restart)
      p.callCooldownMs = 0;
    }
    if (reason !== 'start') {
      for (const p of s.players) p.invulnMs = Math.max(p.invulnMs, ROOM_ENTER_INVULN_MS);
    }
    s.roomIndex = index;
    this.roomGrid = new RoomGrid(room.layout);
    s.room = newRoomState(room, s.playerCount);
    s.phase = 'playing';
    s.phaseTimerMs = 0;
    events.push({ type: 'roomEntered', roomId: room.id, roomIndex: index, reason });
    this.spawnPending(events);
  }

  /** @internal Charge la salle initiale (appelé par `createSimulation`). */
  initialize(): void {
    this.loadRoom(this.state.roomIndex, 'start', this.pending);
  }
}

// ───────────────────────────── Fabrique ─────────────────────────────

/**
 * Crée une simulation neuve sur `level`. Les joueurs apparaissent sur les `playerSpawns` de la première salle, PV pleins
 * (indépendants de la difficulté). Les événements d'entrée (roomEntered 'start', enemySpawned…) sont renvoyés par le
 * premier appel à `step`.
 * `config.startRoomIndex` (reprise d'une sauvegarde, dev `?room=N`) : la simulation démarre dans cette salle (bornée à
 * [0, nbSalles - 1]) ; les salles précédentes sont marquées validées (`clearedRooms`) et les objectifs personnels qui leur
 * appartiennent sont considérés accomplis ; l'événement d'entrée est `roomEntered` 'start' avec le bon `roomIndex`.
 * @param config joueurs (1 à 4), graine du PRNG (`seed`), salle de départ optionnelle ; `config.levelId` est informatif (c'est `level.id` qui fait foi)
 * @param level définition du niveau (non mutée)
 * @throws Error si `config.players` est vide ou si le niveau n'a aucune salle
 */
export function createSimulation(config: SimConfig, level: LevelDef): GameSimulation {
  if (level.rooms.length === 0) throw new Error(`Le niveau ${level.id} n'a aucune salle`);
  const setups = normalizeSetups(config.players);
  const startIndex = resolveStartRoomIndex(config.startRoomIndex, level.rooms.length);
  const first = level.rooms[startIndex];
  const spawns = spawnPixels(first);
  const players = setups.map((setup, i) => createPlayerState(setup, spawns[i % spawns.length]));
  const state: GameState = {
    version: 1,
    tick: 0,
    timeMs: 0,
    rngState: seedToState(config.seed),
    nextEntityId: 1,
    levelId: level.id,
    playerCount: players.length,
    players,
    roomIndex: startIndex,
    phase: 'playing',
    phaseTimerMs: 0,
    room: newRoomState(first, players.length),
    objectives: createObjectives(level, players.length),
    clearedRooms: level.rooms.slice(0, startIndex).map((r) => r.id),
  };
  // Reprise : les objectifs personnels des salles précédentes sont considérés accomplis (ils persistent entre salles).
  if (startIndex > 0) {
    const before = new Set(state.clearedRooms);
    for (const o of state.objectives) {
      const def = level.objectives.find((d) => d.id === o.id);
      if (def && before.has(def.roomId)) {
        o.done = true;
        o.progress = 1;
      }
    }
  }
  const sim = new GameSimulation(state, level);
  sim.initialize();
  return sim;
}

/** Salle de départ valide : entier dans [0, roomCount - 1] ; absent ou non fini → 0. */
export function resolveStartRoomIndex(value: number | undefined, roomCount: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(Math.max(0, roomCount - 1), Math.floor(value)));
}

/** Pas fixe recommandé, réexporté pour les appelants. */
export const FIXED_STEP_MS = SIM_STEP_MS;
