/**
 * Emplacement cœur et SAUVEGARDE (champ optionnel `players[i].heart` du schéma v3, sans changement de version) : lecture tolérante (ancien JSON sans le champ, valeurs inconnues ou hostiles =
 * vide, jamais une erreur), écriture au début de salle, perte écrite DÈS la chute (comme `gearLost`), remise à zéro à la fin du niveau, préservation par les autres mises à jour,
 * « Continuer » (restitution dans la simulation et la session), défaite d'équipe (strict), AutoSaver de bout en bout.
 */
import { describe, expect, it } from 'vitest';
import { AutoSaver } from './autoSave';
import { SIM_STEP_MS } from './constants';
import { makeTestLevel, makeTestRoom } from './levelValidation';
import {
  SAVE_SCHEMA_VERSION,
  applySimEvents,
  buildResumeSimConfig,
  newGameSave,
  parseSave,
  serializeSave,
  validateSave,
  withGear,
  withGearLost,
  withHeartLost,
  withHearts,
  withLevelCompleted,
  type SaveContext,
  type SaveGame,
} from './save';
import { MemorySaveRepository } from './saveRepository';
import { createSimulation } from './simulation';
import type { PickupKind, PlayerGear, PlayerSetup, SimEvent } from './types';
import { advanceLevel, replaySession } from '../render/menuLogic';
import { sessionFromSave } from '../render/saveMenuLogic';
import { createGear } from './gear';

const CTX: SaveContext = { levels: [{ id: 'level1', roomCount: 5 }, { id: 'level2', roomCount: 6 }] };
const SETUPS: PlayerSetup[] = [
  { id: 0, characterId: 'david', difficulty: 2 },
  { id: 1, characterId: 'sandrine', difficulty: 1 },
];
const G1: PlayerGear = { boots: 3, protection: 0, artifact: 2, magic: 0, weapon: 1, accessory: null };

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
const used = (playerId: 0 | 1, targetId: 0 | 1, kind: PickupKind = 'full'): SimEvent => ({ type: 'heartUsed', playerId, targetId, kind, amount: 5, pos: { x: 0, y: 0 } });
const lost = (playerId: 0 | 1, kind: PickupKind = 'full'): SimEvent => ({ type: 'heartLost', playerId, kind, pos: { x: 0, y: 0 } });

describe('schéma : le cœur rangé est un champ OPTIONNEL du schéma v3 (version inchangée)', () => {
  it('la version reste 3 ; un cœur rangé fait l aller-retour sans perte', () => {
    expect(SAVE_SCHEMA_VERSION).toBe(3);
    const s = save({ players: [{ characterId: 'david', difficulty: 2, heart: 'full' }, { characterId: 'sandrine', difficulty: 1, heart: 'half' }] });
    const r = parseSave(serializeSave(s), CTX);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.save.players.map((p) => p.heart)).toEqual(['full', 'half']);
      expect(r.migratedFrom).toBeNull();
    }
  });

  it('ancien JSON (sans le champ) : lu tel quel, emplacements vides, aucun champ ajouté', () => {
    const old = JSON.stringify({ schemaVersion: 3, levelId: 'level1', roomIndex: 1, players: [{ characterId: 'david', difficulty: 2, gear: G1 }], completedLevelIds: [] });
    const r = parseSave(old, CTX);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect('heart' in r.save.players[0]).toBe(false);
      expect(r.save.players[0].gear).toEqual(G1);
      // l ancien JSON est ré-écrit à l identique (octet pour octet) par serializeSave
      expect(serializeSave(r.save)).toBe(JSON.stringify({ schemaVersion: 3, levelId: 'level1', roomIndex: 1, players: [{ characterId: 'david', difficulty: 2, gear: G1 }], completedLevelIds: [] }));
    }
  });

  it('valeurs inconnues ou hostiles : emplacement VIDE (jamais une erreur : la progression reste lisible)', () => {
    for (const heart of ['banana', '', 'FULL', 5, null, true, [], {}, { kind: 'full' }]) {
      const r = validateSave(save({ roomIndex: 3, players: [{ characterId: 'david', difficulty: 2, heart: heart as unknown as PickupKind, gear: G1 }] }), CTX);
      expect(r.ok, JSON.stringify(heart)).toBe(true);
      if (r.ok) {
        expect('heart' in r.save.players[0], JSON.stringify(heart)).toBe(false);
        expect(r.save.roomIndex).toBe(3);
        expect(r.save.players[0].gear).toEqual(G1); // l équipement n est pas affecté
      }
    }
    // un cœur hostile chez un joueur n efface pas celui de l autre
    const mixed = validateSave(save({ players: [{ characterId: 'david', difficulty: 2, heart: 'x' as unknown as PickupKind }, { characterId: 'sandrine', difficulty: 1, heart: 'half' }] }), CTX);
    expect(mixed.ok && mixed.save.players[0].heart === undefined && mixed.save.players[1].heart === 'half').toBe(true);
  });
});

