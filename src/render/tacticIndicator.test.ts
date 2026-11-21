/**
 * Indicateur des tactiques de boss (`tacticIndicator.ts`) : une forme distincte par tactique, rien sans drapeau ni sans but, état déstabilisé reconnu, textes fr/en, légende de la barre de boss.
 */
import { describe, expect, it } from 'vitest';
import { createEnemyState } from '../core/ai';
import { ENEMIES } from '../core/enemies';
import { getDictionary } from '../i18n/i18n';
import { bossBarEntries } from './bossBars';
import { TACTIC_DAZED_KIND, TACTIC_LABEL_KEYS, tacticColor, tacticIcon, tacticLabelKey, tacticNameOf, tacticShapes } from './tacticIndicator';
import { TACTIC_IDS, TACT_DAZED } from '../core/tactics';

describe('tacticShapes', () => {
  it('rien du tout sans drapeau, sans but ou avec des données invalides', () => {
    expect(tacticShapes({}, 100, 100, 30, 0)).toEqual([]);
    expect(tacticShapes({ tact: 63 }, 100, 100, 30, 0)).toEqual([]);
    expect(tacticShapes({ tact: 63, tactKind: 0 }, 100, 100, 30, 0)).toEqual([]);
    expect(tacticShapes({ tactKind: Number.NaN }, 100, 100, 30, 0)).toEqual([]);
    expect(tacticShapes({ tactKind: 42 }, 100, 100, 30, 0)).toEqual([]);
  });

  it('une icône de FORME distincte par tactique (lisible sans la couleur), couleurs distinctes aussi', () => {
    const icons = [1, 2, 3, 4, 5, 6].map((k) => tacticIcon(k));
    expect(new Set(icons).size).toBe(6);
    expect(icons).toEqual(['ring', 'diamond', 'cross', 'triangle', 'square', 'chevron']);
    expect(new Set([1, 2, 3, 4, 5, 6, 7].map(tacticColor)).size).toBe(7);
    for (let k = 1; k <= 6; k++) {
      const shapes = tacticShapes({ tactKind: k, tactX: 200, tactY: 150 }, 100, 100, 30, 500);
      expect(shapes.filter((s) => s.kind === 'icon')).toHaveLength(1);
      expect(shapes.find((s) => s.kind === 'icon')).toMatchObject({ icon: icons[k - 1], x: 100, y: 70 });
      expect(shapes.some((s) => s.kind === 'dashed')).toBe(true);
      expect(shapes.some((s) => s.kind === 'anchor')).toBe(true);
    }
  });

  it('déstabilisé (code 7) : icône grisée et étoiles, ni ligne ni ancre', () => {
    const shapes = tacticShapes({ tactKind: TACTIC_DAZED_KIND, tactX: 200, tactY: 150 }, 100, 100, 30, 0);
    expect(shapes.map((s) => s.kind)).toEqual(['icon', 'stars']);
    expect(shapes[0]).toMatchObject({ icon: 'dazed', color: tacticColor(7) });
    expect(TACTIC_DAZED_KIND).toBe(TACT_DAZED);
  });

  it('sans ancre connue : l\'icône seule', () => {
    expect(tacticShapes({ tactKind: 2 }, 10, 10, 20, 0).map((s) => s.kind)).toEqual(['icon']);
  });
});

describe('textes', () => {
  it('codes ↔ identifiants ↔ clés i18n : parité fr/en, non vides, courts', () => {
    expect(TACTIC_IDS.map((_, i) => tacticNameOf(i + 1))).toEqual([...TACTIC_IDS]);
    expect(tacticNameOf(7)).toBe('dazed');
    expect(tacticNameOf(0)).toBeNull();
    expect(tacticLabelKey(0)).toBeNull();
    expect(TACTIC_LABEL_KEYS).toHaveLength(7);
    const fr = getDictionary('fr');
    const en = getDictionary('en');
    for (let k = 1; k <= 7; k++) {
      const key = tacticLabelKey(k) as string;
      expect(TACTIC_LABEL_KEYS).toContain(key);
      for (const d of [fr, en]) {
        expect(d[key], key).toBeTruthy();
        expect(d[key].length).toBeLessThanOrEqual(90);
      }
    }
  });
});

describe('légende de la barre de boss', () => {
  it('`tactKind` présent seulement quand un but est en cours', () => {
    const lookup = (k: string) => ENEMIES[k as keyof typeof ENEMIES];
    const e = createEnemyState('warden', { x: 0, y: 0 }, 1, 0);
    expect(bossBarEntries([e], lookup)[0]).not.toHaveProperty('tactKind');
    e.data.tactKind = 0;
    expect(bossBarEntries([e], lookup)[0]).not.toHaveProperty('tactKind');
    e.data.tactKind = 1;
    expect(bossBarEntries([e], lookup)[0].tactKind).toBe(1);
    e.data.tactKind = 7;
    expect(bossBarEntries([e], lookup)[0].tactKind).toBe(7);
  });
});
