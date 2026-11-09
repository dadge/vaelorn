/**
 * Tests du dessin de l'indicateur d'appel avec un faux `Graphics` (aucun Phaser) : rien n'est dessiné sans appel,
 * point + 3 arcs (+ contour) par appelant hors vue, orientés vers l'intérieur de la vue, aucun indicateur de bord si l'appelant est visible,
 * vidage unique à la fin du signal, anneaux du monde, destruction.
 */
import { describe, expect, it } from 'vitest';
import { CALL_DURATION_MS } from '../core/constants';
import { makeTestLevel } from '../core/levelValidation';
import { createSimulation } from '../core/simulation';
import type { GameState, PlayerId, Vec2 } from '../core/types';
import type { ViewContext } from '../entities/common';
import { CallEdgeHud, CallWorldFx } from './callHud';
import { CALL_WAVE_COUNT } from './callIndicator';
import { computeLayout } from './splitscreen';

interface Call {
  fn: string;
  args: unknown[];
}

class FakeGraphics {
  calls: Call[] = [];
  destroyed = false;
  depth = -1;
  private rec(fn: string, args: unknown[]): this {
    this.calls.push({ fn, args });
    return this;
  }
  setDepth(d: number): this {
    this.depth = d;
    return this;
  }
  clear(): this {
    return this.rec('clear', []);
  }
  lineStyle(...a: unknown[]): this {
    return this.rec('lineStyle', a);
  }
  fillStyle(...a: unknown[]): this {
    return this.rec('fillStyle', a);
  }
  beginPath(): this {
    return this.rec('beginPath', []);
  }
  arc(...a: unknown[]): this {
    return this.rec('arc', a);
  }
  strokePath(): this {
    return this.rec('strokePath', []);
  }
  strokeCircle(...a: unknown[]): this {
    return this.rec('strokeCircle', a);
  }
  fillCircle(...a: unknown[]): this {
    return this.rec('fillCircle', a);
  }
  destroy(): void {
    this.destroyed = true;
  }
  count(fn: string): number {
    return this.calls.filter((c) => c.fn === fn).length;
  }
  reset(): void {
    this.calls = [];
  }
}

function fakeCtx(zoom: number, g: FakeGraphics, reg: { hud: number; world: number }): ViewContext {
  return {
    scene: { add: { graphics: () => g } },
    rig: {
      registerHud: (o: unknown) => {
        reg.hud++;
        return o;
      },
      registerWorld: (o: unknown) => {
        reg.world++;
        return o;
      },
    },
    zoom,
    playerCount: 4,
  } as unknown as ViewContext;
}

function makeState(n = 4): GameState {
  const level = makeTestLevel();
  const players = Array.from({ length: n }, (_, i) => ({ id: i as PlayerId, characterId: 'david' as const, difficulty: 2 as const }));
  return createSimulation({ levelId: 'test', seed: 1, players }, level).state;
}

