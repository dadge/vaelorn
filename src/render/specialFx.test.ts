import { describe, expect, it } from 'vitest';
import { CHARACTERS } from '../core/characters';
import type { Dir, SpecialKind } from '../core/types';
import { CosmeticRng } from './fx';
import {
  SpecialFx,
  arcPoints,
  crackPath,
  defaultSpecialRadius,
  dirAngle,
  dirOfAngle,
  discSpans,
  drawRing,
  linePoints,
  mixColor,
  ringSpans,
  shapeAlpha,
  specialCenter,
  specialPalette,
  specialShake,
  stageOf,
  stagedRadius,
  type GfxLike,
} from './specialFx';

const KINDS: SpecialKind[] = ['whirlwind', 'fireNova', 'dash', 'healNova', 'arrowFan', 'quake', 'smash', 'bladeDance'];

describe('formes pixel pures', () => {
  it('ringSpans : symétrique, 1 px minimum, dans le disque extérieur', () => {
    for (const [r, th] of [
      [6, 2],
      [20, 3],
      [40, 5],
      [3, 9],
    ] as const) {
      const spans = ringSpans(r, th);
      expect(spans.length).toBeGreaterThan(0);
      const set = new Set(spans.map((s) => `${s.x},${s.y},${s.w}`));
      for (const s of spans) {
        expect(s.w).toBeGreaterThanOrEqual(1);
        expect(s.h).toBe(1);
        expect(Math.abs(s.y)).toBeLessThanOrEqual(r);
        expect(Math.abs(s.x)).toBeLessThanOrEqual(r + 1);
        expect(Math.abs(s.x + s.w - 1)).toBeLessThanOrEqual(r + 1);
        expect(set.has(`${-(s.x + s.w - 1)},${s.y},${s.w}`)).toBe(true); // miroir horizontal
        expect(set.has(`${s.x},${-s.y},${s.w}`)).toBe(true); // miroir vertical
      }
    }
  });

  it('ringSpans : le centre est vide pour un anneau fin', () => {
    const spans = ringSpans(20, 3);
    expect(spans.some((s) => s.y === 0 && s.x <= 0 && s.x + s.w > 0)).toBe(false);
  });

  it('discSpans : disque plein, lignes consécutives', () => {
    const spans = discSpans(5);
    expect(spans.length).toBe(11);
    expect(spans.find((s) => s.y === 0)?.w).toBe(11);
    expect(discSpans(0)).toEqual([{ x: 0, y: 0, w: 1, h: 1 }]);
  });

  it('stageOf / stagedRadius : paliers bornés, croissants, finissant au rayon cible', () => {
    expect(stageOf(0, 4)).toBe(0);
    expect(stageOf(1, 4)).toBe(3);
    expect(stageOf(2, 4)).toBe(3);
    expect(stageOf(-1, 4)).toBe(0);
    let prev = 0;
    for (let s = 0; s < 5; s++) {
      const r = stagedRadius(40, s, 5);
      expect(r).toBeGreaterThanOrEqual(prev);
      prev = r;
    }
    expect(stagedRadius(40, 4, 5)).toBe(40);
    expect(new Set([0, 1, 2, 3, 4].map((s) => stagedRadius(40, s, 5))).size).toBeGreaterThanOrEqual(4);
  });

  it('arcPoints : uniques et à bonne distance du centre', () => {
    const pts = arcPoints(10, 13, 0, Math.PI);
    expect(pts.length).toBeGreaterThan(20);
    expect(new Set(pts.map((p) => `${p.x},${p.y}`)).size).toBe(pts.length);
    for (const p of pts) {
      const d = Math.hypot(p.x, p.y);
      expect(d).toBeGreaterThan(8.5);
      expect(d).toBeLessThan(14.5);
      expect(p.y).toBeGreaterThanOrEqual(-1); // demi-cercle bas
    }
  });

  it('linePoints : extrémités incluses, pas de trou', () => {
    const pts = linePoints(0, 0, 9, 4);
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[pts.length - 1]).toEqual({ x: 9, y: 4 });
    for (let i = 1; i < pts.length; i++) {
      expect(Math.abs(pts[i].x - pts[i - 1].x)).toBeLessThanOrEqual(1);
      expect(Math.abs(pts[i].y - pts[i - 1].y)).toBeLessThanOrEqual(1);
    }
    expect(linePoints(3, 3, 3, 3)).toEqual([{ x: 3, y: 3 }]);
  });

  it("crackPath : déterministe, partant de l'origine, longueur bornée", () => {
    const a = crackPath(new CosmeticRng(7), 30, 0.5);
    const b = crackPath(new CosmeticRng(7), 30, 0.5);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(10);
    expect(Math.hypot(a[0].x, a[0].y)).toBeLessThanOrEqual(2);
    expect(Math.hypot(a[a.length - 1].x, a[a.length - 1].y)).toBeLessThanOrEqual(31);
  });

  it('shapeAlpha : plein puis fondu jusqu’à 0', () => {
    expect(shapeAlpha(0.2, 1, 0.5)).toBe(1);
    expect(shapeAlpha(0.75, 1, 0.5)).toBeCloseTo(0.5);
    expect(shapeAlpha(1, 0.8, 0.5)).toBe(0);
  });

  it('mixColor / directions', () => {
    expect(mixColor(0x000000, 0xffffff, 0.5)).toBe(0x808080);
    expect(mixColor(0xff0000, 0x0000ff, 0)).toBe(0xff0000);
    expect(mixColor(0xff0000, 0x0000ff, 2)).toBe(0x0000ff);
    const dirs: Dir[] = ['up', 'down', 'left', 'right'];
    for (const d of dirs) expect(dirOfAngle(dirAngle(d))).toBe(d);
    expect(dirOfAngle(0.6)).toBe('right');
    expect(dirOfAngle(-2.5)).toBe('left');
  });

  it('palette, rayon par défaut, secousse : définis pour les 8 familles', () => {
    for (const k of KINDS) {
      const p = specialPalette(k, 0x4aa3ff);
      expect(p.main).not.toBe(p.dark);
      expect(p.accent).toBe(0x4aa3ff);
      expect(defaultSpecialRadius(k)).toBeGreaterThan(0);
    }
    expect(specialShake('quake')?.intensity).toBeGreaterThan(specialShake('whirlwind')?.intensity ?? 1);
    expect(specialShake('healNova')).toBeNull();
    expect(specialCenter({ x: 3, y: 4 })).toEqual({ x: 3, y: 4 });
  });

  it('drawRing émet des fillRect avec la couleur demandée', () => {
    const calls: string[] = [];
    const g: GfxLike = { clear: () => 0, fillStyle: (c, a) => calls.push(`style:${c}:${a}`), fillRect: () => calls.push('rect') };
    drawRing(g, 8, 2, 0xff0000, 0.5);
    expect(calls[0]).toBe('style:16711680:0.5');
    expect(calls.length).toBeGreaterThan(10);
  });
});

