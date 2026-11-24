/**
 * Transport WEBRTC : enveloppe un `RTCDataChannel` FIABLE et ORDONNÉ (canal négocié d'identifiant 0, voir `rtcSignaling.ts`) en `Transport`.
 * Docs/NET.md § 4.3. Ne connaît ni la signalisation ni le protocole : il porte du texte.
 *
 * Le canal est abstrait par `RtcDataChannelLike` (sous-ensemble de `RTCDataChannel`) pour être testé sous Node avec un faux canal.
 * Seuls les messages TEXTE sont livrés (un message binaire est ignoré). `bufferedAmount` reflète celui du canal : l'hôte s'en sert pour ne pas envoyer
 * d'instantané sur un canal saturé.
 */
import type { Unsubscribe } from './NetAdapter';
import type { Transport, TransportState } from './contracts';

/** Taille maximale (caractères) d'un message de ce transport : prudente, sous les 16 Kio d'interopérabilité des piles DataChannel (Safari, Firefox). */
export const RTC_MAX_MESSAGE_CHARS = 15000;

/** Sous-ensemble de `RTCDataChannel` utilisé ici. */
export interface RtcDataChannelLike {
  readonly readyState: string;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'close' | 'message' | 'error', listener: (event: { data?: unknown }) => void): void;
  removeEventListener?(type: 'open' | 'close' | 'message' | 'error', listener: (event: { data?: unknown }) => void): void;
}

export class RtcTransport implements Transport {
  readonly kind = 'webrtc' as const;
  readonly maxMessageChars = RTC_MAX_MESSAGE_CHARS;
  private closed = false;
  private lastState: TransportState;
  private msgCbs: ((text: string) => void)[] = [];
  private stateCbs: ((state: TransportState, reason?: string) => void)[] = [];

  /** @param channel canal de données ; @param peer connexion pair à pair à fermer avec lui (facultatif). */
  constructor(
    private readonly channel: RtcDataChannelLike,
    private readonly peer?: { close(): void },
  ) {
    this.lastState = this.computeState();
    channel.addEventListener('open', () => this.refresh());
    channel.addEventListener('close', () => this.markClosed('datachannel closed'));
    channel.addEventListener('message', (ev) => {
      if (this.closed || typeof ev.data !== 'string') return; // binaire ignoré
      for (const cb of this.msgCbs.slice()) cb(ev.data);
    });
  }

  private computeState(): TransportState {
    if (this.closed) return 'closed';
    switch (this.channel.readyState) {
      case 'open':
        return 'open';
      case 'closing':
      case 'closed':
        return 'closed';
      default:
        return 'connecting';
    }
  }

  get state(): TransportState {
    return this.computeState();
  }

  get bufferedAmount(): number {
    const v = this.channel.bufferedAmount;
    return Number.isFinite(v) && v > 0 ? v : 0;
  }

  /** Recalcule l'état et notifie un passage à `open` ou à `closed` (une seule fois pour `closed`). */
  private refresh(): void {
    const next = this.computeState();
    if (next === this.lastState) return;
    this.lastState = next;
    for (const cb of this.stateCbs.slice()) cb(next, next === 'closed' ? 'closed' : undefined);
  }

  send(text: string): void {
    if (this.state !== 'open') throw new Error('Transport fermé');
    if (typeof text !== 'string') throw new Error('Message non textuel');
    if (text.length > this.maxMessageChars) throw new Error(`Message trop long (${text.length} > ${this.maxMessageChars})`);
    this.channel.send(text);
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

  /** Déclare le canal perdu (la connexion pair à pair a échoué, sans que le canal ne l'ait signalé) ; idempotent. */
  markClosed(reason: string): void {
    if (this.lastState === 'closed') {
      this.closed = true;
      return;
    }
    this.closed = true;
    this.lastState = 'closed';
    for (const cb of this.stateCbs.slice()) cb('closed', reason);
  }

  close(reason?: string): void {
    if (this.closed && this.lastState === 'closed') return;
    try {
      this.channel.close();
    } catch {
      // déjà fermé
    }
    try {
      this.peer?.close();
    } catch {
      // déjà fermé
    }
    this.markClosed(reason ?? 'closed');
  }
}

/** Crée le transport d'un canal de données (déjà ouvert ou en cours d'ouverture). */
export function createRtcTransport(channel: RtcDataChannelLike, peer?: { close(): void }): RtcTransport {
  return new RtcTransport(channel, peer);
}
