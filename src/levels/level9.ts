/**
 * Niveau 9 — « Le Clocher de l'Aube » (thème `brass`, 8 salles, ≈ 9 minutes simulées par les bots). DERNIER niveau du jeu : son outro est la conclusion.
 *
 * Signature coopérative : LA CADENCE. Les leviers à fenêtre (`windowMs`) retombent seuls : la porte d'une salle exige que tous soient
 * ACTIFS AU MÊME INSTANT, puis elle reste ouverte. Les fenêtres sont échelonnées selon la distance à la porte (le levier le plus
 * lointain tient le plus longtemps) : le relais se joue de l'extrémité de la galerie vers la porte. Rien n'est jamais perdu : un levier
 * retombé se retire, un relais raté se rejoue à l'infini. La fenêtre effective est élargie à chaque nombre de joueurs
 * (`windowMs × ceil(nbLeviersNonWaived / n)`) : un SEUL joueur tire ses trois leviers de base en courant.
 * Seconde signature : des VAGUES DÉCLENCHÉES PAR UN MÉCANISME (`when: '<plaque>'`) : chaque bloc 2×2 posé sur sa plaque fait surgir une
 * vague (salle des contrepoids) ; un puzzle de runes à vision partagée suivi d'une zone à tenir (verger des échos).
 *
 * Rythme :
 *  1. `forecourt`     Le Parvis des Cloches        levier à fenêtre loin de la porte + plaque devant la porte (tirer puis courir, ou à deux)
 *  2. `gallery`       La Galerie des Battants      LA CADENCE : 6 leviers (2 de base + 4 de couleur) à fenêtres échelonnées, archers aux flancs
 *  3. `bellguard`     Le Sonneur de Garde          DEMI-BOSS n°1 (pyromancien `pyromancer`), salle pure
 *  4. `counterweight` La Salle des Contrepoids     3 blocs 2×2 à pousser sur 3 plaques ; chaque plaque couverte déclenche une vague
 *  5. `echoorchard`   Le Verger des Échos          runes visibles d'UN seul héros (rouge) + tenir la mesure 15 s dans une zone (embuscade)
 *  6. `nave`          La Nef aux Fosses            bandes d'abîme, ennemis terrestres, 4 plaques de couleur ; objectif de chasse
 *  7. `ropehall`      La Salle des Cordes          DEMI-BOSS n°2 (spectre `wraith`, volant) et sbires volants, salle pure
 *  8. `belfry`        Le Clocher                   BOSS FINAL : le seigneur du Néant (`voidlord`, 4 phases), salle pure, sortie scellée
 *
 * Aucune tactique de boss dans ce niveau (`EnemySpawnDef.tactics` absent) ; aucune salle sombre, aucun brasero. Les arènes de demi-boss
 * et de boss n'ont ni mécanisme ni abîme (les boss se téléportent partout dans la salle) ; la nef est la seule salle à abîme : ses
 * ennemis sont tous TERRESTRES.
 *
 * Coop adaptative (1 à 4 joueurs) : plaques / leviers de couleur à `minPlayers = slot + 1` ; ennemis : leur nombre ne dépend QUE du nombre
 * de joueurs (`minPlayers`, ≈ 55 % des ennemis dès 1 joueur dans les salles ordinaires ; paliers explicites dans les arènes), jamais de la
 * difficulté. Aucun ennemi à moins de 12 tuiles de l'arrivée des joueurs. Total (boss et sbires compris) : 170 / 193 / 248 / 310 ennemis à
 * 1 / 2 / 3 / 4 joueurs (planchers du cahier des charges : 170 et 295 ; ratio n1/n4 ≈ 0,55). Les paliers médians (2 et 3 joueurs) sont
 * volontairement resserrés : les parties à deux, faute de bras, sont les plus lentes (fenêtre de durée 5-10 min). Le seigneur du Néant (boss
 * final) est SEUL à 1 joueur (0 / 4 / 14 / 26 sbires) : sans butin ni cristal, un héros seul arrive déjà affaibli au dernier combat.
 *
 * Objectifs personnels (un par slot, types variés, répartis sur quatre salles) :
 *  - slot 0 (bleu)   `bell`    : mécanisme — ouvrir la porte du parvis (levier puis plaque) ;
 *  - slot 1 (rouge)  `measure` : zone — tenir la mesure 15 s dans le verger des échos ;
 *  - slot 2 (vert)   `sweep`   : kills — 6 coups fatals dans la nef ;
 *  - slot 3 (jaune)  `weights` : mécanisme — faire retomber les trois contrepoids (porte de la salle des contrepoids).
 *
 * Toutes les chaînes affichées sont des clés i18n (parts `src/i18n/parts/level9.{fr,en}.json`).
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
const THEME: ZoneTheme = 'brass';

// ───────────────────────────── Aides de construction ─────────────────────────────

/** Raccourci pour un rectangle de tuiles. */
function rect(x: number, y: number, w: number, h: number): TileRect {
  return { x, y, w, h };
}

/**
 * Constructeur de grille : on part d'un plein de murs et on creuse des plates-formes, des abîmes et des couloirs. Déterministe.
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
 * Cycle de paliers `minPlayers` : 60 % des ennemis dès 1 joueur, 70 % à 2, 85 % à 3, 100 % à 4 (paliers médians resserrés : les parties à 2 sont les plus lentes).
 * Le nombre d'ennemis suit les JOUEURS, jamais la difficulté.
 */
const TIERS = [1, 1, 4, 3, 2, 1, 1, 1, 1, 2, 1, 1, 4, 3, 4, 4, 1, 1, 1, 1] as const;

/** Rectangle (2r+1)² autour d'une tuile : interdit aux ennemis et aux décors (mécanismes, cristaux…). */
function around(t: TileXY, r = 2): TileRect {
  return rect(t[0] - r, t[1] - r, 2 * r + 1, 2 * r + 1);
}

