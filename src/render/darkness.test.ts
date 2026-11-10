import { afterEach, describe, expect, it, vi } from 'vitest';
import { SIM_STEP_MS, TILE, TORCH_MAX_MS } from '../core/constants';
import { torchRadiusPx, type LightSource } from '../core/light';
import {
  DarknessLayer,
  FLICKER_AMPLITUDE,
  MAX_BRUSH_RADIUS,
  MAX_LIGHTS,
  MIN_BRUSH_RADIUS,
  bandEraseAt,
  brushPixels,
  darknessScale,
  flickerRadius,
  lightAt,
  lightBrushBands,
  lightGlow,
  lightSeed,
  quantizeBrushRadius,
  selectLights,
} from './darkness';

const src = (x: number, y: number, radius: number, extra: Partial<LightSource> = {}): LightSource => ({ x, y, radius, kind: 'torch', ...extra });

describe('lightBrushBands', () => {
  it('4 à 6 paliers selon le rayon, du centre (effacement total) vers le bord (très léger)', () => {
    for (const r of [4, 12, 19, 28, 63, 64, 96, 112, 300]) {
      const b = lightBrushBands(r);
      expect(b.length, `r=${r}`).toBeGreaterThanOrEqual(4);
      expect(b.length, `r=${r}`).toBeLessThanOrEqual(6);
      expect(b[0].erase).toBe(1);
      expect(b[b.length - 1].outer).toBeCloseTo(r, 6);
      expect(b[b.length - 1].erase).toBeGreaterThan(0);
      expect(b[b.length - 1].erase).toBeLessThanOrEqual(0.2);
      for (let i = 1; i < b.length; i++) {
        expect(b[i].outer, `r=${r} i=${i}`).toBeGreaterThan(b[i - 1].outer);
        expect(b[i].erase, `r=${r} i=${i}`).toBeLessThan(b[i - 1].erase);
      }
    }
    expect(lightBrushBands(10).length).toBe(4);
    expect(lightBrushBands(40).length).toBe(5);
    expect(lightBrushBands(100).length).toBe(6);
  });

  it('rayon invalide → aucun palier', () => {
    for (const r of [0, -5, NaN, Infinity]) expect(lightBrushBands(r)).toEqual([]);
  });

  it('bandEraseAt : palier correspondant, 0 au-delà', () => {
    const b = lightBrushBands(100);
    expect(bandEraseAt(0, b)).toBe(1);
    expect(bandEraseAt(b[1].outer, b)).toBe(b[1].erase);
    expect(bandEraseAt(100, b)).toBe(b[b.length - 1].erase);
    expect(bandEraseAt(100.01, b)).toBe(0);
    expect(bandEraseAt(5, [])).toBe(0);
  });
});

describe('brushPixels', () => {
  it('carré 2R×2R, centre opaque (effacement 255), hors disque transparent, quelques niveaux d’alpha nets', () => {
    const R = 24;
    const { size, data } = brushPixels(R);
    expect(size).toBe(2 * R);
    expect(data.length).toBe(size * size * 4);
    const a = (x: number, y: number) => data[(y * size + x) * 4 + 3];
    expect(a(R, R)).toBe(255);
    expect(a(R - 1, R - 1)).toBe(255);
    expect(a(0, 0)).toBe(0);
    expect(a(size - 1, 0)).toBe(0);
    expect(data[(R * size + R) * 4]).toBe(255);
    const levels = new Set<number>();
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) levels.add(data[i]);
    const bands = lightBrushBands(R);
    expect(levels.size).toBeLessThanOrEqual(bands.length);
    expect(levels.size).toBeGreaterThanOrEqual(bands.length - 1);
    for (const l of levels) expect(bands.map((b) => Math.round(b.erase * 255))).toContain(l);
  });

  it('l’alpha décroît globalement du centre vers le bord', () => {
    const R = 40;
    const { size, data } = brushPixels(R);
    const row = (x: number) => data[(R * size + x) * 4 + 3];
    expect(row(R)).toBeGreaterThan(row(R + 20));
    expect(row(R + 20)).toBeGreaterThanOrEqual(row(size - 1));
    expect(row(size - 1)).toBeGreaterThan(0);
  });

  it('déterministe', () => {
    expect(Array.from(brushPixels(13).data)).toEqual(Array.from(brushPixels(13).data));
  });
});

