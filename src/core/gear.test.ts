/**
 * Équipement — logique PURE (`gear.ts`) : valeurs par défaut et normalisation, règles de ramassage (strictement meilleur, accessoire), perte,
 * bonus et PLAFONDS, arme (épée / hache / arc), tirage (budget par salle sur grand échantillon, pondérations, niveaux, magie exclue en solo,
 * invoqués / boss finaux sans objet, demi-boss >= II), vieillissement et éparpillement, constantes d'équilibrage.
 */
import { describe, expect, it } from 'vitest';
import {
  GEAR_BONUS,
  GEAR_BOW_MELEE_DAMAGE_MULT,
  GEAR_BOW_RANGED_BONUS,
  GEAR_BOW_RANGE_PX,
  GEAR_CAPS,
  GEAR_ENEMY_WEIGHTS,
  GEAR_LEVEL_WEIGHTS,
  GEAR_SLOT_WEIGHTS,
  GEAR_TTL_MS,
  damageToPlayer,
  playerBaseDamage,
} from './balance';
import { CHARACTERS } from './characters';
import {
  ACCESSORY_KINDS,
  BASIC_GEAR_SLOTS,
  GEAR_SLOTS,
  ageGearDrops,
  attackDamageMultiplier,
  cloneGear,
  createGear,
  createLoadout,
  damageReduction,
  effectiveAttack,
  effectiveSpecialCooldownMs,
  enemyGearWeight,
  equipItem,
  equippedCount,
  equippedItems,
  gearDropChance,
  isGearEmpty,
  itemOfSlot,
  leastEquippedAlive,
  normalizeGear,
  normalizeLoadout,
  pickGearItem,
  pickGearLevel,
  pickWeighted,
  pickupDecision,
  reviveTimeReduction,
  rollGearDrop,
  sameGear,
  sameItem,
  scatterPoints,
  slotWeights,
  specialCooldownReduction,
  speedBonus,
  stripLoadout,
  weaponMode,
  type GearRollInput,
} from './gear';
import { nextRandom, seedToState, type RngHolder } from './rng';
import type { EnemyKind, GearItem, PlayerGear, PlayerId, PlayerLoadout } from './types';

/** PRNG de test (le vrai : mulberry32 sérialisable). */
function rngOf(seed: number): () => number {
  const h: RngHolder = { rngState: seedToState(seed) };
  return () => nextRandom(h);
}

type Pl = { id: PlayerId; status: 'alive' | 'down'; loadout: PlayerLoadout };
function pl(id: number, over: Partial<PlayerGear> = {}, status: 'alive' | 'down' = 'alive'): Pl {
  return { id: id as PlayerId, status, loadout: { ...createLoadout(), ...over } };
}

describe('valeurs par défaut et normalisation', () => {
  it('équipement vide par défaut : 5 niveaux à 0, aucun accessoire, aucun buff', () => {
    const l = createLoadout();
    expect(l).toEqual({ boots: 0, protection: 0, artifact: 0, magic: 0, weapon: 0, accessory: null, buffs: [] });
    expect(isGearEmpty(l)).toBe(true);
    expect(equippedCount(l)).toBe(0);
    expect(GEAR_SLOTS).toEqual(['boots', 'protection', 'artifact', 'magic', 'weapon', 'accessory']);
  });
  it('normalizeGear : niveaux invalides -> 0, accessoire invalide ou anneau hors niveau III -> aucun ; donnée absente -> vide', () => {
    expect(normalizeGear(undefined)).toEqual(createGear());
    expect(normalizeGear({ boots: 2, protection: 9, artifact: -1, magic: 1.5, weapon: 'x', accessory: { kind: 'magnet', level: 2 } })).toEqual({
      boots: 2,
      protection: 0,
      artifact: 0,
      magic: 0,
      weapon: 0,
      accessory: { kind: 'magnet', level: 2 },
    });
    expect(normalizeGear({ accessory: { kind: 'vampire', level: 2 } }).accessory).toBeNull();
    expect(normalizeGear({ accessory: { kind: 'vampire', level: 3 } }).accessory).toEqual({ kind: 'vampire', level: 3 });
    expect(normalizeGear({ accessory: { kind: 'nope', level: 1 } }).accessory).toBeNull();
  });
  it('normalizeLoadout : conserve les buffs valides seulement', () => {
    const l = normalizeLoadout({ boots: 1, buffs: [{ kind: 'speed', remainingMs: 500 }, { kind: 'bad', remainingMs: 5 }, { kind: 'rage', remainingMs: -1 }, null] });
    expect(l.buffs).toEqual([{ kind: 'speed', remainingMs: 500 }]);
    expect(l.boots).toBe(1);
  });
  it('cloneGear / sameGear / sameItem', () => {
    const g: PlayerGear = { ...createGear(), boots: 2, accessory: { kind: 'lantern', level: 1 } };
    const c = cloneGear(g);
    expect(sameGear(g, c)).toBe(true);
    c.accessory!.level = 2;
    expect(sameGear(g, c)).toBe(false);
    expect(g.accessory!.level).toBe(1);
    expect(sameItem({ slot: 'boots', level: 1 }, { slot: 'boots', level: 1 })).toBe(true);
    expect(sameItem({ slot: 'boots', level: 1 }, { slot: 'boots', level: 2 })).toBe(false);
  });
});

