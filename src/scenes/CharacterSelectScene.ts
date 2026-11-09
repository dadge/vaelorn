/**
 * CharacterSelectScene : un panneau par joueur (1..N), chacun libre jusqu'à ce qu'un PÉRIPHÉRIQUE le réclame.
 *
 * REJOINDRE PAR BOUTON : le premier appareil actif (A / Entrée / Espace sur manette ou clavier) réclame le plus petit
 * emplacement libre ; un appareil = un emplacement ; B / Échap relâche (ou annule « prêt »). Seul le propriétaire
 * contrôle son panneau (MenuIntent.source). Si le menu principal était piloté à la manette, celle-ci réclame
 * automatiquement l'emplacement 1. Au lancement, les appareils choisis sont appliqués à l'InputManager
 * (`assignDevice`) AVANT l'intro du niveau : 4 manettes simultanées, sans clavier, sont possibles.
 *
 * Chaque joueur parcourt les 8 personnages (sprite animé, nom/classe/description, attaque spéciale, barres Force /
 * Résistance / Vitesse / Relevage), puis se déclare « prêt » : le personnage est alors VERROUILLÉ (unique : grisé et
 * sauté pour les autres, avec message). Quand tous les emplacements sont réclamés ET prêts, un court compte à rebours
 * lance l'intro du niveau (Dialogue) ; n'importe quel joueur peut annuler pendant ce délai. À la souris : un clic sur
 * un panneau libre y installe le clavier (s'il est libre).
 *
 * Toute la logique (unicité, curseurs, emplacements, annulation) est pure : voir src/render/menuLogic.ts.
 *
 * MODE REPRISE (`data.resume`, entrée « Continuer » du menu) : l'équipe vient de la sauvegarde ; personnages et difficultés
 * sont verrouillés (tous « prêts » d'office) et l'écran devient une salle d'attente « A (manette) ou Entrée / Espace pour rejoindre » :
 * le premier appareil à appuyer prend la place 1 (celui qui a validé « Continuer » la prend d'office), puis la 2, etc. Quand
 * toutes les places sont réclamées, compte à rebours puis lancement directement dans la salle sauvegardée (dialogue d'intro
 * seulement si on reprend au début d'un niveau). Voir src/render/saveMenuLogic.ts.
 */
import Phaser from 'phaser';
import { CHARACTERS, CHARACTER_IDS } from '../core/characters';
import { GAME_WIDTH } from '../core/constants';
import type { PlayerId } from '../core/types';
import { t } from '../i18n/i18n';
import { MenuNavigator, inputManager, isNonStandardPad, listGamepads } from '../input';
import type { MenuAction } from '../input';
import { ATLAS_KEY, heroFrame, stepOf } from '../render/art';
import {
  allClaimed,
  allReady,
  applySelection,
  cancelSelection,
  claimSlot,
  claimSlotAt,
  claimedCount,
  confirmSelection,
  createSelectState,
  createSlots,
  describeSlotDevice,
  getMenuDevice,
  isTaken,
  missingSlots,
  moveCursor,
  releaseMissingSlots,
  releaseSlot,
  setCursor,
  setMenuDevice,
  slotOf,
  slotsToDevices,
  statRatings,
  stealMissingSlot,
  takenBy,
  toggleReady,
  type PadInfo,
  type SelectState,
  type SlotsState,
} from '../render/menuLogic';
import { createResumeSelectState, resumeDestination } from '../render/saveMenuLogic';
import {
  SCENE_KEYS,
  type CharacterSelectSceneData,
  type DialogueSceneData,
  type GameSceneData,
  type GameSession,
  type MenuSceneData,
} from '../render/session';
import {
  PANEL_STYLES,
  SegmentBar,
  UI_THEME,
  beginScene,
  bindLanguage,
  createDawnBackground,
  createPanel,
  createText,
  playerColor,
  playerPanelStyle,
  transitionTo,
  type DecorHandle,
} from '../render/ui';

/** Délai (ms) entre « tous prêts » et le lancement : laisse le temps d'annuler. */
export const START_DELAY_MS = 1300;
/** Durée d'affichage d'un message temporaire (« déjà pris… »). */
const FLASH_MS = 1800;
const PANEL_TOP = 84;
const STAT_COLORS = { strength: 0xff6a5a, resistance: 0x5aa8ff, speed: 0x7dffb0, revive: 0xff9ad0 } as const;

