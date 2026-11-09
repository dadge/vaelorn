/**
 * Sons PLACEHOLDER : petits bips synthétisés par WebAudio (aucun fichier audio). Tout est protégé par try/catch :
 * sans audio disponible (Node, contexte bloqué), `play` ne fait rien. À remplacer par de vrais assets plus tard.
 *
 * `sfxForEvent` est pur (testé) : il associe un SimEvent à un nom de son.
 */
import type { SimEvent, SpecialKind } from '../core/types';
import { spriteTier } from '../render/art/enemyTiers';

export type SfxName =
  | 'attack'
  | 'shoot'
  | 'enemyHit'
  | 'enemyDie'
  | 'playerHit'
  | 'down'
  | 'revive'
  | 'door'
  | 'key'
  | 'lever'
  | 'rune'
  | 'runeFail'
  | 'objective'
  | 'cleared'
  | 'complete'
  | 'boss'
  | 'wipe'
  | 'spawn'
  | 'specialWhirlwind'
  | 'specialFire'
  | 'specialDash'
  | 'specialHeal'
  | 'specialArrows'
  | 'specialQuake'
  | 'specialSmash'
  | 'specialBlades'
  | 'specialReady'
  | 'call'
  | 'brazierLit'
  | 'torchRefuel'
  | 'torchLow'
  | 'torchOut'
  // mécanismes des niveaux 4-6 et demi-boss
  | 'statueRotated'
  | 'hourglassFlipped'
  | 'hourglassEmpty'
  | 'gateClosed'
  | 'minibossPhase';

interface SfxSpec {
  /** Fréquence de départ / d'arrivée (Hz). */
  f0: number;
  f1: number;
  durMs: number;
  type: OscillatorType;
  vol: number;
  /** Second ton joué après `delayMs` (petites mélodies). */
  then?: { f0: number; f1: number; delayMs: number };
}