describe('mises à jour pures', () => {
  it('withHearts : écrit les cœurs, un emplacement vide n est pas stocké, même référence si rien ne change, taille incohérente ignorée', () => {
    const s = save();
    const a = withHearts(s, ['full', undefined]);
    expect(a.players[0].heart).toBe('full');
    expect('heart' in a.players[1]).toBe(false);
    expect(withHearts(a, ['full', undefined])).toBe(a);
    const b = withHearts(a, [undefined, 'half']);
    expect('heart' in b.players[0]).toBe(false);
    expect(b.players[1].heart).toBe('half');
    expect(withHearts(a, ['full'])).toBe(a);
    expect(withHearts(a, ['banana' as unknown as PickupKind, undefined]).players[0].heart).toBeUndefined();
  });

  it('withHeartLost : vide le cœur des joueurs indiqués seulement, garde l équipement, même référence si rien ne change', () => {
    const s = save({ players: [{ characterId: 'david', difficulty: 2, gear: G1, heart: 'full' }, { characterId: 'sandrine', difficulty: 1, heart: 'half' }] });
    const a = withHeartLost(s, [0]);
    expect(a.players[0]).toEqual({ characterId: 'david', difficulty: 2, gear: G1 });
    expect(a.players[1].heart).toBe('half');
    expect(withHeartLost(a, [0])).toBe(a);
  });

  it('withGear et withGearLost PRÉSERVENT le cœur rangé (et réciproquement)', () => {
    const s = save({ players: [{ characterId: 'david', difficulty: 2, heart: 'full', gear: G1 }, { characterId: 'sandrine', difficulty: 1 }] });
    const g = withGear(s, [createGear(), createGear()]);
    expect(g.players[0]).toEqual({ characterId: 'david', difficulty: 2, heart: 'full' });
    const l = withGearLost(s, [0]);
    expect(l.players[0]).toEqual({ characterId: 'david', difficulty: 2, heart: 'full' });
    expect(withHeartLost(s, [0]).players[0].gear).toEqual(G1);
  });

  it('fin de niveau : le cœur rangé est remis à zéro (comme l équipement), même référence si rien à remettre', () => {
    const s = save({ levelId: 'level1', roomIndex: 4, players: [{ characterId: 'david', difficulty: 2, heart: 'full' }, { characterId: 'sandrine', difficulty: 1 }] });
    const done = withLevelCompleted(s, 'level1', CTX);
    expect(done.levelId).toBe('level2');
    expect(done.players.every((p) => p.heart === undefined)).toBe(true);
    const clean = withLevelCompleted(save({ levelId: 'level2', roomIndex: 0, completedLevelIds: ['level1'] }), 'level1', CTX);
    expect(withLevelCompleted(clean, 'level1', CTX)).toBe(clean);
  });

  it('applySimEvents : heartLost vide le cœur du joueur tombé sans changer la salle de reprise', () => {
    const s = save({ players: [{ characterId: 'david', difficulty: 2, heart: 'full' }, { characterId: 'sandrine', difficulty: 1, heart: 'half' }] });
    const a = applySimEvents(s, 'level1', [lost(1, 'half')], CTX);
    expect(a.roomIndex).toBe(2);
    expect(a.players[0].heart).toBe('full');
    expect(a.players[1].heart).toBeUndefined();
  });

  it('applySimEvents : heartUsed vide AUSSI le cœur sauvegardé de l utilisateur (un cœur utilisé ne revient jamais), sans toucher aux autres', () => {
    const s0 = save({ players: [{ characterId: 'david', difficulty: 2, heart: 'full' }, { characterId: 'sandrine', difficulty: 1, heart: 'half' }] });
    const a = applySimEvents(s0, 'level1', [used(0, 1)], CTX);
    expect(a.roomIndex).toBe(2);
    expect(a.players[0].heart).toBeUndefined();
    expect(a.players[1].heart).toBe('half');
    expect(applySimEvents(a, 'level1', [used(0, 1)], CTX)).toBe(a); // idempotent
  });

  it('buildResumeSimConfig : initialHearts seulement si quelqu un en porte (la configuration reste celle d avant sinon)', () => {
    expect('initialHearts' in buildResumeSimConfig(save(), 1)).toBe(false);
    const cfg = buildResumeSimConfig(save({ players: [{ characterId: 'david', difficulty: 2 }, { characterId: 'sandrine', difficulty: 1, heart: 'half' }] }), 1);
    expect(cfg.initialHearts).toEqual([undefined, 'half']);
  });
});