describe('règles de ramassage', () => {
  it('emplacement simple : STRICTEMENT meilleur seulement (niveau supérieur) ; égal ou inférieur reste au sol', () => {
    const g: PlayerGear = { ...createGear(), boots: 2 };
    expect(pickupDecision(g, { slot: 'boots', level: 3 })).toBe('equip');
    expect(pickupDecision(g, { slot: 'boots', level: 2 })).toBe('ignore');
    expect(pickupDecision(g, { slot: 'boots', level: 1 })).toBe('ignore');
    expect(pickupDecision(g, { slot: 'weapon', level: 1 })).toBe('equip'); // emplacement vide
  });
  it('accessoire : vide -> équipe ; même sorte plus haut -> amélioration ; même sorte égal/inférieur -> ignoré ; sorte différente -> échange manuel', () => {
    const empty = createGear();
    expect(pickupDecision(empty, { slot: 'accessory', level: 1, accessory: 'magnet' })).toBe('equip');
    const g: PlayerGear = { ...createGear(), accessory: { kind: 'magnet', level: 2 } };
    expect(pickupDecision(g, { slot: 'accessory', level: 3, accessory: 'magnet' })).toBe('upgrade');
    expect(pickupDecision(g, { slot: 'accessory', level: 2, accessory: 'magnet' })).toBe('ignore');
    expect(pickupDecision(g, { slot: 'accessory', level: 1, accessory: 'magnet' })).toBe('ignore');
    expect(pickupDecision(g, { slot: 'accessory', level: 3, accessory: 'warhorn' })).toBe('swap');
    expect(pickupDecision(g, { slot: 'accessory', level: 1, accessory: 'lantern' })).toBe('swap');
  });
  it('accessoire invalide (sans sorte, anneau du vampire hors niveau III) : ignoré', () => {
    expect(pickupDecision(createGear(), { slot: 'accessory', level: 1 })).toBe('ignore');
    expect(pickupDecision(createGear(), { slot: 'accessory', level: 2, accessory: 'vampire' })).toBe('ignore');
    expect(pickupDecision(createGear(), { slot: 'accessory', level: 3, accessory: 'vampire' })).toBe('equip');
  });
  it('equipItem remplace et retourne l\'ancien objet (null si vide) ; itemOfSlot / equippedItems', () => {
    const g = createGear();
    expect(equipItem(g, { slot: 'protection', level: 1 })).toBeNull();
    expect(equipItem(g, { slot: 'protection', level: 3 })).toEqual({ slot: 'protection', level: 1 });
    expect(g.protection).toBe(3);
    equipItem(g, { slot: 'accessory', level: 2, accessory: 'lantern' });
    expect(itemOfSlot(g, 'accessory')).toEqual({ slot: 'accessory', level: 2, accessory: 'lantern' });
    expect(equippedItems(g).map((i) => i.slot)).toEqual(['protection', 'accessory']);
  });
  it('stripLoadout : retire les 6 emplacements ET les buffs, retourne les objets perdus dans l\'ordre', () => {
    const l = createLoadout();
    l.boots = 3;
    l.weapon = 2;
    l.accessory = { kind: 'warhorn', level: 1 };
    l.buffs = [{ kind: 'star', remainingMs: 1000 }];
    const lost = stripLoadout(l);
    expect(lost).toEqual([{ slot: 'boots', level: 3 }, { slot: 'weapon', level: 2 }, { slot: 'accessory', level: 1, accessory: 'warhorn' }]);
    expect(l).toEqual(createLoadout());
    expect(stripLoadout(l)).toEqual([]);
  });
});

