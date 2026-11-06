import { beforeAll, describe, expect, it } from 'vitest';
import { ROOM_CLEAR_DELAY_MS, TILE, WIPE_RESTART_DELAY_MS } from '../core/constants';
import { makeTestLevel, makeTestRoom } from '../core/levelValidation';
import { createSimulation, type GameSimulation } from '../core/simulation';
import type { LevelDef, ObjectiveDef, ObjectiveState, PlayerSetup, RoomDef } from '../core/types';
import { bannerAlpha, wrapIndex } from '../entities/overlay';
import { setLanguage, t } from '../i18n/i18n';
import {
  HP_PER_HEART,
  MAX_HEARTS,
  SIGN_RANGE,
  bossBarRatio,
  colorNameKey,
  computeContextPrompt,
  computeExitOpen,
  enemiesRemaining,
  nearestEnemyPositions,
  pendingSpawnCount,
  describeObjective,
  fadeAlpha,
  formatPercent,
  heartCount,
  heartFrames,
  keyOwnerSlot,
  nearestSign,
  objectiveTotals,
  reviveRatioFor,
  visibleObjectives,
} from './hud';

beforeAll(() => setLanguage('en'));

const setups = (n: number): PlayerSetup[] =>
  (['david', 'sandrine', 'romain', 'valentine'] as const).slice(0, n).map((characterId, i) => ({ id: i as 0 | 1 | 2 | 3, characterId, difficulty: 2 }));

function makeSim(room: RoomDef, players: number, level?: LevelDef): GameSimulation {
  const lvl = level ?? makeTestLevel({ rooms: [room] });
  return createSimulation({ levelId: lvl.id, players: setups(players), seed: 7 }, lvl);
}

function placePlayer(sim: GameSimulation, id: number, tileX: number, tileY: number): void {
  sim.state.players[id].pos = { x: (tileX + 0.5) * TILE, y: (tileY + 0.5) * TILE };
}

describe('cœurs', () => {
  it('heartCount : 1 cœur = 10 PV, borné', () => {
    expect(HP_PER_HEART).toBe(10);
    expect(heartCount(60)).toBe(6);
    expect(heartCount(65)).toBe(7);
    expect(heartCount(150)).toBe(15);
    expect(heartCount(0)).toBe(1);
    expect(heartCount(Number.NaN)).toBe(1);
    expect(heartCount(99999)).toBe(MAX_HEARTS);
  });

  it('heartFrames : pleins, demi, vides', () => {
    expect(heartFrames(60, 60)).toEqual(Array(6).fill('ui_heart_full'));
    expect(heartFrames(25, 60)).toEqual(['ui_heart_full', 'ui_heart_full', 'ui_heart_half', 'ui_heart_empty', 'ui_heart_empty', 'ui_heart_empty']);
    expect(heartFrames(0, 30)).toEqual(Array(3).fill('ui_heart_empty'));
  });

  it('heartFrames : PV négatifs, NaN ou supérieurs au max sont bornés', () => {
    expect(heartFrames(-5, 20)).toEqual(['ui_heart_empty', 'ui_heart_empty']);
    expect(heartFrames(Number.NaN, 20)).toEqual(['ui_heart_empty', 'ui_heart_empty']);
    expect(heartFrames(500, 20)).toEqual(['ui_heart_full', 'ui_heart_full']);
  });
});

describe('formatPercent / bossBarRatio', () => {
  it('pourcentage borné et arrondi', () => {
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(0.456)).toBe('46%');
    expect(formatPercent(1)).toBe('100%');
    expect(formatPercent(7)).toBe('100%');
    expect(formatPercent(-1)).toBe('0%');
    expect(formatPercent(Number.NaN)).toBe('0%');
  });
  it('barre de boss', () => {
    expect(bossBarRatio({ hp: 50, maxHp: 200 })).toBe(0.25);
    expect(bossBarRatio({ hp: -5, maxHp: 200 })).toBe(0);
    expect(bossBarRatio({ hp: 10, maxHp: 0 })).toBe(0);
    expect(bossBarRatio({ hp: 999, maxHp: 100 })).toBe(1);
  });
});

describe('colorNameKey', () => {
  it('clés hint.slotcolor.<couleur> existantes', () => {
    expect(['hint.slotcolor.blue', 'hint.slotcolor.red', 'hint.slotcolor.green', 'hint.slotcolor.yellow']).toEqual([0, 1, 2, 3].map(colorNameKey));
    expect(colorNameKey(5)).toBe('hint.slotcolor.red');
    expect(t(colorNameKey(0))).not.toBe(colorNameKey(0));
  });
});