// ───────────── SpecialFx avec une scène factice ─────────────

function makeFakes() {
  let graphics = 0;
  let destroyed = 0;
  const gfx = () => {
    graphics++;
    const g = {
      visible: false,
      alpha: 1,
      clears: 0,
      rects: 0,
      clear() {
        this.clears++;
        return g;
      },
      fillStyle() {
        return g;
      },
      fillRect() {
        this.rects++;
        return g;
      },
      setPosition() {
        return g;
      },
      setDepth() {
        return g;
      },
      setAlpha(a: number) {
        this.alpha = a;
        return g;
      },
      setVisible(v: boolean) {
        this.visible = v;
        return g;
      },
      destroy() {
        destroyed++;
      },
    };
    return g;
  };
  const scene = { add: { graphics: gfx } };
  const shakes: Array<[number, number, number | undefined]> = [];
  const rig = {
    registerWorld: <T>(o: T) => o,
    shake: (d: number, i: number, p?: number) => {
      shakes.push([d, i, p]);
    },
  };
  const sprites: Array<{ frame?: string; delay?: number }> = [];
  const texts: string[] = [];
  const fx = {
    sprite: (s: { frame?: string; delay?: number }) => {
      sprites.push(s);
    },
    floatText: (_x: number, _y: number, str: string) => {
      texts.push(str);
    },
    burst: () => undefined,
    dust: () => undefined,
    sparkles: () => undefined,
    ring: () => undefined,
  };
  return { scene, rig, fx, shakes, sprites, texts, stats: () => ({ graphics, destroyed }) };
}

