/**
 * Accessoires et bonus temporaires dans la SIMULATION : effets MESURÉS (lanterne, aimant, cor de guerre, anneau du vampire, potion de vitesse, éclair de rage,
 * étoile), échange manuel par l'action A (priorité, verrou anti-échange, amélioration automatique, ignoré), perte à la chute, budget et exclusion des bonus
 * temporaires, effacement au changement de salle, flux isolé, sauvegarde / restauration.
 */
import { describe, expect, it } from 'vitest';
import {
  ACCESSORY_BONUS,
  BUFF_BUDGET_PER_PLAYER,
  BUFF_DURATION_MS,
  BUFF_STAR_DURATION_MS,
  GEAR_PICKUP_RADIUS,
  GEAR_TTL_MS,
  HORN_DURATION_MS,
  HORN_RADIUS_PX,
  MAGNET_PULL_SPEED,
  PICKUP_TTL_MS,
  VAMPIRE_HEAL_HP,
} from './balance';
import { CHARACTERS } from './characters';
import { SIM_STEP_MS, SUMMON_WAVE, TORCH_MAX_MS } from './constants';
import { createEnemyState } from './ai';
import { createLoadout } from './gear';
import { makeTestLevel, makeTestRoom } from './levelValidation';
import { applyDamageToPlayer } from './players';
import { createSimulation, GameSimulation } from './simulation';
import type {
  AccessoryKind,
  ActionFrame,
  BuffDropState,
  CharacterId,
  DroppedBuffKind,
  EnemyKind,
  EnemyState,
  GearDropState,
  GearItem,
  GearLevel,
  LevelDef,
  PlayerGear,
  PlayerId,
  PlayerLoadout,
  PlayerSetup,
  RoomDef,
  SimEvent,
  TickInputs,
  TileXY,
} from './types';

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

interface Opts {
  seed?: number;
  gear?: boolean;
  loot?: boolean;
  rooms?: RoomDef[];
  initialGear?: readonly (PlayerGear | undefined)[];
}

function mk(n: number, r: RoomDef = room('r1'), o: Opts = {}): GameSimulation {
  const lv = level(o.rooms ?? [r, room('r2')]);
  return createSimulation({ levelId: lv.id, players: setups(n), seed: o.seed ?? 5, loot: o.loot === true, gear: o.gear, initialGear: o.initialGear }, lv);
}

function shield(s: GameSimulation): void {
  for (const p of s.state.players) p.invulnMs = 1e9;
}

function foes(kind: EnemyKind, n: number, tiles: TileXY[] = [[8, 2], [8, 3], [9, 2], [9, 3]]): RoomDef['enemies'] {
  return Array.from({ length: n }, (_, i) => ({ kind, tile: tiles[i % tiles.length] }));
}

function ofType<T extends SimEvent['type']>(events: readonly SimEvent[], type: T): Extract<SimEvent, { type: T }>[] {
  return events.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);
}

type Script = TickInputs | ((i: number) => TickInputs);

