import type { LevelDef } from '../core/types';
import { level1 } from './level1';
import { level2 } from './level2';
import { level3 } from './level3';

/** Niveaux du jeu, dans l'ordre de progression linéaire. Pour ajouter un niveau : créer levelN.ts et l'ajouter ici. */
export const LEVELS: readonly LevelDef[] = [level1, level2, level3];

/** Retourne le niveau d'identifiant `id` (ex. 'level1'), ou undefined. */
export function getLevel(id: string): LevelDef | undefined {
  return LEVELS.find((l) => l.id === id);
}

/** Retourne le niveau à l'indice donné (0-based), ou undefined s'il n'y en a plus. */
export function getLevelByIndex(index: number): LevelDef | undefined {
  return LEVELS[index];
}
