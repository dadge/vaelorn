import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MUSIC_SETTINGS,
  MUSIC_SETTINGS_KEY,
  MusicSettingsStore,
  normalizeVolume,
  parseMusicParam,
  parseMusicSettings,
  serializeMusicSettings,
  stepVolume,
  type MusicStorageLike,
} from './musicSettings';

/** Stockage mémoire. */
function memoryStorage(initial: Record<string, string> = {}): MusicStorageLike & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

describe('réglage de la musique : lecture tolérante', () => {
  it('valeur absente → défauts (activée, 60 %)', () => {
    expect(parseMusicSettings(null)).toEqual(DEFAULT_MUSIC_SETTINGS);
    expect(parseMusicSettings(undefined)).toEqual(DEFAULT_MUSIC_SETTINGS);
    expect(parseMusicSettings('')).toEqual(DEFAULT_MUSIC_SETTINGS);
    expect(DEFAULT_MUSIC_SETTINGS).toEqual({ enabled: true, volume: 60 });
  });

  it('JSON corrompu ou de mauvais type → défauts, sans exception', () => {
    for (const raw of ['{', 'nope', '[]', '42', 'null', '"x"', '{"enabled":', 12, {}, true]) {
      expect(() => parseMusicSettings(raw)).not.toThrow();
      expect(parseMusicSettings(raw)).toEqual(DEFAULT_MUSIC_SETTINGS);
    }
  });

  it('champs invalides remplacés un par un par leur défaut', () => {
    expect(parseMusicSettings('{"v":1,"enabled":"oui","volume":30}')).toEqual({ enabled: true, volume: 30 });
    expect(parseMusicSettings('{"v":1,"enabled":false,"volume":"fort"}')).toEqual({ enabled: false, volume: 60 });
    expect(parseMusicSettings('{"v":1,"enabled":false}')).toEqual({ enabled: false, volume: 60 });
    expect(parseMusicSettings('{"v":1,"volume":null,"enabled":null}')).toEqual(DEFAULT_MUSIC_SETTINGS);
  });

  it('volume hors bornes ramené dans [0, 100] au pas de 10', () => {
    expect(parseMusicSettings('{"v":1,"enabled":true,"volume":150}').volume).toBe(100);
    expect(parseMusicSettings('{"v":1,"enabled":true,"volume":-20}').volume).toBe(0);
    expect(parseMusicSettings('{"v":1,"enabled":true,"volume":34}').volume).toBe(30);
    expect(parseMusicSettings('{"v":1,"enabled":true,"volume":35}').volume).toBe(40);
    expect(normalizeVolume(Number.NaN)).toBe(60);
    expect(normalizeVolume(Number.POSITIVE_INFINITY)).toBe(60);
    expect(normalizeVolume('70', 10)).toBe(10);
  });

  it('version de schéma inconnue → défauts ; absence de version tolérée', () => {
    expect(parseMusicSettings('{"v":2,"enabled":false,"volume":10}')).toEqual(DEFAULT_MUSIC_SETTINGS);
    expect(parseMusicSettings('{"enabled":false,"volume":10}')).toEqual({ enabled: false, volume: 10 });
  });

  it('aller-retour : sérialisation puis lecture', () => {
    for (const s of [
      { enabled: true, volume: 100 },
      { enabled: false, volume: 0 },
      { enabled: false, volume: 70 },
    ]) {
      expect(parseMusicSettings(serializeMusicSettings(s))).toEqual(s);
    }
    expect(JSON.parse(serializeMusicSettings({ enabled: true, volume: 44 }))).toEqual({ v: 1, enabled: true, volume: 40 });
  });

  it('stepVolume : pas de 10, borné sans repli', () => {
    expect(stepVolume(60, 1)).toBe(70);
    expect(stepVolume(60, -1)).toBe(50);
    expect(stepVolume(100, 1)).toBe(100);
    expect(stepVolume(0, -1)).toBe(0);
    expect(stepVolume(55, 1)).toBe(70); // 55 → 60 puis +10
  });
});

