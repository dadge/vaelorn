/**
 * Niveau 1 — « Les Cryptes Oubliées » (thème `crypt`, tutoriel, ~7 min, sans boss).
 *
 * Données pures (`LevelDef`). Chaque salle introduit UNE idée (un mécanisme + une rencontre) et alterne
 * coopération collective (tous ensemble) / actions séparées simultanées (chacun son levier, sa clé) :
 *
 *  1. `vestibule`    déplacement + attaque : un levier simple lève la herse ; il faut vider la salle.
 *  2. `plates`       PREMIÈRE PORTE À PLAQUES : deux plaques tenues en même temps (la 2e dès 2 joueurs).
 *  3. `cells`        RELEVAGE (embuscade de squelettes) + CLÉS PERSONNELLES : chacun sa clé, sa porte.
 *  4. `ossuary`      SALLE SOMBRE (torches + braseros) : combat en VAGUES déclenché par un levier ; objectif « vaincre 2 ennemis ».
 *  5. `antechamber`  QUATRE LEVIERS (un par héros) à actionner presque ensemble (fenêtre de 24 s).
 *  6. `seal`         salle du sceau : objectif « tenir le cercle » pendant que les autres protègent ;
 *                    SORTIE SCELLÉE finale qui exige les 4 objectifs personnels.
 *
 * ── Géométrie (refonte « grands niveaux ») ──
 * Chaque salle fait 64–84 tuiles de large pour 38–48 de haut (la caméra n'en montre qu'une fraction : à 1 joueur
 * ≈ 26×15 tuiles, à 4 ≈ 20×11) : grand hall + ailes + couloirs de 3 tuiles + alcôves, piliers en grille, fosses
 * en îlots. Les layouts sont GÉNÉRÉS de façon déterministe par la classe locale `Canvas` (rectangles creusés,
 * couloirs « lane », piliers, fosses) puis lus comme de simples `string[]` alignés. Les éléments d'une même
 * épreuve (plaques, clés, leviers) sont écartés aux extrémités opposées de la salle ; des panneaux guident.
 *
 * ── Ennemis ──
 * Le nombre d'ennemis ne dépend QUE du nombre de joueurs, via `minPlayers` (jamais de la difficulté) :
 * `scaled()` répartit un motif 60 % / 15 % / 15 % / 10 % (≥ 1 joueur / ≥ 2 / ≥ 3 / 4) sur toute la liste, de sorte
 * qu'à 1 joueur il reste ≈ 60 % des ennemis d'une partie à 4. Tous les ennemis sont à ≥ 12 tuiles de l'arrivée.
 *
 * Slots (couleurs) : 0 bleu, 1 rouge, 2 vert, 3 jaune → joueur `slot % nbJoueurs`.
 *
 * Coop adaptative : plaques/clés/portes/ennemis à `minPlayers` croissants ; les leviers à fenêtre
 * (`windowMs`) s'élargissent tout seuls quand un joueur doit en actionner plusieurs.
 *
 * Aucune chaîne affichée ici : uniquement des clés i18n (src/i18n/parts/level1.*.json).
 * Convention de tuiles : `[colonne, ligne]`. Glyphes : '#' mur, 'o' pilier, '~' fosse, '.'/',' sol.
 *
 * Objectifs personnels (un par slot, répartis dans le niveau, tous exigés par la sortie finale) :
 *   slot 0 `o_key`   (salle cells)       ouvrir sa porte avec sa clé ;
 *   slot 3 `o_kills` (salle ossuary)     vaincre 2 ennemis ;
 *   slot 2 `o_lever` (salle antechamber) actionner son levier ;
 *   slot 1 `o_zone`  (salle seal)        tenir le cercle du sceau 6 s.
 * Chaque salle qui porte un objectif l'exige dans `exit.requires` (sauf la dernière, dont la sortie scellée
 * exige les quatre) : aucun objectif ne peut être « raté » (on ne revient jamais en arrière).
 * Limite connue du moteur : si TOUS les ennemis de l'ossuaire meurent alors que le propriétaire de `o_kills`
 * n'a pas ses 2 coups fatals, l'objectif ne peut plus progresser (le HUD affiche sa progression ; une défaite
 * collective relance la salle). Plus de 30 ennemis à 4 joueurs pour 2 coups fatals requis rendent ce cas improbable.
 */

import type { DecorDef, DoorDef, EnemyKind, EnemySpawnDef, KeyDef, LevelDef, MechanismDef, RoomDef, TileXY } from '../core/types';

// ───────────────────────────── Générateur de géométrie ─────────────────────────────

