/**
 * Tests du protocole : validation stricte de chaque type de message, entrées hors bornes, JSON invalide, messages géants,
 * fragmentation / réassemblage (manquants, dupliqués, en désordre, expirés, plafond mémoire), file d'événements bornée.
 */
import { describe, expect, it } from 'vitest';
import type { SimEvent } from '../core/types';
import { NET, NET_PROTOCOL_VERSION, SIM_EVENTS_NEVER_DROPPED, type LobbyState } from './contracts';
import {
  appendEvents,
  createDecoder,
  createEncoder,
  defaultPlayerName,
  validateMessage,
  type DecodeResult,
  type Direction,
  type MessageDecoder,
  type ProtocolMessage,
} from './protocol';

const BUILD = { version: '0.1.0', commit: 'abc1234', date: '2026-11-23' };

function lobby(overrides: Partial<LobbyState> = {}): LobbyState {
  return {
    seq: 3,
    levelIndex: 1,
    levelCount: 9,
    slots: [
      { slot: 0, name: 'Hôte', isHost: true, connected: true, characterId: 'david', difficulty: 2, ready: true },
      { slot: 1, name: 'Anna', isHost: false, connected: true, characterId: 'sandrine', difficulty: 1, ready: false, pingMs: 12 },
    ],
    ...overrides,
  };
}

/** Décode un objet quelconque comme le ferait la couche réseau (sérialisation JSON comprise). */
function decodeObj(direction: Direction, obj: unknown, now = 0): DecodeResult {
  return createDecoder(direction).decode(JSON.stringify(obj), now);
}

function msgOf(r: DecodeResult): ProtocolMessage {
  if (r.kind !== 'message') throw new Error(`message attendu, reçu ${r.kind}${r.kind === 'invalid' ? ` (${r.reason})` : ''}`);
  return r.msg;
}

function roundtrip(direction: Direction, msg: ProtocolMessage): ProtocolMessage {
  const texts = createEncoder().encode(msg);
  expect(texts).toHaveLength(1);
  return msgOf(createDecoder(direction).decode(texts[0], 0));
}

describe('protocole : messages valides (aller-retour)', () => {
  it('hello / welcome / reject / lobby / choice / start', () => {
    const hello = roundtrip('toHost', { t: 'hello', proto: NET_PROTOCOL_VERSION, build: BUILD, levels: 9, name: 'Zoé' });
    expect(hello).toEqual({ t: 'hello', proto: NET_PROTOCOL_VERSION, build: BUILD, levels: 9, name: 'Zoé' });

    const welcome = roundtrip('toGuest', { t: 'welcome', proto: NET_PROTOCOL_VERSION, build: BUILD, levels: 9, slot: 1, lobby: lobby() });
    expect(welcome).toMatchObject({ t: 'welcome', slot: 1 });
    expect((welcome as { lobby: LobbyState }).lobby.slots).toHaveLength(2);

    const reject = roundtrip('toGuest', { t: 'reject', proto: 1, build: BUILD, levels: 9, reason: 'build' });
    expect(reject).toMatchObject({ t: 'reject', reason: 'build' });

    expect(roundtrip('toGuest', { t: 'lobby', lobby: lobby(), you: 1 })).toMatchObject({ t: 'lobby', you: 1 });
    expect(roundtrip('toHost', { t: 'choice', characterId: 'mira', difficulty: 3, ready: true })).toEqual({
      t: 'choice',
      characterId: 'mira',
      difficulty: 3,
      ready: true,
    });
    const start = roundtrip('toGuest', {
      t: 'start',
      gid: 4000000000,
      you: 1,
      levelIndex: 2,
      seed: 123,
      players: [
        { id: 0, characterId: 'david', difficulty: 2, name: 'A' },
        { id: 1, characterId: 'mira', difficulty: 1, name: 'B' },
      ],
    });
    expect(start).toMatchObject({ t: 'start', gid: 4000000000, you: 1, seed: 123 });
  });

  it('input / pong / ping / end / leave', () => {
    expect(roundtrip('toHost', { t: 'input', gid: 7, seq: 1, x: -100, y: 100, b: 63 })).toEqual({ t: 'input', gid: 7, seq: 1, x: -100, y: 100, b: 63 });
    expect(roundtrip('toHost', { t: 'pong', n: 3, ts: 1234.5 })).toEqual({ t: 'pong', n: 3, ts: 1234.5 });
    expect(roundtrip('toGuest', { t: 'ping', n: 3, ts: 99 })).toEqual({ t: 'ping', n: 3, ts: 99 });
    expect(roundtrip('toGuest', { t: 'end', gid: 7, reason: 'levelCompleted' })).toEqual({ t: 'end', gid: 7, reason: 'levelCompleted' });
    expect(roundtrip('toGuest', { t: 'leave' })).toEqual({ t: 'leave' });
    expect(roundtrip('toHost', { t: 'leave' })).toEqual({ t: 'leave' });
  });

  it('snap : état et événements', () => {
    const ev = [{ type: 'roomEntered', roomIndex: 0, reason: 'start' }] as unknown as SimEvent[];
    const m = roundtrip('toGuest', { t: 'snap', gid: 1, n: 5, tick: 15, pc: 3, st: { version: 1, levelId: 'l1', players: [] } as never, ev });
    expect(m).toMatchObject({ t: 'snap', n: 5, tick: 15, pc: 3 });
    expect((m as { ev: unknown[] }).ev).toHaveLength(1);
  });

  it('ping : le champ facultatif r est conservé s\'il est valide, ignoré sinon', () => {
    expect(msgOf(decodeObj('toGuest', { t: 'ping', n: 1, ts: 5, r: 42 }))).toEqual({ t: 'ping', n: 1, ts: 5, r: 42 });
    expect(msgOf(decodeObj('toGuest', { t: 'ping', n: 1, ts: 5, r: -3 }))).toEqual({ t: 'ping', n: 1, ts: 5 });
    expect(msgOf(decodeObj('toGuest', { t: 'ping', n: 1, ts: 5, r: 'vite' }))).toEqual({ t: 'ping', n: 1, ts: 5 });
  });

  it('les champs inconnus sont ignorés et le message rendu est un objet neuf', () => {
    const raw = { t: 'choice', characterId: 'david', difficulty: 2, ready: false, extra: { a: 1 }, isAdmin: true };
    const m = msgOf(decodeObj('toHost', raw));
    expect(m).toEqual({ t: 'choice', characterId: 'david', difficulty: 2, ready: false });
    expect(Object.keys(m).sort()).toEqual(['characterId', 'difficulty', 'ready', 't']);
  });
});

