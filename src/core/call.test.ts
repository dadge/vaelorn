/**
 * Tests de l'« appel » (signal vers l'équipe) : immobilisation de 1 s, signal de 3 s, délai de récupération de 5 s,
 * refus (à terre / déjà en cours / délai / phase), annulation, remise à zéro, interactions avec relevage, blocs, leviers,
 * zones d'objectif, torche, attaques et spéciaux, déterminisme, sérialisation.
 */
import { describe, expect, it } from 'vitest';
import { createEnemyState } from './ai';
import {
  CALL_COOLDOWN_MS,
  CALL_DURATION_MS,
  CALL_FREEZE_MS,
  PLAYER_RADIUS,
  ROOM_CLEAR_DELAY_MS,
  SIM_STEP_MS,
  TILE,
  TORCH_MAX_MS,
  WIPE_RESTART_DELAY_MS,
} from './constants';
import { makeTestLayout, makeTestLevel, makeTestRoom } from './levelValidation';
import {
  applyDamageToPlayer,
  canStartCall,
  CALL_EPSILON_MS,
  createPlayerState,
  isCalling,
  isCallFrozen,
  resetPlayersForRoom,
  startCall,
  stepPlayerTimers,
} from './players';
import { createSimulation, GameSimulation, sanitizeFrame } from './simulation';
import type {
  ActionFrame,
  BlockState,
  CharacterId,
  Difficulty,
  EnemyKind,
  EnemyState,
  LevelDef,
  PlayerId,
  RoomDef,
  SimEvent,
  TickInputs,
} from './types';

const DT = SIM_STEP_MS;

function frame(over: Partial<ActionFrame> = {}): ActionFrame {
  return { moveX: 0, moveY: 0, attack: false, interact: false, revive: false, ...over };
}

/** Arène ouverte 30×20 ; sortie lointaine sans exigence ; une 2e salle finale (pour tester 'next'). */
function openLevel(over: Partial<RoomDef> = {}): LevelDef {
  return makeTestLevel({
    rooms: [
      makeTestRoom({
        id: 'r1',
        layout: makeTestLayout(30, 20),
        playerSpawns: [
          [5, 5],
          [6, 5],
          [5, 6],
          [6, 6],
        ],
        mechanisms: [],
        exit: { rect: { x: 27, y: 17, w: 2, h: 2 }, requires: [] },
        ...over,
      }),
      makeTestRoom({ id: 'r2', exit: { rect: { x: 9, y: 5, w: 2, h: 2 }, requires: [], final: true } }),
    ],
    objectives: [0, 1, 2, 3].map((slot) => ({
      id: `o${slot}`,
      slot,
      roomId: 'r1',
      kind: 'kills' as const,
      labelKey: `objective.test.o${slot}`,
      count: 99,
    })),
  });
}

function makeSim(n = 1, level: LevelDef = openLevel(), chars: CharacterId[] = ['david', 'valentine', 'mira', 'brokk'], seed = 7): GameSimulation {
  return createSimulation(
    {
      levelId: 'test',
      seed,
      players: Array.from({ length: n }, (_, i) => ({ id: i as PlayerId, characterId: chars[i], difficulty: 2 as Difficulty })),
    },
    level,
  );
}

type Script = TickInputs | ((i: number) => TickInputs);

function stepN(s: GameSimulation, n: number, inputs: Script = {}): SimEvent[] {
  const all: SimEvent[] = [];
  for (let i = 0; i < n; i++) all.push(...s.step(DT, typeof inputs === 'function' ? inputs(i) : inputs));
  return all;
}

const count = (ev: readonly SimEvent[], type: SimEvent['type']): number => ev.filter((e) => e.type === type).length;
const CALL: TickInputs = { 0: frame({ call: true }) };

function addFoe(s: GameSimulation, kind: EnemyKind, x: number, y: number, hp = 5000): EnemyState {
  const e = createEnemyState(kind, { x, y }, s.state.nextEntityId++, 0);
  e.hp = hp;
  e.maxHp = hp;
  e.data.stunMs = 1e9;
  e.mode = 'stunned';
  s.state.room.enemies.push(e);
  return e;
}

