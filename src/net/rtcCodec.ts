/**
 * CODEC des codes d'invitation / de réponse WebRTC (signalisation MANUELLE, docs/NET.md § 4.3). Module pur : ni DOM ni `RTCPeerConnection`.
 *
 * Idée : on n'envoie pas la description SDP brute (1 à 2 Ko de lignes inutiles pour un simple DataChannel) mais l'ESSENTIEL, sous forme structurée
 * (`SignalDesc` : identifiants ICE, empreinte DTLS, rôle DTLS, candidats UDP), et on RECONSTRUIT un SDP standard de l'autre côté (`buildSdp`).
 * Typiquement 250 à 600 caractères pour deux ou trois candidats.
 *
 * Format du code (une courte chaîne copiable ; alphabet base64url `[A-Za-z0-9_-]`, JAMAIS `-` comme séparateur) :
 *   `V1` + genre (`O` invitation, `A` réponse) + base64url(octet d'indicateur ‖ charge utile) + somme de contrôle (4 caractères = 24 bits FNV-1a)
 * puis groupes de 5 caractères séparés par des espaces (tout blanc est ignoré à la lecture). Indicateur : 0 = JSON UTF-8 brut ; 1 = JSON compressé
 * `deflate-raw` (uniquement sur demande explicite `compress: true` : par défaut le code est brut, l'émetteur ignorant si le lecteur sait décompresser).
 *
 * Erreurs (`RtcSignalingError`) : `badCode` (illisible, tronqué, somme fausse, mauvais genre, valeurs hors format) ; `wrongVersion` (préfixe `V<n>` avec n ≠ 1, ou code compressé
 * alors que `DecompressionStream` manque : ce n'est pas « WebRTC absent »). `unsupported` n'est jamais levé ici (réservé à `rtcSignaling`, sans RTCPeerConnection). Le contenu n'est JAMAIS interprété avant validation de chaque champ
 * (aucun saut de ligne ni caractère libre ne peut atteindre le SDP reconstruit).
 */
import { NET } from './contracts';
import { RtcSignalingError } from './rtcErrors';

/** Version du FORMAT des codes (préfixe `V1`) ; indépendante de `NET_PROTOCOL_VERSION`. */
export const RTC_CODE_VERSION = 1;
/** Nombre maximal de candidats ICE conservés dans un code. */
export const RTC_MAX_CANDIDATES = 8;
/** Plafond (octets) de la charge utile décompressée : protège contre une « bombe » de décompression. */
const MAX_PAYLOAD_BYTES = 16384;

export type RtcCodeKind = 'invite' | 'answer';
export type DtlsSetup = 'actpass' | 'active' | 'passive';
export type CandidateType = 'host' | 'srflx' | 'prflx' | 'relay';

export interface SignalCandidate {
  foundation: string;
  priority: number;
  /** Adresse IP ou nom mDNS (`xxxx.local`). */
  address: string;
  port: number;
  type: CandidateType;
}

/** Contenu utile d'une description SDP de DataChannel. */
export interface SignalDesc {
  ufrag: string;
  pwd: string;
  /** Empreinte DTLS SHA-256 : 64 chiffres hexadécimaux en minuscules, sans `:`. */
  fingerprint: string;
  setup: DtlsSetup;
  mid: string;
  sctpPort: number;
  maxMessageSize: number;
  candidates: SignalCandidate[];
}

// ───────────────────────────── base64url ─────────────────────────────

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function bytesToBase64Url(bytes: Uint8Array): string {
  let out = '';
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < len ? bytes[i + 1] : 0;
    const b2 = i + 2 < len ? bytes[i + 2] : 0;
    const n = (b0 << 16) | (b1 << 8) | b2;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    if (i + 1 < len) out += B64[(n >> 6) & 63];
    if (i + 2 < len) out += B64[n & 63];
  }
  return out;
}

