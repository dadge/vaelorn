/**
 * Séquenceur PUR et déterministe : transforme un thème (`theme.ts`, données) en liste d'ÉVÉNEMENTS note pour UNE boucle
 * (temps, durée, hauteur en Hz, voix, vélocité). Aucune dépendance à WebAudio, au DOM ni à l'horloge : testable sous Node.
 *
 * - Les temps et durées de sortie sont en SECONDES (un temps de noire = 60 / bpm), relatifs au début de la boucle ;
 *   `beat` / `beats` restent disponibles en temps de noire.
 * - Aucune note ne démarre hors de [0, loopSeconds[ : les queues de relâchement (release) qui dépassent la fin de la mesure 16
 *   sont jouées PAR-DESSUS le début de la boucle suivante par le lecteur (`musicPlayer.ts`), pas coupées.
 * - `transpose` (demi-tons) et `bpm` sont optionnels : la partition n'est pas modifiée.
 * - La liste est triée par instant de début (tri STABLE : à instant égal, ordre mélodie, arpège, basse, percussions).
 */
import { CAVALCADE_DU_CRISTAL, CHORD_TONES, type DrumKind, type MusicTheme } from './theme';

export type PitchedVoice = 'melody' | 'arp' | 'bass';
export type VoiceId = PitchedVoice | 'drums';

/** Note à hauteur définie (mélodie, arpège, basse). */
export interface PitchedEvent {
  voice: PitchedVoice;
  /** Début (s), relatif au début de la boucle. */
  t: number;
  /** Durée écrite (s) : la voix applique ensuite son `gate` et son `release`. */
  d: number;
  /** Début / durée en temps de noire. */
  beat: number;
  beats: number;
  midi: number;
  hz: number;
  vel: number;
}

/** Coup de percussion (bruit). */
export interface DrumEvent {
  voice: 'drums';
  t: number;
  beat: number;
  kind: DrumKind;
  vel: number;
}

export type MusicEvent = PitchedEvent | DrumEvent;

export interface SequenceOptions {
  /** Transposition en demi-tons (défaut 0). */
  transpose?: number;
  /** Tempo (défaut : celui du thème). Une valeur non finie ou ≤ 0 est ignorée. */
  bpm?: number;
}

export interface LoopSequence {
  bpm: number;
  beatsPerBar: number;
  bars: number;
  loopBeats: number;
  /** Durée exacte d'une boucle (s) : loopBeats × 60 / bpm (16 mesures à 150 BPM = 25,6 s). */
  loopSeconds: number;
  /** Secondes par temps de noire. */
  secondsPerBeat: number;
  /** Événements d'UNE boucle, triés par instant de début. */
  events: readonly MusicEvent[];
}

/** Fréquence (Hz) d'un numéro MIDI (la4 = 69 = 440 Hz). */
export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Degré de gamme (1 = tonique, entiers relatifs) → numéro MIDI, avec altération en demi-tons et transposition. */
export function degreeToMidi(theme: MusicTheme, degree: number, alter = 0, transpose = 0): number {
  const sc = theme.key.scale;
  const idx = degree - 1;
  const oct = Math.floor(idx / sc.length);
  const step = ((idx % sc.length) + sc.length) % sc.length;
  return theme.key.tonicMidi + transpose + 12 * oct + sc[step] + alter;
}

/** Place la classe de hauteur `pc` dans [lo, lo + 11]. */
function placeInRange(pc: number, lo: number): number {
  return lo + ((((pc - lo) % 12) + 12) % 12);
}

/** Tempo effectif : celui demandé s'il est valide, sinon celui du thème. */
export function effectiveBpm(theme: MusicTheme, bpm?: number): number {
  return typeof bpm === 'number' && Number.isFinite(bpm) && bpm > 0 ? bpm : theme.bpm;
}

/** Durée d'une boucle (s) pour un thème / un tempo. */
export function loopSeconds(theme: MusicTheme = CAVALCADE_DU_CRISTAL, bpm?: number): number {
  return (theme.loopBeats * 60) / effectiveBpm(theme, bpm);
}

const VOICE_ORDER: Readonly<Record<VoiceId, number>> = { melody: 0, arp: 1, bass: 2, drums: 3 };

/**
 * Déplie la partition en événements d'une boucle. Pur : même entrée, même sortie.
 * Les temps sont calculés `beat × 60 / bpm` (même formule que le synthé de référence : pas de dérive cumulée).
 */
export function buildLoopSequence(theme: MusicTheme = CAVALCADE_DU_CRISTAL, opts: SequenceOptions = {}): LoopSequence {
  const bpm = effectiveBpm(theme, opts.bpm);
  const transpose = typeof opts.transpose === 'number' && Number.isFinite(opts.transpose) ? Math.round(opts.transpose) : 0;
  const spb = 60 / bpm;
  const bpb = theme.beatsPerBar;
  const scratch: MusicEvent[] = [];

  const pitched = (voice: PitchedVoice, beat: number, beats: number, midi: number): void => {
    scratch.push({ voice, t: beat * spb, d: beats * spb, beat, beats, midi, hz: midiToHz(midi), vel: 1 });
  };

  // Ordre de génération = ordre des voix de la référence (mélodie, arpège, basse, percussions), mesure par mesure : on génère par voix
  // pour que le tri stable retrouve exactement l'ordre de `scheduleEvents` de theme.mjs.
  const perVoice: Record<VoiceId, MusicEvent[]> = { melody: [], arp: [], bass: [], drums: [] };
  const push = (voice: VoiceId, list: MusicEvent[]): void => {
    for (const e of list) perVoice[voice].push(e);
  };
  theme.score.forEach((bar, i) => {
    const t0 = i * bpb;
    const [rootOff, quality] = bar.chord;
    const pc = (((theme.key.tonicMidi + transpose + rootOff) % 12) + 12) % 12;

    scratch.length = 0;
    for (const [b, d, deg, alt = 0] of bar.melody) pitched('melody', t0 + b, d, degreeToMidi(theme, deg, alt, transpose));
    push('melody', scratch);

    scratch.length = 0;
    const arpRoot = placeInRange(pc, theme.key.arpRange);
    const tones = CHORD_TONES[quality];
    theme.patterns.arp[bar.arp].forEach((idx, s) => {
      if (idx === null) return;
      pitched('arp', t0 + s * 0.25, 0.25, arpRoot + tones[idx]);
    });
    push('arp', scratch);

    scratch.length = 0;
    const bassRoot = placeInRange(pc, theme.key.bassRange);
    for (const [b, d, iv] of theme.patterns.bass[bar.bass]) pitched('bass', t0 + b, d, bassRoot + iv);
    push('bass', scratch);

    scratch.length = 0;
    for (const [b, kind, vel] of theme.patterns.drums[bar.drums]) {
      scratch.push({ voice: 'drums', t: (t0 + b) * spb, beat: t0 + b, kind, vel });
    }
    push('drums', scratch);
  });

  const merged: MusicEvent[] = [...perVoice.melody, ...perVoice.arp, ...perVoice.bass, ...perVoice.drums];
  // Tri STABLE par instant (Array.prototype.sort est stable depuis ES2019) ; à instant égal, ordre des voix déjà respecté.
  merged.sort((a, b) => a.t - b.t || VOICE_ORDER[a.voice] - VOICE_ORDER[b.voice]);

  return {
    bpm,
    beatsPerBar: bpb,
    bars: theme.bars,
    loopBeats: theme.loopBeats,
    loopSeconds: (theme.loopBeats * 60) / bpm,
    secondsPerBeat: spb,
    events: merged,
  };
}
