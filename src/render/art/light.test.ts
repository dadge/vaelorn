import { describe, expect, it } from 'vitest';
import { ALL_PALETTE_COLORS } from '../palettes';
import { FRAME_NAMES, brazierFrame, buildAtlasData, emberFrame, hasFrame, manifestCovers, torchIconFrame } from './index';

const atlas = buildAtlasData();

function pixels(name: string): number[] {
  const r = atlas.frames[name];
  const out: number[] = [];
  for (let y = 0; y < r.h; y++) {
    for (let x = 0; x < r.w; x++) {
      const o = ((r.y + y) * atlas.width + (r.x + x)) * 4;
      out.push(atlas.pixels[o + 3] === 0 ? -1 : (atlas.pixels[o] << 16) | (atlas.pixels[o + 1] << 8) | atlas.pixels[o + 2]);
    }
  }
  return out;
}
const diff = (a: number[], b: number[]) => a.reduce((n, v, i) => n + (v !== b[i] ? 1 : 0), 0);

const NEW_FRAMES: Array<[string, number]> = [
  ['brazier_unlit', 16],
  ['brazier_lit_0', 16],
  ['brazier_lit_1', 16],
  ['ui_torch_full', 8],
  ['ui_torch_half', 8],
  ['ui_torch_empty', 8],
  ['fx_ember_0', 8],
  ['fx_ember_1', 8],
  ['fx_ember_2', 8],
];

describe('art de la lumière : frames', () => {
  it('toutes les frames sont déclarées, présentes, de la bonne taille, couvertes par le manifeste', () => {
    for (const [name, size] of NEW_FRAMES) {
      expect(FRAME_NAMES, name).toContain(name);
      expect(hasFrame(name), name).toBe(true);
      expect(manifestCovers(name), name).toBe(true);
      const r = atlas.frames[name];
      expect([r.w, r.h], name).toEqual([size, size]);
      expect(pixels(name).some((c) => c >= 0), name).toBe(true);
    }
  });

  it('couleurs dans la palette, pixels opaques ou transparents', () => {
    for (const [name] of NEW_FRAMES) for (const c of pixels(name)) if (c >= 0) expect(ALL_PALETTE_COLORS.has(c), `${name} #${c.toString(16)}`).toBe(true);
  });

  it('les trois états du brasero sont distincts ; la flamme occupe le haut de la frame, la vasque le bas', () => {
    const u = pixels('brazier_unlit');
    const a = pixels('brazier_lit_0');
    const b = pixels('brazier_lit_1');
    expect(diff(u, a)).toBeGreaterThan(40);
    expect(diff(a, b)).toBeGreaterThan(8);
    const rowCount = (px: number[], y: number) => px.slice(y * 16, y * 16 + 16).filter((c) => c >= 0).length;
    expect(rowCount(a, 2)).toBeGreaterThan(rowCount(u, 2));
    for (const px of [u, a, b]) expect(rowCount(px, 14)).toBeGreaterThan(3);
    // la flamme allumée contient du jaune vif et de l'orange
    expect(a.includes(0xffe27a)).toBe(true);
    expect(a.includes(0xff9a3c)).toBe(true);
    // un contour sombre autour du brasero
    expect(u.includes(0x14121f)).toBe(true);
  });

  it('les icônes de torche et les braises sont distinctes entre elles', () => {
    const names = ['ui_torch_full', 'ui_torch_half', 'ui_torch_empty'];
    for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) expect(diff(pixels(names[i]), pixels(names[j])), `${names[i]}/${names[j]}`).toBeGreaterThan(6);
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) expect(diff(pixels(`fx_ember_${i}`), pixels(`fx_ember_${j}`))).toBeGreaterThan(8);
    // plus la torche est pleine, plus elle a de pixels colorés « flamme »
    const flame = (n: string) => pixels(n).filter((c) => c === 0xffe27a || c === 0xff9a3c || c === 0xe0501e).length;
    expect(flame('ui_torch_full')).toBeGreaterThan(flame('ui_torch_half'));
    expect(flame('ui_torch_half')).toBeGreaterThan(flame('ui_torch_empty'));
  });
});

describe('art de la lumière : helpers', () => {
  it('brazierFrame : éteint → brazier_unlit ; allumé → alternance brazier_lit_0/1', () => {
    expect(brazierFrame(false, 0)).toBe('brazier_unlit');
    expect(brazierFrame(false, 12345)).toBe('brazier_unlit');
    const seen = new Set<string>();
    for (let t = 0; t < 2000; t += 50) seen.add(brazierFrame(true, t));
    expect([...seen].sort()).toEqual(['brazier_lit_0', 'brazier_lit_1']);
    for (const t of [-500, 0, 179, 180, 1e9, NaN]) expect(hasFrame(brazierFrame(true, t)), String(t)).toBe(true);
  });

  it('torchIconFrame : seuils plein / moitié / vide, valeurs aberrantes tolérées', () => {
    expect(torchIconFrame(1)).toBe('ui_torch_full');
    expect(torchIconFrame(0.5)).toBe('ui_torch_full');
    expect(torchIconFrame(0.49)).toBe('ui_torch_half');
    expect(torchIconFrame(0.01)).toBe('ui_torch_half');
    expect(torchIconFrame(0)).toBe('ui_torch_empty');
    expect(torchIconFrame(-1)).toBe('ui_torch_empty');
    expect(torchIconFrame(NaN)).toBe('ui_torch_empty');
    expect(torchIconFrame(7)).toBe('ui_torch_full');
    for (const f of [-1, 0, 0.2, 0.7, 3, NaN]) expect(hasFrame(torchIconFrame(f))).toBe(true);
  });

  it('emberFrame : 3 étapes de vie, bornée', () => {
    expect(emberFrame(0)).toBe('fx_ember_0');
    expect(emberFrame(0.5)).toBe('fx_ember_1');
    expect(emberFrame(0.99)).toBe('fx_ember_2');
    expect(emberFrame(1)).toBe('fx_ember_2');
    expect(emberFrame(-3)).toBe('fx_ember_0');
    expect(emberFrame(NaN)).toBe('fx_ember_0');
  });
});
