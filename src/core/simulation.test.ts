import { describe, expect, it } from 'vitest';
import { createEnemyState } from './ai';
import { damageToEnemy, damageToPlayer, playerBaseDamage } from './balance';
import { getCharacter } from './characters';
import { canOccupy } from './collision';
import {
  PLAYER_RADIUS,
  REVIVE_DURATION_MS,
  ROOM_CLEAR_DELAY_MS,
  SIM_STEP_MS,
  TILE,
  WIPE_RESTART_DELAY_MS,
} from './constants';
import { makeTestLayout, makeTestLevel, makeTestRoom } from './levelValidation';
import { applyDamageToPlayer } from './players';
import { createRng, nextRandom } from './rng';
import { createSimulation, GameSimulation, MAX_ALIVE_ENEMIES, ROOM_ENTER_INVULN_MS } from './simulation';
import type {
  ActionFrame,
  CharacterId,
  Difficulty,
  EnemyKind,
  EnemySpawnDef,
  LevelDef,
  MechanismDef,
  ObjectiveDef,
  PlayerId,
  PlayerSetup,
  ProjectileState,
  RoomDef,
  SimEvent,
  TickInputs,
  TileXY,
} from './types';

// ───────────────────────────── Harnais ─────────────────────────────

const DT = SIM_STEP_MS;
const EXIT_CENTER = { x: 10 * TILE, y: 6 * TILE }; // centre de la sortie par défaut [9,5,2,2]

function frame(over: Partial<ActionFrame> = {}): ActionFrame {
  return { moveX: 0, moveY: 0, attack: false, interact: false, revive: false, ...over };
}

function setups(n: number, characterId: CharacterId = 'david', difficulty: Difficulty = 2): PlayerSetup[] {
  return Array.from({ length: n }, (_, i) => ({ id: i as PlayerId, characterId, difficulty }));
}

/** Salle de test dont la sortie ne demande rien. Les `overrides` remplacent les valeurs par défaut. */
function mkRoom(id: string, overrides: Partial<RoomDef> = {}, final = false): RoomDef {
  const base = makeTestRoom({
    id,
    exit: { rect: { x: 9, y: 5, w: 2, h: 2 }, requires: [], ...(final ? { final: true } : {}) },
    ...overrides,
  });
  return base;
}

function mkLevel(rooms: RoomDef[], objectives: ObjectiveDef[] = []): LevelDef {
  rooms[rooms.length - 1].exit.final = true;
  return makeTestLevel({ rooms, objectives });
}

function sim(level: LevelDef, n = 1, opts: { seed?: number; players?: PlayerSetup[] } = {}): GameSimulation {
  return createSimulation(
    { levelId: level.id, players: opts.players ?? setups(n), seed: opts.seed ?? 1234 },
    level,
  );
}

function stepN(s: GameSimulation, n: number, inputs: TickInputs | ((i: number) => TickInputs) = {}): SimEvent[] {
  const all: SimEvent[] = [];
  for (let i = 0; i < n; i++) {
    all.push(...s.step(DT, typeof inputs === 'function' ? inputs(i) : inputs));
  }
  return all;
}

function types(events: readonly SimEvent[]): string[] {
  return events.map((e) => e.type);
}

function tileCenterOf(t: TileXY): { x: number; y: number } {
  return { x: (t[0] + 0.5) * TILE, y: (t[1] + 0.5) * TILE };
}

function teleportToExit(s: GameSimulation, ids?: number[]): void {
  s.state.players.forEach((p, i) => {
    if (ids && !ids.includes(i)) return;
    p.pos = { x: EXIT_CENTER.x + (i % 2) * 4, y: EXIT_CENTER.y + Math.floor(i / 2) * 4 };
  });
}

/** Ajoute un ennemi immobilisé (étourdi très longtemps) à la salle courante. */
function addStaticEnemy(s: GameSimulation, kind: EnemyKind, x: number, y: number): number {
  const id = s.state.nextEntityId++;
  const e = createEnemyState(kind, { x, y }, id, 0);
  e.data.stunMs = 1e9;
  e.mode = 'stunned';
  s.state.room.enemies.push(e);
  return id;
}

function addEnemyProjectile(s: GameSimulation, x: number, y: number, vx: number, vy: number, damage: number): ProjectileState {
  const p: ProjectileState = {
    id: s.state.nextEntityId++,
    kind: 'bolt',
    owner: { type: 'enemy', id: 9999 },
    pos: { x, y },
    vel: { x: vx, y: vy },
    damage,
    radius: 3,
    lifeMs: 2000,
    pierce: false,
    hitIds: [],
  };
  s.state.room.projectiles.push(p);
  return p;
}

function killPlayer(s: GameSimulation, i: number): void {
  const p = s.state.players[i];
  p.invulnMs = 0;
  applyDamageToPlayer(p, 99999);
}

function allFinite(value: unknown, path = 'state'): string | null {
  if (typeof value === 'number') return Number.isFinite(value) ? null : `${path} = ${String(value)}`;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const r = allFinite(value[i], `${path}[${i}]`);
      if (r) return r;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const r = allFinite(v, `${path}.${k}`);
      if (r) return r;
    }
  }
  return null;
}

/** Entrées pseudo-aléatoires déterministes (changent toutes les ~15 pas, avec quelques NaN). */
function randomInputs(n: number, seed: number): (tick: number) => TickInputs {
  const rng = createRng(seed);
  const cur: ActionFrame[] = Array.from({ length: n }, () => frame());
  return (tick) => {
    const out: TickInputs = {};
    for (let i = 0; i < n; i++) {
      if (tick % 15 === (i * 4) % 15) {
        const analog = nextRandom(rng) < 0.3;
        const ax = analog ? nextRandom(rng) * 2 - 1 : Math.floor(nextRandom(rng) * 3) - 1;
        const ay = analog ? nextRandom(rng) * 2 - 1 : Math.floor(nextRandom(rng) * 3) - 1;
        cur[i] = {
          moveX: nextRandom(rng) < 0.01 ? NaN : ax,
          moveY: ay,
          attack: nextRandom(rng) < 0.5,
          interact: nextRandom(rng) < 0.3,
          revive: nextRandom(rng) < 0.4,
        };
      }
      out[i as PlayerId] = cur[i];
    }
    return out;
  };
}

/** Grande salle 30×20 avec piliers, fosses et tous les types d'ennemis. */
function arenaRoom(id: string): RoomDef {
  const layout = makeTestLayout(30, 20).map((row) => row.split(''));
  const set = (x: number, y: number, ch: string): void => {
    layout[y][x] = ch;
  };
  for (let y = 5; y < 15; y += 4) for (let x = 6; x < 26; x += 5) set(x, y, 'o');
  for (let x = 10; x < 16; x++) set(x, 9, '~');
  const enemies: EnemySpawnDef[] = [
    { kind: 'slime', tile: [20, 3] },
    { kind: 'bat', tile: [22, 4] },
    { kind: 'skeleton', tile: [24, 6] },
    { kind: 'archer', tile: [26, 10] },
    { kind: 'spider', tile: [20, 15] },
    { kind: 'wisp', tile: [24, 16] },
    { kind: 'knight', tile: [14, 12] },
    { kind: 'golem', tile: [22, 10], minPlayers: 2 },
    { kind: 'morvane', tile: [16, 16], wave: 1, minPlayers: 3 },
    { kind: 'slime', tile: [18, 2], wave: 1 },
  ];
  return makeTestRoom({
    id,
    layout: layout.map((r) => r.join('')),
    enemies,
    mechanisms: [{ id: 'p1', type: 'plate', tile: [8, 7] }],
    exit: { rect: { x: 27, y: 17, w: 2, h: 2 }, requires: [] },
  });
}

