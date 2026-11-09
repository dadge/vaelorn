/**
 * Sources de vie dans la SIMULATION : butin des ennemis (événements, positions, invoqués, demi-boss, boss), garantie anti-malchance, ramassage
 * (soin plafonné, PV pleins, à terre, rayon, durée de vie), effacement à chaque changement / redémarrage de salle, cristaux de soin (usage unique,
 * 50 PV, minPlayers, rechargés au redémarrage), interrupteur `loot`, déterminisme, sérialisation / restauration (avec et sans les nouveaux champs)
 * et ISOLEMENT du flux aléatoire (les parties existantes restent identiques quand rien n'est ramassé).
 */
import { describe, expect, it } from 'vitest';
import { HEAL_CRYSTAL_HEAL, PICKUP_RADIUS, PICKUP_TTL_MS } from './balance';
import { SIM_STEP_MS, SUMMON_WAVE, TILE, WIPE_RESTART_DELAY_MS } from './constants';
import { makeTestLayout, makeTestLevel, makeTestRoom } from './levelValidation';
import { createSimulation, GameSimulation } from './simulation';
import type {
  CharacterId,
  EnemyKind,
  GameState,
  HealCrystalDef,
  LevelDef,
  PickupKind,
  PlayerId,
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

/** Salle de test 12×8 : sortie sans exigence (pour changer de salle), ennemis et cristaux au choix. */
function room(id: string, over: Partial<RoomDef> = {}): RoomDef {
  return makeTestRoom({ id, exit: { rect: { x: 9, y: 5, w: 2, h: 2 }, requires: [] }, mechanisms: [{ id: 'p1', type: 'plate', tile: [6, 4] }], ...over });
}

function level(rooms: RoomDef[]): LevelDef {
  rooms[rooms.length - 1].exit.final = true;
  return makeTestLevel({ rooms });
}

/** NB : l'équipement (`gear`) est DÉSACTIVÉ par défaut ici : cette suite mesure les sources de vie seules (l'exclusion cœur / objet d'équipement change qui laisse quoi). */
function mk(n: number, r: RoomDef = room('r1'), opts: { seed?: number; loot?: boolean; gear?: boolean; rooms?: RoomDef[] } = {}): GameSimulation {
  const lv = level(opts.rooms ?? [r, room('r2')]);
  return createSimulation({ levelId: lv.id, players: setups(n), seed: opts.seed ?? 99, loot: opts.loot, gear: opts.gear === true }, lv);
}

function stepN(s: GameSimulation, n: number, inputs: TickInputs | ((i: number) => TickInputs) = {}): SimEvent[] {
  const all: SimEvent[] = [];
  for (let i = 0; i < n; i++) all.push(...s.step(DT, typeof inputs === 'function' ? inputs(i) : inputs));
  return all;
}

function foes(kind: EnemyKind, n: number, tiles: TileXY[] = [[8, 2], [8, 3], [9, 2], [9, 3]]): RoomDef['enemies'] {
  return Array.from({ length: n }, (_, i) => ({ kind, tile: tiles[i % tiles.length] }));
}

function ofType<T extends SimEvent['type']>(events: readonly SimEvent[], type: T): Extract<SimEvent, { type: T }>[] {
  return events.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);
}

/** Tue d'un coup tous les ennemis de la salle (PV à 0) : la mort est traitée au pas suivant (étape j). */
function killAll(s: GameSimulation): void {
  for (const e of s.state.room.enemies) e.hp = 0;
}

function put(s: GameSimulation, id: PlayerId, x: number, y: number): void {
  s.state.players[id].pos = { x, y };
}

function addPickup(s: GameSimulation, kind: PickupKind, x: number, y: number, ttlMs = PICKUP_TTL_MS): number {
  const id = s.state.nextPickupId ?? 1;
  s.state.nextPickupId = id + 1;
  s.state.room.pickups?.push({ id, kind, pos: { x, y }, ttlMs });
  return id;
}

/** Joueurs à l'abri des ennemis pour les tests de ramassage : aucun ennemi dans la salle. */
const EMPTY = room('r1');

