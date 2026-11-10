/**
 * Mises en scène du TUTORIEL côté simulation : équipement posé / porté par script (`spawnScriptedGear`, `equipScripted`), cœur rangé d'office (`giveScriptedHeart`) et option
 * `SimConfig.gearDrops: false` (équipement actif, mais AUCUN butin d'équipement ni bonus temporaire aléatoire : aucun tirage du flux `gearRngState`).
 */
import { describe, expect, it } from 'vitest';
import { SIM_STEP_MS } from './constants';
import { createEnemyState } from './ai';
import { makeTestLayout, makeTestLevel, makeTestRoom } from './levelValidation';
import { createSimulation, GameSimulation } from './simulation';
import type { GearDropState, GearItem, LevelDef, PlayerId, SimEvent, SimConfig } from './types';

const DT = SIM_STEP_MS;

function arena(): LevelDef {
  return makeTestLevel({
    rooms: [
      makeTestRoom({
        id: 'r1',
        layout: makeTestLayout(30, 20),
        playerSpawns: [[5, 5], [6, 5], [5, 6], [6, 6]],
        mechanisms: [],
        exit: { rect: { x: 27, y: 17, w: 2, h: 2 }, requires: [] },
      }),
      makeTestRoom({ id: 'r2', exit: { rect: { x: 9, y: 5, w: 2, h: 2 }, requires: [], final: true } }),
    ],
    objectives: [0, 1, 2, 3].map((slot) => ({ id: `o${slot}`, slot, roomId: 'r1', kind: 'kills' as const, labelKey: `objective.test.o${slot}`, count: 99 })),
  });
}

function makeSim(over: Partial<SimConfig> = {}): GameSimulation {
  return createSimulation(
    {
      levelId: 'test',
      seed: 7,
      players: [0, 1].map((i) => ({ id: i as PlayerId, characterId: (['david', 'sandrine'] as const)[i], difficulty: 2 as const })),
      ...over,
    },
    arena(),
  );
}

const protection = (level: 1 | 2 | 3): GearItem => ({ slot: 'protection', level });
const magnet: GearItem = { slot: 'accessory', level: 1, accessory: 'magnet' };

describe('spawnScriptedGear : objet posé au sol par le script', () => {
  it('pose l objet (non verrouillé, durée de vie demandée), émet gearDropped au pas suivant, ne tire aucun flux aléatoire', () => {
    const s = makeSim();
    s.step(DT, {});
    const before = [s.state.rngState, s.state.lootRngState, s.state.gearRngState];
    expect(s.spawnScriptedGear({ x: 144, y: 104 }, protection(1), 600_000)).toBe(true);
    const ev = s.step(DT, {});
    expect(ev.some((e) => e.type === 'gearDropped' && e.item.slot === 'protection' && !e.scattered)).toBe(true);
    const d = (s.state.room.gearDrops as GearDropState[])[0];
    expect(d.lockedFor).toBeNull();
    expect(d.lockMode).toBe('life');
    expect(d.ttlMs).toBeGreaterThan(599_000);
    expect([s.state.rngState, s.state.lootRngState, s.state.gearRngState]).toEqual(before);
  });

  it('refuse (false, rien posé) : hors phase de jeu, TTL invalide, objet invalide (emplacement, niveau, accessoire sans sorte)', () => {
    const s = makeSim();
    s.step(DT, {});
    for (const ttl of [0, -5, Number.NaN, Infinity]) expect(s.spawnScriptedGear({ x: 100, y: 100 }, protection(1), ttl), String(ttl)).toBe(false);
    expect(s.spawnScriptedGear({ x: 100, y: 100 }, { slot: 'cape', level: 1 } as unknown as GearItem, 1000)).toBe(false);
    expect(s.spawnScriptedGear({ x: 100, y: 100 }, { slot: 'boots', level: 9 } as unknown as GearItem, 1000)).toBe(false);
    expect(s.spawnScriptedGear({ x: 100, y: 100 }, { slot: 'accessory', level: 1 }, 1000)).toBe(false);
    expect(s.spawnScriptedGear({ x: 100, y: 100 }, { slot: 'accessory', level: 1, accessory: 'sword' } as unknown as GearItem, 1000)).toBe(false);
    expect((s.state.room.gearDrops as GearDropState[]).length).toBe(0);
    s.state.phase = 'wipe';
    expect(s.spawnScriptedGear({ x: 100, y: 100 }, protection(1), 1000)).toBe(false);
  });
});

