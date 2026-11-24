/**
 * Fausses `RTCPeerConnection` / `RTCDataChannel` pour tester la signalisation WebRTC sous Node (réservé aux tests).
 * Un « monde » relie les connexions : quand la description de réponse est appliquée côté hôte ET que l'invité a ses deux descriptions,
 * les deux canaux s'ouvrent ; un message envoyé sur l'un arrive (de façon asynchrone) sur l'autre.
 */
import type { RtcDataChannelLike } from './transportRtc';
import type { RtcEnv, RtcPeerConnectionLike, RtcSessionDescriptionLike } from './rtcSignaling';

type Listener = (event: { data?: unknown; candidate?: unknown }) => void;

export class FakeDataChannel implements RtcDataChannelLike {
  readyState = 'connecting';
  bufferedAmount = 0;
  peer: FakeDataChannel | null = null;
  sent: string[] = [];
  private listeners = new Map<string, Listener[]>();

  addEventListener(type: 'open' | 'close' | 'message' | 'error', listener: Listener): void {
    const l = this.listeners.get(type) ?? [];
    l.push(listener);
    this.listeners.set(type, l);
  }

  emit(type: string, event: { data?: unknown } = {}): void {
    for (const l of (this.listeners.get(type) ?? []).slice()) l(event);
  }

  send(data: string): void {
    if (this.readyState !== 'open') throw new Error('InvalidStateError');
    this.sent.push(data);
    const peer = this.peer;
    queueMicrotask(() => peer?.emit('message', { data }));
  }

  /** Message binaire arrivant du pair (doit être ignoré par le transport). */
  injectBinary(): void {
    this.emit('message', { data: new ArrayBuffer(4) });
  }

  open(): void {
    if (this.readyState !== 'connecting') return;
    this.readyState = 'open';
    this.emit('open');
  }

  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.emit('close');
    const peer = this.peer;
    this.peer = null;
    if (peer) queueMicrotask(() => peer.close());
  }
}

export interface FakeRtcOptions {
  /** Nombre de candidats UDP « host » produits par la collecte (défaut 2 ; 0 = aucun). */
  candidates?: number;
  /** Délai (ms) avant la fin de la collecte (défaut 0). */
  gatherDelayMs?: number;
  /** La collecte ne se termine jamais (pas de candidat nul, pas de `complete`) : teste le délai maximal. */
  gatherNever?: boolean;
  /** La connexion pair à pair échoue (`connectionState` = failed) au lieu de s'établir. */
  failConnect?: boolean;
  /** Ne jamais ouvrir les canaux ni échouer (teste le délai de connexion). */
  neverConnect?: boolean;
}

let uid = 0;

function hex32(seed: number): string {
  let out = '';
  for (let i = 0; i < 32; i++) out += (((seed * 31 + i * 17) & 0xff) | 0).toString(16).padStart(2, '0').toUpperCase() + (i < 31 ? ':' : '');
  return out;
}

export class FakePeerConnection implements RtcPeerConnectionLike {
  iceGatheringState = 'new';
  connectionState = 'new';
  localDescription: RtcSessionDescriptionLike | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  closed = false;
  channel: FakeDataChannel | null = null;
  channelInit: unknown = null;
  readonly ufrag: string;
  readonly pwd: string;
  private listeners = new Map<string, Listener[]>();

  constructor(
    readonly config: { iceServers: unknown[] },
    private readonly world: FakeRtcWorld,
  ) {
    uid++;
    this.ufrag = `uf${uid.toString(36).padStart(2, '0')}x`;
    this.pwd = `pw${uid.toString(36).padStart(2, '0')}abcdefghijklmnopqrstu`;
    world.pcs.push(this);
    world.byUfrag.set(this.ufrag, this);
  }

  createDataChannel(_label: string, init: { negotiated: boolean; id: number; ordered: boolean }): RtcDataChannelLike {
    this.channelInit = init;
    this.channel = new FakeDataChannel();
    return this.channel;
  }

