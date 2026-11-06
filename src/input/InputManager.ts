/**
 * InputManager : attribue des sources d'entrée aux joueurs et produit les `TickInputs` de la simulation.
 *
 * Attribution par défaut (DESIGN.md §5) :
 *  - J1 = clavier (flèches + Espace, ou WASD + E) ;
 *  - J2..J4 = manettes, par INDICE NAVIGATEUR STABLE : J2 ← manette d'indice 0, J3 ← 1, J4 ← 2
 *    (stable = si une manette est débranchée, les autres joueurs ne « glissent » pas) ;
 *  - option `player1Gamepad` : J1 = manette 0, J2 = manette 1, J3 = manette 2, J4 = manette 3 (plus de clavier) ;
 *  - SOLO (1 joueur, sans `player1Gamepad`) : J1 utilise « la première source utilisée » : clavier OU première
 *    manette connectée, selon celle qui est active (la dernière à avoir produit une entrée garde la main).
 *  - `registerSource(playerId, source)` remplace l'attribution d'un joueur (tactile, réseau…).
 *  - ATTRIBUTION EXPLICITE (écran de sélection « rejoindre par bouton ») : `assignDevice(playerId, device)` avec
 *    device = clavier | manette d'indice N | null. Dès le premier appel, le mode explicite remplace TOUTES les
 *    attributions par défaut : un joueur sans appareil assigné ne reçoit aucune entrée. Un appareil = un emplacement
 *    (le clavier ne peut être que sur un seul joueur ; réassigner un appareil le retire de son ancien propriétaire).
 *    `clearAssignments()` revient aux attributions par défaut.
 *
 * Utilisation côté scène : `inputManager.setPlayerCount(n)` une fois, puis `inputManager.poll()` à chaque
 * frame de rendu (ou avant chaque pas de simulation) → `TickInputs` à passer à `step()`.
 * Le singleton ne touche ni `window` ni `navigator` avant le premier `attach()`/`poll()`.
 */
import type { ActionFrame, PlayerId, TickInputs } from '../core/types';
import { MAX_PLAYERS } from '../core/constants';
import type {
  Bindings,
  BindingsOverrides,
  BindingsValidation,
  DeviceAssignment,
  InputKind,
  InputSource,
  MenuDevice,
  MenuDeviceProvider,
} from './actions';
import { createDefaultBindings } from './defaultBindings';
import { GamepadSource, defaultGamepadProvider, listGamepads } from './GamepadSource';
import type { GamepadLike, GamepadProvider } from './GamepadSource';
import { KeyboardSource } from './KeyboardSource';
import {
  cloneBindings,
  emptyFrame,
  frameHasActivity,
  gamepadToMenuHeld,
  isNonStandardPad,
  keysToMenuHeld,
  mergeBindings,
  validateBindings,
} from './mapping';

/** Stockage minimal (compatible `localStorage`). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Clé localStorage des bindings (versionnée). */
export const BINDINGS_STORAGE_KEY = 'vaelorn.bindings.v1';

/** Une ligne de l'écran de sélection : quelle entrée contrôle quel joueur. */
export interface PlayerAssignment {
  playerId: PlayerId;
  /** Famille de l'entrée actuellement utilisée (en solo : celle de la source active, 'keyboard' au départ). */
  label: InputKind;
  /** Indice navigateur de la manette (label 'gamepad' uniquement, si une manette est résolue). */
  gamepadIndex?: number;
  /** Nom de la manette fournie par le navigateur (si connue). */
  gamepadName?: string;
  /** Clavier : toujours true. Manette : détectée ou non. Autre source : `source.connected()`. */
  connected: boolean;
  /** true en solo « première source utilisée » (clavier ET manette possibles) : l'UI peut afficher « clavier / manette ». */
  anyDevice?: boolean;
  /** false si le mode explicite est actif et qu'aucun appareil n'est assigné à ce joueur (sinon true). */
  assigned: boolean;
  /** true si la manette résolue n'a pas le mapping standard (mappage de repli en vigueur). */
  nonStandard?: boolean;
  /** Appareil explicitement assigné (`assignDevice`), le cas échéant. */
  device?: DeviceAssignment;
}

/** Événement de branchement / débranchement de manette (`onConnect` / `onDisconnect`). */
export interface PadEvent {
  /** Indice navigateur de la manette. */
  index: number;
  /** Identifiant fourni par le navigateur. */
  name: string;
  /** Joueur actif auquel la manette est attribuée (null si aucun). */
  playerId: PlayerId | null;
}

