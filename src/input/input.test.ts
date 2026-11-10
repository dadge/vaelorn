import { describe, expect, it, vi } from 'vitest';
import type { ActionFrame, PlayerId } from '../core/types';
import type { InputSource, MenuDevice, MenuDeviceProvider, MenuAction } from './actions';
import { createDefaultBindings, createKeyboardLayoutBindings, DEFAULT_BINDINGS, PAD_BUTTON } from './defaultBindings';
import {
  emptyFrame,
  gamepadToFrame,
  gamepadToMenuHeld,
  keysToFrame,
  keysToMenuHeld,
  mergeBindings,
  validateBindings,
} from './mapping';
import type { GamepadSnapshot } from './mapping';
import { KeyboardSource } from './KeyboardSource';
import type { KeyEventTarget } from './KeyboardSource';
import { GamepadSource } from './GamepadSource';
import type { GamepadLike } from './GamepadSource';
import { BINDINGS_STORAGE_KEY, InputManager } from './InputManager';
import type { StorageLike } from './InputManager';
import { EdgeRepeater, MenuNavigator } from './MenuNavigator';
import { LocalNetAdapter } from '../net/NetAdapter';
import { RemoteInputSource } from '../net/RemoteInputSource';

const R = Math.SQRT1_2;
const keys = (...codes: string[]): Set<string> => new Set(codes);

function snap(opts: { axes?: number[]; pressed?: number[]; values?: Record<number, number> } = {}): GamepadSnapshot {
  const buttons = Array.from({ length: 17 }, (_, i) => ({
    pressed: (opts.pressed ?? []).includes(i),
    value: opts.values?.[i] ?? ((opts.pressed ?? []).includes(i) ? 1 : 0),
  }));
  return { axes: opts.axes ?? [0, 0, 0, 0], buttons };
}

function padLike(index: number, opts: Parameters<typeof snap>[0] = {}, connected = true): GamepadLike {
  return { index, id: `Pad ${index}`, connected, ...snap(opts) };
}

describe('defaultBindings', () => {
  it('sont valides et gelés ; createDefaultBindings renvoie des copies indépendantes', () => {
    expect(validateBindings(DEFAULT_BINDINGS).valid).toBe(true);
    expect(Object.isFrozen(DEFAULT_BINDINGS)).toBe(true);
    const a = createDefaultBindings();
    a.attack.keys.push('KeyQ');
    expect(createDefaultBindings().attack.keys).not.toContain('KeyQ');
    expect(DEFAULT_BINDINGS.attack.keys).not.toContain('KeyQ');
    expect(DEFAULT_BINDINGS.deadzone).toBe(0.25);
  });

  it('dispositions clavier prédéfinies', () => {
    const arrows = createKeyboardLayoutBindings('arrows');
    expect(arrows.move.keys.up).toEqual(['ArrowUp']);
    expect(arrows.attack.keys).toEqual(['Space']);
    const wasd = createKeyboardLayoutBindings('wasd');
    expect(wasd.move.keys.left).toEqual(['KeyA']);
    expect(wasd.attack.keys).toEqual(['KeyE']);
    expect(validateBindings(arrows).valid).toBe(true);
    expect(validateBindings(wasd).valid).toBe(true);
  });
});

describe('keysToFrame', () => {
  const b = createDefaultBindings();

  it('aucune touche => frame vide', () => {
    expect(keysToFrame(keys(), b)).toEqual(emptyFrame());
  });

  it('flèches : haut = moveY -1, gauche = moveX -1', () => {
    expect(keysToFrame(keys('ArrowUp'), b)).toMatchObject({ moveX: 0, moveY: -1 });
    expect(keysToFrame(keys('ArrowDown'), b)).toMatchObject({ moveX: 0, moveY: 1 });
    expect(keysToFrame(keys('ArrowLeft'), b)).toMatchObject({ moveX: -1, moveY: 0 });
    expect(keysToFrame(keys('ArrowRight'), b)).toMatchObject({ moveX: 1, moveY: 0 });
  });

  it('diagonale normalisée (longueur 1)', () => {
    const f = keysToFrame(keys('ArrowUp', 'ArrowRight'), b);
    expect(f.moveX).toBeCloseTo(R);
    expect(f.moveY).toBeCloseTo(-R);
    expect(Math.hypot(f.moveX, f.moveY)).toBeCloseTo(1);
    const g = keysToFrame(keys('KeyS', 'KeyA'), b);
    expect(g.moveX).toBeCloseTo(-R);
    expect(g.moveY).toBeCloseTo(R);
  });

  it('flèches et WASD mélangées sur le même axe ne s\'additionnent pas', () => {
    const f = keysToFrame(keys('ArrowRight', 'KeyD'), b);
    expect(f.moveX).toBe(1);
  });

  it('directions opposées s\'annulent', () => {
    const f = keysToFrame(keys('ArrowLeft', 'ArrowRight', 'ArrowUp'), b);
    expect(f.moveX).toBe(0);
    expect(f.moveY).toBe(-1);
  });

  it('Espace => attack + interact + revive', () => {
    expect(keysToFrame(keys('Space'), b)).toEqual({
      moveX: 0,
      moveY: 0,
      attack: true,
      interact: true,
      revive: true,
      special: false,
      call: false,
      heart: false,
    });
  });

  it('disposition WASD + E', () => {
    const f = keysToFrame(keys('KeyW', 'KeyE'), b);
    expect(f).toEqual({ moveX: 0, moveY: -1, attack: true, interact: true, revive: true, special: false, call: false, heart: false });
    expect(keysToFrame(keys('KeyD'), b).moveX).toBe(1);
  });

  it('touche non liée ignorée', () => {
    expect(keysToFrame(keys('KeyZ', 'KeyP'), b)).toEqual(emptyFrame());
  });

  it('respecte un remap', () => {
    const custom = mergeBindings(b, { attack: { keys: ['KeyJ'] }, interact: { keys: ['KeyK'] } });
    const f = keysToFrame(keys('KeyJ'), custom);
    expect(f.attack).toBe(true);
    expect(f.interact).toBe(false);
    expect(keysToFrame(keys('Space'), custom).attack).toBe(false);
  });
});

