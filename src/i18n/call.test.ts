/**
 * Tests i18n de la fonctionnalité « appeler » : parité fr/en de la part dédiée, placeholders identiques, clés résolues
 * par `t()` dans les deux langues, et toute clé `call.*` utilisée dans le code existe.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLanguage, hasKey, setLanguage, t, type Language } from './i18n';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(DIR, '..');
type Flat = Record<string, string>;

function readPart(lang: Language): Flat {
  return JSON.parse(fs.readFileSync(path.join(DIR, 'parts', `call.${lang}.json`), 'utf8')) as Flat;
}

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

describe('i18n « appeler »', () => {
  const fr = readPart('fr');
  const en = readPart('en');
  const initial = getLanguage();

  beforeAll(() => setLanguage('fr'));
  afterAll(() => setLanguage(initial));

  it('mêmes clés en français et en anglais, valeurs non vides, mêmes placeholders', () => {
    expect(Object.keys(fr).sort()).toEqual(Object.keys(en).sort());
    expect(Object.keys(fr).length).toBeGreaterThan(0);
    for (const k of Object.keys(fr)) {
      expect(fr[k].trim().length, `fr ${k}`).toBeGreaterThan(0);
      expect(en[k].trim().length, `en ${k}`).toBeGreaterThan(0);
      expect(placeholders(fr[k]), k).toEqual(placeholders(en[k]));
      expect(k.startsWith('call.'), k).toBe(true);
    }
  });

  it('chaque clé est résolue par t() dans les deux langues (pas de clé brute renvoyée)', () => {
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

  it('les touches affichées correspondent aux bindings par défaut (C ; LB / LT)', () => {
    expect(fr['call.controls.keyboard']).toBe('C');
    expect(fr['call.pause.keyboard']).toContain('C');
    expect(fr['call.pause.gamepad']).toContain('LB');
    expect(fr['call.pause.gamepad']).toContain('LT');
    expect(fr['call.controls.gamepad']).toContain('LB');
    expect(en['call.controls.gamepad']).toContain('LT');
  });

  it('toute clé `call.*` référencée dans le code source existe dans le dictionnaire', () => {
    const known = new Set([...Object.keys(fr)]);
    const used = new Set<string>();
    for (const file of sourceFiles(SRC)) {
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(/['"`](call\.[A-Za-z0-9_.]+)['"`]/g)) used.add(m[1]);
    }
    expect(used.size).toBeGreaterThan(0);
    for (const k of used) expect(known.has(k) || hasKey(k), k).toBe(true);
  });
});
