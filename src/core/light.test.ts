import { describe, expect, it } from 'vitest';
import {
  BRAZIER_LIGHT_TILES,
  LIGHT_EMPTY_TILES,
  LIGHT_FULL_TILES,
  LIGHT_LOW_TILES,
  TILE,
  TORCH_LOW_FRACTION,
  TORCH_MAX_MS,
} from './constants';
import { makeTestLayout, makeTestRoom } from './levelValidation';
import { brazierRadiusPx, DECOR_TORCH_LIGHT_TILES, isLit, lightSources, torchRadiusPx } from './light';
import { createRoomMechanisms } from './mechanisms';
import { createPlayerState } from './players';
import type { GameState, PlayerId, RoomDef } from './types';

function stateFor(room: RoomDef, n = 2): GameState {
  const players = Array.from({ length: n }, (_, i) =>
    createPlayerState({ id: i as PlayerId, characterId: 'david', difficulty: 2 }, { x: 40 + i * 20, y: 40 }),
  );
  return {
    version: 1,
    tick: 0,
    timeMs: 0,
    rngState: 1,
    nextEntityId: 1,
    levelId: 'test',
    playerCount: n,
    players,
    roomIndex: 0,
    phase: 'playing',
    phaseTimerMs: 0,
    room: {
      roomId: room.id,
      enemies: [],
      projectiles: [],
      mechanisms: createRoomMechanisms(room, n),
      spawnedSpawnIdx: [],
      elapsedMs: 0,
    },
    objectives: [],
    clearedRooms: [],
  };
}

describe('torchRadiusPx', () => {
  it('torche pleine : rayon plein', () => {
    expect(torchRadiusPx(TORCH_MAX_MS)).toBe(LIGHT_FULL_TILES * TILE);
  });

  it('plein tant que le combustible est au moins au seuil de faiblesse', () => {
    expect(torchRadiusPx(TORCH_MAX_MS * TORCH_LOW_FRACTION)).toBe(LIGHT_FULL_TILES * TILE);
    expect(torchRadiusPx(TORCH_MAX_MS * 0.5)).toBe(LIGHT_FULL_TILES * TILE);
  });

  it('faiblissante : rayon réduit sous le seuil, plateau LIGHT_LOW_TILES', () => {
    expect(torchRadiusPx(TORCH_MAX_MS * TORCH_LOW_FRACTION * 0.5)).toBe(LIGHT_LOW_TILES * TILE);
    expect(torchRadiusPx(TORCH_MAX_MS * TORCH_LOW_FRACTION * 0.3)).toBe(LIGHT_LOW_TILES * TILE);
  });

  it('torche éteinte : rayon minimal', () => {
    expect(torchRadiusPx(0)).toBe(LIGHT_EMPTY_TILES * TILE);
    expect(torchRadiusPx(-10)).toBe(LIGHT_EMPTY_TILES * TILE);
  });

  it('valeurs non finies traitées comme 0, surplus borné au plein', () => {
    expect(torchRadiusPx(Number.NaN)).toBe(LIGHT_EMPTY_TILES * TILE);
    expect(torchRadiusPx(Number.POSITIVE_INFINITY)).toBe(LIGHT_EMPTY_TILES * TILE);
    expect(torchRadiusPx(TORCH_MAX_MS * 10)).toBe(LIGHT_FULL_TILES * TILE);
  });

  it('continue et monotone croissante avec le combustible', () => {
    let prev = -1;
    for (let ms = 0; ms <= TORCH_MAX_MS; ms += 250) {
      const r = torchRadiusPx(ms);
      expect(r).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(r).toBeGreaterThanOrEqual(LIGHT_EMPTY_TILES * TILE - 1e-9);
      expect(r).toBeLessThanOrEqual(LIGHT_FULL_TILES * TILE + 1e-9);
      if (prev >= 0) expect(r - prev).toBeLessThan(4); // pas de saut brutal sur un pas de 250 ms
      prev = r;
    }
  });
});

describe('brazierRadiusPx', () => {
  it('défaut BRAZIER_LIGHT_TILES, sinon la valeur donnée', () => {
    expect(brazierRadiusPx()).toBe(BRAZIER_LIGHT_TILES * TILE);
    expect(brazierRadiusPx(2)).toBe(2 * TILE);
  });
});