describe('butin : événements et positions', () => {
  it('chaque nourriture posée correspond à un événement pickupDropped, à la position de l\'ennemi mort', () => {
    const s = mk(1, room('r1', { enemies: foes('slime', 30, [[4, 1], [5, 1], [6, 1], [7, 1], [8, 1], [9, 1]]) }));
    s.state.players[0].hp = 14; // 20 % : besoin ×2
    s.step(DT, {}); // salle initiale
    const positions = s.state.room.enemies.map((e) => ({ x: e.pos.x, y: e.pos.y }));
    killAll(s);
    const events = s.step(DT, {});
    const drops = ofType(events, 'pickupDropped');
    expect(drops.length).toBeGreaterThan(2);
    expect(drops.length).toBeLessThan(30);
    expect(s.state.room.pickups).toHaveLength(drops.length);
    drops.forEach((d, i) => {
      const p = s.state.room.pickups?.[i];
      expect(p?.id).toBe(d.pickupId);
      expect(p?.kind).toBe(d.kind);
      expect(p?.ttlMs).toBe(PICKUP_TTL_MS);
      // la position est celle d'un ennemi mort (sol praticable : aucun décalage)
      expect(positions.some((q) => Math.abs(q.x - d.pos.x) < 1e-9 && Math.abs(q.y - d.pos.y) < 1e-9)).toBe(true);
    });
    // ids propres aux nourritures : 1, 2, 3…
    expect(drops.map((d) => d.pickupId)).toEqual(drops.map((_, i) => i + 1));
    expect(s.state.nextPickupId).toBe(drops.length + 1);
  });

  it('un demi-boss laisse TOUJOURS un cœur entier (événement + objet), à sa position', () => {
    for (const kind of ['warden', 'pyromancer', 'wraith'] as const) {
      const s = mk(1, room('r1', { enemies: [{ kind, tile: [8, 3] }] }));
      s.step(DT, {});
      killAll(s);
      const ev = ofType(s.step(DT, {}), 'pickupDropped');
      expect(ev, kind).toHaveLength(1);
      expect(ev[0].kind).toBe('full');
      expect(s.state.room.pickups).toHaveLength(1);
      expect(s.state.room.pickups?.[0].kind).toBe('full');
    }
  });

  it('un boss final ne laisse rien', () => {
    for (const kind of ['golem', 'morvane', 'frostqueen', 'forgelord', 'voidlord'] as const) {
      const s = mk(1, room('r1', { enemies: [{ kind, tile: [8, 3] }] }));
      s.state.players[0].hp = 5;
      s.step(DT, {});
      killAll(s);
      const ev = s.step(DT, {});
      expect(ofType(ev, 'enemyDied'), kind).toHaveLength(1);
      expect(ofType(ev, 'pickupDropped'), kind).toHaveLength(0);
      expect(s.state.room.pickups).toHaveLength(0);
    }
  });

  it('un ennemi INVOQUÉ (vague SUMMON_WAVE) ne laisse rien et ne touche pas au compteur anti-malchance ; un ennemi de niveau, si', () => {
    const s = mk(1, room('r1', { enemies: foes('knight', 12) }));
    s.state.players[0].hp = 5;
    s.state.lootDryKills = 3;
    s.step(DT, {});
    for (const e of s.state.room.enemies) e.wave = SUMMON_WAVE;
    killAll(s);
    const ev = s.step(DT, {});
    expect(ofType(ev, 'enemyDied')).toHaveLength(12);
    expect(ofType(ev, 'pickupDropped')).toHaveLength(0);
    expect(s.state.lootDryKills).toBe(3);
    // même scénario avec des ennemis de niveau : des chevaliers à 5 PV laissent presque toujours quelque chose
    const t = mk(1, room('r1', { enemies: foes('knight', 12) }));
    t.state.players[0].hp = 5;
    t.step(DT, {});
    killAll(t);
    expect(ofType(t.step(DT, {}), 'pickupDropped').length).toBeGreaterThan(5);
  });

  it('les invocations RÉELLES d\'un demi-boss (spawnEnemy) portent la vague SUMMON_WAVE (marqueur sérialisé) et ne laissent rien', () => {
    const s = mk(1, room('r1', { enemies: [{ kind: 'pyromancer', tile: [8, 3] }] }));
    const player = s.state.players[0];
    let minions = s.state.room.enemies.filter((e) => e.wave === SUMMON_WAVE);
    for (let i = 0; i < 20000 && minions.length === 0; i++) {
      player.hp = player.maxHp;
      player.invulnMs = 1e9;
      s.step(DT, {});
      minions = s.state.room.enemies.filter((e) => e.wave === SUMMON_WAVE);
    }
    expect(minions.length).toBeGreaterThan(0);
    // le demi-boss lui-même est un ennemi de niveau (vague 0), jamais marqué
    expect(s.state.room.enemies.filter((e) => e.kind === 'pyromancer').every((e) => e.wave === 0)).toBe(true);
    // un joueur très blessé tue les sbires : l'événement de mort sort, aucune nourriture n'est posée
    player.hp = 3;
    for (const m of minions) m.hp = 0;
    const ev = s.step(DT, {});
    expect(ofType(ev, 'enemyDied').length).toBe(minions.length);
    expect(ofType(ev, 'pickupDropped')).toHaveLength(0);
    expect(s.state.room.pickups).toEqual([]);
  });

  it('interrupteur loot: false : aucun butin, aucun cristal, flux de butin intact', () => {
    const crystals: HealCrystalDef[] = [{ id: 'c1', tile: [4, 4] }];
    const s = mk(1, room('r1', { enemies: foes('knight', 10), healCrystals: crystals }), { loot: false });
    s.state.players[0].hp = 5;
    s.step(DT, {});
    expect(s.state.room.healCrystals).toEqual([]);
    const before = s.state.lootRngState;
    killAll(s);
    const ev = s.step(DT, {});
    expect(ofType(ev, 'pickupDropped')).toHaveLength(0);
    expect(s.state.room.pickups).toEqual([]);
    expect(s.state.lootRngState).toBe(before);
    expect(s.state.lootEnabled).toBe(false);
  });
});