// ───────────────────────────── Fonctions pures (players.ts) ─────────────────────────────

describe('players : fonctions d\'appel', () => {
  const mk = (id: PlayerId = 0) => createPlayerState({ id, characterId: 'david', difficulty: 2 }, { x: 50, y: 50 });

  it('constantes documentées', () => {
    expect(CALL_FREEZE_MS).toBe(1000);
    expect(CALL_DURATION_MS).toBe(3000);
    expect(CALL_COOLDOWN_MS).toBe(5000);
  });

  it('état initial : aucun appel, délai nul, prev.call faux', () => {
    const p = mk();
    expect(p.callMs).toBe(0);
    expect(p.callCooldownMs).toBe(0);
    expect(p.prev.call).toBe(false);
    expect(isCalling(p)).toBe(false);
    expect(isCallFrozen(p)).toBe(false);
    expect(canStartCall(p)).toBe(true);
  });

  it('startCall : signal 3 s, délai 5 s, immobile ; refus pendant l\'appel et le délai', () => {
    const p = mk();
    startCall(p);
    expect(p.callMs).toBe(CALL_DURATION_MS);
    expect(p.callCooldownMs).toBe(CALL_COOLDOWN_MS);
    expect(isCalling(p)).toBe(true);
    expect(isCallFrozen(p)).toBe(true);
    expect(canStartCall(p)).toBe(false);
  });

  it('stepPlayerTimers : décompte exact, immobilité jusqu\'à 2 s restantes, planchers à 0 sans reste flottant', () => {
    const p = mk();
    startCall(p);
    for (let i = 0; i < 59; i++) stepPlayerTimers(p, DT);
    expect(isCallFrozen(p)).toBe(true); // 59 pas écoulés : encore immobile
    stepPlayerTimers(p, DT);
    expect(isCallFrozen(p)).toBe(false); // 60 pas = 1 s exactement (malgré 1000/60 non représentable)
    expect(isCalling(p)).toBe(true);
    for (let i = 0; i < 119; i++) stepPlayerTimers(p, DT);
    expect(isCalling(p)).toBe(true);
    stepPlayerTimers(p, DT);
    expect(p.callMs).toBe(0);
    expect(p.callCooldownMs).toBeGreaterThan(0);
    for (let i = 0; i < 120; i++) stepPlayerTimers(p, DT);
    expect(p.callCooldownMs).toBe(0);
    expect(canStartCall(p)).toBe(true);
    expect(CALL_EPSILON_MS).toBeGreaterThan(0);
  });

  it('un joueur à terre ne peut pas appeler et n\'est ni « appelant » ni immobilisé', () => {
    const p = mk();
    startCall(p);
    applyDamageToPlayer(p, 99999);
    expect(p.status).toBe('down');
    expect(p.callMs).toBe(0);
    expect(p.callCooldownMs).toBe(CALL_COOLDOWN_MS); // le délai continue de courir
    expect(canStartCall(p)).toBe(false);
    p.callMs = 1000;
    expect(isCalling(p)).toBe(false);
    expect(isCallFrozen(p)).toBe(false);
  });

  it('resetPlayersForRoom remet appel et délai à zéro', () => {
    const p = mk();
    startCall(p);
    resetPlayersForRoom([p], [{ x: 10, y: 10 }]);
    expect(p.callMs).toBe(0);
    expect(p.callCooldownMs).toBe(0);
  });

  it('stepPlayerTimers tolère un joueur ancien format (champs absents ou NaN)', () => {
    const p = mk();
    (p as unknown as Record<string, unknown>).callMs = undefined;
    (p as unknown as Record<string, unknown>).callCooldownMs = Number.NaN;
    stepPlayerTimers(p, DT);
    expect(p.callMs).toBe(0);
    expect(p.callCooldownMs).toBe(0);
  });

  it('sanitizeFrame : call strict (booléen), absent = faux', () => {
    expect(sanitizeFrame(undefined).call).toBe(false);
    expect(sanitizeFrame(frame()).call).toBe(false);
    expect(sanitizeFrame(frame({ call: true })).call).toBe(true);
    expect(sanitizeFrame({ ...frame(), call: 1 as unknown as boolean }).call).toBe(false);
  });
});

