/**
 * Tests du codec des codes d'invitation / de réponse : base64url, extraction et reconstruction du SDP (Chrome, Firefox), aller-retour brut et compressé,
 * somme de contrôle, mauvaise version, genre inversé, blancs ignorés, longueur, injection dans le SDP, bombe de décompression.
 */
import { describe, expect, it } from 'vitest';
import { NET } from './contracts';
import {
  RTC_MAX_CANDIDATES,
  base64UrlToBytes,
  buildSdp,
  bytesToBase64Url,
  cleanCode,
  codeChecksum,
  decodeSignalCode,
  descToPayload,
  encodeSignalCode,
  groupCode,
  parseSdp,
  payloadToDesc,
  type SignalDesc,
} from './rtcCodec';
import { RtcSignalingError } from './rtcErrors';

const FP = '00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF';

const CHROME_SDP = [
  'v=0',
  'o=- 8123456789 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'a=extmap-allow-mixed',
  'a=msid-semantic: WMS',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=candidate:842163049 1 udp 1677729535 203.0.113.9 51234 typ srflx raddr 0.0.0.0 rport 0 generation 0 network-cost 999',
  'a=candidate:1 1 udp 2113937151 3f2a1c2e-5b6e-4a9a-8c1d-0a1b2c3d4e5f.local 56789 typ host generation 0 network-cost 999',
  'a=candidate:2 1 tcp 1518280447 192.168.43.1 9 typ host tcptype active generation 0',
  'a=candidate:3 1 udp 2113939711 fe80::1234 5000 typ host generation 0',
  'a=candidate:4 1 udp 2113937150 192.168.43.1 40000 typ host generation 0',
  'a=candidate:5 2 udp 2113937149 192.168.43.1 40001 typ host generation 0',
  'a=candidate:6 1 udp 2113937151 3f2a1c2e-5b6e-4a9a-8c1d-0a1b2c3d4e5f.local 56789 typ host generation 0',
  'a=ice-ufrag:aBcD',
  'a=ice-pwd:0123456789abcdefghijklmn',
  'a=ice-options:trickle',
  `a=fingerprint:sha-256 ${FP}`,
  'a=setup:actpass',
  'a=mid:0',
  'a=sctp-port:5000',
  'a=max-message-size:262144',
  '',
].join('\r\n');

/** Firefox : empreinte au niveau SESSION, attributs ICE après les candidats, fins de ligne LF. */
const FIREFOX_SDP = [
  'v=0',
  'o=mozilla...THIS_IS_SDPARTA-99.0 123 0 IN IP4 0.0.0.0',
  's=-',
  't=0 0',
  'a=sendrecv',
  `a=fingerprint:sha-256 ${FP.toLowerCase()}`,
  'a=group:BUNDLE 0',
  'a=ice-options:trickle',
  'a=msid-semantic:WMS *',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=candidate:0 1 UDP 2122252543 192.168.1.20 49152 typ host',
  'a=sendrecv',
  'a=end-of-candidates',
  'a=ice-pwd:fedcba9876543210fedcba98',
  'a=ice-ufrag:ff00ee11',
  'a=mid:0',
  'a=setup:actpass',
  'a=sctp-port:5000',
  'a=max-message-size:1073741823',
].join('\n');

function sampleDesc(overrides: Partial<SignalDesc> = {}): SignalDesc {
  return {
    ufrag: 'aBcD',
    pwd: '0123456789abcdefghijklmn',
    fingerprint: FP.replace(/:/g, '').toLowerCase(),
    setup: 'actpass',
    mid: '0',
    sctpPort: 5000,
    maxMessageSize: 262144,
    candidates: [
      { foundation: '1', priority: 2113937151, address: '3f2a1c2e-5b6e-4a9a-8c1d-0a1b2c3d4e5f.local', port: 56789, type: 'host' },
      { foundation: '2', priority: 1677729535, address: '203.0.113.9', port: 51234, type: 'srflx' },
    ],
    ...overrides,
  };
}

async function rejection(p: Promise<unknown>): Promise<RtcSignalingError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(RtcSignalingError);
    return e as RtcSignalingError;
  }
  throw new Error('rejet attendu');
}

