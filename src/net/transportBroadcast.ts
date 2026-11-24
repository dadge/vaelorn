/**
 * Transport BROADCASTCHANNEL (développement, `?net=bc`) : deux FENÊTRES du même navigateur et de la même origine jouent ensemble sans signalisation
 * manuelle. Docs/NET.md § 4.2.
 *
 * Un seul canal nommé (`NET_BC_CHANNEL`) porte plusieurs liaisons point à point ; petit protocole de présence, enveloppe `{ k, … }` :
 *  - `discover` invité → tous : `{ k, from }` (`from` = identifiant aléatoire de l'invité), répété toutes les 500 ms jusqu'à l'offre ;
 *  - `offer` hôte → invité : `{ k, to, link }` (une liaison par invité ; une même demande répétée rend la même liaison) ;
 *  - `join` invité → hôte : `{ k, from, link }` : l'invité accepte la PREMIÈRE offre reçue ; les deux `Transport` sont alors ouverts ;
 *  - `data` : `{ k, link, side: 'h' | 'g', text }` ; une liaison inconnue ou un `side` du mauvais sens est ignoré ;
 *  - `close` : `{ k, link }`.
 * Un second hôte sur le même canal est détecté quand il voit une `offer` qui n'est pas la sienne : `onConflict`.
 *
 * `BroadcastChannel` est injectable (`BroadcastChannelFactory`) : les tests tournent sous Node avec un faux canal en mémoire.
 * Remarque : deux ONGLETS d'une même fenêtre ne conviennent pas (l'onglet en arrière-plan voit sa boucle de jeu suspendue) ; utiliser deux fenêtres.
 */
import type { Unsubscribe } from './NetAdapter';
import {
  NET,
  NET_BC_CHANNEL,
  type BroadcastHostLink,
  type ConnectBroadcastGuest,
  type CreateBroadcastHost,
  type Transport,
  type TransportState,
} from './contracts';

/** Partie de l'API `BroadcastChannel` utilisée ici. */
export interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export type BroadcastChannelFactory = (name: string) => BroadcastChannelLike;

export interface BroadcastHostLinkEx extends BroadcastHostLink {
  /** Un AUTRE hôte répond sur le même canal (deux hôtes dans le même navigateur : un seul peut fonctionner). */
  onConflict(cb: () => void): Unsubscribe;
}

/** Taille maximale d'un message de ce transport : celle d'un DataChannel prudent (la fragmentation est donc exercée comme en production). */
export const BROADCAST_MAX_MESSAGE_CHARS = 15000;
/** Période (ms) de répétition de `discover` côté invité. */
export const BROADCAST_DISCOVER_RETRY_MS = 500;
/** Nombre maximal d'offres en attente d'acceptation côté hôte (borne la mémoire face à un flot de `discover`). */
const MAX_PENDING_OFFERS = 16;

let idCounter = 0;
function randomId(): string {
  idCounter = (idCounter + 1) % 1_000_000;
  return `${Math.floor(Math.random() * 0xffffffff).toString(36)}${idCounter.toString(36)}${Date.now().toString(36)}`;
}

function defaultFactory(): BroadcastChannelFactory {
  const BC = (globalThis as { BroadcastChannel?: new (name: string) => BroadcastChannelLike }).BroadcastChannel;
  if (typeof BC !== 'function') throw new Error('unsupported');
  return (name) => new BC(name);
}

// ───────────────────────────── Enveloppes ─────────────────────────────

type Envelope =
  | { k: 'discover'; from: string }
  | { k: 'offer'; to: string; link: string }
  | { k: 'join'; from: string; link: string }
  | { k: 'data'; link: string; side: 'h' | 'g'; text: string }
  | { k: 'close'; link: string };

function idField(o: Record<string, unknown>, key: string): string | null {
  const v = Object.prototype.hasOwnProperty.call(o, key) ? o[key] : undefined;
  return typeof v === 'string' && v.length >= 1 && v.length <= 64 ? v : null;
}

