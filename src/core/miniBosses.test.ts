/**
 * Demi-boss et boss des niveaux 4-6 : warden (demi-boss niv.4), frostqueen (boss niv.4), pyromancer (demi-boss niv.5),
 * forgelord (boss niv.5), wraith (demi-boss niv.6), voidlord (boss niv.6).
 *
 * Tests d'IA sur un faux contexte (comme bosses.test.ts), de plafond de dégâts, d'équilibrage (temps de mort minimal
 * avec 4 joueurs), de difficulté (seuls PV/dégâts changent) et d'intégration dans la simulation (sortie 'clear',
 * salle de boss au redémarrage, invocations, fuzz déterministe, sérialisation JSON).
 */
import { describe, expect, it } from 'vitest';
import { getDictionary, hasKey } from '../i18n/i18n';
import { createEnemyState, knockEnemy, onEnemyHit, stunEnemy, updateEnemy } from './ai';
import { damageToEnemy, damageToPlayer, DIFFICULTY_TABLE } from './balance';
import { BOSS_PROFILES, bossPhaseCount, fanLanesFor } from './bossData';
import { ENEMY_SPECIALS, MIN_BOSS_WINDUP_MS, PHASE_ROAR_MS, bossPhaseFor } from './bosses';
import { CHARACTER_IDS, getCharacter } from './characters';
import {
  BOSS_DAMAGE_CAP_FRACTION,
  BOSS_DAMAGE_WINDOW_MS,
  MINIBOSS_DAMAGE_CAP_FRACTION,
  canPlayerAttack,
  canPlayerSpecial,
  damageEnemy,
  performPlayerAttack,
  performPlayerSpecial,
  stepProjectiles,
  stepSpecialEffects,
  type CombatContext,
} from './combat';
import { SIM_STEP_MS, TILE, WIPE_RESTART_DELAY_MS } from './constants';
import {
  BOSS_KINDS,
  ENEMIES,
  ENEMY_KINDS,
  MINI_BOSS_KINDS,
  isAnyBossKind,
  isBossKind,
  isFlyingKind,
  isMiniBossKind,
} from './enemies';
import { angleDiff, dist } from './geometry';
import { RoomGrid } from './grid';
import { makeTestLayout, makeTestLevel, makeTestRoom } from './levelValidation';
import { applyDamageToPlayer, createPlayerState, stepPlayerTimers } from './players';
import { createRng, nextRandom, randomFn } from './rng';
import { createSimulation, GameSimulation, MAX_ALIVE_ENEMIES } from './simulation';
import type {
  ActionFrame,
  CharacterId,
  Difficulty,
  Dir,
  EnemyAIContext,
  EnemyKind,
  EnemyState,
  LevelDef,
  PlayerId,
  PlayerSetup,
  PlayerState,
  ProjectileKind,
  RoomDef,
  SimEvent,
  Vec2,
} from './types';

const DT = SIM_STEP_MS;
const S = ENEMY_SPECIALS;

const MINI: EnemyKind[] = ['warden', 'pyromancer', 'wraith'];
const FINAL: EnemyKind[] = ['frostqueen', 'forgelord', 'voidlord'];
const NEW_KINDS: EnemyKind[] = ['warden', 'frostqueen', 'pyromancer', 'forgelord', 'wraith', 'voidlord'];
const MAX_PHASE: Record<string, number> = {
  warden: 2,
  frostqueen: 3,
  pyromancer: 2,
  forgelord: 3,
  wraith: 2,
  voidlord: 4,
};
/** Plafond de sbires vivants invoqués par boss. */
const MINION_CAP: Record<string, number> = { frostqueen: 4, pyromancer: 2, forgelord: 2, voidlord: 3 };

// ───────────────────────────── Faux contexte d'IA ─────────────────────────────

interface Shot {
  tick: number;
  kind: ProjectileKind;
  pos: Vec2;
  vel: Vec2;
  damage: number;
  lifeMs: number;
  enemyId: number;
  special: number;
}
interface Circle {
  tick: number;
  center: Vec2;
  radius: number;
  damage: number;
  special: number;
  mode: string;
}
interface Harness {
  ctx: EnemyAIContext;
  players: PlayerState[];
  enemies: EnemyState[];
  shots: Shot[];
  circles: Circle[];
  spawns: { kind: EnemyKind; pos: Vec2; id: number }[];
  events: SimEvent[];
  moveFlying: boolean[];
  occupyFlying: boolean[];
  tick: number;
  step: (boss: EnemyState) => void;
}

const ROOM_W = 480;
const ROOM_H = 320;

function makePlayer(id: PlayerId, x: number, y: number, difficulty: Difficulty = 2, status: 'alive' | 'down' = 'alive'): PlayerState {
  const p = createPlayerState({ id, characterId: 'david', difficulty }, { x, y });
  p.status = status;
  if (status === 'down') p.hp = 0;
  return p;
}

function makeHarness(players: PlayerState[], seed = 1): Harness {
  const rng = createRng(seed);
  const enemies: EnemyState[] = [];
  let nextId = 1000;
  let cur: EnemyState | null = null;
  const h: Harness = {
    ctx: undefined as unknown as EnemyAIContext,
    players,
    enemies,
    shots: [],
    circles: [],
    spawns: [],
    events: [],
    moveFlying: [],
    occupyFlying: [],
    tick: 0,
    step: () => undefined,
  };
  const free = (p: Vec2, r: number): boolean => p.x >= r && p.x <= ROOM_W - r && p.y >= r && p.y <= ROOM_H - r;
  h.ctx = {
    dtMs: DT,
    players,
    enemies,
    random: randomFn(rng),
    canOccupy: (pos, radius, flying) => {
      h.occupyFlying.push(flying === true);
      return free(pos, radius);
    },
    moveWithCollision: (pos, delta, radius, flying) => {
      h.moveFlying.push(flying === true);
      let x = pos.x;
      let y = pos.y;
      if (free({ x: x + delta.x, y }, radius)) x += delta.x;
      if (free({ x, y: y + delta.y }, radius)) y += delta.y;
      return { x, y };
    },
    spawnProjectile: (p) => {
      h.shots.push({
        tick: h.tick,
        kind: p.kind,
        pos: { ...p.pos },
        vel: { ...p.vel },
        damage: p.damage,
        lifeMs: p.lifeMs,
        enemyId: p.enemyId,
        special: cur ? cur.data.special : -1,
      });
    },
    spawnEnemy: (kind, pos) => {
      const e = createEnemyState(kind, pos, nextId++, 0);
      enemies.push(e);
      h.spawns.push({ kind, pos: { ...pos }, id: e.id });
      return e.id;
    },
    damageCircle: (center, radius, damage) => {
      h.circles.push({
        tick: h.tick,
        center: { ...center },
        radius,
        damage,
        special: cur ? cur.data.special : -1,
        mode: cur ? cur.mode : '',
      });
    },
    roomBounds: { width: ROOM_W, height: ROOM_H },
    emit: (e) => {
      h.events.push(e);
    },
  };
  h.step = (boss) => {
    cur = boss;
    h.tick++;
    updateEnemy(boss, h.ctx);
  };
  return h;
}

function spawn(kind: EnemyKind, x = 240, y = 160): EnemyState {
  return createEnemyState(kind, { x, y }, 1, 0);
}

function allFinite(e: EnemyState): boolean {
  const nums = [e.pos.x, e.pos.y, e.hp, e.maxHp, e.modeTimerMs, e.attackCooldownMs, e.hitFlashMs, e.phase, e.targetId];
  return nums.every(Number.isFinite) && Object.values(e.data).every(Number.isFinite);
}

/** Fait tourner `ms` ms ; les joueurs restent invulnérables (on teste l'IA, pas la survie). */
function run(h: Harness, boss: EnemyState, ms: number, each?: (pre: string, post: string) => void): void {
  const steps = Math.round(ms / DT);
  for (let i = 0; i < steps; i++) {
    for (const p of h.players) if (p.status === 'alive') p.invulnMs = 1e9;
    const pre = boss.mode;
    h.step(boss);
    each?.(pre, boss.mode);
  }
}

/** Avance jusqu'à ce que `cond()` soit vraie (ou `maxMs`). Retourne true si atteinte. */
function runUntil(h: Harness, boss: EnemyState, cond: () => boolean, maxMs = 60000): boolean {
  const steps = Math.round(maxMs / DT);
  for (let i = 0; i < steps; i++) {
    for (const p of h.players) if (p.status === 'alive') p.invulnMs = 1e9;
    h.step(boss);
    if (cond()) return true;
  }
  return false;
}

/** Engage le boss (1 pas), le met à `hpFrac` PV, puis le force à attaquer `special` en premier. */
function engageWith(h: Harness, boss: EnemyState, hpFrac: number, special: number): void {
  boss.hp = boss.maxHp * hpFrac;
  run(h, boss, 100);
  const phase = Math.min(boss.phase, MAX_PHASE[boss.kind] ?? 3);
  const seq = BOSS_PROFILES[boss.kind]!.seq[phase];
  const idx = seq.findIndex((e) => e[0] === special);
  if (idx < 0) throw new Error(`${boss.kind} phase ${phase} : pas de ${special}`);
  boss.data.seq = idx;
  boss.attackCooldownMs = 0;
  boss.mode = 'chase';
}

function specialsUsed(h: Harness, boss: EnemyState, ms: number, hpFrac: number): Set<number> {
  boss.hp = boss.maxHp * hpFrac;
  const used = new Set<number>();
  run(h, boss, ms, (pre, post) => {
    if (pre !== 'windup' && post === 'windup') used.add(boss.data.special);
    if (post === 'teleport' && pre !== 'teleport') used.add(S.TELEPORT);
  });
  return used;
}

// ───────────────────────────── Définitions et assistants ─────────────────────────────

