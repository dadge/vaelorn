/**
 * Informations de version du build (Node ESM pur, aucune dépendance), injectées dans le jeu par `vite.config.ts`
 * (constante globale `__BUILD_INFO__`) et affichées en petit dans le menu principal (src/buildInfo.ts) :
 *  - `version` : numéro de `package.json` ;
 *  - `commit`  : hash court du commit construit (celui de la page GitHub du commit), ou `null` ;
 *  - `date`    : date (AAAA-MM-JJ) du COMMIT, ou `null`. C'est la date du commit et non l'heure du build : ainsi
 *    deux builds du même commit sont identiques (le nom du cache du service worker en dépend).
 * Sans git (archive téléchargée…), on retombe sur `GITHUB_SHA` pour le hash, et la date reste `null`.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Exécute `git <args>` dans `cwd` ; renvoie la sortie sans espaces de bord, ou `null` si git échoue. */
function defaultGit(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/**
 * Lit les informations de build de `root`.
 * `git` (injectable pour les tests) reçoit `(args, cwd)` et renvoie sa sortie ou `null`.
 */
export function readBuildInfo(root, env = {}, git = defaultGit) {
  let version = '0.0.0';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (typeof pkg.version === 'string' && pkg.version) version = pkg.version;
  } catch {
    // package.json illisible : version neutre.
  }

  let commit = null;
  let date = null;
  const log = git(['log', '-1', '--format=%h %cs'], root);
  const m = typeof log === 'string' ? /^([0-9a-f]{4,40}) (\d{4}-\d{2}-\d{2})$/.exec(log) : null;
  if (m) {
    commit = m[1];
    date = m[2];
  } else if (typeof env.GITHUB_SHA === 'string' && /^[0-9a-f]{7,40}$/.test(env.GITHUB_SHA)) {
    commit = env.GITHUB_SHA.slice(0, 7);
  }
  return { version, commit, date };
}
