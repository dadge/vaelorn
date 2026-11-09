/**
 * Niveau 4 — « Les Cavernes de Givre » (thème `frost`, 8 salles, ≈ 8 minutes).
 *
 * Le niveau de la STATUE JUMELLE (`statuePair`) : deux statues de glace identiques aux deux extrémités d'une caverne. Un héros
 * qui se tient sur le SOCLE d'une statue et appuie sur Action fait pivoter l'AUTRE statue d'un quart de tour (sens horaire) ;
 * quand les deux regardent la même direction (`targetDir`), le mécanisme est résolu pour toujours. Ce qu'on fait ici a donc un
 * effet LÀ-BAS : il faut qu'un partenaire regarde la statue lointaine et annonce ce qu'il voit (à 1 joueur : allers-retours).
 *
 * Rythme (alternance collectif / actions séparées / combat, nombreux ennemis, deux demi-boss, un boss de fin) :
 *  0. `threshold`  Le Seuil de Givre        APPRENTISSAGE CALME de la statue jumelle (2 ailes opposées, socles signalés)
 *  1. `gallery`    La Galerie des Stalactites plaques simultanées aux quatre coins, autour d'un lac gelé (combat)
 *  2. `echoes`     La Caverne des Échos     2e paire de statues PENDANT trois vagues d'ennemis + une zone à tenir
 *  3. `warden1`    L'Antre du Gardien       DEMI-BOSS n°1 (gardien de givre) et sa meute, arène pure (mi-parcours)
 *  4. `deepdark`   Les Profondeurs Aveugles salle SOMBRE : chaque héros allume SON brasero aux quatre coins d'un anneau
 *  5. `spire`      La Flèche de Givre       quatre leviers à fenêtre au bout des quatre bras d'une croix (action séparée)
 *  6. `antechamber`L'Antichambre du Trône   3e paire commandant LA PORTE DU BOSS + plaques + DEMI-BOSS n°2 et sa meute
 *  7. `throne`      Le Trône de la Reine     boss de fin : la Reine du Givre et sa garde (grossit avec n), sortie finale scellée
 *
 * ── Taille des salles ── de 64 à 84 tuiles de large et de 40 à 50 de haut : la caméra défile partout. Les layouts sont
 * générés par des fonctions locales déterministes (cavernes elliptiques, couloirs, lacs gelés, grilles de piliers de glace).
 *
 * Coop adaptative : tout est faisable de 1 à 4 joueurs.
 *  - plaques / leviers / braseros de couleur : `minPlayers` = slot + 1 (le slot k n'existe « pour de vrai » qu'à k+1 joueurs) ;
 *  - paires de statues : pas de `minPlayers` (en solo on fait des allers-retours entre les deux socles) ;
 *  - ennemis : leur nombre ne dépend QUE du nombre de joueurs (`minPlayers`), jamais de la difficulté ; à 1 joueur il y en a
 *    ≈ 52 % de ceux présents à 4 joueurs. Les demi-boss et le boss sont présents à tout n (sbires et garde de la Reine : `minPlayers`).
 *    Aucun ennemi à moins de 12 tuiles du point d'arrivée.
 *
 * Objectifs personnels (un par slot, types variés, répartis sur 4 salles) :
 *  - slot 0 (bleu)   `flame`  : mécanisme — allumer SON brasero dans les Profondeurs Aveugles ;
 *  - slot 1 (rouge)  `lever`  : mécanisme — tirer SON levier de la Flèche de Givre ;
 *  - slot 2 (vert)   `hold`   : zone — tenir le cairn 8 s dans la Caverne des Échos ;
 *  - slot 3 (jaune)  `slayer` : kills — 4 coups fatals dans l'Antre du Gardien.
 *  Chaque salle qui porte un objectif ne peut être quittée qu'une fois celui-ci accompli ; la sortie finale exige en plus la
 *  Reine vaincue (`clear`) et les quatre objectifs.
 *
 * Aucun verrou logique : chaque statue peut être tournée sans limite (4 appuis = retour au départ), les plaques et leviers se
 * refont après un redémarrage de salle (défaite collective = état recréé), les portes ouvertes le restent.
 *
 * Toutes les chaînes affichées sont des clés i18n (parts `src/i18n/parts/level4.{fr,en}.json`).
 */

import type {
  DecorDef,
  DialogueLine,
  EnemyKind,
  EnemySpawnDef,
  LevelDef,
  MechanismDef,
  ObjectiveDef,
  RoomDef,
  SignDef,
  TileRect,
  TileXY,
} from '../core/types';

// ───────────────────────────── Aides de construction ─────────────────────────────

/** Raccourci pour un rectangle de tuiles. */
function rect(x: number, y: number, w: number, h: number): TileRect {
  return { x, y, w, h };
}

/**
 * Constructeur de grille : on part d'un plein de murs et on « creuse » des rectangles et des cavernes elliptiques de sol.
 * Déterministe : aucune part d'aléatoire.
 */
class LayoutBuilder {
  private readonly cells: string[][];
  private readonly reserved: TileRect[] = [];

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.cells = Array.from({ length: height }, () => Array.from({ length: width }, () => '#'));
  }

  private put(x: number, y: number, glyph: string): void {
    // jamais sur la bordure extérieure : les murs de bord restent pleins
    if (y > 0 && y < this.height - 1 && x > 0 && x < this.width - 1) this.cells[y][x] = glyph;
  }

  private paint(x: number, y: number, w: number, h: number, glyph: string): this {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.put(xx, yy, glyph);
    return this;
  }

  private paintBlob(cx: number, cy: number, rx: number, ry: number, glyph: string): this {
    for (let y = cy - ry; y <= cy + ry; y++) {
      for (let x = cx - rx; x <= cx + rx; x++) {
        const nx = (x - cx) / (rx + 0.5);
        const ny = (y - cy) / (ry + 0.5);
        if (nx * nx + ny * ny <= 1) this.put(x, y, glyph);
      }
    }
    return this;
  }

  /** Creuse un rectangle de sol (couloir, passage, chambre carrée). */
  floor(x: number, y: number, w: number, h: number): this {
    return this.paint(x, y, w, h, '.');
  }

  /** Creuse une caverne elliptique de sol de centre (cx, cy) et de demi-axes (rx, ry). */
  blob(cx: number, cy: number, rx: number, ry: number): this {
    return this.paintBlob(cx, cy, rx, ry, '.');
  }

  /** Creuse une fosse elliptique (lac gelé : bloque les déplacements, pas les projectiles). */
  lake(cx: number, cy: number, rx: number, ry: number): this {
    return this.paintBlob(cx, cy, rx, ry, '~');
  }

  /** Pose un pilier massif 2×2 (colonne de glace, couverture) dont le coin haut-gauche est (x, y). */
  pillarBlock(x: number, y: number): this {
    return this.paint(x, y, 2, 2, 'o');
  }

  /** Zones où les grilles de piliers ne posent rien (plaques, spawns, portes, socles, panneaux…). */
  reserve(...rects: TileRect[]): this {
    this.reserved.push(...rects);
    return this;
  }

  private isReserved(x: number, y: number): boolean {
    return this.reserved.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
  }

  private openAround(x: number, y: number): boolean {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const yy = y + dy;
        const xx = x + dx;
        if (yy < 0 || yy >= this.height || xx < 0 || xx >= this.width) return false;
        if (this.cells[yy][xx] !== '.' || this.isReserved(xx, yy)) return false;
      }
    }
    return true;
  }

  /**
   * Grille régulière de piliers dans `area` (pas sx/sy, décalage ox/oy). Un pilier n'est posé que si ses 8 voisines
   * sont du sol libre et non réservé : jamais de passage étranglé, aucune poche fermée.
   */
  pillarGrid(area: TileRect, sx: number, sy: number, ox = 0, oy = 0): this {
    for (let y = area.y + oy; y < area.y + area.h; y += sy) {
      for (let x = area.x + ox; x < area.x + area.w; x += sx) {
        if (this.openAround(x, y)) this.cells[y][x] = 'o';
      }
    }
    return this;
  }

  /** Lignes finales ; une tuile de sol sur sept devient la variante ',' (glace fendue, décor, praticable). */
  rows(): string[] {
    return this.cells.map((row, y) => row.map((c, x) => (c === '.' && (x * 3 + y * 5) % 7 === 0 ? ',' : c)).join(''));
  }
}

