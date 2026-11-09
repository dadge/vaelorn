/**
 * Pilote automatique du mode démo : sur CHAQUE niveau de la campagne × CHAQUE héros jouable × plusieurs graines, 30 s simulées
 * (headless, vraie simulation) : aucune exception, le héros se déplace réellement, engage les ennemis, ne reste pas bloqué,
 * calcul borné, déterminisme.
 */
import { describe, expect, it } from 'vitest';
import { CHARACTER_IDS } from '../core/characters';
import { SIM_STEP_MS } from '../core/constants';
import { pointInTileRect } from '../core/geometry';
import { createSimulation } from '../core/simulation';
import type { CharacterId, GameState, LevelDef, SimEvent } from '../core/types';
import { LEVELS } from '../levels';
import { ATTRACT_DEMO_MS } from './config';
import { DemoPilot, type PilotStats } from './DemoPilot';
import { buildDemoSession } from './demoSession';

/** Mulberry32 local aux tests (générateur injecté : jamais `Math.random`). */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface DemoRunResult {
  levelId: string;
  hero: CharacterId;
  startRoom: number;
  steps: number;
  /** Distance totale parcourue (px) pendant les pas où le jeu tourne. */
  traveled: number;
  /** Nombre d'ennemis touchés (événements `enemyHit` causés par le héros). */
  hits: number;
  kills: number;
  /** Ennemis présents au moins une fois dans la salle de départ ou les suivantes. */
  enemiesSeen: number;
  wipes: number;
  roomsEntered: number;
  /** Plus longue immobilité (ms) hors combat / hors attente à la sortie. */
  maxStallMs: number;
  /** Temps de calcul moyen du pilote par pas (ms). */
  avgDecideMs: number;
  maxDecideMs: number;
  /** Pas dont le calcul a dépassé 25 ms (rares pics : ramasse-miettes, machine chargée par les autres tests en parallèle). */
  slowSteps: number;
  stats: PilotStats;
  finalState: GameState;
  signature: string;
}

/**
 * Joue une démo headless : session construite comme le fait le menu (niveau / salle / héros imposés pour le balayage), simulation
 * réelle, pilote branché sur le joueur 0, `durationMs` de temps de jeu.
 */
function runDemo(level: LevelDef, hero: CharacterId, simSeed: number, pilotSeed: number, startRoom: number, durationMs = ATTRACT_DEMO_MS): DemoRunResult {
  const sim = createSimulation(
    { levelId: level.id, players: [{ id: 0, characterId: hero, difficulty: 1 }], seed: simSeed, startRoomIndex: startRoom },
    level,
  );
  const pilot = new DemoPilot(sim, { seed: pilotSeed });
  const steps = Math.round(durationMs / SIM_STEP_MS);
  let traveled = 0;
  let hits = 0;
  let kills = 0;
  let wipes = 0;
  let roomsEntered = 0;
  let enemiesSeen = 0;
  const seenIds = new Set<string>();
  let stallAnchor = { x: sim.state.players[0].pos.x, y: sim.state.players[0].pos.y };
  let stallMs = 0;
  let maxStallMs = 0;
  let decideTotal = 0;
  let maxDecide = 0;
  let slowSteps = 0;
  let sig = 0;
  let prev = { x: stallAnchor.x, y: stallAnchor.y };
  for (let i = 0; i < steps; i++) {
    const t0 = performance.now();
    const f = pilot.decide(sim.state);
    const dt = performance.now() - t0;
    decideTotal += dt;
    if (dt > maxDecide) maxDecide = dt;
    if (dt > 25) slowSteps++;
    const events: SimEvent[] = sim.step(SIM_STEP_MS, { 0: f });
    const p = sim.state.players[0];
    for (const e of events) {
      if (e.type === 'enemyHit' && e.byPlayer === 0) hits++;
      else if (e.type === 'enemyDied' && e.byPlayer === 0) kills++;
      else if (e.type === 'teamWipe') wipes++;
      else if (e.type === 'roomEntered' && e.reason !== 'start') roomsEntered++;
    }
    for (const en of sim.state.room.enemies) {
      const key = `${sim.state.roomIndex}:${en.id}`;
      if (!seenIds.has(key)) {
        seenIds.add(key);
        enemiesSeen++;
      }
    }
    if (sim.state.phase === 'playing' && p.status === 'alive') traveled += Math.hypot(p.pos.x - prev.x, p.pos.y - prev.y);
    prev = { x: p.pos.x, y: p.pos.y };
    // immobilité : on ne compte pas le combat (attaque), l'attente dans la zone de sortie, ni les phases hors jeu
    const exempt = f.attack || sim.state.phase !== 'playing' || p.status !== 'alive' || pointInTileRect(p.pos, sim.room.exit.rect) || p.specialAnimMs > 0;
    if (exempt || Math.hypot(p.pos.x - stallAnchor.x, p.pos.y - stallAnchor.y) >= 8) {
      stallAnchor = { x: p.pos.x, y: p.pos.y };
      stallMs = 0;
    } else {
      stallMs += SIM_STEP_MS;
      if (stallMs > maxStallMs) maxStallMs = stallMs;
    }
    sig = (Math.imul(sig, 31) + Math.round(p.pos.x * 16) + Math.imul(Math.round(p.pos.y * 16), 7) + (f.attack ? 3 : 0) + (f.special ? 5 : 0)) | 0;
  }
  return {
    levelId: level.id,
    hero,
    startRoom,
    steps,
    traveled,
    hits,
    kills,
    enemiesSeen,
    wipes,
    roomsEntered,
    maxStallMs,
    avgDecideMs: decideTotal / steps,
    maxDecideMs: maxDecide,
    slowSteps,
    stats: { ...pilot.stats },
    finalState: sim.state,
    signature: `${sig}|${sim.state.tick}|${sim.state.roomIndex}|${sim.state.players[0].pos.x.toFixed(2)},${sim.state.players[0].pos.y.toFixed(2)}|${sim.state.players[0].hp}`,
  };
}

