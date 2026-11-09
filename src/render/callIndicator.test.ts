/**
 * Tests du rendu PUR de l'indicateur d'appel : projection au bord (4 directions, coins, appelant visible), séquence des
 * 3 arcs (point au bord, arcs vers l'intérieur), opacités, couleur par joueur, exclusion de l'appelant, évitement de chevauchement, anneaux du monde.
 * Aucun Phaser.
 */
import { describe, expect, it } from 'vitest';
import { CALL_DURATION_MS, PLAYER_COLORS } from '../core/constants';
import { makeTestLevel } from '../core/levelValidation';
import { createSimulation } from '../core/simulation';
import type { PlayerId, PlayerState } from '../core/types';
import { edgeIndicator } from './camera';
import {
  CALL_ARC_SPAN,
  CALL_CYCLE_MS,
  CALL_DOT_RADIUS,
  CALL_EDGE_PADDING,
  CALL_END_FADE_MS,
  CALL_FADE_MS,
  CALL_GHOST_ALPHA,
  CALL_LIT_THRESHOLD,
  CALL_MIN_SEPARATION,
  CALL_RADII,
  CALL_STEP_MS,
  CALL_TAIL_ALPHA,
  CALL_WAVE_COUNT,
  CALL_WORLD_ALPHA,
  CALL_WORLD_RADIUS_MAX,
  CALL_WORLD_RADIUS_MIN,
  callArcCenterAngle,
  callColor,
  callEdgeIndicator,
  callEdgeMargin,
  callElapsedMs,
  callEndFade,
  callHudScale,
  callWaveAlphas,
  callWaveIndex,
  callWorldRings,
  collectCallers,
  isCallSignalActive,
  separateFromAnchors,
  type CallWorldRing,
} from './callIndicator';
import { computeLayout, worldViewSize } from './splitscreen';

function player(id: PlayerId, x: number, y: number, over: Partial<PlayerState> = {}): PlayerState {
  const level = makeTestLevel();
  const sim = createSimulation(
    { levelId: 'test', seed: 1, players: [0, 1, 2, 3].map((i) => ({ id: i as PlayerId, characterId: 'david' as const, difficulty: 2 as const })) },
    level,
  );
  const p = sim.state.players[id];
  p.pos = { x, y };
  Object.assign(p, over);
  return p;
}

describe('constantes', () => {
  it('3 arcs de rayons croissants ~10/18/26 (quarts de cercle), cycle de 900 ms = 3 × 300 ms', () => {
    expect(CALL_ARC_SPAN).toBeCloseTo(Math.PI / 2);
    expect(CALL_WAVE_COUNT).toBe(3);
    expect(CALL_RADII).toEqual([10, 18, 26]);
    expect(CALL_CYCLE_MS).toBe(900);
    expect(CALL_STEP_MS).toBe(300);
    expect(CALL_STEP_MS * CALL_WAVE_COUNT).toBe(CALL_CYCLE_MS);
    for (let i = 1; i < CALL_RADII.length; i++) expect(CALL_RADII[i]).toBeGreaterThan(CALL_RADII[i - 1]);
  });

  it('échelle du HUD : 1 à 2 de zoom, 1,5 à zoom 3 ; zoom invalide = 1', () => {
    expect(callHudScale(2)).toBe(1);
    expect(callHudScale(3)).toBe(1.5);
    expect(callHudScale(0)).toBe(1);
    expect(callHudScale(Number.NaN)).toBe(1);
  });
});

