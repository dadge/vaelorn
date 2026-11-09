/**
 * Logique PURE de l'interface mobile (aucune dépendance au DOM : l'environnement est passé en paramètre, testé sous Node).
 *
 *  - « appareil tactile » = pointeur principal grossier (`(pointer: coarse)`) : un portable Windows à écran tactile, dont le
 *    pointeur principal reste la souris/le pavé tactile, n'est PAS un appareil tactile (pas de bouton ni d'invite) ;
 *  - le jeu se joue en PAYSAGE : en portrait sur un appareil tactile, on affiche l'invite « Tourne ton téléphone » ;
 *  - bouton « Plein écran » : appareil tactile, API disponible, pas déjà plein écran, pas lancé comme application installée
 *    (le manifeste de la PWA demande déjà le plein écran).
 */

/** Ce qu'on lit de la fenêtre / du navigateur pour décider de l'interface mobile. */
export interface MobileEnvironment {
  /** `matchMedia('(pointer: coarse)').matches`. */
  coarsePointer: boolean;
  /** `window.innerWidth` (px CSS). */
  width: number;
  /** `window.innerHeight` (px CSS). */
  height: number;
  /** Lancé comme application installée (`display-mode: standalone | fullscreen`, ou `navigator.standalone` sur iOS). */
  installed: boolean;
  /** Une page est actuellement en plein écran (`document.fullscreenElement`). */
  fullscreen: boolean;
  /** `document.fullscreenEnabled` et `requestFullscreen` disponibles. */
  fullscreenSupported: boolean;
}

/** État de l'interface mobile à afficher. */
export interface MobileUiState {
  /** Appareil tactile (pointeur principal grossier). */
  touch: boolean;
  /** Invite « tourne ton téléphone » (portrait sur appareil tactile). */
  showRotatePrompt: boolean;
  /** Bouton « Plein écran ». */
  showFullscreenButton: boolean;
}

/** Fenêtre en portrait (strictement plus haute que large). Valeurs invalides : faux. */
export function isPortrait(width: number, height: number): boolean {
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > width;
}

/** Décide quoi afficher. */
export function computeMobileUi(env: MobileEnvironment): MobileUiState {
  const touch = env.coarsePointer === true;
  return {
    touch,
    showRotatePrompt: touch && isPortrait(env.width, env.height),
    showFullscreenButton: touch && env.fullscreenSupported && !env.fullscreen && !env.installed,
  };
}

/** Forçage de la manette virtuelle par l'URL : `?touch=1` = affichée, `?touch=0` = masquée, absent/autre = automatique. */
export type TouchParam = 'on' | 'off' | null;

/** Lit le paramètre `touch` de la chaîne de requête (`window.location.search`). */
export function parseTouchParam(search: string): TouchParam {
  let value: string | null = null;
  try {
    value = new URLSearchParams(search).get('touch');
  } catch {
    return null;
  }
  if (value === '1') return 'on';
  if (value === '0') return 'off';
  return null;
}

/** Ce qui décide de l'affichage de la manette virtuelle. */
export interface VirtualPadVisibilityInput {
  /** Appareil tactile (`computeMobileUi(...).touch`, pas de seconde détection). */
  touch: boolean;
  /** Fenêtre en paysage (pas en portrait). */
  landscape: boolean;
  /** Forçage par l'URL. */
  param: TouchParam;
  /** Une vraie manette (indice < 4) est connectée. */
  realGamepad: boolean;
}

/**
 * La manette virtuelle est-elle affichée ? Jamais avec une vraie manette connectée (elle prend le pas) ni avec
 * `?touch=0` ; sinon `?touch=1` l'affiche partout (test sur PC), et automatiquement : appareil tactile ET paysage.
 */
export function shouldShowVirtualPad(input: VirtualPadVisibilityInput): boolean {
  if (input.realGamepad || input.param === 'off') return false;
  if (input.param === 'on') return true;
  return input.touch && input.landscape;
}
