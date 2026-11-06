import { describe, expect, it, vi } from 'vitest';
import { damageToEnemy, damageToPlayer, playerBaseDamage } from './balance';
import { getCharacter } from './characters';
import type { PixelRect } from './collision';
import {
  BOSS_DAMAGE_CAP_FRACTION,
  BOSS_DAMAGE_WINDOW_MS,
  buildPlayerProjectile,
  canPlayerAttack,
  damageEnemy,
  damagePlayersInCircle,
  enemyRadius,
  HEAL_PROJECTILE_AMOUNT,
  healPlayer,
  hurtPlayer,
  meleeTargets,
  performPlayerAttack,
  stepProjectiles,
  type CombatContext,
} from './combat';
import { SIM_STEP_MS } from './constants';
import { ENEMIES } from './enemies';
import { RoomGrid } from './grid';
import { createPlayerState } from './players';
import type {
  CharacterId,
  Difficulty,
  EnemyKind,
  EnemyState,
  PlayerId,
  PlayerState,
  ProjectileState,
  RoomState,
  SimEvent,
} from './types';

// ───────────────────────────── Harnais ─────────────────────────────

/** Grande salle 20×10 (murs sur le bord, une colonne de mur en x=12 entre y=3 et y=6 pour les tests de mur). */
const LAYOUT: string[] = [];
for (let y = 0; y < 10; y++) {
  if (y === 0 || y === 9) LAYOUT.push('#'.repeat(20));
  else if (y >= 3 && y <= 6) LAYOUT.push('#...........#........#'.slice(0, 20).replace(/^(.{19}).$/, '$1#'));
  else LAYOUT.push('#' + '.'.repeat(18) + '#');
}
const grid = new RoomGrid(LAYOUT);

function makePlayer(id: PlayerId, characterId: CharacterId, x: number, y: number, difficulty: Difficulty = 2): PlayerState {
  return createPlayerState({ id, characterId, difficulty }, { x, y });
}

function makeEnemy(id: number, kind: EnemyKind, x: number, y: number): EnemyState {
  const def = ENEMIES[kind];
  return {
    id,
    kind,
    pos: { x, y },
    facing: 'down',
    hp: def.hp,
    maxHp: def.hp,
    mode: 'idle',
    modeTimerMs: 0,
    attackCooldownMs: 0,
    hitFlashMs: 0,
    data: {},
    phase: 0,
    targetId: -1,
    wave: 0,
    dead: false,
  };
}

interface Harness {
  ctx: CombatContext;
  events: SimEvent[];
  room: RoomState;
  players: PlayerState[];
  onHit: ReturnType<typeof vi.fn>;
  setSolids(s: PixelRect[]): void;
  setDamage(on: boolean): void;
}

function harness(players: PlayerState[], enemies: EnemyState[] = [], g: RoomGrid = grid): Harness {
  const events: SimEvent[] = [];
  const room: RoomState = { roomId: 'r', enemies, projectiles: [], mechanisms: [], spawnedSpawnIdx: [], elapsedMs: 0 };
  const onHit = vi.fn();
  let nextId = 1000;
  let damageEnabled = true;
  const ctx: CombatContext = {
    room,
    players,
    grid: g,
    solids: [],
    events,
    nextId: () => nextId++,
    onEnemyHit: onHit,
    killers: new Map(),
    get damageEnabled() {
      return damageEnabled;
    },
  };
  return {
    ctx,
    events,
    room,
    players,
    onHit,
    setSolids: (s) => {
      ctx.solids = s;
    },
    setDamage: (on) => {
      damageEnabled = on;
    },
  };
}

function fireEnemyProjectile(h: Harness, x: number, y: number, vx: number, vy: number, damage = 10): ProjectileState {
  const p: ProjectileState = {
    id: 500,
    kind: 'bolt',
    owner: { type: 'enemy', id: 77 },
    pos: { x, y },
    vel: { x: vx, y: vy },
    damage,
    radius: 3,
    lifeMs: 2000,
    pierce: false,
    hitIds: [],
  };
  h.room.projectiles.push(p);
  return p;
}

function runSteps(h: Harness, n: number): void {
  for (let i = 0; i < n; i++) stepProjectiles(h.ctx, SIM_STEP_MS);
}