describe('SpecialFx', () => {
  const make = () => {
    const f = makeFakes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sfx = new SpecialFx(f.scene as any, f.rig as any, f.fx as any);
    return { f, sfx };
  };

  it('chaque spécial lance des formes, qui se terminent toutes', () => {
    for (const k of KINDS) {
      const { sfx, f } = make();
      sfx.play({
        playerId: 0,
        kind: k,
        pos: { x: 100, y: 100 },
        dir: 'right',
        playerColor: 0x4aa3ff,
        name: 'Test',
        allies: [
          { id: 0, x: 100, y: 100 },
          { id: 1, x: 130, y: 100 },
        ],
        healText: 'Soin',
      });
      expect(sfx.activeCount(), k).toBeGreaterThan(0);
      expect(f.sprites.length + sfx.activeCount(), k).toBeGreaterThan(2);
      for (let i = 0; i < 200; i++) sfx.update(16);
      expect(sfx.activeCount(), k).toBe(0);
    }
  });

  it('utilise les vraies définitions des 8 personnages sans lever', () => {
    for (const c of Object.values(CHARACTERS)) {
      const { sfx } = make();
      expect(c.special).toBeDefined();
      expect(() => sfx.play({ playerId: 1, kind: c.special!.kind, pos: { x: 50, y: 60 }, dir: 'up', playerColor: 0xff5a5a, def: c.special })).not.toThrow();
      for (let i = 0; i < 120; i++) sfx.update(20);
      expect(sfx.activeCount()).toBe(0);
    }
  });

  it('secousse de caméra du joueur pour le séisme, aucune pour le soin', () => {
    const { sfx, f } = make();
    sfx.play({ playerId: 2, kind: 'quake', pos: { x: 0, y: 0 }, dir: 'down', playerColor: 0xffffff });
    expect(f.shakes[0][2]).toBe(2);
    expect(f.shakes[0][1]).toBeGreaterThan(0.008);
    const n = f.shakes.length;
    sfx.play({ playerId: 2, kind: 'healNova', pos: { x: 0, y: 0 }, dir: 'down', playerColor: 0xffffff });
    expect(f.shakes.length).toBe(n);
  });

  it('nom flottant et soin sur les alliés', () => {
    const { sfx, f } = make();
    sfx.play({
      playerId: 0,
      kind: 'healNova',
      pos: { x: 0, y: 0 },
      dir: 'down',
      playerColor: 0xffffff,
      name: 'Lumière',
      allies: [
        { id: 0, x: 0, y: 0 },
        { id: 1, x: 20, y: 0 },
      ],
      healText: 'Soin !',
    });
    expect(f.texts).toContain('Lumière');
    expect(f.texts.filter((s) => s === 'Soin !').length).toBe(2);
    expect(f.sprites.some((s) => s.frame === 'fx_heal')).toBe(true);
  });

  it('pas de fuite : le pool de Graphics est borné, destroy() les libère', () => {
    const { sfx, f } = make();
    for (let i = 0; i < 60; i++) sfx.play({ playerId: 0, kind: KINDS[i % 8], pos: { x: 0, y: 0 }, dir: 'left', playerColor: 0x123456 });
    expect(f.stats().graphics).toBeLessThanOrEqual(24);
    sfx.clear();
    expect(sfx.activeCount()).toBe(0);
    sfx.destroy();
    expect(f.stats().destroyed).toBe(f.stats().graphics);
  });

  it("les formes ne se redessinent qu'au changement de palier", () => {
    const { sfx } = make();
    let renders = 0;
    sfx.shape({
      x: 0,
      y: 0,
      dur: 400,
      steps: 4,
      render: () => {
        renders++;
      },
    });
    for (let i = 0; i < 40; i++) sfx.update(10);
    expect(renders).toBe(4);
  });
});
