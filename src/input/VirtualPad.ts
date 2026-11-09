/**
 * Manette VIRTUELLE tactile : logique PURE (aucun accès au DOM, testable sous Node).
 *
 * Principe : la couche DOM (`src/mobile/touchControls.ts`) traduit les doigts en appels à cet objet ; celui-ci
 * expose l'état sous la forme d'une manette STANDARD (`GamepadLike`, indice `VIRTUAL_PAD_INDEX`) que le code
 * d'entrées (`InputManager`, `MenuNavigator`, écran « rejoindre », pause…) lit comme n'importe quelle vraie manette,
 * via le registre `registerExtraGamepad` de `GamepadSource.ts`. Aucune règle de jeu ici.
 *
 *  - un POINTEUR (un doigt) pilote au plus UN contrôle (le stick OU un bouton) ;
 *  - plusieurs doigts simultanés = plusieurs contrôles (stick + boutons) ;
 *  - déconnectée (`setConnected(false)`) : tous les appuis sont remis à zéro et ignorés (pas de touche « collée »).
 */
import { PAD_BUTTON } from './defaultBindings';
import type { GamepadLike } from './GamepadSource';

/**
 * Indice (navigateur) de la manette virtuelle : hors de la plage 0..3 des vraies manettes, pour ne jamais
 * entrer en conflit avec elles (les navigateurs exposent au plus 4 emplacements).
 */
export const VIRTUAL_PAD_INDEX = 4;
// Hypothèse documentée : l'API Gamepad des navigateurs expose au plus 4 emplacements (indices 0..3) ; une vraie manette
// d'indice >= 4 (non atteignable avec Chrome/Firefox/Safari) entrerait en conflit avec la manette virtuelle.

/** Nombre de boutons du mapping standard. */
export const VIRTUAL_PAD_BUTTON_COUNT = 16;

/** Contrôles à bouton de la manette virtuelle. */
export type VirtualButton = 'a' | 'b' | 'y' | 'call' | 'pause';

export const VIRTUAL_BUTTONS: readonly VirtualButton[] = ['a', 'b', 'y', 'call', 'pause'];

/**
 * Bouton du mapping standard de chaque contrôle (A=0 B=1 Y=3 ; appel = LB=4 ; pause = Start=9). Pas de bouton X virtuel : sur
 * tactile, A fait déjà l'attaque contextuelle ; le losange A / B / Y + appel (à la place du X) tient en 4 boutons.
 */
export const VIRTUAL_BUTTON_INDEX: Readonly<Record<VirtualButton, number>> = {
  a: PAD_BUTTON.A,
  b: PAD_BUTTON.B,
  y: PAD_BUTTON.Y,
  call: PAD_BUTTON.LB,
  pause: PAD_BUTTON.START,
};

/**
 * Zone morte du stick virtuel (fraction du rayon). Volontairement très faible : la zone morte de la manette (0,25,
 * `bindings.deadzone`) s'applique ensuite en aval ; les cumuler rognerait la précision du déplacement fin sur un petit écran.
 */
export const STICK_DEAD_ZONE = 0.03;

/** Identifiant technique de repli (jamais affiché : l'interface passe toujours le libellé traduit `touch.padName`). */
const DEFAULT_LABEL = 'virtual';

/** Tolérance de « glissement hors d'un bouton » : un doigt reste sur le bouton jusqu'à ce rayon (× rayon visuel). */
export const BUTTON_SLIDE_TOLERANCE = 1.35;

/** Lecture du stick : valeurs d'axes (-1..1, y négatif = haut) et position du bouton du stick (px, bornée au rayon). */
export interface StickReading {
  x: number;
  y: number;
  knobX: number;
  knobY: number;
}

const ZERO_STICK: StickReading = { x: 0, y: 0, knobX: 0, knobY: 0 };

/**
 * Convertit un décalage du doigt par rapport au centre du stick (px d'ÉCRAN : dy > 0 = vers le bas) en axes de manette.
 * Cercle unité : l'amplitude est bornée à 1 (au-delà de `radius`, on est clampé sur le cercle) ; zone morte radiale
 * `deadZone`, puis amplitude re-mappée de [deadZone, 1] vers [0, 1]. Convention gamepad : y négatif = haut
 * (cohérent avec l'écran : doigt au-dessus du centre → dy < 0 → axe y < 0). Entrées invalides : stick au repos.
 */
