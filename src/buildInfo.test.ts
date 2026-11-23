import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBuildInfo } from '../scripts/build-info.mjs';
import { UNKNOWN_BUILD, formatBuildDate, formatBuildLabel, getBuildInfo } from './buildInfo';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('buildInfo : libellé de version', () => {
  it('formatBuildDate : jj/mm/aaaa en français, ISO en anglais, illisible inchangé', () => {
    expect(formatBuildDate('2026-11-23', 'fr')).toBe('23/11/2026');
    expect(formatBuildDate('2026-11-23', 'en')).toBe('2026-11-23');
    expect(formatBuildDate('hier', 'fr')).toBe('hier');
  });

  it('formatBuildLabel : version · commit · date', () => {
    const info = { version: '0.1.0', commit: '509b48e', date: '2026-11-21' };
    expect(formatBuildLabel(info, 'fr')).toBe('v0.1.0 · 509b48e · 21/11/2026');
    expect(formatBuildLabel(info, 'en')).toBe('v0.1.0 · 509b48e · 2026-11-21');
  });

  it('formatBuildLabel : les parties inconnues sont omises', () => {
    expect(formatBuildLabel({ version: '0.1.0', commit: '509b48e', date: null }, 'fr')).toBe('v0.1.0 · 509b48e');
    expect(formatBuildLabel(UNKNOWN_BUILD, 'fr')).toBe('v0.0.0');
  });

  it('getBuildInfo : la constante injectée par vite.config.ts reprend la version de package.json', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
    const info = getBuildInfo();
    expect(info.version).toBe(pkg.version);
    if (info.commit !== null) expect(info.commit).toMatch(/^[0-9a-f]{4,40}$/);
    if (info.date !== null) expect(info.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('readBuildInfo (scripts/build-info.mjs)', () => {
  const withPackage = (version: string | null, run: (dir: string) => void): void => {
    const dir = mkdtempSync(join(tmpdir(), 'vaelorn-buildinfo-'));
    try {
      if (version !== null) writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }), 'utf8');
      run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('lit le hash court et la date du commit via git, et la version du package', () => {
    withPackage('1.2.3', (dir) => {
      const calls: string[][] = [];
      const git = (args: string[]): string => {
        calls.push(args);
        return '509b48e 2026-11-21\n'.trim();
      };
      expect(readBuildInfo(dir, {}, git)).toEqual({ version: '1.2.3', commit: '509b48e', date: '2026-11-21' });
      expect(calls).toEqual([['log', '-1', '--format=%h %cs']]);
    });
  });

  it('sans git : retombe sur GITHUB_SHA (hash court), date inconnue', () => {
    withPackage('1.2.3', (dir) => {
      const sha = '509b48e0123456789abcdef0123456789abcdef0';
      expect(readBuildInfo(dir, { GITHUB_SHA: sha }, () => null)).toEqual({ version: '1.2.3', commit: '509b48e', date: null });
    });
  });

  it('sans git ni GITHUB_SHA valide : commit et date inconnus', () => {
    withPackage('1.2.3', (dir) => {
      expect(readBuildInfo(dir, {}, () => null)).toEqual({ version: '1.2.3', commit: null, date: null });
      expect(readBuildInfo(dir, { GITHUB_SHA: 'pas un hash' }, () => null).commit).toBeNull();
    });
  });

  it('sortie de git inattendue : ignorée (jamais d\'exception)', () => {
    withPackage('1.2.3', (dir) => {
      expect(readBuildInfo(dir, {}, () => 'fatal: not a git repository')).toEqual({ version: '1.2.3', commit: null, date: null });
    });
  });

  it('package.json absent ou illisible : version neutre', () => {
    withPackage(null, (dir) => {
      expect(readBuildInfo(dir, {}, () => null).version).toBe('0.0.0');
      writeFileSync(join(dir, 'package.json'), '{ pas du json', 'utf8');
      expect(readBuildInfo(dir, {}, () => null).version).toBe('0.0.0');
    });
  });

  it('sur ce dépôt : renvoie un hash et une date plausibles quand git est disponible', () => {
    const info = readBuildInfo(ROOT, {});
    expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
    if (info.commit !== null) expect(info.commit).toMatch(/^[0-9a-f]{4,40}$/);
    if (info.date !== null) expect(info.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
