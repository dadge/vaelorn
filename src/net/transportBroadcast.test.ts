/**
 * Tests du transport BroadcastChannel avec un FAUX canal en mémoire (Node n'en garantit pas un) : présence (discover / offer / join),
 * messages point à point, fermeture, enveloppes invalides, flot de demandes, deux hôtes ; un essai avec le vrai canal global s'il existe.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NET, NET_BC_CHANNEL, type Transport } from './contracts';
import {
  BROADCAST_MAX_MESSAGE_CHARS,
  connectBroadcastGuest,
  connectBroadcastGuestWith,
  createBroadcastHost,
  createBroadcastHostWith,
  parseEnvelope,
  type BroadcastChannelFactory,
  type BroadcastChannelLike,
} from './transportBroadcast';

/** Faux BroadcastChannel : un « bus » par nom, livraison asynchrone (micro-tâche), jamais à l'émetteur. */
class FakeChannel implements BroadcastChannelLike {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  closed = false;
  constructor(
    private readonly bus: Set<FakeChannel>,
    readonly log: unknown[],
  ) {
    bus.add(this);
  }
  postMessage(message: unknown): void {
    if (this.closed) throw new Error('canal fermé');
    const copy = structuredClone(message);
    this.log.push(copy);
    for (const other of this.bus) {
      if (other === this || other.closed) continue;
      queueMicrotask(() => {
        if (!other.closed) other.onmessage?.({ data: structuredClone(copy) });
      });
    }
  }
  close(): void {
    this.closed = true;
    this.bus.delete(this);
  }
}

function createHub(): { factory: BroadcastChannelFactory; raw: (name?: string) => FakeChannel; log: unknown[] } {
  const buses = new Map<string, Set<FakeChannel>>();
  const log: unknown[] = [];
  const bus = (name: string): Set<FakeChannel> => {
    let b = buses.get(name);
    if (!b) buses.set(name, (b = new Set()));
    return b;
  };
  return {
    factory: (name) => new FakeChannel(bus(name), log),
    raw: (name = NET_BC_CHANNEL) => new FakeChannel(bus(name), log),
    log,
  };
}

/** Laisse circuler les micro-tâches (plusieurs tours : une réponse en déclenche une autre). */
async function settle(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise<void>((r) => setTimeout(r, 0));
}