describe('protocole : validation stricte', () => {
  const invalid = (direction: Direction, obj: unknown): string => {
    const r = decodeObj(direction, obj);
    expect(r.kind).toBe('invalid');
    return r.kind === 'invalid' ? r.reason : '';
  };

  it('rejette ce qui n\'est pas un objet avec un type', () => {
    for (const v of [null, 42, 'texte', true, [], [{ t: 'leave' }], {}, { t: 5 }, { t: null }, { t: 'inconnu' }]) invalid('toHost', v);
  });

  it('rejette un type du mauvais sens', () => {
    expect(invalid('toHost', { t: 'snap', gid: 1, n: 1, tick: 3, pc: 1, st: { version: 1, levelId: 'a' }, ev: [] })).toMatch(/^type:/);
    expect(invalid('toHost', { t: 'welcome' })).toMatch(/^type:/);
    expect(invalid('toHost', { t: 'start' })).toMatch(/^type:/);
    expect(invalid('toHost', { t: 'ping', n: 1, ts: 1 })).toMatch(/^type:/);
    expect(invalid('toGuest', { t: 'input', gid: 1, seq: 1, x: 0, y: 0, b: 0 })).toMatch(/^type:/);
    expect(invalid('toGuest', { t: 'hello', proto: 1 })).toMatch(/^type:/);
    expect(invalid('toGuest', { t: 'choice', characterId: 'david', difficulty: 2, ready: true })).toMatch(/^type:/);
    expect(invalid('toGuest', { t: 'pong', n: 1, ts: 1 })).toMatch(/^type:/);
  });

  it('input : axes, boutons, compteurs hors bornes ou de mauvais type', () => {
    const base = { t: 'input', gid: 7, seq: 1, x: 0, y: 0, b: 0 };
    expect(msgOf(decodeObj('toHost', base))).toMatchObject({ x: 0 });
    const bad: Record<string, unknown>[] = [
      { x: 101 },
      { x: -101 },
      { y: 101 },
      { y: -101 },
      { x: 0.5 },
      { x: '5' },
      { x: null },
      { y: true },
      { b: 64 },
      { b: -1 },
      { b: 1.5 },
      { b: '1' },
      { seq: -1 },
      { seq: 1.5 },
      { seq: 2 ** 31 },
      { seq: 'a' },
      { gid: -1 },
      { gid: 2 ** 32 },
      { gid: 1.5 },
      { gid: '7' },
      { gid: null },
    ];
    for (const patch of bad) invalid('toHost', { ...base, ...patch });
    // manquants
    for (const key of ['gid', 'seq', 'x', 'y', 'b']) {
      const o: Record<string, unknown> = { ...base };
      delete o[key];
      invalid('toHost', o);
    }
  });

  it('input : NaN et Infinity (non représentables en JSON) deviennent null et sont refusés', () => {
    const text = JSON.stringify({ t: 'input', gid: 1, seq: 1, x: Number.NaN, y: Number.POSITIVE_INFINITY, b: 0 });
    expect(createDecoder('toHost').decode(text, 0).kind).toBe('invalid');
  });

  it('choice : personnage, difficulté, ready', () => {
    const base = { t: 'choice', characterId: 'david', difficulty: 2, ready: false };
    for (const patch of [{ characterId: 'inconnu' }, { characterId: 5 }, { characterId: 'constructor' }, { difficulty: 0 }, { difficulty: 4 }, { difficulty: '2' }, { ready: 'oui' }, { ready: 1 }]) {
      invalid('toHost', { ...base, ...patch });
    }
  });

  it('hello : version identique = champs stricts ; autre version = lecture indulgente', () => {
    const base = { t: 'hello', proto: NET_PROTOCOL_VERSION, build: BUILD, levels: 9, name: 'Zoé' };
    invalid('toHost', { ...base, build: 'x' });
    invalid('toHost', { ...base, build: { version: 'a b', commit: null, date: null } });
    invalid('toHost', { ...base, build: { version: '1', commit: 5, date: null } });
    invalid('toHost', { ...base, levels: -1 });
    invalid('toHost', { ...base, levels: 'neuf' });
    invalid('toHost', { ...base, name: 'x'.repeat(300) });
    invalid('toHost', { ...base, name: 12 });
    invalid('toHost', { ...base, proto: 1.5 });
    invalid('toHost', { ...base, proto: -1 });
    invalid('toHost', { ...base, proto: '1' });
    // un autre protocole peut avoir une autre forme : on veut un refus « version », pas « message invalide »
    const other = msgOf(decodeObj('toHost', { t: 'hello', proto: NET_PROTOCOL_VERSION + 1, shape: 'nouvelle' }));
    expect(other).toMatchObject({ t: 'hello', proto: NET_PROTOCOL_VERSION + 1, levels: -1, name: '' });
  });

  it('hello : le nom est assaini (caractères, longueur) et jamais vide par erreur', () => {
    const m = msgOf(decodeObj('toHost', { t: 'hello', proto: NET_PROTOCOL_VERSION, build: BUILD, levels: 9, name: '  <b>Zo\u0000é</b>   !!  très très long nom de joueur ' }));
    const name = (m as { name: string }).name;
    expect(name).not.toMatch(/[<>!\u0000]/);
    expect(Array.from(name).length).toBeLessThanOrEqual(NET.NAME_MAX_CHARS);
    expect(name).toContain('Zo');
    const empty = msgOf(decodeObj('toHost', { t: 'hello', proto: NET_PROTOCOL_VERSION, build: BUILD, levels: 9, name: '<>' }));
    expect((empty as { name: string }).name).toBe('');
  });

  it('lobby : emplacements dupliqués, trop nombreux, hors plage, niveau hors bornes', () => {
    const l = lobby();
    const wrap = (lb: unknown): unknown => ({ t: 'lobby', lobby: lb, you: 1 });
    invalid('toGuest', wrap({ ...l, slots: [l.slots[0], { ...l.slots[1], slot: 0 }] }));
    invalid('toGuest', wrap({ ...l, slots: [...l.slots, ...l.slots, l.slots[0]] }));
    invalid('toGuest', wrap({ ...l, slots: [] }));
    invalid('toGuest', wrap({ ...l, slots: 'x' }));
    invalid('toGuest', wrap({ ...l, slots: [{ ...l.slots[0], slot: 4 }] }));
    invalid('toGuest', wrap({ ...l, slots: [{ ...l.slots[0], characterId: 'pirate' }] }));
    invalid('toGuest', wrap({ ...l, slots: [{ ...l.slots[0], ready: 'oui' }] }));
    invalid('toGuest', wrap({ ...l, levelIndex: 9 }));
    invalid('toGuest', wrap({ ...l, levelIndex: -1 }));
    invalid('toGuest', wrap({ ...l, levelCount: 0 }));
    invalid('toGuest', wrap({ ...l, seq: -1 }));
    invalid('toGuest', { t: 'lobby', lobby: l, you: 4 });
    invalid('toGuest', { t: 'lobby', lobby: l });
  });

  it('lobby : pingMs invalide ignoré, noms assainis, emplacements triés', () => {
    const l = lobby();
    const m = msgOf(
      decodeObj('toGuest', {
        t: 'lobby',
        you: 1,
        lobby: { ...l, slots: [{ ...l.slots[1], pingMs: -5, name: '<<>>' }, { ...l.slots[0], pingMs: 20 }] },
      }),
    );
    const slots = (m as { lobby: LobbyState }).lobby.slots;
    expect(slots.map((s) => s.slot)).toEqual([0, 1]);
    expect(slots[0].pingMs).toBe(20);
    expect(slots[1].pingMs).toBeUndefined();
    expect(slots[1].name).toBe(defaultPlayerName(1));
  });

  it('start : ids non contigus, personnages en double, you hors liste, graine invalide', () => {
    const p = (id: number, characterId: string) => ({ id, characterId, difficulty: 2, name: 'x' });
    const base = { t: 'start', gid: 1, you: 1, levelIndex: 0, seed: 5, players: [p(0, 'david'), p(1, 'mira')] };
    msgOf(decodeObj('toGuest', base));
    invalid('toGuest', { ...base, players: [p(0, 'david'), p(2, 'mira')] });
    invalid('toGuest', { ...base, players: [p(1, 'david'), p(0, 'mira')] });
    invalid('toGuest', { ...base, players: [p(0, 'david'), p(1, 'david')] });
    invalid('toGuest', { ...base, you: 2 });
    invalid('toGuest', { ...base, players: [] });
    invalid('toGuest', { ...base, players: Array.from({ length: 5 }, (_, i) => p(i, 'david')) });
    invalid('toGuest', { ...base, seed: 1.5 });
    invalid('toGuest', { ...base, seed: 2 ** 40 });
    invalid('toGuest', { ...base, levelIndex: 1000 });
    invalid('toGuest', { ...base, gid: -2 });
  });

  it('snap : enveloppe, état, événements', () => {
    const st = { version: 1, levelId: 'l1' };
    const base = { t: 'snap', gid: 1, n: 1, tick: 3, pc: 1, st, ev: [] };
    msgOf(decodeObj('toGuest', base));
    invalid('toGuest', { ...base, st: null });
    invalid('toGuest', { ...base, st: [] });
    invalid('toGuest', { ...base, st: { levelId: 'l1' } });
    invalid('toGuest', { ...base, st: { version: 2, levelId: 'l1' } });
    invalid('toGuest', { ...base, st: { version: 1, levelId: 5 } });
    invalid('toGuest', { ...base, st: { version: 1, levelId: '' } });
    invalid('toGuest', { ...base, st: { version: 1, levelId: 'x'.repeat(65) } });
    invalid('toGuest', { ...base, ev: {} });
    invalid('toGuest', { ...base, ev: Array.from({ length: NET.MAX_PENDING_EVENTS + 1 }, () => ({ type: 'roomCleared' })) });
    invalid('toGuest', { ...base, pc: 16 });
    invalid('toGuest', { ...base, pc: -1 });
    invalid('toGuest', { ...base, tick: -1 });
    invalid('toGuest', { ...base, tick: 1.5 });
    invalid('toGuest', { ...base, n: 'un' });
    invalid('toGuest', { ...base, gid: 2 ** 32 });
  });

  it('snap : les événements de type inconnu ou mal formés sont écartés, les autres gardés dans l\'ordre', () => {
    const ev = [
      { type: 'enemyHit', id: 1 },
      { type: 'pirateEvent', id: 2 },
      'texte',
      null,
      42,
      { type: 5 },
      { type: 'constructor' },
      { type: 'levelCompleted' },
    ];
    const m = msgOf(decodeObj('toGuest', { t: 'snap', gid: 1, n: 1, tick: 3, pc: 1, st: { version: 1, levelId: 'l' }, ev }));
    expect((m as { ev: { type: string }[] }).ev.map((e) => e.type)).toEqual(['enemyHit', 'levelCompleted']);
  });

  it('end / reject : raisons connues seulement', () => {
    invalid('toGuest', { t: 'end', gid: 1, reason: 'explosion' });
    invalid('toGuest', { t: 'end', gid: 1 });
    invalid('toGuest', { t: 'reject', proto: 1, build: BUILD, levels: 9, reason: 'parceQue' });
    invalid('toGuest', { t: 'reject', proto: 1, build: BUILD, levels: 9 });
  });

  it('ping / pong : compteurs entiers, horloge finie', () => {
    invalid('toGuest', { t: 'ping', n: -1, ts: 1 });
    invalid('toGuest', { t: 'ping', n: 1.5, ts: 1 });
    invalid('toGuest', { t: 'ping', n: 1, ts: '1' });
    invalid('toHost', { t: 'pong', n: 1, ts: null });
    expect(createDecoder('toHost').decode('{"t":"pong","n":1,"ts":1e999}', 0).kind).toBe('invalid');
  });

  it('refuse les clés __proto__, même échappées, avant tout JSON.parse', () => {
    const d = createDecoder('toHost');
    expect(d.decode('{"t":"leave","__proto__":{"admin":true}}', 0)).toEqual({ kind: 'invalid', reason: 'forbiddenKey' });
    expect(d.decode('{"t":"leave","\\u005f_proto__":{"admin":true}}', 0)).toEqual({ kind: 'invalid', reason: 'forbiddenKey' });
    expect(d.decode('{"t":"leave","\\u005F_proto__":1}', 0)).toEqual({ kind: 'invalid', reason: 'forbiddenKey' });
    // imbriquée dans une valeur
    expect(d.decode('{"t":"leave","x":{"y":{"__proto__":1}}}', 0)).toEqual({ kind: 'invalid', reason: 'forbiddenKey' });
    // le motif dans une VALEUR (nom de joueur « __proto__ ») est légitime : le message n'est pas refusé
    const hello = (name: string): string => JSON.stringify({ t: 'hello', proto: NET_PROTOCOL_VERSION, build: BUILD, levels: 9, name });
    for (const name of ['__proto__', 'x__proto__y', 'a__proto__']) {
      expect(d.decode(hello(name), 0)).toMatchObject({ kind: 'message', msg: { t: 'hello', name } });
    }
    // le mot « proto » seul (champ de `hello`) reste évidemment accepté
    expect(d.decode(JSON.stringify({ t: 'hello', proto: NET_PROTOCOL_VERSION, build: BUILD, levels: 9, name: 'x' }), 0).kind).toBe('message');
    // aucun effet sur le prototype global
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });

  it('JSON invalide, texte vide, texte non chaîne : jamais d\'exception', () => {
    const d = createDecoder('toGuest');
    for (const text of ['', '{', '}{', 'null', '[]', '"t"', '{"t":', 'undefined', '{t:"leave"}', '\u0000']) {
      expect(() => d.decode(text, 0)).not.toThrow();
      expect(d.decode(text, 0).kind).toBe('invalid');
    }
    expect(d.decode(undefined as unknown as string, 0)).toEqual({ kind: 'invalid', reason: 'notString' });
    expect(d.decode(42 as unknown as string, 0)).toEqual({ kind: 'invalid', reason: 'notString' });
  });

  it('message géant : refusé avant JSON.parse', () => {
    const d = createDecoder('toGuest');
    const huge = `{"t":"leave","pad":"${'x'.repeat(NET.MAX_MESSAGE_CHARS)}"}`;
    expect(d.decode(huge, 0)).toEqual({ kind: 'invalid', reason: 'tooLarge' });
    // à la limite : accepté
    const ok = `{"t":"leave","pad":"${'x'.repeat(NET.MAX_MESSAGE_CHARS - 30)}"}`;
    expect(ok.length).toBeLessThanOrEqual(NET.MAX_MESSAGE_CHARS);
    expect(d.decode(ok, 0).kind).toBe('message');
  });

  it('validateMessage ne lève jamais, même sur des objets hostiles', () => {
    const hostile: unknown[] = [
      Object.create(null),
      { t: 'lobby', lobby: { slots: [null] }, you: 0 },
      { t: 'start', players: [[]], you: 0 },
      { t: 'snap', gid: 1, n: 1, tick: 1, pc: 1, st: Object.create(null), ev: [] },
    ];
    for (const h of hostile) expect(() => validateMessage('toGuest', h)).not.toThrow();
    expect(validateMessage('toGuest', Object.assign(Object.create({ t: 'leave' }), {})).ok).toBe(false); // `t` hérité : ignoré
  });
});

