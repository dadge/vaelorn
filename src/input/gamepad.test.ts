/**
 * Tests de la couche « manette pour tous » : attaque spéciale, mappage non standard, attribution explicite
 * des appareils (assignDevice / getAssignments), déconnexion / reconnexion. Manettes et clavier SIMULÉS.
 */
import { describe, expect, it } from 'vitest';
import type { PlayerId } from '../core/types';
import { deviceFromId, deviceToId } from './actions';
import { createDefaultBindings, createKeyboardLayoutBindings, PAD_BUTTON } from './defaultBindings';
import { emptyFrame, gamepadToFrame, gamepadToMenuHeld, hatToDirections, isNonStandardPad, keysToFrame, mergeBindings, validateBindings } from './mapping';
import type { GamepadSnapshot } from './mapping';
import { GamepadSource } from './GamepadSource';
import type { GamepadLike } from './GamepadSource';
import { InputManager } from './InputManager';
import { KeyboardSource } from './KeyboardSource';
import type { KeyEventTarget } from './KeyboardSource';
import { RemoteInputSource } from '../net/RemoteInputSource';

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

describe('attaque spéciale (bouton dédié)', () => {
  const b = createDefaultBindings();

  it('bindings par défaut : clavier F / X, manette Y seul', () => {
    expect(b.special.keys).toEqual(['KeyF', 'KeyX']);
    expect(b.special.pad).toEqual([PAD_BUTTON.Y]);
    expect(validateBindings(b).valid).toBe(true);
  });

  it('clavier : F et X déclenchent le spécial, Espace / E non', () => {
    expect(keysToFrame(keys('KeyF'), b).special).toBe(true);
    expect(keysToFrame(keys('KeyX'), b).special).toBe(true);
    const sp = keysToFrame(keys('Space', 'KeyE'), b);
    expect(sp.special).toBe(false);
    expect(sp.attack).toBe(true);
    const f = keysToFrame(keys('KeyF'), b);
    expect(f.attack).toBe(false);
    expect(f.interact).toBe(false);
  });

  it('manette : Y SEUL déclenche le spécial (analogique au-delà du seuil) ; A / B / X / LB / RB / LT / RT non', () => {
    expect(gamepadToFrame(snap({ pressed: [PAD_BUTTON.Y] }), b).special).toBe(true);
    expect(gamepadToFrame(snap({ values: { [PAD_BUTTON.Y]: 0.8 } }), b).special).toBe(true);
    expect(gamepadToFrame(snap({ values: { [PAD_BUTTON.Y]: 0.2 } }), b).special).toBe(false);
    for (const i of [0, 1, 2, 4, 5, 6, 7]) expect(gamepadToFrame(snap({ pressed: [i] }), b).special, String(i)).toBe(false);
    expect(gamepadToFrame(snap({ pressed: [3] }), b).attack).toBe(false);
  });

  it('emptyFrame : special false', () => {
    expect(emptyFrame().special).toBe(false);
    expect(keysToFrame(keys(), b)).toEqual(emptyFrame());
  });

  it('mergeBindings / validateBindings : surcharge, défaut conservé, liste vide et conflit refusés', () => {
    const m = mergeBindings(b, { special: { keys: ['KeyG'] } });
    expect(m.special.keys).toEqual(['KeyG']);
    expect(m.special.pad).toEqual([3]);
    // ancien JSON sauvegardé sans « special » : la valeur par défaut est reprise
    const old = JSON.parse(JSON.stringify(b)) as Record<string, unknown>;
    delete old.special;
    expect(mergeBindings(createDefaultBindings(), old as never).special.keys).toEqual(['KeyF', 'KeyX']);
    const empty = createDefaultBindings();
    empty.special.keys = [];
    expect(validateBindings(empty).errors).toContainEqual({ path: 'special.keys', code: 'empty' });
    const conflict = createDefaultBindings();
    conflict.special.keys = ['ArrowUp'];
    expect(validateBindings(conflict).valid).toBe(false);
  });

  it('dispositions clavier prédéfinies : le spécial reste disponible', () => {
    expect(createKeyboardLayoutBindings('arrows').special.keys).toEqual(['KeyF', 'KeyX']);
    expect(createKeyboardLayoutBindings('wasd').special.keys).toEqual(['KeyF', 'KeyX']);
    expect(validateBindings(createKeyboardLayoutBindings('arrows')).valid).toBe(true);
  });

  it('sources : KeyboardSource, GamepadSource, RemoteInputSource propagent special', () => {
    const { keyboard, press } = makeManager();
    press('KeyF');
    expect(keyboard.poll().special).toBe(true);
    const gp = new GamepadSource({ index: 0, provider: () => [padLike(0, { pressed: [3] })] });
    expect(gp.poll().special).toBe(true);
    const remote = new RemoteInputSource(1);
    remote.push({ ...emptyFrame(), special: true });
    expect(remote.poll().special).toBe(true);
    remote.setConnected(false);
    expect(remote.poll().special).toBe(false);
  });

  it('InputManager.poll : le spécial arrive dans les TickInputs', () => {
    const { mgr, press } = makeManager({ playerCount: 1 });
    expect(mgr.poll()[0]?.special).toBe(false);
    press('KeyX');
    expect(mgr.poll()[0]?.special).toBe(true);
  });
});