/** Canevas de salle : tout est mur au départ ; on creuse des rectangles, des couloirs, on sème piliers et fosses. */
class Canvas {
  readonly cells: string[][];
  /** Tuiles à ne pas obstruer par un pilier/une fosse (couloirs, abords des éléments de jeu). */
  private readonly avoid = new Set<number>();
  /** Tuiles occupées par un élément de jeu (aucun décor posé dessus). */
  private readonly taken = new Set<number>();

  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.cells = Array.from({ length: h }, () => Array<string>(w).fill('#'));
  }

  private key(x: number, y: number): number {
    return y * this.w + x;
  }

  /** Creuse un rectangle de sol (jamais sur le cadre extérieur). */
  floor(x: number, y: number, w: number, h: number, ch = '.'): void {
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        if (xx >= 1 && xx < this.w - 1 && yy >= 1 && yy < this.h - 1) this.cells[yy][xx] = ch;
      }
    }
  }

  /** Couloir / passage : sol creusé + abords protégés (aucun pilier ni fosse n'y sera posé). */
  lane(x: number, y: number, w: number, h: number): void {
    this.floor(x, y, w, h);
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.avoidAround(xx, yy);
  }

  private avoidAround(x: number, y: number): void {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) this.avoid.add(this.key(x + dx, y + dy));
  }

  /** Réserve des tuiles d'éléments de jeu (pas de décor dessus, pas de pilier/fosse à côté). */
  reserve(tiles: Iterable<TileXY>): void {
    for (const [x, y] of tiles) {
      this.taken.add(this.key(x, y));
      this.avoidAround(x, y);
    }
  }

  /** Réserve toutes les tuiles d'un rectangle. */
  reserveRect(x: number, y: number, w: number, h: number): void {
    const tiles: TileXY[] = [];
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) tiles.push([xx, yy]);
    this.reserve(tiles);
  }

  isFloor(x: number, y: number): boolean {
    const g = this.cells[y]?.[x];
    return g === '.' || g === ',';
  }

  /** Grille de piliers : une tuile tous les `sx`/`sy`, uniquement sur du sol libre. */
  pillars(x: number, y: number, w: number, h: number, sx: number, sy: number): void {
    for (let yy = y; yy < y + h; yy += sy) {
      for (let xx = x; xx < x + w; xx += sx) {
        if (this.cells[yy]?.[xx] === '.' && !this.avoid.has(this.key(xx, yy))) this.cells[yy][xx] = 'o';
      }
    }
  }

  /** Fosse rectangulaire (îlot au milieu d'un hall : on la contourne toujours). */
  pit(x: number, y: number, w: number, h: number): void {
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        if (this.cells[yy]?.[xx] === '.' && !this.avoid.has(this.key(xx, yy))) this.cells[yy][xx] = '~';
      }
    }
  }

  /** Dalle décorative (glyphe ',') sur le sol ordinaire. */
  patch(x: number, y: number, w: number, h: number): void {
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) if (this.cells[yy]?.[xx] === '.') this.cells[yy][xx] = ',';
    }
  }

  /** Décors posés au sol (ignorés s'ils tombent sur un mur, un pilier, une fosse ou un élément de jeu). */
  props(type: DecorDef['type'], tiles: TileXY[]): DecorDef[] {
    const out: DecorDef[] = [];
    for (const [x, y] of tiles) {
      if (!this.isFloor(x, y) || this.taken.has(this.key(x, y))) continue;
      this.taken.add(this.key(x, y));
      out.push({ type, tile: [x, y] });
    }
    return out;
  }

  /** Torches / bannières accrochées aux murs qui font face au sud (tous les `every` colonnes). */
  wallDecor(type: 'torch' | 'banner', every: number, phase: number): DecorDef[] {
    const out: DecorDef[] = [];
    for (let x = phase; x < this.w - 1; x += every) {
      for (let y = 0; y < this.h - 1; y++) {
        if (this.cells[y][x] === '#' && this.isFloor(x, y + 1)) out.push({ type, tile: [x, y] });
      }
    }
    return out;
  }

  rows(): string[] {
    return this.cells.map((r) => r.join(''));
  }
}

/** Ennemi à placer (avant répartition par nombre de joueurs). */
interface FoeSpec {
  kind: EnemyKind;
  x: number;
  y: number;
}

const GROUP_OFFSETS: readonly TileXY[] = [
  [0, 0], [2, 0], [-2, 0], [0, 2], [0, -2], [2, 2], [-2, -2], [2, -2], [-2, 2], [4, 0],
];

/** Petit groupe de `n` ennemis du même type autour de `(x, y)`. */
function grp(kind: EnemyKind, x: number, y: number, n = 2): FoeSpec[] {
  return GROUP_OFFSETS.slice(0, n).map(([dx, dy]) => ({ kind, x: x + dx, y: y + dy }));
}

/** Motif (20 cases) de `minPlayers` : 12 × 1, 3 × 2, 3 × 3, 2 × 4 → 60 % / 75 % / 90 % / 100 %. */
const MIN_PLAYERS_PATTERN: readonly number[] = [1, 1, 2, 1, 1, 3, 1, 1, 2, 1, 4, 1, 1, 3, 2, 1, 1, 3, 1, 4];

/**
 * Convertit des ennemis en `EnemySpawnDef` en répartissant les `minPlayers` (indice × 7 mod 20 : motif étalé sur
 * toute la liste, donc sur toute la salle). Ne dépend que du nombre de joueurs, jamais de la difficulté.
 */
function scaled(specs: FoeSpec[], extra: Partial<Pick<EnemySpawnDef, 'wave' | 'when'>> = {}, phase = 0): EnemySpawnDef[] {
  return specs.map((s, i) => {
    const mp = MIN_PLAYERS_PATTERN[((i + phase) * 7) % MIN_PLAYERS_PATTERN.length];
    const def: EnemySpawnDef = { kind: s.kind, tile: [s.x, s.y], ...extra };
    if (mp > 1) def.minPlayers = mp;
    return def;
  });
}

const tilesOf = (foes: EnemySpawnDef[]): TileXY[] => foes.map((f) => f.tile);

// ───────────────────────────── Aides de mécanismes ─────────────────────────────

/** Nombre de joueurs à partir duquel la clé/porte du slot `slot` existe « pour de vrai » (slot 0 → dès 1 joueur). */
function minPlayersForSlot(slot: number): number {
  return slot + 1;
}

/**
 * Paire clé personnelle + porte à clé pour un slot (la clé et la porte partagent le même `minPlayers`
 * pour qu'elles soient neutralisées ensemble à moins de joueurs).
 */
function keyAndDoor(slot: number, keyTile: TileXY, doorTiles: TileXY[]): [KeyDef, DoorDef] {
  const minPlayers = minPlayersForSlot(slot);
  const key: KeyDef = {
    id: `k${slot}`,
    type: 'key',
    tile: keyTile,
    ownerSlot: slot,
    doorId: `kd${slot}`,
    minPlayers,
    labelKey: `mech.level1.k${slot}`,
  };
  const door: DoorDef = {
    id: `kd${slot}`,
    type: 'door',
    tiles: doorTiles,
    requires: [],
    keyId: key.id,
    minPlayers,
    labelKey: `mech.level1.kd${slot}`,
  };
  return [key, door];
}

/** Fenêtre (ms) des leviers de l'antichambre : traversée la plus longue de la salle + large marge. */
const ANTECHAMBER_WINDOW_MS = 24000;

/** Levier assigné à un slot, à fenêtre (doit être actionné « à peu près en même temps » que les autres). */
function slotLever(slot: number, tile: TileXY): MechanismDef {
  return {
    id: `lev${slot}`,
    type: 'lever',
    tile,
    ownerSlot: slot,
    windowMs: ANTECHAMBER_WINDOW_MS,
    labelKey: `mech.level1.lev${slot}`,
  };
}

