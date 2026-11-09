/**
 * Détection d'ACTIVITÉ du joueur pour le mode démo : clavier, souris / pointeur / toucher / molette, boutons et sticks de
 * manette (y compris la manette virtuelle tactile, vue comme une manette d'indice `VIRTUAL_PAD_INDEX`).
 *
 * Deux briques :
 *  - `PadActivityDetector` : PUR, testé sous Node. Compare chaque instantané de manette à une référence (état au premier
 *    sondage) : un bouton nouvellement appuyé, ou un axe qui s'écarte de plus de `AXIS_ACTIVITY_THRESHOLD` de sa valeur de
 *    repos, est une activité. Un bouton déjà tenu au premier sondage est ignoré jusqu'à son relâchement (même principe que
 *    `MenuNavigator` : la touche qui vient de lancer la scène ne compte pas), et une dérive de stick sous la zone morte aussi.
 *  - `ActivityWatcher` : fine couche DOM (écouteurs sur `window`, cible injectable pour les tests) ; `poll()` retourne true si
 *    une activité a eu lieu depuis le dernier appel.
 *
 * Aucun `Math.random` / `Date.now`. Ne lève jamais.
 */
import { isPadButtonDown, type GamepadSnapshot } from '../input/mapping';
import { listGamepads, type GamepadLike, type GamepadProvider } from '../input/GamepadSource';

/** Écart minimal (0..1) d'un axe par rapport à sa valeur de repos pour compter comme activité (≈ zone morte par défaut des sticks). */
export const AXIS_ACTIVITY_THRESHOLD = 0.3;

/**
 * Nombre de sondages consécutifs « stables » (axe immobile à `AXIS_STABLE_EPSILON` près) au bout desquels une valeur d'axe écartée
 * de la référence devient la NOUVELLE référence de repos. Sans cela, un stick tenu au premier sondage (figé comme « repos ») puis
 * relâché serait vu comme une activité permanente (écart de repos ≥ seuil à chaque sondage) et la minuterie ne repartirait jamais.
 * À ~60 sondages/s, 30 ≈ 0,5 s : le joueur qui relâche un stick compte comme actif ce temps-là, puis la référence se recale.
 */
export const AXIS_REANCHOR_POLLS = 30;

/** Variation maximale (0..1) d'un axe entre deux sondages pour le considérer immobile (ré-ancrage de la référence). */
export const AXIS_STABLE_EPSILON = 0.05;

/** Déplacement minimal (px) du pointeur depuis sa dernière position de référence pour compter comme activité (ignore le tremblement). */
export const POINTER_MOVE_THRESHOLD_PX = 6;

/** Détecteur d'activité de manettes (état par indice de manette). */
export class PadActivityDetector {
  /** Boutons appuyés au sondage précédent, par indice de manette. */
  private readonly held = new Map<number, Set<number>>();
  /** Valeurs de repos des axes, par indice de manette. */
  private readonly rest = new Map<number, number[]>();
  /** Dernières valeurs d'axes et nombre de sondages consécutifs immobiles (hors repos), par indice de manette. */
  private readonly last = new Map<number, number[]>();
  private readonly still = new Map<number, number[]>();

  /**
   * Examine les manettes connectées. Retourne true si au moins une a un bouton nouvellement appuyé ou un axe écarté de son
   * repos. Le premier sondage d'une manette ne fait que mémoriser son état (retourne false pour elle).
   */
  check(pads: readonly (GamepadSnapshot & { index: number })[]): boolean {
    let active = false;
    const seen = new Set<number>();
    for (const pad of pads) {
      seen.add(pad.index);
      const pressed = new Set<number>();
      for (let i = 0; i < pad.buttons.length; i++) if (isPadButtonDown(pad, i)) pressed.add(i);
      const axes = pad.axes.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0));
      const prevHeld = this.held.get(pad.index);
      const prevRest = this.rest.get(pad.index);
      if (!prevHeld || !prevRest) {
        // première observation : référence seulement
        this.held.set(pad.index, pressed);
        this.rest.set(pad.index, axes);
        this.last.set(pad.index, axes.slice());
        this.still.set(pad.index, axes.map(() => 0));
        continue;
      }
      for (const b of pressed) if (!prevHeld.has(b)) active = true;
      const prevLast = this.last.get(pad.index) ?? axes;
      const still = this.still.get(pad.index) ?? axes.map(() => 0);
      for (let i = 0; i < axes.length; i++) {
        const base = prevRest[i] ?? 0;
        if (Math.abs(axes[i] - base) >= AXIS_ACTIVITY_THRESHOLD) {
          // écarté du repos : activité, sauf si l'axe est immobile depuis assez longtemps (stick tenu / relâché après coup) :
          // la valeur devient alors la nouvelle référence de repos
          const motionless = Math.abs(axes[i] - (prevLast[i] ?? axes[i])) < AXIS_STABLE_EPSILON;
          still[i] = motionless ? (still[i] ?? 0) + 1 : 0;
          if (still[i] >= AXIS_REANCHOR_POLLS) {
            prevRest[i] = axes[i];
            still[i] = 0;
          } else {
            active = true;
          }
        } else {
          still[i] = 0;
        }
      }
      this.last.set(pad.index, axes.slice());
      this.still.set(pad.index, still);
      this.held.set(pad.index, pressed);
    }
    for (const idx of Array.from(this.held.keys())) {
      if (!seen.has(idx)) {
        this.held.delete(idx);
        this.rest.delete(idx);
        this.last.delete(idx);
        this.still.delete(idx);
      }
    }
    return active;
  }

  /** Oublie toutes les références (le prochain sondage de chaque manette redevient une simple observation). */
  reset(): void {
    this.held.clear();
    this.rest.clear();
    this.last.clear();
    this.still.clear();
  }
}

