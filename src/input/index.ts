/** Point d'entrée de la couche d'entrées (réexporte l'API publique). */
export * from './actions';
export * from './defaultBindings';
export * from './mapping';
export * from './VirtualPad';
export * from './virtualPadHandover';
export { KeyboardSource, PREVENT_DEFAULT_CODES } from './KeyboardSource';
export type { KeyEventLike, KeyEventTarget } from './KeyboardSource';
export { GamepadSource, defaultGamepadProvider, listGamepads, getGamepadAt, registerExtraGamepad } from './GamepadSource';
export type { ExtraGamepadGetter, GamepadLike, GamepadProvider, GamepadSourceOptions } from './GamepadSource';
export { InputManager, FirstUsedSource, inputManager, BINDINGS_STORAGE_KEY } from './InputManager';
export type { InputManagerOptions, PlayerAssignment, StorageLike, PadEvent, PadEventListener } from './InputManager';
export { MenuNavigator, EdgeRepeater, MENU_REPEAT_DELAY_MS, MENU_REPEAT_INTERVAL_MS } from './MenuNavigator';
export type { MenuNavigatorOptions } from './MenuNavigator';
