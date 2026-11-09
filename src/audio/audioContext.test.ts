import { afterEach, describe, expect, it, vi } from 'vitest';
import { UNLOCK_EVENTS, getAudioContext, installAudioUnlock, resetAudioContextForTests, resumeAudio } from './audioContext';
import { getMusic, resetMusicForTests } from './music';
import { musicSettings } from './musicSettings';

afterEach(() => {
  vi.unstubAllGlobals();
  resetAudioContextForTests();
  resetMusicForTests();
});

class FakeAudioContextCtor {
  static instances = 0;
  state: 'running' | 'suspended' = 'suspended';
  resumeCalls = 0;
  constructor() {
    FakeAudioContextCtor.instances++;
  }
  resume(): Promise<void> {
    this.resumeCalls++;
    this.state = 'running';
    return Promise.resolve();
  }
}

/** Cible d'événements minimale. */
function fakeTarget() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    listeners,
    addEventListener(name: string, fn: () => void): void {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(fn);
    },
    removeEventListener(name: string, fn: () => void): void {
      listeners.get(name)?.delete(fn);
    },
    fire(name: string): void {
      for (const fn of [...(listeners.get(name) ?? [])]) fn();
    },
    count(): number {
      let n = 0;
      for (const s of listeners.values()) n += s.size;
      return n;
    },
  };
}

describe('contexte audio partagé', () => {
  it('sans AudioContext (Node, bots) : null, sans exception, et resumeAudio ne fait rien', () => {
    expect(getAudioContext()).toBeNull();
    expect(getAudioContext()).toBeNull();
    expect(() => resumeAudio()).not.toThrow();
  });

  it('un seul contexte pour tous les appelants (effets sonores et musique), créé paresseusement', () => {
    FakeAudioContextCtor.instances = 0;
    vi.stubGlobal('AudioContext', FakeAudioContextCtor);
    expect(FakeAudioContextCtor.instances).toBe(0);
    const a = getAudioContext();
    const b = getAudioContext();
    expect(a).not.toBeNull();
    expect(b).toBe(a);
    expect(FakeAudioContextCtor.instances).toBe(1);
  });

  it('constructeur qui lève : null, et on ne réessaie pas en boucle', () => {
    let calls = 0;
    vi.stubGlobal(
      'AudioContext',
      class {
        constructor() {
          calls++;
          throw new Error('refusé');
        }
      },
    );
    expect(getAudioContext()).toBeNull();
    expect(getAudioContext()).toBeNull();
    expect(calls).toBe(1);
  });

  it("un constructeur qui a levé hors geste n'est pas mémorisé pour toute la session : retenté au premier geste (installAudioUnlock)", () => {
    let calls = 0;
    vi.stubGlobal(
      'AudioContext',
      class extends FakeAudioContextCtor {
        constructor() {
          super();
          calls++;
          if (calls === 1) throw new Error('refusé hors geste');
        }
      },
    );
    expect(getAudioContext()).toBeNull();
    expect(getAudioContext()).toBeNull();
    expect(calls).toBe(1); // pas de nouvelle tentative entre deux gestes
    const target = fakeTarget();
    installAudioUnlock(target);
    target.fire('pointerdown'); // le geste : nouvelle tentative, qui réussit
    expect(calls).toBe(2);
    expect(getAudioContext()).not.toBeNull();
    expect(getAudioContext()).toBe(getAudioContext());
    expect(target.count()).toBe(0); // contexte en marche : écouteurs retirés
  });

  it("préfixe webkit pris en charge", () => {
    vi.stubGlobal('webkitAudioContext', FakeAudioContextCtor);
    expect(getAudioContext()).not.toBeNull();
  });

  it('resumeAudio reprend un contexte suspendu', () => {
    vi.stubGlobal('AudioContext', FakeAudioContextCtor);
    const ctx = getAudioContext() as unknown as FakeAudioContextCtor;
    resumeAudio();
    expect(ctx.resumeCalls).toBe(1);
    expect(ctx.state).toBe('running');
    resumeAudio();
    expect(ctx.resumeCalls).toBe(1); // déjà en marche
  });
});

describe('déblocage de l\'audio au premier geste (politique d\'autoplay)', () => {
  it('écoute pointeur, tactile et clavier ; le premier geste crée et reprend le contexte puis les écouteurs se retirent', () => {
    vi.stubGlobal('AudioContext', FakeAudioContextCtor);
    const target = fakeTarget();
    installAudioUnlock(target);
    expect(target.count()).toBe(UNLOCK_EVENTS.length);
    for (const name of ['pointerdown', 'touchstart', 'touchend', 'keydown']) expect(UNLOCK_EVENTS).toContain(name);
    target.fire('touchend');
    const ctx = getAudioContext() as unknown as FakeAudioContextCtor;
    expect(ctx.resumeCalls).toBe(1);
    expect(ctx.state).toBe('running');
    expect(target.count()).toBe(0);
  });

  it("contexte interrompu (iOS) après le déblocage : l'événement statechange ré-arme les écouteurs, le geste suivant reprend le contexte", () => {
    const stateListeners = new Set<() => void>();
    class InterruptibleCtor extends FakeAudioContextCtor {
      addEventListener(name: string, fn: () => void): void {
        if (name === 'statechange') stateListeners.add(fn);
      }
      removeEventListener(name: string, fn: () => void): void {
        if (name === 'statechange') stateListeners.delete(fn);
      }
    }
    vi.stubGlobal('AudioContext', InterruptibleCtor);
    const target = fakeTarget();
    const off = installAudioUnlock(target);
    target.fire('keydown');
    const ctx = getAudioContext() as unknown as InterruptibleCtor & { state: string };
    expect(ctx.state).toBe('running');
    expect(target.count()).toBe(0);
    expect(stateListeners.size).toBe(1);
    // appel entrant : le navigateur interrompt le contexte
    ctx.state = 'interrupted' as never;
    for (const fn of [...stateListeners]) fn();
    expect(target.count()).toBe(UNLOCK_EVENTS.length);
    target.fire('touchend');
    expect(ctx.state).toBe('running');
    expect(target.count()).toBe(0);
    off();
    expect(stateListeners.size).toBe(0);
  });

  it('sans WebAudio : le premier geste ne lève pas et retire les écouteurs', () => {
    const target = fakeTarget();
    installAudioUnlock(target);
    expect(() => target.fire('keydown')).not.toThrow();
    expect(target.count()).toBe(0);
  });

  it('la fonction de nettoyage retire les écouteurs ; sans cible (Node) : ne fait rien', () => {
    const target = fakeTarget();
    const off = installAudioUnlock(target);
    off();
    off();
    expect(target.count()).toBe(0);
    expect(() => installAudioUnlock(null)()).not.toThrow();
  });
});

describe('façade musique sans AudioContext (bots, tests)', () => {
  it('toutes les commandes sont silencieuses et sans exception', () => {
    const m = getMusic();
    expect(getMusic()).toBe(m);
    expect(() => {
      m.start();
      m.setDucked(true);
      m.setMuted(true);
      m.setMuted(false);
      m.nudge();
      m.stop();
    }).not.toThrow();
    expect(m.status).toBe('idle');
  });

  it('suit le réglage mémorisé et le forçage ?music=0', () => {
    const m = getMusic();
    musicSettings.setOverride(false);
    expect(m.isWanted).toBe(false);
    musicSettings.setOverride(null);
    expect(m.targetGain).toBeGreaterThan(0);
  });
});