describe('quantizeBrushRadius', () => {
  it('pas de 2 / 4 px, bornes min et max, entrées invalides → 0', () => {
    expect(quantizeBrushRadius(27)).toBe(28);
    expect(quantizeBrushRadius(47)).toBe(48);
    expect(quantizeBrushRadius(97)).toBe(96);
    expect(quantizeBrushRadius(99)).toBe(100);
    expect(quantizeBrushRadius(0.3)).toBe(MIN_BRUSH_RADIUS);
    expect(quantizeBrushRadius(1e6)).toBe(MAX_BRUSH_RADIUS);
    for (const v of [0, -1, NaN, Infinity]) expect(quantizeBrushRadius(v)).toBe(0);
  });
});

describe('quantizeBrushRadius : torche à rayon continu', () => {
  it('une torche qui s’use de 6 à 1,75 tuile parcourt ~24 paliers de pinceau (échelle 1), moins en échelle réduite', () => {
    for (const [scale, lo, hi] of [[1, 22, 25], [0.5, 16, 19]] as const) {
      const levels = new Set<number>();
      for (let ms = 0; ms <= TORCH_MAX_MS; ms += 16) levels.add(quantizeBrushRadius(torchRadiusPx(ms) * scale));
      expect(levels.size).toBeGreaterThanOrEqual(lo);
      expect(levels.size).toBeLessThanOrEqual(hi);
    }
  });

  it('le scintillement (≤ ±6 % à intensité 0,6) n’ajoute pas plus de 2 paliers à la vie d’une torche', () => {
    const plain = new Set<number>();
    const flick = new Set<number>();
    for (let ms = 0; ms <= TORCH_MAX_MS; ms += 16) {
      const r = torchRadiusPx(TORCH_MAX_MS - ms);
      plain.add(quantizeBrushRadius(r));
      flick.add(quantizeBrushRadius(flickerRadius(r, ms, 1000, ms > TORCH_MAX_MS * 0.75 ? 0.6 : 0.15)));
    }
    expect(flick.size).toBeLessThanOrEqual(plain.size + 2);
  });

  it('deux rayons consécutifs de la torche (1 s d’écart) diffèrent d’au plus un pas de quantification', () => {
    for (let ms = 1000; ms <= TORCH_MAX_MS; ms += 1000) {
      const a = quantizeBrushRadius(torchRadiusPx(ms));
      const b = quantizeBrushRadius(torchRadiusPx(ms - 1000));
      expect(a - b).toBeGreaterThanOrEqual(0);
      expect(a - b).toBeLessThanOrEqual(4);
    }
  });

  it('coût d’un pinceau borné : le plus grand (96 px) pèse 192² × 4 octets', () => {
    const { size, data } = brushPixels(96);
    expect(size).toBe(192);
    expect(data.length).toBe(192 * 192 * 4);
  });
});

