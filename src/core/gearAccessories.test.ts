/**
 * Accessoires et bonus temporaires — logique PURE (`gear.ts`, `balance.ts` [B26] / [B27]) : effets par niveau (lanterne, aimant, cor de guerre, anneau du vampire),
 * plafonds de vitesse, rage, étoile, durée et relance des bonus, perte (`stripLoadout`), normalisation d'anciens états, échange manuel (`swapCandidate`),
 * attraction de l'aimant, tirage de la sorte d'accessoire (anneau rare, toujours niveau III), budget et tirage des bonus temporaires.
 */
import { describe, expect, it } from 'vitest';
import {
  ACCESSORY_BONUS,
  ACCESSORY_KIND_WEIGHTS,
  BUFF_BUDGET_PER_PLAYER,
  BUFF_DURATION_MS,
  BUFF_KIND_WEIGHTS,
  BUFF_RAGE_BONUS,
  BUFF_SPEED_BONUS,
  BUFF_SPEED_TOTAL_CAP,
  BUFF_STAR_DURATION_MS,
  GEAR_CAPS,
  GEAR_PICKUP_RADIUS,
  HORN_DURATION_MS,
  MAGNET_PULL_SPEED,
  VAMPIRE_HEAL_HP,
  VAMPIRE_KILLS_PER_HEAL,
} from './balance';
import { CHARACTERS } from './characters';
import {
  accessoryKindWeights,
  accessoryLevel,
  addBuff,
  attackDamageMultiplier,
  buffDurationMs,
  buffRemainingMs,
  createGear,
  createLoadout,
  equipItem,
  hasBuff,
  hasVampireRing,
  hornBuffFor,
  hornSpeedBonus,
  isStarActive,
  lanternReduction,
  magnetRadius,
  magnetStep,
  normalizeLoadout,
  pickBuffKind,
  pickGearItem,
  rageMultiplier,
  registerRingKill,
  rollBuffBudget,
  rollBuffDrop,
  speedBonus,
  stepBuffs,
  stripLoadout,
  swapCandidate,
  type BuffRollInput,
} from './gear';
import { nextRandom, seedToState, type RngHolder } from './rng';
import type { AccessoryKind, EnemyKind, GearDropState, GearLevel, PlayerGear, PlayerId, PlayerLoadout } from './types';

function rngOf(seed: number): () => number {
  const h: RngHolder = { rngState: seedToState(seed) };
  return () => nextRandom(h);
}

function loadoutWith(over: Partial<PlayerLoadout> = {}): PlayerLoadout {
  return { ...createLoadout(), ...over };
}

function acc(kind: AccessoryKind, level: GearLevel): PlayerGear['accessory'] {
  return { kind, level };
}

describe('accessoires : valeurs [B26] par niveau', () => {
  it('lanterne -30 / -50 / -70 % d\'usure, aimant 50 / 80 / 120 px, cor +20 / +30 / +40 %', () => {
    expect(ACCESSORY_BONUS.lantern).toEqual([0.3, 0.5, 0.7]);
    expect(ACCESSORY_BONUS.magnet).toEqual([50, 80, 120]);
    expect(ACCESSORY_BONUS.warhorn).toEqual([0.2, 0.3, 0.4]);
    for (const lv of [1, 2, 3] as const) {
      expect(lanternReduction({ ...createGear(), accessory: acc('lantern', lv) })).toBe(ACCESSORY_BONUS.lantern[lv - 1]);
      expect(magnetRadius({ ...createGear(), accessory: acc('magnet', lv) })).toBe(ACCESSORY_BONUS.magnet[lv - 1]);
      expect(hornSpeedBonus({ ...createGear(), accessory: acc('warhorn', lv) })).toBe(ACCESSORY_BONUS.warhorn[lv - 1]);
    }
  });
  it('un accessoire n\'a d\'effet que pour SA sorte (une seule sorte à la fois)', () => {
    const g: PlayerGear = { ...createGear(), accessory: acc('magnet', 2) };
    expect(lanternReduction(g)).toBe(0);
    expect(hornSpeedBonus(g)).toBe(0);
    expect(hasVampireRing(g)).toBe(false);
    expect(magnetRadius(g)).toBe(80);
    expect(accessoryLevel(g, 'magnet')).toBe(2);
    expect(accessoryLevel(g, 'lantern')).toBe(0);
    expect(lanternReduction(undefined)).toBe(0);
    expect(magnetRadius(undefined)).toBe(0);
  });
  it('anneau du vampire : niveau III uniquement', () => {
    expect(hasVampireRing({ ...createGear(), accessory: acc('vampire', 3) })).toBe(true);
    expect(hasVampireRing({ ...createGear(), accessory: acc('vampire', 2) })).toBe(false);
    expect(hasVampireRing(createGear())).toBe(false);
  });
});

