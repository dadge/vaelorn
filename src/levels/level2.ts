/**
 * Niveau 2 — « Le Bosquet Putride » (thème `grove`).
 *
 * Mécaniques introduites : actions SÉPARÉES ET SIMULTANÉES (leviers à fenêtre, clés personnelles + plaques tenues
 * en même temps), énigme de runes à VISION PARTAGÉE, archers (R2/R5), araignées (R3) et premier boss : Gorgrim.
 *
 * ── Taille et sensation d'être perdu ──
 *  Les salles font 60–76 tuiles de large et 38–46 de haut (l'arène du boss 50×40) : la caméra défile, on ne voit
 *  JAMAIS une salle entière. Chaque salle est un grand hall relié par des couloirs de 2–4 tuiles à des ailes,
 *  alcôves et culs-de-sac (décors, groupes d'ennemis). Les éléments d'une même épreuve (leviers, plaques, clés,
 *  piédestaux) sont placés dans des ailes opposées pour que les joueurs se dispersent ; des panneaux indiquent où
 *  aller et la sortie est toujours dans le prolongement de la porte de la salle. Les layouts sont générés par de
 *  petites fonctions déterministes (`carve`, `pillars`, `patches`) : aucune donnée aléatoire à l'exécution.
 *
 * ── Convention « une couleur = un joueur » ──
 *  bleu = slot 0, rouge = slot 1, vert = slot 2, jaune = slot 3 (voir `PLAYER_COLORS`).
 *  Coop adaptative : chaque mécanisme « par joueur » a un `minPlayers` croissant, de sorte que n joueurs voient
 *  exactement n leviers / n clés / n plaques actifs, un par joueur (slot % n), et que les autres sont « waived ».
 *    - leviers et plaques à couleur fixe : bleu (min 1), rouge (min 2), vert (min 3), jaune (min 4) ;
 *    - clés/portes/plaques de la Serre (salle 3) : vert (min 1), rouge (min 2), bleu (min 3), jaune (min 4),
 *      pour que la clé du slot 2 (objectif personnel « porteur de clé ») existe dès 1 joueur.
 *  Le nombre d'ennemis ne dépend que des joueurs (`minPlayers`), jamais de la difficulté : `ENEMY_MIN_PATTERN`
 *  répartit les ennemis de façon que 1 joueur en rencontre ≈ 60 % de ceux de 4 joueurs. Les ennemis sont placés
 *  par groupes (`populate`) à ≥ 14 tuiles des points d'arrivée (arrivée calme) ; quelques vagues (`wave` 1)
 *  surgissent quand les groupes d'une salle ont été vaincus.
 *
 * ── Les 6 salles ──
 *  1. lisiere   : plaques collectives (une par joueur) dans quatre ailes + premiers monstres.
 *  2. clairiere : 4 leviers à fenêtre (12 s) dans 4 clairières lointaines, gardées ; tous actifs en même temps.
 *  3. nid       : clés personnelles (alcôves nord) → portes de cellules (sud) → plaques tenues ensemble.
 *  4. murmures  : runes à vision partagée (un lecteur, les autres actionnent les piédestaux, six salles).
 *  5. mare      : ponts sous le feu des archers ; plaques-pièges (embuscades) qui ouvrent le portail.
 *  6. arene     : boss Gorgrim ; sortie finale scellée (`clear` + 4 objectifs personnels).
 *
 * ── Objectifs personnels (un par slot) ──
 *  slot 0 `sync_levers` (levier bleu, salle 2) · slot 1 `read_runes` (runes, salle 4) ·
 *  slot 2 `bear_key` (clé verte, salle 3) · slot 3 `hold_circle` (zone à tenir 8 s, salle du boss).
 *
 * Données pures (aucun texte en dur) : tout passe par des clés i18n (`src/i18n/parts/level2.*.json`).
 * Les layouts : '#' mur, '.' sol, ',' sol variante, 'o' pilier, '~' fosse.
 */

import type {
  DecorDef,
  DoorDef,
  EnemyKind,
  EnemySpawnDef,
  KeyDef,
  LeverDef,
  LevelDef,
  MechanismDef,
  ObjectiveDef,
  BrazierDef,
  PlateDef,
  RoomDef,
  TileRect,
  TileXY,
} from '../core/types';

// ───────────────────────────── Aides locales : mécanismes ─────────────────────────────

type Color = 'blue' | 'red' | 'green' | 'yellow';

/** Slot (0..3) de chaque couleur. */
const SLOT: Readonly<Record<Color, number>> = { blue: 0, red: 1, green: 2, yellow: 3 };

/** `minPlayers` des mécanismes par couleur dans les salles 1, 2 et 5 : un par joueur, dans l'ordre bleu → jaune. */
const MIN_BY_COLOR: Readonly<Record<Color, number>> = { blue: 1, red: 2, green: 3, yellow: 4 };

/** `minPlayers` des mécanismes de la Serre (salle 3) : la clé verte (slot 2) existe dès 1 joueur. */
const MIN_NEST: Readonly<Record<Color, number>> = { green: 1, red: 2, blue: 3, yellow: 4 };

/**
 * Fenêtre d'un levier (ms). Les quatre leviers sont à ≈ 70 tuiles les uns des autres : chacun attend à son levier,
 * les joueurs se coordonnent à la voix ; 12 s laissent le temps de réagir sans rendre l'épreuve triviale.
 */
const LEVER_WINDOW_MS = 12000;

/** Durée (s) à tenir dans le cercle de lumière (objectif du slot 3). */
const CIRCLE_SECONDS = 8;

function plate(color: Color, tile: TileXY, minPlayers: number): PlateDef {
  return { id: `plate_${color}`, type: 'plate', tile, colorSlot: SLOT[color], minPlayers, labelKey: `mech.level2.plate.${color}` };
}

function lever(color: Color, tile: TileXY): LeverDef {
  return {
    id: `lever_${color}`,
    type: 'lever',
    tile,
    ownerSlot: SLOT[color],
    windowMs: LEVER_WINDOW_MS,
    minPlayers: MIN_BY_COLOR[color],
    labelKey: `mech.level2.lever.${color}`,
  };
}

function key(color: Color, tile: TileXY): KeyDef {
  return {
    id: `key_${color}`,
    type: 'key',
    tile,
    ownerSlot: SLOT[color],
    doorId: `gate_${color}`,
    minPlayers: MIN_NEST[color],
    labelKey: `mech.level2.key.${color}`,
  };
}

/** Porte de cellule (salle 3) ouverte par la clé de la même couleur. */
function gate(color: Color, tiles: TileXY[]): DoorDef {
  return {
    id: `gate_${color}`,
    type: 'door',
    tiles,
    requires: [],
    keyId: `key_${color}`,
    minPlayers: MIN_NEST[color],
    labelKey: `mech.level2.gate.${color}`,
  };
}

/** Brasero de recharge (allumé d'office) : lumière permanente + point de recharge de torche (salle sombre). */
function litBrazier(id: string, tile: TileXY): BrazierDef {
  return { id: `brazier_${id}`, type: 'brazier', tile, lit: true, labelKey: 'mech.level2.brazier' };
}

/** Brasero éteint, tâche annexe : un joueur à torche non vide l'allume (Action) et gagne un refuge de plus. */
function coldBrazier(id: string, tile: TileXY): BrazierDef {
  return { id: `brazier_${id}`, type: 'brazier', tile, labelKey: 'mech.level2.brazierCold' };
}

function enemy(kind: EnemyKind, x: number, y: number, minPlayers?: number, extra: Partial<EnemySpawnDef> = {}): EnemySpawnDef {
  const def: EnemySpawnDef = { kind, tile: [x, y], ...extra };
  if (minPlayers !== undefined && minPlayers > 1) def.minPlayers = minPlayers;
  return def;
}