describe('flickerRadius', () => {
  it('déterministe, borné à ±amplitude×intensité, stable à intensité 0', () => {
    const base = 96;
    for (let t = 0; t < 5000; t += 37) {
      for (const seed of [0, 1, 17, 1031]) {
        const a = flickerRadius(base, t, seed, 1);
        expect(a).toBe(flickerRadius(base, t, seed, 1));
        expect(a).toBeGreaterThanOrEqual(base * (1 - FLICKER_AMPLITUDE) - 1e-9);
        expect(a).toBeLessThanOrEqual(base * (1 + FLICKER_AMPLITUDE) + 1e-9);
        const half = flickerRadius(base, t, seed, 0.5);
        expect(Math.abs(half - base)).toBeLessThanOrEqual(base * FLICKER_AMPLITUDE * 0.5 + 1e-9);
        expect(flickerRadius(base, t, seed, 0)).toBe(base);
      }
    }
  });

  it('varie réellement avec le temps et la graine, par paliers, sans dérive', () => {
    const vals = new Set<number>();
    for (let t = 0; t < 4000; t += 10) vals.add(flickerRadius(100, t, 3, 1));
    expect(vals.size).toBeGreaterThan(8);
    expect(flickerRadius(100, 1000, 3, 1)).toBe(flickerRadius(100, 1005, 3, 1));
    let differs = 0;
    for (let t = 0; t < 2000; t += 50) if (flickerRadius(100, t, 1, 1) !== flickerRadius(100, t, 2, 1)) differs++;
    expect(differs).toBeGreaterThan(10);
    let sum = 0;
    let n = 0;
    for (let t = 0; t < 60000; t += 25) {
      sum += flickerRadius(100, t, 5, 1);
      n++;
    }
    expect(Math.abs(sum / n - 100)).toBeLessThan(1.5);
  });

  it('entrées invalides tolérées', () => {
    expect(flickerRadius(0, 10, 1)).toBe(0);
    expect(flickerRadius(-4, 10, 1)).toBe(0);
    expect(flickerRadius(NaN, 10, 1)).toBe(0);
    expect(Number.isFinite(flickerRadius(50, NaN, NaN, NaN))).toBe(true);
    expect(flickerRadius(50, 10, 1, 99)).toBeLessThanOrEqual(50 * (1 + FLICKER_AMPLITUDE) + 1e-9);
  });
});

describe('lightAt', () => {
  const lights = [src(100, 100, 6 * TILE), src(400, 100, 3 * TILE, { kind: 'brazier' })];
  it('1 au cœur d’une source, décroît par paliers, 0 hors de toute lumière', () => {
    expect(lightAt({ x: 100, y: 100 }, lights)).toBe(1);
    expect(lightAt({ x: 400, y: 100 }, lights)).toBe(1);
    const mid = lightAt({ x: 100 + 3 * TILE, y: 100 }, lights);
    const edge = lightAt({ x: 100 + 6 * TILE - 1, y: 100 }, lights);
    expect(mid).toBeLessThan(1);
    expect(mid).toBeGreaterThan(edge);
    expect(edge).toBeGreaterThan(0);
    expect(lightAt({ x: 100 + 6 * TILE + 1, y: 100 }, lights)).toBe(0);
    expect(lightAt({ x: 250, y: 500 }, lights)).toBe(0);
  });
  it('maximum sur plusieurs sources, liste vide ou rayon nul → 0', () => {
    expect(lightAt({ x: 0, y: 0 }, [])).toBe(0);
    expect(lightAt({ x: 100, y: 100 }, [src(100, 100, 0)])).toBe(0);
    const a = lightAt({ x: 90, y: 100 }, [src(100, 100, 96)]);
    const b = lightAt({ x: 90, y: 100 }, [src(100, 100, 96), src(92, 100, 96)]);
    expect(b).toBeGreaterThanOrEqual(a);
    expect(b).toBe(1);
  });
});