describe('séquence des 3 demi-cercles', () => {
  it('un seul demi-cercle allumé à la fois, du plus petit au plus grand', () => {
    const seen: number[] = [];
    for (let t = 0; t < CALL_CYCLE_MS; t += 5) {
      const a = callWaveAlphas(t);
      const lit = a.map((v, i) => (v >= CALL_LIT_THRESHOLD ? i : -1)).filter((i) => i >= 0);
      expect(lit, `t=${t}`).toHaveLength(1);
      expect(lit[0]).toBe(callWaveIndex(t));
      if (seen[seen.length - 1] !== lit[0]) seen.push(lit[0]);
    }
    expect(seen).toEqual([0, 1, 2]); // du plus petit au plus grand
  });

  it('chaque demi-cercle reste allumé 300 ms : bornes exactes', () => {
    expect(callWaveIndex(0)).toBe(0);
    expect(callWaveIndex(299)).toBe(0);
    expect(callWaveIndex(300)).toBe(1);
    expect(callWaveIndex(599)).toBe(1);
    expect(callWaveIndex(600)).toBe(2);
    expect(callWaveIndex(899)).toBe(2);
  });

  it('cycle périodique : même état à t et t + 900 ms, sur tout le signal de 3 s (le tout premier tour n\'a pas de queue, voir plus bas)', () => {
    for (let t = CALL_STEP_MS; t < CALL_DURATION_MS - CALL_CYCLE_MS; t += 37) {
      expect(callWaveAlphas(t + CALL_CYCLE_MS)).toEqual(callWaveAlphas(t));
      expect(callWaveIndex(t + CALL_CYCLE_MS)).toBe(callWaveIndex(t));
    }
  });

  it('opacités : allumé = 1, fondu de queue du précédent (≤ seuil), les autres = fantôme ; jamais hors [0, 1]', () => {
    const a = callWaveAlphas(CALL_STEP_MS + 1); // 2e demi-cercle vient de s'allumer, le 1er s'éteint
    expect(a[1]).toBe(1);
    expect(a[0]).toBeGreaterThan(CALL_GHOST_ALPHA);
    expect(a[0]).toBeLessThanOrEqual(CALL_TAIL_ALPHA);
    expect(a[2]).toBe(CALL_GHOST_ALPHA);
    const after = callWaveAlphas(CALL_STEP_MS + CALL_FADE_MS + 1);
    expect(after[0]).toBe(CALL_GHOST_ALPHA); // fondu terminé
    // le plus grand s'éteint au moment où le plus petit se rallume (boucle)
    const wrap = callWaveAlphas(CALL_CYCLE_MS + 1);
    expect(wrap[0]).toBe(1);
    expect(wrap[2]).toBeGreaterThan(CALL_GHOST_ALPHA);
    for (let t = 0; t < 2000; t += 7) for (const v of callWaveAlphas(t)) expect(v >= 0 && v <= 1).toBe(true);
  });

  it('réutilise le tableau fourni (aucune allocation) ; temps négatif ou NaN = début de cycle', () => {
    const out: number[] = [];
    expect(callWaveAlphas(100, out)).toBe(out);
    expect(out).toHaveLength(CALL_WAVE_COUNT);
    expect(callWaveIndex(-50)).toBe(0);
    expect(callWaveIndex(Number.NaN)).toBe(0);
    expect(callWaveAlphas(Number.NaN)[0]).toBe(1);
  });
});

