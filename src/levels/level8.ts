/**
 * Niveau 8 — « Le Bastion des Stratèges » (thème `dawn`, 8 salles, ≈ 9 minutes simulées par les bots, 9 annoncées).
 *
 * IDENTITÉ : les BOSS « MALINS ». Les trois (demi-)boss du niveau (`warden`, `pyromancer`, `forgelord`) reçoivent des TACTIQUES par donnée
 * (`EnemySpawnDef.tactics`, voir `src/core/tactics.ts` et `balance.ts` [B35]-[B40]) : ils guettent les alliés tombés (veille), gardent un
 * cristal de soin, accourent vers un appelant isolé, se postent sur les bonus au sol pour les confisquer, traquent le plus faible.
 * La progression est volontairement croissante (aucune autre salle du jeu n'a de tactiques) :
 *   `veilleurs`  warden      ['guardDowned']
 *   `vigie`      pyromancer  ['guardDowned', 'campCrystal', 'heedCalls', 'seizeItems']
 *   `conseil`    forgelord   les six tactiques
 * Contre-jeu (enseigné par les panneaux) : une icône de forme distincte flotte au-dessus du chef quand il a un plan ; le frapper fort
 * (rafale) ou lancer un spécial le DÉSTABILISE (il lâche son plan quelques secondes) ; chaque plan a un budget puis une relâche
 * obligatoire ; aucun bonus ne se lâche (le boss se poste sur le butin et les cœurs au sol, jamais sur un objet tombé aux pieds d'un joueur à terre : ramasser avant lui est le contre-jeu) ; rester groupés neutralise les plans de poursuite.
 * Les salles à (demi-)boss tactique sont des salles PURES (aucun mécanisme, aucun abîme : validé par `levelValidation.ts`) avec
 * 3 cristaux de soin. Les niveaux 1 à 7 et 9 n'ont AUCUN champ `tactics` : ils restent identiques à l'octet.
 *
 * Signatures de puzzle (recombinaisons de mécanismes existants, aucun nouveau type) :
 *  - la CHICANE : une énigme de RUNES (séquence visible du seul héros rouge, slot 1 : toujours un joueur existant dès 1 joueur, comme aux niveaux 7 et 9) ouvre une porte, puis un SABLIER partage la herse qui garde
 *    la sortie (relais : l'un retourne le levier lointain pendant que les autres passent) ;
 *  - le CABINET : une PAIRE DE STATUES jumelles ouvre la chambre des plans, où une plaque gardée par des archers ouvre la sortie.
 *
 * Rythme :
 *  1. `parvis`     Le Parvis des Étendards     apprentissage : 4 plaques de couleur à tenir ensemble, ennemis au sol seulement
 *  2. `armurerie`  L'Armurerie des Capitaines  un levier de base + 4 leviers de couleur à fenêtre, porte, objectif « arsenal » (kills)
 *  3. `veilleurs`  Le Poste du Veilleur        DEMI-BOSS n°1 (gardien `warden`, veille), arène pure, piliers de couverture
 *  4. `chicane`    La Chicane des Runes        runes (héros rouge) puis sablier partagé avant la sortie
 *  5. `fosses`     Les Fosses du Siège         abîmes, plaque + 4 leviers à fenêtre, objectif « rempart » (zone, 18 s) sous embuscade
 *  6. `vigie`      La Vigie du Pyromancien     DEMI-BOSS n°2 (`pyromancer`, 4 tactiques), arène pure
 *  7. `cabinet`    Le Cabinet des Plans        paire de statues, plaque gardée par des archers, objectif « plans »
 *  8. `conseil`    Le Conseil de Guerre        BOSS FINAL : `forgelord` (6 tactiques), arène pure, sortie scellée
 *
 * Coop adaptative (1 à 4 joueurs) : plaques / leviers de couleur à `minPlayers` = slot + 1 ; le NOMBRE d'ennemis ne dépend QUE du nombre
 * de joueurs (`minPlayers`, ≈ 60 % des ennemis dès 1 joueur), jamais de la difficulté. Les salles à boss ont des paliers EXPLICITES
 * (sbires : 14 / 20 / 25 / 30 dans `veilleurs`, 16 / 22 / 28 / 33 dans `vigie`, 14 / 19 / 23 / 27 dans `conseil`). Aucun ennemi à moins de
 * 12 tuiles de l'arrivée ; les salles à abîme ne contiennent que des ennemis TERRESTRES.
 *
 * Objectifs personnels (un par slot, types variés, quatre salles) :
 *  - slot 0 (bleu)   `banner`  : mécanisme — la porte du Parvis (4 plaques tenues ensemble) ;
 *  - slot 1 (rouge)  `arsenal` : kills — 5 coups fatals à l'Armurerie ;
 *  - slot 2 (vert)   `rampart` : zone — tenir le rempart des Fosses 18 s pendant l'embuscade ;
 *  - slot 3 (jaune)  `plans`   : mécanisme — résoudre la paire de statues du Cabinet.
 *
 * Toutes les chaînes affichées sont des clés i18n (parts `src/i18n/parts/level8.{fr,en}.json`).
 */

import { isAnyBossKind } from '../core/enemies';
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
  ZoneTheme,
} from '../core/types';

/** Thème visuel du niveau (un seul endroit à changer). */
const THEME: ZoneTheme = 'dawn';

// ───────────────────────────── Aides de construction ─────────────────────────────

/** Raccourci pour un rectangle de tuiles. */
function rect(x: number, y: number, w: number, h: number): TileRect {
  return { x, y, w, h };
}

/** Constructeur de grille : on part d'un plein de murs et on creuse des salles, des abîmes et des couloirs. Déterministe. */
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

  /** Salle, couloir, passage. */
  floor(x: number, y: number, w: number, h: number): this {
    return this.paint(x, y, w, h, '.');
  }

  /** Abîme : bloque les déplacements, pas les projectiles (les ennemis volants le survolent). */
  pit(x: number, y: number, w: number, h: number): this {
    return this.paint(x, y, w, h, '~');
  }

  /** Pose des piliers isolés. */
  pillar(...tiles: TileXY[]): this {
    for (const [x, y] of tiles) this.paint(x, y, 1, 1, 'o');
    return this;
  }

  /** Pilier massif 2×2 (couverture) dont le coin haut-gauche est (x, y). */
  pillarBlock(x: number, y: number): this {
    return this.paint(x, y, 2, 2, 'o');
  }

  /** Zones où les grilles de piliers ne posent rien (arrivées, mécanismes, couloirs…). */
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

  /** Grille régulière de piliers : un pilier n'est posé que si ses 8 voisines sont du sol libre (jamais de passage étranglé). */
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
 * Cycle de paliers `minPlayers` (25 entrées) : 60 % des ennemis dès 1 joueur, 68 % à 2, 80 % à 3, 100 % à 4 (8 % / 12 % / 20 % de paliers 2 / 3 / 4).
 * Le nombre d'ennemis suit les JOUEURS, jamais la difficulté. Plus de paliers « 4 » que dans les niveaux 4 à 6 : à 2 joueurs la durée (bots) est la plus tendue
 * (fenêtre 5-10 min), alors qu'à 4 joueurs la salle reste aussi peuplée que le niveau 6.
 */
