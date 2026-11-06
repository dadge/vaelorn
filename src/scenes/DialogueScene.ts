/**
 * DialogueScene : intro / outro d'un niveau (LevelDef.intro / outro).
 *
 * Fond thématique du niveau (palette + tuiles du thème), portrait de l'orateur (aldric, lyssa, morvane, gorgrim,
 * narrateur, héros alignés), nom d'orateur (speaker.<id>), texte en machine à écrire. Action / Entrée / A (ou clic) :
 * termine la saisie puis passe à la réplique suivante ; Échap / B (ou clic sur « passer ») : saute tout le dialogue.
 *
 * Enchaînement (logique pure : menuLogic.nextAfterDialogue) :
 *   intro  → Game ;
 *   outro  → intro du niveau suivant (session.levelIndex + 1), ou Result (victoire) après le dernier niveau.
 */
import Phaser from 'phaser';
import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import type { DialogueLine } from '../core/types';
import { hasKey, t } from '../i18n/i18n';
import { MenuNavigator, inputManager } from '../input';
import { LEVELS, getLevelByIndex } from '../levels';
import { ATLAS_KEY, heroFrame, stepOf } from '../render/art';
import { nextAfterDialogue, speakerColor } from '../render/menuLogic';
import {
  SCENE_KEYS,
  type DialogueSceneData,
  type GameSceneData,
  type GameSession,
  type ResultSceneData,
} from '../render/session';
import {
  PANEL_STYLES,
  Typewriter,
  UI_THEME,
  beginScene,
  bindLanguage,
  createPanel,
  createPortrait,
  createText,
  createThemeBackground,
  playerColor,
  prewrapText,
  transitionTo,
  type DecorHandle,
  type PortraitHandle,
} from '../render/ui';

/** Grâce (ms) après l'ouverture avant d'accepter « passer » (célébration / fondu précédents). */
const SKIP_GRACE_MS = 700;
/** Fenêtre (ms) pour confirmer « passer » par un deuxième appui. */
const SKIP_CONFIRM_MS = 2500;
const BOX_X = 40;
const BOX_Y = 466;
const BOX_W = GAME_WIDTH - 80;
const BOX_H = 214;
const TEXT_X = 292;
const TEXT_W = BOX_W - (TEXT_X - BOX_X) - 28;

export class DialogueScene extends Phaser.Scene {
  private session!: GameSession;
  private stage: 'intro' | 'outro' = 'intro';
  private lines: DialogueLine[] = [];
  private index = 0;
  private finished = false;
  private typewriter = new Typewriter('');
  private nav!: MenuNavigator;
  private bg!: DecorHandle;
  private portrait!: PortraitHandle;
  private speakerText!: Phaser.GameObjects.Text;
  private bodyText!: Phaser.GameObjects.Text;
  private prompt!: Phaser.GameObjects.Text;
  private dots!: Phaser.GameObjects.Graphics;
  private headerLevel!: Phaser.GameObjects.Text;
  private headerName!: Phaser.GameObjects.Text;
  private headerStage!: Phaser.GameObjects.Text;
  private skipText!: Phaser.GameObjects.Text;
  private party: Array<{ img: Phaser.GameObjects.Image; characterId: GameSession['players'][number]['characterId']; baseY: number; i: number }> = [];
  private currentSpeaker = '';
  /** Instant de la première frame (grâce avant d'accepter « passer ») ; -1 tant que la scène n'a pas tourné. */
  private openedAt = -1;
  /** Instant limite de la confirmation « passer » (deuxième appui sur retour) ; 0 = non armée. */
  private skipArmedUntil = 0;

  constructor() {
    super(SCENE_KEYS.Dialogue);
  }

  init(data: DialogueSceneData): void {
    this.session = data.session;
    this.stage = data.stage;
    this.index = 0;
    this.finished = false;
    this.lines = [];
    this.party = [];
    this.currentSpeaker = '';
    this.openedAt = -1;
    this.skipArmedUntil = 0;
  }

  create(): void {
    beginScene(this);
    this.cameras.main.setBackgroundColor(UI_THEME.bg);
    inputManager.attach();
    inputManager.setPlayerCount(this.session.playerCount);

    const level = getLevelByIndex(this.session.levelIndex);
    if (!level) {
      // Niveau inconnu (données corrompues) : on ne reste pas bloqué sur un écran vide.
      this.finished = true;
      this.scene.start(SCENE_KEYS.Menu, {});
      return;
    }
    this.lines = this.stage === 'intro' ? level.intro : level.outro;

    this.bg = createThemeBackground(this, level.theme, { dim: 0.3 });
    this.buildHeader(level.nameKey);
    this.buildParty();
    this.buildBox();

    this.nav = new MenuNavigator();
    this.input.on('pointerdown', (_p: Phaser.Input.Pointer, over: Phaser.GameObjects.GameObject[]) => {
      if (over.length === 0) this.advance();
    });
    bindLanguage(this, () => this.relabel());

    if (this.lines.length === 0) {
      this.finish();
      return;
    }
    this.showLine(0);
  }

