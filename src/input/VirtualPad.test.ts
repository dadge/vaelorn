/**
 * Tests de la manette virtuelle PURE (`VirtualPad`) : stick, boutons multi-pointeurs, instantané standard.
 */
import { describe, expect, it } from 'vitest';
import {
  STICK_DEAD_ZONE,
  VIRTUAL_BUTTONS,
  VIRTUAL_BUTTON_INDEX,
  VIRTUAL_PAD_BUTTON_COUNT,
  VIRTUAL_PAD_INDEX,
  VirtualPad,
  computeStick,
  hasRealGamepad,
  isInsideCircle,
} from './VirtualPad';
import { PAD_BUTTON } from './defaultBindings';

const R = 65;

function connectedPad(): VirtualPad {
  const p = new VirtualPad({ label: 'Manette virtuelle' });
  p.setConnected(true);
  return p;
}

describe('constantes', () => {
  it('indice 4, hors des vraies manettes 0..3', () => {
    expect(VIRTUAL_PAD_INDEX).toBe(4);
  });
  it('boutons : A=0 B=1 Y=3, appel (affiché « X ») = LB (4), pause = Start (9)', () => {
    expect(VIRTUAL_BUTTON_INDEX).toEqual({ a: 0, b: 1, y: 3, call: 4, pause: 9 });
    expect(VIRTUAL_BUTTONS).not.toContain('x');
    expect(VIRTUAL_BUTTON_INDEX.call).toBe(PAD_BUTTON.LB);
    expect(VIRTUAL_BUTTON_INDEX.pause).toBe(PAD_BUTTON.START);
    expect(new Set(Object.values(VIRTUAL_BUTTON_INDEX)).size).toBe(VIRTUAL_BUTTONS.length);
  });
});

describe('computeStick', () => {
  it('centre : repos', () => {
    expect(computeStick(0, 0, R)).toEqual({ x: 0, y: 0, knobX: 0, knobY: 0 });
  });
  it('bord du rayon : amplitude 1', () => {
    const r = computeStick(R, 0, R);
    expect(r.x).toBeCloseTo(1);
    expect(r.y).toBe(0);
    expect(r.knobX).toBeCloseTo(R);
  });
  it('au-delà du rayon : clampé sur le cercle unité, direction conservée', () => {
    const r = computeStick(300, 400, R); // direction 3-4-5
    expect(Math.hypot(r.x, r.y)).toBeCloseTo(1);
    expect(r.x).toBeCloseTo(0.6);
    expect(r.y).toBeCloseTo(0.8);
    expect(Math.hypot(r.knobX, r.knobY)).toBeCloseTo(R);
  });
  it('diagonale à fond : toujours dans le cercle unité (pas de carré)', () => {
    const r = computeStick(R, R, R);
    expect(Math.hypot(r.x, r.y)).toBeLessThanOrEqual(1 + 1e-9);
  });
  it('zone morte : sous le seuil, axes nuls mais le bouton du stick suit le doigt', () => {
    const r = computeStick(R * STICK_DEAD_ZONE * 0.5, 0, R);
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
    expect(r.knobX).toBeGreaterThan(0);
  });
  it('hors zone morte : amplitude progressive (re-mappée depuis le seuil, sans saut)', () => {
    const just = computeStick(R * (STICK_DEAD_ZONE + 0.01), 0, R);
    expect(just.x).toBeGreaterThan(0);
    expect(just.x).toBeLessThan(0.05);
    const half = computeStick(R * 0.5, 0, R);
    expect(half.x).toBeGreaterThan(0.4);
    expect(half.x).toBeLessThan(0.5);
  });
  it('y : doigt au-dessus du centre (dy < 0) = axe y négatif (haut) ; en dessous = positif', () => {
    expect(computeStick(0, -R, R).y).toBeCloseTo(-1);
    expect(computeStick(0, R, R).y).toBeCloseTo(1);
    expect(computeStick(-R, 0, R).x).toBeCloseTo(-1);
  });
  it('pas de -0', () => {
    const r = computeStick(0, -R, R);
    expect(Object.is(r.x, -0)).toBe(false);
  });
  it('entrées invalides : repos', () => {
    const rest = { x: 0, y: 0, knobX: 0, knobY: 0 };
    expect(computeStick(NaN, 3, R)).toEqual(rest);
    expect(computeStick(10, 10, 0)).toEqual(rest);
    expect(computeStick(10, 10, -5)).toEqual(rest);
    expect(computeStick(Infinity, 0, R)).toEqual(rest);
  });
});