export type PadEventListener = (e: PadEvent) => void;

/** Cible des événements `gamepadconnected` / `gamepaddisconnected` (`window`, ou un faux objet en test). */
export interface PadEventTarget {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addEventListener(type: string, listener: (ev: any) => void): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  removeEventListener(type: string, listener: (ev: any) => void): void;
}

export interface InputManagerOptions {
  /** Nombre de joueurs actifs initial (1..4, défaut 1). */
  playerCount?: number;
  /** J1 = manette 0 au lieu du clavier (défaut false). */
  player1Gamepad?: boolean;
  /** Bindings initiaux (défaut : bindings par défaut). */
  bindings?: Bindings;
  /** Source clavier injectée (tests). Défaut : `new KeyboardSource()` sur `window`. */
  keyboard?: KeyboardSource;
  /** Fournisseur de manettes injecté (tests). Défaut : `navigator.getGamepads()` protégé. */
  gamepadProvider?: GamepadProvider;
  /**
   * Stockage des bindings. `undefined` (défaut) = `localStorage` s'il est accessible ; `null` = aucun.
   */
  storage?: StorageLike | null;
  /** Charge automatiquement les bindings sauvegardés au premier `attach()` (utilisé par le singleton). */
  autoLoad?: boolean;
  /** Cible des événements gamepadconnected/disconnected (défaut : `window` s'il existe). `null` = aucune. */
  padEventTarget?: PadEventTarget | null;
}

/**
 * Source « première utilisée » : interroge deux sources et suit celle qui est active. La source courante
 * garde la main tant qu'elle produit une entrée ; si elle est au repos et que l'autre produit une entrée, on bascule.
 */
export class FirstUsedSource implements InputSource {
  private active: InputSource;

  constructor(
    private readonly primary: InputSource,
    private readonly secondary: InputSource,
  ) {
    this.active = primary;
  }

  get kind(): InputKind {
    return this.active.kind;
  }
  get id(): string {
    return this.active.id;
  }
  /** Source actuellement active. */
  get current(): InputSource {
    return this.active;
  }

  poll(): ActionFrame {
    const fp = this.primary.connected() ? this.primary.poll() : emptyFrame();
    const fs = this.secondary.connected() ? this.secondary.poll() : emptyFrame();
    if (this.active === this.primary) {
      if (!frameHasActivity(fp) && frameHasActivity(fs)) this.active = this.secondary;
    } else if (!frameHasActivity(fs) && frameHasActivity(fp)) {
      this.active = this.primary;
    }
    return this.active === this.primary ? fp : fs;
  }

  connected(): boolean {
    return this.primary.connected() || this.secondary.connected();
  }

  reset(): void {
    this.primary.reset?.();
    this.secondary.reset?.();
  }
}

function defaultStorage(): StorageLike | null {
  try {
    if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
  } catch {
    /* accès refusé (mode privé, cookies bloqués) */
  }
  return null;
}

function clampCount(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(MAX_PLAYERS, Math.floor(n)));
}

const ALL_PLAYER_IDS: readonly PlayerId[] = [0, 1, 2, 3];

export class InputManager implements MenuDeviceProvider {
  private bindings: Bindings;
  private readonly keyboard: KeyboardSource;
  private readonly provider: GamepadProvider;
  private readonly storage: StorageLike | null;
  private readonly autoLoad: boolean;
  private autoLoaded = false;

  private playerCount: number;
  private player1Gamepad: boolean;
  private readonly padIndexOverride: Partial<Record<PlayerId, number>> = {};
  private readonly registered: Partial<Record<PlayerId, InputSource>> = {};

  private readonly padSources = new Map<number | 'any', GamepadSource>();
  private soloSource: FirstUsedSource | null = null;

  /** Mode d'attribution explicite (activé par le premier `assignDevice`). */
  private explicitMode = false;
  private explicit: Partial<Record<PlayerId, DeviceAssignment>> = {};
  /** Indices de manettes vus connectés au moins une fois (pour ne signaler que de VRAIES déconnexions). */
  private readonly seenPads = new Set<number>();
  private readonly padEventTarget: PadEventTarget | null;
  private padListenersAttached = false;
  private readonly disconnectListeners = new Set<PadEventListener>();
  private readonly connectListeners = new Set<PadEventListener>();

