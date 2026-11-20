/**
 * RELEVÉ = ÉQUIPEMENT RÉCUPÉRABLE : quand un allié relève un joueur, le verrou 'life' de ses objets perdus à la chute est levé pour lui et leur durée de vie remonte à
 * `GEAR_RECOVER_GRACE_MS` au moins (jamais au-delà de `GEAR_TTL_MS`, jamais raccourcie) ; il les reprend en marchant dessus. Couvre : levée du verrou, grâce, objets des autres / verrou
 * 'leave' / objet périmé / objet déjà pris par un allié, bout en bout à 2 joueurs (identique à l'avant-chute), défaite d'équipe, relevé par le changement de salle, appel automatique,
 * sauvegarde (« Continuer »), ancien JSON, évènements, absence de flux aléatoire.
 */
import { describe, expect, it } from 'vitest';
import { AutoSaver } from './autoSave';
import { gearAwaitsOwner } from './autoCall';
import { GEAR_RECOVER_GRACE_MS, GEAR_TTL_MS, REVIVE_INVULN_MS } from './balance';
import { REVIVE_DURATION_MS, ROOM_CLEAR_DELAY_MS, SIM_STEP_MS, WIPE_RESTART_DELAY_MS } from './constants';
import { createLoadout, equippedItems } from './gear';
import { makeTestLevel, makeTestRoom } from './levelValidation';
import { buildResumeSimConfig, newGameSave, withGear, withGearRecovered, type SaveContext } from './save';
import { MemorySaveRepository } from './saveRepository';
import { createSimulation, GameSimulation } from './simulation';
import type { ActionFrame, CharacterId, GearDropState, GearItem, LevelDef, PlayerGear, PlayerId, PlayerSetup, RoomDef, SimEvent, TickInputs } from './types';

const DT = SIM_STEP_MS;
const REVIVE_HELD: ActionFrame = { moveX: 0, moveY: 0, attack: false, interact: false, revive: true };

function setups(n: number, characterId: CharacterId = 'david'): PlayerSetup[] {
  return Array.from({ length: n }, (_, i) => ({ id: i as PlayerId, characterId, difficulty: 2 }));
}

function room(id: string, over: Partial<RoomDef> = {}): RoomDef {
  return makeTestRoom({ id, exit: { rect: { x: 9, y: 5, w: 2, h: 2 }, requires: [] }, mechanisms: [{ id: 'p1', type: 'plate', tile: [6, 4] }], ...over });
}

function level(rooms: RoomDef[]): LevelDef {
  rooms[rooms.length - 1].exit.final = true;
  return makeTestLevel({ rooms });
}

function mk(n: number, seed = 5): GameSimulation {
  const lv = level([room('r1'), room('r2')]);
  return createSimulation({ levelId: lv.id, players: setups(n), seed, loot: false, gear: true }, lv);
}

function ofType<T extends SimEvent['type']>(events: readonly SimEvent[], type: T): Extract<SimEvent, { type: T }>[] {
  return events.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);
}

function stepN(s: GameSimulation, n: number, inputs: TickInputs | ((i: number) => TickInputs) = {}): SimEvent[] {
  const all: SimEvent[] = [];
  for (let i = 0; i < n; i++) all.push(...s.step(DT, typeof inputs === 'function' ? inputs(i) : inputs));
  return all;
}

function put(s: GameSimulation, id: PlayerId, x: number, y: number): void {
  s.state.players[id].pos = { x, y };
}

const FULL: PlayerGear = { boots: 1, protection: 2, artifact: 3, magic: 1, weapon: 2, accessory: { kind: 'lantern', level: 2 } };
const MAXED: PlayerGear = { boots: 3, protection: 3, artifact: 3, magic: 3, weapon: 3, accessory: null };

function equip(s: GameSimulation, id: PlayerId, g: PlayerGear): void {
  Object.assign(s.state.players[id].loadout, { ...g, accessory: g.accessory ? { ...g.accessory } : null });
}

function drops(s: GameSimulation): GearDropState[] {
  return s.state.room.gearDrops as GearDropState[];
}

/** Ajoute un objet au sol (comme `addGearDrop`), avec un verrou et une durée de vie au choix. */
function addDrop(s: GameSimulation, item: GearItem, x: number, y: number, over: { lockedFor?: PlayerId | null; ttlMs?: number; lockMode?: 'life' | 'leave' } = {}): GearDropState {
  const id = s.state.nextGearDropId ?? 1;
  s.state.nextGearDropId = id + 1;
  const d: GearDropState = { id, item, pos: { x, y }, ttlMs: over.ttlMs ?? GEAR_TTL_MS, lockedFor: over.lockedFor ?? null, lockMode: over.lockMode ?? 'life' };
  drops(s).push(d);
  return d;
}

/** Place le sauveteur près de la cible et maintient le relevage jusqu'à `playerRevived` (au plus 6 s) ; retourne les événements. */
function reviveBy(s: GameSimulation, rescuer: PlayerId, target: PlayerId): SimEvent[] {
  const t = s.state.players[target];
  put(s, rescuer, t.pos.x + 2, t.pos.y);
  const all: SimEvent[] = [];
  for (let i = 0; i < Math.ceil(6000 / DT); i++) {
    const ev = s.step(DT, { [rescuer]: REVIVE_HELD });
    all.push(...ev);
    if (ev.some((e) => e.type === 'playerRevived')) break;
  }
  return all;
}

/** Joueur 0 équipé de `g`, tombé en (100, 60) (objets éparpillés autour) ; le joueur 1, très bien équipé, est loin (il ne prend rien). Retourne les événements de la chute. */
function fall(s: GameSimulation, g: PlayerGear = FULL): SimEvent[] {
  equip(s, 0, g);
  equip(s, 1, MAXED);
  put(s, 0, 100, 60);
  put(s, 1, 40, 40);
  s.state.players.forEach((p) => (p.invulnMs = 0));
  expect(s.knockDown(0)).toBe(true);
  return stepN(s, 2);
}

/** Marche (téléporte) le joueur 0 sur chacun des objets au sol qui lui appartiennent et avance de quelques pas ; retourne les événements. */
function walkOverDrops(s: GameSimulation, id: PlayerId = 0): SimEvent[] {
  const all: SimEvent[] = [];
  for (const d of drops(s).slice()) {
    put(s, id, d.pos.x, d.pos.y);
    all.push(...stepN(s, 2));
  }
  return all;
}