/** Valide une enveloppe reçue (n'importe quelle page de la même origine peut écrire sur le canal) ; null si invalide. */
export function parseEnvelope(data: unknown): Envelope | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const o = data as Record<string, unknown>;
  switch (o.k) {
    case 'discover': {
      const from = idField(o, 'from');
      return from ? { k: 'discover', from } : null;
    }
    case 'offer': {
      const to = idField(o, 'to');
      const link = idField(o, 'link');
      return to && link ? { k: 'offer', to, link } : null;
    }
    case 'join': {
      const from = idField(o, 'from');
      const link = idField(o, 'link');
      return from && link ? { k: 'join', from, link } : null;
    }
    case 'data': {
      const link = idField(o, 'link');
      const text = o.text;
      if (!link || (o.side !== 'h' && o.side !== 'g') || typeof text !== 'string' || text.length > NET.MAX_MESSAGE_CHARS) return null;
      return { k: 'data', link, side: o.side, text };
    }
    case 'close': {
      const link = idField(o, 'link');
      return link ? { k: 'close', link } : null;
    }
    default:
      return null;
  }
}

/** Au déchargement de la page, ferme proprement (l'autre fenêtre le voit tout de suite au lieu d'attendre le silence). Sans effet hors navigateur. */
function installUnloadHook(fn: () => void): () => void {
  const g = globalThis as { addEventListener?: (type: string, cb: () => void) => void; removeEventListener?: (type: string, cb: () => void) => void };
  if (typeof g.addEventListener !== 'function') return () => undefined;
  g.addEventListener('pagehide', fn);
  return () => g.removeEventListener?.('pagehide', fn);
}

// ───────────────────────────── Transport d'une liaison ─────────────────────────────

class BcTransport implements Transport {
  readonly kind = 'broadcast' as const;
  readonly bufferedAmount = 0;
  readonly maxMessageChars = BROADCAST_MAX_MESSAGE_CHARS;
  state: TransportState = 'open';
  private msgCbs: ((text: string) => void)[] = [];
  private stateCbs: ((state: TransportState, reason?: string) => void)[] = [];

  constructor(
    private readonly channel: BroadcastChannelLike,
    readonly link: string,
    private readonly side: 'h' | 'g',
    private readonly onClosed: () => void,
  ) {}

  send(text: string): void {
    if (this.state !== 'open') throw new Error('Transport fermé');
    if (typeof text !== 'string') throw new Error('Message non textuel');
    if (text.length > this.maxMessageChars) throw new Error(`Message trop long (${text.length} > ${this.maxMessageChars})`);
    this.channel.postMessage({ k: 'data', link: this.link, side: this.side, text });
  }

  onMessage(cb: (text: string) => void): Unsubscribe {
    this.msgCbs.push(cb);
    return () => {
      this.msgCbs = this.msgCbs.filter((c) => c !== cb);
    };
  }

  onState(cb: (state: TransportState, reason?: string) => void): Unsubscribe {
    this.stateCbs.push(cb);
    return () => {
      this.stateCbs = this.stateCbs.filter((c) => c !== cb);
    };
  }

  close(reason?: string): void {
    if (this.state === 'closed') return;
    try {
      this.channel.postMessage({ k: 'close', link: this.link });
    } catch {
      // canal déjà fermé : rien à annoncer
    }
    this.markClosed(reason ?? 'closed');
  }

  deliver(text: string): void {
    if (this.state !== 'open') return;
    for (const cb of this.msgCbs.slice()) cb(text);
  }

  /** Fermeture constatée (annoncée par le pair ou décidée ici) : une seule notification. */
  markClosed(reason: string): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    for (const cb of this.stateCbs.slice()) cb('closed', reason);
    this.onClosed();
  }
}

// ───────────────────────────── Hôte ─────────────────────────────

