/**
 * Butin de vie — fonctions pures (`loot.ts`) et constantes d'équilibrage ([B10]-[B17]) :
 * table par palier, fréquences sur grand échantillon, demi-boss garanti, invoqués / boss finaux sans butin, adaptation au besoin
 * (×0,5 / ×1 / ×2, plafond 90 %), garantie anti-malchance (déclenchement exact, remise à zéro), ramassage (soin plafonné, rayon, PV pleins, à terre),
 * péremption de la nourriture au sol.
 */
import { describe, expect, it } from 'vitest';
import {
  HEAL_CRYSTAL_HEAL,
  HP_PER_HEART,
  LOOT_FULL_HEAL,
  LOOT_HALF_HEAL,
  LOOT_MAX_CHANCE,
  LOOT_PITY_DRY_KILLS,
  LOOT_PITY_HP_FRACTION,
  LOOT_SEED_XOR,
  LOOT_TIERS,
  PICKUP_BLINK_MS,
  PICKUP_RADIUS,
  PICKUP_TTL_MS,
} from './balance';
import { ENEMY_KINDS, ENEMIES } from './enemies';
import {
  agePickups,
  collectorFor,
  healAmountFor,
  isPickupBlinking,
  isSummonedEnemy,
  lootChances,
  lootNeedMultiplier,
  lootTierOf,
  mostWoundedFraction,
  pickupHealValue,
  rollLoot,
} from './loot';
import { createRng, nextRandom } from './rng';
import { createEnemyState } from './ai';
import { SUMMON_WAVE } from './constants';
import type { EnemyKind, PickupState, PlayerState } from './types';

/** Joueur minimal pour les fonctions pures. */
function pl(over: Partial<PlayerState> & { id?: number } = {}): PlayerState {
  return { id: 0, hp: 50, maxHp: 100, status: 'alive', pos: { x: 100, y: 100 }, ...over } as unknown as PlayerState;
}

describe('constantes de butin', () => {
  it('1 cœur = 10 PV ; demi = 5 ; entier = 10 ; cristal = 50 PV (5 cœurs)', () => {
    expect(HP_PER_HEART).toBe(10);
    expect(LOOT_HALF_HEAL).toBe(5);
    expect(LOOT_FULL_HEAL).toBe(10);
    expect(HEAL_CRYSTAL_HEAL).toBe(50);
  });
  it('nourriture : 12 s de vie, clignote les 3 dernières secondes, rayon 14 px ; garantie : 6 morts et 70 % ; plafond 90 %', () => {
    expect(PICKUP_TTL_MS).toBe(12000);
    expect(PICKUP_BLINK_MS).toBe(3000);
    expect(PICKUP_RADIUS).toBe(14);
    expect(LOOT_PITY_DRY_KILLS).toBe(6);
    expect(LOOT_PITY_HP_FRACTION).toBe(0.7);
    expect(LOOT_MAX_CHANCE).toBe(0.9);
  });
  it('table : faible 12 % / 3 %, standard 18 % / 6 %, costaud 40 % / 20 %', () => {
    expect(LOOT_TIERS.weak).toMatchObject({ maxBaseHp: 25, half: 0.12, full: 0.03 });
    expect(LOOT_TIERS.standard).toMatchObject({ maxBaseHp: 40, half: 0.18, full: 0.06 });
    expect(LOOT_TIERS.tough).toMatchObject({ half: 0.4, full: 0.2 });
  });
  it('gain moyen à besoin neutre ≈ 1,5 PV par ennemi standard (0,9 faible, 4 costaud)', () => {
    const gain = (t: 'weak' | 'standard' | 'tough') => LOOT_TIERS[t].half * LOOT_HALF_HEAL + LOOT_TIERS[t].full * LOOT_FULL_HEAL;
    expect(gain('weak')).toBeCloseTo(0.9, 10);
    expect(gain('standard')).toBeCloseTo(1.5, 10);
    expect(gain('tough')).toBeCloseTo(4, 10);
  });
});

