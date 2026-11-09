/**
 * Équipement dans la SIMULATION : budget par salle, ramassage (strictement meilleur, verrous), perte et éparpillement à la chute (règle stricte, défaite
 * d'équipe comprise), effacement au changement de salle, conservation entre salles, effets MESURÉS (vitesse, dégâts reçus / infligés, cadence, spécial,
 * relevage, arc), interrupteur `gear`, déterminisme, ISOLEMENT du flux aléatoire et restauration d'anciens snapshots.
 */
import { describe, expect, it } from 'vitest';
import { GEAR_BUDGET_PER_PLAYER, GEAR_PICKUP_RADIUS, GEAR_TTL_MS, REVIVE_INVULN_MS } from './balance';
import { CHARACTERS } from './characters';
import { REVIVE_DURATION_MS, SIM_STEP_MS, SUMMON_WAVE, WIPE_RESTART_DELAY_MS } from './constants';
import { createLoadout } from './gear';
import { makeTestLevel, makeTestRoom } from './levelValidation';
import { applyDamageToPlayer } from './players';
import { createSimulation, GameSimulation } from './simulation';
import type { CharacterId, EnemyKind, GearItem, LevelDef, PlayerGear, PlayerId, PlayerSetup, RoomDef, SimEvent, TickInputs, TileXY } from './types';

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
  characters?: CharacterId[];
  initialGear?: readonly (PlayerGear | undefined)[];
  rooms?: RoomDef[];
}

function mk(n: number, r: RoomDef = room('r1'), o: Opts = {}): GameSimulation {
  const lv = level(o.rooms ?? [r, room('r2')]);
  const players = setups(n).map((p, i) => ({ ...p, characterId: o.characters?.[i] ?? p.characterId }));
  return createSimulation({ levelId: lv.id, players, seed: o.seed ?? 5, loot: o.loot === true, gear: o.gear, initialGear: o.initialGear }, lv);
}

/** Invulnérabilité « infinie » : les ennemis ne peuvent pas faire tomber les joueurs pendant les mesures de tirage. */
function shield(s: GameSimulation): void {
  for (const p of s.state.players) p.invulnMs = 1e9;
}

function foes(kind: EnemyKind, n: number, tiles: TileXY[] = [[8, 2], [8, 3], [9, 2], [9, 3]]): RoomDef['enemies'] {
  return Array.from({ length: n }, (_, i) => ({ kind, tile: tiles[i % tiles.length] }));
}

function ofType<T extends SimEvent['type']>(events: readonly SimEvent[], type: T): Extract<SimEvent, { type: T }>[] {
  return events.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);
}

function stepN(s: GameSimulation, n: number, inputs: TickInputs | ((i: number) => TickInputs) = {}): SimEvent[] {
  const all: SimEvent[] = [];
  for (let i = 0; i < n; i++) all.push(...s.step(DT, typeof inputs === 'function' ? inputs(i) : inputs));
  return all;
}

function put(s: GameSimulation, id: PlayerId, x: number, y: number): void {
  s.state.players[id].pos = { x, y };
}

function addDrop(s: GameSimulation, item: GearItem, x: number, y: number, over: { lockedFor?: PlayerId; ttlMs?: number; lockMode?: 'life' | 'leave' } = {}): number {
  const id = s.state.nextGearDropId ?? 1;
  s.state.nextGearDropId = id + 1;
  s.state.room.gearDrops?.push({ id, item, pos: { x, y }, ttlMs: over.ttlMs ?? GEAR_TTL_MS, lockedFor: over.lockedFor ?? null, lockMode: over.lockMode ?? 'life' });
  return id;
}

/** Tue UN ennemi (le premier vivant) et avance d'un pas ; retourne les événements. */
function killOne(s: GameSimulation): SimEvent[] {
  const e = s.state.room.enemies.find((x) => !x.dead && x.hp > 0);
  if (e) e.hp = 0;
  return s.step(DT, {});
}

/** Tue les ennemis un par un jusqu'à la fin de la salle et retourne tous les événements. */
function killAllOneByOne(s: GameSimulation, max = 80): SimEvent[] {
  const all: SimEvent[] = [];
  s.step(DT, {}); // apparitions
  for (let i = 0; i < max; i++) {
    if (s.state.room.enemies.length === 0) break;
    all.push(...killOne(s));
  }
  return all;
}

const FAR = { x: 40, y: 40 }; // coin haut-gauche de la salle de test : loin de tout drop

