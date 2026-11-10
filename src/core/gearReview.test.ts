/**
 * Équipement : correctifs de RELECTURE, mesurés dans la simulation.
 *  - morts simultanées : le budget est réparti selon la pondération (costaud x4, standard x1, faible x0,5), pas selon l'ordre du tableau ;
 *  - un appui d'action = UN effet (mécanisme OU échange d'accessoire, jamais les deux) ;
 *  - l'objet laissé par le dernier ennemi reste ramassable (et vieillit) pendant la phase 'roomCleared' ;
 *  - l'aimant ne « vole » pas un objet à un allié mieux placé ;
 *  - le harnais du tutoriel joue sans équipement, comme la scène.
 */
import { describe, expect, it } from 'vitest';
import { GEAR_PICKUP_RADIUS, GEAR_TTL_MS } from './balance';
import { SIM_STEP_MS } from './constants';
import { makeTestLevel, makeTestRoom } from './levelValidation';
import { createSimulation, GameSimulation } from './simulation';
import type { ActionFrame, CharacterId, EnemyKind, GearItem, LevelDef, PlayerId, PlayerLoadout, PlayerSetup, RoomDef, SimEvent, TickInputs, TileXY } from './types';
import { TutorialRun } from '../testing/tutorial.solution';

const DT = SIM_STEP_MS;

function setups(n: number, characterId: CharacterId = 'david'): PlayerSetup[] {
  return Array.from({ length: n }, (_, i) => ({ id: i as PlayerId, characterId, difficulty: 2 }));
}

function room(id: string, over: Partial<RoomDef> = {}): RoomDef {
  return makeTestRoom({ id, exit: { rect: { x: 9, y: 5, w: 2, h: 2 }, requires: [] }, mechanisms: [{ id: 'p1', type: 'plate', tile: [6, 4] }], ...over });
}

function level(rooms: RoomDef[]): LevelDef {
  rooms[rooms.length - 1].exit.final = true;
  return makeTestLevel({ rooms });
}

function mk(n: number, r: RoomDef = room('r1'), seed = 5): GameSimulation {
  const lv = level([r, room('r2')]);
  return createSimulation({ levelId: lv.id, players: setups(n), seed, loot: false }, lv);
}

function ofType<T extends SimEvent['type']>(events: readonly SimEvent[], type: T): Extract<SimEvent, { type: T }>[] {
  return events.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);
}

function stepN(s: GameSimulation, n: number, inputs: TickInputs | ((i: number) => TickInputs) = {}): SimEvent[] {
  const all: SimEvent[] = [];
  for (let i = 0; i < n; i++) all.push(...s.step(DT, typeof inputs === 'function' ? inputs(i) : inputs));
  return all;
}

function frame(over: Partial<ActionFrame> = {}): ActionFrame {
  return { moveX: 0, moveY: 0, attack: false, interact: false, revive: false, special: false, call: false, ...over };
}

function put(s: GameSimulation, id: PlayerId, x: number, y: number): void {
  s.state.players[id].pos = { x, y };
}

function wear(s: GameSimulation, id: PlayerId, g: Partial<PlayerLoadout>): void {
  Object.assign(s.state.players[id].loadout, g);
}

function addDrop(s: GameSimulation, item: GearItem, x: number, y: number): number {
  const id = s.state.nextGearDropId ?? 1;
  s.state.nextGearDropId = id + 1;
  s.state.room.gearDrops?.push({ id, item, pos: { x, y }, ttlMs: GEAR_TTL_MS, lockedFor: null, lockMode: 'life' });
  return id;
}

function foes(kinds: EnemyKind[], tiles: TileXY[]): RoomDef['enemies'] {
  return kinds.map((kind, i) => ({ kind, tile: tiles[i % tiles.length] }));
}

