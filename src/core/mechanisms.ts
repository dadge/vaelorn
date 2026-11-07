/**
 * Mécanismes coopératifs (logique pure, déterministe, sans Phaser/DOM/Math.random/Date.now).
 *
 * Types gérés : plaques, leviers, clés personnelles, portes, blocs poussables 2×2, réceptacles,
 * énigmes de runes, braseros, statues jumelles, sablier partagé, pont de lumière (voir `types.ts`). Les états (`MechanismState[]`) sont du JSON pur ; ils sont créés
 * par `createRoomMechanisms` puis mis à jour à chaque pas par `updateMechanisms`.
 *
 * Contrat d'utilisation côté simulation, par pas :
 *  1. déplacer les joueurs (collisions = grille statique + `mechanismSolidRects`) ;
 *  2. calculer `interactPressed` (front montant déjà arbitré : relevage > interaction > attaque) ;
 *  3. appeler `updateMechanisms(...)` et rejouer/propager les `SimEvent` retournés ;
 *  4. évaluer la sortie avec `areAllRequirementsMet(room.exit.requires, args)`.
 *
 * Conventions importantes :
 *  - `BlockState.tile` est la tuile LOGIQUE DE DESTINATION : dès qu'un déplacement démarre, `tile` = cible
 *    (et `moving.to` = cible) ; `BlockState.pos` est la position pixel interpolée (utiliser `pos` pour le rendu
 *    et les collisions).
 *  - Un bloc « waived » (minPlayers > nbJoueurs) existe quand même physiquement (on ne fait jamais disparaître
 *    un bloc) ; préférer `playersRequired` pour adapter un bloc au nombre de joueurs.
 *  - Braseros (salles sombres) : SOLIDES (comme une tuile de bloc : `mechanismSolidRects` les inclut, donc ils bloquent aussi
 *    les projectiles et la ligne de vue, et les personnages ne marchent pas dessus) ; waived ou `lit` ⇒ allumés d'office
 *    (`active: true`) ; `interact` à portée = recharger la torche (brasero allumé, torche non pleine) ou l'allumer
 *    (brasero éteint, torche non vide, `ownerSlot` respecté). Priorité d'un appui d'interaction (un seul mécanisme le consomme) :
 *    porte à clé > levier > rune > statue > sablier > brasero.
 *    Un appui sur un brasero allumé avec une torche pleine n'est PAS consommé.
 *  - STATUES JUMELLES (`statuePair`, niveau 4) : solides (une tuile chacune, même waived). Un joueur VIVANT dont la tuile
 *    (`floor(pos/TILE)`) est la `standTile` d'une statue et qui appuie sur `interact` fait pivoter l'AUTRE statue d'un quart de tour
 *    horaire (up → right → down → left → up) : `statueRotated`. Résolue (`active`, verrouillée : plus aucune rotation) quand les
 *    deux regardent `targetDir`. Waived : orientées d'office vers `targetDir`. Un appui sur une statue verrouillée n'est PAS consommé.
 *  - SABLIER (`hourglass`, niveau 5) : `sandMs` s'écoule à chaque pas ; `active` = sable restant > 0 (jeton d'exigence '<id>').
 *    État initial : sable 0, herse fermée (`closedCount = gate.length`). `interact` à ≤ INTERACT_RANGE d'un levier du sablier :
 *    sable = `effectiveHourglassPeriodMs` (période × 2 en solo), herse rouverte d'un coup (`hourglassFlipped`). Sable à 0 :
 *    `hourglassEmpty` (une fois, à la transition) puis une tuile de herse se ferme toutes les `closeStepMs` (défaut 700 ms), dans
 *    l'ordre de `gate` (`gateClosed`) ; une tuile recouverte (même partiellement) par un joueur VIVANT, un ennemi
 *    (`args.enemyCircles`) ou un bloc n'est pas fermée tant qu'elle l'est (le chrono attend à 0) : on n'enferme/n'écrase personne.
 *    Les tuiles fermées sont solides (`mechanismSolidRects`). Waived : herse ouverte en permanence (active, sable = période, immobile).
 *  - PONT DE LUMIÈRE (`lightBridge`, niveau 6) : à chaque pas, porteur = joueur `lanternSlot % n` s'il est vivant ; s'il est à terre,
 *    le joueur vivant le plus proche de lui reprend la lanterne (`lightBridgeBearer` : évite l'impasse d'un porteur tombé loin de
 *    l'équipe) ; aucun porteur seulement si tous sont à terre.
 *    `lit[i]` = (porteur vivant ET distance(centre de la tuile, porteur) ≤ radiusTiles × TILE) OU tuile occupée par un joueur vivant
 *    (`floor(pos/TILE)`). Les tuiles NON éclairées sont solides (vide) : une tuile reste donc éclairée tant qu'un joueur dont le
 *    centre s'y trouve l'occupe (aucun joueur n'est piégé dans le solide ; la simulation extrait de toute façon, via
 *    `ejectPlayersFromSolids`, un disque qui déborderait sur une tuile qui vient de s'éteindre). `active` = au moins une tuile
 *    éclairée PAR LE PORTEUR ; comme jeton d'exigence, un pont compte comme satisfait si waived ou si le porteur est vivant
 *    (`isMechanismSolved`). Waived : tout éclairé, `bearerId: null`. Limite : un ennemi n'éclaire pas les tuiles (un ennemi pris dans
 *    une tuile qui s'éteint n'est pas extrait).
 *  - Au redémarrage d'une salle (défaite collective), la simulation recrée l'état avec `createRoomMechanisms`
 *    ET vide `player.keys` (les clés de la salle sont perdues avec l'état).
 */

import {
  BLOCK_MOVE_MS,
  BLOCK_SIZE_TILES,
  INTERACT_RANGE,
  PLAYER_RADIUS,
  TILE,
  TORCH_MAX_MS,
} from './constants';
import type { RoomGrid } from './grid';
import { resolveSlot } from './slots';
import type {
  ActionFrame,
  BlockDef,
  BlockState,
  BrazierDef,
  BrazierState,
  Dir,
  DoorDef,
  DoorState,
  HourglassDef,
  HourglassState,
  KeyState,
  LeverDef,
  LeverState,
  LightBridgeDef,
  LightBridgeState,
  MechanismState,
  PlateState,
  PlayerId,
  PlayerState,
  Requirement,
  RoomDef,
  RuneState,
  SimEvent,
  SocketState,
  StatuePairDef,
  StatuePairState,
  TickInputs,
  TileXY,
  Vec2,
} from './types';

// ───────────────────────────── Constantes ─────────────────────────────

