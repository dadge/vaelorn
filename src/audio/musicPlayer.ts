/**
 * Lecteur de la musique de fond (WebAudio, temps réel) : machine d'états + planification en « lookahead ».
 *
 * PLANIFICATION : un minuteur (~25 ms) réveille `pump`, qui planifie les notes dont l'instant tombe dans la fenêtre
 * [currentTime, currentTime + 0,3 s] de l'horloge audio. Jamais plus loin. La boucle n démarre à `t0 + n × loopSeconds` (multiplication,
 * pas d'accumulation : aucune dérive) ; les notes de la boucle n + 1 sont planifiées dès que leur instant entre dans la fenêtre, donc
 * AVANT la fin de la boucle n, et les queues de relâchement des dernières notes finissent par-dessus le début de la suivante.
 *
 * ÉTATS (par `status`) : `idle` (aucun nœud, aucun minuteur) → `playing` (chaîne branchée, minuteur actif) → `fadingOut` (fondu de sortie,
 * plus de planification) → `idle`. La musique joue si `wanted` (une scène la demande : `start()`) ET `enabled` (réglage, volume > 0) ET non `muted`
 * (touche M, durée de la partie). Réglages et demandes peuvent changer à tout moment : `refresh()` recalcule l'état.
 *  - `start({ level })` / `stop(fadeSec)` : la scène demande / relâche la musique (idempotent : jamais deux boucles en même temps) ;
 *  - `setDucked(true)` : pause du jeu, volume ramené à ~35 % SANS arrêter la musique (la reprise ne décale rien : horloge audio) ;
 *  - `setSettings({ enabled, volume })` : réglage du menu ; `setMuted` : coupure de session (M) ;
 *  - onglet caché (`visibilitychange`) : minuteur arrêté + contexte suspendu (aucun calcul), repris au retour ;
 *  - `dispose()` : arrêt immédiat, minuteurs annulés, nœuds débranchés, écouteurs retirés.
 *
 * TESTABILITÉ : le contexte audio, les minuteurs et la visibilité sont INJECTÉS (`MusicPlayerDeps`) : les tests utilisent un faux
 * AudioContext et un planificateur manuel, sans horloge réelle. Sans AudioContext (Node, bots, navigateur sans WebAudio) :
 * `getContext()` renvoie null et le lecteur reste silencieux, sans exception.
 */
import { buildLoopSequence, type LoopSequence } from './sequencer';
import { createMusicChain, scheduleEvent, type LiveNote, type MusicChain } from './musicSynth';
import { CAVALCADE_DU_CRISTAL, type MusicTheme } from './theme';

/** Période du minuteur de planification (ms). */
export const LOOKAHEAD_TIMER_MS = 25;
/**
 * Fenêtre d'anticipation (s) : on ne planifie jamais plus loin que `currentTime + LOOKAHEAD_WINDOW_S`. 0,3 s (haut de la plage
 * 0,15-0,3 s) : un blocage du fil principal plus court (reconstruction de salle, ramasse-miettes) ne laisse pas la musique tomber à sec.
 */
export const LOOKAHEAD_WINDOW_S = 0.3;
/** Délai (s) entre le démarrage et la première note (laisse le temps de planifier le premier paquet). */
export const START_DELAY_S = 0.05;
/** Fondu d'entrée (s) au démarrage. */
export const FADE_IN_S = 0.5;
/** Fondu de sortie (s) par défaut à l'arrêt. */
export const FADE_OUT_S = 0.4;
/** Facteur de volume pendant la pause du jeu (ducking ~35 %). */
export const DUCK_GAIN = 0.35;
/** Durée (s) de la rampe du ducking. */
export const DUCK_RAMP_S = 0.15;
/** Durée (s) de la rampe d'un changement de volume. */
export const VOLUME_RAMP_S = 0.1;
/**
 * Gain maître de la musique à 100 % de volume réglé : modeste pour ne pas couvrir les effets sonores (sfx.ts). 0,25 : à 60 % (défaut),
 * gain 0,15, soit une crête d'environ -23 dBFS et un RMS d'environ -36 dBFS, sous les effets fréquents (tirs, apparitions : RMS -30 à -37 dBFS
 * dans la même bande 400-900 Hz). À valider à l'oreille en plein combat (TODO.md).
 */