interface Thumb {
  zone: Phaser.GameObjects.Zone;
  x: number;
  y: number;
}

/** Objets Phaser d'un panneau de joueur. */
interface PanelView {
  playerId: number;
  x: number;
  w: number;
  h: number;
  container: Phaser.GameObjects.Container;
  panel: Phaser.GameObjects.Graphics;
  panelReady: Phaser.GameObjects.Graphics;
  header: Phaser.GameObjects.Text;
  inputText: Phaser.GameObjects.Text;
  sprite: Phaser.GameObjects.Image;
  spriteBaseY: number;
  name: Phaser.GameObjects.Text;
  klass: Phaser.GameObjects.Text;
  badgeIcon: Phaser.GameObjects.Image;
  badgeText: Phaser.GameObjects.Text;
  thumbs: Thumb[];
  thumbImages: Phaser.GameObjects.Image[];
  thumbScale: number;
  overlay: Phaser.GameObjects.Graphics;
  desc: Phaser.GameObjects.Text;
  specialTitle: Phaser.GameObjects.Text;
  specialDesc: Phaser.GameObjects.Text;
  statLabels: Phaser.GameObjects.Text[];
  bars: SegmentBar[];
  buttonOff: Phaser.GameObjects.Graphics;
  buttonOn: Phaser.GameObjects.Graphics;
  buttonText: Phaser.GameObjects.Text;
  message: Phaser.GameObjects.Text;
  /** Voile « emplacement libre » + invitation à rejoindre (hors conteneur, au-dessus). */
  joinVeil: Phaser.GameObjects.Graphics;
  joinText: Phaser.GameObjects.Text;
  joinSub: Phaser.GameObjects.Text;
  wide: boolean;
  readyAt: number;
}

/** Réduit `text` pour tenir dans `maxWidth` (jamais agrandi). */
function fit(text: Phaser.GameObjects.Text, content: string, maxWidth: number): void {
  text.setText(content);
  text.setScale(text.width > maxWidth ? maxWidth / text.width : 1);
}

export class CharacterSelectScene extends Phaser.Scene {
  private session!: GameSession;
  private state!: SelectState;
  private slots!: SlotsState;
  private nav!: MenuNavigator;
  private bg!: DecorHandle;
  private panels: PanelView[] = [];
  private title!: Phaser.GameObjects.Text;
  private subtitle!: Phaser.GameObjects.Text;
  private hint!: Phaser.GameObjects.Text;
  private hint2!: Phaser.GameObjects.Text;
  private countdown!: SegmentBar;
  private flash: Array<{ text: string; until: number } | null> = [];
  private startAt = -1;
  private starting = false;
  private nextAssignRefresh = 0;
  private now = 0;
  private assignHints: string[] = [];
  private assignWarns: string[] = [];
  /**
   * Mode REPRISE (« Continuer ») : équipe figée par la sauvegarde. Personnages et difficultés sont pré-remplis et
   * VERROUILLÉS (tous « prêts », on ne peut ni les changer ni les annuler) ; l'écran ne sert qu'à attribuer les appareils :
   * chaque joueur appuie sur A (manette) ou Entrée / Espace (clavier) pour rejoindre (premier arrivé = place 1, etc.).
   */
  private resumeMode = false;
  /** Vérifie l'état « tous prêts » à la prochaine frame (reprise : l'auto-réclamation a lieu dans `create`). */
  private pendingStartCheck = false;

  constructor() {
    super(SCENE_KEYS.CharacterSelect);
  }

  init(data: CharacterSelectSceneData): void {
    this.session = data.session;
    this.resumeMode = data.resume === true;
    this.pendingStartCheck = false;
    this.state = this.resumeMode ? createResumeSelectState(data.session) : createSelectState(data.session);
    this.slots = createSlots(data.session.playerCount);
    this.panels = [];
    this.flash = this.state.cursors.map(() => null);
    this.startAt = -1;
    this.starting = false;
    this.nextAssignRefresh = 0;
    this.now = 0;
    this.assignHints = [];
    this.assignWarns = [];
  }