/** Durée de poussée soutenue (ms) avant qu'un bloc ne démarre son déplacement d'une tuile. */
export const PUSH_THRESHOLD_MS = 250;
/** Jeu (px) toléré entre le bord du joueur et la face du bloc pour compter comme « au contact ». */
export const PUSH_CONTACT_MARGIN = 3;
/** Tolérance (px) sur l'axe tangent à la face poussée. */
export const PUSH_TANGENT_TOLERANCE = 2;
/** Seuil (|moveX|,|moveY|) sous lequel une entrée n'est pas considérée comme une poussée. */
export const PUSH_AXIS_THRESHOLD = 0.3;
/** Distance max (px, centre joueur → centre de tuile) pour ramasser automatiquement une clé. */
export const KEY_PICKUP_RADIUS = 10;
/** Durée (ms) du flash d'erreur d'une énigme de runes. */
export const RUNE_ERROR_FLASH_MS = 600;
/** Délai par défaut (ms) entre la fermeture de deux tuiles de herse d'un sablier (`HourglassDef.closeStepMs`). */
export const DEFAULT_HOURGLASS_CLOSE_STEP_MS = 700;
/** Multiplicateur de la période d'un sablier quand la partie est jouée en solo. */
export const HOURGLASS_SOLO_MULT = 2;

const BLOCK_PX = BLOCK_SIZE_TILES * TILE;
const DIRS: readonly Dir[] = ['up', 'down', 'left', 'right'];
/** Quart de tour horaire : up → right → down → left → up. */
const CLOCKWISE: Readonly<Record<Dir, Dir>> = { up: 'right', right: 'down', down: 'left', left: 'up' };
const DIR_VEC: Readonly<Record<Dir, Vec2>> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

// ───────────────────────────── Types publics ─────────────────────────────

/** Rectangle en pixels. */
export interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Disque (position du centre + rayon), utilisé pour les ennemis qui bloquent un bloc. */
export interface Circle {
  x: number;
  y: number;
  r: number;
}

/** Données nécessaires pour évaluer des exigences (`Requirement`). `MechanismUpdateArgs` en est un sur-ensemble. */
export interface RequirementContext {
  /** États des mécanismes de la salle courante. */
  mechanisms: readonly MechanismState[];
  /** Nombre d'ennemis vivants. Pour 'clear', la simulation doit passer une valeur > 0 tant qu'une vague est en attente. */
  aliveEnemyCount: number;
  /** Objectif accompli ? (jeton 'obj:<id>') */
  objectiveDone: (objectiveId: string) => boolean;
  /** Le propriétaire de l'objectif de zone est-il dans sa zone ? (jeton 'zone:<objId>') */
  zoneOccupied: (objectiveId: string) => boolean;
  /**
   * Au moins un joueur VIVANT est-il en ce moment dans la ZoneDef `zoneId` de la salle ? (jeton 'enter:<zoneId>').
   * Optionnel (compatibilité) : absent ⇒ le jeton n'est jamais satisfait.
   */
  zoneEntered?: (zoneId: string) => boolean;
}

/** Arguments de `updateMechanisms`. */
export interface MechanismUpdateArgs extends RequirementContext {
  room: RoomDef;
  /** Grille statique de la salle (murs, piliers, fosses). */
  grid: RoomGrid;
  /** États à muter (créés par `createRoomMechanisms`, dans l'ordre de `room.mechanisms`). */
  mechanisms: MechanismState[];
  /** Tous les joueurs de la partie (mutables : position des pousseurs, `keys`). `players.length` = nombre de joueurs. */
  players: PlayerState[];
  /** Entrées tenues du pas courant (pour les poussées de blocs). */
  frames: TickInputs;
  /** Front montant d'interaction déjà arbitré par la simulation (relevage > interaction > attaque). */
  interactPressed: Partial<Record<PlayerId, boolean>>;
  dtMs: number;
  /** Optionnel : disques des ennemis vivants ; un ennemi dans la zone cible empêche un bloc de bouger. */
  enemyCircles?: readonly Circle[];
}

// ───────────────────────────── Utilitaires géométriques internes ─────────────────────────────

/** Centre en pixels d'une tuile. */
export function tileCenterPx(tile: readonly [number, number]): Vec2 {
  return { x: (tile[0] + 0.5) * TILE, y: (tile[1] + 0.5) * TILE };
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function circleIntersectsRect(cx: number, cy: number, r: number, rect: PixelRect): boolean {
  const nx = Math.max(rect.x, Math.min(cx, rect.x + rect.w));
  const ny = Math.max(rect.y, Math.min(cy, rect.y + rect.h));
  const dx = cx - nx;
  const dy = cy - ny;
  return dx * dx + dy * dy < r * r;
}

function rectsOverlap(a: PixelRect, b: PixelRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function pointInRect(px: number, py: number, r: PixelRect): boolean {
  return px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h;
}

function circleOverlapsBlockedTile(grid: RoomGrid, x: number, y: number, r: number): boolean {
  const x0 = Math.floor((x - r) / TILE);
  const x1 = Math.floor((x + r) / TILE);
  const y0 = Math.floor((y - r) / TILE);
  const y1 = Math.floor((y + r) / TILE);
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      if (grid.blocksMovement(tx, ty) && circleIntersectsRect(x, y, r, { x: tx * TILE, y: ty * TILE, w: TILE, h: TILE })) {
        return true;
      }
    }
  }
  return false;
}

type StateOf<T extends MechanismState['type']> = Extract<MechanismState, { type: T }>;

function indexStates(mechanisms: readonly MechanismState[]): Map<string, MechanismState> {
  const m = new Map<string, MechanismState>();
  for (const s of mechanisms) m.set(s.id, s);
  return m;
}

function stateOfType<T extends MechanismState['type']>(
  states: Map<string, MechanismState>,
  id: string,
  type: T,
): StateOf<T> | undefined {
  const s = states.get(id);
  return s && s.type === type ? (s as StateOf<T>) : undefined;
}

function setActive(st: MechanismState, value: boolean, events: SimEvent[]): void {
  if (st.active !== value) {
    st.active = value;
    events.push({ type: 'mechanismChanged', mechanismId: st.id, active: value });
  }
}

function playerById(players: readonly PlayerState[], id: PlayerId): PlayerState | undefined {
  return players.find((p) => p.id === id);
}

function blockRect(st: BlockState): PixelRect {
  return { x: st.pos.x, y: st.pos.y, w: BLOCK_PX, h: BLOCK_PX };
}

// ───────────────────────────── Création ─────────────────────────────

/**
 * Crée l'état initial des mécanismes d'une salle (même ordre que `room.mechanisms`).
 *
 * Coop adaptative : un mécanisme dont `minPlayers > playerCount` est « waived » : `waived: true` et rendu comme
 * déjà résolu (`active: true` ; porte : `open: true` ; clé : `collected: true`, `holderId: null` ;
 * énigme de runes : `progress = sequence.length`). Les blocs ne disparaissent jamais (voir en-tête de fichier).
 *
 * @param room Définition de la salle.
 * @param playerCount Nombre de joueurs de la partie (1..4).
 */