/** base64url → octets ; null si un caractère est hors alphabet ou si la longueur est impossible. */
export function base64UrlToBytes(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < text.length; i += 4) {
    const c0 = B64.indexOf(text[i]);
    const c1 = B64.indexOf(text[i + 1]);
    const c2 = i + 2 < text.length ? B64.indexOf(text[i + 2]) : 0;
    const c3 = i + 3 < text.length ? B64.indexOf(text[i + 3]) : 0;
    const n = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    out[o++] = (n >> 16) & 255;
    if (i + 2 < text.length) out[o++] = (n >> 8) & 255;
    if (i + 3 < text.length) out[o++] = n & 255;
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** Somme de contrôle 24 bits (FNV-1a 32 bits tronqué) en 4 caractères base64url. */
export function codeChecksum(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return bytesToBase64Url(new Uint8Array([(h >>> 16) & 255, (h >>> 8) & 255, h & 255]));
}

// ───────────────────────────── SDP ↔ SignalDesc ─────────────────────────────

const FINGERPRINT_RE = /^sha-256 ((?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2})$/i;

/**
 * Extrait l'essentiel d'un SDP de DataChannel produit par un navigateur (Chrome, Firefox, Safari : les attributs peuvent être au niveau session ou média,
 * on lit la première occurrence de chacun). Candidats : UDP, composant 1, hors lien-local IPv6, dédoublonnés, les `RTC_MAX_CANDIDATES` plus prioritaires.
 * @throws RtcSignalingError `failed` si le SDP ne contient pas d'identifiants ICE ou d'empreinte SHA-256.
 */
export function parseSdp(sdp: string): SignalDesc {
  let ufrag: string | undefined;
  let pwd: string | undefined;
  let fingerprint: string | undefined;
  let setup: DtlsSetup | undefined;
  let mid: string | undefined;
  let sctpPort: number | undefined;
  let maxMessageSize: number | undefined;
  const candidates: SignalCandidate[] = [];
  const seen = new Set<string>();

  for (const rawLine of sdp.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('a=ice-ufrag:')) ufrag ??= line.slice(12);
    else if (line.startsWith('a=ice-pwd:')) pwd ??= line.slice(10);
    else if (line.startsWith('a=fingerprint:')) {
      const m = FINGERPRINT_RE.exec(line.slice(14));
      if (m) fingerprint ??= m[1].replace(/:/g, '').toLowerCase();
    } else if (line.startsWith('a=setup:')) {
      const v = line.slice(8);
      if (v === 'actpass' || v === 'active' || v === 'passive') setup ??= v;
    } else if (line.startsWith('a=mid:')) mid ??= line.slice(6);
    else if (line.startsWith('a=sctp-port:')) sctpPort ??= Number(line.slice(12));
    else if (line.startsWith('a=max-message-size:')) maxMessageSize ??= Number(line.slice(19));
    else if (line.startsWith('a=candidate:')) {
      const c = parseCandidateLine(line.slice(12));
      if (c) {
        const key = `${c.address}:${c.port}`;
        if (!seen.has(key)) {
          seen.add(key);
          candidates.push(c);
        }
      }
    }
  }
  if (!ufrag || !pwd || !fingerprint) throw new RtcSignalingError('failed', 'description locale incomplète');
  candidates.sort((a, b) => b.priority - a.priority);
  return {
    ufrag,
    pwd,
    fingerprint,
    setup: setup ?? 'actpass',
    mid: mid ?? '0',
    sctpPort: Number.isInteger(sctpPort) && (sctpPort as number) > 0 ? (sctpPort as number) : 5000,
    maxMessageSize: Number.isInteger(maxMessageSize) && (maxMessageSize as number) > 0 ? (maxMessageSize as number) : 65536,
    candidates: candidates.slice(0, RTC_MAX_CANDIDATES),
  };
}

