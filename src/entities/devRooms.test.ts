import { describe, expect, it } from 'vitest';
import { SIM_STEP_MS } from '../core/constants';
import { RoomGrid } from '../core/grid';
import { createSimulation } from '../core/simulation';
import type { PlayerSetup } from '../core/types';
import { DEV_TEST_KINDS, buildDevTestLevel, devTestKind, devTestRequested } from './devRooms';

const setups: PlayerSetup[] = [
  { id: 0, characterId: 'david', difficulty: 2 },
  { id: 1, characterId: 'sandrine', difficulty: 2 },
];

describe('?dev=<type> : salles de test', () => {
  it('lecture du paramètre : types connus seulement, garde DEV ou ?debug=1', () => {
    expect(devTestRequested('?dev=statues')).toBe('statues');
    expect(devTestRequested('?quick=1&dev=bosses&players=2')).toBe('bosses');
    expect(devTestRequested('?dev=nimporte')).toBeNull();
    expect(devTestRequested('')).toBeNull();
    expect(devTestKind('?dev=bridge', true)).toBe('bridge');
    expect(devTestKind('?dev=bridge', false)).toBeNull();
    expect(devTestKind('?dev=bridge&debug=1', false)).toBe('bridge');
  });

  it.each([...DEV_TEST_KINDS])('%s : niveau valide, simulation sans erreur, mécanismes / ennemis attendus', (kind) => {
    const level = buildDevTestLevel(kind);
    expect(level.rooms).toHaveLength(1);
    const room = level.rooms[0];
    const grid = new RoomGrid(room.layout);
    // toutes les lignes ont la même longueur ; spawns et sortie sur des tuiles praticables
    expect(new Set(room.layout.map((r) => r.length)).size).toBe(1);
    for (const [x, y] of room.playerSpawns) expect(grid.blocksMovement(x, y), `spawn ${x},${y}`).toBe(false);
    expect(level.objectives).toHaveLength(4);
    const sim = createSimulation({ levelId: level.id, players: setups, seed: 1 }, level);
    for (let i = 0; i < 120; i++) sim.step(SIM_STEP_MS, {});
    if (kind === 'statues') expect(room.mechanisms[0].type).toBe('statuePair');
    if (kind === 'hourglass') expect(room.mechanisms[0].type).toBe('hourglass');
    if (kind === 'bridge') {
      expect(room.mechanisms[0].type).toBe('lightBridge');
      expect(room.dark).toBe(true);
    }
    if (kind === 'bosses') expect(new Set(room.enemies.map((e) => e.kind))).toEqual(new Set(['warden', 'pyromancer', 'wraith', 'frostqueen', 'forgelord', 'voidlord']));
  });
});
