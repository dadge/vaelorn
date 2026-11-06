/**
 * Preuve par la simulation réelle (createSimulation + bots, ActionFrame uniquement) que le niveau 2 « Le Bosquet Putride »
 * est terminable de bout en bout à 1, 2, 3 et 4 joueurs (difficulté 2, personnages variés). Voir `level2.solution.ts`.
 */
import { describe, expect, it } from 'vitest';
import { effectiveLeverWindowMs } from '../core/mechanisms';
import { level2 } from '../levels/level2';
import { isObjectiveDone } from '../core/objectives';
import { level2Probe, playLevel2, LEVEL2_CHARACTERS } from './level2.solution';

const MAX_MS = 20 * 60 * 1000;
const ROOM_IDS = level2.rooms.map((r) => r.id);

describe('niveau 2 — terminable de bout en bout par les bots', () => {
  for (const n of [1, 2, 3, 4]) {
    it(`${n} joueur(s)`, () => {
      const { run, result } = playLevel2(n);
      const probe = level2Probe(run);
      const spread = probe.leverPressMs.length > 0 ? Math.max(...probe.leverPressMs) - Math.min(...probe.leverPressMs) : 0;
      console.info(
        `=== Niveau 2, ${n} joueur(s) (${LEVEL2_CHARACTERS[n].join(', ')}), difficulté 2 ===\n${result.report}\n` +
          `Échecs d'actions : ${run.failures.length} ; leviers : ${probe.leverPressMs.length} appui(s), écart max ${Math.round(spread)} ms ; ` +
          `runes lues à ${probe.runesHeardAtMs === null ? '?' : (probe.runesHeardAtMs / 1000).toFixed(1)} s, actionnées par ${[...probe.runePressers].map((p) => `J${p + 1}`).join(',')}`,
      );
      expect(result.failure, result.failure ?? '').toBeNull();
      expect(result.completed).toBe(true);
      expect(run.state.phase).toBe('levelComplete');
      expect(result.timeMs).toBeLessThan(MAX_MS);
      // Non-régression : aucune action de script échouée, toutes les salles validées, tous les objectifs accomplis.
      expect(run.failures).toEqual([]);
      for (const id of ROOM_IDS) expect(run.stats.rooms.find((r) => r.roomId === id)?.clearedAtMs, `salle ${id} validée`).not.toBeNull();
      for (const o of level2.objectives) expect(isObjectiveDone(run.state.objectives, o.id), `objectif ${o.id}`).toBe(true);
      // Pas de défaite collective répétée : le niveau reste équitable pour des bots solides (au plus 1 au total).
      expect(run.stats.wipes).toBeLessThanOrEqual(1);
      // Leviers : actionnés dans la fenêtre effective (agrandie à n joueurs) — tous les leviers non neutralisés sont enclenchés.
      const lever = level2.rooms[1].mechanisms.find((m) => m.type === 'lever');
      if (lever && lever.type === 'lever') {
        expect(effectiveLeverWindowMs(level2.rooms[1], n, lever)).toBeGreaterThanOrEqual(12000);
        expect(spread).toBeLessThan(effectiveLeverWindowMs(level2.rooms[1], n, lever));
      }
      // Runes : à plusieurs joueurs, la séquence n'a été lue qu'à l'autel (vision partagée) puis actionnée par plusieurs joueurs.
      expect(probe.runesHeardAtMs).not.toBeNull();
      if (n > 1) expect(probe.runePressers.size).toBeGreaterThan(1);
    }, 120000);
  }

  it('robustesse : autres graines (2 par nombre de joueurs)', () => {
    for (const n of [1, 2, 3, 4]) {
      for (const seed of [101, 202]) {
        const { run, result } = playLevel2(n, { seed });
        expect(result.failure, `n=${n} seed=${seed}\n${result.failure ?? ''}`).toBeNull();
        expect(run.state.phase).toBe('levelComplete');
        expect(result.timeMs).toBeLessThan(MAX_MS);
      }
    }
  }, 120000);
});