/** `foundation component protocole priorité adresse port typ type …` → candidat compact, ou null (TCP, composant 2, lien-local, forme inattendue). */
function parseCandidateLine(body: string): SignalCandidate | null {
  const t = body.trim().split(/\s+/);
  if (t.length < 8 || t[6] !== 'typ') return null;
  if (t[1] !== '1' || t[2].toLowerCase() !== 'udp') return null;
  const type = t[7];
  if (type !== 'host' && type !== 'srflx' && type !== 'prflx' && type !== 'relay') return null;
  const priority = Number(t[3]);
  const port = Number(t[5]);
  const address = t[4];
  if (!isCandidateFoundation(t[0]) || !Number.isInteger(priority) || priority < 0 || priority > 0xffffffff) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !isCandidateAddress(address)) return null;
  if (/^fe80:/i.test(address)) return null; // lien-local IPv6 : inutilisable sans indice de zone
  return { foundation: t[0], priority, address, port, type };
}

function isCandidateFoundation(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9A-Za-z+/]{1,32}$/.test(v);
}

function isCandidateAddress(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9A-Za-z.:_-]{1,255}$/.test(v);
}

/** Reconstruit un SDP complet (offre ou réponse) à partir d'une `SignalDesc` VALIDÉE. */
export function buildSdp(desc: SignalDesc): string {
  const fp = desc.fingerprint.toUpperCase().match(/../g)?.join(':') ?? '';
  const lines = [
    'v=0',
    'o=- 1 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    `a=group:BUNDLE ${desc.mid}`,
    'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    `a=ice-ufrag:${desc.ufrag}`,
    `a=ice-pwd:${desc.pwd}`,
    `a=fingerprint:sha-256 ${fp}`,
    `a=setup:${desc.setup}`,
    `a=mid:${desc.mid}`,
    `a=sctp-port:${desc.sctpPort}`,
    `a=max-message-size:${desc.maxMessageSize}`,
  ];
  for (const c of desc.candidates) {
    const related = c.type === 'host' ? '' : ` raddr ${c.address.includes(':') ? '::' : '0.0.0.0'} rport 0`;
    lines.push(`a=candidate:${c.foundation} 1 udp ${c.priority} ${c.address} ${c.port} typ ${c.type}${related} generation 0`);
  }
  lines.push('a=end-of-candidates');
  return lines.join('\r\n') + '\r\n';
}

// ───────────────────────────── Charge utile ─────────────────────────────

const SETUP_TO_CODE: Record<DtlsSetup, string> = { actpass: 'x', active: 'a', passive: 'p' };
const CODE_TO_SETUP: Record<string, DtlsSetup> = { x: 'actpass', a: 'active', p: 'passive' };
const TYPE_TO_CODE: Record<CandidateType, string> = { host: 'h', srflx: 's', prflx: 'p', relay: 'r' };
const CODE_TO_TYPE: Record<string, CandidateType> = { h: 'host', s: 'srflx', p: 'prflx', r: 'relay' };

/** Description → JSON compact `{u,p,f,s,m,o,z,c}`. */
export function descToPayload(desc: SignalDesc): string {
  return JSON.stringify({
    u: desc.ufrag,
    p: desc.pwd,
    f: bytesToBase64Url(hexToBytes(desc.fingerprint)),
    s: SETUP_TO_CODE[desc.setup],
    m: desc.mid,
    o: desc.sctpPort,
    z: desc.maxMessageSize,
    c: desc.candidates.map((c) => [c.foundation, c.priority, c.address, c.port, TYPE_TO_CODE[c.type]]),
  });
}

