/**
 * PRNG déterministe (mulberry32) — logique pure, sans Math.random.
 *
 * L'état du générateur est un entier 32 bits stocké dans un « holder » `{ rngState: number }`.
 * `GameState` satisfait directement cette interface : on peut donc écrire `nextRandom(state)`.
 * Sauvegarder / restaurer l'état = copier `rngState` (c'est un simple nombre, JSON-sérialisable).
 *
 * Les fonctions de ce module MUTENT `holder.rngState` (c'est leur seul effet de bord).
 */

/** Tout objet portant l'état du PRNG (GameState l'est déjà). */
export interface RngHolder {
  /** État mulberry32 : entier 32 bits signé (résultat de `| 0`). */
  rngState: number;
}

/**
 * Convertit une graine quelconque (entier, flottant, négatif…) en état initial mulberry32 bien « mélangé ».
 * Deux graines voisines (1 et 2) donnent des états très différents. Déterministe, sans effet de bord.
 * Une graine non finie (NaN, ±Infinity) est traitée comme 0.
 * @param seed graine d'entrée (ex. `SimConfig.seed`)
 * @returns entier 32 bits signé, à placer dans `rngState`
 */
export function seedToState(seed: number): number {
  const s = Number.isFinite(seed) ? Math.floor(seed) : 0;
  let x = (s | 0) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x ^= x >>> 16;
  return x | 0;
}

/**
 * Crée un holder initialisé depuis une graine : `{ rngState: seedToState(seed) }`.
 * @param seed graine d'entrée
 */
export function createRng(seed: number): RngHolder {
  return { rngState: seedToState(seed) };
}

/**
 * Tire un nombre pseudo-aléatoire uniforme dans [0, 1) et fait avancer `holder.rngState`.
 * @param holder objet portant `rngState` (muté)
 */
export function nextRandom(holder: RngHolder): number {
  holder.rngState = (holder.rngState + 0x6d2b79f5) | 0;
  let t = holder.rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * Nombre flottant uniforme dans [min, max). Consomme un tirage. Si max < min, les bornes sont simplement interpolées
 * (le résultat est alors dans (max, min]).
 * @param holder objet portant `rngState` (muté)
 */
export function randomRange(holder: RngHolder, min: number, max: number): number {
  return min + nextRandom(holder) * (max - min);
}

/**
 * Entier uniforme dans [0, maxExclusive). Consomme un tirage.
 * Si `maxExclusive <= 0` (ou non fini), retourne 0 SANS consommer de tirage.
 * @param holder objet portant `rngState` (muté)
 * @param maxExclusive borne supérieure exclue
 */
export function randomInt(holder: RngHolder, maxExclusive: number): number {
  if (!(maxExclusive > 0) || !Number.isFinite(maxExclusive)) return 0;
  return Math.floor(nextRandom(holder) * Math.floor(maxExclusive));
}

/**
 * Choisit un élément uniformément dans un tableau non vide. Consomme un tirage.
 * @throws RangeError si le tableau est vide
 */
export function randomPick<T>(holder: RngHolder, arr: readonly T[]): T {
  if (arr.length === 0) throw new RangeError('randomPick: tableau vide');
  return arr[randomInt(holder, arr.length)];
}

/**
 * Adapte un holder en fonction `() => number` (ex. `EnemyAIContext.random`). Chaque appel fait avancer l'état.
 */
export function randomFn(holder: RngHolder): () => number {
  return () => nextRandom(holder);
}
