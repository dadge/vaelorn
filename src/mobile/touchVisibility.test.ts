import { describe, expect, it } from 'vitest';
import { parseTouchParam, shouldShowVirtualPad, type VirtualPadVisibilityInput } from './device';

const phone: VirtualPadVisibilityInput = { touch: true, landscape: true, param: null, realGamepad: false };

describe('parseTouchParam', () => {
  it('?touch=1 -> on, ?touch=0 -> off, sinon automatique', () => {
    expect(parseTouchParam('?touch=1')).toBe('on');
    expect(parseTouchParam('?quick=1&touch=1&lang=en')).toBe('on');
    expect(parseTouchParam('?touch=0')).toBe('off');
    expect(parseTouchParam('')).toBeNull();
    expect(parseTouchParam('?touch=2')).toBeNull();
    expect(parseTouchParam('?touch=')).toBeNull();
    expect(parseTouchParam('?quick=1')).toBeNull();
  });
});

describe('shouldShowVirtualPad', () => {
  it('appareil tactile en paysage : affichée', () => {
    expect(shouldShowVirtualPad(phone)).toBe(true);
  });
  it('portrait : masquée (l’invite de rotation est affichée)', () => {
    expect(shouldShowVirtualPad({ ...phone, landscape: false })).toBe(false);
  });
  it('ordinateur (pointeur fin) : masquée', () => {
    expect(shouldShowVirtualPad({ ...phone, touch: false })).toBe(false);
  });
  it('?touch=1 : affichée sur PC, même en portrait', () => {
    expect(shouldShowVirtualPad({ ...phone, touch: false, param: 'on' })).toBe(true);
    expect(shouldShowVirtualPad({ ...phone, touch: false, landscape: false, param: 'on' })).toBe(true);
  });
  it('?touch=0 : masquée même sur téléphone', () => {
    expect(shouldShowVirtualPad({ ...phone, param: 'off' })).toBe(false);
  });
  it('une vraie manette connectée la masque (y compris avec ?touch=1), et elle réapparaît quand elle disparaît', () => {
    expect(shouldShowVirtualPad({ ...phone, realGamepad: true })).toBe(false);
    expect(shouldShowVirtualPad({ ...phone, param: 'on', realGamepad: true })).toBe(false);
    expect(shouldShowVirtualPad({ ...phone, realGamepad: false })).toBe(true);
  });
});