describe('relevé : levée du verrou et délai de grâce (simulation)', () => {
  it('constante : 8 s, bien en dessous de GEAR_TTL_MS', () => {
    expect(GEAR_RECOVER_GRACE_MS).toBe(8000);
    expect(GEAR_RECOVER_GRACE_MS).toBeLessThan(GEAR_TTL_MS);
  });

  it("à l\'instant du relevage : verrou levé pour le propriétaire (lockedFor null, recoverFor = lui), événement gearRecoverable avec le nombre d\'objets, une seule fois", () => {
    const s = mk(2);
    fall(s);
    expect(drops(s)).toHaveLength(6);
    for (const d of drops(s)) {
      expect(d.lockedFor).toBe(0);
      expect(d.recoverFor).toBeUndefined();
    }
    const ev = reviveBy(s, 1, 0);
    const rec = ofType(ev, 'gearRecoverable');
    expect(rec).toHaveLength(1);
    expect(rec[0]).toMatchObject({ playerId: 0, count: 6 });
    // l'événement suit `playerRevived` dans le même pas
    expect(ev.findIndex((e) => e.type === 'gearRecoverable')).toBe(ev.findIndex((e) => e.type === 'playerRevived') + 1);
    for (const d of drops(s)) {
      expect(d.lockedFor).toBeNull();
      expect(d.recoverFor).toBe(0);
      expect(d.lockMode).toBe('life');
    }
    // aucun nouvel événement les pas suivants
    expect(ofType(stepN(s, 30), 'gearRecoverable')).toHaveLength(0);
  });

  it('délai de grâce : relevé après 14 s au sol, la durée de vie remonte à 8 s (jamais au-delà de GEAR_TTL_MS) ; un objet encore plus vieux que ça y est ramené', () => {
    const s = mk(2);
    fall(s);
    stepN(s, Math.ceil(14_000 / DT)); // 14 s à terre : il reste ~6 s aux objets
    const before = drops(s).map((d) => d.ttlMs);
    expect(before.every((t) => t > 5000 && t < GEAR_RECOVER_GRACE_MS)).toBe(true);
    reviveBy(s, 1, 0);
    // relevé au bout de ~3 s : sans la grâce il resterait ~3 s ; avec la grâce, 8 s moins le pas en cours
    for (const d of drops(s)) {
      expect(d.ttlMs).toBeGreaterThan(GEAR_RECOVER_GRACE_MS - 3 * DT);
      expect(d.ttlMs).toBeLessThanOrEqual(GEAR_RECOVER_GRACE_MS);
    }
  });

  it('jamais RACCOURCIE : un objet qui a plus de 8 s de vie garde sa durée (relevage rapide) ; jamais au-delà de GEAR_TTL_MS', () => {
    const s = mk(2);
    fall(s);
    reviveBy(s, 1, 0);
    // ~3 s de relevage : il restait ~17 s, c'est plus que la grâce : inchangé (le temps de relevage n'est pas rendu)
    for (const d of drops(s)) {
      expect(d.ttlMs).toBeGreaterThan(GEAR_RECOVER_GRACE_MS + 5000);
      expect(d.ttlMs).toBeLessThanOrEqual(GEAR_TTL_MS);
    }
  });

  it("cas limites sur un état construit : durée de vie plus longue conservée (butin tutoriel), objets des autres, butin sans verrou, verrou \'leave\' : INTACTS", () => {
    const s = mk(2);
    equip(s, 1, MAXED);
    put(s, 0, 100, 60);
    put(s, 1, 40, 40);
    s.state.players.forEach((p) => (p.invulnMs = 0));
    s.knockDown(0); // sans équipement : rien ne tombe
    stepN(s, 2);
    const mine = addDrop(s, { slot: 'boots', level: 1 }, 100, 80, { lockedFor: 0, ttlMs: 5000 });
    const mineLong = addDrop(s, { slot: 'weapon', level: 1 }, 100, 40, { lockedFor: 0, ttlMs: 600_000 }); // durée de vie du tutoriel
    const others = addDrop(s, { slot: 'magic', level: 1 }, 140, 80, { lockedFor: 1, ttlMs: 1000 });
    const loot = addDrop(s, { slot: 'artifact', level: 1 }, 60, 80, { lockedFor: null, ttlMs: 1000 });
    const left = addDrop(s, { slot: 'protection', level: 1 }, 80, 90, { lockedFor: 0, lockMode: 'leave', ttlMs: 1000 });
    const otherLeave = addDrop(s, { slot: 'accessory', level: 1, accessory: 'magnet' }, 120, 90, { lockedFor: 1, lockMode: 'leave', ttlMs: 1000 });
    const ev = reviveBy(s, 1, 0);
    expect(ofType(ev, 'gearRecoverable')[0]).toMatchObject({ playerId: 0, count: 2 }); // seulement les deux objets de 'life' à lui (les deux premiers)
    expect(mine.lockedFor).toBeNull();
    expect(mine.recoverFor).toBe(0);
    expect(mine.ttlMs).toBeGreaterThan(GEAR_RECOVER_GRACE_MS - 3 * DT);
    expect(mineLong.recoverFor).toBe(0);
    expect(mineLong.ttlMs).toBeGreaterThan(590_000); // jamais raccourcie
    // les autres : verrou, durée de vie et champ intacts
    expect(others).toMatchObject({ lockedFor: 1, lockMode: 'life' });
    expect(others.recoverFor).toBeUndefined();
    expect(others.ttlMs).toBeLessThan(1000);
    expect(loot.lockedFor).toBeNull();
    expect(loot.recoverFor).toBeUndefined();
    // 'leave' : jamais touché par le relevage (levé par sa propre règle quand son propriétaire est à terre, mais sans recoverFor ni grâce)
    expect(left.recoverFor).toBeUndefined();
    expect(left.lockMode).toBe('leave');
    expect(otherLeave.lockMode).toBe('leave'); // son propriétaire (le sauveteur) s'est éloigné : sa propre règle l'a levé, mais sans recoverFor ni grâce
    expect(otherLeave.recoverFor).toBeUndefined();
  });

  it('un joueur relevé sans aucun objet à lui au sol : aucun événement, aucun texte', () => {
    const s = mk(2);
    fall(s, { boots: 0, protection: 0, artifact: 0, magic: 0, weapon: 0, accessory: null });
    addDrop(s, { slot: 'boots', level: 1 }, 60, 80, { lockedFor: 1 });
    const ev = reviveBy(s, 1, 0);
    expect(ofType(ev, 'playerRevived')).toHaveLength(1);
    expect(ofType(ev, 'gearRecoverable')).toHaveLength(0);
  });

  it("objets PÉRIMÉS (durée de vie écoulée) : rien n\'est restitué ; seuls ceux qui restent sont comptés", () => {
    const s = mk(2);
    fall(s);
    // 19,5 s à terre : tout est périmé AVANT le relevage (le relevage en prend 3)
    const ev = stepN(s, Math.ceil(21_000 / DT), (i) => (i * DT > 17_000 ? { 1: REVIVE_HELD } : {}));
    expect(drops(s)).toHaveLength(0);
    expect(ofType(ev, 'gearRecoverable')).toHaveLength(0);
    expect(s.state.players[0].loadout).toEqual(createLoadout());
  });

  it("objet DÉJÀ RAMASSÉ par un allié avant le relevage : il reste chez l\'allié, aucun transfert forcé, aucun doublon", () => {
    const s = mk(2);
    fall(s);
    // l'allié (qui n'a pas de bottes) passe sur les bottes éparpillées : il les prend (objet strictement meilleur pour lui)
    equip(s, 1, { ...MAXED, boots: 0 });
    const boots = drops(s).find((d) => d.item.slot === 'boots')!;
    put(s, 1, boots.pos.x, boots.pos.y);
    const taken = ofType(stepN(s, 2), 'gearPicked');
    expect(taken).toHaveLength(1);
    expect(taken[0].playerId).toBe(1);
    expect(taken[0].recovered).toBeUndefined(); // pas un objet repris par son propriétaire
    expect(s.state.players[1].loadout.boots).toBe(1);
    const ev = reviveBy(s, 1, 0);
    expect(ofType(ev, 'gearRecoverable')[0].count).toBe(5);
    walkOverDrops(s);
    const mine = s.state.players[0].loadout;
    expect(mine.boots).toBe(0); // resté chez l'allié
    expect(s.state.players[1].loadout.boots).toBe(1);
    expect(mine.protection).toBe(2);
    expect(mine.artifact).toBe(3);
    expect(mine.weapon).toBe(2);
    expect(mine.accessory).toEqual({ kind: 'lantern', level: 2 });
    expect(drops(s)).toHaveLength(0);
  });
});

