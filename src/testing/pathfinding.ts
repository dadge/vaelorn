/**
 * Recherche de chemin sur la grille de tuiles d'une salle, pour les bots de test (src/testing).
 *
 * Logique pure et déterministe (aucun Phaser/DOM/Math.random/Date.now). Le plan de navigation (`NavMap`) marque comme
 * bloquées : les tuiles qui bloquent le déplacement (murs, piliers, vide, fosses), les tuiles recouvertes (même
 * partiellement) par un rectangle solide dynamique (porte fermée, bloc poussable) et des tuiles bloquées « temporairement »
 * demandées par l'appelant (détection de blocage). Le chemin est un Dijkstra 8-connexe sans coupe de coin (un pas
 * diagonal exige que les deux tuiles orthogonales voisines soient libres), avec un surcoût optionnel par tuile (évitement
 * des ennemis).
 */
import { PLAYER_RADIUS, TILE } from '../core/constants';
import { canOccupy, type PixelRect } from '../core/collision';
import type { RoomGrid } from '../core/grid';
import type { TileXY, Vec2 } from '../core/types';

/** Rayon (px) utilisé pour tester qu'un segment est libre : légèrement supérieur au rayon du joueur (marge de sécurité). */
export const SWEEP_RADIUS = PLAYER_RADIUS + 1;
/** Pas d'échantillonnage (px) de `sweepClear`. */
export const SWEEP_STEP_PX = 4;

/** Plan de navigation d'une salle : une case par tuile, 1 = bloquée. */
export interface NavMap {
  width: number;
  height: number;
  blocked: Uint8Array;
}

/** Index linéaire d'une tuile dans un `NavMap`. */
export function tileIndex(nav: Pick<NavMap, 'width'>, tx: number, ty: number): number {
  return ty * nav.width + tx;
}

/** La tuile (tx,ty) est-elle dans la grille ? */
export function inBounds(nav: Pick<NavMap, 'width' | 'height'>, tx: number, ty: number): boolean {
  return tx >= 0 && ty >= 0 && tx < nav.width && ty < nav.height;
}

/** La tuile est-elle praticable (dans la grille et non bloquée) ? */
export function isPassable(nav: NavMap, tx: number, ty: number): boolean {
  return inBounds(nav, tx, ty) && nav.blocked[ty * nav.width + tx] === 0;
}

/** Centre en pixels d'une tuile. */
export function tileCenterOf(t: readonly [number, number]): Vec2 {
  return { x: (t[0] + 0.5) * TILE, y: (t[1] + 0.5) * TILE };
}

/** Tuile contenant un point pixel. */
export function tileOfPx(p: Vec2): TileXY {
  return [Math.floor(p.x / TILE), Math.floor(p.y / TILE)];
}

/**
 * Construit le plan de navigation d'une salle.
 * @param grid grille statique de la salle
 * @param solids rectangles solides dynamiques (`GameSimulation.solidRects()` : portes fermées, blocs)
 * @param extraBlocked indices de tuiles (`tileIndex`) à considérer comme bloqués en plus
 */
export function buildNavMap(
  grid: RoomGrid,
  solids: readonly PixelRect[],
  extraBlocked?: ReadonlySet<number>,
): NavMap {
  const width = grid.width;
  const height = grid.height;
  const blocked = new Uint8Array(width * height);
  for (let ty = 0; ty < height; ty++) {
    for (let tx = 0; tx < width; tx++) {
      if (grid.blocksMovement(tx, ty)) blocked[ty * width + tx] = 1;
    }
  }
  for (const r of solids) {
    const x0 = Math.floor(r.x / TILE + 1e-6);
    const x1 = Math.ceil((r.x + r.w) / TILE - 1e-6) - 1;
    const y0 = Math.floor(r.y / TILE + 1e-6);
    const y1 = Math.ceil((r.y + r.h) / TILE - 1e-6) - 1;
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        if (inBounds({ width, height }, tx, ty)) blocked[ty * width + tx] = 1;
      }
    }
  }
  if (extraBlocked) {
    for (const idx of extraBlocked) {
      if (idx >= 0 && idx < blocked.length) blocked[idx] = 1;
    }
  }
  return { width, height, blocked };
}

