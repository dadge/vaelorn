/**
 * SAUVEGARDE DE LA PROGRESSION — logique PURE (aucun Phaser/DOM/Date/Math.random, aucun accès au stockage).
 *
 * Principe : la sauvegarde décrit une ÉQUIPE (joueurs, personnages, difficultés), le niveau et la SALLE de reprise, ainsi que
 * la liste des niveaux terminés. Elle est écrite au DÉBUT de chaque salle (événement `roomEntered` 'start' | 'next') et à la
 * fin d'un niveau (`levelCompleted`) — jamais en pleine salle. Une défaite collective (`roomEntered` 'restart') ne la modifie pas.
 *
 * Ce module ne fait que :
 *  - définir le format (`SaveGame`, version de schéma courante `SAVE_SCHEMA_VERSION`) ;
 *  - sérialiser / désérialiser / VALIDER une donnée non fiable (`parseSave`) ;
 *  - MIGRER les anciennes versions vers la version courante (v0 → v1 → v2) ;
 *  - construire une `SimConfig` de reprise, et mettre à jour la sauvegarde (salle atteinte, niveau terminé, événements de simulation).
 *
 * Il ne connaît pas `src/levels` : l'appelant fournit un `SaveContext` (identifiants des niveaux et nombre de salles).
 * Le stockage (localStorage…) est dans `saveRepository.ts`.
 *
 * Historique des versions de schéma :
 *  - v0 (prototype, sans `schemaVersion`) : `{ level: <n° de niveau, 1-based>, room: <indice de salle>, chars: string[], diffs: number[], done: <n° de niveaux terminés>[] }` ;
 *  - v1 : `{ schemaVersion: 1, levelIndex, roomIndex, players: [{characterId, difficulty}], completedLevelIndices: number[] }`
 *         (références aux niveaux par INDICE : fragile dès qu'on insère ou réordonne des niveaux) ;
 *  - v2 (courante) : références par IDENTIFIANT de niveau (`levelId`, `completedLevelIds`), stables à l'ajout de niveaux.
 */
import { CHARACTERS, CHARACTER_IDS } from './characters';
import { MAX_PLAYERS } from './constants';
import type { CharacterId, Difficulty, PlayerId, PlayerSetup, SimConfig, SimEvent } from './types';

// ───────────────────────────── Types ─────────────────────────────

/** Version de schéma écrite par cette version du jeu. */
export const SAVE_SCHEMA_VERSION = 2;

/** Joueur sauvegardé : l'identifiant de joueur est l'indice dans `SaveGame.players`. */
export interface SavedPlayer {
  characterId: CharacterId;
  difficulty: Difficulty;
}

/** Sauvegarde de progression (JSON pur). Le nombre de joueurs est `players.length` (1..4). */
export interface SaveGame {
  schemaVersion: typeof SAVE_SCHEMA_VERSION;
  /** Niveau de reprise (identifiant de `LevelDef`). */
  levelId: string;
  /** Salle de reprise dans ce niveau (indice 0-based). */
  roomIndex: number;
  /** Équipe figée : personnages et difficultés de chaque joueur. */
  players: SavedPlayer[];
  /** Niveaux terminés, dans l'ordre où ils l'ont été. */
  completedLevelIds: string[];
}

/** Description minimale d'un niveau connu (le core ne dépend pas de `src/levels`). */
export interface SaveLevelInfo {
  id: string;
  roomCount: number;
}

/** Niveaux connus, dans l'ordre de progression. */
export interface SaveContext {
  levels: readonly SaveLevelInfo[];
}

/** Construit un `SaveContext` depuis des `LevelDef` (ou tout objet {id, rooms}). */
export function saveContextFromLevels(levels: readonly { id: string; rooms: readonly unknown[] }[]): SaveContext {
  return { levels: levels.map((l) => ({ id: l.id, roomCount: l.rooms.length })) };
}

