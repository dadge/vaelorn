import { describe, expect, it } from 'vitest';
import { TORCH_MAX_MS } from '../core/constants';
import type { SimEvent } from '../core/types';
import { tutorialLevel } from '../levels/tutorial';
import { ALL_REGIONS, TutorialRun } from '../testing/tutorial.solution';
import { countEvents, enemiesGone, eventActor, evalCondition, humanPartnerDistancePx, stepSignNear, type ConditionCtx } from './conditions';
import type { Condition } from './types';

function ctxOf(run: TutorialRun, extra: Partial<ConditionCtx> = {}): ConditionCtx {
  return {
    level: tutorialLevel,
    state: run.state,
    room: tutorialLevel.rooms[run.state.roomIndex],
    events: [],
    movedPx: 0,
    signNear: { id: null, ms: 0 },
    regions: ALL_REGIONS,
    ...extra,
  };
}

const died = (by: 0 | 1 | null): SimEvent => ({ type: 'enemyDied', enemyId: 1, kind: 'slime', pos: { x: 0, y: 0 }, byPlayer: by });

describe('événements', () => {
  it('eventActor : le joueur qui a agi', () => {
    expect(eventActor(died(0))).toBe(0);
    expect(eventActor(died(null))).toBeNull();
    expect(eventActor({ type: 'playerRevived', playerId: 1, reviverId: 0 })).toBe(0);
    expect(eventActor({ type: 'specialUsed', playerId: 1, kind: 'dash', pos: { x: 0, y: 0 }, dir: 'down' })).toBe(1);
    expect(eventActor({ type: 'roomCleared', roomId: 'x' })).toBeNull();
  });

  it('countEvents : type, acteur, champs, nombre', () => {
    const log: SimEvent[] = [died(0), died(1), died(0), { type: 'playerRevived', playerId: 1, reviverId: 0 }];
    expect(countEvents(log, { k: 'event', type: 'enemyDied' })).toBe(3);
    expect(countEvents(log, { k: 'event', type: 'enemyDied', by: 0 })).toBe(2);
    expect(countEvents(log, { k: 'event', type: 'playerRevived', match: { playerId: 1, reviverId: 0 } })).toBe(1);
    expect(countEvents(log, { k: 'event', type: 'playerRevived', match: { playerId: 0 } })).toBe(0);
  });
});

describe('evalCondition sur un état réel', () => {
  it('moved, nearSign, event avec count', () => {
    const run = new TutorialRun();
    run.tick();
    expect(evalCondition({ k: 'moved', px: 64 }, ctxOf(run, { movedPx: 64 }))).toBe(true);
    expect(evalCondition({ k: 'moved', px: 64 }, ctxOf(run, { movedPx: 10 }))).toBe(false);
    expect(evalCondition({ k: 'nearSign', id: 's_yard', ms: 1500 }, ctxOf(run, { signNear: { id: 's_yard', ms: 1600 } }))).toBe(true);
    expect(evalCondition({ k: 'nearSign', id: 's_yard', ms: 1500 }, ctxOf(run, { signNear: { id: 'autre', ms: 9999 } }))).toBe(false);
    expect(evalCondition({ k: 'event', type: 'enemyDied', count: 2 }, ctxOf(run, { events: [died(0), died(0)] }))).toBe(true);
    expect(evalCondition({ k: 'event', type: 'enemyDied', count: 2 }, ctxOf(run, { events: [died(0)] }))).toBe(false);
  });

  it('req, objective, enemiesGone, exitOpen sur la cour au départ', () => {
    const run = new TutorialRun();
    run.tick();
    expect(evalCondition({ k: 'req', token: 'clear' }, ctxOf(run))).toBe(false);
    expect(evalCondition({ k: 'objective', id: 'o_kills' }, ctxOf(run))).toBe(false);
    expect(enemiesGone(run.state, tutorialLevel.rooms[0])).toBe(false);
    expect(evalCondition({ k: 'enemiesGone' }, ctxOf(run))).toBe(false);
    expect(evalCondition({ k: 'exitOpen' }, ctxOf(run))).toBe(false);
  });

  it('near / far : distance joueur ↔ partenaire (en tuiles)', () => {
    const run = new TutorialRun({ startRoomIndex: 5 }); // t_call : 47 tuiles d écart
    run.tick();
    expect(humanPartnerDistancePx(run.state) / 16).toBeGreaterThan(40);
    expect(evalCondition({ k: 'far', tiles: 16 }, ctxOf(run))).toBe(true);
    expect(evalCondition({ k: 'near', tiles: 6 }, ctxOf(run))).toBe(false);
  });

  it('torchUsed : la torche s est consumée ; holdsKey ; regionVisible', () => {
    const run = new TutorialRun({ startRoomIndex: 3 });
    expect(evalCondition({ k: 'torchUsed' }, ctxOf(run))).toBe(false);
    run.state.players[0].torchMs = TORCH_MAX_MS - 5000;
    expect(evalCondition({ k: 'torchUsed' }, ctxOf(run))).toBe(true);
    expect(evalCondition({ k: 'holdsKey' }, ctxOf(run))).toBe(false);
    run.state.players[0].keys.push('k0');
    expect(evalCondition({ k: 'holdsKey' }, ctxOf(run))).toBe(true);
    expect(evalCondition({ k: 'regionVisible', id: 'roomGoals' }, ctxOf(run, { regions: ['hearts'] }))).toBe(false);
    expect(evalCondition({ k: 'regionVisible', id: 'hearts' }, ctxOf(run, { regions: ['hearts'] }))).toBe(true);
  });

  it('all / any', () => {
    const run = new TutorialRun();
    const yes: Condition = { k: 'moved', px: 1 };
    const no: Condition = { k: 'moved', px: 1e9 };
    const c = ctxOf(run, { movedPx: 5 });
    expect(evalCondition({ k: 'all', of: [yes, no] }, c)).toBe(false);
    expect(evalCondition({ k: 'any', of: [yes, no] }, c)).toBe(true);
    expect(evalCondition({ k: 'all', of: [] }, c)).toBe(true);
    expect(evalCondition({ k: 'any', of: [] }, c)).toBe(false);
  });

  it('stepSignNear accumule devant un panneau et repart de zéro en le quittant', () => {
    const run = new TutorialRun();
    const room = tutorialLevel.rooms[0];
    const sign = room.signs![0];
    run.state.players[0].pos = { x: (sign.tile[0] + 0.5) * 16, y: (sign.tile[1] + 0.5) * 16 };
    let s = { id: null as string | null, ms: 0 };
    s = stepSignNear(s, run.state, room, 100);
    s = stepSignNear(s, run.state, room, 100);
    expect(s).toEqual({ id: 's_yard', ms: 100 });
    run.state.players[0].pos = { x: 20 * 16, y: 6 * 16 };
    expect(stepSignNear(s, run.state, room, 100)).toEqual({ id: null, ms: 0 });
  });
});
