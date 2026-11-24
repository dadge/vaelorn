/** Tests du transport Loopback : file / livraison, ordre, limites, fermeture, coupure, saturation, options de panne déterministes. */
import { describe, expect, it } from 'vitest';
import { NET, type CreateLoopbackPair, type TransportState } from './contracts';
import { createLoopbackPair } from './transportLoopback';

// Vérifie à la compilation que la fabrique respecte le type du contrat.
const _contract: CreateLoopbackPair = createLoopbackPair;
void _contract;

function collect(t: { onMessage(cb: (s: string) => void): unknown }): string[] {
  const got: string[] = [];
  t.onMessage((s) => got.push(s));
  return got;
}

describe('Loopback : mode file (par défaut)', () => {
  it('les deux extrémités sont ouvertes, de type loopback', () => {
    const p = createLoopbackPair();
    expect(p.a.state).toBe('open');
    expect(p.b.state).toBe('open');
    expect(p.a.kind).toBe('loopback');
    expect(p.a.maxMessageChars).toBe(NET.FRAGMENT_CHARS + 2048);
  });

  it('rien n\'est livré avant flush ; ordre conservé dans chaque sens', () => {
    const p = createLoopbackPair();
    const atB = collect(p.b);
    const atA = collect(p.a);
    p.a.send('1');
    p.b.send('x');
    p.a.send('2');
    p.a.send('3');
    expect(atB).toEqual([]);
    expect(p.pending()).toBe(4);
    expect(p.flush()).toBe(4);
    expect(atB).toEqual(['1', '2', '3']);
    expect(atA).toEqual(['x']);
    expect(p.pending()).toBe(0);
    expect(p.flush()).toBe(0);
  });

  it('un message envoyé pendant une livraison attend le flush suivant (pas de boucle infinie)', () => {
    const p = createLoopbackPair();
    const atA = collect(p.a);
    p.b.onMessage((s) => p.b.send(`écho:${s}`));
    p.a.send('salut');
    expect(p.flush()).toBe(1);
    expect(atA).toEqual([]);
    expect(p.flush()).toBe(1);
    expect(atA).toEqual(['écho:salut']);
  });

  it('refuse un message trop long ou non textuel, et un envoi sur un canal fermé', () => {
    const p = createLoopbackPair({ maxMessageChars: 10 });
    expect(() => p.a.send('x'.repeat(11))).toThrow(/trop long/);
    expect(() => p.a.send(5 as unknown as string)).toThrow();
    p.a.send('x'.repeat(10));
    p.a.close();
    expect(() => p.a.send('a')).toThrow(/fermé/);
  });

  it('close : l\'extrémité se ferme tout de suite, le pair après avoir reçu les messages déjà envoyés (une seule notification chacun)', () => {
    const p = createLoopbackPair();
    const logA: [TransportState, string | undefined][] = [];
    const logB: [TransportState, string | undefined][] = [];
    p.a.onState((s, r) => logA.push([s, r]));
    p.b.onState((s, r) => logB.push([s, r]));
    const atB = collect(p.b);
    p.a.send('dernier');
    p.a.close('fini');
    p.a.close('encore');
    expect(p.a.state).toBe('closed');
    expect(logA).toEqual([['closed', 'fini']]);
    expect(p.b.state).toBe('open'); // pas encore livré
    p.flush();
    expect(atB).toEqual(['dernier']);
    expect(p.b.state).toBe('closed');
    expect(logB).toEqual([['closed', 'fini']]);
    expect(() => p.b.send('trop tard')).toThrow();
  });

  it('un message qui arrive après la fermeture du destinataire est ignoré', () => {
    const p = createLoopbackPair();
    const atB = collect(p.b);
    p.a.send('perdu');
    p.b.close();
    p.flush();
    expect(atB).toEqual([]);
  });

  it('cut : coupure franche, les deux extrémités fermées, messages en vol perdus', () => {
    const p = createLoopbackPair();
    const states: string[] = [];
    p.a.onState((s, r) => states.push(`a:${s}:${r}`));
    p.b.onState((s, r) => states.push(`b:${s}:${r}`));
    const atB = collect(p.b);
    p.a.send('en vol');
    p.cut('wifi');
    expect(p.a.state).toBe('closed');
    expect(p.b.state).toBe('closed');
    expect(states).toEqual(['a:closed:wifi', 'b:closed:wifi']);
    p.flush();
    expect(atB).toEqual([]);
  });

  it('désabonnement : plus de rappel ; abonnement aux changements futurs seulement', () => {
    const p = createLoopbackPair();
    const got: string[] = [];
    const off = p.b.onMessage((s) => got.push(s));
    p.a.send('1');
    p.flush();
    off();
    p.a.send('2');
    p.flush();
    expect(got).toEqual(['1']);
    const states: string[] = [];
    p.a.close();
    p.a.onState((s) => states.push(s)); // déjà fermé : aucun rappel rétroactif
    expect(states).toEqual([]);
  });

  it('setBufferedAmount : les deux extrémités le rapportent ; jamais négatif', () => {
    const p = createLoopbackPair();
    expect(p.a.bufferedAmount).toBe(0);
    p.setBufferedAmount(300000);
    expect(p.a.bufferedAmount).toBe(300000);
    expect(p.b.bufferedAmount).toBe(300000);
    p.setBufferedAmount(-5);
    expect(p.a.bufferedAmount).toBe(0);
  });

  it('une exception d\'un rappel n\'empêche pas la livraison des autres messages, puis remonte', () => {
    const p = createLoopbackPair();
    const got: string[] = [];
    p.b.onMessage((s) => {
      if (s === 'boom') throw new Error('rappel en erreur');
      got.push(s);
    });
    p.a.send('1');
    p.a.send('boom');
    p.a.send('2');
    expect(() => p.flush()).toThrow('rappel en erreur');
    expect(got).toEqual(['1', '2']);
  });
});

