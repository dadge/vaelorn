/**
 * Validation statique d'un `LevelDef` + analyse d'atteignabilité, et fabriques de niveaux factices de test.
 *
 * `validateLevel(level, opts?)` retourne une liste d'erreurs lisibles (français) ; liste vide = niveau valide.
 * Logique pure : aucune dépendance à Phaser/DOM.
 *
 * ── Règles vérifiées ──
 *  Structure : ids uniques (salles, mécanismes par salle, objectifs, zones par salle, panneaux par salle) ;
 *  layout rectangulaire, glyphes valides ; au moins 4 `playerSpawns` ; tous les `TileXY` (spawns, plaques, leviers,
 *  clés, piédestaux, `displayTile`, ennemis, panneaux, décors, tuiles de portes) dans la grille ET sur un sol ('.' ou ',') ;
 *  exception : les décors `torch` et `banner` (accrochés aux murs) peuvent être sur un mur ; zones et sortie
 *  (rectangles) dans la grille et contenant au moins une tuile de sol. Une porte ne peut pas être posée sur un mur
 *  ni une fosse ; les 4 tuiles d'un bloc ou d'un socket 2×2 doivent être du sol. Aucune porte/bloc ne recouvre un
 *  spawn, un ennemi, un levier, une clé ou un piédestal.
 *  Exigences (`requires` des portes, `when` des apparitions, `exit.requires`) : id de mécanisme existant dans la salle
 *  (jamais la porte elle-même), 'clear', 'obj:<id objectif existant>', 'zone:<id d'un objectif de type zone existant>'.
 *  Clés ↔ portes : `KeyDef.doorId` désigne une porte de la salle dont `keyId` == id de la clé ; 1 clé ↔ 1 porte.
 *  Objectifs : salle/mécanisme/zone existants, `seconds` > 0 pour 'zone', `count` ≥ 1 pour 'kills', les 4 slots 0..3
 *  couverts. Exactement une salle finale (`exit.final`), et c'est la dernière. Blocs/sockets : un socket a au moins
 *  un bloc compatible. Runes : séquence non vide dont tous les symboles ont un piédestal.
 *  Torches / salles sombres : un brasero a une tuile de sol, un `ownerSlot` 0..3 et un `lightRadiusTiles` > 0 ; il est SOLIDE (la BFS
 *  ne le traverse pas, il doit être atteignable depuis un voisin) et ne recouvre ni spawn, ni ennemi, ni tuile de porte/bloc ;
 *  'enter:<zoneId>' doit désigner une ZoneDef existante de la salle (et atteignable) ; une salle `dark: true` doit contenir au moins
 *  un brasero `lit: true` accessible depuis les spawns (point de recharge, à chaque n) et TOUS ses spawns joueurs doivent se trouver à
 *  ≤ LIGHT_FULL_TILES tuiles d'un brasero `lit: true` ou d'un décor `torch` (zone de départ éclairée).
 *  i18n : si `opts.dictionaries` est fourni, toutes les clés requises (voir `collectRequiredI18nKeys`) doivent exister
 *  et être non vides dans CHAQUE dictionnaire.
 *
 * ── Règle « mécanisme coopératif » ──
 *  Chaque salle doit contenir au moins un mécanisme de type plate/lever/key/block/runePuzzle/brazier avec
 *  `(minPlayers ?? 1) <= 1` (donc présent même à 1 joueur), SAUF salle de boss pure : aucune entrée `mechanisms` et
 *  au moins un ennemi boss (`golem` ou `morvane`).
 *
 * ── Atteignabilité (n = 1, 2, 3, 4 joueurs) ──
 *  BFS 4-connexe sur les tuiles de sol depuis les n premiers spawns, portes comptées comme franchissables (ouvertes) et
 *  blocs comme déplaçables. Pour chaque n : tout mécanisme non waived (plaque/clé : sa tuile ; levier/piédestal : sa
 *  tuile ou une voisine ; porte/bloc/socket : leurs tuiles), tout ennemi présent à n joueurs, et la zone de sortie
 *  doivent être atteignables ; chaque exigence de porte/de sortie/d'apparition et chaque objectif doit être SATISFIABLE
 *  (mécanisme waived ou atteignable, dépendances de portes récursives sans cycle, clé atteignable, objectifs 'kills'
 *  avec assez d'ennemis). Limite connue : l'analyse ne détecte pas les verrous logiques (ex. un levier derrière sa propre
 *  porte), uniquement les cycles de dépendances et l'inatteignabilité géométrique.
 */

import { LIGHT_FULL_TILES } from './constants';
import type {
  DecorDef,
  EnemyKind,
  LevelDef,
  MechanismDef,
  ObjectiveDef,
  RoomDef,
  TileRect,
  TileXY,
} from './types';

// ───────────────────────────── API ─────────────────────────────

/** Options de `validateLevel`. */
export interface ValidateLevelOptions {
  /** Dictionnaires i18n à contrôler (nom → dictionnaire plat), ex. `{ fr, en }`. */
  dictionaries?: Record<string, Record<string, string>>;
  /** Vérifier aussi les clés `speaker.<id>` des dialogues (défaut : false). */
  checkSpeakers?: boolean;
}

/** Clé i18n requise par un niveau, avec son contexte (pour les messages). */
export interface I18nKeyRef {
  key: string;
  context: string;
}

const FLOOR_GLYPHS = new Set(['.', ',']);
const VALID_GLYPHS = new Set(['#', '.', ',', 'o', '~', ' ']);
const COOP_TYPES = new Set(['plate', 'lever', 'key', 'block', 'runePuzzle', 'brazier']);
const BOSS_KINDS = new Set<EnemyKind>(['golem', 'morvane']);
const WALL_DECOR = new Set<DecorDef['type']>(['torch', 'banner']);
const MAX_SLOT = 3;

