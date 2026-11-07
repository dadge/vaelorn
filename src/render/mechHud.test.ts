import { beforeAll, describe, expect, it } from 'vitest';
import { SIM_STEP_MS, TILE } from '../core/constants';
import { createSimulation, type GameSimulation } from '../core/simulation';
import type { Dir, HourglassDef, HourglassState, LightBridgeDef, PlayerSetup, StatuePairDef, StatuePairState } from '../core/types';
import { buildDevTestLevel, type DevTestKind } from '../entities/devRooms';
import { setLanguage } from '../i18n/i18n';
import { computeContextPrompt } from './hud';
import {
  HOURGLASS_LOW_RATIO,
  activeHourglass,
  bridgeRadiusPx,
  bridgeTileLit,
  dirAngle,
  dirUnit,
  gateClosedFlags,
  hourglassBarColor,
  hourglassBarWidth,
  hourglassBlinkAlpha,
  hourglassLevel,
  hourglassStatus,
  isLanternBearer,
  lanternBearers,
  lanternHudInfo,
  lanternLightSources,
  sandJumped,
  sandRatio,
  statueOnTarget,
  statueTargetArrow,
  statuesSolved,
} from './mechHud';

beforeAll(() => setLanguage('en'));

const setups = (n: number): PlayerSetup[] =>
  (['david', 'sandrine', 'romain', 'valentine'] as const).slice(0, n).map((characterId, i) => ({ id: i as 0 | 1 | 2 | 3, characterId, difficulty: 2 }));

function simFor(kind: DevTestKind, players = 2): GameSimulation {
  const level = buildDevTestLevel(kind);
  const sim = createSimulation({ levelId: level.id, players: setups(players), seed: 7 }, level);
  sim.step(SIM_STEP_MS, {});
  return sim;
}

function put(sim: GameSimulation, id: number, tile: readonly [number, number]): void {
  sim.state.players[id].pos = { x: (tile[0] + 0.5) * TILE, y: (tile[1] + 0.5) * TILE };
}

describe('statues jumelles : affichage', () => {
  it('directions : angle et vecteur cohérents', () => {
    expect(dirAngle('right')).toBe(0);
    expect(dirAngle('down')).toBeCloseTo(Math.PI / 2);
    expect(dirUnit('up')).toEqual({ x: 0, y: -1 });
    expect(dirUnit('left')).toEqual({ x: -1, y: 0 });
  });

  const def = { targetDir: 'up' } as Pick<StatuePairDef, 'targetDir'>;
  const st = (facings: [Dir, Dir], active = false, waived = false) => ({ facings, active, waived });

  it('statuesSolved / statueOnTarget', () => {
    expect(statuesSolved({ active: false, waived: false })).toBe(false);
    expect(statuesSolved({ active: true, waived: false })).toBe(true);
    expect(statuesSolved({ active: false, waived: true })).toBe(true);
    expect(statueOnTarget(def, st(['up', 'down']), 0)).toBe(true);
    expect(statueOnTarget(def, st(['up', 'down']), 1)).toBe(false);
    expect(statueOnTarget(def, st(['left', 'left'], false, true), 1)).toBe(true);
  });

  it('flèche cible : visible seulement si la statue ne regarde pas la cible et que ce n est pas résolu ; pointe vers la cible', () => {
    const a = statueTargetArrow(def, st(['down', 'up']), 0, 0);
    expect(a.visible).toBe(true);
    expect(a.dy).toBeLessThan(0);
    expect(Math.abs(a.dx)).toBeLessThan(0.001);
    expect(a.rotation).toBeCloseTo(dirAngle('up') - Math.PI / 2);
    expect(statueTargetArrow(def, st(['down', 'up']), 1, 0).visible).toBe(false);
    expect(statueTargetArrow(def, st(['up', 'up'], true), 0, 0).visible).toBe(false);
    const r = statueTargetArrow({ targetDir: 'right' }, st(['down', 'down']), 0, 500);
    expect(r.dx).toBeGreaterThan(0);
    expect(r.alpha).toBeGreaterThan(0);
    expect(r.alpha).toBeLessThanOrEqual(1);
    expect(Number.isFinite(statueTargetArrow(def, st(['down', 'up']), 0, Number.NaN).alpha)).toBe(true);
  });

  it('simulation réelle : invite pivoter sur un socle, rien ailleurs', () => {
    const sim = simFor('statues');
    const room = sim.room;
    const stDef = room.mechanisms[0] as StatuePairDef;
    put(sim, 0, stDef.statues[0].standTile);
    expect(computeContextPrompt(sim.state, sim.level, room, 0)?.key).toBe('hint.rotateStatue');
    put(sim, 0, [10, 2]);
    expect(computeContextPrompt(sim.state, sim.level, room, 0)).toBeNull();
    const s = sim.state.room.mechanisms[0] as StatuePairState;
    expect(s.facings).toEqual(['down', 'left']);
  });
});

