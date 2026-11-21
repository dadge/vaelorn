/**
 * TACTIQUES DE BOSS (« boss malins », `tactics.ts` + branche 'chase' de `bosses.ts`) : tests d'IA sur un faux contexte.
 * Identité sans drapeau, priorités et préemption, budgets et relâches, hystérésis, déstabilisation (dégâts, spécial), isolement, cristaux, confiscation, portée, blocage,
 * aucun tirage aléatoire dans `tactics.ts`, sérialisation JSON, boss seulement. Aucune horloge réelle.
 */
import { describe, expect, it } from 'vitest';
import { createEnemyState, stunEnemy, updateEnemy } from './ai';
import { damageEnemy, type CombatContext } from './combat';
import {
  CAMP_MS,
  GUARD_GIVEUP_MS,
  GUARD_MS,
  GUARD_RELIEF_MS,
  GUARD_RING_PX,
  ISOLATION_PX,
  SEIZE_COOL_MS,
  SEIZE_DWELL_MS,
  SEIZE_MAX_BOSS,
  SEIZE_MAX_MINI,
  TACT_BREAK_COOL_MS,
  TACT_MIN_LOCK_MS,
  TACT_TRAVEL_MAX_MS,
  TACT_REACH_PX,
  TACT_STUCK_MS,
  TACT_STUN_BREAK_MS,
  TACT_WARMUP_MS,
} from './balance';
import { SIM_STEP_MS } from './constants';
import { ENEMIES } from './enemies';
import { dist } from './geometry';
import { createPlayerState } from './players';
import { createRng, randomFn } from './rng';
import {
  TACTIC_IDS,
  TACT_DAZED,
  breakTactics,
  hasTactic,
  isTactical,
  seizeTick,
  tacticBreakThreshold,
  tacticBudgetMs,
  tacticKindOf,
  tacticMask,
  tacticReliefMs,
  tacticsGoal,
  tacticsOfMask,
  tacticsTick,
  type SeizeObject,
} from './tactics';
import type { BossTacticId, EnemyAIContext, EnemyKind, EnemyState, PlayerId, PlayerState, SimEvent, TacticWorld, Vec2 } from './types';

const DT = SIM_STEP_MS;
const ROOM_W = 480;
const ROOM_H = 320;

const MINI: EnemyKind[] = ['warden', 'pyromancer', 'wraith'];
const BOSSES: EnemyKind[] = ['golem', 'morvane', 'frostqueen', 'forgelord', 'voidlord'];
const ALL_BOSS_KINDS: EnemyKind[] = [...MINI, ...BOSSES];

function makePlayer(id: PlayerId, x: number, y: number, over: Partial<PlayerState> = {}): PlayerState {
  const p = createPlayerState({ id, characterId: 'david', difficulty: 2 }, { x, y });
  Object.assign(p, over);
  if (p.status === 'down') p.hp = 0;
  return p;
}

interface Harness {
  ctx: EnemyAIContext;
  players: PlayerState[];
  enemies: EnemyState[];
  events: SimEvent[];
  randomCalls: number;
  blocked: boolean;
}

function makeHarness(players: PlayerState[], seed = 1, world?: TacticWorld): Harness {
  const rng = createRng(seed);
  const rnd = randomFn(rng);
  const enemies: EnemyState[] = [];
  let nextId = 1000;
  const h: Harness = { ctx: undefined as unknown as EnemyAIContext, players, enemies, events: [], randomCalls: 0, blocked: false };
  const free = (p: Vec2, r: number): boolean => p.x >= r && p.x <= ROOM_W - r && p.y >= r && p.y <= ROOM_H - r;
  h.ctx = {
    dtMs: DT,
    players,
    enemies,
    random: () => {
      h.randomCalls++;
      return rnd();
    },
    canOccupy: (pos, radius) => free(pos, radius),
    moveWithCollision: (pos, delta, radius) => {
      if (h.blocked) return { x: pos.x, y: pos.y };
      let x = pos.x;
      let y = pos.y;
      if (free({ x: x + delta.x, y }, radius)) x += delta.x;
      if (free({ x, y: y + delta.y }, radius)) y += delta.y;
      return { x, y };
    },
    spawnProjectile: () => undefined,
    spawnEnemy: (kind, pos) => {
      const e = createEnemyState(kind, pos, nextId++, 0);
      enemies.push(e);
      return e.id;
    },
    damageCircle: () => undefined,
    roomBounds: { width: ROOM_W, height: ROOM_H },
    emit: (e) => {
      h.events.push(e);
    },
    ...(world ? { world } : {}),
  };
  return h;
}