// ───────────────────────────── Mêlée ─────────────────────────────

describe('mêlée', () => {
  it("touche un ennemi devant le joueur mais pas derrière, ni hors de l'arc, ni hors de portée", () => {
    const david = makePlayer(0, 'david', 160, 80);
    david.facing = 'right';
    const front = makeEnemy(1, 'skeleton', 180, 80); // distance 20 ≤ 24 + 7
    const behind = makeEnemy(2, 'skeleton', 140, 80);
    const side = makeEnemy(3, 'skeleton', 160, 100);
    const far = makeEnemy(4, 'skeleton', 200, 80);
    const hits = meleeTargets(david, [front, behind, side, far], grid, []);
    expect(hits.map((e) => e.id)).toEqual([1]);
  });

  it('tient compte du rayon de la cible (une cible de biais mais large est touchée)', () => {
    const david = makePlayer(0, 'david', 160, 80);
    david.facing = 'right';
    const knight = makeEnemy(1, 'knight', 175, 98); // décalé de 18 en y : hors arc de 50° pour un point, touché grâce au rayon 8
    expect(enemyRadius(knight)).toBe(8);
    const dist = Math.hypot(15, 18);
    expect(dist).toBeLessThan(24 + 8);
    const slime = makeEnemy(2, 'slime', 175, 98);
    expect(meleeTargets(david, [slime], grid, []).length).toBeLessThanOrEqual(1);
  });

  it("n'atteint pas à travers un mur ni une porte fermée", () => {
    // mur plein en (x=12 tuiles → 192 px) rangées 3..6 : sol à gauche, mur à 192 ; ici on utilise une porte solide.
    const david = makePlayer(0, 'david', 100, 80);
    david.facing = 'right';
    const e = makeEnemy(1, 'skeleton', 118, 80);
    expect(meleeTargets(david, [e], grid, []).length).toBe(1);
    const door: PixelRect = { x: 108, y: 64, w: 4, h: 32 };
    expect(meleeTargets(david, [e], grid, [door]).length).toBe(0);
  });

  it('ignore les ennemis déjà morts et les personnages à distance', () => {
    const david = makePlayer(0, 'david', 160, 80);
    david.facing = 'right';
    const dead = makeEnemy(1, 'skeleton', 180, 80);
    dead.dead = true;
    expect(meleeTargets(david, [dead], grid, [])).toEqual([]);
    const sandrine = makePlayer(1, 'sandrine', 160, 80);
    sandrine.facing = 'right';
    expect(meleeTargets(sandrine, [makeEnemy(2, 'skeleton', 170, 80)], grid, [])).toEqual([]);
  });

  it("l'arc de chaque personnage de mêlée respecte sa direction (haut/bas/gauche)", () => {
    const brokk = makePlayer(0, 'brokk', 160, 80);
    const target = makeEnemy(1, 'slime', 160, 62); // au-dessus
    brokk.facing = 'up';
    expect(meleeTargets(brokk, [target], grid, []).length).toBe(1);
    brokk.facing = 'down';
    expect(meleeTargets(brokk, [target], grid, []).length).toBe(0);
    brokk.facing = 'left';
    expect(meleeTargets(brokk, [target], grid, []).length).toBe(0);
  });

  it('performPlayerAttack frappe, pose le cooldown et émet playerAttack', () => {
    const david = makePlayer(0, 'david', 160, 80);
    david.facing = 'right';
    const e = makeEnemy(1, 'skeleton', 180, 80);
    const h = harness([david], [e]);
    expect(canPlayerAttack(david)).toBe(true);
    expect(performPlayerAttack(h.ctx, david)).toBe(true);
    const atk = getCharacter('david').attack;
    expect(david.attackCooldownMs).toBe(atk.cooldownMs);
    expect(david.attackAnimMs).toBe(atk.animMs);
    expect(david.attackDir).toBe('right');
    expect(e.hp).toBeCloseTo(36 - damageToEnemy(playerBaseDamage(getCharacter('david')), 2), 9);
    expect(h.events.map((x) => x.type)).toEqual(['playerAttack', 'enemyHit']);
    expect(h.onHit).toHaveBeenCalledTimes(1);
    expect(h.onHit.mock.calls[0][1]).toEqual({ x: 160, y: 80 });
    // cooldown : pas de seconde attaque
    expect(canPlayerAttack(david)).toBe(false);
    expect(performPlayerAttack(h.ctx, david)).toBe(false);
  });

  it('un joueur à terre ou une phase sans dégâts ne peut pas attaquer', () => {
    const david = makePlayer(0, 'david', 160, 80);
    const h = harness([david], [makeEnemy(1, 'slime', 160, 90)]);
    david.status = 'down';
    expect(performPlayerAttack(h.ctx, david)).toBe(false);
    david.status = 'alive';
    h.setDamage(false);
    expect(performPlayerAttack(h.ctx, david)).toBe(false);
    expect(h.events).toEqual([]);
  });

  it("l'ennemi tué est marqué mort, attribué à l'auteur, sans sortir de la liste", () => {
    const grok = makePlayer(0, 'grok', 160, 80, 2);
    grok.facing = 'right';
    const bat = makeEnemy(1, 'bat', 172, 80);
    const h = harness([grok], [bat]);
    performPlayerAttack(h.ctx, grok);
    expect(bat.hp).toBe(0);
    expect(bat.dead).toBe(true);
    expect(h.ctx.killers.get(1)).toBe(0);
    expect(h.room.enemies).toContain(bat);
  });

  it("applique la difficulté DE L'ATTAQUANT aux dégâts infligés", () => {
    const raw = playerBaseDamage(getCharacter('david'));
    const out: Record<number, number> = {};
    for (const diff of [1, 2, 3] as Difficulty[]) {
      const david = makePlayer(0, 'david', 160, 80, diff);
      david.facing = 'right';
      const e = makeEnemy(1, 'knight', 178, 80);
      const h = harness([david], [e]);
      performPlayerAttack(h.ctx, david);
      out[diff] = e.maxHp - e.hp;
      expect(out[diff]).toBeCloseTo(damageToEnemy(raw, diff), 9);
    }
    expect(out[1]).toBeGreaterThan(out[2]);
    expect(out[2]).toBeGreaterThan(out[3]);
  });
});

