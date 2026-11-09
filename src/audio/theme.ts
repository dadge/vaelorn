/**
 * « Cavalcade du Cristal » : thème de la musique de fond de « Les Fragments de l'Aube », en DONNÉES PURES (aucun code audio ici).
 *
 * Thème ORIGINAL composé pour le projet (style « D, hybride B + C », variante D1 à 150 BPM, validée à l'oreille) : la mineur éclairé par
 * do majeur en partie B, 16 mesures à 4 temps, forme A B A' C (4 mesures chacune), fanfare mi-la-do-MI en signature aux mesures 1 et 9.
 * Aucun emprunt délibéré à un thème existant (vérification de ressemblance faite de mémoire : à confirmer à l'oreille).
 *
 * Unités : TEMPS de noire. Mélodie en DEGRÉS de la gamme de la mineur naturelle (1 = la4, 3 = do5, 8 = la5, 0 = sol4, -2 = mi4) plus une
 * altération en demi-tons (sol# = degré 7 + 1) ; basse et arpège en intervalles relatifs à la fondamentale de l'accord de la mesure.
 * Donc TRANSPOSABLE (`transpose`, en demi-tons) et à tempo paramétrable (`bpm`) sans toucher à la partition : voir `sequencer.ts`.
 *
 * Voix : `melody` (pulse 25 %), `arp` (pulse 12,5 % : arpège rapide qui tient le rôle de contre-chant), `bass` (triangle), `drums` (bruit).
 * Les paramètres de timbre (enveloppes, vibrato, mix) vivent ici aussi : `musicSynth.ts` les lit tels quels.
 *
 * Données portées depuis la partition de référence (theme.mjs) ; la parité exacte avec la référence est vérifiée par
 * `sequencer.test.ts` (empreintes de chaque voix).
 */

/** Gamme de la mineur naturelle (= do majeur : mêmes notes), en demi-tons depuis la tonique. */
export const MINOR_SCALE: readonly number[] = [0, 2, 3, 5, 7, 8, 10];

export type ChordQuality = 'maj' | 'min';
export type SectionId = 'A' | 'B' | "A'" | 'C';
export type BassPatternId = 'bounce' | 'bounceEnd' | 'bounceBreak' | 'skip' | 'gallop';
export type ArpPatternId = 'fan' | 'A' | 'B' | 'C' | 'break';
export type DrumPatternId = 'fan' | 'groove' | 'grooveB' | 'drive' | 'fill' | 'break' | 'fillBig';
export type DrumKind = 'kick' | 'snare' | 'hat';

/** Note de mélodie : [début dans la mesure (temps), durée (temps), degré de gamme, altération en demi-tons (défaut 0)]. */
export type MelodyNote = readonly [start: number, dur: number, degree: number, alter?: number];
/** Pas de basse : [début (temps), durée (temps), intervalle en demi-tons au-dessus de la fondamentale]. */
export type BassStep = readonly [start: number, dur: number, interval: number];
/** Coup de percussion : [début (temps), type, vélocité]. */
export type DrumStep = readonly [start: number, kind: DrumKind, vel: number];

export interface ThemeBar {
  /** Numéro de mesure (1-based). */
  bar: number;
  section: SectionId;
  /** Accord : [décalage de la fondamentale en demi-tons depuis la tonique, qualité]. */
  chord: readonly [rootOffset: number, quality: ChordQuality];
  bass: BassPatternId;
  arp: ArpPatternId;
  drums: DrumPatternId;
  melody: readonly MelodyNote[];
}

export interface Envelope {
  /** Secondes. */
  attack: number;
  decay: number;
  /** Niveau de maintien (0..1). */
  sustain: number;
  release: number;
}

export interface Vibrato {
  /** Hz. */
  rate: number;
  depthSemitones: number;
  /** Secondes avant l'entrée du vibrato. */
  delay: number;
  /** Durée minimale (temps) d'une note pour recevoir le vibrato. */
  minBeats: number;
}

