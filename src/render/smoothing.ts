/**
 * Rendu « adouci » (par défaut) ou « pixel » (pixels francs).
 *
 * - doux : filtrage linéaire des textures, pas de `image-rendering: pixelated` sur le canvas → les sprites et l'obscurité sont lissés
 *   quand l'image est agrandie (plus agréable à l'œil, en particulier sur grand écran) ;
 * - pixel : filtrage NEAREST, pixels nets (ancien rendu).
 *
 * Choix : paramètre d'URL `?smooth=0` (pixels) ou `?smooth=1` (doux) — persisté dans `localStorage['vaelorn.smooth']` ;
 * sans paramètre ni valeur mémorisée : doux. Toutes les lectures de stockage sont protégées (navigation privée, quota…).
 * Logique pure (aucune dépendance à Phaser) : testée dans `smoothing.test.ts`.
 */

/** Clé `localStorage` du choix de rendu. */
export const SMOOTH_STORAGE_KEY = 'vaelorn.smooth';

/** Interprète « 0/1/true/false/on/off/pixel/smooth » ; `undefined` si la valeur n'est pas reconnue. */
export function parseSmoothValue(v: string | null | undefined): boolean | undefined {
  if (v == null) return undefined;
  const s = v.trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'on' || s === 'smooth' || s === 'soft') return true;
  if (s === '0' || s === 'false' || s === 'off' || s === 'pixel') return false;
  return undefined;
}

/** Décide du rendu : URL > valeur mémorisée > doux. Retourne aussi le choix à mémoriser (si l'URL en donne un). */
export function resolveSmoothing(search: string, stored: string | null | undefined): { smooth: boolean; persist?: boolean } {
  let fromUrl: boolean | undefined;
  try {
    fromUrl = parseSmoothValue(new URLSearchParams(search).get('smooth'));
  } catch {
    fromUrl = undefined;
  }
  if (fromUrl !== undefined) return { smooth: fromUrl, persist: fromUrl };
  return { smooth: parseSmoothValue(stored) ?? true };
}

let current: boolean | null = null;

/** Rendu courant (calculé une fois au premier appel depuis l'URL et le stockage). */
export function isSmoothRendering(): boolean {
  if (current !== null) return current;
  let stored: string | null = null;
  let search = '';
  try {
    stored = globalThis.localStorage?.getItem(SMOOTH_STORAGE_KEY) ?? null;
  } catch {
    stored = null;
  }
  try {
    search = globalThis.location?.search ?? '';
  } catch {
    search = '';
  }
  const r = resolveSmoothing(search, stored);
  if (r.persist !== undefined) {
    try {
      globalThis.localStorage?.setItem(SMOOTH_STORAGE_KEY, r.persist ? '1' : '0');
    } catch {
      /* stockage indisponible : le choix vaut pour cette session seulement */
    }
  }
  current = r.smooth;
  return current;
}

/** Mode de filtrage Phaser.Textures.FilterMode (LINEAR = 0, NEAREST = 1) pour le rendu courant. */
export function textureFilterMode(): number {
  return isSmoothRendering() ? 0 : 1;
}

/** Pour les tests : oublie le choix calculé. */
export function resetSmoothingForTests(): void {
  current = null;
}