  private baseSdp(setup: string): string {
    return [
      'v=0',
      'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
      's=-',
      't=0 0',
      'a=group:BUNDLE 0',
      'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
      'c=IN IP4 0.0.0.0',
      `a=ice-ufrag:${this.ufrag}`,
      `a=ice-pwd:${this.pwd}`,
      'a=ice-options:trickle',
      `a=fingerprint:sha-256 ${hex32(uid)}`,
      `a=setup:${setup}`,
      'a=mid:0',
      'a=sctp-port:5000',
      'a=max-message-size:262144',
      '',
    ].join('\r\n');
  }

  async createOffer(): Promise<RtcSessionDescriptionLike> {
    return { type: 'offer', sdp: this.baseSdp('actpass') };
  }

  async createAnswer(): Promise<RtcSessionDescriptionLike> {
    return { type: 'answer', sdp: this.baseSdp('active') };
  }

  async setLocalDescription(d: RtcSessionDescriptionLike): Promise<void> {
    this.localDescription = { type: d.type, sdp: d.sdp };
    this.iceGatheringState = 'gathering';
    const opts = this.world.options;
    const count = opts.candidates ?? 2;
    const lines: string[] = [];
    for (let i = 0; i < count; i++) lines.push(`a=candidate:${i + 1} 1 udp ${2113937151 - i} 192.168.${uid}.${i + 2} ${50000 + i} typ host generation 0`);
    const finish = (): void => {
      if (this.closed) return;
      this.localDescription = { type: d.type, sdp: (d.sdp ?? '') + lines.join('\r\n') + (lines.length ? '\r\n' : '') };
      for (const l of lines) this.emit('icecandidate', { candidate: { candidate: l } });
      if (opts.gatherNever) return;
      this.emit('icecandidate', { candidate: null });
      this.iceGatheringState = 'complete';
      this.emit('icegatheringstatechange');
    };
    if (opts.gatherNever) {
      // les candidats « tombent » dans la description locale, mais la collecte n'est jamais déclarée terminée
      setTimeout(finish, 0);
      return;
    }
    setTimeout(finish, opts.gatherDelayMs ?? 0);
  }

  async setRemoteDescription(d: { type: 'offer' | 'answer'; sdp: string }): Promise<void> {
    if (this.closed) throw new Error('InvalidStateError');
    this.remoteDescription = d;
    if (d.type === 'answer') {
      const m = /a=ice-ufrag:(\S+)/.exec(d.sdp);
      const peer = m ? this.world.byUfrag.get(m[1]) : undefined;
      this.world.connect(this, peer ?? null);
    }
  }

  addEventListener(type: string, listener: Listener): void {
    const l = this.listeners.get(type) ?? [];
    l.push(listener);
    this.listeners.set(type, l);
  }

  emit(type: string, event: { candidate?: unknown } = {}): void {
    for (const l of (this.listeners.get(type) ?? []).slice()) l(event);
  }

  setConnectionState(state: string): void {
    this.connectionState = state;
    this.emit('connectionstatechange');
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.connectionState = 'closed';
    this.channel?.close();
  }
}

export class FakeRtcWorld {
  pcs: FakePeerConnection[] = [];
  byUfrag = new Map<string, FakePeerConnection>();

  constructor(readonly options: FakeRtcOptions = {}) {}

  /** Appelé quand l'hôte applique la réponse : ouvre (ou fait échouer) la liaison hôte ↔ invité. */
  connect(host: FakePeerConnection, guest: FakePeerConnection | null): void {
    if (this.options.neverConnect) return;
    setTimeout(() => {
      if (this.options.failConnect || !guest || guest.closed || host.closed) {
        host.setConnectionState('failed');
        guest?.setConnectionState('failed');
        return;
      }
      if (host.channel && guest.channel) {
        host.channel.peer = guest.channel;
        guest.channel.peer = host.channel;
        host.setConnectionState('connected');
        guest.setConnectionState('connected');
        host.channel.open();
        guest.channel.open();
      }
    }, 0);
  }

  env(): RtcEnv {
    return { createPeerConnection: (config) => new FakePeerConnection(config, this) };
  }
}
