import { describe, expect, it, vi } from 'vitest';
import { AutoSaver } from './autoSave';
import { ROOM_CLEAR_DELAY_MS, SIM_STEP_MS, WIPE_RESTART_DELAY_MS } from './constants';
import { makeTestLevel, makeTestRoom } from './levelValidation';
import {
  SAVE_ERROR_REASONS,
  SAVE_SCHEMA_VERSION,
  applySimEvents,
  buildResumeSimConfig,
  describeResume,
  migrateSave,
  newGameSave,
  parseSave,
  playersOfSave,
  saveContextFromLevels,
  serializeSave,
  validateSave,
  withLevelCompleted,
  withRoomReached,
  type SaveContext,
  type SaveGame,
} from './save';
import {
  LocalStorageSaveRepository,
  MemorySaveRepository,
  SAVE_STORAGE_KEY,
  classifyStorageError,
  type StorageLike,
} from './saveRepository';
import { createSimulation, resolveStartRoomIndex } from './simulation';
import type { LevelDef, PlayerSetup, SimEvent } from './types';
import { LEVELS } from '../levels';

// ───────────────────────────── Fixtures ─────────────────────────────

const CTX: SaveContext = {
  levels: [
    { id: 'level1', roomCount: 5 },
    { id: 'level2', roomCount: 6 },
    { id: 'level3', roomCount: 8 },
  ],
};

const SETUPS: PlayerSetup[] = [
  { id: 0, characterId: 'david', difficulty: 2 },
  { id: 1, characterId: 'sandrine', difficulty: 1 },
];

function save(over: Partial<SaveGame> = {}): SaveGame {
  return {
    schemaVersion: SAVE_SCHEMA_VERSION,
    levelId: 'level2',
    roomIndex: 2,
    players: [
      { characterId: 'david', difficulty: 2 },
      { characterId: 'sandrine', difficulty: 1 },
    ],
    completedLevelIds: ['level1'],
    ...over,
  };
}

/** Faux localStorage en mémoire (les erreurs sont injectables). */
function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map<string, string>(Object.entries(initial));
  const storage = {
    data,
    failSet: null as Error | null,
    failGet: null as Error | null,
    failRemove: null as Error | null,
    getItem(k: string): string | null {
      if (storage.failGet) throw storage.failGet;
      return data.has(k) ? (data.get(k) as string) : null;
    },
    setItem(k: string, v: string): void {
      if (storage.failSet) throw storage.failSet;
      data.set(k, v);
    },
    removeItem(k: string): void {
      if (storage.failRemove) throw storage.failRemove;
      data.delete(k);
    },
  };
  return storage;
}

function quotaError(): Error {
  return Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError', code: 22 });
}

const roomEntered = (roomIndex: number, reason: 'start' | 'next' | 'restart'): SimEvent => ({
  type: 'roomEntered',
  roomId: `r${roomIndex + 1}`,
  roomIndex,
  reason,
});

// ───────────────────────────── Sérialisation / désérialisation ─────────────────────────────

describe('sérialisation et désérialisation', () => {
  it('aller-retour sans perte, avec la version de schéma courante', () => {
    const s = save({ completedLevelIds: ['level1', 'level2'] });
    const raw = serializeSave(s);
    expect(JSON.parse(raw).schemaVersion).toBe(SAVE_SCHEMA_VERSION);
    const res = parseSave(raw, CTX);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.save).toEqual(s);
      expect(res.migratedFrom).toBeNull();
    }
  });

  it('la sauvegarde est du JSON pur (aucune classe ni fonction)', () => {
    const s = newGameSave(SETUPS, 'level1');
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });

  it("newGameSave : première salle, aucun niveau terminé, équipe figée (id = indice, tri par id)", () => {
    const s = newGameSave([SETUPS[1], SETUPS[0]], 'level2');
    expect(s).toEqual({
      schemaVersion: SAVE_SCHEMA_VERSION,
      levelId: 'level2',
      roomIndex: 0,
      players: [
        { characterId: 'david', difficulty: 2 },
        { characterId: 'sandrine', difficulty: 1 },
      ],
      completedLevelIds: [],
    });
    expect(playersOfSave(s)).toEqual(SETUPS);
  });

  it('ignore les champs inconnus et déduplique les niveaux terminés', () => {
    const raw = JSON.stringify({ ...save({ completedLevelIds: ['level1', 'level1'] }), extra: { x: 1 } });
    const res = parseSave(raw, CTX);
    expect(res.ok && res.save).toEqual(save({ completedLevelIds: ['level1'] }));
  });

  it('describeResume : numéros 1-based (Niveau 2 — Salle 3)', () => {
    expect(describeResume(save(), CTX)).toEqual({ levelId: 'level2', level: 2, room: 3, roomCount: 6, playerCount: 2 });
    expect(describeResume(save({ levelId: 'inconnu' }), CTX)).toBeNull();
  });

  it('saveContextFromLevels : identifiants et nombre de salles réels', () => {
    const ctx = saveContextFromLevels(LEVELS);
    expect(ctx.levels.map((l) => l.id)).toEqual(LEVELS.map((l) => l.id));
    expect(ctx.levels[0].roomCount).toBe(LEVELS[0].rooms.length);
  });
});

// ───────────────────────────── Sauvegardes corrompues ─────────────────────────────

