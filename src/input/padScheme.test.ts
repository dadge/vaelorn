/**
 * Schéma de manette à QUATRE boutons (A B X Y) :
 *   A = action contextuelle (relever, interagir, attaquer) ; B = utiliser le cœur rangé (emplacement cœur) ; X = appeler les alliés ;
 *   Y = attaque spéciale ; Start = pause ; TOUS les autres boutons sont SANS EFFET en jeu.
 * Exceptions documentées (hors jeu) : dans les menus A = confirmer et B = retour ; Select / Back = « passer » du tutoriel.
 *
 * Ces tests parcourent les 17 boutons du mapping standard (0..16) : ils échouent si un bouton « parasite » (LB, RB, LT, RT,
 * Back, appuis de sticks, Home…) reprend un effet en jeu, ou si les menus perdent A / B / croix / stick.
 */
import { describe, expect, it } from 'vitest';
import { RemoteInputSource } from '../net/RemoteInputSource';
import { createDefaultBindings, DEFAULT_BINDINGS, PAD_BUTTON } from './defaultBindings';
import { GamepadSource } from './GamepadSource';
import type { GamepadLike } from './GamepadSource';
import { BINDINGS_STORAGE_KEY, InputManager, LEGACY_BINDINGS_STORAGE_KEY } from './InputManager';
import type { StorageLike } from './InputManager';
import { KeyboardSource } from './KeyboardSource';
import type { KeyEventTarget } from './KeyboardSource';
import { emptyFrame, gamepadToFrame, gamepadToMenuHeld, keysToFrame, mergeBindings, padHasActivity, validateBindings } from './mapping';
import type { GamepadSnapshot } from './mapping';
import { MENU_ACTIONS } from './actions';
import type { MenuAction } from './actions';

/** Les 17 boutons du mapping standard (0 = A … 16 = Home). */
const ALL_BUTTONS = Array.from({ length: 17 }, (_, i) => i);
const DPAD = [PAD_BUTTON.DPAD_UP, PAD_BUTTON.DPAD_DOWN, PAD_BUTTON.DPAD_LEFT, PAD_BUTTON.DPAD_RIGHT] as const;

function snap(pressed: number[] = [], axes: number[] = [0, 0, 0, 0], mapping?: string): GamepadSnapshot {
  return {
    axes,
    mapping,
    buttons: ALL_BUTTONS.map((i) => ({ pressed: pressed.includes(i), value: pressed.includes(i) ? 1 : 0 })),
  };
}

function padLike(index: number, pressed: number[] = []): GamepadLike {
  return { index, id: `Pad ${index}`, connected: true, ...snap(pressed) };
}

/** Ne garde que les champs « action » d'une frame (sans le déplacement) : attack, interact, revive, special, call, heart. */
function actions(f: ReturnType<typeof gamepadToFrame>): [boolean, boolean, boolean, boolean, boolean, boolean] {
  return [f.attack, f.interact, f.revive, f.special === true, f.call === true, f.heart === true];
}