describe('relevé : bout en bout à 2 joueurs', () => {
  it("A équipé tombe, objets éparpillés ; B relève A ; A reprend ses objets : équipement IDENTIQUE à l\'avant-chute (aucune amélioration, aucun doublon)", () => {
    const s = mk(2);
    const before = createLoadout();
    Object.assign(before, { ...FULL, accessory: { ...FULL.accessory! } });
    const fallEv = fall(s);
    expect(ofType(fallEv, 'gearLost')[0].items).toHaveLength(6);
    expect(s.state.players[0].loadout).toEqual(createLoadout());
    // pendant qu'il est à terre, A ne ramasse rien, même en se tenant sur ses objets
    expect(ofType(walkOverDrops(s), 'gearPicked')).toHaveLength(0);
    expect(drops(s)).toHaveLength(6);
    put(s, 0, 100, 60);
    const ev = reviveBy(s, 1, 0);
    expect(s.state.players[0].status).toBe('alive');
    expect(s.state.players[0].invulnMs).toBeGreaterThan(0);
    expect(s.state.players[0].invulnMs).toBeLessThanOrEqual(REVIVE_INVULN_MS);
    expect(ofType(ev, 'gearRecoverable')).toHaveLength(1);
    // pas de duplication : tant qu'il n'a rien repris, son équipement est vide et les 6 objets sont au sol
    expect(s.state.players[0].loadout).toEqual(createLoadout());
    expect(drops(s)).toHaveLength(6);
    const picks = ofType(walkOverDrops(s), 'gearPicked');
    expect(picks).toHaveLength(6);
    expect(picks.every((p) => p.playerId === 0 && p.recovered === true && p.replaced === null)).toBe(true);
    expect(s.state.players[0].loadout).toEqual(before);
    expect(equippedItems(s.state.players[0].loadout)).toHaveLength(6);
    expect(drops(s)).toHaveLength(0);
    // rien ne revient plus tard : ni doublon, ni reprise supplémentaire
    expect(ofType(stepN(s, 60), 'gearPicked')).toHaveLength(0);
    expect(s.state.players[0].loadout).toEqual(before);
    // l'allié n'a rien pris (il porte déjà mieux)
    expect(s.state.players[1].loadout).toMatchObject({ boots: 3, protection: 3, artifact: 3, magic: 3, weapon: 3 });
  });

  it("en MARCHANT dessus sans aucun bouton : l\'allié qui relève (équipement faible) peut aussi ramasser, mais jamais un objet que le propriétaire a déjà repris", () => {
    const s = mk(2);
    fall(s, { boots: 2, protection: 0, artifact: 0, magic: 0, weapon: 0, accessory: null });
    expect(drops(s)).toHaveLength(1);
    reviveBy(s, 1, 0);
    const d = drops(s)[0];
    // A est le plus proche : il prend son objet, B ne peut plus le prendre
    put(s, 0, d.pos.x, d.pos.y);
    put(s, 1, d.pos.x + 10, d.pos.y);
    equip(s, 1, { ...MAXED, boots: 0 });
    const ev = stepN(s, 2);
    const picked = ofType(ev, 'gearPicked');
    expect(picked).toHaveLength(1);
    expect(picked[0].playerId).toBe(0);
    expect(picked[0].recovered).toBe(true);
    expect(s.state.players[1].loadout.boots).toBe(0);
  });

  it("les alliés PEUVENT toujours prendre un objet du joueur relevé s\'il est plus proche d\'eux (aucune protection exclusive : transfert possible, documenté)", () => {
    const s = mk(2);
    fall(s, { boots: 2, protection: 0, artifact: 0, magic: 0, weapon: 0, accessory: null });
    reviveBy(s, 1, 0);
    const d = drops(s)[0];
    put(s, 0, 40, 40);
    equip(s, 1, { ...MAXED, boots: 0 });
    put(s, 1, d.pos.x, d.pos.y);
    const picked = ofType(stepN(s, 2), 'gearPicked');
    expect(picked).toHaveLength(1);
    expect(picked[0].playerId).toBe(1);
    expect(picked[0].recovered).toBeUndefined(); // pris par un allié : pas une reprise
  });

  it('variante : B a pris un objet avant le relevage ; A reprend le reste et ne récupère rien en double', () => {
    const s = mk(2);
    fall(s);
    equip(s, 1, { ...MAXED, weapon: 0 });
    const w = drops(s).find((d) => d.item.slot === 'weapon')!;
    put(s, 1, w.pos.x, w.pos.y);
    stepN(s, 2);
    expect(s.state.players[1].loadout.weapon).toBe(2);
    reviveBy(s, 1, 0);
    walkOverDrops(s);
    const mine = s.state.players[0].loadout;
    expect(mine).toMatchObject({ boots: 1, protection: 2, artifact: 3, magic: 1, weapon: 0 });
    expect(mine.accessory).toEqual({ kind: 'lantern', level: 2 });
    // un seul exemplaire de l'arme niveau II dans toute la partie
    const weapons = s.state.players.filter((p) => p.loadout.weapon === 2).length + drops(s).filter((d) => d.item.slot === 'weapon').length;
    expect(weapons).toBe(1);
  });

  it('variante : relevé APRÈS 15 s de chute, la durée de vie est remontée à 8 s : A a le temps de tout reprendre', () => {
    const s = mk(2);
    fall(s);
    stepN(s, Math.ceil(15_000 / DT));
    expect(drops(s).length).toBe(6); // ~5 s restantes : pas encore périmés
    const ev = reviveBy(s, 1, 0);
    // ~3 s de relevage pendant lesquelles ils auraient disparu sans la grâce (il ne leur restait que ~2 s)
    expect(ofType(ev, 'gearRecoverable')[0].count).toBe(6);
    for (const d of drops(s)) expect(d.ttlMs).toBeGreaterThan(GEAR_RECOVER_GRACE_MS - 3 * DT);
    walkOverDrops(s);
    expect(equippedItems(s.state.players[0].loadout)).toHaveLength(6);
  });

  it('les bonus TEMPORAIRES restent perdus (non éparpillés, non récupérables) et le cœur rangé tombé reste ramassable par tous', () => {
    const lv = level([room('r1'), room('r2')]);
    const s = createSimulation({ levelId: lv.id, players: setups(2), seed: 5, loot: false, gear: true, heartSlot: true }, lv);
    equip(s, 1, MAXED);
    s.state.players[0].loadout.boots = 1;
    s.state.players[0].loadout.buffs = [{ kind: 'speed', remainingMs: 5000 }];
    s.state.players[0].heart = 'full';
    put(s, 0, 100, 60);
    put(s, 1, 40, 40);
    s.state.players.forEach((p) => (p.invulnMs = 0));
    s.knockDown(0);
    stepN(s, 2);
    expect(s.state.players[0].loadout.buffs).toEqual([]);
    const pk = s.state.room.pickups?.[0];
    expect(pk).toBeDefined();
    reviveBy(s, 1, 0);
    expect(s.state.players[0].loadout.buffs).toEqual([]); // aucune restitution des bonus
    walkOverDrops(s);
    expect(s.state.players[0].loadout.buffs).toEqual([]);
    expect(s.state.players[0].loadout.boots).toBe(1);
    // le cœur (jamais verrouillé, aucune règle nouvelle) a été ramassé comme avant : par le premier joueur debout à portée (ici le sauveteur, emplacement libre), sans rien changer pour son propriétaire
    expect(s.state.room.pickups ?? []).toHaveLength(0);
    expect(s.state.players[1].heart).toBe('full');
    expect(s.state.players[0].heart).toBeUndefined();
  });
});