// ───────────────────────────── Création, joueurs, mouvement ─────────────────────────────

describe('création', () => {
  it('place les joueurs sur les spawns avec PV pleins indépendants de la difficulté', () => {
    const level = mkLevel([mkRoom('r1')]);
    const s = sim(level, 1, {
      players: [
        { id: 0, characterId: 'david', difficulty: 1 },
        { id: 1, characterId: 'david', difficulty: 3 },
      ],
    });
    expect(s.playerCount).toBe(2);
    expect(s.state.players[0].pos).toEqual(tileCenterOf([2, 2]));
    expect(s.state.players[1].pos).toEqual(tileCenterOf([3, 2]));
    expect(s.state.players[0].hp).toBe(s.state.players[1].hp);
    expect(s.state.players[0].maxHp).toBe(s.state.players[1].maxHp);
    expect(s.state.phase).toBe('playing');
    expect(s.room.id).toBe('r1');
    expect(s.grid.width).toBe(12);
  });

  it('le premier pas renvoie roomEntered(start) et les apparitions initiales', () => {
    const level = mkLevel([mkRoom('r1', { enemies: [{ kind: 'slime', tile: [9, 1] }] })]);
    const s = sim(level);
    expect(s.state.room.enemies.length).toBe(1);
    const ev = s.step(DT, {});
    expect(ev[0]).toEqual({ type: 'roomEntered', roomId: 'r1', roomIndex: 0, reason: 'start' });
    expect(types(ev)).toContain('enemySpawned');
    expect(types(s.step(DT, {}))).not.toContain('roomEntered');
  });

  it('refuse une liste de joueurs vide, tronque à 4 joueurs et renumérote les ids non contigus', () => {
    const level = mkLevel([mkRoom('r1')]);
    expect(() => createSimulation({ levelId: 'x', players: [], seed: 1 }, level)).toThrow();
    const five = createSimulation({ levelId: 'x', players: [...setups(4), { id: 3, characterId: 'mira', difficulty: 2 }], seed: 1 }, level);
    expect(five.playerCount).toBe(4);
    const odd = createSimulation(
      { levelId: 'x', players: [{ id: 2, characterId: 'david', difficulty: 2 }, { id: 0, characterId: 'mira', difficulty: 2 }], seed: 1 },
      level,
    );
    expect(odd.state.players.map((p) => p.id)).toEqual([0, 1]);
  });
});

describe('mouvement', () => {
  const level = mkLevel([mkRoom('r1', { mechanisms: [{ id: 'p1', type: 'plate', tile: [6, 6] }] })]);

  it('vitesse du personnage × durée, clavier (norme 1)', () => {
    const s = sim(level);
    const x0 = s.state.players[0].pos.x;
    stepN(s, 60, { 0: frame({ moveX: 1 }) });
    const speed = getCharacter('david').speed;
    expect(s.state.players[0].pos.x - x0).toBeCloseTo((speed * 60 * DT) / 1000, 6);
    expect(s.state.players[0].facing).toBe('right');
    expect(s.state.players[0].moving).toBe(true);
  });

  it("l'amplitude analogique module la vitesse ; la diagonale est normalisée ; norme > 1 plafonnée", () => {
    const speed = getCharacter('david').speed;
    const half = sim(level);
    const x0 = half.state.players[0].pos.x;
    stepN(half, 60, { 0: frame({ moveX: 0.5 }) });
    expect(half.state.players[0].pos.x - x0).toBeCloseTo((speed * 0.5 * 60 * DT) / 1000, 6);

    const diag = sim(level);
    const d0 = { ...diag.state.players[0].pos };
    stepN(diag, 30, { 0: frame({ moveX: 1, moveY: 1 }) });
    const moved = Math.hypot(diag.state.players[0].pos.x - d0.x, diag.state.players[0].pos.y - d0.y);
    expect(moved).toBeCloseTo((speed * 30 * DT) / 1000, 6);
  });

  it('ignore NaN/Infinity, les joueurs absents du map et les joueurs à terre', () => {
    const s = sim(level, 2);
    const before = s.state.players.map((p) => ({ ...p.pos }));
    stepN(s, 20, { 0: frame({ moveX: NaN, moveY: Infinity }) });
    expect(s.state.players[0].pos.y).toBeGreaterThan(before[0].y); // Infinity → 1 (borné) ; NaN → 0
    expect(s.state.players[0].pos.x).toBe(before[0].x);
    expect(s.state.players[1].pos).toEqual(before[1]); // absent
    expect(allFinite(s.state)).toBeNull();
    killPlayer(s, 1);
    const p1 = { ...s.state.players[1].pos };
    stepN(s, 20, { 1: frame({ moveX: 1 }) });
    expect(s.state.players[1].pos).toEqual(p1);
  });

  it('un déplacement est bloqué par les murs et les joueurs ne se bloquent pas entre eux', () => {
    const s = sim(level, 2);
    stepN(s, 600, { 0: frame({ moveX: -1 }), 1: frame({ moveX: -1 }) });
    for (const p of s.state.players) {
      expect(p.pos.x).toBeGreaterThanOrEqual(TILE + PLAYER_RADIUS - 1e-6);
      expect(canOccupy(p.pos, PLAYER_RADIUS, s.grid, s.solidRects())).toBe(true);
    }
    // P2 est derrière P1 (spawn à droite) : il a traversé la même zone sans être gêné
    expect(s.state.players[1].pos.x).toBeLessThan(TILE + PLAYER_RADIUS + 1);
  });

  it('dt invalide : aucun effet', () => {
    const s = sim(level);
    s.step(DT, {});
    const snap = s.serialize();
    expect(s.step(0, {})).toEqual([]);
    expect(s.step(NaN, {})).toEqual([]);
    expect(s.step(-5, {})).toEqual([]);
    expect(s.serialize()).toBe(snap);
  });
});

// ───────────────────────────── Déterminisme et sérialisation ─────────────────────────────