/** Salle de départ d'un run du balayage (celle que la démo tirerait pour cette graine). */
function startRoomFor(levelIndex: number, seed: number): number {
  const s = buildDemoSession(seeded(seed * 7919 + levelIndex), { levels: [LEVELS[levelIndex]], characters: ['david'] });
  return s.startRoomIndex ?? 0;
}

const SEEDS = [11, 23];
const results: DemoRunResult[] = [];

describe('DemoPilot : 30 s simulées sur les 6 niveaux × tous les héros × plusieurs graines', () => {
  it('balayage complet : aucune exception, déplacement réel, combats, pas de blocage prolongé', () => {
    for (let li = 0; li < LEVELS.length; li++) {
      for (const hero of CHARACTER_IDS) {
        for (const seed of SEEDS) {
          const startRoom = startRoomFor(li, seed);
          const r = runDemo(LEVELS[li], hero, seed, seed + 1, startRoom);
          results.push(r);
        }
      }
    }
    expect(results.length).toBe(LEVELS.length * CHARACTER_IDS.length * SEEDS.length);
  });

  it('le héros se déplace réellement (distance parcourue minimale) sur CHAQUE run', () => {
    const bad = results.filter((r) => r.traveled < 80);
    expect(bad.map((r) => `${r.levelId}/${r.hero}/salle ${r.startRoom} : ${r.traveled.toFixed(0)} px`)).toEqual([]);
  });

  it('il engage les ennemis quand il y en a : au moins un coup sur la grande majorité des runs avec ennemis', () => {
    const withEnemies = results.filter((r) => r.enemiesSeen > 0);
    expect(withEnemies.length).toBeGreaterThan(results.length * 0.5);
    const fought = withEnemies.filter((r) => r.hits > 0);
    const ratio = fought.length / withEnemies.length;
    const missed = withEnemies.filter((r) => r.hits === 0).map((r) => `${r.levelId}/${r.hero}/salle ${r.startRoom}`);
    expect(ratio, `runs sans aucun coup : ${missed.join(', ')}`).toBeGreaterThanOrEqual(0.85);
  });

  it('il n\'est jamais bloqué plus de ~3 s d\'affilée (hors combat et attente à la sortie)', () => {
    const bad = results.filter((r) => r.maxStallMs > 3200);
    expect(bad.map((r) => `${r.levelId}/${r.hero}/salle ${r.startRoom} : ${(r.maxStallMs / 1000).toFixed(1)} s`)).toEqual([]);
  });

  it('temps de calcul borné : < 5 ms par pas en moyenne (budget demandé : 50 ms), quasi aucun pas lent', () => {
    const avg = results.reduce((a, r) => a + r.avgDecideMs, 0) / results.length;
    const worstAvg = Math.max(...results.map((r) => r.avgDecideMs));
    const worstPeak = Math.max(...results.map((r) => r.maxDecideMs));
    const slow = results.reduce((a, r) => a + r.slowSteps, 0);
    const total = results.reduce((a, r) => a + r.steps, 0);
    console.info(`[DemoPilot] calcul : moyenne ${avg.toFixed(3)} ms/pas, pire moyenne ${worstAvg.toFixed(3)} ms, pic ${worstPeak.toFixed(1)} ms, ${slow} pas > 25 ms sur ${total}`);
    expect(worstAvg).toBeLessThan(5);
    // les pics isolés (ramasse-miettes, préemption par les autres fichiers de test en parallèle : mesure d'horloge murale) ne sont pas un défaut du pilote : on borne leur fréquence (0,3 %, mesuré à 0 en isolation, ~0,05 % sous charge)
    expect(slow / total).toBeLessThan(0.003);
  });

  it('le chemin est mis en cache : peu de plans par seconde (pas de recalcul à chaque pas)', () => {
    for (const r of results) {
      const perStep = r.stats.plans / r.steps;
      expect(perStep, `${r.levelId}/${r.hero}/salle ${r.startRoom}`).toBeLessThan(0.25);
    }
  });

  it('rapport', () => {
    const wiped = results.filter((r) => r.wipes > 0).length;
    const alive = results.filter((r) => r.finalState.players[0].status === 'alive').length;
    const meanTravel = results.reduce((a, r) => a + r.traveled, 0) / results.length;
    const meanHits = results.reduce((a, r) => a + r.hits, 0) / results.length;
    const stuck = results.reduce((a, r) => a + r.stats.stuck, 0);
    const patrols = results.reduce((a, r) => a + r.stats.patrols, 0);
    const specials = results.reduce((a, r) => a + r.stats.specials, 0);
    const withEnemies = results.filter((r) => r.enemiesSeen > 0);
    const fought = withEnemies.filter((r) => r.hits > 0).length;
    console.info(`[DemoPilot] runs avec ennemis : ${withEnemies.length}, dont ${fought} avec au moins un coup porté`);
    console.info(
      `[DemoPilot] ${results.length} runs : ${wiped} avec mort d'équipe, ${alive} héros debout à la fin, distance moyenne ${meanTravel.toFixed(0)} px, ` +
        `coups moyens ${meanHits.toFixed(1)}, blocages ${stuck}, patrouilles ${patrols}, spéciaux ${specials}`,
    );
    expect(results.length).toBeGreaterThan(0);
  });
});