describe('garantie anti-malchance dans la simulation', () => {
  it('compteur >= 6 et joueur sous 70 % : la mort suivante laisse toujours au moins un demi-cœur', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const s = mk(1, room('r1', { enemies: foes('slime', 1) }), { seed });
      s.state.players[0].hp = Math.floor(s.state.players[0].maxHp * 0.5);
      s.state.lootDryKills = 6;
      s.step(DT, {});
      killAll(s);
      s.step(DT, {});
      expect(s.state.room.pickups, `graine ${seed}`).toHaveLength(1);
      expect(s.state.lootDryKills).toBe(0);
    }
  });

  it('compteur 5 : pas de garantie (certaines graines ne laissent rien) et le compteur passe à 6 ; PV >= 70 % : pas de garantie à 6', () => {
    let nothing = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const s = mk(1, room('r1', { enemies: foes('slime', 1) }), { seed });
      s.state.players[0].hp = Math.floor(s.state.players[0].maxHp * 0.5);
      s.state.lootDryKills = 5;
      s.step(DT, {});
      killAll(s);
      s.step(DT, {});
      if (s.state.room.pickups?.length === 0) {
        nothing++;
        expect(s.state.lootDryKills).toBe(6);
      }
    }
    expect(nothing).toBeGreaterThan(5);
    let dryAtFull = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const s = mk(1, room('r1', { enemies: foes('slime', 1) }), { seed });
      s.state.lootDryKills = 6; // PV pleins : 100 % >= 70 %
      s.step(DT, {});
      killAll(s);
      s.step(DT, {});
      if (s.state.room.pickups?.length === 0) dryAtFull++;
    }
    expect(dryAtFull).toBeGreaterThan(20);
  });

  it('le compteur repart de zéro à chaque début de salle (suivante et redémarrage)', () => {
    const s = mk(1, room('r1'));
    s.state.lootDryKills = 5;
    put(s, 0, 10 * TILE, 6 * TILE);
    stepN(s, 5);
    // salle suivante après ROOM_CLEAR_DELAY_MS
    stepN(s, 120, () => ({}));
    expect(s.state.roomIndex).toBe(1);
    expect(s.state.lootDryKills).toBe(0);
    s.state.lootDryKills = 4;
    s.knockDown(0);
    stepN(s, Math.ceil(WIPE_RESTART_DELAY_MS / DT) + 10);
    expect(s.state.lootDryKills).toBe(0);
  });
});