  create(): void {
    beginScene(this);
    this.cameras.main.setBackgroundColor(UI_THEME.bg);
    inputManager.attach();
    // Pendant la sélection, on lit les périphériques bruts (MenuIntent.source) : pas d'attribution explicite en cours.
    inputManager.clearAssignments();
    inputManager.setPlayerCount(this.session.playerCount);

    this.bg = createDawnBackground(this, { dim: 0.45 });
    this.title = createText(this, GAME_WIDTH / 2, 34, t('select.title'), { size: 'lg', color: UI_THEME.accent, origin: [0.5, 0.5], align: 'center' });
    this.subtitle = createText(this, GAME_WIDTH / 2, 66, '', { size: 'sm', color: UI_THEME.textDim, origin: [0.5, 0.5], align: 'center' });
    this.countdown = new SegmentBar(this, GAME_WIDTH / 2 - 200, 62, 400, 10, 20, UI_THEME.good);
    this.countdown.graphics.setVisible(false);
    this.hint = createText(this, GAME_WIDTH / 2, 686, this.resumeMode ? '' : t('pad.select.hint.choose'), { size: 'sm', color: UI_THEME.textDim, origin: [0.5, 0.5], align: 'center' });
    this.hint2 = createText(this, GAME_WIDTH / 2, 706, t('pad.select.hint.menu'), { size: 'sm', color: UI_THEME.textDim, origin: [0.5, 0.5], align: 'center' });

    this.buildPanels();

    // Navigation créée AVANT l'auto-réclamation : elle ignore les boutons déjà tenus (celui qui a lancé la scène).
    this.nav = new MenuNavigator();

    // La manette qui pilotait le menu principal réclame automatiquement l'emplacement 1.
    const menuDevice = getMenuDevice();
    if (menuDevice && menuDevice.startsWith('gamepad:')) {
      const idx = Number(menuDevice.slice('gamepad:'.length));
      if (listGamepads().some((g) => g.index === idx)) this.slots = claimSlot(this.slots, menuDevice).slots;
    } else if (this.resumeMode && menuDevice === 'keyboard') {
      // Reprise : le clavier qui a validé « Continuer » prend aussi la place 1 (sinon il faudrait rappuyer sur Entrée).
      this.slots = claimSlot(this.slots, menuDevice).slots;
    }
    setMenuDevice(null);
    this.pendingStartCheck = this.resumeMode;

    this.refreshAll();
    this.refreshInputLines();

    bindLanguage(this, () => this.relabel());
    this.events.once('shutdown', () => {
      this.panels = [];
    });
  }

  update(time: number, delta: number): void {
    this.now = time;
    this.bg.update(time);
    if (this.starting) return;
    if (this.pendingStartCheck) {
      this.pendingStartCheck = false;
      this.updateStartState();
    }

    for (const intent of this.nav.pollMenu()) this.onIntent(intent.source, intent.action);

    // Messages temporaires expirés
    for (let i = 0; i < this.flash.length; i++) {
      const f = this.flash[i];
      if (f && time >= f.until) {
        this.flash[i] = null;
        this.refreshPanel(i);
      }
    }

    // Appareils attribués (détection / débranchement des manettes)
    if (time >= this.nextAssignRefresh) {
      this.nextAssignRefresh = time + 500;
      this.refreshInputLines();
    }

    // Animation des sprites
    for (const p of this.panels) this.animatePanel(p, time);

    // Compte à rebours de lancement
    if (this.startAt >= 0) {
      const progress = Math.min(1, (time - this.startAt) / START_DELAY_MS);
      this.countdown.setValue(progress, 1);
      if (progress >= 1) this.launch();
    }
    void delta;
  }

  // ───────────────────────────── Construction ─────────────────────────────

  private buildPanels(): void {
    const n = this.state.cursors.length;
    const wide = n <= 2;
    const w = wide ? 440 : 296;
    const gap = 16;
    const total = n * w + (n - 1) * gap;
    const startX = Math.round((GAME_WIDTH - total) / 2);
    for (let i = 0; i < n; i++) this.panels.push(this.createPanelView(i, startX + i * (w + gap), w, wide));
  }

