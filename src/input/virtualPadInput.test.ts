/**
 * Intégration de la manette virtuelle dans la couche d'entrées : un VRAI InputManager avec le fournisseur PAR DÉFAUT
 * (`defaultGamepadProvider`) auquel la manette virtuelle est enregistrée comme manette « extra » (indice 4).
 * Aucune modification d'InputManager / MenuNavigator : la manette virtuelle doit se comporter comme une vraie manette.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deviceFromId } from './actions';
import { PAD_BUTTON } from './defaultBindings';
import { GamepadSource, defaultGamepadProvider, listGamepads, registerExtraGamepad } from './GamepadSource';
import type { GamepadLike } from './GamepadSource';
import { InputManager } from './InputManager';
import { KeyboardSource } from './KeyboardSource';
import type { KeyEventTarget } from './KeyboardSource';
import { MenuNavigator } from './MenuNavigator';
import { VIRTUAL_PAD_INDEX, VirtualPad } from './VirtualPad';
import { handOverToRealPad, handOverToVirtualPad } from './virtualPadHandover';
import { effectivePauseOwner, pauseIntentAllowed, pauseOwnerForPad } from '../entities/pauseLogic';
import { describeAssignment, describeSlotDevice } from '../render/menuLogic';

const R = 65;

function realPad(index: number, pressed: number[] = []): GamepadLike {
  return {
    index,
    id: `Vraie manette ${index}`,
    connected: true,
    mapping: 'standard',
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i), value: pressed.includes(i) ? 1 : 0 })),
  };
}

/** Simule `navigator.getGamepads()` (Node n'en a pas). */
let browserPads: (GamepadLike | null)[] = [];

function makeManager(opts: ConstructorParameters<typeof InputManager>[0] = {}) {
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
  // PAS de `gamepadProvider` : fournisseur par défaut, comme en production.
  const mgr = new InputManager({ keyboard, storage: null, padEventTarget: null, ...opts });
  const fire = (type: string, code: string): void => handlers.get(type)?.forEach((f) => f({ code, preventDefault() {} }));
  return { mgr, down: (code: string) => fire('keydown', code), up: (code: string) => fire('keyup', code) };
}

let pad: VirtualPad;
let unregister: () => void;

beforeEach(() => {
  browserPads = [null, null, null, null];
  vi.stubGlobal('navigator', { getGamepads: () => browserPads });
  pad = new VirtualPad({ label: 'Manette virtuelle' });
  unregister = registerExtraGamepad(() => pad.asExtraGamepad());
});

afterEach(() => {
  unregister();
  vi.unstubAllGlobals();
});