describe('ramassage', () => {
  it('soigne min(valeur, manque), la nourriture disparaît, événement pickupCollected', () => {
    const s = mk(1, EMPTY);
    const p = s.state.players[0];
    s.step(DT, {});
    p.hp = p.maxHp - 3;
    const id = addPickup(s, 'half', p.pos.x, p.pos.y);
    const ev = s.step(DT, {});
    expect(p.hp).toBe(p.maxHp);
    expect(s.state.room.pickups).toHaveLength(0);
    const got = ofType(ev, 'pickupCollected');
    expect(got).toEqual([{ type: 'pickupCollected', pickupId: id, playerId: 0, kind: 'half', healed: 3, pos: { x: p.pos.x, y: p.pos.y } }]);
  });

  it('demi-cœur = 5 PV, cœur entier = 10 PV', () => {
    const s = mk(1, EMPTY);
    const p = s.state.players[0];
    s.step(DT, {});
    p.hp = p.maxHp - 40;
    addPickup(s, 'half', p.pos.x, p.pos.y);
    s.step(DT, {});
    expect(p.hp).toBe(p.maxHp - 35);
    addPickup(s, 'full', p.pos.x, p.pos.y);
    s.step(DT, {});
    expect(p.hp).toBe(p.maxHp - 25);
  });

  it('à PV pleins : la nourriture RESTE (un allié peut la prendre) ; dès qu\'on est blessé, on la prend', () => {
    const s = mk(2, EMPTY);
    s.step(DT, {});
    const [a, b] = s.state.players;
    put(s, 0, 4 * TILE, 3 * TILE);
    put(s, 1, 4 * TILE, 3 * TILE + 40);
    addPickup(s, 'full', a.pos.x, a.pos.y);
    stepN(s, 30);
    expect(s.state.room.pickups).toHaveLength(1);
    // l'allié blessé vient la chercher
    b.hp = b.maxHp - 6;
    put(s, 1, a.pos.x + 5, a.pos.y);
    const ev = s.step(DT, {});
    expect(ofType(ev, 'pickupCollected')).toMatchObject([{ playerId: 1, healed: 6, kind: 'full' }]);
    expect(b.hp).toBe(b.maxHp);
    expect(s.state.room.pickups).toHaveLength(0);
  });

  it('un joueur à terre ne ramasse pas', () => {
    const s = mk(2, EMPTY);
    s.step(DT, {});
    const [a, b] = s.state.players;
    put(s, 0, 4 * TILE, 3 * TILE);
    put(s, 1, 8 * TILE, 5 * TILE);
    b.hp = 0;
    b.status = 'down';
    addPickup(s, 'half', b.pos.x, b.pos.y);
    stepN(s, 20);
    expect(s.state.room.pickups).toHaveLength(1);
    expect(b.hp).toBe(0);
    expect(a.hp).toBe(a.maxHp);
  });

  it(`rayon de contact ${PICKUP_RADIUS} px : à ${PICKUP_RADIUS - 0.5} px oui, à ${PICKUP_RADIUS + 1} px non`, () => {
    const s = mk(1, EMPTY);
    const p = s.state.players[0];
    s.step(DT, {});
    p.hp = p.maxHp - 20;
    addPickup(s, 'half', p.pos.x + PICKUP_RADIUS + 1, p.pos.y);
    stepN(s, 5);
    expect(s.state.room.pickups).toHaveLength(1);
    s.state.room.pickups![0].pos = { x: p.pos.x + PICKUP_RADIUS - 0.5, y: p.pos.y };
    s.step(DT, {});
    expect(s.state.room.pickups).toHaveLength(0);
  });

  it('en coop, le joueur blessé le plus proche la prend', () => {
    const s = mk(2, EMPTY);
    s.step(DT, {});
    const [a, b] = s.state.players;
    a.hp = a.maxHp - 20;
    b.hp = b.maxHp - 20;
    put(s, 0, 4 * TILE, 3 * TILE);
    put(s, 1, 4 * TILE + 9, 3 * TILE);
    addPickup(s, 'half', 4 * TILE + 12, 3 * TILE);
    s.step(DT, {});
    expect(b.hp).toBe(b.maxHp - 15);
    expect(a.hp).toBe(a.maxHp - 20);
  });

  it(`durée de vie ${PICKUP_TTL_MS / 1000} s : encore là juste avant, disparue juste après (rien n'est ramassé)`, () => {
    const s = mk(1, EMPTY);
    s.step(DT, {});
    put(s, 0, 2 * TILE, 2 * TILE);
    addPickup(s, 'half', 10 * TILE, 6 * TILE);
    const steps = Math.ceil(PICKUP_TTL_MS / DT);
    stepN(s, steps - 2);
    expect(s.state.room.pickups).toHaveLength(1);
    expect(s.state.room.pickups![0].ttlMs).toBeLessThan(2 * DT + 1);
    stepN(s, 3);
    expect(s.state.room.pickups).toHaveLength(0);
  });

  it('effacée à la salle suivante et au redémarrage de salle', () => {
    const s = mk(1, room('r1'));
    s.step(DT, {});
    addPickup(s, 'half', 2 * TILE, 2 * TILE);
    s.state.players[0].hp = s.state.players[0].maxHp; // reste là
    expect(s.state.room.pickups).toHaveLength(1);
    put(s, 0, 10 * TILE, 6 * TILE);
    stepN(s, 120);
    expect(s.state.roomIndex).toBe(1);
    expect(s.state.room.pickups).toEqual([]);
    addPickup(s, 'full', 2 * TILE, 2 * TILE);
    s.knockDown(0);
    stepN(s, Math.ceil(WIPE_RESTART_DELAY_MS / DT) + 10);
    expect(s.state.room.pickups).toEqual([]);
  });

  it('un ennemi volant mort au-dessus d\'une fosse laisse sa nourriture sur le sol praticable le plus proche', () => {
    const layout = makeTestLayout(12, 8).map((row, y) => (y >= 2 && y <= 4 ? row.slice(0, 5) + '~~~' + row.slice(8) : row));
    const s = mk(1, room('r1', { layout, enemies: [{ kind: 'bat', tile: [6, 3] }] }));
    s.state.players[0].hp = 3;
    let found = false;
    for (let seed = 1; seed <= 60 && !found; seed++) {
      const t = mk(1, room('r1', { layout, enemies: [{ kind: 'bat', tile: [6, 3] }] }), { seed });
      t.state.players[0].hp = 3;
      t.step(DT, {});
      killAll(t);
      t.step(DT, {});
      const pk = t.state.room.pickups?.[0];
      if (!pk) continue;
      found = true;
      const tx = Math.floor(pk.pos.x / TILE);
      const ty = Math.floor(pk.pos.y / TILE);
      expect(layout[ty][tx]).not.toBe('~');
    }
    expect(found).toBe(true);
  });
});