// ───────────────────────────── Simulation : déroulé de l'appel ─────────────────────────────

describe('simulation : lancement, immobilisation, signal, délai', () => {
  it('l\'appui lance l\'appel : événement callStarted, callMs = 3 s, délai = 5 s, immédiatement immobile', () => {
    const s = makeSim(1);
    const ev = stepN(s, 1, CALL);
    expect(ev.filter((e) => e.type === 'callStarted')).toEqual([{ type: 'callStarted', playerId: 0 }]);
    const p = s.state.players[0];
    expect(p.callMs).toBe(CALL_DURATION_MS);
    expect(p.callCooldownMs).toBe(CALL_COOLDOWN_MS);
    expect(p.prev.call).toBe(true);
  });

  it('immobilisation EXACTE de 1 s : position inchangée 60 pas malgré un stick plein, puis le héros repart', () => {
    const s = makeSim(1);
    const p = s.state.players[0];
    const x0 = p.pos.x;
    const y0 = p.pos.y;
    const inputs: TickInputs = { 0: frame({ call: true, moveX: 1 }) };
    for (let i = 0; i < 60; i++) {
      s.step(DT, inputs);
      expect(p.pos.x, `pas ${i + 1}`).toBe(x0);
      expect(p.pos.y).toBe(y0);
      expect(p.moving).toBe(false);
    }
    s.step(DT, inputs); // 61e pas : plus immobile (callMs = 2 s)
    expect(p.pos.x).toBeGreaterThan(x0);
    expect(p.moving).toBe(true);
    expect(p.callMs).toBeGreaterThan(0); // le signal continue pendant que le héros marche
  });

  it('le stick maintenu AVANT l\'appui : le héros s\'arrête net au pas de l\'appui', () => {
    const s = makeSim(1);
    const p = s.state.players[0];
    stepN(s, 10, { 0: frame({ moveX: 1 }) });
    const x = p.pos.x;
    stepN(s, 1, { 0: frame({ moveX: 1, call: true }) });
    expect(p.pos.x).toBe(x);
  });

  it('signal de 3 s : 180 états actifs, puis callMs = 0 (sans reste flottant)', () => {
    const s = makeSim(1);
    stepN(s, 1, CALL);
    stepN(s, 179, { 0: frame() });
    expect(s.state.players[0].callMs).toBeGreaterThan(0);
    expect(s.state.players[0].callMs).toBeLessThan(DT + 1e-6);
    stepN(s, 1, { 0: frame() });
    expect(s.state.players[0].callMs).toBe(0);
  });

  it('délai de 5 s depuis l\'appui : nouvel appui accepté exactement 300 pas plus tard, refusé avant', () => {
    const s = makeSim(1);
    const started: number[] = [];
    for (let i = 0; i < 400; i++) {
      // appui répété à chaque pas pair (front montant) : seul le délai peut le refuser
      const ev = s.step(DT, { 0: frame({ call: i % 2 === 0 }) });
      if (ev.some((e) => e.type === 'callStarted')) started.push(s.state.tick);
    }
    expect(started).toHaveLength(2); // appuis refusés aux pas 3, 5, … 299 (délai non écoulé), acceptés au pas 301
    expect(started[1] - started[0]).toBe(CALL_COOLDOWN_MS / DT);
  });

  it('appui maintenu : un seul callStarted (front montant), pas de relance à la fin du délai', () => {
    const s = makeSim(1);
    const ev = stepN(s, 600, CALL);
    expect(count(ev, 'callStarted')).toBe(1);
  });

  it('pendant l\'appel (même hors immobilisation) et pendant le délai, un nouvel appui est refusé', () => {
    const s = makeSim(1);
    stepN(s, 1, CALL);
    // 70e pas : appel encore actif (callMs ≈ 1,8 s), plus immobile
    let ev = stepN(s, 70, (i) => ({ 0: frame({ call: i % 2 === 0 }) }));
    expect(count(ev, 'callStarted')).toBe(0);
    // fin du signal (à ~3 s) mais délai pas écoulé (5 s)
    ev = stepN(s, 150, (i) => ({ 0: frame({ call: i % 2 === 0 }) }));
    expect(s.state.players[0].callMs).toBe(0);
    expect(s.state.players[0].callCooldownMs).toBeGreaterThan(0);
    expect(count(ev, 'callStarted')).toBe(0);
  });

  it('refusé hors phase \'playing\' (roomCleared) ; aucun callStarted', () => {
    const s = makeSim(1);
    const p = s.state.players[0];
    p.pos = { x: 28 * TILE, y: 18 * TILE };
    stepN(s, 2, {});
    expect(s.state.phase).toBe('roomCleared');
    const ev = stepN(s, 5, (i) => ({ 0: frame({ call: i % 2 === 0 }) }));
    expect(count(ev, 'callStarted')).toBe(0);
    expect(p.callMs).toBe(0);
  });

  it('refusé à terre ; autorisé de nouveau une fois relevé (délai nul)', () => {
    const s = makeSim(2);
    applyDamageToPlayer(s.state.players[0], 99999);
    const ev = stepN(s, 5, { 0: frame({ call: true }) });
    expect(count(ev, 'callStarted')).toBe(0);
    expect(s.state.players[0].callMs).toBe(0);
    s.state.players[0].status = 'alive';
    s.state.players[0].hp = s.state.players[0].maxHp;
    const ev2 = stepN(s, 2, (i) => ({ 0: frame({ call: i === 1 }) }));
    expect(count(ev2, 'callStarted')).toBe(1);
  });

  it('annulé si l\'appelant tombe à terre (le délai de récupération continue)', () => {
    const s = makeSim(2);
    stepN(s, 30, CALL);
    expect(s.state.players[0].callMs).toBeGreaterThan(0);
    const downed = applyDamageToPlayer(s.state.players[0], 99999);
    expect(downed.downed).toBe(true);
    expect(s.state.players[0].callMs).toBe(0);
    stepN(s, 1, { 0: frame() });
    expect(s.state.players[0].callMs).toBe(0);
    expect(s.state.players[0].callCooldownMs).toBeGreaterThan(0);
  });

  it('garde-fou : un statut « à terre » posé hors applyDamage annule aussi l\'appel au pas suivant', () => {
    const s = makeSim(2);
    stepN(s, 5, CALL);
    s.state.players[0].status = 'down';
    stepN(s, 1, {});
    expect(s.state.players[0].callMs).toBe(0);
  });

  it('un appelant reste vulnérable pendant l\'immobilisation', () => {
    const s = makeSim(2);
    stepN(s, 5, CALL);
    const p = s.state.players[0];
    const hp = p.hp;
    p.invulnMs = 0;
    const r = applyDamageToPlayer(p, 10);
    expect(r.applied).toBeGreaterThan(0);
    expect(p.hp).toBeLessThan(hp);
    expect(p.callMs).toBeGreaterThan(0); // blessé mais debout : l'appel continue
  });
});

