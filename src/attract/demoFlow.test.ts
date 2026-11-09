import { describe, expect, it } from 'vitest';
import { ATTRACT_INPUT_FADE_MS, ATTRACT_RETURN_GRACE_MS, ATTRACT_TIMEOUT_FADE_MS } from './config';
import { BLINK_PERIOD_MS, DemoFlow, blinkVisible, demoPromptKey, graceActive, graceUntil } from './demoFlow';

describe('DemoFlow : fin de durée', () => {
  it('s\'arrête exactement à la durée, avec le fondu long, une seule fois', () => {
    const flow = new DemoFlow(30_000);
    for (let i = 0; i < 1799; i++) expect(flow.update(1000 / 60, false)).toBeNull();
    expect(flow.exit).toBeNull();
    let exit = null;
    for (let i = 0; i < 5 && !exit; i++) exit = flow.update(1000 / 60, false);
    expect(exit).toEqual({ reason: 'timeout', fadeMs: ATTRACT_TIMEOUT_FADE_MS });
    expect(flow.update(1000, false)).toBeNull(); // décidée une seule fois
    expect(flow.exit?.reason).toBe('timeout');
  });

  it('le temps est compté en temps réel (dt), plafonné pour une image très longue', () => {
    const flow = new DemoFlow(1000);
    flow.update(10_000, false); // image géante (machine saturée) : plafonnée à 250 ms
    expect(flow.elapsedMs).toBe(250);
    expect(flow.exit).toBeNull();
    flow.update(Number.NaN, false);
    flow.update(-5, false);
    expect(flow.elapsedMs).toBe(250);
  });

  it('expose le temps restant', () => {
    const flow = new DemoFlow(10_000);
    flow.update(200, false);
    expect(flow.remainingMs).toBe(9800);
  });
});

describe('DemoFlow : interruption par le joueur', () => {
  it('toute activité interrompt immédiatement, avec le fondu court', () => {
    const flow = new DemoFlow(30_000);
    flow.update(100, false);
    const exit = flow.update(16, true);
    expect(exit).toEqual({ reason: 'input', fadeMs: ATTRACT_INPUT_FADE_MS });
    expect(ATTRACT_INPUT_FADE_MS).toBeLessThan(ATTRACT_TIMEOUT_FADE_MS);
  });

  it('l\'action l\'emporte sur la fin de durée quand elles arrivent ensemble', () => {
    const flow = new DemoFlow(100);
    expect(flow.update(250, true)?.reason).toBe('input');
  });

  it('interrupt() (action pendant le fondu du menu) : sortie dès le premier appel', () => {
    const flow = new DemoFlow(30_000);
    expect(flow.interrupt()?.reason).toBe('input');
    expect(flow.exit?.reason).toBe('input');
    expect(flow.interrupt()).toBeNull();
  });

  it('une sortie décidée ne change plus (pas de double retour au menu)', () => {
    const flow = new DemoFlow(100);
    flow.update(250, false);
    expect(flow.exit?.reason).toBe('timeout');
    expect(flow.update(16, true)).toBeNull();
    expect(flow.interrupt()).toBeNull();
    expect(flow.exit?.reason).toBe('timeout');
  });
});

describe('clignotement', () => {
  it('cycle de 1 s : visible le début du cycle, caché la fin, périodique', () => {
    expect(blinkVisible(0)).toBe(true);
    expect(blinkVisible(600)).toBe(true);
    expect(blinkVisible(800)).toBe(false);
    expect(blinkVisible(999)).toBe(false);
    expect(blinkVisible(BLINK_PERIOD_MS)).toBe(true);
    expect(blinkVisible(5 * BLINK_PERIOD_MS + 100)).toBe(true);
  });

  it('la phase décale le cycle ; valeurs aberrantes : visible', () => {
    expect(blinkVisible(0, 700)).toBe(false);
    expect(blinkVisible(400, 700)).toBe(true);
    expect(blinkVisible(Number.NaN)).toBe(true);
    expect(blinkVisible(-100)).toBe(false); // -100 ≡ 900 dans le cycle
  });

  it('le libellé clignote vraiment (alterne visible / caché sur une seconde)', () => {
    let on = 0;
    let off = 0;
    for (let t = 0; t < BLINK_PERIOD_MS; t += 10) blinkVisible(t) ? on++ : off++;
    expect(on).toBeGreaterThan(0);
    expect(off).toBeGreaterThan(0);
  });
});

describe('fenêtre de grâce (entrée avalée au retour au menu)', () => {
  it('avale les entrées pendant ~400 ms puis les laisse passer', () => {
    const until = graceUntil(10_000);
    expect(until).toBe(10_000 + ATTRACT_RETURN_GRACE_MS);
    expect(graceActive(10_000, until)).toBe(true);
    expect(graceActive(10_399, until)).toBe(true);
    expect(graceActive(10_400, until)).toBe(false);
    expect(graceActive(20_000, until)).toBe(false);
  });

  it('sans retour de démo (null) : aucune entrée n\'est avalée', () => {
    expect(graceActive(0, null)).toBe(false);
  });
});

describe('demoPromptKey', () => {
  it("libellé « toucher l'écran » sur tactile, générique sinon", () => {
    expect(demoPromptKey(true)).toBe('attract.prompt.touch');
    expect(demoPromptKey(false)).toBe('attract.prompt');
  });
});
