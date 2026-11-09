/**
 * GameScene : PUR RENDU + ENTRÉES. Aucune règle de jeu ici : la scène accumule le temps réel, appelle
 * `sim.step(SIM_STEP_MS, inputs)` (pas fixes, ≤ 5 par frame), puis synchronise des vues Phaser avec `GameState` et
 * joue les `SimEvent` (FX, sons placeholder, HUD).
 *
 * Écran partagé : une caméra Phaser par joueur (voir render/camera.ts + render/splitscreen.ts), une caméra d'interface
 * plein écran qui porte le HUD de chaque joueur DANS SA vue, le panneau d'équipe (3 joueurs), les bannières et la pause.
 *
 * TUTORIEL (`session.tutorial`) : même scène, niveau-données `tutorialLevel`, 2 joueurs simulés (le joueur + un partenaire SCRIPTÉ piloté
 * par `TutorialRuntime`) pour UNE seule vue ; aucune sauvegarde (pas d'`AutoSaver`), graine fixe. Tous les ajouts sont gardés par
 * `if (this.tutorial)` : la campagne ne change pas d'un octet. Voir `src/tutorial/` (logique pure) et `render/tutorialHud.ts` (dessin).
 *
 * DÉMO (`session.demo`, mode « attract » : src/attract/) : même scène, même simulation, mais les entrées viennent d'un PILOTE AUTOMATIQUE
 * (`DemoPilot` : il ne produit que des `ActionFrame`) ; les entrées humaines sont IGNORÉES par la simulation et ne servent qu'à SORTIR
 * (`ActivityWatcher` → `DemoFlow`). Ni sauvegarde, ni pause, ni son, ni bannières ; bandeau « DÉMO » et invite clignotants ; retour au
 * menu (avec fondu) quand la durée est écoulée ou dès que le joueur fait quelque chose. Tous les ajouts sont gardés par `if (this.demoFlow)`.
 *
 * Cycle de vie : à chaque événement `roomEntered`, la salle précédente est DÉTRUITE proprement (RoomView, pools
 * d'ennemis et de projectiles, FX) puis reconstruite. Au `shutdown`, tout est libéré (écouteurs, caméras, objets).
 */
import Phaser from 'phaser';
import { GAME_HEIGHT, GAME_WIDTH, PLAYER_COLORS, SIM_STEP_MS } from '../core/constants';
import { CHARACTERS } from '../core/characters';
import { AutoSaver } from '../core/autoSave';
import { createSimulation, type GameSimulation } from '../core/simulation';
import { ActivityWatcher, takeCarriedActivity } from '../attract/activity';
import { ATTRACT_TIMEOUT_FADE_MS } from '../attract/config';
import { DemoFlow } from '../attract/demoFlow';
import { DemoPilot } from '../attract/DemoPilot';
import { DemoOverlay } from '../entities/demoOverlay';
import type { GameState, LevelDef, PlayerId, SimEvent, TickInputs, Vec2 } from '../core/types';
import { PlayerView } from '../entities/PlayerView';
import { EnemyViews } from '../entities/EnemyView';
import { ProjectileViews } from '../entities/ProjectileView';
import { RoomView } from '../entities/RoomView';
import { DarkRoomView, torchLightPos } from '../entities/DarkRoomView';
import { forceDarkLevel, isDevDarkAllowed } from '../entities/devDark';
import { buildDevTestLevel, devTestKind } from '../entities/devRooms';
import { GameOverlay, PauseMenu } from '../entities/overlay';
import { Sfx, sfxForEvent } from '../entities/sfx';
import type { ViewContext } from '../entities/common';
import { MAX_STEPS_PER_FRAME, mergeTickInputs, planSteps } from '../entities/loopLogic';
import { effectivePauseOwner, pauseIntentAllowed, pauseOwnerForPad, resolvePauseBack, resolvePauseConfirm } from '../entities/pauseLogic';
import { t, onLanguageChange } from '../i18n/i18n';
import { MenuNavigator, VIRTUAL_PAD_INDEX, inputManager, listGamepads } from '../input';
import { getLevelByIndex } from '../levels';
import { TUTORIAL_SEED, tutorialLevel } from '../levels/tutorial';
import { TutorialRuntime, tutorialPlayers } from '../entities/tutorialRuntime';
import { TutorialHud } from '../render/tutorialHud';
import { visibleRegionIds } from '../render/tutorialHudLogic';
import type { ButtonName } from '../tutorial/types';
import { ViewRig } from '../render/camera';
import { DEPTH_LABELS, FxManager, damageNumberColor, ensureFxTextures } from '../render/fx';
import { SpecialFx } from '../render/specialFx';
import { CallWorldFx } from '../render/callHud';
import { heroFrame } from '../render/art/animations';
import { spriteTier } from '../render/art/enemyTiers';
import { lanternBearers } from '../render/mechHud';
import { PlayerHud, TeamPanelHud, createSeparators, reviveRatioFor, specialHintLabel, type HudEnv } from '../render/hud';
import { HUD_DEPTH, hudRect, hudText } from '../render/hud';
import { isSavingAllowed } from '../render/saveMenuLogic';
import { getSaveContext, getSaveRepository } from '../render/saveStore';
import { getQuickParams } from '../render/menuLogic';
import { SCENE_KEYS, type DialogueSceneData, type GameSceneData, type GameSession, type MenuSceneData } from '../render/session';
import { computeLayout, type SplitLayout } from '../render/splitscreen';

/** Durée (ms) de la célébration avant d'enchaîner sur le dialogue de fin de niveau. */
const CELEBRATION_MS = 3200;
/** Durée (ms) du fondu de sortie vers une autre scène. */
const LEAVE_FADE_MS = 320;
/** Bouton « Start » des manettes (mapping standard). */
const PAD_START_BUTTON = 9;
/** Boutons « Select / Back » (saut du tutoriel) et « A » (confirmer la carte de fin) des manettes (mapping standard). */
const PAD_SELECT_BUTTON = 8;
const PAD_A_BUTTON = 0;
/** Délai (ms) avant que Espace / Entrée / A confirment la carte de fin du tutoriel (le toucher ou le clic sur le bouton restent immédiats). */
const TUTORIAL_END_CONFIRM_DELAY_MS = 1200;
/** Période (ms de rendu) de relecture de l'appareil du tutoriel (libellés de boutons). */
const TUTORIAL_DEVICE_REFRESH_MS = 250;

let sessionCounter = 0;

export class GameScene extends Phaser.Scene {
  private session!: GameSession;
  private level!: LevelDef;
  private sim!: GameSimulation;
  /** Sauvegarde automatique (début de salle, fin de niveau) ; null si la scène n'a pas pu démarrer. Aucune règle ici. */
  private autoSaver: AutoSaver | null = null;
  private layout!: SplitLayout;
  private rig!: ViewRig;
  private fx!: FxManager;
  private specialFx!: SpecialFx;
  /** Anneaux d'onde des appels (monde) : pur rendu des `callMs` de GameState. */
  private callFx!: CallWorldFx;
  private ctx!: ViewContext;

