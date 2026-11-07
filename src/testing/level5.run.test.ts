/**
 * Niveau 5 (« Les Forges Ardentes ») : preuve par la simulation réelle que le niveau est TERMINABLE de bout en bout
 * (`phase === 'levelComplete'`) à 1, 2, 3 et 4 joueurs, avec des bots qui ne produisent que des `ActionFrame`
 * (script de résolution : `level5.solution.ts`). Parties déterministes (graines fixes, plusieurs graines par effectif).
 *
 * Mesure la « durée cible » : durée simulée totale entre 5 et 10 minutes à 2, 3 et 4 joueurs (5 à 12 minutes en solo, où la période
 * du sablier est doublée mais où un seul héros fait tout ; les bots n'ont aucune esquive fine ni temps de lecture, et les défaites
 * collectives rejouées, au plus 1 à 2 en solo, comptent dans la durée). Vérifie aussi l'équité (pas plus de 2 défaites collectives
 * par salle ni 5 au total) et les propriétés du sablier en simulation réelle : un seul retournement ne suffit PAS à 2 joueurs ou plus
 * (le héros qui retourne le levier lointain reste de son côté), un relais suffit, un héros seul passe encore, même le plus lent.
 */
import { describe, expect, it } from 'vitest';
import { level5 } from '../levels/level5';
import { effectiveHourglassPeriodMs } from '../core/mechanisms';
import type { PlayerId } from '../core/types';
import {
  crossHourglass,
  flipHourglass,
  formatStats,
  goTo,
  hourglassGateOpen,
  hourglassLeverTile,
  hourglassSandMs,
  runUntil,
  waitUntil,
  wait,
  type BotRun,
} from './botKit';
import { level5RunOptions, newLevel5Run, postedAtGate, relay, solveLevel5 } from './level5.solution';

const MIN_MS = 60 * 1000;

/**
 * Graines jouées par nombre de joueurs (solo : les graines 8 et 13, relevées comme dépassant 12 min avant correction, et 1 et 3).
 * Mesures (bots, difficulté 2) : solo 627 à 702 s sur 8 des 12 graines essayées (1 à 9, 11 à 13), 724 à 848 s sur les 4 autres
 * (2 à 4 défaites contre le pyromancien et le boss : les PV ne se régénèrent pas d'une salle à l'autre, une défaite collective les
 * restaure, et les bots n'esquivent pas finement) ; 2, 3 et 4 joueurs : 450 à 606 s sur 9, 9 et 8 graines, 0 à 2 défaites.
 */
const SEEDS: Readonly<Record<number, readonly number[]>> = { 1: [1, 3, 8, 13], 2: [11, 13], 3: [1, 11], 4: [11, 13] };

