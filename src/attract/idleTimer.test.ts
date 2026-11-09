import { describe, expect, it } from 'vitest';
import { IdleTimer } from './idleTimer';

/** Horloge manuelle injectée. */
function makeClock(start = 1000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => void (t += ms) };
}

describe('IdleTimer : seuils exacts', () => {
  it('ne se déclenche pas avant le seuil, exactement au seuil, une seule fois', () => {
    const c = makeClock();
    const timer = new IdleTimer({ thresholdMs: 60_000, clock: c.now });
    c.advance(59_999);
    expect(timer.poll()).toBe(false);
    c.advance(1);
    expect(timer.poll()).toBe(true);
    c.advance(10_000);
    expect(timer.poll()).toBe(false); // déjà déclenchée : une seule fois
  });

  it('progresse par petits pas (60 images/s) et déclenche au bon instant', () => {
    const c = makeClock();
    const timer = new IdleTimer({ thresholdMs: 5000, clock: c.now });
    let firedAt = -1;
    for (let i = 1; i <= 400; i++) {
      c.advance(1000 / 60);
      if (timer.poll() && firedAt < 0) firedAt = i;
    }
    // 5000 ms / 16,67 ms = 300 images
    expect(firedAt).toBeGreaterThanOrEqual(299);
    expect(firedAt).toBeLessThanOrEqual(301);
  });

  it('expose le temps écoulé et restant', () => {
    const c = makeClock();
    const timer = new IdleTimer({ thresholdMs: 10_000, clock: c.now });
    c.advance(2500);
    expect(timer.elapsedMs).toBe(2500);
    expect(timer.remainingMs).toBe(7500);
  });

  it('un seuil invalide est ramené à 1 ms (jamais de déclenchement immédiat ni de NaN)', () => {
    const c = makeClock();
    const timer = new IdleTimer({ thresholdMs: Number.NaN, clock: c.now });
    expect(timer.poll()).toBe(false);
    c.advance(1);
    expect(timer.poll()).toBe(true);
  });
});

describe('IdleTimer : remise à zéro', () => {
  it('reset() à chaque activité repart de zéro', () => {
    const c = makeClock();
    const timer = new IdleTimer({ thresholdMs: 60_000, clock: c.now });
    c.advance(50_000);
    timer.reset();
    c.advance(50_000);
    expect(timer.poll()).toBe(false);
    c.advance(10_000);
    expect(timer.poll()).toBe(true);
  });

  it('reset() après le déclenchement réarme la minuterie', () => {
    const c = makeClock();
    const timer = new IdleTimer({ thresholdMs: 1000, clock: c.now });
    c.advance(1000);
    expect(timer.poll()).toBe(true);
    timer.reset();
    expect(timer.poll()).toBe(false);
    c.advance(1000);
    expect(timer.poll()).toBe(true);
  });
});

describe('IdleTimer : armement (écran-titre principal seulement)', () => {
  it('désarmée, elle ne compte pas et ne déclenche jamais', () => {
    const c = makeClock();
    const timer = new IdleTimer({ thresholdMs: 1000, clock: c.now, active: false });
    c.advance(1_000_000);
    expect(timer.poll()).toBe(false);
    expect(timer.elapsedMs).toBe(0);
  });

  it('armer remet le compteur à zéro : revenir d\'un sous-écran relance un compte complet', () => {
    const c = makeClock();
    const timer = new IdleTimer({ thresholdMs: 10_000, clock: c.now });
    c.advance(8000);
    timer.setActive(false); // ouverture d'un panneau / d'un dialogue
    c.advance(30_000);
    expect(timer.poll()).toBe(false);
    timer.setActive(true); // retour à l'écran-titre
    c.advance(9000);
    expect(timer.poll()).toBe(false);
    c.advance(1000);
    expect(timer.poll()).toBe(true);
  });

  it('setActive avec la même valeur ne remet rien à zéro', () => {
    const c = makeClock();
    const timer = new IdleTimer({ thresholdMs: 10_000, clock: c.now });
    c.advance(4000);
    timer.setActive(true);
    expect(timer.elapsedMs).toBe(4000);
  });
});

describe('IdleTimer : pause (onglet caché)', () => {
  it('le temps passé en pause n\'est pas compté, le reste est conservé', () => {
    const c = makeClock();
    const timer = new IdleTimer({ thresholdMs: 60_000, clock: c.now });
    c.advance(40_000);
    timer.setPaused(true); // onglet caché
    c.advance(10 * 60_000);
    expect(timer.poll()).toBe(false);
    timer.setPaused(false); // onglet de retour
    expect(timer.elapsedMs).toBe(40_000);
    c.advance(19_999);
    expect(timer.poll()).toBe(false);
    c.advance(1);
    expect(timer.poll()).toBe(true);
  });

  it('ne déclenche pas pendant la pause même si le seuil était déjà atteint', () => {
    const c = makeClock();
    const timer = new IdleTimer({ thresholdMs: 1000, clock: c.now });
    c.advance(1000);
    timer.setPaused(true);
    expect(timer.poll()).toBe(false);
    timer.setPaused(false);
    expect(timer.poll()).toBe(true);
  });
});

describe('IdleTimer : désactivation', () => {
  it('une minuterie jamais armée (démo désactivée : ?attract=0) ne se déclenche pas', () => {
    const c = makeClock();
    const timer = new IdleTimer({ thresholdMs: 5, clock: c.now, active: false });
    for (let i = 0; i < 100; i++) {
      c.advance(1000);
      expect(timer.poll()).toBe(false);
    }
  });
});
