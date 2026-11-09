/**
 * Cristaux de soin des salles de boss / demi-boss (niveaux 1 à 6) : présence dans TOUTES ces salles (et seulement elles), structure 2 + 1
 * (le 3e à partir de 3 joueurs), validité (`validateLevel`), et règles de validation (case praticable, accessible, loin des arrivées et du
 * départ des boss, ids uniques, pas de recouvrement). Plus un test d'intégration : le soin fonctionne dans chaque salle réelle.
 */
import { describe, expect, it } from 'vitest';
import { HEAL_CRYSTAL_HEAL, HEAL_CRYSTAL_MIN_BOSS_TILES, HEAL_CRYSTAL_MIN_SPAWN_TILES } from '../core/balance';
import { SIM_STEP_MS, TILE } from '../core/constants';
import { isAnyBossKind } from '../core/enemies';
import { makeTestLayout, makeTestLevel, makeTestRoom, validateLevel } from '../core/levelValidation';
import { createSimulation } from '../core/simulation';
import type { HealCrystalDef, LevelDef, RoomDef } from '../core/types';
import { LEVELS } from './index';

const bossRooms: { level: LevelDef; room: RoomDef; index: number }[] = [];
for (const level of LEVELS) {
  level.rooms.forEach((room, index) => {
    if (room.enemies.some((e) => isAnyBossKind(e.kind))) bossRooms.push({ level, room, index });
  });
}

describe('cristaux de soin : couverture des salles de boss / demi-boss', () => {
  it('les 11 salles de boss ou de demi-boss des niveaux 1 à 6 sont recensées (le niveau 1 n\'en a pas)', () => {
    expect(bossRooms.map((b) => `${b.level.id}:${b.room.id}`)).toEqual([
      'level2:arene',
      'level3:throne',
      'level4:warden1',
      'level4:antechamber',
      'level4:throne',
      'level5:cinderpit',
      'level5:emberhold',
      'level5:forgeheart',
      'level6:wraithhall',
      'level6:hearth',
      'level6:throne',
    ]);
    expect(LEVELS[0].rooms.some((r) => r.enemies.some((e) => isAnyBossKind(e.kind)))).toBe(false);
  });

  for (const { level, room } of bossRooms) {
    it(`${level.id} / ${room.id} : 2 cristaux dès 1 joueur + un 3e (minPlayers 3)`, () => {
      const cs = room.healCrystals ?? [];
      expect(cs).toHaveLength(3);
      expect(cs.filter((c) => (c.minPlayers ?? 1) === 1)).toHaveLength(2);
      expect(cs.filter((c) => c.minPlayers === 3)).toHaveLength(1);
      expect(new Set(cs.map((c) => c.id)).size).toBe(3);
    });
  }

  it('aucune autre salle n\'a de cristal (sources de vie fixes réservées aux salles de boss / demi-boss)', () => {
    for (const level of LEVELS) {
      for (const room of level.rooms) {
        if (room.enemies.some((e) => isAnyBossKind(e.kind))) continue;
        expect(room.healCrystals ?? [], `${level.id}/${room.id}`).toEqual([]);
      }
    }
  });

  it('chaque niveau reste valide (cristaux : sol praticable, accessibles, loin des arrivées et des boss)', () => {
    for (const level of LEVELS) expect(validateLevel(level), level.id).toEqual([]);
  });

  it('distances de placement vérifiées directement : >= 8 tuiles des arrivées, >= 17 tuiles du départ de tout boss, hors de la sortie', () => {
    for (const { level, room } of bossRooms) {
      for (const c of room.healCrystals ?? []) {
        const where = `${level.id}/${room.id}/${c.id}`;
        for (const sp of room.playerSpawns) expect(Math.hypot(sp[0] - c.tile[0], sp[1] - c.tile[1]), where).toBeGreaterThanOrEqual(HEAL_CRYSTAL_MIN_SPAWN_TILES);
        for (const e of room.enemies.filter((x) => isAnyBossKind(x.kind))) {
          expect(Math.hypot(e.tile[0] - c.tile[0], e.tile[1] - c.tile[1]), where).toBeGreaterThanOrEqual(HEAL_CRYSTAL_MIN_BOSS_TILES);
        }
        const ex = room.exit.rect;
        const inExit = c.tile[0] >= ex.x && c.tile[0] < ex.x + ex.w && c.tile[1] >= ex.y && c.tile[1] < ex.y + ex.h;
        expect(inExit, where).toBe(false);
      }
    }
  });
});