describe('budget par salle : tirage des ennemis vaincus', () => {
  it('à n joueurs, au plus n objets par salle ; au moins 1 ; budget initial = n', () => {
    for (const n of [1, 2, 3, 4]) {
      const s = mk(n, room('r1', { enemies: foes('skeleton', 6) }));
      shield(s);
      expect(s.state.room.gearBudget).toBe(n * GEAR_BUDGET_PER_PLAYER);
      const ev = killAllOneByOne(s);
      const drops = ofType(ev, 'gearDropped');
      expect(drops.length, `n=${n}`).toBeLessThanOrEqual(n);
      expect(drops.length, `n=${n}`).toBeGreaterThanOrEqual(1);
      expect(s.state.room.gearBudget).toBe(n - drops.length);
    }
  });
  it('sur 300 graines : moyenne ~ n objets (hors cœurs), jamais plus de n', () => {
    for (const n of [1, 2]) {
      let total = 0;
      const SEEDS = 300;
      for (let seed = 1; seed <= SEEDS; seed++) {
        const s = mk(n, room('r1', { enemies: [...foes('slime', 3), ...foes('skeleton', 3), ...foes('knight', 1)] }), { seed });
        shield(s);
        const c = ofType(killAllOneByOne(s), 'gearDropped').length;
        expect(c).toBeLessThanOrEqual(n);
        total += c;
      }
      expect(total / SEEDS, `n=${n}`).toBeGreaterThan(n * 0.8);
    }
  });
  it('avec les cœurs de vie actifs : l\'exclusion mutuelle est compensée, la moyenne reste proche du budget', () => {
    let total = 0;
    const SEEDS = 300;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const s = mk(2, room('r1', { enemies: [...foes('slime', 3), ...foes('skeleton', 3), ...foes('knight', 1)] }), { seed, loot: true });
      shield(s);
      total += ofType(killAllOneByOne(s), 'gearDropped').length;
    }
    expect(total / SEEDS).toBeGreaterThan(1.5);
    expect(total / SEEDS).toBeLessThanOrEqual(2);
  });
  it('un ennemi invoqué (vague SUMMON_WAVE) ne laisse jamais d\'objet et ne consomme pas le budget', () => {
    const s = mk(2, room('r1', { enemies: foes('knight', 1) }));
    shield(s);
    s.step(DT, {});
    const e = s.state.room.enemies[0];
    e.wave = SUMMON_WAVE;
    e.hp = 0;
    const ev = s.step(DT, {});
    expect(ofType(ev, 'gearDropped')).toHaveLength(0);
    expect(s.state.room.gearBudget).toBe(2);
  });
  it('un boss final ne laisse rien', () => {
    const s = mk(2, room('r1', { enemies: foes('morvane', 1) }));
    shield(s);
    s.step(DT, {});
    s.state.room.enemies[0].hp = 0;
    expect(ofType(s.step(DT, {}), 'gearDropped')).toHaveLength(0);
    expect(s.state.room.gearBudget).toBe(2);
  });
  it('un demi-boss laisse TOUJOURS un objet de niveau >= II (il consomme un objet du budget de sa salle)', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const s = mk(2, room('r1', { enemies: foes('warden', 1) }), { seed });
      shield(s);
      s.step(DT, {});
      s.state.room.enemies[0].hp = 0;
      const drops = ofType(s.step(DT, {}), 'gearDropped');
      expect(drops).toHaveLength(1);
      expect(drops[0].item.level).toBeGreaterThanOrEqual(2);
      expect(drops[0].scattered).toBe(false);
      expect(s.state.room.gearBudget).toBe(1);
    }
  });
  it('salle de demi-boss : les ennemis ordinaires ne mangent pas l\'objet réservé au demi-boss (solo : budget 1 -> uniquement le demi-boss)', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const s = mk(1, room('r1', { enemies: [...foes('skeleton', 3), ...foes('warden', 1, [[9, 3]])] }), { seed });
      shield(s);
      s.step(DT, {});
      // d'abord les ordinaires, puis le demi-boss
      for (const e of s.state.room.enemies.filter((x) => x.kind === 'skeleton')) e.hp = 0;
      const first = ofType(s.step(DT, {}), 'gearDropped');
      expect(first).toHaveLength(0);
      s.state.room.enemies.find((x) => x.kind === 'warden')!.hp = 0;
      expect(ofType(s.step(DT, {}), 'gearDropped')).toHaveLength(1);
    }
  });
  it('magie jamais tirée en solo (budget retiré, poids redistribué)', () => {
    for (let seed = 1; seed <= 150; seed++) {
      const s = mk(1, room('r1', { enemies: foes('knight', 2) }), { seed });
      shield(s);
      for (const d of ofType(killAllOneByOne(s), 'gearDropped')) expect(d.item.slot).not.toBe('magic');
    }
  });
  it('interrupteur gear:false : aucun objet, budget 0 ; la partie est identique à gear:true tant que rien n\'est ramassé', () => {
    const mkSim = (gear: boolean): GameSimulation => mk(2, room('r1', { enemies: [...foes('skeleton', 4), ...foes('knight', 2)] }), { seed: 9, gear });
    const a = mkSim(true);
    const b = mkSim(false);
    shield(a);
    shield(b);
    expect(b.state.room.gearBudget).toBe(0);
    a.step(DT, {});
    b.step(DT, {});
    let drops = 0;
    for (let i = 0; i < 12; i++) {
      for (const sim of [a, b]) {
        const e = sim.state.room.enemies.find((x) => !x.dead && x.hp > 0);
        if (e) e.hp = 0;
      }
      drops += ofType(a.step(DT, {}), 'gearDropped').length;
      expect(ofType(b.step(DT, {}), 'gearDropped')).toHaveLength(0);
      for (const sim of [a, b]) for (const p of sim.state.players) put(sim, p.id, 30 + p.id * 3, 30);
    }
    expect(drops).toBeGreaterThan(0);
    // flux principal, flux de butin de vie, ennemis, projectiles et joueurs : identiques (l'équipement n'a rien ramassé)
    expect(a.state.rngState).toBe(b.state.rngState);
    expect(a.state.lootRngState).toBe(b.state.lootRngState);
    expect(a.state.nextEntityId).toBe(b.state.nextEntityId);
    expect(JSON.stringify(a.state.room.enemies)).toBe(JSON.stringify(b.state.room.enemies));
    expect(JSON.stringify(a.state.players)).toBe(JSON.stringify(b.state.players));
    // et le flux ISOLÉ de l'équipement, lui, a bien avancé
    expect(a.state.gearRngState).not.toBe(b.state.gearRngState);
  });
  it('flux isolé : dérivé de la graine, distinct du flux principal et du flux de butin de vie ; déterminisme complet', () => {
    const a = mk(2, room('r1'), { seed: 77 });
    const b = mk(2, room('r1'), { seed: 77 });
    const c = mk(2, room('r1'), { seed: 78 });
    expect(a.state.gearRngState).toBe(b.state.gearRngState);
    expect(a.state.gearRngState).not.toBe(c.state.gearRngState);
    expect(a.state.gearRngState).not.toBe(a.state.rngState);
    expect(a.state.gearRngState).not.toBe(a.state.lootRngState);
    const r1 = mk(2, room('r1', { enemies: foes('skeleton', 6) }), { seed: 31 });
    const r2 = mk(2, room('r1', { enemies: foes('skeleton', 6) }), { seed: 31 });
    shield(r1);
    shield(r2);
    killAllOneByOne(r1);
    killAllOneByOne(r2);
    expect(r1.serialize()).toBe(r2.serialize());
  });
  it('un objet tombe à côté du cœur laissé par le même ennemi (jamais superposé) et dure 20 s', () => {
    let seen = 0;
    for (let seed = 1; seed <= 200 && seen < 5; seed++) {
      const s = mk(1, room('r1', { enemies: foes('warden', 1) }), { seed, loot: true });
      shield(s);
      s.step(DT, {});
      s.state.room.enemies[0].hp = 0;
      const ev = s.step(DT, {});
      const heart = ofType(ev, 'pickupDropped')[0];
      const gear = ofType(ev, 'gearDropped')[0];
      expect(heart).toBeDefined(); // un demi-boss laisse toujours un cœur entier
      expect(gear).toBeDefined();
      expect(Math.hypot(heart.pos.x - gear.pos.x, heart.pos.y - gear.pos.y)).toBeGreaterThan(4);
      expect(s.state.room.gearDrops?.[0].ttlMs).toBe(GEAR_TTL_MS);
      seen++;
    }
    expect(seen).toBe(5);
  });
});

