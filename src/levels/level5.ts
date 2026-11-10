/**
 * Niveau 5 — « Les Forges Ardentes » (thème `ember`, 9 salles, ≈ 9 minutes).
 *
 * Sous Vaelorn, les anciennes forges se sont rallumées. Le niveau introduit le SABLIER PARTAGÉ (`hourglass`) : une herse
 * ferme un passage obligatoire ; le sable (4 s seulement) s'écoule en permanence et, quand il est vide, la herse se referme
 * tuile par tuile (0,3 à 0,4 s par tuile). Le levier du côté de l'arrivée est LOIN de la herse (≈ 25 tuiles, plus de 6 s de course) :
 * le héros qui le retourne ne peut pas courir jusqu'à la herse avant sa fermeture ; il reste donc de son côté pendant que les
 * autres, déjà postés devant la herse, passent. Il faut alors qu'un coéquipier passé de l'autre côté retourne le levier voisin de la
 * herse (6 à 9 tuiles) pour le laisser passer à son tour : c'est le RELAIS. En solo la période est doublée par le moteur
 * (8 s) : un héros seul retourne le levier lointain puis court, même le plus lent.
 *
 * Rythme (le mécanisme inédit est appris dans le calme, puis réutilisé sous la menace, puis combiné) :
 *  1. `ashgate`    Le Vestibule des Cendres     APPRENTISSAGE calme : une herse, un sable généreux (30 s)
 *  2. `slagworks`  Les Fonderies de Scories     la herse s'ouvre sur une immense fonderie pleine de gardiens (combat)
 *  3. `crucible`   Le Creuset des Deux Passages DEUX sabliers qui se succèdent, une chambre de combat entre eux, zone à tenir
 *  4. `pyre`       Le Porche du Brasier         plaques simultanées (porte) puis sablier, grande forge de gardiens
 *  5. `cinderpit`  La Fosse du Pyromancien      DEMI-BOSS 1 (pyromancien) à mi-parcours : arène pure de lave et de piliers
 *  6. `blindforge` La Forge Aveugle             salle SOMBRE : braseros à allumer (un par héros) derrière un sablier
 *  7. `bellows`    Les Soufflets de la Forge    bloc 2×2 poussé à deux dans un couloir, accès par un sablier
 *  8. `emberhold`  Le Donjon des Braises        clés personnelles (une porte par héros), DEMI-BOSS 2 (pyromancien) dans l'arène
 *  9. `forgeheart` Le Cœur de la Forge          BOSS de fin : le Seigneur de la Forge (arène pure, sortie scellée)
 *
 * ── Pourquoi des arènes de boss « pures » ──
 * Les demi-boss et le boss se téléportent à un point tiré dans TOUTE la salle (moteur : `pickArenaPoint`). Une salle mêlant énigme
 * et boss, avec une herse ou une porte qui peut se refermer, pourrait donc couper le boss des héros (observé : un pyromancien
 * téléporté derrière une herse close). Les deux demi-boss et le boss de fin sont donc dans des espaces ouverts d'un seul tenant :
 * l'arène `cinderpit` (aucun mécanisme), l'arène `emberhold` (les quatre portes à clé sont levées avant que le pyromancien,
 * posé à > 30 tuiles des portes, n'entre en combat) et `forgeheart` (arène pure).
 *
 * ── Taille des salles ──
 * Toutes les salles font de 58 à 86 tuiles de large et de 42 à 52 de haut : la caméra défile. Les layouts sont générés par des
 * fonctions locales déterministes (rectangles creusés, couloirs de 3 tuiles, fosses de lave, grilles de piliers).
 *
 * ── Sablier : relais obligatoire et anti-verrou ──
 * Chaque herse ferme un couloir de 3 tuiles de large, avec un levier du sablier de CHAQUE côté. Côté arrivée le levier est à
 * ≈ 25 tuiles de la herse (coin éloigné de la salle) ; de l'autre côté il est à 6-9 tuiles, dans une zone sans ennemi.
 * Géométrie vérifiée par `level5.test.ts` (course du héros « moyen » du levier lointain à la herse > sable + fermeture) et par les
 * bots (`level5.run.test.ts` : un seul retournement ne suffit PAS à 2 joueurs ou plus, un relais suffit, un héros seul passe).
 * Anti-verrou : après un redémarrage de salle (herse fermée) le levier lointain est atteignable depuis l'arrivée ; en solo la
 * période est doublée, donc le héros seul (même le plus lent) passe ; à plusieurs, le coéquipier resté en arrière est aidé par un
 * retournement du levier voisin de la herse, de l'autre côté, dans une zone sans ennemi.
 * Une tuile de herse occupée par un joueur ou un ennemi ne se ferme pas (moteur) : personne n'est écrasé ; un héros planté dans la
 * herse la tient donc ouverte (« tenir la porte » : un rôle coopératif de plus, toléré). Le sablier n'est jamais exigé dans le
 * `requires` d'une porte (règle du validateur) : c'est un obstacle physique.
 *
 * Coop adaptative : tout est faisable de 1 à 4 joueurs.
 *  - sablier : période doublée en solo (moteur) ; un seul joueur retourne le levier lointain puis court ;
 *  - plaques / clés / portes / braseros de couleur : `minPlayers` croissants par slot (le slot k n'existe qu'à k+1 joueurs) ;
 *  - bloc : `playersRequired` par défaut (2) plafonné au nombre de joueurs ;
 *  - ennemis : leur nombre ne dépend QUE du nombre de joueurs (`minPlayers`), jamais de la difficulté ; à 1 joueur il y en a
 *    ≈ 56 % de ceux présents à 4 joueurs. Les demi-boss (pyromancien) et le boss sont présents à TOUS les nombres de joueurs,
 *    accompagnés de sbires dont le nombre suit les joueurs. Aucun ennemi à moins de 12 tuiles de l'arrivée.
 *
 * Objectifs personnels (un par slot, types variés, répartis sur 4 salles) :
 *  - slot 0 (bleu)   `seal`   : mécanisme — ouvrir SA porte à clé du Donjon des Braises ;
 *  - slot 1 (rouge)  `hold`   : zone — tenir le creuset 8 s (entre les deux sabliers) ;
 *  - slot 2 (vert)   `slayer` : kills — 5 coups fatals aux Soufflets ;
 *  - slot 3 (jaune)  `torch`  : mécanisme — allumer SON brasero jaune dans la Forge Aveugle (waived à moins de 4 joueurs).
 *  Chaque salle qui porte un objectif ne peut être quittée qu'une fois celui-ci accompli (`obj:`), et la sortie finale exige en
 *  plus le Seigneur de la Forge vaincu (`clear`) et les quatre objectifs.
 *
 * Toutes les chaînes affichées sont des clés i18n (parts `src/i18n/parts/level5.{fr,en}.json`).
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
 * Constructeur de grille : on part d'un plein de murs et on « creuse » des rectangles de sol.
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

  private paint(x: number, y: number, w: number, h: number, glyph: string): this {
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        if (yy >= 0 && yy < this.height && xx >= 0 && xx < this.width) this.cells[yy][xx] = glyph;
      }
    }
    return this;
  }

  /** Creuse un rectangle de sol (salle, couloir, passage). */
  floor(x: number, y: number, w: number, h: number): this {
    return this.paint(x, y, w, h, '.');
  }

  /** Creuse une fosse de lave (bloque les déplacements, pas les projectiles). */
  pit(x: number, y: number, w: number, h: number): this {
    return this.paint(x, y, w, h, '~');
  }

  /** Pose des piliers isolés. */
  pillar(...tiles: TileXY[]): this {
    for (const [x, y] of tiles) this.paint(x, y, 1, 1, 'o');
    return this;
  }

  /** Pose un pilier massif 2×2 (couverture) dont le coin haut-gauche est (x, y). */
  pillarBlock(x: number, y: number): this {
    return this.paint(x, y, 2, 2, 'o');
  }

  /** Zones où les grilles de piliers ne posent rien (spawns, leviers, portes, plaques…). */
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

  /** Grille régulière de piliers dans `area` ; un pilier n'est posé que si ses 8 voisines sont du sol libre non réservé. */
  pillarGrid(area: TileRect, sx: number, sy: number, ox = 0, oy = 0): this {
    for (let y = area.y + oy; y < area.y + area.h; y += sy) {
      for (let x = area.x + ox; x < area.x + area.w; x += sx) {
        if (this.openAround(x, y)) this.cells[y][x] = 'o';
      }
    }
    return this;
  }

  /** Lignes finales ; une tuile de sol sur sept devient la variante ',' (décor, praticable). */
  rows(): string[] {
    return this.cells.map((row, y) => row.map((c, x) => (c === '.' && (x * 3 + y * 5) % 7 === 0 ? ',' : c)).join(''));
  }
}

