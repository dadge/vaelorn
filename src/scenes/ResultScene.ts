/**
 * ResultScene : écran de fin.
 *
 *  - Victoire FINALE (dernier niveau terminé) : épilogue en machine à écrire (clés story.end.*) sur fond d'aube,
 *    le Cristal se reforme, puis Lyssa révèle l'ombre plus ancienne sous Vaelorn ; ensuite statistiques.
 *  - Victoire intermédiaire (non utilisée par le flux normal) et défaite : statistiques directement.
 *
 * Statistiques : temps, objectifs accomplis, fois à terre et ennemis vaincus par joueur (+ total d'équipe).
 * Boutons : Rejouer (victoire : depuis le niveau 1 ; défaite : on retente le niveau) / Menu principal
 * (/ Continuer pour une victoire intermédiaire). Toute la logique (totaux, formats, rejouer) est dans menuLogic.ts.
 */
import Phaser from 'phaser';
import { CHARACTERS } from '../core/characters';
import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import { t } from '../i18n/i18n';
import { MenuNavigator, inputManager } from '../input';
import { LEVELS, getLevelByIndex } from '../levels';
import { ATLAS_KEY, heroFrame, stepOf } from '../render/art';
import {
  advanceLevel,
  formatTime,
  isFinalVictory,
  objectivesSummary,
  replaySession,
  resultRows,
  resultTotals,
} from '../render/menuLogic';
import {
  SCENE_KEYS,
  type DialogueSceneData,
  type GameSession,
  type MenuSceneData,
  type ResultSceneData,
} from '../render/session';
import {
  PANEL_STYLES,
  Typewriter,
  UI_THEME,
  UiButton,
  beginScene,
  bindLanguage,
  createDawnBackground,
  createPanel,
  createText,
  playerColor,
  prewrapText,
  transitionTo,
  type DecorHandle,
} from '../render/ui';

const STORY_KEYS = ['story.end.line.1', 'story.end.line.2', 'story.end.line.3', 'story.end.line.4'] as const;
const CRYSTAL_X = GAME_WIDTH / 2;
const CRYSTAL_Y = 175;
const CRYSTAL_SCALE = 11;
const REFORM_MS = 3200;

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** Délai (ms) pendant lequel « confirmer » est ignoré après l'affichage des statistiques. */
const STATS_LOCK_MS = 1000;

export class ResultScene extends Phaser.Scene {
  private session!: GameSession;
  private outcome: 'victory' | 'defeat' = 'victory';
  private nav!: MenuNavigator;
  private bg!: DecorHandle;
  private phase: 'epilogue' | 'stats' = 'stats';
  private finished = false;

  // Épilogue
  private epilogueObjects: Phaser.GameObjects.GameObject[] = [];
  private page = 0;
  private typewriter = new Typewriter('');
  private pageText: Phaser.GameObjects.Text | null = null;
  private promptText: Phaser.GameObjects.Text | null = null;
  private cardTexts: Phaser.GameObjects.Text[] = [];
  private titleText: Phaser.GameObjects.Text | null = null;
  private pagesDone = false;
  private veil: Phaser.GameObjects.Graphics | null = null;
  private veilAlpha = 0;
  private eyes: Phaser.GameObjects.Graphics | null = null;
  private crystal: {
    img: Phaser.GameObjects.Image;
    glow: Phaser.GameObjects.Graphics;
    flash: Phaser.GameObjects.Graphics;
    shards: Array<{ img: Phaser.GameObjects.Image; angle: number; radius: number }>;
    t0: number;
  } | null = null;

  // Statistiques
  private statsObjects: Phaser.GameObjects.GameObject[] = [];
  private buttons: UiButton[] = [];
  private actions: Array<() => void> = [];
  private selected = 0;
  /** Temps restant (ms) pendant lequel « confirmer » est ignoré après l'ouverture des statistiques. */
  private statsLockMs = 0;
  private counters: Array<{ text: Phaser.GameObjects.Text; value: number }> = [];
  private statsBuilder: (() => void) | null = null;

