/**
 * MODE DÉMO (« attract mode ») — constantes et paramètres d'URL. Module PUR (aucun Phaser, aucun DOM, aucun Math.random).
 *
 * Convention des bornes d'arcade : après un moment d'inactivité sur l'écran-titre, le jeu lance une démonstration qui se joue
 * toute seule (bandeau « DÉMO » clignotant + invite « Appuie sur une touche »). TOUTE action du joueur l'interrompt tout de
 * suite et ramène au titre ; au bout de quelques dizaines de secondes la démo s'arrête d'elle-même et le compte à rebours
 * d'inactivité recommence (la démo boucle donc tant que personne ne touche à rien).
 *
 * Source UNIQUE des durées : tout le reste du code (scène de menu, scène de jeu, tests, README) les lit ici.
 */
import { isSavingAllowed } from '../render/saveMenuLogic';

/**
 * Inactivité (ms) sur l'écran-titre avant le lancement de la démo. Usage des bornes d'arcade : 30 à 60 s ; on prend le haut de
 * la fourchette pour ne jamais surprendre quelqu'un qui lit le menu ou règle les options.
 */
export const ATTRACT_IDLE_MS = 60_000;

/** Durée (ms, TEMPS RÉEL) de la démo avant le retour automatique au menu. Usage des bornes d'arcade : 20 à 40 s. */
export const ATTRACT_DEMO_MS = 30_000;

/**
 * Fenêtre de grâce (ms) après le retour au menu : l'entrée qui vient d'interrompre la démo (ou son répétiteur clavier, ou un
 * double appui) est avalée et ne valide donc pas un élément du menu.
 */
export const ATTRACT_RETURN_GRACE_MS = 400;

/** Fondu au noir (ms) vers le menu quand la démo arrive à son terme. */
export const ATTRACT_TIMEOUT_FADE_MS = 700;

/** Fondu au noir (ms) vers le menu quand le joueur interrompt la démo (court : la réponse doit paraître immédiate). */
export const ATTRACT_INPUT_FADE_MS = 200;

/** Fondu (ms) de la scène de menu vers la démo. */
export const ATTRACT_START_FADE_MS = 350;

/** Bornes acceptées pour `?attractIdle=` et `?attractDemo=` (secondes). Valeur hors bornes ou illisible : valeur par défaut. */
export const ATTRACT_IDLE_RANGE_S = { min: 1, max: 3600 } as const;
export const ATTRACT_DEMO_RANGE_S = { min: 3, max: 600 } as const;

/** Configuration effective du mode démo. */
export interface AttractConfig {
  /** false : la démo ne se lance jamais (`?attract=0`, ou mode de test sans `?attract=1`). */
  enabled: boolean;
  /** Inactivité avant la démo (ms). */
  idleMs: number;
  /** Durée de la démo (ms). */
  demoMs: number;
}

/** Configuration par défaut (60 s d'inactivité, 30 s de démo, activée). */
export function defaultAttractConfig(): AttractConfig {
  return { enabled: true, idleMs: ATTRACT_IDLE_MS, demoMs: ATTRACT_DEMO_MS };
}

function readParam(search: string, name: string): string | null {
  try {
    return new URLSearchParams(search).get(name);
  } catch {
    return null;
  }
}

/** Valeur booléenne d'un paramètre : '0' / 'false' / 'no' / 'off' = faux ; '', '1', 'true', 'yes', 'on' = vrai ; autre = null (ignoré). */
function readBool(search: string, name: string): boolean | null {
  const raw = readParam(search, name);
  if (raw === null) return null;
  const s = raw.trim().toLowerCase();
  if (s === '' || s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return null;
}

/** Secondes → millisecondes, dans les bornes ; sinon `fallbackMs`. */
function readSeconds(search: string, name: string, range: { min: number; max: number }, fallbackMs: number): number {
  const raw = readParam(search, name);
  if (raw === null || raw.trim() === '') return fallbackMs;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < range.min || n > range.max) return fallbackMs;
  return Math.round(n * 1000);
}

/**
 * Analyse les paramètres d'URL du mode démo (dev / tests) :
 *  - `?attract=0` : désactive ; `?attract=1` : active MÊME en mode de test (voir ci-dessous) ;
 *  - `?attractIdle=<secondes>` : inactivité avant la démo (ex. 5) ; `?attractDemo=<secondes>` : durée de la démo (ex. 10).
 * MODE DE TEST = démarrage rapide (`?quick=1`), tutoriel (`?tutorial=1`), `?nosave=1`, `?dark=1`, `?dev=…` (mêmes règles que
 * `isSavingAllowed`) : la démo n'y est jamais lancée, sauf `?attract=1` explicite.
 * @param search chaîne de requête (`window.location.search`)
 * @param opts `quick` / `tutorial` : déjà analysés par `parseQuickParams` (sinon relus dans `search`)
 */
export function parseAttractParams(search: string, opts: { quick?: boolean; tutorial?: boolean } = {}): AttractConfig {
  const cfg = defaultAttractConfig();
  cfg.idleMs = readSeconds(search, 'attractIdle', ATTRACT_IDLE_RANGE_S, ATTRACT_IDLE_MS);
  cfg.demoMs = readSeconds(search, 'attractDemo', ATTRACT_DEMO_RANGE_S, ATTRACT_DEMO_MS);
  const explicit = readBool(search, 'attract');
  const quick = opts.quick ?? readBool(search, 'quick') === true;
  const tutorial = opts.tutorial ?? readBool(search, 'tutorial') === true;
  const testMode = !isSavingAllowed({ quick, tutorial, search });
  if (explicit === false) cfg.enabled = false;
  else if (explicit === true) cfg.enabled = true;
  else cfg.enabled = !testMode;
  return cfg;
}

let current: AttractConfig = defaultAttractConfig();

/** Mémorise la configuration analysée par `main.ts` (lue par `MenuScene`). */
export function setAttractConfig(cfg: AttractConfig): void {
  current = { ...cfg };
}

/** Configuration courante (défaut : activée, 60 s / 30 s, tant que `main.ts` n'a rien posé). */
export function getAttractConfig(): AttractConfig {
  return current;
}
