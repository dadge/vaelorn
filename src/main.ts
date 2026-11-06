/**
 * Point d'entrée : configuration Phaser 3 (canvas logique 1280×720, Scale.FIT centré, pixel art, manettes)
 * et liste des scènes : Boot → Menu → CharacterSelect → Dialogue → Game → Result.
 *
 * PARAMÈTRES D'URL (dev / tests automatiques — voir menuLogic.parseQuickParams) :
 *   ?quick=1&players=2&level=2&chars=david,sandrine&diff=1,2&lang=en&room=3[&p1pad=1][&debug=1]
 *   - quick=1  : saute Menu / CharacterSelect / Dialogue et lance Game directement (BootScene) ;
 *   - players  : 1..4 (défaut : nombre de `chars`, sinon 1) ; chars : personnages (complétés par des personnages distincts) ;
 *   - diff     : une valeur pour tous, ou une liste par joueur (1 facile / 2 normal / 3 difficile) ;
 *   - level    : niveau de départ (1-based) ; room : indice 0-based de la salle de départ → `session.startRoomIndex` ;
 *   - lang     : fr | en (appliquée avant le démarrage ; persistée comme tout changement de langue) ;
 *   - p1pad=1  : J1 à la manette ; debug=1 : expose `window.__vaelorn` hors mode dev.
 * `window.__vaelorn = { game }` est exposé en mode dev (import.meta.env.DEV), avec ?debug=1 ou ?quick=1 ;
 * en démarrage rapide un événement `vaelorn:quickstart` (detail = GameSession) est émis sur `window`.
 */
import Phaser from 'phaser';
import { GAME_HEIGHT, GAME_WIDTH } from './core/constants';
import { onLanguageChange, setLanguage, t } from './i18n/i18n';
import { inputManager } from './input';
import { LEVELS } from './levels';
import { parseQuickParams, setQuickParams } from './render/menuLogic';
import { BootScene } from './scenes/BootScene';
import { CharacterSelectScene } from './scenes/CharacterSelectScene';
import { DialogueScene } from './scenes/DialogueScene';
import { GameScene } from './scenes/GameScene';
import { MenuScene } from './scenes/MenuScene';
import { ResultScene } from './scenes/ResultScene';

declare global {
  interface Window {
    /** Inspection en dev / tests automatiques : l'instance Phaser (et la session de démarrage rapide). */
    __vaelorn?: { game: Phaser.Game };
  }
}

function start(): void {
  const quick = parseQuickParams(window.location.search, LEVELS.length);
  setQuickParams(quick);
  if (quick.language) setLanguage(quick.language);

  // Écoute clavier / manettes dès le départ (les menus et le jeu s'appuient sur ce singleton).
  inputManager.attach();

  // Titre de l'onglet = titre du jeu dans la langue courante (abonnement unique, durée de vie de l'application).
  const syncTitle = (): void => {
    document.title = t('menu.title');
  };
  syncTitle();
  onLanguageChange(syncTitle);

  const config: Phaser.Types.Core.GameConfig = {
    type: Phaser.AUTO,
    parent: 'game',
    width: GAME_WIDTH,
    height: GAME_HEIGHT,
    backgroundColor: '#0b0a14',
    pixelArt: true,
    roundPixels: true,
    antialias: false,
    disableContextMenu: true,
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    // Le plugin manette de Phaser n'est PAS utilisé (src/input lit navigator.getGamepads) et plante à la fermeture
    // d'une scène quand les indices de manettes ne sont pas contigus (trou dans `gamepads`) : désactivé.
    input: { gamepad: false },
    scene: [BootScene, MenuScene, CharacterSelectScene, DialogueScene, GameScene, ResultScene],
  };

  const game = new Phaser.Game(config);

  if (import.meta.env.DEV || quick.debug) window.__vaelorn = { game };
}

start();
