import { describe, expect, it } from 'vitest';
import type { SimEvent, SpecialKind } from '../core/types';
import { Sfx, sfxForEvent, sfxForSpecial, sfxVolume } from './sfx';

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

  it("autoCallStarted produit le son discret « autoCall », distinct de « call » (qui accompagne l'immobilisation de l'appel manuel)", () => {
    expect(sfxForEvent({ type: 'autoCallStarted', playerId: 0, icon: 'heart', to: [1] })).toBe('autoCall');
    expect(sfxForEvent({ type: 'autoCallStarted', playerId: 1, icon: 'gear', to: [0, 2] })).toBe('autoCall');
    expect(() => new Sfx().play('autoCall')).not.toThrow();
  });

  it("la croix rouge (autoCallStarted, icon 'cross') a son propre son « autoCallCross » : distinct de « autoCall » et de « call », discret, jouable sans audio sans lever", () => {
    expect(sfxForEvent({ type: 'autoCallStarted', playerId: 2, icon: 'cross', to: [0] })).toBe('autoCallCross');
    for (const icon of ['heart', 'half', 'gear'] as const) expect(sfxForEvent({ type: 'autoCallStarted', playerId: 0, icon, to: [1] })).toBe('autoCall');
    const s = new Sfx();
    expect(() => s.play('autoCallCross')).not.toThrow();
    s.destroy();
  });

  it("volumes : la croix rouge (urgente mais jamais agressive) reste PLUS DISCRÈTE que l'appel manuel et plus forte que le « tic » d'un objet ; aucun son d'appel automatique ne dépasse l'appel manuel", () => {
    expect(sfxVolume('autoCallCross')).toBeLessThan(sfxVolume('call'));
    expect(sfxVolume('autoCallCross')).toBeGreaterThan(sfxVolume('autoCall'));
    expect(sfxVolume('autoCall')).toBeLessThan(sfxVolume('call'));
    expect(sfxVolume('autoCallCross')).toBeLessThanOrEqual(0.05);
  });

  it('le son « call » peut être joué sans audio disponible (Node) sans lever', () => {
    const s = new Sfx();
    expect(() => s.play('call')).not.toThrow();
    s.destroy();
  });
});

describe('sons : emplacement cœur', () => {
  it('rangement, usage et refus ont chacun leur son discret ; heartLost n ajoute pas de son (pickupDropped joue déjà le « pop » du cœur tombé)', () => {
    expect(sfxForEvent({ type: 'heartStored', playerId: 0, pickupId: 1, kind: 'full', pos: { x: 0, y: 0 } })).toBe('heartStore');
    expect(sfxForEvent({ type: 'heartUsed', playerId: 0, targetId: 1, kind: 'half', amount: 5, pos: { x: 0, y: 0 } })).toBe('heartUse');
    expect(sfxForEvent({ type: 'heartRefused', playerId: 0 })).toBe('heartRefuse');
    expect(sfxForEvent({ type: 'heartLost', playerId: 0, kind: 'full', pos: { x: 0, y: 0 } })).toBeNull();
    expect(sfxForEvent({ type: 'pickupDropped', pickupId: 1, kind: 'full', pos: { x: 0, y: 0 } })).toBe('pickupDrop');
  });

  it('les trois sons se jouent sans audio (Node) sans lever ; le refus est plus discret que l usage', () => {
    const s = new Sfx();
    for (const n of ['heartStore', 'heartUse', 'heartRefuse'] as const) expect(() => s.play(n)).not.toThrow();
    s.destroy();
  });
});