describe('ramassage automatique', () => {
  it('un objet STRICTEMENT meilleur est ramassé au contact (équipe, l\'ancien disparaît, événement gearPicked)', () => {
    const s = mk(1);
    s.state.players[0].loadout.boots = 1;
    put(s, 0, 100, 60);
    addDrop(s, { slot: 'boots', level: 3 }, 104, 60);
    const ev = stepN(s, 2);
    const picked = ofType(ev, 'gearPicked');
    expect(picked).toHaveLength(1);
    expect(picked[0].replaced).toEqual({ slot: 'boots', level: 1 });
    expect(s.state.players[0].loadout.boots).toBe(3);
    expect(s.state.room.gearDrops).toHaveLength(0);
  });
  it('emplacement vide : équipé (replaced null)', () => {
    const s = mk(1);
    put(s, 0, 100, 60);
    addDrop(s, { slot: 'weapon', level: 1 }, 100, 60);
    const picked = ofType(stepN(s, 2), 'gearPicked');
    expect(picked[0].replaced).toBeNull();
    expect(s.state.players[0].loadout.weapon).toBe(1);
  });
  it('niveau égal ou inférieur : l\'objet RESTE au sol (aucun ramassage, aucun échange)', () => {
    const s = mk(1);
    s.state.players[0].loadout.protection = 2;
    put(s, 0, 100, 60);
    addDrop(s, { slot: 'protection', level: 2 }, 100, 60);
    addDrop(s, { slot: 'protection', level: 1 }, 101, 60);
    expect(ofType(stepN(s, 30), 'gearPicked')).toHaveLength(0);
    expect(s.state.players[0].loadout.protection).toBe(2);
    expect(s.state.room.gearDrops).toHaveLength(2);
  });
  it('hors du rayon : rien ; dans le rayon : ramassé', () => {
    const s = mk(1);
    put(s, 0, 100, 60);
    addDrop(s, { slot: 'artifact', level: 1 }, 100 + GEAR_PICKUP_RADIUS + 2, 60);
    expect(ofType(stepN(s, 5), 'gearPicked')).toHaveLength(0);
    put(s, 0, 100 + GEAR_PICKUP_RADIUS, 60);
    expect(ofType(stepN(s, 2), 'gearPicked')).toHaveLength(1);
  });
  it('un allié prend ce qu\'un autre joueur ne veut pas ; le plus proche l\'emporte ; un objet non pris reste pour l\'autre', () => {
    const s = mk(2);
    s.state.players[0].loadout.boots = 3; // n'en veut pas
    put(s, 0, 100, 60);
    put(s, 1, 104, 60);
    addDrop(s, { slot: 'boots', level: 2 }, 101, 60);
    const picked = ofType(stepN(s, 2), 'gearPicked');
    expect(picked).toHaveLength(1);
    expect(picked[0].playerId).toBe(1);
    // deux candidats : le plus proche
    const t = mk(2);
    put(t, 0, 100, 60);
    put(t, 1, 108, 60);
    addDrop(t, { slot: 'magic', level: 1 }, 101, 60);
    expect(ofType(stepN(t, 2), 'gearPicked')[0].playerId).toBe(0);
  });
  it('un joueur à terre ne ramasse rien', () => {
    const s = mk(2);
    s.state.players[1].status = 'down';
    s.state.players[1].hp = 0;
    put(s, 1, 100, 60);
    put(s, 0, 40, 40);
    addDrop(s, { slot: 'boots', level: 1 }, 100, 60);
    expect(ofType(stepN(s, 5), 'gearPicked')).toHaveLength(0);
  });
  it('durée au sol : 20 s puis l\'objet disparaît', () => {
    const s = mk(1);
    put(s, 0, 40, 40);
    addDrop(s, { slot: 'boots', level: 1 }, 150, 90, { ttlMs: GEAR_TTL_MS });
    stepN(s, Math.round(19_900 / DT));
    expect(s.state.room.gearDrops).toHaveLength(1);
    stepN(s, Math.round(400 / DT));
    expect(s.state.room.gearDrops).toHaveLength(0);
  });
  it('l\'équipement ramassé est conservé d\'une salle à l\'autre (PV et équipement), objets au sol effacés', () => {
    const s = mk(1);
    s.state.players[0].loadout.boots = 2;
    addDrop(s, { slot: 'magic', level: 1 }, 150, 90);
    put(s, 0, 9 * 16 + 8, 5 * 16 + 8); // dans la sortie
    stepN(s, 2);
    expect(s.state.phase).toBe('roomCleared');
    stepN(s, 120);
    expect(s.state.roomIndex).toBe(1);
    expect(s.state.players[0].loadout.boots).toBe(2);
    expect(s.state.room.gearDrops).toHaveLength(0);
    expect(s.state.room.gearBudget).toBe(1);
  });
});