describe('sauvegarde corrompue : jamais d’exception, cause explicite', () => {
  function reasonOf(raw: string): string | null {
    const res = parseSave(raw, CTX);
    return res.ok ? null : res.error.reason;
  }
  const base = (): Record<string, unknown> => JSON.parse(serializeSave(save())) as Record<string, unknown>;

  it('JSON invalide, vide ou tronqué', () => {
    expect(reasonOf('')).toBe('invalidJson');
    expect(reasonOf('{pas du json')).toBe('invalidJson');
    expect(reasonOf(serializeSave(save()).slice(0, 20))).toBe('invalidJson');
  });

  it("JSON valide mais pas un objet : null, tableau, nombre, chaîne", () => {
    for (const raw of ['null', '[]', '42', '"texte"', 'true']) expect(reasonOf(raw)).toBe('notAnObject');
  });

  it('champs manquants', () => {
    for (const field of ['levelId', 'roomIndex', 'players', 'completedLevelIds']) {
      const data = base();
      delete data[field];
      const res = parseSave(JSON.stringify(data), CTX);
      expect(res.ok, field).toBe(false);
      if (!res.ok) {
        expect(res.error.reason).toBe('missingField');
        expect(res.error.field).toBe(field);
      }
    }
  });

  it('champs manquants dans un joueur (personnage, difficulté)', () => {
    const noChar = base();
    noChar.players = [{ difficulty: 2 }];
    expect(reasonOf(JSON.stringify(noChar))).toBe('missingField');
    const noDiff = base();
    noDiff.players = [{ characterId: 'david' }];
    expect(reasonOf(JSON.stringify(noDiff))).toBe('missingField');
  });

  it('types invalides', () => {
    const cases: Array<[string, unknown]> = [
      ['levelId', 12],
      ['roomIndex', '2'],
      ['roomIndex', 1.5],
      ['roomIndex', -1],
      ['players', 'david'],
      ['completedLevelIds', 'level1'],
    ];
    for (const [field, value] of cases) {
      const data = base();
      data[field] = value;
      expect(reasonOf(JSON.stringify(data)), `${field}=${String(value)}`).toBe('invalidField');
    }
    const badDiff = base();
    badDiff.players = [{ characterId: 'david', difficulty: 4 }];
    expect(reasonOf(JSON.stringify(badDiff))).toBe('invalidField');
    const badPlayer = base();
    badPlayer.players = ['david'];
    expect(reasonOf(JSON.stringify(badPlayer))).toBe('invalidField');
    const badCompleted = base();
    badCompleted.completedLevelIds = [3];
    expect(reasonOf(JSON.stringify(badCompleted))).toBe('invalidField');
  });

  it('version inconnue (négative, fractionnaire, non numérique) ou FUTURE', () => {
    for (const v of [-1, 1.5, 'deux', null]) {
      const data = base();
      data.schemaVersion = v;
      expect(reasonOf(JSON.stringify(data)), `version ${String(v)}`).toBe('unknownVersion');
    }
    for (const v of [SAVE_SCHEMA_VERSION + 1, 99]) {
      const data = base();
      data.schemaVersion = v;
      expect(reasonOf(JSON.stringify(data)), `version ${v}`).toBe('futureVersion');
    }
  });

  it('personnage inconnu, doublon, nombre de joueurs invalide', () => {
    const unknown = base();
    unknown.players = [{ characterId: 'gandalf', difficulty: 2 }];
    expect(reasonOf(JSON.stringify(unknown))).toBe('unknownCharacter');
    const proto = base();
    proto.players = [{ characterId: 'constructor', difficulty: 2 }];
    expect(reasonOf(JSON.stringify(proto))).toBe('unknownCharacter');
    const dup = base();
    dup.players = [
      { characterId: 'david', difficulty: 2 },
      { characterId: 'david', difficulty: 3 },
    ];
    expect(reasonOf(JSON.stringify(dup))).toBe('duplicateCharacter');
    const none = base();
    none.players = [];
    expect(reasonOf(JSON.stringify(none))).toBe('invalidPlayers');
    const five = base();
    five.players = ['david', 'sandrine', 'romain', 'valentine', 'aelith'].map((characterId) => ({ characterId, difficulty: 2 }));
    expect(reasonOf(JSON.stringify(five))).toBe('invalidPlayers');
  });

  it('niveau inconnu (reprise ou niveau terminé) et salle hors plage', () => {
    const lvl = base();
    lvl.levelId = 'level99';
    expect(reasonOf(JSON.stringify(lvl))).toBe('unknownLevel');
    const done = base();
    done.completedLevelIds = ['level99'];
    expect(reasonOf(JSON.stringify(done))).toBe('unknownLevel');
    const room = base();
    room.roomIndex = 6; // level2 a 6 salles : indices 0..5
    expect(reasonOf(JSON.stringify(room))).toBe('invalidRoom');
    const proto = base();
    proto.levelId = '__proto__';
    expect(reasonOf(JSON.stringify(proto))).toBe('unknownLevel');
  });

  it('validateSave refuse un objet de version courante mal formé sans exception', () => {
    expect(validateSave(undefined, CTX).ok).toBe(false);
    expect(validateSave({ schemaVersion: SAVE_SCHEMA_VERSION }, CTX).ok).toBe(false);
  });

  it('toutes les causes sont énumérées (couverture i18n dans saveMenuLogic.test.ts)', () => {
    expect(new Set(SAVE_ERROR_REASONS).size).toBe(SAVE_ERROR_REASONS.length);
  });
});

// ───────────────────────────── Migrations ─────────────────────────────