describe('protocole : fragmentation', () => {
  /** Message valide et volumineux (un `snap` dont l'état porte un bloc de remplissage). */
  function bigSnap(pad: string): ProtocolMessage {
    return { t: 'snap', gid: 1, n: 1, tick: 3, pc: 1, st: { version: 1, levelId: 'l1', pad } as never, ev: [] };
  }

  it('un petit message part en un seul texte, sans fragment', () => {
    expect(createEncoder().encode({ t: 'leave' })).toEqual(['{"t":"leave"}']);
  });

  it('un message long est fragmenté, chaque texte tient dans la limite, et se réassemble à l\'identique', () => {
    const limit = NET.FRAGMENT_CHARS + 2048;
    const msg = bigSnap('abcdef"\\'.repeat(5000)); // beaucoup de guillemets / barres : l'échappement gonfle les fragments
    const texts = createEncoder(limit).encode(msg);
    expect(texts.length).toBeGreaterThan(3);
    for (const t of texts) expect(t.length).toBeLessThanOrEqual(limit);
    const d = createDecoder('toGuest');
    const results = texts.map((t) => d.decode(t, 0));
    expect(results.slice(0, -1).every((r) => r.kind === 'partial')).toBe(true);
    const last = results[results.length - 1];
    expect(msgOf(last)).toEqual(msg);
    expect(d.pendingChars).toBe(0);
  });

  it('le contenu qui gonfle le plus (caractères de contrôle) tient aussi dans la limite', () => {
    const limit = NET.FRAGMENT_CHARS + 2048;
    const msg = bigSnap('\u0001'.repeat(20000)); // chaque \u0001 devient « \u0001 » : ×6
    const texts = createEncoder(limit).encode(msg);
    for (const t of texts) expect(t.length).toBeLessThanOrEqual(limit);
    const d = createDecoder('toGuest');
    let out: DecodeResult = { kind: 'partial' };
    for (const t of texts) out = d.decode(t, 0);
    expect(msgOf(out)).toEqual(msg);
  });

  it('une paire de substitution coupée entre deux fragments est recollée', () => {
    const limit = 1000;
    for (let offset = 0; offset < 4; offset++) {
      const msg = bigSnap('x'.repeat(offset) + '😀🎮'.repeat(3000)); // émojis : 2 unités UTF-16 chacun, la coupure tombe au milieu de certains
      const texts = createEncoder(limit).encode(msg);
      expect(texts.length).toBeGreaterThan(2);
      const d = createDecoder('toGuest');
      let out: DecodeResult = { kind: 'partial' };
      for (const t of texts) out = d.decode(t, 0);
      expect(msgOf(out)).toEqual(msg);
    }
  });

  it('les identifiants de fragments croissent d\'un message fragmenté à l\'autre ; ids, i et n sont cohérents', () => {
    const enc = createEncoder();
    const a = enc.encode(bigSnap('a'.repeat(30000))).map((t) => JSON.parse(t) as { id: number; i: number; n: number });
    const b = enc.encode(bigSnap('b'.repeat(30000))).map((t) => JSON.parse(t) as { id: number; i: number; n: number });
    expect(new Set(a.map((f) => f.id)).size).toBe(1);
    expect(a.map((f) => f.i)).toEqual(a.map((_, k) => k));
    expect(a.every((f) => f.n === a.length)).toBe(true);
    expect(b[0].id).toBeGreaterThan(a[0].id);
    // un petit message entre deux n'en consomme pas
    expect(enc.encode({ t: 'leave' })).toHaveLength(1);
  });

  it('deux messages fragmentés successifs sont décodés l\'un après l\'autre', () => {
    const enc = createEncoder();
    const d = createDecoder('toGuest');
    const m1 = bigSnap('a'.repeat(30000));
    const m2 = bigSnap('b'.repeat(40000));
    let last: DecodeResult = { kind: 'partial' };
    for (const t of enc.encode(m1)) last = d.decode(t, 0);
    expect(msgOf(last)).toEqual(m1);
    for (const t of enc.encode(m2)) last = d.decode(t, 0);
    expect(msgOf(last)).toEqual(m2);
  });

  it('encodeJson : même résultat qu\'encode ; message au-delà de MAX_MESSAGE_CHARS refusé', () => {
    const enc = createEncoder();
    const msg = bigSnap('z'.repeat(20000));
    expect(createEncoder().encodeJson(JSON.stringify(msg))).toEqual(enc.encode(msg));
    expect(() => enc.encode(bigSnap('z'.repeat(NET.MAX_MESSAGE_CHARS)))).toThrow(RangeError);
  });

  it('un message à la limite de MAX_MESSAGE_CHARS se fragmente en au plus MAX_FRAGMENTS et se réassemble', () => {
    const enc = createEncoder(NET.FRAGMENT_CHARS + 2048);
    const pad = 'y'.repeat(NET.MAX_MESSAGE_CHARS - 200);
    const msg = bigSnap(pad);
    const texts = enc.encode(msg);
    expect(texts.length).toBeLessThanOrEqual(NET.MAX_FRAGMENTS);
    const d = createDecoder('toGuest');
    let out: DecodeResult = { kind: 'partial' };
    for (const t of texts) out = d.decode(t, 0);
    expect(msgOf(out)).toEqual(msg);
  });

  describe('réassemblage : fragments défaillants', () => {
    const frag = (id: number, i: number, n: number, d = 'x'.repeat(10)): string => JSON.stringify({ t: 'frag', id, i, n, d });
    const invalid = (d: MessageDecoder, text: string, now = 0): string => {
      const r = d.decode(text, now);
      expect(r.kind).toBe('invalid');
      return r.kind === 'invalid' ? r.reason : '';
    };

    it('fragment manquant : abandon, et le message suivant repart proprement', () => {
      const d = createDecoder('toGuest');
      expect(d.decode(frag(0, 0, 3), 0).kind).toBe('partial');
      expect(invalid(d, frag(0, 2, 3))).toBe('frag.order'); // le 1 manque
      expect(d.abandoned).toBe(1);
      expect(d.pendingChars).toBe(0);
      // la suite d'un autre message n'est pas polluée
      const enc = createEncoder();
      let last: DecodeResult = { kind: 'partial' };
      for (const t of enc.encode(bigSnap('q'.repeat(30000)))) last = d.decode(t, 1);
      // (les ids du nouvel encodeur repartent de 0 : refusé car pas strictement croissant)
      expect(last.kind).toBe('invalid');
    });

    it('fragment dupliqué : abandon', () => {
      const d = createDecoder('toGuest');
      expect(d.decode(frag(5, 0, 3), 0).kind).toBe('partial');
      expect(d.decode(frag(5, 1, 3), 0).kind).toBe('partial');
      expect(invalid(d, frag(5, 1, 3))).toBe('frag.order');
      expect(d.pendingChars).toBe(0);
    });

    it('fragments en désordre : abandon', () => {
      const d = createDecoder('toGuest');
      expect(invalid(d, frag(1, 1, 3))).toBe('frag.order'); // commence par i = 1
      expect(d.decode(frag(2, 0, 3), 0).kind).toBe('partial');
      expect(invalid(d, frag(2, 2, 3))).toBe('frag.order');
    });

    it('identifiant non strictement croissant : refusé', () => {
      const enc = createEncoder();
      const d = createDecoder('toGuest');
      let last: DecodeResult = { kind: 'partial' };
      const texts = enc.encode(bigSnap('a'.repeat(30000)));
      for (const t of texts) last = d.decode(t, 0);
      expect(last.kind).toBe('message');
      // rejeu des mêmes fragments (même id) : refusé dès le premier
      expect(invalid(d, texts[0])).toBe('frag.id');
      // un id plus ancien aussi
      expect(invalid(d, frag(0, 0, 2))).toBe('frag.id');
      // un id plus récent repart
      expect(d.decode(frag(99, 0, 2), 0).kind).toBe('partial');
    });

    it('n incohérent d\'un fragment à l\'autre : abandon', () => {
      const d = createDecoder('toGuest');
      expect(d.decode(frag(1, 0, 3), 0).kind).toBe('partial');
      expect(invalid(d, frag(1, 1, 4))).toBe('frag.order');
    });

    it('n hors bornes, i hors bornes, fragment vide ou trop long : refusés', () => {
      const d = createDecoder('toGuest');
      expect(invalid(d, frag(1, 0, 1))).toBe('frag'); // un « fragment » de message unique n'a pas de sens
      expect(invalid(d, frag(2, 0, NET.MAX_FRAGMENTS + 1))).toBe('frag');
      expect(invalid(d, frag(3, 3, 3))).toBe('frag');
      expect(invalid(d, frag(4, -1, 3))).toBe('frag');
      expect(invalid(d, frag(5, 0, 3, ''))).toBe('frag.d');
      expect(invalid(d, frag(6, 0, 3, 'x'.repeat(NET.FRAGMENT_CHARS + 1)))).toBe('frag.d');
      expect(invalid(d, JSON.stringify({ t: 'frag', id: 7, i: 0, n: 3, d: 12 }))).toBe('frag.d');
      expect(invalid(d, JSON.stringify({ t: 'frag', id: 'a', i: 0, n: 3, d: 'x' }))).toBe('frag');
      expect(invalid(d, JSON.stringify({ t: 'frag', id: -1, i: 0, n: 3, d: 'x' }))).toBe('frag');
      expect(invalid(d, JSON.stringify({ t: 'frag', id: 1.5, i: 0, n: 3, d: 'x' }))).toBe('frag');
    });

    it('plafond mémoire : un réassemblage qui dépasse MAX_MESSAGE_CHARS est abandonné', () => {
      const d = createDecoder('toGuest');
      const chunk = 'x'.repeat(NET.FRAGMENT_CHARS);
      const needed = Math.floor(NET.MAX_MESSAGE_CHARS / NET.FRAGMENT_CHARS) + 1; // 22
      expect(needed).toBeLessThanOrEqual(NET.MAX_FRAGMENTS);
      let reason = '';
      for (let i = 0; i < needed; i++) {
        const r = d.decode(frag(1, i, NET.MAX_FRAGMENTS, chunk), 0);
        if (r.kind === 'invalid') {
          reason = r.reason;
          break;
        }
        expect(d.pendingChars).toBeLessThanOrEqual(NET.MAX_MESSAGE_CHARS);
      }
      expect(reason).toBe('tooLarge');
      expect(d.pendingChars).toBe(0);
      expect(d.abandoned).toBe(1);
    });

    it('réassemblage expiré : abandonné par expire() puis à la réception', () => {
      const d = createDecoder('toGuest');
      expect(d.decode(frag(1, 0, 3), 1000).kind).toBe('partial');
      expect(d.pendingChars).toBe(10);
      expect(d.expire(1000 + NET.REASSEMBLY_TIMEOUT_MS)).toBe(false); // pile à la limite : conservé
      expect(d.expire(1000 + NET.REASSEMBLY_TIMEOUT_MS + 1)).toBe(true);
      expect(d.pendingChars).toBe(0);
      expect(d.abandoned).toBe(1);
      // la suite d'un réassemblage expiré n'est plus acceptée, même sans appel à expire()
      expect(d.decode(frag(2, 0, 3), 5000).kind).toBe('partial');
      expect(invalid(d, frag(2, 1, 3), 5000 + NET.REASSEMBLY_TIMEOUT_MS + 5)).toBe('frag.order');
    });

    it('un message ordinaire en plein réassemblage l\'abandonne mais est traité', () => {
      const d = createDecoder('toGuest');
      expect(d.decode(frag(1, 0, 3), 0).kind).toBe('partial');
      expect(d.decode('{"t":"leave"}', 0)).toEqual({ kind: 'message', msg: { t: 'leave' } });
      expect(d.pendingChars).toBe(0);
      expect(d.abandoned).toBe(1);
    });

    it('un nouveau message fragmenté en plein réassemblage remplace l\'ancien', () => {
      const d = createDecoder('toGuest');
      expect(d.decode(frag(1, 0, 3), 0).kind).toBe('partial');
      expect(d.decode(frag(2, 0, 2), 0).kind).toBe('partial');
      expect(d.abandoned).toBe(1);
      // ...mais pas avec un id ancien ni un i ≠ 0
      expect(invalid(d, frag(1, 0, 3))).toBe('frag.id');
      d.reset();
      expect(invalid(d, frag(3, 1, 3))).toBe('frag.order');
    });

    it('fragments imbriqués : le message réassemblé ne peut pas être un fragment', () => {
      const d = createDecoder('toGuest');
      const inner = JSON.stringify({ t: 'frag', id: 9, i: 0, n: 2, d: 'x' });
      const half = Math.floor(inner.length / 2);
      expect(d.decode(frag(1, 0, 2, inner.slice(0, half)), 0).kind).toBe('partial');
      const r = d.decode(frag(1, 1, 2, inner.slice(half)), 0);
      expect(r.kind).toBe('invalid');
    });

    it('un réassemblage complet mais dont le contenu est invalide est refusé', () => {
      const d = createDecoder('toGuest');
      expect(d.decode(frag(1, 0, 2, '{"t":"snap","gid":1,'), 0).kind).toBe('partial');
      expect(invalid(d, frag(1, 1, 2, '"n":"pasUnEntier"}'))).toMatch(/^snap|badJson/);
    });

    it('un fragment du mauvais type de contenu (binaire, tableau) ne casse rien', () => {
      const d = createDecoder('toGuest');
      expect(invalid(d, '[1,2,3]')).toBe('notObject');
      expect(invalid(d, '{"t":"frag"}')).toBe('frag');
    });
  });
});