describe('perte à la chute et éparpillement', () => {
  function equipped(s: GameSimulation, id: PlayerId, g: Partial<PlayerGear>): void {
    Object.assign(s.state.players[id].loadout, g);
  }
  it('un joueur mis à terre par un coup perd TOUT (les 5 emplacements + buffs) : objets éparpillés, gearLost + gearDropped', () => {
    const s = mk(2);
    equipped(s, 0, { boots: 1, protection: 2, artifact: 3, magic: 1, weapon: 2 });
    s.state.players[0].loadout.buffs = [{ kind: 'speed', remainingMs: 4000 }]; // (l'étoile rendrait invulnérable : testée à part)
    s.state.players[0].invulnMs = 0;
    put(s, 0, 100, 60);
    put(s, 1, 40, 40);
    const res = applyDamageToPlayer(s.state.players[0], 9999);
    expect(res.downed).toBe(true);
    const ev = stepN(s, 2);
    const lost = ofType(ev, 'gearLost');
    expect(lost).toHaveLength(1);
    expect(lost[0].items).toHaveLength(5);
    expect(s.state.players[0].loadout).toEqual(createLoadout());
    const drops = ofType(ev, 'gearDropped');
    expect(drops).toHaveLength(5);
    expect(drops.every((d) => d.scattered)).toBe(true);
    // éparpillés AUTOUR du joueur (pas tous au même point), verrouillés pour lui, 20 s
    expect(new Set(drops.map((d) => `${Math.round(d.pos.x)},${Math.round(d.pos.y)}`)).size).toBeGreaterThan(2);
    for (const d of s.state.room.gearDrops ?? []) {
      expect(d.lockedFor).toBe(0);
      expect(d.lockMode).toBe('life');
      expect(d.ttlMs).toBeGreaterThan(GEAR_TTL_MS - 100);
      expect(Math.hypot(d.pos.x - 100, d.pos.y - 60)).toBeLessThan(40);
    }
    // la perte est unique (idempotente)
    expect(ofType(stepN(s, 5), 'gearLost')).toHaveLength(0);
  });
  it('un joueur sans équipement qui tombe ne produit ni gearLost ni objet', () => {
    const s = mk(2);
    s.state.players[0].invulnMs = 0;
    applyDamageToPlayer(s.state.players[0], 9999);
    const ev = stepN(s, 2);
    expect(ofType(ev, 'gearLost')).toHaveLength(0);
    expect(s.state.room.gearDrops).toHaveLength(0);
  });
  it('chute scénarisée (knockDown, tutoriel) : même perte', () => {
    const s = mk(2);
    equipped(s, 0, { boots: 3 });
    expect(s.knockDown(0)).toBe(true);
    const ev = stepN(s, 1);
    expect(ofType(ev, 'gearLost')).toHaveLength(1);
    expect(s.state.players[0].loadout.boots).toBe(0);
  });
  it('le joueur tombé NE PEUT PAS reprendre ses objets pendant les 20 s, même relevé ; un allié les prend s\'ils sont meilleurs', () => {
    const s = mk(2);
    equipped(s, 0, { boots: 3, weapon: 1 });
    equipped(s, 1, { boots: 1, weapon: 3 }); // l'allié : bottes inférieures, arme supérieure
    s.state.players[0].invulnMs = 0;
    put(s, 0, 100, 60);
    put(s, 1, 40, 40);
    applyDamageToPlayer(s.state.players[0], 9999);
    stepN(s, 2);
    expect(s.state.room.gearDrops).toHaveLength(2);
    // relevé immédiatement (cheat d'état) et debout sur ses objets : il ne les reprend pas
    const p0 = s.state.players[0];
    p0.status = 'alive';
    p0.hp = p0.maxHp;
    for (const d of s.state.room.gearDrops ?? []) {
      put(s, 0, d.pos.x, d.pos.y);
      expect(ofType(stepN(s, 5), 'gearPicked')).toHaveLength(0);
    }
    expect(p0.loadout.boots).toBe(0);
    expect(s.state.room.gearDrops).toHaveLength(2);
    // l'allié passe sur les bottes (meilleures que les siennes) : il les prend ; l'arme (inférieure à la sienne) reste au sol
    const boots = (s.state.room.gearDrops ?? []).find((d) => d.item.slot === 'boots')!;
    put(s, 0, 40, 40);
    put(s, 1, boots.pos.x, boots.pos.y);
    const picked = ofType(stepN(s, 3), 'gearPicked');
    expect(picked).toHaveLength(1);
    expect(picked[0].playerId).toBe(1);
    expect(s.state.players[1].loadout.boots).toBe(3);
    expect(s.state.players[1].loadout.weapon).toBe(3);
    expect(s.state.room.gearDrops).toHaveLength(1);
  });
  it('verrou « tant qu\'il n\'a pas quitté le rayon » : levé dès que le joueur s\'éloigne', () => {
    const s = mk(1);
    put(s, 0, 100, 60);
    s.state.players[0].loadout.boots = 3;
    // objet meilleur... pour un autre emplacement vide
    addDrop(s, { slot: 'weapon', level: 1 }, 100, 60, { lockedFor: 0, lockMode: 'leave' });
    expect(ofType(stepN(s, 10), 'gearPicked')).toHaveLength(0); // verrouillé tant qu'il est dessus
    put(s, 0, 100 + GEAR_PICKUP_RADIUS + 10, 60);
    stepN(s, 1);
    expect(s.state.room.gearDrops?.[0].lockedFor).toBeNull();
    put(s, 0, 100, 60);
    expect(ofType(stepN(s, 2), 'gearPicked')).toHaveLength(1);
  });
  it('DÉFAITE D\'ÉQUIPE : règle stricte, tout le monde perd tout (aucun point de reprise) ; salle redémarrée sans équipement ni objet au sol', () => {
    const s = mk(2, room('r1', { enemies: foes('slime', 2) }));
    equipped(s, 0, { boots: 3, protection: 3 });
    equipped(s, 1, { weapon: 2, magic: 1 });
    // le premier tombe, le dernier survivant tombe à son tour
    s.state.players.forEach((p) => (p.invulnMs = 0));
    applyDamageToPlayer(s.state.players[0], 9999);
    stepN(s, 2);
    expect(s.state.players[1].loadout.weapon).toBe(2); // pas encore tombé
    applyDamageToPlayer(s.state.players[1], 9999);
    const ev = stepN(s, 2);
    expect(ofType(ev, 'teamWipe')).toHaveLength(1);
    expect(s.state.players.every((p) => p.loadout.boots + p.loadout.protection + p.loadout.weapon + p.loadout.magic === 0)).toBe(true);
    // redémarrage automatique : équipement toujours vide, objets au sol effacés
    const after = stepN(s, Math.ceil(WIPE_RESTART_DELAY_MS / DT) + 5);
    expect(ofType(after, 'roomEntered').some((e) => e.reason === 'restart')).toBe(true);
    for (const p of s.state.players) expect(p.loadout).toEqual(createLoadout());
    expect(s.state.room.gearDrops).toHaveLength(0);
    expect(s.state.room.gearBudget).toBe(2);
  });
  it('objets éparpillés effacés au (re)démarrage de salle et au changement de salle', () => {
    const s = mk(1);
    addDrop(s, { slot: 'boots', level: 1 }, 150, 90);
    put(s, 0, 9 * 16 + 8, 5 * 16 + 8);
    stepN(s, 2);
    stepN(s, 120);
    expect(s.state.roomIndex).toBe(1);
    expect(s.state.room.gearDrops).toHaveLength(0);
  });
  it('un relevé revient SANS équipement (relevage à PV pleins)', () => {
    const s = mk(2);
    equipped(s, 0, { boots: 3 });
    s.state.players[0].invulnMs = 0;
    put(s, 0, 100, 60);
    put(s, 1, 102, 60);
    applyDamageToPlayer(s.state.players[0], 9999);
    stepN(s, 2);
    const ev = stepN(s, Math.ceil(REVIVE_DURATION_MS / DT) + 10, { 1: { moveX: 0, moveY: 0, attack: false, interact: false, revive: true } });
    expect(ofType(ev, 'playerRevived')).toHaveLength(1);
    expect(s.state.players[0].status).toBe('alive');
    expect(s.state.players[0].loadout.boots).toBe(0);
  });
});