  constructor() {
    super(SCENE_KEYS.Result);
  }

  init(data: ResultSceneData): void {
    this.session = data.session;
    this.outcome = data.outcome;
    this.finished = false;
    this.epilogueObjects = [];
    this.statsObjects = [];
    this.buttons = [];
    this.actions = [];
    this.counters = [];
    this.cardTexts = [];
    this.page = 0;
    this.pagesDone = false;
    this.pageText = null;
    this.promptText = null;
    this.titleText = null;
    this.veil = null;
    this.veilAlpha = 0;
    this.eyes = null;
    this.crystal = null;
    this.selected = 0;
    this.statsBuilder = null;
  }

  create(): void {
    beginScene(this);
    this.cameras.main.setBackgroundColor(UI_THEME.bg);
    inputManager.attach();
    inputManager.setPlayerCount(this.session.playerCount);

    const final = isFinalVictory(this.session, this.outcome, LEVELS.length);
    this.bg = createDawnBackground(this, { dim: this.outcome === 'defeat' ? 0.55 : final ? 0.1 : 0.3 });
    this.nav = new MenuNavigator();
    bindLanguage(this, () => this.relabel());

    this.input.on('pointerdown', (_p: Phaser.Input.Pointer, over: Phaser.GameObjects.GameObject[]) => {
      if (this.phase === 'epilogue' && over.length === 0) this.advanceEpilogue();
    });

    if (final) this.startEpilogue();
    else this.showStats();
  }

  update(time: number, delta: number): void {
    if (!this.bg) return;
    this.bg.update(time);
    this.updateCrystal(time);
    if (this.veil) {
      this.veil.clear();
      this.veil.fillStyle(0x0a0010, this.veilAlpha);
      this.veil.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
    }
    if (this.finished) return;

    if (this.statsLockMs > 0) this.statsLockMs = Math.max(0, this.statsLockMs - delta);

    for (const intent of this.nav.pollMenu()) {
      const phaseBefore = this.phase;
      if (this.phase === 'epilogue') {
        if (intent.action === 'confirm') this.advanceEpilogue();
        else if (intent.action === 'back') this.showStats();
      } else if (!(intent.action === 'confirm' && this.statsLockMs > 0)) {
        this.onStatsAction(intent.action);
      }
      // Changement de phase : les intentions restantes de la même frame sont jetées (pas d'épilogue → replay d'un coup).
      if (this.phase !== phaseBefore || this.finished) break;
    }

    if (this.phase === 'epilogue') {
      if (this.pageText && this.typewriter.update(delta)) this.pageText.setText(this.typewriter.visible);
      if (this.promptText) this.promptText.setVisible((this.typewriter.done || this.pagesDone) && Math.floor(time / 450) % 2 === 0);
    } else {
      this.animateHeroes(time);
    }
  }

  // ───────────────────────────── Épilogue ─────────────────────────────

  private startEpilogue(): void {
    this.phase = 'epilogue';
    const add = <T extends Phaser.GameObjects.GameObject>(o: T): T => {
      this.epilogueObjects.push(o);
      return o;
    };
    this.buildCrystal(add);
    this.veil = add(this.add.graphics().setDepth(5));
    this.eyes = add(this.add.graphics().setDepth(6));
    this.titleText = add(createText(this, GAME_WIDTH / 2, 330, t('story.end.title'), { size: 'lg', color: UI_THEME.accent, origin: [0.5, 0.5], align: 'center' }).setDepth(10));
    add(createPanel(this, 120, 372, GAME_WIDTH - 240, 210, PANEL_STYLES.default).setDepth(9).setAlpha(0.92));
    this.pageText = add(
      createText(this, GAME_WIDTH / 2, 477, '', {
        size: 'md',
        origin: [0.5, 0.5],
        align: 'center',
        wrapWidth: GAME_WIDTH - 320,
        lineSpacing: 10,
        stroke: null,
      }).setDepth(10),
    );
    this.promptText = add(createText(this, GAME_WIDTH - 150, 566, t('story.continue'), { size: 'sm', color: UI_THEME.accent, origin: [1, 1], align: 'right' }).setDepth(10));
    this.showPage(0);
  }

