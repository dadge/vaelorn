import { describe, expect, it } from 'vitest';
import { ENEMIES, ENEMY_KINDS } from '../../core/enemies';
import type { Dir, EnemyKind, ZoneTheme } from '../../core/types';
import { PUZZLE_COLORS, ALL_PALETTE_COLORS, THEME_PALETTES, rgb, themeColorCount } from '../palettes';
import {
  ENEMY_SPRITES,
  RENDERED_ENEMY_KINDS,
  bossFrame,
  bridgeFrame,
  buildAtlasData,
  enemyFrame,
  enemySpriteInfo,
  gateFrame,
  hasFrame,
  hasHurtFrame,
  hourglassFrame,
  isBossTier,
  isMiniBossTier,
  lanternFrame,
  manifestCovers,
  spriteTier,
  statueFrame,
  tileFrame,
} from './index';

const NEW_KINDS: EnemyKind[] = ['warden', 'frostqueen', 'pyromancer', 'forgelord', 'wraith', 'voidlord'];
const MINI: EnemyKind[] = ['warden', 'pyromancer', 'wraith'];
const BOSS: EnemyKind[] = ['frostqueen', 'forgelord', 'voidlord'];
const NEW_THEMES: ZoneTheme[] = ['frost', 'ember', 'void'];
const DIRS: Dir[] = ['up', 'down', 'left', 'right'];

const atlas = buildAtlasData();

function px(name: string): number[] {
  const r = atlas.frames[name];
  expect(r, name).toBeDefined();
  const out: number[] = [];
  for (let y = 0; y < r.h; y++) {
    for (let x = 0; x < r.w; x++) {
      const o = ((r.y + y) * atlas.width + (r.x + x)) * 4;
      out.push(atlas.pixels[o + 3] === 0 ? -1 : (atlas.pixels[o] << 16) | (atlas.pixels[o + 1] << 8) | atlas.pixels[o + 2]);
    }
  }
  return out;
}

function diff(a: number[], b: number[]): number {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
}

