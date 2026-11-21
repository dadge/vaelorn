/**
 * TOUTE ARME RAMASSÉE PERMET DE TIRER DE LOIN ([B34]) : un héros de MÊLÉE équipé d'une épée (onde), d'une hache (hache lancée) ou d'un arc (flèche) tire au lieu de frapper ;
 * un héros qui tire déjà garde son projectile. Couvre : projectile construit (kind, vitesse, portée, départ, dégâts) dans les 8 directions, murs, perforation (hache) et
 * non-perforation (onde), pas de tir ami (Valentine garde son soin), MAX_PROJECTILES, buffs, sans arme = état inchangé, aucun flux aléatoire touché, sauvegarde / restauration,
 * arme perdue à la chute puis récupérée au relevage, multi-joueurs.
 */
import { describe, expect, it } from 'vitest';
import { createEnemyState, knockEnemy, onEnemyHit, stunEnemy } from './ai';
import { AIM_GRACE_MS, GEAR_AXE_THROW_RANGE_PX, GEAR_BOW_RANGE_PX, GEAR_WAVE_RANGE_PX, damageToEnemy, playerBaseDamage } from './balance';
import { getCharacter, CHARACTER_LIST } from './characters';
import { MAX_PROJECTILES, buildPlayerProjectile, performPlayerAttack, stepProjectiles, type CombatContext } from './combat';
import { PLAYER_RADIUS, SIM_STEP_MS } from './constants';
import { attackDamageMultiplier, createGear, effectiveAttack } from './gear';
import { dirVec } from './geometry';
import { RoomGrid } from './grid';
import { makeTestLayout, makeTestLevel, makeTestRoom } from './levelValidation';
import { createPlayerState } from './players';
import { createSimulation, GameSimulation } from './simulation';
import type { Aim8, CharacterId, DiagDir, Dir, EnemyKind, EnemyState, PlayerId, PlayerSetup, PlayerState, ProjectileKind, ProjectileState, RoomDef, SimEvent, TickInputs } from './types';

const DT = SIM_STEP_MS;
const ALL8: Aim8[] = ['right', 'downRight', 'down', 'downLeft', 'left', 'upLeft', 'up', 'upRight'];
const MELEE_HEROES: CharacterId[] = ['david', 'romain', 'brokk', 'grok', 'mira'];
const SHOOTERS: CharacterId[] = ['sandrine', 'valentine', 'aelith'];
const WEAPONS: { level: 1 | 2 | 3; kind: ProjectileKind; range: number }[] = [
  { level: 1, kind: 'wave', range: GEAR_WAVE_RANGE_PX },
  { level: 2, kind: 'axe', range: GEAR_AXE_THROW_RANGE_PX },
  { level: 3, kind: 'arrow', range: GEAR_BOW_RANGE_PX },
];

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

function armed(characterId: CharacterId, weapon: number, x = 200, y = 150, facing: Dir = 'right', aim?: DiagDir): PlayerState {
  const p = createPlayerState({ id: 0, characterId, difficulty: 2 }, { x, y });
  p.loadout.weapon = weapon;
  p.facing = facing;
  if (aim) {
    p.aim = aim;
    p.aimGraceMs = AIM_GRACE_MS;
  }
  return p;
}

function run(h: Harness, steps: number): void {
  for (let i = 0; i < steps; i++) stepProjectiles(h.ctx, DT);
}

// ───────────────────────────── Projectile construit ─────────────────────────────

