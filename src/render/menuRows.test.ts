import { describe, expect, it } from 'vitest';
import { MENU_ROWS_BOTTOM_MAX, MENU_ROW_HEIGHTS, menuRowHeight, menuRowsBottom } from './menuLogic';

/** Anciens seuils de `MenuScene` (avant la ligne « Multijoueur réseau ») : 34 jusqu'à 12 lignes, 31 pour 13, 28 au-delà. */
function legacyRowHeight(selectableCount: number): number {
  return selectableCount > 13 ? 28 : selectableCount > 12 ? 31 : 34;
}

describe('hauteur des lignes du menu', () => {
  it('reprend exactement les anciennes hauteurs pour 1 à 15 lignes sélectionnables (aucun menu existant ne change)', () => {
    for (let n = 1; n <= 15; n++) expect(menuRowHeight(n), `${n} lignes`).toBe(legacyRowHeight(n));
  });

  it('16 lignes sélectionnables (sauvegarde + 4 joueurs + ligne réseau) : une hauteur plus serrée, qui tient', () => {
    const h = menuRowHeight(16);
    expect(h).toBe(26);
    expect(menuRowsBottom(16, 1, h)).toBeLessThanOrEqual(MENU_ROWS_BOTTOM_MAX);
  });

  it('pour tout nombre de lignes jusqu\'à 16, le menu tient au-dessus de la ligne d\'aide', () => {
    for (let n = 1; n <= 16; n++) expect(menuRowsBottom(n, 1, menuRowHeight(n)), `${n} lignes`).toBeLessThanOrEqual(MENU_ROWS_BOTTOM_MAX);
  });

  it('la hauteur ne croît jamais avec le nombre de lignes et ne descend jamais sous le minimum lisible', () => {
    let previous = Infinity;
    for (let n = 1; n <= 30; n++) {
      const h = menuRowHeight(n);
      expect(h).toBeLessThanOrEqual(previous);
      expect(h).toBeGreaterThanOrEqual(MENU_ROW_HEIGHTS[MENU_ROW_HEIGHTS.length - 1]);
      previous = h;
    }
  });
});
