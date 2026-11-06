import { describe, expect, it } from 'vitest';
import { createEnemyState, knockEnemy, onEnemyHit, stunEnemy } from './ai';
import { damageToEnemy, playerBaseDamage, playerSpecialDamage } from './balance';
import { CHARACTER_IDS, CHARACTER_LIST, getCharacter, getSpecialDef, specialFraction } from './characters';
import {
  bladeDanceHitsDone,
  canPlayerSpecial,
  performPlayerAttack,
  performPlayerSpecial,
  stepProjectiles,
  stepSpecialEffects,
  type CombatContext,
} from './combat';
import { PLAYER_INVULN_MS, SIM_STEP_MS, TILE } from './constants';
import { RoomGrid } from './grid';
import { makeTestLayout, makeTestLevel, makeTestRoom } from './levelValidation';
import { applyDamageToPlayer, createPlayerState, resetPlayersForRoom, stepPlayerTimers } from './players';
import { createRng, nextRandom } from './rng';
import { createSimulation, GameSimulation } from './simulation';
import type {
  ActionFrame,
  CharacterId,
  Difficulty,
  Dir,
  EnemyKind,
  EnemyState,
  PlayerId,
  PlayerState,
  SimEvent,
  TickInputs,
} from './types';

// ───────────────────────────── Harnais unitaire (sans simulation) ─────────────────────────────

const DT = SIM_STEP_MS;

interface Harness {
  ctx: CombatContext;
  players: PlayerState[];
  enemies: EnemyState[];
  events: SimEvent[];
}

function mkPlayer(
  id: PlayerId,
  characterId: CharacterId,
  x: number,
  y: number,
  facing: Dir = 'right',
  difficulty: Difficulty = 2,
): PlayerState {
  const p = createPlayerState({ id, characterId, difficulty }, { x, y });
  p.facing = facing;
  return p;
}

/** Arène ouverte 30×20 tuiles ; ennemis et joueurs fournis ; contexte de combat complet (stun/recul branchés sur ai.ts). */
function harness(players: PlayerState[], layout: string[] = makeTestLayout(30, 20)): Harness {
  const events: SimEvent[] = [];
  const enemies: EnemyState[] = [];
  let nid = 1000;
  const ctx: CombatContext = {
    room: { roomId: 'r', enemies, projectiles: [], mechanisms: [], spawnedSpawnIdx: [], elapsedMs: 0 },
    players,
    grid: new RoomGrid(layout),
    solids: [],
    events,
    nextId: () => nid++,
    onEnemyHit: (e, from, raw) => onEnemyHit(e, from, raw),
    killers: new Map(),
    damageEnabled: true,
    stunEnemy: (e, ms) => {
      stunEnemy(e, ms);
    },
    knockEnemy: (e, from, speed) => {
      knockEnemy(e, from, speed);
    },
  };
  return { ctx, players, enemies, events };
}

let enemyId = 1;
function addEnemy(h: Harness, kind: EnemyKind, x: number, y: number, hp?: number): EnemyState {
  const e = createEnemyState(kind, { x, y }, enemyId++, 0);
  if (hp !== undefined) {
    e.hp = hp;
    e.maxHp = hp;
  }
  h.enemies.push(e);
  return e;
}

const hpLost = (e: EnemyState): number => e.maxHp - e.hp;

/** Dégâts d'un coup normal du personnage (mêlée) sur un ennemi, difficulté normale. */
function normalHit(characterId: CharacterId): number {
  return damageToEnemy(playerBaseDamage(getCharacter(characterId)), 2);
}

// ───────────────────────────── Données ─────────────────────────────

describe('SpecialDef des 8 personnages', () => {
  it('chaque personnage a un spécial distinct, recharge 9–20 s, clés i18n conventionnelles', () => {
    const kinds = new Set<string>();
    for (const c of CHARACTER_LIST) {
      const sp = c.special;
      expect(sp, c.id).toBeDefined();
      if (!sp) continue;
      kinds.add(sp.kind);
      expect(sp.nameKey).toBe(`character.${c.id}.special.name`);
      expect(sp.descKey).toBe(`character.${c.id}.special.desc`);
      expect(sp.cooldownMs).toBeGreaterThanOrEqual(9000);
      expect(sp.cooldownMs).toBeLessThanOrEqual(20000);
      expect(sp.damageMult).toBeGreaterThan(0);
      expect(sp.radius).toBeGreaterThan(0);
      expect(sp.animMs).toBeGreaterThan(0);
      expect(getSpecialDef(c.id)).toBe(sp);
    }
    expect(kinds.size).toBe(8);
  });

  it('valeurs de la mission (portées, rayons, multiplicateurs)', () => {
    expect(getSpecialDef('david')).toMatchObject({ kind: 'whirlwind', radius: 46, damageMult: 3.5, cooldownMs: 14000 });
    expect(getSpecialDef('sandrine')).toMatchObject({ kind: 'fireNova', radius: 58, range: 64, damageMult: 6, cooldownMs: 18000 });
    expect(getSpecialDef('romain')).toMatchObject({ kind: 'dash', range: 90, invulnMs: 350, damageMult: 3, cooldownMs: 9000 });
    expect(getSpecialDef('valentine')).toMatchObject({ kind: 'healNova', radius: 72, healFraction: 0.4, damageMult: 2.5, cooldownMs: 20000 });
    expect(getSpecialDef('aelith')).toMatchObject({ kind: 'arrowFan', count: 9, spreadDeg: 40, damageMult: 0.6, cooldownMs: 13000 });
    expect(getSpecialDef('brokk')).toMatchObject({ kind: 'quake', radius: 62, stunMs: 1300, damageMult: 3, cooldownMs: 16000 });
    expect(getSpecialDef('grok')).toMatchObject({ kind: 'smash', arcDeg: 150, range: 46, damageMult: 6, cooldownMs: 17000 });
    expect(getSpecialDef('mira')).toMatchObject({ kind: 'bladeDance', count: 5, radius: 38, damageMult: 1.3, cooldownMs: 12000 });
  });

  it('playerSpecialDamage = (6 + 2.5 × force) × special.damageMult (sans attack.damageMult)', () => {
    const david = getCharacter('david');
    expect(playerSpecialDamage(david)).toBeCloseTo((6 + 2.5 * 8) * 3.5, 9);
    expect(playerSpecialDamage({ strength: 5, special: undefined })).toBe(0);
  });

  it('specialFraction : 1 prêt, 0 juste après usage, monotone, bornée', () => {
    const c = getCharacter('david');
    const p = mkPlayer(0, 'david', 50, 50);
    expect(specialFraction(p, c)).toBe(1);
    p.specialCooldownMs = c.special!.cooldownMs;
    expect(specialFraction(p, c)).toBe(0);
    p.specialCooldownMs = c.special!.cooldownMs / 2;
    expect(specialFraction(p, c)).toBeCloseTo(0.5, 9);
    p.specialCooldownMs = -5;
    expect(specialFraction(p, c)).toBe(1);
    p.specialCooldownMs = 1e9;
    expect(specialFraction(p, c)).toBe(0);
    p.specialCooldownMs = NaN;
    expect(specialFraction(p, c)).toBe(1);
  });

  it('createPlayerState : spécial PRÊT au départ', () => {
    const p = mkPlayer(0, 'mira', 10, 10);
    expect(p.specialCooldownMs).toBe(0);
    expect(p.specialAnimMs).toBe(0);
    expect(canPlayerSpecial(p)).toBe(true);
  });
});

