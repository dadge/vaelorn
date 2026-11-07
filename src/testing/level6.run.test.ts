/**
 * Niveau 6 (« Les Abysses du Néant ») : preuve par la simulation réelle que le niveau est TERMINABLE de bout en bout
 * (`phase === 'levelComplete'`) à 1, 2, 3 et 4 joueurs, avec des bots qui ne produisent que des `ActionFrame`
 * (script de résolution : `level6.solution.ts`). Graine fixe : partie déterministe.
 *
 * Mesure la « durée cible » (5 à 10 minutes de temps simulé à 2-4 joueurs, 5 à 12 en solo), l'équité (≤ 2 défaites collectives par salle,
 * ≤ 5 au total) et la règle du pont : aucun joueur ne reçoit de coup pendant qu'il se trouve sur un pont de lumière, et aucun joueur
 * vivant n'est jamais pris dans une tuile solide (pont éteint).
 */
import { describe, expect, it } from 'vitest';
import { REVIVE_RANGE, TILE } from '../core/constants';
import { isTileBlockedByMechanism } from '../core/mechanisms';
import type { LightBridgeDef, SimEvent } from '../core/types';
import { level6 } from '../levels/level6';
import { BotRun, escortLightBridge, formatStats, goTo, runLevelScripts, type LevelRunResult } from './botKit';
import {
  LEVEL6_CHARACTERS,
  LEVEL6_DIFFICULTY,
  LEVEL6_SOLO_BOSS,
  level6RunOptions,
  level6Scripts,
  newLevel6Run,
  newLevel6SoloBossRun,
  solveLevel6,
} from './level6.solution';

