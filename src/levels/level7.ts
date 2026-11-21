/**
 * Niveau 7 — « Le Carillon Englouti » (thème `tide`, 8 salles, ≈ 9 minutes simulées par les bots, 9 annoncées).
 *
 * Le fragment manquant n'est pas perdu : il a été NOYÉ. Les héros plongent dans une cité engloutie aux eaux nacrées. Aucun nouveau type de
 * mécanisme : le niveau RECOMBINE les types connus autour de deux signatures coopératives inédites :
 *  - « PHARE ET ÉCHO » (salle `mirrorpools`) : INFORMATION ASYMÉTRIQUE + lanterne portée par un autre joueur. La séquence de runes n'est
 *    visible que par le héros ROUGE (slot 1), sur la rive de départ ; les piédestaux sont sur une île que l'on n'atteint QUE par un pont
 *    de lumière dont le porteur est le héros BLEU (slot 0). L'écran et les piédestaux sont si éloignés qu'on ne les voit jamais ensemble :
 *    le héros rouge doit ANNONCER la séquence à voix haute (en solo : la lire, la retenir, traverser, la jouer) ;
 *  - « CHŒUR » (salle `choir`) : quatre leviers de couleur à fenêtre aux quatre coins d'un anneau de piliers, à tirer « presque
 *    ensemble » pour ouvrir la porte du sanctuaire central, au milieu de trois vagues d'embuscade.
 *
 * Rythme :
 *  1. `shoal`       Les Hauts-Fonds        quatre plaques de couleur autour d'une porte, bassins (abîmes) retenant les marcheurs
 *  2. `pearlcave`   La Grotte des Perles   salle sombre : chacun allume SON brasero (porte), le héros rouge veille 20 s dans la perle
 *  3. `dyke`        La Digue du Gardien    DEMI-BOSS n°1 (gardien `warden`), salle pure
 *  4. `mirrorpools` Les Bassins-Miroirs    « Phare et Écho » : runes lues par le héros rouge, île atteinte par le pont du héros bleu
 *  5. `sluice`      L'Écluse               bloc 2×2 poussé jusqu'au socle (couloir fermé), deux plaques tenues sous le nez des gardiens
 *  6. `choir`       Le Chœur de Nacre      « Chœur » : trois vagues, puis quatre leviers à fenêtre, porte centrale
 *  7. `stormdeck`   Le Pont des Tempêtes   DEMI-BOSS n°2 (spectre `wraith`, volant), salle pure
 *  8. `glassheart`  Le Cœur de Verre       BOSS FINAL du niveau : l'écho de Morvane (`morvane`, 3 phases), salle pure, sortie scellée
 *
 * Toutes les salles font de 60 à 86 tuiles de large et de 44 à 52 de haut (la caméra défile). Les arènes de demi-boss et de boss sont des
 * salles PURES : ni mécanisme, ni abîme, ni herse, ni pont (les boss se téléportent dans toute la salle ; les volants ne doivent jamais
 * rester hors de portée). Les salles à abîmes (`~`) ne contiennent que des ennemis TERRESTRES.
 *
 * Coop adaptative (1 à 4 joueurs) : plaques / leviers / braseros de couleur à `minPlayers = slot + 1` ; ennemis : leur nombre ne dépend QUE
 * du nombre de joueurs (`minPlayers`, ≈ 56 % des ennemis dès 1 joueur : 174 / 195 / 265 / 312 à 1 / 2 / 3 / 4 joueurs), jamais de la
 * difficulté ; les demi-boss et le boss sont présents à tous les nombres de joueurs, leurs sbires suivent les joueurs. Les créatures les plus
 * dangereuses pour un petit groupe sont réservées aux groupes plus grands (chevaliers à 3-4 joueurs, archers et feux follets à 2+) : la
 * composition suit le nombre de joueurs, comme leur nombre. Les PV se conservent d'une salle à l'autre (seule une défaite ou un relevage les
 * remet à plein) : les salles d'embuscade et de boss sont donc allégées à 1 joueur. Aucun ennemi à moins de 12 tuiles de l'arrivée. Aucune tactique de boss
 * (`tactics`) dans ce niveau : elles sont réservées au niveau 8.
 *
 * Objectifs personnels (un par slot, types variés, répartis sur quatre salles) :
 *  - slot 0 (bleu)   `chime` : mécanisme — ouvrir la porte du chœur (Chœur de Nacre) ;
 *  - slot 1 (rouge)  `pearl` : zone — veiller 20 s dans la perle (Grotte des Perles) ;
 *  - slot 2 (vert)   `bones` : kills — 3 squelettes vaincus aux Hauts-Fonds ;
 *  - slot 3 (jaune)  `echo`  : mécanisme — jouer la séquence des runes (Bassins-Miroirs).
 *
 * Toutes les chaînes affichées sont des clés i18n (parts `src/i18n/parts/level7.{fr,en}.json`).
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

/** Thème visuel du niveau (un seul endroit à changer : repli `frost` si le thème `tide` venait à manquer). */
const THEME: ZoneTheme = 'tide';

// ───────────────────────────── Aides de construction ─────────────────────────────

/** Raccourci pour un rectangle de tuiles. */
function rect(x: number, y: number, w: number, h: number): TileRect {
  return { x, y, w, h };
}