describe('définitions des 6 nouveaux ennemis', () => {
  it('isBoss / isMiniBoss, IA, clé i18n, PV et dégâts cohérents', () => {
    for (const k of MINI) {
      expect(ENEMIES[k].isBoss, k).toBe(false);
      expect(ENEMIES[k].isMiniBoss, k).toBe(true);
      expect(ENEMIES[k].ai).toBe(`miniboss-${k}`);
    }
    for (const k of FINAL) {
      expect(ENEMIES[k].isBoss, k).toBe(true);
      expect(ENEMIES[k].ai).toBe(`boss-${k}`);
    }
    for (const k of NEW_KINDS) {
      expect(ENEMY_KINDS).toContain(k);
      expect(ENEMIES[k].nameKey).toBe(`enemy.${k}`);
      expect(BOSS_PROFILES[k], k).toBeDefined();
    }
    // PV : le gardien ≈ 3 × le chevalier ; difficulté croissante des demi-boss et des boss
    expect(ENEMIES.warden.hp / ENEMIES.knight.hp).toBeGreaterThanOrEqual(2.5);
    expect(ENEMIES.warden.hp / ENEMIES.knight.hp).toBeLessThanOrEqual(3.2);
    expect(ENEMIES.warden.hp).toBeLessThan(ENEMIES.pyromancer.hp);
    expect(ENEMIES.pyromancer.hp).toBeLessThan(ENEMIES.wraith.hp);
    expect(ENEMIES.wraith.hp).toBeLessThan(ENEMIES.golem.hp);
    expect(ENEMIES.frostqueen.hp).toBeGreaterThan(ENEMIES.golem.hp);
    expect(ENEMIES.frostqueen.hp).toBeLessThan(ENEMIES.forgelord.hp);
    expect(ENEMIES.forgelord.hp).toBeLessThan(ENEMIES.voidlord.hp);
    for (const k of MINI) for (const f of FINAL) expect(ENEMIES[k].hp).toBeLessThan(ENEMIES[f].hp);
    for (const k of NEW_KINDS) expect(ENEMIES[k].damage).toBeGreaterThan(ENEMIES.knight.damage - 5);
  });

  it('isBossKind / isMiniBossKind / isAnyBossKind / isFlyingKind', () => {
    expect(BOSS_KINDS).toEqual(['golem', 'morvane', 'frostqueen', 'forgelord', 'voidlord']);
    expect(MINI_BOSS_KINDS).toEqual(['warden', 'pyromancer', 'wraith']);
    for (const k of ENEMY_KINDS) {
      expect(isBossKind(k)).toBe(BOSS_KINDS.includes(k));
      expect(isMiniBossKind(k)).toBe(MINI_BOSS_KINDS.includes(k));
      expect(isAnyBossKind(k)).toBe(BOSS_KINDS.includes(k) || MINI_BOSS_KINDS.includes(k));
    }
    expect(isBossKind('dragon')).toBe(false);
    expect(isMiniBossKind('dragon')).toBe(false);
    for (const k of ['bat', 'wisp', 'morvane', 'wraith', 'voidlord']) expect(isFlyingKind(k)).toBe(true);
    for (const k of ['slime', 'knight', 'golem', 'warden', 'frostqueen', 'pyromancer', 'forgelord']) expect(isFlyingKind(k)).toBe(false);
  });

  it('nombre de phases : 2 pour les demi-boss, 3 pour les boss niv.4-5, 4 pour le seigneur du Néant', () => {
    for (const k of NEW_KINDS) expect(bossPhaseCount(k)).toBe(MAX_PHASE[k]);
    expect(bossPhaseCount('golem')).toBe(3);
    expect(bossPhaseCount('morvane')).toBe(3);
    expect(bossPhaseCount('slime')).toBe(3);
  });
});

describe('clés i18n des 6 nouveaux ennemis (parts bosses.fr/en)', () => {
  it('enemy.<kind> et enemy.<kind>.desc existent en fr et en, non vides, distincts entre les deux langues', () => {
    for (const k of NEW_KINDS) {
      for (const lang of ['fr', 'en'] as const) {
        expect(hasKey(ENEMIES[k].nameKey, lang), `${lang}:${ENEMIES[k].nameKey}`).toBe(true);
        expect(hasKey(`${ENEMIES[k].nameKey}.desc`, lang), `${lang}:${k}.desc`).toBe(true);
        expect(getDictionary(lang)[ENEMIES[k].nameKey].trim().length).toBeGreaterThan(0);
      }
      expect(getDictionary('fr')[ENEMIES[k].nameKey]).not.toBe(getDictionary('en')[ENEMIES[k].nameKey]);
    }
  });
});

describe('bossPhaseFor (niveaux 4-6)', () => {
  it('demi-boss : phase 2 (rage) à 50 % pile', () => {
    for (const k of MINI) {
      const max = ENEMIES[k].hp;
      expect(bossPhaseFor(k, max, max)).toBe(1);
      expect(bossPhaseFor(k, max * 0.51, max)).toBe(1);
      expect(bossPhaseFor(k, max * 0.5, max)).toBe(2);
      expect(bossPhaseFor(k, 1, max)).toBe(2);
    }
  });

  it('seuils des boss de fin (reine 70/40, forge 70/35, Néant 75/50/25)', () => {
    const cases: [EnemyKind, number[]][] = [
      ['frostqueen', [0.7, 0.4]],
      ['forgelord', [0.7, 0.35]],
      ['voidlord', [0.75, 0.5, 0.25]],
    ];
    for (const [k, ths] of cases) {
      const max = ENEMIES[k].hp;
      expect(bossPhaseFor(k, max, max)).toBe(1);
      ths.forEach((t, i) => {
        expect(bossPhaseFor(k, max * (t + 0.01), max), `${k} juste au-dessus de ${t}`).toBe(i + 1);
        expect(bossPhaseFor(k, max * t, max), `${k} à ${t}`).toBe(i + 2);
      });
      expect(bossPhaseFor(k, 1, max)).toBe(ths.length + 1);
    }
  });

  it('valeurs dégénérées : jamais NaN ni 0', () => {
    for (const k of NEW_KINDS) {
      expect(bossPhaseFor(k, Number.NaN, 100)).toBe(1);
      expect(bossPhaseFor(k, 10, 0)).toBe(1);
    }
  });
});

// ───────────────────────────── Phases et télégraphes (tous) ─────────────────────────────

describe('phases en combat', () => {
  it.each(NEW_KINDS)('%s : phases dans l\'ordre aux seuils de PV, événements bossPhase, rugissement sans attaque', (kind) => {
    const player = makePlayer(0, 240 + 70, 160);
    const h = makeHarness([player], 5);
    const boss = spawn(kind);
    expect(boss.phase).toBe(0);
    run(h, boss, 200);
    expect(boss.phase).toBe(1);
    expect(boss.data.engaged).toBe(1);
    const ths = BOSS_PROFILES[kind]!.thresholds;
    const seen: number[] = [1];
    ths.forEach((t, i) => {
      boss.hp = boss.maxHp * (t - 0.01);
      const before = h.circles.length + h.shots.length;
      h.step(boss);
      expect(boss.phase).toBe(i + 2);
      expect(boss.mode).toBe('recover');
      expect(boss.data.special).toBe(S.ROAR);
      run(h, boss, PHASE_ROAR_MS - 100);
      expect(h.circles.length + h.shots.length, 'aucune attaque pendant le rugissement').toBe(before);
      seen.push(boss.phase);
    });
    const phases = h.events.flatMap((e) => (e.type === 'bossPhase' ? [e.phase] : []));
    expect(phases).toEqual(seen);
    expect(phases[phases.length - 1]).toBe(MAX_PHASE[kind]);
    // un soin ne fait pas régresser la phase
    boss.hp = boss.maxHp;
    run(h, boss, 500);
    expect(boss.phase).toBe(MAX_PHASE[kind]);
  });

  it.each(NEW_KINDS)('%s : les PV décroissants traversent toutes les phases (balayage)', (kind) => {
    const player = makePlayer(0, 240 + 70, 160);
    const h = makeHarness([player], 7);
    const boss = spawn(kind);
    const seen: number[] = [boss.phase];
    for (let i = 0; i < 6000; i++) {
      player.invulnMs = 1e9;
      boss.hp = Math.max(1, boss.maxHp * (1 - i / 5500));
      h.step(boss);
      if (seen[seen.length - 1] !== boss.phase) seen.push(boss.phase);
    }
    expect(seen).toEqual([0, ...Array.from({ length: MAX_PHASE[kind] }, (_, i) => i + 1)]);
  });
});

describe('attaques toujours télégraphées (>= 600 ms)', () => {
  for (const kind of NEW_KINDS) {
    for (const hpFrac of [1, 0.6, 0.45, 0.3, 0.15]) {
      it(`${kind} à ${Math.round(hpFrac * 100)} % des PV : aucun effet sans windup >= 600 ms, effets en mode attack uniquement`, () => {
        const player = makePlayer(0, 240 + 80, 160);
        const h = makeHarness([player], 11);
        const boss = spawn(kind);
        boss.hp = boss.maxHp * hpFrac;
        let windupMs = 0;
        let attacks = 0;
        let effects = 0;
        run(h, boss, 45000, (pre, post) => {
          const now = h.circles.length + h.shots.length + h.spawns.length;
          if (now > effects) {
            // un effet n'a lieu qu'en 'attack' (ou à la transition windup -> attack)
            expect(pre === 'attack' || (pre === 'windup' && post === 'attack'), `${kind}: effet en mode ${pre}->${post}`).toBe(true);
            effects = now;
          }
          if (pre === 'windup') {
            windupMs += DT;
            expect(boss.data.windupTotalMs).toBeGreaterThanOrEqual(MIN_BOSS_WINDUP_MS);
            expect(boss.data.special).not.toBe(S.NONE);
          }
          if (pre === 'windup' && post === 'attack') {
            attacks++;
            expect(windupMs).toBeGreaterThanOrEqual(MIN_BOSS_WINDUP_MS - DT);
            windupMs = 0;
          }
          if (pre !== 'windup') windupMs = 0;
        });
        expect(attacks).toBeGreaterThan(4);
        expect(effects).toBeGreaterThan(0);
      });
    }
  }

  it('un seul joueur : fenêtres de récupération plus longues qu\'à 4 joueurs (équité)', () => {
    for (const kind of NEW_KINDS) {
      const measure = (n: number): number => {
        const players = Array.from({ length: n }, (_, i) => makePlayer(i as PlayerId, 280 + i * 4, 160));
        const h = makeHarness(players, 61);
        const boss = spawn(kind);
        let recover = 0;
        let counting = false;
        let done = false;
        run(h, boss, 30000, (pre, post) => {
          if (done) return;
          if (counting && pre === 'recover') recover += DT;
          if (counting && pre === 'recover' && post !== 'recover') done = true;
          if (!counting && pre === 'attack' && post === 'recover' && boss.data.comboLeft === 0 && boss.data.comboPending === 0) counting = true;
        });
        return recover;
      };
      expect(measure(1), kind).toBeGreaterThan(measure(4) * 1.1);
    }
  });
});

// ───────────────────────────── Comportements distincts ─────────────────────────────