  private createPanelView(playerId: number, x: number, w: number, wide: boolean): PanelView {
    const color = playerColor(playerId);
    const inner = w - 24;
    let y = 8;
    const kids: Phaser.GameObjects.GameObject[] = [];

    const header = createText(this, 12, y, '', { size: 'md', color });
    y += 28;
    const inputText = createText(this, 12, y, '', { size: 'sm', color: UI_THEME.textDim });
    y += 22;

    const spriteScale = wide ? 6 : 4;
    const spriteSize = spriteScale * 16;
    const spriteBaseY = y + spriteSize / 2;
    const sprite = this.add.image(w / 2, spriteBaseY, ATLAS_KEY, heroFrame('david', 'down', 0)).setScale(spriteScale);
    y += spriteSize + 4;

    const name = createText(this, w / 2, y, '', { size: 'md', origin: [0.5, 0], align: 'center' });
    y += 26;
    const klass = createText(this, w / 2, y, '', { size: 'sm', color: UI_THEME.textDim, origin: [0.5, 0], align: 'center' });
    y += 20;
    const badgeIcon = this.add.image(0, y + 8, ATLAS_KEY, 'ui_heart_full').setScale(2).setOrigin(0, 0.5);
    const badgeText = createText(this, 0, y + 8, t('select.family'), { size: 'sm', color: UI_THEME.accent, origin: [0, 0.5] });
    y += 22;

    // Bandeau des 8 personnages (vignettes cliquables)
    const thumbScale = wide ? 3 : 2;
    const ts = 16 * thumbScale;
    const count = CHARACTER_IDS.length;
    const tgap = Math.max(2, Math.floor((inner - count * ts) / (count - 1)));
    const rowW = count * ts + (count - 1) * tgap;
    const tx0 = Math.round((w - rowW) / 2);
    const thumbs: Thumb[] = [];
    const thumbImages: Phaser.GameObjects.Image[] = [];
    CHARACTER_IDS.forEach((id, k) => {
      const tx = tx0 + k * (ts + tgap);
      const img = this.add.image(tx, y, ATLAS_KEY, heroFrame(id, 'down', 0)).setOrigin(0, 0).setScale(thumbScale);
      thumbImages.push(img);
      const zone = this.add.zone(tx, y, ts, ts).setOrigin(0, 0);
      thumbs.push({ zone, x: tx, y });
    });
    const overlay = this.add.graphics();
    y += ts + 8;

    const descLines = wide ? 3 : 4;
    const desc = createText(this, 12, y, '', { size: 'sm', color: UI_THEME.text, wrapWidth: inner, lineSpacing: 2 }).setMaxLines(descLines);
    y += descLines * 20 + 6;

    // Attaque spéciale : nom + description (clés character.<id>.special.name / .desc)
    const specialTitle = createText(this, 12, y, '', { size: 'sm', color: UI_THEME.accent });
    y += 20;
    const specialLines = 3;
    const specialDesc = createText(this, 12, y, '', { size: 'sm', color: UI_THEME.textDim, wrapWidth: inner, lineSpacing: 2 }).setMaxLines(specialLines);
    y += specialLines * 20 + 6;

    const statKeys = ['select.strength', 'select.resistance', 'select.speed', 'select.reviveSpeed'] as const;
    const statLabels: Phaser.GameObjects.Text[] = [];
    const bars: SegmentBar[] = [];
    const barX = 12 + 112;
    const barW = w - barX - 12;
    const statColors = [STAT_COLORS.strength, STAT_COLORS.resistance, STAT_COLORS.speed, STAT_COLORS.revive];
    statKeys.forEach((key, k) => {
      statLabels.push(createText(this, 12, y + 1, t(key), { size: 'sm', color: UI_THEME.textDim }));
      bars.push(new SegmentBar(this, barX, y + 3, barW, 10, 10, statColors[k]));
      y += 20;
    });
    y += 4;

    const bh = 36;
    const buttonOff = createPanel(this, 12, y, inner, bh, PANEL_STYLES.default);
    const buttonOn = createPanel(this, 12, y, inner, bh, PANEL_STYLES.good);
    const buttonText = createText(this, w / 2, y + bh / 2, '', { size: 'md', origin: [0.5, 0.5], align: 'center' });
    const buttonZone = this.add.zone(12, y, inner, bh).setOrigin(0, 0);
    y += bh + 4;
    const message = createText(this, 12, y, '', { size: 'sm', color: UI_THEME.bad, wrapWidth: inner }).setMaxLines(2);
    y += 38;

    const h = y + 2;
    const panel = createPanel(this, 0, 0, w, h, playerPanelStyle(playerId, false));
    const panelReady = createPanel(this, 0, 0, w, h, playerPanelStyle(playerId, true));

    kids.push(panel, panelReady, header, inputText, sprite, name, klass, badgeIcon, badgeText);
    kids.push(...thumbImages, overlay, desc, specialTitle, specialDesc, ...statLabels, ...bars.map((b) => b.graphics));
    kids.push(buttonOff, buttonOn, buttonText, message, buttonZone, ...thumbs.map((th) => th.zone));
    const container = this.add.container(x, PANEL_TOP, kids);

    // Voile « emplacement libre » (hors conteneur : au-dessus de tout, ne capte pas la souris)
    const joinVeil = this.add.graphics().setDepth(10);
    joinVeil.fillStyle(0x0b0a14, 0.82);
    joinVeil.fillRect(x + 2, PANEL_TOP + 2, w - 4, h - 4);
    const joinText = createText(this, x + w / 2, PANEL_TOP + h / 2 - 20, t('pad.slot.empty'), {
      size: 'md',
      color,
      origin: [0.5, 0.5],
      align: 'center',
      wrapWidth: inner,
    }).setDepth(11);
    const joinSub = createText(this, x + w / 2, PANEL_TOP + h / 2 + 50, t('pad.slot.emptyKb'), {
      size: 'sm',
      color: UI_THEME.textDim,
      origin: [0.5, 0.5],
      align: 'center',
      wrapWidth: inner,
    }).setDepth(11);

    // Souris : un clic sur une vignette choisit (ou valide si c'est déjà le curseur) ; le bouton bascule « prêt ».
    thumbs.forEach((th, k) => {
      th.zone.setInteractive({ useHandCursor: true });
      th.zone.on('pointerdown', () => this.onThumbClick(playerId, k));
    });
    buttonZone.setInteractive({ useHandCursor: true });
    buttonZone.on('pointerdown', () => {
      if (!this.ensureClaimed(playerId)) return;
      if (this.resumeMode) return; // reprise : l'état « prêt » est verrouillé
      this.applyResult(playerId, toggleReady(this.state, playerId));
    });

    return {
      playerId,
      x,
      w,
      h,
      container,
      panel,
      panelReady,
      header,
      inputText,
      sprite,
      spriteBaseY,
      name,
      klass,
      badgeIcon,
      badgeText,
      thumbs,
      thumbImages,
      thumbScale,
      overlay,
      desc,
      specialTitle,
      specialDesc,
      statLabels,
      bars,
      buttonOff,
      buttonOn,
      buttonText,
      message,
      joinVeil,
      joinText,
      joinSub,
      wide,
      readyAt: -1,
    };
  }