/**
 * Surcoût par tuile autour d'une liste de points (ennemis) : `strength × (1 − d / radiusPx)` pour d < radiusPx
 * (d = distance entre le centre de la tuile et le point), cumulé. Retourne null si la liste est vide.
 * @param nav plan de navigation (dimensions)
 * @param points positions en pixels
 * @param radiusPx rayon d'influence (px)
 * @param strength surcoût maximal par point (au centre)
 */
export function buildAvoidCost(
  nav: Pick<NavMap, 'width' | 'height'>,
  points: readonly Vec2[],
  radiusPx: number,
  strength: number,
): Float32Array | null {
  if (points.length === 0) return null;
  const cost = new Float32Array(nav.width * nav.height);
  const rt = Math.ceil(radiusPx / TILE) + 1;
  for (const p of points) {
    const cx = Math.floor(p.x / TILE);
    const cy = Math.floor(p.y / TILE);
    for (let ty = cy - rt; ty <= cy + rt; ty++) {
      for (let tx = cx - rt; tx <= cx + rt; tx++) {
        if (!inBounds(nav, tx, ty)) continue;
        const d = Math.hypot((tx + 0.5) * TILE - p.x, (ty + 0.5) * TILE - p.y);
        if (d < radiusPx) cost[ty * nav.width + tx] += strength * (1 - d / radiusPx);
      }
    }
  }
  return cost;
}

// ───────────────────────────── Tas binaire (priorité = coût, puis ordre d'insertion) ─────────────────────────────

class MinHeap {
  private costs: number[] = [];
  private seqs: number[] = [];
  private items: number[] = [];
  private counter = 0;

  get size(): number {
    return this.items.length;
  }

  push(cost: number, item: number): void {
    let i = this.items.length;
    this.costs.push(cost);
    this.seqs.push(this.counter++);
    this.items.push(item);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.less(i, parent)) {
        this.swap(i, parent);
        i = parent;
      } else break;
    }
  }

  /** Retire le plus petit élément ; retourne [coût, élément]. */
  pop(): [number, number] {
    const topCost = this.costs[0];
    const topItem = this.items[0];
    const lastCost = this.costs.pop() as number;
    const lastSeq = this.seqs.pop() as number;
    const lastItem = this.items.pop() as number;
    const n = this.items.length;
    if (n > 0) {
      this.costs[0] = lastCost;
      this.seqs[0] = lastSeq;
      this.items[0] = lastItem;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < n && this.less(l, m)) m = l;
        if (r < n && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return [topCost, topItem];
  }

  private less(a: number, b: number): boolean {
    return this.costs[a] < this.costs[b] || (this.costs[a] === this.costs[b] && this.seqs[a] < this.seqs[b]);
  }

  private swap(a: number, b: number): void {
    [this.costs[a], this.costs[b]] = [this.costs[b], this.costs[a]];
    [this.seqs[a], this.seqs[b]] = [this.seqs[b], this.seqs[a]];
    [this.items[a], this.items[b]] = [this.items[b], this.items[a]];
  }
}

