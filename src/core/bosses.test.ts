import { describe, expect, it } from 'vitest';
import { createEnemyState, onEnemyHit, updateEnemy } from './ai';
import {
  ENEMY_SPECIALS,
  GOLEM_SLAM_RADIUS,
  MAX_BOSS_MINIONS,
  MIN_BOSS_WINDUP_MS,
  PHASE_ROAR_MS,
  bossPhaseFor,
} from './bosses';
import { SIM_STEP_MS } from './constants';
import { ENEMIES } from './enemies';
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
  circles: { center: Vec2; radius: number; damage: number; enemyId: number }[];
  spawns: { kind: EnemyKind; pos: Vec2 }[];
  events: SimEvent[];
  step: (boss: EnemyState) => void;
}

const ROOM_W = 480;
const ROOM_H = 320;

function makePlayer(id: PlayerId, x: number, y: number, status: 'alive' | 'down' = 'alive'): PlayerState {
  const p = createPlayerState({ id, characterId: 'david', difficulty: 2 }, { x, y });
  p.status = status;
  if (status === 'down') p.hp = 0;
  return p;
}

function makeHarness(players: PlayerState[], seed = 1): Harness {
  const rng = createRng(seed);
  const enemies: EnemyState[] = [];
  let nextId = 1000;
  const h: Harness = {
    ctx: undefined as unknown as EnemyAIContext,
    players,
    enemies,
    projectiles: [],
    circles: [],
    spawns: [],
    events: [],
    step: () => undefined,
  };
  const free = (p: Vec2, r: number): boolean => p.x >= r && p.x <= ROOM_W - r && p.y >= r && p.y <= ROOM_H - r;
  h.ctx = {
    dtMs: SIM_STEP_MS,
    players,
    enemies,
    random: randomFn(rng),
    canOccupy: (pos, radius) => free(pos, radius),
    moveWithCollision: (pos, delta, radius) => {
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
      h.circles.push({ center: { ...center }, radius, damage, enemyId });
    },
    roomBounds: { width: ROOM_W, height: ROOM_H },
    emit: (e) => {
      h.events.push(e);
    },
  };
  h.step = (boss) => updateEnemy(boss, h.ctx);
  return h;
}

function allFinite(e: EnemyState): boolean {
  const nums = [e.pos.x, e.pos.y, e.hp, e.maxHp, e.modeTimerMs, e.attackCooldownMs, e.hitFlashMs, e.phase, e.targetId];
  return nums.every(Number.isFinite) && Object.values(e.data).every(Number.isFinite);
}

function spawnBoss(kind: 'golem' | 'morvane', x = 240, y = 160): EnemyState {
  return createEnemyState(kind, { x, y }, 1, 0);
}

function aliveOf(h: Harness, kind: EnemyKind): number {
  return h.enemies.filter((e) => !e.dead && e.kind === kind).length;
}

/** Fait tourner `ms` millisecondes ; le joueur reste invulnérable (on teste l'IA, pas la survie). */
function run(h: Harness, boss: EnemyState, ms: number, each?: (pre: string, post: string) => void): void {
  const steps = Math.round(ms / SIM_STEP_MS);
  for (let i = 0; i < steps; i++) {
    for (const p of h.players) if (p.status === 'alive') p.invulnMs = 1e9;
    const pre = boss.mode;
    h.step(boss);
    each?.(pre, boss.mode);
  }
}

const BOSSES: ('golem' | 'morvane')[] = ['golem', 'morvane'];

// ───────────────────────────── Phases ─────────────────────────────