describe('manette en jeu : seuls A, B, X, Y ont un effet (parcours des 17 boutons)', () => {
  const b = createDefaultBindings();

  // attack, interact, revive, special, call, heart
  const EXPECTED: Record<number, [boolean, boolean, boolean, boolean, boolean, boolean]> = {
    [PAD_BUTTON.A]: [true, true, true, false, false, false],
    [PAD_BUTTON.B]: [false, false, false, false, false, true],
    [PAD_BUTTON.X]: [false, false, false, false, true, false],
    [PAD_BUTTON.Y]: [false, false, false, true, false, false],
  };

  it('chaque bouton seul : frame vide sauf A (action), B (cœur), X (appel), Y (spécial)', () => {
    for (const i of ALL_BUTTONS) {
      const f = gamepadToFrame(snap([i]), b);
      expect(actions(f), `bouton ${i}`).toEqual(EXPECTED[i] ?? [false, false, false, false, false, false]);
      if (!DPAD.includes(i as (typeof DPAD)[number])) {
        // hors croix : pas même de déplacement
        expect(f, `bouton ${i}`).toEqual({ ...emptyFrame(), attack: f.attack, interact: f.interact, revive: f.revive, special: f.special, call: f.call, heart: f.heart });
        expect([f.moveX, f.moveY], `bouton ${i}`).toEqual([0, 0]);
      }
    }
  });

  it('boutons « sans effet » = tous sauf A, B, X, Y, la croix (déplacement) : frame STRICTEMENT vide, y compris tous ensemble', () => {
    const inert = ALL_BUTTONS.filter((i) => ![PAD_BUTTON.A, PAD_BUTTON.B, PAD_BUTTON.X, PAD_BUTTON.Y, ...DPAD].includes(i as never));
    expect(inert).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 16]); // LB, RB, LT, RT, Back, Start, L3, R3, Home
    for (const i of inert) expect(gamepadToFrame(snap([i]), b), `bouton ${i}`).toEqual(emptyFrame());
    expect(gamepadToFrame(snap(inert), b)).toEqual(emptyFrame());
  });

  it('gâchettes analogiques (LT / RT à fond) : aucun effet en jeu', () => {
    const s = snap();
    const buttons = s.buttons.map((x, i) => (i === PAD_BUTTON.LT || i === PAD_BUTTON.RT ? { pressed: false, value: 1 } : x));
    expect(gamepadToFrame({ ...s, buttons }, b)).toEqual(emptyFrame());
  });

  it('la croix déplace mais ne déclenche aucune action', () => {
    for (const i of DPAD) {
      const f = gamepadToFrame(snap([i]), b);
      expect(actions(f), `bouton ${i}`).toEqual([false, false, false, false, false, false]);
      expect(Math.hypot(f.moveX, f.moveY)).toBeCloseTo(1);
    }
  });

  it('A + B + X + Y ensemble : action contextuelle, cœur, appel et spécial se cumulent sans parasite', () => {
    expect(actions(gamepadToFrame(snap([PAD_BUTTON.A, PAD_BUTTON.B, PAD_BUTTON.X, PAD_BUTTON.Y]), b))).toEqual([true, true, true, true, true, true]);
  });

  it('manette non standard (mapping vide) : mêmes indices 0 / 1 / 2 / 3, gâchettes sans effet', () => {
    for (const i of ALL_BUTTONS) {
      const f = gamepadToFrame(snap([i], [0, 0, 0, 0], ''), b);
      expect(actions(f), `bouton ${i}`).toEqual(EXPECTED[i] ?? [false, false, false, false, false, false]);
    }
  });

  it('bindings par défaut : seuls les indices 0 (A), 1 (B), 2 (X) et 3 (Y) sont liés à une action ; valides et gelés', () => {
    const used = new Set<number>();
    for (const a of ['attack', 'interact', 'revive', 'special', 'call', 'heart'] as const) for (const i of DEFAULT_BINDINGS[a].pad) used.add(i);
    expect([...used].sort()).toEqual([PAD_BUTTON.A, PAD_BUTTON.B, PAD_BUTTON.X, PAD_BUTTON.Y]);
    expect(DEFAULT_BINDINGS.heart.pad).toEqual([PAD_BUTTON.B]);
    expect(DEFAULT_BINDINGS.attack.pad).toEqual([PAD_BUTTON.A]);
    expect(DEFAULT_BINDINGS.interact.pad).toEqual([PAD_BUTTON.A]);
    expect(DEFAULT_BINDINGS.revive.pad).toEqual([PAD_BUTTON.A]);
    expect(DEFAULT_BINDINGS.special.pad).toEqual([PAD_BUTTON.Y]);
    expect(DEFAULT_BINDINGS.call.pad).toEqual([PAD_BUTTON.X]);
    expect(validateBindings(createDefaultBindings()).valid).toBe(true);
  });

  it('GamepadSource et InputManager.poll : même résultat de bout en bout (4 joueurs)', () => {
    let pads: (GamepadLike | null)[] = [];
    const handlers = new Map<string, Set<(e: unknown) => void>>();
    const target: KeyEventTarget = {
      addEventListener: (type, l) => {
        if (!handlers.has(type)) handlers.set(type, new Set());
        handlers.get(type)!.add(l);
      },
      removeEventListener: (type, l) => handlers.get(type)?.delete(l),
    };
    const keyboard = new KeyboardSource(undefined, target);
    keyboard.attach();
    const mgr = new InputManager({ keyboard, gamepadProvider: () => pads, storage: null, padEventTarget: null, playerCount: 4 });
    for (let i = 0; i < 4; i++) mgr.assignDevice(i as 0 | 1 | 2 | 3, { kind: 'gamepad', index: i });
    // J1 : B ; J2 : LB + RB + LT + RT + Back ; J3 : A ; J4 : X + Y
    pads = [
      padLike(0, [PAD_BUTTON.B]),
      padLike(1, [PAD_BUTTON.LB, PAD_BUTTON.RB, PAD_BUTTON.LT, PAD_BUTTON.RT, PAD_BUTTON.BACK]),
      padLike(2, [PAD_BUTTON.A]),
      padLike(3, [PAD_BUTTON.X, PAD_BUTTON.Y]),
    ];
    const inp = mgr.poll();
    expect(actions(inp[0]!)).toEqual([false, false, false, false, false, true]);
    expect(inp[1]).toEqual(emptyFrame());
    expect(actions(inp[2]!)).toEqual([true, true, true, false, false, false]);
    expect(actions(inp[3]!)).toEqual([false, false, false, true, true, false]);
    // la source seule (hors manager) donne la même chose
    expect(actions(new GamepadSource({ index: 0, provider: () => pads }).poll())).toEqual([false, false, false, false, false, true]);
    // Start (pause) n'est PAS une action de simulation : il est lu par GameScene.pollPadStart
    pads = [padLike(0, [PAD_BUTTON.START]), null, null, null];
    expect(mgr.poll()[0]).toEqual(emptyFrame());
    // une source distante n'est pas concernée par le schéma
    expect(new RemoteInputSource(1).poll()).toEqual(emptyFrame());
  });

  it('clavier : Espace / E = action, B = cœur, F ou X = spécial, C = appel', () => {
    const keys = (...c: string[]): Set<string> => new Set(c);
    expect(actions(keysToFrame(keys('Space'), b))).toEqual([true, true, true, false, false, false]);
    expect(actions(keysToFrame(keys('KeyE'), b))).toEqual([true, true, true, false, false, false]);
    expect(actions(keysToFrame(keys('KeyB'), b))).toEqual([false, false, false, false, false, true]);
    expect(actions(keysToFrame(keys('KeyF'), b))).toEqual([false, false, false, true, false, false]);
    expect(actions(keysToFrame(keys('KeyX'), b))).toEqual([false, false, false, true, false, false]);
    expect(actions(keysToFrame(keys('KeyC'), b))).toEqual([false, false, false, false, true, false]);
  });
});