/** Trois tuiles verticales d'une porte à travers un mur épais (`x` fixe, `y0..y0+2`). */
function doorColumn(x: number, y0: number): TileXY[] {
  return [[x, y0], [x, y0 + 1], [x, y0 + 2]];
}

// ───────────────────────────── Salle 1 : le vestibule (64×38) ─────────────────────────────
// Résolution : tous traversent le grand hall de gauche jusqu'à l'aile nord et actionnent le levier `lv1`
// ([27,3], panneau s_lever au débouché du couloir nord) → la herse `d1` (passage [31,18]-[31,20], couloir de
// 3 tuiles entre les deux halls) s'ouvre définitivement ; on vainc les limons/chauves-souris restants (exit
// `clear`, la moitié est derrière la herse) puis tous les héros vivants rejoignent la zone de sortie, à l'est du
// hall de droite. Le levier est accessible dès le spawn (hall → couloir nord → aile nord, rien à franchir).
// 1 joueur : 12 ennemis ; 4 joueurs : 19.

function buildVestibule(): RoomDef {
  const spawns: TileXY[] = [[3, 19], [4, 19], [3, 20], [4, 20]];
  const foes = scaled([
    ...grp('slime', 16, 22), ...grp('bat', 26, 12), ...grp('bat', 8, 34), ...grp('bat', 14, 3), ...grp('slime', 24, 4, 1),
    ...grp('slime', 42, 14), ...grp('bat', 52, 12), ...grp('slime', 46, 26), ...grp('bat', 40, 35), ...grp('bat', 54, 4),
  ]);
  const signs: RoomDef['signs'] = [
    { id: 's_move', tile: [7, 19], textKey: 'sign.level1.s_move' },
    { id: 's_attack', tile: [10, 19], textKey: 'sign.level1.s_attack' },
    { id: 's_lever', tile: [24, 10], textKey: 'sign.level1.s_lever' },
  ];
  const mechanisms: MechanismDef[] = [
    { id: 'lv1', type: 'lever', tile: [27, 3], labelKey: 'mech.level1.lv1' },
    { id: 'd1', type: 'door', tiles: doorColumn(31, 18), requires: ['lv1'], labelKey: 'mech.level1.d1' },
  ];
  const exit = { x: 58, y: 17, w: 3, h: 5 };

  const c = new Canvas(64, 38);
  c.reserve(spawns);
  c.reserve(tilesOf(foes));
  c.reserve(signs.map((s) => s.tile));
  c.reserve([[27, 3], ...doorColumn(31, 18)]);
  c.reserveRect(exit.x, exit.y, exit.w, exit.h);
  // Hall de gauche + aile nord + aile sud
  c.floor(2, 9, 28, 22);
  c.floor(3, 2, 27, 5);
  c.lane(8, 7, 3, 2);
  c.lane(21, 7, 3, 2);
  c.floor(3, 33, 27, 4);
  c.lane(10, 31, 3, 2);
  c.lane(23, 31, 3, 2);
  // Couloir de la herse
  c.lane(30, 18, 3, 3);
  // Hall de droite + ailes
  c.floor(33, 9, 29, 22);
  c.floor(34, 2, 27, 5);
  c.lane(40, 7, 3, 2);
  c.lane(54, 7, 3, 2);
  c.floor(34, 33, 27, 4);
  c.lane(40, 31, 3, 2);
  c.lane(54, 31, 3, 2);
  c.patch(6, 28, 8, 2);
  c.patch(46, 11, 8, 2);
  c.pillars(6, 11, 24, 18, 6, 5);
  c.pillars(36, 11, 24, 18, 6, 5);

  return {
    id: 'vestibule',
    nameKey: 'room.level1.vestibule.name',
    theme: 'crypt',
    layout: c.rows(),
    playerSpawns: spawns,
    enemies: foes,
    mechanisms,
    signs,
    decor: [
      ...c.wallDecor('torch', 11, 6),
      ...c.wallDecor('banner', 17, 12),
      ...c.props('statue', [[3, 10], [28, 10], [3, 29], [28, 29], [34, 10], [60, 10], [34, 29], [60, 29]]),
      ...c.props('crate', [[4, 35], [6, 35], [5, 34], [28, 35], [58, 35], [56, 35], [36, 4]]),
      ...c.props('bones', [[11, 34], [20, 35], [50, 4], [47, 35], [40, 22], [14, 26]]),
    ],
    exit: { rect: exit, requires: ['d1', 'clear'] },
    introHintKey: 'hintroom.level1.vestibule',
  };
}

// ───────────────────────────── Salle 2 : la salle des plaques (76×42) ─────────────────────────────
// Résolution : le héros bleu monte dans l'aile nord et se tient sur la plaque A ([5,4], extrémité ouest) ; le
// héros rouge descend dans l'aile sud, jusqu'à la plaque B ([34,37], extrémité est) : ~45 tuiles les séparent ;
// à l'instant où les deux sont pressées, la porte `d2` ([39,20]-[39,22], couloir de 3 tuiles) s'ouvre pour toujours.
// En solo la plaque B est neutralisée (minPlayers 2) : la plaque A seule suffit (le joueur s'y tient un instant).
// 3-4 joueurs : les autres surveillent les ennemis. Des ennemis apparaissent derrière la porte à son ouverture
// (`when: 'd2'`). Ensuite : zone de sortie à l'est du grand hall de droite.