  // ───────────────────────────── Entrées ─────────────────────────────

  /**
   * Intention d'un périphérique (`source` = 'keyboard' | 'gamepad:N').
   * Périphérique sans emplacement : « confirmer » réclame le plus petit emplacement libre ; « retour » ramène au menu
   * seulement si personne n'a rien réclamé. Propriétaire : « retour » annule « prêt », sinon relâche l'emplacement.
   */
  private onIntent(source: string, action: MenuAction): void {
    const slot = slotOf(this.slots, source);
    if (slot < 0) {
      if (action === 'confirm') {
        // Tout est pris : on récupère l'emplacement d'une manette absente (batterie vide, débranchée).
        const r = stealMissingSlot(this.slots, source, this.padInfos());
        if (r.result === 'claimed') {
          this.slots = r.slots;
          // L'ancien propriétaire (absent) ne doit pas laisser « prêt » au nouvel arrivant.
          if (this.state.ready[r.slot]) this.state = cancelSelection(this.state, r.slot).state;
          this.refreshAll();
          this.refreshInputLines();
          this.updateStartState();
        }
      } else if (action === 'back') {
        // Les emplacements orphelins (manette absente) ne bloquent ni le retour au menu ni l'état « prêt ».
        const missing = missingSlots(this.slots, this.padInfos());
        const active = this.slots.owners.filter((o, i) => o !== null && !missing[i]).length;
        const anyReady = this.state.ready.some((rdy, i) => rdy && !missing[i]);
        if (active === 0 && !anyReady) {
          this.slots = releaseMissingSlots(this.slots, this.padInfos()).slots;
          this.backToMenu();
        }
      }
      return;
    }
    // Reprise : « retour » relâche toujours la place (il n'y a pas de choix de personnage à annuler).
    if (action === 'back' && (this.resumeMode || !this.state.ready[slot])) {
      this.slots = releaseSlot(this.slots, source).slots;
      this.refreshAll();
      this.refreshInputLines();
      this.updateStartState(); // reprise : annule le compte à rebours si toutes les places n'étaient plus réclamées
      return;
    }
    this.onAction(slot, action);
  }

