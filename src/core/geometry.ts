/**
 * Géométrie 2D pure (aucune dépendance à Phaser/DOM).
 *
 * Conventions :
 *  - repère écran : x vers la droite, y vers le BAS ;
 *  - angles en radians, 0 = droite, +π/2 = bas, -π/2 = haut (convention de `Math.atan2(dy, dx)`) ;
 *  - toutes les fonctions retournent de NOUVEAUX objets (aucune mutation des arguments).
 */
import { TILE } from './constants';
import type { Aim8, DiagDir, Dir, TileRect, TileXY, Vec2 } from './types';

/** Distance au carré entre deux points (évite la racine pour les comparaisons). */
export function distSq(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/** Distance euclidienne entre deux points. */
export function dist(a: Vec2, b: Vec2): number {
  return Math.sqrt(distSq(a, b));
}

/** Norme (longueur) d'un vecteur. */
export function length(v: Vec2): number {
  return Math.sqrt(v.x * v.x + v.y * v.y);
}

/** Vecteur unitaire de même direction ; le vecteur nul reste nul ({0,0}). */
export function normalize(v: Vec2): Vec2 {
  const l = length(v);
  if (l < 1e-9) return { x: 0, y: 0 };
  return { x: v.x / l, y: v.y / l };
}

/** Borne `v` dans [min, max]. */
export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/** Interpolation linéaire : a + (b - a) × t (t non borné). */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Vecteur UNITAIRE d'une direction de visée : cardinale (up = (0,-1), down = (0,1), left = (-1,0), right = (1,0)) ou diagonale
 * (±√½ sur chaque axe : même longueur 1, donc même vitesse de projectile / même portée qu'en cardinal).
 */
export function dirVec(dir: Aim8): Vec2 {
  switch (dir) {
    case 'up':
      return { x: 0, y: -1 };
    case 'down':
      return { x: 0, y: 1 };
    case 'left':
      return { x: -1, y: 0 };
    case 'right':
      return { x: 1, y: 0 };
    case 'upLeft':
      return { x: -Math.SQRT1_2, y: -Math.SQRT1_2 };
    case 'upRight':
      return { x: Math.SQRT1_2, y: -Math.SQRT1_2 };
    case 'downLeft':
      return { x: -Math.SQRT1_2, y: Math.SQRT1_2 };
    case 'downRight':
      return { x: Math.SQRT1_2, y: Math.SQRT1_2 };
  }
}

/** Les 8 directions de visée, par pas de 45° dans le sens horaire à l'écran en partant de la droite (index = angle / 45°). */
const AIM8_ORDER: readonly Aim8[] = ['right', 'downRight', 'down', 'downLeft', 'left', 'upLeft', 'up', 'upRight'];

/** La visée est-elle une diagonale ? */
export function isDiagonal(a: Aim8): a is DiagDir {
  return a === 'upLeft' || a === 'upRight' || a === 'downLeft' || a === 'downRight';
}

/** Les deux composantes cardinales d'une diagonale : [horizontale, verticale] (ex. 'upLeft' → ['left', 'up']). */
export function diagComponents(d: DiagDir): [Dir, Dir] {
  switch (d) {
    case 'upLeft':
      return ['left', 'up'];
    case 'upRight':
      return ['right', 'up'];
    case 'downLeft':
      return ['left', 'down'];
    case 'downRight':
      return ['right', 'down'];
  }
}

/**
 * Direction cardinale (sprite 4 directions) d'une visée : la visée elle-même si cardinale, sinon sa composante HORIZONTALE (le héros
 * est dessiné de profil en diagonale). Pour retrouver la composante réellement tenue, préférer `facing`.
 */
export function cardinalOfAim(a: Aim8): Dir {
  return isDiagonal(a) ? diagComponents(a)[0] : a;
}

/**
 * Snap d'un vecteur (déplacement) en 8 directions : secteurs de 45° centrés sur les cardinales et les diagonales (frontières à 22,5° ;
 * un clavier à 2 touches donne la diagonale exacte, un stick analogique le secteur le plus proche).
 * - vecteur (quasi) nul → `fallback` ;
 * - `hysteresisDeg` > 0 : si l'angle du vecteur reste à moins de 22,5° + `hysteresisDeg` du centre du secteur `fallback`, ce secteur est conservé
 *   (le stick qui frôle une frontière ne fait pas trembler la visée).
 * @param v vecteur (repère écran, y vers le bas)
 * @param fallback visée à retourner si `v` est nul, et secteur courant pour l'hystérésis
 * @param hysteresisDeg marge d'hystérésis en degrés (défaut 0)
 */
export function aim8FromVec(v: Vec2, fallback: Aim8, hysteresisDeg = 0): Aim8 {
  if (Math.abs(v.x) < 1e-9 && Math.abs(v.y) < 1e-9) return fallback;
  const step = Math.PI / 4;
  const ang = Math.atan2(v.y, v.x);
  if (hysteresisDeg > 0) {
    const fi = AIM8_ORDER.indexOf(fallback);
    if (fi >= 0 && angleDiff(ang, fi * step) <= ((22.5 + hysteresisDeg) * Math.PI) / 180) return fallback;
  }
  const idx = ((Math.round(ang / step) % 8) + 8) % 8;
  return AIM8_ORDER[idx];
}

/**
 * Direction cardinale dominante d'un vecteur.
 * - vecteur (quasi) nul → `fallback` ;
 * - axe dominant = celui de plus grande valeur absolue ;
 * - égalité parfaite (diagonale) : on garde `fallback` s'il est compatible avec la diagonale, sinon l'axe horizontal.
 * @param v vecteur (déplacement, visée…)
 * @param fallback direction à retourner si `v` est nul
 */
export function dirFromVec(v: Vec2, fallback: Dir): Dir {
  const ax = Math.abs(v.x);
  const ay = Math.abs(v.y);
  if (ax < 1e-9 && ay < 1e-9) return fallback;
  const horiz: Dir = v.x < 0 ? 'left' : 'right';
  const vert: Dir = v.y < 0 ? 'up' : 'down';
  if (Math.abs(ax - ay) < 1e-9) {
    return fallback === horiz || fallback === vert ? fallback : horiz;
  }
  return ax > ay ? horiz : vert;
}

/** Direction opposée (up ↔ down, left ↔ right). */
export function oppositeDir(dir: Dir): Dir {
  switch (dir) {
    case 'up':
      return 'down';
    case 'down':
      return 'up';
    case 'left':
      return 'right';
    case 'right':
      return 'left';
  }
}

/** Deux disques (centre, rayon) se chevauchent-ils ? (contact tangent exact = non). */
export function circleOverlap(a: Vec2, ra: number, b: Vec2, rb: number): boolean {
  const r = ra + rb;
  return distSq(a, b) < r * r;
}

/**
 * Le point (en pixels) est-il dans le rectangle `rect` exprimé en TUILES ? Bords : gauche/haut inclus, droite/bas exclus.
 */
export function pointInTileRect(p: Vec2, rect: TileRect): boolean {
  return (
    p.x >= rect.x * TILE &&
    p.x < (rect.x + rect.w) * TILE &&
    p.y >= rect.y * TILE &&
    p.y < (rect.y + rect.h) * TILE
  );
}

/** Centre (en pixels) de la tuile (tx, ty). */
export function tileCenter(tx: number, ty: number): Vec2 {
  return { x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE };
}

/** Coin haut-gauche (en pixels) de la tuile (tx, ty). */
export function tileToPx(tx: number, ty: number): Vec2 {
  return { x: tx * TILE, y: ty * TILE };
}

/** Tuile [colonne, ligne] contenant le point pixel `pos`. */
export function tileOf(pos: Vec2): TileXY {
  return [Math.floor(pos.x / TILE), Math.floor(pos.y / TILE)];
}

/** Angle (radians, ∈ (-π, π]) du vecteur allant de `from` vers `to`. 0 = droite, π/2 = bas. */
export function angleBetween(from: Vec2, to: Vec2): number {
  return Math.atan2(to.y - from.y, to.x - from.x);
}

/** Vecteur de longueur `len` (défaut 1) dans la direction `angle` (radians). */
export function vecFromAngle(angle: number, len = 1): Vec2 {
  return { x: Math.cos(angle) * len, y: Math.sin(angle) * len };
}

/** Ramène un angle (radians) dans (-π, π]. */
export function normalizeAngle(a: number): number {
  const twoPi = Math.PI * 2;
  let r = a % twoPi;
  if (r > Math.PI) r -= twoPi;
  else if (r <= -Math.PI) r += twoPi;
  return r;
}

/** Écart angulaire absolu le plus court entre deux angles (radians, ∈ [0, π]). */
export function angleDiff(a: number, b: number): number {
  return Math.abs(normalizeAngle(a - b));
}

/**
 * Une cible (disque de rayon `targetRadius`) est-elle touchée par un arc de mêlée ?
 * - distance centre→centre ≤ `range + targetRadius` ;
 * - et direction de la cible dans ±`arcDeg/2` autour de `facingAngle`, avec une tolérance angulaire
 *   asin(targetRadius / distance) pour que le rayon de la cible compte (une cible large est touchée « de biais »).
 * - Une cible qui recouvre l'origine (distance ≤ targetRadius) est toujours touchée.
 * - `arcDeg >= 360` ⇒ simple test de portée (cercle complet).
 * @param origin centre de l'attaquant (px)
 * @param facingAngle direction de l'attaque (radians, voir `angleBetween`/`dirVec`)
 * @param target centre de la cible (px)
 * @param range portée de l'arc depuis l'origine (px)
 * @param arcDeg ouverture totale de l'arc en degrés
 * @param targetRadius rayon de la cible (px), défaut 0
 */
export function isInArc(
  origin: Vec2,
  facingAngle: number,
  target: Vec2,
  range: number,
  arcDeg: number,
  targetRadius = 0,
): boolean {
  const d = dist(origin, target);
  if (d > range + targetRadius) return false;
  if (d <= targetRadius) return true;
  if (arcDeg >= 360) return true;
  const half = (arcDeg * Math.PI) / 360;
  const margin = Math.asin(Math.min(1, targetRadius / d));
  return angleDiff(angleBetween(origin, target), facingAngle) <= half + margin + 1e-9;
}