  /** Cristal de l'Aube : les éclats convergent, flash, puis le cristal entier flotte dans sa lueur. */
  private buildCrystal(add: <T extends Phaser.GameObjects.GameObject>(o: T) => T): void {
    const glow = add(this.add.graphics().setDepth(1));
    const img = add(this.add.image(CRYSTAL_X, CRYSTAL_Y, ATLAS_KEY, 'decor_crystal').setScale(CRYSTAL_SCALE).setDepth(2).setAlpha(0));
    const shards = Array.from({ length: 12 }, (_, i) => {
      const s = add(this.add.image(CRYSTAL_X, CRYSTAL_Y, ATLAS_KEY, i % 2 === 0 ? 'fx_shard' : 'decor_crystal').setDepth(3));
      s.setScale(i % 2 === 0 ? 6 : 3);
      return { img: s, angle: (i / 12) * Math.PI * 2, radius: 360 + (i % 3) * 70 };
    });
    const flash = add(this.add.graphics().setDepth(4));
    this.crystal = { img, glow, flash, shards, t0: -1 };
  }

  private updateCrystal(time: number): void {
    const c = this.crystal;
    if (!c) return;
    if (c.t0 < 0) c.t0 = time;
    const el = time - c.t0;
    const p = clamp01(el / REFORM_MS);
    const ease = p * p * (3 - 2 * p);
    const joined = p >= 1;
    for (const s of c.shards) {
      s.img.setVisible(!joined);
      if (joined) continue;
      const a = s.angle + (1 - ease) * 2.2;
      const r = s.radius * (1 - ease);
      s.img.setPosition(CRYSTAL_X + Math.cos(a) * r, CRYSTAL_Y + Math.sin(a) * r * 0.6);
      s.img.setAngle((a * 60) % 360);
    }
    c.img.setAlpha(clamp01((p - 0.7) / 0.3));
    c.img.setY(CRYSTAL_Y + (joined ? Math.round(Math.sin(time / 600) * 6) : 0));
    const pulse = 0.5 + 0.5 * Math.sin(time / 420);
    c.glow.clear();
    const gk = 0.3 + 0.7 * ease;
    for (let k = 3; k >= 1; k--) {
      c.glow.fillStyle(0x7df9ff, (0.05 + 0.03 * pulse) * gk);
      c.glow.fillCircle(CRYSTAL_X, CRYSTAL_Y, CRYSTAL_SCALE * (5 + k * 3.5));
    }
    c.flash.clear();
    const sinceJoin = el - REFORM_MS;
    if (sinceJoin >= 0 && sinceJoin < 700) {
      c.flash.fillStyle(0xffffff, 0.85 * (1 - sinceJoin / 700));
      c.flash.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
    }
    // Voile sombre progressif (révélation de l'ombre), yeux rouges à la dernière page.
    const target = this.page >= 2 && !this.pagesDone ? 0.5 : this.pagesDone ? 0.25 : 0;
    this.veilAlpha += (target - this.veilAlpha) * 0.04;
    if (this.eyes) {
      this.eyes.clear();
      if (this.page >= 3 && !this.pagesDone) {
        const blink = Math.sin(time / 900) > -0.85 ? 1 : 0.1;
        for (const dx of [-26, 26]) {
          this.eyes.fillStyle(0xff3050, 0.18 * blink);
          this.eyes.fillCircle(CRYSTAL_X + dx, 640, 22);
          this.eyes.fillStyle(0xff3050, blink);
          this.eyes.fillRect(CRYSTAL_X + dx - 8, 636, 16, 6);
          this.eyes.fillStyle(0xffd0d8, blink);
          this.eyes.fillRect(CRYSTAL_X + dx - 2, 637, 4, 4);
        }
      }
    }
  }

