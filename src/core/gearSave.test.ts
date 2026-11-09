/**
 * Équipement et SAUVEGARDE (schéma v3) : format, validation, migration v2 -> v3 (sans équipement), mise à jour au début de salle, remise à zéro à la fin
 * du niveau, défaite d'équipe (règle stricte : l'équipement perdu n'est pas restitué), « Continuer » (restitution dans la simulation), AutoSaver.
 */
import { describe, expect, it } from 'vitest';
import { AutoSaver } from './autoSave';
import { SIM_STEP_MS } from './constants';
import { createGear } from './gear';
import { makeTestLevel, makeTestRoom } from './levelValidation';
import {
  SAVE_SCHEMA_VERSION,
  buildResumeSimConfig,
  migrateSave,
  newGameSave,
  parseSave,
  serializeSave,
  validateSave,
  withGear,
  withLevelCompleted,
  type SaveContext,
  type SaveGame,
} from './save';
import { MemorySaveRepository } from './saveRepository';
import { createSimulation } from './simulation';
import type { PlayerGear, PlayerSetup, SimEvent } from './types';
import { sessionFromSave } from '../render/saveMenuLogic';

const CTX: SaveContext = { levels: [{ id: 'level1', roomCount: 5 }, { id: 'level2', roomCount: 6 }] };
const SETUPS: PlayerSetup[] = [
  { id: 0, characterId: 'david', difficulty: 2 },
  { id: 1, characterId: 'sandrine', difficulty: 1 },
];
const G1: PlayerGear = { boots: 3, protection: 0, artifact: 2, magic: 0, weapon: 1, accessory: null };
const G2: PlayerGear = { boots: 0, protection: 1, artifact: 0, magic: 3, weapon: 0, accessory: { kind: 'magnet', level: 2 } };

function save(over: Partial<SaveGame> = {}): SaveGame {
  return {
    schemaVersion: SAVE_SCHEMA_VERSION,
    levelId: 'level1',
    roomIndex: 2,
    players: [{ characterId: 'david', difficulty: 2 }, { characterId: 'sandrine', difficulty: 1 }],
    completedLevelIds: [],
    ...over,
  };
}

const entered = (reason: 'start' | 'next' | 'restart', roomIndex = 1): SimEvent => ({ type: 'roomEntered', roomId: `r${roomIndex + 1}`, roomIndex, reason });

