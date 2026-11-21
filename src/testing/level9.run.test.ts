/**
 * Niveau 9 (« Le Clocher de l'Aube », DERNIER niveau du jeu) : preuve par la simulation réelle que le niveau est TERMINABLE de bout en
 * bout (`phase === 'levelComplete'`) à 1, 2, 3 et 4 joueurs, avec des bots qui ne produisent que des `ActionFrame`
 * (script de résolution : `level9.solution.ts`). Graine fixe : partie déterministe.
 *
 * Mesure la « durée cible » (5 à 10 minutes de temps simulé à 2-4 joueurs, 5 à 13 en solo), l'équité (≤ 2 défaites collectives par salle,
 * ≤ 5 au total) et prouve les signatures du niveau : la CADENCE (un seul héros tire ses trois leviers dans la fenêtre élargie ; un relais
 * raté se rejoue sans pénalité), les VAGUES déclenchées par les contrepoids, et l'embuscade de la mesure qui ne se contourne pas.
 *
 * Les bots jouent SANS butin ni cristaux de soin (`loot: false`, comme pour les autres niveaux) : un joueur qui perd tous ses PV n'a
 * aucun moyen de se soigner. Les durées mesurées sont donc PESSIMISTES par rapport au jeu réel.
 */
import { describe, expect, it } from 'vitest';
import { level9 } from '../levels/level9';
import { durationCapMs } from './durationWindows';
import { BotRun, conds, formatStats, goTo, runLevelScripts, runUntil, type LevelRunResult } from './botKit';
import {
  LEVEL9_CHARACTERS,
  LEVEL9_DIFFICULTY,
  LEVEL9_SOLO_BOSS,
  level9RunOptions,
  level9Scripts,
  newLevel9Run,
  newLevel9SoloBossRun,
  queueCadence,
  solveLevel9,
} from './level9.solution';
import { pullLever } from './botKit';

