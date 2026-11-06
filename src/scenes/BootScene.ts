/**
 * BootScene : génère l'atlas de sprites (buildAtlas), initialise l'i18n, puis lance le Menu
 * (ou directement Game en démarrage rapide `?quick=1`, voir main.ts / menuLogic.parseQuickParams).
 */
import Phaser from 'phaser';
import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import { getLanguage, setLanguage, t } from '../i18n/i18n';
import { inputManager } from '../input';
import { buildAtlas } from '../render/art';
import { getQuickParams } from '../render/menuLogic';
import { DEV_QUICK_START_EVENT, SCENE_KEYS, type GameSceneData } from '../render/session';
import { UI_THEME, beginScene, createText, transitionTo } from '../render/ui';

export class BootScene extends Phaser.Scene {
  constructor() {
    super(SCENE_KEYS.Boot);
  }

  create(): void {
    beginScene(this, 0);
    this.cameras.main.setBackgroundColor(UI_THEME.bg);
    // La langue sauvegardée (ou détectée) est appliquée ici : `getLanguage` la résout, `setLanguage` pose <html lang>.
    setLanguage(getLanguage());
    this.input.mouse?.disableContextMenu();

    createText(this, GAME_WIDTH / 2, GAME_HEIGHT / 2, t('common.loading'), {
      size: 'lg',
      origin: [0.5, 0.5],
      align: 'center',
      color: UI_THEME.accent,
    });

    // Laisse un cadre s'afficher avant la génération (synchrone) de l'atlas.
    this.time.delayedCall(60, () => this.build());
  }

  private build(): void {
    try {
      buildAtlas(this);
    } catch (err) {
      console.error('[Boot] échec de la génération de l\'atlas', err);
      createText(this, GAME_WIDTH / 2, GAME_HEIGHT / 2 + 64, t('boot.error'), {
        size: 'md',
        origin: [0.5, 0.5],
        align: 'center',
        color: UI_THEME.bad,
        wrapWidth: GAME_WIDTH - 160,
      });
      return;
    }

    const quick = getQuickParams();
    if (quick?.quick) {
      inputManager.attach();
      inputManager.setPlayerCount(quick.session.playerCount);
      inputManager.setPlayer1Gamepad(quick.player1Gamepad);
      try {
        window.dispatchEvent(new CustomEvent(DEV_QUICK_START_EVENT, { detail: quick.session }));
      } catch {
        /* hors navigateur : sans importance */
      }
      const data: GameSceneData = { session: quick.session };
      this.scene.start(SCENE_KEYS.Game, data);
      return;
    }
    transitionTo(this, SCENE_KEYS.Menu, {}, 0);
  }
}