  constructor(opts: InputManagerOptions = {}) {
    this.bindings = opts.bindings ? cloneBindings(opts.bindings) : createDefaultBindings();
    this.provider = opts.gamepadProvider ?? defaultGamepadProvider;
    this.keyboard = opts.keyboard ?? new KeyboardSource(this.bindings);
    this.keyboard.setBindings(this.bindings);
    this.storage = opts.storage === undefined ? null : opts.storage;
    this.useDefaultStorage = opts.storage === undefined;
    this.autoLoad = opts.autoLoad ?? false;
    this.playerCount = clampCount(opts.playerCount ?? 1);
    this.player1Gamepad = opts.player1Gamepad ?? false;
    this.padEventTarget = opts.padEventTarget !== undefined ? opts.padEventTarget : typeof window !== 'undefined' ? window : null;
  }

  /** true quand `storage` n'a pas été injecté : `localStorage` est alors résolu paresseusement. */
  private readonly useDefaultStorage: boolean;

  private getStorage(): StorageLike | null {
    return this.useDefaultStorage ? defaultStorage() : this.storage;
  }

  // ───────────── Cycle de vie ─────────────

  /**
   * Branche l'écoute clavier (idempotent). Appelé automatiquement par `poll()` et `getMenuDevices()`,
   * mais une scène peut l'appeler explicitement. Charge aussi les bindings sauvegardés si `autoLoad`.
   */
  attach(): void {
    if (this.autoLoad && !this.autoLoaded) {
      this.autoLoaded = true;
      this.loadBindings();
    }
    this.keyboard.attach();
    this.attachPadEvents();
  }

  /** Débranche l'écoute clavier et vide l'état des touches. */
  detach(): void {
    this.keyboard.detach();
    this.detachPadEvents();
  }

  private readonly onPadConnected = (ev: { gamepad?: { index: number; id: string } }): void => {
    const g = ev?.gamepad;
    if (!g) return;
    this.seenPads.add(g.index);
    this.emitPad(this.connectListeners, g.index, g.id);
  };

  private readonly onPadDisconnected = (ev: { gamepad?: { index: number; id: string } }): void => {
    const g = ev?.gamepad;
    if (!g) return;
    this.emitPad(this.disconnectListeners, g.index, g.id);
  };

  private emitPad(listeners: Set<PadEventListener>, index: number, name: string): void {
    if (listeners.size === 0) return;
    const e: PadEvent = { index, name, playerId: this.playerOfPad(index) };
    for (const l of Array.from(listeners)) {
      try {
        l(e);
      } catch {
        /* un écouteur défaillant ne doit pas casser les autres */
      }
    }
  }

  private attachPadEvents(): void {
    if (this.padListenersAttached || !this.padEventTarget) return;
    this.padListenersAttached = true;
    this.padEventTarget.addEventListener('gamepadconnected', this.onPadConnected);
    this.padEventTarget.addEventListener('gamepaddisconnected', this.onPadDisconnected);
  }

  private detachPadEvents(): void {
    if (!this.padListenersAttached || !this.padEventTarget) return;
    this.padListenersAttached = false;
    this.padEventTarget.removeEventListener('gamepadconnected', this.onPadConnected);
    this.padEventTarget.removeEventListener('gamepaddisconnected', this.onPadDisconnected);
  }

  /**
   * Écoute les débranchements de manette (événement navigateur `gamepaddisconnected`). Retourne la fonction de
   * désabonnement. `e.playerId` = joueur actif auquel la manette était attribuée (null sinon).
   */
  onDisconnect(cb: PadEventListener): () => void {
    this.disconnectListeners.add(cb);
    this.attach();
    return () => {
      this.disconnectListeners.delete(cb);
    };
  }

  /** Écoute les branchements de manette (`gamepadconnected`). Retourne la fonction de désabonnement. */
  onConnect(cb: PadEventListener): () => void {
    this.connectListeners.add(cb);
    this.attach();
    return () => {
      this.connectListeners.delete(cb);
    };
  }

  /** Mémorise les manettes actuellement connectées (base de `getDisconnectedPlayers`). */
  private refreshSeenPads(): void {
    for (const g of listGamepads(this.provider)) this.seenPads.add(g.index);
  }