describe('relevé : chemins qui ne restituent rien', () => {
  it("DÉFAITE D\'ÉQUIPE : aucun relevage possible, rien n\'est récupéré ; après le redémarrage de salle les objets au sol ont disparu", () => {
    const s = mk(2);
    equip(s, 0, FULL);
    equip(s, 1, { boots: 3, protection: 0, artifact: 0, magic: 0, weapon: 0, accessory: null });
    put(s, 0, 100, 60);
    put(s, 1, 150, 90);
    s.state.players.forEach((p) => (p.invulnMs = 0));
    s.knockDown(0);
    s.knockDown(1);
    const ev = stepN(s, 2);
    expect(ofType(ev, 'teamWipe')).toHaveLength(1);
    expect(drops(s).length).toBeGreaterThan(0);
    expect(drops(s).every((d) => d.lockedFor !== null && d.recoverFor === undefined)).toBe(true);
    const after = stepN(s, Math.ceil(WIPE_RESTART_DELAY_MS / DT) + 5);
    expect(ofType(after, 'roomEntered').some((e) => e.reason === 'restart')).toBe(true);
    expect(ofType(after, 'gearRecoverable')).toHaveLength(0);
    expect(ofType(after, 'gearPicked')).toHaveLength(0);
    expect(drops(s)).toHaveLength(0);
    for (const p of s.state.players) {
      expect(p.status).toBe('alive');
      expect(p.loadout).toEqual(createLoadout());
    }
  });

  it("CHANGEMENT DE SALLE : le relevage d\'office des joueurs à terre (reviveAllDowned) ne restitue rien et ne lève aucun verrou inexistant", () => {
    const s = mk(2);
    fall(s); // A à terre avec 6 objets au sol
    // B rejoint la sortie : salle terminée, A (à terre) sera relevé d'office à la salle suivante
    put(s, 1, 10 * 16, 6 * 16);
    const ev = stepN(s, 3);
    expect(ofType(ev, 'roomCleared')).toHaveLength(1);
    expect(s.state.phase).toBe('roomCleared');
    expect(drops(s).every((d) => d.lockedFor === 0 && d.recoverFor === undefined)).toBe(true);
    const next = stepN(s, Math.ceil(ROOM_CLEAR_DELAY_MS / DT) + 5);
    expect(ofType(next, 'roomEntered').some((e) => e.reason === 'next')).toBe(true);
    expect(ofType(next, 'gearRecoverable')).toHaveLength(0);
    expect(ofType(next, 'gearPicked')).toHaveLength(0);
    expect(s.state.players[0].status).toBe('alive');
    expect(s.state.players[0].loadout).toEqual(createLoadout()); // règle d'avant : le relevé d'office revient sans équipement
    expect(drops(s)).toHaveLength(0);
    expect(s.state.roomIndex).toBe(1);
  });

  it("un « relevage » par modification directe de l\'état (hors updateRevive) ne lève pas le verrou : seul un vrai relevage par un allié le fait", () => {
    const s = mk(2);
    fall(s);
    const p0 = s.state.players[0];
    p0.status = 'alive';
    p0.hp = p0.maxHp;
    expect(drops(s).every((d) => d.lockedFor === 0)).toBe(true);
    expect(ofType(walkOverDrops(s), 'gearPicked')).toHaveLength(0);
    expect(p0.loadout).toEqual(createLoadout());
  });

  it("chute, relevage, NOUVELLE chute avant d\'avoir tout repris : les objets restants restent récupérables au relevage suivant, sans doublon", () => {
    const s = mk(2);
    fall(s);
    reviveBy(s, 1, 0);
    // A reprend deux objets seulement
    const first = drops(s).slice(0, 2);
    for (const d of first) {
      put(s, 0, d.pos.x, d.pos.y);
      stepN(s, 2);
    }
    expect(equippedItems(s.state.players[0].loadout)).toHaveLength(2);
    expect(drops(s)).toHaveLength(4);
    // il retombe : ses deux objets repris sont perdus à nouveau (verrouillés pour lui), les quatre autres gardent leur propriétaire
    s.state.players[0].invulnMs = 0;
    s.knockDown(0);
    stepN(s, 2);
    expect(drops(s)).toHaveLength(6);
    expect(equippedItems(s.state.players[0].loadout)).toHaveLength(0);
    const ev = reviveBy(s, 1, 0);
    expect(ofType(ev, 'gearRecoverable')[0].count).toBe(6);
    walkOverDrops(s);
    expect(equippedItems(s.state.players[0].loadout)).toHaveLength(6);
    expect(drops(s)).toHaveLength(0);
  });
});