describe('déterminisme et sérialisation', () => {
  const level = mkLevel([arenaRoom('r1')]);

  it('même seed + mêmes entrées ⇒ états JSON identiques à chaque pas', () => {
    const a = sim(level, 3, { seed: 99 });
    const b = sim(level, 3, { seed: 99 });
    const inputsA = randomInputs(3, 7);
    const inputsB = randomInputs(3, 7);
    for (let t = 0; t < 1200; t++) {
      const ea = a.step(DT, inputsA(t));
      const eb = b.step(DT, inputsB(t));
      expect(eb).toEqual(ea);
      if (t % 20 === 0) expect(b.serialize()).toBe(a.serialize());
    }
    expect(b.serialize()).toBe(a.serialize());
  });

  it("une graine différente donne une partie différente", () => {
    const a = sim(level, 2, { seed: 1 });
    const b = sim(level, 2, { seed: 2 });
    const ia = randomInputs(2, 5);
    const ib = randomInputs(2, 5);
    for (let t = 0; t < 600; t++) {
      a.step(DT, ia(t));
      b.step(DT, ib(t));
    }
    expect(b.serialize()).not.toBe(a.serialize());
  });

  it('serialize/restore : la simulation restaurée produit exactement la même suite d’états', () => {
    const a = sim(level, 3, { seed: 5 });
    const inputs = randomInputs(3, 11);
    for (let t = 0; t < 400; t++) a.step(DT, inputs(t));
    const snap = a.serialize();
    const b = GameSimulation.restore(snap, level);
    expect(b.serialize()).toBe(snap);
    // les deux continuent avec les mêmes entrées
    const ia = randomInputs(3, 11);
    const ib = randomInputs(3, 11);
    for (let t = 0; t < 400; t++) {
      ia(t);
      ib(t);
    }
    for (let t = 400; t < 900; t++) {
      a.step(DT, ia(t));
      b.step(DT, ib(t));
      if (t % 25 === 0) expect(b.serialize()).toBe(a.serialize());
    }
    expect(b.serialize()).toBe(a.serialize());
  });

  it('restore rejette un snapshot illisible ou d’un autre niveau', () => {
    const a = sim(level);
    expect(() => GameSimulation.restore('{pas du json', level)).toThrow();
    expect(() => GameSimulation.restore('{}', level)).toThrow();
    const other = makeTestLevel({ id: 'autre', rooms: [mkRoom('r1')], objectives: [] });
    expect(() => GameSimulation.restore(a.serialize(), other)).toThrow();
  });

  it('restore après un changement de salle reconstruit la bonne grille', () => {
    const lv = mkLevel([mkRoom('r1'), mkRoom('r2', { layout: makeTestLayout(16, 10) })]);
    const s = sim(lv);
    teleportToExit(s);
    stepN(s, 130);
    expect(s.state.roomIndex).toBe(1);
    const r = GameSimulation.restore(s.serialize(), lv);
    expect(r.grid.width).toBe(16);
    expect(r.room.id).toBe('r2');
  });

  it("l'état reste du JSON pur (aller-retour strictement identique, sans undefined/NaN)", () => {
    const s = sim(level, 4, { seed: 3 });
    const inputs = randomInputs(4, 21);
    for (let t = 0; t < 900; t++) {
      s.step(DT, inputs(t));
      if (t % 100 === 0) {
        const json = JSON.parse(JSON.stringify(s.state));
        expect(json).toStrictEqual(s.state);
      }
    }
    expect(JSON.parse(JSON.stringify(s.state))).toStrictEqual(s.state);
    expect(s.state.room.enemies.length).toBeGreaterThan(0);
  });
});

// ───────────────────────────── Relevage ─────────────────────────────

describe('relevage', () => {
  const level = mkLevel([mkRoom('r1')]);
  const hold = frame({ moveX: 1, attack: true, interact: true, revive: true });

  it('relevage de bout en bout (≈ 3 s) : sauveteur immobile et sans attaque', () => {
    const s = sim(level, 2);
    killPlayer(s, 1);
    expect(s.state.players[1].status).toBe('down');
    const start = { ...s.state.players[0].pos };
    const events: SimEvent[] = [];
    let revivedAt = -1;
    for (let i = 0; i < 230 && revivedAt < 0; i++) {
      const ev = s.step(DT, { 0: hold });
      events.push(...ev);
      if (ev.some((e) => e.type === 'playerRevived')) revivedAt = i + 1;
      if (revivedAt < 0) {
        expect(s.state.players[0].pos).toEqual(start);
        expect(s.state.players[0].moving).toBe(false);
      }
    }
    const expectedSteps = REVIVE_DURATION_MS / DT;
    expect(revivedAt).toBeGreaterThanOrEqual(Math.floor(expectedSteps) - 1);
    expect(revivedAt).toBeLessThanOrEqual(Math.ceil(expectedSteps) + 2);
    expect(types(events)).toContain('reviveStarted');
    expect(types(events)).not.toContain('playerAttack');
    const p1 = s.state.players[1];
    expect(p1.status).toBe('alive');
    expect(p1.hp).toBe(p1.maxHp);
    expect(s.state.players[0].revivingId).toBeNull();
    // une fois relevé, le sauveteur qui tient toujours la touche peut de nouveau bouger
    stepN(s, 10, { 0: frame({ moveX: 1 }) });
    expect(s.state.players[0].pos.x).toBeGreaterThan(start.x);
  });

  it('Valentine relève plus vite (reviveTimeMult 0.65)', () => {
    const s = sim(level, 1, {
      players: [
        { id: 0, characterId: 'valentine', difficulty: 2 },
        { id: 1, characterId: 'david', difficulty: 2 },
      ],
    });
    killPlayer(s, 1);
    let steps = 0;
    while (s.state.players[1].status === 'down' && steps < 400) {
      s.step(DT, { 0: frame({ revive: true }) });
      steps++;
    }
    expect(steps * DT).toBeGreaterThan(REVIVE_DURATION_MS * 0.65 - 40);
    expect(steps * DT).toBeLessThan(REVIVE_DURATION_MS * 0.65 + 60);
  });

  it('un sauveteur qui tombe à terre interrompt le relevage (progression remise à zéro)', () => {
    const s = sim(level, 3);
    killPlayer(s, 1);
    const ev0 = stepN(s, 60, { 0: hold });
    expect(types(ev0)).toContain('reviveStarted');
    expect(s.state.players[1].reviveProgressMs).toBeGreaterThan(900);
    killPlayer(s, 0);
    const ev = s.step(DT, { 0: hold });
    const interrupted = ev.find((e) => e.type === 'reviveInterrupted');
    expect(interrupted).toEqual({ type: 'reviveInterrupted', reviverId: 0, targetId: 1, reason: 'reviverDown' });
    expect(s.state.players[1].reviveProgressMs).toBe(0);
    expect(s.state.players[1].status).toBe('down');
    expect(s.state.phase).toBe('playing'); // J3 est encore debout
  });

  it('relâcher la touche interrompt le relevage', () => {
    const s = sim(level, 2);
    killPlayer(s, 1);
    stepN(s, 30, { 0: hold });
    const ev = s.step(DT, { 0: frame() });
    expect(ev).toContainEqual({ type: 'reviveInterrupted', reviverId: 0, targetId: 1, reason: 'released' });
    expect(s.state.players[1].reviveProgressMs).toBe(0);
  });

  it('le relevage est prioritaire sur une interaction à portée', () => {
    const lv = mkLevel([mkRoom('r1', { mechanisms: [{ id: 'lv', type: 'lever', tile: [3, 2] }, { id: 'p1', type: 'plate', tile: [6, 6] }] })]);
    const s = sim(lv, 2);
    killPlayer(s, 1);
    const ev = s.step(DT, { 0: frame({ interact: true, attack: true, revive: true }) });
    expect(types(ev)).toContain('reviveStarted');
    expect(s.state.room.mechanisms.find((m) => m.id === 'lv')!.active).toBe(false);
    expect(types(ev)).not.toContain('playerAttack');
  });

  it("un joueur à terre n'est jamais achevé (projectiles ennemis ignorés) et ne bloque pas les tirs", () => {
    const s = sim(level, 2);
    killPlayer(s, 1);
    const p1 = s.state.players[1];
    const hpBefore = p1.hp;
    addEnemyProjectile(s, p1.pos.x - 20, p1.pos.y, 100, 0, 30);
    const ev = stepN(s, 60);
    expect(p1.hp).toBe(hpBefore);
    expect(p1.status).toBe('down');
    expect(ev.some((e) => e.type === 'playerHit' && e.playerId === 1)).toBe(false);
    expect(p1.downCount).toBe(1);
  });
});

