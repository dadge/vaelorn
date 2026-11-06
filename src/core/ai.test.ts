import { describe, expect, it } from 'vitest';
import { ENEMY_MODES, ENEMY_RENDER_DATA_KEYS, ENEMY_SPECIALS, createEnemyState, onEnemyHit, updateEnemy } from './ai';
import { SIM_STEP_MS } from './constants';
import { ENEMIES, ENEMY_KINDS } from './enemies';
import { angleDiff } from './geometry';
import { createPlayerState } from './players';
import { createRng, nextRandom, randomFn } from './rng';
import type { EnemyAIContext, EnemyKind, EnemyState, PlayerId, PlayerState, ProjectileKind, SimEvent, Vec2 } from './types';

// ───────────────────────────── Faux contexte ─────────────────────────────

interface LoggedProjectile {
  kind: ProjectileKind;
  pos: Vec2;
  vel: Vec2;
  damage: number;
  radius: number;
  lifeMs: number;
  enemyId: number;
}

interface Harness {
  ctx: EnemyAIContext;
  players: PlayerState[];
  enemies: EnemyState[];
  projectiles: LoggedProjectile[];
  circles: { center: Vec2; radius: number; damage: number; enemyId: number; mode: string }[];
  spawns: { kind: EnemyKind; pos: Vec2 }[];
  events: SimEvent[];
  flyingFlags: boolean[];
  /** Mode de l'ennemi avant le pas courant (pour vérifier qui produit des effets). */
  preMode: string;
  step: (enemy: EnemyState) => void;
}

const ROOM_W = 480;
const ROOM_H = 320;

function makePlayer(id: PlayerId, x: number, y: number, status: 'alive' | 'down' = 'alive'): PlayerState {
  const p = createPlayerState({ id, characterId: 'david', difficulty: 2 }, { x, y });
  p.status = status;
  if (status === 'down') p.hp = 0;
  return p;
}

function makeHarness(players: PlayerState[], seed = 1, extra: EnemyState[] = []): Harness {
  const rng = createRng(seed);
  const enemies: EnemyState[] = [...extra];
  let nextId = 1000;
  const h: Harness = {
    ctx: undefined as unknown as EnemyAIContext,
    players,
    enemies,
    projectiles: [],
    circles: [],
    spawns: [],
    events: [],
    flyingFlags: [],
    preMode: 'idle',
    step: () => undefined,
  };
  const free = (p: Vec2, r: number): boolean => p.x >= r && p.x <= ROOM_W - r && p.y >= r && p.y <= ROOM_H - r;
  h.ctx = {
    dtMs: SIM_STEP_MS,
    players,
    enemies,
    random: randomFn(rng),
    canOccupy: (pos, radius) => free(pos, radius),
    moveWithCollision: (pos, delta, radius, flying) => {
      h.flyingFlags.push(flying === true);
      let x = pos.x;
      let y = pos.y;
      if (free({ x: x + delta.x, y }, radius)) x += delta.x;
      if (free({ x, y: y + delta.y }, radius)) y += delta.y;
      return { x, y };
    },
    spawnProjectile: (p) => {
      h.projectiles.push({ ...p, pos: { ...p.pos }, vel: { ...p.vel } });
    },
    spawnEnemy: (kind, pos) => {
      const e = createEnemyState(kind, pos, nextId++, 0);
      enemies.push(e);
      h.spawns.push({ kind, pos: { ...pos } });
      return e.id;
    },
    damageCircle: (center, radius, damage, enemyId) => {
      h.circles.push({ center: { ...center }, radius, damage, enemyId, mode: h.preMode });
    },
    roomBounds: { width: ROOM_W, height: ROOM_H },
    emit: (e) => {
      h.events.push(e);
    },
  };
  h.step = (enemy) => {
    h.preMode = enemy.mode;
    updateEnemy(enemy, h.ctx);
  };
  return h;
}

function allFinite(e: EnemyState): boolean {
  const nums = [e.pos.x, e.pos.y, e.hp, e.maxHp, e.modeTimerMs, e.attackCooldownMs, e.hitFlashMs, e.phase, e.targetId];
  if (!nums.every(Number.isFinite)) return false;
  return Object.values(e.data).every(Number.isFinite);
}