describe('bossPhaseFor', () => {
  it('Gorgrim : seuils 66 % et 33 %', () => {
    expect(bossPhaseFor('golem', 700, 700)).toBe(1);
    expect(bossPhaseFor('golem', 700 * 0.67, 700)).toBe(1);
    expect(bossPhaseFor('golem', 700 * 0.66, 700)).toBe(2);
    expect(bossPhaseFor('golem', 700 * 0.34, 700)).toBe(2);
    expect(bossPhaseFor('golem', 700 * 0.33, 700)).toBe(3);
    expect(bossPhaseFor('golem', 1, 700)).toBe(3);
  });

  it('Morvane : seuils 70 % et 35 %', () => {
    expect(bossPhaseFor('morvane', 1400, 1400)).toBe(1);
    expect(bossPhaseFor('morvane', 1400 * 0.71, 1400)).toBe(1);
    expect(bossPhaseFor('morvane', 1400 * 0.7, 1400)).toBe(2);
    expect(bossPhaseFor('morvane', 1400 * 0.36, 1400)).toBe(2);
    expect(bossPhaseFor('morvane', 1400 * 0.35, 1400)).toBe(3);
  });

  it('valeurs dégénérées : jamais NaN ni 0', () => {
    expect(bossPhaseFor('golem', Number.NaN, 700)).toBe(1);
    expect(bossPhaseFor('golem', 10, 0)).toBe(1);
  });
});

describe('passage par les 3 phases', () => {
  it.each(BOSSES)('%s : phases 1, 2, 3 dans l\'ordre avec événements bossPhase', (kind) => {
    const player = makePlayer(0, 240 + 60, 160);
    const h = makeHarness([player], 5);
    const boss = spawnBoss(kind);
    expect(boss.phase).toBe(0);
    run(h, boss, 200);
    expect(boss.phase).toBe(1);
    expect(boss.data.engaged).toBe(1);

    const t2 = kind === 'golem' ? 0.66 : 0.7;
    const t3 = kind === 'golem' ? 0.33 : 0.35;
    boss.hp = boss.maxHp * (t2 - 0.01);
    run(h, boss, 100);
    expect(boss.phase).toBe(2);
    boss.hp = boss.maxHp * (t3 - 0.01);
    run(h, boss, 100);
    expect(boss.phase).toBe(3);

    const phases = h.events.filter((e) => e.type === 'bossPhase').map((e) => (e.type === 'bossPhase' ? e.phase : -1));
    expect(phases).toEqual([1, 2, 3]);
    for (const e of h.events) {
      if (e.type === 'bossPhase') {
        expect(e.enemyId).toBe(boss.id);
        expect(e.kind).toBe(kind);
      }
    }
  });

  it.each(BOSSES)('%s : un changement de phase = rugissement sans attaque, la phase ne régresse pas', (kind) => {
    const player = makePlayer(0, 240 + 60, 160);
    const h = makeHarness([player], 6);
    const boss = spawnBoss(kind);
    run(h, boss, 100);
    boss.hp = boss.maxHp * 0.3;
    const before = h.circles.length + h.projectiles.length;
    h.step(boss);
    expect(boss.phase).toBe(3);
    expect(boss.mode).toBe('recover');
    expect(boss.data.special).toBe(ENEMY_SPECIALS.ROAR);
    run(h, boss, PHASE_ROAR_MS - 100);
    expect(h.circles.length + h.projectiles.length).toBe(before);
    // soigner le boss (cas improbable) ne fait pas régresser la phase
    boss.hp = boss.maxHp;
    run(h, boss, 500);
    expect(boss.phase).toBe(3);
  });

  it.each(BOSSES)('%s : les PV réels décroissants traversent les 3 phases (balayage)', (kind) => {
    const player = makePlayer(0, 240 + 70, 160);
    const h = makeHarness([player], 7);
    const boss = spawnBoss(kind);
    const seen: number[] = [boss.phase];
    for (let i = 0; i < 6000; i++) {
      player.invulnMs = 1e9;
      boss.hp = Math.max(1, boss.maxHp * (1 - i / 5500));
      h.step(boss);
      if (seen[seen.length - 1] !== boss.phase) seen.push(boss.phase);
    }
    expect(seen).toEqual([0, 1, 2, 3]);
  });
});

