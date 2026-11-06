/**
 * Preuve par simulation que le niveau 1 est TERMINABLE de bout en bout à 1, 2, 3 et 4 joueurs (bots + `ActionFrame` uniquement,
 * aucune écriture dans `sim.state`). Voir `level1.solution.ts` pour la stratégie coopérative.
 *
 * Contenu :
 *  - parcours complet à 1..4 joueurs (graine fixe, difficulté 2, personnages solides) avec statistiques par salle (console.info) ;
 *  - balayage de graines et de personnages (dont le plus fragile en solo) ;
 *  - déterminisme ;
 *  - ossuaire : l'objectif `o_kills` (slot 3) ne se verrouille pas quand son propriétaire combat ; mais il SE VERROUILLE quand le
 *    propriétaire ne tue rien (comportement documenté dans le rapport — `it.fails` du comportement souhaité).
 */
import { describe, expect, it } from 'vitest';
import { level1 } from '../levels/level1';
import { isObjectiveDone } from '../core/objectives';
import type { PlayerId } from '../core/types';
import { BotRun, conds, pullLever, runLevelScripts, runUntil, wait, waitUntil, type LevelRunResult } from './botKit';
import { clearRoom, level1Scripts, newLevel1Run } from './level1.solution';

const MAX_TOTAL_MS = 20 * 60_000;
/** Délai vitest par test (le temps réel varie selon la charge machine ; le temps SIMULÉ est borné par ailleurs). */
const T = 110_000;
/** Résultats des parcours principaux (graine 7), réutilisés par le test de déterminisme. */
const MAIN = new Map<number, { timeMs: number; stats: string }>();
/** Cible de non-régression : le niveau est annoncé à ~7 min ; la résolution parfaite des bots doit rester en dessous. */
const REGRESSION_MS = 8 * 60_000;

function play(n: number, opts: Parameters<typeof newLevel1Run>[2] = {}): { run: BotRun; res: LevelRunResult } {
  const run = newLevel1Run(level1, n, opts);
  const res = runLevelScripts(run, level1Scripts(), { maxTotalMs: MAX_TOTAL_MS, maxRoomMs: 300000 });
  return { run, res };
}

function expectCompleted(run: BotRun, res: LevelRunResult): void {
  expect(res.failure, res.failure ?? '').toBeNull();
  expect(res.completed).toBe(true);
  expect(run.state.phase).toBe('levelComplete');
  expect(run.failures).toEqual([]);
  expect(run.state.objectives.every((o) => o.done)).toBe(true);
  expect(run.state.clearedRooms).toEqual(level1.rooms.map((r) => r.id));
  expect(res.timeMs).toBeLessThan(MAX_TOTAL_MS);
}

describe('niveau 1 : terminable de bout en bout', () => {
  for (const n of [1, 2, 3, 4]) {
    it(`${n} joueur(s) : niveau terminé en < 20 min simulées (graine 7)`, () => {
      const { run, res } = play(n);
      console.info(`[niveau 1 / ${n} joueur(s)] ${res.completed ? 'TERMINÉ' : 'ÉCHEC'} en ${(res.timeMs / 1000).toFixed(1)} s simulées\n${res.report}`);
      expectCompleted(run, res);
      // Non-régression d'équilibrage : durée raisonnable, jamais de défaite collective avec des héros solides.
      expect(res.timeMs).toBeLessThan(REGRESSION_MS);
      expect(run.stats.wipes).toBe(0);
      for (const room of run.stats.rooms) expect(room.clearedAtMs, `salle ${room.roomId} validée`).not.toBeNull();
      MAIN.set(n, { timeMs: res.timeMs, stats: JSON.stringify(res.stats) });
    }, T);
  }

  it('autre graine (11) à 1..4 joueurs : toujours terminé, jamais de défaite collective', () => {
    for (const n of [1, 2, 3, 4]) {
      const { run, res } = play(n, { seed: 11 });
      expectCompleted(run, res);
      expect(run.stats.wipes, `n=${n} seed=11`).toBe(0);
    }
  }, T);

  it('personnages fragiles (Sandrine solo ; Sandrine/Mira/Valentine/Aelith à 4) : terminé, au plus quelques défaites collectives', () => {
    const solo = play(1, { characters: ['sandrine'], seed: 2 });
    expectCompleted(solo.run, solo.res);
    expect(solo.run.stats.wipes).toBeLessThanOrEqual(2);
    const four = play(4, { characters: ['sandrine', 'mira', 'valentine', 'aelith'], seed: 2 });
    expectCompleted(four.run, four.res);
    expect(four.run.stats.wipes).toBeLessThanOrEqual(1);
  }, T);

  it('déterministe : mêmes options et même graine (7) ⇒ mêmes durée et statistiques que le parcours principal', () => {
    const ref = MAIN.get(2);
    const again = play(2);
    expect(again.res.completed).toBe(true);
    if (ref) {
      expect(again.res.timeMs).toBe(ref.timeMs);
      expect(JSON.stringify(again.res.stats)).toBe(ref.stats);
    } else {
      expect(again.res.timeMs).toBe(play(2).res.timeMs);
    }
  }, T);
});