/**
 * Paliers `minPlayers` PAR TYPE d'ennemi (cycles). Les faibles (chauves-souris, limons) sont présents dès 1 joueur ; les plus
 * dangereux (archers, feux follets, chevaliers) n'arrivent qu'avec plus de joueurs : à 1 joueur ≈ 56 % des ennemis de la salle à
 * 4 joueurs, mais surtout les plus doux. Les compteurs sont partagés par toutes les salles (évaluées dans l'ordre : déterministe).
 */
const KIND_TIERS: Partial<Record<EnemyKind, readonly number[]>> = {
  bat: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  slime: [1, 1, 1, 1, 1, 1, 1, 3, 1, 4],
  skeleton: [1, 1, 1, 4, 2, 2, 4, 1, 3, 4],
  spider: [1, 2, 4, 1, 3, 2, 4, 1, 2, 4],
  archer: [4, 2, 4, 1, 3, 4, 2, 4, 2, 4],
  wisp: [4, 2, 4, 3, 4, 1, 2, 2, 4, 4],
  knight: [4, 3, 4, 4, 4, 4, 2, 4, 4, 4],
};
const tierCursor = new Map<EnemyKind, number>();

/** Suite de Halton (van der Corput) : positions réparties de façon déterministe dans un rectangle. */
function halton(index: number, base: number): number {
  let f = 1;
  let r = 0;
  let i = index;
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r;
}

/**
 * Pose ennemis, décors, braseros et panneaux sur des tuiles de sol libres : chaque position demandée est « aimantée » vers la
 * tuile de sol libre la plus proche (jamais dans un mur ni une fosse, jamais deux sur la même tuile, jamais dans une zone
 * interdite, jamais à moins de `minDist` tuiles de l'arrivée des joueurs pour les ennemis).
 */
/** Ennemis ordinaires qui volent (les fosses ne les bloquent pas). */
const FLYERS: ReadonlySet<EnemyKind> = new Set<EnemyKind>(['bat', 'wisp']);

class Placer {
  readonly enemies: EnemySpawnDef[] = [];
  readonly decors: DecorDef[] = [];
  /** Braseros posés (à poser AVANT les ennemis : ceux-ci les évitent). */
  readonly fires: MechanismDef[] = [];
  private readonly used = new Set<number>();

  constructor(
    private readonly roomId: string,
    private readonly rows: readonly string[],
    private readonly spawn: TileXY,
    private readonly avoid: readonly TileRect[],
    private readonly minDist = 13,
  ) {}

  /** Une fosse de lave à moins de 3 tuiles (un ennemi volant y resterait suspendu, hors de portée d'une arme de mêlée) ? */
  private nearPit(x: number, y: number): boolean {
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) if (this.rows[y + dy]?.[x + dx] === '~') return true;
    }
    return false;
  }

  private free(x: number, y: number, far: boolean, flying = false): boolean {
    const g = this.rows[y]?.[x];
    if (g !== '.' && g !== ',') return false;
    if (this.used.has(y * 1000 + x)) return false;
    if (this.avoid.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)) return false;
    if (flying && this.nearPit(x, y)) return false;
    if (far) {
      // distance au plus proche des quatre spawns groupés (carré 2×2)
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
        if (Math.hypot(x - this.spawn[0] - dx, y - this.spawn[1] - dy) < this.minDist) return false;
      }
    }
    return true;
  }

  private snap(x: number, y: number, far: boolean, flying = false): TileXY {
    for (let r = 0; r <= 16; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (this.free(x + dx, y + dy, far, flying)) {
            this.used.add((y + dy) * 1000 + (x + dx));
            return [x + dx, y + dy];
          }
        }
      }
    }
    throw new Error(`level5 (${this.roomId}) : aucune tuile libre près de [${x},${y}]`);
  }

  /** Un ennemi près de (x, y). */
  foe(kind: EnemyKind, x: number, y: number, extra: Partial<Omit<EnemySpawnDef, 'kind' | 'tile'>> = {}): this {
    this.enemies.push({ kind, tile: this.snap(x, y, true, FLYERS.has(kind)), ...extra });
    return this;
  }

  /**
   * `count` ennemis répartis (Halton) dans `area`, types pris en boucle dans `kinds`. Les paliers `minPlayers` sont attribués
   * ensuite par `tiered()`.
   */
  scatter(area: TileRect, kinds: readonly EnemyKind[], count: number, extra: Partial<Omit<EnemySpawnDef, 'kind' | 'tile'>> = {}): this {
    for (let i = 0; i < count; i++) {
      const x = area.x + Math.floor(halton(i + 1, 2) * area.w);
      const y = area.y + Math.floor(halton(i + 1, 3) * area.h);
      this.foe(kinds[i % kinds.length], x, y, extra);
    }
    return this;
  }

  /**
   * Réserve à `minPlayers` joueurs ou plus certains des ennemis posés depuis le rang `from` (décalages `offsets` dans cette série) :
   * allège le parcours à 1 joueur sans toucher aux autres effectifs. Les ennemis déjà dotés d'un `minPlayers` sont laissés tels quels.
   */
  restrict(from: number, offsets: readonly number[], minPlayers: number): this {
    for (const o of offsets) {
      const e = this.enemies[from + o];
      if (e && e.minPlayers === undefined) this.enemies[from + o] = { ...e, minPlayers };
    }
    return this;
  }

  /** Décors du même type près des tuiles demandées. */
  decor(type: DecorDef['type'], ...tiles: TileXY[]): this {
    for (const [x, y] of tiles) this.decors.push({ type, tile: this.snap(x, y, false) });
    return this;
  }

  /** Brasero ALLUMÉ (point de recharge de torche, lumière permanente) près de (x, y). */
  lit(id: string, x: number, y: number, lightRadiusTiles?: number): this {
    this.fires.push({
      id,
      type: 'brazier',
      tile: this.snap(x, y, false),
      lit: true,
      labelKey: mechLabel(this.roomId, 'fire'),
      ...(lightRadiusTiles === undefined ? {} : { lightRadiusTiles }),
    });
    return this;
  }

  /**
   * Brasero ÉTEINT à allumer (`interact`, torche non vide) ; `ownerSlot`/`minPlayers` : coop adaptative. Posé EXACTEMENT sur (x, y)
   * (ignore les zones interdites, qui servent justement à le protéger) tant que la tuile est du sol libre.
   */
  unlit(
    id: string,
    label: string,
    x: number,
    y: number,
    extra: { ownerSlot?: number; minPlayers?: number; lightRadiusTiles?: number; litLabel?: string } = {},
  ): this {
    // `litLabel` : suffixe de la clé du libellé « allumé » (défaut `fire` : celui des braseros de recharge de la salle)
    const { litLabel = 'fire', ...rest } = extra;
    const g = this.rows[y]?.[x];
    let tile: TileXY;
    if ((g === '.' || g === ',') && !this.used.has(y * 1000 + x)) {
      this.used.add(y * 1000 + x);
      tile = [x, y];
    } else {
      tile = this.snap(x, y, false);
    }
    this.fires.push({ id, type: 'brazier', tile, labelKey: mechLabel(this.roomId, label), litLabelKey: mechLabel(this.roomId, litLabel), ...rest });
    return this;
  }

  /** Panneau de salle (`sign.level5.<roomId>.<name>`), posé sur la tuile de sol libre la plus proche de (x, y). */
  sign(name: string, x: number, y: number): SignDef {
    return { id: `${this.roomId}.${name}`, tile: this.snap(x, y, false), textKey: `sign.level5.${this.roomId}.${name}` };
  }

  /** Ennemis finaux : les paliers `minPlayers` non précisés sont répartis selon le cycle de leur type (`KIND_TIERS`). */
  tiered(): EnemySpawnDef[] {
    return this.enemies.map((e) => {
      if (e.minPlayers !== undefined) return e;
      const cycle = KIND_TIERS[e.kind];
      if (!cycle) return e;
      const i = tierCursor.get(e.kind) ?? 0;
      tierCursor.set(e.kind, i + 1);
      const tier = cycle[i % cycle.length];
      return tier === 1 ? e : { ...e, minPlayers: tier };
    });
  }
}