// ───────────────────────────── Équité : tout est télégraphié ─────────────────────────────

describe('attaques toujours télégraphées (>= 600 ms)', () => {
  for (const kind of BOSSES) {
    for (const hpFrac of [1, 0.5, 0.2]) {
      it(`${kind} à ${Math.round(hpFrac * 100)} % des PV : aucun effet sans windup >= 600 ms`, () => {
        const player = makePlayer(0, 240 + 70, 160);
        const h = makeHarness([player], 11);
        const boss = spawnBoss(kind);
        boss.hp = boss.maxHp * hpFrac;
        let windupMs = 0;
        let attacks = 0;
        let lastSpecial = 0;
        run(h, boss, 60000, (pre, post) => {
          if (pre === 'windup') {
            windupMs += SIM_STEP_MS;
            lastSpecial = boss.data.special;
            expect(boss.data.windupTotalMs).toBeGreaterThanOrEqual(MIN_BOSS_WINDUP_MS);
            expect(lastSpecial).not.toBe(ENEMY_SPECIALS.NONE);
          }
          if (pre === 'windup' && post === 'attack') {
            attacks++;
            expect(windupMs).toBeGreaterThanOrEqual(MIN_BOSS_WINDUP_MS - SIM_STEP_MS);
            windupMs = 0;
          }
          if (pre !== 'windup') windupMs = 0;
        });
        expect(attacks).toBeGreaterThan(5);
      });

      it(`${kind} à ${Math.round(hpFrac * 100)} % des PV : les effets n'ont lieu qu'en mode attack`, () => {
        const player = makePlayer(0, 240 + 70, 160);
        const h = makeHarness([player], 12);
        const boss = spawnBoss(kind);
        boss.hp = boss.maxHp * hpFrac;
        let effects = h.circles.length + h.projectiles.length + h.spawns.length;
        run(h, boss, 40000, (pre, post) => {
          const now = h.circles.length + h.projectiles.length + h.spawns.length;
          if (now > effects) {
            // soit déjà en attack, soit transition windup -> attack (exécution au premier pas)
            expect(pre === 'attack' || (pre === 'windup' && post === 'attack')).toBe(true);
          }
          effects = now;
        });
        expect(effects).toBeGreaterThan(0);
      });
    }
  }
});

// ───────────────────────────── Gorgrim ─────────────────────────────

