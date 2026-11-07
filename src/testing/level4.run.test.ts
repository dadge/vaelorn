/**
 * Niveau 4 (« Les Cavernes de Givre ») : preuve par la simulation réelle que le niveau est TERMINABLE de bout en bout
 * (`phase === 'levelComplete'`) à 1, 2, 3 et 4 joueurs, avec des bots qui ne produisent que des `ActionFrame`
 * (script de résolution : `level4.solution.ts`). Graine fixe : partie déterministe.
 *
 * Mesure aussi la « durée cible » : temps simulé total entre 5 et 10 minutes à 1, 2, 3 et 4 joueurs (solo compris, défaites
 * collectives comprises), sur plusieurs graines, et vérifie que la statue jumelle reste résoluble après un redémarrage de salle
 * (défaite collective).
 */
import { describe, expect, it } from 'vitest';
import { level4 } from '../levels/level4';
import { conds, formatStats, rotateOtherStatue, runUntil, waitUntil } from './botKit';
import { level4RunOptions, newLevel4Run, solveLevel4 } from './level4.solution';

const MIN_MS = 5 * 60 * 1000;
const MAX_MS = 10 * 60 * 1000;

function secs(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

describe('niveau 4 : terminable de bout en bout (bots, simulation réelle)', () => {
  for (const n of [1, 2, 3, 4]) {
    it(`${n} joueur(s) : niveau terminé, salles validées, objectifs accomplis, durée dans la fenêtre cible`, () => {
      const { run, result } = solveLevel4(n);
      const chars = level4RunOptions(n).characters.join(', ');
      console.info(`\n[level4] ${n} joueur(s) (${chars}) : ${result.completed ? 'TERMINÉ' : 'ÉCHEC'} en ${secs(result.timeMs)} simulées, ${run.stats.wipes} défaite(s) collective(s)`);
      for (const r of run.stats.rooms) {
        const first = run.stats.rooms.indexOf(r) === 0 ? 0 : (run.stats.rooms[run.stats.rooms.indexOf(r) - 1].clearedAtMs ?? 0);
        const dur = r.clearedAtMs === null ? r.timeMs : r.clearedAtMs - first;
        console.info(
          `[level4]   ${String(r.roomIndex + 1)}. ${r.roomId.padEnd(12)} ${secs(dur).padStart(8)}  à terre ${r.downs.reduce((a, b) => a + b, 0)}  défaites ${r.wipes}  PV perdus ${Math.round(r.hpLost.reduce((a, b) => a + b, 0))}`,
        );
      }
      console.info(formatStats(run));
      expect(result.failure, result.failure ?? '').toBeNull();
      expect(result.completed).toBe(true);
      expect(run.state.phase).toBe('levelComplete');
      // Non-régression : aucune action de script échouée, toutes les salles validées, tous les objectifs accomplis.
      expect(run.failures).toEqual([]);
      expect(run.state.clearedRooms).toEqual(level4.rooms.map((r) => r.id));
      expect(run.state.objectives.every((o) => o.done)).toBe(true);
      // Durée cible : 5-10 min à tout effectif, solo compris (le temps des défaites collectives est compris).
      expect(result.timeMs, `durée à ${n} joueur(s)`).toBeGreaterThanOrEqual(MIN_MS);
      expect(result.timeMs, `durée à ${n} joueur(s)`).toBeLessThanOrEqual(MAX_MS);
      // Équité : pas plus de 2 défaites collectives dans une même salle, pas plus de 5 sur le niveau (difficulté normale ; les bots
      // n'utilisent ni esquive intelligente ni spéciaux hors combat de groupe).
      for (const r of run.stats.rooms) expect(r.wipes, `défaites dans ${r.roomId}`).toBeLessThanOrEqual(2);
      expect(run.stats.wipes).toBeLessThanOrEqual(5);
    }, 150_000);
  }

  // La durée dépend du hasard des combats (une défaite collective coûte 40 à 100 s) : on la contrôle sur d'autres graines que la
  // graine de référence, en solo (le cas le plus long) et à 2 joueurs (celui où l'antichambre fait le plus souvent une défaite).
  for (const [n, seeds] of [
    [1, [1, 2, 3, 4]],
    [2, [1, 2, 4]],
  ] as const) {
    it(`${n} joueur(s) : durée entre 5 et 10 min sur les graines ${seeds.join(', ')}`, () => {
      for (const seed of seeds) {
        const { run, result } = solveLevel4(n, { seed });
        expect(result.completed, `graine ${seed} : ${result.failure ?? ''}`).toBe(true);
        expect(run.failures, `graine ${seed}`).toEqual([]);
        expect(result.timeMs, `durée à ${n} joueur(s), graine ${seed} : ${secs(result.timeMs)}`).toBeGreaterThanOrEqual(MIN_MS);
        expect(result.timeMs, `durée à ${n} joueur(s), graine ${seed} : ${secs(result.timeMs)}`).toBeLessThanOrEqual(MAX_MS);
      }
    }, 300_000);
  }

  it('est déterministe : deux parties identiques (2 joueurs, dès la salle des échos) donnent la même durée et les mêmes statistiques', () => {
    const a = solveLevel4(2, { startRoomIndex: 2 });
    const b = solveLevel4(2, { startRoomIndex: 2 });
    expect(a.result.timeMs).toBe(b.result.timeMs);
    expect(JSON.stringify(a.run.stats)).toBe(JSON.stringify(b.run.stats));
  }, 150_000);
});

describe('niveau 4 : la statue jumelle reste résoluble après une défaite collective', () => {
  it("échos (2 joueurs) : une statue tournée, tout le monde à terre → salle recréée, statues d'origine, puis résolution", () => {
    const run = newLevel4Run(2, { startRoomIndex: 2 });
    const pair = level4.rooms[2].mechanisms.find((m) => m.type === 'statuePair');
    if (!pair || pair.type !== 'statuePair') throw new Error('paire attendue');
    // le joueur 0 tourne la statue 1 d'un quart de tour (depuis le socle 0), puis la paire est partiellement tournée
    run.queue(0, rotateOtherStatue('echoPair', 0, { maxMs: 60000 }));
    run.queue(1, waitUntil(() => false, 1e9, { label: 'attente' }));
    const turned = runUntil(
      run,
      (r) => {
        const st = r.mech('echoPair');
        return st.type === 'statuePair' && st.facings[1] !== pair.statues[1].facing;
      },
      60000,
    );
    expect(turned.ok, run.diagnose('statue tournée')).toBe(true);
    // défaite collective : tous à terre
    for (const p of run.sim.state.players) {
      p.hp = 0;
      p.status = 'down';
    }
    const wiped = runUntil(run, (r) => r.stats.wipes >= 1 && r.state.phase === 'playing', 20000);
    expect(wiped.ok, run.diagnose('redémarrage de salle')).toBe(true);
    const st = run.mech('echoPair');
    expect(st.type === 'statuePair' && st.facings).toEqual([pair.statues[0].facing, pair.statues[1].facing]);
    expect(st.active).toBe(false);
    // et la paire se résout normalement ensuite
    run.clearQueue();
    run.queue(0, rotateOtherStatue('echoPair', 0, { maxMs: 90000 }));
    run.queue(1, rotateOtherStatue('echoPair', 1, { maxMs: 90000 }));
    const solved = runUntil(run, conds.mechActive('echoPair'), 120000);
    expect(solved.ok, run.diagnose('paire résolue après redémarrage')).toBe(true);
  }, 100_000);
});