/**
 * Cycle de paliers `minPlayers` : ≈ 52 % des ennemis du niveau dès 1 joueur (164), 67 % à 2 (213), 83 % à 3 (263), 100 % à 4 (318).
 * La courbe est régulière (+50 environ par joueur) : chaque effectif reste au moins 25 % au-dessus du maximum des niveaux 1-3 au
 * même n, sans que 1-2 joueurs soient submergés. Les chevaliers (90 PV) sont réservés à 2 joueurs et plus (voir `tiered`).
 */
const TIERS = [1, 1, 4, 1, 1, 3, 1, 1, 2, 1, 2, 1, 3, 1, 1, 4, 3, 1, 4, 2] as const;

/**
 * Pose ennemis, décors et panneaux sur des tuiles de sol libres : chaque position demandée est « aimantée » vers la tuile
 * de sol libre la plus proche (jamais dans un mur, jamais deux sur la même tuile, jamais dans une zone interdite, jamais à
 * moins de `minDist` tuiles de l'arrivée des joueurs pour les ennemis).
 */
class Placer {
  readonly enemies: EnemySpawnDef[] = [];
  readonly decors: DecorDef[] = [];
  /** Braseros posés (à poser AVANT les ennemis : ceux-ci les évitent). */
  readonly fires: MechanismDef[] = [];
  private readonly used = new Set<number>();

  constructor(
    private readonly rows: readonly string[],
    private readonly spawn: TileXY,
    private readonly avoid: readonly TileRect[],
    private readonly minDist = 13.5,
  ) {}

  private free(x: number, y: number, far: boolean, ignoreAvoid: boolean): boolean {
    const g = this.rows[y]?.[x];
    if (g !== '.' && g !== ',') return false;
    if (this.used.has(y * 1000 + x)) return false;
    if (!ignoreAvoid && this.avoid.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)) return false;
    if (far && Math.hypot(x - this.spawn[0], y - this.spawn[1]) < this.minDist) return false;
    return true;
  }

  /**
   * Tuile libre la plus proche de (x, y). `ignoreAvoid` : les zones interdites (`avoid`) ne comptent pas — pour les braseros,
   * qui sont POSÉS dans ces zones (leurs tuiles) et ne doivent pas en être repoussés.
   */
  private snap(x: number, y: number, far: boolean, ignoreAvoid = false): TileXY {
    for (let r = 0; r <= 16; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (this.free(x + dx, y + dy, far, ignoreAvoid)) {
            this.used.add((y + dy) * 1000 + (x + dx));
            return [x + dx, y + dy];
          }
        }
      }
    }
    throw new Error(`level4 : aucune tuile libre près de [${x},${y}]`);
  }

  /** Un ennemi près de (x, y). */
  foe(kind: EnemyKind, x: number, y: number, extra: Partial<Omit<EnemySpawnDef, 'kind' | 'tile'>> = {}): this {
    this.enemies.push({ kind, tile: this.snap(x, y, true), ...extra });
    return this;
  }

  /** Une meute : les `kinds` en petit amas (grille 2×2 espacée de 2 tuiles) autour de (x, y). */
  pack(kinds: readonly EnemyKind[], x: number, y: number, extra: Partial<Omit<EnemySpawnDef, 'kind' | 'tile'>> = {}): this {
    kinds.forEach((kind, i) => this.foe(kind, x + (i % 2) * 2, y + Math.floor(i / 2) * 2, extra));
    return this;
  }

  /** Décors du même type près des tuiles demandées. */
  decor(type: DecorDef['type'], ...tiles: TileXY[]): this {
    for (const [x, y] of tiles) this.decors.push({ type, tile: this.snap(x, y, false) });
    return this;
  }

  /** Brasero ALLUMÉ (point de recharge de torche, lumière permanente) près de (x, y). Étiquette commune `fire` de la salle. */
  lit(room: string, id: string, x: number, y: number, lightRadiusTiles?: number): this {
    this.fires.push({
      id,
      type: 'brazier',
      tile: this.snap(x, y, false, true),
      lit: true,
      labelKey: mechLabel(room, 'fire'),
      ...(lightRadiusTiles === undefined ? {} : { lightRadiusTiles }),
    });
    return this;
  }

  /** Brasero ÉTEINT à allumer (`interact`, torche non vide) ; `ownerSlot`/`minPlayers` : coop adaptative. */
  unlit(
    room: string,
    id: string,
    label: string,
    x: number,
    y: number,
    extra: { ownerSlot?: number; minPlayers?: number; lightRadiusTiles?: number } = {},
  ): this {
    this.fires.push({ id, type: 'brazier', tile: this.snap(x, y, false, true), labelKey: mechLabel(room, label), ...extra });
    return this;
  }

  /** Panneau de salle (`sign.level4.<roomId>.<name>`), posé sur la tuile de sol libre la plus proche de (x, y). */
  sign(room: string, name: string, x: number, y: number): SignDef {
    return { id: `${room}.${name}`, tile: this.snap(x, y, false), textKey: `sign.level4.${room}.${name}` };
  }

  /** Ennemis finaux : les paliers `minPlayers` non précisés sont répartis selon le cycle `TIERS`. */
  tiered(): EnemySpawnDef[] {
    let i = 0;
    return this.enemies.map((e) => {
      if (e.minPlayers !== undefined) return e;
      const cycle = TIERS[i++ % TIERS.length];
      // un chevalier (90 PV) n'est jamais seul face à un joueur seul : il arrive à partir de 2 joueurs
      const tier = e.kind === 'knight' ? Math.max(cycle, 2) : cycle;
      return tier === 1 ? e : { ...e, minPlayers: tier };
    });
  }
}

/**
 * Torches/bannières accrochées au mur nord (ou sud) d'une salle : une tous les `step` tuiles le long de `area`.
 * Une position n'est retenue que si la tuile est bien un mur (les décors muraux sont autorisés sur les murs).
 */
function wallDecor(
  rows: readonly string[],
  type: 'torch' | 'banner',
  area: TileRect,
  step: number,
  side: 'north' | 'south' = 'north',
  start = 3,
): DecorDef[] {
  const y = side === 'north' ? area.y - 1 : area.y + area.h;
  const out: DecorDef[] = [];
  for (let x = area.x + start; x < area.x + area.w; x += step) {
    if (rows[y]?.[x] === '#') out.push({ type, tile: [x, y] });
  }
  return out;
}

/** Décors `torch` posés à des tuiles précises (mur ou sol) : éclairent un peu (3 tuiles) les épreuves de la salle sombre. */
function torchesAt(rows: readonly string[], ...tiles: TileXY[]): DecorDef[] {
  return tiles.map(([x, y]) => {
    if (rows[y]?.[x] === undefined) throw new Error(`level4 : torche hors grille [${x},${y}]`);
    return { type: 'torch' as const, tile: [x, y] as TileXY };
  });
}

/** Les quatre couleurs de slot, dans l'ordre des slots 0..3 (bleu, rouge, vert, jaune). */
const COLORS = ['Blue', 'Red', 'Green', 'Yellow'] as const;

/** Les tuiles (rectangle w×h, 2×2 par défaut) d'une porte dont le coin haut-gauche est (x, y). */
function doorTiles(x: number, y: number, w = 2, h = 2): TileXY[] {
  const out: TileXY[] = [];
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) out.push([xx, yy]);
  return out;
}

/** Clé d'étiquette de mécanisme : `mech.level4.<roomId>.<mechanismId>`. */
function mechLabel(room: string, mechanismId: string): string {
  return `mech.level4.${room}.${mechanismId}`;
}

/** Quatre spawns joueurs groupés (carré 2×2) dont le coin haut-gauche est (x, y). */
function spawns(x: number, y: number): TileXY[] {
  return [
    [x, y],
    [x + 1, y],
    [x, y + 1],
    [x + 1, y + 1],
  ];
}

