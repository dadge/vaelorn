/**
 * FRAPPE EN DIAGONALE : snap 8 directions, vecteur diagonal unitaire, mêlée / projectiles / spéciaux en diagonale, grâce de relâchement,
 * invariance de l'état pour un joueur qui ne bouge qu'en cardinal, sauvegarde (snapshot), événements.
 */
import { describe, expect, it } from 'vitest';
import { createEnemyState, knockEnemy, onEnemyHit, stunEnemy } from './ai';
import { AIM_GRACE_MS, AIM_HYSTERESIS_DEG } from './balance';
import { ARROW_FAN_SPEED, buildPlayerProjectile, meleeTargets, performPlayerAttack, performPlayerSpecial, stepProjectiles, type CombatContext } from './combat';
import { canOccupy } from './collision';
import { PLAYER_RADIUS, SIM_STEP_MS, TILE } from './constants';
import { aim8FromVec, cardinalOfAim, diagComponents, dirFromVec, dirVec, isDiagonal } from './geometry';
import { RoomGrid } from './grid';
import { makeTestLayout, makeTestLevel, makeTestRoom } from './levelValidation';
import { applyMoveAim, createPlayerState, playerAim, predictAttackAim, resetPlayersForRoom, stepPlayerTimers } from './players';
import { createSimulation, GameSimulation } from './simulation';
import type { ActionFrame, Aim8, CharacterId, DiagDir, Dir, EnemyKind, EnemyState, PlayerId, PlayerState, SimEvent, TickInputs, Vec2 } from './types';

const DT = SIM_STEP_MS;
const D = Math.SQRT1_2;
const DEG = Math.PI / 180;
const ALL8: Aim8[] = ['right', 'downRight', 'down', 'downLeft', 'left', 'upLeft', 'up', 'upRight'];
const DIAGS: DiagDir[] = ['upLeft', 'upRight', 'downLeft', 'downRight'];

/** Vecteur d'angle `deg` degrés (0 = droite, +90 = bas). */
const at = (deg: number, len = 1): Vec2 => ({ x: Math.cos(deg * DEG) * len, y: Math.sin(deg * DEG) * len });

// ───────────────────────────── Géométrie : snap 8 directions ─────────────────────────────

describe('aim8FromVec : snap en secteurs de 45°', () => {
  it('le centre de chacun des 8 secteurs et ±20° autour donnent la direction du secteur', () => {
    ALL8.forEach((a, k) => {
      for (const off of [0, -20, 20]) expect(aim8FromVec(at(k * 45 + off), 'up'), `${a} ${off}`).toBe(a);
    });
  });

  it('bornes : juste en deçà / au-delà de 22,5° du cardinal change de secteur', () => {
    expect(aim8FromVec(at(22), 'up')).toBe('right');
    expect(aim8FromVec(at(23), 'up')).toBe('downRight');
    expect(aim8FromVec(at(67), 'up')).toBe('downRight');
    expect(aim8FromVec(at(68), 'up')).toBe('down');
    expect(aim8FromVec(at(-22), 'up')).toBe('right');
    expect(aim8FromVec(at(-23), 'up')).toBe('upRight');
    expect(aim8FromVec(at(180 - 22), 'up')).toBe('left');
    expect(aim8FromVec(at(180 - 23), 'up')).toBe('downLeft');
    expect(aim8FromVec(at(-180 + 23), 'up')).toBe('upLeft');
  });

  it('la norme du vecteur est sans effet (stick à moitié incliné, clavier ±√½)', () => {
    expect(aim8FromVec({ x: 0.01, y: 0.01 }, 'up')).toBe('downRight');
    expect(aim8FromVec({ x: -D, y: -D }, 'down')).toBe('upLeft');
    expect(aim8FromVec({ x: -D, y: D }, 'up')).toBe('downLeft');
    expect(aim8FromVec({ x: D, y: -D }, 'up')).toBe('upRight');
    expect(aim8FromVec({ x: -1, y: 0 }, 'up')).toBe('left');
    expect(aim8FromVec({ x: -1, y: -0 }, 'up')).toBe('left');
    expect(aim8FromVec({ x: 0, y: -1 }, 'down')).toBe('up');
  });

  it('vecteur nul (ou quasi nul) : retourne le repli, diagonal compris', () => {
    expect(aim8FromVec({ x: 0, y: 0 }, 'upLeft')).toBe('upLeft');
    expect(aim8FromVec({ x: 1e-12, y: -1e-12 }, 'down')).toBe('down');
  });

  it('hystérésis : le secteur courant est élargi de la marge, pas plus', () => {
    // sans hystérésis : 25° du cardinal = diagonale ; avec 5° et repli « right » : reste right
    expect(aim8FromVec(at(25), 'right')).toBe('downRight');
    expect(aim8FromVec(at(25), 'right', 5)).toBe('right');
    expect(aim8FromVec(at(28), 'right', 5)).toBe('downRight'); // au-delà de 27,5°
    // depuis la diagonale : elle tient jusqu'à 17,5° du cardinal
    expect(aim8FromVec(at(20), 'downRight', 5)).toBe('downRight');
    expect(aim8FromVec(at(16), 'downRight', 5)).toBe('right');
    // l'hystérésis ne s'applique qu'au secteur de repli : un autre secteur est choisi normalement
    expect(aim8FromVec(at(90), 'right', 5)).toBe('down');
    expect(AIM_HYSTERESIS_DEG).toBeGreaterThan(0);
  });

  it('un stick qui oscille de ±2° autour de la frontière ne fait pas trembler la visée (hystérésis)', () => {
    let aim: Aim8 = 'right';
    const seen = new Set<Aim8>();
    for (let i = 0; i < 100; i++) {
      aim = aim8FromVec(at(22.5 + (i % 2 === 0 ? 2 : -2)), aim, AIM_HYSTERESIS_DEG);
      seen.add(aim);
    }
    expect(seen.size).toBe(1);
  });
});

