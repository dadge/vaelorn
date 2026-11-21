/**
 * Niveau 7 (« Le Carillon Englouti ») : preuve par la simulation réelle que le niveau est TERMINABLE de bout en bout
 * (`phase === 'levelComplete'`) à 1, 2, 3 et 4 joueurs, avec des bots qui ne produisent que des `ActionFrame`
 * (script de résolution : `level7.solution.ts`). Graine fixe : partie déterministe.
 *
 * Mesure la « durée cible » (plafonds mesurés de `durationWindows.ts` ; balayage de graines dans `durationWindows.run.test.ts`), l'équité (≤ 2 défaites collectives par
 * salle, ≤ 5 au total) et les deux signatures du niveau :
 *  - « Phare et Écho » (Bassins-Miroirs) : aucun joueur ne reçoit de coup pendant qu'il se trouve sur le pont de lumière, personne n'est jamais pris dans
 *    une tuile solide, le pont est indispensable (le joueur qui ne porte pas la lanterne n'a aucun chemin seul), les embuscades de l'île et de la rive
 *    est se déclenchent avant la première rune et avant la sortie (elles ne se contournent pas), une rune fausse remet la séquence à zéro SANS pénalité ;
 *  - « Chœur » (Chœur de Nacre) : les leviers à fenêtre ne comptent que « presque ensemble » ; seuls les leviers des héros PRÉSENTS existent (à 1
 *    joueur, le levier bleu suffit), et l'échec est rejouable à l'infini.
 *
 * Mesures (graine 7, difficulté 2, bots sans butin ni équipement), à titre indicatif ; les chiffres exacts sont affichés par `console.info` :
 * 1 joueur ≈ 11,3 min (1 défaite, au demi-boss n°2 : les bots n'ont aucun soin et arrivent à bout de PV), 2 joueurs ≈ 9,3 min, 3 joueurs ≈ 9 min,
 * 4 joueurs ≈ 8,5 min.
 */
import { describe, expect, it } from 'vitest';
import { SIM_STEP_MS, TILE } from '../core/constants';
import { isTileBlockedByMechanism } from '../core/mechanisms';
import type { LightBridgeDef, RunePuzzleDef, SimEvent } from '../core/types';
import { level7 } from '../levels/level7';
import { durationCapMs } from './durationWindows';
import { BotRun, formatStats, goTo, runLevelScripts, type LevelRunResult } from './botKit';
import {
  LEVEL7_CHARACTERS,
  LEVEL7_DIFFICULTY,
  LEVEL7_SOLO_BOSS,
  level7RunOptions,
  level7Scripts,
  newLevel7Run,
  newLevel7SoloBossRun,
  solveLevel7,
} from './level7.solution';

function secs(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** Trace de la salle des Bassins-Miroirs relevée pendant la partie. */
interface MirrorTrace {
  /** Temps (ms) de la première apparition d'un ennemi de l'embuscade de l'île / de la rive est, null si jamais. */
  islandAt: number | null;
  eastAt: number | null;
  /** Temps (ms) du premier appui juste sur un piédestal (progression de la séquence), null si jamais. */
  firstRuneAt: number | null;
  /** Temps (ms) où le premier joueur atteint la tuile de la porte de la rive est, null si jamais. */
  atDoorAt: number | null;
  /** Apparitions en attente à la fin de la salle (embuscades non déclenchées). */
  pendingAtEnd: number | null;
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
  mirror: MirrorTrace;
}

/** Joue le niveau de bout en bout en surveillant la règle du pont et l'ordre des embuscades des Bassins-Miroirs. */
function play(n: number, opts: { startRoomIndex?: number; seed?: number } = {}): Play {
  const run = newLevel7Run(n, opts);
  const out = { crossingHits: 0, crossingSteps: 0, trappedSteps: 0 };
  const mirror: MirrorTrace = { islandAt: null, eastAt: null, firstRuneAt: null, atDoorAt: null, pendingAtEnd: null };
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
        // le centre du joueur ne doit jamais être dans une tuile solide
        if (isTileBlockedByMechanism(room, run.state.room.mechanisms, tx, ty)) out.trappedSteps++;
      }
      if (onBridge) {
        out.crossingSteps++;
        out.crossingHits += events.filter((e) => e.type === 'playerHit').length;
      }
    }
    if (room.id === 'mirrorpools' && run.state.phase === 'playing') {
      const spawned = (when: string): boolean =>
        room.enemies.some((e, idx) => e.when === when && run.state.room.spawnedSpawnIdx.includes(idx));
      if (mirror.islandAt === null && spawned('enter:islandZone')) mirror.islandAt = run.timeMs;
      if (mirror.eastAt === null && spawned('enter:eastZone')) mirror.eastAt = run.timeMs;
      const st = run.mech('mirrorRunes');
      if (mirror.firstRuneAt === null && st.type === 'runePuzzle' && (st.progress >= 1 || st.active)) mirror.firstRuneAt = run.timeMs;
      const door = run.mechDef('mirrorDoor');
      if (mirror.atDoorAt === null && door.type === 'door') {
        const [dx, dy] = door.tiles[0];
        if (run.alivePlayers().some((p) => Math.abs(p.pos.x / TILE - dx) < 2 && Math.abs(p.pos.y / TILE - dy) < 3)) mirror.atDoorAt = run.timeMs;
      }
      mirror.pendingAtEnd = run.pendingSpawnCount(false);
    }
    return events;
  };
  const result = runLevelScripts(run, level7Scripts(), { maxTotalMs: 20 * 60 * 1000, maxRoomMs: 240000, maxWipesPerRoom: 4 });
  return { run, result, ...out, mirror };
}