export function computeStick(dx: number, dy: number, radius: number, deadZone: number = STICK_DEAD_ZONE): StickReading {
  if (![dx, dy, radius].every(Number.isFinite) || radius <= 0) return { ...ZERO_STICK };
  const dist = Math.hypot(dx, dy);
  if (dist === 0) return { ...ZERO_STICK };
  const clamp = Math.min(1, radius / dist);
  const knobX = dx * clamp + 0;
  const knobY = dy * clamp + 0;
  const dz = Math.max(0, Math.min(0.95, Number.isFinite(deadZone) ? deadZone : STICK_DEAD_ZONE));
  const norm = Math.min(1, dist / radius);
  if (norm <= dz) return { x: 0, y: 0, knobX, knobY };
  const m = (norm - dz) / (1 - dz);
  return { x: (dx / dist) * m + 0, y: (dy / dist) * m + 0, knobX, knobY };
}

/** true si le point (px, py) est dans le disque de centre (cx, cy) et de rayon `r` (bord inclus). */
export function isInsideCircle(px: number, py: number, cx: number, cy: number, r: number): boolean {
  if (![px, py, cx, cy, r].every(Number.isFinite)) return false;
  return Math.hypot(px - cx, py - cy) <= r;
}

/** Instantané de la manette virtuelle (compatible `GamepadLike`, mapping standard). */
export interface VirtualPadSnapshot extends GamepadLike {
  readonly mapping: 'standard';
  readonly connected: boolean;
  readonly axes: readonly number[];
  readonly buttons: readonly { readonly pressed: boolean; readonly value: number }[];
}

/**
 * `true` si au moins une VRAIE manette (indice < `VIRTUAL_PAD_INDEX`) est connectée dans la liste du navigateur
 * (la manette virtuelle elle-même, d'indice 4, ne compte pas).
 */
export function hasRealGamepad(raw: ArrayLike<GamepadLike | null | undefined>): boolean {
  for (let i = 0; i < raw.length; i++) {
    const g = raw[i];
    if (g && g.connected !== false && g.index < VIRTUAL_PAD_INDEX) return true;
  }
  return false;
}

export interface VirtualPadOptions {
  /** Libellé (déjà traduit) exposé comme `id` de la manette. */
  label?: string;
  /** Zone morte du stick (défaut `STICK_DEAD_ZONE`). */
  deadZone?: number;
}

const PRESSED_BUTTON = Object.freeze({ pressed: true, value: 1 });
const RELEASED_BUTTON = Object.freeze({ pressed: false, value: 0 });

export class VirtualPad {
  private connected = false;
  private label: string;
  private readonly deadZone: number;
  /** Pointeur → bouton tenu. */
  private readonly holders = new Map<number, VirtualButton>();
  private stickPointer: number | null = null;
  private axisX = 0;
  private axisY = 0;
  private cache: VirtualPadSnapshot | null = null;

  constructor(opts: VirtualPadOptions = {}) {
    this.label = opts.label ?? DEFAULT_LABEL;
    this.deadZone = opts.deadZone ?? STICK_DEAD_ZONE;
  }