describe('dirVec / helpers de diagonale', () => {
  it('toutes les directions sont unitaires (une diagonale n est PAS 1,41× plus longue)', () => {
    for (const a of ALL8) expect(Math.hypot(dirVec(a).x, dirVec(a).y), a).toBeCloseTo(1, 12);
    expect(dirVec('upLeft')).toEqual({ x: -D, y: -D });
    expect(dirVec('downRight')).toEqual({ x: D, y: D });
    expect(dirVec('up')).toEqual({ x: 0, y: -1 }); // les cardinales sont inchangées
    expect(dirVec('left')).toEqual({ x: -1, y: 0 });
  });

  it('isDiagonal, composantes, direction cardinale du sprite', () => {
    for (const a of ALL8) expect(isDiagonal(a)).toBe(DIAGS.includes(a as DiagDir));
    expect(diagComponents('upLeft')).toEqual(['left', 'up']);
    expect(diagComponents('downRight')).toEqual(['right', 'down']);
    expect(cardinalOfAim('upRight')).toBe('right');
    expect(cardinalOfAim('down')).toBe('down');
  });

  it('dirFromVec reste à 4 directions (le sprite, les statues, les ennemis ne changent pas)', () => {
    expect(dirFromVec({ x: D, y: D }, 'down')).toBe('down');
    expect(dirFromVec({ x: D, y: D }, 'left')).toBe('right');
  });
});

// ───────────────────────────── Joueur : visée et grâce ─────────────────────────────

function mkPlayer(id: PlayerId, characterId: CharacterId, x: number, y: number, facing: Dir = 'right', aim?: DiagDir): PlayerState {
  const p = createPlayerState({ id, characterId, difficulty: 2 }, { x, y });
  p.facing = facing;
  if (aim) {
    p.aim = aim;
    p.aimGraceMs = AIM_GRACE_MS;
  }
  return p;
}

describe('applyMoveAim : visée diagonale et grâce de relâchement', () => {
  it('un mouvement diagonal pose la visée et la grâce ; un cardinal seul ne pose rien', () => {
    const p = mkPlayer(0, 'david', 50, 50);
    applyMoveAim(p, { x: D, y: -D });
    expect(p.aim).toBe('upRight');
    expect(p.aimGraceMs).toBe(AIM_GRACE_MS);
    const q = mkPlayer(0, 'david', 50, 50);
    applyMoveAim(q, { x: 1, y: 0 });
    applyMoveAim(q, { x: 0, y: -1 });
    expect('aim' in q).toBe(false);
    expect('aimGraceMs' in q).toBe(false);
    expect(JSON.stringify(q)).not.toContain('aim');
  });

  it('une composante cardinale de la diagonale la conserve pendant la grâce (relâchement non simultané)', () => {
    const p = mkPlayer(0, 'david', 50, 50, 'up');
    applyMoveAim(p, { x: D, y: -D });
    stepPlayerTimers(p, DT);
    applyMoveAim(p, { x: 0, y: -1 }); // « droite » relâché le premier : reste « haut »
    expect(p.aim).toBe('upRight');
    stepPlayerTimers(p, DT);
    applyMoveAim(p, { x: 1, y: 0 }); // l'autre composante
    expect(p.aim).toBe('upRight');
  });

  it('la grâce écoulée, un cardinal tenu rend la visée au facing (champs supprimés)', () => {
    const p = mkPlayer(0, 'david', 50, 50, 'up');
    applyMoveAim(p, { x: D, y: -D });
    let steps = 0;
    while (p.aim && steps < 100) {
      stepPlayerTimers(p, DT);
      applyMoveAim(p, { x: 0, y: -1 });
      steps++;
    }
    expect(p.aim).toBeUndefined();
    expect('aimGraceMs' in p).toBe(false);
    expect(steps * DT).toBeGreaterThanOrEqual(AIM_GRACE_MS - DT);
    expect(steps * DT).toBeLessThanOrEqual(AIM_GRACE_MS + 2 * DT);
  });

  it('une autre direction (cardinale hors composantes, ou autre diagonale) la remplace tout de suite', () => {
    const p = mkPlayer(0, 'david', 50, 50, 'up');
    applyMoveAim(p, { x: D, y: -D });
    applyMoveAim(p, { x: -1, y: 0 }); // gauche n'est pas une composante de haut-droite
    expect(p.aim).toBeUndefined();
    applyMoveAim(p, { x: D, y: -D });
    applyMoveAim(p, { x: -D, y: -D });
    expect(p.aim).toBe('upLeft');
    applyMoveAim(p, { x: 0, y: 1 });
    expect(p.aim).toBeUndefined();
  });

  it('la grâce court aussi à l arrêt : un cardinal pressé APRÈS une longue pause n hérite pas d une vieille diagonale', () => {
    const p = mkPlayer(0, 'david', 50, 50, 'up');
    applyMoveAim(p, { x: D, y: -D });
    for (let i = 0; i < 60; i++) stepPlayerTimers(p, DT); // immobile 1 s : la visée est conservée…
    expect(p.aim).toBe('upRight');
    expect(playerAim(p)).toBe('upRight');
    applyMoveAim(p, { x: 0, y: -1 }); // …mais un cardinal l'efface
    expect(p.aim).toBeUndefined();
    expect(playerAim(p)).toBe('up');
  });

  it('predictAttackAim : pure, reproduit applyMoveAim + facing', () => {
    const p = mkPlayer(0, 'david', 50, 50, 'right');
    const before = JSON.stringify(p);
    expect(predictAttackAim(p, { x: D, y: D })).toBe('downRight');
    expect(predictAttackAim(p, { x: 0, y: -1 })).toBe('up');
    expect(predictAttackAim(p, { x: 0, y: 0 })).toBe('right');
    expect(JSON.stringify(p)).toBe(before);
    const q = mkPlayer(0, 'david', 50, 50, 'down', 'downRight');
    expect(predictAttackAim(q, { x: 1, y: 0 })).toBe('downRight'); // grâce
    expect(predictAttackAim(q, { x: -1, y: 0 })).toBe('left');
  });
});

