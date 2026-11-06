import { describe, expect, it } from 'vitest';
import { createSlots, claimSlot, missingSlots, releaseMissingSlots, stealMissingSlot, type PadInfo } from './menuLogic';

/** 4 emplacements pris par les manettes 0..3. */
function fullPads() {
  let s = createSlots(4);
  for (let i = 0; i < 4; i++) s = claimSlot(s, `gamepad:${i}`).slots;
  return s;
}
const pad = (index: number): PadInfo => ({ index, name: `Pad ${index}` });

describe('emplacements orphelins (manette absente)', () => {
  it('détecte les emplacements dont la manette a disparu', () => {
    const s = fullPads();
    expect(missingSlots(s, [pad(0), pad(1), pad(3)])).toEqual([false, false, true, false]);
  });

  it('le clavier n\'est jamais considéré comme absent', () => {
    const s = claimSlot(createSlots(2), 'keyboard').slots;
    expect(missingSlots(s, [])).toEqual([false, false]);
  });

  it('un nouvel appareil récupère l\'emplacement de la manette absente quand tout est plein', () => {
    const s = fullPads();
    const r = stealMissingSlot(s, 'keyboard', [pad(0), pad(1), pad(3)]);
    expect(r.result).toBe('claimed');
    expect(r.slot).toBe(2);
    expect(r.slots.owners).toEqual(['gamepad:0', 'gamepad:1', 'keyboard', 'gamepad:3']);
    // immuable
    expect(s.owners[2]).toBe('gamepad:2');
  });

  it('préfère un emplacement libre à un orphelin', () => {
    let s = fullPads();
    s = { owners: [s.owners[0], null, s.owners[2], s.owners[3]] };
    const r = stealMissingSlot(s, 'keyboard', [pad(0), pad(3)]);
    expect(r.slot).toBe(1);
  });

  it('reste « full » si toutes les manettes sont présentes', () => {
    const s = fullPads();
    const r = stealMissingSlot(s, 'keyboard', [pad(0), pad(1), pad(2), pad(3)]);
    expect(r.result).toBe('full');
    expect(r.slots).toBe(s);
  });

  it('un périphérique qui possède déjà un emplacement reste « already »', () => {
    const s = fullPads();
    expect(stealMissingSlot(s, 'gamepad:0', [pad(0)]).result).toBe('already');
  });

  it('releaseMissingSlots libère uniquement les orphelins', () => {
    const s = fullPads();
    const r = releaseMissingSlots(s, [pad(0), pad(2)]);
    expect(r.released).toEqual([1, 3]);
    expect(r.slots.owners).toEqual(['gamepad:0', null, 'gamepad:2', null]);
    expect(releaseMissingSlots(s, [pad(0), pad(1), pad(2), pad(3)]).slots).toBe(s);
  });
});