  /**
   * Joueurs ACTIFS dont la manette attribuée a été vue connectée puis a disparu (déconnexion, batterie vide).
   * Une manette jamais détectée n'est PAS signalée (démarrage rapide sans manette). Vide si tout va bien.
   * Sert à la pause « manette déconnectée » de GameScene ; la reprise est automatique à la reconnexion
   * (le joueur sort de la liste dès que la manette réapparaît à son indice).
   */
  getDisconnectedPlayers(): PlayerId[] {
    this.refreshSeenPads();
    const out: PlayerId[] = [];
    for (let i = 0; i < this.playerCount; i++) {
      const playerId = i as PlayerId;
      const src = this.sourceFor(playerId);
      if (src instanceof GamepadSource) {
        const idx = src.getIndex();
        if (idx !== 'any' && this.seenPads.has(idx) && !src.connected()) out.push(playerId);
      }
    }
    return out;
  }

  /** Vide les états internes (touches tenues, sources enregistrées qui supportent `reset`). */
  reset(): void {
    this.keyboard.reset();
    this.soloSource?.reset();
    for (const id of ALL_PLAYER_IDS) this.registered[id]?.reset?.();
  }

  // ───────────── Configuration des joueurs ─────────────

  /** Définit le nombre de joueurs actifs (borné à 1..4) et ré-attribue les sources. */
  setPlayerCount(n: number): void {
    this.playerCount = clampCount(n);
  }

  getPlayerCount(): number {
    return this.playerCount;
  }

  /** Option « J1 = manette » : J1..J4 = manettes 0..3, plus de clavier. */
  setPlayer1Gamepad(enabled: boolean): void {
    this.player1Gamepad = enabled;
  }

  getPlayer1Gamepad(): boolean {
    return this.player1Gamepad;
  }

  /**
   * Force l'indice (navigateur) de la manette d'un joueur, ou `null` pour revenir à l'attribution par défaut.
   * Un joueur 0 auquel on force un indice n'utilise plus le clavier.
   */
  setGamepadIndex(playerId: PlayerId, index: number | null): void {
    if (index === null) delete this.padIndexOverride[playerId];
    else this.padIndexOverride[playerId] = index;
  }

  /**
   * Branche une source personnalisée (tactile, réseau…) pour un joueur ; elle remplace l'attribution par défaut.
   * Le joueur est interrogé via `source.poll()` seulement si `source.connected()`.
   */
  registerSource(playerId: PlayerId, source: InputSource): void {
    this.registered[playerId] = source;
  }

  /** Retire la source enregistrée d'un joueur (retour à l'attribution par défaut). */
  unregisterSource(playerId: PlayerId): void {
    delete this.registered[playerId];
  }

  getRegisteredSource(playerId: PlayerId): InputSource | null {
    return this.registered[playerId] ?? null;
  }

  // ───────────── Attribution explicite (rejoindre par bouton) ─────────────

  /**
   * Assigne un appareil à un emplacement de joueur et ACTIVE le mode explicite (voir l'en-tête du fichier).
   * - `{kind:'keyboard'}` : le clavier (un seul joueur à la fois : il est retiré de son ancien propriétaire) ;
   * - `{kind:'gamepad', index}` : la manette d'indice navigateur `index` (retirée de son ancien propriétaire) ;
   * - `null` : libère l'emplacement (le joueur ne reçoit plus aucune entrée).
   * Fonctionne à 1..4 joueurs ; les 4 manettes peuvent être actives simultanément. Une manette débranchée puis
   * rebranchée au même indice reprend son joueur sans nouvelle attribution. Indice invalide : ignoré.
   */
  assignDevice(playerId: PlayerId, device: DeviceAssignment | null): void {
    if (!ALL_PLAYER_IDS.includes(playerId)) return;
    if (device !== null) {
      if (device.kind === 'gamepad' && !(Number.isInteger(device.index) && device.index >= 0)) return;
      for (const other of ALL_PLAYER_IDS) {
        const d = this.explicit[other];
        if (other === playerId || !d) continue;
        if (d.kind === 'keyboard' ? device.kind === 'keyboard' : device.kind === 'gamepad' && d.index === device.index) {
          delete this.explicit[other];
        }
      }
    }
    this.explicitMode = true;
    if (device === null) delete this.explicit[playerId];
    else this.explicit[playerId] = device.kind === 'keyboard' ? { kind: 'keyboard' } : { kind: 'gamepad', index: device.index };
  }

  /** Quitte le mode explicite : retour aux attributions par défaut (J1 clavier, J2..J4 manettes 0..2…). */
  clearAssignments(): void {
    this.explicit = {};
    this.explicitMode = false;
  }

  /** true si le mode d'attribution explicite est actif. */
  isExplicitMode(): boolean {
    return this.explicitMode;
  }