describe('manette virtuelle : vue comme une manette d’indice 4', () => {
  it('connectée : listGamepads la contient (indice 4, mapping standard, libellé traduit)', () => {
    pad.setConnected(true);
    const list = listGamepads();
    expect(list).toHaveLength(1);
    expect(list[0].index).toBe(VIRTUAL_PAD_INDEX);
    expect(list[0].id).toBe('Manette virtuelle');
    expect(list[0].mapping).toBe('standard');
  });

  it('solo : A virtuel -> attaque + interaction + relevage (comme A d’une vraie manette), pas de spécial ni d’appel', () => {
    pad.setConnected(true);
    const { mgr } = makeManager();
    pad.pressButton(1, 'a');
    const f = mgr.poll()[0]!;
    expect(f.attack).toBe(true);
    expect(f.interact).toBe(true);
    expect(f.revive).toBe(true);
    expect(f.special).toBe(false);
    expect(f.call).toBe(false);
  });

  it('X = attaque seule, B = interagir/relever seul, Y = spécial, LB (appel) = call', () => {
    pad.setConnected(true);
    const { mgr } = makeManager();
    pad.pressButton(1, 'x');
    let f = mgr.poll()[0]!;
    expect([f.attack, f.interact, f.revive, f.special, f.call]).toEqual([true, false, false, false, false]);
    pad.releasePointer(1);
    pad.pressButton(1, 'b');
    f = mgr.poll()[0]!;
    expect([f.attack, f.interact, f.revive, f.special, f.call]).toEqual([false, true, true, false, false]);
    pad.releasePointer(1);
    pad.pressButton(1, 'y');
    f = mgr.poll()[0]!;
    expect([f.attack, f.interact, f.revive, f.special, f.call]).toEqual([false, false, false, true, false]);
    pad.releasePointer(1);
    pad.pressButton(1, 'call');
    f = mgr.poll()[0]!;
    expect([f.attack, f.interact, f.revive, f.special, f.call]).toEqual([false, false, false, false, true]);
  });

  it('stick -> moveX / moveY (y négatif = haut), amplitude analogique', () => {
    pad.setConnected(true);
    const { mgr } = makeManager();
    pad.beginStick(1, R, 0, R);
    let f = mgr.poll()[0]!;
    expect(f.moveX).toBeCloseTo(1);
    expect(f.moveY).toBeCloseTo(0);
    pad.moveStick(1, 0, -R, R); // doigt en haut
    f = mgr.poll()[0]!;
    expect(f.moveX).toBeCloseTo(0);
    expect(f.moveY).toBeCloseTo(-1);
    pad.moveStick(1, -R * 0.55, 0, R); // demi-course vers la gauche : vitesse partielle
    f = mgr.poll()[0]!;
    expect(f.moveX).toBeLessThan(0);
    expect(f.moveX).toBeGreaterThan(-1);
    pad.releasePointer(1);
    f = mgr.poll()[0]!;
    expect(f.moveX).toBe(0);
    expect(f.moveY).toBe(0);
  });

  it('déplacement fin : un tiers de course suffit à bouger (zone morte virtuelle minimale, pas de cumul avec celle de la manette)', () => {
    pad.setConnected(true);
    const { mgr } = makeManager();
    pad.beginStick(1, R * 0.3, 0, R);
    expect(mgr.poll()[0]!.moveX).toBeGreaterThan(0);
  });

  it('Start virtuel : bouton 9 de la manette d’indice 4 (lu par GameScene.pollPadStart), sans entrée de jeu ni intention de menu', () => {
    pad.setConnected(true);
    const { mgr } = makeManager();
    pad.pressButton(1, 'pause');
    // Même lecture que GameScene.pollPadStart : listGamepads() puis buttons[9]
    const start = listGamepads().find((g) => g.index === VIRTUAL_PAD_INDEX)!.buttons[PAD_BUTTON.START];
    expect(start.pressed || start.value > 0.5).toBe(true);
    const f = mgr.poll()[0]!;
    expect([f.moveX, f.moveY, f.attack, f.interact, f.revive, f.special, f.call]).toEqual([0, 0, false, false, false, false, false]);
    const dev = mgr.getMenuDevices().find((d) => d.id === 'gamepad:4')!;
    expect(dev.held.size).toBe(0);
  });
});

describe('manette virtuelle : menus', () => {
  it('getMenuDevices contient gamepad:4 rattaché au joueur 0 en solo', () => {
    pad.setConnected(true);
    const { mgr } = makeManager();
    const dev = mgr.getMenuDevices().find((d) => d.id === 'gamepad:4');
    expect(dev).toBeDefined();
    expect(dev!.playerId).toBe(0);
  });

  it('A = confirmer, B = retour, stick = directions (axe dominant)', () => {
    pad.setConnected(true);
    const { mgr } = makeManager();
    const held = () => mgr.getMenuDevices().find((d) => d.id === 'gamepad:4')!.held;
    pad.pressButton(1, 'a');
    expect([...held()]).toEqual(['confirm']);
    pad.releasePointer(1);
    pad.pressButton(1, 'b');
    expect([...held()]).toEqual(['back']);
    pad.releasePointer(1);
    pad.beginStick(2, 0, -R, R);
    expect([...held()]).toEqual(['up']);
    pad.moveStick(2, R, 0, R);
    expect([...held()]).toEqual(['right']);
  });

  it('MenuNavigator (singleton non utilisé : fournisseur injecté) émet des intentions depuis gamepad:4', () => {
    pad.setConnected(true);
    const { mgr } = makeManager();
    const nav = new MenuNavigator(mgr);
    pad.pressButton(1, 'a');
    const intents = nav.pollMenu(1000);
    expect(intents).toEqual([{ playerId: 0, source: 'gamepad:4', action: 'confirm' }]);
  });
});

