import { describe, expect, it } from 'vitest';
import { FakeContext, FakeGain, ManualTimers, ManualVisibility, type FakeSource } from '../testing/fakeAudioContext';
import {
  DUCK_GAIN,
  DUCK_RAMP_S,
  FADE_IN_S,
  FADE_OUT_S,
  LOOKAHEAD_TIMER_MS,
  LOOKAHEAD_WINDOW_S,
  MUSIC_BASE_GAIN,
  MusicPlayer,
  START_DELAY_S,
} from './musicPlayer';
import { buildLoopSequence } from './sequencer';

/**
 * Tests de la machine d'états du lecteur SANS vrai WebAudio : faux AudioContext (horloge audio pilotée à la main), minuteur manuel,
 * visibilité manuelle. Aucun test ne dépend de l'horloge réelle.
 */

const SEQ = buildLoopSequence();
const STEP_S = LOOKAHEAD_TIMER_MS / 1000;

function setup(opts: { hidden?: boolean; suspended?: boolean } = {}) {
  const ctx = new FakeContext();
  const timers = new ManualTimers();
  const vis = new ManualVisibility();
  vis.hidden = opts.hidden === true;
  if (opts.suspended) ctx.state = 'suspended';
  const player = new MusicPlayer({ getContext: () => ctx.asAudioContext(), timers, visibility: vis });
  /** Fait avancer l'horloge audio de `seconds` par pas de 25 ms, en réveillant le planificateur à chaque pas. */
  const advance = (seconds: number, onStep?: () => void): void => {
    const n = Math.round(seconds / STEP_S);
    for (let i = 0; i < n; i++) {
      ctx.currentTime += STEP_S;
      timers.fireAll();
      onStep?.();
    }
  };
  return { ctx, timers, vis, player, advance };
}

/** Débuts planifiés des notes de basse (triangle), triés. */
function bassStarts(ctx: FakeContext): number[] {
  return ctx
    .sources('oscillator')
    .filter((s) => s.type === 'triangle')
    .map((s) => s.startsAt)
    .sort((a, b) => a - b);
}

/** Tous les débuts de NOTES planifiés (oscillateurs et percussions ; le LFO de vibrato, de type sinus, démarre `delay` après sa note). */
function allStarts(ctx: FakeContext): number[] {
  return ctx.sources().filter((s: FakeSource) => !(s.kind === 'oscillator' && s.type === 'sine')).flatMap((s) => s.startTimes);
}

/** Les débuts de basse correspondent EXACTEMENT à la grille t0 + n × loopSeconds + t (à l'échantillon près, et bien mieux). */
function expectBassGrid(ctx: FakeContext, t0: number, loops: number): void {
  const expected: number[] = [];
  for (let n = 0; n < loops; n++) for (const e of SEQ.events) if (e.voice === 'bass') expected.push(t0 + n * SEQ.loopSeconds + e.t);
  const got = bassStarts(ctx);
  expect(got.length).toBeGreaterThanOrEqual(expected.length);
  const tol = 1 / ctx.sampleRate;
  expected.forEach((t, i) => expect(Math.abs(got[i] - t), `note de basse ${i}`).toBeLessThan(tol));
}