describe('héros de mêlée armé : projectile construit', () => {
  it('chaque (héros de mêlée) x (épée, hache, arc) : kind, vitesse, portée, dégâts = force x multiplicateur, propriétaire', () => {
    for (const id of MELEE_HEROES) {
      for (const w of WEAPONS) {
        const p = armed(id, w.level);
        const h = harness([p]);
        const proj = buildPlayerProjectile(p, 7, h.ctx.grid, [])!;
        const atk = effectiveAttack(getCharacter(id), p.loadout);
        expect(proj, `${id} ${w.kind}`).not.toBeNull();
        expect(proj.kind).toBe(w.kind);
        expect(proj.owner).toEqual({ type: 'player', id: 0 });
        expect(proj.damage).toBeCloseTo(playerBaseDamage(getCharacter(id)) * attackDamageMultiplier(getCharacter(id), p.loadout), 9);
        expect(proj.vel).toEqual({ x: atk.projectile!.speed, y: 0 });
        expect((Math.hypot(proj.vel.x, proj.vel.y) * proj.lifeMs) / 1000).toBeCloseTo(w.range, 6);
        expect(proj.radius).toBe(atk.projectile!.radius);
        expect(proj.pierce).toBe(atk.projectile!.pierce);
        expect(proj.hitIds).toEqual([]);
        expect(proj.pos.x).toBeGreaterThan(200); // départ devant le héros
      }
    }
  });

  it('sans arme : un héros de mêlée ne construit AUCUN projectile (il frappe) ; un tireur construit le sien', () => {
    for (const id of MELEE_HEROES) {
      const p = armed(id, 0);
      expect(buildPlayerProjectile(p, 1, harness([p]).ctx.grid, [])).toBeNull();
    }
    for (const id of SHOOTERS) {
      const p = armed(id, 0);
      expect(buildPlayerProjectile(p, 1, harness([p]).ctx.grid, [])).not.toBeNull();
    }
  });

  it('8 DIRECTIONS (cardinales ET diagonales) : même vitesse, départ à la même distance, direction de la visée', () => {
    for (const w of WEAPONS) {
      const p = armed('david', w.level);
      const h = harness([p]);
      const card = buildPlayerProjectile(p, 1, h.ctx.grid, [], 'right')!;
      for (const aim of ALL8) {
        const proj = buildPlayerProjectile(p, 2, h.ctx.grid, [], aim)!;
        const v = dirVec(aim);
        expect(proj, `${w.kind} ${aim}`).not.toBeNull();
        expect(Math.hypot(proj.vel.x, proj.vel.y), `${w.kind} ${aim}`).toBeCloseTo(Math.hypot(card.vel.x, card.vel.y), 9);
        expect(proj.vel.x / Math.hypot(proj.vel.x, proj.vel.y)).toBeCloseTo(v.x, 9);
        expect(proj.vel.y / Math.hypot(proj.vel.x, proj.vel.y)).toBeCloseTo(v.y, 9);
        expect(Math.hypot(proj.pos.x - 200, proj.pos.y - 150)).toBeCloseTo(Math.hypot(card.pos.x - 200, card.pos.y - 150), 9);
        expect(proj.lifeMs).toBe(card.lifeMs);
      }
    }
  });

  it('par défaut la visée suit `aim ?? facing` (une diagonale tenue fait partir l\'onde en diagonale)', () => {
    const p = armed('david', 1, 200, 150, 'right', 'upLeft');
    const h = harness([p]);
    const proj = buildPlayerProjectile(p, 1, h.ctx.grid, [])!;
    expect(proj.vel.x).toBeLessThan(0);
    expect(proj.vel.y).toBeLessThan(0);
    expect(Math.abs(proj.vel.x)).toBeCloseTo(Math.abs(proj.vel.y), 9);
  });

  it('départ dans un mur : aucun projectile, mais le tir est consommé (cooldown posé, `playerAttack` émis)', () => {
    for (const w of WEAPONS) {
      const p = armed('david', w.level, 17, 80, 'left'); // mur à gauche (x < 16)
      const h = harness([p]);
      expect(buildPlayerProjectile(p, 1, h.ctx.grid, [])).toBeNull();
      expect(performPlayerAttack(h.ctx, p)).toBe(true);
      expect(h.ctx.room.projectiles).toHaveLength(0);
      expect(p.attackCooldownMs).toBeCloseTo(effectiveAttack(getCharacter('david'), p.loadout).cooldownMs);
      expect(h.events.some((e) => e.type === 'playerAttack')).toBe(true);
      expect(h.events.some((e) => e.type === 'projectileFired')).toBe(false);
    }
  });
});