describe('manette virtuelle : écran « rejoindre » (attribution explicite)', () => {
  it('assignDevice(gamepad:4) : le joueur reçoit les entrées de la manette virtuelle', () => {
    pad.setConnected(true);
    const { mgr } = makeManager({ playerCount: 2 });
    const dev = deviceFromId('gamepad:4');
    expect(dev).toEqual({ kind: 'gamepad', index: 4 });
    mgr.assignDevice(0, dev);
    mgr.assignDevice(1, { kind: 'keyboard' });
    pad.pressButton(1, 'y');
    pad.beginStick(2, -R, 0, R);
    const inputs = mgr.poll();
    expect(inputs[0]!.special).toBe(true);
    expect(inputs[0]!.moveX).toBeCloseTo(-1);
    expect(inputs[1]!.special).toBe(false);
    const a = mgr.getAssignments()[0];
    expect(a.label).toBe('gamepad');
    expect(a.gamepadIndex).toBe(4);
    expect(a.gamepadName).toBe('Manette virtuelle');
    expect(a.connected).toBe(true);
    expect(mgr.getMenuDevices().find((d) => d.id === 'gamepad:4')!.playerId).toBe(0);
  });

  it('un seul téléphone = un joueur : la manette 4 ne peut occuper qu’un emplacement', () => {
    pad.setConnected(true);
    const { mgr } = makeManager({ playerCount: 2 });
    mgr.assignDevice(0, { kind: 'gamepad', index: 4 });
    mgr.assignDevice(1, { kind: 'gamepad', index: 4 });
    expect(mgr.getAssignedDevice(0)).toBeNull();
    expect(mgr.getAssignedDevice(1)).toEqual({ kind: 'gamepad', index: 4 });
  });

  it('masquée (déconnectée) après attribution : le joueur est signalé déconnecté (pause « manette déconnectée »), reprise automatique au retour', () => {
    pad.setConnected(true);
    const { mgr } = makeManager({ playerCount: 1 });
    mgr.assignDevice(0, { kind: 'gamepad', index: 4 });
    mgr.poll();
    expect(mgr.getDisconnectedPlayers()).toEqual([]);
    pad.setConnected(false); // rotation en portrait, ou vraie manette branchée
    expect(mgr.getDisconnectedPlayers()).toEqual([0]);
    expect(mgr.poll()[0]).toEqual({ moveX: 0, moveY: 0, attack: false, interact: false, revive: false, special: false, call: false });
    pad.setConnected(true);
    expect(mgr.getDisconnectedPlayers()).toEqual([]);
  });
});

describe('manette virtuelle : connexion / déconnexion', () => {
  it('déconnectée : absente de la liste et des menus ; le solo retombe sur le clavier', () => {
    pad.setConnected(true);
    const { mgr, down } = makeManager();
    pad.pressButton(1, 'a');
    expect(mgr.poll()[0]!.attack).toBe(true);
    pad.setConnected(false); // remet aussi tous les appuis à zéro
    expect(listGamepads()).toHaveLength(0);
    expect(mgr.getMenuDevices().some((d) => d.id.startsWith('gamepad:'))).toBe(false);
    expect(mgr.poll()[0]!.attack).toBe(false); // pas de touche collée
    down('ArrowRight');
    expect(mgr.poll()[0]!.moveX).toBe(1);
  });

  it('jamais connectée : aucune manette (comportement actuel)', () => {
    const { mgr } = makeManager();
    expect(listGamepads()).toHaveLength(0);
    expect(mgr.getMenuDevices().filter((d) => d.id !== 'keyboard')).toEqual([]);
  });

  it('GamepadSource ciblant l’indice 4 ne voit la manette que connectée', () => {
    const src = new GamepadSource({ index: VIRTUAL_PAD_INDEX });
    expect(src.connected()).toBe(false);
    pad.setConnected(true);
    expect(src.connected()).toBe(true);
    expect(src.getName()).toBe('Manette virtuelle');
    expect(src.isNonStandard()).toBe(false);
  });
});