describe('début et fin de l\'animation', () => {
  it('au tout premier tour : pas de fondu de queue sur le plus grand demi-cercle (jamais allumé)', () => {
    expect(callWaveAlphas(0)).toEqual([1, CALL_GHOST_ALPHA, CALL_GHOST_ALPHA]);
    expect(callWaveAlphas(CALL_STEP_MS - 1)[2]).toBe(CALL_GHOST_ALPHA);
    expect(callWaveAlphas(CALL_CYCLE_MS + 1)[2]).toBeGreaterThan(CALL_GHOST_ALPHA); // les tours suivants : queue normale
  });

  it('fondu de sortie global : 1 jusqu\'aux derniers CALL_END_FADE_MS, puis décroît jusqu\'à 0, toujours dans [0, 1]', () => {
    expect(callEndFade(0)).toBe(1);
    expect(callEndFade(CALL_DURATION_MS - CALL_END_FADE_MS)).toBe(1);
    expect(callEndFade(CALL_DURATION_MS - CALL_END_FADE_MS / 2)).toBeCloseTo(0.5);
    expect(callEndFade(CALL_DURATION_MS)).toBe(0);
    expect(callEndFade(CALL_DURATION_MS + 500)).toBe(0);
    expect(callEndFade(Number.NaN)).toBe(1);
    let prev = 1;
    for (let t = 0; t <= CALL_DURATION_MS; t += 10) {
      const f = callEndFade(t);
      expect(f).toBeLessThanOrEqual(prev + 1e-12);
      expect(f >= 0 && f <= 1).toBe(true);
      prev = f;
    }
  });

  it('séparation minimale entre indicateurs : au moins la largeur, le long du bord, du plus grand arc (corde + trait)', () => {
    const chord = 2 * CALL_RADII[CALL_WAVE_COUNT - 1] * Math.sin(CALL_ARC_SPAN / 2);
    expect(CALL_MIN_SEPARATION).toBeGreaterThanOrEqual(chord + 2);
  });

  it("les arcs pointent vers l'intérieur : à l'opposé de la direction de l'appelant", () => {
    expect(callArcCenterAngle(0)).toBeCloseTo(Math.PI); // appelant à droite -> arcs vers la gauche (vers le joueur)
    expect(Math.cos(callArcCenterAngle(Math.PI))).toBeCloseTo(1); // appelant à gauche -> arcs vers la droite
    expect(Math.sin(callArcCenterAngle(-Math.PI / 2))).toBeCloseTo(1); // appelant en haut -> arcs vers le bas
    for (const a of [0.3, 1.1, -2.4, 2.9]) {
      const c = callArcCenterAngle(a);
      expect(Math.cos(c)).toBeCloseTo(-Math.cos(a));
      expect(Math.sin(c)).toBeCloseTo(-Math.sin(a));
    }
  });
});

describe('temps d\'animation et activité du signal', () => {
  it('temps écoulé dérivé de callMs : 0 à l\'appui, 3 s à la fin, borné', () => {
    expect(callElapsedMs({ callMs: CALL_DURATION_MS })).toBe(0);
    expect(callElapsedMs({ callMs: 1000 })).toBe(2000);
    expect(callElapsedMs({ callMs: 0 })).toBe(CALL_DURATION_MS);
    expect(callElapsedMs({ callMs: 99999 })).toBe(0);
    expect(callElapsedMs({ callMs: Number.NaN })).toBe(CALL_DURATION_MS);
  });

  it('hors signal : rien à afficher (callMs = 0, ou appelant à terre)', () => {
    expect(isCallSignalActive({ status: 'alive', callMs: 0 })).toBe(false);
    expect(isCallSignalActive({ status: 'alive', callMs: 1500 })).toBe(true);
    expect(isCallSignalActive({ status: 'down', callMs: 1500 })).toBe(false);
    expect(isCallSignalActive({ status: 'alive', callMs: Number.NaN })).toBe(false);
  });
});

describe('couleur et sélection des appelants', () => {
  it('couleur = celle du joueur appelant ; repli blanc pour un id inconnu', () => {
    for (const id of [0, 1, 2, 3]) expect(callColor(id)).toBe(PLAYER_COLORS[id]);
    expect(new Set([0, 1, 2, 3].map(callColor)).size).toBe(4);
    expect(callColor(9)).toBe(0xffffff);
  });

  it('exclut l\'appelant lui-même et ceux qui n\'appellent pas', () => {
    const ps = [player(0, 0, 0, { callMs: 2000 }), player(1, 0, 0, { callMs: 1000 }), player(2, 0, 0), player(3, 0, 0, { callMs: 500, status: 'down' })];
    const out: PlayerState[] = [];
    expect(collectCallers(ps, 0, out)).toBe(1); // J1 appelle mais ne voit pas son propre indicateur : seul J2 compte
    expect(out.map((p) => p.id)).toEqual([1]);
    expect(collectCallers(ps, 2, out)).toBe(2);
    expect(out.map((p) => p.id)).toEqual([0, 1]);
    expect(collectCallers(ps, 1, out)).toBe(1);
    expect(out.map((p) => p.id)).toEqual([0]);
    ps[0].callMs = 0;
    ps[1].callMs = 0;
    expect(collectCallers(ps, 2, out)).toBe(0);
    expect(out).toHaveLength(0);
  });
});

