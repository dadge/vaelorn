/**
 * Collisions (logique pure, déterministe, sans Phaser/DOM).
 *
 * Les personnages (joueurs, ennemis) sont des DISQUES (centre + rayon, en pixels) qui se déplacent contre :
 *  - la grille statique de la salle (`RoomGrid.blocksMovement` : murs, piliers, vide, fosses) ;
 *  - des rectangles « solides » dynamiques : portes fermées et blocs poussables (`mechanismSolidRects`).
 *
 * Les entités VOLANTES (`flying`, ex. chauve-souris, feu follet, Morvane) ne sont pas arrêtées par les fosses (`~`) :
 * murs, piliers, vide, portes fermées et blocs les bloquent toujours.
 *
 * Les projectiles, eux, sont arrêtés par les murs/piliers/vide, les portes fermées et les blocs, mais PAS par les fosses
 * (`RoomGrid.blocksProjectile`).
 *
 * Conventions :
 *  - un contact tangent exact n'est PAS une collision (un disque peut longer un mur à frottement nul) ;
 *  - aucune fonction ne mute ses arguments : les positions retournées sont de nouveaux objets ;
 *  - toute valeur non finie (NaN, ±Infinity) en entrée est neutralisée (déplacement nul, position conservée).
 */
import { TILE } from './constants';
import type { RoomGrid } from './grid';
import type { PixelRect } from './mechanisms';
import type { Vec2 } from './types';

export type { PixelRect } from './mechanisms';

/** Longueur maximale (px) d'un sous-pas de déplacement : garantit l'absence de tunnelage (< rayon et < épaisseur d'un mur). */
export const MAX_MOVE_SUBSTEP = 2;
/** Nombre maximal de sous-pas par appel de `moveCircle` (borne de sécurité pour les déplacements aberrants). */
const MAX_SUBSTEPS = 256;
/** Marge (px) ajoutée lors d'une extraction hors d'un solide, pour sortir franchement du contact. */
const DEPENETRATION_EPS = 0.01;
/** Itérations de dichotomie pour s'arrêter au contact d'un obstacle. */
const BISECT_ITERATIONS = 7;
/** Pas d'échantillonnage (px) de `segmentBlocked`. */
const SEGMENT_SAMPLE_PX = 3;

const NO_SOLIDS: readonly PixelRect[] = [];

// ───────────────────────────── Primitives cercle / rectangle ─────────────────────────────

/**
 * Un disque (centre `cx,cy`, rayon `r`) chevauche-t-il le rectangle `rect` ? Contact tangent = non (comparaison stricte).
 * Un rayon ≤ 0 est traité comme un point (contenu dans le rectangle, bord gauche/haut inclus, droite/bas exclus).
 */
export function circleIntersectsRect(cx: number, cy: number, r: number, rect: PixelRect): boolean {
  if (r <= 0) return pointInRect(cx, cy, rect);
  const nx = Math.max(rect.x, Math.min(cx, rect.x + rect.w));
  const ny = Math.max(rect.y, Math.min(cy, rect.y + rect.h));
  const dx = cx - nx;
  const dy = cy - ny;
  return dx * dx + dy * dy < r * r;
}

/** Le point (px,py) est-il dans le rectangle ? (gauche/haut inclus, droite/bas exclus) */
export function pointInRect(px: number, py: number, rect: PixelRect): boolean {
  return px >= rect.x && px < rect.x + rect.w && py >= rect.y && py < rect.y + rect.h;
}

/** Deux rectangles se chevauchent-ils ? (contact par le bord = non) */
export function rectsOverlap(a: PixelRect, b: PixelRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Rectangle pixel d'une tuile (tx, ty). */
export function tileRectPx(tx: number, ty: number): PixelRect {
  return { x: tx * TILE, y: ty * TILE, w: TILE, h: TILE };
}

function isFiniteVec(v: Vec2): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y);
}

/** La tuile (tx, ty) bloque-t-elle ce type de déplacement ? Les volants ignorent les fosses. */
function tileBlocks(grid: RoomGrid, tx: number, ty: number, flying: boolean): boolean {
  return flying ? grid.isWall(tx, ty) : grid.blocksMovement(tx, ty);
}

// ───────────────────────────── Occupation ─────────────────────────────

/**
 * Un disque (centre `pos`, rayon `radius`) peut-il occuper cette position ? Faux s'il chevauche une tuile qui bloque le
 * déplacement (mur, pilier, vide, fosse) ou l'un des rectangles `solids` (portes fermées, blocs). Faux si `pos` n'est pas fini.
 * @param pos centre du disque (px)
 * @param radius rayon (px)
 * @param grid grille statique de la salle
 * @param solids rectangles solides dynamiques (voir `mechanismSolidRects`)
 * @param flying vrai : les fosses ne bloquent pas (entités volantes)
 */
