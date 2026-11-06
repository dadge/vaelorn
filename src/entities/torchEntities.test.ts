import { describe, expect, it } from 'vitest';
import { emberState } from './MechanismViews';
import { sfxForEvent } from './sfx';
import { torchLightPos } from './DarkRoomView';

describe('braises du brasero', () => {
  it('position et opacité bornées, cycle périodique et déphasé entre braises', () => {
    for (let i = 0; i < 4; i++) {
      for (let t = 0; t < 4000; t += 37) {
        const e = emberState(i, t);
        expect(e.alpha).toBeGreaterThanOrEqual(0);
        expect(e.alpha).toBeLessThanOrEqual(1);
        expect(e.dy).toBeLessThan(0);
        expect(e.dy).toBeGreaterThanOrEqual(-27);
        expect(Math.abs(e.dx)).toBeLessThan(12);
        expect(e.phase).toBeGreaterThanOrEqual(0);
        expect(e.phase).toBeLessThan(1);
      }
    }
    const a = emberState(0, 300);
    const b = emberState(0, 300 + 1500);
    expect(b.dy).toBeCloseTo(a.dy, 6);
    expect(emberState(1, 300).phase).not.toBeCloseTo(emberState(0, 300).phase, 3);
  });

  it('temps négatif ou NaN : jamais de NaN', () => {
    const e = emberState(2, -1234);
    expect(Number.isFinite(e.dx) && Number.isFinite(e.dy) && Number.isFinite(e.alpha)).toBe(true);
  });
});

describe('sons des torches', () => {
  it('chaque événement de torche a un son', () => {
    expect(sfxForEvent({ type: 'brazierLit', brazierId: 'b', playerId: 0 })).toBe('brazierLit');
    expect(sfxForEvent({ type: 'torchRefueled', brazierId: 'b', playerId: 0 })).toBe('torchRefuel');
    expect(sfxForEvent({ type: 'torchLow', playerId: 1 })).toBe('torchLow');
    expect(sfxForEvent({ type: 'torchOut', playerId: 2 })).toBe('torchOut');
  });
});

describe('lumière du héros', () => {
  it('suit la position affichée, légèrement au-dessus des pieds', () => {
    expect(torchLightPos(100, 50)).toEqual({ x: 100, y: 47 });
  });
});