describe('projection au bord (même géométrie que les flèches existantes)', () => {
  const layout = computeLayout(4); // 4 quadrants, zoom 2, vue de 638 × 358 px d'écran
  const vp = layout.viewports[0];
  const zoom = vp.zoom;
  const cam = { x: 500, y: 400 };
  const view = worldViewSize(vp); // 319 × 179 px monde
  const margin = callEdgeMargin(callHudScale(zoom));

  it('appelant dans la vue : pas d\'indicateur de bord', () => {
    for (const d of [
      { x: 0, y: 0 },
      { x: 100, y: 50 },
      { x: -view.w / 2 + 1, y: view.h / 2 - 1 },
    ]) {
      expect(callEdgeIndicator({ x: cam.x + d.x, y: cam.y + d.y }, cam, zoom, vp.w, vp.h).visible).toBe(false);
    }
  });

  it('4 directions : l\'ancre est sur le bord correspondant, l\'angle pointe vers l\'appelant', () => {
    const right = callEdgeIndicator({ x: cam.x + 600, y: cam.y }, cam, zoom, vp.w, vp.h);
    expect(right.visible).toBe(true);
    expect(right.angle).toBeCloseTo(0);
    expect(right.x).toBeCloseTo(vp.w - margin);
    expect(right.y).toBeCloseTo(vp.h / 2);
    const left = callEdgeIndicator({ x: cam.x - 600, y: cam.y }, cam, zoom, vp.w, vp.h);
    expect(Math.abs(left.angle)).toBeCloseTo(Math.PI);
    expect(left.x).toBeCloseTo(margin);
    const down = callEdgeIndicator({ x: cam.x, y: cam.y + 600 }, cam, zoom, vp.w, vp.h);
    expect(down.angle).toBeCloseTo(Math.PI / 2);
    expect(down.y).toBeCloseTo(vp.h - margin);
    expect(down.x).toBeCloseTo(vp.w / 2);
    const up = callEdgeIndicator({ x: cam.x, y: cam.y - 600 }, cam, zoom, vp.w, vp.h);
    expect(up.angle).toBeCloseTo(-Math.PI / 2);
    expect(up.y).toBeCloseTo(margin);
  });

  it('coins : direction exacte (pas seulement 4 directions) et ancre dans le coin du rectangle intérieur', () => {
    const corners: [number, number][] = [
      [700, 700],
      [-700, 700],
      [700, -700],
      [-700, -700],
    ];
    for (const [dx, dy] of corners) {
      const e = callEdgeIndicator({ x: cam.x + dx, y: cam.y + dy }, cam, zoom, vp.w, vp.h);
      expect(e.visible).toBe(true);
      expect(e.angle).toBeCloseTo(Math.atan2(dy, dx));
      // l'ancre est sur le rectangle intérieur, et colinéaire avec la direction de l'appelant
      const rx = Math.abs(e.x - vp.w / 2) / (vp.w / 2 - margin);
      const ry = Math.abs(e.y - vp.h / 2) / (vp.h / 2 - margin);
      expect(Math.max(rx, ry)).toBeCloseTo(1);
      expect(Math.atan2(e.y - vp.h / 2, e.x - vp.w / 2)).toBeCloseTo(e.angle);
    }
    // direction oblique non diagonale : angle exact
    const oblique = callEdgeIndicator({ x: cam.x + 900, y: cam.y + 100 }, cam, zoom, vp.w, vp.h);
    expect(oblique.angle).toBeCloseTo(Math.atan2(100, 900));
  });

  it('même projection que `edgeIndicator` (flèches alliés à terre / ennemis) pour une même marge', () => {
    const caller = { x: cam.x + 321, y: cam.y - 777 };
    const a = callEdgeIndicator(caller, cam, zoom, vp.w, vp.h, 22);
    const b = edgeIndicator((caller.x - cam.x) * zoom, (caller.y - cam.y) * zoom, vp.w, vp.h, 22);
    expect(a).toEqual(b);
  });

  it("le point est collé au bord et TOUT l'indicateur (arcs compris) reste dans la vue, à 1-2 joueurs (zoom 3) comme à 4 (zoom 2)", () => {
    for (const n of [1, 2, 3, 4]) {
      const l = computeLayout(n);
      for (const v of l.viewports) {
        const m = callEdgeMargin(callHudScale(v.zoom));
        expect(m).toBeCloseTo((CALL_DOT_RADIUS + CALL_EDGE_PADDING) * (v.zoom / 2));
        expect(m).toBeLessThan(8 * (v.zoom / 2)); // le point est bien collé au bord
        for (const [dx, dy] of [[3000, 0], [-3000, 40], [0, 3000], [0, -3000], [2000, 2000], [-2000, -2000]]) {
          const e = callEdgeIndicator({ x: 1000 + dx, y: 1000 + dy }, { x: 1000, y: 1000 }, v.zoom, v.w, v.h);
          expect(e.visible).toBe(true);
          expect(e.x).toBeGreaterThanOrEqual(m - 1e-6);
          expect(e.x).toBeLessThanOrEqual(v.w - m + 1e-6);
          expect(e.y).toBeGreaterThanOrEqual(m - 1e-6);
          expect(e.y).toBeLessThanOrEqual(v.h - m + 1e-6);
          // extrémités et milieu du plus grand arc (rayon max + demi-trait) : dans la vue
          const sc = callHudScale(v.zoom);
          const centre = callArcCenterAngle(e.angle);
          const R = (CALL_RADII[CALL_WAVE_COUNT - 1] + 1.5) * sc;
          for (const da of [-CALL_ARC_SPAN / 2, 0, CALL_ARC_SPAN / 2]) {
            const px = e.x + R * Math.cos(centre + da);
            const py = e.y + R * Math.sin(centre + da);
            expect(px).toBeGreaterThanOrEqual(-1e-6);
            expect(px).toBeLessThanOrEqual(v.w + 1e-6);
            expect(py).toBeGreaterThanOrEqual(-1e-6);
            expect(py).toBeLessThanOrEqual(v.h + 1e-6);
          }
        }
      }
    }
  });
});