describe('manette virtuelle : une VRAIE manette prend le pas', () => {
  it('solo : la vraie manette (indice 0) est « la première manette » ; la virtuelle est ignorée', () => {
    pad.setConnected(true);
    browserPads = [realPad(0), null, null, null];
    const { mgr } = makeManager();
    pad.pressButton(1, 'a'); // appui virtuel résiduel
    expect(mgr.poll()[0]!.attack).toBe(false);
    const devs = mgr.getMenuDevices().filter((d) => d.id.startsWith('gamepad:'));
    expect(devs.map((d) => d.id)).toEqual(['gamepad:0', 'gamepad:4']); // triées par indice
    expect(devs[0].playerId).toBe(0);
    expect(devs[1].playerId).toBeNull();
    browserPads = [realPad(0, [PAD_BUTTON.A]), null, null, null];
    expect(mgr.poll()[0]!.attack).toBe(true);
  });

  it('multi-joueurs par défaut : J2 = manette 0 (vraie) ; la virtuelle n’est attribuée à personne sans attribution explicite', () => {
    pad.setConnected(true);
    browserPads = [realPad(0, [PAD_BUTTON.X]), null, null, null];
    const { mgr } = makeManager({ playerCount: 2 });
    pad.pressButton(1, 'a');
    const inputs = mgr.poll();
    expect(inputs[1]!.attack).toBe(true); // la vraie manette 0
    expect(inputs[0]!.attack).toBe(false); // J1 = clavier
    expect(mgr.getMenuDevices().find((d) => d.id === 'gamepad:4')!.playerId).toBeNull();
  });
});

describe('fournisseur par défaut', () => {
  it('sans extra : renvoie la liste du navigateur telle quelle (comportement actuel)', () => {
    unregister();
    const list = [realPad(0), null, null, null];
    browserPads = list;
    expect(defaultGamepadProvider()).toBe(list);
    unregister = registerExtraGamepad(() => pad.asExtraGamepad()); // restauré pour afterEach
  });

  it('sans extra et sans navigator.getGamepads : liste vide', () => {
    unregister();
    vi.stubGlobal('navigator', {});
    expect(defaultGamepadProvider()).toHaveLength(0);
    vi.stubGlobal('navigator', { getGamepads: () => { throw new Error('SecurityError'); } });
    expect(defaultGamepadProvider()).toHaveLength(0);
    unregister = registerExtraGamepad(() => pad.asExtraGamepad());
  });

  it('extra enregistré mais absent (null) : la liste du navigateur est renvoyée telle quelle (aucune allocation)', () => {
    const list = [realPad(1), null, null, null];
    browserPads = list;
    expect(pad.isConnected()).toBe(false);
    expect(defaultGamepadProvider()).toBe(list);
  });

  it('extra présent : vraies manettes + extra, identifiées par `.index`', () => {
    pad.setConnected(true);
    const list = [null, realPad(1), null, null];
    browserPads = list;
    const out = defaultGamepadProvider();
    const indexes = Array.from(out).filter((g): g is GamepadLike => !!g).map((g) => g.index);
    expect(indexes).toEqual([1, VIRTUAL_PAD_INDEX]);
    expect(list).toHaveLength(4); // la liste du navigateur n'est pas modifiée
  });

  it('désenregistrement et extra défaillant', () => {
    const off = registerExtraGamepad(() => {
      throw new Error('boom');
    });
    pad.setConnected(true);
    expect(listGamepads().map((g) => g.index)).toEqual([VIRTUAL_PAD_INDEX]);
    off();
    off(); // idempotent
    unregister();
    expect(listGamepads()).toHaveLength(0);
    unregister = registerExtraGamepad(() => pad.asExtraGamepad());
  });

  it('un fournisseur injecté (tests) n’est pas concerné par les extras', () => {
    pad.setConnected(true);
    const only = [realPad(2)];
    expect(listGamepads(() => only).map((g) => g.index)).toEqual([2]);
  });
});

