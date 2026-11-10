import { beforeAll, describe, expect, it } from 'vitest';
import { CHARACTERS } from '../core/characters';
import { TILE } from '../core/constants';
import { makeTestLevel, makeTestRoom } from '../core/levelValidation';
import { createSimulation, type GameSimulation } from '../core/simulation';
import type { EnemySpawnDef, LevelDef, MechanismDef, ObjectiveDef, PlayerSetup, RoomDef } from '../core/types';
import { hasKey, setLanguage, t } from '../i18n/i18n';
import {
  ENEMY_COUNTER_MAX,
  MAX_GOAL_LINES,
  computeExitOpen,
  MECHANISM_FALLBACK_KEYS,
  describePersonalObjectives,
  describeRoomGoals,
  goalLineText,
  objectiveLineText,
  teamObjectiveText,
  type GoalLine,
} from './roomGoals';

beforeAll(() => setLanguage('en'));

const setups = (n: number): PlayerSetup[] =>
  (['david', 'sandrine', 'romain', 'valentine'] as const).slice(0, n).map((characterId, i) => ({ id: i as 0 | 1 | 2 | 3, characterId, difficulty: 2 }));

function makeSim(level: LevelDef, players: number, startRoomIndex = 0): GameSimulation {
  return createSimulation({ levelId: level.id, players: setups(players), seed: 7, startRoomIndex }, level);
}

const EXIT = { x: 9, y: 5, w: 2, h: 2 };
const slimes = (n: number, extra: Partial<EnemySpawnDef> = {}): EnemySpawnDef[] =>
  Array.from({ length: n }, (_, i) => ({ kind: 'slime', tile: [3 + (i % 6), 2 + Math.floor(i / 6)], ...extra }) as EnemySpawnDef);

/** Salle « tout vaincre » : niveau à une salle (non finale-dépendante des objectifs : on les marque accomplis). */
function clearScene(enemies: EnemySpawnDef[], players = 1): { sim: GameSimulation; room: RoomDef; goals: () => GoalLine[] } {
  const room = makeTestRoom({ exit: { rect: EXIT, requires: ['clear'] }, enemies });
  const level = makeTestLevel({ rooms: [room] });
  const sim = makeSim(level, players);
  for (const o of sim.state.objectives) o.done = true;
  return { sim, room, goals: () => describeRoomGoals(sim.state, level, room) };
}

const goalOf = (lines: GoalLine[], id: string): GoalLine => {
  const l = lines.find((x) => x.id === id);
  if (!l) throw new Error(`ligne ${id} absente : ${lines.map((x) => x.id).join(',')}`);
  return l;
};

