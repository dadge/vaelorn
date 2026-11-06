import type { PlayerId } from './types';

/**
 * Coop adaptative : les slots (0..3) définis dans les niveaux (objectifs, clés, leviers, vision)
 * sont repliés sur les joueurs réellement présents : slot % nbJoueurs.
 * Avec 4 joueurs : slot i → J(i+1). Avec 2 joueurs : slots 0,2 → J1 ; slots 1,3 → J2. Avec 1 : tout → J1.
 */
export function resolveSlot(slot: number, playerCount: number): PlayerId {
  const n = Math.max(1, Math.min(4, Math.floor(playerCount)));
  const s = ((Math.floor(slot) % n) + n) % n;
  return s as PlayerId;
}