describe('equipScripted : équipement porté par script', () => {
  it('équipe l objet (remplace l emplacement), sans événement ni tirage ; un objet égal ou inférieur posé ensuite est « ignoré » (refusé)', () => {
    const s = makeSim();
    s.step(DT, {});
    const before = [s.state.rngState, s.state.lootRngState, s.state.gearRngState];
    expect(s.equipScripted(0, protection(2))).toBe(true);
    expect(s.state.players[0].loadout.protection).toBe(2);
    expect(s.equipScripted(0, { slot: 'accessory', level: 1, accessory: 'lantern' })).toBe(true);
    expect(s.state.players[0].loadout.accessory).toEqual({ kind: 'lantern', level: 1 });
    expect([s.state.rngState, s.state.lootRngState, s.state.gearRngState]).toEqual(before);
  });

  it('refuse : joueur inconnu ou à terre, objet invalide, hors phase de jeu', () => {
    const s = makeSim();
    s.step(DT, {});
    expect(s.equipScripted(9 as PlayerId, protection(1))).toBe(false);
    expect(s.equipScripted(0, { slot: 'accessory', level: 1 })).toBe(false);
    expect(s.equipScripted(0, { slot: 'boots', level: 0 } as unknown as GearItem)).toBe(false);
    s.knockDown(1);
    expect(s.equipScripted(1, protection(1))).toBe(false);
    s.state.phase = 'wipe';
    expect(s.equipScripted(0, protection(1))).toBe(false);
  });
});

describe('giveScriptedHeart : cœur rangé d office', () => {
  it('range le cœur dans un emplacement VIDE (avec l option heartSlot) ; un cœur déjà rangé n est jamais remplacé', () => {
    const s = makeSim({ heartSlot: true });
    s.step(DT, {});
    expect(s.giveScriptedHeart(0, 'full')).toBe(true);
    expect(s.state.players[0].heart).toBe('full');
    expect(s.giveScriptedHeart(0, 'half')).toBe(false);
    expect(s.state.players[0].heart).toBe('full');
  });

  it('refuse : sans l option heartSlot, genre inconnu, joueur à terre ou inconnu, hors phase de jeu', () => {
    const noSlot = makeSim();
    noSlot.step(DT, {});
    expect(noSlot.giveScriptedHeart(0, 'full')).toBe(false);
    expect(noSlot.state.players[0].heart).toBeUndefined();
    const s = makeSim({ heartSlot: true });
    s.step(DT, {});
    expect(s.giveScriptedHeart(0, 'quarter' as never)).toBe(false);
    expect(s.giveScriptedHeart(7 as PlayerId, 'full')).toBe(false);
    s.knockDown(1);
    expect(s.giveScriptedHeart(1, 'full')).toBe(false);
    s.state.phase = 'wipe';
    expect(s.giveScriptedHeart(0, 'full')).toBe(false);
  });
});

