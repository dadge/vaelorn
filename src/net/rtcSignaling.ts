/**
 * SIGNALISATION WEBRTC MANUELLE, sans serveur (docs/NET.md § 4.3). Un code par invité :
 *  1. HÔTE `createInvite()` : `RTCPeerConnection` SANS serveur ICE (réseau local seulement), canal de données négocié (`negotiated`, `id: 0`, fiable et ordonné,
 *     créé des deux côtés : pas de `ondatachannel`), offre, collecte ICE ATTENDUE jusqu'au bout (plafonnée par `iceTimeoutMs`), puis export du « code d'invitation » ;
 *  2. INVITÉ `join(code)` : colle l'invitation, produit le « code de réponse » (même collecte ICE) à renvoyer à l'hôte ;
 *  3. HÔTE `invite.accept(codeDeReponse)` : applique la réponse ; la promesse rend le `Transport` OUVERT ; côté invité `answer.transport` se résout à l'ouverture.
 * Le format des codes est celui de `rtcCodec.ts` (structuré, validé champ par champ : le code n'est jamais interprété autrement que reconstruit en SDP après validation).
 *
 * `RTCPeerConnection` est injectable (`RtcEnv`) : la logique (attente ICE, délais, annulation, erreurs) est testée sous Node avec une fausse connexion.
 */
import {
  type CreateRtcGuestSignaling,
  type CreateRtcHostSignaling,
  type RtcGuestAnswer,
  type RtcGuestSignaling,
  type RtcHostInvite,
  type RtcHostSignaling,
  type RtcOptions,
  type Transport,
} from './contracts';
import { answerMatchesOffer, buildSdp, decodeSignalCode, encodeSignalCode, offerRef, parseSdp } from './rtcCodec';
import { RtcSignalingError } from './rtcErrors';
import { createRtcTransport, type RtcDataChannelLike } from './transportRtc';

export { RtcSignalingError } from './rtcErrors';

/** Délai maximal (ms) de collecte ICE par défaut. */
export const RTC_ICE_TIMEOUT_MS = 4000;
/** Délai (ms) accordé à l'HÔTE entre le collage de la réponse et l'ouverture du canal. */
export const RTC_HOST_CONNECT_TIMEOUT_MS = 20000;
/** Délai (ms) accordé à l'INVITÉ pour que l'hôte colle sa réponse (copie du code, bascule d'appareil…) : plus long. */
export const RTC_GUEST_CONNECT_TIMEOUT_MS = 120000;

/** Options étendues : `connectTimeoutMs` remplace les deux délais de connexion ci-dessus (essais, dépannage). */
export interface RtcOptionsEx extends RtcOptions {
  connectTimeoutMs?: number;
}

// ───────────────────────────── Abstraction de RTCPeerConnection ─────────────────────────────

export interface RtcSessionDescriptionLike {
  type?: string;
  sdp?: string;
}

/** Sous-ensemble de `RTCPeerConnection` utilisé ici. */
export interface RtcPeerConnectionLike {
  readonly iceGatheringState: string;
  readonly connectionState?: string;
  readonly localDescription: RtcSessionDescriptionLike | null;
  createDataChannel(label: string, init: { negotiated: boolean; id: number; ordered: boolean }): RtcDataChannelLike;
  createOffer(): Promise<RtcSessionDescriptionLike>;
  createAnswer(): Promise<RtcSessionDescriptionLike>;
  setLocalDescription(description: RtcSessionDescriptionLike): Promise<void>;
  setRemoteDescription(description: { type: 'offer' | 'answer'; sdp: string }): Promise<void>;
  addEventListener(type: 'icecandidate' | 'icegatheringstatechange' | 'connectionstatechange', listener: (event: unknown) => void): void;
  close(): void;
}

export interface RtcEnv {
  createPeerConnection(config: { iceServers: { urls: string | string[] }[] }): RtcPeerConnectionLike;
}

