/**
 * Construction de la session DÉMO (mode « attract ») : niveau aléatoire de la campagne, héros aléatoire, salle de départ
 * aléatoire « sans danger », difficulté facile, graine de simulation. Module PUR : le hasard est INJECTÉ (`random: () => [0,1)`),
 * la scène de menu passe `Math.random`, les tests passent un générateur à graine ; le coeur du jeu ne voit jamais `Math.random`.
 *
 * La session ne mène JAMAIS à une sauvegarde : `GameScene` ne crée pas d'`AutoSaver` quand `session.demo` est présent, et
 * `isSavingAllowed({ demo: true, … })` vaut false (voir `isDemoSession`).
 */
import { CHARACTER_IDS } from '../core/characters';
import { TILE } from '../core/constants';
import { ENEMIES } from '../core/enemies';
import { RoomGrid } from '../core/grid';
import type { CharacterId, LevelDef, PlayerId, RoomDef } from '../core/types';
import { LEVELS } from '../levels';
import { emptyStats, type GameSession } from '../render/session';
import { buildNavMap, isPassable, reachableTiles, tileOfPx } from '../testing/pathfinding';
import { ATTRACT_DEMO_MS } from './config';

/** Difficulté de la démo : 1 (facile), pour que le héros survive ~30 s sans que le pilote soit parfait. */
export const DEMO_DIFFICULTY = 1;

/**
 * Nombre d'ennemis accessibles (solo, au départ) à partir duquel une salle est jugée « assez animée » pour 30 s de démo : en dessous,
 * le héros finit vite le combat puis patrouille dans une salle vide. Préférence seulement : repli sur toutes les salles de combat
 * si aucune du niveau n'atteint ce seuil (le niveau 5 n'en a qu'une, à 6 ennemis).
 */
export const DEMO_MIN_ENEMIES = 8;

/** Entier aléatoire dans [0, n) à partir de `random` (borné pour tolérer une valeur de 1 ou hors plage). */
function randomIndex(random: () => number, n: number): number {
  const r = random();
  const x = Number.isFinite(r) ? Math.min(0.999999999, Math.max(0, r)) : 0;
  return Math.floor(x * n);
}

/**
 * Une salle est-elle « sans danger » pour démarrer une démo au milieu d'un niveau ? Ni salle sombre (l'image serait presque noire et
 * la torche s'userait), ni boss / demi-boss, ni salle finale du niveau (sa sortie termine le niveau).
 */
export function isSafeDemoRoom(room: RoomDef): boolean {
  if (room.dark === true) return false;
  if (room.exit.final === true) return false;
  for (const e of room.enemies) {
    const def = ENEMIES[e.kind];
    if (def.isBoss || def.isMiniBoss === true) return false;
  }
  return true;
}

/** Rectangles pleins (px) que les mécanismes ferment au départ de la salle : portes, herse, pont éteint, statues, braseros, blocs 2×2. Approximation PRUDENTE. */
function closedMechanismRects(room: RoomDef): { x: number; y: number; w: number; h: number }[] {
  const out: { x: number; y: number; w: number; h: number }[] = [];
  const tile = (t: readonly [number, number], size = 1): void => {
    out.push({ x: t[0] * TILE, y: t[1] * TILE, w: size * TILE, h: size * TILE });
  };
  for (const m of room.mechanisms) {
    switch (m.type) {
      case 'door':
        m.tiles.forEach((t) => tile(t));
        break;
      case 'hourglass':
        m.gate.forEach((t) => tile(t)); // ouverte au début, mais elle se referme : on ne compte pas dessus
        break;
      case 'lightBridge':
        m.tiles.forEach((t) => tile(t));
        break;
      case 'statuePair':
        m.statues.forEach((s) => tile(s.tile));
        break;
      case 'brazier':
        tile(m.tile);
        break;
      case 'block':
        tile(m.tile, 2);
        break;
      default:
        break;
    }
  }
  return out;
}

/** Ce que le héros peut faire dans la salle depuis son point d'apparition, portes et herses fermées. */
export interface DemoRoomReach {
  /** Nombre d'ennemis (apparition initiale en solo) accessibles à pied. */
  enemiesReachable: number;
  /** La zone de sortie est accessible à pied. */
  exitReachable: boolean;
}

/**
 * Analyse statique d'une salle pour la démo : depuis la première case d'apparition, que peut atteindre le héros sans résoudre
 * d'énigme (mécanismes fermés = obstacles) ? Sert à écarter les salles où le héros resterait enfermé sans rien voir.
 */