const TIERS = [1, 1, 4, 1, 3, 1, 4, 1, 2, 1, 1, 3, 1, 4, 1, 1, 2, 1, 4, 3, 1, 1, 4, 1, 1] as const;

/** Rectangle (2r+1)² autour d'une tuile : interdit aux ennemis et aux décors (mécanismes, atterrissages). */
function around(t: TileXY, r = 2): TileRect {
  return rect(t[0] - r, t[1] - r, 2 * r + 1, 2 * r + 1);
}

/** Pose ennemis, décors et panneaux sur des tuiles de sol libres (aimantés vers la tuile libre la plus proche). */
class Placer {
  readonly enemies: EnemySpawnDef[] = [];
  readonly decors: DecorDef[] = [];
  private readonly used = new Set<number>();

  constructor(
    private readonly rows: readonly string[],
    private readonly spawn: TileXY,
    private readonly avoid: TileRect[],
    private readonly minDist = 14,
  ) {}

  /** Interdit d'autres zones aux ennemis, décors et panneaux posés ensuite. */
  forbid(...rects: TileRect[]): this {
    this.avoid.push(...rects);
    return this;
  }

  private free(x: number, y: number, far: boolean): boolean {
    const g = this.rows[y]?.[x];
    if (g !== '.' && g !== ',') return false;
    if (this.used.has(y * 1000 + x)) return false;
    if (this.avoid.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)) return false;
    if (far && Math.hypot(x - this.spawn[0], y - this.spawn[1]) < this.minDist) return false;
    return true;
  }

  private snap(x: number, y: number, far: boolean): TileXY {
    for (let r = 0; r <= 14; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (this.free(x + dx, y + dy, far)) {
            this.used.add((y + dy) * 1000 + (x + dx));
            return [x + dx, y + dy];
          }
        }
      }
    }
    throw new Error(`level8 : aucune tuile libre près de [${x},${y}]`);
  }

  /** Un ennemi près de (x, y). */
  foe(kind: EnemyKind, x: number, y: number, extra: Partial<Omit<EnemySpawnDef, 'kind' | 'tile'>> = {}): this {
    this.enemies.push({ kind, tile: this.snap(x, y, true), ...extra });
    return this;
  }

  /**
   * `count` ennemis répartis régulièrement sur les tuiles libres d'une zone (réseau de pas 3, puis 2, puis 1), types en alternance
   * cyclique dans `kinds`. Jamais à moins de `minDist` tuiles de l'arrivée.
   */
  fill(area: TileRect, kinds: readonly EnemyKind[], count: number, extra: Partial<Omit<EnemySpawnDef, 'kind' | 'tile'>> = {}): this {
    let cands: TileXY[] = [];
    for (const step of [3, 2, 1]) {
      cands = [];
      for (let y = area.y; y < area.y + area.h; y += step) {
        for (let x = area.x; x < area.x + area.w; x += step) if (this.free(x, y, true)) cands.push([x, y]);
      }
      if (cands.length >= count) break;
    }
    if (cands.length < count) throw new Error(`level8 : zone [${area.x},${area.y},${area.w},${area.h}] : ${cands.length} tuiles libres pour ${count} ennemis`);
    for (let i = 0; i < count; i++) {
      const t = cands[Math.floor(((i + 0.5) * cands.length) / count)];
      this.used.add(t[1] * 1000 + t[0]);
      this.enemies.push({ kind: kinds[i % kinds.length], tile: t, ...extra });
    }
    return this;
  }

  /**
   * Embuscade : comme `fill`, mais conditionnée à l'entrée dans la zone `zone` (`when: 'enter:<zone>'`) et JAMAIS à moins de 6 tuiles
   * de la tuile d'atterrissage `landing` (le point par lequel on arrive) : un ennemi ne surgit donc jamais juste à côté.
   */
  ambush(landing: TileXY, zone: string, area: TileRect, kinds: readonly EnemyKind[], count: number): this {
    const mark = this.avoid.length;
    this.avoid.push(around(landing, 5));
    this.fill(area, kinds, count, { when: `enter:${zone}` });
    this.avoid.length = mark;
    return this;
  }

  /**
   * Sbires d'une salle de (demi-)boss avec des paliers EXPLICITES : `counts[k]` sbires qui apparaissent dès k+1 joueurs
   * (le palier 1 sans `minPlayers`). À utiliser avec `raw()`, pas `tiered()`.
   */
  minions(area: TileRect, kinds: readonly EnemyKind[], counts: readonly [number, number, number, number]): this {
    counts.forEach((c, i) => {
      if (c > 0) this.fill(area, kinds, c, i === 0 ? {} : { minPlayers: i + 1 });
    });
    return this;
  }

  /** Décors du même type près des tuiles demandées. */
  decor(type: DecorDef['type'], ...tiles: TileXY[]): this {
    for (const [x, y] of tiles) this.decors.push({ type, tile: this.snap(x, y, false) });
    return this;
  }

  /** Panneau de salle (`sign.level8.<roomId>.<name>`). */
  sign(room: string, name: string, x: number, y: number): SignDef {
    return { id: `${room}.${name}`, tile: this.snap(x, y, false), textKey: `sign.level8.${room}.${name}` };
  }

  /** Ennemis finaux : les paliers `minPlayers` non précisés suivent le cycle `TIERS` (demi-boss et boss : présents à tous les n). */
  tiered(): EnemySpawnDef[] {
    let i = 0;
    return this.enemies.map((e) => {
      if (e.minPlayers !== undefined || isAnyBossKind(e.kind)) return e;
      const tier = TIERS[i++ % TIERS.length];
      return tier === 1 ? e : { ...e, minPlayers: tier };
    });
  }

  /** Ennemis tels que posés (paliers explicites déjà fixés : salles de demi-boss et de boss). */
  raw(): EnemySpawnDef[] {
    return this.enemies;
  }
}