describe('describeRoomGoals : « clear » (ennemis)', () => {
  it('« Vaincre tous les ennemis » + compteur quand il n\'y a plus de vague en attente', () => {
    const { goals } = clearScene(slimes(8));
    const l = goalOf(goals(), 'clear');
    expect(l.label).toBe(t('goal.clear.all'));
    expect(l.kind).toBe('clear');
    expect(l.done).toBe(false);
    expect(l.detail).toBe(t('goal.remaining.other', { count: 8 })); // 8 > ENEMY_COUNTER_MAX mais aucune apparition en attente
  });

  it('vague en attente et > ENEMY_COUNTER_MAX : libellé seul (on garde la surprise)', () => {
    const { sim, room, goals } = clearScene([...slimes(3), ...slimes(4, { wave: 1 })]);
    expect(room.enemies).toHaveLength(7);
    expect(sim.state.room.spawnedSpawnIdx.length).toBeLessThan(7);
    const l = goalOf(goals(), 'clear');
    expect(l.label).toBe(t('goal.clear.all'));
    expect(l.detail).toBe('');
  });

  it('vague en attente mais ≤ ENEMY_COUNTER_MAX restants : compteur affiché', () => {
    const { sim, goals } = clearScene([...slimes(1), ...slimes(4, { wave: 1 })]);
    expect(ENEMY_COUNTER_MAX).toBe(5);
    for (const e of sim.state.room.enemies) e.dead = true;
    const l = goalOf(goals(), 'clear');
    expect(l.detail).toBe(t('goal.remaining.other', { count: 4 }));
  });

  it('singulier à 1 restant, ligne cochée quand tout est vaincu (sortie ouverte ensuite)', () => {
    const { sim, goals } = clearScene(slimes(2));
    sim.state.room.enemies[0].dead = true;
    expect(goalOf(goals(), 'clear').detail).toBe(t('goal.remaining.one', { count: 1 }));
    sim.state.room.enemies[1].dead = true;
    for (let i = 0; i < 2; i++) if (!sim.state.room.spawnedSpawnIdx.includes(i)) sim.state.room.spawnedSpawnIdx.push(i);
    const lines = goals();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ id: 'exit', kind: 'exit', highlight: true, label: t('goal.exit.open') });
  });

  it('boss seul : « Vaincre le boss », sans compteur ; boss + escorte : « le boss et ses sbires » + compteur', () => {
    const boss = clearScene([{ kind: 'warden', tile: [8, 2] }]);
    const lb = goalOf(boss.goals(), 'clear');
    expect(lb).toMatchObject({ kind: 'boss', label: t('goal.clear.boss'), detail: '' });
    const mixed = clearScene([{ kind: 'warden', tile: [8, 2] }, ...slimes(2)]);
    const lm = goalOf(mixed.goals(), 'clear');
    expect(lm.label).toBe(t('goal.clear.bossAndMinions'));
    expect(lm.detail).toBe(t('goal.remaining.other', { count: 3 }));
    // le demi-boss est mort : le libellé reste STABLE (déduit de la salle, pas de l'état instantané du combat)
    const warden = mixed.sim.state.room.enemies.find((e) => e.kind === 'warden');
    if (warden) warden.dead = true;
    expect(goalOf(mixed.goals(), 'clear').label).toBe(t('goal.clear.bossAndMinions'));
  });

  it('libellé stable pendant tout le combat : le boss qui invoque des renforts ne change pas la ligne', () => {
    const { sim, goals } = clearScene([{ kind: 'warden', tile: [8, 2] }]);
    const before = goalOf(goals(), 'clear').label;
    // des sbires invoqués (absents de la définition de la salle) apparaissent
    const proto = sim.state.room.enemies[0];
    for (let i = 0; i < 3; i++) sim.state.room.enemies.push({ ...proto, kind: 'slime', id: 900 + i } as typeof proto);
    const during = goalOf(goals(), 'clear');
    expect(during.label).toBe(before);
    expect(during.label).toBe(t('goal.clear.boss'));
    expect(during.detail).toBe(t('goal.remaining.other', { count: 4 }));
    // le boss tombe, il reste des sbires : toujours le même libellé
    sim.state.room.enemies[0].dead = true;
    expect(goalOf(goals(), 'clear').label).toBe(before);
    for (const e of sim.state.room.enemies) e.dead = true;
    expect(goals().map((l) => l.kind)).toEqual(['exit']); // plus rien à vaincre : « Sortie ouverte »
  });

  it('boss en attente d\'apparition (vague suivante) : déjà annoncé', () => {
    const { goals } = clearScene([...slimes(1), { kind: 'forgelord', tile: [8, 2], wave: 1 }]);
    expect(goalOf(goals(), 'clear').label).toBe(t('goal.clear.bossAndMinions'));
  });

  it('les apparitions réservées à plus de joueurs ne comptent pas (coop adaptative)', () => {
    const solo = clearScene([...slimes(2), ...slimes(2, { minPlayers: 3 })], 1);
    expect(goalOf(solo.goals(), 'clear').detail).toBe(t('goal.remaining.other', { count: 2 }));
    const trio = clearScene([...slimes(2), ...slimes(2, { minPlayers: 3 })], 3);
    expect(goalOf(trio.goals(), 'clear').detail).toBe(t('goal.remaining.other', { count: 4 }));
  });
});

