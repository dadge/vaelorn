/**
 * MenuScene : menu principal navigable au clavier ET à la manette (MenuNavigator) et à la souris.
 *
 * Lignes : Jouer, Nombre de joueurs (1–4), Difficulté de CHAQUE joueur (1 facile / 2 normal / 3 difficile),
 * Niveau de départ, Langue (FR/EN, change tous les textes immédiatement), Plein écran, Contrôles (panneau : déplacement,
 * action, spécial, appeler, pause et menus au clavier et à la manette, manettes détectées), Musique (activée / désactivée) et Volume de la
 * musique (0-100 % par pas de 10, mémorisés : src/audio/musicSettings.ts). Le menu est SILENCIEUX ; la musique n'y est entendue qu'en
 * APERÇU tant qu'une des deux lignes « Musique » est sélectionnée (fondu à l'entrée et à la sortie). Chaque joueur choisit son appareil à l'écran de sélection
 * (rejoindre par bouton) : l'ancienne option « J1 à la manette » n'est donc plus affichée.
 * 100 % utilisable à la manette seule : croix / stick = naviguer et modifier, A = valider, B = fermer le panneau.
 * La manette qui lance « Jouer » réclame automatiquement l'emplacement 1 de l'écran de sélection.
 * Les choix sont mémorisés (localStorage) et passés à CharacterSelect sous forme de GameSession.
 *
 * MODE DÉMO (« attract mode », src/attract/) : sur l'écran-titre PRINCIPAL (ni panneau « Contrôles », ni dialogue, ni transition), une
 * minuterie d'inactivité (`IdleTimer`, remise à zéro par toute activité : clavier, souris / toucher / molette, manette, langue ; en pause
 * quand l'onglet est caché ; suspendue tant que l'invite de rotation d'un téléphone en portrait masque le jeu) lance, au bout de
 * `ATTRACT_IDLE_MS`, une démo (`GameScene` + `session.demo`) : niveau, héros et salle aléatoires, pilote automatique, aucune
 * sauvegarde. Au retour de la démo (`afterDemo`), les entrées sont AVALÉES pendant `ATTRACT_RETURN_GRACE_MS` : l'entrée qui a
 * interrompu la démo ne valide aucun élément. Désactivable (`?attract=0`) ; voir `src/attract/config.ts`.
 *
 * SAUVEGARDE (règles dans src/render/saveMenuLogic.ts, stockage dans src/core/saveRepository.ts) : « Continuer (Niveau X — Salle Y) »
 * en tête de liste UNIQUEMENT si une sauvegarde valide existe ; « Nouvelle partie » demande confirmation avant d'écraser une
 * sauvegarde ; « Effacer la sauvegarde » (en bas de liste) est toujours confirmé ; une sauvegarde illisible est signalée (alerte
 * une fois par lancement + ligne dédiée) avec le choix « conserver » / « repartir de zéro » (confirmation en plus) — elle n'est
 * JAMAIS supprimée sans confirmation. Les dialogues se pilotent au clavier, à la manette et à la souris ; « retour » = choix sûr.
 */
import Phaser from 'phaser';
import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import type { CharacterId } from '../core/types';
import { getMusic } from '../audio/music';
import { musicSettings, stepVolume } from '../audio/musicSettings';
import { SUPPORTED_LANGUAGES, getLanguage, setLanguage, t } from '../i18n/i18n';
import { CHARACTERS } from '../core/characters';
import { MenuNavigator, VIRTUAL_PAD_INDEX, inputManager, isNonStandardPad, listGamepads } from '../input';
import type { MenuAction } from '../input';
import { ATLAS_KEY } from '../render/art';
import { LEVELS, getLevelByIndex } from '../levels';
import {
  MENU_CHOICES_STORAGE_KEY,
  choicesFromSession,
  defaultMenuChoices,
  parseChoices,
  serializeChoices,
  sessionFromChoices,
  sessionForTutorial,
  setMenuDevice,
  shortPadName,
  withDifficulty,
  withPlayerCount,
  withStartLevel,
  type MenuChoices,
} from '../render/menuLogic';
import { SCENE_KEYS, type CharacterSelectSceneData, type GameSceneData, type MenuSceneData } from '../render/session';
import { initialDeviceFromMenuSource } from '../tutorial/deviceHints';
import { ActivityWatcher, carryActivity } from '../attract/activity';
import { ATTRACT_RETURN_GRACE_MS, ATTRACT_START_FADE_MS, getAttractConfig } from '../attract/config';
import { buildDemoSession } from '../attract/demoSession';
import { graceActive, graceUntil } from '../attract/demoFlow';
import { IdleTimer } from '../attract/idleTimer';
import { computeMobileUi } from '../mobile/device';
import { readEnvironment } from '../mobile/mobileUi';
import {
  chooseInDialog,
  eraseAction,
  errorReasonKey,
  menuSaveState,
  newGameAction,
  openSaveDialog,
  resumeAutoClaimDevice,
  saveDialogTexts,
  saveMenuLayout,
  sessionFromSave,
  stepSaveDialog,
  type MenuSaveState,
  type SaveDialog,
  type SaveDialogKind,
  type SaveDialogStep,
} from '../render/saveMenuLogic';
import { getSaveContext, getSaveRepository } from '../render/saveStore';
import {
  PANEL_STYLES,
  UI_THEME,
  css,
  UiButton,
  beginScene,
  bindLanguage,
  createDawnBackground,
  createPanel,
  createText,
  drawArrow,
  playerColor,
  transitionTo,
  type DecorHandle,
} from '../render/ui';