/** Constructeur de grille : on part d'un plein de murs et on creuse des plates-formes, des abîmes et des ponts. Déterministe. */
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

  /** Mur plein (enceinte intérieure). */
  wall(x: number, y: number, w: number, h: number): this {
    return this.paint(x, y, w, h, '#');
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
      if (px !== x && py !== y) throw new Error(`level7 : segment de pont en diagonale [${px},${py}] → [${x},${y}]`);
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
 * Cycle de paliers `minPlayers` : 80 % des ennemis dès 1 joueur, 85 % à 2 (un palier « 2 » : le duo ne rencontre pas la même population que le solo ; mais il reste le cas le plus lent des bots), 90 % à 3, 100 % à 4 (salles ordinaires sans embuscade : les ennemis y sont attirés un à un, peu de dégâts par ennemi ;
 * les salles d'embuscade, de demi-boss et de boss sont, elles, allégées pour un joueur seul).
 * Le nombre d'ennemis suit les JOUEURS, jamais la difficulté.
 */
const TIERS = [1, 1, 1, 1, 2, 1, 1, 1, 1, 4, 1, 1, 1, 3, 1, 1, 1, 4, 1, 1] as const;

/**
 * Cycle « moyen » pour les salles d'embuscade (îles, vagues) : 60 % des ennemis dès 1 joueur, 65 % à 2, 85 % à 3, 100 % à 4. Toujours fonction du
 * Cycle « moyen » pour les salles d'embuscade (îles, vagues) : 60 % des ennemis dès 1 joueur, 60 % à 2, 85 % à 3, 100 % à 4. Toujours fonction du
 */
const TIERS_MID = [1, 1, 2, 1, 1, 3, 1, 1, 4, 1, 2, 1, 3, 1, 1, 4, 1, 3, 1, 4] as const;

/** Rectangle (2r+1)² autour d'une tuile : interdit aux ennemis et aux décors (extrémités de pont, mécanismes). */
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
    throw new Error(`level7 : aucune tuile libre près de [${x},${y}]`);
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
    if (cands.length < count) throw new Error(`level7 : zone [${area.x},${area.y},${area.w},${area.h}] : ${cands.length} tuiles libres pour ${count} ennemis`);
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
    extra: { ownerSlot?: number; minPlayers?: number; lightRadiusTiles?: number; litLabel?: string } = {},
  ): this {
    // `litLabel` : suffixe de la clé du libellé « allumé » (défaut `fire` : celui des braseros de recharge de la salle)
    const { litLabel = 'fire', ...rest } = extra;
    this.fires.push({
      id,
      type: 'brazier',
      tile: this.snap(x, y, false),
      labelKey: mechLabel(room, label),
      litLabelKey: mechLabel(room, litLabel),
      ...rest,
    });
    return this;
  }

  /** Panneau de salle (`sign.level7.<roomId>.<name>`). */
  sign(room: string, name: string, x: number, y: number): SignDef {
    return { id: `${room}.${name}`, tile: this.snap(x, y, false), textKey: `sign.level7.${room}.${name}` };
  }

  /**
   * Ennemis finaux : les paliers `minPlayers` non précisés suivent le cycle `cycle` (défaut `TIERS`). Les créatures les plus dangereuses pour un
   * petit groupe sont réservées aux groupes plus grands : les chevaliers n'apparaissent qu'à 3-4 joueurs, les archers et feux follets qu'à 2+.
   * Le nombre d'ennemis ne dépend toujours QUE du nombre de joueurs.
   */
  tiered(cycle: readonly number[] = TIERS): EnemySpawnDef[] {
    let i = 0;
    let knights = 0;
    return this.enemies.map((e) => {
      if (e.minPlayers !== undefined || isAnyBossKind(e.kind)) return e; // demi-boss et boss : présents à tous les nombres de joueurs
      let tier = cycle[i++ % cycle.length];
      if (e.kind === 'knight') tier = knights++ % 2 === 0 ? 3 : 4;
      else if ((e.kind === 'wisp' || e.kind === 'archer') && tier < 2) tier = 2;
      return tier === 1 ? e : { ...e, minPlayers: tier };
    });
  }

  /**
   * Ennemis finaux avec des effectifs EXACTS par nombre de joueurs (`counts` = sbires présents à 1, 2, 3 et 4 joueurs) : les paliers sont
   * répartis dans la salle par un pas premier avec l'effectif (pas de côté « vide » d'un seul nombre de joueurs), les chevaliers prenant
   * les paliers les plus hauts, puis les archers et feux follets. Le demi-boss/boss, lui, n'a jamais de `minPlayers`.
   */
  tieredTo(counts: readonly [number, number, number, number]): EnemySpawnDef[] {
    const minions = this.enemies.filter((e) => e.minPlayers === undefined && !isAnyBossKind(e.kind));
    if (minions.length !== counts[3]) throw new Error(`level7 : ${minions.length} sbires posés pour un effectif de ${counts[3]} à 4 joueurs`);
    const pool: number[] = [];
    for (let n = 1; n <= 4; n++) for (let k = 0; k < counts[n - 1] - (n > 1 ? counts[n - 2] : 0); k++) pool.push(n);
    pool.sort((x, y) => y - x); // paliers décroissants : les plus dangereux prennent les premiers
    const rank = (k: EnemyKind): number => (k === 'knight' ? 0 : k === 'wisp' || k === 'archer' ? 1 : 2);
    const order = minions.map((e, idx) => ({ e, idx })).sort((x, y) => rank(x.e.kind) - rank(y.e.kind) || x.idx - y.idx);
    const dangerous = order.filter((o) => rank(o.e.kind) < 2);
    const tierOf = new Map<EnemySpawnDef, number>();
    dangerous.forEach((o, k) => tierOf.set(o.e, pool[k]));
    const rest = pool.slice(dangerous.length).reverse(); // croissant
    const calm = order.filter((o) => rank(o.e.kind) === 2).sort((x, y) => x.idx - y.idx);
    const m = rest.length;
    let stride = Math.max(1, Math.round(m * 0.618));
    const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
    while (gcd(stride, m) !== 1) stride++;
    calm.forEach((o, j) => tierOf.set(o.e, rest[(j * stride) % m]));
    return this.enemies.map((e) => {
      const tier = tierOf.get(e);
      return tier === undefined || tier === 1 ? e : { ...e, minPlayers: tier };
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
    if (rows[y]?.[x] === undefined) throw new Error(`level7 : torche hors grille [${x},${y}]`);
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

/** Clé d'étiquette de mécanisme : `mech.level7.<roomId>.<mechanismId>`. */
function mechLabel(room: string, mechanismId: string): string {
  return `mech.level7.${room}.${mechanismId}`;
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

/** Nom, indice d'arrivée : clés `room.level7.<id>.name` et `hintroom.level7.<id>`. */
function roomKeys(id: string): { nameKey: string; introHintKey: string } {
  return { nameKey: `room.level7.${id}.name`, introHintKey: `hintroom.level7.${id}` };
}

/**
 * Types d'ennemis des salles à abîme : uniquement des créatures TERRESTRES (pas de chauves-souris ni de feux follets, qui pourraient rester
 * suspendus au-dessus du vide, hors de portée, et empêcher le « clear »). Les volants sont réservés aux salles sans abîme.
 */
const GROUND: readonly EnemyKind[] = ['slime', 'skeleton', 'spider', 'slime', 'skeleton', 'spider'];
const GROUND_TOUGH: readonly EnemyKind[] = ['skeleton', 'spider', 'slime', 'skeleton', 'slime', 'spider', 'knight'];
/** Créatures des salles sans abîme (les chevaliers n'apparaissent qu'à 3-4 joueurs, voir `Placer.tiered`). */
const ANY: readonly EnemyKind[] = ['slime', 'skeleton', 'slime', 'bat', 'spider', 'slime', 'bat', 'knight'];

// ───────────────────────────── Salle 1 : Les Hauts-Fonds ─────────────────────────────
//
// 60×44. Idée : APPRENDRE les plaques de couleur, calmement. Une grande plage nacrée [2..51, 4..39] semée de bassins (abîmes) retenant les
// marcheurs ; quatre plaques de couleur autour de la porte [52..53, 21..22] qui garde la chambre de sortie. Des limons, squelettes et
// araignées (créatures terrestres : les bassins sont des abîmes) rôdent sur la plage.
// Résolution : vaincre les rôdeurs (le héros vert doit porter 3 coups fatals à des squelettes) ; chacun tient SA plaque — bleue [47,14],
// rouge [47,30], verte [41,22], jaune [47,22] — la porte s'ouvre ; sortie [55..57, 18..25].

const shoal: RoomDef = (() => {
  const spawn: TileXY = [4, 22];
  const plates: Record<string, TileXY> = { Blue: [47, 14], Red: [47, 30], Green: [41, 22], Yellow: [47, 22] };
  const plateAreas = Object.values(plates).map((t) => around(t));
  const b = new LayoutBuilder(60, 44)
    .floor(2, 4, 50, 36)
    .floor(52, 21, 2, 2)
    .floor(54, 17, 5, 10)
    .pit(10, 8, 8, 5)
    .pit(24, 13, 7, 6)
    .pit(10, 31, 9, 5)
    .pit(34, 7, 8, 5)
    .pit(30, 28, 8, 6)
    .pit(42, 16, 5, 5)
    .pit(40, 34, 7, 4)
    .reserve(rect(2, 18, 9, 9), ...plateAreas, rect(48, 18, 4, 8))
    .pillarGrid(rect(4, 5, 46, 34), 6, 6, 3, 2);
  const rows = b.rows();
  const p = new Placer(rows, spawn, [...plateAreas, rect(50, 17, 9, 10)]).fill(rect(14, 5, 38, 34), GROUND, 32);
  const mechanisms: MechanismDef[] = [];
  COLORS.forEach((color, slot) => {
    const base = {
      id: `shoalPlate${color}`,
      type: 'plate' as const,
      tile: plates[color],
      colorSlot: slot,
      labelKey: mechLabel('shoal', `shoalPlate${color}`),
    };
    mechanisms.push(slot === 0 ? base : { ...base, minPlayers: slot + 1 });
  });
  mechanisms.push({
    id: 'shoalDoor',
    type: 'door',
    tiles: doorTiles(52, 21),
    requires: COLORS.map((c) => `shoalPlate${c}`),
    labelKey: mechLabel('shoal', 'shoalDoor'),
  });
  return {
    id: 'shoal',
    ...roomKeys('shoal'),
    theme: THEME,
    layout: rows,
    playerSpawns: spawns(...spawn),
    enemies: p.tiered(),
    mechanisms,
    signs: [p.sign('shoal', 'plates', 8, 22), p.sign('shoal', 'basins', 12, 17), p.sign('shoal', 'bones', 9, 28)],
    decor: [
      ...wallDecor(rows, 'torch', rect(2, 4, 50, 36), 8),
      ...wallDecor(rows, 'banner', rect(2, 4, 50, 36), 12, 'north', 6),
      ...p.decor('crystal', [3, 5], [50, 5], [3, 38], [50, 38], [56, 18], [58, 25]).decor('statue', [3, 20], [3, 25], [50, 20])
        .decor('bones', [20, 24], [36, 22], [44, 33]).decor('plant', [6, 6], [6, 37], [26, 8]).decors,
    ],
    exit: { rect: rect(55, 18, 3, 8), requires: ['shoalDoor', 'clear'] },
  };
})();

// ───────────────────────────── Salle 2 : La Grotte des Perles ─────────────────────────────
//
// 66×46, SOMBRE. Idée : l'ALLUMAGE et la VEILLE. Une grande grotte [2..49, 6..39] éclairée seulement par quelques braseros ; quatre braseros de
// couleur ÉTEINTS (un par héros, ownerSlot 0..3, minPlayers = slot + 1) dans les coins : la porte [50..51, 22..23] exige les quatre. Au centre,
// la perle (zone [21..27, 19..25]) : le héros rouge doit y veiller 20 s cumulées (objectif « pearl », exigé par la sortie).
// Une torche s'use : des braseros allumés rechargent (un au départ, un près de la perle, un par quadrant, un devant la porte).
// Résolution : vaincre les habitants ; recharger sa torche au besoin ; chacun allume SON brasero — bleu [15,10], rouge [40,10], vert [15,35],
// jaune [40,35] — la porte s'ouvre ; le héros rouge veille 20 s dans la perle ; sortie [58..62, 19..26].

const pearlcave: RoomDef = (() => {
  const spawn: TileXY = [4, 22];
  const pearl = rect(21, 19, 7, 7);
  const colorTiles: TileXY[] = [
    [15, 10],
    [40, 10],
    [15, 35],
    [40, 35],
  ];
  const b = new LayoutBuilder(66, 46)
    .floor(2, 6, 48, 34)
    .floor(50, 22, 2, 2)
    .floor(52, 16, 12, 14)
    .reserve(rect(2, 18, 9, 9), pearl, ...colorTiles.map((t) => around(t, 3)), rect(46, 18, 6, 10));
  [
    [10, 14],
    [10, 30],
    [20, 10],
    [20, 34],
    [30, 13],
    [30, 31],
    [34, 20],
    [34, 25],
    [45, 9],
    [45, 35],
    [45, 14],
    [45, 30],
  ].forEach(([x, y]) => b.pillarBlock(x, y));
  b.pillar([16, 18], [16, 27], [29, 22], [38, 22]);
  const rows = b.rows();
  // Les braseros (allumés et de couleur) se posent AVANT toute zone interdite : leurs tuiles sont celles du commentaire d'en-tête (la liste `avoid` est remplie ensuite, pour les ennemis, décors et panneaux).
  const p = new Placer(rows, spawn, [])
    // braseros allumés (recharge) : départ, perle, quadrants, devant la porte, chambre de sortie
    .lit('pearlcave', 'pearlFire1', 8, 19)
    .lit('pearlcave', 'pearlFire2', 24, 16)
    .lit('pearlcave', 'pearlFire3', 24, 29)
    .lit('pearlcave', 'pearlFire4', 36, 15)
    .lit('pearlcave', 'pearlFire5', 36, 30)
    .lit('pearlcave', 'pearlFire6', 47, 22)
    .lit('pearlcave', 'pearlFire7', 56, 22);
  COLORS.forEach((color, slot) => {
    p.unlit('pearlcave', `pearlBrazier${color}`, `pearlBrazier${color}`, colorTiles[slot][0], colorTiles[slot][1], {
      litLabel: `pearlBrazier${color}Lit`,
      ownerSlot: slot,
      lightRadiusTiles: 4,
      ...(slot === 0 ? {} : { minPlayers: slot + 1 }),
    });
  });
  p.forbid(...colorTiles.map((t) => around(t, 2)), rect(19, 17, 11, 11), rect(46, 18, 6, 10)).fill(rect(18, 7, 32, 32), ['bat', 'slime', 'spider', 'skeleton'], 38);
  const mechanisms: MechanismDef[] = [...p.fires];
  mechanisms.push({
    id: 'pearlDoor',
    type: 'door',
    tiles: doorTiles(50, 22),
    requires: COLORS.map((c) => `pearlBrazier${c}`),
    labelKey: mechLabel('pearlcave', 'pearlDoor'),
  });
  return {
    id: 'pearlcave',
    ...roomKeys('pearlcave'),
    theme: THEME,
    layout: rows,
    playerSpawns: spawns(...spawn),
    enemies: p.tiered(TIERS_MID),
    mechanisms,
    zones: [{ id: 'pearlZone', rect: pearl }],
    signs: [p.sign('pearlcave', 'dark', 7, 22), p.sign('pearlcave', 'pearl', 19, 22), p.sign('pearlcave', 'braziers', 33, 22)],
    decor: [
      ...torchesAt(rows, [3, 22], [3, 24], [21, 22], [27, 22], [24, 19], [24, 25], [50, 21], [50, 24], [56, 17], [56, 28]),
      // la perle : un grand cristal au centre de la zone
      { type: 'crystal' as const, tile: [24, 22] as TileXY },
      ...p.decor('crystal', [4, 7], [48, 7], [4, 38], [48, 38], [62, 17], [62, 28]).decor('statue', [12, 22], [46, 22]).decor('plant', [13, 12], [13, 33], [42, 12], [42, 33])
        .decor('bones', [24, 12], [26, 33]).decors,
    ],
    exit: { rect: rect(58, 19, 5, 8), requires: ['pearlDoor', 'obj:pearl', 'clear'] },
    dark: true,
  };
})();

// ───────────────────────────── Salle 3 : La Digue du Gardien (demi-boss n°1) ─────────────────────────────
//
// 60×44. Idée : DEMI-BOSS n°1 sur une digue de pierre nacrée. Salle pure : le gardien (`warden`, mêlée lourde, coup de sol, charge ; présent à
// tous les nombres de joueurs) et ses sbires (12 à 1 joueur, 27 à 4), des piliers épars pour se couvrir. Sortie : le gardien vaincu (`clear`).
// Résolution : se couvrir, user le gardien (spécial recommandé) ; sortie [53..56, 19..24].

const dyke: RoomDef = (() => {
  const spawn: TileXY = [4, 22];
  const b = new LayoutBuilder(60, 44).floor(2, 4, 50, 36).floor(52, 18, 6, 8);
  [
    [12, 10],
    [12, 32],
    [26, 15],
    [26, 27],
    [32, 9],
    [32, 33],
    [32, 21],
    [43, 14],
    [43, 28],
    [47, 9],
    [47, 33],
  ].forEach(([x, y]) => b.pillarBlock(x, y));
  b.pillar([18, 22], [38, 11], [38, 31], [22, 6]);
  const rows = b.rows();
  const crystals = [
    { id: 'dyke_heal1', tile: [20, 8] as TileXY },
    { id: 'dyke_heal2', tile: [20, 36] as TileXY },
    { id: 'dyke_heal3', tile: [21, 22] as TileXY, minPlayers: 3 },
  ];
  const p = new Placer(rows, spawn, [rect(50, 17, 8, 10), ...crystals.map((c) => around(c.tile, 1))])
    .foe('warden', 40, 22)
    .fill(rect(16, 5, 35, 34), ['skeleton', 'slime', 'spider', 'skeleton', 'slime', 'spider', 'skeleton', 'knight'], 27);
  return {
    id: 'dyke',
    ...roomKeys('dyke'),
    theme: THEME,
    layout: rows,
    playerSpawns: spawns(...spawn),
    enemies: p.tieredTo([12, 18, 23, 27]),
    mechanisms: [],
    signs: [p.sign('dyke', 'warden', 8, 22), p.sign('dyke', 'cover', 10, 16)],
    decor: [
      ...wallDecor(rows, 'torch', rect(2, 4, 50, 36), 8),
      ...wallDecor(rows, 'banner', rect(2, 4, 50, 36), 12, 'north', 6),
      ...p.decor('crystal', [3, 5], [50, 5], [3, 38], [50, 38], [54, 19], [56, 24]).decor('statue', [3, 20], [3, 25], [50, 20], [50, 24])
        .decor('bones', [16, 14], [30, 26], [44, 20]).decor('plant', [8, 6], [8, 37]).decors,
    ],
    // Cristaux de soin (sources de vie fixes, usage unique, 50 PV) : loin des arrivées et du départ du demi-boss ; le 3e exige 3 joueurs.
    healCrystals: crystals,
    exit: { rect: rect(53, 19, 4, 6), requires: ['clear'] },
  };
})();

// ───────────────────────────── Salle 4 : Les Bassins-Miroirs — « Phare et Écho » ─────────────────────────────
//
// 72×48. Idée : INFORMATION ASYMÉTRIQUE + LANTERNE. La séquence de 4 runes ne s'affiche que pour le héros ROUGE (slot 1), sur l'écran [8,10] de la
// rive ouest. Les cinq piédestaux sont sur une île [38..55, 10..37] atteinte UNIQUEMENT par le pont de lumière [26..37] (porteur : le héros BLEU,
// slot 0) : l'écran et les piédestaux sont à ≈ 40 tuiles l'un de l'autre, on ne les voit jamais ensemble. Le héros rouge annonce la séquence ;
// en solo, on la lit, on la retient, on traverse, on la joue (une erreur remet à zéro, sans pénalité). La séquence jouée ouvre la porte
// [56..57, 22..23] vers la rive est (sortie). Rives en embuscade : l'île (zone x43..55) puis la rive est (zone entière), jamais à < 6 tuiles
// de l'atterrissage [37,32] ; les deux zones coupent entièrement leur rive (aucune embuscade ne se contourne).
// Résolution : vaincre les rôdeurs de la rive ouest ; le héros rouge lit [vague, œil, étoile, lune] sur l'écran ; le héros bleu guide le pont,
// les autres le suivent ; l'embuscade de l'île ; piédestaux dans l'ordre ; la porte s'ouvre ; embuscade de la rive est ; sortie [64..68, 19..28].

const mirrorpools: RoomDef = (() => {
  const spawn: TileXY = [4, 24];
  const pedestals: { symbol: string; tile: TileXY }[] = [
    { symbol: 'wave', tile: [44, 13] },
    { symbol: 'star', tile: [52, 13] },
    { symbol: 'eye', tile: [46, 24] },
    { symbol: 'moon', tile: [52, 34] },
    { symbol: 'sun', tile: [44, 34] },
  ];
  const b = new LayoutBuilder(72, 48)
    .pit(26, 2, 12, 44)
    .floor(2, 6, 24, 36)
    .floor(38, 10, 18, 28)
    .floor(56, 22, 2, 2)
    .floor(58, 14, 12, 20)
    // bassins-miroirs décoratifs (abîmes) : rive ouest, île, rive est
    .pit(8, 32, 7, 5)
    .pit(14, 12, 6, 3)
    .pit(48, 18, 5, 3)
    .pit(40, 20, 3, 4)
    .pit(62, 16, 4, 3);
  const bridge = b.bridge([26, 24], [31, 24], [31, 32], [37, 32]);
  const landing = bridge[bridge.length - 1];
  b.reserve(
    rect(2, 20, 9, 9),
    rect(5, 8, 6, 5),
    around(bridge[0], 3),
    rect(20, 20, 6, 9),
    rect(38, 28, 6, 8),
    rect(53, 19, 5, 8),
    ...pedestals.map((x) => around(x.tile, 1)),
  )
    .pillarGrid(rect(4, 7, 20, 34), 6, 6, 2, 2)
    .pillarGrid(rect(39, 11, 16, 26), 6, 6, 3, 2)
    .pillarGrid(rect(59, 15, 10, 18), 5, 5, 2, 2);
  const rows = b.rows();
  const p = new Placer(rows, spawn, [around(bridge[0], 3), around(landing, 2), rect(53, 19, 5, 8), ...pedestals.map((x) => around(x.tile, 1))])
    // rive ouest : les rôdeurs sont à vaincre AVANT de traverser (aucun ennemi n'attaque pendant une traversée)
    .fill(rect(18, 7, 8, 34), GROUND, 16)
    // île : embuscade, à ≥ 6 tuiles de l'atterrissage
    .ambush(landing, 'islandZone', rect(43, 10, 13, 28), GROUND, 16)
    // rive est : embuscade sur toute la rive
    .forbid(rect(56, 17, 6, 10))
    .fill(rect(60, 15, 10, 18), GROUND, 16, { when: 'enter:eastZone' });
  return {
    id: 'mirrorpools',
    ...roomKeys('mirrorpools'),
    theme: THEME,
    layout: rows,
    playerSpawns: spawns(...spawn),
    enemies: p.tiered(TIERS_MID),
    mechanisms: [
      {
        id: 'mirrorBridge',
        type: 'lightBridge',
        tiles: bridge,
        lanternSlot: 0,
        radiusTiles: 3,
        labelKey: mechLabel('mirrorpools', 'mirrorBridge'),
      },
      {
        id: 'mirrorRunes',
        type: 'runePuzzle',
        displayTile: [8, 10],
        visibleToSlot: 1,
        sequence: ['wave', 'eye', 'star', 'moon'],
        pedestals,
        labelKey: mechLabel('mirrorpools', 'mirrorRunes'),
      },
      {
        id: 'mirrorDoor',
        type: 'door',
        tiles: doorTiles(56, 22),
        requires: ['mirrorRunes'],
        labelKey: mechLabel('mirrorpools', 'mirrorDoor'),
      },
    ],
    zones: [
      { id: 'islandZone', rect: rect(43, 10, 13, 28) },
      { id: 'eastZone', rect: rect(58, 14, 12, 20) },
    ],
    signs: [
      p.sign('mirrorpools', 'reader', 7, 14),
      p.sign('mirrorpools', 'bridge', 22, 22),
      p.sign('mirrorpools', 'pedestals', 40, 28),
      p.sign('mirrorpools', 'east', 54, 22),
    ],
    decor: [
      ...wallDecor(rows, 'torch', rect(2, 6, 24, 36), 7),
      ...wallDecor(rows, 'torch', rect(38, 10, 18, 28), 8),
      ...wallDecor(rows, 'torch', rect(58, 14, 12, 20), 6),
      ...p.decor('crystal', [3, 7], [24, 7], [3, 40], [24, 40], [39, 11], [54, 36], [69, 15], [69, 32]).decor('statue', [7, 8], [10, 8], [44, 24], [58, 18])
        .decor('bones', [14, 28], [40, 16], [64, 28]).decor('plant', [4, 34], [18, 16], [50, 22]).decors,
    ],
    exit: { rect: rect(64, 19, 5, 10), requires: ['mirrorDoor', 'clear'] },
  };
})();

// ───────────────────────────── Salle 5 : L'Écluse ─────────────────────────────
//
// 78×46. Idée : le BLOC 2×2 à deux joueurs, sous la menace des gardiens. Le bloc est dans un COULOIR de 2 tuiles (y22..23) fermé sur les côtés et au
// fond, long de 32 tuiles ; le socle est tout au fond [44,22]. Il ne bouge que si 2 héros le poussent ensemble (à 1 joueur : 1 seul suffit).
// Les galeries nord et sud (semées de bassins, abîmes) abritent des gardiens terrestres ; deux plaques — la pompe [18,10] (galerie nord, sans
// minimum) et la marée [18,34] (galerie sud, dès 2 joueurs) — doivent être tenues ENSEMBLE avec le socle rempli pour ouvrir la porte
// [62..63, 9..10] de la galerie nord, vers le hall est (sortie).
// Résolution : deux héros poussent le bloc de 30 tuiles vers l'est (à partir des tuiles [13,22] et [13,23]) ; les autres défendent le hall
// ouest ; socle rempli → l'un tient la pompe, l'autre la marée ; la porte s'ouvre ; vaincre les gardiens de l'est ; sortie [72..75, 20..25].

const sluice: RoomDef = (() => {
  const spawn: TileXY = [3, 21];
  const lane = rect(14, 22, 32, 2);
  const pump: TileXY = [18, 10];
  const tide: TileXY = [18, 34];
  const b = new LayoutBuilder(78, 46)
    .floor(2, 6, 12, 34) // hall ouest x2..13, y6..39 (derrière le bloc)
    .floor(14, 22, 32, 2) // couloir du bloc x14..45, y22..23
    .floor(16, 3, 46, 15) // galerie nord x16..61, y3..17
    .floor(16, 28, 46, 15) // galerie sud x16..61, y28..42
    .floor(14, 8, 2, 4) // liaison hall → galerie nord
    .floor(14, 32, 2, 4) // liaison hall → galerie sud
    .floor(62, 9, 2, 2) // passage de la porte
    .floor(64, 2, 12, 42) // hall est x64..75, y2..43
    // bassins (abîmes) des galeries et du hall est
    .pit(24, 5, 8, 4)
    .pit(38, 12, 10, 4)
    .pit(24, 35, 8, 4)
    .pit(38, 29, 10, 4)
    .pit(67, 7, 6, 4)
    .pit(67, 34, 6, 4)
    .reserve(
      rect(2, 17, 11, 12),
      rect(56, 5, 8, 10),
      rect(70, 17, 8, 12),
      rect(13, 6, 4, 8),
      rect(13, 30, 4, 8),
      around(pump, 3),
      around(tide, 3),
    )
    .pillarGrid(rect(18, 4, 42, 13), 6, 4, 2, 2)
    .pillarGrid(rect(18, 29, 42, 13), 6, 4, 2, 2)
    .pillarGrid(rect(66, 3, 10, 40), 5, 5, 2, 1)
    .pillarGrid(rect(3, 7, 10, 9), 5, 4, 2, 1)
    .pillarGrid(rect(3, 30, 10, 9), 5, 4, 2, 1);
  const rows = b.rows();
  const p = new Placer(rows, spawn, [lane, rect(12, 20, 4, 6), around(pump, 3), around(tide, 3), rect(60, 7, 5, 6)])
    // galerie nord : gardiens terrestres
    .fill(rect(18, 4, 42, 13), GROUND, 14)
    // galerie sud
    .fill(rect(18, 29, 42, 13), GROUND, 14)
    // hall est : derrière la porte
    .fill(rect(67, 3, 9, 40), GROUND_TOUGH, 14);
  return {
    id: 'sluice',
    ...roomKeys('sluice'),
    theme: THEME,
    layout: rows,
    playerSpawns: spawns(...spawn),
    enemies: p.tiered(),
    mechanisms: [
      { id: 'sluiceBlock', type: 'block', tile: [14, 22], labelKey: mechLabel('sluice', 'sluiceBlock') },
      { id: 'sluiceSocket', type: 'socket', tile: [44, 22], blockId: 'sluiceBlock', labelKey: mechLabel('sluice', 'sluiceSocket') },
      { id: 'sluicePlatePump', type: 'plate', tile: pump, labelKey: mechLabel('sluice', 'sluicePlatePump') },
      { id: 'sluicePlateTide', type: 'plate', tile: tide, minPlayers: 2, labelKey: mechLabel('sluice', 'sluicePlateTide') },
      {
        id: 'sluiceDoor',
        type: 'door',
        tiles: doorTiles(62, 9),
        requires: ['sluiceSocket', 'sluicePlatePump', 'sluicePlateTide'],
        labelKey: mechLabel('sluice', 'sluiceDoor'),
      },
    ],
    signs: [p.sign('sluice', 'block', 9, 20), p.sign('sluice', 'plates', 52, 9), p.sign('sluice', 'galleries', 10, 27)],
    decor: [
      ...wallDecor(rows, 'torch', rect(16, 3, 46, 15), 8),
      ...wallDecor(rows, 'torch', rect(16, 28, 46, 15), 8, 'south', 1),
      ...wallDecor(rows, 'banner', rect(2, 6, 12, 34), 6, 'north', 3),
      ...p.decor('crystal', [3, 7], [12, 38], [75, 3], [75, 41], [60, 4], [60, 40]).decor('statue', [17, 4], [17, 41], [60, 17], [60, 28])
        .decor('bones', [30, 14], [36, 36], [70, 22]).decor('crate', [3, 8], [3, 37], [61, 5], [76, 3]).decor('plant', [20, 10], [20, 33]).decors,
    ],
    exit: { rect: rect(72, 20, 4, 6), requires: ['clear'] },
  };
})();

// ───────────────────────────── Salle 6 : Le Chœur de Nacre — « Chœur » ─────────────────────────────
//
// 84×52. Idée : le MORCEAU DE BRAVOURE. Une immense nef nacrée [2..81, 2..49] ; au centre, un sanctuaire muré [38..45, 22..29] (intérieur [40..43,
// 24..27] = la sortie) dont la porte [38..39, 25..26] s'ouvre à l'ouest. Autour, un anneau de piliers et, à ses quatre coins, quatre leviers de
// couleur à FENÊTRE (10 s) : bleu [37,20], rouge [47,20], vert [37,31], jaune [47,31] (espacés de 10-11 tuiles). La porte exige les quatre,
// tirés presque ensemble : le chœur chante à quatre voix. Trois VAGUES d'embuscade (bandes pleine hauteur, impossibles à contourner) :
// la grille de l'entrée [16..18], le milieu de nef [26..28] et l'anneau [34..37] qui contient les leviers de l'ouest.
// Résolution : avancer par bandes en vainquant chaque vague ; chacun s'annonce près de SON levier puis tire dans la fenêtre ; la porte
// s'ouvre ; sortie [40..43, 24..27].

const choir: RoomDef = (() => {
  const spawn: TileXY = [4, 26];
  const leverTiles: TileXY[] = [
    [37, 20],
    [47, 20],
    [37, 31],
    [47, 31],
  ];
  const b = new LayoutBuilder(84, 52)
    .floor(2, 2, 80, 48)
    .wall(38, 22, 8, 8)
    .floor(40, 24, 4, 4)
    .floor(38, 25, 2, 2)
    .reserve(rect(2, 22, 9, 9), rect(29, 21, 18, 10), ...leverTiles.map((t) => around(t, 2)));
  [
    [34, 16],
    [49, 16],
    [34, 33],
    [49, 33],
    [41, 15],
    [41, 35],
    [53, 24],
    [22, 12],
    [22, 38],
    [20, 24],
    [60, 12],
    [60, 38],
    [66, 24],
    [72, 16],
    [72, 34],
    [12, 12],
    [12, 38],
    [30, 6],
    [30, 44],
    [56, 6],
    [56, 44],
  ].forEach(([x, y]) => b.pillarBlock(x, y));
  b.pillar([27, 18], [27, 33], [55, 18], [55, 33], [64, 8], [64, 42]);
  const rows = b.rows();
  const p = new Placer(rows, spawn, [rect(29, 21, 18, 10), ...leverTiles.map((t) => around(t, 2))])
    // vague 1 : la grille de l'entrée (bande x16..18)
    .fill(rect(22, 3, 6, 46), ANY, 16, { when: 'enter:choirGate' })
    // vague 2 : le milieu de nef (bande x26..28)
    .fill(rect(32, 3, 17, 46), ANY, 20, { when: 'enter:choirMid' })
    // vague 3 : l'anneau (bande x34..37), l'est de la nef
    .fill(rect(52, 3, 28, 46), ANY, 16, { when: 'enter:choirRing' });
  const mechanisms: MechanismDef[] = [];
  COLORS.forEach((color, slot) => {
    const base = {
      id: `choirLever${color}`,
      type: 'lever' as const,
      tile: leverTiles[slot],
      ownerSlot: slot,
      windowMs: 10000,
      labelKey: mechLabel('choir', `choirLever${color}`),
    };
    mechanisms.push(slot === 0 ? base : { ...base, minPlayers: slot + 1 });
  });
  mechanisms.push({
    id: 'choirDoor',
    type: 'door',
    tiles: doorTiles(38, 25),
    requires: COLORS.map((c) => `choirLever${c}`),
    labelKey: mechLabel('choir', 'choirDoor'),
  });
  return {
    id: 'choir',
    ...roomKeys('choir'),
    theme: THEME,
    layout: rows,
    playerSpawns: spawns(...spawn),
    enemies: p.tiered(TIERS_MID),
    mechanisms,
    zones: [
      { id: 'choirGate', rect: rect(16, 2, 3, 48) },
      { id: 'choirMid', rect: rect(26, 2, 3, 48) },
      { id: 'choirRing', rect: rect(34, 2, 4, 48) },
    ],
    signs: [p.sign('choir', 'waves', 8, 26), p.sign('choir', 'levers', 31, 26), p.sign('choir', 'door', 35, 24)],
    decor: [
      ...wallDecor(rows, 'torch', rect(2, 2, 80, 48), 8),
      ...wallDecor(rows, 'torch', rect(2, 49, 80, 1), 8, 'south'),
      ...wallDecor(rows, 'banner', rect(2, 2, 80, 48), 12, 'north', 6),
      ...p.decor('crystal', [3, 3], [80, 3], [3, 48], [80, 48], [36, 17], [48, 17], [36, 34], [48, 34]).decor('statue', [37, 23], [37, 28], [3, 24], [3, 28])
        .decor('bones', [14, 20], [58, 28], [70, 40]).decor('plant', [8, 8], [8, 44], [74, 8], [74, 44]).decors,
    ],
    exit: { rect: rect(40, 24, 4, 4), requires: ['choirDoor', 'clear'] },
  };
})();

// ───────────────────────────── Salle 7 : Le Pont des Tempêtes (demi-boss n°2) ─────────────────────────────
//
// 66×46. Idée : DEMI-BOSS n°2 sur le pont d'un vaisseau échoué. Le spectre (`wraith`, VOLANT) disparaît, réapparaît et tire des traits sombres ;
// salle pure sans aucun abîme (le spectre ne doit jamais se réfugier hors de portée), des mâts (piliers) pour se couvrir, 12 sbires à 1 joueur,
// 30 à 4 (surtout des volants). Sortie : le spectre vaincu (`clear`).
// Résolution : se couvrir derrière les mâts, vaincre le spectre et ses sbires (spécial recommandé) ; sortie [59..62, 20..25].

const stormdeck: RoomDef = (() => {
  const spawn: TileXY = [4, 23];
  const b = new LayoutBuilder(66, 46).floor(2, 4, 56, 38).floor(58, 19, 6, 8);
  [
    [12, 10],
    [12, 32],
    [26, 14],
    [26, 28],
    [32, 9],
    [32, 33],
    [34, 21],
    [42, 15],
    [42, 27],
    [50, 9],
    [50, 33],
  ].forEach(([x, y]) => b.pillarBlock(x, y));
  b.pillar([19, 22], [38, 8], [38, 36], [20, 8], [20, 38]);
  const rows = b.rows();
  const crystals = [
    { id: 'stormdeck_heal1', tile: [20, 12] as TileXY },
    { id: 'stormdeck_heal2', tile: [20, 34] as TileXY },
    { id: 'stormdeck_heal3', tile: [26, 22] as TileXY, minPlayers: 3 },
  ];
  const p = new Placer(rows, spawn, [rect(56, 18, 8, 10), ...crystals.map((c) => around(c.tile, 1))])
    .foe('wraith', 47, 22)
    .fill(rect(16, 5, 40, 36), ['wisp', 'skeleton', 'bat', 'spider', 'slime', 'wisp', 'skeleton', 'slime'], 30);
  return {
    id: 'stormdeck',
    ...roomKeys('stormdeck'),
    theme: THEME,
    layout: rows,
    playerSpawns: spawns(...spawn),
    enemies: p.tieredTo([12, 18, 25, 30]),
    mechanisms: [],
    signs: [p.sign('stormdeck', 'wraith', 8, 23), p.sign('stormdeck', 'masts', 11, 17)],
    decor: [
      ...wallDecor(rows, 'torch', rect(2, 4, 56, 38), 8),
      ...wallDecor(rows, 'banner', rect(2, 4, 56, 38), 12, 'north', 6),
      ...p.decor('crystal', [3, 5], [56, 5], [3, 40], [56, 40], [60, 20], [62, 25]).decor('statue', [3, 21], [3, 25], [56, 21], [56, 25])
        .decor('bones', [18, 16], [36, 30], [46, 12]).decor('crate', [8, 6], [8, 39]).decors,
    ],
    // Cristaux de soin (sources de vie fixes, usage unique, 50 PV) : loin des arrivées et du départ du demi-boss ; le 3e exige 3 joueurs.
    healCrystals: crystals,
    exit: { rect: rect(59, 20, 4, 6), requires: ['clear'] },
  };
})();

// ───────────────────────────── Salle 8 : Le Cœur de Verre ─────────────────────────────
//
// 86×52. BOSS FINAL du niveau : l'écho de Morvane (`morvane`, VOLANT, 3 phases), escorté de 9 gardes à 1 joueur, 40 à 4. Salle pure sans abîme,
// piliers 2×2 de couverture, sortie scellée dans une alcôve au nord : elle exige l'écho vaincu (`clear`) et les quatre objectifs personnels.
// Les héros arrivent à l'ouest, Morvane à l'est. Aucun butin sur le boss.
// Résolution : se couvrir, vaincre les gardes puis Morvane ; l'alcôve [39..46, 1..2] s'ouvre ; tous s'y rejoignent.

const glassheart: RoomDef = (() => {
  const spawn: TileXY = [4, 26];
  const b = new LayoutBuilder(86, 52).floor(2, 4, 80, 44).floor(39, 1, 8, 3);
  [
    [12, 10],
    [12, 38],
    [24, 17],
    [24, 31],
    [34, 10],
    [34, 38],
    [44, 24],
    [54, 17],
    [54, 31],
    [64, 10],
    [64, 38],
    [74, 17],
    [74, 33],
  ].forEach(([x, y]) => b.pillarBlock(x, y));
  b.pillar([20, 24], [48, 10], [48, 40], [60, 24], [32, 24]);
  const rows = b.rows();
  const crystals = [
    { id: 'glassheart_heal1', tile: [24, 10] as TileXY },
    { id: 'glassheart_heal2', tile: [24, 42] as TileXY },
    { id: 'glassheart_heal3', tile: [44, 45] as TileXY, minPlayers: 3 },
  ];
  const p = new Placer(rows, spawn, [around([75, 26], 3), rect(37, 1, 12, 4), ...crystals.map((c) => around(c.tile, 1))])
    .foe('morvane', 75, 26)
    .fill(rect(18, 5, 62, 42), ['knight', 'skeleton', 'archer', 'spider', 'wisp', 'bat', 'slime'], 40);
  return {
    id: 'glassheart',
    ...roomKeys('glassheart'),
    theme: THEME,
    layout: rows,
    playerSpawns: spawns(3, 26),
    enemies: p.tieredTo([9, 18, 30, 40]),
    mechanisms: [],
    signs: [p.sign('glassheart', 'morvane', 8, 26), p.sign('glassheart', 'cover', 14, 20)],
    decor: [
      ...wallDecor(rows, 'torch', rect(2, 4, 80, 44), 8),
      ...wallDecor(rows, 'torch', rect(2, 47, 80, 1), 8, 'south'),
      ...wallDecor(rows, 'banner', rect(2, 4, 80, 44), 12, 'north', 5),
      ...p.decor('statue', [3, 5], [80, 5], [3, 46], [80, 46]).decor('crystal', [39, 1], [46, 1], [42, 3], [43, 3], [3, 26], [81, 26])
        .decor('bones', [16, 26], [40, 14], [58, 32]).decors,
    ],
    // Cristaux de soin (sources de vie fixes, usage unique, 50 PV) : loin des arrivées et du départ du boss ; le 3e exige 3 joueurs.
    healCrystals: crystals,
    exit: {
      rect: rect(39, 1, 8, 2),
      requires: ['clear', 'obj:chime', 'obj:pearl', 'obj:bones', 'obj:echo'],
      final: true,
      sealed: true,
    },
  };
})();

// ───────────────────────────── Dialogues et objectifs ─────────────────────────────

const intro: DialogueLine[] = [
  { speaker: 'narrator', textKey: 'level.level7.intro.1' },
  { speaker: 'lyssa', textKey: 'level.level7.intro.2' },
  { speaker: 'aldric', textKey: 'level.level7.intro.3' },
  { speaker: 'heroes', textKey: 'level.level7.intro.4' },
];

const outro: DialogueLine[] = [
  { speaker: 'lyssa', textKey: 'level.level7.outro.1' },
  { speaker: 'morvane', textKey: 'level.level7.outro.2' },
  { speaker: 'heroes', textKey: 'level.level7.outro.3' },
];

const objectives: ObjectiveDef[] = [
  { id: 'chime', slot: 0, roomId: 'choir', kind: 'mechanism', mechanismId: 'choirDoor', labelKey: 'objective.level7.chime' },
  { id: 'pearl', slot: 1, roomId: 'pearlcave', kind: 'zone', zoneId: 'pearlZone', seconds: 20, labelKey: 'objective.level7.pearl' },
  { id: 'bones', slot: 2, roomId: 'shoal', kind: 'kills', count: 3, enemyKind: 'skeleton', labelKey: 'objective.level7.bones' },
  { id: 'echo', slot: 3, roomId: 'mirrorpools', kind: 'mechanism', mechanismId: 'mirrorRunes', labelKey: 'objective.level7.echo' },
];

/**
 * Niveau 7 — Le Carillon Englouti. Données pures (aucune logique) : voir l'en-tête du fichier pour la structure, le rythme, la coop
 * adaptative et les objectifs.
 */
export const level7: LevelDef = {
  id: 'level7',
  nameKey: 'level.level7.name',
  theme: THEME,
  estimatedMinutes: 9,
  intro,
  outro,
  rooms: [shoal, pearlcave, dyke, mirrorpools, sluice, choir, stormdeck, glassheart],
  objectives,
};
