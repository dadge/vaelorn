/**
 * Éléments d'interface GLOBAUX de l'écran partagé (caméra d'interface plein écran) : bandeau de salle, indice de
 * salle, bannières de phase (« Tous à terre », « Salle terminée », « Niveau terminé »), barre de PV de boss, fondu
 * enchaîné / flash plein écran, et menu pause. Aucune règle de jeu : lecture de GameState seulement.
 */
import type Phaser from 'phaser';
import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import type { GamePhase, LevelDef, RoomDef } from '../core/types';
import { t } from '../i18n/i18n';
import { HUD_DEPTH, fadeAlpha, hudRect, hudText, setTextIfChanged, type ScreenBounds } from '../render/hud';
import { MAX_BOSS_BARS, bossBarColor, bossBarFrameColor, type BossBarEntry } from '../render/bossBars';
import type { ViewContext } from './common';

type Text = Phaser.GameObjects.Text;
type Rect = Phaser.GameObjects.Rectangle;

// ───────────────────────────── Bannière à fondu ─────────────────────────────

const FADE_IN_MS = 220;
const FADE_OUT_MS = 500;

/** Alpha d'une bannière affichée `durMs` ms, après `elapsedMs` ms (fondu d'entrée puis de sortie). Pur. */
export function bannerAlpha(elapsedMs: number, durMs: number): number {
  if (elapsedMs < 0) return 0;
  if (elapsedMs >= durMs) return 0;
  const inn = Math.min(1, elapsedMs / FADE_IN_MS);
  const out = Number.isFinite(durMs) ? Math.min(1, (durMs - elapsedMs) / FADE_OUT_MS) : 1;
  return Math.max(0, Math.min(inn, out));
}

class BannerSlot {
  private readonly bg: Rect;
  private readonly title: Text;
  private readonly sub: Text;
  private elapsed = 0;
  private dur = 0;
  private active = false;
  /** Rectangle écran occupé par la bannière (réutilisé : pas d'allocation par frame). */
  private readonly rect: ScreenBounds = { x0: 0, y0: 0, x1: 0, y1: 0 };

  constructor(
    ctx: ViewContext,
    cx: number,
    private readonly y: number,
    titleSize: number,
    subSize: number,
    private readonly wrap: number,
  ) {
    this.bg = hudRect(ctx, cx, y, 10, 10, 0x0b0912, 0.74, HUD_DEPTH.banner);
    this.bg.setVisible(false);
    this.title = hudText(ctx, cx, y, '', { size: titleSize, originX: 0.5, originY: 0, align: 'center', depth: HUD_DEPTH.banner + 1, wrap });
    this.sub = hudText(ctx, cx, y, '', { size: subSize, originX: 0.5, originY: 0, align: 'center', depth: HUD_DEPTH.banner + 1, bold: false, wrap });
    this.title.setVisible(false);
    this.sub.setVisible(false);
  }

  show(title: string, sub: string, durMs: number, titleColor = 0xffffff, subColor = 0xe6e0c8): void {
    this.title.setText(title).setColor(`#${titleColor.toString(16).padStart(6, '0')}`);
    this.sub.setText(sub).setColor(`#${subColor.toString(16).padStart(6, '0')}`);
    this.layout();
    this.elapsed = 0;
    this.dur = durMs;
    this.active = true;
    this.apply(1);
  }

  /** Remplace les textes sans relancer le fondu (changement de langue). */
  retext(title: string, sub: string): void {
    if (!this.active) return;
    this.title.setText(title);
    this.sub.setText(sub);
    this.layout();
  }

