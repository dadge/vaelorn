/**
 * Source clavier : écoute keydown/keyup sur `window` et expose l'état « tenu ».
 * Aucun accès à `window`/`document` à l'import : le module est importable sous Node.
 */
import type { ActionFrame } from '../core/types';
import type { Bindings, InputSource } from './actions';
import { createDefaultBindings } from './defaultBindings';
import { keysToFrame } from './mapping';

/** Événement clavier minimal (compatible `KeyboardEvent`). */
export interface KeyEventLike {
  code: string;
  repeat?: boolean;
  target?: unknown;
  preventDefault(): void;
}

/** Cible d'événements minimale (compatible `window`, ou un faux objet dans les tests). */
export interface KeyEventTarget {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addEventListener(type: string, listener: (ev: any) => void): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  removeEventListener(type: string, listener: (ev: any) => void): void;
}

/** Touches dont l'action par défaut du navigateur (défilement de page) est supprimée. */
export const PREVENT_DEFAULT_CODES: ReadonlySet<string> = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Space',
]);

function isEditableTarget(t: unknown): boolean {
  if (!t || typeof t !== 'object') return false;
  const el = t as { tagName?: unknown; isContentEditable?: unknown };
  if (el.isContentEditable === true) return true;
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * Source clavier d'un joueur. `attach()`/`detach()` (idempotents) branchent les écouteurs ;
 * l'état est vidé au `blur` de la fenêtre et quand l'onglet devient invisible (évite les touches « collées »).
 * `preventDefault` est appelé sur flèches et Espace (sauf dans un champ de saisie).
 */
export class KeyboardSource implements InputSource {
  readonly kind = 'keyboard' as const;
  readonly id = 'keyboard';

  private bindings: Bindings;
  private readonly target: KeyEventTarget | null;
  private readonly pressed = new Set<string>();
  /** Touches enfoncées depuis le dernier `drainTapped()` (rattrape les appuis plus courts qu'une frame, pour les menus). */
  private tapped = new Set<string>();
  private attached = false;

  /**
   * @param bindings bindings initiaux (défaut : `createDefaultBindings()`)
   * @param target cible des événements ; défaut : `window` s'il existe, sinon aucune (no-op sous Node)
   */
  constructor(bindings?: Bindings, target?: KeyEventTarget | null) {
    this.bindings = bindings ?? createDefaultBindings();
    this.target = target !== undefined ? target : typeof window !== 'undefined' ? window : null;
  }

  private readonly onKeyDown = (e: KeyEventLike): void => {
    if (!e || typeof e.code !== 'string' || e.code === '') return;
    if (PREVENT_DEFAULT_CODES.has(e.code) && !isEditableTarget(e.target)) e.preventDefault();
    this.pressed.add(e.code);
    if (!e.repeat) this.tapped.add(e.code);
  };

  private readonly onKeyUp = (e: KeyEventLike): void => {
    if (!e || typeof e.code !== 'string') return;
    this.pressed.delete(e.code);
  };

  private readonly onBlur = (): void => {
    this.reset();
  };

  private readonly onVisibility = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') this.reset();
  };

  /** Branche les écouteurs (idempotent). Sans cible (Node), ne fait rien mais marque la source attachée. */
  attach(): void {
    if (this.attached) return;
    this.attached = true;
    if (!this.target) return;
    this.target.addEventListener('keydown', this.onKeyDown);
    this.target.addEventListener('keyup', this.onKeyUp);
    this.target.addEventListener('blur', this.onBlur);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisibility);
  }

  /** Débranche les écouteurs et vide l'état (idempotent). */
  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    if (this.target) {
      this.target.removeEventListener('keydown', this.onKeyDown);
      this.target.removeEventListener('keyup', this.onKeyUp);
      this.target.removeEventListener('blur', this.onBlur);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility);
    }
    this.reset();
  }

  get isAttached(): boolean {
    return this.attached;
  }

  setBindings(bindings: Bindings): void {
    this.bindings = bindings;
  }

  /** Vide les touches maintenues (perte de focus, changement de scène…). */
  reset(): void {
    this.pressed.clear();
    this.tapped.clear();
  }

  connected(): boolean {
    return true;
  }

  poll(): ActionFrame {
    return keysToFrame(this.pressed, this.bindings);
  }

  /** Ensemble des codes actuellement tenus (lecture seule, ne pas conserver : il est vivant). */
  getPressedKeys(): ReadonlySet<string> {
    return this.pressed;
  }

  /**
   * Retourne `pressed ∪ touches enfoncées depuis le dernier appel` puis vide le tampon.
   * Utilisé par la navigation de menu pour ne pas perdre un appui plus court qu'une frame.
   */
  drainTapped(): Set<string> {
    const out = new Set<string>(this.pressed);
    for (const c of this.tapped) out.add(c);
    this.tapped = new Set<string>();
    return out;
  }

  /** Injection manuelle d'un événement (tests / futures sources tactiles émulant le clavier). */
  handleKeyDown(e: KeyEventLike): void {
    this.onKeyDown(e);
  }
  handleKeyUp(e: KeyEventLike): void {
    this.onKeyUp(e);
  }
}