describe('manette dans les menus : A confirme, B retour, croix et stick naviguent', () => {
  const b = createDefaultBindings();
  const held = (pressed: number[], axes: number[] = [0, 0, 0, 0]): MenuAction[] => [...gamepadToMenuHeld(snap(pressed, axes), b)].sort();

  it('A = confirmer, B = retour', () => {
    expect(held([PAD_BUTTON.A])).toEqual(['confirm']);
    expect(held([PAD_BUTTON.B])).toEqual(['back']);
  });

  it('croix : une intention par direction', () => {
    expect(held([PAD_BUTTON.DPAD_UP])).toEqual(['up']);
    expect(held([PAD_BUTTON.DPAD_DOWN])).toEqual(['down']);
    expect(held([PAD_BUTTON.DPAD_LEFT])).toEqual(['left']);
    expect(held([PAD_BUTTON.DPAD_RIGHT])).toEqual(['right']);
  });

  it('stick gauche : axe dominant', () => {
    expect(held([], [0, -1, 0, 0])).toEqual(['up']);
    expect(held([], [0, 1, 0, 0])).toEqual(['down']);
    expect(held([], [-1, 0.2, 0, 0])).toEqual(['left']);
    expect(held([], [1, -0.2, 0, 0])).toEqual(['right']);
  });

  it('X, Y, LB, RB, LT, RT, Back, Start, appuis de sticks, Home : aucune intention de menu', () => {
    const none = ALL_BUTTONS.filter((i) => ![PAD_BUTTON.A, PAD_BUTTON.B, ...DPAD].includes(i as never));
    for (const i of none) expect(held([i]), `bouton ${i}`).toEqual([]);
  });

  it('les 6 intentions de menu restent atteignables (rien d’orphelin)', () => {
    const reached = new Set<MenuAction>();
    for (const i of [PAD_BUTTON.A, PAD_BUTTON.B, ...DPAD]) for (const a of gamepadToMenuHeld(snap([i]), b)) reached.add(a);
    expect([...reached].sort()).toEqual([...MENU_ACTIONS].sort());
  });

  it('Back / Select reste détecté comme « activité » (réveil, « passer » du tutoriel lu par GameScene) mais sans effet en jeu ni en menu', () => {
    expect(padHasActivity(snap([PAD_BUTTON.BACK]))).toBe(true);
    expect(gamepadToFrame(snap([PAD_BUTTON.BACK]), b)).toEqual(emptyFrame());
    expect(held([PAD_BUTTON.BACK])).toEqual([]);
  });
});

