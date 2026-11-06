import { describe, expect, it } from 'vitest';
import type { EnemyState, PlayerState } from '../core/types';
import { createPlayerState } from '../core/players';
import { hasFrame } from '../render/art';
import {
  COLOR_STUN,
  COLOR_WARN_RED,
  COLOR_WHITE,
  INTERP_TELEPORT_DISTANCE,
  PosInterp,
  computeEnemyVisual,
  createEnemyVisual,
  enemyStep,
  heroFrameFor,
  invulnVisible,
  slashAlpha,
  walkStep,
  WALK_FRAME_MS,
  INVULN_BLINK_MS,
  WINDUP_BLINK_MS,
  reviveFxFrame,
} from './animation';

function enemy(over: Partial<EnemyState> = {}): EnemyState {
  return {
    id: 1,
    kind: 'slime',
    pos: { x: 10, y: 10 },
    facing: 'right',
    hp: 10,
    maxHp: 10,
    mode: 'chase',
    modeTimerMs: 0,
    attackCooldownMs: 0,
    hitFlashMs: 0,
    data: {},
    phase: 0,
    targetId: -1,
    wave: 0,
    dead: false,
    ...over,
  };
}

function player(over: Partial<PlayerState> = {}): PlayerState {
  return { ...createPlayerState({ id: 0, characterId: 'david', difficulty: 2 }, { x: 40, y: 40 }), ...over };
}

describe('walkStep / enemyStep', () => {
  it('0 à l\'arrêt, alterne en marchant', () => {
    expect(walkStep(12345, false)).toBe(0);
    expect(walkStep(0, true)).toBe(0);
    expect(walkStep(WALK_FRAME_MS + 1, true)).toBe(1);
    expect(walkStep(2 * WALK_FRAME_MS + 1, true)).toBe(0);
  });
  it('les ennemis de ids voisins sont déphasés', () => {
    expect(enemyStep(0, 0)).not.toBe(enemyStep(0, 1));
  });
});

describe('invulnVisible', () => {
  it('toujours visible sans invulnérabilité', () => {
    expect(invulnVisible(0)).toBe(true);
    expect(invulnVisible(-5)).toBe(true);
  });
  it('clignote pendant l\'invulnérabilité', () => {
    const seen = new Set<boolean>();
    for (let ms = 1; ms < INVULN_BLINK_MS * 4; ms += 10) seen.add(invulnVisible(ms));
    expect(seen.size).toBe(2);
  });
});

describe('heroFrameFor', () => {
  it('retourne toujours une frame existante de l\'atlas', () => {
    const states: Partial<PlayerState>[] = [
      {},
      { moving: true },
      { attackAnimMs: 100, attackDir: 'left' },
      { status: 'down', hp: 0 },
      { facing: 'up', moving: true },
    ];
    for (const s of states) {
      for (const t of [0, 200, 999]) expect(hasFrame(heroFrameFor(player(s), t))).toBe(true);
    }
  });
  it('à terre → frame downed ; attaque → attack dans la direction d\'attaque', () => {
    expect(heroFrameFor(player({ status: 'down' }), 0)).toBe('hero_david_downed');
    expect(heroFrameFor(player({ attackAnimMs: 50, attackDir: 'left', facing: 'down' }), 0)).toBe('hero_david_left_attack');
  });
});

describe('slashAlpha / reviveFxFrame', () => {
  it('slashAlpha : 0 hors animation, plafonné à 1', () => {
    expect(slashAlpha(0, 200)).toBe(0);
    expect(slashAlpha(200, 200)).toBe(1);
    expect(slashAlpha(40, 200)).toBeCloseTo(0.36, 5);
    expect(slashAlpha(50, 0)).toBe(0);
  });
  it('reviveFxFrame existe dans l\'atlas', () => {
    for (let t = 0; t < 1000; t += 50) expect(hasFrame(reviveFxFrame(t))).toBe(true);
  });
});