describe('sablier : statut et alertes', () => {
  const def: HourglassDef = { id: 'h', type: 'hourglass', levers: [[1, 1], [2, 2]], gate: [[3, 3], [4, 4], [5, 5]], periodMs: 10000, displayTile: [0, 0] };
  const mk = (sandMs: number, closedCount = 0, waived = false): HourglassState => ({ id: 'h', type: 'hourglass', waived, active: sandMs > 0, sandMs, closedCount, stepMs: 700, lastLever: -1 });

  it('période effective doublée en solo : même sable = fraction plus faible', () => {
    expect(hourglassStatus(def, mk(10000), 2).ratio).toBe(1);
    expect(hourglassStatus(def, mk(10000), 1).periodMs).toBe(20000);
    expect(hourglassStatus(def, mk(10000), 1).ratio).toBeCloseTo(0.5);
  });

  it('secondes restantes arrondies au supérieur ; niveaux ok / low / empty', () => {
    expect(hourglassStatus(def, mk(4100), 2).seconds).toBe(5);
    expect(hourglassStatus(def, mk(0), 2).seconds).toBe(0);
    expect(hourglassStatus(def, mk(0), 2).level).toBe('empty');
    expect(hourglassStatus(def, mk(2000), 2).level).toBe('low');
    expect(hourglassStatus(def, mk(2600), 2).level).toBe('ok');
    expect(HOURGLASS_LOW_RATIO).toBeGreaterThan(0);
    expect(hourglassLevel(1, 0.1)).toBe('low');
  });

  it('robuste aux valeurs aberrantes (NaN, sable > période, herse hors bornes)', () => {
    expect(sandRatio(Number.NaN, 1000)).toBe(0);
    expect(sandRatio(5000, 1000)).toBe(1);
    expect(sandRatio(-5, 1000)).toBe(0);
    expect(sandRatio(0, 0)).toBe(0);
    expect(hourglassStatus(def, mk(1000, 99), 2).closed).toBe(3);
    expect(hourglassStatus(def, { ...mk(1000), closedCount: Number.NaN }, 2).closed).toBe(0);
    expect(hourglassStatus(def, mk(1000, 2), 2).total).toBe(3);
  });

  it('barre : largeur d au moins 1 px tant qu il reste du sable, couleurs, clignotement', () => {
    expect(hourglassBarWidth(0, 100)).toBe(0);
    expect(hourglassBarWidth(0.001, 100)).toBe(1);
    expect(hourglassBarWidth(0.5, 100)).toBe(50);
    expect(hourglassBarWidth(3, 100)).toBe(100);
    expect(new Set((['ok', 'low', 'empty'] as const).map((l) => hourglassBarColor(l))).size).toBe(3);
    expect(hourglassBlinkAlpha('ok', 123)).toBe(1);
    for (let t = 0; t < 2000; t += 37) {
      for (const l of ['low', 'empty'] as const) {
        const a = hourglassBlinkAlpha(l, t);
        expect(a).toBeGreaterThan(0);
        expect(a).toBeLessThanOrEqual(1);
      }
    }
  });

  it('herse : les closedCount premières tuiles sont fermées ; retournement détecté sur un saut de sable', () => {
    expect(gateClosedFlags(0, 3)).toEqual([false, false, false]);
    expect(gateClosedFlags(2, 3)).toEqual([true, true, false]);
    expect(gateClosedFlags(9, 3)).toEqual([true, true, true]);
    expect(gateClosedFlags(Number.NaN, 2)).toEqual([false, false]);
    expect(sandJumped(0, 12000)).toBe(true);
    expect(sandJumped(5000, 4984)).toBe(false);
    expect(sandJumped(5000, 5016)).toBe(false);
  });

  it('simulation réelle : sablier actif, invite retourner près d un levier, bandeau absent si neutralisé', () => {
    const sim = simFor('hourglass');
    const hg = activeHourglass(sim.state, sim.room);
    expect(hg).not.toBeNull();
    expect(hg?.def.id).toBe('hg');
    const d = sim.room.mechanisms[0] as HourglassDef;
    put(sim, 0, d.levers[0]);
    expect(computeContextPrompt(sim.state, sim.level, sim.room, 0)?.key).toBe('hint.flipHourglass');
    const other = simFor('statues');
    expect(activeHourglass(other.state, other.room)).toBeNull();
    (sim.state.room.mechanisms[0] as HourglassState).waived = true;
    expect(activeHourglass(sim.state, sim.room)).toBeNull();
  });
});