// ───────────────────────────── Mort d'équipe ─────────────────────────────

describe("mort d'équipe", () => {
  const rooms = (): RoomDef[] => [
    mkRoom('r1'),
    mkRoom('r2', {
      enemies: [{ kind: 'skeleton', tile: [9, 1] }],
      mechanisms: [{ id: 'p1', type: 'plate', tile: [6, 4] }],
    }),
  ];

  it('tous à terre ⇒ teamWipe, phase wipe puis redémarrage de LA salle courante, salles validées conservées', () => {
    const level = mkLevel(rooms());
    const s = sim(level, 2);
    teleportToExit(s);
    stepN(s, Math.ceil(ROOM_CLEAR_DELAY_MS / DT) + 5);
    expect(s.state.roomIndex).toBe(1);
    expect(s.state.clearedRooms).toEqual(['r1']);

    // salle 2 : une plaque pressée, des PV perdus, des kills
    s.state.players[0].pos = tileCenterOf([6, 4]);
    stepN(s, 3);
    expect(s.state.room.mechanisms[0].active).toBe(true);
    s.state.players[0].kills = 4;
    s.state.room.enemies[0].hp = 5;

    killPlayer(s, 0);
    expect(s.state.phase).toBe('playing'); // J2 encore debout
    killPlayer(s, 1);
    const ev = s.step(DT, {});
    expect(types(ev)).toContain('teamWipe');
    expect(s.state.phase).toBe('wipe');

    // pendant le wipe, rien ne bouge côté dégâts et le relevage est impossible
    const ev2 = stepN(s, Math.floor(WIPE_RESTART_DELAY_MS / DT) - 5);
    expect(types(ev2)).not.toContain('roomEntered');
    expect(s.state.phase).toBe('wipe');

    const ev3 = stepN(s, 10);
    expect(ev3).toContainEqual({ type: 'roomEntered', roomId: 'r2', roomIndex: 1, reason: 'restart' });
    expect(s.state.phase).toBe('playing');
    expect(s.state.roomIndex).toBe(1);
    expect(s.state.clearedRooms).toEqual(['r1']);
    s.state.players.forEach((p, i) => {
      expect(p.status).toBe('alive');
      expect(p.hp).toBe(p.maxHp);
      expect(p.kills).toBe(0);
      expect(p.invulnMs).toBeGreaterThan(0);
      expect(p.invulnMs).toBeLessThanOrEqual(ROOM_ENTER_INVULN_MS);
      const sp = level.rooms[1].playerSpawns[i];
      expect(Math.abs(p.pos.x - tileCenterOf(sp).x)).toBeLessThan(2);
    });
    expect(s.state.room.mechanisms[0].active).toBe(false);
    expect(s.state.room.enemies.length).toBe(1);
    expect(s.state.room.enemies[0].hp).toBe(s.state.room.enemies[0].maxHp);
    expect(s.state.room.spawnedSpawnIdx).toEqual([0]);
  });

  it('en solo, un seul joueur à terre = défaite puis redémarrage automatique', () => {
    const level = mkLevel(rooms());
    const s = sim(level, 1);
    killPlayer(s, 0);
    const ev = s.step(DT, {});
    expect(types(ev)).toContain('teamWipe');
    const ev2 = stepN(s, Math.ceil(WIPE_RESTART_DELAY_MS / DT) + 2);
    expect(ev2.some((e) => e.type === 'roomEntered' && e.reason === 'restart')).toBe(true);
    expect(s.state.players[0].status).toBe('alive');
    expect(s.state.roomIndex).toBe(0);
  });

  it('teamWipe est émis une seule fois', () => {
    const s = sim(mkLevel(rooms()), 2);
    killPlayer(s, 0);
    killPlayer(s, 1);
    const all = stepN(s, 200);
    expect(all.filter((e) => e.type === 'teamWipe').length).toBe(1);
  });

  it("les objectifs non accomplis de la salle sont remis à zéro, les accomplis conservés", () => {
    const level = mkLevel(rooms(), [
      { id: 'z', slot: 0, roomId: 'r2', kind: 'zone', labelKey: 'objective.test.z', zoneId: 'zone', seconds: 5 },
      { id: 'done', slot: 1, roomId: 'r1', kind: 'mechanism', labelKey: 'objective.test.d', mechanismId: 'p1' },
    ]);
    level.rooms[1].zones = [{ id: 'zone', rect: { x: 1, y: 1, w: 4, h: 4 } }];
    const s = sim(level, 2);
    s.state.objectives[1].done = true;
    teleportToExit(s);
    stepN(s, Math.ceil(ROOM_CLEAR_DELAY_MS / DT) + 5);
    expect(s.state.roomIndex).toBe(1);
    stepN(s, 60, {}); // J1 est dans la zone de spawn [2,2] : progression de l'objectif de zone
    expect(s.state.objectives[0].progress).toBeGreaterThan(0.1);
    killPlayer(s, 0);
    killPlayer(s, 1);
    stepN(s, Math.ceil(WIPE_RESTART_DELAY_MS / DT) + 5);
    expect(s.state.objectives[0].progress).toBeLessThan(0.05);
    expect(s.state.objectives[1].done).toBe(true);
  });
});

// ───────────────────────────── Difficulté par joueur ─────────────────────────────

