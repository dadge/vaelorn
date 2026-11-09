import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const PARTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'i18n', 'parts');
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Lit une part i18n si elle existe encore, sinon (fusionnée dans fr.json / en.json par `npm run i18n:merge`) les dictionnaires de base. */
function load(lang: 'fr' | 'en'): Record<string, string> {
  const part = path.join(PARTS, `attract.${lang}.json`);
  if (fs.existsSync(part)) return JSON.parse(fs.readFileSync(part, 'utf8')) as Record<string, string>;
  return JSON.parse(fs.readFileSync(path.resolve(PARTS, '..', `${lang}.json`), 'utf8')) as Record<string, string>;
}

const KEYS = ['attract.banner', 'attract.prompt', 'attract.prompt.touch'];

describe('i18n du mode démo : parité fr / en', () => {
  const fr = load('fr');
  const en = load('en');

  it('les clés du mode démo existent dans les deux langues, non vides', () => {
    for (const k of KEYS) {
      expect(typeof fr[k], `fr ${k}`).toBe('string');
      expect(typeof en[k], `en ${k}`).toBe('string');
      expect(fr[k].trim().length).toBeGreaterThan(0);
      expect(en[k].trim().length).toBeGreaterThan(0);
    }
  });

  it('même ensemble de clés « attract.* » des deux côtés, mêmes placeholders', () => {
    const frKeys = Object.keys(fr).filter((k) => k.startsWith('attract.')).sort();
    const enKeys = Object.keys(en).filter((k) => k.startsWith('attract.')).sort();
    expect(frKeys).toEqual(enKeys);
    const ph = (v: string): string[] => Array.from(v.matchAll(/\{(\w+)\}/g), (m) => m[1]).sort();
    for (const k of frKeys) expect(ph(fr[k]), k).toEqual(ph(en[k]));
  });

  it('les clés « attract.* » utilisées dans le code existent toutes (aucun texte en dur oublié)', () => {
    const used = new Set<string>();
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
          for (const m of fs.readFileSync(p, 'utf8').matchAll(/'(attract\.[\w.]+)'/g)) used.add(m[1]);
        }
      }
    };
    walk(SRC);
    expect(used.size).toBeGreaterThan(0);
    for (const k of used) {
      expect(fr[k], `fr ${k}`).toBeDefined();
      expect(en[k], `en ${k}`).toBeDefined();
    }
  });
});