  hide(): void {
    this.active = false;
    this.apply(0);
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Rectangle écran de la bannière tant qu'elle est visible (sinon null). */
  get bounds(): ScreenBounds | null {
    return this.active ? this.rect : null;
  }

  private layout(): void {
    const pad = 14;
    const hasSub = this.sub.text !== '';
    this.title.setY(this.y + pad);
    this.sub.setY(this.y + pad + this.title.height + 4);
    const h = pad * 2 + this.title.height + (hasSub ? this.sub.height + 4 : 0);
    const w = Math.max(this.title.width, hasSub ? this.sub.width : 0) + pad * 4;
    this.bg.setSize(w, h);
    this.bg.setPosition(this.title.x, this.y + h / 2);
    this.rect.x0 = this.title.x - w / 2;
    this.rect.x1 = this.title.x + w / 2;
    this.rect.y0 = this.y;
    this.rect.y1 = this.y + h;
    this.sub.setVisible(hasSub);
  }

  update(dtMs: number): void {
    if (!this.active) return;
    this.elapsed += dtMs;
    if (this.elapsed >= this.dur) {
      this.hide();
      return;
    }
    this.apply(bannerAlpha(this.elapsed, this.dur));
  }

  private apply(a: number): void {
    const vis = a > 0.001 && this.active;
    this.bg.setVisible(vis).setAlpha(a * 0.74);
    this.title.setVisible(vis).setAlpha(a);
    this.sub.setVisible(vis && this.sub.text !== '').setAlpha(a);
  }

  destroy(): void {
    this.bg.destroy();
    this.title.destroy();
    this.sub.destroy();
  }
}

// ───────────────────────────── Overlay global ─────────────────────────────

export interface OverlayUpdate {
  phase: GamePhase;
  phaseTimerMs: number;
  dtMs: number;
  /** Temps réel (ms) depuis la dernière entrée de salle (fondu d'ouverture). */
  sinceEnterMs: number;
  exitOpen: boolean;
  /** Boss puis demi-boss vivants de la salle (barres de PV), au plus MAX_BOSS_BARS. */
  bosses: readonly BossBarEntry[];
}

/** Largeur (px) d'une barre de PV de boss / de demi-boss. */
const BOSS_BAR_W = 560;
const MINI_BAR_W = 400;
/** Écart vertical (px) entre deux barres empilées. */
const BOSS_BAR_STEP = 46;

/** Une barre de PV de boss ou de demi-boss : cadre, remplissage, nom (clé i18n de l'EnemyDef). */
class BossBarSlot {
  private readonly bg: Rect;
  private readonly fill: Rect;
  private readonly name: Text;
  private nameKey = '';
  private tier = '';
  private shown = false;

  constructor(
    ctx: ViewContext,
    private readonly cx: number,
    private readonly by: number,
  ) {
    this.bg = hudRect(ctx, cx, by, BOSS_BAR_W + 8, 20, 0x0b0912, 0.88, HUD_DEPTH.banner);
    this.bg.setStrokeStyle(2, 0xff6a6a, 0.9).setVisible(false);
    this.fill = hudRect(ctx, cx - BOSS_BAR_W / 2, by, BOSS_BAR_W, 12, 0xe0304f, 1, HUD_DEPTH.banner + 1);
    this.fill.setOrigin(0, 0.5).setVisible(false);
    this.name = hudText(ctx, cx, by - 14, '', { size: 16, originX: 0.5, originY: 1, color: 0xffd0d0, depth: HUD_DEPTH.banner + 2 });
    this.name.setVisible(false);
  }

  hide(): void {
    if (!this.shown) return;
    this.shown = false;
    this.bg.setVisible(false);
    this.fill.setVisible(false);
    this.name.setVisible(false);
  }

  show(e: BossBarEntry): void {
    this.shown = true;
    const w = e.tier === 'boss' ? BOSS_BAR_W : MINI_BAR_W;
    if (e.tier !== this.tier) {
      this.tier = e.tier;
      this.bg.setSize(w + 8, e.tier === 'boss' ? 20 : 16).setStrokeStyle(2, bossBarFrameColor(e.tier), 0.9);
      this.fill.setPosition(this.cx - w / 2, this.by);
      this.name.setColor(e.tier === 'boss' ? '#ffd0d0' : '#ffe2b0').setFontSize(e.tier === 'boss' ? 16 : 14);
    }
    this.bg.setVisible(true);
    this.fill.setVisible(true);
    this.name.setVisible(true);
    if (e.nameKey !== this.nameKey) {
      this.nameKey = e.nameKey;
      this.name.setText(t(e.nameKey));
    }
    this.fill.setSize(Math.max(1, w * e.ratio), e.tier === 'boss' ? 12 : 9);
    this.fill.setFillStyle(bossBarColor(e.tier, e.phase), 1);
  }

  retranslate(): void {
    if (this.nameKey) this.name.setText(t(this.nameKey));
  }

