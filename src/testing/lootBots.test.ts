/**
 * Bots et sources de vie :
 *  - les bots existants jouent SANS sources de vie par défaut (`loot` faux) : leurs résultats sont strictement ceux d'avant l'ajout (mesuré :
 *    avec les sources actives ils en ramassent par hasard des dizaines par niveau, ce qui change durées et défaites) ;
 *  - la brique `eat` (option de fond, désactivée par défaut) : « ramasse la nourriture / utilise un cristal proche quand PV < 70 % », utilisée par la calibration.
 */
import { describe, expect, it } from 'vitest';
import { HEAL_CRYSTAL_HEAL } from '../core/balance';
import { TILE } from '../core/constants';
import { makeTestLayout, makeTestLevel, makeTestRoom } from '../core/levelValidation';
import type { HealCrystalDef, LevelDef, TileXY } from '../core/types';
import { attackUntilClear, BotRun, DEFAULT_BACKGROUND, runUntil } from './botKit';

/** Salle vide 40×12, le joueur apparaît à gauche ; aucune menace. */
function emptyLevel(crystals: HealCrystalDef[] = []): LevelDef {
  const room = makeTestRoom({
    id: 'r1',
    layout: makeTestLayout(40, 12),
    mechanisms: [],
    enemies: [],
    healCrystals: crystals,
    exit: { rect: { x: 36, y: 5, w: 2, h: 2 }, requires: [], final: true },
  });
  return makeTestLevel({ rooms: [room], objectives: [] });
}

function px(t: TileXY): { x: number; y: number } {
  return { x: (t[0] + 0.5) * TILE, y: (t[1] + 0.5) * TILE };
}

function food(run: BotRun, t: TileXY, kind: 'half' | 'full' = 'full'): void {
  const id = run.state.nextPickupId ?? 1;
  run.state.nextPickupId = id + 1;
  run.state.room.pickups?.push({ id, kind, pos: px(t), ttlMs: 12_000 });
}

describe('bots existants : sans sources de vie par défaut', () => {
  it('BotRun joue avec `loot` faux (rien ne tombe, aucun cristal) sauf demande explicite', () => {
    const level = emptyLevel([{ id: 'c1', tile: [20, 6] }]);
    const legacy = new BotRun(level, { playerCount: 1 });
    expect(legacy.state.lootEnabled).toBe(false);
    expect(legacy.state.room.healCrystals).toEqual([]);
    const real = new BotRun(level, { playerCount: 1, loot: true });
    expect(real.state.lootEnabled).toBe(true);
    expect(real.state.room.healCrystals).toEqual([{ id: 'c1', used: false }]);
  });

  it('la brique de ramassage est désactivée par défaut (les bots existants ne cherchent rien)', () => {
    expect(DEFAULT_BACKGROUND.eat).toBe(false);
    expect(DEFAULT_BACKGROUND.eatBelowFrac).toBe(0.7);
    const run = new BotRun(emptyLevel(), { playerCount: 1, loot: true });
    run.player(0).hp = 5;
    food(run, [10, 6]);
    for (let i = 0; i < 600; i++) run.stepOnce();
    expect(run.state.room.pickups).toHaveLength(1); // le bot n'est pas allé la chercher
    expect(run.player(0).hp).toBe(5);
  });
});