describe('difficulté par joueur', () => {
  const level = mkLevel([mkRoom('r1')]);
  const duo: PlayerSetup[] = [
    { id: 0, characterId: 'david', difficulty: 1 },
    { id: 1, characterId: 'david', difficulty: 3 },
  ];

  it('un même coup d’ennemi inflige des dégâts différents selon la difficulté du joueur touché, à PV max identiques', () => {
    const s = sim(level, 2, { players: duo });
    const [p0, p1] = s.state.players;
    expect(p0.maxHp).toBe(p1.maxHp);
    p0.pos = { x: 40, y: 60 };
    p1.pos = { x: 40, y: 100 };
    addEnemyProjectile(s, 20, 60, 120, 0, 20);
    addEnemyProjectile(s, 20, 100, 120, 0, 20);
    const ev = stepN(s, 40);
    const david = getCharacter('david');
    expect(p0.maxHp - p0.hp).toBe(damageToPlayer(20, david, 1));
    expect(p1.maxHp - p1.hp).toBe(damageToPlayer(20, david, 3));
    expect(p1.maxHp - p1.hp).toBeGreaterThan(p0.maxHp - p0.hp);
    const hits = ev.filter((e): e is Extract<SimEvent, { type: 'playerHit' }> => e.type === 'playerHit');
    expect(hits.map((h) => h.damage).sort((a, b) => a - b)).toEqual(
      [damageToPlayer(20, david, 1), damageToPlayer(20, david, 3)].sort((a, b) => a - b),
    );
  });

  it('les dégâts infligés à un ennemi dépendent de la difficulté de l’attaquant', () => {
    const s = sim(level, 2, { players: duo });
    const [p0, p1] = s.state.players;
    p0.pos = { x: 40, y: 40 };
    p0.facing = 'right';
    p1.pos = { x: 40, y: 100 };
    p1.facing = 'right';
    const e0 = addStaticEnemy(s, 'knight', 60, 40);
    const e1 = addStaticEnemy(s, 'knight', 60, 100);
    s.step(DT, { 0: frame({ attack: true }), 1: frame({ attack: true }) });
    const raw = playerBaseDamage(getCharacter('david'));
    const hp = (id: number): number => s.state.room.enemies.find((e) => e.id === id)!.hp;
    expect(90 - hp(e0)).toBeCloseTo(damageToEnemy(raw, 1), 9);
    expect(90 - hp(e1)).toBeCloseTo(damageToEnemy(raw, 3), 9);
    expect(90 - hp(e0)).toBeGreaterThan(90 - hp(e1));
  });

  it('la difficulté ne change ni le nombre d’ennemis ni les PV max des ennemis', () => {
    const lv = mkLevel([mkRoom('r1', { enemies: [{ kind: 'knight', tile: [9, 1] }, { kind: 'slime', tile: [9, 2] }] })]);
    const easy = sim(lv, 1, { players: [{ id: 0, characterId: 'david', difficulty: 1 }] });
    const hard = sim(lv, 1, { players: [{ id: 0, characterId: 'david', difficulty: 3 }] });
    expect(easy.state.room.enemies.map((e) => [e.kind, e.maxHp])).toEqual(hard.state.room.enemies.map((e) => [e.kind, e.maxHp]));
  });
});

// ───────────────────────────── Mécanismes et coop adaptative ─────────────────────────────

describe('mécanismes coopératifs', () => {
  const doorRoom = (spawns: TileXY[], extra: Partial<RoomDef> = {}): RoomDef =>
    mkRoom('r1', {
      playerSpawns: spawns,
      mechanisms: [
        { id: 'pa', type: 'plate', tile: [4, 2] },
        { id: 'pb', type: 'plate', tile: [4, 5], minPlayers: 2 },
        { id: 'd1', type: 'door', tiles: [[8, 3]], requires: ['pa', 'pb'] },
      ] as MechanismDef[],
      ...extra,
    });
  const doorOf = (s: GameSimulation) => s.state.room.mechanisms.find((m) => m.id === 'd1')!;

  it('deux plaques occupées simultanément ouvrent une porte', () => {
    const s = sim(mkLevel([doorRoom([[4, 2], [4, 5], [2, 2], [2, 3]])]), 2);
    expect(doorOf(s).active).toBe(false);
    expect(s.solidRects().length).toBe(1);
    const ev = s.step(DT, {});
    expect(types(ev)).toContain('doorOpened');
    expect(doorOf(s).active).toBe(true);
    expect(s.solidRects().length).toBe(0);
  });

  it('une seule plaque occupée (à 2 joueurs) ne suffit pas', () => {
    const s = sim(mkLevel([doorRoom([[4, 2], [2, 5], [2, 2], [2, 3]])]), 2);
    stepN(s, 60);
    expect(doorOf(s).active).toBe(false);
    expect(s.solidRects().length).toBe(1);
    // le deuxième joueur rejoint la plaque B : la porte s'ouvre
    s.state.players[1].pos = tileCenterOf([4, 5]);
    const ev = stepN(s, 2);
    expect(types(ev)).toContain('doorOpened');
  });

  it('coop adaptative : à 1 joueur la plaque minPlayers=2 est ignorée et la plaque A suffit', () => {
    const s = sim(mkLevel([doorRoom([[4, 2], [4, 5], [2, 2], [2, 3]])]), 1);
    expect(s.state.room.mechanisms.find((m) => m.id === 'pb')!.waived).toBe(true);
    const ev = s.step(DT, {});
    expect(types(ev)).toContain('doorOpened');
    expect(s.solidRects().length).toBe(0);
  });

  it('les portes fermées arrêtent les joueurs', () => {
    const lv = mkLevel([
      mkRoom('r1', {
        mechanisms: [
          { id: 'p1', type: 'plate', tile: [2, 6] },
          { id: 'd1', type: 'door', tiles: [[5, 1], [5, 2], [5, 3], [5, 4], [5, 5], [5, 6]], requires: ['p1'] },
        ],
      }),
    ]);
    const s = sim(lv, 1);
    s.state.players[0].pos = tileCenterOf([3, 3]);
    stepN(s, 200, { 0: frame({ moveX: 1 }) });
    expect(s.state.players[0].pos.x).toBeLessThanOrEqual(5 * TILE - PLAYER_RADIUS + 1e-6);
  });

  it('deux joueurs poussent un bloc (intégration mouvement + mécanismes)', () => {
    const lv = mkLevel([
      mkRoom('r1', {
        layout: makeTestLayout(16, 10),
        playerSpawns: [[2, 2], [2, 3], [3, 2], [3, 3]],
        mechanisms: [{ id: 'b1', type: 'block', tile: [5, 2] }, { id: 'p1', type: 'plate', tile: [12, 7] }],
      }),
    ]);
    const s = sim(lv, 2);
    s.state.players[0].pos = { x: 75, y: 40 };
    s.state.players[1].pos = { x: 75, y: 56 };
    stepN(s, 90, { 0: frame({ moveX: 1 }), 1: frame({ moveX: 1 }) });
    const block = s.state.room.mechanisms.find((m) => m.id === 'b1')!;
    expect(block.type === 'block' && block.tile[0]).toBeGreaterThanOrEqual(6);
  });

  it('un levier est actionné par le front montant de interact ; l’attaque est supprimée tant qu’une interaction est possible', () => {
    const lv = mkLevel([mkRoom('r1', { mechanisms: [{ id: 'lv', type: 'lever', tile: [3, 2] }, { id: 'p1', type: 'plate', tile: [6, 6] }] })]);
    const s = sim(lv, 1);
    const ev = s.step(DT, { 0: frame({ interact: true, attack: true }) });
    expect(s.state.room.mechanisms.find((m) => m.id === 'lv')!.active).toBe(true);
    expect(types(ev)).toContain('mechanismChanged');
    expect(types(ev)).not.toContain('playerAttack');

    // attaque sans interaction (A seul, sans autre ordre) : attaque normalement même près d'un levier
    const s2 = sim(lv, 1);
    const ev2 = s2.step(DT, { 0: frame({ attack: true }) });
    expect(types(ev2)).toContain('playerAttack');
    expect(s2.state.room.mechanisms.find((m) => m.id === 'lv')!.active).toBe(false);
  });

  it('interact maintenu ne réactive pas en boucle (front montant uniquement)', () => {
    const lv = mkLevel([mkRoom('r1', { mechanisms: [{ id: 'lv', type: 'lever', tile: [3, 2], windowMs: 200 }, { id: 'p1', type: 'plate', tile: [6, 6] }] })]);
    const s = sim(lv, 1);
    const events = stepN(s, 60, { 0: frame({ interact: true }) });
    expect(events.filter((e) => e.type === 'mechanismChanged' && e.active).length).toBe(1);
  });
});

