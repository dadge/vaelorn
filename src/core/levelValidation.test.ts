import { describe, expect, it } from 'vitest';
import {
  collectRequiredI18nKeys,
  makeTestDictionary,
  makeTestLayout,
  makeTestLevel,
  makeTestRoom,
  validateBossStructure,
  validateLevel,
} from './levelValidation';
import type { LevelDef, MechanismDef, RoomDef } from './types';

// ───────────────────────────── Niveau valide « riche » ─────────────────────────────

function richLevel(): LevelDef {
  const roomA: RoomDef = makeTestRoom({
    id: 'a',
    layout: makeTestLayout(16, 12),
    playerSpawns: [
      [2, 2],
      [3, 2],
      [2, 3],
      [3, 3],
    ],
    mechanisms: [
      { id: 'pa', type: 'plate', tile: [4, 4], colorSlot: 0 },
      { id: 'pb', type: 'plate', tile: [4, 8], minPlayers: 2, colorSlot: 1 },
      { id: 'dA', type: 'door', tiles: [[8, 5], [8, 6]], requires: ['pa', 'pb'] },
      { id: 'lv1', type: 'lever', tile: [10, 3], ownerSlot: 0, windowMs: 2000 },
      { id: 'lv2', type: 'lever', tile: [10, 9], ownerSlot: 1, windowMs: 2000 },
      { id: 'k', type: 'key', tile: [3, 10], ownerSlot: 2, doorId: 'dK' },
      { id: 'dK', type: 'door', tiles: [[13, 4]], requires: ['lv1', 'lv2'], keyId: 'k' },
      { id: 'blk', type: 'block', tile: [6, 5] },
      { id: 'sk', type: 'socket', tile: [11, 6], blockId: 'blk' },
      {
        id: 'rp',
        type: 'runePuzzle',
        displayTile: [12, 10],
        visibleToSlot: 1,
        sequence: ['sun', 'moon'],
        pedestals: [
          { symbol: 'sun', tile: [6, 10] },
          { symbol: 'moon', tile: [8, 10] },
        ],
      },
    ],
    enemies: [
      { kind: 'slime', tile: [10, 6] },
      { kind: 'bat', tile: [12, 5], minPlayers: 2 },
      { kind: 'skeleton', tile: [12, 9], when: 'pa' },
    ],
    zones: [{ id: 'zA', rect: { x: 2, y: 8, w: 3, h: 2 } }],
    signs: [{ id: 's1', tile: [2, 5], textKey: 'sign.test.s1' }],
    decor: [
      { type: 'torch', tile: [0, 3] },
      { type: 'crate', tile: [2, 7] },
    ],
    exit: { rect: { x: 13, y: 7, w: 2, h: 3 }, requires: ['dA', 'dK', 'sk', 'rp'] },
    introHintKey: 'hintroom.test.a',
  });
  const roomB: RoomDef = makeTestRoom({
    id: 'boss',
    layout: makeTestLayout(16, 12),
    mechanisms: [],
    enemies: [{ kind: 'golem', tile: [8, 5] }],
    exit: { rect: { x: 12, y: 8, w: 2, h: 2 }, requires: ['clear'], final: true },
  });
  return makeTestLevel({
    rooms: [roomA, roomB],
    objectives: [
      { id: 'o0', slot: 0, roomId: 'a', kind: 'mechanism', labelKey: 'objective.test.o0', mechanismId: 'dK' },
      { id: 'o1', slot: 1, roomId: 'a', kind: 'zone', labelKey: 'objective.test.o1', zoneId: 'zA', seconds: 3 },
      { id: 'o2', slot: 2, roomId: 'a', kind: 'kills', labelKey: 'objective.test.o2', count: 1, enemyKind: 'slime' },
      { id: 'o3', slot: 3, roomId: 'boss', kind: 'kills', labelKey: 'objective.test.o3', count: 1, enemyKind: 'golem' },
    ],
  });
}

function mutated(fn: (l: LevelDef) => void): string[] {
  const l = richLevel();
  fn(l);
  return validateLevel(l);
}

function expectError(errors: string[], pattern: RegExp): void {
  expect(errors.some((e) => pattern.test(e)), `attendu /${pattern.source}/ dans:\n${errors.join('\n')}`).toBe(true);
}

const roomA = (l: LevelDef): RoomDef => l.rooms[0];
const mech = (l: LevelDef, id: string): MechanismDef => {
  const m = roomA(l).mechanisms.find((x) => x.id === id);
  if (!m) throw new Error(`mécanisme ${id}`);
  return m;
};
function setGlyph(room: RoomDef, x: number, y: number, ch: string): void {
  const row = room.layout[y];
  room.layout[y] = row.slice(0, x) + ch + row.slice(x + 1);
}

// ───────────────────────────── Niveaux valides ─────────────────────────────