describe('migrations des anciennes versions', () => {
  const v0 = {
    level: 2, // numéro de niveau 1-based
    room: 3,
    chars: ['david', 'sandrine'],
    diffs: [2, 1],
    done: [1],
  };
  const v1 = {
    schemaVersion: 1,
    levelIndex: 1,
    roomIndex: 3,
    players: [
      { characterId: 'david', difficulty: 2 },
      { characterId: 'sandrine', difficulty: 1 },
    ],
    completedLevelIndices: [0],
  };
  const expected = save({ levelId: 'level2', roomIndex: 3, completedLevelIds: ['level1'] });

  it('v0 (prototype sans schemaVersion) → version courante', () => {
    const res = migrateSave(v0, CTX);
    expect(res).toEqual({ ok: true, save: expected, migratedFrom: 0 });
    const viaString = parseSave(JSON.stringify(v0), CTX);
    expect(viaString.ok && viaString.save).toEqual(expected);
  });

  it('v1 (références par indice) → version courante (indices → identifiants)', () => {
    const res = migrateSave(v1, CTX);
    expect(res).toEqual({ ok: true, save: expected, migratedFrom: 1 });
  });

  it('v1 : la migration suit l’ordre du contexte (niveau inséré avant → autre identifiant)', () => {
    const ctx2: SaveContext = { levels: [{ id: 'intro', roomCount: 2 }, ...CTX.levels] };
    const res = migrateSave({ ...v1, levelIndex: 2, completedLevelIndices: [0, 1] }, ctx2);
    expect(res.ok && res.save.levelId).toBe('level2');
    expect(res.ok && res.save.completedLevelIds).toEqual(['intro', 'level1']);
  });

  it('v0 : difficulté absente → 2 (normal), sans niveaux terminés', () => {
    const res = migrateSave({ level: 1, room: 0, chars: ['romain'] }, CTX);
    expect(res.ok && res.save.players).toEqual([{ characterId: 'romain', difficulty: 2 }]);
    expect(res.ok && res.save.completedLevelIds).toEqual([]);
  });

  it('une migration ne laisse jamais passer une donnée invalide (niveau inconnu, personnage inconnu)', () => {
    expect(migrateSave({ ...v0, level: 9 }, CTX).ok).toBe(false);
    expect(migrateSave({ ...v1, levelIndex: 7 }, CTX)).toMatchObject({ ok: false, error: { reason: 'unknownLevel' } });
    expect(migrateSave({ ...v1, completedLevelIndices: [5] }, CTX)).toMatchObject({ ok: false, error: { reason: 'unknownLevel' } });
    expect(migrateSave({ ...v0, chars: ['gandalf'] }, CTX)).toMatchObject({ ok: false, error: { reason: 'unknownCharacter' } });
    expect(migrateSave({ ...v0, room: 99 }, CTX)).toMatchObject({ ok: false, error: { reason: 'invalidRoom' } });
  });

  it('une v0 / v1 incomplète est refusée proprement (champ manquant / invalide)', () => {
    expect(migrateSave({ level: 1, room: 0 }, CTX)).toMatchObject({ ok: false, error: { reason: 'missingField', field: 'chars' } });
    expect(migrateSave({}, CTX)).toMatchObject({ ok: false, error: { reason: 'missingField' } });
    expect(migrateSave({ level: 'x', room: 0, chars: [] }, CTX)).toMatchObject({ ok: false, error: { reason: 'invalidField', field: 'level' } });
    expect(migrateSave({ schemaVersion: 1, levelIndex: 0 }, CTX)).toMatchObject({ ok: false, error: { reason: 'missingField' } });
  });

  it('une sauvegarde déjà à la version courante n’est pas marquée « migrée »', () => {
    const res = migrateSave(JSON.parse(serializeSave(expected)), CTX);
    expect(res.ok && res.migratedFrom).toBeNull();
  });

  it('le repository relit une ancienne version sans réécrire le stockage ; la prochaine écriture passe en version courante', () => {
    const storage = fakeStorage({ [SAVE_STORAGE_KEY]: JSON.stringify(v1) });
    const repo = new LocalStorageSaveRepository(CTX, storage);
    const loaded = repo.load();
    expect(loaded).toMatchObject({ status: 'ok', migratedFrom: 1 });
    expect(storage.data.get(SAVE_STORAGE_KEY)).toBe(JSON.stringify(v1));
    if (loaded.status === 'ok') {
      expect(repo.save(loaded.save)).toEqual({ ok: true });
      expect(JSON.parse(storage.data.get(SAVE_STORAGE_KEY) as string).schemaVersion).toBe(SAVE_SCHEMA_VERSION);
    }
  });
});

// ───────────────────────────── Mises à jour de la sauvegarde ─────────────────────────────

