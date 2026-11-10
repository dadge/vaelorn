/**
 * Bindings par défaut (DESIGN.md §5).
 *
 * Clavier J1 : flèches + Espace, ET en parallèle la disposition WASD + E (même joueur).
 * Les codes sont des `KeyboardEvent.code` PHYSIQUES : sur un clavier AZERTY, la disposition « WASD »
 * correspond donc aux touches ZQSD sans rien configurer.
 *
 * Manette (mapping « standard »), schéma à QUATRE boutons (A B X Y) :
 *   A (0) = action contextuelle (attack + interact + revive : relever, interagir, attaquer) ;
 *   B (1) = UTILISER LE CŒUR rangé dans l'emplacement cœur (se soigner, ou soigner le coéquipier blessé sur lequel on se place) ;
 *   X (2) = APPEL des alliés ; Y (3) = ATTAQUE SPÉCIALE (rechargeable) ; Start (9) = pause (lu par GameScene, pas par les bindings).
 * TOUS les autres boutons (LB, RB, LT, RT, Back, appuis de sticks, croix hors déplacement…) sont SANS EFFET en jeu.
 * Stick gauche + croix = déplacement (zone morte 0.25).
 * Exceptions (hors jeu, donc hors bindings d'action) : dans les MENUS, A = confirmer et B = retour (sinon on ne pourrait plus
 * annuler ni libérer une place à l'écran de sélection) ; Select / Back (8) reste le « passer » du tutoriel sur manette
 * (GameScene.pollTutorialPad) ; B sert aussi de « retour » dans la pause et les dialogues (l'action « utiliser le cœur » n'existe qu'en jeu actif :
 * GameScene filtre le B qui vient de fermer la pause ou d'ouvrir la scène tant qu'il n'est pas relâché).
 * Clavier : Espace / E = action ; B = utiliser le cœur ; F ou X = spécial ; C = appel ; Entrée / Échap / M (menus, pause, son).
 * Un seul clavier existe (un seul joueur à la fois, dispositions flèches ET WASD en parallèle) : « B » et « C » ne figurent dans aucune
 * autre action ni direction, quelle que soit la disposition (`createKeyboardLayoutBindings`).
 */
import type { Bindings } from './actions';

/** Zone morte par défaut du stick. */
export const DEFAULT_DEADZONE = 0.25;

/**
 * Indices du mapping standard des manettes. Seuls A, B, X, Y (jeu), Start (pause), A / B (menus), Back (« passer » du tutoriel)
 * et la croix (déplacement / menus) ont un rôle ; LB / RB / LT / RT restent déclarés pour les tests (« sans effet »).
 */
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
    // Espace / E / A : action contextuelle → la simulation arbitre (relevage > interaction > attaque). A SEUL à la manette.
    attack: { keys: ['Space', 'KeyE'], pad: [PAD_BUTTON.A] },
    interact: { keys: ['Space', 'KeyE'], pad: [PAD_BUTTON.A] },
    revive: { keys: ['Space', 'KeyE'], pad: [PAD_BUTTON.A] },
    // Attaque spéciale : bouton dédié (clavier F / X ; manette Y SEUL). Espace et A ne la déclenchent PAS.
    special: { keys: ['KeyF', 'KeyX'], pad: [PAD_BUTTON.Y] },
    // Appel : bouton dédié (clavier C ; manette X SEUL). Aucune autre action n'utilise ces entrées.
    call: { keys: ['KeyC'], pad: [PAD_BUTTON.X] },
    // Utiliser le cœur rangé : bouton dédié (clavier B ; manette B SEUL, qui reste « retour » dans les menus). Aucune autre action n'utilise ces entrées en jeu.
    heart: { keys: ['KeyB'], pad: [PAD_BUTTON.B] },
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