  destroy(): void {
    this.bg.destroy();
    this.fill.destroy();
    this.name.destroy();
  }
}

export class GameOverlay {
  private readonly ctx: ViewContext;
  private readonly roomBanner: BannerSlot;
  private readonly hintBanner: BannerSlot;
  private readonly bigBanner: BannerSlot;
  private readonly exitBanner: BannerSlot;
  private readonly fade: Rect;
  private readonly flashRect: Rect;
  private readonly bossBars: BossBarSlot[] = [];
  private readonly bannerOut: ScreenBounds[] = [];
  private readonly entrySlots: BannerSlot[] = [];
  private extraFade = 0;
  private flashLeftMs = 0;
  private flashTotalMs = 1;
  private flashAlpha = 0;
  private lastPhase: GamePhase = 'playing';
  private lastExitOpen = false;
  private exitPending = false;
  private room: RoomDef | null = null;
  private roomIndex = 0;
  private roomTotal = 1;
  /** Mode démo : aucune bannière (nom de salle, indice, sortie, « tous à terre »…) ; seuls le fondu, le flash et les barres de boss restent. */
  private quiet = false;

  constructor(ctx: ViewContext, private readonly level: LevelDef) {
    this.ctx = ctx;
    const cx = GAME_WIDTH / 2;
    this.roomBanner = new BannerSlot(ctx, cx, 24, 30, 16, 900);
    this.hintBanner = new BannerSlot(ctx, cx, 120, 18, 14, 860);
    this.exitBanner = new BannerSlot(ctx, cx, 24, 20, 14, 800);
    this.bigBanner = new BannerSlot(ctx, cx, GAME_HEIGHT * 0.3, 44, 20, 1000);
    this.entrySlots.push(this.roomBanner, this.hintBanner, this.exitBanner);
    this.flashRect = hudRect(ctx, cx, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, 0xffffff, 0, HUD_DEPTH.fade - 1);
    this.flashRect.setVisible(false);
    this.fade = hudRect(ctx, cx, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, 0x000000, 0, HUD_DEPTH.fade);
    this.fade.setVisible(false);
    // barres de PV des boss et demi-boss (empilées depuis le bas de l'écran)
    for (let i = 0; i < MAX_BOSS_BARS; i++) this.bossBars.push(new BossBarSlot(ctx, cx, GAME_HEIGHT - 34 - i * BOSS_BAR_STEP));
  }

  /** Mode démo (« attract mode ») : supprime toutes les bannières, pour laisser la place au bandeau « DÉMO » et à l'invite. */
  setQuiet(quiet: boolean): void {
    this.quiet = quiet;
    if (quiet) for (const b of [this.roomBanner, this.hintBanner, this.exitBanner, this.bigBanner]) b.hide();
  }

  /** Nouvelle salle : bandeau de nom + indice d'introduction (sauf redémarrage après défaite : bandeau court). */
  onRoomEntered(room: RoomDef, roomIndex: number, reason: 'start' | 'next' | 'restart'): void {
    this.room = room;
    this.roomIndex = roomIndex;
    this.roomTotal = this.level.rooms.length;
    if (this.quiet) return;
    this.roomBanner.show(t(room.nameKey), t('hud.room.number', { n: roomIndex + 1, total: this.roomTotal }), reason === 'restart' ? 2200 : 3800, 0xf0e2b0);
    if (room.introHintKey && reason !== 'restart') this.hintBanner.show(t(room.introHintKey), '', 7000, 0xffffff);
    else this.hintBanner.hide();
    this.exitBanner.hide();
    this.lastExitOpen = false;
    this.exitPending = false;
  }

  /**
   * Rectangles écran des bannières d'arrivée de salle / d'annonce de sortie actuellement affichées (centre haut de l'écran).
   * Le HUD de chaque joueur y masque son bloc « Objectif de la salle » s'il passerait dessous. Tableau réutilisé.
   */
  activeBanners(): readonly ScreenBounds[] {
    this.bannerOut.length = 0;
    for (const b of this.entrySlots) {
      const r = b.bounds;
      if (r) this.bannerOut.push(r);
    }
    return this.bannerOut;
  }

  /** Fondu au noir supplémentaire (0..1), combiné par maximum au fondu de salle (sortie de scène). */
  setExtraFade(alpha: number): void {
    this.extraFade = Math.max(0, Math.min(1, alpha));
  }

  /** Flash plein écran (couleur, intensité max 0..1, durée ms). */
  flash(color: number, alpha: number, durMs: number): void {
    this.flashRect.setFillStyle(color, 1);
    this.flashAlpha = alpha;
    this.flashLeftMs = durMs;
    this.flashTotalMs = Math.max(1, durMs);
  }

