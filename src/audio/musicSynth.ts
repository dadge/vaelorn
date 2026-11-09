/**
 * Synthèse de la musique de fond avec WebAudio : port FIDÈLE du synthé logiciel de référence (render.mjs, qui a produit le rendu validé
 * à l'oreille), sans aucun fichier audio.
 *
 * Correspondance avec la référence :
 *  - impulsions (mélodie 25 %, arpège 12,5 %) : `PeriodicWave` de la série de Fourier de l'impulsion, SANS normalisation (amplitude
 *    identique à la référence, moyenne nulle) ; la référence utilisait PolyBLEP, la série est limitée en bande par WebAudio ;
 *  - basse : oscillateur `triangle` natif ;
 *  - enveloppes ADSR LINÉAIRES (`envelopePoints`, même formule que `envelope()` de la référence), maintien jusqu'à `gate` × durée ;
 *  - vibrato : LFO sinus sur `detune`, retardé (`delay`), établi en 0,12 s, uniquement pour les notes d'au moins `minBeats` temps ;
 *  - percussions : bruit à échantillonnage-maintien (fréquence de rafraîchissement glissante) passe-bas 1 pôle, décroissance en
 *    puissance, attaque anti-clic de 1,5 ms, PRÉ-RENDU en `AudioBuffer` (`renderDrumHit`, générateur pseudo-aléatoire à graine : déterministe) ;
 *  - mix : gain `master.gain` × `volume` de la voix × vélocité appliqué à CHAQUE note (comme la référence), puis passe-bas 1 pôle à
 *    `master.lowpassHz` (`IIRFilterNode`, repli : biquad), puis LIMITEUR DOUX (courbe tanh au-delà de 0,7 : jamais d'écrêtage).
 *
 * Ce module ne planifie rien dans le temps : il construit la chaîne (`createMusicChain`), crée les notes à un instant donné
 * (`scheduleEvent`) et sait planifier des boucles entières d'un coup (`scheduleLoops`, rendu hors ligne / harnais de vérification).
 * La planification en temps réel (fenêtre d'anticipation, fondus, pause) est dans `musicPlayer.ts`.
 */
import type { DrumEvent, LoopSequence, MusicEvent, PitchedEvent } from './sequencer';
import type { DrumKind, Envelope, MusicTheme, NoiseKind } from './theme';

/** Nombre d'harmoniques fournies à `PeriodicWave` (WebAudio limite ensuite la bande selon la hauteur jouée). */
export const PULSE_HARMONICS = 128;
/** Variantes de chaque percussion (bruit différent à chaque coup, comme le flux pseudo-aléatoire de la référence). */
export const DRUM_VARIANTS = 4;
/** Durée (s) d'établissement du vibrato (référence : 0,12 s). */
export const VIBRATO_RAMP_S = 0.12;
/** Marge (s) avant l'arrêt effectif d'un oscillateur après la fin de son release. */
const STOP_MARGIN_S = 0.01;
/** Seuil (amplitude) au-delà duquel le limiteur doux commence à arrondir. */
export const LIMITER_KNEE = 0.7;

// ───────────────────────────── Fonctions pures (testables sous Node) ─────────────────────────────

/** Générateur pseudo-aléatoire à graine (mulberry32), identique à la référence : déterministe. */
export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Coefficients de Fourier d'une impulsion de rapport cyclique `duty` (haut sur [0, duty[, bas ensuite, amplitude ±1, composante
 * continue ignorée par WebAudio donc moyenne nulle) : cos = 2 sin(2π n D) / (π n), sin = 2 (1 − cos(2π n D)) / (π n).
 */
export function pulseCoefficients(duty: number, harmonics: number = PULSE_HARMONICS): { real: Float32Array<ArrayBuffer>; imag: Float32Array<ArrayBuffer> } {
  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);
  for (let n = 1; n <= harmonics; n++) {
    real[n] = (2 * Math.sin(2 * Math.PI * n * duty)) / (Math.PI * n);
    imag[n] = (2 * (1 - Math.cos(2 * Math.PI * n * duty))) / (Math.PI * n);
  }
  return { real, imag };
}

/** Niveau (0..1) de l'enveloppe ADSR à l'instant `x` (s) tant que la note est tenue. Identique à `level()` de la référence. */
export function envelopeLevel(x: number, e: Envelope): number {
  if (x < e.attack) return x / e.attack;
  if (e.decay > 0 && x < e.attack + e.decay) return 1 - ((1 - e.sustain) * (x - e.attack)) / e.decay;
  return e.sustain;
}

