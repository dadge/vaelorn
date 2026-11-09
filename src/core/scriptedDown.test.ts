/**
 * `GameSimulation.knockDown` : mise à terre SCÉNARISÉE (tutoriel). Même effet qu'une chute au combat, déterministe,
 * sans modifier la signature de `step`.
 */
import { describe, expect, it } from 'vitest';
import { CALL_DURATION_MS, REVIVE_DURATION_MS, SIM_STEP_MS, WIPE_RESTART_DELAY_MS } from './constants';
import { markPlayerDown, applyDamageToPlayer, createPlayerState } from './players';
import { GameSimulation, createSimulation } from './simulation';
import { makeTestLevel } from './levelValidation';
import type { ActionFrame, PlayerId, SimEvent, TickInputs } from './types';

const IDLE: ActionFrame = { moveX: 0, moveY: 0, attack: false, interact: false, revive: false };

function makeSim(n = 2): GameSimulation {
  const level = makeTestLevel();
  return createSimulation(
    { levelId: level.id, players: Array.from({ length: n }, (_, i) => ({ id: i as PlayerId, characterId: (['david', 'sandrine', 'romain', 'valentine'] as const)[i], difficulty: 1 as const })), seed: 42 },
    level,
  );
}

function run(sim: GameSimulation, ms: number, inputs: TickInputs = {}): SimEvent[] {
  const out: SimEvent[] = [];
  for (let t = 0; t < ms; t += SIM_STEP_MS) out.push(...sim.step(SIM_STEP_MS, inputs));
  return out;
}

describe('markPlayerDown (extrait de applyDamageToPlayer)', () => {
  it('produit le même état qu une chute au combat', () => {
    const a = createPlayerState({ id: 0, characterId: 'david', difficulty: 1 }, { x: 8, y: 8 });
    const b = createPlayerState({ id: 0, characterId: 'david', difficulty: 1 }, { x: 8, y: 8 });
    a.hp = 1;
    a.callMs = 1500;
    b.callMs = 1500;
    expect(applyDamageToPlayer(a, 999).downed).toBe(true);
    markPlayerDown(b);
    expect(b).toEqual(a);
    expect(b.status).toBe('down');
    expect(b.hp).toBe(0);
    expect(b.callMs).toBe(0);
    expect(b.downCount).toBe(1);
  });
});

describe('GameSimulation.knockDown', () => {
  it('met un joueur vivant à terre : statut, PV, downCount, appel annulé ; playerDown au pas suivant', () => {
    const sim = makeSim();
    run(sim, 100);
    sim.state.players[1].callMs = CALL_DURATION_MS;
    expect(sim.knockDown(1)).toBe(true);
    const p = sim.state.players[1];
    expect(p.status).toBe('down');
    expect(p.hp).toBe(0);
    expect(p.downCount).toBe(1);
    expect(p.callMs).toBe(0);
    const ev = sim.step(SIM_STEP_MS, {});
    expect(ev.filter((e) => e.type === 'playerDown')).toEqual([{ type: 'playerDown', playerId: 1 }]);
    expect(sim.state.players[0].status).toBe('alive');
  });

  it('ignore l invulnérabilité', () => {
    const sim = makeSim();
    run(sim, 100);
    sim.state.players[0].invulnMs = 5000;
    expect(sim.knockDown(0)).toBe(true);
    expect(sim.state.players[0].status).toBe('down');
  });

  it('retourne false sans effet : joueur déjà à terre, id inconnu, phase hors playing', () => {
    const sim = makeSim();
    run(sim, 100);
    expect(sim.knockDown(1)).toBe(true);
    const before = sim.serialize();
    expect(sim.knockDown(1)).toBe(false);
    expect(sim.knockDown(3)).toBe(false);
    expect(sim.serialize()).toBe(before);
    sim.state.phase = 'roomCleared';
    expect(sim.knockDown(0)).toBe(false);
    expect(sim.state.players[0].status).toBe('alive');
  });

  it('un allié qui maintient revive relève le joueur tombé en 3,0 s (playerRevived)', () => {
    const sim = makeSim();
    run(sim, 100);
    // rapproche l'allié du joueur qui va tomber
    sim.state.players[0].pos = { x: sim.state.players[1].pos.x + 8, y: sim.state.players[1].pos.y };
    sim.knockDown(1);
    const events: SimEvent[] = [];
    let t = 0;
    while (t < REVIVE_DURATION_MS * 2 && !events.some((e) => e.type === 'playerRevived')) {
      events.push(...sim.step(SIM_STEP_MS, { 0: { ...IDLE, revive: true } }));
      t += SIM_STEP_MS;
    }
    const revived = events.find((e) => e.type === 'playerRevived');
    expect(revived).toEqual({ type: 'playerRevived', playerId: 1, reviverId: 0 });
    expect(t).toBeGreaterThan(REVIVE_DURATION_MS * 0.95);
    expect(t).toBeLessThan(REVIVE_DURATION_MS * 1.1);
    expect(sim.state.players[1].status).toBe('alive');
  });

  it('mettre tout le monde à terre déclenche la mort d équipe puis le redémarrage à ~2,5 s, tous debout', () => {
    const sim = makeSim();
    run(sim, 100);
    sim.knockDown(0);
    sim.knockDown(1);
    const events = run(sim, WIPE_RESTART_DELAY_MS + 200);
    expect(events.some((e) => e.type === 'teamWipe')).toBe(true);
    const restart = events.find((e) => e.type === 'roomEntered' && e.reason === 'restart');
    expect(restart).toBeTruthy();
    expect(sim.state.players.every((p) => p.status === 'alive')).toBe(true);
    expect(sim.state.phase).toBe('playing');
  });

  it('est déterministe : même graine, mêmes entrées, même knockDown au même tick = même serialize()', () => {
    const a = makeSim();
    const b = makeSim();
    for (let i = 0; i < 300; i++) {
      if (i === 120) {
        a.knockDown(1);
        b.knockDown(1);
      }
      a.step(SIM_STEP_MS, { 0: { ...IDLE, moveX: 1 } });
      b.step(SIM_STEP_MS, { 0: { ...IDLE, moveX: 1 } });
    }
    expect(a.serialize()).toBe(b.serialize());
  });

  it('serialize / restore après knockDown : suite identique', () => {
    const a = makeSim();
    run(a, 200);
    a.knockDown(1);
    a.step(SIM_STEP_MS, {}); // les événements pendants sont consommés avant la sérialisation
    const b = GameSimulation.restore(a.serialize(), a.level);
    for (let i = 0; i < 200; i++) {
      a.step(SIM_STEP_MS, { 0: { ...IDLE, moveX: -1 } });
      b.step(SIM_STEP_MS, { 0: { ...IDLE, moveX: -1 } });
    }
    expect(b.serialize()).toBe(a.serialize());
  });
});