function buildPlates(): RoomDef {
  const spawns: TileXY[] = [[3, 20], [4, 20], [3, 21], [4, 21]];
  const foes = [
    ...scaled([
      ...grp('slime', 18, 14), ...grp('bat', 30, 16), ...grp('slime', 18, 27), ...grp('bat', 30, 26),
      ...grp('slime', 8, 36), ...grp('bat', 22, 4),
    ]),
    ...scaled(
      [
        ...grp('bat', 50, 13), ...grp('slime', 58, 20), ...grp('bat', 50, 28), ...grp('slime', 62, 12),
        ...grp('slime', 62, 30), ...grp('bat', 56, 4), ...grp('bat', 56, 37),
      ],
      { when: 'd2' },
      3,
    ),
  ];
  const signs: RoomDef['signs'] = [
    { id: 's_plates', tile: [7, 21], textKey: 'sign.level1.s_plates' },
    { id: 's_plateA', tile: [8, 4], textKey: 'sign.level1.s_plateA' },
    { id: 's_plateB', tile: [31, 37], textKey: 'sign.level1.s_plateB' },
  ];
  const mechanisms: MechanismDef[] = [
    { id: 'pA', type: 'plate', tile: [5, 4], colorSlot: 0, labelKey: 'mech.level1.pA' },
    { id: 'pB', type: 'plate', tile: [34, 37], colorSlot: 1, minPlayers: 2, labelKey: 'mech.level1.pB' },
    { id: 'd2', type: 'door', tiles: doorColumn(39, 20), requires: ['pA', 'pB'], labelKey: 'mech.level1.d2' },
  ];
  const exit = { x: 70, y: 19, w: 3, h: 5 };

  const c = new Canvas(76, 42);
  c.reserve(spawns);
  c.reserve(tilesOf(foes));
  c.reserve(signs.map((s) => s.tile));
  c.reserve([[5, 4], [34, 37], ...doorColumn(39, 20)]);
  c.reserveRect(exit.x, exit.y, exit.w, exit.h);
  // Chambre de gauche : grand hall, aile nord (plaque A), aile sud (plaque B)
  c.floor(2, 10, 36, 22);
  c.floor(3, 2, 34, 6);
  c.lane(10, 8, 3, 2);
  c.lane(28, 8, 3, 2);
  c.floor(3, 34, 34, 6);
  c.lane(10, 32, 3, 2);
  c.lane(28, 32, 3, 2);
  // Couloir de la porte à plaques
  c.lane(38, 20, 3, 3);
  // Chambre de droite : grand hall + alcôves
  c.floor(41, 8, 33, 26);
  c.floor(48, 2, 20, 5);
  c.lane(54, 7, 3, 1);
  c.floor(48, 35, 20, 5);
  c.lane(54, 34, 3, 1);
  c.pit(18, 19, 4, 3);
  c.patch(3, 3, 5, 3);
  c.patch(31, 35, 5, 4);
  c.pillars(6, 12, 30, 18, 6, 5);
  c.pillars(44, 10, 28, 22, 6, 5);

  return {
    id: 'plates',
    nameKey: 'room.level1.plates.name',
    theme: 'crypt',
    layout: c.rows(),
    playerSpawns: spawns,
    enemies: foes,
    mechanisms,
    signs,
    decor: [
      ...c.wallDecor('torch', 11, 7),
      ...c.wallDecor('banner', 17, 14),
      ...c.props('statue', [[3, 11], [36, 11], [3, 30], [36, 30], [42, 9], [72, 9], [42, 32], [72, 32]]),
      ...c.props('crate', [[4, 2], [6, 2], [4, 38], [36, 36], [50, 3], [66, 3], [66, 38]]),
      ...c.props('bones', [[12, 4], [24, 36], [15, 24], [52, 20], [60, 26], [64, 5]]),
    ],
    exit: { rect: exit, requires: ['d2'] },
    introHintKey: 'hintroom.level1.plates',
  };
}

// ───────────────────────────── Salle 3 : les cellules (80×48) ─────────────────────────────
// Résolution : le hall central est gardé par des squelettes (embuscade) ; avec 2+ joueurs quelqu'un tombe
// probablement : un allié vivant s'approche et maintient Action ~3 s (panneau s_revive). Chaque héros
// ramasse SA clé en marchant dessus — chacune dort dans une aile différente (k0 [5,4] aile nord-ouest,
// k1 [5,43] sud-ouest, k2 [33,3] nord-est, k3 [50,44] sud-est ; panneau s_wings) — puis appuie sur Action devant
// SA porte du grand mur est (kd0 lignes 4-6, kd1 lignes 16-18, kd2 lignes 29-31, kd3 lignes 40-42 ; couloirs de
// 3 tuiles). La clé est consommée, la porte reste ouverte. 1 joueur : seule k0/kd0 existe (les 3 autres portes sont
// neutralisées = ouvertes) ; 2 joueurs : k0/k1 ; 3 : k0..k2 ; 4 : toutes. La sortie, dans la salle à l'est,
// exige les 4 portes (les neutralisées comptent). Les clés sont sur des tuiles dégagées, loin des portes.
// 1 joueur : 17 squelettes ; 4 joueurs : 28.

