import { describe, expect, it } from 'vitest';
import { ENEMIES, ENEMY_KINDS } from '../core/enemies';
import type { EnemyKind, EnemyState } from '../core/types';
import { MAX_BOSS_BARS, bossBarColor, bossBarEntries, bossBarFrameColor, bossBarSignature, bossBarTier, hpRatio } from './bossBars';

function enemy(id: number, kind: EnemyKind, hp: number, over: Partial<EnemyState> = {}): EnemyState {
  return {
    id, kind, pos: { x: 0, y: 0 }, facing: 'down', hp, maxHp: 100, mode: 'idle', modeTimerMs: 0, attackCooldownMs: 0, hitFlashMs: 0,
    data: {}, phase: 0, targetId: -1, wave: 0, dead: false, ...over,
  };
}
const lookup = (k: string) => ENEMIES[k as EnemyKind];

describe('barres de vie des demi-boss et des boss', () => {
  it('hpRatio borné, jamais NaN', () => {
    expect(hpRatio({ hp: 50, maxHp: 100 })).toBe(0.5);
    expect(hpRatio({ hp: 500, maxHp: 100 })).toBe(1);
    expect(hpRatio({ hp: -5, maxHp: 100 })).toBe(0);
    expect(hpRatio({ hp: 5, maxHp: 0 })).toBe(0);
    expect(hpRatio({ hp: Number.NaN, maxHp: 10 })).toBe(0);
  });

  it('palier : défini par EnemyDef (isBoss / isMiniBoss) pour tous les types, avec repli sur les helpers du core', () => {
    for (const k of ENEMY_KINDS) {
      const def = ENEMIES[k];
      const tier = bossBarTier(k, def);
      if (def.isBoss) expect(tier, k).toBe('boss');
      else if (def.isMiniBoss) expect(tier, k).toBe('mini');
      else expect(tier, k).toBeNull();
      expect(bossBarTier(k), `${k} sans def`).toBe(tier);
    }
    for (const k of ['warden', 'pyromancer', 'wraith'] as const) expect(bossBarTier(k, ENEMIES[k])).toBe('mini');
    for (const k of ['golem', 'morvane', 'frostqueen', 'forgelord', 'voidlord'] as const) expect(bossBarTier(k, ENEMIES[k])).toBe('boss');
  });

  it('entrées : boss d abord, puis demi-boss ; normaux, morts et à 0 PV exclus ; nom = nameKey de l EnemyDef', () => {
    const list = [
      enemy(1, 'slime', 10),
      enemy(2, 'warden', 60),
      enemy(3, 'frostqueen', 100, { phase: 1 }),
      enemy(4, 'wraith', 0),
      enemy(5, 'pyromancer', 30, { dead: true }),
      enemy(6, 'pyromancer', 25),
    ];
    const e = bossBarEntries(list, lookup);
    expect(e.map((x) => x.enemyId)).toEqual([3, 2, 6]);
    expect(e.map((x) => x.tier)).toEqual(['boss', 'mini', 'mini']);
    expect(e[0].nameKey).toBe(ENEMIES.frostqueen.nameKey);
    expect(e[1].ratio).toBeCloseTo(0.6);
    expect(e[0].phase).toBe(1);
  });

  it('au plus MAX_BOSS_BARS barres ; sans table de définitions : nameKey = enemy.<kind>', () => {
    const many = (['warden', 'wraith', 'pyromancer', 'warden', 'wraith'] as EnemyKind[]).map((k, i) => enemy(i + 1, k, 50));
    expect(bossBarEntries(many, lookup)).toHaveLength(MAX_BOSS_BARS);
    expect(bossBarEntries(many, lookup, 1)).toHaveLength(1);
    const noDef = bossBarEntries([enemy(1, 'golem', 50)], () => undefined);
    expect(noDef[0].nameKey).toBe('enemy.golem');
    expect(bossBarEntries([], lookup)).toEqual([]);
  });

  it('couleurs : boss plus vif par phase, demi-boss ambre ; signature indépendante des PV', () => {
    expect(bossBarColor('boss', 2)).not.toBe(bossBarColor('boss', 0));
    expect(bossBarColor('mini', 0)).not.toBe(bossBarColor('boss', 0));
    expect(bossBarFrameColor('boss')).not.toBe(bossBarFrameColor('mini'));
    const a = bossBarEntries([enemy(3, 'frostqueen', 90), enemy(2, 'warden', 60)], lookup);
    const b = bossBarEntries([enemy(3, 'frostqueen', 10), enemy(2, 'warden', 5)], lookup);
    expect(bossBarSignature(a)).toBe(bossBarSignature(b));
  });
});