const NORMAL_KINDS: EnemyKind[] = ['slime', 'bat', 'skeleton', 'archer', 'spider', 'wisp', 'knight'];

function spawnAt(kind: EnemyKind, x: number, y: number, id = 1): EnemyState {
  return createEnemyState(kind, { x, y }, id, 0);
}

// ───────────────────────────── Création ─────────────────────────────

describe('createEnemyState', () => {
  it.each(ENEMY_KINDS)('initialise correctement %s', (kind) => {
    const pos = { x: 40, y: 50 };
    const e = createEnemyState(kind, pos, 7, 2);
    expect(e.hp).toBe(ENEMIES[kind].hp);
    expect(e.maxHp).toBe(ENEMIES[kind].hp);
    expect(e.mode).toBe('idle');
    expect(e.phase).toBe(0);
    expect(e.targetId).toBe(-1);
    expect(e.wave).toBe(2);
    expect(e.id).toBe(7);
    expect(e.dead).toBe(false);
    expect(e.pos).toEqual(pos);
    expect(e.pos).not.toBe(pos); // copie
    expect(allFinite(e)).toBe(true);
    expect(JSON.parse(JSON.stringify(e))).toEqual(e); // JSON pur
  });

  it('rejette un type inconnu', () => {
    expect(() => createEnemyState('dragon' as EnemyKind, { x: 0, y: 0 }, 1, 0)).toThrow();
  });
});

describe('documentation exportée pour le rendu', () => {
  it('liste les modes et les clés de data', () => {
    expect([...ENEMY_MODES]).toEqual(['idle', 'chase', 'windup', 'attack', 'recover', 'stunned', 'teleport']);
    expect(ENEMY_RENDER_DATA_KEYS).toContain('special');
    expect(ENEMY_RENDER_DATA_KEYS).toContain('aimAngle');
    expect(ENEMY_SPECIALS.NONE).toBe(0);
  });
});

// ───────────────────────────── Ciblage et poursuite ─────────────────────────────