describe('mise à jour : salle atteinte / niveau terminé / événements', () => {
  it('withRoomReached : met à jour niveau + salle ; même référence si inchangé ou invalide', () => {
    const s = save({ levelId: 'level1', roomIndex: 1 });
    expect(withRoomReached(s, 'level1', 2, CTX)).toEqual({ ...s, roomIndex: 2 });
    expect(withRoomReached(s, 'level1', 1, CTX)).toBe(s);
    expect(withRoomReached(s, 'level1', 5, CTX)).toBe(s); // hors plage
    expect(withRoomReached(s, 'level1', -1, CTX)).toBe(s);
    expect(withRoomReached(s, 'inconnu', 0, CTX)).toBe(s);
    expect(withRoomReached(s, 'level2', 0, CTX)).toMatchObject({ levelId: 'level2', roomIndex: 0 });
  });

  it('withRoomReached ne modifie pas l’objet d’origine (immuable)', () => {
    const s = save();
    const frozen = JSON.stringify(s);
    withRoomReached(s, 'level2', 4, CTX);
    withLevelCompleted(s, 'level2', CTX);
    expect(JSON.stringify(s)).toBe(frozen);
  });

  it('withLevelCompleted : niveau ajouté, reprise = SALLE 0 du niveau suivant', () => {
    const s = save({ levelId: 'level1', roomIndex: 4, completedLevelIds: [] });
    const done = withLevelCompleted(s, 'level1', CTX);
    expect(done.completedLevelIds).toEqual(['level1']);
    expect(done.levelId).toBe('level2');
    expect(done.roomIndex).toBe(0);
    const done2 = withLevelCompleted(done, 'level2', CTX);
    expect(done2.completedLevelIds).toEqual(['level1', 'level2']);
    expect(done2).toMatchObject({ levelId: 'level3', roomIndex: 0 });
  });

  it('withLevelCompleted : dernier niveau → la reprise reste sur ce niveau (salle 0) ; idempotent', () => {
    const s = save({ levelId: 'level3', roomIndex: 7, completedLevelIds: ['level1', 'level2'] });
    const done = withLevelCompleted(s, 'level3', CTX);
    expect(done).toMatchObject({ levelId: 'level3', roomIndex: 0, completedLevelIds: ['level1', 'level2', 'level3'] });
    expect(withLevelCompleted(done, 'level3', CTX)).toBe(done);
    expect(withLevelCompleted(s, 'inconnu', CTX)).toBe(s);
  });

  it('applySimEvents : start et next mettent à jour ; restart est IGNORÉ ; autres événements ignorés', () => {
    const s = save({ levelId: 'level2', roomIndex: 0 });
    expect(applySimEvents(s, 'level2', [roomEntered(1, 'next')], CTX).roomIndex).toBe(1);
    expect(applySimEvents(s, 'level2', [roomEntered(3, 'start')], CTX).roomIndex).toBe(3);
    const restarted = applySimEvents(save({ roomIndex: 3 }), 'level2', [{ type: 'teamWipe' }, roomEntered(0, 'restart')], CTX);
    expect(restarted).toEqual(save({ roomIndex: 3 }));
    expect(applySimEvents(s, 'level2', [{ type: 'roomCleared', roomId: 'r1' }], CTX)).toBe(s);
  });

  it('applySimEvents : fin de niveau puis début du niveau suivant, dans un même lot', () => {
    const s = save({ levelId: 'level1', roomIndex: 4, completedLevelIds: [] });
    const res = applySimEvents(s, 'level1', [{ type: 'levelCompleted', levelId: 'level1' }], CTX);
    expect(res).toMatchObject({ levelId: 'level2', roomIndex: 0, completedLevelIds: ['level1'] });
    // le « start » du niveau suivant (salle 0) ne change plus rien
    expect(applySimEvents(res, 'level2', [roomEntered(0, 'start')], CTX)).toBe(res);
  });
});

// ───────────────────────────── Stockage ─────────────────────────────

describe('LocalStorageSaveRepository', () => {
  it('load : rien → none ; sauvegarde valide → ok', () => {
    const storage = fakeStorage();
    const repo = new LocalStorageSaveRepository(CTX, storage);
    expect(repo.load()).toEqual({ status: 'none' });
    expect(repo.save(save())).toEqual({ ok: true });
    expect(storage.data.has(SAVE_STORAGE_KEY)).toBe(true);
    expect(repo.load()).toEqual({ status: 'ok', save: save(), migratedFrom: null });
  });

  it('la clé de stockage documentée est « vaelorn.save »', () => {
    expect(SAVE_STORAGE_KEY).toBe('vaelorn.save');
  });

  it('NE SUPPRIME RIEN sans confirmation : corrompue, version future ou inconnue → donnée brute conservée à l’octet près', () => {
    const rawCases = [
      '{pas du json',
      '',
      JSON.stringify({ ...save(), schemaVersion: 99 }),
      JSON.stringify({ ...save(), schemaVersion: 'x' }),
      JSON.stringify({ ...save(), levelId: 'level99' }),
      JSON.stringify({ ...save(), players: [{ characterId: 'gandalf', difficulty: 2 }] }),
      JSON.stringify({ levelId: 'level2' }),
    ];
    for (const raw of rawCases) {
      const storage = fakeStorage({ [SAVE_STORAGE_KEY]: raw });
      const remove = vi.spyOn(storage, 'removeItem');
      const set = vi.spyOn(storage, 'setItem');
      const repo = new LocalStorageSaveRepository(CTX, storage);
      const res = repo.load();
      expect(res.status, raw).toBe('corrupt');
      repo.load(); // plusieurs lectures
      expect(storage.data.get(SAVE_STORAGE_KEY), raw).toBe(raw);
      expect(remove).not.toHaveBeenCalled();
      expect(set).not.toHaveBeenCalled();
    }
  });

  it('clear() supprime seulement quand on l’appelle explicitement', () => {
    const storage = fakeStorage({ [SAVE_STORAGE_KEY]: '{corrompu' });
    const repo = new LocalStorageSaveRepository(CTX, storage);
    expect(repo.load().status).toBe('corrupt');
    expect(storage.data.has(SAVE_STORAGE_KEY)).toBe(true);
    expect(repo.clear()).toEqual({ ok: true });
    expect(storage.data.has(SAVE_STORAGE_KEY)).toBe(false);
    expect(repo.load()).toEqual({ status: 'none' });
  });

  it('version future : cause explicite et donnée intacte', () => {
    const raw = JSON.stringify({ ...save(), schemaVersion: SAVE_SCHEMA_VERSION + 5 });
    const storage = fakeStorage({ [SAVE_STORAGE_KEY]: raw });
    const res = new LocalStorageSaveRepository(CTX, storage).load();
    expect(res).toMatchObject({ status: 'corrupt', error: { reason: 'futureVersion' } });
    expect(storage.data.get(SAVE_STORAGE_KEY)).toBe(raw);
  });

  it('setItem qui lève (stockage bloqué) : erreur typée, jamais d’exception, ancienne valeur intacte', () => {
    const storage = fakeStorage({ [SAVE_STORAGE_KEY]: serializeSave(save()) });
    const repo = new LocalStorageSaveRepository(CTX, storage);
    storage.failSet = new Error('SecurityError: The operation is insecure.');
    const res = repo.save(save({ roomIndex: 4 }));
    expect(res).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    expect(storage.data.get(SAVE_STORAGE_KEY)).toBe(serializeSave(save()));
  });

  it('quota dépassé : code « quota » (QuotaExceededError, code 22, Firefox)', () => {
    const storage = fakeStorage();
    const repo = new LocalStorageSaveRepository(CTX, storage);
    storage.failSet = quotaError();
    expect(repo.save(save())).toMatchObject({ ok: false, error: { code: 'quota' } });
    storage.failSet = Object.assign(new Error('x'), { name: 'NS_ERROR_DOM_QUOTA_REACHED' });
    expect(repo.save(save())).toMatchObject({ ok: false, error: { code: 'quota' } });
    expect(classifyStorageError(Object.assign(new Error('boom'), { code: 22 })).code).toBe('quota');
    expect(classifyStorageError('chaîne')).toMatchObject({ code: 'unavailable', message: 'chaîne' });
  });

  it('getItem qui lève, ou stockage absent / accesseur qui lève : load → unavailable, sans exception', () => {
    const storage = fakeStorage();
    storage.failGet = new Error('blocked');
    expect(new LocalStorageSaveRepository(CTX, storage).load()).toMatchObject({ status: 'unavailable' });
    expect(new LocalStorageSaveRepository(CTX, () => null).load()).toMatchObject({ status: 'unavailable' });
    expect(new LocalStorageSaveRepository(CTX, () => undefined).save(save())).toMatchObject({ ok: false });
    const throwing = (): StorageLike => {
      throw new Error('accès à localStorage interdit');
    };
    const repo = new LocalStorageSaveRepository(CTX, throwing);
    expect(repo.load()).toMatchObject({ status: 'unavailable' });
    expect(repo.save(save())).toMatchObject({ ok: false });
    expect(repo.clear()).toMatchObject({ ok: false });
  });

  it('removeItem qui lève : clear → erreur, sans exception', () => {
    const storage = fakeStorage({ [SAVE_STORAGE_KEY]: serializeSave(save()) });
    storage.failRemove = new Error('blocked');
    expect(new LocalStorageSaveRepository(CTX, storage).clear()).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    expect(storage.data.has(SAVE_STORAGE_KEY)).toBe(true);
  });

  it('clé personnalisable', () => {
    const storage = fakeStorage();
    const repo = new LocalStorageSaveRepository(CTX, storage, 'autre.cle');
    repo.save(save());
    expect(storage.data.has('autre.cle')).toBe(true);
    expect(storage.data.has(SAVE_STORAGE_KEY)).toBe(false);
  });
});