// ───────────────────────────── Attaque, impacts, murs ─────────────────────────────

describe('héros de mêlée armé : attaque, impacts et murs', () => {
  it('performPlayerAttack : un projectile (kind de l\'arme) + `projectileFired` ; AUCUN coup de mêlée sur un ennemi collé', () => {
    for (const w of WEAPONS) {
      const p = armed('david', w.level);
      const h = harness([p]);
      const e = addEnemy(h, 'skeleton', 200 + 14, 150);
      expect(performPlayerAttack(h.ctx, p)).toBe(true);
      expect(hit(e), `${w.kind} : pas de dégât instantané`).toBe(false);
      expect(h.ctx.room.projectiles).toHaveLength(1);
      expect(h.ctx.room.projectiles[0].kind).toBe(w.kind);
      expect(h.events.find((x) => x.type === 'projectileFired')).toMatchObject({ type: 'projectileFired', kind: w.kind });
      run(h, 5);
      expect(hit(e), `${w.kind} : touché par le projectile`).toBe(true);
    }
  });

  it('un tir touche une cible à portée dans chacune des 8 directions, dégâts = damageToEnemy(brut) ; hors portée : manquée', () => {
    for (const w of WEAPONS) {
      for (const aim of ALL8) {
        const p = armed('david', w.level);
        const h = harness([p]);
        const v = dirVec(aim);
        const near = addEnemy(h, 'skeleton', 200 + v.x * (w.range * 0.6), 150 + v.y * (w.range * 0.6));
        // une cible bien au-delà de la portée sur la même ligne : jamais touchée
        const far = addEnemy(h, 'skeleton', 200 + v.x * (w.range + 70), 150 + v.y * (w.range + 70));
        const proj = buildPlayerProjectile(p, 5, h.ctx.grid, [], aim)!;
        h.ctx.room.projectiles.push(proj);
        run(h, 80);
        expect(hit(near), `${w.kind} ${aim}`).toBe(true);
        expect(near.maxHp - near.hp).toBeCloseTo(damageToEnemy(proj.damage, 2), 9);
        expect(hit(far), `${w.kind} ${aim} hors portée`).toBe(false);
      }
    }
  });

  it('PORTÉE : le projectile parcourt la portée de son arme, pas plus (durée de vie) ; vitesse hache < épée < arc', () => {
    const travelled: Record<string, number> = {};
    const speed: Record<string, number> = {};
    for (const w of WEAPONS) {
      const p = armed('david', w.level);
      const h = harness([p]);
      const proj = buildPlayerProjectile(p, 1, h.ctx.grid, [])!;
      h.ctx.room.projectiles.push(proj);
      const start = { x: proj.pos.x, y: proj.pos.y };
      let steps = 0;
      let last = { x: start.x, y: start.y };
      while (h.ctx.room.projectiles.length > 0 && steps < 600) {
        last = { x: proj.pos.x, y: proj.pos.y };
        stepProjectiles(h.ctx, DT);
        steps++;
      }
      travelled[w.kind] = last.x - 200;
      speed[w.kind] = Math.hypot(proj.vel.x, proj.vel.y);
      expect(steps).toBeLessThan(600);
      expect(last.x - 200).toBeLessThanOrEqual(w.range + PLAYER_RADIUS + proj.radius + 6);
      expect(last.x - 200).toBeGreaterThan(w.range * 0.8);
    }
    expect(travelled.arrow).toBeGreaterThan(travelled.wave);
    expect(travelled.wave).toBeGreaterThan(travelled.axe);
    expect(speed.axe).toBeLessThan(speed.wave);
    expect(speed.wave).toBeLessThan(speed.arrow);
  });

  it('ONDE non perforante : une seule cible touchée, l\'onde disparaît ; HACHE perforante : traverse les ennemis alignés (une fois chacun)', () => {
    const wave = armed('david', 1);
    const hw = harness([wave]);
    const w1 = addEnemy(hw, 'skeleton', 230, 150);
    const w2 = addEnemy(hw, 'skeleton', 250, 150);
    performPlayerAttack(hw.ctx, wave);
    run(hw, 40);
    expect(hit(w1)).toBe(true);
    expect(hit(w2)).toBe(false);
    expect(hw.ctx.room.projectiles).toHaveLength(0);

    const axe = armed('david', 2);
    const ha = harness([axe]);
    const a1 = addEnemy(ha, 'skeleton', 220, 150);
    const a2 = addEnemy(ha, 'skeleton', 245, 150);
    performPlayerAttack(ha.ctx, axe);
    run(ha, 60);
    expect(hit(a1)).toBe(true);
    expect(hit(a2)).toBe(true);
    // une seule fois chacun : 1 tir = 1 coup par cible
    const dmg = damageToEnemy(playerBaseDamage(getCharacter('david')) * attackDamageMultiplier(getCharacter('david'), axe.loadout), 2);
    expect(a1.maxHp - a1.hp).toBeCloseTo(dmg, 9);
    expect(a2.maxHp - a2.hp).toBeCloseTo(dmg, 9);
  });

  it('MURS : le projectile s\'arrête sur un mur (tir cardinal et diagonal) ; une porte / un bloc fermé l\'arrête aussi', () => {
    for (const w of WEAPONS) {
      // mur plein à l'est (colonne x = 12, tuiles de 16 px : x = 192..208)
      const p = armed('david', w.level, 168, 150);
      const col = Array.from({ length: 20 }, (_, ty) => [12, ty] as [number, number]);
      const h = harness([p], layoutWith(col));
      const behind = addEnemy(h, 'skeleton', 230, 150);
      performPlayerAttack(h.ctx, p);
      run(h, 120);
      expect(hit(behind), `${w.kind} cardinal`).toBe(false);
      expect(h.ctx.room.projectiles).toHaveLength(0);

      const d = armed('david', w.level, 168, 118, 'right', 'downRight');
      const hd = harness([d], layoutWith([[12, 8], [11, 8], [12, 7]]));
      const behindD = addEnemy(hd, 'skeleton', 168 + 40, 118 + 40);
      performPlayerAttack(hd.ctx, d);
      run(hd, 120);
      expect(hit(behindD), `${w.kind} diagonale`).toBe(false);

      const s = armed('david', w.level, 168, 150);
      const hs = harness([s]);
      hs.ctx.solids = [{ x: 192, y: 0, w: 16, h: 320 }]; // porte fermée
      const behindS = addEnemy(hs, 'skeleton', 230, 150);
      performPlayerAttack(hs.ctx, s);
      run(hs, 120);
      expect(hit(behindS), `${w.kind} porte fermée`).toBe(false);
    }
  });

  it('MAX_PROJECTILES : au plafond, aucun nouveau tir n\'est ajouté mais l\'attaque est consommée', () => {
    const p = armed('david', 1);
    const h = harness([p]);
    for (let i = 0; i < MAX_PROJECTILES; i++) {
      const filler: ProjectileState = { id: i, kind: 'orb', owner: { type: 'enemy', id: 1 }, pos: { x: 20, y: 20 }, vel: { x: 0, y: 0 }, damage: 0, radius: 2, lifeMs: 9999, pierce: false, hitIds: [] };
      h.ctx.room.projectiles.push(filler);
    }
    expect(performPlayerAttack(h.ctx, p)).toBe(true);
    expect(h.ctx.room.projectiles).toHaveLength(MAX_PROJECTILES);
    expect(p.attackCooldownMs).toBeGreaterThan(0);
  });

  it('pas de tir ami : onde et hache ne blessent aucun allié (même sur la trajectoire) ; le soin de Valentine reste le sien', () => {
    for (const w of WEAPONS) {
      const shooter = armed('david', w.level);
      const ally = createPlayerState({ id: 1, characterId: 'brokk', difficulty: 2 }, { x: 220, y: 150 });
      ally.hp = ally.maxHp - 20;
      const hp0 = ally.hp;
      const h = harness([shooter, ally]);
      performPlayerAttack(h.ctx, shooter);
      run(h, 40);
      expect(ally.hp, w.kind).toBe(hp0);
    }
    // Valentine équipée de l'épée / la hache / l'arc : son projectile reste un soin
    for (const w of WEAPONS) {
      const val = armed('valentine', w.level);
      const ally = createPlayerState({ id: 1, characterId: 'brokk', difficulty: 2 }, { x: 225, y: 150 });
      ally.hp = ally.maxHp - 30;
      const hp0 = ally.hp;
      const h = harness([val, ally]);
      performPlayerAttack(h.ctx, val);
      expect(h.ctx.room.projectiles[0].kind).toBe('heal');
      run(h, 40);
      expect(ally.hp, `soin avec arme ${w.level}`).toBeGreaterThan(hp0);
    }
  });

  it('éclair de rage : les dégâts du tir sont multipliés par 1,5', () => {
    const p = armed('david', 1);
    const base = buildPlayerProjectile(p, 1, harness([p]).ctx.grid, [])!;
    p.loadout.buffs.push({ kind: 'rage', remainingMs: 5000 });
    const raged = buildPlayerProjectile(p, 2, harness([p]).ctx.grid, [])!;
    expect(raged.damage / base.damage).toBeCloseTo(1.5, 9);
  });

  it('héros qui tire déjà : projectile inchangé avec toute arme (kind, vitesse, rayon, perforation), dégâts avec le bonus de l\'arme', () => {
    for (const id of SHOOTERS) {
      const none = armed(id, 0);
      const base = buildPlayerProjectile(none, 1, harness([none]).ctx.grid, [])!;
      for (const w of WEAPONS) {
        const p = armed(id, w.level);
        const proj = buildPlayerProjectile(p, 1, harness([p]).ctx.grid, [])!;
        expect(proj.kind, `${id} ${w.level}`).toBe(base.kind);
        expect(proj.vel).toEqual(base.vel);
        expect(proj.radius).toBe(base.radius);
        expect(proj.pierce).toBe(base.pierce);
        expect(proj.lifeMs).toBe(base.lifeMs);
        expect(proj.damage / base.damage).toBeCloseTo(w.level === 1 ? 1.2 : w.level === 2 ? 1.35 : 1.15, 9);
      }
    }
  });
});