describe('relevé : compatibilité et déterminisme', () => {
  it("un état sans relevage n\'a PAS le champ recoverFor (identique octet pour octet à celui d\'avant) ; un ancien JSON reste valide et fonctionnel", () => {
    const s = mk(2);
    fall(s);
    expect(s.serialize()).not.toContain('recoverFor');
    // ancien JSON : aucun champ recoverFor, rechargé tel quel, puis relevage : le champ n'apparaît qu'à ce moment
    const lv = level([room('r1'), room('r2')]);
    const s2 = GameSimulation.restore(s.serialize(), lv);
    expect(s2.serialize()).toBe(s.serialize());
    const ev = reviveBy(s2, 1, 0);
    expect(ofType(ev, 'gearRecoverable')).toHaveLength(1);
    expect(s2.serialize()).toContain('recoverFor');
    walkOverDrops(s2);
    expect(equippedItems(s2.state.players[0].loadout)).toHaveLength(6);
  });

  it('un snapshot pris APRÈS le relevage (avec recoverFor) se restaure et la récupération continue', () => {
    const s = mk(2);
    fall(s);
    reviveBy(s, 1, 0);
    const lv = level([room('r1'), room('r2')]);
    const s2 = GameSimulation.restore(s.serialize(), lv);
    walkOverDrops(s2);
    expect(equippedItems(s2.state.players[0].loadout)).toHaveLength(6);
  });

  it("déterminisme et aucun flux aléatoire : deux exécutions identiques ; le flux de l\'équipement et le flux principal ne bougent pas au relevage", () => {
    const run = (): GameSimulation => {
      const s = mk(2, 11);
      fall(s);
      stepN(s, 40);
      reviveBy(s, 1, 0);
      walkOverDrops(s);
      return s;
    };
    const a = run();
    const b = run();
    expect(a.serialize()).toBe(b.serialize());
    const c = mk(2, 11);
    fall(c);
    const rngBefore = [c.state.rngState, c.state.gearRngState, c.state.lootRngState];
    reviveBy(c, 1, 0);
    walkOverDrops(c);
    expect([c.state.rngState, c.state.gearRngState, c.state.lootRngState]).toEqual(rngBefore);
  });

  it("chute ET relevage sans équipement (cas courant) : l\'état final est identique à celui d\'avant l\'ajout (aucun événement ni champ nouveau)", () => {
    const s = mk(2);
    equip(s, 1, MAXED);
    put(s, 0, 100, 60);
    put(s, 1, 40, 40);
    s.state.players.forEach((p) => (p.invulnMs = 0));
    s.knockDown(0);
    const ev = stepN(s, 2).concat(reviveBy(s, 1, 0));
    expect(ofType(ev, 'gearRecoverable')).toHaveLength(0);
    expect(s.serialize()).not.toContain('recoverFor');
    expect(REVIVE_DURATION_MS).toBe(3000); // le relevage lui-même est inchangé
  });
});

describe('relevé : sauvegarde (« Continuer »)', () => {
  const SETUPS: PlayerSetup[] = [
    { id: 0, characterId: 'david', difficulty: 2 },
    { id: 1, characterId: 'sandrine', difficulty: 1 },
  ];
  function world(): { sim: GameSimulation; repo: MemorySaveRepository; auto: AutoSaver; ctx: SaveContext; lv: LevelDef } {
    const lv = level([room('r1'), room('r2'), room('r3')]);
    const ctx: SaveContext = { levels: [{ id: lv.id, roomCount: 3 }] };
    const repo = new MemorySaveRepository(ctx);
    const base = withGear({ ...newGameSave(SETUPS, lv.id), roomIndex: 1 }, [FULL, MAXED]);
    repo.save(base);
    const sim = createSimulation({ ...buildResumeSimConfig(base, 9), levelId: lv.id }, lv);
    const auto = new AutoSaver({ repository: repo, context: ctx, levelId: lv.id, players: SETUPS, existing: base, gearProvider: () => sim.state.players.map((p) => ({ ...p.loadout })) });
    return { sim, repo, auto, ctx, lv };
  }
  const saved = (repo: MemorySaveRepository): PlayerGear | undefined => {
    const r = repo.load();
    if (r.status !== 'ok') throw new Error('sauvegarde absente');
    return r.save.players[0].gear;
  };
  /** Pas de simulation + relais des événements à l'AutoSaver. */
  function tick(w: ReturnType<typeof world>, n: number, inputs: TickInputs = {}): SimEvent[] {
    const all: SimEvent[] = [];
    for (let i = 0; i < n; i++) {
      const ev = w.sim.step(DT, inputs);
      w.auto.handleEvents(ev);
      all.push(...ev);
    }
    return all;
  }

  it("chute -> perte écrite -> relevage -> récupération : l\'équipement repris est ÉCRIT au ramassage ; quitter puis Continuer le restitue (jamais plus que ce qui a été repris)", () => {
    const w = world();
    tick(w, 1);
    expect(saved(w.repo)).toMatchObject({ boots: 1, protection: 2 });
    put(w.sim, 0, 100, 60);
    put(w.sim, 1, 40, 40);
    w.sim.state.players.forEach((p) => (p.invulnMs = 0));
    w.sim.knockDown(0);
    tick(w, 2);
    expect(saved(w.repo)).toBeUndefined(); // la PERTE est écrite dès la chute (inchangé)
    // relevage par B puis A reprend 3 objets seulement
    put(w.sim, 1, 102, 60);
    tick(w, Math.ceil(REVIVE_DURATION_MS / DT) + 10, { 1: REVIVE_HELD });
    expect(w.sim.state.players[0].status).toBe('alive');
    expect(saved(w.repo)).toBeUndefined(); // rien n'est encore repris : toujours rien d'écrit (aucune restitution à la simple levée du verrou)
    const picks: string[] = [];
    for (const d of drops(w.sim).slice(0, 3)) {
      put(w.sim, 0, d.pos.x, d.pos.y);
      const ev = tick(w, 2);
      for (const p of ofType(ev, 'gearPicked')) picks.push(p.item.slot);
    }
    expect(picks).toHaveLength(3);
    const g = saved(w.repo);
    expect(g).toBeDefined();
    // l'écriture porte EXACTEMENT les objets repris (les trois premiers de l'ordre d'équipement : bottes, protection, artefact)
    expect(g).toMatchObject({ boots: 1, protection: 2, artifact: 3, magic: 0, weapon: 0, accessory: null });
    // « Continuer » : une nouvelle simulation reprend avec cet équipement (partiel), pas l'ancien
    const r = w.repo.load();
    if (r.status !== 'ok') throw new Error('absente');
    const resumed = createSimulation({ ...buildResumeSimConfig(r.save, 3), levelId: w.lv.id }, w.lv);
    expect(resumed.state.players[0].loadout).toMatchObject({ boots: 1, protection: 2, artifact: 3, magic: 0, weapon: 0, accessory: null });
    expect(resumed.state.players[1].loadout).toMatchObject({ boots: 3 });
  });

  it("tout repris : la sauvegarde contient l\'équipement d\'avant la chute ; sans reprise (objets périmés), « Continuer » ne restitue RIEN", () => {
    const w = world();
    tick(w, 1);
    put(w.sim, 0, 100, 60);
    put(w.sim, 1, 40, 40);
    w.sim.state.players.forEach((p) => (p.invulnMs = 0));
    w.sim.knockDown(0);
    tick(w, 2);
    put(w.sim, 1, 102, 60);
    tick(w, Math.ceil(REVIVE_DURATION_MS / DT) + 10, { 1: REVIVE_HELD });
    for (const d of drops(w.sim).slice()) {
      put(w.sim, 0, d.pos.x, d.pos.y);
      tick(w, 2);
    }
    expect(saved(w.repo)).toEqual(FULL);
    // variante : un autre joueur tombé, objets laissés périmer : rien d'écrit
    const w2 = world();
    tick(w2, 1);
    put(w2.sim, 0, 100, 60);
    put(w2.sim, 1, 40, 40);
    w2.sim.state.players.forEach((p) => (p.invulnMs = 0));
    w2.sim.knockDown(0);
    tick(w2, 2);
    put(w2.sim, 1, 102, 60);
    tick(w2, Math.ceil(25_000 / DT));
    expect(drops(w2.sim)).toHaveLength(0);
    expect(saved(w2.repo)).toBeUndefined();
  });

  it("un ramassage ORDINAIRE en cours de salle (hors récupération) n\'est toujours pas écrit avant la salle suivante", () => {
    const w = world();
    tick(w, 1);
    const before = w.repo.writes;
    w.sim.state.players[1].loadout.weapon = 0;
    addDrop(w.sim, { slot: 'weapon', level: 3 }, 200, 100);
    put(w.sim, 1, 200, 100);
    put(w.sim, 0, 40, 40);
    const ev = tick(w, 2);
    expect(ofType(ev, 'gearPicked')).toHaveLength(1);
    expect(w.repo.writes).toBe(before);
  });

  it("l\'objet repris par un ALLIÉ n\'est jamais écrit pour le propriétaire ; sans gearProvider rien n\'est écrit", () => {
    const w = world();
    tick(w, 1);
    put(w.sim, 0, 100, 60);
    put(w.sim, 1, 40, 40);
    w.sim.state.players.forEach((p) => (p.invulnMs = 0));
    w.sim.knockDown(0);
    tick(w, 2);
    equip(w.sim, 1, { ...MAXED, boots: 0 });
    const boots = drops(w.sim).find((d) => d.item.slot === 'boots')!;
    put(w.sim, 1, boots.pos.x, boots.pos.y);
    tick(w, 2);
    expect(saved(w.repo)).toBeUndefined();
    const repo2 = new MemorySaveRepository(w.ctx);
    const auto2 = new AutoSaver({ repository: repo2, context: w.ctx, levelId: w.lv.id, players: SETUPS });
    const ev: SimEvent = { type: 'gearPicked', dropId: 1, playerId: 0, item: { slot: 'boots', level: 1 }, replaced: null, pos: { x: 0, y: 0 }, recovered: true };
    expect(auto2.handleEvents([ev])).toBe(false);
    expect(repo2.writes).toBe(0);
  });

  it("perte et reprise dans le MÊME pas (chute postérieure) : l\'ordre des événements est respecté (la perte l\'emporte)", () => {
    const w = world();
    tick(w, 1);
    const recovered: SimEvent = { type: 'gearPicked', dropId: 1, playerId: 0, item: { slot: 'boots', level: 1 }, replaced: null, pos: { x: 0, y: 0 }, recovered: true };
    const lost: SimEvent = { type: 'gearLost', playerId: 0, items: [], pos: { x: 0, y: 0 } };
    w.auto.handleEvents([lost]);
    expect(saved(w.repo)).toBeUndefined();
    w.auto.handleEvents([recovered, lost]);
    expect(saved(w.repo)).toBeUndefined();
    w.auto.handleEvents([lost, recovered]);
    expect(saved(w.repo)).toMatchObject({ boots: 1 });
  });
});