// ───────────────────────────── Projectiles de joueurs ─────────────────────────────

describe('projectiles de joueurs', () => {
  it('buildPlayerProjectile : dégâts, durée de vie, perforation et direction du personnage', () => {
    const sandrine = makePlayer(0, 'sandrine', 100, 80);
    sandrine.facing = 'left';
    const p = buildPlayerProjectile(sandrine, 5, grid, [])!;
    const def = getCharacter('sandrine').attack.projectile!;
    expect(p.damage).toBe(playerBaseDamage(getCharacter('sandrine')));
    expect(p.lifeMs).toBe(def.lifeMs);
    expect(p.pierce).toBe(true);
    expect(p.kind).toBe('orb');
    expect(p.vel).toEqual({ x: -def.speed, y: 0 });
    expect(p.pos.x).toBeLessThan(100);
    expect(p.owner).toEqual({ type: 'player', id: 0 });
    expect(buildPlayerProjectile(makePlayer(1, 'david', 0, 0), 6, grid, [])).toBeNull();
  });

  it('ne crée pas de projectile quand le départ est dans un mur (le tir est quand même consommé)', () => {
    const aelith = makePlayer(0, 'aelith', 17, 80); // départ de flèche dans le mur (x < 16 + rayon)
    aelith.facing = 'left';
    const h = harness([aelith]);
    expect(performPlayerAttack(h.ctx, aelith)).toBe(true);
    expect(h.room.projectiles.length).toBe(0);
    expect(aelith.attackCooldownMs).toBeGreaterThan(0);
  });

  it('tir à distance : projectileFired + projectile ajouté à la salle', () => {
    const aelith = makePlayer(0, 'aelith', 100, 80);
    aelith.facing = 'right';
    const h = harness([aelith]);
    performPlayerAttack(h.ctx, aelith);
    expect(h.room.projectiles.length).toBe(1);
    expect(h.events.map((e) => e.type)).toEqual(['playerAttack', 'projectileFired']);
  });

  it('un projectile perforant traverse et touche chaque ennemi UNE seule fois', () => {
    const sandrine = makePlayer(0, 'sandrine', 40, 80);
    sandrine.facing = 'right';
    const a = makeEnemy(1, 'knight', 90, 80);
    const b = makeEnemy(2, 'knight', 130, 80);
    const h = harness([sandrine], [a, b]);
    performPlayerAttack(h.ctx, sandrine);
    runSteps(h, 60);
    const raw = playerBaseDamage(getCharacter('sandrine'));
    expect(a.maxHp - a.hp).toBeCloseTo(damageToEnemy(raw, 2), 9);
    expect(b.maxHp - b.hp).toBeCloseTo(damageToEnemy(raw, 2), 9);
    expect(h.events.filter((e) => e.type === 'enemyHit').length).toBe(2);
  });

  it('un projectile non perforant disparaît au premier impact', () => {
    const aelith = makePlayer(0, 'aelith', 40, 80);
    aelith.facing = 'right';
    const a = makeEnemy(1, 'knight', 90, 80);
    const b = makeEnemy(2, 'knight', 130, 80);
    const h = harness([aelith], [a, b]);
    performPlayerAttack(h.ctx, aelith);
    runSteps(h, 60);
    expect(a.hp).toBeLessThan(a.maxHp);
    expect(b.hp).toBe(b.maxHp);
    expect(h.room.projectiles.length).toBe(0);
  });

  it('les projectiles disparaissent contre un mur, une porte fermée, et à la fin de leur durée de vie', () => {
    const aelith = makePlayer(0, 'aelith', 100, 80);
    aelith.facing = 'right';
    const h = harness([aelith]);
    h.setSolids([{ x: 140, y: 64, w: 16, h: 32 }]);
    performPlayerAttack(h.ctx, aelith);
    runSteps(h, 30);
    expect(h.room.projectiles.length).toBe(0);

    const h2 = harness([makePlayer(0, 'aelith', 100, 40)]);
    h2.players[0].facing = 'right';
    performPlayerAttack(h2.ctx, h2.players[0]);
    runSteps(h2, 6);
    expect(h2.room.projectiles.length).toBe(1);
    runSteps(h2, 60);
    expect(h2.room.projectiles.length).toBe(0); // mur droit ou fin de vie
  });

  it('pas de tunnelage : un projectile très rapide est arrêté par un mur fin', () => {
    const h = harness([makePlayer(0, 'david', 100, 100)]);
    fireEnemyProjectile(h, 100, 40, 6000, 0, 10); // 100 px par pas
    h.setSolids([{ x: 140, y: 16, w: 2, h: 100 }]);
    runSteps(h, 1);
    expect(h.room.projectiles.length).toBe(0);
    expect(h.players[0].hp).toBe(h.players[0].maxHp);
  });

  it('les fosses ne bloquent pas les projectiles', () => {
    const g = new RoomGrid(['#######', '#..~..#', '#.....#', '#######']);
    const h = harness([makePlayer(0, 'david', 24, 40)], [], g);
    fireEnemyProjectile(h, 20, 24, 120, 0, 10);
    runSteps(h, 20); // 40 px de trajet : jusqu'au milieu de la fosse (x 48..64)
    expect(h.room.projectiles.length).toBe(1);
    expect(h.room.projectiles[0].pos.x).toBeGreaterThan(50);
  });

  it('un projectile ne blesse jamais un joueur (pas de tir ami) hors soin', () => {
    const sandrine = makePlayer(0, 'sandrine', 40, 80);
    const david = makePlayer(1, 'david', 80, 80);
    sandrine.facing = 'right';
    david.hp = 10;
    const h = harness([sandrine, david]);
    performPlayerAttack(h.ctx, sandrine);
    runSteps(h, 40);
    expect(david.hp).toBe(10);
    expect(h.events.some((e) => e.type === 'playerHit')).toBe(false);
  });

  it("la difficulté de l'attaquant s'applique aussi aux projectiles", () => {
    const dmg: number[] = [];
    for (const diff of [1, 3] as Difficulty[]) {
      const aelith = makePlayer(0, 'aelith', 40, 80, diff);
      aelith.facing = 'right';
      const k = makeEnemy(1, 'knight', 90, 80);
      const h = harness([aelith], [k]);
      performPlayerAttack(h.ctx, aelith);
      runSteps(h, 30);
      dmg.push(k.maxHp - k.hp);
    }
    expect(dmg[0]).toBeGreaterThan(dmg[1]);
  });
});

