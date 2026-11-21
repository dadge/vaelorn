/**
 * Niveau 8 (« Le Bastion des Stratèges ») : preuve par la simulation réelle que le niveau est TERMINABLE de bout en bout
 * (`phase === 'levelComplete'`) à 1, 2, 3 et 4 joueurs, avec des bots qui ne produisent que des `ActionFrame`
 * (script de résolution : `level8.solution.ts`). Graine fixe : partie déterministe.
 *
 * Mesure la « durée cible » (plafonds mesurés de `durationWindows.ts` ; balayage de graines dans `durationWindows.run.test.ts`), l'équité (≤ 2 défaites collectives par
 * salle, ≤ 5 au total), l'identité du niveau (les boss MALINS : un allié forcé à terre dans chaque salle tactique est relevé en ≤ 25 s
 * simulées, sans défaite collective) et la règle d'embuscade des Fosses (aucun chemin ne la contourne).
 *
 * Mesures de référence (graine 7, bots, difficulté 2 ; secondes simulées) : 1 joueur 739 (2 défaites : vigie et conseil), 2 joueurs 554,
 * 3 joueurs 493, 4 joueurs 487 (aucune défaite). Autres graines : solo 746 (graine 1) et 688 (graine 2), 2 joueurs 519 (graine 1) et 561
 * (graine 4). Le solo est PROCHE du plafond (750 s) : la salle du boss final (≈ 195 s en solo) et la vigie dominent ; toute dérive de moteur
 * ou de balance se verra donc ici.
 */
import { describe, expect, it } from 'vitest';
import { GUARD_RING_PX, TACT_REACT_MS, TACT_WARMUP_MS } from '../core/balance';
import { TILE } from '../core/constants';
import { tacticMask } from '../core/tactics';
import type { PlayerId } from '../core/types';
import { level8 } from '../levels/level8';
import { durationCapMs } from './durationWindows';
import { BotRun, conds, formatStats, goTo, runLevelScripts, standOn, waitUntil, type LevelRunResult } from './botKit';
import {
  LEVEL8_CHARACTERS,
  LEVEL8_DIFFICULTY,
  LEVEL8_SOLO_BOSS,
  level8RunOptions,
  level8Scripts,
  newLevel8Run,
  newLevel8SoloBossRun,
  solveLevel8,
} from './level8.solution';