// ───────────────────────────── Harnais de combat ─────────────────────────────

interface Harness {
  ctx: CombatContext;
  enemies: EnemyState[];
  events: SimEvent[];
}

function layoutWith(walls: [number, number][], w = 30, h = 20): string[] {
  const rows = makeTestLayout(w, h).map((r) => r.split(''));
  for (const [tx, ty] of walls) rows[ty][tx] = '#';
  return rows.map((r) => r.join(''));
}

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
  return { ctx, enemies, events };
}

let eid = 1;
function addEnemy(h: Harness, kind: EnemyKind, x: number, y: number, hp = 500): EnemyState {
  const e = createEnemyState(kind, { x, y }, eid++, 0);
  e.hp = hp;
  e.maxHp = hp;
  h.enemies.push(e);
  return e;
}
const hit = (e: EnemyState): boolean => e.hp < e.maxHp;

// ───────────────────────────── Mêlée ─────────────────────────────

describe('mêlée en diagonale', () => {
  it('un ennemi en diagonale est touché ; à 90° de la visée (autre diagonale) ou derrière, il est manqué (arc de Romain : 90°)', () => {
    const p = mkPlayer(0, 'romain', 200, 150, 'right', 'downRight');
    const h = harness([p]);
    const front = addEnemy(h, 'skeleton', 200 + 11, 150 + 11);
    const up = addEnemy(h, 'skeleton', 200 + 11, 150 - 11); // 90° de la visée
    const down = addEnemy(h, 'skeleton', 200 - 11, 150 + 11); // 90° de l'autre côté
    const behind = addEnemy(h, 'skeleton', 200 - 11, 150 - 11);
    const targets = meleeTargets(p, h.enemies, h.ctx.grid, []);
    expect(targets).toEqual([front]);
    expect(targets).not.toContain(up);
    expect(targets).not.toContain(down);
    expect(targets).not.toContain(behind);
  });

  it('la portée est celle d une attaque cardinale (dirVec unitaire) : même distance, même résultat', () => {
    const reach = 18 + 6 - 0.5; // portée de Romain + rayon du squelette
    for (const aim of ['right', 'downRight', 'upLeft'] as Aim8[]) {
      const v = dirVec(aim);
      const p = mkPlayer(0, 'romain', 200, 150);
      const h = harness([p]);
      addEnemy(h, 'skeleton', 200 + v.x * reach, 150 + v.y * reach);
      expect(meleeTargets(p, h.enemies, h.ctx.grid, [], aim).length, aim).toBe(1);
      h.enemies[0].pos = { x: 200 + v.x * (reach + 2), y: 150 + v.y * (reach + 2) };
      expect(meleeTargets(p, h.enemies, h.ctx.grid, [], aim).length, `${aim} hors portée`).toBe(0);
    }
  });

  it('un mur en diagonale coupe la ligne de vue : pas de coup à travers', () => {
    // joueur en bas-droite de la tuile (5,5) ; mur en (6,6) ; ennemi derrière, en (7,7)
    const p = mkPlayer(0, 'david', 94, 94, 'right', 'downRight');
    const open = harness([p]);
    addEnemy(open, 'skeleton', 112, 112);
    expect(meleeTargets(p, open.enemies, open.ctx.grid, []).length).toBe(1);
    const walled = harness([p], layoutWith([[6, 6]]));
    addEnemy(walled, 'skeleton', 112, 112);
    expect(meleeTargets(p, walled.enemies, walled.ctx.grid, []).length).toBe(0);
  });

  it('performPlayerAttack : la visée diagonale par défaut, attackDir = facing, attackAim posée ; en cardinal le champ disparaît', () => {
    const p = mkPlayer(0, 'david', 200, 150, 'right', 'downRight');
    const h = harness([p]);
    const e = addEnemy(h, 'skeleton', 200 + 14, 150 + 14);
    expect(performPlayerAttack(h.ctx, p)).toBe(true);
    expect(hit(e)).toBe(true);
    expect(p.attackDir).toBe('right');
    expect(p.attackAim).toBe('downRight');
    expect(h.events.find((x) => x.type === 'playerAttack')).toEqual({ type: 'playerAttack', playerId: 0, dir: 'right', aim: 'downRight' });
    // coup suivant en cardinal : plus d'attackAim, événement SANS champ aim
    delete p.aim;
    delete p.aimGraceMs;
    p.attackCooldownMs = 0;
    h.events.length = 0;
    performPlayerAttack(h.ctx, p);
    expect('attackAim' in p).toBe(false);
    expect(h.events.find((x) => x.type === 'playerAttack')).toStrictEqual({ type: 'playerAttack', playerId: 0, dir: 'right' });
  });
});

// ───────────────────────────── Projectiles ─────────────────────────────

