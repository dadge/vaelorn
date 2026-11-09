/**
 * Niveau 3 — « La Citadelle de Morvane » (thème `citadel`, 9 salles, ≈ 10 minutes).
 *
 * Le plus long et le plus labyrinthique du jeu : il COMBINE toutes les mécaniques déjà vues (plaques simultanées,
 * clés personnelles, leviers à fenêtre, runes à vision partagée) et introduit les BLOCS 2×2 à deux joueurs, les
 * chevaliers déchus (`knight`) et les feux follets (`wisp`). Il se termine par le boss final Morvane.
 *
 * Rythme (alternance coopération collective / actions séparées simultanées / combat) :
 *  1. `gate`      La Herse d'Entrée       plaques simultanées aux quatre coins des ailes (collectif, calme)
 *  2. `seals`     La Galerie des Sceaux   clés personnelles : chacun SA clé dans SA chambre, SA porte (séparé, course)
 *  3. `forge`     La Forge des Gardiens   bloc 2×2 poussé à deux sur 30 tuiles jusqu'à un socle (collectif + défense)
 *  4. `sanctum`   Le Sanctuaire des Runes runes à vision partagée, six chambres éparses, feux follets (énigme tendue)
 *  5. `balconies` Les Balcons Jumeaux     leviers à fenêtre aux quatre coins du château (séparé, synchronisation)
 *  6. `abyss`     Le Gouffre aux Reflets  bloc posé sur une plaque + plaque tenue à la main sous les archers (collectif)
 *  7. `arena`     L'Arène des Chevaliers  tocsin + 5 vagues (combat pur, quotas d'ennemis)
 *  8. `dais`      Le Dais du Cristal      un héros tient le dais, un autre garde un sceau lointain, les autres protègent
 *  9. `throne`    Le Trône de Morvane     boss final (salle de boss pure, sortie scellée)
 *
 * ── Taille des salles (retour joueurs : « on se sent un peu perdu ») ──
 * Toutes les salles font de 54 à 86 tuiles de large et de 42 à 52 de haut : la caméra défile (≈ 26×15 tuiles à
 * 1 joueur, ≈ 20×11 à 3-4 joueurs), on ne voit JAMAIS une salle en entier. Les layouts sont générés par des
 * fonctions locales déterministes (rectangles creusés, couloirs, grilles de piliers) : grand hall + ailes + chambres
 * dans les coins + couloirs de 3-4 tuiles + culs-de-sac. Les éléments d'une même épreuve (plaques, clés, leviers,
 * piédestaux) sont ÉCARTÉS aux extrémités opposées de la salle, signalés par des panneaux ; chaque salle reste
 * résoluble (la logique de résolution est inchangée depuis la version compacte, seule la géométrie a grandi).
 *
 * Coop adaptative : tout est faisable de 1 à 4 joueurs.
 *  - plaques / leviers / clés / portes : `minPlayers` croissants par slot (le slot k n'existe « pour de vrai » qu'à k+1 joueurs) ;
 *  - blocs : `playersRequired` par défaut (2) plafonné au nombre de joueurs ;
 *  - ennemis : leur nombre ne dépend QUE du nombre de joueurs (`minPlayers`), jamais de la difficulté ; à 1 joueur
 *    il y en a ≈ 55-65 % de ceux présents à 4 joueurs. Aucun ennemi à moins de 12 tuiles du point d'arrivée.
 *
 * Objectifs personnels (un par slot, types variés, répartis sur 4 salles) :
 *  - slot 0 (bleu)   `seal`   : mécanisme — briser SA porte à clé dans la Galerie des Sceaux ;
 *  - slot 1 (rouge)  `hold`   : zone — tenir le dais 10 s ;
 *  - slot 2 (vert)   `slayer` : kills — 3 coups fatals dans l'Arène ;
 *  - slot 3 (jaune)  `lever`  : mécanisme — tirer SON levier des Balcons.
 *  Chaque salle qui porte un objectif ne peut être quittée qu'une fois celui-ci accompli (exit/porte → `obj:`),
 *  et la sortie finale exige en plus Morvane vaincu (`clear`) et les quatre objectifs.
 *
 * Conception anti-verrou des blocs : chaque bloc est posé dans un COULOIR de 2 tuiles de large fermé sur les
 * côtés et au fond ; seule l'embouchure (derrière le bloc, un hall) est ouverte. Personne ne peut donc se placer
 * devant le bloc pour le repousser, ni le pousser de côté : il ne peut qu'avancer droit jusqu'au socle (ou à la
 * plaque) situé exactement au fond du couloir.
 *
 * ── Torches et salles sombres ──
 * Trois salles sont SOMBRES (`dark: true`) : `forge` (blocs 2×2 dans la pénombre : torches murales au départ du bloc, au socle
 * et à la porte), `sanctum` (énigme d'allumage : chaque héros allume SON brasero de couleur — ownerSlot 0..3, minPlayers =
 * slot + 1 ; les quatre braseros sont exigés par la porte `nicheDoor` qui ferme la niche où la séquence de runes s'affiche ;
 * l'exigence de sortie `sanctumDoor` ← runes est inchangée) et `abyss` (très grande galerie traversée de brasero allumé en
 * brasero allumé, fosses). Chaque salle sombre a ≥ 1 brasero allumé (recharge) à proximité des spawns, d'autres tous les
 * ≈ 25-35 tuiles, quelques torches près des épreuves, et un panneau `.dark` + un indice d'arrivée qui rappellent la torche.
 * Les braseros éteints de la forge et du gouffre sont facultatifs. L'arène reste éclairée par des braseros allumés (ambiance
 * rouge, rayon 7) mais n'est PAS sombre ; le trône est inchangé (salle de boss pure, aucun mécanisme).
 *
 * Toutes les chaînes affichées sont des clés i18n (parts `src/i18n/parts/level3.{fr,en}.json`).
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
 * Le résultat (`rows()`) est un tableau de chaînes rectangulaires conforme à `RoomDef.layout`.
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

  /** Creuse une fosse (bloque les déplacements, pas les projectiles). */
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

  /** Zones où les grilles de piliers ne posent rien (plaques, spawns, portes, panneaux…). */
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

  /** Lignes finales ; une tuile de sol sur sept devient la variante ',' (décor, praticable). */
  rows(): string[] {
    return this.cells.map((row, y) => row.map((c, x) => (c === '.' && (x * 3 + y * 5) % 7 === 0 ? ',' : c)).join(''));
  }
}

/** Cycle de paliers `minPlayers` : ≈ 55 % d'ennemis dès 1 joueur, 70 % à 2, 85 % à 3, 100 % à 4. */
const TIERS = [1, 1, 2, 1, 1, 3, 1, 1, 4, 1, 2, 1, 3, 1, 1, 4, 2, 1, 3, 4] as const;

