#!/usr/bin/env node
/**
 * Fusion des « parts » i18n dans les dictionnaires de base.
 *
 *   npm run i18n:merge [-- --dry-run] [-- --keep] [-- --dir <dossier i18n>]
 *
 * Fusionne `<dir>/parts/*.fr.json` dans `<dir>/fr.json` et `<dir>/parts/*.en.json` dans `<dir>/en.json`
 * (objets PLATS clé pointée -> chaîne), trie les clés par ordre alphabétique (ordre des points de code,
 * indépendant de la locale), puis supprime les fichiers de parts traités.
 *
 * Erreurs bloquantes (aucun fichier n'est modifié, code de sortie 1, tous les problèmes sont listés) :
 *  - JSON invalide, objet non plat, valeur non chaîne ou vide ;
 *  - doublon de clé avec une valeur différente (entre deux parts, ou entre une part et le dictionnaire de base) ;
 *  - parité fr/en brisée (fichier de part sans équivalent dans l'autre langue, clé présente d'un seul côté,
 *    placeholders {x} différents entre fr et en).
 *
 * Options :
 *   --dir <dossier>  dossier i18n (défaut : src/i18n à côté du dépôt) ; contient fr.json, en.json et parts/
 *   --dry-run        ne rien écrire ni supprimer, afficher seulement ce qui serait fait
 *   --keep           écrire fr.json/en.json mais conserver les fichiers de parts
 *   -h, --help       aide
 *
 * Aucune dépendance : Node ESM pur. Le module exporte aussi `mergeI18n()` (utilisé par les tests).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = path.resolve(SCRIPT_DIR, '..', 'src', 'i18n');
const PART_RE = /^(.+)\.(fr|en)\.json$/;
const LANGS = /** @type {const} */ (['fr', 'en']);

/** Erreur de fusion : `problems` contient toutes les anomalies détectées (une par ligne). */
export class I18nMergeError extends Error {
  /** @param {string[]} problems */
  constructor(problems) {
    super(`Fusion i18n impossible (${problems.length} problème(s)) :\n - ${problems.join('\n - ')}`);
    this.name = 'I18nMergeError';
    this.problems = problems;
  }
}