// ───────────────────────────── Aides locales : génération des layouts ─────────────────────────────

type Grid = string[][];

/** Grille pleine de murs (`w`×`h`). */
function newGrid(w: number, h: number): Grid {
  return Array.from({ length: h }, () => Array.from({ length: w }, () => '#'));
}

/** Remplit le rectangle (x, y, w, h) avec `ch` (sol par défaut). La bordure extérieure reste toujours un mur. */
function carve(g: Grid, x: number, y: number, w: number, h: number, ch = '.'): void {
  if (x < 1 || y < 1 || x + w > g[0].length - 1 || y + h > g.length - 1) {
    throw new Error(`level2 : rectangle hors grille (${x},${y},${w},${h})`);
  }
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) g[j][i] = ch;
}

function isFloorCh(c: string | undefined): boolean {
  return c === '.' || c === ',';
}

/** Pose `ch` sur les seules tuiles de sol '.' du rectangle (taches de sol variante). */
function patches(g: Grid, x: number, y: number, w: number, h: number): void {
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (g[j][i] === '.') g[j][i] = ',';
}

/**
 * Piliers en grille (pas `sx`×`sy`) dans le rectangle, uniquement sur une tuile dont les 8 voisines sont du sol :
 * ils ne bouchent jamais un couloir ni ne touchent un mur.
 */
function pillars(g: Grid, x: number, y: number, w: number, h: number, sx: number, sy: number): void {
  const todo: TileXY[] = [];
  for (let j = y; j < y + h; j += sy) {
    for (let i = x; i < x + w; i += sx) {
      let ok = true;
      for (let dj = -1; dj <= 1 && ok; dj++) for (let di = -1; di <= 1 && ok; di++) ok = isFloorCh(g[j + dj]?.[i + di]);
      if (ok) todo.push([i, j]);
    }
  }
  for (const [i, j] of todo) g[j][i] = 'o';
}

function toRows(g: Grid): string[] {
  return g.map((r) => r.join(''));
}

/** PRNG déterministe (mulberry32) : mêmes niveaux à chaque exécution. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Motif de `minPlayers` appliqué dans l'ordre aux ennemis d'une salle : 12/20 présents dès 1 joueur (60 %),
 * 15/20 à 2, 18/20 à 3, 20/20 à 4. Le nombre d'ennemis suit les JOUEURS, jamais la difficulté.
 */
const ENEMY_MIN_PATTERN: readonly number[] = [1, 1, 2, 1, 3, 1, 1, 4, 1, 2, 1, 3, 1, 4, 1, 1, 2, 1, 3, 1];

/** Distance minimale (tuiles) entre un ennemi placé automatiquement et un point d'arrivée des joueurs. */
const MIN_SPAWN_DIST = 14;

/** Groupe d'ennemis à répartir au hasard (déterministe) dans un rectangle. */
interface EnemyGroup {
  rect: TileRect;
  kinds: EnemyKind[];
  count: number;
  /** Vague (défaut 0). */
  wave?: number;
}

function dist(a: TileXY, b: TileXY): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/**
 * Place les groupes d'ennemis sur des tuiles de sol, à ≥ `MIN_SPAWN_DIST` des arrivées et à ≥ 3 tuiles des
 * éléments à éviter (mécanismes, portes, panneaux), sans empilement. `minPlayers` suit `ENEMY_MIN_PATTERN`.
 */
function populate(layout: string[], groups: EnemyGroup[], avoid: TileXY[], spawns: TileXY[], seed: number): EnemySpawnDef[] {
  const rand = rng(seed);
  const out: EnemySpawnDef[] = [];
  const taken: TileXY[] = [];
  let idx = 0;
  for (const grp of groups) {
    for (let k = 0; k < grp.count; k++) {
      let placed: TileXY | null = null;
      for (let attempt = 0; attempt < 400 && !placed; attempt++) {
        const x = grp.rect.x + Math.floor(rand() * grp.rect.w);
        const y = grp.rect.y + Math.floor(rand() * grp.rect.h);
        if (!isFloorCh(layout[y]?.[x])) continue;
        const t: TileXY = [x, y];
        if (spawns.some((s) => dist(s, t) < MIN_SPAWN_DIST)) continue;
        if (avoid.some((a) => dist(a, t) < 3)) continue;
        const gap = attempt < 200 ? 2 : 1;
        if (taken.some((o) => Math.max(Math.abs(o[0] - x), Math.abs(o[1] - y)) < gap)) continue;
        placed = t;
      }
      if (!placed) throw new Error(`level2 : groupe d'ennemis impossible à placer (${JSON.stringify(grp.rect)})`);
      taken.push(placed);
      const kind = grp.kinds[k % grp.kinds.length];
      const def: EnemySpawnDef = { kind, tile: placed };
      const min = ENEMY_MIN_PATTERN[idx % ENEMY_MIN_PATTERN.length];
      if (min > 1) def.minPlayers = min;
      if ((grp.wave ?? 0) > 0) def.wave = grp.wave;
      out.push(def);
      idx++;
    }
  }
  return out;
}

/** Décor à répartir : torches/bannières sur les murs, le reste sur des tuiles de sol dégagées. */
interface DecorSpec {
  type: DecorDef['type'];
  count: number;
  rect?: TileRect;
}

/**
 * Répartit le décor de façon déterministe. Les objets au sol n'occupent que des tuiles dont les 8 voisines sont du
 * sol (jamais dans un couloir, donc jamais bloquants), à ≥ 3 tuiles des éléments à éviter. Torches et bannières
 * s'accrochent à un mur dont la tuile sud est du sol.
 */
function placeDecor(layout: string[], specs: DecorSpec[], avoid: TileXY[], seed: number): DecorDef[] {
  const rand = rng(seed);
  const out: DecorDef[] = [];
  const used = new Set<string>();
  const h = layout.length;
  const w = layout[0].length;
  for (const spec of specs) {
    const r = spec.rect ?? { x: 1, y: 1, w: w - 2, h: h - 2 };
    const wall = spec.type === 'torch' || spec.type === 'banner';
    const cands: TileXY[] = [];
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        if (wall) {
          if (layout[y]?.[x] === '#' && isFloorCh(layout[y + 1]?.[x])) cands.push([x, y]);
        } else if (isFloorCh(layout[y]?.[x])) {
          let ok = true;
          for (let dj = -1; dj <= 1 && ok; dj++) for (let di = -1; di <= 1 && ok; di++) ok = isFloorCh(layout[y + dj]?.[x + di]);
          if (ok && avoid.every((a) => dist(a, [x, y]) >= 3)) cands.push([x, y]);
        }
      }
    }
    for (let k = 0; k < spec.count && cands.length > 0; k++) {
      const i = Math.floor(rand() * cands.length);
      const [t] = cands.splice(i, 1);
      const id = `${t[0]},${t[1]}`;
      if (used.has(id)) continue;
      used.add(id);
      out.push({ type: spec.type, tile: t });
    }
  }
  return out;
}

/** Toutes les tuiles « sensibles » des mécanismes (à éloigner des ennemis et du décor). */
function mechTiles(mechs: readonly MechanismDef[]): TileXY[] {
  const out: TileXY[] = [];
  for (const m of mechs) {
    if (m.type === 'plate' || m.type === 'lever' || m.type === 'key') out.push(m.tile);
    else if (m.type === 'brazier') out.push(m.tile);
    else if (m.type === 'door') out.push(...m.tiles);
    else if (m.type === 'runePuzzle') out.push(m.displayTile, ...m.pedestals.map((p) => p.tile));
  }
  return out;
}

// ───────────────────────────── Layouts ─────────────────────────────

/**
 * Grille « lisiere » (60×38) : salle d'arrivée à l'ouest, grande clairière centrale, quatre ailes (une plaque par
 * aile : NO, NE, SO, SE), deux alcôves, couloir est fermé par la porte de racines (x=44) vers la salle de sortie.
 */
