import { describe, expect, it } from 'vitest';
import { CHARACTER_IDS } from '../core/characters';
import { createSimulation } from '../core/simulation';
import { LEVELS } from '../levels';
import { tutorialLevel } from '../levels/tutorial';
import { isSavingAllowed } from '../render/saveMenuLogic';
import { ATTRACT_DEMO_MS } from './config';
import { DEMO_DIFFICULTY, DEMO_MIN_ENEMIES, analyzeDemoRoom, buildDemoSession, isDemoSession, isSafeDemoRoom, pickDemoStartRoom } from './demoSession';

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('buildDemoSession', () => {
  it('niveau valide de la campagne, JAMAIS le tutoriel ; héros valide ; 1 joueur ; difficulté facile', () => {
    const campaignIds = LEVELS.map((l) => l.id);
    expect(campaignIds).not.toContain(tutorialLevel.id);
    for (let seed = 1; seed <= 300; seed++) {
      const s = buildDemoSession(seeded(seed));
      expect(s.levelIndex).toBeGreaterThanOrEqual(0);
      expect(s.levelIndex).toBeLessThan(LEVELS.length);
      expect(s.tutorial).toBeUndefined();
      expect(s.playerCount).toBe(1);
      expect(s.players).toHaveLength(1);
      expect(s.players[0].id).toBe(0);
      expect(CHARACTER_IDS).toContain(s.players[0].characterId);
      expect(s.players[0].difficulty).toBe(DEMO_DIFFICULTY);
      expect(s.demo).toBeDefined();
      expect(s.demo!.durationMs).toBe(ATTRACT_DEMO_MS);
      expect(Number.isInteger(s.demo!.seed) && s.demo!.seed >= 0).toBe(true);
      const level = LEVELS[s.levelIndex];
      const room = s.startRoomIndex ?? 0;
      expect(room).toBeGreaterThanOrEqual(0);
      expect(room).toBeLessThan(level.rooms.length);
    }
  });

  it('tire des niveaux, des héros et des salles variés (les 6 niveaux et les 8 héros apparaissent)', () => {
    const levels = new Set<number>();
    const heroes = new Set<string>();
    const rooms = new Set<number>();
    for (let seed = 1; seed <= 400; seed++) {
      const s = buildDemoSession(seeded(seed));
      levels.add(s.levelIndex);
      heroes.add(s.players[0].characterId);
      rooms.add(s.startRoomIndex ?? 0);
    }
    expect(levels.size).toBe(LEVELS.length);
    expect(heroes.size).toBe(CHARACTER_IDS.length);
    expect(rooms.size).toBeGreaterThan(3);
  });

  it('déterministe : mêmes valeurs aléatoires ⇒ même session ; le hasard est injecté (jamais Math.random)', () => {
    const a = buildDemoSession(seeded(42));
    const b = buildDemoSession(seeded(42));
    expect(a).toEqual(b);
    const c = buildDemoSession(seeded(43));
    expect(c).not.toEqual(a);
    // un « hasard » constant donne toujours la même session valide, y compris aux bornes
    expect(() => buildDemoSession(() => 0)).not.toThrow();
    expect(() => buildDemoSession(() => 0.9999999999)).not.toThrow();
    expect(() => buildDemoSession(() => 1)).not.toThrow();
    expect(() => buildDemoSession(() => Number.NaN)).not.toThrow();
  });

  it('aucune sauvegarde : isDemoSession vrai et isSavingAllowed faux, aucun niveau « terminé », statistiques vierges', () => {
    const s = buildDemoSession(seeded(7));
    expect(isDemoSession(s)).toBe(true);
    expect(isDemoSession({ demo: undefined })).toBe(false);
    expect(isDemoSession(null)).toBe(false);
    expect(isSavingAllowed({ quick: false, search: '', demo: isDemoSession(s) })).toBe(false);
    expect(s.completedLevelIds).toBeUndefined();
    expect(s.stats.timeMs).toBe(0);
    expect(s.stats.kills).toEqual([0]);
    expect(s.stats.downs).toEqual([0]);
  });

  it('la durée de la démo est paramétrable (?attractDemo)', () => {
    expect(buildDemoSession(seeded(1), { durationMs: 10_000 }).demo!.durationMs).toBe(10_000);
  });

  it('options : un seul niveau / un seul héros imposés', () => {
    const s = buildDemoSession(seeded(5), { levels: [LEVELS[3]], characters: ['mira'] });
    expect(s.levelIndex).toBe(0);
    expect(s.players[0].characterId).toBe('mira');
  });
});

