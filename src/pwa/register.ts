/**
 * Enregistrement du service worker (PWA : installation sur l'écran d'accueil + jeu hors ligne).
 *
 * Le fichier `sw.js` est généré au build (scripts/pwa-build.mjs) : il n'existe pas en développement (`npm run dev`),
 * où on n'enregistre donc rien (un service worker en cache gênerait le rechargement à chaud). Un échec d'enregistrement
 * (navigation privée, HTTP non sécurisé, navigateur ancien) n'empêche jamais de jouer.
 */

/** Ce qu'il faut savoir de l'environnement pour décider d'enregistrer le service worker. */
export interface PwaEnvironment {
  /** Build de production (`import.meta.env.PROD`). */
  production: boolean;
  /** `'serviceWorker' in navigator`. */
  supported: boolean;
  /** `window.isSecureContext` (HTTPS ou localhost). */
  secure: boolean;
}

/** Vrai quand on doit enregistrer le service worker. */
export function shouldRegisterServiceWorker(env: PwaEnvironment): boolean {
  return env.production && env.supported && env.secure;
}

/** Enregistre `./sw.js` (relatif à la page : fonctionne dans un sous-dossier, ex. GitHub Pages). Ne lève jamais. */
export function registerServiceWorker(): void {
  try {
    const env: PwaEnvironment = {
      production: import.meta.env.PROD,
      supported: typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
      secure: typeof window !== 'undefined' && window.isSecureContext === true,
    };
    if (!shouldRegisterServiceWorker(env)) return;
    const register = (): void => {
      navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {
        /* hors ligne / bloqué : le jeu reste jouable en ligne */
      });
    };
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  } catch {
    /* aucune importance pour le jeu */
  }
}
