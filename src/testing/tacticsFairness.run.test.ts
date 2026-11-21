/**
 * PREUVE D'ÉQUITÉ des TACTIQUES DE BOSS : un boss « malin » (toutes les tactiques) affronte (1) une équipe de bots qui SE BAT et (2) le PIRE CAS (un sauveteur seul qui ne frappe jamais) ;
 * un joueur est mis à terre pendant le combat et doit pouvoir être RELEVÉ, à 2, 3 et 4 joueurs, sur plusieurs graines, pour un demi-boss de mêlée, un demi-boss lévitant et un boss de fin.
 * (1) comparaison avec le même scénario SANS tactiques (les bots ne relèvent qu'une fois la zone sûre : leur propre politique domine le délai, les tactiques ne doivent rien y ajouter de
 * notable ni provoquer de défaite en plus) ; (2) relevé en 25 s simulées au plus, sans défaite collective, même sans jamais frapper le boss (veille bornée + relâche obligatoire).
 *
 * Les bots (`BotRun`) ne produisent que des `ActionFrame` : ils attaquent (`attackUntilClear`) et relèvent seuls (`decideRevive`, jamais tant qu'un ennemi est dans `reviveSafeRadius`
 * de l'allié à terre : c'est la déstabilisation par les dégâts qui libère le relevage). Boucles bornées : aucune horloge réelle.
 */
import { describe, expect, it } from 'vitest';
import { REVIVE_RANGE, SIM_STEP_MS } from '../core/constants';
import { makeTestLayout, makeTestLevel, makeTestRoom } from '../core/levelValidation';
import { createSimulation } from '../core/simulation';
import type { BossTacticId, CharacterId, EnemyKind, LevelDef, PlayerId, SimEvent, TickInputs } from '../core/types';
import { BotRun, attackUntilClear } from './botKit';

const ALL: BossTacticId[] = ['guardDowned', 'campCrystal', 'heedCalls', 'interceptCarrier', 'seizeItems', 'huntWeak'];
const CHARS: Record<number, CharacterId[]> = {
  2: ['david', 'valentine'],
  3: ['david', 'valentine', 'aelith'],
  4: ['david', 'valentine', 'grok', 'aelith'],
};

/** Salle de boss pure 60×36 : le boss tactique, quelques sbires, 3 cristaux de soin, sortie après `clear`. */
function bossLevel(kind: EnemyKind, tactics: BossTacticId[]): LevelDef {
  const room = makeTestRoom({
    id: 'arena',
    layout: makeTestLayout(60, 36),
    playerSpawns: [
      [4, 4],
      [5, 4],
      [4, 5],
      [5, 5],
    ],
    enemies: [
      { kind, tile: [40, 20], ...(tactics.length > 0 ? { tactics } : {}) },
      { kind: 'skeleton', tile: [30, 8], minPlayers: 1 },
      { kind: 'skeleton', tile: [34, 28], minPlayers: 1 },
      { kind: 'spider', tile: [48, 10], minPlayers: 1 },
      { kind: 'slime', tile: [50, 28], minPlayers: 2 },
    ],
    mechanisms: [],
    healCrystals: [
      { id: 'c1', tile: [12, 28] },
      { id: 'c2', tile: [26, 4] },
      { id: 'c3', tile: [14, 6], minPlayers: 3 },
    ],
    exit: { rect: { x: 56, y: 16, w: 2, h: 3 }, requires: ['clear'], final: true },
  });
  return makeTestLevel({ rooms: [room] });
}

interface Outcome {
  revivedAfterMs: number | null;
  wipes: number;
  tacticEvents: number[];
}

/** Équipe de bots qui SE BAT (relève seule quand c'est sûr) : un joueur tombe 7 s après le début du combat. */
function scenario(kind: EnemyKind, tactics: BossTacticId[], n: number, seed: number): Outcome {
  const level = bossLevel(kind, tactics);
  const run = new BotRun(level, { playerCount: n, characters: CHARS[n], difficulties: Array.from({ length: n }, () => 2), seed });
  run.queueEach(() => attackUntilClear({ maxMs: 200000 }));
  const events: SimEvent[] = [];
  const orig = run.stepOnce.bind(run);
  (run as { stepOnce: typeof run.stepOnce }).stepOnce = (frames) => {
    const ev = orig(frames);
    events.push(...ev);
    return ev;
  };
  // 7 s de combat (l'échauffement des tactiques est de 4 s), puis le joueur 2 tombe
  const fightStart = run.timeMs;
  while (run.timeMs - fightStart < 7000 && run.state.phase === 'playing') run.stepOnce();
  const victim = 1 as PlayerId;
  const downedAt = run.timeMs;
  let revivedAfterMs: number | null = null;
  if (run.sim.knockDown(victim)) {
    while (run.timeMs - downedAt < 60000 && run.state.phase === 'playing') {
      run.stepOnce();
      if (run.state.players[victim].status === 'alive') {
        revivedAfterMs = run.timeMs - downedAt;
        break;
      }
    }
  }
  return {
    revivedAfterMs,
    wipes: run.stats.wipes,
    tacticEvents: events.filter((e) => e.type === 'bossTactic').map((e) => (e as { kind: number }).kind),
  };
}