export function createRoomMechanisms(room: RoomDef, playerCount: number): MechanismState[] {
  return room.mechanisms.map((def): MechanismState => {
    const waived = (def.minPlayers ?? 1) > playerCount;
    switch (def.type) {
      case 'plate':
        return { id: def.id, type: 'plate', waived, active: waived, pressedBy: null };
      case 'lever':
        return { id: def.id, type: 'lever', waived, active: waived, remainingMs: 0 };
      case 'key':
        return { id: def.id, type: 'key', waived, active: waived, collected: waived, holderId: null };
      case 'door':
        return { id: def.id, type: 'door', waived, active: waived, open: waived };
      case 'block':
        return {
          id: def.id,
          type: 'block',
          waived,
          active: waived,
          pos: { x: def.tile[0] * TILE, y: def.tile[1] * TILE },
          tile: [def.tile[0], def.tile[1]],
          moving: null,
          pushMs: 0,
        };
      case 'socket':
        return { id: def.id, type: 'socket', waived, active: waived };
      case 'brazier':
        return { id: def.id, type: 'brazier', waived, active: waived || def.lit === true, litBy: null };
      case 'runePuzzle':
        return {
          id: def.id,
          type: 'runePuzzle',
          waived,
          active: waived,
          progress: waived ? def.sequence.length : 0,
          errorFlashMs: 0,
          lastPedestal: -1,
        };
      case 'statuePair': {
        const facings: [Dir, Dir] = waived ? [def.targetDir, def.targetDir] : [def.statues[0].facing, def.statues[1].facing];
        const solved = facings[0] === def.targetDir && facings[1] === def.targetDir;
        return { id: def.id, type: 'statuePair', waived, active: waived || solved, facings, lastRotated: -1 };
      }
      case 'hourglass':
        // Non waived : sable vide, herse entièrement fermée. Waived : herse ouverte en permanence, sable plein et immobile.
        return {
          id: def.id,
          type: 'hourglass',
          waived,
          active: waived,
          sandMs: waived ? effectiveHourglassPeriodMs(def, playerCount) : 0,
          closedCount: waived ? 0 : def.gate.length,
          stepMs: 0,
          lastLever: -1,
        };
      case 'lightBridge':
        // Non waived : tout éteint jusqu'au premier pas de `updateMechanisms`. Waived : tout éclairé, pas de porteur.
        return {
          id: def.id,
          type: 'lightBridge',
          waived,
          active: waived,
          bearerId: null,
          lit: def.tiles.map(() => waived),
        };
    }
  });
}

// ───────────────────────────── Exigences ─────────────────────────────

/**
 * Un jeton `Requirement` est-il satisfait ?
 *  - 'clear'      : `aliveEnemyCount === 0` (la simulation décide si une vague est encore en attente) ;
 *  - 'obj:<id>'   : `ctx.objectiveDone(id)` ;
 *  - 'zone:<id>'  : `ctx.zoneOccupied(id)` ;
 *  - 'enter:<zoneId>' : `ctx.zoneEntered?.(zoneId)` (absent ⇒ false) : un joueur vivant est dans la zone ;
 *  - '<mechId>'   : mécanisme résolu (`isMechanismSolved` : waived, ou actif/ouvert/résolu ; sablier = sable restant > 0 ;
 *                   pont de lumière = porteur vivant). Id inconnu ⇒ false.
 */
export function isRequirementMet(req: Requirement, ctx: RequirementContext): boolean {
  if (req === 'clear') return ctx.aliveEnemyCount === 0;
  if (req.startsWith('obj:')) return ctx.objectiveDone(req.slice(4));
  if (req.startsWith('zone:')) return ctx.zoneOccupied(req.slice(5));
  if (req.startsWith('enter:')) return ctx.zoneEntered ? ctx.zoneEntered(req.slice(6)) === true : false;
  const st = ctx.mechanisms.find((m) => m.id === req);
  if (!st) return false;
  return isMechanismSolved(st);
}

/** Toutes les exigences sont-elles satisfaites ? (liste vide ⇒ true) */
export function areAllRequirementsMet(reqs: readonly Requirement[], ctx: RequirementContext): boolean {
  return reqs.every((r) => isRequirementMet(r, ctx));
}

// ───────────────────────────── Aides publiques ─────────────────────────────

/** Fenêtre effective (ms) d'un levier à fenêtre : `windowMs × ceil(nbLeviersÀFenêtreNonWaived / nbJoueurs)`. 0 si pas de fenêtre. */
export function effectiveLeverWindowMs(room: RoomDef, playerCount: number, lever: LeverDef): number {
  const w = lever.windowMs ?? 0;
  if (w <= 0) return 0;
  const n = Math.max(1, playerCount);
  let count = 0;
  for (const d of room.mechanisms) {
    if (d.type === 'lever' && (d.windowMs ?? 0) > 0 && (d.minPlayers ?? 1) <= n) count++;
  }
  return w * Math.max(1, Math.ceil(count / n));
}

/** Nombre de pousseurs simultanés requis pour un bloc : `min(playersRequired ?? 2, nbJoueurs)` (au moins 1). */
export function requiredPushers(def: BlockDef, playerCount: number): number {
  return Math.max(1, Math.min(def.playersRequired ?? 2, Math.max(1, playerCount)));
}

function tileRectPx(t: readonly [number, number]): PixelRect {
  return { x: t[0] * TILE, y: t[1] * TILE, w: TILE, h: TILE };
}

/**
 * Solides FIXES (hors blocs) : tuiles de porte fermée, braseros, statues jumelles (toujours, même waived), tuiles de herse
 * fermées d'un sablier, tuiles NON éclairées d'un pont de lumière.
 */
function staticSolidRects(room: RoomDef, states: ReadonlyMap<string, MechanismState>): PixelRect[] {
  const rects: PixelRect[] = [];
  for (const def of room.mechanisms) {
    const st = states.get(def.id);
    switch (def.type) {
      case 'door':
        if (st && st.type === 'door' && !st.open) for (const t of def.tiles) rects.push(tileRectPx(t));
        break;
      case 'brazier':
        rects.push(tileRectPx(def.tile));
        break;
      case 'statuePair':
        for (const sd of def.statues) rects.push(tileRectPx(sd.tile));
        break;
      case 'hourglass':
        if (st && st.type === 'hourglass' && !st.waived) {
          const n = Math.min(st.closedCount, def.gate.length);
          for (let i = 0; i < n; i++) rects.push(tileRectPx(def.gate[i]));
        }
        break;
      case 'lightBridge':
        if (st && st.type === 'lightBridge' && !st.waived) {
          def.tiles.forEach((t, i) => {
            if (st.lit[i] !== true) rects.push(tileRectPx(t));
          });
        }
        break;
      default:
        break;
    }
  }
  return rects;
}