// ───────────────────────────── Remise à zéro ─────────────────────────────

describe('simulation : remise à zéro', () => {
  it('défaite collective : après le redémarrage de la salle, appel et délai sont à zéro et un nouvel appel est possible', () => {
    const s = makeSim(1);
    stepN(s, 5, CALL);
    expect(s.state.players[0].callCooldownMs).toBeGreaterThan(0);
    applyDamageToPlayer(s.state.players[0], 99999);
    const ev = stepN(s, 2, {});
    expect(count(ev, 'teamWipe')).toBe(1);
    const restart = stepN(s, Math.ceil(WIPE_RESTART_DELAY_MS / DT) + 3, {});
    expect(restart.some((e) => e.type === 'roomEntered' && e.reason === 'restart')).toBe(true);
    const p = s.state.players[0];
    expect(p.callMs).toBe(0);
    expect(p.callCooldownMs).toBe(0);
    expect(count(stepN(s, 2, (i) => ({ 0: frame({ call: i === 1 }) })), 'callStarted')).toBe(1);
  });

  it('passage à la salle suivante : appel en cours et délai remis à zéro', () => {
    const s = makeSim(1);
    stepN(s, 3, CALL);
    s.state.players[0].pos = { x: 28 * TILE, y: 18 * TILE };
    const ev = stepN(s, Math.ceil(ROOM_CLEAR_DELAY_MS / DT) + 5, { 0: frame() });
    expect(ev.some((e) => e.type === 'roomEntered' && e.reason === 'next')).toBe(true);
    expect(s.state.roomIndex).toBe(1);
    expect(s.state.players[0].callMs).toBe(0);
    expect(s.state.players[0].callCooldownMs).toBe(0);
  });

  it('début de partie : tous les joueurs sans appel ni délai', () => {
    const s = makeSim(4);
    for (const p of s.state.players) {
      expect(p.callMs).toBe(0);
      expect(p.callCooldownMs).toBe(0);
    }
  });
});