/** Comparaison par points de code (stable, indépendante de la locale). */
function compareKeys(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Ensemble trié des placeholders `{nom}` d'une chaîne. */
function placeholders(value) {
  return Array.from(new Set(Array.from(value.matchAll(/\{(\w+)\}/g), (m) => m[1]))).sort().join(',');
}

/**
 * Lit un fichier JSON plat. Les problèmes sont ajoutés à `problems` ; retourne `{}` si illisible.
 * @param {string} file
 * @param {string} label nom affiché
 * @param {string[]} problems
 * @returns {Record<string, string>}
 */
function readFlat(file, label, problems) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    problems.push(`${label} : JSON illisible (${err instanceof Error ? err.message : String(err)})`);
    return {};
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    problems.push(`${label} : doit être un objet plat clé -> chaîne`);
    return {};
  }
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (typeof v !== 'string') {
      problems.push(`${label} : la clé « ${k} » n'est pas une chaîne (objets imbriqués interdits : dictionnaires plats)`);
    } else if (v.trim() === '') {
      problems.push(`${label} : la clé « ${k} » a une valeur vide`);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Sérialise un dictionnaire plat trié (indentation 2, saut de ligne final). */
function serialize(dict) {
  const sorted = {};
  for (const k of Object.keys(dict).sort(compareKeys)) sorted[k] = dict[k];
  return JSON.stringify(sorted, null, 2) + '\n';
}

/**
 * Fusionne les parts dans fr.json/en.json.
 *
 * @param {{ dir?: string, dryRun?: boolean, keep?: boolean, log?: (msg: string) => void }} [options]
 * @returns {{ dir: string, processed: string[], added: { fr: number, en: number }, total: { fr: number, en: number }, written: boolean, removed: boolean }}
 * @throws {I18nMergeError} si un problème bloquant est détecté (rien n'est alors écrit)
 */
export function mergeI18n(options = {}) {
  const dir = path.resolve(options.dir ?? DEFAULT_DIR);
  const dryRun = Boolean(options.dryRun);
  const keep = Boolean(options.keep);
  const log = options.log ?? (() => {});
  const partsDir = path.join(dir, 'parts');
  /** @type {string[]} */
  const problems = [];

  // 1. Dictionnaires de base
  const baseFiles = { fr: path.join(dir, 'fr.json'), en: path.join(dir, 'en.json') };
  /** @type {Record<'fr'|'en', Record<string, string>>} */
  const merged = { fr: {}, en: {} };
  /** Origine de chaque clé : langue -> clé -> nom de fichier. */
  const origin = { fr: {}, en: {} };
  for (const lang of LANGS) {
    if (!fs.existsSync(baseFiles[lang])) {
      problems.push(`${lang}.json introuvable dans ${dir}`);
      continue;
    }
    merged[lang] = readFlat(baseFiles[lang], `${lang}.json`, problems);
    for (const k of Object.keys(merged[lang])) origin[lang][k] = `${lang}.json`;
  }
  const baseCount = { fr: Object.keys(merged.fr).length, en: Object.keys(merged.en).length };

  // 2. Parts présentes
  /** @type {{ zone: string, lang: 'fr'|'en', file: string, name: string }[]} */
  const parts = [];
  if (fs.existsSync(partsDir)) {
    for (const name of fs.readdirSync(partsDir).sort()) {
      const m = PART_RE.exec(name);
      if (m) parts.push({ zone: m[1], lang: /** @type {'fr'|'en'} */ (m[2]), file: path.join(partsDir, name), name });
    }
  }

  // 3. Parité des fichiers de parts (chaque zone doit avoir fr ET en)
  const zones = Array.from(new Set(parts.map((p) => p.zone))).sort();
  for (const zone of zones) {
    for (const lang of LANGS) {
      if (!parts.some((p) => p.zone === zone && p.lang === lang)) {
        problems.push(`parts/${zone}.${lang}.json manquant (parité fr/en des parts de « ${zone} »)`);
      }
    }
  }

  // 4. Lecture + fusion à plat, avec détection des doublons
  /** Clés apportées par chaque part : `${zone}.${lang}` -> dict. */
  const partDicts = {};
  for (const p of parts) {
    const dict = readFlat(p.file, `parts/${p.name}`, problems);
    partDicts[`${p.zone}.${p.lang}`] = dict;
    for (const [k, v] of Object.entries(dict)) {
      if (Object.prototype.hasOwnProperty.call(merged[p.lang], k)) {
        if (merged[p.lang][k] !== v) {
          problems.push(
            `doublon de clé « ${k} » (${p.lang}) avec des valeurs différentes : ${origin[p.lang][k]} = « ${merged[p.lang][k]} » / parts/${p.name} = « ${v} »`,
          );
        }
        continue; // même valeur : doublon bénin, on garde la première
      }
      merged[p.lang][k] = v;
      origin[p.lang][k] = `parts/${p.name}`;
    }
  }

  // 5. Parité fr/en des dictionnaires fusionnés + placeholders
  for (const k of Object.keys(merged.fr)) {
    if (!Object.prototype.hasOwnProperty.call(merged.en, k)) {
      problems.push(`parité fr/en : « ${k} » existe en fr (${origin.fr[k]}) mais pas en en`);
    } else if (placeholders(merged.fr[k]) !== placeholders(merged.en[k])) {
      problems.push(
        `placeholders différents pour « ${k} » : fr {${placeholders(merged.fr[k])}} / en {${placeholders(merged.en[k])}}`,
      );
    }
  }
  for (const k of Object.keys(merged.en)) {
    if (!Object.prototype.hasOwnProperty.call(merged.fr, k)) {
      problems.push(`parité fr/en : « ${k} » existe en en (${origin.en[k]}) mais pas en fr`);
    }
  }

  if (problems.length > 0) throw new I18nMergeError(problems);

  const processed = parts.map((p) => `parts/${p.name}`);
  const added = {
    fr: Object.keys(merged.fr).length - baseCount.fr,
    en: Object.keys(merged.en).length - baseCount.en,
  };
  const total = { fr: Object.keys(merged.fr).length, en: Object.keys(merged.en).length };

  if (parts.length === 0) {
    log('Aucune part à fusionner : rien à faire.');
    return { dir, processed, added, total, written: false, removed: false };
  }

  // 6. Écriture (sauf --dry-run), puis suppression des parts (sauf --keep / --dry-run)
  if (dryRun) {
    log(`[dry-run] ${parts.length} fichier(s) de parts seraient fusionnés : +${added.fr} clés fr, +${added.en} clés en.`);
    for (const f of processed) log(`[dry-run]   - ${f}`);
    log(`[dry-run] Totaux après fusion : fr=${total.fr}, en=${total.en}. Aucun fichier modifié.`);
    return { dir, processed, added, total, written: false, removed: false };
  }

  for (const lang of LANGS) fs.writeFileSync(baseFiles[lang], serialize(merged[lang]), 'utf8');
  log(`fr.json : +${added.fr} clés (total ${total.fr}) ; en.json : +${added.en} clés (total ${total.en}).`);

  let removed = false;
  if (keep) {
    log('--keep : fichiers de parts conservés.');
  } else {
    for (const p of parts) fs.unlinkSync(p.file);
    removed = true;
    log(`${parts.length} fichier(s) de parts supprimé(s).`);
  }
  return { dir, processed, added, total, written: true, removed };
}

// ───────────────────────────── CLI ─────────────────────────────

const HELP = `Usage : node scripts/merge-i18n.mjs [--dir <dossier i18n>] [--dry-run] [--keep]
  --dir <dossier>  dossier contenant fr.json, en.json et parts/ (défaut : src/i18n)
  --dry-run        affiche ce qui serait fait sans rien écrire ni supprimer
  --keep           met à jour fr.json/en.json mais conserve les fichiers de parts
  -h, --help       affiche cette aide`;

/**
 * Analyse les arguments de la ligne de commande.
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  /** @type {{ dir?: string, dryRun: boolean, keep: boolean, help: boolean }} */
  const opts = { dryRun: false, keep: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--keep') opts.keep = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--dir') {
      const v = argv[++i];
      if (!v) throw new Error('--dir attend un chemin');
      opts.dir = v;
    } else if (a.startsWith('--dir=')) opts.dir = a.slice('--dir='.length);
    else throw new Error(`option inconnue : ${a}\n${HELP}`);
  }
  return opts;
}

function main() {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      console.log(HELP);
      return;
    }
    mergeI18n({ ...opts, log: (m) => console.log(m) });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

// Exécute le CLI seulement quand le fichier est lancé directement (pas à l'import par les tests).
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