describe('palier de butin par type d\'ennemi', () => {
  it('faible (PV <= 25) : slime, chauve-souris, feu follet', () => {
    for (const k of ['slime', 'bat', 'wisp'] as const) expect(lootTierOf(k), k).toBe('weak');
  });
  it('standard (PV 26 à 40) : squelette, archer, araignée', () => {
    for (const k of ['skeleton', 'archer', 'spider'] as const) expect(lootTierOf(k), k).toBe('standard');
  });
  it('costaud (90 PV, hors boss) : chevalier', () => {
    expect(lootTierOf('knight')).toBe('tough');
  });
  it('demi-boss : cœur garanti ; boss finaux : rien', () => {
    for (const k of ['warden', 'pyromancer', 'wraith'] as const) expect(lootTierOf(k), k).toBe('miniBoss');
    for (const k of ['golem', 'morvane', 'frostqueen', 'forgelord', 'voidlord'] as const) expect(lootTierOf(k), k).toBe('none');
  });
  it('tous les types d\'ennemis ont un palier, cohérent avec isBoss / isMiniBoss et les PV de base', () => {
    for (const k of ENEMY_KINDS) {
      const def = ENEMIES[k];
      const tier = lootTierOf(k);
      if (def.isBoss) expect(tier).toBe('none');
      else if (def.isMiniBoss) expect(tier).toBe('miniBoss');
      else if (def.hp <= 25) expect(tier).toBe('weak');
      else if (def.hp <= 40) expect(tier).toBe('standard');
      else expect(tier).toBe('tough');
    }
  });
});

describe('invoqués (marqueur SUMMON_WAVE)', () => {
  it('un ennemi créé avec la vague d\'invocation est invoqué ; un ennemi de niveau (vague 0, 1…) ne l\'est pas', () => {
    expect(isSummonedEnemy(createEnemyState('slime', { x: 0, y: 0 }, 1, SUMMON_WAVE))).toBe(true);
    expect(isSummonedEnemy(createEnemyState('slime', { x: 0, y: 0 }, 2, 0))).toBe(false);
    expect(isSummonedEnemy(createEnemyState('slime', { x: 0, y: 0 }, 3, 2))).toBe(false);
  });
  it('rollLoot : jamais de butin ni de tirage pour un invoqué, quel que soit son type, même avec la garantie prête', () => {
    for (const kind of ['slime', 'knight', 'warden', 'golem'] as const) {
      let draws = 0;
      const r = rollLoot({ kind, summoned: true, hurtFraction: 0.1, dryKills: 99, random: () => (draws++, 0) });
      expect(r, kind).toEqual({ drop: null, dryKills: 99 });
      expect(draws, kind).toBe(0);
    }
  });
});

describe('demi-boss et boss finaux', () => {
  it('un demi-boss laisse TOUJOURS un cœur entier, sans tirage, et remet le compteur à zéro', () => {
    for (const kind of ['warden', 'pyromancer', 'wraith'] as const) {
      let draws = 0;
      const r = rollLoot({ kind, summoned: false, hurtFraction: 1, dryKills: 3, random: () => (draws++, 0.999) });
      expect(r).toEqual({ drop: 'full', dryKills: 0 });
      expect(draws).toBe(0);
    }
  });
  it('un boss final ne laisse rien (aucun tirage, compteur inchangé), même à PV très bas', () => {
    for (const kind of ['golem', 'morvane', 'frostqueen', 'forgelord', 'voidlord'] as const) {
      let draws = 0;
      const r = rollLoot({ kind, summoned: false, hurtFraction: 0.05, dryKills: 9, random: () => (draws++, 0) });
      expect(r).toEqual({ drop: null, dryKills: 9 });
      expect(draws).toBe(0);
    }
  });
  it('un ennemi ordinaire consomme exactement UN tirage', () => {
    let draws = 0;
    rollLoot({ kind: 'skeleton', summoned: false, hurtFraction: 0.5, dryKills: 0, random: () => (draws++, 0.5) });
    expect(draws).toBe(1);
  });
});