function buildLisiere(): string[] {
  const g = newGrid(60, 38);
  carve(g, 1, 14, 12, 11); //   salle d'arrivée x1..12, y14..24
  carve(g, 13, 18, 4, 3); //    couloir arrivée → clairière
  carve(g, 17, 10, 22, 18); //  clairière centrale x17..38, y10..27
  carve(g, 3, 2, 14, 8); //     aile nord-ouest
  carve(g, 9, 10, 3, 4); //     couloir nord-ouest ↔ arrivée
  carve(g, 3, 29, 14, 7); //    aile sud-ouest
  carve(g, 9, 25, 3, 4); //     couloir sud-ouest ↔ arrivée
  carve(g, 34, 4, 3, 6); //     couloir nord (clairière → aile nord-est)
  carve(g, 37, 3, 3, 3);
  carve(g, 40, 2, 18, 8); //    aile nord-est
  carve(g, 34, 28, 3, 5); //    couloir sud (clairière → aile sud-est)
  carve(g, 37, 30, 3, 3);
  carve(g, 40, 28, 18, 8); //   aile sud-est
  carve(g, 39, 18, 6, 3); //    couloir est x39..44, y18..20 (porte en x=44)
  carve(g, 45, 14, 13, 11); //  salle de sortie x45..57, y14..24
  carve(g, 19, 4, 8, 5); //     alcôve nord
  carve(g, 22, 9, 3, 1);
  carve(g, 19, 30, 8, 5); //    alcôve sud
  carve(g, 22, 28, 3, 2);
  carve(g, 27, 17, 6, 4, '~'); // mare au centre de la clairière
  patches(g, 4, 15, 6, 4);
  patches(g, 19, 22, 6, 4);
  patches(g, 42, 3, 8, 4);
  patches(g, 42, 30, 8, 4);
  patches(g, 47, 17, 6, 4);
  pillars(g, 19, 12, 18, 14, 4, 4);
  pillars(g, 5, 4, 10, 5, 4, 3);
  pillars(g, 42, 4, 14, 5, 5, 3);
  pillars(g, 42, 30, 14, 5, 5, 3);
  return toRows(g);
}

/**
 * Grille « clairiere » (76×44) : grande prairie centrale (mare, piliers), quatre clairières d'angle reliées par des
 * sentiers sinueux, salle sud en cul-de-sac, couloir nord vers la grille de ronces puis la salle de sortie.
 */
function buildClairiere(): string[] {
  const g = newGrid(76, 44);
  carve(g, 22, 14, 32, 19); //  prairie x22..53, y14..32
  carve(g, 3, 3, 18, 12); //    clairière nord-ouest
  carve(g, 21, 8, 6, 3); //     sentier NO (est puis sud)
  carve(g, 24, 11, 3, 4);
  carve(g, 55, 3, 18, 12); //   clairière nord-est
  carve(g, 49, 8, 6, 3); //     sentier NE
  carve(g, 49, 11, 3, 4);
  carve(g, 3, 30, 18, 12); //   clairière sud-ouest
  carve(g, 21, 35, 6, 3); //    sentier SO
  carve(g, 24, 33, 3, 3);
  carve(g, 55, 30, 18, 12); //  clairière sud-est
  carve(g, 49, 35, 6, 3); //    sentier SE
  carve(g, 49, 33, 3, 3);
  carve(g, 28, 34, 20, 8); //   salle sud (cul-de-sac)
  carve(g, 36, 33, 4, 1);
  carve(g, 37, 9, 2, 5); //     couloir nord vers la grille (x37..38)
  carve(g, 37, 7, 2, 2); //     au-delà de la grille (porte en y=8)
  carve(g, 30, 1, 16, 6); //    salle de sortie
  carve(g, 34, 20, 8, 6, '~'); // mare centrale
  patches(g, 24, 16, 6, 5);
  patches(g, 46, 26, 6, 5);
  patches(g, 5, 5, 6, 4);
  patches(g, 63, 32, 6, 4);
  patches(g, 32, 36, 8, 4);
  pillars(g, 23, 15, 30, 17, 5, 4);
  pillars(g, 7, 6, 12, 8, 5, 4);
  pillars(g, 58, 6, 12, 8, 5, 4);
  pillars(g, 7, 33, 12, 7, 5, 4);
  pillars(g, 58, 33, 12, 7, 5, 4);
  pillars(g, 29, 35, 18, 3, 6, 3);
  return toRows(g);
}

/** Départs x des 4 alcôves de clés (nord) et des 4 cellules (sud) du nid : vert, rouge, bleu, jaune. */
const NID_X0: Readonly<Record<Color, number>> = { green: 3, red: 19, blue: 35, yellow: 51 };

/**
 * Grille « nid » (76×46) : très grand hall central, quatre alcôves de clés au nord (couloirs de 3 tuiles), quatre
 * cellules à plaque au sud (couloirs de 2 tuiles fermés par les portes, y=34), niches décoratives, couloir est
 * fermé par la grille (x=69) vers la salle de sortie.
 */
function buildNid(): string[] {
  const g = newGrid(76, 46);
  carve(g, 1, 14, 66, 19); //   hall x1..66, y14..32
  for (const x0 of Object.values(NID_X0)) {
    carve(g, x0, 2, 11, 10); //     alcôve de clé
    carve(g, x0 + 4, 12, 3, 2); //  couloir alcôve ↔ hall
    carve(g, x0, 36, 11, 8); //     cellule
    carve(g, x0 + 5, 33, 2, 3); //  passage hall ↔ cellule (porte en y=34)
    patches(g, x0 + 1, 3, 4, 4);
    patches(g, x0 + 6, 38, 4, 4);
    pillars(g, x0 + 1, 5, 9, 6, 4, 3);
  }
  carve(g, 31, 10, 3, 4); //    niche nord
  carve(g, 31, 33, 3, 5); //    niche sud
  carve(g, 64, 9, 3, 5); //     niche nord-est
  carve(g, 67, 22, 3, 2); //    couloir est (grille en x=69)
  carve(g, 70, 16, 5, 14); //   salle de sortie
  carve(g, 40, 22, 10, 4, '~'); // mare du hall
  patches(g, 3, 17, 8, 6);
  patches(g, 52, 26, 10, 5);
  pillars(g, 5, 15, 60, 17, 5, 4);
  return toRows(g);
}

/**
 * Grille « murmures » (76×42) : grande salle centrale (autel, fosse), six salles à piédestal reliées par des
 * couloirs (NO, NE, SO, SE, ouest, est), vestibule nord fermé par le sceau (y=5) vers la salle de sortie.
 */
function buildMurmures(): string[] {
  const g = newGrid(76, 42);
  carve(g, 22, 10, 32, 22); //  salle centrale x22..53, y10..31
  carve(g, 3, 2, 14, 12); //    salle NO
  carve(g, 17, 10, 5, 3);
  carve(g, 59, 2, 14, 12); //   salle NE
  carve(g, 54, 10, 5, 3);
  carve(g, 3, 28, 14, 12); //   salle SO
  carve(g, 17, 28, 5, 3);
  carve(g, 59, 28, 14, 12); //  salle SE
  carve(g, 54, 28, 5, 3);
  carve(g, 3, 16, 10, 8); //    salle ouest
  carve(g, 13, 18, 9, 3);
  carve(g, 63, 16, 10, 8); //   salle est
  carve(g, 54, 18, 9, 3);
  carve(g, 36, 5, 3, 5); //     vestibule nord (sceau en y=5)
  carve(g, 30, 1, 16, 4); //    salle de sortie
  carve(g, 30, 24, 16, 3, '~'); // fosse sud de l'autel
  patches(g, 24, 12, 8, 6);
  patches(g, 44, 12, 8, 6);
  patches(g, 4, 3, 6, 4);
  patches(g, 62, 30, 8, 5);
  pillars(g, 24, 12, 28, 18, 4, 4);
  pillars(g, 4, 3, 12, 10, 4, 3);
  pillars(g, 60, 3, 12, 10, 4, 3);
  pillars(g, 4, 29, 12, 10, 4, 3);
  pillars(g, 60, 29, 12, 10, 4, 3);
  return toRows(g);
}