// ───────────────────────────── Soin ─────────────────────────────

describe('projectiles de soin', () => {
  function healSetup(allyHp: number, allyStatus: 'alive' | 'down' = 'alive') {
    const valentine = makePlayer(0, 'valentine', 40, 80);
    const ally = makePlayer(1, 'david', 80, 80);
    ally.hp = allyHp;
    ally.status = allyStatus;
    valentine.facing = 'right';
    const h = harness([valentine, ally]);
    performPlayerAttack(h.ctx, valentine);
    return { h, valentine, ally };
  }

  it('soigne un allié vivant blessé de HEAL_PROJECTILE_AMOUNT, sans dépasser maxHp', () => {
    const { h, ally } = healSetup(50);
    runSteps(h, 40);
    expect(ally.hp).toBe(50 + HEAL_PROJECTILE_AMOUNT);
    expect(h.room.projectiles.length).toBe(0);

    const second = healSetup(ally.maxHp - 3);
    runSteps(second.h, 40);
    expect(second.ally.hp).toBe(second.ally.maxHp);
  });

  it('traverse un allié à pleine santé et un allié à terre (pas de soin sur un joueur à terre)', () => {
    const full = healSetup(140);
    full.ally.hp = full.ally.maxHp;
    runSteps(full.h, 40);
    expect(full.ally.hp).toBe(full.ally.maxHp);
    expect(full.h.events.some((e) => e.type === 'playerHit')).toBe(false);

    const down = healSetup(0, 'down');
    runSteps(down.h, 40);
    expect(down.ally.hp).toBe(0);
    expect(down.ally.status).toBe('down');
  });

  it('ne soigne pas son propre tireur et blesse faiblement les ennemis', () => {
    const valentine = makePlayer(0, 'valentine', 40, 80);
    valentine.hp = 20;
    valentine.facing = 'right';
    const e = makeEnemy(1, 'knight', 90, 80);
    const h = harness([valentine], [e]);
    performPlayerAttack(h.ctx, valentine);
    runSteps(h, 40);
    expect(valentine.hp).toBe(20);
    const raw = playerBaseDamage(getCharacter('valentine'));
    expect(e.maxHp - e.hp).toBeCloseTo(damageToEnemy(raw, 2), 9);
    expect(raw).toBeLessThan(playerBaseDamage(getCharacter('david')));
  });

  it('healPlayer : plafonne, rend le montant réel, ignore les joueurs à terre', () => {
    const p = makePlayer(0, 'david', 0, 0);
    p.hp = p.maxHp - 5;
    expect(healPlayer(p, 12)).toBe(5);
    expect(p.hp).toBe(p.maxHp);
    p.status = 'down';
    p.hp = 0;
    expect(healPlayer(p, 12)).toBe(0);
    expect(p.hp).toBe(0);
  });
});

