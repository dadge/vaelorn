/**
 * Tests de l'entrée « appeler » (bouton dédié) : bindings par défaut sans conflit, fusion de bindings personnalisés,
 * mapping clavier et manette → `ActionFrame.call`, propagation par les sources et l'InputManager.
 */
import { describe, expect, it } from 'vitest';
import { RemoteInputSource } from '../net/RemoteInputSource';
import { BUTTON_ACTIONS } from './actions';
import { createDefaultBindings, createKeyboardLayoutBindings, DEFAULT_BINDINGS, PAD_BUTTON } from './defaultBindings';
import { GamepadSource } from './GamepadSource';
import type { GamepadLike } from './GamepadSource';
import { InputManager } from './InputManager';
import { KeyboardSource } from './KeyboardSource';
import type { KeyEventTarget } from './KeyboardSource';
import {
  emptyFrame,
  frameHasActivity,
  gamepadToFrame,
  keysToFrame,
  mergeBindings,
  validateBindings,
} from './mapping';
import type { GamepadSnapshot } from './mapping';

const keys = (...codes: string[]): Set<string> => new Set(codes);

function snap(opts: { axes?: number[]; pressed?: number[]; values?: Record<number, number> } = {}): GamepadSnapshot {
  const buttons = Array.from({ length: 17 }, (_, i) => ({
    pressed: (opts.pressed ?? []).includes(i),
    value: opts.values?.[i] ?? ((opts.pressed ?? []).includes(i) ? 1 : 0),
  }));
  return { axes: opts.axes ?? [0, 0, 0, 0], buttons };
}

function padLike(index: number, opts: Parameters<typeof snap>[0] = {}): GamepadLike {
  return { index, id: `Pad ${index}`, connected: true, ...snap(opts) };
}

function makeManager(opts: ConstructorParameters<typeof InputManager>[0] = {}) {
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
  const mgr = new InputManager({ keyboard, gamepadProvider: () => pads, storage: null, padEventTarget: null, ...opts });
  return {
    mgr,
    keyboard,
    press: (code: string) => handlers.get('keydown')?.forEach((f) => f({ code, preventDefault() {} })),
    setPads: (p: (GamepadLike | null)[]) => {
      pads = p;
    },
  };
}

describe('appeler : bindings par défaut', () => {
  const b = createDefaultBindings();

  it('clavier C ; manette X seul ; bindings valides', () => {
    expect(b.call.keys).toEqual(['KeyC']);
    expect(b.call.pad).toEqual([PAD_BUTTON.X]);
    expect(validateBindings(b).valid).toBe(true);
    expect(DEFAULT_BINDINGS.call.keys).toEqual(['KeyC']);
    expect(Object.isFrozen(DEFAULT_BINDINGS.call)).toBe(true);
  });

  it('« call » fait partie des actions boutons énumérées', () => {
    expect(BUTTON_ACTIONS).toContain('call');
  });

  it('aucune touche d\'appel n\'est utilisée par une autre action, une direction ou un menu', () => {
    const others = [
      ...b.attack.keys,
      ...b.interact.keys,
      ...b.revive.keys,
      ...b.special.keys,
      ...Object.values(b.move.keys).flat(),
      ...b.menu.confirm.keys,
      ...b.menu.back.keys,
    ];
    for (const k of b.call.keys) expect(others, k).not.toContain(k);
  });

  it('aucun bouton de manette d\'appel n\'est utilisé par une autre action, la croix ou les menus', () => {
    const others = [
      ...b.attack.pad,
      ...b.interact.pad,
      ...b.revive.pad,
      ...b.special.pad,
      ...Object.values(b.move.padDpad),
      ...b.menu.confirm.pad,
      ...b.menu.back.pad,
    ];
    for (const i of b.call.pad) expect(others, String(i)).not.toContain(i);
  });

  it('une même touche / un même bouton ne déclenche jamais deux actions différentes avec call', () => {
    for (const code of b.call.keys) {
      const f = keysToFrame(keys(code), b);
      expect({ ...f, call: false }).toEqual(emptyFrame());
    }
    for (const i of b.call.pad) {
      const f = gamepadToFrame(snap({ pressed: [i] }), b);
      expect({ ...f, call: false }).toEqual(emptyFrame());
    }
  });

  it('les dispositions clavier prédéfinies conservent « C » et restent valides', () => {
    for (const layout of ['both', 'arrows', 'wasd'] as const) {
      const lb = createKeyboardLayoutBindings(layout);
      expect(lb.call.keys, layout).toEqual(['KeyC']);
      expect(validateBindings(lb).valid, layout).toBe(true);
    }
  });
});