  private onAction(playerId: number, action: MenuAction): void {
    switch (action) {
      case 'left':
        this.setState(moveCursor(this.state, playerId, -1), playerId);
        break;
      case 'right':
        this.setState(moveCursor(this.state, playerId, 1), playerId);
        break;
      case 'confirm':
        this.applyResult(playerId, confirmSelection(this.state, playerId));
        break;
      case 'back':
        this.applyResult(playerId, cancelSelection(this.state, playerId));
        break;
      default:
        break;
    }
  }

  /** Souris : un panneau libre est réclamé par le clavier (s'il est libre) ; retourne true si le panneau est utilisable. */
  private ensureClaimed(playerId: number): boolean {
    if (this.slots.owners[playerId] !== null) return true;
    const r = claimSlotAt(this.slots, playerId, 'keyboard');
    if (r.result === 'claimed') {
      this.slots = r.slots;
      this.refreshAll();
      this.refreshInputLines();
      this.updateStartState();
    }
    return false;
  }

  private onThumbClick(playerId: number, index: number): void {
    if (!this.ensureClaimed(playerId)) return;
    const id = CHARACTER_IDS[index];
    if (this.state.ready[playerId]) return;
    if (this.state.cursors[playerId] === id) {
      this.applyResult(playerId, confirmSelection(this.state, playerId));
      return;
    }
    const res = setCursor(this.state, playerId, id);
    if (res.ok) this.setState(res.state, playerId);
    else if (res.takenBy >= 0) this.flashTaken(playerId, res.takenBy);
  }

  /** Applique le résultat d'une confirmation / annulation / bascule. */
  private applyResult(playerId: number, r: ReturnType<typeof toggleReady>): void {
    switch (r.result) {
      case 'ready':
        this.state = r.state;
        this.panels[playerId].readyAt = this.now;
        for (const b of r.bumped) this.flashTaken(b, playerId);
        break;
      case 'taken':
        this.flashTaken(playerId, r.takenBy);
        return;
      case 'unready':
        this.state = r.state;
        break;
      case 'menu':
        // Le retour au menu ne passe que par `onIntent` (aucun emplacement réclamé) : ignoré ici.
        return;
      default:
        return;
    }
    this.refreshAll();
    this.updateStartState();
  }

  private setState(next: SelectState, playerId: number): void {
    if (next === this.state) return;
    this.state = next;
    this.refreshPanel(playerId);
  }

  private flashTaken(victim: number, owner: number): void {
    this.flash[victim] = { text: t('select.takenBy', { n: owner + 1 }), until: this.now + FLASH_MS };
    this.refreshAll();
  }

  /** Démarre / annule le compte à rebours selon l'état « tous prêts » (et tous les emplacements réclamés). */
  private updateStartState(): void {
    const everyone = allReady(this.state) && allClaimed(this.slots);
    if (everyone && this.startAt < 0) this.startAt = this.now;
    if (!everyone) {
      this.startAt = -1;
      this.countdown.setValue(0, 1);
    }
    this.refreshHeader();
  }

  private launch(): void {
    if (this.starting) return;
    this.starting = true;
    const session = applySelection(this.session, this.state);
    // Les appareils choisis sont appliqués AVANT le lancement du jeu (mode explicite : un appareil = un joueur).
    inputManager.clearAssignments();
    inputManager.setPlayerCount(session.playerCount);
    slotsToDevices(this.slots).forEach((device, i) => inputManager.assignDevice(i as PlayerId, device));
    inputManager.reset();
    if (this.resumeMode && resumeDestination(session) === 'game') {
      // Reprise en cours de niveau : pas de dialogue d'introduction, directement la salle sauvegardée.
      const game: GameSceneData = { session };
      transitionTo(this, SCENE_KEYS.Game, game);
      return;
    }
    const data: DialogueSceneData = { session, stage: 'intro' };
    transitionTo(this, SCENE_KEYS.Dialogue, data);
  }

  private backToMenu(): void {
    if (this.starting) return;
    this.starting = true;
    // Reprise : on ne renvoie pas l'équipe sauvegardée au menu (elle écraserait les choix de « Nouvelle partie »).
    const data: MenuSceneData = this.resumeMode ? {} : { session: applySelection(this.session, this.state) };
    transitionTo(this, SCENE_KEYS.Menu, data);
  }