  private showPage(i: number, instant = false): void {
    if (!this.pageText) return;
    this.page = i;
    this.pageText.setText('');
    const wrapped = prewrapText(this.pageText, t(STORY_KEYS[i]));
    this.typewriter.reset(wrapped);
    if (instant) this.typewriter.skip();
    this.pageText.setText(this.typewriter.visible);
  }

  private advanceEpilogue(): void {
    if (this.phase !== 'epilogue' || this.finished) return;
    if (this.pagesDone) {
      this.showStats();
      return;
    }
    if (!this.typewriter.done) {
      this.typewriter.skip();
      this.pageText?.setText(this.typewriter.visible);
      return;
    }
    if (this.page + 1 < STORY_KEYS.length) {
      this.showPage(this.page + 1);
      return;
    }
    this.showEndCard();
  }

  /** Dernière carte : félicitations, « à suivre… », remerciements. */
  private showEndCard(): void {
    this.pagesDone = true;
    this.pageText?.setText('');
    const make = (key: string, y: number, size: 'lg' | 'md' | 'sm', color: number, delay: number): void => {
      const txt = createText(this, GAME_WIDTH / 2, y, t(key), { size, color, origin: [0.5, 0.5], align: 'center', wrapWidth: GAME_WIDTH - 320 }).setDepth(10).setAlpha(0);
      this.epilogueObjects.push(txt);
      this.cardTexts.push(txt);
      this.tweens.add({ targets: txt, alpha: 1, duration: 700, delay });
    };
    this.cardTexts = [];
    make('story.end.congrats', 440, 'lg', UI_THEME.accent, 0);
    make('story.end.tbc', 496, 'md', 0x7df9ff, 900);
    make('story.end.thanks', 538, 'sm', UI_THEME.text, 1800);
  }

  // ───────────────────────────── Statistiques ─────────────────────────────

  private showStats(): void {
    if (this.finished) return;
    for (const o of this.epilogueObjects) o.destroy();
    this.epilogueObjects = [];
    this.crystal = null;
    this.veil = null;
    this.eyes = null;
    this.pageText = null;
    this.promptText = null;
    this.titleText = null;
    this.cardTexts = [];
    this.phase = 'stats';
    this.buildStats();
    this.nav.reset();
    this.statsLockMs = STATS_LOCK_MS;
  }

  private heroImages: Array<{ img: Phaser.GameObjects.Image; characterId: GameSession['players'][number]['characterId']; i: number }> = [];