/**
 * Grille « mare » (76×40) : rive ouest (hall + deux bosquets), marais de fosses traversé par trois ponts et un îlot
 * central, rive est (hall + quatre salles à plaque), couloir est fermé par le portail (x=70) vers la salle de sortie.
 */
function buildMare(): string[] {
  const g = newGrid(76, 40);
  carve(g, 1, 12, 21, 16); //   hall ouest x1..21, y12..27
  carve(g, 2, 2, 18, 7); //     bosquet nord-ouest
  carve(g, 9, 9, 3, 3);
  carve(g, 2, 31, 18, 7); //    bosquet sud-ouest
  carve(g, 9, 28, 3, 3);
  carve(g, 22, 10, 23, 20, '~'); // marais x22..44, y10..29
  carve(g, 22, 13, 23, 3); //   pont nord
  carve(g, 22, 19, 23, 3); //   pont central
  carve(g, 22, 24, 23, 3); //   pont sud
  carve(g, 30, 16, 8, 8); //    îlot central (relie les ponts)
  carve(g, 45, 12, 22, 16); //  hall est x45..66, y12..27
  carve(g, 46, 2, 11, 7); //    salle de la plaque bleue
  carve(g, 50, 9, 3, 3);
  carve(g, 58, 2, 9, 7); //     salle de la plaque rouge
  carve(g, 61, 9, 3, 3);
  carve(g, 46, 31, 11, 7); //   salle de la plaque verte
  carve(g, 50, 28, 3, 3);
  carve(g, 58, 31, 9, 7); //    salle de la plaque jaune
  carve(g, 61, 28, 3, 3);
  carve(g, 67, 18, 4, 3); //    couloir du portail (porte en x=70)
  carve(g, 71, 14, 4, 12); //   salle de sortie
  patches(g, 3, 14, 8, 6);
  patches(g, 5, 4, 8, 3);
  patches(g, 5, 33, 8, 3);
  patches(g, 47, 14, 8, 6);
  patches(g, 56, 20, 8, 6);
  pillars(g, 3, 13, 18, 14, 5, 4);
  pillars(g, 46, 13, 20, 14, 5, 4);
  pillars(g, 3, 3, 16, 5, 5, 3);
  pillars(g, 3, 32, 16, 5, 5, 3);
  return toRows(g);
}

/** Grille « arene » (50×40) : arène dégagée avec quelques piliers et des taches de sol. */
function buildArene(): string[] {
  const g = newGrid(50, 40);
  carve(g, 1, 1, 48, 38);
  patches(g, 3, 3, 8, 6);
  patches(g, 20, 17, 8, 6);
  patches(g, 38, 30, 9, 6);
  patches(g, 30, 6, 6, 5);
  for (const x of [14, 34]) for (const y of [8, 15, 24, 31]) g[y][x] = 'o';
  return toRows(g);
}

const LISIERE_LAYOUT = buildLisiere();
const CLAIRIERE_LAYOUT = buildClairiere();
const NID_LAYOUT = buildNid();
const MURMURES_LAYOUT = buildMurmures();
const MARE_LAYOUT = buildMare();
const ARENE_LAYOUT = buildArene();

// ───────────────────────────── Salle 1 : la Lisière Moisie ─────────────────────────────

const LISIERE_SPAWNS: TileXY[] = [[2, 18], [3, 18], [2, 19], [3, 19]];

const lisiereMechanisms: MechanismDef[] = [
  plate('blue', [6, 4], MIN_BY_COLOR.blue),
  plate('red', [54, 5], MIN_BY_COLOR.red),
  plate('green', [6, 33], MIN_BY_COLOR.green),
  plate('yellow', [54, 32], MIN_BY_COLOR.yellow),
  {
    id: 'root_door',
    type: 'door',
    tiles: [[44, 18], [44, 19], [44, 20]],
    requires: ['plate_blue', 'plate_red', 'plate_green', 'plate_yellow'],
    labelKey: 'mech.level2.root_door',
  },
];

const LISIERE_SIGNS = [
  { id: 'plates', tile: [5, 16] as TileXY, textKey: 'sign.level2.plates' },
  { id: 'platesWings', tile: [20, 19] as TileXY, textKey: 'sign.level2.platesWings' },
  { id: 'platesDoor', tile: [41, 19] as TileXY, textKey: 'sign.level2.plates' },
];

/**
 * Salle 1 — plaques collectives (rappel du niveau 1) dans un décor de bois pourri, 60×38.
 * Résolution : la porte de racines (x=44, couloir de 3 tuiles entièrement fermé) exige les plaques
 * bleue/rouge/verte/jaune (une par joueur présent, les plaques des joueurs absents sont « waived »). Les quatre
 * plaques sont dans quatre ailes opposées de la clairière (bleue NO, rouge NE, verte SO, jaune SE), toutes
 * accessibles depuis la clairière centrale ou la salle d'arrivée : les joueurs se dispersent, éliminent les
 * limaces/chauves-souris, puis chacun tient la plaque de sa couleur en même temps → la porte s'ouvre
 * définitivement. Tous rejoignent la salle de sortie (est). À 1 joueur : seule la plaque bleue compte ; à 2 :
 * bleue + rouge ; etc. Deux panneaux dans la salle d'arrivée et la clairière expliquent où aller.
 */
const lisiere: RoomDef = {
  id: 'lisiere',
  nameKey: 'room.level2.lisiere.name',
  theme: 'grove',
  layout: LISIERE_LAYOUT,
  playerSpawns: LISIERE_SPAWNS,
  enemies: populate(
    LISIERE_LAYOUT,
    [
      { rect: { x: 18, y: 11, w: 9, h: 6 }, kinds: ['slime', 'bat'], count: 2 },
      { rect: { x: 30, y: 11, w: 8, h: 6 }, kinds: ['slime', 'bat'], count: 2 },
      { rect: { x: 18, y: 21, w: 9, h: 6 }, kinds: ['slime', 'bat'], count: 2 },
      { rect: { x: 30, y: 21, w: 8, h: 6 }, kinds: ['slime', 'bat'], count: 2 },
      { rect: { x: 3, y: 2, w: 14, h: 8 }, kinds: ['slime', 'bat'], count: 2 },
      { rect: { x: 40, y: 2, w: 18, h: 8 }, kinds: ['slime', 'bat'], count: 2 },
      { rect: { x: 3, y: 29, w: 14, h: 7 }, kinds: ['slime', 'bat'], count: 2 },
      { rect: { x: 40, y: 28, w: 18, h: 8 }, kinds: ['slime', 'bat'], count: 2 },
      { rect: { x: 19, y: 4, w: 8, h: 5 }, kinds: ['slime'], count: 1 },
      { rect: { x: 19, y: 30, w: 8, h: 5 }, kinds: ['slime'], count: 1 },
    ],
    [...mechTiles(lisiereMechanisms), ...LISIERE_SIGNS.map((s) => s.tile)],
    LISIERE_SPAWNS,
    21,
  ),
  mechanisms: lisiereMechanisms,
  signs: LISIERE_SIGNS,
  decor: placeDecor(
    LISIERE_LAYOUT,
    [
      { type: 'torch', count: 10 },
      { type: 'banner', count: 3, rect: { x: 40, y: 10, w: 18, h: 16 } },
      { type: 'statue', count: 3 },
      { type: 'plant', count: 10 },
      { type: 'crystal', count: 5 },
      { type: 'bones', count: 6 },
      { type: 'crate', count: 5 },
    ],
    [...mechTiles(lisiereMechanisms), ...LISIERE_SIGNS.map((s) => s.tile), ...LISIERE_SPAWNS],
    22,
  ),
  exit: { rect: { x: 51, y: 16, w: 5, h: 7 }, requires: ['root_door'] },
  introHintKey: 'hintroom.level2.lisiere',
};