export const MUSIC_BASE_GAIN = 0.25;
/** Une note planifiée avec plus de ce retard (s) sur l'horloge audio est abandonnée (après un blocage), pas jouée en rafale. */
const STALE_NOTE_S = 0.03;
/** Garde-fou : nombre maximal de notes planifiées par réveil. */
const MAX_EVENTS_PER_PUMP = 2048;

export type MusicStatus = 'idle' | 'playing' | 'fadingOut';

/** Minuteur injectable (setTimeout / clearTimeout en production, planificateur manuel dans les tests). */
export interface TimerApi {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** Visibilité du document injectable (document.hidden / visibilitychange en production). */
export interface VisibilityApi {
  isHidden(): boolean;
  /** S'abonne aux changements ; retourne la fonction de désabonnement. */
  subscribe(listener: () => void): () => void;
}

export interface MusicPlayerDeps {
  /** Contexte audio partagé, ou null (pas de WebAudio : silence). */
  getContext(): AudioContext | null;
  timers?: TimerApi;
  /** null / absent : pas de gestion de visibilité. */
  visibility?: VisibilityApi | null;
  /** Thème et séquence (défaut : « Cavalcade du Cristal » à 150 BPM). */
  theme?: MusicTheme;
  sequence?: LoopSequence;
  lookaheadMs?: number;
  windowSec?: number;
}

export interface MusicStartOptions {
  /** Niveau relatif de la scène (1 = plein ; 0,5 pour le tutoriel). */
  level?: number;
}

export interface MusicSettingsInput {
  enabled: boolean;
  /** 0..100. */
  volume: number;
}

/**
 * Suivi côté JS d'une rampe linéaire de gain : permet de repartir de la valeur COURANTE (fondu interrompu, ducking, changement de volume)
 * sans dépendre du getter `AudioParam.value` (dont le suivi des rampes n'est pas garanti par tous les navigateurs).
 */
class RampTracker {
  private from: number;
  private to: number;
  private t0: number;
  private t1: number;

  constructor(initial: number, now: number) {
    this.from = initial;
    this.to = initial;
    this.t0 = now;
    this.t1 = now;
  }

  /** Valeur attendue à l'instant `now` (horloge audio). */
  valueAt(now: number): number {
    if (now >= this.t1) return this.to;
    if (now <= this.t0) return this.from;
    return this.from + ((this.to - this.from) * (now - this.t0)) / (this.t1 - this.t0);
  }

  /** Mémorise une rampe déjà planifiée sur le paramètre (de la valeur courante vers `target`). */
  track(target: number, now: number, durationSec: number): void {
    this.from = this.valueAt(now);
    this.to = target;
    this.t0 = now;
    this.t1 = now + durationSec;
  }

