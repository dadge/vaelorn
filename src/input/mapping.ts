/**
 * Fonctions PURES de conversion « état brut du périphérique » → `ActionFrame` / intentions de menu.
 * Aucune dépendance au DOM : testables sous Node. Elles ne mutent jamais leurs arguments.
 */
import type { ActionFrame, Dir } from '../core/types';
import type {
  Bindings,
  BindingsError,
  BindingsOverrides,
  BindingsValidation,
  ButtonBinding,
  MenuAction,
} from './actions';
import { BUTTON_ACTIONS } from './actions';
import { createDefaultBindings, DEFAULT_DEADZONE } from './defaultBindings';

/** Saturation du stick : au-delà de cette amplitude brute, le mouvement est à pleine vitesse (sticks usés). */
export const STICK_SATURATION = 0.9;
/** Amplitude brute minimale du stick pour déclencher une intention de menu (au moins la dead-zone). */
export const MENU_STICK_THRESHOLD = 0.5;
/** Zone morte maximale acceptée. */
export const MAX_DEADZONE = 0.95;
/** Seuil de `value` au-dessus duquel un bouton analogique (gâchette) compte comme appuyé. */
export const ANALOG_BUTTON_THRESHOLD = 0.5;

const DIRS: readonly Dir[] = ['up', 'down', 'left', 'right'];

/** Capture minimale d'une manette (compatible avec l'objet `Gamepad` du navigateur). */
export interface GamepadSnapshot {
  readonly axes: readonly number[];
  readonly buttons: readonly { readonly pressed: boolean; readonly value: number }[];
  /**
   * Mapping annoncé par le navigateur : `'standard'` ou `''` (manette non standard). `undefined` (instantané
   * de test, ancien code) est traité comme « standard ».
   */
  readonly mapping?: string;
}

/** Indice d'axe du « hat » (croix directionnelle encodée sur un axe) des manettes non standard. */
export const NONSTANDARD_HAT_AXIS = 9;

/** true si la manette n'a PAS le mapping standard (mappage de repli : axes 0/1, axe 9 = croix, boutons 0/1/2 = A/B/X). */
export function isNonStandardPad(snapshot: GamepadSnapshot): boolean {
  return snapshot.mapping !== undefined && snapshot.mapping !== 'standard';
}

/**
 * Décode la valeur d'un axe « hat » (croix sur un axe, 8 positions espacées de 2/7 de -1 à +1, neutre ≈ 1.29)
 * en directions. Valeur hors plage / non finie : aucune direction.
 */
export function hatToDirections(value: number | undefined): { up: boolean; down: boolean; left: boolean; right: boolean } {
  const none = { up: false, down: false, left: false, right: false };
  if (typeof value !== 'number' || !Number.isFinite(value) || value < -1.05 || value > 1.05) return none;
  const k = Math.max(0, Math.min(7, Math.round((value + 1) * 3.5)));
  // 0 haut, 1 haut-droite, 2 droite, 3 bas-droite, 4 bas, 5 bas-gauche, 6 gauche, 7 haut-gauche
  return {
    up: k === 7 || k === 0 || k === 1,
    right: k >= 1 && k <= 3,
    down: k >= 3 && k <= 5,
    left: k >= 5 && k <= 7,
  };
}

/** Directions de la croix : boutons du mapping (si présents) OU axe hat (manettes non standard). */
function padDirections(snapshot: GamepadSnapshot, bindings: Bindings): { up: boolean; down: boolean; left: boolean; right: boolean } {
  const d = bindings.move.padDpad;
  const out = {
    up: isPadButtonDown(snapshot, d.up),
    down: isPadButtonDown(snapshot, d.down),
    left: isPadButtonDown(snapshot, d.left),
    right: isPadButtonDown(snapshot, d.right),
  };
  if (isNonStandardPad(snapshot)) {
    const h = hatToDirections(snapshot.axes[NONSTANDARD_HAT_AXIS]);
    out.up = out.up || h.up;
    out.down = out.down || h.down;
    out.left = out.left || h.left;
    out.right = out.right || h.right;
  }
  return out;
}