describe('schéma de sauvegarde v3', () => {
  it('version courante 3', () => {
    expect(SAVE_SCHEMA_VERSION).toBe(3);
    expect(newGameSave(SETUPS, 'level1').schemaVersion).toBe(3);
  });
  it('une sauvegarde v3 avec équipement fait l\'aller-retour (sérialisation / lecture) sans perte', () => {
    const s = save({ players: [{ characterId: 'david', difficulty: 2, gear: G1 }, { characterId: 'sandrine', difficulty: 1, gear: G2 }] });
    const r = parseSave(serializeSave(s), CTX);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.save.players[0].gear).toEqual(G1);
      expect(r.save.players[1].gear).toEqual(G2);
      expect(r.migratedFrom).toBeNull();
    }
  });
  it('un équipement vide n\'est jamais stocké (la sauvegarde reste identique à celle d\'avant)', () => {
    const r = validateSave(save({ players: [{ characterId: 'david', difficulty: 2, gear: createGear() }, { characterId: 'sandrine', difficulty: 1 }] }), CTX);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.save.players[0]).toEqual({ characterId: 'david', difficulty: 2 });
  });
  it('équipement invalide (niveau hors 0..3, accessoire inconnu, forme non objet) : DÉGRADÉ en équipement vide, la progression (niveau, salle, équipe) reste lisible', () => {
    for (const gear of [{ boots: 4 }, { weapon: -1 }, { magic: 1.5 }, { accessory: { kind: 'nope', level: 1 } }, { accessory: { kind: 'magnet', level: 0 } }, null, [], 'x', 12]) {
      const r = validateSave(save({ roomIndex: 3, players: [{ characterId: 'david', difficulty: 2, gear: gear as unknown as PlayerGear }] }), CTX);
      expect(r.ok, JSON.stringify(gear)).toBe(true);
      if (r.ok) {
        expect(r.save.players[0]).toEqual({ characterId: 'david', difficulty: 2 });
        expect(r.save.roomIndex).toBe(3);
      }
    }
    // un équipement invalide chez UN joueur n'efface pas celui des autres
    const mixed = validateSave(save({ players: [{ characterId: 'david', difficulty: 2, gear: { boots: 9 } as unknown as PlayerGear }, { characterId: 'sandrine', difficulty: 1, gear: G2 }] }), CTX);
    expect(mixed.ok && mixed.save.players[0].gear === undefined && mixed.save.players[1].gear?.magic === 3).toBe(true);
    // les champs de PROGRESSION restent stricts
    const bad = validateSave(save({ roomIndex: 99 }), CTX);
    expect(bad.ok).toBe(false);
  });
  it('MIGRATION v2 -> v3 : aucune perte, aucun équipement, migratedFrom 2', () => {
    const v2 = { schemaVersion: 2, levelId: 'level2', roomIndex: 3, players: [{ characterId: 'david', difficulty: 2 }, { characterId: 'sandrine', difficulty: 1 }], completedLevelIds: ['level1'] };
    const r = migrateSave(v2, CTX);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.migratedFrom).toBe(2);
      expect(r.save.schemaVersion).toBe(3);
      expect(r.save.levelId).toBe('level2');
      expect(r.save.roomIndex).toBe(3);
      expect(r.save.completedLevelIds).toEqual(['level1']);
      expect(r.save.players.every((p) => p.gear === undefined)).toBe(true);
    }
  });
  it('migration en chaîne depuis v1 et v0 jusqu\'à v3', () => {
    const v1 = { schemaVersion: 1, levelIndex: 1, roomIndex: 2, players: [{ characterId: 'david', difficulty: 2 }], completedLevelIndices: [0] };
    const r1 = migrateSave(v1, CTX);
    expect(r1.ok && r1.save.schemaVersion === 3 && r1.migratedFrom === 1).toBe(true);
    const v0 = { level: 1, room: 2, chars: ['david'], diffs: [2], done: [] };
    const r0 = migrateSave(v0, CTX);
    expect(r0.ok && r0.save.schemaVersion === 3 && r0.migratedFrom === 0).toBe(true);
  });
  it('une version future reste refusée', () => {
    const r = migrateSave({ schemaVersion: 4 }, CTX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('futureVersion');
  });
});

describe('withGear / fin de niveau', () => {
  it('withGear : met à jour par joueur, même référence si rien ne change, vide non stocké, longueur incohérente ignorée', () => {
    const s = save();
    expect(withGear(s, [createGear(), createGear()])).toBe(s);
    const s2 = withGear(s, [G1, createGear()]);
    expect(s2.players[0].gear).toEqual(G1);
    expect(s2.players[1].gear).toBeUndefined();
    expect(withGear(s2, [G1, createGear()])).toBe(s2);
    const s3 = withGear(s2, [createGear(), G2]);
    expect(s3.players[0].gear).toBeUndefined();
    expect(s3.players[1].gear).toEqual(G2);
    expect(withGear(s, [G1])).toBe(s);
  });
  it('la copie sauvegardée est indépendante de l\'objet fourni', () => {
    const g = { ...G1 };
    const s = withGear(save(), [g, createGear()]);
    g.boots = 0;
    expect(s.players[0].gear?.boots).toBe(3);
  });
  it('fin de niveau : l\'équipement est remis à zéro (l\'équipement dure jusqu\'à la FIN DU NIVEAU)', () => {
    const s = withGear(save({ levelId: 'level1', roomIndex: 4 }), [G1, G2]);
    const next = withLevelCompleted(s, 'level1', CTX);
    expect(next.levelId).toBe('level2');
    expect(next.roomIndex).toBe(0);
    expect(next.players.every((p) => p.gear === undefined)).toBe(true);
    // même quand l'état de reprise était déjà celui du niveau suivant
    const again = withLevelCompleted({ ...next, players: s.players }, 'level1', CTX);
    expect(again.players.every((p) => p.gear === undefined)).toBe(true);
  });
});