describe('bonus et plafonds [B18] [B19]', () => {
  it('bottes +10 / +20 / +30 % ; protection -10 / -20 / -30 % ; artefact -15 / -25 / -35 % ; magie -20 / -35 / -50 %', () => {
    const at = (slot: 'boots' | 'protection' | 'artifact' | 'magic', lv: number): PlayerGear => ({ ...createGear(), [slot]: lv });
    expect([1, 2, 3].map((l) => speedBonus(at('boots', l)))).toEqual([0.1, 0.2, 0.3]);
    expect([1, 2, 3].map((l) => damageReduction(at('protection', l)))).toEqual([0.1, 0.2, 0.3]);
    expect([1, 2, 3].map((l) => specialCooldownReduction(at('artifact', l)))).toEqual([0.15, 0.25, 0.35]);
    expect([1, 2, 3].map((l) => reviveTimeReduction(at('magic', l)))).toEqual([0.2, 0.35, 0.5]);
  });
  it('sans équipement (ou loadout absent) : aucun bonus', () => {
    for (const l of [createGear(), undefined]) {
      expect(speedBonus(l)).toBe(0);
      expect(damageReduction(l)).toBe(0);
      expect(specialCooldownReduction(l)).toBe(0);
      expect(reviveTimeReduction(l)).toBe(0);
    }
  });
  it('les bonus du tableau ne dépassent jamais les plafonds ; les plafonds valent ceux de la décision (30 / 30 / 35 / 50 %)', () => {
    expect(GEAR_CAPS).toEqual({ speed: 0.3, protection: 0.3, special: 0.35, revive: 0.5 });
    for (const v of GEAR_BONUS.boots) expect(v).toBeLessThanOrEqual(GEAR_CAPS.speed);
    for (const v of GEAR_BONUS.protection) expect(v).toBeLessThanOrEqual(GEAR_CAPS.protection);
    for (const v of GEAR_BONUS.artifact) expect(v).toBeLessThanOrEqual(GEAR_CAPS.special);
    for (const v of GEAR_BONUS.magic) expect(v).toBeLessThanOrEqual(GEAR_CAPS.revive);
  });
  it('plafond : un niveau hors table n\'élargit jamais le bonus', () => {
    expect(speedBonus({ ...createGear(), boots: 9 })).toBe(0);
    expect(damageToPlayer(100, { resistance: 0 }, 2, 5)).toBe(damageToPlayer(100, { resistance: 0 }, 2, GEAR_CAPS.protection));
    expect(damageToPlayer(100, { resistance: 0 }, 2, -1)).toBe(100);
  });
  it('dégâts reçus : la protection s\'applique APRÈS la difficulté et la résistance (arrondi final)', () => {
    const david = CHARACTERS.david; // résistance 9 -> -18 %
    const base = damageToPlayer(10, david, 3);
    expect(base).toBe(Math.round(10 * 1.5 * (1 - 0.18)));
    expect(damageToPlayer(10, david, 3, 0.3)).toBe(Math.round(10 * 1.5 * 0.82 * 0.7));
  });
  it('recharge du spécial effective', () => {
    expect(effectiveSpecialCooldownMs(14000, undefined)).toBe(14000);
    expect(effectiveSpecialCooldownMs(14000, { ...createGear(), artifact: 3 })).toBe(Math.round(14000 * 0.65));
  });
});

