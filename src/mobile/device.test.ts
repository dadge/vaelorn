import { describe, expect, it } from 'vitest';
import { computeMobileUi, isPortrait, type MobileEnvironment } from './device';

const phoneLandscape: MobileEnvironment = { coarsePointer: true, width: 844, height: 390, installed: false, fullscreen: false, fullscreenSupported: true };

describe('isPortrait', () => {
  it('portrait = plus haut que large', () => {
    expect(isPortrait(390, 844)).toBe(true);
    expect(isPortrait(844, 390)).toBe(false);
    expect(isPortrait(500, 500)).toBe(false);
  });
  it('valeurs invalides : faux', () => {
    expect(isPortrait(NaN, 800)).toBe(false);
    expect(isPortrait(0, 800)).toBe(false);
    expect(isPortrait(400, Infinity)).toBe(false);
  });
});

describe('computeMobileUi', () => {
  it('téléphone en paysage : bouton plein écran, pas d\'invite de rotation', () => {
    expect(computeMobileUi(phoneLandscape)).toEqual({ touch: true, showRotatePrompt: false, showFullscreenButton: true });
  });

  it('téléphone en portrait : invite de rotation', () => {
    const s = computeMobileUi({ ...phoneLandscape, width: 390, height: 844 });
    expect(s.showRotatePrompt).toBe(true);
  });

  it('ordinateur (pointeur fin) : aucune interface mobile, même dans une fenêtre en portrait', () => {
    const s = computeMobileUi({ ...phoneLandscape, coarsePointer: false, width: 600, height: 900 });
    expect(s).toEqual({ touch: false, showRotatePrompt: false, showFullscreenButton: false });
  });

  it('déjà en plein écran ou application installée : pas de bouton plein écran', () => {
    expect(computeMobileUi({ ...phoneLandscape, fullscreen: true }).showFullscreenButton).toBe(false);
    expect(computeMobileUi({ ...phoneLandscape, installed: true }).showFullscreenButton).toBe(false);
  });

  it('API plein écran indisponible (ex. iPhone / Safari) : pas de bouton, mais l\'invite de rotation reste', () => {
    const s = computeMobileUi({ ...phoneLandscape, fullscreenSupported: false, width: 390, height: 844 });
    expect(s.showFullscreenButton).toBe(false);
    expect(s.showRotatePrompt).toBe(true);
  });

  it('application installée en portrait : invite de rotation quand même', () => {
    expect(computeMobileUi({ ...phoneLandscape, installed: true, width: 390, height: 844 }).showRotatePrompt).toBe(true);
  });
});