function buildCells(): RoomDef {
  const [k0, kd0] = keyAndDoor(0, [5, 4], doorColumn(55, 4));
  const [k1, kd1] = keyAndDoor(1, [5, 43], doorColumn(55, 16));
  const [k2, kd2] = keyAndDoor(2, [33, 3], doorColumn(55, 29));
  const [k3, kd3] = keyAndDoor(3, [50, 44], doorColumn(55, 40));
  const spawns: TileXY[] = [[3, 23], [4, 23], [3, 24], [4, 24]];
  const foes = scaled([
    // hall central
    ...grp('skeleton', 20, 18), ...grp('skeleton', 38, 18), ...grp('skeleton', 20, 29), ...grp('skeleton', 38, 29),
    ...grp('skeleton', 46, 23),
    // ailes
    ...grp('skeleton', 14, 6), ...grp('skeleton', 36, 6), ...grp('skeleton', 47, 7), ...grp('skeleton', 14, 41),
    ...grp('skeleton', 36, 41), ...grp('skeleton', 46, 41),
    // salle de l'est (derrière les portes)
    ...grp('skeleton', 62, 10), ...grp('skeleton', 62, 36), ...grp('skeleton', 68, 23),
  ]);
  const signs: RoomDef['signs'] = [
    { id: 's_wings', tile: [9, 22], textKey: 'sign.level1.s_wings' },
    { id: 's_revive', tile: [14, 24], textKey: 'sign.level1.s_revive' },
    { id: 's_keys', tile: [50, 24], textKey: 'sign.level1.s_keys' },
  ];
  const mechanisms: MechanismDef[] = [k0, k1, k2, k3, kd0, kd1, kd2, kd3];
  const exit = { x: 73, y: 20, w: 4, h: 7 };

  const c = new Canvas(80, 48);
  c.reserve(spawns);
  c.reserve(tilesOf(foes));
  c.reserve(signs.map((s) => s.tile));
  c.reserve([k0.tile, k1.tile, k2.tile, k3.tile, ...kd0.tiles, ...kd1.tiles, ...kd2.tiles, ...kd3.tiles]);
  c.reserveRect(exit.x, exit.y, exit.w, exit.h);
  // Vestibule d'arrivée + grand hall central
  c.floor(2, 19, 6, 10);
  c.floor(6, 14, 48, 20);
  // Quatre ailes (une clé chacune)
  c.floor(3, 2, 22, 9);
  c.lane(12, 11, 3, 3);
  c.floor(30, 2, 24, 9);
  c.lane(40, 11, 3, 3);
  c.floor(3, 37, 22, 9);
  c.lane(12, 34, 3, 3);
  c.floor(30, 37, 24, 9);
  c.lane(40, 34, 3, 3);
  // Mur des portes (x 54-56) : quatre couloirs de 3 tuiles
  c.lane(54, 4, 3, 3);
  c.lane(54, 16, 3, 3);
  c.lane(54, 29, 3, 3);
  c.lane(54, 40, 3, 3);
  // Salle de l'est
  c.floor(57, 2, 21, 44);
  c.pit(28, 22, 6, 4);
  c.patch(24, 19, 14, 2);
  c.patch(24, 27, 14, 2);
  c.pillars(10, 16, 42, 16, 6, 5);
  c.pillars(6, 4, 18, 6, 6, 4);
  c.pillars(32, 4, 20, 6, 6, 4);
  c.pillars(6, 39, 18, 6, 6, 4);
  c.pillars(32, 39, 20, 6, 6, 4);
  c.pillars(60, 4, 14, 40, 6, 5);

  return {
    id: 'cells',
    nameKey: 'room.level1.cells.name',
    theme: 'crypt',
    layout: c.rows(),
    playerSpawns: spawns,
    enemies: foes,
    mechanisms,
    signs,
    decor: [
      ...c.wallDecor('torch', 11, 6),
      ...c.wallDecor('banner', 17, 11),
      ...c.props('statue', [[8, 15], [52, 15], [8, 32], [52, 32], [58, 3], [76, 3], [58, 44], [76, 44]]),
      ...c.props('crate', [[3, 3], [4, 3], [3, 44], [24, 44], [52, 44], [52, 3], [24, 3]]),
      ...c.props('bones', [[16, 22], [26, 30], [44, 18], [9, 40], [48, 8], [66, 22], [70, 30]]),
    ],
    exit: { rect: exit, requires: ['kd0', 'kd1', 'kd2', 'kd3'] },
    introHintKey: 'hintroom.level1.cells',
  };
}

// ───────────────────────────── Salle 4 : l'ossuaire (84×46) ─────────────────────────────
// Résolution : un long couloir mène du vestibule d'arrivée à l'arène centrale ; tous convergent vers le levier
// `lv4` ([28,23], bord ouest de l'arène) et l'actionnent : quatre vagues d'ennemis se réveillent autour de la
// grande fosse (`when: 'lv4'`, vague k+1 quand la vague k est vaincue). On les bat ; le propriétaire du slot 3
// (objectif `o_kills`, 2 coups fatals) doit porter au moins 2 coups : panneau s_kills. Des sentinelles (vague 0,
// sans condition) rôdent dans les ailes nord/sud et la salle de l'est : elles font partie de la vague 0 (les
// vagues suivantes attendent leur défaite) et comptent dans `clear`. Quand tout est vaincu (`clear`) et
// l'objectif accompli, tous rejoignent la sortie, à l'extrémité est de la grande salle de droite ([77,20]).
// Ennemis : 21 à 1 joueur, 35 à 4. Fosses + piliers : on contourne, jamais coincé.
// SALLE SOMBRE (première du jeu) : chaque héros a une torche qui s'use (panneau s_torch, brasero allumé `br_start`
// juste à côté du départ). Braseros allumés = recharge (action à côté) et lumière permanente : départ, levier
// (`br_lever`), arène est (`br_east`), salle de sortie (`br_exit`) ; décors torch près du levier et de la sortie.
// Les 3 braseros éteints (ailes, alcôve) sont facultatifs (ambiance/récompense), jamais exigés.

