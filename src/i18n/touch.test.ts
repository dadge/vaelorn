/**
 * Parité fr / en des textes de la manette virtuelle (src/i18n/parts/touch.*.json) et usage dans la couche DOM.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const read = (f: string): Record<string, string> => JSON.parse(fs.readFileSync(path.join(DIR, 'parts', f), 'utf8')) as Record<string, string>;
const placeholders = (s: string): string[] => Array.from(s.matchAll(/\{(\w+)\}/g), (m) => m[1]).sort();

describe('textes de la manette virtuelle (touch.fr.json / touch.en.json)', () => {
  const fr = read('touch.fr.json');
  const en = read('touch.en.json');

  it('mêmes clés des deux côtés, valeurs non vides, mêmes placeholders', () => {
    expect(Object.keys(fr).sort()).toEqual(Object.keys(en).sort());
    for (const k of Object.keys(fr)) {
      expect(fr[k].trim().length, k).toBeGreaterThan(0);
      expect(en[k].trim().length, k).toBeGreaterThan(0);
      expect(placeholders(fr[k]), k).toEqual(placeholders(en[k]));
    }
  });

  it('toutes les clés touch.* utilisées par touchControls.ts existent', () => {
    const src = fs.readFileSync(path.join(DIR, '..', 'mobile', 'touchControls.ts'), 'utf8');
    const used = Array.from(src.matchAll(/\bt\('(touch\.[\w.]+)'\)/g), (m) => m[1]);
    expect(used.length).toBeGreaterThan(5);
    for (const k of used) {
      expect(fr[k], k).toBeDefined();
      expect(en[k], k).toBeDefined();
    }
  });

  it('libellés demandés : « Manette virtuelle » / « Virtual gamepad »', () => {
    expect(fr['touch.padName']).toBe('Manette virtuelle');
    expect(en['touch.padName']).toBe('Virtual gamepad');
  });
});
