/**
 * Niveau 6 — « Les Abysses du Néant » (thème `void`, 9 salles, ≈ 9 minutes simulées par les bots à 2-4 joueurs, 10 annoncées). DERNIER niveau du jeu.
 *
 * Mécanisme INÉDIT : le PONT DE LUMIÈRE (`lightBridge`). Des abîmes ('~' dans la grille) séparent des plates-formes ; les ponts qui les
 * franchissent (tuiles '.' d'une largeur) ne sont SOLIDES que lorsqu'ils ne sont pas éclairés : seul le porteur de la lanterne
 * (joueur `lanternSlot % n`) les éclaire dans son halo (rayon `radiusTiles`), et une tuile reste praticable tant qu'un joueur vivant
 * l'occupe. Les autres héros doivent donc rester dans la lumière du porteur, tuile après tuile ; `lanternSlot` change d'une salle (et
 * d'un pont) à l'autre : chaque héros guide les autres à son tour. Les salles sombres (`dark: true`) cachent tout hors des halos.
 * Si le porteur tombe, le joueur vivant le plus proche de lui reprend la lanterne (`lightBridgeBearer`) : pas d'impasse, les suiveurs
 * peuvent avancer et le relever. Conception en conséquence :
 *  - AUCUN ennemi n'attaque pendant une traversée : on nettoie la rive de départ avant de passer, et les ennemis de la rive d'arrivée
 *    ne surgissent qu'en embuscade (`when: 'enter:<zone>'`), dans une zone ET à des positions situées à ≥ 6 tuiles de l'atterrissage du
 *    pont ; les zones d'embuscade englobent aussi les tuiles d'accès au pont SUIVANT (aucune embuscade ne se contourne : testé par BFS) ;
 *    les salles à abîme ne contiennent que des ennemis TERRESTRES (aucun volant ne peut rester suspendu hors de portée) ;
 *  - les ponts font une tuile de large et leurs tuiles se suivent (route continue : `escortLightBridge`), un suiveur qui tient la
 *    tuile derrière le porteur reste à portée de relevage (16 px < REVIVE_RANGE) ;
 *  - les ponts sont à sens unique : aucune salle n'exige de repasser (clés, plaques, leviers, braseros se trouvent AVANT ou APRÈS).
 *
 * Rythme :
 *  1. `quay`       Le Quai des Étoiles        apprentissage CALME : un pont droit et court (porteur : slot 0), embuscade légère
 *  2. `islets`     Les Îlots de Repos         salle sombre : deux ponts courts séparés par un îlot de repos (porteurs : slots 1 puis 2)
 *  3. `terrace`    La Terrasse des Balises    long pont sinueux (slot 3) vers une île : tenir la balise (zone) + 4 leviers à fenêtre
 *  4. `wraithhall` La Salle du Spectre        DEMI-BOSS n°1 (spectre `wraith`, volant) + sbires, 4 plaques simultanées, sans abîme
 *  5. `keys`       La Galerie des Éclipses    salle sombre : 4 clés personnelles dans 4 chambres, puis pont long (slot 0) et 4 portes à clé
 *  6. `embers`     Le Sanctuaire des Braises  salle sombre : pont sinueux (slot 1), puis chaque héros allume SON brasero (porte)
 *  7. `hearth`     Le Foyer du Spectre        DEMI-BOSS n°2 (salle clé), sbires plus nombreux, 4 leviers à fenêtre, objectif « chasse »
 *  8. `gauntlet`   Le Grand Pont des Âmes     salle sombre : quatre ponts à la suite (porteurs : slots 0, 1, 2, 3), îlots d'embuscade
 *  9. `throne`     Le Trône du Néant          BOSS FINAL : le seigneur du Néant (`voidlord`, 4 phases), arène sans abîme, sortie scellée
 *
 * Toutes les salles font de 60 à 86 tuiles de large et de 44 à 52 de haut (la caméra défile). Les layouts sont générés par des fonctions
 * locales déterministes (plates-formes, abîmes, ponts en lignes brisées, grilles de piliers). Les arènes de demi-boss et de boss n'ont
 * AUCUN abîme : un ennemi volant ne peut ainsi jamais se réfugier hors de portée.
 *
 * Coop adaptative (1 à 4 joueurs) : plaques / leviers / clés / portes / braseros à `minPlayers` croissants par slot ; ennemis : leur
 * nombre ne dépend QUE du nombre de joueurs (`minPlayers`, ≈ 60 % des ennemis dès 1 joueur), jamais de la difficulté ; les demi-boss et
 * le boss sont présents à tous les nombres de joueurs, leurs sbires suivent les joueurs. Aucun ennemi à moins de 12 tuiles de l'arrivée.
 *
 * Objectifs personnels (un par slot, types variés, répartis sur quatre salles) :
 *  - slot 0 (bleu)   `seal`   : mécanisme — ouvrir SA porte à clé de la Galerie des Éclipses ;
 *  - slot 1 (rouge)  `beacon` : zone — tenir la balise de la Terrasse 8 s ;
 *  - slot 2 (vert)   `hunt`   : kills — 4 coups fatals dans le Foyer du Spectre ;
 *  - slot 3 (jaune)  `ember`  : mécanisme — allumer SON brasero du Sanctuaire des Braises.
 *
 * Toutes les chaînes affichées sont des clés i18n (parts `src/i18n/parts/level6.{fr,en}.json`).
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
} from '../core/types';

// ───────────────────────────── Aides de construction ─────────────────────────────

/** Raccourci pour un rectangle de tuiles. */
function rect(x: number, y: number, w: number, h: number): TileRect {
  return { x, y, w, h };
}

/**
 * Constructeur de grille : on part d'un plein de murs et on creuse des plates-formes, des abîmes et des ponts. Déterministe.
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

  /** Plate-forme, couloir, passage. */
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

  /**
   * Pont d'une tuile de large le long d'une ligne brisée de points de passage (segments horizontaux ou verticaux). Les tuiles sont
   * du sol '.' ; elles sont retournées DANS L'ORDRE de traversée (sans doublon, chacune adjacente à la précédente). À appeler APRÈS
   * avoir creusé l'abîme et les plates-formes. Le premier et le dernier point doivent toucher les plates-formes de départ/d'arrivée.
   */
  bridge(...points: TileXY[]): TileXY[] {
    const out: TileXY[] = [];
    const push = (x: number, y: number): void => {
      const last = out[out.length - 1];
      if (last && last[0] === x && last[1] === y) return;
      out.push([x, y]);
      this.paint(x, y, 1, 1, '.');
    };
    points.forEach(([x, y], i) => {
      if (i === 0) {
        push(x, y);
        return;
      }
      const [px, py] = points[i - 1];
      if (px !== x && py !== y) throw new Error(`level6 : segment de pont en diagonale [${px},${py}] → [${x},${y}]`);
      const dx = Math.sign(x - px);
      const dy = Math.sign(y - py);
      for (let cx = px + dx, cy = py + dy; ; cx += dx, cy += dy) {
        push(cx, cy);
        if (cx === x && cy === y) break;
      }
    });
    return out;
  }

  /** Zones où les grilles de piliers ne posent rien (arrivées, extrémités de pont, mécanismes…). */
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
 * Cycle de paliers `minPlayers` : 60 % des ennemis dès 1 joueur, 75 % à 2, 90 % à 3, 100 % à 4.
 * Le nombre d'ennemis suit les JOUEURS, jamais la difficulté.
 */