// ───────────────────────────── Un test par kind ─────────────────────────────

describe('whirlwind (David)', () => {
  it('touche à 360° dans le rayon, pas au-delà ; dégâts ≥ 3× un coup normal', () => {
    const p = mkPlayer(0, 'david', 200, 150, 'right');
    const h = harness([p]);
    const front = addEnemy(h, 'knight', 235, 150, 500);
    const behind = addEnemy(h, 'knight', 165, 150, 500);
    const above = addEnemy(h, 'knight', 200, 112, 500);
    const far = addEnemy(h, 'knight', 270, 150, 500);
    expect(performPlayerSpecial(h.ctx, p)).toBe(true);
    const raw = playerSpecialDamage(getCharacter('david'));
    for (const e of [front, behind, above]) expect(hpLost(e)).toBeCloseTo(damageToEnemy(raw, 2), 9);
    expect(hpLost(far)).toBe(0);
    expect(hpLost(front)).toBeGreaterThanOrEqual(3 * normalHit('david'));
    const ev = h.events.find((e) => e.type === 'specialUsed');
    expect(ev).toMatchObject({ type: 'specialUsed', playerId: 0, kind: 'whirlwind', dir: 'right' });
  });

  it('pas de coup à travers un mur', () => {
    const layout = makeTestLayout(30, 20).map((r) => r.split(''));
    for (let y = 1; y < 19; y++) layout[y][14] = '#';
    const p = mkPlayer(0, 'david', 14 * TILE - 10, 150, 'right');
    const h = harness([p], layout.map((r) => r.join('')));
    const behindWall = addEnemy(h, 'knight', 14 * TILE + 24, 150, 500);
    performPlayerSpecial(h.ctx, p);
    expect(hpLost(behindWall)).toBe(0);
  });
});

describe('fireNova (Sandrine)', () => {
  it('explose ≈ 64 px devant elle (rayon 58) : dans la direction visée seulement', () => {
    const p = mkPlayer(0, 'sandrine', 200, 150, 'right');
    const h = harness([p]);
    const inNova = addEnemy(h, 'knight', 264, 190, 500); // 40 px sous le centre (264,150)
    const edge = addEnemy(h, 'knight', 264, 150 - 60, 500); // 60 ≤ 58 + 6
    const outNova = addEnemy(h, 'knight', 264, 150 + 70, 500);
    const behind = addEnemy(h, 'knight', 150, 150, 500);
    performPlayerSpecial(h.ctx, p);
    const dmg = damageToEnemy(playerSpecialDamage(getCharacter('sandrine')), 2);
    expect(hpLost(inNova)).toBeCloseTo(dmg, 9);
    expect(hpLost(edge)).toBeCloseTo(dmg, 9);
    expect(hpLost(outNova)).toBe(0);
    expect(hpLost(behind)).toBe(0);
    expect(dmg).toBeGreaterThanOrEqual(3 * normalHit('sandrine'));
    const ev = h.events.find((e) => e.type === 'specialUsed');
    expect(ev && ev.type === 'specialUsed' ? ev.pos : null).toEqual({ x: 264, y: 150 });
  });

  it('orientée vers la gauche, le centre passe de l\'autre côté', () => {
    const p = mkPlayer(0, 'sandrine', 200, 150, 'left');
    const h = harness([p]);
    const left = addEnemy(h, 'knight', 140, 150, 500);
    const right = addEnemy(h, 'knight', 260, 150, 500);
    performPlayerSpecial(h.ctx, p);
    expect(hpLost(left)).toBeGreaterThan(0);
    expect(hpLost(right)).toBe(0);
  });

  it('le centre est ramené devant un mur proche', () => {
    const p = mkPlayer(0, 'sandrine', 14 * TILE - 8, 150, 'right');
    const layout = makeTestLayout(30, 20).map((r) => r.split(''));
    for (let y = 1; y < 19; y++) layout[y][15] = '#';
    const h = harness([p], layout.map((r) => r.join('')));
    performPlayerSpecial(h.ctx, p);
    const ev = h.events.find((e) => e.type === 'specialUsed');
    expect(ev && ev.type === 'specialUsed' ? ev.pos.x : 999).toBeLessThan(15 * TILE);
  });
});