describe('AutoSaver : équipement au début de salle', () => {
  function make(gear: () => PlayerGear[]) {
    const repo = new MemorySaveRepository(CTX);
    const auto = new AutoSaver({ repository: repo, context: CTX, levelId: 'level1', players: SETUPS, gearProvider: gear });
    const read = (): SaveGame => {
      const r = repo.load();
      if (r.status !== 'ok') throw new Error('sauvegarde absente');
      return r.save;
    };
    return { repo, auto, read };
  }
  it('début de salle : l\'équipement porté à cet instant est sauvegardé ; il est restitué à chaque nouvelle salle', () => {
    let gears: PlayerGear[] = [createGear(), createGear()];
    const { auto, read } = make(() => gears);
    auto.handleEvents([entered('start', 0)]);
    expect(read().players.every((p) => p.gear === undefined)).toBe(true);
    gears = [G1, G2];
    expect(auto.handleEvents([entered('next', 1)])).toBe(true);
    expect(read().roomIndex).toBe(1);
    expect(read().players[0].gear).toEqual(G1);
    expect(read().players[1].gear).toEqual(G2);
  });
  it('pas d\'écriture inutile : même salle, même équipement -> aucune écriture', () => {
    const gears = [G1, createGear()];
    const { repo, auto } = make(() => gears);
    auto.handleEvents([entered('next', 1)]);
    const w = repo.writes;
    expect(auto.handleEvents([entered('next', 1)])).toBe(false);
    expect(repo.writes).toBe(w);
  });
  it('défaite d\'équipe (restart) : la salle de reprise ne change pas MAIS l\'équipement perdu est enregistré (pas de point de reprise)', () => {
    let gears: PlayerGear[] = [G1, G2];
    const { auto, read } = make(() => gears);
    auto.handleEvents([entered('next', 2)]);
    expect(read().players[0].gear).toEqual(G1);
    gears = [createGear(), createGear()]; // tout est perdu
    expect(auto.handleEvents([entered('restart', 2)])).toBe(true);
    expect(read().roomIndex).toBe(2);
    expect(read().players.every((p) => p.gear === undefined)).toBe(true);
  });
  it('PERTE STRICTE : gearLost est écrit IMMÉDIATEMENT (avant tout restart) : seul l\'équipement du joueur tombé est vidé, la salle de reprise ne change pas', () => {
    const gears: PlayerGear[] = [G1, G2];
    const { auto, read } = make(() => gears);
    auto.handleEvents([entered('next', 2)]);
    expect(read().players[0].gear).toEqual(G1);
    expect(read().players[1].gear).toEqual(G2);
    // le joueur 0 tombe : sa perte est enregistrée aussitôt, celui du joueur 1 reste
    gears[0] = createGear();
    expect(auto.handleEvents([{ type: 'gearLost', playerId: 0, items: [], pos: { x: 0, y: 0 } }])).toBe(true);
    expect(read().roomIndex).toBe(2);
    expect(read().players[0].gear).toBeUndefined();
    expect(read().players[1].gear).toEqual(G2);
    // idempotent : même perte, aucune écriture
    expect(auto.handleEvents([{ type: 'gearLost', playerId: 0, items: [], pos: { x: 0, y: 0 } }])).toBe(false);
  });
  it('« Continuer » après une partie quittée juste après la chute ne restitue PAS l\'équipement perdu (simulation + AutoSaver de bout en bout, défaite d\'équipe)', () => {
    const room = (id: string) => makeTestRoom({ id, exit: { rect: { x: 9, y: 5, w: 2, h: 2 }, requires: [] } });
    const level = makeTestLevel({ rooms: [room('r1'), room('r2'), room('r3')] });
    level.rooms[2].exit.final = true;
    const ctx: SaveContext = { levels: [{ id: level.id, roomCount: 3 }] };
    const repo = new MemorySaveRepository(ctx);
    const base = withGear({ ...newGameSave(SETUPS, level.id), roomIndex: 1 }, [G1, G2]);
    repo.save(base);
    const sim = createSimulation({ ...buildResumeSimConfig(base, 9), levelId: level.id }, level);
    const auto = new AutoSaver({ repository: repo, context: ctx, levelId: level.id, players: SETUPS, existing: base, gearProvider: () => sim.state.players.map((p) => ({ ...p.loadout })) });
    auto.handleEvents(sim.step(SIM_STEP_MS, {}));
    expect(sim.state.players[0].loadout.boots).toBe(3);
    // joueur 1 tombé seul : sa perte est déjà dans le fichier (l'équipe n'a pas changé de salle)
    sim.knockDown(1);
    let ev: SimEvent[] = [];
    for (let i = 0; i < 3; i++) ev = ev.concat(sim.step(SIM_STEP_MS, {}));
    expect(ev.some((e) => e.type === 'gearLost' && e.playerId === 1)).toBe(true);
    auto.handleEvents(ev);
    const afterOne = repo.load();
    expect(afterOne.status === 'ok' && afterOne.save.players[1].gear === undefined && afterOne.save.players[0].gear?.boots === 3).toBe(true);
    // puis le dernier survivant tombe aussi : défaite d'équipe, le fichier est vide AVANT la fin du délai de redémarrage
    sim.knockDown(0);
    ev = [];
    for (let i = 0; i < 3; i++) ev = ev.concat(sim.step(SIM_STEP_MS, {}));
    expect(ev.some((e) => e.type === 'teamWipe')).toBe(true);
    expect(ev.some((e) => e.type === 'roomEntered')).toBe(false);
    auto.handleEvents(ev);
    const loaded = repo.load();
    expect(loaded.status).toBe('ok');
    if (loaded.status === 'ok') {
      expect(loaded.save.roomIndex).toBe(1);
      expect(loaded.save.players.every((p) => p.gear === undefined)).toBe(true);
      expect(buildResumeSimConfig(loaded.save, 3).initialGear).toBeUndefined();
    }
  });
  it('restart sans changement d\'équipement : aucune écriture (comportement d\'avant)', () => {
    const { repo, auto } = make(() => [createGear(), createGear()]);
    auto.handleEvents([entered('next', 2)]);
    const w = repo.writes;
    expect(auto.handleEvents([entered('restart', 2)])).toBe(false);
    expect(repo.writes).toBe(w);
  });
  it('fin de niveau : équipement remis à zéro dans la sauvegarde (niveau suivant)', () => {
    let gears: PlayerGear[] = [G1, G2];
    const { auto, read } = make(() => gears);
    auto.handleEvents([entered('next', 4)]);
    gears = [G1, G2];
    auto.handleEvents([{ type: 'levelCompleted', levelId: 'level1' }]);
    expect(read().levelId).toBe('level2');
    expect(read().players.every((p) => p.gear === undefined)).toBe(true);
  });
  it('sans gearProvider : l\'équipement n\'est pas sauvegardé (comportement d\'avant)', () => {
    const repo = new MemorySaveRepository(CTX);
    const auto = new AutoSaver({ repository: repo, context: CTX, levelId: 'level1', players: SETUPS });
    auto.handleEvents([entered('next', 1)]);
    const r = repo.load();
    expect(r.status === 'ok' && r.save.players.every((p) => p.gear === undefined)).toBe(true);
  });
  it('mode enabled:false : rien n\'est écrit', () => {
    const repo = new MemorySaveRepository(CTX);
    const auto = new AutoSaver({ repository: repo, context: CTX, levelId: 'level1', players: SETUPS, enabled: false, gearProvider: () => [G1, G2] });
    auto.handleEvents([entered('next', 1)]);
    expect(repo.writes).toBe(0);
  });
});