function buildOssuary(): RoomDef {
  const spawns: TileXY[] = [[3, 22], [4, 22], [3, 23], [4, 23]];
  const sentinels = scaled(
    [
      { kind: 'slime', x: 20, y: 8 }, { kind: 'bat', x: 26, y: 6 }, { kind: 'slime', x: 20, y: 37 },
      { kind: 'bat', x: 26, y: 39 }, { kind: 'skeleton', x: 72, y: 18 }, { kind: 'skeleton', x: 72, y: 28 },
      { kind: 'bat', x: 76, y: 14 }, { kind: 'slime', x: 70, y: 5 }, { kind: 'slime', x: 70, y: 40 },
    ],
    {},
    2,
  );
  const wave = (k: number, specs: FoeSpec[]): EnemySpawnDef[] => scaled(specs, { wave: k, when: 'lv4' }, k * 3);
  const w0 = wave(0, [
    { kind: 'slime', x: 33, y: 15 }, { kind: 'slime', x: 33, y: 31 }, { kind: 'bat', x: 36, y: 18 },
    { kind: 'bat', x: 36, y: 28 }, { kind: 'slime', x: 32, y: 19 }, { kind: 'slime', x: 32, y: 27 },
    { kind: 'bat', x: 35, y: 23 },
  ]);
  const w1 = wave(1, [
    { kind: 'skeleton', x: 34, y: 12 }, { kind: 'skeleton', x: 34, y: 34 }, { kind: 'bat', x: 40, y: 14 },
    { kind: 'bat', x: 40, y: 32 }, { kind: 'slime', x: 31, y: 16 }, { kind: 'slime', x: 31, y: 30 },
    { kind: 'skeleton', x: 37, y: 23 }, { kind: 'bat', x: 33, y: 23 },
  ]);
  const w2 = wave(2, [
    { kind: 'skeleton', x: 30, y: 13 }, { kind: 'skeleton', x: 30, y: 33 }, { kind: 'bat', x: 36, y: 12 },
    { kind: 'bat', x: 36, y: 34 }, { kind: 'slime', x: 34, y: 17 }, { kind: 'slime', x: 34, y: 29 },
    { kind: 'skeleton', x: 36, y: 20 }, { kind: 'skeleton', x: 36, y: 26 },
  ]);
  const w3 = wave(3, [
    { kind: 'skeleton', x: 32, y: 11 }, { kind: 'skeleton', x: 32, y: 35 }, { kind: 'skeleton', x: 35, y: 21 },
    { kind: 'skeleton', x: 35, y: 25 }, { kind: 'bat', x: 37, y: 16 }, { kind: 'bat', x: 37, y: 30 },
  ]);
  const foes = [...sentinels, ...w0, ...w1, ...w2, ...w3];
  const signs: RoomDef['signs'] = [
    { id: 's_torch', tile: [6, 22], textKey: 'sign.level1.s_torch' },
    { id: 's_waves', tile: [25, 21], textKey: 'sign.level1.s_waves' },
    { id: 's_kills', tile: [29, 25], textKey: 'sign.level1.s_kills' },
    { id: 's_unlit', tile: [27, 27], textKey: 'sign.level1.s_unlit' },
  ];
  // Torches : 4 braseros ALLUMÉS (points de recharge : départ, levier, arène est, salle de sortie) et 3 braseros
  // ÉTEINTS facultatifs (ailes nord/sud, alcôve est) : aucune condition de progression ne dépend d'eux.
  const lit = (id: string, tile: TileXY): MechanismDef => ({ id, type: 'brazier', tile, lit: true, labelKey: 'mech.level1.br_lit' });
  const unlit = (id: string, tile: TileXY): MechanismDef => ({ id, type: 'brazier', tile, labelKey: 'mech.level1.br_unlit', litLabelKey: 'mech.level1.br_lit' });
  const braziers: MechanismDef[] = [
    lit('br_start', [6, 20]), lit('br_lever', [26, 26]), lit('br_east', [52, 24]), lit('br_exit', [69, 18]),
    unlit('br_n', [29, 8]), unlit('br_s', [29, 38]), unlit('br_alcove', [75, 5]),
  ];
  const mechanisms: MechanismDef[] = [{ id: 'lv4', type: 'lever', tile: [28, 23], labelKey: 'mech.level1.lv4' }, ...braziers];
  const exit = { x: 77, y: 20, w: 4, h: 6 };

  const c = new Canvas(84, 46);
  c.reserve(spawns);
  c.reserve(tilesOf(foes));
  c.reserve(signs.map((s) => s.tile));
  c.reserve([[28, 23]]);
  c.reserve(braziers.flatMap((m) => (m.type === 'brazier' ? [m.tile] : [])));
  c.reserveRect(exit.x, exit.y, exit.w, exit.h);
  // Vestibule d'arrivée, couloir, ailes nord/sud
  c.floor(2, 18, 10, 10);
  c.lane(12, 22, 12, 3);
  c.floor(8, 4, 24, 10);
  c.lane(8, 14, 3, 4);
  c.floor(8, 32, 24, 10);
  c.lane(8, 28, 3, 4);
  // Arène centrale
  c.floor(24, 10, 36, 26);
  // Passage vers l'est + grande salle de sortie + alcôves
  c.lane(60, 22, 6, 3);
  c.floor(66, 12, 16, 22);
  c.floor(62, 2, 18, 7);
  c.lane(70, 9, 3, 3);
  c.floor(62, 37, 18, 7);
  c.lane(70, 34, 3, 3);
  c.pit(38, 19, 8, 8);
  c.pit(16, 6, 4, 3);
  c.pit(16, 36, 4, 3);
  c.patch(48, 14, 8, 2);
  c.patch(48, 30, 8, 2);
  c.pillars(26, 12, 32, 22, 6, 5);
  c.pillars(10, 5, 20, 8, 6, 4);
  c.pillars(10, 33, 20, 8, 6, 4);
  c.pillars(68, 14, 12, 18, 6, 5);

  return {
    id: 'ossuary',
    nameKey: 'room.level1.ossuary.name',
    theme: 'crypt',
    dark: true,
    layout: c.rows(),
    playerSpawns: spawns,
    enemies: foes,
    mechanisms,
    signs,
    decor: [
      ...c.wallDecor('torch', 11, 5),
      ...c.wallDecor('banner', 17, 9),
      ...c.props('statue', [[3, 19], [3, 26], [26, 11], [58, 11], [26, 34], [58, 34], [68, 13], [80, 32]]),
      ...c.props('crate', [[63, 3], [78, 3], [63, 42], [78, 42], [9, 5], [9, 40]]),
      ...c.props('bones', [[48, 16], [48, 30], [14, 10], [14, 36], [72, 24], [66, 6], [66, 40], [30, 20]]),
      ...c.props('torch', [[10, 19], [10, 26], [24, 22], [24, 24], [58, 22], [58, 25], [76, 22], [76, 25]]),
    ],
    exit: { rect: exit, requires: ['lv4', 'clear', 'obj:o_kills'] },
    introHintKey: 'hintroom.level1.ossuary',
  };
}

// ───────────────────────────── Salle 5 : l'antichambre (76×44) ─────────────────────────────
// Résolution : quatre leviers dans les quatre ailes du grand hall — NO [6,4] (lev0), SO [6,39] (lev1),
// SE [66,39] (lev2), NE [66,4] (lev3) —, chacun réservé à un slot (couleur) et à fenêtre de 24 s. Chaque héros
// court à son levier (panneau s_levers au départ) et appuie sur Action : quand les 4 sont actifs en même temps,
// la porte `d5` ([65,20]-[65,22], couloir de 3 tuiles à l'est du hall) s'ouvre pour toujours.
// Fenêtre effective = 24 s × ceil(4 / nbJoueurs) : 4 joueurs → 24 s (arrivées étalées par la distance : jusqu'à
// ~17 s d'écart) ; 2-3 joueurs → 48 s (un joueur enchaîne 2 coins opposés, ~100 tuiles ≈ 30 s) ; 1 joueur → 96 s
// pour faire le tour des 4 coins (~130 tuiles ≈ 40 s). L'objectif `o_lever` (slot 2) est accompli dès que son
// levier est actionné. Fosse centrale contournable ; les leviers sont au fond d'ailes dégagées.
// 1 joueur : 15 ennemis ; 4 joueurs : 24.