/** WebRTC est-il disponible dans cet environnement ? */
export function isRtcSupported(): boolean {
  return typeof (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection === 'function';
}

function defaultEnv(): RtcEnv {
  const Ctor = (globalThis as { RTCPeerConnection?: new (config: unknown) => unknown }).RTCPeerConnection;
  if (typeof Ctor !== 'function') throw new RtcSignalingError('unsupported');
  return { createPeerConnection: (config) => new Ctor(config) as unknown as RtcPeerConnectionLike };
}

// ───────────────────────────── Outils ─────────────────────────────

/** Annulation : `race` rejette `cancelled` dès que `cancel()` est appelé ; les crochets libèrent les ressources. */
class Cancel {
  cancelled = false;
  private hooks: (() => void)[] = [];

  onCancel(hook: () => void): void {
    if (this.cancelled) hook();
    else this.hooks.push(hook);
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const h of this.hooks.splice(0)) {
      try {
        h();
      } catch {
        // une libération qui échoue ne doit pas empêcher les autres
      }
    }
  }

  race<T>(p: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.cancelled) {
        reject(new RtcSignalingError('cancelled'));
        return;
      }
      this.onCancel(() => reject(new RtcSignalingError('cancelled')));
      p.then(resolve, reject);
    });
  }
}

function asSignalingError(e: unknown, fallback: string): RtcSignalingError {
  if (e instanceof RtcSignalingError) return e;
  return new RtcSignalingError('failed', e instanceof Error ? e.message || fallback : fallback);
}

function sdpHasCandidate(pc: RtcPeerConnectionLike): boolean {
  return /^a=candidate:/m.test(pc.localDescription?.sdp ?? '');
}

/** Attend la fin de la collecte ICE (candidat nul, `iceGatheringState === 'complete'`) ou le délai ; sans aucun candidat : `iceTimeout`. */
function waitIceComplete(pc: RtcPeerConnectionLike, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (err?: RtcSignalingError): void => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    const timeoutError = (): RtcSignalingError => new RtcSignalingError('iceTimeout', 'aucun candidat réseau collecté');
    pc.addEventListener('icecandidate', (ev) => {
      const candidate = (ev as { candidate?: unknown } | null)?.candidate;
      if (candidate === null) finish(); // fin de collecte annoncée
    });
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') finish();
    });
    if (pc.iceGatheringState === 'complete') {
      finish();
      return;
    }
    timer = setTimeout(() => finish(sdpHasCandidate(pc) ? undefined : timeoutError()), Math.max(0, timeoutMs));
  });
}

/** Attend l'ouverture du canal ; échoue (`failed`) à sa fermeture, à l'échec de la connexion pair à pair ou au délai. */
function waitChannelOpen(pc: RtcPeerConnectionLike, dc: RtcDataChannelLike, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (err?: RtcSignalingError): void => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    dc.addEventListener('open', () => finish());
    dc.addEventListener('close', () => finish(new RtcSignalingError('failed', 'canal fermé avant l\'ouverture')));
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed') finish(new RtcSignalingError('failed', 'connexion pair à pair échouée'));
    });
    if (dc.readyState === 'open') {
      finish();
      return;
    }
    timer = setTimeout(() => finish(new RtcSignalingError('failed', 'délai de connexion dépassé')), Math.max(0, timeoutMs));
  });
}

const DC_LABEL = 'vaelorn';
const DC_INIT = { negotiated: true, id: 0, ordered: true } as const;

// ───────────────────────────── Hôte ─────────────────────────────

