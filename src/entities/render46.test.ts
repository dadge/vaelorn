/**
 * Rendu des ennemis des niveaux 4-6 et sons des nouveaux événements : choix de frames par type, aspect (flash de dégâts,
 * télégraphe), zones de danger du seigneur du Vide, couleurs de mort, sons.
 */
import { describe, expect, it } from 'vitest';
import { createEnemyState } from '../core/ai';
import { ENEMY_KINDS } from '../core/enemies';
import type { EnemyKind, EnemyState, SimEvent } from '../core/types';
import { hasFrame } from '../render/art';
import { enemyDeathColor } from '../render/fx';
import { COLOR_WARN_RED, COLOR_WHITE, computeEnemyVisual, createEnemyVisual, isBigKind, isBossKind } from './animation';
import { Sfx, sfxForEvent } from './sfx';
import { telegraphShapes, voidZones } from './telegraph';

const NEW_KINDS: EnemyKind[] = ['warden', 'frostqueen', 'pyromancer', 'forgelord', 'wraith', 'voidlord'];

function enemy(kind: EnemyKind, over: Partial<EnemyState> = {}): EnemyState {
  return { ...createEnemyState(kind, { x: 40, y: 40 }, 1, 0), ...over };
}

describe('aspect des nouveaux ennemis (générique : ne dépend que de kind / mode / hitFlashMs)', () => {
  it('frames existantes pour tous les types, à tout instant et dans tous les modes courants', () => {
    const out = createEnemyVisual();
    for (const kind of ENEMY_KINDS) {
      for (const mode of ['idle', 'chase', 'windup', 'attack', 'recover', 'stunned', 'teleport', 'inconnu']) {
        for (let t = 0; t < 600; t += 120) {
          computeEnemyVisual(enemy(kind, { mode }), t, out);
          expect(hasFrame(out.frame), `${kind}/${mode}@${t}`).toBe(true);
        }
      }
    }
  });

  it('boss et demi-boss : jamais retournés ; frame « hurt » au lieu du flash blanc ; petits ennemis : flipX et flash blanc', () => {
    const out = createEnemyVisual();
    for (const kind of NEW_KINDS) {
      computeEnemyVisual(enemy(kind, { facing: 'left', hitFlashMs: 80 }), 0, out);
      expect(out.flipX, kind).toBe(false);
      expect(out.frame, kind).toMatch(/_hurt$/);
      expect(out.tintFill, kind).toBe(-1);
      expect(isBigKind(kind)).toBe(true);
    }
    computeEnemyVisual(enemy('slime', { facing: 'left', hitFlashMs: 80 }), 0, out);
    expect(out.flipX).toBe(true);
    expect(out.tintFill).toBe(COLOR_WHITE);
    expect(isBigKind('slime')).toBe(false);
  });

  it('télégraphe générique : un windup clignote blanc/rouge pour tous les types', () => {
    const out = createEnemyVisual();
    const seen = new Set<number>();
    for (const kind of NEW_KINDS) {
      for (const t of [0, 100]) {
        computeEnemyVisual(enemy(kind, { mode: 'windup' }), t, out);
        expect(out.windup, kind).toBe(true);
        seen.add(out.tintFill);
      }
    }
    expect(seen).toEqual(new Set([COLOR_WHITE, COLOR_WARN_RED]));
  });

  it('isBossKind suit le core : seulement les boss de fin de niveau', () => {
    for (const k of ['golem', 'morvane', 'frostqueen', 'forgelord', 'voidlord']) expect(isBossKind(k), k).toBe(true);
    for (const k of ['warden', 'pyromancer', 'wraith', 'slime']) expect(isBossKind(k), k).toBe(false);
  });
});

describe('zones de danger du seigneur du Vide', () => {
  it('une zone par cercle (zoneX/Y i, zoneRadius) ; rien sans zoneCount', () => {
    const e = enemy('voidlord', { mode: 'windup' });
    expect(voidZones(e)).toEqual([]);
    Object.assign(e.data, { zoneCount: 2, zoneRadius: 24, zoneX0: 10, zoneY0: 20, zoneX1: 100, zoneY1: 60, zoneX2: 999, zoneY2: 999 });
    expect(voidZones(e)).toEqual([
      { kind: 'circle', x: 10, y: 20, r: 24 },
      { kind: 'circle', x: 100, y: 60, r: 24 },
    ]);
    // le télégraphe dessine ces zones à la place de la forme générique
    expect(telegraphShapes(e, 0, 0)).toEqual(voidZones(e));
  });

  it('bornée à 3 zones, ignore les valeurs absentes ou non finies', () => {
    const e = enemy('voidlord');
    Object.assign(e.data, { zoneCount: 9, zoneRadius: 10, zoneX0: 1, zoneY0: 2, zoneX1: Number.NaN, zoneY1: 3, zoneX2: 5, zoneY2: 6 });
    expect(voidZones(e)).toHaveLength(2);
    e.data.zoneRadius = 0;
    expect(voidZones(e)).toEqual([]);
  });
});

describe('couleurs de mort et sons des nouveaux événements', () => {
  it('couleur de mort propre à chaque nouveau type (pas le blanc par défaut)', () => {
    const colors = NEW_KINDS.map((k) => enemyDeathColor(k));
    for (const c of colors) expect(c).not.toBe(0xffffff);
    expect(new Set(colors).size).toBe(NEW_KINDS.length);
  });

  it('chaque nouvel événement a son son ; bossPhase distingue demi-boss et boss', () => {
    const ev: Record<string, SimEvent> = {
      statueRotated: { type: 'statueRotated', mechanismId: 's', index: 0, facing: 'up', playerId: 0 },
      hourglassFlipped: { type: 'hourglassFlipped', mechanismId: 'h', leverIndex: 0, playerId: 0 },
      hourglassEmpty: { type: 'hourglassEmpty', mechanismId: 'h' },
      gateClosed: { type: 'gateClosed', mechanismId: 'h', closedCount: 1 },
    };
    for (const [name, e] of Object.entries(ev)) expect(sfxForEvent(e), name).toBe(name);
    expect(sfxForEvent({ type: 'bossPhase', enemyId: 1, kind: 'warden', phase: 1 })).toBe('minibossPhase');
    for (const kind of ['golem', 'morvane', 'frostqueen', 'forgelord', 'voidlord'] as const) {
      expect(sfxForEvent({ type: 'bossPhase', enemyId: 1, kind, phase: 1 }), kind).toBe('boss');
    }
  });

  it('le lecteur ne lève jamais pour les nouveaux sons (Node, sans audio)', () => {
    const s = new Sfx();
    for (const n of ['statueRotated', 'hourglassFlipped', 'hourglassEmpty', 'gateClosed', 'minibossPhase'] as const) expect(() => s.play(n)).not.toThrow();
    s.destroy();
  });
});