describe('describeRoomGoals : mécanismes', () => {
  const doorRoom = (mechs: MechanismDef[], requires: string[]): { sim: GameSimulation; room: RoomDef; goals: () => GoalLine[] } => {
    const room = makeTestRoom({ mechanisms: mechs, exit: { rect: EXIT, requires } });
    const level = makeTestLevel({ rooms: [room, makeTestRoom({ id: 'r2' })] }); // r1 n'est pas la salle finale
    const sim = makeSim(level, 2);
    return { sim, room, goals: () => describeRoomGoals(sim.state, level, room) };
  };
  const plate = (id: string, x: number): MechanismDef => ({ id, type: 'plate', tile: [x, 4] });

  it('porte à plusieurs prérequis : « Ouvrir : … » + progression (met/total), cochée quand ouverte', () => {
    const { sim, goals } = doorRoom(
      [plate('pa', 4), plate('pb', 6), { id: 'dd', type: 'door', tiles: [[8, 3]], requires: ['pa', 'pb'], labelKey: 'mech.level1.d2' }],
      ['dd'],
    );
    let l = goalOf(goals(), 'dd');
    expect(l).toMatchObject({ kind: 'door', label: t('goal.open', { name: t('mech.level1.d2') }), detail: t('goal.progress', { done: 0, total: 2 }), done: false });
    expect(goalLineText(l)).toBe('Open: Plate door (0/2)');
    sim.state.room.mechanisms.find((m) => m.id === 'pa')!.active = true;
    expect(goalOf(goals(), 'dd').detail).toBe('(1/2)');
    sim.state.room.mechanisms.find((m) => m.id === 'pb')!.active = true;
    sim.state.room.mechanisms.find((m) => m.id === 'dd')!.active = true;
    const lines = goals();
    expect(lines).toHaveLength(1);
    expect(lines[0].kind).toBe('exit');
    l = goalOf(lines, 'exit');
    expect(l.highlight).toBe(true);
  });

  it('porte à un seul prérequis : pas de progression ; repli sur le nom du type sans labelKey', () => {
    const { goals } = doorRoom([{ id: 'dd', type: 'door', tiles: [[8, 3]], requires: ['lv'] }, { id: 'lv', type: 'lever', tile: [5, 4] }], ['dd']);
    const l = goalOf(goals(), 'dd');
    expect(l.detail).toBe('');
    expect(l.label).toBe(t('goal.open', { name: t('mech.door') }));
  });

  it('autres mécanismes : « Activer : … » (levier, plaque, brasero, sablier…), repli par type', () => {
    const mechs: MechanismDef[] = [
      { id: 'lv', type: 'lever', tile: [5, 4], labelKey: 'mech.level1.lv1' },
      { id: 'pl', type: 'plate', tile: [6, 4] },
      { id: 'br', type: 'brazier', tile: [7, 4] },
      { id: 'st', type: 'statuePair', statues: [{ tile: [3, 3], standTile: [3, 4], facing: 'up' }, { tile: [8, 3], standTile: [8, 4], facing: 'up' }], targetDir: 'down' },
      { id: 'hg', type: 'hourglass', levers: [[2, 2], [9, 2]], gate: [[5, 5]], periodMs: 8000, displayTile: [5, 2] },
      { id: 'lb', type: 'lightBridge', tiles: [[4, 5]], lanternSlot: 0, radiusTiles: 3 },
    ];
    const { goals } = doorRoom(mechs, mechs.map((m) => m.id));
    const lines = goals();
    expect(lines.map((l) => l.kind)).toEqual(Array(6).fill('mechanism'));
    expect(lines.map((l) => l.label)).toEqual([
      'Activate: Portcullis lever',
      'Activate: Pressure plate',
      'Activate: Brazier',
      'Activate: Twin statues',
      'Activate: Hourglass',
      'Activate: Light bridge',
    ]);
    expect(lines.every((l) => l.detail === '' && !l.highlight)).toBe(true);
  });

  it("brasero à libellé « allumé » : la ligne d'objectif suit le libellé courant (éteint, puis allumé, puis repasse à éteint)", () => {
    const br: MechanismDef = { id: 'br', type: 'brazier', tile: [7, 4], labelKey: 'mech.tutorial.br_b', litLabelKey: 'mech.tutorial.br_a' };
    const { sim, goals } = doorRoom([br, plate('pa', 4)], ['br', 'pa']); // 2e exigence non remplie : la ligne du brasero reste affichée une fois cochée
    const state = sim.state.room.mechanisms.find((m) => m.id === 'br')!;
    expect(goalOf(goals(), 'br').label).toBe(`Activate: ${t('mech.tutorial.br_b')}`);
    state.active = true;
    expect(goalOf(goals(), 'br').label).toBe(`Activate: ${t('mech.tutorial.br_a')}`);
    expect(goalOf(goals(), 'br').done).toBe(true);
    state.active = false;
    expect(goalOf(goals(), 'br').label).toBe(`Activate: ${t('mech.tutorial.br_b')}`);
  });

  it('mécanisme neutralisé (waived) : ligne déjà cochée', () => {
    const { goals } = doorRoom([{ id: 'lv', type: 'lever', tile: [5, 4], minPlayers: 3 }, plate('pa', 6)], ['lv', 'pa']);
    const lines = goals();
    expect(goalOf(lines, 'lv').done).toBe(true);
    expect(goalOf(lines, 'pa').done).toBe(false);
  });

  it('mécanisme inconnu : ligne générique, jamais d\'exception', () => {
    const { goals } = doorRoom([plate('pa', 6)], ['ghost', 'pa']);
    const l = goalOf(goals(), 'ghost');
    expect(l.label).toBe(t('goal.activate', { name: t('goal.mech.generic') }));
    expect(l.done).toBe(false);
  });

  it('une même exigence répétée n\'est listée qu\'une fois ; l\'ordre du niveau est conservé', () => {
    const { goals } = doorRoom([plate('pa', 4), plate('pb', 6)], ['pb', 'pa', 'pb']);
    expect(goals().map((l) => l.id)).toEqual(['pb', 'pa']);
  });

  it('chaque type de mécanisme a une clé de repli traduite en fr et en', () => {
    for (const key of Object.values(MECHANISM_FALLBACK_KEYS)) {
      expect(hasKey(key, 'fr'), `fr ${key}`).toBe(true);
      expect(hasKey(key, 'en'), `en ${key}`).toBe(true);
    }
  });
});