describe('MemorySaveRepository', () => {
  it('même comportement que le localStorage : none / ok / corrupt conservé / clear', () => {
    const repo = new MemorySaveRepository(CTX);
    expect(repo.load()).toEqual({ status: 'none' });
    repo.save(save());
    expect(repo.load().status).toBe('ok');
    repo.raw = '{cassé';
    expect(repo.load().status).toBe('corrupt');
    expect(repo.raw).toBe('{cassé');
    expect(repo.clear()).toEqual({ ok: true });
    expect(repo.raw).toBeNull();
  });

  it('pannes simulées : écritures en quota, lectures bloquées', () => {
    const repo = new MemorySaveRepository(CTX, { raw: serializeSave(save()), failWrites: { code: 'quota', message: 'plein' } });
    expect(repo.save(save({ roomIndex: 5 }))).toMatchObject({ ok: false, error: { code: 'quota' } });
    expect(repo.raw).toBe(serializeSave(save()));
    const blocked = new MemorySaveRepository(CTX, { failReads: { code: 'unavailable', message: 'bloqué' } });
    expect(blocked.load()).toMatchObject({ status: 'unavailable' });
  });
});

// ───────────────────────────── Reprise ─────────────────────────────

describe('reprise : bon niveau, bonne salle', () => {
  it('resolveStartRoomIndex : défaut 0, bornage, arrondi, valeurs non finies', () => {
    expect(resolveStartRoomIndex(undefined, 5)).toBe(0);
    expect(resolveStartRoomIndex(Number.NaN, 5)).toBe(0);
    expect(resolveStartRoomIndex(Number.POSITIVE_INFINITY, 5)).toBe(0);
    expect(resolveStartRoomIndex(-3, 5)).toBe(0);
    expect(resolveStartRoomIndex(2.9, 5)).toBe(2);
    expect(resolveStartRoomIndex(99, 5)).toBe(4);
    expect(resolveStartRoomIndex(3, 1)).toBe(0);
  });

  const threeRooms = (): LevelDef =>
    makeTestLevel({
      roomCount: 3,
      objectives: [
        { id: 'o_r1', slot: 0, roomId: 'r1', kind: 'mechanism', labelKey: 'objective.test.o0', mechanismId: 'p1' },
        { id: 'o_r2', slot: 1, roomId: 'r2', kind: 'mechanism', labelKey: 'objective.test.o1', mechanismId: 'p1' },
        { id: 'o_r3', slot: 0, roomId: 'r3', kind: 'mechanism', labelKey: 'objective.test.o0', mechanismId: 'p1' },
      ],
    });

  it('startRoomIndex : la simulation démarre dans la bonne salle, émet roomEntered « start », salles précédentes validées', () => {
    const level = threeRooms();
    const sim = createSimulation({ levelId: level.id, players: SETUPS, seed: 5, startRoomIndex: 2 }, level);
    expect(sim.state.roomIndex).toBe(2);
    expect(sim.state.room.roomId).toBe('r3');
    expect(sim.room.id).toBe('r3');
    expect(sim.state.clearedRooms).toEqual(['r1', 'r2']);
    expect(sim.state.phase).toBe('playing');
    const events = sim.step(SIM_STEP_MS, {});
    expect(events.filter((e) => e.type === 'roomEntered')).toEqual([{ type: 'roomEntered', roomId: 'r3', roomIndex: 2, reason: 'start' }]);
    // les joueurs sont sur les points d'apparition de la salle de reprise, PV pleins
    for (const p of sim.state.players) expect(p.hp).toBe(p.maxHp);
  });

  it('objectifs des salles PRÉCÉDENTES considérés accomplis ; ceux de la salle de reprise et des suivantes restent à faire', () => {
    const level = threeRooms();
    const sim = createSimulation({ levelId: level.id, players: SETUPS, seed: 5, startRoomIndex: 1 }, level);
    const byId = Object.fromEntries(sim.state.objectives.map((o) => [o.id, o]));
    expect(byId.o_r1).toMatchObject({ done: true, progress: 1 });
    expect(byId.o_r2.done).toBe(false);
    expect(byId.o_r3.done).toBe(false);
  });

  it('sans startRoomIndex (ou 0, NaN) : comportement historique, salle 0, rien de validé', () => {
    const level = threeRooms();
    for (const start of [undefined, 0, Number.NaN]) {
      const sim = createSimulation({ levelId: level.id, players: SETUPS, seed: 5, startRoomIndex: start }, level);
      expect(sim.state.roomIndex).toBe(0);
      expect(sim.state.clearedRooms).toEqual([]);
      expect(sim.state.objectives.every((o) => !o.done)).toBe(true);
    }
  });

  it('startRoomIndex hors plage : borné (dernière salle), jamais d’exception', () => {
    const level = threeRooms();
    expect(createSimulation({ levelId: level.id, players: SETUPS, seed: 1, startRoomIndex: 99 }, level).state.roomIndex).toBe(2);
    expect(createSimulation({ levelId: level.id, players: SETUPS, seed: 1, startRoomIndex: -4 }, level).state.roomIndex).toBe(0);
  });

  it('une simulation de reprise reste déterministe et sérialisable', () => {
    const level = threeRooms();
    const a = createSimulation({ levelId: level.id, players: SETUPS, seed: 9, startRoomIndex: 2 }, level);
    const b = createSimulation({ levelId: level.id, players: SETUPS, seed: 9, startRoomIndex: 2 }, level);
    for (let i = 0; i < 30; i++) {
      a.step(SIM_STEP_MS, {});
      b.step(SIM_STEP_MS, {});
    }
    expect(a.serialize()).toBe(b.serialize());
    expect(JSON.parse(a.serialize()).roomIndex).toBe(2);
  });

  it('buildResumeSimConfig : équipe, niveau et salle de la sauvegarde ; graine fournie par l’appelant', () => {
    const cfg = buildResumeSimConfig(save({ levelId: 'level3', roomIndex: 5 }), 1234);
    expect(cfg).toEqual({ levelId: 'level3', players: SETUPS, seed: 1234, startRoomIndex: 5 });
  });

  it('avec les VRAIS niveaux : la reprise charge le bon niveau et la bonne salle (équipe et difficultés conservées)', () => {
    const ctx = saveContextFromLevels(LEVELS);
    const level = LEVELS[1];
    const roomIndex = Math.min(3, level.rooms.length - 1);
    const sv: SaveGame = {
      schemaVersion: SAVE_SCHEMA_VERSION,
      levelId: level.id,
      roomIndex,
      players: [
        { characterId: 'brokk', difficulty: 3 },
        { characterId: 'mira', difficulty: 1 },
        { characterId: 'aelith', difficulty: 2 },
      ],
      completedLevelIds: [LEVELS[0].id],
    };
    const reparsed = parseSave(serializeSave(sv), ctx);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    const sim = createSimulation(buildResumeSimConfig(reparsed.save, 42), level);
    expect(sim.state.levelId).toBe(level.id);
    expect(sim.state.roomIndex).toBe(roomIndex);
    expect(sim.room.id).toBe(level.rooms[roomIndex].id);
    expect(sim.state.playerCount).toBe(3);
    expect(sim.state.players.map((p) => [p.characterId, p.difficulty])).toEqual([
      ['brokk', 3],
      ['mira', 1],
      ['aelith', 2],
    ]);
    expect(sim.state.clearedRooms).toEqual(level.rooms.slice(0, roomIndex).map((r) => r.id));
  });
});