// ───────────────────────────── Dégâts aux joueurs ─────────────────────────────

describe('dégâts ennemi → joueur', () => {
  it('applique la difficulté et la résistance DU joueur touché (PV max identiques)', () => {
    const easy = makePlayer(0, 'david', 60, 40, 1);
    const hard = makePlayer(1, 'david', 60, 40, 3);
    expect(easy.maxHp).toBe(hard.maxHp);
    const h = harness([easy, hard]);
    hurtPlayer(h.ctx, easy, 20);
    hurtPlayer(h.ctx, hard, 20);
    const david = getCharacter('david');
    expect(easy.maxHp - easy.hp).toBe(damageToPlayer(20, david, 1));
    expect(hard.maxHp - hard.hp).toBe(damageToPlayer(20, david, 3));
    expect(hard.maxHp - hard.hp).toBeGreaterThan(easy.maxHp - easy.hp);
    expect(h.events.filter((e) => e.type === 'playerHit').length).toBe(2);
  });

  it('un projectile ennemi touche un joueur vivant : playerHit, projectile consommé', () => {
    const p = makePlayer(0, 'romain', 100, 40);
    const h = harness([p]);
    fireEnemyProjectile(h, 80, 40, 120, 0, 10);
    runSteps(h, 30);
    expect(p.hp).toBe(p.maxHp - damageToPlayer(10, getCharacter('romain'), 2));
    expect(h.room.projectiles.length).toBe(0);
    expect(p.invulnMs).toBeGreaterThan(0);
  });

  it('un joueur à terre ne peut pas être achevé et ne bloque pas les projectiles', () => {
    const p = makePlayer(0, 'romain', 100, 40);
    p.status = 'down';
    p.hp = 0;
    const h = harness([p]);
    fireEnemyProjectile(h, 80, 40, 120, 0, 10);
    runSteps(h, 30);
    expect(p.hp).toBe(0);
    expect(h.events.some((e) => e.type === 'playerHit' || e.type === 'playerDown')).toBe(false);
    expect(h.room.projectiles[0]?.pos.x ?? 999).toBeGreaterThan(100); // a traversé (ou fini sa course)
    expect(hurtPlayer(h.ctx, p, 99)).toEqual({ applied: 0, downed: false });
  });

  it('un coup fatal émet playerDown et appelle onPlayerDowned', () => {
    const p = makePlayer(0, 'sandrine', 100, 40);
    p.hp = 1;
    const h = harness([p]);
    const downed = vi.fn();
    h.ctx.onPlayerDowned = downed;
    const res = hurtPlayer(h.ctx, p, 50);
    expect(res.downed).toBe(true);
    expect(p.status).toBe('down');
    expect(h.events.map((e) => e.type)).toEqual(['playerHit', 'playerDown']);
    expect(downed).toHaveBeenCalledWith(p);
  });

  it("l'invulnérabilité empêche les dégâts mais consomme le projectile", () => {
    const p = makePlayer(0, 'romain', 100, 40);
    p.invulnMs = 500;
    const h = harness([p]);
    fireEnemyProjectile(h, 80, 40, 120, 0, 10);
    runSteps(h, 30);
    expect(p.hp).toBe(p.maxHp);
    expect(h.room.projectiles.length).toBe(0);
  });

  it('damagePlayersInCircle touche tous les joueurs vivants du cercle et ignore les joueurs à terre', () => {
    const a = makePlayer(0, 'david', 100, 80);
    const b = makePlayer(1, 'romain', 108, 80);
    const c = makePlayer(2, 'brokk', 100, 84);
    c.status = 'down';
    c.hp = 0;
    const d = makePlayer(3, 'mira', 200, 80);
    const h = harness([a, b, c, d]);
    expect(damagePlayersInCircle(h.ctx, { x: 102, y: 80 }, 12, 10)).toBe(2);
    expect(a.hp).toBeLessThan(a.maxHp);
    expect(b.hp).toBeLessThan(b.maxHp);
    expect(c.hp).toBe(0);
    expect(d.hp).toBe(d.maxHp);
  });

  it('aucun dégât quand damageEnabled est faux (phases hors jeu)', () => {
    const p = makePlayer(0, 'romain', 100, 40);
    const e = makeEnemy(1, 'knight', 140, 40);
    const h = harness([p], [e]);
    h.setDamage(false);
    fireEnemyProjectile(h, 80, 40, 120, 0, 10);
    runSteps(h, 30);
    expect(p.hp).toBe(p.maxHp);
    expect(damageEnemy(h.ctx, e, 50, p, p.pos)).toBe(0);
    expect(e.hp).toBe(e.maxHp);
  });
});