describe('niveau 7 : terminable de bout en bout (bots, simulation réelle)', () => {
  for (const n of [1, 2, 3, 4]) {
    it(`${n} joueur(s) : niveau terminé, durée simulée dans la fenêtre cible, équité, règle du pont, embuscades`, () => {
      const p = play(n);
      const { run, result } = p;
      const chars = level7RunOptions(n).characters.join(', ');
      console.info(
        `\n[level7] ${n} joueur(s) (${chars}, difficulté ${LEVEL7_DIFFICULTY[n]}) : ${result.completed ? 'TERMINÉ' : 'ÉCHEC'} en ${secs(result.timeMs)} simulées, ${run.stats.wipes} défaite(s) collective(s), ${p.crossingSteps} pas sur le pont (${p.crossingHits} coup reçu)`,
      );
      for (const r of run.stats.rooms) {
        const first = run.stats.rooms.indexOf(r) === 0 ? 0 : (run.stats.rooms[run.stats.rooms.indexOf(r) - 1].clearedAtMs ?? 0);
        const dur = r.clearedAtMs === null ? r.timeMs : r.clearedAtMs - first;
        console.info(
          `[level7]   ${String(r.roomIndex + 1)}. ${r.roomId.padEnd(11)} ${secs(dur).padStart(8)}  à terre ${r.downs.reduce((a, b) => a + b, 0)}  défaites ${r.wipes}  PV perdus ${Math.round(r.hpLost.reduce((a, b) => a + b, 0))}`,
        );
      }
      console.info(formatStats(run));
      expect(result.failure, result.failure ?? '').toBeNull();
      expect(result.completed).toBe(true);
      expect(run.state.phase).toBe('levelComplete');
      // Durée cible : 5 minutes au moins, plafonds mesurés dans `durationWindows.ts` (balayage de graines : `durationWindows.run.test.ts`). Le solo est le cas le plus long : les bots n'ont aucun soin (ni butin ni cristaux)
      // et perdent une fois collectivement au demi-boss n°2 ; cette défaite remet les PV à plein et coûte ≈ 80 s.
      expect(result.timeMs, 'durée simulée trop courte').toBeGreaterThanOrEqual(5 * 60 * 1000);
      expect(result.timeMs, 'durée simulée trop longue').toBeLessThanOrEqual(durationCapMs(7, n));
      // Aucune action de script échouée, toutes les salles validées, tous les objectifs accomplis.
      expect(run.failures).toEqual([]);
      expect(run.state.clearedRooms).toEqual(level7.rooms.map((r) => r.id));
      expect(run.state.objectives.every((o) => o.done)).toBe(true);
      // Équité (les bots n'esquivent pas intelligemment) : ≤ 2 défaites collectives par salle, ≤ 5 au total.
      for (const r of run.stats.rooms) expect(r.wipes, `défaites dans ${r.roomId}`).toBeLessThanOrEqual(2);
      expect(run.stats.wipes).toBeLessThanOrEqual(5);
      // Règle du pont : il a bien été franchi, sans aucun coup reçu dessus, et personne n'a été piégé dans une tuile solide.
      expect(p.crossingSteps, 'le pont doit avoir été traversé').toBeGreaterThan(50);
      expect(p.crossingHits, 'aucun coup reçu pendant la traversée').toBe(0);
      expect(p.trappedSteps, 'aucun joueur dans une tuile solide').toBe(0);
      // Embuscades : l'île se déclenche AVANT la première rune, la rive est AVANT que quiconque atteigne la porte, et plus rien « d'invisible » ne reste en attente.
      const m = p.mirror;
      expect(m.islandAt, "l'embuscade de l'île doit se déclencher").not.toBeNull();
      expect(m.eastAt, "l'embuscade de la rive est doit se déclencher").not.toBeNull();
      expect(m.islandAt as number, "l'île avant la première rune").toBeLessThanOrEqual(m.firstRuneAt as number);
      expect(m.eastAt as number, 'la rive est après la porte ouverte').toBeGreaterThanOrEqual(m.firstRuneAt as number);
      expect(m.pendingAtEnd, 'aucune apparition en attente à la fin des Bassins-Miroirs').toBe(0);
    }, 300_000);
  }

  it('est déterministe : deux parties identiques (2 joueurs, à partir de l\'Écluse) donnent la même durée et les mêmes statistiques', () => {
    const a = play(2, { startRoomIndex: 4 });
    const b = play(2, { startRoomIndex: 4 });
    expect(a.result.timeMs).toBe(b.result.timeMs);
    expect(JSON.stringify(a.run.stats)).toBe(JSON.stringify(b.run.stats));
  }, 300_000);

  it('les personnages et difficultés des bots sont documentés (difficulté 2 partout, solo compris)', () => {
    expect(LEVEL7_CHARACTERS[1]).toHaveLength(1);
    expect(LEVEL7_CHARACTERS[4]).toHaveLength(4);
    for (const n of [1, 2, 3, 4]) expect(LEVEL7_DIFFICULTY[n]).toBe(2);
  });
});