describe("CallEdgeHud (point au bord + arcs vers l'intérieur)", () => {
  const layout = computeLayout(4);
  const vp = layout.viewports[0];
  const cam: Vec2 = { x: 400, y: 300 };
  const setup = () => {
    const g = new FakeGraphics();
    const reg = { hud: 0, world: 0 };
    const hud = new CallEdgeHud(fakeCtx(layout.zoom, g, reg), vp, 20, 6);
    return { g, reg, hud, state: makeState() };
  };

  it("enregistré comme objet d'interface (HUD), à la profondeur demandée", () => {
    const { g, reg } = setup();
    expect(reg).toEqual({ hud: 1, world: 0 });
    expect(g.depth).toBe(20);
  });

  it("aucun appel : rien n'est dessiné ni effacé (pas de travail inutile)", () => {
    const { g, hud, state } = setup();
    for (let i = 0; i < 10; i++) hud.update(state, 0, cam, [], 0);
    expect(g.calls).toHaveLength(0);
  });

  it("appelant hors vue : 3 arcs (contour + couleur) de 90° qui partent d'un point collé au bord, vers l'intérieur", () => {
    const { g, hud, state } = setup();
    state.players[1].pos = { x: cam.x + 1000, y: cam.y }; // loin à droite
    state.players[1].callMs = CALL_DURATION_MS;
    hud.update(state, 0, cam, [], 0);
    expect(g.count('clear')).toBe(1);
    expect(g.count('arc')).toBe(CALL_WAVE_COUNT * 2);
    const arcs = g.calls.filter((c) => c.fn === 'arc');
    for (const a of arcs) {
      const [cx, cy, , start, end, anticlockwise] = a.args as [number, number, number, number, number, boolean];
      expect(cx).toBeGreaterThan(vp.x + vp.w / 2); // ancre sur le bord droit de la vue
      expect(cx).toBeGreaterThan(vp.x + vp.w - 10 * (layout.zoom / 2)); // le point est COLLÉ au bord
      expect(cy).toBeCloseTo(vp.y + vp.h / 2);
      expect(Math.cos((start + end) / 2)).toBeCloseTo(-1); // appelant à droite : arcs vers la gauche, vers l'intérieur de la vue
      expect(end - start).toBeCloseTo(Math.PI / 2); // quart de cercle, comme l'icône « signal »
      expect(anticlockwise).toBe(false);
    }
    // rayons croissants (contour et trait ont le même rayon pour chaque demi-cercle)
    const radii = arcs.map((a) => a.args[2] as number);
    expect(radii[0]).toBe(radii[1]);
    expect(radii[2]).toBe(radii[3]);
    expect(radii[0]).toBeLessThan(radii[2]);
    expect(radii[2]).toBeLessThan(radii[4]);
  });

  it("fin du signal : les demi-cercles s'estompent (opacité multipliée par le fondu de sortie)", () => {
    const { g, hud, state } = setup();
    state.players[1].pos = { x: cam.x + 1000, y: cam.y };
    state.players[1].callMs = 600; // t = 2400 ms : pleine opacité pour l'arc allumé
    hud.update(state, 0, cam, [], 0);
    const full = Math.max(...g.calls.filter((c) => c.fn === 'lineStyle').map((c) => c.args[2] as number));
    g.reset();
    state.players[1].callMs = 30; // t = 2970 ms : 30/150 du fondu restant
    hud.update(state, 0, cam, [], 0);
    const faded = Math.max(...g.calls.filter((c) => c.fn === 'lineStyle').map((c) => c.args[2] as number));
    expect(full).toBeCloseTo(1);
    expect(faded).toBeCloseTo(0.2, 1);
  });

  it("capacité des autres indicateurs fournie par l'appelant : au-delà, les ancres en trop sont ignorées sans erreur", () => {
    const g = new FakeGraphics();
    const hud = new CallEdgeHud(fakeCtx(layout.zoom, g, { hud: 0, world: 0 }), vp, 20, 2);
    const state = makeState();
    state.players[1].pos = { x: cam.x + 1000, y: cam.y };
    state.players[1].callMs = 2000;
    const many = Array.from({ length: 6 }, () => ({ x: 0, y: 0 }));
    expect(() => hud.update(state, 0, cam, many, many.length)).not.toThrow();
    expect(g.count('arc')).toBe(CALL_WAVE_COUNT * 2);
  });

  it('couleur du trait = couleur du joueur appelant', () => {
    const { g, hud, state } = setup();
    state.players[2].pos = { x: cam.x, y: cam.y - 1000 };
    state.players[2].callMs = CALL_DURATION_MS;
    hud.update(state, 0, cam, [], 0);
    const colors = g.calls.filter((c) => c.fn === 'lineStyle').map((c) => c.args[1]);
    expect(colors).toContain(0x5be37d); // vert = joueur 3
    expect(colors).not.toContain(0xff5a5a);
  });

  it("appelant visible dans la vue : aucun indicateur de bord (les anneaux du monde le montrent)", () => {
    const { g, hud, state } = setup();
    state.players[1].pos = { x: cam.x + 20, y: cam.y + 10 };
    state.players[1].callMs = 2000;
    hud.update(state, 0, cam, [], 0);
    expect(g.calls).toHaveLength(0);
  });

  it("le spectateur ne voit pas d'indicateur pour son propre appel", () => {
    const { g, hud, state } = setup();
    state.players[0].pos = { x: cam.x + 2000, y: cam.y };
    state.players[0].callMs = 2500;
    hud.update(state, 0, cam, [], 0);
    expect(g.calls).toHaveLength(0);
  });

  it('fin du signal : la zone est vidée UNE seule fois, puis plus rien', () => {
    const { g, hud, state } = setup();
    state.players[1].pos = { x: cam.x + 1000, y: cam.y };
    state.players[1].callMs = 500;
    hud.update(state, 0, cam, [], 0);
    g.reset();
    state.players[1].callMs = 0;
    hud.update(state, 0, cam, [], 0);
    hud.update(state, 0, cam, [], 0);
    hud.update(state, 0, cam, [], 0);
    expect(g.calls.map((c) => c.fn)).toEqual(['clear']);
  });

  it('deux appelants au même endroit : leurs centres ne se superposent pas ; autres flèches évitées', () => {
    const { g, hud, state } = setup();
    state.players[1].pos = { x: cam.x + 1000, y: cam.y };
    state.players[2].pos = { x: cam.x + 1000, y: cam.y };
    state.players[1].callMs = 2000;
    state.players[2].callMs = 2000;
    const other = { x: vp.w - 30, y: vp.h / 2 }; // une flèche existante exactement là où irait le premier indicateur
    hud.update(state, 0, cam, [other], 1);
    const pts = g.calls.filter((c) => c.fn === 'arc').map((c) => [c.args[0], c.args[1]] as [number, number]);
    const uniq = new Set(pts.map((p) => p.join(',')));
    expect(uniq.size).toBe(2); // 2 appelants → 2 centres distincts
    for (const u of uniq) {
      const [x, y] = u.split(',').map(Number);
      expect(Math.hypot(x - vp.x - other.x, y - vp.y - other.y)).toBeGreaterThan(20); // et à l'écart de la flèche
    }
  });

  it('destroy libère le Graphics', () => {
    const { g, hud } = setup();
    hud.destroy();
    expect(g.destroyed).toBe(true);
  });
});