describe('arme : épée, hache, arc', () => {
  const david = CHARACTERS.david; // mêlée
  const aelith = CHARACTERS.aelith; // tire déjà
  const valentine = CHARACTERS.valentine; // tir de soin
  const w = (lv: number): PlayerGear => ({ ...createGear(), weapon: lv });
  it('mode d\'arme selon le niveau', () => {
    expect([weaponMode(undefined), weaponMode(w(0)), weaponMode(w(1)), weaponMode(w(2)), weaponMode(w(3))]).toEqual(['none', 'none', 'sword', 'axe', 'bow']);
  });
  it('épée : +20 % de dégâts, cadence inchangée', () => {
    expect(attackDamageMultiplier(david, w(1))).toBeCloseTo(1.2);
    expect(effectiveAttack(david, w(1))).toBe(david.attack);
  });
  it('hache : +35 % de dégâts, attaque 20 % plus lente (délai x1,2)', () => {
    expect(attackDamageMultiplier(david, w(2))).toBeCloseTo(1.35);
    expect(effectiveAttack(david, w(2)).cooldownMs).toBeCloseTo(david.attack.cooldownMs * 1.2);
    expect(effectiveAttack(david, w(2)).kind).toBe('melee');
  });
  it('arc : un héros au corps à corps TIRE (flèche, ~190 px de portée, 70 % de ses dégâts), même cadence', () => {
    const a = effectiveAttack(david, w(3));
    expect(a.kind).toBe('ranged');
    expect(a.cooldownMs).toBe(david.attack.cooldownMs);
    expect(a.range).toBe(GEAR_BOW_RANGE_PX);
    expect(a.projectile?.kind).toBe('arrow');
    expect((a.projectile!.speed * a.projectile!.lifeMs) / 1000).toBeCloseTo(GEAR_BOW_RANGE_PX);
    expect(attackDamageMultiplier(david, w(3))).toBe(GEAR_BOW_MELEE_DAMAGE_MULT);
    expect(GEAR_BOW_MELEE_DAMAGE_MULT).toBe(0.7);
  });
  it('arc : un héros qui tire déjà garde son tir et gagne +15 % de dégâts (Valentine : projectile de soin conservé)', () => {
    expect(effectiveAttack(aelith, w(3))).toBe(aelith.attack);
    expect(attackDamageMultiplier(aelith, w(3))).toBeCloseTo(1 + GEAR_BOW_RANGED_BONUS);
    expect(effectiveAttack(valentine, w(3)).projectile?.kind).toBe('heal');
    expect(attackDamageMultiplier(valentine, w(3))).toBeCloseTo(1.15);
  });
  it('sans arme : aucune modification (même objet, multiplicateur 1)', () => {
    expect(effectiveAttack(david, undefined)).toBe(david.attack);
    expect(attackDamageMultiplier(david, createGear())).toBe(1);
    expect(playerBaseDamage(david) * attackDamageMultiplier(david, w(1))).toBeCloseTo(playerBaseDamage(david) * 1.2);
  });
});

describe('poids des ennemis et des emplacements', () => {
  it('ennemi : costaud x4, standard x1, faible x0,5 ; demi-boss et boss final : 0 (règles propres)', () => {
    expect(GEAR_ENEMY_WEIGHTS).toEqual({ weak: 0.5, standard: 1, tough: 4 });
    expect(enemyGearWeight('slime')).toBe(0.5);
    expect(enemyGearWeight('skeleton')).toBe(1);
    expect(enemyGearWeight('knight')).toBe(4);
    expect(enemyGearWeight('warden')).toBe(0);
    expect(enemyGearWeight('morvane')).toBe(0);
  });
  it('emplacements : poids de départ bottes 18, protection 22, arme 18, artefact 18, magie 12, accessoire 12', () => {
    expect(GEAR_SLOT_WEIGHTS).toEqual({ boots: 18, protection: 22, weapon: 18, artifact: 18, magic: 12, accessory: 12 });
  });
  it('magie RETIRÉE en solo (poids 0), présente à plusieurs', () => {
    const solo = slotWeights([pl(0)], 1);
    expect(solo.magic).toBe(0);
    const duo = slotWeights([pl(0), pl(1)], 2);
    expect(duo.magic).toBeGreaterThan(0);
  });
  it('un emplacement VIDE chez le joueur vivant le moins équipé pèse x2', () => {
    const a = pl(0, { boots: 1, protection: 1, artifact: 1, magic: 1 }); // 4 emplacements
    const b = pl(1, { boots: 2 }); // 1 emplacement : le moins équipé
    const w = slotWeights([a, b], 2);
    expect(w.boots).toBe(18); // déjà garni chez le moins équipé
    expect(w.protection).toBe(22 * 2);
    expect(w.weapon).toBe(18 * 2);
    expect(w.accessory).toBe(12 * 2); // vide chez le moins équipé : x2
    expect(leastEquippedAlive([a, b])?.id).toBe(1);
    // un joueur à terre ne compte pas
    expect(leastEquippedAlive([a, pl(1, {}, 'down')])?.id).toBe(0);
    expect(leastEquippedAlive([pl(0, {}, 'down')])).toBeNull();
  });
  it('pickWeighted : proportionnel, un seul tirage, -1 si les poids sont nuls', () => {
    expect(pickWeighted([0, 0], () => 0.5)).toBe(-1);
    expect(pickWeighted([1, 3], () => 0.1)).toBe(0);
    expect(pickWeighted([1, 3], () => 0.3)).toBe(1);
    const r = rngOf(5);
    const counts = [0, 0, 0];
    for (let i = 0; i < 30000; i++) counts[pickWeighted([1, 2, 7], r)]++;
    expect(counts[2] / 30000).toBeGreaterThan(0.67);
    expect(counts[2] / 30000).toBeLessThan(0.73);
    expect(counts[0] / 30000).toBeGreaterThan(0.08);
  });
});