export function createBroadcastHostWith(factory: BroadcastChannelFactory, channelName: string = NET_BC_CHANNEL): BroadcastHostLinkEx {
  const channel = factory(channelName);
  const guestCbs = new Set<(t: Transport) => void>();
  const conflictCbs = new Set<() => void>();
  /** Offres faites, non encore acceptées : identifiant d'invité → liaison. Ordre d'insertion = ordre d'ancienneté. */
  const offers = new Map<string, string>();
  const links = new Map<string, BcTransport>();
  let closed = false;

  const removeHook = installUnloadHook(() => close());

  function close(): void {
    if (closed) return;
    closed = true;
    removeHook();
    for (const t of Array.from(links.values())) t.close('hostClosed');
    links.clear();
    offers.clear();
    channel.onmessage = null;
    channel.close();
  }

  channel.onmessage = (ev) => {
    if (closed) return;
    const env = parseEnvelope(ev.data);
    if (!env) return;
    switch (env.k) {
      case 'discover': {
        let link = offers.get(env.from);
        if (!link) {
          link = randomId();
          offers.set(env.from, link);
          if (offers.size > MAX_PENDING_OFFERS) {
            const oldest = offers.keys().next().value;
            if (oldest !== undefined) offers.delete(oldest);
          }
        }
        channel.postMessage({ k: 'offer', to: env.from, link });
        break;
      }
      case 'join': {
        if (offers.get(env.from) !== env.link || links.has(env.link)) return;
        offers.delete(env.from);
        const t = new BcTransport(channel, env.link, 'h', () => links.delete(env.link));
        links.set(env.link, t);
        for (const cb of Array.from(guestCbs)) cb(t);
        break;
      }
      case 'data': {
        if (env.side !== 'g') return;
        links.get(env.link)?.deliver(env.text);
        break;
      }
      case 'close':
        links.get(env.link)?.markClosed('peerClosed');
        break;
      case 'offer':
        // une offre qui n'est pas la nôtre : un autre hôte écoute sur ce canal
        for (const cb of Array.from(conflictCbs)) cb();
        break;
    }
  };

  return {
    channelName,
    onGuest(cb) {
      guestCbs.add(cb);
      return () => {
        guestCbs.delete(cb);
      };
    },
    onConflict(cb) {
      conflictCbs.add(cb);
      return () => {
        conflictCbs.delete(cb);
      };
    },
    close,
  };
}

// ───────────────────────────── Invité ─────────────────────────────

export function connectBroadcastGuestWith(factory: BroadcastChannelFactory, channelName: string = NET_BC_CHANNEL, timeoutMs = 5000): Promise<Transport> {
  return new Promise<Transport>((resolve, reject) => {
    let channel: BroadcastChannelLike;
    try {
      channel = factory(channelName);
    } catch (e) {
      reject(e instanceof Error ? e : new Error('unsupported'));
      return;
    }
    const me = randomId();
    let transport: BcTransport | null = null;
    let settled = false;
    let removeHook: () => void = () => undefined;

    const stop = (): void => {
      clearTimeout(timer);
      clearInterval(retry);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      stop();
      channel.onmessage = null;
      channel.close();
      reject(new Error('timeout'));
    }, timeoutMs);
    const retry = setInterval(() => {
      if (!settled) channel.postMessage({ k: 'discover', from: me });
    }, BROADCAST_DISCOVER_RETRY_MS);

    channel.onmessage = (ev) => {
      const env = parseEnvelope(ev.data);
      if (!env) return;
      if (!transport) {
        if (settled || env.k !== 'offer' || env.to !== me) return;
        settled = true;
        stop();
        const link = env.link;
        const t = new BcTransport(channel, link, 'g', () => {
          removeHook();
          channel.onmessage = null;
          channel.close();
        });
        transport = t;
        removeHook = installUnloadHook(() => t.close('pagehide'));
        channel.postMessage({ k: 'join', from: me, link });
        resolve(t);
        return;
      }
      if (env.k === 'data' && env.link === transport.link && env.side === 'h') transport.deliver(env.text);
      else if (env.k === 'close' && env.link === transport.link) transport.markClosed('peerClosed');
    };
    channel.postMessage({ k: 'discover', from: me });
  });
}

// ───────────────────────────── Fabriques du contrat ─────────────────────────────

/** Hôte BroadcastChannel (contrat `CreateBroadcastHost`). @throws Error('unsupported') sans `BroadcastChannel`. */
export const createBroadcastHost: CreateBroadcastHost = (channelName = NET_BC_CHANNEL) => createBroadcastHostWith(defaultFactory(), channelName);

/** Invité BroadcastChannel (contrat `ConnectBroadcastGuest`) : rejette `Error('timeout')` sans hôte au bout de `timeoutMs`. */
export const connectBroadcastGuest: ConnectBroadcastGuest = (channelName = NET_BC_CHANNEL, timeoutMs = 5000) => {
  let factory: BroadcastChannelFactory;
  try {
    factory = defaultFactory();
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error('unsupported'));
  }
  return connectBroadcastGuestWith(factory, channelName, timeoutMs);
};