// ───────────────────────────── Aides géométriques ─────────────────────────────

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

function isTile(t: unknown): t is TileXY {
  return Array.isArray(t) && t.length === 2 && isInt(t[0]) && isInt(t[1]);
}

function rowWidth(room: RoomDef): number {
  return room.layout.reduce((m, r) => Math.max(m, r.length), 0);
}

function inBounds(room: RoomDef, x: number, y: number): boolean {
  return y >= 0 && y < room.layout.length && x >= 0 && x < room.layout[y].length;
}

function glyph(room: RoomDef, x: number, y: number): string {
  return inBounds(room, x, y) ? room.layout[y][x] : ' ';
}

function isFloor(room: RoomDef, x: number, y: number): boolean {
  return FLOOR_GLYPHS.has(glyph(room, x, y));
}

/** Décrit pourquoi une tuile n'est pas utilisable, ou null si c'est du sol. */
function tileProblem(room: RoomDef, t: unknown): 'invalid' | 'out' | 'wall' | 'pit' | null {
  if (!isTile(t)) return 'invalid';
  if (!inBounds(room, t[0], t[1])) return 'out';
  const g = glyph(room, t[0], t[1]);
  if (FLOOR_GLYPHS.has(g)) return null;
  return g === '~' ? 'pit' : 'wall';
}

const PROBLEM_TEXT = {
  invalid: 'n\'est pas une tuile [x,y] entière',
  out: 'est hors de la grille',
  wall: 'est sur un mur, un pilier ou un vide',
  pit: 'est sur une fosse',
} as const;

function tileKey(room: RoomDef, x: number, y: number): number {
  return y * Math.max(1, rowWidth(room)) + x;
}

/** Tuiles occupées par un brasero (solide : non traversable) — clés `tileKey`. */
function brazierBlocked(room: RoomDef): Set<number> {
  const out = new Set<number>();
  for (const m of room.mechanisms ?? []) {
    if (m.type === 'brazier' && isTile(m.tile)) out.add(tileKey(room, m.tile[0], m.tile[1]));
  }
  return out;
}

function bfs(room: RoomDef, sources: readonly TileXY[]): Set<number> {
  const seen = new Set<number>();
  const queue: TileXY[] = [];
  const blocked = brazierBlocked(room);
  for (const s of sources) {
    if (isTile(s) && isFloor(room, s[0], s[1]) && !blocked.has(tileKey(room, s[0], s[1])) && !seen.has(tileKey(room, s[0], s[1]))) {
      seen.add(tileKey(room, s[0], s[1]));
      queue.push([s[0], s[1]]);
    }
  }
  for (let i = 0; i < queue.length; i++) {
    const [x, y] = queue[i];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (!isFloor(room, nx, ny)) continue;
      const k = tileKey(room, nx, ny);
      if (seen.has(k) || blocked.has(k)) continue;
      seen.add(k);
      queue.push([nx, ny]);
    }
  }
  return seen;
}

function rectInBounds(room: RoomDef, r: TileRect): boolean {
  if (!r || !isInt(r.x) || !isInt(r.y) || !isInt(r.w) || !isInt(r.h) || r.w <= 0 || r.h <= 0) return false;
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      if (!inBounds(room, x, y)) return false;
    }
  }
  return true;
}

function rectTiles(r: TileRect): TileXY[] {
  const out: TileXY[] = [];
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) out.push([x, y]);
  return out;
}

function squareTiles(t: TileXY, size = 2): TileXY[] {
  const out: TileXY[] = [];
  for (let dy = 0; dy < size; dy++) for (let dx = 0; dx < size; dx++) out.push([t[0] + dx, t[1] + dy]);
  return out;
}

function hasText(s: unknown): boolean {
  return typeof s === 'string' && s.trim().length > 0;
}

// ───────────────────────────── i18n ─────────────────────────────

/**
 * Liste toutes les clés i18n qu'un niveau référence : nom du niveau, textes des dialogues (+ `speaker.<id>` si
 * `checkSpeakers`), noms de salles, `introHintKey`, `labelKey` des mécanismes, textes des panneaux, libellés d'objectifs.
 */
export function collectRequiredI18nKeys(level: LevelDef, opts: { checkSpeakers?: boolean } = {}): I18nKeyRef[] {
  const refs: I18nKeyRef[] = [];
  const add = (key: unknown, context: string): void => {
    if (typeof key === 'string' && key.length > 0) refs.push({ key, context });
  };
  add(level.nameKey, `niveau "${level.id}" nameKey`);
  const lines = (arr: readonly { speaker: string; textKey: string }[], label: string): void => {
    arr.forEach((l, i) => {
      add(l.textKey, `niveau "${level.id}" ${label}[${i}].textKey`);
      if (opts.checkSpeakers) add(`speaker.${l.speaker}`, `niveau "${level.id}" ${label}[${i}].speaker`);
    });
  };
  lines(level.intro ?? [], 'intro');
  lines(level.outro ?? [], 'outro');
  for (const room of level.rooms ?? []) {
    add(room.nameKey, `salle "${room.id}" nameKey`);
    add(room.introHintKey, `salle "${room.id}" introHintKey`);
    for (const m of room.mechanisms ?? []) add(m.labelKey, `salle "${room.id}" mécanisme "${m.id}" labelKey`);
    for (const s of room.signs ?? []) add(s.textKey, `salle "${room.id}" panneau "${s.id}" textKey`);
  }
  for (const o of level.objectives ?? []) add(o.labelKey, `objectif "${o.id}" labelKey`);
  return refs;
}

// ───────────────────────────── Validation ─────────────────────────────