describe('manette virtuelle : passage de relais avec les vraies manettes', () => {
  const emptyFrameLike = { moveX: 0, moveY: 0, attack: false, interact: false, revive: false, special: false, call: false };

  it('vraie manette branchée après inscription au pad virtuel : le joueur la reprend (plus de déconnexion permanente)', () => {
    pad.setConnected(true);
    const { mgr } = makeManager({ playerCount: 1 });
    mgr.assignDevice(0, { kind: 'gamepad', index: 4 });
    mgr.poll();
    // la vraie manette 0 apparaît (A appuyé) : l'overlay se masque
    browserPads = [realPad(0, [PAD_BUTTON.A]), null, null, null];
    pad.setConnected(false);
    expect(mgr.getDisconnectedPlayers()).toEqual([0]); // avant relais : impasse
    expect(handOverToRealPad(mgr, [0])).toEqual([0]);
    expect(mgr.getAssignedDevice(0)).toEqual({ kind: 'gamepad', index: 0 });
    expect(mgr.getDisconnectedPlayers()).toEqual([]);
    expect(mgr.poll()[0]!.attack).toBe(true);
  });

  it('relais vers une vraie manette libre uniquement (jamais celle d’un autre joueur) ; sans manette libre : rien', () => {
    pad.setConnected(true);
    const { mgr } = makeManager({ playerCount: 2 });
    mgr.assignDevice(0, { kind: 'gamepad', index: 4 });
    mgr.assignDevice(1, { kind: 'gamepad', index: 0 });
    expect(handOverToRealPad(mgr, [0])).toEqual([]);
    expect(mgr.getAssignedDevice(0)).toEqual({ kind: 'gamepad', index: 4 });
    expect(handOverToRealPad(mgr, [0, 2])).toEqual([0]);
    expect(mgr.getAssignedDevice(0)).toEqual({ kind: 'gamepad', index: 2 });
    expect(mgr.getAssignedDevice(1)).toEqual({ kind: 'gamepad', index: 0 });
  });

  it('vraie manette disparue (batterie) : l’overlay revient et le joueur reprend la manette virtuelle', () => {
    const { mgr } = makeManager({ playerCount: 1 });
    browserPads = [realPad(0), null, null, null];
    mgr.assignDevice(0, { kind: 'gamepad', index: 0 });
    mgr.poll();
    browserPads = [null, null, null, null];
    pad.setConnected(true); // overlay réaffiché
    expect(mgr.getDisconnectedPlayers()).toEqual([0]); // avant relais : les commandes tactiles ne pilotent personne
    expect(handOverToVirtualPad(mgr, listGamepads().map((g) => g.index))).toEqual([0]);
    expect(mgr.getAssignedDevice(0)).toEqual({ kind: 'gamepad', index: VIRTUAL_PAD_INDEX });
    expect(mgr.getDisconnectedPlayers()).toEqual([]);
    pad.pressButton(1, 'a');
    expect(mgr.poll()[0]!.attack).toBe(true);
    // la vraie manette revient : relais inverse
    browserPads = [realPad(0), null, null, null];
    pad.setConnected(false);
    expect(handOverToRealPad(mgr, [0])).toEqual([0]);
    expect(mgr.getAssignedDevice(0)).toEqual({ kind: 'gamepad', index: 0 });
  });

  it('relais vers le pad virtuel : ignoré s’il est déjà attribué, si la manette du joueur est présente, ou sans attribution', () => {
    pad.setConnected(true);
    const { mgr } = makeManager({ playerCount: 2 });
    expect(handOverToVirtualPad(mgr, [])).toEqual([]);
    expect(handOverToRealPad(mgr, [0])).toEqual([]);
    mgr.assignDevice(0, { kind: 'gamepad', index: 4 });
    mgr.assignDevice(1, { kind: 'gamepad', index: 1 });
    expect(handOverToVirtualPad(mgr, [1, 4])).toEqual([]);
    mgr.assignDevice(0, null);
    expect(handOverToVirtualPad(mgr, [1, 4])).toEqual([]); // manette 1 présente
    expect(handOverToVirtualPad(mgr, [4])).toEqual([1]);
    expect(mgr.getAssignedDevice(1)).toEqual({ kind: 'gamepad', index: 4 });
  });

  it('un joueur au clavier n’est jamais touché', () => {
    const { mgr } = makeManager({ playerCount: 1 });
    mgr.assignDevice(0, { kind: 'keyboard' });
    expect(handOverToVirtualPad(mgr, [])).toEqual([]);
    expect(handOverToRealPad(mgr, [0])).toEqual([]);
    expect(mgr.getAssignedDevice(0)).toEqual({ kind: 'keyboard' });
    expect(mgr.poll()[0]).toEqual(emptyFrameLike);
  });
});

