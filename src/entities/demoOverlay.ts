/**
 * Habillage du MODE DÉMO (« attract mode ») sur la caméra d'interface plein écran : bandeau « DÉMO » clignotant en haut et invite
 * « Appuie sur une touche pour jouer » clignotante en bas (libellé générique : clavier, manette ou toucher). Rendu seulement ; le
 * rythme du clignotement vient de `blinkVisible` (src/attract/demoFlow.ts, pur et testé). Tout texte passe par `t()`.
 */
import type Phaser from 'phaser';
import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import { blinkVisible, demoPromptKey } from '../attract/demoFlow';
import { t } from '../i18n/i18n';
import { computeMobileUi } from '../mobile/device';
import { readEnvironment } from '../mobile/mobileUi';
import { HUD_DEPTH, hudRect, hudText } from '../render/hud';
import type { ViewContext } from './common';

type Text = Phaser.GameObjects.Text;
type Rect = Phaser.GameObjects.Rectangle;

/** Décalage (ms) du clignotement de l'invite par rapport au bandeau : les deux ne s'éteignent pas ensemble. */
const PROMPT_PHASE_MS = 350;

/** L'utilisateur demande-t-il moins d'animation (`prefers-reduced-motion`) ? Lu côté scène (jamais dans un module pur) ; faux si indisponible. */
function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** Appareil tactile ? (libellé de l'invite) ; faux si l'environnement est illisible. */
function isTouchDevice(): boolean {
  try {
    return computeMobileUi(readEnvironment()).touch;
  } catch {
    return false;
  }
}

export class DemoOverlay {
  /** Mouvement réduit demandé : bandeau et invite restent affichés en continu (pas de clignotement). */
  private readonly steady = prefersReducedMotion();
  private promptKey = demoPromptKey(isTouchDevice());
  private readonly bannerBg: Rect;
  private readonly banner: Text;
  private readonly promptBg: Rect;
  private readonly prompt: Text;

  constructor(private readonly ctx: ViewContext) {
    const cx = GAME_WIDTH / 2;
    const depth = HUD_DEPTH.banner + 10;
    this.bannerBg = hudRect(ctx, cx, 30, 10, 10, 0x0b0912, 0.72, depth);
    this.banner = hudText(ctx, cx, 30, t('attract.banner'), { size: 34, color: 0xffd36b, originX: 0.5, originY: 0.5, align: 'center', depth: depth + 1 });
    this.promptBg = hudRect(ctx, cx, GAME_HEIGHT - 60, 10, 10, 0x0b0912, 0.72, depth);
    this.prompt = hudText(ctx, cx, GAME_HEIGHT - 60, t(this.promptKey), { size: 28, color: 0xffffff, originX: 0.5, originY: 0.5, align: 'center', depth: depth + 1 });
    this.layout();
  }

  /** Ajuste les fonds aux textes (après un changement de langue). */
  private layout(): void {
    this.bannerBg.setSize(this.banner.width + 48, this.banner.height + 14);
    this.promptBg.setSize(this.prompt.width + 40, this.prompt.height + 12);
  }

  /** Clignotement : `timeMs` = temps réel écoulé de la démo. */
  update(timeMs: number): void {
    const showBanner = this.steady || blinkVisible(timeMs);
    const showPrompt = this.steady || blinkVisible(timeMs, PROMPT_PHASE_MS);
    this.banner.setVisible(showBanner);
    this.bannerBg.setVisible(showBanner);
    this.prompt.setVisible(showPrompt);
    this.promptBg.setVisible(showPrompt);
  }

  /** Changement de langue. */
  retranslate(): void {
    this.banner.setText(t('attract.banner'));
    this.promptKey = demoPromptKey(isTouchDevice());
    this.prompt.setText(t(this.promptKey));
    this.layout();
  }

  destroy(): void {
    this.banner.destroy();
    this.bannerBg.destroy();
    this.prompt.destroy();
    this.promptBg.destroy();
    void this.ctx;
  }
}