describe('Gorgrim (golem)', () => {
  it('phase 1 : marche vers le joueur puis frappe au sol (onde + anneau d\'éclats)', () => {
    const player = makePlayer(0, 240 + 150, 160);
    const h = makeHarness([player], 21);
    const boss = spawnBoss('golem');
    const d0 = 150;
    run(h, boss, 3000);
    expect(Math.hypot(boss.pos.x - player.pos.x, boss.pos.y - player.pos.y)).toBeLessThan(d0 - 20);
    run(h, boss, 12000);
    expect(h.circles.length).toBeGreaterThan(0);
    expect(h.circles[0].radius).toBe(GOLEM_SLAM_RADIUS);
    expect(h.circles[0].damage).toBe(ENEMIES.golem.damage);
    const shards = h.projectiles.filter((p) => p.kind === 'shard');
    expect(shards.length).toBeGreaterThanOrEqual(12);
    expect(shards.every((p) => p.enemyId === boss.id)).toBe(true);
    // l'anneau couvre tous les angles
    const first = shards.slice(0, 12).map((p) => Math.atan2(p.vel.y, p.vel.x));
    const sorted = [...first].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i] - sorted[i - 1]).toBeGreaterThan(0.3);
  });

  it('phase 2 : invoque 2 araignées, jamais plus de 4 vivantes', () => {
    const player = makePlayer(0, 240 + 60, 160);
    const h = makeHarness([player], 22);
    const boss = spawnBoss('golem');
    boss.hp = boss.maxHp * 0.5;
    let maxAlive = 0;
    let maxEverSpawned = 0;
    run(h, boss, 90000, () => {
      maxAlive = Math.max(maxAlive, aliveOf(h, 'spider'));
      maxEverSpawned = h.spawns.length;
    });
    expect(h.spawns.length).toBeGreaterThanOrEqual(2);
    expect(h.spawns.every((s) => s.kind === 'spider')).toBe(true);
    expect(maxAlive).toBeLessThanOrEqual(MAX_BOSS_MINIONS);
    expect(maxAlive).toBe(MAX_BOSS_MINIONS); // on ne tue jamais les araignées : le plafond est atteint mais pas dépassé
    expect(maxEverSpawned).toBe(4);
  });

  it('phase 2 : la première attaque est une invocation (2 araignées d\'un coup)', () => {
    const player = makePlayer(0, 240 + 60, 160);
    const h = makeHarness([player], 23);
    const boss = spawnBoss('golem');
    boss.hp = boss.maxHp * 0.5;
    run(h, boss, 8000, () => undefined);
    expect(h.spawns.length).toBe(2);
  });

  it("phase 2 : les racines sont des lignes de projectiles dans la direction visée", () => {
    const player = makePlayer(0, 240 + 60, 160 + 10);
    const h = makeHarness([player], 24);
    const boss = spawnBoss('golem');
    boss.hp = boss.maxHp * 0.5;
    boss.data.seq = 1; // première attaque : ROOTS
    let aim = 0;
    let rooted = false;
    run(h, boss, 20000, (pre, post) => {
      if (!rooted && boss.mode === 'windup' && boss.data.special === ENEMY_SPECIALS.ROOTS) aim = boss.data.aimAngle;
      if (pre === 'attack' && boss.data.special === ENEMY_SPECIALS.ROOTS) rooted = true;
    });
    // 7 salves x 3 lignes
    const shards = h.projectiles.filter((p) => p.kind === 'shard');
    expect(shards.length).toBeGreaterThanOrEqual(21);
    const lane = shards.slice(0, 21).map((p) => angleDiff(Math.atan2(p.vel.y, p.vel.x), aim));
    expect(Math.max(...lane)).toBeLessThanOrEqual(0.3);
    expect(aim).toBeGreaterThan(-0.2);
  });

  it('phase 3 : enchaîne deux frappes re-télégraphées, onde plus dense, plus rapide', () => {
    const player = makePlayer(0, 240 + 50, 160);
    const h = makeHarness([player], 25);
    const slow = spawnBoss('golem');
    const fast = spawnBoss('golem');
    fast.hp = fast.maxHp * 0.2;
    // Vitesse de marche comparée sur un joueur lointain
    const far = makePlayer(0, 470, 160);
    const h1 = makeHarness([far], 1);
    const h2 = makeHarness([far], 1);
    slow.attackCooldownMs = 1e9;
    fast.attackCooldownMs = 1e9;
    run(h1, slow, 1500);
    run(h2, fast, 1500);
    // (le boss rapide a d'abord un rugissement d'1 s, on compare donc sur une durée plus longue)
    run(h1, slow, 3000);
    run(h2, fast, 3000);
    expect(fast.pos.x - 240).toBeGreaterThan(slow.pos.x - 240);

    const boss = spawnBoss('golem');
    boss.hp = boss.maxHp * 0.2;
    const windups: number[] = [];
    let ringSizes: number[] = [];
    let before = 0;
    run(h, boss, 30000, (pre, post) => {
      if (pre !== 'windup' && post === 'windup' && boss.data.special === ENEMY_SPECIALS.RAGE) windups.push(boss.data.windupTotalMs);
      if (pre === 'windup' && post === 'attack' && boss.data.special === ENEMY_SPECIALS.RAGE) {
        ringSizes.push(h.projectiles.length - before);
      }
      before = h.projectiles.length;
    });
    expect(windups.length).toBeGreaterThanOrEqual(2);
    expect(windups.every((w) => w >= MIN_BOSS_WINDUP_MS)).toBe(true);
    ringSizes = ringSizes.filter((n) => n > 0);
    expect(ringSizes.length).toBeGreaterThanOrEqual(2);
    expect(ringSizes[1]).toBeGreaterThan(ringSizes[0]); // 2e onde plus dense
  });

  it('marche vers le joueur vivant le plus proche, jamais vers un joueur à terre', () => {
    const downed = makePlayer(0, 240 + 25, 160, 'down');
    const alive = makePlayer(1, 240 - 120, 160);
    const h = makeHarness([downed, alive], 26);
    const boss = spawnBoss('golem');
    run(h, boss, 3000);
    expect(boss.targetId).toBe(1);
    expect(boss.pos.x).toBeLessThan(240);
  });
});