  private roomView: RoomView | null = null;
  /** Obscurité de la salle courante (null si la salle n'est pas sombre). */
  private darkRoom: DarkRoomView | null = null;
  /** Message d'équipe « salle sombre » déjà affiché ? / délai (ms) avant affichage (< 0 : aucun en attente). */
  private darkIntroShown = false;
  private darkIntroDelayMs = -1;
  private viewRoomIndex = -1;
  private forceRebuild = false;
  private pendingReason: 'start' | 'next' | 'restart' = 'next';
  private playerViews: PlayerView[] = [];
  private enemyViews!: EnemyViews;
  private projViews!: ProjectileViews;
  private huds: PlayerHud[] = [];
  private teamPanel: TeamPanelHud | null = null;
  private overlay!: GameOverlay;
  private pauseMenu!: PauseMenu;
  private pauseNav: MenuNavigator | null = null;
  /** Périphérique qui a ouvert la pause ('keyboard' | 'gamepad:<i>') ; null = pause de déconnexion, pilotable par tous. */
  private pauseOwner: string | null = null;
  /** Indice de la manette dont le front montant Start a été détecté le plus récemment. */
  private lastStartPad = 0;
  private sfx = new Sfx();

  private accumulatorMs = 0;
  private latched: TickInputs | null = null;
  private lastPolled: TickInputs = {};
  private paused = false;
  private snapCameras = true;
  private sinceEnterMs = 0;
  private padStartDown: boolean[] = [];
  /** Pause « manette déconnectée » : clé des joueurs concernés, message et rectangle d'affichage. */
  private padLostKey = '';
  private padPauseOwned = false;
  private padMsg: { text: Phaser.GameObjects.Text; back: Phaser.GameObjects.Rectangle } | null = null;

  private kills: number[] = [];
  private downs: number[] = [];
  private finishing = false;
  private finishMs = 0;
  private leaving: { key: string; data?: object; elapsedMs: number; fadeMs: number } | null = null;
  private failed = false;

  // ── Démo « attract » (null hors démo) ──
  private demoFlow: DemoFlow | null = null;
  private demoPilot: DemoPilot | null = null;
  private demoWatcher: ActivityWatcher | null = null;
  private demoOverlay: DemoOverlay | null = null;

  // ── Tutoriel (null hors tutoriel) ──
  private tutorial: TutorialRuntime | null = null;
  private tutorialHud: TutorialHud | null = null;
  private tutorialEnded = false;
  /** Instant (`time.now`) d'apparition de la carte de fin : les touches de confirmation sont ignorées juste après (un joueur qui martèle Espace ne la manque pas). */
  private tutorialEndedAt = 0;
  private tutorialLabels: Record<ButtonName, string> | null = null;
  private tutorialDeviceAccumMs = TUTORIAL_DEVICE_REFRESH_MS;
  private padEdgeDown: Record<number, boolean> = {};

  private offLanguage: (() => void) | null = null;
  private readonly onEscape = (): void => {
    if (!this.paused && !this.leaving) this.openPause('keyboard');
  };
  /** Entrée : saute l'étape du tutoriel (ou confirme la carte de fin). */
  private readonly onEnter = (e?: KeyboardEvent): void => {
    if (!this.tutorial || e?.repeat || this.paused || this.leaving) return;
    if (this.tutorialEnded) {
      if (this.tutorialEndConfirmReady()) this.leaveTo(SCENE_KEYS.Menu);
    } else this.doTutorialSkip();
  };
  /** Espace : confirme la carte de fin du tutoriel (jamais pendant le jeu : c'est la touche d'action). */
  private readonly onSpaceEnd = (e?: KeyboardEvent): void => {
    if (!this.tutorial || e?.repeat || this.paused || this.leaving || !this.tutorialEnded || !this.tutorialEndConfirmReady()) return;
    this.leaveTo(SCENE_KEYS.Menu);
  };
  /** Toute touche : le clavier est bien l'appareil utilisé (libellés de boutons du tutoriel). */
  private readonly onAnyKey = (): void => {
    this.tutorial?.noteKeyboard();
  };
  private readonly onMute = (): void => {
    this.sfx.setMuted(!this.sfx.isMuted);
  };
  private readonly onWindowBlur = (): void => {
    inputManager.reset();
    this.latched = null;
  };
  private readonly onGameHidden = (): void => {
    // onglet masqué : Phaser suspend sa boucle ; au retour, aucune touche ne doit rester « collée » ni un retard s'accumuler
    inputManager.reset();
    this.latched = null;
    this.accumulatorMs = 0;
  };
  /** Position d'affichage (sprite interpolé) d'un joueur pour les anneaux d'appel ; objet réutilisé (aucune allocation par frame). */
  private readonly callScratch: Vec2 = { x: 0, y: 0 };
  private readonly callPosOf = (id: number): Vec2 | null => {
    const pv = this.playerViews[id];
    if (!pv) return null;
    this.callScratch.x = pv.x;
    this.callScratch.y = pv.y;
    return this.callScratch;
  };
  private readonly onShutdown = (): void => {
    this.cleanup();
  };

  constructor() {
    super(SCENE_KEYS.Game);
  }

  // ───────────────────────────── Cycle de vie ─────────────────────────────

  init(data: GameSceneData): void {
    this.session = data.session;
    this.autoSaver = null;
    this.roomView = null;
    this.darkRoom = null;
    this.darkIntroShown = false;
    this.darkIntroDelayMs = -1;
    this.viewRoomIndex = -1;
    this.forceRebuild = false;
    this.pendingReason = 'next';
    this.playerViews = [];
    this.huds = [];
    this.teamPanel = null;
    this.pauseNav = null;
    this.pauseOwner = null;
    this.accumulatorMs = 0;
    this.latched = null;
    this.lastPolled = {};
    this.paused = false;
    this.snapCameras = true;
    this.sinceEnterMs = 0;
    this.padStartDown = [];
    this.padLostKey = '';
    this.padPauseOwned = false;
    this.padMsg = null;
    this.finishing = false;
    this.finishMs = 0;
    this.leaving = null;
    this.failed = false;
    this.demoFlow = null;
    this.demoPilot = null;
    this.demoWatcher = null;
    this.demoOverlay = null;
    this.tutorial = null;
    this.tutorialHud = null;
    this.tutorialEnded = false;
    this.tutorialEndedAt = 0;
    this.tutorialLabels = null;
    this.tutorialDeviceAccumMs = TUTORIAL_DEVICE_REFRESH_MS;
    this.padEdgeDown = {};
    this.sfx = new Sfx();
  }