/** Nom, indice d'arrivée : clés `room.level4.<id>.name` et `hintroom.level4.<id>`. */
function roomKeys(id: string): { nameKey: string; introHintKey: string } {
  return { nameKey: `room.level4.${id}.name`, introHintKey: `hintroom.level4.${id}` };
}

/** Zone 3×3 centrée sur une tuile (interdite aux ennemis/décors/panneaux). */
function at(t: TileXY): TileRect {
  return rect(t[0] - 1, t[1] - 1, 3, 3);
}

/** Meutes types (kinds) : mélanges d'ennemis, du plus facile au plus dur. */
const SWARM: readonly EnemyKind[] = ['slime', 'slime', 'bat', 'slime'];
const BONES: readonly EnemyKind[] = ['skeleton', 'slime', 'archer', 'bat'];
const FLIERS: readonly EnemyKind[] = ['bat', 'slime', 'bat', 'wisp'];
const HUNTERS: readonly EnemyKind[] = ['spider', 'slime', 'skeleton', 'bat'];
const GUARD: readonly EnemyKind[] = ['knight', 'slime', 'bat', 'slime'];
const HEAVY: readonly EnemyKind[] = ['skeleton', 'slime', 'spider', 'bat'];
const SHOOTERS: readonly EnemyKind[] = ['archer', 'slime', 'skeleton', 'slime'];
const ELITE: readonly EnemyKind[] = ['knight', 'skeleton', 'bat', 'slime'];

/** Les `n` premiers types d'une meute. */
function few(kinds: readonly EnemyKind[], n: number): readonly EnemyKind[] {
  return kinds.slice(0, n);
}

// ───────────────────────────── Salle 0 : Le Seuil de Givre ─────────────────────────────
//
// 68×44. Idée : APPRENDRE la STATUE JUMELLE dans le calme. Deux ailes opposées de la caverne : l'aile nord-ouest abrite la
// statue A [8,5] (socle A [8,7]), l'aile sud-est la statue B [60,38] (socle B [60,36]). Se tenir sur le socle A et appuyer sur
// Action fait pivoter la statue B (à l'autre bout de la caverne) ; le socle B fait pivoter la statue A. Les deux doivent regarder
// le NORD (haut) : A part vers le sud (2 quarts de tour), B vers l'ouest (1 quart de tour). La porte [54..55, 21..22] s'ouvre
// quand c'est fait, sur l'alcôve de sortie.
// Résolution : un héros va sur le socle A [8,7] et appuie 1 fois (B : ouest → nord) ; un autre va sur le socle B [60,36] et
// appuie 2 fois (A : sud → ouest → nord) ; à 1 joueur on fait l'aller-retour. La porte s'ouvre ; sortie [61..65, 19..24].
// Le calme est relatif : quelques limons et chauves-souris loin de l'arrivée (aucun à < 12 tuiles).

const threshold: RoomDef = (() => {
  const spawn: TileXY = [5, 22];
  const statueA: TileXY = [8, 5];
  const standA: TileXY = [8, 7];
  const statueB: TileXY = [60, 38];
  const standB: TileXY = [60, 36];
  const b = new LayoutBuilder(68, 44)
    .blob(11, 22, 10, 9) // caverne d'arrivée x1..21, y13..31
    .blob(34, 22, 18, 10) // grande salle centrale x16..52, y12..32
    .blob(14, 7, 12, 5) // aile nord-ouest (statue A)
    .floor(12, 10, 5, 5) // liaison aile NO ↔ caverne d'arrivée
    .blob(54, 37, 12, 5) // aile sud-est (statue B)
    .floor(46, 29, 4, 6) // liaison salle centrale ↔ aile SE
    .floor(50, 21, 8, 2) // passage de la porte (tuiles de porte x54..55)
    .blob(62, 22, 4, 6) // alcôve de sortie x58..66, y16..28
    .reserve(
      rect(2, 18, 9, 9), // arrivée
      at(standA),
      at(standB),
      rect(7, 4, 3, 5),
      rect(59, 35, 3, 5),
      rect(50, 19, 8, 6), // porte
      rect(58, 18, 9, 9), // sortie
    )
    .pillarGrid(rect(14, 13, 36, 18), 6, 5, 2, 2)
    .pillarGrid(rect(12, 14, 8, 15), 5, 5, 1, 1)
    .pillarGrid(rect(46, 33, 18, 8), 6, 4, 1, 1)
    .pillarGrid(rect(4, 3, 20, 8), 6, 4, 4, 1);
  const rows = b.rows();
  const p = new Placer(rows, spawn, [at(standA), at(standB), rect(7, 4, 3, 5), rect(59, 35, 3, 5), rect(50, 19, 8, 6)])
    .pack(few(SWARM, 3), 30, 15)
    .pack(few(FLIERS, 3), 40, 28)
    .pack(few(SWARM, 2), 46, 16)
    .pack(few(BONES, 2), 20, 38 - 16)
    .pack(few(SWARM, 2), 48, 39)
    .foe('bat', 22, 6)
    .foe('slime', 45, 34);
  return {
    id: 'threshold',
    ...roomKeys('threshold'),
    theme: 'frost',
    layout: rows,
    playerSpawns: spawns(...spawn),
    enemies: p.tiered(),
    mechanisms: [
      {
        id: 'twins',
        type: 'statuePair',
        statues: [
          { tile: statueA, standTile: standA, facing: 'down' },
          { tile: statueB, standTile: standB, facing: 'left' },
        ],
        targetDir: 'up',
        labelKey: mechLabel('threshold', 'twins'),
      },
      {
        id: 'twinsDoor',
        type: 'door',
        tiles: doorTiles(54, 21),
        requires: ['twins'],
        labelKey: mechLabel('threshold', 'twinsDoor'),
      },
    ],
    signs: [
      p.sign('threshold', 'twins', 9, 22),
      p.sign('threshold', 'north', 20, 22),
      p.sign('threshold', 'socketA', 10, 8),
      p.sign('threshold', 'socketB', 58, 35),
      p.sign('threshold', 'door', 50, 22),
    ],
    decor: [
      ...wallDecor(rows, 'torch', rect(16, 12, 36, 20), 8),
      ...wallDecor(rows, 'torch', rect(2, 2, 24, 10), 9),
      ...wallDecor(rows, 'banner', rect(16, 12, 36, 20), 12, 'north', 6),
      ...p.decor('crystal', [3, 14], [3, 30], [20, 13], [66, 17], [66, 27], [44, 42], [64, 41], [3, 3])
        .decor('bones', [24, 20], [40, 26], [50, 16])
        .decor('crate', [2, 2], [65, 40], [20, 30]).decors,
    ],
    exit: { rect: rect(61, 19, 5, 6), requires: ['twinsDoor'] },
    introHintKey: 'hintroom.level4.threshold',
  };
})();

// ───────────────────────────── Salle 1 : La Galerie des Stalactites ─────────────────────────────
//
// 76×46. Idée : plaques SIMULTANÉES (collectif) autour d'un lac gelé. Quatre plaques colorées dans les quatre chambres de coin
// reliées à la grande caverne par des liaisons de 4 tuiles ; la herse de glace (porte [64..65, 21..22]) s'ouvre quand toutes
// les plaques existantes sont tenues en même temps, puis reste ouverte. Plaque bleue min 1, rouge min 2, verte min 3, jaune min 4.
// Résolution : chaque héros rejoint la plaque de sa couleur — bleu [7,6] (nord-ouest), rouge [69,6] (nord-est), vert [7,40]
// (sud-ouest), jaune [69,40] (sud-est) — la porte s'ouvre ; on bat alors les gardiens (clear) puis tous à la sortie [69..73, 19..24].