describe('PosInterp', () => {
  it('interpole entre deux pas', () => {
    const p = new PosInterp(0, 0);
    p.push(10, 0);
    expect(p.at(0).x).toBe(0);
    expect(p.at(0.5).x).toBe(5);
    expect(p.at(1).x).toBe(10);
    p.push(20, 4);
    expect(p.at(0.5).x).toBe(15);
    expect(p.y).toBe(2);
  });
  it('alpha hors bornes est borné', () => {
    const p = new PosInterp(0, 0);
    p.push(10, 0);
    expect(p.at(-3).x).toBe(0);
    expect(p.at(7).x).toBe(10);
  });
  it('une téléportation n\'est pas lissée', () => {
    const p = new PosInterp(0, 0);
    p.push(INTERP_TELEPORT_DISTANCE + 100, 0);
    expect(p.at(0).x).toBe(INTERP_TELEPORT_DISTANCE + 100);
  });
  it('ignore les valeurs non finies', () => {
    const p = new PosInterp(3, 3);
    p.push(Number.NaN, 5);
    expect(p.at(1).x).toBe(3);
  });
  it('reset place tout', () => {
    const p = new PosInterp(0, 0);
    p.push(5, 5);
    p.reset(40, 40);
    expect(p.at(0.3).x).toBe(40);
  });
});

describe('computeEnemyVisual', () => {
  it('chase : aucune teinte, frame valide, flipX selon la direction', () => {
    const out = createEnemyVisual();
    computeEnemyVisual(enemy({ facing: 'left' }), 0, out);
    expect(out.flipX).toBe(true);
    expect(out.tintFill).toBe(-1);
    expect(out.tint).toBe(COLOR_WHITE);
    expect(hasFrame(out.frame)).toBe(true);
    computeEnemyVisual(enemy({ facing: 'right' }), 0, out);
    expect(out.flipX).toBe(false);
  });

  it('windup : alterne blanc / rouge', () => {
    const out = createEnemyVisual();
    const fills = new Set<number>();
    for (let t = 0; t < WINDUP_BLINK_MS * 4; t += 10) {
      computeEnemyVisual(enemy({ mode: 'windup' }), t, out);
      expect(out.windup).toBe(true);
      fills.add(out.tintFill);
    }
    expect(fills).toEqual(new Set([COLOR_WHITE, COLOR_WARN_RED]));
  });

  it('dégâts : silhouette blanche (ennemi) ou frame hurt (boss)', () => {
    const out = createEnemyVisual();
    computeEnemyVisual(enemy({ hitFlashMs: 80 }), 0, out);
    expect(out.tintFill).toBe(COLOR_WHITE);
    computeEnemyVisual(enemy({ kind: 'golem', hitFlashMs: 80 }), 0, out);
    expect(out.frame).toBe('boss_golem_hurt');
    expect(hasFrame(out.frame)).toBe(true);
    expect(out.flipX).toBe(false);
  });

  it('stunned et teleport', () => {
    const out = createEnemyVisual();
    computeEnemyVisual(enemy({ mode: 'stunned' }), 0, out);
    expect(out.tint).toBe(COLOR_STUN);
    computeEnemyVisual(enemy({ kind: 'morvane', mode: 'teleport' }), 0, out);
    expect(out.alpha).toBeLessThan(0.5);
    expect(hasFrame(out.frame)).toBe(true);
  });

  it('toutes les frames d\'ennemis existent', () => {
    const out = createEnemyVisual();
    for (const kind of ['slime', 'bat', 'skeleton', 'archer', 'spider', 'wisp', 'knight', 'golem', 'morvane'] as const) {
      for (let t = 0; t < 600; t += 120) {
        computeEnemyVisual(enemy({ kind }), t, out);
        expect(hasFrame(out.frame), `${kind}@${t}`).toBe(true);
      }
    }
  });
});