const SPECS: Readonly<Record<SfxName, SfxSpec>> = {
  attack: { f0: 420, f1: 200, durMs: 90, type: 'triangle', vol: 0.05 },
  shoot: { f0: 700, f1: 380, durMs: 80, type: 'square', vol: 0.03 },
  enemyHit: { f0: 240, f1: 120, durMs: 80, type: 'square', vol: 0.05 },
  enemyDie: { f0: 300, f1: 60, durMs: 220, type: 'sawtooth', vol: 0.05 },
  playerHit: { f0: 180, f1: 70, durMs: 200, type: 'sawtooth', vol: 0.07 },
  down: { f0: 220, f1: 50, durMs: 520, type: 'triangle', vol: 0.08 },
  revive: { f0: 440, f1: 880, durMs: 220, type: 'sine', vol: 0.07, then: { f0: 660, f1: 1320, delayMs: 120 } },
  door: { f0: 90, f1: 60, durMs: 360, type: 'sawtooth', vol: 0.06 },
  key: { f0: 880, f1: 1320, durMs: 140, type: 'sine', vol: 0.06 },
  lever: { f0: 160, f1: 110, durMs: 120, type: 'square', vol: 0.05 },
  rune: { f0: 520, f1: 780, durMs: 150, type: 'sine', vol: 0.06 },
  runeFail: { f0: 160, f1: 100, durMs: 260, type: 'square', vol: 0.06 },
  objective: { f0: 660, f1: 990, durMs: 160, type: 'sine', vol: 0.07, then: { f0: 990, f1: 1480, delayMs: 140 } },
  cleared: { f0: 523, f1: 659, durMs: 180, type: 'triangle', vol: 0.07, then: { f0: 784, f1: 1046, delayMs: 160 } },
  complete: { f0: 523, f1: 784, durMs: 260, type: 'triangle', vol: 0.08, then: { f0: 784, f1: 1318, delayMs: 220 } },
  boss: { f0: 110, f1: 55, durMs: 520, type: 'sawtooth', vol: 0.08 },
  wipe: { f0: 200, f1: 40, durMs: 700, type: 'sawtooth', vol: 0.08 },
  spawn: { f0: 300, f1: 500, durMs: 120, type: 'sine', vol: 0.03 },
  // attaques spéciales : plus longues et plus graves que l'attaque normale, une signature par famille
  specialWhirlwind: { f0: 260, f1: 620, durMs: 260, type: 'sawtooth', vol: 0.06, then: { f0: 620, f1: 300, delayMs: 130 } },
  specialFire: { f0: 90, f1: 40, durMs: 420, type: 'sawtooth', vol: 0.09, then: { f0: 520, f1: 140, delayMs: 40 } },
  specialDash: { f0: 200, f1: 900, durMs: 170, type: 'square', vol: 0.05 },
  specialHeal: { f0: 523, f1: 784, durMs: 240, type: 'sine', vol: 0.07, then: { f0: 784, f1: 1318, delayMs: 160 } },
  specialArrows: { f0: 900, f1: 420, durMs: 150, type: 'square', vol: 0.04, then: { f0: 1100, f1: 500, delayMs: 60 } },
  specialQuake: { f0: 70, f1: 30, durMs: 560, type: 'sawtooth', vol: 0.1 },
  specialSmash: { f0: 130, f1: 45, durMs: 360, type: 'square', vol: 0.09, then: { f0: 300, f1: 80, delayMs: 30 } },
  specialBlades: { f0: 1000, f1: 400, durMs: 90, type: 'triangle', vol: 0.05, then: { f0: 1250, f1: 500, delayMs: 110 } },
  specialReady: { f0: 880, f1: 1760, durMs: 140, type: 'sine', vol: 0.05 },
  // appel : deux « pings » montants, comme une onde qui s'élargit (placeholder : un vrai son d'appel viendra avec les assets audio)
  call: { f0: 420, f1: 700, durMs: 260, type: 'sine', vol: 0.07, then: { f0: 560, f1: 940, delayMs: 300 } },
  // torches et braseros (salles sombres)
  brazierLit: { f0: 120, f1: 320, durMs: 260, type: 'sawtooth', vol: 0.06, then: { f0: 520, f1: 780, delayMs: 110 } },
  torchRefuel: { f0: 420, f1: 840, durMs: 200, type: 'triangle', vol: 0.06, then: { f0: 630, f1: 1260, delayMs: 100 } },
  torchLow: { f0: 520, f1: 330, durMs: 180, type: 'triangle', vol: 0.06, then: { f0: 520, f1: 330, delayMs: 220 } },
  torchOut: { f0: 300, f1: 70, durMs: 420, type: 'sawtooth', vol: 0.07 },
  // statues jumelles, sablier partagé, herse, demi-boss
  statueRotated: { f0: 150, f1: 90, durMs: 260, type: 'square', vol: 0.06, then: { f0: 210, f1: 340, delayMs: 200 } },
  hourglassFlipped: { f0: 520, f1: 260, durMs: 200, type: 'triangle', vol: 0.06, then: { f0: 300, f1: 640, delayMs: 140 } },
  hourglassEmpty: { f0: 340, f1: 110, durMs: 420, type: 'sawtooth', vol: 0.07, then: { f0: 340, f1: 110, delayMs: 260 } },
  gateClosed: { f0: 110, f1: 48, durMs: 240, type: 'square', vol: 0.08 },
  minibossPhase: { f0: 150, f1: 70, durMs: 380, type: 'sawtooth', vol: 0.07 },
};

/** Son d'une attaque spéciale selon sa famille. Pur. */
export function sfxForSpecial(kind: SpecialKind): SfxName {
  switch (kind) {
    case 'whirlwind':
      return 'specialWhirlwind';
    case 'fireNova':
      return 'specialFire';
    case 'dash':
      return 'specialDash';
    case 'healNova':
      return 'specialHeal';
    case 'arrowFan':
      return 'specialArrows';
    case 'quake':
      return 'specialQuake';
    case 'smash':
      return 'specialSmash';
    default:
      return 'specialBlades';
  }
}