  // ───────────────────────────── Rafraîchissement ─────────────────────────────

  private relabel(): void {
    this.hint.setText(this.resumeMode ? '' : t('pad.select.hint.choose'));
    this.hint2.setText(t('pad.select.hint.menu'));
    for (const p of this.panels) {
      const keys = ['select.strength', 'select.resistance', 'select.speed', 'select.reviveSpeed'] as const;
      p.statLabels.forEach((l, k) => l.setText(t(keys[k])));
      p.badgeText.setText(t('select.family'));
    }
    // Les messages temporaires sont recalculés dans la nouvelle langue (le propriétaire est relu dans le texte).
    this.flash = this.flash.map(() => null);
    this.refreshAll();
    this.refreshInputLines();
  }

  private refreshAll(): void {
    this.panels.forEach((_, i) => this.refreshPanel(i));
    this.refreshHeader();
  }

  private refreshHeader(): void {
    const claimedAll = allClaimed(this.slots);
    const everyone = allReady(this.state) && claimedAll;
    const some = this.state.ready.some(Boolean);
    this.title.setText(everyone ? t('select.start') : this.resumeMode ? t('save.resume.title') : t('select.title'));
    this.title.setColor(everyone ? '#5be37d' : '#ffd36b');
    let sub = '';
    if (!everyone) {
      if (!claimedAll && this.resumeMode) {
        const resume = t('save.resume', { level: this.session.levelIndex + 1, room: (this.session.startRoomIndex ?? 0) + 1 });
        sub = t('save.resume.subtitle', { resume });
      } else if (!claimedAll) sub = t('pad.select.joined', { claimed: claimedCount(this.slots), total: this.slots.owners.length });
      else if (some) sub = t('select.waiting');
    }
    this.subtitle.setText(sub);
    this.countdown.graphics.setVisible(everyone);
  }

  /** Manettes actuellement visibles par le navigateur (instantané). */
  private padInfos(): PadInfo[] {
    return listGamepads().map((g) => ({ index: g.index, name: g.id, nonStandard: isNonStandardPad(g) }));
  }

  /** Relit les appareils des emplacements : libellé, avertissement (manette débranchée), info (non standard). */
  private refreshInputLines(): void {
    const pads = this.padInfos();
    for (const p of this.panels) {
      const view = describeSlotDevice(this.slots.owners[p.playerId] ?? null, pads);
      const label = view.claimed ? t(view.labelKey, view.params) : '';
      const maxChars = Math.floor((p.w - 24) / 9.5);
      p.inputText.setText(label.length > maxChars ? `${label.slice(0, maxChars - 1)}…` : label);
      p.inputText.setColor(view.missing ? '#ff5a5a' : '#a8a2c8');
      this.assignWarns[p.playerId] = view.missing ? t('pad.slot.missing') : '';
      this.assignHints[p.playerId] = view.nonStandard ? t('pad.nonStandard') : '';
      this.refreshMessage(p.playerId);
    }
  }

  /** Message sous le bouton : temporaire (déjà pris) en priorité, sinon avertissement + info de manette. */
  private refreshMessage(playerId: number): void {
    const p = this.panels[playerId];
    if (!p) return;
    const f = this.flash[playerId];
    if (f) {
      p.message.setText(f.text);
      p.message.setColor('#ff5a5a');
      return;
    }
    const warn = this.assignWarns[playerId] ?? '';
    const hint = this.assignHints[playerId] ?? '';
    p.message.setText([warn, hint].filter((x) => x.length > 0).join('\n'));
    p.message.setColor(warn ? '#ff9a8a' : '#ffd36b');
  }

