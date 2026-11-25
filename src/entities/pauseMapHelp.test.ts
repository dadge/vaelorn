/**
 * Menu pause : le rappel de la minicarte (`map.help`, « Tab : afficher / masquer le plan » ; `map.helpTouch`, « appui long sur le plan », sur appareil
 * tactile) n'apparaît que dans une partie avec carte (ni démo ni tutoriel : leur menu reste inchangé), dans les deux langues.
 */
import { describe, expect, it } from 'vitest';
import { makeFakeViewContext, type FakeGameObject } from '../render/hudTestKit';
import { setLanguage, t, type Language } from '../i18n/i18n';
import { PauseMenu } from './overlay';

interface PauseInternals {
  controls: FakeGameObject;
  panel: FakeGameObject;
}

describe('menu pause : aide de la touche de la minicarte', () => {
  it.each(['fr', 'en'] as Language[])('ligne d\'aide présente avec la carte, absente sans (%s)', (lang) => {
    setLanguage(lang);
    const { ctx } = makeFakeViewContext(3, 1);
    const menu = new PauseMenu(ctx);
    const inner = menu as unknown as PauseInternals;
    menu.show();
    const base = inner.controls.text;
    expect(base).not.toContain(t('map.help'));
    const baseHeight = inner.panel.height;

    menu.setMapHelp(true);
    expect(inner.controls.text).toBe(`${base}\n${t('map.help')}`);
    expect(inner.controls.text).toContain('Tab');
    expect(inner.panel.height).toBeGreaterThan(baseHeight); // la ligne de plus tient dans le panneau

    menu.setMapHelp(false);
    expect(inner.controls.text).toBe(base);
    expect(inner.panel.height).toBe(baseHeight);
  });

  it.each(['fr', 'en'] as Language[])('appareil tactile : la ligne d\'aide dit « appui long sur le plan » au lieu de « Tab » (%s)', (lang) => {
    setLanguage(lang);
    const { ctx } = makeFakeViewContext(3, 1);
    const menu = new PauseMenu(ctx);
    const inner = menu as unknown as PauseInternals;
    menu.show();
    menu.setMapHelp(true, true);
    expect(inner.controls.text).toContain(t('map.helpTouch'));
    expect(inner.controls.text).not.toContain(t('map.help'));
    expect(inner.controls.text).not.toContain('Tab');
    // retour au clavier : la ligne « Tab » réapparaît
    menu.setMapHelp(true, false);
    expect(inner.controls.text).toContain(t('map.help'));
    expect(inner.controls.text).not.toContain(t('map.helpTouch'));
  });
});
