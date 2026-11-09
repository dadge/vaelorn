/**
 * SAUVEGARDE DE LA PROGRESSION — logique PURE (aucun Phaser/DOM/Date/Math.random, aucun accès au stockage).
 *
 * Principe : la sauvegarde décrit une ÉQUIPE (joueurs, personnages, difficultés), le niveau et la SALLE de reprise, ainsi que
 * la liste des niveaux terminés. Elle est écrite au DÉBUT de chaque salle (événement `roomEntered` 'start' | 'next') et à la
 * fin d'un niveau (`levelCompleted`) — jamais en pleine salle. Une défaite collective (`roomEntered` 'restart') ne change PAS la salle de reprise ;
 * en revanche la PERTE d'équipement (`gearLost`, chute d'un joueur) est enregistrée immédiatement (règle stricte : quitter puis « Continuer » ne la restitue pas).
 *
 * Ce module ne fait que :
 *  - définir le format (`SaveGame`, version de schéma courante `SAVE_SCHEMA_VERSION`) ;
 *  - sérialiser / désérialiser / VALIDER une donnée non fiable (`parseSave`) ;
 *  - MIGRER les anciennes versions vers la version courante (v0 → v1 → v2 → v3) ;
 *  - construire une `SimConfig` de reprise, et mettre à jour la sauvegarde (salle atteinte, niveau terminé, événements de simulation).
 *
 * Il ne connaît pas `src/levels` : l'appelant fournit un `SaveContext` (identifiants des niveaux et nombre de salles).
 * Le stockage (localStorage…) est dans `saveRepository.ts`.
 *
 * Historique des versions de schéma :
 *  - v0 (prototype, sans `schemaVersion`) : `{ level: <n° de niveau, 1-based>, room: <indice de salle>, chars: string[], diffs: number[], done: <n° de niveaux terminés>[] }` ;
 *  - v1 : `{ schemaVersion: 1, levelIndex, roomIndex, players: [{characterId, difficulty}], completedLevelIndices: number[] }`
 *         (références aux niveaux par INDICE : fragile dès qu'on insère ou réordonne des niveaux) ;
 *  - v2 : références par IDENTIFIANT de niveau (`levelId`, `completedLevelIds`), stables à l'ajout de niveaux ;
 *  - v3 (courante) : v2 + ÉQUIPEMENT par joueur (`players[i].gear`, optionnel : absent = équipement vide). L'équipement dure jusqu'à la fin du
 *    niveau : il est écrit au début de chaque salle (l'équipement perdu n'y est évidemment plus), remis à zéro à la fin d'un niveau, et restitué
 *    par « Continuer ». Migration v2 → v3 : aucun équipement.
 */
import { CHARACTERS, CHARACTER_IDS } from './characters';
import { MAX_PLAYERS } from './constants';
import { ACCESSORY_KINDS, cloneGear, isGearEmpty, normalizeGear, sameGear } from './gear';
import type { CharacterId, Difficulty, PlayerGear, PlayerId, PlayerSetup, SimConfig, SimEvent } from './types';

// ───────────────────────────── Types ─────────────────────────────

/** Version de schéma écrite par cette version du jeu. */
export const SAVE_SCHEMA_VERSION = 3;

