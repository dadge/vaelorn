/**
 * Contexte audio PARTAGÉ de l'application : un seul `AudioContext` pour les effets sonores (`entities/sfx.ts`) et la musique
 * (`musicPlayer.ts`), créé paresseusement. Absence de WebAudio ou échec de création : `null` (le jeu reste silencieux, sans exception :
 * bots, tests Node).
 *
 * POLITIQUE D'AUTOPLAY : les navigateurs créent / gardent le contexte « suspendu » tant que l'utilisateur n'a fait aucun geste.
 * `installAudioUnlock()` (appelé une fois par `main.ts`) écoute le premier geste (pointeur, tactile, clavier) et crée / reprend le
 * contexte DANS le geste (exigence d'iOS) ; les écouteurs se retirent d'eux-mêmes dès que le contexte tourne. Les manettes ne
 * déclenchent pas toujours une activation utilisateur : `resumeAudio()` peut être rappelée (musicPlayer.nudge).
 *
 * INTERRUPTIONS (iOS : appel, notification, verrouillage d'écran → état « interrupted ») : tout état autre que « running » est repris
 * (`resumeAudio`, `nudge`), et les écouteurs de geste sont ré-armés quand le contexte quitte « running » (événement `statechange`).
 *
 * ÉCHEC DE CRÉATION : l'absence de WebAudio est définitive ; en revanche un constructeur qui lève (certaines versions de Safari avant un
 * geste) n'est pas mémorisé pour toute la session : on réessaie au prochain geste de l'utilisateur, jamais « en boucle » entre deux gestes.
 */

type AudioCtor = new () => AudioContext;

let shared: AudioContext | null = null;
/** Échec DÉFINITIF (pas de WebAudio) ou TRANSITOIRE (le constructeur a levé : on réessaie au prochain geste). */
let failed: false | 'unsupported' | 'threw' = false;

function audioConstructor(): AudioCtor | null {
  const g = globalThis as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

/** Le contexte partagé (créé au premier appel), ou null si WebAudio est indisponible. Ne lève jamais. */
export function getAudioContext(): AudioContext | null {
  if (shared) return shared;
  if (failed) return null;
  try {
    const Ctor = audioConstructor();
    if (!Ctor) {
      failed = 'unsupported';
      return null;
    }
    shared = new Ctor();
  } catch {
    failed = 'threw';
    return null;
  }
  return shared;
}

/** Autorise une nouvelle tentative de création après un échec transitoire (à appeler DANS un geste utilisateur). */
export function retryAudioCreation(): void {
  if (failed === 'threw') failed = false;
}

/** WebAudio existe-t-il dans ce navigateur ? */
function audioSupported(): boolean {
  return audioConstructor() !== null;
}

/** Reprend le contexte s'il est suspendu (sans exception, sans rejet non géré). Ne crée pas de contexte. */
export function resumeAudio(): void {
  const ctx = shared;
  if (!ctx || ctx.state === 'running') return;
  try {
    const p = ctx.resume();
    if (p && typeof p.catch === 'function') p.catch(() => undefined);
  } catch {
    /* contexte fermé */
  }
}

/** Événements considérés comme un geste utilisateur (le premier débloque l'audio). */
export const UNLOCK_EVENTS: readonly string[] = ['pointerdown', 'mousedown', 'touchstart', 'touchend', 'keydown'];

/**
 * Installe les écouteurs de déblocage de l'audio sur `target` (défaut : `window`). Retourne une fonction de nettoyage ; les écouteurs
 * se retirent seuls quand le contexte est « running ». Sans `window` (Node) : ne fait rien.
 */
export function installAudioUnlock(target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null = typeof window !== 'undefined' ? window : null): () => void {
  if (!target) return () => undefined;
  let removed = false;
  let armed = false;
  let watched: AudioContext | null = null;
  const arm = (): void => {
    if (armed) return;
    armed = true;
    for (const name of UNLOCK_EVENTS) target.addEventListener(name, onGesture, { capture: true, passive: true } as AddEventListenerOptions);
  };
  const disarm = (): void => {
    if (!armed) return;
    armed = false;
    for (const name of UNLOCK_EVENTS) target.removeEventListener(name, onGesture, true);
  };
  /** Le contexte a quitté « running » (interruption iOS…) : on se remet à l'écoute d'un geste pour le reprendre. */
  const onStateChange = (): void => {
    if (!removed && watched && watched.state !== 'running') arm();
  };
  const remove = (): void => {
    if (removed) return;
    removed = true;
    disarm();
    try {
      watched?.removeEventListener?.('statechange', onStateChange);
    } catch {
      /* contexte fermé */
    }
  };
  const onGesture = (): void => {
    retryAudioCreation(); // un constructeur qui avait levé hors geste peut réussir DANS un geste
    const ctx = getAudioContext(); // créé DANS le geste (iOS)
    if (!ctx) {
      if (!audioSupported()) remove(); // pas de WebAudio du tout : inutile d'écouter ; sinon, on retentera au geste suivant
      return;
    }
    if (watched !== ctx) {
      watched = ctx;
      try {
        ctx.addEventListener?.('statechange', onStateChange);
      } catch {
        /* pas de statechange : le nudge de la scène reprend le relais */
      }
    }
    resumeAudio();
    if (ctx.state === 'running') disarm(); // ré-armé par `statechange` si le contexte est interrompu plus tard
  };
  arm();
  return remove;
}

/** Oublie le contexte partagé (tests uniquement). */
export function resetAudioContextForTests(): void {
  shared = null;
  failed = false;
}
