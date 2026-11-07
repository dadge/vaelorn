import { describe, expect, it } from 'vitest';
import { parseSmoothValue, resolveSmoothing } from './smoothing';

describe('rendu doux / pixel', () => {
  it('reconnaît les valeurs usuelles', () => {
    expect(parseSmoothValue('1')).toBe(true);
    expect(parseSmoothValue('smooth')).toBe(true);
    expect(parseSmoothValue('0')).toBe(false);
    expect(parseSmoothValue('pixel')).toBe(false);
    expect(parseSmoothValue('peut-être')).toBeUndefined();
    expect(parseSmoothValue(null)).toBeUndefined();
  });
  it('par défaut : doux', () => {
    expect(resolveSmoothing('', null)).toEqual({ smooth: true });
    expect(resolveSmoothing('?quick=1', 'n’importe quoi')).toEqual({ smooth: true });
  });
  it('la valeur mémorisée est reprise', () => {
    expect(resolveSmoothing('', '0')).toEqual({ smooth: false });
    expect(resolveSmoothing('', '1')).toEqual({ smooth: true });
  });
  it('l’URL l’emporte et demande à être mémorisée', () => {
    expect(resolveSmoothing('?smooth=0', '1')).toEqual({ smooth: false, persist: false });
    expect(resolveSmoothing('?smooth=1', '0')).toEqual({ smooth: true, persist: true });
    expect(resolveSmoothing('?smooth=zzz', '0')).toEqual({ smooth: false });
  });
});