describe('cristaux de soin : intégration dans les vraies salles', () => {
  for (const { level, room, index } of bossRooms) {
    it(`${level.id} / ${room.id} : 2 cristaux à 1 et 2 joueurs, 3 à 3 et 4 ; un joueur blessé posé dessus récupère 50 PV, une seule fois`, () => {
      for (const n of [1, 2, 3, 4]) {
        const players = Array.from({ length: n }, (_, i) => ({ id: i as 0 | 1 | 2 | 3, characterId: 'david' as const, difficulty: 2 as const }));
        const sim = createSimulation({ levelId: level.id, players, seed: 5, startRoomIndex: index }, level);
        sim.step(SIM_STEP_MS, {});
        expect(sim.state.room.healCrystals?.length, `n=${n}`).toBe(n >= 3 ? 3 : 2);
        if (n !== 1) continue;
        const def = (room.healCrystals as HealCrystalDef[])[0];
        const p = sim.state.players[0];
        p.hp = 1;
        p.invulnMs = 1e9;
        p.pos = { x: (def.tile[0] + 0.5) * TILE, y: (def.tile[1] + 0.5) * TILE };
        sim.step(SIM_STEP_MS, {});
        expect(p.hp, `${room.id}`).toBe(Math.min(p.maxHp, 1 + HEAL_CRYSTAL_HEAL));
        expect(sim.state.room.healCrystals?.find((c) => c.id === def.id)?.used).toBe(true);
      }
    });
  }
});

