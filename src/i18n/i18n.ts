/**
 * Internationalisation — Les Fragments de l'Aube.
 *
 * Les dictionnaires (`fr.json`, `en.json`) sont des objets PLATS : clé pointée -> chaîne
 * (ex. `"menu.play": "Jouer"`). Toute chaîne affichée dans le jeu passe par `t(clé, params?)`.
 *
 * Utilisation :
 * ```ts
 * import { t, setLanguage, onLanguageChange } from '../i18n/i18n';
 * t('menu.play');                        // « Jouer » / « Play »
 * t('hud.reviveHold', { name: 'David' }); // interpolation {name}
 * const off = onLanguageChange((lang) => relabelAll());
 * ```
 *
 * Comportement :
 * - Langue initiale : `localStorage['vaelorn.lang']` si valide, sinon `navigator.language` commençant par
 *   « fr » => `fr`, sinon `en`. La détection est paresseuse (au premier appel) et protégée pour Node.
 * - Clé manquante : `t` retourne la clé telle quelle et émet un `console.warn` (une seule fois par clé).
 * - Parts temporaires : sous Vite/Vitest, les fichiers `src/i18n/parts/*.fr.json|*.en.json` écrits par les
 *   agents de niveaux sont automatiquement superposés aux dictionnaires de base (les clés de base gagnent en
 *   cas de doublon). Avant l'intégration, `npm run i18n:merge` les fusionne dans `fr.json`/`en.json`.
 *   Sous Node pur (pas de `import.meta.glob`), seuls `fr.json`/`en.json` sont chargés.
 */

import frBase from './fr.json';
import enBase from './en.json';

/** Langues supportées. */
export type Language = 'fr' | 'en';

/** Liste des langues supportées (ordre d'affichage dans le menu). */
export const SUPPORTED_LANGUAGES: readonly Language[] = ['fr', 'en'];

/** Clé `localStorage` où la langue choisie est persistée. */
export const LANGUAGE_STORAGE_KEY = 'vaelorn.lang';

/** Paramètres d'interpolation : `{name}` dans la chaîne est remplacé par `params.name`. */
export type I18nParams = Readonly<Record<string, string | number>>;

/** Dictionnaire plat clé -> chaîne. */
export type Dictionary = Readonly<Record<string, string>>;

type MutableDict = Record<string, string>;

// ───────────────────────────── Chargement des dictionnaires ─────────────────────────────

/**
 * Parts temporaires chargées par Vite (eager). Sous Node pur `import.meta.glob` n'existe pas :
 * l'appel lève une TypeError, interceptée => aucune part.
 */
function loadFrParts(): Record<string, MutableDict> {
  try {
    return import.meta.glob<MutableDict>('./parts/*.fr.json', { eager: true, import: 'default' });
  } catch {
    return {};
  }
}

function loadEnParts(): Record<string, MutableDict> {
  try {
    return import.meta.glob<MutableDict>('./parts/*.en.json', { eager: true, import: 'default' });
  } catch {
    return {};
  }
}

/** Construit un dictionnaire = base + parts (la base l'emporte en cas de doublon ; parts triées par chemin). */
function buildDictionary(base: Dictionary, parts: Record<string, MutableDict>): Dictionary {
  const dict: MutableDict = Object.create(null) as MutableDict;
  for (const [k, v] of Object.entries(base)) dict[k] = v;
  for (const path of Object.keys(parts).sort()) {
    const part = parts[path];
    if (!part || typeof part !== 'object') continue;
    for (const [k, v] of Object.entries(part)) {
      if (typeof v === 'string' && !(k in dict)) dict[k] = v;
    }
  }
  return Object.freeze(dict);
}

const DICTIONARIES: Record<Language, Dictionary> = {
  fr: buildDictionary(frBase as Dictionary, loadFrParts()),
  en: buildDictionary(enBase as Dictionary, loadEnParts()),
};

// ───────────────────────────── État ─────────────────────────────

let currentLanguage: Language | null = null;
const listeners = new Set<(lang: Language) => void>();
const warnedKeys = new Set<string>();

/** true si `value` est une langue supportée. */
function isLanguage(value: unknown): value is Language {
  return value === 'fr' || value === 'en';
}

