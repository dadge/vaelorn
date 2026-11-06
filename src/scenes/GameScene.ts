/**
 * GameScene : PUR RENDU + ENTRÉES. Aucune règle de jeu ici : la scène accumule le temps réel, appelle
 * `sim.step(SIM_STEP_MS, inputs)` (pas fixes, ≤ 5 par frame), puis synchronise des vues Phaser avec `GameState` et
 * joue les `SimEvent` (FX, sons placeholder, HUD).
 *
 * Écran partagé : une caméra Phaser par joueur (voir render/camera.ts + render/splitscreen.ts), une caméra d'interface
 * plein écran qui porte le HUD de chaque joueur DANS SA vue, le panneau d'équipe (3 joueurs), les bannières et la pause.
 *
 * Cycle de vie : à chaque événement `roomEntered`, la salle précédente est DÉTRUITE proprement (RoomView, pools
 * d'ennemis et de projectiles, FX) puis reconstruite. Au `shutdown`, tout est libéré (écouteurs, caméras, objets).
 */
import Phaser from 'phaser';
import { GAME_HEIGHT, GAME_WIDTH, PLAYER_COLORS, SIM_STEP_MS } from '../core/constants';
import { CHARACTERS } from '../core/characters';
import { createSimulation, type GameSimulation } from '../core/simulation';
import type { GameState, LevelDef, PlayerId, SimEvent, TickInputs, Vec2 } from '../core/types';
import { PlayerView } from '../entities/PlayerView';
import { EnemyViews } from '../entities/EnemyView';
import { ProjectileViews } from '../entities/ProjectileView';
import { RoomView } from '../entities/RoomView';
import { DarkRoomView, torchLightPos } from '../entities/DarkRoomView';
import { forceDarkLevel, isDevDarkAllowed } from '../entities/devDark';
import { GameOverlay, PauseMenu } from '../entities/overlay';
import { Sfx, sfxForEvent } from '../entities/sfx';
import type { ViewContext } from '../entities/common';
import { MAX_STEPS_PER_FRAME, mergeTickInputs, planSteps } from '../entities/loopLogic';
import { effectivePauseOwner, pauseIntentAllowed, pauseOwnerForPad, resolvePauseBack, resolvePauseConfirm } from '../entities/pauseLogic';
import { t, onLanguageChange } from '../i18n/i18n';
import { MenuNavigator, inputManager, listGamepads } from '../input';
import { getLevelByIndex } from '../levels';
import { ViewRig } from '../render/camera';
import { FxManager, damageNumberColor, ensureFxTextures } from '../render/fx';
import { SpecialFx } from '../render/specialFx';
import { heroFrame } from '../render/art/animations';
import { PlayerHud, TeamPanelHud, createSeparators, reviveRatioFor, specialHintLabel, type HudEnv } from '../render/hud';
import { HUD_DEPTH, hudRect, hudText } from '../render/hud';
import { SCENE_KEYS, type DialogueSceneData, type GameSceneData, type GameSession } from '../render/session';
import { computeLayout, type SplitLayout } from '../render/splitscreen';

/** Durée (ms) de la célébration avant d'enchaîner sur le dialogue de fin de niveau. */
const CELEBRATION_MS = 3200;
/** Durée (ms) du fondu de sortie vers une autre scène. */
const LEAVE_FADE_MS = 320;
/** Bouton « Start » des manettes (mapping standard). */
const PAD_START_BUTTON = 9;

let sessionCounter = 0;

export class GameScene extends Phaser.Scene {
  private session!: GameSession;
  private level!: LevelDef;
  private sim!: GameSimulation;
  private layout!: SplitLayout;
  private rig!: ViewRig;
  private fx!: FxManager;
  private specialFx!: SpecialFx;
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
  private leaving: { key: string; data?: object; elapsedMs: number } | null = null;
  private failed = false;