/** Son associé à un événement de simulation, ou null. Pur. */
export function sfxForEvent(e: SimEvent): SfxName | null {
  switch (e.type) {
    case 'playerAttack':
      return 'attack';
    case 'projectileFired':
      return 'shoot';
    case 'enemyHit':
      return 'enemyHit';
    case 'enemyDied':
      return 'enemyDie';
    case 'playerHit':
      return 'playerHit';
    case 'playerDown':
      return 'down';
    case 'playerRevived':
      return 'revive';
    case 'doorOpened':
      return 'door';
    case 'keyPicked':
      return 'key';
    case 'mechanismChanged':
      return e.active ? 'lever' : null;
    case 'runeProgress':
      return e.ok ? 'rune' : 'runeFail';
    case 'objectiveCompleted':
      return 'objective';
    case 'roomCleared':
      return 'cleared';
    case 'levelCompleted':
      return 'complete';
    case 'bossPhase':
      // boss de fin (48×48) : grondement long ; demi-boss (32×32) : plus court
      return spriteTier(e.kind) === 'mini' ? 'minibossPhase' : 'boss';
    case 'statueRotated':
      return 'statueRotated';
    case 'hourglassFlipped':
      return 'hourglassFlipped';
    case 'hourglassEmpty':
      return 'hourglassEmpty';
    case 'gateClosed':
      return 'gateClosed';
    case 'teamWipe':
      return 'wipe';
    case 'enemySpawned':
      return 'spawn';
    case 'specialUsed':
      return sfxForSpecial(e.kind);
    case 'specialReady':
      return 'specialReady';
    case 'callStarted':
      return 'call';
    case 'brazierLit':
      return 'brazierLit';
    case 'torchRefueled':
      return 'torchRefuel';
    case 'torchLow':
      return 'torchLow';
    case 'torchOut':
      return 'torchOut';
    default:
      return null;
  }
}

/** Lecteur de sons placeholder (WebAudio). Créé paresseusement ; ne lève jamais. */
export class Sfx {
  private ctx: AudioContext | null = null;
  private failed = false;
  private muted = false;
  private readonly lastPlayed = new Map<SfxName, number>();

  /** Coupe / rétablit tous les sons. */
  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  private ensure(): AudioContext | null {
    if (this.failed) return null;
    if (this.ctx) return this.ctx;
    try {
      const Ctor = (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ??
        (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) {
        this.failed = true;
        return null;
      }
      this.ctx = new Ctor();
    } catch {
      this.failed = true;
      return null;
    }
    return this.ctx;
  }

  /** Joue un son (au plus un par nom toutes les 45 ms pour éviter la cacophonie). */
  play(name: SfxName, nowMs: number = Date.now()): void {
    if (this.muted) return;
    const last = this.lastPlayed.get(name) ?? -1e9;
    if (nowMs - last < 45) return;
    this.lastPlayed.set(name, nowMs);
    const ctx = this.ensure();
    if (!ctx) return;
    try {
      if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
      const spec = SPECS[name];
      this.tone(ctx, spec.f0, spec.f1, spec.durMs, spec.type, spec.vol, 0);
      if (spec.then) this.tone(ctx, spec.then.f0, spec.then.f1, spec.durMs, spec.type, spec.vol, spec.then.delayMs);
    } catch {
      /* audio indisponible : sans gravité */
    }
  }

  private tone(ctx: AudioContext, f0: number, f1: number, durMs: number, type: OscillatorType, vol: number, delayMs: number): void {
    const t0 = ctx.currentTime + delayMs / 1000;
    const t1 = t0 + durMs / 1000;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t1);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t1);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t1 + 0.02);
  }

  /** Ferme le contexte audio. */
  destroy(): void {
    try {
      void this.ctx?.close();
    } catch {
      /* déjà fermé */
    }
    this.ctx = null;
  }
}