describe('réglage de la musique : stockage', () => {
  it('la clé est versionnée', () => {
    expect(MUSIC_SETTINGS_KEY).toBe('vaelorn.music.v1');
  });

  it('lit le stockage au premier accès et écrit à chaque changement', () => {
    const storage = memoryStorage({ [MUSIC_SETTINGS_KEY]: '{"v":1,"enabled":false,"volume":30}' });
    const store = new MusicSettingsStore(() => storage);
    expect(store.get()).toEqual({ enabled: false, volume: 30 });
    store.update({ volume: 80 });
    expect(JSON.parse(storage.data[MUSIC_SETTINGS_KEY])).toEqual({ v: 1, enabled: false, volume: 80 });
    store.update({ enabled: true });
    expect(store.get()).toEqual({ enabled: true, volume: 80 });
  });

  it('stockage vide ou corrompu : défauts', () => {
    expect(new MusicSettingsStore(() => memoryStorage()).get()).toEqual(DEFAULT_MUSIC_SETTINGS);
    expect(new MusicSettingsStore(() => memoryStorage({ [MUSIC_SETTINGS_KEY]: '###' })).get()).toEqual(DEFAULT_MUSIC_SETTINGS);
  });

  it('stockage indisponible (null) : défauts, le réglage reste valable pour la session', () => {
    const store = new MusicSettingsStore(() => null);
    expect(store.get()).toEqual(DEFAULT_MUSIC_SETTINGS);
    store.update({ enabled: false, volume: 20 });
    expect(store.get()).toEqual({ enabled: false, volume: 20 });
  });

  it('stockage qui lève (lecture comme écriture) : aucune exception', () => {
    const throwing: MusicStorageLike = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    const store = new MusicSettingsStore(() => throwing);
    expect(store.get()).toEqual(DEFAULT_MUSIC_SETTINGS);
    expect(() => store.update({ volume: 10 })).not.toThrow();
    expect(store.get().volume).toBe(10);
    const store2 = new MusicSettingsStore(() => {
      throw new Error('accès au stockage interdit');
    });
    expect(store2.get()).toEqual(DEFAULT_MUSIC_SETTINGS);
    expect(() => store2.update({ enabled: false })).not.toThrow();
  });

  it('une valeur de volume hors bornes passée à update est ramenée dans les bornes', () => {
    const store = new MusicSettingsStore(() => memoryStorage());
    store.update({ volume: 999 });
    expect(store.get().volume).toBe(100);
    store.update({ volume: Number.NaN });
    expect(store.get().volume).toBe(100); // NaN ignoré : on garde la valeur précédente
  });

  it('les abonnés sont prévenus ; un abonné qui lève ne bloque pas les autres ; désabonnement', () => {
    const store = new MusicSettingsStore(() => memoryStorage());
    const a = vi.fn(() => {
      throw new Error('abonné défaillant');
    });
    const b = vi.fn();
    store.subscribe(a);
    const off = store.subscribe(b);
    store.update({ volume: 40 });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    off();
    store.update({ volume: 50 });
    expect(b).toHaveBeenCalledTimes(1);
  });
});

describe('paramètre d\'URL ?music=0|1', () => {
  it('lecture : 0 / 1 (et off / on / false / true), sinon null', () => {
    expect(parseMusicParam('?music=0')).toBe(false);
    expect(parseMusicParam('?music=1')).toBe(true);
    expect(parseMusicParam('?quick=1&music=off')).toBe(false);
    expect(parseMusicParam('?music=ON')).toBe(true);
    expect(parseMusicParam('?music=true')).toBe(true);
    expect(parseMusicParam('?music=false')).toBe(false);
    expect(parseMusicParam('')).toBeNull();
    expect(parseMusicParam('?music=')).toBeNull();
    expect(parseMusicParam('?music=2')).toBeNull();
    expect(parseMusicParam('?lang=en')).toBeNull();
  });

  it('le forçage change le réglage effectif SANS toucher au stockage ; un choix du joueur le lève', () => {
    const storage = memoryStorage({ [MUSIC_SETTINGS_KEY]: '{"v":1,"enabled":true,"volume":50}' });
    const store = new MusicSettingsStore(() => storage);
    const before = JSON.stringify(storage.data);
    const listener = vi.fn();
    store.subscribe(listener);
    store.setOverride(false);
    expect(store.effective()).toEqual({ enabled: false, volume: 50 });
    expect(store.get().enabled).toBe(true);
    expect(JSON.stringify(storage.data)).toBe(before);
    expect(listener).toHaveBeenCalledTimes(1);
    store.setOverride(true);
    expect(store.effective().enabled).toBe(true);
    store.setOverride(false);
    store.update({ enabled: true }); // le joueur réactive dans le menu : le forçage est levé
    expect(store.effective().enabled).toBe(true);
    store.setOverride(null);
    expect(store.effective()).toEqual(store.get());
  });

  it('un simple changement de VOLUME ne lève pas le forçage ?music=0 (la musique ne démarre pas)', () => {
    const storage = memoryStorage({ [MUSIC_SETTINGS_KEY]: '{"v":1,"enabled":true,"volume":50}' });
    const store = new MusicSettingsStore(() => storage);
    store.setOverride(false);
    store.update({ volume: 70 });
    expect(store.effective()).toEqual({ enabled: false, volume: 70 });
    expect(store.get()).toEqual({ enabled: true, volume: 70 }); // le volume est bien mémorisé
    store.update({ enabled: true }); // la ligne « Musique » : le joueur reprend la main
    expect(store.effective().enabled).toBe(true);
  });
});