/** Quart de tour horaire d'une direction : up → right → down → left → up. */
export function rotateClockwise(dir: Dir): Dir {
  return CLOCKWISE[dir];
}

/**
 * Période effective (ms) du sable d'un sablier : `def.periodMs`, MULTIPLIÉE PAR 2 quand la partie est jouée en solo
 * (`playerCount <= 1`, `HOURGLASS_SOLO_MULT`) : un seul joueur doit retourner le sablier puis courir.
 */
export function effectiveHourglassPeriodMs(def: HourglassDef, playerCount: number): number {
  return def.periodMs * (playerCount <= 1 ? HOURGLASS_SOLO_MULT : 1);
}

/** Délai effectif (ms) entre deux fermetures de tuiles de herse (`closeStepMs`, défaut `DEFAULT_HOURGLASS_CLOSE_STEP_MS`). */
export function hourglassCloseStepMs(def: HourglassDef): number {
  const v = def.closeStepMs;
  return typeof v === 'number' && v > 0 ? v : DEFAULT_HOURGLASS_CLOSE_STEP_MS;
}

/** Tuile logique (`floor(pos/TILE)`) occupée par un joueur. */
function tileOfPlayer(p: PlayerState): TileXY {
  return [Math.floor(p.pos.x / TILE), Math.floor(p.pos.y / TILE)];
}

/**
 * Index (0|1) de la statue dont `p` occupe la `standTile`, ou -1 (joueur à terre, ou sur aucun socle). `p` n'agit alors que sur
 * l'AUTRE statue (`1 - index`).
 */
export function statueStandIndex(def: StatuePairDef, p: PlayerState): -1 | 0 | 1 {
  if (p.status !== 'alive') return -1;
  const t = tileOfPlayer(p);
  for (const i of [0, 1] as const) {
    const st = def.statues[i].standTile;
    if (st[0] === t[0] && st[1] === t[1]) return i;
  }
  return -1;
}

/**
 * Statue qu'un appui d'interaction de `p` ferait pivoter (index 0|1), ou null : mécanisme waived/résolu (verrouillé), `p` à terre
 * ou hors de tout socle.
 */
export function statueRotationTarget(def: StatuePairDef, st: StatuePairState, p: PlayerState): 0 | 1 | null {
  if (st.waived || st.active) return null;
  const idx = statueStandIndex(def, p);
  return idx < 0 ? null : ((1 - idx) as 0 | 1);
}

/**
 * Index du levier de sablier le plus proche de `p` à ≤ INTERACT_RANGE (centre de tuile), ou -1 (joueur à terre, trop loin).
 * Un appui d'interaction à cet endroit retourne le sablier.
 */
export function hourglassLeverIndex(def: HourglassDef, p: PlayerState): number {
  if (p.status !== 'alive') return -1;
  let best = -1;
  let bd = Infinity;
  def.levers.forEach((t, i) => {
    const d = dist(p.pos, tileCenterPx(t));
    if (d <= INTERACT_RANGE && d < bd) {
      bd = d;
      best = i;
    }
  });
  return best;
}

/**
 * Rectangles pixels SOLIDES pour les collisions des personnages : une tuile par tuile de porte FERMÉE,
 * les blocs (position interpolée, 32×32), une tuile par brasero (toujours solide, même waived), une tuile par statue jumelle
 * (toujours), les tuiles de herse FERMÉES d'un sablier (les `closedCount` premières de `gate`) et les tuiles NON éclairées d'un
 * pont de lumière. À ajouter à la grille statique par la simulation.
 */
export function mechanismSolidRects(room: RoomDef, mechanisms: readonly MechanismState[]): PixelRect[] {
  const states = indexStates(mechanisms);
  const rects = staticSolidRects(room, states);
  for (const def of room.mechanisms) {
    if (def.type !== 'block') continue;
    const st = states.get(def.id);
    if (st && st.type === 'block') rects.push(blockRect(st));
  }
  return rects;
}

/**
 * Un disque (centre `pos`, rayon `radius`, 0 = point) touche-t-il un solide de mécanisme (porte fermée, bloc, brasero, statue,
 * herse de sablier fermée) ? Les projectiles sont bloqués par ces éléments (en plus des murs de la grille). Les tuiles non
 * éclairées d'un pont de lumière sont comptées aussi (vide solide), comme pour `mechanismSolidRects`.
 */
export function mechanismBlocksProjectile(
  room: RoomDef,
  mechanisms: readonly MechanismState[],
  pos: Vec2,
  radius = 0,
): boolean {
  for (const r of mechanismSolidRects(room, mechanisms)) {
    if (radius <= 0 ? pointInRect(pos.x, pos.y, r) : circleIntersectsRect(pos.x, pos.y, radius, r)) return true;
  }
  return false;
}

/** La tuile (tx,ty) est-elle (au moins partiellement) occupée par un solide de mécanisme (porte fermée, bloc, brasero, statue, herse fermée, pont éteint) ? (IA / chemin) */
export function isTileBlockedByMechanism(
  room: RoomDef,
  mechanisms: readonly MechanismState[],
  tx: number,
  ty: number,
): boolean {
  const tileRect: PixelRect = { x: tx * TILE, y: ty * TILE, w: TILE, h: TILE };
  return mechanismSolidRects(room, mechanisms).some((r) => rectsOverlap(r, tileRect));
}

/**
 * Un mécanisme est-il « résolu » (jeton d'exigence '<id>' satisfait) ? Waived ou `active`, avec une exception :
 * un pont de lumière compte comme satisfait tant que son porteur est vivant (`bearerId !== null`), même si le halo ne touche
 * encore aucune tuile. Sablier : `active` = sable restant > 0 ; statues jumelles : `active` = les deux regardent `targetDir`.
 */
export function isMechanismSolved(st: MechanismState): boolean {
  if (st.waived) return true;
  if (st.type === 'lightBridge') return st.bearerId !== null;
  return st.active;
}

// ───────────────────────────── Mise à jour ─────────────────────────────

/**
 * Met à jour tous les mécanismes de la salle pour UN pas de simulation.
 *
 * Mute uniquement `args.mechanisms` et `args.players` (position des pousseurs de blocs ; ajout/retrait de clés
 * dans `player.keys`). Déterministe. Retourne les événements : `mechanismChanged`, `keyPicked`, `doorOpened`,
 * `runeProgress`.
 *
 * Ordre : timers de leviers → blocs → plaques → réceptacles → ponts de lumière (porteur, tuiles éclairées) → sabliers
 * (écoulement du sable, fermeture progressive de la herse) → portes à clé (consomme l'interaction) → leviers → runes →
 * statues jumelles (pivotement) → sabliers (retournement) → braseros → ramassage de clés → portes sans clé (résolues en chaîne).
 * Une même pression d'interaction n'est consommée que par UN mécanisme (porte à clé > levier > rune > statue > sablier > brasero).
 * Le sablier s'écoule AVANT son retournement : un appui au pas où le sable atteint 0 rouvre la herse (la tuile éventuellement
 * fermée à ce pas est rouverte). Événements possibles en plus : `brazierLit`, `torchRefueled`, `statueRotated`,
 * `hourglassFlipped`, `hourglassEmpty`, `gateClosed`.
 */
