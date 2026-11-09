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
 *  Mécanismes inédits (niveaux 4-6) :
 *   - `statuePair` : 2 statues dont les tuiles ET les `standTile` sont du sol, toutes 4 distinctes ; `facing`/`targetDir` valides ;
 *     pas déjà résolue au départ ; une statue est SOLIDE (la BFS ne la traverse pas ; aucun spawn/ennemi/plaque/levier/clé/
 *     piédestal/socle dessus) ; les deux `standTile` doivent être atteignables ;
 *   - `hourglass` : ≥ 2 leviers (tuiles de sol distinctes), ≥ 1 tuile de herse (sol, distinctes, jamais un levier), `displayTile`
 *     de sol, `periodMs` > 0, `closeStepMs` > 0 si présent ; la herse est FERMÉE au départ (aucun spawn/ennemi/levier dessus) ; les
 *     leviers doivent être atteignables (la herse est comptée franchissable) ; une PORTE ne peut pas exiger un sablier dans son
 *     `requires` (une porte reste ouverte pour toujours : le sablier perdrait son sens) — utiliser `exit.requires` ou `when` ;
 *   - `lightBridge` : ≥ 1 tuile de sol distinctes, `lanternSlot` entier 0..3, `radiusTiles` > 0 ; le pont est ÉTEINT au départ
 *     (aucun spawn/ennemi/levier dessus) et toutes ses tuiles doivent être atteignables (comptées franchissables).
 *   Les jetons d'exigence '<id>' vers ces mécanismes se valident comme les autres (id existant dans la salle).
 *  Cristaux de soin (`RoomDef.healCrystals`, salles de boss / demi-boss) : ids uniques par salle, `minPlayers` entier 1..4, tuile de SOL (pas mur,
 *   fosse, pilier), distincte d'un spawn joueur, d'un ennemi, d'une porte, d'un bloc, d'un brasero, d'une statue, d'une herse et d'un pont de lumière ;
 *   « pas trivial » : à >= `HEAL_CRYSTAL_MIN_SPAWN_TILES` tuiles de tout point d'arrivée des joueurs ; « hors zones de danger de départ » : à >=
 *   `HEAL_CRYSTAL_MIN_BOSS_TILES` tuiles de tout boss / demi-boss ; ACCESSIBLE depuis les spawns à chaque nombre de joueurs n >= minPlayers.
 *  i18n : si `opts.dictionaries` est fourni, toutes les clés requises (voir `collectRequiredI18nKeys`) doivent exister
 *  et être non vides dans CHAQUE dictionnaire.
 *
 * ── Règle « mécanisme coopératif » ──
 *  Chaque salle doit contenir au moins un mécanisme de type plate/lever/key/block/runePuzzle/brazier/statuePair/hourglass/
 *  lightBridge avec `(minPlayers ?? 1) <= 1` (donc présent même à 1 joueur), SAUF salle de boss pure : aucune entrée
 *  `mechanisms` et au moins un ennemi boss (`isBoss` : golem, morvane, frostqueen, forgelord, voidlord) OU demi-boss (`isMiniBoss` : warden, pyromancer,
 *  wraith) — arène de combat pur ; helpers `isAnyBossKind` de `enemies.ts`. Les demi-boss restent soumis à `validateBossStructure`.
 *
 * ── Structure boss (niveaux 4-6) : `validateBossStructure(level, { minMiniBosses })` ──
 *  Fonction séparée de `validateLevel` : le niveau contient au moins `minMiniBosses` demi-boss (`EnemyDef.isMiniBoss`) présents à
 *  CHAQUE nombre de joueurs (spawn avec `(minPlayers ?? 1) <= 1`) ; la sortie de chaque salle contenant un demi-boss exige 'clear'
 *  (directement, ou via une porte dont les `requires` en dépendent) OU est inaccessible tant qu'une porte dépendant de 'clear'
 *  est fermée ; la salle finale contient un boss (`isBoss`), présent à chaque nombre de joueurs.
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