function collect(t: Transport): string[] {
  const got: string[] = [];
  t.onMessage((s) => got.push(s));
  return got;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('BroadcastChannel : liaison hôte ↔ invité', () => {
  it('l\'invité trouve l\'hôte ; les deux transports sont ouverts et échangent du texte dans les deux sens', async () => {
    const hub = createHub();
    const host = createBroadcastHostWith(hub.factory);
    const guests: Transport[] = [];
    host.onGuest((t) => guests.push(t));
    const guest = await connectBroadcastGuestWith(hub.factory, NET_BC_CHANNEL, 1000);
    await settle();
    expect(guests).toHaveLength(1);
    const h = guests[0];
    expect(h.kind).toBe('broadcast');
    expect(h.state).toBe('open');
    expect(guest.state).toBe('open');
    expect(h.maxMessageChars).toBe(BROADCAST_MAX_MESSAGE_CHARS);
    expect(host.channelName).toBe(NET_BC_CHANNEL);

    const atHost = collect(h);
    const atGuest = collect(guest);
    guest.send('bonjour');
    guest.send('{"t":"leave"}');
    h.send('salut');
    await settle();
    expect(atHost).toEqual(['bonjour', '{"t":"leave"}']);
    expect(atGuest).toEqual(['salut']);
    host.close();
  });

  it('plusieurs invités : chaque liaison est isolée', async () => {
    const hub = createHub();
    const host = createBroadcastHostWith(hub.factory);
    const atHost: Transport[] = [];
    host.onGuest((t) => atHost.push(t));
    const g1 = await connectBroadcastGuestWith(hub.factory, NET_BC_CHANNEL, 1000);
    const g2 = await connectBroadcastGuestWith(hub.factory, NET_BC_CHANNEL, 1000);
    const g3 = await connectBroadcastGuestWith(hub.factory, NET_BC_CHANNEL, 1000);
    await settle();
    expect(atHost).toHaveLength(3);
    const got = atHost.map(collect);
    const gg = [g1, g2, g3].map(collect);
    g2.send('de-2');
    g1.send('de-1');
    atHost[2].send('pour-3');
    await settle();
    expect(got[0]).toEqual(['de-1']);
    expect(got[1]).toEqual(['de-2']);
    expect(got[2]).toEqual([]);
    expect(gg[0]).toEqual([]);
    expect(gg[1]).toEqual([]);
    expect(gg[2]).toEqual(['pour-3']);
  });

  it('un invité lancé AVANT l\'hôte le trouve grâce à la répétition de discover', async () => {
    vi.useFakeTimers();
    const hub = createHub();
    const pending = connectBroadcastGuestWith(hub.factory, NET_BC_CHANNEL, 5000);
    let result: Transport | null = null;
    void pending.then((t) => (result = t));
    await vi.advanceTimersByTimeAsync(1200);
    expect(result).toBeNull();
    const host = createBroadcastHostWith(hub.factory);
    const guests: Transport[] = [];
    host.onGuest((t) => guests.push(t));
    await vi.advanceTimersByTimeAsync(700);
    expect(result).not.toBeNull();
    expect(guests).toHaveLength(1);
    host.close();
  });

  it('sans hôte : rejette Error(timeout) au bout du délai et libère le canal', async () => {
    vi.useFakeTimers();
    const hub = createHub();
    const p = connectBroadcastGuestWith(hub.factory, NET_BC_CHANNEL, 3000);
    const outcome = p.then(
      () => 'ok',
      (e: Error) => e.message,
    );
    await vi.advanceTimersByTimeAsync(3001);
    expect(await outcome).toBe('timeout');
    // plus aucun `discover` après l'abandon
    const before = hub.log.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(hub.log.length).toBe(before);
  });

  it('un canal par nom : l\'hôte d\'un autre canal ne répond pas', async () => {
    vi.useFakeTimers();
    const hub = createHub();
    const host = createBroadcastHostWith(hub.factory, 'autre-salon');
    const seen: Transport[] = [];
    host.onGuest((t) => seen.push(t));
    const p = connectBroadcastGuestWith(hub.factory, 'mon-salon', 1000);
    const outcome = p.then(
      () => 'ok',
      (e: Error) => e.message,
    );
    await vi.advanceTimersByTimeAsync(1100);
    expect(await outcome).toBe('timeout');
    expect(seen).toHaveLength(0);
  });
});

describe('BroadcastChannel : fermeture', () => {
  it('close d\'un côté : l\'autre passe à closed (une seule notification), plus d\'envoi possible', async () => {
    const hub = createHub();
    const host = createBroadcastHostWith(hub.factory);
    const hostSide: Transport[] = [];
    host.onGuest((t) => hostSide.push(t));
    const guest = await connectBroadcastGuestWith(hub.factory, NET_BC_CHANNEL, 1000);
    await settle();
    const states: string[] = [];
    hostSide[0].onState((s, r) => states.push(`${s}:${r}`));
    guest.close('partie');
    guest.close('encore');
    expect(guest.state).toBe('closed');
    expect(() => guest.send('x')).toThrow(/fermé/);
    await settle();
    expect(hostSide[0].state).toBe('closed');
    expect(states).toEqual(['closed:peerClosed']);
    expect(() => hostSide[0].send('x')).toThrow();
  });

  it('close côté hôte (une liaison) : l\'invité est prévenu ; les autres liaisons continuent', async () => {
    const hub = createHub();
    const host = createBroadcastHostWith(hub.factory);
    const hostSide: Transport[] = [];
    host.onGuest((t) => hostSide.push(t));
    const g1 = await connectBroadcastGuestWith(hub.factory, NET_BC_CHANNEL, 1000);
    const g2 = await connectBroadcastGuestWith(hub.factory, NET_BC_CHANNEL, 1000);
    await settle();
    hostSide[0].close();
    await settle();
    expect(g1.state).toBe('closed');
    expect(g2.state).toBe('open');
    const got = collect(hostSide[1]);
    g2.send('toujours là');
    await settle();
    expect(got).toEqual(['toujours là']);
  });

  it('host.close : toutes les liaisons sont fermées, le canal est libéré, plus de nouvel invité', async () => {
    const hub = createHub();
    const host = createBroadcastHostWith(hub.factory);
    const hostSide: Transport[] = [];
    host.onGuest((t) => hostSide.push(t));
    const g1 = await connectBroadcastGuestWith(hub.factory, NET_BC_CHANNEL, 1000);
    await settle();
    host.close();
    host.close(); // idempotent
    expect(hostSide[0].state).toBe('closed');
    await settle();
    expect(g1.state).toBe('closed');
    const late = connectBroadcastGuestWith(hub.factory, NET_BC_CHANNEL, 300);
    const outcome = late.then(
      () => 'ok',
      (e: Error) => e.message,
    );
    expect(await outcome).toBe('timeout');
    expect(hostSide).toHaveLength(1);
  });
});

describe('BroadcastChannel : robustesse', () => {
  it('parseEnvelope : n\'accepte que des enveloppes bien formées', () => {
    expect(parseEnvelope({ k: 'discover', from: 'abc' })).toEqual({ k: 'discover', from: 'abc' });
    expect(parseEnvelope({ k: 'offer', to: 'a', link: 'b' })).toEqual({ k: 'offer', to: 'a', link: 'b' });
    expect(parseEnvelope({ k: 'join', from: 'a', link: 'b' })).toEqual({ k: 'join', from: 'a', link: 'b' });
    expect(parseEnvelope({ k: 'data', link: 'b', side: 'h', text: 'x' })).toEqual({ k: 'data', link: 'b', side: 'h', text: 'x' });
    expect(parseEnvelope({ k: 'close', link: 'b' })).toEqual({ k: 'close', link: 'b' });
    for (const bad of [
      null,
      undefined,
      42,
      'x',
      [],
      {},
      { k: 'inconnu' },
      { k: 'discover' },
      { k: 'discover', from: '' },
      { k: 'discover', from: 'x'.repeat(65) },
      { k: 'discover', from: 5 },
      { k: 'offer', to: 'a' },
      { k: 'join', from: 'a' },
      { k: 'data', link: 'b', side: 'x', text: 'x' },
      { k: 'data', link: 'b', side: 'h', text: 5 },
      { k: 'data', link: 'b', side: 'h', text: 'x'.repeat(NET.MAX_MESSAGE_CHARS + 1) },
      { k: 'data', side: 'h', text: 'x' },
      { k: 'close' },
    ]) {
      expect(parseEnvelope(bad)).toBeNull();
    }
  });

  it('enveloppes invalides, liaisons inconnues et mauvais sens sont ignorés sans exception', async () => {
    const hub = createHub();
    const host = createBroadcastHostWith(hub.factory);
    const created: Transport[] = [];
    host.onGuest((t) => created.push(t));
    const intruder = hub.raw();
    for (const junk of [null, 'texte', 42, { k: 'zzz' }, { k: 'join', from: 'a', link: 'inconnue' }, { k: 'data', link: 'inconnue', side: 'g', text: 'x' }, { k: 'close', link: 'inconnue' }]) {
      intruder.postMessage(junk);
    }
    await settle();
    expect(created).toHaveLength(0);

    // une vraie liaison : un `data` dans le mauvais sens (side 'h' alors que c'est l'hôte qui reçoit) est ignoré
    const guest = await connectBroadcastGuestWith(hub.factory, NET_BC_CHANNEL, 1000);
    await settle();
    const got = collect(created[0]);
    const linkId = (hub.log.find((m) => (m as { k?: string; link?: string } | null)?.k === 'join' && (m as { link: string }).link !== 'inconnue') as { link: string }).link;
    intruder.postMessage({ k: 'data', link: linkId, side: 'h', text: 'usurpation' });
    intruder.postMessage({ k: 'data', link: linkId, side: 'g', text: 'légitime côté invité' });
    await settle();
    expect(got).toEqual(['légitime côté invité']);
    expect(guest.state).toBe('open');
  });

  it('une même demande répétée reçoit la même liaison (pas de doublon d\'invité)', async () => {
    const hub = createHub();
    const host = createBroadcastHostWith(hub.factory);
    const raw = hub.raw();
    const offers: { to: string; link: string }[] = [];
    raw.onmessage = (ev) => {
      const d = ev.data as { k: string; to: string; link: string };
      if (d.k === 'offer') offers.push(d);
    };
    raw.postMessage({ k: 'discover', from: 'moi' });
    raw.postMessage({ k: 'discover', from: 'moi' });
    raw.postMessage({ k: 'discover', from: 'autre' });
    await settle();
    expect(offers).toHaveLength(3);
    expect(offers[0].link).toBe(offers[1].link);
    expect(offers[2].link).not.toBe(offers[0].link);
    // un `join` répété ne crée qu'une liaison
    const created: Transport[] = [];
    host.onGuest((t) => created.push(t));
    raw.postMessage({ k: 'join', from: 'moi', link: offers[0].link });
    raw.postMessage({ k: 'join', from: 'moi', link: offers[0].link });
    await settle();
    expect(created).toHaveLength(1);
    // un `join` d'un autre invité avec la liaison de « moi » est refusé
    raw.postMessage({ k: 'join', from: 'autre', link: offers[0].link });
    await settle();
    expect(created).toHaveLength(1);
  });

  it('flot de demandes : les offres en attente sont bornées (les plus anciennes sont oubliées)', async () => {
    const hub = createHub();
    const host = createBroadcastHostWith(hub.factory);
    const created: Transport[] = [];
    host.onGuest((t) => created.push(t));
    const raw = hub.raw();
    const offers = new Map<string, string>();
    raw.onmessage = (ev) => {
      const d = ev.data as { k: string; to: string; link: string };
      if (d.k === 'offer') offers.set(d.to, d.link);
    };
    for (let i = 0; i < 100; i++) raw.postMessage({ k: 'discover', from: `g${i}` });
    await settle();
    expect(offers.size).toBe(100);
    raw.postMessage({ k: 'join', from: 'g0', link: offers.get('g0') as string }); // évincée
    await settle();
    expect(created).toHaveLength(0);
    raw.postMessage({ k: 'join', from: 'g99', link: offers.get('g99') as string }); // récente
    await settle();
    expect(created).toHaveLength(1);
  });

  it('deux hôtes sur le même canal : détecté (onConflict) ; l\'invité n\'est rattaché qu\'à un seul', async () => {
    const hub = createHub();
    const h1 = createBroadcastHostWith(hub.factory);
    const h2 = createBroadcastHostWith(hub.factory);
    const conflicts: string[] = [];
    h1.onConflict(() => conflicts.push('h1'));
    h2.onConflict(() => conflicts.push('h2'));
    const c1: Transport[] = [];
    const c2: Transport[] = [];
    h1.onGuest((t) => c1.push(t));
    h2.onGuest((t) => c2.push(t));
    await connectBroadcastGuestWith(hub.factory, NET_BC_CHANNEL, 1000);
    await settle();
    expect(c1.length + c2.length).toBe(1);
    expect(conflicts.length).toBeGreaterThan(0);
  });

  it('send : texte seulement, taille bornée', async () => {
    const hub = createHub();
    const host = createBroadcastHostWith(hub.factory);
    const guest = await connectBroadcastGuestWith(hub.factory, NET_BC_CHANNEL, 1000);
    await settle();
    expect(() => guest.send('x'.repeat(BROADCAST_MAX_MESSAGE_CHARS + 1))).toThrow(/trop long/);
    expect(() => guest.send(5 as unknown as string)).toThrow();
    guest.send('x'.repeat(BROADCAST_MAX_MESSAGE_CHARS));
    host.close();
  });

  it('sans BroadcastChannel : createBroadcastHost lève unsupported, connectBroadcastGuest rejette', async () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    expect(() => createBroadcastHost()).toThrow('unsupported');
    await expect(connectBroadcastGuest()).rejects.toThrow('unsupported');
  });
});

describe.skipIf(typeof (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel === 'undefined')('BroadcastChannel réel (global)', () => {
  it('hôte et invité se joignent et échangent un message', async () => {
    const name = `vaelorn-test-${Math.random().toString(36).slice(2)}`;
    const host = createBroadcastHost(name);
    const seen: Transport[] = [];
    host.onGuest((t) => seen.push(t));
    const guest = await connectBroadcastGuest(name, 3000);
    await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: 2000 });
    const got = collect(seen[0]);
    guest.send('réel');
    await vi.waitFor(() => expect(got).toEqual(['réel']), { timeout: 2000 });
    guest.close();
    host.close();
  });
});