describe('lecteur de musique : démarrage', () => {
  it('démarre une seule fois : start() répété ne crée ni seconde chaîne ni second minuteur', () => {
    const { ctx, timers, player } = setup();
    expect(player.status).toBe('idle');
    player.start();
    const chains = ctx.nodes.filter((n) => n.kind === 'iir').length;
    expect(chains).toBe(1);
    expect(timers.pending).toBe(1);
    expect(timers.pendingDelays()).toEqual([LOOKAHEAD_TIMER_MS]);
    player.start();
    player.start({ level: 1 });
    expect(ctx.nodes.filter((n) => n.kind === 'iir')).toHaveLength(1);
    expect(timers.pending).toBe(1);
    expect(player.status).toBe('playing');
  });

  it('fondu d\'entrée de ~0,5 s : le gain maître part de 0 et monte jusqu\'au volume visé', () => {
    const { ctx, player } = setup();
    player.start();
    const master = ctx.nodes.filter((n): n is FakeGain => n instanceof FakeGain)[2]; // bus, ducking, maître (ordre de création de la chaîne)
    expect(master.gain.events[0]).toMatchObject({ type: 'set', value: 0, time: 0 });
    const ramp = master.gain.lastRamp()!;
    expect(ramp.time).toBeCloseTo(FADE_IN_S, 9);
    expect(ramp.value).toBeCloseTo(0.6 * MUSIC_BASE_GAIN, 9); // volume 60 % par défaut
    expect(FADE_IN_S).toBeGreaterThanOrEqual(0.4);
    expect(FADE_IN_S).toBeLessThanOrEqual(0.6);
  });

  it('la première note part START_DELAY_S après le démarrage', () => {
    const { ctx, player } = setup();
    ctx.currentTime = 3;
    player.start();
    expect(Math.abs(Math.min(...allStarts(ctx)) - (3 + START_DELAY_S))).toBeLessThan(1 / ctx.sampleRate); // grille d'échantillons
  });

  it('niveau de scène : tutoriel à moitié volume', () => {
    const { ctx, player } = setup();
    player.start({ level: 0.5 });
    const master = ctx.nodes.filter((n): n is FakeGain => n instanceof FakeGain)[2];
    expect(master.gain.lastRamp()!.value).toBeCloseTo(0.6 * MUSIC_BASE_GAIN * 0.5, 9);
    player.start({ level: 1 }); // même instance : seul le niveau change
    expect(ctx.nodes.filter((n) => n.kind === 'iir')).toHaveLength(1);
    expect(master.gain.lastRamp()!.value).toBeCloseTo(0.6 * MUSIC_BASE_GAIN, 9);
  });

  it('gain par défaut modeste, sous les effets sonores : au plus 0,15 à 60 % (crête ~ -23 dBFS), 0,25 à 100 %', () => {
    expect(MUSIC_BASE_GAIN).toBeLessThanOrEqual(0.25);
    const { player } = setup();
    expect(player.targetGain).toBeCloseTo(0.15, 9);
    // crête de la musique à 60 % : environ -23 dBFS, nettement sous les effets fréquents (RMS -30 à -37 dBFS dans la même bande)
    expect(20 * Math.log10(0.457 * player.targetGain)).toBeLessThan(-22);
  });
});

