import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import frBase from './fr.json';
import enBase from './en.json';
import {
  LANGUAGE_STORAGE_KEY,
  SUPPORTED_LANGUAGES,
  detectLanguage,
  getDictionary,
  getLanguage,
  hasKey,
  onLanguageChange,
  resetI18nStateForTests,
  setLanguage,
  t,
  type Language,
} from './i18n';
import { I18nMergeError, mergeI18n, parseArgs } from '../../scripts/merge-i18n.mjs';

// ───────────────────────────── Utilitaires ─────────────────────────────

const I18N_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(I18N_DIR, '..');
const PARTS_DIR = path.join(I18N_DIR, 'parts');

type Flat = Record<string, string>;

/** Placeholders `{x}` d'une chaîne, triés et dédupliqués. */
function placeholdersOf(value: string): string[] {
  return Array.from(new Set(Array.from(value.matchAll(/\{(\w+)\}/g), (m) => m[1]))).sort();
}

/** Lit un fichier JSON plat. */
function readJson(file: string): Flat {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Flat;
}

interface CollectedKeys {
  fr: Flat;
  en: Flat;
  /** Noms des fichiers de parts trouvés (ex. 'level1.fr.json'). */
  partFiles: string[];
  /** Clés présentes dans une part avec une valeur différente d'une autre source. */
  conflicts: string[];
}

/**
 * Collecte TOUTES les clés connues : fr.json/en.json + parts/*.fr.json / *.en.json présentes.
 * (`import.meta.glob` n'est pas disponible sous Node pur : on lit le disque avec fs.)
 */
function collectAllKeys(): CollectedKeys {
  const out: CollectedKeys = { fr: { ...(frBase as Flat) }, en: { ...(enBase as Flat) }, partFiles: [], conflicts: [] };
  if (!fs.existsSync(PARTS_DIR)) return out;
  const names = fs
    .readdirSync(PARTS_DIR, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => d.name)
    .sort();
  for (const name of names) {
    const m = /^(.+)\.(fr|en)\.json$/.exec(name);
    if (!m) continue;
    out.partFiles.push(name);
    const lang = m[2] as Language;
    const dict = readJson(path.join(PARTS_DIR, name));
    for (const [k, v] of Object.entries(dict)) {
      if (k in out[lang] && out[lang][k] !== v) out.conflicts.push(`${k} (${lang}, ${name})`);
      else out[lang][k] = v;
    }
  }
  return out;
}