export interface PulseChannel {
  type: 'pulse';
  /** Rapport cyclique (0..1). */
  duty: number;
  volume: number;
  /** Fraction de la durée écrite pendant laquelle la note est tenue (le reste = silence avant la note suivante). */
  gate: number;
  env: Envelope;
  vibrato?: Vibrato;
}

export interface TriangleChannel {
  type: 'triangle';
  volume: number;
  gate: number;
  env: Envelope;
}

export interface NoiseKind {
  /** Bruit à échantillonnage-maintien : fréquence de rafraîchissement de départ / d'arrivée (Hz). */
  rate0: number;
  rate1: number;
  /** Durée (s). */
  dur: number;
  vol: number;
  /** Puissance de la décroissance. */
  shape: number;
  /** Passe-bas propre au coup (Hz). */
  lp: number;
}

export interface NoiseChannel {
  type: 'noise';
  volume: number;
  kinds: Readonly<Record<DrumKind, NoiseKind>>;
}

export interface MusicTheme {
  name: string;
  /** Intitulé de la variante validée. */
  variant: string;
  bpm: number;
  beatsPerBar: number;
  bars: number;
  loopBeats: number;
  key: {
    /** Étiquette honnête de la tonalité. */
    label: string;
    /** Précision (partie B en do majeur, sensible). */
    note: string;
    /** Tonique de référence de la mélodie (MIDI) : la4. */
    tonicMidi: number;
    scale: readonly number[];
    /** La fondamentale de basse est placée dans [bassRange, bassRange + 11]. */
    bassRange: number;
    /** La fondamentale d'arpège est placée dans [arpRange, arpRange + 11]. */
    arpRange: number;
  };
  structure: readonly { name: SectionId; bars: readonly [number, number]; chords: string; note: string }[];
  /** Gain fixe appliqué à chaque voix, puis passe-bas doux (1 pôle) anti-stridence. */
  master: { gain: number; lowpassHz: number };
  channels: {
    melody: PulseChannel;
    arp: PulseChannel;
    bass: TriangleChannel;
    drums: NoiseChannel;
  };
  patterns: {
    bass: Readonly<Record<BassPatternId, readonly BassStep[]>>;
    /** 16 doubles-croches : indice dans [fond., tierce, quinte, fond.+8, tierce+8, quinte+8] ; null = silence. */
    arp: Readonly<Record<ArpPatternId, readonly (number | null)[]>>;
    drums: Readonly<Record<DrumPatternId, readonly DrumStep[]>>;
  };
  score: readonly ThemeBar[];
}

/** Tons de l'accord (demi-tons au-dessus de la fondamentale) : fondamentale, tierce, quinte, puis l'octave au-dessus. */
export const CHORD_TONES: Readonly<Record<ChordQuality, readonly number[]>> = {
  maj: [0, 4, 7, 12, 16, 19],
  min: [0, 3, 7, 12, 15, 19],
};