/** Instant (s, depuis le début de la note) du relâchement : durée × gate, au moins attaque + 4 ms (comme la référence). */
export function gateSeconds(env: Envelope, gate: number, durSec: number): number {
  return Math.max(durSec * gate, env.attack + 0.004);
}

/**
 * Enveloppe en points [instant (s), niveau 0..1] pour des rampes LINÉAIRES : 0 → attaque → décroissance → maintien, coupée à
 * `gateSec` (le niveau y est celui de la référence), puis release linéaire jusqu'à 0. Les instants sont strictement croissants.
 */
export function envelopePoints(env: Envelope, gateSec: number): ReadonlyArray<readonly [number, number]> {
  const pts: Array<[number, number]> = [[0, 0]];
  const knots: Array<[number, number]> = [[env.attack, 1]];
  if (env.decay > 0) knots.push([env.attack + env.decay, env.sustain]);
  for (const k of knots) {
    if (k[0] < gateSec) pts.push(k);
    else break;
  }
  const last = pts[pts.length - 1];
  if (gateSec > last[0]) pts.push([gateSec, envelopeLevel(gateSec, env)]);
  pts.push([gateSec + env.release, 0]);
  return pts;
}

/** Coefficient `a` d'un passe-bas 1 pôle y[n] = (1 − a) x[n] + a y[n − 1] de fréquence `hz` à la fréquence d'échantillonnage `sr`. */
export function onePoleCoefficient(hz: number, sr: number): number {
  return Math.exp((-2 * Math.PI * hz) / sr);
}

/**
 * Rend UNE percussion (bruit à échantillonnage-maintien, passe-bas 1 pôle, décroissance en puissance, attaque 1,5 ms) en échantillons,
 * volume propre au type (`vol`) inclus. Port exact de `renderNoise` de la référence.
 */
export function renderDrumHit(k: NoiseKind, sampleRate: number, rnd: () => number): Float32Array<ArrayBuffer> {
  const n = Math.max(1, Math.ceil(k.dur * sampleRate));
  const out = new Float32Array(n);
  const a = k.lp ? onePoleCoefficient(k.lp, sampleRate) : 0;
  let acc = 0;
  let held = rnd() * 2 - 1;
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const x = i / n;
    const rate = k.rate0 + (k.rate1 - k.rate0) * x;
    acc += rate / sampleRate;
    if (acc >= 1) {
      acc -= Math.floor(acc);
      held = rnd() * 2 - 1;
    }
    lp = (1 - a) * held + a * lp;
    const att = Math.min(1, i / (0.0015 * sampleRate));
    const env = Math.pow(1 - x, k.shape) * att;
    out[i] = lp * env * k.vol;
  }
  return out;
}

/** Courbe du limiteur doux : identité jusqu'à `knee`, puis `knee + (1 − knee) tanh(...)` : sortie toujours < 1, dérivée continue. */
export function softClipCurve(size = 2049, knee: number = LIMITER_KNEE): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const x = (i / (size - 1)) * 2 - 1;
    const ax = Math.abs(x);
    const y = ax <= knee ? ax : knee + (1 - knee) * Math.tanh((ax - knee) / (1 - knee));
    curve[i] = x < 0 ? -y : y;
  }
  return curve;
}

/** Décalage (en échantillons) sous la grille visé pour le départ d'une source : voir `snapToSample`. */
export const SAMPLE_START_BIAS = 0.25;

/**
 * Ramène un instant de DÉPART sur la grille des échantillons du contexte, légèrement en dessous (un quart d'échantillon avant l'échantillon k) :
 * le moteur démarre alors la source À l'échantillon k, que sa conversion de l'instant en position soit un arrondi au plafond, au plus
 * proche ou vers le bas... sauf vers le bas strict, que les navigateurs n'utilisent pas. Viser exactement k laissait l'erreur d'arrondi des
 * flottants (k + ε) décider, et Chrome décalait alors environ une note sur cinquante d'UN échantillon (31 µs à 32 kHz) selon la boucle :
 * avec ce biais, toutes les boucles retombent sur les mêmes échantillons (vérifié en rendu hors ligne).
 */
export function snapToSample(time: number, sampleRate: number): number {
  return (Math.round(time * sampleRate) - SAMPLE_START_BIAS) / sampleRate;
}

/** Les trois voix à hauteur définie du thème : leurs paramètres de timbre. */
function channelOf(theme: MusicTheme, voice: PitchedEvent['voice']) {
  return theme.channels[voice];
}

// ───────────────────────────── Ressources WebAudio ─────────────────────────────

