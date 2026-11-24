/**
 * Tests de la signalisation WebRTC manuelle avec de FAUSSES connexions (Node n'a pas de `RTCPeerConnection`) : déroulé complet hôte ↔ invité,
 * aucun serveur ICE par défaut, attente de la fin de la collecte, délais, annulation, codes invalides, échecs de connexion.
 * Un essai avec le vrai WebRTC n'est joué que si l'environnement le fournit.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Transport } from './contracts';
import { answerMatchesOffer, cleanCode, decodeSignalCode, encodeSignalCode, offerRef, parseSdp } from './rtcCodec';
import {
  RTC_GUEST_CONNECT_TIMEOUT_MS,
  RTC_HOST_CONNECT_TIMEOUT_MS,
  RTC_ICE_TIMEOUT_MS,
  RtcSignalingError,
  createRtcGuestSignaling,
  createRtcGuestSignalingWith,
  createRtcHostSignaling,
  createRtcHostSignalingWith,
  isRtcSupported,
  type RtcOptionsEx,
} from './rtcSignaling';
import { FakeRtcWorld, type FakeDataChannel, type FakePeerConnection } from './rtcTestKit';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Code d'erreur d'une promesse qui doit être rejetée par une `RtcSignalingError` ; « ok » si elle réussit. */
async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(RtcSignalingError);
    return (e as RtcSignalingError).code;
  }
  return 'ok';
}

function setup(world = new FakeRtcWorld(), options: RtcOptionsEx = {}) {
  const host = createRtcHostSignalingWith(() => world.env(), options);
  const guest = createRtcGuestSignalingWith(() => world.env(), options);
  return { world, host, guest };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setTimeout(r, 0));
}

describe('signalisation WebRTC : déroulé complet', () => {
  it("invitation → réponse → collage : les deux transports s'ouvrent et échangent du texte", async () => {
    const { world, host, guest } = setup();
    const invite = await host.createInvite();
    expect(invite.code).toMatch(/^V1O/);
    const answer = await guest.join(invite.code);
    expect(answer.answerCode).toMatch(/^V1A/);
    const hostTransport = await invite.accept(answer.answerCode);
    const guestTransport = await answer.transport;

    for (const t of [hostTransport, guestTransport]) {
      expect(t.kind).toBe('webrtc');
      expect(t.state).toBe('open');
    }
    const atHost: string[] = [];
    const atGuest: string[] = [];
    hostTransport.onMessage((s) => atHost.push(s));
    guestTransport.onMessage((s) => atGuest.push(s));
    guestTransport.send("de l'invité");
    hostTransport.send("de l'hôte");
    await settle();
    expect(atHost).toEqual(["de l'invité"]);
    expect(atGuest).toEqual(["de l'hôte"]);
    expect(world.pcs).toHaveLength(2);
  });

  it('aucun serveur ICE par défaut ; canal négocié, id 0, ordonné, créé des deux côtés', async () => {
    const { world, host, guest } = setup();
    const invite = await host.createInvite();
    await guest.join(invite.code);
    expect(world.pcs).toHaveLength(2);
    for (const pc of world.pcs) {
      expect(pc.config.iceServers).toEqual([]);
      expect(pc.channelInit).toEqual({ negotiated: true, id: 0, ordered: true });
    }
  });

  it('les serveurs ICE passés en option sont transmis (dépannage seulement)', async () => {
    const { world, host, guest } = setup(new FakeRtcWorld(), { iceServers: [{ urls: 'stun:stun.example.org:3478' }] });
    const invite = await host.createInvite();
    await guest.join(invite.code);
    expect(world.pcs.every((pc) => (pc.config.iceServers as { urls: string }[])[0].urls === 'stun:stun.example.org:3478')).toBe(true);
  });

  it('le code est exporté APRÈS la fin de la collecte ICE (il contient les candidats, même quand la collecte est lente)', async () => {
    const { host } = setup(new FakeRtcWorld({ candidates: 3, gatherDelayMs: 60 }));
    const invite = await host.createInvite();
    const desc = await decodeSignalCode(invite.code, 'invite');
    expect(desc.candidates).toHaveLength(3);
    expect(desc.setup).toBe('actpass');
  });

  it("un code de réponse porte le rôle DTLS « active » et les candidats de l'invité", async () => {
    const { host, guest } = setup(new FakeRtcWorld({ candidates: 2 }));
    const invite = await host.createInvite();
    const answer = await guest.join(invite.code);
    const desc = await decodeSignalCode(answer.answerCode, 'answer');
    expect(desc.setup).toBe('active');
    expect(desc.candidates).toHaveLength(2);
  });

  it("jusqu'à 3 invitations simultanées : un code par invité, chacune indépendante", async () => {
    const { world, host, guest } = setup();
    const invites = [await host.createInvite(), await host.createInvite(), await host.createInvite()];
    expect(new Set(invites.map((i) => cleanCode(i.code))).size).toBe(3);
    const answers = await Promise.all(invites.map((i) => guest.join(i.code)));
    const transports: Transport[] = [];
    for (let i = 0; i < 3; i++) transports.push(await invites[i].accept(answers[i].answerCode));
    expect(transports.every((t) => t.state === 'open')).toBe(true);
    expect(world.pcs).toHaveLength(6);
    // chaque liaison est isolée
    const got: string[][] = [[], [], []];
    transports.forEach((t, i) => t.onMessage((s) => got[i].push(s)));
    const guests = await Promise.all(answers.map((a) => a.transport));
    guests[1].send('seul le 2');
    await settle();
    expect(got).toEqual([[], ['seul le 2'], []]);
  });
});

