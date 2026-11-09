/**
 * Réglage de la musique : « Musique » activée / désactivée + volume 0..100 % par pas de 10, mémorisés dans `localStorage`
 * (clé VERSIONNÉE `vaelorn.music.v1`, JSON `{ v: 1, enabled, volume }`).
 *
 * Lecture TOLÉRANTE : valeur absente, JSON illisible, type inattendu, volume hors bornes, stockage indisponible ou qui lève : chaque
 * champ retombe sur sa valeur par défaut (ou est ramené dans [0, 100] au pas de 10), sans exception.
 *
 * Paramètre d'URL de dev `?music=0|1` : force « désactivée » / « activée » SANS toucher au stockage (`setOverride`). Un changement fait
 * ensuite dans le menu sur la ligne « Musique » (activée / désactivée) l'emporte sur le forçage (le joueur a la main) ; un simple
 * changement de VOLUME ne le lève pas.
 */

/** Clé `localStorage` du réglage de musique (le numéro de version de schéma est aussi DANS la donnée). */
export const MUSIC_SETTINGS_KEY = 'vaelorn.music.v1';
/** Version du schéma de la donnée sérialisée. */
export const MUSIC_SETTINGS_VERSION = 1;
/** Pas du volume (%). */
export const MUSIC_VOLUME_STEP = 10;

export interface MusicSettings {
  enabled: boolean;
  /** 0..100, multiple de 10. */
  volume: number;
}

/** Réglage par défaut : musique activée, volume 60 % (modeste : les effets sonores ne doivent pas être couverts). */
export const DEFAULT_MUSIC_SETTINGS: Readonly<MusicSettings> = Object.freeze({ enabled: true, volume: 60 });

/** Stockage minimal (compatible `localStorage`). */
export interface MusicStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Volume ramené dans [0, 100] au pas de 10 ; toute valeur non numérique / non finie retourne `fallback`. */
export function normalizeVolume(value: unknown, fallback: number = DEFAULT_MUSIC_SETTINGS.volume): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const stepped = Math.round(value / MUSIC_VOLUME_STEP) * MUSIC_VOLUME_STEP;
  return Math.max(0, Math.min(100, stepped));
}

/** Volume après un pas (+1 / −1), borné (pas de repli : 100 + 1 pas = 100, 0 − 1 pas = 0). */
export function stepVolume(volume: number, direction: 1 | -1): number {
  return normalizeVolume(normalizeVolume(volume) + direction * MUSIC_VOLUME_STEP, DEFAULT_MUSIC_SETTINGS.volume);
}

/** Relit un réglage sérialisé (valeur NON FIABLE). Ne lève jamais ; retourne toujours un réglage valide. */
export function parseMusicSettings(raw: unknown): MusicSettings {
  const out: MusicSettings = { ...DEFAULT_MUSIC_SETTINGS };
  if (typeof raw !== 'string' || raw.length === 0) return out;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return out;
  const o = data as Record<string, unknown>;
  if (o.v !== undefined && o.v !== MUSIC_SETTINGS_VERSION) return out; // schéma futur / inconnu : défauts
  if (typeof o.enabled === 'boolean') out.enabled = o.enabled;
  out.volume = normalizeVolume(o.volume, out.volume);
  return out;
}

/** Sérialise un réglage (normalisé). */
export function serializeMusicSettings(s: MusicSettings): string {
  return JSON.stringify({ v: MUSIC_SETTINGS_VERSION, enabled: s.enabled === true, volume: normalizeVolume(s.volume) });
}

/** Paramètre d'URL `?music=0|1` (aussi off/on, false/true) : `false` / `true` pour forcer, `null` si absent ou illisible. */
export function parseMusicParam(search: string): boolean | null {
  try {
    const v = new URLSearchParams(search).get('music');
    if (v === null) return null;
    const s = v.trim().toLowerCase();
    if (s === '1' || s === 'on' || s === 'true') return true;
    if (s === '0' || s === 'off' || s === 'false') return false;
    return null;
  } catch {
    return null;
  }
}

/** Stockage du navigateur, ou null (accès impossible : mode privé, stockage bloqué…). */
function browserStorage(): MusicStorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Dépôt du réglage : lecture paresseuse, écriture tolérante, abonnés. `getStorage` est rappelé à chaque accès (injectable en test).
 */
export class MusicSettingsStore {
  private current: MusicSettings | null = null;
  private override: boolean | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly getStorage: () => MusicStorageLike | null = browserStorage) {}

  /** Réglage mémorisé (sans le forçage d'URL). */
  get(): MusicSettings {
    if (!this.current) this.current = this.load();
    return { ...this.current };
  }

  /** Réglage EFFECTIF : le forçage d'URL (`?music=0|1`) l'emporte sur « activée ». */
  effective(): MusicSettings {
    const s = this.get();
    return this.override === null ? s : { ...s, enabled: this.override };
  }

  /** Force « activée » / « désactivée » sans toucher au stockage ; `null` retire le forçage. */
  setOverride(value: boolean | null): void {
    if (this.override === value) return;
    this.override = value;
    this.emit();
  }

  /** Modifie et mémorise (le forçage d'URL n'est levé que si `enabled` change : le choix explicite du joueur prime, pas un réglage de volume). */
  update(patch: Partial<MusicSettings>): void {
    const cur = this.get();
    const next: MusicSettings = {
      enabled: typeof patch.enabled === 'boolean' ? patch.enabled : cur.enabled,
      volume: patch.volume === undefined ? cur.volume : normalizeVolume(patch.volume, cur.volume),
    };
    this.current = next;
    if (typeof patch.enabled === 'boolean') this.override = null;
    this.save(next);
    this.emit();
  }

  /** S'abonne aux changements (réglage ou forçage) ; retourne le désabonnement. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Relit le stockage (tests). */
  reload(): void {
    this.current = null;
    this.emit();
  }

  private load(): MusicSettings {
    try {
      return parseMusicSettings(this.getStorage()?.getItem(MUSIC_SETTINGS_KEY));
    } catch {
      return { ...DEFAULT_MUSIC_SETTINGS };
    }
  }

  private save(s: MusicSettings): void {
    try {
      this.getStorage()?.setItem(MUSIC_SETTINGS_KEY, serializeMusicSettings(s));
    } catch {
      /* stockage indisponible ou plein : le réglage reste valable pour la session */
    }
  }

  private emit(): void {
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch {
        /* un abonné défaillant ne bloque pas les autres */
      }
    }
  }
}

/** Réglage de musique de l'application (singleton). */
export const musicSettings = new MusicSettingsStore();