export function createRtcHostSignalingWith(env: () => RtcEnv, options: RtcOptionsEx = {}): RtcHostSignaling {
  const iceTimeoutMs = options.iceTimeoutMs ?? RTC_ICE_TIMEOUT_MS;
  const connectTimeoutMs = options.connectTimeoutMs ?? RTC_HOST_CONNECT_TIMEOUT_MS;

  return {
    async createInvite(): Promise<RtcHostInvite> {
      const pc = env().createPeerConnection({ iceServers: options.iceServers ?? [] });
      const cancel = new Cancel();
      cancel.onCancel(() => pc.close());
      try {
        const dc = pc.createDataChannel(DC_LABEL, DC_INIT);
        const offer = await cancel.race(pc.createOffer());
        await cancel.race(pc.setLocalDescription(offer));
        await cancel.race(waitIceComplete(pc, iceTimeoutMs));
        const sdp = pc.localDescription?.sdp;
        if (!sdp) throw new RtcSignalingError('failed', 'description locale absente');
        const desc = parseSdp(sdp);
        if (desc.candidates.length === 0) throw new RtcSignalingError('iceTimeout', 'aucun candidat réseau utilisable');
        const code = await cancel.race(encodeSignalCode('invite', desc));
        let used = false;
        const invite: RtcHostInvite = {
          code,
          async accept(answerCode: string): Promise<Transport> {
            if (used) throw new RtcSignalingError('failed', 'invitation déjà utilisée');
            // un code illisible ne « consomme » pas l'invitation : l'utilisateur peut recoller
            const answer = await cancel.race(decodeSignalCode(answerCode, 'answer'));
            // la réponse d'une AUTRE invitation (l'invité montre encore l'écran d'une invitation annulée) ne « consomme » pas non plus l'invitation : `badCode`
            if (!answerMatchesOffer(answer, desc)) throw new RtcSignalingError('badCode', 'réponse à une autre invitation');
            used = true;
            try {
              await cancel.race(pc.setRemoteDescription({ type: 'answer', sdp: buildSdp(answer) }));
              await cancel.race(waitChannelOpen(pc, dc, connectTimeoutMs));
              return createRtcTransport(dc, pc);
            } catch (e) {
              cancel.cancel();
              throw asSignalingError(e, 'connexion impossible');
            }
          },
          cancel: () => cancel.cancel(),
        };
        return invite;
      } catch (e) {
        cancel.cancel();
        throw asSignalingError(e, 'invitation impossible');
      }
    },
  };
}

// ───────────────────────────── Invité ─────────────────────────────

export function createRtcGuestSignalingWith(env: () => RtcEnv, options: RtcOptionsEx = {}): RtcGuestSignaling {
  const iceTimeoutMs = options.iceTimeoutMs ?? RTC_ICE_TIMEOUT_MS;
  const connectTimeoutMs = options.connectTimeoutMs ?? RTC_GUEST_CONNECT_TIMEOUT_MS;

  return {
    async join(inviteCode: string): Promise<RtcGuestAnswer> {
      const rtc = env(); // d'abord : sans WebRTC, l'erreur est « unsupported », pas « badCode »
      const invite = await decodeSignalCode(inviteCode, 'invite');
      const pc = rtc.createPeerConnection({ iceServers: options.iceServers ?? [] });
      const cancel = new Cancel();
      cancel.onCancel(() => pc.close());
      try {
        const dc = pc.createDataChannel(DC_LABEL, DC_INIT);
        await cancel.race(pc.setRemoteDescription({ type: 'offer', sdp: buildSdp(invite) }));
        const answer = await cancel.race(pc.createAnswer());
        await cancel.race(pc.setLocalDescription(answer));
        await cancel.race(waitIceComplete(pc, iceTimeoutMs));
        const sdp = pc.localDescription?.sdp;
        if (!sdp) throw new RtcSignalingError('failed', 'description locale absente');
        const desc = parseSdp(sdp);
        if (desc.candidates.length === 0) throw new RtcSignalingError('iceTimeout', 'aucun candidat réseau utilisable');
        const answerCode = await cancel.race(encodeSignalCode('answer', { ...desc, offerRef: offerRef(invite) })); // la réponse porte l'empreinte de SON invitation
        const transport = cancel
          .race(waitChannelOpen(pc, dc, connectTimeoutMs))
          .then((): Transport => createRtcTransport(dc, pc))
          .catch((e: unknown) => {
            cancel.cancel();
            throw asSignalingError(e, 'connexion impossible');
          });
        transport.catch(() => undefined); // aucune « rejection non gérée » si personne n'attend la promesse
        return { answerCode, transport, cancel: () => cancel.cancel() };
      } catch (e) {
        cancel.cancel();
        throw asSignalingError(e, 'réponse impossible');
      }
    },
  };
}

// ───────────────────────────── Fabriques du contrat ─────────────────────────────

/** Signalisation côté hôte (contrat `CreateRtcHostSignaling`). `createInvite()` rejette `unsupported` sans WebRTC. */
export const createRtcHostSignaling: CreateRtcHostSignaling = (options) => createRtcHostSignalingWith(defaultEnv, options);

/** Signalisation côté invité (contrat `CreateRtcGuestSignaling`). `join()` rejette `unsupported` sans WebRTC. */
export const createRtcGuestSignaling: CreateRtcGuestSignaling = (options) => createRtcGuestSignalingWith(defaultEnv, options);