  private offLanguage: (() => void) | null = null;
  private readonly onEscape = (): void => {
    if (!this.paused && !this.leaving) this.openPause('keyboard');
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
  private readonly onShutdown = (): void => {
    this.cleanup();
  };

  constructor() {
    super(SCENE_KEYS.Game);
  }

  // ───────────────────────────── Cycle de vie ─────────────────────────────

  init(data: GameSceneData): void {
    this.session = data.session;
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
    this.sfx = new Sfx();
  }

  create(): void {
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.onShutdown);
    const baseLevel = getLevelByIndex(this.session.levelIndex);
    if (!baseLevel || this.session.players.length === 0) {
      this.showFatalError();
      return;
    }
    // dev : `?dark=1` force toutes les salles sombres (clone du niveau ; brasero virtuel en mode DEV uniquement)
    const search = typeof window !== 'undefined' ? window.location.search : '';
    const level = isDevDarkAllowed(search, import.meta.env.DEV) ? forceDarkLevel(baseLevel, import.meta.env.DEV) : baseLevel;
    this.level = level;
    const playerCount = Math.max(1, Math.min(4, this.session.players.length));
    this.kills = Array.from({ length: playerCount }, () => 0);
    this.downs = Array.from({ length: playerCount }, () => 0);

    // simulation (graine dérivée d'un compteur + horloge : la scène peut utiliser Date.now, pas le core)
    sessionCounter++;
    const seed = (Date.now() ^ Math.imul(sessionCounter, 0x9e3779b1)) >>> 0;
    this.sim = createSimulation({ levelId: level.id, players: this.session.players.slice(0, playerCount), seed }, level);

    inputManager.setPlayerCount(playerCount);
    inputManager.reset();

    // vues
    ensureFxTextures(this);
    this.layout = computeLayout(playerCount);
    this.rig = new ViewRig(this, this.layout);
    this.fx = new FxManager(this, this.rig, this.layout.zoom);
    this.specialFx = new SpecialFx(this, this.rig, this.fx);
    this.ctx = { scene: this, rig: this.rig, fx: this.fx, zoom: this.layout.zoom, playerCount };
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
    this.huds = state.players.map((p) => new PlayerHud(env, p.id, p));
    if (this.layout.teamPanel) this.teamPanel = new TeamPanelHud(env, this.layout.teamPanel, state.players);
    this.overlay = new GameOverlay(this.ctx, level);
    this.pauseMenu = new PauseMenu(this.ctx);

    // salle de départ (dev : ?room=N) puis construction de la vue de la salle
    this.applyStartRoom();
    this.buildRoom('start');

    // écouteurs
    this.input.keyboard?.on('keydown-ESC', this.onEscape);
    this.input.keyboard?.on('keydown-M', this.onMute);
    window.addEventListener('blur', this.onWindowBlur);
    this.game.events.on(Phaser.Core.Events.HIDDEN, this.onGameHidden);
    this.offLanguage = onLanguageChange(() => this.retranslate());
    // mémorise l'état « tenu » initial des boutons Start pour ne pas déclencher une pause fantôme
    this.pollPadStart();
  }