describe('poursuite', () => {
  const START: Record<string, number> = { slime: 60, bat: 80, skeleton: 80, archer: 120, spider: 90, wisp: 110, knight: 100 };

  it.each(['slime', 'bat', 'skeleton', 'spider', 'knight'] as EnemyKind[])('%s se rapproche d\'un joueur vivant', (kind) => {
    const start = START[kind];
    const player = makePlayer(0, 240 + start, 160);
    const h = makeHarness([player], 3);
    const e = spawnAt(kind, 240, 160);
    let minDist = start;
    for (let i = 0; i < 600; i++) {
      h.step(e);
      minDist = Math.min(minDist, Math.hypot(e.pos.x - player.pos.x, e.pos.y - player.pos.y));
    }
    expect(minDist).toBeLessThan(start * 0.55);
    expect(e.targetId).toBe(0);
  });

  it("l'archer et le feu follet engagent le combat depuis leur portée (ils tirent)", () => {
    for (const kind of ['archer', 'wisp'] as EnemyKind[]) {
      const player = makePlayer(0, 240 + START[kind], 160);
      const h = makeHarness([player], 5);
      const e = spawnAt(kind, 240, 160);
      for (let i = 0; i < 600 && h.projectiles.length === 0; i++) h.step(e);
      expect(h.projectiles.length).toBeGreaterThan(0);
    }
  });

  it('reste en idle hors du rayon d\'aggro', () => {
    for (const kind of NORMAL_KINDS) {
      const player = makePlayer(0, 240 + ENEMIES[kind].aggroRadius + 150, 160);
      const h = makeHarness([player], 9);
      const e = spawnAt(kind, 240, 160);
      for (let i = 0; i < 300; i++) h.step(e);
      expect(e.targetId).toBe(-1);
      expect(e.mode).toBe('idle');
      expect(h.circles).toHaveLength(0);
      expect(h.projectiles).toHaveLength(0);
    }
  });

  it("n'attaque jamais quand aucun joueur n'est vivant", () => {
    for (const kind of NORMAL_KINDS) {
      const players = [makePlayer(0, 250, 160, 'down'), makePlayer(1, 245, 165, 'down')];
      const h = makeHarness(players, 11);
      const e = spawnAt(kind, 240, 160);
      for (let i = 0; i < 900; i++) h.step(e);
      expect(h.circles).toHaveLength(0);
      expect(h.projectiles).toHaveLength(0);
      expect(e.mode).toBe('idle');
      expect(e.targetId).toBe(-1);
    }
  });

  it('ignore un joueur à terre et cible un joueur vivant plus loin', () => {
    const downed = makePlayer(0, 250, 160, 'down');
    const alive = makePlayer(1, 240 + 60, 160);
    const h = makeHarness([downed, alive], 13);
    const e = spawnAt('skeleton', 240, 160);
    for (let i = 0; i < 60; i++) h.step(e);
    expect(e.targetId).toBe(1);
  });

  it('abandonne une attaque en cours si plus aucun joueur vivant', () => {
    const player = makePlayer(0, 262, 160);
    const h = makeHarness([player], 17);
    const e = spawnAt('skeleton', 240, 160);
    for (let i = 0; i < 400 && e.mode !== 'windup'; i++) h.step(e);
    expect(e.mode).toBe('windup');
    player.status = 'down';
    player.hp = 0;
    h.step(e);
    expect(e.mode).toBe('idle');
    for (let i = 0; i < 200; i++) h.step(e);
    expect(h.circles).toHaveLength(0);
  });

  it('change de cible si la cible actuelle tombe à terre', () => {
    const a = makePlayer(0, 270, 160);
    const b = makePlayer(1, 200, 160);
    const h = makeHarness([a, b], 19);
    const e = spawnAt('slime', 240, 160);
    for (let i = 0; i < 5; i++) h.step(e);
    const first = e.targetId;
    const victim = first === 0 ? a : b;
    victim.status = 'down';
    victim.hp = 0;
    h.step(e);
    expect(e.targetId).toBe(first === 0 ? 1 : 0);
  });

  it('les ailes passent le drapeau flying à moveWithCollision (chauve-souris, feu follet), pas le slime', () => {
    const player = makePlayer(0, 300, 160);
    const hb = makeHarness([player], 2);
    const bat = spawnAt('bat', 240, 160);
    for (let i = 0; i < 120; i++) hb.step(bat);
    expect(hb.flyingFlags.length).toBeGreaterThan(0);
    expect(hb.flyingFlags.every(Boolean)).toBe(true);

    const hs = makeHarness([player], 2);
    const slime = spawnAt('slime', 270, 160);
    for (let i = 0; i < 120; i++) hs.step(slime);
    expect(hs.flyingFlags.length).toBeGreaterThan(0);
    expect(hs.flyingFlags.some(Boolean)).toBe(false);
  });
});

// ───────────────────────────── Télégraphe et attaques ─────────────────────────────

