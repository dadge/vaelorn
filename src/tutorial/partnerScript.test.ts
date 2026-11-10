import { describe, expect, it } from 'vitest';
import { CALL_COOLDOWN_MS, SIM_STEP_MS } from '../core/constants';
import { createSimulation } from '../core/simulation';
import type { ActionFrame, SimEvent } from '../core/types';
import { TUTORIAL_LEVEL_ID, TUTORIAL_SEED, tutorialLevel } from '../levels/tutorial';
import { evalCondition, type ConditionCtx } from './conditions';
import { loadProgram, newVm, resolveTarget, stepVm } from './partnerScript';
import type { Condition, PartnerOp } from './types';

function makeSim(startRoomIndex = 0) {
  return createSimulation(
    { levelId: TUTORIAL_LEVEL_ID, players: [{ id: 0, characterId: 'david', difficulty: 1 }, { id: 1, characterId: 'sandrine', difficulty: 1 }], seed: TUTORIAL_SEED, startRoomIndex },
    tutorialLevel,
  );
}

/** Joue un programme du partenaire (le joueur reste immobile) ; retourne les frames, les événements et le temps. */
function play(ops: PartnerOp[], opts: { room?: number; maxMs?: number; humanFrame?: Partial<ActionFrame>; until?: (sim: ReturnType<typeof makeSim>) => boolean } = {}) {
  const sim = makeSim(opts.room ?? 0);
  const vm = newVm();
  loadProgram(vm, ops);
  const frames: ActionFrame[] = [];
  const events: SimEvent[] = [];
  let ms = 0;
  const human: ActionFrame = { moveX: 0, moveY: 0, attack: false, interact: false, revive: false, ...opts.humanFrame };
  while (ms < (opts.maxMs ?? 30_000)) {
    const state = sim.state;
    const ctx: ConditionCtx = { level: tutorialLevel, state, room: tutorialLevel.rooms[state.roomIndex], events, movedPx: 0, signNear: { id: null, ms: 0 }, regions: [] };
    const f = stepVm(vm, { dtMs: SIM_STEP_MS, state, room: ctx.room, level: tutorialLevel, evalCond: (c: Condition) => evalCondition(c, ctx) });
    frames.push(f);
    events.push(...sim.step(SIM_STEP_MS, { 0: human, 1: f }));
    ms += SIM_STEP_MS;
    if (opts.until?.(sim)) break;
  }
  return { sim, vm, frames, events, ms };
}

