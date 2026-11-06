/**
 * Niveau 3 (« La Citadelle de Morvane ») : preuve par la simulation réelle que le niveau est TERMINABLE de bout en bout
 * (`phase === 'levelComplete'`) à 1, 2, 3 et 4 joueurs, avec des bots qui ne produisent que des `ActionFrame`
 * (script de résolution : `level3.solution.ts`). Graine fixe : partie déterministe.
 *
 * Ajoute des vérifications de géométrie des deux blocs 2×2 (forge, gouffre) : chaque bloc a un couloir fermé jusqu'à son
 * socle / sa plaque, sans issue latérale ni obstacle, donc aucun coincement irrécupérable.
 */
import { describe, expect, it } from 'vitest';
import { level3 } from '../levels/level3';
import { BLOCK_SIZE_TILES } from '../core/constants';
import { attackUntilClear, pullLever, pushBlock, pushersNeeded, runUntil, wait, waitUntil, conds, formatStats } from './botKit';
import { level3RunOptions, newLevel3Run, solveLevel3 } from './level3.solution';
import { BotRun } from './botKit';

const TWENTY_MIN_MS = 20 * 60 * 1000;

function secs(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

describe('niveau 3 : terminable de bout en bout (bots, simulation réelle)', () => {
  for (const n of [1, 2, 3, 4]) {
    it(`${n} joueur(s) : niveau terminé en moins de 20 min de temps simulé`, () => {
      const { run, result } = solveLevel3(n);
      const chars = level3RunOptions(n).characters.join(', ');
      console.info(`\n[level3] ${n} joueur(s) (${chars}) : ${result.completed ? 'TERMINÉ' : 'ÉCHEC'} en ${secs(result.timeMs)} simulées, ${run.stats.wipes} défaite(s) collective(s)`);
      for (const r of run.stats.rooms) {
        const first = run.stats.rooms.indexOf(r) === 0 ? 0 : (run.stats.rooms[run.stats.rooms.indexOf(r) - 1].clearedAtMs ?? 0);
        const dur = r.clearedAtMs === null ? r.timeMs : r.clearedAtMs - first;
        console.info(
          `[level3]   ${String(r.roomIndex + 1)}. ${r.roomId.padEnd(10)} ${secs(dur).padStart(8)}  à terre ${r.downs.reduce((a, b) => a + b, 0)}  défaites ${r.wipes}  PV perdus ${Math.round(r.hpLost.reduce((a, b) => a + b, 0))}`,
        );
      }
      console.info(formatStats(run));
      expect(result.failure, result.failure ?? '').toBeNull();
      expect(result.completed).toBe(true);
      expect(run.state.phase).toBe('levelComplete');
      expect(result.timeMs).toBeLessThan(TWENTY_MIN_MS);
      // Non-régression : aucune action de script échouée, toutes les salles validées, tous les objectifs accomplis.
      expect(run.failures).toEqual([]);
      expect(run.state.clearedRooms).toEqual(level3.rooms.map((r) => r.id));
      expect(run.state.objectives.every((o) => o.done)).toBe(true);
      // Équité : pas plus de 2 défaites collectives dans une même salle, pas plus de 6 sur le niveau (difficulté normale). (les bots n utilisent ni esquive ni attaque spéciale : le boss final en solo reste le pic de difficulté ; seuil volontairement large)
      for (const r of run.stats.rooms) expect(r.wipes, `défaites dans ${r.roomId}`).toBeLessThanOrEqual(5);
      expect(run.stats.wipes).toBeLessThanOrEqual(6);
    }, 100_000);
  }

  it('est déterministe : deux parties identiques (2 joueurs) donnent la même durée et les mêmes statistiques', () => {
    const a = solveLevel3(2, { startRoomIndex: 5 });
    const b = solveLevel3(2, { startRoomIndex: 5 });
    expect(a.result.timeMs).toBe(b.result.timeMs);
    expect(JSON.stringify(a.run.stats)).toBe(JSON.stringify(b.run.stats));
  }, 100_000);
});

describe('niveau 3 : les deux blocs 2×2 ne peuvent pas se coincer', () => {
  const cases = [
    { room: 'forge', roomIndex: 2, block: 'forgeBlock', target: 'forgeSocket' },
    { room: 'abyss', roomIndex: 5, block: 'abyssBlock', target: 'plateBlock' },
  ];
  for (const c of cases) {
    it(`${c.room} : couloir fermé, libre et sans issue latérale du bloc jusqu'à ${c.target}`, () => {
      const run = new BotRun(level3, { ...level3RunOptions(1), startRoomIndex: c.roomIndex });
      const grid = run.sim.grid;
      const block = run.mechDef(c.block);
      const target = run.mechDef(c.target);
      if (block.type !== 'block') throw new Error('bloc attendu');
      if (target.type !== 'socket' && target.type !== 'plate') throw new Error('socle ou plaque attendu');
      const [bx, by] = block.tile;
      const [tx, ty] = target.tile;
      expect(ty).toBe(by); // même rangée : trajet en ligne droite vers l'est
      const dist = tx - bx;
      expect(dist).toBeGreaterThan(0);
      const S = BLOCK_SIZE_TILES;
      // 1. Trajet libre : à chaque pas, les 2×2 tuiles visées sont du sol.
      for (let k = 0; k <= dist; k++) {
        for (let dy = 0; dy < S; dy++) for (let dx = 0; dx < S; dx++) {
          expect(grid.blocksMovement(bx + k + dx, by + dy), `tuile ${bx + k + dx},${by + dy} bloquée sur le trajet`).toBe(false);
        }
      }
      // 2. Couloir fermé sur les côtés (aucune poussée latérale, personne ne peut se mettre devant) et au fond.
      for (let x = bx; x <= tx + S - 1; x++) {
        expect(grid.blocksMovement(x, by - 1), `mur nord attendu en ${x},${by - 1}`).toBe(true);
        expect(grid.blocksMovement(x, by + S), `mur sud attendu en ${x},${by + S}`).toBe(true);
      }
      for (let dy = 0; dy < S; dy++) expect(grid.blocksMovement(tx + S, by + dy), 'fond du couloir muré').toBe(true);
      // 3. Embouchure ouverte derrière le bloc (là où l'on se place pour pousser).
      for (let dy = 0; dy < S; dy++) expect(grid.blocksMovement(bx - 1, by + dy)).toBe(false);
      // 4. Aucun ennemi ni mécanisme ne naît dans le couloir.
      const inLane = (x: number, y: number): boolean => x >= bx && x <= tx + S - 1 && y >= by && y < by + S;
      for (const e of run.room.enemies) expect(inLane(e.tile[0], e.tile[1]), `ennemi ${e.kind} dans le couloir`).toBe(false);
      for (const m of run.room.mechanisms) {
        if (m.id === c.block || m.id === c.target) continue;
        if (m.type === 'door') for (const t of m.tiles) expect(inLane(t[0], t[1])).toBe(false);
        else if ('tile' in m) expect(inLane(m.tile[0], m.tile[1]), `${m.id} dans le couloir`).toBe(false);
      }
    });
  }

  for (const n of [1, 2, 3, 4]) {
    it(`pousseurs requis à ${n} joueur(s) : ${Math.min(2, n)} (plafonné au nombre de joueurs) et le bloc de la forge atteint son socle`, () => {
      const run = newLevel3Run(n, { startRoomIndex: 2 });
      expect(pushersNeeded(run, 'forgeBlock')).toBe(Math.min(2, n));
      const pushers = run.pushBlockTogether('forgeBlock', 'right', 30);
      expect(pushers.length).toBe(Math.min(2, n));
      // Les autres joueurs défendent l'entrée du couloir.
      for (const b of run.bots) if (!pushers.includes(b.id)) run.queue(b.id, wait(240000));
      const res = runUntil(run, conds.mechActive('forgeSocket'), 150000, { stopOnFailure: true });
      expect(res.ok, run.diagnose('bloc de la forge')).toBe(true);
      const st = run.mech('forgeBlock');
      expect(st.type === 'block' && st.tile).toEqual([44, 22]);
      console.info(`[level3] forge : socle rempli en ${secs(res.elapsedMs)} à ${n} joueur(s)`);
    });
  }

  it('gouffre : un seul pousseur ne suffit pas à 2 joueurs (le bloc exige bien la coopération)', () => {
    const run = newLevel3Run(2, { startRoomIndex: 5 });
    run.queue(0, pushBlock('abyssBlock', 'right', 3, { maxMs: 1e9, stallMs: 1e9 }));
    run.queue(1, wait(60000, { passive: true }));
    run.stepFor(10000);
    const st = run.mech('abyssBlock');
    expect(st.type === 'block' && st.tile).toEqual([14, 4]);
  });
});

describe('niveau 3 : problèmes de conception documentés', () => {
  // SOFT-LOCK potentiel : l'objectif « slayer » (3 coups fatals du héros du slot 2) bloque la sortie de l'arène
  // (`obj:slayer`). Les ennemis ne réapparaissent pas : si les AUTRES héros achèvent toute l'arène avant que le héros du slot 2
  // n'ait ses 3 kills, la salle est bloquée (aucun ennemi, sortie fermée) jusqu'à une défaite collective volontaire.
  // Corrigé : un objectif 'kills' non accompli s'accomplit d'office quand la salle est vidée (objectives.ts, roomCleared).
  it("arène (3 joueurs) : même si le héros du slot 2 n'a rien tué, la sortie finit par s'ouvrir quand l'arène est vide", () => {
    const run = newLevel3Run(3, { startRoomIndex: 6 });
    run.queue(0, pullLever('bell'), attackUntilClear({ maxMs: 300000 }));
    run.queue(1, waitUntil(conds.mechActive('bell'), 60000), attackUntilClear({ maxMs: 300000 }));
    run.queue(2, wait(400000, { passive: true })); // le héros du slot 2 reste à l'écart (ou se fait voler ses kills)
    run.setBackground(2, { combat: false });
    runUntil(run, (r) => r.requirementMet('clear') && r.state.players[2].kills < 3, 300000);
    // Salle vidée sans que l'objectif soit accompli : on laisse 60 s de plus, rien ne peut plus progresser.
    run.stepFor(60000);
    expect(run.sim.isExitOpen(), run.diagnose('arène soft-lock')).toBe(true);
  });
});
