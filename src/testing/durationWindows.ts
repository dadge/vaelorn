/**
 * Fenêtres de durée (temps simulé, bots de test, difficulté 2) des niveaux 7 à 9, MESURÉES sur un balayage de graines (voir `durationWindows.run.test.ts`) :
 *  - 1 joueur : niveau 7 ≤ 13 min (mesuré 660-739 s), niveau 8 ≤ 13,5 min (688-771 s), niveau 9 ≤ 15,5 min (691-888 s : le seigneur du Néant coûte 1 à 3 défaites de bot) ;
 *  - 2 joueurs : ≤ 10,5 min pour les trois niveaux (mesuré 519-613 s) ;
 *  - 3 et 4 joueurs : ≤ 10 min (mesuré 460-560 s).
 * Les bots n'ont ni soin, ni butin, ni cristaux, et n'esquivent pas : valeurs pessimistes pour un joueur humain (TODO.md « Marges de durée »).
 */
export const MINUTE_MS = 60 * 1000;
/** Durée minimale (ms) d'un niveau complet, quel que soit le nombre de joueurs. */
export const MIN_DURATION_MS = 5 * MINUTE_MS;
/** Plafond (ms) d'un niveau complet joué SEUL, par numéro de niveau. */
export const SOLO_CAP_MS: Readonly<Record<7 | 8 | 9, number>> = { 7: 13 * MINUTE_MS, 8: 13.5 * MINUTE_MS, 9: 15.5 * MINUTE_MS };
/** Plafond (ms) à 2 joueurs. */
export const DUO_CAP_MS = 10.5 * MINUTE_MS;
/** Plafond (ms) à 3 et 4 joueurs. */
export const GROUP_CAP_MS = 10 * MINUTE_MS;

/** Plafond de durée (ms) d'un niveau complet du bloc 7-9 pour `n` joueurs. */
export function durationCapMs(level: 7 | 8 | 9, n: number): number {
  return n <= 1 ? SOLO_CAP_MS[level] : n === 2 ? DUO_CAP_MS : GROUP_CAP_MS;
}

/** Graines du balayage : 1 à 6 en solo et en duo (les cas les plus longs), 1 à 3 à 3 et 4 joueurs. */
export const SWEEP_SEEDS: Readonly<Record<number, readonly number[]>> = { 1: [1, 2, 3, 4, 5, 6], 2: [1, 2, 3, 4, 5, 6], 3: [1, 2, 3], 4: [1, 2, 3] };