describe('validateLevel — niveaux valides', () => {
  it('le niveau minimal makeTestLevel() est valide', () => {
    expect(validateLevel(makeTestLevel())).toEqual([]);
  });

  it('makeTestLevel({ roomCount }) produit des niveaux valides (dernière salle finale)', () => {
    const l = makeTestLevel({ roomCount: 3 });
    expect(l.rooms.map((r) => r.id)).toEqual(['r1', 'r2', 'r3']);
    expect(l.rooms.map((r) => !!r.exit.final)).toEqual([false, false, true]);
    expect(validateLevel(l)).toEqual([]);
  });

  it('un niveau riche (plaques, leviers, clé, bloc, socket, runes, boss pur) est valide pour n = 1..4', () => {
    expect(validateLevel(richLevel())).toEqual([]);
  });

  it('makeTestRoom accepte des surcharges', () => {
    const r = makeTestRoom({ id: 'zz', enemies: [{ kind: 'slime', tile: [5, 5] }] });
    expect(r.id).toBe('zz');
    expect(r.nameKey).toBe('room.test.zz.name');
    expect(r.enemies).toHaveLength(1);
  });

  it('les dictionnaires complets passent ; makeTestDictionary couvre toutes les clés requises', () => {
    const l = richLevel();
    const dict = makeTestDictionary(l);
    expect(validateLevel(l, { dictionaries: { fr: dict, en: dict } })).toEqual([]);
    const keys = collectRequiredI18nKeys(l).map((k) => k.key);
    expect(keys).toEqual(
      expect.arrayContaining(['level.test.name', 'room.test.a.name', 'sign.test.s1', 'hintroom.test.a', 'objective.test.o3', 'level.test.intro.1']),
    );
  });
});

// ───────────────────────────── Niveaux cassés : une erreur détectée par cas ─────────────────────────────

