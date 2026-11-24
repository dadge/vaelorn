/**
 * Touches de la minicarte : Tab (lu par GameScene, hors bindings d'action) ne doit entrer en conflit avec aucune liaison du jeu,
 * et M reste réservée au son (la demande initiale parlait de M, déjà prise).
 */
import { describe, expect, it } from 'vitest';
import { createDefaultBindings } from './defaultBindings';

describe('touches de la minicarte', () => {
  const json = JSON.stringify(createDefaultBindings());

  it('Tab ne figure dans aucune liaison par défaut', () => {
    expect(json).not.toContain('"Tab"');
  });

  it('KeyM ne figure dans aucune liaison par défaut (M = son, géré par GameScene)', () => {
    expect(json).not.toContain('"KeyM"');
  });
});