describe('anneau du vampire : +1 PV tous les 3 ennemis tués', () => {
  it('constantes : 1 PV tous les 3 ennemis', () => {
    expect(VAMPIRE_HEAL_HP).toBe(1);
    expect(VAMPIRE_KILLS_PER_HEAL).toBe(3);
  });
  it('le 3e ennemi rend 1 PV, puis le compteur repart de 0', () => {
    const l = loadoutWith({ accessory: acc('vampire', 3) });
    const heals: number[] = [];
    for (let i = 0; i < 7; i++) heals.push(registerRingKill(l));
    expect(heals).toEqual([0, 0, 1, 0, 0, 1, 0]);
    expect(l.ringKills).toBe(1);
  });
  it('sans anneau : rien n\'est compté', () => {
    const l = loadoutWith({ accessory: acc('lantern', 3) });
    for (let i = 0; i < 6; i++) expect(registerRingKill(l)).toBe(0);
    expect(l.ringKills).toBeUndefined();
  });
  it('le compteur disparaît quand l\'anneau n\'est plus porté (perte, échange)', () => {
    const l = loadoutWith({ accessory: acc('vampire', 3) });
    registerRingKill(l);
    expect(l.ringKills).toBe(1);
    equipItem(l, { slot: 'accessory', level: 1, accessory: 'lantern' });
    expect(l.ringKills).toBeUndefined();
    const m = loadoutWith({ accessory: acc('vampire', 3), ringKills: 2 });
    stripLoadout(m);
    expect(m.ringKills).toBeUndefined();
  });
});

describe('vitesse : bottes + effet temporaire, plafonds', () => {
  it('bottes seules : plafonnées à +30 %', () => {
    expect(speedBonus({ ...createGear(), boots: 3 })).toBeCloseTo(GEAR_CAPS.speed, 9);
    expect(speedBonus(createGear())).toBe(0);
    expect(speedBonus(undefined)).toBe(0);
  });
  it('potion de vitesse : +40 % ; avec des bottes ailées, plafond GLOBAL +60 %', () => {
    expect(speedBonus(loadoutWith({ buffs: [{ kind: 'speed', remainingMs: 1000 }] }))).toBeCloseTo(BUFF_SPEED_BONUS, 9);
    expect(speedBonus(loadoutWith({ boots: 1, buffs: [{ kind: 'speed', remainingMs: 1000 }] }))).toBeCloseTo(0.5, 9);
    expect(speedBonus(loadoutWith({ boots: 3, buffs: [{ kind: 'speed', remainingMs: 1000 }] }))).toBeCloseTo(BUFF_SPEED_TOTAL_CAP, 9);
  });
  it('le bonus du cor d\'un allié s\'ajoute aux bottes mais ne se cumule JAMAIS avec la potion (le plus fort des deux)', () => {
    expect(speedBonus(loadoutWith({ buffs: [{ kind: 'horn', remainingMs: 1000, power: 0.3 }] }))).toBeCloseTo(0.3, 9);
    expect(speedBonus(loadoutWith({ boots: 2, buffs: [{ kind: 'horn', remainingMs: 1000, power: 0.3 }] }))).toBeCloseTo(0.5, 9);
    expect(speedBonus(loadoutWith({ buffs: [{ kind: 'horn', remainingMs: 1000, power: 0.4 }, { kind: 'speed', remainingMs: 1000 }] }))).toBeCloseTo(0.4, 9);
    expect(speedBonus(loadoutWith({ buffs: [{ kind: 'horn', remainingMs: 1000, power: 0.2 }, { kind: 'speed', remainingMs: 1000 }] }))).toBeCloseTo(0.4, 9);
  });
});