describe('signalisation WebRTC : collecte ICE', () => {
  it('collecte sans aucun candidat → iceTimeout et connexion fermée', async () => {
    const { world, host } = setup(new FakeRtcWorld({ candidates: 0 }));
    expect(await code(host.createInvite())).toBe('iceTimeout');
    expect(world.pcs[0].closed).toBe(true);
  });

  it('collecte qui ne se termine jamais, sans candidat → iceTimeout après le délai', async () => {
    const { host } = setup(new FakeRtcWorld({ candidates: 0, gatherNever: true }), { iceTimeoutMs: 40 });
    const t0 = Date.now();
    expect(await code(host.createInvite())).toBe('iceTimeout');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(30);
  });

  it("collecte qui ne se termine jamais mais déjà des candidats → code exporté avec ce qu'on a, au délai", async () => {
    const { host } = setup(new FakeRtcWorld({ candidates: 2, gatherNever: true }), { iceTimeoutMs: 50 });
    const invite = await host.createInvite();
    expect((await decodeSignalCode(invite.code, 'invite')).candidates).toHaveLength(2);
  });

  it('invité : même comportement (iceTimeout sans candidat)', async () => {
    const hostWorld = new FakeRtcWorld();
    const invite = await createRtcHostSignalingWith(() => hostWorld.env()).createInvite();
    const guestWorld = new FakeRtcWorld({ candidates: 0 });
    const guest = createRtcGuestSignalingWith(() => guestWorld.env());
    expect(await code(guest.join(invite.code))).toBe('iceTimeout');
    expect(guestWorld.pcs[0].closed).toBe(true);
  });
});