import { HEAL_CRYSTAL_MIN_BOSS_TILES, HEAL_CRYSTAL_MIN_SPAWN_TILES } from './balance';
import { LIGHT_FULL_TILES } from './constants';
import { isAnyBossKind, isBossKind, isMiniBossKind } from './enemies';
import type {
  DecorDef,
  Dir,
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
const COOP_TYPES = new Set(['plate', 'lever', 'key', 'block', 'runePuzzle', 'brazier', 'statuePair', 'hourglass', 'lightBridge']);
const DIRS = new Set<Dir>(['up', 'down', 'left', 'right']);
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

/** Tuiles occupées par un brasero ou une statue jumelle (solides : non traversables) — clés `tileKey`. */
function brazierBlocked(room: RoomDef): Set<number> {
  const out = new Set<number>();
  for (const m of room.mechanisms ?? []) {
    if (m.type === 'brazier' && isTile(m.tile)) out.add(tileKey(room, m.tile[0], m.tile[1]));
    if (m.type === 'statuePair' && Array.isArray(m.statues)) {
      for (const s of m.statues) if (s && isTile(s.tile)) out.add(tileKey(room, s.tile[0], s.tile[1]));
    }
  }
  return out;
}

function bfs(room: RoomDef, sources: readonly TileXY[], extraBlocked?: ReadonlySet<number>): Set<number> {
  const seen = new Set<number>();
  const queue: TileXY[] = [];
  const blocked = brazierBlocked(room);
  if (extraBlocked) for (const k of extraBlocked) blocked.add(k);
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
  /** Tuiles solides des statues jumelles / herses de sablier (fermées au départ) / ponts de lumière (éteints au départ). */
  const statueTiles = new Map<string, string>();
  const gateTiles = new Map<string, string>();
  const bridgeTiles = new Map<string, string>();
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
    if (m.type === 'statuePair' && Array.isArray(m.statues)) {
      for (const s of m.statues) if (s && isTile(s.tile)) statueTiles.set(tk(s.tile), m.id);
    }
    if (m.type === 'hourglass' && Array.isArray(m.gate)) {
      for (const t of m.gate) if (isTile(t)) gateTiles.set(tk(t), m.id);
    }
    if (m.type === 'lightBridge' && Array.isArray(m.tiles)) {
      for (const t of m.tiles) if (isTile(t)) bridgeTiles.set(tk(t), m.id);
    }
  }

  // exigences
  for (const m of room.mechanisms ?? []) {
    if (m.type !== 'door') continue;
    for (const r of m.requires ?? []) {
      const pb = requirementProblem(r, room, level, m.id);
      if (pb) err(`${P} : porte "${m.id}" requires "${r}" : ${pb}`);
      else if (room.mechanisms.some((o) => o.id === r && o.type === 'hourglass')) {
        err(`${P} : porte "${m.id}" requires "${r}" : un sablier ne peut pas ouvrir une porte (elle reste ouverte pour toujours) — utiliser exit.requires ou when`);
      }
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
    overlapCheck(s, `playerSpawns[${i}]`, statueTiles, 'la statue');
    overlapCheck(s, `playerSpawns[${i}]`, gateTiles, 'la herse');
    overlapCheck(s, `playerSpawns[${i}]`, bridgeTiles, 'le pont de lumière');
  });
  (room.enemies ?? []).forEach((e, i) => {
    overlapCheck(e.tile, `ennemi[${i}] (${e.kind})`, doorTiles, 'la porte');
    overlapCheck(e.tile, `ennemi[${i}] (${e.kind})`, blockTiles, 'le bloc');
    overlapCheck(e.tile, `ennemi[${i}] (${e.kind})`, brazierTiles, 'le brasero');
    overlapCheck(e.tile, `ennemi[${i}] (${e.kind})`, statueTiles, 'la statue');
    overlapCheck(e.tile, `ennemi[${i}] (${e.kind})`, gateTiles, 'la herse');
    overlapCheck(e.tile, `ennemi[${i}] (${e.kind})`, bridgeTiles, 'le pont de lumière');
  });
  for (const m of room.mechanisms ?? []) {
    if (m.type === 'plate') {
      overlapCheck(m.tile, `plaque "${m.id}"`, doorTiles, 'la porte');
      overlapCheck(m.tile, `plaque "${m.id}"`, statueTiles, 'la statue');
    }
    if (m.type === 'statuePair' && Array.isArray(m.statues)) {
      // les socles (standTile) ne peuvent être ni une statue (de ce mécanisme ou d'un autre), ni une herse, ni une porte, ni un bloc
      m.statues.forEach((s, i) => {
        if (!s) return;
        overlapCheck(s.standTile, `socle ${i} de "${m.id}"`, statueTiles, 'la statue');
        overlapCheck(s.standTile, `socle ${i} de "${m.id}"`, doorTiles, 'la porte');
        overlapCheck(s.standTile, `socle ${i} de "${m.id}"`, blockTiles, 'le bloc');
        overlapCheck(s.standTile, `socle ${i} de "${m.id}"`, brazierTiles, 'le brasero');
        overlapCheck(s.standTile, `socle ${i} de "${m.id}"`, gateTiles, 'la herse');
        overlapCheck(s.tile, `statue ${i} de "${m.id}"`, doorTiles, 'la porte');
        overlapCheck(s.tile, `statue ${i} de "${m.id}"`, blockTiles, 'le bloc');
        overlapCheck(s.tile, `statue ${i} de "${m.id}"`, brazierTiles, 'le brasero');
        overlapCheck(s.tile, `statue ${i} de "${m.id}"`, gateTiles, 'la herse');
      });
    }
    if (m.type === 'hourglass' && Array.isArray(m.levers)) {
      m.levers.forEach((t, i) => {
        overlapCheck(t, `levier ${i} du sablier "${m.id}"`, doorTiles, 'la porte');
        overlapCheck(t, `levier ${i} du sablier "${m.id}"`, blockTiles, 'le bloc');
        overlapCheck(t, `levier ${i} du sablier "${m.id}"`, statueTiles, 'la statue');
        overlapCheck(t, `levier ${i} du sablier "${m.id}"`, brazierTiles, 'le brasero');
        overlapCheck(t, `levier ${i} du sablier "${m.id}"`, bridgeTiles, 'le pont de lumière');
      });
    }
    if (m.type === 'brazier') {
      overlapCheck(m.tile, `brasero "${m.id}"`, doorTiles, 'la porte');
      overlapCheck(m.tile, `brasero "${m.id}"`, blockTiles, 'le bloc');
    }
    if (m.type === 'lever' || m.type === 'key') {
      overlapCheck(m.tile, `${m.type === 'lever' ? 'levier' : 'clé'} "${m.id}"`, doorTiles, 'la porte');
      overlapCheck(m.tile, `${m.type === 'lever' ? 'levier' : 'clé'} "${m.id}"`, blockTiles, 'le bloc');
      overlapCheck(m.tile, `${m.type === 'lever' ? 'levier' : 'clé'} "${m.id}"`, statueTiles, 'la statue');
      overlapCheck(m.tile, `${m.type === 'lever' ? 'levier' : 'clé'} "${m.id}"`, gateTiles, 'la herse');
    }
    if (m.type === 'runePuzzle') {
      (m.pedestals ?? []).forEach((p, i) => {
        overlapCheck(p.tile, `piédestal ${i} de "${m.id}"`, doorTiles, 'la porte');
        overlapCheck(p.tile, `piédestal ${i} de "${m.id}"`, blockTiles, 'le bloc');
        overlapCheck(p.tile, `piédestal ${i} de "${m.id}"`, statueTiles, 'la statue');
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

  // cristaux de soin (sources de vie fixes)
  const crystalIds = new Set<string>();
  (room.healCrystals ?? []).forEach((c, i) => {
    const L = `cristal de soin[${i}] "${c?.id}"`;
    if (!hasText(c?.id)) err(`${P} : ${L} sans id`);
    if (crystalIds.has(c.id)) err(`${P} : id de cristal de soin dupliqué "${c.id}"`);
    crystalIds.add(c.id);
    if (c.minPlayers !== undefined && (!isInt(c.minPlayers) || c.minPlayers < 1 || c.minPlayers > 4)) {
      err(`${P} : ${L} minPlayers doit être un entier 1..4`);
    }
    if (!tile(c.tile, L)) return;
    overlapCheck(c.tile, L, doorTiles, 'la porte');
    overlapCheck(c.tile, L, blockTiles, 'le bloc');
    overlapCheck(c.tile, L, brazierTiles, 'le brasero');
    overlapCheck(c.tile, L, statueTiles, 'la statue');
    overlapCheck(c.tile, L, gateTiles, 'la herse');
    overlapCheck(c.tile, L, bridgeTiles, 'le pont de lumière');
    // autres éléments de salle : plaque, levier, clé, socle (2×2), énigme de runes, sablier, panneau, rectangle de sortie
    for (const m of room.mechanisms ?? []) {
      const hit = (t: unknown, what: string): void => {
        if (isTile(t) && t[0] === c.tile[0] && t[1] === c.tile[1]) err(`${P} : ${L} recouvre ${what} "${m.id}"`);
      };
      if (m.type === 'plate') hit(m.tile, 'la plaque');
      else if (m.type === 'lever') hit(m.tile, 'le levier');
      else if (m.type === 'key') hit(m.tile, 'la clé');
      else if (m.type === 'socket' && isTile(m.tile) && c.tile[0] >= m.tile[0] && c.tile[0] <= m.tile[0] + 1 && c.tile[1] >= m.tile[1] && c.tile[1] <= m.tile[1] + 1) {
        err(`${P} : ${L} recouvre le socle "${m.id}"`);
      } else if (m.type === 'runePuzzle') {
        hit(m.displayTile, "l'affichage de l'énigme");
        (m.pedestals ?? []).forEach((pd) => hit(pd?.tile, "le piédestal de l'énigme"));
      } else if (m.type === 'hourglass') (m.levers ?? []).forEach((lt) => hit(lt, 'un levier du sablier'));
    }
    for (const sg of room.signs ?? []) {
      if (isTile(sg.tile) && sg.tile[0] === c.tile[0] && sg.tile[1] === c.tile[1]) err(`${P} : ${L} recouvre le panneau "${sg.id}"`);
    }
    if (room.exit?.rect && rectInBounds(room, room.exit.rect) && rectTiles(room.exit.rect).some((t) => t[0] === c.tile[0] && t[1] === c.tile[1])) {
      err(`${P} : ${L} est dans le rectangle de sortie`);
    }
    (room.enemies ?? []).forEach((e, k) => {
      if (isTile(e.tile) && e.tile[0] === c.tile[0] && e.tile[1] === c.tile[1]) err(`${P} : ${L} recouvre l'apparition de l'ennemi[${k}] (${e.kind})`);
      else if (isAnyBossKind(e.kind) && isTile(e.tile) && Math.hypot(e.tile[0] - c.tile[0], e.tile[1] - c.tile[1]) < HEAL_CRYSTAL_MIN_BOSS_TILES) {
        err(`${P} : ${L} à moins de ${HEAL_CRYSTAL_MIN_BOSS_TILES} tuiles du départ de ${e.kind} (zone de danger)`);
      }
    });
    (room.playerSpawns ?? []).forEach((sp, k) => {
      if (!isTile(sp)) return;
      if (sp[0] === c.tile[0] && sp[1] === c.tile[1]) err(`${P} : ${L} recouvre playerSpawns[${k}]`);
      else if (Math.hypot(sp[0] - c.tile[0], sp[1] - c.tile[1]) < HEAL_CRYSTAL_MIN_SPAWN_TILES) {
        err(`${P} : ${L} à moins de ${HEAL_CRYSTAL_MIN_SPAWN_TILES} tuiles de playerSpawns[${k}] (trop facile à atteindre)`);
      }
    });
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
  const pureBoss = (room.mechanisms ?? []).length === 0 && (room.enemies ?? []).some((e) => isAnyBossKind(e.kind));
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
    case 'statuePair': {
      if (!DIRS.has(m.targetDir)) err(`${P} : ${L} targetDir invalide "${String(m.targetDir)}"`);
      if (!Array.isArray(m.statues) || m.statues.length !== 2) {
        err(`${P} : ${L} doit avoir exactement 2 statues`);
        break;
      }
      const used = new Map<string, string>();
      m.statues.forEach((s, i) => {
        if (!s) {
          err(`${P} : ${L} statue ${i} absente`);
          return;
        }
        tile(s.tile, `${L} statues[${i}].tile`);
        tile(s.standTile, `${L} statues[${i}].standTile`);
        if (!DIRS.has(s.facing)) err(`${P} : ${L} statues[${i}].facing invalide "${String(s.facing)}"`);
        for (const [key, what] of [
          [s.tile, `statues[${i}].tile`],
          [s.standTile, `statues[${i}].standTile`],
        ] as const) {
          if (!isTile(key)) continue;
          const k = `${key[0]},${key[1]}`;
          const other = used.get(k);
          if (other !== undefined) err(`${P} : ${L} ${what} [${k}] est confondue avec ${other} (les 4 tuiles doivent être distinctes)`);
          else used.set(k, what);
        }
      });
      if (m.statues.every((s) => s && s.facing === m.targetDir)) {
        err(`${P} : ${L} est déjà résolue au départ (les deux statues regardent déjà targetDir "${m.targetDir}")`);
      }
      break;
    }
    case 'hourglass': {
      if (typeof m.periodMs !== 'number' || !(m.periodMs > 0)) err(`${P} : ${L} periodMs doit être un nombre > 0`);
      if (m.closeStepMs !== undefined && (typeof m.closeStepMs !== 'number' || !(m.closeStepMs > 0))) {
        err(`${P} : ${L} closeStepMs doit être un nombre > 0`);
      }
      tile(m.displayTile, `${L} displayTile`);
      const seen = new Map<string, string>();
      const distinct = (list: unknown, name: string, min: number): void => {
        if (!Array.isArray(list) || list.length < min) {
          err(`${P} : ${L} ${name} doit contenir au moins ${min} tuile(s)`);
          return;
        }
        list.forEach((t, i) => {
          tile(t, `${L} ${name}[${i}]`);
          if (!isTile(t)) return;
          const k = `${t[0]},${t[1]}`;
          const prev = seen.get(k);
          if (prev !== undefined) err(`${P} : ${L} ${name}[${i}] [${k}] est confondue avec ${prev}`);
          else seen.set(k, `${name}[${i}]`);
        });
      };
      distinct(m.levers, 'levers', 2);
      distinct(m.gate, 'gate', 1);
      break;
    }
    case 'lightBridge': {
      if (!slotOk(m.lanternSlot)) err(`${P} : ${L} lanternSlot doit être un entier 0..3`);
      if (typeof m.radiusTiles !== 'number' || !(m.radiusTiles > 0)) err(`${P} : ${L} radiusTiles doit être un nombre > 0`);
      if (!Array.isArray(m.tiles) || m.tiles.length === 0) {
        err(`${P} : ${L} tiles doit contenir au moins 1 tuile`);
        break;
      }
      const seen = new Set<string>();
      m.tiles.forEach((t, i) => {
        tile(t, `${L} tiles[${i}]`);
        if (!isTile(t)) return;
        const k = `${t[0]},${t[1]}`;
        if (seen.has(k)) err(`${P} : ${L} tiles[${i}] [${k}] dupliquée`);
        seen.add(k);
      });
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
          case 'statuePair':
            // statues solides : on agit depuis les socles, qui doivent être atteignables (un joueur par socle, ou allers-retours en solo)
            return (m.statues ?? []).length === 2 && m.statues.every((s) => inSet(room, s.standTile));
          case 'hourglass':
            // la herse est comptée franchissable ; chaque levier s'actionne depuis sa tuile ou une voisine
            return (m.levers ?? []).length >= 2 && m.levers.every((t) => touch(room, t));
          case 'lightBridge':
            // tuiles de sol comptées franchissables (éclairées) : toutes doivent être atteignables
            return (m.tiles ?? []).length > 0 && m.tiles.every((t) => inSet(room, t));
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
      for (const c of room.healCrystals ?? []) {
        if ((c.minPlayers ?? 1) > n || !isTile(c.tile)) continue;
        if (!inSet(room, c.tile)) add(`${P} : cristal de soin "${c.id}" en [${c.tile}] inatteignable depuis les spawns`, n);
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

// ───────────────────────────── Structure boss / demi-boss ─────────────────────────────

/** Options de `validateBossStructure`. */
export interface BossStructureOptions {
  /** Nombre minimal de demi-boss (`EnemyDef.isMiniBoss`) que le niveau doit contenir à chaque nombre de joueurs (0 = aucun exigé). */
  minMiniBosses: number;
}

/**
 * Valide la structure « demi-boss / boss » d'un niveau des paliers 4-6 (même convention que `validateLevel` : liste d'erreurs
 * lisibles en français, vide = conforme). Règles :
 *  - au moins `opts.minMiniBosses` demi-boss (`EnemyDef.isMiniBoss`, via `ENEMIES`) PRÉSENTS à chaque nombre de joueurs 1..4
 *    (une apparition avec `minPlayers > n` ne compte pas pour n) ;
 *  - la sortie de CHAQUE salle contenant une apparition de demi-boss exige la mort du demi-boss : `exit.requires` contient 'clear',
 *    directement ou par une porte (transitivement via `requires`), OU la zone de sortie est inatteignable depuis les spawns tant
 *    que les portes dépendant de 'clear' restent fermées ;
 *  - la salle finale (dernière) contient une apparition de boss (`EnemyDef.isBoss`) présente à chaque nombre de joueurs.
 * @param level niveau à contrôler
 * @param opts voir `BossStructureOptions`
 */
export function validateBossStructure(level: LevelDef, opts: BossStructureOptions): string[] {
  const errors: string[] = [];
  const rooms = level.rooms ?? [];
  if (!isInt(opts.minMiniBosses) || opts.minMiniBosses < 0) {
    errors.push(`structure boss : minMiniBosses doit être un entier >= 0 (reçu ${String(opts.minMiniBosses)})`);
    return errors;
  }
  if (rooms.length === 0) {
    errors.push(`niveau "${level.id}" : aucune salle (structure boss)`);
    return errors;
  }

  // demi-boss présents à chaque n
  const short: string[] = [];
  for (let n = 1; n <= 4; n++) {
    let count = 0;
    for (const room of rooms) {
      for (const e of room.enemies ?? []) if (isMiniBossKind(e.kind) && (e.minPlayers ?? 1) <= n) count++;
    }
    if (count < opts.minMiniBosses) short.push(`${count} à n=${n}`);
  }
  if (short.length > 0) errors.push(`niveau "${level.id}" : ${opts.minMiniBosses} demi-boss exigé(s) mais trouvé(s) ${short.join(', ')}`);

  // la sortie des salles à demi-boss exige la victoire
  for (const room of rooms) {
    const minis = (room.enemies ?? []).filter((e) => isMiniBossKind(e.kind));
    if (minis.length === 0) continue;
    const P = `salle "${room.id}"`;
    const doorsById = new Map<string, MechanismDef>();
    for (const m of room.mechanisms ?? []) if (m.type === 'door') doorsById.set(m.id, m);
    const dependsOnClear = (tokens: readonly string[], seen: Set<string>): boolean =>
      tokens.some((t) => {
        if (t === 'clear') return true;
        const door = doorsById.get(t);
        if (!door || door.type !== 'door' || seen.has(t)) return false;
        seen.add(t);
        return dependsOnClear(door.requires ?? [], seen);
      });
    if (dependsOnClear(room.exit?.requires ?? [], new Set())) continue;
    // sinon : la sortie doit être coupée du reste de la salle par une porte dépendant de 'clear'
    const clearDoors = [...doorsById.values()].filter((d) => d.type === 'door' && dependsOnClear(d.requires ?? [], new Set()));
    let sealed = false;
    if (clearDoors.length > 0 && room.exit?.rect && rectInBounds(room, room.exit.rect)) {
      const closed = new Set<number>();
      for (const d of clearDoors) {
        if (d.type !== 'door') continue;
        for (const t of d.tiles ?? []) if (isTile(t)) closed.add(tileKey(room, t[0], t[1]));
      }
      const reach = bfs(room, (room.playerSpawns ?? []).slice(0, 4), closed);
      sealed = !rectTiles(room.exit.rect).some((t) => reach.has(tileKey(room, t[0], t[1])));
    }
    if (!sealed) {
      errors.push(
        `${P} : contient un demi-boss (${minis.map((e) => e.kind).join(', ')}) mais sa sortie n'exige pas 'clear' ` +
          `(exit.requires doit inclure 'clear', ou une porte qui en dépend et qui barre l'accès à la sortie)`,
      );
    }
  }

  // salle finale : boss présent à chaque n
  const last = rooms[rooms.length - 1];
  const missing: number[] = [];
  for (let n = 1; n <= 4; n++) {
    if (!(last.enemies ?? []).some((e) => isBossKind(e.kind) && (e.minPlayers ?? 1) <= n)) missing.push(n);
  }
  if (missing.length > 0) errors.push(`salle finale "${last.id}" : aucun boss (isBoss) présent (n=${missing.join(',')})`);
  return errors;
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