describe('rtcCodec : base64url et somme de contrôle', () => {
  it('aller-retour pour toutes les longueurs 0..40', () => {
    for (let n = 0; n <= 40; n++) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 37 + n * 11) & 255);
      const text = bytesToBase64Url(bytes);
      expect(text).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(Array.from(base64UrlToBytes(text) ?? [])).toEqual(Array.from(bytes));
    }
  });

  it('refuse les caractères hors alphabet et les longueurs impossibles', () => {
    expect(base64UrlToBytes('abc+')).toBeNull();
    expect(base64UrlToBytes('ab/d')).toBeNull();
    expect(base64UrlToBytes('abc=')).toBeNull();
    expect(base64UrlToBytes('a b')).toBeNull();
    expect(base64UrlToBytes('abcde')).toBeNull(); // longueur ≡ 1 (mod 4)
    expect(base64UrlToBytes('')).toEqual(new Uint8Array(0));
  });

  it('somme de contrôle : 4 caractères base64url, sensible à chaque caractère', () => {
    const base = 'V1OAbCdEfGhIjKlMnOp';
    const sum = codeChecksum(base);
    expect(sum).toMatch(/^[A-Za-z0-9_-]{4}$/);
    expect(codeChecksum(base)).toBe(sum);
    for (let i = 0; i < base.length; i++) {
      const flipped = base.slice(0, i) + (base[i] === 'x' ? 'y' : 'x') + base.slice(i + 1);
      expect(codeChecksum(flipped)).not.toBe(sum);
    }
  });

  it('groupCode / cleanCode : groupes de 5 séparés par des espaces, tous les blancs retirés', () => {
    expect(groupCode('ABCDEFGHIJKLM')).toBe('ABCDE FGHIJ KLM');
    expect(cleanCode(' AB\tCD\r\nEF GH​IJ﻿ ')).toBe('ABCDEFGHIJ');
    expect(groupCode('')).toBe('');
  });
});

