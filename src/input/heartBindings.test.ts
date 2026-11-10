/**
 * Action « utiliser le cœur » (`heart`) : valeurs par défaut (clavier B, manette B, bouton B de la manette virtuelle), aucun conflit de touche dans CHAQUE disposition clavier,
 * lecture tolérante d'anciens bindings sauvegardés (sans l'action : valeurs par défaut, réglages existants conservés), B toujours « retour » dans les menus.
 */
import { describe, expect, it } from 'vitest';
import { BUTTON_ACTIONS, type Bindings } from './actions';
import { createDefaultBindings, createKeyboardLayoutBindings, DEFAULT_BINDINGS, PAD_BUTTON, type KeyboardLayout } from './defaultBindings';
import { InputManager, BINDINGS_STORAGE_KEY, type StorageLike } from './InputManager';
import { emptyFrame, frameHasActivity, gamepadToFrame, gamepadToMenuHeld, keysToFrame, mergeBindings, validateBindings } from './mapping';
import { VIRTUAL_BUTTON_INDEX, VirtualPad } from './VirtualPad';
import type { GamepadLike } from './GamepadSource';

const LAYOUTS: KeyboardLayout[] = ['both', 'arrows', 'wasd'];

function snap(pressed: number[] = []): { axes: number[]; buttons: { pressed: boolean; value: number }[] } {
  return { axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i), value: pressed.includes(i) ? 1 : 0 })) };
}

describe('valeurs par défaut', () => {
  it('clavier : B (KeyB) ; manette : B (indice 1) ; BUTTON_ACTIONS contient heart', () => {
    expect(DEFAULT_BINDINGS.heart.keys).toEqual(['KeyB']);
    expect(DEFAULT_BINDINGS.heart.pad).toEqual([PAD_BUTTON.B]);
    expect(BUTTON_ACTIONS).toContain('heart');
    expect(validateBindings(createDefaultBindings()).valid).toBe(true);
  });

  it('le bouton B de la manette virtuelle est le vrai B du mapping standard : il est branché sur l action sans rien de plus', () => {
    expect(VIRTUAL_BUTTON_INDEX.b).toBe(DEFAULT_BINDINGS.heart.pad[0]);
    const vp = new VirtualPad();
    vp.setConnected(true);
    vp.pressButton(1, 'b');
    const pad = vp.asExtraGamepad() as GamepadLike;
    const f = gamepadToFrame(pad, DEFAULT_BINDINGS as Bindings);
    expect(f).toEqual({ ...emptyFrame(), heart: true });
  });

  it('clavier et manette : B / KeyB produisent heart et RIEN d autre ; heart compte comme une activité (source « première utilisée »)', () => {
    const k = keysToFrame(new Set(['KeyB']), DEFAULT_BINDINGS as Bindings);
    expect(k).toEqual({ ...emptyFrame(), heart: true });
    expect(frameHasActivity(k)).toBe(true);
    expect(frameHasActivity(emptyFrame())).toBe(false);
  });
});

describe('aucun conflit de touche : « B » est libre dans chaque disposition clavier', () => {
  for (const layout of LAYOUTS) {
    it(`disposition ${layout} : KeyB n est dans aucune autre action ni direction ; bindings valides`, () => {
      const b = createKeyboardLayoutBindings(layout);
      expect(b.heart.keys).toEqual(['KeyB']);
      for (const a of BUTTON_ACTIONS) if (a !== 'heart') expect(b[a].keys, `${layout} ${a}`).not.toContain('KeyB');
      for (const d of ['up', 'down', 'left', 'right'] as const) expect(b.move.keys[d], `${layout} ${d}`).not.toContain('KeyB');
      expect(b.menu.confirm.keys).not.toContain('KeyB');
      expect(b.menu.back.keys).not.toContain('KeyB');
      expect(validateBindings(b).valid).toBe(true);
      expect(keysToFrame(new Set(['KeyB']), b).heart).toBe(true);
    });
  }

  it('aucune touche clavier partagée entre B et les autres actions (hors action contextuelle) ; M (son), Échap / Entrée (menus) ne sont pas touchés', () => {
    const b = createDefaultBindings();
    const others = [b.special.keys, b.call.keys, b.attack.keys, b.interact.keys, b.revive.keys].flat();
    for (const k of b.heart.keys) expect(others).not.toContain(k);
    for (const k of ['KeyM', 'Escape', 'Enter']) expect(b.heart.keys).not.toContain(k);
  });

  it('un remappage qui met B sur une direction est rejeté par validateBindings (conflit)', () => {
    const merged = mergeBindings(createDefaultBindings(), { move: { keys: { down: ['KeyB'] } } });
    expect(validateBindings(merged).valid).toBe(false);
  });
});