const gallery: RoomDef = (() => {
  const plates: Record<string, TileXY> = { Blue: [7, 6], Red: [69, 6], Green: [7, 40], Yellow: [69, 40] };
  const spawn: TileXY = [4, 22];
  const b = new LayoutBuilder(76, 46)
    .blob(9, 22, 8, 7) // caverne d'arrivée x1..17, y15..29
    .blob(38, 22, 24, 15) // grande caverne x14..62, y7..37
    .lake(38, 22, 9, 5) // lac gelé au centre
    .blob(10, 7, 9, 5) // chambre nord-ouest
    .blob(66, 7, 9, 5) // chambre nord-est
    .blob(10, 39, 9, 5) // chambre sud-ouest
    .blob(66, 39, 9, 5) // chambre sud-est
    .floor(12, 11, 4, 6) // liaisons chambres ↔ caverne
    .floor(12, 28, 4, 7)
    .floor(58, 10, 4, 5)
    .floor(58, 30, 4, 6)
    .floor(60, 21, 8, 2) // passage de la porte
    .blob(71, 22, 4, 6) // alcôve de sortie x67..75, y16..28
    .reserve(
      rect(2, 17, 8, 10), // arrivée
      ...Object.values(plates).map(at),
      rect(58, 18, 10, 8), // porte
      rect(66, 17, 10, 10), // sortie
      rect(11, 10, 6, 6),
      rect(11, 29, 6, 6),
    )
    .pillarGrid(rect(16, 8, 44, 28), 6, 5, 2, 1)
    .pillarGrid(rect(4, 3, 14, 8), 5, 4, 2, 1)
    .pillarGrid(rect(58, 3, 16, 8), 5, 4, 2, 1)
    .pillarGrid(rect(4, 35, 14, 8), 5, 4, 2, 1)
    .pillarGrid(rect(58, 35, 16, 8), 5, 4, 2, 1);
  const rows = b.rows();
  const p = new Placer(rows, spawn, [...Object.values(plates).map(at), rect(58, 18, 10, 8), rect(66, 17, 10, 10)])
    // chambres des plaques (les gardes suivent les paliers de leurs plaques)
    .pack(few(BONES, 3), 12, 6)
    .pack(few(FLIERS, 3), 62, 6)
    .pack(few(SWARM, 3), 12, 38)
    .pack(few(HUNTERS, 3), 62, 38)
    // anneau autour du lac
    .pack(BONES, 24, 12)
    .pack(SWARM, 38, 10)
    .pack(HUNTERS, 52, 12)
    .pack(BONES, 24, 32)
    .pack(GUARD, 52, 32)
    .pack(SHOOTERS, 20, 22)
    // alcôve et couloirs
    .pack(few(BONES, 3), 14, 14)
    .pack(few(GUARD, 3), 14, 31)
    .pack(few(SHOOTERS, 3), 70, 24)
    // renfort de la galerie à 4 joueurs
    .pack(SWARM, 38, 34, { minPlayers: 4 })
    .pack(few(FLIERS, 3), 56, 8);
  const mechanisms: MechanismDef[] = COLORS.map((color, slot): MechanismDef => {
    const base = {
      id: `plate${color}`,
      type: 'plate' as const,
      tile: plates[color],
      colorSlot: slot,
      labelKey: mechLabel('gallery', `plate${color}`),
    };
    return slot === 0 ? base : { ...base, minPlayers: slot + 1 };
  });
  mechanisms.push({
    id: 'galleryDoor',
    type: 'door',
    tiles: doorTiles(64, 21),
    requires: ['plateBlue', 'plateRed', 'plateGreen', 'plateYellow'],
    labelKey: mechLabel('gallery', 'galleryDoor'),
  });
  return {
    id: 'gallery',
    ...roomKeys('gallery'),
    theme: 'frost',
    layout: rows,
    playerSpawns: spawns(...spawn),
    enemies: p.tiered(),
    mechanisms,
    signs: [p.sign('gallery', 'plates', 8, 22), p.sign('gallery', 'lake', 28, 14), p.sign('gallery', 'door', 58, 22)],
    decor: [
      ...wallDecor(rows, 'torch', rect(14, 7, 48, 31), 8),
      ...wallDecor(rows, 'banner', rect(14, 7, 48, 31), 12, 'north', 6),
      ...p.decor('crystal', [2, 2], [74, 2], [2, 43], [74, 43], [30, 8], [46, 36], [20, 20], [56, 24])
        .decor('statue', [12, 11], [64, 11], [12, 35], [64, 35])
        .decor('bones', [34, 12], [44, 33], [22, 26]).decor('crate', [3, 3], [73, 3], [3, 42], [73, 42]).decors,
    ],
    exit: { rect: rect(69, 19, 5, 6), requires: ['galleryDoor', 'clear'] },
  };
})();

// ───────────────────────────── Salle 2 : La Caverne des Échos ─────────────────────────────
//
// 80×48. Idée : la 2e STATUE JUMELLE PENDANT TROIS VAGUES d'ennemis. La statue A [70,5] (socle A [70,8]) est au nord-est, la statue
// B [10,43] (socle B [10,40]) au sud-ouest ; la salle est une immense caverne ovale où l'on est harcelé. Les deux doivent
// regarder le SUD (bas) : A part vers l'est (1 quart de tour, depuis le socle B), B vers le nord (2 quarts de tour, depuis le
// socle A). Le héros VERT (slot 2) doit en plus tenir le cairn [39..41, 23..25] 8 secondes cumulées. Trois vagues successives
// (chacune n'apparaît que quand la précédente est vaincue) : on se bat, on tourne les statues, on tient le cairn.
// Résolution : socle A [70,8] : 2 appuis ; socle B [10,40] : 1 appui ; porte [68..69, 23..24] ouverte ; vaincre les trois vagues
// (clear) ; le héros vert a tenu le cairn 8 s ; sortie [72..76, 21..26].