describe('gamepadToFrame', () => {
  const b = createDefaultBindings();

  it('dead-zone : stick faible => aucun mouvement', () => {
    expect(gamepadToFrame(snap({ axes: [0.2, 0.1] }), b)).toEqual(emptyFrame());
    expect(gamepadToFrame(snap({ axes: [0.24, 0] }), b).moveX).toBe(0);
    expect(gamepadToFrame(snap({ axes: [-0.15, 0.15] }), b)).toEqual(emptyFrame());
  });

  it('au-delà de la dead-zone : direction correcte, amplitude croissante et bornée à 1', () => {
    const small = gamepadToFrame(snap({ axes: [0.5, 0] }), b);
    const big = gamepadToFrame(snap({ axes: [1, 0] }), b);
    expect(small.moveX).toBeGreaterThan(0);
    expect(small.moveX).toBeLessThan(big.moveX);
    expect(big.moveX).toBe(1);
    expect(big.moveY).toBe(0);
    const left = gamepadToFrame(snap({ axes: [-1, 0] }), b);
    expect(left.moveX).toBe(-1);
    const up = gamepadToFrame(snap({ axes: [0, -0.95] }), b);
    expect(up.moveY).toBeCloseTo(-1);
    const diag = gamepadToFrame(snap({ axes: [1, 1] }), b);
    expect(Math.hypot(diag.moveX, diag.moveY)).toBeLessThanOrEqual(1 + 1e-9);
    expect(diag.moveX).toBeCloseTo(diag.moveY);
  });

  it('dead-zone personnalisée via le paramètre', () => {
    expect(gamepadToFrame(snap({ axes: [0.4, 0] }), b, 0.5).moveX).toBe(0);
    expect(gamepadToFrame(snap({ axes: [0.4, 0] }), b, 0.1).moveX).toBeGreaterThan(0);
  });

  it('croix directionnelle : vitesse pleine, diagonale normalisée, prioritaire sur le stick', () => {
    expect(gamepadToFrame(snap({ pressed: [PAD_BUTTON.DPAD_LEFT] }), b)).toMatchObject({ moveX: -1, moveY: 0 });
    expect(gamepadToFrame(snap({ pressed: [PAD_BUTTON.DPAD_UP] }), b)).toMatchObject({ moveX: 0, moveY: -1 });
    const d = gamepadToFrame(snap({ pressed: [PAD_BUTTON.DPAD_DOWN, PAD_BUTTON.DPAD_RIGHT] }), b);
    expect(d.moveX).toBeCloseTo(R);
    expect(d.moveY).toBeCloseTo(R);
    const both = gamepadToFrame(snap({ axes: [-1, 0], pressed: [PAD_BUTTON.DPAD_RIGHT] }), b);
    expect(both.moveX).toBe(1);
  });

  it('A = attack + interact + revive', () => {
    expect(gamepadToFrame(snap({ pressed: [PAD_BUTTON.A] }), b)).toMatchObject({
      attack: true,
      interact: true,
      revive: true,
    });
  });

  it('X = appel seul (aucune action contextuelle)', () => {
    expect(gamepadToFrame(snap({ pressed: [PAD_BUTTON.X] }), b)).toMatchObject({
      attack: false,
      interact: false,
      revive: false,
      special: false,
      call: true,
    });
  });

  it('B = UTILISER LE CŒUR uniquement en jeu (et « retour » dans les menus) : aucune autre action', () => {
    expect(gamepadToFrame(snap({ pressed: [PAD_BUTTON.B] }), b)).toEqual({ ...emptyFrame(), heart: true });
  });

  it('bouton analogique (value) et indices manquants gérés', () => {
    expect(gamepadToFrame(snap({ values: { 0: 0.9 } }), b).attack).toBe(true);
    expect(gamepadToFrame(snap({ values: { 0: 0.2 } }), b).attack).toBe(false);
    const tiny: GamepadSnapshot = { axes: [], buttons: [] };
    expect(gamepadToFrame(tiny, b)).toEqual(emptyFrame());
    const nan: GamepadSnapshot = { axes: [NaN, Infinity], buttons: [] };
    expect(gamepadToFrame(nan, b)).toEqual(emptyFrame());
  });

  it('ne produit jamais -0', () => {
    const f = gamepadToFrame(snap({ axes: [-0.1, -0.1] }), b);
    expect(Object.is(f.moveX, -0)).toBe(false);
    expect(Object.is(f.moveY, -0)).toBe(false);
  });
});