describe('comportements propres à chaque IA', () => {
  it('chaque boss a un répertoire d\'attaques DISTINCT (aucun doublon d\'ensemble)', () => {
    const sets = new Map<EnemyKind, string>();
    for (const kind of [...NEW_KINDS, 'golem', 'morvane'] as EnemyKind[]) {
      const player = makePlayer(0, 240 + 80, 160);
      const h = makeHarness([player], 3);
      const used = new Set<number>();
      for (const frac of [1, 0.6, 0.45, 0.3, 0.1]) for (const s of specialsUsed(h, spawn(kind), 40000, frac)) used.add(s);
      sets.set(kind, [...used].sort((a, b) => a - b).join(','));
    }
    const values = [...sets.values()];
    expect(new Set(values).size).toBe(values.length);
    // signatures attendues
    expect(sets.get('warden')).toContain(String(S.HEAVY));
    expect(sets.get('warden')).toContain(String(S.CHARGE));
    expect(sets.get('frostqueen')).toContain(String(S.BLIZZARD));
    expect(sets.get('pyromancer')).toContain(String(S.NOVA));
    expect(sets.get('forgelord')).toContain(String(S.SHOCKWAVE));
    expect(sets.get('wraith')).toContain(String(S.DARKBOLT));
    expect(sets.get('voidlord')).toContain(String(S.VOIDZONE));
  });

  describe('gardien de givre (warden)', () => {
    it('coup lourd : zone de 24 px décalée de 18 px vers la cible, dégâts pleins, après télégraphe', () => {
      const player = makePlayer(0, 240 + 40, 160);
      const h = makeHarness([player], 21);
      const boss = spawn('warden');
      engageWith(h, boss, 1, S.HEAVY);
      let aim = Number.NaN;
      expect(runUntil(h, boss, () => {
        if (boss.mode === 'windup' && boss.data.special === S.HEAVY) {
          aim = boss.data.aimAngle;
          expect(boss.data.telegraphRadius).toBe(24);
          expect(boss.data.telegraphDist).toBe(18);
        }
        return h.circles.some((c) => c.special === S.HEAVY);
      })).toBe(true);
      const c = h.circles.find((x) => x.special === S.HEAVY)!;
      expect(c.radius).toBe(24);
      expect(c.damage).toBe(ENEMIES.warden.damage);
      expect(dist(c.center, boss.pos)).toBeCloseTo(18, 5);
      expect(angleDiff(Math.atan2(c.center.y - boss.pos.y, c.center.x - boss.pos.x), aim)).toBeLessThan(1e-6);
    });

    it('charge : télégraphe long (>= 900 ms) puis déplacement en ligne droite > 100 px, dégâts au contact', () => {
      const player = makePlayer(0, 240 + 150, 160);
      const h = makeHarness([player], 22);
      const boss = spawn('warden');
      engageWith(h, boss, 1, S.CHARGE);
      let start: Vec2 | null = null;
      let moved = 0;
      let windup = 0;
      run(h, boss, 8000, (pre, post) => {
        if (pre !== 'windup' && post === 'windup' && boss.data.special === S.CHARGE) {
          windup = boss.data.windupTotalMs;
          expect(boss.data.telegraphLength).toBeGreaterThan(120);
        }
        if (pre === 'windup' && post === 'attack' && boss.data.special === S.CHARGE) start = { ...boss.pos };
        if (pre === 'attack' && post === 'recover' && start) {
          moved = Math.max(moved, dist(start, boss.pos));
          start = null;
        }
      });
      expect(windup).toBeGreaterThanOrEqual(900);
      expect(moved).toBeGreaterThan(100);
      expect(h.circles.filter((c) => c.special === S.CHARGE).length).toBeGreaterThan(5);
    });

    it('coup de sol : zone seule en phase 1, + anneau d\'éclats de glace en rage (phase 2)', () => {
      const countRing = (hpFrac: number): number => {
        const player = makePlayer(0, 240 + 40, 160);
        const h = makeHarness([player], 23);
        const boss = spawn('warden');
        engageWith(h, boss, hpFrac, S.SLAM);
        runUntil(h, boss, () => h.circles.some((c) => c.special === S.SLAM));
        expect(h.circles.find((c) => c.special === S.SLAM)!.radius).toBe(46);
        return h.shots.filter((s) => s.special === S.SLAM && s.kind === 'shard').length;
      };
      expect(countRing(1)).toBe(0);
      expect(countRing(0.4)).toBe(10);
    });

    it('rage : plus rapide (>= 1,25 ×) et enchaîne un second coup lourd re-télégraphé', () => {
      const walked = (hpFrac: number): number => {
        const far = makePlayer(0, 460, 160);
        const h = makeHarness([far], 24);
        const boss = spawn('warden', 260, 160);
        boss.hp = boss.maxHp * hpFrac;
        boss.attackCooldownMs = 1e9;
        run(h, boss, 1500);
        const x0 = boss.pos.x;
        boss.attackCooldownMs = 1e9;
        run(h, boss, 1000);
        return boss.pos.x - x0;
      };
      expect(walked(0.4)).toBeGreaterThan(walked(1) * 1.25);

      const player = makePlayer(0, 240 + 40, 160);
      const h = makeHarness([player], 25);
      const boss = spawn('warden');
      engageWith(h, boss, 0.4, S.HEAVY);
      runUntil(h, boss, () => h.circles.filter((c) => c.special === S.HEAVY).length >= 2, 20000);
      const ticks = h.circles.filter((c) => c.special === S.HEAVY).map((c) => c.tick);
      expect(ticks.length).toBeGreaterThanOrEqual(2);
      expect((ticks[1] - ticks[0]) * DT).toBeGreaterThanOrEqual(MIN_BOSS_WINDUP_MS);
    });

    it('au sol : ne vole pas (moveWithCollision flying=false)', () => {
      const h = makeHarness([makePlayer(0, 360, 160)], 26);
      const boss = spawn('warden');
      run(h, boss, 10000);
      expect(h.moveFlying.length).toBeGreaterThan(0);
      expect(h.moveFlying.every((f) => !f)).toBe(true);
    });
  });

  describe('reine du givre (frostqueen)', () => {
    it('blizzard : anneau d\'éclats de glace avec 2 brèches (vers la cible et à l\'opposé)', () => {
      const player = makePlayer(0, 240 + 100, 160);
      const h = makeHarness([player], 31);
      const boss = spawn('frostqueen');
      engageWith(h, boss, 1, S.BLIZZARD);
      let aim = 0;
      runUntil(h, boss, () => {
        if (boss.mode === 'windup' && boss.data.special === S.BLIZZARD) aim = boss.data.aimAngle;
        return h.shots.some((s) => s.special === S.BLIZZARD);
      });
      const ring = h.shots.filter((s) => s.special === S.BLIZZARD);
      expect(ring.length).toBeGreaterThan(8);
      expect(ring.length).toBeLessThan(16); // 16 voies - brèches
      expect(ring.every((s) => s.kind === 'shard')).toBe(true);
      for (const s of ring) {
        const a = Math.atan2(s.vel.y, s.vel.x);
        expect(angleDiff(a, aim), 'brèche vers la cible').toBeGreaterThanOrEqual(0.3 - 1e-6);
        expect(angleDiff(a, aim + Math.PI), 'brèche opposée').toBeGreaterThanOrEqual(0.3 - 1e-6);
      }
    });

    it('phase 1 : ne se téléporte pas ; phase 2+ : se téléporte après ses attaques vers des points valides loin des joueurs', () => {
      const countTeleports = (hpFrac: number): number => {
        const players = [makePlayer(0, 100, 100), makePlayer(1, 380, 220)];
        const h = makeHarness(players, 32);
        const boss = spawn('frostqueen');
        boss.hp = boss.maxHp * hpFrac;
        let n = 0;
        run(h, boss, 40000, (pre, post) => {
          if (post === 'teleport' && pre !== 'teleport') {
            n++;
            expect(boss.data.special).toBe(S.TELEPORT);
          }
          if (pre === 'teleport' && post !== 'teleport') {
            expect(h.ctx.canOccupy(boss.pos, ENEMIES.frostqueen.radius, false)).toBe(true);
            for (const p of players) expect(dist(boss.pos, p.pos)).toBeGreaterThanOrEqual(40);
          }
        });
        return n;
      };
      // En phase 1 elle ne se téléporte jamais après une attaque ; seule la téléportation « anti-collage » reste possible (non provoquée ici).
      expect(countTeleports(1)).toBe(0);
      expect(countTeleports(0.55)).toBeGreaterThanOrEqual(3);
      expect(countTeleports(0.2)).toBeGreaterThanOrEqual(3);
    });

    it('invocations de chauves-souris / squelettes : plafond de 4 sbires vivants, marqués par le boss', () => {
      const player = makePlayer(0, 240 + 100, 160);
      const h = makeHarness([player], 33);
      const boss = spawn('frostqueen');
      boss.hp = boss.maxHp * 0.55;
      let maxAlive = 0;
      run(h, boss, 90000, () => {
        maxAlive = Math.max(maxAlive, h.enemies.filter((e) => !e.dead && e.data.summoner === boss.id).length);
      });
      expect(h.spawns.length).toBeGreaterThanOrEqual(2);
      expect(h.spawns.every((s) => s.kind === 'bat' || s.kind === 'skeleton')).toBe(true);
      expect(new Set(h.spawns.map((s) => s.kind)).size).toBe(2);
      expect(maxAlive).toBe(MINION_CAP.frostqueen);
      expect(h.spawns.length).toBe(MINION_CAP.frostqueen);
    });

    it('phase 3 : glissade télégraphée (>= 900 ms) avec trace d\'éclats sur les côtés', () => {
      const player = makePlayer(0, 240 + 130, 160);
      const h = makeHarness([player], 34);
      const boss = spawn('frostqueen');
      engageWith(h, boss, 0.2, S.SLIDE);
      let start: Vec2 | null = null;
      let moved = 0;
      let windup = 0;
      run(h, boss, 6000, (pre, post) => {
        if (pre !== 'windup' && post === 'windup' && boss.data.special === S.SLIDE) {
          windup = boss.data.windupTotalMs;
          expect(boss.data.telegraphLength).toBeGreaterThan(100);
        }
        if (pre === 'windup' && post === 'attack' && boss.data.special === S.SLIDE) start = { ...boss.pos };
        if (pre === 'attack' && post === 'recover' && start) {
          moved = Math.max(moved, dist(start, boss.pos));
          start = null;
        }
      });
      expect(windup).toBeGreaterThanOrEqual(900);
      expect(moved).toBeGreaterThan(80);
      const trail = h.shots.filter((s) => s.special === S.SLIDE);
      expect(trail.length).toBeGreaterThanOrEqual(4);
      expect(trail.every((s) => s.kind === 'shard')).toBe(true);
    });

    it('éventail : 5 éclats en phase 1, 9 en phase 3', () => {
      const count = (hpFrac: number): number => {
        const player = makePlayer(0, 240 + 100, 160);
        const h = makeHarness([player], 35);
        const boss = spawn('frostqueen');
        engageWith(h, boss, hpFrac, S.FAN);
        runUntil(h, boss, () => h.shots.some((s) => s.special === S.FAN));
        return h.shots.filter((s) => s.special === S.FAN).length;
      };
      expect(count(1)).toBe(5);
      expect(count(0.2)).toBe(9);
    });
  });

  describe('pyromancien (pyromancer)', () => {
    it('garde ses distances : ne reste pas collé à un joueur immobile, ne le fuit pas indéfiniment', () => {
      const player = makePlayer(0, 240 + 140, 160);
      const h = makeHarness([player], 41);
      const boss = spawn('pyromancer');
      let minD = Infinity;
      let maxD = 0;
      run(h, boss, 4000);
      run(h, boss, 12000, () => {
        const d = dist(boss.pos, player.pos);
        minD = Math.min(minD, d);
        maxD = Math.max(maxD, d);
      });
      expect(minD).toBeGreaterThan(55);
      expect(maxD).toBeLessThan(200);
    });

    it('trop près d\'un joueur : recule et/ou lance sa nova de panique télégraphée puis se replie', () => {
      const player = makePlayer(0, 240 + 25, 160);
      const h = makeHarness([player], 42);
      const boss = spawn('pyromancer');
      let sawNovaWindup = false;
      let maxD = 0;
      run(h, boss, 8000, (pre, post) => {
        if (pre !== 'windup' && post === 'windup' && boss.data.special === S.NOVA) {
          sawNovaWindup = true;
          expect(boss.data.windupTotalMs).toBeGreaterThanOrEqual(900);
          expect(boss.data.telegraphRadius).toBe(46);
        }
        maxD = Math.max(maxD, dist(boss.pos, player.pos));
      });
      expect(maxD).toBeGreaterThan(70);
      expect(sawNovaWindup || maxD > 80).toBe(true);
    });

    it('nova de feu : zone de 46 px autour de lui + anneau d\'orbes (12, puis 16 en phase 2)', () => {
      const rings = (hpFrac: number): number => {
        const player = makePlayer(0, 240 + 60, 160);
        const h = makeHarness([player], 43);
        const boss = spawn('pyromancer');
        engageWith(h, boss, hpFrac, S.NOVA);
        runUntil(h, boss, () => h.circles.some((c) => c.special === S.NOVA));
        const c = h.circles.find((x) => x.special === S.NOVA)!;
        expect(c.radius).toBe(46);
        expect(c.center).toEqual(boss.pos);
        expect(c.damage).toBe(ENEMIES.pyromancer.damage);
        return h.shots.filter((s) => s.special === S.NOVA && s.kind === 'orb').length;
      };
      expect(rings(1)).toBe(12);
      expect(rings(0.4)).toBe(16);
    });

    it('boules de feu : éventail de 3 (phase 1) puis 5 (phase 2)', () => {
      const count = (hpFrac: number): number => {
        const player = makePlayer(0, 240 + 110, 160);
        const h = makeHarness([player], 44);
        const boss = spawn('pyromancer');
        engageWith(h, boss, hpFrac, S.FIREBALL);
        runUntil(h, boss, () => h.shots.some((s) => s.special === S.FIREBALL));
        return h.shots.filter((s) => s.special === S.FIREBALL).length;
      };
      expect(count(1)).toBe(3);
      expect(count(0.4)).toBe(5);
    });

    it('invoque des feux follets : plafond de 2 vivants, même s\'il y a d\'autres feux follets dans la salle', () => {
      const player = makePlayer(0, 240 + 110, 160);
      const h = makeHarness([player], 45);
      // 5 feux follets « de décor » (non invoqués) ne comptent pas dans le plafond
      for (let i = 0; i < 5; i++) h.enemies.push(createEnemyState('wisp', { x: 20 + i, y: 20 }, 50 + i, 0));
      const boss = spawn('pyromancer');
      let maxAlive = 0;
      run(h, boss, 90000, () => {
        maxAlive = Math.max(maxAlive, h.enemies.filter((e) => !e.dead && e.data.summoner === boss.id).length);
      });
      expect(h.spawns.length).toBe(MINION_CAP.pyromancer);
      expect(h.spawns.every((s) => s.kind === 'wisp')).toBe(true);
      expect(maxAlive).toBe(MINION_CAP.pyromancer);
    });

    it("ne se téléporte qu'après sa nova (jamais après une boule de feu ou une invocation)", () => {
      const players = [makePlayer(0, 100, 100), makePlayer(1, 380, 220)];
      const h = makeHarness(players, 46);
      const boss = spawn('pyromancer');
      let lastAttack = -1;
      let teleports = 0;
      run(h, boss, 60000, (pre, post) => {
        if (post === 'attack') lastAttack = boss.data.special;
        if (pre === 'recover' && post === 'teleport') {
          teleports++;
          expect(lastAttack).toBe(S.NOVA);
        }
      });
      expect(teleports).toBeGreaterThan(0);
    });
  });

  describe('seigneur de la forge (forgelord)', () => {
    it('marteau : zone de 36 px à 30 px devant lui + onde de choc (14 orbes en phase 1, 20 en enrage)', () => {
      const ring = (hpFrac: number): number => {
        const player = makePlayer(0, 240 + 50, 160);
        const h = makeHarness([player], 51);
        const boss = spawn('forgelord');
        engageWith(h, boss, hpFrac, S.SHOCKWAVE);
        runUntil(h, boss, () => h.circles.some((c) => c.special === S.SHOCKWAVE));
        const c = h.circles.find((x) => x.special === S.SHOCKWAVE)!;
        expect(c.radius).toBe(36);
        expect(dist(c.center, boss.pos)).toBeCloseTo(30, 5);
        expect(c.damage).toBe(ENEMIES.forgelord.damage);
        const orbs = h.shots.filter((s) => s.special === S.SHOCKWAVE);
        // l'onde part du point d'impact
        for (const o of orbs) expect(dist(o.pos, c.center)).toBeLessThan(1e-6);
        return orbs.length;
      };
      expect(ring(1)).toBe(14);
      expect(ring(0.2)).toBe(20);
    });

    it('rafale de boules de feu : tirs ÉCHELONNÉS dans le temps (pas instantanés), 6 puis 10 en enrage', () => {
      const barrage = (hpFrac: number): Shot[] => {
        const player = makePlayer(0, 240 + 120, 160);
        const h = makeHarness([player], 52);
        const boss = spawn('forgelord');
        engageWith(h, boss, hpFrac, S.FIREBALL);
        runUntil(h, boss, () => h.shots.filter((s) => s.special === S.FIREBALL).length >= (hpFrac > 0.5 ? 6 : 10));
        return h.shots.filter((s) => s.special === S.FIREBALL);
      };
      const p1 = barrage(1);
      expect(p1).toHaveLength(6);
      expect((p1[p1.length - 1].tick - p1[0].tick) * DT).toBeGreaterThan(800);
      expect(new Set(p1.map((s) => Math.atan2(s.vel.y, s.vel.x).toFixed(3))).size).toBeGreaterThan(3); // balayage
      const p3 = barrage(0.2);
      expect(p3).toHaveLength(10);
      const gap1 = (p1[1].tick - p1[0].tick) * DT;
      const gap3 = (p3[1].tick - p3[0].tick) * DT;
      expect(gap3).toBeLessThan(gap1);
    });

    it('invoque des chevaliers (plafond 2 vivants) en phase 2 ; plus aucune invocation en enrage (phase 3)', () => {
      const player = makePlayer(0, 240 + 100, 160);
      const h = makeHarness([player], 53);
      const boss = spawn('forgelord');
      boss.hp = boss.maxHp * 0.5;
      let maxAlive = 0;
      run(h, boss, 120000, () => {
        maxAlive = Math.max(maxAlive, h.enemies.filter((e) => !e.dead && e.data.summoner === boss.id).length);
      });
      expect(h.spawns.every((s) => s.kind === 'knight')).toBe(true);
      expect(h.spawns.length).toBe(MINION_CAP.forgelord);
      expect(maxAlive).toBe(MINION_CAP.forgelord);

      const h3 = makeHarness([makePlayer(0, 240 + 100, 160)], 54);
      const rage = spawn('forgelord');
      rage.hp = rage.maxHp * 0.2;
      run(h3, rage, 60000);
      expect(h3.spawns).toHaveLength(0);
    });

    it('enrage : plus rapide, charge disponible, marteau enchaîné en 2 coups re-télégraphés', () => {
      const walked = (hpFrac: number): number => {
        const far = makePlayer(0, 470, 160);
        const h = makeHarness([far], 55);
        const boss = spawn('forgelord', 60, 160);
        boss.hp = boss.maxHp * hpFrac;
        boss.attackCooldownMs = 1e9;
        run(h, boss, 1600);
        const x0 = boss.pos.x;
        boss.attackCooldownMs = 1e9;
        run(h, boss, 1000);
        return boss.pos.x - x0;
      };
      expect(walked(0.2)).toBeGreaterThan(walked(1) * 1.3);
      const player = makePlayer(0, 240 + 50, 160);
      const h = makeHarness([player], 56);
      const used = specialsUsed(h, spawn('forgelord'), 50000, 0.2);
      expect(used.has(S.CHARGE)).toBe(true);
      expect(used.has(S.SUMMON)).toBe(false);
      const boss = spawn('forgelord');
      const h2 = makeHarness([makePlayer(0, 240 + 50, 160)], 57);
      engageWith(h2, boss, 0.2, S.SHOCKWAVE);
      runUntil(h2, boss, () => h2.circles.filter((c) => c.special === S.SHOCKWAVE).length >= 2, 20000);
      const t = h2.circles.filter((c) => c.special === S.SHOCKWAVE).map((c) => c.tick);
      expect(t.length).toBeGreaterThanOrEqual(2);
      expect((t[1] - t[0]) * DT).toBeGreaterThanOrEqual(MIN_BOSS_WINDUP_MS);
    });
  });

  describe('spectre (wraith)', () => {
    it('volant : tous ses déplacements et ses points de réapparition passent flying=true', () => {
      const players = [makePlayer(0, 100, 100), makePlayer(1, 380, 220)];
      const h = makeHarness(players, 61);
      const boss = spawn('wraith');
      run(h, boss, 30000);
      expect(h.moveFlying.length).toBeGreaterThan(0);
      expect(h.moveFlying.every(Boolean)).toBe(true);
      expect(h.occupyFlying.length).toBeGreaterThan(0);
      expect(h.occupyFlying.every(Boolean)).toBe(true);
    });

    it('disparaît puis réapparaît après chaque attaque : téléportation visible (destination connue), point valide, loin des joueurs', () => {
      const players = [makePlayer(0, 100, 100), makePlayer(1, 380, 220)];
      const h = makeHarness(players, 62);
      const boss = spawn('wraith');
      let attacks = 0;
      let teleports = 0;
      run(h, boss, 40000, (pre, post) => {
        if (pre === 'attack' && post === 'recover' && boss.data.comboLeft === 0) attacks++;
        if (post === 'teleport' && pre !== 'teleport') {
          teleports++;
          expect(boss.data.special).toBe(S.TELEPORT);
          expect(boss.data.teleportTotalMs).toBe(560);
          expect(Number.isFinite(boss.data.teleportToX + boss.data.teleportToY)).toBe(true);
        }
        if (pre === 'teleport' && post !== 'teleport') {
          expect(boss.data.teleportMoved).toBe(1);
          expect(h.ctx.canOccupy(boss.pos, ENEMIES.wraith.radius, true)).toBe(true);
          for (const p of players) expect(dist(boss.pos, p.pos)).toBeGreaterThanOrEqual(40);
        }
      });
      expect(teleports).toBeGreaterThanOrEqual(5);
      expect(Math.abs(teleports - attacks)).toBeLessThanOrEqual(1);
    });

    it('traits sombres (kind bolt) : éventail de 3 puis 5 en rage ; anneau d\'orbes seulement en rage', () => {
      const count = (hpFrac: number): number => {
        const player = makePlayer(0, 240 + 110, 160);
        const h = makeHarness([player], 63);
        const boss = spawn('wraith');
        engageWith(h, boss, hpFrac, S.DARKBOLT);
        runUntil(h, boss, () => h.shots.some((s) => s.special === S.DARKBOLT));
        const bolts = h.shots.filter((s) => s.special === S.DARKBOLT);
        expect(bolts.every((s) => s.kind === 'bolt')).toBe(true);
        return bolts.length;
      };
      expect(count(1)).toBe(3);
      expect(count(0.4)).toBe(5);
      const h = makeHarness([makePlayer(0, 350, 160)], 64);
      expect(specialsUsed(h, spawn('wraith'), 40000, 1).has(S.RING)).toBe(false);
      expect(specialsUsed(makeHarness([makePlayer(0, 350, 160)], 64), spawn('wraith'), 40000, 0.4).has(S.RING)).toBe(true);
    });

    it('n\'invoque jamais', () => {
      const h = makeHarness([makePlayer(0, 350, 160)], 65);
      run(h, spawn('wraith'), 60000);
      expect(h.spawns).toHaveLength(0);
    });
  });

  describe('seigneur du Néant (voidlord)', () => {
    it('4 phases (75 / 50 / 25 %), volant', () => {
      const player = makePlayer(0, 350, 160);
      const h = makeHarness([player], 71);
      const boss = spawn('voidlord');
      for (const frac of [1, 0.74, 0.49, 0.24]) {
        boss.hp = boss.maxHp * frac;
        run(h, boss, 1200);
      }
      expect(h.events.flatMap((e) => (e.type === 'bossPhase' ? [e.phase] : []))).toEqual([1, 2, 3, 4]);
      expect(h.moveFlying.every(Boolean)).toBe(true);
    });

    it('zone de danger : cercles posés sous les joueurs pendant le télégraphe, verrouillés avant l\'impact, qui persistent', () => {
      const players = [makePlayer(0, 240 + 90, 160), makePlayer(1, 240 - 90, 100)];
      const h = makeHarness(players, 72);
      const boss = spawn('voidlord');
      engageWith(h, boss, 0.6, S.VOIDZONE);
      let lockedAt: number[] | null = null;
      let windup = 0;
      runUntil(h, boss, () => {
        if (boss.mode === 'windup' && boss.data.special === S.VOIDZONE) {
          windup = boss.data.windupTotalMs;
          expect(boss.data.zoneCount).toBe(2);
          expect(boss.data.zoneRadius).toBeGreaterThan(20);
          expect(boss.data.telegraphRadius).toBe(boss.data.zoneRadius);
          // les joueurs bougent : tant que la visée suit, les zones suivent ; ensuite elles sont verrouillées
          for (const p of players) p.pos.x += 0.4;
          const frozen = boss.modeTimerMs < boss.data.windupTotalMs * 0.4;
          const now = [boss.data.zoneX0, boss.data.zoneY0, boss.data.zoneX1, boss.data.zoneY1];
          if (frozen) {
            if (lockedAt) expect(now).toEqual(lockedAt);
            lockedAt = now;
          }
        }
        return boss.mode === 'attack' && boss.data.special === S.VOIDZONE;
      });
      expect(windup).toBeGreaterThanOrEqual(1100);
      expect(lockedAt).not.toBeNull();
      const zones = h.circles.filter((c) => c.special === S.VOIDZONE);
      expect(zones).toHaveLength(2);
      expect(zones[0].damage).toBe(ENEMIES.voidlord.damage);
      // persistance : d'autres dégâts de zone tombent pendant l'attaque
      run(h, boss, 1500);
      expect(h.circles.filter((c) => c.special === S.VOIDZONE).length).toBeGreaterThan(4);
      // et s'arrêtent à la fin
      run(h, boss, 3000);
      expect(boss.data.zoneCount === 0 || boss.data.special === S.VOIDZONE).toBe(true);
    });

    it('à un seul joueur les cercles supplémentaires sont décalés autour de lui (mêmes dégâts, aucun joueur nécessaire en plus)', () => {
      const player = makePlayer(0, 240 + 90, 160);
      const h = makeHarness([player], 73);
      const boss = spawn('voidlord');
      engageWith(h, boss, 0.6, S.VOIDZONE);
      runUntil(h, boss, () => boss.mode === 'windup' && boss.data.special === S.VOIDZONE && boss.modeTimerMs < 400);
      expect(boss.data.zoneCount).toBe(2);
      const z0 = { x: boss.data.zoneX0, y: boss.data.zoneY0 };
      const z1 = { x: boss.data.zoneX1, y: boss.data.zoneY1 };
      expect(dist(z0, player.pos)).toBeLessThan(1e-6);
      expect(dist(z1, player.pos)).toBeGreaterThan(30);
      expect(dist(z1, player.pos)).toBeLessThan(60);
    });

    it('phase 4 : 3 zones, spirale à 3 bras, télégraphe >= 600 ms', () => {
      const players = [makePlayer(0, 300, 160), makePlayer(1, 200, 120), makePlayer(2, 260, 240)];
      const h = makeHarness(players, 74);
      const boss = spawn('voidlord');
      engageWith(h, boss, 0.1, S.VOIDZONE);
      runUntil(h, boss, () => boss.mode === 'windup' && boss.data.special === S.VOIDZONE && boss.modeTimerMs < 300);
      expect(boss.data.zoneCount).toBe(3);
      const h2 = makeHarness([makePlayer(0, 300, 160)], 75);
      const b2 = spawn('voidlord');
      engageWith(h2, b2, 0.1, S.SPIRAL);
      runUntil(h2, b2, () => h2.shots.filter((s) => s.special === S.SPIRAL).length >= 90, 15000);
      const sp = h2.shots.filter((s) => s.special === S.SPIRAL);
      expect(sp.length).toBe(90); // 30 émissions × 3 bras
      expect(new Set(sp.map((s) => s.tick)).size).toBeGreaterThan(20); // émission étalée dans le temps
    });

    it('invocations (bat / wisp) : plafond de 3 vivants (2 sans en tuer), aucune en phase 4', () => {
      const player = makePlayer(0, 240 + 100, 160);
      const h = makeHarness([player], 76);
      const boss = spawn('voidlord');
      boss.hp = boss.maxHp * 0.6;
      let maxAlive = 0;
      run(h, boss, 120000, () => {
        maxAlive = Math.max(maxAlive, h.enemies.filter((e) => !e.dead && e.data.summoner === boss.id).length);
      });
      expect(h.spawns.every((s) => s.kind === 'bat' || s.kind === 'wisp')).toBe(true);
      expect(maxAlive).toBeLessThanOrEqual(MINION_CAP.voidlord);
      expect(maxAlive).toBeGreaterThanOrEqual(2);
      const h4 = makeHarness([makePlayer(0, 340, 160)], 77);
      run(h4, spawn('voidlord'), 1);
      const b4 = spawn('voidlord');
      b4.hp = b4.maxHp * 0.1;
      run(h4, b4, 60000);
      expect(h4.spawns).toHaveLength(0);
    });
  });
});