const echoes: RoomDef = (() => {
  const spawn: TileXY = [4, 24];
  const statueA: TileXY = [70, 5];
  const standA: TileXY = [70, 8];
  const statueB: TileXY = [10, 43];
  const standB: TileXY = [10, 40];
  const b = new LayoutBuilder(80, 48)
    .blob(8, 24, 7, 6) // alcôve d'arrivée x1..15, y18..30
    .blob(40, 24, 26, 15) // caverne centrale x14..66, y9..39
    .floor(12, 21, 6, 7)
    .blob(62, 8, 13, 6) // aile nord-est (statue A)
    .floor(56, 11, 6, 5)
    .blob(18, 41, 13, 5) // aile sud-ouest (statue B)
    .floor(20, 33, 6, 5)
    .floor(66, 23, 6, 2) // passage de la porte (tuiles x68..69)
    .blob(74, 24, 3, 5) // alcôve de sortie x71..77, y19..29
    .reserve(
      rect(2, 20, 9, 9), // arrivée
      at(standA),
      at(standB),
      rect(69, 4, 3, 5),
      rect(9, 39, 3, 5),
      rect(38, 22, 5, 5), // cairn
      rect(64, 21, 12, 6), // porte + sortie
    )
    .pillarGrid(rect(16, 10, 50, 29), 6, 5, 2, 2)
    .pillarGrid(rect(50, 3, 25, 10), 6, 4, 3, 1)
    .pillarGrid(rect(6, 36, 26, 9), 6, 4, 3, 1);
  const rows = b.rows();
  const keep = [at(standA), at(standB), rect(69, 4, 3, 5), rect(9, 39, 3, 5), rect(38, 22, 5, 5), rect(64, 21, 12, 6)];
  const p = new Placer(rows, spawn, keep);
  // trois vagues de 18 ennemis (meutes de 3 sur 6 points d'ancrage), de plus en plus dures
  const anchors: TileXY[][] = [
    [[26, 12], [52, 14], [24, 34], [54, 34], [40, 11], [40, 37]],
    [[22, 20], [58, 20], [30, 30], [50, 28], [34, 14], [46, 36]],
    [[28, 22], [54, 24], [36, 12], [44, 36], [20, 28], [60, 14]],
  ];
  const wavePacks: (readonly EnemyKind[])[][] = [
    [few(SWARM, 3), few(BONES, 3), few(FLIERS, 3), few(SWARM, 3), few(HUNTERS, 3), few(BONES, 3)],
    [few(BONES, 3), few(HUNTERS, 3), few(SHOOTERS, 3), few(GUARD, 3), few(FLIERS, 3), few(HUNTERS, 3)],
    [few(GUARD, 3), few(HEAVY, 3), few(SHOOTERS, 3), few(ELITE, 3), few(HEAVY, 3), few(GUARD, 3)],
  ];
  wavePacks.forEach((packs, wave) => {
    packs.forEach((kinds, i) => {
      const [ax, ay] = anchors[wave][i];
      p.pack(kinds, ax, ay, wave === 0 ? {} : { wave });
    });
  });
  return {
    id: 'echoes',
    ...roomKeys('echoes'),
    theme: 'frost',
    layout: rows,
    playerSpawns: spawns(...spawn),
    enemies: p.tiered(),
    mechanisms: [
      {
        id: 'echoPair',
        type: 'statuePair',
        statues: [
          { tile: statueA, standTile: standA, facing: 'right' },
          { tile: statueB, standTile: standB, facing: 'up' },
        ],
        targetDir: 'down',
        labelKey: mechLabel('echoes', 'echoPair'),
      },
      {
        id: 'echoDoor',
        type: 'door',
        tiles: doorTiles(68, 23),
        requires: ['echoPair'],
        labelKey: mechLabel('echoes', 'echoDoor'),
      },
    ],
    zones: [{ id: 'holdZone', rect: rect(39, 23, 3, 3) }],
    signs: [
      p.sign('echoes', 'pair', 10, 22),
      p.sign('echoes', 'south', 18, 24),
      p.sign('echoes', 'cairn', 36, 24),
      p.sign('echoes', 'socketA', 68, 9),
      p.sign('echoes', 'socketB', 12, 39),
    ],
    decor: [
      ...wallDecor(rows, 'torch', rect(14, 9, 52, 31), 8),
      ...wallDecor(rows, 'banner', rect(14, 9, 52, 31), 12, 'north', 6),
      ...p.decor('crystal', [39, 22], [41, 22], [39, 26], [41, 26], [3, 3], [76, 3], [3, 44], [76, 44])
        .decor('statue', [48, 3], [30, 44], [66, 11], [14, 37])
        .decor('bones', [26, 20], [56, 30], [44, 12]).decor('crate', [2, 2], [77, 2], [2, 45], [77, 45]).decors,
    ],
    exit: { rect: rect(72, 21, 5, 6), requires: ['echoDoor', 'clear', 'obj:hold'] },
  };
})();

// ───────────────────────────── Salle 3 : L'Antre du Gardien (DEMI-BOSS n°1) ─────────────────────────────
//
// 72×48. Arène pure (aucun mécanisme) : une immense caverne parsemée de colonnes de glace 2×2 (couverture contre les éclats du
// gardien). Le GARDIEN DE GIVRE (demi-boss, présent à tout n) attend à l'est avec sa meute (le nombre de sbires suit les
// joueurs). Objectif du héros JAUNE (slot 3) : 4 coups fatals. La sortie [64..67, 21..26] exige que tout soit vaincu (`clear`).
// Résolution : se couvrir derrière les colonnes, vaincre le gardien et sa meute ; la sortie s'ouvre ; tous s'y rejoignent.

const warden1: RoomDef = (() => {
  const spawn: TileXY = [4, 24];
  const b = new LayoutBuilder(72, 48)
    .blob(7, 24, 6, 5) // alcôve d'arrivée
    .blob(38, 24, 31, 19); // arène x7..69, y5..43
  // colonnes de glace 2×2 en quinconce (évitent l'arrivée et la sortie)
  const keep = [rect(2, 18, 14, 13), rect(58, 17, 12, 14)];
  const colsX = [
    [18, 30, 42, 54],
    [24, 36, 48, 60],
  ];
  [9, 17, 25, 33, 40].forEach((y, r) => {
    for (const x of colsX[r % 2]) {
      const hit = keep.some((k) => x + 1 >= k.x && x < k.x + k.w && y + 1 >= k.y && y < k.y + k.h);
      if (!hit) b.pillarBlock(x, y);
    }
  });
  const rows = b.rows();
  const p = new Placer(rows, spawn, [rect(60, 20, 8, 8)])
    .foe('warden', 54, 24, { minPlayers: 1 })
    .pack(GUARD, 40, 12)
    .pack(SWARM, 28, 20)
    .pack(BONES, 46, 30)
    .pack(HUNTERS, 36, 38)
    .pack(FLIERS, 52, 12)
    .pack(SHOOTERS, 56, 38)
    .pack(BONES, 30, 10)
    .pack(HUNTERS, 46, 18)
    .pack(few(SHOOTERS, 3), 62, 10)
    .pack(few(GUARD, 3), 62, 38)
    // renfort de la meute à 4 joueurs
    .pack(HEAVY, 24, 36, { minPlayers: 4 });
  return {
    id: 'warden1',
    ...roomKeys('warden1'),
    theme: 'frost',
    layout: rows,
    playerSpawns: spawns(...spawn),
    enemies: p.tiered(),
    mechanisms: [],
    signs: [p.sign('warden1', 'warden', 10, 22), p.sign('warden1', 'cover', 14, 28)],
    decor: [
      ...wallDecor(rows, 'torch', rect(7, 5, 63, 39), 9),
      ...wallDecor(rows, 'banner', rect(7, 5, 63, 39), 13, 'north', 7),
      ...p.decor('crystal', [8, 6], [68, 6], [8, 42], [68, 42], [38, 5], [38, 43])
        .decor('statue', [14, 8], [14, 40], [62, 8], [62, 40])
        .decor('bones', [34, 24], [50, 14], [26, 38]).decor('crate', [8, 8], [68, 8], [8, 40], [68, 40]).decors,
    ],
    // Cristaux de soin (sources de vie fixes, usage unique, 50 PV) : loin des arrivées et du départ du boss ; le 3e exige 3 joueurs.
    healCrystals: [
      { id: 'warden1_heal1', tile: [24, 14] },
      { id: 'warden1_heal2', tile: [22, 34] },
      { id: 'warden1_heal3', tile: [38, 8], minPlayers: 3 },
    ],
    exit: { rect: rect(64, 21, 4, 6), requires: ['clear', 'obj:slayer'] },
  };
})();

// ───────────────────────────── Salle 4 : Les Profondeurs Aveugles (SOMBRE) ─────────────────────────────
//
// 80×50. Idée : la salle SOMBRE du niveau (torches et braseros). Une salle centrale (arrivée, brasero allumé) reliée par deux
// rampes à un grand anneau de couloirs ; aux quatre coins de l'anneau, un brasero de couleur (ownerSlot 0..3, minPlayers = slot + 1) :
// chaque héros allume SON brasero ; quand les quatre brûlent, la porte [51..52, 24..25] de la salle centrale s'ouvre sur la chambre
// de sortie. Des braseros allumés (recharge de torche) jalonnent l'anneau ; des feux follets et des chauves-souris y rôdent.
// Les braseros de couleur sont posés EXACTEMENT sur les tuiles ci-dessous (le Placer ignore ses zones interdites pour les
// braseros) ; une torche repère est accrochée juste au nord de chacun ([x, y-1]).
// Résolution : bleu → [8,7] (nord-ouest), rouge → [72,7] (nord-est), vert → [8,43] (sud-ouest), jaune → [72,43] (sud-est) ;
// on y allume son brasero (Action, torche non vide : recharger aux braseros allumés) ; retour par les rampes [36..40, 10..17] /
// [36..40, 33..40] ; la porte s'ouvre ; sortie [56..62, 22..27]. Objectif slot 0 « flame » : le brasero bleu.