describe('éclair de rage et étoile', () => {
  it('rage : +50 % de TOUS les dégâts infligés, cumulable avec l\'arme', () => {
    expect(BUFF_RAGE_BONUS).toBe(0.5);
    const rage = loadoutWith({ buffs: [{ kind: 'rage', remainingMs: 1000 }] });
    expect(rageMultiplier(rage)).toBeCloseTo(1.5, 9);
    expect(rageMultiplier(createLoadout())).toBe(1);
    expect(rageMultiplier(undefined)).toBe(1);
    const david = CHARACTERS.david;
    expect(attackDamageMultiplier(david, loadoutWith({ weapon: 1, buffs: rage.buffs }))).toBeCloseTo(1.2 * 1.5, 9);
    expect(attackDamageMultiplier(david, loadoutWith({ weapon: 2 }))).toBeCloseTo(1.35, 9);
    expect(attackDamageMultiplier(david, createLoadout())).toBe(1);
  });
  it('étoile : invulnérabilité tant que le bonus dure', () => {
    expect(isStarActive(loadoutWith({ buffs: [{ kind: 'star', remainingMs: 10 }] }))).toBe(true);
    expect(isStarActive(loadoutWith({ buffs: [{ kind: 'rage', remainingMs: 10 }] }))).toBe(false);
    expect(isStarActive(createLoadout())).toBe(false);
  });
});

describe('bonus temporaires : durée, relance, expiration', () => {
  it('durées : 8 s (potion, rage), 4 s (étoile), 3 s (cor)', () => {
    expect(BUFF_DURATION_MS).toBe(8000);
    expect(BUFF_STAR_DURATION_MS).toBe(4000);
    expect(HORN_DURATION_MS).toBe(3000);
    expect(buffDurationMs('speed')).toBe(8000);
    expect(buffDurationMs('rage')).toBe(8000);
    expect(buffDurationMs('star')).toBe(4000);
  });
  it('addBuff : un nouveau bonus s\'ajoute ; le même bonus repart à la durée pleine sans se cumuler ni se raccourcir', () => {
    const l = createLoadout();
    addBuff(l, { kind: 'speed', remainingMs: 8000 });
    addBuff(l, { kind: 'rage', remainingMs: 8000 });
    expect(l.buffs.map((b) => b.kind)).toEqual(['speed', 'rage']);
    stepBuffs(l, 5000);
    expect(buffRemainingMs(l, 'speed')).toBe(3000);
    addBuff(l, { kind: 'speed', remainingMs: 8000 });
    expect(l.buffs).toHaveLength(2);
    expect(buffRemainingMs(l, 'speed')).toBe(8000);
    addBuff(l, { kind: 'speed', remainingMs: 100 }); // jamais raccourci
    expect(buffRemainingMs(l, 'speed')).toBe(8000);
  });
  it('addBuff horn : garde la plus forte puissance', () => {
    const l = createLoadout();
    addBuff(l, { kind: 'horn', remainingMs: 3000, power: 0.2 });
    addBuff(l, { kind: 'horn', remainingMs: 3000, power: 0.4 });
    addBuff(l, { kind: 'horn', remainingMs: 3000, power: 0.3 });
    expect(l.buffs).toHaveLength(1);
    expect(l.buffs[0].power).toBe(0.4);
  });
  it('stepBuffs : décompte et retire les bonus échus, ordre conservé', () => {
    const l = loadoutWith({ buffs: [{ kind: 'speed', remainingMs: 100 }, { kind: 'rage', remainingMs: 1000 }, { kind: 'star', remainingMs: 50 }] });
    stepBuffs(l, 60);
    expect(l.buffs.map((b) => b.kind)).toEqual(['speed', 'rage']);
    stepBuffs(l, 60);
    expect(l.buffs.map((b) => b.kind)).toEqual(['rage']);
    expect(hasBuff(l, 'rage')).toBe(true);
    expect(hasBuff(l, 'speed')).toBe(false);
    stepBuffs(l, 10_000);
    expect(l.buffs).toEqual([]);
  });
  it('hornBuffFor : 3 s à la puissance du cor, null sans cor', () => {
    expect(hornBuffFor({ ...createGear(), accessory: acc('warhorn', 3) })).toEqual({ kind: 'horn', remainingMs: 3000, power: 0.4 });
    expect(hornBuffFor({ ...createGear(), accessory: acc('lantern', 3) })).toBeNull();
    expect(hornBuffFor(createGear())).toBeNull();
  });
  it('perte à la chute : bonus temporaires effacés avec l\'équipement', () => {
    const l = loadoutWith({ boots: 2, accessory: acc('warhorn', 1), buffs: [{ kind: 'rage', remainingMs: 5000 }] });
    const lost = stripLoadout(l);
    expect(lost.map((i) => i.slot)).toEqual(['boots', 'accessory']);
    expect(l).toEqual(createLoadout());
  });
});