/** Cause d'invalidité d'une sauvegarde (la scène la traduit via la clé i18n `save.error.<reason>`). */
export type SaveErrorReason =
  | 'invalidJson'
  | 'notAnObject'
  | 'missingField'
  | 'invalidField'
  | 'unknownVersion'
  | 'futureVersion'
  | 'unknownLevel'
  | 'invalidRoom'
  | 'invalidPlayers'
  | 'unknownCharacter'
  | 'duplicateCharacter';

/** Toutes les causes possibles (tests de couverture i18n). */
export const SAVE_ERROR_REASONS: readonly SaveErrorReason[] = [
  'invalidJson',
  'notAnObject',
  'missingField',
  'invalidField',
  'unknownVersion',
  'futureVersion',
  'unknownLevel',
  'invalidRoom',
  'invalidPlayers',
  'unknownCharacter',
  'duplicateCharacter',
];

/** Erreur de lecture : cause + champ fautif (diagnostic technique, jamais traduit). */
export interface SaveParseError {
  reason: SaveErrorReason;
  field?: string;
  detail?: string;
}

/** Résultat de `parseSave` / `validateSave` / `migrateSave`. */
export type ParseSaveResult =
  | { ok: true; save: SaveGame; /** Version d'origine si une migration a eu lieu, sinon null. */ migratedFrom: number | null }
  | { ok: false; error: SaveParseError };

// ───────────────────────────── Utilitaires de validation ─────────────────────────────

type Rec = Record<string, unknown>;