/** Torches/bannières accrochées au mur nord (ou sud) d'une salle : une tous les `step` tuiles le long de `area`. */
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

/** Décors `torch` posés à des tuiles précises (mur ou sol) : éclairent un peu (3 tuiles) les épreuves des salles sombres. */
function torchesAt(rows: readonly string[], ...tiles: TileXY[]): DecorDef[] {
  return tiles.map(([x, y]) => {
    if (rows[y]?.[x] === undefined) throw new Error(`level5 : torche hors grille [${x},${y}]`);
    return { type: 'torch' as const, tile: [x, y] as TileXY };
  });
}

/** Les quatre couleurs de slot, dans l'ordre des slots 0..3 (bleu, rouge, vert, jaune). */
const COLORS = ['Blue', 'Red', 'Green', 'Yellow'] as const;

/** Tuiles d'une porte rectangulaire dont le coin haut-gauche est (x, y). */
function doorTiles(x: number, y: number, w = 2, h = 2): TileXY[] {
  const out: TileXY[] = [];
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) out.push([xx, yy]);
  return out;
}

/** Herse verticale : `h` tuiles de la colonne `x` à partir de la ligne `y`, dans l'ordre de fermeture (de haut en bas). */
function gateColumn(x: number, y: number, h = 3): TileXY[] {
  return Array.from({ length: h }, (_, i) => [x, y + i] as TileXY);
}

