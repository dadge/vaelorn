import { describe, expect, it } from 'vitest';
import { buildLoopSequence } from './sequencer';
import {
  DRUM_VARIANTS,
  LIMITER_KNEE,
  PULSE_HARMONICS,
  createMusicChain,
  envelopeLevel,
  envelopePoints,
  gateSeconds,
  getSynthAssets,
  mulberry32,
  onePoleCoefficient,
  pulseCoefficients,
  renderDrumHit,
  scheduleEvent,
  scheduleLoops,
  SAMPLE_START_BIAS,
  snapToSample,
  softClipCurve,
} from './musicSynth';
import { CAVALCADE_DU_CRISTAL, type Envelope } from './theme';
import { FakeContext, FakeGain, FakeSource } from '../testing/fakeAudioContext';

const T = CAVALCADE_DU_CRISTAL;
const SEQ = buildLoopSequence(T);

/** `envelope()` de la référence render.mjs (échantillonnée à la main). */
function referenceEnvelope(t: number, gateT: number, e: Envelope): number {
  const level = (x: number): number => {
    if (x < e.attack) return x / e.attack;
    if (e.decay > 0 && x < e.attack + e.decay) return 1 - ((1 - e.sustain) * (x - e.attack)) / e.decay;
    return e.sustain;
  };
  if (t < gateT) return level(t);
  const r = (t - gateT) / e.release;
  return r >= 1 ? 0 : level(gateT) * (1 - r);
}

/** Interpolation linéaire des points d'enveloppe (ce que fait WebAudio avec les rampes linéaires). */
function evalPoints(pts: ReadonlyArray<readonly [number, number]>, t: number): number {
  if (t <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (t <= pts[i][0]) {
      const [t0, v0] = pts[i - 1];
      const [t1, v1] = pts[i];
      return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
    }
  }
  return pts[pts.length - 1][1];
}

describe('enveloppes ADSR : identiques à la référence', () => {
  it('pour chaque voix et chaque durée de note du thème, les rampes reproduisent l\'enveloppe de référence', () => {
    for (const ch of [T.channels.melody, T.channels.arp, T.channels.bass]) {
      const durs = new Set(SEQ.events.filter((e) => e.voice !== 'drums').map((e) => e.d));
      for (const d of durs) {
        const gateT = gateSeconds(ch.env, ch.gate, d);
        const pts = envelopePoints(ch.env, gateT);
        for (let i = 1; i < pts.length; i++) expect(pts[i][0]).toBeGreaterThan(pts[i - 1][0]);
        expect(pts[0]).toEqual([0, 0]);
        expect(pts[pts.length - 1]).toEqual([gateT + ch.env.release, 0]);
        const end = gateT + ch.env.release + 0.01;
        for (let t = 0; t <= end; t += end / 400) {
          expect(Math.abs(evalPoints(pts, t) - referenceEnvelope(t, gateT, ch.env)), `t=${t} d=${d}`).toBeLessThan(0.02);
        }
      }
    }
  });

  it('gate : au moins attaque + 4 ms ; niveau de maintien atteint après décroissance', () => {
    const e = T.channels.melody.env;
    expect(gateSeconds(e, 0.92, 0.01)).toBeCloseTo(e.attack + 0.004, 12);
    expect(gateSeconds(e, 0.92, 1)).toBeCloseTo(0.92, 12);
    expect(envelopeLevel(1, e)).toBe(e.sustain);
    expect(envelopeLevel(0, e)).toBe(0);
    expect(envelopeLevel(e.attack, e)).toBe(1);
  });

  it('note plus courte que l\'attaque + décroissance : l\'enveloppe est coupée au niveau de la référence', () => {
    const e: Envelope = { attack: 0.01, decay: 0.2, sustain: 0.5, release: 0.05 };
    const pts = envelopePoints(e, 0.1);
    expect(pts.map((p) => p[0])).toEqual([0, 0.01, 0.1, 0.1 + 0.05]);
    expect(pts[2][1]).toBeCloseTo(1 - (0.5 * 0.09) / 0.2, 12);
    expect(pts[3][1]).toBe(0);
  });
});

