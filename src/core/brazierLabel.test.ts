import { describe, expect, it } from 'vitest';
import { SIM_STEP_MS } from './constants';
import { RoomGrid } from './grid';
import { makeTestDictionary, makeTestLevel, makeTestRoom, validateLevel } from './levelValidation';
import { createRoomMechanisms, mechanismLabelKey, tileCenterPx, updateMechanisms } from './mechanisms';
import { createPlayerState } from './players';
import type { BrazierDef, BrazierState, MechanismDef, MechanismState, PlayerState, RoomDef } from './types';

const COLD: BrazierDef = { id: 'b', type: 'brazier', tile: [5, 5], labelKey: 'lbl.cold', litLabelKey: 'lbl.lit' };

function st(partial: Partial<BrazierState>): BrazierState {
  return { id: 'b', type: 'brazier', waived: false, active: false, litBy: null, ...partial };
}

describe('mechanismLabelKey — brasero (fonction pure état -> clé)', () => {
  it('éteint : libellé d\'éteint ; allumé : libellé d\'allumé', () => {
    expect(mechanismLabelKey(COLD, st({ active: false }))).toBe('lbl.cold');
    expect(mechanismLabelKey(COLD, st({ active: true }))).toBe('lbl.lit');
  });

  it('waived (coop adaptative) : rendu allumé d\'office, donc libellé d\'allumé', () => {
    expect(mechanismLabelKey(COLD, st({ waived: true, active: true }))).toBe('lbl.lit');
    expect(mechanismLabelKey(COLD, st({ waived: true, active: false }))).toBe('lbl.lit');
  });

  it('un brasero qui repasse à éteint reprend son libellé d\'éteint', () => {
    const s = st({ active: true });
    expect(mechanismLabelKey(COLD, s)).toBe('lbl.lit');
    s.active = false;
    expect(mechanismLabelKey(COLD, s)).toBe('lbl.cold');
  });

  it('sans litLabelKey : labelKey en toute circonstance (comportement inchangé)', () => {
    const plain: BrazierDef = { id: 'b', type: 'brazier', tile: [5, 5], labelKey: 'lbl.cold' };
    expect(mechanismLabelKey(plain, st({ active: true }))).toBe('lbl.cold');
    expect(mechanismLabelKey(plain, st({ active: false }))).toBe('lbl.cold');
    const none: BrazierDef = { id: 'b', type: 'brazier', tile: [5, 5] };
    expect(mechanismLabelKey(none, st({ active: true }))).toBeUndefined();
  });

  it('état absent ou d\'un autre type : labelKey', () => {
    expect(mechanismLabelKey(COLD, undefined)).toBe('lbl.cold');
    const other: MechanismState = { id: 'b', type: 'lever', waived: false, active: true, remainingMs: 0 } as MechanismState;
    expect(mechanismLabelKey(COLD, other)).toBe('lbl.cold');
  });

  it('autres types de mécanismes : labelKey, jamais modifié par l\'état', () => {
    const plate: MechanismDef = { id: 'p', type: 'plate', tile: [1, 1], labelKey: 'lbl.plate' };
    const lever: MechanismDef = { id: 'l', type: 'lever', tile: [1, 1], labelKey: 'lbl.lever' };
    const s = { id: 'p', type: 'plate', waived: false, active: true } as MechanismState;
    expect(mechanismLabelKey(plate, s)).toBe('lbl.plate');
    expect(mechanismLabelKey(lever, { ...s, id: 'l', type: 'lever' } as MechanismState)).toBe('lbl.lever');
    expect(mechanismLabelKey({ id: 'p', type: 'plate', tile: [1, 1] }, s)).toBeUndefined();
  });
});