  create(): void {
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.onShutdown);
    // dev : `?dev=statues|hourglass|bridge|bosses` remplace le niveau par une salle de test (voir entities/devRooms.ts)
    const tut = this.session.tutorial;
    const demo = this.session.demo ?? null;
    const devKind = tut || demo ? null : devTestKind(typeof window !== 'undefined' ? window.location.search : '', import.meta.env.DEV);
    const baseLevel = tut ? tutorialLevel : devKind ? buildDevTestLevel(devKind) : getLevelByIndex(this.session.levelIndex);
    if (!baseLevel || this.session.players.length === 0) {
      this.showFatalError();
      return;
    }
    // dev : `?dark=1` force toutes les salles sombres (clone du niveau ; brasero virtuel en mode DEV uniquement)
    const search = typeof window !== 'undefined' ? window.location.search : '';
    const level = !tut && !demo && isDevDarkAllowed(search, import.meta.env.DEV) ? forceDarkLevel(baseLevel, import.meta.env.DEV) : baseLevel;
    this.level = level;
    // Tutoriel : 2 joueurs simulés (le joueur + le partenaire scripté) mais UNE seule vue / UNE seule entrée humaine.
    const setups = tut ? tutorialPlayers(this.session.players[0]) : this.session.players;
    const playerCount = Math.max(1, Math.min(4, setups.length));
    const viewCount = tut ? 1 : playerCount;
    this.kills = Array.from({ length: playerCount }, () => 0);
    this.downs = Array.from({ length: playerCount }, () => 0);

    // simulation (graine dérivée d'un compteur + horloge : la scène peut utiliser Date.now, pas le core)
    sessionCounter++;
    const seed = tut ? TUTORIAL_SEED : demo ? demo.seed : (Date.now() ^ Math.imul(sessionCounter, 0x9e3779b1)) >>> 0;
    // Salle de départ : reprise d'une sauvegarde ou dev `?room=N` (honorée par la simulation, voir SimConfig.startRoomIndex).
    const players = setups.slice(0, playerCount);
    this.sim = createSimulation({ levelId: level.id, players, seed, startRoomIndex: this.session.startRoomIndex }, level);

    // Sauvegarde automatique : désactivée en démarrage rapide, `?nosave=1` et paramètres de dev (la vraie sauvegarde n'est jamais écrasée).
    // Tutoriel : AUCUN AutoSaver (le niveau n'est pas dans le contexte de sauvegarde, et rien ne doit jamais être écrit).
    // Démo : AUCUN AutoSaver non plus (`isSavingAllowed({ demo: true })` vaut false) : la démo n'écrit jamais rien.
    if (!tut && !demo) {
      this.autoSaver = new AutoSaver({
        repository: getSaveRepository(),
        context: getSaveContext(),
        levelId: level.id,
        players,
        completedLevelIds: this.session.completedLevelIds,
        enabled: isSavingAllowed({ quick: getQuickParams()?.quick === true, search }),
        onError: (err) => {
          const text = err.code === 'quota' ? t('save.error.quota') : t('save.error.unavailable');
          this.huds[0]?.showToast(text, 0xff8a6a, 5000);
        },
      });
    }

    inputManager.setPlayerCount(viewCount);
    inputManager.reset();

    // vues
    ensureFxTextures(this);
    this.layout = computeLayout(viewCount);
    this.rig = new ViewRig(this, this.layout);
    this.fx = new FxManager(this, this.rig, this.layout.zoom);
    this.specialFx = new SpecialFx(this, this.rig, this.fx);
    this.ctx = { scene: this, rig: this.rig, fx: this.fx, zoom: this.layout.zoom, playerCount };
    // anneaux d'appel : au-dessus de l'obscurité des salles sombres (DEPTH_LABELS - 0.5) : un appel doit se voir dans le noir
    this.callFx = new CallWorldFx(this.ctx, DEPTH_LABELS - 0.25);
    this.enemyViews = new EnemyViews(this.ctx);
    this.projViews = new ProjectileViews(this.ctx);

    const state = this.sim.state;
    this.playerViews = state.players.map((p, i) => new PlayerView(this.ctx, i, p));

    // interface
    const env: HudEnv = {
      ctx: this.ctx,
      level,
      layout: this.layout,
      specialHint: (id) => specialHintLabel(inputManager.getAssignments()[id], inputManager.getBindings().special),
    };
    createSeparators(this.ctx, this.layout);
    this.huds = state.players.slice(0, viewCount).map((p) => new PlayerHud(env, p.id, p));
    if (this.layout.teamPanel) this.teamPanel = new TeamPanelHud(env, this.layout.teamPanel, state.players);
    this.overlay = new GameOverlay(this.ctx, level);
    this.pauseMenu = new PauseMenu(this.ctx);
    if (demo) {
      // Démo : pilote automatique sur le joueur 0, aucun son, aucune bannière ; bandeau « DÉMO » + invite clignotants.
      this.sfx.setMuted(true);
      this.overlay.setQuiet(true);
      for (const h of this.huds) h.setDemoQuiet(true); // pas de notifications ni d'invites « Appuie sur… » : elles s'adressent à un humain
      this.demoPilot = new DemoPilot(this.sim, { playerId: 0, seed: demo.seed ^ 0x5bd1e995 });
      this.demoFlow = new DemoFlow(demo.durationMs);
      this.demoOverlay = new DemoOverlay(this.ctx);
      this.demoWatcher = new ActivityWatcher();
      this.demoWatcher.start();
      // une action pendant le fondu du menu vers la démo : on s'arrête tout de suite
      if (takeCarriedActivity()) this.demoFlow.interrupt();
      const exit = this.demoFlow.exit;
      if (exit) this.leaveDemo(exit.fadeMs);
    }
    if (tut) {
      this.pauseMenu.setTutorial(true); // confirmation de sortie propre au tutoriel (rien n'est sauvegardé ni perdu)
      this.tutorial = new TutorialRuntime(level, { initialDevice: tut.initialDevice, startRoomIndex: this.session.startRoomIndex });
      this.tutorialHud = new TutorialHud(this.ctx, this.layout.viewports[0]);
      this.tutorialHud.setSkipHandler(() => this.doTutorialSkip());
    }

    // construction de la vue de la salle de départ
    this.buildRoom('start');