function buildAntechamber(): RoomDef {
  const spawns: TileXY[] = [[3, 21], [4, 21], [3, 22], [4, 22]];
  const foes = scaled([
    ...grp('skeleton', 18, 14), ...grp('bat', 30, 14), ...grp('skeleton', 42, 13), ...grp('slime', 18, 29),
    ...grp('skeleton', 30, 29), ...grp('bat', 44, 29), ...grp('slime', 56, 15), ...grp('skeleton', 56, 28),
    ...grp('bat', 16, 4), ...grp('slime', 16, 39), ...grp('bat', 56, 4), ...grp('slime', 56, 39),
  ]);
  const signs: RoomDef['signs'] = [{ id: 's_levers', tile: [12, 22], textKey: 'sign.level1.s_levers' }];
  const levers: TileXY[] = [[6, 4], [6, 39], [66, 39], [66, 4]];
  const mechanisms: MechanismDef[] = [
    slotLever(0, levers[0]),
    slotLever(1, levers[1]),
    slotLever(2, levers[2]),
    slotLever(3, levers[3]),
    {
      id: 'd5',
      type: 'door',
      tiles: doorColumn(65, 20),
      requires: ['lev0', 'lev1', 'lev2', 'lev3'],
      labelKey: 'mech.level1.d5',
    },
  ];
  const exit = { x: 71, y: 18, w: 3, h: 8 };

  const c = new Canvas(76, 44);
  c.reserve(spawns);
  c.reserve(tilesOf(foes));
  c.reserve(signs.map((s) => s.tile));
  c.reserve([...levers, ...doorColumn(65, 20)]);
  c.reserveRect(exit.x, exit.y, exit.w, exit.h);
  // Vestibule d'arrivée + grand hall central
  c.floor(2, 18, 8, 8);
  c.floor(10, 10, 54, 24);
  // Quatre ailes (un levier au fond de chacune)
  c.floor(3, 2, 20, 6);
  c.lane(12, 8, 3, 2);
  c.floor(3, 36, 20, 6);
  c.lane(12, 34, 3, 2);
  c.floor(50, 2, 20, 6);
  c.lane(58, 8, 3, 2);
  c.floor(50, 36, 20, 6);
  c.lane(58, 34, 3, 2);
  // Couloir de la grande porte + salle de sortie
  c.lane(64, 20, 3, 3);
  c.floor(67, 16, 8, 12);
  c.pit(28, 19, 8, 6);
  c.pit(46, 16, 4, 3);
  c.pit(46, 28, 4, 3);
  c.patch(5, 3, 4, 3);
  c.patch(5, 38, 4, 3);
  c.patch(65, 3, 4, 3);
  c.patch(65, 38, 4, 3);
  c.pillars(12, 12, 50, 20, 6, 5);

  return {
    id: 'antechamber',
    nameKey: 'room.level1.antechamber.name',
    theme: 'crypt',
    layout: c.rows(),
    playerSpawns: spawns,
    enemies: foes,
    mechanisms,
    signs,
    decor: [
      ...c.wallDecor('torch', 11, 8),
      ...c.wallDecor('banner', 17, 13),
      ...c.props('statue', [[11, 11], [62, 11], [11, 32], [62, 32], [68, 17], [68, 26], [10, 3], [60, 3]]),
      ...c.props('crate', [[4, 2], [21, 2], [4, 41], [21, 41], [68, 2], [68, 41], [51, 3]]),
      ...c.props('bones', [[24, 20], [40, 30], [52, 22], [20, 38], [20, 5], [54, 38]]),
    ],
    exit: { rect: exit, requires: ['d5'] },
    introHintKey: 'hintroom.level1.antechamber',
  };
}

// ───────────────────────────── Salle 6 : la salle du sceau (84×48) ─────────────────────────────
// Résolution : au centre de la grande nef, le cercle du sceau ([34,22]-[36,24]) autour de la plaque `pcirc`
// ([35,23]). Le propriétaire du slot 1 (objectif `o_zone`) s'y tient 6 s cumulées pendant que les autres le
// protègent ; dès qu'un héros marche sur la plaque, les gardiens apparaissent (`when: 'pcirc'`, 3 vagues :
// 7 à 8 ennemis à 4 joueurs chacune). Des sentinelles (vague 0, sans condition) rôdent dans les ailes nord/sud
// et les coins de la nef : les vagues 1+ attendent leur défaite, mais la sortie ne les exige pas. Les 3 autres
// objectifs ont été accomplis dans les salles précédentes (chaque sortie les exige) : quand `o_zone` est
// accompli, la SORTIE SCELLÉE finale ([76,18]), au bout du passage est, s'ouvre et tous la rejoignent pour
// terminer le niveau. En solo le joueur tient le cercle seul (cumul : il peut sortir du cercle pour se battre
// et y revenir). 1 joueur : 20 ennemis ; 4 joueurs : 34.