const ROWS_X = 450;
const ROWS_W = 780;
const ROW_H = 34; // 12 lignes au plus (4 joueurs + Continuer + Effacer la sauvegarde) doivent tenir au-dessus de la ligne d'aide
/** Avec la ligne « Tutoriel » (13 lignes sélectionnables au plus), les lignes sont un peu plus basses. */
const ROW_H_COMPACT = 31;
/** Nombre de lignes sélectionnables au-delà duquel on passe à `ROW_H_COMPACT`. */
const COMPACT_ROWS_FROM = 12;
/** Avec les lignes « Musique » et « Volume », 15 lignes sélectionnables au plus (sauvegarde + 4 joueurs) : lignes plus basses encore. */
const ROW_H_TIGHT = 28;
/** Nombre de lignes sélectionnables au-delà duquel on passe à `ROW_H_TIGHT`. */
const TIGHT_ROWS_FROM = 13;
/** Durée (s) du fondu de sortie de l'aperçu de la musique. */
const MUSIC_PREVIEW_FADE_S = 0.3;
const ROW_GAP = 3;
const ROWS_TOP = 152;
const VALUE_CX = 575;
const VALUE_W = 380;
const LABEL_MAX_W = 330;

/** Durée (ms) d'affichage d'un message d'information (sauvegarde effacée…). */
const NOTICE_MS = 3500;
/** L'alerte « sauvegarde illisible » n'est affichée automatiquement qu'une fois par lancement du jeu. */
let corruptNoticeShown = false;

/** Période (ms) de relecture de l'environnement mobile (invite de rotation) pour le mode démo. */
const ATTRACT_ENV_CHECK_MS = 500;

/** Durée (ms) du fondu d'entrée de la scène (valeur par défaut de `beginScene`) : la fenêtre de grâce ne commence qu'une fois le menu visible. */
const MENU_FADE_IN_MS = 250;

/**
 * Choix du menu et ligne sélectionnée mémorisés au lancement d'une démo, restitués au retour (`afterDemo`) : sans cela, un stockage
 * local indisponible ferait perdre le nombre de joueurs, et la ligne sélectionnée reviendrait toujours à « Jouer ».
 */
let demoReturnMemory: { choices: MenuChoices; selectedId: string } | null = null;

/** Horloge monotone (ms) du mode démo (minuterie d'inactivité et fenêtre de grâce). */
function attractNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Mode démo : minuterie d'inactivité + surveillant d'activité de CETTE instance de la scène. */
interface AttractRuntime {
  idle: IdleTimer;
  watcher: ActivityWatcher;
  /** Prochain instant (horloge `attractNow`) de relecture de l'environnement mobile. */
  envCheckAt: number;
  /** Le jeu est-il affichable (pas d'invite de rotation) ? */
  displayable: boolean;
}

/** Écrit `content` dans `text` et le réduit si besoin pour tenir dans `maxWidth` (jamais agrandi). */
function setFitted(text: Phaser.GameObjects.Text, content: string, maxWidth: number): void {
  text.setText(content);
  text.setScale(text.width > maxWidth ? maxWidth / text.width : 1);
}

/** Description d'une ligne du menu. */
interface RowSpec {
  id: string;
  kind: 'action' | 'choice' | 'note';
  label: () => string;
  value?: () => string;
  /** Couleur du libellé (couleur du joueur pour les difficultés). */
  color?: number;
  left?: () => void;
  right?: () => void;
  confirm?: () => void;
}

/** Objets Phaser d'une ligne affichée. */
interface RowView {
  spec: RowSpec;
  container: Phaser.GameObjects.Container;
  normal: Phaser.GameObjects.Graphics | null;
  selected: Phaser.GameObjects.Graphics | null;
  label: Phaser.GameObjects.Text;
  value: Phaser.GameObjects.Text | null;
  height: number;
}

export class MenuScene extends Phaser.Scene {
  private choices: MenuChoices = defaultMenuChoices();
  private lastCharacters: CharacterId[] = [];
  private nav!: MenuNavigator;
  private bg!: DecorHandle;
  private title!: Phaser.GameObjects.Text;
  private subtitle!: Phaser.GameObjects.Text;
  private hint!: Phaser.GameObjects.Text;
  private info!: Phaser.GameObjects.Text;
  private rows: RowView[] = [];
  private rowH = ROW_H;
  private selectedId = 'play';
  private controls: {
    objects: Phaser.GameObjects.GameObject[];
    assignments: Phaser.GameObjects.Container | null;
    refreshAt: number;
  } | null = null;
  private lastTime = 0;
  /** Périphérique de la dernière intention de menu (null après un clic souris). */
  private lastSource: string | null = null;
  /** true dès que « Jouer » est validé : la scène ignore toute entrée pendant le fondu (évite d'écraser le périphérique mémorisé). */
  private starting = false;
  /** État de la sauvegarde (relu à chaque ouverture du menu ; jamais modifié sans confirmation). */
  private saveState: MenuSaveState = { kind: 'none' };
  /** Dialogue modal ouvert (confirmation, sauvegarde illisible) et ses objets Phaser. */
  private dialog: SaveDialog | null = null;
  private dialogObjects: Phaser.GameObjects.GameObject[] = [];
  private dialogButtons: UiButton[] = [];
  /** Message d'information temporaire (affiché à la place de l'aide de la ligne). */
  private notice: { text: string; until: number } | null = null;
  /** Mode démo (null si désactivé : `?attract=0`, mode de test). */
  private attract: AttractRuntime | null = null;
  /** true dès que la démo est lancée (fondu en cours) : on continue de surveiller le joueur pour ne pas perdre une action. */
  private demoLaunching = false;
  /** Retour d'une démo : les entrées sont avalées jusqu'à cet instant (horloge `attractNow`), null sinon. */
  private graceUntilMs: number | null = null;
  /** Cette instance de la scène est un retour de démo (la grâce est armée dans `create`, une fois le menu affiché). */
  private afterDemo = false;
  /** Aperçu de la musique en cours (une ligne « Musique » est sélectionnée). */
  private musicPreview = false;
  /** Prochain instant (ms de scène) où retenter la reprise du contexte audio pendant l'aperçu. */
  private nextAudioNudgeAt = 0;

  constructor() {
    super(SCENE_KEYS.Menu);
  }