describe('manettes non standard (mappage de repli)', () => {
  const b = createDefaultBindings();
  const nonStd = (o: Parameters<typeof snap>[0] = {}): GamepadSnapshot => ({ ...snap(o), mapping: '' });

  it('détection du mapping', () => {
    expect(isNonStandardPad({ ...snap(), mapping: 'standard' })).toBe(false);
    expect(isNonStandardPad(snap())).toBe(false);
    expect(isNonStandardPad(nonStd())).toBe(true);
  });

  it('hat (axe 9) : 8 directions + neutre', () => {
    const none = { up: false, down: false, left: false, right: false };
    expect(hatToDirections(-1)).toEqual({ ...none, up: true });
    expect(hatToDirections(-0.4286)).toEqual({ ...none, right: true });
    expect(hatToDirections(0.1429)).toEqual({ ...none, down: true });
    expect(hatToDirections(0.7143)).toEqual({ ...none, left: true });
    expect(hatToDirections(-0.7143)).toEqual({ ...none, up: true, right: true });
    expect(hatToDirections(1)).toEqual({ ...none, up: true, left: true });
    expect(hatToDirections(1.2857)).toEqual(none);
    expect(hatToDirections(Number.NaN)).toEqual(none);
  });

  it("croix sur l'axe 9 : mouvement seulement si non standard", () => {
    const axes = [0, 0, 0, 0, 0, 0, 0, 0, 0, -0.4286];
    expect(gamepadToFrame(nonStd({ axes }), b).moveX).toBe(1);
    expect(gamepadToFrame(snap({ axes }), b).moveX).toBe(0);
    expect(gamepadToMenuHeld(nonStd({ axes: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0.1429] }), b).has('down')).toBe(true);
  });

  it('stick 0/1 et boutons 0/1/2/3 = A/B/X/Y en repli (B = utiliser le cœur en jeu)', () => {
    const f = gamepadToFrame(nonStd({ axes: [1, 0], pressed: [0] }), b);
    expect(f.moveX).toBeCloseTo(1);
    expect(f.attack && f.interact && f.revive).toBe(true);
    expect(gamepadToFrame(nonStd({ pressed: [2] }), b)).toMatchObject({ attack: false, interact: false, call: true });
    expect(gamepadToFrame(nonStd({ pressed: [3] }), b)).toMatchObject({ attack: false, interact: false, special: true });
    expect(gamepadToFrame(nonStd({ pressed: [1] }), b)).toMatchObject({ attack: false, interact: false, revive: false, special: false, call: false, heart: true });
    expect(gamepadToMenuHeld(nonStd({ pressed: [0] }), b).has('confirm')).toBe(true);
    expect(gamepadToMenuHeld(nonStd({ pressed: [1] }), b).has('back')).toBe(true);
  });

  it('getAssignments signale nonStandard:true', () => {
    const { mgr, setPads } = makeManager();
    mgr.setPlayerCount(2);
    setPads([{ index: 0, id: 'Generic USB Joystick', connected: true, ...nonStd() }]);
    expect(mgr.getAssignments()[1].nonStandard).toBe(true);
    setPads([padLike(0)]);
    expect(mgr.getAssignments()[1].nonStandard).toBeUndefined();
  });
});