  /** Fige la valeur courante puis rampe vers `target` : le paramètre repart de là où il en est, jamais d'un saut. */
  rampTo(param: AudioParam, target: number, now: number, durationSec: number): void {
    const current = this.valueAt(now);
    param.cancelScheduledValues(now);
    param.setValueAtTime(current, now);
    param.linearRampToValueAtTime(target, now + durationSec);
    this.track(target, now, durationSec);
  }
}

/** Un « graphe » = une instance de lecture (chaîne branchée + position de planification). */
interface Run {
  ctx: AudioContext;
  chain: MusicChain;
  /** Suivi des rampes du gain maître et du ducking. */
  masterRamp: RampTracker;
  duckRamp: RampTracker;
  live: Set<LiveNote>;
  /** Instant (horloge audio) du début de la boucle 0. */
  t0: number;
  loopIndex: number;
  eventIndex: number;
  /** Fondu de sortie en cours : plus de planification. */
  leaving: boolean;
  teardownTimer: unknown;
}

const DEFAULT_TIMERS: TimerApi = {
  set: (fn, ms) => globalThis.setTimeout(fn, ms),
  clear: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class MusicPlayer {
  private readonly deps: MusicPlayerDeps;
  private readonly timers: TimerApi;
  private readonly theme: MusicTheme;
  private readonly sequence: LoopSequence;
  private readonly lookaheadMs: number;
  private readonly windowSec: number;

  private wanted = false;
  private enabled = true;
  private muted = false;
  private ducked = false;
  private volume = 60;
  private level = 1;
  private hidden = false;
  private disposed = false;
  /** Dernier contexte utilisé (pour le reprendre au retour de l'onglet même si plus rien ne joue). */
  private lastCtx: AudioContext | null = null;

  private run: Run | null = null;
  /** Instances en fondu de sortie (encore branchées jusqu'à la fin de leur fondu). */
  private readonly retiring = new Set<Run>();
  private pumpTimer: unknown = null;
  private unsubscribeVisibility: (() => void) | null = null;

  constructor(deps: MusicPlayerDeps) {
    this.deps = deps;
    this.timers = deps.timers ?? DEFAULT_TIMERS;
    this.theme = deps.theme ?? CAVALCADE_DU_CRISTAL;
    this.sequence = deps.sequence ?? buildLoopSequence(this.theme);
    this.lookaheadMs = deps.lookaheadMs ?? LOOKAHEAD_TIMER_MS;
    this.windowSec = deps.windowSec ?? LOOKAHEAD_WINDOW_S;
  }

  // ───────────────────────────── Lecture seule ─────────────────────────────

  /** Une scène demande-t-elle la musique ? */
  get isWanted(): boolean {
    return this.wanted;
  }

  get status(): MusicStatus {
    if (this.run) return 'playing';
    return this.retiring.size > 0 ? 'fadingOut' : 'idle';
  }

  get isDucked(): boolean {
    return this.ducked;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** Gain maître visé (volume réglé × gain de base × niveau de la scène) ; 0 si le réglage est coupé. */
  get targetGain(): number {
    return (this.volume / 100) * MUSIC_BASE_GAIN * this.level;
  }

  /** Durée d'une boucle (s). */
  get loopSeconds(): number {
    return this.sequence.loopSeconds;
  }

  // ───────────────────────────── Commandes ─────────────────────────────

  /** Demande la musique (fondu d'entrée). Idempotent : un second appel ne crée pas de seconde boucle, il ne change que le niveau. */
  start(opts: MusicStartOptions = {}): void {
    if (this.disposed) return;
    this.level = clamp01(opts.level ?? 1);
    this.wanted = true;
    this.refresh();
  }

  /** Relâche la musique : fondu de sortie de `fadeSec` secondes (0 = arrêt immédiat), puis nettoyage complet. */
  stop(fadeSec: number = FADE_OUT_S): void {
    // La coupure (M) ne vaut que pour la durée d'une demande de musique (une partie) : elle ne survit pas à l'arrêt, sinon l'aperçu
    // du menu resterait muet après un M en jeu.
    this.muted = false;
    if (!this.wanted && !this.run) return;
    this.wanted = false;
    this.refresh(fadeSec);
  }

  /** Réglage du menu : musique activée / désactivée et volume 0..100. */
  setSettings(s: MusicSettingsInput): void {
    this.enabled = s.enabled === true;
    this.volume = Number.isFinite(s.volume) ? Math.max(0, Math.min(100, s.volume)) : this.volume;
    this.refresh();
  }

  /**
   * Coupure de session (touche M) : arrête (fondu) / relance la musique sans toucher au réglage mémorisé. Remise à zéro par `stop()` :
   * elle ne vaut que pour la durée d'une partie.
   */
  setMuted(muted: boolean): void {
    this.muted = muted;
    this.refresh();
  }

  /** Pause du jeu : volume baissé (~35 %), la musique CONTINUE ; reprise sans décalage. */
  setDucked(ducked: boolean): void {
    if (this.ducked === ducked) return;
    this.ducked = ducked;
    const r = this.run;
    if (!r) return;
    r.duckRamp.rampTo(r.chain.duck.gain, ducked ? DUCK_GAIN : 1, r.ctx.currentTime, DUCK_RAMP_S);
  }

  /**
   * Politique d'autoplay : à appeler de temps en temps (action de manette…) ; tente de reprendre un contexte encore suspendu. Sans effet
   * si l'onglet est caché (la reprise se fait alors au retour) ou si rien ne joue.
   */
  nudge(): void {
    const r = this.run;
    if (!r || this.hidden) return;
    // tout état autre que « running » : « suspended » (autoplay) mais aussi « interrupted » (iOS : appel, verrouillage d'écran)
    if (r.ctx.state !== 'running') tryResume(r.ctx);
  }

  /** Arrêt immédiat et définitif : minuteurs annulés, nœuds débranchés, écouteurs retirés. */
  dispose(): void {
    this.disposed = true;
    this.wanted = false;
    this.clearPump();
    if (this.run) {
      this.teardown(this.run);
      this.run = null;
    }
    for (const r of [...this.retiring]) this.teardown(r);
    this.retiring.clear();
    this.detachVisibility();
  }

  // ───────────────────────────── Machine d'états ─────────────────────────────

  /**
   * Recalcule l'état voulu : démarre, arrête (fondu) ou ajuste le volume. Volume 0 %, réglage désactivé et coupure (M) sont de vrais
   * ARRÊTS (aucun nœud, aucun calcul) : la remise du son repart du début de la boucle (mesure 1) avec un fondu d'entrée.
   */
  private refresh(stopFadeSec: number = FADE_OUT_S): void {
    if (this.disposed) return;
    const audible = this.wanted && this.enabled && !this.muted && this.volume > 0;
    if (audible) {
      if (this.run) this.applyVolume(this.run);
      else this.engage();
    } else if (this.run) {
      this.disengage(stopFadeSec);
    }
  }

  private engage(): void {
    let ctx: AudioContext | null = null;
    try {
      ctx = this.deps.getContext();
    } catch {
      ctx = null;
    }
    if (!ctx) return; // pas de WebAudio : silence
    let chain: MusicChain;
    try {
      chain = createMusicChain(ctx, this.theme);
    } catch {
      return; // contexte inutilisable : silence, sans exception
    }
    const now = ctx.currentTime;
    const duckStart = this.ducked ? DUCK_GAIN : 1;
    const run: Run = {
      ctx,
      chain,
      masterRamp: new RampTracker(0, now),
      duckRamp: new RampTracker(duckStart, now),
      live: new Set(),
      t0: now + START_DELAY_S,
      loopIndex: 0,
      eventIndex: 0,
      leaving: false,
      teardownTimer: null,
    };
    this.run = run;
    this.lastCtx = ctx;
    // Fondu d'entrée : 0 → volume visé en FADE_IN_S ; ducking cohérent avec l'état courant.
    chain.master.gain.setValueAtTime(0, now);
    chain.master.gain.linearRampToValueAtTime(this.targetGain, now + FADE_IN_S);
    run.masterRamp.track(this.targetGain, now, FADE_IN_S);
    chain.duck.gain.setValueAtTime(duckStart, now);
    this.attachVisibility();
    this.hidden = this.deps.visibility?.isHidden() ?? false;
    if (this.hidden) {
      suspendQuietly(ctx);
      return; // la planification démarre au retour de l'onglet
    }
    if (ctx.state === 'suspended') tryResume(ctx); // le contexte démarrera au premier geste (politique d'autoplay)
    this.pump();
    this.armPump();
  }

  /** Arrête la planification et lance le fondu de sortie ; le nettoyage final a lieu à la fin du fondu. */
  private disengage(fadeSec: number): void {
    const run = this.run;
    if (!run) return;
    this.run = null;
    this.clearPump();
    if (!(fadeSec > 0) || run.ctx.state !== 'running' || this.hidden) {
      this.teardown(run);
      this.afterTeardown();
      return;
    }
    run.leaving = true;
    run.masterRamp.rampTo(run.chain.master.gain, 0, run.ctx.currentTime, fadeSec);
    this.retiring.add(run);
    run.teardownTimer = this.timers.set(() => {
      this.retiring.delete(run);
      this.teardown(run);
      this.afterTeardown();
    }, Math.ceil(fadeSec * 1000) + 40);
  }

  private afterTeardown(): void {
    // Onglet caché : on reste abonné jusqu'au retour, pour reprendre le contexte partagé qu'on a suspendu (voir `onVisibility`).
    if (!this.run && this.retiring.size === 0 && !this.hidden) this.detachVisibility();
  }

  /** Libère une instance : notes arrêtées et débranchées, chaîne débranchée, minuteur de fin annulé. */
  private teardown(run: Run): void {
    if (run.teardownTimer !== null) {
      this.timers.clear(run.teardownTimer);
      run.teardownTimer = null;
    }
    for (const n of [...run.live]) n.kill();
    run.live.clear();
    run.chain.dispose();
  }

  private applyVolume(run: Run): void {
    run.masterRamp.rampTo(run.chain.master.gain, this.targetGain, run.ctx.currentTime, VOLUME_RAMP_S);
  }

  // ───────────────────────────── Planification ─────────────────────────────

  private armPump(): void {
    this.clearPump();
    if (!this.run || this.hidden) return;
    this.pumpTimer = this.timers.set(() => {
      this.pumpTimer = null;
      this.pump();
      this.armPump();
    }, this.lookaheadMs);
  }

  private clearPump(): void {
    if (this.pumpTimer !== null) {
      this.timers.clear(this.pumpTimer);
      this.pumpTimer = null;
    }
  }

  /** Planifie les notes dont l'instant tombe dans la fenêtre d'anticipation. Ne lève jamais : en cas d'erreur, la musique s'arrête. */
  private pump(): void {
    const run = this.run;
    if (!run || run.leaving) return;
    try {
      const { ctx } = run;
      const now = ctx.currentTime;
      const horizon = now + this.windowSec;
      const events = this.sequence.events;
      const loopSec = this.sequence.loopSeconds;
      let budget = MAX_EVENTS_PER_PUMP;
      while (budget-- > 0) {
        const ev = events[run.eventIndex];
        const at = run.t0 + run.loopIndex * loopSec + ev.t;
        if (at >= horizon) break;
        if (at >= now - STALE_NOTE_S) scheduleEvent(ctx, run.chain, this.theme, this.sequence, ev, at, run.eventIndex + run.loopIndex, run.live);
        run.eventIndex++;
        if (run.eventIndex >= events.length) {
          run.eventIndex = 0;
          run.loopIndex++;
        }
      }
    } catch {
      // WebAudio défaillant : on se tait plutôt que de faire planter le jeu
      this.run = null;
      this.clearPump();
      this.teardown(run);
      this.afterTeardown();
    }
  }

  // ───────────────────────────── Visibilité de l'onglet ─────────────────────────────

  private attachVisibility(): void {
    const vis = this.deps.visibility;
    if (!vis || this.unsubscribeVisibility) return;
    this.unsubscribeVisibility = vis.subscribe(() => this.onVisibility());
  }

  private detachVisibility(): void {
    this.unsubscribeVisibility?.();
    this.unsubscribeVisibility = null;
  }

  /** Onglet caché : plus de minuteur, contexte suspendu (aucun calcul). Retour : contexte repris, planification relancée. */
  private onVisibility(): void {
    const hidden = this.deps.visibility?.isHidden() ?? false;
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    const ctxs = new Set<AudioContext>();
    if (this.lastCtx) ctxs.add(this.lastCtx);
    if (this.run) ctxs.add(this.run.ctx);
    for (const r of this.retiring) ctxs.add(r.ctx);
    if (hidden) {
      this.clearPump();
      for (const c of ctxs) suspendQuietly(c);
    } else {
      for (const c of ctxs) tryResume(c);
      if (this.run) {
        this.pump();
        this.armPump();
      } else if (this.retiring.size === 0) {
        this.detachVisibility(); // plus rien ne joue : le contexte est repris, on n'a plus besoin d'écouter
      }
    }
  }
}

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 1;
}

/** `resume()` sans exception ni rejet non géré. */
function tryResume(ctx: AudioContext): void {
  try {
    const p = ctx.resume();
    if (p && typeof p.catch === 'function') p.catch(() => undefined);
  } catch {
    /* contexte fermé ou bloqué */
  }
}

function suspendQuietly(ctx: AudioContext): void {
  try {
    const p = ctx.suspend();
    if (p && typeof p.catch === 'function') p.catch(() => undefined);
  } catch {
    /* contexte fermé */
  }
}