    // écouteurs
    if (!demo) {
      this.input.keyboard?.on('keydown-ESC', this.onEscape);
      this.input.keyboard?.on('keydown-M', this.onMute);
    }
    if (tut) {
      this.input.keyboard?.on('keydown-ENTER', this.onEnter);
      this.input.keyboard?.on('keydown-SPACE', this.onSpaceEnd);
      this.input.keyboard?.on('keydown', this.onAnyKey);
    }
    window.addEventListener('blur', this.onWindowBlur);
    this.game.events.on(Phaser.Core.Events.HIDDEN, this.onGameHidden);
    this.offLanguage = onLanguageChange(() => this.retranslate());
    // mémorise l'état « tenu » initial des boutons Start pour ne pas déclencher une pause fantôme
    this.pollPadStart();
    this.padEdge(PAD_SELECT_BUTTON);
    this.padEdge(PAD_A_BUTTON);
  }

  /** Affiche une erreur lisible puis retourne au menu (niveau introuvable, session vide). */
  private showFatalError(): void {
    this.failed = true;
    this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2, t('game.error.level'), { fontFamily: 'monospace', fontSize: '24px', color: '#ff8a8a', align: 'center' })
      .setOrigin(0.5);
    const back: MenuSceneData | undefined = this.session.demo ? { afterDemo: true } : undefined;
    this.time.delayedCall(2200, () => this.scene.start(SCENE_KEYS.Menu, back));
  }

  // ───────────────────────────── Construction de salle ─────────────────────────────

  private buildRoom(reason: 'start' | 'next' | 'restart'): void {
    const s = this.sim.state;
    this.roomView?.destroy();
    this.enemyViews.clear();
    this.projViews.clear();
    this.fx.clear();
    this.specialFx.clear();
    this.callFx.clear();
    this.darkRoom?.destroy();
    this.darkRoom = null;
    this.roomView = new RoomView(this.ctx, this.level, this.sim.room);
    // salle sombre : couche d'obscurité (au-dessus du monde, sous le HUD) ; message d'équipe à la première
    if (this.sim.room.dark) {
      this.darkRoom = new DarkRoomView(this, this.rig, this.sim.room, this.roomView.widthPx, this.roomView.heightPx);
      if (!this.darkIntroShown) this.darkIntroDelayMs = 1600;
    } else {
      this.darkIntroDelayMs = -1;
    }
    this.viewRoomIndex = s.roomIndex;
    this.forceRebuild = false;
    this.rig.setRoom(this.roomView.widthPx, this.roomView.heightPx, this.roomView.backgroundColor);
    s.players.forEach((p, i) => this.playerViews[i]?.interp.reset(p.pos.x, p.pos.y));
    this.snapCameras = true;
    this.sinceEnterMs = 0;
    this.overlay.onRoomEntered(this.sim.room, s.roomIndex, reason);
  }

  // ───────────────────────────── Boucle ─────────────────────────────

  update(_time: number, delta: number): void {
    if (this.failed) return;
    const dt = delta > 0 && Number.isFinite(delta) ? Math.min(delta, 250) : 0;

    if (this.leaving) {
      this.leaving.elapsedMs += dt;
      this.overlay.setExtraFade(Math.min(1, this.leaving.elapsedMs / this.leaving.fadeMs));
      if (this.leaving.elapsedMs >= this.leaving.fadeMs) {
        const { key, data } = this.leaving;
        this.leaving = null;
        this.scene.start(key, data);
        return;
      }
    }

    // Démo : chronomètre en temps réel + détection d'activité (toute action du joueur interrompt la démo).
    const demoFlow = this.demoFlow;
    if (demoFlow) {
      const exit = demoFlow.update(dt, this.demoWatcher?.poll() ?? false);
      if (exit) this.leaveDemo(exit.fadeMs);
    } else {
      if (this.pollPadStart() && !this.leaving) {
        if (this.paused) this.closePause();
        else this.openPause(pauseOwnerForPad(this.lastStartPad));
      }

      this.updatePadDisconnect();
    }

    if (this.paused) {
      this.updatePause();
      this.syncViews(0, false, 1);
      return;
    }

    const state = this.sim.state;
    // Démo : les entrées humaines ne sont JAMAIS lues (le pilote automatique joue seul) ; elles ne servent qu'à sortir.
    const cur: TickInputs = demoFlow ? {} : inputManager.poll();
    this.lastPolled = cur;
    this.latched = mergeTickInputs(this.latched, cur);
    const plan = planSteps(this.accumulatorMs, dt, SIM_STEP_MS, MAX_STEPS_PER_FRAME);
    this.accumulatorMs = plan.accumulatorMs;
    let stepped = false;
    // Tutoriel : zones du HUD visibles (condition `regionVisible`) et touches de saut / de confirmation des manettes.
    const tutorial = this.tutorial;
    const regionIds = tutorial && this.huds[0] ? visibleRegionIds(this.huds[0].regions()) : [];
    if (tutorial) this.pollTutorialPad();
    if (!this.leaving) {
      for (let i = 0; i < plan.steps; i++) {
        let inputs = i === 0 ? (this.latched ?? cur) : cur;
        // Tutoriel : le partenaire scripté est le joueur 1 (entrées posées À CHAQUE pas, jamais fusionnées ni mémorisées).
        if (tutorial) inputs = tutorial.decorate(inputs, state);
        if (this.demoPilot) inputs = { 0: this.demoPilot.decide(state) };
        const events = this.sim.step(SIM_STEP_MS, inputs);
        if (i === 0) this.latched = null;
        stepped = true;
        this.autoSaver?.handleEvents(events); // début de salle / fin de niveau : jamais en pleine salle
        for (let k = 0; k < events.length; k++) this.handleEvent(events[k], state);
        if (tutorial) {
          tutorial.observe(events, state, regionIds);
          for (const id of tutorial.takeKnockDowns()) this.sim.knockDown(id); // chute scénarisée (relevage, mort d'équipe)
        }
      }
    }
    if (state.roomIndex !== this.viewRoomIndex || this.forceRebuild) this.buildRoom(this.pendingReason);
    this.syncViews(dt, stepped, plan.alpha);
    this.demoOverlay?.update(demoFlow?.elapsedMs ?? 0);

    if (this.finishing && !this.leaving) {
      this.finishMs += dt;
      if (this.finishMs >= CELEBRATION_MS) {
        if (this.tutorial) this.showTutorialEnd();
        else if (demoFlow) this.leaveDemo(ATTRACT_TIMEOUT_FADE_MS); // niveau terminé pendant la démo : retour au menu, rien n'est enregistré
        else this.finishLevel();
      }
    }
  }

  /** Synchronise vues, caméras, FX, HUD et bandeaux avec l'état courant. */
  private syncViews(dtMs: number, stepped: boolean, alpha: number): void {
    const s = this.sim.state;
    const timeMs = s.timeMs;
    this.sinceEnterMs += dtMs;

    for (let i = 0; i < this.playerViews.length; i++) {
      const p = s.players[i];
      if (p) this.playerViews[i].update(p, timeMs, stepped, alpha, reviveRatioFor(p, s.players), dtMs);
    }
    // porteur(s) de lanterne du pont de lumière : halo doré (rendu seulement)
    const bearers = lanternBearers(s, this.sim.room);
    for (let i = 0; i < this.playerViews.length; i++) {
      const b = bearers.find((x) => x.playerId === i);
      this.playerViews[i].setLantern(b ? b.radiusPx : null);
    }
    this.enemyViews.sync(s.room.enemies, timeMs, stepped, alpha, dtMs);
    this.projViews.sync(s.room.projectiles, stepped, alpha);

    const exitOpen = this.sim.isExitOpen();
    this.roomView?.update(s, timeMs, exitOpen);
    this.darkRoom?.update(s, timeMs, (id) => {
      const pv = this.playerViews[id];
      return pv ? torchLightPos(pv.x, pv.y) : null;
    });
    this.updateDarkIntro(dtMs);

    const snap = this.snapCameras;
    this.snapCameras = false;
    for (let i = 0; i < this.playerViews.length; i++) {
      const pv = this.playerViews[i];
      this.rig.follow(i, { x: pv.x, y: pv.y - 3 }, dtMs, snap);
    }

    this.fx.update(dtMs);
    this.specialFx.update(dtMs);
    this.callFx.update(s, this.callPosOf);

    const banners = this.overlay.activeBanners();
    for (let i = 0; i < this.huds.length; i++) {
      this.huds[i].update({ state: s, room: this.sim.room, dtMs, timeMs, exitOpen, camCenter: this.rig.centerOf(i), banners });
    }
    this.teamPanel?.update(s, this.sim.room, dtMs);
    this.updateTutorialHud(dtMs);
    this.overlay.update({
      phase: s.phase,
      phaseTimerMs: s.phaseTimerMs,
      dtMs,
      sinceEnterMs: this.sinceEnterMs,
      exitOpen,
      bosses: this.enemyViews.bossBars,
    });
  }

  /** Message d'équipe de la première salle sombre : affiché après un court délai (laisse passer la bannière de salle). */
  private updateDarkIntro(dtMs: number): void {
    if (this.darkIntroDelayMs < 0) return;
    this.darkIntroDelayMs -= dtMs;
    if (this.darkIntroDelayMs > 0) return;
    this.darkIntroDelayMs = -1;
    this.darkIntroShown = true;
    for (const h of this.huds) h.showToast(t('hud.torch.first'), 0xffc86a, 4200);
  }

  // ───────────────────────────── Événements ─────────────────────────────

  private playerPos(id: PlayerId, state: GameState): Vec2 {
    return state.players[id]?.pos ?? { x: 0, y: 0 };
  }

  private handleEvent(e: SimEvent, state: GameState): void {
    const snd = sfxForEvent(e);
    if (snd) this.sfx.play(snd);
    const fx = this.fx;
    switch (e.type) {
      case 'roomEntered':
        if (e.reason === 'start' && this.roomView && this.viewRoomIndex === e.roomIndex) break; // déjà construite à la création
        this.forceRebuild = true;
        this.pendingReason = e.reason;
        break;
      case 'playerHit': {
        fx.hit(e.pos.x, e.pos.y);
        fx.damageNumber(e.pos.x, e.pos.y - 4, e.damage, 0xff6a6a, true);
        this.playerViews[e.playerId]?.flashHit();
        this.rig.shake(110, 0.004, e.playerId);
        break;
      }
      case 'playerDown': {
        const pos = this.playerPos(e.playerId, state);
        fx.downBurst(pos.x, pos.y);
        if (this.downs[e.playerId] !== undefined) this.downs[e.playerId]++;
        const downed = state.players[e.playerId];
        if (downed) {
          const name = t(`character.${downed.characterId}.name`);
          for (let j = 0; j < this.huds.length; j++) {
            if (j !== e.playerId && state.players[j]?.status === 'alive') this.huds[j].showToast(t('game.allyDown', { name }), PLAYER_COLORS[e.playerId], 2400);
          }
        }
        this.rig.shake(240, 0.006, e.playerId);
        break;
      }
      case 'playerRevived': {
        const pos = this.playerPos(e.playerId, state);
        fx.reviveBurst(pos.x, pos.y);
        break;
      }
      case 'reviveInterrupted': {
        const pos = this.playerPos(e.targetId, state);
        fx.burst(pos.x, pos.y - 6, 5, 0xff9a9a, 28, 300, 40);
        break;
      }
      case 'teamWipe':
        this.overlay.flash(0xb01830, 0.55, 700);
        this.rig.shake(450, 0.01);
        break;
      case 'enemyHit': {
        fx.hit(e.pos.x, e.pos.y);
        fx.damageNumber(e.pos.x, e.pos.y - 6, e.damage, damageNumberColor(e.byPlayer));
        break;
      }
      case 'enemyDied': {
        const tier = spriteTier(e.kind); // 'small' | 'mini' (demi-boss) | 'boss'
        fx.enemyDeath(e.pos.x, e.pos.y, e.kind, tier !== 'small');
        if (e.byPlayer !== null && this.kills[e.byPlayer] !== undefined) this.kills[e.byPlayer]++;
        if (tier === 'boss') {
          this.rig.shake(700, 0.012);
          this.overlay.flash(0xffffff, 0.7, 500);
        } else if (tier === 'mini') {
          this.rig.shake(380, 0.008);
          this.overlay.flash(0xffffff, 0.35, 300);
        }
        break;
      }
      case 'enemySpawned':
        fx.spawnPoof(e.pos.x, e.pos.y, 0xc8b0ff);
        break;
      case 'specialUsed': {
        const caster = state.players[e.playerId];
        const def = caster ? CHARACTERS[caster.characterId]?.special : undefined;
        const allies =
          e.kind === 'healNova'
            ? state.players.filter((q) => q.status === 'alive').map((q) => ({ id: q.id, x: q.pos.x, y: q.pos.y }))
            : undefined;
        this.specialFx.play({
          playerId: e.playerId,
          kind: e.kind,
          pos: e.pos,
          dir: e.dir,
          casterPos: caster?.pos,
          heroFrame: caster ? heroFrame(caster.characterId, e.dir, 0, 'attack') : undefined,
          playerColor: PLAYER_COLORS[e.playerId] ?? 0xffffff,
          def,
          name: def ? t(def.nameKey) : '',
          allies: allies && def ? allies.filter((q) => Math.hypot(q.x - e.pos.x, q.y - e.pos.y) <= def.radius + 4) : allies,
          healText: t('specialhud.heal'),
        });
        this.playerViews[e.playerId]?.flashSpecial();
        break;
      }
      case 'callStarted': {
        // petit éclat de départ à l'appui ; les ondes (monde et bords de vue) sont dessinées à partir de GameState
        const pos = this.playerPos(e.playerId, state);
        fx.ring(pos.x, pos.y, PLAYER_COLORS[e.playerId] ?? 0xffffff, 20, 420);
        break;
      }
      case 'specialReady': {
        this.huds[e.playerId]?.flashSpecialReady();
        const pos = this.playerPos(e.playerId, state);
        this.specialFx.readyFlash(pos.x, pos.y, PLAYER_COLORS[e.playerId] ?? 0xffffff);
        break;
      }
      case 'projectileFired':
        fx.burst(e.pos.x, e.pos.y, 3, 0xffffff, 26, 180, 0);
        break;
      case 'bossPhase':
        if (spriteTier(e.kind) === 'mini') {
          this.rig.shake(400, 0.008);
          this.overlay.flash(0xffffff, 0.3, 300);
        } else {
          this.rig.shake(600, 0.011);
          this.overlay.flash(0xffffff, 0.5, 400);
        }
        break;
      case 'statueRotated': {
        const c = this.roomView?.mechanismPartCenter(e.mechanismId, e.index);
        if (c) {
          fx.ring(c.x, c.y, 0x7af0ff, 26, 420);
          fx.burst(c.x, c.y - 6, 10, 0xbfeaff, 40, 450, 20);
          fx.dust(c.x, c.y + 6, 6, 8);
        }
        this.rig.shake(100, 0.0025);
        break;
      }
      case 'hourglassFlipped': {
        const c = this.roomView?.centerOfMechanism(e.mechanismId);
        if (c) {
          fx.pulse(c.x, c.y, 0xffc24a);
          fx.ring(c.x, c.y, 0xffe08a, 28, 500);
          fx.sparkles(c.x, c.y - 6, 0xffe08a, 10, 8);
        }
        break;
      }
      case 'hourglassEmpty': {
        const c = this.roomView?.centerOfMechanism(e.mechanismId);
        if (c) {
          fx.ring(c.x, c.y, 0xff4a3a, 34, 600);
          fx.burst(c.x, c.y - 4, 10, 0xff6a4a, 44, 500, 30);
        }
        this.rig.shake(160, 0.004);
        for (let j = 0; j < this.huds.length; j++) {
          if (state.players[j]?.status === 'alive') this.huds[j].showToast(t('hud.hourglass.emptyToast'), 0xff7a4a, 2600);
        }
        break;
      }
      case 'gateClosed': {
        const c = this.roomView?.mechanismPartCenter(e.mechanismId, Math.max(0, e.closedCount - 1));
        if (c) {
          fx.dust(c.x, c.y + 4, 8, 8);
          fx.ring(c.x, c.y, 0xc8c0b0, 18, 300);
        }
        this.rig.shake(120, 0.003);
        break;
      }
      case 'brazierLit': {
        const c = this.roomView?.centerOfMechanism(e.brazierId);
        if (c) {
          fx.pulse(c.x, c.y - 4, 0xffb347);
          fx.ring(c.x, c.y - 2, 0xffd08a, 30, 520);
          fx.burst(c.x, c.y - 6, 12, 0xffa03c, 46, 600, -24);
          fx.sparkles(c.x, c.y - 8, 0xffe0a0, 10, 8);
        }
        this.huds[e.playerId]?.showToast(t('hud.brazier.lit'), 0xffc86a, 1500);
        break;
      }
      case 'torchRefueled': {
        const pos = this.playerPos(e.playerId, state);
        fx.sparkles(pos.x, pos.y - 4, 0xffc860, 14, 9);
        fx.ring(pos.x, pos.y, 0xffd27a, 26, 450);
        const c = this.roomView?.centerOfMechanism(e.brazierId);
        if (c) fx.pulse(c.x, c.y - 4, 0xffd27a);
        this.huds[e.playerId]?.showToast(t('hud.torch.refueled'), 0xffd27a, 1400);
        this.huds[e.playerId]?.flashTorch(state.timeMs);
        break;
      }
      case 'torchLow':
        this.huds[e.playerId]?.showToast(t('hud.torch.low'), 0xffa040, 3200);
        this.huds[e.playerId]?.flashTorch(state.timeMs, 1400);
        break;
      case 'torchOut': {
        const pos = this.playerPos(e.playerId, state);
        fx.burst(pos.x, pos.y - 8, 7, 0xa8a8b8, 22, 650, -14);
        this.huds[e.playerId]?.showToast(t('hud.torch.out'), 0xff5a5a, 3200);
        this.huds[e.playerId]?.flashTorch(state.timeMs, 1400);
        break;
      }
      case 'mechanismChanged': {
        const c = this.roomView?.centerOfMechanism(e.mechanismId);
        if (c && e.active) fx.pulse(c.x, c.y, 0xffe27a);
        break;
      }
      case 'keyPicked': {
        const pos = this.playerPos(e.playerId, state);
        fx.sparkles(pos.x, pos.y - 4, PLAYER_COLORS[e.playerId], 12, 8);
        this.huds[e.playerId]?.showToast(t('hud.key.have'), PLAYER_COLORS[e.playerId]);
        break;
      }
      case 'doorOpened': {
        const c = this.roomView?.centerOfMechanism(e.doorId);
        if (c) {
          fx.dust(c.x, c.y, 10, 10);
          fx.ring(c.x, c.y, 0xfff6c8, 26, 450);
        }
        this.rig.shake(160, 0.003);
        break;
      }
      case 'runeProgress': {
        const rs = state.room.mechanisms.find((m) => m.id === e.mechanismId);
        const idx = rs && rs.type === 'runePuzzle' ? rs.lastPedestal : -1;
        const c = (idx >= 0 ? this.roomView?.pedestalCenter(e.mechanismId, idx) : null) ?? this.roomView?.centerOfMechanism(e.mechanismId);
        if (c) {
          if (e.ok) fx.sparkles(c.x, c.y - 6, 0x9affc8, 8, 7);
          else {
            fx.burst(c.x, c.y - 4, 8, 0xff5a5a, 40, 380, 60);
            this.rig.shake(140, 0.004);
          }
        }
        break;
      }
      case 'objectiveCompleted': {
        const def = this.level.objectives.find((o) => o.id === e.objectiveId);
        const pos = this.playerPos(e.playerId, state);
        fx.sparkles(pos.x, pos.y - 6, 0x7dffb0, 14, 9);
        fx.ring(pos.x, pos.y, 0x7dffb0, 30, 520);
        if (def) this.huds[e.playerId]?.showToast(`${t('hud.done')} - ${t(def.labelKey)}`, 0x8dffa8);
        break;
      }
      case 'roomCleared': {
        const c = this.roomView?.exitCenterPx;
        if (c) fx.confetti(c.x, c.y, 60, 24);
        break;
      }
      case 'levelCompleted': {
        const c = this.roomView?.exitCenterPx ?? { x: 0, y: 0 };
        fx.confetti(c.x, c.y, 120, 70);
        this.finishing = true;
        this.finishMs = 0;
        break;
      }
      default:
        break;
    }
  }

  // ───────────────────────────── Tutoriel ─────────────────────────────

  /** Relit l'appareil (clavier / manette / PlayStation / tactile) et les libellés de boutons ; rendu seulement. */
  private refreshTutorialLabels(): void {
    const tut = this.tutorial;
    if (!tut) return;
    const a = inputManager.getAssignments()[0];
    tut.refreshDevice({
      label: a?.label ?? 'keyboard',
      gamepadIndex: a?.gamepadIndex,
      gamepadName: a?.gamepadName,
      virtualPadConnected: listGamepads().some((p) => p.index === VIRTUAL_PAD_INDEX),
    });
    this.tutorialLabels = tut.labels(inputManager.getBindings());
  }

  /** Met à jour l'interface du tutoriel (carte, cadres, repères, puce) depuis la vue du directeur. */
  private updateTutorialHud(dtMs: number): void {
    const tut = this.tutorial;
    const hud = this.tutorialHud;
    const human = this.sim.state.players[0];
    const partner = this.sim.state.players[1];
    if (!tut || !hud || !human || !partner || !this.huds[0]) return;
    this.tutorialDeviceAccumMs += dtMs;
    if (this.tutorialDeviceAccumMs >= TUTORIAL_DEVICE_REFRESH_MS || !this.tutorialLabels) {
      this.tutorialDeviceAccumMs = 0;
      this.refreshTutorialLabels();
    }
    const special = CHARACTERS[human.characterId]?.special;
    hud.update({
      view: tut.view(),
      labels: this.tutorialLabels as Record<ButtonName, string>,
      partnerName: t(`character.${partner.characterId}.name`),
      specialName: special ? t(special.nameKey) : '',
      regions: this.huds[0].regions(),
      camCenter: this.rig.centerOf(0),
      timeMs: this.time.now,
      touch: tut.currentDevice === 'touch',
    });
  }

  /** Saute l'étape courante ; si le directeur propose de sauter la salle, relance la scène à la salle suivante (ou termine). */
  private doTutorialSkip(): void {
    const tut = this.tutorial;
    if (!tut || this.leaving || this.paused || this.tutorialEnded || this.finishing) return;
    const r = tut.skip();
    if (r.kind === 'step') return;
    if (r.nextRoomIndex >= this.level.rooms.length) {
      this.finishing = true; // la dernière salle est sautée : carte de fin
      this.finishMs = CELEBRATION_MS;
      return;
    }
    const data: GameSceneData = { session: { ...this.session, startRoomIndex: r.nextRoomIndex } };
    this.leaveTo(SCENE_KEYS.Game, data);
  }

  /** La carte de fin est-elle affichée depuis assez longtemps pour qu'une touche la confirme (délai anti-martèlement) ? */
  private tutorialEndConfirmReady(): boolean {
    return this.time.now - this.tutorialEndedAt >= TUTORIAL_END_CONFIRM_DELAY_MS;
  }

  /** Carte de fin du tutoriel : rien n'est sauvegardé ; le bouton (ou Entrée / Espace / A / toucher) revient au menu. */
  private showTutorialEnd(): void {
    const hud = this.tutorialHud;
    if (!hud || this.tutorialEnded) return;
    this.tutorialEnded = true;
    this.tutorialEndedAt = this.time.now;
    const solo = (this.session.tutorial?.campaignPlayers ?? 1) === 1;
    hud.showEnd(this.tutorialEndLabels(), solo, () => {
      if (!this.leaving) this.leaveTo(SCENE_KEYS.Menu);
    });
  }

  /** Libellés de la carte de fin : « Entrée » au clavier, « A » (ou le gros bouton A) à la manette / au tactile pour confirmer. */
  private tutorialEndLabels(): Record<ButtonName, string> {
    this.refreshTutorialLabels();
    const labels = { ...(this.tutorialLabels as Record<ButtonName, string>) };
    if (this.tutorial?.currentDevice === 'keyboard') labels.action = labels.skip;
    return labels;
  }

  /** Select / Back : saute l'étape ; A : confirme la carte de fin. */
  private pollTutorialPad(): void {
    if (this.leaving || this.paused) {
      this.padEdge(PAD_SELECT_BUTTON);
      this.padEdge(PAD_A_BUTTON);
      return;
    }
    if (this.padEdge(PAD_SELECT_BUTTON) && !this.tutorialEnded) this.doTutorialSkip();
    if (this.padEdge(PAD_A_BUTTON) && this.tutorialEnded && this.tutorialEndConfirmReady()) this.leaveTo(SCENE_KEYS.Menu);
  }

  /** Front montant d'un bouton de n'importe quelle manette (état mémorisé par bouton). */
  private padEdge(button: number): boolean {
    let down = false;
    for (const pad of listGamepads()) {
      const b = pad.buttons[button];
      if (b && (b.pressed || b.value > 0.5)) down = true;
    }
    const was = this.padEdgeDown[button] === true;
    this.padEdgeDown[button] = down;
    return down && !was;
  }

  // ───────────────────────────── Fin de niveau ─────────────────────────────

  /** Reporte les statistiques du niveau dans la session puis enchaîne sur le dialogue de fin. */
  private finishLevel(): void {
    const s = this.sim.state;
    const stats = this.session.stats;
    stats.timeMs += s.timeMs;
    const n = this.kills.length;
    while (stats.downs.length < n) stats.downs.push(0);
    while (stats.kills.length < n) stats.kills.push(0);
    for (let i = 0; i < n; i++) {
      stats.downs[i] += Math.max(this.downs[i] ?? 0, s.players[i]?.downCount ?? 0);
      stats.kills[i] += this.kills[i] ?? 0;
    }
    // Niveaux terminés reportés dans la session (la sauvegarde a déjà été écrite à l'événement `levelCompleted`).
    if (this.autoSaver) this.session.completedLevelIds = [...this.autoSaver.completedLevelIds];
    const data: DialogueSceneData = { session: this.session, stage: 'outro' };
    this.leaveTo(SCENE_KEYS.Dialogue, data);
  }

  private leaveTo(key: string, data?: object, fadeMs: number = LEAVE_FADE_MS): void {
    if (this.leaving) return;
    this.leaving = { key, data, elapsedMs: 0, fadeMs: Math.max(1, fadeMs) };
    inputManager.reset();
  }

  /**
   * Fin de la démo (durée écoulée, ou action du joueur) : fondu au noir puis retour au menu, qui avale les entrées pendant une courte
   * fenêtre de grâce (`afterDemo`) pour que l'entrée qui a interrompu la démo ne valide aucun élément. Aucune session n'est renvoyée :
   * la démo ne touche ni aux choix du menu ni à la sauvegarde.
   */
  private leaveDemo(fadeMs: number): void {
    const data: MenuSceneData = { afterDemo: true };
    this.leaveTo(SCENE_KEYS.Menu, data, fadeMs);
  }

  // ───────────────────────────── Pause ─────────────────────────────

  private openPause(owner: string | null): void {
    if (this.paused || this.failed || this.demoFlow) return; // jamais de pause en démo
    this.paused = true;
    this.pauseOwner = owner;
    inputManager.reset();
    this.latched = null;
    this.accumulatorMs = 0;
    this.pauseNav = new MenuNavigator(); // ignore les touches déjà tenues (celle qui a ouvert la pause)
    this.pauseMenu.show();
  }

  private closePause(): void {
    if (!this.paused) return;
    this.paused = false;
    this.pauseNav = null;
    this.pauseOwner = null;
    this.pauseMenu.hide();
    inputManager.reset();
    this.latched = null;
    this.accumulatorMs = 0;
  }

  private updatePause(): void {
    const nav = this.pauseNav;
    if (!nav) return;
    // Seul le périphérique qui a ouvert la pause la pilote (sauf pause de déconnexion) ; si sa manette a disparu, tous peuvent.
    this.pauseOwner = effectivePauseOwner(
      this.pauseOwner,
      listGamepads().map((p) => p.index),
    );
    for (const intent of nav.pollMenu()) {
      if (!pauseIntentAllowed(this.pauseOwner, intent.source)) continue;
      switch (intent.action) {
        case 'up':
          this.pauseMenu.move(-1);
          break;
        case 'down':
          this.pauseMenu.move(1);
          break;
        case 'back':
          if (resolvePauseBack(this.pauseMenu.confirming) === 'cancelQuit') {
            this.pauseMenu.cancelQuit();
            break;
          }
          this.closePause();
          return;
        case 'confirm': {
          const r = resolvePauseConfirm(this.pauseMenu.confirming, this.pauseMenu.choice);
          if (r === 'askQuit') this.pauseMenu.askQuit();
          else if (r === 'cancelQuit') this.pauseMenu.cancelQuit();
          else if (r === 'resume') {
            this.closePause();
            return;
          } else {
            this.closePause();
            this.leaveTo(SCENE_KEYS.Menu);
            return;
          }
          break;
        }
        default:
          break;
      }
    }
  }

  /**
   * Manette d'un joueur actif déconnectée : pause + message « Manette du joueur n déconnectée — reconnecte-la ou
   * appuie sur Échap ». Reprise automatique à la reconnexion (si la pause a été ouverte par la déconnexion) ; Échap
   * (ou Start) reprend la partie sans la manette, et la pause ne se rouvre que pour une NOUVELLE déconnexion.
   */
  private updatePadDisconnect(): void {
    if (this.leaving || this.failed) return;
    const lost = inputManager.getDisconnectedPlayers();
    const key = lost.join(',');
    if (key !== this.padLostKey) {
      this.padLostKey = key;
      if (lost.length > 0) {
        if (!this.paused) {
          this.padPauseOwned = true;
          this.openPause(null);
        }
        this.showPadMessage(lost);
      } else if (this.padPauseOwned) {
        this.padPauseOwned = false;
        if (this.paused) this.closePause();
      }
    }
    if (!this.paused && lost.length === 0) this.padPauseOwned = false;
    if (this.padMsg) {
      const visible = lost.length > 0 && this.paused;
      this.padMsg.text.setVisible(visible);
      this.padMsg.back.setVisible(visible);
    }
  }

  private showPadMessage(lost: PlayerId[]): void {
    const cx = GAME_WIDTH / 2;
    const cy = GAME_HEIGHT / 2 - 232;
    if (!this.padMsg) {
      const back = hudRect(this.ctx, cx, cy + 20, GAME_WIDTH - 160, 76, 0x3a1420, 0.95, HUD_DEPTH.pause + 5);
      back.setStrokeStyle(3, 0xff8a6a, 1);
      const text = hudText(this.ctx, cx, cy + 20, '', { size: 22, originX: 0.5, originY: 0.5, color: 0xffd0c0, depth: HUD_DEPTH.pause + 6, wrap: GAME_WIDTH - 220, align: 'center' });
      this.padMsg = { text, back };
    }
    // Manette virtuelle masquée (téléphone en portrait…) : pas d'Échap sur un téléphone, le message dit quoi faire.
    const virtual = lost.some((p) => {
      const d = inputManager.getAssignedDevice(p);
      return d !== null && d.kind === 'gamepad' && d.index === VIRTUAL_PAD_INDEX;
    });
    this.padMsg.text.setText(t(virtual ? 'touch.game.disconnected' : 'pad.game.disconnected', { n: lost.map((p) => p + 1).join(', ') }));
  }

  /** Détecte un front montant du bouton Start d'une manette (ouvre / ferme la pause). */
  private pollPadStart(): boolean {
    let pressed = false;
    const pads = listGamepads();
    for (const pad of pads) {
      const b = pad.buttons[PAD_START_BUTTON];
      const down = !!b && (b.pressed || b.value > 0.5);
      if (down && !this.padStartDown[pad.index]) {
        pressed = true;
        this.lastStartPad = pad.index;
      }
      this.padStartDown[pad.index] = down;
    }
    return pressed;
  }

  // ───────────────────────────── Langue, nettoyage ─────────────────────────────

  private retranslate(): void {
    if (this.failed) return;
    const players = this.sim.state.players;
    this.roomView?.retranslate();
    this.huds.forEach((h, i) => h.retranslate(players[i]));
    this.teamPanel?.retranslate(players);
    this.overlay.retranslate();
    this.demoOverlay?.retranslate();
    this.pauseMenu.retranslate();
    this.tutorialLabels = null;
    this.tutorialHud?.retranslate(this.tutorialEnded ? this.tutorialEndLabels() : undefined);
  }

  private cleanup(): void {
    this.demoWatcher?.stop();
    this.demoWatcher = null;
    this.demoOverlay?.destroy();
    this.demoOverlay = null;
    this.demoPilot = null;
    this.demoFlow = null;
    this.offLanguage?.();
    this.offLanguage = null;
    this.input.keyboard?.off('keydown-ESC', this.onEscape);
    this.input.keyboard?.off('keydown-M', this.onMute);
    this.input.keyboard?.off('keydown-ENTER', this.onEnter);
    this.input.keyboard?.off('keydown-SPACE', this.onSpaceEnd);
    this.input.keyboard?.off('keydown', this.onAnyKey);
    window.removeEventListener('blur', this.onWindowBlur);
    this.game.events.off(Phaser.Core.Events.HIDDEN, this.onGameHidden);
    this.events.off(Phaser.Scenes.Events.SHUTDOWN, this.onShutdown);
    if (this.failed) return;
    inputManager.reset();
    for (const h of this.huds) h.destroy();
    this.huds = [];
    this.teamPanel?.destroy();
    this.teamPanel = null;
    this.pauseMenu?.destroy();
    this.tutorialHud?.destroy();
    this.tutorialHud = null;
    this.tutorial = null;
    this.overlay?.destroy();
    this.darkRoom?.destroy();
    this.darkRoom = null;
    this.roomView?.destroy();
    this.roomView = null;
    this.enemyViews?.destroy();
    this.projViews?.destroy();
    for (const pv of this.playerViews) pv.destroy();
    this.playerViews = [];
    this.specialFx?.destroy();
    this.callFx?.destroy();
    this.fx?.destroy();
    this.rig?.destroy();
    this.sfx.destroy();
    this.pauseNav = null;
  }
}