/**
 * Valide un niveau. Retourne la liste des erreurs (français, lisibles) ; tableau vide = niveau valide.
 * Voir l'en-tête du fichier pour la liste exhaustive des règles.
 */
export function validateLevel(level: LevelDef, opts: ValidateLevelOptions = {}): string[] {
  const errors: string[] = [];
  const err = (m: string): void => {
    errors.push(m);
  };

  if (!hasText(level.id)) err('niveau : id vide');
  if (!hasText(level.nameKey)) err(`niveau "${level.id}" : nameKey vide`);
  if (!Array.isArray(level.rooms) || level.rooms.length === 0) {
    err(`niveau "${level.id}" : aucune salle`);
    return errors;
  }
  if (!level.intro || level.intro.length === 0) err(`niveau "${level.id}" : intro vide`);
  if (!level.outro || level.outro.length === 0) err(`niveau "${level.id}" : outro vide`);

  // ids de salles uniques
  const roomIds = new Set<string>();
  for (const room of level.rooms) {
    if (!hasText(room.id)) err('salle : id vide');
    if (roomIds.has(room.id)) err(`salle "${room.id}" : id dupliqué`);
    roomIds.add(room.id);
  }

  // salle finale unique et dernière
  const finals = level.rooms.filter((r) => r.exit?.final === true);
  if (finals.length !== 1) {
    err(`niveau "${level.id}" : il faut exactement une salle finale (exit.final), trouvé ${finals.length}`);
  } else if (level.rooms[level.rooms.length - 1] !== finals[0]) {
    err(`salle "${finals[0].id}" : la salle finale (exit.final) doit être la dernière du niveau`);
  }

  // objectifs : ids uniques
  const objIds = new Set<string>();
  for (const o of level.objectives ?? []) {
    if (!hasText(o.id)) err('objectif : id vide');
    if (objIds.has(o.id)) err(`objectif "${o.id}" : id dupliqué`);
    objIds.add(o.id);
  }

  // salles (statique)
  const usable = new Set<string>(); // salles analysables (géométrie correcte)
  for (const room of level.rooms) {
    if (validateRoomStatic(room, level, err)) usable.add(room.id);
  }

  validateObjectivesStatic(level, err);

  // atteignabilité n = 1..4
  validateReachability(level, usable, err);

  // i18n
  if (opts.dictionaries) {
    const refs = collectRequiredI18nKeys(level, { checkSpeakers: opts.checkSpeakers });
    for (const [name, dict] of Object.entries(opts.dictionaries)) {
      for (const ref of refs) {
        const v = dict[ref.key];
        if (typeof v !== 'string' || v.trim() === '') {
          err(`i18n [${name}] : clé manquante ou vide "${ref.key}" (${ref.context})`);
        }
      }
    }
  }
  return errors;
}

/** Vérifie un jeton d'exigence ; retourne un message d'erreur ou null. */
function requirementProblem(token: string, room: RoomDef, level: LevelDef, selfId?: string): string | null {
  if (!hasText(token)) return 'jeton d\'exigence vide';
  if (token === 'clear') return null;
  if (token.startsWith('obj:')) {
    const id = token.slice(4);
    return (level.objectives ?? []).some((o) => o.id === id) ? null : `objectif inexistant "${id}"`;
  }
  if (token.startsWith('zone:')) {
    const id = token.slice(5);
    const o = (level.objectives ?? []).find((x) => x.id === id);
    if (!o) return `objectif de zone inexistant "${id}"`;
    return o.kind === 'zone' ? null : `l'objectif "${id}" n'est pas de type zone`;
  }
  if (token.startsWith('enter:')) {
    const id = token.slice(6);
    return (room.zones ?? []).some((z) => z.id === id) ? null : `zone inexistante "${id}" dans cette salle (jeton enter:)`;
  }
  if (token === selfId) return 'un mécanisme ne peut pas exiger lui-même';
  return room.mechanisms.some((m) => m.id === token) ? null : `mécanisme inexistant "${token}" dans cette salle`;
}