// ───────────────────────────── Invocations : plafonds globaux ─────────────────────────────

describe('invocations plafonnées', () => {
  it.each(['frostqueen', 'pyromancer', 'forgelord', 'voidlord'] as const)(
    '%s : jamais plus de sbires que son plafond, même quand on les tue régulièrement',
    (kind) => {
      const player = makePlayer(0, 240 + 100, 160);
      const h = makeHarness([player], 81);
      const boss = spawn(kind);
      boss.hp = boss.maxHp * 0.55;
      let maxAlive = 0;
      let tick = 0;
      run(h, boss, 150000, () => {
        if (++tick % 900 === 0) for (const e of h.enemies) e.dead = true;
        maxAlive = Math.max(maxAlive, h.enemies.filter((e) => !e.dead && e.data.summoner === boss.id).length);
      });
      expect(h.spawns.length).toBeGreaterThan(MINION_CAP[kind]);
      expect(maxAlive).toBeLessThanOrEqual(MINION_CAP[kind]);
    },
  );

  it('si le contexte refuse l\'invocation (limite de salle) : aucun plantage, aucune marque', () => {
    const player = makePlayer(0, 340, 160);
    const h = makeHarness([player], 82);
    h.ctx.spawnEnemy = () => -1;
    const boss = spawn('frostqueen');
    boss.hp = boss.maxHp * 0.5;
    run(h, boss, 30000);
    expect(h.enemies).toHaveLength(0);
    expect(allFinite(boss)).toBe(true);
  });
});

