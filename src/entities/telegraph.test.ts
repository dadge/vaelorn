import { describe, expect, it } from 'vitest';
import { createEnemyState } from '../core/ai';
import { GOLEM_SLAM_RADIUS } from '../core/bosses';
import { telegraphShapes } from './telegraph';

function enemy(kind: Parameters<typeof createEnemyState>[0], data: Record<string, number>) {
  const e = createEnemyState(kind, { x: 0, y: 0 }, 1, 0);
  Object.assign(e.data, data);
  return e;
}

describe('telegraphShapes (constat 3)', () => {
  it('slime : cercle de hitRadius (et non une ligne de visée), même avec aimAngle = 0', () => {
    const e = enemy('slime', { aimAngle: 0, telegraphRadius: 17, telegraphDist: 0 });
    expect(telegraphShapes(e, 10, 20)).toEqual([{ kind: 'circle', x: 10, y: 20, r: 17 }]);
  });

  it('chevalier : cercle décalé de telegraphDist le long de aimAngle', () => {
    const e = enemy('knight', { aimAngle: Math.PI / 2, telegraphRadius: 19, telegraphDist: 12 });
    const [s] = telegraphShapes(e, 0, 0);
    expect(s.kind).toBe('circle');
    if (s.kind === 'circle') {
      expect(s.x).toBeCloseTo(0, 6);
      expect(s.y).toBeCloseTo(12, 6);
      expect(s.r).toBe(19);
    }
  });

  it('Golem : cercle de rayon GOLEM_SLAM_RADIUS centré sur lui', () => {
    const e = enemy('golem', { aimAngle: 1, telegraphRadius: GOLEM_SLAM_RADIUS, telegraphDist: 0 });
    expect(telegraphShapes(e, 5, 5)).toEqual([{ kind: 'circle', x: 5, y: 5, r: GOLEM_SLAM_RADIUS }]);
  });

  it('chauve-souris : couloir de la longueur du bond', () => {
    const e = enemy('bat', { aimAngle: 0, telegraphRadius: 8, telegraphLength: 59 });
    const [s] = telegraphShapes(e, 0, 0);
    expect(s).toMatchObject({ kind: 'corridor', x1: 59, y1: 0, halfWidth: 8 });
  });

  it('charge de boss : couloir, demi-largeur = rayon du corps à défaut de telegraphRadius', () => {
    const e = enemy('golem', { aimAngle: 0, telegraphLength: 140 });
    const [s] = telegraphShapes(e, 0, 0);
    expect(s).toMatchObject({ kind: 'corridor', x1: 140, halfWidth: 20 });
  });

  it('feu follet : éventail d\'ouverture telegraphSpread autour de aimAngle', () => {
    const e = enemy('wisp', { aimAngle: 1, telegraphSpread: 0.7 });
    const [s] = telegraphShapes(e, 0, 0);
    expect(s.kind).toBe('fan');
    if (s.kind === 'fan') {
      expect(s.a1 - s.a0).toBeCloseTo(0.7, 9);
      expect((s.a0 + s.a1) / 2).toBeCloseTo(1, 9);
      expect(s.r).toBeGreaterThanOrEqual(36);
    }
  });

  it('éventail de boss : rayon = telegraphLength', () => {
    const e = enemy('morvane', { aimAngle: 0, telegraphSpread: 1, telegraphLength: 130 });
    expect(telegraphShapes(e, 0, 0)[0]).toMatchObject({ kind: 'fan', r: 130 });
  });

  it('Morvane : cercle de rayon 40 centré sur elle', () => {
    const e = enemy('morvane', { telegraphRadius: 40 });
    expect(telegraphShapes(e, 0, 0)).toEqual([{ kind: 'circle', x: 0, y: 0, r: 40 }]);
  });

  it('archer sans zone : ligne de visée seulement', () => {
    const e = enemy('archer', { aimAngle: 0 });
    expect(telegraphShapes(e, 0, 0)[0]).toMatchObject({ kind: 'line', x1: 110, y1: 0 });
  });

  it('attaque de boss sans zone : anneau discret, jamais de ligne', () => {
    const e = enemy('golem', {});
    expect(telegraphShapes(e, 0, 0)[0].kind).toBe('ring');
  });

  it('valeurs non finies : ignorées (jamais NaN)', () => {
    const e = enemy('slime', { aimAngle: Number.NaN, telegraphRadius: Number.NaN, telegraphLength: Infinity, telegraphDist: Number.NaN });
    const [s] = telegraphShapes(e, 1, 1);
    expect(JSON.stringify(s)).not.toContain('null');
  });
});
