/**
 * Bots et équipement :
 *  - les bots existants jouent SANS équipement par défaut (`gear` faux) : leurs résultats sont strictement ceux d'avant l'ajout (même principe que `loot`) ;
 *  - la brique `pickGear` (option de fond, désactivée par défaut) : « ramasse l'équipement proche strictement meilleur », utilisée par la calibration ;
 *  - `enableGear` active l'équipement sur une partie déjà créée (fabriques des niveaux).
 */
import { describe, expect, it } from 'vitest';
import { TILE } from '../core/constants';
import { makeTestLayout, makeTestLevel, makeTestRoom } from '../core/levelValidation';
import type { GearItem, LevelDef, TileXY } from '../core/types';
import { BotRun, DEFAULT_BACKGROUND, runUntil } from './botKit';
import { enableGear } from './lootCalibration';

function emptyLevel(): LevelDef {
  const room = makeTestRoom({
    id: 'r1',
    layout: makeTestLayout(40, 12),
    mechanisms: [],
    enemies: [],
    exit: { rect: { x: 36, y: 5, w: 2, h: 2 }, requires: [], final: true },
  });
  return makeTestLevel({ rooms: [room], objectives: [] });
}

const px = (t: TileXY): { x: number; y: number } => ({ x: (t[0] + 0.5) * TILE, y: (t[1] + 0.5) * TILE });

function drop(run: BotRun, t: TileXY, item: GearItem, lockedFor: 0 | 1 | null = null): void {
  const id = run.state.nextGearDropId ?? 1;
  run.state.nextGearDropId = id + 1;
  run.state.room.gearDrops?.push({ id, item, pos: px(t), ttlMs: 20_000, lockedFor, lockMode: 'life' });
}

describe('bots existants : sans équipement par défaut', () => {
  it('BotRun joue avec `gear` faux (aucun objet, budget 0) sauf demande explicite', () => {
    const legacy = new BotRun(emptyLevel(), { playerCount: 1 });
    expect(legacy.state.gearEnabled).toBe(false);
    expect(legacy.state.room.gearBudget).toBe(0);
    const real = new BotRun(emptyLevel(), { playerCount: 2, gear: true });
    expect(real.state.gearEnabled).toBe(true);
    expect(real.state.room.gearBudget).toBe(2);
  });
  it('la brique de ramassage est désactivée par défaut : un bot ne va pas chercher l\'équipement', () => {
    expect(DEFAULT_BACKGROUND.pickGear).toBe(false);
    const run = new BotRun(emptyLevel(), { playerCount: 1, gear: true });
    drop(run, [10, 6], { slot: 'boots', level: 3 });
    for (let i = 0; i < 600; i++) run.stepOnce();
    expect(run.state.room.gearDrops).toHaveLength(1);
    expect(run.player(0).loadout.boots).toBe(0);
  });
});

describe('brique « ramasse l\'équipement proche » (option pickGear)', () => {
  it('va chercher un objet strictement meilleur et l\'équipe', () => {
    const run = new BotRun(emptyLevel(), { playerCount: 1, gear: true, background: { pickGear: true } });
    drop(run, [8, 6], { slot: 'protection', level: 2 });
    const ok = runUntil(run, () => run.player(0).loadout.protection === 2, 15_000).ok;
    expect(ok).toBe(true);
    expect(run.state.room.gearDrops).toHaveLength(0);
  });
  it('ignore un objet qui ne serait pas ramassé (niveau égal) ou qui lui est verrouillé', () => {
    const run = new BotRun(emptyLevel(), { playerCount: 1, gear: true, background: { pickGear: true } });
    run.player(0).loadout.boots = 2;
    drop(run, [8, 6], { slot: 'boots', level: 2 });
    drop(run, [9, 6], { slot: 'weapon', level: 1 }, 0);
    for (let i = 0; i < 400; i++) run.stepOnce();
    expect(run.state.room.gearDrops).toHaveLength(2);
  });
  it('rayon de repérage : un objet trop loin n\'est pas cherché', () => {
    const run = new BotRun(emptyLevel(), { playerCount: 1, gear: true, background: { pickGear: true, gearRadius: 20 } });
    drop(run, [20, 6], { slot: 'weapon', level: 3 });
    for (let i = 0; i < 300; i++) run.stepOnce();
    expect(run.player(0).loadout.weapon).toBe(0);
  });
  it('enableGear : active l\'équipement et la brique sur une partie existante', () => {
    const run = new BotRun(emptyLevel(), { playerCount: 2 });
    expect(run.state.gearEnabled).toBe(false);
    enableGear(run);
    expect(run.state.gearEnabled).toBe(true);
    expect(run.state.room.gearBudget).toBe(2);
    drop(run, [8, 6], { slot: 'artifact', level: 1 });
    const ok = runUntil(run, () => run.player(0).loadout.artifact === 1 || run.player(1).loadout.artifact === 1, 15_000).ok;
    expect(ok).toBe(true);
  });
});

describe('brique « équipement » : accessoires et bonus temporaires', () => {
  it('va chercher un accessoire pour un emplacement vide, un bonus temporaire au sol, et ignore un accessoire d\'une autre sorte (échange manuel)', () => {
    const run = new BotRun(emptyLevel(), { playerCount: 1, gear: true, background: { pickGear: true } });
    drop(run, [8, 6], { slot: 'accessory', level: 1, accessory: 'magnet' });
    expect(runUntil(run, () => run.player(0).loadout.accessory?.kind === 'magnet', 15_000).ok).toBe(true);
    // accessoire d'une AUTRE sorte : jamais visé (il faudrait appuyer sur A) ; le bot ne bouge pas pour lui
    drop(run, [20, 6], { slot: 'accessory', level: 3, accessory: 'lantern' });
    for (let i = 0; i < 300; i++) run.stepOnce();
    expect(run.player(0).loadout.accessory).toEqual({ kind: 'magnet', level: 1 });
    expect(run.state.room.gearDrops).toHaveLength(1);
    // bonus temporaire au sol : ramassé
    const id = run.state.nextGearDropId ?? 1;
    run.state.nextGearDropId = id + 1;
    run.state.room.buffDrops?.push({ id, kind: 'speed', pos: px([12, 6]), ttlMs: 20_000 });
    expect(runUntil(run, () => run.player(0).loadout.buffs.some((b) => b.kind === 'speed'), 15_000).ok).toBe(true);
  });
});