describe('DemoPilot : robustesse sur TOUTES les salles (même sombres, à boss, énigmes fermées)', () => {
  it('aucune exception ni valeur aberrante sur chaque salle de chaque niveau, héros de mêlée et à distance (15 s)', () => {
    let runs = 0;
    for (const level of LEVELS) {
      for (let room = 0; room < level.rooms.length; room++) {
        for (const hero of ['david', 'aelith'] as const) {
          const r = runDemo(level, hero, 100 + room, 200 + room, room, 15_000);
          expect(Number.isFinite(r.traveled), `${level.id}/${hero}/salle ${room}`).toBe(true);
          expect(r.avgDecideMs, `${level.id}/${hero}/salle ${room}`).toBeLessThan(5);
          runs++;
        }
      }
    }
    expect(runs).toBeGreaterThan(40);
  });
});

describe('DemoPilot : déterminisme et cas limites', () => {
  it('mêmes graines et mêmes entrées ⇒ même résultat, pas pour pas', () => {
    const a = runDemo(LEVELS[1], 'brokk', 5, 6, 0, 12_000);
    const b = runDemo(LEVELS[1], 'brokk', 5, 6, 0, 12_000);
    expect(a.signature).toBe(b.signature);
    expect(a.traveled).toBeCloseTo(b.traveled, 6);
  });

  it('une graine de pilote différente peut changer les patrouilles mais reste valide', () => {
    const a = runDemo(LEVELS[0], 'mira', 5, 1, 0, 8_000);
    const b = runDemo(LEVELS[0], 'mira', 5, 2, 0, 8_000);
    expect(Number.isFinite(a.traveled) && Number.isFinite(b.traveled)).toBe(true);
  });

  it('un héros à terre ou une phase hors jeu produit une frame vide', () => {
    const sim = createSimulation({ levelId: LEVELS[0].id, players: [{ id: 0, characterId: 'david', difficulty: 1 }], seed: 3 }, LEVELS[0]);
    const pilot = new DemoPilot(sim);
    const state = sim.state;
    state.players[0].status = 'down';
    const f = pilot.decide(state);
    expect(f.moveX).toBe(0);
    expect(f.moveY).toBe(0);
    expect(f.attack).toBe(false);
    expect(f.special).toBe(false);
    state.players[0].status = 'alive';
    state.phase = 'roomCleared';
    expect(pilot.decide(state).moveX).toBe(0);
  });

  it('ne produit que des ActionFrame valides (nombres finis, norme ≤ 1)', () => {
    const sim = createSimulation({ levelId: LEVELS[2].id, players: [{ id: 0, characterId: 'sandrine', difficulty: 1 }], seed: 9 }, LEVELS[2]);
    const pilot = new DemoPilot(sim, { seed: 4 });
    for (let i = 0; i < 1500; i++) {
      const f = pilot.decide(sim.state);
      expect(Number.isFinite(f.moveX) && Number.isFinite(f.moveY)).toBe(true);
      expect(Math.hypot(f.moveX, f.moveY)).toBeLessThanOrEqual(1.0001);
      sim.step(SIM_STEP_MS, { 0: f });
    }
  });
});