// ───────────────────────────── Morvane ─────────────────────────────

describe('Morvane', () => {
  it('phase 1 : éventail de 5 orbes (5 voies) après télégraphe', () => {
    const player = makePlayer(0, 240 + 100, 160);
    const h = makeHarness([player], 31);
    const boss = spawnBoss('morvane');
    run(h, boss, 10000, () => undefined);
    const orbs = h.projectiles.filter((p) => p.kind === 'orb');
    expect(orbs.length).toBeGreaterThanOrEqual(5);
    const volley = orbs.slice(0, 5).map((p) => Math.atan2(p.vel.y, p.vel.x));
    expect(new Set(volley.map((a) => a.toFixed(3))).size).toBe(5);
    expect(orbs.every((p) => p.enemyId === boss.id)).toBe(true);
  });

  it('se téléporte entre des points de l\'arène valides, loin des joueurs', () => {
    const players = [makePlayer(0, 100, 100), makePlayer(1, 380, 220)];
    const h = makeHarness(players, 32);
    const boss = spawnBoss('morvane');
    let teleports = 0;
    let prevMode = boss.mode;
    run(h, boss, 40000, (pre, post) => {
      if (post === 'teleport' && prevMode !== 'teleport') {
        teleports++;
        expect(boss.data.special).toBe(ENEMY_SPECIALS.TELEPORT);
      }
      if (prevMode === 'teleport' && post !== 'teleport') {
        expect(h.ctx.canOccupy(boss.pos, ENEMIES.morvane.radius)).toBe(true);
        for (const p of players) {
          expect(Math.hypot(boss.pos.x - p.pos.x, boss.pos.y - p.pos.y)).toBeGreaterThanOrEqual(40);
        }
      }
      prevMode = post;
    });
    expect(teleports).toBeGreaterThanOrEqual(3);
  });

  it('phase 2 : invoque 2 squelettes ou feux follets, jamais plus de 4 vivants, et un anneau d\'orbes', () => {
    const player = makePlayer(0, 240 + 100, 160);
    const h = makeHarness([player], 33);
    const boss = spawnBoss('morvane');
    boss.hp = boss.maxHp * 0.5;
    let maxAlive = 0;
    run(h, boss, 90000, () => {
      maxAlive = Math.max(maxAlive, aliveOf(h, 'skeleton') + aliveOf(h, 'wisp'));
    });
    expect(h.spawns.length).toBeGreaterThanOrEqual(2);
    expect(h.spawns.every((s) => s.kind === 'skeleton' || s.kind === 'wisp')).toBe(true);
    expect(maxAlive).toBeLessThanOrEqual(MAX_BOSS_MINIONS);
    expect(maxAlive).toBe(MAX_BOSS_MINIONS);
    expect(h.spawns.length).toBe(4);
    expect(h.projectiles.filter((p) => p.kind === 'orb').length).toBeGreaterThanOrEqual(16);
  });

  it('phase 2 : reprend les invocations quand les sbires sont vaincus (toujours <= 4)', () => {
    const player = makePlayer(0, 240 + 100, 160);
    const h = makeHarness([player], 34);
    const boss = spawnBoss('morvane');
    boss.hp = boss.maxHp * 0.5;
    let maxAlive = 0;
    let tick = 0;
    run(h, boss, 120000, () => {
      // le joueur élimine tous les sbires toutes les 10 s
      if (++tick % 600 === 0) for (const e of h.enemies) e.dead = true;
      maxAlive = Math.max(maxAlive, aliveOf(h, 'skeleton') + aliveOf(h, 'wisp'));
    });
    expect(h.spawns.length).toBeGreaterThan(4);
    expect(maxAlive).toBeLessThanOrEqual(MAX_BOSS_MINIONS);
  });

  it('phase 3 : spirale de projectiles (beaucoup d\'orbes en une attaque) puis charge télégraphée', () => {
    const player = makePlayer(0, 240 + 100, 160);
    const h = makeHarness([player], 35);
    const boss = spawnBoss('morvane');
    boss.hp = boss.maxHp * 0.2;
    let spiralOrbs = 0;
    let chargeMoved = 0;
    let chargeCircles = 0;
    let chargeStart: Vec2 | null = null;
    let sawChargeWindup = false;
    run(h, boss, 90000, (pre, post) => {
      const sp = boss.data.special;
      if (post === 'windup' && sp === ENEMY_SPECIALS.CHARGE) {
        sawChargeWindup = true;
        expect(boss.data.windupTotalMs).toBeGreaterThanOrEqual(900);
        expect(boss.data.telegraphLength).toBeGreaterThan(100);
      }
      if (pre === 'windup' && post === 'attack' && sp === ENEMY_SPECIALS.CHARGE) {
        chargeStart = { ...boss.pos };
      }
      if (post === 'recover' && pre === 'attack' && chargeStart) {
        chargeMoved = Math.max(chargeMoved, Math.hypot(boss.pos.x - chargeStart.x, boss.pos.y - chargeStart.y));
        chargeStart = null;
      }
    });
    spiralOrbs = h.projectiles.length;
    chargeCircles = h.circles.length;
    expect(spiralOrbs).toBeGreaterThan(80);
    expect(sawChargeWindup).toBe(true);
    expect(chargeMoved).toBeGreaterThan(50);
    expect(chargeCircles).toBeGreaterThan(5);
  });

  it('lévite : passe flying=true à moveWithCollision', () => {
    const player = makePlayer(0, 240 + 100, 160);
    const h = makeHarness([player], 36);
    const flags: boolean[] = [];
    const orig = h.ctx.moveWithCollision;
    h.ctx.moveWithCollision = (pos, delta, radius, flying) => {
      flags.push(flying === true);
      return orig(pos, delta, radius, flying);
    };
    const boss = spawnBoss('morvane');
    run(h, boss, 5000);
    expect(flags.length).toBeGreaterThan(0);
    expect(flags.every(Boolean)).toBe(true);
  });
});

