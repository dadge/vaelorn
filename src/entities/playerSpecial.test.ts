import { describe, expect, it } from 'vitest';
import { spinDir, specialSpins } from './PlayerView';

describe('rotation du héros pendant un spécial', () => {
  it('le tourbillon et la danse des lames tournent, pas les autres', () => {
    expect(specialSpins('whirlwind')).toBe(true);
    expect(specialSpins('bladeDance')).toBe(true);
    for (const k of ['fireNova', 'dash', 'healNova', 'arrowFan', 'quake', 'smash'] as const) expect(specialSpins(k)).toBe(false);
    expect(specialSpins(undefined)).toBe(false);
  });

  it('spinDir parcourt les 4 directions avec le temps restant', () => {
    const seen = new Set<string>();
    for (let ms = 0; ms < 300; ms += 10) seen.add(spinDir(ms));
    expect(seen.size).toBe(4);
    expect(spinDir(-5)).toBe(spinDir(0));
    expect(spinDir(0, 1)).not.toBe(spinDir(0, 0));
  });
});