describe('validateLevel — structure', () => {
  it('ids de salles dupliqués', () => {
    expectError(mutated((l) => (l.rooms[1].id = 'a')), /id dupliqué/);
  });
  it('ids de mécanismes dupliqués dans une salle', () => {
    expectError(mutated((l) => (mech(l, 'pb').id = 'pa')), /id de mécanisme dupliqué "pa"/);
  });
  it('ids d\'objectifs dupliqués', () => {
    expectError(mutated((l) => (l.objectives[1].id = 'o0')), /objectif "o0" : id dupliqué/);
  });
  it('ids de zones dupliqués', () => {
    expectError(
      mutated((l) => roomA(l).zones!.push({ id: 'zA', rect: { x: 5, y: 5, w: 1, h: 1 } })),
      /id de zone dupliqué "zA"/,
    );
  });
  it('layout non rectangulaire', () => {
    expectError(mutated((l) => (roomA(l).layout[3] += '.')), /non rectangulaire/);
  });
  it('glyphe invalide', () => {
    expectError(mutated((l) => setGlyph(roomA(l), 5, 5, 'X')), /glyphe invalide 'X'/);
  });
  it('moins de 4 spawns', () => {
    expectError(mutated((l) => roomA(l).playerSpawns.pop()), /au moins 4 playerSpawns/);
  });
  it('spawn sur un mur', () => {
    expectError(mutated((l) => (roomA(l).playerSpawns[1] = [0, 0])), /playerSpawns\[1\] est sur un mur/);
  });
  it('spawn hors de la grille', () => {
    expectError(mutated((l) => (roomA(l).playerSpawns[2] = [50, 2])), /playerSpawns\[2\] est hors de la grille/);
  });
  it('spawn recouvrant une porte', () => {
    expectError(mutated((l) => (roomA(l).playerSpawns[0] = [8, 5])), /playerSpawns\[0\] \[8,5\] recouvre la porte "dA"/);
  });
  it('plaque hors de la grille', () => {
    expectError(mutated((l) => ((mech(l, 'pa') as { tile: [number, number] }).tile = [40, 4])), /plate "pa" est hors de la grille/);
  });
  it('plaque sur une fosse', () => {
    expectError(
      mutated((l) => setGlyph(roomA(l), 4, 4, '~')),
      /plate "pa" est sur une fosse/,
    );
  });
  it('ennemi sur un mur', () => {
    expectError(mutated((l) => (roomA(l).enemies[0].tile = [0, 6])), /ennemi\[0\] \(slime\) est sur un mur/);
  });
  it('panneau et décor hors sol (torche contre un mur autorisée)', () => {
    expectError(mutated((l) => (roomA(l).signs![0].tile = [0, 5])), /panneau "s1" est sur un mur/);
    expectError(mutated((l) => (roomA(l).decor![1].tile = [0, 7])), /décor\[1\] \(crate\) est sur un mur/);
    expect(mutated((l) => (roomA(l).decor![0].tile = [0, 7]))).toEqual([]);
  });
  it('porte posée sur un mur', () => {
    expectError(mutated((l) => (mech(l, 'dA') as { tiles: [number, number][] }).tiles.push([0, 5])), /tiles\[2\] est sur un mur/);
  });
  it('bloc dont une tuile 2×2 est un mur', () => {
    expectError(mutated((l) => setGlyph(roomA(l), 7, 6, '#')), /block "blk".*\[7,6\] n'est pas du sol/);
  });
  it('socket dont une tuile 2×2 est hors sol', () => {
    expectError(mutated((l) => ((mech(l, 'sk') as { tile: [number, number] }).tile = [14, 6])), /socket "sk".*n'est pas du sol/);
  });
  it('mécanisme minPlayers invalide', () => {
    expectError(mutated((l) => (mech(l, 'pb').minPlayers = 7)), /minPlayers doit être un entier 1\.\.4/);
  });
  it('zone ou sortie hors de la grille', () => {
    expectError(mutated((l) => (roomA(l).zones![0].rect = { x: 14, y: 10, w: 5, h: 5 })), /zone "zA" rect invalide ou hors de la grille/);
    expectError(mutated((l) => (roomA(l).exit.rect = { x: 14, y: 10, w: 5, h: 5 })), /exit\.rect invalide ou hors de la grille/);
  });
});

describe('validateLevel — exigences, clés, objectifs, salle finale', () => {
  it('porte exigeant un mécanisme inexistant', () => {
    expectError(mutated((l) => ((mech(l, 'dA') as { requires: string[] }).requires = ['pa', 'ghost'])), /porte "dA" requires "ghost" : mécanisme inexistant/);
  });
  it('porte s\'exigeant elle-même', () => {
    expectError(mutated((l) => ((mech(l, 'dA') as { requires: string[] }).requires = ['dA'])), /ne peut pas exiger lui-même/);
  });
  it('apparition conditionnée par un jeton inexistant', () => {
    expectError(mutated((l) => (roomA(l).enemies[2].when = 'obj:nope')), /ennemi\[2\] when "obj:nope" : objectif inexistant/);
  });
  it('exit.requires avec zone: pointant un objectif qui n\'est pas une zone', () => {
    expectError(mutated((l) => roomA(l).exit.requires.push('zone:o0')), /exit\.requires "zone:o0" : l'objectif "o0" n'est pas de type zone/);
  });
  it('clé dont la porte n\'existe pas', () => {
    expectError(mutated((l) => ((mech(l, 'k') as { doorId: string }).doorId = 'nope')), /clé "k" doorId "nope" n'est pas une porte/);
  });
  it('porte dont le keyId ne correspond pas à la clé', () => {
    expectError(mutated((l) => ((mech(l, 'dK') as { keyId?: string }).keyId = undefined)), /clé "k" → porte "dK" dont keyId est "\(absent\)"/);
  });
  it('une porte avec deux clés (1 clé ↔ 1 porte)', () => {
    expectError(
      mutated((l) => roomA(l).mechanisms.push({ id: 'k2', type: 'key', tile: [3, 9], ownerSlot: 0, doorId: 'dK' })),
      /la porte "dK" a plusieurs clés/,
    );
  });
  it('clé ownerSlot hors 0..3', () => {
    expectError(mutated((l) => ((mech(l, 'k') as { ownerSlot: number }).ownerSlot = 5)), /clé "k" ownerSlot/);
  });
  it('objectif avec salle, mécanisme ou zone inexistants', () => {
    expectError(mutated((l) => (l.objectives[0].roomId = 'ghost')), /objectif "o0" : salle inexistante "ghost"/);
    expectError(mutated((l) => (l.objectives[0].mechanismId = 'ghost')), /objectif "o0" : mécanisme inexistant "ghost"/);
    expectError(mutated((l) => (l.objectives[1].zoneId = 'ghost')), /objectif "o1" : zone inexistante "ghost"/);
  });
  it('objectif de zone sans durée, objectif de kills sans count', () => {
    expectError(mutated((l) => (l.objectives[1].seconds = 0)), /objectif "o1" : seconds doit être > 0/);
    expectError(mutated((l) => (l.objectives[2].count = 0)), /objectif "o2" : count doit être un entier >= 1/);
  });
  it('un slot sans objectif', () => {
    expectError(mutated((l) => l.objectives.pop()), /aucun objectif pour le slot 3/);
  });
  it('aucune salle finale', () => {
    expectError(mutated((l) => delete l.rooms[1].exit.final), /exactement une salle finale/);
  });
  it('deux salles finales', () => {
    expectError(mutated((l) => (roomA(l).exit.final = true)), /exactement une salle finale/);
  });
  it('la salle finale n\'est pas la dernière', () => {
    expectError(
      mutated((l) => {
        l.rooms.reverse();
      }),
      /doit être la dernière du niveau/,
    );
  });
  it('socket sans bloc compatible', () => {
    expectError(
      mutated((l) => {
        roomA(l).mechanisms = roomA(l).mechanisms.filter((m) => m.id !== 'blk');
        (mech(l, 'sk') as { blockId?: string }).blockId = undefined;
      }),
      /socket "sk" : aucun bloc compatible/,
    );
  });
  it('énigme de runes dont la séquence utilise un symbole sans piédestal', () => {
    expectError(mutated((l) => ((mech(l, 'rp') as { sequence: string[] }).sequence = ['sun', 'star'])), /le symbole "star" de la séquence n'a pas de piédestal/);
  });
});

describe('validateLevel — règle du mécanisme coopératif', () => {
  it('une salle sans mécanisme coopératif (et pas un boss pur) est refusée', () => {
    const l = makeTestLevel({ rooms: [makeTestRoom({ mechanisms: [], exit: { rect: { x: 9, y: 5, w: 2, h: 2 }, requires: [], final: true } })] });
    l.objectives = [];
    expectError(validateLevel(l), /aucun mécanisme coopératif/);
  });
  it('une salle dont tous les mécanismes coopératifs sont waived à 1 joueur est refusée', () => {
    const l = makeTestLevel({
      rooms: [makeTestRoom({ mechanisms: [{ id: 'p1', type: 'plate', tile: [6, 4], minPlayers: 2 }] })],
    });
    l.rooms[0].exit.final = true;
    expectError(validateLevel(l), /aucun mécanisme coopératif/);
  });
  it('une salle de boss pure (aucun mécanisme + boss) est acceptée', () => {
    const l = richLevel();
    expect(l.rooms[1].mechanisms).toHaveLength(0);
    expect(validateLevel(l)).toEqual([]);
  });
});

describe('validateLevel — i18n', () => {
  it('clé manquante, clé vide et option checkSpeakers', () => {
    const l = richLevel();
    const dict = makeTestDictionary(l);
    const fr = { ...dict };
    delete fr['objective.test.o2'];
    const en = { ...dict, 'sign.test.s1': '   ' };
    const errors = validateLevel(l, { dictionaries: { fr, en } });
    expectError(errors, /i18n \[fr\] : clé manquante ou vide "objective\.test\.o2"/);
    expectError(errors, /i18n \[en\] : clé manquante ou vide "sign\.test\.s1"/);
    expect(errors).toHaveLength(2);

    expect(validateLevel(l, { dictionaries: { fr: dict }, checkSpeakers: true }).some((e) => e.includes('speaker.aldric'))).toBe(true);
    expect(validateLevel(l, { dictionaries: { fr: { ...dict, 'speaker.aldric': 'Aldric' } }, checkSpeakers: true })).toEqual([]);
  });
});

// ───────────────────────────── Atteignabilité ─────────────────────────────

describe('validateLevel — atteignabilité (BFS, n = 1..4)', () => {
  /** Entoure la tuile [x,y] de murs. */
  function wallOff(room: RoomDef, x: number, y: number): void {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx !== 0 || dy !== 0) setGlyph(room, x + dx, y + dy, '#');
      }
    }
  }

  it('une plaque emmurée est inatteignable à tous les nombres de joueurs', () => {
    const errors = mutated((l) => wallOff(roomA(l), 4, 4));
    expectError(errors, /plate "pa" inatteignable depuis les spawns \(n=1,2,3,4\)/);
  });

  it('un levier, une clé, un piédestal, un ennemi ou la sortie emmurés sont signalés', () => {
    expectError(mutated((l) => wallOff(roomA(l), 12, 9)), /ennemi skeleton en \[12,9\] inatteignable/);
    expectError(mutated((l) => wallOff(roomA(l), 3, 10)), /key "k" inatteignable/);
    expectError(mutated((l) => wallOff(roomA(l), 6, 10)), /runePuzzle "rp"/);
    expectError(
      mutated((l) => {
        roomA(l).layout = makeTestLayout(16, 12);
        for (let y = 7; y <= 9; y++) for (let x = 12; x <= 14; x++) setGlyph(roomA(l), x, y, '#');
        roomA(l).exit.rect = { x: 13, y: 8, w: 1, h: 1 };
      }),
      /exit\.rect ne contient aucune tuile de sol|zone de sortie inatteignable/,
    );
  });

  it('la sortie coupée du reste de la salle par un mur est inatteignable', () => {
    const errors = mutated((l) => {
      const r = roomA(l);
      r.exit.rect = { x: 13, y: 8, w: 1, h: 1 };
      wallOff(r, 13, 8);
    });
    expectError(errors, /zone de sortie inatteignable \(n=1,2,3,4\)/);
  });

  it('un mur coupant la salle en deux isole les spawns / mécanismes de l\'autre côté', () => {
    const errors = mutated((l) => {
      for (let y = 1; y <= 10; y++) setGlyph(roomA(l), 7, y, '#');
    });
    expectError(errors, /inatteignable/);
  });

  it('un spawn isolé des autres est signalé', () => {
    const errors = mutated((l) => {
      const r = roomA(l);
      r.playerSpawns[3] = [14, 10];
      wallOff(r, 14, 10);
      // le contour de la salle fait déjà mur à droite/en bas : on emmure le reste
    });
    expectError(errors, /playerSpawns\[3\] n'est pas relié au premier spawn/);
  });

  it('dépendance circulaire entre portes', () => {
    const errors = mutated((l) => {
      (mech(l, 'dA') as { requires: string[] }).requires = ['dK'];
      (mech(l, 'dK') as { requires: string[] }).requires = ['dA'];
    });
    expectError(errors, /porte? .*dA|door "dA"/);
    expectError(errors, /dépendance circulaire/);
  });

  it('exigence de sortie satisfiable à 1 joueur (mécanisme waived) mais pas à 2+ : erreur ciblée sur n=2,3,4', () => {
    const l = makeTestLevel();
    const room = l.rooms[0];
    room.layout = makeTestLayout(16, 12);
    room.mechanisms = [
      { id: 'p1', type: 'plate', tile: [6, 4] },
      { id: 'px', type: 'plate', tile: [9, 8], minPlayers: 2 },
    ];
    room.exit.requires = ['p1', 'px'];
    for (let y = 7; y <= 9; y++) for (let x = 8; x <= 10; x++) setGlyph(room, x, y, '#');
    setGlyph(room, 9, 8, '.'); // plaque emmurée (centre)
    // la sortie reste accessible (9..10, 5..6)
    const errors = validateLevel(l);
    expectError(errors, /plate "px" inatteignable depuis les spawns \(n=2,3,4\)/);
    expectError(errors, /exit\.requires "px" non satisfiable \(n=2,3,4\)/);
    expect(errors.some((e) => /n=1[,)]/.test(e) && /px/.test(e))).toBe(false);
  });

  it('objectif de kills impossible : plus de kills requis que d\'ennemis présents à n joueurs', () => {
    const l = richLevel();
    l.objectives[2] = { id: 'o2', slot: 2, roomId: 'a', kind: 'kills', labelKey: 'objective.test.o2', count: 2, enemyKind: 'bat' };
    l.rooms[0].enemies.push({ kind: 'bat', tile: [13, 3], minPlayers: 2 }); // 2 bats à 2+ joueurs, aucun à 1
    const errors = validateLevel(l);
    expectError(errors, /objectif "o2" non accomplissable \(n=1\)/);
    expect(errors.some((e) => /objectif "o2" non accomplissable \(n=1,2,3,4\)/.test(e))).toBe(false);
  });

  it('objectif de mécanisme dont le mécanisme est inatteignable', () => {
    const errors = mutated((l) => wallOff(roomA(l), 3, 10));
    expectError(errors, /objectif "o0" non accomplissable \(n=1,2,3,4\)/);
  });

  it('apparition d\'ennemi conditionnée par un mécanisme inatteignable', () => {
    const errors = mutated((l) => wallOff(roomA(l), 4, 4));
    expectError(errors, /ennemi skeleton en \[12,9\] : apparition conditionnée par "pa" non satisfiable/);
  });
});

// ───────────────────────────── Mécanismes inédits (statues, sablier, pont de lumière) ─────────────────────────────

describe('validateLevel — statues jumelles, sablier, pont de lumière', () => {
  const STATUE: MechanismDef = {
    id: 'sp',
    type: 'statuePair',
    statues: [
      { tile: [4, 3], standTile: [4, 5], facing: 'up' },
      { tile: [12, 3], standTile: [12, 5], facing: 'left' },
    ],
    targetDir: 'down',
  };
  const HOURGLASS: MechanismDef = {
    id: 'hg',
    type: 'hourglass',
    levers: [[5, 8], [11, 8]],
    gate: [[8, 8], [8, 9]],
    periodMs: 4000,
    displayTile: [8, 7],
  };
  const BRIDGE: MechanismDef = { id: 'br', type: 'lightBridge', tiles: [[6, 6], [7, 6]], lanternSlot: 0, radiusTiles: 3 };
  const STATUES_OK = [
    { tile: [4, 3], standTile: [4, 5], facing: 'up' },
    { tile: [12, 3], standTile: [12, 5], facing: 'left' },
  ];

  /** Niveau d'une seule salle (finale) avec les mécanismes donnés ; les 4 objectifs visent le premier mécanisme. */
  function novel(mechanisms: MechanismDef[], room: Partial<RoomDef> = {}): LevelDef {
    const r = makeTestRoom({
      id: 'n',
      layout: makeTestLayout(16, 12),
      mechanisms,
      exit: { rect: { x: 13, y: 8, w: 2, h: 2 }, requires: [], final: true },
      ...room,
    });
    return makeTestLevel({
      rooms: [r],
      objectives: [0, 1, 2, 3].map((slot) => ({
        id: `o${slot}`,
        slot,
        roomId: 'n',
        kind: 'mechanism' as const,
        labelKey: `objective.test.o${slot}`,
        mechanismId: mechanisms[0]?.id ?? 'none',
      })),
    });
  }
  const withMech = (m: MechanismDef, patch: Record<string, unknown>): MechanismDef => ({ ...m, ...patch }) as MechanismDef;
  const errorsOf = (m: MechanismDef, patch: Record<string, unknown>): string[] => validateLevel(novel([withMech(m, patch)]));

  it('une salle valide avec les trois mécanismes (et sablier dans exit.requires) est acceptée ; ils comptent comme coopératifs', () => {
    const exit = { rect: { x: 13, y: 8, w: 2, h: 2 }, requires: ['sp', 'hg'], final: true };
    expect(validateLevel(novel([STATUE, HOURGLASS, BRIDGE], { exit }))).toEqual([]);
    for (const m of [STATUE, HOURGLASS, BRIDGE]) expect(validateLevel(novel([m]))).toEqual([]);
  });

  it('statuePair : tuiles hors grille / sur un mur, tuiles confondues, orientation invalide, déjà résolue', () => {
    expectError(errorsOf(STATUE, { statues: [{ tile: [-1, 3], standTile: [4, 5], facing: 'up' }, STATUES_OK[1]] }), /statues\[0\]\.tile est hors de la grille/);
    expectError(errorsOf(STATUE, { statues: [{ tile: [4, 3], standTile: [0, 5], facing: 'up' }, STATUES_OK[1]] }), /statues\[0\]\.standTile est sur un mur/);
    expectError(errorsOf(STATUE, { statues: [{ tile: [4, 3], standTile: [4, 3], facing: 'up' }, STATUES_OK[1]] }), /confondue avec statues\[0\]\.tile/);
    expectError(errorsOf(STATUE, { statues: [{ tile: [4, 3], standTile: [12, 5], facing: 'up' }, STATUES_OK[1]] }), /standTile \[12,5\] est confondue/);
    expectError(errorsOf(STATUE, { targetDir: 'north' }), /targetDir invalide/);
    expectError(errorsOf(STATUE, { statues: [{ tile: [4, 3], standTile: [4, 5], facing: 'sideways' }, STATUES_OK[1]] }), /facing invalide/);
    expectError(
      errorsOf(STATUE, { statues: [{ tile: [4, 3], standTile: [4, 5], facing: 'down' }, { tile: [12, 3], standTile: [12, 5], facing: 'down' }] }),
      /déjà résolue au départ/,
    );
    expectError(errorsOf(STATUE, { statues: [STATUES_OK[0]] }), /exactement 2 statues/);
  });

  it('statuePair : la statue est solide (pas de spawn/ennemi dessus), les socles doivent être atteignables', () => {
    expectError(validateLevel(novel([STATUE], { playerSpawns: [[4, 3], [3, 2], [2, 3], [3, 3]] })), /playerSpawns\[0\] \[4,3\] recouvre la statue "sp"/);
    expectError(validateLevel(novel([STATUE], { enemies: [{ kind: 'slime', tile: [12, 3] }] })), /ennemi\[0\] \(slime\) \[12,3\] recouvre la statue "sp"/);
    // socle emmuré : un anneau de murs autour du socle (4,5)
    const l = novel([STATUE]);
    for (const [x, y] of [[3, 4], [4, 4], [5, 4], [3, 5], [5, 5], [3, 6], [4, 6], [5, 6]]) setGlyph(l.rooms[0], x, y, '#');
    expectError(validateLevel(l), /statuePair "sp" inatteignable depuis les spawns/);
  });

  it('statuePair : un socle sur une porte est refusé', () => {
    const door: MechanismDef = { id: 'd', type: 'door', tiles: [[4, 5]], requires: ['sp'] };
    expectError(validateLevel(novel([STATUE, door])), /socle 0 de "sp" \[4,5\] recouvre la porte "d"/);
  });

  it('hourglass : leviers (≥ 2), herse (≥ 1), périodes > 0, tuiles de sol distinctes', () => {
    expectError(errorsOf(HOURGLASS, { levers: [[5, 8]] }), /levers doit contenir au moins 2 tuile/);
    expectError(errorsOf(HOURGLASS, { gate: [] }), /gate doit contenir au moins 1 tuile/);
    expectError(errorsOf(HOURGLASS, { periodMs: 0 }), /periodMs doit être un nombre > 0/);
    expectError(errorsOf(HOURGLASS, { periodMs: -5 }), /periodMs doit être un nombre > 0/);
    expectError(errorsOf(HOURGLASS, { closeStepMs: 0 }), /closeStepMs doit être un nombre > 0/);
    expectError(errorsOf(HOURGLASS, { levers: [[5, 8], [5, 8]] }), /levers\[1\] \[5,8\] est confondue avec levers\[0\]/);
    expectError(errorsOf(HOURGLASS, { gate: [[8, 8], [5, 8]] }), /gate\[1\] \[5,8\] est confondue avec levers\[0\]/);
    expectError(errorsOf(HOURGLASS, { levers: [[0, 8], [11, 8]] }), /levers\[0\] est sur un mur/);
    expectError(errorsOf(HOURGLASS, { gate: [[8, 99]] }), /gate\[0\] est hors de la grille/);
    expectError(errorsOf(HOURGLASS, { displayTile: [0, 0] }), /displayTile est sur un mur/);
  });

  it('hourglass : herse fermée au départ (pas de spawn/ennemi/levier dessus) ; une porte ne peut pas exiger un sablier', () => {
    expectError(validateLevel(novel([HOURGLASS], { playerSpawns: [[8, 8], [3, 2], [2, 3], [3, 3]] })), /playerSpawns\[0\] \[8,8\] recouvre la herse "hg"/);
    expectError(validateLevel(novel([HOURGLASS], { enemies: [{ kind: 'slime', tile: [8, 9] }] })), /recouvre la herse "hg"/);
    expectError(validateLevel(novel([HOURGLASS, { id: 'lv', type: 'lever', tile: [8, 9] }])), /levier "lv" \[8,9\] recouvre la herse/);
    const door: MechanismDef = { id: 'd', type: 'door', tiles: [[13, 4]], requires: ['hg'] };
    expectError(validateLevel(novel([HOURGLASS, door])), /porte "d" requires "hg" : un sablier ne peut pas ouvrir une porte/);
    // l'exigence de sortie, elle, est acceptée
    expect(validateLevel(novel([HOURGLASS], { exit: { rect: { x: 13, y: 8, w: 2, h: 2 }, requires: ['hg'], final: true } }))).toEqual([]);
  });

  it('hourglass : un levier emmuré est détecté', () => {
    const l = novel([HOURGLASS]);
    for (const [x, y] of [[10, 7], [11, 7], [12, 7], [10, 8], [12, 8], [10, 9], [11, 9], [12, 9]]) setGlyph(l.rooms[0], x, y, '#');
    expectError(validateLevel(l), /hourglass "hg" inatteignable depuis les spawns/);
  });

  it('lightBridge : tuiles, lanternSlot entier 0..3, rayon > 0, pas de spawn dessus', () => {
    expectError(errorsOf(BRIDGE, { tiles: [] }), /tiles doit contenir au moins 1 tuile/);
    expectError(errorsOf(BRIDGE, { tiles: [[6, 6], [6, 6]] }), /tiles\[1\] \[6,6\] dupliquée/);
    expectError(errorsOf(BRIDGE, { tiles: [[0, 6]] }), /tiles\[0\] est sur un mur/);
    expectError(errorsOf(BRIDGE, { lanternSlot: 4 }), /lanternSlot doit être un entier 0..3/);
    expectError(errorsOf(BRIDGE, { lanternSlot: 1.5 }), /lanternSlot doit être un entier 0..3/);
    expectError(errorsOf(BRIDGE, { radiusTiles: 0 }), /radiusTiles doit être un nombre > 0/);
    expectError(errorsOf(BRIDGE, { radiusTiles: -1 }), /radiusTiles doit être un nombre > 0/);
    expectError(validateLevel(novel([BRIDGE], { playerSpawns: [[6, 6], [3, 2], [2, 3], [3, 3]] })), /playerSpawns\[0\] \[6,6\] recouvre le pont de lumière "br"/);
    expectError(validateLevel(novel([BRIDGE], { enemies: [{ kind: 'bat', tile: [7, 6] }] })), /recouvre le pont de lumière "br"/);
  });

  it('requires vers ces mécanismes : id existant exigé, vérifié comme les autres', () => {
    const door: MechanismDef = { id: 'd', type: 'door', tiles: [[13, 4]], requires: ['sp', 'br'] };
    expect(validateLevel(novel([STATUE, BRIDGE, door]))).toEqual([]);
    const bad: MechanismDef = { id: 'd', type: 'door', tiles: [[13, 4]], requires: ['spx'] };
    expectError(validateLevel(novel([STATUE, bad])), /porte "d" requires "spx" : mécanisme inexistant/);
    expectError(validateLevel(novel([STATUE], { exit: { rect: { x: 13, y: 8, w: 2, h: 2 }, requires: ['hgx'], final: true } })), /exit\.requires "hgx" : mécanisme inexistant/);
    expectError(validateLevel(novel([STATUE], { enemies: [{ kind: 'slime', tile: [9, 9], when: 'brx' }] })), /when "brx" : mécanisme inexistant/);
  });

  it('un mécanisme inédit seul (minPlayers 2) ne suffit pas comme mécanisme coopératif à 1 joueur', () => {
    expectError(errorsOf(STATUE, { minPlayers: 2 }), /aucun mécanisme coopératif/);
  });

  it('salle de boss pure : une arène de demi-boss (warden, pyromancer, wraith) est aussi admise', () => {
    for (const kind of ['warden', 'pyromancer', 'wraith'] as const) {
      const l = novel([], { enemies: [{ kind, tile: [8, 5] }] });
      expect(validateLevel(l).filter((e) => /mécanisme coopératif/.test(e))).toEqual([]);
    }
  });

  it('salle de boss pure : tous les boss de fin (frostqueen, forgelord, voidlord) sont admis', () => {
    for (const kind of ['frostqueen', 'forgelord', 'voidlord'] as const) {
      const l = novel([], { enemies: [{ kind, tile: [8, 5] }] });
      expect(validateLevel(l).filter((e) => /mécanisme coopératif/.test(e))).toEqual([]);
    }
  });
});

// ───────────────────────────── Structure demi-boss / boss ─────────────────────────────

describe('validateBossStructure', () => {
  const EXIT_CLEAR = { rect: { x: 13, y: 8, w: 2, h: 2 }, requires: ['clear'] };

  function bossLevel(mid: Partial<RoomDef> = {}, last: Partial<RoomDef> = {}): LevelDef {
    const a = makeTestRoom({ id: 'a', mechanisms: [], enemies: [{ kind: 'slime', tile: [4, 4] }], exit: { rect: { x: 10, y: 5, w: 2, h: 2 }, requires: [] } });
    const m = makeTestRoom({ id: 'm', layout: makeTestLayout(16, 12), enemies: [{ kind: 'warden', tile: [8, 5] }], exit: EXIT_CLEAR, ...mid });
    const f = makeTestRoom({
      id: 'f',
      enemies: [{ kind: 'frostqueen', tile: [8, 5] }],
      exit: { rect: { x: 9, y: 5, w: 2, h: 2 }, requires: ['clear'], final: true },
      ...last,
    });
    return makeTestLevel({ rooms: [a, m, f] });
  }

  it('conforme : un demi-boss dans une salle dont la sortie exige clear + un boss dans la salle finale', () => {
    expect(validateBossStructure(bossLevel(), { minMiniBosses: 1 })).toEqual([]);
    expect(validateBossStructure(bossLevel(), { minMiniBosses: 0 })).toEqual([]);
  });

  it('pas assez de demi-boss', () => {
    expectError(validateBossStructure(bossLevel(), { minMiniBosses: 2 }), /2 demi-boss exigé\(s\) mais trouvé\(s\) 1 à n=1, 1 à n=2/);
  });

  it('un demi-boss qui n\'apparaît qu\'à partir de 2 joueurs ne compte pas à 1 joueur', () => {
    const l = bossLevel({ enemies: [{ kind: 'warden', tile: [8, 5], minPlayers: 2 }] });
    expectError(validateBossStructure(l, { minMiniBosses: 1 }), /1 demi-boss exigé\(s\) mais trouvé\(s\) 0 à n=1/);
  });

  it('la sortie de la salle du demi-boss doit exiger clear', () => {
    const l = bossLevel({ exit: { rect: { x: 13, y: 8, w: 2, h: 2 }, requires: [] } });
    expectError(validateBossStructure(l, { minMiniBosses: 1 }), /salle "m" : contient un demi-boss \(warden\) mais sa sortie n'exige pas 'clear'/);
  });

  it('clear exigé indirectement par une porte (transitif) est accepté', () => {
    const l = bossLevel({
      mechanisms: [
        { id: 'p1', type: 'plate', tile: [3, 3] },
        { id: 'd1', type: 'door', tiles: [[12, 3]], requires: ['clear'] },
        { id: 'd2', type: 'door', tiles: [[12, 4]], requires: ['d1', 'p1'] },
      ],
      exit: { rect: { x: 13, y: 8, w: 2, h: 2 }, requires: ['d2'] },
    });
    expect(validateBossStructure(l, { minMiniBosses: 1 })).toEqual([]);
  });

  it('une porte dépendant de clear qui barre l\'accès à la sortie est acceptée ; sinon refusée', () => {
    // mur vertical x=11 sauf (11,5) = porte « clear » ; sortie à droite
    const walled = makeTestLayout(16, 12).map((row, y) => (y >= 1 && y <= 10 ? row.slice(0, 11) + '#' + row.slice(12) : row));
    const layoutOpen = walled.map((row, y) => (y === 5 ? row.slice(0, 11) + '.' + row.slice(12) : row));
    const door: MechanismDef = { id: 'd1', type: 'door', tiles: [[11, 5]], requires: ['clear'] };
    const noExitReq = { rect: { x: 13, y: 8, w: 2, h: 2 }, requires: [] };
    expect(validateBossStructure(bossLevel({ layout: layoutOpen, mechanisms: [door], exit: noExitReq }), { minMiniBosses: 1 })).toEqual([]);
    // la porte ne barre rien : un second passage libre existe
    const layoutTwo = layoutOpen.map((row, y) => (y === 8 ? row.slice(0, 11) + '.' + row.slice(12) : row));
    const bad = bossLevel({ layout: layoutTwo, mechanisms: [door], exit: noExitReq });
    expectError(validateBossStructure(bad, { minMiniBosses: 1 }), /sa sortie n'exige pas 'clear'/);
  });

  it('la salle finale doit contenir un boss présent à chaque nombre de joueurs', () => {
    expectError(validateBossStructure(bossLevel({}, { enemies: [{ kind: 'slime', tile: [8, 5] }] }), { minMiniBosses: 1 }), /salle finale "f" : aucun boss/);
    expectError(
      validateBossStructure(bossLevel({}, { enemies: [{ kind: 'frostqueen', tile: [8, 5], minPlayers: 3 }] }), { minMiniBosses: 1 }),
      /salle finale "f" : aucun boss \(isBoss\) présent \(n=1,2\)/,
    );
  });

  it('options invalides ou niveau sans salle', () => {
    expectError(validateBossStructure(bossLevel(), { minMiniBosses: -1 }), /minMiniBosses doit être un entier >= 0/);
    expectError(validateBossStructure(bossLevel(), { minMiniBosses: 1.5 }), /minMiniBosses doit être un entier >= 0/);
    const empty = { ...bossLevel(), rooms: [] };
    expectError(validateBossStructure(empty, { minMiniBosses: 1 }), /aucune salle/);
  });

  it('les boss déjà connus (golem, morvane) comptent comme boss de salle finale', () => {
    expect(validateBossStructure(bossLevel({}, { enemies: [{ kind: 'morvane', tile: [8, 5] }] }), { minMiniBosses: 1 })).toEqual([]);
  });
});