/** Cible d'événements minimale (compatible `window`). */
export interface ActivityTarget {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addEventListener(type: string, listener: (ev: any) => void, options?: any): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  removeEventListener(type: string, listener: (ev: any) => void, options?: any): void;
}

export interface ActivityWatcherOptions {
  /** Cible des événements (défaut : `window` s'il existe, sinon aucune : seules les manettes sont sondées). */
  target?: ActivityTarget | null;
  /** Fournisseur de manettes (défaut : `defaultGamepadProvider` via `listGamepads`). */
  gamepads?: GamepadProvider;
}

/** Événements qui comptent TOUJOURS comme une activité. */
const DISCRETE_EVENTS = ['keydown', 'mousedown', 'pointerdown', 'touchstart', 'wheel'] as const;
/** Événements de déplacement : comptent au-delà de `POINTER_MOVE_THRESHOLD_PX`. */
const MOVE_EVENTS = ['pointermove', 'mousemove'] as const;

interface PointerLike {
  clientX?: number;
  clientY?: number;
}

/**
 * Surveillant d'activité : écouteurs DOM + sondage des manettes. `start()` branche, `stop()` débranche (idempotents).
 * `poll()` : true s'il y a eu une activité depuis le dernier `poll()`.
 */
export class ActivityWatcher {
  private readonly target: ActivityTarget | null;
  private readonly provider: GamepadProvider | undefined;
  private readonly pads = new PadActivityDetector();
  private started = false;
  private flagged = false;
  private anchor: { x: number; y: number } | null = null;

  constructor(opts: ActivityWatcherOptions = {}) {
    this.target = opts.target !== undefined ? opts.target : typeof window !== 'undefined' ? window : null;
    this.provider = opts.gamepads;
  }

  private readonly onDiscrete = (): void => {
    this.flagged = true;
  };

  private readonly onMove = (ev: PointerLike): void => {
    const x = ev.clientX;
    const y = ev.clientY;
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
      this.flagged = true;
      return;
    }
    if (!this.anchor) {
      // première position vue : simple référence (un mouvement « fantôme » du navigateur après un changement de scène ne compte pas)
      this.anchor = { x, y };
      return;
    }
    if (Math.hypot(x - this.anchor.x, y - this.anchor.y) >= POINTER_MOVE_THRESHOLD_PX) {
      this.anchor = { x, y };
      this.flagged = true;
    }
  };

  start(): void {
    if (this.started) return;
    this.started = true;
    this.flagged = false;
    this.anchor = null;
    this.pads.reset();
    const t = this.target;
    if (!t) return;
    for (const type of DISCRETE_EVENTS) t.addEventListener(type, this.onDiscrete, { capture: true, passive: true });
    for (const type of MOVE_EVENTS) t.addEventListener(type, this.onMove, { capture: true, passive: true });
    // première observation des manettes : référence (ne compte pas comme activité)
    this.pads.check(this.readPads());
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    const t = this.target;
    if (t) {
      for (const type of DISCRETE_EVENTS) t.removeEventListener(type, this.onDiscrete, { capture: true });
      for (const type of MOVE_EVENTS) t.removeEventListener(type, this.onMove, { capture: true });
    }
    this.flagged = false;
    this.anchor = null;
    this.pads.reset();
  }

  get isStarted(): boolean {
    return this.started;
  }

  private readPads(): GamepadLike[] {
    return this.provider ? listGamepads(this.provider) : listGamepads();
  }

  /** Marque une activité venue d'ailleurs (changement de langue…). */
  notify(): void {
    this.flagged = true;
  }

  /** true si une activité a eu lieu depuis le dernier appel (événements DOM ou manettes). */
  poll(): boolean {
    if (!this.started) return false;
    const padActive = this.pads.check(this.readPads());
    const active = this.flagged || padActive;
    this.flagged = false;
    return active;
  }
}

// ───────────── Activité « transportée » d'une scène à l'autre ─────────────

let carried = false;

/**
 * Le menu continue de surveiller le joueur pendant le fondu vers la démo : une action pendant ce fondu serait sinon perdue (la démo
 * démarrerait comme si de rien n'était). Il la dépose ici ; la démo la reprend à son démarrage et s'arrête aussitôt.
 */
export function carryActivity(): void {
  carried = true;
}

/** Lit et efface l'activité transportée. */
export function takeCarriedActivity(): boolean {
  const v = carried;
  carried = false;
  return v;
}