function secs(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

interface Play {
  run: BotRun;
  result: LevelRunResult;
  /** Coups reçus pendant qu'un joueur vivant se tient sur un pont de lumière. */
  crossingHits: number;
  /** Pas de simulation pendant lesquels au moins un joueur vivant est sur un pont. */
  crossingSteps: number;
  /** Pas pendant lesquels un joueur vivant occupait une tuile solide d'un mécanisme (pont éteint, porte fermée…). */
  trappedSteps: number;
}

/** Joue le niveau de bout en bout en surveillant la règle des ponts. */
function play(n: number, opts: { startRoomIndex?: number } = {}): Play {
  const run = newLevel6Run(n, opts);
  const out = { crossingHits: 0, crossingSteps: 0, trappedSteps: 0 };
  const orig = run.stepOnce.bind(run);
  (run as { stepOnce: typeof run.stepOnce }).stepOnce = (frames) => {
    const events: SimEvent[] = orig(frames);
    const room = run.room;
    const bridges = room.mechanisms.filter((m): m is LightBridgeDef => m.type === 'lightBridge');
    if (bridges.length > 0 && run.state.phase === 'playing') {
      let onBridge = false;
      for (const p of run.alivePlayers()) {
        const tx = Math.floor(p.pos.x / TILE);
        const ty = Math.floor(p.pos.y / TILE);
        if (bridges.some((b) => b.tiles.some((t) => t[0] === tx && t[1] === ty))) onBridge = true;
        if (isTileBlockedByMechanism(room, run.state.room.mechanisms, tx, ty)) {
          // le centre du joueur ne doit jamais être dans une tuile solide
          out.trappedSteps++;
        }
      }
      if (onBridge) {
        out.crossingSteps++;
        out.crossingHits += events.filter((e) => e.type === 'playerHit').length;
      }
    }
    return events;
  };
  const result = runLevelScripts(run, level6Scripts(), { maxTotalMs: 20 * 60 * 1000, maxRoomMs: 240000, maxWipesPerRoom: 4 });
  return { run, result, ...out };
}

describe('niveau 6 : terminable de bout en bout (bots, simulation réelle)', () => {
  for (const n of [1, 2, 3, 4]) {
    it(`${n} joueur(s) : niveau terminé, durée simulée dans la fenêtre cible, équité, règle des ponts`, () => {
      const p = play(n);
      const { run, result } = p;
      const chars = level6RunOptions(n).characters.join(', ');
      console.info(
        `\n[level6] ${n} joueur(s) (${chars}, difficulté ${LEVEL6_DIFFICULTY[n]}) : ${result.completed ? 'TERMINÉ' : 'ÉCHEC'} en ${secs(result.timeMs)} simulées, ${run.stats.wipes} défaite(s) collective(s), ${p.crossingSteps} pas sur un pont (${p.crossingHits} coup reçu)`,
      );
      for (const r of run.stats.rooms) {
        const first = run.stats.rooms.indexOf(r) === 0 ? 0 : (run.stats.rooms[run.stats.rooms.indexOf(r) - 1].clearedAtMs ?? 0);
        const dur = r.clearedAtMs === null ? r.timeMs : r.clearedAtMs - first;
        console.info(
          `[level6]   ${String(r.roomIndex + 1)}. ${r.roomId.padEnd(10)} ${secs(dur).padStart(8)}  à terre ${r.downs.reduce((a, b) => a + b, 0)}  défaites ${r.wipes}  PV perdus ${Math.round(r.hpLost.reduce((a, b) => a + b, 0))}`,
        );
      }
      console.info(formatStats(run));
      expect(result.failure, result.failure ?? '').toBeNull();
      expect(result.completed).toBe(true);
      expect(run.state.phase).toBe('levelComplete');
      // Durée cible : 5 à 10 minutes simulées (solo : 5 à 12).
      expect(result.timeMs, 'durée simulée trop courte').toBeGreaterThanOrEqual(5 * 60 * 1000);
      expect(result.timeMs, 'durée simulée trop longue').toBeLessThanOrEqual((n === 1 ? 12 : 10) * 60 * 1000);
      // Aucune action de script échouée, toutes les salles validées, tous les objectifs accomplis.
      expect(run.failures).toEqual([]);
      expect(run.state.clearedRooms).toEqual(level6.rooms.map((r) => r.id));
      expect(run.state.objectives.every((o) => o.done)).toBe(true);
      // Équité (les bots n'esquivent pas intelligemment) : ≤ 2 défaites collectives par salle, ≤ 5 au total.
      for (const r of run.stats.rooms) expect(r.wipes, `défaites dans ${r.roomId}`).toBeLessThanOrEqual(2);
      expect(run.stats.wipes).toBeLessThanOrEqual(5);
      // Règle des ponts : les ponts ont bien été franchis, sans aucun coup reçu dessus, et personne n'a été piégé dans le vide.
      expect(p.crossingSteps, 'les ponts doivent avoir été traversés').toBeGreaterThan(200);
      expect(p.crossingHits, 'aucun coup reçu pendant une traversée').toBe(0);
      expect(p.trappedSteps, 'aucun joueur dans une tuile solide').toBe(0);
    }, 300_000);
  }

  it('est déterministe : deux parties identiques (2 joueurs, à partir du Grand Pont) donnent la même durée et les mêmes statistiques', () => {
    const a = play(2, { startRoomIndex: 7 });
    const b = play(2, { startRoomIndex: 7 });
    expect(a.result.timeMs).toBe(b.result.timeMs);
    expect(JSON.stringify(a.run.stats)).toBe(JSON.stringify(b.run.stats));
  }, 300_000);

  it('les personnages et difficultés des bots sont documentés (solo : difficulté 1, faute d\'esquive intelligente contre le boss final)', () => {
    expect(LEVEL6_CHARACTERS[1]).toHaveLength(1);
    expect(LEVEL6_CHARACTERS[4]).toHaveLength(4);
    expect(LEVEL6_DIFFICULTY[1]).toBe(2);
    expect(LEVEL6_DIFFICULTY[2]).toBe(2);
    expect(LEVEL6_DIFFICULTY[3]).toBe(2);
    expect(LEVEL6_DIFFICULTY[4]).toBe(2);
  });
});

describe('niveau 6 : le pont de lumière est indispensable et se franchit en escorte', () => {
  it('quai (2 joueurs) : sans le porteur de la lanterne, l\'autre joueur n\'a aucun chemin vers l\'autre rive', () => {
    const run = newLevel6Run(2);
    // le porteur du quai est le joueur du slot 0 (J1) ; J2 tente seul la traversée
    run.queue(1, goTo([43, 22], { onUnreachable: 'fail', unreachableGraceMs: 800 }));
    run.stepFor(5000);
    expect(run.failures.some((f) => /aucun chemin/.test(f.reason))).toBe(true);
    expect(run.player(1).pos.x).toBeLessThan(28 * TILE);
  });

  it('terrasse (4 joueurs) : le porteur du long pont est le joueur du slot 3 (jaune)', () => {
    const run = newLevel6Run(4, { startRoomIndex: 2 });
    run.stepOnce();
    const st = run.mech('terraceBridge');
    expect(st.type === 'lightBridge' && st.bearerId).toBe(3);
    expect(run.mechDef('terraceBridge').type).toBe('lightBridge');
  });

  it('pont waived : à 1 joueur les plaques, clés et braseros des slots 1..3 sont neutralisés mais le pont reste à franchir', () => {
    const run = newLevel6Run(1, { startRoomIndex: 4 });
    for (const id of ['keyRed', 'doorRed', 'keyGreen', 'doorYellow']) expect(run.mech(id).waived, id).toBe(true);
    expect(run.mech('keyBlue').waived).toBe(false);
    expect(run.mech('keysBridge').waived).toBe(false);
  });
});

describe('niveau 6 : Grand Pont — les embuscades ne se contournent pas (simulation réelle)', () => {
  it('en escortant les 4 ponts SANS viser aucune zone d\'embuscade, le trajet naturel vers chaque pont déclenche l\'embuscade de l\'îlot AVANT de s\'engager sur le pont suivant', () => {
    const run = newLevel6Run(2, { startRoomIndex: 7 });
    escortLightBridge(run, 'bridgeA', { dest: [32, 30] });
    escortLightBridge(run, 'bridgeB', { dest: [47, 14] });
    escortLightBridge(run, 'bridgeC', { dest: [66, 28] });
    escortLightBridge(run, 'bridgeD', { dest: [76, 18] });
    const bridges = run.room.mechanisms.filter((m): m is LightBridgeDef => m.type === 'lightBridge');
    const onBridge = (id: string): boolean =>
      run.alivePlayers().some((p) => {
        const t = [Math.floor(p.pos.x / TILE), Math.floor(p.pos.y / TILE)];
        return bridges.find((b) => b.id === id)?.tiles.some((b) => b[0] === t[0] && b[1] === t[1]) === true;
      });
    // pont suivant (à franchir) → zone d'îlot qui doit déjà avoir été déclenchée
    const gate: Record<string, string> = { bridgeB: 'isleOne', bridgeC: 'isleTwo', bridgeD: 'isleThree' };
    const entered = new Set<string>();
    const violations: string[] = [];
    let crossedD = false;
    for (let i = 0; i < 20 * 60 * 5 && !crossedD; i++) {
      run.stepFor(200);
      // pas de combat : on retire les ennemis surgis pour ne mesurer que le trajet
      run.state.room.enemies.splice(0);
      // embuscade déclenchée = au moins une de ses apparitions a eu lieu (`BotRun.requirementMet` n'évalue pas les jetons `enter:`)
      for (const z of ['isleOne', 'isleTwo', 'isleThree']) {
        if (run.room.enemies.some((e, idx) => e.when === `enter:${z}` && run.state.room.spawnedSpawnIdx.includes(idx))) entered.add(z);
      }
      for (const [bridge, zone] of Object.entries(gate)) {
        if (onBridge(bridge) && !entered.has(zone)) violations.push(`${bridge} engagé sans que ${zone} ait été déclenchée`);
      }
      if (onBridge('bridgeD')) crossedD = true;
      expect(run.failures, `échec d'une action de bot à ${run.timeMs} ms`).toEqual([]);
    }
    expect(crossedD, 'les quatre ponts doivent avoir été franchis').toBe(true);
    expect(violations).toEqual([]);
    expect([...entered].sort()).toEqual(['isleOne', 'isleThree', 'isleTwo']);
    // toutes les apparitions d'îlot ont eu lieu : plus rien « d'invisible » ne retient la sortie, hormis l'embuscade de la rive d'arrivée
    const pendingBefore = run.pendingSpawnCount(false);
    const farRiver = run.room.enemies.filter((e) => e.when === 'enter:farRiver' && (e.minPlayers ?? 1) <= 2).length;
    expect(pendingBefore).toBe(farRiver);
  }, 120_000);
});

describe('niveau 6 : solo à la difficulté par défaut (2)', () => {
  it('boss final : une archère (Aelith) vainc le seigneur du Néant en solo à difficulté 2, graines 7, 1 et 2 (≤ 2 défaites)', () => {
    expect(LEVEL6_SOLO_BOSS).toEqual({ character: 'aelith', difficulty: 2 });
    for (const seed of [7, 1, 2]) {
      const run = newLevel6SoloBossRun({ seed });
      const result = runLevelScripts(run, level6Scripts(), { maxTotalMs: 20 * 60 * 1000, maxRoomMs: 240000, maxWipesPerRoom: 4 });
      console.info(`[level6] solo boss (aelith, difficulté 2, graine ${seed}) : ${result.completed ? 'TERMINÉ' : 'ÉCHEC'} en ${secs(result.timeMs)}, ${run.stats.wipes} défaite(s)`);
      expect(result.failure, `graine ${seed} : ${result.failure ?? ''}`).toBeNull();
      expect(result.completed, `graine ${seed}`).toBe(true);
      expect(run.state.phase).toBe('levelComplete');
      expect(run.stats.wipes, `graine ${seed} : défaites`).toBeLessThanOrEqual(2);
    }
  }, 300_000);

  it('boss final : David (mêlée) vainc aussi le seigneur du Néant en solo à difficulté 2 (graines 7, 1 et 2, ≤ 2 défaites) — rééquilibrage du boss solo', () => {
    for (const seed of [7, 1, 2]) {
      const run = newLevel6SoloBossRun({ seed, character: 'david', difficulty: 2 });
      const result = runLevelScripts(run, level6Scripts(), { maxTotalMs: 20 * 60 * 1000, maxRoomMs: 240000, maxWipesPerRoom: 4 });
      console.info(`[level6] solo boss (david, difficulté 2, graine ${seed}) : ${result.completed ? 'TERMINÉ' : 'ÉCHEC'} en ${secs(result.timeMs)}, ${run.stats.wipes} défaite(s)`);
      expect(result.failure, `graine ${seed} : ${result.failure ?? ''}`).toBeNull();
      expect(result.completed, `graine ${seed}`).toBe(true);
      expect(run.stats.wipes, `graine ${seed} : défaites`).toBeLessThanOrEqual(2);
    }
  }, 300_000);
});

describe('niveau 6 : marge de durée', () => {
  it('à 2 joueurs, la durée simulée reste dans la fenêtre cible (≤ 10 min) pour les graines 1, 2 et 7', () => {
    for (const seed of [1, 2, 7]) {
      const { run, result } = solveLevel6(2, { seed });
      console.info(`[level6] 2 joueurs, graine ${seed} : ${secs(result.timeMs)} simulées, ${run.stats.wipes} défaite(s)`);
      expect(result.completed, `graine ${seed} : ${result.failure ?? ''}`).toBe(true);
      expect(result.timeMs, `graine ${seed}`).toBeGreaterThanOrEqual(5 * 60 * 1000);
      expect(result.timeMs, `graine ${seed}`).toBeLessThanOrEqual(10 * 60 * 1000);
    }
  }, 300_000);
});

describe('niveau 6 : porteur tombé loin de l\'équipe (plus d\'impasse)', () => {
  it('Grand Pont (2 joueurs) : le porteur est à terre au bout du pont A, son partenaire encore sur le pont avance dans le halo de SA lanterne et le relève', () => {
    const run = newLevel6Run(2, { startRoomIndex: 7 });
    run.stepOnce();
    const bridge = run.mechDef('bridgeA') as LightBridgeDef;
    const route = bridge.tiles;
    const centre = (t: readonly [number, number]) => ({ x: (t[0] + 0.5) * TILE, y: (t[1] + 0.5) * TILE });
    const bearer = run.player(0); // lanternSlot 0
    const follower = run.player(1);
    bearer.pos = centre([30, 30]); // rive d'arrivée (hors pont)
    bearer.status = 'down';
    follower.pos = centre(route[6]); // encore sur le pont, très loin derrière
    // le pilote de fond des bots n'intervient pas : on force les deux frames
    const idle = { moveX: 0, moveY: 0, attack: false, interact: false, revive: false };
    let revived = false;
    for (let i = 0; i < 90 * 20 && !revived; i++) {
      const here = [Math.floor(follower.pos.x / TILE), Math.floor(follower.pos.y / TILE)];
      const idx = route.findIndex((t) => t[0] === here[0] && t[1] === here[1]);
      const target = idx >= 0 && idx + 1 < route.length ? centre(route[idx + 1]) : bearer.pos;
      const dx = target.x - follower.pos.x;
      const dy = target.y - follower.pos.y;
      const d = Math.hypot(dx, dy);
      const near = Math.hypot(bearer.pos.x - follower.pos.x, bearer.pos.y - follower.pos.y) <= REVIVE_RANGE - 4;
      const f = near ? { ...idle, revive: true } : d > 1 ? { ...idle, moveX: dx / d, moveY: dy / d } : idle;
      run.stepOnce({ 0: idle, 1: f });
      revived = (bearer.status as string) === 'alive';
    }
    expect(follower.status as string).toBe('alive');
    expect(revived, `le partenaire (J2) est resté bloqué sur le pont : ${Math.round(follower.pos.x / TILE)},${Math.round(follower.pos.y / TILE)}`).toBe(true);
    expect(run.state.phase).toBe('playing');
  }, 120_000);
});