// ───────────────────────────── « Phare et Écho » ─────────────────────────────

const IDLE = { moveX: 0, moveY: 0, attack: false, interact: false, revive: false };
const PRESS = { ...IDLE, interact: true };

function centre(t: readonly [number, number]): { x: number; y: number } {
  return { x: (t[0] + 0.5) * TILE, y: (t[1] + 0.5) * TILE };
}

describe('niveau 7 : Bassins-Miroirs — le pont est indispensable, la séquence se rejoue sans pénalité', () => {
  it('(2 joueurs) sans le porteur de la lanterne, l\'autre joueur n\'a aucun chemin vers l\'île', () => {
    const run = newLevel7Run(2, { startRoomIndex: 3 });
    // le porteur est le héros du slot 0 (J1) ; J2 tente seul la traversée vers l'atterrissage
    const bridge = run.room.mechanisms.find((m): m is LightBridgeDef => m.type === 'lightBridge');
    expect(bridge?.lanternSlot).toBe(0);
    const landing = bridge!.tiles[bridge!.tiles.length - 1];
    run.queue(1, goTo(landing, { onUnreachable: 'fail', unreachableGraceMs: 800 }));
    run.stepFor(5000);
    expect(run.failures.some((f) => /aucun chemin/.test(f.reason))).toBe(true);
    expect(run.player(1).pos.x).toBeLessThan(26 * TILE);
  });

  it('la séquence est lue par le héros ROUGE (slot 1) et jouée sur une île que seul le pont du héros BLEU (slot 0) atteint', () => {
    const run = newLevel7Run(4, { startRoomIndex: 3 });
    run.stepOnce();
    const runes = run.mechDef('mirrorRunes') as RunePuzzleDef;
    expect(runes.visibleToSlot).toBe(1);
    const st = run.mech('mirrorBridge');
    expect(st.type === 'lightBridge' && st.bearerId).toBe(0);
  });

  it('une rune fausse remet la séquence à zéro SANS aucune pénalité : on peut rejouer à l\'infini jusqu\'à la porte ouverte', () => {
    const run = newLevel7Run(2, { startRoomIndex: 3 });
    run.stepOnce();
    const runes = run.mechDef('mirrorRunes') as RunePuzzleDef;
    const tileOf = (symbol: string) => (runes.pedestals.find((q) => q.symbol === symbol) as { tile: [number, number] }).tile;
    const press = (symbol: string): void => {
      run.player(0).pos = centre(tileOf(symbol));
      run.state.room.enemies.splice(0);
      run.stepOnce({ 0: IDLE, 1: IDLE });
      run.stepOnce({ 0: PRESS, 1: IDLE });
      run.stepOnce({ 0: IDLE, 1: IDLE });
    };
    const progress = (): number => {
      const st = run.mech('mirrorRunes');
      return st.type === 'runePuzzle' ? st.progress : -1;
    };
    // bonne rune, puis rune FAUSSE (la 3e de la séquence est « star » : on joue « sun »)
    press(runes.sequence[0]);
    expect(progress()).toBe(1);
    press('sun');
    expect(progress()).toBe(0);
    expect(run.mechSolved('mirrorRunes')).toBe(false);
    for (let i = 0; i < 3; i++) {
      press(runes.sequence[0]);
      press('sun');
      expect(progress()).toBe(0);
    }
    // aucune pénalité : tous les héros vivants, la porte reste fermée, la salle reste jouable
    expect(run.alivePlayers()).toHaveLength(2);
    expect(run.mechSolved('mirrorDoor')).toBe(false);
    // la bonne séquence ouvre la porte
    for (const s of runes.sequence) press(s);
    expect(run.mechSolved('mirrorRunes')).toBe(true);
    for (let i = 0; i < 3; i++) run.stepOnce({ 0: IDLE, 1: IDLE });
    expect(run.mechSolved('mirrorDoor')).toBe(true);
    expect(run.state.phase).toBe('playing');
  });
});