describe('cristaux de soin', () => {
  const crystals: HealCrystalDef[] = [
    { id: 'c1', tile: [4, 4] },
    { id: 'c2', tile: [8, 4] },
    { id: 'c3', tile: [6, 6], minPlayers: 3 },
  ];
  const c1 = { x: 4.5 * TILE, y: 4.5 * TILE };
  const bossRoom = (): RoomDef => room('r1', { healCrystals: crystals });

  it('2 cristaux à 1 ou 2 joueurs, un 3e à partir de 3 joueurs (minPlayers), tous intacts', () => {
    for (const [n, expected] of [[1, 2], [2, 2], [3, 3], [4, 3]] as const) {
      const s = mk(n, bossRoom());
      expect(s.state.room.healCrystals?.map((c) => c.id)).toEqual(['c1', 'c2', 'c3'].slice(0, expected));
      expect(s.state.room.healCrystals?.every((c) => !c.used)).toBe(true);
    }
  });

  it(`soigne ${HEAL_CRYSTAL_HEAL} PV (5 cœurs) au joueur blessé qui le touche, puis il est épuisé (usage unique)`, () => {
    const s = mk(1, bossRoom());
    const p = s.state.players[0];
    s.step(DT, {});
    p.hp = 1;
    put(s, 0, c1.x, c1.y);
    const ev = s.step(DT, {});
    expect(p.hp).toBe(1 + HEAL_CRYSTAL_HEAL);
    expect(ofType(ev, 'crystalUsed')).toEqual([{ type: 'crystalUsed', crystalId: 'c1', playerId: 0, healed: HEAL_CRYSTAL_HEAL, pos: c1 }]);
    expect(s.state.room.healCrystals?.find((c) => c.id === 'c1')?.used).toBe(true);
    // second passage : plus rien (même blessé)
    put(s, 0, 2 * TILE, 2 * TILE);
    stepN(s, 5);
    p.hp = 1;
    put(s, 0, c1.x, c1.y);
    stepN(s, 5);
    expect(p.hp).toBe(1);
  });

  it('soin plafonné au manque (le cristal est tout de même consommé) ; à PV pleins il n\'est pas consommé', () => {
    const s = mk(1, bossRoom());
    const p = s.state.players[0];
    s.step(DT, {});
    put(s, 0, c1.x, c1.y);
    stepN(s, 10);
    expect(s.state.room.healCrystals?.[0].used).toBe(false);
    p.hp = p.maxHp - 12;
    const ev = s.step(DT, {});
    expect(ofType(ev, 'crystalUsed')[0].healed).toBe(12);
    expect(p.hp).toBe(p.maxHp);
    expect(s.state.room.healCrystals?.[0].used).toBe(true);
  });

  it('un joueur à terre ne l\'utilise pas ; le premier joueur vivant blessé qui le touche l\'utilise', () => {
    const s = mk(2, bossRoom());
    s.step(DT, {});
    const [a, b] = s.state.players;
    a.hp = 0;
    a.status = 'down';
    put(s, 0, c1.x, c1.y);
    put(s, 1, 2 * TILE, 2 * TILE);
    stepN(s, 10);
    expect(s.state.room.healCrystals?.[0].used).toBe(false);
    b.hp = 10;
    put(s, 1, c1.x + 4, c1.y);
    s.step(DT, {});
    expect(b.hp).toBe(10 + HEAL_CRYSTAL_HEAL);
    expect(s.state.room.healCrystals?.[0].used).toBe(true);
    expect(a.hp).toBe(0);
  });

  it('se recharge au redémarrage de la salle (défaite collective) et à l\'entrée de la salle suivante (neuve)', () => {
    const r1 = bossRoom();
    const r2 = room('r2', { healCrystals: [{ id: 'd1', tile: [4, 4] }] });
    const s = mk(1, r1, { rooms: [r1, r2] });
    const p = s.state.players[0];
    s.step(DT, {});
    p.hp = 5;
    put(s, 0, c1.x, c1.y);
    s.step(DT, {});
    expect(s.state.room.healCrystals?.[0].used).toBe(true);
    s.knockDown(0);
    stepN(s, Math.ceil(WIPE_RESTART_DELAY_MS / DT) + 10);
    expect(s.state.room.healCrystals?.map((c) => c.used)).toEqual([false, false]);
    // salle suivante : ses propres cristaux, intacts
    put(s, 0, 10 * TILE, 6 * TILE);
    stepN(s, 120);
    expect(s.state.roomIndex).toBe(1);
    expect(s.state.room.healCrystals).toEqual([{ id: 'd1', used: false }]);
  });
});