describe('relevé : appel automatique', () => {
  /** Pose B (équipement fort : il refuse tout) sur chaque objet de `list` à tour de rôle, A loin ; retourne les appels de B. */
  function callsOfB(s: GameSimulation, list: GearDropState[]): Extract<SimEvent, { type: 'autoCallStarted' }>[] {
    const calls: Extract<SimEvent, { type: 'autoCallStarted' }>[] = [];
    put(s, 0, 40, 40);
    for (const d of list) {
      put(s, 1, d.pos.x, d.pos.y);
      calls.push(...ofType(stepN(s, 90), 'autoCallStarted').filter((e) => e.playerId === 1));
    }
    return calls;
  }

  it("un objet du joueur relevé que son propriétaire va reprendre ne déclenche AUCUN appel d'un allié qui le refuse (pas d'appel fantôme) ; un objet ordinaire, si", () => {
    const s = mk(2);
    fall(s, { boots: 1, protection: 2, artifact: 0, magic: 0, weapon: 0, accessory: null });
    reviveBy(s, 1, 0);
    const mine = drops(s).slice();
    expect(mine.every((d) => d.recoverFor === 0 && d.lockedFor === null)).toBe(true);
    // un objet ordinaire (butin) à côté : refusé par B, utile à A (emplacement vide) : appel normal
    const loot = addDrop(s, { slot: 'weapon', level: 1 }, 160, 100);
    expect(callsOfB(s, mine)).toHaveLength(0);
    // le contrôle : sans le souvenir du propriétaire (objet ordinaire), le même refus déclenche l'appel vers A
    const control = callsOfB(s, [loot]);
    expect(control).toHaveLength(1);
    expect(control[0].to).toEqual([0]);
  });

  it('avant le relevage (propriétaire à terre) rien ne change : les objets verrouillés sont refusés comme avant (aucun destinataire vivant utile)', () => {
    const s = mk(2);
    fall(s, { boots: 1, protection: 0, artifact: 0, magic: 0, weapon: 0, accessory: null });
    expect(callsOfB(s, drops(s).slice())).toHaveLength(0); // A est à terre : personne à prévenir
  });

  it("gearAwaitsOwner : propriétaire vivant qui peut le prendre (equip / upgrade) = vrai ; absent, à terre, ou qui ne peut pas (équipement déjà meilleur, accessoire d'une autre sorte) = faux", () => {
    const owner = { id: 0 as PlayerId, status: 'alive' as const, loadout: createLoadout() };
    const item: GearItem = { slot: 'boots', level: 2 };
    expect(gearAwaitsOwner([owner], { item, recoverFor: 0 })).toBe(true);
    expect(gearAwaitsOwner([owner], { item })).toBe(false);
    expect(gearAwaitsOwner([owner], { item, recoverFor: 1 })).toBe(false); // propriétaire inconnu
    expect(gearAwaitsOwner([{ ...owner, status: 'down' }], { item, recoverFor: 0 })).toBe(false);
    expect(gearAwaitsOwner([{ ...owner, loadout: { ...createLoadout(), boots: 3 } }], { item, recoverFor: 0 })).toBe(false);
    const lantern: GearItem = { slot: 'accessory', level: 1, accessory: 'lantern' };
    expect(gearAwaitsOwner([owner], { item: lantern, recoverFor: 0 })).toBe(true); // accessoire vide : equip
    const withMagnet = { ...owner, loadout: { ...createLoadout(), accessory: { kind: 'magnet' as const, level: 1 as const } } };
    expect(gearAwaitsOwner([withMagnet], { item: lantern, recoverFor: 0 })).toBe(false); // 'swap' : échange manuel, pas une reprise automatique
  });

  it('le propriétaire lui-même qui REFUSE un de ses objets (il porte mieux) appelle normalement ses alliés (refus ordinaire)', () => {
    const s = mk(2);
    fall(s, { boots: 1, protection: 0, artifact: 0, magic: 0, weapon: 0, accessory: null });
    reviveBy(s, 1, 0);
    const d = drops(s)[0];
    equip(s, 0, { ...MAXED }); // A a ramassé mieux entre-temps
    equip(s, 1, { ...MAXED, boots: 0 }); // B n'a pas de bottes : l'objet lui serait utile
    put(s, 1, 40, 40);
    put(s, 0, d.pos.x, d.pos.y);
    const calls = ofType(stepN(s, 90), 'autoCallStarted').filter((e) => e.playerId === 0);
    expect(calls).toHaveLength(1);
    expect(calls[0].to).toEqual([1]);
  });
});