  init(data?: MenuSceneData): void {
    const stored = this.loadChoices();
    this.afterDemo = data?.afterDemo === true;
    const memory = this.afterDemo ? demoReturnMemory : null;
    demoReturnMemory = null;
    this.choices = data?.session ? choicesFromSession(data.session, stored ?? defaultMenuChoices()) : (memory?.choices ?? stored ?? defaultMenuChoices());
    this.lastCharacters = data?.session ? data.session.players.map((p) => p.characterId) : [];
    this.saveState = this.loadSaveState();
    this.selectedId = memory?.selectedId ?? saveMenuLayout(this.saveState).defaultRow; // buildRows() retombe sur « Jouer » si la ligne n'existe plus
    this.rows = [];
    this.controls = null;
    this.dialog = null;
    this.dialogObjects = [];
    this.dialogButtons = [];
    this.notice = null;
    this.lastSource = null;
    this.starting = false;
    this.demoLaunching = false;
    this.attract = null;
    this.graceUntilMs = null;
    this.musicPreview = false;
    this.nextAudioNudgeAt = 0;
  }

  create(): void {
    beginScene(this);
    this.cameras.main.setBackgroundColor(UI_THEME.bg);
    this.applyInputSettings();

    this.bg = createDawnBackground(this, { crystal: { x: 235, y: 420, scale: 14 }, dim: 0.12 });
    this.title = createText(this, GAME_WIDTH / 2, 50, t('menu.title'), { size: 'xxl', color: UI_THEME.accent, origin: [0.5, 0.5], align: 'center' });
    this.subtitle = createText(this, GAME_WIDTH / 2, 108, t('menu.subtitle'), { size: 'md', color: UI_THEME.textDim, origin: [0.5, 0.5], align: 'center' });
    this.info = createText(this, ROWS_X + ROWS_W / 2, GAME_HEIGHT - 52, '', {
      size: 'sm',
      color: UI_THEME.textDim,
      origin: [0.5, 0.5],
      align: 'center',
      wrapWidth: ROWS_W,
    });
    this.hint = createText(this, GAME_WIDTH / 2, GAME_HEIGHT - 20, t('pad.menu.hint'), {
      size: 'sm',
      color: UI_THEME.textDim,
      origin: [0.5, 0.5],
      align: 'center',
    });

    this.buildRows();

    // Navigation (créée APRÈS l'affichage : les touches déjà tenues sont ignorées jusqu'au relâchement).
    this.nav = new MenuNavigator();

    bindLanguage(this, () => this.relabel());

    const onFullscreen = (): void => this.refreshValues();
    this.scale.on('enterfullscreen', onFullscreen);
    this.scale.on('leavefullscreen', onFullscreen);
    this.events.once('shutdown', () => {
      this.scale.off('enterfullscreen', onFullscreen);
      this.scale.off('leavefullscreen', onFullscreen);
      if (this.musicPreview) {
        this.musicPreview = false;
        getMusic().stop(MUSIC_PREVIEW_FADE_S); // l'aperçu ne déborde jamais sur une autre scène
      }
      this.rows = [];
      this.controls = null;
      this.dialog = null;
      this.dialogObjects = [];
      this.dialogButtons = [];
    });

    this.setupAttract();
    // Retour de démo : grâce armée ICI (et non dans init) et décomptée après le fondu d'entrée, pour qu'elle couvre bien le moment où
    // le menu devient visible, même sur une machine lente.
    if (this.afterDemo) this.graceUntilMs = graceUntil(attractNow() + MENU_FADE_IN_MS, ATTRACT_RETURN_GRACE_MS);

    // Sauvegarde illisible : on prévient une fois par lancement (rien n'est supprimé sans confirmation).
    if (this.saveState.kind === 'corrupt' && !corruptNoticeShown) {
      corruptNoticeShown = true;
      this.openDialog('corrupt');
    }
  }

  update(time: number): void {
    this.lastTime = time;
    if (this.notice && time >= this.notice.until) {
      this.notice = null;
      this.refreshInfo();
    }
    this.bg.update(time);
    this.title.setY(50 + Math.round(Math.sin(time / 700) * 3));
    this.updateAttract();
    // Aperçu musical à la manette seule : un bouton de manette n'est pas toujours un geste qui débloque l'audio ; on retente périodiquement.
    if (this.musicPreview && time >= this.nextAudioNudgeAt) {
      this.nextAudioNudgeAt = time + 500;
      getMusic().nudge();
    }
    if (this.starting) return;
    const swallow = this.inGrace();
    for (const intent of this.nav.pollMenu()) {
      if (swallow) continue; // retour de démo : l'entrée qui l'a interrompue (ou son répétiteur) ne valide rien
      this.lastSource = intent.source;
      this.onAction(intent.action);
    }
    if (this.controls && time >= this.controls.refreshAt) {
      this.controls.refreshAt = time + 500;
      this.buildAssignments();
    }
  }

  // ───────────────────────────── Mode démo (attract) ─────────────────────────────

  /** Fenêtre de grâce après un retour de démo : les entrées sont avalées. */
  private inGrace(): boolean {
    return graceActive(attractNow(), this.graceUntilMs);
  }

  /** Crée la minuterie d'inactivité et le surveillant d'activité (sauf si la démo est désactivée). Nettoyés à la fermeture de la scène. */
  private setupAttract(): void {
    const cfg = getAttractConfig();
    if (!cfg.enabled) return;
    const watcher = new ActivityWatcher();
    watcher.start();
    this.attract = {
      idle: new IdleTimer({ thresholdMs: cfg.idleMs, clock: attractNow, active: false }),
      watcher,
      envCheckAt: 0,
      displayable: true,
    };
    // Onglet caché : Phaser suspend sa boucle (aucun `update`), il faut donc mettre la minuterie en pause À L'ÉVÉNEMENT, sinon la durée
    // passée en arrière-plan serait comptée comme de l'inactivité au retour.
    const onVisibility = (): void => this.attract?.idle.setPaused(typeof document !== 'undefined' && document.hidden === true);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
    this.events.once('shutdown', () => {
      watcher.stop();
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
      this.attract = null;
    });
  }