describe('signalisation WebRTC : codes invalides', () => {
  it("l'invité refuse un code illisible, une réponse, un autre format", async () => {
    const { host, guest } = setup();
    const invite = await host.createInvite();
    const answer = await guest.join(invite.code);
    expect(await code(guest.join("n'importe quoi"))).toBe('badCode');
    expect(await code(guest.join(''))).toBe('badCode');
    expect(await code(guest.join(answer.answerCode))).toBe('badCode'); // une réponse à la place d'une invitation
    expect(await code(guest.join('V2' + cleanCode(invite.code).slice(2)))).toBe('wrongVersion');
    const flipped = cleanCode(invite.code);
    expect(await code(guest.join(flipped.slice(0, 30) + (flipped[30] === 'A' ? 'B' : 'A') + flipped.slice(31)))).toBe('badCode');
  });

  it("l'hôte refuse une invitation collée à la place de la réponse, sans « consommer » l'invitation", async () => {
    const { host, guest } = setup();
    const invite = await host.createInvite();
    const answer = await guest.join(invite.code);
    expect(await code(invite.accept(invite.code))).toBe('badCode');
    expect(await code(invite.accept('???'))).toBe('badCode');
    // la bonne réponse fonctionne encore
    const t = await invite.accept(answer.answerCode);
    expect(t.state).toBe('open');
  });

  it("la réponse porte l'empreinte de SON invitation ; la réponse à une AUTRE invitation est refusée (badCode) sans consommer l'invitation courante", async () => {
    const { host, guest } = setup();
    const first = await host.createInvite();
    const staleAnswer = await guest.join(first.code); // l'invité affiche encore cette réponse...
    first.cancel();
    const second = await host.createInvite(); // ...mais l'hôte a recréé une invitation
    const stale = await decodeSignalCode(staleAnswer.answerCode, 'answer');
    expect(stale.offerRef).toBe(offerRef(await decodeSignalCode(first.code, 'invite')));
    expect(answerMatchesOffer(stale, await decodeSignalCode(second.code, 'invite'))).toBe(false);
    expect(await code(second.accept(staleAnswer.answerCode))).toBe('badCode');
    // l'invitation n'a pas été consommée : la bonne réponse fonctionne encore
    const fresh = await guest.join(second.code);
    const t = await second.accept(fresh.answerCode);
    expect(t.state).toBe('open');
  });

  it("une réponse sans empreinte (code d'une autre génération) reste acceptée", async () => {
    const { host, guest } = setup();
    const invite = await host.createInvite();
    const answer = await guest.join(invite.code);
    const { offerRef: _ignored, ...legacy } = await decodeSignalCode(answer.answerCode, 'answer');
    const legacyCode = await encodeSignalCode('answer', legacy);
    expect((await decodeSignalCode(legacyCode, 'answer')).offerRef).toBeUndefined();
    const t = await invite.accept(legacyCode);
    expect(t.state).toBe('open');
  });

  it("une invitation ne s'accepte qu'une fois", async () => {
    const { host, guest } = setup();
    const invite = await host.createInvite();
    const answer = await guest.join(invite.code);
    await invite.accept(answer.answerCode);
    expect(await code(invite.accept(answer.answerCode))).toBe('failed');
  });

  it("un code bien emballé mais dont un champ est piégé est refusé par la validation du codec", async () => {
    const { guest } = setup();
    const desc = parseSdp(
      ['a=ice-ufrag:abcd', 'a=ice-pwd:0123456789abcdefghijklmn', `a=fingerprint:sha-256 ${'AA:'.repeat(31)}AA`, 'a=candidate:1 1 udp 100 10.0.0.1 4000 typ host'].join('\r\n'),
    );
    const bogus = await encodeSignalCode('invite', { ...desc, ufrag: 'a\r\nm=evil' }, { compress: false });
    expect(await code(guest.join(bogus))).toBe('badCode');
  });
});