describe('validation des cristaux de soin (levelValidation)', () => {
  /** Grande salle 40×12 : spawns à gauche, golem à droite (en [34, 10]), un cristal valide en [16, 8]. */
  function mk(crystals: HealCrystalDef[], over: Partial<RoomDef> = {}): LevelDef {
    const room = makeTestRoom({
      id: 'r1',
      layout: makeTestLayout(40, 12),
      enemies: [{ kind: 'golem', tile: [34, 10] }],
      exit: { rect: { x: 36, y: 5, w: 2, h: 2 }, requires: ['p1'], final: true },
      healCrystals: crystals,
      ...over,
    });
    return makeTestLevel({ rooms: [room] });
  }
  const ok: HealCrystalDef = { id: 'c1', tile: [16, 8] };

  it('un cristal bien placé est accepté', () => {
    expect(validateLevel(mk([ok, { id: 'c2', tile: [16, 3], minPlayers: 3 }]))).toEqual([]);
  });

  it('refuse : mur, hors grille, fosse, pilier', () => {
    const wall = validateLevel(mk([{ id: 'c1', tile: [0, 0] }]));
    expect(wall.some((e) => e.includes('cristal de soin') && e.includes('mur'))).toBe(true);
    const out = validateLevel(mk([{ id: 'c1', tile: [99, 99] }]));
    expect(out.some((e) => e.includes('cristal de soin') && e.includes('hors de la grille'))).toBe(true);
    const layout = makeTestLayout(40, 12).map((r, y) => (y === 8 ? r.slice(0, 16) + '~' + r.slice(17) : y === 3 ? r.slice(0, 16) + 'o' + r.slice(17) : r));
    const pit = validateLevel(mk([{ id: 'c1', tile: [16, 8] }], { layout }));
    expect(pit.some((e) => e.includes('cristal de soin') && e.includes('fosse'))).toBe(true);
    const pillar = validateLevel(mk([{ id: 'c1', tile: [16, 3] }], { layout }));
    expect(pillar.some((e) => e.includes('cristal de soin') && e.includes('mur, un pilier'))).toBe(true);
  });

  it(`refuse un cristal à moins de ${HEAL_CRYSTAL_MIN_SPAWN_TILES} tuiles d'une arrivée ou sur une arrivée`, () => {
    const near = validateLevel(mk([{ id: 'c1', tile: [8, 3] }]));
    expect(near.some((e) => e.includes('playerSpawns') && e.includes('trop facile'))).toBe(true);
    const on = validateLevel(mk([{ id: 'c1', tile: [2, 2] }]));
    expect(on.some((e) => e.includes('recouvre playerSpawns'))).toBe(true);
  });

  it(`refuse un cristal à moins de ${HEAL_CRYSTAL_MIN_BOSS_TILES} tuiles du départ d'un boss (zone de danger) ou sur son apparition`, () => {
    const near = validateLevel(mk([{ id: 'c1', tile: [22, 6] }]));
    expect(near.some((e) => e.includes('golem') && e.includes('zone de danger'))).toBe(true);
    const on = validateLevel(mk([{ id: 'c1', tile: [34, 10] }]));
    expect(on.some((e) => e.includes('recouvre l\'apparition'))).toBe(true);
  });

  it('refuse les ids dupliqués, un minPlayers hors 1..4, un recouvrement de porte ou de brasero', () => {
    const dup = validateLevel(mk([ok, { id: 'c1', tile: [16, 3] }]));
    expect(dup.some((e) => e.includes('id de cristal de soin dupliqué'))).toBe(true);
    const bad = validateLevel(mk([{ id: 'c1', tile: [16, 8], minPlayers: 5 }]));
    expect(bad.some((e) => e.includes('minPlayers'))).toBe(true);
    const door = validateLevel(
      mk([ok], { mechanisms: [{ id: 'p1', type: 'plate', tile: [6, 4] }, { id: 'd1', type: 'door', tiles: [[16, 8]], requires: ['p1'] }] }),
    );
    expect(door.some((e) => e.includes('cristal de soin') && e.includes('recouvre la porte'))).toBe(true);
    const brazier = validateLevel(
      mk([ok], { mechanisms: [{ id: 'p1', type: 'plate', tile: [6, 4] }, { id: 'b1', type: 'brazier', tile: [16, 8], lit: true }] }),
    );
    expect(brazier.some((e) => e.includes('cristal de soin') && e.includes('recouvre le brasero'))).toBe(true);
  });

  it('refuse un cristal sur une plaque, un levier, une clé, un panneau ou dans le rectangle de sortie', () => {
    const plate = validateLevel(mk([ok], { mechanisms: [{ id: 'p1', type: 'plate', tile: [16, 8] }] }));
    expect(plate.some((e) => e.includes('cristal de soin') && e.includes('recouvre la plaque "p1"'))).toBe(true);
    const lever = validateLevel(mk([ok], { mechanisms: [{ id: 'l1', type: 'lever', tile: [16, 8] }] }));
    expect(lever.some((e) => e.includes('cristal de soin') && e.includes('recouvre le levier "l1"'))).toBe(true);
    const key = validateLevel(
      mk([ok], { mechanisms: [{ id: 'k1', type: 'key', tile: [16, 8], doorId: 'd1', ownerSlot: 0 }, { id: 'd1', type: 'door', tiles: [[20, 3]], requires: [], keyId: 'k1' }] }),
    );
    expect(key.some((e) => e.includes('cristal de soin') && e.includes('recouvre la clé "k1"'))).toBe(true);
    const sign = validateLevel(mk([ok], { signs: [{ id: 's1', tile: [16, 8], textKey: 'sign.test.s1' }] }));
    expect(sign.some((e) => e.includes('cristal de soin') && e.includes('recouvre le panneau "s1"'))).toBe(true);
    const exit = validateLevel(mk([ok], { exit: { rect: { x: 15, y: 7, w: 3, h: 3 }, requires: ['p1'], final: true } }));
    expect(exit.some((e) => e.includes('cristal de soin') && e.includes('rectangle de sortie'))).toBe(true);
  });

  it('refuse un cristal inaccessible depuis les arrivées (salle coupée par un mur), signalé aux nombres de joueurs concernés', () => {
    const layout = makeTestLayout(40, 12).map((r) => r.slice(0, 20) + '#' + r.slice(21));
    // le 2e cristal (minPlayers 3) est derrière le mur : inaccessible dès n = 3 seulement
    const errs = validateLevel(mk([ok, { id: 'c2', tile: [26, 8], minPlayers: 3 }], { layout, enemies: [{ kind: 'golem', tile: [8, 9] }], exit: { rect: { x: 4, y: 5, w: 2, h: 2 }, requires: ['p1'], final: true } }));
    const e = errs.find((x) => x.includes('cristal de soin "c2"') && x.includes('inatteignable'));
    expect(e).toBeDefined();
    expect(e).toContain('n=3,4');
  });

  it('un cristal à minPlayers supérieur n\'est pas contrôlé en dessous (absent à ce nombre de joueurs)', () => {
    const layout = makeTestLayout(40, 12).map((r) => r.slice(0, 20) + '#' + r.slice(21));
    const errs = validateLevel(mk([{ id: 'c2', tile: [26, 8], minPlayers: 4 }], { layout, enemies: [{ kind: 'golem', tile: [8, 9] }], exit: { rect: { x: 4, y: 5, w: 2, h: 2 }, requires: ['p1'], final: true } }));
    const e = errs.find((x) => x.includes('cristal de soin "c2"') && x.includes('inatteignable'));
    expect(e).toContain('n=4');
    expect(e).not.toContain('n=3');
  });
});