export function updateMechanisms(args: MechanismUpdateArgs): SimEvent[] {
  const events: SimEvent[] = [];
  const { room, mechanisms, players } = args;
  const states = indexStates(mechanisms);
  const n = Math.max(1, players.length);
  const consumed = new Set<PlayerId>();
  const pressed = (p: PlayerState): boolean =>
    p.status === 'alive' && args.interactPressed[p.id] === true && !consumed.has(p.id);

  updateLeverTimers(args, states, events);
  updateBlocks(args, states, n);
  updatePlates(args, states, events);
  updateSockets(args, states, events);
  updateLightBridges(args, states, events);
  updateHourglassFlow(args, states, events);
  updateKeyDoors(args, states, events, pressed, consumed);
  updateLeverPresses(args, states, events, n, pressed, consumed);
  updateRunes(args, states, events, pressed, consumed);
  updateStatuePairs(args, states, events, pressed, consumed);
  updateHourglassFlips(args, states, events, pressed, consumed);
  updateBraziers(args, states, events, n, pressed, consumed);
  updateKeyPickups(args, states, events, n);
  updateOpenDoors(args, states, events);
  return events;
}

// ── Leviers ──

function updateLeverTimers(args: MechanismUpdateArgs, states: Map<string, MechanismState>, events: SimEvent[]): void {
  for (const def of args.room.mechanisms) {
    if (def.type !== 'lever') continue;
    const st = stateOfType(states, def.id, 'lever');
    if (!st || st.waived || !st.active || (def.windowMs ?? 0) <= 0) continue;
    st.remainingMs -= args.dtMs;
    if (st.remainingMs <= 0) {
      st.remainingMs = 0;
      setActive(st, false, events);
    }
  }
}

function updateLeverPresses(
  args: MechanismUpdateArgs,
  states: Map<string, MechanismState>,
  events: SimEvent[],
  n: number,
  pressed: (p: PlayerState) => boolean,
  consumed: Set<PlayerId>,
): void {
  const { room, players } = args;
  for (const p of players) {
    if (!pressed(p)) continue;
    let best: { def: LeverDef; st: LeverState; d: number } | null = null;
    for (const def of room.mechanisms) {
      if (def.type !== 'lever') continue;
      const st = stateOfType(states, def.id, 'lever');
      if (!st || st.waived || st.active) continue;
      if (def.ownerSlot !== undefined && resolveSlot(def.ownerSlot, n) !== p.id) continue;
      const d = dist(p.pos, tileCenterPx(def.tile));
      if (d <= INTERACT_RANGE && (best === null || d < best.d)) best = { def, st, d };
    }
    if (best) {
      best.st.remainingMs = effectiveLeverWindowMs(room, n, best.def);
      setActive(best.st, true, events);
      consumed.add(p.id);
    }
  }
}

// ── Plaques / réceptacles ──

function updatePlates(args: MechanismUpdateArgs, states: Map<string, MechanismState>, events: SimEvent[]): void {
  const blocks = blockRects(args, states);
  for (const def of args.room.mechanisms) {
    if (def.type !== 'plate') continue;
    const st = stateOfType(states, def.id, 'plate');
    if (!st || st.waived) continue;
    const [tx, ty] = def.tile;
    let by: PlateState['pressedBy'] = null;
    for (const p of args.players) {
      if (p.status === 'alive' && Math.floor(p.pos.x / TILE) === tx && Math.floor(p.pos.y / TILE) === ty) {
        by = p.id;
        break;
      }
    }
    if (by === null) {
      const c = tileCenterPx(def.tile);
      if (blocks.some((r) => pointInRect(c.x, c.y, r))) by = 'block';
    }
    st.pressedBy = by;
    setActive(st, by !== null, events);
  }
}

function blockRects(args: MechanismUpdateArgs, states: Map<string, MechanismState>): PixelRect[] {
  const out: PixelRect[] = [];
  for (const def of args.room.mechanisms) {
    if (def.type !== 'block') continue;
    const st = stateOfType(states, def.id, 'block');
    if (st) out.push(blockRect(st));
  }
  return out;
}

function updateSockets(args: MechanismUpdateArgs, states: Map<string, MechanismState>, events: SimEvent[]): void {
  for (const def of args.room.mechanisms) {
    if (def.type !== 'socket') continue;
    const st: SocketState | undefined = stateOfType(states, def.id, 'socket');
    if (!st || st.waived) continue;
    let filled = false;
    for (const bd of args.room.mechanisms) {
      if (bd.type !== 'block') continue;
      if (def.blockId !== undefined && def.blockId !== bd.id) continue;
      const bs = stateOfType(states, bd.id, 'block');
      if (bs && bs.moving === null && bs.tile[0] === def.tile[0] && bs.tile[1] === def.tile[1]) {
        filled = true;
        break;
      }
    }
    setActive(st, filled, events);
  }
}

// ── Clés / portes ──

function updateKeyPickups(
  args: MechanismUpdateArgs,
  states: Map<string, MechanismState>,
  events: SimEvent[],
  n: number,
): void {
  for (const def of args.room.mechanisms) {
    if (def.type !== 'key') continue;
    const st: KeyState | undefined = stateOfType(states, def.id, 'key');
    if (!st || st.waived || st.collected || st.active) continue;
    const owner = playerById(args.players, resolveSlot(def.ownerSlot, n));
    if (!owner || owner.status !== 'alive') continue;
    if (dist(owner.pos, tileCenterPx(def.tile)) <= KEY_PICKUP_RADIUS) {
      st.collected = true;
      st.holderId = owner.id;
      if (!owner.keys.includes(def.id)) owner.keys.push(def.id);
      events.push({ type: 'keyPicked', playerId: owner.id, keyId: def.id });
    }
  }
}

function openDoor(def: DoorDef, st: DoorState, events: SimEvent[]): void {
  st.open = true;
  st.active = true;
  events.push({ type: 'doorOpened', doorId: def.id });
  events.push({ type: 'mechanismChanged', mechanismId: def.id, active: true });
}