describe('morts simultanées : le budget suit la pondération, pas l\'ordre du tableau', () => {
  const TILES: TileXY[] = [[8, 2], [8, 3], [9, 2], [9, 3]];
  /** Solo, 3 faibles + 1 costaud (le costaud est EN DERNIER) : renvoie le nombre d'objets venus du costaud et du 1er faible, sur `seeds` graines. */
  function run(simultaneous: boolean, seeds: number): { knight: number; firstSlime: number; total: number } {
    let knight = 0;
    let firstSlime = 0;
    let total = 0;
    for (let seed = 1; seed <= seeds; seed++) {
      const s = mk(1, room('r1', { enemies: foes(['slime', 'slime', 'slime', 'knight'], TILES) }), seed);
      s.state.players[0].invulnMs = 1e9;
      s.step(DT, {}); // apparitions
      const order = s.state.room.enemies.map((e) => e.kind);
      expect(order).toEqual(['slime', 'slime', 'slime', 'knight']);
      let ev: SimEvent[] = [];
      if (simultaneous) {
        for (const e of s.state.room.enemies) e.hp = 0;
        ev = s.step(DT, {});
      } else {
        for (let i = 0; i < 6 && s.state.room.enemies.length > 0; i++) {
          const e = s.state.room.enemies.find((x) => x.hp > 0);
          if (e) e.hp = 0;
          ev = ev.concat(s.step(DT, {}));
        }
      }
      const died = ofType(ev, 'enemyDied');
      const drops = ofType(ev, 'gearDropped');
      expect(drops.length).toBeLessThanOrEqual(1);
      if (drops.length === 1) {
        total++;
        // l'objet est posé sur l'ennemi qui l'a laissé : on retrouve sa sorte par la position la plus proche
        const d = drops[0].pos;
        let best = died[0];
        let bd = Infinity;
        for (const e of died) {
          const dd = (e.pos.x - d.x) ** 2 + (e.pos.y - d.y) ** 2;
          if (dd < bd) {
            bd = dd;
            best = e;
          }
        }
        if (best.kind === 'knight') knight++;
        else if (died[0] === best) firstSlime++;
      }
    }
    return { knight, firstSlime, total };
  }
  it('morts simultanées : le costaud (poids x4) laisse l\'objet bien plus souvent que le 1er faible (jadis : toujours l\'ennemi d\'indice 0)', () => {
    const r = run(true, 300);
    expect(r.total).toBeGreaterThan(250); // budget de 1 objet : presque toujours distribué
    expect(r.firstSlime / r.total).toBeLessThan(0.2); // pondération 0,5 / 5,5 ~ 9 %, avant : 100 %
    expect(r.knight / r.total).toBeGreaterThan(0.55); // 4 / 5,5 ~ 73 %
  });
  it('mêmes ennemis tués un par un : même répartition (cohérence)', () => {
    const together = run(true, 300);
    const apart = run(false, 300);
    expect(Math.abs(together.knight / together.total - apart.knight / apart.total)).toBeLessThan(0.15);
  });
});

describe('un appui d\'action = un effet (mécanisme OU échange d\'accessoire)', () => {
  it('debout sur un accessoire d\'une autre sorte ET à portée d\'un levier : le levier est actionné, l\'accessoire n\'est PAS échangé (il reste au sol)', () => {
    const s = mk(1, room('r1', { mechanisms: [{ id: 'l1', type: 'lever', tile: [5, 5] }] }));
    wear(s, 0, { accessory: { kind: 'lantern', level: 1 } });
    put(s, 0, 88, 88);
    s.step(DT, {});
    const id = addDrop(s, { slot: 'accessory', level: 2, accessory: 'magnet' }, 88, 88);
    const ev = stepN(s, 2, { 0: frame({ interact: true, attack: true }) });
    expect(ofType(ev, 'mechanismChanged').length).toBe(1);
    expect(ofType(ev, 'gearSwapped')).toHaveLength(0);
    expect(s.state.players[0].loadout.accessory).toEqual({ kind: 'lantern', level: 1 });
    expect(s.state.room.gearDrops?.some((d) => d.id === id)).toBe(true);
  });
  it('à l\'écart du levier, l\'échange fonctionne comme avant', () => {
    const s = mk(1, room('r1', { mechanisms: [{ id: 'l1', type: 'lever', tile: [5, 5] }] }));
    wear(s, 0, { accessory: { kind: 'lantern', level: 1 } });
    put(s, 0, 40, 40);
    s.step(DT, {});
    addDrop(s, { slot: 'accessory', level: 2, accessory: 'magnet' }, 40, 40);
    const ev = stepN(s, 1, { 0: frame({ interact: true }) });
    expect(ofType(ev, 'gearSwapped')).toHaveLength(1);
    expect(ofType(ev, 'mechanismChanged')).toHaveLength(0);
  });
});