describe('évitement de chevauchement entre indicateurs de bord', () => {
  const W = 638;
  const H = 358;
  const margin = callEdgeMargin(1);
  const sep = CALL_MIN_SEPARATION;

  it('rien à éviter : l\'ancre ne bouge pas', () => {
    const a = { x: W - margin, y: 100 };
    separateFromAnchors(a, [], 0, W, H, margin, sep);
    expect(a).toEqual({ x: W - margin, y: 100 });
    separateFromAnchors(a, [{ x: 10, y: 10 }], 1, W, H, margin, sep); // loin
    expect(a).toEqual({ x: W - margin, y: 100 });
  });

  it('deux indicateurs au même endroit (bord droit) : l\'ancre glisse le long du bord, reste sur le bord et à bonne distance', () => {
    const other = { x: W - margin, y: 150 };
    const a = { x: W - margin, y: 150 };
    separateFromAnchors(a, [other], 1, W, H, margin, sep);
    expect(a.x).toBe(W - margin); // toujours sur le bord droit
    expect(Math.hypot(a.x - other.x, a.y - other.y)).toBeGreaterThanOrEqual(sep - 1e-6);
    expect(a.y).toBeGreaterThanOrEqual(margin);
    expect(a.y).toBeLessThanOrEqual(H - margin);
  });

  it('bord haut : glisse horizontalement ; coin : reste dans le rectangle intérieur', () => {
    const top = { x: 300, y: margin };
    separateFromAnchors(top, [{ x: 300, y: margin }], 1, W, H, margin, sep);
    expect(top.y).toBe(margin);
    expect(Math.abs(top.x - 300)).toBeGreaterThanOrEqual(sep - 1e-6);
    const corner = { x: W - margin, y: H - margin };
    separateFromAnchors(corner, [{ x: W - margin, y: H - margin }], 1, W, H, margin, sep);
    expect(corner.x).toBeGreaterThanOrEqual(margin);
    expect(corner.x).toBeLessThanOrEqual(W - margin);
    expect(corner.y).toBeGreaterThanOrEqual(margin);
    expect(corner.y).toBeLessThanOrEqual(H - margin);
    expect(Math.hypot(corner.x - (W - margin), corner.y - (H - margin))).toBeGreaterThanOrEqual(sep - 1e-6);
  });

  it('plusieurs obstacles : trouve une place libre ; sans place libre, garde la position la plus dégagée', () => {
    const x = W - margin;
    const others = [
      { x, y: 150 },
      { x, y: 150 - sep },
      { x, y: 150 + sep },
    ];
    const a = { x, y: 150 };
    separateFromAnchors(a, others, 3, W, H, margin, sep);
    for (const o of others) expect(Math.hypot(a.x - o.x, a.y - o.y)).toBeGreaterThanOrEqual(sep - 1e-6);
    // vue minuscule : aucune place libre, l'ancre reste dans les bornes
    const tiny = { x: 60, y: 30 };
    separateFromAnchors(tiny, [{ x: 60, y: 30 }], 1, 140, 70, 30, 200);
    expect(tiny.x).toBeGreaterThanOrEqual(30); // rectangle intérieur : 70 ± 40
    expect(tiny.x).toBeLessThanOrEqual(110);
  });
});