/** Ressources dépendantes du contexte (formes d'onde, tampons de percussions, courbe du limiteur), calculées une fois par contexte. */
export interface SynthAssets {
  /** Forme d'onde d'impulsion par rapport cyclique. */
  waves: Map<number, PeriodicWave>;
  /** Percussions pré-rendues : DRUM_VARIANTS tampons par type. */
  drums: Record<DrumKind, AudioBuffer[]>;
  curve: Float32Array<ArrayBuffer>;
}

const DRUM_KINDS: readonly DrumKind[] = ['kick', 'snare', 'hat'];
const assetCache = new WeakMap<BaseAudioContext, { theme: MusicTheme; assets: SynthAssets }>();

/** Construit (ou relit du cache) les ressources du thème pour ce contexte. */
export function getSynthAssets(ctx: BaseAudioContext, theme: MusicTheme): SynthAssets {
  const cached = assetCache.get(ctx);
  if (cached && cached.theme === theme) return cached.assets;
  const waves = new Map<number, PeriodicWave>();
  for (const ch of [theme.channels.melody, theme.channels.arp]) {
    if (waves.has(ch.duty)) continue;
    const { real, imag } = pulseCoefficients(ch.duty);
    waves.set(ch.duty, ctx.createPeriodicWave(real, imag, { disableNormalization: true }));
  }
  const drums = { kick: [], snare: [], hat: [] } as Record<DrumKind, AudioBuffer[]>;
  DRUM_KINDS.forEach((kind, ki) => {
    for (let v = 0; v < DRUM_VARIANTS; v++) {
      const rnd = mulberry32(0xa11ce + 1000 * v + ki + 1);
      const samples = renderDrumHit(theme.channels.drums.kinds[kind], ctx.sampleRate, rnd);
      const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
      buffer.getChannelData(0).set(samples);
      drums[kind].push(buffer);
    }
  });
  const assets: SynthAssets = { waves, drums, curve: softClipCurve() };
  assetCache.set(ctx, { theme, assets });
  return assets;
}

/** Chaîne de sortie : bus de mixage → passe-bas doux → limiteur doux → ducking → gain maître (fondus / volume) → sortie. */
export interface MusicChain {
  /** Point d'entrée des notes. */
  input: GainNode;
  /** Atténuation de la pause (1 = normal, ~0,35 en pause). */
  duck: GainNode;
  /** Gain maître : volume réglé × niveau de la scène × fondus. */
  master: GainNode;
  /** Débranche toute la chaîne. */
  dispose(): void;
}

/** Crée la chaîne de sortie et la branche sur `destination` (par défaut `ctx.destination`). */
export function createMusicChain(ctx: BaseAudioContext, theme: MusicTheme, destination: AudioNode = ctx.destination): MusicChain {
  const assets = getSynthAssets(ctx, theme);
  const input = ctx.createGain();
  let lowpass: AudioNode;
  if (typeof ctx.createIIRFilter === 'function') {
    const a = onePoleCoefficient(theme.master.lowpassHz, ctx.sampleRate);
    lowpass = ctx.createIIRFilter([1 - a], [1, -a]);
  } else {
    const biquad = ctx.createBiquadFilter();
    biquad.type = 'lowpass';
    biquad.frequency.value = theme.master.lowpassHz;
    lowpass = biquad;
  }
  const shaper = ctx.createWaveShaper();
  shaper.curve = assets.curve;
  const duck = ctx.createGain();
  const master = ctx.createGain();
  input.connect(lowpass);
  lowpass.connect(shaper);
  shaper.connect(duck);
  duck.connect(master);
  master.connect(destination);
  const nodes: AudioNode[] = [input, lowpass, shaper, duck, master];
  return {
    input,
    duck,
    master,
    dispose() {
      for (const n of nodes) {
        try {
          n.disconnect();
        } catch {
          /* déjà débranché */
        }
      }
    },
  };
}

/** Note en cours de lecture : `kill` l'arrête et débranche ses nœuds (appelé à la fin naturelle, ou à l'arrêt forcé). */
export interface LiveNote {
  kill(): void;
}

/** Arrête et débranche proprement des nœuds d'une note. */
function makeLive(sources: Array<OscillatorNode | AudioBufferSourceNode>, nodes: AudioNode[], live: Set<LiveNote> | null): LiveNote {
  const note: LiveNote = {
    kill() {
      if (live) live.delete(note);
      for (const s of sources) {
        try {
          s.onended = null;
          s.stop();
        } catch {
          /* jamais démarrée ou déjà arrêtée */
        }
      }
      for (const n of [...sources, ...nodes]) {
        try {
          n.disconnect();
        } catch {
          /* déjà débranché */
        }
      }
    },
  };
  if (live) live.add(note);
  return note;
}