// ───────────────────────────── Ennemis : vagues, 'clear' ─────────────────────────────

describe('apparitions et jeton clear', () => {
  const waveRoom = (): RoomDef =>
    mkRoom('r1', {
      enemies: [
        { kind: 'slime', tile: [9, 1], wave: 0 },
        { kind: 'slime', tile: [10, 1], wave: 0, minPlayers: 2 },
        { kind: 'skeleton', tile: [9, 6], wave: 1 },
      ],
      mechanisms: [
        { id: 'p1', type: 'plate', tile: [6, 6] },
        { id: 'd1', type: 'door', tiles: [[6, 1]], requires: ['clear'] },
      ],
    });
  const door = (s: GameSimulation) => s.state.room.mechanisms.find((m) => m.id === 'd1')!;

  it('vagues successives, minPlayers et jeton clear (les apparitions en attente comptent)', () => {
    const s = sim(mkLevel([waveRoom()]), 1);
    expect(s.state.room.enemies.map((e) => e.kind)).toEqual(['slime']); // minPlayers 2 absent, vague 1 en attente
    stepN(s, 5);
    expect(door(s).active).toBe(false);
    expect(s.state.room.enemies.length).toBe(1);

    s.state.room.enemies[0].hp = 0; // vague 0 vaincue
    const ev = s.step(DT, {});
    expect(types(ev)).toContain('enemyDied');
    expect(ev.some((e) => e.type === 'enemySpawned' && e.kind === 'skeleton')).toBe(true);
    expect(s.state.room.enemies.map((e) => e.kind)).toEqual(['skeleton']);
    expect(door(s).active).toBe(false); // le jeton clear n'est pas satisfait : la vague 1 vient d'apparaître

    stepN(s, 30);
    expect(door(s).active).toBe(false);
    s.state.room.enemies[0].hp = 0;
    const ev2 = s.step(DT, {});
    expect(types(ev2)).toContain('doorOpened');
    expect(door(s).active).toBe(true);
    expect(s.state.room.enemies.length).toBe(0);

    // chaque apparition n'a lieu qu'une fois
    stepN(s, 120);
    expect(s.state.room.enemies.length).toBe(0);
    expect(s.state.room.spawnedSpawnIdx.slice().sort()).toEqual([0, 2]);
  });

  it('à 2 joueurs l’ennemi minPlayers=2 apparaît dès le départ', () => {
    const s = sim(mkLevel([waveRoom()]), 2);
    expect(s.state.room.enemies.length).toBe(2);
  });

  it("une vague k n'apparaît qu'après la mort de TOUS les ennemis des vagues précédentes", () => {
    const s = sim(mkLevel([waveRoom()]), 2);
    s.state.room.enemies[0].hp = 0;
    stepN(s, 5);
    expect(s.state.room.enemies.some((e) => e.kind === 'skeleton')).toBe(false);
    s.state.room.enemies[0].hp = 0;
    stepN(s, 2);
    expect(s.state.room.enemies.some((e) => e.kind === 'skeleton')).toBe(true);
  });

  it("l'apparition conditionnée par `when` attend que le mécanisme soit actif", () => {
    const room = mkRoom('r1', {
      enemies: [{ kind: 'slime', tile: [9, 1], when: 'p1' }],
      mechanisms: [{ id: 'p1', type: 'plate', tile: [4, 4] }],
    });
    const s = sim(mkLevel([room]), 1);
    expect(s.state.room.enemies.length).toBe(0);
    stepN(s, 10);
    expect(s.state.room.enemies.length).toBe(0);
    s.state.players[0].pos = tileCenterOf([4, 4]);
    stepN(s, 3);
    expect(s.state.room.enemies.length).toBe(1);
  });

  it('plafonne le nombre d’ennemis vivants (MAX_ALIVE_ENEMIES)', () => {
    const many: EnemySpawnDef[] = [];
    for (let i = 0; i < 60; i++) many.push({ kind: 'slime', tile: [1 + (i % 10), 1 + Math.floor(i / 10)] });
    const s = sim(mkLevel([mkRoom('r1', { layout: makeTestLayout(14, 12), enemies: many })]), 1);
    stepN(s, 10);
    expect(s.state.room.enemies.length).toBeLessThanOrEqual(MAX_ALIVE_ENEMIES);
  });
});

// ───────────────────────────── Combat via la simulation ─────────────────────────────

describe('combat via la simulation', () => {
  it('un projectile joueur tue un ennemi, incrémente kills et valide un objectif kills', () => {
    const level = mkLevel(
      [mkRoom('r1')],
      [{ id: 'k1', slot: 0, roomId: 'r1', kind: 'kills', labelKey: 'objective.test.k1', count: 1, enemyKind: 'slime' }],
    );
    const s = sim(level, 1, { players: [{ id: 0, characterId: 'sandrine', difficulty: 1 }] });
    s.state.players[0].facing = 'right';
    const enemyId = addStaticEnemy(s, 'slime', 104, 40);
    const events = [...s.step(DT, { 0: frame({ attack: true }) })];
    events.push(...stepN(s, 40));
    expect(types(events)).toContain('projectileFired');
    const died = events.find((e) => e.type === 'enemyDied');
    expect(died).toMatchObject({ type: 'enemyDied', enemyId, kind: 'slime', byPlayer: 0 });
    expect(s.state.players[0].kills).toBe(1);
    expect(s.state.objectives[0].done).toBe(true);
    expect(events).toContainEqual({ type: 'objectiveCompleted', objectiveId: 'k1', playerId: 0 });
    expect(s.state.room.enemies.some((e) => e.id === enemyId)).toBe(false);
  });

  it("l'attribution des kills suit l'auteur du coup fatal", () => {
    const level = mkLevel([mkRoom('r1')]);
    const s = sim(level, 2, { players: [{ id: 0, characterId: 'david', difficulty: 2 }, { id: 1, characterId: 'grok', difficulty: 2 }] });
    const [p0, p1] = s.state.players;
    p0.pos = { x: 40, y: 100 };
    p1.pos = { x: 40, y: 40 };
    p1.facing = 'right';
    addStaticEnemy(s, 'bat', 56, 40);
    const ev = s.step(DT, { 1: frame({ attack: true }) });
    expect(ev.find((e) => e.type === 'enemyDied')).toMatchObject({ byPlayer: 1 });
    expect(p0.kills).toBe(0);
    expect(p1.kills).toBe(1);
  });

  it("l'ennemi tiré par le sol touche un joueur vivant par ses projectiles (playerHit) et la mort d'équipe est détectée", () => {
    const s = sim(mkLevel([mkRoom('r1')]), 1);
    const p = s.state.players[0];
    p.hp = 1;
    p.invulnMs = 0;
    addEnemyProjectile(s, p.pos.x - 20, p.pos.y, 100, 0, 30);
    const ev = stepN(s, 30);
    expect(types(ev)).toEqual(expect.arrayContaining(['playerHit', 'playerDown', 'teamWipe']));
    expect(s.state.phase).toBe('wipe');
  });

  it("en phase roomCleared, plus aucun dégât ni attaque", () => {
    const level = mkLevel([mkRoom('r1'), mkRoom('r2')]);
    const s = sim(level, 1);
    teleportToExit(s);
    s.step(DT, {});
    expect(s.state.phase).toBe('roomCleared');
    const p = s.state.players[0];
    addEnemyProjectile(s, p.pos.x - 20, p.pos.y, 100, 0, 30);
    const ev = stepN(s, 30, { 0: frame({ attack: true }) });
    expect(p.hp).toBe(p.maxHp);
    expect(types(ev)).not.toContain('playerHit');
    expect(types(ev)).not.toContain('playerAttack');
  });
});