function secs(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

const MINUTE = 60 * 1000;

describe('niveau 8 : terminable de bout en bout (bots, simulation réelle)', () => {
  for (const n of [1, 2, 3, 4]) {
    it(`${n} joueur(s) : niveau terminé, durée simulée dans la fenêtre cible, équité`, () => {
      const { run, result } = solveLevel8(n);
      const chars = level8RunOptions(n).characters.join(', ');
      console.info(
        `\n[level8] ${n} joueur(s) (${chars}, difficulté ${LEVEL8_DIFFICULTY[n]}) : ${result.completed ? 'TERMINÉ' : 'ÉCHEC'} en ${secs(result.timeMs)} simulées, ${run.stats.wipes} défaite(s) collective(s)`,
      );
      for (const r of run.stats.rooms) {
        const i = run.stats.rooms.indexOf(r);
        const first = i === 0 ? 0 : (run.stats.rooms[i - 1].clearedAtMs ?? 0);
        const dur = r.clearedAtMs === null ? r.timeMs : r.clearedAtMs - first;
        console.info(
          `[level8]   ${String(r.roomIndex + 1)}. ${r.roomId.padEnd(10)} ${secs(dur).padStart(8)}  à terre ${r.downs.reduce((a, b) => a + b, 0)}  défaites ${r.wipes}  PV perdus ${Math.round(r.hpLost.reduce((a, b) => a + b, 0))}`,
        );
      }
      console.info(formatStats(run));
      expect(result.failure, result.failure ?? '').toBeNull();
      expect(result.completed).toBe(true);
      expect(run.state.phase).toBe('levelComplete');
      expect(result.timeMs, 'durée simulée trop courte').toBeGreaterThanOrEqual(5 * MINUTE);
      expect(result.timeMs, 'durée simulée trop longue').toBeLessThanOrEqual(durationCapMs(8, n));
      // Aucune action de script échouée, toutes les salles validées, tous les objectifs accomplis.
      expect(run.failures).toEqual([]);
      expect(run.state.clearedRooms).toEqual(level8.rooms.map((r) => r.id));
      expect(run.state.objectives.every((o) => o.done)).toBe(true);
      // Équité (les bots n'esquivent pas intelligemment) : ≤ 2 défaites collectives par salle, ≤ 5 au total.
      for (const r of run.stats.rooms) expect(r.wipes, `défaites dans ${r.roomId}`).toBeLessThanOrEqual(2);
      expect(run.stats.wipes).toBeLessThanOrEqual(5);
    }, 300_000);
  }

  it('est déterministe : deux parties identiques (2 joueurs, à partir de la Vigie) donnent la même durée et les mêmes statistiques', () => {
    const a = solveLevel8(2, { startRoomIndex: 5 });
    const b = solveLevel8(2, { startRoomIndex: 5 });
    expect(a.result.completed).toBe(true);
    expect(a.result.timeMs).toBe(b.result.timeMs);
    expect(JSON.stringify(a.run.stats)).toBe(JSON.stringify(b.run.stats));
  }, 300_000);

  it('les personnages et difficultés des bots sont documentés (difficulté 2, solo compris)', () => {
    expect(LEVEL8_CHARACTERS[1]).toEqual(['david']);
    expect(LEVEL8_CHARACTERS[4]).toHaveLength(4);
    for (const n of [1, 2, 3, 4]) expect(LEVEL8_DIFFICULTY[n]).toBe(2);
  });
});

describe('niveau 8 : solo à la difficulté par défaut (2)', () => {
  it('boss final : une archère (Aelith) vainc le seigneur de la forge (six tactiques) en solo à difficulté 2, graines 7, 1 et 2 (≤ 2 défaites)', () => {
    expect(LEVEL8_SOLO_BOSS).toEqual({ character: 'aelith', difficulty: 2 });
    for (const seed of [7, 1, 2]) {
      const run = newLevel8SoloBossRun({ seed });
      const result = runLevelScripts(run, level8Scripts(), { maxTotalMs: 20 * MINUTE, maxRoomMs: 240000, maxWipesPerRoom: 4 });
      console.info(`[level8] solo boss (aelith, difficulté 2, graine ${seed}) : ${result.completed ? 'TERMINÉ' : 'ÉCHEC'} en ${secs(result.timeMs)}, ${run.stats.wipes} défaite(s)`);
      expect(result.failure, `graine ${seed} : ${result.failure ?? ''}`).toBeNull();
      expect(result.completed, `graine ${seed}`).toBe(true);
      expect(run.state.phase).toBe('levelComplete');
      expect(run.stats.wipes, `graine ${seed} : défaites`).toBeLessThanOrEqual(2);
    }
  }, 300_000);

  it('boss final : David (mêlée) vainc aussi le seigneur de la forge en solo à difficulté 2 (graines 7, 1 et 2, ≤ 2 défaites)', () => {
    for (const seed of [7, 1, 2]) {
      const run = newLevel8SoloBossRun({ seed, character: 'david', difficulty: 2 });
      const result = runLevelScripts(run, level8Scripts(), { maxTotalMs: 20 * MINUTE, maxRoomMs: 240000, maxWipesPerRoom: 4 });
      console.info(`[level8] solo boss (david, difficulté 2, graine ${seed}) : ${result.completed ? 'TERMINÉ' : 'ÉCHEC'} en ${secs(result.timeMs)}, ${run.stats.wipes} défaite(s)`);
      expect(result.failure, `graine ${seed} : ${result.failure ?? ''}`).toBeNull();
      expect(result.completed, `graine ${seed}`).toBe(true);
      expect(run.stats.wipes, `graine ${seed} : défaites`).toBeLessThanOrEqual(2);
    }
  }, 300_000);
});

// ───────────────────────────── Identité : les boss malins sont réellement actifs et restent équitables ─────────────────────────────

/** Salles tactiques : indice dans le niveau, boss attendu et liste des tactiques de la donnée. */
const TACTICAL_ROOMS = [
  { id: 'veilleurs', index: 2, kind: 'warden' },
  { id: 'vigie', index: 5, kind: 'pyromancer' },
  { id: 'conseil', index: 7, kind: 'forgelord' },
] as const;

/** Sentinelle : interrompt la partie scriptée dès la mesure faite (les salles suivantes ne nous intéressent pas). */
class Stop extends Error {}

interface Fairness {
  revivedAfterMs: number | null;
  /** Défaites collectives dans la salle mesurée. */
  wipes: number;
  /** Durée (ms) pendant laquelle le boss a eu le but « veille » (tactKind 1) après la chute du joueur. */
  guardMs: number;
  /** Durée (ms) pendant laquelle le boss a RÉELLEMENT été posté à l'anneau du joueur à terre (but « veille » ET distance <= GUARD_RING_PX + 14) avant son relevage. */
  postedMs: number;
  /** Plus grand code d'affichage d'un VRAI plan (1 à 6) vu sur le boss pendant la partie ; 7 (déstabilisé) n'est pas un plan. 0 = jamais de plan. */
  maxPlanKind: number;
  /** Délai (ms) entre l'engagement du boss et la chute (toujours après l'échauffement des tactiques et le délai de réaction). */
  fallAfterMs: number;
}

/**
 * Joue la salle tactique `roomIndex` avec les scripts du niveau et FORCE le joueur 1 à terre APRÈS l'échauffement des tactiques (`TACT_WARMUP_MS`) et du délai de réaction
 * (`TACT_REACT_MS`) : les tactiques peuvent donc agir dès la chute (une chute pendant l'échauffement ne prouvait rien). Mesure le temps jusqu'à son relevage (les bots le relèvent
 * seuls : `withRescue`, en ≈ 3 à 8 s) et le temps pendant lequel le boss s'est RÉELLEMENT posté près de lui. Les bots relevant vite, la veille n'a souvent pas le temps de se poster :
 * cela se lit dans le journal (`postée`) ; la preuve d'une veille effectivement exercée (sauveteur tardif, pour les trois sortes de boss) est dans `tacticsFairness.run.test.ts`.
 */
function forcedDown(n: number, roomIndex: number, seed: number): Fairness {
  const run = newLevel8Run(n, { seed, startRoomIndex: roomIndex });
  const roomId = level8.rooms[roomIndex].id;
  const victim = 1 as PlayerId;
  let engagedAt: number | null = null;
  let downedAt: number | null = null;
  let revivedAfterMs: number | null = null;
  let guardMs = 0;
  let postedMs = 0;
  let maxPlanKind = 0;
  let fallAfterMs = 0;
  const orig = run.stepOnce.bind(run);
  (run as { stepOnce: typeof run.stepOnce }).stepOnce = (frames) => {
    const events = orig(frames);
    const boss = run.state.room.enemies.find((e) => (e.data.tact ?? 0) > 0);
    const v = run.state.players[victim];
    if (boss) {
      const k = boss.data.tactKind ?? 0;
      if (k >= 1 && k <= 6) maxPlanKind = Math.max(maxPlanKind, k);
      if (boss.data.engaged && engagedAt === null) engagedAt = run.timeMs;
      if (downedAt !== null && revivedAfterMs === null && k === 1) {
        guardMs += 1000 / 60;
        if (Math.hypot(boss.pos.x - v.pos.x, boss.pos.y - v.pos.y) <= GUARD_RING_PX + 14) postedMs += 1000 / 60;
      }
    }
    if (downedAt === null && engagedAt !== null && run.state.phase === 'playing' && v.status === 'alive') {
      const since = run.timeMs - engagedAt;
      if (since >= TACT_WARMUP_MS + TACT_REACT_MS) {
        if (run.sim.knockDown(victim)) {
          downedAt = run.timeMs;
          fallAfterMs = since;
        }
      }
    } else if (downedAt !== null && revivedAfterMs === null && v.status === 'alive') {
      revivedAfterMs = run.timeMs - downedAt;
      throw new Stop();
    } else if (downedAt !== null && run.timeMs - downedAt > 60000) {
      throw new Stop();
    }
    return events;
  };
  try {
    runLevelScripts(run, level8Scripts(), { maxTotalMs: 20 * MINUTE, maxRoomMs: 240000, maxWipesPerRoom: 4 });
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
  }
  return { revivedAfterMs, wipes: run.stats.rooms.find((r) => r.roomId === roomId)?.wipes ?? 0, guardMs: Math.round(guardMs), postedMs: Math.round(postedMs), maxPlanKind, fallAfterMs: Math.round(fallAfterMs) };
}

describe('niveau 8 : les boss malins sont actifs et leur contre-jeu fonctionne (simulation réelle)', () => {
  for (const room of TACTICAL_ROOMS) {
    it(`${room.id} : le boss (${room.kind}) porte le masque de tactiques de la donnée dès l'entrée dans la salle, à 1 et 4 joueurs`, () => {
      const def = level8.rooms[room.index].enemies.find((e) => e.kind === room.kind);
      expect(def?.tactics?.length ?? 0).toBeGreaterThan(0);
      for (const n of [1, 4]) {
        const run = newLevel8Run(n, { startRoomIndex: room.index });
        run.stepFor(500);
        const boss = run.state.room.enemies.find((e) => e.kind === room.kind);
        expect(boss, `${room.kind} présent à ${n} joueur(s)`).toBeDefined();
        expect(boss?.data.tact).toBe(tacticMask(def?.tactics ?? []));
        // les sbires, eux, n'ont jamais de plan
        for (const e of run.state.room.enemies) if (e.kind !== room.kind) expect(e.data.tact, `${e.kind} sans tactique`).toBeUndefined();
      }
    });
  }

  for (const room of TACTICAL_ROOMS) {
    it(`${room.id} : un allié tombé APRÈS l'échauffement des tactiques est relevé en ≤ 25 s sans défaite collective (2, 3, 4 joueurs, graines 1 à 3), le boss ayant de vrais plans`, () => {
      let sawPlan = 0;
      let posted = 0;
      let total = 0;
      const rows: string[] = [];
      for (const n of [2, 3, 4]) {
        for (const seed of [1, 2, 3]) {
          const o = forcedDown(n, room.index, seed);
          rows.push(`${n}j/g${seed} ${o.revivedAfterMs === null ? 'JAMAIS' : secs(o.revivedAfterMs)} (veille ${secs(o.guardMs)}, postée ${secs(o.postedMs)})`);
          total++;
          if (o.maxPlanKind > 0) sawPlan++;
          if (o.postedMs > 0) posted++;
          // la chute a bien eu lieu APRÈS l'échauffement (sinon la mesure ne prouverait rien)
          expect(o.fallAfterMs, `chute trop tôt (${n} joueurs, graine ${seed})`).toBeGreaterThanOrEqual(TACT_WARMUP_MS + TACT_REACT_MS);
          expect(o.wipes, `défaites collectives (${n} joueurs, graine ${seed})`).toBe(0);
          expect(o.revivedAfterMs, `joueur jamais relevé (${n} joueurs, graine ${seed})`).not.toBeNull();
          expect(o.revivedAfterMs as number, `relevage trop long (${n} joueurs, graine ${seed})`).toBeLessThanOrEqual(25000);
        }
      }
      console.info(`[level8] relevage forcé, ${room.id} (${posted}/${total} parties avec le boss posté à l'anneau) : ${rows.join(' | ')}`);
      // le boss a eu de VRAIS plans (1 à 6, pas seulement « déstabilisé » : code 7) pendant ces parties
      expect(sawPlan, 'le boss malin doit avoir exprimé au moins un vrai plan').toBeGreaterThan(0);
    }, 300_000);
  }
});

// ───────────────────────────── Fosses : l'embuscade ne se contourne pas ─────────────────────────────

describe('niveau 8 : Fosses du Siège — l\'embuscade ne se contourne pas (simulation réelle)', () => {
  it('2 joueurs qui traversent la poterne SANS combattre déclenchent toute l\'embuscade avant de s\'engager dans le rempart', () => {
    const run = newLevel8Run(2, { startRoomIndex: 4 });
    const plate = run.mechTile('fossesPlate');
    // le joueur 0 tient la plaque ; le joueur 1 attend la poterne, puis file droit vers le levier bleu, au fond du rempart
    run.queue(0, goTo(plate), standOn(plate, { until: conds.mechActive('fossesWicket'), maxMs: 600000 }));
    run.queue(1, waitUntil(conds.mechActive('fossesWicket'), 600000, { label: 'poterne ouverte' }), goTo(run.mechTile('fossesLeverBlue'), { tolerance: 8 }));
    const room = run.room;
    const ambush = room.enemies.map((e, i) => ({ e, i })).filter(({ e }) => e.when === 'enter:siege' && (e.minPlayers ?? 1) <= 2);
    expect(ambush.length).toBeGreaterThanOrEqual(10);
    const triggered = (): boolean => ambush.every(({ i }) => run.state.room.spawnedSpawnIdx.includes(i));
    const violations: string[] = [];
    let reachedLever = false;
    // plateforme de départ : on retire les ennemis de la salle centrale (le trajet seul est mesuré) ; les apparitions de l'embuscade sont
    // aussi retirées dès qu'elles surgissent (le plafond d'ennemis vivants ne doit pas retarder le déclenchement)
    for (let i = 0; i < 20 * 60 * 5 && !reachedLever; i++) {
      run.stepFor(200);
      run.state.room.enemies.splice(0);
      for (const p of run.alivePlayers()) {
        const tx = Math.floor(p.pos.x / TILE);
        if (tx >= 54 && !triggered()) violations.push(`J${p.id + 1} en x=${tx} avant le déclenchement de l'embuscade`);
        if (tx >= 70 && !triggered()) violations.push(`J${p.id + 1} à la porte du rempart sans embuscade`);
      }
      const p1 = run.player(1);
      if (Math.hypot(p1.pos.x - (run.mechTile('fossesLeverBlue')[0] + 0.5) * TILE, p1.pos.y - (run.mechTile('fossesLeverBlue')[1] + 0.5) * TILE) < 2 * TILE) reachedLever = true;
      expect(run.failures, `échec d'une action de bot à ${run.timeMs} ms`).toEqual([]);
    }
    expect(reachedLever, 'le levier du rempart doit avoir été atteint').toBe(true);
    expect(violations).toEqual([]);
    expect(triggered(), 'toute l\'embuscade a surgi').toBe(true);
  }, 120_000);
});