  /** Le jeu est-il affiché (pas d'invite « tourne ton téléphone » par-dessus) ? Relu toutes les 500 ms. */
  private gameDisplayable(a: AttractRuntime): boolean {
    const now = attractNow();
    if (now >= a.envCheckAt) {
      a.envCheckAt = now + ATTRACT_ENV_CHECK_MS;
      try {
        a.displayable = !computeMobileUi(readEnvironment()).showRotatePrompt;
      } catch {
        a.displayable = true;
      }
    }
    return a.displayable;
  }

  /**
   * À chaque image : surveille le joueur et fait avancer la minuterie. Armée UNIQUEMENT à l'écran-titre principal (ni panneau
   * « Contrôles », ni dialogue, ni transition, ni invite de rotation) ; une activité la remet à zéro ; en pause onglet caché.
   */
  private updateAttract(): void {
    const a = this.attract;
    if (!a) return;
    const active = a.watcher.poll();
    if (this.demoLaunching) {
      if (active) carryActivity(); // action pendant le fondu vers la démo : la démo s'arrêtera dès son démarrage
      return;
    }
    if (active) a.idle.reset();
    a.idle.setActive(!this.starting && !this.dialog && !this.controls && this.gameDisplayable(a));
    a.idle.setPaused(typeof document !== 'undefined' && document.hidden === true);
    if (a.idle.poll()) this.startDemo();
  }

  /**
   * Lance la démo : session aléatoire (`Math.random` ICI, côté scène : le coeur n'en voit jamais), un seul joueur, aucune sauvegarde
   * ni aucun choix du menu modifié. Les appareils sont remis à zéro (la démo ne lit aucune entrée humaine).
   */
  private startDemo(): void {
    if (this.starting || this.demoLaunching) return;
    this.starting = true;
    this.demoLaunching = true;
    demoReturnMemory = { choices: this.choices, selectedId: this.selectedId };
    inputManager.attach();
    inputManager.clearAssignments();
    inputManager.setPlayer1Gamepad(false);
    inputManager.setPlayerCount(1);
    const session = buildDemoSession(Math.random, { durationMs: getAttractConfig().demoMs });
    const data: GameSceneData = { session };
    transitionTo(this, SCENE_KEYS.Game, data, ATTRACT_START_FADE_MS);
  }

  // ───────────────────────────── État / persistance ─────────────────────────────

  private loadChoices(): MenuChoices | null {
    try {
      return parseChoices(globalThis.localStorage?.getItem(MENU_CHOICES_STORAGE_KEY), LEVELS.length);
    } catch {
      return null;
    }
  }

  private saveChoices(): void {
    try {
      globalThis.localStorage?.setItem(MENU_CHOICES_STORAGE_KEY, serializeChoices(this.choices));
    } catch {
      /* stockage indisponible : sans gravité */
    }
  }

  /** Lit la sauvegarde (lecture seule : ne modifie ni ne supprime jamais rien, même si elle est corrompue). */
  private loadSaveState(): MenuSaveState {
    try {
      return menuSaveState(getSaveRepository().load(), getSaveContext());
    } catch {
      return { kind: 'unavailable' };
    }
  }

  /** « Niveau X — Salle Y » de la sauvegarde valide (chaîne vide sinon). */
  private resumeLabel(): string {
    if (this.saveState.kind !== 'valid') return '';
    const r = this.saveState.resume;
    return t('save.resume', { level: r.level, room: r.room });
  }

  /** Propage le nombre de joueurs à l'InputManager ; les appareils se choisissent à l'écran de sélection. */
  private applyInputSettings(): void {
    inputManager.attach();
    inputManager.clearAssignments();
    inputManager.setPlayer1Gamepad(false);
    inputManager.setPlayerCount(this.choices.playerCount);
  }

  private commit(next: MenuChoices): void {
    this.choices = next;
    this.saveChoices();
    this.applyInputSettings();
    this.buildRows();
    if (this.controls) this.buildAssignments();
  }

  // ───────────────────────────── Lignes ─────────────────────────────