// ───────────────────────────── 1 à 4 joueurs ─────────────────────────────

describe('simulation : 1 à 4 joueurs indépendants', () => {
  it('chaque joueur a son propre appel, délai et immobilisation', () => {
    const s = makeSim(4);
    const start = s.state.players.map((p) => ({ x: p.pos.x, y: p.pos.y }));
    // J2 appelle au pas 0, J4 au pas 30 ; J1 et J3 marchent vers la droite
    const inputs = (i: number): TickInputs => ({
      0: frame({ moveX: 1 }),
      1: frame({ call: true, moveX: 1 }),
      2: frame({ moveX: 1 }),
      3: frame({ call: i >= 30, moveX: 1 }),
    });
    const ev = stepN(s, 45, inputs);
    expect(ev.filter((e) => e.type === 'callStarted')).toEqual([
      { type: 'callStarted', playerId: 1 },
      { type: 'callStarted', playerId: 3 },
    ]);
    const [p0, p1, p2, p3] = s.state.players;
    expect(p1.pos.x).toBe(start[1].x); // immobilisé depuis le pas 0
    expect(p0.pos.x).toBeGreaterThan(start[0].x); // les autres avancent
    expect(p2.pos.x).toBeGreaterThan(start[2].x);
    expect(p3.callMs).toBeGreaterThan(CALL_DURATION_MS - CALL_FREEZE_MS); // immobilisé depuis le pas 30
    expect(p0.callMs).toBe(0);
    expect(p2.callCooldownMs).toBe(0);
    expect(p1.callMs).toBeLessThan(p3.callMs); // J2 a appelé avant J4
  });

  it('un seul joueur : l\'appel fonctionne comme dans une équipe', () => {
    const s = makeSim(1);
    expect(count(stepN(s, 1, CALL), 'callStarted')).toBe(1);
  });
});

// ───────────────────────────── Actions bloquées pendant l'immobilisation ─────────────────────────────