export function analyzeDemoRoom(room: RoomDef): DemoRoomReach {
  const grid = new RoomGrid(room.layout);
  const nav = buildNavMap(grid, closedMechanismRects(room));
  const sp = room.playerSpawns[0] ?? [1, 1];
  const reach = reachableTiles(nav, [sp[0], sp[1]]);
  const at = (tx: number, ty: number): boolean => isPassable(nav, tx, ty) && reach[ty * nav.width + tx] === 1;
  const nearReached = (tx: number, ty: number): boolean => {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (at(tx + dx, ty + dy)) return true;
    return false;
  };
  let enemiesReachable = 0;
  for (const e of room.enemies) {
    // Seuls comptent les ennemis présents au départ EN SOLO : ni conditionnés (`when`), ni vagues ultérieures (`wave > 0`), ni
    // réservés à la coop (`minPlayers > 1`) : sinon les salles d'arène / d'estrade seraient retenues alors qu'elles sont vides au départ.
    if (e.when || (e.wave ?? 0) > 0 || (e.minPlayers ?? 1) > 1) continue;
    const t = tileOfPx({ x: (e.tile[0] + 0.5) * TILE, y: (e.tile[1] + 0.5) * TILE });
    if (nearReached(t[0], t[1])) enemiesReachable++;
  }
  const r = room.exit.rect;
  let exitReachable = false;
  for (let ty = r.y; ty < r.y + r.h && !exitReachable; ty++) {
    for (let tx = r.x; tx < r.x + r.w; tx++) {
      if (at(tx, ty)) {
        exitReachable = true;
        break;
      }
    }
  }
  return { enemiesReachable, exitReachable };
}

/**
 * Indice de la salle de départ de la démo : tirée uniformément parmi les salles SANS DANGER (`isSafeDemoRoom`) ET où il se passe
 * quelque chose pour le héros (au moins un ennemi accessible à pied : il se bat ; à défaut, une sortie accessible : il avance) ;
 * la salle 0 si aucune ne convient. Le tirage ne dépend que de `random` (aucun biais vers la première salle).
 */
export function pickDemoStartRoom(level: LevelDef, random: () => number): number {
  const fights: number[] = [];
  const walks: number[] = [];
  level.rooms.forEach((room, i) => {
    if (!isSafeDemoRoom(room)) return;
    const a = analyzeDemoRoom(room);
    if (a.enemiesReachable > 0) fights.push(i);
    else if (a.exitReachable) walks.push(i);
  });
  // préférence aux salles bien peuplées (voir DEMO_MIN_ENEMIES) ; repli sur toutes les salles de combat, puis de marche
  const lively = fights.filter((i) => analyzeDemoRoom(level.rooms[i]).enemiesReachable >= DEMO_MIN_ENEMIES);
  const pool = lively.length > 0 ? lively : fights.length > 0 ? fights : walks;
  if (pool.length === 0) return 0;
  return pool[randomIndex(random, pool.length)];
}

/** Options de `buildDemoSession`. */
export interface DemoSessionOptions {
  /** Niveaux parmi lesquels tirer (défaut : `LEVELS`, la campagne : JAMAIS le tutoriel, qui n'en fait pas partie). */
  levels?: readonly LevelDef[];
  /** Personnages parmi lesquels tirer (défaut : tous les personnages jouables). */
  characters?: readonly CharacterId[];
  /** Durée de la démo (ms, défaut `ATTRACT_DEMO_MS`). */
  durationMs?: number;
}

/**
 * Session de démo : 1 joueur (héros aléatoire), niveau aléatoire de la campagne, salle de départ aléatoire sans danger,
 * difficulté 1, graine de simulation aléatoire, statistiques vierges, aucun niveau « terminé ».
 * L'ordre des tirages est fixe (niveau, héros, salle, graine) : mêmes valeurs de `random` ⇒ même session.
 * @param random tirage dans [0, 1) (INJECTÉ : `Math.random` côté scène, générateur à graine dans les tests)
 */
export function buildDemoSession(random: () => number, opts: DemoSessionOptions = {}): GameSession {
  const levels = opts.levels ?? LEVELS;
  const characters = opts.characters ?? CHARACTER_IDS;
  const levelIndex = randomIndex(random, Math.max(1, levels.length));
  const level = levels[levelIndex];
  const characterId = characters[randomIndex(random, Math.max(1, characters.length))];
  const startRoomIndex = level ? pickDemoStartRoom(level, random) : 0;
  const seed = Math.floor(Math.min(0.999999999, Math.max(0, random())) * 0xffffffff) >>> 0;
  const session: GameSession = {
    playerCount: 1,
    players: [{ id: 0 as PlayerId, characterId, difficulty: DEMO_DIFFICULTY }],
    levelIndex,
    stats: emptyStats(1),
    demo: { seed, durationMs: opts.durationMs ?? ATTRACT_DEMO_MS },
  };
  if (startRoomIndex > 0) session.startRoomIndex = startRoomIndex;
  return session;
}

/** La session est-elle une démo ? (aucune sauvegarde, aucune progression écrite) */
export function isDemoSession(session: Pick<GameSession, 'demo'> | null | undefined): boolean {
  return !!session && session.demo !== undefined;
}