  private specs(): RowSpec[] {
    const c = this.choices;
    const specs: RowSpec[] = [];
    const layout = saveMenuLayout(this.saveState);
    if (layout.showContinue) {
      specs.push({
        id: 'continue',
        kind: 'action',
        label: () => t('save.continue.detail', { resume: this.resumeLabel() }),
        confirm: () => this.continueGame(),
      });
    }
    if (layout.showCorruptRow) {
      specs.push({ id: 'corrupt', kind: 'action', color: UI_THEME.bad, label: () => t('save.corrupt.row'), confirm: () => this.openDialog('corrupt') });
    }
    specs.push({
      id: 'play',
      kind: 'action',
      label: () => t(layout.playLabelKey),
      confirm: () => this.onNewGame(),
    });
    specs.push({ id: 'tutorial', kind: 'action', label: () => t('menu.tutorial'), confirm: () => this.startTutorial() });
    specs.push({
      id: 'players',
      kind: 'choice',
      label: () => t('menu.players'),
      value: () => (c.playerCount === 1 ? t('menu.players.one', { count: 1 }) : t('menu.players.many', { count: c.playerCount })),
      left: () => this.commit(withPlayerCount(c, c.playerCount === 1 ? 4 : c.playerCount - 1)),
      right: () => this.commit(withPlayerCount(c, c.playerCount === 4 ? 1 : c.playerCount + 1)),
    });
    for (let i = 0; i < c.playerCount; i++) {
      specs.push({
        id: `diff${i}`,
        kind: 'choice',
        color: playerColor(i),
        label: () => t('menu.difficulty.forPlayer', { n: i + 1 }),
        value: () => t(`menu.difficulty.${c.difficulties[i]}`),
        left: () => this.commit(withDifficulty(c, i, -1)),
        right: () => this.commit(withDifficulty(c, i, 1)),
      });
    }
    specs.push({ id: 'note', kind: 'note', label: () => t('menu.difficulty.note') });
    specs.push({
      id: 'level',
      kind: 'choice',
      label: () => t('menu.startLevel'),
      value: () => {
        const level = getLevelByIndex(c.startLevel);
        return `${c.startLevel + 1}. ${level ? t(level.nameKey) : t('result.level', { n: c.startLevel + 1 })}`;
      },
      left: () => this.commit(withStartLevel(c, -1, LEVELS.length)),
      right: () => this.commit(withStartLevel(c, 1, LEVELS.length)),
    });
    const toggleLang = (): void => {
      const langs = SUPPORTED_LANGUAGES;
      const next = langs[(langs.indexOf(getLanguage()) + 1) % langs.length];
      setLanguage(next);
    };
    specs.push({
      id: 'language',
      kind: 'choice',
      label: () => t('menu.language'),
      value: () => t(`menu.language.${getLanguage()}`),
      left: toggleLang,
      right: toggleLang,
      confirm: toggleLang,
    });
    const toggleFs = (): void => {
      try {
        this.scale.toggleFullscreen();
      } catch {
        /* plein écran refusé par le navigateur */
      }
    };
    specs.push({
      id: 'fullscreen',
      kind: 'choice',
      label: () => t('menu.fullscreen'),
      value: () => (this.scale.isFullscreen ? t('menu.on') : t('menu.off')),
      left: toggleFs,
      right: toggleFs,
      confirm: toggleFs,
    });
    const toggleMusic = (): void => {
      musicSettings.update({ enabled: !musicSettings.effective().enabled });
      this.refreshValues();
      this.syncMusicPreview(); // l'action du joueur lance l'aperçu même si la ligne n'avait été que survolée
    };
    specs.push({
      id: 'music',
      kind: 'choice',
      label: () => t('audio.music'),
      value: () => (musicSettings.effective().enabled ? t('audio.music.on') : t('audio.music.off')),
      left: toggleMusic,
      right: toggleMusic,
      confirm: toggleMusic,
    });
    const stepMusicVolume = (direction: 1 | -1): void => {
      musicSettings.update({ volume: stepVolume(musicSettings.get().volume, direction) });
      this.refreshValues();
      this.syncMusicPreview();
    };
    specs.push({
      id: 'musicVolume',
      kind: 'choice',
      label: () => t('audio.volume'),
      value: () => t('audio.volume.value', { percent: musicSettings.get().volume }),
      left: () => stepMusicVolume(-1),
      right: () => stepMusicVolume(1),
    });
    specs.push({ id: 'controls', kind: 'action', label: () => t('menu.controls'), confirm: () => this.openControls() });
    if (layout.showErase) {
      specs.push({ id: 'erase', kind: 'action', label: () => t('save.erase'), confirm: () => this.onErase() });
    }
    return specs;
  }

  private selectable(): RowView[] {
    return this.rows.filter((r) => r.spec.kind !== 'note');
  }

  /** (Re)construit toutes les lignes ; conserve la sélection par identifiant. */
  private buildRows(): void {
    for (const r of this.rows) r.container.destroy();
    this.rows = [];
    let y = ROWS_TOP;
    const specs = this.specs();
    // 13 lignes sélectionnables au plus (avec « Tutoriel ») : lignes un peu plus basses pour tout tenir au-dessus de la ligne d'aide
    const selectableCount = specs.filter((x) => x.kind !== 'note').length;
    this.rowH = selectableCount > TIGHT_ROWS_FROM ? ROW_H_TIGHT : selectableCount > COMPACT_ROWS_FROM ? ROW_H_COMPACT : ROW_H;
    for (const spec of specs) {
      const view = this.createRowView(spec, y);
      this.rows.push(view);
      y += view.height + ROW_GAP;
    }
    if (!this.selectable().some((r) => r.spec.id === this.selectedId)) this.selectedId = 'play';
    this.applySelection();
  }