describe('session « Continuer » / niveau suivant / nouvelle tentative', () => {
  const s = save({ players: [{ characterId: 'david', difficulty: 2, heart: 'full' }, { characterId: 'sandrine', difficulty: 1 }] });

  it('sessionFromSave restitue le cœur (startHearts) ; absent si personne n en porte', () => {
    expect(sessionFromSave(s, CTX)?.startHearts).toEqual(['full', undefined]);
    expect(sessionFromSave(save(), CTX)?.startHearts).toBeUndefined();
  });

  it('advanceLevel et replaySession (nouvelle tentative / victoire) effacent startHearts : il dure jusqu à la fin du niveau', () => {
    const sess = sessionFromSave(s, CTX)!;
    expect(advanceLevel(sess).startHearts).toBeUndefined();
    expect(replaySession(sess, 'defeat').startHearts).toBeUndefined();
    expect(replaySession(sess, 'victory').startHearts).toBeUndefined();
  });
});

describe('AutoSaver : cœur rangé', () => {
  function make(hearts: () => (PickupKind | undefined)[]) {
    const repo = new MemorySaveRepository(CTX);
    const auto = new AutoSaver({ repository: repo, context: CTX, levelId: 'level1', players: SETUPS, heartProvider: hearts });
    const read = (): SaveGame => {
      const r = repo.load();
      if (r.status !== 'ok') throw new Error('sauvegarde absente');
      return r.save;
    };
    return { repo, auto, read };
  }

  it('début de salle : le cœur rangé à cet instant est sauvegardé', () => {
    let hearts: (PickupKind | undefined)[] = [undefined, undefined];
    const { auto, read } = make(() => hearts);
    auto.handleEvents([entered('start', 0)]);
    expect(read().players.every((p) => p.heart === undefined)).toBe(true);
    hearts = ['full', 'half'];
    expect(auto.handleEvents([entered('next', 1)])).toBe(true);
    expect(read().players.map((p) => p.heart)).toEqual(['full', 'half']);
  });

  it('pas d écriture inutile (même salle, mêmes cœurs)', () => {
    const { repo, auto } = make(() => ['full', undefined]);
    auto.handleEvents([entered('next', 1)]);
    const w = repo.writes;
    expect(auto.handleEvents([entered('next', 1)])).toBe(false);
    expect(repo.writes).toBe(w);
  });

  it('PERTE écrite DÈS la chute (heartLost) : seul le joueur tombé est vidé, la salle de reprise ne change pas ; idempotent', () => {
    const { auto, read } = make(() => ['full', 'half']);
    auto.handleEvents([entered('next', 2)]);
    expect(read().players.map((p) => p.heart)).toEqual(['full', 'half']);
    expect(auto.handleEvents([lost(0)])).toBe(true);
    expect(read().roomIndex).toBe(2);
    expect(read().players.map((p) => p.heart)).toEqual([undefined, 'half']);
    expect(auto.handleEvents([lost(0)])).toBe(false);
  });

  it('USAGE écrit DÈS qu il a lieu (heartUsed) : le cœur utilisé n est plus dans le fichier, la salle de reprise ne change pas', () => {
    const hearts: (PickupKind | undefined)[] = ['full', 'half'];
    const { auto, read } = make(() => hearts);
    auto.handleEvents([entered('next', 2)]);
    hearts[0] = undefined;
    expect(auto.handleEvents([used(0, 1)])).toBe(true);
    expect(read().roomIndex).toBe(2);
    expect(read().players.map((p) => p.heart)).toEqual([undefined, 'half']);
    expect(auto.handleEvents([used(0, 1)])).toBe(false);
  });

  it('défaite d équipe (restart) : le cœur perdu est enregistré (la salle de reprise ne change pas)', () => {
    let hearts: (PickupKind | undefined)[] = ['full', 'half'];
    const { auto, read } = make(() => hearts);
    auto.handleEvents([entered('next', 2)]);
    hearts = [undefined, undefined];
    expect(auto.handleEvents([entered('restart', 2)])).toBe(true);
    expect(read().roomIndex).toBe(2);
    expect(read().players.every((p) => p.heart === undefined)).toBe(true);
  });

  it('fin de niveau : le cœur est remis à zéro dans la sauvegarde', () => {
    const { auto, read } = make(() => ['full', 'half']);
    auto.handleEvents([entered('next', 4)]);
    auto.handleEvents([{ type: 'levelCompleted', levelId: 'level1' }]);
    expect(read().levelId).toBe('level2');
    expect(read().players.every((p) => p.heart === undefined)).toBe(true);
  });

  it('sans heartProvider : le cœur n est pas sauvegardé (comportement d avant) ; enabled:false : rien n est écrit', () => {
    const repo = new MemorySaveRepository(CTX);
    const auto = new AutoSaver({ repository: repo, context: CTX, levelId: 'level1', players: SETUPS });
    auto.handleEvents([entered('next', 1)]);
    const r = repo.load();
    expect(r.status === 'ok' && r.save.players.every((p) => p.heart === undefined)).toBe(true);
    const repo2 = new MemorySaveRepository(CTX);
    new AutoSaver({ repository: repo2, context: CTX, levelId: 'level1', players: SETUPS, enabled: false, heartProvider: () => ['full', 'half'] }).handleEvents([entered('next', 1)]);
    expect(repo2.writes).toBe(0);
  });
});