describe('InputManager : assignDevice (attribution explicite)', () => {
  it('identifiants de périphériques', () => {
    expect(deviceFromId('keyboard')).toEqual({ kind: 'keyboard' });
    expect(deviceFromId('gamepad:3')).toEqual({ kind: 'gamepad', index: 3 });
    expect(deviceFromId('gamepad:x')).toBeNull();
    expect(deviceToId({ kind: 'gamepad', index: 2 })).toBe('gamepad:2');
  });

  it('4 joueurs sur 4 manettes, sans clavier, tous actifs simultanément', () => {
    const { mgr, setPads, press } = makeManager({ playerCount: 4 });
    for (let i = 0; i < 4; i++) mgr.assignDevice(i as PlayerId, { kind: 'gamepad', index: i });
    setPads([0, 1, 2, 3].map((i) => padLike(i, { axes: [i === 2 ? 1 : 0, 0], pressed: i === 3 ? [3] : [] })));
    press('Space');
    const inp = mgr.poll();
    expect(inp[0]).toEqual(emptyFrame());
    expect(inp[2]?.moveX).toBeCloseTo(1);
    expect(inp[3]?.special).toBe(true);
    const a = mgr.getAssignments();
    expect(a.map((x) => x.label)).toEqual(['gamepad', 'gamepad', 'gamepad', 'gamepad']);
    expect(a.map((x) => x.gamepadIndex)).toEqual([0, 1, 2, 3]);
    expect(a.every((x) => x.connected && x.assigned)).toBe(true);
    expect(a[1].device).toEqual({ kind: 'gamepad', index: 1 });
  });

  it("le clavier peut être sur N'IMPORTE quel emplacement, un seul à la fois", () => {
    const { mgr, press } = makeManager({ playerCount: 3 });
    mgr.assignDevice(0, { kind: 'keyboard' });
    mgr.assignDevice(2, { kind: 'keyboard' });
    expect(mgr.getAssignedDevice(0)).toBeNull();
    expect(mgr.getAssignedDevice(2)).toEqual({ kind: 'keyboard' });
    press('KeyD');
    const inp = mgr.poll();
    expect(inp[2]?.moveX).toBe(1);
    expect(inp[0]).toEqual(emptyFrame());
    expect(mgr.getAssignments()[0]).toMatchObject({ assigned: false, connected: false });
    expect(mgr.getAssignments()[2]).toMatchObject({ label: 'keyboard', assigned: true, connected: true });
  });

  it("un appareil = un emplacement : réassigner retire l'ancien propriétaire ; null libère ; indice invalide ignoré", () => {
    const { mgr } = makeManager({ playerCount: 2 });
    mgr.assignDevice(0, { kind: 'gamepad', index: 1 });
    mgr.assignDevice(1, { kind: 'gamepad', index: 1 });
    expect(mgr.getAssignedDevice(0)).toBeNull();
    expect(mgr.getAssignedDevice(1)).toEqual({ kind: 'gamepad', index: 1 });
    mgr.assignDevice(1, null);
    expect(mgr.getAssignedDevice(1)).toBeNull();
    mgr.assignDevice(1, { kind: 'gamepad', index: -1 });
    expect(mgr.getAssignedDevice(1)).toBeNull();
  });

  it("fonctionne à 1 joueur : seul l'appareil assigné compte", () => {
    const { mgr, setPads, press } = makeManager({ playerCount: 1 });
    mgr.assignDevice(0, { kind: 'gamepad', index: 2 });
    setPads([padLike(0), null, padLike(2, { pressed: [3] })]);
    press('Space');
    const f = mgr.poll()[0];
    expect(f?.special).toBe(true);
    expect(f?.attack).toBe(false);
    mgr.assignDevice(0, { kind: 'keyboard' });
    expect(mgr.poll()[0]?.attack).toBe(true);
  });

  it('clearAssignments : retour aux attributions par défaut', () => {
    const { mgr } = makeManager({ playerCount: 2 });
    mgr.assignDevice(0, { kind: 'gamepad', index: 0 });
    expect(mgr.isExplicitMode()).toBe(true);
    mgr.clearAssignments();
    expect(mgr.isExplicitMode()).toBe(false);
    expect(mgr.getAssignments().map((x) => x.label)).toEqual(['keyboard', 'gamepad']);
  });

  it('menus : chaque appareil est rattaché à son joueur en mode explicite', () => {
    const { mgr, setPads } = makeManager({ playerCount: 2 });
    mgr.assignDevice(0, { kind: 'gamepad', index: 1 });
    mgr.assignDevice(1, { kind: 'keyboard' });
    setPads([padLike(0), padLike(1)]);
    const dev = mgr.getMenuDevices();
    expect(dev.find((d) => d.id === 'keyboard')?.playerId).toBe(1);
    expect(dev.find((d) => d.id === 'gamepad:1')?.playerId).toBe(0);
    expect(dev.find((d) => d.id === 'gamepad:0')?.playerId).toBeNull();
  });

  it('déconnexion / reconnexion : stable, le joueur reprend sa manette au même indice', () => {
    const { mgr, setPads } = makeManager({ playerCount: 3 });
    for (let i = 0; i < 3; i++) mgr.assignDevice(i as PlayerId, { kind: 'gamepad', index: i });
    setPads([padLike(0), padLike(1), padLike(2)]);
    expect(mgr.getDisconnectedPlayers()).toEqual([]);
    // la manette 1 disparaît : seul J2 est signalé, J1 et J3 ne « glissent » pas
    setPads([padLike(0), null, padLike(2, { pressed: [3] })]);
    expect(mgr.getDisconnectedPlayers()).toEqual([1]);
    const inp = mgr.poll();
    expect(inp[1]).toEqual(emptyFrame());
    expect(inp[2]?.special).toBe(true);
    expect(mgr.getAssignments()[1]).toMatchObject({ connected: false, assigned: true });
    // reconnexion
    setPads([padLike(0), padLike(1, { pressed: [3] }), padLike(2)]);
    expect(mgr.getDisconnectedPlayers()).toEqual([]);
    expect(mgr.poll()[1]?.special).toBe(true);
  });

  it("une manette JAMAIS détectée n'est pas signalée comme déconnectée (démarrage rapide sans manette)", () => {
    const { mgr } = makeManager({ playerCount: 2 });
    expect(mgr.getDisconnectedPlayers()).toEqual([]);
    mgr.assignDevice(0, { kind: 'gamepad', index: 0 });
    expect(mgr.getDisconnectedPlayers()).toEqual([]);
  });

  it('onDisconnect / onConnect : événements navigateur relayés avec le joueur concerné', () => {
    const handlers = new Map<string, (e: unknown) => void>();
    const padEventTarget = {
      addEventListener: (t: string, l: (e: unknown) => void) => handlers.set(t, l),
      removeEventListener: (t: string) => handlers.delete(t),
    };
    const { mgr } = makeManager({ playerCount: 2, padEventTarget });
    mgr.assignDevice(1, { kind: 'gamepad', index: 3 });
    const gone: unknown[] = [];
    const back: unknown[] = [];
    const off = mgr.onDisconnect((e) => gone.push(e));
    mgr.onConnect((e) => back.push(e));
    handlers.get('gamepaddisconnected')?.({ gamepad: { index: 3, id: 'X' } });
    handlers.get('gamepadconnected')?.({ gamepad: { index: 3, id: 'X' } });
    expect(gone).toEqual([{ index: 3, name: 'X', playerId: 1 }]);
    expect(back).toHaveLength(1);
    off();
    handlers.get('gamepaddisconnected')?.({ gamepad: { index: 3, id: 'X' } });
    expect(gone).toHaveLength(1);
    mgr.detach();
    expect(handlers.size).toBe(0);
  });
});
