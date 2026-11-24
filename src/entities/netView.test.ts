import { describe, expect, it } from 'vitest';
import { NET } from '../net/contracts';
import { MirrorClock, clampSnapshotInterval, playerOfView, viewOfPlayer } from './netView';
import { PosInterp } from './animation';

describe('MirrorClock : interpolation d\'un invité réseau', () => {
  it('avant le premier instantané : rien à interpoler', () => {
    const c = new MirrorClock();
    expect(c.hasSnapshot).toBe(false);
    expect(c.advance(16)).toEqual({ stepped: false, alpha: 1, timeMs: 0 });
  });

  it('la frame de l\'arrivée est « stepped » avec alpha 0 (un intervalle de retard), puis alpha croît', () => {
    const c = new MirrorClock();
    c.feed(1000, 50);
    const f0 = c.advance(16);
    expect(f0.stepped).toBe(true);
    expect(f0.alpha).toBe(0);
    const f1 = c.advance(10);
    expect(f1.stepped).toBe(false);
    expect(f1.alpha).toBeCloseTo(10 / 50, 6);
    const f2 = c.advance(15);
    expect(f2.alpha).toBeCloseTo(25 / 50, 6);
  });

  it('un second instantané : le précédent glisse vers le courant (positions d\'un PosInterp)', () => {
    const c = new MirrorClock();
    const pos = new PosInterp(0, 0);
    // instantané 1 : x = 0
    c.feed(0, 50);
    let f = c.advance(16);
    if (f.stepped) pos.push(0, 0);
    // 50 ms plus tard : instantané 2 : x = 8
    f = c.advance(50);
    expect(pos.at(f.alpha).x).toBe(0);
    c.feed(50, 50);
    f = c.advance(16);
    expect(f.stepped).toBe(true);
    pos.push(8, 0);
    expect(pos.at(f.alpha).x).toBe(0); // on affiche encore l'état précédent
    const xs: number[] = [];
    for (let i = 0; i < 4; i++) {
      f = c.advance(12.5);
      xs.push(pos.at(f.alpha).x);
    }
    expect(xs[0]).toBeCloseTo(2, 5);
    expect(xs[3]).toBeCloseTo(8, 5); // un intervalle plus tard : arrivé
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1]);
  });

  it('instantané tardif : on TIENT la dernière position (alpha plafonné à 1), sans extrapoler', () => {
    const c = new MirrorClock();
    c.feed(100, 50);
    c.advance(16);
    let last = c.advance(1000);
    expect(last.alpha).toBe(1);
    last = c.advance(1000);
    expect(last.alpha).toBe(1);
    expect(last.timeMs).toBe(100);
    expect(last.stepped).toBe(false);
  });

  it('instantané précoce : il attend la fin de l\'intervalle en cours (phase conservée), puis le segment suivant repart sans saut', () => {
    const c = new MirrorClock();
    const pos = new PosInterp(0, 0);
    c.feed(0, 50);
    let f = c.advance(16);
    pos.push(0, 0);
    f = c.advance(20); // alpha = 0,4
    c.feed(50, 50); // arrive à 20 ms au lieu de 50 : trop tôt
    f = c.advance(10);
    expect(f.stepped).toBe(false); // pas encore : l\'état précédent continue de glisser
    expect(f.alpha).toBeCloseTo(0.6, 6);
    f = c.advance(4);
    expect(f.stepped).toBe(false);
    expect(f.alpha).toBeCloseTo(0.68, 6);
    f = c.advance(16); // 50 ms écoulées : l\'instantané avance
    expect(f.stepped).toBe(true);
    expect(f.alpha).toBe(0);
    pos.push(8, 0);
    expect(pos.at(f.alpha).x).toBe(0);
  });

  it('gigue : un instantané en avance puis en retard ne fait JAMAIS sauter l\'affichage (déplacement par frame borné par la vitesse nominale)', () => {
    // vitesse nominale : 8 px par instantané de 50 ms ; arrivées à des instants irréguliers (±20 ms), rendu à 60 Hz
    const arrivals: number[] = [];
    let t = 0;
    const jitter = [0, -20, 20, -15, 25, -25, 10, 0, -20, 20, 15, -15, 0, 20, -20];
    for (let i = 0; i < 60; i++) arrivals.push(i * 50 + jitter[i % jitter.length] + 100);
    const c = new MirrorClock();
    const pos = new PosInterp(0, 0);
    let n = 0;
    let lastX = 0;
    let maxStep = 0;
    let started = false;
    for (let frame = 0; frame < 190; frame++) {
      t += 1000 / 60;
      while (n < arrivals.length && arrivals[n] <= t) {
        c.feed(n * 50, 50);
        n++;
      }
      const f = c.advance(1000 / 60);
      if (f.stepped) pos.push(n * 8, 0);
      const x = pos.at(f.alpha).x;
      if (started) maxStep = Math.max(maxStep, Math.abs(x - lastX));
      if (c.hasSnapshot) started = true;
      lastX = x;
    }
    // nominal : 8 px par 50 ms = 2,67 px par frame ; un instantané sauté (deux reçus dans le même intervalle) peut ajouter un segment, jamais un saut brutal
    expect(maxStep).toBeLessThan(8 * (1000 / 60 / 50) * 2.1);
  });

  it('instantané très tardif : position tenue puis reprise depuis la position tenue (alpha 0)', () => {
    const c = new MirrorClock();
    c.feed(0, 50);
    c.advance(16);
    c.advance(200); // en retard : tenu
    expect(c.advance(16).alpha).toBe(1);
    c.feed(50, 50);
    const f = c.advance(16);
    expect(f.stepped).toBe(true);
    expect(f.alpha).toBe(0);
  });

  it('longue suspension de l\'affichage : le dépassement reporté est plafonné (pas de saut jusqu\'à la cible)', () => {
    const c = new MirrorClock();
    c.feed(0, 50);
    c.advance(16);
    c.feed(50, 50);
    const f = c.advance(5000);
    expect(f.stepped).toBe(true);
    expect(f.alpha).toBeLessThanOrEqual(0.5);
  });

  it('timeMs : interpolé entre le temps du précédent et du courant instantané, jamais en arrière', () => {
    const c = new MirrorClock();
    c.feed(1000, 50);
    c.advance(16);
    c.feed(1050, 50);
    let prev = c.advance(10).timeMs; // l\'instantané attend la fin de l\'intervalle : on est encore à 1000
    expect(prev).toBe(1000);
    for (let i = 0; i < 12; i++) {
      const t = c.advance(10).timeMs;
      expect(t).toBeGreaterThanOrEqual(prev);
      expect(t).toBeLessThanOrEqual(1050);
      prev = t;
    }
    expect(prev).toBeGreaterThan(1000);
    // instantané précoce : le temps affiché ne recule pas
    const c2 = new MirrorClock();
    c2.feed(0, 50);
    c2.advance(16);
    c2.feed(50, 50);
    c2.advance(16);
    const mid = c2.advance(20).timeMs;
    c2.feed(100, 50);
    expect(c2.advance(16).timeMs).toBeGreaterThanOrEqual(mid);
  });

  it('stepped ne vaut vrai qu\'une frame, sans nouvel instantané les vues ne re-poussent rien', () => {
    const c = new MirrorClock();
    c.feed(0, 50);
    expect(c.advance(16).stepped).toBe(true);
    for (let i = 0; i < 10; i++) expect(c.advance(16).stepped).toBe(false);
  });

  it('l\'intervalle est borné à [INTERP_MIN_MS, INTERP_MAX_MS], valeur nominale si invalide', () => {
    expect(clampSnapshotInterval(1)).toBe(NET.INTERP_MIN_MS);
    expect(clampSnapshotInterval(10_000)).toBe(NET.INTERP_MAX_MS);
    expect(clampSnapshotInterval(60)).toBe(60);
    expect(clampSnapshotInterval(Number.NaN)).toBe(NET.SNAPSHOT_INTERVAL_MS);
    expect(clampSnapshotInterval(-5)).toBe(NET.SNAPSHOT_INTERVAL_MS);
    const c = new MirrorClock();
    c.feed(0, 1);
    expect(c.intervalMs).toBe(NET.INTERP_MIN_MS);
    c.feed(0, 5000);
    expect(c.intervalMs).toBe(NET.INTERP_MAX_MS);
  });

  it('dt négatif ou non fini : aucun temps ajouté', () => {
    const c = new MirrorClock();
    c.feed(0, 50);
    c.advance(16);
    expect(c.advance(-10).alpha).toBe(0);
    expect(c.advance(Number.NaN).alpha).toBe(0);
    expect(c.advance(25).alpha).toBeCloseTo(0.5, 6);
  });

  it('reset oublie tout', () => {
    const c = new MirrorClock();
    c.feed(10, 50);
    c.reset();
    expect(c.hasSnapshot).toBe(false);
    expect(c.advance(16).stepped).toBe(false);
  });

  it('un temps d\'état non fini est ignoré (on garde le courant)', () => {
    const c = new MirrorClock();
    c.feed(100, 50);
    c.advance(16);
    c.feed(Number.NaN, 50);
    c.advance(16);
    expect(c.advance(100).timeMs).toBe(100);
  });
});

describe('correspondance joueur / vue', () => {
  it('partie locale (joueur local null) : identité, comme en écran partagé', () => {
    for (const id of [0, 1, 2, 3]) {
      expect(viewOfPlayer(null, id)).toBe(id);
      expect(playerOfView(null, id)).toBe(id);
    }
  });

  it('partie réseau : le joueur local est dans la vue 0, les autres n\'ont pas de vue', () => {
    expect(viewOfPlayer(2, 2)).toBe(0);
    expect(viewOfPlayer(2, 0)).toBe(-1);
    expect(viewOfPlayer(2, 1)).toBe(-1);
    expect(viewOfPlayer(0, 0)).toBe(0); // l'hôte
    expect(playerOfView(2, 0)).toBe(2);
    // -1 donne `undefined` sur un tableau de HUD : les `huds[...]?.` deviennent des no-op
    const huds = ['hud-local'];
    expect(huds[viewOfPlayer(2, 2)]).toBe('hud-local');
    expect(huds[viewOfPlayer(2, 1)]).toBeUndefined();
  });
});