describe('lecture tolérante d anciens bindings (sans l action heart)', () => {
  const OLD = {
    version: 1,
    attack: { keys: ['KeyJ'], pad: [0] },
    interact: { keys: ['Space', 'KeyE'], pad: [0] },
    revive: { keys: ['Space', 'KeyE'], pad: [0] },
    special: { keys: ['KeyF'], pad: [3] },
    call: { keys: ['KeyC'], pad: [2] },
    deadzone: 0.4,
  };

  it('mergeBindings : valeurs par défaut pour heart, réglages existants conservés', () => {
    const m = mergeBindings(createDefaultBindings(), OLD as never);
    expect(m.heart).toEqual({ keys: ['KeyB'], pad: [PAD_BUTTON.B] });
    expect(m.attack.keys).toEqual(['KeyJ']);
    expect(m.deadzone).toBe(0.4);
    expect(validateBindings(m).valid).toBe(true);
  });

  it('validateBindings sur un objet SANS heart non fusionné : erreur « missing » (il faut passer par mergeBindings)', () => {
    const raw = JSON.parse(JSON.stringify(createDefaultBindings())) as Record<string, unknown>;
    delete raw.heart;
    expect(validateBindings(raw).errors).toContainEqual({ path: 'heart', code: 'missing' });
  });

  it('InputManager.loadBindings : un jeu sauvegardé (clé v2) sans heart est chargé, heart prend la valeur par défaut, aucun réglage n est perdu', () => {
    const data = new Map<string, string>([[BINDINGS_STORAGE_KEY, JSON.stringify(OLD)]]);
    const storage: StorageLike = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
    const mgr = new InputManager({ storage, gamepadProvider: () => [], padEventTarget: null });
    expect(mgr.loadBindings()).toBe(true);
    const b = mgr.getBindings();
    expect(b.attack.keys).toEqual(['KeyJ']);
    expect(b.special.keys).toEqual(['KeyF']);
    expect(b.deadzone).toBe(0.4);
    expect(b.heart).toEqual({ keys: ['KeyB'], pad: [PAD_BUTTON.B] });
  });

  it('bindings sauvegardés avec heart remappé : le remappage est respecté', () => {
    const data = new Map<string, string>([[BINDINGS_STORAGE_KEY, JSON.stringify({ ...OLD, heart: { keys: ['KeyV'], pad: [5] } })]]);
    const storage: StorageLike = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
    const mgr = new InputManager({ storage, gamepadProvider: () => [], padEventTarget: null });
    expect(mgr.loadBindings()).toBe(true);
    expect(keysToFrame(new Set(['KeyV']), mgr.getBindings()).heart).toBe(true);
    expect(keysToFrame(new Set(['KeyB']), mgr.getBindings()).heart).toBe(false);
    expect(gamepadToFrame(snap([5]), mgr.getBindings()).heart).toBe(true);
  });
});

describe('dans les menus, la pause et les dialogues, B reste « retour »', () => {
  it('gamepadToMenuHeld : B = back (et rien d autre), A = confirm ; l action heart n existe pas dans les menus', () => {
    const b = createDefaultBindings();
    expect([...gamepadToMenuHeld(snap([PAD_BUTTON.B]), b)]).toEqual(['back']);
    expect([...gamepadToMenuHeld(snap([PAD_BUTTON.A]), b)]).toEqual(['confirm']);
    expect(b.menu.back.pad).toEqual([PAD_BUTTON.B]);
    expect(b.menu.back.keys).not.toContain('KeyB');
  });
});