describe('anneaux du monde (appelant visible)', () => {
  it('aucun avant le début ; le 1er dès 0 ms ; les 2e et 3e démarrent 300 et 600 ms plus tard', () => {
    const rings: CallWorldRing[] = [];
    expect(callWorldRings(0, rings)).toBe(1);
    expect(callWorldRings(299, rings)).toBe(1);
    expect(callWorldRings(300, rings)).toBe(2);
    expect(callWorldRings(600, rings)).toBe(3);
    expect(callWorldRings(2999, rings)).toBe(3);
  });

  it('chaque anneau grandit (rayon croissant) en s\'estompant, entre les bornes, puis recommence', () => {
    const rings: CallWorldRing[] = [];
    let prevR = -1;
    let prevA = 2;
    for (let t = 0; t < CALL_CYCLE_MS; t += 10) {
      callWorldRings(t, rings);
      expect(rings[0].radius).toBeGreaterThan(prevR);
      expect(rings[0].alpha).toBeLessThan(prevA);
      expect(rings[0].radius).toBeGreaterThanOrEqual(CALL_WORLD_RADIUS_MIN);
      expect(rings[0].radius).toBeLessThanOrEqual(CALL_WORLD_RADIUS_MAX);
      expect(rings[0].alpha).toBeLessThanOrEqual(CALL_WORLD_ALPHA);
      expect(rings[0].alpha).toBeGreaterThan(0);
      prevR = rings[0].radius;
      prevA = rings[0].alpha;
    }
    callWorldRings(CALL_CYCLE_MS, rings);
    expect(rings[0].radius).toBeCloseTo(CALL_WORLD_RADIUS_MIN);
    expect(rings[0].alpha).toBeCloseTo(CALL_WORLD_ALPHA);
  });

  it('réutilise les objets du tableau fourni', () => {
    const rings: CallWorldRing[] = [];
    callWorldRings(700, rings);
    const first = rings[0];
    callWorldRings(710, rings);
    expect(rings[0]).toBe(first);
  });
});

describe('cohérence avec la simulation', () => {
  it('l\'indicateur n\'est affichable que pendant les 3 s du signal (callMs de GameState)', () => {
    const level = makeTestLevel();
    const sim = createSimulation({ levelId: 'test', seed: 3, players: [0, 1].map((i) => ({ id: i as PlayerId, characterId: 'david' as const, difficulty: 2 as const })) }, level);
    const p = sim.state.players[0];
    expect(isCallSignalActive(p)).toBe(false);
    sim.step(1000 / 60, { 0: { moveX: 0, moveY: 0, attack: false, interact: false, revive: false, call: true } });
    expect(isCallSignalActive(p)).toBe(true);
    expect(callElapsedMs(p)).toBe(0);
    expect(callWaveIndex(callElapsedMs(p))).toBe(0);
    for (let i = 0; i < 90; i++) sim.step(1000 / 60, {});
    expect(callElapsedMs(p)).toBeCloseTo(1500, 0);
    for (let i = 0; i < 100; i++) sim.step(1000 / 60, {});
    expect(isCallSignalActive(p)).toBe(false);
  });
});