// ───────────────────────────── Salle 2 : la Clairière des Lianes ─────────────────────────────

const CLAIRIERE_SPAWNS: TileXY[] = [[35, 38], [36, 38], [37, 38], [38, 38]];

const clairiereMechanisms: MechanismDef[] = [
  lever('blue', [4, 4]),
  lever('red', [71, 4]),
  lever('green', [4, 40]),
  lever('yellow', [71, 40]),
  {
    id: 'vine_gate',
    type: 'door',
    tiles: [[37, 8], [38, 8]],
    requires: ['lever_blue', 'lever_red', 'lever_green', 'lever_yellow'],
    labelKey: 'mech.level2.vine_gate',
  },
];

const CLAIRIERE_SIGNS = [
  { id: 'levers', tile: [33, 37] as TileXY, textKey: 'sign.level2.levers' },
  { id: 'leversWings', tile: [40, 37] as TileXY, textKey: 'sign.level2.leversWings' },
  { id: 'leversGate', tile: [37, 12] as TileXY, textKey: 'sign.level2.leversGate' },
];

/**
 * Salle 2 — leviers à fenêtre aux quatre coins, SÉPARÉS et SIMULTANÉS, 76×44.
 * Résolution : chaque joueur rejoint le levier de sa couleur par un sentier sinueux (coins nord-ouest bleu,
 * nord-est rouge, sud-ouest vert, sud-est jaune ; ≈ 40–50 tuiles depuis la prairie d'arrivée), élimine ses gardiens,
 * puis tous actionnent leur levier dans la même fenêtre de 12 s (sinon le premier levier se rabat). La grille de
 * ronces (couloir nord, x37–38, porte en y=8, entièrement fermée) s'ouvre définitivement dès que tous les leviers
 * actifs sont enclenchés en même temps ; la sortie est dans la salle derrière. À n joueurs : n leviers (les autres
 * sont « waived ») ; la fenêtre effective reste 12 s car nbLeviers ≤ nbJoueurs. Les leviers sont dans les clairières
 * d'angle, bien loin de la grille : aucun verrou. Une vague de renforts apparaît dans la prairie une fois les
 * premiers groupes vaincus (facultatif : aucun mécanisme n'en dépend).
 */
const clairiere: RoomDef = {
  id: 'clairiere',
  nameKey: 'room.level2.clairiere.name',
  theme: 'grove',
  layout: CLAIRIERE_LAYOUT,
  playerSpawns: CLAIRIERE_SPAWNS,
  enemies: populate(
    CLAIRIERE_LAYOUT,
    [
      { rect: { x: 4, y: 4, w: 16, h: 10 }, kinds: ['archer', 'slime', 'slime'], count: 3 },
      { rect: { x: 56, y: 4, w: 16, h: 10 }, kinds: ['archer', 'slime', 'bat'], count: 3 },
      { rect: { x: 4, y: 31, w: 16, h: 10 }, kinds: ['skeleton', 'bat', 'bat'], count: 3 },
      { rect: { x: 56, y: 31, w: 16, h: 10 }, kinds: ['skeleton', 'bat', 'archer'], count: 3 },
      { rect: { x: 22, y: 14, w: 14, h: 8 }, kinds: ['slime', 'bat'], count: 2 },
      { rect: { x: 40, y: 14, w: 14, h: 8 }, kinds: ['slime', 'bat'], count: 2 },
      { rect: { x: 22, y: 14, w: 10, h: 10 }, kinds: ['slime', 'skeleton'], count: 2 },
      { rect: { x: 44, y: 14, w: 10, h: 10 }, kinds: ['slime', 'skeleton'], count: 2 },
      { rect: { x: 21, y: 8, w: 6, h: 3 }, kinds: ['bat'], count: 1 },
      { rect: { x: 49, y: 8, w: 6, h: 3 }, kinds: ['bat'], count: 1 },
      { rect: { x: 21, y: 35, w: 6, h: 3 }, kinds: ['spider'], count: 1 },
      { rect: { x: 49, y: 35, w: 6, h: 3 }, kinds: ['spider'], count: 1 },
      { rect: { x: 24, y: 15, w: 28, h: 16 }, kinds: ['skeleton', 'archer', 'bat', 'skeleton'], count: 4, wave: 1 },
    ],
    [...mechTiles(clairiereMechanisms), ...CLAIRIERE_SIGNS.map((s) => s.tile)],
    CLAIRIERE_SPAWNS,
    31,
  ),
  mechanisms: clairiereMechanisms,
  signs: CLAIRIERE_SIGNS,
  decor: placeDecor(
    CLAIRIERE_LAYOUT,
    [
      { type: 'torch', count: 12 },
      { type: 'banner', count: 2, rect: { x: 30, y: 1, w: 16, h: 6 } },
      { type: 'statue', count: 3 },
      { type: 'plant', count: 14 },
      { type: 'crystal', count: 6 },
      { type: 'bones', count: 6 },
      { type: 'crate', count: 5 },
    ],
    [...mechTiles(clairiereMechanisms), ...CLAIRIERE_SIGNS.map((s) => s.tile), ...CLAIRIERE_SPAWNS],
    32,
  ),
  exit: { rect: { x: 32, y: 2, w: 12, h: 3 }, requires: ['vine_gate'] },
  introHintKey: 'hintroom.level2.clairiere',
};

// ───────────────────────────── Salle 3 : le Nid des Ronces ─────────────────────────────

const NID_SPAWNS: TileXY[] = [[2, 21], [2, 22], [2, 23], [2, 24]];

/** Passage 2 tuiles (porte en y=34) vers la cellule de la couleur donnée. */
function nidGate(color: Color): DoorDef {
  const x = NID_X0[color] + 5;
  return gate(color, [[x, 34], [x + 1, 34]]);
}

/**
 * Braseros de la salle sombre : départ éclairé (ouest du hall), hall central et est (≈ 28 tuiles d'écart), un par
 * alcôve de clé (à 3 tuiles de la clé), un par cellule (à ≈ 3 tuiles de la plaque), et deux braseros ÉTEINTS en
 * niche (tâche annexe : l'allumer ajoute un refuge, rien n'en dépend).
 */
const nidBraziers: MechanismDef[] = [
  litBrazier('start', [4, 22]),
  litBrazier('hall_mid', [32, 26]),
  litBrazier('hall_east', [60, 26]),
  ...(['green', 'red', 'blue', 'yellow'] as const).flatMap((c) => [
    litBrazier(`key_${c}`, [NID_X0[c] + 8, 3]),
    litBrazier(`cell_${c}`, [NID_X0[c] + 8, 40]),
  ]),
  coldBrazier('niche_north', [32, 10]),
  coldBrazier('niche_east', [65, 9]),
];

const nidMechanisms: MechanismDef[] = [
  ...nidBraziers,
  key('green', [NID_X0.green + 5, 3]),
  key('red', [NID_X0.red + 5, 3]),
  key('blue', [NID_X0.blue + 5, 3]),
  key('yellow', [NID_X0.yellow + 5, 3]),
  nidGate('green'),
  nidGate('red'),
  nidGate('blue'),
  nidGate('yellow'),
  plate('green', [NID_X0.green + 5, 41], MIN_NEST.green),
  plate('red', [NID_X0.red + 5, 41], MIN_NEST.red),
  plate('blue', [NID_X0.blue + 5, 41], MIN_NEST.blue),
  plate('yellow', [NID_X0.yellow + 5, 41], MIN_NEST.yellow),
  {
    id: 'grille',
    type: 'door',
    tiles: [[69, 22], [69, 23]],
    requires: ['plate_green', 'plate_red', 'plate_blue', 'plate_yellow'],
    labelKey: 'mech.level2.grille',
  },
];