describe('fréquences sur grand échantillon (besoin neutre : PV du plus blessé à 50 %, ×1)', () => {
  const N = 300_000;
  function freq(kind: EnemyKind, hurt = 0.5): { none: number; half: number; full: number } {
    const rng = createRng(2024);
    let half = 0;
    let full = 0;
    for (let i = 0; i < N; i++) {
      // dryKills = 0 : la garantie anti-malchance ne s'en mêle pas
      const r = rollLoot({ kind, summoned: false, hurtFraction: hurt, dryKills: 0, random: () => nextRandom(rng) });
      if (r.drop === 'half') half++;
      else if (r.drop === 'full') full++;
    }
    return { none: (N - half - full) / N, half: half / N, full: full / N };
  }
  it('faible : rien 85 %, demi 12 %, entier 3 %', () => {
    const f = freq('slime');
    expect(f.none).toBeCloseTo(0.85, 2);
    expect(f.half).toBeCloseTo(0.12, 2);
    expect(f.full).toBeCloseTo(0.03, 2);
  });
  it('standard : rien 76 %, demi 18 %, entier 6 %', () => {
    const f = freq('skeleton');
    expect(f.none).toBeCloseTo(0.76, 2);
    expect(f.half).toBeCloseTo(0.18, 2);
    expect(f.full).toBeCloseTo(0.06, 2);
  });
  it('costaud : rien 40 %, demi 40 %, entier 20 %', () => {
    const f = freq('knight');
    expect(f.none).toBeCloseTo(0.4, 2);
    expect(f.half).toBeCloseTo(0.4, 2);
    expect(f.full).toBeCloseTo(0.2, 2);
  });
  it('indépendant de la difficulté : la table ne lit que le type d\'ennemi et les PV du joueur (jamais de paramètre de difficulté)', () => {
    // rollLoot n'a aucune entrée de difficulté : deux appels identiques donnent le même résultat
    const a = rollLoot({ kind: 'skeleton', summoned: false, hurtFraction: 0.5, dryKills: 0, random: () => 0.1 });
    const b = rollLoot({ kind: 'skeleton', summoned: false, hurtFraction: 0.5, dryKills: 0, random: () => 0.1 });
    expect(a).toEqual(b);
  });
});

describe('adaptation au besoin', () => {
  it('multiplicateur : ×0,5 à PV pleins, ×1 à 50 %, ×2 à <= 30 % (plafonné)', () => {
    expect(lootNeedMultiplier(1)).toBeCloseTo(0.5, 10);
    expect(lootNeedMultiplier(0.5)).toBeCloseTo(1, 10);
    expect(lootNeedMultiplier(0.3)).toBeCloseTo(2, 10);
    expect(lootNeedMultiplier(0.1)).toBe(2);
    expect(lootNeedMultiplier(0)).toBe(2);
    expect(lootNeedMultiplier(1.5)).toBe(0.5);
  });
  it('interpolation linéaire par morceaux : 75 % → ×0,75 ; 40 % → ×1,5', () => {
    expect(lootNeedMultiplier(0.75)).toBeCloseTo(0.75, 10);
    expect(lootNeedMultiplier(0.4)).toBeCloseTo(1.5, 10);
    expect(lootNeedMultiplier(0.9)).toBeCloseTo(0.6, 10);
  });
  it('valeur non finie : traitée comme PV pleins', () => {
    expect(lootNeedMultiplier(Number.NaN)).toBe(0.5);
  });
  it('s\'applique à la SOMME des deux chances ; la répartition demi / entier reste celle de la table', () => {
    const base = LOOT_TIERS.standard.half + LOOT_TIERS.standard.full;
    for (const mult of [0.5, 1, 1.5]) {
      const c = lootChances('standard', mult);
      expect(c.total).toBeCloseTo(base * mult, 10);
      expect(c.half + c.full).toBeCloseTo(c.total, 10);
      expect(c.full / c.total).toBeCloseTo(LOOT_TIERS.standard.full / base, 10);
    }
  });
  it('probabilité totale plafonnée à 90 % (costaud à ×2 : 60 % × 2 = 120 % → 90 %)', () => {
    const c = lootChances('tough', 2);
    expect(c.total).toBe(0.9);
    expect(c.half + c.full).toBeCloseTo(0.9, 10);
    expect(c.full / c.total).toBeCloseTo(1 / 3, 10);
    expect(lootChances('tough', 1.4).total).toBeCloseTo(0.84, 10);
  });
  it('fréquence mesurée : un joueur à 20 % de PV double la chance d\'un standard ; à PV pleins elle est divisée par 2', () => {
    const N = 200_000;
    const rate = (hurt: number): number => {
      const rng = createRng(7);
      let n = 0;
      for (let i = 0; i < N; i++) if (rollLoot({ kind: 'skeleton', summoned: false, hurtFraction: hurt, dryKills: 0, random: () => nextRandom(rng) }).drop) n++;
      return n / N;
    };
    expect(rate(0.2)).toBeCloseTo(0.48, 2);
    expect(rate(0.5)).toBeCloseTo(0.24, 2);
    expect(rate(1)).toBeCloseTo(0.12, 2);
  });
  it('mostWoundedFraction : le plus blessé parmi les VIVANTS (un joueur à terre est ignoré) ; 1 si personne', () => {
    expect(mostWoundedFraction([pl({ hp: 80, maxHp: 100 }), pl({ hp: 30, maxHp: 60 })])).toBeCloseTo(0.5, 10);
    expect(mostWoundedFraction([pl({ hp: 80, maxHp: 100 }), pl({ hp: 0, maxHp: 60, status: 'down' })])).toBeCloseTo(0.8, 10);
    expect(mostWoundedFraction([pl({ hp: 0, maxHp: 60, status: 'down' })])).toBe(1);
    expect(mostWoundedFraction([])).toBe(1);
  });
});