// ───────────────────────────── « Chœur » ─────────────────────────────

describe('niveau 7 : Chœur de Nacre — les leviers à fenêtre ne comptent que « presque ensemble »', () => {
  /** Place un héros à côté de son levier (tuile du dessous) et vide la salle d'ennemis à chaque pas (on ne mesure que les leviers). */
  function setup(n: number): BotRun {
    const run = newLevel7Run(n, { startRoomIndex: 5 });
    run.stepOnce();
    for (let slot = 0; slot < n; slot++) {
      const lever = level7.rooms[5].mechanisms.find((m) => m.id === `choirLever${['Blue', 'Red', 'Green', 'Yellow'][slot]}`);
      if (!lever || lever.type !== 'lever') throw new Error('levier introuvable');
      run.player(run.playerFor(slot)).pos = centre([lever.tile[0], lever.tile[1] + (slot < 2 ? -1 : 1)]);
    }
    return run;
  }
  const step = (run: BotRun, frames: Record<number, typeof IDLE>): void => {
    run.state.room.enemies.splice(0);
    run.stepOnce(frames);
  };
  const idleAll = (n: number): Record<number, typeof IDLE> => Object.fromEntries(Array.from({ length: n }, (_, i) => [i, IDLE]));
  const wait = (run: BotRun, n: number, ms: number): void => {
    for (let t = 0; t < ms; t += SIM_STEP_MS) step(run, idleAll(n));
  };

  it('à 1 joueur, seul le levier bleu existe : un seul geste ouvre la porte (les autres leviers sont neutralisés)', () => {
    const run = setup(1);
    for (const c of ['Red', 'Green', 'Yellow']) expect(run.mech(`choirLever${c}`).waived, c).toBe(true);
    expect(run.mech('choirLeverBlue').waived).toBe(false);
    step(run, { 0: IDLE });
    step(run, { 0: PRESS });
    wait(run, 1, 300);
    expect(run.mechSolved('choirDoor')).toBe(true);
    expect(run.requirementMet('obj:chime')).toBe(true);
  });

  it('à 2 joueurs, deux leviers tirés à plus de 10 s d\'écart ne comptent pas : le premier retombe, on rejoue sans pénalité', () => {
    const run = setup(2);
    step(run, { 0: IDLE, 1: IDLE });
    step(run, { 0: PRESS, 1: IDLE });
    expect(run.mechSolved('choirLeverBlue')).toBe(true);
    wait(run, 2, 12000); // fenêtre de 10 s écoulée : le levier bleu est retombé
    expect(run.mechSolved('choirLeverBlue')).toBe(false);
    step(run, { 0: IDLE, 1: PRESS });
    expect(run.mechSolved('choirLeverRed')).toBe(true);
    expect(run.mechSolved('choirDoor')).toBe(false);
    wait(run, 2, 300);
    expect(run.mechSolved('choirDoor')).toBe(false);
    // on rejoue : bleu puis rouge à 3 s d'écart → la porte s'ouvre, et reste ouverte
    wait(run, 2, 11000);
    step(run, { 0: PRESS, 1: IDLE });
    step(run, { 0: IDLE, 1: IDLE });
    wait(run, 2, 3000);
    step(run, { 0: IDLE, 1: PRESS });
    wait(run, 2, 500);
    expect(run.mechSolved('choirDoor')).toBe(true);
    wait(run, 2, 15000);
    expect(run.mechSolved('choirDoor')).toBe(true);
    expect(run.alivePlayers()).toHaveLength(2);
  });

  it('à 4 joueurs, les quatre leviers (10 à 11 tuiles d\'écart) se tirent dans la fenêtre et la porte reste ouverte', () => {
    const run = setup(4);
    step(run, idleAll(4));
    step(run, { 0: PRESS, 1: IDLE, 2: IDLE, 3: IDLE });
    step(run, idleAll(4));
    wait(run, 4, 2000);
    step(run, { 0: IDLE, 1: PRESS, 2: IDLE, 3: IDLE });
    step(run, idleAll(4));
    wait(run, 4, 2000);
    step(run, { 0: IDLE, 1: IDLE, 2: PRESS, 3: IDLE });
    step(run, idleAll(4));
    wait(run, 4, 2000);
    step(run, { 0: IDLE, 1: IDLE, 2: IDLE, 3: PRESS });
    wait(run, 4, 500);
    expect(run.mechSolved('choirDoor')).toBe(true);
    wait(run, 4, 15000);
    expect(run.mechSolved('choirDoor')).toBe(true);
  });
});