const NID_SIGNS = [
  { id: 'keys', tile: [4, 19] as TileXY, textKey: 'sign.level2.keys' },
  { id: 'keysAlcoves', tile: [7, 27] as TileXY, textKey: 'sign.level2.keysAlcoves' },
  { id: 'keysGrille', tile: [64, 24] as TileXY, textKey: 'sign.level2.keysGrille' },
  { id: 'keysDark', tile: [5, 25] as TileXY, textKey: 'sign.level2.keysDark' },
];

/** Décors lumineux de la salle sombre : torches murales (3 tuiles) de part et d'autre des clés et des portes de cellule. */
const NID_GLOW: DecorDef[] = (['green', 'red', 'blue', 'yellow'] as const).flatMap((c): DecorDef[] => {
  const x0 = NID_X0[c];
  return [
    { type: 'torch', tile: [x0 + 4, 1] },
    { type: 'torch', tile: [x0 + 6, 1] },
    { type: 'crystal', tile: [x0 + 4, 3] },
    { type: 'crystal', tile: [x0 + 6, 4] },
    { type: 'torch', tile: [x0 + 4, 34] },
    { type: 'torch', tile: [x0 + 7, 34] },
  ];
});

/**
 * Salle 3 — clés personnelles + plaques tenues ensemble (séparés, puis simultanés), 76×46.
 * Résolution : au nord, 4 alcôves de 11×10 gardées par des araignées contiennent chacune la clé d'une couleur
 * (seul le joueur de cette couleur peut la ramasser ; couloirs de 3 tuiles depuis le hall). Chacun rapporte sa clé
 * à la porte de sa couleur (passages de 2 tuiles, rangée sud, entièrement fermés) et appuie sur Action devant
 * elle : la porte s'ouvre pour de bon (la clé est consommée), puis il se place sur la plaque, au fond de sa
 * cellule (aucun ennemi dans les cellules). Quand toutes les plaques (une par joueur présent) sont tenues en même
 * temps, la grille de l'est (couloir de 2 tuiles, porte en x=69) s'ouvre définitivement. À n joueurs : n
 * clés/portes/plaques (les autres sont « waived »). Aucun verrou : les clés sont dans des alcôves ouvertes sur le
 * hall d'arrivée, les cellules ne contiennent que des plaques. Panneaux : alcôves nord / cellules sud / grille.
 *
 * SALLE SOMBRE (`dark: true`) : seule la torche de chaque joueur (75 s de combustible) et les sources fixes éclairent.
 * Braseros ALLUMÉS = points de recharge : un au départ (à ≈ 2 tuiles des arrivées), deux dans le hall (≈ 28 tuiles
 * d'écart), un dans chaque alcôve à 3 tuiles de la clé et un dans chaque cellule près de la plaque. Des torches
 * murales encadrent les clés et les portes de cellule, des cristaux (champignons lumineux) signalent les clés. Deux
 * braseros ÉTEINTS en niche (nord, nord-est) : tâche annexe, jamais exigés par une porte. Tout reste solvable à
 * 1-4 joueurs : les mécanismes (clés, portes, plaques) ne dépendent d'aucun brasero.
 */
const nid: RoomDef = {
  id: 'nid',
  nameKey: 'room.level2.nid.name',
  theme: 'grove',
  layout: NID_LAYOUT,
  dark: true,
  playerSpawns: NID_SPAWNS,
  enemies: populate(
    NID_LAYOUT,
    [
      { rect: { x: 3, y: 2, w: 11, h: 10 }, kinds: ['spider'], count: 2 },
      { rect: { x: 19, y: 2, w: 11, h: 10 }, kinds: ['spider'], count: 2 },
      { rect: { x: 35, y: 2, w: 11, h: 10 }, kinds: ['spider'], count: 2 },
      { rect: { x: 51, y: 2, w: 11, h: 10 }, kinds: ['spider'], count: 2 },
      { rect: { x: 8, y: 15, w: 14, h: 17 }, kinds: ['slime', 'skeleton'], count: 3 },
      { rect: { x: 24, y: 15, w: 14, h: 17 }, kinds: ['skeleton', 'slime'], count: 3 },
      { rect: { x: 40, y: 15, w: 10, h: 6 }, kinds: ['skeleton', 'spider'], count: 2 },
      { rect: { x: 50, y: 15, w: 16, h: 17 }, kinds: ['spider', 'skeleton'], count: 3 },
      { rect: { x: 31, y: 10, w: 3, h: 4 }, kinds: ['spider'], count: 1 },
      { rect: { x: 31, y: 33, w: 3, h: 5 }, kinds: ['slime'], count: 1 },
      { rect: { x: 64, y: 9, w: 3, h: 5 }, kinds: ['spider'], count: 1 },
      { rect: { x: 8, y: 15, w: 56, h: 17 }, kinds: ['skeleton', 'spider', 'skeleton', 'slime'], count: 4, wave: 1 },
    ],
    [...mechTiles(nidMechanisms), ...NID_SIGNS.map((s) => s.tile)],
    NID_SPAWNS,
    41,
  ),
  mechanisms: nidMechanisms,
  signs: NID_SIGNS,
  decor: [
    ...NID_GLOW,
    ...placeDecor(
      NID_LAYOUT,
      [
        { type: 'torch', count: 5 },
        { type: 'banner', count: 8, rect: { x: 1, y: 30, w: 66, h: 6 } },
        { type: 'statue', count: 3 },
        { type: 'plant', count: 12 },
        { type: 'crystal', count: 6 },
        { type: 'bones', count: 8 },
        { type: 'crate', count: 6 },
      ],
      [...mechTiles(nidMechanisms), ...NID_SIGNS.map((s) => s.tile), ...NID_SPAWNS, ...NID_GLOW.map((d) => d.tile)],
      42,
    ),
  ],
  exit: { rect: { x: 71, y: 18, w: 3, h: 10 }, requires: ['grille'] },
  introHintKey: 'hintroom.level2.nid',
};

// ───────────────────────────── Salle 4 : la Chambre des Murmures ─────────────────────────────

const MURMURES_SPAWNS: TileXY[] = [[35, 29], [36, 29], [37, 29], [38, 29]];

const murmuresMechanisms: MechanismDef[] = [
  {
    id: 'runes',
    type: 'runePuzzle',
    displayTile: [37, 18],
    visibleToSlot: 1,
    sequence: ['moon', 'flame', 'eye', 'star'],
    pedestals: [
      { symbol: 'sun', tile: [6, 5] },
      { symbol: 'moon', tile: [68, 5] },
      { symbol: 'star', tile: [6, 35] },
      { symbol: 'eye', tile: [69, 35] },
      { symbol: 'flame', tile: [6, 19] },
      { symbol: 'wave', tile: [69, 19] },
    ],
    labelKey: 'mech.level2.runes',
  },
  {
    id: 'seal',
    type: 'door',
    tiles: [[36, 5], [37, 5], [38, 5]],
    requires: ['runes'],
    labelKey: 'mech.level2.seal',
  },
];

const MURMURES_SIGNS = [
  { id: 'runesReader', tile: [35, 27] as TileXY, textKey: 'sign.level2.runesReader' },
  { id: 'runesPedestals', tile: [39, 21] as TileXY, textKey: 'sign.level2.runesPedestals' },
  { id: 'runesWings', tile: [24, 15] as TileXY, textKey: 'sign.level2.runesWings' },
];