describe('relevé : corrections après relecture adversariale', () => {
  const LANTERN: GearItem = { slot: 'accessory', level: 2, accessory: 'lantern' };
  const MAGNET: GearItem = { slot: 'accessory', level: 1, accessory: 'magnet' };
  const PRESS: ActionFrame = { moveX: 0, moveY: 0, attack: false, interact: true, revive: false };
  const RELEASE: ActionFrame = { moveX: 0, moveY: 0, attack: false, interact: false, revive: false };
  const NO_GEAR: PlayerGear = { boots: 0, protection: 0, artifact: 0, magic: 0, weapon: 0, accessory: null };

  it("GRÂCE UNIQUE : chute / relevage en boucle ne ré-arme pas la durée de vie d'objets déjà récupérables (plafond de durée de vie total)", () => {
    const s = mk(2);
    fall(s);
    stepN(s, Math.ceil(15_000 / DT)); // 15 s au sol : 5 s de vie restantes
    reviveBy(s, 1, 0); // 1re grâce : les objets remontent à 8 s
    for (const d of drops(s)) expect(d.ttlMs).toBeGreaterThan(GEAR_RECOVER_GRACE_MS - 500);
    put(s, 0, 40, 40); // A s'éloigne sans rien reprendre
    stepN(s, Math.ceil(3000 / DT)); // il reste ~5 s
    expect(Math.max(...drops(s).map((d) => d.ttlMs))).toBeLessThan(GEAR_RECOVER_GRACE_MS - 1000);
    s.state.players[0].invulnMs = 0;
    expect(s.knockDown(0)).toBe(true); // retombe sans équipement : rien de nouveau au sol
    stepN(s, 2);
    const ev = reviveBy(s, 1, 0); // 2e relevage
    // les objets sont toujours comptés (retour visuel) mais leur durée de vie n'est PAS remontée à 8 s
    expect(ofType(ev, 'gearRecoverable')[0].count).toBe(6);
    for (const d of drops(s)) expect(d.ttlMs).toBeLessThan(GEAR_RECOVER_GRACE_MS - 1500);
    // et ils finissent par périr : durée de vie totale bornée
    stepN(s, Math.ceil(GEAR_TTL_MS / DT));
    expect(drops(s)).toHaveLength(0);
  });

  it('une chute à objets NOUVEAUX après un 1er relevage : les nouveaux ont la grâce (une fois), les anciens ne sont pas ré-armés', () => {
    const s = mk(2);
    fall(s);
    stepN(s, Math.ceil(15_000 / DT));
    reviveBy(s, 1, 0);
    // A reprend 2 objets (perdus à la prochaine chute), s'éloigne : les 4 autres restent
    for (const d of drops(s).slice(0, 2)) {
      put(s, 0, d.pos.x, d.pos.y);
      stepN(s, 2);
    }
    put(s, 0, 40, 40);
    stepN(s, Math.ceil(3000 / DT));
    s.state.players[0].invulnMs = 0;
    s.knockDown(0);
    stepN(s, 2);
    const olds = drops(s).filter((d) => d.recoverFor === 0);
    const news = drops(s).filter((d) => d.lockedFor === 0);
    expect(olds).toHaveLength(4);
    expect(news).toHaveLength(2);
    const oldTtl = olds.map((d) => d.ttlMs);
    reviveBy(s, 1, 0);
    olds.forEach((d, i) => expect(d.ttlMs).toBeLessThanOrEqual(oldTtl[i]));
    for (const d of news) expect(d.ttlMs).toBeGreaterThanOrEqual(GEAR_RECOVER_GRACE_MS - 500); // 20 s d'origine, jamais raccourcis
  });

  it("APPEL FANTÔME : à 3 joueurs, un allié qui refuse l'objet éparpillé d'un joueur À TERRE n'appelle personne (objet verrouillé 'life') ; le contrôle d'un butin ordinaire appelle", () => {
    const s = mk(3);
    fall(s, { ...NO_GEAR, boots: 1 }); // 1 objet au sol, A à terre
    put(s, 2, 40, 60); // C, vide : l'objet lui serait utile
    const boots = drops(s)[0];
    expect(boots.lockedFor).toBe(0);
    equip(s, 1, { ...MAXED }); // B refuse tout
    put(s, 1, boots.pos.x, boots.pos.y);
    const calls = ofType(stepN(s, 90), 'autoCallStarted').filter((e) => e.playerId === 1);
    expect(calls).toHaveLength(0);
    // contrôle : butin ordinaire (non verrouillé) refusé par B : C est appelé
    drops(s).length = 0;
    addDrop(s, { slot: 'boots', level: 1 }, 100, 90);
    put(s, 1, 100, 90);
    const control = ofType(stepN(s, 90), 'autoCallStarted').filter((e) => e.playerId === 1);
    expect(control).toHaveLength(1);
    expect(control[0].to).toEqual([2]);
  });

  it('knockDown(id, ttl) : l\'équipement perdu vit `ttl` (tutoriel) ; sans paramètre (ou valeur invalide) : GEAR_TTL_MS comme avant', () => {
    const run = (ttl?: number): number[] => {
      const s = mk(2);
      equip(s, 0, FULL);
      put(s, 0, 100, 60);
      put(s, 1, 40, 40);
      s.state.players.forEach((p) => (p.invulnMs = 0));
      if (ttl === undefined) s.knockDown(0);
      else s.knockDown(0, ttl);
      return drops(s).map((d) => d.ttlMs);
    };
    expect(run()).toEqual(Array(6).fill(GEAR_TTL_MS));
    expect(run(600_000)).toEqual(Array(6).fill(600_000));
    expect(run(Number.NaN)).toEqual(Array(6).fill(GEAR_TTL_MS));
    expect(run(-5)).toEqual(Array(6).fill(GEAR_TTL_MS));
  });

  it("ÉCHANGE manuel d'un accessoire repris : `gearSwapped.recovered` (absent pour un objet ordinaire)", () => {
    const s = mk(2);
    fall(s, { ...NO_GEAR, accessory: { kind: 'lantern', level: 2 } });
    reviveBy(s, 1, 0);
    // A a entre-temps ramassé un autre accessoire (aimant), puis se place sur sa lanterne perdue
    equip(s, 0, { ...NO_GEAR, accessory: { kind: 'magnet', level: 1 } });
    const lantern = drops(s).find((d) => d.item.slot === 'accessory')!;
    expect(lantern.recoverFor).toBe(0);
    put(s, 0, lantern.pos.x, lantern.pos.y);
    const ev = [...s.step(DT, { 0: PRESS }), ...s.step(DT, { 0: RELEASE })];
    const sw = ofType(ev, 'gearSwapped');
    expect(sw).toHaveLength(1);
    expect(sw[0]).toMatchObject({ playerId: 0, recovered: true });
    expect(s.state.players[0].loadout.accessory).toMatchObject({ kind: 'lantern', level: 2 });
    // contrôle : un accessoire ordinaire échangé n'a PAS le champ
    const t = mk(2);
    equip(t, 0, { ...NO_GEAR, accessory: { kind: 'magnet', level: 1 } });
    put(t, 1, 40, 40);
    addDrop(t, LANTERN, 100, 60);
    put(t, 0, 100, 60);
    const ev2 = [...t.step(DT, { 0: PRESS }), ...t.step(DT, { 0: RELEASE })];
    const sw2 = ofType(ev2, 'gearSwapped');
    expect(sw2).toHaveLength(1);
    expect('recovered' in sw2[0]).toBe(false);
  });

  it('SAUVEGARDE : accessoire repris par ÉCHANGE manuel (chute, relevage, aimant ramassé, échange avec sa lanterne perdue, quitter, Continuer) : la sauvegarde contient la lanterne', () => {
    const setupsAB: PlayerSetup[] = [
      { id: 0, characterId: 'david', difficulty: 2 },
      { id: 1, characterId: 'sandrine', difficulty: 1 },
    ];
    const lv = level([room('r1'), room('r2'), room('r3')]);
    const ctx: SaveContext = { levels: [{ id: lv.id, roomCount: 3 }] };
    const repo = new MemorySaveRepository(ctx);
    const base = withGear({ ...newGameSave(setupsAB, lv.id), roomIndex: 1 }, [{ ...NO_GEAR, accessory: { kind: 'lantern', level: 2 } }, MAXED]);
    repo.save(base);
    const sim = createSimulation({ ...buildResumeSimConfig(base, 9), levelId: lv.id }, lv);
    const auto = new AutoSaver({ repository: repo, context: ctx, levelId: lv.id, players: setupsAB, existing: base, gearProvider: () => sim.state.players.map((p) => ({ ...p.loadout })) });
    const run = (n: number, inputs: TickInputs = {}): void => {
      for (let i = 0; i < n; i++) auto.handleEvents(sim.step(DT, inputs));
    };
    const savedAccessory = (): unknown => {
      const r = repo.load();
      if (r.status !== 'ok') throw new Error('absente');
      return r.save.players[0].gear?.accessory;
    };
    run(1);
    expect(savedAccessory()).toMatchObject({ kind: 'lantern', level: 2 });
    put(sim, 0, 100, 60);
    put(sim, 1, 40, 40);
    sim.state.players.forEach((p) => (p.invulnMs = 0));
    sim.knockDown(0);
    run(2);
    expect(savedAccessory()).toBeUndefined(); // perte écrite
    put(sim, 1, 102, 60);
    run(Math.ceil(REVIVE_DURATION_MS / DT) + 10, { 1: REVIVE_HELD });
    expect(sim.state.players[0].status).toBe('alive');
    // A ramasse un aimant ordinaire (non écrit), puis échange avec sa lanterne
    equip(sim, 0, { ...NO_GEAR, accessory: { kind: 'magnet', level: 1 } });
    expect(savedAccessory()).toBeUndefined();
    const lantern = drops(sim).find((d) => d.item.slot === 'accessory')!;
    put(sim, 0, lantern.pos.x, lantern.pos.y);
    for (const f of [PRESS, RELEASE]) auto.handleEvents(sim.step(DT, { 0: f }));
    expect(sim.state.players[0].loadout.accessory).toMatchObject({ kind: 'lantern', level: 2 });
    expect(savedAccessory()).toMatchObject({ kind: 'lantern', level: 2 }); // écrit à la reprise
    const r = repo.load();
    if (r.status !== 'ok') throw new Error('absente');
    const resumed = createSimulation({ ...buildResumeSimConfig(r.save, 3), levelId: lv.id }, lv);
    expect(resumed.state.players[0].loadout.accessory).toMatchObject({ kind: 'lantern', level: 2 });
  });

  it("withGearRecovered : la décision 'swap' n'est acceptée que pour un échange (`swapped`) ; un ramassage ordinaire d'une autre sorte ne change jamais la sauvegarde", () => {
    const setupsAB: PlayerSetup[] = [
      { id: 0, characterId: 'david', difficulty: 2 },
      { id: 1, characterId: 'sandrine', difficulty: 1 },
    ];
    const base = withGear(newGameSave(setupsAB, 'x'), [{ ...NO_GEAR, accessory: { kind: 'magnet', level: 1 } }, MAXED]);
    expect(withGearRecovered(base, 0, LANTERN)).toBe(base); // 'swap' sans échange : inchangé (même référence)
    const sw = withGearRecovered(base, 0, LANTERN, true);
    expect(sw.players[0].gear?.accessory).toMatchObject({ kind: 'lantern', level: 2 });
    expect(withGearRecovered(base, 0, MAGNET, true)).toBe(base); // même sorte, niveau égal : 'ignore'
  });

  it("JSON HOSTILE : `recoverFor` invalide ('x', null, 99, -1, 0.5) à la restauration : aucune exception, la partie continue, aucun objet n'est dupliqué", () => {
    for (const bad of ['x', null, 99, -1, 0.5]) {
      const s = mk(2);
      fall(s);
      reviveBy(s, 1, 0);
      const snap = JSON.parse(s.serialize());
      for (const d of snap.room.gearDrops) d.recoverFor = bad;
      const lv = level([room('r1'), room('r2')]);
      const s2 = GameSimulation.restore(JSON.stringify(snap), lv);
      expect(() => stepN(s2, 120)).not.toThrow();
      // le propriétaire peut toujours ramasser (verrou nul) : aucun doublon
      walkOverDrops(s2);
      const worn = equippedItems(s2.state.players[0].loadout).length;
      expect(worn + drops(s2).length).toBeLessThanOrEqual(6);
      expect(() => JSON.parse(s2.serialize())).not.toThrow();
    }
  });
});