describe('garantie anti-malchance', () => {
  const miss = (): number => 0.999;
  it('6 morts sans butin ET le plus blessé sous 70 % : la mort suivante laisse AU MOINS un demi-cœur', () => {
    let dry = 0;
    for (let i = 0; i < LOOT_PITY_DRY_KILLS; i++) {
      const r = rollLoot({ kind: 'slime', summoned: false, hurtFraction: 0.5, dryKills: dry, random: miss });
      expect(r.drop, `mort ${i + 1}`).toBeNull();
      dry = r.dryKills;
    }
    expect(dry).toBe(6);
    const seventh = rollLoot({ kind: 'slime', summoned: false, hurtFraction: 0.5, dryKills: dry, random: miss });
    expect(seventh).toEqual({ drop: 'half', dryKills: 0 });
  });
  it('déclenchement exact : 5 morts sèches → pas de garantie ; 6 → garantie', () => {
    expect(rollLoot({ kind: 'slime', summoned: false, hurtFraction: 0.5, dryKills: 5, random: miss }).drop).toBeNull();
    expect(rollLoot({ kind: 'slime', summoned: false, hurtFraction: 0.5, dryKills: 6, random: miss }).drop).toBe('half');
    expect(rollLoot({ kind: 'slime', summoned: false, hurtFraction: 0.5, dryKills: 40, random: miss }).drop).toBe('half');
  });
  it('seuil de PV : strictement sous 70 % (69 % déclenche, 70 % et plus non)', () => {
    expect(rollLoot({ kind: 'skeleton', summoned: false, hurtFraction: 0.69, dryKills: 6, random: miss }).drop).toBe('half');
    expect(rollLoot({ kind: 'skeleton', summoned: false, hurtFraction: 0.7, dryKills: 6, random: miss }).drop).toBeNull();
    expect(rollLoot({ kind: 'skeleton', summoned: false, hurtFraction: 1, dryKills: 6, random: miss }).drop).toBeNull();
  });
  it('« au moins » : un tirage naturel d\'un cœur entier reste un cœur entier', () => {
    expect(rollLoot({ kind: 'knight', summoned: false, hurtFraction: 0.5, dryKills: 6, random: () => 0 }).drop).toBe('full');
  });
  it('remise à zéro à chaque butin (naturel ou garanti) ; incrémentation à chaque mort sans butin', () => {
    expect(rollLoot({ kind: 'slime', summoned: false, hurtFraction: 1, dryKills: 4, random: () => 0 })).toEqual({ drop: 'full', dryKills: 0 });
    expect(rollLoot({ kind: 'slime', summoned: false, hurtFraction: 1, dryKills: 4, random: miss })).toEqual({ drop: null, dryKills: 5 });
    expect(rollLoot({ kind: 'slime', summoned: false, hurtFraction: 0.2, dryKills: 9, random: miss })).toEqual({ drop: 'half', dryKills: 0 });
  });
  it('les invoqués et les boss ne font pas avancer le compteur', () => {
    expect(rollLoot({ kind: 'slime', summoned: true, hurtFraction: 0.2, dryKills: 3, random: miss }).dryKills).toBe(3);
    expect(rollLoot({ kind: 'voidlord', summoned: false, hurtFraction: 0.2, dryKills: 3, random: miss }).dryKills).toBe(3);
  });
});