  update(time: number, delta: number): void {
    if (!this.bg) return;
    this.bg.update(time);
    this.portrait?.update(time);
    this.animateParty(time);
    if (this.finished) return;

    if (this.openedAt < 0) this.openedAt = time;
    if (this.skipArmedUntil > 0 && time >= this.skipArmedUntil) this.disarmSkip();

    let advanced = false;
    for (const intent of this.nav.pollMenu()) {
      if (intent.action === 'confirm') {
        // Au plus un « confirmer » par frame : deux joueurs simultanés ne sautent pas une réplique non lue.
        if (!advanced) {
          advanced = true;
          this.disarmSkip();
          this.advance();
        }
      } else if (intent.action === 'back') {
        if (this.requestSkip(time)) break;
      }
    }

    if (this.typewriter.update(delta)) this.bodyText.setText(this.typewriter.visible);
    const waiting = this.typewriter.done;
    this.prompt.setVisible(waiting && Math.floor(time / 450) % 2 === 0);
  }

  /**
   * « Passer » au clavier / à la manette : ignoré pendant la grâce d'ouverture (les enfants martèlent B pendant la
   * célébration), puis il faut un DEUXIÈME appui rapproché (le texte d'aide s'illumine). Retourne true si on a terminé.
   */
  private requestSkip(time: number): boolean {
    if (this.finished || time - this.openedAt < SKIP_GRACE_MS) return false;
    if (this.skipArmedUntil > 0 && time < this.skipArmedUntil) {
      this.finish();
      return true;
    }
    this.skipArmedUntil = time + SKIP_CONFIRM_MS;
    this.skipText?.setColor('#ffd36b');
    return false;
  }

  private disarmSkip(): void {
    if (this.skipArmedUntil === 0) return;
    this.skipArmedUntil = 0;
    this.skipText?.setColor('#a8a2c8');
  }

  // ───────────────────────────── Construction ─────────────────────────────

  private buildHeader(nameKey: string): void {
    const n = this.session.levelIndex + 1;
    createPanel(this, GAME_WIDTH / 2 - 300, 6, 600, this.stage === 'outro' ? 122 : 92, PANEL_STYLES.dark).setAlpha(0.8);
    this.headerLevel = createText(this, GAME_WIDTH / 2, 30, t('result.level', { n }), { size: 'sm', color: UI_THEME.textDim, origin: [0.5, 0.5], align: 'center' });
    this.headerName = createText(this, GAME_WIDTH / 2, 66, t(nameKey), { size: 'lg', color: UI_THEME.accent, origin: [0.5, 0.5], align: 'center' });
    this.headerStage = createText(this, GAME_WIDTH / 2, 104, this.stage === 'outro' ? t('hud.levelComplete') : '', {
      size: 'md',
      color: UI_THEME.good,
      origin: [0.5, 0.5],
      align: 'center',
    });
  }

  /** Les héros choisis, alignés au centre de la scène (animation de respiration). */
  private buildParty(): void {
    const players = this.session.players;
    const scale = 5;
    const size = 16 * scale;
    const spacing = size + 40;
    const total = (players.length - 1) * spacing;
    const y = 300;
    players.forEach((p, i) => {
      const x = GAME_WIDTH / 2 - total / 2 + i * spacing;
      const shadow = this.add.graphics();
      shadow.fillStyle(0x000000, 0.35);
      shadow.fillEllipse(x, y + size / 2 - 4, size * 0.8, 14);
      const img = this.add.image(x, y, ATLAS_KEY, heroFrame(p.characterId, 'down', 0)).setScale(scale);
      const mark = this.add.graphics();
      mark.fillStyle(0x14121f, 1);
      mark.fillRect(x - 24, y + size / 2 + 6, 48, 10);
      mark.fillStyle(playerColor(p.id), 1);
      mark.fillRect(x - 22, y + size / 2 + 8, 44, 6);
      this.party.push({ img, characterId: p.characterId, baseY: y, i });
    });
  }