function isRecord(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fail(reason: SaveErrorReason, field?: string, detail?: string): { ok: false; error: SaveParseError } {
  const error: SaveParseError = { reason };
  if (field !== undefined) error.field = field;
  if (detail !== undefined) error.detail = detail;
  return { ok: false, error };
}

function isDifficulty(v: unknown): v is Difficulty {
  return v === 1 || v === 2 || v === 3;
}

function isCharacterId(v: unknown): v is CharacterId {
  return typeof v === 'string' && (CHARACTER_IDS as readonly string[]).includes(v) && Object.prototype.hasOwnProperty.call(CHARACTERS, v);
}

function isNonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function levelInfo(ctx: SaveContext, levelId: string): SaveLevelInfo | undefined {
  return ctx.levels.find((l) => l.id === levelId);
}

// ───────────────────────────── Validation de la version courante ─────────────────────────────

/**
 * Valide un objet de version COURANTE (v2) et retourne une copie propre (champs inconnus ignorés).
 * Ne tolère rien : niveau inconnu, salle hors plage, personnage inconnu/doublon, joueurs hors 1..4 → erreur.
 */
export function validateSave(data: unknown, ctx: SaveContext): ParseSaveResult {
  if (!isRecord(data)) return fail('notAnObject');
  if (data.schemaVersion !== SAVE_SCHEMA_VERSION) return fail('unknownVersion', 'schemaVersion');

  if (!('levelId' in data)) return fail('missingField', 'levelId');
  if (typeof data.levelId !== 'string') return fail('invalidField', 'levelId');
  const level = levelInfo(ctx, data.levelId);
  if (!level) return fail('unknownLevel', 'levelId', data.levelId);

  if (!('roomIndex' in data)) return fail('missingField', 'roomIndex');
  if (!isNonNegInt(data.roomIndex)) return fail('invalidField', 'roomIndex');
  if (data.roomIndex >= level.roomCount) return fail('invalidRoom', 'roomIndex', String(data.roomIndex));

  if (!('players' in data)) return fail('missingField', 'players');
  if (!Array.isArray(data.players)) return fail('invalidField', 'players');
  if (data.players.length < 1 || data.players.length > MAX_PLAYERS) {
    return fail('invalidPlayers', 'players', String(data.players.length));
  }
  const players: SavedPlayer[] = [];
  const seen = new Set<CharacterId>();
  for (let i = 0; i < data.players.length; i++) {
    const p: unknown = data.players[i];
    if (!isRecord(p)) return fail('invalidField', `players[${i}]`);
    if (!('characterId' in p)) return fail('missingField', `players[${i}].characterId`);
    if (!isCharacterId(p.characterId)) {
      return typeof p.characterId === 'string'
        ? fail('unknownCharacter', `players[${i}].characterId`, p.characterId)
        : fail('invalidField', `players[${i}].characterId`);
    }
    if (!('difficulty' in p)) return fail('missingField', `players[${i}].difficulty`);
    if (!isDifficulty(p.difficulty)) return fail('invalidField', `players[${i}].difficulty`);
    if (seen.has(p.characterId)) return fail('duplicateCharacter', `players[${i}].characterId`, p.characterId);
    seen.add(p.characterId);
    players.push({ characterId: p.characterId, difficulty: p.difficulty });
  }

  if (!('completedLevelIds' in data)) return fail('missingField', 'completedLevelIds');
  if (!Array.isArray(data.completedLevelIds)) return fail('invalidField', 'completedLevelIds');
  const completed: string[] = [];
  for (let i = 0; i < data.completedLevelIds.length; i++) {
    const id: unknown = data.completedLevelIds[i];
    if (typeof id !== 'string') return fail('invalidField', `completedLevelIds[${i}]`);
    if (!levelInfo(ctx, id)) return fail('unknownLevel', `completedLevelIds[${i}]`, id);
    if (!completed.includes(id)) completed.push(id);
  }

  return {
    ok: true,
    save: { schemaVersion: SAVE_SCHEMA_VERSION, levelId: data.levelId, roomIndex: data.roomIndex, players, completedLevelIds: completed },
    migratedFrom: null,
  };
}

// ───────────────────────────── Migrations ─────────────────────────────

type MigrationResult = { ok: true; data: Rec } | { ok: false; error: SaveParseError };

/** Migration d'une version `n` vers `n + 1` (ne valide pas : `validateSave` le fait à la fin). */
type Migration = (data: Rec, ctx: SaveContext) => MigrationResult;

function needInt(data: Rec, field: string): number | SaveParseError {
  if (!(field in data)) return { reason: 'missingField', field };
  const v = data[field];
  if (typeof v !== 'number' || !Number.isInteger(v)) return { reason: 'invalidField', field };
  return v;
}

function needArray(data: Rec, field: string): unknown[] | SaveParseError {
  if (!(field in data)) return { reason: 'missingField', field };
  const v = data[field];
  if (!Array.isArray(v)) return { reason: 'invalidField', field };
  return v;
}

function isErr(v: unknown): v is SaveParseError {
  return isRecord(v) && typeof v.reason === 'string';
}

/**
 * v0 → v1 : format prototype (sans `schemaVersion`). `level` et `done` étaient des numéros de niveau 1-based ;
 * `chars` / `diffs` deux tableaux parallèles (difficulté absente → 2 « normal »).
 */
const migrateV0toV1: Migration = (data) => {
  const level = needInt(data, 'level');
  if (isErr(level)) return { ok: false, error: level };
  const room = needInt(data, 'room');
  if (isErr(room)) return { ok: false, error: room };
  const chars = needArray(data, 'chars');
  if (isErr(chars)) return { ok: false, error: chars };
  const diffsRaw = 'diffs' in data ? data.diffs : [];
  if (!Array.isArray(diffsRaw)) return { ok: false, error: { reason: 'invalidField', field: 'diffs' } };
  const done = 'done' in data ? data.done : [];
  if (!Array.isArray(done)) return { ok: false, error: { reason: 'invalidField', field: 'done' } };
  const players = chars.map((characterId, i) => ({ characterId, difficulty: diffsRaw[i] === undefined ? 2 : diffsRaw[i] }));
  const completedLevelIndices: unknown[] = [];
  for (const n of done) {
    if (typeof n !== 'number' || !Number.isInteger(n)) return { ok: false, error: { reason: 'invalidField', field: 'done' } };
    completedLevelIndices.push(n - 1);
  }
  return { ok: true, data: { schemaVersion: 1, levelIndex: level - 1, roomIndex: room, players, completedLevelIndices } };
};

/** v1 → v2 : les indices de niveau deviennent des identifiants (stables si l'on ajoute/insère des niveaux). */
const migrateV1toV2: Migration = (data, ctx) => {
  const levelIndex = needInt(data, 'levelIndex');
  if (isErr(levelIndex)) return { ok: false, error: levelIndex };
  const roomIndex = needInt(data, 'roomIndex');
  if (isErr(roomIndex)) return { ok: false, error: roomIndex };
  if (!('players' in data)) return { ok: false, error: { reason: 'missingField', field: 'players' } };
  const done = needArray(data, 'completedLevelIndices');
  if (isErr(done)) return { ok: false, error: done };
  const level = ctx.levels[levelIndex];
  if (!level) return { ok: false, error: { reason: 'unknownLevel', field: 'levelIndex', detail: String(levelIndex) } };
  const completedLevelIds: unknown[] = [];
  for (let i = 0; i < done.length; i++) {
    const idx = done[i];
    const l = typeof idx === 'number' && Number.isInteger(idx) ? ctx.levels[idx] : undefined;
    if (!l) return { ok: false, error: { reason: 'unknownLevel', field: `completedLevelIndices[${i}]`, detail: String(idx) } };
    completedLevelIds.push(l.id);
  }
  return { ok: true, data: { schemaVersion: 2, levelId: level.id, roomIndex, players: data.players, completedLevelIds } };
};

/** Migrations indexées par version SOURCE : `MIGRATIONS[n]` fait passer de la version n à n + 1. */
const MIGRATIONS: Readonly<Record<number, Migration>> = { 0: migrateV0toV1, 1: migrateV1toV2 };

/** Version de schéma d'une donnée brute : absente → 0 (prototype) ; invalide → null. */
function versionOf(data: Rec): number | null {
  if (!('schemaVersion' in data)) return 0;
  const v = data.schemaVersion;
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}

/**
 * Migre une donnée brute (objet déjà parsé) vers la version courante PUIS la valide. Une version future ou inconnue
 * est refusée (`futureVersion` / `unknownVersion`) : on ne devine jamais un format qu'on ne connaît pas.
 */
export function migrateSave(data: unknown, ctx: SaveContext): ParseSaveResult {
  if (!isRecord(data)) return fail('notAnObject');
  const from = versionOf(data);
  if (from === null) return fail('unknownVersion', 'schemaVersion');
  if (from > SAVE_SCHEMA_VERSION) return fail('futureVersion', 'schemaVersion', String(from));
  let current: Rec = data;
  for (let v = from; v < SAVE_SCHEMA_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (!step) return fail('unknownVersion', 'schemaVersion', String(v));
    const res = step(current, ctx);
    if (!res.ok) return res;
    current = res.data;
  }
  const validated = validateSave(current, ctx);
  if (!validated.ok) return validated;
  return { ok: true, save: validated.save, migratedFrom: from === SAVE_SCHEMA_VERSION ? null : from };
}

// ───────────────────────────── Sérialisation ─────────────────────────────

/** Sérialise une sauvegarde (JSON compact). */
export function serializeSave(save: SaveGame): string {
  return JSON.stringify(save);
}

/**
 * Désérialise et valide une chaîne lue du stockage (donnée NON FIABLE) : JSON invalide, champs manquants, version
 * inconnue/future, personnage ou niveau inconnu… → `{ ok: false }` (jamais d'exception). Migre si besoin.
 */
export function parseSave(raw: string, ctx: SaveContext): ParseSaveResult {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return fail('invalidJson');
  }
  return migrateSave(data, ctx);
}