describe('IA ennemie via la simulation', () => {
  it("un ennemi qui attaque blesse le joueur visé mais n'achève jamais un joueur à terre pris dans la zone", () => {
    const level = mkLevel([mkRoom('r1')]);
    const s = sim(level, 2);
    const [p0, p1] = s.state.players;
    p0.pos = { x: 40, y: 40 };
    p1.pos = { x: 50, y: 40 };
    killPlayer(s, 0);
    const id = s.state.nextEntityId++;
    s.state.room.enemies.push(createEnemyState('skeleton', { x: 64, y: 40 }, id, 0));
    const events = stepN(s, 400);
    const hits = events.filter((e): e is Extract<SimEvent, { type: 'playerHit' }> => e.type === 'playerHit');
    expect(hits.some((h) => h.playerId === 1)).toBe(true);
    expect(hits.some((h) => h.playerId === 0)).toBe(false);
    expect(p0.hp).toBe(0);
    expect(p0.status).toBe('down');
    expect(p0.downCount).toBe(1);
    expect(p1.hp).toBeLessThan(p1.maxHp);
  });

  it('un boss affaibli invoque des sbires (vague -1) qui comptent pour le jeton clear, sans dépasser la limite', () => {
    const room = mkRoom('r1', {
      layout: makeTestLayout(30, 20),
      enemies: [{ kind: 'golem', tile: [15, 10] }],
      mechanisms: [{ id: 'p1', type: 'plate', tile: [3, 3] }, { id: 'd1', type: 'door', tiles: [[2, 10]], requires: ['clear'] }],
    });
    const s = sim(mkLevel([room]), 1);
    s.state.players[0].pos = { x: 15 * TILE - 100, y: 10 * TILE };
    s.state.room.enemies[0].hp = s.state.room.enemies[0].maxHp * 0.3;
    let summons = 0;
    for (let i = 0; i < 12000 && summons === 0; i++) {
      s.state.players[0].hp = s.state.players[0].maxHp;
      s.state.players[0].invulnMs = 1000;
      s.step(DT, {});
      summons = s.state.room.enemies.filter((e) => e.wave === -1).length;
    }
    expect(summons).toBeGreaterThan(0);
    expect(s.state.room.enemies.length).toBeLessThanOrEqual(MAX_ALIVE_ENEMIES);
    for (const e of s.state.room.enemies) e.hp = 0;
    stepN(s, 2);
    expect(s.state.room.mechanisms.find((m) => m.id === 'd1')!.active).toBe(true);
  });
});

// ───────────────────────────── Sortie de salle, fin de niveau ─────────────────────────────

describe('sortie de salle et fin de niveau', () => {
  it('change de salle quand tous les joueurs vivants sont dans la sortie, puis charge la suivante', () => {
    const level = mkLevel([mkRoom('r1'), mkRoom('r2', { layout: makeTestLayout(14, 9) })]);
    const s = sim(level, 2);
    teleportToExit(s, [0]);
    stepN(s, 10);
    expect(s.state.phase).toBe('playing'); // J2 pas encore dans la sortie
    teleportToExit(s);
    const ev = s.step(DT, {});
    expect(types(ev)).toContain('roomCleared');
    expect(s.state.phase).toBe('roomCleared');
    expect(s.state.clearedRooms).toEqual(['r1']);
    const ev2 = stepN(s, Math.ceil(ROOM_CLEAR_DELAY_MS / DT) + 2);
    expect(ev2).toContainEqual({ type: 'roomEntered', roomId: 'r2', roomIndex: 1, reason: 'next' });
    expect(s.state.phase).toBe('playing');
    expect(s.room.id).toBe('r2');
    expect(s.grid.width).toBe(14);
    s.state.players.forEach((p, i) => {
      expect(p.pos).toEqual(tileCenterOf(level.rooms[1].playerSpawns[i]));
    });
  });

  it('les joueurs à terre sont relevés d’office à PV pleins au changement de salle ; les vivants gardent leurs PV ; clés vidées', () => {
    const level = mkLevel([mkRoom('r1'), mkRoom('r2')]);
    const s = sim(level, 3);
    killPlayer(s, 1);
    s.state.players[2].hp = 10;
    s.state.players[0].keys.push('k');
    teleportToExit(s, [0, 2]); // J2 est à terre : seuls les vivants comptent
    stepN(s, Math.ceil(ROOM_CLEAR_DELAY_MS / DT) + 5);
    expect(s.state.roomIndex).toBe(1);
    const [p0, p1, p2] = s.state.players;
    expect(p1.status).toBe('alive');
    expect(p1.hp).toBe(p1.maxHp);
    expect(p2.hp).toBe(10);
    expect(p0.keys).toEqual([]);
    expect(p1.reviverId).toBeNull();
    expect(p1.invulnMs).toBeGreaterThan(0);
  });

  it('la sortie exige ses `requires` (porte/levier) en plus de la présence des joueurs', () => {
    const room = mkRoom('r1', {
      mechanisms: [{ id: 'lv', type: 'lever', tile: [3, 2] }, { id: 'p1', type: 'plate', tile: [6, 6] }],
      exit: { rect: { x: 9, y: 5, w: 2, h: 2 }, requires: ['lv'] },
    });
    const level = mkLevel([room, mkRoom('r2')]);
    const s = sim(level, 1);
    teleportToExit(s);
    stepN(s, 10);
    expect(s.state.phase).toBe('playing');
    expect(s.isExitOpen()).toBe(false);
    s.state.room.mechanisms[0].active = true;
    expect(s.isExitOpen()).toBe(true);
    s.step(DT, {});
    expect(s.state.phase).toBe('roomCleared');
  });

  it('salle finale : phase levelComplete, événement levelCompleted (une seule fois)', () => {
    const level = mkLevel([mkRoom('r1'), mkRoom('r2')]);
    const s = sim(level, 2);
    teleportToExit(s);
    stepN(s, Math.ceil(ROOM_CLEAR_DELAY_MS / DT) + 5);
    expect(s.state.roomIndex).toBe(1);
    teleportToExit(s);
    const ev = stepN(s, 5);
    expect(types(ev)).toContain('roomCleared');
    expect(ev.filter((e) => e.type === 'levelCompleted')).toEqual([{ type: 'levelCompleted', levelId: 'test' }]);
    expect(s.state.phase).toBe('levelComplete');
    expect(s.state.clearedRooms).toEqual(['r1', 'r2']);
    const more = stepN(s, 300);
    expect(types(more)).not.toContain('levelCompleted');
    expect(s.state.phase).toBe('levelComplete');
  });

  it('la sortie finale exige que tous les objectifs soient accomplis', () => {
    const level = mkLevel(
      [mkRoom('r1')],
      [{ id: 'o', slot: 0, roomId: 'r1', kind: 'zone', zoneId: 'inexistante', seconds: 5, labelKey: 'objective.test.o' }],
    );
    const s = sim(level, 1);
    teleportToExit(s);
    stepN(s, 10);
    expect(s.state.phase).toBe('playing');
    expect(s.isExitOpen()).toBe(false);
    s.state.objectives[0].done = true;
    stepN(s, 2);
    expect(s.state.phase).toBe('levelComplete');
  });

  it('tous les joueurs vivants dans la sortie avec un seul survivant : suffit (joueurs à terre ignorés)', () => {
    const level = mkLevel([mkRoom('r1'), mkRoom('r2')]);
    const s = sim(level, 2);
    killPlayer(s, 1);
    teleportToExit(s, [0]);
    s.step(DT, {});
    expect(s.state.phase).toBe('roomCleared');
  });
});

