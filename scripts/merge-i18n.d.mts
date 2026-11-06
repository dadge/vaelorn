/** Déclarations de types pour scripts/merge-i18n.mjs (utilisé par src/i18n/i18n.test.ts). */

export interface MergeOptions {
  /** Dossier i18n (contient fr.json, en.json, parts/). Défaut : src/i18n. */
  dir?: string;
  /** N'écrit ni ne supprime rien. */
  dryRun?: boolean;
  /** Conserve les fichiers de parts après fusion. */
  keep?: boolean;
  /** Réception des messages d'information. */
  log?: (msg: string) => void;
}

export interface MergeResult {
  dir: string;
  /** Chemins relatifs (parts/xxx.fr.json) des parts traitées. */
  processed: string[];
  added: { fr: number; en: number };
  total: { fr: number; en: number };
  written: boolean;
  removed: boolean;
}

export class I18nMergeError extends Error {
  problems: string[];
  constructor(problems: string[]);
}

export function mergeI18n(options?: MergeOptions): MergeResult;

export function parseArgs(argv: string[]): { dir?: string; dryRun: boolean; keep: boolean; help: boolean };