describe('partenaire scripté : machine virtuelle', () => {
  it('walk : atteint une tuile en ligne droite', () => {
    const { sim } = play([{ op: 'walk', at: { tile: [16, 6] } }], { until: (s) => Math.hypot(s.state.players[1].pos.x - 264, s.state.players[1].pos.y - 104) < 4 });
    expect(Math.hypot(sim.state.players[1].pos.x - 264, sim.state.players[1].pos.y - 104)).toBeLessThan(4);
  });

  it('atteint chaque cible de chaque salle (plaque, levier, tuile, zone, sortie)', () => {
    const targets: Array<[number, PartnerOp]> = [
      [1, { op: 'walk', at: { mech: 'pB' } }],
      [1, { op: 'walk', at: { mech: 'lv1' } }],
      [3, { op: 'walk', at: { tile: [14, 5] } }], // un brasero est solide : on vise la tuile voisine
      [7, { op: 'walk', at: { zone: 'z_seal' } }],
      [0, { op: 'goExit' }],
      [5, { op: 'walk', at: { tile: [12, 6] } }], // t_heart : un cœur posé par le script
      [6, { op: 'goExit' }],
    ];
    for (const [room, op] of targets) {
      const r = tutorialLevel.rooms[room];
      const sim0 = makeSim(room);
      const to = op.op === 'goExit' ? resolveTarget({ exit: true }, r, sim0.state) : resolveTarget((op as Extract<PartnerOp, { op: 'walk' }>).at, r, sim0.state);
      expect(to, `cible ${room}`).not.toBeNull();
      const res = play([op], { room, maxMs: 40_000, until: (s) => Math.hypot(s.state.players[1].pos.x - to!.x, s.state.players[1].pos.y - to!.y) < 8 });
      expect(Math.hypot(res.sim.state.players[1].pos.x - to!.x, res.sim.state.players[1].pos.y - to!.y), `salle ${r.id}`).toBeLessThan(10);
    }
  });

  it('press : UNE impulsion d un pas puis relâchement (front montant)', () => {
    const { frames } = play([{ op: 'press', button: 'interact' }, { op: 'idle' }], { maxMs: 200 });
    const interact = frames.map((f) => f.interact);
    expect(interact.filter(Boolean).length).toBe(1);
    expect(interact[0]).toBe(true);
    expect(interact[1]).toBe(false);
  });

  it('callEvery : n appelle jamais avant le délai de récupération (aucun appel perdu) et s arrête avec `until`', () => {
    const { frames, events } = play([{ op: 'callEvery', ms: 5200, until: { k: 'near', tiles: 0.1 } }], { room: 6, maxMs: 20_000 });
    const callFrames = frames.map((f, i) => (f.call ? i : -1)).filter((i) => i >= 0);
    expect(callFrames.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < callFrames.length; i++) expect((callFrames[i] - callFrames[i - 1]) * SIM_STEP_MS).toBeGreaterThanOrEqual(CALL_COOLDOWN_MS);
    // chaque impulsion a bien déclenché un appel dans la simulation
    expect(events.filter((e) => e.type === 'callStarted').length).toBe(callFrames.length);
  });

  it('stand : tient la plaque jusqu à `until`, sans bouger ensuite', () => {
    const until: Condition = { k: 'moved', px: 1e9 }; // jamais vrai : il reste sur la plaque
    const { sim } = play([{ op: 'stand', at: { mech: 'pB' }, until }], { room: 1, maxMs: 15_000 });
    const pB = sim.state.room.mechanisms.find((m) => m.id === 'pB') as { active: boolean; pressedBy: unknown };
    expect(pB.active).toBe(true);
    expect(pB.pressedBy).toBe(1);
  });

  it('stand : déjà satisfait → ne bouge pas pour rien', () => {
    const { sim, vm } = play([{ op: 'stand', at: { mech: 'pB' }, until: { k: 'all', of: [] } }, { op: 'idle' }], { room: 1, maxMs: 500 });
    expect(vm.pc).toBe(1);
    expect(sim.state.players[1].pos.x).toBeCloseTo(4.5 * 16, 0);
  });

  it('reviveHuman : relève le joueur à terre (relevage maintenu), puis la suite du programme reprend', () => {
    const sim = makeSim(0);
    sim.step(SIM_STEP_MS, {});
    sim.knockDown(0);
    const vm = newVm();
    loadProgram(vm, [{ op: 'idle' }]);
    const events: SimEvent[] = [];
    for (let i = 0; i < 60 * 12; i++) {
      const state = sim.state;
      const ctx: ConditionCtx = { level: tutorialLevel, state, room: tutorialLevel.rooms[0], events, movedPx: 0, signNear: { id: null, ms: 0 }, regions: [] };
      const f = stepVm(vm, { dtMs: SIM_STEP_MS, state, room: ctx.room, level: tutorialLevel, evalCond: (c) => evalCondition(c, ctx) }, { op: 'reviveHuman' });
      events.push(...sim.step(SIM_STEP_MS, { 1: f }));
    }
    expect(events.some((e) => e.type === 'playerRevived' && e.playerId === 0 && e.reviverId === 1)).toBe(true);
    expect(sim.state.players[0].status).toBe('alive');
  });

  it('un partenaire à terre ne produit aucune entrée', () => {
    const sim = makeSim(0);
    sim.step(SIM_STEP_MS, {});
    sim.knockDown(1);
    const vm = newVm();
    loadProgram(vm, [{ op: 'walk', at: { tile: [30, 6] } }]);
    const state = sim.state;
    const f = stepVm(vm, { dtMs: SIM_STEP_MS, state, room: tutorialLevel.rooms[0], level: tutorialLevel, evalCond: () => false });
    expect(f).toEqual({ moveX: 0, moveY: 0, attack: false, interact: false, revive: false, special: false, call: false, heart: false });
  });

  it('n attaque jamais et n utilise jamais le spécial (toutes les frames de tous les programmes des étapes)', async () => {
    const { TUTORIAL_STEPS } = await import('./steps');
    for (const s of TUTORIAL_STEPS) {
      if (!s.partner) continue;
      const room = tutorialLevel.rooms.findIndex((r) => r.id === s.room);
      const { frames } = play(s.partner, { room, maxMs: 8000 });
      for (const f of frames) {
        expect(f.attack, s.id).toBe(false);
        expect(f.special, s.id).toBe(false);
      }
    }
  });

  it('détection de blocage : immobile contre un mur → détour perpendiculaire', () => {
    const sim = makeSim(0);
    const vm = newVm();
    loadProgram(vm, [{ op: 'walk', at: { tile: [0, 6] } }]); // vise le mur : la cible [0,6] est un mur, le partenaire s y colle
    let detour = false;
    for (let i = 0; i < 60 * 6; i++) {
      const state = sim.state;
      const f = stepVm(vm, { dtMs: SIM_STEP_MS, state, room: tutorialLevel.rooms[0], level: tutorialLevel, evalCond: () => false });
      if (vm.detourMs > 0) detour = true;
      sim.step(SIM_STEP_MS, { 1: f });
    }
    expect(detour).toBe(true);
  });
});
