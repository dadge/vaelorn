import { describe, expect, it } from 'vitest';
import {
  collectRequiredI18nKeys,
  makeTestDictionary,
  makeTestLayout,
  makeTestLevel,
  makeTestRoom,
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
