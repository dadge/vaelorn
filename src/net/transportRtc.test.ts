/** Tests de l'enveloppe `RtcTransport` autour d'un faux canal de données : états, envoi, messages binaires, saturation, fermeture. */
import { describe, expect, it } from 'vitest';
import { FakeDataChannel } from './rtcTestKit';
import { RTC_MAX_MESSAGE_CHARS, createRtcTransport } from './transportRtc';

describe('RtcTransport', () => {
  it('état : connecting → open → closed, chaque changement notifié une fois', () => {
    const dc = new FakeDataChannel();
    const t = createRtcTransport(dc);
    const log: string[] = [];
    t.onState((s, r) => log.push(`${s}:${r ?? ''}`));
    expect(t.state).toBe('connecting');
    expect(t.kind).toBe('webrtc');
    dc.open();
    expect(t.state).toBe('open');
    dc.close();
    expect(t.state).toBe('closed');
    expect(log).toEqual(['open:', 'closed:datachannel closed']);
  });

  it('un canal déjà ouvert à la création est open tout de suite', () => {
    const dc = new FakeDataChannel();
    dc.open();
    expect(createRtcTransport(dc).state).toBe('open');
  });

  it('send : refusé hors état open, trop long ou non textuel ; sinon transmis tel quel', () => {
    const dc = new FakeDataChannel();
    const t = createRtcTransport(dc);
    expect(() => t.send('x')).toThrow(/fermé/);
    dc.open();
    t.send('bonjour');
    expect(dc.sent).toEqual(['bonjour']);
    expect(() => t.send('x'.repeat(RTC_MAX_MESSAGE_CHARS + 1))).toThrow(/trop long/);
    expect(() => t.send(5 as unknown as string)).toThrow();
    t.send('x'.repeat(RTC_MAX_MESSAGE_CHARS));
    expect(t.maxMessageChars).toBe(RTC_MAX_MESSAGE_CHARS);
    expect(RTC_MAX_MESSAGE_CHARS).toBeLessThan(16384);
  });

  it('messages : seuls les textes sont livrés (le binaire est ignoré) ; désabonnement', () => {
    const dc = new FakeDataChannel();
    const t = createRtcTransport(dc);
    dc.open();
    const got: string[] = [];
    const off = t.onMessage((s) => got.push(s));
    dc.emit('message', { data: 'a' });
    dc.injectBinary();
    dc.emit('message', { data: 42 });
    dc.emit('message', {});
    dc.emit('message', { data: 'b' });
    off();
    dc.emit('message', { data: 'c' });
    expect(got).toEqual(['a', 'b']);
  });

  it('bufferedAmount : celui du canal, jamais négatif ni non fini', () => {
    const dc = new FakeDataChannel();
    const t = createRtcTransport(dc);
    expect(t.bufferedAmount).toBe(0);
    dc.bufferedAmount = 123456;
    expect(t.bufferedAmount).toBe(123456);
    dc.bufferedAmount = -3;
    expect(t.bufferedAmount).toBe(0);
    dc.bufferedAmount = Number.NaN;
    expect(t.bufferedAmount).toBe(0);
  });

  it('close : ferme le canal ET la connexion pair à pair, une seule notification, idempotent', () => {
    const dc = new FakeDataChannel();
    dc.open();
    let peerClosed = 0;
    const t = createRtcTransport(dc, { close: () => peerClosed++ });
    const log: string[] = [];
    t.onState((s, r) => log.push(`${s}:${r}`));
    t.close('fin');
    t.close('encore');
    expect(dc.readyState).toBe('closed');
    expect(peerClosed).toBe(1);
    expect(t.state).toBe('closed');
    expect(log).toEqual(['closed:datachannel closed']); // le canal annonce lui-même sa fermeture en premier
    expect(() => t.send('x')).toThrow();
  });

  it('markClosed : déclare le canal perdu (connexion échouée) avec une raison, une seule fois', () => {
    const dc = new FakeDataChannel();
    dc.open();
    const t = createRtcTransport(dc);
    const log: string[] = [];
    t.onState((s, r) => log.push(`${s}:${r}`));
    t.markClosed('ice failed');
    t.markClosed('autre');
    expect(log).toEqual(['closed:ice failed']);
    expect(t.state).toBe('closed');
    // les messages tardifs ne sont plus livrés
    const got: string[] = [];
    t.onMessage((s) => got.push(s));
    dc.emit('message', { data: 'tard' });
    expect(got).toEqual([]);
  });

  it('close avant l\'ouverture : fermé tout de suite', () => {
    const dc = new FakeDataChannel();
    const t = createRtcTransport(dc);
    t.close();
    expect(t.state).toBe('closed');
  });
});