/** true si au moins un bouton de la manette est appuyé (réveil / « rejoindre »). */
export function padHasActivity(snapshot: GamepadSnapshot): boolean {
  for (let i = 0; i < snapshot.buttons.length; i++) if (isPadButtonDown(snapshot, i)) return true;
  return false;
}

/** Nouvelle frame vide (jamais l'objet gelé `EMPTY_ACTION_FRAME`, que l'appelant pourrait vouloir muter). */
export function emptyFrame(): ActionFrame {
  return { moveX: 0, moveY: 0, attack: false, interact: false, revive: false, special: false };
}

/** true si la frame contient une entrée (déplacement ou bouton). */
export function frameHasActivity(f: ActionFrame): boolean {
  return f.moveX !== 0 || f.moveY !== 0 || f.attack || f.interact || f.revive || f.special === true;
}

function anyKey(pressed: ReadonlySet<string>, codes: readonly string[]): boolean {
  for (const c of codes) if (pressed.has(c)) return true;
  return false;
}

/** Vecteur directionnel numérique (4 directions), diagonale normalisée à une longueur de 1. */
function digitalVector(up: boolean, down: boolean, left: boolean, right: boolean): { x: number; y: number } {
  let x = (right ? 1 : 0) - (left ? 1 : 0);
  let y = (down ? 1 : 0) - (up ? 1 : 0);
  if (x !== 0 && y !== 0) {
    x *= Math.SQRT1_2;
    y *= Math.SQRT1_2;
  }
  return { x, y };
}

/**
 * Clavier → frame. `pressedKeyCodes` = ensemble des `KeyboardEvent.code` actuellement tenus.
 * Directions opposées simultanées s'annulent ; la diagonale est normalisée (±√½ sur chaque axe).
 * Une même touche (Espace) peut déclencher attack + interact + revive à la fois : la simulation arbitre.
 */
export function keysToFrame(pressedKeyCodes: ReadonlySet<string>, bindings: Bindings): ActionFrame {
  const k = bindings.move.keys;
  const v = digitalVector(
    anyKey(pressedKeyCodes, k.up),
    anyKey(pressedKeyCodes, k.down),
    anyKey(pressedKeyCodes, k.left),
    anyKey(pressedKeyCodes, k.right),
  );
  return {
    moveX: v.x,
    moveY: v.y,
    attack: anyKey(pressedKeyCodes, bindings.attack.keys),
    interact: anyKey(pressedKeyCodes, bindings.interact.keys),
    revive: anyKey(pressedKeyCodes, bindings.revive.keys),
    special: anyKey(pressedKeyCodes, bindings.special.keys),
  };
}

/** true si le bouton `index` est appuyé (`pressed`, ou `value` > seuil pour les gâchettes). Index absent → false. */
export function isPadButtonDown(snapshot: GamepadSnapshot, index: number): boolean {
  const b = snapshot.buttons[index];
  if (!b) return false;
  return b.pressed || b.value > ANALOG_BUTTON_THRESHOLD;
}

function anyPadButton(snapshot: GamepadSnapshot, indices: readonly number[]): boolean {
  for (const i of indices) if (isPadButtonDown(snapshot, i)) return true;
  return false;
}

function axisValue(snapshot: GamepadSnapshot, index: number): number {
  const v = snapshot.axes[index];
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
}

function clampDeadzone(dz: number): number {
  if (!Number.isFinite(dz)) return DEFAULT_DEADZONE;
  return Math.max(0, Math.min(MAX_DEADZONE, dz));
}

/**
 * Manette → frame.
 * - La croix directionnelle (si au moins une direction appuyée) a priorité : vitesse pleine, diagonale normalisée.
 * - Sinon le stick gauche : zone morte RADIALE (`deadzone`, défaut `bindings.deadzone` = 0.25), puis
 *   l'amplitude est re-mappée de [deadzone, STICK_SATURATION] vers [0, 1] (mouvement progressif, sans à-coup).
 *   La simulation peut donc recevoir une amplitude analogique (0..1) ; la direction reste exacte.
 * - Boutons : voir `bindings.attack/interact/revive/special.pad` (A = les trois, X = attaque, B = interact + revive,
 *   Y / RB / RT = attaque spéciale UNIQUEMENT : A ne la déclenche jamais).
 * - Manette non standard (`snapshot.mapping` ≠ 'standard') : mappage de repli (axes 0/1, croix sur l'axe 9, boutons 0/1/2 = A/B/X).
 */