function boss(kind: EnemyKind, x = 240, y = 160, tactics?: BossTacticId[]): EnemyState {
  const e = createEnemyState(kind, { x, y }, 1, 0);
  e.data.engaged = 1; // déjà engagé : aggro illimitée (les joueurs du faux contexte sont loin)
  if (tactics) e.data.tact = tacticMask(tactics);
  return e;
}

function run(h: Harness, e: EnemyState, ms: number, each?: (t: number) => void): void {
  const steps = Math.round(ms / DT);
  for (let i = 0; i < steps; i++) {
    updateEnemy(e, h.ctx);
    each?.(i * DT);
  }
}

const kindOf = (e: EnemyState): number => e.data.tactKind ?? 0;
const kinds = (h: Harness): number[] => h.events.filter((e) => e.type === 'bossTactic').map((e) => (e as { kind: number }).kind);

describe('identifiants et masques', () => {
  it('rang = code d\'affichage, masque aller-retour', () => {
    expect(TACTIC_IDS.map(tacticKindOf)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(tacticMask(['guardDowned'])).toBe(1);
    expect(tacticMask(['campCrystal', 'seizeItems'])).toBe(2 | 16);
    expect(tacticMask([...TACTIC_IDS])).toBe(63);
    expect(tacticsOfMask(63)).toEqual([...TACTIC_IDS]);
    expect(tacticsOfMask(2 | 16)).toEqual(['campCrystal', 'seizeItems']);
    const e = boss('warden', 0, 0, ['huntWeak']);
    expect(isTactical(e)).toBe(true);
    expect(hasTactic(e, 'huntWeak')).toBe(true);
    expect(hasTactic(e, 'guardDowned')).toBe(false);
    expect(TACT_DAZED).toBe(7);
  });
});

describe('sans drapeau : comportement historique', () => {
  it.each(ALL_BOSS_KINDS)('%s : aucune clé tact*, aucun événement tactique, `tact: 0` identique', (kind) => {
    const mk = (flag: boolean): { e: EnemyState; h: Harness } => {
      const h = makeHarness([makePlayer(0, 100, 160), makePlayer(1, 380, 90, { status: 'down', hp: 0 })], 3);
      const e = boss(kind);
      if (flag) e.data.tact = 0;
      return { e, h };
    };
    const a = mk(false);
    const b = mk(true);
    run(a.h, a.e, 10000);
    run(b.h, b.e, 10000);
    expect(Object.keys(a.e.data).filter((k) => k.startsWith('tact'))).toEqual([]);
    expect(a.h.events.some((e) => e.type === 'bossTactic' || e.type === 'itemSeized')).toBe(false);
    expect(a.h.randomCalls).toBe(b.h.randomCalls);
    const bd = { ...b.e.data };
    delete bd.tact;
    expect(JSON.stringify({ ...b.e, data: bd })).toBe(JSON.stringify(a.e));
  });
});

describe('guardDowned (veilleur)', () => {
  it('attend l\'échauffement et le délai de réaction, puis se poste à l\'anneau du joueur à terre', () => {
    const down = makePlayer(1, 380, 100, { status: 'down' });
    const h = makeHarness([makePlayer(0, 60, 280), down], 1);
    const e = boss('warden', 240, 160, ['guardDowned']);
    let firstGuard = -1;
    let ref = -1;
    run(h, e, 20000, (t) => {
      if (firstGuard < 0 && kindOf(e) === 1) {
        firstGuard = t;
        ref = e.data.tactRef ?? -1;
      }
    });
    expect(firstGuard).toBeGreaterThanOrEqual(TACT_WARMUP_MS - 100);
    expect(kinds(h)[0]).toBe(1);
    expect(ref).toBe(1);
  });

  it('tient l\'anneau (au-delà de DOWNED_THREAT_RADIUS) puis relâche : budget et relâche par joueurs vivants', () => {
    const down = makePlayer(1, 330, 120, { status: 'down' });
    const h = makeHarness([makePlayer(0, 60, 280), down], 1);
    const e = boss('warden', 240, 160, ['guardDowned']);
    let minD = Infinity;
    let guardMs = 0;
    const periods: number[] = [];
    let cur = 0;
    run(h, e, 30000, () => {
      // temps POSTÉ près du joueur à terre (le budget ne compte pas le trajet)
      const posted = kindOf(e) === 1 && dist(e.pos, down.pos) <= GUARD_RING_PX + 14;
      if (posted) {
        cur += DT;
        guardMs += DT;
      } else if (cur > 0) {
        periods.push(cur);
        cur = 0;
      }
      if (kindOf(e) === 1 && e.mode === 'chase') minD = Math.min(minD, dist(e.pos, down.pos));
    });
    // 1 joueur vivant + 1 à terre : GUARD_MS[1] ; le boss reste au-dessus du rayon de menace du relevage
    expect(minD).toBeGreaterThan(20);
    expect(minD).toBeLessThan(GUARD_RING_PX + 15);
    expect(periods.length).toBeGreaterThanOrEqual(1);
    for (const p of periods) expect(p).toBeLessThanOrEqual(GUARD_MS[1] + 200);
    // relâche : entre deux veilles, au moins GUARD_RELIEF_MS[1]
    expect(guardMs).toBeLessThan(30000 * 0.6);
  });

  it('budget et relâche : valeurs des tableaux', () => {
    for (let a = 1; a <= 4; a++) {
      expect(tacticBudgetMs(1, a)).toBe(GUARD_MS[a]);
      expect(tacticReliefMs(1, a)).toBe(GUARD_RELIEF_MS[a]);
      expect(tacticReliefMs(1, a)).toBeGreaterThanOrEqual(6000);
      expect(tacticBudgetMs(2, a)).toBe(CAMP_MS[a]);
    }
    // plus il y a de joueurs vivants, plus la veille dure et moins la relâche est longue
    expect(GUARD_MS[4]).toBeGreaterThan(GUARD_MS[1]);
    expect(GUARD_RELIEF_MS[4]).toBeLessThan(GUARD_RELIEF_MS[1]);
  });

  it('abandonne le joueur après GUARD_GIVEUP_MS de chute continue', () => {
    const down = makePlayer(1, 380, 100, { status: 'down' });
    const h = makeHarness([makePlayer(0, 60, 280), down], 1);
    const e = boss('warden', 240, 160, ['guardDowned']);
    run(h, e, GUARD_GIVEUP_MS + 3000);
    expect(e.data.tactGiveUp).toBe(2);
    // ensuite, plus aucune veille de ce joueur
    const before = kinds(h).length;
    run(h, e, 20000);
    expect(kinds(h).slice(before).filter((k) => k === 1)).toEqual([]);
    expect(kindOf(e)).toBe(0);
    // relevé : l'abandon est levé
    down.status = 'alive';
    down.hp = down.maxHp;
    run(h, e, 100);
    expect(e.data.tactGiveUp).toBe(0);
  });

  it('plafond de portée : un joueur à terre trop loin est ignoré', () => {
    const down = makePlayer(1, 470, 310, { status: 'down' });
    const h = makeHarness([makePlayer(0, 400, 20), down], 1);
    const e = boss('warden', 10, 10, ['guardDowned']);
    expect(dist(e.pos, down.pos)).toBeGreaterThan(TACT_REACH_PX);
    run(h, e, 8000, () => {
      // le boss se rapproche en poursuivant le vivant : tant qu'il est hors de portée, aucun but
      if (dist(e.pos, down.pos) > TACT_REACH_PX) expect(kindOf(e)).not.toBe(1);
    });
  });
});

describe("guardDowned : TOUS les styles de boss atteignent l'ancre (brute et lévitant)", () => {
  // Régression : un boss lévitant (pyromancien, spectre, seigneur du Néant) n'avançait vers son but que pendant les rares pas 'chase' entre deux attaques
  // (windup/attack/recover l'immobilisaient) et n'arrivait jamais ; il n'attaque plus en trajet, il arrive puis tient l'anneau.
  it.each(['warden', 'forgelord', 'pyromancer', 'wraith', 'voidlord'] as EnemyKind[])("%s : atteint l'anneau (<= GUARD_RING_PX + 14) en moins de TACT_TRAVEL_MAX_MS et y reste posté", (kind) => {
    for (const dx of [100, 200, 300]) {
      const down = makePlayer(1, 100 + dx, 160, { status: 'down' });
      const h = makeHarness([makePlayer(0, 20, 300), down], 1);
      const e = boss(kind, 100, 160, ['guardDowned']);
      let reachedAt = -1;
      let posted = 0;
      run(h, e, 4000 + 1200 + TACT_TRAVEL_MAX_MS + 3000, (t) => {
        const near = kindOf(e) === 1 && dist(e.pos, down.pos) <= GUARD_RING_PX + 14;
        if (near) {
          if (reachedAt < 0) reachedAt = t;
          posted += DT;
        }
      });
      expect(reachedAt, `${kind} dx=${dx}`).toBeGreaterThan(0);
      expect(reachedAt - (TACT_WARMUP_MS + 1200), `${kind} dx=${dx}`).toBeLessThan(TACT_TRAVEL_MAX_MS);
      expect(posted, `${kind} dx=${dx}`).toBeGreaterThan(1000);
    }
  });

  it("un boss lévitant confisque aussi (seizeItems) et campe (campCrystal) : il atteint l'ancre", () => {
    for (const kind of ['pyromancer', 'wraith', 'voidlord'] as EnemyKind[]) {
      const item: TacticWorld = { crystals: [], items: [{ ref: 4, kind: 'heart', pos: { x: 260, y: 160 }, value: 2, eatable: true }] };
      const h = makeHarness([makePlayer(0, 20, 300), makePlayer(1, 20, 20)], 1, item);
      const e = boss(kind, 100, 160, ['seizeItems']);
      let min = Infinity;
      run(h, e, 4000 + TACT_TRAVEL_MAX_MS + 2000, () => {
        min = Math.min(min, dist(e.pos, { x: 260, y: 160 }));
      });
      expect(min, kind).toBeLessThan(12);
      const cr: TacticWorld = { crystals: [{ idx: 0, id: 'c0', pos: { x: 300, y: 160 } }], items: [] };
      const h2 = makeHarness([makePlayer(0, 20, 300, { hp: 10 }), makePlayer(1, 20, 20)], 1, cr);
      const e2 = boss(kind, 100, 160, ['campCrystal']);
      let min2 = Infinity;
      run(h2, e2, 4000 + TACT_TRAVEL_MAX_MS + 2000, () => {
        min2 = Math.min(min2, dist(e2.pos, { x: 300, y: 160 }));
      });
      expect(min2, kind).toBeLessThan(ENEMIES[kind].radius + 20 + 16);
    }
  });
});

describe('déstabilisation (contre-jeu)', () => {
  it('une perte de PV sur la fenêtre coupe les buts pendant TACT_BREAK_COOL_MS', () => {
    const down = makePlayer(1, 380, 100, { status: 'down' });
    const alive = makePlayer(0, 60, 280);
    const h = makeHarness([alive, down], 1);
    const e = boss('warden', 240, 160, ['guardDowned']);
    run(h, e, 8000);
    expect(kindOf(e)).toBe(1);
    const thr = tacticBreakThreshold(e, 1);
    expect(thr).toBeLessThan(45); // quelques coups de héros (≈ 22-25 PV) suffisent pour un demi-boss de 270 PV
    e.hp -= thr + 0.5;
    run(h, e, DT * 2);
    expect(kindOf(e)).toBe(TACT_DAZED);
    expect(e.data.tactBreakMs).toBeGreaterThan(0);
    run(h, e, TACT_BREAK_COOL_MS - 300);
    expect(kindOf(e)).toBe(TACT_DAZED);
    run(h, e, 600);
    expect(kindOf(e)).not.toBe(TACT_DAZED);
    expect(kinds(h)).toContain(TACT_DAZED);
  });

  it.each(ALL_BOSS_KINDS)('seuils réalistes : %s (1 à 4 vivants)', (kind) => {
    const e = boss(kind);
    const frac = ENEMIES[kind].isBoss ? 0.07 : 0.14;
    for (let a = 1; a <= 4; a++) {
      const thr = tacticBreakThreshold(e, a);
      expect(thr).toBeGreaterThan(0);
      expect(thr).toBeLessThanOrEqual(frac * e.maxHp);
      if (a >= 3) expect(thr).toBeCloseTo(frac * e.maxHp, 6);
    }
    // le seuil est atteignable en peu de coups (≈ 22-25 PV par coup) sous le plafond de dégâts (20 % / 35 % par 2 s)
    const cap = (ENEMIES[kind].isBoss ? 0.2 : 0.35) * e.maxHp;
    expect(tacticBreakThreshold(e, 4)).toBeLessThan(cap);
  });

  it("le seuil se mesure en dégâts NORMALISÉS : le même nombre de coups déstabilise à difficulté 1, 2 et 3 (jamais selon la difficulté de l'attaquant)", () => {
    const results: number[] = [];
    for (const diff of [1, 2, 3] as const) {
      const e = boss('warden', 240, 160, ['guardDowned']);
      const h = makeHarness([makePlayer(0, 60, 280), makePlayer(1, 380, 100, { status: 'down' })], 1);
      run(h, e, 8000); // but actif
      expect(kindOf(e)).toBe(1);
      const attacker = createPlayerState({ id: 0, characterId: 'david', difficulty: diff }, { x: 60, y: 280 });
      const cctx = { damageEnabled: true, room: { elapsedMs: 0 }, events: [], killers: new Map(), onEnemyHit: () => undefined } as unknown as CombatContext;
      // coups bruts de 8 jusqu à la déstabilisation (PV max d un demi-boss : 270, seuil à 1 vivant = 14 % x 0,6 = 22,7 : 3 coups)
      let hits = 0;
      while (kindOf(e) !== TACT_DAZED && hits < 50) {
        damageEnemy(cctx, e, 8, attacker, { x: 0, y: 0 });
        (cctx.room as { elapsedMs: number }).elapsedMs += 700; // le plafond glissant de dégâts ne s'en mêle pas
        hits++;
        run(h, e, DT * 2);
      }
      results.push(hits);
    }
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toBe(3);
  });

  it('un spécial qui touche (stunEnemy) déstabilise 5 s, sans étourdir le boss ; sans drapeau : aucun effet', () => {
    const h = makeHarness([makePlayer(0, 60, 280), makePlayer(1, 380, 100, { status: 'down' })], 1);
    const e = boss('warden', 240, 160, ['guardDowned']);
    run(h, e, 8000);
    expect(kindOf(e)).toBe(1);
    expect(stunEnemy(e, 800)).toBe(false);
    expect(e.mode).not.toBe('stunned');
    run(h, e, DT * 2);
    expect(kindOf(e)).toBe(TACT_DAZED);
    expect(e.data.tactBreakMs).toBeGreaterThan(TACT_STUN_BREAK_MS - 200);
    const plain = boss('warden');
    expect(stunEnemy(plain, 800)).toBe(false);
    expect(Object.keys(plain.data).filter((k) => k.startsWith('tact'))).toEqual([]);
    breakTactics(plain, 5000);
    expect(plain.data.tactBreakMs).toBeUndefined();
  });
});

describe('priorité, préemption et hystérésis', () => {
  it('campCrystal puis préemption par guardDowned quand un joueur tombe', () => {
    const world: TacticWorld = { crystals: [{ idx: 0, id: 'c0', pos: { x: 60, y: 60 } }, { idx: 1, id: 'c1', pos: { x: 420, y: 260 } }], items: [] };
    const hurt = makePlayer(0, 100, 280, { hp: 10 });
    const other = makePlayer(1, 380, 100);
    const h = makeHarness([hurt, other], 1, world);
    const e = boss('warden', 240, 160, ['guardDowned', 'campCrystal']);
    let sawCamp = false;
    run(h, e, 9000, () => {
      if (kindOf(e) === 2) sawCamp = true;
    });
    expect(sawCamp).toBe(true);
    // un joueur tombe pendant que le verrou court : la veille préempte (sans relâche en cours)
    const target = e.data.tactKind === 2 ? 2 : 0;
    expect(target).toBe(2);
    other.status = 'down';
    other.hp = 0;
    run(h, e, 3000);
    expect(kinds(h)).toContain(1);
  });

  it('hystérésis : le but n\'oscille pas (un événement au plus par TACT_MIN_LOCK_MS hors fin de budget)', () => {
    const world: TacticWorld = { crystals: [{ idx: 0, id: 'c0', pos: { x: 60, y: 60 } }], items: [{ ref: 0, kind: 'heart', pos: { x: 400, y: 260 }, value: 2, eatable: true }] };
    const hurt = makePlayer(0, 100, 280, { hp: 10 });
    const h = makeHarness([hurt, makePlayer(1, 380, 100)], 1, world);
    const e = boss('warden', 240, 160, ['campCrystal', 'seizeItems']);
    run(h, e, 40000);
    const k = kinds(h);
    // 40 s : au plus une dizaine de changements (budgets 3 s + 6 s + relâches), jamais des dizaines
    expect(k.length).toBeLessThan(25);
    expect(TACT_MIN_LOCK_MS).toBe(1500);
  });
});

describe('isolement : victimes (heedCalls, interceptCarrier, huntWeak)', () => {
  const near = ISOLATION_PX - 20;
  const far = ISOLATION_PX + 120;

  it('interceptCarrier : porteur de cœur isolé poursuivi ; groupé : jamais', () => {
    const carrier = makePlayer(0, 60, 60, { heart: 'full' });
    const mate = makePlayer(1, 60 + near, 60);
    const h = makeHarness([carrier, mate], 1);
    const e = boss('warden', 400, 280, ['interceptCarrier']);
    run(h, e, 12000);
    expect(kinds(h).filter((k) => k === 4)).toEqual([]);
    mate.pos = { x: 60 + far + 100, y: 60 };
    run(h, e, 12000);
    expect(kinds(h)).toContain(4);
    expect(e.data.tactRef).toBe(0);
  });

  it('heedCalls : appelant isolé (croix rouge), jamais pour un objet d\'équipement ; solo : jamais', () => {
    const caller = makePlayer(0, 60, 60, { autoCall: { icon: 'cross', ref: 'x', ms: 3000, to: [1] } });
    const mate = makePlayer(1, 60 + far + 100, 60);
    const h = makeHarness([caller, mate], 1);
    const e = boss('warden', 400, 280, ['heedCalls']);
    run(h, e, 7000);
    expect(kinds(h)).toContain(3);
    const gearCaller = makePlayer(0, 60, 60, { autoCall: { icon: 'gear', ref: 'g1', ms: 3000, to: [1] } });
    const h2 = makeHarness([gearCaller, makePlayer(1, 60 + far + 100, 60)], 1);
    const e2 = boss('warden', 400, 280, ['heedCalls']);
    run(h2, e2, 12000);
    expect(kinds(h2)).toEqual([]);
    const solo = makePlayer(0, 60, 60, { autoCall: { icon: 'cross', ref: 'x', ms: 3000, to: [] } });
    const h3 = makeHarness([solo], 1);
    const e3 = boss('warden', 400, 280, ['heedCalls']);
    run(h3, e3, 12000);
    expect(kinds(h3)).toEqual([]);
  });

  it('huntWeak : le plus faible isolé (≤ 60 % de PV) ; un joueur en bonne santé n\'est pas pris pour cible', () => {
    const weak = makePlayer(0, 60, 60);
    weak.hp = Math.floor(weak.maxHp * 0.4);
    const strong = makePlayer(1, 60 + far + 100, 60);
    const h = makeHarness([weak, strong], 1);
    const e = boss('warden', 400, 280, ['huntWeak']);
    run(h, e, 7000);
    expect(kinds(h)).toContain(6);
    const h2 = makeHarness([makePlayer(0, 60, 60), makePlayer(1, 60 + far + 100, 60)], 1);
    const e2 = boss('warden', 400, 280, ['huntWeak']);
    run(h2, e2, 12000);
    expect(kinds(h2)).toEqual([]);
  });
});

describe('campCrystal (gardien de cristal)', () => {
  it('se poste près du cristal le plus proche du plus nécessiteux, un seul à la fois, jamais un cristal utilisé', () => {
    const needy = makePlayer(0, 60, 300, { hp: 5 });
    const world: TacticWorld = {
      crystals: [
        { idx: 0, id: 'c0', pos: { x: 60, y: 250 } },
        { idx: 2, id: 'c2', pos: { x: 420, y: 60 } },
      ],
      items: [],
    };
    const h = makeHarness([needy, makePlayer(1, 440, 300)], 1, world);
    const e = boss('warden', 300, 160, ['campCrystal']);
    let post = Infinity;
    run(h, e, 20000, () => {
      if (kindOf(e) === 2 && e.mode === 'chase') post = Math.min(post, dist(e.pos, world.crystals[0].pos));
    });
    expect(post).toBeLessThan(ENEMIES.warden.radius + 20 + 16);
    expect(kinds(h)).toContain(2);
    // le cristal 0 est utilisé : il n'existe plus dans le monde ; reste c2 (le plus proche restant)
    world.crystals.shift();
    run(h, e, 200);
    expect(world.crystals.length).toBe(1);
  });

  it('sans besoin (tous en forme), aucun campement', () => {
    const world: TacticWorld = { crystals: [{ idx: 0, id: 'c0', pos: { x: 60, y: 260 } }], items: [] };
    const h = makeHarness([makePlayer(0, 80, 280), makePlayer(1, 380, 120)], 1, world);
    const e = boss('warden', 300, 160, ['campCrystal']);
    run(h, e, 12000);
    expect(kinds(h)).toEqual([]);
  });
});

describe('seizeItems (rapace) : poste et confiscation', () => {
  it('se poste sur le bonus le plus précieux (cœur entier avant demi-cœur) et y reste immobile', () => {
    const world: TacticWorld = {
      crystals: [],
      items: [
        { ref: 4, kind: 'heart', pos: { x: 100, y: 100 }, value: 2, eatable: true },
        { ref: 8, kind: 'heart', pos: { x: 100, y: 240 }, value: 3, eatable: false },
      ],
    };
    const h = makeHarness([makePlayer(0, 440, 300), makePlayer(1, 440, 20)], 1, world);
    const e = boss('warden', 240, 160, ['seizeItems']);
    let parked = Infinity;
    run(h, e, 25000, () => {
      if (kindOf(e) === 5 && e.mode === 'chase') parked = Math.min(parked, dist(e.pos, { x: 100, y: 240 }));
    });
    expect(e.data.tactX).toBe(100);
    expect(e.data.tactY).toBe(240);
    expect(parked).toBeLessThan(8);
  });

  it("jamais sur un objet tombé aux pieds d'un joueur à terre (le relevage resterait ralenti) ; un objet loin reste visé", () => {
    const down = makePlayer(1, 300, 160, { status: 'down' });
    const world: TacticWorld = {
      crystals: [],
      items: [
        { ref: 4, kind: 'heart', pos: { x: 300, y: 160 }, value: 3, eatable: false }, // cœur rangé tombé SUR le joueur
        { ref: 8, kind: 'heart', pos: { x: 310, y: 150 }, value: 2, eatable: true }, // demi-cœur éparpillé à 14 px
        { ref: 12, kind: 'gear', pos: { x: 330, y: 160 }, value: 1, eatable: false }, // équipement à 30 px
      ],
    };
    const h = makeHarness([makePlayer(0, 20, 300), down], 1, world);
    const e = boss('forgelord', 100, 160, ['seizeItems']);
    let minD = Infinity;
    run(h, e, 40000, () => {
      minD = Math.min(minD, dist(e.pos, down.pos));
    });
    expect(minD).toBeGreaterThan(20); // DOWNED_THREAT_RADIUS : jamais de ralentissement du relevage
    expect(kinds(h)).not.toContain(5);
    // le même objet loin du joueur à terre : visé normalement
    world.items.push({ ref: 16, kind: 'heart', pos: { x: 150, y: 60 }, value: 2, eatable: true });
    run(h, e, 20000);
    expect(kinds(h)).toContain(5);
    expect(e.data.tactRef === 16 || kinds(h).includes(5)).toBe(true);
  });

  const obj = (ref: number, x: number, y: number): SeizeObject => ({ ref, kind: 'heart', pos: { x, y } });

  it('confisque après SEIZE_DWELL_MS ; objet ramassé avant : rien ; délai et plafond (2 demi-boss / 3 boss)', () => {
    const e = boss('warden', 100, 100, ['seizeItems']);
    const o = obj(4, 102, 100);
    let t = 0;
    let got: number | null = null;
    while (got === null && t < SEIZE_DWELL_MS + 500) {
      got = seizeTick(e, DT, [o]);
      t += DT;
    }
    expect(got).toBe(4);
    expect(t).toBeGreaterThanOrEqual(SEIZE_DWELL_MS - 50);
    expect(t).toBeLessThanOrEqual(SEIZE_DWELL_MS + 100);
    // délai entre deux confiscations
    let again: number | null = null;
    let t2 = 0;
    while (again === null && t2 < 20000) {
      again = seizeTick(e, DT, [obj(8, 102, 100)]);
      t2 += DT;
    }
    expect(t2).toBeGreaterThanOrEqual(SEIZE_COOL_MS + SEIZE_DWELL_MS - 100);
    // plafond d'un demi-boss : SEIZE_MAX_MINI
    let third: number | null = null;
    for (let i = 0; i < 1500; i++) third = third ?? seizeTick(e, DT, [obj(12, 102, 100)]);
    expect(SEIZE_MAX_MINI).toBe(2);
    expect(third).toBeNull();
    // un boss de fin : SEIZE_MAX_BOSS
    const f = boss('frostqueen', 100, 100, ['seizeItems']);
    let count = 0;
    for (let i = 0; i < 6000 * 3; i++) if (seizeTick(f, DT, [obj(100 + count, 102, 100)]) !== null) count++;
    expect(count).toBe(SEIZE_MAX_BOSS);
    // objet disputé : retiré avant l'échéance (aucune confiscation, minuterie remise à zéro)
    const g = boss('warden', 100, 100, ['seizeItems']);
    for (let i = 0; i < 100; i++) seizeTick(g, DT, [obj(4, 102, 100)]);
    expect(seizeTick(g, DT, [])).toBeNull();
    expect(g.data.tactSeizeMs).toBe(0);
    // hors de portée du boss : rien
    const far = boss('warden', 100, 100, ['seizeItems']);
    for (let i = 0; i < 400; i++) expect(seizeTick(far, DT, [obj(4, 200, 100)])).toBeNull();
    // sans la tactique : aucun effet, aucune clé
    const plain = boss('warden', 100, 100, ['guardDowned']);
    expect(seizeTick(plain, DT, [obj(4, 102, 100)])).toBeNull();
    expect(plain.data.tactSeizeMs).toBeUndefined();
  });

  it('déstabilisé : pas de confiscation', () => {
    const e = boss('warden', 100, 100, ['seizeItems']);
    e.data.tactBreakMs = 4000;
    for (let i = 0; i < 400; i++) expect(seizeTick(e, DT, [obj(4, 102, 100)])).toBeNull();
  });
});

describe('blocage du boss', () => {
  it('un boss qui n\'avance plus abandonne son but (relâche = moitié)', () => {
    const down = makePlayer(1, 460, 20, { status: 'down' });
    const h = makeHarness([makePlayer(0, 20, 300), down], 1);
    h.blocked = false;
    const e = boss('warden', 240, 160, ['guardDowned']);
    run(h, e, 6000); // échauffement + réaction + début de la veille
    expect(kindOf(e)).toBe(1);
    h.blocked = true;
    let released = false;
    run(h, e, TACT_STUCK_MS + 1500, () => {
      if (kindOf(e) === 0) released = true;
    });
    expect(released).toBe(true);
    expect(e.data.tactCool1).toBeGreaterThan(0);
  });
});

describe('aucun tirage aléatoire, sérialisation, boss seulement', () => {
  it('tactics.ts n\'appelle jamais ctx.random', () => {
    const world: TacticWorld = { crystals: [{ idx: 0, id: 'c0', pos: { x: 60, y: 60 } }], items: [{ ref: 4, kind: 'heart', pos: { x: 200, y: 200 }, value: 2, eatable: true }] };
    const players = [makePlayer(0, 100, 280, { hp: 10, heart: 'half' }), makePlayer(1, 420, 40, { status: 'down' }), makePlayer(2, 300, 100, { autoCall: { icon: 'cross', ref: 'x', ms: 1000, to: [] } })];
    const h = makeHarness(players, 1, world);
    h.ctx = { ...h.ctx, random: () => { throw new Error('random interdit'); } };
    const e = boss('warden', 240, 160, [...TACTIC_IDS]);
    for (let i = 0; i < 6000; i++) {
      tacticsTick(e, h.ctx, DT);
      e.mode = 'chase';
      tacticsGoal(e, h.ctx, DT);
      seizeTick(e, DT, []);
    }
    expect(kindOf(e)).toBeGreaterThanOrEqual(0);
  });

  it.each(ALL_BOSS_KINDS)('%s : données JSON pures, reprise à l\'identique après sérialisation en plein but', (kind) => {
    const mkPlayers = (): PlayerState[] => [makePlayer(0, 60, 280), makePlayer(1, 380, 100, { status: 'down' })];
    const world: TacticWorld = { crystals: [{ idx: 0, id: 'c0', pos: { x: 60, y: 60 } }], items: [] };
    const constRandom = (h: Harness): void => {
      h.ctx = { ...h.ctx, random: () => 0.37 };
    };
    const h1 = makeHarness(mkPlayers(), 1, world);
    constRandom(h1);
    const e1 = boss(kind, 240, 160, [...TACTIC_IDS]);
    run(h1, e1, 8000);
    expect(Object.values(e1.data).every(Number.isFinite)).toBe(true);
    const snapshot = JSON.stringify({ e: e1, p: h1.players });
    const parsed = JSON.parse(snapshot) as { e: EnemyState; p: PlayerState[] };
    const h2 = makeHarness(parsed.p, 1, world);
    constRandom(h2);
    run(h1, e1, 6000);
    run(h2, parsed.e, 6000);
    expect(JSON.stringify(parsed.e)).toBe(JSON.stringify(e1));
  });

  it('un ennemi ordinaire ignore `tact` ; les sbires invoqués n\'en héritent pas', () => {
    const h = makeHarness([makePlayer(0, 100, 160), makePlayer(1, 380, 100, { status: 'down' })], 1);
    const slime = createEnemyState('slime', { x: 200, y: 160 }, 5, 0);
    slime.data.tact = 63;
    run(h, slime, 5000);
    expect(Object.keys(slime.data).filter((k) => k.startsWith('tact') && k !== 'tact')).toEqual([]);
    const q = boss('frostqueen', 240, 160, [...TACTIC_IDS]);
    q.hp = q.maxHp * 0.3;
    h.enemies.push(q);
    run(h, q, 90000); // un boss qui ne rejoint un but qu'après avoir marché n'invoque plus avant d'arriver : on laisse le temps
    const minions = h.enemies.filter((e) => e.data.summoner === q.id);
    expect(minions.length).toBeGreaterThan(0);
    for (const m of minions) expect(m.data.tact).toBeUndefined();
  });
});