describe('effets mesurés en simulation', () => {
  function distanceWalked(gear: Partial<PlayerGear>, steps = 60): number {
    const s = mk(1, room('r1'));
    Object.assign(s.state.players[0].loadout, gear);
    put(s, 0, 20, 64);
    const x0 = s.state.players[0].pos.x;
    stepN(s, steps, { 0: { moveX: 1, moveY: 0, attack: false, interact: false, revive: false } });
    return s.state.players[0].pos.x - x0;
  }
  it('VITESSE : bottes +10 / +20 / +30 % de déplacement', () => {
    const base = distanceWalked({});
    expect(base).toBeGreaterThan(30);
    for (const [lv, k] of [[1, 1.1], [2, 1.2], [3, 1.3]] as const) expect(distanceWalked({ boots: lv }) / base).toBeCloseTo(k, 2);
  });
  it('DÉGÂTS REÇUS : protection -10 / -20 / -30 % (après difficulté et résistance)', () => {
    const hit = (lv: number): number => {
      const s = mk(1);
      s.state.players[0].loadout.protection = lv;
      s.state.players[0].invulnMs = 0;
      return applyDamageToPlayer(s.state.players[0], 40).applied;
    };
    const base = hit(0);
    expect(hit(1)).toBe(Math.round(40 * 0.82 * 0.9));
    expect(hit(2)).toBe(Math.round(40 * 0.82 * 0.8));
    expect(hit(3)).toBe(Math.round(40 * 0.82 * 0.7));
    expect(base).toBe(Math.round(40 * 0.82));
  });
  /** PV perdus par une cible au corps à corps (david face à un squelette) après UNE attaque. */
  function oneHit(gear: Partial<PlayerGear>, characterId: CharacterId = 'david'): { lost: number; cooldown: number; projectiles: number; kind: string | null } {
    const s = mk(1, room('r1', { enemies: [{ kind: 'skeleton', tile: [4, 2] }] }), { characters: [characterId] });
    Object.assign(s.state.players[0].loadout, gear);
    s.step(DT, {});
    const e = s.state.room.enemies[0];
    const p = s.state.players[0];
    p.pos = { x: 4 * 16 + 8 - 14, y: 2 * 16 + 8 };
    p.facing = 'right';
    p.invulnMs = 1e9;
    e.pos = { x: 4 * 16 + 8, y: 2 * 16 + 8 };
    const hp0 = e.hp;
    s.step(DT, { 0: { moveX: 0, moveY: 0, attack: true, interact: false, revive: false } });
    return { lost: hp0 - (s.state.room.enemies[0]?.hp ?? 0), cooldown: p.attackCooldownMs, projectiles: s.state.room.projectiles.length, kind: s.state.room.projectiles[0]?.kind ?? null };
  }
  it('DÉGÂTS INFLIGÉS : épée +20 %, hache +35 % ; cadence : hache 20 % plus lente', () => {
    const base = oneHit({});
    expect(base.lost).toBeGreaterThan(0);
    expect(base.projectiles).toBe(0);
    const sword = oneHit({ weapon: 1 });
    const axe = oneHit({ weapon: 2 });
    expect(sword.lost / base.lost).toBeCloseTo(1.2, 5);
    expect(axe.lost / base.lost).toBeCloseTo(1.35, 5);
    expect(sword.cooldown).toBeCloseTo(base.cooldown, 5);
    expect(axe.cooldown / base.cooldown).toBeCloseTo(1.2, 1);
    expect(base.cooldown).toBeGreaterThan(CHARACTERS.david.attack.cooldownMs - 40);
  });
  it('ARC : un héros au corps à corps tire une flèche (pas de coup de mêlée), ~190 px de portée, 70 % de ses dégâts', () => {
    const bow = oneHit({ weapon: 3 });
    // cible collée au héros : la flèche part ET touche dans le même pas (elle est consommée), pour 70 % des dégâts de mêlée
    expect(bow.lost / oneHit({}).lost).toBeCloseTo(0.7, 5);
    expect(bow.cooldown).toBeCloseTo(oneHit({}).cooldown, 5);
    const s = mk(1, room('r1'), { characters: ['david'] });
    s.state.players[0].loadout.weapon = 3;
    s.step(DT, {});
    s.state.players[0].facing = 'right';
    put(s, 0, 20, 64);
    s.step(DT, { 0: { moveX: 0, moveY: 0, attack: true, interact: false, revive: false } });
    const proj = s.state.room.projectiles[0];
    expect(proj.damage).toBeCloseTo((6 + 2.5 * 8) * 0.8 * 0.7, 5);
    expect((Math.hypot(proj.vel.x, proj.vel.y) * proj.lifeMs) / 1000).toBeLessThanOrEqual(190 + 5);
    expect((Math.hypot(proj.vel.x, proj.vel.y) * proj.lifeMs) / 1000).toBeGreaterThan(150);
  });
  it('ARC sur un tireur : même projectile, +15 % de dégâts', () => {
    const dmg = (weapon: number): number => {
      const s = mk(1, room('r1'), { characters: ['aelith'] });
      s.state.players[0].loadout.weapon = weapon;
      s.step(DT, {});
      put(s, 0, 20, 64);
      s.state.players[0].facing = 'right';
      s.step(DT, { 0: { moveX: 0, moveY: 0, attack: true, interact: false, revive: false } });
      return s.state.room.projectiles[0].damage;
    };
    expect(dmg(3) / dmg(0)).toBeCloseTo(1.15, 5);
  });
  it('SPÉCIAL : l\'artefact réduit la recharge de 15 / 25 / 35 %', () => {
    const cd = (lv: number): number => {
      const s = mk(1, room('r1'));
      s.state.players[0].loadout.artifact = lv;
      s.step(DT, {});
      s.step(DT, { 0: { moveX: 0, moveY: 0, attack: false, interact: false, revive: false, special: true } });
      return s.state.players[0].specialCooldownMs;
    };
    const base = cd(0);
    expect(base).toBeGreaterThan(13900);
    expect(cd(1) / base).toBeCloseTo(0.85, 2);
    expect(cd(2) / base).toBeCloseTo(0.75, 2);
    expect(cd(3) / base).toBeCloseTo(0.65, 2);
  });
  it('RELEVAGE : la magie de CELUI QUI RELÈVE réduit la durée de 20 / 35 / 50 %', () => {
    const duration = (lv: number): number => {
      const s = mk(2);
      s.state.players[1].loadout.magic = lv; // le sauveteur
      s.state.players[0].invulnMs = 0;
      put(s, 0, 100, 60);
      put(s, 1, 104, 60);
      applyDamageToPlayer(s.state.players[0], 9999);
      let steps = 0;
      for (; steps < 600; steps++) {
        s.step(DT, { 1: { moveX: 0, moveY: 0, attack: false, interact: false, revive: true } });
        if (s.state.players[0].status === 'alive') break;
      }
      return steps * DT;
    };
    const base = duration(0);
    expect(base).toBeGreaterThan(REVIVE_DURATION_MS - 100);
    expect(duration(1) / base).toBeCloseTo(0.8, 1);
    expect(duration(2) / base).toBeCloseTo(0.65, 1);
    expect(duration(3) / base).toBeCloseTo(0.5, 1);
  });
  it('la magie de la CIBLE (relevée) ne change rien', () => {
    const s = mk(2);
    s.state.players[0].loadout.magic = 3;
    s.state.players[0].invulnMs = 0;
    applyDamageToPlayer(s.state.players[0], 9999);
    stepN(s, 1);
    // magie perdue à la chute : de toute façon vide
    expect(s.state.players[0].loadout.magic).toBe(0);
  });
});

