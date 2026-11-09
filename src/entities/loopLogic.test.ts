import { describe, expect, it } from 'vitest';
import { SIM_STEP_MS } from '../core/constants';
import type { ActionFrame, TickInputs } from '../core/types';
import { MAX_FRAME_MS, MAX_STEPS_PER_FRAME, mergeTickInputs, planSteps } from './loopLogic';

const frame = (o: Partial<ActionFrame> = {}): ActionFrame => ({ moveX: 0, moveY: 0, attack: false, interact: false, revive: false, ...o });

describe('planSteps', () => {
  it('un pas exact consomme exactement SIM_STEP_MS', () => {
    const p = planSteps(0, SIM_STEP_MS);
    expect(p.steps).toBe(1);
    expect(p.accumulatorMs).toBeCloseTo(0, 6);
    expect(p.dropped).toBe(false);
  });

  it('affichage 144 Hz : souvent 0 pas, jamais plus de 1 sur la durée', () => {
    let acc = 0;
    let total = 0;
    const frames = 1440; // 10 s à 144 Hz
    for (let i = 0; i < frames; i++) {
      const p = planSteps(acc, 1000 / 144);
      acc = p.accumulatorMs;
      total += p.steps;
      expect(p.steps).toBeLessThanOrEqual(1);
      expect(p.alpha).toBeGreaterThanOrEqual(0);
      expect(p.alpha).toBeLessThanOrEqual(1);
    }
    expect(total).toBeGreaterThanOrEqual(598);
    expect(total).toBeLessThanOrEqual(601);
  });

  it('affichage 30 Hz : 2 pas par frame', () => {
    const p = planSteps(0, 1000 / 30);
    expect(p.steps).toBe(2);
  });

  it('plafonne à 5 pas par frame et abandonne le retard', () => {
    const p = planSteps(0, 200);
    expect(p.steps).toBe(MAX_STEPS_PER_FRAME);
    expect(p.dropped).toBe(true);
    expect(p.accumulatorMs).toBe(0);
  });

  it('un dt gigantesque (onglet caché) est plafonné', () => {
    const p = planSteps(0, 60_000);
    expect(p.steps).toBeLessThanOrEqual(MAX_STEPS_PER_FRAME);
    expect(MAX_FRAME_MS).toBeLessThanOrEqual(250);
  });

  it('dt négatif, NaN ou Infinity : aucun pas, jamais NaN', () => {
    for (const dt of [-5, Number.NaN, -Infinity]) {
      const p = planSteps(3, dt);
      expect(p.steps).toBe(0);
      expect(Number.isFinite(p.accumulatorMs)).toBe(true);
      expect(Number.isFinite(p.alpha)).toBe(true);
    }
    const q = planSteps(Number.NaN, 5);
    expect(Number.isFinite(q.accumulatorMs)).toBe(true);
  });

  it('l\'accumulateur reste dans [0, step)', () => {
    let acc = 0;
    for (let i = 0; i < 500; i++) {
      const p = planSteps(acc, 5 + (i % 13) * 3);
      acc = p.accumulatorMs;
      expect(acc).toBeGreaterThanOrEqual(0);
      expect(acc).toBeLessThan(SIM_STEP_MS + 1e-6);
    }
  });
});

describe('mergeTickInputs', () => {
  it('sans précédent : renvoie le nouveau relevé', () => {
    const next = { 0: frame({ attack: true }) } as const;
    expect(mergeTickInputs(null, next)).toBe(next);
  });

  it('un appui court (pressé puis relâché) est conservé', () => {
    const merged = mergeTickInputs({ 0: frame({ attack: true, moveX: 1 }) }, { 0: frame({ attack: false, moveX: 0 }) });
    expect(merged[0]?.attack).toBe(true);
    expect(merged[0]?.moveX).toBe(0); // les axes prennent la valeur la plus récente
  });

  it('le bouton spécial est fusionné en OU (constat 11)', () => {
    expect(mergeTickInputs({ 0: frame({ special: true }) }, { 0: frame({ special: false }) })[0]?.special).toBe(true);
    expect(mergeTickInputs({ 0: frame({ special: false }) }, { 0: frame({ special: true }) })[0]?.special).toBe(true);
    expect(mergeTickInputs({ 0: frame() }, { 0: frame() })[0]?.special).toBe(false);
    // special absent (undefined) sur l'un des deux relevés
    expect(mergeTickInputs({ 0: frame({ special: true }) }, { 0: frame() })[0]?.special).toBe(true);
  });

  it('le bouton « appeler » est fusionné en OU (appui court conservé)', () => {
    expect(mergeTickInputs({ 0: frame({ call: true }) }, { 0: frame({ call: false }) })[0]?.call).toBe(true);
    expect(mergeTickInputs({ 0: frame({ call: false }) }, { 0: frame({ call: true }) })[0]?.call).toBe(true);
    expect(mergeTickInputs({ 0: frame() }, { 0: frame() })[0]?.call).toBe(false);
    expect(mergeTickInputs({ 0: frame({ call: true }) }, { 0: frame() })[0]?.call).toBe(true);
  });

  it('combine chaque bouton indépendamment et chaque joueur séparément', () => {
    const merged = mergeTickInputs(
      { 0: frame({ interact: true }), 1: frame({ revive: true }) },
      { 0: frame({ revive: true }), 2: frame({ attack: true }) },
    );
    expect(merged[0]).toMatchObject({ interact: true, revive: true, attack: false });
    expect(merged[1]).toMatchObject({ revive: true });
    expect(merged[2]).toMatchObject({ attack: true });
  });
});

/** Rejoue la boucle de GameScene.update (fusion `latched` + planSteps + détection de front montant de la simulation). */
function simulateLoop(hz: number, button: 'attack' | 'interact' | 'revive' | 'special' | 'call', pressFrame: number, pressFrames: number, jitter = 0): number {
  let latched: TickInputs | null = null;
  let acc = 0;
  let prev = false;
  let risingEdges = 0;
  const frames = pressFrame + pressFrames + 30;
  for (let f = 0; f < frames; f++) {
    const down = f >= pressFrame && f < pressFrame + pressFrames;
    const cur: TickInputs = { 0: frame({ [button]: down }) };
    latched = mergeTickInputs(latched, cur);
    const dt = (1000 / hz) * (1 + (jitter > 0 ? jitter * Math.sin(f * 1.7) : 0));
    const plan = planSteps(acc, dt, SIM_STEP_MS, MAX_STEPS_PER_FRAME);
    acc = plan.accumulatorMs;
    for (let i = 0; i < plan.steps; i++) {
      const inputs = i === 0 ? (latched ?? cur) : cur;
      if (i === 0) latched = null;
      const held = inputs[0]?.[button] === true;
      if (held && !prev) risingEdges++;
      prev = held;
    }
  }
  return risingEdges;
}

describe('boucle simulée : un appui court est détecté une fois à 60/120/144/240 Hz', () => {
  const buttons = ['attack', 'interact', 'revive', 'special', 'call'] as const;
  for (const hz of [60, 75, 120, 144, 165, 240]) {
    for (const button of buttons) {
      it(`${button} à ${hz} Hz (un seul relevé à true)`, () => {
        for (const jitter of [0, 0.1]) {
          for (let start = 5; start < 25; start++) {
            expect(simulateLoop(hz, button, start, 1, jitter)).toBe(1);
          }
        }
      });
    }
    it(`special tenu 5 s à ${hz} Hz : un seul front montant, pas de rebond`, () => {
      expect(simulateLoop(hz, 'special', 10, hz * 5, 0.1)).toBe(1);
    });
  }
});