function luminance(c: number): number {
  const [r, g, b] = rgb(c);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

describe('ennemis des niveaux 4-6 : gabarits de rendu et atlas', () => {
  it('chaque EnemyKind du jeu a un gabarit de rendu, et la table ne contient rien de plus', () => {
    expect([...RENDERED_ENEMY_KINDS].sort()).toEqual([...ENEMY_KINDS].sort());
    for (const k of NEW_KINDS) expect(ENEMY_KINDS, k).toContain(k);
  });

  it('les 6 nouveaux types : demi-boss en 32×32, boss en 48×48', () => {
    for (const k of MINI) {
      expect(spriteTier(k), k).toBe('mini');
      expect(isMiniBossTier(k)).toBe(true);
      expect(isBossTier(k)).toBe(false);
      expect(enemySpriteInfo(k).size).toBe(32);
    }
    for (const k of BOSS) {
      expect(spriteTier(k), k).toBe('boss');
      expect(isBossTier(k)).toBe(true);
      expect(enemySpriteInfo(k).size).toBe(48);
    }
  });

  it('le gabarit de sprite est cohérent avec EnemyDef (isBoss / isMiniBoss)', () => {
    for (const k of ENEMY_KINDS) {
      const def = ENEMIES[k];
      const tier = ENEMY_SPRITES[k].tier;
      if (def.isBoss) expect(tier, `${k} boss`).toBe('boss');
      else if (def.isMiniBoss) expect(tier, `${k} demi-boss`).toBe('mini');
      else expect(tier, `${k} standard`).toBe('small');
    }
  });

  it('toutes les frames de tous les types existent, à la bonne taille (animation 0/1, hurt pour boss et demi-boss)', () => {
    for (const k of ENEMY_KINDS) {
      const info = ENEMY_SPRITES[k];
      for (const step of [0, 1]) {
        const name = enemyFrame(k, step);
        expect(hasFrame(name), name).toBe(true);
        const r = atlas.frames[name];
        expect([r.w, r.h], name).toEqual([info.size, info.size]);
      }
      if (hasHurtFrame(k)) {
        const name = bossFrame(k as Parameters<typeof bossFrame>[0], 0, true);
        expect(hasFrame(name), name).toBe(true);
        expect(atlas.frames[name].w).toBe(info.size);
      }
    }
  });

  it('noms de frames par gabarit', () => {
    expect(enemyFrame('slime', 3)).toBe('enemy_slime_1');
    expect(enemyFrame('warden', 0)).toBe('miniboss_warden_0');
    expect(enemyFrame('wraith', 1)).toBe('miniboss_wraith_1');
    expect(enemyFrame('forgelord', 1)).toBe('boss_forgelord_1');
    expect(bossFrame('pyromancer', 0, true)).toBe('miniboss_pyromancer_hurt');
    expect(bossFrame('voidlord', 1)).toBe('boss_voidlord_1');
    expect(bossFrame('golem', 0, true)).toBe('boss_golem_hurt');
    // un type inconnu (donnée corrompue) n'est jamais rendu avec un préfixe invalide : repli « petit ennemi »
    expect(enemySpriteInfo('inconnu').tier).toBe('small');
  });

  it('les 6 nouveaux sprites sont distincts entre eux (silhouettes ET couleurs)', () => {
    for (let i = 0; i < NEW_KINDS.length; i++) {
      for (let j = i + 1; j < NEW_KINDS.length; j++) {
        const a = px(enemyFrame(NEW_KINDS[i], 0));
        const b = px(enemyFrame(NEW_KINDS[j], 0));
        if (a.length !== b.length) continue; // tailles différentes : forcément distincts
        expect(diff(a, b), `${NEW_KINDS[i]}/${NEW_KINDS[j]}`).toBeGreaterThan(200);
      }
    }
  });

  it('les sprites 32×32 et 48×48 sont cerclés d\'un contour sombre et ne touchent pas le bord de la toile', () => {
    for (const k of NEW_KINDS) {
      const name = enemyFrame(k, 0);
      const p = px(name);
      const n = atlas.frames[name].w;
      const dark = 0x14121f;
      for (let i = 0; i < n; i++) {
        // bord de toile : transparent ou teinte de contour (contour sombre ou trait de calque, jamais une couleur claire)
        for (const c of [p[i], p[(n - 1) * n + i], p[i * n], p[i * n + n - 1]]) expect(c < 0 || luminance(c) < 90, `${k} bord`).toBe(true);
      }
      expect(p.some((c) => c === dark), `${k} contour`).toBe(true);
    }
  });
});

describe('thèmes frost / ember / void', () => {
  it('palettes : ≤ 12 couleurs distinctes, toutes dans la liste blanche', () => {
    for (const t of NEW_THEMES) {
      expect(themeColorCount(t), t).toBeLessThanOrEqual(12);
      for (const v of Object.values(THEME_PALETTES[t])) expect(ALL_PALETTE_COLORS.has(v), `${t} ${v.toString(16)}`).toBe(true);
    }
  });

  it('contraste : le sol se distingue du dessus de mur et du vide ; la face du mur du sol', () => {
    for (const t of NEW_THEMES) {
      const p = THEME_PALETTES[t];
      expect(Math.abs(luminance(p.floorMid) - luminance(p.wallTop)), `${t} sol/dessus`).toBeGreaterThan(25);
      expect(Math.abs(luminance(p.floorMid) - luminance(p.void)), `${t} sol/vide`).toBeGreaterThan(25);
      expect(Math.abs(luminance(p.wallMid) - luminance(p.floorMid)), `${t} mur/sol`).toBeGreaterThan(12);
      expect(luminance(p.floorLight), `${t} reflet`).toBeGreaterThan(luminance(p.floorDark));
      expect(luminance(p.wallLight), `${t} mur clair`).toBeGreaterThan(luminance(p.wallDark));
    }
  });

  it('chaque thème a sa propre identité (aucun sol / mur partagé entre deux thèmes)', () => {
    const all: ZoneTheme[] = ['crypt', 'grove', 'citadel', ...NEW_THEMES];
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        expect(THEME_PALETTES[all[i]].floorMid, `${all[i]}/${all[j]} sol`).not.toBe(THEME_PALETTES[all[j]].floorMid);
        expect(THEME_PALETTES[all[i]].wallMid, `${all[i]}/${all[j]} mur`).not.toBe(THEME_PALETTES[all[j]].wallMid);
      }
    }
  });

  it('ambiances : frost = bleu, ember = rouge/orange, void = violet-bleu sombre', () => {
    const frost = rgb(THEME_PALETTES.frost.floorMid);
    expect(frost[2]).toBeGreaterThan(frost[0]);
    const ember = rgb(THEME_PALETTES.ember.accent);
    expect(ember[0]).toBeGreaterThan(ember[2] + 100);
    const voidAccent = rgb(THEME_PALETTES.void.accent);
    expect(voidAccent[2]).toBeGreaterThan(voidAccent[1]);
    expect(luminance(THEME_PALETTES.void.floorMid)).toBeLessThan(50);
  });

  it('tuiles : 7 types × 3 thèmes, opaques, avec des variantes différentes et des tuiles qui se distinguent', () => {
    for (const t of NEW_THEMES) {
      const kinds = ['floor', 'floor_alt', 'wall', 'wall_top', 'pillar', 'pit', 'void'];
      const frames = kinds.map((k) => px(`tile_${t}_${k}`));
      frames.forEach((f, i) => expect(f.every((c) => c >= 0), `${t} ${kinds[i]} opaque`).toBe(true));
      expect(diff(frames[0], frames[1]), `${t} floor/alt`).toBeGreaterThan(6);
      for (let i = 0; i < kinds.length; i++) {
        for (let j = i + 1; j < kinds.length; j++) expect(diff(frames[i], frames[j]), `${t} ${kinds[i]}/${kinds[j]}`).toBeGreaterThan(8);
      }
    }
  });

  it('tileFrame fonctionne pour les nouveaux thèmes (frames existantes, variantes déterministes)', () => {
    for (const t of NEW_THEMES) {
      for (const g of ['#', '.', ',', 'o', '~', ' '] as const) {
        for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) expect(hasFrame(tileFrame(t, g, x, y, '.'))).toBe(true);
      }
      expect(tileFrame(t, '#', 2, 2, '#')).toBe(`tile_${t}_wall_top`);
      expect(tileFrame(t, '#', 2, 2, '.')).toBe(`tile_${t}_wall`);
      expect(tileFrame(t, '~', 1, 1)).toBe(`tile_${t}_pit`);
    }
  });

  it('manifeste : les frames des nouveaux thèmes sont couvertes', () => {
    for (const t of NEW_THEMES) expect(manifestCovers(`tile_${t}_floor`)).toBe(true);
  });
});