// ───────────────────────────── Simulation : état, sauvegarde, relevage ─────────────────────────────

function setups(n: number, characterId: CharacterId = 'david'): PlayerSetup[] {
  return Array.from({ length: n }, (_, i) => ({ id: i as PlayerId, characterId, difficulty: 2 }));
}

function room(id: string, over: Partial<RoomDef> = {}): RoomDef {
  return makeTestRoom({ id, exit: { rect: { x: 9, y: 5, w: 2, h: 2 }, requires: [] }, mechanisms: [{ id: 'p1', type: 'plate', tile: [6, 4] }], ...over });
}

function mk(n: number, characterId: CharacterId = 'david', r: RoomDef = room('r1'), gear = true): GameSimulation {
  const lv = makeTestLevel({ rooms: [r, { ...room('r2'), exit: { ...room('r2').exit, final: true } }] });
  return createSimulation({ levelId: lv.id, players: setups(n, characterId), seed: 5, loot: false, gear }, lv);
}

const ATTACK: TickInputs = { 0: { moveX: 0, moveY: 0, attack: true, interact: false, revive: false } };
const NOTHING: TickInputs = {};

function stepN(s: GameSimulation, n: number, inputs: TickInputs = NOTHING): SimEvent[] {
  const all: SimEvent[] = [];
  for (let i = 0; i < n; i++) all.push(...s.step(DT, inputs));
  return all;
}