function secs(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function play(n: number, opts: { seed?: number; startRoomIndex?: number } = {}): { run: BotRun; result: LevelRunResult } {
  return solveLevel9(n, opts);
}

/** Retire tous les ennemis déjà apparus (les apparitions conditionnelles restent en attente) : pour isoler un mécanisme du combat. */
function clearSpawned(run: BotRun): void {
  run.state.room.enemies.splice(0);
}

describe('niveau 9 : terminable de bout en bout (bots, simulation réelle)', () => {
  for (const n of [1, 2, 3, 4]) {
    it(`${n} joueur(s) : niveau terminé, durée simulée dans la fenêtre cible, équité`, () => {
      const { run, result } = play(n);
      const chars = level9RunOptions(n).characters.join(', ');
      console.info(
        `\n[level9] ${n} joueur(s) (${chars}, difficulté ${LEVEL9_DIFFICULTY[n]}) : ${result.completed ? 'TERMINÉ' : 'ÉCHEC'} en ${secs(result.timeMs)} simulées, ${run.stats.wipes} défaite(s) collective(s)`,
      );
      for (const r of run.stats.rooms) {
        const first = run.stats.rooms.indexOf(r) === 0 ? 0 : (run.stats.rooms[run.stats.rooms.indexOf(r) - 1].clearedAtMs ?? 0);
        const dur = r.clearedAtMs === null ? r.timeMs : r.clearedAtMs - first;
        console.info(
          `[level9]   ${String(r.roomIndex + 1)}. ${r.roomId.padEnd(14)} ${secs(dur).padStart(8)}  à terre ${r.downs.reduce((a, b) => a + b, 0)}  défaites ${r.wipes}  PV perdus ${Math.round(r.hpLost.reduce((a, b) => a + b, 0))}`,
        );
      }
      console.info(formatStats(run));
      expect(result.failure, result.failure ?? '').toBeNull();
      expect(result.completed).toBe(true);
      expect(run.state.phase).toBe('levelComplete');
      // Durée cible : 5 minutes au moins, plafonds mesurés dans `durationWindows.ts` (balayage de graines : `durationWindows.run.test.ts`). Bots SANS butin ni cristaux : pessimiste.
      // Solo mesuré 690-890 s selon la graine : le seigneur du Néant (boss final) coûte 1 à 3 défaites (en solo, tomber = défaite collective). Cf. TODO « Niveau 9 ».
      expect(result.timeMs, 'durée simulée trop courte').toBeGreaterThanOrEqual(5 * 60 * 1000);
      expect(result.timeMs, 'durée simulée trop longue').toBeLessThanOrEqual(durationCapMs(9, n));
      // Aucune action de script échouée, toutes les salles validées, tous les objectifs accomplis.
      expect(run.failures).toEqual([]);
      expect(run.state.clearedRooms).toEqual(level9.rooms.map((r) => r.id));
      expect(run.state.objectives.every((o) => o.done)).toBe(true);
      // Équité (les bots n'esquivent pas intelligemment) : ≤ 2 défaites collectives par salle, ≤ 5 au total.
      for (const r of run.stats.rooms) expect(r.wipes, `défaites dans ${r.roomId}`).toBeLessThanOrEqual(2);
      expect(run.stats.wipes).toBeLessThanOrEqual(5);
    }, 300_000);
  }

  it('est déterministe : deux parties identiques (2 joueurs, à partir de la salle des cordes) donnent la même durée et les mêmes statistiques', () => {
    const a = play(2, { startRoomIndex: 6 });
    const b = play(2, { startRoomIndex: 6 });
    expect(a.result.timeMs).toBe(b.result.timeMs);
    expect(JSON.stringify(a.run.stats)).toBe(JSON.stringify(b.run.stats));
  }, 300_000);

  it('les personnages et difficultés des bots sont documentés (difficulté 2 partout, solo compris)', () => {
    expect(LEVEL9_CHARACTERS[1]).toEqual(['david']);
    expect(LEVEL9_CHARACTERS[2]).toEqual(['david', 'valentine']);
    expect(LEVEL9_CHARACTERS[4]).toHaveLength(4);
    for (const n of [1, 2, 3, 4]) expect(LEVEL9_DIFFICULTY[n]).toBe(2);
  });
});

// ───────────────────────────── La cadence ─────────────────────────────

describe('niveau 9 : la cadence (galerie des battants)', () => {
  it('SEUL, un héros tire ses trois leviers de la galerie (A, bleu, B) dans la fenêtre élargie : la porte s\'ouvre', () => {
    const run = newLevel9Run(1, { startRoomIndex: 1 });
    run.stepOnce();
    clearSpawned(run);
    queueCadence(run, 0);
    const res = runUntil(run, conds.mechActive('galleryDoor'), 120_000, { stopOnFailure: true });
    expect(res.ok, `porte jamais ouverte (${res.reason}) : ${run.failures.map((f) => f.reason).join(' / ')}`).toBe(true);
    expect(res.elapsedMs).toBeLessThan(60_000);
    expect(run.failures).toEqual([]);
    // les trois leviers inexistants à 1 joueur sont neutralisés d'office
    for (const id of ['galleryLeverRed', 'galleryLeverGreen', 'galleryLeverYellow']) expect(run.mech(id).waived, id).toBe(true);
    for (const id of ['galleryLeverA', 'galleryLeverBlue', 'galleryLeverB']) expect(run.mech(id).waived, id).toBe(false);
  });

  it.each([2, 3, 4])('à %i joueurs, le relais se joue à plusieurs : chacun tire SON levier, la porte s\'ouvre', (n) => {
    const run = newLevel9Run(n, { startRoomIndex: 1 });
    run.stepOnce();
    clearSpawned(run);
    queueCadence(run, 0);
    const res = runUntil(run, conds.mechActive('galleryDoor'), 120_000, { stopOnFailure: true });
    expect(res.ok, `porte jamais ouverte (${res.reason}) : ${run.failures.map((f) => f.reason).join(' / ')}`).toBe(true);
    expect(run.failures).toEqual([]);
  });

  it("dans l'ordre INVERSE (B, bleu, A) la porte s'ouvre aussi : l'ordre n'est pas imposé, seules les fenêtres (élargies en solo) comptent", () => {
    const run = newLevel9Run(1, { startRoomIndex: 1 });
    run.stepOnce();
    clearSpawned(run);
    // trois leviers réellement tirés, de l'est vers l'ouest (l'inverse de l'ordre conseillé par les panneaux)
    run.queue(0, pullLever('galleryLeverB'), pullLever('galleryLeverBlue'), pullLever('galleryLeverA'));
    const res = runUntil(run, conds.mechActive('galleryDoor'), 120_000, { stopOnFailure: true });
    expect(res.ok, `porte jamais ouverte (${res.reason}) : ${run.failures.map((f) => f.reason).join(' / ')}`).toBe(true);
    expect(run.failures).toEqual([]);
  });

  it('un levier qui retombe avant le dernier tirage fait échouer le relais : la porte reste fermée tant que les trois ne sont pas actifs ensemble', () => {
    const run = newLevel9Run(1, { startRoomIndex: 1 });
    run.stepOnce();
    clearSpawned(run);
    run.queue(0, pullLever('galleryLeverA'));
    expect(runUntil(run, conds.mechActive('galleryLeverA'), 120_000, { stopOnFailure: true }).ok).toBe(true);
    run.stepFor(30_000); // au-delà de la fenêtre élargie du premier battant (22,5 s en solo) : A retombe
    expect(run.mech('galleryLeverA').active, 'A retombé').toBe(false);
    run.queue(0, pullLever('galleryLeverBlue'), pullLever('galleryLeverB'));
    const res = runUntil(run, (r) => r.mech('galleryLeverB').active, 120_000, { stopOnFailure: true });
    expect(res.ok, `B jamais tiré (${res.reason})`).toBe(true);
    expect(run.mech('galleryLeverA').active).toBe(false);
    expect(run.mechSolved('galleryDoor')).toBe(false);
  });

  it('un relais INCOMPLET (B puis A, sans jamais le levier bleu) se rejoue sans aucune pénalité : les leviers retombent seuls, puis le bon relais ouvre la porte', () => {
    const run = newLevel9Run(1, { startRoomIndex: 1 });
    run.stepOnce();
    clearSpawned(run);
    // relais incomplet : le dernier battant (B), puis le premier (A), mais jamais le bleu : jamais les trois ensemble
    run.queue(0, pullLever('galleryLeverB'), pullLever('galleryLeverA'));
    let seenBoth = false;
    const res = runUntil(
      run,
      (r) => {
        const a = r.mech('galleryLeverA').active;
        const b = r.mech('galleryLeverB').active;
        if (a && b) seenBoth = true;
        return seenBoth && !a && !b;
      },
      180_000,
      { stopOnFailure: true },
    );
    expect(res.ok, `leviers jamais retombés (${res.reason})`).toBe(true);
    expect(run.mechSolved('galleryDoor')).toBe(false);
    expect(run.failures).toEqual([]);
    // le relais raté ne laisse aucune trace : le bon relais ouvre la porte
    queueCadence(run, 1);
    const ok = runUntil(run, conds.mechActive('galleryDoor'), 120_000, { stopOnFailure: true });
    expect(ok.ok, `porte jamais ouverte au second essai (${ok.reason})`).toBe(true);
    expect(run.failures).toEqual([]);
  });

  it('une fois ouverte, la porte de la galerie le reste (les leviers peuvent retomber)', () => {
    const run = newLevel9Run(2, { startRoomIndex: 1 });
    run.stepOnce();
    clearSpawned(run);
    queueCadence(run, 0);
    expect(runUntil(run, conds.mechActive('galleryDoor'), 120_000, { stopOnFailure: true }).ok).toBe(true);
    run.stepFor(60_000);
    for (const l of ['galleryLeverA', 'galleryLeverB']) expect(run.mech(l).active, `${l} retombé`).toBe(false);
    expect(run.mechSolved('galleryDoor')).toBe(true);
  });
});

// ───────────────────────────── Le parvis : tirer puis courir ─────────────────────────────

describe('niveau 9 : parvis des cloches (levier à fenêtre + plaque)', () => {
  it('SEUL : tirer le levier du fond puis courir à la plaque dans les 19 s ouvre la porte (script des bots)', () => {
    const { run, result } = play(1, { startRoomIndex: 0 });
    expect(result.completed, result.failure ?? '').toBe(true);
    expect(run.state.objectives.find((o) => o.id === 'bell')?.done).toBe(true);
  }, 300_000);
});

// ───────────────────────────── Les contrepoids : vagues déclenchées par les plaques ─────────────────────────────

describe('niveau 9 : contrepoids — chaque bloc posé sur sa plaque fait surgir sa vague', () => {
  it('à 2 joueurs, seules les vagues dont la plaque est couverte apparaissent (A d\'abord ; B et C restent en attente)', () => {
    const run = newLevel9Run(2, { startRoomIndex: 3 });
    run.stepOnce();
    clearSpawned(run);
    const cw = level9.rooms[3];
    const waveOf = (id: string): number => cw.enemies.filter((e) => e.when === id && (e.minPlayers ?? 1) <= 2).length;
    expect(run.pendingSpawnCount(false)).toBe(waveOf('counterweightPlateA') + waveOf('counterweightPlateB') + waveOf('counterweightPlateC'));
    // sans toucher aux blocs, rien n'apparaît
    run.stepFor(3000);
    expect(run.aliveEnemies).toHaveLength(0);
    // on pousse le bloc A sur sa plaque
    const block = run.mechDef('counterweightBlockA');
    const plate = run.mechDef('counterweightPlateA');
    if (block.type !== 'block' || plate.type !== 'plate') throw new Error('bloc et plaque attendus');
    run.pushBlockTogether('counterweightBlockA', 'right', plate.tile[0] - block.tile[0] - 1);
    const res = runUntil(run, conds.mechActive('counterweightPlateA'), 90_000, { stopOnFailure: true });
    expect(res.ok, `bloc A jamais sur sa plaque (${res.reason}) : ${run.failures.map((f) => f.reason).join(' / ')}`).toBe(true);
    run.stepFor(1500);
    // la vague A a surgi en entier (et seulement elle) ; B et C attendent toujours leur plaque (certains sbires de A ont pu tomber depuis)
    const spawnedBy = (id: string): number => cw.enemies.filter((e, i) => e.when === id && run.state.room.spawnedSpawnIdx.includes(i)).length;
    expect(spawnedBy('counterweightPlateA')).toBe(waveOf('counterweightPlateA'));
    expect(spawnedBy('counterweightPlateB') + spawnedBy('counterweightPlateC')).toBe(0);
    expect(run.aliveEnemies.length).toBeGreaterThanOrEqual(waveOf('counterweightPlateA') - 3);
    expect(run.pendingSpawnCount(false)).toBe(waveOf('counterweightPlateB') + waveOf('counterweightPlateC'));
    expect(run.mechSolved('counterweightDoor')).toBe(false);
  }, 120_000);
});

// ───────────────────────────── Le verger : l'embuscade de la mesure ─────────────────────────────

describe('niveau 9 : verger des échos — l\'embuscade de la mesure ne se contourne pas', () => {
  it('à 2 joueurs, aucune embuscade tant que personne n\'entre dans la zone ; elle surgit dès que le héros rouge y entre', () => {
    const run = newLevel9Run(2, { startRoomIndex: 4 });
    run.stepOnce();
    clearSpawned(run);
    const orchard = level9.rooms[4];
    const zone = (orchard.zones ?? [])[0];
    const ambush = orchard.enemies.filter((e) => e.when === `enter:${zone.id}` && (e.minPlayers ?? 1) <= 2).length;
    expect(ambush).toBeGreaterThanOrEqual(8);
    expect(run.pendingSpawnCount(false)).toBe(ambush);
    run.stepFor(5000);
    expect(run.aliveEnemies).toHaveLength(0);
    expect(run.pendingSpawnCount(false)).toBe(ambush);
    // le héros rouge (slot 1) entre dans la zone : l'embuscade surgit
    run.queue(1, goTo([zone.rect.x + Math.floor(zone.rect.w / 2), zone.rect.y + Math.floor(zone.rect.h / 2)]));
    const res = runUntil(run, (r) => r.aliveEnemies.length > 0, 60_000, { stopOnFailure: true });
    expect(res.ok, `embuscade jamais déclenchée : ${run.failures.map((f) => f.reason).join(' / ')}`).toBe(true);
    run.stepFor(500);
    expect(run.aliveEnemies.length).toBe(ambush);
    expect(run.pendingSpawnCount(false)).toBe(0);
  }, 120_000);

  it('seul, le héros lit lui-même la séquence : l\'unique joueur est le voyant des runes (slot 1 → joueur 0)', () => {
    const run = newLevel9Run(1, { startRoomIndex: 4 });
    expect(run.playerFor(1)).toBe(0);
    const def = run.mechDef('orchardRunes');
    expect(def.type === 'runePuzzle' && def.visibleToSlot).toBe(1);
  });
});

// ───────────────────────────── Solo à la difficulté par défaut ─────────────────────────────

describe('niveau 9 : solo à la difficulté par défaut (2)', () => {
  it('boss final : une archère (Aelith) vainc le seigneur du Néant en solo à difficulté 2, graines 7, 1 et 2 (≤ 2 défaites)', () => {
    expect(LEVEL9_SOLO_BOSS).toEqual({ character: 'aelith', difficulty: 2 });
    for (const seed of [7, 1, 2]) {
      const run = newLevel9SoloBossRun({ seed });
      const result = runLevelScripts(run, level9Scripts(), { maxTotalMs: 20 * 60 * 1000, maxRoomMs: 240000, maxWipesPerRoom: 4 });
      console.info(`[level9] solo boss (aelith, difficulté 2, graine ${seed}) : ${result.completed ? 'TERMINÉ' : 'ÉCHEC'} en ${secs(result.timeMs)}, ${run.stats.wipes} défaite(s)`);
      expect(result.failure, `graine ${seed} : ${result.failure ?? ''}`).toBeNull();
      expect(result.completed, `graine ${seed}`).toBe(true);
      expect(run.state.phase).toBe('levelComplete');
      expect(run.stats.wipes, `graine ${seed} : défaites`).toBeLessThanOrEqual(2);
    }
  }, 300_000);

  it('boss final : David (mêlée) vainc aussi le seigneur du Néant en solo à difficulté 2 (graines 7, 1 et 2, ≤ 2 défaites)', () => {
    for (const seed of [7, 1, 2]) {
      const run = newLevel9SoloBossRun({ seed, character: 'david', difficulty: 2 });
      const result = runLevelScripts(run, level9Scripts(), { maxTotalMs: 20 * 60 * 1000, maxRoomMs: 240000, maxWipesPerRoom: 4 });
      console.info(`[level9] solo boss (david, difficulté 2, graine ${seed}) : ${result.completed ? 'TERMINÉ' : 'ÉCHEC'} en ${secs(result.timeMs)}, ${run.stats.wipes} défaite(s)`);
      expect(result.failure, `graine ${seed} : ${result.failure ?? ''}`).toBeNull();
      expect(result.completed, `graine ${seed}`).toBe(true);
      expect(run.stats.wipes, `graine ${seed} : défaites`).toBeLessThanOrEqual(2);
    }
  }, 300_000);
});
