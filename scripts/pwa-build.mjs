/**
 * Outillage PWA exécuté au BUILD (Node ESM pur, aucune dépendance) :
 *  - `listBuildFiles(dir)`     : tous les fichiers du dossier de build (chemins relatifs, séparateur « / », triés) ;
 *  - `computeVersion(dir, files)` : hash du contenu du build (12 caractères hexadécimaux) → nom du cache ;
 *  - `buildServiceWorker({ files, version, template? })` : source du service worker (voir sw.template.js) ;
 *  - `pwaPlugin()`             : plugin Vite qui écrit `sw.js` dans le dossier de build, une fois tous les fichiers
 *    (y compris ceux de `public/`) copiés.
 * Le service worker n'est PAS enregistré en développement (voir src/pwa/register.ts).
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
/** Fichier jamais pré-caché (le service worker lui-même, et les cartes de sources). */
const EXCLUDED = (rel) => rel === 'sw.js' || rel.endsWith('.map');

/** Liste récursive des fichiers de `dir` (chemins relatifs avec « / », triés), sans `sw.js` ni `*.map`. */
export function listBuildFiles(dir) {
  const out = [];
  const walk = (abs, rel) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(abs, entry.name), r);
      else if (entry.isFile() && !EXCLUDED(r)) out.push(r);
    }
  };
  walk(dir, '');
  return out.sort();
}

/**
 * Hash (sha-256 tronqué à 12 caractères) des chemins et contenus de `files` (+ `extra`, ex. le modèle du service worker) :
 * change à chaque modification du build.
 */
export function computeVersion(dir, files, extra = '') {
  const hash = createHash('sha256');
  hash.update(extra);
  hash.update('\0');
  for (const f of files) {
    hash.update(f);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(dir, f)));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 12);
}

/**
 * Source du service worker : `__VERSION__` et `__PRECACHE__` du modèle sont remplacés. Les chemins sont relatifs à la
 * portée du service worker (le build utilise `base: './'`) : `index.html` est ajouté, `./` aussi n'est pas nécessaire.
 */
export function buildServiceWorker({ files, version, template }) {
  if (!/^[0-9a-f]{6,64}$/.test(version)) throw new Error(`version invalide : ${version}`);
  const src = template ?? fs.readFileSync(path.join(SCRIPT_DIR, 'sw.template.js'), 'utf8');
  if (!src.includes('__VERSION__') || !src.includes('__PRECACHE__')) throw new Error('modèle de service worker sans marqueurs');
  const list = files.filter((f) => !EXCLUDED(f)).map((f) => `./${f}`);
  const precache = JSON.stringify(list, null, 2);
  // fonctions de remplacement : aucune interprétation des « $ » dans le contenu injecté
  return src.replaceAll('__VERSION__', () => version).replaceAll('__PRECACHE__', () => precache);
}

/** Plugin Vite : génère `<outDir>/sw.js` à la fin du build. */
export function pwaPlugin() {
  let outDir = '';
  return {
    name: 'vaelorn-pwa',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const files = listBuildFiles(outDir);
      if (!files.includes('index.html')) throw new Error('pwa : index.html absent du build');
      const template = fs.readFileSync(path.join(SCRIPT_DIR, 'sw.template.js'), 'utf8');
      // le modèle compte dans la version : changer la stratégie de cache change aussi le nom du cache
      const version = computeVersion(outDir, files, template);
      fs.writeFileSync(path.join(outDir, 'sw.js'), buildServiceWorker({ files, version, template }), 'utf8');
    },
  };
}