/** Torches/bannières accrochées au mur nord (ou sud) d'une salle (positions retenues seulement si c'est un mur). */
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

/** Les quatre couleurs de slot, dans l'ordre des slots 0..3 (bleu, rouge, vert, jaune). */
const COLORS = ['Blue', 'Red', 'Green', 'Yellow'] as const;

/** Les tuiles d'une porte dont le coin haut-gauche est (x, y). */
function doorTiles(x: number, y: number, w = 2, h = 2): TileXY[] {
  const out: TileXY[] = [];
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) out.push([xx, yy]);
  return out;
}

/** Herse verticale de `h` tuiles à la colonne `x`, à partir de la ligne `y`. */
function gateColumn(x: number, y: number, h = 3): TileXY[] {
  return Array.from({ length: h }, (_, i) => [x, y + i] as TileXY);
}

/** Clé d'étiquette de mécanisme : `mech.level8.<roomId>.<mechanismId>`. */
function mechLabel(room: string, mechanismId: string): string {
  return `mech.level8.${room}.${mechanismId}`;
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

/** Nom, indice d'arrivée : clés `room.level8.<id>.name` et `hintroom.level8.<id>`. */
function roomKeys(id: string): { nameKey: string; introHintKey: string } {
  return { nameKey: `room.level8.${id}.name`, introHintKey: `hintroom.level8.${id}` };
}

/** Types d'ennemis des salles à abîme : uniquement des créatures TERRESTRES (un volant resterait suspendu hors de portée). */
const GROUND: readonly EnemyKind[] = ['slime', 'skeleton', 'spider', 'slime', 'skeleton', 'spider'];
const GROUND_TOUGH: readonly EnemyKind[] = ['skeleton', 'spider', 'slime', 'skeleton', 'knight', 'spider', 'slime'];
/** Embuscade des Fosses : un seul chevalier pour neuf créatures (elle surgit d'un coup sur le héros qui tient le rempart). */
const GROUND_AMBUSH: readonly EnemyKind[] = ['skeleton', 'spider', 'slime', 'skeleton', 'spider', 'slime', 'skeleton', 'spider', 'slime', 'skeleton', 'spider', 'knight'];

// ───────────────────────────── Salle 1 : Le Parvis des Étendards ─────────────────────────────
//
// 60×44. Idée : APPRENTISSAGE calme. Une grande cour à piliers, sans aucun volant (que des créatures au sol), et quatre plaques de couleur
// dans les coins : bleue (min 1), rouge (min 2), verte (min 3), jaune (min 4). La porte [52..53, 21..22] s'ouvre quand les quatre sont
// tenues en même temps ; derrière, la chambre de sortie. Objectif du héros bleu : la porte. Un panneau annonce l'œil doré (le plan du chef).
// Résolution : vaincre les gardes ; chaque héros tient SA plaque — bleue [7,7], rouge [46,7], verte [7,36], jaune [46,36] — la porte
// s'ouvre ; sortie [55..58, 18..25].

const parvis: RoomDef = (() => {
  const spawn: TileXY = [4, 22];
  const plates: Record<string, TileXY> = { Blue: [7, 7], Red: [46, 7], Green: [7, 36], Yellow: [46, 36] };
  const b = new LayoutBuilder(60, 44).floor(2, 4, 50, 36).floor(52, 21, 2, 2).floor(54, 16, 5, 12);
  [
    [14, 11],
    [14, 31],
    [24, 16],
    [24, 26],
    [34, 11],
    [34, 31],
    [32, 21],
    [41, 16],
    [41, 26],
  ].forEach(([x, y]) => b.pillarBlock(x, y));
  b.pillar([19, 21], [28, 7], [28, 36], [47, 21]);
  const rows = b.rows();
  const p = new Placer(rows, spawn, [...Object.values(plates).map((t) => around(t)), rect(48, 18, 6, 10)]).fill(
    rect(18, 5, 33, 34),
    ['slime', 'skeleton', 'spider', 'archer', 'slime', 'skeleton'],
    42,
  );
  const mechanisms: MechanismDef[] = [];
  COLORS.forEach((color, slot) => {
    const base = {
      id: `parvisPlate${color}`,
      type: 'plate' as const,
      tile: plates[color],
      colorSlot: slot,
      labelKey: mechLabel('parvis', `parvisPlate${color}`),
    };
    mechanisms.push(slot === 0 ? base : { ...base, minPlayers: slot + 1 });
  });
  mechanisms.push({
    id: 'parvisDoor',
    type: 'door',
    tiles: doorTiles(52, 21),
    requires: COLORS.map((c) => `parvisPlate${c}`),
    labelKey: mechLabel('parvis', 'parvisDoor'),
  });
  return {
    id: 'parvis',
    ...roomKeys('parvis'),
    theme: THEME,
    layout: rows,
    playerSpawns: spawns(...spawn),
    enemies: p.tiered(),
    mechanisms,
    signs: [p.sign('parvis', 'eye', 9, 17), p.sign('parvis', 'plates', 9, 27), p.sign('parvis', 'door', 49, 24)],
    decor: [
      ...wallDecor(rows, 'torch', rect(2, 4, 50, 36), 8),
      ...wallDecor(rows, 'banner', rect(2, 4, 50, 36), 12, 'north', 6),
      ...p.decor('crystal', [3, 5], [50, 5], [3, 38], [50, 38], [56, 17], [57, 26]).decor('statue', [3, 20], [3, 25], [50, 20], [50, 25])
        .decor('bones', [22, 12], [36, 28], [44, 14]).decor('crate', [3, 6], [3, 37]).decors,
    ],
    exit: { rect: rect(55, 18, 4, 8), requires: ['parvisDoor', 'clear'] },
  };
})();

// ───────────────────────────── Salle 2 : L'Armurerie des Capitaines ─────────────────────────────
//
// 66×44. Idée : un LEVIER DE BASE (verrouillant, au centre de la salle) et QUATRE LEVIERS DE COULEUR à fenêtre de 12 s aux quatre coins
// (bleu min 1, rouge min 2, vert min 3, jaune min 4) ouvrent la porte [58..59, 21..22]. Squelettes, archers et araignées gardent
// l'armurerie (des caisses en décor). Objectif du héros rouge : 5 coups fatals (accompli d'office quand la salle est vidée).
// Résolution : vaincre la garnison ; tirer le levier de base [38,21] ; chacun tire SON levier — bleu [5,7], rouge [54,7], vert [5,36],
// jaune [54,36] — dans la fenêtre ; la porte s'ouvre ; sortie [61..63, 19..24].

const armurerie: RoomDef = (() => {
  const spawn: TileXY = [4, 22];
  const baseLever: TileXY = [38, 21];
  const leverTiles: TileXY[] = [
    [5, 7],
    [54, 7],
    [5, 36],
    [54, 36],
  ];
  const b = new LayoutBuilder(66, 44).floor(2, 4, 56, 36).floor(58, 21, 2, 2).floor(60, 17, 5, 10);
  [
    [12, 11],
    [12, 31],
    [22, 16],
    [22, 26],
    [30, 9],
    [30, 33],
    [46, 16],
    [46, 26],
    [48, 9],
    [48, 33],
  ].forEach(([x, y]) => b.pillarBlock(x, y));
  b.pillar([17, 21], [28, 21], [43, 21], [52, 21]);
  const rows = b.rows();
  const p = new Placer(rows, spawn, [...leverTiles.map((t) => around(t)), around(baseLever, 3), rect(54, 18, 6, 8)]).fill(
    rect(16, 5, 41, 34),
    ['skeleton', 'spider', 'skeleton', 'archer', 'spider', 'skeleton'],
    49,
  );
  const mechanisms: MechanismDef[] = [
    { id: 'armoryLeverBase', type: 'lever', tile: baseLever, labelKey: mechLabel('armurerie', 'armoryLeverBase') },
  ];
  COLORS.forEach((color, slot) => {
    const base = {
      id: `armoryLever${color}`,
      type: 'lever' as const,
      tile: leverTiles[slot],
      ownerSlot: slot,
      windowMs: 12000,
      labelKey: mechLabel('armurerie', `armoryLever${color}`),
    };
    mechanisms.push(slot === 0 ? base : { ...base, minPlayers: slot + 1 });
  });
  mechanisms.push({
    id: 'armoryDoor',
    type: 'door',
    tiles: doorTiles(58, 21),
    requires: ['armoryLeverBase', ...COLORS.map((c) => `armoryLever${c}`)],
    labelKey: mechLabel('armurerie', 'armoryDoor'),
  });
  return {
    id: 'armurerie',
    ...roomKeys('armurerie'),
    theme: THEME,
    layout: rows,
    playerSpawns: spawns(...spawn),
    enemies: p.tiered(),
    mechanisms,
    signs: [p.sign('armurerie', 'base', 36, 24), p.sign('armurerie', 'levers', 9, 18), p.sign('armurerie', 'arsenal', 9, 27), p.sign('armurerie', 'door', 55, 24)],
    decor: [
      ...wallDecor(rows, 'torch', rect(2, 4, 56, 36), 8),
      ...wallDecor(rows, 'banner', rect(2, 4, 56, 36), 12, 'north', 6),
      ...p.decor('crate', [3, 5], [4, 5], [3, 6], [56, 5], [56, 38], [57, 38], [3, 38], [4, 38], [28, 5], [36, 38], [20, 21], [40, 14])
        .decor('statue', [3, 20], [3, 25], [56, 20], [56, 25]).decor('crystal', [3, 10], [56, 10], [3, 33], [56, 33])
        .decor('bones', [18, 12], [34, 30], [50, 20]).decors,
    ],
    exit: { rect: rect(61, 19, 3, 6), requires: ['armoryDoor', 'obj:arsenal', 'clear'] },
  };
})();

// ───────────────────────────── Salle 3 : Le Poste du Veilleur (demi-boss n°1, veille) ─────────────────────────────
//
// 64×44. Idée : le gardien (`warden`, tactique `guardDowned`) VEILLE ceux qui tombent : quand un héros est à terre il vient se poster
// près de lui (anneau de 44 px) pour l'empêcher d'être relevé. Salle PURE (aucun mécanisme, aucun abîme), piliers 2×2 pour se couvrir ;
// 3 cristaux de soin (le 3e dès 3 joueurs). Sbires : 14 / 20 / 25 / 30 selon le nombre de joueurs (explicites).
// Contre-jeu : frapper fort le gardien ou lancer un spécial le déstabilise ; sa veille a un budget puis une relâche (le relevage
// reste possible) ; un allié peut relever derrière un pilier pendant que les autres l'occupent.
// Résolution : vaincre le gardien et ses sbires ; sortie [57..60, 19..24] (exige `clear`).

const veilleurs: RoomDef = (() => {
  const spawn: TileXY = [4, 22];
  const b = new LayoutBuilder(64, 44).floor(2, 4, 60, 36);
  [
    [12, 9],
    [12, 33],
    [22, 15],
    [22, 27],
    [32, 9],
    [32, 33],
    [38, 21],
    [42, 14],
    [42, 28],
    [50, 9],
    [50, 33],
  ].forEach(([x, y]) => b.pillarBlock(x, y));
  b.pillar([17, 22], [29, 21], [46, 22], [56, 12], [56, 31]);
  const rows = b.rows();
  const p = new Placer(rows, spawn, [rect(56, 18, 6, 8), around([20, 8]), around([20, 35]), around([28, 22])])
    .foe('warden', 50, 22, { tactics: ['guardDowned'] })
    .minions(rect(16, 5, 44, 34), ['skeleton', 'spider', 'bat', 'slime', 'archer', 'skeleton', 'bat'], [14, 6, 5, 5]);
  return {
    id: 'veilleurs',
    ...roomKeys('veilleurs'),
    theme: THEME,
    layout: rows,
    playerSpawns: spawns(...spawn),
    enemies: p.raw(),
    mechanisms: [],
    signs: [p.sign('veilleurs', 'eye', 8, 20), p.sign('veilleurs', 'counter', 8, 25), p.sign('veilleurs', 'crystals', 16, 22)],
    decor: [
      ...wallDecor(rows, 'torch', rect(2, 4, 60, 36), 8),
      ...wallDecor(rows, 'banner', rect(2, 4, 60, 36), 12, 'north', 6),
      ...p.decor('crystal', [3, 5], [60, 5], [3, 38], [60, 38]).decor('statue', [3, 20], [3, 25], [60, 20], [60, 25])
        .decor('bones', [18, 10], [36, 28], [47, 15], [26, 35]).decors,
    ],
    // Cristaux de soin (sources de vie fixes, usage unique, 50 PV) : loin des arrivées et du départ du gardien ; le 3e exige 3 joueurs.
    healCrystals: [
      { id: 'veilleurs_heal1', tile: [20, 8] },
      { id: 'veilleurs_heal2', tile: [20, 35] },
      { id: 'veilleurs_heal3', tile: [28, 22], minPlayers: 3 },
    ],
    exit: { rect: rect(57, 19, 4, 6), requires: ['clear'] },
  };
})();

// ───────────────────────────── Salle 4 : La Chicane des Runes ─────────────────────────────
//
// 80×46. Idée : la CHICANE. Le hall ouest abrite l'écran des runes, tout au nord-est [31,9] : seule la vision du héros rouge (slot 1) lit
// la séquence ; les piédestaux sont dispersés à l'autre bout (star [4,36], lune [13,36], œil [4,10], flamme [8,29]) : il faut annoncer
// l'ordre à voix haute. La bonne séquence ouvre la porte [35..36, 21..22] sur le hall central, que garde une HERSE À SABLIER
// [61, 20..22] : le levier lointain [41,9] (≈ 23 tuiles de la herse) et le levier voisin [68,21] de l'autre côté. Sable de 4 s (8 s en solo).
// Derrière la herse, le hall de sortie (aucun ennemi). Pas d'objectif propre ; la sortie exige `clear`.
// Résolution : vaincre les gardes du hall ouest ; le héros rouge lit l'écran, les autres frappent les runes dans l'ordre (un seul
// héros fait tout en solo) ; la porte s'ouvre ; vaincre le hall central ; relais au sablier : un héros retourne le levier lointain
// pendant que les autres franchissent la herse, puis le levier voisin rouvre le passage au « tenant » ; sortie [73..76, 18..25].

const chicane: RoomDef = (() => {
  const spawn: TileXY = [4, 22];
  const display: TileXY = [31, 9];
  const pedestals = [
    { symbol: 'star', tile: [4, 36] as TileXY },
    { symbol: 'moon', tile: [13, 36] as TileXY },
    { symbol: 'eye', tile: [4, 10] as TileXY },
    { symbol: 'flame', tile: [8, 29] as TileXY },
  ];
  const levers: [TileXY, TileXY] = [
    [41, 9],
    [68, 21],
  ];
  const b = new LayoutBuilder(80, 46)
    .floor(2, 8, 32, 30) // hall ouest x2..33, y8..37
    .floor(34, 21, 5, 2) // couloir de la porte de runes x34..38 (porte x35..36)
    .floor(39, 8, 20, 30) // hall central x39..58, y8..37
    .floor(59, 20, 7, 3) // couloir de la herse x59..65, y20..22 (herse x61)
    .floor(66, 12, 12, 22) // hall de sortie x66..77, y12..33
    .reserve(rect(2, 18, 8, 9), rect(28, 8, 6, 4), rect(32, 19, 7, 6), rect(39, 8, 5, 4), rect(55, 18, 4, 7), ...pedestals.map((q) => around(q.tile)))
    .pillarGrid(rect(4, 9, 28, 28), 6, 6, 2, 2)
    .pillarGrid(rect(40, 9, 18, 28), 6, 6, 3, 2);
  const rows = b.rows();
  const p = new Placer(rows, spawn, [around(display), ...pedestals.map((q) => around(q.tile)), around(levers[0], 3), rect(31, 18, 9, 7), rect(52, 17, 14, 9)])
    .fill(rect(18, 9, 15, 28), ['skeleton', 'wisp', 'skeleton', 'archer', 'skeleton'], 8)
    .fill(rect(40, 9, 18, 28), ['skeleton', 'skeleton', 'wisp', 'skeleton', 'archer', 'skeleton'], 30);
  const mechanisms: MechanismDef[] = [
    {
      id: 'chicaneRunes',
      type: 'runePuzzle',
      displayTile: display,
      visibleToSlot: 1,
      sequence: ['eye', 'star', 'flame', 'moon'],
      pedestals,
      labelKey: mechLabel('chicane', 'chicaneRunes'),
    },
    {
      id: 'chicaneRuneDoor',
      type: 'door',
      tiles: doorTiles(35, 21),
      requires: ['chicaneRunes'],
      labelKey: mechLabel('chicane', 'chicaneRuneDoor'),
    },
    {
      id: 'chicaneHourglass',
      type: 'hourglass',
      levers,
      gate: gateColumn(61, 20),
      periodMs: 4000,
      closeStepMs: 350,
      displayTile: [59, 21],
      labelKey: mechLabel('chicane', 'chicaneHourglass'),
    },
  ];
  return {
    id: 'chicane',
    ...roomKeys('chicane'),
    theme: THEME,
    layout: rows,
    playerSpawns: spawns(...spawn),
    enemies: p.tiered(),
    mechanisms,
    signs: [p.sign('chicane', 'runes', 8, 20), p.sign('chicane', 'screen', 29, 13), p.sign('chicane', 'hourglass', 56, 21), p.sign('chicane', 'relay', 63, 24)],
    decor: [
      ...wallDecor(rows, 'torch', rect(2, 8, 32, 30), 8),
      ...wallDecor(rows, 'torch', rect(39, 8, 20, 30), 8),
      ...wallDecor(rows, 'banner', rect(66, 12, 12, 22), 4, 'north', 2),
      ...p.decor('crystal', [3, 9], [32, 36], [40, 36], [57, 9], [76, 13], [76, 32]).decor('statue', [33, 19], [33, 24], [58, 19], [58, 24])
        .decor('bones', [14, 30], [48, 28]).decors,
    ],
    exit: { rect: rect(73, 18, 4, 8), requires: ['clear'] },
  };
})();

// ───────────────────────────── Salle 5 : Les Fosses du Siège ─────────────────────────────
//
// 76×48. Idée : le siège. Deux colonnes d'ABÎMES coupent la salle ; on ne les franchit que par deux étroits passages (aucun pont :
// uniquement des créatures TERRESTRES, aucun volant). Une PLAQUE [44,21] de la salle centrale ouvre la poterne [50..51, 21..22] du passage
// est (une porte ouverte le reste). Au-delà, le rempart (zone `siege`) : l'embuscade surgit à l'entrée ; le héros vert doit TENIR LE
// REMPART [60..64, 19..23] 18 s cumulées pendant qu'elle fait rage. Quatre leviers de couleur à fenêtre de 12 s dans les coins du rempart —
// bleu min 1, rouge min 2, vert min 3, jaune min 4 — ouvrent la porte [70..71, 21..22] de la chambre de sortie.
// Les leviers et la sortie sont DANS la zone d'embuscade : aucun chemin ne la contourne.
// Résolution : vaincre la salle centrale ; poser un héros sur la plaque ; entrer dans le rempart ; le héros vert tient le rempart pendant
// que les autres vainquent l'embuscade ; chacun tire SON levier — bleu [57,8], rouge [66,8], vert [57,39], jaune [66,39] — dans la fenêtre ;
// sortie [72..74, 18..25].

const fosses: RoomDef = (() => {
  const spawn: TileXY = [4, 24];
  const plate: TileXY = [44, 21];
  const leverTiles: TileXY[] = [
    [57, 8],
    [66, 8],
    [57, 39],
    [66, 39],
  ];
  const landing: TileXY = [53, 21];
  const b = new LayoutBuilder(76, 48)
    .floor(2, 4, 68, 40) // x2..69, y4..43
    .pit(18, 4, 6, 14) // colonne d'abîme ouest (haut)
    .pit(18, 30, 6, 14) // colonne d'abîme ouest (bas) ; passage y18..29
    .pit(48, 4, 6, 17) // colonne d'abîme est (haut)
    .pit(48, 23, 6, 21) // colonne d'abîme est (bas) ; passage y21..22 (2 tuiles : la poterne)
    .pit(29, 8, 5, 6) // mares de la salle centrale
    .pit(38, 32, 5, 6)
    .pit(29, 34, 4, 4)
    .pit(40, 8, 4, 4)
    .floor(70, 21, 2, 2) // passage de la porte x70..71
    .floor(72, 17, 3, 10) // chambre de sortie x72..74, y17..26
    .reserve(rect(2, 20, 8, 9), rect(24, 17, 5, 10), rect(43, 18, 5, 8), rect(54, 17, 6, 10), rect(59, 18, 7, 7), ...leverTiles.map((t) => around(t)), rect(66, 18, 4, 8))
    .pillarGrid(rect(4, 5, 13, 38), 6, 6, 2, 2)
    .pillarGrid(rect(25, 5, 22, 38), 6, 6, 3, 2)
    .pillarGrid(rect(55, 5, 14, 38), 5, 5, 2, 2);
  const rows = b.rows();
  const p = new Placer(rows, spawn, [around(plate), ...leverTiles.map((t) => around(t)), rect(59, 18, 7, 7), rect(66, 18, 4, 8)])
    .fill(rect(24, 5, 24, 38), GROUND, 20)
    .ambush(landing, 'siege', rect(54, 5, 16, 38), GROUND_AMBUSH, 26);
  const mechanisms: MechanismDef[] = [
    { id: 'fossesPlate', type: 'plate', tile: plate, labelKey: mechLabel('fosses', 'fossesPlate') },
    {
      id: 'fossesWicket',
      type: 'door',
      tiles: doorTiles(50, 21),
      requires: ['fossesPlate'],
      labelKey: mechLabel('fosses', 'fossesWicket'),
    },
  ];
  COLORS.forEach((color, slot) => {
    const base = {
      id: `fossesLever${color}`,
      type: 'lever' as const,
      tile: leverTiles[slot],
      ownerSlot: slot,
      windowMs: 12000,
      labelKey: mechLabel('fosses', `fossesLever${color}`),
    };
    mechanisms.push(slot === 0 ? base : { ...base, minPlayers: slot + 1 });
  });
  mechanisms.push({
    id: 'fossesDoor',
    type: 'door',
    tiles: doorTiles(70, 21),
    requires: COLORS.map((c) => `fossesLever${c}`),
    labelKey: mechLabel('fosses', 'fossesDoor'),
  });
  return {
    id: 'fosses',
    ...roomKeys('fosses'),
    theme: THEME,
    layout: rows,
    playerSpawns: spawns(...spawn),
    enemies: p.tiered(),
    mechanisms,
    zones: [
      // `siege` englobe la sortie du passage (x52..53), tout le rempart, les leviers, la porte et la chambre de sortie (x52..74) : l'embuscade ne se contourne pas.
      { id: 'siege', rect: rect(52, 5, 23, 38) },
      { id: 'rampart', rect: rect(60, 19, 5, 5) },
    ],
    signs: [p.sign('fosses', 'pits', 8, 22), p.sign('fosses', 'plate', 41, 24), p.sign('fosses', 'rampart', 56, 22), p.sign('fosses', 'levers', 62, 14)],
    decor: [
      ...wallDecor(rows, 'torch', rect(2, 4, 16, 40), 7),
      ...wallDecor(rows, 'torch', rect(24, 4, 24, 40), 8),
      ...wallDecor(rows, 'banner', rect(54, 4, 16, 40), 5, 'north', 2),
      ...p.decor('crystal', [3, 5], [16, 42], [26, 5], [46, 42], [55, 5], [68, 42]).decor('statue', [16, 17], [16, 30], [55, 20], [68, 24])
        .decor('bones', [10, 30], [36, 20], [62, 30], [62, 12]).decors,
    ],
    exit: { rect: rect(72, 18, 3, 8), requires: ['fossesDoor', 'obj:rampart', 'clear'] },
  };
})();

// ───────────────────────────── Salle 6 : La Vigie du Pyromancien (demi-boss n°2, quatre tactiques) ─────────────────────────────
//
// 66×44. Idée : le pyromancien (`pyromancer`, qui garde ses distances) a quatre plans : veiller un allié tombé (`guardDowned`), garder un
// cristal de soin (`campCrystal`), accourir vers un appelant isolé (`heedCalls`), se poster sur un bonus au sol (`seizeItems`).
// Salle PURE, piliers 2×2, 3 cristaux de soin (le 3e dès 3 joueurs). Sbires : 16 / 22 / 28 / 33 (explicites).
// Contre-jeu : le frapper fort ou lancer un spécial le déstabilise ; rester groupés (un appelant isolé est sa cible) ; les plans ont un budget
// puis une relâche ; le boss se poste sur les bonus du butin (jamais sur un objet aux pieds d'un joueur à terre) : les ramasser avant lui.
// Résolution : vaincre le pyromancien et ses sbires ; sortie [58..61, 19..24] (exige `clear`).

const vigie: RoomDef = (() => {
  const spawn: TileXY = [4, 22];
  const b = new LayoutBuilder(66, 44).floor(2, 4, 62, 36);
  [
    [12, 10],
    [12, 32],
    [22, 16],
    [22, 26],
    [31, 9],
    [31, 33],
    [38, 21],
    [43, 14],
    [43, 28],
    [52, 9],
    [52, 33],
  ].forEach(([x, y]) => b.pillarBlock(x, y));
  b.pillar([17, 22], [29, 21], [47, 22], [58, 12], [58, 31]);
  const rows = b.rows();
  const p = new Placer(rows, spawn, [rect(58, 18, 6, 8), around([22, 8]), around([22, 36]), around([30, 22])])
    .foe('pyromancer', 52, 22, { tactics: ['guardDowned', 'campCrystal', 'heedCalls', 'seizeItems'] })
    .minions(rect(16, 5, 46, 34), ['spider', 'wisp', 'bat', 'skeleton', 'slime', 'archer', 'bat', 'wisp'], [16, 6, 6, 5]);
  return {
    id: 'vigie',
    ...roomKeys('vigie'),
    theme: THEME,
    layout: rows,
    playerSpawns: spawns(...spawn),
    enemies: p.raw(),
    mechanisms: [],
    signs: [p.sign('vigie', 'plans', 8, 20), p.sign('vigie', 'counter', 8, 25), p.sign('vigie', 'bonus', 16, 22)],
    decor: [
      ...wallDecor(rows, 'torch', rect(2, 4, 62, 36), 8),
      ...wallDecor(rows, 'banner', rect(2, 4, 62, 36), 12, 'north', 6),
      ...p.decor('crystal', [3, 5], [62, 5], [3, 38], [62, 38]).decor('statue', [3, 20], [3, 25], [62, 20], [62, 25])
        .decor('bones', [18, 10], [36, 30], [48, 15], [26, 35]).decors,
    ],
    healCrystals: [
      { id: 'vigie_heal1', tile: [22, 8] },
      { id: 'vigie_heal2', tile: [22, 36] },
      { id: 'vigie_heal3', tile: [30, 22], minPlayers: 3 },
    ],
    exit: { rect: rect(59, 19, 4, 6), requires: ['clear'] },
  };
})();

// ───────────────────────────── Salle 7 : Le Cabinet des Plans ─────────────────────────────
//
// 72×46. Idée : les PLANS du bastion. Deux statues jumelles aux deux bouts de la grande salle : [7,9] (socle [7,11]) et [44,36] (socle [44,34]) ;
// se tenir sur un socle et appuyer sur Action fait pivoter l'AUTRE statue (un quart de tour horaire). Toutes deux doivent regarder le NORD
// (la statue [7,9] part vers le sud, 2 quarts de tour ; [44,36] vers l'ouest, 1 quart de tour). Elles ouvrent la porte [50..51, 22..23] sur
// la chambre des plans, où une PLAQUE [57,22] est gardée par des archers, des chevaliers et des araignées : la tenir une fois ouvre la herse
// [64..65, 22..23] de la chambre de sortie (une porte ouverte le reste). Objectif du héros jaune : les statues (aucun bloc dans ce niveau).
// Résolution : vaincre la salle ; un héros au socle [7,11] (1 appui : la statue de l'est passe de l'ouest au nord), un autre au socle [44,34]
// (2 appuis) ; à 1 joueur, aller-retour ; la porte s'ouvre ; vaincre la chambre ; se poster sur la plaque ; sortie [67..69, 18..27].

const cabinet: RoomDef = (() => {
  const spawn: TileXY = [4, 22];
  const statueA: TileXY = [7, 9];
  const standA: TileXY = [7, 11];
  const statueB: TileXY = [44, 36];
  const standB: TileXY = [44, 34];
  const plate: TileXY = [57, 22];
  const b = new LayoutBuilder(72, 46)
    .floor(2, 6, 48, 34) // grande salle x2..49, y6..39
    .floor(50, 22, 2, 2) // passage de la porte des statues x50..51
    .floor(52, 12, 12, 22) // chambre des plans x52..63, y12..33
    .floor(64, 22, 2, 2) // passage de la herse x64..65
    .floor(66, 16, 4, 14) // chambre de sortie x66..69, y16..29
    .reserve(rect(2, 18, 8, 9), rect(5, 7, 5, 7), rect(42, 32, 5, 6), rect(44, 18, 6, 10), rect(54, 19, 7, 7), rect(61, 19, 3, 7))
    .pillarGrid(rect(4, 7, 44, 32), 6, 6, 2, 2)
    .pillarGrid(rect(53, 13, 10, 20), 5, 5, 2, 2);
  const rows = b.rows();
  const p = new Placer(rows, spawn, [around(standA, 3), around(statueA, 3), around(standB, 3), around(statueB, 3), around(plate, 2), rect(44, 18, 8, 10), rect(61, 19, 6, 7)])
    .fill(rect(16, 7, 33, 32), ['knight', 'skeleton', 'spider', 'skeleton', 'archer', 'spider', 'skeleton'], 18)
    .fill(rect(52, 12, 12, 22), ['archer', 'archer', 'spider', 'archer', 'skeleton', 'archer', 'knight', 'spider'], 19);
  const mechanisms: MechanismDef[] = [
    {
      id: 'cabinetStatues',
      type: 'statuePair',
      statues: [
        { tile: statueA, standTile: standA, facing: 'down' },
        { tile: statueB, standTile: standB, facing: 'left' },
      ],
      targetDir: 'up',
      labelKey: mechLabel('cabinet', 'cabinetStatues'),
    },
    {
      id: 'cabinetDoor',
      type: 'door',
      tiles: doorTiles(50, 22),
      requires: ['cabinetStatues'],
      labelKey: mechLabel('cabinet', 'cabinetDoor'),
    },
    { id: 'cabinetPlate', type: 'plate', tile: plate, labelKey: mechLabel('cabinet', 'cabinetPlate') },
    {
      id: 'cabinetGate',
      type: 'door',
      tiles: doorTiles(64, 22),
      requires: ['cabinetPlate'],
      labelKey: mechLabel('cabinet', 'cabinetGate'),
    },
  ];
  return {
    id: 'cabinet',
    ...roomKeys('cabinet'),
    theme: THEME,
    layout: rows,
    playerSpawns: spawns(...spawn),
    enemies: p.tiered(),
    mechanisms,
    signs: [p.sign('cabinet', 'statues', 8, 20), p.sign('cabinet', 'sockets', 12, 12), p.sign('cabinet', 'door', 47, 24), p.sign('cabinet', 'plate', 55, 25)],
    decor: [
      ...wallDecor(rows, 'torch', rect(2, 6, 48, 34), 8),
      ...wallDecor(rows, 'torch', rect(52, 12, 12, 22), 4, 'north', 1),
      ...wallDecor(rows, 'banner', rect(66, 16, 4, 14), 2, 'north', 1),
      ...p.decor('crystal', [3, 7], [48, 7], [3, 38], [48, 38], [53, 13], [62, 32]).decor('statue', [3, 20], [3, 25], [48, 20], [48, 25])
        .decor('crate', [20, 8], [32, 38], [54, 32], [62, 13]).decor('bones', [14, 30], [38, 14]).decors,
    ],
    exit: { rect: rect(67, 18, 3, 10), requires: ['cabinetGate', 'clear'] },
  };
})();

// ───────────────────────────── Salle 8 : Le Conseil de Guerre (boss final, six tactiques) ─────────────────────────────
//
// 76×48. BOSS FINAL : le seigneur de la forge (`forgelord`) a TOUS les plans : veille, garde de cristal, écoute des appels, interception d'un
// porteur de cœur, confiscation des bonus, traque du plus faible. Arène ouverte (blocs de piliers épars, aucun cul-de-sac), aucune mécanique,
// aucun abîme. Sbires : 14 / 19 / 23 / 27 (explicites) ; leur butin attire le boss (plan « rapace »). 3 cristaux de soin loin du boss.
// Sortie finale SCELLÉE dans une alcôve au nord : elle exige le seigneur vaincu (`clear`) et les quatre objectifs personnels.
// Résolution : se couvrir derrière les piliers, vaincre le seigneur de la forge ; la sortie [34..41, 1..2] s'ouvre : fin du niveau.

const conseil: RoomDef = (() => {
  const b = new LayoutBuilder(76, 48).floor(2, 4, 70, 40).floor(34, 1, 8, 3);
  [
    [12, 10],
    [12, 35],
    [22, 16],
    [22, 29],
    [32, 10],
    [32, 35],
    [40, 22],
    [46, 12],
    [46, 33],
    [54, 17],
    [54, 28],
    [62, 9],
    [62, 37],
  ].forEach(([x, y]) => b.pillarBlock(x, y));
  b.pillar([18, 23], [28, 22], [58, 23], [68, 14], [68, 32]);
  const rows = b.rows();
  const p = new Placer(rows, [4, 24], [rect(32, 1, 12, 5), around([20, 12]), around([20, 36]), around([38, 40])])
    .foe('forgelord', 64, 24, { tactics: ['guardDowned', 'campCrystal', 'heedCalls', 'interceptCarrier', 'seizeItems', 'huntWeak'] })
    .minions(rect(16, 5, 55, 38), ['skeleton', 'archer', 'spider', 'knight', 'slime', 'bat', 'wisp', 'skeleton'], [14, 5, 4, 4]);
  return {
    id: 'conseil',
    ...roomKeys('conseil'),
    theme: THEME,
    layout: rows,
    playerSpawns: spawns(3, 23),
    enemies: p.raw(),
    mechanisms: [],
    signs: [p.sign('conseil', 'plans', 8, 20), p.sign('conseil', 'counter', 8, 27)],
    decor: [
      ...wallDecor(rows, 'torch', rect(2, 4, 70, 40), 8),
      ...wallDecor(rows, 'torch', rect(2, 43, 70, 1), 8, 'south'),
      ...wallDecor(rows, 'banner', rect(2, 4, 70, 40), 12, 'north', 5),
      ...p.decor('statue', [3, 5], [70, 5], [3, 42], [70, 42]).decor('crystal', [34, 1], [41, 1], [37, 3], [38, 3], [3, 24], [71, 24])
        .decor('bones', [18, 22], [44, 18], [50, 30]).decors,
    ],
    healCrystals: [
      { id: 'conseil_heal1', tile: [20, 12] },
      { id: 'conseil_heal2', tile: [20, 36] },
      { id: 'conseil_heal3', tile: [38, 40], minPlayers: 3 },
    ],
    exit: {
      rect: rect(34, 1, 8, 2),
      requires: ['clear', 'obj:banner', 'obj:arsenal', 'obj:rampart', 'obj:plans'],
      final: true,
      sealed: true,
    },
  };
})();

// ───────────────────────────── Dialogues et objectifs ─────────────────────────────

const intro: DialogueLine[] = [
  { speaker: 'narrator', textKey: 'level.level8.intro.1' },
  { speaker: 'lyssa', textKey: 'level.level8.intro.2' },
  { speaker: 'aldric', textKey: 'level.level8.intro.3' },
  { speaker: 'heroes', textKey: 'level.level8.intro.4' },
];

const outro: DialogueLine[] = [
  { speaker: 'lyssa', textKey: 'level.level8.outro.1' },
  { speaker: 'aldric', textKey: 'level.level8.outro.2' },
  { speaker: 'heroes', textKey: 'level.level8.outro.3' },
];

const objectives: ObjectiveDef[] = [
  { id: 'banner', slot: 0, roomId: 'parvis', kind: 'mechanism', mechanismId: 'parvisDoor', labelKey: 'objective.level8.banner' },
  { id: 'arsenal', slot: 1, roomId: 'armurerie', kind: 'kills', count: 5, labelKey: 'objective.level8.arsenal' },
  { id: 'rampart', slot: 2, roomId: 'fosses', kind: 'zone', zoneId: 'rampart', seconds: 18, labelKey: 'objective.level8.rampart' },
  { id: 'plans', slot: 3, roomId: 'cabinet', kind: 'mechanism', mechanismId: 'cabinetStatues', labelKey: 'objective.level8.plans' },
];

/**
 * Niveau 8 — Le Bastion des Stratèges. Données pures (aucune logique) : voir l'en-tête du fichier pour la structure, le rythme, les tactiques
 * de boss, la coop adaptative et les objectifs.
 */
export const level8: LevelDef = {
  id: 'level8',
  nameKey: 'level.level8.name',
  theme: THEME,
  estimatedMinutes: 9,
  intro,
  outro,
  rooms: [parvis, armurerie, veilleurs, chicane, fosses, vigie, cabinet, conseil],
  objectives,
};