const NEIGHBORS: readonly (readonly [number, number, number])[] = [
  [0, -1, 1],
  [1, 0, 1],
  [0, 1, 1],
  [-1, 0, 1],
  [1, -1, Math.SQRT2],
  [1, 1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
];

/** Options de `findPath`. */
export interface PathOptions {
  /** Autorise les pas diagonaux sans coupe de coin (défaut true). */
  diagonal?: boolean;
  /** Surcoût additionnel par tuile (voir `buildAvoidCost`). */
  extraCost?: Float32Array | null;
}

/**
 * Chemin de moindre coût depuis la tuile `start` jusqu'à la première tuile (au sens du coût) qui vérifie `isGoal`.
 * La tuile de départ peut être bloquée (on peut toujours en sortir). Les autres tuiles doivent être praticables.
 * @param nav plan de navigation
 * @param start tuile de départ
 * @param isGoal prédicat de but (appelé sur des tuiles praticables et sur le départ)
 * @param opts options
 * @returns tuiles de `start` au but inclus, ou null si aucun but n'est atteignable
 */
export function findPath(
  nav: NavMap,
  start: TileXY,
  isGoal: (tx: number, ty: number) => boolean,
  opts: PathOptions = {},
): TileXY[] | null {
  const { width, height } = nav;
  if (!inBounds(nav, start[0], start[1])) return null;
  const diagonal = opts.diagonal !== false;
  const extra = opts.extraCost ?? null;
  const n = width * height;
  const best = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const heap = new MinHeap();
  const s = start[1] * width + start[0];
  best[s] = 0;
  heap.push(0, s);
  while (heap.size > 0) {
    const [cost, idx] = heap.pop();
    if (done[idx]) continue;
    done[idx] = 1;
    const x = idx % width;
    const y = (idx - x) / width;
    if (isGoal(x, y)) {
      const path: TileXY[] = [];
      let cur = idx;
      while (cur !== -1) {
        const cx = cur % width;
        path.push([cx, (cur - cx) / width]);
        cur = prev[cur];
      }
      path.reverse();
      return path;
    }
    for (const [dx, dy, step] of NEIGHBORS) {
      if (dx !== 0 && dy !== 0 && !diagonal) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (!isPassable(nav, nx, ny)) continue;
      if (dx !== 0 && dy !== 0 && (!isPassable(nav, x + dx, y) || !isPassable(nav, x, y + dy))) continue;
      const nidx = ny * width + nx;
      if (done[nidx]) continue;
      const c = cost + step + (extra ? extra[nidx] : 0);
      if (c < best[nidx]) {
        best[nidx] = c;
        prev[nidx] = idx;
        heap.push(c, nidx);
      }
    }
  }
  return null;
}

/**
 * Ensemble des tuiles atteignables depuis `start` (même règles de déplacement que `findPath`).
 * @returns tableau d'octets (1 = atteignable) indexé par `tileIndex`
 */
export function reachableTiles(nav: NavMap, start: TileXY, diagonal = true): Uint8Array {
  const seen = new Uint8Array(nav.width * nav.height);
  if (!inBounds(nav, start[0], start[1])) return seen;
  const queue: number[] = [start[1] * nav.width + start[0]];
  seen[queue[0]] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const idx = queue[qi];
    const x = idx % nav.width;
    const y = (idx - x) / nav.width;
    for (const [dx, dy] of NEIGHBORS) {
      if (dx !== 0 && dy !== 0 && !diagonal) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (!isPassable(nav, nx, ny)) continue;
      if (dx !== 0 && dy !== 0 && (!isPassable(nav, x + dx, y) || !isPassable(nav, x, y + dy))) continue;
      const nidx = ny * nav.width + nx;
      if (seen[nidx]) continue;
      seen[nidx] = 1;
      queue.push(nidx);
    }
  }
  return seen;
}

/**
 * Tuile praticable la plus proche de `tile` (recherche par anneaux croissants, ordre déterministe). Retourne `tile` si
 * elle est déjà praticable, null si la grille n'a aucune tuile praticable.
 */
export function nearestPassableTile(nav: NavMap, tile: TileXY): TileXY | null {
  if (isPassable(nav, tile[0], tile[1])) return [tile[0], tile[1]];
  const maxR = Math.max(nav.width, nav.height);
  for (let r = 1; r <= maxR; r++) {
    let best: TileXY | null = null;
    let bestD = Infinity;
    for (let ty = tile[1] - r; ty <= tile[1] + r; ty++) {
      for (let tx = tile[0] - r; tx <= tile[0] + r; tx++) {
        if (Math.max(Math.abs(tx - tile[0]), Math.abs(ty - tile[1])) !== r) continue;
        if (!isPassable(nav, tx, ty)) continue;
        const d = Math.hypot(tx - tile[0], ty - tile[1]);
        if (d < bestD) {
          bestD = d;
          best = [tx, ty];
        }
      }
    }
    if (best) return best;
  }
  return null;
}

/**
 * Le déplacement en ligne droite d'un disque de rayon `radius` de `a` vers `b` est-il libre (murs, fosses, portes
 * fermées, blocs) ? Échantillonné tous les `step` px (balayage approximatif, avec marge de sécurité via `SWEEP_RADIUS`).
 */
export function sweepClear(
  grid: RoomGrid,
  solids: readonly PixelRect[],
  a: Vec2,
  b: Vec2,
  radius: number = SWEEP_RADIUS,
  step: number = SWEEP_STEP_PX,
): boolean {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const n = Math.max(1, Math.ceil(len / step));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    if (!canOccupy({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, radius, grid, solids)) return false;
  }
  return true;
}