describe('mergeBindings / validateBindings', () => {
  it('sans surcharge : copie profonde égale aux défauts', () => {
    const m = mergeBindings(DEFAULT_BINDINGS);
    expect(m).toEqual(DEFAULT_BINDINGS);
    expect(m).not.toBe(DEFAULT_BINDINGS);
    expect(m.attack.keys).not.toBe(DEFAULT_BINDINGS.attack.keys);
    m.attack.keys.push('KeyX');
    expect(DEFAULT_BINDINGS.attack.keys).not.toContain('KeyX');
  });

  it('les tableaux sont remplacés (pas concaténés), le reste est conservé', () => {
    const m = mergeBindings(DEFAULT_BINDINGS, {
      attack: { keys: ['KeyJ'] },
      move: { keys: { up: ['KeyI'] } },
      deadzone: 0.4,
    });
    expect(m.attack.keys).toEqual(['KeyJ']);
    expect(m.attack.pad).toEqual(DEFAULT_BINDINGS.attack.pad);
    expect(m.move.keys.up).toEqual(['KeyI']);
    expect(m.move.keys.down).toEqual(DEFAULT_BINDINGS.move.keys.down);
    expect(m.deadzone).toBe(0.4);
    expect(validateBindings(m).valid).toBe(true);
  });

  it('ignore les valeurs de forme invalide (données non fiables) et déduplique', () => {
    const junk = {
      attack: { keys: [1, 2], pad: 'x' },
      interact: { keys: ['KeyU', 'KeyU'] },
      move: { padAxes: { x: -3 }, keys: 'nope' },
      deadzone: 5,
    } as unknown as Parameters<typeof mergeBindings>[1];
    const m = mergeBindings(DEFAULT_BINDINGS, junk);
    expect(m.attack).toEqual(DEFAULT_BINDINGS.attack);
    expect(m.interact.keys).toEqual(['KeyU']);
    expect(m.move.padAxes).toEqual(DEFAULT_BINDINGS.move.padAxes);
    expect(m.move.keys).toEqual(DEFAULT_BINDINGS.move.keys);
    expect(m.deadzone).toBe(0.25);
    expect(mergeBindings(DEFAULT_BINDINGS, null)).toEqual(DEFAULT_BINDINGS);
    expect(mergeBindings(DEFAULT_BINDINGS, 42 as never)).toEqual(DEFAULT_BINDINGS);
  });

  it('ne mute pas ses arguments', () => {
    const over = { attack: { keys: ['KeyJ'] } };
    const frozenOver = JSON.parse(JSON.stringify(over)) as typeof over;
    mergeBindings(DEFAULT_BINDINGS, over);
    expect(over).toEqual(frozenOver);
  });

  it('validateBindings : défauts valides, JSON aller-retour valide', () => {
    expect(validateBindings(createDefaultBindings())).toEqual({ valid: true, errors: [] });
    expect(validateBindings(JSON.parse(JSON.stringify(createDefaultBindings()))).valid).toBe(true);
  });

  it('validateBindings : types invalides', () => {
    expect(validateBindings(null).valid).toBe(false);
    expect(validateBindings('x').valid).toBe(false);
    expect(validateBindings([]).valid).toBe(false);
    expect(validateBindings({}).valid).toBe(false);
  });

  it('validateBindings : liste vide, champ manquant, plage', () => {
    const b = createDefaultBindings();
    b.attack.keys = [];
    const v1 = validateBindings(b);
    expect(v1.valid).toBe(false);
    expect(v1.errors).toContainEqual({ path: 'attack.keys', code: 'empty' });

    const b2 = createDefaultBindings() as unknown as Record<string, unknown>;
    delete b2.interact;
    expect(validateBindings(b2).errors).toContainEqual({ path: 'interact', code: 'missing' });

    const b3 = createDefaultBindings();
    b3.deadzone = 1.5;
    expect(validateBindings(b3).errors).toContainEqual({ path: 'deadzone', code: 'range' });

    const b4 = createDefaultBindings();
    b4.move.padAxes = { x: 1, y: 1 };
    expect(validateBindings(b4).errors).toContainEqual({ path: 'move.padAxes', code: 'conflict' });
  });

  it('validateBindings : conflits direction/action, mais partage attack/interact/revive autorisé', () => {
    const b = createDefaultBindings();
    b.attack.keys = ['ArrowUp'];
    const v = validateBindings(b);
    expect(v.valid).toBe(false);
    expect(v.errors).toContainEqual({ path: 'keys:ArrowUp', code: 'conflict' });

    const c = createDefaultBindings();
    c.move.keys.up = ['KeyX'];
    c.move.keys.down = ['KeyX'];
    expect(validateBindings(c).errors).toContainEqual({ path: 'keys:KeyX', code: 'conflict' });

    const d = createDefaultBindings();
    d.attack.pad = [PAD_BUTTON.DPAD_UP];
    expect(validateBindings(d).errors).toContainEqual({ path: `pad:${PAD_BUTTON.DPAD_UP}`, code: 'conflict' });

    // Espace est partagé par attack/interact/revive/menu dans les défauts : valide.
    expect(validateBindings(createDefaultBindings()).valid).toBe(true);
  });
});

describe('actions de menu (fonctions pures)', () => {
  const b = createDefaultBindings();
  it('clavier', () => {
    expect([...keysToMenuHeld(keys('ArrowUp', 'Enter'), b)].sort()).toEqual(['confirm', 'up']);
    expect(keysToMenuHeld(keys('Space'), b).has('confirm')).toBe(true);
    expect(keysToMenuHeld(keys('Escape'), b).has('back')).toBe(true);
    expect(keysToMenuHeld(keys('KeyS'), b).has('down')).toBe(true);
    expect(keysToMenuHeld(keys('ArrowUp', 'ArrowDown'), b).size).toBe(0);
  });
  it('manette : croix, stick (axe dominant), A/B', () => {
    expect(gamepadToMenuHeld(snap({ pressed: [PAD_BUTTON.DPAD_DOWN] }), b).has('down')).toBe(true);
    expect(gamepadToMenuHeld(snap({ axes: [0.9, 0.6] }), b)).toEqual(new Set(['right']));
    expect(gamepadToMenuHeld(snap({ axes: [0.3, 0.2] }), b).size).toBe(0);
    expect(gamepadToMenuHeld(snap({ axes: [0, -0.8] }), b)).toEqual(new Set(['up']));
    expect(gamepadToMenuHeld(snap({ pressed: [PAD_BUTTON.A] }), b).has('confirm')).toBe(true);
    expect(gamepadToMenuHeld(snap({ pressed: [PAD_BUTTON.B] }), b).has('back')).toBe(true);
  });
});

