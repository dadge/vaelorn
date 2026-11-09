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

  it('manette : A/B/X/Y/LB ; PlayStation : croix/rond/carré/triangle/L1 ; tactile : boutons de la manette virtuelle', () => {
    const pad = buttonLabels('gamepad');
    expect([pad.action, pad.interact, pad.attack, pad.special, pad.call]).toEqual(['le bouton A', 'le bouton B', 'le bouton X', 'le bouton Y', 'le bouton LB']);
    const ps = buttonLabels('gamepadPs');
    expect(ps.action).toContain('croix');
    expect(ps.attack).toContain('carré');
    expect(ps.interact).toContain('rond');
    expect(ps.special).toContain('triangle');
    expect(ps.call).toContain('L1');
    const touch = buttonLabels('touch');
    expect(touch.move).toContain('stick');
    expect(touch.action).toContain('A');
    // la manette virtuelle n'a PAS de bouton X d'attaque : l'attaque est le gros A ; le bouton affiché « X » est l'APPEL
    expect(touch.attack).toContain('A');
    expect(touch.attack).not.toContain('X');
    expect(touch.call).toContain('X');
  });
});
