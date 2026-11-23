/**
 * Version du build, affichée en petit dans le menu principal : « v0.1.0 · 509b48e · 23/11/2026 ».
 *
 * Les valeurs sont injectées au build par `vite.config.ts` (constante `__BUILD_INFO__`, voir scripts/build-info.mjs). Le hash est
 * celui du commit sur GitHub : il suffit de le comparer au dernier commit de `main` pour savoir si l'on a la dernière version.
 * Hors build (tests Node sans la constante), on retombe sur `UNKNOWN_BUILD`.
 */

import type { Language } from './i18n/i18n';

export interface BuildInfo {
  /** Numéro de `package.json`. */
  readonly version: string;
  /** Hash court du commit construit, ou `null` si inconnu (pas de git). */
  readonly commit: string | null;
  /** Date (AAAA-MM-JJ) du commit, ou `null` si inconnue. */
  readonly date: string | null;
}

declare const __BUILD_INFO__: BuildInfo | undefined;

/** Valeur de repli quand rien n'a été injecté. */
export const UNKNOWN_BUILD: BuildInfo = { version: '0.0.0', commit: null, date: null };

/** Informations du build courant (jamais d'exception). */
export function getBuildInfo(): BuildInfo {
  return typeof __BUILD_INFO__ !== 'undefined' && __BUILD_INFO__ ? __BUILD_INFO__ : UNKNOWN_BUILD;
}

/** « 2026-11-23 » → « 23/11/2026 » en français, inchangé en anglais (format ISO) ; chaîne illisible → renvoyée telle quelle. */
export function formatBuildDate(iso: string, lang: Language): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return lang === 'fr' ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

/** Libellé affiché : « v0.1.0 · 509b48e · 23/11/2026 » (les parties inconnues sont omises : « v0.1.0 » seul au pire). */
export function formatBuildLabel(info: BuildInfo, lang: Language): string {
  const parts = [`v${info.version}`];
  if (info.commit) parts.push(info.commit);
  if (info.date) parts.push(formatBuildDate(info.date, lang));
  return parts.join(' · ');
}
