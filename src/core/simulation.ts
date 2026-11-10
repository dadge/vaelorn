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
 *  (i2) sources de vie (phase 'playing', sim créée avec `loot` vrai) : vieillissement et péremption de la nourriture au sol, ramassage
 *      (`pickupCollected`) par le joueur vivant blessé le plus proche, usage des cristaux de soin (`crystalUsed`) ;
 *      AVEC `SimConfig.heartSlot` (`heartSlot.ts`) : d'abord l'usage VOLONTAIRE du cœur rangé par le front montant de `ActionFrame.heart` (B : `heartUsed` sur un allié blessé à portée, ou
 *      cristal de soin sous les pieds (`crystalUsed`), ou soi-même ; sinon `heartRefused`), puis le RANGEMENT du cœur / demi-cœur touché dans l'emplacement du joueur vivant le plus proche
 *      dont il est vide (`heartStored`, blessé ou non) ; aucune consommation au contact, le cristal ne soigne plus au contact ;
 *  (i3) équipement au sol (phase 'playing') : vieillissement / péremption des objets, verrous, ramassage automatique (`gearPicked`) par le joueur
 *      vivant le plus proche pour qui l'objet est STRICTEMENT meilleur (`gear.ts` `pickupDecision`) ;
 *  (i4) appel AUTOMATIQUE (phases 'playing' et 'roomCleared', option `SimConfig.autoCall`, 2 joueurs ou plus ; `autoCall.ts`, [B28]) : un joueur vivant qui chevauche un cœur qu'il ne
 *      peut pas prendre (PV pleins ; avec `heartSlot` : emplacement PLEIN, quels que soient les PV), un objet d'équipement qu'il ne prend pas (décision 'ignore') ou l'ancien accessoire qu'il vient de poser en
 *      l'ÉCHANGEANT à la main (verrou 'leave') prévient les alliés pour qui l'objet serait utile (`autoCallStarted`) ; un joueur qui tombe à 30 % de ses PV max ou moins demande des soins par la CROIX ROUGE
 *      (`icon: 'cross'`, aux alliés qui peuvent soigner : cœur rangé utilisable ou Valentine, [B30]).
 *      Purement informatif : ne fige personne, ne consomme pas le délai de l'appel manuel, aucun tirage aléatoire, aucun effet sur le jeu ;
 *  (j) morts d'ennemis (enemyDied, kills du tueur, retrait) ; BUTIN : chaque mort d'ennemi non invoqué tire son butin de vie avec le PRNG
 *      DÉDIÉ (`lootRngState`, jamais `rngState`) → `pickupDropped` (voir `loot.ts`, `balance.ts` [B10]-[B17]) ; puis, s'il ne laisse pas de cœur,
 *      son objet d'ÉQUIPEMENT avec le PRNG ISOLÉ `gearRngState` (budget par salle, `gear.ts`, [B18]-[B25]) → `gearDropped` ;
 *      un joueur TOMBÉ perd tout son équipement, éparpillé au sol et verrouillé pour lui (`gearLost`) : règle stricte, même à la défaite d'équipe ;
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
 *  - appel AUTOMATIQUE (`autoCall`, `autoCallCooldownMs`, `autoCallSeen`, `autoCallCross` : champs OPTIONNELS créés au déclenchement et supprimés à leur terme) : signal de 3 s qui
 *    NE fige PAS le joueur et ne touche pas aux champs de l'appel manuel ; un appel manuel qui démarre l'efface (`startCall`) ; remis à zéro à chaque entrée de salle et à la
 *    chute ; désactivé par `SimConfig.autoCall === false` (`GameState.autoCallDisabled`). Un état sans appel automatique est identique à celui d'avant son ajout.
 *  - sources de vie : nourriture (`room.pickups`) et cristaux (`room.healCrystals`) sont remis à zéro / à neuf à chaque entrée de salle (start /
 *    next / restart), comme le compteur anti-malchance (`lootDryKills`) ; leur flux aléatoire (`lootRngState`) et leurs ids (`nextPickupId`) sont
 *    DISTINCTS de ceux du reste de la partie : sans ramassage, une partie est strictement identique à celle d'avant leur ajout ;
 *  - emplacement CŒUR (`PlayerState.heart`, champ optionnel ; option `heartSlot`) : conservé d'une salle à l'autre comme l'équipement, réinitialisé avec la simulation (nouveau niveau) ;
 *    perdu à la chute (au combat, scénarisée, ou défaite d'équipe) mais le cœur tombe alors au sol aux pieds du joueur (`heartLost` puis `pickupDropped`) ; B ne fait rien hors phases 'playing' et 'roomCleared' (le rangement et B restent actifs pendant le délai de salle terminée),
 *    à terre, pendant le gel d'un appel manuel ni pendant un relevage ; `ActionFrame.heart` est un bouton DÉDIÉ (aucune autre action). Aucun tirage aléatoire : les flux restent identiques ;
 *  - équipement : conservé d'une salle à l'autre, perdu à la chute, réinitialisé avec la simulation (nouveau niveau) ; `room.gearDrops` et `room.gearBudget`
 *    sont remis à neuf à chaque entrée de salle (start / next / restart) ; le flux aléatoire (`gearRngState`) et les ids (`nextGearDropId`) sont ISOLÉS :
 *    sans ramassage, une partie est strictement identique à celle d'avant l'ajout de l'équipement (aux champs d'état supplémentaires près) ;
 *  - `knockDown(id)` (hors `IGameSimulation`, appelé ENTRE deux pas) : chute scénarisée du tutoriel, événement `playerDown` au pas suivant.
 */