describe('niveaux tirés [B22]', () => {
  it('poids I 75 / II 22 / III 3 : fréquences sur grand échantillon', () => {
    expect(GEAR_LEVEL_WEIGHTS).toEqual([75, 22, 3]);
    const r = rngOf(11);
    const c = [0, 0, 0, 0];
    const N = 60000;
    for (let i = 0; i < N; i++) c[pickGearLevel(r)]++;
    expect(c[1] / N).toBeGreaterThan(0.73);
    expect(c[1] / N).toBeLessThan(0.77);
    expect(c[2] / N).toBeGreaterThan(0.2);
    expect(c[2] / N).toBeLessThan(0.24);
    expect(c[3] / N).toBeGreaterThan(0.02);
    expect(c[3] / N).toBeLessThan(0.04);
  });
  it('niveau minimal II : jamais de niveau I ; II et III dans le rapport 22 / 3', () => {
    const r = rngOf(12);
    const c = [0, 0, 0, 0];
    const N = 30000;
    for (let i = 0; i < N; i++) c[pickGearLevel(r, 2)]++;
    expect(c[1]).toBe(0);
    expect(c[3] / N).toBeGreaterThan(0.09);
    expect(c[3] / N).toBeLessThan(0.15);
  });
  it('un objet tiré a toujours un emplacement valide et un niveau 1..3 ; l\'accessoire a toujours une sorte (anneau : niveau III)', () => {
    const r = rngOf(3);
    for (let i = 0; i < 2000; i++) {
      const it = pickGearItem(r, [pl(0), pl(1)], 2)!;
      expect(GEAR_SLOTS).toContain(it.slot);
      expect([1, 2, 3]).toContain(it.level);
      if (it.slot === 'accessory') {
        expect(ACCESSORY_KINDS).toContain(it.accessory);
        if (it.accessory === 'vampire') expect(it.level).toBe(3);
      } else expect(it.accessory).toBeUndefined();
    }
  });
  it('en solo, la magie n\'est jamais tirée ; à deux elle l\'est', () => {
    const r = rngOf(4);
    let solo = 0;
    let duo = 0;
    for (let i = 0; i < 3000; i++) {
      if (pickGearItem(r, [pl(0)], 1)!.slot === 'magic') solo++;
      if (pickGearItem(r, [pl(0), pl(1)], 2)!.slot === 'magic') duo++;
    }
    expect(solo).toBe(0);
    expect(duo).toBeGreaterThan(200);
  });
  it('les emplacements vides du joueur le moins équipé sont tirés plus souvent (x2)', () => {
    const r = rngOf(8);
    const needy = pl(0, { boots: 1, protection: 1, artifact: 1, magic: 1 }); // seule l'arme est vide
    const other = pl(1, { boots: 1, protection: 1, artifact: 1, magic: 1, weapon: 1 });
    // le moins équipé est `needy` (4 emplacements contre 5) : l'arme pèse x2
    let weapon = 0;
    const N = 20000;
    for (let i = 0; i < N; i++) if (pickGearItem(r, [needy, other], 2)!.slot === 'weapon') weapon++;
    // l'arme ET l'accessoire sont vides chez le moins équipé : somme = 18 + 22 + 18 + 12 + 36 + 24 = 130
    expect(weapon / N).toBeGreaterThan(36 / 130 - 0.02);
    expect(weapon / N).toBeLessThan(36 / 130 + 0.02);
  });
});