describe('déterminisme, sérialisation, anciens snapshots', () => {
  function scenario(seed: number, loot = true): GameSimulation {
    const r = room('r1', { enemies: [...foes('skeleton', 6), ...foes('slime', 6, [[7, 1], [7, 2], [7, 3]])], healCrystals: [{ id: 'c1', tile: [4, 4] }] });
    return mk(2, r, { seed, loot });
  }
  const script = (i: number): TickInputs => {
    const a = i % 90 < 60;
    return { 0: { moveX: a ? 1 : -1, moveY: 0, attack: true, interact: false, revive: false }, 1: { moveX: 0, moveY: a ? 1 : -1, attack: true, interact: false, revive: false } };
  };

  it('même graine, mêmes entrées : états strictement identiques (nourriture et cristaux compris), nourriture réellement posée', () => {
    const a = scenario(5);
    const b = scenario(5);
    let drops = 0;
    for (let i = 0; i < 1500; i++) {
      drops += ofType(a.step(DT, script(i)), 'pickupDropped').length;
      b.step(DT, script(i));
    }
    expect(a.serialize()).toBe(b.serialize());
    expect(drops).toBeGreaterThan(0);
    // une autre graine donne une autre partie
    const c = scenario(6);
    stepN(c, 1500, script);
    expect(c.serialize()).not.toBe(a.serialize());
  });

  it('serialize → restore à mi-partie : la suite est identique, objets au sol et cristaux compris', () => {
    const a = scenario(8);
    stepN(a, 700, script);
    const snap = a.serialize();
    expect(JSON.parse(snap).room.healCrystals).toBeDefined();
    const b = GameSimulation.restore(snap, a.level);
    for (let i = 700; i < 1600; i++) {
      a.step(DT, script(i));
      b.step(DT, script(i));
    }
    expect(b.serialize()).toBe(a.serialize());
    expect(JSON.parse(b.serialize())).toEqual(JSON.parse(a.serialize())); // JSON pur
  });

  it('ancien snapshot SANS les nouveaux champs : valeurs par défaut (butin actif, aucun objet, cristaux de la salle intacts), la partie continue', () => {
    const a = scenario(3);
    stepN(a, 120, script);
    const old = JSON.parse(a.serialize()) as GameState;
    delete old.lootEnabled;
    delete old.lootRngState;
    delete old.lootDryKills;
    delete old.nextPickupId;
    delete old.room.pickups;
    delete old.room.healCrystals;
    const b = GameSimulation.restore(JSON.stringify(old), a.level);
    expect(b.state.lootEnabled).toBe(true);
    expect(b.state.lootDryKills).toBe(0);
    expect(b.state.nextPickupId).toBe(1);
    expect(typeof b.state.lootRngState).toBe('number');
    expect(Number.isFinite(b.state.lootRngState)).toBe(true);
    expect(b.state.room.pickups).toEqual([]);
    expect(b.state.room.healCrystals).toEqual([{ id: 'c1', used: false }]);
    stepN(b, 600, script); // ne lève pas, reste cohérent
    expect(b.state.players.every((p) => p.hp >= 0 && p.hp <= p.maxHp)).toBe(true);
    // restauré deux fois depuis le même ancien snapshot : même suite
    const c = GameSimulation.restore(JSON.stringify(old), a.level);
    stepN(c, 600, script);
    expect(c.serialize()).toBe(b.serialize());
  });

  it('ancien snapshot dont le butin était désactivé reste désactivé ; champs présents jamais écrasés', () => {
    const a = scenario(3, false);
    stepN(a, 30, script);
    const b = GameSimulation.restore(a.serialize(), a.level);
    expect(b.state.lootEnabled).toBe(false);
    expect(b.state.room.healCrystals).toEqual([]);
  });
});