describe('protocole : file d\'événements bornée', () => {
  const ev = (type: string, id = 0): SimEvent => ({ type, id }) as unknown as SimEvent;

  it('sous la limite : tout est conservé dans l\'ordre', () => {
    const q: SimEvent[] = [ev('enemyHit', 1)];
    appendEvents(q, [ev('enemyDied', 2), ev('roomCleared', 3)]);
    expect(q.map((e) => e.type)).toEqual(['enemyHit', 'enemyDied', 'roomCleared']);
  });

  it('au-delà : on jette les plus anciens, sauf les événements qui pilotent l\'interface', () => {
    expect(SIM_EVENTS_NEVER_DROPPED).toContain('roomEntered');
    const q: SimEvent[] = [ev('roomEntered', 0), ev('enemyHit', 1), ev('playerDown', 2), ev('enemyHit', 3)];
    appendEvents(q, [ev('enemyHit', 4), ev('levelCompleted', 5), ev('enemyHit', 6)], 4);
    expect(q).toHaveLength(4);
    // les 4 gardés : les 3 indispensables + le plus récent des jetables
    expect(q.map((e) => e.type)).toEqual(['roomEntered', 'playerDown', 'levelCompleted', 'enemyHit']);
    expect((q[3] as unknown as { id: number }).id).toBe(6);
  });

  it('garde-fou : même les indispensables sont jetés (les plus anciens) au-delà de 2 × max', () => {
    const q: SimEvent[] = [];
    appendEvents(
      q,
      Array.from({ length: 20 }, (_, i) => ev('playerDown', i)),
      4,
    );
    expect(q).toHaveLength(8);
    expect((q[0] as unknown as { id: number }).id).toBe(12);
    expect((q[7] as unknown as { id: number }).id).toBe(19);
  });

  it('borne par défaut : NET.MAX_PENDING_EVENTS', () => {
    const q: SimEvent[] = [];
    appendEvents(q, Array.from({ length: NET.MAX_PENDING_EVENTS + 100 }, (_, i) => ev('enemyHit', i)));
    expect(q).toHaveLength(NET.MAX_PENDING_EVENTS);
    expect((q[q.length - 1] as unknown as { id: number }).id).toBe(NET.MAX_PENDING_EVENTS + 99);
  });
});