/** Clé d'étiquette de mécanisme : `mech.level5.<roomId>.<mechanismId>`. */
function mechLabel(room: string, mechanismId: string): string {
  return `mech.level5.${room}.${mechanismId}`;
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

/** Nom, indice d'arrivée : clés `room.level5.<id>.name` et `hintroom.level5.<id>`. */
function roomKeys(id: string): { nameKey: string; introHintKey: string } {
  return { nameKey: `room.level5.${id}.name`, introHintKey: `hintroom.level5.${id}` };
}

/** Zone interdite 3×3 autour d'une tuile. */
function at(t: TileXY): TileRect {
  return rect(t[0] - 1, t[1] - 1, 3, 3);
}

/** Zone interdite carrée de rayon `r` tuiles autour d'une tuile : aucun ennemi près du levier de relais (le coéquipier resté en arrière en dépend). */
function around(t: TileXY, r: number): TileRect {
  return rect(t[0] - r, t[1] - r, 2 * r + 1, 2 * r + 1);
}

/** Rayon (tuiles) de la zone sans ennemi autour du levier voisin de la herse. */
const RELAY_CLEAR = 5;

/** Mélanges d'ennemis (la braise : limons de lave, chauves-souris de feu, feux follets, gardiens de forge…). */
const FODDER: readonly EnemyKind[] = ['bat', 'slime', 'bat', 'slime', 'skeleton', 'bat', 'slime', 'skeleton', 'archer', 'wisp'];
const MIXED: readonly EnemyKind[] = ['bat', 'skeleton', 'slime', 'bat', 'spider', 'slime', 'skeleton', 'archer', 'bat', 'wisp', 'slime', 'knight'];
const HARD: readonly EnemyKind[] = ['skeleton', 'bat', 'slime', 'archer', 'knight', 'bat', 'spider', 'wisp', 'skeleton', 'bat', 'slime', 'archer'];

/**
 * Sablier d'une herse verticale à `gateX`, `gateY..gateY+2`. `levers[0]` : levier du côté de l'arrivée, LOIN de la herse (≈ 25 tuiles) ;
 * `levers[1]` : levier de l'autre côté, près de la herse (6 à 9 tuiles). `periodMs` court (4 s) : voir l'en-tête du fichier.
 */
function hourglass(
  roomId: string,
  id: string,
  gateX: number,
  gateY: number,
  levers: [TileXY, TileXY],
  periodMs: number,
  closeStepMs: number,
  displayTile: TileXY,
): MechanismDef {
  return {
    id,
    type: 'hourglass',
    levers,
    gate: gateColumn(gateX, gateY),
    periodMs,
    closeStepMs,
    displayTile,
    labelKey: mechLabel(roomId, id),
  };
}

// ───────────────────────────── Salle 1 : Le Vestibule des Cendres ─────────────────────────────
//
// 64×42. APPRENTISSAGE CALME du sablier. Le hall ouest (arrivée) est vide ; un couloir de 3 tuiles mène à la herse [27, 19..21] ;
// derrière, un grand hall est où rôdent quelques créatures faibles. Sable de 4 s (8 s en solo) et herse lente (0,4 s par tuile).
// Levier ouest [3,11] dans le coin nord-ouest du hall (≈ 26 tuiles de la herse), levier est [36,20] à 9 tuiles de la herse.
// Résolution : tous se postent devant la herse ; un héros (le « tenant ») retourne le levier lointain, les autres franchissent la
// herse pendant les 4 s ; le tenant, resté en arrière, rejoint la herse en 6 s : le héros passé en dernier retourne le levier est
// pour lui ouvrir le passage (relais) ; on bat les gardiens (clear) et tous rejoignent la sortie [55..58, 17..22]. En solo :
// retourner le levier lointain puis courir (période doublée).

const ashgate: RoomDef = (() => {
  const spawn: TileXY = [3, 20];
  const levers: [TileXY, TileXY] = [
    [3, 11],
    [36, 20],
  ];
  const b = new LayoutBuilder(64, 42)
    .floor(2, 10, 22, 22) // hall ouest x2..23, y10..31
    .floor(24, 19, 8, 3) // couloir de la herse x24..31, y19..21
    .floor(32, 6, 28, 30) // hall est x32..59, y6..35
    .reserve(rect(2, 16, 8, 10), rect(2, 10, 5, 5), rect(22, 17, 12, 7), rect(34, 17, 6, 7), rect(53, 15, 7, 9))
    .pillarGrid(rect(4, 11, 19, 20), 5, 5, 2, 2)
    .pillarGrid(rect(34, 7, 24, 28), 5, 5, 2, 2);
  const rows = b.rows();
  const p = new Placer('ashgate', rows, spawn, [rect(22, 17, 12, 7), at(levers[0]), around(levers[1], RELAY_CLEAR), rect(53, 15, 7, 9)]);
  p.scatter(rect(41, 7, 18, 28), FODDER, 20);
  return {
    id: 'ashgate',
    ...roomKeys('ashgate'),
    theme: 'ember',
    layout: rows,
    playerSpawns: spawns(...spawn),
    enemies: p.tiered(),
    mechanisms: [hourglass('ashgate', 'hgAsh', 27, 19, levers, 4000, 400, [25, 20])],
    signs: [p.sign('hourglass', 6, 13), p.sign('gate', 21, 18), p.sign('relay', 38, 18)],
    decor: [
      ...wallDecor(rows, 'torch', rect(2, 10, 22, 22), 6),
      ...wallDecor(rows, 'torch', rect(32, 6, 28, 30), 7),
      ...wallDecor(rows, 'banner', rect(32, 6, 28, 30), 9, 'north', 5),
      ...p.decor('crystal', [3, 11], [3, 30], [58, 7], [58, 34]).decor('statue', [23, 14], [23, 27]).decor('crate', [2, 10], [2, 31], [59, 6]).decors,
    ],
    exit: { rect: rect(55, 17, 4, 6), requires: ['clear'] },
  };
})();

// ───────────────────────────── Salle 2 : Les Fonderies de Scories ─────────────────────────────
//
// 74×46. Le sablier s'ouvre sur une immense FONDERIE (42×40) pleine de gardiens, de lave et de piliers. La herse [28, 22..24] est
// à ≈ 27 tuiles du levier ouest [3,15] (coin nord-ouest du hall) et à 9 tuiles du levier est [37,23] ; sable 4 s (8 s en solo),
// herse 0,3 s par tuile. Les premières bandes de gardiens sont à ≈ 10 tuiles de la herse : franchir le passage, c'est entrer dans
// le combat ; le héros qui retourne le levier est se bat près de lui, dans la zone sans ennemi qui l'entoure.
// Résolution : relais comme à l'apprentissage ; la fonderie est nettoyée (clear) ; sortie [66..70, 20..25] à l'est.

const slagworks: RoomDef = (() => {
  const spawn: TileXY = [3, 23];
  const levers: [TileXY, TileXY] = [
    [3, 15],
    [37, 23],
  ];
  const b = new LayoutBuilder(74, 46)
    .floor(2, 14, 20, 20) // hall ouest x2..21, y14..33
    .floor(22, 22, 8, 3) // couloir de la herse x22..29, y22..24
    .floor(30, 4, 42, 40) // fonderie x30..71, y4..43
    .pit(38, 9, 6, 5)
    .pit(38, 33, 6, 5)
    .pit(52, 12, 10, 4)
    .pit(52, 31, 10, 4)
    .pit(46, 20, 3, 7)
    .reserve(rect(2, 19, 9, 9), rect(2, 14, 5, 5), rect(20, 19, 12, 9), rect(32, 20, 7, 7), rect(64, 18, 8, 10))
    .pillarGrid(rect(4, 15, 17, 18), 5, 5, 2, 2)
    .pillarGrid(rect(32, 5, 38, 38), 6, 5, 2, 2);
  const rows = b.rows();
  const p = new Placer('slagworks', rows, spawn, [rect(20, 19, 12, 9), at(levers[0]), around(levers[1], RELAY_CLEAR), rect(64, 18, 8, 10)]);
  p.scatter(rect(38, 5, 32, 38), MIXED, 46);
  return {
    id: 'slagworks',
    ...roomKeys('slagworks'),
    theme: 'ember',
    layout: rows,
    playerSpawns: spawns(...spawn),
    enemies: p.tiered(),
    mechanisms: [hourglass('slagworks', 'hgSlag', 28, 22, levers, 4000, 300, [26, 23])],
    signs: [p.sign('hourglass', 6, 17), p.sign('foundry', 21, 21), p.sign('guard', 33, 20)],
    decor: [
      ...wallDecor(rows, 'torch', rect(2, 14, 20, 20), 6),
      ...wallDecor(rows, 'torch', rect(30, 4, 42, 40), 7),
      ...wallDecor(rows, 'banner', rect(30, 4, 42, 40), 11, 'north', 6),
      ...p.decor('crystal', [3, 15], [3, 32], [70, 5], [70, 42]).decor('statue', [21, 15], [21, 32]).decor('bones', [36, 15], [60, 36], [44, 24]).decor('crate', [2, 14], [2, 33], [71, 4]).decors,
    ],
    exit: { rect: rect(66, 20, 5, 6), requires: ['clear'] },
  };
})();

// ───────────────────────────── Salle 3 : Le Creuset des Deux Passages ─────────────────────────────
//
// 86×48. DEUX sabliers qui se succèdent : chambre A (arrivée) → herse A [26, 22..24] → grande chambre B (combat) → herse B
// [61, 22..24] → chambre C (sortie). Leviers : A [3,14] (coin de la chambre A, ≈ 25 tuiles) / [31,23] (5 tuiles) ; B [35,23] (≈ 26 tuiles,
// dans la chambre de combat) / [70,23] (9 tuiles). Sable 4 s (8 s en solo), herse 0,3 s par tuile. Dans la chambre B, un héros (objectif slot 1 « hold », rouge) doit tenir la zone du creuset [41..43, 21..23]
// 8 s cumulées ; ce n'est qu'ensuite qu'on peut sortir (exit exige `obj:hold`).
// Résolution : relais à la herse A ; on nettoie la chambre B (les gardiens de C attendent derrière la herse B) pendant que le héros
// rouge tient le creuset ; relais à la herse B ; on nettoie la chambre C et tous rejoignent la sortie [77..81, 20..25].

const crucible: RoomDef = (() => {
  const spawn: TileXY = [3, 23];
  const leversA: [TileXY, TileXY] = [
    [3, 14],
    [31, 23],
  ];
  const leversB: [TileXY, TileXY] = [
    [35, 23],
    [70, 23],
  ];
  const b = new LayoutBuilder(86, 48)
    .floor(2, 14, 18, 20) // chambre A x2..19, y14..33
    .floor(20, 22, 8, 3) // couloir A x20..27, y22..24
    .floor(28, 4, 30, 40) // chambre B x28..57, y4..43
    .floor(58, 22, 8, 3) // couloir B x58..65, y22..24
    .floor(66, 12, 18, 24) // chambre C x66..83, y12..35
    .pit(34, 8, 6, 5)
    .pit(34, 35, 6, 5)
    .pit(46, 9, 8, 4)
    .pit(46, 34, 8, 4)
    .pit(72, 16, 4, 3)
    .pit(72, 31, 4, 3)
    .reserve(
      rect(2, 19, 9, 9),
      rect(2, 13, 5, 5),
      rect(18, 19, 12, 9),
      rect(29, 20, 10, 7),
      rect(56, 19, 12, 9),
      rect(67, 20, 6, 7),
      rect(40, 20, 5, 5),
      rect(75, 18, 9, 11),
    )
    .pillarGrid(rect(4, 15, 15, 18), 5, 5, 2, 2)
    .pillarGrid(rect(30, 5, 26, 38), 6, 5, 2, 2)
    .pillarGrid(rect(68, 13, 15, 22), 5, 5, 2, 2);
  const rows = b.rows();
  const p = new Placer('crucible', rows, spawn, [
    rect(18, 19, 12, 9),
    rect(56, 19, 12, 9),
    at(leversA[0]),
    around(leversA[1], RELAY_CLEAR),
    around(leversB[0], RELAY_CLEAR),
    around(leversB[1], RELAY_CLEAR),
    rect(40, 20, 5, 5),
    rect(75, 18, 9, 11),
  ]);
  p.scatter(rect(34, 5, 22, 38), MIXED, 28); // chambre B
  p.scatter(rect(70, 13, 13, 22), HARD, 18); // chambre C
  return {
    id: 'crucible',
    ...roomKeys('crucible'),
    theme: 'ember',
    layout: rows,
    playerSpawns: spawns(...spawn),
    enemies: p.tiered(),
    mechanisms: [
      hourglass('crucible', 'hgForgeA', 26, 22, leversA, 4000, 300, [24, 23]),
      hourglass('crucible', 'hgForgeB', 61, 22, leversB, 4000, 300, [59, 23]),
    ],
    zones: [{ id: 'crucibleZone', rect: rect(41, 21, 3, 3) }],
    signs: [p.sign('hourglass', 6, 16), p.sign('second', 38, 20), p.sign('hold', 38, 26)],
    decor: [
      ...wallDecor(rows, 'torch', rect(2, 14, 18, 20), 6),
      ...wallDecor(rows, 'torch', rect(28, 4, 30, 40), 7),
      ...wallDecor(rows, 'torch', rect(66, 12, 18, 24), 6),
      ...wallDecor(rows, 'banner', rect(28, 4, 30, 40), 10, 'north', 5),
      ...p.decor('crystal', [40, 20], [44, 20], [40, 26], [44, 26], [3, 15], [82, 13]).decor('statue', [19, 15], [19, 32], [57, 5], [57, 42]).decor('bones', [50, 24], [76, 24]).decor('crate', [2, 14], [83, 12], [83, 35]).decors,
    ],
    exit: { rect: rect(77, 20, 5, 6), requires: ['clear', 'obj:hold'] },
  };
})();

// ───────────────────────────── Salle 4 : Le Porche du Brasier ─────────────────────────────
//
// 82×46. Plaques SIMULTANÉES + sablier, sous la menace. Dans le hall d'arrivée, quatre plaques colorées (bleue min 1, rouge min 2,
// verte min 3, jaune min 4) : tenues ensemble, elles ouvrent la porte [33, 21..23] (définitivement). Derrière : l'antichambre puis
// la herse [52, 21..23] qui donne sur la grande forge, peuplée de gardiens. Le levier ouest [27,16] est dans le hall (≈ 27 tuiles de
// course jusqu'à la herse, par la porte), le levier est [60,22] à 8 tuiles de la herse ; sable 4 s (8 s en solo), herse 0,3 s par tuile.
// La sortie [75..78, 19..25] exige que tout soit vaincu (`clear`).
// Résolution : chaque héros tient la plaque de sa couleur ; la porte s'ouvre ; on nettoie le hall et l'antichambre AVANT de passer
// (rien ne reste derrière une herse close) ; relais au sablier ; on bat les gardiens de la forge et tous rejoignent la sortie.

const pyre: RoomDef = (() => {
  const spawn: TileXY = [3, 22];
  const plates: Record<(typeof COLORS)[number], TileXY> = { Blue: [26, 12], Red: [26, 32], Green: [9, 9], Yellow: [9, 36] };
  const levers: [TileXY, TileXY] = [
    [27, 16],
    [60, 22],
  ];
  const b = new LayoutBuilder(82, 46)
    .floor(2, 8, 30, 30) // hall x2..31, y8..37
    .floor(32, 21, 4, 3) // couloir de la porte x32..35 (porte x33)
    .floor(36, 14, 14, 18) // antichambre x36..49, y14..31
    .floor(50, 21, 6, 3) // couloir de la herse x50..55
    .floor(56, 6, 24, 34) // forge x56..79, y6..39
    .pit(62, 9, 5, 5)
    .pit(62, 32, 5, 5)
    .pit(70, 15, 3, 3)
    .pit(70, 28, 3, 3)
    .reserve(
      rect(2, 18, 9, 9),
      ...Object.values(plates).map(at),
      rect(30, 19, 8, 7),
      rect(25, 14, 5, 5),
      rect(48, 19, 10, 7),
      rect(57, 19, 6, 7),
      rect(73, 17, 7, 11),
    )
    .pillarGrid(rect(4, 9, 27, 28), 5, 5, 2, 2)
    .pillarGrid(rect(37, 15, 12, 16), 5, 5, 2, 2)
    .pillarGrid(rect(58, 7, 21, 32), 6, 5, 2, 2);
  const rows = b.rows();
  const p = new Placer('pyre', rows, spawn, [
    ...Object.values(plates).map(at),
    rect(30, 19, 8, 7),
    at(levers[0]),
    around(levers[1], RELAY_CLEAR),
    rect(48, 19, 10, 7),
    rect(73, 17, 7, 11),
  ]);
  p.scatter(rect(13, 9, 17, 28), FODDER, 10); // hall
  p.scatter(rect(37, 15, 12, 16), MIXED, 8); // antichambre
  p.scatter(rect(58, 7, 20, 32), HARD, 16); // forge
  const mechanisms: MechanismDef[] = COLORS.map((color, slot): MechanismDef => {
    const base = { id: `plate${color}`, type: 'plate' as const, tile: plates[color], colorSlot: slot, labelKey: mechLabel('pyre', `plate${color}`) };
    return slot === 0 ? base : { ...base, minPlayers: slot + 1 };
  });
  mechanisms.push(
    {
      id: 'pyreDoor',
      type: 'door',
      tiles: doorTiles(33, 21, 1, 3),
      requires: COLORS.map((c) => `plate${c}`),
      labelKey: mechLabel('pyre', 'pyreDoor'),
    },
    hourglass('pyre', 'hgPyre', 52, 21, levers, 4000, 300, [51, 22]),
  );
  return {
    id: 'pyre',
    ...roomKeys('pyre'),
    theme: 'ember',
    layout: rows,
    playerSpawns: spawns(...spawn),
    enemies: p.tiered(),
    mechanisms,
    signs: [p.sign('plates', 7, 20), p.sign('door', 29, 22), p.sign('hourglass', 29, 15)],
    decor: [
      ...wallDecor(rows, 'torch', rect(2, 8, 30, 30), 6),
      ...wallDecor(rows, 'torch', rect(56, 6, 24, 34), 6),
      ...wallDecor(rows, 'banner', rect(36, 14, 14, 18), 5, 'north', 2),
      ...p.decor('crystal', [26, 11], [26, 33], [9, 10], [9, 35]).decor('statue', [31, 9], [31, 36], [56, 7], [56, 38]).decor('bones', [18, 22], [66, 22]).decor('crate', [2, 8], [2, 37], [79, 6], [79, 39]).decors,
    ],
    exit: { rect: rect(75, 19, 4, 7), requires: ['clear'] },
  };
})();

// ───────────────────────────── Salle 5 : La Fosse du Pyromancien (DEMI-BOSS 1) ─────────────────────────────
//
// 72×46. Salle de demi-boss PURE (aucun mécanisme), à mi-parcours : une vaste arène de lave et de piliers de couverture où le
// pyromancien garde ses distances (boules de feu en éventail, nova télégraphée, feux follets invoqués) et où rôdent ses sbires
// (leur nombre suit les joueurs). Toute l'arène est UN seul espace ouvert : le pyromancien se téléporte n'importe où dans la salle
// (moteur), il ne peut donc jamais se retrouver coupé des héros. La sortie (alcôve nord [32..39, 1..2]) exige sa défaite (`clear`).
// Résolution : se couvrir derrière les piliers, déborder le pyromancien (le coller le contraint à se téléporter), vaincre ses sbires.

const cinderpit: RoomDef = (() => {
  const spawn: TileXY = [3, 22];
  const b = new LayoutBuilder(72, 46)
    .floor(2, 4, 68, 38) // arène x2..69, y4..41
    .floor(32, 1, 8, 3) // alcôve de la sortie (nord)
    .pit(14, 8, 5, 5)
    .pit(14, 33, 5, 5)
    .pit(34, 6, 4, 4)
    .pit(34, 32, 4, 4)
    .pit(46, 15, 4, 3)
    .pit(46, 28, 4, 3)
    .pit(58, 9, 5, 4)
    .pit(58, 33, 5, 4)
    .pillarBlock(24, 13)
    .pillarBlock(24, 29)
    .pillarBlock(40, 20)
    .pillarBlock(52, 12)
    .pillarBlock(52, 30)
    .pillarBlock(62, 20)
    .pillar([20, 20], [20, 23], [30, 24], [44, 8], [44, 36], [56, 22], [66, 12], [66, 32]);
  const rows = b.rows();
  const p = new Placer('cinderpit', rows, spawn, [rect(30, 1, 12, 5)]);
  p.foe('pyromancer', 62, 22, { minPlayers: 1 });
  p.scatter(rect(18, 5, 50, 36), HARD, 28);
  return {
    id: 'cinderpit',
    ...roomKeys('cinderpit'),
    theme: 'ember',
    layout: rows,
    playerSpawns: spawns(...spawn),
    enemies: p.tiered(),
    mechanisms: [],
    signs: [p.sign('pyromancer', 7, 20), p.sign('cover', 12, 26)],
    decor: [
      ...wallDecor(rows, 'torch', rect(2, 4, 68, 38), 8),
      ...wallDecor(rows, 'banner', rect(2, 4, 68, 38), 12, 'north', 6),
      ...p.decor('crystal', [32, 1], [39, 1], [2, 5], [69, 40]).decor('statue', [2, 40], [69, 5]).decor('bones', [28, 18], [56, 26], [66, 22]).decor('crate', [2, 4], [2, 41], [69, 41]).decors,
    ],
    // Cristaux de soin (sources de vie fixes, usage unique, 50 PV) : loin des arrivées et du départ du boss ; le 3e exige 3 joueurs.
    healCrystals: [
      { id: 'cinderpit_heal1', tile: [24, 10] },
      { id: 'cinderpit_heal2', tile: [24, 36] },
      { id: 'cinderpit_heal3', tile: [44, 6], minPlayers: 3 },
    ],
    exit: { rect: rect(32, 1, 8, 2), requires: ['clear'] },
  };
})();


// ───────────────────────────── Salle 6 : La Forge Aveugle (SOMBRE) ─────────────────────────────
//
// 80×48. Salle SOMBRE : seuls les braseros allumés et quelques torches éclairent ; la torche personnelle (75 s) se recharge aux braseros
// allumés (Action). Le hall ouest (arrivée, lumière de braseros) mène à la herse [27, 22..24] (levier ouest [3,13] au coin nord-ouest,
// éclairé par un brasero et une torche, ≈ 26 tuiles de la herse ; levier est [36,23] ; sable 4 s, 8 s en solo) ;
// derrière, un immense hall est dans le noir où brûlent quatre braseros ÉTEINTS, un par héros et par couleur (bleu min 1 [42,8], rouge min 2
// [66,8], vert min 3 [42,39], jaune min 4 [66,39]) : tous allumés, ils ouvrent la porte de la forge [73, 21..23] vers la sortie.
// Objectif slot 3 « torch » (jaune) : allumer son brasero (à moins de 4 joueurs, le brasero jaune est neutralisé : objectif accompli d'office).
// Résolution : relais au sablier ; chacun recharge sa torche si besoin puis allume SON brasero ; on bat les gardiens (clear) ; sortie
// [75..77, 21..23] derrière la porte.

const blindforge: RoomDef = (() => {
  const spawn: TileXY = [3, 23];
  const levers: [TileXY, TileXY] = [
    [3, 13],
    [36, 23],
  ];
  const colorTiles: TileXY[] = [
    [42, 8],
    [66, 8],
    [42, 39],
    [66, 39],
  ];
  const b = new LayoutBuilder(80, 48)
    .floor(2, 12, 22, 24) // hall ouest x2..23, y12..35
    .floor(24, 22, 8, 3) // couloir de la herse x24..31, y22..24
    .floor(32, 4, 40, 40) // hall est x32..71, y4..43
    .floor(72, 21, 6, 3) // couloir de la porte x72..77 (porte x73)
    .pit(44, 13, 6, 4)
    .pit(44, 31, 6, 4)
    .pit(56, 20, 5, 6)
    .reserve(
      rect(2, 18, 10, 10),
      rect(2, 12, 5, 5),
      rect(22, 19, 12, 9),
      rect(34, 20, 6, 7),
      ...colorTiles.map(at),
      rect(66, 19, 12, 9),
    )
    .pillarGrid(rect(4, 13, 19, 22), 5, 5, 2, 2)
    .pillarGrid(rect(34, 5, 36, 38), 6, 5, 2, 2);
  const rows = b.rows();
  const p = new Placer('blindforge', rows, spawn, [rect(22, 19, 12, 9), at(levers[0]), around(levers[1], RELAY_CLEAR), ...colorTiles.map(at), rect(66, 19, 12, 9)]);
  // braseros allumés (recharge de torche) : départ, avant la herse, hall est ; puis les quatre braseros de couleur à allumer
  p.lit('darkFire1', 8, 21)
    .lit('darkFire2', 20, 28)
    .lit('darkFire8', 6, 14)
    .lit('darkFire3', 37, 16)
    .lit('darkFire4', 37, 31)
    .lit('darkFire5', 54, 10)
    .lit('darkFire6', 54, 37)
    .lit('darkFire7', 68, 22);
  COLORS.forEach((color, slot) => {
    p.unlit(`brazier${color}`, `brazier${color}`, colorTiles[slot][0], colorTiles[slot][1], {
      litLabel: `brazier${color}Lit`,
      ownerSlot: slot,
      lightRadiusTiles: 4,
      ...(slot === 0 ? {} : { minPlayers: slot + 1 }),
    });
  });
  p.scatter(rect(36, 5, 34, 38), HARD, 42);
  return {
    id: 'blindforge',
    ...roomKeys('blindforge'),
    theme: 'ember',
    layout: rows,
    playerSpawns: spawns(...spawn),
    enemies: p.tiered(),
    mechanisms: [
      ...p.fires,
      hourglass('blindforge', 'hgDark', 27, 22, levers, 4000, 300, [25, 23]),
      {
        id: 'hearthDoor',
        type: 'door',
        tiles: doorTiles(73, 21, 1, 3),
        requires: COLORS.map((c) => `brazier${c}`),
        labelKey: mechLabel('blindforge', 'hearthDoor'),
      },
    ],
    signs: [p.sign('dark', 7, 22), p.sign('hourglass', 6, 16), p.sign('braziers', 38, 21), p.sign('door', 69, 20)],
    decor: [
      // salle sombre : torches près des épreuves (herse, leviers, braseros de couleur, porte)
      ...torchesAt(
        rows,
        [26, 21], // couloir de la herse
        [28, 25],
        [4, 11], // levier ouest (coin nord-ouest)
        [37, 22], // levier est
        [41, 7], // braseros de couleur
        [67, 7],
        [41, 40],
        [67, 40],
        [72, 20], // porte
        [72, 24],
        [5, 21], // arrivée
        [5, 26],
      ),
      ...wallDecor(rows, 'banner', rect(32, 4, 40, 40), 11, 'north', 5),
      ...p.decor('crystal', [3, 13], [3, 34], [70, 5], [70, 42]).decor('statue', [23, 13], [23, 34]).decor('bones', [40, 24], [62, 14]).decor('crate', [2, 12], [2, 35], [71, 4], [71, 43]).decors,
    ],
    exit: { rect: rect(75, 21, 3, 3), requires: ['hearthDoor', 'clear', 'obj:torch'] },
    dark: true,
  };
})();

// ───────────────────────────── Salle 7 : Les Soufflets de la Forge ─────────────────────────────
//
// 86×52. BLOC 2×2 + sablier. Arrivée à l'ouest ; la herse [26, 28..30] (levier ouest [3,20] au coin nord-ouest, ≈ 25 tuiles ; levier est
// [35,29] à 9 tuiles ; sable 4 s, 8 s en solo) donne sur le hall des
// soufflets. Là, un bloc 2×2 [44,29] attend à l'entrée d'un COULOIR fermé (y29..30, 32 tuiles) au fond duquel est le socle [74,29] ;
// deux héros le poussent ensemble (un seul à 1 joueur), ≈ 11 s de poussée continue. Les galeries nord et sud (gardiens qui
// harcèlent) bordent le couloir sans y donner accès : aucun verrou. Socle rempli → la porte [74..75, 14..15] de la galerie nord
// s'ouvre sur la salle de sortie [76..81, 5..9]. Objectif slot 2 « slayer » : 5 coups fatals (accompli d'office si la salle est vidée).
// Résolution : relais au sablier ; on nettoie le hall et les galeries ; deux héros poussent le bloc jusqu'au socle ; la porte
// s'ouvre ; on bat les gardiens de la salle de sortie (clear) et tous rejoignent la sortie.

const bellows: RoomDef = (() => {
  const spawn: TileXY = [3, 28];
  const lane = rect(44, 29, 32, 2);
  const levers: [TileXY, TileXY] = [
    [3, 20],
    [35, 29],
  ];
  const b = new LayoutBuilder(86, 52)
    .floor(2, 20, 18, 18) // hall ouest x2..19, y20..37
    .floor(20, 28, 8, 3) // couloir de la herse x20..27, y28..30
    .floor(28, 12, 16, 36) // hall des soufflets x28..43, y12..47
    .floor(44, 29, 32, 2) // couloir du bloc x44..75, y29..30
    .floor(44, 16, 40, 11) // galerie nord x44..83, y16..26
    .floor(44, 33, 40, 14) // galerie sud x44..83, y33..46
    .floor(74, 12, 2, 4) // passage de la porte x74..75, y12..15
    .floor(60, 3, 24, 9) // salle de sortie x60..83, y3..11
    .reserve(
      rect(2, 24, 9, 9),
      rect(2, 19, 5, 5),
      rect(18, 25, 12, 9),
      rect(30, 26, 6, 7),
      rect(28, 26, 17, 8),
      rect(72, 10, 6, 8),
      rect(74, 3, 10, 9),
    )
    .pillarGrid(rect(4, 21, 15, 16), 5, 5, 2, 2)
    .pillarGrid(rect(29, 13, 14, 34), 5, 5, 2, 2)
    .pillarGrid(rect(45, 17, 38, 9), 6, 4, 2, 1)
    .pillarGrid(rect(45, 34, 38, 12), 6, 4, 2, 2)
    .pillarGrid(rect(61, 4, 22, 7), 5, 3, 2, 1);
  const rows = b.rows();
  const p = new Placer('bellows', rows, spawn, [lane, rect(18, 25, 12, 9), at(levers[0]), around(levers[1], RELAY_CLEAR), rect(28, 26, 17, 8), rect(72, 10, 6, 8), rect(72, 3, 12, 8)]);
  // Pas de feu follet ici : il se téléporte près des joueurs et pourrait atterrir dans le couloir fermé du bloc, hors d'atteinte
  // (un ennemi inaccessible empêcherait d'obtenir `clear` avant d'avoir poussé le bloc).
  const noWisp = (kinds: readonly EnemyKind[]): EnemyKind[] => kinds.map((k) => (k === 'wisp' ? 'bat' : k));
  p.scatter(rect(29, 13, 14, 34), noWisp(MIXED), 8); // hall des soufflets
  p.scatter(rect(46, 17, 36, 9), noWisp(MIXED), 12); // galerie nord
  p.scatter(rect(46, 34, 36, 12), noWisp(HARD), 12); // galerie sud
  p.scatter(rect(62, 4, 20, 7), noWisp(MIXED), 10); // salle de sortie (derrière la porte)
  return {
    id: 'bellows',
    ...roomKeys('bellows'),
    theme: 'ember',
    layout: rows,
    playerSpawns: spawns(...spawn),
    enemies: p.tiered(),
    mechanisms: [
      hourglass('bellows', 'hgBellows', 26, 28, levers, 4000, 300, [24, 29]),
      { id: 'bellowsBlock', type: 'block', tile: [44, 29], labelKey: mechLabel('bellows', 'bellowsBlock') },
      { id: 'bellowsSocket', type: 'socket', tile: [74, 29], blockId: 'bellowsBlock', labelKey: mechLabel('bellows', 'bellowsSocket') },
      {
        id: 'bellowsDoor',
        type: 'door',
        tiles: doorTiles(74, 14),
        requires: ['bellowsSocket'],
        labelKey: mechLabel('bellows', 'bellowsDoor'),
      },
    ],
    signs: [p.sign('hourglass', 6, 22), p.sign('block', 38, 28), p.sign('guard', 38, 34), p.sign('quota', 21, 26)],
    decor: [
      ...wallDecor(rows, 'torch', rect(2, 20, 18, 18), 6),
      ...wallDecor(rows, 'torch', rect(28, 12, 16, 36), 7),
      ...wallDecor(rows, 'torch', rect(44, 16, 40, 11), 8),
      ...wallDecor(rows, 'banner', rect(60, 3, 24, 9), 8, 'north', 4),
      ...p.decor('crystal', [3, 21], [3, 36], [82, 4], [82, 10]).decor('statue', [19, 21], [19, 36], [43, 13], [43, 46]).decor('bones', [50, 20], [60, 40], [70, 8]).decor('crate', [2, 20], [2, 37], [83, 16], [83, 46]).decors,
    ],
    exit: { rect: rect(76, 5, 6, 5), requires: ['bellowsDoor', 'clear', 'obj:slayer'] },
  };
})();

// ───────────────────────────── Salle 8 : Le Donjon des Braises (DEMI-BOSS 2) ─────────────────────────────
//
// 86×48. CLÉS PERSONNELLES + second DEMI-BOSS, dans une salle clé tardive. Le grand hall d'arrivée (44×36, lave et piliers) abrite
// quatre clés personnelles, une par coin : bleue [7,9], rouge [40,9], verte [7,38], jaune [40,38] ; leurs quatre portes (2×2) donnent
// sur l'arène du pyromancien à l'est (portes [46..47] y15, 20, 25, 30). Chaque héros ne ramasse QUE sa clé et n'ouvre QUE sa porte.
// Objectif slot 0 « seal » : ouvrir la porte bleue. Les portes, clés et gardiens des slots 1..3 suivent `minPlayers`.
// Le pyromancien est au fond de l'arène (≥ 30 tuiles des portes) : il n'entre en combat qu'une fois les héros dans l'arène.
// Tout est UN seul espace ouvert une fois les portes levées : ses téléportations (moteur) ne le coupent jamais des héros.
// Résolution : chacun sa clé puis sa porte ; une fois les quatre portes ouvertes, tous contre le pyromancien et ses sbires (clear)
// puis sortie [76..81, 30..35].

const emberhold: RoomDef = (() => {
  const spawn: TileXY = [3, 23];
  const keyTiles: TileXY[] = [
    [7, 9],
    [40, 9],
    [7, 38],
    [40, 38],
  ];
  const doorTop = [15, 20, 25, 30];
  const b = new LayoutBuilder(86, 48)
    .floor(2, 6, 44, 36) // grand hall x2..45, y6..41
    .floor(46, 15, 2, 2) // passages des quatre portes
    .floor(46, 20, 2, 2)
    .floor(46, 25, 2, 2)
    .floor(46, 30, 2, 2)
    .floor(48, 8, 36, 32) // arène x48..83, y8..39
    .pit(16, 12, 6, 4)
    .pit(16, 31, 6, 4)
    .pit(28, 19, 5, 6)
    .pit(58, 14, 5, 4)
    .pit(58, 28, 5, 4)
    .pit(68, 20, 4, 4)
    .pit(74, 10, 4, 3)
    .reserve(rect(2, 19, 9, 9), ...keyTiles.map(at), rect(43, 13, 7, 22), rect(74, 28, 10, 10))
    .pillarGrid(rect(4, 7, 40, 34), 6, 5, 2, 2)
    .pillarGrid(rect(50, 9, 33, 30), 6, 5, 2, 2);
  const rows = b.rows();
  const p = new Placer('emberhold', rows, spawn, [...keyTiles.map(at), rect(43, 13, 7, 22), rect(74, 28, 10, 10)]);
  // gardiens des clés (mêmes paliers que leurs clés), puis le hall
  p.foe('skeleton', 11, 11)
    .foe('bat', 36, 11, { minPlayers: 2 })
    .foe('archer', 11, 36, { minPlayers: 3 })
    .foe('spider', 36, 36, { minPlayers: 4 });
  const hallFrom = p.enemies.length;
  p.scatter(rect(12, 7, 32, 34), MIXED, 20); // hall
  p.restrict(hallFrom, [5, 13], 2); // 2 sbires du hall n'arrivent qu'à 2 joueurs
  p.foe('pyromancer', 79, 16, { minPlayers: 1 });
  const arenaFrom = p.enemies.length;
  p.scatter(rect(52, 9, 30, 30), HARD, 18); // arène
  p.restrict(arenaFrom, [2, 8, 14], 2); // 3 sbires de l'arène n'arrivent qu'à 2 joueurs
  const mechanisms: MechanismDef[] = [];
  COLORS.forEach((color, slot) => {
    const extra = slot === 0 ? {} : { minPlayers: slot + 1 };
    mechanisms.push({
      id: `key${color}`,
      type: 'key',
      tile: keyTiles[slot],
      ownerSlot: slot,
      doorId: `door${color}`,
      labelKey: mechLabel('emberhold', `key${color}`),
      ...extra,
    });
    mechanisms.push({
      id: `door${color}`,
      type: 'door',
      tiles: doorTiles(46, doorTop[slot]),
      requires: [],
      keyId: `key${color}`,
      labelKey: mechLabel('emberhold', `door${color}`),
      ...extra,
    });
  });
  return {
    id: 'emberhold',
    ...roomKeys('emberhold'),
    theme: 'ember',
    layout: rows,
    playerSpawns: spawns(...spawn),
    enemies: p.tiered(),
    mechanisms,
    signs: [p.sign('keys', 8, 20), p.sign('doors', 41, 23), p.sign('pyromancer', 50, 22)],
    decor: [
      ...wallDecor(rows, 'torch', rect(2, 6, 44, 36), 7),
      ...wallDecor(rows, 'torch', rect(48, 8, 36, 32), 7),
      ...wallDecor(rows, 'banner', rect(48, 8, 36, 32), 10, 'north', 5),
      ...p.decor('crystal', [3, 7], [44, 7], [3, 40], [44, 40]).decor('statue', [45, 15], [45, 32], [48, 9], [48, 38]).decor('bones', [22, 24], [62, 24]).decor('crate', [2, 6], [2, 41], [83, 8], [83, 39]).decors,
    ],
    // Cristaux de soin (sources de vie fixes, usage unique, 50 PV) : loin des arrivées et du départ du boss ; le 3e exige 3 joueurs.
    healCrystals: [
      { id: 'emberhold_heal1', tile: [26, 33] },
      { id: 'emberhold_heal2', tile: [62, 12] },
      { id: 'emberhold_heal3', tile: [62, 36], minPlayers: 3 },
    ],
    exit: { rect: rect(76, 30, 6, 6), requires: ['doorBlue', 'doorRed', 'doorGreen', 'doorYellow', 'clear', 'obj:seal'] },
  };
})();


// ───────────────────────────── Salle 9 : Le Cœur de la Forge (BOSS) ─────────────────────────────
//
// 58×44. Salle de boss PURE (aucun mécanisme) : grande arène aux piliers 2×2 de couverture (qui arrêtent les projectiles), quelques
// mares de lave et une alcôve au nord qui contient la sortie finale, SCELLÉE : elle exige le Seigneur de la Forge vaincu (`clear`) et les
// quatre objectifs personnels. Le Seigneur de la Forge (marteau + onde de choc, rafales de boules de feu, chevaliers invoqués, enrage
// à la phase 3) apparaît à l'est ; les héros arrivent à l'ouest.
// Résolution : se couvrir derrière les piliers, vaincre le Seigneur de la Forge ; la sortie [25..32, 1..2] s'ouvre, tous s'y rejoignent.

const forgeheart: RoomDef = (() => {
  const b = new LayoutBuilder(58, 44)
    .floor(1, 3, 56, 38) // arène x1..56, y3..40
    .floor(25, 1, 8, 2) // alcôve de la sortie finale
    .pit(1, 3, 3, 3)
    .pit(54, 3, 3, 3)
    .pit(1, 38, 3, 3)
    .pit(54, 38, 3, 3)
    .pillarBlock(11, 8)
    .pillarBlock(11, 31)
    .pillarBlock(19, 19)
    .pillarBlock(28, 11)
    .pillarBlock(28, 28)
    .pillarBlock(38, 19)
    .pillarBlock(46, 8)
    .pillarBlock(46, 31)
    .pillar([17, 6], [17, 37], [39, 6], [39, 37], [31, 19], [31, 22]);
  const rows = b.rows();
  const p = new Placer('forgeheart', rows, [4, 21], [], 0);
  return {
    id: 'forgeheart',
    ...roomKeys('forgeheart'),
    theme: 'ember',
    layout: rows,
    playerSpawns: spawns(3, 20),
    enemies: [{ kind: 'forgelord', tile: [49, 21], minPlayers: 1 }],
    mechanisms: [],
    signs: [p.sign('warning', 6, 17)],
    decor: [
      ...wallDecor(rows, 'torch', rect(1, 3, 56, 38), 8),
      ...wallDecor(rows, 'torch', rect(1, 40, 56, 1), 8, 'south'),
      ...wallDecor(rows, 'banner', rect(1, 3, 56, 38), 12, 'north', 5),
      ...p.decor('statue', [2, 7], [55, 7], [2, 36], [55, 36]).decor('crystal', [25, 1], [32, 1], [28, 3], [29, 3]).decor('bones', [14, 24], [34, 14], [41, 26]).decors,
    ],
    // Cristaux de soin (sources de vie fixes, usage unique, 50 PV) : loin des arrivées et du départ du boss ; le 3e exige 3 joueurs.
    healCrystals: [
      { id: 'forgeheart_heal1', tile: [17, 10] },
      { id: 'forgeheart_heal2', tile: [17, 32] },
      { id: 'forgeheart_heal3', tile: [29, 37], minPlayers: 3 },
    ],
    exit: {
      rect: rect(25, 1, 8, 2),
      requires: ['clear', 'obj:seal', 'obj:hold', 'obj:slayer', 'obj:torch'],
      final: true,
      sealed: true,
    },
  };
})();

// ───────────────────────────── Dialogues et objectifs ─────────────────────────────

const intro: DialogueLine[] = [
  { speaker: 'narrator', textKey: 'level.level5.intro.1' },
  { speaker: 'lyssa', textKey: 'level.level5.intro.2' },
  { speaker: 'aldric', textKey: 'level.level5.intro.3' },
  { speaker: 'heroes', textKey: 'level.level5.intro.4' },
  { speaker: 'forgelord', textKey: 'level.level5.intro.5' },
];

const outro: DialogueLine[] = [
  { speaker: 'narrator', textKey: 'level.level5.outro.1' },
  { speaker: 'lyssa', textKey: 'level.level5.outro.2' },
  { speaker: 'aldric', textKey: 'level.level5.outro.3' },
  { speaker: 'heroes', textKey: 'level.level5.outro.4' },
];

const objectives: ObjectiveDef[] = [
  { id: 'seal', slot: 0, roomId: 'emberhold', kind: 'mechanism', mechanismId: 'doorBlue', labelKey: 'objective.level5.seal' },
  { id: 'hold', slot: 1, roomId: 'crucible', kind: 'zone', zoneId: 'crucibleZone', seconds: 8, labelKey: 'objective.level5.hold' },
  { id: 'slayer', slot: 2, roomId: 'bellows', kind: 'kills', count: 5, labelKey: 'objective.level5.slayer' },
  { id: 'torch', slot: 3, roomId: 'blindforge', kind: 'mechanism', mechanismId: 'brazierYellow', labelKey: 'objective.level5.torch' },
];

/**
 * Niveau 5 — Les Forges Ardentes. Données pures (aucune logique) : voir l'en-tête du fichier pour la structure, le rythme, la coop
 * adaptative et les objectifs.
 */
export const level5: LevelDef = {
  id: 'level5',
  nameKey: 'level.level5.name',
  theme: 'ember',
  estimatedMinutes: 9,
  intro,
  outro,
  rooms: [ashgate, slagworks, crucible, pyre, cinderpit, blindforge, bellows, emberhold, forgeheart],
  objectives,
};