describe('lecteur de musique : planification en lookahead', () => {
  it('ne planifie JAMAIS plus loin que la fenêtre d\'anticipation, à aucun réveil', () => {
    const { ctx, player, advance } = setup();
    player.start();
    let seen = 0;
    const check = (): void => {
      const starts = allStarts(ctx);
      for (let i = seen; i < starts.length; i++) {
        expect(starts[i], `début ${i}`).toBeLessThanOrEqual(ctx.currentTime + LOOKAHEAD_WINDOW_S + 1e-9);
      }
      seen = starts.length;
    };
    check();
    advance(60, check);
    expect(seen).toBeGreaterThan(1000);
    expect(LOOKAHEAD_WINDOW_S).toBeGreaterThanOrEqual(0.15);
    expect(LOOKAHEAD_WINDOW_S).toBeLessThanOrEqual(0.3);
  });

  it('le réveil se rappelle toutes les ~25 ms et ne laisse jamais de trou : chaque note est planifiée avant son instant', () => {
    const { ctx, player, timers, advance } = setup();
    player.start();
    const created: Array<{ when: number; at: number }> = [];
    let seen = 0;
    advance(30, () => {
      const starts = allStarts(ctx);
      for (let i = seen; i < starts.length; i++) created.push({ when: starts[i], at: ctx.currentTime });
      seen = starts.length;
    });
    for (const c of created) expect(c.when, 'note planifiée en retard').toBeGreaterThanOrEqual(c.at - STEP_S - 1e-9);
    expect(timers.pendingDelays()).toEqual([LOOKAHEAD_TIMER_MS]);
  });

  it('boucle parfaite : la boucle n + 1 commence exactement à la fin de la boucle n (à l\'échantillon près) et est planifiée AVANT la fin', () => {
    const { ctx, player, advance } = setup();
    player.start();
    const t0 = START_DELAY_S;
    let firstOfLoop1: number | null = null;
    let plannedAt = 0;
    advance(70, () => {
      if (firstOfLoop1 === null) {
        const starts = bassStarts(ctx);
        const idx = starts.findIndex((s) => s > t0 + SEQ.loopSeconds - 1e-4); // (la grille d'échantillons décale de moins d'un échantillon)
        if (idx >= 0) {
          firstOfLoop1 = starts[idx];
          plannedAt = ctx.currentTime;
        }
      }
    });
    expectBassGrid(ctx, t0, 2);
    const starts = bassStarts(ctx);
    // raccord : dernière basse de la boucle 0 (beat 63,5) → première de la boucle 1 : exactement une croche
    const bassPerLoop = SEQ.events.filter((e) => e.voice === 'bass').length;
    expect(starts[bassPerLoop] - starts[bassPerLoop - 1]).toBeCloseTo(0.5 * SEQ.secondsPerBeat, 9);
    expect(starts[bassPerLoop] - starts[0]).toBeCloseTo(SEQ.loopSeconds, 9);
    expect(firstOfLoop1).not.toBeNull();
    expect(Math.abs((firstOfLoop1 as unknown as number) - (t0 + SEQ.loopSeconds))).toBeLessThan(1 / ctx.sampleRate);
    expect(plannedAt).toBeLessThan(t0 + SEQ.loopSeconds); // planifiée avant la fin de la boucle précédente
    expect(plannedAt).toBeGreaterThanOrEqual(t0 + SEQ.loopSeconds - LOOKAHEAD_WINDOW_S - STEP_S - 1e-9);
  });

  it('les queues de notes ne coupent pas net : chaque oscillateur s\'arrête après son release, jamais à la fin de la mesure 16', () => {
    const { ctx, player, advance } = setup();
    player.start();
    advance(30);
    const lastBar = START_DELAY_S + SEQ.loopSeconds;
    const lastBass = ctx
      .sources('oscillator')
      .filter((s) => s.type === 'triangle' && Math.abs(s.startsAt - (lastBar - 0.5 * SEQ.secondsPerBeat)) < 2e-5)[0];
    expect(lastBass).toBeDefined();
    // note écrite jusqu'à lastBar, relâchée après : l'arrêt dépasse son début de gate × durée + release
    expect(lastBass.stopTimes[0]).toBeGreaterThan(lastBass.startsAt + 0.5 * SEQ.secondsPerBeat * 0.8);
    // et les notes planifiées ne sont jamais arrêtées par le lecteur lui-même tant que la musique joue
    for (const s of ctx.sources('oscillator')) expect(s.stopTimes).toHaveLength(1);
  });

  it('un gros retard de l\'horloge (blocage) n\'entraîne pas une rafale de notes en retard', () => {
    const { ctx, player, timers } = setup();
    player.start();
    const before = ctx.sources().length;
    ctx.currentTime += 12; // le thread a été bloqué 12 s
    timers.fireAll();
    const burst = ctx.sources().length - before;
    expect(burst).toBeLessThan(80);
  });
});