describe('dash (Romain)', () => {
  it('charge de 90 px dans la direction visée, blesse les traversés (×3), invulnérable 350 ms', () => {
    const p = mkPlayer(0, 'romain', 100, 150, 'right');
    const h = harness([p]);
    const inPath = addEnemy(h, 'knight', 150, 152, 500);
    const offPath = addEnemy(h, 'knight', 150, 185, 500);
    const beyond = addEnemy(h, 'knight', 220, 150, 500);
    expect(performPlayerSpecial(h.ctx, p)).toBe(true);
    expect(p.pos.x).toBeCloseTo(190, 0);
    expect(p.pos.y).toBeCloseTo(150, 5);
    const dmg = damageToEnemy(playerSpecialDamage(getCharacter('romain')), 2);
    expect(hpLost(inPath)).toBeCloseTo(dmg, 9);
    expect(hpLost(offPath)).toBe(0);
    expect(hpLost(beyond)).toBe(0);
    expect(dmg).toBeGreaterThanOrEqual(3 * normalHit('romain'));
    expect(p.invulnMs).toBeGreaterThanOrEqual(350);
    expect(applyDamageToPlayer(p, 50)).toEqual({ applied: 0, downed: false });
    const hp = p.hp;
    p.invulnMs = 350;
    stepPlayerTimers(p, 351);
    expect(p.invulnMs).toBe(0);
    expect(applyDamageToPlayer(p, 5).applied).toBeGreaterThan(0);
    expect(p.hp).toBeLessThan(hp);
  });

  it('va vers le haut / la gauche selon le facing', () => {
    const up = mkPlayer(0, 'romain', 200, 200, 'up');
    const h = harness([up]);
    performPlayerSpecial(h.ctx, up);
    expect(up.pos.y).toBeCloseTo(110, 0);
    expect(up.pos.x).toBeCloseTo(200, 5);
    const left = mkPlayer(0, 'romain', 200, 200, 'left');
    performPlayerSpecial(harness([left]).ctx, left);
    expect(left.pos.x).toBeCloseTo(110, 0);
  });

  it('respecte les collisions : arrêtée par un mur, jamais dedans', () => {
    const p = mkPlayer(0, 'romain', 28 * TILE - 20, 150, 'right');
    const h = harness([p]);
    performPlayerSpecial(h.ctx, p);
    expect(p.pos.x).toBeLessThanOrEqual(29 * TILE - 5 + 1e-6);
    expect(p.pos.x).toBeGreaterThan(28 * TILE - 20);
  });

  it('respecte une porte fermée (solide dynamique)', () => {
    const p = mkPlayer(0, 'romain', 100, 150, 'right');
    const h = harness([p]);
    h.ctx.solids = [{ x: 130, y: 100, w: 16, h: 100 }];
    performPlayerSpecial(h.ctx, p);
    expect(p.pos.x).toBeLessThanOrEqual(130 - 5 + 1e-6);
  });
});

describe('healNova (Valentine)', () => {
  it('soigne 40 % des PV max des alliés vivants dans le rayon (elle incluse), plafonné ; pas de relevage', () => {
    const v = mkPlayer(0, 'valentine', 200, 150, 'right');
    const near = mkPlayer(1, 'david', 250, 150, 'right');
    const nearFull = mkPlayer(2, 'brokk', 200, 190, 'right');
    const far = mkPlayer(3, 'mira', 300, 150, 'right');
    const downed = mkPlayer(3, 'mira', 210, 150, 'right');
    v.hp = 1;
    near.hp = 1;
    nearFull.hp = nearFull.maxHp - 3;
    far.hp = 1;
    downed.hp = 0;
    downed.status = 'down';
    const h = harness([v, near, nearFull, far, downed]);
    const foe = addEnemy(h, 'knight', 230, 150, 500);
    const foeFar = addEnemy(h, 'knight', 300, 150, 500);
    performPlayerSpecial(h.ctx, v);
    expect(v.hp).toBe(1 + Math.round(v.maxHp * 0.4));
    expect(near.hp).toBe(1 + Math.round(near.maxHp * 0.4));
    expect(nearFull.hp).toBe(nearFull.maxHp);
    expect(far.hp).toBe(1);
    expect(downed.status).toBe('down');
    expect(downed.hp).toBe(0);
    expect(downed.reviveProgressMs).toBe(0);
    expect(hpLost(foe)).toBeCloseTo(damageToEnemy(playerSpecialDamage(getCharacter('valentine')), 2), 9);
    expect(hpLost(foeFar)).toBe(0);
    expect(hpLost(foe)).toBeGreaterThanOrEqual(3 * normalHit('valentine'));
  });
});

describe('arrowFan (Aelith)', () => {
  it('9 flèches perforantes réparties sur ±40°, dégâts bruts = special damage', () => {
    const p = mkPlayer(0, 'aelith', 200, 150, 'right');
    const h = harness([p]);
    expect(performPlayerSpecial(h.ctx, p)).toBe(true);
    const arrows = h.ctx.room.projectiles;
    expect(arrows).toHaveLength(9);
    const raw = playerSpecialDamage(getCharacter('aelith'));
    const angles = arrows.map((a) => (Math.atan2(a.vel.y, a.vel.x) * 180) / Math.PI);
    expect(Math.min(...angles)).toBeCloseTo(-40, 5);
    expect(Math.max(...angles)).toBeCloseTo(40, 5);
    for (const a of arrows) {
      expect(a.pierce).toBe(true);
      expect(a.kind).toBe('arrow');
      expect(a.damage).toBeCloseTo(raw, 9);
      expect(a.owner).toEqual({ type: 'player', id: 0 });
    }
    expect(h.events.filter((e) => e.type === 'projectileFired')).toHaveLength(9);
  });

  it('orientée vers le haut : toutes les flèches montent', () => {
    const p = mkPlayer(0, 'aelith', 200, 150, 'up');
    const h = harness([p]);
    performPlayerSpecial(h.ctx, p);
    for (const a of h.ctx.room.projectiles) expect(a.vel.y).toBeLessThan(0);
  });

  it('plusieurs flèches touchent un ennemi proche (≥ 3 touches) ; un ennemi loin hors éventail n\'est pas touché', () => {
    const p = mkPlayer(0, 'aelith', 200, 150, 'right');
    const h = harness([p]);
    const near = addEnemy(h, 'knight', 222, 150, 1000);
    const side = addEnemy(h, 'knight', 215, 150 + 120, 1000);
    performPlayerSpecial(h.ctx, p);
    for (let i = 0; i < 60; i++) stepProjectiles(h.ctx, DT);
    const hits = h.events.filter((e) => e.type === 'enemyHit' && e.enemyId === near.id).length;
    expect(hits).toBeGreaterThanOrEqual(3);
    expect(hpLost(near)).toBeGreaterThanOrEqual(3 * normalHit('aelith'));
    expect(hpLost(side)).toBe(0);
  });

  it('portée limitée (~170 px)', () => {
    const p = mkPlayer(0, 'aelith', 40, 150, 'right');
    const h = harness([p]);
    const far = addEnemy(h, 'knight', 40 + 230, 150, 1000);
    performPlayerSpecial(h.ctx, p);
    for (let i = 0; i < 120; i++) stepProjectiles(h.ctx, DT);
    expect(hpLost(far)).toBe(0);
    expect(h.ctx.room.projectiles).toHaveLength(0);
  });
});