describe('describeObjective', () => {
  const kills: ObjectiveDef = { id: 'k', slot: 0, roomId: 'r1', kind: 'kills', labelKey: 'hud.objective', count: 5 };
  const zone: ObjectiveDef = { id: 'z', slot: 0, roomId: 'r1', kind: 'zone', labelKey: 'hud.objective', zoneId: 'zz', seconds: 10 };
  const mech: ObjectiveDef = { id: 'm', slot: 0, roomId: 'r1', kind: 'mechanism', labelKey: 'hud.objective', mechanismId: 'p1' };
  const st = (progress: number, done = false): ObjectiveState => ({ id: 'x', ownerId: 0, done, progress });

  it('kills : compteur n/total et pourcentage', () => {
    const l = describeObjective(kills, st(0.4));
    expect(l.detail).toBe(t('hud.kills', { count: 2, total: 5 }));
    expect(l.percent).toBe('40%');
    expect(l.label).toBe(t('hud.objective'));
    expect(l.done).toBe(false);
  });

  it('zone : secondes restantes et pourcentage', () => {
    const l = describeObjective(zone, st(0.5));
    expect(l.detail).toBe(t('hud.zoneHold', { seconds: 5 }));
    expect(l.percent).toBe('50%');
  });

  it('mécanisme : pas de pourcentage', () => {
    const l = describeObjective(mech, st(0));
    expect(l.detail).toBe('');
    expect(l.percent).toBe('');
  });

  it('accompli : plus de détail ni de pourcentage', () => {
    const l = describeObjective(kills, st(1, true));
    expect(l.done).toBe(true);
    expect(l.detail).toBe('');
    expect(l.percent).toBe('');
  });

  it('progression invalide (NaN, >1) : jamais NaN', () => {
    expect(describeObjective(kills, st(Number.NaN)).percent).toBe('0%');
    expect(describeObjective(kills, st(9)).detail).toBe(t('hud.kills', { count: 5, total: 5 }));
  });
});

describe('objectifs visibles et totaux', () => {
  const r1 = makeTestRoom({ id: 'r1' });
  const r2 = makeTestRoom({ id: 'r2' });
  const level = makeTestLevel({
    rooms: [r1, r2],
    objectives: [
      { id: 'a', slot: 0, roomId: 'r1', kind: 'mechanism', labelKey: 'hud.objective', mechanismId: 'p1' },
      { id: 'b', slot: 0, roomId: 'r2', kind: 'mechanism', labelKey: 'hud.objective', mechanismId: 'p1' },
      { id: 'c', slot: 1, roomId: 'r1', kind: 'mechanism', labelKey: 'hud.objective', mechanismId: 'p1' },
    ],
  });
  const sim = createSimulation({ levelId: 'test', players: setups(2), seed: 1 }, level);

  it('salle 1 : seulement les objectifs de la salle courante du joueur', () => {
    expect(visibleObjectives(sim.state, level, 0, r1).map((l) => l.id)).toEqual(['a']);
    expect(visibleObjectives(sim.state, level, 1, r1).map((l) => l.id)).toEqual(['c']);
  });

  it('salle 2 : l\'objectif non accompli d\'une salle passée reste affiché', () => {
    const ids = visibleObjectives(sim.state, level, 0, r2).map((l) => l.id);
    expect(ids).toEqual(['a', 'b']);
    sim.state.objectives.find((o) => o.id === 'a')!.done = true;
    expect(visibleObjectives(sim.state, level, 0, r2).map((l) => l.id)).toEqual(['b']);
    sim.state.objectives.find((o) => o.id === 'a')!.done = false;
  });

  it('totaux accomplis / total sur tout le niveau', () => {
    expect(objectiveTotals(sim.state, level, 0)).toEqual({ done: 0, total: 2 });
    sim.state.objectives.find((o) => o.id === 'b')!.done = true;
    expect(objectiveTotals(sim.state, level, 0)).toEqual({ done: 1, total: 2 });
  });
});

describe('reviveRatioFor', () => {
  it('0 sans sauveteur, ratio selon la durée du sauveteur sinon', () => {
    const sim = makeSim(makeTestRoom(), 2);
    const [a, b] = sim.state.players;
    expect(reviveRatioFor(b, sim.state.players)).toBe(0);
    b.status = 'down';
    b.reviverId = 0;
    b.reviveProgressMs = 1500;
    const r = reviveRatioFor(b, sim.state.players);
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThanOrEqual(1);
    b.reviveProgressMs = 999999;
    expect(reviveRatioFor(b, sim.state.players)).toBe(1);
    a.status = 'alive';
    b.reviverId = null;
    expect(reviveRatioFor(b, sim.state.players)).toBe(0);
  });
});