describe('rtcCodec : SDP ↔ description', () => {
  it('Chrome : extrait l\'essentiel, filtre TCP / composant 2 / lien-local, dédoublonne, trie par priorité', () => {
    const d = parseSdp(CHROME_SDP);
    expect(d.ufrag).toBe('aBcD');
    expect(d.pwd).toBe('0123456789abcdefghijklmn');
    expect(d.fingerprint).toBe(FP.replace(/:/g, '').toLowerCase());
    expect(d.setup).toBe('actpass');
    expect(d.mid).toBe('0');
    expect(d.sctpPort).toBe(5000);
    expect(d.maxMessageSize).toBe(262144);
    expect(d.candidates.map((c) => `${c.address}:${c.port}`)).toEqual([
      '3f2a1c2e-5b6e-4a9a-8c1d-0a1b2c3d4e5f.local:56789',
      '192.168.43.1:40000',
      '203.0.113.9:51234',
    ]);
    expect(d.candidates.map((c) => c.type)).toEqual(['host', 'host', 'srflx']);
    expect(d.candidates.map((c) => c.priority)).toEqual([...d.candidates.map((c) => c.priority)].sort((a, b) => b - a));
  });

  it('Firefox : empreinte au niveau session, attributs après les candidats, fins de ligne LF', () => {
    const d = parseSdp(FIREFOX_SDP);
    expect(d.ufrag).toBe('ff00ee11');
    expect(d.pwd).toBe('fedcba9876543210fedcba98');
    expect(d.fingerprint).toBe(FP.replace(/:/g, '').toLowerCase());
    expect(d.maxMessageSize).toBe(1073741823);
    expect(d.candidates).toEqual([{ foundation: '0', priority: 2122252543, address: '192.168.1.20', port: 49152, type: 'host' }]);
  });

  it('valeurs absentes : défauts raisonnables (mid 0, port SCTP 5000, taille 65536, setup actpass)', () => {
    const minimal = ['a=ice-ufrag:abcd', 'a=ice-pwd:0123456789abcdefghijklmn', `a=fingerprint:sha-256 ${FP}`, 'a=candidate:1 1 udp 100 10.0.0.1 4000 typ host'].join('\r\n');
    const d = parseSdp(minimal);
    expect([d.mid, d.sctpPort, d.maxMessageSize, d.setup]).toEqual(['0', 5000, 65536, 'actpass']);
  });

  it('plafonne à RTC_MAX_CANDIDATES candidats (les plus prioritaires)', () => {
    const lines = ['a=ice-ufrag:abcd', 'a=ice-pwd:0123456789abcdefghijklmn', `a=fingerprint:sha-256 ${FP}`];
    for (let i = 0; i < 20; i++) lines.push(`a=candidate:${i} 1 udp ${1000 + i} 10.0.0.${i + 1} ${4000 + i} typ host`);
    const d = parseSdp(lines.join('\n'));
    expect(d.candidates).toHaveLength(RTC_MAX_CANDIDATES);
    expect(d.candidates[0].priority).toBe(1019);
  });

  it('SDP incomplet : erreur « failed »', () => {
    expect(() => parseSdp('v=0\r\n')).toThrow(RtcSignalingError);
    expect(() => parseSdp(`a=ice-ufrag:abcd\r\na=ice-pwd:0123456789abcdefghijklmn\r\na=fingerprint:sha-1 AA:BB`)).toThrow(/incomplète/);
    try {
      parseSdp('');
    } catch (e) {
      expect((e as RtcSignalingError).code).toBe('failed');
    }
  });

  it('buildSdp : SDP complet (fins de ligne CRLF), relu à l\'identique par parseSdp', () => {
    const d = sampleDesc();
    const sdp = buildSdp(d);
    expect(sdp.endsWith('\r\n')).toBe(true);
    expect(sdp).toContain('m=application 9 UDP/DTLS/SCTP webrtc-datachannel');
    expect(sdp).toContain('a=group:BUNDLE 0');
    expect(sdp).toContain(`a=fingerprint:sha-256 ${FP}`);
    expect(sdp).toContain('a=end-of-candidates');
    // un candidat srflx porte raddr / rport (obligatoires en SDP)
    expect(sdp).toMatch(/typ srflx raddr 0\.0\.0\.0 rport 0/);
    const back = parseSdp(buildSdp(d));
    expect(back.ufrag).toBe(d.ufrag);
    expect(back.fingerprint).toBe(d.fingerprint);
    expect(back.candidates).toEqual(d.candidates);
  });

  it('l\'empreinte du SDP reconstruit est en majuscules séparées par « : »', () => {
    expect(buildSdp(sampleDesc())).toMatch(/a=fingerprint:sha-256 (?:[0-9A-F]{2}:){31}[0-9A-F]{2}\r\n/);
  });
});