describe('simulation : attaque, spécial, interaction, relevage ignorés pendant l\'immobilisation', () => {
  it('attaque : aucune attaque pendant 1 s (bouton tenu), puis elle reprend sans rappui', () => {
    const s = makeSim(1);
    const p = s.state.players[0];
    p.facing = 'right';
    addFoe(s, 'knight', p.pos.x + 10, p.pos.y);
    const inputs: TickInputs = { 0: frame({ call: true, attack: true }) };
    const frozen = stepN(s, 60, inputs);
    expect(count(frozen, 'playerAttack')).toBe(0);
    const after = stepN(s, 60, inputs);
    expect(count(after, 'playerAttack')).toBeGreaterThan(0);
  });

  it('l\'appui d\'appel prime sur l\'attaque et le spécial du même pas', () => {
    const s = makeSim(1);
    const ev = stepN(s, 1, { 0: frame({ call: true, attack: true, special: true }) });
    expect(count(ev, 'callStarted')).toBe(1);
    expect(count(ev, 'playerAttack')).toBe(0);
    expect(count(ev, 'specialUsed')).toBe(0);
  });

  it('spécial : ignoré pendant l\'immobilisation, utilisable ensuite (appel encore actif)', () => {
    const s = makeSim(1);
    stepN(s, 1, CALL);
    const early = stepN(s, 30, (i) => ({ 0: frame({ special: i % 2 === 0 }) }));
    expect(count(early, 'specialUsed')).toBe(0);
    expect(s.state.players[0].specialCooldownMs).toBe(0);
    stepN(s, 30, { 0: frame() }); // fin de l'immobilisation
    expect(s.state.players[0].callMs).toBeGreaterThan(0);
    const late = stepN(s, 2, (i) => ({ 0: frame({ special: i === 1 }) }));
    expect(count(late, 'specialUsed')).toBe(1);
  });

  it('un spécial déjà lancé n\'est pas annulé par un appel', () => {
    const s = makeSim(1, openLevel(), ['mira']);
    const p = s.state.players[0];
    p.facing = 'right';
    addFoe(s, 'knight', p.pos.x + 12, p.pos.y);
    stepN(s, 1, { 0: frame({ special: true }) });
    expect(p.specialAnimMs).toBeGreaterThan(0);
    stepN(s, 1, { 0: frame({ call: true }) });
    expect(p.callMs).toBeGreaterThan(0);
    expect(p.specialCooldownMs).toBeGreaterThan(0);
  });

  it('interaction : un levier à portée n\'est pas actionné pendant l\'immobilisation, mais l\'est après', () => {
    const lever = { id: 'l1', type: 'lever' as const, tile: [5, 5] as [number, number] };
    const s = makeSim(1, openLevel({ mechanisms: [lever] }));
    stepN(s, 1, CALL);
    const early = stepN(s, 40, (i) => ({ 0: frame({ interact: i % 2 === 0 }) }));
    expect(count(early, 'mechanismChanged')).toBe(0);
    stepN(s, 30, { 0: frame() });
    const late = stepN(s, 2, (i) => ({ 0: frame({ interact: i === 1 }) }));
    expect(late.some((e) => e.type === 'mechanismChanged' && e.mechanismId === 'l1' && e.active)).toBe(true);
  });

  it('relevage prioritaire : un appel pendant un relevage est ignoré et le relevage continue', () => {
    const s = makeSim(2);
    const [p0, p1] = s.state.players;
    p0.pos = { x: 100, y: 100 };
    p1.pos = { x: 110, y: 100 };
    applyDamageToPlayer(p1, 99999);
    stepN(s, 5, { 0: frame({ revive: true }) });
    expect(p0.revivingId).toBe(1);
    const ev = stepN(s, 10, { 0: frame({ revive: true, call: true }) });
    expect(count(ev, 'callStarted')).toBe(0);
    expect(p0.callMs).toBe(0);
    expect(p0.revivingId).toBe(1);
    expect(p1.reviveProgressMs).toBeGreaterThan(0);
  });

  it('appel d\'abord, relevage ensuite : le sauveteur ne peut pas relever avant la fin de l\'immobilisation', () => {
    const s = makeSim(2);
    const [p0, p1] = s.state.players;
    p0.pos = { x: 100, y: 100 };
    p1.pos = { x: 110, y: 100 };
    applyDamageToPlayer(p1, 99999);
    stepN(s, 1, { 0: frame({ call: true }) });
    const ev = stepN(s, 58, { 0: frame({ call: true, revive: true }) });
    expect(count(ev, 'reviveStarted')).toBe(0);
    expect(p0.revivingId).toBeNull();
    expect(p1.reviveProgressMs).toBe(0);
    stepN(s, 10, { 0: frame({ call: true, revive: true }) });
    expect(p0.revivingId).toBe(1); // immobilisation terminée, signal encore actif : le relevage peut commencer
    expect(p1.reviveProgressMs).toBeGreaterThan(0);
    expect(p0.callMs).toBeGreaterThan(0);
  });

  it('un allié à terre ne bloque pas l\'appelant debout : l\'appel d\'un joueur seul est possible même si tous les autres sont à terre', () => {
    const s = makeSim(2);
    applyDamageToPlayer(s.state.players[1], 99999);
    expect(count(stepN(s, 1, CALL), 'callStarted')).toBe(1);
  });
});

