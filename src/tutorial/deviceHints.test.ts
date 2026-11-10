import { afterEach, describe, expect, it } from 'vitest';
import { setLanguage } from '../i18n/i18n';
import { createDefaultBindings } from '../input/defaultBindings';
import { VIRTUAL_PAD_INDEX } from '../input/VirtualPad';
import { BUTTON_NAMES, DEVICE_KINDS, buttonLabels, initialDeviceFromMenuSource, isPlayStationPad, keyLabel, resolveDevice } from './deviceHints';

afterEach(() => setLanguage('fr'));

const base = { virtualPadConnected: false, keyboardUsed: false };

describe('resolveDevice', () => {
  it('clavier par défaut', () => {
    expect(resolveDevice({ ...base, label: 'keyboard' })).toBe('keyboard');
  });

  it('manette standard, manette PlayStation (nom DualSense / 054c), manette virtuelle (indice 4)', () => {
    expect(resolveDevice({ ...base, label: 'gamepad', gamepadIndex: 0, gamepadName: 'Xbox 360 Controller (STANDARD GAMEPAD)' })).toBe('gamepad');
    expect(resolveDevice({ ...base, label: 'gamepad', gamepadIndex: 0, gamepadName: 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)' })).toBe('gamepadPs');
    expect(resolveDevice({ ...base, label: 'gamepad', gamepadIndex: 1, gamepadName: 'Wireless Controller (Vendor: 054c Product: 09cc)' })).toBe('gamepadPs');
    expect(resolveDevice({ ...base, label: 'gamepad', gamepadIndex: VIRTUAL_PAD_INDEX, gamepadName: 'Manette virtuelle' })).toBe('touch');
  });

  it('avant la première activité clavier : appareil du menu, sinon manette virtuelle présente ; ensuite le clavier l emporte', () => {
    expect(resolveDevice({ ...base, label: 'keyboard', initialDevice: 'gamepadPs' })).toBe('gamepadPs');
    expect(resolveDevice({ ...base, label: 'keyboard', virtualPadConnected: true })).toBe('touch');
    expect(resolveDevice({ ...base, label: 'keyboard', virtualPadConnected: true, keyboardUsed: true })).toBe('keyboard');
    expect(resolveDevice({ ...base, label: 'keyboard', initialDevice: 'touch', keyboardUsed: true })).toBe('keyboard');
  });

  it('isPlayStationPad et initialDeviceFromMenuSource', () => {
    expect(isPlayStationPad('PS4 DualShock')).toBe(true);
    expect(isPlayStationPad('Xbox One')).toBe(false);
    expect(isPlayStationPad(undefined)).toBe(false);
    expect(initialDeviceFromMenuSource(null)).toBeUndefined();
    expect(initialDeviceFromMenuSource('keyboard')).toBe('keyboard');
    expect(initialDeviceFromMenuSource(`gamepad:${VIRTUAL_PAD_INDEX}`)).toBe('touch');
    expect(initialDeviceFromMenuSource('gamepad:0')).toBe('gamepad');
    expect(initialDeviceFromMenuSource('gamepad:0', 'DualSense 054c')).toBe('gamepadPs');
  });
});

describe('buttonLabels', () => {
  it('jamais de chaîne vide ni de clé brute, pour chaque appareil et chaque langue', () => {
    for (const lang of ['fr', 'en'] as const) {
      setLanguage(lang);
      for (const dev of DEVICE_KINDS) {
        const labels = buttonLabels(dev);
        for (const b of BUTTON_NAMES) {
          expect(labels[b], `${lang} ${dev} ${b}`).toBeTruthy();
          expect(labels[b], `${lang} ${dev} ${b}`).not.toMatch(/^tutorial\./);
          expect(labels[b], `${lang} ${dev} ${b}`).not.toMatch(/\{\w+\}/);
        }
      }
    }
  });

  it('clavier : lit les touches courantes (Espace traduit selon la langue)', () => {
    const l = buttonLabels('keyboard');
    expect(l.action).toContain('Espace');
    expect(l.special).toContain('F / X');
    expect(l.call).toContain('C');
    setLanguage('en');
    expect(buttonLabels('keyboard').action).toContain('Space');
    expect(keyLabel('Space')).toBe('Space');
    expect(keyLabel('KeyF')).toBe('F');
    expect(keyLabel('Escape')).toBe('Esc');
  });

  it('clavier : bindings remappés respectés', () => {
    const b = createDefaultBindings();
    b.special.keys = ['KeyG'];
    b.call.keys = ['KeyV'];
    b.attack.keys = ['KeyJ'];
    b.move.keys = { up: ['KeyI'], down: ['KeyK'], left: ['KeyJ'], right: ['KeyL'] };
    const l = buttonLabels('keyboard', b);
    expect(l.special).toContain('G');
    expect(l.call).toContain('V');
    expect(l.attack).toContain('J');
    expect(l.move).toContain('I');
    expect(l.move).toContain('L');
  });

  it('manette Xbox : A = action / attaque / interaction, Y = spécial, X = appel, Select = passer, Start = pause', () => {
    const pad = buttonLabels('gamepad');
    expect([pad.action, pad.interact, pad.attack, pad.special, pad.call]).toEqual(['le bouton A', 'le bouton A', 'le bouton A', 'le bouton Y', 'le bouton X']);
    expect(pad.skip).toContain('Select');
    expect(pad.pause).toContain('Start');
    setLanguage('en');
    const en = buttonLabels('gamepad');
    expect([en.action, en.interact, en.attack, en.special, en.call]).toEqual(['the A button', 'the A button', 'the A button', 'the Y button', 'the X button']);
  });

  it('manette PlayStation (A = croix, X = carré, Y = triangle) : croix = action, triangle = spécial, carré = appel', () => {
    const ps = buttonLabels('gamepadPs');
    expect([ps.action, ps.interact, ps.attack]).toEqual(['le bouton croix', 'le bouton croix', 'le bouton croix']);
    expect(ps.special).toContain('triangle');
    expect(ps.call).toContain('carré');
    setLanguage('en');
    const en = buttonLabels('gamepadPs');
    expect(en.action).toContain('cross');
    expect(en.special).toContain('triangle');
    expect(en.call).toContain('square');
  });

  it('tactile : gros A = action, Y = spécial, X (vrai X de la manette virtuelle) = appel ; B n est cité nulle part', () => {
    const touch = buttonLabels('touch');
    expect(touch.move).toContain('stick');
    expect([touch.action, touch.attack, touch.interact]).toEqual(['le gros bouton A', 'le gros bouton A', 'le gros bouton A']);
    expect(touch.special).toContain('Y');
    expect(touch.call).toContain('X');
    for (const lang of ['fr', 'en'] as const) {
      setLanguage(lang);
      for (const dev of ['gamepad', 'gamepadPs', 'touch'] as const) {
        const l = buttonLabels(dev);
        for (const b of ['action', 'attack', 'interact', 'special', 'call'] as const) {
          // jamais LB / RB / LT / RT / L1 / R1 / R2 / L2, ni le bouton B / le rond (sans effet en jeu)
          expect(l[b], `${lang} ${dev} ${b}`).not.toMatch(/(LB|RB|LT|RT|L1|R1|L2|R2)|bouton B|B button|rond|circle/);
        }
      }
    }
  });
});

describe('buttonLabels : bouton « utiliser le cœur » (B)', () => {
  it('clavier : touche des bindings courants (B par défaut, remappage respecté) ; manette : bouton B ; PlayStation : rond ; tactile : bouton B du losange', () => {
    expect(buttonLabels('keyboard').heart).toContain('B');
    const b = createDefaultBindings();
    b.heart.keys = ['KeyV'];
    expect(buttonLabels('keyboard', b).heart).toContain('V');
    expect(buttonLabels('gamepad').heart).toBe('le bouton B');
    expect(buttonLabels('gamepadPs').heart).toBe('le rond');
    expect(buttonLabels('touch').heart).toContain('B');
    setLanguage('en');
    expect(buttonLabels('gamepad').heart).toBe('the B button');
    expect(buttonLabels('gamepadPs').heart).toBe('the circle');
    expect(buttonLabels('touch').heart).toContain('B button');
  });
});