describe('normalisation d\'un loadout ancien / corrompu (accessoire, bonus, anneau)', () => {
  it('bonus : sortes connues et durées > 0 conservées (cor avec puissance), le reste ignoré', () => {
    const l = normalizeLoadout({
      accessory: { kind: 'warhorn', level: 2 },
      buffs: [
        { kind: 'speed', remainingMs: 100 },
        { kind: 'horn', remainingMs: 100, power: 0.3 },
        { kind: 'horn', remainingMs: 100 },
        { kind: 'rage', remainingMs: -1 },
        { kind: 'nope', remainingMs: 100 },
        null,
        'x',
      ],
    });
    expect(l.accessory).toEqual({ kind: 'warhorn', level: 2 });
    expect(l.buffs).toEqual([{ kind: 'speed', remainingMs: 100 }, { kind: 'horn', remainingMs: 100, power: 0.3 }]);
  });
  it('ringKills : conservé seulement avec l\'anneau, ramené sous 3', () => {
    expect(normalizeLoadout({ accessory: { kind: 'vampire', level: 3 }, ringKills: 2 }).ringKills).toBe(2);
    expect(normalizeLoadout({ accessory: { kind: 'vampire', level: 3 }, ringKills: 7 }).ringKills).toBe(1);
    expect(normalizeLoadout({ accessory: { kind: 'magnet', level: 3 }, ringKills: 2 }).ringKills).toBeUndefined();
    expect(normalizeLoadout({ ringKills: 2 }).ringKills).toBeUndefined();
    expect(normalizeLoadout({ accessory: { kind: 'vampire', level: 3 }, ringKills: 'x' }).ringKills).toBeUndefined();
  });
});

describe('échange manuel : swapCandidate', () => {
  const drop = (id: number, kind: AccessoryKind, level: GearLevel, x: number, y: number, over: Partial<GearDropState> = {}): GearDropState => ({
    id,
    item: { slot: 'accessory', level, accessory: kind },
    pos: { x, y },
    ttlMs: 10_000,
    lockedFor: null,
    lockMode: 'life',
    ...over,
  });
  const me = (accessory: PlayerGear['accessory'], x = 100, y = 100, status: 'alive' | 'down' = 'alive'): Pick<import('./types').PlayerState, 'id' | 'pos' | 'status' | 'loadout'> => ({
    id: 0 as PlayerId,
    pos: { x, y },
    status,
    loadout: loadoutWith({ accessory }),
  });

  it('un accessoire d\'une AUTRE sorte, à portée, est échangeable', () => {
    expect(swapCandidate([drop(1, 'magnet', 1, 104, 100)], me(acc('lantern', 2)))?.id).toBe(1);
  });
  it('même sorte (supérieure, égale, inférieure) ou emplacement vide : pas d\'échange (amélioration / ignoré / auto)', () => {
    for (const lv of [1, 2, 3] as const) expect(swapCandidate([drop(1, 'lantern', lv, 100, 100)], me(acc('lantern', 2)))).toBeNull();
    expect(swapCandidate([drop(1, 'lantern', 1, 100, 100)], me(null))).toBeNull();
  });
  it('hors de portée, verrouillé pour ce joueur, périmé, à terre, objet simple : aucun candidat', () => {
    const far = drop(1, 'magnet', 1, 100 + GEAR_PICKUP_RADIUS + 1, 100);
    expect(swapCandidate([far], me(acc('lantern', 1)))).toBeNull();
    expect(swapCandidate([drop(2, 'magnet', 1, 100, 100, { lockedFor: 0 })], me(acc('lantern', 1)))).toBeNull();
    expect(swapCandidate([drop(3, 'magnet', 1, 100, 100, { ttlMs: 0 })], me(acc('lantern', 1)))).toBeNull();
    expect(swapCandidate([drop(4, 'magnet', 1, 100, 100)], me(acc('lantern', 1), 100, 100, 'down'))).toBeNull();
    const boots: GearDropState = { id: 5, item: { slot: 'boots', level: 3 }, pos: { x: 100, y: 100 }, ttlMs: 10_000, lockedFor: null, lockMode: 'life' };
    expect(swapCandidate([boots], me(acc('lantern', 1)))).toBeNull();
  });
  it('verrouillé pour un autre joueur : candidat pour moi ; le plus proche l\'emporte ; l\'anneau est échangeable', () => {
    const a = drop(1, 'magnet', 1, 104, 100, { lockedFor: 1 as PlayerId });
    const b = drop(2, 'warhorn', 1, 108, 100);
    const c = drop(3, 'vampire', 3, 103, 100);
    expect(swapCandidate([a, b], me(acc('lantern', 1)))?.id).toBe(1);
    expect(swapCandidate([b, c], me(acc('lantern', 1)))?.id).toBe(3);
  });
});