const TIERS = [1, 1, 2, 1, 1, 3, 1, 1, 4, 1, 2, 1, 3, 1, 1, 4, 1, 2, 1, 3] as const;

/** Rectangle 5×5 autour d'une tuile : interdit aux ennemis et aux décors (extrémités de pont, mécanismes). */
function around(t: TileXY, r = 2): TileRect {
  return rect(t[0] - r, t[1] - r, 2 * r + 1, 2 * r + 1);
}

/** Pose ennemis, décors, panneaux et braseros sur des tuiles de sol libres (aimantés vers la tuile libre la plus proche). */
class Placer {
  readonly enemies: EnemySpawnDef[] = [];
  readonly decors: DecorDef[] = [];
  /** Braseros posés (à poser AVANT les ennemis : ceux-ci les évitent). */
  readonly fires: MechanismDef[] = [];
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
    throw new Error(`level6 : aucune tuile libre près de [${x},${y}]`);
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
    if (cands.length < count) throw new Error(`level6 : zone [${area.x},${area.y},${area.w},${area.h}] : ${cands.length} tuiles libres pour ${count} ennemis`);
    for (let i = 0; i < count; i++) {
      const t = cands[Math.floor(((i + 0.5) * cands.length) / count)];
      this.used.add(t[1] * 1000 + t[0]);
      this.enemies.push({ kind: kinds[i % kinds.length], tile: t, ...extra });
    }
    return this;
  }

  /**
   * Embuscade : comme `fill`, mais conditionnée à l'entrée dans la zone `zone` (`when: 'enter:<zone>'`) et JAMAIS à moins de 6 tuiles
   * de la tuile d'atterrissage `landing` du pont par lequel on arrive : un ennemi ne surgit donc jamais sur un pont ni juste à côté.
   */
  ambush(landing: TileXY, zone: string, area: TileRect, kinds: readonly EnemyKind[], count: number): this {
    const mark = this.avoid.length;
    this.avoid.push(around(landing, 5));
    this.fill(area, kinds, count, { when: `enter:${zone}` });
    this.avoid.length = mark;
    return this;
  }

  /** Décors du même type près des tuiles demandées. */
  decor(type: DecorDef['type'], ...tiles: TileXY[]): this {
    for (const [x, y] of tiles) this.decors.push({ type, tile: this.snap(x, y, false) });
    return this;
  }

  /** Brasero ALLUMÉ (recharge de torche, lumière permanente) près de (x, y). Solide. */
  lit(room: string, id: string, x: number, y: number, lightRadiusTiles?: number): this {
    this.fires.push({
      id,
      type: 'brazier',
      tile: this.snap(x, y, false),
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
    this.fires.push({ id, type: 'brazier', tile: this.snap(x, y, false), labelKey: mechLabel(room, label), ...extra });
    return this;
  }

  /** Panneau de salle (`sign.level6.<roomId>.<name>`). */
  sign(room: string, name: string, x: number, y: number): SignDef {
    return { id: `${room}.${name}`, tile: this.snap(x, y, false), textKey: `sign.level6.${room}.${name}` };
  }

  /** Ennemis finaux : les paliers `minPlayers` non précisés suivent le cycle `TIERS`. */
  tiered(): EnemySpawnDef[] {
    let i = 0;
    return this.enemies.map((e) => {
      if (e.minPlayers !== undefined || isAnyBossKind(e.kind)) return e; // demi-boss et boss : présents à tous les nombres de joueurs
      const tier = TIERS[i++ % TIERS.length];
      return tier === 1 ? e : { ...e, minPlayers: tier };
    });
  }
}

/** Torches/bannières accrochées au mur nord (ou sud) d'une plate-forme (positions retenues seulement si c'est un mur). */
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

/** Décors `torch` posés à des tuiles précises (mur ou sol) : éclairent un peu (3 tuiles) les points clés des salles sombres. */
function torchesAt(rows: readonly string[], ...tiles: TileXY[]): DecorDef[] {
  return tiles.map(([x, y]) => {
    if (rows[y]?.[x] === undefined) throw new Error(`level6 : torche hors grille [${x},${y}]`);
    return { type: 'torch' as const, tile: [x, y] as TileXY };
  });
}

/** Les quatre couleurs de slot, dans l'ordre des slots 0..3 (bleu, rouge, vert, jaune). */
const COLORS = ['Blue', 'Red', 'Green', 'Yellow'] as const;

/** Les tuiles d'une porte dont le coin haut-gauche est (x, y). */
function doorTiles(x: number, y: number, w = 2, h = 2): TileXY[] {
  const out: TileXY[] = [];
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) out.push([xx, yy]);
  return out;
}