describe('Loopback : mode synchrone', () => {
  it('livre dans send ; flush sans effet ; fermeture immédiate chez le pair', () => {
    const p = createLoopbackPair({ synchronous: true });
    const got = collect(p.b);
    const states: string[] = [];
    p.b.onState((s) => states.push(s));
    p.a.send('hop');
    expect(got).toEqual(['hop']);
    expect(p.flush()).toBe(0);
    expect(p.pending()).toBe(0);
    p.a.close();
    expect(p.b.state).toBe('closed');
    expect(states).toEqual(['closed']);
  });
});

describe('Loopback : pannes déterministes (tests de la couche protocole)', () => {
  it('filter : perte et duplication ciblées', () => {
    const p = createLoopbackPair({
      filter: ({ index }) => (index === 1 ? 'drop' : index === 2 ? 'duplicate' : 'deliver'),
    });
    const got = collect(p.b);
    for (const s of ['a', 'b', 'c', 'd']) p.a.send(s);
    p.flush();
    expect(got).toEqual(['a', 'c', 'c', 'd']);
  });

  it('filter reçoit l\'émetteur et le texte', () => {
    const seen: string[] = [];
    const p = createLoopbackPair({
      filter: ({ index, from, text }) => {
        seen.push(`${index}:${from}:${text}`);
        return 'deliver';
      },
    });
    p.a.send('x');
    p.b.send('y');
    expect(seen).toEqual(['0:a:x', '1:b:y']);
  });

  it('latencyFlushes : livraison au flush numéro N', () => {
    const p = createLoopbackPair({ latencyFlushes: 2 });
    const got = collect(p.b);
    p.a.send('lent');
    expect(p.flush()).toBe(0);
    expect(p.flush()).toBe(0);
    expect(got).toEqual([]);
    expect(p.flush()).toBe(1);
    expect(got).toEqual(['lent']);
    // un message envoyé plus tard garde son propre retard
    p.a.send('2');
    p.flush();
    p.flush();
    expect(got).toEqual(['lent']);
    p.flush();
    expect(got).toEqual(['lent', '2']);
  });

  it('reorderPending : la file est réordonnée selon la permutation (et seules les permutations valides sont admises)', () => {
    const p = createLoopbackPair();
    const got = collect(p.b);
    for (const s of ['1', '2', '3']) p.a.send(s);
    expect(p.pendingMessages().map((m) => m.text)).toEqual(['1', '2', '3']);
    p.reorderPending([2, 0, 1]);
    p.flush();
    expect(got).toEqual(['3', '1', '2']);
    p.a.send('z');
    expect(() => p.reorderPending([0, 0])).toThrow();
    expect(() => p.reorderPending([1])).toThrow();
    expect(() => p.reorderPending([5])).toThrow();
  });
});