describe('projectile en diagonale', () => {
  it('direction diagonale, VITESSE identique à une cardinale, départ devant le héros', () => {
    const base = mkPlayer(0, 'aelith', 200, 150);
    const h = harness([base]);
    const card = buildPlayerProjectile(base, 1, h.ctx.grid, [], 'right')!;
    for (const aim of DIAGS) {
      const p = buildPlayerProjectile(base, 2, h.ctx.grid, [], aim)!;
      expect(p).not.toBeNull();
      expect(Math.hypot(p.vel.x, p.vel.y)).toBeCloseTo(Math.hypot(card.vel.x, card.vel.y), 9);
      expect(Math.sign(p.vel.x)).toBe(Math.sign(dirVec(aim).x));
      expect(Math.sign(p.vel.y)).toBe(Math.sign(dirVec(aim).y));
      expect(Math.abs(p.vel.x)).toBeCloseTo(Math.abs(p.vel.y), 9);
      // départ : même distance que le cardinal (PLAYER_RADIUS + rayon), dans la direction de visée
      expect(Math.hypot(p.pos.x - 200, p.pos.y - 150)).toBeCloseTo(Math.hypot(card.pos.x - 200, card.pos.y - 150), 9);
      expect((p.pos.x - 200) * Math.sign(dirVec(aim).x)).toBeGreaterThan(0);
      expect((p.pos.y - 150) * Math.sign(dirVec(aim).y)).toBeGreaterThan(0);
      expect(p.lifeMs).toBe(card.lifeMs);
    }
  });

  it('par défaut le projectile suit la visée effective (aim ?? facing)', () => {
    const p = mkPlayer(0, 'aelith', 200, 150, 'right', 'upLeft');
    const h = harness([p]);
    const proj = buildPlayerProjectile(p, 1, h.ctx.grid, [])!;
    expect(proj.vel.x).toBeLessThan(0);
    expect(proj.vel.y).toBeLessThan(0);
    delete p.aim;
    const card = buildPlayerProjectile(p, 2, h.ctx.grid, [])!;
    expect(card.vel).toEqual({ x: 260, y: 0 });
  });

  it('un tir diagonal touche une cible sur la diagonale ; un mur sur la diagonale l arrête', () => {
    const p = mkPlayer(0, 'aelith', 200, 150, 'right', 'downRight');
    const h = harness([p]);
    const e = addEnemy(h, 'skeleton', 200 + 60, 150 + 60);
    performPlayerAttack(h.ctx, p);
    for (let i = 0; i < 40; i++) stepProjectiles(h.ctx, DT);
    expect(hit(e)).toBe(true);

    const wall = harness([mkPlayer(0, 'aelith', 200, 150, 'right', 'downRight')], layoutWith([[15, 11]]));
    const behind = addEnemy(wall, 'skeleton', 200 + 90, 150 + 90);
    performPlayerAttack(wall.ctx, wall.ctx.players[0]);
    for (let i = 0; i < 60; i++) stepProjectiles(wall.ctx, DT);
    expect(hit(behind)).toBe(false);
    expect(wall.ctx.room.projectiles.length).toBe(0);
  });

  it('un tir diagonal qui frotte un coin de mur est arrêté par ce coin (même règle que les autres angles)', () => {
    // le tir part de (200,150) vers le bas-droite (droite y = x - 50) ; la tuile (13,11) occupe x 208..224, y 176..192 : son coin (224,176) est à 1,4 px de la droite,
    // sous le rayon de collision d'un tir de joueur (2 px) : le tir ne traverse pas la tuile mais ÉFFLEURE son coin
    const w = harness([mkPlayer(0, 'aelith', 200, 150, 'right', 'downRight')], layoutWith([[13, 11]]));
    performPlayerAttack(w.ctx, w.ctx.players[0]);
    expect(w.ctx.room.projectiles.length).toBe(1);
    for (let i = 0; i < 60; i++) stepProjectiles(w.ctx, DT);
    expect(w.ctx.room.projectiles.length).toBe(0);
    // sans mur, il vole encore après le même nombre de pas courts
    const o = harness([mkPlayer(0, 'aelith', 200, 150, 'right', 'downRight')]);
    performPlayerAttack(o.ctx, o.ctx.players[0]);
    for (let i = 0; i < 10; i++) stepProjectiles(o.ctx, DT);
    expect(o.ctx.room.projectiles.length).toBe(1);
  });
});

// ───────────────────────────── Spéciaux directionnels ─────────────────────────────