// ───────────────────────────── AutoSaver ─────────────────────────────

describe('AutoSaver : sauvegarde au début de salle et à la fin de niveau', () => {
  function make(over: Partial<ConstructorParameters<typeof AutoSaver>[0]> = {}) {
    const repo = new MemorySaveRepository(CTX);
    const autoSaver = new AutoSaver({ repository: repo, context: CTX, levelId: 'level1', players: SETUPS, ...over });
    return { repo, autoSaver };
  }

  it('une nouvelle partie écrit la sauvegarde dès l’entrée dans la première salle', () => {
    const { repo, autoSaver } = make();
    expect(repo.raw).toBeNull(); // rien avant le début de salle
    expect(autoSaver.handleEvents([roomEntered(0, 'start')])).toBe(true);
    expect(repo.load()).toEqual({ status: 'ok', save: newGameSave(SETUPS, 'level1'), migratedFrom: null });
  });

  it('chaque nouvelle salle met la reprise à jour ; rien d’autre n’écrit', () => {
    const { repo, autoSaver } = make();
    autoSaver.handleEvents([roomEntered(0, 'start')]);
    autoSaver.handleEvents([{ type: 'playerHit', playerId: 0, damage: 3, pos: { x: 0, y: 0 } }]);
    autoSaver.handleEvents([{ type: 'roomCleared', roomId: 'r1' }]);
    expect(repo.writes).toBe(1);
    autoSaver.handleEvents([roomEntered(1, 'next')]);
    autoSaver.handleEvents([roomEntered(2, 'next')]);
    expect(repo.writes).toBe(3);
    const loaded = repo.load();
    expect(loaded.status === 'ok' && loaded.save.roomIndex).toBe(2);
  });

  it('une défaite collective (teamWipe + roomEntered « restart ») n’altère PAS la sauvegarde', () => {
    const { repo, autoSaver } = make();
    autoSaver.handleEvents([roomEntered(0, 'start')]);
    autoSaver.handleEvents([roomEntered(3, 'next')]);
    const before = repo.raw;
    const writes = repo.writes;
    expect(autoSaver.handleEvents([{ type: 'teamWipe' }])).toBe(false);
    expect(autoSaver.handleEvents([roomEntered(3, 'restart')])).toBe(false);
    expect(repo.raw).toBe(before);
    expect(repo.writes).toBe(writes);
    expect(repo.clears).toBe(0);
    const loaded = repo.load();
    expect(loaded.status === 'ok' && loaded.save.roomIndex).toBe(3);
  });

  it('fin de niveau : écrite AVANT le niveau suivant (niveau terminé ajouté, reprise = salle 0 du niveau suivant)', () => {
    const { repo, autoSaver } = make();
    autoSaver.handleEvents([roomEntered(0, 'start'), roomEntered(4, 'next')]);
    expect(autoSaver.handleEvents([{ type: 'levelCompleted', levelId: 'level1' }])).toBe(true);
    const loaded = repo.load();
    expect(loaded).toMatchObject({ status: 'ok', save: { levelId: 'level2', roomIndex: 0, completedLevelIds: ['level1'] } });
    expect(autoSaver.completedLevelIds).toEqual(['level1']);
    // Le niveau suivant est joué par une NOUVELLE scène de jeu (nouvel AutoSaver) qui reçoit les niveaux terminés via la session :
    // son « start » en salle 0 ne réécrit rien (déjà à jour).
    const next = new AutoSaver({
      repository: repo,
      context: CTX,
      levelId: 'level2',
      players: SETUPS,
      completedLevelIds: autoSaver.completedLevelIds,
      existing: loaded.status === 'ok' ? loaded.save : null,
    });
    const writes = repo.writes;
    next.handleEvents([roomEntered(0, 'start')]);
    expect(repo.writes).toBe(writes);
  });

  it('niveau suivant : une partie reprend avec les niveaux déjà terminés de la session', () => {
    const { repo, autoSaver } = make({ levelId: 'level2', completedLevelIds: ['level1'] });
    autoSaver.handleEvents([roomEntered(0, 'start')]);
    const loaded = repo.load();
    expect(loaded).toMatchObject({ status: 'ok', save: { levelId: 'level2', roomIndex: 0, completedLevelIds: ['level1'] } });
  });

  it('reprise (« existing ») : pas de réécriture inutile au démarrage, mais les salles suivantes sont écrites', () => {
    const existing = save({ roomIndex: 2 });
    const repo = new MemorySaveRepository(CTX, { raw: serializeSave(existing) });
    const autoSaver = new AutoSaver({ repository: repo, context: CTX, levelId: 'level2', players: SETUPS, existing });
    expect(autoSaver.handleEvents([roomEntered(2, 'start')])).toBe(false);
    expect(repo.writes).toBe(0);
    expect(autoSaver.handleEvents([roomEntered(3, 'next')])).toBe(true);
    const loaded = repo.load();
    expect(loaded.status === 'ok' && loaded.save.roomIndex).toBe(3);
  });

  it('désactivée (?quick=1, ?nosave=1) : n’écrit JAMAIS, ne touche pas la vraie sauvegarde', () => {
    const real = serializeSave(save({ roomIndex: 4 }));
    const repo = new MemorySaveRepository(CTX, { raw: real });
    const autoSaver = new AutoSaver({ repository: repo, context: CTX, levelId: 'level1', players: SETUPS, enabled: false });
    autoSaver.handleEvents([roomEntered(0, 'start'), roomEntered(1, 'next'), { type: 'levelCompleted', levelId: 'level1' }]);
    expect(autoSaver.isEnabled).toBe(false);
    expect(repo.raw).toBe(real);
    expect(repo.writes).toBe(0);
    expect(repo.clears).toBe(0);
    // l'état est tout de même suivi (le niveau terminé est reporté dans la session)
    expect(autoSaver.completedLevelIds).toEqual(['level1']);
  });

  it('erreur de stockage (quota) : signalée une seule fois, ancienne valeur intacte, nouvelle tentative à la salle suivante', () => {
    const onError = vi.fn();
    const previous = serializeSave(save({ levelId: 'level1', roomIndex: 0, completedLevelIds: [] }));
    const repo = new MemorySaveRepository(CTX, { raw: previous, failWrites: { code: 'quota', message: 'plein' } });
    const autoSaver = new AutoSaver({ repository: repo, context: CTX, levelId: 'level1', players: SETUPS, onError });
    expect(autoSaver.handleEvents([roomEntered(1, 'next')])).toBe(false);
    expect(autoSaver.handleEvents([roomEntered(2, 'next')])).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith({ code: 'quota', message: 'plein' });
    expect(repo.raw).toBe(previous);
    expect(autoSaver.lastError?.code).toBe('quota');
    // le stockage redevient disponible : la salle suivante est sauvegardée
    repo.failWrites = null;
    expect(autoSaver.handleEvents([roomEntered(3, 'next')])).toBe(true);
    expect(autoSaver.lastError).toBeNull();
    const loaded = repo.load();
    expect(loaded.status === 'ok' && loaded.save.roomIndex).toBe(3);
  });

  it('un callback d’erreur qui lève ne casse pas la partie', () => {
    const repo = new MemorySaveRepository(CTX, { failWrites: { code: 'unavailable', message: 'bloqué' } });
    const autoSaver = new AutoSaver({
      repository: repo,
      context: CTX,
      levelId: 'level1',
      players: SETUPS,
      onError: () => {
        throw new Error('toast cassé');
      },
    });
    expect(() => autoSaver.handleEvents([roomEntered(0, 'start')])).not.toThrow();
  });

  it('localStorage dont setItem lève : le jeu continue, l’ancienne sauvegarde n’est pas perdue', () => {
    const storage = fakeStorage({ [SAVE_STORAGE_KEY]: serializeSave(save({ roomIndex: 1 })) });
    storage.failSet = quotaError();
    const repo = new LocalStorageSaveRepository(CTX, storage);
    const onError = vi.fn();
    const autoSaver = new AutoSaver({ repository: repo, context: CTX, levelId: 'level2', players: SETUPS, onError });
    expect(() => autoSaver.handleEvents([roomEntered(2, 'next')])).not.toThrow();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'quota' }));
    expect(storage.data.get(SAVE_STORAGE_KEY)).toBe(serializeSave(save({ roomIndex: 1 })));
  });

  it('écraser une sauvegarde corrompue n’arrive que par une écriture explicite (nouvelle partie confirmée), jamais au chargement', () => {
    const repo = new MemorySaveRepository(CTX, { raw: '{corrompu' });
    expect(repo.load().status).toBe('corrupt');
    expect(repo.raw).toBe('{corrompu');
    const autoSaver = new AutoSaver({ repository: repo, context: CTX, levelId: 'level1', players: SETUPS });
    expect(repo.raw).toBe('{corrompu'); // créer la partie ne touche à rien
    autoSaver.handleEvents([roomEntered(0, 'start')]);
    expect(repo.load().status).toBe('ok');
  });
});