/** Joueur sauvegardé : l'identifiant de joueur est l'indice dans `SaveGame.players`. */
export interface SavedPlayer {
  characterId: CharacterId;
  difficulty: Difficulty;
  /** Équipement du joueur au début de la salle de reprise (v3). Absent = vide (jamais écrit quand il est vide : une sauvegarde sans équipement reste identique à celle d'avant). */
  gear?: PlayerGear;
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

/**
 * Valide l'équipement d'un joueur sauvegardé (donnée non fiable) : niveaux entiers 0..3 (absent = 0), accessoire absent / null ou {sorte connue, niveau 1..3}.
 * Retourne `undefined` si l'équipement est vide (rien à stocker), `null` si la donnée est invalide. L'appelant (`validateSave`) DÉGRADE alors en équipement vide :
 * l'équipement n'est qu'un bonus facultatif, une anomalie (retour à une version plus ancienne, sorte d'accessoire retirée) ne doit pas faire perdre la progression.
 */
function validateGear(v: unknown): PlayerGear | undefined | null {
  if (v === undefined) return undefined;
  if (!isRecord(v)) return null;
  for (const slot of ['boots', 'protection', 'artifact', 'magic', 'weapon']) {
    const lv = v[slot];
    if (lv !== undefined && !(typeof lv === 'number' && Number.isInteger(lv) && lv >= 0 && lv <= 3)) return null;
  }
  const acc = v.accessory;
  if (acc !== undefined && acc !== null) {
    if (!isRecord(acc)) return null;
    if (typeof acc.kind !== 'string' || !(ACCESSORY_KINDS as readonly string[]).includes(acc.kind)) return null;
    if (!(typeof acc.level === 'number' && Number.isInteger(acc.level) && acc.level >= 1 && acc.level <= 3)) return null;
  }
  const gear = normalizeGear(v);
  return isGearEmpty(gear) ? undefined : gear;
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
    // équipement invalide : traité comme VIDE (la progression - niveau, salle, équipe - reste lisible)
    const gearChecked = validateGear(p.gear);
    const gear = gearChecked === null ? undefined : gearChecked;
    players.push(gear ? { characterId: p.characterId, difficulty: p.difficulty, gear } : { characterId: p.characterId, difficulty: p.difficulty });
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

/** v2 → v3 : ajout de l'équipement par joueur ; une sauvegarde v2 n'en a aucun (champ `gear` absent = équipement vide). */
const migrateV2toV3: Migration = (data) => ({ ok: true, data: { ...data, schemaVersion: 3 } });

/** Migrations indexées par version SOURCE : `MIGRATIONS[n]` fait passer de la version n à n + 1. */
const MIGRATIONS: Readonly<Record<number, Migration>> = { 0: migrateV0toV1, 1: migrateV1toV2, 2: migrateV2toV3 };

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
  const config: SimConfig = { levelId: save.levelId, players: playersOfSave(save), seed, startRoomIndex: save.roomIndex };
  // « Continuer » restitue l'équipement (champ absent quand personne n'en porte : la configuration reste celle d'avant)
  if (save.players.some((p) => p.gear)) config.initialGear = save.players.map((p) => (p.gear ? cloneGear(p.gear) : undefined));
  return config;
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
  if (completedLevelIds === save.completedLevelIds && save.levelId === next.id && save.roomIndex === 0 && save.players.every((p) => !p.gear)) return save;
  // l'équipement dure jusqu'à la FIN DU NIVEAU : il est réinitialisé au niveau suivant
  const players = save.players.map((p) => ({ characterId: p.characterId, difficulty: p.difficulty }));
  return { ...save, levelId: next.id, roomIndex: 0, completedLevelIds, players };
}

/**
 * Met à jour l'équipement sauvegardé (un élément par joueur, dans l'ordre de `players`) : un équipement vide n'est pas stocké. Même référence si rien ne
 * change (ou si le nombre de joueurs ne correspond pas : donnée ignorée).
 */
export function withGear(save: SaveGame, gears: readonly PlayerGear[]): SaveGame {
  if (gears.length !== save.players.length) return save;
  let changed = false;
  const players = save.players.map((p, i) => {
    const g = gears[i];
    const before = p.gear ?? normalizeGear(undefined);
    if (sameGear(before, g)) return p;
    changed = true;
    const base = { characterId: p.characterId, difficulty: p.difficulty };
    return isGearEmpty(g) ? base : { ...base, gear: cloneGear(g) };
  });
  return changed ? { ...save, players } : save;
}

/**
 * Équipement PERDU : vide l'équipement sauvegardé des joueurs indiqués (identifiant = indice dans `players`) sans toucher à la salle de reprise ni à
 * l'équipement des autres (celui qu'ils ont ramassé en cours de salle n'est enregistré qu'au début de la salle suivante). Même référence si rien ne change.
 */
export function withGearLost(save: SaveGame, playerIds: readonly number[]): SaveGame {
  let changed = false;
  const players = save.players.map((p, i) => {
    if (!playerIds.includes(i) || !p.gear) return p;
    changed = true;
    return { characterId: p.characterId, difficulty: p.difficulty };
  });
  return changed ? { ...save, players } : save;
}

/**
 * Applique les événements d'un pas de simulation à la sauvegarde :
 *  - `roomEntered` 'start' | 'next' → salle atteinte (niveau `levelId` de la partie en cours) ;
 *  - `roomEntered` 'restart' (défaite collective) → IGNORÉ : la sauvegarde ne change pas ;
 *  - `levelCompleted` → niveau terminé (reprise = salle 0 du niveau suivant) ;
 *  - `gearLost` → l'équipement sauvegardé du joueur tombé est vidé (règle stricte : pas de point de reprise).
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
    } else if (e.type === 'gearLost') {
      current = withGearLost(current, [e.playerId]);
    }
  }
  return current;
}