  /** Appareil explicitement assigné à un joueur (copie), ou null (aucun / mode par défaut). */
  getAssignedDevice(playerId: PlayerId): DeviceAssignment | null {
    const d = this.explicit[playerId];
    return d ? { ...d } : null;
  }

  /** Joueur ACTIF auquel appartient la manette d'indice `index` (null si aucun). */
  private playerOfPad(index: number): PlayerId | null {
    if (this.explicitMode) {
      for (let i = 0; i < this.playerCount; i++) {
        const d = this.explicit[i as PlayerId];
        if (d && d.kind === 'gamepad' && d.index === index) return i as PlayerId;
      }
      return null;
    }
    if (this.isSoloMode()) return null;
    for (let i = 0; i < this.playerCount; i++) {
      const p = i as PlayerId;
      if (!this.registered[p] && this.padIndexFor(p) === index) return p;
    }
    return null;
  }

  // ───────────── Attribution ─────────────

  private isSoloMode(): boolean {
    return (
      !this.explicitMode &&
      this.playerCount === 1 &&
      !this.player1Gamepad &&
      this.padIndexOverride[0] === undefined &&
      this.registered[0] === undefined
    );
  }

  /** Indice de manette attribué à un joueur (hors mode solo), ou null s'il utilise le clavier. */
  private padIndexFor(playerId: PlayerId): number | null {
    const forced = this.padIndexOverride[playerId];
    if (forced !== undefined) return forced;
    if (this.player1Gamepad) return playerId;
    return playerId === 0 ? null : playerId - 1;
  }

  private padSource(index: number | 'any'): GamepadSource {
    let s = this.padSources.get(index);
    if (!s) {
      s = new GamepadSource({ index, bindings: this.bindings, provider: this.provider });
      this.padSources.set(index, s);
    }
    return s;
  }

  private sourceFor(playerId: PlayerId): InputSource | null {
    const reg = this.registered[playerId];
    if (reg) return reg;
    if (this.explicitMode) {
      const d = this.explicit[playerId];
      if (!d) return null;
      return d.kind === 'keyboard' ? this.keyboard : this.padSource(d.index);
    }
    if (playerId === 0 && this.isSoloMode()) {
      if (!this.soloSource) this.soloSource = new FirstUsedSource(this.keyboard, this.padSource('any'));
      return this.soloSource;
    }
    const idx = this.padIndexFor(playerId);
    return idx === null ? this.keyboard : this.padSource(idx);
  }

  /**
   * Attribution courante des entrées pour les joueurs ACTIFS (`playerCount`), pour l'écran de sélection :
   * quelle entrée contrôle quel joueur, et la manette est-elle détectée ?
   */
  getAssignments(): PlayerAssignment[] {
    const out: PlayerAssignment[] = [];
    for (let i = 0; i < this.playerCount; i++) {
      const playerId = i as PlayerId;
      const src = this.sourceFor(playerId);
      if (!src) {
        out.push({ playerId, label: 'keyboard', connected: false, assigned: false });
        continue;
      }
      let pad: GamepadLike | null = null;
      let anyDevice = false;
      if (src instanceof FirstUsedSource) {
        anyDevice = true;
        pad = this.padSource('any').resolve();
      } else if (src instanceof GamepadSource) {
        pad = src.resolve();
      }
      const a: PlayerAssignment = { playerId, label: src.kind, connected: src.connected(), assigned: true };
      if (src.kind === 'gamepad' && pad) {
        a.gamepadIndex = pad.index;
        a.gamepadName = pad.id;
        if (isNonStandardPad(pad)) a.nonStandard = true;
      }
      const dev = this.explicit[playerId];
      if (this.explicitMode && dev) a.device = { ...dev };
      if (anyDevice) a.anyDevice = true;
      out.push(a);
    }
    return out;
  }

  // ───────────── Poll ─────────────

  /**
   * Lit les entrées de chaque joueur ACTIF (1..playerCount). Un joueur sans source connectée
   * (manette débranchée) reçoit une frame vide : la clé est toujours présente pour les joueurs actifs.
   */
  poll(): TickInputs {
    this.attach();
    this.refreshSeenPads();
    const out: TickInputs = {};
    for (let i = 0; i < this.playerCount; i++) {
      const playerId = i as PlayerId;
      const src = this.sourceFor(playerId);
      out[playerId] = src && src.connected() ? src.poll() : emptyFrame();
    }
    return out;
  }

  // ───────────── Menus ─────────────