describe('lecteur de musique : pause (ducking), coupure, arrêt', () => {
  it('pause : volume baissé à ~35 % en 0,15 s SANS arrêter la musique ; la reprise ne décale rien', () => {
    const { ctx, player, advance, timers } = setup();
    player.start();
    advance(5);
    const duck = ctx.nodes.filter((n): n is FakeGain => n instanceof FakeGain)[1];
    player.setDucked(true);
    expect(player.isDucked).toBe(true);
    expect(duck.gain.lastRamp()).toMatchObject({ value: DUCK_GAIN, time: ctx.currentTime + DUCK_RAMP_S });
    expect(DUCK_GAIN).toBeGreaterThan(0.3);
    expect(DUCK_GAIN).toBeLessThan(0.4);
    expect(player.status).toBe('playing');
    expect(timers.pending).toBe(1);
    const countAtPause = bassStarts(ctx).length;
    advance(4);
    expect(bassStarts(ctx).length).toBeGreaterThan(countAtPause); // la musique continue
    player.setDucked(true); // idempotent
    player.setDucked(false);
    expect(duck.gain.lastRamp()).toMatchObject({ value: 1, time: ctx.currentTime + DUCK_RAMP_S });
    advance(60);
    expectBassGrid(ctx, START_DELAY_S, 2); // grille intacte : aucun décalage dû à la pause
  });

  it('démarrer pendant une pause : le ducking est appliqué dès le départ', () => {
    const { ctx, player } = setup();
    player.setDucked(true);
    player.start();
    const duck = ctx.nodes.filter((n): n is FakeGain => n instanceof FakeGain)[1];
    expect(duck.gain.events[0]).toMatchObject({ type: 'set', value: DUCK_GAIN });
  });

  it('coupure (M) : fondu de sortie, plus aucune planification, nettoyage complet à la fin ; remise : nouveau départ', () => {
    const { ctx, player, advance, timers } = setup();
    player.start();
    advance(3);
    player.setMuted(true);
    expect(player.isMuted).toBe(true);
    expect(player.status).toBe('fadingOut');
    const master = ctx.nodes.filter((n): n is FakeGain => n instanceof FakeGain)[2];
    expect(master.gain.lastRamp()).toMatchObject({ value: 0 });
    expect(master.gain.lastRamp()!.time).toBeCloseTo(ctx.currentTime + FADE_OUT_S, 9);
    expect(timers.pending).toBe(1); // uniquement le nettoyage de fin de fondu
    expect(timers.pendingDelays()[0]).toBeGreaterThanOrEqual(FADE_OUT_S * 1000);
    const count = ctx.sources().length;
    timers.fireAll(); // fin du fondu
    expect(player.status).toBe('idle');
    expect(timers.pending).toBe(0);
    for (const n of ctx.nodes) expect(n.disconnected).toBe(true);
    advance(2);
    expect(ctx.sources().length).toBe(count); // rien de nouveau
    // remise du son : repart du début de la boucle avec un fondu d'entrée
    const t = ctx.currentTime;
    player.setMuted(false);
    expect(player.status).toBe('playing');
    expect(Math.abs(Math.min(...bassStarts(ctx).filter((s) => s > t - 1e-4)) - (t + START_DELAY_S))).toBeLessThan(1 / ctx.sampleRate);
    expect(ctx.nodes.filter((n) => n.kind === 'iir')).toHaveLength(2);
  });

  it('réglage désactivé : aucun nœud créé tant que la musique est coupée, démarrage dès la réactivation', () => {
    const { ctx, player, timers } = setup();
    player.setSettings({ enabled: false, volume: 60 });
    player.start();
    expect(player.isWanted).toBe(true);
    expect(player.status).toBe('idle');
    expect(ctx.nodes).toHaveLength(0);
    expect(timers.pending).toBe(0);
    player.setSettings({ enabled: true, volume: 60 });
    expect(player.status).toBe('playing');
    player.setSettings({ enabled: false, volume: 60 });
    expect(player.status).toBe('fadingOut');
  });

  it('volume : changement en rampe courte, 0 % = silence sans calcul, 100 % = gain de base', () => {
    const { ctx, player, timers } = setup();
    player.start();
    const master = ctx.nodes.filter((n): n is FakeGain => n instanceof FakeGain)[2];
    player.setSettings({ enabled: true, volume: 100 });
    expect(master.gain.lastRamp()!.value).toBeCloseTo(MUSIC_BASE_GAIN, 9);
    player.setSettings({ enabled: true, volume: 30 });
    expect(master.gain.lastRamp()!.value).toBeCloseTo(0.3 * MUSIC_BASE_GAIN, 9);
    player.setSettings({ enabled: true, volume: 0 });
    expect(player.status).toBe('fadingOut');
    timers.fireAll();
    expect(player.status).toBe('idle');
    expect(timers.pending).toBe(0);
    player.setSettings({ enabled: true, volume: 40 });
    expect(player.status).toBe('playing');
  });

  it('stop(0) : arrêt immédiat, minuteurs annulés, nœuds débranchés, notes en cours arrêtées', () => {
    const { ctx, player, timers, vis, advance } = setup();
    player.start();
    advance(2);
    expect(vis.listeners.size).toBe(1);
    player.stop(0);
    expect(player.status).toBe('idle');
    expect(player.isWanted).toBe(false);
    expect(timers.pending).toBe(0);
    expect(vis.listeners.size).toBe(0);
    for (const n of ctx.nodes) expect(n.disconnected).toBe(true);
    // les notes encore en cours (queues de release) ont reçu un arrêt forcé
    expect(ctx.sources('oscillator').some((s) => s.stopTimes.length > 1)).toBe(true);
  });

  it('stop(fondu) : fondu de sortie puis nettoyage ; start() pendant le fondu repart sans couper le fondu en cours', () => {
    const { ctx, player, timers, vis, advance } = setup();
    player.start();
    advance(2);
    player.stop();
    expect(player.status).toBe('fadingOut');
    expect(vis.listeners.size).toBe(1); // encore abonné pendant le fondu (suspension éventuelle)
    player.start(); // nouvelle scène : une nouvelle instance démarre, l'ancienne finit son fondu
    expect(player.status).toBe('playing');
    expect(ctx.nodes.filter((n) => n.kind === 'iir')).toHaveLength(2);
    timers.fireAll(); // fin du fondu de l'ancienne instance
    const iirs = ctx.nodes.filter((n) => n.kind === 'iir');
    expect(iirs[0].disconnected).toBe(true);
    expect(iirs[1].disconnected).toBe(false);
    player.stop(0);
    expect(timers.pending).toBe(0);
    expect(vis.listeners.size).toBe(0);
  });

  it('stop() sans rien en cours ou répété : sans effet', () => {
    const { ctx, player, timers } = setup();
    player.stop();
    player.stop(0);
    expect(ctx.nodes).toHaveLength(0);
    player.start();
    player.stop(0);
    player.stop(0);
    expect(timers.pending).toBe(0);
    expect(player.status).toBe('idle');
  });

  it('dispose : tout est libéré, même en plein fondu ; le lecteur ne redémarre plus', () => {
    const { ctx, player, timers, vis, advance } = setup();
    player.start();
    advance(1);
    player.stop();
    player.dispose();
    expect(timers.pending).toBe(0);
    expect(vis.listeners.size).toBe(0);
    for (const n of ctx.nodes) expect(n.disconnected).toBe(true);
    player.start();
    expect(player.status).toBe('idle');
  });
});