/**
 * Pose ennemis et décors sur des tuiles de sol libres : chaque position demandée est « aimantée » vers la
 * tuile de sol libre la plus proche (jamais dans un mur, jamais deux sur la même tuile, jamais dans une zone
 * interdite, jamais à moins de `minDist` tuiles de l'arrivée des joueurs pour les ennemis).
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
    private readonly minDist = 13,
  ) {}

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
    throw new Error(`level3 : aucune tuile libre près de [${x},${y}]`);
  }

  /** Un ennemi près de (x, y). */
  foe(kind: EnemyKind, x: number, y: number, extra: Partial<Omit<EnemySpawnDef, 'kind' | 'tile'>> = {}): this {
    this.enemies.push({ kind, tile: this.snap(x, y, true), ...extra });
    return this;
  }

  /** Un groupe de `n` ennemis du même type, en petit amas autour de (x, y). */
  squad(kind: EnemyKind, x: number, y: number, n: number, extra: Partial<Omit<EnemySpawnDef, 'kind' | 'tile'>> = {}): this {
    for (let i = 0; i < n; i++) this.foe(kind, x + (i % 2) * 2, y + Math.floor(i / 2) * 2, extra);
    return this;
  }

  /** Décors du même type près des tuiles demandées. */
  decor(type: DecorDef['type'], ...tiles: TileXY[]): this {
    for (const [x, y] of tiles) this.decors.push({ type, tile: this.snap(x, y, false) });
    return this;
  }

  /**
   * Brasero ALLUMÉ (point de recharge de torche, lumière permanente) près de (x, y). Étiquette commune `fire` de la salle.
   * Solide : jamais dans une zone interdite (couloir de bloc, plaques…) ; l'atteignabilité reste validée par le validateur.
   */
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

  /** Panneau de salle (`sign.level3.<roomId>.<name>`), posé sur la tuile de sol libre la plus proche de (x, y). */
  sign(room: string, name: string, x: number, y: number): SignDef {
    return { id: `${room}.${name}`, tile: this.snap(x, y, false), textKey: `sign.level3.${room}.${name}` };
  }

  /** Ennemis finaux : les paliers `minPlayers` non précisés sont répartis selon le cycle `TIERS`. */
  tiered(): EnemySpawnDef[] {
    let i = 0;
    return this.enemies.map((e) => {
      if (e.minPlayers !== undefined) return e;
      const tier = TIERS[i++ % TIERS.length];
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

/** Décors `torch` posés à des tuiles précises (mur ou sol) : éclairent un peu (3 tuiles) les épreuves des salles sombres. */
function torchesAt(rows: readonly string[], ...tiles: TileXY[]): DecorDef[] {
  return tiles.map(([x, y]) => {
    if (rows[y]?.[x] === undefined) throw new Error(`level3 : torche hors grille [${x},${y}]`);
    return { type: 'torch' as const, tile: [x, y] as TileXY };
  });
}

/** Les quatre couleurs de slot, dans l'ordre des slots 0..3 (bleu, rouge, vert, jaune). */
const COLORS = ['Blue', 'Red', 'Green', 'Yellow'] as const;

/** Les 4 tuiles (carré 2×2 par défaut, ou w×h) d'une porte dont le coin haut-gauche est (x, y). */
function doorTiles(x: number, y: number, w = 2, h = 2): TileXY[] {
  const out: TileXY[] = [];
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) out.push([xx, yy]);
  return out;
}

/** Clé d'étiquette de mécanisme : `mech.level3.<roomId>.<mechanismId>`. */
function mechLabel(room: string, mechanismId: string): string {
  return `mech.level3.${room}.${mechanismId}`;
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

/** Nom, indice d'arrivée : clés `room.level3.<id>.name` et `hintroom.level3.<id>`. */
function roomKeys(id: string): { nameKey: string; introHintKey: string } {
  return { nameKey: `room.level3.${id}.name`, introHintKey: `hintroom.level3.${id}` };
}

/** Rectangle 1×1 d'une tuile (zone interdite aux ennemis/décors). */
function at(t: TileXY): TileRect {
  return rect(t[0] - 1, t[1] - 1, 3, 3);
}

// ───────────────────────────── Salle 1 : La Herse d'Entrée ─────────────────────────────
//
// 72×44. Idée : plaques SIMULTANÉES. Quatre plaques colorées aux QUATRE COINS de la cour ouest (une au bout de chaque
// aile nord/sud) ; la herse (porte 2×2 dans le mur central) se lève quand toutes les plaques existantes sont tenues en
// même temps, puis reste ouverte. Coop adaptative : plaque bleue min 1, rouge min 2, verte min 3, jaune min 4.
// Résolution : chaque héros rejoint la plaque de sa couleur — bleu [4,4] (aile nord, ouest), vert [31,4] (aile nord, est),
// rouge [4,39] (aile sud, ouest), jaune [31,39] (aile sud, est), par les liaisons de 3 tuiles x8..10 / x26..28 — la herse
// [35..36, 21..22] s'ouvre ; la cour est s'ouvre, on y bat tous les gardiens (clear), puis tous à la sortie [65..68, 19..24].
// Le calme est relatif : des limons rôdent dans les ailes, des squelettes veillent dans la cour est (aucun à < 12 tuiles du départ).

const gate: RoomDef = (() => {
  const plates: Record<string, TileXY> = { Blue: [4, 4], Green: [31, 4], Red: [4, 39], Yellow: [31, 39] };
  const spawn: TileXY = [3, 21];
  const b = new LayoutBuilder(72, 44)
    .floor(2, 12, 32, 20) // cour ouest x2..33, y12..31
    .floor(2, 2, 32, 7) // aile nord y2..8
    .floor(2, 35, 32, 7) // aile sud y35..41
    .floor(8, 9, 3, 3) // liaisons nord (y9..11)
    .floor(26, 9, 3, 3)
    .floor(8, 32, 3, 3) // liaisons sud (y32..34)
    .floor(26, 32, 3, 3)
    .floor(34, 21, 4, 2) // passage de la herse (tuiles de porte x35..36)
    .floor(38, 10, 32, 24) // cour est x38..69, y10..33
    .floor(40, 2, 12, 6) // alcôves nord-est (culs-de-sac)
    .floor(45, 8, 3, 2)
    .floor(58, 2, 12, 6)
    .floor(63, 8, 3, 2)
    .floor(40, 36, 12, 6) // alcôves sud-est
    .floor(45, 34, 3, 2)
    .floor(58, 36, 12, 6)
    .floor(63, 34, 3, 2)
    .reserve(
      rect(2, 17, 8, 10), // arrivée
      rect(30, 18, 8, 8), // approche de la herse
      rect(38, 18, 4, 8),
      rect(62, 16, 8, 14), // approche de la sortie
      ...Object.values(plates).map(at),
      rect(5, 20, 5, 3),
      rect(8, 12, 4, 3),
    )
    .pillarGrid(rect(4, 13, 28, 18), 5, 5, 2, 2)
    .pillarGrid(rect(40, 11, 22, 22), 5, 5, 1, 2)
    .pillarGrid(rect(12, 3, 16, 5), 5, 3, 0, 2)
    .pillarGrid(rect(12, 36, 16, 5), 5, 3, 0, 2);
  const rows = b.rows();
  const p = new Placer(rows, spawn, [...Object.values(plates).map(at), rect(33, 20, 6, 4), rect(5, 20, 5, 3)])
    // ailes ouest : limons et squelettes entre les plaques
    .squad('slime', 14, 5, 2)
    .foe('skeleton', 24, 5)
    .squad('slime', 14, 38, 2)
    .foe('skeleton', 24, 38)
    .foe('bat', 16, 16)
    .foe('bat', 27, 27)
    .foe('skeleton', 21, 22)
    .foe('skeleton', 9, 6)
    // cour est : gardiens en patrouilles
    .squad('skeleton', 44, 15, 2)
    .foe('skeleton', 44, 29)
    .foe('bat', 54, 21)
    .squad('slime', 56, 13, 1)
    .foe('slime', 56, 31)
    .foe('archer', 62, 12)
    .foe('archer', 62, 32)
    .foe('skeleton', 45, 4)
    .foe('bat', 64, 4)
    .foe('skeleton', 45, 39);
  const mechanisms: MechanismDef[] = COLORS.map((color, slot): MechanismDef => {
    const base = {
      id: `plate${color}`,
      type: 'plate' as const,
      tile: plates[color],
      colorSlot: slot,
      labelKey: mechLabel('gate', `plate${color}`),
    };
    return slot === 0 ? base : { ...base, minPlayers: slot + 1 };
  });
  mechanisms.push({
    id: 'gateDoor',
    type: 'door',
    tiles: doorTiles(35, 21),
    requires: ['plateBlue', 'plateRed', 'plateGreen', 'plateYellow'],
    labelKey: mechLabel('gate', 'gateDoor'),
  });
  return {
    id: 'gate',
    ...roomKeys('gate'),
    theme: 'citadel',
    layout: rows,
    playerSpawns: spawns(...spawn),
    enemies: p.tiered(),
    mechanisms,
    signs: [p.sign('gate', 'plates', 7, 21), p.sign('gate', 'wings', 9, 13), p.sign('gate', 'door', 31, 21)],
    decor: [
      ...wallDecor(rows, 'torch', rect(2, 12, 32, 20), 8),
      ...wallDecor(rows, 'torch', rect(38, 10, 32, 24), 8),
      ...wallDecor(rows, 'torch', rect(2, 2, 32, 7), 10),
      ...wallDecor(rows, 'torch', rect(2, 35, 32, 7), 10, 'south'),
      ...wallDecor(rows, 'banner', rect(38, 10, 32, 24), 12, 'north', 6),
      ...p.decor('statue', [3, 14], [3, 29], [34, 14], [34, 29]).decor('crystal', [14, 3], [14, 40], [66, 4], [66, 39])
        .decor('bones', [18, 14], [50, 30], [60, 15]).decor('crate', [2, 2], [2, 41], [69, 10], [69, 33]).decors,
    ],
    exit: { rect: rect(65, 19, 4, 6), requires: ['gateDoor', 'clear'] },
  };
})();

// ───────────────────────────── Salle 2 : La Galerie des Sceaux ─────────────────────────────
//
// 68×48. Idée : actions SÉPARÉES simultanées. Quatre clés personnelles, chacune au fond d'une CHAMBRE de coin (reliée
// au grand hall par un couloir de 3 tuiles) ; quatre portes dans le mur est du hall (une par couleur) donnent sur la
// galerie de sortie. Chaque héros ne ramasse QUE la clé de sa couleur et n'ouvre QUE la porte de sa couleur. Coop
// adaptative : les clés/portes des slots 1..3 n'existent qu'à 2..4 joueurs (portes waived = ouvertes d'office) ;
// leurs gardiens suivent les mêmes `minPlayers`.
// Résolution : héros bleu → clé [4,4] (chambre nord-ouest) puis porte [50..51, 15..16] ; rouge → [47,4] (nord-est) puis
// [50..51, 20..21] ; vert → [4,43] (sud-ouest) puis [50..51, 25..26] ; jaune → [47,43] (sud-est) puis [50..51, 30..31] ;
// les clés se ramassent en marchant dessus, la porte s'ouvre avec Action à portée, clé en main. Les 4 portes
// ouvertes → sortie dans la galerie est [58..62, 21..24]. Objectif slot 0 « seal » : la porte bleue.

const seals: RoomDef = (() => {
  const keyTiles: TileXY[] = [
    [4, 4],
    [47, 4],
    [4, 43],
    [47, 43],
  ];
  const doorTop = [15, 20, 25, 30];
  const spawn: TileXY = [4, 23];
  const mechanisms: MechanismDef[] = [];
  COLORS.forEach((color, slot) => {
    const minPlayers = slot === 0 ? undefined : slot + 1;
    const extra = minPlayers === undefined ? {} : { minPlayers };
    mechanisms.push({
      id: `key${color}`,
      type: 'key',
      tile: keyTiles[slot],
      ownerSlot: slot,
      doorId: `door${color}`,
      labelKey: mechLabel('seals', `key${color}`),
      ...extra,
    });
    mechanisms.push({
      id: `door${color}`,
      type: 'door',
      tiles: doorTiles(50, doorTop[slot]),
      requires: [],
      keyId: `key${color}`,
      labelKey: mechLabel('seals', `door${color}`),
      ...extra,
    });
  });
  const b = new LayoutBuilder(68, 48)
    .floor(2, 14, 48, 20) // grand hall x2..49, y14..33
    .floor(2, 2, 12, 9) // chambres des quatre coins
    .floor(38, 2, 12, 9)
    .floor(2, 37, 12, 9)
    .floor(38, 37, 12, 9)
    .floor(6, 11, 3, 3) // couloirs de liaison (3 tuiles)
    .floor(42, 11, 3, 3)
    .floor(6, 34, 3, 3)
    .floor(42, 34, 3, 3)
    .floor(50, 15, 2, 2) // passages des quatre portes
    .floor(50, 20, 2, 2)
    .floor(50, 25, 2, 2)
    .floor(50, 30, 2, 2)
    .floor(52, 12, 14, 24) // galerie de sortie x52..65, y12..35
    .reserve(
      rect(2, 19, 9, 10), // arrivée
      rect(44, 14, 8, 20), // approche des portes
      ...keyTiles.map(at),
      rect(5, 12, 5, 3),
      rect(11, 24, 4, 3),
    )
    .pillarGrid(rect(4, 15, 44, 18), 6, 5, 3, 2)
    .pillarGrid(rect(4, 3, 8, 7), 4, 3, 2, 1)
    .pillarGrid(rect(40, 3, 8, 7), 4, 3, 2, 1)
    .pillarGrid(rect(4, 38, 8, 7), 4, 3, 2, 1)
    .pillarGrid(rect(40, 38, 8, 7), 4, 3, 2, 1)
    .pillarGrid(rect(54, 13, 10, 22), 5, 5, 1, 1);
  const rows = b.rows();
  const p = new Placer(rows, spawn, [...keyTiles.map(at), rect(48, 14, 6, 20), rect(11, 24, 4, 3)])
    // gardes des clés (mêmes paliers que leurs clés)
    .foe('skeleton', 9, 6)
    .foe('bat', 42, 6, { minPlayers: 2 })
    .foe('archer', 9, 41, { minPlayers: 3 })
    .foe('spider', 42, 41, { minPlayers: 4 })
    // chambres : un peu de compagnie
    .foe('slime', 11, 8)
    .foe('skeleton', 40, 8)
    .foe('slime', 11, 38)
    .foe('bat', 40, 40)
    // grand hall : patrouilles réparties
    .squad('skeleton', 20, 18, 2)
    .squad('slime', 20, 30, 2)
    .foe('bat', 28, 24)
    .squad('skeleton', 34, 17, 2)
    .squad('slime', 34, 31, 1)
    .foe('archer', 26, 16)
    .foe('skeleton', 44, 24)
    .foe('bat', 16, 24)
    .foe('spider', 40, 24)
    // galerie de sortie
    .squad('skeleton', 56, 15, 2)
    .squad('slime', 56, 32, 2)
    .foe('archer', 62, 14)
    .foe('bat', 60, 28);
  return {
    id: 'seals',
    ...roomKeys('seals'),
    theme: 'citadel',
    layout: rows,
    playerSpawns: spawns(...spawn),
    enemies: p.tiered(),
    mechanisms,
    signs: [p.sign('seals', 'keys', 7, 21), p.sign('seals', 'chambers', 12, 16), p.sign('seals', 'doors', 47, 23)],
    decor: [
      ...wallDecor(rows, 'torch', rect(2, 14, 48, 20), 8),
      ...wallDecor(rows, 'torch', rect(2, 33, 48, 1), 8, 'south'),
      ...wallDecor(rows, 'torch', rect(52, 12, 14, 24), 6),
      ...wallDecor(rows, 'banner', rect(52, 12, 14, 24), 6, 'north', 6),
      ...p.decor('statue', [53, 13], [53, 34], [64, 13], [64, 34]).decor('crystal', [2, 2], [49, 2], [2, 45], [49, 45], [10, 15])
        .decor('crate', [3, 3], [12, 9], [3, 44], [48, 44]).decor('bones', [30, 20], [22, 28], [58, 18]).decors,
    ],
    exit: { rect: rect(58, 21, 5, 4), requires: ['doorBlue', 'doorRed', 'doorGreen', 'doorYellow'] },
  };
})();

// ───────────────────────────── Salle 3 : La Forge des Gardiens ─────────────────────────────
//
// 80×46. Idée : le BLOC 2×2 à deux joueurs. Le bloc est dans un COULOIR de 2 tuiles (y22..23) fermé sur les côtés et au
// fond, long de 32 tuiles ; le socle est tout au fond [44,22]. Il avance d'une tuile par poussée soutenue (≈ 0,35 s) et
// ne bouge que si 2 héros le poussent ensemble (à 1 joueur : 1 seul suffit) : ≈ 11 s de poussée continue. Pendant ce temps,
// des gardiens sortent des deux galeries : les autres défendent l'entrée du couloir (dans le hall ouest, large de 12 tuiles
// derrière le bloc). Socle rempli → la porte [62..63, 9..10] de la galerie nord s'ouvre sur le hall est (sortie).
// Résolution : deux héros se placent à l'ouest du bloc [14,22] (tuiles [13,22] et [13,23]) et poussent vers l'est pendant
// 30 tuiles jusqu'au socle [44,22] ; ensuite on monte par la liaison [14..15, 8..11], on traverse la galerie nord jusqu'à la
// porte, puis le hall est et la sortie [72..76, 20..25]. Aucun verrou : personne ne peut atteindre l'est du bloc, et les
// murs (y21, y24) interdisent toute poussée latérale ; fond muré en x46.

const forge: RoomDef = (() => {
  const spawn: TileXY = [3, 21];
  const lane = rect(14, 22, 32, 2);
  const b = new LayoutBuilder(80, 46)
    .floor(2, 6, 12, 34) // hall ouest x2..13, y6..39 (derrière le bloc)
    .floor(14, 22, 32, 2) // couloir du bloc x14..45, y22..23
    .floor(16, 3, 46, 15) // galerie nord x16..61, y3..17
    .floor(16, 28, 46, 15) // galerie sud x16..61, y28..42
    .floor(14, 8, 2, 4) // liaison hall → galerie nord
    .floor(14, 32, 2, 4) // liaison hall → galerie sud
    .floor(62, 9, 2, 2) // passage de la porte
    .floor(64, 2, 14, 42) // hall est x64..77, y2..43
    .reserve(
      rect(2, 17, 11, 12), // arrivée + espace derrière le bloc
      rect(56, 5, 8, 10), // approche de la porte
      rect(70, 17, 8, 12), // approche de la sortie
      rect(13, 6, 4, 8),
      rect(13, 30, 4, 8),
    )
    .pillarGrid(rect(18, 4, 42, 13), 6, 4, 2, 2)
    .pillarGrid(rect(18, 29, 42, 13), 6, 4, 2, 2)
    .pillarGrid(rect(66, 3, 10, 40), 5, 5, 2, 1)
    .pillarGrid(rect(3, 7, 10, 9), 5, 4, 2, 1)
    .pillarGrid(rect(3, 30, 10, 9), 5, 4, 2, 1);
  const rows = b.rows();
  const p = new Placer(rows, spawn, [lane, rect(12, 20, 4, 6)])
    // braseros allumés (recharge de torche) : départ, entrée de la galerie nord, avant la porte, galerie sud, hall est
    .lit('forge', 'forgeFire1', 7, 20)
    .lit('forge', 'forgeFire2', 26, 10)
    .lit('forge', 'forgeFire3', 52, 10)
    .lit('forge', 'forgeFire4', 30, 36)
    .lit('forge', 'forgeFire5', 68, 22)
    // brasero facultatif à allumer : éclaire la liaison sud (jamais requis)
    .unlit('forge', 'forgePyre', 'pyre', 9, 33)
    // hall ouest
    .foe('slime', 6, 9)
    .foe('slime', 6, 36)
    // galerie nord
    .squad('skeleton', 22, 8, 2)
    .foe('bat', 32, 6)
    .foe('bat', 38, 12)
    .squad('skeleton', 44, 6, 2)
    .foe('spider', 52, 12)
    .foe('archer', 58, 5)
    .foe('slime', 26, 14)
    .foe('skeleton', 56, 14)
    // galerie sud (les gardiens qui harcèlent l'entrée du couloir)
    .squad('skeleton', 22, 32, 2)
    .foe('bat', 32, 38)
    .squad('slime', 28, 34, 2)
    .foe('archer', 56, 30)
    .foe('spider', 46, 40)
    .foe('skeleton', 40, 33)
    .foe('bat', 52, 36)
    .foe('skeleton', 58, 40)
    // hall est
    .squad('skeleton', 68, 8, 2)
    .squad('skeleton', 68, 36, 2)
    .foe('bat', 72, 14)
    .foe('archer', 74, 30)
    .foe('slime', 72, 40);
  return {
    id: 'forge',
    ...roomKeys('forge'),
    theme: 'citadel',
    layout: rows,
    playerSpawns: spawns(...spawn),
    enemies: p.tiered(),
    mechanisms: [
      ...p.fires,
      { id: 'forgeBlock', type: 'block', tile: [14, 22], labelKey: mechLabel('forge', 'forgeBlock') },
      { id: 'forgeSocket', type: 'socket', tile: [44, 22], blockId: 'forgeBlock', labelKey: mechLabel('forge', 'forgeSocket') },
      {
        id: 'forgeDoor',
        type: 'door',
        tiles: doorTiles(62, 9),
        requires: ['forgeSocket'],
        labelKey: mechLabel('forge', 'forgeDoor'),
      },
    ],
    signs: [
      p.sign('forge', 'dark', 6, 18),
      p.sign('forge', 'block', 9, 20),
      p.sign('forge', 'guard', 10, 26),
      p.sign('forge', 'path', 17, 9),
    ],
    decor: [
      // salle sombre : peu de torches murales, posées là où l'on doit VOIR (bloc, socle, porte, sortie)
      ...torchesAt(
        rows,
        [14, 21], // départ du bloc
        [14, 24],
        [24, 21], // le long du couloir
        [34, 24],
        [44, 21], // socle
        [45, 24],
        [62, 8], // porte de la forge
        [63, 11],
      ),
      ...wallDecor(rows, 'banner', rect(2, 6, 12, 34), 6, 'north', 3),
      ...p.decor('torch', [72, 18], [72, 27]).decor('crystal', [75, 3], [75, 42], [3, 7], [3, 38]).decor('statue', [17, 4], [17, 41], [60, 4], [60, 41])
        .decor('bones', [30, 14], [36, 36], [70, 20]).decor('crate', [2, 6], [2, 39], [61, 42], [77, 2]).decors,
    ],
    exit: { rect: rect(72, 20, 5, 6), requires: ['forgeDoor'] },
    dark: true,
  };
})();

// ───────────────────────────── Salle 4 : Le Sanctuaire des Runes ─────────────────────────────
//
// 72×46. Idée : VISION PARTAGÉE (et premiers feux follets, qui tirent à distance). La séquence de 4 runes n'est visible
// que par le héros ROUGE (slot 1) sur l'écran de la niche nord [34,4]. Six piédestaux sont cachés dans six chambres
// éparses autour du grand hall (quatre coins + deux flancs) ; les autres héros les frappent (Action) dans l'ordre que le
// héros rouge décrit. Une erreur remet à zéro. À 1 joueur : énigme de mémoire (on lit la séquence, on la retient, on court
// aux piédestaux). Sortie : une chambre au sud, derrière la porte [34..35, 32..33].
// Résolution : lire la séquence [étoile, lune, œil, flamme] depuis la niche nord ; frapper dans l'ordre les piédestaux
// étoile [4,23] (flanc ouest), lune [65,5] (nord-est), œil [67,23] (flanc est), flamme [65,40] (sud-est) ; la porte
// s'ouvre ; on traverse la chambre sud jusqu'à la sortie [30..37, 38..41]. Les feux follets sont exposés (piliers) et
// peuvent être abattus avant ou pendant l'énigme.

const sanctum: RoomDef = (() => {
  const spawn: TileXY = [34, 22];
  const pedestals = [
    { symbol: 'sun' as const, tile: [6, 5] as TileXY },
    { symbol: 'moon' as const, tile: [65, 5] as TileXY },
    { symbol: 'star' as const, tile: [4, 23] as TileXY },
    { symbol: 'eye' as const, tile: [67, 23] as TileXY },
    { symbol: 'flame' as const, tile: [65, 40] as TileXY },
    { symbol: 'wave' as const, tile: [6, 40] as TileXY },
  ];
  const b = new LayoutBuilder(72, 46)
    .floor(14, 14, 44, 18) // grand hall x14..57, y14..31
    .floor(4, 3, 14, 8) // chambre nord-ouest
    .floor(54, 3, 14, 8) // chambre nord-est
    .floor(4, 35, 14, 8) // chambre sud-ouest
    .floor(54, 35, 14, 8) // chambre sud-est
    .floor(2, 16, 10, 14) // chambre ouest
    .floor(60, 16, 10, 14) // chambre est
    .floor(28, 2, 12, 9) // niche des runes (nord)
    .floor(15, 11, 3, 3) // liaisons
    .floor(54, 11, 3, 3)
    .floor(15, 32, 3, 3)
    .floor(54, 32, 3, 3)
    .floor(12, 21, 2, 3)
    .floor(58, 21, 2, 3)
    .floor(34, 11, 2, 3) // liaison hall → niche (tuiles de la porte de la niche y11..12)
    .floor(34, 32, 2, 4) // passage de la porte (tuiles de porte y32..33)
    .floor(26, 36, 16, 8) // chambre de sortie (sud)
    .reserve(
      rect(30, 18, 10, 8), // arrivée
      ...pedestals.map((x) => at(x.tile)),
      rect(33, 9, 4, 6),
      rect(30, 28, 10, 4),
      rect(29, 36, 10, 7),
    )
    .pillarGrid(rect(16, 15, 40, 16), 6, 5, 1, 1)
    .pillarGrid(rect(5, 4, 12, 6), 4, 3, 1, 1)
    .pillarGrid(rect(55, 4, 12, 6), 4, 3, 1, 1)
    .pillarGrid(rect(5, 36, 12, 6), 4, 3, 1, 1)
    .pillarGrid(rect(55, 36, 12, 6), 4, 3, 1, 1)
    .pillarGrid(rect(3, 17, 8, 12), 4, 4, 1, 1)
    .pillarGrid(rect(61, 17, 8, 12), 4, 4, 1, 1);
  const rows = b.rows();
  const colorBraziers: TileXY[] = [
    [18, 16],
    [53, 16],
    [18, 29],
    [53, 29],
  ];
  const p = new Placer(rows, spawn, [
    ...pedestals.map((x) => at(x.tile)),
    rect(33, 9, 4, 6),
    rect(33, 31, 4, 6),
    rect(30, 38, 8, 4), // sortie
  ]);
  // braseros de couleur : chaque héros allume SON brasero (slot 0 bleu, 1 rouge, 2 vert, 3 jaune) ; coop adaptative minPlayers = slot + 1
  COLORS.forEach((color, slot) => {
    p.unlit('sanctum', `sanctumBrazier${color}`, `brazier${color}`, colorBraziers[slot][0], colorBraziers[slot][1], {
      ownerSlot: slot,
      lightRadiusTiles: 4,
      ...(slot === 0 ? {} : { minPlayers: slot + 1 }),
    });
  });
  // braseros allumés (recharge de torche) : départ, niche des runes, les quatre chambres des piédestaux utiles, sortie
  p.lit('sanctum', 'sanctumFire1', 37, 25)
    .lit('sanctum', 'sanctumFire2', 31, 8)
    .lit('sanctum', 'sanctumFire3', 8, 25)
    .lit('sanctum', 'sanctumFire4', 63, 20)
    .lit('sanctum', 'sanctumFire5', 60, 7)
    .lit('sanctum', 'sanctumFire6', 60, 38)
    .lit('sanctum', 'sanctumFire7', 28, 39);
  p
    // feux follets : exposés, répartis autour du hall
    .foe('wisp', 20, 17)
    .foe('wisp', 50, 28, { minPlayers: 2 })
    .foe('wisp', 28, 6, { minPlayers: 3 })
    .foe('wisp', 46, 16)
    .foe('wisp', 22, 27)
    .foe('wisp', 8, 38)
    .foe('wisp', 62, 8)
    // chambres des piédestaux : chaque coin a ses habitants
    .squad('skeleton', 10, 7, 2)
    .foe('bat', 14, 5)
    .squad('slime', 60, 7, 2)
    .foe('skeleton', 58, 5)
    .squad('skeleton', 11, 39, 1)
    .foe('bat', 14, 41)
    .squad('skeleton', 60, 39, 2)
    .foe('spider', 58, 41)
    .foe('slime', 8, 20)
    .foe('skeleton', 8, 27)
    .foe('slime', 64, 19)
    .foe('bat', 64, 27)
    // hall et niche
    .foe('skeleton', 18, 24)
    .foe('spider', 52, 22)
    .foe('bat', 34, 7)
    .foe('skeleton', 30, 40)
    .foe('slime', 40, 38);
  return {
    id: 'sanctum',
    ...roomKeys('sanctum'),
    theme: 'citadel',
    layout: rows,
    playerSpawns: spawns(...spawn),
    enemies: p.tiered(),
    mechanisms: [
      ...p.fires,
      {
        id: 'nicheDoor',
        type: 'door',
        tiles: doorTiles(34, 11),
        requires: COLORS.map((c) => `sanctumBrazier${c}`),
        labelKey: mechLabel('sanctum', 'nicheDoor'),
      },
      {
        id: 'sanctumRunes',
        type: 'runePuzzle',
        displayTile: [34, 4],
        visibleToSlot: 1,
        sequence: ['star', 'moon', 'eye', 'flame'],
        pedestals,
        labelKey: mechLabel('sanctum', 'sanctumRunes'),
      },
      {
        id: 'sanctumDoor',
        type: 'door',
        tiles: doorTiles(34, 32),
        requires: ['sanctumRunes'],
        labelKey: mechLabel('sanctum', 'sanctumDoor'),
      },
    ],
    signs: [
      p.sign('sanctum', 'dark', 33, 20),
      p.sign('sanctum', 'seer', 31, 21),
      p.sign('sanctum', 'niche', 37, 16),
      p.sign('sanctum', 'pedestals', 32, 13),
      p.sign('sanctum', 'chambers', 38, 22),
    ],
    decor: [
      // salle sombre : torches près des braseros de couleur, de la niche des runes, des piédestaux et de la porte
      ...torchesAt(
        rows,
        [18, 13], // repères des braseros de couleur
        [53, 13],
        [19, 32],
        [53, 32],
        [33, 3], // niche : séquence de runes (écran en [34,4])
        [36, 3],
        [33, 12], // porte de la niche
        [36, 12],
        [33, 32], // porte du sanctuaire
        [36, 32],
        [3, 22], // piédestal de l'étoile
        [68, 22], // piédestal de l'œil
        [64, 4], // piédestal de la lune
        [64, 39], // piédestal de la flamme
      ),
      ...wallDecor(rows, 'banner', rect(26, 36, 16, 8), 5, 'south', 2),
      ...p.decor('statue', [31, 3], [38, 3], [27, 37], [40, 37]).decor('crystal', [4, 3], [67, 3], [4, 42], [67, 42], [2, 16], [69, 29])
        .decor('crate', [4, 10], [67, 10], [17, 42], [54, 42]).decor('bones', [24, 22], [46, 20]).decors,
    ],
    exit: { rect: rect(30, 38, 8, 4), requires: ['sanctumDoor'] },
    dark: true,
  };
})();

// ───────────────────────────── Salle 5 : Les Balcons Jumeaux ─────────────────────────────
//
// 84×50. Idée : leviers à FENÊTRE, actions séparées. Quatre leviers réservés (un par couleur) aux quatre COINS d'un
// château en anneau (quatre halls de coin reliés par deux grands couloirs nord/sud et deux couloirs latéraux ; au milieu,
// la salle centrale où l'on arrive). Chaque levier se rabat 20 s après avoir été tiré : il faut les avoir tous tirés « presque
// ensemble » — on les rejoint, on s'annonce, on tire (le trajet d'un coin à l'autre dure ≈ 22 s, d'où la fenêtre généreuse).
// Levier rouge min 2, vert min 3, jaune min 4 (fenêtre effective inchangée : 20 s à tout n). Des araignées gardent les
// leviers ; des chevaliers déchus (premiers du niveau) rôdent dans les couloirs.
// Résolution : chaque héros court à son levier — bleu [4,4] (nord-ouest), rouge [79,4] (nord-est), vert [4,45] (sud-ouest),
// jaune [79,45] (sud-est) — et le tire (Action) ; quand les quatre sont actifs en même temps, la herse [56..57, 24..25]
// (est de la salle centrale) s'ouvre définitivement sur l'alcôve de sortie [64..67, 22..27].
// Objectif slot 3 « lever » : le levier jaune (waived, donc accompli d'office, à moins de 4 joueurs).

const balconies: RoomDef = (() => {
  const leverTiles: TileXY[] = [
    [4, 4],
    [79, 4],
    [4, 45],
    [79, 45],
  ];
  const spawn: TileXY = [40, 24];
  const mechanisms: MechanismDef[] = COLORS.map((color, slot): MechanismDef => {
    const base = {
      id: `lever${color}`,
      type: 'lever' as const,
      tile: leverTiles[slot],
      ownerSlot: slot,
      windowMs: 20000,
      labelKey: mechLabel('balconies', `lever${color}`),
    };
    return slot === 0 ? base : { ...base, minPlayers: slot + 1 };
  });
  mechanisms.push({
    id: 'balconyDoor',
    type: 'door',
    tiles: doorTiles(56, 24),
    requires: COLORS.map((c) => `lever${c}`),
    labelKey: mechLabel('balconies', 'balconyDoor'),
  });
  const b = new LayoutBuilder(84, 50)
    .floor(2, 2, 24, 14) // halls de coin
    .floor(58, 2, 24, 14)
    .floor(2, 34, 24, 14)
    .floor(58, 34, 24, 14)
    .floor(26, 8, 32, 4) // grand couloir nord
    .floor(26, 38, 32, 4) // grand couloir sud
    .floor(8, 16, 4, 18) // couloir ouest
    .floor(72, 16, 4, 18) // couloir est
    .floor(28, 14, 28, 22) // salle centrale x28..55, y14..35
    .floor(40, 12, 4, 2) // liaisons centrale ↔ couloirs nord/sud
    .floor(40, 36, 4, 2)
    .floor(56, 24, 2, 2) // passage de la herse
    .floor(58, 20, 12, 10) // alcôve de sortie x58..69, y20..29
    .reserve(
      rect(35, 20, 12, 10), // arrivée
      rect(52, 20, 6, 10), // approche de la herse
      ...leverTiles.map(at),
      rect(38, 11, 8, 4),
      rect(38, 35, 8, 4),
    )
    .pillarGrid(rect(30, 15, 24, 20), 5, 5, 2, 2)
    .pillarGrid(rect(4, 3, 20, 12), 5, 4, 3, 2)
    .pillarGrid(rect(60, 3, 20, 12), 5, 4, 3, 2)
    .pillarGrid(rect(4, 35, 20, 12), 5, 4, 3, 2)
    .pillarGrid(rect(60, 35, 20, 12), 5, 4, 3, 2)
    .pillarGrid(rect(28, 9, 28, 2), 6, 1, 3, 0)
    .pillarGrid(rect(28, 39, 28, 2), 6, 1, 3, 0)
    .pillarGrid(rect(59, 21, 10, 8), 5, 4, 2, 2);
  const rows = b.rows();
  const p = new Placer(rows, spawn, [...leverTiles.map(at), rect(54, 21, 5, 8)])
    // gardes des leviers : une araignée par levier (mêmes paliers)
    .foe('spider', 9, 7)
    .foe('spider', 74, 7, { minPlayers: 2 })
    .foe('spider', 9, 42, { minPlayers: 3 })
    .foe('spider', 74, 42, { minPlayers: 4 })
    // chevaliers déchus : premier du niveau dans le couloir nord, d'autres plus loin
    .foe('knight', 42, 9)
    .foe('knight', 42, 40)
    .foe('knight', 10, 25)
    .foe('knight', 74, 25)
    // halls de coin
    .squad('skeleton', 16, 6, 2)
    .foe('bat', 20, 12)
    .squad('skeleton', 66, 6, 2)
    .foe('archer', 62, 12)
    .squad('skeleton', 16, 43, 1)
    .foe('bat', 20, 36)
    .squad('slime', 66, 43, 2)
    .foe('archer', 62, 37)
    // couloirs et salle centrale
    .foe('skeleton', 32, 9)
    .foe('skeleton', 52, 40)
    .foe('bat', 10, 20)
    .foe('bat', 74, 30)
    .foe('slime', 10, 30)
    .foe('skeleton', 74, 20)
    .foe('wisp', 30, 16)
    .foe('wisp', 53, 33)
    .foe('skeleton', 53, 16)
    .foe('slime', 30, 33)
    // alcôve de sortie
    .foe('skeleton', 62, 22)
    .foe('bat', 66, 27);
  return {
    id: 'balconies',
    ...roomKeys('balconies'),
    theme: 'citadel',
    layout: rows,
    playerSpawns: spawns(...spawn),
    enemies: p.tiered(),
    mechanisms,
    signs: [
      p.sign('balconies', 'levers', 38, 22),
      p.sign('balconies', 'corners', 44, 26),
      p.sign('balconies', 'knight', 45, 12),
    ],
    decor: [
      ...wallDecor(rows, 'torch', rect(2, 2, 24, 14), 8),
      ...wallDecor(rows, 'torch', rect(58, 2, 24, 14), 8),
      ...wallDecor(rows, 'torch', rect(2, 34, 24, 14), 8, 'south'),
      ...wallDecor(rows, 'torch', rect(58, 34, 24, 14), 8, 'south'),
      ...wallDecor(rows, 'torch', rect(28, 14, 28, 22), 7),
      ...wallDecor(rows, 'banner', rect(28, 14, 28, 22), 9, 'south', 5),
      ...p.decor('statue', [2, 8], [81, 8], [2, 41], [81, 41]).decor('crystal', [25, 2], [58, 2], [25, 47], [58, 47], [2, 2], [81, 47])
        .decor('bones', [20, 18], [62, 40], [40, 32]).decor('crate', [2, 15], [81, 15], [2, 34], [81, 34]).decors,
    ],
    exit: { rect: rect(64, 22, 4, 6), requires: ['balconyDoor'] },
  };
})();

// ───────────────────────────── Salle 6 : Le Gouffre aux Reflets ─────────────────────────────
//
// 80×48. Idée : le bloc REMPLACE un joueur sur une plaque. La porte exige DEUX plaques tenues en même temps :
//  - la plaque du bloc, au fond du couloir nord [44,4] : un bloc 2×2 poussé à deux joueurs la couvre pour toujours ;
//  - la plaque de l'îlot [36,28] (héros vert), au milieu du gouffre, sous le feu des archers de la corniche est.
// Coop adaptative : la plaque de l'îlot n'existe qu'à 3+ joueurs (à 1-2 joueurs, tous les héros poussent le bloc).
// Résolution : deux héros poussent le bloc [14,4] vers l'est (30 tuiles) jusqu'à couvrir la plaque [44,4] ; le héros vert
// (3+ joueurs) fait le tour par l'anneau, traverse le pont [24..31, 27..29] et tient la plaque [36,28] ; la porte
// [66..67, 26..27] s'ouvre (définitivement) ; tous vers la sortie [72..76, 24..29] à l'est.
// Aucun verrou : même principe de couloir fermé que la Forge (rangées y3 et y6 murées, fond en x46).

const abyss: RoomDef = (() => {
  const spawn: TileXY = [5, 24];
  const lane = rect(14, 4, 32, 2);
  const b = new LayoutBuilder(80, 48)
    .floor(2, 2, 12, 44) // hall ouest x2..13 (derrière le bloc)
    .floor(14, 4, 32, 2) // couloir du bloc x14..45, y4..5 (fermé en x46)
    .floor(16, 8, 50, 38) // salle centrale x16..65, y8..45
    .floor(14, 20, 2, 6) // liaison hall → salle centrale
    .pit(24, 16, 34, 26) // gouffre x24..57, y16..41
    .floor(24, 27, 8, 3) // pont x24..31, y27..29
    .floor(32, 22, 10, 14) // îlot x32..41, y22..35
    .floor(66, 26, 2, 2) // passage de la porte
    .floor(68, 18, 10, 18) // alcôve de sortie x68..77, y18..35
    .reserve(rect(2, 19, 10, 12), rect(33, 25, 7, 8), rect(24, 26, 9, 5), rect(60, 22, 8, 10), rect(70, 22, 8, 10))
    .pillarGrid(rect(17, 9, 48, 7), 6, 3, 2, 1)
    .pillarGrid(rect(17, 42, 48, 4), 6, 3, 2, 1)
    .pillarGrid(rect(16, 16, 8, 26), 4, 4, 2, 2)
    .pillarGrid(rect(58, 16, 8, 26), 4, 4, 2, 2)
    .pillarGrid(rect(3, 3, 10, 40), 4, 5, 2, 2);
  const rows = b.rows();
  const p = new Placer(rows, spawn, [lane, rect(33, 25, 7, 8), rect(12, 2, 4, 6)])
    // braseros allumés (recharge de torche) de loin en loin le long de l'anneau : départ, départ du bloc, anneaux ouest/nord/sud/est, îlot, sortie
    .lit('abyss', 'abyssFire1', 8, 22)
    .lit('abyss', 'abyssFire2', 10, 8)
    .lit('abyss', 'abyssFire3', 20, 30)
    .lit('abyss', 'abyssFire4', 28, 12)
    .lit('abyss', 'abyssFire5', 50, 12)
    .lit('abyss', 'abyssFire6', 62, 24)
    .lit('abyss', 'abyssFire7', 52, 43)
    .lit('abyss', 'abyssFire8', 30, 43)
    .lit('abyss', 'abyssFire9', 36, 24)
    .lit('abyss', 'abyssFire10', 74, 22)
    // brasero facultatif à allumer : balise au centre de l'anneau sud (jamais requis)
    .unlit('abyss', 'abyssPyre', 'pyre', 41, 43)
    // anneau ouest et nord
    .foe('skeleton', 19, 33)
    .squad('skeleton', 22, 11, 2)
    .foe('bat', 34, 12)
    .foe('bat', 46, 12)
    .squad('skeleton', 56, 11, 2)
    .foe('wisp', 40, 10)
    .foe('slime', 19, 22)
    // corniche est : archers dont les tirs traversent le gouffre
    .foe('archer', 60, 19)
    .foe('archer', 60, 24, { minPlayers: 2 })
    .foe('archer', 60, 29)
    .foe('archer', 60, 34, { minPlayers: 2 })
    .foe('skeleton', 63, 22)
    .foe('skeleton', 63, 32)
    // anneau sud
    .squad('skeleton', 20, 43, 2)
    .foe('bat', 32, 43)
    .foe('slime', 44, 44)
    .foe('bat', 52, 43)
    .squad('skeleton', 58, 43, 1)
    .foe('wisp', 40, 44)
    // îlot et pont
    .foe('bat', 37, 24)
    .foe('skeleton', 30, 28)
    // hall ouest (loin de l'arrivée) et alcôve de sortie
    .foe('slime', 7, 9)
    .foe('slime', 7, 40)
    .foe('skeleton', 72, 21)
    .foe('bat', 72, 32);
  return {
    id: 'abyss',
    ...roomKeys('abyss'),
    theme: 'citadel',
    layout: rows,
    playerSpawns: spawns(...spawn),
    enemies: p.tiered(),
    mechanisms: [
      ...p.fires,
      { id: 'abyssBlock', type: 'block', tile: [14, 4], labelKey: mechLabel('abyss', 'abyssBlock') },
      { id: 'plateBlock', type: 'plate', tile: [44, 4], labelKey: mechLabel('abyss', 'plateBlock') },
      {
        id: 'plateIsland',
        type: 'plate',
        tile: [36, 28],
        colorSlot: 2,
        minPlayers: 3,
        labelKey: mechLabel('abyss', 'plateIsland'),
      },
      {
        id: 'abyssDoor',
        type: 'door',
        tiles: doorTiles(66, 26),
        requires: ['plateBlock', 'plateIsland'],
        labelKey: mechLabel('abyss', 'abyssDoor'),
      },
    ],
    signs: [
      p.sign('abyss', 'dark', 7, 21),
      p.sign('abyss', 'block', 9, 7),
      p.sign('abyss', 'island', 22, 26),
      p.sign('abyss', 'bridge', 20, 30),
    ],
    decor: [
      // salle sombre : torches murales/au sol seulement près des épreuves (couloir du bloc, plaque, pont, îlot, porte)
      ...torchesAt(
        rows,
        [14, 3], // départ du couloir du bloc
        [14, 6],
        [30, 3],
        [43, 3], // plaque du bloc
        [45, 3],
        [43, 6],
        [66, 25], // porte du gouffre
        [67, 28],
      ),
      ...wallDecor(rows, 'banner', rect(68, 18, 10, 18), 4, 'north', 2),
      ...p.decor('torch', [23, 26], [23, 30], [34, 31], [39, 31]).decor('crystal', [3, 3], [3, 44], [64, 44], [69, 19], [76, 34]).decor('bones', [20, 40], [62, 12], [10, 30])
        .decor('statue', [16, 9], [16, 44], [65, 9], [65, 44]).decor('crate', [2, 2], [2, 45], [17, 45]).decors,
    ],
    exit: { rect: rect(72, 24, 5, 6), requires: ['abyssDoor'] },
    dark: true,
  };
})();

// ───────────────────────────── Salle 7 : L'Arène des Chevaliers ─────────────────────────────
//
// 86×52. Idée : COMBAT pur, cinq vagues. Le tocsin (levier près de l'arrivée, tirable par n'importe qui) déclenche l'assaut :
// tous les ennemis portent `when: 'bell'`. Vague 0 : squelettes et archers ; vague 1 : un chevalier + soutien ; vague 2 :
// araignées, chevaliers et feux follets ; vagues 3 et 4 : la garde d'élite. Piliers 2×2 en quinconce pour se couvrir sur ces
// 74×44 tuiles d'arène. Objectif slot 2 « slayer » : 3 coups fatals par le héros vert (à 1 joueur : plus de vingt ennemis,
// donc largement atteignable ; le nombre d'ennemis croît avec les joueurs).
// Résolution : tirer le levier [8,26] ; vaincre les 5 vagues (le héros vert doit porter 3 coups fatals) ; la sortie
// [80..82, 22..29] (au bout du goulot est) exige tocsin + arène nettoyée + objectif accompli.

const arena: RoomDef = (() => {
  const spawn: TileXY = [3, 24];
  const b = new LayoutBuilder(86, 52)
    .floor(2, 4, 74, 44) // arène x2..75, y4..47
    .floor(76, 22, 2, 8) // goulot de sortie
    .floor(78, 18, 6, 16) // alcôve de sortie x78..83, y18..33
    .pillar([20, 10], [20, 41], [32, 28], [58, 28], [48, 5], [48, 46]);
  // piliers 2×2 en quinconce (évitent l'arrivée, le tocsin et l'entrée du goulot)
  const keep = [rect(2, 18, 16, 16), rect(66, 16, 12, 20)];
  const rowsXs = [
    [16, 28, 40, 52, 64],
    [22, 34, 46, 58],
  ];
  [8, 19, 30, 41].forEach((y, r) => {
    for (const x of rowsXs[r % 2]) {
      const hit = keep.some((k) => x + 1 >= k.x && x < k.x + k.w && y + 1 >= k.y && y < k.y + k.h);
      if (!hit) b.pillarBlock(x, y);
    }
  });
  const rows = b.rows();
  const anchors: TileXY[] = [
    [30, 12],
    [44, 14],
    [58, 12],
    [70, 10],
    [36, 24],
    [50, 24],
    [64, 24],
    [30, 36],
    [44, 38],
    [58, 36],
    [70, 40],
    [24, 24],
    [56, 18],
    [56, 32],
    [40, 22],
    [40, 30],
    [70, 24],
    [26, 44],
    [26, 8],
    [62, 44],
    [62, 8],
  ];
  const waves: EnemyKind[][] = [
    ['skeleton', 'skeleton', 'archer', 'skeleton', 'bat', 'skeleton', 'archer'],
    ['skeleton', 'knight', 'archer', 'wisp', 'bat', 'archer', 'skeleton', 'bat'],
    ['spider', 'spider', 'knight', 'skeleton', 'wisp', 'archer', 'bat', 'spider', 'knight'],
    ['knight', 'wisp', 'archer', 'spider', 'skeleton', 'knight', 'bat', 'wisp', 'skeleton'],
    ['knight', 'knight', 'wisp', 'spider', 'archer', 'knight', 'wisp', 'spider', 'skeleton'],
  ];
  // braseros allumés aux lueurs rouges (ambiance) : l'arène n'est PAS sombre, mais on peut y recharger sa torche
  const p = new Placer(rows, spawn, [rect(6, 24, 5, 5), rect(74, 20, 4, 12)])
    .lit('arena', 'arenaFire1', 10, 10, 7)
    .lit('arena', 'arenaFire2', 10, 42, 7)
    .lit('arena', 'arenaFire3', 40, 6, 7)
    .lit('arena', 'arenaFire4', 40, 46, 7)
    .lit('arena', 'arenaFire5', 66, 10, 7)
    .lit('arena', 'arenaFire6', 66, 42, 7);
  waves.forEach((kinds, wave) => {
    kinds.forEach((kind, i) => {
      const [ax, ay] = anchors[(wave * 7 + i * 3) % anchors.length];
      p.foe(kind, ax, ay, wave === 0 ? { when: 'bell' } : { when: 'bell', wave });
    });
  });
  return {
    id: 'arena',
    ...roomKeys('arena'),
    theme: 'citadel',
    layout: rows,
    playerSpawns: spawns(...spawn),
    enemies: p.tiered(),
    mechanisms: [...p.fires, { id: 'bell', type: 'lever', tile: [8, 26], labelKey: mechLabel('arena', 'bell') }],
    signs: [p.sign('arena', 'bell', 6, 22), p.sign('arena', 'quota', 12, 24), p.sign('arena', 'waves', 12, 29)],
    decor: [
      ...wallDecor(rows, 'torch', rect(2, 4, 74, 44), 9),
      ...wallDecor(rows, 'torch', rect(2, 47, 74, 1), 9, 'south'),
      ...wallDecor(rows, 'banner', rect(2, 4, 74, 44), 12, 'north', 8),
      ...p.decor('statue', [2, 4], [2, 47], [75, 4], [75, 47]).decor('crystal', [79, 18], [82, 33], [3, 5], [3, 46])
        .decor('crate', [4, 40], [4, 8], [74, 5], [74, 46]).decor('bones', [40, 26], [24, 14], [60, 38], [50, 10]).decors,
    ],
    exit: { rect: rect(80, 22, 3, 8), requires: ['bell', 'clear', 'obj:slayer'] },
  };
})();

// ───────────────────────────── Salle 8 : Le Dais du Cristal ─────────────────────────────
//
// 80×48. Idée : PROTÉGER le porteur. Le héros ROUGE (slot 1, objectif « hold ») doit tenir le dais [44,23] (plaque ronde,
// zone 1×1, au centre du grand hall) pendant 10 s cumulées ; le héros BLEU (plaque du sceau [4,4], 2+ joueurs) garde le sceau,
// dans la chambre nord-ouest, à l'autre bout du château, pendant ce temps ; les autres protègent. Dès que le dais est foulé,
// une première vague d'assaillants surgit dans les halls et les ailes ; la seconde arrive quand la première est vaincue.
// La porte s'ouvre quand dais tenu 10 s + dais pressé + sceau pressé simultanément.
// Coop adaptative : sceau min 2 (waived en solo : le héros seul tient le dais et se défend, le temps est cumulé).
// Résolution : le héros rouge traverse le hall ouest et la liaison [26..29, 21..26], monte sur [44,23] et y reste 10 s
// (cumulées, il peut s'écarter pour parer) ; le héros bleu rejoint [4,4] par la liaison [8..10, 8..9] (2+ joueurs) ; quand
// l'objectif est accompli et que les deux plaques sont pressées, la porte [60..61, 23..24] s'ouvre ; battre la seconde
// vague (clear) puis tous à la sortie [72..75, 21..26] dans le hall est.

const dais: RoomDef = (() => {
  const spawn: TileXY = [4, 26];
  const b = new LayoutBuilder(80, 48)
    .floor(2, 10, 24, 28) // hall ouest x2..25, y10..37
    .floor(2, 2, 14, 6) // chambre du sceau x2..15, y2..7
    .floor(8, 8, 3, 2) // liaison (y8..9)
    .floor(26, 21, 4, 6) // liaison hall ouest → grand hall
    .floor(30, 12, 30, 24) // grand hall x30..59, y12..35
    .floor(28, 2, 34, 7) // aile nord x28..61, y2..8
    .floor(44, 9, 4, 3) // liaison aile nord
    .floor(28, 38, 34, 7) // aile sud x28..61, y38..44
    .floor(44, 36, 4, 2) // liaison aile sud
    .floor(60, 23, 2, 2) // passage de la porte
    .floor(62, 14, 16, 20) // hall est x62..77, y14..33
    .reserve(
      rect(2, 22, 8, 9), // arrivée
      rect(3, 3, 3, 3), // sceau
      rect(40, 19, 9, 9), // dais
      rect(56, 19, 6, 9), // approche de la porte
      rect(70, 18, 8, 12), // approche de la sortie
      rect(43, 8, 6, 5),
      rect(43, 35, 6, 4),
      rect(24, 20, 6, 8),
    )
    .pillarGrid(rect(4, 11, 20, 26), 5, 5, 2, 2)
    .pillarGrid(rect(32, 13, 26, 22), 5, 5, 1, 2)
    .pillarGrid(rect(30, 3, 30, 5), 6, 3, 1, 2)
    .pillarGrid(rect(30, 39, 30, 5), 6, 3, 1, 2)
    .pillarGrid(rect(64, 15, 12, 18), 5, 5, 1, 1);
  const rows = b.rows();
  const p = new Placer(rows, spawn, [rect(3, 3, 3, 3), rect(43, 22, 3, 3), rect(58, 21, 4, 5)]);
  const waveKinds: EnemyKind[][] = [
    ['wisp', 'knight', 'archer', 'wisp', 'bat', 'skeleton', 'bat', 'archer', 'skeleton', 'wisp', 'bat', 'skeleton', 'archer', 'skeleton', 'bat', 'wisp'],
    ['skeleton', 'spider', 'knight', 'skeleton', 'archer', 'spider', 'knight', 'bat', 'skeleton', 'archer', 'wisp', 'knight'],
  ];
  const anchors: TileXY[] = [
    [32, 14],
    [57, 14],
    [32, 33],
    [57, 33],
    [38, 24],
    [50, 24],
    [44, 14],
    [44, 33],
    [34, 5],
    [56, 5],
    [34, 41],
    [56, 41],
    [44, 4],
    [44, 42],
    [20, 14],
    [20, 34],
    [66, 18],
    [72, 30],
    [66, 30],
    [74, 16],
  ];
  waveKinds.forEach((kinds, wave) => {
    kinds.forEach((kind, i) => {
      const [ax, ay] = anchors[(wave * 5 + i) % anchors.length];
      p.foe(kind, ax, ay, wave === 0 ? { when: 'daisPlate' } : { wave });
    });
  });
  return {
    id: 'dais',
    ...roomKeys('dais'),
    theme: 'citadel',
    layout: rows,
    playerSpawns: spawns(...spawn),
    enemies: p.tiered(),
    mechanisms: [
      { id: 'daisPlate', type: 'plate', tile: [44, 23], colorSlot: 1, labelKey: mechLabel('dais', 'daisPlate') },
      { id: 'sealPlate', type: 'plate', tile: [4, 4], colorSlot: 0, minPlayers: 2, labelKey: mechLabel('dais', 'sealPlate') },
      {
        id: 'daisDoor',
        type: 'door',
        tiles: doorTiles(60, 23),
        requires: ['daisPlate', 'sealPlate', 'obj:hold'],
        labelKey: mechLabel('dais', 'daisDoor'),
      },
    ],
    zones: [{ id: 'holdZone', rect: rect(44, 23, 1, 1) }],
    signs: [p.sign('dais', 'hold', 38, 23), p.sign('dais', 'seal', 7, 11), p.sign('dais', 'wings', 12, 24)],
    decor: [
      ...wallDecor(rows, 'torch', rect(30, 12, 30, 24), 7),
      ...wallDecor(rows, 'torch', rect(2, 10, 24, 28), 8),
      ...wallDecor(rows, 'torch', rect(62, 14, 16, 20), 7),
      ...wallDecor(rows, 'banner', rect(28, 2, 34, 7), 10, 'north', 4),
      ...p.decor('crystal', [43, 22], [45, 22], [43, 24], [45, 24], [3, 3], [14, 6], [77, 14], [77, 33])
        .decor('statue', [30, 12], [59, 12], [30, 35], [59, 35], [2, 10], [2, 37])
        .decor('bones', [14, 26], [52, 30], [68, 26]).decor('crate', [28, 2], [61, 2], [28, 44], [61, 44]).decors,
    ],
    exit: { rect: rect(72, 21, 4, 6), requires: ['daisDoor', 'clear'] },
  };
})();

// ───────────────────────────── Salle 9 : Le Trône de Morvane ─────────────────────────────
//
// 56×42. Salle de boss PURE (aucun mécanisme) : grande arène avec piliers 2×2 de couverture (arrêtent les projectiles) et une
// alcôve au nord qui contient la sortie finale, SCELLÉE : elle exige Morvane vaincu (`clear`) et les quatre objectifs
// personnels. Si un objectif manquait (impossible par construction, chaque salle porteuse verrouille sa sortie),
// la sortie resterait scellée. Morvane (kind 'morvane', 3 phases) apparaît à l'est ; les héros arrivent à l'ouest.
// Résolution : se couvrir derrière les piliers, vaincre Morvane (invocations possibles) ; la sortie [24..31, 1..2]
// s'ouvre, tous s'y rejoignent ; le Cristal est reconstitué.

const throne: RoomDef = (() => {
  const b = new LayoutBuilder(56, 42)
    .floor(1, 3, 54, 38) // arène x1..54, y3..40
    .floor(24, 1, 8, 2) // alcôve de la sortie finale
    .pillarBlock(10, 8)
    .pillarBlock(10, 30)
    .pillarBlock(18, 19)
    .pillarBlock(26, 11)
    .pillarBlock(26, 27)
    .pillarBlock(36, 19)
    .pillarBlock(44, 8)
    .pillarBlock(44, 30)
    .pillar([16, 6], [16, 35], [38, 6], [38, 35], [30, 19], [30, 21]);
  const rows = b.rows();
  const p = new Placer(rows, [4, 21], [], 0);
  return {
    id: 'throne',
    ...roomKeys('throne'),
    theme: 'citadel',
    layout: rows,
    playerSpawns: spawns(3, 20),
    enemies: [{ kind: 'morvane', tile: [47, 21] }],
    mechanisms: [],
    signs: [p.sign('throne', 'warning', 6, 17)],
    decor: [
      ...wallDecor(rows, 'torch', rect(1, 3, 54, 38), 8),
      ...wallDecor(rows, 'torch', rect(1, 40, 54, 1), 8, 'south'),
      ...wallDecor(rows, 'banner', rect(1, 3, 54, 38), 12, 'north', 5),
      ...p.decor('statue', [2, 4], [53, 4], [2, 39], [53, 39]).decor('crystal', [24, 1], [31, 1], [27, 3], [28, 3])
        .decor('bones', [14, 24], [34, 14], [40, 26]).decors,
    ],
    // Cristaux de soin (sources de vie fixes, usage unique, 50 PV) : loin des arrivées et du départ du boss ; le 3e exige 3 joueurs.
    healCrystals: [
      { id: 'throne_heal1', tile: [16, 9] },
      { id: 'throne_heal2', tile: [16, 32] },
      { id: 'throne_heal3', tile: [27, 37], minPlayers: 3 },
    ],
    exit: {
      rect: rect(24, 1, 8, 2),
      requires: ['clear', 'obj:seal', 'obj:hold', 'obj:slayer', 'obj:lever'],
      final: true,
      sealed: true,
    },
  };
})();

// ───────────────────────────── Dialogues et objectifs ─────────────────────────────

const intro: DialogueLine[] = [
  { speaker: 'narrator', textKey: 'level.level3.intro.1' },
  { speaker: 'lyssa', textKey: 'level.level3.intro.2' },
  { speaker: 'aldric', textKey: 'level.level3.intro.3' },
  { speaker: 'morvane', textKey: 'level.level3.intro.4' },
  { speaker: 'heroes', textKey: 'level.level3.intro.5' },
];

const outro: DialogueLine[] = [
  { speaker: 'narrator', textKey: 'level.level3.outro.1' },
  { speaker: 'lyssa', textKey: 'level.level3.outro.2' },
  { speaker: 'narrator', textKey: 'level.level3.outro.3' },
  { speaker: 'lyssa', textKey: 'level.level3.outro.4' },
];

const objectives: ObjectiveDef[] = [
  { id: 'seal', slot: 0, roomId: 'seals', kind: 'mechanism', mechanismId: 'doorBlue', labelKey: 'objective.level3.seal' },
  { id: 'hold', slot: 1, roomId: 'dais', kind: 'zone', zoneId: 'holdZone', seconds: 10, labelKey: 'objective.level3.hold' },
  { id: 'slayer', slot: 2, roomId: 'arena', kind: 'kills', count: 3, labelKey: 'objective.level3.slayer' },
  { id: 'lever', slot: 3, roomId: 'balconies', kind: 'mechanism', mechanismId: 'leverYellow', labelKey: 'objective.level3.lever' },
];

/**
 * Niveau 3 — La Citadelle de Morvane. Données pures (aucune logique) : voir l'en-tête du fichier pour la
 * structure, le rythme, la coop adaptative et les objectifs.
 */
export const level3: LevelDef = {
  id: 'level3',
  nameKey: 'level.level3.name',
  theme: 'citadel',
  estimatedMinutes: 10,
  intro,
  outro,
  rooms: [gate, seals, forge, sanctum, balconies, abyss, arena, dais, throne],
  objectives,
};