describe('KeyboardSource', () => {
  function fakeTarget() {
    const handlers = new Map<string, Set<(e: unknown) => void>>();
    const target: KeyEventTarget = {
      addEventListener: (t, l) => {
        if (!handlers.has(t)) handlers.set(t, new Set());
        handlers.get(t)!.add(l);
      },
      removeEventListener: (t, l) => {
        handlers.get(t)?.delete(l);
      },
    };
    const emit = (t: string, e: unknown): void => handlers.get(t)?.forEach((h) => h(e));
    const count = (t: string): number => handlers.get(t)?.size ?? 0;
    return { target, emit, count };
  }
  const ev = (code: string, extra: Record<string, unknown> = {}) => ({ code, preventDefault: vi.fn(), ...extra });

  it('attach/detach idempotents, état tenu, preventDefault sur flèches/espace', () => {
    const { target, emit, count } = fakeTarget();
    const kb = new KeyboardSource(undefined, target);
    kb.attach();
    kb.attach();
    expect(count('keydown')).toBe(1);
    const up = ev('ArrowUp');
    emit('keydown', up);
    expect(up.preventDefault).toHaveBeenCalled();
    const kw = ev('KeyW');
    emit('keydown', kw);
    expect(kw.preventDefault).not.toHaveBeenCalled();
    expect(kb.poll().moveY).toBe(-1);
    emit('keyup', ev('ArrowUp'));
    emit('keyup', ev('KeyW'));
    expect(kb.poll()).toEqual(emptyFrame());
    kb.detach();
    expect(count('keydown')).toBe(0);
    expect(count('keyup')).toBe(0);
    expect(count('blur')).toBe(0);
    emit('keydown', ev('Space'));
    expect(kb.poll()).toEqual(emptyFrame());
  });

  it('vide l\'état au blur', () => {
    const { target, emit } = fakeTarget();
    const kb = new KeyboardSource(undefined, target);
    kb.attach();
    emit('keydown', ev('Space'));
    expect(kb.poll().attack).toBe(true);
    emit('blur', {});
    expect(kb.poll()).toEqual(emptyFrame());
  });

  it('pas de preventDefault dans un champ de saisie', () => {
    const { target, emit } = fakeTarget();
    const kb = new KeyboardSource(undefined, target);
    kb.attach();
    const e = ev('Space', { target: { tagName: 'INPUT' } });
    emit('keydown', e);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it('drainTapped rattrape un appui plus court qu\'une frame', () => {
    const { target, emit } = fakeTarget();
    const kb = new KeyboardSource(undefined, target);
    kb.attach();
    emit('keydown', ev('Enter'));
    emit('keyup', ev('Enter'));
    expect(kb.drainTapped().has('Enter')).toBe(true);
    expect(kb.drainTapped().has('Enter')).toBe(false);
  });

  it('importable et utilisable sans window (Node) : attach/detach sont des no-op', () => {
    const kb = new KeyboardSource();
    expect(() => {
      kb.attach();
      kb.poll();
      kb.detach();
    }).not.toThrow();
    expect(kb.connected()).toBe(true);
  });
});

describe('GamepadSource', () => {
  it('lit la manette ciblée à chaque poll, gère connexion/déconnexion et nom', () => {
    let pads: (GamepadLike | null)[] = [padLike(0, { pressed: [PAD_BUTTON.A] })];
    const src = new GamepadSource({ index: 0, provider: () => pads });
    expect(src.connected()).toBe(true);
    expect(src.getName()).toBe('Pad 0');
    expect(src.poll().attack).toBe(true);
    pads = [padLike(0, { axes: [1, 0] })];
    expect(src.poll()).toMatchObject({ moveX: 1, attack: false });
    pads = [null];
    expect(src.connected()).toBe(false);
    expect(src.poll()).toEqual(emptyFrame());
    expect(src.getName()).toBeNull();
  });

  it('indice configurable, "any" = première connectée, creux et connected=false ignorés', () => {
    const pads: (GamepadLike | null)[] = [null, padLike(1, { pressed: [PAD_BUTTON.A] }), padLike(2, {}, false)];
    const src = new GamepadSource({ index: 2, provider: () => pads });
    expect(src.connected()).toBe(false);
    src.setIndex(1);
    expect(src.getIndex()).toBe(1);
    expect(src.poll().attack).toBe(true);
    src.setIndex('any');
    expect(src.resolve()?.index).toBe(1);
  });

  it('un fournisseur qui lève une exception = aucune manette', () => {
    const src = new GamepadSource({
      index: 0,
      provider: () => {
        throw new Error('SecurityError');
      },
    });
    expect(src.connected()).toBe(false);
    expect(src.poll()).toEqual(emptyFrame());
  });

  it('le fournisseur par défaut ne plante pas sous Node', () => {
    const src = new GamepadSource({ index: 0 });
    expect(src.connected()).toBe(false);
    expect(src.poll()).toEqual(emptyFrame());
  });
});

// ───────────────────────────── MenuNavigator ─────────────────────────────

describe('EdgeRepeater', () => {
  it('front montant unique, puis répétition après le délai initial, puis à intervalle régulier', () => {
    const r = new EdgeRepeater<string>(400, 100);
    const held = new Set(['down']);
    expect(r.update(held, 0)).toEqual(['down']);
    expect(r.update(held, 16)).toEqual([]);
    expect(r.update(held, 399)).toEqual([]);
    expect(r.update(held, 400)).toEqual(['down']);
    expect(r.update(held, 450)).toEqual([]);
    expect(r.update(held, 500)).toEqual(['down']);
    expect(r.update(held, 5000)).toEqual(['down']); // pas de rafale après une longue pause
    expect(r.update(held, 5001)).toEqual([]);
  });

  it('relâcher puis ré-appuyer redéclenche immédiatement', () => {
    const r = new EdgeRepeater<string>(400, 100);
    expect(r.update(new Set(['up']), 0)).toEqual(['up']);
    expect(r.update(new Set(), 10)).toEqual([]);
    expect(r.update(new Set(['up']), 20)).toEqual(['up']);
  });

  it('suppress : ignoré tant que non relâché', () => {
    const r = new EdgeRepeater<string>(400, 100);
    r.suppress(new Set(['a']));
    expect(r.update(new Set(['a']), 0)).toEqual([]);
    expect(r.update(new Set(['a']), 10000)).toEqual([]);
    expect(r.update(new Set(), 10001)).toEqual([]);
    expect(r.update(new Set(['a']), 10002)).toEqual(['a']);
  });

  it('prédicat repeatable', () => {
    const r = new EdgeRepeater<string>(100, 50, (k) => k !== 'ok');
    const held = new Set(['ok', 'move']);
    expect(r.update(held, 0)).toEqual(['ok', 'move']);
    expect(r.update(held, 120)).toEqual(['move']);
  });
});

/** Fournisseur de menu factice contrôlable. */
class FakeMenu implements MenuDeviceProvider {
  devices: MenuDevice[] = [];
  set(id: string, playerId: PlayerId | null, ...held: MenuAction[]): void {
    this.devices = this.devices.filter((d) => d.id !== id);
    this.devices.push({ id, playerId, held: new Set(held) });
  }
  remove(id: string): void {
    this.devices = this.devices.filter((d) => d.id !== id);
  }
  getMenuDevices(): MenuDevice[] {
    return this.devices;
  }
}

describe('MenuNavigator', () => {
  it('front montant unique, puis répétition des directions après le délai', () => {
    const fake = new FakeMenu();
    const nav = new MenuNavigator(fake, { initialDelayMs: 400, repeatMs: 100 });
    fake.set('keyboard', 0);
    expect(nav.pollMenu(0)).toEqual([]);
    fake.set('keyboard', 0, 'down');
    expect(nav.pollMenu(10)).toEqual([{ playerId: 0, source: 'keyboard', action: 'down' }]);
    expect(nav.pollMenu(30)).toEqual([]);
    expect(nav.pollMenu(300)).toEqual([]);
    expect(nav.pollMenu(410)).toEqual([{ playerId: 0, source: 'keyboard', action: 'down' }]);
    expect(nav.pollMenu(450)).toEqual([]);
    expect(nav.pollMenu(520)).toHaveLength(1);
    fake.set('keyboard', 0);
    expect(nav.pollMenu(530)).toEqual([]);
  });

  it('confirm/back ne se répètent pas', () => {
    const fake = new FakeMenu();
    const nav = new MenuNavigator(fake, { initialDelayMs: 100, repeatMs: 50 });
    fake.set('keyboard', 0, 'confirm');
    expect(nav.pollMenu(0)).toHaveLength(1);
    expect(nav.pollMenu(150)).toEqual([]);
    expect(nav.pollMenu(1000)).toEqual([]);
  });

  it('suit chaque périphérique séparément et porte le playerId', () => {
    const fake = new FakeMenu();
    const nav = new MenuNavigator(fake);
    fake.set('keyboard', 0);
    fake.set('gamepad:0', 1);
    nav.pollMenu(0);
    fake.set('keyboard', 0, 'up');
    fake.set('gamepad:0', 1, 'confirm', 'left');
    const intents = nav.pollMenu(16);
    expect(intents).toContainEqual({ playerId: 0, source: 'keyboard', action: 'up' });
    expect(intents).toContainEqual({ playerId: 1, source: 'gamepad:0', action: 'confirm' });
    expect(intents).toContainEqual({ playerId: 1, source: 'gamepad:0', action: 'left' });
    expect(intents).toHaveLength(3);
  });

  it('supprime ce qui est déjà tenu à la création (Entrée de la scène précédente)', () => {
    const fake = new FakeMenu();
    fake.set('keyboard', 0, 'confirm');
    const nav = new MenuNavigator(fake);
    expect(nav.pollMenu(0)).toEqual([]);
    expect(nav.pollMenu(50)).toEqual([]);
    fake.set('keyboard', 0);
    nav.pollMenu(100);
    fake.set('keyboard', 0, 'confirm');
    expect(nav.pollMenu(150)).toHaveLength(1);
  });

  it('suppressHeld: false déclenche immédiatement', () => {
    const fake = new FakeMenu();
    fake.set('keyboard', 0, 'confirm');
    const nav = new MenuNavigator(fake, { suppressHeld: false });
    expect(nav.pollMenu(0)).toHaveLength(1);
  });

  it('périphérique débranché puis rebranché : nouveau front montant', () => {
    const fake = new FakeMenu();
    const nav = new MenuNavigator(fake, { suppressHeld: false });
    fake.set('gamepad:0', 1, 'confirm');
    expect(nav.pollMenu(0)).toHaveLength(1);
    fake.remove('gamepad:0');
    nav.pollMenu(10);
    fake.set('gamepad:0', 1, 'confirm');
    expect(nav.pollMenu(20)).toHaveLength(1);
  });
});

// ───────────────────────────── InputManager ─────────────────────────────

/** Fabrique un InputManager de test avec clavier factice et manettes pilotables. */
function makeManager(opts: ConstructorParameters<typeof InputManager>[0] = {}) {
  let pads: (GamepadLike | null)[] = [];
  const target = (() => {
    const h = new Map<string, Set<(e: unknown) => void>>();
    const t: KeyEventTarget = {
      addEventListener: (type, l) => {
        if (!h.has(type)) h.set(type, new Set());
        h.get(type)!.add(l);
      },
      removeEventListener: (type, l) => h.get(type)?.delete(l),
    };
    return { t, emit: (type: string, e: unknown) => h.get(type)?.forEach((f) => f(e)) };
  })();
  const keyboard = new KeyboardSource(undefined, target.t);
  keyboard.attach();
  const mgr = new InputManager({ keyboard, gamepadProvider: () => pads, storage: null, ...opts });
  return {
    mgr,
    keyboard,
    press: (code: string) => target.emit('keydown', { code, preventDefault() {} }),
    release: (code: string) => target.emit('keyup', { code, preventDefault() {} }),
    setPads: (p: (GamepadLike | null)[]) => {
      pads = p;
    },
  };
}

describe('InputManager : attributions', () => {
  it('1 joueur : clavier par défaut, "première source utilisée"', () => {
    const { mgr } = makeManager({ playerCount: 1 });
    const a = mgr.getAssignments();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ playerId: 0, label: 'keyboard', connected: true, anyDevice: true });
  });

  it('2, 3, 4 joueurs : J1 clavier, J2..J4 manettes (indices 0..2), connected selon détection', () => {
    const { mgr, setPads } = makeManager();
    mgr.setPlayerCount(2);
    expect(mgr.getAssignments()).toEqual([
      { playerId: 0, label: 'keyboard', connected: true, assigned: true },
      { playerId: 1, label: 'gamepad', connected: false, assigned: true },
    ]);
    setPads([padLike(0)]);
    expect(mgr.getAssignments()[1]).toMatchObject({
      playerId: 1,
      label: 'gamepad',
      gamepadIndex: 0,
      gamepadName: 'Pad 0',
      connected: true,
    });
    mgr.setPlayerCount(3);
    expect(mgr.getAssignments().map((x) => [x.playerId, x.label, x.connected])).toEqual([
      [0, 'keyboard', true],
      [1, 'gamepad', true],
      [2, 'gamepad', false],
    ]);
    setPads([padLike(0), padLike(1), padLike(2)]);
    mgr.setPlayerCount(4);
    const a4 = mgr.getAssignments();
    expect(a4).toHaveLength(4);
    expect(a4.slice(1).map((x) => x.gamepadIndex)).toEqual([0, 1, 2]);
    expect(a4.every((x) => x.connected)).toBe(true);
  });

  it('setPlayerCount borne à 1..4 et arrondit', () => {
    const { mgr } = makeManager();
    mgr.setPlayerCount(9);
    expect(mgr.getPlayerCount()).toBe(4);
    mgr.setPlayerCount(0);
    expect(mgr.getPlayerCount()).toBe(1);
    mgr.setPlayerCount(2.9);
    expect(mgr.getPlayerCount()).toBe(2);
    mgr.setPlayerCount(NaN);
    expect(mgr.getPlayerCount()).toBe(1);
  });

  it('player1Gamepad : J1..J4 = manettes 0..3', () => {
    const { mgr } = makeManager({ player1Gamepad: true, playerCount: 2 });
    const a = mgr.getAssignments();
    expect(a.map((x) => x.label)).toEqual(['gamepad', 'gamepad']);
    mgr.setPlayerCount(1);
    expect(mgr.getAssignments()[0]).toMatchObject({ label: 'gamepad', connected: false });
    expect(mgr.getAssignments()[0].anyDevice).toBeUndefined();
  });

  it('setGamepadIndex force un indice, null revient au défaut', () => {
    const { mgr, setPads } = makeManager({ playerCount: 2 });
    setPads([null, null, padLike(2, { pressed: [PAD_BUTTON.A] })]);
    expect(mgr.getAssignments()[1].connected).toBe(false);
    mgr.setGamepadIndex(1, 2);
    expect(mgr.getAssignments()[1]).toMatchObject({ gamepadIndex: 2, connected: true });
    expect(mgr.poll()[1]?.attack).toBe(true);
    mgr.setGamepadIndex(1, null);
    expect(mgr.getAssignments()[1].connected).toBe(false);
  });
});