describe('appeler : mapping clavier / manette → frame.call', () => {
  const b = createDefaultBindings();

  it('clavier : C déclenche call seulement ; Espace, E, F, X, flèches non', () => {
    const f = keysToFrame(keys('KeyC'), b);
    expect(f.call).toBe(true);
    expect(f.attack || f.interact || f.revive || f.special).toBe(false);
    for (const code of ['Space', 'KeyE', 'KeyF', 'KeyX', 'KeyW', 'ArrowUp', 'Enter', 'Escape']) {
      expect(keysToFrame(keys(code), b).call, code).toBe(false);
    }
  });

  it('clavier : C + déplacement + Espace se combinent', () => {
    const f = keysToFrame(keys('KeyC', 'KeyD', 'Space'), b);
    expect(f).toMatchObject({ call: true, moveX: 1, attack: true, interact: true, revive: true, special: false });
  });

  it('manette : X (seul) déclenche call, sans aucune autre action (X analogique au-delà du seuil)', () => {
    expect(gamepadToFrame(snap({ pressed: [PAD_BUTTON.X] }), b).call).toBe(true);
    expect(gamepadToFrame(snap({ values: { [PAD_BUTTON.X]: 0.8 } }), b).call).toBe(true);
    expect(gamepadToFrame(snap({ values: { [PAD_BUTTON.X]: 0.2 } }), b).call).toBe(false);
    const f = gamepadToFrame(snap({ pressed: [PAD_BUTTON.X] }), b);
    expect(f.attack || f.interact || f.revive || f.special).toBe(false);
  });

  it('manette : A, B, Y, LB, LT, RB, RT, la croix et Start ne déclenchent pas call', () => {
    for (const i of [PAD_BUTTON.A, PAD_BUTTON.B, PAD_BUTTON.Y, PAD_BUTTON.LB, PAD_BUTTON.LT, PAD_BUTTON.RB, PAD_BUTTON.RT, PAD_BUTTON.DPAD_UP, PAD_BUTTON.START]) {
      expect(gamepadToFrame(snap({ pressed: [i] }), b).call, String(i)).toBe(false);
    }
  });

  it('emptyFrame : call false ; frameHasActivity reconnaît un appel seul', () => {
    expect(emptyFrame().call).toBe(false);
    expect(frameHasActivity(emptyFrame())).toBe(false);
    expect(frameHasActivity({ ...emptyFrame(), call: true })).toBe(true);
    expect(frameHasActivity({ moveX: 0, moveY: 0, attack: false, interact: false, revive: false })).toBe(false); // ancien format sans call
  });
});

describe('appeler : fusion et validation de bindings personnalisés', () => {
  it('surcharge clavier seule : la manette par défaut est conservée, et inversement', () => {
    const b = createDefaultBindings();
    const m = mergeBindings(b, { call: { keys: ['KeyV'] } });
    expect(m.call.keys).toEqual(['KeyV']);
    expect(m.call.pad).toEqual([PAD_BUTTON.X]);
    const m2 = mergeBindings(b, { call: { pad: [10] } });
    expect(m2.call.keys).toEqual(['KeyC']);
    expect(m2.call.pad).toEqual([10]);
    expect(keysToFrame(keys('KeyV'), m).call).toBe(true);
    expect(keysToFrame(keys('KeyC'), m).call).toBe(false);
    expect(validateBindings(m).valid).toBe(true);
  });

  it('ancien JSON enregistré sans « call » : valeur par défaut reprise ; forme invalide ignorée', () => {
    const old = JSON.parse(JSON.stringify(createDefaultBindings())) as Record<string, unknown>;
    delete old.call;
    const merged = mergeBindings(createDefaultBindings(), old as never);
    expect(merged.call).toEqual(createDefaultBindings().call);
    expect(validateBindings(merged).valid).toBe(true);
    const bad = mergeBindings(createDefaultBindings(), { call: { keys: 'KeyV' as never, pad: [-1] } });
    expect(bad.call).toEqual(createDefaultBindings().call);
  });

  it('la fusion ne mute pas les bindings par défaut gelés et rend une copie indépendante', () => {
    const m = mergeBindings(DEFAULT_BINDINGS, { call: { keys: ['KeyV'] } });
    expect(DEFAULT_BINDINGS.call.keys).toEqual(['KeyC']);
    m.call.keys.push('KeyB');
    expect(DEFAULT_BINDINGS.call.keys).toEqual(['KeyC']);
  });

  it('liste vide refusée ; touche déjà utilisée par une direction refusée ; partage avec une autre action autorisé', () => {
    const empty = createDefaultBindings();
    empty.call.keys = [];
    expect(validateBindings(empty).errors).toContainEqual({ path: 'call.keys', code: 'empty' });
    const emptyPad = createDefaultBindings();
    emptyPad.call.pad = [];
    expect(validateBindings(emptyPad).errors).toContainEqual({ path: 'call.pad', code: 'empty' });
    const conflict = createDefaultBindings();
    conflict.call.keys = ['ArrowUp'];
    expect(validateBindings(conflict).valid).toBe(false);
    const missing = JSON.parse(JSON.stringify(createDefaultBindings())) as Record<string, unknown>;
    delete missing.call;
    expect(validateBindings(missing).errors).toContainEqual({ path: 'call', code: 'missing' });
  });
});

describe('appeler : sources et InputManager', () => {
  it('KeyboardSource, GamepadSource et RemoteInputSource propagent call', () => {
    const { keyboard, press } = makeManager();
    expect(keyboard.poll().call).toBe(false);
    press('KeyC');
    expect(keyboard.poll().call).toBe(true);
    const gp = new GamepadSource({ index: 0, provider: () => [padLike(0, { pressed: [PAD_BUTTON.X] })] });
    expect(gp.poll().call).toBe(true);
    const remote = new RemoteInputSource(1);
    remote.push({ ...emptyFrame(), call: true });
    expect(remote.poll().call).toBe(true);
    remote.setConnected(false);
    expect(remote.poll().call).toBe(false);
  });

  it('InputManager.poll : call arrive dans les TickInputs (clavier et manettes de 4 joueurs)', () => {
    const solo = makeManager({ playerCount: 1 });
    expect(solo.mgr.poll()[0]?.call).toBe(false);
    solo.press('KeyC');
    expect(solo.mgr.poll()[0]?.call).toBe(true);

    const four = makeManager({ playerCount: 4 });
    for (let i = 0; i < 4; i++) four.mgr.assignDevice(i as 0 | 1 | 2 | 3, { kind: 'gamepad', index: i });
    four.setPads([0, 1, 2, 3].map((i) => padLike(i, { pressed: i === 2 ? [PAD_BUTTON.X] : [] })));
    const inp = four.mgr.poll();
    expect(inp[2]?.call).toBe(true);
    expect([inp[0]?.call, inp[1]?.call, inp[3]?.call]).toEqual([false, false, false]);
  });
});