  /**
   * Périphériques de menu avec leur état « tenu », pour `MenuNavigator`. Le clavier est rattaché à J1
   * (null si J1 utilise une manette) ; chaque manette connectée est rattachée au joueur auquel elle correspond
   * (en solo, la première manette connectée = J1). ATTENTION : l'appel vide le tampon d'appuis courts du clavier
   * (un seul `MenuNavigator` actif à la fois).
   */
  getMenuDevices(): MenuDevice[] {
    this.attach();
    const devices: MenuDevice[] = [];
    let kbPlayer: PlayerId | null;
    if (this.explicitMode) {
      kbPlayer = null;
      for (let i = 0; i < this.playerCount; i++) {
        if (this.explicit[i as PlayerId]?.kind === 'keyboard') kbPlayer = i as PlayerId;
      }
    } else {
      kbPlayer = this.player1Gamepad || this.padIndexOverride[0] !== undefined || this.registered[0] ? null : 0;
    }
    devices.push({ id: 'keyboard', playerId: kbPlayer, held: keysToMenuHeld(this.keyboard.drainTapped(), this.bindings) });

    const pads = listGamepads(this.provider);
    for (const pad of pads) this.seenPads.add(pad.index);
    const solo = this.isSoloMode();
    pads.forEach((pad, order) => {
      let playerId: PlayerId | null = null;
      if (this.explicitMode) {
        playerId = this.playerOfPad(pad.index);
      } else if (solo) {
        playerId = order === 0 ? 0 : null;
      } else {
        for (const p of ALL_PLAYER_IDS) {
          if (this.registered[p]) continue;
          if (this.padIndexFor(p) === pad.index) {
            playerId = p;
            break;
          }
        }
      }
      devices.push({ id: `gamepad:${pad.index}`, playerId, held: gamepadToMenuHeld(pad, this.bindings) });
    });
    return devices;
  }

  // ───────────── Bindings ─────────────

  /** Copie des bindings courants (modifier la copie n'a aucun effet : utiliser `setBindings`). */
  getBindings(): Bindings {
    return cloneBindings(this.bindings);
  }

  /**
   * Remplace les bindings (copie profonde) SI ils sont valides ; sinon aucun changement.
   * Retourne le résultat de `validateBindings`.
   */
  setBindings(next: Bindings): BindingsValidation {
    const v = validateBindings(next);
    if (v.valid) this.applyBindings(cloneBindings(next));
    return v;
  }

  /**
   * Fusionne des surcharges partielles sur les bindings COURANTS puis valide ; applique seulement si valide.
   * Retourne le résultat de `validateBindings` sur la fusion.
   */
  updateBindings(overrides: BindingsOverrides): BindingsValidation {
    const merged = mergeBindings(this.bindings, overrides);
    const v = validateBindings(merged);
    if (v.valid) this.applyBindings(merged);
    return v;
  }

  /** Revient aux bindings par défaut (en mémoire ; appeler `saveBindings()` pour persister). */
  resetBindings(): void {
    this.applyBindings(createDefaultBindings());
  }

  private applyBindings(b: Bindings): void {
    this.bindings = b;
    this.keyboard.setBindings(b);
    for (const s of this.padSources.values()) s.setBindings(b);
  }

  /**
   * Charge les bindings sauvegardés (localStorage, try/catch). Les valeurs sont fusionnées sur les défauts
   * puis validées ; un contenu absent, illisible ou invalide est ignoré. Retourne true si des bindings ont été appliqués.
   */
  loadBindings(): boolean {
    try {
      const storage = this.getStorage();
      if (!storage) return false;
      const raw = storage.getItem(BINDINGS_STORAGE_KEY);
      if (!raw) return false;
      const merged = mergeBindings(createDefaultBindings(), JSON.parse(raw) as BindingsOverrides);
      if (!validateBindings(merged).valid) return false;
      this.applyBindings(merged);
      return true;
    } catch {
      return false;
    }
  }

  /** Sauvegarde les bindings courants (localStorage, try/catch). Retourne true en cas de succès. */
  saveBindings(): boolean {
    try {
      const storage = this.getStorage();
      if (!storage) return false;
      storage.setItem(BINDINGS_STORAGE_KEY, JSON.stringify(this.bindings));
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Singleton de l'application (clavier sur `window`, manettes via `navigator.getGamepads()`,
 * bindings sauvegardés chargés automatiquement au premier `attach()`/`poll()`).
 */
export const inputManager = new InputManager({ autoLoad: true });