describe('télégraphe (windup) avant toute attaque', () => {
  const NEAR: Record<string, number> = { slime: 14, bat: 30, skeleton: 20, archer: 80, spider: 30, wisp: 70, knight: 22 };

  it.each(NORMAL_KINDS)('%s : windup >= 350 ms, puis attack, effets uniquement en attack', (kind) => {
    const player = makePlayer(0, 240 + NEAR[kind], 160);
    const h = makeHarness([player], 23);
    const e = spawnAt(kind, 240, 160);
    let windupSteps = 0;
    let sawAttack = 0;
    let prev = e.mode;
    for (let i = 0; i < 1500 && sawAttack < 2; i++) {
      // Le joueur reste vivant et immobile (on teste le comportement de l'ennemi, pas la survie).
      player.invulnMs = 999;
      const effectsBefore = h.circles.length + h.projectiles.length;
      h.step(e);
      if (h.preMode === 'windup') windupSteps++;
      if (prev === 'windup' && e.mode === 'attack') {
        sawAttack++;
        expect(windupSteps * SIM_STEP_MS).toBeGreaterThanOrEqual(350 - SIM_STEP_MS);
        expect(e.data.windupTotalMs).toBeGreaterThanOrEqual(350);
        windupSteps = 0;
      }
      if (e.mode !== 'windup' && prev !== 'windup') windupSteps = 0;
      // Aucun effet sans être passé par le mode 'attack'.
      if (h.circles.length + h.projectiles.length > effectsBefore) {
        expect(h.preMode).toBe('attack');
      }
      prev = e.mode;
    }
    expect(sawAttack).toBeGreaterThanOrEqual(1);
  });

  it('data.special / aimAngle sont renseignés pendant le windup', () => {
    const player = makePlayer(0, 240 + 30, 160);
    const h = makeHarness([player], 4);
    const e = spawnAt('spider', 240, 160);
    for (let i = 0; i < 300 && e.mode !== 'windup'; i++) h.step(e);
    expect(e.mode).toBe('windup');
    expect(e.data.special).toBe(ENEMY_SPECIALS.LEAP);
    expect(Math.abs(e.data.aimAngle)).toBeLessThan(0.2); // joueur à droite
    expect(e.data.telegraphLength).toBeGreaterThan(20);
  });

  it('squelette : damageCircle devant lui, dans la direction visée', () => {
    const player = makePlayer(0, 240, 160 + 20);
    const h = makeHarness([player], 6);
    const e = spawnAt('skeleton', 240, 160);
    for (let i = 0; i < 600 && h.circles.length === 0; i++) h.step(e);
    expect(h.circles).toHaveLength(1);
    const c = h.circles[0];
    expect(c.center.y).toBeGreaterThan(e.pos.y); // joueur en dessous
    expect(c.damage).toBe(ENEMIES.skeleton.damage);
    expect(c.enemyId).toBe(e.id);
    expect(e.attackCooldownMs).toBeGreaterThan(0);
    expect(['attack', 'recover']).toContain(e.mode);
  });

  it("l'araignée bondit vers le joueur (déplacement rapide pendant attack)", () => {
    const player = makePlayer(0, 240 + 40, 160);
    const h = makeHarness([player], 8);
    const e = spawnAt('spider', 240, 160);
    let before = 0;
    let after = 0;
    for (let i = 0; i < 600; i++) {
      const wasWindup = e.mode === 'windup';
      if (wasWindup) before = e.pos.x;
      h.step(e);
      if (e.mode === 'recover') {
        after = e.pos.x;
        break;
      }
    }
    expect(after - before).toBeGreaterThan(25);
    expect(h.circles.length).toBeGreaterThan(0);
  });

  it("l'archer tire des flèches dirigées vers sa cible, à vitesse constante", () => {
    const player = makePlayer(0, 240 + 80, 160 + 40);
    const h = makeHarness([player], 10);
    const e = spawnAt('archer', 240, 160);
    for (let i = 0; i < 900 && h.projectiles.length === 0; i++) h.step(e);
    expect(h.projectiles.length).toBeGreaterThanOrEqual(1);
    const p = h.projectiles[0];
    expect(p.kind).toBe('arrow');
    expect(p.damage).toBe(ENEMIES.archer.damage);
    expect(p.enemyId).toBe(e.id);
    const speed = Math.hypot(p.vel.x, p.vel.y);
    expect(speed).toBeGreaterThan(80);
    expect(p.lifeMs).toBeGreaterThan(500);
    // direction : vers le joueur (qui n'a pas bougé), tolérance pour le déplacement de l'archer pendant le télégraphe
    const want = Math.atan2(player.pos.y - e.pos.y, player.pos.x - e.pos.x);
    const got = Math.atan2(p.vel.y, p.vel.x);
    expect(angleDiff(want, got)).toBeLessThan(0.35);
  });

  it("l'archer garde ses distances (recule quand le joueur est trop près)", () => {
    const player = makePlayer(0, 240 + 25, 160);
    const h = makeHarness([player], 12);
    const e = spawnAt('archer', 240, 160);
    // empêche le tir pour isoler le mouvement
    e.attackCooldownMs = 99999;
    for (let i = 0; i < 90; i++) h.step(e);
    const d = Math.hypot(e.pos.x - player.pos.x, e.pos.y - player.pos.y);
    expect(d).toBeGreaterThan(25 + 15);
  });

  it('le feu follet tire un éventail de 3 orbes puis se téléporte', () => {
    const player = makePlayer(0, 240 + 70, 160);
    const h = makeHarness([player], 14);
    const e = spawnAt('wisp', 240, 160);
    let teleportSeen = false;
    let posBefore: Vec2 | null = null;
    let moved = false;
    for (let i = 0; i < 900 && !moved; i++) {
      player.invulnMs = 999;
      h.step(e);
      if (e.mode === 'teleport') {
        teleportSeen = true;
        if (!posBefore) posBefore = { ...e.pos };
        if (e.data.teleportMoved === 1) {
          moved = Math.hypot(e.pos.x - posBefore.x, e.pos.y - posBefore.y) > 5;
        }
      }
    }
    expect(h.projectiles.length).toBe(3);
    expect(h.projectiles.every((p) => p.kind === 'orb')).toBe(true);
    expect(teleportSeen).toBe(true);
    expect(moved).toBe(true);
    const angles = h.projectiles.map((p) => Math.atan2(p.vel.y, p.vel.x));
    expect(new Set(angles.map((a) => a.toFixed(3))).size).toBe(3);
  });

  it('le slime erre puis poursuit en bonds (data.hop alterne)', () => {
    const player = makePlayer(0, 240 + 60, 160);
    const h = makeHarness([player], 15);
    const e = spawnAt('slime', 240, 160);
    const hops = new Set<number>();
    for (let i = 0; i < 200; i++) {
      h.step(e);
      hops.add(e.data.hop);
    }
    expect(hops.has(0)).toBe(true);
    expect(hops.has(1)).toBe(true);
  });

  it('la chauve-souris vole par rafales (changements de cap) et pique après un télégraphe', () => {
    const player = makePlayer(0, 240 + 70, 160);
    const h = makeHarness([player], 16);
    const e = spawnAt('bat', 240, 160);
    const angles = new Set<string>();
    for (let i = 0; i < 400; i++) {
      player.invulnMs = 999;
      h.step(e);
      angles.add(e.data.burstAngle.toFixed(2));
    }
    expect(angles.size).toBeGreaterThan(4);
    expect(h.circles.length).toBeGreaterThan(0);
    expect(h.circles.every((c) => c.mode === 'attack')).toBe(true);
  });
});