describe('aimant : magnetStep', () => {
  it('avance de MAGNET_PULL_SPEED px/s vers la cible, sans la dépasser', () => {
    const p = magnetStep({ x: 0, y: 0 }, { x: 500, y: 0 }, 1000);
    expect(p.x).toBeCloseTo(MAGNET_PULL_SPEED, 9);
    expect(p.y).toBe(0);
    const d = magnetStep({ x: 0, y: 0 }, { x: 30, y: 40 }, 100);
    expect(Math.hypot(d.x, d.y)).toBeCloseTo((MAGNET_PULL_SPEED * 100) / 1000, 9);
    expect(d.x / d.y).toBeCloseTo(0.75, 9);
    expect(magnetStep({ x: 0, y: 0 }, { x: 3, y: 4 }, 1000)).toEqual({ x: 3, y: 4 });
    expect(magnetStep({ x: 5, y: 5 }, { x: 5, y: 5 }, 16)).toEqual({ x: 5, y: 5 });
  });
});

describe('tirage de la sorte d\'accessoire', () => {
  it('l\'anneau du vampire est RARE (~7 % des accessoires) et TOUJOURS de niveau III ; les autres sorties à égalité', () => {
    expect(ACCESSORY_KIND_WEIGHTS.vampire).toBeLessThan(ACCESSORY_KIND_WEIGHTS.lantern / 3);
    const r = rngOf(21);
    // 2 joueurs : le cor de guerre (utile aux seuls alliés) est tiré ; en solo il est retiré (test suivant)
    const players = [{ id: 0 as PlayerId, status: 'alive' as const, loadout: createLoadout() }, { id: 1 as PlayerId, status: 'alive' as const, loadout: createLoadout() }];
    const counts: Record<string, number> = { lantern: 0, magnet: 0, warhorn: 0, vampire: 0 };
    let n = 0;
    for (let i = 0; i < 60_000; i++) {
      const it = pickGearItem(r, players, 2);
      if (!it || it.slot !== 'accessory') continue;
      n++;
      counts[it.accessory as string]++;
      if (it.accessory === 'vampire') expect(it.level).toBe(3);
      else expect([1, 2, 3]).toContain(it.level);
    }
    expect(n).toBeGreaterThan(4000);
    expect(counts.vampire / n).toBeGreaterThan(0.05);
    expect(counts.vampire / n).toBeLessThan(0.09);
    for (const k of ['lantern', 'magnet', 'warhorn']) {
      expect(counts[k] / n).toBeGreaterThan(0.27);
      expect(counts[k] / n).toBeLessThan(0.35);
    }
  });
  it('SOLO : le cor de guerre (sans effet sans allié) est retiré du tirage, son poids est redistribué (comme la magie) ; avec 2 joueurs il est tiré', () => {
    expect(accessoryKindWeights(1)).toEqual([31, 31, 0, 7]);
    expect(accessoryKindWeights(2)).toEqual([31, 31, 31, 7]);
    const r = rngOf(33);
    const solo = [{ id: 0 as PlayerId, status: 'alive' as const, loadout: createLoadout() }];
    const counts: Record<string, number> = { lantern: 0, magnet: 0, warhorn: 0, vampire: 0 };
    let n = 0;
    for (let i = 0; i < 60_000; i++) {
      const it = pickGearItem(r, solo, 1);
      if (!it || it.slot !== 'accessory') continue;
      n++;
      counts[it.accessory as string]++;
    }
    expect(n).toBeGreaterThan(3000);
    expect(counts.warhorn).toBe(0);
    expect(counts.vampire / n).toBeGreaterThan(0.07);
    expect(counts.vampire / n).toBeLessThan(0.13);
    expect(counts.lantern / n).toBeGreaterThan(0.4);
    expect(counts.magnet / n).toBeGreaterThan(0.4);
  });
  it('l\'accessoire pèse 12 sur ~100 de poids total (~10-12 % des objets, davantage chez un joueur sans accessoire)', () => {
    const r = rngOf(5);
    const players = [{ id: 0 as PlayerId, status: 'alive' as const, loadout: createLoadout() }, { id: 1 as PlayerId, status: 'alive' as const, loadout: createLoadout() }];
    let acc12 = 0;
    const N = 30_000;
    for (let i = 0; i < N; i++) if (pickGearItem(r, players, 2)?.slot === 'accessory') acc12++;
    expect(acc12 / N).toBeGreaterThan(0.1);
    expect(acc12 / N).toBeLessThan(0.2);
  });
});

