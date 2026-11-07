/**
 * STOCKAGE DE LA SAUVEGARDE — abstraction `SaveRepository` (load / save / clear) et deux implémentations :
 *  - `LocalStorageSaveRepository` : localStorage (ou tout `StorageLike` injecté : testable sans DOM) ;
 *  - `MemorySaveRepository` : en mémoire (tests, mode sans stockage).
 * Les autres supports (fichier local, Capacitor Preferences, serveur/cloud, plusieurs emplacements) se brancheront en
 * implémentant la même interface ; elle est volontairement SYNCHRONE (localStorage) — passer en asynchrone le jour où un
 * support asynchrone arrive ne touche que le menu et `AutoSaver`.
 *
 * Règles de sûreté :
 *  - chaque lecture / écriture / suppression est dans un try/catch : le jeu ne plante jamais à cause du stockage ;
 *  - `load()` ne SUPPRIME ni ne RÉÉCRIT jamais rien, même si la donnée est corrompue ou d'une version inconnue : la donnée
 *    brute reste en place jusqu'à un `clear()` explicite (appelé après confirmation du joueur) ;
 *  - une écriture qui échoue (quota, stockage bloqué) laisse l'ancienne valeur intacte et retourne une erreur.
 */
import { SAVE_SCHEMA_VERSION, parseSave, serializeSave, type SaveContext, type SaveGame, type SaveParseError } from './save';

/** Clé localStorage de la sauvegarde (le numéro de version de schéma est DANS la donnée, pas dans la clé). */
export const SAVE_STORAGE_KEY = 'vaelorn.save';

/** Sous-ensemble de l'API Storage utilisé (localStorage, sessionStorage, faux stockage de test…). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Cause d'un échec de stockage (la scène la traduit via `save.error.<code>`). */
export type SaveStorageErrorCode = 'quota' | 'unavailable';

export interface SaveStorageError {
  code: SaveStorageErrorCode;
  /** Message technique de l'exception d'origine (diagnostic). */
  message: string;
}

/** Résultat de `load()`. `corrupt` : la donnée brute est CONSERVÉE dans le stockage. */
export type SaveLoadResult =
  | { status: 'none' }
  | { status: 'ok'; save: SaveGame; migratedFrom: number | null }
  | { status: 'corrupt'; error: SaveParseError }
  | { status: 'unavailable'; error: SaveStorageError };

/** Résultat d'une écriture ou d'une suppression. */
export type SaveWriteResult = { ok: true } | { ok: false; error: SaveStorageError };

export interface SaveRepository {
  /** Lit et valide la sauvegarde. Ne modifie jamais le stockage. */
  load(): SaveLoadResult;
  /** Écrit la sauvegarde (version de schéma courante). */
  save(game: SaveGame): SaveWriteResult;
  /** Supprime la sauvegarde. À n'appeler qu'après confirmation explicite du joueur. */
  clear(): SaveWriteResult;
}

/** Convertit une exception de stockage en erreur typée (quota dépassé vs stockage indisponible). */
export function classifyStorageError(err: unknown): SaveStorageError {
  const name = typeof err === 'object' && err !== null && 'name' in err ? String((err as { name: unknown }).name) : '';
  const code = typeof err === 'object' && err !== null && 'code' in err ? Number((err as { code: unknown }).code) : NaN;
  const message = err instanceof Error ? err.message : String(err);
  const quota =
    name === 'QuotaExceededError' ||
    name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    code === 22 ||
    code === 1014 ||
    /quota/i.test(message);
  return { code: quota ? 'quota' : 'unavailable', message };
}

/** Logique commune : lecture/écriture brutes fournies par la sous-classe, validation et sérialisation ici. */
abstract class RawSaveRepository implements SaveRepository {
  constructor(protected readonly context: SaveContext) {}

  protected abstract readRaw(): string | null;
  protected abstract writeRaw(value: string): void;
  protected abstract removeRaw(): void;