// ───────────────────────────── Mécanismes, objectifs, torche ─────────────────────────────

describe('simulation : blocs poussables, zones d\'objectif, torche', () => {
  it('bloc poussable : un appelant immobilisé ne pousse pas (stick plein), puis pousse une fois libre', () => {
    const block = { id: 'b', type: 'block' as const, tile: [10, 5] as [number, number], playersRequired: 1 };
    const push = (withCall: boolean): { moved: boolean; sim: GameSimulation } => {
      const s = makeSim(1, openLevel({ mechanisms: [block] }));
      s.state.players[0].pos = { x: 10 * TILE - PLAYER_RADIUS - 1, y: 5 * TILE + 8 };
      const b = s.state.room.mechanisms.find((m) => m.id === 'b') as BlockState;
      stepN(s, 55, { 0: frame({ moveX: 1, call: withCall }) });
      return { moved: b.moving !== null || b.tile[0] !== 10, sim: s };
    };
    expect(push(false).moved).toBe(true); // témoin : sans appel, la poussée a abouti à 55 pas
    const frozen = push(true);
    expect(frozen.moved).toBe(false);
    stepN(frozen.sim, 40, { 0: frame({ moveX: 1, call: true }) });
    const b = frozen.sim.state.room.mechanisms.find((m) => m.id === 'b') as BlockState;
    expect(b.moving !== null || b.tile[0] !== 10).toBe(true); // libéré : le bloc finit par bouger
  });

  it('zone d\'objectif : tenir la zone en appelant reste valide (la progression continue)', () => {
    const level = openLevel({ zones: [{ id: 'z1', rect: { x: 4, y: 4, w: 4, h: 4 } }] });
    level.objectives = [
      { id: 'o0', slot: 0, roomId: 'r1', kind: 'zone', labelKey: 'objective.test.o0', zoneId: 'z1', seconds: 2 },
      ...[1, 2, 3].map((slot) => ({ id: `o${slot}`, slot, roomId: 'r1', kind: 'kills' as const, labelKey: `objective.test.o${slot}`, count: 99 })),
    ];
    const s = makeSim(1, level);
    stepN(s, 1, CALL);
    stepN(s, 60, CALL); // toujours dans la zone, immobile : progression ≈ 1 s sur 2 s
    const o = s.state.objectives.find((x) => x.id === 'o0');
    expect(o?.progress).toBeGreaterThan(0.45);
    expect(o?.done).toBe(false);
    stepN(s, 90, CALL);
    expect(s.state.objectives.find((x) => x.id === 'o0')?.done).toBe(true);
  });

  it('torche : continue de s\'user pendant l\'appel (salle sombre)', () => {
    const s = makeSim(1, openLevel({ dark: true }));
    stepN(s, 1, CALL);
    const before = s.state.players[0].torchMs;
    stepN(s, 59, CALL);
    expect(s.state.players[0].torchMs).toBeLessThan(before);
    expect(s.state.players[0].torchMs).toBeCloseTo(TORCH_MAX_MS - 60 * DT, 3);
  });
});

// ───────────────────────────── Déterminisme et sérialisation ─────────────────────────────