describe('ramassage (fonctions pures)', () => {
  it('valeurs : demi 5 PV, entier 10 PV', () => {
    expect(pickupHealValue('half')).toBe(5);
    expect(pickupHealValue('full')).toBe(10);
  });
  it('soin = min(valeur, manque) ; 0 pour un joueur aux PV pleins ou à terre', () => {
    expect(healAmountFor(pl({ hp: 90, maxHp: 100 }), 5)).toBe(5);
    expect(healAmountFor(pl({ hp: 97, maxHp: 100 }), 10)).toBe(3);
    expect(healAmountFor(pl({ hp: 100, maxHp: 100 }), 10)).toBe(0);
    expect(healAmountFor(pl({ hp: 0, maxHp: 100, status: 'down' }), 10)).toBe(0);
  });
  it('collectorFor : joueur vivant blessé le plus proche dans le rayon ; rayon 14 px inclusif', () => {
    const a = pl({ id: 0 as never, hp: 50, pos: { x: 100, y: 100 } });
    const b = pl({ id: 1 as never, hp: 50, pos: { x: 108, y: 100 } });
    expect(collectorFor([a, b], { x: 110, y: 100 }, PICKUP_RADIUS)).toBe(b);
    expect(collectorFor([a, b], { x: 100, y: 100 + PICKUP_RADIUS }, PICKUP_RADIUS)).toBe(a);
    expect(collectorFor([a], { x: 100, y: 100 + PICKUP_RADIUS + 0.5 }, PICKUP_RADIUS)).toBeNull();
  });
  it('collectorFor : ni un joueur à PV pleins ni un joueur à terre (l\'allié blessé, lui, la prend)', () => {
    const full = pl({ id: 0 as never, hp: 100, maxHp: 100, pos: { x: 100, y: 100 } });
    const down = pl({ id: 1 as never, hp: 0, status: 'down', pos: { x: 100, y: 100 } });
    const hurt = pl({ id: 2 as never, hp: 40, pos: { x: 110, y: 100 } });
    expect(collectorFor([full, down], { x: 100, y: 100 }, PICKUP_RADIUS)).toBeNull();
    expect(collectorFor([full, down, hurt], { x: 100, y: 100 }, PICKUP_RADIUS)).toBe(hurt);
  });
});

describe('durée de vie de la nourriture', () => {
  const mk = (id: number, ttlMs: number): PickupState => ({ id, kind: 'half', pos: { x: 0, y: 0 }, ttlMs });
  it('agePickups retire les objets périmés (ttl <= 0) et garde les autres dans l\'ordre', () => {
    const list = [mk(1, 100), mk(2, 5000), mk(3, 50), mk(4, 12000)];
    const gone = agePickups(list, 100);
    expect(gone.map((p) => p.id)).toEqual([1, 3]);
    expect(list.map((p) => p.id)).toEqual([2, 4]);
    expect(list[0].ttlMs).toBe(4900);
  });
  it('clignote pendant les 3 dernières secondes seulement', () => {
    expect(isPickupBlinking(mk(1, 3001))).toBe(false);
    expect(isPickupBlinking(mk(1, 3000))).toBe(true);
    expect(isPickupBlinking(mk(1, 10))).toBe(true);
  });
});

describe('flux PRNG dédié', () => {
  it('la constante de dérivation est distincte de zéro (graine du butin ≠ graine de la simulation)', () => {
    expect(LOOT_SEED_XOR).not.toBe(0);
  });
});
