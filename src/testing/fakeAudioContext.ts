/**
 * Fausse implémentation MINIMALE d'AudioContext pour tester le lecteur de musique sans vrai WebAudio (et sans horloge réelle) :
 * horloge audio pilotée à la main (`currentTime`), nœuds qui enregistrent leurs connexions et leurs automations, minuteur manuel,
 * visibilité manuelle. Voir `src/audio/musicPlayer.test.ts`. Non utilisé par l'application.
 */
import type { TimerApi, VisibilityApi } from '../audio/musicPlayer';

export interface ParamEvent {
  type: 'set' | 'ramp' | 'cancel';
  value: number;
  time: number;
}

export class FakeParam {
  value: number;
  readonly events: ParamEvent[] = [];
  constructor(initial = 1) {
    this.value = initial;
  }
  setValueAtTime(value: number, time: number): this {
    this.events.push({ type: 'set', value, time });
    this.value = value;
    return this;
  }
  linearRampToValueAtTime(value: number, time: number): this {
    this.events.push({ type: 'ramp', value, time });
    return this;
  }
  cancelScheduledValues(time: number): this {
    this.events.push({ type: 'cancel', value: 0, time });
    return this;
  }
  /** Dernière rampe linéaire demandée (cible, instant), ou null. */
  lastRamp(): ParamEvent | null {
    for (let i = this.events.length - 1; i >= 0; i--) if (this.events[i].type === 'ramp') return this.events[i];
    return null;
  }
}

export class FakeNode {
  readonly kind: string;
  readonly outputs: unknown[] = [];
  disconnected = false;
  constructor(kind: string) {
    this.kind = kind;
  }
  connect(dest: unknown): unknown {
    this.outputs.push(dest);
    return dest;
  }
  disconnect(): void {
    this.disconnected = true;
    this.outputs.length = 0;
  }
}

export class FakeGain extends FakeNode {
  readonly gain = new FakeParam(1);
  constructor() {
    super('gain');
  }
}

export class FakeSource extends FakeNode {
  startTimes: number[] = [];
  stopTimes: number[] = [];
  onended: (() => void) | null = null;
  type = 'sine';
  wave: unknown = null;
  buffer: unknown = null;
  readonly frequency = new FakeParam(440);
  readonly detune = new FakeParam(0);
  constructor(kind: 'oscillator' | 'buffersource') {
    super(kind);
  }
  setPeriodicWave(w: unknown): void {
    this.wave = w;
    this.type = 'custom'; // comme WebAudio
  }
  start(when = 0): void {
    this.startTimes.push(when);
  }
  stop(when = 0): void {
    this.stopTimes.push(when);
  }
  /** Début planifié de la note (premier `start`). */
  get startsAt(): number {
    return this.startTimes[0];
  }
}

export class FakeContext {
  currentTime = 0;
  sampleRate = 48000;
  state: 'running' | 'suspended' | 'interrupted' | 'closed' = 'running';
  readonly destination = new FakeNode('destination');
  readonly nodes: FakeNode[] = [];
  resumeCalls = 0;
  suspendCalls = 0;
  /** Si défini, `createOscillator` lève (test de robustesse). */
  failOscillators = false;

  private track<T extends FakeNode>(n: T): T {
    this.nodes.push(n);
    return n;
  }
  createGain(): FakeGain {
    return this.track(new FakeGain());
  }
  createOscillator(): FakeSource {
    if (this.failOscillators) throw new Error('oscillateur indisponible');
    return this.track(new FakeSource('oscillator'));
  }
  createBufferSource(): FakeSource {
    return this.track(new FakeSource('buffersource'));
  }
  createBuffer(_channels: number, length: number): { length: number; getChannelData(c: number): Float32Array } {
    const data = new Float32Array(length);
    return { length, getChannelData: () => data };
  }
  createPeriodicWave(real: Float32Array, imag: Float32Array, constraints?: { disableNormalization?: boolean }): object {
    return { real, imag, constraints };
  }
  createIIRFilter(feedforward: number[], feedback: number[]): FakeNode & { feedforward: number[]; feedback: number[] } {
    const n = this.track(new FakeNode('iir')) as FakeNode & { feedforward: number[]; feedback: number[] };
    n.feedforward = feedforward;
    n.feedback = feedback;
    return n;
  }
  createWaveShaper(): FakeNode & { curve: Float32Array | null } {
    const n = this.track(new FakeNode('shaper')) as FakeNode & { curve: Float32Array | null };
    n.curve = null;
    return n;
  }
  resume(): Promise<void> {
    this.resumeCalls++;
    if (this.state === 'suspended' || this.state === 'interrupted') this.state = 'running';
    return Promise.resolve();
  }
  suspend(): Promise<void> {
    this.suspendCalls++;
    if (this.state === 'running') this.state = 'suspended';
    return Promise.resolve();
  }
  /** Oscillateurs / sources créés, du type demandé. */
  sources(kind?: 'oscillator' | 'buffersource'): FakeSource[] {
    return this.nodes.filter((n): n is FakeSource => n instanceof FakeSource && (!kind || n.kind === kind));
  }
  asAudioContext(): AudioContext {
    return this as unknown as AudioContext;
  }
}

interface PendingTimer {
  id: number;
  fn: () => void;
  ms: number;
}

/** Minuteur manuel : rien ne s'exécute tant que le test ne le demande pas. */
export class ManualTimers implements TimerApi {
  private nextId = 1;
  private readonly pendingMap = new Map<number, PendingTimer>();
  /** Nombre total d'appels à `set` / `clear` (pour vérifier le nettoyage). */
  setCount = 0;
  clearCount = 0;

  set(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.setCount++;
    this.pendingMap.set(id, { id, fn, ms });
    return id;
  }
  clear(handle: unknown): void {
    this.clearCount++;
    this.pendingMap.delete(handle as number);
  }
  get pending(): number {
    return this.pendingMap.size;
  }
  /** Exécute une fois chaque minuteur en attente (ceux armés pendant l'exécution attendent le prochain appel). */
  fireAll(): void {
    const batch = [...this.pendingMap.values()];
    for (const t of batch) {
      if (!this.pendingMap.has(t.id)) continue;
      this.pendingMap.delete(t.id);
      t.fn();
    }
  }
  /** Durées (ms) des minuteurs en attente. */
  pendingDelays(): number[] {
    return [...this.pendingMap.values()].map((t) => t.ms);
  }
}

/** Visibilité manuelle. */
export class ManualVisibility implements VisibilityApi {
  hidden = false;
  readonly listeners = new Set<() => void>();
  isHidden(): boolean {
    return this.hidden;
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  set(hidden: boolean): void {
    this.hidden = hidden;
    for (const l of [...this.listeners]) l();
  }
}