import {
  GEAR_BUDGET_PER_PLAYER,
  GEAR_PICKUP_RADIUS,
  GEAR_SEED_XOR,
  GEAR_TTL_MS,
  HEAL_CRYSTAL_HEAL,
  HORN_RADIUS_PX,
  HEAL_CRYSTAL_RADIUS,
  LOOT_SEED_XOR,
  PICKUP_RADIUS,
  PICKUP_TTL_MS,
} from './balance';
import {
  DOWNED_THREAT_RADIUS,
  INTERACT_RANGE,
  PLAYER_RADIUS,
  TORCH_MAX_MS,
  REVIVE_RANGE,
  ROOM_CLEAR_DELAY_MS,
  SIM_STEP_MS,
  SUMMON_WAVE,
  WIPE_RESTART_DELAY_MS,
} from './constants';
import { normalizeAutoCallFields, stepAutoCalls, validGearItem } from './autoCall';
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
import { getEnemyDef, isAnyBossKind, isFlyingKind, isMiniBossKind } from './enemies';
import {
  addBuff,
  ageGearDrops,
  buffDurationMs,
  enemyGearWeight,
  equipItem,
  gearDropChance,
  hornBuffFor,
  magnetRadius,
  magnetStep,
  normalizeGear,
  pickupDecision,
  registerRingKill,
  rollBuffBudget,
  rollBuffDrop,
  rollGearDrop,
  scatterPoints,
  speedBonus,
  stripLoadout,
  swapCandidate,
  ensureLoadout,
} from './gear';
import { dirFromVec, distSq, pointInTileRect, tileCenter } from './geometry';
import { RoomGrid } from './grid';
import { canStoreHeart, heartCollectorFor, heartUseAmount, isHeartKind, normalizeHeartField, planHeartUse } from './heartSlot';
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
  resetAutoCall,
  cancelAutoCall,
  markPlayerDown,
  canStartCall,
  startCall,
  cancelCall,
  stepPlayerTorch,
  updateRevive,
} from './players';
import {
  agePickups,
  collectorFor,
  healAmountFor,
  isSummonedEnemy,
  lootChances,
  lootNeedMultiplier,
  lootTierOf,
  mostWoundedFraction,
  pickupHealValue,
  rollLoot,
} from './loot';
import { nextRandom, seedToState, type RngHolder } from './rng';
import { resolveSlot } from './slots';
import type {
  ActionFrame,
  EnemyAIContext,
  EnemyKind,
  EnemyState,
  GameState,
  BuffDropState,
  GearDropState,
  GearItem,
  HealCrystalState,
  IGameSimulation,
  LevelDef,
  PickupKind,
  PickupState,
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
/** Vague attribuée aux ennemis invoqués par l'IA (ne retardent pas les vagues suivantes, comptent pour 'clear', ne laissent aucun butin de vie) : définie dans `constants.ts`. */
export { SUMMON_WAVE };
// Types d'ennemis volants (fosses non bloquantes, voir `collision.ts`) : `isFlyingKind` (enemies.ts).

/** Durée maximale (ms) d'un pas : un `dtMs` plus grand est tronqué (le rendu doit appeler `step` plusieurs fois). */
export const MAX_STEP_MS = 100;

// ───────────────────────────── Utilitaires ─────────────────────────────

/** Frame d'entrées assainie : NaN → 0, axes bornés à [-1, 1] (±Infinity → ±1), booléens stricts. Frame absente = frame vide. */
export function sanitizeFrame(f: ActionFrame | undefined): ActionFrame {
  if (!f) return { moveX: 0, moveY: 0, attack: false, interact: false, revive: false, special: false, call: false, heart: false };
  const axis = (v: number): number => (Number.isNaN(v) ? 0 : Math.max(-1, Math.min(1, v)));
  return {
    moveX: axis(f.moveX),
    moveY: axis(f.moveY),
    attack: f.attack === true,
    interact: f.interact === true,
    revive: f.revive === true,
    special: f.special === true,
    call: f.call === true,
    heart: f.heart === true,
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

/**
 * États des cristaux de soin d'une salle : un par `HealCrystalDef` présent à ce nombre de joueurs (`minPlayers`), tous intacts ;
 * aucun si les sources de vie sont désactivées (`loot` faux).
 */
export function createHealCrystalStates(room: RoomDef, playerCount: number, lootEnabled: boolean): HealCrystalState[] {
  if (!lootEnabled) return [];
  return (room.healCrystals ?? []).filter((c) => (c.minPlayers ?? 1) <= playerCount).map((c) => ({ id: c.id, used: false }));
}

function newRoomState(room: RoomDef, playerCount: number, lootEnabled = true, gearEnabled = true): RoomState {
  return {
    roomId: room.id,
    enemies: [],
    projectiles: [],
    mechanisms: createRoomMechanisms(room, playerCount),
    spawnedSpawnIdx: [],
    elapsedMs: 0,
    pickups: [],
    healCrystals: createHealCrystalStates(room, playerCount, lootEnabled),
    gearDrops: [],
    gearBudget: gearEnabled ? playerCount * GEAR_BUDGET_PER_PLAYER : 0,
    buffDrops: [],
    buffBudget: 0, // tiré à l'entrée de la salle (`loadRoom`, PRNG isolé de l'équipement)
  };
}

/**
 * Compatibilité : pose les valeurs par défaut des champs de sources de vie absents (ancien snapshot, état construit à la main, saut de salle
 * des bots) — `lootEnabled` vrai, flux de butin dérivé de `rngState`, compteur 0, prochain id 1, aucun objet au sol, cristaux de la salle intacts.
 * N'écrase JAMAIS une valeur présente.
 */
function normalizeLootState(state: GameState, room: RoomDef | undefined): void {
  if (typeof state.lootEnabled !== 'boolean') state.lootEnabled = true;
  if (typeof state.lootRngState !== 'number' || !Number.isFinite(state.lootRngState)) {
    state.lootRngState = seedToState((state.rngState | 0) ^ LOOT_SEED_XOR);
  }
  if (typeof state.lootDryKills !== 'number' || !Number.isFinite(state.lootDryKills)) state.lootDryKills = 0;
  if (typeof state.nextPickupId !== 'number' || !Number.isFinite(state.nextPickupId)) state.nextPickupId = 1;
  if (!Array.isArray(state.room.pickups)) state.room.pickups = [];
  if (!Array.isArray(state.room.healCrystals)) {
    state.room.healCrystals = room ? createHealCrystalStates(room, state.playerCount, state.lootEnabled) : [];
  }
}

/**
 * Compatibilité : pose les valeurs par défaut des champs d'ÉQUIPEMENT absents (ancien snapshot, état construit à la main) — équipement actif,
 * flux dérivé de `rngState`, prochain id 1, aucun objet au sol, budget de la salle = nombre de joueurs, loadout vide pour chaque joueur.
 * N'écrase JAMAIS une valeur valide (un loadout présent est seulement normalisé).
 */
function normalizeGearState(state: GameState): void {
  if (typeof state.gearEnabled !== 'boolean') state.gearEnabled = true;
  // marqueur optionnel « pas de tirage d'équipement » (tutoriel) : tout ce qui n'est pas exactement `true` est supprimé (valeur hostile / ancien état)
  if (state.gearDropsDisabled !== undefined && state.gearDropsDisabled !== true) delete state.gearDropsDisabled;
  if (typeof state.gearRngState !== 'number' || !Number.isFinite(state.gearRngState)) {
    state.gearRngState = seedToState((state.rngState | 0) ^ GEAR_SEED_XOR);
  }
  if (typeof state.nextGearDropId !== 'number' || !Number.isFinite(state.nextGearDropId)) state.nextGearDropId = 1;
  if (!Array.isArray(state.room.gearDrops)) state.room.gearDrops = [];
  if (!Array.isArray(state.room.buffDrops)) state.room.buffDrops = [];
  if (typeof state.room.buffBudget !== 'number' || !Number.isFinite(state.room.buffBudget)) state.room.buffBudget = 0;
  if (typeof state.room.gearBudget !== 'number' || !Number.isFinite(state.room.gearBudget)) {
    state.room.gearBudget = state.gearEnabled ? state.playerCount * GEAR_BUDGET_PER_PLAYER : 0;
  }
  for (const p of state.players) ensureLoadout(p);
}

/** Objet d'équipement posable / équipable par script : emplacement et niveau connus, et pour un accessoire une sorte connue (une icône ET une règle de ramassage existent). */
function isValidGearItem(item: GearItem): boolean {
  return validGearItem(item) && (item.slot !== 'accessory' || item.accessory !== undefined);
}

// ───────────────────────────── Simulation ─────────────────────────────

/** Résultat de l'arbitrage d'action d'un pas (par joueur). */
interface Arbitration {
  /** Joueurs qui relèvent (ou tentent de relever) : immobiles, sans attaque ni interaction. */
  reviving: Set<PlayerId>;
  /** Front montant d'interaction arbitré. */
  interactPressed: Partial<Record<PlayerId, boolean>>;
  /** Joueurs dont l'appui d'action ÉCHANGE un accessoire ce pas (jamais en même temps qu'un mécanisme : un seul effet par appui). */
  swapPressed: Set<PlayerId>;
  /** Joueurs qui attaquent ce pas. */
  attacking: Set<PlayerId>;
  /** Joueurs dont le bouton de spécial vient d'être pressé (front montant) ce pas. */
  special: Set<PlayerId>;
  /** Joueurs dont l'appel est lancé CE pas (front montant accepté : vivant, libre, délai écoulé). */
  call: Set<PlayerId>;
  /** Joueurs dont le bouton B (utiliser le cœur) vient d'être pressé ce pas : front montant accepté (option `heartSlot`, phase 'playing', ni relevage ni appel ni gel d'appel). */
  heart: Set<PlayerId>;
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
  /** Adaptateur du PRNG DÉDIÉ au butin (lit / écrit `state.lootRngState`) : `nextRandom(this.lootRng)` ne touche jamais `state.rngState`. */
  private readonly lootRng: RngHolder;
  /** Adaptateur du PRNG ISOLÉ de l'équipement (lit / écrit `state.gearRngState`) : distinct de `rngState` ET de `lootRngState`. */
  private readonly gearRng: RngHolder;
  /** Ennemis morts de CE pas dont le butin est déjà tiré (voir `collectDeaths`) ; transitoire, jamais sérialisé. */
  private readonly deathHandled = new Set<EnemyState>();

  /** @internal Utiliser `createSimulation` ou `GameSimulation.restore`. */
  constructor(state: GameState, level: LevelDef, pendingEvents: SimEvent[] = []) {
    this.state = state;
    this.level = level;
    this.roomGrid = new RoomGrid(level.rooms[state.roomIndex].layout);
    this.pending = pendingEvents;
    normalizeLootState(state, level.rooms[state.roomIndex]);
    normalizeGearState(state);
    for (const p of state.players) normalizeAutoCallFields(p); // champs d'appel automatique : absents = valides, mal formés = supprimés
    for (const p of state.players) normalizeHeartField(p, state.heartSlot === true); // emplacement cœur : valeur inconnue = vide, sans l'option toujours vide
    this.gearRng = {
      get rngState(): number {
        return state.gearRngState as number;
      },
      set rngState(v: number) {
        state.gearRngState = v;
      },
    };
    this.lootRng = {
      get rngState(): number {
        return state.lootRngState as number;
      },
      set rngState(v: number) {
        state.lootRngState = v;
      },
    };
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
   * Mise à terre SCÉNARISÉE d'un joueur (tutoriel uniquement : démonstration du relevage et de la mort d'équipe).
   * À appeler ENTRE deux pas ; ignore l'invulnérabilité. Même effet qu'une chute au combat (`markPlayerDown`), et l'événement
   * `playerDown` sort au pas suivant. Retourne false (aucun effet) si la phase n'est pas 'playing', si l'id est inconnu ou si le joueur
   * est déjà à terre. Déterministe : mêmes entrées + mêmes appels au même tick = même état. (Si un réseau est ajouté, cet appel
   * devra devenir une entrée datée.)
   */
  knockDown(id: PlayerId): boolean {
    if (this.state.phase !== 'playing') return false;
    const p = this.state.players.find((q) => q.id === id);
    if (!p || p.status !== 'alive') return false;
    markPlayerDown(p);
    this.pending.push({ type: 'playerDown', playerId: id });
    this.loseGear(p, this.pending);
    return true;
  }

  /**
   * BLESSURE SCÉNARISÉE d'un joueur (tutoriel uniquement : démonstration du soin d'un coéquipier blessé, comme `knockDown`). À appeler ENTRE deux pas ; ramène les PV d'un joueur VIVANT à
   * `fraction` de ses PV max (au moins 1, jamais à terre, ne soigne jamais : sans effet s'il est déjà plus bas). Retourne false (aucun effet) si la phase n'est pas 'playing', si l'id est
   * inconnu, si le joueur n'est pas vivant ou si ses PV sont déjà <= la cible. Déterministe.
   */
  woundPlayer(id: PlayerId, fraction: number): boolean {
    if (this.state.phase !== 'playing') return false;
    const p = this.state.players.find((q) => q.id === id);
    if (!p || p.status !== 'alive' || !Number.isFinite(fraction)) return false;
    const target = Math.max(1, Math.floor(p.maxHp * Math.max(0, Math.min(1, fraction))));
    if (p.hp <= target) return false;
    p.hp = target;
    return true;
  }

  /**
   * Cœur / demi-cœur SCÉNARISÉ posé au sol (tutoriel uniquement), avec une durée de vie longue (`ttlMs`) pour qu'il ne disparaisse pas pendant la lecture de la consigne. Événement
   * `pickupDropped` au pas suivant. À appeler ENTRE deux pas ; retourne false hors phase 'playing'. Ne tire AUCUN flux aléatoire.
   */
  spawnScriptedHeart(pos: Vec2, kind: PickupKind, ttlMs: number): boolean {
    if (this.state.phase !== 'playing' || !isHeartKind(kind) || !Number.isFinite(ttlMs) || !(ttlMs > 0)) return false;
    this.addPickup(kind, this.findPickupSpot(pos), ttlMs, this.pending);
    return true;
  }

  /**
   * Range d'office un cœur / demi-cœur dans l'emplacement d'un joueur VIVANT (tutoriel uniquement : de quoi soigner pour la démonstration de la croix rouge). Ne remplace JAMAIS un cœur déjà rangé (retourne alors
   * false, rien ne change). Retourne false sans l'option `heartSlot`, hors phase 'playing', pour un joueur inconnu ou à terre ou un genre de cœur inconnu. Aucun événement, aucun tirage aléatoire.
   */
  giveScriptedHeart(id: PlayerId, kind: PickupKind): boolean {
    if (this.state.phase !== 'playing' || this.state.heartSlot !== true || !isHeartKind(kind)) return false;
    const p = this.state.players.find((q) => q.id === id);
    if (!p || !canStoreHeart(p)) return false;
    p.heart = kind;
    return true;
  }

  /**
   * Objet d'ÉQUIPEMENT SCÉNARISÉ posé au sol (tutoriel uniquement : démonstration de l'appel après un objet refusé ou un échange d'accessoire), avec une durée de vie longue (`ttlMs`) pour qu'il ne disparaisse pas pendant
   * la lecture de la consigne. Non verrouillé. Événement `gearDropped` au pas suivant. À appeler ENTRE deux pas ; retourne false hors phase 'playing' ou pour un objet invalide (emplacement / niveau inconnu, accessoire
   * sans sorte). Ne tire AUCUN flux aléatoire.
   */
  spawnScriptedGear(pos: Vec2, item: GearItem, ttlMs: number): boolean {
    if (this.state.phase !== 'playing' || !isValidGearItem(item) || !Number.isFinite(ttlMs) || !(ttlMs > 0)) return false;
    this.addGearDrop({ ...item }, this.findPickupSpot(pos), null, 'life', false, this.pending, ttlMs);
    return true;
  }

  /**
   * ÉQUIPE un joueur d'un objet (tutoriel uniquement : lui donner de quoi refuser un objet moins bon ou échanger un accessoire). À appeler ENTRE deux pas ; retourne false (aucun effet) hors phase 'playing', pour un
   * joueur inconnu ou à terre, ou pour un objet invalide. Remplace l'objet de l'emplacement (même règle que `equipItem`). Aucun événement, aucun tirage aléatoire.
   */
  equipScripted(id: PlayerId, item: GearItem): boolean {
    if (this.state.phase !== 'playing' || !isValidGearItem(item)) return false;
    const p = this.state.players.find((q) => q.id === id);
    if (!p || p.status !== 'alive') return false;
    equipItem(p.loadout, item);
    return true;
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

    // (i2) sources de vie : nourriture au sol (vieillissement, ramassage) et cristaux de soin
    if (s.phase === 'playing' || s.phase === 'roomCleared') this.stepMagnets(dt);
    // Avec l'emplacement cœur, B et le rangement fonctionnent AUSSI pendant le délai de 'roomCleared' (les PV passent à la salle suivante : se soigner et ranger le cœur du dernier ennemi ont encore un sens) ;
    // sans l'option, l'ancien comportement (phase 'playing' seulement) est conservé tel quel.
    if (s.phase === 'playing' || (s.heartSlot === true && s.phase === 'roomCleared')) {
      if (s.heartSlot === true) this.stepHeartUse(arb, events); // B : usage volontaire, AVANT le rangement (un emplacement libéré ce pas peut ranger l'objet sous les pieds)
      this.stepLifeSources(dt, events);
    }

    // (i3) équipement au sol : vieillissement, verrous, ramassage
    // (aussi pendant 'roomCleared' : l'objet laissé par le dernier ennemi reste ramassable et vieillit pendant le délai avant la salle suivante)
    if (s.phase === 'playing' || s.phase === 'roomCleared') this.stepGear(dt, events, arb);

    // (i4) appel automatique : objets au sol qu'un joueur ne prend pas (après les ramassages : un objet pris a disparu). Aussi en 'roomCleared' : l'équipement y reste
    // ramassable (le butin du dernier ennemi) et le signal d'un objet pris pendant ce délai doit être purgé.
    if ((s.phase === 'playing' || s.phase === 'roomCleared') && s.autoCallDisabled !== true) {
      stepAutoCalls(players, s.room.pickups as PickupState[], s.room.gearDrops as GearDropState[], events, { heartSlot: s.heartSlot === true });
    }

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

    // garde-fou : tout joueur à terre est dépouillé de son équipement (quelle que soit la cause de la chute), AVANT la mort d'équipe / le redémarrage
    for (const p of players) if (p.status === 'down') this.loseGear(p, events);

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
      if (s.heartSlot === true) p.prev.heart = f.heart === true; // posé seulement avec l'option : sans elle l'état reste celui d'avant l'ajout
      if (p.status !== 'alive') {
        cancelAutoCall(p);
        cancelCall(p);
      } // garde-fou : un joueur à terre n'appelle pas (quelle que soit la cause de la chute)
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
    const arb: Arbitration = { reviving: new Set(), interactPressed: {}, swapPressed: new Set(), attacking: new Set(), special: new Set(), call: new Set(), heart: new Set() };
    const heartSlot = this.state.heartSlot === true;
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
      if (!playing) {
        // délai de 'roomCleared' : seul B (utiliser le cœur) reste actif, front montant comme en jeu
        if (heartSlot && this.state.phase === 'roomCleared' && f.heart === true && p.prev.heart !== true) arb.heart.add(p.id);
        continue;
      }
      // Appel : front montant, joueur libre (délai écoulé, pas d'appel en cours). Il prime sur le reste du pas (immobilisation immédiate).
      if (f.call === true && p.prev.call !== true && canStartCall(p)) {
        arb.call.add(p.id);
        continue;
      }
      // B (utiliser le cœur) : bouton DÉDIÉ, front montant ; il n'a lieu ni pendant un relevage (A prioritaire, `continue` ci-dessus), ni avec un appel accepté ce pas, ni pendant le gel d'un appel.
      if (heartSlot && f.heart === true && p.prev.heart !== true) arb.heart.add(p.id);
      if (f.special === true && p.prev.special !== true) arb.special.add(p.id);
      const pressed = f.interact && !p.prev.interact;
      if (pressed) arb.interactPressed[p.id] = true;
      // L'attaque n'est supprimée que sur le front montant qui actionne réellement un mécanisme : un bouton maintenu
      // continue d'attaquer, un nouvel appui près d'un levier l'actionne sans attaquer.
      // Un seul effet par appui : un mécanisme à portée prime sur l'échange d'accessoire ; comme un levier, l'échange manuel n'attaque pas non plus.
      const mech = pressed && this.interactableNear(p);
      const swap = pressed && !mech && swapCandidate(this.state.room.gearDrops as GearDropState[], p) !== null;
      if (swap) arb.swapPressed.add(p.id);
      if (f.attack && !(mech || swap)) arb.attacking.add(p.id);
    }
    return arb;
  }

  /** Lance les appels acceptés par l'arbitrage (`callMs`, `callCooldownMs`) et émet `callStarted`. */
  private startCalls(arb: Arbitration, events: SimEvent[]): void {
    for (const p of this.state.players) {
      if (!arb.call.has(p.id)) continue;
      startCall(p);
      events.push({ type: 'callStarted', playerId: p.id });
      this.applyHorn(p, events);
    }
  }

  /**
   * Cor de guerre : l'APPEL de son porteur donne aux alliés VIVANTS proches (`HORN_RADIUS_PX`, centre à centre) un bonus de vitesse de 3 s (+20 / +30 / +40 % selon
   * le niveau), jamais à l'appelant lui-même ; ne se cumule pas avec les autres sources temporaires de vitesse (voir `speedBonus`). Émet `buffStarted` par allié.
   */
  private applyHorn(caller: PlayerState, events: SimEvent[]): void {
    const proto = hornBuffFor(caller.loadout);
    if (!proto) return;
    const r2 = HORN_RADIUS_PX * HORN_RADIUS_PX;
    for (const ally of this.state.players) {
      if (ally.id === caller.id || ally.status !== 'alive' || distSq(ally.pos, caller.pos) > r2) continue;
      addBuff(ally.loadout, { ...proto });
      events.push({ type: 'buffStarted', playerId: ally.id, kind: 'horn', durationMs: proto.remainingMs, fromPlayerId: caller.id, pos: { x: ally.pos.x, y: ally.pos.y } });
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
      const speed = getCharacter(p.characterId).speed * (1 + speedBonus(p.loadout)) * amplitude;
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
      onPlayerDowned: (player) => {
        sim.loseGear(player, events); // l'équipement est perdu AVANT le test de mort d'équipe (règle stricte)
        sim.checkTeamWipe(events);
      },
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
    // morts du même pas déjà traitées : les autres (encore à traiter) comptent comme « restantes » dans la répartition du budget d'équipement (pondération respectée)
    this.deathHandled.clear();
    for (const e of s.room.enemies) {
      if (!e.dead && e.hp > 0) {
        remaining.push(e);
        continue;
      }
      const byPlayer = killers.get(e.id) ?? null;
      events.push({ type: 'enemyDied', enemyId: e.id, kind: e.kind, pos: { x: e.pos.x, y: e.pos.y }, byPlayer });
      const heart = this.dropLoot(e, events);
      const gearChance = this.dropGear(e, heart, events);
      this.dropBuff(e, heart, gearChance, events);
      this.deathHandled.add(e);
      if (byPlayer !== null) {
        const killer = s.players.find((p) => p.id === byPlayer);
        if (killer) {
          killer.kills += 1;
          this.vampireKill(killer, e, events);
        }
      }
      deaths.push({ kind: e.kind, byPlayer, roomId: s.room.roomId });
    }
    this.deathHandled.clear();
    s.room.enemies = remaining;
    return deaths;
  }

  // ── Sources de vie : butin des ennemis, ramassage, cristaux ──

  /**
   * Butin de vie d'un ennemi qui vient de mourir (voir `loot.ts`) : tire avec le PRNG dédié, met à jour le compteur anti-malchance et, le cas
   * échéant, pose une nourriture au sol (`pickupDropped`). Sans effet hors phase 'playing' ou si les sources de vie sont désactivées.
   * Les ennemis invoqués (vague `SUMMON_WAVE`) et les boss finaux ne laissent rien ; un demi-boss laisse toujours un cœur entier.
   */
  private dropLoot(e: EnemyState, events: SimEvent[]): { heart: boolean; chance: number } {
    const s = this.state;
    const none = { heart: false, chance: 0 };
    if (s.lootEnabled === false || s.phase !== 'playing') return none;
    const tier = isSummonedEnemy(e) ? 'none' : lootTierOf(e.kind);
    // probabilité de cœur de CET ennemi (avant le tirage) : sert à compenser l'exclusion mutuelle cœur / objet d'équipement
    const chance = tier === 'none' ? 0 : tier === 'miniBoss' ? 1 : lootChances(tier, lootNeedMultiplier(mostWoundedFraction(s.players))).total;
    const res = rollLoot({
      kind: e.kind,
      summoned: isSummonedEnemy(e),
      hurtFraction: mostWoundedFraction(s.players),
      dryKills: s.lootDryKills ?? 0,
      random: () => nextRandom(this.lootRng),
    });
    s.lootDryKills = res.dryKills;
    if (res.drop === null) return { heart: false, chance };
    const id = s.nextPickupId ?? 1;
    s.nextPickupId = id + 1;
    const pos = this.findPickupSpot(e.pos);
    (s.room.pickups as PickupState[]).push({ id, kind: res.drop, pos, ttlMs: PICKUP_TTL_MS });
    events.push({ type: 'pickupDropped', pickupId: id, kind: res.drop, pos: { x: pos.x, y: pos.y } });
    return { heart: true, chance };
  }

  // ── Équipement : butin des ennemis, éparpillement, ramassage ──

  /** Somme des poids d'équipement des ennemis ORDINAIRES restants (vivants non invoqués + apparitions en attente) et nombre de demi-boss restants, hors `except`. */
  private remainingGearWeights(except: EnemyState): { weight: number; miniBosses: number } {
    const s = this.state;
    let weight = 0;
    let miniBosses = 0;
    for (const o of s.room.enemies) {
      if (o === except || this.deathHandled.has(o) || isSummonedEnemy(o)) continue;
      weight += enemyGearWeight(o.kind);
      if (isMiniBossKind(o.kind)) miniBosses++;
    }
    const spawned = s.room.spawnedSpawnIdx;
    this.room.enemies.forEach((def, i) => {
      if ((def.minPlayers ?? 1) > s.playerCount || spawned.includes(i)) return;
      weight += enemyGearWeight(def.kind);
      if (isMiniBossKind(def.kind)) miniBosses++;
    });
    return { weight, miniBosses };
  }

  /**
   * Objet d'ÉQUIPEMENT d'un ennemi qui vient de mourir (voir `gear.ts` `rollGearDrop`) : budget par salle, tirage sur le PRNG ISOLÉ
   * `gearRngState`, pas d'objet si l'ennemi laisse déjà un cœur (`heart`). Sans effet hors phase 'playing' ou si l'équipement est désactivé.
   */
  private dropGear(e: EnemyState, heart: { heart: boolean; chance: number }, events: SimEvent[]): { dropped: boolean; chance: number } {
    const s = this.state;
    const none = { dropped: false, chance: 0 };
    if (s.gearEnabled === false || s.gearDropsDisabled === true || s.phase !== 'playing') return none;
    const budget = s.room.gearBudget ?? 0;
    if (!(budget > 0)) return none;
    const rest = this.remainingGearWeights(e);
    const own = enemyGearWeight(e.kind);
    // probabilité d'objet de CET ennemi (sert à compenser l'exclusion mutuelle avec le bonus temporaire) ; le demi-boss en laisse toujours un
    const chance = isMiniBossKind(e.kind) ? 1 : gearDropChance({ kind: e.kind, budget, reservedForMiniBosses: rest.miniBosses, weightLeft: own + rest.weight, heartChance: heart.chance });
    const item = rollGearDrop({
      kind: e.kind,
      summoned: isSummonedEnemy(e),
      hasHeart: heart.heart,
      heartChance: heart.chance,
      budget,
      reservedForMiniBosses: rest.miniBosses,
      weightLeft: own + rest.weight,
      playerCount: s.playerCount,
      players: s.players,
      random: () => nextRandom(this.gearRng),
    });
    if (!item) return { dropped: false, chance };
    s.room.gearBudget = budget - 1;
    // un cœur laissé au même endroit : l'objet est posé à côté pour rester lisible
    const origin = heart.heart ? { x: e.pos.x + 9, y: e.pos.y } : e.pos;
    this.addGearDrop(item, this.findPickupSpot(origin), null, 'life', false, events);
    return { dropped: true, chance };
  }

  /**
   * Bonus TEMPORAIRE d'un ennemi qui vient de mourir (voir `gear.ts` `rollBuffDrop`) : petit budget entier de la salle (~0,3 par héros, tiré à l'entrée), même
   * répartition que l'équipement, exclusif avec le cœur et l'objet d'équipement de cet ennemi (probabilité compensée). PRNG isolé de l'équipement.
   */
  private dropBuff(e: EnemyState, heart: { heart: boolean; chance: number }, gear: { dropped: boolean; chance: number }, events: SimEvent[]): void {
    const s = this.state;
    if (s.gearEnabled === false || s.gearDropsDisabled === true || s.phase !== 'playing') return;
    const budget = s.room.buffBudget ?? 0;
    if (!(budget > 0)) return;
    const rest = this.remainingGearWeights(e);
    const kind = rollBuffDrop({
      kind: e.kind,
      summoned: isSummonedEnemy(e),
      hasDrop: heart.heart || gear.dropped,
      otherDropChance: heart.chance + (1 - heart.chance) * Math.min(1, gear.chance),
      budget,
      weightLeft: enemyGearWeight(e.kind) + rest.weight,
      random: () => nextRandom(this.gearRng),
    });
    if (!kind) return;
    s.room.buffBudget = budget - 1;
    const pos = this.findPickupSpot({ x: e.pos.x - 9, y: e.pos.y });
    const id = s.nextGearDropId ?? 1;
    s.nextGearDropId = id + 1;
    (s.room.buffDrops as BuffDropState[]).push({ id, kind, pos: { x: pos.x, y: pos.y }, ttlMs: GEAR_TTL_MS });
    events.push({ type: 'buffDropped', dropId: id, kind, pos: { x: pos.x, y: pos.y } });
  }

  /** Anneau du vampire : un ennemi NON invoqué tué par le porteur compte ; tous les 3, +1 PV (plafonné aux PV max). Émet `vampireHeal`. */
  private vampireKill(killer: PlayerState, e: EnemyState, events: SimEvent[]): void {
    if (killer.status !== 'alive' || isSummonedEnemy(e)) return;
    const heal = registerRingKill(killer.loadout);
    if (heal <= 0) return;
    const healed = Math.max(0, Math.min(heal, killer.maxHp - killer.hp));
    killer.hp += healed;
    if (healed > 0) events.push({ type: 'vampireHeal', playerId: killer.id, healed, pos: { x: killer.pos.x, y: killer.pos.y } });
  }

  /** Pose un objet d'équipement au sol et émet `gearDropped`. */
  private addGearDrop(item: GearItem, pos: Vec2, lockedFor: PlayerId | null, lockMode: 'life' | 'leave', scattered: boolean, events: SimEvent[], ttlMs: number = GEAR_TTL_MS): void {
    const s = this.state;
    const id = s.nextGearDropId ?? 1;
    s.nextGearDropId = id + 1;
    (s.room.gearDrops as GearDropState[]).push({ id, item, pos: { x: pos.x, y: pos.y }, ttlMs, lockedFor, lockMode });
    events.push({ type: 'gearDropped', dropId: id, item, pos: { x: pos.x, y: pos.y }, scattered });
  }

  /**
   * Un joueur TOMBÉ perd TOUT : les 6 emplacements et les bonus temporaires. L'équipement perdu est ÉPARPILLÉ autour de lui (`scatterPoints`, ramené sur des
   * cases praticables), 20 s au sol (`GEAR_TTL_MS`), VERROUILLÉ pour lui (il ne peut pas les reprendre) ; ses alliés les ramassent s'ils sont meilleurs que
   * les leurs. Règle stricte : aussi à la défaite d'équipe (pas de point de reprise). Idempotent : sans équipement, ne fait rien. Émet `gearLost` puis `gearDropped`.
   */
  private loseGear(p: PlayerState, events: SimEvent[]): void {
    this.loseHeart(p, events); // le cœur rangé est perdu avec l'équipement (mais tombe au sol) : même garde-fou, même idempotence
    const hadBuffs = p.loadout.buffs.length > 0;
    const lost = stripLoadout(p.loadout);
    if (lost.length === 0) {
      if (hadBuffs) p.loadout.buffs = [];
      return;
    }
    events.push({ type: 'gearLost', playerId: p.id, items: lost, pos: { x: p.pos.x, y: p.pos.y } });
    const points = scatterPoints(p.pos, lost.length);
    lost.forEach((item, i) => this.addGearDrop(item, this.findPickupSpot(points[i]), p.id, 'life', true, events));
  }

  /**
   * Pas de l'équipement au sol (phase 'playing') : vieillissement et péremption (`GEAR_TTL_MS`) des objets et des bonus temporaires, levée des verrous
   * 'leave', ÉCHANGE MANUEL d'accessoire (le joueur qui appuie sur l'action avec un objet échangeable à portée : `swapCandidate`), puis ramassage objet par objet
   * par le joueur VIVANT le plus proche (égalité : plus petit id) dans `GEAR_PICKUP_RADIUS` pour qui l'objet n'est pas verrouillé et ne peut pas être
   * ignoré (`pickupDecision` : strictement meilleur ; accessoire : emplacement vide ou même sorte de niveau supérieur). L'ancien objet de l'emplacement
   * disparaît (sauf l'accessoire échangé à la main, lâché au sol). Un objet que personne ne peut prendre reste au sol. Les bonus temporaires sont ramassés
   * par le joueur vivant le plus proche.
   */
  private stepGear(dt: number, events: SimEvent[], arb: Arbitration): void {
    const s = this.state;
    const drops = s.room.gearDrops as GearDropState[];
    const buffDrops = s.room.buffDrops as BuffDropState[];
    if (drops.length === 0 && buffDrops.length === 0) return;
    ageGearDrops(drops, dt);
    ageGearDrops(buffDrops, dt);
    const r2 = GEAR_PICKUP_RADIUS * GEAR_PICKUP_RADIUS;
    for (const d of drops) {
      // verrou « tant que le joueur n'a pas quitté le rayon » : levé dès qu'il en sort (ou s'il est à terre / absent)
      if (d.lockMode === 'leave' && d.lockedFor !== null) {
        const owner = s.players.find((q) => q.id === d.lockedFor);
        if (!owner || owner.status !== 'alive' || distSq(owner.pos, d.pos) > r2) d.lockedFor = null;
      }
    }
    // échange manuel d'accessoire (priorité : relevage > interaction / échange > attaque, voir `arbitrate`)
    for (const p of s.players) {
      if (!arb.swapPressed.has(p.id)) continue;
      const cand = swapCandidate(drops, p);
      if (cand) this.swapAccessory(p, cand, drops, events);
    }
    for (let i = 0; i < drops.length; ) {
      const d = drops[i];
      let best: PlayerState | null = null;
      let bestD = Infinity;
      for (const p of s.players) {
        if (p.status !== 'alive' || d.lockedFor === p.id) continue;
        const dd = distSq(p.pos, d.pos);
        if (dd > r2 || dd >= bestD) continue;
        const decision = pickupDecision(p.loadout, d.item);
        if (decision !== 'equip' && decision !== 'upgrade') continue; // 'swap' : échange manuel (action A), 'ignore' : reste au sol
        best = p;
        bestD = dd;
      }
      if (!best) {
        i++;
        continue;
      }
      const replaced = equipItem(best.loadout, d.item);
      drops.splice(i, 1);
      events.push({ type: 'gearPicked', dropId: d.id, playerId: best.id, item: d.item, replaced, pos: { x: d.pos.x, y: d.pos.y } });
    }
    for (let i = 0; i < buffDrops.length; ) {
      const d = buffDrops[i];
      let best: PlayerState | null = null;
      let bestD = Infinity;
      for (const p of s.players) {
        if (p.status !== 'alive') continue;
        const dd = distSq(p.pos, d.pos);
        if (dd > r2 || dd >= bestD) continue;
        best = p;
        bestD = dd;
      }
      if (!best) {
        i++;
        continue;
      }
      const durationMs = buffDurationMs(d.kind);
      addBuff(best.loadout, { kind: d.kind, remainingMs: durationMs });
      buffDrops.splice(i, 1);
      events.push({ type: 'buffStarted', playerId: best.id, kind: d.kind, durationMs, pos: { x: d.pos.x, y: d.pos.y } });
    }
  }

  /**
   * Échange MANUEL d'accessoire : `p` équipe l'accessoire au sol `d` (d'une AUTRE sorte que le sien) et LÂCHE l'ancien à ses pieds (20 s, clignotement). L'ancien est
   * VERROUILLÉ pour `p` tant qu'il n'a pas quitté son rayon (pas d'échange infini) ; un allié peut le prendre. Émet `gearSwapped` puis `gearDropped`.
   */
  private swapAccessory(p: PlayerState, d: GearDropState, drops: GearDropState[], events: SimEvent[]): void {
    const idx = drops.indexOf(d);
    if (idx < 0) return;
    drops.splice(idx, 1);
    const old = equipItem(p.loadout, d.item);
    events.push({ type: 'gearSwapped', playerId: p.id, item: d.item, dropped: old ?? d.item, pos: { x: d.pos.x, y: d.pos.y } });
    if (old) this.addGearDrop(old, this.findPickupSpot(p.pos), p.id, 'leave', false, events);
  }

  /**
   * Aimant à cœurs : chaque joueur vivant qui le porte tire vers lui, à `MAGNET_PULL_SPEED`, dans son rayon (50 / 80 / 120 px) : les cœurs (s'il est blessé), les
   * objets d'équipement qu'il peut ramasser (non verrouillés pour lui, 'equip' ou 'upgrade') et les bonus temporaires. Un objet visé par plusieurs aimants va vers
   * le plus proche. Le déplacement respecte les murs (glissement sur un axe). Sans aimant : aucun effet (ni coût, ni changement d'état).
   * Co-op : l'aimant ne « vole » pas un objet à un allié mieux placé : si un autre joueur vivant qui pourrait le prendre (même critère) est PLUS PROCHE de l'objet
   * que le porteur (égalité : le plus petit id, comme le ramassage), l'objet n'est pas tiré (la traction, 110 px/s, dépasse la vitesse de tous les héros).
   */
  private stepMagnets(dt: number): void {
    const s = this.state;
    const magnets: { p: PlayerState; r: number }[] = [];
    for (const p of s.players) {
      if (p.status !== 'alive') continue;
      const r = magnetRadius(p.loadout);
      if (r > 0) magnets.push({ p, r });
    }
    if (magnets.length === 0) return;
    const solids = this.solidRects();
    const grid = this.roomGrid;
    const pull = (pos: Vec2, eligible: (p: PlayerState) => boolean): void => {
      let target: PlayerState | null = null;
      let bestD = Infinity;
      for (const m of magnets) {
        if (!eligible(m.p)) continue;
        const dd = distSq(m.p.pos, pos);
        if (dd > m.r * m.r || dd >= bestD) continue;
        target = m.p;
        bestD = dd;
      }
      if (!target) return;
      // un allié éligible mieux placé (plus proche, ou à égalité de distance avec un plus petit id) garde la priorité : pas de traction
      for (const o of s.players) {
        if (o === target || o.status !== 'alive' || !eligible(o)) continue;
        const od = distSq(o.pos, pos);
        if (od < bestD || (od === bestD && o.id < target.id)) return;
      }
      const next = magnetStep(pos, target.pos, dt);
      const tries: Vec2[] = [next, { x: next.x, y: pos.y }, { x: pos.x, y: next.y }];
      for (const c of tries) {
        if (canOccupy(c, 4, grid, solids, false)) {
          pos.x = c.x;
          pos.y = c.y;
          return;
        }
      }
    };
    // l'aimant ne tire un cœur que vers un porteur qui peut s'en servir : blessé (comportement d'origine) ; avec l'emplacement cœur : qui peut le RANGER (emplacement vide)
    const heartSlot = s.heartSlot === true;
    for (const pk of s.room.pickups as PickupState[]) pull(pk.pos, heartSlot ? (p) => p.heart === undefined : (p) => p.hp < p.maxHp);
    for (const d of s.room.gearDrops as GearDropState[]) {
      pull(d.pos, (p) => {
        if (d.lockedFor === p.id) return false;
        const decision = pickupDecision(p.loadout, d.item);
        return decision === 'equip' || decision === 'upgrade';
      });
    }
    for (const d of s.room.buffDrops as BuffDropState[]) pull(d.pos, () => true);
  }

  /**
   * Position de pose d'une nourriture : celle de l'ennemi si un joueur peut y marcher, sinon la plus proche position praticable (anneaux
   * croissants de 8 px : un ennemi volant qui meurt au-dessus d'une fosse ne laisse pas un objet inatteignable). Déterministe.
   */
  private findPickupSpot(pos: Vec2): Vec2 {
    const solids = this.solidRects();
    const grid = this.roomGrid;
    const r = 4;
    if (canOccupy(pos, r, grid, solids, false)) return { x: pos.x, y: pos.y };
    for (let ring = 1; ring <= 16; ring++) {
      for (let k = 0; k < 16; k++) {
        const a = (k * Math.PI) / 8;
        const cand = { x: pos.x + Math.cos(a) * ring * 8, y: pos.y + Math.sin(a) * ring * 8 };
        if (canOccupy(cand, r, grid, solids, false)) return cand;
      }
    }
    return { x: pos.x, y: pos.y };
  }

  /**
   * Pas des sources de vie (phase 'playing') : les objets au sol vieillissent (périmés à `ttlMs` <= 0) puis, un par un, chaque objet est ramassé
   * par le joueur VIVANT blessé le plus proche dans `PICKUP_RADIUS` (soin = min(valeur, manque), `pickupCollected`) ; un joueur aux PV pleins
   * ou à terre ne ramasse rien (l'objet reste pour un allié). Puis chaque cristal de soin intact est utilisé par le joueur vivant blessé le plus
   * proche dans `HEAL_CRYSTAL_RADIUS` (`HEAL_CRYSTAL_HEAL` PV plafonnés au manque, usage unique, `crystalUsed`).
   */
  private stepLifeSources(dt: number, events: SimEvent[]): void {
    const s = this.state;
    const pickups = s.room.pickups as PickupState[];
    const heartSlot = s.heartSlot === true;
    if (pickups.length > 0) {
      agePickups(pickups, dt);
      for (let i = 0; i < pickups.length; ) {
        const pk = pickups[i];
        if (heartSlot) {
          // EMPLACEMENT CŒUR : le joueur vivant à l'emplacement VIDE le plus proche RANGE l'objet (blessé ou non, aucun soin) ; emplacement plein : il reste au sol
          const keeper = heartCollectorFor(s.players, pk.pos, PICKUP_RADIUS);
          if (!keeper) {
            i++;
            continue;
          }
          keeper.heart = pk.kind;
          pickups.splice(i, 1);
          events.push({ type: 'heartStored', playerId: keeper.id, pickupId: pk.id, kind: pk.kind, pos: { x: pk.pos.x, y: pk.pos.y } });
          continue;
        }
        const p = collectorFor(s.players, pk.pos, PICKUP_RADIUS);
        if (!p) {
          i++;
          continue;
        }
        const healed = healAmountFor(p, pickupHealValue(pk.kind));
        p.hp = Math.min(p.maxHp, p.hp + healed);
        pickups.splice(i, 1);
        events.push({ type: 'pickupCollected', pickupId: pk.id, playerId: p.id, kind: pk.kind, healed, pos: { x: pk.pos.x, y: pk.pos.y } });
      }
    }
    if (heartSlot) return; // le cristal de soin est VOLONTAIRE avec l'emplacement cœur : il ne soigne plus au contact (voir `stepHeartUse`)
    const crystals = s.room.healCrystals as HealCrystalState[];
    for (const cs of crystals) {
      if (cs.used) continue;
      const def = (this.room.healCrystals ?? []).find((c) => c.id === cs.id);
      if (!def) continue;
      const pos = tileCenter(def.tile[0], def.tile[1]);
      const p = collectorFor(s.players, pos, HEAL_CRYSTAL_RADIUS);
      if (!p) continue;
      const healed = healAmountFor(p, HEAL_CRYSTAL_HEAL);
      p.hp = Math.min(p.maxHp, p.hp + healed);
      cs.used = true;
      events.push({ type: 'crystalUsed', crystalId: cs.id, playerId: p.id, healed, pos: { x: pos.x, y: pos.y } });
    }
  }

  /** Cristal de soin INTACT le plus proche de `p` dans `HEAL_CRYSTAL_RADIUS` (id), ou null. */
  private crystalUnderfoot(p: PlayerState): string | null {
    let best: string | null = null;
    let bestD = Infinity;
    const r2 = HEAL_CRYSTAL_RADIUS * HEAL_CRYSTAL_RADIUS;
    for (const cs of this.state.room.healCrystals as HealCrystalState[]) {
      if (cs.used) continue;
      const def = (this.room.healCrystals ?? []).find((c) => c.id === cs.id);
      if (!def) continue;
      const d = distSq(p.pos, tileCenter(def.tile[0], def.tile[1]));
      if (d <= r2 && d < bestD) {
        best = cs.id;
        bestD = d;
      }
    }
    return best;
  }

  /**
   * B : usage VOLONTAIRE du cœur rangé (option `heartSlot`, joueurs de `arb.heart` dans l'ordre des ids, un effet par appui). `planHeartUse` décide : (a) allié blessé à portée de contact
   * ([B29]) et cœur rangé → on LE soigne ; (b) cristal de soin sous les pieds et joueur blessé → on utilise le CRISTAL (le cœur rangé reste) ; (c) joueur blessé avec un cœur → il se soigne
   * lui-même ; (d) sinon rien (`heartRefused`, aucun cœur gaspillé). Soin plafonné au manque, le reste est perdu. Émet `heartUsed` / `crystalUsed` / `heartRefused`.
   */
  private stepHeartUse(arb: Arbitration, events: SimEvent[]): void {
    if (arb.heart.size === 0) return;
    const s = this.state;
    for (const p of s.players) {
      if (!arb.heart.has(p.id) || p.status !== 'alive') continue;
      const crystalId = this.crystalUnderfoot(p);
      const plan = planHeartUse(s.players, p, crystalId);
      if (plan.kind === 'none') {
        events.push({ type: 'heartRefused', playerId: p.id });
      } else if (plan.kind === 'crystal') {
        const cs = (s.room.healCrystals as HealCrystalState[]).find((c) => c.id === plan.crystalId);
        const def = (this.room.healCrystals ?? []).find((c) => c.id === plan.crystalId);
        if (!cs || !def) continue;
        const pos = tileCenter(def.tile[0], def.tile[1]);
        const healed = healAmountFor(p, HEAL_CRYSTAL_HEAL);
        p.hp = Math.min(p.maxHp, p.hp + healed);
        cs.used = true;
        events.push({ type: 'crystalUsed', crystalId: cs.id, playerId: p.id, healed, pos: { x: pos.x, y: pos.y } });
      } else {
        const target = plan.kind === 'ally' ? plan.target : p;
        const kind = p.heart as PickupKind;
        const amount = heartUseAmount(p, target);
        target.hp = Math.min(target.maxHp, target.hp + amount);
        delete p.heart;
        events.push({ type: 'heartUsed', playerId: p.id, targetId: target.id, kind, amount, pos: { x: target.pos.x, y: target.pos.y } });
      }
    }
  }

  /**
   * Pose un cœur / demi-cœur au sol (le sien : id du compteur `nextPickupId`, durée `ttlMs`) et émet `pickupDropped`. Sert à la perte du cœur rangé (durée habituelle) et au tutoriel
   * (`spawnScriptedHeart`).
   */
  private addPickup(kind: PickupKind, pos: Vec2, ttlMs: number, events: SimEvent[]): void {
    const s = this.state;
    const id = s.nextPickupId ?? 1;
    s.nextPickupId = id + 1;
    (s.room.pickups as PickupState[]).push({ id, kind, pos: { x: pos.x, y: pos.y }, ttlMs });
    events.push({ type: 'pickupDropped', pickupId: id, kind, pos: { x: pos.x, y: pos.y } });
  }

  /**
   * Un joueur TOMBÉ perd son cœur rangé : il tombe AU SOL à ses pieds (cœur ou demi-cœur identique, ramassable sans verrou, durée de vie habituelle `PICKUP_TTL_MS`) ; événements `heartLost` (la
   * sauvegarde enregistre la perte dès la chute) puis `pickupDropped`. Idempotent : emplacement vide, ne fait rien. Sans l'option `heartSlot`, l'emplacement est toujours vide.
   */
  private loseHeart(p: PlayerState, events: SimEvent[]): void {
    const kind = p.heart;
    if (kind === undefined) return;
    delete p.heart;
    events.push({ type: 'heartLost', playerId: p.id, kind, pos: { x: p.pos.x, y: p.pos.y } });
    this.addPickup(kind, this.findPickupSpot(p.pos), PICKUP_TTL_MS, events);
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
      resetAutoCall(p); // appel automatique (signal, délai, objets signalés) aussi
    }
    if (reason !== 'start') {
      for (const p of s.players) p.invulnMs = Math.max(p.invulnMs, ROOM_ENTER_INVULN_MS);
    }
    s.roomIndex = index;
    this.roomGrid = new RoomGrid(room.layout);
    s.room = newRoomState(room, s.playerCount, s.lootEnabled !== false, s.gearEnabled !== false);
    // budget de bonus temporaires de la salle : tiré sur le PRNG isolé de l'équipement (jamais sur le flux principal ni celui du butin de vie)
    if (s.gearEnabled !== false && s.gearDropsDisabled !== true) s.room.buffBudget = rollBuffBudget(s.playerCount, () => nextRandom(this.gearRng));
    s.lootDryKills = 0; // compteur anti-malchance remis à zéro à chaque début de salle (start / next / restart)
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
  // reprise (« Continuer ») : équipement de départ des joueurs, normalisé (une donnée invalide devient un emplacement vide)
  players.forEach((p, i) => {
    const g = config.initialGear?.[i];
    if (g) p.loadout = { ...normalizeGear(g), buffs: [] };
    // reprise : cœur rangé (valeur inconnue = vide ; sans l'option, l'emplacement reste vide et le champ absent)
    const h = config.initialHearts?.[i];
    if (config.heartSlot === true && isHeartKind(h)) p.heart = h;
  });
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
    room: newRoomState(first, players.length, config.loot !== false, config.gear !== false),
    objectives: createObjectives(level, players.length),
    clearedRooms: level.rooms.slice(0, startIndex).map((r) => r.id),
    lootEnabled: config.loot !== false,
    lootRngState: seedToState((Number.isFinite(config.seed) ? Math.floor(config.seed) | 0 : 0) ^ LOOT_SEED_XOR),
    lootDryKills: 0,
    nextPickupId: 1,
    ...(config.autoCall === false ? { autoCallDisabled: true } : {}),
    ...(config.gear !== false && config.gearDrops === false ? { gearDropsDisabled: true } : {}),
    ...(config.heartSlot === true ? { heartSlot: true } : {}),
    gearEnabled: config.gear !== false,
    gearRngState: seedToState((Number.isFinite(config.seed) ? Math.floor(config.seed) | 0 : 0) ^ GEAR_SEED_XOR),
    nextGearDropId: 1,
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