export function canOccupy(
  pos: Vec2,
  radius: number,
  grid: RoomGrid,
  solids: readonly PixelRect[] = NO_SOLIDS,
  flying = false,
): boolean {
  if (!isFiniteVec(pos) || !Number.isFinite(radius)) return false;
  const r = Math.max(0, radius);
  const x0 = Math.floor((pos.x - r) / TILE);
  const x1 = Math.floor((pos.x + r) / TILE);
  const y0 = Math.floor((pos.y - r) / TILE);
  const y1 = Math.floor((pos.y + r) / TILE);
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      if (tileBlocks(grid, tx, ty, flying) && circleIntersectsRect(pos.x, pos.y, r, tileRectPx(tx, ty))) return false;
    }
  }
  for (const s of solids) {
    if (circleIntersectsRect(pos.x, pos.y, r, s)) return false;
  }
  return true;
}

/**
 * Vecteur de sortie minimal pour extraire un disque d'un rectangle (nul si pas de chevauchement).
 * Si le centre est à l'intérieur du rectangle, on sort par la face la plus proche.
 */
function pushOutOfRect(cx: number, cy: number, r: number, rect: PixelRect): Vec2 | null {
  if (!circleIntersectsRect(cx, cy, r, rect)) return null;
  const nx = Math.max(rect.x, Math.min(cx, rect.x + rect.w));
  const ny = Math.max(rect.y, Math.min(cy, rect.y + rect.h));
  const dx = cx - nx;
  const dy = cy - ny;
  const d2 = dx * dx + dy * dy;
  if (d2 > 1e-12) {
    const d = Math.sqrt(d2);
    const k = (r - d + DEPENETRATION_EPS) / d;
    return { x: dx * k, y: dy * k };
  }
  // Centre dans le rectangle (ou sur son bord) : sortie par la face la plus proche.
  const left = cx - rect.x;
  const right = rect.x + rect.w - cx;
  const top = cy - rect.y;
  const bottom = rect.y + rect.h - cy;
  const m = Math.min(left, right, top, bottom);
  if (m === left) return { x: -(left + r + DEPENETRATION_EPS), y: 0 };
  if (m === right) return { x: right + r + DEPENETRATION_EPS, y: 0 };
  if (m === top) return { x: 0, y: -(top + r + DEPENETRATION_EPS) };
  return { x: 0, y: bottom + r + DEPENETRATION_EPS };
}

/**
 * Extrait un disque des obstacles qui le recouvrent (ex. bloc poussé sur un ennemi, apparition dans un décor).
 * Retourne la position corrigée (la même position si rien ne la recouvre). Itératif, borné ; si le disque est pris en
 * étau (couloir trop étroit) la meilleure position trouvée est retournée.
 * @param pos centre du disque (px)
 * @param radius rayon (px)
 * @param grid grille statique
 * @param solids rectangles solides dynamiques
 * @param flying vrai : les fosses ne comptent pas comme obstacles
 */
export function resolveOverlap(
  pos: Vec2,
  radius: number,
  grid: RoomGrid,
  solids: readonly PixelRect[] = NO_SOLIDS,
  flying = false,
): Vec2 {
  if (!isFiniteVec(pos) || !Number.isFinite(radius)) return { x: pos.x, y: pos.y };
  const r = Math.max(0, radius);
  let x = pos.x;
  let y = pos.y;
  for (let iter = 0; iter < 8; iter++) {
    let moved = false;
    const x0 = Math.floor((x - r) / TILE);
    const x1 = Math.floor((x + r) / TILE);
    const y0 = Math.floor((y - r) / TILE);
    const y1 = Math.floor((y + r) / TILE);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        if (!tileBlocks(grid, tx, ty, flying)) continue;
        const push = pushOutOfRect(x, y, r, tileRectPx(tx, ty));
        if (push) {
          x += push.x;
          y += push.y;
          moved = true;
        }
      }
    }
    for (const s of solids) {
      const push = pushOutOfRect(x, y, r, s);
      if (push) {
        x += push.x;
        y += push.y;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return { x, y };
}

// ───────────────────────────── Déplacement ─────────────────────────────

/** Avance sur un seul axe de `step` (px) en s'arrêtant au contact (dichotomie). Suppose (x,y) libre. */
function slideAxis(
  x: number,
  y: number,
  step: number,
  axis: 'x' | 'y',
  radius: number,
  grid: RoomGrid,
  solids: readonly PixelRect[],
  flying: boolean,
): number {
  const base = axis === 'x' ? x : y;
  const target = base + step;
  const free = (v: number): boolean =>
    axis === 'x'
      ? canOccupy({ x: v, y }, radius, grid, solids, flying)
      : canOccupy({ x, y: v }, radius, grid, solids, flying);
  if (free(target)) return target;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < BISECT_ITERATIONS; i++) {
    const mid = (lo + hi) / 2;
    if (free(base + step * mid)) lo = mid;
    else hi = mid;
  }
  return base + step * lo;
}