/** Liste récursive des fichiers `.ts` (hors tests et .d.ts) sous `dir`. */
function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listSourceFiles(full));
    else if (entry.isFile() && /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

/** Retire les commentaires (bloc et ligne) d'un source TS — approximation suffisante pour le scan. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

/**
 * Extrait les clés littérales passées à `t('...')`. Ignore les appels membres (`x.t(`), les templates avec
 * interpolation `${...}` (clés dynamiques) et les commentaires.
 */
function extractLiteralKeys(source: string): string[] {
  const keys: string[] = [];
  const re = /(?<![\w$.])t\(\s*(['"`])((?:(?!\1)[^\\\n])*)\1/g;
  for (const m of stripComments(source).matchAll(re)) {
    const key = m[2];
    if (key === '' || key.includes('${')) continue;
    keys.push(key);
  }
  return keys;
}

/** Faux localStorage en mémoire. */
function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (k: string) => (data.has(k) ? (data.get(k) as string) : null),
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    data,
  };
}

beforeEach(() => {
  resetI18nStateForTests();
  vi.stubGlobal('localStorage', fakeStorage());
  vi.stubGlobal('navigator', { language: 'en-US' });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetI18nStateForTests();
});

// ───────────────────────────── Dictionnaires de base ─────────────────────────────

describe('dictionnaires fr.json / en.json', () => {
  const fr = frBase as Flat;
  const en = enBase as Flat;

  it('ont exactement les mêmes clés', () => {
    const onlyFr = Object.keys(fr).filter((k) => !(k in en));
    const onlyEn = Object.keys(en).filter((k) => !(k in fr));
    expect({ onlyFr, onlyEn }).toEqual({ onlyFr: [], onlyEn: [] });
  });

  it('sont plats : toutes les valeurs sont des chaînes non vides', () => {
    for (const [lang, dict] of [['fr', fr], ['en', en]] as const) {
      for (const [k, v] of Object.entries(dict)) {
        expect(typeof v, `${lang}:${k} doit être une chaîne`).toBe('string');
        expect(v.trim().length, `${lang}:${k} est vide`).toBeGreaterThan(0);
      }
    }
  });

  it('utilisent les mêmes placeholders {x} des deux côtés', () => {
    for (const k of Object.keys(fr)) {
      expect(placeholdersOf(en[k]), `placeholders de ${k}`).toEqual(placeholdersOf(fr[k]));
    }
  });

  it('ont des clés pointées bien formées et triées alphabétiquement', () => {
    const keys = Object.keys(fr);
    for (const k of keys) expect(k, `clé mal formée : ${k}`).toMatch(/^[A-Za-z0-9_]+(\.[A-Za-z0-9_-]+)+$/);
    expect(keys).toEqual([...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(Object.keys(en)).toEqual(keys);
  });

  it('contiennent les chaînes clés du contrat', () => {
    expect(fr['menu.title']).toBe("Les Fragments de l'Aube");
    expect(en['menu.title']).toBe('The Dawn Fragments');
    expect(fr['menu.difficulty.1']).toBe('Facile');
    expect(fr['menu.difficulty.2']).toBe('Normal');
    expect(fr['menu.difficulty.3']).toBe('Difficile');
    expect(fr['menu.difficulty.note']).toContain('PV');
    expect(fr['enemy.golem']).toBe('Gorgrim, Golem de racines');
    expect(fr['enemy.morvane']).toBe('Morvane, le Seigneur Déchu');
    expect(fr['speaker.aldric']).toBe('Maître Aldric');
    expect(fr['mech.symbol.eye']).toBe('œil');
  });

  it('couvrent les 8 personnages (nom, classe, description)', () => {
    const classesEn: Record<string, string> = {
      david: 'Warrior',
      sandrine: 'Sorceress',
      romain: 'Scout',
      valentine: 'Healer-Archer',
      aelith: 'Elven Archer',
      brokk: 'Dwarf Guardian',
      grok: 'Troll',
      mira: 'Rogue',
    };
    for (const [id, classEn] of Object.entries(classesEn)) {
      for (const part of ['name', 'class', 'desc']) expect(fr[`character.${id}.${part}`], `fr character.${id}.${part}`).toBeTruthy();
      expect(en[`character.${id}.class`]).toBe(classEn);
    }
    // Noms propres familiaux identiques FR/EN
    for (const id of ['david', 'sandrine', 'romain', 'valentine']) {
      expect(fr[`character.${id}.name`]).toBe(en[`character.${id}.name`]);
    }
  });

  it('couvrent ennemis, orateurs, symboles, couleurs de slot, difficultés et textes de fin', () => {
    const required = [
      ...['slime', 'bat', 'skeleton', 'archer', 'spider', 'wisp', 'knight', 'golem', 'morvane'].map((k) => `enemy.${k}`),
      ...['narrator', 'aldric', 'lyssa', 'morvane', 'gorgrim', 'heroes'].map((k) => `speaker.${k}`),
      ...['sun', 'moon', 'star', 'eye', 'flame', 'wave'].map((k) => `mech.symbol.${k}`),
      ...['blue', 'red', 'green', 'yellow'].map((k) => `hint.slotcolor.${k}`),
      ...['1', '2', '3'].map((k) => `menu.difficulty.${k}`),
      'story.end.title',
      'story.end.line.3',
      'menu.play',
      'hud.allDown',
      'hud.restartRoom',
      'result.victory',
      'select.input.gamepadMissing',
      'select.taken',
    ];
    for (const k of required) {
      expect(fr[k], `fr ${k}`).toBeTruthy();
      expect(en[k], `en ${k}`).toBeTruthy();
    }
  });
});

// ───────────────────────────── t() et interpolation ─────────────────────────────

describe('t() — traduction et interpolation', () => {
  it('traduit selon la langue courante', () => {
    setLanguage('fr');
    expect(t('menu.play')).toBe('Jouer');
    setLanguage('en');
    expect(t('menu.play')).toBe('Play');
  });

  it('interpole les {paramètres} (chaînes et nombres, occurrences multiples)', () => {
    setLanguage('fr');
    expect(t('hud.reviveHold', { name: 'David' })).toBe("Maintiens l'action pour relever David");
    expect(t('hud.room.number', { n: 2, total: 6 })).toBe('Salle 2/6');
    expect(t('menu.players.many', { count: 4 })).toBe('4 joueurs');
    setLanguage('en');
    expect(t('hud.room.number', { n: 3, total: 9 })).toBe('Room 3/9');
  });

  it('laisse visible un placeholder sans paramètre correspondant, et accepte 0', () => {
    setLanguage('en');
    expect(t('hud.room.number', { n: 0 })).toBe('Room 0/{total}');
    expect(t('hud.room.number')).toBe('Room {n}/{total}');
  });

  it("n'interprète pas les $ ni les motifs spéciaux de replace dans les valeurs", () => {
    setLanguage('en');
    expect(t('hud.reviveHold', { name: '$&$1' })).toBe('Hold the action button to revive $&$1');
  });

  it('clé manquante : retourne la clé et avertit UNE seule fois', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(t('does.not.exist')).toBe('does.not.exist');
    expect(t('does.not.exist')).toBe('does.not.exist');
    expect(t('does.not.exist', { a: 1 })).toBe('does.not.exist');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('does.not.exist');
    expect(t('other.missing')).toBe('other.missing');
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('ne confond pas une clé manquante avec une propriété héritée d\'Object', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(t('constructor')).toBe('constructor');
    expect(t('toString')).toBe('toString');
    expect(hasKey('constructor')).toBe(false);
    expect(hasKey('__proto__')).toBe(false);
  });

  it('hasKey et getDictionary reflètent les dictionnaires', () => {
    expect(hasKey('menu.play', 'fr')).toBe(true);
    expect(hasKey('menu.play', 'en')).toBe(true);
    expect(hasKey('nope.nope', 'fr')).toBe(false);
    setLanguage('fr');
    expect(hasKey('menu.play')).toBe(true);
    expect(getDictionary('fr')['menu.play']).toBe('Jouer');
    expect(getDictionary('en')['menu.play']).toBe('Play');
    // Contient au moins toutes les clés de base
    expect(Object.keys(getDictionary('fr')).length).toBeGreaterThanOrEqual(Object.keys(frBase).length);
  });
});

// ───────────────────────────── Langue ─────────────────────────────

describe('langue : détection, setLanguage, onLanguageChange', () => {
  it('SUPPORTED_LANGUAGES = fr, en', () => {
    expect([...SUPPORTED_LANGUAGES]).toEqual(['fr', 'en']);
  });

  it('détecte fr/en depuis navigator.language quand rien n\'est persisté', () => {
    vi.stubGlobal('navigator', { language: 'fr-FR' });
    expect(detectLanguage()).toBe('fr');
    vi.stubGlobal('navigator', { language: 'FR' });
    expect(detectLanguage()).toBe('fr');
    vi.stubGlobal('navigator', { language: 'en-GB' });
    expect(detectLanguage()).toBe('en');
    vi.stubGlobal('navigator', { language: 'de-DE' });
    expect(detectLanguage()).toBe('en');
  });

  it('la langue persistée l\'emporte sur navigator', () => {
    vi.stubGlobal('navigator', { language: 'fr-FR' });
    vi.stubGlobal('localStorage', fakeStorage({ [LANGUAGE_STORAGE_KEY]: 'en' }));
    expect(detectLanguage()).toBe('en');
    resetI18nStateForTests();
    expect(getLanguage()).toBe('en');
  });

  it('ignore une valeur persistée invalide', () => {
    vi.stubGlobal('navigator', { language: 'fr-FR' });
    vi.stubGlobal('localStorage', fakeStorage({ [LANGUAGE_STORAGE_KEY]: 'klingon' }));
    expect(detectLanguage()).toBe('fr');
  });

  it('survit à un localStorage et un navigator qui lèvent des exceptions', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    vi.stubGlobal('navigator', undefined);
    expect(detectLanguage()).toBe('en');
    expect(() => setLanguage('fr')).not.toThrow();
    expect(getLanguage()).toBe('fr');
  });

  it('survit à l\'absence totale de localStorage / navigator', () => {
    vi.stubGlobal('localStorage', undefined);
    vi.stubGlobal('navigator', undefined);
    expect(detectLanguage()).toBe('en');
    expect(() => setLanguage('fr')).not.toThrow();
    expect(t('menu.play')).toBe('Jouer');
  });

  it('setLanguage persiste dans localStorage', () => {
    const storage = fakeStorage();
    vi.stubGlobal('localStorage', storage);
    setLanguage('fr');
    expect(storage.data.get(LANGUAGE_STORAGE_KEY)).toBe('fr');
    setLanguage('en');
    expect(storage.data.get(LANGUAGE_STORAGE_KEY)).toBe('en');
  });

  it('getLanguage détecte paresseusement puis reste stable', () => {
    vi.stubGlobal('navigator', { language: 'fr-CA' });
    expect(getLanguage()).toBe('fr');
    vi.stubGlobal('navigator', { language: 'en-US' });
    expect(getLanguage()).toBe('fr');
  });

  it('onLanguageChange notifie les abonnés uniquement quand la langue change', () => {
    setLanguage('en');
    const cb = vi.fn();
    const off = onLanguageChange(cb);
    setLanguage('en'); // inchangée
    expect(cb).not.toHaveBeenCalled();
    setLanguage('fr');
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenLastCalledWith('fr');
    expect(getLanguage()).toBe('fr'); // la langue est déjà à jour dans le callback
    off();
    setLanguage('en');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('le callback voit la nouvelle langue via t() et plusieurs abonnés coexistent', () => {
    setLanguage('en');
    const seen: string[] = [];
    const offA = onLanguageChange(() => seen.push(`A:${t('menu.play')}`));
    const offB = onLanguageChange(() => seen.push(`B:${t('menu.play')}`));
    setLanguage('fr');
    expect(seen).toEqual(['A:Jouer', 'B:Jouer']);
    offA();
    offB();
  });

  it('un abonné qui lève une exception ne bloque pas les suivants', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    setLanguage('en');
    const ok = vi.fn();
    const offBad = onLanguageChange(() => {
      throw new Error('boom');
    });
    const offOk = onLanguageChange(ok);
    setLanguage('fr');
    expect(ok).toHaveBeenCalledWith('fr');
    expect(err).toHaveBeenCalled();
    offBad();
    offOk();
  });

  it('un désabonnement pendant la notification est sûr', () => {
    setLanguage('en');
    const calls: string[] = [];
    const offFirst = onLanguageChange(() => {
      calls.push('first');
      offFirst();
    });
    onLanguageChange(() => calls.push('second'));
    setLanguage('fr');
    setLanguage('en');
    expect(calls).toEqual(['first', 'second', 'second']);
  });

  it('ignore une langue non supportée', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setLanguage('fr');
    setLanguage('de' as Language);
    expect(getLanguage()).toBe('fr');
    expect(warn).toHaveBeenCalled();
  });
});

// ───────────────────────────── Parts (collectAllKeys) ─────────────────────────────

describe('parts temporaires (src/i18n/parts)', () => {
  it('collectAllKeys : base + parts, parité fr/en, aucune valeur vide, mêmes placeholders', () => {
    const all = collectAllKeys();
    expect(all.conflicts, 'doublons de clés avec valeurs différentes').toEqual([]);

    // Chaque part fr a sa part en (et inversement)
    const zones = new Set(all.partFiles.map((f) => f.replace(/\.(fr|en)\.json$/, '')));
    for (const zone of zones) {
      expect(all.partFiles, `parts/${zone}.fr.json manquant`).toContain(`${zone}.fr.json`);
      expect(all.partFiles, `parts/${zone}.en.json manquant`).toContain(`${zone}.en.json`);
    }

    const onlyFr = Object.keys(all.fr).filter((k) => !(k in all.en));
    const onlyEn = Object.keys(all.en).filter((k) => !(k in all.fr));
    expect({ onlyFr, onlyEn }, 'parité fr/en (base + parts)').toEqual({ onlyFr: [], onlyEn: [] });

    for (const lang of ['fr', 'en'] as const) {
      for (const [k, v] of Object.entries(all[lang])) {
        expect(typeof v, `${lang}:${k}`).toBe('string');
        expect(v.trim().length, `${lang}:${k} est vide`).toBeGreaterThan(0);
      }
    }
    for (const k of Object.keys(all.fr)) {
      expect(placeholdersOf(all.en[k] ?? ''), `placeholders de ${k}`).toEqual(placeholdersOf(all.fr[k]));
    }
  });

  it('chaque part est un objet plat (aucun objet imbriqué)', () => {
    if (!fs.existsSync(PARTS_DIR)) return;
    for (const name of fs.readdirSync(PARTS_DIR)) {
      if (!/\.(fr|en)\.json$/.test(name)) continue;
      const data = JSON.parse(fs.readFileSync(path.join(PARTS_DIR, name), 'utf8')) as unknown;
      expect(data !== null && typeof data === 'object' && !Array.isArray(data), `${name} doit être un objet`).toBe(true);
      for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
        expect(typeof v, `${name} : ${k} doit être une chaîne`).toBe('string');
      }
    }
  });
});

// ───────────────────────────── Scan du code source ─────────────────────────────

describe("scan de src/**/*.ts : clés littérales de t('...')", () => {
  it("extractLiteralKeys : littéraux oui, dynamiques / membres / commentaires non", () => {
    const source = `
      // t('comment.line')
      /* t('comment.block') */
      const a = t('menu.play');
      const b = t("hud.pause", { x: 1 });
      const c = t(\`select.title\`);
      const d = t(\`character.\${id}.name\`);
      const e = i18n.t('member.call');
      const f = format('not.a.t.call');
      const g = t(dynamicKey);
      const h = t('');
      const url = 'http://example.com'; const i = t('after.url');
    `;
    expect(extractLiteralKeys(source)).toEqual(['menu.play', 'hud.pause', 'select.title', 'after.url']);
  });

  it('toute clé littérale utilisée dans src/ existe dans fr.json ou dans les parts', () => {
    const all = collectAllKeys();
    const missing: string[] = [];
    let scanned = 0;
    for (const file of listSourceFiles(SRC_DIR)) {
      const rel = path.relative(SRC_DIR, file).split(path.sep).join('/');
      for (const key of extractLiteralKeys(fs.readFileSync(file, 'utf8'))) {
        scanned++;
        if (!(key in all.fr) || !(key in all.en)) missing.push(`${rel} -> ${key}`);
      }
    }
    expect(scanned).toBeGreaterThanOrEqual(0);
    expect(missing, 'clés t() absentes des dictionnaires (fr ET en)').toEqual([]);
  });
});

// ───────────────────────────── Script de fusion ─────────────────────────────

describe('scripts/merge-i18n.mjs', () => {
  let dir: string;

  /** Écrit un objet JSON dans `dir/<rel>`. */
  function put(rel: string, data: unknown): void {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2), 'utf8');
  }
  const read = (rel: string): Flat => JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8')) as Flat;
  const partsLeft = (): string[] => (fs.existsSync(path.join(dir, 'parts')) ? fs.readdirSync(path.join(dir, 'parts')).sort() : []);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaelorn-i18n-'));
    put('fr.json', { 'menu.play': 'Jouer', 'menu.quit': 'Quitter' });
    put('en.json', { 'menu.play': 'Play', 'menu.quit': 'Quit' });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('fusionne les parts, trie les clés et supprime les parts traitées', () => {
    put('parts/level2.fr.json', { 'level.level2.name': 'Le Bosquet', 'a.first': 'Un' });
    put('parts/level2.en.json', { 'level.level2.name': 'The Grove', 'a.first': 'One' });
    put('parts/level1.fr.json', { 'level.level1.name': 'Les Cryptes' });
    put('parts/level1.en.json', { 'level.level1.name': 'The Crypts' });
    const logs: string[] = [];
    const res = mergeI18n({ dir, log: (m) => logs.push(m) });

    expect(res.written).toBe(true);
    expect(res.removed).toBe(true);
    expect(res.added).toEqual({ fr: 3, en: 3 });
    expect(res.total).toEqual({ fr: 5, en: 5 });
    expect(res.processed).toEqual([
      'parts/level1.en.json',
      'parts/level1.fr.json',
      'parts/level2.en.json',
      'parts/level2.fr.json',
    ]);
    expect(Object.keys(read('fr.json'))).toEqual(['a.first', 'level.level1.name', 'level.level2.name', 'menu.play', 'menu.quit']);
    expect(read('en.json')['level.level2.name']).toBe('The Grove');
    expect(read('fr.json')['menu.play']).toBe('Jouer');
    expect(partsLeft()).toEqual([]);
    expect(logs.length).toBeGreaterThan(0);
    expect(fs.readFileSync(path.join(dir, 'fr.json'), 'utf8').endsWith('\n')).toBe(true);
  });

  it('--dry-run : n\'écrit ni ne supprime rien', () => {
    put('parts/z.fr.json', { 'z.k': 'Zed' });
    put('parts/z.en.json', { 'z.k': 'Zed' });
    const before = fs.readFileSync(path.join(dir, 'fr.json'), 'utf8');
    const res = mergeI18n({ dir, dryRun: true });
    expect(res.written).toBe(false);
    expect(res.removed).toBe(false);
    expect(res.added).toEqual({ fr: 1, en: 1 });
    expect(fs.readFileSync(path.join(dir, 'fr.json'), 'utf8')).toBe(before);
    expect(partsLeft()).toEqual(['z.en.json', 'z.fr.json']);
  });

  it('--keep : écrit les dictionnaires mais conserve les parts', () => {
    put('parts/z.fr.json', { 'z.k': 'Zed' });
    put('parts/z.en.json', { 'z.k': 'Zed' });
    const res = mergeI18n({ dir, keep: true });
    expect(res.written).toBe(true);
    expect(res.removed).toBe(false);
    expect(read('fr.json')['z.k']).toBe('Zed');
    expect(partsLeft()).toEqual(['z.en.json', 'z.fr.json']);
    // Relancer est idempotent (doublons à valeur identique tolérés)
    const again = mergeI18n({ dir });
    expect(again.added).toEqual({ fr: 0, en: 0 });
    expect(partsLeft()).toEqual([]);
  });

  it('sans parts : ne fait rien', () => {
    const res = mergeI18n({ dir });
    expect(res.processed).toEqual([]);
    expect(res.written).toBe(false);
    put('parts/.gitkeep', '');
    expect(mergeI18n({ dir }).processed).toEqual([]);
  });

  it('erreur explicite sur doublon de clé avec valeur différente (entre parts)', () => {
    put('parts/a.fr.json', { 'dup.k': 'Un' });
    put('parts/a.en.json', { 'dup.k': 'One' });
    put('parts/b.fr.json', { 'dup.k': 'Deux' });
    put('parts/b.en.json', { 'dup.k': 'One' });
    const before = fs.readFileSync(path.join(dir, 'fr.json'), 'utf8');
    let error: unknown;
    try {
      mergeI18n({ dir });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(I18nMergeError);
    expect((error as I18nMergeError).problems.join('\n')).toContain('dup.k');
    expect((error as I18nMergeError).message).toContain('doublon');
    // Rien n'a été modifié ni supprimé
    expect(fs.readFileSync(path.join(dir, 'fr.json'), 'utf8')).toBe(before);
    expect(partsLeft()).toHaveLength(4);
  });

  it('erreur sur doublon avec une valeur différente du dictionnaire de base', () => {
    put('parts/a.fr.json', { 'menu.play': 'Lancer' });
    put('parts/a.en.json', { 'menu.play': 'Play' });
    expect(() => mergeI18n({ dir })).toThrow(/menu\.play/);
  });

  it('doublon à valeur identique : toléré', () => {
    put('parts/a.fr.json', { 'menu.play': 'Jouer' });
    put('parts/a.en.json', { 'menu.play': 'Play' });
    expect(mergeI18n({ dir }).added).toEqual({ fr: 0, en: 0 });
  });

  it('erreur si la parité fr/en est brisée (clé d\'un seul côté)', () => {
    put('parts/a.fr.json', { 'only.fr': 'Seulement' });
    put('parts/a.en.json', { 'other.en': 'Only' });
    let error: unknown;
    try {
      mergeI18n({ dir });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(I18nMergeError);
    const problems = (error as I18nMergeError).problems.join('\n');
    expect(problems).toContain('only.fr');
    expect(problems).toContain('other.en');
    expect(partsLeft()).toHaveLength(2);
  });

  it('erreur si une part n\'a pas son équivalent dans l\'autre langue', () => {
    put('parts/lonely.fr.json', { 'lonely.k': 'Seul' });
    expect(() => mergeI18n({ dir })).toThrow(/lonely\.en\.json/);
  });

  it('erreur si les placeholders diffèrent entre fr et en', () => {
    put('parts/a.fr.json', { 'p.k': 'Salut {name}' });
    put('parts/a.en.json', { 'p.k': 'Hello {who}' });
    expect(() => mergeI18n({ dir })).toThrow(/placeholders/);
  });

  it('erreur sur valeur vide, valeur non chaîne ou JSON invalide', () => {
    put('parts/a.fr.json', { 'e.k': '  ', 'n.k': 3 });
    put('parts/a.en.json', '{ pas du json');
    let error: unknown;
    try {
      mergeI18n({ dir });
    } catch (e) {
      error = e;
    }
    const problems = (error as I18nMergeError).problems.join('\n');
    expect(problems).toContain('vide');
    expect(problems).toContain("n'est pas une chaîne");
    expect(problems).toContain('JSON illisible');
  });

  it('erreur claire si fr.json / en.json sont introuvables', () => {
    fs.rmSync(path.join(dir, 'en.json'));
    expect(() => mergeI18n({ dir })).toThrow(/en\.json introuvable/);
  });

  it('parseArgs : --dir, --dry-run, --keep, --help, option inconnue', () => {
    expect(parseArgs([])).toEqual({ dryRun: false, keep: false, help: false });
    expect(parseArgs(['--dry-run', '--keep', '--dir', 'x'])).toEqual({ dir: 'x', dryRun: true, keep: true, help: false });
    expect(parseArgs(['--dir=y']).dir).toBe('y');
    expect(parseArgs(['-h']).help).toBe(true);
    expect(() => parseArgs(['--bogus'])).toThrow(/option inconnue/);
    expect(() => parseArgs(['--dir'])).toThrow(/--dir/);
  });
});