const deepdark: RoomDef = (() => {
  const spawn: TileXY = [30, 24];
  const braziers: TileXY[] = [
    [8, 7],
    [72, 7],
    [8, 43],
    [72, 43],
  ];
  const b = new LayoutBuilder(80, 50)
    .blob(38, 25, 11, 8) // salle centrale x27..49, y17..33
    .floor(5, 4, 70, 7) // anneau nord y4..10
    .floor(5, 40, 70, 7) // anneau sud y40..46
    .floor(4, 4, 7, 43) // anneau ouest x4..10
    .floor(69, 4, 7, 43) // anneau est x69..75
    .floor(36, 10, 5, 8) // rampe nord
    .floor(36, 33, 5, 8) // rampe sud
    .floor(49, 24, 5, 2) // passage de la porte (tuiles x51..52)
    .blob(59, 25, 5, 6) // chambre de sortie x54..64, y19..31
    .reserve(
      rect(28, 21, 8, 8), // arrivée
      ...braziers.map(at),
      rect(47, 22, 10, 6), // porte
      rect(54, 20, 10, 11), // sortie
      rect(35, 9, 7, 9),
      rect(35, 33, 7, 9),
    )
    .pillarGrid(rect(12, 4, 56, 7), 7, 4, 3, 1)
    .pillarGrid(rect(12, 40, 56, 7), 7, 4, 3, 1)
    .pillarGrid(rect(4, 12, 7, 28), 4, 6, 3, 1)
    .pillarGrid(rect(69, 12, 7, 28), 4, 6, 3, 1)
    .pillarGrid(rect(28, 18, 20, 14), 6, 5, 3, 2);
  const rows = b.rows();
  const p = new Placer(rows, spawn, [...braziers.map(at), rect(47, 22, 10, 6), rect(54, 20, 10, 11)]);
  // braseros allumés : arrivée, milieux de l'anneau, chambre de sortie
  p.lit('deepdark', 'darkFire1', 33, 22)
    .lit('deepdark', 'darkFire2', 40, 7)
    .lit('deepdark', 'darkFire3', 40, 43)
    .lit('deepdark', 'darkFire4', 7, 25)
    .lit('deepdark', 'darkFire5', 72, 25)
    .lit('deepdark', 'darkFire6', 20, 7)
    .lit('deepdark', 'darkFire7', 60, 43)
    .lit('deepdark', 'darkFire8', 60, 20);
  COLORS.forEach((color, slot) => {
    p.unlit('deepdark', `darkBrazier${color}`, `brazier${color}`, braziers[slot][0], braziers[slot][1], {
      ownerSlot: slot,
      lightRadiusTiles: 4,
      ...(slot === 0 ? {} : { minPlayers: slot + 1 }),
    });
  });
  p
    // anneau nord
    .pack(HUNTERS, 32, 7)
    .pack(BONES, 50, 7)
    // anneau est
    .pack(GUARD, 72, 18)
    .pack(FLIERS, 72, 32)
    // anneau sud
    .pack(HUNTERS, 48, 43)
    .pack(SHOOTERS, 30, 43)
    // anneau ouest
    .pack(GUARD, 8, 32)
    .pack(SWARM, 8, 18)
    // salle centrale et rampes
    .pack(few(HEAVY, 3), 44, 20)
    .pack(few(BONES, 3), 44, 30)
    .pack(few(FLIERS, 3), 38, 13)
    .pack(few(SWARM, 3), 38, 37)
    .pack(few(SHOOTERS, 3), 14, 10);
  return {
    id: 'deepdark',
    ...roomKeys('deepdark'),
    theme: 'frost',
    layout: rows,
    playerSpawns: spawns(...spawn),
    enemies: p.tiered(),
    mechanisms: [
      ...p.fires,
      {
        id: 'darkDoor',
        type: 'door',
        tiles: doorTiles(51, 24),
        requires: COLORS.map((c) => `darkBrazier${c}`),
        labelKey: mechLabel('deepdark', 'darkDoor'),
      },
    ],
    signs: [
      p.sign('deepdark', 'dark', 31, 21),
      p.sign('deepdark', 'braziers', 33, 26),
      p.sign('deepdark', 'door', 46, 24),
      p.sign('deepdark', 'ring', 38, 16),
    ],
    decor: [
      ...torchesAt(
        rows,
        [8, 6], // repères des braseros de couleur
        [72, 6],
        [8, 44],
        [72, 44],
        [50, 23], // porte
        [53, 23],
        [30, 20], // arrivée
        [56, 19], // sortie
      ),
      ...wallDecor(rows, 'banner', rect(54, 19, 11, 13), 5, 'south', 2),
      ...p.decor('crystal', [4, 4], [75, 4], [4, 46], [75, 46], [40, 16], [40, 34], [60, 20], [60, 30])
        .decor('statue', [27, 25], [49, 20], [49, 30])
        .decor('bones', [14, 7], [66, 43], [8, 38]).decor('crate', [5, 5], [74, 5], [5, 45], [74, 45]).decors,
    ],
    exit: { rect: rect(56, 22, 6, 6), requires: ['darkDoor'] },
    dark: true,
  };
})();

// ───────────────────────────── Salle 5 : La Flèche de Givre ─────────────────────────────
//
// 84×50. Idée : leviers à FENÊTRE, actions séparées, au bout des quatre bras d'une CROIX. Au centre, la salle d'arrivée ; quatre
// bras de 25 tuiles (nord, est, sud, ouest) se terminent par une chambre et un levier réservé à une couleur. Chaque levier se
// rabat 25 s après avoir été tiré : il faut les avoir tous tirés « presque ensemble ». Levier rouge min 2, vert min 3, jaune min 4
// (fenêtre effective inchangée). Quand les quatre sont actifs, la porte [54..55, 17..18] (coin nord-est de la salle centrale)
// s'ouvre définitivement sur la chambre de sortie [60..68, 10..18].
// Résolution : bleu → levier [4,25] (bras ouest), rouge → [42,4] (bras nord), vert → [79,25] (bras est), jaune → [42,46]
// (bras sud) ; on s'annonce près de son levier puis on tire (Action) ; la porte s'ouvre ; sortie [62..66, 12..16].
// Objectif slot 1 « lever » : le levier rouge (waived, donc accompli d'office, en solo).