  /** Change le libellé (changement de langue). */
  setLabel(label: string): void {
    if (label === this.label) return;
    this.label = label;
    this.cache = null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Connecte / déconnecte la manette. Déconnecter remet TOUT à zéro. */
  setConnected(connected: boolean): void {
    if (connected === this.connected) return;
    if (!connected) this.releaseAll();
    this.connected = connected;
    this.cache = null;
  }

  // ───────────── Stick ─────────────

  /**
   * Un doigt commence à tenir le stick. `dx`/`dy` = position du doigt relative au centre (px d'écran), `radius` = rayon
   * max. Refusé (null) si la manette est déconnectée ou si un autre doigt tient déjà le stick. Un pointeur qui tenait un
   * bouton le relâche d'abord (un doigt = un contrôle).
   */
  beginStick(pointerId: number, dx: number, dy: number, radius: number): StickReading | null {
    if (!this.connected || this.stickPointer !== null) return null;
    this.releasePointer(pointerId);
    this.stickPointer = pointerId;
    return this.applyStick(dx, dy, radius);
  }

  /** Déplace le stick (ignoré, null, si ce pointeur ne le tient pas). */
  moveStick(pointerId: number, dx: number, dy: number, radius: number): StickReading | null {
    if (!this.connected || this.stickPointer !== pointerId) return null;
    return this.applyStick(dx, dy, radius);
  }

  private applyStick(dx: number, dy: number, radius: number): StickReading {
    const r = computeStick(dx, dy, radius, this.deadZone);
    if (r.x !== this.axisX || r.y !== this.axisY) {
      this.axisX = r.x;
      this.axisY = r.y;
      this.cache = null;
    }
    return r;
  }

  /** true si le stick est tenu par un doigt. */
  isStickActive(): boolean {
    return this.stickPointer !== null;
  }

  /** Valeurs d'axes courantes du stick. */
  getStick(): { x: number; y: number } {
    return { x: this.axisX, y: this.axisY };
  }

  // ───────────── Boutons ─────────────

  /**
   * Un doigt appuie sur un bouton. Retourne false si l'appui est refusé (manette déconnectée). Un pointeur qui tenait
   * déjà un AUTRE contrôle le relâche d'abord ; plusieurs doigts peuvent tenir le même bouton (il reste enfoncé tant
   * qu'au moins un le tient).
   */
  pressButton(pointerId: number, button: VirtualButton): boolean {
    if (!this.connected) return false;
    if (this.holders.get(pointerId) === button) return true;
    this.releasePointer(pointerId);
    this.holders.set(pointerId, button);
    this.cache = null;
    return true;
  }

  /** true si au moins un doigt tient ce bouton. */
  isButtonDown(button: VirtualButton): boolean {
    for (const b of this.holders.values()) if (b === button) return true;
    return false;
  }

  // ───────────── Relâchements ─────────────

  /** true si ce pointeur tient actuellement un contrôle (stick ou bouton). */
  isPointerActive(pointerId: number): boolean {
    return this.stickPointer === pointerId || this.holders.has(pointerId);
  }

  /** Relâche le contrôle tenu par ce pointeur (pointerup / pointercancel / glissement hors du bouton). */
  releasePointer(pointerId: number): boolean {
    let released = false;
    if (this.holders.delete(pointerId)) released = true;
    if (this.stickPointer === pointerId) {
      this.stickPointer = null;
      this.axisX = 0;
      this.axisY = 0;
      released = true;
    }
    if (released) this.cache = null;
    return released;
  }

  /** Relâche TOUT (perte de focus, rotation, masquage, visibilitychange). */
  releaseAll(): void {
    if (this.holders.size === 0 && this.stickPointer === null && this.axisX === 0 && this.axisY === 0) return;
    this.holders.clear();
    this.stickPointer = null;
    this.axisX = 0;
    this.axisY = 0;
    this.cache = null;
  }

  // ───────────── Lecture ─────────────

  /**
   * Instantané (objet gelé, recréé seulement quand l'état change : aucune allocation entre deux changements).
   * Déconnectée : `connected: false`, axes et boutons à zéro.
   */
  snapshot(): VirtualPadSnapshot {
    if (this.cache) return this.cache;
    const down = new Set<number>();
    if (this.connected) for (const b of this.holders.values()) down.add(VIRTUAL_BUTTON_INDEX[b]);
    const buttons = Array.from({ length: VIRTUAL_PAD_BUTTON_COUNT }, (_, i) => (down.has(i) ? PRESSED_BUTTON : RELEASED_BUTTON));
    const snap: VirtualPadSnapshot = Object.freeze({
      index: VIRTUAL_PAD_INDEX,
      id: this.label,
      mapping: 'standard' as const,
      connected: this.connected,
      axes: Object.freeze(this.connected ? [this.axisX, this.axisY, 0, 0] : [0, 0, 0, 0]),
      buttons: Object.freeze(buttons),
    });
    this.cache = snap;
    return snap;
  }

  /** Pour `registerExtraGamepad` : l'instantané si la manette est connectée, sinon null (absente de la liste). */
  asExtraGamepad(): GamepadLike | null {
    return this.connected ? this.snapshot() : null;
  }
}