describe('mechanismLabelKey — avec la simulation (aucune horloge réelle)', () => {
  it('Action sur un brasero éteint : son libellé passe de « éteint » à « allumé »', () => {
    const room: RoomDef = makeTestRoom({ mechanisms: [{ id: 'p1', type: 'plate', tile: [6, 4] }, COLD] });
    const grid = new RoomGrid(room.layout);
    const mechanisms = createRoomMechanisms(room, 1);
    const p: PlayerState = createPlayerState({ id: 0, characterId: 'david', difficulty: 2 }, tileCenterPx([5, 4]));
    const label = (): string | undefined => mechanismLabelKey(COLD, mechanisms.find((m) => m.id === 'b'));
    expect(label()).toBe('lbl.cold');
    const events = updateMechanisms({
      room,
      grid,
      mechanisms,
      players: [p],
      frames: {},
      interactPressed: { 0: true },
      dtMs: SIM_STEP_MS,
      aliveEnemyCount: 0,
      objectiveDone: () => false,
      zoneOccupied: () => false,
      zoneEntered: () => false,
    });
    expect(events.some((e) => e.type === 'brazierLit')).toBe(true);
    expect(label()).toBe('lbl.lit');
  });

  it('brasero waived (n < minPlayers) : libellé d\'allumé dès la création', () => {
    const room: RoomDef = makeTestRoom({ mechanisms: [{ id: 'p1', type: 'plate', tile: [6, 4] }, { ...COLD, minPlayers: 2 }] });
    const solo = createRoomMechanisms(room, 1).find((m) => m.id === 'b');
    const duo = createRoomMechanisms(room, 2).find((m) => m.id === 'b');
    expect(mechanismLabelKey({ ...COLD, minPlayers: 2 }, solo)).toBe('lbl.lit');
    expect(mechanismLabelKey({ ...COLD, minPlayers: 2 }, duo)).toBe('lbl.cold');
  });

  it('brasero allumé au départ avec litLabelKey : libellé d\'allumé', () => {
    const lit: BrazierDef = { ...COLD, lit: true };
    const room: RoomDef = makeTestRoom({ mechanisms: [{ id: 'p1', type: 'plate', tile: [6, 4] }, lit] });
    expect(mechanismLabelKey(lit, createRoomMechanisms(room, 1).find((m) => m.id === 'b'))).toBe('lbl.lit');
  });
});

describe('validateLevel — litLabelKey', () => {
  function level(b: BrazierDef) {
    return makeTestLevel({ rooms: [makeTestRoom({ id: 'r1', mechanisms: [{ id: 'p1', type: 'plate', tile: [6, 4] }, b], exit: { rect: { x: 9, y: 5, w: 2, h: 2 }, requires: ['p1'], final: true } })] });
  }

  it('brasero avec litLabelKey valide : aucune erreur', () => {
    const l = level(COLD);
    const dict = { ...makeTestDictionary(l), 'lbl.cold': 'Froid', 'lbl.lit': 'Allumé' };
    expect(validateLevel(l, { dictionaries: { fr: dict, en: dict } })).toEqual([]);
  });

  it('litLabelKey inconnu des dictionnaires : erreur i18n (fr et en)', () => {
    const l = level({ ...COLD, litLabelKey: 'lbl.inconnu' });
    const dict = { ...makeTestDictionary(l), 'lbl.cold': 'Froid', 'lbl.lit': 'Allumé' };
    delete (dict as Record<string, string>)['lbl.inconnu'];
    const errors = validateLevel(l, { dictionaries: { fr: dict, en: dict } });
    expect(errors.some((e) => /i18n \[fr\] : clé manquante ou vide "lbl\.inconnu".*litLabelKey/.test(e))).toBe(true);
    expect(errors.some((e) => /i18n \[en\] : clé manquante ou vide "lbl\.inconnu"/.test(e))).toBe(true);
  });

  it('litLabelKey vide : erreur', () => {
    const errors = validateLevel(level({ ...COLD, litLabelKey: '  ' }));
    expect(errors.some((e) => /brasero "b" litLabelKey vide/.test(e))).toBe(true);
  });

  it('litLabelKey sans labelKey : erreur (l\'étiquette n\'existerait pas)', () => {
    const errors = validateLevel(level({ id: 'b', type: 'brazier', tile: [5, 5], litLabelKey: 'lbl.lit' }));
    expect(errors.some((e) => /brasero "b" litLabelKey sans labelKey/.test(e))).toBe(true);
  });
});
