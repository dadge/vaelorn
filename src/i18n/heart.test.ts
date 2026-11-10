/**
 * Tests i18n de l'emplacement cœur : parité fr / en de la part dédiée (`parts/heart.*.json`), placeholders identiques, clés résolues, touches affichées = bindings par défaut,
 * et toute clé `heart.*` utilisée dans le code existe. Les textes du tutoriel et de la manette virtuelle liés à B sont vérifiés dans les deux langues.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BINDINGS } from '../input/defaultBindings';
import { getLanguage, hasKey, setLanguage, t, type Language } from './i18n';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(DIR, '..');
type Flat = Record<string, string>;

const readPart = (name: string, lang: Language): Flat => JSON.parse(fs.readFileSync(path.join(DIR, 'parts', `${name}.${lang}.json`), 'utf8')) as Flat;
const placeholders = (v: string): string[] => Array.from(new Set(Array.from(v.matchAll(/\{(\w+)\}/g), (m) => m[1]))).sort();

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(full);
  }
  return out;
}

describe('i18n « emplacement cœur »', () => {
  const fr = readPart('heart', 'fr');
  const en = readPart('heart', 'en');
  const initial = getLanguage();
  beforeAll(() => setLanguage('fr'));
  afterAll(() => setLanguage(initial));

  it('mêmes clés en français et en anglais, valeurs non vides, mêmes placeholders, toutes préfixées heart.', () => {
    expect(Object.keys(fr).sort()).toEqual(Object.keys(en).sort());
    expect(Object.keys(fr).length).toBeGreaterThan(0);
    for (const k of Object.keys(fr)) {
      expect(fr[k].trim().length, `fr ${k}`).toBeGreaterThan(0);
      expect(en[k].trim().length, `en ${k}`).toBeGreaterThan(0);
      expect(placeholders(fr[k]), k).toEqual(placeholders(en[k]));
      expect(k.startsWith('heart.'), k).toBe(true);
    }
  });

  it('chaque clé est résolue par t() dans les deux langues', () => {
    for (const lang of ['fr', 'en'] as const) {
      setLanguage(lang);
      const dict = lang === 'fr' ? fr : en;
      for (const k of Object.keys(dict)) {
        expect(hasKey(k), `${lang} ${k}`).toBe(true);
        expect(t(k), `${lang} ${k}`).toBe(dict[k]);
      }
    }
    setLanguage('fr');
  });

  it('les touches affichées correspondent aux bindings par défaut (clavier B, manette B) et aux rappels de la pause', () => {
    expect(fr['heart.controls.keyboard']).toBe(DEFAULT_BINDINGS.heart.keys[0].replace('Key', ''));
    expect(fr['heart.controls.gamepad']).toBe('Bouton B');
    expect(en['heart.controls.gamepad']).toBe('B button');
    setLanguage('fr');
    expect(t('game.pause.controls.keyboard')).toContain('B : cœur');
    expect(t('game.pause.controls.gamepad')).toContain('B : cœur');
    setLanguage('en');
    expect(t('game.pause.controls.keyboard')).toContain('B: heart');
    expect(t('game.pause.controls.gamepad')).toContain('B: heart');
    setLanguage('fr');
  });

  it('le bouton B virtuel n est plus décrit « sans effet en jeu » (fr et en) et parle du cœur', () => {
    for (const lang of ['fr', 'en'] as const) {
      const touch = readPart('touch', lang);
      expect(touch['touch.b'], lang).not.toMatch(/sans effet|no effect/i);
      expect(touch['touch.b'], lang).toMatch(/cœur|heart/i);
    }
  });

  it('toute clé `heart.*` référencée dans le code source existe dans le dictionnaire', () => {
    const used = new Set<string>();
    for (const file of sourceFiles(SRC)) {
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(/['"`](heart\.[A-Za-z0-9_.]+)['"`]/g)) used.add(m[1]);
    }
    expect(used.size).toBeGreaterThan(0);
    for (const k of used) expect(hasKey(k), k).toBe(true);
  });
});