// ───────────────────────────── Robustesse (fuzz) ─────────────────────────────

describe('fuzz déterministe', () => {
  for (const n of [1, 2, 3, 4]) {
    it(`5000 pas d'entrées aléatoires à ${n} joueur(s) : aucun NaN, invariants respectés`, () => {
      const level = mkLevel([arenaRoom('r1'), arenaRoom('r2')]);
      const characters: CharacterId[] = ['david', 'sandrine', 'valentine', 'mira'];
      const s = sim(level, n, {
        seed: 1000 + n,
        players: Array.from({ length: n }, (_, i) => ({
          id: i as PlayerId,
          characterId: characters[i],
          difficulty: ((i % 3) + 1) as Difficulty,
        })),
      });
      const inputs = randomInputs(n, 42 + n);
      const seen = new Set<string>();
      for (let t = 0; t < 5000; t++) {
        // perturbations : chutes d'alliés (relevages) puis mort d'équipe (redémarrage de salle)
        if (t === 700) for (let i = 0; i < n - 1; i++) killPlayer(s, i);
        if (t === 2500) for (let i = 0; i < n; i++) killPlayer(s, i);
        const ev = s.step(DT, inputs(t));
        for (const e of ev) seen.add(e.type);
        if (t % 7 === 0) {
          const bad = allFinite(s.state);
          if (bad) throw new Error(`NaN/Infinity à t=${t} : ${bad}`);
        }
        for (const p of s.state.players) {
          expect(p.hp).toBeGreaterThanOrEqual(0);
          expect(p.hp).toBeLessThanOrEqual(p.maxHp);
          if (p.status === 'alive') expect(canOccupy(p.pos, PLAYER_RADIUS, s.grid, s.solidRects())).toBe(true);
        }
        expect(s.state.room.enemies.length).toBeLessThanOrEqual(MAX_ALIVE_ENEMIES);
        expect(s.state.room.projectiles.length).toBeLessThanOrEqual(200);
      }
      expect(allFinite(s.state)).toBeNull();
      expect(JSON.parse(s.serialize())).toStrictEqual(s.state);
      // la partie a réellement « vécu » : combats, chutes, redémarrages
      expect(seen.has('playerAttack') || seen.has('projectileFired')).toBe(true);
      expect([...seen]).toContain('enemyHit');
      expect([...seen]).toContain('teamWipe');
      expect([...seen]).toContain('roomEntered');
    });
  }
});

describe('régressions : arbitrage du bouton d\'action et spéciaux en salle de boss', () => {
  it('bouton d\'action maintenu près d\'un levier : continue d\'attaquer ; un nouvel appui actionne le levier sans attaquer', () => {
    const lv = mkLevel([mkRoom('r1', { mechanisms: [{ id: 'lv', type: 'lever', tile: [3, 2] }] })]);
    const s = sim(lv, 1, { players: [{ id: 0, characterId: 'sandrine', difficulty: 2 }] });
    const p = s.state.players[0];
    // maintenu avant d'arriver à portée : l'entrée dans la portée n'est pas un appui
    p.pos = { x: tileCenterOf([3, 2]).x + 60, y: tileCenterOf([3, 2]).y };
    p.facing = 'left';
    const hold = frame({ attack: true, interact: true });
    stepN(s, 2, { 0: hold });
    p.pos = { x: tileCenterOf([3, 2]).x + 4, y: tileCenterOf([3, 2]).y };
    const ev = stepN(s, 60, { 0: hold });
    expect(types(ev)).toContain('playerAttack');
    expect(s.state.room.mechanisms[0].active).toBe(false);
    // relâcher puis réappuyer : levier actionné, pas d'attaque sur ce pas
    stepN(s, 1, { 0: frame() });
    p.attackCooldownMs = 0;
    const ev2 = stepN(s, 1, { 0: hold });
    expect(types(ev2)).not.toContain('playerAttack');
    expect(types(ev2)).toContain('mechanismChanged');
  });

  it('redémarrage d\'une salle de boss : spéciaux à la moitié de la recharge ; autres salles / entrée normale : prêts', () => {
    const lv = mkLevel([
      mkRoom('r1'),
      mkRoom('r2', { enemies: [{ kind: 'golem', tile: [9, 1] }] }),
    ]);
    const s = sim(lv, 2);
    teleportToExit(s);
    stepN(s, Math.ceil(ROOM_CLEAR_DELAY_MS / DT) + 5);
    expect(s.state.roomIndex).toBe(1);
    for (const p of s.state.players) expect(p.specialCooldownMs).toBe(0); // entrée normale
    killPlayer(s, 0);
    killPlayer(s, 1);
    stepN(s, Math.ceil(WIPE_RESTART_DELAY_MS / DT) + 5);
    expect(s.state.roomIndex).toBe(1);
    for (const p of s.state.players) {
      const cd = getCharacter(p.characterId).special?.cooldownMs ?? 0;
      expect(p.specialCooldownMs).toBeGreaterThan(cd / 2 - 100);
      expect(p.specialCooldownMs).toBeLessThanOrEqual(cd / 2);
    }
  });
});