describe('quake (Brokk)', () => {
  it('onde de choc rayon 62, ×3, étourdit ≈ 1,3 s les ennemis touchés', () => {
    const p = mkPlayer(0, 'brokk', 200, 150, 'down');
    const h = harness([p]);
    const a = addEnemy(h, 'slime', 250, 150, 500);
    const b = addEnemy(h, 'skeleton', 200, 100, 500);
    const out = addEnemy(h, 'slime', 290, 150, 500);
    performPlayerSpecial(h.ctx, p);
    const dmg = damageToEnemy(playerSpecialDamage(getCharacter('brokk')), 2);
    expect(hpLost(a)).toBeCloseTo(dmg, 9);
    expect(hpLost(b)).toBeCloseTo(dmg, 9);
    expect(hpLost(out)).toBe(0);
    expect(dmg).toBeGreaterThanOrEqual(3 * normalHit('brokk'));
    expect(a.mode).toBe('stunned');
    expect(a.data.stunMs).toBeGreaterThanOrEqual(1300);
    expect(b.data.stunMs).toBeGreaterThanOrEqual(1300);
    expect(out.data.stunMs).toBe(0);
  });

  it('un boss n\'est jamais étourdi ni immobilisé (simple léger retard d\'attaque)', () => {
    const p = mkPlayer(0, 'brokk', 200, 150, 'down');
    const h = harness([p]);
    const boss = addEnemy(h, 'golem', 230, 150);
    boss.mode = 'chase';
    performPlayerSpecial(h.ctx, p);
    expect(boss.mode).toBe('chase');
    expect(boss.data.stunMs).toBe(0);
    expect(boss.attackCooldownMs).toBeLessThanOrEqual(400);
    expect(hpLost(boss)).toBeGreaterThan(0);
    expect(boss.dead).toBe(false);
  });

  it('stunEnemy : ignore un ennemi mort et les durées invalides', () => {
    const e = createEnemyState('slime', { x: 0, y: 0 }, 1, 0);
    expect(stunEnemy(e, NaN)).toBe(false);
    expect(stunEnemy(e, -10)).toBe(false);
    expect(stunEnemy(e, 500)).toBe(true);
    e.dead = true;
    const d = createEnemyState('slime', { x: 0, y: 0 }, 2, 0);
    d.dead = true;
    expect(stunEnemy(d, 500)).toBe(false);
  });
});

describe('smash (Grok)', () => {
  it('cône de 150° sur 46 px, ×6, avec fort recul ; rien derrière ni hors portée', () => {
    const p = mkPlayer(0, 'grok', 200, 150, 'right');
    const h = harness([p]);
    const front = addEnemy(h, 'slime', 240, 150, 500);
    const diag = addEnemy(h, 'slime', 200 + 30 * Math.cos(1.1), 150 + 30 * Math.sin(1.1), 500); // ~63° < 75°
    const side = addEnemy(h, 'slime', 200, 190, 500); // 90° > 75° (+marge de rayon faible à cette distance)
    const behind = addEnemy(h, 'slime', 160, 150, 500);
    const far = addEnemy(h, 'slime', 270, 150, 500);
    performPlayerSpecial(h.ctx, p);
    const dmg = damageToEnemy(playerSpecialDamage(getCharacter('grok')), 2);
    expect(hpLost(front)).toBeCloseTo(dmg, 9);
    expect(hpLost(diag)).toBeCloseTo(dmg, 9);
    expect(hpLost(side)).toBe(0);
    expect(hpLost(behind)).toBe(0);
    expect(hpLost(far)).toBe(0);
    expect(dmg).toBeGreaterThanOrEqual(3 * normalHit('grok'));
    // recul fort, orienté à l'opposé du troll
    expect(front.data.kbx).toBeGreaterThan(150);
    expect(Math.abs(front.data.kby)).toBeLessThan(1e-6);
  });

  it('knockEnemy : sans effet sur boss et chevalier', () => {
    const boss = createEnemyState('golem', { x: 10, y: 10 }, 1, 0);
    const knight = createEnemyState('knight', { x: 10, y: 10 }, 2, 0);
    expect(knockEnemy(boss, { x: 0, y: 10 }, 200)).toBe(false);
    expect(knockEnemy(knight, { x: 0, y: 10 }, 200)).toBe(false);
    expect(knockEnemy(createEnemyState('slime', { x: 10, y: 10 }, 3, 0), { x: 0, y: 10 }, 200)).toBe(true);
  });
});