describe('darknessScale / lightGlow / lightSeed', () => {
  it('salles jusqu’à 120×70 tuiles à pleine résolution ; au-delà de la texture max, échelle réduite', () => {
    expect(darknessScale(120 * TILE, 70 * TILE)).toBe(1);
    expect(darknessScale(4096, 100)).toBe(1);
    expect(darknessScale(8192, 1000)).toBe(0.5);
    expect(darknessScale(8192, 1000, 2048)).toBe(0.25);
    expect(darknessScale(0, 0)).toBe(1);
    expect(darknessScale(NaN, 5)).toBe(1);
  });
  it('lueurs : braseros plus marqués que torches, alpha très faible', () => {
    expect(lightGlow('brazier').alpha).toBeGreaterThan(lightGlow('torch').alpha);
    for (const k of ['torch', 'brazier', 'decor'] as const) {
      expect(lightGlow(k).alpha).toBeGreaterThan(0);
      expect(lightGlow(k).alpha).toBeLessThan(0.3);
    }
  });
  it('graine : stable pour une source immobile, indépendante de la position pour une torche de joueur', () => {
    expect(lightSeed(src(32, 48, 50, { kind: 'brazier' }))).toBe(lightSeed(src(32, 48, 99, { kind: 'brazier' })));
    expect(lightSeed(src(32, 48, 50, { kind: 'brazier' }))).not.toBe(lightSeed(src(33, 48, 50, { kind: 'brazier' })));
    expect(lightSeed(src(1, 2, 50, { playerId: 2 }))).toBe(lightSeed(src(300, 90, 50, { playerId: 2 })));
    expect(lightSeed(src(1, 2, 50, { playerId: 2 }))).not.toBe(lightSeed(src(1, 2, 50, { playerId: 3 })));
  });
});

// ───────────────────────────── Cycle de vie avec une scène simulée ─────────────────────────────

interface FakeRt {
  destroyed: boolean;
  w: number;
  h: number;
  ops: string[];
  texture: { renderTarget: object | null; setFilter: (f: number) => void };
  setOrigin: () => FakeRt;
  setDepth: (d: number) => FakeRt;
  setScale: (s: number) => FakeRt;
  setVisible: (v: boolean) => FakeRt;
  resize: (w: number, h: number) => FakeRt;
  clear: () => void;
  fill: (c: number, a: number) => void;
  beginDraw: () => void;
  batchDrawFrame: (key: string, frame: unknown, x: number, y: number, alpha?: number, tint?: number) => void;
  endDraw: (erase: boolean) => void;
  erase: (f: unknown, x: number, y: number) => void;
  destroy: () => void;
}

function makeFakeScene(webgl = true) {
  const textures = new Map<string, { w: number }>();
  const created: string[] = [];
  const removed: string[] = [];
  const rts: FakeRt[] = [];
  const listeners = new Map<string, Array<() => void>>();
  const tm = {
    exists: (k: string) => textures.has(k),
    createCanvas: (k: string, w: number) => {
      textures.set(k, { w });
      created.push(k);
      return { getContext: () => ({ putImageData: () => undefined }), refresh: () => undefined, setFilter: () => undefined };
    },
    remove: (k: string) => {
      textures.delete(k);
      removed.push(k);
    },
    getFrame: (k: string) => (textures.has(k) ? { key: k } : null),
  };
  const scene = {
    textures: tm,
    game: { renderer: { getMaxTextureSize: () => 4096 } },
    events: {
      once: (n: string, f: () => void) => listeners.set(n, [...(listeners.get(n) ?? []), f]),
      off: (n: string, f: () => void) => listeners.set(n, (listeners.get(n) ?? []).filter((x) => x !== f)),
    },
    add: {
      renderTexture: (_x: number, _y: number, w: number, h: number) => {
        const rt: FakeRt = {
          destroyed: false,
          w,
          h,
          ops: [],
          texture: { renderTarget: webgl ? {} : null, setFilter: () => undefined },
          setOrigin: () => rt,
          setDepth: () => rt,
          setScale: () => rt,
          setVisible: () => rt,
          resize: (nw, nh) => {
            rt.w = nw;
            rt.h = nh;
            return rt;
          },
          clear: () => {
            rt.ops.push('clear');
          },
          fill: () => {
            rt.ops.push('fill');
          },
          beginDraw: () => {
            rt.ops.push('begin');
          },
          batchDrawFrame: (key, _f, x, y, alpha) => {
            rt.ops.push(`draw:${key}:${x},${y}${alpha !== undefined ? ':a' : ''}`);
          },
          endDraw: (erase) => {
            rt.ops.push(`end:${erase}`);
          },
          erase: (_f, x, y) => {
            rt.ops.push(`erase:${x},${y}`);
          },
          destroy: () => {
            rt.destroyed = true;
          },
        };
        rts.push(rt);
        return rt;
      },
    },
  };
  return { scene, textures, created, removed, rts, listeners };
}