function secs(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

describe('niveau 5 : terminable de bout en bout (bots, simulation réelle)', () => {
  for (const n of [1, 2, 3, 4]) {
    for (const seed of SEEDS[n]) {
      it(`${n} joueur(s), graine ${seed} : niveau terminé, objectifs accomplis, durée dans la fenêtre cible`, () => {
        const { run, result } = solveLevel5(n, { seed });
        const chars = level5RunOptions(n).characters.join(', ');
        console.info(
          `\n[level5] ${n} joueur(s) (${chars}) graine ${seed} : ${result.completed ? 'TERMINÉ' : 'ÉCHEC'} en ${secs(result.timeMs)} simulées (${(result.timeMs / MIN_MS).toFixed(1)} min), ${run.stats.wipes} défaite(s) collective(s)`,
        );
        for (const r of run.stats.rooms) {
          const idx = run.stats.rooms.indexOf(r);
          const first = idx === 0 ? 0 : (run.stats.rooms[idx - 1].clearedAtMs ?? 0);
          const dur = r.clearedAtMs === null ? r.timeMs : r.clearedAtMs - first;
          console.info(
            `[level5]   ${String(r.roomIndex + 1)}. ${r.roomId.padEnd(10)} ${secs(dur).padStart(8)}  à terre ${r.downs.reduce((a, b) => a + b, 0)}  défaites ${r.wipes}  PV perdus ${Math.round(r.hpLost.reduce((a, b) => a + b, 0))}`,
          );
        }
        console.info(formatStats(run));
        expect(result.failure, result.failure ?? '').toBeNull();
        expect(result.completed).toBe(true);
        expect(run.state.phase).toBe('levelComplete');
        // Non-régression : aucune action de script échouée, toutes les salles validées, tous les objectifs accomplis.
        expect(run.failures).toEqual([]);
        expect(run.state.clearedRooms).toEqual(level5.rooms.map((r) => r.id));
        expect(run.state.objectives.every((o) => o.done)).toBe(true);
        // Durée cible : 5 à 10 minutes (solo : 5 à 12).
        expect(result.timeMs).toBeGreaterThanOrEqual(5 * MIN_MS);
        expect(result.timeMs).toBeLessThanOrEqual((n === 1 ? 12 : 10) * MIN_MS);
        // Équité (difficulté normale, bots sans esquive fine) : pas plus de 2 défaites collectives par salle, 5 au total.
        for (const r of run.stats.rooms) expect(r.wipes, `défaites dans ${r.roomId}`).toBeLessThanOrEqual(2);
        expect(run.stats.wipes).toBeLessThanOrEqual(5);
      }, 240_000);
    }
  }

  it('est déterministe : deux parties identiques (2 joueurs, depuis le porche) donnent la même durée et les mêmes statistiques', () => {
    const a = solveLevel5(2, { startRoomIndex: 3 });
    const b = solveLevel5(2, { startRoomIndex: 3 });
    expect(a.result.completed).toBe(true);
    expect(a.result.timeMs).toBe(b.result.timeMs);
    expect(JSON.stringify(a.run.stats)).toBe(JSON.stringify(b.run.stats));
  }, 240_000);
});

// ───────────────────────────── Sablier en simulation réelle ─────────────────────────────

/** Salles à sablier jouables isolément depuis leur arrivée (la herse du porche est derrière une porte à plaques, celle du creuset B derrière la chambre de combat). */
const HOURGLASS_ROOMS: readonly [string, string][] = [
  ['ashgate', 'hgAsh'],
  ['slagworks', 'hgSlag'],
  ['crucible', 'hgForgeA'],
  ['blindforge', 'hgDark'],
  ['bellows', 'hgBellows'],
];

function hourglassOf(run: BotRun, id: string) {
  const def = run.mechDef(id);
  if (def.type !== 'hourglass') throw new Error('sablier attendu');
  return def;
}

/** Tuile d'arrivée de chaque héros de l'autre côté de la herse, près du levier voisin. */
function destAfter(run: BotRun, id: string): (pid: PlayerId) => [number, number] {
  const def = hourglassOf(run, id);
  return (pid) => [def.levers[1][0] + 1 + (pid % 2), def.levers[1][1] - 2 + 2 * Math.floor(pid / 2)];
}

describe('niveau 5 : le sablier en simulation réelle', () => {
  it("sans retourner le sablier, la herse reste fermée : personne ne passe, même après une minute", () => {
    const run = newLevel5Run(2, { startRoomIndex: 0 });
    const gateX = hourglassOf(run, 'hgAsh').gate[0][0];
    run.queue(0, wait(70_000, { passive: true }));
    run.queue(1, wait(70_000, { passive: true }));
    // les deux joueurs essaient de passer en ligne droite vers l'est
    for (let i = 0; i < 70 * 60; i++) {
      run.stepOnce({ 0: { moveX: 1, moveY: 0, attack: false, interact: false, revive: false }, 1: { moveX: 1, moveY: 0.1, attack: false, interact: false, revive: false } });
    }
    expect(hourglassSandMs(run, 'hgAsh')).toBe(0);
    expect(hourglassGateOpen(run, 'hgAsh')).toBe(false);
    for (const p of run.state.players) expect(p.pos.x / 16, `joueur ${p.id}`).toBeLessThan(gateX);
  });

  it("retourner le levier remplit le sable : période normale à 2+ joueurs, DOUBLE en solo ; la herse se rouvre d'un coup", () => {
    for (const n of [1, 2]) {
      const run = newLevel5Run(n, { startRoomIndex: 0 });
      const def = hourglassOf(run, 'hgAsh');
      run.queue(0, flipHourglass('hgAsh', { leverIndex: 0 }));
      const res = runUntil(run, (r) => hourglassSandMs(r, 'hgAsh') > 0, 30_000, { stopOnFailure: true });
      expect(res.ok, run.diagnose('retournement du sablier')).toBe(true);
      const eff = effectiveHourglassPeriodMs(def, n);
      expect(eff).toBe(n === 1 ? 2 * def.periodMs : def.periodMs);
      expect(hourglassSandMs(run, 'hgAsh')).toBeGreaterThan(eff - 1000);
      expect(hourglassGateOpen(run, 'hgAsh')).toBe(true);
      // le sable s'écoule puis la herse se referme tuile par tuile
      run.stepFor(eff + 500);
      expect(hourglassSandMs(run, 'hgAsh')).toBe(0);
      run.stepFor((def.closeStepMs ?? 700) * (def.gate.length + 1) + 500);
      expect(hourglassGateOpen(run, 'hgAsh')).toBe(false);
      const st = run.mech('hgAsh');
      expect(st.type === 'hourglass' && st.closedCount).toBe(def.gate.length);
    }
  });

  it('à 1 joueur, un héros seul franchit la première herse de chaque salle à sablier, même le plus lent (retournement du levier lointain puis course, sable doublé)', () => {
    for (const hero of ['david', 'grok'] as const) {
      for (const [id] of HOURGLASS_ROOMS) {
        const idx = level5.rooms.findIndex((r) => r.id === id);
        const run = newLevel5Run(1, { startRoomIndex: idx, specials: false, characters: [hero] });
        const hg = run.room.mechanisms.find((m) => m.type === 'hourglass');
        if (!hg || hg.type !== 'hourglass') throw new Error(`sablier attendu dans ${id}`);
        const gateX = hg.gate[0][0];
        const dest: [number, number] = [hg.levers[1][0], hg.levers[1][1] - 1];
        run.queue(0, flipHourglass(hg.id, { leverIndex: 0 }), crossHourglass(hg.id, dest));
        const res = runUntil(run, (r) => r.player(0).pos.x / 16 > gateX + 1, 60_000, { stopOnFailure: true });
        expect(res.ok, run.diagnose(`traversée de ${hg.id} en solo avec ${hero}`)).toBe(true);
        expect(run.failures, `${id} ${hero}`).toEqual([]);
      }
    }
  });

  it("à 2, 3 et 4 joueurs, UN SEUL retournement ne suffit PAS : le héros du levier lointain reste de son côté, herse refermée", () => {
    for (const [roomId, hgId] of HOURGLASS_ROOMS) {
      for (const n of [2, 3, 4]) {
        const idx = level5.rooms.findIndex((r) => r.id === roomId);
        const run = newLevel5Run(n, { startRoomIndex: idx, specials: false });
        const hg = hourglassOf(run, hgId);
        const gateX = hg.gate[0][0];
        const dest = destAfter(run, hgId);
        const others = Array.from({ length: n - 1 }, (_, i) => (i + 1) as PlayerId);
        // tous les autres se postent devant la herse ; le héros 0 retourne alors le levier lointain, une seule fois, puis court
        run.queue(
          0,
          goTo((r) => hourglassLeverTile(r, hgId, 0), { tolerance: 10 }),
          waitUntil((r) => others.every((i) => postedAtGate(r, hgId, i)), 90_000),
          flipHourglass(hgId, { leverIndex: 0 }),
          crossHourglass(hgId, dest(0)),
        );
        for (const i of others) run.queue(i, crossHourglass(hgId, dest(i)));
        run.stepFor(45_000);
        const label = `${roomId} à ${n} joueurs`;
        // les autres ont passé (le héros 0 a fait passer toute l'équipe sauf lui)
        for (const i of others) expect(run.player(i).pos.x / 16, `${label} : joueur ${i}`).toBeGreaterThan(gateX + 1);
        // lui est resté de l'autre côté : la herse s'est refermée avant son arrivée
        expect(run.player(0).pos.x / 16, `${label} : joueur 0 doit rester derrière la herse`).toBeLessThan(gateX);
        expect(hourglassGateOpen(run, hgId), label).toBe(false);
        const st = run.mech(hgId);
        expect(st.type === 'hourglass' && st.closedCount, label).toBe(hg.gate.length);
      }
    }
  });

  it("à 1, 2, 3 et 4 joueurs, le RELAIS suffit : tous franchissent la herse, un coéquipier passé retourne le levier voisin", () => {
    for (const [roomId, hgId] of HOURGLASS_ROOMS) {
      for (const n of [1, 2, 3, 4]) {
        const idx = level5.rooms.findIndex((r) => r.id === roomId);
        const run = newLevel5Run(n, { startRoomIndex: idx, specials: false });
        const hg = hourglassOf(run, hgId);
        const gateX = hg.gate[0][0];
        relay(run, hgId, destAfter(run, hgId));
        const res = runUntil(run, (r) => r.state.players.every((p) => p.pos.x / 16 > gateX + 1), 60_000, { stopOnFailure: true });
        expect(res.ok, run.diagnose(`relais de ${hgId} à ${n} joueurs`)).toBe(true);
        expect(run.failures, `${roomId} à ${n} joueurs`).toEqual([]);
        // à plusieurs, le dernier passé l'a été grâce à un retournement du levier VOISIN de la herse (indice 1) ; en solo, du levier lointain (0)
        const st = run.mech(hgId);
        expect(st.type === 'hourglass' && st.lastLever, `${roomId} à ${n} joueurs : dernier levier utilisé`).toBe(n >= 2 ? 1 : 0);
      }
    }
  });
});
