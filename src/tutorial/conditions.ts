/**
 * Évaluation des `Condition` du tutoriel (PUR, lecture seule sur GameState). S'appuie sur les mêmes aides que le HUD
 * (`requirementContextFor`, `computeExitOpen`, `pendingSpawnCount`, `nearestSign`) pour que le tutoriel et l'écran soient
 * TOUJOURS d'accord sur ce qui est « fait ».
 */
import { BLOCK_SIZE_TILES, TILE, TORCH_MAX_MS } from '../core/constants';
import { RoomGrid } from '../core/grid';
import { isRequirementMet } from '../core/mechanisms';
import { isObjectiveDone } from '../core/objectives';
import type { GameState, LevelDef, PlayerId, RoomDef, SimEvent, Vec2 } from '../core/types';
import { nearestSign } from '../render/hud';
import { computeExitOpen, pendingSpawnCount, requirementContextFor } from '../render/roomGoals';
import type { Condition, HudRegionId, LoggedEvent } from './types';

/** Le joueur humain et son partenaire scripté. */
export const HUMAN_ID: PlayerId = 0;
export const PARTNER_ID: PlayerId = 1;

/** Marge de combustible (ms) en dessous de laquelle on considère que la torche « s'est consumée ». */
export const TORCH_USED_MARGIN_MS = 1000;

/** Contexte d'évaluation d'une condition. */
export interface ConditionCtx {
  level: LevelDef;
  state: GameState;
  room: RoomDef;
  /** Événements survenus depuis le début de l'étape courante. */
  events: readonly LoggedEvent[];
  /** Déplacement cumulé du joueur depuis le début de l'étape (px). */
  movedPx: number;
  /** Panneau devant lequel le joueur se tient et depuis combien de temps (ms). */
  signNear: { id: string | null; ms: number };
  /** Zones du HUD actuellement visibles. */
  regions: readonly HudRegionId[];
}

/** Types d'événements conservés dans le journal d'étape (les autres sont trop bavards et inutiles aux conditions). */
export const LOGGED_EVENT_TYPES: ReadonlySet<SimEvent['type']> = new Set<SimEvent['type']>([
  'roomEntered',
  'roomCleared',
  'levelCompleted',
  'enemyDied',
  'specialUsed',
  'keyPicked',
  'doorOpened',
  'brazierLit',
  'torchRefueled',
  'objectiveCompleted',
  'playerDown',
  'playerRevived',
  'reviveStarted',
  'reviveInterrupted',
  'teamWipe',
  'callStarted',
  'mechanismChanged',
]);

/** Taille maximale du journal d'événements d'une étape. */
export const MAX_LOGGED_EVENTS = 48;

/** Joueur acteur d'un événement (qui a fait l'action), ou null. */
export function eventActor(e: SimEvent): PlayerId | null {
  switch (e.type) {
    case 'enemyDied':
    case 'enemyHit':
      return e.byPlayer;
    case 'playerRevived':
    case 'reviveStarted':
    case 'reviveInterrupted':
      return e.reviverId;
    case 'specialUsed':
    case 'keyPicked':
    case 'brazierLit':
    case 'torchRefueled':
    case 'callStarted':
    case 'objectiveCompleted':
    case 'playerDown':
    case 'playerAttack':
      return e.playerId;
    default:
      return null;
  }
}

/** Nombre d'événements du journal qui correspondent à la condition `event`. */
export function countEvents(events: readonly LoggedEvent[], c: Extract<Condition, { k: 'event' }>): number {
  let n = 0;
  for (const e of events) {
    if (e.type !== c.type) continue;
    if (c.by !== undefined && eventActor(e) !== c.by) continue;
    if (c.match) {
      const rec = e as unknown as Record<string, unknown>;
      let ok = true;
      for (const [k, v] of Object.entries(c.match)) {
        if (rec[k] !== v) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
    }
    n++;
  }
  return n;
}

/** Distance (px) entre le joueur et son partenaire ; 0 si l'un des deux est absent. */
export function humanPartnerDistancePx(state: GameState): number {
  const a = state.players[HUMAN_ID];
  const b = state.players[PARTNER_ID];
  if (!a || !b) return 0;
  return Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y);
}