/** Portes à clé : le détenteur interagit à portée avec la clé en main et les exigences sont satisfaites. */
function updateKeyDoors(
  args: MechanismUpdateArgs,
  states: Map<string, MechanismState>,
  events: SimEvent[],
  pressed: (p: PlayerState) => boolean,
  consumed: Set<PlayerId>,
): void {
  for (const def of args.room.mechanisms) {
    if (def.type !== 'door' || def.keyId === undefined) continue;
    const st = stateOfType(states, def.id, 'door');
    if (!st || st.waived || st.open) continue;
    const keySt = stateOfType(states, def.keyId, 'key');
    if (!keySt || keySt.waived || !keySt.collected || keySt.holderId === null) continue;
    const holder = playerById(args.players, keySt.holderId);
    if (!holder || !holder.keys.includes(def.keyId) || !pressed(holder)) continue;
    if (!areAllRequirementsMet(def.requires, args)) continue;
    if (!def.tiles.some((t) => dist(holder.pos, tileCenterPx(t)) <= INTERACT_RANGE)) continue;
    // Ouverture : la clé est consommée.
    const idx = holder.keys.indexOf(def.keyId);
    if (idx >= 0) holder.keys.splice(idx, 1);
    consumed.add(holder.id);
    openDoor(def, st, events);
    keySt.active = true;
    events.push({ type: 'mechanismChanged', mechanismId: keySt.id, active: true });
  }
}

/** Portes sans clé (ou dont la clé est waived) : s'ouvrent dès que les exigences sont satisfaites ; chaînage en un pas. */
function updateOpenDoors(args: MechanismUpdateArgs, states: Map<string, MechanismState>, events: SimEvent[]): void {
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 16) {
    changed = false;
    for (const def of args.room.mechanisms) {
      if (def.type !== 'door') continue;
      const st = stateOfType(states, def.id, 'door');
      if (!st || st.waived || st.open) continue;
      if (def.keyId !== undefined) {
        const keySt = stateOfType(states, def.keyId, 'key');
        // Ouverture par clé uniquement (clé inconnue : la porte reste fermée, c'est une erreur de niveau).
        if (!keySt || !keySt.waived) continue;
      }
      if (areAllRequirementsMet(def.requires, args)) {
        openDoor(def, st, events);
        changed = true;
      }
    }
  }
}

// ── Runes ──

function updateRunes(
  args: MechanismUpdateArgs,
  states: Map<string, MechanismState>,
  events: SimEvent[],
  pressed: (p: PlayerState) => boolean,
  consumed: Set<PlayerId>,
): void {
  const { room, players, dtMs } = args;
  for (const def of room.mechanisms) {
    if (def.type !== 'runePuzzle') continue;
    const st = stateOfType(states, def.id, 'runePuzzle');
    if (st && st.errorFlashMs > 0) st.errorFlashMs = Math.max(0, st.errorFlashMs - dtMs);
  }
  for (const p of players) {
    if (!pressed(p)) continue;
    let best: { st: RuneState; seq: readonly string[]; symbol: string; idx: number; d: number } | null = null;
    for (const def of room.mechanisms) {
      if (def.type !== 'runePuzzle') continue;
      const st = stateOfType(states, def.id, 'runePuzzle');
      if (!st || st.waived || st.active) continue;
      for (let idx = 0; idx < def.pedestals.length; idx++) {
        const ped = def.pedestals[idx];
        const d = dist(p.pos, tileCenterPx(ped.tile));
        if (d <= INTERACT_RANGE && (best === null || d < best.d)) {
          best = { st, seq: def.sequence, symbol: ped.symbol, idx, d };
        }
      }
    }
    const hit = best;
    if (!hit) continue;
    consumed.add(p.id);
    hit.st.lastPedestal = hit.idx;
    if (hit.seq[hit.st.progress] === hit.symbol) {
      hit.st.progress += 1;
      events.push({ type: 'runeProgress', mechanismId: hit.st.id, progress: hit.st.progress, ok: true });
      if (hit.st.progress >= hit.seq.length) setActive(hit.st, true, events);
    } else {
      hit.st.progress = 0;
      hit.st.errorFlashMs = RUNE_ERROR_FLASH_MS;
      events.push({ type: 'runeProgress', mechanismId: hit.st.id, progress: 0, ok: false });
    }
  }
}

// ── Braseros ──

/**
 * Ce qu'un appui d'interaction de `p` ferait sur le brasero `def` :
 *  - 'refuel' : brasero allumé (ou waived), `p` vivant à portée (INTERACT_RANGE depuis le centre de la tuile) avec une torche
 *    non pleine ;
 *  - 'light'  : brasero éteint, `p` à portée avec une torche non vide, et `ownerSlot` (si défini) correspond à `p` ;
 *  - null     : rien (hors de portée, torche pleine sur un brasero allumé, torche vide sur un brasero éteint, mauvais joueur).
 * @param playerCount nombre de joueurs de la partie (résolution de `ownerSlot`)
 */
export function brazierAction(
  def: BrazierDef,
  st: BrazierState,
  p: PlayerState,
  playerCount: number,
): 'refuel' | 'light' | null {
  if (p.status !== 'alive') return null;
  if (dist(p.pos, tileCenterPx(def.tile)) > INTERACT_RANGE) return null;
  if (st.active || st.waived) return p.torchMs < TORCH_MAX_MS ? 'refuel' : null;
  if (!(p.torchMs > 0)) return null;
  if (def.ownerSlot !== undefined && resolveSlot(def.ownerSlot, Math.max(1, playerCount)) !== p.id) return null;
  return 'light';
}

function updateBraziers(
  args: MechanismUpdateArgs,
  states: Map<string, MechanismState>,
  events: SimEvent[],
  n: number,
  pressed: (p: PlayerState) => boolean,
  consumed: Set<PlayerId>,
): void {
  const { room, players } = args;
  for (const p of players) {
    if (!pressed(p)) continue;
    let best: { def: BrazierDef; st: BrazierState; action: 'refuel' | 'light'; d: number } | null = null;
    for (const def of room.mechanisms) {
      if (def.type !== 'brazier') continue;
      const st = stateOfType(states, def.id, 'brazier');
      if (!st) continue;
      const action = brazierAction(def, st, p, n);
      if (action === null) continue;
      const d = dist(p.pos, tileCenterPx(def.tile));
      if (best === null || d < best.d) best = { def, st, action, d };
    }
    if (!best) continue;
    consumed.add(p.id);
    if (best.action === 'refuel') {
      p.torchMs = TORCH_MAX_MS;
      events.push({ type: 'torchRefueled', playerId: p.id, brazierId: best.def.id });
    } else {
      best.st.litBy = p.id;
      setActive(best.st, true, events);
      events.push({ type: 'brazierLit', brazierId: best.def.id, playerId: p.id });
    }
  }
}

// ── Statues jumelles ──