describe('lightSources', () => {
  const room = makeTestRoom({
    layout: makeTestLayout(16, 12),
    dark: true,
    mechanisms: [
      { id: 'b1', type: 'brazier', tile: [8, 6], lit: true },
      { id: 'b2', type: 'brazier', tile: [10, 6], lightRadiusTiles: 2 },
      { id: 'b3', type: 'brazier', tile: [12, 6], minPlayers: 3 },
      { id: 'p1', type: 'plate', tile: [6, 4] },
    ],
    decor: [
      { type: 'torch', tile: [3, 0] },
      { type: 'statue', tile: [5, 5] },
    ],
  });

  it('une source par joueur, par brasero allumé/waived et par décor torch (salle sombre)', () => {
    const st = stateFor(room, 2);
    const src = lightSources(st, room);
    expect(src.filter((s) => s.kind === 'torch')).toHaveLength(2);
    // b1 allumé, b2 éteint, b3 waived (minPlayers 3 > 2 joueurs) => allumé d'office
    const braziers = src.filter((s) => s.kind === 'brazier');
    expect(braziers).toHaveLength(2);
    expect(braziers.map((b) => b.x).sort((a, b) => a - b)).toEqual([8.5 * TILE, 12.5 * TILE]);
    expect(src.filter((s) => s.kind === 'decor')).toHaveLength(1);
    expect(src.find((s) => s.kind === 'decor')?.radius).toBe(DECOR_TORCH_LIGHT_TILES * TILE);
  });

  it('un brasero allumé en jeu devient une source ; son rayon propre est respecté', () => {
    const st = stateFor(room, 3); // b3 non waived
    expect(lightSources(st, room).filter((s) => s.kind === 'brazier')).toHaveLength(1);
    const b2 = st.room.mechanisms[1];
    expect(b2.type).toBe('brazier');
    b2.active = true;
    const src = lightSources(st, room).filter((s) => s.kind === 'brazier');
    expect(src).toHaveLength(2);
    expect(src.find((s) => s.x === 10.5 * TILE)?.radius).toBe(2 * TILE);
  });

  it('les décors torch ne comptent pas hors salle sombre', () => {
    const bright = { ...room, dark: false };
    const src = lightSources(stateFor(bright, 2), bright);
    expect(src.some((s) => s.kind === 'decor')).toBe(false);
  });

  it('le rayon de la torche suit le combustible ; à terre : lueur minimale', () => {
    const st = stateFor(room, 2);
    st.players[0].torchMs = 0;
    st.players[1].status = 'down';
    const torches = lightSources(st, room).filter((s) => s.kind === 'torch');
    expect(torches.find((t) => t.playerId === 0)?.radius).toBe(LIGHT_EMPTY_TILES * TILE);
    expect(torches.find((t) => t.playerId === 1)?.radius).toBeLessThanOrEqual(LIGHT_EMPTY_TILES * TILE);
  });

  it('scintillement plus fort quand la torche faiblit', () => {
    const st = stateFor(room, 2);
    st.players[0].torchMs = TORCH_MAX_MS * TORCH_LOW_FRACTION * 0.5;
    const t = lightSources(st, room).filter((s) => s.kind === 'torch');
    expect(t.find((x) => x.playerId === 0)?.flicker).toBeGreaterThan(t.find((x) => x.playerId === 1)?.flicker ?? 1);
  });
});

describe('isLit', () => {
  it('vrai dans le rayon (bord inclus), faux au-delà ; aucune source ⇒ faux', () => {
    const src = [{ x: 100, y: 100, radius: 50, kind: 'brazier' as const }];
    expect(isLit({ x: 100, y: 100 }, src)).toBe(true);
    expect(isLit({ x: 150, y: 100 }, src)).toBe(true);
    expect(isLit({ x: 150.5, y: 100 }, src)).toBe(false);
    expect(isLit({ x: 130, y: 130 }, src)).toBe(true);
    expect(isLit({ x: 0, y: 0 }, [])).toBe(false);
  });

  it('plusieurs sources : une seule suffit', () => {
    const src = [
      { x: 0, y: 0, radius: 10, kind: 'torch' as const },
      { x: 200, y: 0, radius: 30, kind: 'brazier' as const },
    ];
    expect(isLit({ x: 215, y: 10 }, src)).toBe(true);
    expect(isLit({ x: 100, y: 0 }, src)).toBe(false);
  });
});