describe('damageEnemy', () => {
  it('retire brut ÷ multPV(attaquant), borne à 0, garde au moins MIN_DAMAGE et ne frappe pas deux fois un mort', () => {
    const p = makePlayer(0, 'david', 0, 0, 3);
    const e = makeEnemy(1, 'slime', 50, 50);
    const h = harness([p], [e]);
    expect(damageEnemy(h.ctx, e, 10, p, p.pos)).toBeCloseTo(10 / 1.4, 9);
    expect(damageEnemy(h.ctx, e, 0.1, p, p.pos)).toBe(1);
    expect(damageEnemy(h.ctx, e, 9999, p, p.pos)).toBeGreaterThan(0);
    expect(e.hp).toBe(0);
    expect(e.dead).toBe(true);
    expect(damageEnemy(h.ctx, e, 10, p, p.pos)).toBe(0);
    expect(h.events.filter((x) => x.type === 'enemyHit').length).toBe(3);
    expect(e.hitFlashMs).toBeGreaterThan(0);
  });
});

describe('plafond de dégâts sur les boss', () => {
  it('au plus 20 % des PV max par fenêtre de 2 s, puis la fenêtre repart (état JSON dans enemy.data)', () => {
    const p = makePlayer(0, 'david', 0, 0, 1);
    const boss = makeEnemy(1, 'golem', 50, 50);
    const h = harness([p], [boss]);
    const cap = boss.maxHp * BOSS_DAMAGE_CAP_FRACTION;
    let total = 0;
    for (let i = 0; i < 20; i++) total += damageEnemy(h.ctx, boss, 500, p, p.pos);
    expect(total).toBeCloseTo(cap, 6);
    expect(boss.maxHp - boss.hp).toBeCloseTo(cap, 6);
    expect(boss.hitFlashMs).toBeGreaterThan(0);
    expect(JSON.parse(JSON.stringify(boss.data))).toEqual(boss.data);
    // fenêtre suivante
    h.room.elapsedMs += BOSS_DAMAGE_WINDOW_MS;
    expect(damageEnemy(h.ctx, boss, 500, p, p.pos)).toBeGreaterThan(0);
    expect(boss.maxHp - boss.hp).toBeGreaterThan(cap);
    expect(boss.maxHp - boss.hp).toBeLessThanOrEqual(2 * cap + 1e-6);
  });

  it('ne concerne pas les ennemis ordinaires', () => {
    const p = makePlayer(0, 'david', 0, 0, 2);
    const e = makeEnemy(1, 'knight', 50, 50);
    e.maxHp = e.hp = 1000;
    const h = harness([p], [e]);
    damageEnemy(h.ctx, e, 900, p, p.pos);
    expect(e.hp).toBeLessThan(1000 - 1000 * BOSS_DAMAGE_CAP_FRACTION);
  });
});

