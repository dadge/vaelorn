import { describe, expect, it } from 'vitest';
import { RoomGrid } from '../core/grid';
import { makeTestLevel, makeTestRoom } from '../core/levelValidation';
import type { BrazierDef, RoomDef } from '../core/types';
import { DEV_BRAZIER_ID, findBrazierTile, forceDarkLevel, forceDarkRoom, isDevDarkAllowed, isDevDarkRequested } from './devDark';

describe('paramètre ?dark=1', () => {
  it('reconnaît dark=1 / dark=true seulement', () => {
    expect(isDevDarkRequested('?dark=1')).toBe(true);
    expect(isDevDarkRequested('?quick=1&dark=1&lang=fr')).toBe(true);
    expect(isDevDarkRequested('?dark=true')).toBe(true);
    expect(isDevDarkRequested('?dark=0')).toBe(false);
    expect(isDevDarkRequested('?dark=')).toBe(false);
    expect(isDevDarkRequested('')).toBe(false);
  });

  it('pris en compte seulement en dev ou avec debug=1', () => {
    expect(isDevDarkAllowed('?dark=1', true)).toBe(true);
    expect(isDevDarkAllowed('?dark=1', false)).toBe(false);
    expect(isDevDarkAllowed('?dark=1&debug=1', false)).toBe(true);
    expect(isDevDarkAllowed('?debug=1', true)).toBe(false);
  });
});

describe('forceDarkLevel', () => {
  it('clone sans muter les données ; toutes les salles deviennent sombres', () => {
    const level = makeTestLevel({ roomCount: 3 });
    const snapshot = JSON.stringify(level);
    const dark = forceDarkLevel(level, true);
    expect(JSON.stringify(level)).toBe(snapshot);
    expect(dark).not.toBe(level);
    expect(dark.rooms).toHaveLength(3);
    for (const r of dark.rooms) expect(r.dark).toBe(true);
    for (const r of level.rooms) expect(r.dark).toBeUndefined();
  });

  it('ajoute un brasero virtuel allumé, sur une tuile praticable et libre, aux salles sans brasero', () => {
    const room = makeTestRoom();
    const dark = forceDarkRoom(room, true);
    const b = dark.mechanisms.find((m) => m.type === 'brazier') as BrazierDef | undefined;
    expect(b).toBeDefined();
    expect(b?.id).toBe(DEV_BRAZIER_ID);
    expect(b?.lit).toBe(true);
    const grid = new RoomGrid(room.layout);
    expect(grid.blocksMovement(b!.tile[0], b!.tile[1])).toBe(false);
    for (const s of room.playerSpawns) expect(s[0] === b!.tile[0] && s[1] === b!.tile[1]).toBe(false);
    expect(room.mechanisms.some((m) => m.type === 'brazier')).toBe(false);
  });

  it('sans addVirtualBrazier : aucun brasero ajouté', () => {
    const dark = forceDarkRoom(makeTestRoom(), false);
    expect(dark.mechanisms.some((m) => m.type === 'brazier')).toBe(false);
    expect(dark.dark).toBe(true);
  });

  it('une salle qui a déjà un brasero n en reçoit pas de second', () => {
    const room: RoomDef = makeTestRoom({ mechanisms: [{ id: 'p1', type: 'plate', tile: [6, 4] }, { id: 'br', type: 'brazier', tile: [5, 5] }] });
    const dark = forceDarkRoom(room, true);
    expect(dark.mechanisms.filter((m) => m.type === 'brazier')).toHaveLength(1);
  });

  it('findBrazierTile : évite mécanismes, décors et sortie', () => {
    const room = makeTestRoom();
    const t = findBrazierTile(room);
    expect(t).not.toBeNull();
    expect(t![0] === 6 && t![1] === 4).toBe(false);
  });
});