export function gamepadToFrame(snapshot: GamepadSnapshot, bindings: Bindings, deadzone?: number): ActionFrame {
  const dz = clampDeadzone(deadzone ?? bindings.deadzone);
  const dirs = padDirections(snapshot, bindings);
  const dpadUp = dirs.up;
  const dpadDown = dirs.down;
  const dpadLeft = dirs.left;
  const dpadRight = dirs.right;

  let mx = 0;
  let my = 0;
  if (dpadUp || dpadDown || dpadLeft || dpadRight) {
    const v = digitalVector(dpadUp, dpadDown, dpadLeft, dpadRight);
    mx = v.x;
    my = v.y;
  } else {
    const ax = axisValue(snapshot, bindings.move.padAxes.x);
    const ay = axisValue(snapshot, bindings.move.padAxes.y);
    const mag = Math.hypot(ax, ay);
    if (mag > dz) {
      const sat = Math.max(STICK_SATURATION, dz + 0.05);
      const scaled = Math.min(1, (mag - dz) / (sat - dz));
      mx = (ax / mag) * scaled;
      my = (ay / mag) * scaled;
    }
  }

  return {
    moveX: mx + 0, // + 0 : évite -0
    moveY: my + 0,
    attack: anyPadButton(snapshot, bindings.attack.pad),
    interact: anyPadButton(snapshot, bindings.interact.pad),
    revive: anyPadButton(snapshot, bindings.revive.pad),
    special: anyPadButton(snapshot, bindings.special.pad),
  };
}

// ───────────────────────────── Menus ─────────────────────────────

/** Supprime les directions opposées simultanées (haut+bas, gauche+droite) d'un ensemble d'intentions de menu. */
function cancelOpposites(held: Set<MenuAction>): Set<MenuAction> {
  if (held.has('up') && held.has('down')) {
    held.delete('up');
    held.delete('down');
  }
  if (held.has('left') && held.has('right')) {
    held.delete('left');
    held.delete('right');
  }
  return held;
}

/** Clavier → actions de menu « tenues » (flèches/WASD, Entrée/Espace, Échap par défaut). */
export function keysToMenuHeld(pressedKeyCodes: ReadonlySet<string>, bindings: Bindings): Set<MenuAction> {
  const held = new Set<MenuAction>();
  const k = bindings.move.keys;
  if (anyKey(pressedKeyCodes, k.up)) held.add('up');
  if (anyKey(pressedKeyCodes, k.down)) held.add('down');
  if (anyKey(pressedKeyCodes, k.left)) held.add('left');
  if (anyKey(pressedKeyCodes, k.right)) held.add('right');
  if (anyKey(pressedKeyCodes, bindings.menu.confirm.keys)) held.add('confirm');
  if (anyKey(pressedKeyCodes, bindings.menu.back.keys)) held.add('back');
  return cancelOpposites(held);
}

/**
 * Manette → actions de menu « tenues » : croix, stick (axe dominant uniquement, seuil
 * `max(MENU_STICK_THRESHOLD, deadzone)`), A = confirmer, B = retour par défaut.
 */
export function gamepadToMenuHeld(snapshot: GamepadSnapshot, bindings: Bindings, deadzone?: number): Set<MenuAction> {
  const dz = clampDeadzone(deadzone ?? bindings.deadzone);
  const held = new Set<MenuAction>();
  const dirs = padDirections(snapshot, bindings);
  if (dirs.up) held.add('up');
  if (dirs.down) held.add('down');
  if (dirs.left) held.add('left');
  if (dirs.right) held.add('right');

  const ax = axisValue(snapshot, bindings.move.padAxes.x);
  const ay = axisValue(snapshot, bindings.move.padAxes.y);
  const threshold = Math.max(MENU_STICK_THRESHOLD, dz);
  if (Math.max(Math.abs(ax), Math.abs(ay)) >= threshold) {
    if (Math.abs(ax) >= Math.abs(ay)) held.add(ax < 0 ? 'left' : 'right');
    else held.add(ay < 0 ? 'up' : 'down');
  }

  if (anyPadButton(snapshot, bindings.menu.confirm.pad)) held.add('confirm');
  if (anyPadButton(snapshot, bindings.menu.back.pad)) held.add('back');
  return cancelOpposites(held);
}