/** Pose ennemis, décors et panneaux sur des tuiles de sol libres (aimantés vers la tuile libre la plus proche). */
class Placer {
  readonly enemies: EnemySpawnDef[] = [];
  readonly decors: DecorDef[] = [];
  private readonly used = new Set<number>();
  /** Ennemis présents dès 1 joueur (jamais de `minPlayers`, hors cycle `TIERS`). */
  private readonly always = new Set<EnemySpawnDef>();

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
    throw new Error(`level9 : aucune tuile libre près de [${x},${y}]`);
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
    if (cands.length < count) throw new Error(`level9 : zone [${area.x},${area.y},${area.w},${area.h}] : ${cands.length} tuiles libres pour ${count} ennemis`);
    for (let i = 0; i < count; i++) {
      const t = cands[Math.floor(((i + 0.5) * cands.length) / count)];
      this.used.add(t[1] * 1000 + t[0]);
      this.enemies.push({ kind: kinds[i % kinds.length], tile: t, ...extra });
    }
    return this;
  }

  /** Comme `fill`, mais ces ennemis sont présents dès 1 joueur (socle du plancher d'ennemis à 1 joueur, hors cycle `TIERS`). */
  base(area: TileRect, kinds: readonly EnemyKind[], count: number): this {
    const before = this.enemies.length;
    this.fill(area, kinds, count);
    for (const e of this.enemies.slice(before)) this.always.add(e);
    return this;
  }

  /**
   * Sbires d'une arène de demi-boss / de boss avec des paliers EXPLICITES : `tiers[k]` sbires présents dès k+1 joueurs en plus de
   * ceux des paliers précédents (ex. [13, 3, 3, 2] : 13 à 1 joueur, 16 à 2, 19 à 3, 21 à 4). Les paliers sont posés d'un seul réseau
   * de tuiles pour rester répartis dans l'arène.
   */
  squad(area: TileRect, kinds: readonly EnemyKind[], tiers: readonly [number, number, number, number]): this {
    this.fill(area, kinds, tiers[0] + tiers[1] + tiers[2] + tiers[3]);
    const first = this.enemies.length - (tiers[0] + tiers[1] + tiers[2] + tiers[3]);
    // les paliers sont répartis dans l'ordre inverse du réseau pour qu'aucune moitié d'arène ne se vide en premier
    const order = this.enemies.slice(first).map((_, i) => i);
    const marks: number[] = [];
    for (let t = 0; t < 4; t++) for (let i = 0; i < tiers[t]; i++) marks.push(t + 1);
    // entrelacement déterministe : l'ennemi i du réseau reçoit le palier marks[(i * 7) % total]
    const total = marks.length;
    const used = new Set<number>();
    order.forEach((i) => {
      let k = (i * 7) % total;
      while (used.has(k)) k = (k + 1) % total;
      used.add(k);
      const tier = marks[k];
      const e = this.enemies[first + i];
      if (tier > 1) e.minPlayers = tier;
    });
    return this;
  }

  /** Décors du même type près des tuiles demandées. */
  decor(type: DecorDef['type'], ...tiles: TileXY[]): this {
    for (const [x, y] of tiles) this.decors.push({ type, tile: this.snap(x, y, false) });
    return this;
  }

  /** Panneau de salle (`sign.level9.<roomId>.<name>`). */
  sign(room: string, name: string, x: number, y: number): SignDef {
    return { id: `${room}.${name}`, tile: this.snap(x, y, false), textKey: `sign.level9.${room}.${name}` };
  }

  /** Ennemis finaux : les paliers `minPlayers` non précisés suivent le cycle `TIERS` (boss et demi-boss exclus). */
  tiered(): EnemySpawnDef[] {
    let i = 0;
    return this.enemies.map((e) => {
      if (e.minPlayers !== undefined || isAnyBossKind(e.kind) || this.always.has(e)) return e;
      const tier = TIERS[i++ % TIERS.length];
      return tier === 1 ? e : { ...e, minPlayers: tier };
    });
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

/** Clé d'étiquette de mécanisme : `mech.level9.<roomId>.<mechanismId>`. */
function mechLabel(room: string, mechanismId: string): string {
  return `mech.level9.${room}.${mechanismId}`;
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

/** Nom, indice d'arrivée : clés `room.level9.<id>.name` et `hintroom.level9.<id>`. */
function roomKeys(id: string): { nameKey: string; introHintKey: string } {
  return { nameKey: `room.level9.${id}.name`, introHintKey: `hintroom.level9.${id}` };
}

/** Piliers 2×2 de couverture d'une arène (liste de coins haut-gauche). */
function pillarBlocks(b: LayoutBuilder, blocks: readonly TileXY[]): void {
  for (const [x, y] of blocks) b.pillarBlock(x, y);
}

/**
 * Types d'ennemis de la nef (salle à abîme) : uniquement des créatures TERRESTRES (pas de chauves-souris ni de feux follets, qui pourraient
 * rester suspendus au-dessus du vide, hors de portée, et empêcher le « clear »).
 */
const GROUND: readonly EnemyKind[] = ['slime', 'skeleton', 'spider', 'slime', 'skeleton', 'slime'];
const GROUND_TOUGH: readonly EnemyKind[] = ['skeleton', 'spider', 'slime', 'skeleton', 'spider', 'slime', 'skeleton'];

// ───────────────────────────── Salle 1 : Le Parvis des Cloches ─────────────────────────────
//
// 62×42. Idée : APPRENDRE la fenêtre. Un levier à fenêtre (19 s) tout au fond du parvis, au nord-ouest ; la porte, à l'est, exige ce
// levier ACTIF ET la plaque posée devant elle. Un seul héros tire le levier puis court à la plaque (≈ 11 s de course pour un héros de
// vitesse moyenne, ≈ 14 s pour le plus lent, Grok : d'où 19 s, marge ≥ 30 % sur le trajet réel) ; à plusieurs, un second tient la plaque pendant qu'un autre tire. La porte reste ensuite ouverte.
// Résolution : vaincre les rôdeurs du parvis ; tirer le levier [8,6] ; poser un héros sur la plaque [50,20] pendant que le levier est
// actif ; la porte [52..53, 20..21] s'ouvre ; sortie [55..58, 17..24]. Objectif du héros bleu : cette porte.

const forecourt: RoomDef = (() => {
  const spawn: TileXY = [4, 20];
  const lever: TileXY = [8, 6];
  const plate: TileXY = [50, 20];
  const b = new LayoutBuilder(62, 42).floor(2, 3, 50, 36).floor(52, 20, 2, 2).floor(54, 14, 6, 14);
  b.reserve(rect(2, 16, 8, 9), around(lever, 3), rect(44, 16, 10, 9), rect(54, 14, 6, 14)).pillarGrid(rect(4, 4, 46, 34), 7, 6, 3, 2);
  const rows = b.rows();
  const p = new Placer(rows, spawn, [around(lever, 3), around(plate, 3), rect(44, 16, 10, 9), rect(54, 14, 6, 14)])
    .fill(rect(22, 8, 24, 26), ['slime', 'skeleton', 'bat', 'slime', 'skeleton'], 30)
    .base(rect(20, 6, 28, 30), ['slime'], 4);
  return {
    id: 'forecourt',
    ...roomKeys('forecourt'),
    theme: THEME,
    layout: rows,
    playerSpawns: spawns(...spawn),
    enemies: p.tiered(),
    mechanisms: [
      { id: 'forecourtLever', type: 'lever', tile: lever, windowMs: 19000, labelKey: mechLabel('forecourt', 'forecourtLever') },
      { id: 'forecourtPlate', type: 'plate', tile: plate, labelKey: mechLabel('forecourt', 'forecourtPlate') },
      {
        id: 'forecourtDoor',
        type: 'door',
        tiles: doorTiles(52, 20),
        requires: ['forecourtLever', 'forecourtPlate'],
        labelKey: mechLabel('forecourt', 'forecourtDoor'),
      },
    ],
    signs: [p.sign('forecourt', 'lever', 13, 9), p.sign('forecourt', 'plate', 46, 14), p.sign('forecourt', 'bells', 8, 24)],
    decor: [
      ...wallDecor(rows, 'torch', rect(2, 3, 50, 36), 8),
      ...wallDecor(rows, 'banner', rect(2, 3, 50, 36), 12, 'north', 6),
      ...wallDecor(rows, 'torch', rect(2, 3, 50, 36), 10, 'south', 5),
      ...p.decor('crystal', [3, 4], [50, 4], [3, 37], [50, 37]).decor('statue', [44, 14], [44, 27], [3, 14], [3, 27])
        .decor('crate', [20, 5], [20, 36]).decor('bones', [28, 20], [38, 10]).decors,
    ],
    exit: { rect: rect(55, 17, 4, 8), requires: ['forecourtDoor', 'clear'] },
  };
})();

// ───────────────────────────── Salle 2 : La Galerie des Battants ─────────────────────────────
//
// 80×42. Idée : LA CADENCE. Une longue galerie (x2..69) dont la porte est tout à l'est [70..71, 20..21]. SIX leviers à fenêtre sont
// répartis du bout ouest vers la porte, une fenêtre par levier, décroissantes avec la proximité de la porte :
//   A [8,12] 7,5 s · Rouge [19,30] 7 s · Bleu [30,12] 6,5 s · Vert [41,30] 6 s · B [52,12] 5,5 s · Jaune [62,30] 5 s   (valeurs brutes)
// A et B n'ont ni propriétaire ni `minPlayers` ; Bleu est le levier de base de couleur (slot 0), Rouge / Vert / Jaune n'existent qu'à
// 2 / 3 / 4 joueurs. Fenêtre effective = brute × ceil(nbLeviersNonWaived / n) : ×3 en solo (A, Bleu, B : 22,5 / 19,5 / 16,5 s pour
// ≈ 11 s de course), ×2 à 2-4 joueurs. La porte exige les six ACTIFS ENSEMBLE ; elle reste ouverte ensuite. L'ordre n'est PAS imposé : les fenêtres (plus longues pour les leviers
// lointains, donc « commencer par l'ouest » est un avantage de timing) dépassent la durée du relais ; un levier qui retombe avant le dernier tirage fait seulement échouer le relais. Archers et squelettes
// tiennent les flancs nord (y4..10) et sud (y31..37) : on nettoie AVANT de lancer le relais.
// Résolution : tout vaincre ; chacun va à son levier ; en partant du plus lointain (ouest), tirer chacun le sien dans la fenêtre ; la
// porte s'ouvre ; sortie [73..76, 17..24] (le nettoyage `clear` est exigé aussi).

const gallery: RoomDef = (() => {
  const spawn: TileXY = [4, 20];
  const levers: { id: string; tile: TileXY; windowMs: number; slot?: number }[] = [
    { id: 'galleryLeverA', tile: [8, 12], windowMs: 7500 },
    { id: 'galleryLeverRed', tile: [19, 30], windowMs: 7000, slot: 1 },
    { id: 'galleryLeverBlue', tile: [30, 12], windowMs: 6500, slot: 0 },
    { id: 'galleryLeverGreen', tile: [41, 30], windowMs: 6000, slot: 2 },
    { id: 'galleryLeverB', tile: [52, 12], windowMs: 5500 },
    { id: 'galleryLeverYellow', tile: [62, 30], windowMs: 5000, slot: 3 },
  ];
  const b = new LayoutBuilder(80, 42).floor(2, 4, 68, 34).floor(70, 20, 2, 2).floor(72, 14, 6, 14);
  b.reserve(rect(2, 16, 8, 9), rect(64, 16, 8, 9), rect(72, 14, 6, 14), ...levers.map((l) => around(l.tile, 2))).pillarGrid(rect(4, 6, 64, 30), 8, 6, 3, 2);
  const rows = b.rows();
  const leverAvoid = levers.map((l) => around(l.tile, 3));
  const p = new Placer(rows, spawn, [...leverAvoid, rect(62, 16, 10, 9), rect(72, 14, 6, 14)])
    .fill(rect(14, 4, 46, 7), ['archer', 'skeleton', 'skeleton'], 14)
    .fill(rect(14, 31, 46, 7), ['skeleton', 'archer', 'skeleton'], 14)
    .fill(rect(14, 11, 46, 20), ['skeleton', 'skeleton', 'archer'], 14)
    .base(rect(14, 11, 46, 20), ['skeleton'], 2);
  const mechanisms: MechanismDef[] = levers.map((l) => {
    const base = { id: l.id, type: 'lever' as const, tile: l.tile, windowMs: l.windowMs, labelKey: mechLabel('gallery', l.id) };
    if (l.slot === undefined) return base;
    const owned = { ...base, ownerSlot: l.slot };
    return l.slot === 0 ? owned : { ...owned, minPlayers: l.slot + 1 };
  });
  mechanisms.push({
    id: 'galleryDoor',
    type: 'door',
    tiles: doorTiles(70, 20),
    requires: levers.map((l) => l.id),
    labelKey: mechLabel('gallery', 'galleryDoor'),
  });
  return {
    id: 'gallery',
    ...roomKeys('gallery'),
    theme: THEME,
    layout: rows,
    playerSpawns: spawns(...spawn),
    enemies: p.tiered(),
    mechanisms,
    signs: [p.sign('gallery', 'cadence', 9, 17), p.sign('gallery', 'order', 24, 22), p.sign('gallery', 'colors', 45, 22), p.sign('gallery', 'door', 66, 18)],
    decor: [
      ...wallDecor(rows, 'torch', rect(2, 4, 68, 34), 8),
      ...wallDecor(rows, 'banner', rect(2, 4, 68, 34), 12, 'north', 6),
      ...wallDecor(rows, 'torch', rect(2, 4, 68, 34), 10, 'south', 5),
      ...p.decor('crystal', [3, 5], [68, 5], [3, 36], [68, 36]).decor('statue', [66, 17], [66, 24], [40, 20])
        .decor('bones', [24, 20], [56, 22], [14, 26]).decor('crate', [14, 5], [48, 36]).decors,
    ],
    exit: { rect: rect(73, 17, 4, 8), requires: ['galleryDoor', 'clear'] },
  };
})();

// ───────────────────────────── Salle 3 : Le Sonneur de Garde (demi-boss n°1) ─────────────────────────────
//
// 66×44. Idée : le DEMI-BOSS n°1, le pyromancien (`pyromancer`, garde ses distances, boules de feu, nova), seul avec ses sbires dans une
// arène pure (aucun mécanisme, aucun abîme : il se téléporte partout). Sbires à paliers explicites : 13 / 16 / 19 / 21 à 1 / 2 / 3 / 4
// joueurs. Trois cristaux de soin. Sortie : le pyromancien et ses sbires vaincus (`clear`).
// Résolution : se couvrir derrière les piliers, frapper le pyromancien quand il s'approche ; sortie [59..62, 18..25].

const bellguard: RoomDef = (() => {
  const spawn: TileXY = [4, 22];
  const crystals: TileXY[] = [
    [22, 8],
    [22, 35],
    [26, 21],
  ];
  const b = new LayoutBuilder(66, 44).floor(2, 3, 62, 38);
  pillarBlocks(b, [
    [12, 9],
    [12, 33],
    [18, 20],
    [31, 11],
    [31, 31],
    [38, 20],
    [44, 14],
    [44, 28],
    [53, 9],
    [53, 33],
  ]);
  b.pillar([24, 15], [24, 28], [48, 21], [48, 22]);
  const rows = b.rows();
  const p = new Placer(rows, spawn, [...crystals.map((t) => around(t, 1)), rect(56, 16, 8, 12), rect(2, 18, 6, 8)])
    .squad(rect(20, 4, 42, 36), ['skeleton', 'spider', 'wisp', 'slime', 'archer', 'bat'], [13, 3, 3, 2]);
  return {
    id: 'bellguard',
    ...roomKeys('bellguard'),
    theme: THEME,
    layout: rows,
    playerSpawns: spawns(...spawn),
    enemies: [{ kind: 'pyromancer', tile: [52, 21] }, ...p.enemies],
    mechanisms: [],
    signs: [p.sign('bellguard', 'guard', 8, 22), p.sign('bellguard', 'cover', 14, 28), p.sign('bellguard', 'fire', 20, 14)],
    decor: [
      ...wallDecor(rows, 'torch', rect(2, 3, 62, 38), 8),
      ...wallDecor(rows, 'banner', rect(2, 3, 62, 38), 12, 'north', 6),
      ...p.decor('statue', [3, 4], [62, 4], [3, 39], [62, 39]).decor('crystal', [28, 4], [40, 39], [3, 21], [62, 21])
        .decor('bones', [16, 24], [36, 24], [46, 12]).decor('crate', [50, 38], [58, 5]).decors,
    ],
    // Cristaux de soin (sources de vie fixes, usage unique) : loin des arrivées et du départ du demi-boss ; le 3e exige 3 joueurs.
    healCrystals: [
      { id: 'bellguard_heal1', tile: crystals[0] },
      { id: 'bellguard_heal2', tile: crystals[1] },
      { id: 'bellguard_heal3', tile: crystals[2], minPlayers: 3 },
    ],
    exit: { rect: rect(59, 18, 4, 8), requires: ['clear'] },
  };
})();

// ───────────────────────────── Salle 4 : La Salle des Contrepoids ─────────────────────────────
//
// 54×46, sans abîme. Idée : des VAGUES DÉCLENCHÉES PAR UN MÉCANISME. Dans le mur est de la grande salle (x2..33), TROIS couloirs de 2 tuiles
// de large (y8-9, y14-15, y34-35 ; x34..41) abritent chacun un bloc 2×2 au départ [34,y] et une plaque tout au fond [41,y] ; les
// couloirs sont fermés sur les côtés et au fond : un bloc ne peut avancer que vers l'est (donc aucun blocage définitif). Chaque bloc
// avance d'une tuile par poussée soutenue (6 tuiles ≈ 7 s ; 2 pousseurs, 1 seul si l'équipe est seule : `playersRequired` plafonné à n).
// Quand le bloc couvre sa plaque, une VAGUE surgit dans la grande salle (`when: '<plaque>'`) : les pousseurs ne sont jamais seuls,
// l'équipe se bat entre deux poussées. La porte du corridor [35..36, 22..23] exige les trois plaques ; derrière, la chambre de sortie
// [38..51, 18..27]. Quelques rôdeurs patrouillent d'emblée. Aucune zone d'embuscade : seules les plaques déclenchent.
// Résolution : vaincre les rôdeurs ; pousser le bloc A à l'est (6 tuiles), vaincre la vague A ; idem B, C ; la porte s'ouvre ;
// sortie [46..49, 20..25]. Objectif du héros jaune : cette porte.

const counterweight: RoomDef = (() => {
  const spawn: TileXY = [4, 22];
  const laneY = [8, 14, 34];
  const X0 = 34; // début des couloirs (mur est de la grande salle)
  const LANE_LEN = 8; // x34..41 : le bloc (coin [34,y]) avance de 6 tuiles jusqu'à la plaque [41,y]
  const names = ['A', 'B', 'C'];
  const b = new LayoutBuilder(54, 46).floor(2, 3, 32, 40).floor(X0, 22, 4, 2).floor(X0 + 4, 18, 14, 10);
  for (const y of laneY) b.floor(X0, y, LANE_LEN, 2);
  b.reserve(rect(2, 18, 8, 9), rect(26, 18, 10, 9), ...laneY.map((y) => rect(24, y - 2, 11, 6))).pillarGrid(rect(4, 4, 28, 38), 7, 6, 3, 2);
  const rows = b.rows();
  const waveId = (i: number): string => `counterweightPlate${names[i]}`;
  const lanes = rect(X0, 6, LANE_LEN, 32);
  const p = new Placer(rows, spawn, [lanes, rect(26, 18, 10, 9), rect(X0 + 4, 18, 14, 10)])
    // rôdeurs d'emblée
    .fill(rect(16, 3, 17, 40), ['slime', 'skeleton', 'spider', 'skeleton'], 6)
    // vagues : l'une par plaque
    .fill(rect(16, 3, 17, 40), ['slime', 'skeleton', 'spider', 'slime', 'skeleton'], 16, { when: waveId(0) })
    .fill(rect(16, 3, 17, 40), ['skeleton', 'spider', 'slime', 'skeleton', 'slime'], 16, { when: waveId(1) })
    .fill(rect(16, 3, 17, 40), ['spider', 'knight', 'skeleton', 'wisp', 'slime', 'skeleton'], 16, { when: waveId(2) });
  const mechanisms: MechanismDef[] = [];
  laneY.forEach((y, i) => {
    mechanisms.push({ id: `counterweightBlock${names[i]}`, type: 'block', tile: [X0, y], labelKey: mechLabel('counterweight', `counterweightBlock${names[i]}`) });
    mechanisms.push({ id: waveId(i), type: 'plate', tile: [X0 + LANE_LEN - 1, y], labelKey: mechLabel('counterweight', waveId(i)) });
  });
  mechanisms.push({
    id: 'counterweightDoor',
    type: 'door',
    tiles: doorTiles(X0 + 1, 22),
    requires: laneY.map((_, i) => waveId(i)),
    labelKey: mechLabel('counterweight', 'counterweightDoor'),
  });
  return {
    id: 'counterweight',
    ...roomKeys('counterweight'),
    theme: THEME,
    layout: rows,
    playerSpawns: spawns(...spawn),
    enemies: p.tiered(),
    mechanisms,
    signs: [p.sign('counterweight', 'blocks', 8, 20), p.sign('counterweight', 'waves', 26, 20), p.sign('counterweight', 'door', 30, 25)],
    decor: [
      ...wallDecor(rows, 'torch', rect(2, 3, 32, 40), 8),
      ...wallDecor(rows, 'banner', rect(2, 3, 32, 40), 12, 'north', 6),
      ...wallDecor(rows, 'torch', rect(2, 3, 32, 40), 10, 'south', 5),
      ...p.decor('crystal', [3, 4], [3, 41], [32, 4], [32, 41]).decor('statue', [27, 20], [27, 25], [3, 12], [3, 33])
        .decor('bones', [14, 12], [20, 30], [24, 22]).decor('crate', [10, 4], [10, 41]).decors,
    ],
    exit: { rect: rect(X0 + 12, 20, 4, 6), requires: ['counterweightDoor', 'clear'] },
  };
})();

// ───────────────────────────── Salle 5 : Le Verger des Échos ─────────────────────────────
//
// 62×48. Idée : VISION PARTAGÉE + zone à tenir. La séquence de 4 runes [vague, soleil, lune, œil] n'est affichée que sur l'écran du
// héros ROUGE (slot 1), dans la niche nord-ouest [8,6] ; six piédestaux sont dispersés aux confins du verger, trop loin de la niche pour
// qu'on les voie ensemble : le héros rouge LIT puis DÉCRIT, les autres frappent les piédestaux dans l'ordre (une erreur remet à zéro). Seul,
// on lit, on retient, on court. Au centre du verger, la zone « mesure » : le héros rouge doit s'y tenir 15 s cumulées ; en y entrant,
// l'embuscade surgit tout autour (à plus de 6 tuiles de la zone) : il faut la tenir pendant que l'équipe la défend. La porte [46..47, 22..23]
// exige les runes ET la mesure tenue ; derrière, la chambre de sortie [48..59, 17..28]. Un SEUL héros doit tenir la zone (le héros rouge) :
// à plusieurs, il la tient pendant que les autres jouent les runes (l'embuscade le vise seul un moment) ; seul, on enchaîne.
// Résolution : vaincre les gardiens ; lire la séquence ; frapper les piédestaux [24,7] vague, [38,7] soleil, [43,14] lune, [38,41] œil
// (les piédestaux [43,33] étoile et [24,41] flamme sont des leurres) ; le héros rouge tient la zone [18..27, 19..28] 15 s pendant
// l'embuscade ; vaincre ; sortie [53..57, 19..26].

const echoorchard: RoomDef = (() => {
  const spawn: TileXY = [4, 24];
  const display: TileXY = [8, 6];
  const zone = rect(18, 19, 10, 10);
  const pedestals = [
    { symbol: 'sun' as const, tile: [38, 7] as TileXY },
    { symbol: 'moon' as const, tile: [43, 14] as TileXY },
    { symbol: 'star' as const, tile: [43, 33] as TileXY },
    { symbol: 'eye' as const, tile: [38, 41] as TileXY },
    { symbol: 'flame' as const, tile: [24, 41] as TileXY },
    { symbol: 'wave' as const, tile: [24, 7] as TileXY },
  ];
  const b = new LayoutBuilder(62, 48).floor(2, 4, 44, 40).floor(46, 22, 2, 2).floor(48, 17, 12, 12);
  b.reserve(rect(2, 20, 8, 9), around(display, 3), zone, rect(40, 17, 8, 14), rect(48, 17, 12, 12), ...pedestals.map((x) => around(x.tile, 2))).pillarGrid(rect(4, 5, 40, 38), 7, 6, 3, 2);
  const rows = b.rows();
  const keep = [around(display, 3), rect(40, 17, 8, 14), rect(48, 17, 12, 12), ...pedestals.map((x) => around(x.tile, 2))];
  // zone élargie de 6 tuiles : aucun ennemi d'embuscade n'y surgit (jamais à moins de 6 tuiles de la zone)
  const ring = rect(zone.x - 6, zone.y - 6, zone.w + 12, zone.h + 12);
  const p = new Placer(rows, spawn, [...keep, rect(zone.x - 3, zone.y - 3, zone.w + 6, zone.h + 6)])
    // gardiens du verger (présents d'emblée)
    .fill(rect(20, 9, 26, 30), ['spider', 'archer', 'skeleton', 'wisp', 'slime', 'bat', 'skeleton'], 22)
    // embuscade : tout autour de la zone, jamais à moins de 6 tuiles
    .forbid(ring)
    .fill(rect(10, 5, 36, 38), ['skeleton', 'spider', 'archer', 'bat', 'skeleton', 'wisp'], 22, { when: 'enter:measureZone' });
  return {
    id: 'echoorchard',
    ...roomKeys('echoorchard'),
    theme: THEME,
    layout: rows,
    playerSpawns: spawns(...spawn),
    enemies: p.tiered(),
    mechanisms: [
      {
        id: 'orchardRunes',
        type: 'runePuzzle',
        displayTile: display,
        visibleToSlot: 1,
        sequence: ['wave', 'sun', 'moon', 'eye'],
        pedestals,
        labelKey: mechLabel('echoorchard', 'orchardRunes'),
      },
      {
        id: 'orchardDoor',
        type: 'door',
        tiles: doorTiles(46, 22),
        requires: ['orchardRunes', 'obj:measure'],
        labelKey: mechLabel('echoorchard', 'orchardDoor'),
      },
    ],
    zones: [{ id: 'measureZone', rect: zone }],
    signs: [p.sign('echoorchard', 'seer', 11, 9), p.sign('echoorchard', 'pedestals', 34, 12), p.sign('echoorchard', 'measure', 15, 24), p.sign('echoorchard', 'door', 41, 26)],
    decor: [
      ...wallDecor(rows, 'torch', rect(2, 4, 44, 40), 8),
      ...wallDecor(rows, 'banner', rect(2, 4, 44, 40), 12, 'north', 6),
      ...wallDecor(rows, 'torch', rect(2, 4, 44, 40), 10, 'south', 5),
      ...p.decor('crystal', [3, 5], [44, 5], [3, 42], [44, 42]).decor('statue', [17, 18], [28, 18], [17, 29], [28, 29])
        .decor('plant', [12, 9], [12, 39], [34, 10], [34, 38]).decor('bones', [14, 26], [34, 24]).decors,
    ],
    exit: { rect: rect(53, 19, 5, 8), requires: ['orchardDoor', 'clear'] },
  };
})();

// ───────────────────────────── Salle 6 : La Nef aux Fosses ─────────────────────────────
//
// 64×50. Idée : la nef est coupée par TROIS bandes d'abîme (x18..21, x34..37, x50..53). Les deux premières se franchissent par deux passages
// de 4 tuiles (y10..13 et y36..39), la troisième par un seul passage de 2 tuiles de large [50..53, 22..23], fermé par la porte [51..52,
// 22..23]. Ennemis TERRESTRES uniquement (aucun volant ne peut rester suspendu au-dessus du vide). Quatre plaques de couleur occupent
// les coins du troisième segment [38..49] : la porte exige les quatre tenues ENSEMBLE (bleue sans condition, rouge à 2, verte à 3,
// jaune à 4) ; derrière, la chambre de sortie [54..61, 3..46]. Objectif du héros vert : 6 coups fatals dans la nef.
// Les chevaliers n'arrivent qu'à 3 et 4 joueurs (2 puis 4 de plus) : un chevalier seul vient à bout d'un héros isolé.
// Résolution : tout vaincre en franchissant les passages ; chaque héros tient SA plaque — bleue [41,8], rouge [47,8], verte [41,41],
// jaune [47,41] ; la porte s'ouvre ; sortie [56..59, 20..25].

const nave: RoomDef = (() => {
  const spawn: TileXY = [4, 24];
  const plates: Record<string, TileXY> = { Blue: [41, 8], Red: [47, 8], Green: [41, 41], Yellow: [47, 41] };
  const b = new LayoutBuilder(64, 50)
    .floor(2, 3, 60, 44)
    .pit(18, 3, 4, 44)
    .pit(34, 3, 4, 44)
    .pit(50, 3, 4, 44)
    .floor(18, 9, 4, 6)
    .floor(18, 35, 4, 6)
    .floor(34, 9, 4, 6)
    .floor(34, 35, 4, 6)
    .floor(50, 22, 4, 2);
  b.reserve(rect(2, 20, 8, 9), rect(14, 8, 12, 8), rect(14, 34, 12, 8), rect(30, 8, 12, 8), rect(30, 34, 12, 8), rect(46, 18, 8, 10), rect(54, 3, 8, 44), ...Object.values(plates).map((t) => around(t, 2)))
    .pillarGrid(rect(3, 4, 14, 42), 5, 5, 2, 2)
    .pillarGrid(rect(23, 4, 11, 42), 5, 5, 2, 2)
    .pillarGrid(rect(39, 4, 11, 42), 5, 5, 2, 2);
  const rows = b.rows();
  const platesAvoid = Object.values(plates).map((t) => around(t, 3));
  const p = new Placer(rows, spawn, [...platesAvoid, rect(46, 18, 8, 10), rect(54, 3, 8, 44), rect(14, 8, 12, 8), rect(14, 34, 12, 8), rect(30, 8, 12, 8), rect(30, 34, 12, 8)])
    .fill(rect(2, 3, 16, 44), GROUND, 6)
    .fill(rect(22, 3, 12, 44), GROUND, 22)
    .base(rect(22, 3, 12, 44), ['slime'], 4)
    .fill(rect(38, 3, 12, 44), GROUND_TOUGH, 22)
    // chevaliers : jamais en solo ni à deux (un chevalier seul vient à bout d'un héros isolé), 2 à 3 joueurs, 4 à 4 joueurs
    .foe('knight', 44, 12, { minPlayers: 3 })
    .foe('knight', 44, 38, { minPlayers: 3 })
    .foe('knight', 40, 22, { minPlayers: 4 })
    .foe('knight', 46, 30, { minPlayers: 4 });
  const mechanisms: MechanismDef[] = [];
  COLORS.forEach((color, slot) => {
    const base = {
      id: `navePlate${color}`,
      type: 'plate' as const,
      tile: plates[color],
      colorSlot: slot,
      labelKey: mechLabel('nave', `navePlate${color}`),
    };
    mechanisms.push(slot === 0 ? base : { ...base, minPlayers: slot + 1 });
  });
  mechanisms.push({
    id: 'naveDoor',
    type: 'door',
    tiles: doorTiles(51, 22),
    requires: COLORS.map((c) => `navePlate${c}`),
    labelKey: mechLabel('nave', 'naveDoor'),
  });
  return {
    id: 'nave',
    ...roomKeys('nave'),
    theme: THEME,
    layout: rows,
    playerSpawns: spawns(...spawn),
    enemies: p.tiered(),
    mechanisms,
    signs: [p.sign('nave', 'pits', 8, 22), p.sign('nave', 'sweep', 24, 24), p.sign('nave', 'plates', 43, 20), p.sign('nave', 'door', 47, 24)],
    decor: [
      ...wallDecor(rows, 'torch', rect(2, 3, 16, 44), 8),
      ...wallDecor(rows, 'torch', rect(22, 3, 12, 44), 6),
      ...wallDecor(rows, 'torch', rect(38, 3, 12, 44), 6),
      ...wallDecor(rows, 'banner', rect(54, 3, 8, 44), 3, 'north', 1),
      ...p.decor('crystal', [3, 4], [3, 45], [20, 4], [35, 45], [49, 4], [60, 4], [60, 45]).decor('statue', [23, 20], [23, 28], [48, 20], [48, 28])
        .decor('bones', [10, 14], [28, 22], [44, 28]).decor('crate', [3, 12], [3, 36], [30, 6]).decors,
    ],
    exit: { rect: rect(56, 20, 4, 6), requires: ['naveDoor', 'clear', 'obj:sweep'] },
  };
})();

// ───────────────────────────── Salle 7 : La Salle des Cordes (demi-boss n°2) ─────────────────────────────
//
// 66×46. Idée : le DEMI-BOSS n°2, un spectre (`wraith`, volant : il disparaît, réapparaît, tire des traits sombres) escorté de sbires
// VOLANTS (chauves-souris, feux follets) ; arène pure sans abîme, piliers de couverture. Sbires à paliers explicites : 12 / 16 / 21 / 26 à
// 1 / 2 / 3 / 4 joueurs. Trois cristaux de soin. Sortie : tout vaincre (`clear`).
// Résolution : s'abriter derrière les piliers, frapper le spectre à son retour, abattre les volants ; sortie [59..62, 19..26].

const ropehall: RoomDef = (() => {
  const spawn: TileXY = [4, 22];
  const crystals: TileXY[] = [
    [22, 8],
    [22, 38],
    [28, 22],
  ];
  const b = new LayoutBuilder(66, 46).floor(2, 3, 62, 40);
  pillarBlocks(b, [
    [12, 10],
    [12, 33],
    [20, 20],
    [32, 8],
    [32, 34],
    [38, 20],
    [46, 13],
    [46, 29],
    [54, 8],
    [54, 34],
  ]);
  b.pillar([26, 14], [26, 30], [50, 21], [50, 22]);
  const rows = b.rows();
  const p = new Placer(rows, spawn, [...crystals.map((t) => around(t, 1)), rect(56, 16, 8, 12), rect(2, 18, 6, 8)])
    .squad(rect(20, 4, 42, 38), ['bat', 'wisp'], [12, 4, 5, 5]);
  return {
    id: 'ropehall',
    ...roomKeys('ropehall'),
    theme: THEME,
    layout: rows,
    playerSpawns: spawns(...spawn),
    enemies: [{ kind: 'wraith', tile: [52, 21] }, ...p.enemies],
    mechanisms: [],
    signs: [p.sign('ropehall', 'wraith', 8, 22), p.sign('ropehall', 'ropes', 16, 14), p.sign('ropehall', 'cover', 14, 30)],
    decor: [
      ...wallDecor(rows, 'torch', rect(2, 3, 62, 40), 8),
      ...wallDecor(rows, 'banner', rect(2, 3, 62, 40), 8, 'north', 4),
      ...wallDecor(rows, 'banner', rect(2, 3, 62, 40), 12, 'south', 6),
      ...p.decor('statue', [3, 4], [62, 4], [3, 41], [62, 41]).decor('crystal', [28, 4], [40, 41], [3, 21], [62, 21])
        .decor('bones', [16, 24], [36, 24], [48, 16]).decor('crate', [50, 40], [58, 5]).decors,
    ],
    healCrystals: [
      { id: 'ropehall_heal1', tile: crystals[0] },
      { id: 'ropehall_heal2', tile: crystals[1] },
      { id: 'ropehall_heal3', tile: crystals[2], minPlayers: 3 },
    ],
    exit: { rect: rect(59, 19, 4, 8), requires: ['clear'] },
  };
})();

// ───────────────────────────── Salle 8 : Le Clocher ─────────────────────────────
//
// 76×50. BOSS FINAL : le seigneur du Néant (`voidlord`, 4 phases, volant — le plus dur du jeu) et ses sbires (0 / 4 / 14 / 26 à 1 / 2 / 3 / 4
// joueurs : seul, le héros n'affronte que le seigneur et ses invocations). Arène sans aucun abîme ni mécanisme, piliers 2×2 de couverture qui arrêtent les projectiles, sortie finale SCELLÉE dans
// une alcôve au nord : elle exige le seigneur vaincu (`clear`) et les quatre objectifs personnels. Les héros arrivent à l'ouest, le seigneur
// est à l'est. Pas de butin sur le boss.
// Résolution : se couvrir derrière les piliers, abattre les sbires, éviter anneaux et zones de danger, vaincre le seigneur (4 phases) ;
// la sortie [34..41, 1..2] s'ouvre ; tous s'y rejoignent : la fin de l'histoire.

const belfry: RoomDef = (() => {
  const spawn: TileXY = [4, 25];
  const crystals: TileXY[] = [
    [22, 12],
    [22, 38],
    [38, 44],
  ];
  const b = new LayoutBuilder(76, 50).floor(2, 4, 72, 42).floor(34, 1, 8, 3);
  pillarBlocks(b, [
    [12, 10],
    [12, 38],
    [22, 19],
    [22, 30],
    [34, 11],
    [34, 36],
    [44, 19],
    [44, 30],
    [54, 10],
    [54, 38],
    [64, 18],
    [64, 31],
  ]);
  b.pillar([18, 8], [18, 42], [48, 8], [48, 42], [38, 24], [38, 26]);
  const rows = b.rows();
  const p = new Placer(rows, spawn, [...crystals.map((t) => around(t, 1)), rect(32, 1, 12, 4), rect(2, 20, 6, 10)])
    .squad(rect(20, 5, 52, 40), ['slime', 'slime', 'skeleton', 'slime', 'bat'], [0, 4, 10, 12]);
  return {
    id: 'belfry',
    ...roomKeys('belfry'),
    theme: THEME,
    layout: rows,
    playerSpawns: spawns(3, 24),
    enemies: [{ kind: 'voidlord', tile: [64, 25] }, ...p.enemies],
    mechanisms: [],
    signs: [p.sign('belfry', 'warning', 8, 22), p.sign('belfry', 'cover', 14, 28)],
    decor: [
      ...wallDecor(rows, 'torch', rect(2, 4, 72, 42), 8),
      ...wallDecor(rows, 'torch', rect(2, 45, 72, 1), 8, 'south'),
      ...wallDecor(rows, 'banner', rect(2, 4, 72, 42), 12, 'north', 5),
      ...p.decor('statue', [3, 5], [72, 5], [3, 44], [72, 44]).decor('crystal', [34, 1], [41, 1], [37, 3], [38, 3], [3, 25], [72, 25])
        .decor('bones', [16, 24], [46, 14], [58, 32]).decors,
    ],
    // Cristaux de soin (sources de vie fixes, usage unique) : loin des arrivées et du départ du boss ; le 3e exige 3 joueurs.
    healCrystals: [
      { id: 'belfry_heal1', tile: crystals[0] },
      { id: 'belfry_heal2', tile: crystals[1] },
      { id: 'belfry_heal3', tile: crystals[2], minPlayers: 3 },
    ],
    exit: {
      rect: rect(34, 1, 8, 2),
      requires: ['clear', 'obj:bell', 'obj:measure', 'obj:sweep', 'obj:weights'],
      final: true,
      sealed: true,
    },
  };
})();

// ───────────────────────────── Dialogues et objectifs ─────────────────────────────

const intro: DialogueLine[] = [
  { speaker: 'narrator', textKey: 'level.level9.intro.1' },
  { speaker: 'lyssa', textKey: 'level.level9.intro.2' },
  { speaker: 'aldric', textKey: 'level.level9.intro.3' },
  { speaker: 'heroes', textKey: 'level.level9.intro.4' },
];

const outro: DialogueLine[] = [
  { speaker: 'narrator', textKey: 'level.level9.outro.1' },
  { speaker: 'lyssa', textKey: 'level.level9.outro.2' },
  { speaker: 'aldric', textKey: 'level.level9.outro.3' },
  { speaker: 'heroes', textKey: 'level.level9.outro.4' },
];

const objectives: ObjectiveDef[] = [
  { id: 'bell', slot: 0, roomId: 'forecourt', kind: 'mechanism', mechanismId: 'forecourtDoor', labelKey: 'objective.level9.bell' },
  { id: 'measure', slot: 1, roomId: 'echoorchard', kind: 'zone', zoneId: 'measureZone', seconds: 15, labelKey: 'objective.level9.measure' },
  { id: 'sweep', slot: 2, roomId: 'nave', kind: 'kills', count: 6, labelKey: 'objective.level9.sweep' },
  { id: 'weights', slot: 3, roomId: 'counterweight', kind: 'mechanism', mechanismId: 'counterweightDoor', labelKey: 'objective.level9.weights' },
];

/**
 * Niveau 9 — Le Clocher de l'Aube. Données pures (aucune logique) : voir l'en-tête du fichier pour la structure, le rythme, la coop
 * adaptative et les objectifs.
 */
export const level9: LevelDef = {
  id: 'level9',
  nameKey: 'level.level9.name',
  theme: THEME,
  estimatedMinutes: 9,
  intro,
  outro,
  rooms: [forecourt, gallery, bellguard, counterweight, echoorchard, nave, ropehall, belfry],
  objectives,
};