function put(s: GameSimulation, id: PlayerId, x: number, y: number): void {
  s.state.players[id].pos = { x, y };
}

function arm(s: GameSimulation, id: PlayerId, weapon: number): void {
  s.state.players[id].loadout.weapon = weapon;
}

/** Clés de `PlayerState` d'un joueur SANS arme, en tir cardinal (aucun champ optionnel de visée diagonale, d'appel, de cœur rangé) : figées à la main. */
const SANS_ARME_PLAYER_KEYS = [
  'attackAnimMs', 'attackCooldownMs', 'attackDir', 'callCooldownMs', 'callMs', 'characterId', 'difficulty', 'downCount', 'facing', 'hp', 'id', 'invulnMs', 'keys', 'kills', 'loadout',
  'maxHp', 'moving', 'pos', 'prev', 'reviveProgressMs', 'reviverId', 'revivingId', 'specialAnimMs', 'specialCooldownMs', 'status', 'torchMs',
];

describe('simulation : arme, état et déterminisme', () => {
  it("SANS arme : un héros de mêlée garde le corps à corps (l'ennemi est blessé sans projectile) ; l'état ne contient aucun champ nouveau", () => {
    const s = mk(1, 'david', room('r1', { enemies: [{ kind: 'skeleton', tile: [4, 2] }] }));
    s.step(DT, NOTHING);
    const e = s.state.room.enemies[0];
    const hp0 = e.hp;
    put(s, 0, 4 * 16 + 8 - 14, 2 * 16 + 8);
    s.state.players[0].facing = 'right';
    e.pos = { x: 4 * 16 + 8, y: 2 * 16 + 8 };
    s.step(DT, ATTACK);
    expect(s.state.room.enemies[0].hp).toBeLessThan(hp0);
    expect(s.state.room.projectiles).toHaveLength(0);
    expect(s.state.players[0].loadout).toEqual({ boots: 0, protection: 0, artifact: 0, magic: 0, weapon: 0, accessory: null, buffs: [] });
    // liste de clés FIGÉE (pas comparée à un état fabriqué par la même fonction) : un champ ajouté par erreur à `PlayerState` fait échouer ce test
    expect(Object.keys(s.state.players[0]).sort()).toEqual(SANS_ARME_PLAYER_KEYS);
    expect(Object.keys(s.state.players[0].loadout).sort()).toEqual(['accessory', 'artifact', 'boots', 'buffs', 'magic', 'protection', 'weapon']);
  });

  it("SANS arme, les 8 héros : ni onde ni hache ni projectile d'arme sur 300 pas ; les champs optionnels de visée / d'appel restent absents en tir cardinal ; clés d'état figées", () => {
    for (const id of CHARACTER_LIST.map((c) => c.id)) {
      const s = mk(1, id, room('r1', { enemies: [{ kind: 'skeleton', tile: [8, 3] }] }));
      for (let i = 0; i < 300; i++) {
        put(s, 0, 100, 56);
        s.state.players[0].facing = 'right';
        s.step(DT, ATTACK);
        for (const p of s.state.room.projectiles) expect(['wave', 'axe'], `${id} : ${p.kind}`).not.toContain(p.kind);
      }
      expect(s.state.players[0].loadout.weapon, id).toBe(0);
      expect(Object.keys(s.state.players[0]).sort(), id).toEqual(SANS_ARME_PLAYER_KEYS);
    }
  });

  it('AVEC arme : aucun flux aléatoire touché (rngState / lootRngState / gearRngState identiques à la partie sans arme)', () => {
    const mkRun = (weapon: number): GameSimulation => {
      const s = mk(1, 'david', room('r1', { enemies: [{ kind: 'skeleton', tile: [8, 3] }] }));
      arm(s, 0, weapon);
      for (let i = 0; i < 200; i++) {
        put(s, 0, 100, 56);
        s.state.players[0].facing = 'right';
        s.step(DT, ATTACK);
      }
      return s;
    };
    const none = mkRun(0);
    for (const lv of [1, 2, 3]) {
      const s = mkRun(lv);
      expect(s.state.rngState, `arme ${lv}`).toBe(none.state.rngState);
      expect(s.state.lootRngState).toBe(none.state.lootRngState);
      expect(s.state.gearRngState).toBe(none.state.gearRngState);
    }
  });

  it('déterminisme : deux parties identiques avec arme donnent exactement le même état', () => {
    const play = (): string => {
      const s = mk(2, 'brokk', room('r1', { enemies: [{ kind: 'skeleton', tile: [8, 3] }, { kind: 'slime', tile: [9, 4] }] }));
      arm(s, 0, 2);
      arm(s, 1, 1);
      for (let i = 0; i < 240; i++) s.step(DT, { 0: { moveX: 0.2, moveY: 0, attack: true, interact: false, revive: false }, 1: { moveX: 0, moveY: -0.2, attack: i % 3 === 0, interact: false, revive: false } });
      return s.serialize();
    };
    expect(play()).toBe(play());
  });

  it('SAUVEGARDE : un projectile d\'onde / de hache en vol survit à serialize / restore et la suite est identique ; un ancien état sans arme se recharge', () => {
    for (const weapon of [1, 2]) {
      const lv = makeTestLevel({ rooms: [room('r1', { enemies: [{ kind: 'skeleton', tile: [9, 3] }] }), { ...room('r2'), exit: { ...room('r2').exit, final: true } }] });
      const s = createSimulation({ levelId: lv.id, players: setups(1), seed: 9, loot: false, gear: true }, lv);
      arm(s, 0, weapon);
      put(s, 0, 60, 56);
      s.state.players[0].facing = 'right';
      stepN(s, 2, ATTACK);
      expect(s.state.room.projectiles.length).toBeGreaterThan(0);
      expect(s.state.room.projectiles[0].kind).toBe(weapon === 1 ? 'wave' : 'axe');
      const json = s.serialize();
      const r = GameSimulation.restore(json, lv);
      expect(r.serialize()).toBe(json);
      stepN(s, 60);
      stepN(r, 60);
      expect(r.serialize()).toBe(s.serialize());
      expect(r.state.players[0].loadout.weapon).toBe(weapon);
    }
    // ancien état : aucun projectile / aucune arme → recharge et joue normalement
    const lv = makeTestLevel({ rooms: [room('r1'), { ...room('r2'), exit: { ...room('r2').exit, final: true } }] });
    const old = createSimulation({ levelId: lv.id, players: setups(1), seed: 3, loot: false, gear: true }, lv);
    stepN(old, 10);
    const back = GameSimulation.restore(old.serialize(), lv);
    expect(back.state.players[0].loadout.weapon).toBe(0);
    stepN(back, 10, ATTACK);
    expect(back.state.room.projectiles).toHaveLength(0);
  });

  it('MULTI-JOUEURS : chaque porteur tire SON projectile (propriétaire, kind) ; un coéquipier sans arme frappe toujours', () => {
    const s = mk(3, 'david', room('r1'));
    arm(s, 0, 1);
    arm(s, 1, 2);
    put(s, 0, 60, 40);
    put(s, 1, 60, 90);
    put(s, 2, 60, 140);
    for (const p of s.state.players) p.facing = 'right';
    const inputs: TickInputs = {
      0: { moveX: 0, moveY: 0, attack: true, interact: false, revive: false },
      1: { moveX: 0, moveY: 0, attack: true, interact: false, revive: false },
      2: { moveX: 0, moveY: 0, attack: true, interact: false, revive: false },
    };
    const ev = stepN(s, 1, inputs);
    const fired = ev.filter((e): e is Extract<SimEvent, { type: 'projectileFired' }> => e.type === 'projectileFired');
    expect(fired.map((f) => f.kind).sort()).toEqual(['axe', 'wave']);
    const owners = s.state.room.projectiles.map((p) => (p.owner.type === 'player' ? p.owner.id : -1)).sort();
    expect(owners).toEqual([0, 1]);
  });

  it('ARME PERDUE à la chute, RÉCUPÉRÉE au relevage : le héros frappe sans arme à terre puis le tir repart avec l\'arme reprise', () => {
    const s = mk(2, 'david', room('r1'));
    arm(s, 0, 2);
    put(s, 0, 100, 60);
    put(s, 1, 40, 40);
    s.state.players.forEach((p) => (p.invulnMs = 0));
    expect(s.knockDown(0)).toBe(true);
    stepN(s, 2);
    expect(s.state.players[0].loadout.weapon).toBe(0);
    const drop = (s.state.room.gearDrops ?? []).find((d) => d.item.slot === 'weapon');
    expect(drop).toBeDefined();
    // relevage par le joueur 1
    put(s, 1, s.state.players[0].pos.x + 2, s.state.players[0].pos.y);
    for (let i = 0; i < Math.ceil(6000 / DT) && s.state.players[0].status !== 'alive'; i++) s.step(DT, { 1: { moveX: 0, moveY: 0, attack: false, interact: false, revive: true } });
    expect(s.state.players[0].status).toBe('alive');
    put(s, 0, drop!.pos.x, drop!.pos.y);
    stepN(s, 3);
    expect(s.state.players[0].loadout.weapon).toBe(2);
    // sans arme il aurait frappé ; avec l'arme reprise : une hache part
    s.state.players[0].facing = 'right';
    s.state.players[0].attackCooldownMs = 0;
    put(s, 0, 60, 56);
    stepN(s, 1, ATTACK);
    expect(s.state.room.projectiles.some((p) => p.kind === 'axe')).toBe(true);
  });

  it('un héros de mêlée sans arme ne tire jamais : son attaque effective reste le corps à corps (niveau 0)', () => {
    for (const id of MELEE_HEROES) {
      const g = createGear();
      expect(effectiveAttack(getCharacter(id), g).kind).toBe('melee');
    }
    expect(CHARACTER_LIST.length).toBe(8);
  });

  it("équipement DÉSACTIVÉ (`gear: false`) : aucune arme n'apparaît, le héros de mêlée frappe au corps à corps et aucun projectile de joueur n'est tiré", () => {
    const s = mk(1, 'david', room('r1', { enemies: [{ kind: 'skeleton', tile: [4, 2] }] }), false);
    expect(s.state.gearEnabled).toBe(false);
    s.step(DT, NOTHING);
    const e = s.state.room.enemies[0];
    const hp0 = e.hp;
    e.pos = { x: 4 * 16 + 8, y: 2 * 16 + 8 };
    let playerShots = 0;
    for (let i = 0; i < 120; i++) {
      put(s, 0, 4 * 16 + 8 - 14, 2 * 16 + 8);
      s.state.players[0].facing = 'right';
      s.step(DT, ATTACK);
      playerShots += s.state.room.projectiles.filter((p) => p.owner.type === 'player').length;
    }
    expect(playerShots).toBe(0);
    expect(s.state.players[0].loadout.weapon).toBe(0);
    expect(effectiveAttack(getCharacter('david'), s.state.players[0].loadout).kind).toBe('melee');
    // l'ennemi a été blessé par le corps à corps (ou déjà vaincu et retiré de la salle)
    const left = s.state.room.enemies[0];
    expect(left === undefined || left.hp < hp0).toBe(true);
  });
});