class FakeImageData {
  constructor(
    public data: Uint8ClampedArray,
    public width: number,
    public height: number,
  ) {}
}

describe('DarknessLayer (scène simulée)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const make = (webgl = true, w = 20 * TILE, h = 12 * TILE) => {
    vi.stubGlobal('ImageData', FakeImageData);
    const f = makeFakeScene(webgl);
    const layer = new DarknessLayer(f.scene as never, w, h, { depth: 700 });
    return { ...f, layer, rt: f.rts[0] };
  };

  it('crée un RenderTexture de la taille de la salle (pleine résolution) et expose l’objet', () => {
    const { layer, rt } = make(true, 120 * TILE, 70 * TILE);
    expect(rt.w).toBe(1920);
    expect(rt.h).toBe(1120);
    expect(layer.resolutionScale).toBe(1);
    expect(layer.object).toBe(rt);
    expect(layer.alive).toBe(true);
  });

  it('salle plus grande que la texture max → résolution réduite', () => {
    const { rt, layer } = make(true, 10000, 2000);
    expect(layer.resolutionScale).toBeCloseTo(0.4096, 4);
    expect(rt.w).toBe(4096);
    expect(rt.h).toBe(Math.ceil(2000 * 0.4096));
  });

  it('update : remplit puis efface un pinceau par source, puis lueurs chaudes (WebGL) ; positions centrées', () => {
    const { layer, rt } = make();
    layer.update([src(100, 80, 96, { flicker: 0 }), src(200, 120, 80, { kind: 'brazier', flicker: 0 })], 1234);
    expect(rt.ops[0]).toBe('clear');
    expect(rt.ops[1]).toBe('fill');
    expect(rt.ops).toContain('end:true');
    expect(rt.ops).toContain('end:false');
    const draws = rt.ops.filter((o) => o.startsWith('draw:'));
    expect(draws.length).toBe(4);
    expect(draws[0]).toBe('draw:darkbrush_96:4,-16');
    expect(draws[1]).toBe('draw:darkbrush_80:120,40');
    expect(draws[2]).toContain(':a');
    expect(layer.brushCount).toBe(2);
  });

  it('sans source : voile plein ; sources invalides / hors salle ignorées ; plafonné à MAX_LIGHTS', () => {
    const { layer, rt } = make();
    layer.update([], 0);
    expect(rt.ops).toEqual(['clear', 'fill']);
    rt.ops.length = 0;
    layer.update([src(NaN, 0, 50), src(10, 10, 0), src(10, 10, -3), src(-5000, 0, 50), src(0, 99999, 50)], 0);
    expect(rt.ops).toEqual(['clear', 'fill']);
    rt.ops.length = 0;
    const many = Array.from({ length: 40 }, (_, i) => src(20 + i * 5, 50, 30, { flicker: 0 }));
    layer.update(many, 0);
    expect(rt.ops.filter((o) => o.startsWith('draw:') && !o.endsWith(':a')).length).toBe(MAX_LIGHTS);
  });

  it('setVisible(false) : update ne dessine rien', () => {
    const { layer, rt } = make();
    layer.setVisible(false);
    layer.update([src(50, 50, 50)], 0);
    expect(rt.ops).toEqual([]);
    layer.setVisible(true);
    layer.update([src(50, 50, 50)], 0);
    expect(rt.ops.length).toBeGreaterThan(0);
  });

  it('mode Canvas : effacement source par source via erase()', () => {
    const { layer, rt } = make(false);
    layer.update([src(100, 80, 96, { flicker: 0 })], 0);
    expect(rt.ops.some((o) => o.startsWith('erase:'))).toBe(true);
    expect(rt.ops.some((o) => o.startsWith('begin'))).toBe(false);
  });

  it('le scintillement fait varier le pinceau utilisé, mais le cache reste borné', () => {
    const { layer } = make();
    for (let t = 0; t < 20000; t += 16) layer.update([src(100, 80, 96, { flicker: 1 })], t);
    expect(layer.brushCount).toBeGreaterThan(1);
    expect(layer.brushCount).toBeLessThanOrEqual(8);
  });

  it('torche qui s’use sur toute sa vie (75 s à 60 i/s) : ≤ 26 pinceaux créés, au plus 1 par image, aucune fuite', () => {
    const { layer, created, removed, textures } = make(true, 40 * TILE, 30 * TILE);
    const frames = Math.round(TORCH_MAX_MS / SIM_STEP_MS);
    let maxLive = 0;
    let maxCreatedPerFrame = 0;
    for (let i = 0; i < frames; i++) {
      const before = created.length;
      const torchMs = TORCH_MAX_MS - i * SIM_STEP_MS;
      layer.update([src(200, 150, torchRadiusPx(torchMs), { flicker: torchMs < TORCH_MAX_MS * 0.25 ? 0.6 : 0.15 })], i * SIM_STEP_MS);
      maxCreatedPerFrame = Math.max(maxCreatedPerFrame, created.length - before);
      maxLive = Math.max(maxLive, textures.size);
    }
    expect(created.length).toBeLessThanOrEqual(26); // ≈ 24 paliers de rayon sur la vie d'une torche
    expect(created.length).toBeGreaterThanOrEqual(18); // la lumière change bel et bien de pinceau en continu
    expect(maxCreatedPerFrame).toBeLessThanOrEqual(1); // une seule source : au plus une création par image
    expect(maxLive).toBeLessThanOrEqual(12); // les pinceaux dépassés sont libérés au fil de l'eau (inactivité)
    expect(removed.length).toBeGreaterThan(0);
    layer.destroy();
    expect(textures.size).toBe(0);
    expect(removed.length).toBe(created.length); // créées = supprimées : aucune fuite
  });

  it('4 torches au même niveau partagent leurs pinceaux ; 4 niveaux différents : au plus 4 pinceaux utilisés par image', () => {
    const { layer, created } = make(true, 40 * TILE, 30 * TILE);
    const same = [0, 1, 2, 3].map((i) => src(100 + i * 50, 100, torchRadiusPx(TORCH_MAX_MS * 0.6), { playerId: i, flicker: 0 }));
    layer.update(same, 0);
    expect(created.length).toBe(1);
    const mixed = [1, 0.7, 0.4, 0.1].map((f, i) => src(100 + i * 50, 100, torchRadiusPx(TORCH_MAX_MS * f), { playerId: i, flicker: 0 }));
    layer.update(mixed, 16);
    expect(created.length).toBe(1 + 4);
    layer.update(mixed, 32); // même image : plus aucune création
    expect(created.length).toBe(1 + 4);
  });

  it('destroy : libère le RenderTexture et toutes les textures de pinceau, idempotent', () => {
    const { layer, rt, textures, removed } = make();
    layer.update([src(100, 80, 96), src(50, 50, 40), src(150, 60, 70)], 0);
    expect(textures.size).toBeGreaterThan(0);
    layer.destroy();
    expect(rt.destroyed).toBe(true);
    expect(textures.size).toBe(0);
    expect(removed.length).toBeGreaterThan(0);
    expect(layer.alive).toBe(false);
    expect(layer.object).toBeNull();
    layer.destroy();
    layer.update([src(1, 1, 10)], 0);
  });

  it('comptage de références : deux calques partagent un pinceau, il disparaît avec le dernier', () => {
    vi.stubGlobal('ImageData', FakeImageData);
    const f = makeFakeScene();
    const a = new DarknessLayer(f.scene as never, 320, 192);
    const b = new DarknessLayer(f.scene as never, 320, 192);
    a.update([src(100, 80, 96, { flicker: 0 })], 0);
    b.update([src(100, 80, 96, { flicker: 0 })], 0);
    expect(f.created.length).toBe(1);
    a.destroy();
    expect(f.textures.has('darkbrush_96')).toBe(true);
    b.destroy();
    expect(f.textures.has('darkbrush_96')).toBe(false);
  });

  it('arrêt de la scène : le calque se détruit tout seul', () => {
    vi.stubGlobal('ImageData', FakeImageData);
    const f = makeFakeScene();
    const layer = new DarknessLayer(f.scene as never, 320, 192);
    layer.update([src(100, 80, 96)], 0);
    for (const fn of f.listeners.get('shutdown') ?? []) fn();
    expect(layer.alive).toBe(false);
    expect(f.textures.size).toBe(0);
  });

  it('resize : nouvelle taille, pinceaux reconstruits à la demande', () => {
    const { layer, rt } = make(true, 320, 192);
    layer.update([src(100, 80, 96, { flicker: 0 })], 0);
    layer.resize(640, 400);
    expect(rt.w).toBe(640);
    expect(rt.h).toBe(400);
    expect(layer.brushCount).toBe(0);
    layer.update([src(100, 80, 96, { flicker: 0 })], 0);
    expect(layer.brushCount).toBe(1);
  });
});