/** Clé d'étiquette de mécanisme : `mech.level6.<roomId>.<mechanismId>`. */
function mechLabel(room: string, mechanismId: string): string {
  return `mech.level6.${room}.${mechanismId}`;
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

/** Nom, indice d'arrivée : clés `room.level6.<id>.name` et `hintroom.level6.<id>`. */
function roomKeys(id: string): { nameKey: string; introHintKey: string } {
  return { nameKey: `room.level6.${id}.name`, introHintKey: `hintroom.level6.${id}` };
}

/** Pont de lumière de la salle `room` (étiquette `mech.level6.<room>.<id>`). */
function lightBridge(room: string, id: string, tiles: TileXY[], lanternSlot: number, radiusTiles: number): MechanismDef {
  return { id, type: 'lightBridge', tiles, lanternSlot, radiusTiles, labelKey: mechLabel(room, id) };
}

/**
 * Types d'ennemis des salles à abîme : uniquement des créatures TERRESTRES (pas de chauves-souris ni de feux follets, qui pourraient rester
 * suspendus au-dessus du vide, hors de portée, et empêcher le « clear » d'une rive). Les volants sont réservés aux arènes sans abîme.
 */
const GROUND: readonly EnemyKind[] = ['slime', 'skeleton', 'spider', 'slime', 'skeleton', 'spider'];
const GROUND_TOUGH: readonly EnemyKind[] = ['skeleton', 'spider', 'slime', 'skeleton', 'slime', 'spider', 'knight'];

// ───────────────────────────── Salle 1 : Le Quai des Étoiles ─────────────────────────────
//
// 60×44. Idée : APPRENDRE le pont de lumière, calmement. Le quai ouest (x2..27) est séparé du quai est (x40..57) par un abîme de
// 12 tuiles ; un seul pont droit, y22 x28..39, que seul le porteur de la lanterne (slot 0, bleu) éclaire dans un halo généreux
// (3,5 tuiles). Quelques limons rôdent sur le quai ouest (à vaincre avant de passer) ; sur le quai est une embuscade légère ne se
// déclenche qu'en s'éloignant du pont (zone x47..56).
// Résolution : vaincre les rôdeurs du quai ouest ; le héros bleu avance sur le pont, les autres le suivent de près (restent dans
// son halo) jusqu'à la tuile d'atterrissage [40,22] ; on s'avance dans la zone [47..56, 9..34] : l'embuscade surgit ; la vaincre ;
// tous à la sortie [53..56, 19..24].

const quay: RoomDef = (() => {
  const spawn: TileXY = [4, 22];
  const b = new LayoutBuilder(60, 44).pit(28, 2, 12, 40).floor(2, 8, 26, 28).floor(40, 8, 18, 28);
  const bridge = b.bridge([28, 22], [39, 22]);
  b.reserve(rect(2, 18, 9, 9), rect(22, 18, 6, 9), rect(40, 18, 6, 9), rect(52, 17, 6, 11))
    .pillarGrid(rect(4, 10, 20, 24), 6, 6, 2, 2)
    .pillarGrid(rect(42, 10, 14, 24), 6, 6, 3, 2);
  const rows = b.rows();
  const p = new Placer(rows, spawn, [around(bridge[0]), around(bridge[bridge.length - 1]), rect(52, 17, 6, 11)])
    .fill(rect(14, 9, 13, 26), ['slime', 'slime', 'spider'], 6)
    .ambush(bridge[bridge.length - 1], 'farShore', rect(47, 9, 10, 26), ['slime', 'skeleton', 'spider', 'spider'], 8);
  return {
    id: 'quay',
    ...roomKeys('quay'),
    theme: 'void',
    layout: rows,
    playerSpawns: spawns(...spawn),
    enemies: p.tiered(),
    mechanisms: [lightBridge('quay', 'quayBridge', bridge, 0, 3.5)],
    zones: [{ id: 'farShore', rect: rect(47, 9, 10, 26) }],
    signs: [p.sign('quay', 'lantern', 7, 22), p.sign('quay', 'bridge', 24, 20), p.sign('quay', 'shore', 43, 20)],
    decor: [
      ...wallDecor(rows, 'torch', rect(2, 8, 26, 28), 8),
      ...wallDecor(rows, 'torch', rect(40, 8, 18, 28), 8),
      ...wallDecor(rows, 'torch', rect(2, 8, 26, 28), 12, 'south', 6),
      ...p.decor('crystal', [3, 9], [26, 9], [3, 34], [26, 34], [42, 9], [56, 34]).decor('statue', [24, 18], [24, 26], [42, 18], [42, 26])
        .decor('bones', [14, 28], [48, 14]).decor('crate', [3, 10], [3, 33]).decors,
    ],
    exit: { rect: rect(53, 19, 4, 6), requires: ['clear'] },
  };
})();

// ───────────────────────────── Salle 2 : Les Îlots de Repos ─────────────────────────────
//
// 64×46, SOMBRE. Idée : deux ponts COURTS séparés par un îlot de repos. Premier pont y24 x20..29 (porteur : slot 1, rouge), îlot
// [30..41, 16..31], second pont avec un coude [42..46,24]→[46,27]→[47..51,27] (porteur : slot 2, vert), plate-forme d'arrivée
// [52..61, 10..37]. Des gardiens sur la plate-forme de départ (à vaincre avant de passer) ; une embuscade surgit sur l'îlot (zone
// x36..41) puis sur la plate-forme d'arrivée (zone x58..61). Des braseros allumés (recharge de torche) à chaque étape.
// Résolution : vaincre les gardiens ; le héros rouge guide le premier pont ; on gagne l'îlot, on s'avance dans [36..41, 22..31] :
// embuscade, vaincre ; le héros vert guide le second pont (coude) ; on s'avance dans [58..61, 11..36] : embuscade, vaincre ; sortie
// [58..60, 24..29].

const islets: RoomDef = (() => {
  const spawn: TileXY = [4, 24];
  const b = new LayoutBuilder(64, 46).pit(20, 4, 32, 38).floor(2, 12, 18, 24).floor(30, 16, 12, 16).floor(52, 10, 10, 28);
  const bridge1 = b.bridge([20, 24], [29, 24]);
  const bridge2 = b.bridge([42, 24], [46, 24], [46, 27], [51, 27]);
  b.reserve(rect(2, 20, 8, 9), rect(15, 20, 5, 9), rect(30, 20, 5, 9), rect(38, 21, 4, 8), rect(52, 23, 5, 8), rect(56, 22, 6, 10))
    .pillarGrid(rect(4, 13, 14, 22), 5, 5, 2, 2)
    .pillarGrid(rect(54, 11, 7, 26), 5, 5, 2, 2);
  const rows = b.rows();
  const avoid = [around(bridge1[0]), around(bridge1[bridge1.length - 1]), around(bridge2[0]), around(bridge2[bridge2.length - 1]), rect(56, 22, 5, 10)];
  const p = new Placer(rows, spawn, avoid)
    .lit('islets', 'isletsFire1', 7, 20)
    .lit('islets', 'isletsFire2', 35, 19)
    .lit('islets', 'isletsFire3', 35, 28)
    .lit('islets', 'isletsFire4', 55, 14)
    .lit('islets', 'isletsFire5', 55, 34)
    .fill(rect(14, 13, 6, 22), GROUND, 4)
    .fill(rect(8, 13, 12, 22), GROUND, 8)
    .ambush(bridge1[bridge1.length - 1], 'isletZone', rect(36, 17, 6, 14), GROUND, 7)
    .ambush(bridge1[bridge1.length - 1], 'isletZone', rect(31, 17, 11, 14), ['skeleton', 'spider', 'slime', 'spider'], 7)
    .ambush(bridge2[bridge2.length - 1], 'farBank', rect(58, 11, 4, 26), GROUND_TOUGH, 7)
    .ambush(bridge2[bridge2.length - 1], 'farBank', rect(54, 11, 8, 26), GROUND, 7);
  return {
    id: 'islets',
    ...roomKeys('islets'),
    theme: 'void',
    layout: rows,
    playerSpawns: spawns(...spawn),
    enemies: p.tiered(),
    mechanisms: [...p.fires, lightBridge('islets', 'bridgeOne', bridge1, 1, 3), lightBridge('islets', 'bridgeTwo', bridge2, 2, 3)],
    zones: [
      { id: 'isletZone', rect: rect(36, 22, 6, 10) },
      { id: 'farBank', rect: rect(58, 11, 4, 26) },
    ],
    signs: [p.sign('islets', 'dark', 6, 22), p.sign('islets', 'rest', 33, 22), p.sign('islets', 'second', 38, 26), p.sign('islets', 'bank', 55, 24)],
    decor: [
      ...torchesAt(rows, [19, 23], [19, 25], [30, 23], [30, 25], [41, 23], [41, 25], [52, 26], [52, 28], [6, 23], [3, 24]),
      ...p.decor('crystal', [3, 13], [18, 34], [32, 17], [40, 30], [60, 11], [60, 36]).decor('statue', [18, 20], [18, 28], [53, 12], [53, 36])
        .decor('bones', [10, 30], [35, 25]).decors,
    ],
    exit: { rect: rect(58, 24, 3, 6), requires: ['clear'] },
    dark: true,
  };
})();

// ───────────────────────────── Salle 3 : La Terrasse des Balises ─────────────────────────────
//
// 78×48. Idée : un LONG pont sinueux (50 tuiles, porteur : slot 3, jaune) mène à une île où se tient la balise ; on combine le pont avec
// des LEVIERS à fenêtre (un par héros, aux quatre coins de l'île) et une ZONE à tenir (objectif du héros rouge : la balise, 8 s).
// La porte [70..71, 30..31] s'ouvre quand les quatre leviers sont tirés presque ensemble ET que la balise a été tenue ; derrière,
// la chambre de sortie [72..76, 24..37].
// Résolution : vaincre les rôdeurs de la plate-forme de départ ; le héros jaune porte la lanterne sur le pont [22..51, 18..30] ;
// l'embuscade de l'île (zone x60..68) surgit ; la vaincre ; le héros rouge tient la balise [58..62, 28..33] 8 s ; chacun tire SON
// levier — bleu [54,22], rouge [67,22], vert [54,39], jaune [67,39] — dans la fenêtre de 12 s ; la porte s'ouvre ; sortie [73..75, 28..33].

const terrace: RoomDef = (() => {
  const spawn: TileXY = [4, 26];
  const leverTiles: TileXY[] = [
    [54, 22],
    [67, 22],
    [54, 39],
    [67, 39],
  ];
  const b = new LayoutBuilder(78, 48)
    .pit(22, 10, 30, 34)
    .floor(2, 16, 20, 22)
    .floor(52, 20, 18, 22)
    .floor(70, 30, 2, 2)
    .floor(72, 24, 5, 14);
  const bridge = b.bridge([22, 26], [32, 26], [32, 18], [42, 18], [42, 30], [51, 30]);
  b.reserve(rect(2, 22, 8, 9), rect(17, 22, 5, 9), rect(52, 26, 5, 9), rect(56, 26, 9, 9), rect(66, 27, 5, 8), ...leverTiles.map((t) => around(t)))
    .pillarGrid(rect(4, 17, 16, 20), 5, 5, 2, 2)
    .pillarGrid(rect(54, 21, 14, 20), 5, 5, 2, 2);
  const rows = b.rows();
  const avoid = [around(bridge[0]), around(bridge[bridge.length - 1]), ...leverTiles.map((t) => around(t)), rect(65, 27, 7, 8)];
  const p = new Placer(rows, spawn, avoid)
    .lit('terrace', 'terraceFire1', 7, 22)
    .lit('terrace', 'terraceFire2', 56, 25)
    .lit('terrace', 'terraceFire3', 56, 36)
    .lit('terrace', 'terraceFire4', 74, 26)
    .fill(rect(14, 17, 8, 20), GROUND, 5)
    .fill(rect(6, 17, 15, 20), GROUND, 10)
    .ambush(bridge[bridge.length - 1], 'isleZone', rect(60, 21, 9, 20), GROUND_TOUGH, 11)
    .ambush(bridge[bridge.length - 1], 'isleZone', rect(55, 21, 14, 20), ['spider', 'skeleton', 'slime', 'spider', 'spider'], 11);
  const mechanisms: MechanismDef[] = [...p.fires, lightBridge('terrace', 'terraceBridge', bridge, 3, 2.5)];
  COLORS.forEach((color, slot) => {
    const base = {
      id: `terraceLever${color}`,
      type: 'lever' as const,
      tile: leverTiles[slot],
      ownerSlot: slot,
      windowMs: 12000,
      labelKey: mechLabel('terrace', `terraceLever${color}`),
    };
    mechanisms.push(slot === 0 ? base : { ...base, minPlayers: slot + 1 });
  });
  mechanisms.push({
    id: 'terraceDoor',
    type: 'door',
    tiles: doorTiles(70, 30),
    requires: [...COLORS.map((c) => `terraceLever${c}`), 'obj:beacon'],
    labelKey: mechLabel('terrace', 'terraceDoor'),
  });
  return {
    id: 'terrace',
    ...roomKeys('terrace'),
    theme: 'void',
    layout: rows,
    playerSpawns: spawns(...spawn),
    enemies: p.tiered(),
    mechanisms,
    zones: [
      { id: 'isleZone', rect: rect(60, 21, 9, 20) },
      { id: 'beaconZone', rect: rect(58, 28, 5, 6) },
    ],
    signs: [p.sign('terrace', 'winding', 8, 26), p.sign('terrace', 'island', 55, 30), p.sign('terrace', 'beacon', 57, 31), p.sign('terrace', 'levers', 63, 25)],
    decor: [
      ...wallDecor(rows, 'torch', rect(2, 16, 20, 22), 7),
      ...wallDecor(rows, 'torch', rect(72, 24, 5, 14), 3, 'north', 1),
      ...p.decor('crystal', [59, 30], [62, 30], [59, 33], [62, 33], [3, 17], [20, 36], [68, 21], [53, 40]).decor('statue', [53, 21], [68, 40], [4, 35], [20, 17])
        .decor('bones', [12, 30], [64, 36]).decors,
    ],
    exit: { rect: rect(73, 28, 3, 6), requires: ['terraceDoor'] },
  };
})();

// ───────────────────────────── Salle 4 : La Salle du Spectre (demi-boss n°1) ─────────────────────────────
//
// 64×48. Idée : DEMI-BOSS à mi-parcours. Une grande arène sans aucun abîme (le spectre est VOLANT : il ne doit jamais se réfugier hors de
// portée), des piliers de couverture, le spectre (`wraith`, présent à tous les nombres de joueurs) et ses sbires (suivent les
// joueurs). La sortie exige le spectre vaincu (`clear`) ET la porte [52..53, 23..24], qui s'ouvre quand les quatre plaques de couleur
// des coins sont tenues en même temps (bleue min 1, rouge min 2, verte min 3, jaune min 4).
// Résolution : se couvrir derrière les piliers, vaincre le spectre et ses sbires ; chaque héros tient SA plaque — bleue [7,7],
// rouge [46,7], verte [7,40], jaune [46,40] — la porte s'ouvre ; tous à la sortie [57..60, 22..27].

const wraithhall: RoomDef = (() => {
  const spawn: TileXY = [4, 24];
  const plates: Record<string, TileXY> = { Blue: [7, 7], Red: [46, 7], Green: [7, 40], Yellow: [46, 40] };
  const b = new LayoutBuilder(64, 48).floor(2, 4, 50, 40).floor(52, 23, 2, 2).floor(54, 18, 8, 14);
  [
    [14, 11],
    [14, 35],
    [24, 17],
    [24, 29],
    [34, 11],
    [34, 35],
    [32, 23],
    [41, 17],
    [41, 29],
  ].forEach(([x, y]) => b.pillarBlock(x, y));
  b.pillar([20, 23], [28, 7], [28, 40], [48, 23]);
  const rows = b.rows();
  const platesAvoid = Object.values(plates).map((t) => around(t));
  const p = new Placer(rows, spawn, [...platesAvoid, rect(48, 20, 6, 8)])
    .lit('wraithhall', 'wraithhallFire1', 8, 20)
    .lit('wraithhall', 'wraithhallFire2', 40, 6)
    .lit('wraithhall', 'wraithhallFire3', 40, 41)
    .foe('wraith', 44, 24)
    .fill(rect(20, 5, 31, 38), ['wisp', 'bat', 'skeleton', 'spider', 'bat', 'wisp', 'slime'], 26);
  const mechanisms: MechanismDef[] = [...p.fires];
  COLORS.forEach((color, slot) => {
    const base = {
      id: `wraithPlate${color}`,
      type: 'plate' as const,
      tile: plates[color],
      colorSlot: slot,
      labelKey: mechLabel('wraithhall', `wraithPlate${color}`),
    };
    mechanisms.push(slot === 0 ? base : { ...base, minPlayers: slot + 1 });
  });
  mechanisms.push({
    id: 'wraithDoor',
    type: 'door',
    tiles: doorTiles(52, 23),
    requires: COLORS.map((c) => `wraithPlate${c}`),
    labelKey: mechLabel('wraithhall', 'wraithDoor'),
  });
  return {
    id: 'wraithhall',
    ...roomKeys('wraithhall'),
    theme: 'void',
    layout: rows,
    playerSpawns: spawns(...spawn),
    enemies: p.tiered(),
    mechanisms,
    signs: [p.sign('wraithhall', 'wraith', 8, 24), p.sign('wraithhall', 'plates', 10, 14), p.sign('wraithhall', 'door', 49, 22)],
    decor: [
      ...wallDecor(rows, 'torch', rect(2, 4, 50, 40), 8),
      ...wallDecor(rows, 'banner', rect(2, 4, 50, 40), 12, 'north', 6),
      ...p.decor('crystal', [3, 5], [50, 5], [3, 42], [50, 42], [55, 19], [60, 30]).decor('statue', [3, 22], [3, 26], [50, 22], [50, 26])
        .decor('bones', [22, 12], [36, 30], [45, 15]).decors,
    ],
    exit: { rect: rect(57, 22, 4, 6), requires: ['wraithDoor', 'clear'] },
  };
})();

// ───────────────────────────── Salle 5 : La Galerie des Éclipses ─────────────────────────────
//
// 80×50, SOMBRE. Idée : CLÉS personnelles + long pont (porteur : slot 0, bleu). Le hall ouest [2..39, 12..37] ouvre sur quatre chambres
// de coin (une clé par héros : bleue [7,5], rouge [33,5], verte [7,44], jaune [33,44]) ; un pont long et sinueux ([40..47,25] puis
// [47,24..16] puis [48..56,16]) mène à la rive est [57..70, 8..33], où quatre portes à clé (une par couleur, dans le mur x71..72) donnent
// sur la galerie de sortie [73..77, 8..33]. Chaque héros ne ramasse QUE sa clé et n'ouvre QUE sa porte. Coop adaptative : les clés et
// portes des slots 1..3 n'existent qu'à 2..4 joueurs. Objectif slot 0 « seal » : la porte bleue.
// Résolution : chacun va chercher SA clé dans SA chambre ; on se regroupe au départ du pont, le héros bleu guide ; embuscade sur la rive
// est (zone x64..69) ; chacun ouvre SA porte [71..72, 10..11] / [15..16] / [20..21] / [25..26] (bleu, rouge, vert, jaune) ; sortie [74..76, 14..27].

const keys: RoomDef = (() => {
  const spawn: TileXY = [4, 25];
  const keyTiles: TileXY[] = [
    [7, 5],
    [33, 5],
    [7, 44],
    [33, 44],
  ];
  const doorTop = [10, 15, 20, 25];
  const b = new LayoutBuilder(80, 50)
    .pit(40, 8, 17, 34)
    .floor(2, 12, 38, 26)
    .floor(2, 2, 12, 8)
    .floor(28, 2, 12, 8)
    .floor(2, 40, 12, 8)
    .floor(28, 40, 12, 8)
    .floor(6, 10, 3, 2)
    .floor(32, 10, 3, 2)
    .floor(6, 38, 3, 2)
    .floor(32, 38, 3, 2)
    .floor(57, 8, 14, 26)
    .floor(71, 10, 2, 2)
    .floor(71, 15, 2, 2)
    .floor(71, 20, 2, 2)
    .floor(71, 25, 2, 2)
    .floor(73, 8, 5, 26);
  const bridge = b.bridge([40, 25], [47, 25], [47, 16], [56, 16]);
  b.reserve(rect(2, 21, 8, 9), rect(34, 20, 6, 10), rect(57, 12, 6, 9), rect(64, 8, 7, 26), ...keyTiles.map((t) => around(t)), rect(5, 10, 5, 3), rect(31, 10, 5, 3), rect(5, 37, 5, 3), rect(31, 37, 5, 3))
    .pillarGrid(rect(4, 13, 32, 24), 6, 5, 3, 2)
    .pillarGrid(rect(4, 3, 8, 6), 4, 3, 2, 1)
    .pillarGrid(rect(30, 3, 8, 6), 4, 3, 2, 1)
    .pillarGrid(rect(4, 41, 8, 6), 4, 3, 2, 1)
    .pillarGrid(rect(30, 41, 8, 6), 4, 3, 2, 1);
  const rows = b.rows();
  const avoid = [around(bridge[0]), around(bridge[bridge.length - 1]), ...keyTiles.map((t) => around(t)), rect(68, 8, 5, 26), rect(5, 10, 5, 3), rect(31, 10, 5, 3), rect(5, 37, 5, 3), rect(31, 37, 5, 3)];
  const p = new Placer(rows, spawn, avoid)
    .lit('keys', 'keysFire1', 7, 21)
    .lit('keys', 'keysFire2', 36, 24)
    .lit('keys', 'keysFire3', 36, 30)
    .lit('keys', 'keysFire4', 59, 12)
    .lit('keys', 'keysFire5', 59, 30)
    .lit('keys', 'keysFire6', 75, 12)
    .lit('keys', 'keysFire7', 10, 6)
    .lit('keys', 'keysFire8', 31, 7)
    .lit('keys', 'keysFire9', 10, 44)
    .lit('keys', 'keysFire10', 31, 42)
    // gardiens des clés (mêmes paliers que leurs clés) et chambres
    .fill(rect(2, 2, 12, 8), ['skeleton', 'spider', 'slime'], 4)
    .fill(rect(28, 2, 12, 8), ['spider', 'spider', 'skeleton'], 4)
    .fill(rect(2, 40, 12, 8), ['skeleton', 'slime', 'spider'], 4)
    .fill(rect(28, 40, 12, 8), ['spider', 'skeleton', 'slime'], 4)
    // grand hall
    .fill(rect(14, 13, 24, 24), GROUND_TOUGH, 14)
    // rive est : embuscade
    .ambush(bridge[bridge.length - 1], 'eastBank', rect(64, 9, 6, 24), GROUND_TOUGH, 8)
    .ambush(bridge[bridge.length - 1], 'eastBank', rect(60, 9, 10, 24), GROUND, 8);
  const mechanisms: MechanismDef[] = [...p.fires, lightBridge('keys', 'keysBridge', bridge, 0, 3)];
  COLORS.forEach((color, slot) => {
    const extra = slot === 0 ? {} : { minPlayers: slot + 1 };
    mechanisms.push({
      id: `key${color}`,
      type: 'key',
      tile: keyTiles[slot],
      ownerSlot: slot,
      doorId: `door${color}`,
      labelKey: mechLabel('keys', `key${color}`),
      ...extra,
    });
    mechanisms.push({
      id: `door${color}`,
      type: 'door',
      tiles: doorTiles(71, doorTop[slot]),
      requires: [],
      keyId: `key${color}`,
      labelKey: mechLabel('keys', `door${color}`),
      ...extra,
    });
  });
  return {
    id: 'keys',
    ...roomKeys('keys'),
    theme: 'void',
    layout: rows,
    playerSpawns: spawns(...spawn),
    enemies: p.tiered(),
    mechanisms,
    zones: [{ id: 'eastBank', rect: rect(64, 9, 6, 24) }],
    signs: [p.sign('keys', 'dark', 7, 25), p.sign('keys', 'keys', 12, 19), p.sign('keys', 'bridge', 36, 27), p.sign('keys', 'doors', 66, 20)],
    decor: [
      ...torchesAt(rows, [3, 25], [6, 12], [34, 12], [6, 37], [34, 37], [39, 24], [39, 26], [57, 15], [57, 17], [70, 9], [70, 28], [74, 20]),
      ...p.decor('crystal', [3, 13], [38, 36], [2, 2], [39, 2], [2, 47], [39, 47], [58, 9], [69, 32]).decor('statue', [37, 13], [37, 36], [58, 32])
        .decor('bones', [20, 25], [62, 24]).decors,
    ],
    exit: { rect: rect(74, 14, 3, 14), requires: COLORS.map((c) => `door${c}`) },
    dark: true,
  };
})();

// ───────────────────────────── Salle 6 : Le Sanctuaire des Braises ─────────────────────────────
//
// 76×46, SOMBRE. Idée : pont sinueux (35 tuiles, porteur : slot 1, rouge) puis ALLUMAGE : quatre braseros de couleur dans les coins du
// sanctuaire ; chaque héros allume SON brasero (ownerSlot 0..3, minPlayers = slot + 1) ; la porte [68..69, 21..22] exige les quatre.
// Objectif slot 3 « ember » : le brasero jaune. Une torche s'use : des braseros allumés rechargent (un à l'arrivée du pont, un au sanctuaire).
// Résolution : vaincre les gardiens de la plate-forme de départ ; le héros rouge guide le pont [22..32, 23] → [32, 22..14] → [33..47, 14] ;
// embuscade sanctuaire (zone x57..66) ; vaincre ; recharger sa torche à un brasero allumé si besoin ; chacun allume SON brasero — bleu
// [51,11], rouge [64,11], vert [51,34], jaune [64,34] ; la porte s'ouvre ; sortie [71..73, 18..25].

const embers: RoomDef = (() => {
  const spawn: TileXY = [4, 23];
  const emberTiles: TileXY[] = [
    [51, 11],
    [64, 11],
    [51, 34],
    [64, 34],
  ];
  const b = new LayoutBuilder(76, 46).pit(22, 6, 26, 34).floor(2, 10, 20, 26).floor(48, 8, 20, 30).floor(68, 21, 2, 2).floor(70, 12, 5, 22);
  const bridge = b.bridge([22, 23], [32, 23], [32, 14], [47, 14]);
  b.reserve(rect(2, 19, 8, 9), rect(17, 19, 5, 9), rect(48, 10, 5, 8), rect(55, 18, 12, 10), rect(65, 18, 5, 8), ...emberTiles.map((t) => around(t)))
    .pillarGrid(rect(4, 11, 16, 24), 5, 5, 2, 2)
    .pillarGrid(rect(50, 9, 16, 28), 5, 5, 2, 2);
  const rows = b.rows();
  const avoid = [around(bridge[0]), around(bridge[bridge.length - 1]), rect(64, 19, 6, 6)];
  const p = new Placer(rows, spawn, avoid)
    .lit('embers', 'embersFire1', 7, 19)
    .lit('embers', 'embersFire2', 50, 23)
    .lit('embers', 'embersFire3', 57, 23)
    .lit('embers', 'embersFire4', 72, 16)
    .lit('embers', 'embersFire5', 57, 36);
  COLORS.forEach((color, slot) => {
    p.unlit('embers', `emberBrazier${color}`, `emberBrazier${color}`, emberTiles[slot][0], emberTiles[slot][1], {
      ownerSlot: slot,
      lightRadiusTiles: 4,
      ...(slot === 0 ? {} : { minPlayers: slot + 1 }),
    });
  });
  p.forbid(...emberTiles.map((t) => around(t)))
    .fill(rect(14, 11, 8, 24), GROUND, 5)
    .fill(rect(6, 11, 15, 24), GROUND_TOUGH, 10)
    .ambush(bridge[bridge.length - 1], 'sanctumZone', rect(57, 9, 10, 28), GROUND_TOUGH, 12)
    .ambush(bridge[bridge.length - 1], 'sanctumZone', rect(50, 9, 17, 28), ['spider', 'skeleton', 'slime', 'spider', 'spider'], 12);
  const mechanisms: MechanismDef[] = [...p.fires];
  mechanisms.push(lightBridge('embers', 'embersBridge', bridge, 1, 2.5));
  mechanisms.push({
    id: 'embersDoor',
    type: 'door',
    tiles: doorTiles(68, 21),
    requires: COLORS.map((c) => `emberBrazier${c}`),
    labelKey: mechLabel('embers', 'embersDoor'),
  });
  return {
    id: 'embers',
    ...roomKeys('embers'),
    theme: 'void',
    layout: rows,
    playerSpawns: spawns(...spawn),
    enemies: p.tiered(),
    mechanisms,
    zones: [{ id: 'sanctumZone', rect: rect(57, 9, 10, 28) }],
    signs: [p.sign('embers', 'dark', 7, 23), p.sign('embers', 'winding', 18, 22), p.sign('embers', 'braziers', 54, 22), p.sign('embers', 'refuel', 56, 25)],
    decor: [
      ...torchesAt(rows, [21, 22], [21, 24], [48, 13], [48, 15], [3, 23], [68, 20], [68, 23], [72, 14], [72, 31]),
      ...p.decor('crystal', [3, 11], [20, 34], [49, 9], [66, 36], [74, 12], [74, 32]).decor('statue', [49, 36], [66, 9], [4, 34], [20, 11])
        .decor('bones', [12, 28], [60, 30]).decors,
    ],
    exit: { rect: rect(71, 18, 3, 8), requires: ['embersDoor'] },
    dark: true,
  };
})();

// ───────────────────────────── Salle 7 : Le Foyer du Spectre (demi-boss n°2) ─────────────────────────────
//
// 70×50. Idée : DEMI-BOSS n°2, dans une salle clé : le second spectre, escorté de bien plus de sbires, garde le foyer. Arène sans
// abîme, piliers de couverture. Quatre leviers à fenêtre (12 s) aux quatre coins — bleu min 1, rouge min 2, vert min 3, jaune min 4 —
// ouvrent la porte [58..59, 24..25] ; la sortie exige en plus le spectre vaincu (`clear`) et l'objectif « chasse » (4 coups fatals du
// héros vert, accompli d'office si l'arène est vidée).
// Résolution : vaincre le spectre et ses sbires (le héros vert doit porter 4 coups fatals) ; chacun tire SON levier — bleu [5,7], rouge
// [54,7], vert [5,42], jaune [54,42] — dans la fenêtre ; la porte s'ouvre ; tous à la sortie [63..66, 22..27].

const hearth: RoomDef = (() => {
  const spawn: TileXY = [4, 25];
  const leverTiles: TileXY[] = [
    [5, 7],
    [54, 7],
    [5, 42],
    [54, 42],
  ];
  const b = new LayoutBuilder(70, 50).floor(2, 4, 56, 42).floor(58, 24, 2, 2).floor(60, 18, 8, 14);
  [
    [12, 11],
    [12, 37],
    [22, 17],
    [22, 31],
    [32, 11],
    [32, 37],
    [30, 24],
    [40, 17],
    [40, 31],
    [48, 24],
  ].forEach(([x, y]) => b.pillarBlock(x, y));
  b.pillar([18, 24], [26, 7], [26, 42], [46, 11], [46, 37]);
  const rows = b.rows();
  const p = new Placer(rows, spawn, [...leverTiles.map((t) => around(t)), rect(52, 21, 6, 8)])
    .lit('hearth', 'hearthFire1', 8, 21)
    .lit('hearth', 'hearthFire2', 38, 6)
    .lit('hearth', 'hearthFire3', 38, 44)
    .foe('wraith', 46, 27)
    .fill(rect(18, 5, 38, 40), ['spider', 'wisp', 'bat', 'skeleton', 'slime', 'bat', 'wisp', 'spider', 'knight'], 34);
  const mechanisms: MechanismDef[] = [...p.fires];
  COLORS.forEach((color, slot) => {
    const base = {
      id: `hearthLever${color}`,
      type: 'lever' as const,
      tile: leverTiles[slot],
      ownerSlot: slot,
      windowMs: 12000,
      labelKey: mechLabel('hearth', `hearthLever${color}`),
    };
    mechanisms.push(slot === 0 ? base : { ...base, minPlayers: slot + 1 });
  });
  mechanisms.push({
    id: 'hearthDoor',
    type: 'door',
    tiles: doorTiles(58, 24),
    requires: COLORS.map((c) => `hearthLever${c}`),
    labelKey: mechLabel('hearth', 'hearthDoor'),
  });
  return {
    id: 'hearth',
    ...roomKeys('hearth'),
    theme: 'void',
    layout: rows,
    playerSpawns: spawns(...spawn),
    enemies: p.tiered(),
    mechanisms,
    signs: [p.sign('hearth', 'wraith', 8, 25), p.sign('hearth', 'hunt', 10, 20), p.sign('hearth', 'levers', 12, 29), p.sign('hearth', 'door', 55, 22)],
    decor: [
      ...wallDecor(rows, 'torch', rect(2, 4, 56, 42), 8),
      ...wallDecor(rows, 'banner', rect(2, 4, 56, 42), 12, 'north', 6),
      ...p.decor('crystal', [3, 5], [56, 5], [3, 44], [56, 44], [61, 19], [66, 30]).decor('statue', [3, 23], [3, 27], [56, 23], [56, 27])
        .decor('bones', [20, 12], [36, 34], [50, 14], [24, 38]).decors,
    ],
    exit: { rect: rect(63, 22, 4, 6), requires: ['hearthDoor', 'obj:hunt', 'clear'] },
  };
})();

// ───────────────────────────── Salle 8 : Le Grand Pont des Âmes ─────────────────────────────
//
// 86×52, SOMBRE. Idée : le pont des ponts. QUATRE ponts à la suite, porteurs successifs : slots 0, 1, 2, 3 — chaque héros guide les autres
// à son tour. Cinq plates-formes : le quai de départ P0 [3..16, 34..47], trois îlots I1 [30..43, 24..36], I2 [45..58, 8..20], I3 [58..71,
// 26..38], et la rive d'arrivée P4 [72..83, 6..20]. Ponts : seg1 y40 x17..26 puis x26 y39..30 puis y30 x27..29 (23 tuiles) ; seg2 x36 y23..14
// puis y14 x37..44 (18) ; seg3 y14 x59..66 puis x66 y15..25 (19) ; seg4 y32 x72..76 puis x76 y31..21 (16). Le quai de départ est trop étroit pour des gardiens
// (aucun ennemi à < 12 tuiles de l'arrivée) ; chaque îlot et la rive d'arrivée abritent une embuscade (zones ≥ 6 tuiles de l'atterrissage).
// Résolution : seg1 (slot 0) ; embuscade I1, vaincre ; seg2 (slot 1) ; embuscade I2 ; seg3 (slot 2) ; embuscade
// I3 ; seg4 (slot 3) ; embuscade de la rive ; vaincre ; sortie [77..81, 8..12].

const gauntlet: RoomDef = (() => {
  const spawn: TileXY = [5, 40];
  const b = new LayoutBuilder(86, 52)
    .pit(1, 1, 84, 50)
    .floor(3, 34, 14, 14)
    .floor(30, 24, 14, 13)
    .floor(45, 8, 14, 13)
    .floor(58, 26, 14, 13)
    .floor(72, 6, 12, 15);
  const seg1 = b.bridge([17, 40], [26, 40], [26, 30], [29, 30]);
  const seg2 = b.bridge([36, 23], [36, 14], [44, 14]);
  const seg3 = b.bridge([59, 14], [66, 14], [66, 25]);
  const seg4 = b.bridge([72, 32], [76, 32], [76, 21]);
  const segs = [seg1, seg2, seg3, seg4];
  b.reserve(rect(3, 37, 8, 8), rect(12, 36, 5, 8), rect(30, 27, 5, 7), rect(32, 21, 7, 6), rect(39, 11, 6, 7), rect(45, 11, 5, 7), rect(55, 11, 4, 7), rect(61, 14, 10, 4), rect(60, 26, 12, 6), rect(66, 27, 6, 8), rect(72, 14, 8, 7), rect(76, 6, 8, 8))
    .pillarGrid(rect(4, 35, 12, 12), 5, 5, 2, 2)
    .pillarGrid(rect(31, 25, 12, 11), 5, 5, 3, 2)
    .pillarGrid(rect(46, 9, 12, 11), 5, 5, 2, 2)
    .pillarGrid(rect(59, 27, 12, 11), 5, 5, 3, 2)
    .pillarGrid(rect(73, 7, 10, 13), 5, 5, 2, 2);
  const rows = b.rows();
  const avoid = segs.flatMap((s) => [around(s[0]), around(s[s.length - 1])]);
  const p = new Placer(rows, spawn, avoid)
    .lit('gauntlet', 'gauntletFire1', 8, 38)
    .lit('gauntlet', 'gauntletFire2', 36, 26)
    .lit('gauntlet', 'gauntletFire3', 40, 34)
    .lit('gauntlet', 'gauntletFire4', 50, 11)
    .lit('gauntlet', 'gauntletFire5', 55, 18)
    .lit('gauntlet', 'gauntletFire6', 62, 29)
    .lit('gauntlet', 'gauntletFire7', 69, 36)
    .lit('gauntlet', 'gauntletFire8', 75, 9)
    .lit('gauntlet', 'gauntletFire9', 80, 18)
    // îlot 1 : embuscade
    .ambush(seg1[seg1.length - 1], 'isleOne', rect(37, 25, 6, 11), GROUND_TOUGH, 8)
    .ambush(seg1[seg1.length - 1], 'isleOne', rect(31, 25, 12, 11), GROUND, 8)
    // îlot 2 : embuscade
    .ambush(seg2[seg2.length - 1], 'isleTwo', rect(51, 9, 7, 11), GROUND_TOUGH, 8)
    .ambush(seg2[seg2.length - 1], 'isleTwo', rect(46, 9, 12, 11), ['spider', 'skeleton', 'slime', 'spider'], 8)
    // îlot 3 : embuscade
    .ambush(seg3[seg3.length - 1], 'isleThree', rect(60, 31, 11, 7), GROUND_TOUGH, 8)
    .ambush(seg3[seg3.length - 1], 'isleThree', rect(59, 30, 12, 8), GROUND, 8)
    // rive d'arrivée : embuscade finale
    .ambush(seg4[seg4.length - 1], 'farRiver', rect(77, 7, 6, 8), GROUND_TOUGH, 9)
    .ambush(seg4[seg4.length - 1], 'farRiver', rect(73, 7, 10, 9), ['spider', 'skeleton', 'slime', 'spider', 'spider'], 9);
  return {
    id: 'gauntlet',
    ...roomKeys('gauntlet'),
    theme: 'void',
    layout: rows,
    playerSpawns: spawns(...spawn),
    enemies: p.tiered(),
    mechanisms: [
      ...p.fires,
      lightBridge('gauntlet', 'bridgeA', seg1, 0, 2.5),
      lightBridge('gauntlet', 'bridgeB', seg2, 1, 2.5),
      lightBridge('gauntlet', 'bridgeC', seg3, 2, 2.5),
      lightBridge('gauntlet', 'bridgeD', seg4, 3, 2.5),
    ],
    zones: [
      // Chaque zone englobe les tuiles d'accès au pont SUIVANT ([36,24] ; [58,13..15] ; [71,31..33]) : impossible de s'engager sur le
      // pont suivant sans avoir déclenché l'embuscade (sinon `clear` resterait faux avec des ennemis invisibles, et il faudrait
      // revenir en arrière). Chacune reste à ≥ 6 tuiles de l'atterrissage (testé).
      { id: 'isleOne', rect: rect(35, 24, 8, 12) },
      { id: 'isleTwo', rect: rect(51, 9, 8, 11) },
      { id: 'isleThree', rect: rect(60, 31, 12, 7) },
      { id: 'farRiver', rect: rect(77, 7, 6, 8) },
    ],
    signs: [p.sign('gauntlet', 'relay', 7, 40), p.sign('gauntlet', 'rest', 34, 30), p.sign('gauntlet', 'last', 69, 33), p.sign('gauntlet', 'river', 76, 12)],
    decor: [
      ...torchesAt(rows, [16, 39], [16, 41], [30, 29], [30, 31], [36, 24], [37, 24], [45, 13], [45, 15], [58, 13], [58, 15], [66, 26], [67, 26], [71, 31], [71, 33], [76, 20], [77, 20], [4, 40]),
      ...p.decor('crystal', [4, 35], [15, 46], [31, 25], [42, 35], [46, 9], [57, 19], [59, 27], [70, 37], [73, 7], [82, 19]).decor('statue', [16, 35], [16, 46], [44, 25], [71, 27])
        .decor('bones', [8, 43], [38, 30], [52, 14], [64, 32]).decors,
    ],
    exit: { rect: rect(77, 8, 5, 5), requires: ['clear'] },
    dark: true,
  };
})();

// ───────────────────────────── Salle 9 : Le Trône du Néant ─────────────────────────────
//
// 64×48. BOSS FINAL : le seigneur du Néant (`voidlord`, 4 phases, volant — le plus dur du jeu), seul ou presque (il invoque ses propres
// sbires). Arène sans aucun abîme, piliers 2×2 de couverture qui arrêtent les projectiles, sortie finale SCELLÉE dans une alcôve au
// nord : elle exige le seigneur vaincu (`clear`) et les quatre objectifs personnels. Le héros arrive à l'ouest, le seigneur à l'est.
// Résolution : se couvrir derrière les piliers, éviter anneaux et zones de danger, vaincre le seigneur (4 phases) ; la sortie [28..35, 1..2]
// s'ouvre ; tous s'y rejoignent : la fin de l'histoire.

const throne: RoomDef = (() => {
  const b = new LayoutBuilder(64, 48).floor(2, 4, 60, 40).floor(28, 1, 8, 3);
  [
    [11, 9],
    [11, 36],
    [21, 17],
    [21, 28],
    [31, 12],
    [31, 33],
    [41, 17],
    [41, 28],
    [51, 9],
    [51, 36],
  ].forEach(([x, y]) => b.pillarBlock(x, y));
  b.pillar([17, 7], [17, 40], [45, 7], [45, 40], [36, 22], [36, 24]);
  const rows = b.rows();
  const p = new Placer(rows, [4, 24], [], 0);
  return {
    id: 'throne',
    ...roomKeys('throne'),
    theme: 'void',
    layout: rows,
    playerSpawns: spawns(3, 23),
    enemies: [{ kind: 'voidlord', tile: [54, 24] }],
    mechanisms: [],
    signs: [p.sign('throne', 'warning', 7, 20), p.sign('throne', 'cover', 12, 26)],
    decor: [
      ...wallDecor(rows, 'torch', rect(2, 4, 60, 40), 8),
      ...wallDecor(rows, 'torch', rect(2, 43, 60, 1), 8, 'south'),
      ...wallDecor(rows, 'banner', rect(2, 4, 60, 40), 12, 'north', 5),
      ...p.decor('statue', [3, 5], [60, 5], [3, 42], [60, 42]).decor('crystal', [28, 1], [35, 1], [31, 3], [32, 3], [3, 24], [61, 24])
        .decor('bones', [16, 24], [38, 14], [46, 30]).decors,
    ],
    exit: {
      rect: rect(28, 1, 8, 2),
      requires: ['clear', 'obj:seal', 'obj:beacon', 'obj:hunt', 'obj:ember'],
      final: true,
      sealed: true,
    },
  };
})();

// ───────────────────────────── Dialogues et objectifs ─────────────────────────────

const intro: DialogueLine[] = [
  { speaker: 'narrator', textKey: 'level.level6.intro.1' },
  { speaker: 'lyssa', textKey: 'level.level6.intro.2' },
  { speaker: 'aldric', textKey: 'level.level6.intro.3' },
  { speaker: 'voidlord', textKey: 'level.level6.intro.4' },
  { speaker: 'heroes', textKey: 'level.level6.intro.5' },
];

const outro: DialogueLine[] = [
  { speaker: 'narrator', textKey: 'level.level6.outro.1' },
  { speaker: 'lyssa', textKey: 'level.level6.outro.2' },
  { speaker: 'aldric', textKey: 'level.level6.outro.3' },
  { speaker: 'heroes', textKey: 'level.level6.outro.4' },
];

const objectives: ObjectiveDef[] = [
  { id: 'seal', slot: 0, roomId: 'keys', kind: 'mechanism', mechanismId: 'doorBlue', labelKey: 'objective.level6.seal' },
  { id: 'beacon', slot: 1, roomId: 'terrace', kind: 'zone', zoneId: 'beaconZone', seconds: 8, labelKey: 'objective.level6.beacon' },
  { id: 'hunt', slot: 2, roomId: 'hearth', kind: 'kills', count: 4, labelKey: 'objective.level6.hunt' },
  { id: 'ember', slot: 3, roomId: 'embers', kind: 'mechanism', mechanismId: 'emberBrazierYellow', labelKey: 'objective.level6.ember' },
];

/**
 * Niveau 6 — Les Abysses du Néant. Données pures (aucune logique) : voir l'en-tête du fichier pour la structure, le rythme, la coop
 * adaptative et les objectifs.
 */
export const level6: LevelDef = {
  id: 'level6',
  nameKey: 'level.level6.name',
  theme: 'void',
  estimatedMinutes: 10,
  intro,
  outro,
  rooms: [quay, islets, terrace, wraithhall, keys, embers, hearth, gauntlet, throne],
  objectives,
};