describe('InputManager : poll', () => {
  it('ne retourne que les joueurs actifs ; frames fraîches', () => {
    const { mgr, press } = makeManager({ playerCount: 2 });
    press('ArrowRight');
    const t = mgr.poll();
    expect(Object.keys(t).sort()).toEqual(['0', '1']);
    expect(t[0]?.moveX).toBe(1);
    expect(t[1]).toEqual(emptyFrame());
    expect(t[2]).toBeUndefined();
    const t2 = mgr.poll();
    expect(t2[0]).not.toBe(t[0]);
    mgr.setPlayerCount(1);
    expect(Object.keys(mgr.poll())).toEqual(['0']);
  });

  it('J1 clavier (Espace) + J2 manette (A) avec sources factices', () => {
    const { mgr, press, setPads } = makeManager({ playerCount: 2 });
    setPads([padLike(0, { axes: [-1, 0], pressed: [PAD_BUTTON.A] })]);
    press('Space');
    const t = mgr.poll();
    expect(t[0]).toMatchObject({ attack: true, interact: true, revive: true });
    expect(t[1]).toMatchObject({ moveX: -1, attack: true });
  });

  it('manette débranchée : frame vide (la clé reste présente)', () => {
    const { mgr } = makeManager({ playerCount: 3 });
    const t = mgr.poll();
    expect(t[1]).toEqual(emptyFrame());
    expect(t[2]).toEqual(emptyFrame());
  });

  it('manettes attribuées par indice stable : débrancher la manette 0 ne décale pas J3', () => {
    const { mgr, setPads } = makeManager({ playerCount: 3 });
    setPads([padLike(0, { pressed: [PAD_BUTTON.A] }), padLike(1, { pressed: [PAD_BUTTON.Y] })]);
    let t = mgr.poll();
    expect(t[1]?.interact).toBe(true);
    expect(t[2]).toMatchObject({ attack: false, interact: false, special: true });
    setPads([null, padLike(1, { pressed: [PAD_BUTTON.Y] })]);
    t = mgr.poll();
    expect(t[1]).toEqual(emptyFrame());
    expect(t[2]).toMatchObject({ attack: false, interact: false, special: true });
  });

  it('solo : première source utilisée (clavier ou manette), la source active garde la main', () => {
    const { mgr, press, release, setPads } = makeManager({ playerCount: 1 });
    setPads([padLike(0, { axes: [0, 1] })]); // manette tenue vers le bas, clavier au repos
    // clavier actif par défaut mais au repos → bascule sur la manette qui a de l'activité
    expect(mgr.poll()[0]).toMatchObject({ moveY: 1 });
    expect(mgr.getAssignments()[0]).toMatchObject({ label: 'gamepad', gamepadIndex: 0, anyDevice: true });
    // le clavier est pressé alors que la manette est toujours active : la manette garde la main
    press('ArrowLeft');
    expect(mgr.poll()[0]).toMatchObject({ moveX: 0, moveY: 1 });
    // la manette revient au repos : bascule sur le clavier
    setPads([padLike(0)]);
    expect(mgr.poll()[0]).toMatchObject({ moveX: -1 });
    expect(mgr.getAssignments()[0].label).toBe('keyboard');
    release('ArrowLeft');
    expect(mgr.poll()[0]).toEqual(emptyFrame());
  });

  it('poll sans aucune manette ni fenêtre ne plante pas (Node)', () => {
    const m = new InputManager({ playerCount: 4, storage: null });
    expect(() => m.poll()).not.toThrow();
    expect(Object.keys(m.poll())).toHaveLength(4);
    m.detach();
  });
});

