/**
 * Transport LOOPBACK : paire de `Transport` reliés en mémoire (tests, aucun réseau). Docs/NET.md § 4.1.
 *
 * Par défaut les messages sont MIS EN FILE et livrés par `flush()` (ordre et retard déterministes) ; `synchronous: true` livre dans `send`.
 * `maxMessageChars` vaut par défaut `NET.FRAGMENT_CHARS` + 2048 : un test qui oublie de fragmenter échoue.
 *
 * Options de panne DÉTERMINISTES (réservées aux tests de la couche protocole ; un vrai canal est fiable et ordonné, voir `Transport`) :
 *  - `filter(info)` : décide pour chaque message envoyé de le livrer, de le perdre (`drop`) ou de le livrer deux fois (`duplicate`) ;
 *  - `latencyFlushes` : un message n'est livré qu'au `flush()` numéro N après son envoi (0 = au premier) ;
 *  - `reorderPending(permutation)` : réordonne la file (les entrées de fermeture suivent le même ordre).
 */
import type { Unsubscribe } from './NetAdapter';
import { NET, type LoopbackOptions, type LoopbackPair, type Transport, type TransportState } from './contracts';

export type LoopbackSide = 'a' | 'b';

export interface LoopbackFaultInfo {
  /** Rang (0, 1, 2…) du message parmi tous ceux envoyés sur la paire. */
  index: number;
  from: LoopbackSide;
  text: string;
}

export interface LoopbackFaultOptions extends LoopbackOptions {
  filter?: (info: LoopbackFaultInfo) => 'deliver' | 'drop' | 'duplicate';
  latencyFlushes?: number;
}

export interface LoopbackPairEx extends LoopbackPair {
  /** Messages en file (texte et émetteur), dans l'ordre de livraison prévu. */
  pendingMessages(): { from: LoopbackSide; text: string }[];
  /** Réordonne la file : `permutation[k]` = indice (dans l'ordre actuel) de l'entrée à livrer en k-ième position. @throws si ce n'est pas une permutation. */
  reorderPending(permutation: readonly number[]): void;
}

type Entry = { kind: 'msg'; from: LoopbackSide; to: End; text: string; due: number } | { kind: 'close'; from: LoopbackSide; to: End; reason: string | undefined; due: number };

class End implements Transport {
  readonly kind = 'loopback' as const;
  state: TransportState = 'open';
  readonly maxMessageChars: number;
  peer!: End;
  private msgCbs: ((text: string) => void)[] = [];
  private stateCbs: ((state: TransportState, reason?: string) => void)[] = [];

  constructor(
    readonly side: LoopbackSide,
    private readonly hub: Hub,
    maxMessageChars: number,
  ) {
    this.maxMessageChars = maxMessageChars;
  }

  get bufferedAmount(): number {
    return this.hub.buffered;
  }

  send(text: string): void {
    if (this.state !== 'open') throw new Error('Transport fermé');
    if (typeof text !== 'string') throw new Error('Message non textuel');
    if (text.length > this.maxMessageChars) throw new Error(`Message trop long (${text.length} > ${this.maxMessageChars})`);
    this.hub.enqueueMessage(this, text);
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
    this.setClosed(reason);
    this.hub.enqueueClose(this, reason);
  }

  /** Reçoit un message de la file. */
  receive(text: string): void {
    if (this.state !== 'open') return;
    for (const cb of this.msgCbs.slice()) cb(text);
  }

  /** Passage à `closed` (une seule fois) et notification. */
  setClosed(reason?: string): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    for (const cb of this.stateCbs.slice()) cb('closed', reason);
  }
}

class Hub {
  queue: Entry[] = [];
  buffered = 0;
  private sent = 0;
  private flushes = 0;
  a!: End;
  b!: End;

  constructor(readonly opts: LoopbackFaultOptions) {}

  private due(): number {
    return this.flushes + Math.max(0, Math.floor(this.opts.latencyFlushes ?? 0));
  }

  enqueueMessage(from: End, text: string): void {
    const index = this.sent++;
    const verdict = this.opts.filter ? this.opts.filter({ index, from: from.side, text }) : 'deliver';
    if (verdict === 'drop') return;
    const copies = verdict === 'duplicate' ? 2 : 1;
    for (let k = 0; k < copies; k++) {
      if (this.opts.synchronous) from.peer.receive(text);
      else this.queue.push({ kind: 'msg', from: from.side, to: from.peer, text, due: this.due() });
    }
  }

  enqueueClose(from: End, reason: string | undefined): void {
    if (this.opts.synchronous) from.peer.setClosed(reason);
    else this.queue.push({ kind: 'close', from: from.side, to: from.peer, reason, due: this.due() });
  }

  flush(): number {
    // seules les entrées déjà présentes au début de l'appel sont livrées (les réponses déclenchées attendent le flush suivant)
    const batch = this.queue.length;
    const keep: Entry[] = [];
    const deliver: Entry[] = [];
    for (let k = 0; k < batch; k++) {
      const e = this.queue[k];
      (e.due <= this.flushes ? deliver : keep).push(e);
    }
    const rest = this.queue.slice(batch);
    this.queue = keep.concat(rest);
    this.flushes++;
    let delivered = 0;
    let firstError: unknown;
    let failed = false;
    for (const e of deliver) {
      try {
        if (e.kind === 'msg') e.to.receive(e.text);
        else e.to.setClosed(e.reason);
        delivered++;
      } catch (err) {
        if (!failed) {
          failed = true;
          firstError = err;
        }
      }
    }
    if (failed) throw firstError;
    return delivered;
  }
}

/** Paire de transports en mémoire (`a` ↔ `b`). */
export function createLoopbackPair(options?: LoopbackFaultOptions): LoopbackPairEx {
  const opts: LoopbackFaultOptions = options ?? {};
  const maxChars = opts.maxMessageChars ?? NET.FRAGMENT_CHARS + 2048;
  const hub = new Hub(opts);
  const a = new End('a', hub, maxChars);
  const b = new End('b', hub, maxChars);
  a.peer = b;
  b.peer = a;
  hub.a = a;
  hub.b = b;
  return {
    a,
    b,
    flush: () => (opts.synchronous ? 0 : hub.flush()),
    pending: () => hub.queue.length,
    setBufferedAmount(bytes: number): void {
      hub.buffered = Math.max(0, bytes);
    },
    cut(reason?: string): void {
      hub.queue = [];
      a.setClosed(reason ?? 'cut');
      b.setClosed(reason ?? 'cut');
    },
    pendingMessages: () => hub.queue.filter((e): e is Extract<Entry, { kind: 'msg' }> => e.kind === 'msg').map((e) => ({ from: e.from, text: e.text })),
    reorderPending(permutation: readonly number[]): void {
      const n = hub.queue.length;
      const seen = new Set(permutation);
      if (permutation.length !== n || seen.size !== n || permutation.some((i) => !Number.isInteger(i) || i < 0 || i >= n)) {
        throw new Error('permutation invalide');
      }
      hub.queue = permutation.map((i) => hub.queue[i]);
    },
  };
}