// ───────────────────────────── Coups reçus ─────────────────────────────

describe('onEnemyHit', () => {
  it('flash + recul + étourdissement pour un ennemi léger', () => {
    const h = makeHarness([], 1);
    const e = spawnAt('slime', 240, 160);
    onEnemyHit(e, { x: 220, y: 160 }, 20);
    expect(e.hitFlashMs).toBeGreaterThan(0);
    expect(e.mode).toBe('stunned');
    expect(e.data.kbx).toBeGreaterThan(0);
    expect(Math.abs(e.data.kby)).toBeLessThan(1e-9);
    const x0 = e.pos.x;
    for (let i = 0; i < 20; i++) h.step(e);
    expect(e.pos.x).toBeGreaterThan(x0 + 3); // repoussé dans la direction opposée au coup
    expect(e.pos.x - x0).toBeLessThan(25); // recul modeste
    expect(e.hitFlashMs).toBe(0); // le flash décroît jusqu'à 0
  });

  it('le chevalier encaisse : aucun recul ni étourdissement', () => {
    const h = makeHarness([], 1);
    const e = spawnAt('knight', 240, 160);
    onEnemyHit(e, { x: 220, y: 160 }, 40);
    expect(e.hitFlashMs).toBeGreaterThan(0);
    expect(e.data.kbx).toBe(0);
    expect(e.data.kby).toBe(0);
    expect(e.mode).not.toBe('stunned');
    expect(e.data.stunMs).toBe(0);
    for (let i = 0; i < 10; i++) h.step(e);
    expect(e.mode).not.toBe('stunned');
  });

  it('le squelette est moins repoussé que le slime', () => {
    const a = spawnAt('slime', 240, 160);
    const b = spawnAt('skeleton', 240, 160);
    onEnemyHit(a, { x: 220, y: 160 }, 20);
    onEnemyHit(b, { x: 220, y: 160 }, 20);
    expect(b.data.kbx).toBeLessThan(a.data.kbx);
    expect(b.data.kbx).toBeGreaterThan(0);
  });

  it('un coup interrompt un télégraphe mais pas une attaque en cours', () => {
    const player = makePlayer(0, 262, 160);
    const h = makeHarness([player], 21);
    const e = spawnAt('skeleton', 240, 160);
    for (let i = 0; i < 400 && e.mode !== 'windup'; i++) h.step(e);
    expect(e.mode).toBe('windup');
    onEnemyHit(e, { x: 200, y: 160 }, 20);
    expect(e.mode).toBe('stunned');
    expect(e.data.special).toBe(0);

    const e2 = spawnAt('skeleton', 240, 160, 2);
    e2.mode = 'attack';
    e2.modeTimerMs = 100;
    onEnemyHit(e2, { x: 200, y: 160 }, 20);
    expect(e2.mode).toBe('attack');
  });

  it('le stun cumulé est borné : frappé à chaque pas pendant 20 s, <= 35 % du temps étourdi', () => {
    for (const kind of ['slime', 'bat', 'skeleton', 'archer', 'spider', 'wisp'] as EnemyKind[]) {
      const player = makePlayer(0, 262, 160);
      player.invulnMs = 1e9;
      const h = makeHarness([player], 31);
      const e = spawnAt(kind, 240, 160);
      const steps = Math.round(20000 / SIM_STEP_MS);
      let stunned = 0;
      for (let i = 0; i < steps; i++) {
        onEnemyHit(e, { x: 200, y: 160 }, 20);
        h.step(e);
        player.invulnMs = 1e9;
        if (e.mode === 'stunned') stunned++;
        // L'ennemi peut être repoussé jusqu'au mur : on le replace pour tester le stun, pas la géométrie.
        if (e.pos.x > 300 || e.pos.x < 180) e.pos.x = 240;
      }
      expect(stunned / steps).toBeLessThanOrEqual(0.35);
      expect(allFinite(e)).toBe(true);
    }
  });

  it('un ennemi frappé en continu reste capable d\'attaquer (pas de stun-lock total)', () => {
    for (const kind of ['slime', 'skeleton', 'spider'] as EnemyKind[]) {
      const player = makePlayer(0, 240 + 14, 160);
      player.invulnMs = 1e9;
      const h = makeHarness([player], 33);
      const e = spawnAt(kind, 240, 160);
      const steps = Math.round(15000 / SIM_STEP_MS);
      let attacks = 0;
      let prev = e.mode;
      for (let i = 0; i < steps; i++) {
        if (i % 6 === 0) onEnemyHit(e, { x: 200, y: 160 }, 12); // un coup toutes les 100 ms
        h.step(e);
        player.invulnMs = 1e9;
        if (e.mode === 'attack' && prev !== 'attack') attacks++;
        prev = e.mode;
        if (e.pos.x > 300 || e.pos.x < 180) e.pos.x = 240;
      }
      expect(attacks).toBeGreaterThan(0);
    }
  });

  it("un coup pendant l'étourdissement ne le prolonge pas", () => {
    const e = spawnAt('slime', 240, 160);
    onEnemyHit(e, { x: 200, y: 160 }, 20);
    const first = e.data.stunMs;
    onEnemyHit(e, { x: 200, y: 160 }, 20);
    expect(e.data.stunMs).toBe(first);
  });

  it('ignore un ennemi mort', () => {
    const e = spawnAt('slime', 240, 160);
    e.dead = true;
    onEnemyHit(e, { x: 200, y: 160 }, 20);
    expect(e.hitFlashMs).toBe(0);
  });
});