/** Validation d'une salle ; retourne false si la géométrie est inexploitable (analyse d'atteignabilité ignorée). */
function validateRoomStatic(room: RoomDef, level: LevelDef, err: (m: string) => void): boolean {
  const P = `salle "${room.id}"`;
  let geometryOk = true;

  if (!hasText(room.nameKey)) err(`${P} : nameKey vide`);

  // layout
  if (!Array.isArray(room.layout) || room.layout.length === 0) {
    err(`${P} : layout vide`);
    return false;
  }
  const w0 = room.layout[0].length;
  room.layout.forEach((row, y) => {
    if (typeof row !== 'string' || row.length !== w0) {
      err(`${P} : layout non rectangulaire (ligne ${y} de longueur ${row?.length} au lieu de ${w0})`);
      geometryOk = false;
    } else {
      for (let x = 0; x < row.length; x++) {
        if (!VALID_GLYPHS.has(row[x])) {
          err(`${P} : glyphe invalide '${row[x]}' en [${x},${y}]`);
          geometryOk = false;
          break;
        }
      }
    }
  });
  if (!geometryOk) return false;

  const tile = (t: unknown, label: string, allowWall = false): boolean => {
    const pb = tileProblem(room, t);
    if (pb === null) return true;
    if (allowWall && pb === 'wall') return true;
    err(`${P} : ${label} ${PROBLEM_TEXT[pb]}${isTile(t) ? ` [${t[0]},${t[1]}]` : ''}`);
    return false;
  };

  // spawns
  if (!Array.isArray(room.playerSpawns) || room.playerSpawns.length < 4) {
    err(`${P} : au moins 4 playerSpawns requis (trouvé ${room.playerSpawns?.length ?? 0})`);
  }
  (room.playerSpawns ?? []).forEach((s, i) => tile(s, `playerSpawns[${i}]`));

  // mécanismes
  const mechIds = new Set<string>();
  const doorTiles = new Map<string, string>();
  const blockTiles = new Map<string, string>();
  const tk = (t: TileXY): string => `${t[0]},${t[1]}`;

  for (const m of room.mechanisms ?? []) {
    if (!hasText(m.id)) err(`${P} : mécanisme sans id`);
    if (mechIds.has(m.id)) err(`${P} : id de mécanisme dupliqué "${m.id}"`);
    mechIds.add(m.id);
    if (m.minPlayers !== undefined && (!isInt(m.minPlayers) || m.minPlayers < 1 || m.minPlayers > 4)) {
      err(`${P} : mécanisme "${m.id}" minPlayers doit être un entier 1..4`);
    }
    validateMechanismStatic(m, room, P, tile, err);
    if (m.type === 'door' && Array.isArray(m.tiles)) {
      for (const t of m.tiles) if (isTile(t)) doorTiles.set(tk(t), m.id);
    }
    if (m.type === 'block' && isTile(m.tile)) {
      for (const t of squareTiles(m.tile)) blockTiles.set(tk(t), m.id);
    }
  }

  // exigences
  for (const m of room.mechanisms ?? []) {
    if (m.type !== 'door') continue;
    for (const r of m.requires ?? []) {
      const pb = requirementProblem(r, room, level, m.id);
      if (pb) err(`${P} : porte "${m.id}" requires "${r}" : ${pb}`);
    }
  }

  // clés ↔ portes
  const keyByDoor = new Map<string, string>();
  const doorByKey = new Map<string, string>();
  for (const m of room.mechanisms ?? []) {
    if (m.type === 'key') {
      const door = room.mechanisms.find((d) => d.id === m.doorId);
      if (!door || door.type !== 'door') {
        err(`${P} : clé "${m.id}" doorId "${m.doorId}" n'est pas une porte de la salle`);
      } else if (door.keyId !== m.id) {
        err(`${P} : clé "${m.id}" → porte "${door.id}" dont keyId est "${door.keyId ?? '(absent)'}" au lieu de "${m.id}"`);
      }
      if (keyByDoor.has(m.doorId)) err(`${P} : la porte "${m.doorId}" a plusieurs clés ("${keyByDoor.get(m.doorId)}" et "${m.id}")`);
      keyByDoor.set(m.doorId, m.id);
      if (!isInt(m.ownerSlot) || m.ownerSlot < 0 || m.ownerSlot > MAX_SLOT) {
        err(`${P} : clé "${m.id}" ownerSlot doit être un entier 0..3`);
      }
    }
  }
  for (const m of room.mechanisms ?? []) {
    if (m.type === 'door' && m.keyId !== undefined) {
      const key = room.mechanisms.find((k) => k.id === m.keyId);
      if (!key || key.type !== 'key') {
        err(`${P} : porte "${m.id}" keyId "${m.keyId}" n'est pas une clé de la salle`);
      } else if (key.doorId !== m.id) {
        err(`${P} : porte "${m.id}" → clé "${key.id}" dont doorId est "${key.doorId}" au lieu de "${m.id}"`);
      }
      if (doorByKey.has(m.keyId)) err(`${P} : la clé "${m.keyId}" est utilisée par plusieurs portes`);
      doorByKey.set(m.keyId, m.id);
    }
  }

  // braseros : tuiles occupées
  const brazierTiles = new Map<string, string>();
  for (const m of room.mechanisms ?? []) {
    if (m.type === 'brazier' && isTile(m.tile)) brazierTiles.set(tk(m.tile), m.id);
  }

  // chevauchements au démarrage
  const overlapCheck = (t: unknown, label: string, against: Map<string, string>, what: string): void => {
    if (isTile(t) && against.has(tk(t))) err(`${P} : ${label} [${t[0]},${t[1]}] recouvre ${what} "${against.get(tk(t))}"`);
  };
  (room.playerSpawns ?? []).forEach((s, i) => {
    overlapCheck(s, `playerSpawns[${i}]`, doorTiles, 'la porte');
    overlapCheck(s, `playerSpawns[${i}]`, blockTiles, 'le bloc');
    overlapCheck(s, `playerSpawns[${i}]`, brazierTiles, 'le brasero');
  });
  (room.enemies ?? []).forEach((e, i) => {
    overlapCheck(e.tile, `ennemi[${i}] (${e.kind})`, doorTiles, 'la porte');
    overlapCheck(e.tile, `ennemi[${i}] (${e.kind})`, blockTiles, 'le bloc');
    overlapCheck(e.tile, `ennemi[${i}] (${e.kind})`, brazierTiles, 'le brasero');
  });
  for (const m of room.mechanisms ?? []) {
    if (m.type === 'plate') overlapCheck(m.tile, `plaque "${m.id}"`, doorTiles, 'la porte');
    if (m.type === 'brazier') {
      overlapCheck(m.tile, `brasero "${m.id}"`, doorTiles, 'la porte');
      overlapCheck(m.tile, `brasero "${m.id}"`, blockTiles, 'le bloc');
    }
    if (m.type === 'lever' || m.type === 'key') {
      overlapCheck(m.tile, `${m.type === 'lever' ? 'levier' : 'clé'} "${m.id}"`, doorTiles, 'la porte');
      overlapCheck(m.tile, `${m.type === 'lever' ? 'levier' : 'clé'} "${m.id}"`, blockTiles, 'le bloc');
    }
    if (m.type === 'runePuzzle') {
      (m.pedestals ?? []).forEach((p, i) => {
        overlapCheck(p.tile, `piédestal ${i} de "${m.id}"`, doorTiles, 'la porte');
        overlapCheck(p.tile, `piédestal ${i} de "${m.id}"`, blockTiles, 'le bloc');
      });
    }
  }

  // ennemis
  (room.enemies ?? []).forEach((e, i) => {
    tile(e.tile, `ennemi[${i}] (${e.kind})`);
    if (e.minPlayers !== undefined && (!isInt(e.minPlayers) || e.minPlayers < 1 || e.minPlayers > 4)) {
      err(`${P} : ennemi[${i}] minPlayers doit être un entier 1..4`);
    }
    if (e.wave !== undefined && (!isInt(e.wave) || e.wave < 0)) err(`${P} : ennemi[${i}] wave doit être un entier >= 0`);
    if (e.when !== undefined) {
      const pb = requirementProblem(e.when, room, level);
      if (pb) err(`${P} : ennemi[${i}] when "${e.when}" : ${pb}`);
    }
  });

  // zones
  const zoneIds = new Set<string>();
  for (const z of room.zones ?? []) {
    if (!hasText(z.id)) err(`${P} : zone sans id`);
    if (zoneIds.has(z.id)) err(`${P} : id de zone dupliqué "${z.id}"`);
    zoneIds.add(z.id);
    if (!rectInBounds(room, z.rect)) err(`${P} : zone "${z.id}" rect invalide ou hors de la grille`);
    else if (!rectTiles(z.rect).some((t) => isFloor(room, t[0], t[1]))) err(`${P} : zone "${z.id}" ne contient aucune tuile de sol`);
  }

  // panneaux
  const signIds = new Set<string>();
  for (const s of room.signs ?? []) {
    if (signIds.has(s.id)) err(`${P} : id de panneau dupliqué "${s.id}"`);
    signIds.add(s.id);
    tile(s.tile, `panneau "${s.id}"`);
    if (!hasText(s.textKey)) err(`${P} : panneau "${s.id}" textKey vide`);
  }

  // décors
  (room.decor ?? []).forEach((d, i) => tile(d.tile, `décor[${i}] (${d.type})`, WALL_DECOR.has(d.type)));

  // sortie
  if (!room.exit || !room.exit.rect) {
    err(`${P} : sortie (exit) absente`);
  } else {
    if (!rectInBounds(room, room.exit.rect)) err(`${P} : exit.rect invalide ou hors de la grille`);
    else if (!rectTiles(room.exit.rect).some((t) => isFloor(room, t[0], t[1]))) err(`${P} : exit.rect ne contient aucune tuile de sol`);
    for (const r of room.exit.requires ?? []) {
      const pb = requirementProblem(r, room, level);
      if (pb) err(`${P} : exit.requires "${r}" : ${pb}`);
    }
  }

  // salle sombre : point de recharge + départ éclairé
  if (room.dark === true) {
    const lit = (room.mechanisms ?? []).filter((m) => m.type === 'brazier' && m.lit === true);
    if (lit.length === 0) {
      err(`${P} : salle sombre sans brasero allumé (lit: true) : aucun point de recharge de torche`);
    }
    const sources: TileXY[] = [];
    for (const m of lit) if (m.type === 'brazier' && isTile(m.tile)) sources.push(m.tile);
    for (const d of room.decor ?? []) if (d.type === 'torch' && isTile(d.tile)) sources.push(d.tile);
    (room.playerSpawns ?? []).forEach((sp, i) => {
      if (!isTile(sp)) return;
      const near = sources.some((t) => Math.hypot(t[0] - sp[0], t[1] - sp[1]) <= LIGHT_FULL_TILES);
      if (!near) {
        err(`${P} : salle sombre : playerSpawns[${i}] [${sp[0]},${sp[1]}] à plus de ${LIGHT_FULL_TILES} tuiles d'un brasero allumé ou d'un décor torch (départ non éclairé)`);
      }
    });
  }

  // mécanisme coopératif
  const hasCoop = (room.mechanisms ?? []).some((m) => COOP_TYPES.has(m.type) && (m.minPlayers ?? 1) <= 1);
  const pureBoss = (room.mechanisms ?? []).length === 0 && (room.enemies ?? []).some((e) => BOSS_KINDS.has(e.kind));
  if (!hasCoop && !pureBoss) {
    err(`${P} : aucun mécanisme coopératif (plate/lever/key/block/runePuzzle/brazier présent dès 1 joueur) et ce n'est pas une salle de boss pure`);
  }

  return true;
}

