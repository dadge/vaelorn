import { beforeAll, describe, expect, it } from 'vitest';
import { INTERACT_RANGE, TILE, TORCH_MAX_MS } from '../core/constants';
import { makeTestLevel, makeTestRoom } from '../core/levelValidation';
import { createSimulation, type GameSimulation } from '../core/simulation';
import type { BrazierDef, BrazierState, MechanismDef, PlayerSetup } from '../core/types';
import { setLanguage, t } from '../i18n/i18n';
import { brazierPrompt, computeContextPrompt } from './hud';

beforeAll(() => setLanguage('en'));

const setups = (n: number): PlayerSetup[] =>
  (['david', 'sandrine', 'romain', 'valentine'] as const).slice(0, n).map((characterId, i) => ({ id: i as 0 | 1 | 2 | 3, characterId, difficulty: 2 }));

/** Simulation sur une salle sombre ; le brasero est injecté « à la main » (définition + état) : indépendant du moteur de torches. */
function simWith(extra: MechanismDef[], braziers: Record<string, boolean>, players = 2): GameSimulation {
  const room = makeTestRoom({ dark: true });
  room.mechanisms = [...room.mechanisms, ...extra];
  const level = makeTestLevel({ rooms: [room] });
  const sim = createSimulation({ levelId: level.id, players: setups(players), seed: 3 }, level);
  for (const [id, lit] of Object.entries(braziers)) {
    const st: BrazierState = { id, type: 'brazier', waived: false, active: lit, litBy: null };
    const idx = sim.state.room.mechanisms.findIndex((m) => m.id === id);
    if (idx >= 0) sim.state.room.mechanisms[idx] = st;
    else sim.state.room.mechanisms.push(st);
  }
  return sim;
}

function place(sim: GameSimulation, id: number, tx: number, ty: number, dx = 0, dy = 0): void {
  sim.state.players[id].pos = { x: (tx + 0.5) * TILE + dx, y: (ty + 0.5) * TILE + dy };
}

describe('brazierPrompt (pur)', () => {
  const free: Pick<BrazierDef, 'ownerSlot'> = {};

  it('allumé : recharger seulement si la torche n est pas pleine', () => {
    expect(brazierPrompt(free, true, { id: 0, torchMs: TORCH_MAX_MS / 2 }, 2)?.key).toBe('hint.brazierRefuel');
    expect(brazierPrompt(free, true, { id: 0, torchMs: 0 }, 2)?.key).toBe('hint.brazierRefuel');
    expect(brazierPrompt(free, true, { id: 0, torchMs: TORCH_MAX_MS }, 2)).toBeNull();
  });

  it('éteint : allumer (torche non vide) ou torche éteinte', () => {
    expect(brazierPrompt(free, false, { id: 0, torchMs: 1000 }, 2)?.key).toBe('hint.brazierLight');
    expect(brazierPrompt(free, false, { id: 0, torchMs: 0 }, 2)?.key).toBe('hint.brazierNoTorch');
  });

  it('ownerSlot : réservé au joueur du slot (coop adaptative), couleur d accent', () => {
    const slot1 = { ownerSlot: 1 };
    const other = brazierPrompt(slot1, false, { id: 0, torchMs: 1000 }, 2);
    expect(other?.key).toBe('hint.slotRequired');
    expect(other?.color).not.toBeNull();
    expect(brazierPrompt(slot1, false, { id: 1, torchMs: 1000 }, 2)?.key).toBe('hint.brazierLight');
    // 1 seul joueur : le slot 1 est résolu sur le joueur 0
    expect(brazierPrompt(slot1, false, { id: 0, torchMs: 1000 }, 1)?.key).toBe('hint.brazierLight');
  });

  it('les clés i18n existent', () => {
    for (const key of ['hint.brazierRefuel', 'hint.brazierLight', 'hint.brazierNoTorch']) expect(t(key)).not.toBe(key);
  });
});

describe('computeContextPrompt avec brasero', () => {
  const def: BrazierDef = { id: 'br', type: 'brazier', tile: [4, 6] };

  it('invite « recharger » près d un brasero allumé quand la torche est entamée', () => {
    const sim = simWith([def], { br: true });
    place(sim, 0, 4, 6, 6);
    sim.state.players[0].torchMs = TORCH_MAX_MS / 3;
    const p = computeContextPrompt(sim.state, sim.level, sim.room, 0);
    expect(p?.kind).toBe('brazier');
    expect(p?.key).toBe('hint.brazierRefuel');
  });

  it('pas d invite quand la torche est pleine ou hors de portée', () => {
    const sim = simWith([def], { br: true });
    place(sim, 0, 4, 6, 4);
    sim.state.players[0].torchMs = TORCH_MAX_MS;
    expect(computeContextPrompt(sim.state, sim.level, sim.room, 0)?.kind).not.toBe('brazier');
    place(sim, 0, 4, 6, INTERACT_RANGE + 12);
    sim.state.players[0].torchMs = 10;
    expect(computeContextPrompt(sim.state, sim.level, sim.room, 0)?.kind).not.toBe('brazier');
  });

  it('invite « allumer » sur un brasero éteint', () => {
    const sim = simWith([def], { br: false });
    place(sim, 0, 4, 6, 5);
    sim.state.players[0].torchMs = 5000;
    expect(computeContextPrompt(sim.state, sim.level, sim.room, 0)?.key).toBe('hint.brazierLight');
  });

  it('un levier à portée est prioritaire sur le brasero (priorité de l appui Action)', () => {
    const sim = simWith([def, { id: 'lv', type: 'lever', tile: [4, 7] }], { br: true });
    place(sim, 0, 4, 6, 0, 6);
    sim.state.players[0].torchMs = 1000;
    const p = computeContextPrompt(sim.state, sim.level, sim.room, 0);
    expect(p?.kind).toBe('lever');
  });
});