describe('spéciaux en diagonale', () => {
  it('ruée (Romain) : parcourt la même distance qu en cardinal, en diagonale ; événement avec dir cardinal ET aim', () => {
    const p = mkPlayer(0, 'romain', 200, 150, 'right', 'downRight');
    const h = harness([p]);
    performPlayerSpecial(h.ctx, p);
    expect(p.pos.x - 200).toBeCloseTo(p.pos.y - 150, 6);
    expect(Math.hypot(p.pos.x - 200, p.pos.y - 150)).toBeCloseTo(90, 6);
    expect(h.events.find((e) => e.type === 'specialUsed')).toMatchObject({ type: 'specialUsed', kind: 'dash', dir: 'right', aim: 'downRight' });
    expect(p.attackDir).toBe('right');
    expect(p.attackAim).toBe('downRight');
  });

  it('ruée : un mur sur la diagonale arrête la ruée, le héros ne finit jamais dans le mur', () => {
    const p = mkPlayer(0, 'romain', 200, 150, 'right', 'downRight');
    const h = harness([p], layoutWith([[15, 11], [14, 11], [15, 10]]));
    performPlayerSpecial(h.ctx, p);
    expect(Math.hypot(p.pos.x - 200, p.pos.y - 150)).toBeLessThan(90);
    expect(canOccupy(p.pos, PLAYER_RADIUS, h.ctx.grid, [])).toBe(true);
  });

  it('ruée : blesse un ennemi traversé en diagonale', () => {
    const p = mkPlayer(0, 'romain', 200, 150, 'right', 'upLeft');
    const h = harness([p]);
    const e = addEnemy(h, 'skeleton', 200 - 30, 150 - 30);
    const off = addEnemy(h, 'skeleton', 200 + 30, 150 - 30);
    performPlayerSpecial(h.ctx, p);
    expect(hit(e)).toBe(true);
    expect(hit(off)).toBe(false);
    expect(p.pos.x).toBeLessThan(200);
    expect(p.pos.y).toBeLessThan(150);
  });

  it('nova ardente (Sandrine) : centrée devant le héros en diagonale, à la même distance', () => {
    const p = mkPlayer(0, 'sandrine', 200, 150, 'right', 'downRight');
    const h = harness([p]);
    const inside = addEnemy(h, 'skeleton', 200 + 64 * D, 150 + 64 * D);
    const away = addEnemy(h, 'skeleton', 200 + 64 * D, 150 - 64 * D);
    performPlayerSpecial(h.ctx, p);
    expect(hit(inside)).toBe(true);
    expect(hit(away)).toBe(false);
    const ev = h.events.find((e) => e.type === 'specialUsed');
    if (ev?.type !== 'specialUsed') throw new Error('specialUsed attendu');
    expect(ev.pos.x).toBeCloseTo(200 + 64 * D, 6);
    expect(ev.pos.y).toBeCloseTo(150 + 64 * D, 6);
    expect(ev.aim).toBe('downRight');
  });

  it('volée d étoiles (Aelith) : l éventail est centré sur la diagonale, flèches à la vitesse d une cardinale', () => {
    const p = mkPlayer(0, 'aelith', 200, 150, 'left', 'upLeft');
    const h = harness([p]);
    performPlayerSpecial(h.ctx, p);
    const arrows = h.ctx.room.projectiles;
    expect(arrows.length).toBe(9);
    const mid = arrows[4];
    expect(mid.vel.x).toBeCloseTo(-ARROW_FAN_SPEED * D, 6);
    expect(mid.vel.y).toBeCloseTo(-ARROW_FAN_SPEED * D, 6);
    for (const a of arrows) {
      expect(Math.hypot(a.vel.x, a.vel.y)).toBeCloseTo(ARROW_FAN_SPEED, 6);
      const ang = (Math.atan2(a.vel.y, a.vel.x) * 180) / Math.PI;
      const diff = Math.abs(((ang - -135 + 540) % 360) - 180);
      expect(diff).toBeLessThanOrEqual(40 + 1e-6);
    }
  });

  it('fracas (Grok) : le cône de 150° est centré sur la diagonale', () => {
    const p = mkPlayer(0, 'grok', 200, 150, 'right', 'downRight');
    const h = harness([p]);
    const front = addEnemy(h, 'knight', 200 + 25, 150 + 25);
    const side = addEnemy(h, 'knight', 200 + 25, 150 - 25); // 90° de la visée : hors du cône (±75°)
    const behind = addEnemy(h, 'knight', 200 - 25, 150 - 25);
    performPlayerSpecial(h.ctx, p);
    expect(hit(front)).toBe(true);
    expect(hit(side)).toBe(false);
    expect(hit(behind)).toBe(false);
  });

  it('tourbillon (David) : radial, la visée diagonale ne change pas ce qu il touche ; sans diagonale, l événement n a pas de champ aim', () => {
    const p = mkPlayer(0, 'david', 200, 150, 'right', 'downRight');
    const h = harness([p]);
    const front = addEnemy(h, 'knight', 200 + 20, 150 + 20);
    const behind = addEnemy(h, 'knight', 200 - 20, 150 - 20);
    performPlayerSpecial(h.ctx, p);
    expect(hit(front)).toBe(true);
    expect(hit(behind)).toBe(true);
    const q = mkPlayer(0, 'david', 200, 150, 'right');
    const h2 = harness([q]);
    performPlayerSpecial(h2.ctx, q);
    expect(h2.events.find((e) => e.type === 'specialUsed')).toStrictEqual({ type: 'specialUsed', playerId: 0, kind: 'whirlwind', pos: { x: 200, y: 150 }, dir: 'right' });
  });
});

// ───────────────────────────── Simulation : grâce, invariance, sauvegarde ─────────────────────────────

function arena() {
  return makeTestLevel({
    rooms: [
      makeTestRoom({
        id: 'r1',
        layout: makeTestLayout(30, 20),
        playerSpawns: [[5, 10], [6, 10], [5, 11], [6, 11]],
        mechanisms: [],
        exit: { rect: { x: 27, y: 17, w: 2, h: 2 }, requires: [] },
      }),
      makeTestRoom({ id: 'r2', exit: { rect: { x: 9, y: 5, w: 2, h: 2 }, requires: [], final: true } }),
    ],
  });
}

function sim(chars: CharacterId[] = ['david'], seed = 7): GameSimulation {
  return createSimulation(
    { levelId: 'test', seed, players: chars.map((characterId, i) => ({ id: i as PlayerId, characterId, difficulty: 2 as const })) },
    arena(),
  );
}

const fr = (over: Partial<ActionFrame> = {}): ActionFrame => ({ moveX: 0, moveY: 0, attack: false, interact: false, revive: false, ...over });

