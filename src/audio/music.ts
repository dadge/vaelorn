/**
 * Façade de la musique de fond : UNE instance de `MusicPlayer` pour toute l'application, branchée sur le contexte audio partagé
 * (`audioContext.ts`), la visibilité réelle de l'onglet et le réglage mémorisé (`musicSettings.ts`).
 *
 * Les scènes n'utilisent que `getMusic()` : `start()` / `stop()`, `setDucked()` (pause), `setMuted()` (touche M). Sans AudioContext
 * (Node, bots, tests), tout est silencieux et sans exception.
 *
 * DÉCISIONS (voir README, section « Musique ») : la musique joue pendant le JEU (GameScene) ; menu silencieux (la musique ne s'y fait
 * entendre qu'en APERÇU quand une ligne « Musique » est sélectionnée) ; tutoriel : volume réduit de moitié ; démo « attract » :
 * coupée ; résultat / dialogue de fin de niveau : fondu de sortie au départ de la scène de jeu ; pause : ducking (35 %).
 */
import { getAudioContext } from './audioContext';
import { MusicPlayer, type VisibilityApi } from './musicPlayer';
import { musicSettings } from './musicSettings';

/** Niveau relatif de la musique pendant le tutoriel (le joueur lit des consignes : musique basse). */
export const TUTORIAL_MUSIC_LEVEL = 0.5;

/** Visibilité du document réel, ou null hors navigateur. */
function documentVisibility(): VisibilityApi | null {
  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return null;
  return {
    isHidden: () => document.hidden === true,
    subscribe(listener) {
      document.addEventListener('visibilitychange', listener);
      return () => document.removeEventListener('visibilitychange', listener);
    },
  };
}

let instance: MusicPlayer | null = null;
let unsubscribeSettings: (() => void) | null = null;

/** Le lecteur de musique de l'application (créé au premier appel, réglage appliqué et suivi). */
export function getMusic(): MusicPlayer {
  if (instance) return instance;
  const player = new MusicPlayer({ getContext: getAudioContext, visibility: documentVisibility() });
  player.setSettings(musicSettings.effective());
  unsubscribeSettings = musicSettings.subscribe(() => player.setSettings(musicSettings.effective()));
  instance = player;
  return player;
}

/** Oublie l'instance (tests uniquement). */
export function resetMusicForTests(): void {
  unsubscribeSettings?.();
  unsubscribeSettings = null;
  instance?.dispose();
  instance = null;
}