function buildSeal(): RoomDef {
  const spawns: TileXY[] = [[3, 23], [4, 23], [3, 24], [4, 24]];
  const sentinels = scaled(
    [
      { kind: 'bat', x: 22, y: 4 }, { kind: 'skeleton', x: 32, y: 4 }, { kind: 'bat', x: 44, y: 4 },
      { kind: 'slime', x: 22, y: 43 }, { kind: 'skeleton', x: 32, y: 43 }, { kind: 'bat', x: 44, y: 43 },
      { kind: 'skeleton', x: 18, y: 12 }, { kind: 'skeleton', x: 52, y: 12 }, { kind: 'skeleton', x: 18, y: 36 },
      { kind: 'skeleton', x: 52, y: 36 },
    ],
    {},
    1,
  );
  const guard = (k: number, specs: FoeSpec[]): EnemySpawnDef[] => scaled(specs, { wave: k, when: 'pcirc' }, k * 5);
  const g0 = guard(0, [
    { kind: 'bat', x: 26, y: 18 }, { kind: 'bat', x: 26, y: 28 }, { kind: 'skeleton', x: 44, y: 18 },
    { kind: 'skeleton', x: 44, y: 28 }, { kind: 'slime', x: 30, y: 23 }, { kind: 'bat', x: 40, y: 14 },
    { kind: 'bat', x: 40, y: 32 },
  ]);
  const g1 = guard(1, [
    { kind: 'skeleton', x: 28, y: 19 }, { kind: 'skeleton', x: 28, y: 27 }, { kind: 'slime', x: 42, y: 21 },
    { kind: 'slime', x: 42, y: 25 }, { kind: 'bat', x: 36, y: 16 }, { kind: 'bat', x: 36, y: 30 },
    { kind: 'skeleton', x: 24, y: 23 },
  ]);
  const g2 = guard(2, [
    { kind: 'skeleton', x: 30, y: 16 }, { kind: 'skeleton', x: 30, y: 30 }, { kind: 'skeleton', x: 40, y: 16 },
    { kind: 'skeleton', x: 40, y: 30 }, { kind: 'bat', x: 36, y: 12 }, { kind: 'bat', x: 36, y: 34 },
    { kind: 'slime', x: 26, y: 23 }, { kind: 'slime', x: 46, y: 23 },
  ]);
  const foes = [...sentinels, ...g0, ...g1, ...g2];
  const signs: RoomDef['signs'] = [
    { id: 's_seal', tile: [31, 22], textKey: 'sign.level1.s_seal' },
    { id: 's_exit', tile: [58, 20], textKey: 'sign.level1.s_exit' },
  ];
  const zone = { x: 34, y: 22, w: 3, h: 3 };
  const exit = { x: 76, y: 18, w: 4, h: 12 };

  const c = new Canvas(84, 48);
  c.reserve(spawns);
  c.reserve(tilesOf(foes));
  c.reserve(signs.map((s) => s.tile));
  c.reserve([[35, 23]]);
  c.reserveRect(zone.x - 1, zone.y - 1, zone.w + 2, zone.h + 2);
  c.reserveRect(exit.x, exit.y, exit.w, exit.h);
  // Vestibule d'arrivée + grande nef
  c.floor(2, 19, 9, 10);
  c.floor(10, 8, 50, 32);
  // Ailes nord et sud
  c.floor(14, 2, 40, 5);
  c.lane(20, 7, 3, 1);
  c.lane(46, 7, 3, 1);
  c.floor(14, 41, 40, 5);
  c.lane(20, 40, 3, 1);
  c.lane(46, 40, 3, 1);
  // Passage vers la sortie scellée
  c.lane(60, 22, 6, 3);
  c.floor(66, 14, 16, 20);
  c.pit(20, 30, 4, 3);
  c.pit(48, 30, 4, 3);
  c.pit(20, 14, 4, 3);
  c.pit(48, 14, 4, 3);
  c.patch(33, 21, 5, 5);
  c.pillars(12, 10, 46, 28, 6, 5);
  c.pillars(68, 16, 12, 16, 6, 5);

  return {
    id: 'seal',
    nameKey: 'room.level1.seal.name',
    theme: 'crypt',
    layout: c.rows(),
    playerSpawns: spawns,
    enemies: foes,
    mechanisms: [{ id: 'pcirc', type: 'plate', tile: [35, 23], colorSlot: 1, labelKey: 'mech.level1.pcirc' }],
    zones: [{ id: 'seal_circle', rect: zone }],
    signs,
    decor: [
      ...c.wallDecor('torch', 11, 7),
      ...c.wallDecor('banner', 17, 10),
      ...c.props('statue', [[3, 20], [3, 27], [12, 9], [58, 9], [12, 38], [58, 38], [68, 15], [68, 32]]),
      ...c.props('crystal', [[80, 15], [80, 32], [31, 20], [39, 26], [31, 26], [39, 20]]),
      ...c.props('bones', [[16, 24], [50, 20], [28, 12], [28, 34], [16, 4], [50, 44]]),
    ],
    exit: {
      rect: exit,
      requires: ['obj:o_key', 'obj:o_zone', 'obj:o_lever', 'obj:o_kills'],
      final: true,
      sealed: true,
    },
    introHintKey: 'hintroom.level1.seal',
  };
}

const vestibule = buildVestibule();
const plates = buildPlates();
const cells = buildCells();
const ossuary = buildOssuary();
const antechamber = buildAntechamber();
const seal = buildSeal();

// ───────────────────────────── Niveau ─────────────────────────────

/** Niveau 1 : « Les Cryptes Oubliées ». */
export const level1: LevelDef = {
  id: 'level1',
  nameKey: 'level.level1.name',
  theme: 'crypt',
  estimatedMinutes: 7,
  intro: [
    { speaker: 'narrator', textKey: 'level.level1.intro.1' },
    { speaker: 'aldric', textKey: 'level.level1.intro.2' },
    { speaker: 'aldric', textKey: 'level.level1.intro.3' },
    { speaker: 'heroes', textKey: 'level.level1.intro.4' },
  ],
  outro: [
    { speaker: 'narrator', textKey: 'level.level1.outro.1' },
    { speaker: 'lyssa', textKey: 'level.level1.outro.2' },
    { speaker: 'lyssa', textKey: 'level.level1.outro.3' },
    { speaker: 'heroes', textKey: 'level.level1.outro.4' },
  ],
  rooms: [vestibule, plates, cells, ossuary, antechamber, seal],
  objectives: [
    {
      id: 'o_key',
      slot: 0,
      roomId: 'cells',
      kind: 'mechanism',
      mechanismId: 'kd0',
      labelKey: 'objective.level1.o_key',
    },
    {
      id: 'o_zone',
      slot: 1,
      roomId: 'seal',
      kind: 'zone',
      zoneId: 'seal_circle',
      seconds: 6,
      labelKey: 'objective.level1.o_zone',
    },
    {
      id: 'o_lever',
      slot: 2,
      roomId: 'antechamber',
      kind: 'mechanism',
      mechanismId: 'lev2',
      labelKey: 'objective.level1.o_lever',
    },
    {
      id: 'o_kills',
      slot: 3,
      roomId: 'ossuary',
      kind: 'kills',
      count: 2,
      labelKey: 'objective.level1.o_kills',
    },
  ],
};
