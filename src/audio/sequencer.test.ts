import { describe, expect, it } from 'vitest';
import { buildLoopSequence, degreeToMidi, effectiveBpm, loopSeconds, midiToHz, type DrumEvent, type MusicEvent, type PitchedEvent, type VoiceId } from './sequencer';
import { CAVALCADE_DU_CRISTAL, MINOR_SCALE } from './theme';

const SEQ = buildLoopSequence();

/** FNV-1a 32 bits (même empreinte que celle calculée sur la référence theme.mjs). */
function fnv(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function voice(seq: { events: readonly MusicEvent[] }, v: VoiceId): MusicEvent[] {
  return seq.events.filter((e) => e.voice === v);
}

/** Empreinte d'une voix : temps et durées en TEMPS DE NOIRE, hauteur MIDI, vélocité (format de la référence). */
function voiceHash(events: MusicEvent[]): string {
  return fnv(
    events
      .map((e) =>
        e.voice === 'drums' ? `${e.beat.toFixed(4)}|${e.kind}|${e.vel.toFixed(3)}` : `${e.beat.toFixed(4)}|${e.beats.toFixed(4)}|${e.midi}|${e.vel.toFixed(3)}`,
      )
      .join(';'),
  );
}

describe('séquenceur : structure de la boucle', () => {
  it('16 mesures à 4 temps, 150 BPM : boucle de 25,6 s', () => {
    expect(CAVALCADE_DU_CRISTAL.score).toHaveLength(16);
    expect(SEQ.bars).toBe(16);
    expect(SEQ.beatsPerBar).toBe(4);
    expect(SEQ.loopBeats).toBe(64);
    expect(SEQ.bpm).toBe(150);
    expect(SEQ.loopSeconds).toBeCloseTo(25.6, 12);
    expect(SEQ.secondsPerBeat).toBeCloseTo(0.4, 12);
    expect(loopSeconds()).toBeCloseTo(25.6, 12);
  });

  it('la boucle dure un nombre entier d\'échantillons à 32, 44,1 et 48 kHz', () => {
    for (const sr of [32000, 44100, 48000]) {
      const samples = SEQ.loopSeconds * sr;
      expect(Math.abs(samples - Math.round(samples))).toBeLessThan(1e-6);
    }
  });

  it('nombre de notes par voix : 84 mélodie, 236 arpège, 127 basse, 130 percussions', () => {
    expect(voice(SEQ, 'melody')).toHaveLength(84);
    expect(voice(SEQ, 'arp')).toHaveLength(236);
    expect(voice(SEQ, 'bass')).toHaveLength(127);
    expect(voice(SEQ, 'drums')).toHaveLength(130);
    expect(SEQ.events).toHaveLength(577);
  });

  it('aucune note hors boucle : tout début dans [0, loopSeconds[, durées positives, vélocités dans ]0, 1]', () => {
    for (const e of SEQ.events) {
      expect(e.t).toBeGreaterThanOrEqual(0);
      expect(e.t).toBeLessThan(SEQ.loopSeconds);
      expect(e.vel).toBeGreaterThan(0);
      expect(e.vel).toBeLessThanOrEqual(1);
      if (e.voice !== 'drums') {
        expect(e.d).toBeGreaterThan(0);
        // la durée ÉCRITE reste dans sa mesure (les relâchements, eux, débordent et sont joués par-dessus la boucle suivante)
        expect(e.beat + e.beats).toBeLessThanOrEqual(SEQ.loopBeats + 1e-9);
      }
    }
  });

  it('événements triés par instant de début, de façon déterministe', () => {
    for (let i = 1; i < SEQ.events.length; i++) expect(SEQ.events[i].t).toBeGreaterThanOrEqual(SEQ.events[i - 1].t);
    expect(buildLoopSequence()).toEqual(SEQ);
  });

  it('boucle sans trou : aucun silence de plus d\'un temps entre deux débuts de notes, raccord fin → début compris', () => {
    const onsets = [...new Set(SEQ.events.map((e) => e.t))].sort((a, b) => a - b);
    let maxGap = 0;
    for (let i = 1; i < onsets.length; i++) maxGap = Math.max(maxGap, onsets[i] - onsets[i - 1]);
    // raccord : dernière attaque de la boucle n → première de la boucle n + 1
    maxGap = Math.max(maxGap, onsets[0] + SEQ.loopSeconds - onsets[onsets.length - 1]);
    expect(onsets[0]).toBe(0); // la boucle commence sur un coup (fanfare, basse, grosse caisse)
    expect(maxGap).toBeLessThanOrEqual(SEQ.secondsPerBeat + 1e-9);
  });

  it('la basse et les percussions couvrent la fin de boucle (mesure 16) : la boucle retombe sur la fanfare sans silence', () => {
    const lastBar = SEQ.loopSeconds - 4 * SEQ.secondsPerBeat;
    for (const v of ['bass', 'drums'] as const) {
      expect(voice(SEQ, v).some((e) => e.t >= lastBar && e.t < SEQ.loopSeconds)).toBe(true);
    }
    expect(voice(SEQ, 'bass')[0].t).toBe(0);
  });
});

describe('séquenceur : hauteurs', () => {
  it('midiToHz : la4 = 440 Hz, octave = ×2', () => {
    expect(midiToHz(69)).toBeCloseTo(440, 9);
    expect(midiToHz(81)).toBeCloseTo(880, 9);
    expect(midiToHz(60)).toBeCloseTo(261.6256, 3);
  });

  it('degreeToMidi : 1 = la4, 3 = do5, 8 = la5, 0 = sol4, -2 = mi4, sol# = degré 7 + 1', () => {
    expect(degreeToMidi(CAVALCADE_DU_CRISTAL, 1)).toBe(69);
    expect(degreeToMidi(CAVALCADE_DU_CRISTAL, 3)).toBe(72);
    expect(degreeToMidi(CAVALCADE_DU_CRISTAL, 8)).toBe(81);
    expect(degreeToMidi(CAVALCADE_DU_CRISTAL, 0)).toBe(67);
    expect(degreeToMidi(CAVALCADE_DU_CRISTAL, -2)).toBe(64);
    expect(degreeToMidi(CAVALCADE_DU_CRISTAL, 7, 1)).toBe(69 + 10 + 1);
    expect(degreeToMidi(CAVALCADE_DU_CRISTAL, 1, 0, 3)).toBe(72);
  });

  it('la fanfare mi4 - la4 - do5 - MI5 ouvre les mesures 1 et 9 (mélodie)', () => {
    const mel = voice(SEQ, 'melody') as PitchedEvent[];
    for (const bar of [0, 8]) {
      const t0 = bar * 4;
      const notes = mel.filter((e) => e.beat >= t0 && e.beat < t0 + 2.5 + 1e-9).slice(0, 4);
      expect(notes.map((n) => n.midi)).toEqual([64, 69, 72, 76]);
      expect(notes.map((n) => n.beat - t0)).toEqual([0, 0.5, 1, 1.5]);
      expect(notes[3].beats).toBe(2.5);
    }
    expect(mel[0].hz).toBeCloseTo(329.6276, 3);
  });

  it('toutes les notes de mélodie sont dans la gamme de la mineur (+ sol#) et dans l\'ambitus mi4..la5', () => {
    const mel = voice(SEQ, 'melody') as PitchedEvent[];
    for (const n of mel) {
      const pc = (((n.midi - 69) % 12) + 12) % 12; // demi-tons depuis la
      const inScale = MINOR_SCALE.includes(pc) || pc === 11; // 11 = sol# (sensible)
      expect(inScale, `midi ${n.midi}`).toBe(true);
      expect(n.midi).toBeGreaterThanOrEqual(64);
      expect(n.midi).toBeLessThanOrEqual(81);
    }
  });

  it('basse : fondamentale de l\'accord dans re2..do3 + octave ; arpège : dans re3..do#4 + deux octaves', () => {
    const bass = voice(SEQ, 'bass') as PitchedEvent[];
    expect(bass[0].midi).toBe(45); // la2 sur Am
    expect(bass[1].midi).toBe(57); // la3 (octave)
    for (const n of bass) {
      expect(n.midi).toBeGreaterThanOrEqual(38);
      expect(n.midi).toBeLessThanOrEqual(49 + 12);
    }
    for (const n of voice(SEQ, 'arp') as PitchedEvent[]) {
      expect(n.midi).toBeGreaterThanOrEqual(50);
      expect(n.midi).toBeLessThanOrEqual(61 + 19);
    }
    // mesure 2 sur Fa : fondamentale fa2 (41), mesure 3 sur Sol : sol2 (43)
    expect(bass.find((n) => n.beat === 4)?.midi).toBe(41);
    expect(bass.find((n) => n.beat === 8)?.midi).toBe(43);
  });

  it('transposition : +3 demi-tons décale toute la mélodie de 3 et ne change ni les temps ni les percussions', () => {
    const up = buildLoopSequence(CAVALCADE_DU_CRISTAL, { transpose: 3 });
    const a = voice(SEQ, 'melody') as PitchedEvent[];
    const b = voice(up, 'melody') as PitchedEvent[];
    expect(b).toHaveLength(a.length);
    a.forEach((n, i) => {
      expect(b[i].midi).toBe(n.midi + 3);
      expect(b[i].t).toBe(n.t);
    });
    expect(voice(up, 'drums')).toEqual(voice(SEQ, 'drums'));
  });

  it('tempo : 120 BPM → boucle de 32 s ; un tempo invalide retombe sur celui du thème', () => {
    expect(buildLoopSequence(CAVALCADE_DU_CRISTAL, { bpm: 120 }).loopSeconds).toBe(32);
    for (const bad of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) expect(effectiveBpm(CAVALCADE_DU_CRISTAL, bad)).toBe(150);
    expect(buildLoopSequence(CAVALCADE_DU_CRISTAL, { bpm: 0 }).loopSeconds).toBeCloseTo(25.6, 12);
  });
});

/**
 * PARITÉ avec le thème de référence (theme.mjs, hors dépôt) : empreintes calculées sur `compileTheme(THEME)` / `scheduleEvents(THEME)`
 * de la référence. Si ces tests échouent, le thème TypeScript ne joue plus les mêmes notes que le thème validé à l'oreille.
 */
describe('parité avec le thème de référence theme.mjs (D1, 150 BPM)', () => {
  it('somme des durées, première et dernière note de chaque voix', () => {
    const mel = voice(SEQ, 'melody') as PitchedEvent[];
    const arp = voice(SEQ, 'arp') as PitchedEvent[];
    const bass = voice(SEQ, 'bass') as PitchedEvent[];
    const drums = voice(SEQ, 'drums') as DrumEvent[];
    expect(mel.reduce((s, n) => s + n.beats, 0)).toBe(63.5);
    expect(arp.reduce((s, n) => s + n.beats, 0)).toBe(59);
    expect(bass.reduce((s, n) => s + n.beats, 0)).toBe(60.5);
    expect([mel[0].beat, mel[0].beats, mel[0].midi]).toEqual([0, 0.5, 64]);
    expect([mel[83].beat, mel[83].beats, mel[83].midi]).toEqual([63, 1, 68]);
    expect([arp[0].beat, arp[0].beats, arp[0].midi]).toEqual([1.5, 0.25, 57]);
    expect([arp[235].beat, arp[235].beats, arp[235].midi]).toEqual([63.75, 0.25, 59]);
    expect([bass[0].beat, bass[0].beats, bass[0].midi]).toEqual([0, 0.5, 45]);
    expect([bass[126].beat, bass[126].beats, bass[126].midi]).toEqual([63.5, 0.5, 52]);
    expect([drums[0].beat, drums[0].kind, drums[0].vel]).toEqual([0, 'kick', 1]);
    expect([drums[129].beat, drums[129].kind, drums[129].vel]).toEqual([63.75, 'snare', 0.95]);
  });

  it('empreinte de chaque voix (temps, durées, hauteurs, vélocités) identique à la référence', () => {
    expect(voiceHash(voice(SEQ, 'melody'))).toBe('d4c90ffa');
    expect(voiceHash(voice(SEQ, 'arp'))).toBe('47cb61df');
    expect(voiceHash(voice(SEQ, 'bass'))).toBe('f654a767');
    expect(voiceHash(voice(SEQ, 'drums'))).toBe('6952cc3d');
  });

  it('transpositions +3 et -5 : mêmes empreintes que compileTheme(THEME, { transpose }) de la référence', () => {
    const expected: Record<number, Record<VoiceId, string>> = {
      3: { melody: 'b03c2687', arp: 'ba75b492', bass: 'e95078d6', drums: '6952cc3d' },
      [-5]: { melody: '483b24e8', arp: '6d26be99', bass: '8879b9ce', drums: '6952cc3d' },
    };
    for (const tr of [3, -5]) {
      const s = buildLoopSequence(CAVALCADE_DU_CRISTAL, { transpose: tr });
      for (const v of ['melody', 'arp', 'bass', 'drums'] as const) expect(voiceHash(voice(s, v)), `${v} @${tr}`).toBe(expected[tr][v]);
    }
  });

  it('liste triée en SECONDES identique à scheduleEvents(THEME) de la référence (150 et 120 BPM)', () => {
    const line = (e: MusicEvent): string =>
      e.voice === 'drums'
        ? `${e.voice}|${e.t.toFixed(6)}|${(0).toFixed(6)}||${e.kind}|${e.vel.toFixed(3)}`
        : `${e.voice}|${e.t.toFixed(6)}|${e.d.toFixed(6)}|${e.midi}||${e.vel.toFixed(3)}`;
    expect(fnv(SEQ.events.map(line).join(';'))).toBe('688d8995');
    expect(fnv(buildLoopSequence(CAVALCADE_DU_CRISTAL, { bpm: 120 }).events.map(line).join(';'))).toBe('eccd9bd6');
  });
});

describe('thème : étiquette honnête', () => {
  it('tonalité « la mineur » (éclaircie en do majeur en partie B), titre et structure A B A\' C', () => {
    expect(CAVALCADE_DU_CRISTAL.key.label).toBe('la mineur');
    expect(CAVALCADE_DU_CRISTAL.name).toBe('Cavalcade du Cristal');
    expect(CAVALCADE_DU_CRISTAL.structure.map((s) => s.name)).toEqual(['A', 'B', "A'", 'C']);
    expect(CAVALCADE_DU_CRISTAL.score.map((b) => b.bar)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
  });
});