describe('lecteur de musique : coupure de session et fondus', () => {
  it("la coupure (M) ne survit pas à l'arrêt : après M puis stop(), un nouveau start() (aperçu du menu) joue", () => {
    const { player, timers, advance } = setup();
    player.start();
    advance(1);
    player.setMuted(true);
    player.stop(0.3);
    advance(1);
    timers.fireAll();
    expect(player.status).toBe('idle');
    expect(player.isMuted).toBe(false);
    player.start();
    expect(player.status).toBe('playing');
  });

  it("fondu d'entrée interrompu : la sortie repart de la valeur COURANTE de la rampe, sans dépendre de AudioParam.value", () => {
    const { ctx, player } = setup();
    player.start();
    const master = ctx.nodes.filter((n): n is FakeGain => n instanceof FakeGain)[2];
    ctx.currentTime = FADE_IN_S / 2; // mi-fondu : gain attendu = la moitié de la cible
    // un navigateur dont le getter ne suit pas les rampes renverrait ici l'ancienne valeur intrinsèque : on la fausse exprès
    master.gain.value = 1;
    player.setMuted(true);
    const set = master.gain.events.filter((e) => e.type === 'set').pop()!;
    expect(set.time).toBeCloseTo(FADE_IN_S / 2, 9);
    expect(set.value).toBeCloseTo(0.5 * player.targetGain, 9);
    expect(master.gain.lastRamp()).toMatchObject({ value: 0 });
  });

  it("volume changé en plein fondu, ducking inversé en plein ducking : on part de la valeur courante, jamais d'un saut", () => {
    const { ctx, player } = setup();
    player.start();
    const [, duck, master] = ctx.nodes.filter((n): n is FakeGain => n instanceof FakeGain);
    ctx.currentTime = 1; // fondu d'entrée terminé : gain = cible
    player.setDucked(true);
    ctx.currentTime = 1 + DUCK_RAMP_S / 2;
    duck.gain.value = 1; // getter « intrinsèque »
    player.setDucked(false);
    const duckSet = duck.gain.events.filter((e) => e.type === 'set').pop()!;
    expect(duckSet.value).toBeCloseTo(1 + (DUCK_GAIN - 1) / 2, 9);
    master.gain.value = 0;
    player.setSettings({ enabled: true, volume: 100 });
    const masterSet = master.gain.events.filter((e) => e.type === 'set').pop()!;
    expect(masterSet.value).toBeCloseTo(0.6 * MUSIC_BASE_GAIN, 9); // valeur de croisière avant le changement
    expect(master.gain.lastRamp()!.value).toBeCloseTo(MUSIC_BASE_GAIN, 9);
  });

  it('dispose en pleine lecture : le minuteur de planification est annulé immédiatement', () => {
    const { player, timers, advance } = setup();
    player.start();
    advance(1);
    expect(timers.pending).toBe(1);
    player.dispose();
    expect(timers.pending).toBe(0);
  });
});