function run(s: GameSimulation, n: number, f: ActionFrame | ((i: number) => ActionFrame)): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < n; i++) {
    const inputs: TickInputs = { 0: typeof f === 'function' ? f(i) : f };
    out.push(...s.step(DT, inputs));
  }
  return out;
}

describe('simulation : visée diagonale au déplacement', () => {
  const diag = (): ActionFrame => fr({ moveX: D, moveY: -D });

  it('deux touches (±√½) posent la diagonale ; le facing reste cardinal (sprite)', () => {
    const s = sim();
    run(s, 3, diag());
    const p = s.state.players[0];
    expect(p.aim).toBe('upRight');
    expect(['up', 'right']).toContain(p.facing);
  });

  it('relâchement non simultané : la dernière frame cardinale avant la frappe garde la diagonale (événement avec aim)', () => {
    const s = sim();
    run(s, 5, diag());
    run(s, 3, fr({ moveY: -1 })); // « droite » relâché, « haut » encore tenu
    const events = run(s, 1, fr({ moveY: -1, attack: true }));
    expect(s.state.players[0].aim).toBe('upRight');
    const atk = events.find((e) => e.type === 'playerAttack');
    expect(atk).toMatchObject({ type: 'playerAttack', playerId: 0, aim: 'upRight' });
  });

  it('au-delà de la grâce, le cardinal tenu rend la frappe cardinale (pas d aim dans l événement ni dans l état)', () => {
    const s = sim();
    run(s, 5, diag());
    run(s, Math.ceil(AIM_GRACE_MS / SIM_STEP_MS) + 3, fr({ moveY: -1 }));
    const p = s.state.players[0];
    expect(p.aim).toBeUndefined();
    expect(JSON.stringify(p)).not.toContain('"aim"');
    const events = run(s, 1, fr({ moveY: -1, attack: true }));
    expect(events.find((e) => e.type === 'playerAttack')).toStrictEqual({ type: 'playerAttack', playerId: 0, dir: 'up' });
  });

  it('une autre direction perd la diagonale ; l arrêt complet la conserve (comme le facing)', () => {
    const s = sim();
    run(s, 5, diag());
    run(s, 120, fr()); // immobile 2 s
    expect(s.state.players[0].aim).toBe('upRight');
    run(s, 1, fr({ moveX: -1 }));
    expect(s.state.players[0].aim).toBeUndefined();
    expect(s.state.players[0].facing).toBe('left');
  });

  it('un stick analogique : secteur le plus proche (30° sous l horizontale = diagonale ; 10° = cardinal)', () => {
    const s = sim();
    const v30 = at(30);
    run(s, 2, fr({ moveX: v30.x, moveY: v30.y }));
    expect(s.state.players[0].aim).toBe('downRight');
    const t = sim();
    const v10 = at(10);
    run(t, 2, fr({ moveX: v10.x, moveY: v10.y }));
    expect(t.state.players[0].aim).toBeUndefined();
  });

  it('un héros qui frappe en diagonale touche un ennemi en diagonale (intégration)', () => {
    const s = sim(['romain']);
    const p = s.state.players[0];
    s.state.room.enemies.push(createEnemyState('skeleton', { x: p.pos.x + 12, y: p.pos.y + 12 }, s.state.nextEntityId++, 0));
    const e = s.state.room.enemies[0];
    const hp = e.hp;
    // diagonale vers le bas-droite quelques pas (contre le squelette), puis frappe
    run(s, 2, fr({ moveX: D * 0.05, moveY: D * 0.05, attack: true }));
    expect(s.state.players[0].aim).toBe('downRight');
    expect(e.hp).toBeLessThan(hp);
  });

  it('flux aléatoires inchangés : mêmes graines après les mêmes pas, avec ou sans déplacement diagonal', () => {
    const a = sim(['david'], 11);
    const b = sim(['david'], 11);
    run(a, 200, (i) => fr({ moveX: i % 40 < 20 ? D : -D, moveY: i % 40 < 20 ? -D : D, attack: i % 9 === 0 }));
    run(b, 200, (i) => fr({ moveX: i % 40 < 20 ? 1 : -1, moveY: 0, attack: i % 9 === 0 }));
    expect([a.state.rngState, a.state.lootRngState, a.state.gearRngState]).toEqual([b.state.rngState, b.state.lootRngState, b.state.gearRngState]);
  });
});

describe('invariance : un joueur qui ne bouge qu en cardinal garde un état identique à l ancien', () => {
  it('aucun champ aim / aimGraceMs / attackAim dans l état sérialisé ni dans les événements (déplacements et attaques cardinaux)', () => {
    const s = sim(['david', 'aelith']);
    const events: SimEvent[] = [];
    const dirs: [number, number][] = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    for (let i = 0; i < 600; i++) {
      const [mx, my] = dirs[Math.floor(i / 45) % 4];
      const [nx, ny] = dirs[(Math.floor(i / 45) + 1) % 4];
      events.push(
        ...s.step(DT, {
          0: fr({ moveX: mx, moveY: my, attack: i % 7 === 0, special: i % 200 === 0 }),
          1: fr({ moveX: ny, moveY: nx, attack: i % 11 === 0 }),
        }),
      );
    }
    const json = s.serialize();
    expect(json).not.toContain('"aim"');
    expect(json).not.toContain('aimGraceMs');
    expect(json).not.toContain('attackAim');
    for (const e of events) {
      if (e.type === 'playerAttack' || e.type === 'specialUsed') expect('aim' in e).toBe(false);
    }
    expect(events.some((e) => e.type === 'playerAttack')).toBe(true);
  });

  it('un snapshot ancien (sans aucun champ de visée) se recharge et se joue comme avant', () => {
    const s = sim();
    run(s, 30, fr({ moveX: 1 }));
    const old = s.serialize();
    expect(old).not.toContain('aim');
    const r = GameSimulation.restore(old, arena());
    expect(r.serialize()).toBe(old);
    run(s, 50, fr({ moveY: 1, attack: true }));
    run(r, 50, fr({ moveY: 1, attack: true }));
    expect(r.serialize()).toBe(s.serialize());
  });
});

