/**
 * Objectifs personnels (logique pure, déterministe).
 *
 * Chaque `ObjectiveDef` du niveau a un `ObjectiveState` dans `GameState.objectives` (même ordre que
 * `level.objectives`). Le propriétaire est `resolveSlot(slot, nbJoueurs)` : à 1–3 joueurs, un joueur peut
 * posséder plusieurs objectifs. Un objectif accompli le reste pour toute la partie (persiste entre salles).
 * Un objectif ne progresse que lorsque la salle courante est celle de `ObjectiveDef.roomId`.
 */

import { TILE } from './constants';
import { resolveSlot } from './slots';
import type {
  EnemyKind,
  LevelDef,
  MechanismState,
  ObjectiveDef,
  ObjectiveState,
  PlayerId,
  PlayerState,
  RoomDef,
  SimEvent,
  TileRect,
} from './types';

/** Mort d'ennemi rapportée par la simulation pour le pas courant. */
export interface DeathRecord {
  kind: EnemyKind;
  /** Joueur à l'origine du coup fatal, ou null (boss, fosse, effet…). */
  byPlayer: PlayerId | null;
  roomId: string;
}

/** Arguments de `updateObjectives`. */
export interface ObjectiveUpdateArgs {
  level: LevelDef;
  /** Salle courante. */
  room: RoomDef;
  /** États à muter. */
  objectives: ObjectiveState[];
  players: readonly PlayerState[];
  /** États des mécanismes de la salle courante. */
  mechanisms: readonly MechanismState[];
  /** Ennemis morts pendant ce pas. */
  deaths: readonly DeathRecord[];
  dtMs: number;
  /**
   * Vrai quand plus aucun ennemi n'est vivant NI en attente d'apparition dans la salle courante. Filet anti-verrou :
   * un objectif 'kills' non accompli est alors accompli d'office (sinon, si les autres joueurs ont tué tous les
   * ennemis, l'objectif ne pourrait plus jamais progresser et la sortie resterait fermée).
   */
  roomCleared?: boolean;
}

/** Couple définition + état d'un objectif (voir `objectivesForPlayer`). */
export interface ObjectiveEntry {
  def: ObjectiveDef;
  state: ObjectiveState;
}

function findDef(level: LevelDef, id: string): ObjectiveDef | undefined {
  return level.objectives.find((o) => o.id === id);
}

function playerInRect(p: PlayerState, rect: TileRect): boolean {
  return (
    p.pos.x >= rect.x * TILE &&
    p.pos.x < (rect.x + rect.w) * TILE &&
    p.pos.y >= rect.y * TILE &&
    p.pos.y < (rect.y + rect.h) * TILE
  );
}

/**
 * Crée l'état initial des objectifs d'un niveau (même ordre que `level.objectives`).
 * `ownerId = resolveSlot(slot, playerCount)`.
 */
export function createObjectives(level: LevelDef, playerCount: number): ObjectiveState[] {
  return level.objectives.map((o) => ({
    id: o.id,
    ownerId: resolveSlot(o.slot, playerCount),
    done: false,
    progress: 0,
  }));
}

/**
 * Met à jour les objectifs de la salle courante pour UN pas. Mute `args.objectives`, retourne les
 * événements `objectiveCompleted`.
 *
 *  - 'mechanism' : accompli quand le mécanisme `mechanismId` (de la salle courante) est actif ou waived ;
 *  - 'zone'      : tant que le propriétaire est VIVANT dans la zone `zoneId`, cumule `dtMs/1000/seconds` (progress 0..1) ;
 *  - 'kills'     : compte les morts de `deaths` attribuées au propriétaire dans `roomId` (filtre `enemyKind`),
 *                  `progress = kills / count` ; accompli d'office si la salle est vidée (`roomCleared`).
 */