describe('objet du dernier ennemi : ramassable pendant le délai « salle terminée »', () => {
  it('le joueur déjà dans la sortie quand le dernier ennemi tombe : la phase passe à roomCleared, l\'objet reste ramassable et vieillit (jadis : figé puis perdu)', () => {
    const s = mk(1, room('r1', { enemies: foes(['skeleton'], [[9, 5]]) }));
    s.state.players[0].invulnMs = 1e9;
    s.step(DT, {});
    put(s, 0, 152, 88); // dans la sortie, sur l'ennemi
    for (const e of s.state.room.enemies) {
      e.pos = { x: 152, y: 88 };
      e.hp = 0;
    }
    const ev = s.step(DT, {});
    expect(ofType(ev, 'gearDropped')).toHaveLength(1);
    expect(s.state.phase).toBe('roomCleared');
    expect(s.state.room.gearDrops).toHaveLength(1);
    const ttl0 = s.state.room.gearDrops?.[0].ttlMs ?? 0;
    const ev2 = stepN(s, 3);
    // le joueur est sur l'objet : ramassé (emplacement vide) pendant le délai
    expect(ofType(ev2, 'gearPicked')).toHaveLength(1);
    expect(s.state.room.gearDrops).toHaveLength(0);
    expect(ttl0).toBeGreaterThan(0);
  });
  it('un objet que personne ne prend vieillit aussi pendant roomCleared', () => {
    const s = mk(1, room('r1', { enemies: foes(['skeleton'], [[9, 5]]) }));
    s.state.players[0].invulnMs = 1e9;
    s.step(DT, {});
    put(s, 0, 152, 88);
    for (const e of s.state.room.enemies) {
      e.pos = { x: 152, y: 88 };
      e.hp = 0;
    }
    s.step(DT, {});
    expect(s.state.phase).toBe('roomCleared');
    const d = s.state.room.gearDrops?.[0];
    if (!d) throw new Error('objet absent');
    d.pos = { x: 40, y: 40 }; // hors de portée
    const before = d.ttlMs;
    stepN(s, 10);
    expect(s.state.room.gearDrops?.[0].ttlMs).toBeLessThan(before);
  });
});

describe('aimant : pas de « vol » d\'un objet à un allié mieux placé', () => {
  function setup(allyX: number): { s: GameSimulation; id: number } {
    const s = mk(2);
    wear(s, 0, { accessory: { kind: 'magnet', level: 3 } });
    put(s, 0, 30, 64);
    put(s, 1, allyX, 64);
    s.step(DT, {});
    const id = addDrop(s, { slot: 'boots', level: 2 }, 90, 64);
    return { s, id };
  }
  it('un allié plus proche de l\'objet que le porteur : l\'objet ne bouge pas (l\'allié peut le prendre)', () => {
    const { s, id } = setup(110); // allié à 20 px de l'objet, porteur à 60 px
    stepN(s, 20);
    const d = s.state.room.gearDrops?.find((x) => x.id === id);
    expect(d?.pos.x).toBe(90);
    // l'allié s'en approche et le prend
    put(s, 1, 90 + GEAR_PICKUP_RADIUS - 4, 64);
    const ev = stepN(s, 2);
    expect(ofType(ev, 'gearPicked').map((e) => e.playerId)).toEqual([1]);
  });
  it('un allié plus loin que le porteur (ou sans intérêt pour l\'objet) : l\'aimant tire comme avant', () => {
    const { s, id } = setup(190); // allié à 100 px de l'objet
    stepN(s, 10);
    expect(s.state.room.gearDrops?.find((x) => x.id === id)?.pos.x ?? 90).toBeLessThan(90);
    // allié proche mais qui ne pourrait pas le prendre (déjà des bottes III) : pas de blocage
    const { s: s2, id: id2 } = setup(100);
    wear(s2, 1, { boots: 3 });
    stepN(s2, 10);
    expect(s2.state.room.gearDrops?.find((x) => x.id === id2)?.pos.x ?? 90).toBeLessThan(90);
  });
});

describe('harnais du tutoriel', () => {
  it("joue AVEC l'équipement (rangée du HUD, ramassage, échange : objets posés par script) mais SANS butin d'équipement aléatoire (comme GameScene : gear:true, gearDrops:false)", () => {
    const run = new TutorialRun();
    expect(run.sim.state.gearEnabled).toBe(true);
    expect(run.sim.state.gearDropsDisabled).toBe(true);
  });
});