// ───────────────────────────── Équité, robustesse, déterminisme ─────────────────────────────

describe('équité', () => {
  it.each(NEW_KINDS)('%s : aucun effet quand aucun joueur n\'est vivant, retour en idle', (kind) => {
    const players = [makePlayer(0, 250, 160, 2, 'down'), makePlayer(1, 260, 160, 2, 'down')];
    const h = makeHarness(players, 91);
    const boss = spawn(kind);
    run(h, boss, 10000);
    expect(h.circles).toHaveLength(0);
    expect(h.shots).toHaveLength(0);
    expect(h.spawns).toHaveLength(0);
    expect(boss.mode).toBe('idle');
    expect(boss.phase).toBe(0);
  });

  it.each(NEW_KINDS)('%s : abandonne l\'attaque en cours si tous les joueurs tombent', (kind) => {
    const player = makePlayer(0, 240 + 60, 160);
    const h = makeHarness([player], 92);
    const boss = spawn(kind);
    for (let i = 0; i < 4000 && boss.mode !== 'windup'; i++) {
      player.invulnMs = 1e9;
      h.step(boss);
    }
    expect(boss.mode).toBe('windup');
    player.status = 'down';
    player.hp = 0;
    h.step(boss);
    expect(boss.mode).toBe('idle');
    const n = h.circles.length + h.shots.length;
    run(h, boss, 5000);
    expect(h.circles.length + h.shots.length).toBe(n);
  });

  it.each(NEW_KINDS)('%s : cible un joueur vivant, jamais un joueur à terre, même loin une fois engagé', (kind) => {
    const downed = makePlayer(0, 240 + 25, 160, 2, 'down');
    const alive = makePlayer(1, 240 - 120, 160);
    const h = makeHarness([downed, alive], 93);
    const boss = spawn(kind);
    run(h, boss, 800);
    expect(boss.targetId).toBe(1);
    alive.pos.x = 20;
    alive.pos.y = 310;
    run(h, boss, 500);
    expect(boss.targetId).toBe(1);
  });

  it.each(NEW_KINDS)('%s : attaques opérationnelles avec 1, 2, 3 et 4 joueurs', (kind) => {
    for (let n = 1; n <= 4; n++) {
      const players = Array.from({ length: n }, (_, i) => makePlayer(i as PlayerId, 150 + i * 60, 200));
      const h = makeHarness(players, 94 + n);
      const boss = spawn(kind);
      run(h, boss, 30000);
      expect(h.circles.length + h.shots.length).toBeGreaterThan(0);
      expect(allFinite(boss)).toBe(true);
    }
  });

  it.each(NEW_KINDS)('%s : ni recul, ni étourdissement, ni immobilisation (boss et demi-boss)', (kind) => {
    const player = makePlayer(0, 240 + 60, 160);
    const h = makeHarness([player], 95);
    const boss = spawn(kind);
    run(h, boss, 500);
    const mode = boss.mode;
    onEnemyHit(boss, { x: 100, y: 100 }, 60);
    expect(boss.hitFlashMs).toBeGreaterThan(0);
    expect(boss.data.kbx).toBe(0);
    expect(boss.data.stunMs).toBe(0);
    expect(boss.mode).toBe(mode);
    expect(knockEnemy(boss, { x: 0, y: 0 }, 300)).toBe(false);
    expect(stunEnemy(boss, 1500)).toBe(false);
    expect(boss.data.stunMs).toBe(0);
    expect(boss.attackCooldownMs).toBeLessThanOrEqual(1500);
    // un boss touché en continu continue d'attaquer
    const h2 = makeHarness([makePlayer(0, 300, 160)], 96);
    const b2 = spawn(kind);
    run(h2, b2, 30000, () => {
      onEnemyHit(b2, { x: 100, y: 100 }, 20);
    });
    expect(h2.circles.length + h2.shots.length).toBeGreaterThan(0);
  });
});