describe('niveau 1 : ossuaire, objectif o_kills (slot 3)', () => {
  /**
   * Joue l'ossuaire seul (salle d'index 3). Le propriétaire de `o_kills` reste PASSIF (loin de l'arène : un joueur absent, occupé
   * ou à terre) ; les autres vainquent TOUT. Retourne si `clear` a été atteint, si l'objectif est accompli et la phase finale.
   */
  function ownerIdle(n: number): { clear: boolean; done: boolean; phase: string; exitOpen: boolean } {
    const run = newLevel1Run(level1, n, { startRoomIndex: 3 });
    const owner = run.playerFor(3);
    const lever = (run.playerFor(0) === owner ? (owner + 1) % n : run.playerFor(0)) as PlayerId;
    run.queue(lever, pullLever('lv4'), clearRoom());
    for (let i = 0; i < n; i++) {
      const id = i as PlayerId;
      if (id === owner) run.queue(id, wait(900000, { passive: true }));
      else if (id !== lever) run.queue(id, waitUntil(conds.mechActive('lv4'), 120000), clearRoom());
    }
    const r = runUntil(run, conds.requirements(['clear']), 400000);
    run.stepFor(30000);
    return {
      clear: r.ok,
      done: isObjectiveDone(run.state.objectives, 'o_kills'),
      phase: run.state.phase,
      exitOpen: run.sim.isExitOpen(),
    };
  }

  it('propriétaire actif (comportement naïf : tout le monde chasse) : l’objectif s’accomplit à 1..4 joueurs sur 6 graines', () => {
    const ossuaryScript = level1Scripts({ ossuaryPolicy: 'natural' }).find((sc) => sc.roomId === 'ossuary');
    if (!ossuaryScript) throw new Error('script ossuary introuvable');
    for (const n of [1, 2, 3, 4]) {
      for (const seed of [1, 2, 3, 4, 5, 6]) {
        const run = newLevel1Run(level1, n, { seed, startRoomIndex: 3 });
        ossuaryScript.build(run, { room: run.room, roomIndex: run.roomIndex, attempt: 0, restart: false });
        const r = runUntil(run, conds.roomReached(4), 300_000);
        expect(r.ok, `ossuaire franchie n=${n} seed=${seed}
${run.diagnose('ossuaire')}`).toBe(true);
        expect(isObjectiveDone(run.state.objectives, 'o_kills'), `o_kills n=${n} seed=${seed}`).toBe(true);
        expect(run.stats.wipes, `défaite collective n=${n} seed=${seed}`).toBe(0);
      }
    }
  }, T);

  for (const n of [2, 3, 4]) {
    // Corrigé : un objectif 'kills' non accompli s'accomplit d'office quand la salle est vidée (objectives.ts, roomCleared).
    it(`ANTI-VERROU (${n} joueurs) : l'ossuaire ne se verrouille jamais, même si le propriétaire de o_kills ne tue rien`, () => {
      const r = ownerIdle(n);
      expect(r.clear).toBe(true);
      expect(r.exitOpen).toBe(true);
    });
  }
});