// ───────────────────────────── Équité : 1 à 4 joueurs, joueurs à terre ─────────────────────────────

describe('équité', () => {
  it.each(BOSSES)('%s : aucun effet quand aucun joueur n\'est vivant, retour en idle', (kind) => {
    const players = [makePlayer(0, 250, 160, 'down'), makePlayer(1, 260, 160, 'down')];
    const h = makeHarness(players, 41);
    const boss = spawnBoss(kind);
    run(h, boss, 10000);
    expect(h.circles).toHaveLength(0);
    expect(h.projectiles).toHaveLength(0);
    expect(h.spawns).toHaveLength(0);
    expect(boss.mode).toBe('idle');
    expect(boss.phase).toBe(0);
  });

  it.each(BOSSES)('%s : abandonne l\'attaque en cours si tous les joueurs tombent', (kind) => {
    const player = makePlayer(0, 240 + 60, 160);
    const h = makeHarness([player], 42);
    const boss = spawnBoss(kind);
    for (let i = 0; i < 3000 && boss.mode !== 'windup'; i++) {
      player.invulnMs = 1e9;
      h.step(boss);
    }
    expect(boss.mode).toBe('windup');
    player.status = 'down';
    player.hp = 0;
    h.step(boss);
    expect(boss.mode).toBe('idle');
    const n = h.circles.length + h.projectiles.length;
    run(h, boss, 5000);
    expect(h.circles.length + h.projectiles.length).toBe(n);
  });

  it.each(BOSSES)('%s : cible un joueur vivant même loin (aggro illimité une fois engagé)', (kind) => {
    const near = makePlayer(0, 240 + 30, 160);
    const h = makeHarness([near], 43);
    const boss = spawnBoss(kind);
    run(h, boss, 500);
    expect(boss.targetId).toBe(0);
    near.pos.x = 470;
    near.pos.y = 310;
    run(h, boss, 500);
    expect(boss.targetId).toBe(0);
  });

  it.each(BOSSES)('%s : les attaques fonctionnent avec 1, 2, 3 et 4 joueurs', (kind) => {
    for (let n = 1; n <= 4; n++) {
      const players = Array.from({ length: n }, (_, i) => makePlayer(i as PlayerId, 150 + i * 60, 200));
      const h = makeHarness(players, 50 + n);
      const boss = spawnBoss(kind);
      run(h, boss, 25000);
      expect(h.circles.length + h.projectiles.length).toBeGreaterThan(0);
      expect(allFinite(boss)).toBe(true);
    }
  });

  it("récupération plus longue quand il reste peu de joueurs vivants (1 joueur ≥ 4 joueurs)", () => {
    const measure = (n: number): number => {
      const players = Array.from({ length: n }, (_, i) => makePlayer(i as PlayerId, 250 + i * 5, 160));
      const h = makeHarness(players, 61);
      const boss = spawnBoss('golem');
      let recover = 0;
      let counting = false;
      let done = false;
      run(h, boss, 20000, (pre, post) => {
        if (done) return;
        if (counting && pre === 'recover') recover += SIM_STEP_MS;
        if (counting && pre === 'recover' && post !== 'recover') done = true;
        if (!counting && pre === 'attack' && post === 'recover') counting = true;
      });
      return recover;
    };
    const solo = measure(1);
    const four = measure(4);
    expect(solo).toBeGreaterThan(four * 1.1);
  });
});