  load(): SaveLoadResult {
    let raw: string | null;
    try {
      raw = this.readRaw();
    } catch (err) {
      return { status: 'unavailable', error: classifyStorageError(err) };
    }
    if (raw === null || raw === undefined) return { status: 'none' };
    // Une chaîne vide n'est pas une sauvegarde valide : elle est traitée comme corrompue (et conservée), pas comme absente.
    const parsed = parseSave(raw, this.context);
    if (!parsed.ok) return { status: 'corrupt', error: parsed.error };
    return { status: 'ok', save: parsed.save, migratedFrom: parsed.migratedFrom };
  }

  save(game: SaveGame): SaveWriteResult {
    try {
      this.writeRaw(serializeSave({ ...game, schemaVersion: SAVE_SCHEMA_VERSION }));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: classifyStorageError(err) };
    }
  }

  clear(): SaveWriteResult {
    try {
      this.removeRaw();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: classifyStorageError(err) };
    }
  }
}

/**
 * Sauvegarde dans un `StorageLike` (localStorage par défaut côté navigateur, voir `src/render/saveStore.ts`).
 * `storage` peut être une fonction : elle est rappelée à chaque accès (utile quand `localStorage` n'existe pas ou lève
 * une exception à l'accès — mode navigation privée, cookies bloqués — : l'exception est alors attrapée comme les autres).
 */
export class LocalStorageSaveRepository extends RawSaveRepository {
  private readonly getStorage: () => StorageLike | null | undefined;

  constructor(
    context: SaveContext,
    storage: StorageLike | (() => StorageLike | null | undefined),
    private readonly key: string = SAVE_STORAGE_KEY,
  ) {
    super(context);
    this.getStorage = typeof storage === 'function' ? storage : () => storage;
  }

  private storage(): StorageLike {
    const s = this.getStorage();
    if (!s) throw new Error('Stockage indisponible');
    return s;
  }

  protected readRaw(): string | null {
    return this.storage().getItem(this.key);
  }

  protected writeRaw(value: string): void {
    this.storage().setItem(this.key, value);
  }

  protected removeRaw(): void {
    this.storage().removeItem(this.key);
  }
}

/** Options de `MemorySaveRepository` (simulation de pannes pour les tests). */
export interface MemorySaveOptions {
  /** Contenu brut initial (peut être volontairement invalide). */
  raw?: string | null;
  /** Fait échouer les écritures avec cette erreur (quota, stockage bloqué…). */
  failWrites?: SaveStorageError | null;
  /** Fait échouer les lectures avec cette erreur. */
  failReads?: SaveStorageError | null;
}

/** Sauvegarde en mémoire. `raw` expose la donnée brute (assertions « rien n'a été supprimé »). */
export class MemorySaveRepository extends RawSaveRepository {
  raw: string | null;
  failWrites: SaveStorageError | null;
  failReads: SaveStorageError | null;
  /** Nombre d'écritures / suppressions effectuées avec succès (assertions). */
  writes = 0;
  clears = 0;

  constructor(context: SaveContext, options: MemorySaveOptions = {}) {
    super(context);
    this.raw = options.raw ?? null;
    this.failWrites = options.failWrites ?? null;
    this.failReads = options.failReads ?? null;
  }

  protected readRaw(): string | null {
    if (this.failReads) throw Object.assign(new Error(this.failReads.message), { name: this.failReads.code === 'quota' ? 'QuotaExceededError' : 'SecurityError' });
    return this.raw;
  }

  protected writeRaw(value: string): void {
    if (this.failWrites) throw Object.assign(new Error(this.failWrites.message), { name: this.failWrites.code === 'quota' ? 'QuotaExceededError' : 'SecurityError' });
    this.raw = value;
    this.writes++;
  }

  protected removeRaw(): void {
    if (this.failWrites) throw Object.assign(new Error(this.failWrites.message), { name: this.failWrites.code === 'quota' ? 'QuotaExceededError' : 'SecurityError' });
    this.raw = null;
    this.clears++;
  }
}
