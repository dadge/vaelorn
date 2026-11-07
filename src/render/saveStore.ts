/**
 * Accès partagé à la sauvegarde pour les scènes : dépôt (`SaveRepository`) et contexte (niveaux connus).
 *
 * Par défaut : localStorage du navigateur (clé `SAVE_STORAGE_KEY`), lu paresseusement et protégé par try/catch (mode
 * navigation privée, cookies bloqués, Node). Pour brancher un autre support (fichier local, Capacitor Preferences,
 * serveur…), appeler `setSaveRepository` au démarrage avec une autre implémentation de `SaveRepository`.
 */
import { saveContextFromLevels, type SaveContext } from '../core/save';
import { LocalStorageSaveRepository, type SaveRepository, type StorageLike } from '../core/saveRepository';
import { LEVELS } from '../levels';

/** Niveaux connus du jeu (identifiants et nombre de salles, d'après la liste `LEVELS`). */
export function getSaveContext(): SaveContext {
  return saveContextFromLevels(LEVELS);
}

function browserStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // l'accès à `localStorage` peut lui-même lever une exception (stockage bloqué)
  }
}

let repository: SaveRepository | null = null;

/** Dépôt de sauvegarde courant (localStorage par défaut). */
export function getSaveRepository(): SaveRepository {
  if (!repository) {
    repository = new LocalStorageSaveRepository(getSaveContext(), browserStorage);
  }
  return repository;
}

/** Remplace le dépôt (autre support de stockage, tests). `null` : revient au localStorage. */
export function setSaveRepository(next: SaveRepository | null): void {
  repository = next;
}