describe('InputManager : registerSource', () => {
  const fixed = (frame: ActionFrame, connected = true): InputSource => ({
    kind: 'touch',
    id: 'touch:test',
    poll: () => ({ ...frame }),
    connected: () => connected,
  });

  it('remplace l\'attribution par défaut et apparaît dans getAssignments', () => {
    const { mgr } = makeManager({ playerCount: 2 });
    mgr.registerSource(1, fixed({ ...emptyFrame(), moveX: -1, attack: true }));
    const t = mgr.poll();
    expect(t[1]).toMatchObject({ moveX: -1, attack: true });
    expect(mgr.getAssignments()[1]).toMatchObject({ playerId: 1, label: 'touch', connected: true });
    expect(mgr.getRegisteredSource(1)?.id).toBe('touch:test');
  });

  it('source enregistrée déconnectée => frame vide ; unregister restaure le défaut', () => {
    const { mgr } = makeManager({ playerCount: 2 });
    mgr.registerSource(1, fixed({ ...emptyFrame(), attack: true }, false));
    expect(mgr.poll()[1]).toEqual(emptyFrame());
    mgr.unregisterSource(1);
    expect(mgr.getAssignments()[1].label).toBe('gamepad');
  });

  it('J1 enregistré désactive le mode solo clavier/manette', () => {
    const { mgr, press } = makeManager({ playerCount: 1 });
    mgr.registerSource(0, fixed({ ...emptyFrame(), interact: true }));
    press('ArrowUp');
    expect(mgr.poll()[0]).toMatchObject({ interact: true, moveY: 0 });
    expect(mgr.getAssignments()[0].anyDevice).toBeUndefined();
  });

  it('RemoteInputSource (réseau) : rejoue la dernière frame, vide si déconnecté', () => {
    const { mgr } = makeManager({ playerCount: 3 });
    const remote = new RemoteInputSource(2);
    mgr.registerSource(2, remote);
    expect(mgr.getAssignments()[2]).toMatchObject({ label: 'network', connected: true });
    remote.push({ moveX: 1, moveY: 0, attack: true, interact: false, revive: false });
    expect(mgr.poll()[2]).toMatchObject({ moveX: 1, attack: true });
    expect(mgr.poll()[2]).toMatchObject({ moveX: 1, attack: true });
    remote.setConnected(false);
    expect(mgr.poll()[2]).toEqual(emptyFrame());
    expect(mgr.getAssignments()[2].connected).toBe(false);
  });
});