describe('brique « ramasse la nourriture proche quand PV < 70 % » (option eat)', () => {
  it('blessé sous 70 % : va ramasser la nourriture proche et se soigne', () => {
    const run = new BotRun(emptyLevel(), { playerCount: 1, loot: true, background: { eat: true } });
    const p = run.player(0);
    p.hp = Math.floor(p.maxHp * 0.5);
    const hp0 = p.hp;
    food(run, [10, 6], 'full');
    const ok = runUntil(run, () => run.state.room.pickups?.length === 0, 15_000).ok;
    expect(ok).toBe(true);
    expect(p.hp).toBe(hp0 + 10);
  });

  it('à 80 % de PV (au-dessus du seuil de 70 %) il ne se déplace pas pour elle', () => {
    const run = new BotRun(emptyLevel(), { playerCount: 1, loot: true, background: { eat: true } });
    const p = run.player(0);
    p.hp = Math.floor(p.maxHp * 0.8);
    food(run, [10, 6]);
    const start = { ...p.pos };
    for (let i = 0; i < 300; i++) run.stepOnce();
    expect(run.state.room.pickups).toHaveLength(1);
    expect(Math.hypot(p.pos.x - start.x, p.pos.y - start.y)).toBeLessThan(2);
  });

  it('ne va pas chercher une nourriture au-delà de eatRadius', () => {
    const run = new BotRun(emptyLevel(), { playerCount: 1, loot: true, background: { eat: true, eatRadius: 60 } });
    const p = run.player(0);
    p.hp = Math.floor(p.maxHp * 0.3);
    food(run, [30, 6]); // loin
    for (let i = 0; i < 300; i++) run.stepOnce();
    expect(run.state.room.pickups).toHaveLength(1);
  });

  it('utilise aussi un cristal de soin intact proche (50 PV), une seule fois', () => {
    const run = new BotRun(emptyLevel([{ id: 'c1', tile: [10, 6] }]), { playerCount: 1, loot: true, background: { eat: true } });
    const p = run.player(0);
    p.hp = 4;
    const ok = runUntil(run, () => run.state.room.healCrystals?.[0].used === true, 15_000).ok;
    expect(ok).toBe(true);
    expect(p.hp).toBe(Math.min(p.maxHp, 4 + HEAL_CRYSTAL_HEAL));
  });

  it('même graine : la partie avec la brique est reproductible', () => {
    const play = (): string => {
      const run = new BotRun(emptyLevel([{ id: 'c1', tile: [14, 6] }]), { playerCount: 2, loot: true, seed: 3, background: { eat: true } });
      run.player(0).hp = 10;
      run.player(1).hp = 20;
      food(run, [8, 4], 'half');
      for (let i = 0; i < 900; i++) run.stepOnce();
      return run.sim.serialize();
    };
    expect(play()).toBe(play());
  });
});

describe('la brique eat agit aussi dans attackUntilClear (boucle de combat des scripts de niveaux)', () => {
  /** Salle 40×12 avec un squelette lointain à droite ; une nourriture à 3 tuiles sous la route du joueur (hors contact fortuit). */
  function scripted(eat: boolean): BotRun {
    const room = makeTestRoom({
      id: 'r1',
      layout: makeTestLayout(40, 12),
      mechanisms: [],
      enemies: [{ kind: 'skeleton', tile: [36, 6] }],
      exit: { rect: { x: 36, y: 5, w: 2, h: 2 }, requires: [], final: true },
    });
    const level = makeTestLevel({ rooms: [room], objectives: [] });
    const run = new BotRun(level, { playerCount: 1, loot: true, background: { eat } });
    const p = run.player(0);
    p.hp = Math.floor(p.maxHp * 0.4);
    const tile: TileXY = [Math.floor(p.pos.x / TILE) + 4, Math.floor(p.pos.y / TILE) + 3];
    food(run, tile, 'full');
    run.queue(0, attackUntilClear({ maxMs: 60_000 }));
    return run;
  }

  it("avec eat : blessé, il fait un détour pour la nourriture proche avant de poursuivre l'ennemi", () => {
    const run = scripted(true);
    const hp0 = run.player(0).hp;
    for (let i = 0; i < 400; i++) run.stepOnce();
    expect(run.state.room.pickups).toHaveLength(0);
    expect(run.player(0).hp).toBeGreaterThan(hp0);
  });

  it('sans eat (défaut) : la même partie ne ramasse rien (résultats des bots existants inchangés)', () => {
    const run = scripted(false);
    for (let i = 0; i < 400; i++) run.stepOnce();
    expect(run.state.room.pickups).toHaveLength(1);
  });
});