/**
 * Salle 4 — énigme de runes à VISION PARTAGÉE, 76×42.
 * Résolution : la séquence (lune, flamme, œil, étoile) n'est affichée que dans la vue du joueur « lecteur »
 * (slot 1 → rouge ; en solo c'est le même joueur : énigme de mémoire, il lit l'autel puis parcourt les salles).
 * Il la décrit à voix haute ; les autres actionnent les piédestaux (Action à moins d'une tuile) dans l'ordre
 * annoncé. Les six piédestaux sont dans six salles distinctes (coins NO/NE/SO/SE, ouest, est), toutes reliées à la
 * grande salle centrale par des couloirs de 3–5 tuiles et à ≥ 30 tuiles de l'autel : le lecteur ne peut pas tout
 * faire seul en coop, la description orale est indispensable. Une erreur remet la progression à zéro (flash
 * rouge) ; on peut recommencer à volonté. Quand la séquence est complète, le sceau (vestibule nord, 3 tuiles,
 * entièrement fermé) s'ouvre définitivement et donne sur la salle de sortie. Les ennemis gardent les salles :
 * ils harcèlent mais n'empêchent pas la résolution. Une vague de renforts apparaît dans la grande salle.
 */
const murmures: RoomDef = {
  id: 'murmures',
  nameKey: 'room.level2.murmures.name',
  theme: 'grove',
  layout: MURMURES_LAYOUT,
  playerSpawns: MURMURES_SPAWNS,
  enemies: populate(
    MURMURES_LAYOUT,
    [
      { rect: { x: 3, y: 2, w: 14, h: 12 }, kinds: ['bat', 'skeleton'], count: 2 },
      { rect: { x: 59, y: 2, w: 14, h: 12 }, kinds: ['bat', 'archer'], count: 2 },
      { rect: { x: 3, y: 28, w: 14, h: 12 }, kinds: ['skeleton', 'bat'], count: 2 },
      { rect: { x: 59, y: 28, w: 14, h: 12 }, kinds: ['archer', 'bat'], count: 2 },
      { rect: { x: 3, y: 16, w: 10, h: 8 }, kinds: ['bat', 'slime'], count: 2 },
      { rect: { x: 63, y: 16, w: 10, h: 8 }, kinds: ['bat', 'slime'], count: 2 },
      { rect: { x: 22, y: 10, w: 12, h: 12 }, kinds: ['skeleton', 'bat'], count: 2 },
      { rect: { x: 42, y: 10, w: 12, h: 12 }, kinds: ['skeleton', 'bat'], count: 2 },
      { rect: { x: 22, y: 20, w: 8, h: 11 }, kinds: ['slime', 'bat'], count: 1 },
      { rect: { x: 46, y: 20, w: 8, h: 11 }, kinds: ['slime', 'archer'], count: 1 },
      { rect: { x: 17, y: 10, w: 5, h: 3 }, kinds: ['bat'], count: 1 },
      { rect: { x: 54, y: 28, w: 5, h: 3 }, kinds: ['bat'], count: 1 },
      { rect: { x: 23, y: 11, w: 30, h: 19 }, kinds: ['skeleton', 'bat', 'archer'], count: 3, wave: 1 },
    ],
    [...mechTiles(murmuresMechanisms), ...MURMURES_SIGNS.map((s) => s.tile)],
    MURMURES_SPAWNS,
    51,
  ),
  mechanisms: murmuresMechanisms,
  signs: MURMURES_SIGNS,
  decor: placeDecor(
    MURMURES_LAYOUT,
    [
      { type: 'torch', count: 12 },
      { type: 'banner', count: 4, rect: { x: 22, y: 1, w: 32, h: 12 } },
      { type: 'statue', count: 4, rect: { x: 22, y: 10, w: 32, h: 14 } },
      { type: 'plant', count: 10 },
      { type: 'crystal', count: 6 },
      { type: 'bones', count: 6 },
      { type: 'crate', count: 5 },
    ],
    [...mechTiles(murmuresMechanisms), ...MURMURES_SIGNS.map((s) => s.tile), ...MURMURES_SPAWNS],
    52,
  ),
  exit: { rect: { x: 33, y: 1, w: 10, h: 3 }, requires: ['seal'] },
  introHintKey: 'hintroom.level2.murmures',
};

// ───────────────────────────── Salle 5 : la Mare aux Archers ─────────────────────────────

const MARE_SPAWNS: TileXY[] = [[3, 19], [4, 19], [3, 20], [4, 20]];

const mareMechanisms: MechanismDef[] = [
  plate('blue', [51, 4], MIN_BY_COLOR.blue),
  plate('red', [63, 4], MIN_BY_COLOR.red),
  plate('green', [51, 35], MIN_BY_COLOR.green),
  plate('yellow', [63, 35], MIN_BY_COLOR.yellow),
  {
    id: 'portal',
    type: 'door',
    tiles: [[70, 18], [70, 19], [70, 20]],
    requires: ['plate_blue', 'plate_red', 'plate_green', 'plate_yellow'],
    labelKey: 'mech.level2.portal',
  },
];

const MARE_SIGNS = [
  { id: 'mare', tile: [6, 17] as TileXY, textKey: 'sign.level2.mare' },
  { id: 'mareBridges', tile: [20, 20] as TileXY, textKey: 'sign.level2.mareBridges' },
  { id: 'marePlates', tile: [55, 19] as TileXY, textKey: 'sign.level2.marePlates' },
];

/**
 * Salle 5 — traversée sous le feu, plaques-pièges, 76×40.
 * Résolution : la rive ouest (hall d'arrivée + deux bosquets) est séparée de la rive est par un marais (fosses)
 * franchissable par trois ponts de 3 tuiles (y 13-15, 19-21 et 24-26) reliés par un îlot central où se postent des
 * archers. Ceux de la rive est tirent par-dessus les fosses : on traverse groupé, on les élimine, puis chaque
 * joueur gagne la salle à plaque de sa couleur (bleue NO, rouge NE, verte SO, jaune SE — couloirs ouverts sur le
 * hall est) et la tient. Chaque plaque réveille une embuscade dans sa propre salle (apparition `when` sur la
 * plaque, même `minPlayers` qu'elle). Quand toutes les plaques (une par joueur présent) sont tenues ensemble, le
 * portail (x=70, couloir de 3 tuiles entièrement fermé) s'ouvre définitivement. À 1 joueur : plaque bleue seule.
 * Aucun verrou : les plaques sont atteignables depuis le hall est sans traverser le portail.
 */