/** JSON décodé → description validée champ par champ, ou null. */
export function payloadToDesc(v: unknown): SignalDesc | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const own = (k: string): unknown => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
  const u = own('u');
  const p = own('p');
  const f = own('f');
  const s = own('s');
  const m = own('m');
  const port = own('o');
  const z = own('z');
  const c = own('c');
  if (typeof u !== 'string' || !/^[A-Za-z0-9+/]{3,256}$/.test(u)) return null;
  if (typeof p !== 'string' || !/^[A-Za-z0-9+/]{8,256}$/.test(p)) return null;
  if (typeof f !== 'string') return null;
  const fpBytes = base64UrlToBytes(f);
  if (!fpBytes || fpBytes.length !== 32) return null;
  if (typeof s !== 'string' || !Object.prototype.hasOwnProperty.call(CODE_TO_SETUP, s)) return null;
  if (typeof m !== 'string' || !/^[A-Za-z0-9_-]{1,16}$/.test(m)) return null;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (typeof z !== 'number' || !Number.isInteger(z) || z < 1 || z > 0x7fffffff) return null;
  if (!Array.isArray(c) || c.length < 1 || c.length > RTC_MAX_CANDIDATES + 4) return null;
  const candidates: SignalCandidate[] = [];
  for (const raw of c as unknown[]) {
    if (!Array.isArray(raw) || raw.length !== 5) return null;
    const [foundation, priority, address, cport, tcode] = raw as unknown[];
    if (!isCandidateFoundation(foundation) || !isCandidateAddress(address)) return null;
    if (typeof priority !== 'number' || !Number.isInteger(priority) || priority < 0 || priority > 0xffffffff) return null;
    if (typeof cport !== 'number' || !Number.isInteger(cport) || cport < 1 || cport > 65535) return null;
    if (typeof tcode !== 'string' || !Object.prototype.hasOwnProperty.call(CODE_TO_TYPE, tcode)) return null;
    candidates.push({ foundation, priority, address, port: cport, type: CODE_TO_TYPE[tcode] });
  }
  return { ufrag: u, pwd: p, fingerprint: bytesToHex(fpBytes), setup: CODE_TO_SETUP[s], mid: m, sctpPort: port, maxMessageSize: z, candidates };
}

// ───────────────────────────── Compression (optionnelle) ─────────────────────────────

type StreamCtor = new (format: string) => { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };

async function runStream(Ctor: StreamCtor, input: Uint8Array, maxOut: number): Promise<Uint8Array | null> {
  try {
    const stream = new Ctor('deflate-raw');
    const writer = stream.writable.getWriter();
    // l'écriture et la lecture avancent ensemble : on n'attend pas l'écriture avant de lire
    void writer.write(input).catch(() => undefined);
    void writer.close().catch(() => undefined);
    const reader = stream.readable.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxOut) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const ch of chunks) {
      out.set(ch, at);
      at += ch.length;
    }
    return out;
  } catch {
    return null;
  }
}

async function deflateRaw(input: Uint8Array): Promise<Uint8Array | null> {
  const Ctor = (globalThis as { CompressionStream?: StreamCtor }).CompressionStream;
  return typeof Ctor === 'function' ? runStream(Ctor, input, MAX_PAYLOAD_BYTES) : null;
}

async function inflateRaw(input: Uint8Array): Promise<Uint8Array> {
  const Ctor = (globalThis as { DecompressionStream?: StreamCtor }).DecompressionStream;
  // ce n'est PAS « WebRTC non pris en charge » (code `unsupported`) : le navigateur lit le code d'une autre génération de l'application (compressé) ; « autre version » est le message juste
  if (typeof Ctor !== 'function') throw new RtcSignalingError('wrongVersion', 'code compressé : DecompressionStream indisponible');
  const out = await runStream(Ctor, input, MAX_PAYLOAD_BYTES);
  if (!out) throw new RtcSignalingError('badCode', 'décompression impossible');
  return out;
}

// ───────────────────────────── Codes ─────────────────────────────

/** Regroupe par 5 caractères séparés par des espaces (lisible et facile à recopier). */
export function groupCode(clean: string): string {
  return (clean.match(/.{1,5}/g) ?? []).join(' ');
}

/** Retire tous les blancs (espaces, retours à la ligne, tabulations, espaces insécables) d'un code collé. */
export function cleanCode(code: string): string {
  return code.replace(/[\s ​﻿]+/g, '');
}

