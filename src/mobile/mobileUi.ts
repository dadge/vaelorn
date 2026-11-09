/**
 * Interface mobile (DOM, par-dessus le canvas Phaser) :
 *  - invite « Tourne ton téléphone » en portrait sur appareil tactile ;
 *  - bouton « Plein écran » (cache la barre d'adresse du navigateur) + verrouillage du paysage quand c'est possible ;
 *  - recalage du canvas (`scale.refresh()`) à chaque changement de taille / rotation / barre d'adresse qui apparaît ou disparaît ;
 *  - écran maintenu allumé pendant le jeu (Screen Wake Lock) sur appareil tactile.
 * La décision (quoi afficher) est dans device.ts (pure, testée) ; ce fichier ne fait que lire l'environnement et mettre à jour le DOM.
 * Aucune erreur ne doit jamais empêcher de jouer : tout est protégé.
 */
import { onLanguageChange, t } from '../i18n/i18n';
import { computeMobileUi, type MobileEnvironment } from './device';

/** Ce dont on a besoin du jeu Phaser (permet de tester / simuler sans Phaser). */
export interface ScaleHost {
  scale: { refresh(): void; startFullscreen(config?: { navigationUI?: 'auto' | 'show' | 'hide' }): void };
}

/** Délai (ms) après un changement de taille avant de recaler : les navigateurs mobiles stabilisent leur fenêtre après coup. */
const REFRESH_DELAYS_MS = [0, 300];

export function readEnvironment(): MobileEnvironment {
  const media = (q: string): boolean => {
    try {
      return typeof window.matchMedia === 'function' && window.matchMedia(q).matches;
    } catch {
      return false;
    }
  };
  const nav = navigator as Navigator & { standalone?: boolean };
  return {
    coarsePointer: media('(pointer: coarse)'),
    width: window.innerWidth,
    height: window.innerHeight,
    installed: media('(display-mode: standalone)') || media('(display-mode: fullscreen)') || nav.standalone === true,
    fullscreen: document.fullscreenElement !== null && document.fullscreenElement !== undefined,
    fullscreenSupported: document.fullscreenEnabled === true && typeof document.documentElement.requestFullscreen === 'function',
  };
}

/** Verrouille le paysage (possible seulement en plein écran ; refusé sur bureau / iOS : sans importance). */
async function lockLandscape(): Promise<void> {
  try {
    const orientation = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
    await orientation.lock?.('landscape');
  } catch {
    /* verrouillage non pris en charge : l'invite de rotation sert de repli */
  }
}

/** Garde l'écran allumé (réacquis quand l'onglet redevient visible). */
function keepScreenAwake(): void {
  const wakeLock = (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<unknown> } }).wakeLock;
  if (!wakeLock) return;
  const acquire = (): void => {
    if (document.visibilityState !== 'visible') return;
    wakeLock.request('screen').catch(() => {
      /* refusé (économie d'énergie…) : l'écran pourra s'éteindre, le jeu reste jouable */
    });
  };
  acquire();
  document.addEventListener('visibilitychange', acquire);
}

/** Installe l'interface mobile. À appeler une fois, après la création du jeu. */
export function installMobileUi(game: ScaleHost): void {
  try {
    const rotate = document.createElement('div');
    rotate.id = 'rotate-prompt';
    rotate.hidden = true;
    rotate.setAttribute('role', 'alert');
    const icon = document.createElement('div');
    icon.className = 'rotate-icon';
    icon.setAttribute('aria-hidden', 'true');
    const title = document.createElement('h2');
    const hint = document.createElement('p');
    rotate.append(icon, title, hint);

    const fullscreen = document.createElement('button');
    fullscreen.id = 'fullscreen-btn';
    fullscreen.type = 'button';
    fullscreen.hidden = true;
    // même chemin que l'option « Plein écran » du menu (le menu en reflète l'état via les événements de Phaser)
    fullscreen.addEventListener('click', () => {
      try {
        game.scale.startFullscreen({ navigationUI: 'hide' });
      } catch {
        /* refusé : tant pis */
      }
    });

    document.body.append(rotate, fullscreen);

    const texts = (): void => {
      title.textContent = t('mobile.rotate.title');
      hint.textContent = t('mobile.rotate.hint');
      fullscreen.title = t('mobile.fullscreen');
      fullscreen.setAttribute('aria-label', t('mobile.fullscreen'));
    };
    texts();
    onLanguageChange(texts);

    let wakeStarted = false;
    const update = (): void => {
      const state = computeMobileUi(readEnvironment());
      rotate.hidden = !state.showRotatePrompt;
      fullscreen.hidden = !state.showFullscreenButton;
      document.documentElement.classList.toggle('touch', state.touch);
      if (state.touch && document.fullscreenElement) void lockLandscape();
      if (state.touch && !wakeStarted) {
        wakeStarted = true;
        keepScreenAwake();
      }
    };

    const refreshScale = (): void => {
      for (const delay of REFRESH_DELAYS_MS) {
        window.setTimeout(() => {
          try {
            game.scale.refresh();
          } catch {
            /* jeu en cours de démarrage / détruit */
          }
        }, delay);
      }
    };
    const onViewportChange = (): void => {
      update();
      refreshScale();
    };

    window.addEventListener('resize', onViewportChange);
    window.addEventListener('orientationchange', onViewportChange);
    document.addEventListener('fullscreenchange', onViewportChange);
    window.visualViewport?.addEventListener('resize', onViewportChange);
    update();
    refreshScale();
  } catch {
    /* l'interface mobile est un confort : jamais bloquant */
  }
}