function validateMechanismStatic(
  m: MechanismDef,
  room: RoomDef,
  P: string,
  tile: (t: unknown, label: string, allowWall?: boolean) => boolean,
  err: (msg: string) => void,
): void {
  const L = `${m.type} "${m.id}"`;
  const slotOk = (v: unknown): boolean => isInt(v) && v >= 0 && v <= MAX_SLOT;
  switch (m.type) {
    case 'plate':
      tile(m.tile, L);
      if (m.colorSlot !== undefined && !slotOk(m.colorSlot)) err(`${P} : ${L} colorSlot doit être un entier 0..3`);
      break;
    case 'lever':
      tile(m.tile, L);
      if (m.ownerSlot !== undefined && !slotOk(m.ownerSlot)) err(`${P} : ${L} ownerSlot doit être un entier 0..3`);
      if (m.windowMs !== undefined && (typeof m.windowMs !== 'number' || m.windowMs < 0)) err(`${P} : ${L} windowMs doit être >= 0`);
      break;
    case 'key':
      tile(m.tile, L);
      break;
    case 'door':
      if (!Array.isArray(m.tiles) || m.tiles.length === 0) {
        err(`${P} : ${L} sans tuiles`);
      } else {
        m.tiles.forEach((t, i) => tile(t, `${L} tiles[${i}]`));
      }
      if (!Array.isArray(m.requires)) err(`${P} : ${L} requires doit être un tableau`);
      break;
    case 'block': {
      if (!isTile(m.tile)) {
        tile(m.tile, L);
        break;
      }
      for (const t of squareTiles(m.tile)) {
        if (tileProblem(room, t) !== null) err(`${P} : ${L} (2×2 depuis [${m.tile[0]},${m.tile[1]}]) : la tuile [${t[0]},${t[1]}] n'est pas du sol`);
      }
      if (m.playersRequired !== undefined && (!isInt(m.playersRequired) || m.playersRequired < 1)) {
        err(`${P} : ${L} playersRequired doit être un entier >= 1`);
      }
      break;
    }
    case 'socket': {
      if (isTile(m.tile)) {
        for (const t of squareTiles(m.tile)) {
          if (tileProblem(room, t) !== null) err(`${P} : ${L} (2×2 depuis [${m.tile[0]},${m.tile[1]}]) : la tuile [${t[0]},${t[1]}] n'est pas du sol`);
        }
      } else {
        tile(m.tile, L);
      }
      const blocks = room.mechanisms.filter((b) => b.type === 'block');
      if (m.blockId !== undefined) {
        if (!blocks.some((b) => b.id === m.blockId)) err(`${P} : ${L} blockId "${m.blockId}" n'est pas un bloc de la salle`);
      } else if (blocks.length === 0) {
        err(`${P} : ${L} : aucun bloc compatible dans la salle`);
      }
      break;
    }
    case 'brazier':
      tile(m.tile, L);
      if (m.ownerSlot !== undefined && !slotOk(m.ownerSlot)) err(`${P} : ${L} ownerSlot doit être un entier 0..3`);
      if (m.lightRadiusTiles !== undefined && (typeof m.lightRadiusTiles !== 'number' || !(m.lightRadiusTiles > 0))) {
        err(`${P} : ${L} lightRadiusTiles doit être un nombre > 0`);
      }
      break;
    case 'runePuzzle': {
      tile(m.displayTile, `${L} displayTile`);
      if (!slotOk(m.visibleToSlot)) err(`${P} : ${L} visibleToSlot doit être un entier 0..3`);
      if (!Array.isArray(m.pedestals) || m.pedestals.length === 0) err(`${P} : ${L} sans piédestaux`);
      const symbols = new Set<string>();
      (m.pedestals ?? []).forEach((p, i) => {
        tile(p.tile, `${L} piédestal[${i}]`);
        if (symbols.has(p.symbol)) err(`${P} : ${L} symbole de piédestal dupliqué "${p.symbol}"`);
        symbols.add(p.symbol);
      });
      if (!Array.isArray(m.sequence) || m.sequence.length === 0) err(`${P} : ${L} séquence vide`);
      for (const s of m.sequence ?? []) {
        if (!symbols.has(s)) err(`${P} : ${L} le symbole "${s}" de la séquence n'a pas de piédestal`);
      }
      break;
    }
    default:
      err(`${P} : mécanisme "${(m as { id?: string }).id}" de type inconnu "${(m as { type?: string }).type}"`);
  }
}