describe('mécanismes des niveaux 4-6 : frames', () => {
  it('statues : 4 directions × (normal, résolu), toutes différentes ; le résolu est vert, pas cyan', () => {
    for (const lit of [false, true]) {
      const frames = DIRS.map((d) => px(statueFrame(d, lit)));
      for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) expect(diff(frames[i], frames[j]), `${DIRS[i]}/${DIRS[j]} lit=${lit}`).toBeGreaterThan(4);
    }
    for (const d of DIRS) {
      expect(diff(px(statueFrame(d, false)), px(statueFrame(d, true))), d).toBeGreaterThan(2);
      expect(px(statueFrame(d, true)).includes(PUZZLE_COLORS.eyeSolved)).toBe(true);
      expect(px(statueFrame(d, false)).includes(PUZZLE_COLORS.eyeSolved)).toBe(false);
    }
    expect(statueFrame('left', false)).toBe('statuepair_left');
    expect(statueFrame('up', true)).toBe('statuepair_up_lit');
    expect(hasFrame('statuepair_stand')).toBe(true);
    // le socle est transparent aux angles (le sol reste visible)
    expect(px('statuepair_stand')[0]).toBe(-1);
  });

  it('sablier : 5 niveaux de sable ; frame monotone selon la fraction (vide seulement si 0)', () => {
    // sable du HAUT : pixels de sable dans la moitié supérieure de la frame (le bas utilise sandShade)
    const sand = (n: string) => px(n).filter((c, i) => i < 8 * 16 && (c === PUZZLE_COLORS.sand || c === PUZZLE_COLORS.sandHi)).length;
    for (let l = 0; l <= 4; l++) expect(hasFrame(`hourglass_${l}`)).toBe(true);
    // le sable du haut (sand/sandHi) augmente avec le niveau
    for (let l = 1; l <= 4; l++) expect(sand(`hourglass_${l}`), `niveau ${l}`).toBeGreaterThan(sand(`hourglass_${l - 1}`));
    expect(hourglassFrame(0)).toBe('hourglass_0');
    expect(hourglassFrame(-3)).toBe('hourglass_0');
    expect(hourglassFrame(Number.NaN)).toBe('hourglass_0');
    expect(hourglassFrame(0.01)).toBe('hourglass_1');
    expect(hourglassFrame(0.5)).toBe('hourglass_2');
    expect(hourglassFrame(1)).toBe('hourglass_4');
    expect(hourglassFrame(7)).toBe('hourglass_4');
    for (let f = -0.5; f <= 1.5; f += 0.05) expect(hasFrame(hourglassFrame(f))).toBe(true);
  });

  it('herse : fermée (opaque) ≠ relevée (presque vide) ; pont : lumière ≠ abîme (opaques)', () => {
    expect(px(gateFrame(true)).every((c) => c >= 0)).toBe(true);
    expect(px(gateFrame(false)).filter((c) => c >= 0).length).toBeLessThan(px(gateFrame(true)).length / 2);
    expect(px(bridgeFrame(true)).every((c) => c >= 0)).toBe(true);
    expect(px(bridgeFrame(false)).every((c) => c >= 0)).toBe(true);
    expect(diff(px(bridgeFrame(true)), px(bridgeFrame(false)))).toBeGreaterThan(100);
    // la lumière est nettement plus claire que l'abîme
    const mean = (f: string) => px(f).reduce((s, c) => s + luminance(c), 0) / 256;
    expect(mean(bridgeFrame(true))).toBeGreaterThan(mean(bridgeFrame(false)) + 60);
  });

  it('lanterne : 2 frames qui vacillent, 8×8', () => {
    expect(diff(px('lantern_0'), px('lantern_1'))).toBeGreaterThan(1);
    expect(lanternFrame(0)).toBe('lantern_0');
    expect(lanternFrame(140)).toBe('lantern_1');
    expect(lanternFrame(Number.NaN)).toBe('lantern_0');
    expect([atlas.frames.lantern_0.w, atlas.frames.lantern_0.h]).toEqual([8, 8]);
  });

  it('manifeste : tout est couvert', () => {
    for (const n of ['statuepair_up_lit', 'statuepair_stand', 'hourglass_3', 'gate_closed', 'gate_open', 'bridge_lit', 'bridge_dark', 'lantern_1', 'miniboss_wraith_hurt', 'boss_voidlord_0']) {
      expect(manifestCovers(n), n).toBe(true);
    }
  });
});