describe('bladeDance (Mira)', () => {
  it('5 coups en 600 ms (le 1er immédiat), rayon 38, ×1,3 chacun, invulnérable pendant la danse', () => {
    const p = mkPlayer(0, 'mira', 200, 150, 'right');
    const h = harness([p]);
    const e = addEnemy(h, 'knight', 225, 150, 5000);
    const out = addEnemy(h, 'knight', 260, 150, 5000);
    expect(performPlayerSpecial(h.ctx, p)).toBe(true);
    const per = damageToEnemy(playerSpecialDamage(getCharacter('mira')), 2);
    expect(hpLost(e)).toBeCloseTo(per, 9);
    expect(p.invulnMs).toBeGreaterThanOrEqual(600);
    // avance le temps : coups différés
    let steps = 0;
    while (p.specialAnimMs > 0 && steps < 200) {
      const before = p.specialAnimMs;
      stepPlayerTimers(p, DT);
      stepSpecialEffects(h.ctx, p, before);
      if (p.invulnMs > 0) expect(applyDamageToPlayer(p, 30).applied).toBe(0);
      steps++;
    }
    expect(hpLost(e)).toBeCloseTo(5 * per, 6);
    expect(hpLost(out)).toBe(0);
    expect(steps).toBeGreaterThan(30);
    expect(steps).toBeLessThan(40);
    expect(per * 5).toBeGreaterThanOrEqual(3 * normalHit('mira'));
  });

  it('bladeDanceHitsDone : 1 au départ, 5 à la fin, jamais plus', () => {
    const def = getSpecialDef('mira')!;
    expect(bladeDanceHitsDone(def, def.animMs)).toBe(1);
    expect(bladeDanceHitsDone(def, def.animMs - 119)).toBe(1);
    expect(bladeDanceHitsDone(def, def.animMs - 121)).toBe(2);
    expect(bladeDanceHitsDone(def, 0)).toBe(5);
    expect(bladeDanceHitsDone(def, -50)).toBe(5);
    expect(bladeDanceHitsDone(def, 1e9)).toBe(1);
  });

  it('la danse s\'arrête si Mira est mise à terre', () => {
    const p = mkPlayer(0, 'mira', 200, 150, 'right');
    const h = harness([p]);
    const e = addEnemy(h, 'knight', 225, 150, 5000);
    performPlayerSpecial(h.ctx, p);
    p.invulnMs = 0;
    applyDamageToPlayer(p, 100000);
    expect(p.status).toBe('down');
    expect(p.specialAnimMs).toBe(0);
    const lost = hpLost(e);
    const before = 300;
    p.specialAnimMs = 0;
    expect(stepSpecialEffects(h.ctx, p, before)).toBe(0);
    expect(hpLost(e)).toBe(lost);
  });
});

// ───────────────────────────── Règles communes ─────────────────────────────

describe('conditions de déclenchement', () => {
  it('refus : joueur à terre, en train de relever, en recharge, dégâts désactivés', () => {
    const p = mkPlayer(0, 'david', 200, 150);
    const h = harness([p]);
    addEnemy(h, 'knight', 220, 150, 500);

    p.status = 'down';
    expect(canPlayerSpecial(p)).toBe(false);
    expect(performPlayerSpecial(h.ctx, p)).toBe(false);
    p.status = 'alive';

    p.revivingId = 1;
    expect(canPlayerSpecial(p)).toBe(false);
    expect(performPlayerSpecial(h.ctx, p)).toBe(false);
    p.revivingId = null;

    p.specialCooldownMs = 500;
    expect(performPlayerSpecial(h.ctx, p)).toBe(false);
    p.specialCooldownMs = 0;

    const off: CombatContext = { ...h.ctx, damageEnabled: false };
    expect(performPlayerSpecial(off, p)).toBe(false);
    expect(p.specialCooldownMs).toBe(0);

    expect(h.events).toHaveLength(0);
    expect(h.enemies[0].hp).toBe(500);

    expect(performPlayerSpecial(h.ctx, p)).toBe(true);
    expect(p.specialCooldownMs).toBe(14000);
    expect(p.specialAnimMs).toBe(280);
    expect(performPlayerSpecial(h.ctx, p)).toBe(false); // recharge posée
  });

  it('recharge : décrémentée par stepPlayerTimers jusqu\'à 0, puis relançable', () => {
    const p = mkPlayer(0, 'romain', 200, 150);
    const h = harness([p]);
    performPlayerSpecial(h.ctx, p);
    stepPlayerTimers(p, 8999);
    expect(p.specialCooldownMs).toBeCloseTo(1, 6);
    expect(canPlayerSpecial(p)).toBe(false);
    stepPlayerTimers(p, 2);
    expect(p.specialCooldownMs).toBe(0);
    expect(canPlayerSpecial(p)).toBe(true);
  });

  it('resetPlayersForRoom remet le spécial prêt', () => {
    const p = mkPlayer(0, 'david', 200, 150);
    p.specialCooldownMs = 9999;
    p.specialAnimMs = 100;
    resetPlayersForRoom([p], [{ x: 20, y: 20 }]);
    expect(p.specialCooldownMs).toBe(0);
    expect(p.specialAnimMs).toBe(0);
  });

  it('un coup normal ne touche pas au spécial et inversement', () => {
    const p = mkPlayer(0, 'david', 200, 150);
    const h = harness([p]);
    performPlayerAttack(h.ctx, p);
    expect(p.specialCooldownMs).toBe(0);
    performPlayerSpecial(h.ctx, p);
    expect(p.attackCooldownMs).toBe(getCharacter('david').attack.cooldownMs);
  });
});