describe('describeRoomGoals : objectifs personnels regroupés', () => {
  const objRoom = (requires: string[], players: number): { sim: GameSimulation; level: LevelDef; room: RoomDef; goals: () => GoalLine[] } => {
    const room = makeTestRoom({ exit: { rect: EXIT, requires } });
    const level = makeTestLevel({ rooms: [room, makeTestRoom({ id: 'r2' })] });
    const sim = makeSim(level, players);
    return { sim, level, room, goals: () => describeRoomGoals(sim.state, level, room) };
  };
  const done = (sim: GameSimulation, ...ids: string[]): void => {
    for (const id of ids) sim.state.objectives.find((o) => o.id === id)!.done = true;
  };

  it('UNE seule ligne « Objectifs personnels accomplis : x/y » pour plusieurs jetons obj:', () => {
    const { goals } = objRoom(['obj:o0', 'obj:o1', 'obj:o2', 'obj:o3'], 4);
    const lines = goals();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ id: 'objectives', kind: 'objectives', label: 'Personal objectives completed: 0/4', done: false });
    expect(lines[0].detail).toBe(t('goal.objectives.waitingCount', { count: 4 }));
  });

  it('nomme les joueurs qui n\'ont pas fini (≤ 2), sinon donne le compte', () => {
    const { sim, goals } = objRoom(['obj:o0', 'obj:o1', 'obj:o2', 'obj:o3'], 4);
    done(sim, 'o0', 'o1');
    let l = goals()[0];
    expect(l.label).toBe('Personal objectives completed: 2/4');
    expect(l.detail).toBe(t('goal.objectives.waitingNames', { names: `${t(CHARACTERS.romain.nameKey)}, ${t(CHARACTERS.valentine.nameKey)}` }));
    done(sim, 'o2');
    l = goals()[0];
    expect(l.detail).toBe(t('goal.objectives.waitingNames', { names: t(CHARACTERS.valentine.nameKey) }));
    done(sim, 'o3');
    const lines = goals();
    expect(lines).toHaveLength(1);
    expect(lines[0].kind).toBe('exit'); // tout accompli : sortie ouverte
  });

  it('ne compte que les objectifs référencés (x sur y), et fonctionne à 1 joueur (il les possède tous)', () => {
    const { sim, goals } = objRoom(['obj:o1', 'obj:o2'], 1);
    done(sim, 'o1');
    const l = goals()[0];
    expect(l.label).toBe('Personal objectives completed: 1/2');
    expect(l.detail).toBe(t('goal.objectives.waitingNames', { names: t(CHARACTERS.david.nameKey) }));
  });

  it('objectif inconnu : compté comme non accompli, sans exception', () => {
    const { goals } = objRoom(['obj:nope'], 2);
    expect(goals()[0]).toMatchObject({ kind: 'objectives', label: 'Personal objectives completed: 0/1', done: false });
  });

  it('salle finale : les objectifs de TOUT le niveau sont exigés en plus (comme isExitOpen), même sans jeton obj:', () => {
    const room = makeTestRoom({ exit: { rect: EXIT, requires: ['pf'] }, mechanisms: [{ id: 'pf', type: 'plate', tile: [6, 4] }] });
    const level = makeTestLevel({ rooms: [room] });
    const sim = makeSim(level, 2);
    sim.state.room.mechanisms.find((m) => m.id === 'pf')!.active = true;
    let lines = describeRoomGoals(sim.state, level, room);
    expect(lines.map((l) => l.kind)).toEqual(['mechanism', 'objectives']);
    expect(lines[1].label).toBe('Personal objectives completed: 0/4');
    expect(sim.isExitOpen()).toBe(false); // cohérent avec la simulation
    expect(computeExitOpen(sim.state, level, room)).toBe(false); // …et computeExitOpen en est le miroir exact
    for (const o of sim.state.objectives) o.done = true;
    lines = describeRoomGoals(sim.state, level, room);
    expect(lines).toHaveLength(1);
    expect(lines[0].kind).toBe('exit');
    expect(sim.isExitOpen()).toBe(true);
    expect(computeExitOpen(sim.state, level, room)).toBe(true);
  });

  it("goalLineText : le complément reste d'un bloc (espaces insécables), pas de coupure dans « (19 restants) »", () => {
    const text = goalLineText({ label: 'Defeat all enemies', detail: '(19 remaining)' });
    expect(text).toBe('Defeat all enemies (19' + String.fromCharCode(0xa0) + 'remaining)');
    expect(goalLineText({ label: 'x', detail: '' })).toBe('x');
  });
});