// ───────────────────────────── Robustesse et déterminisme ─────────────────────────────

describe('robustesse', () => {
  it('dtMs = 0 ou invalide : aucun effet, aucun NaN', () => {
    const player = makePlayer(0, 250, 160);
    const h = makeHarness([player], 1);
    for (const dt of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const e = spawnAt('skeleton', 240, 160);
      const snapshot = JSON.stringify(e);
      h.ctx.dtMs = dt;
      updateEnemy(e, h.ctx);
      if (dt !== Number.POSITIVE_INFINITY) expect(JSON.stringify(e)).toBe(snapshot);
      expect(allFinite(e)).toBe(true);
    }
  });

  it('un ennemi mort ne bouge plus', () => {
    const player = makePlayer(0, 250, 160);
    const h = makeHarness([player], 1);
    const e = spawnAt('skeleton', 240, 160);
    e.dead = true;
    const snap = JSON.stringify(e);
    for (let i = 0; i < 50; i++) h.step(e);
    expect(JSON.stringify(e)).toBe(snap);
  });

  it.each(ENEMY_KINDS)('aucune valeur NaN après 20 000 pas aléatoires (%s)', (kind) => {
    const scenario = createRng(99);
    const players = [makePlayer(0, 100, 100), makePlayer(1, 380, 220), makePlayer(2, 240, 160), makePlayer(3, 60, 260)];
    const h = makeHarness(players, 77);
    const e = spawnAt(kind, 240, 160);
    h.enemies.push(e);
    const modes = new Set<string>();
    for (let i = 0; i < 20000; i++) {
      // Les joueurs se déplacent, tombent et sont relevés au hasard.
      for (const p of players) {
        if (nextRandom(scenario) < 0.02) {
          p.pos.x = Math.min(ROOM_W - 6, Math.max(6, p.pos.x + (nextRandom(scenario) - 0.5) * 30));
          p.pos.y = Math.min(ROOM_H - 6, Math.max(6, p.pos.y + (nextRandom(scenario) - 0.5) * 30));
        }
        if (nextRandom(scenario) < 0.001) {
          p.status = p.status === 'alive' ? 'down' : 'alive';
          p.hp = p.status === 'alive' ? p.maxHp : 0;
        }
      }
      if (nextRandom(scenario) < 0.01) {
        onEnemyHit(e, { x: nextRandom(scenario) * ROOM_W, y: nextRandom(scenario) * ROOM_H }, nextRandom(scenario) * 40);
      }
      // Bosses : on fait baisser les PV pour traverser toutes les phases.
      if (ENEMIES[kind].isBoss) e.hp = Math.max(1, e.hp - e.maxHp / 15000);
      h.step(e);
      modes.add(e.mode);
      if (!allFinite(e)) throw new Error(`NaN/Infinity détecté au pas ${i} pour ${kind}`);
      expect(e.pos.x).toBeGreaterThanOrEqual(0);
      expect(e.pos.x).toBeLessThanOrEqual(ROOM_W);
      expect(e.pos.y).toBeGreaterThanOrEqual(0);
      expect(e.pos.y).toBeLessThanOrEqual(ROOM_H);
    }
    for (const m of modes) expect(ENEMY_MODES as readonly string[]).toContain(m);
    for (const p of h.projectiles) {
      expect(Number.isFinite(p.vel.x) && Number.isFinite(p.vel.y) && Number.isFinite(p.pos.x) && Number.isFinite(p.pos.y)).toBe(true);
      expect(p.lifeMs).toBeGreaterThan(0);
    }
  });

  it.each(ENEMY_KINDS)('déterminisme : même seed => même trajectoire (%s)', (kind) => {
    const run = (seed: number): string => {
      const players = [makePlayer(0, 200, 150), makePlayer(1, 300, 180)];
      const h = makeHarness(players, seed);
      const e = spawnAt(kind, 240, 160);
      const trace: number[] = [];
      for (let i = 0; i < 3000; i++) {
        if (i % 400 === 0) onEnemyHit(e, { x: 100, y: 100 }, 15);
        if (ENEMIES[kind].isBoss) e.hp = Math.max(1, e.maxHp * (1 - i / 3200));
        h.step(e);
        if (i % 10 === 0) trace.push(e.pos.x, e.pos.y, e.modeTimerMs);
      }
      return JSON.stringify([trace, h.projectiles.length, h.circles.length, e.mode, e.data]);
    };
    expect(run(5)).toBe(run(5));
  });

  it('seeds différentes => trajectoires différentes (chauve-souris)', () => {
    const run = (seed: number): number[] => {
      const players = [makePlayer(0, 300, 160)];
      const h = makeHarness(players, seed);
      const e = spawnAt('bat', 240, 160);
      for (let i = 0; i < 300; i++) h.step(e);
      return [e.pos.x, e.pos.y];
    };
    expect(run(1)).not.toEqual(run(2));
  });

  it("ne sort jamais de la pièce (collision de la boîte) sur 5000 pas", () => {
    for (const kind of NORMAL_KINDS) {
      const players = [makePlayer(0, 470, 310)];
      const h = makeHarness(players, 3);
      const e = spawnAt(kind, 470, 300);
      for (let i = 0; i < 5000; i++) {
        h.step(e);
        expect(e.pos.x).toBeLessThanOrEqual(ROOM_W);
        expect(e.pos.y).toBeLessThanOrEqual(ROOM_H);
      }
    }
  });
});