  private refreshPanel(i: number): void {
    const p = this.panels[i];
    if (!p) return;
    const id = this.state.cursors[i];
    const def = CHARACTERS[id];
    const ready = this.state.ready[i];
    const taken = isTaken(this.state, id, i);
    const colorHex = playerColor(i);
    const claimed = this.slots.owners[i] !== null;

    // Emplacement libre : voile + invitation à rejoindre
    p.joinVeil.setVisible(!claimed);
    p.joinText.setVisible(!claimed);
    p.joinSub.setVisible(!claimed);
    p.joinText.setText(t('pad.slot.empty'));
    p.joinSub.setText(t('pad.slot.emptyKb'));

    p.header.setText(t('select.player', { n: i + 1 }));
    p.panel.setVisible(!ready);
    p.panelReady.setVisible(ready);

    p.name.setText(t(def.nameKey));
    p.name.setColor('#' + def.color.toString(16).padStart(6, '0'));
    p.klass.setText(t(def.classKey));
    p.desc.setText(t(def.descKey));
    const sp = def.special;
    if (sp) {
      fit(p.specialTitle, t('pad.select.special', { name: t(sp.nameKey) }), p.w - 24);
      p.specialDesc.setText(t(sp.descKey));
    } else {
      p.specialTitle.setText('');
      p.specialDesc.setText('');
    }
    p.sprite.setFrame(heroFrame(id, 'down', 0));
    if (taken) p.sprite.setTint(0x444444);
    else p.sprite.clearTint();

    // Badge « famille » centré sous la classe
    p.badgeIcon.setVisible(def.family);
    p.badgeText.setVisible(def.family);
    if (def.family) {
      const iconW = 16;
      const total = iconW + 6 + p.badgeText.width;
      const sx = Math.round((p.w - total) / 2);
      p.badgeIcon.setX(sx);
      p.badgeText.setX(sx + iconW + 6);
    }

    const r = statRatings(def);
    [r.strength, r.resistance, r.speed, r.revive].forEach((v, k) => p.bars[k].setValue(v, 10));

    // Bouton « prêt »
    p.buttonOff.setVisible(!ready);
    p.buttonOn.setVisible(ready);
    p.buttonText.setText(ready ? t('select.ready') : t('select.confirm'));
    p.buttonText.setColor(ready ? '#5be37d' : '#f4f0ff');

    // Vignettes : cadre du curseur, personnages pris grisés avec la pastille de leur propriétaire
    const g = p.overlay;
    g.clear();
    const ts = 16 * p.thumbScale;
    CHARACTER_IDS.forEach((cid, k) => {
      const th = p.thumbs[k];
      const owner = takenBy(this.state, cid, i);
      const img = p.thumbImages[k];
      if (owner >= 0) img.setTint(0x3a3a4a);
      else img.clearTint();
      if (owner >= 0) {
        g.fillStyle(0x000000, 0.45);
        g.fillRect(th.x, th.y, ts, ts);
        g.fillStyle(0x14121f, 1);
        g.fillRect(th.x + ts - 11, th.y + ts - 11, 11, 11);
        g.fillStyle(playerColor(owner), 1);
        g.fillRect(th.x + ts - 9, th.y + ts - 9, 7, 7);
      }
      if (CHARACTERS[cid].family) {
        g.fillStyle(0x14121f, 1);
        g.fillRect(th.x, th.y, 8, 8);
        g.fillStyle(0xff4058, 1);
        g.fillRect(th.x + 1, th.y + 1, 6, 6);
      }
      if (k === CHARACTER_IDS.indexOf(id)) {
        const c = ready ? 0x5be37d : colorHex;
        g.fillStyle(0x14121f, 1);
        g.fillRect(th.x - 3, th.y - 3, ts + 6, 7);
        g.fillRect(th.x - 3, th.y + ts - 4, ts + 6, 7);
        g.fillRect(th.x - 3, th.y - 3, 7, ts + 6);
        g.fillRect(th.x + ts - 4, th.y - 3, 7, ts + 6);
        g.fillStyle(c, 1);
        g.fillRect(th.x - 2, th.y - 2, ts + 4, 3);
        g.fillRect(th.x - 2, th.y + ts - 1, ts + 4, 3);
        g.fillRect(th.x - 2, th.y - 2, 3, ts + 4);
        g.fillRect(th.x + ts - 1, th.y - 2, 3, ts + 4);
      }
    });

    this.refreshMessage(i);
  }

  private animatePanel(p: PanelView, time: number): void {
    const id = this.state.cursors[p.playerId];
    const ready = this.state.ready[p.playerId];
    const step = stepOf(Math.floor(time / 260));
    const sinceReady = p.readyAt >= 0 ? time - p.readyAt : -1;
    const strike = ready && sinceReady >= 0 && sinceReady < 420;
    p.sprite.setFrame(heroFrame(id, strike ? 'right' : 'down', step, strike ? 'attack' : 'walk'));
    const bob = ready ? Math.round(Math.sin(time / 180) * 3) : Math.round(Math.sin(time / 520) * 2);
    p.sprite.setY(p.spriteBaseY + bob);
  }
}