describe('simulation : déterminisme et sérialisation', () => {
  const script = (i: number): TickInputs => ({
    0: frame({ call: i === 5 || i === 330, moveX: i % 90 < 45 ? 1 : -0.5 }),
    1: frame({ call: i === 100, moveY: 1, attack: i % 40 < 10 }),
    2: frame({ moveX: -1, special: i === 250 }),
  });

  it('deux simulations identiques (même graine, mêmes entrées) donnent la même suite d\'états', () => {
    const a = makeSim(3, openLevel(), undefined, 42);
    const b = makeSim(3, openLevel(), undefined, 42);
    for (let i = 0; i < 400; i++) {
      const ea = a.step(DT, script(i));
      const eb = b.step(DT, script(i));
      expect(eb).toEqual(ea);
      if (i % 25 === 0) expect(b.serialize()).toBe(a.serialize());
    }
    expect(b.serialize()).toBe(a.serialize());
    expect(count(stepN(makeSim(3, openLevel(), undefined, 42), 400, script), 'callStarted')).toBe(3);
  });

  it('serialize / restore : aller-retour identique, y compris les champs d\'appel, et suite identique', () => {
    const level = openLevel();
    const a = makeSim(3, level, undefined, 9);
    stepN(a, 90, script);
    expect(a.state.players[0].callMs).toBeGreaterThan(0);
    const snap = a.serialize();
    const b = GameSimulation.restore(snap, level);
    expect(b.serialize()).toBe(snap);
    expect(b.state.players[0].callMs).toBe(a.state.players[0].callMs);
    expect(b.state.players[0].callCooldownMs).toBe(a.state.players[0].callCooldownMs);
    for (let i = 90; i < 500; i++) {
      expect(b.step(DT, script(i))).toEqual(a.step(DT, script(i)));
    }
    expect(b.serialize()).toBe(a.serialize());
  });

  it('restore d\'un ancien snapshot SANS les champs d\'appel : valeurs par défaut (0), appel possible', () => {
    const level = openLevel();
    const a = makeSim(2, level);
    stepN(a, 20, {});
    const old = JSON.parse(a.serialize()) as { players: { callMs?: number; callCooldownMs?: number; prev: { call?: boolean } }[] };
    for (const p of old.players) {
      delete p.callMs;
      delete p.callCooldownMs;
      delete p.prev.call;
    }
    const b = GameSimulation.restore(JSON.stringify(old), level);
    for (const p of b.state.players) {
      expect(p.callMs).toBe(0);
      expect(p.callCooldownMs).toBe(0);
      expect(p.prev.call).toBe(false);
    }
    expect(count(stepN(b, 2, (i) => ({ 0: frame({ call: i === 1 }) })), 'callStarted')).toBe(1);
    // l'ancien et le nouveau format évoluent ensuite de la même façon (sans appel)
    const c = GameSimulation.restore(JSON.stringify(old), level);
    const d = GameSimulation.restore(a.serialize(), level);
    for (let i = 0; i < 100; i++) {
      c.step(DT, { 0: frame({ moveX: 1 }) });
      d.step(DT, { 0: frame({ moveX: 1 }) });
    }
    expect(c.state).toEqual(d.state); // même contenu (l'ordre des clés JSON peut différer pour les champs ajoutés à la restauration)
  });

  it('restore tolère des valeurs d\'appel invalides (NaN/chaîne) : ramenées à 0', () => {
    const level = openLevel();
    const a = makeSim(1, level);
    const raw = JSON.parse(a.serialize()) as { players: Record<string, unknown>[] };
    raw.players[0].callMs = 'oops';
    raw.players[0].callCooldownMs = null;
    const b = GameSimulation.restore(JSON.stringify(raw), level);
    expect(b.state.players[0].callMs).toBe(0);
    expect(b.state.players[0].callCooldownMs).toBe(0);
  });
});

// ───────────────────────────── Non-régression ─────────────────────────────

describe('simulation : pas de régression sans appel', () => {
  it('sans `call`, les autres actions se comportent comme avant (déplacement, spécial)', () => {
    const s = makeSim(1);
    const x0 = s.state.players[0].pos.x;
    stepN(s, 30, { 0: frame({ moveX: 1 }) });
    expect(s.state.players[0].pos.x).toBeGreaterThan(x0);
    const ev = stepN(s, 2, (i) => ({ 0: frame({ special: i === 1 }) }));
    expect(count(ev, 'specialUsed')).toBe(1);
    expect(s.state.players[0].callMs).toBe(0);
    expect(s.state.players[0].callCooldownMs).toBe(0);
  });

  it('le bouton d\'appel n\'est déclenché ni par attack, ni par interact, ni par revive, ni par special', () => {
    const s = makeSim(1);
    const ev = stepN(s, 10, { 0: frame({ attack: true, interact: true, revive: true, special: true }) });
    expect(count(ev, 'callStarted')).toBe(0);
  });
});