  private createRowView(spec: RowSpec, y: number): RowView {
    if (spec.kind === 'note') {
      const h = 24;
      const label = createText(this, ROWS_W / 2, h / 2, spec.label(), {
        size: 'sm',
        color: UI_THEME.textDim,
        origin: [0.5, 0.5],
        align: 'center',
      });
      const container = this.add.container(ROWS_X, y, [label]);
      return { spec, container, normal: null, selected: null, label, value: null, height: h };
    }
    const w = ROWS_W;
    const h = this.rowH;
    const normal = createPanel(this, 0, 0, w, h, PANEL_STYLES.default);
    const selected = createPanel(this, 0, 0, w, h, PANEL_STYLES.selected);
    const isAction = spec.kind === 'action';
    const label = createText(this, isAction ? w / 2 : 20, h / 2, spec.label(), {
      size: 'md',
      color: spec.color ?? UI_THEME.text,
      origin: isAction ? [0.5, 0.5] : [0, 0.5],
      align: isAction ? 'center' : 'left',
    });
    if (!isAction) setFitted(label, spec.label(), LABEL_MAX_W);
    const children: Phaser.GameObjects.GameObject[] = [normal, selected, label];
    let value: Phaser.GameObjects.Text | null = null;
    if (spec.value) {
      value = createText(this, VALUE_CX, h / 2, '', { size: 'md', color: UI_THEME.accent, origin: [0.5, 0.5], align: 'center' });
      setFitted(value, spec.value(), VALUE_W - 64);
      const arrows = this.add.graphics();
      drawArrow(arrows, VALUE_CX - VALUE_W / 2 + 6, h / 2, 'left', 5, UI_THEME.accent);
      drawArrow(arrows, VALUE_CX + VALUE_W / 2 - 6, h / 2, 'right', 5, UI_THEME.accent);
      children.push(arrows, value);
    }
    const zone = this.add.zone(0, 0, w, h).setOrigin(0, 0);
    children.push(zone);
    const container = this.add.container(ROWS_X, y, children);
    zone.setInteractive({ useHandCursor: true });
    zone.on('pointerover', () => {
      if (this.controls || this.dialog || this.starting) return;
      this.selectedId = spec.id;
      this.applySelection(false); // le simple survol ne lance pas l'aperçu musical (ni ne crée un contexte audio avant tout geste)
    });
    zone.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      if (this.controls || this.dialog || this.starting || this.inGrace()) return;
      this.lastSource = null;
      this.selectedId = spec.id;
      this.applySelection();
      if (spec.kind === 'action') {
        spec.confirm?.();
        return;
      }
      const localX = pointer.x - ROWS_X;
      if (localX < VALUE_CX - 40) (spec.left ?? spec.right)?.();
      else (spec.right ?? spec.left)?.();
    });
    return { spec, container, normal, selected, label, value, height: h };
  }

  private applySelection(startPreview: boolean = true): void {
    for (const r of this.rows) {
      if (!r.normal || !r.selected) continue;
      const on = r.spec.id === this.selectedId;
      r.normal.setVisible(!on);
      r.selected.setVisible(on);
      r.label.setColor(css(r.spec.color ?? (on ? UI_THEME.accent : UI_THEME.text)));
    }
    this.refreshInfo();
    this.syncMusicPreview(startPreview);
  }

  /**
   * Aperçu de la musique : joue (fondu d'entrée) tant qu'une ligne « Musique » est sélectionnée AU CLAVIER, À LA MANETTE OU AU CLIC (un geste de
   * l'utilisateur), s'arrête (fondu) sinon. `allowStart = false` (survol à la souris) ne lance jamais l'aperçu, mais l'arrête si besoin.
   */
  private syncMusicPreview(allowStart: boolean = true): void {
    const want = this.selectedId === 'music' || this.selectedId === 'musicVolume';
    if (want === this.musicPreview) return;
    if (want && !allowStart) return;
    this.musicPreview = want;
    if (want) getMusic().start();
    else getMusic().stop(MUSIC_PREVIEW_FADE_S);
  }

  private refreshInfo(): void {
    const sel = this.selectedId;
    if (this.notice) {
      this.info.setText(this.notice.text);
    } else if (sel === 'continue' && this.saveState.kind === 'valid') {
      const names = this.saveState.save.players.map((p) => t(CHARACTERS[p.characterId].nameKey)).join(', ');
      this.info.setText(t('save.continue.team', { names }));
    } else if (sel === 'tutorial') {
      this.info.setText(t('menu.tutorial.hint'));
    } else if (sel === 'music' || sel === 'musicVolume') {
      this.info.setText(t('audio.hint'));
    } else if (sel.startsWith('diff')) {
      const i = Number(sel.slice(4));
      this.info.setText(t(`menu.difficulty.${this.choices.difficulties[i]}.desc`));
    } else {
      this.info.setText('');
    }
  }

  /** Recalcule les valeurs affichées (plein écran, etc.) sans reconstruire. */
  private refreshValues(): void {
    for (const r of this.rows) {
      if (r.value && r.spec.value) setFitted(r.value, r.spec.value(), VALUE_W - 64);
    }
  }

  /** Changement de langue : tous les textes sont recalculés. */
  private relabel(): void {
    this.attract?.watcher.notify(); // changer de langue est une activité : le compte à rebours de la démo repart
    this.title.setText(t('menu.title'));
    this.subtitle.setText(t('menu.subtitle'));
    this.hint.setText(t('pad.menu.hint'));
    this.buildRows();
    if (this.controls) {
      this.closeControls();
      this.openControls();
    }
    if (this.dialog) this.buildDialog();
  }

  // ───────────────────────────── Actions ─────────────────────────────

  private onAction(action: MenuAction): void {
    if (this.dialog) {
      this.applyDialogStep(stepSaveDialog(this.dialog, action));
      return;
    }
    if (this.controls) {
      if (action === 'back' || action === 'confirm') this.closeControls();
      return;
    }
    const rows = this.selectable();
    const idx = Math.max(
      0,
      rows.findIndex((r) => r.spec.id === this.selectedId),
    );
    const cur = rows[idx];
    switch (action) {
      case 'up':
      case 'down': {
        const next = rows[(idx + (action === 'down' ? 1 : rows.length - 1)) % rows.length];
        this.selectedId = next.spec.id;
        this.applySelection();
        break;
      }
      case 'left':
        (cur?.spec.left ?? undefined)?.();
        break;
      case 'right':
        (cur?.spec.right ?? undefined)?.();
        break;
      case 'confirm':
        if (cur?.spec.confirm) cur.spec.confirm();
        else (cur?.spec.right ?? undefined)?.();
        break;
      default:
        break;
    }
  }

  private startGame(): void {
    if (this.starting) return;
    this.starting = true;
    this.applyInputSettings();
    // La manette qui valide « Jouer » réclamera l'emplacement 1 (CharacterSelectScene) ; clavier / souris : rien.
    setMenuDevice(this.lastSource !== null && this.lastSource.startsWith('gamepad:') ? this.lastSource : null);
    const session = sessionFromChoices(this.choices, this.lastCharacters, LEVELS.length);
    const data: CharacterSelectSceneData = { session };
    transitionTo(this, SCENE_KEYS.CharacterSelect, data);
  }

  /**
   * « Tutoriel » : lance le niveau-tutoriel (1 humain + partenaire scripté, `GameScene` + `session.tutorial`). NE lit ni n'écrit aucune
   * sauvegarde, aucun choix du menu (`saveChoices` n'est pas appelé) et ne demande aucune confirmation : il n'écrase jamais rien.
   * L'appareil qui a validé la ligne (clavier, manette, manette virtuelle tactile) sert aux libellés de boutons avant la première entrée.
   */
  private startTutorial(): void {
    if (this.starting) return;
    this.starting = true;
    inputManager.attach();
    inputManager.clearAssignments();
    inputManager.setPlayer1Gamepad(false);
    inputManager.setPlayerCount(1);
    const padIndex = this.lastSource !== null && this.lastSource.startsWith('gamepad:') ? Number(this.lastSource.slice(8)) : -1;
    const padName = listGamepads().find((p) => p.index === padIndex)?.id;
    const session = sessionForTutorial(this.lastCharacters, initialDeviceFromMenuSource(this.lastSource, padName), this.choices.playerCount);
    const data: GameSceneData = { session };
    transitionTo(this, SCENE_KEYS.Game, data);
  }

  /** « Nouvelle partie » : confirmation avant d'écraser une sauvegarde existante (valide ou illisible), sinon on lance. */
  private onNewGame(): void {
    if (newGameAction(this.saveState) === 'confirm') this.openDialog('confirmNewGame');
    else this.startGame();
  }

  /**
   * « Continuer » : équipe, niveau et salle de la sauvegarde. L'équipe est FIGÉE : on passe par la salle d'attente de
   * CharacterSelectScene (mode `resume`, personnages verrouillés) où chaque joueur n'a plus qu'à appuyer sur un bouton pour
   * rejoindre sa place — les appareils sont ainsi toujours attribués à de vrais périphériques présents.
   * L'appareil qui a validé « Continuer » (clavier ou manette) réclame automatiquement la place 1.
   */
  private continueGame(): void {
    if (this.starting || this.saveState.kind !== 'valid') return;
    const session = sessionFromSave(this.saveState.save, getSaveContext());
    if (!session) return;
    this.starting = true;
    inputManager.attach();
    inputManager.clearAssignments();
    inputManager.setPlayer1Gamepad(false);
    inputManager.setPlayerCount(session.playerCount);
    setMenuDevice(resumeAutoClaimDevice(this.lastSource));
    const data: CharacterSelectSceneData = { session, resume: true };
    transitionTo(this, SCENE_KEYS.CharacterSelect, data);
  }

  /** « Effacer la sauvegarde » (options) : toujours derrière une confirmation. */
  private onErase(): void {
    const kind = eraseAction(this.saveState);
    if (kind) this.openDialog(kind);
  }

  /** Efface réellement la sauvegarde (appelé UNIQUEMENT après confirmation dans un dialogue). */
  private eraseSave(): void {
    const res = getSaveRepository().clear();
    if (res.ok) {
      this.saveState = { kind: 'none' };
      this.selectedId = 'play';
      this.notice = { text: t('save.erase.done'), until: this.lastTime + NOTICE_MS };
    } else {
      this.notice = { text: t('save.erase.failed'), until: this.lastTime + NOTICE_MS };
    }
    this.buildRows();
  }

  // ───────────────────────────── Dialogues de sauvegarde ─────────────────────────────

  private openDialog(kind: SaveDialogKind): void {
    this.dialog = openSaveDialog(kind);
    this.buildDialog();
  }

  /** Applique le résultat d'une interaction : nouveau dialogue (ou fermeture) puis effet éventuel. */
  private applyDialogStep(step: SaveDialogStep): void {
    this.dialog = step.dialog;
    if (this.dialog) {
      this.buildDialog();
    } else {
      this.destroyDialog();
      this.nav.reset();
    }
    if (step.effect === 'startNewGame') this.startGame();
    else if (step.effect === 'eraseSave') this.eraseSave();
  }

  private destroyDialog(): void {
    for (const o of this.dialogObjects) o.destroy();
    this.dialogObjects = [];
    this.dialogButtons = [];
  }

  /** (Re)dessine le dialogue ouvert : voile, panneau, titre, message, boutons (le premier = choix sûr, sélectionné d'abord). */
  private buildDialog(): void {
    this.destroyDialog();
    const dialog = this.dialog;
    if (!dialog) return;
    const depth = 60;
    const objects = this.dialogObjects;
    const add = <T extends Phaser.GameObjects.GameObject & { setDepth(d: number): unknown }>(o: T): T => {
      o.setDepth(depth);
      objects.push(o);
      return o;
    };
    const veil = add(this.add.graphics());
    veil.fillStyle(0x000000, 0.72);
    veil.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
    const blocker = add(this.add.zone(0, 0, GAME_WIDTH, GAME_HEIGHT).setOrigin(0, 0));
    blocker.setInteractive();

    const pw = 800;
    const ph = 300;
    const px = (GAME_WIDTH - pw) / 2;
    const py = (GAME_HEIGHT - ph) / 2;
    add(createPanel(this, px, py, pw, ph, PANEL_STYLES.raised));
    const texts = saveDialogTexts(dialog, this.saveState);
    const reason = this.saveState.kind === 'corrupt' ? t(errorReasonKey(this.saveState.error)) : '';
    add(createText(this, GAME_WIDTH / 2, py + 44, t(texts.titleKey), { size: 'lg', color: UI_THEME.accent, origin: [0.5, 0.5], align: 'center' }));
    add(
      createText(this, GAME_WIDTH / 2, py + 130, t(texts.messageKey, { resume: this.resumeLabel(), reason }), {
        size: 'md',
        color: UI_THEME.text,
        origin: [0.5, 0.5],
        align: 'center',
        wrapWidth: pw - 80,
      }),
    );

    const n = dialog.choices.length;
    const bw = 300;
    const gap = 24;
    const total = n * bw + (n - 1) * gap;
    const bx0 = (GAME_WIDTH - total) / 2;
    this.dialogButtons = dialog.choices.map((choice, i) => {
      const button = new UiButton(this, bx0 + i * (bw + gap), py + ph - 76, {
        width: bw,
        height: 44,
        label: () => t(texts.choiceKeys[i]),
        onHover: () => {
          if (this.dialog && this.dialog.index !== i) {
            this.dialog = { ...this.dialog, index: i };
            this.dialogButtons.forEach((b, k) => b.setSelected(k === i));
          }
        },
        onClick: () => {
          if (this.dialog) this.applyDialogStep(chooseInDialog(this.dialog, choice));
        },
      });
      button.setSelected(i === dialog.index);
      button.container.setDepth(depth);
      objects.push(button.container);
      return button;
    });
  }

  // ───────────────────────────── Panneau « Contrôles » ─────────────────────────────

  private openControls(): void {
    if (this.controls) return;
    const objects: Phaser.GameObjects.GameObject[] = [];
    const depth = 50;
    const add = <T extends Phaser.GameObjects.GameObject & { setDepth(d: number): unknown }>(o: T): T => {
      o.setDepth(depth);
      objects.push(o);
      return o;
    };
    const veil = add(this.add.graphics());
    veil.fillStyle(0x000000, 0.72);
    veil.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
    // Capte les clics hors du panneau (ne laisse pas passer vers le menu).
    const blocker = add(this.add.zone(0, 0, GAME_WIDTH, GAME_HEIGHT).setOrigin(0, 0));
    blocker.setInteractive();

    const px = 130;
    const py = 40;
    const pw = GAME_WIDTH - 2 * px;
    const ph = GAME_HEIGHT - 2 * py;
    add(createPanel(this, px, py, pw, ph, PANEL_STYLES.raised));
    add(createText(this, GAME_WIDTH / 2, py + 40, t('controls.title'), { size: 'lg', color: UI_THEME.accent, origin: [0.5, 0.5], align: 'center' }));

    const colW = (pw - 90) / 2;
    const columns: Array<{ x: number; header: string; lines: Array<[string, string]> }> = [
      {
        x: px + 30,
        header: t('controls.keyboard'),
        lines: [
          [t('controls.move'), t('controls.keyboard.move')],
          [t('controls.action'), t('controls.keyboard.action')],
          [t('pad.controls.special'), t('pad.controls.keyboard.special')],
          [t('heart.controls.label'), t('heart.controls.keyboard')],
          [t('call.controls.label'), t('call.controls.keyboard')],
          [t('controls.pause'), t('controls.keyboard.pause')],
          [t('controls.menus'), t('controls.keyboard.menu')],
        ],
      },
      {
        x: px + 60 + colW,
        header: t('controls.gamepad'),
        lines: [
          [t('controls.move'), t('controls.gamepad.move')],
          // Schéma à quatre boutons : A action (relever, interagir, attaquer), B utiliser le cœur rangé, Y spécial, X appel, Start pause ; tous les autres
          // boutons n'ont aucun effet en jeu. A / B valident / reviennent aussi dans les menus.
          [t('controls.action'), t('controls.gamepad.action')],
          [t('heart.controls.label'), t('heart.controls.gamepad')],
          [t('pad.controls.special'), t('pad.controls.gamepad.special')],
          [t('call.controls.label'), t('call.controls.gamepad')],
          [t('controls.pause'), t('controls.gamepad.pause')],
          [t('controls.menus'), t('controls.gamepad.menu')],
        ],
      },
    ];
    for (const col of columns) {
      add(createText(this, col.x, py + 86, col.header, { size: 'md', color: UI_THEME.good }));
      let y = py + 118;
      for (const [label, value] of col.lines) {
        add(createText(this, col.x, y, label, { size: 'sm', color: UI_THEME.textDim, wrapWidth: colW }));
        add(createText(this, col.x + 12, y + 18, value, { size: 'sm', color: UI_THEME.text, wrapWidth: colW - 12 }));
        y += 36; // 7 lignes par colonne (déplacement, action, cœur, spécial, appel, pause, menus) : la dernière finit avant l'indice de relevage (py + 390)
      }
    }
    add(createText(this, GAME_WIDTH / 2, py + 390, t('hint.revive'), { size: 'sm', color: UI_THEME.accent, origin: [0.5, 0.5], align: 'center', wrapWidth: pw - 80 }));

    const assignments = this.add.container(0, 0);
    add(assignments);

    const back = new UiButton(this, GAME_WIDTH / 2 - 100, py + ph - 50, {
      width: 200,
      height: 38,
      label: () => t('menu.back'),
      onClick: () => this.closeControls(),
    });
    back.setSelected(true);
    objects.push(back.container);
    back.container.setDepth(depth);

    this.controls = { objects, assignments, refreshAt: 0 };
    this.buildAssignments();
  }

  /**
   * (Re)dessine la liste des manettes détectées (rafraîchie toutes les 500 ms : le navigateur ne révèle une manette
   * qu'après un premier appui sur un de ses boutons) : indice, nom, mapping standard / non standard.
   */
  private buildAssignments(): void {
    const ctrl = this.controls;
    if (!ctrl?.assignments) return;
    const box = ctrl.assignments;
    box.removeAll(true);
    const px = 130;
    const py = 40;
    const pw = GAME_WIDTH - 2 * px;
    const add = <T extends Phaser.GameObjects.GameObject>(o: T): T => {
      box.add(o);
      return o;
    };
    add(createText(this, px + 30, py + 408, t('pad.controls.join'), { size: 'sm', color: UI_THEME.textDim, wrapWidth: pw - 60 }));
    let y = py + 472;
    const pads = listGamepads();
    add(createText(this, px + 30, y - 22, t('pad.controls.pads'), { size: 'sm', color: UI_THEME.good }));
    if (pads.length === 0) {
      add(this.add.image(px + 38, y + 9, ATLAS_KEY, 'ui_cross').setScale(2));
      add(createText(this, px + 58, y - 3, t('pad.controls.none'), { size: 'sm', color: UI_THEME.bad, wrapWidth: pw - 100 }));
      return;
    }
    for (const pad of pads.slice(0, 4)) {
      const nonStd = isNonStandardPad(pad);
      add(this.add.image(px + 38, y + 9, ATLAS_KEY, 'ui_check').setScale(2));
      const padLine = pad.index === VIRTUAL_PAD_INDEX ? t('touch.padName') : t('pad.controls.padLine', { n: pad.index + 1, name: shortPadName(pad.id, 40) || '?' });
      add(createText(this, px + 58, y - 3, padLine, { size: 'sm', color: UI_THEME.text }));
      add(createText(this, px + 620, y - 3, nonStd ? t('pad.controls.nonStandard') : t('pad.controls.standard'), { size: 'sm', color: nonStd ? UI_THEME.accent : UI_THEME.good }));
      y += 22;
    }
  }

  private closeControls(): void {
    if (!this.controls) return;
    for (const o of this.controls.objects) o.destroy();
    this.controls = null;
    this.nav.reset();
  }
}