describe('dégâts, difficulté, kills', () => {
  it('chaque touche émet enemyHit / kills crédités à l\'attaquant', () => {
    const p = mkPlayer(2, 'david', 200, 150);
    const h = harness([p]);
    const weak = addEnemy(h, 'slime', 220, 150);
    const tough = addEnemy(h, 'knight', 180, 150, 500);
    performPlayerSpecial(h.ctx, p);
    const hits = h.events.filter((e) => e.type === 'enemyHit');
    expect(hits).toHaveLength(2);
    for (const e of hits) expect(e.type === 'enemyHit' && e.byPlayer).toBe(2);
    expect(weak.dead).toBe(true);
    expect(tough.dead).toBe(false);
    expect(h.ctx.killers.get(weak.id)).toBe(2);
  });

  it('la difficulté DE L\'ATTAQUANT s\'applique (facile > normal > difficile)', () => {
    const loss: Record<number, number> = {};
    for (const d of [1, 2, 3] as Difficulty[]) {
      const p = mkPlayer(0, 'david', 200, 150, 'right', d);
      const h = harness([p]);
      const e = addEnemy(h, 'knight', 220, 150, 5000);
      performPlayerSpecial(h.ctx, p);
      loss[d] = hpLost(e);
      expect(loss[d]).toBeCloseTo(damageToEnemy(playerSpecialDamage(getCharacter('david')), d), 9);
    }
    expect(loss[1]).toBeGreaterThan(loss[2]);
    expect(loss[2]).toBeGreaterThan(loss[3]);
  });

  it('jamais de one-shot sur les boss, même à difficulté facile (tous les spéciaux)', () => {
    for (const id of CHARACTER_IDS) {
      for (const boss of ['golem', 'morvane'] as const) {
        const p = mkPlayer(0, id, 200, 150, 'right', 1);
        const h = harness([p]);
        const b = addEnemy(h, boss, 215, 150);
        performPlayerSpecial(h.ctx, p);
        for (let i = 0; i < 80; i++) {
          const before = p.specialAnimMs;
          stepPlayerTimers(p, DT);
          stepSpecialEffects(h.ctx, p, before);
          stepProjectiles(h.ctx, DT);
        }
        expect(b.dead, `${id} vs ${boss}`).toBe(false);
        expect(b.hp / b.maxHp, `${id} vs ${boss}`).toBeGreaterThan(0.2);
      }
    }
  });

  it('4 spéciaux simultanés (Aelith, Sandrine, Grok, David) : jamais sous 60 % de PV sur golem et morvane, difficultés 1/2/3', () => {
    for (const boss of ['golem', 'morvane'] as const) {
      for (const diff of [1, 2, 3] as Difficulty[]) {
        const ps = [
          mkPlayer(0, 'aelith', 200, 150, 'right', diff),
          mkPlayer(1, 'sandrine', 196, 154, 'right', diff),
          mkPlayer(2, 'grok', 200, 146, 'right', diff),
          mkPlayer(3, 'david', 204, 150, 'right', diff),
        ];
        const h = harness(ps);
        const b = addEnemy(h, boss, 215, 150);
        for (const p of ps) expect(performPlayerSpecial(h.ctx, p), `${p.characterId}`).toBe(true);
        for (let i = 0; i < 90; i++) {
          h.ctx.room.elapsedMs += DT;
          for (const p of ps) {
            const before = p.specialAnimMs;
            stepPlayerTimers(p, DT);
            stepSpecialEffects(h.ctx, p, before);
          }
          stepProjectiles(h.ctx, DT);
        }
        expect(b.dead, `${boss} d${diff}`).toBe(false);
        expect(b.hp / b.maxHp, `${boss} d${diff}`).toBeGreaterThanOrEqual(0.6);
        expect(b.hp / b.maxHp, `${boss} d${diff}`).toBeLessThan(1);
      }
    }
  });

  it("Aelith seule : la Volée d'étoiles retire moins de 25 % des PV de Gorgrim, même à difficulté facile", () => {
    const p = mkPlayer(0, 'aelith', 200, 150, 'right', 1);
    const h = harness([p]);
    const b = addEnemy(h, 'golem', 215, 150);
    performPlayerSpecial(h.ctx, p);
    for (let i = 0; i < 60; i++) stepProjectiles(h.ctx, DT);
    expect(hpLost(b) / b.maxHp).toBeLessThan(0.25);
  });

  it('chaque spécial inflige clairement plus qu\'une attaque normale sur un ennemi au contact', () => {
    for (const id of CHARACTER_IDS) {
      const p = mkPlayer(0, id, 200, 150, 'right');
      const h = harness([p]);
      const e = addEnemy(h, 'knight', 216, 150, 100000);
      performPlayerSpecial(h.ctx, p);
      for (let i = 0; i < 60; i++) {
        const before = p.specialAnimMs;
        stepPlayerTimers(p, DT);
        stepSpecialEffects(h.ctx, p, before);
        stepProjectiles(h.ctx, DT);
      }
      expect(hpLost(e), id).toBeGreaterThanOrEqual(3 * normalHit(id));
    }
  });
});

// ───────────────────────────── Simulation complète ─────────────────────────────

function frame(over: Partial<ActionFrame> = {}): ActionFrame {
  return { moveX: 0, moveY: 0, attack: false, interact: false, revive: false, ...over };
}

function openLevel(): ReturnType<typeof makeTestLevel> {
  return makeTestLevel({
    rooms: [
      makeTestRoom({
        id: 'r1',
        layout: makeTestLayout(30, 20),
        playerSpawns: [[5, 5], [6, 5], [5, 6], [6, 6]],
        exit: { rect: { x: 27, y: 17, w: 2, h: 2 }, requires: [] },
      }),
      makeTestRoom({ id: 'r2', exit: { rect: { x: 9, y: 5, w: 2, h: 2 }, requires: [], final: true } }),
    ],
  });
}

function simOf(chars: CharacterId[], seed = 7): GameSimulation {
  return createSimulation(
    { levelId: 'test', seed, players: chars.map((characterId, i) => ({ id: i as PlayerId, characterId, difficulty: 2 as Difficulty })) },
    openLevel(),
  );
}

function stepN(s: GameSimulation, n: number, inputs: TickInputs | ((i: number) => TickInputs) = {}): SimEvent[] {
  const all: SimEvent[] = [];
  for (let i = 0; i < n; i++) all.push(...s.step(DT, typeof inputs === 'function' ? inputs(i) : inputs));
  return all;
}

function addFoe(s: GameSimulation, kind: EnemyKind, x: number, y: number, hp = 5000): EnemyState {
  const e = createEnemyState(kind, { x, y }, s.state.nextEntityId++, 0);
  e.hp = hp;
  e.maxHp = hp;
  e.data.stunMs = 1e9;
  e.mode = 'stunned';
  s.state.room.enemies.push(e);
  return e;
}