export function updateObjectives(args: ObjectiveUpdateArgs): SimEvent[] {
  const { level, room, objectives, players, mechanisms, deaths, dtMs, roomCleared } = args;
  const events: SimEvent[] = [];
  for (const st of objectives) {
    if (st.done) continue;
    const def = findDef(level, st.id);
    if (!def || def.roomId !== room.id) continue;

    let completed = false;
    switch (def.kind) {
      case 'mechanism': {
        const m = mechanisms.find((x) => x.id === def.mechanismId);
        if (m && (m.waived || m.active)) {
          st.progress = 1;
          completed = true;
        }
        break;
      }
      case 'zone': {
        const zone = room.zones?.find((z) => z.id === def.zoneId);
        const owner = players.find((p) => p.id === st.ownerId);
        const seconds = def.seconds ?? 0;
        if (zone && owner && owner.status === 'alive' && playerInRect(owner, zone.rect)) {
          if (seconds <= 0) {
            st.progress = 1;
          } else {
            st.progress = Math.min(1, st.progress + dtMs / 1000 / seconds);
          }
          if (st.progress >= 1 - 1e-9) {
            st.progress = 1;
            completed = true;
          }
        }
        break;
      }
      case 'kills': {
        const count = Math.max(1, def.count ?? 1);
        let gained = 0;
        for (const d of deaths) {
          if (d.roomId !== def.roomId || d.byPlayer !== st.ownerId) continue;
          if (def.enemyKind !== undefined && d.kind !== def.enemyKind) continue;
          gained++;
        }
        if (gained > 0) {
          const kills = Math.min(count, Math.round(st.progress * count) + gained);
          st.progress = kills / count;
          if (kills >= count) completed = true;
        }
        if (!completed && roomCleared) {
          // Filet anti-verrou : la salle est vidée, plus aucun ennemi ne peut compter.
          st.progress = 1;
          completed = true;
        }
        break;
      }
    }
    if (completed) {
      st.done = true;
      events.push({ type: 'objectiveCompleted', objectiveId: st.id, playerId: st.ownerId });
    }
  }
  return events;
}

/** L'objectif `id` est-il accompli ? (id inconnu ⇒ false) */
export function isObjectiveDone(objectives: readonly ObjectiveState[], id: string): boolean {
  return objectives.some((o) => o.id === id && o.done);
}

/** Tous les objectifs sont-ils accomplis ? (aucun objectif ⇒ true) */
export function allObjectivesDone(objectives: readonly ObjectiveState[]): boolean {
  return objectives.every((o) => o.done);
}

/**
 * Jeton 'zone:<objId>' : le propriétaire (vivant) de l'objectif de zone `objId` est-il EN CE MOMENT dans sa zone ?
 * Faux si l'objectif n'est pas de type 'zone', n'appartient pas à la salle `room`, ou si la zone est introuvable.
 */
export function isZoneOccupied(
  objectives: readonly ObjectiveState[],
  level: LevelDef,
  room: RoomDef,
  players: readonly PlayerState[],
  objId: string,
): boolean {
  const def = findDef(level, objId);
  if (!def || def.kind !== 'zone' || def.roomId !== room.id) return false;
  const st = objectives.find((o) => o.id === objId);
  if (!st) return false;
  const zone = room.zones?.find((z) => z.id === def.zoneId);
  if (!zone) return false;
  const owner = players.find((p) => p.id === st.ownerId);
  return !!owner && owner.status === 'alive' && playerInRect(owner, zone.rect);
}

/**
 * Remet à zéro (progress = 0) les objectifs NON accomplis de la salle `roomId`.
 * À appeler après une défaite collective (les objectifs accomplis restent accomplis). Mute `objectives`.
 */
export function resetRoomObjectives(objectives: ObjectiveState[], level: LevelDef, roomId: string): void {
  for (const st of objectives) {
    if (st.done) continue;
    const def = findDef(level, st.id);
    if (def && def.roomId === roomId) st.progress = 0;
  }
}

/** Objectifs (définition + état) dont le propriétaire est `playerId`, dans l'ordre du niveau. */
export function objectivesForPlayer(
  objectives: readonly ObjectiveState[],
  level: LevelDef,
  playerId: PlayerId,
): ObjectiveEntry[] {
  const out: ObjectiveEntry[] = [];
  for (const def of level.objectives) {
    const state = objectives.find((o) => o.id === def.id);
    if (state && state.ownerId === playerId) out.push({ def, state });
  }
  return out;
}