describe('formes d\'onde', () => {
  it('impulsion 25 % : la série de Fourier reproduit +1,5 / -0,5 (moyenne nulle, amplitude de la référence)', () => {
    const { real, imag } = pulseCoefficients(0.25, PULSE_HARMONICS);
    expect(real).toHaveLength(PULSE_HARMONICS + 1);
    expect(real[0]).toBe(0);
    expect(imag[0]).toBe(0);
    const at = (phase: number): number => {
      let v = 0;
      for (let n = 1; n <= PULSE_HARMONICS; n++) v += real[n] * Math.cos(2 * Math.PI * n * phase) + imag[n] * Math.sin(2 * Math.PI * n * phase);
      return v;
    };
    expect(at(0.125)).toBeCloseTo(1.5, 1); // haut : 2 - 2D
    expect(at(0.625)).toBeCloseTo(-0.5, 1); // bas : -2D
    let mean = 0;
    for (let i = 0; i < 1000; i++) mean += at((i + 0.5) / 1000);
    expect(Math.abs(mean / 1000)).toBeLessThan(0.01);
  });

  it('impulsion 12,5 % : +1,75 / -0,25', () => {
    const { real, imag } = pulseCoefficients(0.125);
    const at = (phase: number): number => {
      let v = 0;
      for (let n = 1; n < real.length; n++) v += real[n] * Math.cos(2 * Math.PI * n * phase) + imag[n] * Math.sin(2 * Math.PI * n * phase);
      return v;
    };
    expect(at(0.0625)).toBeCloseTo(1.75, 1);
    expect(at(0.5)).toBeCloseTo(-0.25, 1);
  });

  it('carré (50 %) : harmoniques impaires seulement, 4 / (π n)', () => {
    const { real, imag } = pulseCoefficients(0.5, 9);
    expect(imag[1]).toBeCloseTo(4 / Math.PI, 6);
    expect(imag[3]).toBeCloseTo(4 / (3 * Math.PI), 6);
    expect(Math.abs(imag[2])).toBeLessThan(1e-6);
    for (let n = 1; n <= 9; n++) expect(Math.abs(real[n])).toBeLessThan(1e-6);
  });
});

describe('percussions : bruit déterministe', () => {
  it('même graine, mêmes échantillons ; graines différentes, bruits différents', () => {
    const a = renderDrumHit(T.channels.drums.kinds.snare, 32000, mulberry32(7));
    const b = renderDrumHit(T.channels.drums.kinds.snare, 32000, mulberry32(7));
    const c = renderDrumHit(T.channels.drums.kinds.snare, 32000, mulberry32(8));
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(a)).not.toEqual(Array.from(c));
  });

  it('durée = dur × fréquence d\'échantillonnage, attaque anti-clic (départ à 0), fin éteinte, amplitude bornée', () => {
    for (const [name, k] of Object.entries(T.channels.drums.kinds)) {
      const out = renderDrumHit(k, 32000, mulberry32(1));
      expect(out.length, name).toBe(Math.ceil(k.dur * 32000));
      expect(out[0], name).toBe(0);
      expect(Math.abs(out[out.length - 1]), name).toBeLessThan(0.02);
      let peak = 0;
      for (const v of out) peak = Math.max(peak, Math.abs(v));
      expect(peak, name).toBeLessThanOrEqual(k.vol + 1e-6);
      expect(peak, name).toBeGreaterThan(0.05);
    }
  });

  it('mulberry32 : suite dans [0, 1[ identique à la référence', () => {
    const r = mulberry32(0xa11ce + 1);
    const first = [r(), r(), r()];
    for (const v of first) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    const r2 = mulberry32(0xa11ce + 1);
    expect([r2(), r2(), r2()]).toEqual(first);
  });
});

describe('grille des échantillons', () => {
  it("snapToSample vise un quart d'échantillon SOUS l'échantillon le plus proche (mêmes échantillons à chaque boucle)", () => {
    expect(snapToSample(6.6000000000000005, 32000) * 32000).toBeCloseTo(211200 - SAMPLE_START_BIAS, 9);
    expect(snapToSample(0.05 + 25.6, 48000)).toBe((Math.round(25.65 * 48000) - SAMPLE_START_BIAS) / 48000);
    expect(Math.abs(snapToSample(1.23456789, 44100) - 1.23456789)).toBeLessThanOrEqual((0.5 + SAMPLE_START_BIAS) / 44100 + 1e-12);
  });

  it("départ DÉTERMINISTE : quel que soit l'arrondi du moteur (plafond, plus proche), chaque note de chaque boucle part au même échantillon", () => {
    // Régression : viser exactement l'échantillon k laissait l'erreur des flottants (k + epsilon) décider, et un arrondi au plafond
    // (Chrome) décalait une note sur cinquante d'un échantillon selon la boucle.
    for (const sr of [32000, 44100, 48000]) {
      const loopSamples = Math.round(SEQ.loopSeconds * sr);
      for (const t0 of [0, 0.05, 3.05]) {
        for (let n = 0; n < 4; n++) {
          for (const ev of SEQ.events) {
            const nominal = Math.round((t0 + ev.t) * sr) + n * loopSamples; // échantillon visé de la note, dans la boucle n
            const when = snapToSample(t0 + n * SEQ.loopSeconds + ev.t, sr);
            expect(Math.ceil(when * sr) + 0, `plafond, ${sr} Hz, boucle ${n}, t = ${ev.t}`).toBe(nominal);
            expect(Math.round(when * sr) + 0, `plus proche, ${sr} Hz, boucle ${n}, t = ${ev.t}`).toBe(nominal);
          }
        }
      }
    }
  });
});