describe('isInsideCircle / hasRealGamepad', () => {
  it('disque, bord inclus, valeurs invalides = dehors', () => {
    expect(isInsideCircle(3, 4, 0, 0, 5)).toBe(true);
    expect(isInsideCircle(3, 4.1, 0, 0, 5)).toBe(false);
    expect(isInsideCircle(NaN, 0, 0, 0, 5)).toBe(false);
  });
  const pad = (index: number, connected = true) => ({ index, id: 'p', connected, axes: [], buttons: [] });
  it('vraie manette = indice < 4 connectée ; la virtuelle (4) ne compte pas', () => {
    expect(hasRealGamepad([])).toBe(false);
    expect(hasRealGamepad([null, null, null, null])).toBe(false);
    expect(hasRealGamepad([pad(VIRTUAL_PAD_INDEX)])).toBe(false);
    expect(hasRealGamepad([null, pad(1)])).toBe(true);
    expect(hasRealGamepad([pad(0, false)])).toBe(false);
    expect(hasRealGamepad([undefined, pad(3), pad(VIRTUAL_PAD_INDEX)])).toBe(true);
  });
});

describe('VirtualPad : connexion', () => {
  it('démarre déconnectée ; asExtraGamepad = null tant que déconnectée', () => {
    const p = new VirtualPad();
    expect(p.isConnected()).toBe(false);
    expect(p.asExtraGamepad()).toBeNull();
    expect(p.snapshot().connected).toBe(false);
  });
  it('déconnectée : les appuis sont refusés', () => {
    const p = new VirtualPad();
    expect(p.pressButton(1, 'a')).toBe(false);
    expect(p.beginStick(2, R, 0, R)).toBeNull();
    expect(p.isButtonDown('a')).toBe(false);
    expect(p.snapshot().buttons.some((b) => b.pressed)).toBe(false);
  });
  it('déconnecter remet TOUT à zéro (aucune touche collée) et reconnecter repart de zéro', () => {
    const p = connectedPad();
    p.pressButton(1, 'a');
    p.pressButton(2, 'call');
    p.beginStick(3, R, 0, R);
    expect(p.snapshot().axes[0]).toBeCloseTo(1);
    p.setConnected(false);
    expect(p.isStickActive()).toBe(false);
    expect(p.isPointerActive(1)).toBe(false);
    const off = p.snapshot();
    expect(off.connected).toBe(false);
    expect(off.axes).toEqual([0, 0, 0, 0]);
    expect(off.buttons.every((b) => !b.pressed && b.value === 0)).toBe(true);
    p.setConnected(true);
    const on = p.snapshot();
    expect(on.connected).toBe(true);
    expect(on.axes).toEqual([0, 0, 0, 0]);
    expect(on.buttons.every((b) => !b.pressed)).toBe(true);
  });
});

describe('VirtualPad : instantané', () => {
  it('manette standard : index 4, id traduit, mapping standard, 16 boutons, 4 axes', () => {
    const s = connectedPad().snapshot();
    expect(s.index).toBe(VIRTUAL_PAD_INDEX);
    expect(s.id).toBe('Manette virtuelle');
    expect(s.mapping).toBe('standard');
    expect(s.connected).toBe(true);
    expect(s.buttons).toHaveLength(VIRTUAL_PAD_BUTTON_COUNT);
    expect(s.buttons).toHaveLength(16);
    expect(s.axes).toEqual([0, 0, 0, 0]);
  });
  it('bouton tenu : pressed + value 1 à son indice, rien ailleurs', () => {
    const p = connectedPad();
    p.pressButton(1, 'y');
    const s = p.snapshot();
    s.buttons.forEach((b, i) => {
      expect(b.pressed).toBe(i === 3);
      expect(b.value).toBe(i === 3 ? 1 : 0);
    });
  });
  it('stick -> axes[0], axes[1] ; axes 2 et 3 restent nuls', () => {
    const p = connectedPad();
    p.beginStick(7, 0, -R, R);
    const s = p.snapshot();
    expect(s.axes[0]).toBeCloseTo(0);
    expect(s.axes[1]).toBeCloseTo(-1);
    expect(s.axes[2]).toBe(0);
    expect(s.axes[3]).toBe(0);
  });
  it('stable entre deux changements (même objet), nouvel objet gelé après un changement', () => {
    const p = connectedPad();
    const s1 = p.snapshot();
    expect(p.snapshot()).toBe(s1);
    expect(p.asExtraGamepad()).toBe(s1);
    p.pressButton(1, 'b');
    const s2 = p.snapshot();
    expect(s2).not.toBe(s1);
    expect(Object.isFrozen(s2)).toBe(true);
    expect(s1.buttons[1].pressed).toBe(false); // l'ancien instantané n'est pas muté
  });
  it('setLabel : le libellé de la manette change (langue)', () => {
    const p = connectedPad();
    p.setLabel('Virtual gamepad');
    expect(p.snapshot().id).toBe('Virtual gamepad');
  });
});