// ───────────────────────────── Fusion / validation ─────────────────────────────

function isStringList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length > 0);
}

function isIndexList(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((x) => Number.isInteger(x) && (x as number) >= 0);
}

function isIndex(v: unknown): v is number {
  return Number.isInteger(v) && (v as number) >= 0;
}

function pickStrings(v: unknown, fallback: readonly string[]): string[] {
  return isStringList(v) ? Array.from(new Set(v)) : fallback.slice();
}

function pickIndices(v: unknown, fallback: readonly number[]): number[] {
  return isIndexList(v) ? Array.from(new Set(v)) : fallback.slice();
}

function pickIndex(v: unknown, fallback: number): number {
  return isIndex(v) ? v : fallback;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function mergeButton(base: ButtonBinding, over: unknown): ButtonBinding {
  const o = obj(over);
  return { keys: pickStrings(o.keys, base.keys), pad: pickIndices(o.pad, base.pad) };
}

/**
 * Fusionne des surcharges (typiquement lues du localStorage, donc NON FIABLES) sur des bindings de base.
 * Retourne TOUJOURS une copie profonde et indépendante ; ne mute ni `defaults` ni `overrides`.
 * Les tableaux valides remplacent ceux de la base ; toute valeur de forme invalide est ignorée
 * (on garde la valeur de la base). Les doublons sont retirés. N'effectue PAS la validation sémantique
 * (conflits, listes vides) : appeler `validateBindings` sur le résultat.
 */
export function mergeBindings(defaults: Bindings, overrides?: BindingsOverrides | null): Bindings {
  const o = obj(overrides);
  const om = obj(o.move);
  const omKeys = obj(om.keys);
  const omAxes = obj(om.padAxes);
  const omDpad = obj(om.padDpad);
  const omenu = obj(o.menu);

  const keys = {} as Bindings['move']['keys'];
  const dpad = {} as Bindings['move']['padDpad'];
  for (const d of DIRS) {
    keys[d] = pickStrings(omKeys[d], defaults.move.keys[d]);
    dpad[d] = pickIndex(omDpad[d], defaults.move.padDpad[d]);
  }
  const dz = o.deadzone;
  return {
    version: 1,
    move: {
      keys,
      padAxes: { x: pickIndex(omAxes.x, defaults.move.padAxes.x), y: pickIndex(omAxes.y, defaults.move.padAxes.y) },
      padDpad: dpad,
    },
    attack: mergeButton(defaults.attack, o.attack),
    interact: mergeButton(defaults.interact, o.interact),
    revive: mergeButton(defaults.revive, o.revive),
    special: mergeButton(defaults.special, o.special),
    menu: {
      confirm: mergeButton(defaults.menu.confirm, omenu.confirm),
      back: mergeButton(defaults.menu.back, omenu.back),
    },
    deadzone:
      typeof dz === 'number' && Number.isFinite(dz) && dz >= 0 && dz <= MAX_DEADZONE ? dz : defaults.deadzone,
  };
}

/**
 * Valide une valeur quelconque comme `Bindings` : forme complète et typée, listes non vides,
 * indices entiers ≥ 0, `deadzone` ∈ [0, 0.95], axes x/y distincts, et absence de CONFLITS
 * (une même touche / un même bouton ne peut pas servir à deux directions, ni à une direction ET une action ;
 * en revanche attack/interact/revive PEUVENT partager une entrée — c'est le principe de l'action contextuelle).
 * Retourne la liste des erreurs (chemin + code), vide si valide.
 */
export function validateBindings(candidate: unknown): BindingsValidation {
  const errors: BindingsError[] = [];
  const err = (path: string, code: BindingsError['code']): void => {
    errors.push({ path, code });
  };
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { valid: false, errors: [{ path: '', code: 'type' }] };
  }
  const b = candidate as Record<string, unknown>;

  const checkStrings = (path: string, v: unknown): string[] => {
    if (v === undefined) {
      err(path, 'missing');
      return [];
    }
    if (!isStringList(v)) {
      err(path, 'type');
      return [];
    }
    if (v.length === 0) {
      err(path, 'empty');
      return [];
    }
    return v;
  };
  const checkIndices = (path: string, v: unknown): number[] => {
    if (v === undefined) {
      err(path, 'missing');
      return [];
    }
    if (!isIndexList(v)) {
      err(path, 'type');
      return [];
    }
    if (v.length === 0) {
      err(path, 'empty');
      return [];
    }
    return v;
  };

  if (b.version !== 1) err('version', b.version === undefined ? 'missing' : 'range');

  if (typeof b.deadzone !== 'number' || !Number.isFinite(b.deadzone)) {
    err('deadzone', b.deadzone === undefined ? 'missing' : 'type');
  } else if (b.deadzone < 0 || b.deadzone > MAX_DEADZONE) {
    err('deadzone', 'range');
  }

  // Rôles « mouvement » vs « action » pour la détection de conflits.
  const keyRoles = new Map<string, string[]>();
  const padRoles = new Map<string, string[]>();
  const addRole = (m: Map<string, string[]>, code: string | number, role: string): void => {
    const k = String(code);
    const list = m.get(k);
    if (list) list.push(role);
    else m.set(k, [role]);
  };

  const move = obj(b.move);
  if (b.move === undefined) err('move', 'missing');
  const mkeys = obj(move.keys);
  const mdpad = obj(move.padDpad);
  for (const d of DIRS) {
    for (const code of checkStrings(`move.keys.${d}`, mkeys[d])) addRole(keyRoles, code, `move:${d}`);
    const idx = mdpad[d];
    if (idx === undefined) err(`move.padDpad.${d}`, 'missing');
    else if (!isIndex(idx)) err(`move.padDpad.${d}`, 'type');
    else addRole(padRoles, idx, `move:${d}`);
  }
  const axes = obj(move.padAxes);
  if (!isIndex(axes.x)) err('move.padAxes.x', axes.x === undefined ? 'missing' : 'type');
  if (!isIndex(axes.y)) err('move.padAxes.y', axes.y === undefined ? 'missing' : 'type');
  if (isIndex(axes.x) && isIndex(axes.y) && axes.x === axes.y) err('move.padAxes', 'conflict');

  for (const a of BUTTON_ACTIONS) {
    const ab = obj(b[a]);
    if (b[a] === undefined) err(a, 'missing');
    for (const code of checkStrings(`${a}.keys`, ab.keys)) addRole(keyRoles, code, 'action');
    for (const idx of checkIndices(`${a}.pad`, ab.pad)) addRole(padRoles, idx, 'action');
  }

  const menu = obj(b.menu);
  if (b.menu === undefined) err('menu', 'missing');
  for (const m of ['confirm', 'back'] as const) {
    const mb = obj(menu[m]);
    if (menu[m] === undefined) err(`menu.${m}`, 'missing');
    checkStrings(`menu.${m}.keys`, mb.keys);
    checkIndices(`menu.${m}.pad`, mb.pad);
  }

  const reportConflicts = (m: Map<string, string[]>, prefix: string): void => {
    for (const [code, roles] of m) {
      const moves = roles.filter((r) => r.startsWith('move:'));
      const distinctMoves = new Set(moves);
      const hasAction = roles.includes('action');
      if (distinctMoves.size > 1 || (distinctMoves.size >= 1 && hasAction)) {
        err(`${prefix}:${code}`, 'conflict');
      }
    }
  };
  reportConflicts(keyRoles, 'keys');
  reportConflicts(padRoles, 'pad');

  return { valid: errors.length === 0, errors };
}

/** Copie profonde indépendante (les bindings sont du JSON pur). */
export function cloneBindings(b: Bindings): Bindings {
  return JSON.parse(JSON.stringify(b)) as Bindings;
}

/** Raccourci : `mergeBindings(createDefaultBindings(), overrides)`. */
export function bindingsFromOverrides(overrides?: BindingsOverrides | null): Bindings {
  return mergeBindings(createDefaultBindings(), overrides);
}