  private buildStats(): void {
    for (const o of this.statsObjects) o.destroy();
    this.statsObjects = [];
    this.buttons = [];
    this.actions = [];
    this.counters = [];
    this.heroImages = [];
    const add = <T extends Phaser.GameObjects.GameObject>(o: T): T => {
      this.statsObjects.push(o);
      return o;
    };
    const victory = this.outcome === 'victory';
    const final = isFinalVictory(this.session, this.outcome, LEVELS.length);

    add(createText(this, GAME_WIDTH / 2, 56, victory ? t('result.victory') : t('result.defeat'), {
      size: 'xxl',
      color: victory ? UI_THEME.accent : UI_THEME.bad,
      origin: [0.5, 0.5],
      align: 'center',
    }));
    const level = getLevelByIndex(this.session.levelIndex);
    const subtitle = final ? t('story.end.title') : level ? t(level.nameKey) : t('result.level', { n: this.session.levelIndex + 1 });
    add(createText(this, GAME_WIDTH / 2, 108, subtitle, { size: 'md', color: UI_THEME.textDim, origin: [0.5, 0.5], align: 'center' }));

    const rows = resultRows(this.session);
    const totals = resultTotals(rows);
    const px = 190;
    const py = 138;
    const pw = GAME_WIDTH - 2 * px;
    const rowH = 54;
    const ph = 150 + rows.length * rowH + 52;
    add(createPanel(this, px, py, pw, ph, PANEL_STYLES.default));

    // Temps et objectifs
    const counts = LEVELS.map((l) => l.objectives.length);
    const obj = objectivesSummary(this.session, this.outcome, counts);
    add(createText(this, px + 30, py + 22, t('result.stats'), { size: 'sm', color: UI_THEME.textDim }));
    // le « x/y accomplis » porte sur les objectifs personnels des niveaux joués (libellé « Objectifs perso (niveaux joués) »)
    const valueX = px + 520;
    add(createText(this, px + 30, py + 50, t('result.time'), { size: 'md', color: UI_THEME.textDim }));
    add(createText(this, valueX, py + 50, formatTime(this.session.stats.timeMs), { size: 'md', color: UI_THEME.text }));
    add(createText(this, px + 30, py + 82, t('result.objectives'), { size: 'md', color: UI_THEME.textDim }));
    add(createText(this, valueX, py + 82, t('result.objectives.value', { done: obj.done, total: obj.total }), { size: 'md', color: obj.done >= obj.total ? UI_THEME.good : UI_THEME.text }));

    // En-têtes de colonnes
    const colDowns = px + pw - 330;
    const colKills = px + pw - 130;
    const headY = py + 120;
    add(createText(this, colDowns, headY, t('result.downs'), { size: 'sm', color: UI_THEME.textDim, origin: [0.5, 0.5], align: 'center' }));
    add(createText(this, colKills, headY, t('result.kills'), { size: 'sm', color: UI_THEME.textDim, origin: [0.5, 0.5], align: 'center' }));

    let y = py + 144;
    rows.forEach((r, i) => {
      const color = playerColor(r.playerId);
      const sw = this.add.graphics();
      sw.fillStyle(0x14121f, 1);
      sw.fillRect(px + 24, y + 6, 10, rowH - 12);
      sw.fillStyle(color, 1);
      sw.fillRect(px + 26, y + 8, 6, rowH - 16);
      add(sw);
      const img = add(this.add.image(px + 74, y + rowH / 2, ATLAS_KEY, heroFrame(r.characterId, 'down', 0)).setScale(3));
      this.heroImages.push({ img, characterId: r.characterId, i });
      const def = CHARACTERS[r.characterId];
      add(createText(this, px + 118, y + rowH / 2, `${t(def.nameKey)}`, { size: 'md', color, origin: [0, 0.5] }));
      add(createText(this, px + 118 + 230, y + rowH / 2, t('hud.player', { n: r.playerId + 1 }), { size: 'sm', color: UI_THEME.textDim, origin: [0, 0.5] }));
      const dText = add(createText(this, colDowns, y + rowH / 2, '0', { size: 'md', origin: [0.5, 0.5], align: 'center', color: r.downs === 0 ? UI_THEME.good : UI_THEME.text }));
      const kText = add(createText(this, colKills, y + rowH / 2, '0', { size: 'md', origin: [0.5, 0.5], align: 'center' }));
      this.counters.push({ text: dText, value: r.downs }, { text: kText, value: r.kills });
      y += rowH;
    });

    // Total d'équipe
    const line = this.add.graphics();
    line.fillStyle(0x4a4670, 1);
    line.fillRect(px + 24, y + 4, pw - 48, 2);
    add(line);
    add(createText(this, px + 118, y + 28, t('hud.team'), { size: 'md', color: UI_THEME.accent, origin: [0, 0.5] }));
    const tD = add(createText(this, colDowns, y + 28, '0', { size: 'md', color: UI_THEME.accent, origin: [0.5, 0.5], align: 'center' }));
    const tK = add(createText(this, colKills, y + 28, '0', { size: 'md', color: UI_THEME.accent, origin: [0.5, 0.5], align: 'center' }));
    this.counters.push({ text: tD, value: totals.downs }, { text: tK, value: totals.kills });

    // Décompte animé des valeurs
    this.tweens.addCounter({
      from: 0,
      to: 1,
      duration: 900,
      delay: 250,
      onUpdate: (tw: Phaser.Tweens.Tween) => {
        const v = tw.getValue() ?? 0;
        for (const c of this.counters) c.text.setText(String(Math.round(c.value * v)));
      },
      onComplete: () => {
        for (const c of this.counters) c.text.setText(String(c.value));
      },
    });

    this.buildButtons(py + ph + 24, add);
  }

