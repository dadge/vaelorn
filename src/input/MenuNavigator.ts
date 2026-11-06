/**
 * Navigation de menu : transforme l'état « tenu » des périphériques en intentions discrètes
 * (front montant unique + répétition automatique des directions maintenues).
 *
 * La logique d'édge/répétition (`EdgeRepeater`) est pure et testable avec un temps injecté.
 */
import type { MenuAction, MenuDeviceProvider, MenuIntent } from './actions';
import { inputManager } from './InputManager';

/** Délai (ms) avant la première répétition d'une direction maintenue. */
export const MENU_REPEAT_DELAY_MS = 380;
/** Intervalle (ms) entre deux répétitions. */
export const MENU_REPEAT_INTERVAL_MS = 110;

const REPEATABLE: ReadonlySet<MenuAction> = new Set<MenuAction>(['up', 'down', 'left', 'right']);

interface HoldState {
  nextAt: number;
  /** Maintenu depuis avant `suppress()` : ne déclenche rien tant qu'il n'a pas été relâché. */
  suppressed: boolean;
}

/**
 * Détecteur de fronts montants avec répétition, pour UN périphérique.
 * - Une action nouvellement tenue se déclenche immédiatement (une seule fois).
 * - Si elle est `repeatable` et reste tenue, elle se redéclenche après `initialDelayMs`, puis toutes les `repeatMs`
 *   (au plus une répétition par `update`, même après une longue pause de frames).
 * - Relâcher réinitialise.
 */
export class EdgeRepeater<K> {
  private readonly state = new Map<K, HoldState>();

  constructor(
    private readonly initialDelayMs: number = MENU_REPEAT_DELAY_MS,
    private readonly repeatMs: number = MENU_REPEAT_INTERVAL_MS,
    private readonly repeatable: (key: K) => boolean = () => true,
  ) {}

  /** Fournit l'ensemble tenu à l'instant `nowMs` ; retourne les actions déclenchées (ordre d'itération de `held`). */
  update(held: ReadonlySet<K>, nowMs: number): K[] {
    const fired: K[] = [];
    for (const key of this.state.keys()) {
      if (!held.has(key)) this.state.delete(key);
    }
    for (const key of held) {
      const s = this.state.get(key);
      if (!s) {
        fired.push(key);
        this.state.set(key, { nextAt: nowMs + this.initialDelayMs, suppressed: false });
      } else if (!s.suppressed && this.repeatable(key) && nowMs >= s.nextAt) {
        fired.push(key);
        s.nextAt = nowMs + this.repeatMs;
      }
    }
    return fired;
  }

  /** Marque ce qui est tenu MAINTENANT comme « déjà tenu » : rien ne se déclenche avant relâchement. */
  suppress(held: ReadonlySet<K>): void {
    this.state.clear();
    for (const key of held) this.state.set(key, { nextAt: Infinity, suppressed: true });
  }

  clear(): void {
    this.state.clear();
  }
}

export interface MenuNavigatorOptions {
  initialDelayMs?: number;
  repeatMs?: number;
  /**
   * Si true (défaut), les touches déjà tenues à la création/`reset()` (ex. Entrée qui a servi à lancer la scène)
   * ne déclenchent rien tant qu'elles ne sont pas relâchées.
   */
  suppressHeld?: boolean;
}

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

/**
 * Navigateur de menu. Une instance par scène de menu : `const nav = new MenuNavigator();` puis, à chaque `update`,
 * `for (const i of nav.pollMenu()) …`. Clavier : flèches/WASD, Entrée/Espace = confirmer, Échap = retour ;
 * manettes : croix + stick, A = confirmer, B = retour. Chaque intention porte le `playerId` auquel le périphérique
 * est rattaché dans l'InputManager (null si aucun) et l'identifiant du périphérique.
 */
export class MenuNavigator {
  private readonly repeaters = new Map<string, EdgeRepeater<MenuAction>>();
  private readonly opts: Required<MenuNavigatorOptions>;

  /**
   * @param provider fournisseur de périphériques (défaut : le singleton `inputManager`)
   */
  constructor(
    private readonly provider: MenuDeviceProvider = inputManager,
    opts: MenuNavigatorOptions = {},
  ) {
    this.opts = {
      initialDelayMs: opts.initialDelayMs ?? MENU_REPEAT_DELAY_MS,
      repeatMs: opts.repeatMs ?? MENU_REPEAT_INTERVAL_MS,
      suppressHeld: opts.suppressHeld ?? true,
    };
    this.reset();
  }

  private repeaterFor(id: string): EdgeRepeater<MenuAction> {
    let r = this.repeaters.get(id);
    if (!r) {
      r = new EdgeRepeater<MenuAction>(this.opts.initialDelayMs, this.opts.repeatMs, (a) => REPEATABLE.has(a));
      this.repeaters.set(id, r);
    }
    return r;
  }

  /** Oublie tout l'état ; si `suppressHeld`, ignore ce qui est tenu en ce moment jusqu'au relâchement. */
  reset(): void {
    this.repeaters.clear();
    const devices = this.provider.getMenuDevices();
    if (!this.opts.suppressHeld) return;
    for (const d of devices) this.repeaterFor(d.id).suppress(d.held);
  }

  /**
   * Retourne les intentions déclenchées depuis le dernier appel (fronts montants + répétitions).
   * @param now temps courant en ms (monotone) ; défaut `performance.now()` — injectable pour les tests.
   */
  pollMenu(now: number = nowMs()): MenuIntent[] {
    const devices = this.provider.getMenuDevices();
    const intents: MenuIntent[] = [];
    const seen = new Set<string>();
    for (const d of devices) {
      seen.add(d.id);
      for (const action of this.repeaterFor(d.id).update(d.held, now)) {
        intents.push({ playerId: d.playerId, source: d.id, action });
      }
    }
    for (const id of Array.from(this.repeaters.keys())) {
      if (!seen.has(id)) this.repeaters.delete(id);
    }
    return intents;
  }
}