/** Plus aucun ennemi vivant ni apparition en attente. */
export function enemiesGone(state: GameState, room: RoomDef): boolean {
  for (const e of state.room.enemies) if (!e.dead && e.hp > 0) return false;
  return pendingSpawnCount(state, room) === 0;
}

/**
 * Le bloc `blockId` est-il irrécupérable ? Un bloc collé à une paroi ne peut plus s'en éloigner (il faudrait un pousseur DANS le mur) :
 * il est mort dès que son socle n'est pas sur la même ligne/colonne que lui sur l'axe concerné. Lecture seule, pur, déterministe.
 */
export function isBlockDead(state: GameState, room: RoomDef, blockId: string): boolean {
  const st = state.room.mechanisms.find((m) => m.id === blockId);
  const socket = room.mechanisms.find((d) => d.type === 'socket' && d.blockId === blockId);
  if (!st || st.type !== 'block' || !socket || socket.type !== 'socket') return false;
  const grid = new RoomGrid(room.layout);
  const [bx, by] = st.tile;
  const [sx, sy] = socket.tile;
  const span = Array.from({ length: BLOCK_SIZE_TILES }, (_, i) => i);
  const colBlocked = (x: number): boolean => span.some((d) => grid.blocksMovement(x, by + d));
  const rowBlocked = (y: number): boolean => span.some((d) => grid.blocksMovement(bx + d, y));
  if (bx !== sx && (colBlocked(bx - 1) || colBlocked(bx + BLOCK_SIZE_TILES))) return true;
  if (by !== sy && (rowBlocked(by - 1) || rowBlocked(by + BLOCK_SIZE_TILES))) return true;
  return false;
}

/** Position du joueur humain (ou null). */
export function humanPos(state: GameState): Vec2 | null {
  return state.players[HUMAN_ID]?.pos ?? null;
}

/** Évalue une condition. Ne lève jamais (état inattendu → false). */
export function evalCondition(c: Condition, ctx: ConditionCtx): boolean {
  const { state, level, room } = ctx;
  const human = state.players[HUMAN_ID];
  switch (c.k) {
    case 'moved':
      return ctx.movedPx >= c.px;
    case 'nearSign':
      return ctx.signNear.id === c.id && ctx.signNear.ms >= c.ms;
    case 'event':
      return countEvents(ctx.events, c) >= (c.count ?? 1);
    case 'req':
      return isRequirementMet(c.token, requirementContextFor(state, level, room));
    case 'objective':
      return isObjectiveDone(state.objectives, c.id);
    case 'enemiesGone':
      return enemiesGone(state, room);
    case 'exitOpen':
      return computeExitOpen(state, level, room);
    case 'near':
      return humanPartnerDistancePx(state) <= c.tiles * TILE;
    case 'far':
      return humanPartnerDistancePx(state) > c.tiles * TILE;
    case 'torchUsed':
      return !!human && human.torchMs < TORCH_MAX_MS - TORCH_USED_MARGIN_MS;
    case 'holdsKey':
      return !!human && human.keys.length > 0;
    case 'blockDead':
      return isBlockDead(state, room, c.id);
    case 'regionVisible':
      return ctx.regions.includes(c.id);
    case 'all':
      return c.of.every((x) => evalCondition(x, ctx));
    case 'any':
      return c.of.some((x) => evalCondition(x, ctx));
    default:
      return false;
  }
}

/** Met à jour le suivi du panneau devant lequel se tient le joueur (appelé à chaque pas). */
export function stepSignNear(prev: { id: string | null; ms: number }, state: GameState, room: RoomDef, dtMs: number): { id: string | null; ms: number } {
  const human = state.players[HUMAN_ID];
  const sign = human ? nearestSign(room, human) : null;
  const id = sign ? sign.id : null;
  if (id === null) return { id: null, ms: 0 };
  return { id, ms: prev.id === id ? prev.ms + dtMs : 0 };
}