const count = (ev: readonly SimEvent[], type: SimEvent['type']): number => ev.filter((e) => e.type === type).length;

describe('simulation : déclenchement sur front montant', () => {
  it('prêt au départ ; maintenir le bouton ne déclenche qu\'UNE fois ; événement specialUsed', () => {
    const s = simOf(['david']);
    const foe = addFoe(s, 'knight', s.state.players[0].pos.x + 20, s.state.players[0].pos.y);
    const ev = stepN(s, 90, { 0: frame({ special: true }) });
    expect(count(ev, 'specialUsed')).toBe(1);
    expect(ev.find((e) => e.type === 'specialUsed')).toMatchObject({ playerId: 0, kind: 'whirlwind' });
    expect(foe.maxHp - foe.hp).toBeCloseTo(damageToEnemy(playerSpecialDamage(getCharacter('david')), 2), 6);
    expect(s.state.players[0].prev.special).toBe(true);
  });

  it('relâcher puis ré-appuyer pendant la recharge ne fait rien ; après la recharge, ça repart (+ specialReady)', () => {
    const s = simOf(['david']);
    let ev = stepN(s, 1, { 0: frame({ special: true }) });
    expect(count(ev, 'specialUsed')).toBe(1);
    stepN(s, 2, { 0: frame() });
    ev = stepN(s, 1, { 0: frame({ special: true }) });
    expect(count(ev, 'specialUsed')).toBe(0);
    stepN(s, 1, { 0: frame() });
    // attendre la fin de la recharge (14 s) : specialReady émis exactement une fois
    const wait = stepN(s, Math.ceil(14000 / DT) + 5, { 0: frame() });
    expect(count(wait, 'specialReady')).toBe(1);
    expect(s.state.players[0].specialCooldownMs).toBe(0);
    ev = stepN(s, 1, { 0: frame({ special: true }) });
    expect(count(ev, 'specialUsed')).toBe(1);
  });

  it('refus à terre et pendant un relevage ; frame sans champ special = pas d\'appui', () => {
    const s = simOf(['david', 'valentine']);
    s.state.players[0].invulnMs = 0;
    applyDamageToPlayer(s.state.players[0], 100000);
    expect(s.state.players[0].status).toBe('down');
    let ev = stepN(s, 2, { 0: frame({ special: true }), 1: frame() });
    expect(count(ev, 'specialUsed')).toBe(0);
    // joueur 1 relève 0 (proches) : revive tenu + special pressé => pas de spécial
    s.state.players[1].pos = { x: s.state.players[0].pos.x + 5, y: s.state.players[0].pos.y };
    ev = stepN(s, 10, { 0: frame(), 1: frame({ revive: true }) });
    expect(s.state.players[1].revivingId).toBe(0);
    ev = stepN(s, 2, { 0: frame(), 1: frame({ revive: true, special: true }) });
    expect(count(ev, 'specialUsed')).toBe(0);
    expect(s.state.players[1].specialCooldownMs).toBe(0);
    ev = stepN(s, 5, { 0: frame({ moveX: 1 }), 1: { moveX: 0, moveY: 0, attack: false, interact: false, revive: false } });
    expect(count(ev, 'specialUsed')).toBe(0);
  });

  it('changement de salle ⇒ spécial prêt', () => {
    const s = simOf(['david']);
    stepN(s, 1, { 0: frame({ special: true }) });
    expect(s.state.players[0].specialCooldownMs).toBeGreaterThan(10000);
    s.state.players[0].pos = { x: 28 * TILE, y: 18 * TILE };
    stepN(s, 200, { 0: frame() });
    expect(s.state.roomIndex).toBe(1);
    expect(s.state.players[0].specialCooldownMs).toBe(0);
  });

  it('redémarrage de salle (défaite) ⇒ spécial prêt', () => {
    const s = simOf(['mira']);
    stepN(s, 1, { 0: frame({ special: true }) });
    expect(s.state.players[0].specialCooldownMs).toBeGreaterThan(0);
    s.state.players[0].invulnMs = 0;
    applyDamageToPlayer(s.state.players[0], 100000);
    const ev = stepN(s, Math.ceil(3000 / DT), { 0: frame() });
    expect(ev.some((e) => e.type === 'roomEntered' && e.reason === 'restart')).toBe(true);
    expect(s.state.players[0].specialCooldownMs).toBe(0);
    expect(s.state.players[0].specialAnimMs).toBe(0);
  });

  it('hors phase « playing » : aucun spécial', () => {
    const s = simOf(['david']);
    s.state.phase = 'roomCleared';
    const ev = stepN(s, 3, { 0: frame({ special: true }) });
    expect(count(ev, 'specialUsed')).toBe(0);
    expect(s.state.players[0].specialCooldownMs).toBe(0);
  });

  it('kills du spécial crédités au joueur (enemyDied.byPlayer, player.kills)', () => {
    const s = simOf(['david', 'sandrine']);
    const p1 = s.state.players[1];
    const foe = addFoe(s, 'slime', p1.pos.x + 64, p1.pos.y, 24);
    p1.facing = 'right';
    const ev = stepN(s, 2, { 1: frame({ special: true }) });
    expect(foe.dead || s.state.room.enemies.every((e) => e.id !== foe.id)).toBe(true);
    const died = ev.find((e) => e.type === 'enemyDied');
    expect(died).toMatchObject({ enemyId: foe.id, byPlayer: 1 });
    expect(p1.kills).toBe(1);
  });

  it('quake via la simulation : l\'ennemi libre est étourdi', () => {
    const s = simOf(['brokk']);
    const p = s.state.players[0];
    const foe = createEnemyState('slime', { x: p.pos.x + 40, y: p.pos.y }, s.state.nextEntityId++, 0);
    foe.hp = foe.maxHp = 5000;
    s.state.room.enemies.push(foe);
    stepN(s, 1, { 0: frame({ special: true }) });
    expect(foe.mode).toBe('stunned');
    expect(foe.data.stunMs).toBeGreaterThan(1100);
  });
});