/**
 * PIRE CAS : un SEUL sauveteur « humain » (il ne frappe jamais le boss, ne fuit pas, ne se soigne pas) rejoint le joueur à terre et maintient `revive` quoi que fasse le boss ; les autres
 * joueurs restent immobiles à l'écart. `delayMs` : le sauveteur n'agit qu'après ce délai (il arrive PENDANT la veille). Retourne le temps (ms) jusqu'au relevage, ou null.
 */
function lonelyRescuer(kind: EnemyKind, n: number, seed: number, delayMs = 0): { revivedAfterMs: number | null; wipes: number; guardPostedMs: number } {
  const level = bossLevel(kind, ALL);
  const chars = CHARS[n];
  const sim = createSimulation(
    { levelId: level.id, players: Array.from({ length: n }, (_, i) => ({ id: i as PlayerId, characterId: chars[i], difficulty: 2 as const })), seed },
    level,
  );
  let wipes = 0;
  let guardPostedMs = 0;
  const down = 1 as PlayerId;
  const rescuer = 0 as PlayerId;
  // le boss est engagé d'emblée (aggro illimitée) ; l'échauffement des tactiques (4 s) se déroule pendant qu'il marche vers l'équipe, restée au départ
  sim.step(SIM_STEP_MS, {});
  const boss0 = sim.state.room.enemies.find((e) => e.kind === kind);
  if (boss0) boss0.data.engaged = 1;
  for (let t = 0; t < 6000; t += SIM_STEP_MS) sim.step(SIM_STEP_MS, {});
  // le joueur à terre tombe à ~100 px du boss, entre lui et le sauveteur (à ~70 px derrière) ; les autres joueurs restent au départ
  const boss1 = sim.state.room.enemies.find((e) => e.kind === kind) as { pos: { x: number; y: number } };
  sim.state.players[down].pos = { x: boss1.pos.x - 100, y: boss1.pos.y };
  sim.state.players[rescuer].pos = { x: boss1.pos.x - 170, y: boss1.pos.y };
  sim.knockDown(down);
  const downedAt = sim.state.timeMs;
  let revivedAfterMs: number | null = null;
  while (sim.state.timeMs - downedAt < 60000) {
    const r = sim.state.players[rescuer];
    const d = sim.state.players[down];
    const dx = d.pos.x - r.pos.x;
    const dy = d.pos.y - r.pos.y;
    const len = Math.hypot(dx, dy);
    const inputs: TickInputs = {};
    if (r.status === 'alive' && sim.state.timeMs - downedAt >= delayMs) {
      inputs[rescuer] =
        len > REVIVE_RANGE - 4
          ? { moveX: dx / len, moveY: dy / len, attack: false, interact: false, revive: len <= REVIVE_RANGE }
          : { moveX: 0, moveY: 0, attack: false, interact: false, revive: true };
    }
    const events = sim.step(SIM_STEP_MS, inputs);
    if (events.some((e) => e.type === 'teamWipe')) wipes++;
    const boss = sim.state.room.enemies.find((e) => e.kind === kind);
    if (boss && (boss.data.tactKind ?? 0) === 1 && Math.hypot(boss.pos.x - d.pos.x, boss.pos.y - d.pos.y) <= 60) guardPostedMs += SIM_STEP_MS;
    if (d.status === 'alive') {
      revivedAfterMs = sim.state.timeMs - downedAt;
      break;
    }
    if (sim.state.phase === 'wipe') break;
  }
  return { revivedAfterMs, wipes, guardPostedMs };
}

const BOSS_CASES: { kind: EnemyKind; label: string }[] = [
  { kind: 'warden', label: 'demi-boss de mêlée (warden)' },
  { kind: 'pyromancer', label: 'demi-boss lévitant (pyromancer)' },
  { kind: 'forgelord', label: 'boss de fin (forgelord)' },
];

