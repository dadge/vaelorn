/**
 * APPEL AUTOMATIQUE et emplacement cœur (`options.heartSlot`) : NOUVELLE règle — l'appel de cœur part quand l'emplacement du joueur est ENTIER (quels que soient ses PV ; un emplacement vide ou à demi-cœur
 * ramasse / fusionne) ; les destinataires utiles sont les alliés VIVANTS qui PEUVENT ranger : emplacement LIBRE ou contenant un DEMI-cœur (fusion). Sans l'option : règle d'origine (PV pleins / alliés blessés), strictement inchangée (voir `autoCall.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import { heartSlotUsefulTo, heartUsefulTo, stepAutoCalls } from './autoCall';
import { AUTO_CALL_DURATION_MS, PICKUP_RADIUS, PICKUP_TTL_MS } from './balance';
import { makeTestLevel, makeTestRoom } from './levelValidation';
import { createPlayerState, markPlayerDown } from './players';
import { createSimulation } from './simulation';
import { SIM_STEP_MS } from './constants';
import type { PickupState, PlayerId, PlayerState, SimEvent } from './types';

let nextId = 100;
const mkPlayer = (id: PlayerId, x: number, y = 100): PlayerState => createPlayerState({ id, characterId: 'david', difficulty: 2 }, { x, y });
const team = (n = 2): PlayerState[] => Array.from({ length: n }, (_, i) => mkPlayer(i as PlayerId, 100 + i * 200));
const heart = (x: number, y: number, kind: PickupState['kind'] = 'full'): PickupState => ({ id: nextId++, kind, pos: { x, y }, ttlMs: PICKUP_TTL_MS });
const slot = (players: PlayerState[], pk: PickupState[]): SimEvent[] => stepAutoCalls(players, pk, [], [], { heartSlot: true });
const calls = (ev: readonly SimEvent[]): Extract<SimEvent, { type: 'autoCallStarted' }>[] => ev.filter((e): e is Extract<SimEvent, { type: 'autoCallStarted' }> => e.type === 'autoCallStarted');

describe('utilité d un cœur', () => {
  it('heartSlotUsefulTo : vivant ET emplacement libre OU à demi-cœur (fusion) ; entier = inutile ; la règle d origine (heartUsefulTo) reste « vivant ET blessé »', () => {
    const p = mkPlayer(0, 0);
    expect(heartSlotUsefulTo(p)).toBe(true);
    expect(heartUsefulTo(p)).toBe(false); // PV pleins
    p.heart = 'half';
    expect(heartSlotUsefulTo(p)).toBe(true); // un demi-cœur monte à l'entier
    p.heart = 'full';
    expect(heartSlotUsefulTo(p)).toBe(false);
    delete p.heart;
    markPlayerDown(p);
    expect(heartSlotUsefulTo(p)).toBe(false);
  });
});

describe('règle de l emplacement cœur : appel quand l emplacement est ENTIER', () => {
  it('emplacement plein, PV pleins, allié à l emplacement libre : appel avec le symbole du cœur (entier) / du demi-cœur', () => {
    for (const [kind, icon] of [['full', 'heart'], ['half', 'half']] as const) {
      const [a, b] = team();
      a.heart = 'full';
      const pk = [heart(a.pos.x, a.pos.y, kind)];
      const ev = calls(slot([a, b], pk));
      expect(ev, kind).toEqual([{ type: 'autoCallStarted', playerId: 0, icon, to: [1] }]);
      expect(a.autoCall).toEqual({ icon, ref: `p${pk[0].id}`, ms: AUTO_CALL_DURATION_MS, to: [1] });
    }
  });

  it('emplacement plein ET blessé : l appel part quand même (les PV ne comptent plus) ; l allié blessé mais à l emplacement plein n est pas destinataire', () => {
    const [a, b, c] = team(3);
    a.heart = 'full';
    a.hp = a.maxHp / 2; // blessé (au-dessus du seuil de la croix rouge) : sous l ancienne règle il aurait consommé le cœur, aucun appel
    b.hp = b.maxHp / 2; // blessé mais emplacement entier : ne peut pas le ranger
    b.heart = 'full';
    const ev = calls(slot([a, b, c], [heart(a.pos.x, a.pos.y)]));
    expect(ev).toHaveLength(1);
    expect(ev[0].to).toEqual([2]); // seul c (emplacement libre)
  });

  it('emplacement VIDE : le joueur le range lui-même (le ramassage a lieu avant) : aucun appel, même aux PV pleins', () => {
    const [a, b] = team();
    expect(slot([a, b], [heart(a.pos.x, a.pos.y)])).toEqual([]);
    expect(a.autoCall).toBeUndefined();
  });

  it('aucun allié qui puisse ranger (tous entiers) : AUCUN appel, aucun champ créé', () => {
    const [a, b] = team();
    a.heart = 'full';
    b.heart = 'full';
    expect(slot([a, b], [heart(a.pos.x, a.pos.y)])).toEqual([]);
    expect(a.autoCall).toBeUndefined();
    expect(a.autoCallCooldownMs).toBeUndefined();
    expect(a.autoCallSeen).toBeUndefined();
    // allié à terre : pas destinataire non plus
    const [c, d] = team();
    c.heart = 'full';
    markPlayerDown(d);
    expect(slot([c, d], [heart(c.pos.x, c.pos.y)])).toEqual([]);
  });

  it('FUSION : un joueur à demi-cœur ne déclenche AUCUN appel (il accepte l objet) ; un allié à demi-cœur EST destinataire, que l objet soit un cœur ou un demi-cœur ; un allié entier ne l est pas', () => {
    for (const kind of ['full', 'half'] as const) {
      const [a, b, c] = team(3);
      a.heart = 'full';
      b.heart = 'half'; // peut monter à l'entier : utile
      c.heart = 'full'; // ne peut rien ranger : inutile
      const ev = calls(slot([a, b, c], [heart(a.pos.x, a.pos.y, kind)]));
      expect(ev, kind).toHaveLength(1);
      expect(ev[0].to, kind).toEqual([1]);
      expect(ev[0].icon, kind).toBe(kind === 'full' ? 'heart' : 'half');
      // le porteur d un demi-cœur qui se tient sur l objet : pas d appel (il le fusionnera)
      const [d, e] = team();
      d.heart = 'half';
      expect(slot([d, e], [heart(d.pos.x, d.pos.y, kind)]), kind).toEqual([]);
      expect(d.autoCall).toBeUndefined();
    }
  });

  it('solo : aucun appel (rien à prévenir) ; hors du rayon de contact : rien', () => {
    const [a] = team(1);
    a.heart = 'full';
    expect(slot([a], [heart(a.pos.x, a.pos.y)])).toEqual([]);
    const [c, d] = team();
    c.heart = 'full';
    expect(slot([c, d], [heart(c.pos.x + PICKUP_RADIUS + 1, c.pos.y)])).toEqual([]);
  });

  it('anti-spam d origine conservé : un seul appel par couple (joueur, objet) tant que le joueur reste dessus', () => {
    const [a, b] = team();
    a.heart = 'full';
    const pk = [heart(a.pos.x, a.pos.y)];
    expect(slot([a, b], pk)).toHaveLength(1);
    delete a.autoCall;
    delete a.autoCallCooldownMs;
    expect(slot([a, b], pk)).toHaveLength(0);
  });

  it('un joueur à terre ne déclenche rien', () => {
    const [a, b] = team();
    a.heart = 'full';
    markPlayerDown(a);
    expect(slot([a, b], [heart(a.pos.x, a.pos.y)])).toEqual([]);
  });
});

describe('règle d origine inchangée sans l option (bots, calibration, démo)', () => {
  it('PV pleins : appel vers les alliés BLESSÉS ; emplacement ignoré', () => {
    const [a, b] = team();
    b.hp = 5;
    a.heart = 'full'; // sans l option, l emplacement n est pas lu
    const ev = calls(stepAutoCalls([a, b], [heart(a.pos.x, a.pos.y)], []));
    expect(ev).toEqual([{ type: 'autoCallStarted', playerId: 0, icon: 'heart', to: [1] }]);
    // allié aux PV pleins : aucun destinataire
    const [c, d] = team();
    expect(calls(stepAutoCalls([c, d], [heart(c.pos.x, c.pos.y)], []))).toEqual([]);
    expect(calls(stepAutoCalls([c, d], [heart(c.pos.x, c.pos.y)], [], [], { heartSlot: false }))).toEqual([]);
  });
});

describe('simulation : l appel automatique utilise la nouvelle règle quand heartSlot est actif', () => {
  function sim(heartSlot: boolean) {
    const room = makeTestRoom({ id: 'r1', exit: { rect: { x: 9, y: 5, w: 2, h: 2 }, requires: [] } });
    const level = makeTestLevel({ rooms: [{ ...room, exit: { ...room.exit, final: true } }] });
    const s = createSimulation({ levelId: level.id, players: [{ id: 0, characterId: 'david', difficulty: 2 }, { id: 1, characterId: 'sandrine', difficulty: 2 }], seed: 4, gear: false, heartSlot }, level);
    s.step(SIM_STEP_MS, {});
    s.state.players[0].pos = { x: 40, y: 40 };
    s.state.players[1].pos = { x: 120, y: 40 };
    return s;
  }
  const addPickup = (s: ReturnType<typeof sim>): void => {
    s.state.room.pickups?.push({ id: 1, kind: 'full', pos: { x: 41, y: 40 }, ttlMs: PICKUP_TTL_MS });
    s.state.nextPickupId = 2;
  };

  it('heartSlot : emplacement ENTIER, PV pleins -> appel (allié libre) ; l objet reste au sol', () => {
    const s = sim(true);
    s.state.players[0].heart = 'full';
    addPickup(s);
    const ev: SimEvent[] = [];
    for (let i = 0; i < 3; i++) ev.push(...s.step(SIM_STEP_MS, {}));
    expect(calls(ev)).toEqual([{ type: 'autoCallStarted', playerId: 0, icon: 'heart', to: [1] }]);
    expect(s.state.room.pickups).toHaveLength(1);
  });

  it('sans heartSlot : mêmes positions, PV pleins, allié aux PV pleins -> aucun appel (ancienne règle)', () => {
    const s = sim(false);
    addPickup(s);
    const ev: SimEvent[] = [];
    for (let i = 0; i < 3; i++) ev.push(...s.step(SIM_STEP_MS, {}));
    expect(calls(ev)).toEqual([]);
  });
});