describe('flux PRNG isolé : les parties existantes restent identiques quand rien n\'est ramassé', () => {
  it('avec ou sans sources de vie, si les joueurs sont toujours à PV pleins : même flux principal, mêmes ennemis, mêmes projectiles, mêmes joueurs', () => {
    const mkSim = (loot: boolean): GameSimulation =>
      mk(2, room('r1', { enemies: [...foes('knight', 10), ...foes('slime', 10, [[7, 1], [7, 2], [7, 3]])] }), { seed: 17, loot });
    const a = mkSim(true);
    const b = mkSim(false);
    let drops = 0;
    for (let i = 0; i < 900; i++) {
      const inputs: TickInputs = { 0: { moveX: Math.sin(i / 40), moveY: Math.cos(i / 55), attack: true, interact: false, revive: false }, 1: { moveX: 0, moveY: 0, attack: i % 2 === 0, interact: false, revive: false } };
      if (i === 20 || i === 600) {
        // deux fournées de morts (la 2e est encore au sol à la fin : 12 s de vie > 300 pas restants)
        for (const sim of [a, b]) sim.state.room.enemies.filter((_, k) => (i === 20 ? k % 2 === 0 : true)).forEach((e) => (e.hp = 0));
      }
      drops += ofType(a.step(DT, inputs), 'pickupDropped').length;
      b.step(DT, inputs);
      for (const sim of [a, b]) for (const p of sim.state.players) if (p.status === 'alive') p.hp = p.maxHp; // jamais blessés : rien n'est ramassé
    }
    expect(drops).toBeGreaterThan(0);
    expect(a.state.room.pickups?.length).toBeGreaterThan(0); // posée, jamais ramassée
    expect(a.state.rngState).toBe(b.state.rngState);
    expect(a.state.nextEntityId).toBe(b.state.nextEntityId);
    expect(JSON.stringify(a.state.room.enemies)).toBe(JSON.stringify(b.state.room.enemies));
    expect(JSON.stringify(a.state.room.projectiles)).toBe(JSON.stringify(b.state.room.projectiles));
    expect(JSON.stringify(a.state.players)).toBe(JSON.stringify(b.state.players));
    expect(a.state.tick).toBe(b.state.tick);
    // et le flux de butin, lui, a bien avancé
    expect(a.state.lootRngState).not.toBe(b.state.lootRngState);
  });

  it('le flux de butin dérive de la graine (déterministe) et n\'est jamais confondu avec le flux principal', () => {
    const a = mk(1, room('r1'), { seed: 123 });
    const b = mk(1, room('r1'), { seed: 123 });
    const c = mk(1, room('r1'), { seed: 124 });
    expect(a.state.lootRngState).toBe(b.state.lootRngState);
    expect(a.state.lootRngState).not.toBe(c.state.lootRngState);
    expect(a.state.lootRngState).not.toBe(a.state.rngState);
  });
});