describe('SimConfig.gearDrops : butin d équipement aléatoire', () => {
  /** Tue beaucoup d ennemis dans une salle et retourne tous les événements. */
  function massacre(s: GameSimulation): SimEvent[] {
    const all: SimEvent[] = [];
    all.push(...s.step(DT, {}));
    for (let wave = 0; wave < 12; wave++) {
      for (let k = 0; k < 8; k++) {
        const e = createEnemyState('slime', { x: 200 + k * 20, y: 150 }, s.state.nextEntityId++, 0);
        e.hp = 0;
        e.dead = false;
        s.state.room.enemies.push(e);
      }
      for (let i = 0; i < 10; i++) all.push(...s.step(DT, {}));
    }
    return all;
  }

  it('par défaut (et `gearDrops: true`) : le champ d état est absent et les ennemis laissent du butin comme avant', () => {
    for (const cfg of [{}, { gearDrops: true }]) {
      const s = makeSim({ gear: true, loot: false, ...cfg });
      expect(s.state.gearDropsDisabled).toBeUndefined();
      expect(s.serialize()).not.toContain('gearDropsDisabled');
    }
    // contrôle positif : sans le réglage, le même massacre laisse bien des objets (sinon le test « sans butin » ne prouverait rien)
    const ev = massacre(makeSim({ gear: true, loot: false }));
    expect(ev.some((e) => e.type === 'gearDropped' || e.type === 'buffDropped')).toBe(true);
  });

  it('`gearDrops: false` avec équipement actif : champ posé, AUCUN objet ni bonus laissé par les ennemis, flux gearRngState et budgets de bonus inchangés', () => {
    const s = makeSim({ gear: true, loot: false, gearDrops: false });
    expect(s.state.gearDropsDisabled).toBe(true);
    expect(s.state.gearEnabled).toBe(true);
    const seed0 = s.state.gearRngState;
    const ev = massacre(s);
    expect(ev.some((e) => e.type === 'enemyDied')).toBe(true);
    expect(ev.some((e) => e.type === 'gearDropped' || e.type === 'buffDropped')).toBe(false);
    expect(s.state.gearRngState).toBe(seed0);
    expect(s.state.room.buffBudget ?? 0).toBe(0);
  });

  it('sans `gear: false` ce réglage n est pas posé (équipement désactivé : la démo reste identique à avant)', () => {
    const s = makeSim({ gear: false, gearDrops: false });
    expect(s.state.gearDropsDisabled).toBeUndefined();
    expect(s.state.gearEnabled).toBe(false);
  });

  it('un équipement posé par script fonctionne même avec `gearDrops: false` : l ennemi tué ne laisse rien, l objet posé est ramassé par qui en profite', () => {
    const s = makeSim({ gear: true, loot: false, gearDrops: false });
    s.step(DT, {});
    s.state.players[0].pos = { x: 100, y: 100 };
    s.state.players[1].pos = { x: 300, y: 200 };
    s.spawnScriptedGear({ x: 300, y: 200 }, protection(1), 600_000);
    const ev: SimEvent[] = [];
    for (let i = 0; i < 4; i++) ev.push(...s.step(DT, {}));
    expect(ev.some((e) => e.type === 'gearPicked' && e.playerId === 1)).toBe(true);
    expect(s.state.players[1].loadout.protection).toBe(1);
  });

  it('un ancien état sans le champ se restaure tel quel (butin actif)', () => {
    const s = makeSim({ gear: true });
    const st = JSON.parse(s.serialize());
    expect(st.gearDropsDisabled).toBeUndefined();
    const r = GameSimulation.restore(JSON.stringify(st), s.level);
    expect(r.state.gearDropsDisabled).toBeUndefined();
  });

  it('valeur hostile du champ à la restauration : tout ce qui n est pas exactement `true` est supprimé ; `true` est conservé', () => {
    const s = makeSim({ gear: true, loot: false, gearDrops: false });
    for (const bad of [false, 0, 1, 'true', null, {}, []]) {
      const st = JSON.parse(s.serialize());
      st.gearDropsDisabled = bad;
      const r = GameSimulation.restore(JSON.stringify(st), s.level);
      expect(r.state.gearDropsDisabled, JSON.stringify(bad)).toBeUndefined();
    }
    const ok = GameSimulation.restore(s.serialize(), s.level);
    expect(ok.state.gearDropsDisabled).toBe(true);
  });
});