describe('CallWorldFx (anneaux du monde)', () => {
  const setup = () => {
    const g = new FakeGraphics();
    const reg = { hud: 0, world: 0 };
    const fx = new CallWorldFx(fakeCtx(2, g, reg), 5999.75);
    return { g, reg, fx, state: makeState() };
  };
  const posOf = (state: GameState) => (id: number): Vec2 | null => state.players[id]?.pos ?? null;

  it("enregistré comme objet du monde, profondeur au-dessus de l'obscurité", () => {
    const { g, reg } = setup();
    expect(reg).toEqual({ hud: 0, world: 1 });
    expect(g.depth).toBeCloseTo(5999.75);
  });

  it("aucun appel : rien n'est dessiné", () => {
    const { g, fx, state } = setup();
    fx.update(state, posOf(state));
    expect(g.calls).toHaveLength(0);
  });

  it("appel en cours : anneaux autour de l'appelant (objet du monde : l'appelant les voit aussi), de plus en plus nombreux", () => {
    const { g, fx, state } = setup();
    state.players[1].callMs = CALL_DURATION_MS; // t = 0 : un seul anneau
    fx.update(state, posOf(state));
    expect(g.count('clear')).toBe(1);
    const first = g.calls.filter((c) => c.fn === 'strokeCircle');
    expect(first).toHaveLength(2); // contour + couleur
    for (const c of first) expect([c.args[0], c.args[1]]).toEqual([state.players[1].pos.x, state.players[1].pos.y]);
    g.reset();
    state.players[1].callMs = CALL_DURATION_MS - 700; // t = 700 ms : 3 anneaux
    fx.update(state, posOf(state));
    expect(g.count('strokeCircle')).toBe(CALL_WAVE_COUNT * 2);
  });

  it('plusieurs appelants : chacun ses anneaux ; fin du signal : un seul clear puis plus rien', () => {
    const { g, fx, state } = setup();
    state.players[0].callMs = 2900;
    state.players[3].callMs = 2900;
    fx.update(state, posOf(state));
    expect(g.count('clear')).toBe(1);
    expect(g.count('strokeCircle')).toBe(4); // à t = 100 ms : 1 anneau × 2 traits (contour + couleur) × 2 appelants
    g.reset();
    state.players[0].callMs = 0;
    state.players[3].callMs = 0;
    fx.update(state, posOf(state));
    fx.update(state, posOf(state));
    expect(g.calls.map((c) => c.fn)).toEqual(['clear']);
  });

  it('appelant à terre ou position inconnue : rien', () => {
    const { g, fx, state } = setup();
    state.players[1].callMs = 2000;
    state.players[1].status = 'down';
    state.players[2].callMs = 2000;
    fx.update(state, (id) => (id === 2 ? null : state.players[id].pos));
    expect(g.calls).toHaveLength(0);
  });

  it('clear et destroy', () => {
    const { g, fx, state } = setup();
    state.players[1].callMs = 2000;
    fx.update(state, posOf(state));
    g.reset();
    fx.clear();
    expect(g.calls.map((c) => c.fn)).toEqual(['clear']);
    fx.destroy();
    expect(g.destroyed).toBe(true);
  });
});