  private buildButtons(y: number, add: <T extends Phaser.GameObjects.GameObject>(o: T) => T): void {
    const victory = this.outcome === 'victory';
    const final = isFinalVictory(this.session, this.outcome, LEVELS.length);
    const defs: Array<{ label: () => string; action: () => void }> = [];
    if (victory && !final) defs.push({ label: () => t('result.continue'), action: () => this.goNext() });
    defs.push({ label: () => t('result.replay'), action: () => this.goReplay() });
    defs.push({ label: () => t('result.menu'), action: () => this.goMenu() });

    const w = 300;
    const gap = 28;
    const total = defs.length * w + (defs.length - 1) * gap;
    const x0 = (GAME_WIDTH - total) / 2;
    this.actions = defs.map((d) => d.action);
    this.buttons = defs.map((d, i) => {
      const b = new UiButton(this, x0 + i * (w + gap), y, {
        width: w,
        height: 46,
        label: d.label,
        onClick: () => {
          this.selected = i;
          this.applyButtonSelection();
          d.action();
        },
        onHover: () => {
          this.selected = i;
          this.applyButtonSelection();
        },
      });
      add(b.container);
      return b;
    });
    // Victoire finale : « Menu principal » par défaut (un appui accidentel ne relance pas la partie et ne perd pas les stats).
    this.selected = final ? defs.length - 1 : 0;
    this.applyButtonSelection();
  }

  private applyButtonSelection(): void {
    this.buttons.forEach((b, i) => b.setSelected(i === this.selected));
  }

  private onStatsAction(action: string): void {
    const n = this.buttons.length;
    if (n === 0) return;
    if (action === 'left' || action === 'up') this.selected = (this.selected + n - 1) % n;
    else if (action === 'right' || action === 'down') this.selected = (this.selected + 1) % n;
    else if (action === 'confirm') {
      this.actions[this.selected]?.();
      return;
    } else return;
    this.applyButtonSelection();
  }

  private animateHeroes(time: number): void {
    for (const h of this.heroImages) h.img.setFrame(heroFrame(h.characterId, 'down', stepOf(Math.floor(time / 380 + h.i))));
  }

  // ───────────────────────────── Sorties ─────────────────────────────

  private goReplay(): void {
    if (this.finished) return;
    this.finished = true;
    const data: DialogueSceneData = { session: replaySession(this.session, this.outcome), stage: 'intro' };
    transitionTo(this, SCENE_KEYS.Dialogue, data);
  }

  private goNext(): void {
    if (this.finished) return;
    this.finished = true;
    const data: DialogueSceneData = { session: advanceLevel(this.session), stage: 'intro' };
    transitionTo(this, SCENE_KEYS.Dialogue, data);
  }

  private goMenu(): void {
    if (this.finished) return;
    this.finished = true;
    const data: MenuSceneData = { session: replaySession(this.session, this.outcome) };
    transitionTo(this, SCENE_KEYS.Menu, data);
  }

  /** Changement de langue : on reconstruit le contenu de la phase courante. */
  private relabel(): void {
    if (this.finished) return;
    if (this.phase === 'stats') {
      this.buildStats();
      return;
    }
    this.titleText?.setText(t('story.end.title'));
    this.promptText?.setText(t('story.continue'));
    if (this.pagesDone) {
      const keys = ['story.end.congrats', 'story.end.tbc', 'story.end.thanks'];
      this.cardTexts.forEach((txt, i) => txt.setText(t(keys[i])));
    } else {
      this.showPage(this.page, true);
    }
  }
}