describe('rtcCodec : codes', () => {
  it('aller-retour brut (sans compression) : invitation et réponse', async () => {
    const d = sampleDesc();
    for (const kind of ['invite', 'answer'] as const) {
      const code = await encodeSignalCode(kind, d, { compress: false });
      expect(code.startsWith(kind === 'invite' ? 'V1O' : 'V1A')).toBe(true);
      expect(await decodeSignalCode(code, kind)).toEqual(d);
    }
  });

  it('aller-retour avec compression explicite ; jamais plus long que le brut', async () => {
    const d = sampleDesc({
      candidates: Array.from({ length: 6 }, (_, i) => ({ foundation: String(i + 1), priority: 2113937151 - i, address: `192.168.1.${i + 10}`, port: 50000 + i, type: 'host' as const })),
    });
    const packed = await encodeSignalCode('invite', d, { compress: true });
    const raw = await encodeSignalCode('invite', d, { compress: false });
    expect(cleanCode(packed).length).toBeLessThanOrEqual(cleanCode(raw).length);
    expect(await decodeSignalCode(packed, 'invite')).toEqual(d);
    expect(await decodeSignalCode(raw, 'invite')).toEqual(d);
  });

  it('le code est une courte chaîne copiable : alphabet base64url, groupes de 5 séparés par des espaces, jamais de « - » comme séparateur', async () => {
    const code = await encodeSignalCode('invite', sampleDesc());
    const clean = cleanCode(code);
    expect(clean.length).toBeLessThan(900);
    expect(clean).toMatch(/^V1O[A-Za-z0-9_-]+$/);
    for (const group of code.split(' ')) expect(group.length).toBeLessThanOrEqual(5);
    expect(code.split(' ').slice(0, -1).every((g) => g.length === 5)).toBe(true);
    expect(code).not.toMatch(/[\r\n\t]/);
  });

  it('les blancs, retours à la ligne, tabulations et espaces insécables sont ignorés à la lecture', async () => {
    const d = sampleDesc();
    const code = await encodeSignalCode('answer', d);
    const mangled = `  \n${cleanCode(code).replace(/(.{7})/g, '$1\r\n\t ')} \n`;
    expect(await decodeSignalCode(mangled, 'answer')).toEqual(d);
  });

  it('une somme de contrôle fausse (un caractère modifié n\'importe où) donne badCode', async () => {
    const clean = cleanCode(await encodeSignalCode('invite', sampleDesc()));
    for (const i of [3, 10, Math.floor(clean.length / 2), clean.length - 5, clean.length - 1]) {
      const flipped = clean.slice(0, i) + (clean[i] === 'A' ? 'B' : 'A') + clean.slice(i + 1);
      const e = await rejection(decodeSignalCode(flipped, 'invite'));
      expect(e.code).toBe('badCode');
    }
  });

  it('un code tronqué ou rallongé donne badCode', async () => {
    const clean = cleanCode(await encodeSignalCode('invite', sampleDesc()));
    for (const bad of [clean.slice(0, clean.length - 1), clean.slice(0, 40), clean + 'A', clean.slice(1), 'V1O', 'V1OAAAA', 'V1OAAAAAAAA']) {
      expect((await rejection(decodeSignalCode(bad, 'invite'))).code).toBe('badCode');
    }
  });

  it('autre version du format : wrongVersion (avant même la somme de contrôle)', async () => {
    const clean = cleanCode(await encodeSignalCode('invite', sampleDesc()));
    for (const v of ['V2', 'V0', 'V10', 'V99']) {
      const e = await rejection(decodeSignalCode(v + clean.slice(2), 'invite'));
      expect(e.code).toBe('wrongVersion');
    }
  });

  it('genre inversé : une réponse collée à la place d\'une invitation (et l\'inverse) donne badCode', async () => {
    const d = sampleDesc();
    const invite = await encodeSignalCode('invite', d);
    const answer = await encodeSignalCode('answer', d);
    const a = await rejection(decodeSignalCode(answer, 'invite'));
    const b = await rejection(decodeSignalCode(invite, 'answer'));
    expect(a.code).toBe('badCode');
    expect(a.message).toMatch(/réponse/);
    expect(b.code).toBe('badCode');
    expect(b.message).toMatch(/invitation/);
    // et un genre inconnu
    expect((await rejection(decodeSignalCode('V1X' + cleanCode(invite).slice(3), 'invite'))).code).toBe('badCode');
  });

  it('entrées absurdes : vide, blancs, texte quelconque, URL, trop long, non chaîne', async () => {
    for (const bad of ['', '   \n  ', 'bonjour', 'https://example.org/?code=V1O', 'V', 'VO1AAAA', '{"u":"x"}', 'V1O' + '!'.repeat(40), 'V1O' + 'A'.repeat(NET.CODE_MAX_CHARS)]) {
      expect((await rejection(decodeSignalCode(bad, 'invite'))).code).toBe('badCode');
    }
    expect((await rejection(decodeSignalCode(undefined as unknown as string, 'invite'))).code).toBe('badCode');
    expect((await rejection(decodeSignalCode('A'.repeat(NET.CODE_MAX_CHARS * 5), 'invite'))).code).toBe('badCode');
  });

  it('pire cas (champs les plus longs, sans compression) : le code tient sous CODE_MAX_CHARS, quitte à abandonner les candidats les moins prioritaires', async () => {
    const d = sampleDesc({
      pwd: 'p'.repeat(256),
      ufrag: 'u'.repeat(256),
      candidates: Array.from({ length: RTC_MAX_CANDIDATES }, (_, i) => ({ foundation: 'f'.repeat(32), priority: 4294967295 - i, address: String(i).repeat(1) + 'a'.repeat(254), port: 65535, type: 'srflx' as const })),
    });
    const code = await encodeSignalCode('invite', d, { compress: false });
    expect(cleanCode(code).length).toBeLessThanOrEqual(NET.CODE_MAX_CHARS);
    const back = await decodeSignalCode(code, 'invite');
    expect(back.candidates.length).toBeGreaterThan(0);
    expect(back.candidates).toEqual(d.candidates.slice(0, back.candidates.length)); // les plus prioritaires d'abord
    expect({ ...back, candidates: [] }).toEqual({ ...d, candidates: [] });
  });

  /** Fabrique un code VALIDE (somme comprise) autour d'une charge utile arbitraire : prouve que la validation de contenu fait son travail. */
  function forge(payloadJson: string, flag = 0, kind: 'O' | 'A' = 'O'): string {
    const raw = new TextEncoder().encode(payloadJson);
    const body = new Uint8Array(raw.length + 1);
    body[0] = flag;
    body.set(raw, 1);
    const head = `V1${kind}${bytesToBase64Url(body)}`;
    return head + codeChecksum(head);
  }

  it('contenu invalide mais bien emballé : chaque champ est validé (aucune injection possible dans le SDP)', async () => {
    const good = JSON.parse(descToPayload(sampleDesc())) as Record<string, unknown>;
    expect(await decodeSignalCode(forge(JSON.stringify(good)), 'invite')).toEqual(sampleDesc());
    const patches: Record<string, unknown>[] = [
      { u: 'abc\r\nm=audio 9 RTP/AVP 0' },
      { u: 'a' },
      { u: 5 },
      { p: 'court' },
      { p: 'p'.repeat(300) },
      { p: 'mot de passe avec espaces!!' },
      { f: 'AAAA' },
      { f: 5 },
      { s: 'z' },
      { s: '__proto__' },
      { m: 'x y' },
      { m: '0\r\na=evil' },
      { o: 0 },
      { o: 70000 },
      { o: 1.5 },
      { z: 0 },
      { z: -5 },
      { c: [] },
      { c: 'x' },
      { c: Array.from({ length: RTC_MAX_CANDIDATES + 5 }, () => ['1', 1, '10.0.0.1', 4000, 'h']) },
      { c: [['1', 1, '10.0.0.1 evil', 4000, 'h']] },
      { c: [['1', 1, '10.0.0.1\nm=audio', 4000, 'h']] },
      { c: [['1\n', 1, '10.0.0.1', 4000, 'h']] },
      { c: [['1', 1, '10.0.0.1', 0, 'h']] },
      { c: [['1', 1, '10.0.0.1', 70000, 'h']] },
      { c: [['1', -1, '10.0.0.1', 4000, 'h']] },
      { c: [['1', 1, '10.0.0.1', 4000, 'z']] },
      { c: [['1', 1, '10.0.0.1', 4000, 'constructor']] },
      { c: [['1', 1, '10.0.0.1', 4000]] },
      { c: [{ foundation: '1' }] },
    ];
    for (const patch of patches) {
      const e = await rejection(decodeSignalCode(forge(JSON.stringify({ ...good, ...patch })), 'invite'));
      expect(e.code, JSON.stringify(patch)).toBe('badCode');
    }
    for (const key of ['u', 'p', 'f', 's', 'm', 'o', 'z', 'c']) {
      const o = { ...good };
      delete o[key];
      expect((await rejection(decodeSignalCode(forge(JSON.stringify(o)), 'invite'))).code).toBe('badCode');
    }
  });

  it('charge utile qui n\'est pas un objet JSON, UTF-8 invalide, indicateur inconnu : badCode', async () => {
    for (const payload of ['null', '[]', '42', '"texte"', 'pas du json', '{']) {
      expect((await rejection(decodeSignalCode(forge(payload), 'invite'))).code).toBe('badCode');
    }
    expect((await rejection(decodeSignalCode(forge(JSON.stringify(JSON.parse(descToPayload(sampleDesc()))), 2), 'invite'))).code).toBe('badCode');
    const head = `V1O${bytesToBase64Url(new Uint8Array([0, 0xff, 0xfe, 0xfd]))}`;
    expect((await rejection(decodeSignalCode(head + codeChecksum(head), 'invite'))).code).toBe('badCode');
  });

  it('payloadToDesc : ne lit que des champs propres (pas de prototype hérité)', () => {
    expect(payloadToDesc(Object.create(JSON.parse(descToPayload(sampleDesc()))))).toBeNull();
    expect(payloadToDesc(null)).toBeNull();
    expect(payloadToDesc([])).toBeNull();
  });

  const compressionAvailable = typeof (globalThis as { CompressionStream?: unknown }).CompressionStream === 'function';

  it.skipIf(!compressionAvailable)('bombe de décompression : une charge utile gigantesque est refusée sans tout décompresser', async () => {
    const zeros = new Uint8Array(1024 * 1024); // 1 Mio de zéros, compressés en environ 1 Ko
    const stream = new Blob([zeros]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    const packed = new Uint8Array(await new Response(stream).arrayBuffer());
    expect(packed.length).toBeLessThan(NET.CODE_MAX_CHARS / 2);
    const body = new Uint8Array(packed.length + 1);
    body[0] = 1;
    body.set(packed, 1);
    const head = `V1O${bytesToBase64Url(body)}`;
    const code = head + codeChecksum(head);
    expect(code.length).toBeLessThanOrEqual(NET.CODE_MAX_CHARS);
    expect((await rejection(decodeSignalCode(code, 'invite'))).code).toBe('badCode');
  });

  it.skipIf(!compressionAvailable)('charge compressée corrompue : badCode', async () => {
    const body = new Uint8Array([1, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const head = `V1O${bytesToBase64Url(body)}`;
    expect((await rejection(decodeSignalCode(head + codeChecksum(head), 'invite'))).code).toBe('badCode');
  });

  it('par défaut le code n\'est JAMAIS compressé (l\'émetteur ignore les capacités du lecteur) : indicateur 0, lisible sans DecompressionStream', async () => {
    const original = (globalThis as { DecompressionStream?: unknown }).DecompressionStream;
    const d = sampleDesc({ candidates: Array.from({ length: 6 }, (_, i) => ({ foundation: String(i), priority: 1000 - i, address: `10.0.0.${i + 1}`, port: 4000 + i, type: 'host' as const })) });
    const clean = cleanCode(await encodeSignalCode('invite', d));
    const body = base64UrlToBytes(clean.slice(3, -4));
    expect(body?.[0]).toBe(0);
    try {
      (globalThis as { DecompressionStream?: unknown }).DecompressionStream = undefined;
      expect(await decodeSignalCode(clean, 'invite')).toEqual(d);
    } finally {
      (globalThis as { DecompressionStream?: unknown }).DecompressionStream = original;
    }
  });

  it('code compressé lu sans DecompressionStream : « autre version » (pas « WebRTC non pris en charge »)', async () => {
    const original = (globalThis as { DecompressionStream?: unknown }).DecompressionStream;
    const clean = await encodeSignalCode('invite', sampleDesc({ candidates: Array.from({ length: 6 }, (_, i) => ({ foundation: String(i), priority: 1000 - i, address: `10.0.0.${i + 1}`, port: 4000 + i, type: 'host' as const })) }), { compress: true });
    try {
      (globalThis as { DecompressionStream?: unknown }).DecompressionStream = undefined;
      const body = base64UrlToBytes(cleanCode(clean).slice(3, -4));
      if (body && body[0] === 1) expect((await rejection(decodeSignalCode(clean, 'invite'))).code).toBe('wrongVersion');
      else expect(await decodeSignalCode(clean, 'invite')).toBeTruthy(); // pas de compression disponible dans cet environnement : le brut se lit
    } finally {
      (globalThis as { DecompressionStream?: unknown }).DecompressionStream = original;
    }
  });
});