/**
 * Détecte la langue initiale : `localStorage['vaelorn.lang']` si valide, sinon `navigator.language`
 * commençant par « fr » => `'fr'`, sinon `'en'`. Tous les accès à `localStorage`/`navigator` sont protégés
 * (Node, mode privé, stockage bloqué…). N'a aucun effet de bord (ne persiste rien).
 */
export function detectLanguage(): Language {
  try {
    const stored = globalThis.localStorage?.getItem(LANGUAGE_STORAGE_KEY);
    if (isLanguage(stored)) return stored;
  } catch {
    /* stockage indisponible : on continue */
  }
  try {
    const lang = globalThis.navigator?.language;
    if (typeof lang === 'string' && lang.toLowerCase().startsWith('fr')) return 'fr';
  } catch {
    /* navigator indisponible */
  }
  return 'en';
}

function ensureLanguage(): Language {
  if (currentLanguage === null) currentLanguage = detectLanguage();
  return currentLanguage;
}

/** Langue courante (détectée au premier appel si `setLanguage` n'a jamais été appelé). */
export function getLanguage(): Language {
  return ensureLanguage();
}

/**
 * Change la langue, la persiste dans `localStorage` (try/catch) et notifie les abonnés si elle a changé.
 * Une langue non supportée est ignorée (avertissement console).
 */
export function setLanguage(lang: Language): void {
  if (!isLanguage(lang)) {
    console.warn(`[i18n] Langue non supportée : ${String(lang)}`);
    return;
  }
  const previous = ensureLanguage();
  currentLanguage = lang;
  try {
    globalThis.localStorage?.setItem(LANGUAGE_STORAGE_KEY, lang);
  } catch {
    /* persistance impossible : sans gravité */
  }
  try {
    if (typeof document !== 'undefined' && document.documentElement) document.documentElement.lang = lang;
  } catch {
    /* pas de DOM */
  }
  if (previous === lang) return;
  for (const cb of Array.from(listeners)) {
    try {
      cb(lang);
    } catch (err) {
      console.error('[i18n] Erreur dans un abonné onLanguageChange', err);
    }
  }
}

/**
 * S'abonne aux changements de langue. Le callback reçoit la nouvelle langue.
 * @returns une fonction de désabonnement (à appeler dans `shutdown`/`destroy` des scènes).
 */
export function onLanguageChange(cb: (lang: Language) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// ───────────────────────────── Traduction ─────────────────────────────

/** Dictionnaire complet (base + parts éventuelles) d'une langue — sert à la validation des niveaux et aux tests. */
export function getDictionary(lang: Language): Dictionary {
  return DICTIONARIES[lang];
}

/** true si la clé existe dans le dictionnaire de `lang` (langue courante par défaut). */
export function hasKey(key: string, lang?: Language): boolean {
  const dict = DICTIONARIES[lang ?? ensureLanguage()];
  return Object.prototype.hasOwnProperty.call(dict, key);
}

/** Remplace chaque `{nom}` par `params.nom` ; un paramètre absent laisse le `{nom}` visible (aide au débogage). */
function interpolate(template: string, params: I18nParams): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

/**
 * Traduit une clé dans la langue courante, avec interpolation optionnelle des `{paramètres}`.
 * Clé manquante : retourne la clé elle-même et émet un `console.warn` (une seule fois par clé).
 *
 * @param key clé pointée (ex. `'hud.reviveHold'`)
 * @param params valeurs d'interpolation (ex. `{ name: 'David' }`)
 */
export function t(key: string, params?: I18nParams): string {
  const dict = DICTIONARIES[ensureLanguage()];
  if (!Object.prototype.hasOwnProperty.call(dict, key)) {
    if (!warnedKeys.has(key)) {
      warnedKeys.add(key);
      console.warn(`[i18n] Clé manquante : ${key}`);
    }
    return key;
  }
  const value = dict[key];
  return params ? interpolate(value, params) : value;
}

/**
 * Réinitialise l'état interne (langue non détectée, abonnés et mémoire des avertissements vidés).
 * @internal Réservé aux tests.
 */
export function resetI18nStateForTests(): void {
  currentLanguage = null;
  listeners.clear();
  warnedKeys.clear();
}