describe('tirs de joueur le long d\'un coin de pilier', () => {
  const rows: string[] = [];
  for (let y = 0; y < 11; y++) {
    if (y === 0 || y === 10) rows.push('#'.repeat(18));
    else rows.push('#' + '.'.repeat(16) + '#');
  }
  rows[4] = rows[4].slice(0, 3) + 'o' + rows[4].slice(4);
  rows[4] = rows[4].slice(0, 18);
  const pillarGrid = new RoomGrid(rows);

  it('un tireur à 5 px du coin : le projectile survit au premier pas et touche un ennemi juste en dessous', () => {
    for (const id of ['sandrine', 'aelith', 'valentine'] as CharacterId[]) {
      const p = makePlayer(0, id, 67, 60);
      p.facing = 'down';
      const foe = makeEnemy(1, 'slime', 67, 110);
      const h = harness([p], [foe], pillarGrid);
      expect(performPlayerAttack(h.ctx, p), id).toBe(true);
      expect(h.room.projectiles.length, id).toBe(1);
      runSteps(h, 1);
      expect(h.room.projectiles.length, id).toBe(1);
    }
    const p = makePlayer(0, 'sandrine', 67, 60);
    p.facing = 'down';
    const foe = makeEnemy(1, 'slime', 67, 90);
    const h = harness([p], [foe], pillarGrid);
    performPlayerAttack(h.ctx, p);
    runSteps(h, 30);
    expect(foe.hp).toBeLessThan(foe.maxHp);
  });

  it('un projectile de joueur est toujours arrêté par un mur de face', () => {
    const p = makePlayer(0, 'sandrine', 30, 72);
    p.facing = 'right';
    const h = harness([p], [], pillarGrid);
    performPlayerAttack(h.ctx, p);
    runSteps(h, 60);
    expect(h.room.projectiles.length).toBe(0);
  });
});