/**
 * Déplace un disque de `delta` en glissant le long des obstacles (axes traités séparément, X puis Y, par sous-pas de
 * `MAX_MOVE_SUBSTEP` px au plus : pas de tunnelage même à très grande vitesse, pas de blocage le long d'un mur ni dans un
 * coin convexe). Si le disque démarre DANS un obstacle, il en est d'abord extrait (`resolveOverlap`).
 *
 * Retourne la nouvelle position (nouvel objet). Un `delta` non fini est ignoré ; une `pos` non finie est retournée telle quelle.
 * @param pos centre de départ (px)
 * @param delta déplacement souhaité (px)
 * @param radius rayon du disque (px)
 * @param grid grille statique de la salle
 * @param solids rectangles solides dynamiques (portes fermées, blocs)
 * @param flying vrai : les fosses ne bloquent pas (entités volantes)
 */
export function moveCircle(
  pos: Vec2,
  delta: Vec2,
  radius: number,
  grid: RoomGrid,
  solids: readonly PixelRect[] = NO_SOLIDS,
  flying = false,
): Vec2 {
  if (!isFiniteVec(pos) || !Number.isFinite(radius)) return { x: pos.x, y: pos.y };
  const dx = Number.isFinite(delta.x) ? delta.x : 0;
  const dy = Number.isFinite(delta.y) ? delta.y : 0;
  let cur: Vec2 = { x: pos.x, y: pos.y };
  if (!canOccupy(cur, radius, grid, solids, flying)) cur = resolveOverlap(cur, radius, grid, solids, flying);
  if (dx === 0 && dy === 0) return cur;
  const n = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / MAX_MOVE_SUBSTEP)));
  const sx = dx / n;
  const sy = dy / n;
  let x = cur.x;
  let y = cur.y;
  // Si le disque est toujours coincé (étau), on ne bouge pas plutôt que de traverser un mur.
  if (!canOccupy({ x, y }, radius, grid, solids, flying)) return { x, y };
  for (let i = 0; i < n; i++) {
    if (sx !== 0) x = slideAxis(x, y, sx, 'x', radius, grid, solids, flying);
    if (sy !== 0) y = slideAxis(x, y, sy, 'y', radius, grid, solids, flying);
  }
  return { x, y };
}

// ───────────────────────────── Projectiles ─────────────────────────────

/**
 * Un projectile (disque `radius`, 0 = point) touche-t-il un obstacle qui l'arrête ? Murs, piliers, vide hors-salle,
 * rectangles `solids` (portes fermées, blocs). Les fosses (`~`) ne bloquent PAS les projectiles.
 * @param pos centre du projectile (px) ; non fini ⇒ true (le projectile est à supprimer)
 * @param radius rayon (px)
 * @param grid grille statique
 * @param solids rectangles solides dynamiques (voir `mechanismSolidRects`)
 */
export function projectileHitsWall(
  pos: Vec2,
  radius: number,
  grid: RoomGrid,
  solids: readonly PixelRect[] = NO_SOLIDS,
): boolean {
  if (!isFiniteVec(pos) || !Number.isFinite(radius)) return true;
  const r = Math.max(0, radius);
  const x0 = Math.floor((pos.x - r) / TILE);
  const x1 = Math.floor((pos.x + r) / TILE);
  const y0 = Math.floor((pos.y - r) / TILE);
  const y1 = Math.floor((pos.y + r) / TILE);
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      if (grid.blocksProjectile(tx, ty) && circleIntersectsRect(pos.x, pos.y, r, tileRectPx(tx, ty))) return true;
    }
  }
  for (const s of solids) {
    if (circleIntersectsRect(pos.x, pos.y, r, s)) return true;
  }
  return false;
}

/**
 * Le segment [a, b] est-il coupé par un obstacle qui arrête les projectiles (mur, pilier, vide, porte fermée, bloc) ?
 * Échantillonné tous les `SEGMENT_SAMPLE_PX` px (points sans épaisseur). Sert à la ligne de vue des attaques de mêlée
 * (on ne frappe pas à travers un mur).
 */
export function segmentBlocked(
  a: Vec2,
  b: Vec2,
  grid: RoomGrid,
  solids: readonly PixelRect[] = NO_SOLIDS,
): boolean {
  if (!isFiniteVec(a) || !isFiniteVec(b)) return true;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const n = Math.max(1, Math.ceil(len / SEGMENT_SAMPLE_PX));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    if (projectileHitsWall(p, 0, grid, solids)) return true;
  }
  return false;
}