// ───────────────────────────── onEnemyHit sur les boss ─────────────────────────────

describe('onEnemyHit (boss)', () => {
  it.each(BOSSES)("%s : flash seulement, ni recul ni étourdissement, phase préservée", (kind) => {
    const player = makePlayer(0, 240 + 60, 160);
    const h = makeHarness([player], 71);
    const boss = spawnBoss(kind);
    boss.hp = boss.maxHp * 0.5;
    run(h, boss, 500);
    const phase = boss.phase;
    const mode = boss.mode;
    onEnemyHit(boss, { x: 100, y: 100 }, 60);
    expect(boss.hitFlashMs).toBeGreaterThan(0);
    expect(boss.data.kbx).toBe(0);
    expect(boss.data.kby).toBe(0);
    expect(boss.data.stunMs).toBe(0);
    expect(boss.mode).toBe(mode);
    expect(boss.phase).toBe(phase);
  });

  it.each(BOSSES)("%s : un boss touché en continu continue d'attaquer", (kind) => {
    const player = makePlayer(0, 240 + 60, 160);
    const h = makeHarness([player], 72);
    const boss = spawnBoss(kind);
    run(h, boss, 30000, () => {
      onEnemyHit(boss, { x: 100, y: 100 }, 20);
    });
    expect(h.circles.length + h.projectiles.length).toBeGreaterThan(0);
  });
});