describe('limiteur doux et filtre', () => {
  it('courbe : identité sous le seuil, monotone, sortie toujours < 1 (jamais d\'écrêtage)', () => {
    const c = softClipCurve();
    const n = c.length;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      if (Math.abs(x) <= LIMITER_KNEE) expect(c[i]).toBeCloseTo(x, 6);
      expect(Math.abs(c[i])).toBeLessThan(1);
      if (i > 0) expect(c[i]).toBeGreaterThanOrEqual(c[i - 1]);
    }
    expect(c[0]).toBeCloseTo(-c[n - 1], 6);
  });

  it('coefficient du passe-bas 1 pôle : e^(-2π f / sr), identique à la référence à 32 kHz', () => {
    expect(onePoleCoefficient(5200, 32000)).toBeCloseTo(Math.exp((-2 * Math.PI * 5200) / 32000), 12);
    expect(onePoleCoefficient(5200, 48000)).toBeGreaterThan(onePoleCoefficient(5200, 32000));
  });
});

describe('synthèse sur un faux AudioContext', () => {
  it('ressources par contexte : 2 formes d\'onde (25 % et 12,5 %), 3 types × variantes de percussions, mises en cache', () => {
    const ctx = new FakeContext();
    const a = getSynthAssets(ctx.asAudioContext(), T);
    expect(a.waves.size).toBe(2);
    expect(a.drums.kick).toHaveLength(DRUM_VARIANTS);
    expect(a.drums.snare).toHaveLength(DRUM_VARIANTS);
    expect(a.drums.hat).toHaveLength(DRUM_VARIANTS);
    expect(getSynthAssets(ctx.asAudioContext(), T)).toBe(a);
  });

  it('chaîne : bus → passe-bas IIR (1 pôle) → limiteur → ducking → maître → sortie ; dispose débranche tout', () => {
    const ctx = new FakeContext();
    const chain = createMusicChain(ctx.asAudioContext(), T, ctx.destination as unknown as AudioNode);
    const iir = ctx.nodes.find((n) => n.kind === 'iir') as unknown as { feedforward: number[]; feedback: number[] };
    expect(iir.feedback).toEqual([1, -onePoleCoefficient(5200, 48000)]);
    expect(iir.feedforward[0]).toBeCloseTo(1 - onePoleCoefficient(5200, 48000), 12);
    const shaper = ctx.nodes.find((n) => n.kind === 'shaper') as unknown as { curve: Float32Array };
    expect(shaper.curve.length).toBeGreaterThan(100);
    expect((chain.master as unknown as FakeGain).outputs).toContain(ctx.destination);
    chain.dispose();
    for (const n of ctx.nodes) expect(n.disconnected).toBe(true);
  });

  it('note de mélodie longue : oscillateur à la bonne fréquence, forme d\'onde à 25 %, vibrato ; note de basse : triangle sans vibrato', () => {
    const ctx = new FakeContext();
    const chain = createMusicChain(ctx.asAudioContext(), T);
    const fan = SEQ.events.find((e) => e.voice === 'melody' && e.beats === 2.5)!;
    scheduleEvent(ctx.asAudioContext(), chain, T, SEQ, fan, 1, 0);
    const osc = ctx.sources('oscillator');
    expect(osc).toHaveLength(2); // note + LFO du vibrato
    const note = osc[0];
    expect(note.startTimes[0]).toBeCloseTo(1, 4); // grille d'échantillons : à moins d'un échantillon (48 kHz) de l'instant demandé
    expect(Math.abs(note.startTimes[0] - 1)).toBeLessThan(1 / ctx.sampleRate);
    expect(note.frequency.events[0].value).toBeCloseTo(659.2551, 3); // mi5
    expect(note.wave).toBe(getSynthAssets(ctx.asAudioContext(), T).waves.get(0.25));
    const lfo = osc[1];
    expect(lfo.frequency.events[0].value).toBe(5.4);
    expect(Math.abs(lfo.startTimes[0] - 1.16)).toBeLessThan(1 / ctx.sampleRate); // delay 0,16 s
    expect((lfo.outputs[0] as FakeGain).outputs).toContain(note.detune); // le LFO module bien la hauteur (vibrato)
    const depth = (lfo.outputs[0] as FakeGain).gain.lastRamp();
    expect(depth?.value).toBeCloseTo(16, 9); // 0,16 demi-ton = 16 cents
    expect(Math.abs((depth?.time ?? 0) - (1.16 + 0.12))).toBeLessThan(1 / ctx.sampleRate);
    // gain de crête = volume × master × vélocité
    const peak = (note.outputs[0] as FakeGain).gain.events.find((e) => e.type === 'ramp');
    expect(peak?.value).toBeCloseTo(0.3 * 0.4, 9);

    const bass = SEQ.events.find((e) => e.voice === 'bass')!;
    const before = ctx.sources('oscillator').length;
    scheduleEvent(ctx.asAudioContext(), chain, T, SEQ, bass, 2, 0);
    const added = ctx.sources('oscillator').slice(before);
    expect(added).toHaveLength(1);
    expect(added[0].type).toBe('triangle');
    expect(added[0].frequency.events[0].value).toBeCloseTo(110, 6);
    expect(added[0].stopTimes[0]).toBeGreaterThan(2);
    // polarité inversée : le triangle de la référence démarre en descendant (celui de WebAudio monte)
    expect((added[0].outputs[0] as FakeGain).gain.events.find((e) => e.type === 'ramp')?.value).toBeCloseTo(-0.26 * 0.4, 9);
  });

  it('un arrêt naturel (onended) débranche les nœuds de la note ; kill arrête aussi les notes encore en cours', () => {
    const ctx = new FakeContext();
    const chain = createMusicChain(ctx.asAudioContext(), T);
    const live = new Set<{ kill(): void }>();
    const ev = SEQ.events.find((e) => e.voice === 'arp')!;
    scheduleEvent(ctx.asAudioContext(), chain, T, SEQ, ev, 0.5, 0, live as never);
    scheduleEvent(ctx.asAudioContext(), chain, T, SEQ, ev, 0.6, 0, live as never);
    expect(live.size).toBe(2);
    const [first, second] = ctx.sources('oscillator');
    first.onended?.();
    expect(live.size).toBe(1);
    expect(first.disconnected).toBe(true);
    for (const n of [...live]) n.kill();
    expect(second.disconnected).toBe(true);
    expect(second.stopTimes.length).toBeGreaterThan(1); // stop() forcé en plus du stop planifié
  });

  it('percussion : source tamponnée au gain volume × master × vélocité, variante choisie modulo', () => {
    const ctx = new FakeContext();
    const chain = createMusicChain(ctx.asAudioContext(), T);
    const kick = SEQ.events.find((e) => e.voice === 'drums' && e.kind === 'kick')!;
    scheduleEvent(ctx.asAudioContext(), chain, T, SEQ, kick, 3, 5);
    const src = ctx.sources('buffersource')[0];
    expect(src.startTimes).toHaveLength(1);
    expect(Math.abs(src.startTimes[0] - 3)).toBeLessThan(1 / ctx.sampleRate);
    const assets = getSynthAssets(ctx.asAudioContext(), T);
    expect(src.buffer).toBe(assets.drums.kick[5 % DRUM_VARIANTS]);
    expect((src.outputs[0] as FakeGain).gain.events[0].value).toBeCloseTo(0.42 * 0.4 * kick.vel, 9);
  });

  it('scheduleLoops : deux boucles = deux fois les événements, la boucle n + 1 commence exactement loopSeconds après la boucle n', () => {
    const ctx = new FakeContext();
    const chain = createMusicChain(ctx.asAudioContext(), T);
    scheduleLoops(ctx.asAudioContext(), chain, T, SEQ, 0.25, 2);
    const all = ctx.sources();
    expect(all.filter((s: FakeSource) => s.kind === 'buffersource')).toHaveLength(2 * 130);
    const bassStarts = all.filter((s) => s.kind === 'oscillator' && s.type === 'triangle').map((s) => s.startsAt);
    expect(bassStarts).toHaveLength(2 * 127);
    expect(bassStarts[127] - bassStarts[0]).toBeCloseTo(SEQ.loopSeconds, 9);
  });
});