function validateObjectivesStatic(level: LevelDef, err: (m: string) => void): void {
  const objectives = level.objectives ?? [];
  const slots = new Set<number>();
  for (const o of objectives) {
    const L = `objectif "${o.id}"`;
    if (!isInt(o.slot) || o.slot < 0 || o.slot > MAX_SLOT) err(`${L} : slot doit être un entier 0..3`);
    else slots.add(o.slot);
    if (!hasText(o.labelKey)) err(`${L} : labelKey vide`);
    const room = level.rooms.find((r) => r.id === o.roomId);
    if (!room) {
      err(`${L} : salle inexistante "${o.roomId}"`);
      continue;
    }
    switch (o.kind) {
      case 'mechanism':
        if (!o.mechanismId || !room.mechanisms.some((m) => m.id === o.mechanismId)) {
          err(`${L} : mécanisme inexistant "${o.mechanismId}" dans la salle "${o.roomId}"`);
        }
        break;
      case 'zone':
        if (!o.zoneId || !(room.zones ?? []).some((z) => z.id === o.zoneId)) {
          err(`${L} : zone inexistante "${o.zoneId}" dans la salle "${o.roomId}"`);
        }
        if (typeof o.seconds !== 'number' || !(o.seconds > 0)) err(`${L} : seconds doit être > 0`);
        break;
      case 'kills':
        if (!isInt(o.count) || o.count < 1) err(`${L} : count doit être un entier >= 1`);
        if (o.enemyKind !== undefined && !room.enemies.some((e) => e.kind === o.enemyKind)) {
          err(`${L} : aucun ennemi "${o.enemyKind}" dans la salle "${o.roomId}"`);
        }
        break;
      default:
        err(`${L} : kind inconnu "${(o as { kind?: string }).kind}"`);
    }
  }
  for (let s = 0; s <= MAX_SLOT; s++) {
    if (!slots.has(s)) err(`niveau "${level.id}" : aucun objectif pour le slot ${s}`);
  }
}

// ───────────────────────────── Atteignabilité ─────────────────────────────