describe('robustesse (fuzz déterministe)', () => {
  it.each(NEW_KINDS)('%s : 3000 pas aléatoires sans NaN ni sortie de salle, état JSON pur', (kind) => {
    const scenario = createRng(2025);
    const players = [makePlayer(0, 100, 100), makePlayer(1, 380, 220), makePlayer(2, 240, 160), makePlayer(3, 60, 260)];
    const h = makeHarness(players, 4243);
    const boss = spawn(kind);
    for (let i = 0; i < 3000; i++) {
      for (const p of players) {
        if (nextRandom(scenario) < 0.04) {
          p.pos.x = Math.min(ROOM_W - 6, Math.max(6, p.pos.x + (nextRandom(scenario) - 0.5) * 40));
          p.pos.y = Math.min(ROOM_H - 6, Math.max(6, p.pos.y + (nextRandom(scenario) - 0.5) * 40));
        }
        if (nextRandom(scenario) < 0.001) {
          p.status = p.status === 'alive' ? 'down' : 'alive';
          p.hp = p.status === 'alive' ? p.maxHp : 0;
        }
      }
      if (nextRandom(scenario) < 0.01) onEnemyHit(boss, { x: 50, y: 50 }, 30);
      boss.hp = Math.max(1, boss.maxHp * (1 - i / 2900));
      if (h.enemies.length > 40) h.enemies.splice(0, 20);
      h.step(boss);
      if (!allFinite(boss)) throw new Error(`NaN/Infinity au pas ${i} (${kind})`);
      expect(boss.pos.x).toBeGreaterThanOrEqual(0);
      expect(boss.pos.x).toBeLessThanOrEqual(ROOM_W);
      expect(boss.pos.y).toBeGreaterThanOrEqual(0);
      expect(boss.pos.y).toBeLessThanOrEqual(ROOM_H);
      expect(boss.phase).toBeGreaterThanOrEqual(0);
      expect(boss.phase).toBeLessThanOrEqual(MAX_PHASE[kind]);
    }
    for (const s of h.shots) {
      expect(Number.isFinite(s.vel.x + s.vel.y + s.pos.x + s.pos.y + s.damage + s.lifeMs)).toBe(true);
      expect(s.damage).toBeGreaterThan(0);
      expect(s.lifeMs).toBeGreaterThan(0);
    }
    for (const c of h.circles) expect(Number.isFinite(c.center.x + c.center.y + c.radius + c.damage)).toBe(true);
    expect(JSON.parse(JSON.stringify(boss))).toEqual(boss);
    for (const v of Object.values(boss.data)) expect(typeof v).toBe('number');
    for (const e of h.events) expect(e.type).toBe('bossPhase');
  });

  it.each(NEW_KINDS)('%s : déterminisme (même seed => même combat), seeds différentes => combats différents', (kind) => {
    const go = (seed: number): string => {
      const players = [makePlayer(0, 200, 150), makePlayer(1, 300, 180)];
      const h = makeHarness(players, seed);
      const boss = spawn(kind);
      for (let i = 0; i < 4000; i++) {
        for (const p of players) p.invulnMs = 1e9;
        boss.hp = Math.max(1, boss.maxHp * (1 - i / 4500));
        h.step(boss);
      }
      return JSON.stringify([boss, h.shots, h.circles, h.spawns, h.events]);
    };
    expect(go(8)).toBe(go(8));
    // le warden n'utilise le hasard que pour contourner un obstacle
    if (kind !== 'warden') expect(go(8)).not.toBe(go(9));
  });

  it.each(NEW_KINDS)('%s : dtMs invalide => aucun effet', (kind) => {
    const h = makeHarness([makePlayer(0, 250, 160)], 1);
    const boss = spawn(kind);
    const snap = JSON.stringify(boss);
    h.ctx.dtMs = Number.NaN;
    updateEnemy(boss, h.ctx);
    h.ctx.dtMs = 0;
    updateEnemy(boss, h.ctx);
    expect(JSON.stringify(boss)).toBe(snap);
  });
});

// ───────────────────────────── Difficulté : seuls PV / dégâts changent ─────────────────────────────

describe('difficulté 1/2/3', () => {
  const DIFFS: Difficulty[] = [1, 2, 3];

  it.each(NEW_KINDS)('%s : l\'IA ne lit pas la difficulté (mêmes attaques, mêmes invocations, même trajectoire)', (kind) => {
    const trace = (d: Difficulty): string => {
      const players = [makePlayer(0, 200, 150, d), makePlayer(1, 300, 180, d)];
      const h = makeHarness(players, 17);
      const boss = spawn(kind);
      for (let i = 0; i < 5000; i++) {
        for (const p of players) p.invulnMs = 1e9;
        boss.hp = Math.max(1, boss.maxHp * (1 - i / 5500));
        h.step(boss);
      }
      return JSON.stringify([boss, h.shots, h.circles, h.spawns]);
    };
    const t2 = trace(2);
    expect(trace(1)).toBe(t2);
    expect(trace(3)).toBe(t2);
  });

  it.each(NEW_KINDS)('%s : PV de départ identiques quelle que soit la difficulté ; dégâts reçus ÷ 0,7 / 1 / 1,4', (kind) => {
    for (const d of DIFFS) {
      const e = createEnemyState(kind, { x: 10, y: 10 }, 1, 0);
      expect(e.maxHp).toBe(ENEMIES[kind].hp);
      expect(e.hp).toBe(ENEMIES[kind].hp);
    }
    const raw = 40;
    expect(damageToEnemy(raw, 1)).toBeCloseTo(raw / 0.7, 9);
    expect(damageToEnemy(raw, 2)).toBeCloseTo(raw, 9);
    expect(damageToEnemy(raw, 3)).toBeCloseTo(raw / 1.4, 9);
    const david = getCharacter('david');
    const red = 1 - 0.02 * david.resistance;
    for (const d of DIFFS) {
      const mult = DIFFICULTY_TABLE[d].enemyDamageMult;
      expect(damageToPlayer(ENEMIES[kind].damage, david, d)).toBe(Math.max(1, Math.round(ENEMIES[kind].damage * mult * red)));
    }
    expect(damageToPlayer(ENEMIES[kind].damage, david, 1)).toBeLessThan(damageToPlayer(ENEMIES[kind].damage, david, 2));
    expect(damageToPlayer(ENEMIES[kind].damage, david, 2)).toBeLessThan(damageToPlayer(ENEMIES[kind].damage, david, 3));
  });

  it('en simulation : mêmes ennemis (nombre, types, trajectoires) à difficulté 1 et 3 ; seuls les dégâts infligés diffèrent', () => {
    for (const kind of NEW_KINDS) {
      const snapshot = (d: Difficulty): string => {
        const s = bossSim(kind, [2, 2].map((_, i) => ({ id: i as PlayerId, characterId: 'david' as CharacterId, difficulty: d })));
        for (let i = 0; i < 1800; i++) {
          for (const p of s.state.players) p.invulnMs = 1e9;
          s.step(DT, {});
        }
        return JSON.stringify(s.state.room.enemies);
      };
      const a = snapshot(1);
      expect(snapshot(3), kind).toBe(a);
      expect(snapshot(2), kind).toBe(a);
    }
  });
});