describe('InputManager : menus', () => {
  it('getMenuDevices rattache le clavier à J1 et chaque manette à son joueur', () => {
    const { mgr, press, setPads } = makeManager({ playerCount: 3 });
    setPads([padLike(0, { pressed: [PAD_BUTTON.A] }), padLike(1)]);
    press('ArrowUp');
    const devices = mgr.getMenuDevices();
    const kb = devices.find((d) => d.id === 'keyboard');
    expect(kb?.playerId).toBe(0);
    expect(kb?.held.has('up')).toBe(true);
    const p0 = devices.find((d) => d.id === 'gamepad:0');
    expect(p0?.playerId).toBe(1);
    expect(p0?.held.has('confirm')).toBe(true);
    expect(devices.find((d) => d.id === 'gamepad:1')?.playerId).toBe(2);
  });

  it('solo : la première manette est J1 ; avec player1Gamepad le clavier n\'est plus rattaché', () => {
    const solo = makeManager({ playerCount: 1 });
    solo.setPads([padLike(3)]);
    expect(solo.mgr.getMenuDevices().find((d) => d.id === 'gamepad:3')?.playerId).toBe(0);
    const p1 = makeManager({ playerCount: 2, player1Gamepad: true });
    p1.setPads([padLike(0)]);
    const dev = p1.mgr.getMenuDevices();
    expect(dev.find((d) => d.id === 'keyboard')?.playerId).toBeNull();
    expect(dev.find((d) => d.id === 'gamepad:0')?.playerId).toBe(0);
  });

  it('MenuNavigator + InputManager : un appui bref au clavier est rattrapé, une seule intention', () => {
    const { mgr, press, release } = makeManager({ playerCount: 1 });
    const nav = new MenuNavigator(mgr);
    press('Enter');
    release('Enter'); // plus court qu'une frame
    expect(nav.pollMenu(0)).toEqual([{ playerId: 0, source: 'keyboard', action: 'confirm' }]);
    expect(nav.pollMenu(16)).toEqual([]);
  });
});