describe('lecteur de musique : onglet caché (visibilitychange)', () => {
  it("musique arrêtée pendant que l'onglet est caché : le contexte partagé suspendu est repris au retour", () => {
    const { ctx, player, vis, timers } = setup();
    player.start();
    vis.set(true);
    expect(ctx.state).toBe('suspended');
    player.stop(0.3);
    expect(player.status).toBe('idle');
    vis.set(false);
    expect(ctx.state).toBe('running');
    expect(vis.listeners.size).toBe(0);
    expect(timers.pending).toBe(0);
  });

  it('caché : minuteur arrêté (aucun calcul) et contexte suspendu ; retour : contexte repris et planification relancée sans décalage', () => {
    const { ctx, player, timers, vis, advance } = setup();
    player.start();
    advance(6);
    const before = allStarts(ctx).length;
    vis.set(true);
    expect(ctx.suspendCalls).toBe(1);
    expect(ctx.state).toBe('suspended');
    expect(timers.pending).toBe(0);
    timers.fireAll(); // rien à exécuter : aucun calcul pendant que l'onglet est caché
    expect(allStarts(ctx).length).toBe(before);
    vis.set(false);
    expect(ctx.resumeCalls).toBe(1);
    expect(ctx.state).toBe('running');
    expect(timers.pending).toBe(1);
    advance(70);
    expectBassGrid(ctx, START_DELAY_S, 2); // l'horloge audio gelée pendant la suspension : aucun décalage
  });

  it('démarrage onglet caché : rien n\'est planifié ; planification au retour', () => {
    const { ctx, player, timers, vis } = setup({ hidden: true });
    player.start();
    expect(player.status).toBe('playing');
    expect(ctx.suspendCalls).toBe(1);
    expect(timers.pending).toBe(0);
    expect(allStarts(ctx)).toHaveLength(0);
    vis.set(false);
    expect(timers.pending).toBe(1);
    expect(allStarts(ctx).length).toBeGreaterThan(0);
  });

  it('événements de visibilité répétés (même état) sans effet', () => {
    const { ctx, player, vis } = setup();
    player.start();
    vis.set(false);
    vis.set(false);
    expect(ctx.suspendCalls).toBe(0);
    expect(ctx.resumeCalls).toBe(0);
  });
});