/** Statues jumelles : un joueur vivant sur un socle + interaction fait pivoter l'AUTRE statue d'un quart de tour horaire. */
function updateStatuePairs(
  args: MechanismUpdateArgs,
  states: Map<string, MechanismState>,
  events: SimEvent[],
  pressed: (p: PlayerState) => boolean,
  consumed: Set<PlayerId>,
): void {
  const { room, players } = args;
  for (const p of players) {
    if (!pressed(p)) continue;
    for (const def of room.mechanisms) {
      if (def.type !== 'statuePair') continue;
      const st = stateOfType(states, def.id, 'statuePair');
      if (!st) continue;
      const target = statueRotationTarget(def, st, p);
      if (target === null) continue;
      const facing = rotateClockwise(st.facings[target]);
      st.facings[target] = facing;
      st.lastRotated = target;
      events.push({ type: 'statueRotated', mechanismId: def.id, index: target, facing, playerId: p.id });
      setActive(st, st.facings[0] === def.targetDir && st.facings[1] === def.targetDir, events);
      consumed.add(p.id);
      break;
    }
  }
}

// ── Sablier ──

/** La tuile `t` est-elle occupée (même partiellement) par un joueur vivant, un ennemi ou un bloc ? (une herse ne s'y ferme pas) */
function isTileOccupied(args: MechanismUpdateArgs, states: Map<string, MechanismState>, t: TileXY): boolean {
  const rect = tileRectPx(t);
  for (const p of args.players) {
    if (p.status === 'alive' && circleIntersectsRect(p.pos.x, p.pos.y, PLAYER_RADIUS, rect)) return true;
  }
  for (const c of args.enemyCircles ?? []) {
    if (circleIntersectsRect(c.x, c.y, c.r, rect)) return true;
  }
  for (const bs of states.values()) {
    if (bs.type === 'block' && rectsOverlap(blockRect(bs), rect)) return true;
  }
  return false;
}

/**
 * Écoulement du sable et fermeture progressive de la herse. Sable à 0 : `hourglassEmpty` (à la transition seulement), puis une
 * tuile toutes les `closeStepMs` (la première après un délai complet) ; une tuile occupée retarde sa fermeture (le chrono reste
 * à 0 et la tuile se ferme dès qu'elle est libre).
 */
function updateHourglassFlow(args: MechanismUpdateArgs, states: Map<string, MechanismState>, events: SimEvent[]): void {
  for (const def of args.room.mechanisms) {
    if (def.type !== 'hourglass') continue;
    const st = stateOfType(states, def.id, 'hourglass');
    if (!st || st.waived) continue;
    const step = hourglassCloseStepMs(def);
    if (st.sandMs > 0) {
      st.sandMs = Math.max(0, st.sandMs - args.dtMs);
      if (st.sandMs <= 0) {
        st.sandMs = 0;
        st.stepMs = step;
        setActive(st, false, events);
        events.push({ type: 'hourglassEmpty', mechanismId: def.id });
      }
      continue;
    }
    if (st.closedCount >= def.gate.length) continue;
    st.stepMs = Math.max(0, st.stepMs - args.dtMs);
    if (st.stepMs > 0) continue;
    if (isTileOccupied(args, states, def.gate[st.closedCount])) continue; // attend, chrono à 0
    st.closedCount += 1;
    st.stepMs = step;
    events.push({ type: 'gateClosed', mechanismId: def.id, closedCount: st.closedCount });
  }
}

/** Retournement : interaction à portée d'un levier du sablier → sable = période effective, herse rouverte d'un coup. */
function updateHourglassFlips(
  args: MechanismUpdateArgs,
  states: Map<string, MechanismState>,
  events: SimEvent[],
  pressed: (p: PlayerState) => boolean,
  consumed: Set<PlayerId>,
): void {
  const { room, players } = args;
  const n = Math.max(1, players.length);
  for (const p of players) {
    if (!pressed(p)) continue;
    let best: { def: HourglassDef; st: HourglassState; lever: number; d: number } | null = null;
    for (const def of room.mechanisms) {
      if (def.type !== 'hourglass') continue;
      const st = stateOfType(states, def.id, 'hourglass');
      if (!st || st.waived) continue;
      const lever = hourglassLeverIndex(def, p);
      if (lever < 0) continue;
      const d = dist(p.pos, tileCenterPx(def.levers[lever]));
      if (best === null || d < best.d) best = { def, st, lever, d };
    }
    if (!best) continue;
    best.st.sandMs = effectiveHourglassPeriodMs(best.def, n);
    best.st.closedCount = 0;
    best.st.stepMs = hourglassCloseStepMs(best.def);
    best.st.lastLever = best.lever;
    setActive(best.st, true, events);
    events.push({ type: 'hourglassFlipped', mechanismId: best.def.id, leverIndex: best.lever, playerId: p.id });
    consumed.add(p.id);
  }
}

// ── Pont de lumière ──

/**
 * Porteur de la lanterne d'un pont : joueur `lanternSlot % n` s'il est vivant. S'il est À TERRE, la lanterne est reprise par le joueur
 * VIVANT le plus proche de lui (égalité : le plus petit id) : sans cela, un porteur tombé loin de l'équipe (ou sur l'autre rive) laisse
 * les suiveurs bloqués sur un pont éteint, sans pouvoir ni le relever ni avancer, et sans défaite collective puisqu'ils sont vivants
 * (impasse). Null seulement si plus personne n'est vivant.
 */