// ───────────────────────────── Robustesse et déterminisme ─────────────────────────────

describe('robustesse des boss', () => {
  it.each(BOSSES)('%s : aucune valeur NaN sur 20 000 pas aléatoires, projectiles valides', (kind) => {
    const scenario = createRng(2024);
    const players = [makePlayer(0, 100, 100), makePlayer(1, 380, 220), makePlayer(2, 240, 160), makePlayer(3, 60, 260)];
    const h = makeHarness(players, 4242);
    const boss = spawnBoss(kind);
    for (let i = 0; i < 20000; i++) {
      for (const p of players) {
        if (nextRandom(scenario) < 0.03) {
          p.pos.x = Math.min(ROOM_W - 6, Math.max(6, p.pos.x + (nextRandom(scenario) - 0.5) * 40));
          p.pos.y = Math.min(ROOM_H - 6, Math.max(6, p.pos.y + (nextRandom(scenario) - 0.5) * 40));
        }
        if (nextRandom(scenario) < 0.0008) {
          p.status = p.status === 'alive' ? 'down' : 'alive';
          p.hp = p.status === 'alive' ? p.maxHp : 0;
        }
      }
      if (nextRandom(scenario) < 0.01) onEnemyHit(boss, { x: 50, y: 50 }, 30);
      boss.hp = Math.max(1, boss.maxHp * (1 - i / 19000));
      // nettoyage des sbires pour éviter une liste infinie
      if (h.enemies.length > 40) h.enemies.splice(0, 20);
      h.step(boss);
      if (!allFinite(boss)) throw new Error(`NaN/Infinity au pas ${i} (${kind})`);
      expect(boss.pos.x).toBeGreaterThanOrEqual(0);
      expect(boss.pos.x).toBeLessThanOrEqual(ROOM_W);
      expect(boss.pos.y).toBeGreaterThanOrEqual(0);
      expect(boss.pos.y).toBeLessThanOrEqual(ROOM_H);
      expect(boss.phase).toBeGreaterThanOrEqual(0);
      expect(boss.phase).toBeLessThanOrEqual(3);
    }
    for (const p of h.projectiles) {
      expect(Number.isFinite(p.vel.x + p.vel.y + p.pos.x + p.pos.y + p.damage + p.lifeMs + p.radius)).toBe(true);
      expect(p.damage).toBeGreaterThan(0);
      expect(p.lifeMs).toBeGreaterThan(0);
    }
    for (const s of h.spawns) expect(Number.isFinite(s.pos.x + s.pos.y)).toBe(true);
    for (const e of h.events) expect(e.type).toBe('bossPhase');
  });

  it.each(BOSSES)('%s : déterminisme (même seed => même combat)', (kind) => {
    const go = (seed: number): string => {
      const players = [makePlayer(0, 200, 150), makePlayer(1, 300, 180)];
      const h = makeHarness(players, seed);
      const boss = spawnBoss(kind);
      for (let i = 0; i < 6000; i++) {
        for (const p of players) p.invulnMs = 1e9;
        boss.hp = Math.max(1, boss.maxHp * (1 - i / 6500));
        h.step(boss);
      }
      return JSON.stringify([boss, h.projectiles, h.circles, h.spawns, h.events]);
    };
    expect(go(8)).toBe(go(8));
    expect(go(8)).not.toBe(go(9));
  });

  it.each(BOSSES)('%s : dtMs invalide => aucun effet', (kind) => {
    const player = makePlayer(0, 250, 160);
    const h = makeHarness([player], 1);
    const boss = spawnBoss(kind);
    const snap = JSON.stringify(boss);
    h.ctx.dtMs = Number.NaN;
    updateEnemy(boss, h.ctx);
    h.ctx.dtMs = 0;
    updateEnemy(boss, h.ctx);
    expect(JSON.stringify(boss)).toBe(snap);
  });
});