/**
 * Planifie UNE note à l'instant absolu `when` (horloge du contexte, ramené sur la grille des échantillons, voir `snapToSample` : une boucle
 * d'un nombre entier d'échantillons retombe donc sur les mêmes échantillons à chaque tour). `variant` choisit la variante de bruit d'une percussion.
 * `live` (facultatif) collecte les notes en cours pour un arrêt forcé.
 */
export function scheduleEvent(
  ctx: BaseAudioContext,
  chain: MusicChain,
  theme: MusicTheme,
  seq: LoopSequence,
  ev: MusicEvent,
  when: number,
  variant: number,
  live: Set<LiveNote> | null = null,
): void {
  const assets = getSynthAssets(ctx, theme);
  when = snapToSample(when, ctx.sampleRate);
  if (ev.voice === 'drums') {
    scheduleDrum(ctx, chain, theme, assets, ev, when, variant, live);
    return;
  }
  const ch = channelOf(theme, ev.voice);
  const durSec = ev.beats * seq.secondsPerBeat;
  const gateT = gateSeconds(ch.env, ch.gate, durSec);
  const total = gateT + ch.env.release;
  // Le triangle de la référence démarre en DESCENDANT (celui de WebAudio monte) : polarité inversée pour retrouver la même onde.
  const amp = ch.volume * theme.master.gain * ev.vel * (ch.type === 'triangle' ? -1 : 1);

  const osc = ctx.createOscillator();
  if (ch.type === 'pulse') {
    const wave = assets.waves.get(ch.duty);
    if (wave) osc.setPeriodicWave(wave);
  } else {
    osc.type = 'triangle';
  }
  osc.frequency.setValueAtTime(ev.hz, when);

  const gain = ctx.createGain();
  const pts = envelopePoints(ch.env, gateT);
  gain.gain.setValueAtTime(pts[0][1] * amp, when + pts[0][0]);
  for (let i = 1; i < pts.length; i++) gain.gain.linearRampToValueAtTime(pts[i][1] * amp, when + pts[i][0]);
  osc.connect(gain);
  gain.connect(chain.input);

  const sources: Array<OscillatorNode | AudioBufferSourceNode> = [osc];
  const nodes: AudioNode[] = [gain];
  const vib = ch.type === 'pulse' ? ch.vibrato : undefined;
  if (vib && ev.beats >= vib.minBeats && total > vib.delay) {
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.setValueAtTime(vib.rate, when);
    const lfoGain = ctx.createGain();
    lfoGain.gain.setValueAtTime(0, when + vib.delay);
    lfoGain.gain.linearRampToValueAtTime(vib.depthSemitones * 100, when + vib.delay + VIBRATO_RAMP_S);
    lfo.connect(lfoGain);
    lfoGain.connect(osc.detune);
    lfo.start(snapToSample(when + vib.delay, ctx.sampleRate));
    lfo.stop(when + total + STOP_MARGIN_S);
    sources.push(lfo);
    nodes.push(lfoGain);
  }
  const note = makeLive(sources, nodes, live);
  osc.onended = () => note.kill();
  osc.start(when);
  osc.stop(when + total + STOP_MARGIN_S);
}

function scheduleDrum(
  ctx: BaseAudioContext,
  chain: MusicChain,
  theme: MusicTheme,
  assets: SynthAssets,
  ev: DrumEvent,
  when: number,
  variant: number,
  live: Set<LiveNote> | null,
): void {
  const buffers = assets.drums[ev.kind];
  const src = ctx.createBufferSource();
  src.buffer = buffers[((variant % buffers.length) + buffers.length) % buffers.length];
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(theme.channels.drums.volume * theme.master.gain * ev.vel, when);
  src.connect(gain);
  gain.connect(chain.input);
  const note = makeLive([src], [gain], live);
  src.onended = () => note.kill();
  src.start(when);
}

/**
 * Planifie `loops` boucles COMPLÈTES à partir de `startTime` (rendu hors ligne / harnais de vérification) : la boucle n démarre à
 * `startTime + n × loopSeconds`. Les queues de relâchement dépassent naturellement sur la boucle suivante.
 */
export function scheduleLoops(ctx: BaseAudioContext, chain: MusicChain, theme: MusicTheme, seq: LoopSequence, startTime: number, loops: number): void {
  for (let n = 0; n < loops; n++) {
    seq.events.forEach((ev, i) => scheduleEvent(ctx, chain, theme, seq, ev, startTime + n * seq.loopSeconds + ev.t, i, null));
  }
}