// ───────────────────────────── Solo ─────────────────────────────

describe('niveau 7 : solo à la difficulté par défaut (2)', () => {
  it('boss final : une archère (Aelith) vainc l\'écho de Morvane en solo à difficulté 2, graines 7, 1 et 2 (≤ 2 défaites)', () => {
    expect(LEVEL7_SOLO_BOSS).toEqual({ character: 'aelith', difficulty: 2 });
    for (const seed of [7, 1, 2]) {
      const run = newLevel7SoloBossRun({ seed });
      const result = runLevelScripts(run, level7Scripts(), { maxTotalMs: 20 * 60 * 1000, maxRoomMs: 240000, maxWipesPerRoom: 4 });
      console.info(`[level7] solo boss (aelith, difficulté 2, graine ${seed}) : ${result.completed ? 'TERMINÉ' : 'ÉCHEC'} en ${secs(result.timeMs)}, ${run.stats.wipes} défaite(s)`);
      expect(result.failure, `graine ${seed} : ${result.failure ?? ''}`).toBeNull();
      expect(result.completed, `graine ${seed}`).toBe(true);
      expect(run.state.phase).toBe('levelComplete');
      expect(run.stats.wipes, `graine ${seed} : défaites`).toBeLessThanOrEqual(2);
    }
  }, 300_000);

  it('boss final : David (mêlée) vainc aussi l\'écho de Morvane en solo à difficulté 2 (graines 7, 1 et 2, ≤ 2 défaites)', () => {
    for (const seed of [7, 1, 2]) {
      const run = newLevel7SoloBossRun({ seed, character: 'david', difficulty: 2 });
      const result = runLevelScripts(run, level7Scripts(), { maxTotalMs: 20 * 60 * 1000, maxRoomMs: 240000, maxWipesPerRoom: 4 });
      console.info(`[level7] solo boss (david, difficulté 2, graine ${seed}) : ${result.completed ? 'TERMINÉ' : 'ÉCHEC'} en ${secs(result.timeMs)}, ${run.stats.wipes} défaite(s)`);
      expect(result.failure, `graine ${seed} : ${result.failure ?? ''}`).toBeNull();
      expect(result.completed, `graine ${seed}`).toBe(true);
      expect(run.stats.wipes, `graine ${seed} : défaites`).toBeLessThanOrEqual(2);
    }
  }, 300_000);
});