describe('signalisation WebRTC : annulation et échecs', () => {
  it('cancel côté hôte : la connexion est fermée, accept rejette « cancelled »', async () => {
    const { world, host, guest } = setup();
    const invite = await host.createInvite();
    const answer = await guest.join(invite.code);
    invite.cancel();
    expect(world.pcs[0].closed).toBe(true);
    expect(await code(invite.accept(answer.answerCode))).toBe('cancelled');
    invite.cancel(); // idempotent
  });

  it("cancel côté invité : la promesse du transport rejette « cancelled », connexion fermée", async () => {
    const { world, host, guest } = setup();
    const invite = await host.createInvite();
    const answer = await guest.join(invite.code);
    answer.cancel();
    expect(await code(answer.transport)).toBe('cancelled');
    expect(world.pcs[1].closed).toBe(true);
  });

  it('une promesse de transport jamais attendue ne provoque aucune « rejection non gérée »', async () => {
    const unhandled: unknown[] = [];
    const on = (e: unknown): void => void unhandled.push(e);
    const proc = (globalThis as unknown as { process: { on(e: string, cb: (x: unknown) => void): void; off(e: string, cb: (x: unknown) => void): void } }).process;
    proc.on('unhandledRejection', on);
    try {
      const { host, guest } = setup();
      const invite = await host.createInvite();
      const answer = await guest.join(invite.code);
      answer.cancel();
      await settle();
    } finally {
      proc.off('unhandledRejection', on);
    }
    expect(unhandled).toEqual([]);
  });

  it('échec de la connexion pair à pair → « failed » des deux côtés', async () => {
    const { host, guest } = setup(new FakeRtcWorld({ failConnect: true }));
    const invite = await host.createInvite();
    const answer = await guest.join(invite.code);
    expect(await code(invite.accept(answer.answerCode))).toBe('failed');
    expect(await code(answer.transport)).toBe('failed');
  });

  it('délai de connexion dépassé → « failed »', async () => {
    const { host, guest } = setup(new FakeRtcWorld({ neverConnect: true }), { connectTimeoutMs: 40 });
    const invite = await host.createInvite();
    const answer = await guest.join(invite.code);
    expect(await code(invite.accept(answer.answerCode))).toBe('failed');
    expect(await code(answer.transport)).toBe('failed');
  });

  it("délais par défaut : l'hôte attend peu après le collage, l'invité laisse le temps de copier le code", () => {
    expect(RTC_ICE_TIMEOUT_MS).toBe(4000);
    expect(RTC_HOST_CONNECT_TIMEOUT_MS).toBeLessThan(RTC_GUEST_CONNECT_TIMEOUT_MS);
  });

  it("échec de la création de l'offre → « failed » (message de l'erreur d'origine conservé)", async () => {
    const world = new FakeRtcWorld();
    const env = world.env();
    const host = createRtcHostSignalingWith(() => ({
      createPeerConnection: (c) => {
        const pc = env.createPeerConnection(c) as unknown as FakePeerConnection;
        pc.createOffer = () => Promise.reject(new Error('plantage navigateur'));
        return pc;
      },
    }));
    try {
      await host.createInvite();
      throw new Error('rejet attendu');
    } catch (e) {
      expect(e).toBeInstanceOf(RtcSignalingError);
      expect((e as RtcSignalingError).code).toBe('failed');
      expect((e as RtcSignalingError).message).toContain('plantage navigateur');
    }
    expect(world.pcs[0].closed).toBe(true);
  });

  it("canal fermé avant l'ouverture → « failed »", async () => {
    const world = new FakeRtcWorld({ neverConnect: true });
    const { host, guest } = setup(world, { connectTimeoutMs: 5000 });
    const invite = await host.createInvite();
    const answer = await guest.join(invite.code);
    const pending = invite.accept(answer.answerCode);
    await settle();
    (world.pcs[0].channel as FakeDataChannel).close();
    expect(await code(pending)).toBe('failed');
  });
});

describe('signalisation WebRTC : environnement', () => {
  it('sans RTCPeerConnection : unsupported', async () => {
    vi.stubGlobal('RTCPeerConnection', undefined);
    expect(isRtcSupported()).toBe(false);
    expect(await code(createRtcHostSignaling().createInvite())).toBe('unsupported');
    expect(await code(createRtcGuestSignaling().join('V1OAAAA'))).toBe('unsupported');
  });

  it('avec un RTCPeerConnection global : isRtcSupported', () => {
    vi.stubGlobal('RTCPeerConnection', class {});
    expect(isRtcSupported()).toBe(true);
  });

  it('RtcSignalingError : porte son code et un message lisible', () => {
    const e = new RtcSignalingError('badCode', 'somme de contrôle');
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('badCode');
    expect(e.name).toBe('RtcSignalingError');
    expect(e.message).toBe('badCode: somme de contrôle');
    expect(new RtcSignalingError('cancelled').message).toBe('cancelled');
  });
});

const hasRealRtc = typeof (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection === 'function';

describe.skipIf(!hasRealRtc)('signalisation WebRTC : vraie pile (si disponible)', () => {
  it('deux connexions réelles se joignent par codes copiés-collés', async () => {
    const host = createRtcHostSignaling({ iceTimeoutMs: 5000 });
    const guest = createRtcGuestSignaling({ iceTimeoutMs: 5000 });
    const invite = await host.createInvite();
    const answer = await guest.join(invite.code);
    const [h, g] = await Promise.all([invite.accept(answer.answerCode), answer.transport]);
    const got: string[] = [];
    h.onMessage((s) => got.push(s));
    g.send('réel');
    await vi.waitFor(() => expect(got).toEqual(['réel']), { timeout: 3000 });
    g.close();
    h.close();
  }, 20000);
});
