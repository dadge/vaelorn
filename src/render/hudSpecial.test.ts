import { describe, expect, it } from 'vitest';
import { CHARACTERS } from '../core/characters';
import { createPlayerState } from '../core/players';
import { keyCodeLabel, padButtonLabel, specialHintLabel, specialPulse, specialStatus } from './hud';

describe('HUD du spécial : charge', () => {
  const ids = Object.keys(CHARACTERS) as Array<keyof typeof CHARACTERS>;

  it('prêt au départ pour les 8 personnages', () => {
    for (const id of ids) {
      const st = specialStatus({ characterId: id, specialCooldownMs: 0 });
      expect(st).toEqual({ has: true, ratio: 1, ready: true, secondsLeft: 0 });
    }
  });

  it('recharge : ratio croissant, secondes arrondies au supérieur', () => {
    const cd = CHARACTERS.david.special!.cooldownMs;
    const just = specialStatus({ characterId: 'david', specialCooldownMs: cd });
    expect(just.ready).toBe(false);
    expect(just.ratio).toBe(0);
    expect(just.secondsLeft).toBe(Math.ceil(cd / 1000));
    const half = specialStatus({ characterId: 'david', specialCooldownMs: cd / 2 });
    expect(half.ratio).toBeCloseTo(0.5);
    const almost = specialStatus({ characterId: 'david', specialCooldownMs: 1 });
    expect(almost.ready).toBe(false);
    expect(almost.secondsLeft).toBe(1);
    expect(almost.ratio).toBeLessThan(1);
  });

  it('valeurs aberrantes : jamais NaN, ratio borné', () => {
    expect(specialStatus({ characterId: 'david', specialCooldownMs: Number.NaN }).ready).toBe(true);
    expect(specialStatus({ characterId: 'david', specialCooldownMs: -50 }).ready).toBe(true);
    const huge = specialStatus({ characterId: 'david', specialCooldownMs: 1e9 });
    expect(huge.ratio).toBe(0);
  });

  it('état réel d’un joueur créé par le moteur', () => {
    const p = createPlayerState({ id: 0, characterId: 'valentine', difficulty: 2 }, { x: 10, y: 10 });
    expect(specialStatus(p).ready).toBe(true);
  });

  it('la pulsation reste dans [0,1]', () => {
    for (let t = 0; t < 2000; t += 37) {
      const v = specialPulse(t);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('HUD du spécial : rappel du bouton', () => {
  const binding = { keys: ['KeyF', 'KeyX'], pad: [3, 5, 7] };

  it('libellés de touches et de boutons', () => {
    expect(keyCodeLabel('KeyF')).toBe('F');
    expect(keyCodeLabel('Digit4')).toBe('4');
    expect(keyCodeLabel('Space')).toBe('Espace');
    expect(keyCodeLabel('ArrowUp')).toBe('↑');
    expect(padButtonLabel(3)).toBe('Y');
    expect(padButtonLabel(5)).toBe('RB');
    expect(padButtonLabel(11)).toBe('B11');
  });

  it('clavier : F/X ; manette : Y ; première source : les deux', () => {
    expect(specialHintLabel({ label: 'keyboard' }, binding)).toBe('F/X');
    expect(specialHintLabel({ label: 'gamepad' }, binding)).toBe('Y');
    expect(specialHintLabel({ label: 'keyboard', anyDevice: true }, binding)).toBe('F/X / Y');
  });

  it('sans information : valeurs par défaut', () => {
    expect(specialHintLabel(undefined, undefined)).toBe('F/X');
    expect(specialHintLabel({ label: 'gamepad' }, undefined)).toBe('Y');
    expect(specialHintLabel({ label: 'gamepad' }, { keys: [], pad: [] })).toBe('Y');
  });
});