describe('InputManager : bindings', () => {
  function memoryStorage(initial?: string): StorageLike & { data: Map<string, string> } {
    const data = new Map<string, string>();
    if (initial !== undefined) data.set(BINDINGS_STORAGE_KEY, initial);
    return {
      data,
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => void data.set(k, v),
    };
  }

  it('getBindings renvoie une copie ; setBindings valide et applique', () => {
    const { mgr, press } = makeManager({ playerCount: 1 });
    const b = mgr.getBindings();
    b.attack.keys.push('KeyZ');
    expect(mgr.getBindings().attack.keys).not.toContain('KeyZ');

    const custom = mgr.getBindings();
    custom.attack.keys = ['KeyJ'];
    expect(mgr.setBindings(custom).valid).toBe(true);
    press('KeyJ');
    expect(mgr.poll()[0]?.attack).toBe(true);
  });

  it('setBindings refuse des bindings invalides (aucun changement)', () => {
    const { mgr } = makeManager();
    const bad = mgr.getBindings();
    bad.attack.keys = ['ArrowUp'];
    const v = mgr.setBindings(bad);
    expect(v.valid).toBe(false);
    expect(mgr.getBindings().attack.keys).toEqual(DEFAULT_BINDINGS.attack.keys);
  });

  it('updateBindings fusionne sur les bindings courants et propage aux manettes', () => {
    const { mgr, setPads } = makeManager({ playerCount: 2 });
    setPads([padLike(0, { pressed: [PAD_BUTTON.B] })]);
    expect(mgr.poll()[1]?.attack).toBe(false);
    expect(mgr.updateBindings({ attack: { pad: [PAD_BUTTON.B] } }).valid).toBe(true);
    expect(mgr.poll()[1]?.attack).toBe(true);
    expect(mgr.getBindings().interact.pad).toEqual(DEFAULT_BINDINGS.interact.pad);
    mgr.resetBindings();
    expect(mgr.getBindings()).toEqual(DEFAULT_BINDINGS);
    expect(mgr.poll()[1]?.attack).toBe(false);
  });

  it('saveBindings / loadBindings via un stockage (aller-retour)', () => {
    const storage = memoryStorage();
    const a = makeManager({ storage });
    a.mgr.updateBindings({ attack: { keys: ['KeyJ'] }, deadzone: 0.3 });
    expect(a.mgr.saveBindings()).toBe(true);
    expect(storage.data.has(BINDINGS_STORAGE_KEY)).toBe(true);

    const b = makeManager({ storage });
    expect(b.mgr.loadBindings()).toBe(true);
    expect(b.mgr.getBindings().attack.keys).toEqual(['KeyJ']);
    expect(b.mgr.getBindings().deadzone).toBe(0.3);
  });

  it('loadBindings ignore contenu absent, corrompu ou invalide ; stockage qui lève = false', () => {
    expect(makeManager({ storage: memoryStorage() }).mgr.loadBindings()).toBe(false);
    expect(makeManager({ storage: memoryStorage('{pas du json') }).mgr.loadBindings()).toBe(false);
    const conflict = JSON.stringify({ attack: { keys: ['ArrowUp'] } });
    const m = makeManager({ storage: memoryStorage(conflict) });
    expect(m.mgr.loadBindings()).toBe(false);
    expect(m.mgr.getBindings()).toEqual(DEFAULT_BINDINGS);

    const throwing: StorageLike = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    const t = makeManager({ storage: throwing });
    expect(t.mgr.loadBindings()).toBe(false);
    expect(t.mgr.saveBindings()).toBe(false);
    expect(makeManager({ storage: null }).mgr.saveBindings()).toBe(false);
  });

  it("loadBindings : une sauvegarde antérieure à « appeler » qui utilise déjà C pour une direction entre en conflit avec le défaut de `call` : repli complet sur les défauts (documenté, pas de remappage partiel)", () => {
    const old = JSON.stringify({ move: { keys: { up: ['KeyC'] } } });
    const m = makeManager({ storage: memoryStorage(old) });
    expect(m.mgr.loadBindings()).toBe(false);
    expect(m.mgr.getBindings()).toEqual(DEFAULT_BINDINGS);
    // la même sauvegarde SANS conflit avec `call` reste chargée, et `call` prend ses valeurs par défaut
    const ok = makeManager({ storage: memoryStorage(JSON.stringify({ attack: { keys: ['KeyJ'] } })) });
    expect(ok.mgr.loadBindings()).toBe(true);
    expect(ok.mgr.getBindings().call).toEqual(DEFAULT_BINDINGS.call);
  });

  it('autoLoad : charge au premier attach()/poll()', () => {
    const storage = memoryStorage(JSON.stringify({ attack: { keys: ['KeyJ'] } }));
    const { mgr } = makeManager({ storage, autoLoad: true });
    expect(mgr.getBindings().attack.keys).toEqual(DEFAULT_BINDINGS.attack.keys);
    mgr.poll();
    expect(mgr.getBindings().attack.keys).toEqual(['KeyJ']);
  });
});

describe('net', () => {
  it('LocalNetAdapter par défaut : no-op', async () => {
    const net = new LocalNetAdapter();
    const cb = vi.fn();
    net.onRemoteInputs(cb);
    await net.start();
    net.sendInputs(1, 0, emptyFrame());
    expect(cb).not.toHaveBeenCalled();
    expect(net.mode).toBe('local');
    expect(net.connected).toBe(true);
    expect(await net.ping()).toBe(0);
    net.stop();
    expect(net.isRunning).toBe(false);
  });

  it('LocalNetAdapter loopback : livre des copies, désabonnement fonctionnel', () => {
    const net = new LocalNetAdapter({ loopback: true });
    const got: { tick: number; id: PlayerId; f: ActionFrame }[] = [];
    const off = net.onRemoteInputs((tick, id, f) => got.push({ tick, id, f }));
    const frame = { ...emptyFrame(), moveX: 1 };
    net.sendInputs(5, 2, frame);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ tick: 5, id: 2 });
    expect(got[0].f).toEqual(frame);
    expect(got[0].f).not.toBe(frame);
    off();
    net.sendInputs(6, 2, frame);
    expect(got).toHaveLength(1);

    const snaps: unknown[] = [];
    net.onSnapshot((s) => snaps.push(s));
    const state = { version: 1, tick: 3 } as unknown as Parameters<typeof net.sendSnapshot>[0];
    net.sendSnapshot(state);
    expect(snaps).toEqual([state]);
    expect(snaps[0]).not.toBe(state);
  });
});