function validateReachability(level: LevelDef, usable: Set<string>, err: (m: string) => void): void {
  // erreurs dédupliquées : texte → liste des n concernés
  const collected = new Map<string, number[]>();
  const order: string[] = [];
  const add = (text: string, n: number): void => {
    let arr = collected.get(text);
    if (!arr) {
      arr = [];
      collected.set(text, arr);
      order.push(text);
    }
    arr.push(n);
  };

  const roomById = new Map(level.rooms.map((r) => [r.id, r] as const));

  for (let n = 1; n <= 4; n++) {
    const reachCache = new Map<string, Set<number>>();
    const memo = new Map<string, boolean>();
    const visiting = new Set<string>();

    const reachOf = (room: RoomDef): Set<number> => {
      let s = reachCache.get(room.id);
      if (!s) {
        s = bfs(room, (room.playerSpawns ?? []).slice(0, n));
        reachCache.set(room.id, s);
      }
      return s;
    };
    const inSet = (room: RoomDef, t: TileXY): boolean => isTile(t) && reachOf(room).has(tileKey(room, t[0], t[1]));
    const touch = (room: RoomDef, t: TileXY): boolean =>
      inSet(room, t) ||
      (isTile(t) && ([[1, 0], [-1, 0], [0, 1], [0, -1]] as const).some(([dx, dy]) => inSet(room, [t[0] + dx, t[1] + dy])));
    const enemiesAt = (room: RoomDef) => (room.enemies ?? []).filter((e) => (e.minPlayers ?? 1) <= n);
    const rectReachable = (room: RoomDef, r: TileRect): boolean =>
      rectInBounds(room, r) && rectTiles(r).some((t) => inSet(room, t));

    const withGuard = (key: string, compute: () => boolean): boolean => {
      const cached = memo.get(key);
      if (cached !== undefined) return cached;
      if (visiting.has(key)) return false; // dépendance circulaire
      visiting.add(key);
      const v = compute();
      visiting.delete(key);
      memo.set(key, v);
      return v;
    };

    const objectiveSat = (o: ObjectiveDef): boolean =>
      withGuard(`obj:${o.id}`, () => {
        const room = roomById.get(o.roomId);
        if (!room || !usable.has(room.id)) return false;
        switch (o.kind) {
          case 'mechanism':
            return !!o.mechanismId && tokenSat(room, o.mechanismId);
          case 'zone': {
            const z = (room.zones ?? []).find((zz) => zz.id === o.zoneId);
            return !!z && rectReachable(room, z.rect);
          }
          case 'kills': {
            const avail = enemiesAt(room).filter((e) => o.enemyKind === undefined || e.kind === o.enemyKind).length;
            return avail >= (o.count ?? 1);
          }
          default:
            return false;
        }
      });

    const mechSat = (room: RoomDef, m: MechanismDef): boolean => {
      if ((m.minPlayers ?? 1) > n) return true; // waived
      return withGuard(`${room.id}|${m.id}`, () => {
        switch (m.type) {
          case 'plate':
          case 'key':
            if (!inSet(room, m.tile)) return false;
            if (m.type === 'key') {
              const door = room.mechanisms.find((d) => d.id === m.doorId);
              return !!door && mechSat(room, door);
            }
            return true;
          case 'lever':
            return touch(room, m.tile);
          case 'brazier':
            return touch(room, m.tile); // solide : on l'atteint depuis une tuile voisine
          case 'door': {
            if (!(m.tiles ?? []).some((t) => inSet(room, t))) return false;
            if (!(m.requires ?? []).every((r) => tokenSat(room, r))) return false;
            if (m.keyId !== undefined) {
              const key = room.mechanisms.find((k) => k.id === m.keyId);
              if (!key || key.type !== 'key') return false;
              if ((key.minPlayers ?? 1) > n) return true; // clé waived : plus nécessaire
              return inSet(room, key.tile);
            }
            return true;
          }
          case 'block':
            return squareTiles(m.tile).every((t) => inSet(room, t));
          case 'socket': {
            if (!squareTiles(m.tile).every((t) => inSet(room, t))) return false;
            const blocks = room.mechanisms.filter((b) => b.type === 'block' && (m.blockId === undefined || b.id === m.blockId));
            return blocks.length > 0 && blocks.every((b) => b.type !== 'block' || squareTiles(b.tile).every((t) => inSet(room, t)));
          }
          case 'runePuzzle': {
            const used = new Set(m.sequence);
            return m.pedestals.filter((p) => used.has(p.symbol)).every((p) => touch(room, p.tile)) && m.sequence.every((s) => m.pedestals.some((p) => p.symbol === s));
          }
          default:
            return false;
        }
      });
    };

    const tokenSat = (room: RoomDef, token: string): boolean => {
      if (token === 'clear') return true;
      if (token.startsWith('enter:')) {
        const z = (room.zones ?? []).find((zz) => zz.id === token.slice(6));
        return !!z && rectReachable(room, z.rect);
      }
      if (token.startsWith('obj:') || token.startsWith('zone:')) {
        const id = token.startsWith('obj:') ? token.slice(4) : token.slice(5);
        const o = (level.objectives ?? []).find((x) => x.id === id);
        if (!o) return false;
        if (token.startsWith('zone:') && o.kind !== 'zone') return false;
        return objectiveSat(o);
      }
      const m = room.mechanisms.find((x) => x.id === token);
      return !!m && mechSat(room, m);
    };

    for (const room of level.rooms) {
      if (!usable.has(room.id)) continue;
      const P = `salle "${room.id}"`;
      if (reachOf(room).size === 0) {
        add(`${P} : aucun spawn praticable`, n);
        continue;
      }
      // spawns : tous accessibles entre eux (depuis le premier spawn)
      if (n === 4) {
        const all = bfs(room, [room.playerSpawns[0]]);
        room.playerSpawns.forEach((s, i) => {
          if (isTile(s) && isFloor(room, s[0], s[1]) && !all.has(tileKey(room, s[0], s[1]))) {
            add(`${P} : playerSpawns[${i}] n'est pas relié au premier spawn`, n);
          }
        });
      }
      for (const m of room.mechanisms) {
        if ((m.minPlayers ?? 1) > n) continue;
        if (!mechSat(room, m)) {
          const why =
            m.type === 'door'
              ? 'exigences non satisfiables, dépendance circulaire ou tuiles/clé inatteignables'
              : m.type === 'socket'
                ? 'inatteignable ou sans bloc compatible atteignable'
                : 'inatteignable depuis les spawns';
          add(`${P} : ${m.type} "${m.id}" ${why}`, n);
        }
      }
      if (room.dark === true) {
        const refill = room.mechanisms.some(
          (m) => m.type === 'brazier' && (m.lit === true || (m.minPlayers ?? 1) > n) && touch(room, m.tile),
        );
        if (!refill) add(`${P} : salle sombre : aucun brasero allumé accessible depuis les spawns (point de recharge)`, n);
      }
      for (const e of enemiesAt(room)) {
        if (!inSet(room, e.tile)) add(`${P} : ennemi ${e.kind} en [${e.tile}] inatteignable`, n);
        if (e.when !== undefined && !tokenSat(room, e.when)) add(`${P} : ennemi ${e.kind} en [${e.tile}] : apparition conditionnée par "${e.when}" non satisfiable`, n);
      }
      if (room.exit?.rect && rectInBounds(room, room.exit.rect) && !rectReachable(room, room.exit.rect)) {
        add(`${P} : zone de sortie inatteignable`, n);
      }
      for (const r of room.exit?.requires ?? []) {
        if (!tokenSat(room, r)) add(`${P} : exit.requires "${r}" non satisfiable`, n);
      }
    }
    for (const o of level.objectives ?? []) {
      if (!roomById.has(o.roomId)) continue; // déjà signalé
      if (!objectiveSat(o)) add(`objectif "${o.id}" non accomplissable`, n);
    }
  }

  for (const text of order) {
    const ns = collected.get(text) ?? [];
    err(`${text} (n=${ns.join(',')})`);
  }
}