describe('persistance : un ancien jeu de bindings sauvegardé ne ressuscite pas l ancien schéma', () => {
  function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
    const data = new Map<string, string>(Object.entries(initial));
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
  }
  const manager = (storage: StorageLike): InputManager => new InputManager({ storage, gamepadProvider: () => [], padEventTarget: null });

  /** Sauvegarde fidèle à l'ancien schéma (clé v1) : B / X d'attaque, B d'interaction, RB / RT de spécial, LB / LT d'appel. */
  const OLD_SAVE = JSON.stringify({
    version: 1,
    attack: { keys: ['Space', 'KeyE'], pad: [0, 2] },
    interact: { keys: ['Space', 'KeyE'], pad: [0, 1] },
    revive: { keys: ['Space', 'KeyE'], pad: [0, 1] },
    special: { keys: ['KeyF', 'KeyX'], pad: [3, 5, 7] },
    call: { keys: ['KeyC'], pad: [4, 6] },
    deadzone: 0.3,
  });

  it('la clé de stockage a changé (v2) et l ancienne reste distincte', () => {
    expect(BINDINGS_STORAGE_KEY).toBe('vaelorn.bindings.v2');
    expect(LEGACY_BINDINGS_STORAGE_KEY).toBe('vaelorn.bindings.v1');
    expect(BINDINGS_STORAGE_KEY).not.toBe(LEGACY_BINDINGS_STORAGE_KEY);
  });

  it('ancienne sauvegarde (clé v1) : IGNORÉE, bindings par défaut (LB / RB / LT / RT toujours sans effet, B = cœur)', () => {
    const storage = memoryStorage({ [LEGACY_BINDINGS_STORAGE_KEY]: OLD_SAVE });
    const mgr = manager(storage);
    expect(mgr.loadBindings()).toBe(false);
    expect(mgr.getBindings()).toEqual(DEFAULT_BINDINGS);
    for (const i of [PAD_BUTTON.LB, PAD_BUTTON.RB, PAD_BUTTON.LT, PAD_BUTTON.RT]) {
      expect(gamepadToFrame(snap([i]), mgr.getBindings()), `bouton ${i}`).toEqual(emptyFrame());
    }
    expect(actions(gamepadToFrame(snap([PAD_BUTTON.B]), mgr.getBindings()))).toEqual([false, false, false, false, false, true]);
    expect(actions(gamepadToFrame(snap([PAD_BUTTON.X]), mgr.getBindings()))).toEqual([false, false, false, false, true, false]);
  });

  it('la sauvegarde écrit la clé v2 et ne touche JAMAIS l ancienne clé v1', () => {
    const storage = memoryStorage({ [LEGACY_BINDINGS_STORAGE_KEY]: OLD_SAVE });
    const mgr = manager(storage);
    mgr.updateBindings({ deadzone: 0.4 });
    expect(mgr.saveBindings()).toBe(true);
    expect(storage.data.get(LEGACY_BINDINGS_STORAGE_KEY)).toBe(OLD_SAVE);
    expect(JSON.parse(storage.data.get(BINDINGS_STORAGE_KEY)!).deadzone).toBe(0.4);
    const again = manager(storage);
    expect(again.loadBindings()).toBe(true);
    expect(again.getBindings().deadzone).toBe(0.4);
    expect(again.getBindings().call.pad).toEqual([PAD_BUTTON.X]);
  });

  it('autoLoad + ancienne clé v1 seule : aucun conflit, aucun avertissement, défauts appliqués au premier poll', () => {
    const storage = memoryStorage({ [LEGACY_BINDINGS_STORAGE_KEY]: OLD_SAVE });
    const mgr = new InputManager({ storage, gamepadProvider: () => [padLike(0, [PAD_BUTTON.RB])], padEventTarget: null, autoLoad: true, player1Gamepad: true });
    expect(mgr.poll()[0]).toEqual(emptyFrame());
    expect(mgr.getBindings()).toEqual(DEFAULT_BINDINGS);
  });

  it('un ancien objet de bindings qui arriverait malgré tout par mergeBindings reste cohérent (validateBindings) et ne crée pas de conflit', () => {
    const merged = mergeBindings(createDefaultBindings(), JSON.parse(OLD_SAVE));
    expect(validateBindings(merged).valid).toBe(true);
    // c'est un remappage explicite (v2) : il est respecté tel quel, sans fusion parasite avec les défauts
    expect(merged.call.pad).toEqual([PAD_BUTTON.LB, PAD_BUTTON.LT]);
    expect(merged.special.pad).toEqual([PAD_BUTTON.Y, PAD_BUTTON.RB, PAD_BUTTON.RT]);
  });
});