// ───────────────────────────── Construction ─────────────────────────────

/** Équipe de la sauvegarde sous forme de `PlayerSetup` (id = indice). */
export function playersOfSave(save: SaveGame): PlayerSetup[] {
  return save.players.map((p, i) => ({ id: i as PlayerId, characterId: p.characterId, difficulty: p.difficulty }));
}

/** Sauvegarde d'une partie qui démarre : première salle du niveau `levelId`, aucun niveau terminé. */
export function newGameSave(players: readonly PlayerSetup[], levelId: string): SaveGame {
  const sorted = players.slice().sort((a, b) => a.id - b.id).slice(0, MAX_PLAYERS);
  return {
    schemaVersion: SAVE_SCHEMA_VERSION,
    levelId,
    roomIndex: 0,
    players: sorted.map((p) => ({ characterId: p.characterId, difficulty: p.difficulty })),
    completedLevelIds: [],
  };
}

/**
 * `SimConfig` de REPRISE : même équipe, niveau et salle de la sauvegarde (`startRoomIndex`). La graine est fournie par
 * l'appelant (le core n'a pas d'horloge). La simulation considère les objectifs et salles précédents comme accomplis.
 */
export function buildResumeSimConfig(save: SaveGame, seed: number): SimConfig {
  return { levelId: save.levelId, players: playersOfSave(save), seed, startRoomIndex: save.roomIndex };
}

