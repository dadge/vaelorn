import { describe, expect, it } from 'vitest';
import { CHARACTERS, CHARACTER_IDS, CHARACTER_LIST, getCharacter } from './characters';
import { ENEMIES, ENEMY_KINDS, getEnemyDef } from './enemies';

describe('characters', () => {
  it('8 personnages dans l\'ordre canonique', () => {
    expect(CHARACTER_LIST.map((c) => c.id)).toEqual([
      'david',
      'sandrine',
      'romain',
      'valentine',
      'aelith',
      'brokk',
      'grok',
      'mira',
    ]);
    expect(Object.keys(CHARACTERS)).toHaveLength(8);
    expect([...CHARACTER_IDS]).toEqual(CHARACTER_LIST.map((c) => c.id));
  });

  it('aucun couple (force, résistance) dupliqué', () => {
    const pairs = CHARACTER_LIST.map((c) => `${c.strength}/${c.resistance}`);
    expect(new Set(pairs).size).toBe(CHARACTER_LIST.length);
  });

  it('au moins 4 personnages de la famille (david, sandrine, romain, valentine)', () => {
    const fam = CHARACTER_LIST.filter((c) => c.family).map((c) => c.id);
    expect(fam.length).toBeGreaterThanOrEqual(4);
    expect(fam).toEqual(['david', 'sandrine', 'romain', 'valentine']);
  });

  it('stats dans [1, 10] et vitesses plausibles', () => {
    for (const c of CHARACTER_LIST) {
      expect(c.strength).toBeGreaterThanOrEqual(1);
      expect(c.strength).toBeLessThanOrEqual(10);
      expect(c.resistance).toBeGreaterThanOrEqual(1);
      expect(c.resistance).toBeLessThanOrEqual(10);
      expect(c.speed).toBeGreaterThanOrEqual(40);
      expect(c.speed).toBeLessThanOrEqual(120);
    }
  });

  it('clés i18n conformes et id cohérent avec la clé du dictionnaire', () => {
    for (const c of CHARACTER_LIST) {
      expect(CHARACTERS[c.id]).toBe(c);
      expect(c.nameKey).toBe(`character.${c.id}.name`);
      expect(c.classKey).toBe(`character.${c.id}.class`);
      expect(c.descKey).toBe(`character.${c.id}.desc`);
      expect(Number.isInteger(c.color)).toBe(true);
    }
  });

  it('toutes les attaques sont valides (ranged => projectile défini)', () => {
    for (const c of CHARACTER_LIST) {
      const a = c.attack;
      expect(a.cooldownMs).toBeGreaterThan(0);
      expect(a.animMs).toBeGreaterThan(0);
      expect(a.damageMult).toBeGreaterThan(0);
      expect(a.range).toBeGreaterThan(0);
      if (a.kind === 'ranged') {
        expect(a.projectile).toBeDefined();
        const p = a.projectile!;
        expect(p.speed).toBeGreaterThan(0);
        expect(p.lifeMs).toBeGreaterThan(0);
        expect(p.radius).toBeGreaterThan(0);
        // range ≈ speed × life
        expect(Math.abs(a.range - (p.speed * p.lifeMs) / 1000)).toBeLessThanOrEqual(10);
      } else {
        expect(a.arcDeg).toBeGreaterThan(0);
        expect(a.arcDeg).toBeLessThanOrEqual(360);
        expect(a.projectile).toBeUndefined();
      }
    }
  });

  it('intentions de design : rôles et extrêmes', () => {
    const by = (id: Parameters<typeof getCharacter>[0]) => getCharacter(id);
    expect(by('david').attack.kind).toBe('melee');
    expect(by('sandrine').attack.kind).toBe('ranged');
    expect(by('sandrine').attack.projectile?.pierce).toBe(true);
    expect(by('valentine').attack.projectile?.kind).toBe('heal');
    expect(by('aelith').attack.projectile?.kind).toBe('arrow');
    expect(by('sandrine').strength).toBe(Math.max(...CHARACTER_LIST.map((c) => c.strength)));
    expect(by('sandrine').resistance).toBeLessThanOrEqual(2);
    expect(by('brokk').resistance).toBe(Math.max(...CHARACTER_LIST.map((c) => c.resistance)));
    // Romain est le plus rapide de tous (Mira juste derrière)
    expect(by('romain').speed).toBe(Math.max(...CHARACTER_LIST.map((c) => c.speed)));
    expect(by('mira').speed).toBeGreaterThanOrEqual(95);
    expect(by('grok').attack.cooldownMs).toBeGreaterThanOrEqual(750);
    expect(by('mira').attack.cooldownMs).toBeLessThanOrEqual(260);
  });

  it('reviveTimeMult = 1 sauf Valentine (0.65)', () => {
    for (const c of CHARACTER_LIST) {
      expect(c.reviveTimeMult).toBe(c.id === 'valentine' ? 0.65 : 1);
    }
  });

  it('getCharacter lance sur id inconnu', () => {
    expect(() => getCharacter('nobody' as never)).toThrow();
  });
});

describe('enemies', () => {
  it('9 types, clés i18n et ia conformes', () => {
    expect(ENEMY_KINDS).toHaveLength(9);
    const expectedAi: Record<string, string> = {
      slime: 'wander-chase',
      bat: 'erratic-flyer',
      skeleton: 'melee',
      archer: 'ranged',
      spider: 'melee',
      wisp: 'caster',
      knight: 'melee',
      golem: 'boss-golem',
      morvane: 'boss-morvane',
    };
    for (const k of ENEMY_KINDS) {
      const e = getEnemyDef(k);
      expect(e.kind).toBe(k);
      expect(ENEMIES[k]).toBe(e);
      expect(e.nameKey).toBe(`enemy.${k}`);
      expect(e.ai).toBe(expectedAi[k]);
    }
  });

  it('PV de base demandés', () => {
    expect(ENEMIES.slime.hp).toBe(24);
    expect(ENEMIES.bat.hp).toBe(14);
    expect(ENEMIES.skeleton.hp).toBe(36);
    expect(ENEMIES.archer.hp).toBe(28);
    expect(ENEMIES.spider.hp).toBe(30);
    expect(ENEMIES.wisp.hp).toBe(24);
    expect(ENEMIES.knight.hp).toBe(90);
    expect(ENEMIES.golem.hp).toBe(700);
    expect(ENEMIES.morvane.hp).toBe(1400);
  });

  it('plages de dégâts, vitesses, rayons ; boss = isBoss', () => {
    for (const k of ENEMY_KINDS) {
      const e = ENEMIES[k];
      expect(e.damage).toBeGreaterThanOrEqual(6);
      expect(e.damage).toBeLessThanOrEqual(25);
      expect(e.speed).toBeGreaterThanOrEqual(28);
      expect(e.speed).toBeLessThanOrEqual(65);
      expect(e.attackRange).toBeGreaterThan(0);
      expect(e.attackCooldownMs).toBeGreaterThan(0);
      expect(e.aggroRadius).toBeGreaterThan(0);
      if (e.isBoss) {
        expect([18, 20]).toContain(e.radius);
      } else {
        expect(e.radius).toBeGreaterThanOrEqual(5);
        expect(e.radius).toBeLessThanOrEqual(8);
      }
    }
    expect(ENEMIES.golem.isBoss).toBe(true);
    expect(ENEMIES.morvane.isBoss).toBe(true);
    expect(ENEMIES.knight.isBoss).toBe(false);
  });

  it('getEnemyDef lance sur type inconnu', () => {
    expect(() => getEnemyDef('dragon' as never)).toThrow();
  });
});