function stepN(s: GameSimulation, n: number, inputs: Script = {}): SimEvent[] {
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

function accessory(kind: AccessoryKind, level: GearLevel): GearItem {
  return { slot: 'accessory', level, accessory: kind };
}

function addDrop(s: GameSimulation, item: GearItem, x: number, y: number, over: { lockedFor?: PlayerId; ttlMs?: number; lockMode?: 'life' | 'leave' } = {}): number {
  const id = s.state.nextGearDropId ?? 1;
  s.state.nextGearDropId = id + 1;
  s.state.room.gearDrops?.push({ id, item, pos: { x, y }, ttlMs: over.ttlMs ?? GEAR_TTL_MS, lockedFor: over.lockedFor ?? null, lockMode: over.lockMode ?? 'life' });
  return id;
}

function addBuffDrop(s: GameSimulation, kind: DroppedBuffKind, x: number, y: number, ttlMs = GEAR_TTL_MS): number {
  const id = s.state.nextGearDropId ?? 1;
  s.state.nextGearDropId = id + 1;
  s.state.room.buffDrops?.push({ id, kind, pos: { x, y }, ttlMs });
  return id;
}

/** Ennemi immobile (assommé) ajouté à la salle. */
function addFoe(s: GameSimulation, kind: EnemyKind, x: number, y: number, hp: number): EnemyState {
  const e = createEnemyState(kind, { x, y }, s.state.nextEntityId++, 0);
  e.hp = hp;
  e.maxHp = hp;
  e.data.stunMs = 1e9;
  e.mode = 'stunned';
  s.state.room.enemies.push(e);
  return e;
}

/** Le joueur `id` (face au bas) tue un ennemi de 1 PV posé juste devant lui : retourne les événements du combat. */
function killByPlayer(s: GameSimulation, id: PlayerId, over: Partial<EnemyState> = {}): SimEvent[] {
  const p = s.state.players[id];
  p.facing = 'down';
  p.attackCooldownMs = 0;
  const e = addFoe(s, 'slime', p.pos.x, p.pos.y + 14, 1);
  Object.assign(e, over);
  const all: SimEvent[] = [];
  for (let i = 0; i < 90 && s.state.room.enemies.includes(e); i++) all.push(...s.step(DT, { [id]: frame({ attack: true }) }));
  return all;
}

const ENEMIES_6 = (): RoomDef['enemies'] => [...foes('slime', 3), ...foes('skeleton', 3)];

// ───────────────────────────── Lanterne ─────────────────────────────

describe('lanterne : la torche des salles sombres s\'use 30 / 50 / 70 % moins vite', () => {
  const lost = (g: Partial<PlayerGear>, dark: boolean, steps = 120): number => {
    const s = mk(1, room('r1', { dark }));
    wear(s, 0, g);
    stepN(s, steps);
    return TORCH_MAX_MS - s.state.players[0].torchMs;
  };
  it('usure mesurée : x(1 - réduction) pour chaque niveau', () => {
    const base = lost({}, true);
    expect(base).toBeCloseTo(120 * DT, 3);
    for (const lv of [1, 2, 3] as const) {
      const l = lost({ accessory: { kind: 'lantern', level: lv } }, true);
      expect(l, `niveau ${lv}`).toBeCloseTo(base * (1 - ACCESSORY_BONUS.lantern[lv - 1]), 3);
    }
  });
  it('un autre accessoire ne change rien ; hors salle sombre la torche ne s\'use pas, lanterne ou non', () => {
    expect(lost({ accessory: { kind: 'magnet', level: 3 } }, true)).toBeCloseTo(120 * DT, 3);
    expect(lost({ accessory: { kind: 'lantern', level: 3 } }, false)).toBe(0);
  });
  it('la torche d\'un joueur sans lanterne s\'éteint à l\'heure habituelle ; avec la lanterne III elle tient plus de 3 fois plus longtemps (mesuré)', () => {
    const turns = (g: Partial<PlayerGear>): number => {
      const s = mk(1, room('r1', { dark: true }));
      wear(s, 0, g);
      s.state.players[0].torchMs = 3000;
      for (let i = 1; i <= 2000; i++) {
        s.step(DT, {});
        if (s.state.players[0].torchMs <= 0) return i;
      }
      return Infinity;
    };
    const base = turns({});
    expect(Math.abs(base - 3000 / DT)).toBeLessThanOrEqual(1.5);
    expect(turns({ accessory: { kind: 'lantern', level: 3 } })).toBeGreaterThanOrEqual(Math.floor(base / 0.3) - 4);
  });
});

// ───────────────────────────── Aimant ─────────────────────────────

describe('aimant à cœurs : attire cœurs ET objets proches (rayon 50 / 80 / 120 px)', () => {
  const HEART = (s: GameSimulation, x: number, y: number): void => {
    s.state.room.pickups?.push({ id: 900, kind: 'full', pos: { x, y }, ttlMs: PICKUP_TTL_MS });
  };
  const hurt = (s: GameSimulation, id: PlayerId = 0): void => {
    s.state.players[id].hp = 10;
  };
  it('un cœur dans le rayon est tiré vers le joueur blessé à MAGNET_PULL_SPEED px/s, puis ramassé', () => {
    const s = mk(1);
    wear(s, 0, { accessory: { kind: 'magnet', level: 1 } });
    put(s, 0, 30, 64);
    hurt(s);
    HEART(s, 30 + 45, 64);
    stepN(s, 10);
    const x = (s.state.room.pickups ?? [])[0].pos.x;
    expect(x).toBeCloseTo(30 + 45 - (MAGNET_PULL_SPEED * 10 * DT) / 1000, 0);
    const ev = stepN(s, 60);
    expect(ofType(ev, 'pickupCollected')).toHaveLength(1);
  });
  it('sans aimant, ou hors du rayon, le cœur ne bouge pas ; un joueur aux PV pleins n\'attire pas de cœur', () => {
    const none = mk(1);
    put(none, 0, 30, 64);
    hurt(none);
    HEART(none, 30 + 45, 64);
    stepN(none, 30);
    expect((none.state.room.pickups ?? [])[0].pos.x).toBe(30 + 45);
    const far = mk(1);
    wear(far, 0, { accessory: { kind: 'magnet', level: 1 } });
    put(far, 0, 30, 64);
    hurt(far);
    HEART(far, 30 + 55, 64); // > 50 px
    stepN(far, 30);
    expect((far.state.room.pickups ?? [])[0].pos.x).toBe(30 + 55);
    const full = mk(1);
    wear(full, 0, { accessory: { kind: 'magnet', level: 3 } });
    put(full, 0, 30, 64);
    HEART(full, 30 + 45, 64);
    stepN(full, 30);
    expect((full.state.room.pickups ?? [])[0].pos.x).toBe(30 + 45);
  });
  it('rayon mesuré par niveau : un cœur à 100 px n\'est attiré qu\'avec le niveau III (120)', () => {
    const moved = (lv: GearLevel): boolean => {
      const s = mk(1);
      wear(s, 0, { accessory: { kind: 'magnet', level: lv } });
      put(s, 0, 30, 64);
      hurt(s);
      HEART(s, 30 + 100, 64);
      stepN(s, 10);
      return (s.state.room.pickups ?? [])[0].pos.x < 30 + 100;
    };
    expect([moved(1), moved(2), moved(3)]).toEqual([false, false, true]);
    const at = (lv: GearLevel, d: number): boolean => {
      const s = mk(1);
      wear(s, 0, { accessory: { kind: 'magnet', level: lv } });
      put(s, 0, 30, 64);
      hurt(s);
      HEART(s, 30 + d, 64);
      stepN(s, 5);
      return (s.state.room.pickups ?? [])[0].pos.x < 30 + d;
    };
    expect([at(2, 75), at(2, 85), at(1, 45), at(1, 55)]).toEqual([true, false, true, false]);
  });
  it('les objets d\'équipement aussi : attirés seulement s\'il pourrait les ramasser (strictement meilleur, non verrouillé)', () => {
    const s = mk(1);
    wear(s, 0, { accessory: { kind: 'magnet', level: 2 }, weapon: 2 });
    put(s, 0, 30, 64);
    const good = addDrop(s, { slot: 'boots', level: 1 }, 30 + 60, 64);
    const worse = addDrop(s, { slot: 'weapon', level: 1 }, 30 + 60, 80); // inférieur à la hache : reste
    const mine = addDrop(s, { slot: 'protection', level: 1 }, 30 + 60, 48, { lockedFor: 0 }); // verrouillé pour lui : reste
    const swap = addDrop(s, accessory('lantern', 3), 30 + 60, 96); // accessoire d'une autre sorte : échange manuel, pas d'attraction
    stepN(s, 20);
    const byId = (id: number): GearDropState => (s.state.room.gearDrops ?? []).find((d) => d.id === id) as GearDropState;
    expect(byId(good)?.pos.x ?? 0).toBeLessThan(30 + 60);
    expect(byId(worse).pos.x).toBe(30 + 60);
    expect(byId(mine).pos.x).toBe(30 + 60);
    expect(byId(swap).pos.x).toBe(30 + 60);
    const ev = stepN(s, 60);
    expect(ofType(ev, 'gearPicked').map((e) => e.item.slot)).toEqual(['boots']);
  });
  it('les bonus temporaires sont attirés aussi ; un mur arrête l\'objet (jamais dans un mur)', () => {
    const s = mk(1);
    wear(s, 0, { accessory: { kind: 'magnet', level: 3 } });
    put(s, 0, 30, 64);
    addBuffDrop(s, 'rage', 30 + 80, 64);
    stepN(s, 20);
    expect((s.state.room.buffDrops ?? [])[0].pos.x).toBeLessThan(30 + 80);
    const w = mk(1);
    wear(w, 0, { accessory: { kind: 'magnet', level: 3 } });
    put(w, 0, 30, 64);
    w.state.room.pickups?.push({ id: 901, kind: 'half', pos: { x: 30 + 10, y: 64 }, ttlMs: PICKUP_TTL_MS });
    w.state.players[0].hp = 5;
    for (let i = 0; i < 120; i++) {
      w.step(DT, {});
      for (const pk of w.state.room.pickups ?? []) {
        expect(pk.pos.x).toBeGreaterThanOrEqual(16);
        expect(pk.pos.x).toBeLessThanOrEqual(176);
        expect(pk.pos.y).toBeGreaterThanOrEqual(16);
        expect(pk.pos.y).toBeLessThanOrEqual(112);
      }
    }
  });
  it('un seul aimant par objet : le plus proche l\'emporte (deux joueurs aimantés)', () => {
    const s = mk(2);
    wear(s, 0, { accessory: { kind: 'magnet', level: 3 } });
    wear(s, 1, { accessory: { kind: 'magnet', level: 3 } });
    put(s, 0, 30, 64);
    put(s, 1, 150, 64);
    hurt(s, 0);
    hurt(s, 1);
    HEART(s, 60, 64); // 30 px de J0, 90 px de J1
    stepN(s, 5);
    expect((s.state.room.pickups ?? [])[0].pos.x).toBeLessThan(60);
  });
});

// ───────────────────────────── Cor de guerre ─────────────────────────────

describe('cor de guerre : l\'APPEL donne aussi aux alliés proches +20 / +30 / +40 % de vitesse pendant 3 s', () => {
  /** Distance parcourue en 30 pas par le joueur 1 qui court vers la droite. */
  const dist = (call: boolean, lv: GearLevel | 0): number => {
    const s = mk(2);
    if (lv !== 0) wear(s, 0, { accessory: { kind: 'warhorn', level: lv } });
    put(s, 0, 20, 40);
    put(s, 1, 40, 80);
    if (call) stepN(s, 1, { 0: frame({ call: true }) });
    const x0 = s.state.players[1].pos.x;
    stepN(s, 30, { 1: frame({ moveX: 1 }) });
    return s.state.players[1].pos.x - x0;
  };
  it('vitesse mesurée de l\'allié proche : x(1 + bonus) selon le niveau', () => {
    const base = dist(false, 0);
    expect(base).toBeGreaterThan(20);
    for (const lv of [1, 2, 3] as const) expect(dist(true, lv) / base, `niveau ${lv}`).toBeCloseTo(1 + ACCESSORY_BONUS.warhorn[lv - 1], 1);
  });
  it('événement buffStarted (horn, 3 s) pour l\'allié, pas pour l\'appelant ; l\'allié lointain ne reçoit rien', () => {
    const s = mk(3);
    wear(s, 0, { accessory: { kind: 'warhorn', level: 2 } });
    put(s, 0, 20, 40);
    put(s, 1, 20 + HORN_RADIUS_PX - 10, 40);
    put(s, 2, 20 + HORN_RADIUS_PX + 10, 40);
    const ev = stepN(s, 1, { 0: frame({ call: true }) });
    const started = ofType(ev, 'buffStarted');
    expect(started.map((e) => e.playerId)).toEqual([1]);
    expect(started[0]).toMatchObject({ kind: 'horn', durationMs: HORN_DURATION_MS, fromPlayerId: 0 });
    expect(s.state.players[0].loadout.buffs).toEqual([]);
    expect(s.state.players[1].loadout.buffs).toHaveLength(1);
    expect(s.state.players[1].loadout.buffs[0]).toMatchObject({ kind: 'horn', power: 0.3 });
    expect(s.state.players[2].loadout.buffs).toEqual([]);
  });
  it('le bonus dure 3 s puis disparaît ; sans cor, l\'appel ne donne rien ; un allié à terre ne reçoit rien', () => {
    const s = mk(2);
    wear(s, 0, { accessory: { kind: 'warhorn', level: 1 } });
    put(s, 0, 20, 40);
    put(s, 1, 40, 40);
    stepN(s, 1, { 0: frame({ call: true }) });
    expect(s.state.players[1].loadout.buffs).toHaveLength(1);
    stepN(s, Math.ceil(HORN_DURATION_MS / DT) + 2);
    expect(s.state.players[1].loadout.buffs).toEqual([]);
    const none = mk(2);
    put(none, 0, 20, 40);
    put(none, 1, 40, 40);
    expect(ofType(stepN(none, 1, { 0: frame({ call: true }) }), 'buffStarted')).toHaveLength(0);
    const down = mk(2);
    wear(down, 0, { accessory: { kind: 'warhorn', level: 1 } });
    put(down, 0, 20, 40);
    put(down, 1, 40, 40);
    down.state.players[1].invulnMs = 0;
    applyDamageToPlayer(down.state.players[1], 9999);
    stepN(down, 1);
    expect(ofType(stepN(down, 1, { 0: frame({ call: true }) }), 'buffStarted')).toHaveLength(0);
  });
  it('ne se cumule pas avec la potion de vitesse : le plus fort des deux', () => {
    const s = mk(2);
    wear(s, 0, { accessory: { kind: 'warhorn', level: 1 } });
    wear(s, 1, { buffs: [{ kind: 'speed', remainingMs: 8000 }] });
    put(s, 0, 20, 40);
    put(s, 1, 40, 80);
    stepN(s, 1, { 0: frame({ call: true }) });
    const x0 = s.state.players[1].pos.x;
    stepN(s, 30, { 1: frame({ moveX: 1 }) });
    const d = s.state.players[1].pos.x - x0;
    const base = dist(false, 0);
    expect(d / base).toBeCloseTo(1.4, 1); // +40 % (potion), pas +60 %
  });
});

// ───────────────────────────── Anneau du vampire ─────────────────────────────

describe('anneau du vampire (niveau III) : +1 PV tous les 3 ennemis tués', () => {
  it('trois kills du porteur = +1 PV (événement vampireHeal), le compteur repart', () => {
    const s = mk(1);
    wear(s, 0, { accessory: { kind: 'vampire', level: 3 } });
    put(s, 0, 60, 40);
    s.state.players[0].hp = 20;
    s.state.players[0].invulnMs = 1e9;
    const heals: number[] = [];
    for (let i = 0; i < 6; i++) heals.push(...ofType(killByPlayer(s, 0), 'vampireHeal').map((e) => e.healed));
    expect(heals).toEqual([VAMPIRE_HEAL_HP, VAMPIRE_HEAL_HP]);
    expect(s.state.players[0].hp).toBe(20 + 2 * VAMPIRE_HEAL_HP);
    expect(s.state.players[0].kills).toBe(6);
  });
  it('les kills d\'un allié ne comptent pas ; sans anneau, aucun soin ; un ennemi INVOQUÉ ne compte pas', () => {
    const s = mk(2);
    wear(s, 0, { accessory: { kind: 'vampire', level: 3 } });
    put(s, 0, 60, 40);
    put(s, 1, 120, 40);
    for (const p of s.state.players) {
      p.hp = 20;
      p.invulnMs = 1e9;
    }
    for (let i = 0; i < 6; i++) expect(ofType(killByPlayer(s, 1), 'vampireHeal')).toHaveLength(0);
    expect(s.state.players[0].hp).toBe(20);
    expect(s.state.players[0].loadout.ringKills ?? 0).toBe(0);
    for (let i = 0; i < 6; i++) expect(ofType(killByPlayer(s, 0, { wave: SUMMON_WAVE }), 'vampireHeal')).toHaveLength(0);
    expect(s.state.players[0].hp).toBe(20);
  });
  it('PV pleins : pas de soin ni d\'événement, le compteur repart quand même', () => {
    const s = mk(1);
    wear(s, 0, { accessory: { kind: 'vampire', level: 3 } });
    put(s, 0, 60, 40);
    for (let i = 0; i < 3; i++) expect(ofType(killByPlayer(s, 0), 'vampireHeal')).toHaveLength(0);
    expect(s.state.players[0].loadout.ringKills).toBe(0);
    expect(s.state.players[0].hp).toBe(s.state.players[0].maxHp);
  });
});

// ───────────────────────────── Échange manuel d'accessoire ─────────────────────────────

describe('accessoire : ramassage automatique, amélioration, ignoré, échange manuel (A)', () => {
  it('emplacement vide : ramassé automatiquement', () => {
    const s = mk(1);
    put(s, 0, 60, 60);
    addDrop(s, accessory('magnet', 1), 60, 60);
    const ev = stepN(s, 2);
    expect(ofType(ev, 'gearPicked')).toHaveLength(1);
    expect(s.state.players[0].loadout.accessory).toEqual({ kind: 'magnet', level: 1 });
  });
  it('même sorte de niveau supérieur : amélioration automatique (l\'ancien disparaît, rien n\'est lâché)', () => {
    const s = mk(1);
    wear(s, 0, { accessory: { kind: 'lantern', level: 1 } });
    put(s, 0, 60, 60);
    addDrop(s, accessory('lantern', 3), 60, 60);
    const ev = stepN(s, 2);
    expect(ofType(ev, 'gearPicked')[0].replaced).toEqual(accessory('lantern', 1));
    expect(s.state.players[0].loadout.accessory).toEqual({ kind: 'lantern', level: 3 });
    expect(s.state.room.gearDrops).toHaveLength(0);
  });
  it('même sorte de niveau égal ou inférieur : ignoré (reste au sol, un allié peut le prendre)', () => {
    const s = mk(2);
    wear(s, 0, { accessory: { kind: 'lantern', level: 2 } });
    put(s, 0, 60, 60);
    put(s, 1, 150, 100);
    const a = addDrop(s, accessory('lantern', 2), 60, 60);
    const b = addDrop(s, accessory('lantern', 1), 60, 60);
    stepN(s, 10, { 0: frame({ interact: true }) });
    expect(s.state.players[0].loadout.accessory).toEqual({ kind: 'lantern', level: 2 });
    expect((s.state.room.gearDrops ?? []).map((d) => d.id).sort()).toEqual([a, b].sort());
    // l'allié (emplacement vide) prend celui qu'il croise
    put(s, 0, 40, 40);
    put(s, 1, 60, 60);
    const ev = stepN(s, 3);
    expect(ofType(ev, 'gearPicked').map((e) => e.playerId)).toContain(1);
    expect(s.state.players[1].loadout.accessory?.kind).toBe('lantern');
  });
  it('accessoire DIFFÉRENT : jamais d\'échange automatique ; A équipe le nouveau et LÂCHE l\'ancien aux pieds (20 s)', () => {
    const s = mk(1);
    wear(s, 0, { accessory: { kind: 'lantern', level: 2 } });
    put(s, 0, 60, 60);
    addDrop(s, accessory('magnet', 3), 60, 60);
    expect(ofType(stepN(s, 30), 'gearPicked')).toHaveLength(0);
    expect(s.state.players[0].loadout.accessory).toEqual({ kind: 'lantern', level: 2 });
    const ev = stepN(s, 1, { 0: frame({ interact: true }) });
    const sw = ofType(ev, 'gearSwapped');
    expect(sw).toHaveLength(1);
    expect(sw[0].item).toEqual(accessory('magnet', 3));
    expect(sw[0].dropped).toEqual(accessory('lantern', 2));
    expect(s.state.players[0].loadout.accessory).toEqual({ kind: 'magnet', level: 3 });
    const dropped = ofType(ev, 'gearDropped');
    expect(dropped).toHaveLength(1);
    expect(dropped[0].item).toEqual(accessory('lantern', 2));
    expect(dropped[0].scattered).toBe(false);
    const d = (s.state.room.gearDrops ?? [])[0];
    expect(d.item).toEqual(accessory('lantern', 2));
    expect(d.ttlMs).toBeCloseTo(GEAR_TTL_MS, -2);
    expect(d.pos.x).toBeCloseTo(60, 0);
    expect(d.pos.y).toBeCloseTo(60, 0);
    expect(d.lockedFor).toBe(0);
    expect(d.lockMode).toBe('leave');
  });
  it('anti-échange infini : l\'ancien est verrouillé tant que le joueur n\'a pas quitté son rayon ; appuyer de nouveau dessus ne fait rien', () => {
    const s = mk(1);
    wear(s, 0, { accessory: { kind: 'lantern', level: 2 } });
    put(s, 0, 60, 60);
    addDrop(s, accessory('magnet', 3), 60, 60);
    stepN(s, 1, { 0: frame({ interact: true }) });
    for (let i = 0; i < 6; i++) {
      stepN(s, 2, { 0: frame({ interact: i % 2 === 0 }) });
      stepN(s, 1, { 0: frame({ interact: false }) });
    }
    expect(s.state.players[0].loadout.accessory).toEqual({ kind: 'magnet', level: 3 });
    expect(s.state.room.gearDrops).toHaveLength(1);
    // il s'éloigne : le verrou tombe ; en revenant, il peut rééchanger
    put(s, 0, 60 + GEAR_PICKUP_RADIUS + 12, 60);
    stepN(s, 1);
    expect(s.state.room.gearDrops?.[0].lockedFor).toBeNull();
    put(s, 0, 60, 60);
    stepN(s, 2);
    const ev = stepN(s, 1, { 0: frame({ interact: true }) });
    expect(ofType(ev, 'gearSwapped')).toHaveLength(1);
    expect(s.state.players[0].loadout.accessory).toEqual({ kind: 'lantern', level: 2 });
  });
  it('un allié peut prendre l\'ancien lâché (vide : automatiquement ; autre sorte : par A)', () => {
    const s = mk(2);
    wear(s, 0, { accessory: { kind: 'lantern', level: 2 } });
    put(s, 0, 60, 60);
    put(s, 1, 150, 100);
    addDrop(s, accessory('magnet', 3), 60, 60);
    stepN(s, 1, { 0: frame({ interact: true }) });
    put(s, 0, 60 + GEAR_PICKUP_RADIUS + 12, 60);
    put(s, 1, 60, 60);
    const ev = stepN(s, 2);
    expect(ofType(ev, 'gearPicked').map((e) => e.playerId)).toEqual([1]);
    expect(s.state.players[1].loadout.accessory).toEqual({ kind: 'lantern', level: 2 });
  });
  it('priorité de l\'action : l\'échange n\'ATTAQUE pas (comme un levier) ; sans objet à échanger, l\'appui attaque', () => {
    const s = mk(1);
    wear(s, 0, { accessory: { kind: 'lantern', level: 1 } });
    put(s, 0, 60, 60);
    addDrop(s, accessory('magnet', 1), 60, 60);
    stepN(s, 1, { 0: frame({ attack: true, interact: true }) });
    expect(s.state.players[0].attackCooldownMs).toBe(0);
    expect(s.state.players[0].loadout.accessory?.kind).toBe('magnet');
    // plus d'objet échangeable (l'ancien est verrouillé) : l'appui attaque normalement
    stepN(s, 2);
    stepN(s, 1, { 0: frame({ attack: true, interact: true }) });
    expect(s.state.players[0].attackCooldownMs).toBeGreaterThan(0);
  });
  it('priorité de l\'action : le RELEVAGE prime sur l\'échange', () => {
    const s = mk(2);
    wear(s, 0, { accessory: { kind: 'lantern', level: 1 } });
    put(s, 0, 60, 60);
    put(s, 1, 64, 60);
    s.state.players[1].invulnMs = 0;
    applyDamageToPlayer(s.state.players[1], 9999);
    stepN(s, 2);
    addDrop(s, accessory('magnet', 1), 60, 60);
    const ev = stepN(s, 5, { 0: frame({ revive: true, interact: true }) });
    expect(ofType(ev, 'gearSwapped')).toHaveLength(0);
    expect(ofType(ev, 'reviveStarted')).toHaveLength(1);
    expect(s.state.players[0].loadout.accessory?.kind).toBe('lantern');
  });
  it('l\'anneau du vampire (niveau III) s\'échange comme les autres, et son compteur disparaît', () => {
    const s = mk(1);
    wear(s, 0, { accessory: { kind: 'vampire', level: 3 }, ringKills: 2 });
    put(s, 0, 60, 60);
    addDrop(s, accessory('warhorn', 1), 60, 60);
    const ev = stepN(s, 1, { 0: frame({ interact: true }) });
    expect(ofType(ev, 'gearSwapped')[0].dropped).toEqual(accessory('vampire', 3));
    expect(s.state.players[0].loadout.ringKills).toBeUndefined();
  });
});

// ───────────────────────────── Perte à la chute ─────────────────────────────

describe('perte à la chute : accessoire et bonus temporaires', () => {
  it('l\'accessoire est perdu et éparpillé avec le reste, verrouillé pour son propriétaire ; les bonus temporaires disparaissent', () => {
    const s = mk(2);
    wear(s, 0, { boots: 2, accessory: { kind: 'vampire', level: 3 }, ringKills: 1, buffs: [{ kind: 'rage', remainingMs: 5000 }, { kind: 'horn', remainingMs: 2000, power: 0.3 }] });
    put(s, 0, 100, 60);
    put(s, 1, 40, 40);
    s.state.players[0].invulnMs = 0;
    applyDamageToPlayer(s.state.players[0], 9999);
    const ev = stepN(s, 2);
    const lost = ofType(ev, 'gearLost');
    expect(lost).toHaveLength(1);
    expect(lost[0].items.map((i) => i.slot)).toEqual(['boots', 'accessory']);
    expect(s.state.players[0].loadout).toEqual(createLoadout());
    const drops = s.state.room.gearDrops ?? [];
    expect(drops).toHaveLength(2);
    expect(drops.every((d) => d.lockedFor === 0)).toBe(true);
    // l'allié prend l'anneau (emplacement vide)
    const ring = drops.find((d) => d.item.slot === 'accessory') as GearDropState;
    put(s, 1, ring.pos.x, ring.pos.y);
    expect(ofType(stepN(s, 3), 'gearPicked').some((e) => e.item.slot === 'accessory')).toBe(true);
    expect(s.state.players[1].loadout.accessory).toEqual({ kind: 'vampire', level: 3 });
  });
  it('un joueur sans équipement mais avec un bonus temporaire qui tombe perd le bonus (pas d\'événement gearLost)', () => {
    const s = mk(2);
    wear(s, 0, { buffs: [{ kind: 'speed', remainingMs: 5000 }] });
    put(s, 0, 100, 60);
    s.state.players[0].invulnMs = 0;
    applyDamageToPlayer(s.state.players[0], 9999);
    const ev = stepN(s, 2);
    expect(ofType(ev, 'gearLost')).toHaveLength(0);
    expect(s.state.players[0].loadout.buffs).toEqual([]);
  });
  it('défaite d\'équipe : accessoire et bonus perdus aussi (règle stricte)', () => {
    const s = mk(1);
    wear(s, 0, { accessory: { kind: 'magnet', level: 2 }, buffs: [{ kind: 'rage', remainingMs: 5000 }] });
    s.state.players[0].invulnMs = 0;
    applyDamageToPlayer(s.state.players[0], 9999);
    const ev = stepN(s, 2);
    expect(ofType(ev, 'teamWipe')).toHaveLength(1);
    expect(s.state.players[0].loadout).toEqual(createLoadout());
  });
});

// ───────────────────────────── Bonus temporaires ─────────────────────────────

describe('bonus temporaires au sol : ramassage, durée, effets mesurés', () => {
  it('ramassé au contact : buffStarted avec la durée (8 s ; étoile 4 s), l\'objet disparaît ; il expire au bout de 20 s', () => {
    const s = mk(1);
    put(s, 0, 60, 60);
    addBuffDrop(s, 'speed', 60, 60);
    const ev = stepN(s, 2);
    expect(ofType(ev, 'buffStarted')[0]).toMatchObject({ playerId: 0, kind: 'speed', durationMs: BUFF_DURATION_MS });
    expect(s.state.room.buffDrops).toHaveLength(0);
    expect(s.state.players[0].loadout.buffs.map((b) => b.kind)).toEqual(['speed']);
    addBuffDrop(s, 'star', 60, 60);
    expect(ofType(stepN(s, 2), 'buffStarted')[0].durationMs).toBe(BUFF_STAR_DURATION_MS);
    const idle = mk(1);
    put(idle, 0, 40, 40);
    addBuffDrop(idle, 'rage', 150, 100);
    stepN(idle, Math.ceil(GEAR_TTL_MS / DT) - 5);
    expect(idle.state.room.buffDrops).toHaveLength(1);
    stepN(idle, 10);
    expect(idle.state.room.buffDrops).toHaveLength(0);
  });
  it('le joueur vivant le PLUS PROCHE le prend ; un joueur à terre ne le prend pas ; un bonus déjà actif repart à la durée pleine', () => {
    const s = mk(2);
    put(s, 0, 60, 60);
    put(s, 1, 62, 60);
    addBuffDrop(s, 'rage', 63, 60);
    expect(ofType(stepN(s, 1), 'buffStarted').map((e) => e.playerId)).toEqual([1]);
    const d = mk(2);
    put(d, 0, 60, 60);
    put(d, 1, 150, 100);
    d.state.players[0].invulnMs = 0;
    applyDamageToPlayer(d.state.players[0], 9999);
    stepN(d, 2);
    addBuffDrop(d, 'speed', 60, 60);
    expect(ofType(stepN(d, 3), 'buffStarted')).toHaveLength(0);
    const r = mk(1);
    put(r, 0, 60, 60);
    wear(r, 0, { buffs: [{ kind: 'speed', remainingMs: 1000 }] });
    addBuffDrop(r, 'speed', 60, 60);
    stepN(r, 1);
    expect(r.state.players[0].loadout.buffs).toHaveLength(1);
    expect(r.state.players[0].loadout.buffs[0].remainingMs).toBeGreaterThan(BUFF_DURATION_MS - 100);
  });
  it('potion de vitesse : +40 % mesuré, pendant 8 s seulement', () => {
    const run = (buffs: Partial<PlayerGear> & { buffs?: { kind: 'speed'; remainingMs: number }[] }): number => {
      const s = mk(1);
      wear(s, 0, buffs);
      put(s, 0, 20, 40);
      const x0 = s.state.players[0].pos.x;
      stepN(s, 30, { 0: frame({ moveX: 1 }) });
      return s.state.players[0].pos.x - x0;
    };
    const base = run({});
    expect(run({ buffs: [{ kind: 'speed', remainingMs: 8000 }] }) / base).toBeCloseTo(1.4, 1);
    const s = mk(1);
    put(s, 0, 20, 40);
    addBuffDrop(s, 'speed', 20, 40);
    stepN(s, Math.ceil(BUFF_DURATION_MS / DT) + 3);
    expect(s.state.players[0].loadout.buffs).toEqual([]);
  });
  it('éclair de rage : +50 % de dégâts infligés mesuré (attaque et spécial), perdu après 8 s', () => {
    const hit = (rage: boolean, special = false): number => {
      const s = mk(1);
      if (rage) wear(s, 0, { buffs: [{ kind: 'rage', remainingMs: BUFF_DURATION_MS }] });
      put(s, 0, 60, 60);
      s.state.players[0].facing = 'down';
      const e = addFoe(s, 'skeleton', 60, 74, 5000);
      const hp0 = e.hp;
      for (let i = 0; i < 90 && e.hp === hp0; i++) s.step(DT, { 0: frame(special ? { special: true } : { attack: true }) });
      return hp0 - e.hp;
    };
    expect(hit(true) / hit(false)).toBeCloseTo(1.5, 5);
    expect(hit(true, true) / hit(false, true)).toBeCloseTo(1.5, 5);
    expect(CHARACTERS.david.special).toBeDefined();
  });
  it('étoile : AUCUN dégât pendant 4 s, puis les dégâts reviennent', () => {
    const s = mk(1);
    wear(s, 0, { buffs: [{ kind: 'star', remainingMs: BUFF_STAR_DURATION_MS }] });
    expect(applyDamageToPlayer(s.state.players[0], 9999)).toEqual({ applied: 0, downed: false });
    expect(s.state.players[0].hp).toBe(s.state.players[0].maxHp);
    stepN(s, Math.ceil(BUFF_STAR_DURATION_MS / DT) + 2);
    expect(s.state.players[0].loadout.buffs).toEqual([]);
    s.state.players[0].invulnMs = 0;
    expect(applyDamageToPlayer(s.state.players[0], 5).applied).toBeGreaterThan(0);
  });
  it('étoile : un ennemi au contact ne blesse pas le porteur', () => {
    const s = mk(1);
    wear(s, 0, { buffs: [{ kind: 'star', remainingMs: BUFF_STAR_DURATION_MS }] });
    put(s, 0, 60, 60);
    const e = createEnemyState('skeleton', { x: 62, y: 60 }, s.state.nextEntityId++, 0);
    s.state.room.enemies.push(e);
    stepN(s, 120);
    expect(s.state.players[0].hp).toBe(s.state.players[0].maxHp);
  });
  it('les bonus temporaires sont effacés avec la salle (objets au sol) mais restent actifs sur le joueur d\'une salle à l\'autre', () => {
    const s = mk(1);
    put(s, 0, 60, 60);
    wear(s, 0, { buffs: [{ kind: 'rage', remainingMs: 6000 }] });
    addBuffDrop(s, 'speed', 30, 100);
    put(s, 0, 9 * 16 + 8, 5 * 16 + 8);
    stepN(s, 2);
    stepN(s, 120);
    expect(s.state.roomIndex).toBe(1);
    expect(s.state.room.buffDrops).toHaveLength(0);
    expect(s.state.players[0].loadout.buffs.map((b) => b.kind)).toEqual(['rage']);
  });
});

// ───────────────────────────── Budget des bonus temporaires ─────────────────────────────

describe('bonus temporaires : budget de salle (~0,3 par héros), exclusivité, flux isolé', () => {
  it('budget de salle tiré à l\'entrée : espérance ~0,3 n sur 400 graines, jamais plus de ceil(0,3 n)', () => {
    for (const n of [1, 2, 3, 4]) {
      let total = 0;
      const SEEDS = 400;
      for (let seed = 1; seed <= SEEDS; seed++) {
        const b = mk(n, room('r1'), { seed }).state.room.buffBudget ?? -1;
        expect(b).toBeGreaterThanOrEqual(Math.floor(n * BUFF_BUDGET_PER_PLAYER));
        expect(b).toBeLessThanOrEqual(Math.ceil(n * BUFF_BUDGET_PER_PLAYER));
        total += b;
      }
      expect(total / SEEDS, `n=${n}`).toBeGreaterThan(n * 0.3 - 0.07);
      expect(total / SEEDS, `n=${n}`).toBeLessThan(n * 0.3 + 0.07);
    }
  });
  it('gear:false : aucun budget, aucun bonus au sol', () => {
    const s = mk(2, room('r1', { enemies: ENEMIES_6() }), { gear: false });
    expect(s.state.room.buffBudget).toBe(0);
    shield(s);
    s.step(DT, {});
    for (const e of s.state.room.enemies) e.hp = 0;
    stepN(s, 3);
    expect(s.state.room.buffDrops).toHaveLength(0);
  });
  it('tuer les ennemis d\'une salle : jamais plus de bonus que le budget ; invoqués, demi-boss et boss final n\'en laissent pas', () => {
    let drops = 0;
    let rooms = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const s = mk(4, room('r1', { enemies: [...ENEMIES_6(), ...foes('slime', 2)] }), { seed });
      shield(s);
      const budget = s.state.room.buffBudget ?? 0;
      s.step(DT, {});
      let n = 0;
      for (let i = 0; i < 40 && s.state.room.enemies.length > 0; i++) {
        const e = s.state.room.enemies[0];
        e.hp = 0;
        n += ofType(s.step(DT, {}), 'buffDropped').length;
      }
      expect(n).toBeLessThanOrEqual(budget);
      drops += n;
      rooms++;
    }
    expect(drops / rooms).toBeGreaterThan(0.8); // ~1,2 attendu à 4 joueurs (certains ennemis laissent un cœur / objet)
    expect(drops / rooms).toBeLessThanOrEqual(1.3);
    for (const kind of ['warden', 'morvane'] as const) {
      for (let seed = 1; seed <= 60; seed++) {
        const s = mk(4, room('r1', { enemies: foes(kind, 1) }), { seed });
        s.state.room.buffBudget = 5;
        shield(s);
        s.step(DT, {});
        s.state.room.enemies[0].hp = 0;
        expect(ofType(s.step(DT, {}), 'buffDropped')).toHaveLength(0);
      }
    }
    const summoned = mk(4, room('r1', { enemies: foes('knight', 1) }), { seed: 3 });
    summoned.state.room.buffBudget = 5;
    shield(summoned);
    summoned.step(DT, {});
    summoned.state.room.enemies[0].wave = SUMMON_WAVE;
    summoned.state.room.enemies[0].hp = 0;
    expect(ofType(summoned.step(DT, {}), 'buffDropped')).toHaveLength(0);
  });
  it('exclusif : un ennemi qui laisse un cœur ou un objet d\'équipement ne laisse pas de bonus (même pas)', () => {
    let both = 0;
    let anyBuff = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const s = mk(4, room('r1', { enemies: [...ENEMIES_6(), ...foes('knight', 2)] }), { seed, loot: true });
      shield(s);
      s.step(DT, {});
      for (let i = 0; i < 40 && s.state.room.enemies.length > 0; i++) {
        s.state.room.enemies[0].hp = 0;
        const ev = s.step(DT, {});
        const buff = ofType(ev, 'buffDropped').length;
        anyBuff += buff;
        if (buff > 0 && (ofType(ev, 'gearDropped').length > 0 || ofType(ev, 'pickupDropped').length > 0)) both++;
      }
    }
    expect(anyBuff).toBeGreaterThan(50);
    expect(both).toBe(0);
  });
  it('les tirages de bonus n\'utilisent QUE le flux isolé de l\'équipement : flux principal et flux de butin de vie identiques avec ou sans équipement', () => {
    const mkSim = (gear: boolean): GameSimulation => mk(3, room('r1', { enemies: ENEMIES_6() }), { seed: 17, gear, loot: true });
    const a = mkSim(true);
    const b = mkSim(false);
    shield(a);
    shield(b);
    a.step(DT, {});
    b.step(DT, {});
    for (let i = 0; i < 12; i++) {
      for (const sim of [a, b]) {
        const e = sim.state.room.enemies[0];
        if (e) e.hp = 0;
      }
      a.step(DT, {});
      b.step(DT, {});
      for (const sim of [a, b]) for (const p of sim.state.players) put(sim, p.id, 30 + p.id * 3, 30);
    }
    expect(a.state.rngState).toBe(b.state.rngState);
    expect(a.state.lootRngState).toBe(b.state.lootRngState);
    expect(JSON.stringify(a.state.room.enemies)).toBe(JSON.stringify(b.state.room.enemies));
    expect(a.state.gearRngState).not.toBe(b.state.gearRngState);
  });
  it('déterminisme : deux simulations de même graine et mêmes entrées donnent le même état (accessoires, bonus, aimant, cor)', () => {
    const run = (): string => {
      const s = mk(2, room('r1', { enemies: ENEMIES_6() }), { seed: 23, loot: true });
      wear(s, 0, { accessory: { kind: 'magnet', level: 3 } });
      wear(s, 1, { accessory: { kind: 'warhorn', level: 2 } });
      for (let i = 0; i < 400; i++) {
        s.step(DT, {
          0: frame({ moveX: Math.sin(i / 25), moveY: Math.cos(i / 31), attack: i % 3 === 0 }),
          1: frame({ moveX: Math.cos(i / 20), moveY: Math.sin(i / 35), attack: i % 4 === 0, call: i === 50 || i === 300 }),
        });
        if (i === 60) addBuffDrop(s, 'speed', 100, 60);
      }
      return s.serialize();
    };
    expect(run()).toBe(run());
  });
});