describe('intégration avec la vraie simulation', () => {
  /** Niveau de 3 salles à sortie immédiate (aucune exigence) : la dernière est finale. */
  function easyLevel(): LevelDef {
    const rooms = [1, 2, 3].map((i) =>
      makeTestRoom({
        id: `r${i}`,
        mechanisms: [{ id: 'p1', type: 'plate', tile: [6, 4] }],
        exit: { rect: { x: 1, y: 1, w: 4, h: 4 }, requires: [], ...(i === 3 ? { final: true } : {}) },
      }),
    );
    return makeTestLevel({ id: 'test', rooms, objectives: [] });
  }
  const ctx: SaveContext = { levels: [{ id: 'test', roomCount: 3 }, { id: 'suite', roomCount: 1 }] };

  function run(level: LevelDef) {
    const repo = new MemorySaveRepository(ctx);
    const sim = createSimulation({ levelId: level.id, players: SETUPS, seed: 3 }, level);
    const autoSaver = new AutoSaver({ repository: repo, context: ctx, levelId: level.id, players: SETUPS });
    const seen: SimEvent[] = [];
    const step = (n = 1): void => {
      for (let i = 0; i < n; i++) {
        const events = sim.step(SIM_STEP_MS, {});
        seen.push(...events);
        autoSaver.handleEvents(events);
      }
    };
    return { repo, sim, autoSaver, step, seen };
  }

  it('au fil des salles : une écriture par début de salle, puis fin de niveau', () => {
    const { repo, step, seen, sim } = run(easyLevel());
    step();
    expect(repo.writes).toBe(1);
    expect(repo.load()).toMatchObject({ status: 'ok', save: { levelId: 'test', roomIndex: 0 } });
    /** Avance pas à pas jusqu'à l'entrée dans la salle `index` (le test s'arrête AVANT que cette salle soit validée). */
    const stepToRoom = (index: number): void => {
      for (let i = 0; i < 1000 && sim.state.roomIndex !== index; i++) step();
      expect(sim.state.roomIndex).toBe(index);
    };
    stepToRoom(1);
    expect(repo.load()).toMatchObject({ status: 'ok', save: { levelId: 'test', roomIndex: 1 } });
    stepToRoom(2);
    expect(repo.load()).toMatchObject({ status: 'ok', save: { levelId: 'test', roomIndex: 2 } });
    expect(seen.some((e) => e.type === 'levelCompleted')).toBe(false);
    // dernière salle : levelCompleted → reprise = salle 0 du niveau suivant, niveau terminé ajouté
    step(5);
    expect(seen.some((e) => e.type === 'levelCompleted')).toBe(true);
    expect(repo.load()).toMatchObject({ status: 'ok', save: { levelId: 'suite', roomIndex: 0, completedLevelIds: ['test'] } });
  });

  it('défaite collective : la sauvegarde est inchangée et la reprise se fait au début de la salle sauvegardée', () => {
    const level = easyLevel();
    // Salle 1 : exit hors de portée pour ne pas se valider pendant le test
    level.rooms[0].exit = { rect: { x: 9, y: 5, w: 2, h: 2 }, requires: ['p1'] };
    const { repo, sim, step, seen } = run(level);
    step();
    const before = repo.raw;
    const writes = repo.writes;
    for (const p of sim.state.players) {
      p.hp = 0;
      p.status = 'down';
    }
    step(Math.ceil(WIPE_RESTART_DELAY_MS / SIM_STEP_MS) + 20);
    expect(seen.some((e) => e.type === 'teamWipe')).toBe(true);
    expect(seen.some((e) => e.type === 'roomEntered' && e.reason === 'restart')).toBe(true);
    expect(repo.raw).toBe(before);
    expect(repo.writes).toBe(writes);
    expect(repo.clears).toBe(0);
    // reprise depuis la sauvegarde : même salle, début de salle
    const loaded = repo.load();
    expect(loaded.status).toBe('ok');
    if (loaded.status === 'ok') {
      const resumed = createSimulation(buildResumeSimConfig(loaded.save, 8), level);
      expect(resumed.state.roomIndex).toBe(0);
      expect(resumed.state.players.every((p) => p.status === 'alive' && p.hp === p.maxHp)).toBe(true);
    }
  });
});