const mare: RoomDef = {
  id: 'mare',
  nameKey: 'room.level2.mare.name',
  theme: 'grove',
  layout: MARE_LAYOUT,
  playerSpawns: MARE_SPAWNS,
  enemies: [
    ...populate(
      MARE_LAYOUT,
      [
        // Rive ouest.
        { rect: { x: 10, y: 12, w: 12, h: 16 }, kinds: ['slime', 'bat'], count: 3 },
        { rect: { x: 2, y: 2, w: 18, h: 7 }, kinds: ['slime', 'bat'], count: 3 },
        { rect: { x: 2, y: 31, w: 18, h: 7 }, kinds: ['slime', 'bat'], count: 3 },
        // Îlot central et ponts : archers.
        { rect: { x: 30, y: 16, w: 8, h: 8 }, kinds: ['archer'], count: 2 },
        { rect: { x: 22, y: 13, w: 8, h: 3 }, kinds: ['bat'], count: 1 },
        { rect: { x: 36, y: 24, w: 8, h: 3 }, kinds: ['bat'], count: 1 },
        // Rive est : archers et gardes du hall.
        { rect: { x: 46, y: 12, w: 10, h: 16 }, kinds: ['archer', 'skeleton'], count: 3 },
        { rect: { x: 56, y: 12, w: 10, h: 16 }, kinds: ['archer', 'skeleton'], count: 3 },
        { rect: { x: 46, y: 2, w: 11, h: 7 }, kinds: ['bat'], count: 1 },
        { rect: { x: 58, y: 2, w: 9, h: 7 }, kinds: ['bat'], count: 1 },
        { rect: { x: 46, y: 31, w: 11, h: 7 }, kinds: ['bat'], count: 1 },
        { rect: { x: 58, y: 31, w: 9, h: 7 }, kinds: ['bat'], count: 1 },
      ],
      [...mechTiles(mareMechanisms), ...MARE_SIGNS.map((s) => s.tile)],
      MARE_SPAWNS,
      61,
    ),
    // Embuscades déclenchées par les plaques (dans la salle de chaque plaque, même minPlayers que la plaque).
    enemy('skeleton', 54, 6, 1, { when: 'plate_blue' }),
    enemy('spider', 48, 6, 1, { when: 'plate_blue' }),
    enemy('spider', 59, 6, 2, { when: 'plate_red' }),
    enemy('skeleton', 65, 6, 2, { when: 'plate_red' }),
    enemy('skeleton', 54, 33, 3, { when: 'plate_green' }),
    enemy('spider', 48, 33, 3, { when: 'plate_green' }),
    enemy('spider', 59, 33, 4, { when: 'plate_yellow' }),
    enemy('skeleton', 65, 33, 4, { when: 'plate_yellow' }),
  ],
  mechanisms: mareMechanisms,
  signs: MARE_SIGNS,
  decor: placeDecor(
    MARE_LAYOUT,
    [
      { type: 'torch', count: 12 },
      { type: 'banner', count: 3, rect: { x: 45, y: 1, w: 22, h: 10 } },
      { type: 'statue', count: 3 },
      { type: 'plant', count: 12 },
      { type: 'crystal', count: 6 },
      { type: 'bones', count: 6 },
      { type: 'crate', count: 4 },
    ],
    [...mechTiles(mareMechanisms), ...MARE_SIGNS.map((s) => s.tile), ...MARE_SPAWNS],
    62,
  ),
  exit: { rect: { x: 72, y: 16, w: 3, h: 8 }, requires: ['portal'] },
  introHintKey: 'hintroom.level2.mare',
};

// ───────────────────────────── Salle 6 : l'Arène de Gorgrim (boss) ─────────────────────────────

const ARENE_SPAWNS: TileXY[] = [[3, 19], [3, 20], [4, 19], [4, 20]];

const ARENE_SIGNS = [{ id: 'arena', tile: [5, 22] as TileXY, textKey: 'sign.level2.arena' }];

/**
 * Salle 6 — salle de boss pure (aucun mécanisme) : Gorgrim, golem de racines.
 * Arène dégagée de 50×40 tuiles avec 8 piliers (esquive, abri contre les projectiles) et une meute de renforts
 * répartie dans toute l'arène (à ≥ 14 tuiles de l'arrivée) qui dépend UNIQUEMENT du nombre de joueurs.
 * Résolution : le groupe harcèle Gorgrim (mêlée par les côtés, tirs à distance) pendant que le joueur du slot 3
 * (jaune ; en solo le joueur lui-même) cumule 8 s dans le cercle de lumière (zone nord). Quand Gorgrim et tous
 * les renforts sont vaincus (`clear`) et que les 4 objectifs personnels sont accomplis, la sortie scellée
 * (est) s'ouvre ; tous les joueurs vivants la rejoignent → niveau terminé.
 * Pas de verrou : les objectifs des salles 2/3/4 sont accomplis avant d'arriver ; celui du cercle l'est ici,
 * même après la mort du boss (le cercle reste accessible, plus aucun ennemi).
 */
const arene: RoomDef = {
  id: 'arene',
  nameKey: 'room.level2.arene.name',
  theme: 'grove',
  layout: ARENE_LAYOUT,
  playerSpawns: ARENE_SPAWNS,
  enemies: [
    { kind: 'golem', tile: [38, 19] },
    ...populate(
      ARENE_LAYOUT,
      [
        { rect: { x: 14, y: 2, w: 14, h: 10 }, kinds: ['bat', 'skeleton', 'archer'], count: 3 },
        { rect: { x: 30, y: 2, w: 18, h: 10 }, kinds: ['archer', 'bat', 'slime'], count: 3 },
        { rect: { x: 14, y: 28, w: 14, h: 10 }, kinds: ['bat', 'skeleton', 'spider'], count: 3 },
        { rect: { x: 30, y: 28, w: 18, h: 10 }, kinds: ['archer', 'bat', 'skeleton'], count: 3 },
        { rect: { x: 20, y: 13, w: 12, h: 14 }, kinds: ['slime', 'spider'], count: 2 },
        { rect: { x: 40, y: 12, w: 8, h: 16 }, kinds: ['skeleton', 'archer'], count: 2 },
      ],
      ARENE_SIGNS.map((s) => s.tile),
      ARENE_SPAWNS,
      71,
    ),
  ],
  mechanisms: [],
  zones: [{ id: 'circle', rect: { x: 20, y: 3, w: 10, h: 5 } }],
  signs: ARENE_SIGNS,
  decor: placeDecor(
    ARENE_LAYOUT,
    [
      { type: 'torch', count: 12 },
      { type: 'banner', count: 5 },
      { type: 'crystal', count: 6 },
      { type: 'bones', count: 6 },
      { type: 'plant', count: 8 },
      { type: 'statue', count: 4 },
    ],
    [...ARENE_SIGNS.map((s) => s.tile), ...ARENE_SPAWNS],
    72,
  ),
  exit: {
    rect: { x: 46, y: 17, w: 3, h: 6 },
    requires: ['clear', 'obj:sync_levers', 'obj:read_runes', 'obj:bear_key', 'obj:hold_circle'],
    final: true,
    sealed: true,
  },
  introHintKey: 'hintroom.level2.arene',
};

// ───────────────────────────── Objectifs personnels ─────────────────────────────

const objectives: ObjectiveDef[] = [
  { id: 'sync_levers', slot: 0, roomId: 'clairiere', kind: 'mechanism', mechanismId: 'lever_blue', labelKey: 'objective.level2.sync_levers' },
  { id: 'read_runes', slot: 1, roomId: 'murmures', kind: 'mechanism', mechanismId: 'runes', labelKey: 'objective.level2.read_runes' },
  { id: 'bear_key', slot: 2, roomId: 'nid', kind: 'mechanism', mechanismId: 'key_green', labelKey: 'objective.level2.bear_key' },
  { id: 'hold_circle', slot: 3, roomId: 'arene', kind: 'zone', zoneId: 'circle', seconds: CIRCLE_SECONDS, labelKey: 'objective.level2.hold_circle' },
];

// ───────────────────────────── Niveau ─────────────────────────────

/** Niveau 2 : Le Bosquet Putride (6 salles vastes, ≈ 8 min, boss Gorgrim). */
export const level2: LevelDef = {
  id: 'level2',
  nameKey: 'level.level2.name',
  theme: 'grove',
  estimatedMinutes: 8,
  intro: [
    { speaker: 'narrator', textKey: 'level.level2.intro.1' },
    { speaker: 'aldric', textKey: 'level.level2.intro.2' },
    { speaker: 'lyssa', textKey: 'level.level2.intro.3' },
    { speaker: 'heroes', textKey: 'level.level2.intro.4' },
    { speaker: 'aldric', textKey: 'level.level2.intro.5' },
  ],
  outro: [
    { speaker: 'gorgrim', textKey: 'level.level2.outro.1' },
    { speaker: 'lyssa', textKey: 'level.level2.outro.2' },
    { speaker: 'lyssa', textKey: 'level.level2.outro.3' },
    { speaker: 'heroes', textKey: 'level.level2.outro.4' },
  ],
  rooms: [lisiere, clairiere, nid, murmures, mare, arene],
  objectives,
};
