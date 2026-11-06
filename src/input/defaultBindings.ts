/**
 * Bindings par défaut (DESIGN.md §5).
 *
 * Clavier J1 : flèches + Espace, ET en parallèle la disposition WASD + E (même joueur).
 * Les codes sont des `KeyboardEvent.code` PHYSIQUES : sur un clavier AZERTY, la disposition « WASD »
 * correspond donc aux touches ZQSD sans rien configurer.
 *
 * Manette (mapping « standard ») : stick gauche + croix = déplacement ; A (0) = action contextuelle
 * (attack + interact + revive) ; X (2) = attaque seule ; B (1) = interact + revive ; Y (3) / RB (5) / RT (7) =
 * ATTAQUE SPÉCIALE (bouton dédié). Clavier : F ou X = spécial. Dead-zone 0.25.
 */
import type { Bindings } from './actions';

/** Zone morte par défaut du stick. */
export const DEFAULT_DEADZONE = 0.25;

/** Indices du mapping standard des manettes. */
export const PAD_BUTTON = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  BACK: 8,
  START: 9,
  DPAD_UP: 12,
  DPAD_DOWN: 13,
  DPAD_LEFT: 14,
  DPAD_RIGHT: 15,
} as const;

/** Construit une copie MUTABLE et indépendante des bindings par défaut. */
export function createDefaultBindings(): Bindings {
  return {
    version: 1,
    move: {
      keys: {
        up: ['ArrowUp', 'KeyW'],
        down: ['ArrowDown', 'KeyS'],
        left: ['ArrowLeft', 'KeyA'],
        right: ['ArrowRight', 'KeyD'],
      },
      padAxes: { x: 0, y: 1 },
      padDpad: {
        up: PAD_BUTTON.DPAD_UP,
        down: PAD_BUTTON.DPAD_DOWN,
        left: PAD_BUTTON.DPAD_LEFT,
        right: PAD_BUTTON.DPAD_RIGHT,
      },
    },
    // Espace / E / A : action contextuelle → la simulation arbitre (relevage > interaction > attaque).
    attack: { keys: ['Space', 'KeyE'], pad: [PAD_BUTTON.A, PAD_BUTTON.X] },
    interact: { keys: ['Space', 'KeyE'], pad: [PAD_BUTTON.A, PAD_BUTTON.B] },
    revive: { keys: ['Space', 'KeyE'], pad: [PAD_BUTTON.A, PAD_BUTTON.B] },
    // Attaque spéciale : bouton dédié (clavier F / X ; manette Y / RB / RT). Espace et A ne la déclenchent PAS.
    special: { keys: ['KeyF', 'KeyX'], pad: [PAD_BUTTON.Y, PAD_BUTTON.RB, PAD_BUTTON.RT] },
    menu: {
      confirm: { keys: ['Enter', 'NumpadEnter', 'Space'], pad: [PAD_BUTTON.A] },
      back: { keys: ['Escape', 'Backspace'], pad: [PAD_BUTTON.B] },
    },
    deadzone: DEFAULT_DEADZONE,
  };
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

/** Bindings par défaut, gelés (lecture seule). Utiliser `createDefaultBindings()` pour une copie modifiable. */
export const DEFAULT_BINDINGS: Readonly<Bindings> = deepFreeze(createDefaultBindings());

/** Dispositions clavier prédéfinies (pour une future option « disposition clavier » du menu). */
export type KeyboardLayout = 'both' | 'arrows' | 'wasd';

/**
 * Retourne des bindings dont la partie clavier n'utilise que la disposition demandée
 * ('arrows' = flèches + Espace ; 'wasd' = WASD + E ; 'both' = défaut). La partie manette est inchangée.
 */
export function createKeyboardLayoutBindings(layout: KeyboardLayout): Bindings {
  const b = createDefaultBindings();
  if (layout === 'both') return b;
  const keep = (codes: string[]): string[] =>
    codes.filter((c) =>
      layout === 'arrows' ? c.startsWith('Arrow') || c === 'Space' : !c.startsWith('Arrow') && c !== 'Space',
    );
  for (const d of ['up', 'down', 'left', 'right'] as const) b.move.keys[d] = keep(b.move.keys[d]);
  b.attack.keys = keep(b.attack.keys);
  b.interact.keys = keep(b.interact.keys);
  b.revive.keys = keep(b.revive.keys);
  return b;
}
