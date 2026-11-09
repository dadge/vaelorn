import { describe, expect, it } from 'vitest';
import type { SimEvent, SpecialKind } from '../core/types';
import { Sfx, sfxForEvent, sfxForSpecial } from './sfx';

const KINDS: SpecialKind[] = ['whirlwind', 'fireNova', 'dash', 'healNova', 'arrowFan', 'quake', 'smash', 'bladeDance'];

describe('sfx des attaques spéciales', () => {
  it('chaque famille a un son propre', () => {
    const names = KINDS.map((k) => sfxForSpecial(k));
    expect(new Set(names).size).toBe(KINDS.length);
  });

  it('specialUsed / specialReady produisent un son', () => {
    const used: SimEvent = { type: 'specialUsed', playerId: 0, kind: 'quake', pos: { x: 0, y: 0 }, dir: 'down' };
    expect(sfxForEvent(used)).toBe('specialQuake');
    expect(sfxForEvent({ type: 'specialReady', playerId: 1 })).toBe('specialReady');
  });

  it('le lecteur ne lève jamais sans audio (Node)', () => {
    const s = new Sfx();
    for (const k of KINDS) expect(() => s.play(sfxForSpecial(k))).not.toThrow();
    expect(() => s.play('specialReady')).not.toThrow();
    s.destroy();
  });

  it('les anciens événements gardent leur son', () => {
    expect(sfxForEvent({ type: 'playerAttack', playerId: 0, pos: { x: 0, y: 0 }, dir: 'up' } as SimEvent)).toBe('attack');
  });
});

describe('sons : appel', () => {
  it('callStarted produit le son « call » ; aucun son pour les événements voisins non concernés', () => {
    expect(sfxForEvent({ type: 'callStarted', playerId: 2 })).toBe('call');
    expect(sfxForEvent({ type: 'callStarted', playerId: 0 })).toBe('call');
    expect(sfxForEvent({ type: 'specialReady', playerId: 0 })).toBe('specialReady');
  });

  it('le son « call » peut être joué sans audio disponible (Node) sans lever', () => {
    const s = new Sfx();
    expect(() => s.play('call')).not.toThrow();
    s.destroy();
  });
});
