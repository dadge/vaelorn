/**
 * Couche d'abstraction des entrées (DESIGN.md §5).
 *
 * Ce module ne contient QUE des types et des constantes : aucune dépendance au DOM ni à Phaser.
 * Une `InputSource` produit, à chaque `poll()`, l'`ActionFrame` « tenue » (held) d'UN joueur ;
 * la simulation détecte elle-même les fronts montants. Les sources ne contiennent aucune logique de jeu.
 */
import type { ActionFrame, Dir, PlayerId } from '../core/types';

/** Famille d'une source d'entrée. `touch` et `network` sont réservés (branchables via `InputManager.registerSource`). */
export type InputKind = 'keyboard' | 'gamepad' | 'touch' | 'network';

/**
 * Source d'entrée d'un joueur. Implémentée par `KeyboardSource`, `GamepadSource`,
 * et plus tard `TouchSource` / `RemoteInputSource` (src/net).
 */
export interface InputSource {
  /** Famille de la source (affichage dans l'écran de sélection). */
  readonly kind: InputKind;
  /** Identifiant stable et lisible (ex. 'keyboard', 'gamepad:1', 'network:2'). */
  readonly id: string;
  /**
   * Lit l'état courant (valeurs « tenues ») et retourne un NOUVEL objet `ActionFrame`
   * (l'appelant peut le conserver). Convention : moveY < 0 = haut, moveY > 0 = bas, moveX < 0 = gauche.
   */
  poll(): ActionFrame;
  /** true si le périphérique est utilisable (le clavier est toujours « connecté »). */
  connected(): boolean;
  /** Efface tout état interne (touches maintenues, etc.). Optionnel. */
  reset?(): void;
}

/**
 * Périphérique attribuable à un emplacement de joueur (`InputManager.assignDevice`).
 * `index` = indice navigateur de la manette (0..3 en pratique).
 */
export type DeviceAssignment = { kind: 'keyboard' } | { kind: 'gamepad'; index: number };

/** Identifiant de périphérique des menus : 'keyboard' ou 'gamepad:<indice>' (= `MenuIntent.source`). */
export type DeviceId = string;

/** Convertit un identifiant de périphérique de menu en `DeviceAssignment` (null si non reconnu). */
export function deviceFromId(id: DeviceId): DeviceAssignment | null {
  if (id === 'keyboard') return { kind: 'keyboard' };
  const m = /^gamepad:(\d+)$/.exec(id);
  return m ? { kind: 'gamepad', index: Number(m[1]) } : null;
}

/** Identifiant de périphérique de menu d'un `DeviceAssignment`. */
export function deviceToId(device: DeviceAssignment): DeviceId {
  return device.kind === 'keyboard' ? 'keyboard' : `gamepad:${device.index}`;
}

// ───────────────────────────── Bindings ─────────────────────────────

/** Entrées associées à une action « bouton » : codes `KeyboardEvent.code` et indices de boutons manette. */
export interface ButtonBinding {
  /** Codes physiques (ex. 'Space', 'KeyE', 'ArrowUp'). Indépendants de la disposition AZERTY/QWERTY. */
  keys: string[];
  /** Indices de boutons du mapping « standard » des manettes (0 = A, 1 = B, 2 = X, 3 = Y…) ; en jeu seuls A (action), X (appel) et Y (spécial) sont liés par défaut. */
  pad: number[];
}

/** Entrées de l'action `move`. */
export interface MoveBinding {
  /** Touches de chaque direction (plusieurs dispositions possibles : flèches ET WASD). */
  keys: Record<Dir, string[]>;
  /** Indices des axes du stick gauche (standard : x = 0, y = 1). */
  padAxes: { x: number; y: number };
  /** Boutons de la croix directionnelle (standard : haut 12, bas 13, gauche 14, droite 15). */
  padDpad: Record<Dir, number>;
}

/**
 * Configuration complète des entrées. JSON pur (sérialisable dans localStorage) et remappable.
 * Pour chaque `ActionName` ('move' | 'attack' | 'interact' | 'revive' | 'special' | 'call') : les entrées clavier ET manette.
 */
export interface Bindings {
  version: 1;
  move: MoveBinding;
  attack: ButtonBinding;
  interact: ButtonBinding;
  revive: ButtonBinding;
  /** Attaque spéciale (bouton DÉDIÉ : ni Espace ni A ne la déclenchent). Clavier F / X, manette Y seul. */
  special: ButtonBinding;
  /**
   * Appel (bouton DÉDIÉ : signal vers l'équipe, le joueur s'immobilise 1 s ; ni Espace ni A ne le déclenchent).
   * Clavier C ; manette X seul.
   */
  call: ButtonBinding;
  /** Navigation de menu : confirmer / retour (les directions réutilisent `move`). */
  menu: { confirm: ButtonBinding; back: ButtonBinding };
  /** Zone morte radiale du stick, 0..0.95 (défaut 0.25). */
  deadzone: number;
}

/** Surcharge partielle (profonde) de `Bindings` ; les tableaux sont REMPLACÉS, jamais concaténés. */
export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;
export type BindingsOverrides = DeepPartial<Bindings>;

/** Clés de `Bindings` qui sont des actions « bouton » (par opposition à `move`). */
export type ButtonActionName = 'attack' | 'interact' | 'revive' | 'special' | 'call';
export const BUTTON_ACTIONS: readonly ButtonActionName[] = ['attack', 'interact', 'revive', 'special', 'call'];

/** Code d'erreur de validation (diagnostic technique, jamais affiché tel quel). */
export type BindingsErrorCode = 'missing' | 'type' | 'empty' | 'range' | 'conflict';

export interface BindingsError {
  /** Chemin pointé dans `Bindings` (ex. 'move.keys.up', 'attack.pad', 'deadzone'). */
  path: string;
  code: BindingsErrorCode;
}

export interface BindingsValidation {
  valid: boolean;
  errors: BindingsError[];
}

// ───────────────────────────── Menus ─────────────────────────────

export type MenuAction = 'up' | 'down' | 'left' | 'right' | 'confirm' | 'back';
export const MENU_ACTIONS: readonly MenuAction[] = ['up', 'down', 'left', 'right', 'confirm', 'back'];

/**
 * Intention de navigation de menu (front montant, ou répétition pour les directions maintenues).
 * `playerId` = joueur auquel le périphérique est rattaché dans l'InputManager (null = aucun/inconnu) ;
 * `source` = identifiant du périphérique ('keyboard', 'gamepad:0'…).
 */
export interface MenuIntent {
  playerId: PlayerId | null;
  source: string;
  action: MenuAction;
}

/** État « tenu » des actions de menu d'UN périphérique, à un instant donné. */
export interface MenuDevice {
  id: string;
  playerId: PlayerId | null;
  held: ReadonlySet<MenuAction>;
}

/** Fournisseur de périphériques de menu (implémenté par `InputManager`, factice dans les tests). */
export interface MenuDeviceProvider {
  getMenuDevices(): MenuDevice[];
}