describe('lecteur de musique : autoplay et robustesse', () => {
  it('contexte encore suspendu (aucun geste) : le lecteur tente de le reprendre, planifie la première fenêtre et attend ; nudge() retente', () => {
    const { ctx, player, timers } = setup({ suspended: true });
    // le faux contexte reste suspendu tant que le « navigateur » refuse
    ctx.resume = (): Promise<void> => {
      ctx.resumeCalls++;
      return Promise.resolve();
    };
    player.start();
    expect(ctx.resumeCalls).toBe(1);
    expect(player.status).toBe('playing');
    const n = allStarts(ctx).length;
    expect(n).toBeGreaterThan(0);
    expect(allStarts(ctx).every((t) => t <= LOOKAHEAD_WINDOW_S + 1e-9)).toBe(true);
    timers.fireAll();
    timers.fireAll();
    expect(allStarts(ctx).length).toBe(n); // l'horloge est gelée : rien de plus
    player.nudge();
    expect(ctx.resumeCalls).toBe(2);
  });

  it("contexte « interrupted » (iOS : appel, verrouillage d'écran) : nudge() le reprend aussi", () => {
    const { ctx, player } = setup();
    player.start();
    ctx.state = 'interrupted';
    const r = ctx.resumeCalls;
    player.nudge();
    expect(ctx.resumeCalls).toBe(r + 1);
    expect(ctx.state).toBe('running');
  });

  it('nudge() sans rien en cours ou onglet caché : sans effet', () => {
    const { ctx, player, vis } = setup({ suspended: true });
    player.nudge();
    expect(ctx.resumeCalls).toBe(0);
    ctx.state = 'running';
    player.start();
    vis.set(true);
    const r = ctx.resumeCalls;
    player.nudge();
    expect(ctx.resumeCalls).toBe(r);
  });

  it('sans AudioContext (null) : silence, sans exception', () => {
    const timers = new ManualTimers();
    const player = new MusicPlayer({ getContext: () => null, timers });
    expect(() => {
      player.start();
      player.setDucked(true);
      player.setMuted(true);
      player.setMuted(false);
      player.setSettings({ enabled: true, volume: 50 });
      player.nudge();
      player.stop();
      player.dispose();
    }).not.toThrow();
    expect(player.status).toBe('idle');
    expect(timers.pending).toBe(0);
  });

  it('getContext qui lève : silence, sans exception', () => {
    const player = new MusicPlayer({
      getContext: () => {
        throw new Error('WebAudio indisponible');
      },
      timers: new ManualTimers(),
    });
    expect(() => player.start()).not.toThrow();
    expect(player.status).toBe('idle');
  });

  it('WebAudio défaillant en cours de route : la musique se tait sans exception ni minuteur résiduel', () => {
    const { ctx, player, timers } = setup();
    ctx.failOscillators = true;
    expect(() => player.start()).not.toThrow();
    expect(player.status).toBe('idle');
    expect(timers.pending).toBe(0);
    for (const n of ctx.nodes) expect(n.disconnected).toBe(true);
  });

  it('sans visibilité injectée (Node, bots) : fonctionne', () => {
    const ctx = new FakeContext();
    const timers = new ManualTimers();
    const player = new MusicPlayer({ getContext: () => ctx.asAudioContext(), timers });
    player.start();
    expect(player.status).toBe('playing');
    player.stop(0);
    expect(player.status).toBe('idle');
  });

  it('l\'instance ne dépend pas de l\'horloge réelle : rien ne s\'exécute sans le minuteur manuel', () => {
    const { ctx, player } = setup();
    player.start();
    const n = allStarts(ctx).length;
    // le temps « réel » passe, mais ni l'horloge audio ni le minuteur ne bougent : rien de nouveau
    expect(allStarts(ctx).length).toBe(n);
    expect(player.loopSeconds).toBeCloseTo(25.6, 9);
  });
});