const spire: RoomDef = (() => {
  const leverTiles: TileXY[] = [
    [4, 25],
    [42, 4],
    [79, 25],
    [42, 46],
  ];
  const leverIdOrder = ['Blue', 'Red', 'Green', 'Yellow'] as const;
  const spawn: TileXY = [36, 25];
  const mechanisms: MechanismDef[] = leverIdOrder.map((color, slot): MechanismDef => {
    const base = {
      id: `lever${color}`,
      type: 'lever' as const,
      tile: leverTiles[slot],
      ownerSlot: slot,
      windowMs: 25000,
      labelKey: mechLabel('spire', `lever${color}`),
    };
    return slot === 0 ? base : { ...base, minPlayers: slot + 1 };
  });
  mechanisms.push({
    id: 'spireDoor',
    type: 'door',
    tiles: doorTiles(54, 17),
    requires: leverIdOrder.map((c) => `lever${c}`),
    labelKey: mechLabel('spire', 'spireDoor'),
  });
  const b = new LayoutBuilder(84, 50)
    .blob(42, 25, 13, 10) // salle centrale x29..55, y15..35
    .floor(39, 2, 7, 14) // bras nord
    .blob(42, 6, 8, 4) // chambre du levier rouge
    .floor(39, 35, 7, 14) // bras sud
    .blob(42, 45, 8, 4) // chambre du levier jaune
    .floor(2, 22, 28, 7) // bras ouest
    .blob(6, 25, 5, 7) // chambre du levier bleu
    .floor(54, 22, 28, 7) // bras est
    .blob(78, 25, 5, 7) // chambre du levier vert
    .floor(50, 17, 13, 2) // passage de la porte (tuiles x54..55)
    .blob(66, 14, 5, 4) // chambre de sortie x61..71, y10..18
    .reserve(
      rect(32, 21, 8, 8), // arrivée
      ...leverTiles.map(at),
      rect(50, 15, 12, 6), // porte
      rect(61, 11, 11, 8), // sortie
    )
    .pillarGrid(rect(30, 16, 24, 19), 5, 5, 2, 2)
    .pillarGrid(rect(40, 3, 5, 12), 4, 4, 1, 1)
    .pillarGrid(rect(40, 36, 5, 12), 4, 4, 1, 1)
    .pillarGrid(rect(4, 23, 25, 5), 6, 3, 3, 1)
    .pillarGrid(rect(55, 23, 25, 5), 6, 3, 3, 1);
  const rows = b.rows();
  const p = new Placer(rows, spawn, [...leverTiles.map(at), rect(50, 15, 12, 6), rect(61, 11, 11, 8)])
    // gardes des leviers (mêmes paliers)
    .pack(few(HUNTERS, 3), 12, 25)
    .pack(few(SWARM, 3), 42, 9)
    .pack(few(BONES, 3), 73, 25)
    .pack(few(SWARM, 3), 42, 42)
    // bras ouest
    .pack(SWARM, 26, 26)
    // bras nord
    .pack(FLIERS, 41, 14)
    // bras est
    .pack(BONES, 62, 24)
    // bras sud
    .pack(SHOOTERS, 41, 38)
    // salle centrale
    .pack(HEAVY, 46, 20)
    .pack(FLIERS, 46, 31)
    .pack(few(BONES, 3), 34, 17)
    // coin sud-est de la salle centrale
    .pack(few(SHOOTERS, 3), 50, 31)
    .pack(few(SWARM, 3), 8, 30)
    .pack(few(FLIERS, 3), 76, 20);
  return {
    id: 'spire',
    ...roomKeys('spire'),
    theme: 'frost',
    layout: rows,
    playerSpawns: spawns(...spawn),
    enemies: p.tiered(),
    mechanisms,
    signs: [
      p.sign('spire', 'levers', 37, 23),
      p.sign('spire', 'arms', 38, 28),
      p.sign('spire', 'window', 46, 24),
      p.sign('spire', 'door', 52, 20),
    ],
    decor: [
      ...wallDecor(rows, 'torch', rect(29, 15, 27, 21), 7),
      ...wallDecor(rows, 'torch', rect(2, 22, 28, 7), 9),
      ...wallDecor(rows, 'torch', rect(54, 22, 28, 7), 9),
      ...wallDecor(rows, 'banner', rect(60, 10, 9, 9), 4, 'north', 2),
      ...p.decor('crystal', [3, 20], [3, 30], [80, 20], [80, 30], [37, 3], [47, 3], [37, 47], [47, 47])
        .decor('statue', [30, 16], [54, 34], [30, 34], [54, 16])
        .decor('bones', [14, 25], [70, 24], [42, 12], [42, 38]).decor('crate', [2, 24], [81, 24], [40, 2], [40, 48]).decors,
    ],
    exit: { rect: rect(62, 12, 5, 5), requires: ['spireDoor', 'clear'] },
  };
})();

// ───────────────────────────── Salle 6 : L'Antichambre du Trône (DEMI-BOSS n°2) ─────────────────────────────
//
// 80×46. Idée : la 3e STATUE JUMELLE commande LA PORTE DU BOSS, sous la garde d'un 2e GARDIEN DE GIVRE et de sa meute. La statue
// A [70,5] (socle A [70,8]) est dans la chambre nord-est, la statue B [70,41] (socle B [70,38]) dans la chambre sud-est ; la
// grande porte [66..67, 21..24] (2×4 tuiles) exige la paire résolue ET deux plaques de garde tenues en même temps (plaque
// ouest [8,6], héros VERT, 3+ joueurs ; plaque sud-ouest [8,40], héros JAUNE, 4 joueurs). Les deux statues doivent regarder l'OUEST (gauche) :
// A part vers le nord (3 quarts de tour, depuis le socle B), B vers l'est (1 quart de tour, depuis le socle A).
// Résolution : socle A [70,8] : 1 appui (la statue B, qui regarde le sud, passe à l'ouest) ; socle B [70,38] : 3 appuis (la statue A,
// qui regarde le nord, tourne trois fois dans le sens horaire : est, sud, ouest) ; plaques tenues (3+/4 joueurs) ; la porte
// s'ouvre ; vaincre le gardien et sa meute (clear) ; sortie [71..75, 20..26].

const antechamber: RoomDef = (() => {
  const spawn: TileXY = [4, 23];
  const statueA: TileXY = [70, 5];
  const standA: TileXY = [70, 8];
  const statueB: TileXY = [70, 41];
  const standB: TileXY = [70, 38];
  const plateA: TileXY = [8, 6];
  const plateB: TileXY = [8, 40];
  const b = new LayoutBuilder(80, 46)
    .blob(8, 23, 7, 6) // alcôve d'arrivée
    .blob(40, 23, 24, 14) // grande caverne x16..64, y9..37
    .floor(12, 20, 6, 7)
    .blob(12, 8, 8, 5) // chambre de la plaque A (nord-ouest)
    .floor(16, 12, 4, 6)
    .blob(12, 38, 8, 5) // chambre de la plaque B (sud-ouest)
    .floor(16, 29, 4, 7)
    .blob(66, 8, 9, 5) // chambre de la statue A (nord-est)
    .floor(58, 11, 5, 7)
    .blob(66, 38, 9, 5) // chambre de la statue B (sud-est)
    .floor(58, 29, 5, 7)
    .floor(64, 21, 6, 4) // passage de la grande porte (tuiles x66..67, y21..24)
    .blob(73, 23, 4, 6) // chambre de sortie x69..77, y17..29
    .reserve(
      rect(2, 19, 9, 9), // arrivée
      at(plateA),
      at(plateB),
      at(standA),
      at(standB),
      rect(69, 4, 3, 5),
      rect(69, 37, 3, 5),
      rect(62, 19, 16, 10), // porte + sortie
    )
    .pillarGrid(rect(18, 10, 44, 27), 6, 5, 2, 2)
    .pillarGrid(rect(4, 3, 18, 10), 5, 4, 3, 1)
    .pillarGrid(rect(4, 33, 18, 10), 5, 4, 3, 1)
    .pillarGrid(rect(58, 3, 18, 10), 5, 4, 3, 2)
    .pillarGrid(rect(58, 33, 18, 10), 5, 4, 3, 1);
  const rows = b.rows();
  const keep = [at(plateA), at(plateB), at(standA), at(standB), rect(69, 4, 3, 5), rect(69, 37, 3, 5), rect(62, 19, 16, 10)];
  const p = new Placer(rows, spawn, keep)
    .foe('warden', 44, 23, { minPlayers: 1 })
    // gardes des plaques (qui n'existent qu'à 3 et 4 joueurs : leurs gardes suivent)
    .pack(few(HEAVY, 3), 14, 8, { minPlayers: 3 })
    .pack(few(ELITE, 3), 14, 38, { minPlayers: 4 })
    // gardes des statues
    .pack(few(SHOOTERS, 3), 62, 8)
    .pack(few(GUARD, 3), 62, 38)
    // caverne
    .pack(GUARD, 28, 14)
    .pack(BONES, 28, 32)
    .pack(HEAVY, 50, 14)
    .pack(SHOOTERS, 50, 32)
    .pack(ELITE, 56, 23)
    .pack(HUNTERS, 44, 12)
    .pack(GUARD, 32, 23)
    .pack(few(SWARM, 3), 20, 15)
    .pack(few(FLIERS, 3), 20, 32);
  return {
    id: 'antechamber',
    ...roomKeys('antechamber'),
    theme: 'frost',
    layout: rows,
    playerSpawns: spawns(...spawn),
    enemies: p.tiered(),
    mechanisms: [
      {
        id: 'bossPair',
        type: 'statuePair',
        statues: [
          { tile: statueA, standTile: standA, facing: 'up' },
          { tile: statueB, standTile: standB, facing: 'down' },
        ],
        targetDir: 'left',
        labelKey: mechLabel('antechamber', 'bossPair'),
      },
      { id: 'guardPlateA', type: 'plate', tile: plateA, colorSlot: 2, minPlayers: 3, labelKey: mechLabel('antechamber', 'guardPlateA') },
      { id: 'guardPlateB', type: 'plate', tile: plateB, colorSlot: 3, minPlayers: 4, labelKey: mechLabel('antechamber', 'guardPlateB') },
      {
        id: 'bossDoor',
        type: 'door',
        tiles: doorTiles(66, 21, 2, 4),
        requires: ['bossPair', 'guardPlateA', 'guardPlateB'],
        labelKey: mechLabel('antechamber', 'bossDoor'),
      },
    ],
    signs: [
      p.sign('antechamber', 'door', 9, 22),
      p.sign('antechamber', 'pair', 11, 25),
      p.sign('antechamber', 'plates', 12, 12),
      p.sign('antechamber', 'socketA', 68, 9),
      p.sign('antechamber', 'socketB', 68, 37),
    ],
    decor: [
      ...wallDecor(rows, 'torch', rect(16, 9, 48, 29), 8),
      ...wallDecor(rows, 'banner', rect(16, 9, 48, 29), 11, 'north', 5),
      ...p.decor('crystal', [64, 22], [64, 24], [3, 3], [76, 3], [3, 42], [76, 42], [8, 10], [8, 36])
        .decor('statue', [40, 9], [40, 37], [68, 20], [68, 26])
        .decor('bones', [24, 24], [52, 20], [44, 30]).decor('crate', [2, 2], [77, 2], [2, 43], [77, 43]).decors,
    ],
    // Cristaux de soin (sources de vie fixes, usage unique, 50 PV) : loin des arrivées et du départ du boss ; le 3e exige 3 joueurs.
    healCrystals: [
      { id: 'antechamber_heal1', tile: [26, 14] },
      { id: 'antechamber_heal2', tile: [26, 30] },
      { id: 'antechamber_heal3', tile: [62, 7], minPlayers: 3 },
    ],
    exit: { rect: rect(71, 20, 5, 6), requires: ['bossDoor', 'clear'] },
  };
})();