  /** Affiche une erreur lisible puis retourne au menu (niveau introuvable, session vide). */
  private showFatalError(): void {
    this.failed = true;
    this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2, t('game.error.level'), { fontFamily: 'monospace', fontSize: '24px', color: '#ff8a8a', align: 'center' })
      .setOrigin(0.5);
    this.time.delayedCall(2200, () => this.scene.start(SCENE_KEYS.Menu));
  }

  /** Dev : démarre dans la salle `session.startRoomIndex` (premier niveau uniquement ; lue sans modifier la session). */
  private applyStartRoom(): void {
    const wanted = this.session.startRoomIndex;
    if (typeof wanted !== 'number' || !Number.isFinite(wanted) || wanted <= 0) return;
    const index = Math.min(Math.floor(wanted), this.level.rooms.length - 1);
    if (index <= 0) return;
    const priv = this.sim as unknown as { loadRoom?: (i: number, reason: 'start' | 'next' | 'restart', events: SimEvent[]) => void };
    if (typeof priv.loadRoom !== 'function') return;
    try {
      this.sim.step(SIM_STEP_MS, {}); // consomme les événements de la salle 0
      for (let i = 0; i < index; i++) {
        const id = this.level.rooms[i].id;
        if (!this.sim.state.clearedRooms.includes(id)) this.sim.state.clearedRooms.push(id);
      }
      priv.loadRoom.call(this.sim, index, 'start', []);
    } catch (err) {
      console.warn('[GameScene] salle de départ ignorée', err);
    }
  }

  // ───────────────────────────── Construction de salle ─────────────────────────────

  private buildRoom(reason: 'start' | 'next' | 'restart'): void {
    const s = this.sim.state;
    this.roomView?.destroy();
    this.enemyViews.clear();
    this.projViews.clear();
    this.fx.clear();
    this.specialFx.clear();
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
      this.overlay.setExtraFade(Math.min(1, this.leaving.elapsedMs / LEAVE_FADE_MS));
      if (this.leaving.elapsedMs >= LEAVE_FADE_MS) {
        const { key, data } = this.leaving;
        this.leaving = null;
        this.scene.start(key, data);
        return;
      }
    }

    if (this.pollPadStart() && !this.leaving) {
      if (this.paused) this.closePause();
      else this.openPause(pauseOwnerForPad(this.lastStartPad));
    }

    this.updatePadDisconnect();

    if (this.paused) {
      this.updatePause();
      this.syncViews(0, false, 1);
      return;
    }

    const state = this.sim.state;
    const cur = inputManager.poll();
    this.lastPolled = cur;
    this.latched = mergeTickInputs(this.latched, cur);
    const plan = planSteps(this.accumulatorMs, dt, SIM_STEP_MS, MAX_STEPS_PER_FRAME);
    this.accumulatorMs = plan.accumulatorMs;
    let stepped = false;
    if (!this.leaving) {
      for (let i = 0; i < plan.steps; i++) {
        const inputs = i === 0 ? (this.latched ?? cur) : cur;
        const events = this.sim.step(SIM_STEP_MS, inputs);
        if (i === 0) this.latched = null;
        stepped = true;
        for (let k = 0; k < events.length; k++) this.handleEvent(events[k], state);
      }
    }
    if (state.roomIndex !== this.viewRoomIndex || this.forceRebuild) this.buildRoom(this.pendingReason);
    this.syncViews(dt, stepped, plan.alpha);

    if (this.finishing && !this.leaving) {
      this.finishMs += dt;
      if (this.finishMs >= CELEBRATION_MS) this.finishLevel();
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

    for (let i = 0; i < this.huds.length; i++) {
      this.huds[i].update({ state: s, room: this.sim.room, dtMs, timeMs, exitOpen, camCenter: this.rig.centerOf(i) });
    }
    this.teamPanel?.update(s, this.sim.room, dtMs);
    this.overlay.update({
      phase: s.phase,
      phaseTimerMs: s.phaseTimerMs,
      dtMs,
      sinceEnterMs: this.sinceEnterMs,
      exitOpen,
      boss: this.enemyViews.boss,
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
        const boss = e.kind === 'golem' || e.kind === 'morvane';
        fx.enemyDeath(e.pos.x, e.pos.y, e.kind, boss);
        if (e.byPlayer !== null && this.kills[e.byPlayer] !== undefined) this.kills[e.byPlayer]++;
        if (boss) {
          this.rig.shake(700, 0.012);
          this.overlay.flash(0xffffff, 0.7, 500);
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
        this.rig.shake(600, 0.011);
        this.overlay.flash(0xffffff, 0.5, 400);
        break;
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
    const data: DialogueSceneData = { session: this.session, stage: 'outro' };
    this.leaveTo(SCENE_KEYS.Dialogue, data);
  }

  private leaveTo(key: string, data?: object): void {
    if (this.leaving) return;
    this.leaving = { key, data, elapsedMs: 0 };
    inputManager.reset();
  }

  // ───────────────────────────── Pause ─────────────────────────────

  private openPause(owner: string | null): void {
    if (this.paused || this.failed) return;
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
    this.padMsg.text.setText(t('pad.game.disconnected', { n: lost.map((p) => p + 1).join(', ') }));
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
    this.pauseMenu.retranslate();
  }

  private cleanup(): void {
    this.offLanguage?.();
    this.offLanguage = null;
    this.input.keyboard?.off('keydown-ESC', this.onEscape);
    this.input.keyboard?.off('keydown-M', this.onMute);
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
    this.fx?.destroy();
    this.rig?.destroy();
    this.sfx.destroy();
    this.pauseNav = null;
  }
}