describe('restauration et compatibilité', () => {
  it('serialize / restore : l\'équipement, les objets au sol, le budget et les flux sont conservés ; la suite est identique', () => {
    const a = mk(2, room('r1', { enemies: foes('skeleton', 3) }), { seed: 4 });
    shield(a);
    a.state.players[0].loadout.boots = 2;
    a.state.players[1].loadout.accessory = { kind: 'magnet', level: 1 };
    killOne(a);
    addDrop(a, { slot: 'weapon', level: 2 }, 150, 90, { lockedFor: 1 });
    const b = GameSimulation.restore(a.serialize(), a.level);
    expect(b.state.players[0].loadout.boots).toBe(2);
    expect(b.state.players[1].loadout.accessory).toEqual({ kind: 'magnet', level: 1 });
    expect(b.state.room.gearDrops).toEqual(a.state.room.gearDrops);
    for (let i = 0; i < 40; i++) {
      killOne(a);
      killOne(b);
    }
    expect(b.serialize()).toBe(a.serialize());
  });
  it('ancien snapshot (sans loadout, sans champs d\'équipement) : valeurs par défaut posées, partie jouable', () => {
    const a = mk(2, room('r1', { enemies: foes('skeleton', 2) }), { seed: 8 });
    a.step(DT, {});
    const snap = JSON.parse(a.serialize()) as Record<string, unknown> & { players: Record<string, unknown>[]; room: Record<string, unknown> };
    for (const p of snap.players) delete p.loadout;
    delete snap.gearEnabled;
    delete snap.gearRngState;
    delete snap.nextGearDropId;
    delete snap.room.gearDrops;
    delete snap.room.gearBudget;
    const b = GameSimulation.restore(JSON.stringify(snap), a.level);
    expect(b.state.players.every((p) => JSON.stringify(p.loadout) === JSON.stringify(createLoadout()))).toBe(true);
    expect(b.state.gearEnabled).toBe(true);
    expect(typeof b.state.gearRngState).toBe('number');
    expect(b.state.nextGearDropId).toBe(1);
    expect(b.state.room.gearDrops).toEqual([]);
    expect(b.state.room.gearBudget).toBe(2);
    expect(() => stepN(b, 30)).not.toThrow();
  });
  it('snapshot dont l\'équipement était désactivé reste désactivé ; un loadout corrompu est normalisé', () => {
    const a = mk(1, room('r1'), { gear: false });
    const snap = JSON.parse(a.serialize()) as { players: { loadout: Record<string, unknown> }[] };
    snap.players[0].loadout = { boots: 7, weapon: 2, accessory: 'x', buffs: 'y' };
    const b = GameSimulation.restore(JSON.stringify(snap), a.level);
    expect(b.state.gearEnabled).toBe(false);
    expect(b.state.players[0].loadout).toEqual({ ...createLoadout(), weapon: 2 });
  });
  it('initialGear (reprise « Continuer ») : équipement de départ restitué, donnée invalide normalisée', () => {
    const s = mk(2, room('r1'), { initialGear: [{ boots: 2, protection: 0, artifact: 0, magic: 0, weapon: 3, accessory: null }, undefined] });
    expect(s.state.players[0].loadout.boots).toBe(2);
    expect(s.state.players[0].loadout.weapon).toBe(3);
    expect(s.state.players[1].loadout).toEqual(createLoadout());
    const bad = mk(1, room('r1'), { initialGear: [{ boots: 99, protection: 1, artifact: 0, magic: 0, weapon: 0, accessory: null } as PlayerGear] });
    expect(bad.state.players[0].loadout.boots).toBe(0);
    expect(bad.state.players[0].loadout.protection).toBe(1);
  });
  it('sans équipement ramassé, le comportement de combat est strictement celui d\'avant (même suite d\'états avec ou sans gear)', () => {
    const mkSim = (gear: boolean): GameSimulation => mk(1, room('r1', { enemies: foes('skeleton', 2) }), { seed: 12, gear });
    const a = mkSim(true);
    const b = mkSim(false);
    for (let i = 0; i < 300; i++) {
      const inp: TickInputs = { 0: { moveX: Math.sin(i / 30), moveY: Math.cos(i / 40), attack: i % 3 === 0, interact: false, revive: false } };
      a.step(DT, inp);
      b.step(DT, inp);
      if (a.state.room.gearDrops && a.state.room.gearDrops.length > 0) break; // un objet est tombé : la comparaison s'arrête (il pourrait être ramassé)
    }
    expect(JSON.stringify(a.state.room.enemies)).toBe(JSON.stringify(b.state.room.enemies));
    expect(JSON.stringify(a.state.players)).toBe(JSON.stringify(b.state.players));
    expect(a.state.rngState).toBe(b.state.rngState);
  });
  it('invincibilité et relevage : REVIVE_INVULN_MS inchangé', () => {
    expect(REVIVE_INVULN_MS).toBe(1500);
  });
});