describe('sauvegarde / restauration de la visée', () => {
  it('un snapshot pris en pleine diagonale (aim + grâce) redonne exactement la même suite d états', () => {
    const s = sim(['david']);
    run(s, 12, fr({ moveX: -D, moveY: D }));
    expect(s.state.players[0].aim).toBe('downLeft');
    const snap = s.serialize();
    expect(snap).toContain('"aim":"downLeft"');
    const r = GameSimulation.restore(snap, arena());
    expect(r.state.players[0].aim).toBe('downLeft');
    expect(r.state.players[0].aimGraceMs).toBe(s.state.players[0].aimGraceMs);
    const script = (i: number): ActionFrame => (i < 4 ? fr({ moveY: 1 }) : fr({ moveY: 1, attack: i % 5 === 0 }));
    const ea = run(s, 40, script);
    const eb = run(r, 40, script);
    expect(eb).toEqual(ea);
    expect(r.serialize()).toBe(s.serialize());
    expect(ea.find((e) => e.type === 'playerAttack')).toBeDefined();
  });
});

describe('constantes [B33]', () => {
  it('grâce courte (≥ 6 pas, ≤ 150 ms) et hystérésis raisonnable', () => {
    expect(AIM_GRACE_MS).toBeGreaterThanOrEqual(6 * SIM_STEP_MS);
    expect(AIM_GRACE_MS).toBeLessThanOrEqual(150);
    expect(AIM_HYSTERESIS_DEG).toBeGreaterThan(0);
    expect(AIM_HYSTERESIS_DEG).toBeLessThan(10);
    expect(TILE).toBe(16);
  });
});

// ───────────────────────────── Cycle de vie : chute, relevage, salle, appel, difficulté, snapshot corrompu ─────────────────────────────

/** Simulation à `chars.length` joueurs, tous à la difficulté `difficulty`. */
function simDiff(chars: CharacterId[], difficulty: 1 | 2 | 3, seed = 7): GameSimulation {
  return createSimulation({ levelId: 'test', seed, players: chars.map((characterId, i) => ({ id: i as PlayerId, characterId, difficulty })) }, arena());
}

const frames2 = (a: Partial<ActionFrame>, b: Partial<ActionFrame> = {}): TickInputs => ({ 0: fr(a), 1: fr(b) });

describe('cycle de vie de la visée diagonale', () => {
  it('chute puis relevage : aim et facing sont conservés, la grâce décroît pendant que le héros est à terre', () => {
    const s = simDiff(['david', 'aelith'], 2);
    for (let i = 0; i < 5; i++) s.step(DT, frames2({ moveX: D, moveY: -D }));
    const p = s.state.players[0];
    expect(p.aim).toBe('upRight');
    const facing = p.facing;
    expect(s.knockDown(0)).toBe(true);
    expect(p.status).toBe('down');
    expect(p.aim).toBe('upRight'); // la chute ne remet pas la visée à zéro
    expect(p.aimGraceMs).toBe(AIM_GRACE_MS);
    for (let i = 0; i < 20; i++) s.step(DT, frames2({ moveX: -1 }, {})); // à terre, les touches de déplacement n'ont aucun effet
    expect(p.aim).toBe('upRight');
    expect(p.aimGraceMs).toBe(0); // …mais la grâce a décru (même pour un joueur à terre)
    // l'allié (joueur 1) relève : le héros se relève avec la même visée, la même direction de sprite
    for (let i = 0; i < 400 && p.status === 'down'; i++) s.step(DT, frames2({}, { revive: true }));
    expect(p.status).toBe('alive');
    expect(p.facing).toBe(facing);
    expect(p.aim).toBe('upRight');
    expect(playerAim(p)).toBe('upRight');
    // grâce écoulée : un cardinal pressé après le relevage supprime la diagonale
    s.step(DT, frames2({ moveY: -1 }));
    expect(p.aim).toBeUndefined();
    expect(JSON.stringify(p)).not.toContain('"aim"');
  });

  it('changement de salle : la visée est conservée comme le facing (resetPlayersForRoom ne la touche pas)', () => {
    const p = mkPlayer(0, 'david', 50, 50, 'up', 'upRight');
    p.aimGraceMs = 37;
    resetPlayersForRoom([p], [{ x: 10, y: 10 }]);
    expect(p.facing).toBe('up');
    expect(p.aim).toBe('upRight');
    expect(p.aimGraceMs).toBe(37);
    // sans diagonale : toujours aucun champ
    const q = mkPlayer(0, 'david', 50, 50, 'up');
    resetPlayersForRoom([q], [{ x: 10, y: 10 }]);
    expect('aim' in q).toBe(false);
    expect('aimGraceMs' in q).toBe(false);
  });

  it('changement de salle réel (simulation) : le héros arrive dans la salle suivante avec sa visée diagonale', () => {
    const s = simDiff(['david'], 2);
    // d'abord à droite, puis en diagonale vers le bas-droite jusqu'à la sortie (tuiles 27-28 × 17-18)
    for (let i = 0; i < 600 && s.state.players[0].pos.x < 20 * TILE; i++) s.step(DT, { 0: fr({ moveX: 1 }) });
    for (let i = 0; i < 1200 && s.state.roomIndex === 0; i++) s.step(DT, { 0: fr({ moveX: D, moveY: D }) });
    expect(s.state.roomIndex).toBe(1);
    const p = s.state.players[0];
    expect(p.aim).toBe('downRight');
    expect(playerAim(p)).toBe('downRight');
  });

  it('appel (gel) : le héros immobilisé garde sa visée, la grâce décroît, un cardinal pressé après le dégel (grâce écoulée) la supprime', () => {
    const s = simDiff(['david'], 2);
    run(s, 5, fr({ moveX: D, moveY: -D }));
    const p = s.state.players[0];
    run(s, 1, fr({ call: true }));
    expect(p.callMs).toBeGreaterThan(0);
    // pendant le gel, les touches de déplacement sont ignorées : aim inchangé (pas de remplacement par « gauche »)
    run(s, 6, fr({ moveX: -1 }));
    expect(p.aim).toBe('upRight');
    expect(p.aimGraceMs).toBeLessThan(AIM_GRACE_MS);
    run(s, Math.ceil(1000 / DT) + 5, fr()); // fin du gel
    expect(p.aim).toBe('upRight'); // immobile : la visée reste
    expect(p.aimGraceMs).toBe(0);
    run(s, 1, fr({ moveY: -1 })); // composante cardinale, grâce écoulée
    expect(p.aim).toBeUndefined();
  });

  it('difficultés 1, 2 et 3 : même visée, même grâce, même événement de frappe', () => {
    const results = ([1, 2, 3] as const).map((d) => {
      const s = simDiff(['david'], d);
      run(s, 5, fr({ moveX: D, moveY: -D }));
      run(s, 3, fr({ moveY: -1 }));
      const events = run(s, 1, fr({ moveY: -1, attack: true }));
      const p = s.state.players[0];
      return { aim: p.aim, grace: p.aimGraceMs, facing: p.facing, attack: events.find((e) => e.type === 'playerAttack') };
    });
    expect(results[0].aim).toBe('upRight');
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    expect(results[0].attack).toMatchObject({ type: 'playerAttack', aim: 'upRight' });
  });
});