describe('describeRoomGoals : porte déjà ouverte', () => {
  it('porte verrouillée ouverte, plaques relâchées : cochée, SANS progression « (0/2) » contradictoire', () => {
    const mechs: MechanismDef[] = [
      { id: 'pa', type: 'plate', tile: [4, 4] },
      { id: 'pb', type: 'plate', tile: [6, 4] },
      { id: 'dd', type: 'door', tiles: [[8, 3]], requires: ['pa', 'pb'], labelKey: 'mech.level1.d2' },
      { id: 'lv', type: 'lever', tile: [3, 2] },
    ];
    const room = makeTestRoom({ mechanisms: mechs, exit: { rect: EXIT, requires: ['dd', 'lv'] } });
    const level = makeTestLevel({ rooms: [room, makeTestRoom({ id: 'r2' })] });
    const sim = makeSim(level, 2);
    const mech = (id: string) => sim.state.room.mechanisms.find((m) => m.id === id)!;
    mech('pa').active = true;
    expect(goalOf(describeRoomGoals(sim.state, level, room), 'dd').detail).toBe('(1/2)');
    mech('pb').active = true;
    mech('dd').active = true;
    mech('pa').active = false;
    mech('pb').active = false;
    const l = goalOf(describeRoomGoals(sim.state, level, room), 'dd');
    expect(l.done).toBe(true);
    expect(l.detail).toBe('');
    expect(goalLineText(l)).not.toContain('/');
  });
});

