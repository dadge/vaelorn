/**
 * Source manette : lit `navigator.getGamepads()` à CHAQUE poll (les objets Gamepad sont des instantanés).
 * Aucun accès à `navigator` à l'import : le module est importable sous Node.
 */
import type { ActionFrame } from '../core/types';
import type { Bindings, InputSource } from './actions';
import { createDefaultBindings } from './defaultBindings';
import { emptyFrame, gamepadToFrame, isNonStandardPad } from './mapping';
import type { GamepadSnapshot } from './mapping';

/** Manette minimale (compatible avec l'objet `Gamepad` du navigateur). */
export interface GamepadLike extends GamepadSnapshot {
  readonly index: number;
  readonly id: string;
  /** `undefined` est traité comme connectée. */
  readonly connected?: boolean;
}

/** Fournit la liste (éventuellement creuse : `null` pour les emplacements vides) des manettes. */
export type GamepadProvider = () => ArrayLike<GamepadLike | null | undefined>;

/** Fournisseur par défaut : `navigator.getGamepads()` protégé (Node, contexte non sécurisé, erreurs). */
export const defaultGamepadProvider: GamepadProvider = () => {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function') {
      return navigator.getGamepads() as unknown as ArrayLike<GamepadLike | null>;
    }
  } catch {
    /* SecurityError (Permissions-Policy) ou API absente : aucune manette */
  }
  return [];
};

/** Liste des manettes connectées, triées par indice. Ne lève jamais. */
export function listGamepads(provider: GamepadProvider = defaultGamepadProvider): GamepadLike[] {
  let raw: ArrayLike<GamepadLike | null | undefined>;
  try {
    raw = provider();
  } catch {
    return [];
  }
  const out: GamepadLike[] = [];
  for (let i = 0; i < raw.length; i++) {
    const g = raw[i];
    if (g && g.connected !== false) out.push(g);
  }
  return out.sort((a, b) => a.index - b.index);
}

/** Manette à l'indice `index` (indice du navigateur), ou null si absente/déconnectée. */
export function getGamepadAt(index: number, provider: GamepadProvider = defaultGamepadProvider): GamepadLike | null {
  for (const g of listGamepads(provider)) if (g.index === index) return g;
  return null;
}

export interface GamepadSourceOptions {
  /** Indice de la manette ciblée, ou 'any' = la première manette connectée (mode solo). */
  index: number | 'any';
  bindings?: Bindings;
  provider?: GamepadProvider;
}

/** Source manette d'un joueur. L'indice est configurable (`setIndex`). */
export class GamepadSource implements InputSource {
  readonly kind = 'gamepad' as const;

  private index: number | 'any';
  private bindings: Bindings;
  private readonly provider: GamepadProvider;

  constructor(opts: GamepadSourceOptions) {
    this.index = opts.index;
    this.bindings = opts.bindings ?? createDefaultBindings();
    this.provider = opts.provider ?? defaultGamepadProvider;
  }

  get id(): string {
    return `gamepad:${this.index}`;
  }

  getIndex(): number | 'any' {
    return this.index;
  }

  setIndex(index: number | 'any'): void {
    this.index = index;
  }

  setBindings(bindings: Bindings): void {
    this.bindings = bindings;
  }

  /** Manette actuellement ciblée (instantané frais), ou null. */
  resolve(): GamepadLike | null {
    if (this.index === 'any') return listGamepads(this.provider)[0] ?? null;
    return getGamepadAt(this.index, this.provider);
  }

  connected(): boolean {
    return this.resolve() !== null;
  }

  /** true si la manette ciblée est connectée mais n'a pas le mapping standard (mappage de repli utilisé). */
  isNonStandard(): boolean {
    const pad = this.resolve();
    return pad !== null && isNonStandardPad(pad);
  }

  /** Identifiant fourni par le navigateur (ex. « Xbox 360 Controller… »), ou null si non connectée. */
  getName(): string | null {
    return this.resolve()?.id ?? null;
  }

  poll(): ActionFrame {
    const pad = this.resolve();
    return pad ? gamepadToFrame(pad, this.bindings) : emptyFrame();
  }

  reset(): void {
    /* aucun état interne : tout est relu à chaque poll */
  }
}