/** Libellé de reprise sous forme de numéros 1-based (la scène l'affiche via `save.resume`). */
export interface ResumeInfo {
  levelId: string;
  /** Numéro de niveau (1-based). */
  level: number;
  /** Numéro de salle (1-based). */
  room: number;
  roomCount: number;
  playerCount: number;
}

/** Point de reprise de la sauvegarde (null si le niveau est inconnu du contexte). */
export function describeResume(save: SaveGame, ctx: SaveContext): ResumeInfo | null {
  const index = ctx.levels.findIndex((l) => l.id === save.levelId);
  if (index < 0) return null;
  return {
    levelId: save.levelId,
    level: index + 1,
    room: save.roomIndex + 1,
    roomCount: ctx.levels[index].roomCount,
    playerCount: save.players.length,
  };
}

// ───────────────────────────── Mises à jour ─────────────────────────────

/**
 * « Salle atteinte » : le point de reprise devient la salle `roomIndex` du niveau `levelId`. Sans effet (même référence)
 * si le niveau ou la salle est inconnu, ou si le point de reprise est déjà celui-ci.
 */
export function withRoomReached(save: SaveGame, levelId: string, roomIndex: number, ctx: SaveContext): SaveGame {
  const level = levelInfo(ctx, levelId);
  if (!level || !isNonNegInt(roomIndex) || roomIndex >= level.roomCount) return save;
  if (save.levelId === levelId && save.roomIndex === roomIndex) return save;
  return { ...save, levelId, roomIndex };
}

/**
 * « Niveau terminé » : ajoute `levelId` aux niveaux terminés et place la reprise en SALLE 0 du niveau suivant.
 * Après le dernier niveau, la reprise reste sur ce niveau (salle 0) : il n'y a pas de niveau suivant.
 * Sans effet (même référence) si le niveau est inconnu ou si l'état est déjà celui-là.
 */
export function withLevelCompleted(save: SaveGame, levelId: string, ctx: SaveContext): SaveGame {
  const index = ctx.levels.findIndex((l) => l.id === levelId);
  if (index < 0) return save;
  const next = ctx.levels[index + 1] ?? ctx.levels[index];
  const completedLevelIds = save.completedLevelIds.includes(levelId) ? save.completedLevelIds : [...save.completedLevelIds, levelId];
  if (completedLevelIds === save.completedLevelIds && save.levelId === next.id && save.roomIndex === 0) return save;
  return { ...save, levelId: next.id, roomIndex: 0, completedLevelIds };
}

/**
 * Applique les événements d'un pas de simulation à la sauvegarde :
 *  - `roomEntered` 'start' | 'next' → salle atteinte (niveau `levelId` de la partie en cours) ;
 *  - `roomEntered` 'restart' (défaite collective) → IGNORÉ : la sauvegarde ne change pas ;
 *  - `levelCompleted` → niveau terminé (reprise = salle 0 du niveau suivant).
 * Retourne la sauvegarde mise à jour (même référence si rien n'a changé). Les autres événements sont ignorés.
 *
 * @param levelId niveau joué par la simulation qui émet ces événements
 */
export function applySimEvents(save: SaveGame, levelId: string, events: readonly SimEvent[], ctx: SaveContext): SaveGame {
  let current = save;
  for (const e of events) {
    if (e.type === 'roomEntered') {
      if (e.reason === 'start' || e.reason === 'next') current = withRoomReached(current, levelId, e.roomIndex, ctx);
    } else if (e.type === 'levelCompleted') {
      current = withLevelCompleted(current, e.levelId, ctx);
    }
  }
  return current;
}