// ───────────────────────────── Fabriques de test ─────────────────────────────

/**
 * Génère une grille rectangulaire (murs sur le bord, sol à l'intérieur). Utilitaire de test.
 * @param width Colonnes (défaut 12). @param height Lignes (défaut 8).
 */
export function makeTestLayout(width = 12, height = 8): string[] {
  const rows: string[] = [];
  for (let y = 0; y < height; y++) {
    if (y === 0 || y === height - 1) rows.push('#'.repeat(width));
    else rows.push(`#${'.'.repeat(Math.max(0, width - 2))}#`);
  }
  return rows;
}

/**
 * Crée une salle minimale VALIDE (12×8, 4 spawns, une plaque `p1` en [6,4], sortie en [9,5] 2×2 exigeant `p1`).
 * Tout champ de `overrides` remplace la valeur par défaut (ex. `{ id: 'r2', mechanisms: [...] }`).
 * Les clés i18n par défaut sont `room.test.<id>.name`.
 */
export function makeTestRoom(overrides: Partial<RoomDef> = {}): RoomDef {
  const id = overrides.id ?? 'r1';
  return {
    id,
    nameKey: `room.test.${id}.name`,
    theme: 'crypt',
    layout: makeTestLayout(),
    playerSpawns: [
      [2, 2],
      [3, 2],
      [2, 3],
      [3, 3],
    ],
    enemies: [],
    mechanisms: [{ id: 'p1', type: 'plate', tile: [6, 4] }],
    exit: { rect: { x: 9, y: 5, w: 2, h: 2 }, requires: ['p1'] },
    ...overrides,
  };
}

/**
 * Crée un niveau minimal VALIDE : `roomCount` salles `r1..rK` (défaut 1, la dernière est finale), chacune avec
 * une plaque `p1`, et 4 objectifs `o0..o3` (un par slot) de type 'mechanism' sur la plaque `p1` de la première salle.
 * Les champs de `overrides` remplacent les défauts (ex. `{ rooms: [...] , objectives: [...] }`).
 * Clés i18n par défaut : `level.test.name`, `level.test.intro.1`, `level.test.outro.1`, `objective.test.o<slot>`,
 * `room.test.<roomId>.name` ; voir `makeTestDictionary`.
 */
export function makeTestLevel(overrides: Partial<LevelDef> & { roomCount?: number } = {}): LevelDef {
  const { roomCount = 1, ...rest } = overrides;
  const count = Math.max(1, roomCount);
  const defaultRooms: RoomDef[] = [];
  for (let i = 1; i <= count; i++) {
    const room = makeTestRoom({ id: `r${i}` });
    if (i === count) room.exit.final = true;
    defaultRooms.push(room);
  }
  const rooms = rest.rooms ?? defaultRooms;
  const objectives: ObjectiveDef[] = [0, 1, 2, 3].map((slot) => ({
    id: `o${slot}`,
    slot,
    roomId: rooms[0]?.id ?? 'r1',
    kind: 'mechanism',
    labelKey: `objective.test.o${slot}`,
    mechanismId: 'p1',
  }));
  return {
    id: 'test',
    nameKey: 'level.test.name',
    theme: 'crypt',
    estimatedMinutes: 1,
    intro: [{ speaker: 'aldric', textKey: 'level.test.intro.1' }],
    outro: [{ speaker: 'aldric', textKey: 'level.test.outro.1' }],
    rooms,
    objectives,
    ...rest,
  };
}

/**
 * Construit un dictionnaire plat (clé → clé) contenant toutes les clés i18n requises par `level`
 * (utile pour tester `validateLevel(level, { dictionaries: { fr: makeTestDictionary(level) } })`).
 */
export function makeTestDictionary(level: LevelDef, opts: { checkSpeakers?: boolean } = {}): Record<string, string> {
  const dict: Record<string, string> = {};
  for (const ref of collectRequiredI18nKeys(level, opts)) dict[ref.key] = ref.key;
  return dict;
}