describe('restore : snapshot à visée hors norme (édité à la main ou corrompu)', () => {
  const corrupt = (mutate: (p: Record<string, unknown>) => void): string => {
    const s = sim(['david']);
    run(s, 5, fr({ moveX: D, moveY: -D }));
    const parsed = JSON.parse(s.serialize()) as { players: Record<string, unknown>[] };
    mutate(parsed.players[0]);
    return JSON.stringify(parsed);
  };

  it('aim invalide (chaîne, cardinal, null) : champs supprimés, la simulation joue et frappe sans erreur', () => {
    for (const bad of ['foo', 'up', null, 3]) {
      const r = GameSimulation.restore(corrupt((p) => (p.aim = bad)), arena());
      const p = r.state.players[0];
      expect('aim' in p, String(bad)).toBe(false);
      expect('aimGraceMs' in p, String(bad)).toBe(false);
      expect(() => run(r, 5, fr({ attack: true }))).not.toThrow();
      expect(playerAim(p)).toBe(p.facing);
    }
  });

  it('aimGraceMs invalide (NaN, négatif, texte) : ramené à 0 ; sans aim : supprimé', () => {
    for (const bad of [-5, 'x', null]) {
      const r = GameSimulation.restore(corrupt((p) => (p.aimGraceMs = bad)), arena());
      expect(r.state.players[0].aim).toBe('upRight');
      expect(r.state.players[0].aimGraceMs, String(bad)).toBe(0);
    }
    const r = GameSimulation.restore(corrupt((p) => { delete p.aim; p.aimGraceMs = 50; }), arena());
    expect('aimGraceMs' in r.state.players[0]).toBe(false);
  });

  it('attackAim invalide : supprimé ; valide : conservé', () => {
    const r = GameSimulation.restore(corrupt((p) => (p.attackAim = 'left')), arena());
    expect('attackAim' in r.state.players[0]).toBe(false);
    const ok = GameSimulation.restore(corrupt((p) => (p.attackAim = 'downLeft')), arena());
    expect(ok.state.players[0].attackAim).toBe('downLeft');
  });
});

describe('applyMoveAim : hystérésis et diagonale « gardée à l arrêt »', () => {
  it('grâce courante : l hystérésis tient la diagonale (25° du cardinal reste diagonale) ; grâce écoulée : on repart du facing (25° sous l horizontale = cardinal)', () => {
    const fresh = mkPlayer(0, 'david', 50, 50, 'right', 'downRight');
    applyMoveAim(fresh, at(20)); // 25° de la diagonale (45°) < 27,5° : conservée
    expect(fresh.aim).toBe('downRight');
    const stale = mkPlayer(0, 'david', 50, 50, 'right', 'downRight');
    stale.aimGraceMs = 0; // arrêté depuis longtemps, la diagonale n'a été « gardée » que par l'arrêt
    applyMoveAim(stale, at(20)); // 20° sous l'horizontale : secteur « right » (frontière 22,5°), comme avec un facing neuf
    expect(stale.aim).toBeUndefined();
    const neutral = mkPlayer(0, 'david', 50, 50, 'right');
    applyMoveAim(neutral, at(20));
    expect(neutral.aim).toBeUndefined();
    expect(predictAttackAim({ facing: 'right', aim: 'downRight', aimGraceMs: 0 }, at(20))).toBe('right');
  });
});