export function lightBridgeBearer(def: LightBridgeDef, players: readonly PlayerState[]): PlayerState | null {
  const n = Math.max(1, players.length);
  const b = playerById(players, resolveSlot(def.lanternSlot, n));
  if (b && b.status === 'alive') return b;
  let best: PlayerState | null = null;
  let bestD = Infinity;
  for (const p of players) {
    if (p.status !== 'alive') continue;
    const d = b ? dist(p.pos, b.pos) : 0;
    if (d < bestD) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

/** Éclairage des tuiles du pont (halo du porteur ou occupation par un joueur vivant), `active` = halo sur au moins une tuile. */
function updateLightBridges(args: MechanismUpdateArgs, states: Map<string, MechanismState>, events: SimEvent[]): void {
  for (const def of args.room.mechanisms) {
    if (def.type !== 'lightBridge') continue;
    const st = stateOfType(states, def.id, 'lightBridge');
    if (!st || st.waived) continue;
    const bearer = lightBridgeBearer(def, args.players);
    st.bearerId = bearer ? bearer.id : null;
    const reach = def.radiusTiles * TILE;
    let byBearer = false;
    const lit: boolean[] = def.tiles.map((t) => {
      const lanternLit = bearer !== null && dist(tileCenterPx(t), bearer.pos) <= reach;
      if (lanternLit) {
        byBearer = true;
        return true;
      }
      return args.players.some((p) => {
        if (p.status !== 'alive') return false;
        const pt = tileOfPlayer(p);
        return pt[0] === t[0] && pt[1] === t[1];
      });
    });
    st.lit = lit;
    setActive(st, byBearer, events);
  }
}

// ── Blocs ──

function dominantDir(f: ActionFrame): Dir | null {
  const ax = Math.abs(f.moveX);
  const ay = Math.abs(f.moveY);
  if (Math.max(ax, ay) < PUSH_AXIS_THRESHOLD) return null;
  if (ax >= ay) return f.moveX > 0 ? 'right' : 'left';
  return f.moveY > 0 ? 'down' : 'up';
}

/** Joueurs vivants au contact d'une face du bloc ET pressant vers lui, groupés par direction de poussée. */
function contactPushers(rect: PixelRect, players: readonly PlayerState[], frames: TickInputs): Record<Dir, PlayerState[]> {
  const res: Record<Dir, PlayerState[]> = { up: [], down: [], left: [], right: [] };
  const r = PLAYER_RADIUS;
  const m = PUSH_CONTACT_MARGIN;
  const t = PUSH_TANGENT_TOLERANCE;
  for (const p of players) {
    if (p.status !== 'alive') continue;
    const f = frames[p.id];
    if (!f) continue;
    const dir = dominantDir(f);
    if (!dir) continue;
    const { x, y } = p.pos;
    const withinY = y >= rect.y - t && y <= rect.y + rect.h + t;
    const withinX = x >= rect.x - t && x <= rect.x + rect.w + t;
    let ok = false;
    switch (dir) {
      case 'right': // joueur sur la face gauche
        ok = withinY && x <= rect.x + 1 && x + r >= rect.x - m;
        break;
      case 'left': // face droite
        ok = withinY && x >= rect.x + rect.w - 1 && x - r <= rect.x + rect.w + m;
        break;
      case 'down': // face haute
        ok = withinX && y <= rect.y + 1 && y + r >= rect.y - m;
        break;
      case 'up': // face basse
        ok = withinX && y >= rect.y + rect.h - 1 && y - r <= rect.y + rect.h + m;
        break;
    }
    if (ok) res[dir].push(p);
  }
  return res;
}

function tryTranslatePlayer(grid: RoomGrid, p: PlayerState, dx: number, dy: number): void {
  const nx = p.pos.x + dx;
  const ny = p.pos.y + dy;
  if (!circleOverlapsBlockedTile(grid, nx, ny, PLAYER_RADIUS)) {
    p.pos.x = nx;
    p.pos.y = ny;
  }
}

function dirFromDelta(dx: number, dy: number): Dir {
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'down' : 'up';
}

function updateBlocks(args: MechanismUpdateArgs, states: Map<string, MechanismState>, n: number): void {
  const { room, grid, players, frames, dtMs } = args;
  for (const def of room.mechanisms) {
    if (def.type !== 'block') continue;
    const st = stateOfType(states, def.id, 'block');
    if (!st) continue;
    const required = requiredPushers(def, n);

    // 1. Avancement du déplacement en cours (les pousseurs au contact sont entraînés).
    if (st.moving) {
      const toPx = { x: st.moving.to[0] * TILE, y: st.moving.to[1] * TILE };
      const moveDir = dirFromDelta(toPx.x - st.pos.x, toPx.y - st.pos.y);
      const carried = contactPushers(blockRect(st), players, frames)[moveDir];
      const p0 = st.moving.progress;
      const p1 = Math.min(1, p0 + dtMs / BLOCK_MOVE_MS);
      let nx: number;
      let ny: number;
      if (p1 >= 1) {
        nx = toPx.x;
        ny = toPx.y;
      } else {
        const frac = (p1 - p0) / (1 - p0);
        nx = st.pos.x + (toPx.x - st.pos.x) * frac;
        ny = st.pos.y + (toPx.y - st.pos.y) * frac;
      }
      const dx = nx - st.pos.x;
      const dy = ny - st.pos.y;
      st.pos.x = nx;
      st.pos.y = ny;
      for (const p of carried) tryTranslatePlayer(grid, p, dx, dy);
      if (p1 >= 1) st.moving = null;
      else st.moving.progress = p1;
    }

    // 2. Évaluation de la poussée courante.
    const contacts = contactPushers(blockRect(st), players, frames);
    const qualifying = DIRS.filter((d) => contacts[d].length >= required);
    if (qualifying.length !== 1) {
      st.pushMs = 0;
      continue;
    }
    st.pushMs = Math.min(PUSH_THRESHOLD_MS, st.pushMs + dtMs);
    if (st.moving === null && st.pushMs >= PUSH_THRESHOLD_MS - 1e-6) {
      const dir = qualifying[0];
      const v = DIR_VEC[dir];
      const to: TileXY = [st.tile[0] + v.x, st.tile[1] + v.y];
      if (canBlockMoveTo(args, states, def.id, to, contacts[dir])) {
        st.moving = { to, progress: 0 };
        st.tile = [to[0], to[1]];
      }
    }
  }
}

/** Les 4 tuiles cibles sont-elles libres (mur, fosse, porte fermée, autre bloc, joueur hors pousseurs, ennemi) ? */
function canBlockMoveTo(
  args: MechanismUpdateArgs,
  states: Map<string, MechanismState>,
  blockId: string,
  to: TileXY,
  pushers: readonly PlayerState[],
): boolean {
  const { room, grid, players } = args;
  for (let dy = 0; dy < BLOCK_SIZE_TILES; dy++) {
    for (let dx = 0; dx < BLOCK_SIZE_TILES; dx++) {
      if (grid.blocksMovement(to[0] + dx, to[1] + dy)) return false;
    }
  }
  const target: PixelRect = { x: to[0] * TILE, y: to[1] * TILE, w: BLOCK_PX, h: BLOCK_PX };
  // Solides fixes : portes fermées, braseros, statues, herse de sablier fermée, tuiles de pont éteintes.
  for (const r of staticSolidRects(room, states)) {
    if (rectsOverlap(target, r)) return false;
  }
  for (const def of room.mechanisms) {
    if (def.type === 'block' && def.id !== blockId) {
      const bs = stateOfType(states, def.id, 'block');
      if (!bs) continue;
      if (rectsOverlap(target, blockRect(bs))) return false;
      if (rectsOverlap(target, { x: bs.tile[0] * TILE, y: bs.tile[1] * TILE, w: BLOCK_PX, h: BLOCK_PX })) return false;
    }
  }
  for (const p of players) {
    if (pushers.includes(p)) continue;
    if (circleIntersectsRect(p.pos.x, p.pos.y, PLAYER_RADIUS, target)) return false;
  }
  if (args.enemyCircles) {
    for (const c of args.enemyCircles) {
      if (circleIntersectsRect(c.x, c.y, c.r, target)) return false;
    }
  }
  return true;
}