describe('pont de lumière : lanterne', () => {
  it('porteur, rayon du halo = rayon d éclairage du pont, source de lumière côté rendu', () => {
    const sim = simFor('bridge');
    const def = sim.room.mechanisms[0] as LightBridgeDef;
    const bearers = lanternBearers(sim.state, sim.room);
    expect(bearers).toHaveLength(1);
    expect(bearers[0]).toMatchObject({ playerId: 0, mechanismId: 'bridge', radiusPx: bridgeRadiusPx(def) });
    expect(bridgeRadiusPx(def)).toBe(3 * TILE);
    expect(isLanternBearer(bearers, 0)).toBe(true);
    expect(isLanternBearer(bearers, 1)).toBe(false);

    const lights = lanternLightSources(sim.state, sim.room);
    expect(lights).toHaveLength(1);
    expect(lights[0].radius).toBe(3 * TILE);
    expect(lights[0].x).toBe(sim.state.players[0].pos.x);
    const shown = lanternLightSources(sim.state, sim.room, () => ({ x: 5, y: 6 }));
    expect(shown[0]).toMatchObject({ x: 5, y: 6 });
    // porteur à terre : le joueur vivant le plus proche (J2) reprend la lanterne (pas d'impasse sur un pont éteint)
    sim.state.players[0].status = 'down';
    sim.step(SIM_STEP_MS, {});
    const relay = lanternBearers(sim.state, sim.room);
    expect(relay).toHaveLength(1);
    expect(relay[0]).toMatchObject({ playerId: 1, mechanismId: 'bridge' });
    expect(lanternLightSources(sim.state, sim.room)).toHaveLength(1);
    // tout le monde à terre : plus de lanterne
    sim.state.players[1].status = 'down';
    sim.step(SIM_STEP_MS, {});
    expect(lanternLightSources(sim.state, sim.room)).toHaveLength(0);
  });

  it('indicateur de HUD : porteur ou suiveur (avec le porteur à nommer), rien sans lanterne', () => {
    expect(lanternHudInfo([], 0)).toBeNull();
    const b = [{ playerId: 1 as const, mechanismId: 'x', radiusPx: 48 }];
    expect(lanternHudInfo(b, 1)).toEqual({ isBearer: true, bearerId: 1 });
    expect(lanternHudInfo(b, 0)).toEqual({ isBearer: false, bearerId: 1 });
  });

  it('tuiles éclairées : suit lit[], neutralisé = toujours éclairé, hors bornes = sombre', () => {
    expect(bridgeTileLit({ lit: [true, false], waived: false }, 0)).toBe(true);
    expect(bridgeTileLit({ lit: [true, false], waived: false }, 1)).toBe(false);
    expect(bridgeTileLit({ lit: [true, false], waived: false }, 7)).toBe(false);
    expect(bridgeTileLit({ lit: [], waived: true }, 3)).toBe(true);
  });

  it('simulation réelle : au départ seules les tuiles proches du porteur sont éclairées', () => {
    const sim = simFor('bridge');
    const def = sim.room.mechanisms[0] as LightBridgeDef;
    const st = sim.state.room.mechanisms[0];
    expect(st.type).toBe('lightBridge');
    if (st.type !== 'lightBridge') return;
    expect(st.lit).toHaveLength(def.tiles.length);
    expect(bridgeTileLit(st, def.tiles.length - 1)).toBe(false);
  });
});