  /** Re-traduit les textes visibles (changement de langue). */
  retranslate(): void {
    if (this.quiet) {
      for (const b of this.bossBars) b.retranslate();
      return;
    }
    if (this.room) {
      this.roomBanner.retext(t(this.room.nameKey), t('hud.room.number', { n: this.roomIndex + 1, total: this.roomTotal }));
      if (this.room.introHintKey) this.hintBanner.retext(t(this.room.introHintKey), '');
    }
    this.applyPhaseBanner(this.lastPhase, true);
    for (const b of this.bossBars) b.retranslate();
  }

  private applyPhaseBanner(phase: GamePhase, retext = false): void {
    if (this.quiet) return;
    switch (phase) {
      case 'wipe':
        if (retext) this.bigBanner.retext(t('hud.allDown'), t('hud.restartRoom'));
        else this.bigBanner.show(t('hud.allDown'), t('hud.restartRoom'), Infinity, 0xff6a6a);
        break;
      case 'roomCleared':
        if (retext) this.bigBanner.retext(t('hud.roomCleared'), '');
        else this.bigBanner.show(t('hud.roomCleared'), '', Infinity, 0xf5c53d);
        break;
      case 'levelComplete':
        if (retext) this.bigBanner.retext(t('hud.levelComplete'), '');
        else this.bigBanner.show(t('hud.levelComplete'), '', Infinity, 0xf5c53d);
        break;
      default:
        if (!retext) this.bigBanner.hide();
        break;
    }
  }

  update(a: OverlayUpdate): void {
    if (a.phase !== this.lastPhase) {
      this.lastPhase = a.phase;
      this.applyPhaseBanner(a.phase);
    }
    if (a.exitOpen && !this.lastExitOpen && a.phase === 'playing' && !this.quiet) this.exitPending = true;
    if (!a.exitOpen) this.exitPending = false;
    this.lastExitOpen = a.exitOpen;
    // l'annonce de sortie attend que les bandeaux d'arrivée de salle soient passés (pas de chevauchement)
    if (this.exitPending && !this.roomBanner.isActive && !this.hintBanner.isActive) {
      this.exitPending = false;
      this.exitBanner.show(t('hint.gatherAtExit'), '', 3600, 0xfff6c8);
    }
    this.roomBanner.update(a.dtMs);
    this.hintBanner.update(a.dtMs);
    this.exitBanner.update(a.dtMs);
    this.bigBanner.update(a.dtMs);

    // fondu enchaîné entre salles
    const fa = Math.max(this.extraFade, fadeAlpha(a.phase, a.phaseTimerMs, a.sinceEnterMs));
    this.fade.setVisible(fa > 0.003).setAlpha(fa);

    // flash
    if (this.flashLeftMs > 0) {
      this.flashLeftMs -= a.dtMs;
      const k = Math.max(0, this.flashLeftMs / this.flashTotalMs);
      this.flashRect.setVisible(k > 0).setAlpha(this.flashAlpha * k);
    }

    // barres de boss / demi-boss
    for (let i = 0; i < this.bossBars.length; i++) {
      const e = a.bosses[i];
      if (e) this.bossBars[i].show(e);
      else this.bossBars[i].hide();
    }
  }

  destroy(): void {
    this.roomBanner.destroy();
    this.hintBanner.destroy();
    this.exitBanner.destroy();
    this.bigBanner.destroy();
    this.fade.destroy();
    this.flashRect.destroy();
    for (const b of this.bossBars) b.destroy();
    this.bossBars.length = 0;
    void this.ctx;
  }
}

// ───────────────────────────── Menu pause ─────────────────────────────

export type PauseChoice = 'resume' | 'quit';
const PAUSE_ITEMS: readonly PauseChoice[] = ['resume', 'quit'];

/** Prochaine sélection d'un menu circulaire (pur). */
export function wrapIndex(index: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return (((index + delta) % count) + count) % count;
}

/** Menu pause : reprendre / quitter vers le menu. Textes via i18n. */
export class PauseMenu {
  private readonly dim: Rect;
  private readonly panel: Rect;
  private readonly title: Text;
  private readonly items: Text[] = [];
  private readonly hint: Text;
  private readonly controls: Text;
  private index = 0;
  private shown = false;
  private confirmingQuit = false;
  /** Tutoriel : la confirmation de sortie dit que rien n'est sauvegardé (au lieu de « progression perdue »). */
  private tutorialMode = false;