describe('VirtualPad : boutons multi-pointeurs', () => {
  it('deux doigts sur deux boutons ; relâcher un seul laisse l’autre', () => {
    const p = connectedPad();
    p.pressButton(10, 'a');
    p.pressButton(11, 'call');
    expect(p.isButtonDown('a')).toBe(true);
    expect(p.isButtonDown('call')).toBe(true);
    expect(p.releasePointer(10)).toBe(true);
    expect(p.isButtonDown('a')).toBe(false);
    expect(p.isButtonDown('call')).toBe(true);
    expect(p.snapshot().buttons[4].pressed).toBe(true);
    expect(p.snapshot().buttons[0].pressed).toBe(false);
  });
  it('stick + bouton simultanés', () => {
    const p = connectedPad();
    p.beginStick(1, R, 0, R);
    p.pressButton(2, 'y');
    const s = p.snapshot();
    expect(s.axes[0]).toBeCloseTo(1);
    expect(s.buttons[3].pressed).toBe(true);
    p.releasePointer(2);
    expect(p.snapshot().axes[0]).toBeCloseTo(1);
    expect(p.isStickActive()).toBe(true);
  });
  it('deux doigts sur le même bouton : enfoncé tant qu’un seul le tient', () => {
    const p = connectedPad();
    p.pressButton(1, 'a');
    p.pressButton(2, 'a');
    p.releasePointer(1);
    expect(p.isButtonDown('a')).toBe(true);
    p.releasePointer(2);
    expect(p.isButtonDown('a')).toBe(false);
  });
  it('un doigt = un contrôle : changer de bouton relâche l’ancien', () => {
    const p = connectedPad();
    p.pressButton(1, 'a');
    p.pressButton(1, 'b');
    expect(p.isButtonDown('a')).toBe(false);
    expect(p.isButtonDown('b')).toBe(true);
  });
  it('pointeur inconnu : releasePointer ne fait rien', () => {
    const p = connectedPad();
    expect(p.releasePointer(99)).toBe(false);
  });
  it('pointercancel (= releasePointer) d’un bouton et du stick', () => {
    const p = connectedPad();
    p.pressButton(1, 'a');
    p.beginStick(2, R, 0, R);
    p.releasePointer(2);
    expect(p.isStickActive()).toBe(false);
    expect(p.getStick()).toEqual({ x: 0, y: 0 });
    expect(p.isButtonDown('a')).toBe(true);
    p.releasePointer(1);
    expect(p.snapshot().buttons.some((b) => b.pressed)).toBe(false);
  });
  it('releaseAll : tout est relâché, la manette reste connectée', () => {
    const p = connectedPad();
    VIRTUAL_BUTTONS.forEach((b, i) => p.pressButton(i, b));
    p.beginStick(50, R, 0, R);
    p.releaseAll();
    const s = p.snapshot();
    expect(s.connected).toBe(true);
    expect(s.axes).toEqual([0, 0, 0, 0]);
    expect(s.buttons.every((b) => !b.pressed)).toBe(true);
    expect(p.isPointerActive(0)).toBe(false);
    expect(p.isStickActive()).toBe(false);
  });
});

describe('VirtualPad : stick', () => {
  it('un seul doigt tient le stick ; un second est refusé', () => {
    const p = connectedPad();
    expect(p.beginStick(1, R, 0, R)).not.toBeNull();
    expect(p.beginStick(2, -R, 0, R)).toBeNull();
    expect(p.getStick().x).toBeCloseTo(1);
  });
  it('moveStick ignoré pour un autre pointeur ; suit le doigt propriétaire', () => {
    const p = connectedPad();
    p.beginStick(1, 0, 0, R);
    expect(p.moveStick(2, R, 0, R)).toBeNull();
    expect(p.getStick().x).toBe(0);
    p.moveStick(1, -R, 0, R);
    expect(p.getStick().x).toBeCloseTo(-1);
  });
  it('relâchement : retour à zéro, un autre doigt peut reprendre le stick', () => {
    const p = connectedPad();
    p.beginStick(1, R, R, R);
    p.releasePointer(1);
    expect(p.getStick()).toEqual({ x: 0, y: 0 });
    expect(p.snapshot().axes).toEqual([0, 0, 0, 0]);
    expect(p.beginStick(2, 0, R, R)).not.toBeNull();
  });
  it('un pointeur qui tenait un bouton ne peut pas tenir le stick en même temps', () => {
    const p = connectedPad();
    p.pressButton(1, 'a');
    p.beginStick(1, R, 0, R);
    expect(p.isButtonDown('a')).toBe(false);
    expect(p.isStickActive()).toBe(true);
  });
});