/**
 * Description → code compact et groupé. PAS de compression par défaut : l'émetteur ne connaît pas les capacités de celui qui lira le code (un navigateur sans
 * `DecompressionStream` deflate-raw ne pourrait jamais rejoindre), et le gain est faible (≈ 250 contre 350-400 caractères pour 1 candidat, bien sous
 * `NET.CODE_MAX_CHARS`). `compress: true` est un choix explicite (tests, usages où les deux bouts sont connus).
 * Si le code dépasse `NET.CODE_MAX_CHARS`, on retire les candidats les moins prioritaires jusqu'à ce qu'il tienne.
 */
export async function encodeSignalCode(kind: RtcCodeKind, desc: SignalDesc, options: { compress?: boolean } = {}): Promise<string> {
  const letter = kind === 'invite' ? 'O' : 'A';
  const work: SignalDesc = { ...desc, candidates: desc.candidates.slice(0, RTC_MAX_CANDIDATES) };
  for (;;) {
    const raw = new TextEncoder().encode(descToPayload(work));
    let body = new Uint8Array(raw.length + 1);
    body[0] = 0;
    body.set(raw, 1);
    if (options.compress === true) {
      const packed = await deflateRaw(raw);
      if (packed && packed.length + 1 < body.length) {
        body = new Uint8Array(packed.length + 1);
        body[0] = 1;
        body.set(packed, 1);
      }
    }
    const head = `V${RTC_CODE_VERSION}${letter}${bytesToBase64Url(body)}`;
    const clean = head + codeChecksum(head);
    if (clean.length <= NET.CODE_MAX_CHARS || work.candidates.length <= 1) return groupCode(clean);
    work.candidates = work.candidates.slice(0, work.candidates.length - 1);
  }
}

/**
 * Code collé → description validée.
 * @throws RtcSignalingError `badCode` | `wrongVersion`
 */
export async function decodeSignalCode(code: string, expected: RtcCodeKind): Promise<SignalDesc> {
  if (typeof code !== 'string' || code.length === 0 || code.length > NET.CODE_MAX_CHARS * 4) throw new RtcSignalingError('badCode', 'taille');
  const clean = cleanCode(code);
  if (clean.length === 0 || clean.length > NET.CODE_MAX_CHARS) throw new RtcSignalingError('badCode', 'taille');
  const prefix = /^V(\d{1,3})/.exec(clean);
  if (!prefix) throw new RtcSignalingError('badCode', 'préfixe');
  if (Number(prefix[1]) !== RTC_CODE_VERSION) throw new RtcSignalingError('wrongVersion', `format V${prefix[1]}`);
  const letter = clean[prefix[0].length];
  if (letter !== 'O' && letter !== 'A') throw new RtcSignalingError('badCode', 'genre');
  if (letter !== (expected === 'invite' ? 'O' : 'A')) {
    throw new RtcSignalingError('badCode', expected === 'invite' ? 'ce code est une réponse, pas une invitation' : 'ce code est une invitation, pas une réponse');
  }
  const rest = clean.slice(prefix[0].length + 1);
  if (rest.length < 6 || !/^[A-Za-z0-9_-]+$/.test(rest)) throw new RtcSignalingError('badCode', 'alphabet');
  const body = rest.slice(0, -4);
  const sum = rest.slice(-4);
  if (codeChecksum(`V${RTC_CODE_VERSION}${letter}${body}`) !== sum) throw new RtcSignalingError('badCode', 'somme de contrôle');
  const bytes = base64UrlToBytes(body);
  if (!bytes || bytes.length < 2) throw new RtcSignalingError('badCode', 'contenu');
  let data = bytes.subarray(1);
  if (bytes[0] === 1) data = await inflateRaw(data);
  else if (bytes[0] !== 0) throw new RtcSignalingError('badCode', 'indicateur');
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)) as unknown;
  } catch {
    throw new RtcSignalingError('badCode', 'JSON');
  }
  const desc = payloadToDesc(json);
  if (!desc) throw new RtcSignalingError('badCode', 'champs invalides');
  return desc;
}