describe('tirage d\'un ennemi mort : rollGearDrop', () => {
  const base = (kind: EnemyKind, over: Partial<GearRollInput> = {}): GearRollInput => ({
    kind,
    summoned: false,
    hasHeart: false,
    heartChance: 0,
    budget: 2,
    reservedForMiniBosses: 0,
    weightLeft: 4,
    playerCount: 2,
    players: [pl(0), pl(1)],
    random: () => 0,
    ...over,
  });
  it('invoqué et boss final : jamais d\'objet, AUCUN tirage consommé', () => {
    let calls = 0;
    const random = (): number => {
      calls++;
      return 0;
    };
    expect(rollGearDrop(base('skeleton', { summoned: true, random }))).toBeNull();
    expect(rollGearDrop(base('morvane', { random }))).toBeNull();
    expect(rollGearDrop(base('frostqueen', { random }))).toBeNull();
    expect(calls).toBe(0);
  });
  it('un ennemi qui laisse déjà un cœur ne laisse pas d\'objet (aucun tirage)', () => {
    let calls = 0;
    expect(rollGearDrop(base('skeleton', { hasHeart: true, random: () => (calls++, 0) }))).toBeNull();
    expect(calls).toBe(0);
  });
  it('budget épuisé : rien ; demi-boss à venir : un objet est réservé', () => {
    expect(rollGearDrop(base('skeleton', { budget: 0 }))).toBeNull();
    expect(rollGearDrop(base('skeleton', { budget: 1, reservedForMiniBosses: 1 }))).toBeNull();
    expect(gearDropChance({ kind: 'skeleton', budget: 2, reservedForMiniBosses: 1, weightLeft: 1, heartChance: 0 })).toBe(1);
  });
  it('demi-boss : objet de niveau >= II tant qu\'il reste du budget, même avec un cœur ; sinon rien', () => {
    const r = rngOf(21);
    for (let i = 0; i < 300; i++) {
      const it = rollGearDrop(base('warden', { hasHeart: true, budget: 1, random: r }));
      expect(it).not.toBeNull();
      expect(it!.level).toBeGreaterThanOrEqual(2);
    }
    expect(rollGearDrop(base('pyromancer', { budget: 0 }))).toBeNull();
  });
  it('probabilité : budget x poids / poids restants, compensée par la probabilité de cœur, bornée à 1', () => {
    const c = (kind: EnemyKind, over = {}): number => gearDropChance({ kind, budget: 1, reservedForMiniBosses: 0, weightLeft: 10, heartChance: 0, ...over });
    expect(c('knight')).toBeCloseTo(0.4);
    expect(c('skeleton')).toBeCloseTo(0.1);
    expect(c('slime')).toBeCloseTo(0.05);
    expect(c('knight') / c('slime')).toBeCloseTo(8);
    expect(c('skeleton', { heartChance: 0.2 })).toBeCloseTo(0.1 / 0.8);
    expect(c('knight', { weightLeft: 4 })).toBe(1); // dernier ennemi : le budget restant lui revient
    expect(c('knight', { budget: 3 })).toBe(1);
  });
  /** Une salle simulée : chaque mort tire un cœur (probabilité h par palier) PUIS l'équipement ; retourne le nombre d'objets tirés. */
  function simulateRoom(r: () => number, kinds: EnemyKind[], n: number, withHearts: boolean): { items: number; levels: number[] } {
    let budget = n;
    const alive = kinds.slice();
    const levels: number[] = [];
    const heartP: Record<string, number> = { slime: 0.15, bat: 0.15, wisp: 0.15, skeleton: 0.24, archer: 0.24, spider: 0.24, knight: 0.6 };
    const players = Array.from({ length: n }, (_, i) => pl(i));
    // ordre de mort aléatoire (mélange de Fisher-Yates)
    for (let i = alive.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [alive[i], alive[j]] = [alive[j], alive[i]];
    }
    let items = 0;
    while (alive.length > 0) {
      const kind = alive.shift() as EnemyKind;
      const h = withHearts ? heartP[kind] ?? 0 : 0;
      const hasHeart = r() < h;
      const weightLeft = enemyGearWeight(kind) + alive.reduce((s, k) => s + enemyGearWeight(k), 0);
      const it = rollGearDrop({ kind, summoned: false, hasHeart, heartChance: h, budget, reservedForMiniBosses: 0, weightLeft, playerCount: n, players, random: r });
      if (it) {
        items++;
        budget--;
        levels.push(it.level);
      }
    }
    return { items, levels };
  }
  it('BUDGET : en moyenne ~ n objets par salle de combat (n joueurs), jamais plus de n, sur grand échantillon', () => {
    const r = rngOf(2024);
    const kinds: EnemyKind[] = ['slime', 'slime', 'bat', 'skeleton', 'skeleton', 'archer', 'spider', 'knight'];
    for (const n of [1, 2, 3, 4]) {
      let total = 0;
      const ROOMS = 4000;
      let max = 0;
      for (let i = 0; i < ROOMS; i++) {
        const { items } = simulateRoom(r, kinds, n, true);
        total += items;
        max = Math.max(max, items);
      }
      const mean = total / ROOMS;
      expect(max, `n=${n}`).toBeLessThanOrEqual(n);
      expect(mean, `n=${n}`).toBeGreaterThan(n * 0.8);
      expect(mean, `n=${n}`).toBeLessThanOrEqual(n);
    }
  });
  it('BUDGET sans cœurs : jamais plus de n objets, au moins 1 (le dernier ennemi reçoit tout le budget restant, mais un seul objet par ennemi)', () => {
    const r = rngOf(7);
    let total = 0;
    for (let i = 0; i < 2000; i++) {
      const { items } = simulateRoom(r, ['slime', 'skeleton', 'skeleton', 'knight', 'bat'], 2, false);
      expect(items).toBeGreaterThanOrEqual(1);
      expect(items).toBeLessThanOrEqual(2);
      total += items;
    }
    expect(total / 2000).toBeGreaterThan(1.7);
  });
  it('POIDS : le costaud porte l\'objet bien plus souvent que le faible (x8 à poids restants égaux)', () => {
    const r = rngOf(99);
    let knight = 0;
    let slime = 0;
    const N = 20000;
    for (let i = 0; i < N; i++) {
      const common = { summoned: false, hasHeart: false, heartChance: 0, budget: 1, reservedForMiniBosses: 0, weightLeft: 20, playerCount: 2, players: [pl(0), pl(1)], random: r };
      if (rollGearDrop({ ...common, kind: 'knight' })) knight++;
      if (rollGearDrop({ ...common, kind: 'slime' })) slime++;
    }
    expect(knight / N).toBeGreaterThan(0.17);
    expect(knight / N).toBeLessThan(0.23);
    expect(slime / N).toBeGreaterThan(0.015);
    expect(slime / N).toBeLessThan(0.035);
  });
  it('NIVEAUX tirés dans une salle : majoritairement I, quelques II, très rarement III', () => {
    const r = rngOf(55);
    const c = [0, 0, 0, 0];
    for (let i = 0; i < 6000; i++) for (const l of simulateRoom(r, ['skeleton', 'skeleton', 'archer', 'knight'], 2, false).levels) c[l]++;
    const total = c[1] + c[2] + c[3];
    expect(c[1] / total).toBeGreaterThan(0.72);
    expect(c[3] / total).toBeLessThan(0.05);
  });
});