describe('bonus temporaires : budget et tirage', () => {
  it('budget : floor(0,3 n) + 1 avec la probabilité du reste ; espérance exacte 0,3 par héros', () => {
    expect(BUFF_BUDGET_PER_PLAYER).toBe(0.3);
    for (const n of [1, 2, 3, 4]) {
      const r = rngOf(100 + n);
      const N = 40_000;
      let total = 0;
      let min = Infinity;
      let max = 0;
      for (let i = 0; i < N; i++) {
        const b = rollBuffBudget(n, r);
        total += b;
        min = Math.min(min, b);
        max = Math.max(max, b);
      }
      expect(total / N, `n=${n}`).toBeGreaterThan(0.3 * n - 0.02);
      expect(total / N, `n=${n}`).toBeLessThan(0.3 * n + 0.02);
      expect(min).toBeGreaterThanOrEqual(Math.floor(0.3 * n));
      expect(max).toBeLessThanOrEqual(Math.ceil(0.3 * n));
    }
  });
  it('budget : aucun tirage quand le reste est nul (flux préservé)', () => {
    let calls = 0;
    const counter = (): number => {
      calls++;
      return 0.99;
    };
    expect(rollBuffBudget(0, counter)).toBe(0);
    expect(calls).toBe(0);
    expect(rollBuffBudget(10, counter)).toBe(3); // 0,3 x 10 = 3 pile
    expect(calls).toBe(0);
    expect(rollBuffBudget(1, counter)).toBe(0); // 0,3 : un tirage, 0,99 >= 0,3
    expect(calls).toBe(1);
  });
  it('sorte : speed 40 / rage 40 / star 20 (l\'étoile est la plus rare)', () => {
    expect(BUFF_KIND_WEIGHTS).toEqual({ speed: 40, rage: 40, star: 20 });
    const r = rngOf(7);
    const c = { speed: 0, rage: 0, star: 0 };
    const N = 30_000;
    for (let i = 0; i < N; i++) c[pickBuffKind(r)]++;
    expect(c.speed / N).toBeGreaterThan(0.38);
    expect(c.speed / N).toBeLessThan(0.42);
    expect(c.star / N).toBeGreaterThan(0.18);
    expect(c.star / N).toBeLessThan(0.22);
  });

  const base = (kind: EnemyKind, over: Partial<BuffRollInput> = {}): BuffRollInput => ({
    kind,
    summoned: false,
    hasDrop: false,
    otherDropChance: 0,
    budget: 1,
    weightLeft: 1,
    random: () => 0,
    ...over,
  });
  it('dernier ennemi du budget : bonus certain ; ennemi invoqué, demi-boss, boss final, cœur / objet déjà laissé, budget épuisé : jamais', () => {
    expect(rollBuffDrop(base('skeleton'))).not.toBeNull();
    expect(rollBuffDrop(base('skeleton', { summoned: true }))).toBeNull();
    expect(rollBuffDrop(base('warden'))).toBeNull();
    expect(rollBuffDrop(base('morvane'))).toBeNull();
    expect(rollBuffDrop(base('skeleton', { hasDrop: true }))).toBeNull();
    expect(rollBuffDrop(base('skeleton', { budget: 0 }))).toBeNull();
  });
  it('un seul tirage de décision quand l\'ennemi ne peut rien laisser (flux préservé)', () => {
    let calls = 0;
    const counter = (): number => {
      calls++;
      return 0;
    };
    rollBuffDrop(base('skeleton', { summoned: true, random: counter }));
    rollBuffDrop(base('warden', { random: counter }));
    rollBuffDrop(base('skeleton', { hasDrop: true, random: counter }));
    rollBuffDrop(base('skeleton', { budget: 0, random: counter }));
    expect(calls).toBe(0);
  });
  it('probabilité = budget x poids / poids restants, compensée par l\'exclusion (fréquence mesurée)', () => {
    const r = rngOf(9);
    let hit = 0;
    const N = 40_000;
    for (let i = 0; i < N; i++) if (rollBuffDrop(base('skeleton', { budget: 1, weightLeft: 4, otherDropChance: 0.5, random: r }))) hit++;
    // base = 1 x 1/4 = 0,25 ; compensation 1 / (1 - 0,5) = x2 -> 0,5
    expect(hit / N).toBeGreaterThan(0.48);
    expect(hit / N).toBeLessThan(0.52);
  });
});