  constructor(ctx: ViewContext) {
    const cx = GAME_WIDTH / 2;
    const cy = GAME_HEIGHT / 2;
    this.dim = hudRect(ctx, cx, cy, GAME_WIDTH, GAME_HEIGHT, 0x05040a, 0.66, HUD_DEPTH.pause);
    this.panel = hudRect(ctx, cx, cy, 520, 372, 0x1c1530, 0.97, HUD_DEPTH.pause + 1); // 372 : la ligne de commandes (spécial, appeler) peut occuper 4 lignes
    this.panel.setStrokeStyle(3, 0xf0e2b0, 1);
    this.title = hudText(ctx, cx, cy - 140, '', { size: 38, originX: 0.5, color: 0xf0e2b0, depth: HUD_DEPTH.pause + 2 });
    PAUSE_ITEMS.forEach((_, i) => {
      this.items.push(hudText(ctx, cx, cy - 60 + i * 56, '', { size: 28, originX: 0.5, depth: HUD_DEPTH.pause + 2 }));
    });
    this.hint = hudText(ctx, cx, cy + 62, '', { size: 14, originX: 0.5, color: 0xb8c0d8, bold: false, depth: HUD_DEPTH.pause + 2, wrap: 480, align: 'center' });
    this.controls = hudText(ctx, cx, cy + 100, '', { size: 14, originX: 0.5, color: 0xe6e0c8, bold: false, depth: HUD_DEPTH.pause + 2, wrap: 480, align: 'center' });
    this.setVisible(false);
  }

  /** Active la variante « tutoriel » du texte de confirmation de sortie. */
  setTutorial(on: boolean): void {
    this.tutorialMode = on;
  }

  private setVisible(v: boolean): void {
    this.dim.setVisible(v);
    this.panel.setVisible(v);
    this.title.setVisible(v);
    this.hint.setVisible(v);
    this.controls.setVisible(v);
    for (const i of this.items) i.setVisible(v);
  }

  get visible(): boolean {
    return this.shown;
  }

  /** Choix actuellement sélectionné. */
  get choice(): PauseChoice {
    return PAUSE_ITEMS[this.index];
  }

  /** Vrai quand l'écran « Quitter ? Oui / Non » est affiché (ligne 0 = « Non » = 'resume', ligne 1 = « Oui » = 'quit'). */
  get confirming(): boolean {
    return this.confirmingQuit;
  }

  /** Affiche la confirmation de sortie, « Non » sélectionné par défaut. */
  askQuit(): void {
    this.confirmingQuit = true;
    this.index = 0;
    this.retranslate();
  }

  /** Revient au menu pause principal (curseur sur « Reprendre »). */
  cancelQuit(): void {
    this.confirmingQuit = false;
    this.index = 0;
    this.retranslate();
  }

  show(): void {
    this.index = 0;
    this.confirmingQuit = false;
    this.shown = true;
    this.setVisible(true);
    this.retranslate();
  }

  hide(): void {
    this.shown = false;
    this.setVisible(false);
  }

  /** Déplace la sélection (−1 haut, +1 bas). */
  move(delta: number): void {
    this.index = wrapIndex(this.index, delta, PAUSE_ITEMS.length);
    this.refreshItems();
  }

  retranslate(): void {
    setTextIfChanged(this.title, t('hud.pause'));
    this.hint.setText(this.confirmingQuit ? t(this.tutorialMode ? 'tutorial.quit.confirm' : 'game.pause.quit.confirm') : t('game.pause.hint'));
    // rappel des commandes : déplacement, action, spécial et appeler (boutons dédiés), pause
    this.controls.setText(`${t('controls.keyboard')} : ${t('controls.keyboard.move')} - ${t('game.pause.controls.keyboard')}\n${t('controls.gamepad')} : ${t('controls.gamepad.move')} - ${t('game.pause.controls.gamepad')}`);
    this.refreshItems();
  }

  private refreshItems(): void {
    PAUSE_ITEMS.forEach((c, i) => {
      const sel = i === this.index;
      const label = this.confirmingQuit ? (c === 'resume' ? t('game.pause.quit.no') : t('game.pause.quit.yes')) : c === 'resume' ? t('hud.resume') : t('hud.quitToMenu');
      this.items[i].setText(sel ? `> ${label} <` : label);
      this.items[i].setColor(sel ? '#ffe27a' : '#ffffff');
    });
  }

  destroy(): void {
    this.dim.destroy();
    this.panel.destroy();
    this.title.destroy();
    this.hint.destroy();
    this.controls.destroy();
    for (const i of this.items) i.destroy();
    this.items.length = 0;
  }
}