describe('vie au sol et éparpillement', () => {
  it('ageGearDrops : décompte, péremption à 0, ordre conservé, retourne les périmés', () => {
    const mk = (id: number, ttlMs: number): { id: number; item: GearItem; pos: { x: number; y: number }; ttlMs: number; lockedFor: null; lockMode: 'life' } => ({
      id,
      item: { slot: 'boots', level: 1 },
      pos: { x: 0, y: 0 },
      ttlMs,
      lockedFor: null,
      lockMode: 'life',
    });
    const list = [mk(1, 50), mk(2, GEAR_TTL_MS), mk(3, 16)];
    const gone = ageGearDrops(list, 16);
    expect(gone.map((d) => d.id)).toEqual([3]);
    expect(list.map((d) => d.id)).toEqual([1, 2]);
    expect(list[0].ttlMs).toBe(34);
    expect(GEAR_TTL_MS).toBe(20000);
  });
  it('scatterPoints : points régulièrement répartis à rayon constant, déterministes', () => {
    const c = { x: 100, y: 100 };
    const pts = scatterPoints(c, 4);
    expect(pts).toHaveLength(4);
    for (const p of pts) expect(Math.hypot(p.x - c.x, p.y - c.y)).toBeCloseTo(20);
    expect(pts).toEqual(scatterPoints(c, 4));
    expect(new Set(pts.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`)).size).toBe(4);
    expect(scatterPoints(c, 0)).toEqual([]);
  });
  it('sortes d\'accessoires connues', () => {
    expect(ACCESSORY_KINDS).toEqual(['lantern', 'magnet', 'warhorn', 'vampire']);
  });
});