describe('simulation : déterminisme, JSON, fuzz', () => {
  function randomSpecialInputs(n: number, seed: number): (tick: number) => TickInputs {
    const rng = createRng(seed);
    const cur: ActionFrame[] = Array.from({ length: n }, () => frame());
    return (tick) => {
      const out: TickInputs = {};
      for (let i = 0; i < n; i++) {
        if (tick % 9 === (i * 2) % 9) {
          cur[i] = {
            moveX: nextRandom(rng) < 0.02 ? NaN : Math.floor(nextRandom(rng) * 3) - 1,
            moveY: Math.floor(nextRandom(rng) * 3) - 1,
            attack: nextRandom(rng) < 0.5,
            interact: nextRandom(rng) < 0.2,
            revive: nextRandom(rng) < 0.3,
            special: nextRandom(rng) < 0.5,
          };
        }
        out[i as PlayerId] = cur[i];
      }
      return out;
    };
  }

  function finiteCheck(value: unknown, path = 'state'): string | null {
    if (typeof value === 'number') return Number.isFinite(value) ? null : `${path} = ${String(value)}`;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const r = finiteCheck(value[i], `${path}[${i}]`);
        if (r) return r;
      }
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        const r = finiteCheck(v, `${path}.${k}`);
        if (r) return r;
      }
    }
    return null;
  }

  function populated(chars: CharacterId[], seed: number): GameSimulation {
    const s = simOf(chars, seed);
    const kinds: EnemyKind[] = ['slime', 'bat', 'skeleton', 'archer', 'spider', 'wisp', 'knight', 'slime'];
    kinds.forEach((k, i) => {
      const p = s.state.players[i % chars.length];
      const e = createEnemyState(k, { x: p.pos.x + 12 + i * 5, y: p.pos.y + (i % 2 ? 10 : -10) }, s.state.nextEntityId++, 0);
      s.state.room.enemies.push(e);
    });
    return s;
  }

  it('déterministe : mêmes entrées ⇒ même état sérialisé ; état JSON pur et restaurable', () => {
    const chars: CharacterId[] = ['david', 'sandrine', 'romain', 'valentine'];
    const a = populated(chars, 11);
    const b = populated(chars, 11);
    const inputs = randomSpecialInputs(4, 99);
    const events: string[] = [];
    for (let i = 0; i < 500; i++) {
      const inp = inputs(i);
      const ea = a.step(DT, inp);
      const eb = b.step(DT, inp);
      expect(JSON.stringify(ea)).toBe(JSON.stringify(eb));
      events.push(...ea.map((e) => e.type));
    }
    expect(a.serialize()).toBe(b.serialize());
    expect(events).toContain('specialUsed');
    // restauration en cours de route
    const mid = populated(chars, 11);
    const inputs2 = randomSpecialInputs(4, 99);
    for (let i = 0; i < 200; i++) mid.step(DT, inputs2(i));
    const restored = GameSimulation.restore(mid.serialize(), mid.level);
    for (let i = 200; i < 400; i++) {
      const inp = inputs2(i);
      mid.step(DT, inp);
      restored.step(DT, inp);
    }
    expect(restored.serialize()).toBe(mid.serialize());
    expect(JSON.parse(a.serialize())).toEqual(JSON.parse(JSON.stringify(a.state)));
  });

  it('snapshot ancien (sans prev.special) : pas de crash, front montant géré', () => {
    const s = simOf(['david']);
    stepN(s, 3, {});
    const snap = JSON.parse(s.serialize());
    delete snap.players[0].prev.special;
    const r = GameSimulation.restore(JSON.stringify(snap), s.level);
    const ev = stepN(r, 1, { 0: frame({ special: true }) });
    expect(count(ev, 'specialUsed')).toBe(1);
  });

  it('fuzz : 8 personnages, 4 joueurs, entrées aléatoires — aucun NaN, specialCooldown borné', () => {
    const sets: CharacterId[][] = [
      ['david', 'sandrine', 'romain', 'valentine'],
      ['aelith', 'brokk', 'grok', 'mira'],
      ['mira', 'valentine', 'grok', 'aelith'],
    ];
    sets.forEach((chars, si) => {
      const s = populated(chars, 100 + si);
      const inputs = randomSpecialInputs(4, 500 + si);
      for (let i = 0; i < 900; i++) {
        s.step(DT, inputs(i));
        if (i % 50 === 0) expect(finiteCheck(s.state)).toBeNull();
        for (const p of s.state.players) {
          const max = getCharacter(p.characterId).special!.cooldownMs;
          expect(p.specialCooldownMs).toBeGreaterThanOrEqual(0);
          expect(p.specialCooldownMs).toBeLessThanOrEqual(max);
          expect(p.hp).toBeLessThanOrEqual(p.maxHp);
          expect(p.hp).toBeGreaterThanOrEqual(0);
        }
      }
      expect(finiteCheck(s.state)).toBeNull();
    });
  });
});

describe('invulnérabilité (Romain, Mira) face aux ennemis en simulation', () => {
  it.each(['romain', 'mira'] as const)('%s ne subit aucun dégât pendant son spécial', (id) => {
    const s = simOf([id]);
    const p = s.state.players[0];
    p.invulnMs = 0;
    stepN(s, 1, { 0: frame({ special: true }) });
    const hp = p.hp;
    // un projectile ennemi arrive juste sur le joueur
    s.state.room.projectiles.push({
      id: s.state.nextEntityId++,
      kind: 'bolt',
      owner: { type: 'enemy', id: 9999 },
      pos: { x: p.pos.x + 6, y: p.pos.y },
      vel: { x: -60, y: 0 },
      damage: 30,
      radius: 3,
      lifeMs: 1000,
      pierce: false,
      hitIds: [],
    });
    stepN(s, 12, { 0: frame() });
    expect(p.hp).toBe(hp);
    expect(PLAYER_INVULN_MS).toBeGreaterThan(0);
  });
});
