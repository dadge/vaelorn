/**
 * BALAYAGE DE GRAINES des fenêtres de durée des niveaux 7 à 9 (bots, simulation réelle, difficulté 2) : 1 joueur et 2 joueurs sur les graines 1 à 6 (les cas les plus longs, où une
 * graine isolée avait mesuré hors fenêtre), 3 et 4 joueurs sur les graines 1 à 3. Chaque partie doit être terminée, durer entre 5 min et le plafond de `durationWindows.ts`, et rester
 * équitable (≤ 2 défaites collectives par salle, ≤ 5 au total). Les fenêtres sont MESURÉES (pas souhaitées) : voir `durationWindows.ts` et TODO.md « Marges de durée ».
 */
import { describe, expect, it } from 'vitest';
import { DUO_CAP_MS, MIN_DURATION_MS, SWEEP_SEEDS, durationCapMs } from './durationWindows';
import { solveLevel7 } from './level7.solution';
import { solveLevel8 } from './level8.solution';
import { solveLevel9 } from './level9.solution';
import type { BotRun, LevelRunResult } from './botKit';

type Solve = (n: number, opts: { seed?: number }) => { run: BotRun; result: LevelRunResult };
const SOLVERS: Record<7 | 8 | 9, Solve> = { 7: solveLevel7, 8: solveLevel8, 9: solveLevel9 };

const secs = (ms: number): string => `${(ms / 1000).toFixed(0)} s`;

describe('durées des niveaux 7 à 9 : balayage de graines', () => {
  for (const level of [7, 8, 9] as const) {
    for (const n of [1, 2, 3, 4]) {
      it(`niveau ${level}, ${n} joueur(s) : graines ${SWEEP_SEEDS[n].join(', ')} terminées dans la fenêtre mesurée (≤ ${(durationCapMs(level, n) / 60000).toFixed(1)} min), équitables`, () => {
        const rows: string[] = [];
        for (const seed of SWEEP_SEEDS[n]) {
          const { run, result } = SOLVERS[level](n, { seed });
          rows.push(`g${seed} ${secs(result.timeMs)} (${run.stats.wipes} déf.)`);
          expect(result.completed, `graine ${seed} : ${result.failure ?? ''}`).toBe(true);
          expect(result.timeMs, `graine ${seed} trop courte`).toBeGreaterThanOrEqual(MIN_DURATION_MS);
          expect(result.timeMs, `graine ${seed} hors fenêtre`).toBeLessThanOrEqual(durationCapMs(level, n));
          for (const r of run.stats.rooms) expect(r.wipes, `graine ${seed} : défaites dans ${r.roomId}`).toBeLessThanOrEqual(2);
          expect(run.stats.wipes, `graine ${seed} : défaites totales`).toBeLessThanOrEqual(5);
        }
        console.info(`[durées] niveau ${level}, ${n} joueur(s) : ${rows.join(', ')}`);
      }, 600_000);
    }
  }

  it('le duo a une fenêtre propre (10,5 min) : plus large que celle de 3-4 joueurs, plus étroite que celle du solo', () => {
    for (const level of [7, 8, 9] as const) {
      expect(durationCapMs(level, 2)).toBe(DUO_CAP_MS);
      expect(durationCapMs(level, 2)).toBeGreaterThan(durationCapMs(level, 3));
      expect(durationCapMs(level, 1)).toBeGreaterThan(durationCapMs(level, 2));
    }
  });
});