const fmt = (ms: number | null): string => (ms === null ? 'JAMAIS' : `${(ms / 1000).toFixed(1)}s`);

describe('tactiques de boss : le relevage reste possible (preuve par simulation)', () => {
  for (const { kind, label } of BOSS_CASES) {
    for (const n of [2, 3, 4]) {
      it(`${label}, ${n} joueurs, graines 1 à 5 : l'équipe qui se bat relève aussi bien que sans tactiques (aucune défaite en plus, ≤ +10 s)`, () => {
        const rows: string[] = [];
        for (const seed of [1, 2, 3, 4, 5]) {
          const base = scenario(kind, [], n, seed);
          const tact = scenario(kind, ALL, n, seed);
          rows.push(`${fmt(base.revivedAfterMs)}/${fmt(tact.revivedAfterMs)}`);
          expect(base.tacticEvents, 'sans tactiques : aucun événement').toEqual([]);
          expect(tact.wipes, `défaites collectives en plus (graine ${seed})`).toBeLessThanOrEqual(base.wipes);
          if (base.revivedAfterMs !== null) {
            expect(tact.revivedAfterMs, `joueur jamais relevé avec les tactiques (graine ${seed})`).not.toBeNull();
            expect(tact.revivedAfterMs as number, `relevage trop long (graine ${seed})`).toBeLessThanOrEqual(base.revivedAfterMs + 10000);
          }
        }
        console.info(`[tactiques] ${label} ${n}j : relevé (sans / avec tactiques) ${rows.join(', ')}`);
      }, 300_000);
    }
  }

  for (const { kind, label } of BOSS_CASES) {
    for (const n of [2, 3, 4]) {
      it(`${label}, ${n} joueurs : un sauveteur seul, sans jamais frapper le boss (pire cas), relève en ≤ 25 s sans défaite collective`, () => {
        const rows: string[] = [];
        for (const seed of [1, 2, 3, 4, 5]) {
          const o = lonelyRescuer(kind, n, seed);
          rows.push(`${fmt(o.revivedAfterMs)} (veille ${(o.guardPostedMs / 1000).toFixed(1)}s)`);
          expect(o.wipes, `défaites collectives (graine ${seed})`).toBe(0);
          expect(o.revivedAfterMs, `joueur jamais relevé (graine ${seed})`).not.toBeNull();
          expect(o.revivedAfterMs as number, `relevage trop long (graine ${seed})`).toBeLessThanOrEqual(25000);
        }
        console.info(`[tactiques] pire cas ${label} ${n}j : ${rows.join(', ')}`);
      }, 300_000);
    }
  }

  for (const { kind, label } of BOSS_CASES) {
    for (const n of [2, 3, 4]) {
      it(`${label}, ${n} joueurs : le sauveteur arrive 6 s APRÈS la chute (pendant la veille), le boss se POSTE réellement près du joueur à terre, relevé en ≤ 25 s sans défaite`, () => {
        const rows: string[] = [];
        for (const seed of [1, 2, 3, 4, 5]) {
          const o = lonelyRescuer(kind, n, seed, 6000);
          rows.push(`${fmt(o.revivedAfterMs)} (postée ${(o.guardPostedMs / 1000).toFixed(1)}s)`);
          expect(o.wipes, `défaites collectives (graine ${seed})`).toBe(0);
          expect(o.revivedAfterMs, `joueur jamais relevé (graine ${seed})`).not.toBeNull();
          expect(o.revivedAfterMs as number, `relevage trop long (graine ${seed})`).toBeLessThanOrEqual(25000);
          // la veille est réellement exercée : le boss (brute OU lévitant) est arrivé à l'anneau du joueur à terre avant le relevage
          expect(o.guardPostedMs, `le boss ne s'est jamais posté (graine ${seed})`).toBeGreaterThan(0);
        }
        console.info(`[tactiques] sauveteur tardif ${label} ${n}j : ${rows.join(', ')}`);
      }, 300_000);
    }
  }

  it('les tactiques se déclenchent bel et bien pendant le scénario (la veille apparaît)', () => {
    let seen = 0;
    for (const seed of [1, 2, 3]) {
      const o = scenario('warden', ALL, 3, seed);
      if (o.tacticEvents.includes(1)) seen++;
    }
    expect(seen).toBeGreaterThanOrEqual(1);
  }, 300_000);
});