describe('describeRoomGoals : zones, sortie, jetons inconnus', () => {
  it('zone:<obj> et enter:<zone> : « Tenir la zone » / « Rejoindre la zone », cochés selon les positions', () => {
    const room = makeTestRoom({
      zones: [{ id: 'zz', rect: { x: 4, y: 2, w: 3, h: 3 } }],
      exit: { rect: EXIT, requires: ['zone:oz', 'enter:zz', 'never'] },
    });
    const objectives: ObjectiveDef[] = [
      { id: 'oz', slot: 1, roomId: 'r1', kind: 'zone', zoneId: 'zz', seconds: 5, labelKey: 'hud.objective' },
      { id: 'o0', slot: 0, roomId: 'r1', kind: 'mechanism', mechanismId: 'p1', labelKey: 'hud.objective' },
    ];
    const level = makeTestLevel({ rooms: [room, makeTestRoom({ id: 'r2' })], objectives });
    const sim = makeSim(level, 2);
    let lines = describeRoomGoals(sim.state, level, room);
    expect(lines.slice(0, 2).map((l) => l.label)).toEqual([`Hold the zone (${t(CHARACTERS.sandrine.nameKey)})`, 'Reach the zone']);
    expect(lines.every((l) => !l.done)).toBe(true);
    expect(lines).toHaveLength(3); // le jeton « never » (mécanisme inconnu) garde la sortie fermée
    sim.state.players[1].pos = { x: 5.5 * TILE, y: 3.5 * TILE };
    lines = describeRoomGoals(sim.state, level, room);
    expect(lines.map((l) => l.done)).toEqual([true, true, false]);
  });

  it('jetons inconnus / zone sans objectif : jamais d\'exception, libellés non vides', () => {
    const room = makeTestRoom({ exit: { rect: EXIT, requires: ['zone:nope', 'enter:nope', 'obj:nope', '', 'bogus:token'] } });
    const level = makeTestLevel({ rooms: [room, makeTestRoom({ id: 'r2' })] });
    const sim = makeSim(level, 3);
    const lines = describeRoomGoals(sim.state, level, room);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l.label.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(MAX_GOAL_LINES);
  });

  it('aucune exigence : « Rejoins la sortie » (sans mise en évidence) ; exigences satisfaites : « Sortie ouverte » (en évidence)', () => {
    const room = makeTestRoom({ exit: { rect: EXIT, requires: [] } });
    const level = makeTestLevel({ rooms: [room, makeTestRoom({ id: 'r2' })] });
    const sim = makeSim(level, 1);
    expect(describeRoomGoals(sim.state, level, room)).toEqual([
      { id: 'exit', kind: 'exit', label: t('goal.exit.reach'), detail: '', done: false, highlight: false },
    ]);
    const room2 = makeTestRoom();
    const level2 = makeTestLevel({ rooms: [room2, makeTestRoom({ id: 'r2' })] });
    const sim2 = makeSim(level2, 1);
    expect(describeRoomGoals(sim2.state, level2, room2)[0]).toMatchObject({ label: 'Activate: Pressure plate', highlight: false });
    sim2.state.room.mechanisms.find((m) => m.id === 'p1')!.active = true;
    expect(describeRoomGoals(sim2.state, level2, room2)).toEqual([
      { id: 'exit', kind: 'exit', label: t('goal.exit.open'), detail: '', done: false, highlight: true },
    ]);
  });

  it('mélange : l\'ordre des exigences est conservé et les ennemis ne cachent pas le reste', () => {
    const room = makeTestRoom({
      exit: { rect: EXIT, requires: ['pl', 'clear', 'obj:o0'] },
      mechanisms: [{ id: 'pl', type: 'plate', tile: [6, 4] }],
      enemies: slimes(2),
    });
    const level = makeTestLevel({ rooms: [room, makeTestRoom({ id: 'r2' })] });
    const sim = makeSim(level, 2);
    expect(describeRoomGoals(sim.state, level, room).map((l) => l.id)).toEqual(['pl', 'clear', 'objectives']);
  });
});