describe('fadeAlpha', () => {
  it('ouverture à l\'arrivée, rien au milieu de la salle', () => {
    expect(fadeAlpha('playing', 5000, 0)).toBe(1);
    expect(fadeAlpha('playing', 5000, 275)).toBeCloseTo(0.5, 1);
    expect(fadeAlpha('playing', 5000, 2000)).toBe(0);
  });
  it('fermeture en fin de salle et avant le redémarrage', () => {
    expect(fadeAlpha('roomCleared', 0, 9999)).toBe(0);
    expect(fadeAlpha('roomCleared', ROOM_CLEAR_DELAY_MS, 9999)).toBe(1);
    expect(fadeAlpha('wipe', WIPE_RESTART_DELAY_MS, 9999)).toBe(1);
    expect(fadeAlpha('wipe', 100, 9999)).toBe(0);
    expect(fadeAlpha('levelComplete', 5000, 9999)).toBe(0);
  });
  it('toujours dans [0,1]', () => {
    for (const ph of ['playing', 'roomCleared', 'wipe', 'levelComplete'] as const) {
      for (const pt of [-10, 0, 700, 1700, 99999]) {
        for (const se of [-5, 0, 300, 9999]) {
          const a = fadeAlpha(ph, pt, se);
          expect(a).toBeGreaterThanOrEqual(0);
          expect(a).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

describe('nearestSign / keyOwnerSlot', () => {
  const room = makeTestRoom({ signs: [{ id: 's1', tile: [3, 3], textKey: 'hud.pause' }, { id: 's2', tile: [8, 3], textKey: 'hud.resume' }] });
  it('panneau à portée, le plus proche', () => {
    const p = { pos: { x: 3.5 * TILE + 5, y: 3.5 * TILE }, status: 'alive' as const };
    expect(nearestSign(room, p)?.id).toBe('s1');
    expect(nearestSign(room, { pos: { x: 6 * TILE, y: 3.5 * TILE }, status: 'alive' })).toBeNull();
    expect(SIGN_RANGE).toBeGreaterThan(10);
  });
  it('aucun panneau pour un joueur à terre ou une salle sans panneau', () => {
    expect(nearestSign(room, { pos: { x: 3.5 * TILE, y: 3.5 * TILE }, status: 'down' })).toBeNull();
    expect(nearestSign(makeTestRoom(), { pos: { x: 0, y: 0 }, status: 'alive' })).toBeNull();
  });
  it('slot propriétaire d\'une clé du niveau', () => {
    const lvl = makeTestLevel({
      rooms: [makeTestRoom({ mechanisms: [{ id: 'k1', type: 'key', tile: [4, 4], ownerSlot: 2, doorId: 'd1' }, { id: 'd1', type: 'door', tiles: [[8, 2]], requires: [], keyId: 'k1' }] })],
    });
    expect(keyOwnerSlot(lvl, 'k1')).toBe(2);
    expect(keyOwnerSlot(lvl, 'nope')).toBeUndefined();
  });
});

describe('computeContextPrompt', () => {
  const lever = (ownerSlot?: number) =>
    makeTestRoom({
      mechanisms: [
        { id: 'l1', type: 'lever', tile: [5, 4], ownerSlot },
        { id: 'p1', type: 'plate', tile: [9, 2] },
      ],
      exit: { rect: { x: 9, y: 5, w: 2, h: 2 }, requires: ['p1'] },
    });

  it('rien à proximité → null', () => {
    const room = lever();
    const sim = makeSim(room, 1);
    placePlayer(sim, 0, 2, 2);
    expect(computeContextPrompt(sim.state, sim.level, room, 0)).toBeNull();
  });

  it('levier à portée → invite « actionner le levier »', () => {
    const room = lever();
    const sim = makeSim(room, 1);
    placePlayer(sim, 0, 5, 4);
    expect(computeContextPrompt(sim.state, sim.level, room, 0)).toMatchObject({ key: 'hint.useLever', kind: 'lever' });
  });

  it('levier réservé à un autre joueur → couleur du propriétaire', () => {
    const room = lever(1);
    const sim = makeSim(room, 2);
    placePlayer(sim, 0, 5, 4);
    placePlayer(sim, 1, 2, 2);
    const p0 = computeContextPrompt(sim.state, sim.level, room, 0);
    expect(p0?.key).toBe('hint.slotRequired');
    expect(p0?.params).toEqual({ color: t('hint.slotcolor.red') });
    expect(p0?.color).not.toBeNull();
    placePlayer(sim, 0, 2, 2);
    placePlayer(sim, 1, 5, 4);
    expect(computeContextPrompt(sim.state, sim.level, room, 1)?.key).toBe('hint.useLever');
  });

  it('coop adaptative : à 1 joueur un levier de slot 1 lui revient', () => {
    const room = lever(1);
    const sim = makeSim(room, 1);
    placePlayer(sim, 0, 5, 4);
    expect(computeContextPrompt(sim.state, sim.level, room, 0)?.key).toBe('hint.useLever');
  });

  it('relever un allié à terre a priorité, puis « relevage en cours »', () => {
    const room = lever();
    const sim = makeSim(room, 2);
    placePlayer(sim, 0, 5, 4);
    placePlayer(sim, 1, 5, 4);
    sim.state.players[1].status = 'down';
    expect(computeContextPrompt(sim.state, sim.level, room, 0)).toMatchObject({ key: 'hud.reviveHold', kind: 'revive' });
    sim.state.players[0].revivingId = 1;
    expect(computeContextPrompt(sim.state, sim.level, room, 0)?.key).toBe('hud.reviving');
  });

  it('un joueur à terre n\'a pas d\'invite', () => {
    const room = lever();
    const sim = makeSim(room, 1);
    placePlayer(sim, 0, 5, 4);
    sim.state.players[0].status = 'down';
    expect(computeContextPrompt(sim.state, sim.level, room, 0)).toBeNull();
  });

  it('porte à clé : clé en main / pas la bonne personne', () => {
    const room = makeTestRoom({
      mechanisms: [
        { id: 'k1', type: 'key', tile: [3, 3], ownerSlot: 0, doorId: 'd1' },
        { id: 'd1', type: 'door', tiles: [[8, 2]], requires: [], keyId: 'k1' },
        { id: 'p1', type: 'plate', tile: [9, 5] },
      ],
    });
    const sim = makeSim(room, 2);
    placePlayer(sim, 0, 7, 2);
    placePlayer(sim, 1, 7, 3);
    expect(computeContextPrompt(sim.state, sim.level, room, 0)?.key).toBe('hint.needKey');
    expect(computeContextPrompt(sim.state, sim.level, room, 1)?.key).toBe('hint.slotRequired');
    sim.state.players[0].keys.push('k1');
    expect(computeContextPrompt(sim.state, sim.level, room, 0)?.key).toBe('hint.useKey');
  });

  it('piédestal d\'une énigme de runes', () => {
    const room = makeTestRoom({
      mechanisms: [
        {
          id: 'rp',
          type: 'runePuzzle',
          displayTile: [3, 2],
          visibleToSlot: 0,
          sequence: ['sun', 'moon'],
          pedestals: [
            { symbol: 'sun', tile: [5, 5] },
            { symbol: 'moon', tile: [7, 5] },
          ],
        },
      ],
      exit: { rect: { x: 9, y: 5, w: 2, h: 2 }, requires: ['rp'] },
    });
    const sim = makeSim(room, 1);
    placePlayer(sim, 0, 5, 5);
    const pr = computeContextPrompt(sim.state, sim.level, room, 0);
    expect(pr).toMatchObject({ key: 'game.prompt.pedestal', kind: 'rune' });
    expect(pr?.params).toEqual({ symbol: t('mech.symbol.sun') });
  });

  it('mécanisme waived (coop adaptative) : aucune invite', () => {
    const room = makeTestRoom({
      mechanisms: [
        { id: 'l1', type: 'lever', tile: [5, 4], minPlayers: 3 },
        { id: 'p1', type: 'plate', tile: [9, 2] },
      ],
    });
    const sim = makeSim(room, 2);
    placePlayer(sim, 0, 5, 4);
    expect(computeContextPrompt(sim.state, sim.level, room, 0)).toBeNull();
  });

  it('toutes les clés d\'invite existent dans le dictionnaire', () => {
    for (const key of ['hint.useLever', 'hint.slotRequired', 'hud.reviveHold', 'hud.reviving', 'hint.needKey', 'hint.useKey', 'game.prompt.pedestal', 'game.prompt.walkOverKey', 'hint.pushBlock', 'hint.gatherAtExit', 'hint.sealedExit', 'hint.locked']) {
      expect(t(key, { name: 'x', color: 'y', symbol: 'z' })).not.toBe(key);
    }
  });
});

describe('computeExitOpen', () => {
  it('suit les exigences de sortie (plaque)', () => {
    const room = makeTestRoom();
    const sim = makeSim(room, 1);
    expect(computeExitOpen(sim.state, sim.level, room)).toBe(false);
    const plate = sim.state.room.mechanisms.find((m) => m.id === 'p1')!;
    plate.active = true;
    expect(computeExitOpen(sim.state, sim.level, room)).toBe(true);
  });

  it('exigence « clear » : ennemis vivants bloquent', () => {
    const room = makeTestRoom({ exit: { rect: { x: 9, y: 5, w: 2, h: 2 }, requires: ['clear'] }, enemies: [{ kind: 'slime', tile: [8, 2] }] });
    const sim = makeSim(room, 1);
    expect(computeExitOpen(sim.state, sim.level, room)).toBe(false);
    for (const e of sim.state.room.enemies) e.dead = true;
    expect(computeExitOpen(sim.state, sim.level, room)).toBe(true);
  });
});

describe('ennemis restants (constat 18)', () => {
  const clearRoom = () =>
    makeTestRoom({
      exit: { rect: { x: 9, y: 5, w: 2, h: 2 }, requires: ['clear'] },
      enemies: [
        { kind: 'slime', tile: [8, 2] },
        { kind: 'slime', tile: [3, 2] },
        { kind: 'slime', tile: [6, 4] },
      ],
    });

  it('null si la sortie ne demande pas « clear »', () => {
    const room = makeTestRoom();
    const sim = makeSim(room, 1);
    expect(enemiesRemaining(sim.state, room)).toBeNull();
  });

  it('compte les ennemis vivants + apparitions en attente, null une fois tout vaincu', () => {
    const room = clearRoom();
    const sim = makeSim(room, 1);
    const total = sim.state.room.enemies.filter((e) => !e.dead).length + pendingSpawnCount(sim.state, room);
    expect(total).toBe(3);
    expect(enemiesRemaining(sim.state, room)).toBe(3);
    sim.state.room.enemies[0].dead = true;
    expect(enemiesRemaining(sim.state, room)).toBe(2);
    for (const e of sim.state.room.enemies) e.dead = true;
    for (let i = 0; i < room.enemies.length; i++) if (!sim.state.room.spawnedSpawnIdx.includes(i)) sim.state.room.spawnedSpawnIdx.push(i);
    expect(enemiesRemaining(sim.state, room)).toBeNull();
  });

  it('nearestEnemyPositions : vivants seulement, du plus proche au plus loin, bornés', () => {
    const room = clearRoom();
    const sim = makeSim(room, 1);
    const alive = sim.state.room.enemies.filter((e) => !e.dead);
    if (alive.length < 2) return;
    alive[0].pos = { x: 500, y: 0 };
    alive[1].pos = { x: 100, y: 0 };
    const out = nearestEnemyPositions(sim.state, { x: 0, y: 0 }, 2);
    expect(out.length).toBe(2);
    expect(out[0].x).toBeLessThanOrEqual(out[1].x);
    alive[1].dead = true;
    expect(nearestEnemyPositions(sim.state, { x: 0, y: 0 }, 5).every((p) => p.x !== 100)).toBe(true);
    expect(nearestEnemyPositions(sim.state, { x: 0, y: 0 }, 0)).toEqual([]);
  });
});

describe('overlay : bannerAlpha / wrapIndex', () => {
  it('fondu d\'entrée, plateau, fondu de sortie', () => {
    expect(bannerAlpha(0, 3000)).toBe(0);
    expect(bannerAlpha(110, 3000)).toBeCloseTo(0.5, 1);
    expect(bannerAlpha(1500, 3000)).toBe(1);
    expect(bannerAlpha(2750, 3000)).toBeCloseTo(0.5, 1);
    expect(bannerAlpha(3000, 3000)).toBe(0);
    expect(bannerAlpha(-5, 3000)).toBe(0);
  });
  it('durée infinie : jamais de fondu de sortie', () => {
    expect(bannerAlpha(1e6, Infinity)).toBe(1);
  });
  it('wrapIndex : navigation circulaire', () => {
    expect(wrapIndex(0, -1, 2)).toBe(1);
    expect(wrapIndex(1, 1, 2)).toBe(0);
    expect(wrapIndex(0, 1, 2)).toBe(1);
    expect(wrapIndex(0, 5, 0)).toBe(0);
  });
});