describe('selectLights (constat 5 : priorité plutôt qu un plafond aveugle)', () => {
  const hero = (id: number, x: number, y: number) => src(x, y, 90, { playerId: id });
  const deco = (x: number, y: number) => src(x, y, 40, { kind: 'decor' });

  it('sous le plafond : renvoie le tableau tel quel', () => {
    const l = [hero(0, 0, 0), deco(10, 10)];
    expect(selectLights(l, 16)).toBe(l);
  });

  it('15 braseros devant + 4 joueurs + torches murales : tous les joueurs gardés, les sources proches priment', () => {
    const lights: LightSource[] = [];
    for (let p = 0; p < 4; p++) lights.push(hero(p, 1000 + p * 10, 1000));
    for (let i = 0; i < 20; i++) lights.push(src(i * 200, 3000, 60, { kind: 'brazier' })); // loin des joueurs
    const near = deco(1030, 1010); // une torche murale proche des joueurs, placée en DERNIER
    lights.push(near);
    const out = selectLights(lights, 16);
    expect(out.length).toBe(16);
    for (let p = 0; p < 4; p++) expect(out.filter((l) => l.playerId === p).length).toBe(1);
    expect(out).toContain(near);
  });

  it("un brasero allumé proche d'un joueur n'est pas abandonné au profit d'une source lointaine", () => {
    const lights: LightSource[] = [hero(0, 0, 0)];
    for (let i = 0; i < 30; i++) lights.push(deco(5000 + i, 5000)); // lointaines, listées avant
    const brazier = src(40, 0, 60, { kind: 'brazier' });
    lights.push(brazier);
    expect(selectLights(lights, 16)).toContain(brazier);
  });

  it("sources invalides écartées avant le plafond ; sans joueur : ordre d'origine", () => {
    const lights: LightSource[] = [src(Number.NaN, 0, 10), src(0, 0, 0), ...Array.from({ length: 20 }, (_, i) => src(i, 0, 10))];
    const out = selectLights(lights, 16);
    expect(out.length).toBe(16);
    expect(out[0].x).toBe(0);
    expect(out.every((l) => Number.isFinite(l.x) && l.radius > 0)).toBe(true);
  });

  it('plus de joueurs que de places : jamais plus de `max`', () => {
    const lights = Array.from({ length: 6 }, (_, i) => hero(i, i, 0));
    expect(selectLights(lights, 4).length).toBe(4);
  });
});