// ───────────────────────────── Salle 7 : Le Trône de la Reine ─────────────────────────────
//
// 64×44. Salle de boss sans mécanisme : la grande cathédrale de glace, colonnes 2×2 de couverture (elles arrêtent les
// éclats) et une alcôve au nord qui contient la sortie finale, SCELLÉE : elle exige la Reine du Givre vaincue (`clear`) et les
// quatre objectifs personnels. La Reine (kind 'frostqueen', 3 phases : éventail d'éclats, blizzard, invocations, téléportation,
// glissade) apparaît à l'est, présente à tout n ; sa garde (4, 8 puis 12 sbires à 2, 3 et 4 joueurs) allonge le combat final à
// plusieurs sans toucher aux PV du boss ; les héros arrivent à l'ouest.
// Résolution : se couvrir derrière les colonnes, vaincre la Reine (ses sbires invoqués comptent) ; la sortie [28..35, 1..3] s'ouvre.

const throne: RoomDef = (() => {
  const b = new LayoutBuilder(64, 44)
    .blob(32, 25, 29, 17) // cathédrale x3..61, y8..42
    .floor(28, 2, 8, 8) // alcôve de la sortie finale
    .pillarBlock(12, 12)
    .pillarBlock(12, 30)
    .pillarBlock(22, 20)
    .pillarBlock(30, 14)
    .pillarBlock(30, 32)
    .pillarBlock(40, 20)
    .pillarBlock(50, 12)
    .pillarBlock(50, 30);
  const rows = b.rows();
  const p = new Placer(rows, [5, 24], [], 0);
  // Escorte de la Reine : la Reine est présente à tout n (PV inchangés) ; sa garde grossit avec les joueurs (`minPlayers` 2, 3, 4)
  // pour que le combat final ne s'effondre pas à plusieurs. Aucune apparition à moins de 13,5 tuiles de l'arrivée.
  const guard = new Placer(rows, [5, 24], [], 13.5)
    .foe('knight', 38, 14, { minPlayers: 2 })
    .foe('skeleton', 38, 36, { minPlayers: 2 })
    .foe('archer', 46, 12, { minPlayers: 2 })
    .foe('slime', 46, 38, { minPlayers: 2 })
    .foe('knight', 24, 24, { minPlayers: 3 })
    .foe('archer', 46, 20, { minPlayers: 3 })
    .foe('skeleton', 46, 32, { minPlayers: 3 })
    .foe('wisp', 34, 24, { minPlayers: 3 })
    .foe('knight', 24, 14, { minPlayers: 4 })
    .foe('knight', 24, 36, { minPlayers: 4 })
    .foe('archer', 56, 14, { minPlayers: 4 })
    .foe('spider', 56, 36, { minPlayers: 4 });
  return {
    id: 'throne',
    ...roomKeys('throne'),
    theme: 'frost',
    layout: rows,
    playerSpawns: spawns(4, 24),
    enemies: [{ kind: 'frostqueen', tile: [52, 25] }, ...guard.enemies],
    mechanisms: [],
    signs: [p.sign('throne', 'warning', 8, 22)],
    decor: [
      ...wallDecor(rows, 'torch', rect(3, 8, 59, 35), 9),
      ...wallDecor(rows, 'banner', rect(3, 8, 59, 35), 13, 'north', 6),
      ...p.decor('crystal', [28, 2], [35, 2], [31, 8], [33, 8], [5, 12], [59, 12], [5, 38], [59, 38])
        .decor('statue', [6, 10], [57, 10], [6, 40], [57, 40])
        .decor('bones', [16, 24], [36, 28], [44, 36]).decors,
    ],
    // Cristaux de soin (sources de vie fixes, usage unique, 50 PV) : loin des arrivées et du départ du boss ; le 3e exige 3 joueurs.
    healCrystals: [
      { id: 'throne_heal1', tile: [20, 16] },
      { id: 'throne_heal2', tile: [20, 34] },
      { id: 'throne_heal3', tile: [30, 10], minPlayers: 3 },
    ],
    exit: {
      rect: rect(28, 1, 8, 3),
      requires: ['clear', 'obj:flame', 'obj:lever', 'obj:hold', 'obj:slayer'],
      final: true,
      sealed: true,
    },
  };
})();

// ───────────────────────────── Dialogues et objectifs ─────────────────────────────

const intro: DialogueLine[] = [
  { speaker: 'narrator', textKey: 'level.level4.intro.1' },
  { speaker: 'lyssa', textKey: 'level.level4.intro.2' },
  { speaker: 'aldric', textKey: 'level.level4.intro.3' },
  { speaker: 'frostqueen', textKey: 'level.level4.intro.4' },
  { speaker: 'heroes', textKey: 'level.level4.intro.5' },
];

const outro: DialogueLine[] = [
  { speaker: 'narrator', textKey: 'level.level4.outro.1' },
  { speaker: 'lyssa', textKey: 'level.level4.outro.2' },
  { speaker: 'heroes', textKey: 'level.level4.outro.3' },
  { speaker: 'lyssa', textKey: 'level.level4.outro.4' },
];

const objectives: ObjectiveDef[] = [
  { id: 'flame', slot: 0, roomId: 'deepdark', kind: 'mechanism', mechanismId: 'darkBrazierBlue', labelKey: 'objective.level4.flame' },
  { id: 'lever', slot: 1, roomId: 'spire', kind: 'mechanism', mechanismId: 'leverRed', labelKey: 'objective.level4.lever' },
  { id: 'hold', slot: 2, roomId: 'echoes', kind: 'zone', zoneId: 'holdZone', seconds: 8, labelKey: 'objective.level4.hold' },
  { id: 'slayer', slot: 3, roomId: 'warden1', kind: 'kills', count: 4, labelKey: 'objective.level4.slayer' },
];

/**
 * Niveau 4 — Les Cavernes de Givre. Données pures (aucune logique) : voir l'en-tête du fichier pour la structure, le rythme,
 * la coop adaptative et les objectifs.
 */
export const level4: LevelDef = {
  id: 'level4',
  nameKey: 'level.level4.name',
  theme: 'frost',
  estimatedMinutes: 8,
  intro,
  outro,
  rooms: [threshold, gallery, echoes, warden1, deepdark, spire, antechamber, throne],
  objectives,
};