// ───────────────────────────── Sauvegarde / restauration ─────────────────────────────

describe('accessoires et bonus : sérialisation et anciens snapshots', () => {
  it('serialize / restore : accessoire, compteur de l\'anneau, bonus actifs (cor avec puissance), bonus au sol et budget conservés ; la suite est identique', () => {
    const a = mk(2, room('r1', { enemies: foes('skeleton', 3) }), { seed: 4 });
    shield(a);
    wear(a, 0, { accessory: { kind: 'vampire', level: 3 }, ringKills: 2 });
    wear(a, 1, { accessory: { kind: 'warhorn', level: 3 }, buffs: [{ kind: 'horn', remainingMs: 2500, power: 0.4 }, { kind: 'rage', remainingMs: 4000 }] });
    addBuffDrop(a, 'star', 150, 90);
    a.state.room.buffBudget = 1;
    const b = GameSimulation.restore(a.serialize(), a.level);
    expect(b.state.players[0].loadout.ringKills).toBe(2);
    expect(b.state.players[1].loadout.buffs).toEqual(a.state.players[1].loadout.buffs);
    expect(b.state.room.buffDrops).toEqual(a.state.room.buffDrops);
    expect(b.state.room.buffBudget).toBe(1);
    for (let i = 0; i < 60; i++) {
      for (const sim of [a, b]) {
        const e = sim.state.room.enemies[0];
        if (e && i % 5 === 0) e.hp = 0;
      }
      a.step(DT, { 1: frame({ call: i === 10 }) });
      b.step(DT, { 1: frame({ call: i === 10 }) });
    }
    expect(b.serialize()).toBe(a.serialize());
  });
  it('ancien snapshot sans buffDrops / buffBudget : valeurs par défaut, partie jouable', () => {
    const a = mk(2, room('r1', { enemies: foes('skeleton', 2) }), { seed: 8 });
    a.step(DT, {});
    const snap = JSON.parse(a.serialize()) as { room: Record<string, unknown>; players: { loadout: Record<string, unknown> }[] };
    delete snap.room.buffDrops;
    delete snap.room.buffBudget;
    for (const p of snap.players) delete p.loadout.ringKills;
    const b = GameSimulation.restore(JSON.stringify(snap), a.level);
    expect(b.state.room.buffDrops).toEqual([]);
    expect(b.state.room.buffBudget).toBe(0);
    expect(() => stepN(b, 30)).not.toThrow();
  });
  it('loadout corrompu : bonus invalides ignorés, anneau hors niveau III refusé', () => {
    const a = mk(1, room('r1'));
    const snap = JSON.parse(a.serialize()) as { players: { loadout: Record<string, unknown> }[] };
    snap.players[0].loadout = { accessory: { kind: 'vampire', level: 1 }, buffs: [{ kind: 'speed', remainingMs: 100 }, { kind: 'nope', remainingMs: 100 }, { kind: 'rage', remainingMs: 'x' }] };
    const b = GameSimulation.restore(JSON.stringify(snap), a.level);
    expect(b.state.players[0].loadout.accessory).toBeNull();
    expect(b.state.players[0].loadout.buffs).toEqual([{ kind: 'speed', remainingMs: 100 }]);
  });
  it('initialGear (« Continuer ») restitue l\'accessoire ; les bonus temporaires, eux, ne sont jamais restitués', () => {
    const s = mk(1, room('r1'), { initialGear: [{ boots: 1, protection: 0, artifact: 0, magic: 0, weapon: 0, accessory: { kind: 'magnet', level: 3 } }] });
    expect(s.state.players[0].loadout.accessory).toEqual({ kind: 'magnet', level: 3 });
    expect(s.state.players[0].loadout.buffs).toEqual([]);
  });
});