describe('« Continuer » de bout en bout (simulation + AutoSaver)', () => {
  const room = (id: string) => makeTestRoom({ id, exit: { rect: { x: 9, y: 5, w: 2, h: 2 }, requires: [] } });
  const level = makeTestLevel({ rooms: [room('r1'), room('r2'), room('r3')] });
  level.rooms[2].exit.final = true;
  const ctx: SaveContext = { levels: [{ id: level.id, roomCount: 3 }] };

  it('« Continuer » restitue le cœur rangé à l emplacement du joueur', () => {
    const base = withHearts({ ...newGameSave(SETUPS, level.id), roomIndex: 1 }, ['full', 'half']);
    const sim = createSimulation({ ...buildResumeSimConfig(base, 9), levelId: level.id, heartSlot: true }, level);
    expect(sim.state.players.map((p) => p.heart)).toEqual(['full', 'half']);
  });

  it('quitter juste après la chute puis « Continuer » ne restitue PAS le cœur perdu (joueur tombé seul, puis défaite d équipe)', () => {
    const repo = new MemorySaveRepository(ctx);
    const base = withHearts({ ...newGameSave(SETUPS, level.id), roomIndex: 1 }, ['full', 'half']);
    repo.save(base);
    const sim = createSimulation({ ...buildResumeSimConfig(base, 9), levelId: level.id, heartSlot: true }, level);
    const auto = new AutoSaver({ repository: repo, context: ctx, levelId: level.id, players: SETUPS, existing: base, heartProvider: () => sim.state.players.map((p) => p.heart) });
    auto.handleEvents(sim.step(SIM_STEP_MS, {}));
    expect(sim.state.players[1].heart).toBe('half');
    // le joueur 1 tombe : sa perte est déjà dans le fichier
    sim.knockDown(1);
    let ev: SimEvent[] = [];
    for (let i = 0; i < 3; i++) ev = ev.concat(sim.step(SIM_STEP_MS, {}));
    expect(ev.some((e) => e.type === 'heartLost' && e.playerId === 1)).toBe(true);
    auto.handleEvents(ev);
    const afterOne = repo.load();
    expect(afterOne.status === 'ok' && afterOne.save.players[1].heart === undefined && afterOne.save.players[0].heart === 'full').toBe(true);
    // le dernier survivant tombe : défaite d équipe, fichier vide AVANT le redémarrage de la salle
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
      expect(loaded.save.players.every((p) => p.heart === undefined)).toBe(true);
      expect(buildResumeSimConfig(loaded.save, 3).initialHearts).toBeUndefined();
      expect(sessionFromSave(loaded.save, ctx)?.startHearts).toBeUndefined();
    }
  });
  it('B puis quitter puis « Continuer » : le cœur UTILISÉ ne revient pas (aucune duplication), le cœur d un autre joueur reste', () => {
    const repo = new MemorySaveRepository(ctx);
    const base = withHearts({ ...newGameSave(SETUPS, level.id), roomIndex: 1 }, ['full', 'half']);
    repo.save(base);
    const sim = createSimulation({ ...buildResumeSimConfig(base, 9), levelId: level.id, heartSlot: true }, level);
    const auto = new AutoSaver({ repository: repo, context: ctx, levelId: level.id, players: SETUPS, existing: base, heartProvider: () => sim.state.players.map((p) => p.heart) });
    auto.handleEvents(sim.step(SIM_STEP_MS, {}));
    // le joueur 1 est blessé et se tient sur le joueur 0 ; le joueur 0 appuie sur B
    sim.state.players[1].hp = 5;
    sim.state.players[1].pos = { ...sim.state.players[0].pos };
    const B = { moveX: 0, moveY: 0, attack: false, interact: false, revive: false, special: false, call: false, heart: true };
    const ev = sim.step(SIM_STEP_MS, { 0: B });
    expect(ev.some((e) => e.type === 'heartUsed' && e.playerId === 0 && e.targetId === 1)).toBe(true);
    expect(sim.state.players[0].heart).toBeUndefined();
    auto.handleEvents(ev);
    const loaded = repo.load();
    expect(loaded.status).toBe('ok');
    if (loaded.status === 'ok') {
      expect(loaded.save.players.map((p) => p.heart)).toEqual([undefined, 'half']);
      const resumed = createSimulation({ ...buildResumeSimConfig(loaded.save, 9), levelId: level.id, heartSlot: true }, level);
      expect(resumed.state.players.map((p) => p.heart)).toEqual([undefined, 'half']);
    }
  });
});