export const CAVALCADE_DU_CRISTAL: MusicTheme = {
  name: 'Cavalcade du Cristal',
  variant: 'D1 - cavalcade (150 BPM)',
  bpm: 150,
  beatsPerBar: 4,
  bars: 16,
  loopBeats: 64, // 16 mesures x 4 temps

  key: {
    label: 'la mineur',
    note: 'éclaircie en do majeur (relatif) en partie B ; seul pitch hors gamme : sol# (sensible de mi majeur, mesures 8 et 16 : présent dans mélodie, basse et arpège)',
    tonicMidi: 69, // la4
    scale: MINOR_SCALE,
    bassRange: 38, // re2..do3
    arpRange: 50, // re3..do#4
  },

  structure: [
    { name: 'A', bars: [1, 4], chords: 'Am F G Am', note: 'fanfare + motif, la mineur' },
    { name: 'B', bars: [5, 8], chords: 'C G F E', note: 'éclaircie en do majeur, pont qui retombe sur la dominante, break' },
    { name: "A'", bars: [9, 12], chords: 'Am F G Am', note: 'fanfare + motif, fin variée' },
    { name: 'C', bars: [13, 16], chords: 'Dm F G E', note: 'montée séquentielle, galop, dominante qui relance la boucle' },
  ],

  master: { gain: 0.4, lowpassHz: 5200 },

  channels: {
    melody: {
      type: 'pulse',
      duty: 0.25,
      volume: 0.3,
      gate: 0.92,
      env: { attack: 0.008, decay: 0.14, sustain: 0.78, release: 0.045 },
      vibrato: { rate: 5.4, depthSemitones: 0.16, delay: 0.16, minBeats: 1.5 },
    },
    arp: {
      type: 'pulse',
      duty: 0.125,
      volume: 0.17,
      gate: 0.78,
      env: { attack: 0.003, decay: 0.07, sustain: 0.45, release: 0.02 },
    },
    bass: {
      type: 'triangle',
      volume: 0.26,
      gate: 0.8,
      env: { attack: 0.004, decay: 0, sustain: 1, release: 0.02 },
    },
    drums: {
      type: 'noise',
      volume: 0.42,
      kinds: {
        kick: { rate0: 1500, rate1: 160, dur: 0.12, vol: 1, shape: 2, lp: 700 },
        snare: { rate0: 6500, rate1: 4200, dur: 0.12, vol: 0.55, shape: 2.2, lp: 5000 },
        hat: { rate0: 9000, rate1: 9000, dur: 0.035, vol: 0.3, shape: 2, lp: 5200 },
      },
    },
  },

  patterns: {
    bass: {
      bounce: [[0, .5, 0], [.5, .5, 12], [1, .5, 0], [1.5, .5, 12], [2, .5, 0], [2.5, .5, 12], [3, .5, 0], [3.5, .5, 12]],
      bounceEnd: [[0, .5, 0], [.5, .5, 12], [1, .5, 0], [1.5, .5, 12], [2, .5, 0], [2.5, .5, 12], [3, .5, 7], [3.5, .5, 12]],
      bounceBreak: [[0, .5, 0], [.5, .5, 12], [1, .5, 0], [1.5, .5, 12]],
      skip: [[0, .5, 0], [.5, .25, 0], [1, .5, 12], [1.5, .5, 7], [2, .5, 0], [2.5, .25, 0], [3, .5, 12], [3.5, .5, 7]],
      gallop: [[0, .5, 0], [.5, .5, 12], [1, .5, 0], [1.5, .5, 12], [2, .5, 0], [2.5, .5, 12], [3, .25, 0], [3.25, .25, 7], [3.5, .5, 12]],
    },
    arp: {
      fan: [null, null, null, null, null, null, 0, 1, 2, 3, 2, 1, 2, 1, 0, 1],
      A: [0, 1, 2, 1, 3, 2, 1, 2, 0, 1, 2, 1, 3, 2, 1, 2],
      B: [0, 2, 1, 3, 2, 3, 1, 2, 0, 2, 1, 3, 2, 3, 1, 2],
      C: [0, 1, 2, 3, 2, 3, 2, 1, 1, 2, 3, 4, 3, 2, 3, 2],
      break: [0, 1, 2, 3, 2, 1, 2, 1, null, null, null, null, null, null, null, null],
    },
    drums: {
      fan: [[0, 'kick', 1], [2, 'hat', .4], [3, 'snare', .5], [3.5, 'snare', .65]],
      groove: [[0, 'kick', 1], [.5, 'hat', .5], [1, 'snare', .75], [1.5, 'hat', .5], [2, 'kick', .9], [2.5, 'hat', .5], [3, 'snare', .75], [3.5, 'hat', .5]],
      grooveB: [[0, 'kick', 1], [.5, 'hat', .5], [1, 'snare', .75], [1.5, 'kick', .6], [2, 'kick', .9], [2.5, 'kick', .55], [3, 'snare', .75], [3.5, 'hat', .5]],
      drive: [[0, 'kick', 1], [.5, 'hat', .5], [1, 'snare', .8], [1.5, 'hat', .5], [2, 'kick', .95], [2.5, 'kick', .6], [3, 'snare', .8], [3.5, 'hat', .55]],
      fill: [[0, 'kick', 1], [.5, 'hat', .5], [1, 'snare', .75], [1.5, 'hat', .5], [2, 'kick', .9], [2.5, 'hat', .5], [3, 'snare', .6], [3.25, 'snare', .65], [3.5, 'snare', .75], [3.75, 'snare', .85]],
      break: [[0, 'kick', 1], [.5, 'hat', .5], [1, 'snare', .75], [1.5, 'hat', .5], [2, 'kick', 1], [2.5, 'snare', .55], [2.75, 'snare', .6], [3, 'snare', .7], [3.25, 'snare', .7], [3.5, 'snare', .8], [3.75, 'snare', .9]],
      fillBig: [[0, 'kick', 1], [.5, 'hat', .5], [1, 'snare', .75], [1.5, 'kick', .7], [2, 'kick', .95], [2.5, 'snare', .6], [2.75, 'snare', .65], [3, 'snare', .7], [3.25, 'snare', .75], [3.5, 'snare', .85], [3.75, 'snare', .95]],
    },
  },

  score: [
    // mesure 1 (A) : E4:.5 A4:.5 C5:.5 E5:2.5
    { bar: 1, section: 'A', chord: [0, 'min'], bass: 'bounce', arp: 'fan', drums: 'fan', melody: [[0, .5, -2], [.5, .5, 1], [1, .5, 3], [1.5, 2.5, 5]] },
    // mesure 2 (A) : A4:1.5 F5:.5 E5:.75 D5:.25 A4:1
    { bar: 2, section: 'A', chord: [8, 'maj'], bass: 'bounce', arp: 'A', drums: 'groove', melody: [[0, 1.5, 1], [1.5, .5, 6], [2, .75, 5], [2.75, .25, 4], [3, 1, 1]] },
    // mesure 3 (A) : B4:1.5 G5:.5 F5:.75 E5:.25 B4:1
    { bar: 3, section: 'A', chord: [10, 'maj'], bass: 'bounce', arp: 'A', drums: 'groove', melody: [[0, 1.5, 2], [1.5, .5, 7], [2, .75, 6], [2.75, .25, 5], [3, 1, 2]] },
    // mesure 4 (A) : C5:.75 B4:.25 A4:1.5 B4:.5 C5:.5 E5:.5
    { bar: 4, section: 'A', chord: [0, 'min'], bass: 'bounceEnd', arp: 'A', drums: 'fill', melody: [[0, .75, 3], [.75, .25, 2], [1, 1.5, 1], [2.5, .5, 2], [3, .5, 3], [3.5, .5, 5]] },
    // mesure 5 (B) : G5:1.5 E5:.5 D5:.75 C5:.25 E5:1
    { bar: 5, section: 'B', chord: [3, 'maj'], bass: 'skip', arp: 'B', drums: 'grooveB', melody: [[0, 1.5, 7], [1.5, .5, 5], [2, .75, 4], [2.75, .25, 3], [3, 1, 5]] },
    // mesure 6 (B) : F5:1.5 D5:.5 C5:.75 B4:.25 D5:1
    { bar: 6, section: 'B', chord: [10, 'maj'], bass: 'skip', arp: 'B', drums: 'grooveB', melody: [[0, 1.5, 6], [1.5, .5, 4], [2, .75, 3], [2.75, .25, 2], [3, 1, 4]] },
    // mesure 7 (B) : E5:1.5 C5:.5 A4:.75 G4:.25 A4:1
    { bar: 7, section: 'B', chord: [8, 'maj'], bass: 'skip', arp: 'B', drums: 'grooveB', melody: [[0, 1.5, 5], [1.5, .5, 3], [2, .75, 1], [2.75, .25, 0], [3, 1, 1]] },
    // mesure 8 (B) : B4:1 C5:.5 B4:.5 G#4:1.5
    { bar: 8, section: 'B', chord: [7, 'maj'], bass: 'bounceBreak', arp: 'break', drums: 'break', melody: [[0, 1, 2], [1, .5, 3], [1.5, .5, 2], [2, 1.5, 0, 1]] },
    // mesure 9 (A') : E4:.5 A4:.5 C5:.5 E5:2.5
    { bar: 9, section: "A'", chord: [0, 'min'], bass: 'bounce', arp: 'fan', drums: 'fan', melody: [[0, .5, -2], [.5, .5, 1], [1, .5, 3], [1.5, 2.5, 5]] },
    // mesure 10 (A') : A4:1.5 F5:.5 E5:.75 D5:.25 A4:1
    { bar: 10, section: "A'", chord: [8, 'maj'], bass: 'bounce', arp: 'A', drums: 'groove', melody: [[0, 1.5, 1], [1.5, .5, 6], [2, .75, 5], [2.75, .25, 4], [3, 1, 1]] },
    // mesure 11 (A') : B4:1.5 G5:.5 F5:.75 G5:.25 D5:1
    { bar: 11, section: "A'", chord: [10, 'maj'], bass: 'bounce', arp: 'A', drums: 'groove', melody: [[0, 1.5, 2], [1.5, .5, 7], [2, .75, 6], [2.75, .25, 7], [3, 1, 4]] },
    // mesure 12 (A') : C5:1 A4:.5 B4:.5 C5:.5 D5:.5 E5:1
    { bar: 12, section: "A'", chord: [0, 'min'], bass: 'bounceEnd', arp: 'A', drums: 'fill', melody: [[0, 1, 3], [1, .5, 1], [1.5, .5, 2], [2, .5, 3], [2.5, .5, 4], [3, 1, 5]] },
    // mesure 13 (C) : A4:.75 B4:.25 C5:1 B4:.75 C5:.25 D5:1
    { bar: 13, section: 'C', chord: [5, 'min'], bass: 'gallop', arp: 'C', drums: 'drive', melody: [[0, .75, 1], [.75, .25, 2], [1, 1, 3], [2, .75, 2], [2.75, .25, 3], [3, 1, 4]] },
    // mesure 14 (C) : C5:.75 D5:.25 E5:1 D5:.75 E5:.25 F5:1
    { bar: 14, section: 'C', chord: [8, 'maj'], bass: 'gallop', arp: 'C', drums: 'drive', melody: [[0, .75, 3], [.75, .25, 4], [1, 1, 5], [2, .75, 4], [2.75, .25, 5], [3, 1, 6]] },
    // mesure 15 (C) : D5:.75 E5:.25 F5:1 E5:.75 F5:.25 G5:.5 A5:.5
    { bar: 15, section: 'C', chord: [10, 'maj'], bass: 'gallop', arp: 'C', drums: 'drive', melody: [[0, .75, 4], [.75, .25, 5], [1, 1, 6], [2, .75, 5], [2.75, .25, 6], [3, .5, 7], [3.5, .5, 8]] },
    // mesure 16 (C) : A5:.75 G#5:.25 E5:.5 D5:.5 B4:1 G#4:1
    { bar: 16, section: 'C', chord: [7, 'maj'], bass: 'bounceEnd', arp: 'A', drums: 'fillBig', melody: [[0, .75, 8], [.75, .25, 7, 1], [1, .5, 5], [1.5, .5, 4], [2, 1, 2], [3, 1, 0, 1]] },
  ],
};