describe('manette virtuelle : pause (Start virtuel = bouton 9 de la manette 4)', () => {
  it('le propriétaire de pause est gamepad:4 ; il garde la main tant que l’overlay est affiché', () => {
    expect(pauseOwnerForPad(VIRTUAL_PAD_INDEX)).toBe('gamepad:4');
    expect(effectivePauseOwner('gamepad:4', [VIRTUAL_PAD_INDEX])).toBe('gamepad:4');
    expect(pauseIntentAllowed('gamepad:4', 'gamepad:4')).toBe(true);
    expect(pauseIntentAllowed('gamepad:4', 'keyboard')).toBe(false);
  });

  it('overlay masqué : le propriétaire est perdu, la pause redevient pilotable par tous', () => {
    pad.setConnected(true);
    pad.pressButton(1, 'pause');
    expect(listGamepads().map((g) => g.index)).toEqual([VIRTUAL_PAD_INDEX]);
    pad.setConnected(false);
    expect(effectivePauseOwner('gamepad:4', listGamepads().map((g) => g.index))).toBeNull();
  });
});

describe('manette virtuelle : libellés (pas d’indice technique exposé)', () => {
  it('emplacement de joueur : « Manette virtuelle » sans numéro ; manquante si masquée', () => {
    const view = describeSlotDevice('gamepad:4', [{ index: 4, name: 'Manette virtuelle' }]);
    expect(view).toMatchObject({ labelKey: 'touch.padName', claimed: true, missing: false });
    expect(view.params).toBeUndefined();
    expect(describeSlotDevice('gamepad:4', [])).toMatchObject({ labelKey: 'touch.padName', missing: true });
    expect(describeSlotDevice('gamepad:1', [{ index: 1, name: 'Pad' }]).labelKey).toBe('pad.slot.gamepad');
  });

  it('écran de sélection : libellé d’entrée sans numéro, avertissement dédié si masquée', () => {
    const ok = describeAssignment({ playerId: 0, label: 'gamepad', connected: true, assigned: true, gamepadIndex: 4 });
    expect(ok).toMatchObject({ labelKey: 'touch.padName', connected: true });
    expect(ok.labelParams).toBeUndefined();
    const hidden = describeAssignment({ playerId: 0, label: 'gamepad', connected: false, assigned: true, gamepadIndex: 4 });
    expect(hidden.warnKey).toBe('touch.hidden');
  });
});