describe('« Continuer » restitue l\'équipement', () => {
  it('buildResumeSimConfig : initialGear seulement si quelqu\'un porte quelque chose', () => {
    expect(buildResumeSimConfig(save(), 3).initialGear).toBeUndefined();
    const cfg = buildResumeSimConfig(withGear(save(), [G1, createGear()]), 3);
    expect(cfg.initialGear?.[0]).toEqual(G1);
    expect(cfg.initialGear?.[1]).toBeUndefined();
  });
  it('de bout en bout : sauvegarde -> session -> simulation reprise avec le même équipement', () => {
    const s = withGear(save({ levelId: 'level1', roomIndex: 1 }), [G1, G2]);
    const room = (id: string) => makeTestRoom({ id, exit: { rect: { x: 9, y: 5, w: 2, h: 2 }, requires: [] } });
    const level = makeTestLevel({ rooms: [room('r1'), room('r2'), room('r3')] });
    level.rooms[2].exit.final = true;
    const sim = createSimulation({ ...buildResumeSimConfig(s, 9), levelId: level.id }, level);
    expect(sim.state.roomIndex).toBe(1);
    expect(sim.state.players[0].loadout).toMatchObject({ boots: 3, artifact: 2, weapon: 1 });
    expect(sim.state.players[1].loadout.accessory).toEqual({ kind: 'magnet', level: 2 });
    sim.step(SIM_STEP_MS, {});
    expect(sim.state.players[0].loadout.boots).toBe(3);
    // et la session de reprise du menu porte le même équipement
    const sess = sessionFromSave(s, CTX);
    expect(sess?.startGear?.[0]).toEqual(G1);
    expect(sess?.startGear?.[1]).toEqual(G2);
    expect(sessionFromSave(save(), CTX)?.startGear).toBeUndefined();
  });
});