// ───────────────────────────── Plafond de dégâts ─────────────────────────────

interface CombatHarness {
  ctx: CombatContext;
  players: PlayerState[];
  boss: EnemyState;
}

function combatHarness(kind: EnemyKind, ids: CharacterId[], diff: Difficulty = 2): CombatHarness {
  const pos: { x: number; y: number; f: Dir }[] = [
    { x: 260, y: 150, f: 'left' },
    { x: 220, y: 150, f: 'right' },
    { x: 240, y: 126, f: 'down' },
    { x: 240, y: 174, f: 'up' },
  ];
  const players = ids.map((id, i) => {
    const p = createPlayerState({ id: i as PlayerId, characterId: id, difficulty: diff }, { x: pos[i].x, y: pos[i].y });
    p.facing = pos[i].f;
    return p;
  });
  const boss = createEnemyState(kind, { x: 240, y: 150 }, 1, 0);
  const ctx: CombatContext = {
    room: { roomId: 'r', enemies: [boss], projectiles: [], mechanisms: [], spawnedSpawnIdx: [], elapsedMs: 0 },
    players,
    grid: new RoomGrid(makeTestLayout(30, 20)),
    solids: [],
    events: [],
    nextId: () => 5000,
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
  return { ctx, players, boss };
}

/** Temps (s) avant la mort d'un boss immobile frappé par l'équipe ; `normal` : attaques normales en plus des spéciaux. */
function killTime(kind: EnemyKind, ids: CharacterId[], diff: Difficulty, normal: boolean, maxSeconds = 300): number {
  const { ctx, players, boss } = combatHarness(kind, ids, diff);
  const steps = Math.round((maxSeconds * 1000) / DT);
  for (let t = 0; t < steps; t++) {
    ctx.room.elapsedMs += DT;
    for (const p of players) {
      const before = p.specialAnimMs;
      stepPlayerTimers(p, DT);
      stepSpecialEffects(ctx, p, before);
      if (canPlayerSpecial(p)) performPlayerSpecial(ctx, p);
      if (normal && canPlayerAttack(p)) performPlayerAttack(ctx, p);
    }
    stepProjectiles(ctx, DT);
    if (boss.dead) return (t * DT) / 1000;
  }
  return Infinity;
}

describe('plafond de dégâts par fenêtre de 2 s', () => {
  it('constantes : 20 % pour les boss de fin, 35 % (plus doux) pour les demi-boss', () => {
    expect(BOSS_DAMAGE_CAP_FRACTION).toBe(0.2);
    expect(MINIBOSS_DAMAGE_CAP_FRACTION).toBe(0.35);
    expect(MINIBOSS_DAMAGE_CAP_FRACTION).toBeGreaterThan(BOSS_DAMAGE_CAP_FRACTION);
    expect(BOSS_DAMAGE_WINDOW_MS).toBe(2000);
  });

  it.each([...MINI, ...FINAL])('%s : au plus la fraction de PV max par fenêtre ; la fenêtre suivante rouvre le plafond', (kind) => {
    const frac = ENEMIES[kind].isBoss ? BOSS_DAMAGE_CAP_FRACTION : MINIBOSS_DAMAGE_CAP_FRACTION;
    const { ctx, boss } = combatHarness(kind, ['david']);
    const cap = boss.maxHp * frac;
    let total = 0;
    for (let i = 0; i < 400; i++) total += damageEnemy(ctx, boss, 40, null, { x: 0, y: 0 });
    expect(total).toBeCloseTo(cap, 6);
    expect(boss.maxHp - boss.hp).toBeCloseTo(cap, 6);
    expect(boss.dead).toBe(false);
    // coup suivant dans la même fenêtre : 0 mais le flash reste
    expect(damageEnemy(ctx, boss, 40, null, { x: 0, y: 0 })).toBe(0);
    expect(boss.hitFlashMs).toBeGreaterThan(0);
    // fenêtre suivante : un nouveau plafond complet
    ctx.room.elapsedMs += BOSS_DAMAGE_WINDOW_MS;
    let second = 0;
    for (let i = 0; i < 400; i++) second += damageEnemy(ctx, boss, 40, null, { x: 0, y: 0 });
    expect(second).toBeCloseTo(cap, 6);
    expect(boss.maxHp - boss.hp).toBeCloseTo(2 * cap, 6);
  });

  it('état dans enemy.data uniquement : JSON pur, déterministe, sans effet sur un ennemi normal', () => {
    const run = (): string => {
      const { ctx, boss } = combatHarness('warden', ['david']);
      for (let i = 0; i < 100; i++) {
        ctx.room.elapsedMs += 50;
        damageEnemy(ctx, boss, 25, null, { x: 0, y: 0 });
      }
      expect(Number.isFinite(boss.data.dmgWinStartMs)).toBe(true);
      expect(Number.isFinite(boss.data.dmgWinTaken)).toBe(true);
      return JSON.stringify(boss);
    };
    expect(run()).toBe(run());
    const { ctx, boss } = combatHarness('knight', ['david']);
    boss.maxHp = 1000;
    boss.hp = 1000;
    for (let i = 0; i < 20; i++) damageEnemy(ctx, boss, 40, null, { x: 0, y: 0 });
    expect(1000 - boss.hp).toBeGreaterThan(0.35 * 1000); // pas de plafond sur un ennemi normal
    expect(boss.data.dmgWinTaken).toBeUndefined();
  });

  it('difficulté de l\'attaquant : le plafond reste en fraction des PV max (difficultés 1/2/3)', () => {
    for (const d of [1, 2, 3] as Difficulty[]) {
      const { ctx, boss, players } = combatHarness('voidlord', ['david'], d);
      let total = 0;
      for (let i = 0; i < 300; i++) total += damageEnemy(ctx, boss, 100, players[0], { x: 0, y: 0 });
      expect(total).toBeCloseTo(boss.maxHp * BOSS_DAMAGE_CAP_FRACTION, 6);
    }
  });
});

// ───────────────────────────── Équilibrage : temps de mort minimal ─────────────────────────────

describe('temps de mort minimal avec 4 joueurs de difficulté 2', () => {
  const ids = [...CHARACTER_IDS] as CharacterId[];
  const teams: CharacterId[][] = [];
  for (let a = 0; a < 8; a++)
    for (let b = a + 1; b < 8; b++)
      for (let c = b + 1; c < 8; c++) for (let d = c + 1; d < 8; d++) teams.push([ids[a], ids[b], ids[c], ids[d]]);

  it('70 équipes possibles, spéciaux enchaînés : demi-boss >= 12 s, boss de fin >= 35 s', () => {
    for (const kind of NEW_KINDS) {
      const min = ENEMIES[kind].isBoss ? 35 : 12;
      let worst = Infinity;
      for (const team of teams) worst = Math.min(worst, killTime(kind, team, 2, false));
      expect(worst, `${kind} (pire équipe)`).toBeGreaterThanOrEqual(min);
    }
  });

  it('même sans limite d\'uptime (attaques normales + spéciaux, tout touche) : le plafond impose >= 4 s (demi-boss) / >= 9 s (boss)', () => {
    for (const kind of NEW_KINDS) {
      const min = ENEMIES[kind].isBoss ? 9 : 4;
      let worst = Infinity;
      for (const team of teams) worst = Math.min(worst, killTime(kind, team, 2, true));
      expect(worst, `${kind}`).toBeGreaterThanOrEqual(min);
    }
  });

  it('battable à 1 joueur : même difficulté 3 (PV ×1,4), un joueur seul vient à bout de chaque ennemi en temps raisonnable', () => {
    for (const kind of NEW_KINDS) {
      for (const who of ['david', 'grok', 'aelith'] as CharacterId[]) {
        const t = killTime(kind, [who], 3, true);
        expect(t, `${kind} / ${who}`).toBeLessThan(ENEMIES[kind].isBoss ? 150 : 45);
      }
    }
  });

  it('les boss de fin tiennent plus longtemps que Gorgrim, les demi-boss moins que tous les boss', () => {
    const team = ['sandrine', 'aelith', 'grok', 'mira'] as CharacterId[];
    const t = (k: EnemyKind): number => killTime(k, team, 2, false);
    for (const f of FINAL) expect(t(f)).toBeGreaterThan(t('golem'));
    for (const m of MINI) for (const f of FINAL) expect(t(m)).toBeLessThan(t(f));
  });
});

// ───────────────────────────── Intégration dans la simulation ─────────────────────────────

function setups(n: number, difficulty: Difficulty = 2, characterId: CharacterId = 'david'): PlayerSetup[] {
  return Array.from({ length: n }, (_, i) => ({ id: i as PlayerId, characterId, difficulty }));
}

function bossRoom(kind: EnemyKind, overrides: Partial<RoomDef> = {}): RoomDef {
  return makeTestRoom({
    id: 'arena',
    layout: makeTestLayout(30, 20),
    enemies: [{ kind, tile: [20, 10] }],
    mechanisms: [],
    exit: { rect: { x: 9, y: 5, w: 2, h: 2 }, requires: ['clear'], final: true },
    ...overrides,
  });
}

function bossLevel(room: RoomDef, extraRooms: RoomDef[] = []): LevelDef {
  const rooms = [room, ...extraRooms];
  rooms[rooms.length - 1].exit.final = true;
  return makeTestLevel({ rooms, objectives: [] });
}

function bossSim(kind: EnemyKind, players: PlayerSetup[], seed = 777): GameSimulation {
  const s = createSimulation({ levelId: 'test', players, seed }, bossLevel(bossRoom(kind)));
  // joueurs à portée d'aggro des demi-boss (le boss est en tuile [20,10] = (328, 168))
  s.state.players.forEach((p, i) => {
    p.pos = { x: 240 + (i % 2) * 10, y: 150 + Math.floor(i / 2) * 10 };
  });
  return s;
}

function frame(over: Partial<ActionFrame> = {}): ActionFrame {
  return { moveX: 0, moveY: 0, attack: false, interact: false, revive: false, special: false, ...over };
}

function bossOf(s: GameSimulation, kind: EnemyKind): EnemyState | undefined {
  return s.state.room.enemies.find((e) => e.kind === kind);
}

function numbersFinite(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(numbersFinite);
  if (value && typeof value === 'object') return Object.values(value).every(numbersFinite);
  return true;
}

describe('simulation : demi-boss et boss des niveaux 4-6', () => {
  it.each(NEW_KINDS)('%s apparaît avec ses PV de base, quel que soit le nombre de joueurs', (kind) => {
    for (let n = 1; n <= 4; n++) {
      const s = bossSim(kind, setups(n));
      const b = bossOf(s, kind)!;
      expect(b.maxHp).toBe(ENEMIES[kind].hp);
      expect(b.hp).toBe(ENEMIES[kind].hp);
      expect(s.state.room.enemies).toHaveLength(1);
    }
  });

  it.each(MINI)('un demi-boss vivant empêche la sortie (jeton clear) et ferme les portes « clear » ; sa mort les ouvre', (kind) => {
    const room = bossRoom(kind, {
      mechanisms: [{ id: 'd1', type: 'door', tiles: [[2, 10]], requires: ['clear'] }],
    });
    const s = createSimulation({ levelId: 'test', players: setups(2), seed: 5 }, bossLevel(room, [makeTestRoom({ id: 'next', layout: makeTestLayout(14, 9) })]));
    const door = () => s.state.room.mechanisms.find((m) => m.id === 'd1')!;
    const toExit = (): void => {
      s.state.players.forEach((p, i) => {
        p.pos = { x: 10 * TILE + i * 3, y: 6 * TILE };
      });
    };
    for (let i = 0; i < 240; i++) {
      toExit();
      for (const p of s.state.players) p.invulnMs = 1e9;
      s.step(DT, {});
    }
    expect(bossOf(s, kind)).toBeDefined();
    expect(door().active).toBe(false);
    expect(s.state.phase).toBe('playing'); // tous dans la sortie mais le demi-boss vit
    expect(s.state.clearedRooms).toEqual([]);
    // mort du demi-boss
    bossOf(s, kind)!.hp = 0;
    const events: SimEvent[] = [];
    for (let i = 0; i < 10; i++) {
      toExit();
      events.push(...s.step(DT, {}));
    }
    expect(events.some((e) => e.type === 'enemyDied' && e.kind === kind)).toBe(true);
    expect(door().active).toBe(true);
    expect(events.some((e) => e.type === 'roomCleared')).toBe(true);
  });

  it('un boss de fin vivant empêche la sortie de la même façon (jeton clear)', () => {
    const s = bossSim('frostqueen', setups(1));
    for (let i = 0; i < 180; i++) {
      s.state.players[0].pos = { x: 10 * TILE, y: 6 * TILE };
      s.state.players[0].invulnMs = 1e9;
      s.step(DT, {});
    }
    expect(s.state.phase).toBe('playing');
    bossOf(s, 'frostqueen')!.hp = 0;
    s.state.players[0].pos = { x: 10 * TILE, y: 6 * TILE };
    s.step(DT, {});
    expect(s.state.phase).toBe('levelComplete');
  });

  it('les sbires invoqués comptent pour le jeton clear (la sortie reste fermée tant qu\'ils vivent)', () => {
    const s = bossSim('pyromancer', setups(1));
    const player = s.state.players[0];
    let summoned = 0;
    for (let i = 0; i < 20000 && summoned === 0; i++) {
      player.hp = player.maxHp;
      player.invulnMs = 1e9;
      s.step(DT, {});
      summoned = s.state.room.enemies.filter((e) => e.wave === -1).length;
    }
    expect(summoned).toBeGreaterThan(0);
    const minions = s.state.room.enemies.filter((e) => e.wave === -1);
    expect(minions.every((e) => e.data.summoner === bossOf(s, 'pyromancer')!.id)).toBe(true);
    bossOf(s, 'pyromancer')!.hp = 0;
    player.pos = { x: 10 * TILE, y: 6 * TILE };
    s.step(DT, {});
    expect(s.state.phase).toBe('playing'); // il reste des feux follets
    for (const e of s.state.room.enemies) e.hp = 0;
    player.pos = { x: 10 * TILE, y: 6 * TILE };
    s.step(DT, {});
    expect(s.state.phase).toBe('levelComplete');
  });

  it.each([...MINI, ...FINAL])('%s : salle de boss au redémarrage — spéciaux à demi-recharge (demi-boss compris)', (kind) => {
    const s = bossSim(kind, setups(2));
    for (const p of s.state.players) {
      p.invulnMs = 0;
      applyDamageToPlayer(p, 99999);
    }
    s.step(DT, {});
    expect(s.state.phase).toBe('wipe');
    for (let i = 0; i < Math.ceil(WIPE_RESTART_DELAY_MS / DT) + 3; i++) s.step(DT, {});
    expect(s.state.phase).toBe('playing');
    const cd = getCharacter('david').special!.cooldownMs;
    for (const p of s.state.players) expect(p.specialCooldownMs).toBeGreaterThan(cd / 2 - 100);
    for (const p of s.state.players) expect(p.specialCooldownMs).toBeLessThanOrEqual(Math.round(cd / 2));
    expect(bossOf(s, kind)!.hp).toBe(ENEMIES[kind].hp); // salle réinitialisée
  });

  it('une salle sans boss ne demi-recharge pas les spéciaux au redémarrage', () => {
    const room = bossRoom('knight');
    const s = createSimulation({ levelId: 'test', players: setups(1), seed: 1 }, bossLevel(room));
    s.state.players[0].invulnMs = 0;
    applyDamageToPlayer(s.state.players[0], 99999);
    for (let i = 0; i < Math.ceil(WIPE_RESTART_DELAY_MS / DT) + 5; i++) s.step(DT, {});
    expect(s.state.players[0].specialCooldownMs).toBe(0);
  });

  it.each(NEW_KINDS)('%s : fuzz de 2400 pas à 1..4 joueurs — pas de NaN, rien hors salle, plafond de salle et de sbires respectés, JSON pur', (kind) => {
    for (const n of [1, 4]) {
      const s = bossSim(kind, setups(n, 2, n === 1 ? 'grok' : 'david'), 31 + n);
      const rng = createRng(900 + n);
      const room = s.room;
      const w = room.layout[0].length * TILE;
      const h = room.layout.length * TILE;
      let maxMinions = 0;
      for (let i = 0; i < 2400; i++) {
        const inputs: Record<number, ActionFrame> = {};
        for (let p = 0; p < n; p++) {
          const a = nextRandom(rng) * Math.PI * 2;
          inputs[p] = frame({
            moveX: nextRandom(rng) < 0.7 ? Math.cos(a) : 0,
            moveY: nextRandom(rng) < 0.7 ? Math.sin(a) : 0,
            attack: nextRandom(rng) < 0.5,
            special: nextRandom(rng) < 0.02,
            revive: nextRandom(rng) < 0.3,
          });
        }
        // le fuzz doit atteindre toutes les phases : on rabote les PV du boss au fil du temps
        const boss = bossOf(s, kind);
        if (boss && i % 20 === 0) boss.hp = Math.max(1, boss.hp - boss.maxHp / 130);
        s.step(DT, inputs);
        if (i % 200 === 0 && !numbersFinite(s.state)) throw new Error(`NaN dans l'état au pas ${i} (${kind}, ${n} joueurs)`);
        expect(s.state.room.enemies.length).toBeLessThanOrEqual(MAX_ALIVE_ENEMIES);
        for (const e of s.state.room.enemies) {
          expect(e.pos.x, `${e.kind} x`).toBeGreaterThanOrEqual(0);
          expect(e.pos.x).toBeLessThanOrEqual(w);
          expect(e.pos.y).toBeGreaterThanOrEqual(0);
          expect(e.pos.y).toBeLessThanOrEqual(h);
        }
        const bossNow = bossOf(s, kind);
        if (bossNow && MINION_CAP[kind]) {
          const alive = s.state.room.enemies.filter((e) => e.data.summoner === bossNow.id && !e.dead && e.hp > 0).length;
          maxMinions = Math.max(maxMinions, alive);
          expect(alive).toBeLessThanOrEqual(MINION_CAP[kind]);
        }
      }
      expect(numbersFinite(s.state)).toBe(true);
      expect(JSON.parse(s.serialize())).toEqual(JSON.parse(JSON.stringify(s.state)));
    }
  });

  it.each(NEW_KINDS)('%s : la simulation est déterministe (même seed, mêmes entrées => même état)', (kind) => {
    const go = (): string => {
      const s = bossSim(kind, setups(2, 2, 'aelith'), 4242);
      for (let i = 0; i < 1500; i++) {
        s.step(DT, { 0: frame({ moveX: Math.sin(i / 40), moveY: Math.cos(i / 55), attack: i % 7 < 3, special: i % 300 === 0 }) });
      }
      return s.serialize();
    };
    expect(go()).toBe(go());
  });
});

describe('sérialisation JSON', () => {
  it.each(NEW_KINDS)('%s : createEnemyState et l\'état en plein combat survivent à un aller-retour JSON', (kind) => {
    const fresh = createEnemyState(kind, { x: 40, y: 50 }, 7, 0);
    expect(JSON.parse(JSON.stringify(fresh))).toEqual(fresh);
    const players = [makePlayer(0, 300, 160), makePlayer(1, 200, 200)];
    const h = makeHarness(players, 9);
    const boss = spawn(kind);
    boss.hp = boss.maxHp * 0.3;
    run(h, boss, 20000);
    const copy = JSON.parse(JSON.stringify(boss)) as EnemyState;
    expect(copy).toEqual(boss);
    // le combat peut reprendre depuis la copie restaurée
    const h2 = makeHarness([makePlayer(0, 300, 160), makePlayer(1, 200, 200)], 31);
    run(h2, copy, 5000);
    expect(allFinite(copy)).toBe(true);
    expect(JSON.parse(JSON.stringify(copy))).toEqual(copy);
  });

  it('fanLanesFor : voies symétriques autour de la visée', () => {
    const lanes = fanLanesFor(5, 0.24);
    expect(lanes).toHaveLength(5);
    expect(lanes[0]).toBeCloseTo(-lanes[4], 12);
    expect(lanes[2]).toBe(0);
  });
});