  private buildBox(): void {
    createPanel(this, BOX_X, BOX_Y, BOX_W, BOX_H, PANEL_STYLES.default);
    this.portrait = createPortrait(this, BOX_X + 24, BOX_Y + 22, 200, 170, () =>
      this.session.players.map((p) => ({ characterId: p.characterId, playerId: p.id })),
    );
    this.speakerText = createText(this, TEXT_X, BOX_Y + 20, '', { size: 'md', color: UI_THEME.text });
    this.bodyText = createText(this, TEXT_X, BOX_Y + 62, '', { size: 'md', wrapWidth: TEXT_W, lineSpacing: 8, stroke: null });
    this.dots = this.add.graphics();
    this.prompt = createText(this, BOX_X + BOX_W - 24, BOX_Y + BOX_H - 14, t('story.continue'), {
      size: 'sm',
      color: UI_THEME.accent,
      origin: [1, 1],
      align: 'right',
    });
    this.skipText = createText(this, GAME_WIDTH - 40, GAME_HEIGHT - 20, t('dialogue.skipHint'), {
      size: 'sm',
      color: UI_THEME.textDim,
      origin: [1, 0.5],
      align: 'right',
    });
    this.skipText.setInteractive({ useHandCursor: true });
    this.skipText.on('pointerdown', () => this.finish());
  }

  // ───────────────────────────── Répliques ─────────────────────────────

  private speakerName(id: string): string {
    const key = `speaker.${id}`;
    return hasKey(key) ? t(key) : t('speaker.narrator');
  }

  /** Affiche la réplique `i` (machine à écrire) ; `instant` = texte complet immédiatement. */
  private showLine(i: number, instant = false): void {
    const line = this.lines[i];
    if (!line) return;
    this.index = i;
    if (line.speaker !== this.currentSpeaker) {
      this.currentSpeaker = line.speaker;
      this.portrait.setSpeaker(line.speaker);
    }
    this.speakerText.setText(this.speakerName(line.speaker));
    this.speakerText.setColor('#' + speakerColor(line.speaker).toString(16).padStart(6, '0'));
    this.bodyText.setText('');
    const wrapped = prewrapText(this.bodyText, t(line.textKey));
    this.typewriter.reset(wrapped);
    if (instant) this.typewriter.skip();
    this.bodyText.setText(this.typewriter.visible);
    this.drawDots();
  }

  private drawDots(): void {
    const g = this.dots;
    g.clear();
    const n = this.lines.length;
    const size = 10;
    const gap = 6;
    const x0 = BOX_X + BOX_W - 24 - n * (size + gap) + gap;
    const y = BOX_Y + 20;
    for (let k = 0; k < n; k++) {
      g.fillStyle(0x14121f, 1);
      g.fillRect(x0 + k * (size + gap) - 1, y - 1, size + 2, size + 2);
      g.fillStyle(k < this.index ? 0x8a84c0 : k === this.index ? 0xffd36b : 0x3a3652, 1);
      g.fillRect(x0 + k * (size + gap), y, size, size);
    }
  }

  /** Action : finit la saisie en cours, ou passe à la réplique suivante (ou termine après la dernière). */
  private advance(): void {
    if (this.finished) return;
    if (!this.typewriter.done) {
      this.typewriter.skip();
      this.bodyText.setText(this.typewriter.visible);
      return;
    }
    if (this.index + 1 >= this.lines.length) this.finish();
    else this.showLine(this.index + 1);
  }

  /** Quitte la scène vers la suite du flux (voir menuLogic.nextAfterDialogue). */
  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    const next = nextAfterDialogue(this.session, this.stage, LEVELS.length);
    switch (next.to) {
      case 'game': {
        const data: GameSceneData = { session: next.session };
        transitionTo(this, SCENE_KEYS.Game, data);
        break;
      }
      case 'dialogue': {
        const data: DialogueSceneData = { session: next.session, stage: next.stage };
        transitionTo(this, SCENE_KEYS.Dialogue, data);
        break;
      }
      case 'result': {
        const data: ResultSceneData = { session: next.session, outcome: next.outcome };
        transitionTo(this, SCENE_KEYS.Result, data);
        break;
      }
    }
  }

  /** Changement de langue : textes recalculés (la réplique en cours s'affiche en entier). */
  private relabel(): void {
    const level = getLevelByIndex(this.session.levelIndex);
    if (!level || !this.headerName) return;
    this.headerLevel.setText(t('result.level', { n: this.session.levelIndex + 1 }));
    this.headerName.setText(t(level.nameKey));
    this.headerStage.setText(this.stage === 'outro' ? t('hud.levelComplete') : '');
    this.prompt.setText(t('story.continue'));
    this.skipText.setText(t('dialogue.skipHint'));
    if (!this.finished && this.lines[this.index]) this.showLine(this.index, true);
  }

  private animateParty(time: number): void {
    const heroesSpeak = this.currentSpeaker === 'heroes';
    for (const m of this.party) {
      const phase = Math.floor(time / 420 + m.i);
      m.img.setFrame(heroFrame(m.characterId, 'down', stepOf(phase)));
      const hop = heroesSpeak ? Math.abs(Math.sin(time / 160 + m.i)) * 8 : 0;
      m.img.setY(m.baseY - Math.round(hop) + (phase % 2 === 0 ? 0 : -2));
    }
  }
}