describe('objectifs personnels : en-tête sans fraction orpheline', () => {
  const r1 = makeTestRoom({ id: 'r1', nameKey: 'hud.team' });
  const r2 = makeTestRoom({ id: 'r2' });
  const objectives: ObjectiveDef[] = [
    { id: 'a', slot: 0, roomId: 'r1', kind: 'mechanism', labelKey: 'hud.objective', mechanismId: 'p1' },
    { id: 'b', slot: 0, roomId: 'r2', kind: 'kills', labelKey: 'hud.objective', count: 3 },
    { id: 'c', slot: 1, roomId: 'r2', kind: 'zone', labelKey: 'hud.objective', zoneId: 'zz', seconds: 10 },
  ];
  const level = makeTestLevel({ rooms: [r1, r2], objectives });

  it('aucune ligne ⇒ aucun en-tête (pas de « 0/1 » seul)', () => {
    const sim = makeSim(level, 2);
    // joueur 1 : son seul objectif est dans r2 ; en r1 il n'a rien à montrer
    const pv = describePersonalObjectives(sim.state, level, 1, r1);
    expect(pv.lines).toEqual([]);
    expect(pv.header).toBe('');
    expect(teamObjectiveText(sim.state, level, 1, r1)).toBe(t('hud.objective.none'));
  });

  it('une ligne et un seul objectif sur le niveau : « Your objective », sans fraction', () => {
    const sim = makeSim(level, 2);
    const pv = describePersonalObjectives(sim.state, level, 1, r2);
    expect(pv.lines).toHaveLength(1);
    expect(pv.header).toBe('Your objective');
    expect(pv.header).not.toMatch(/\d\/\d/);
  });

  it('plusieurs objectifs : pluriel et progression écrite en mots (« 1/2 completed »)', () => {
    const sim = makeSim(level, 2);
    sim.state.objectives.find((o) => o.id === 'a')!.done = true;
    const pv = describePersonalObjectives(sim.state, level, 0, r2);
    expect(pv.lines.map((l) => l.id)).toEqual(['b']);
    expect(pv.header).toBe('Your objectives (1/2 completed)'); // une seule ligne, mais plusieurs objectifs sur le niveau : pluriel
    const sim2 = makeSim(level, 2);
    const both = describePersonalObjectives(sim2.state, level, 0, r2);
    expect(both.lines.map((l) => l.id)).toEqual(['a', 'b']);
    expect(both.header).toBe('Your objectives (0/2 completed)');
    expect(both.header).toMatch(/completed/);
  });

  it('en français : mots « accomplis » et libellés', () => {
    setLanguage('fr');
    try {
      const sim = makeSim(level, 2);
      expect(describePersonalObjectives(sim.state, level, 0, r2).header).toBe('Tes objectifs (0/2 accomplis)');
      expect(describePersonalObjectives(sim.state, level, 1, r2).header).toBe('Ton objectif');
      expect(describePersonalObjectives(sim.state, level, 1, r1).header).toBe('');
    } finally {
      setLanguage('en');
    }
  });

  it('coups fatals : libellé + « Finishing blows: n/total » (les siens), sans pourcentage ; zone : garde le pourcentage', () => {
    const sim = makeSim(level, 2);
    const b = sim.state.objectives.find((o) => o.id === 'b')!;
    b.progress = 1 / 3;
    const kills = describePersonalObjectives(sim.state, level, 0, r2).lines.find((l) => l.id === 'b')!;
    expect(objectiveLineText(kills)).toBe(`${t('hud.objective')}\n${t('hud.kills', { count: 1, total: 3 })}`);
    expect(objectiveLineText(kills)).toContain(t('hud.kills', { count: 1, total: 3 }));
    expect(objectiveLineText(kills)).not.toMatch(/%/);
    const c = sim.state.objectives.find((o) => o.id === 'c')!;
    c.progress = 0.4;
    const zone = describePersonalObjectives(sim.state, level, 1, r2).lines[0];
    expect(objectiveLineText(zone)).toContain('(40%)');
  });

  it('objectif d\'une salle passée non accompli : indique la salle', () => {
    const sim = makeSim(level, 2);
    const a = describePersonalObjectives(sim.state, level, 0, r2).lines.find((l) => l.id === 'a')!;
    expect(a.where).toBe(t(r1.nameKey));
    expect(objectiveLineText(a)).toBe(`${t('hud.objective')}\nRoom: ${t(r1.nameKey)}`);
    sim.state.objectives.find((o) => o.id === 'a')!.done = true;
    expect(describePersonalObjectives(sim.state, level, 0, r2).lines.map((l) => l.id)).toEqual(['b']);
  });

  it('accompli : « Done », plus de détail', () => {
    const sim = makeSim(level, 2);
    sim.state.objectives.find((o) => o.id === 'a')!.done = true;
    const a = describePersonalObjectives(sim.state, level, 0, r1).lines[0];
    expect(objectiveLineText(a)).toBe(`${t('hud.objective')}\n${t('hud.done')}`);
  });

  it('panneau d\'équipe : jamais « 0/1 » seul ; résumé court cohérent', () => {
    const sim = makeSim(level, 2);
    expect(teamObjectiveText(sim.state, level, 0, r1)).toBe(`✗ ${t('hud.objective')}`);
    sim.state.objectives.find((o) => o.id === 'a')!.done = true;
    expect(teamObjectiveText(sim.state, level, 0, r1)).toBe(`✓ ${t('hud.objective')}`);
    sim.state.objectives.find((o) => o.id === 'b')!.progress = 1 / 3;
    expect(teamObjectiveText(sim.state, level, 0, r2)).toBe(`✗ ${t('hud.objective')} (1/3)`);
    sim.state.objectives.find((o) => o.id === 'b')!.done = true;
    expect(teamObjectiveText(sim.state, level, 0, r2)).toBe(`✓ ${t('hud.objective')}`); // accompli dans la salle courante : reste affiché
    // salle suivante : plus rien à montrer, tout est accompli
    const r3 = makeTestRoom({ id: 'r3' });
    const level3 = makeTestLevel({ rooms: [r1, r2, r3], objectives });
    expect(teamObjectiveText(sim.state, level3, 0, r3)).toBe(t('hud.objective.allDone'));
    for (let id = 0; id < 2; id++) expect(teamObjectiveText(sim.state, level, id as 0 | 1, r1)).not.toMatch(/^\d+\/\d+/);
  });

  it('joueur sans aucun objectif sur le niveau : chaîne vide', () => {
    const sim = makeSim(level, 3);
    expect(teamObjectiveText(sim.state, level, 2, r1)).toBe('');
    expect(describePersonalObjectives(sim.state, level, 2, r1)).toEqual({ header: '', lines: [] });
  });
});
