import { describe, expect, it } from 'vitest';
import {
  BRAZIER_LIGHT_TILES,
  LIGHT_EMPTY_TILES,
  LIGHT_FULL_TILES,
  TILE,
  TORCH_LOW_FRACTION,
  TORCH_MAX_MS,
} from './constants';
import { makeTestLayout, makeTestRoom } from './levelValidation';
import { brazierRadiusPx, DECOR_TORCH_LIGHT_TILES, isLit, lightSources, torchFuelFraction, torchRadiusPx } from './light';
import { torchBarWidth, torchFraction } from '../render/torchHud';
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

describe('torchRadiusPx : la lumière décroît en continu, proportionnellement à la jauge', () => {
  const FULL = LIGHT_FULL_TILES * TILE;
  const EMPTY = LIGHT_EMPTY_TILES * TILE;

  it('f = 1 : rayon plein ; f = 0 : rayon de torche vide ; f = 0,5 : le milieu exact', () => {
    expect(torchRadiusPx(TORCH_MAX_MS)).toBe(FULL);
    expect(torchRadiusPx(0)).toBe(EMPTY);
    expect(torchRadiusPx(TORCH_MAX_MS * 0.5)).toBeCloseTo((FULL + EMPTY) / 2, 9);
    expect(EMPTY).toBe(28);
    expect(FULL).toBe(96);
  });

  it('formule : rayon = lerp(LIGHT_EMPTY_TILES, LIGHT_FULL_TILES, f) × TILE, pour tout f', () => {
    for (let k = 0; k <= 100; k++) {
      const f = k / 100;
      expect(torchRadiusPx(f * TORCH_MAX_MS)).toBeCloseTo((LIGHT_EMPTY_TILES + f * (LIGHT_FULL_TILES - LIGHT_EMPTY_TILES)) * TILE, 9);
    }
  });

  it('plus de palier : plus de plateau plein au-dessus du seuil de faiblesse (ancienne courbe en marches)', () => {
    // avant : plein dès 25 % (et jusqu'à 100 %) ; maintenant : strictement croissant, rien n'est plein avant 100 %
    expect(torchRadiusPx(TORCH_MAX_MS * TORCH_LOW_FRACTION)).toBeLessThan(torchRadiusPx(TORCH_MAX_MS * 0.5));
    expect(torchRadiusPx(TORCH_MAX_MS * 0.5)).toBeLessThan(torchRadiusPx(TORCH_MAX_MS * 0.9));
    expect(torchRadiusPx(TORCH_MAX_MS * 0.9)).toBeLessThan(FULL);
    expect(torchRadiusPx(TORCH_MAX_MS * 0.75)).toBeCloseTo((LIGHT_EMPTY_TILES + 0.75 * (LIGHT_FULL_TILES - LIGHT_EMPTY_TILES)) * TILE, 9);
  });

  it('valeurs hors bornes : négatif ⇒ vide, au-delà du plein ⇒ plein, non fini ⇒ 0', () => {
    expect(torchRadiusPx(-10)).toBe(EMPTY);
    expect(torchRadiusPx(Number.NEGATIVE_INFINITY)).toBe(EMPTY);
    expect(torchRadiusPx(Number.NaN)).toBe(EMPTY);
    expect(torchRadiusPx(Number.POSITIVE_INFINITY)).toBe(EMPTY); // non fini ⇒ traité comme 0 (comme torchFraction)
    expect(torchRadiusPx(TORCH_MAX_MS * 10)).toBe(FULL);
    expect(torchRadiusPx(TORCH_MAX_MS + 1)).toBe(FULL);
  });

  it('strictement croissante sur [0, TORCH_MAX_MS] (pas de 250 ms) et bornée', () => {
    let prev = -Infinity;
    for (let ms = 0; ms <= TORCH_MAX_MS; ms += 250) {
      const r = torchRadiusPx(ms);
      expect(r).toBeGreaterThan(prev);
      expect(r).toBeGreaterThanOrEqual(EMPTY);
      expect(r).toBeLessThanOrEqual(FULL);
      prev = r;
    }
  });

  it('continue : sur un pas de 1 ms le rayon varie de moins de 0,001 px (aucun saut)', () => {
    let prev = torchRadiusPx(0);
    for (let ms = 1; ms <= TORCH_MAX_MS; ms += 1) {
      const r = torchRadiusPx(ms);
      expect(Math.abs(r - prev)).toBeLessThan(1e-3);
      prev = r;
    }
  });

  it('pente constante : (FULL - EMPTY) / TORCH_MAX_MS px par ms, y compris sous et sur le seuil de faiblesse', () => {
    const slope = (FULL - EMPTY) / TORCH_MAX_MS;
    for (const f of [0.01, 0.1, TORCH_LOW_FRACTION - 0.001, TORCH_LOW_FRACTION + 0.001, 0.6, 0.99]) {
      const ms = f * TORCH_MAX_MS;
      expect((torchRadiusPx(ms + 100) - torchRadiusPx(ms - 100)) / 200).toBeCloseTo(slope, 9);
    }
  });

  it('même fraction que la jauge du HUD : rayon et barre sont liés linéairement', () => {
    const fullW = 40;
    for (let ms = 0; ms <= TORCH_MAX_MS; ms += 500) {
      expect(torchFuelFraction(ms)).toBe(torchFraction(ms));
      // la jauge est proportionnelle à la fraction (à l'arrondi du pixel près) ; le rayon aussi
      const f = torchFraction(ms);
      expect(Math.abs(torchBarWidth(ms, fullW) - fullW * f)).toBeLessThanOrEqual(1);
      expect((torchRadiusPx(ms) - EMPTY) / (FULL - EMPTY)).toBeCloseTo(f, 9);
    }
    // rapport « part de lumière restante / part de jauge restante » : toujours 1
    const part = (ms: number) => (torchRadiusPx(ms) - EMPTY) / (FULL - EMPTY);
    expect(part(TORCH_MAX_MS * 0.5) / torchFraction(TORCH_MAX_MS * 0.5)).toBeCloseTo(1, 9);
    expect(part(TORCH_MAX_MS * 0.2) / torchFraction(TORCH_MAX_MS * 0.2)).toBeCloseTo(1, 9);
  });

  it('torchFuelFraction : borné à [0, 1], jamais NaN', () => {
    expect(torchFuelFraction(0)).toBe(0);
    expect(torchFuelFraction(TORCH_MAX_MS)).toBe(1);
    expect(torchFuelFraction(-5)).toBe(0);
    expect(torchFuelFraction(TORCH_MAX_MS * 3)).toBe(1);
    expect(torchFuelFraction(Number.NaN)).toBe(0);
    expect(torchFuelFraction(TORCH_MAX_MS / 4)).toBeCloseTo(0.25, 12);
  });

  it('équilibrage (mesuré) : sur un plein réservoir, rayon moyen 3,875 tuiles ; 39,7 s sous 4 tuiles ; 22,1 s sous 3 tuiles', () => {
    let sum = 0;
    let under4 = 0;
    let under3 = 0;
    for (let t = 0; t < TORCH_MAX_MS; t++) {
      const r = torchRadiusPx(TORCH_MAX_MS - t - 0.5) / TILE;
      sum += r;
      if (r < 4) under4++;
      if (r < 3) under3++;
    }
    expect(sum / TORCH_MAX_MS).toBeCloseTo((LIGHT_EMPTY_TILES + LIGHT_FULL_TILES) / 2, 6);
    expect(under4 / 1000).toBeCloseTo(39.7, 1);
    expect(under3 / 1000).toBeCloseTo(22.06, 1);
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

  it('à terre : faible lueur = min(rayon, LIGHT_EMPTY_TILES × TILE) ; torche pleine à terre plafonnée', () => {
    const st = stateFor(room, 2);
    st.players[0].status = 'down';
    st.players[1].status = 'down';
    st.players[1].torchMs = TORCH_MAX_MS * 0.5;
    st.players[0].torchMs = 0;
    const torches = lightSources(st, room).filter((s) => s.kind === 'torch');
    expect(torches.find((t) => t.playerId === 0)?.radius).toBe(LIGHT_EMPTY_TILES * TILE);
    expect(torches.find((t) => t.playerId === 1)?.radius).toBe(LIGHT_EMPTY_TILES * TILE); // plafonné
  });

  it('le rayon de la torche du joueur vivant suit torchRadiusPx (continu, à tout niveau de combustible)', () => {
    const st = stateFor(room, 1);
    for (const f of [1, 0.9, 0.5, 0.26, 0.24, 0.1, 0]) {
      st.players[0].torchMs = f * TORCH_MAX_MS;
      const r = lightSources(st, room).find((s) => s.kind === 'torch')?.radius;
      expect(r).toBe(torchRadiusPx(f * TORCH_MAX_MS));
    }
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