describe('salle de départ « sans danger »', () => {
  it('jamais une salle sombre, à boss / demi-boss, ni la salle finale ; toujours une salle où le héros peut agir', () => {
    for (const level of LEVELS) {
      for (let seed = 1; seed <= 40; seed++) {
        const i = pickDemoStartRoom(level, seeded(seed * 31));
        const room = level.rooms[i];
        if (i === 0) continue; // repli sur la salle 0 : accepté
        expect(isSafeDemoRoom(room), `${level.id} salle ${i}`).toBe(true);
        const a = analyzeDemoRoom(room);
        expect(a.enemiesReachable > 0 || a.exitReachable, `${level.id} salle ${i}`).toBe(true);
      }
    }
  });

  it('non-régression : toute salle retenue fait apparaître au moins un ennemi en solo dès le départ (pas d arène à vagues / coop)', () => {
    LEVELS.forEach((level, li) => {
      for (let seed = 1; seed <= 25; seed++) {
        const i = pickDemoStartRoom(level, seeded(seed * 17 + li));
        const a = analyzeDemoRoom(level.rooms[i]);
        if (a.enemiesReachable === 0) continue; // repli « marche » / salle 0 : hors sujet
        const sim = createSimulation({ levelId: level.id, players: [{ id: 0, characterId: 'david', difficulty: 1 }], seed: 1, startRoomIndex: i }, level);
        expect(sim.state.room.enemies.length, `${level.id} salle ${i}`).toBeGreaterThanOrEqual(1);
      }
    });
  });

  it("niveau 3 : l'arène et l'estrade (ennemis en vagues / coop, vides au départ en solo) ne sont jamais tirées", () => {
    const level = LEVELS[2];
    const picked = new Set<number>();
    for (let seed = 1; seed <= 200; seed++) picked.add(pickDemoStartRoom(level, seeded(seed)));
    for (const i of picked) {
      const total = level.rooms[i].enemies.length;
      if (total > 0) expect(analyzeDemoRoom(level.rooms[i]).enemiesReachable, `salle ${i}`).toBeGreaterThan(0);
    }
    expect(picked.has(6)).toBe(false);
    expect(picked.has(7)).toBe(false);
  });

  it('préfère les salles animées (>= DEMO_MIN_ENEMIES ennemis solo) quand le niveau en a, sinon repli sur les salles de combat', () => {
    for (const level of LEVELS) {
      const lively = level.rooms.some((r) => isSafeDemoRoom(r) && analyzeDemoRoom(r).enemiesReachable >= DEMO_MIN_ENEMIES);
      for (let seed = 1; seed <= 40; seed++) {
        const i = pickDemoStartRoom(level, seeded(seed * 13));
        const a = analyzeDemoRoom(level.rooms[i]);
        if (lively) expect(a.enemiesReachable, `${level.id} salle ${i}`).toBeGreaterThanOrEqual(DEMO_MIN_ENEMIES);
      }
    }
  });

  it('les salles à boss, sombres ou finales sont écartées', () => {
    let flagged = 0;
    for (const level of LEVELS) {
      for (const room of level.rooms) {
        if (!isSafeDemoRoom(room)) flagged++;
      }
    }
    expect(flagged).toBeGreaterThan(0); // la campagne contient bien de telles salles
    const last = LEVELS[0].rooms[LEVELS[0].rooms.length - 1];
    expect(isSafeDemoRoom(last)).toBe(false);
  });

  it('un niveau sans salle sûre retombe sur la salle 0', () => {
    const level = { ...LEVELS[0], rooms: [LEVELS[0].rooms[LEVELS[0].rooms.length - 1]] };
    expect(pickDemoStartRoom(level, () => 0.5)).toBe(0);
  });
});
