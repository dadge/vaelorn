import { describe, expect, it } from 'vitest';
import type { CharacterId, Dir, EnemyKind, TileGlyph, ZoneTheme } from '../../core/types';
import { ALL_PALETTE_COLORS, THEME_PALETTES, themeColorCount } from '../palettes';
import {
  ATLAS_KEY,
  EXTRA_FRAME_SPECS,
  FRAME_NAMES,
  SPRITE_MANIFEST,
  bossFrame,
  buildAtlasData,
  doorFrame,
  enemyFrame,
  exitFrame,
  hasFrame,
  heartFrame,
  heroFrame,
  keyFrame,
  leverFrame,
  manifestCovers,
  plateFrame,
  projectileFrame,
  requiredFrameSpecs,
  requiredFrames,
  reviveFrame,
  runeFrame,
  slashFrame,
  socketFrame,
  tileFrame,
  torchFrame,
  uiKeyFrame,
  hitFrame,
} from './index';

const HEROES: CharacterId[] = ['david', 'sandrine', 'romain', 'valentine', 'aelith', 'brokk', 'grok', 'mira'];
const DIRS: Dir[] = ['down', 'up', 'left', 'right'];
const ENEMIES: EnemyKind[] = ['slime', 'bat', 'skeleton', 'archer', 'spider', 'wisp', 'knight'];
const THEMES: ZoneTheme[] = ['crypt', 'grove', 'citadel'];

const atlas = buildAtlasData();

/** RGBA d'une frame (Uint32 little-endian-agnostique : on compare des chaînes de 4 octets). */
function framePixels(name: string): number[] {
  const r = atlas.frames[name];
  const out: number[] = [];
  for (let y = 0; y < r.h; y++) {
    for (let x = 0; x < r.w; x++) {
      const o = ((r.y + y) * atlas.width + (r.x + x)) * 4;
      const a = atlas.pixels[o + 3];
      out.push(a === 0 ? -1 : (atlas.pixels[o] << 16) | (atlas.pixels[o + 1] << 8) | atlas.pixels[o + 2]);
    }
  }
  return out;
}

function diffCount(a: number[], b: number[]): number {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
}

function maskDiff(a: number[], b: number[]): number {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] < 0 !== b[i] < 0) n++;
  return n;
}

describe('contrat des frames (DESIGN.md §4)', () => {
  it('requiredFrames() est sans doublon et non vide', () => {
    const names = requiredFrames();
    expect(names.length).toBeGreaterThan(150);
    expect(new Set(names).size).toBe(names.length);
  });

  it('toutes les frames exigées existent dans l’atlas', () => {
    const missing = requiredFrames().filter((n) => !atlas.frames[n]);
    expect(missing).toEqual([]);
  });

  it('l’atlas ne contient que des frames déclarées (contrat + extras), sans doublon', () => {
    const declared = new Set(FRAME_NAMES);
    const extra = Object.keys(atlas.frames).filter((n) => !declared.has(n));
    expect(extra).toEqual([]);
    expect(Object.keys(atlas.frames).length).toBe(FRAME_NAMES.length);
    expect(new Set(FRAME_NAMES).size).toBe(FRAME_NAMES.length);
  });

  it('les tailles respectent le contrat', () => {
    for (const spec of [...requiredFrameSpecs(), ...EXTRA_FRAME_SPECS]) {
      const r = atlas.frames[spec.name];
      expect(r, spec.name).toBeDefined();
      expect([r.w, r.h], spec.name).toEqual(spec.size);
    }
  });

  it('noms de frames : conventions DESIGN.md (échantillon)', () => {
    for (const n of [
      'hero_david_down_0', 'hero_mira_right_attack', 'hero_grok_downed', 'enemy_knight_1', 'boss_golem_hurt', 'boss_morvane_0',
      'tile_crypt_floor_alt', 'tile_citadel_wall_top', 'plate_down', 'lever_on', 'door_sealed', 'key_3', 'block', 'socket_filled',
      'exit_closed', 'pedestal', 'rune_wave', 'rune_frame', 'decor_torch_1', 'decor_crystal', 'sign', 'fx_slash_left', 'fx_arrow',
      'fx_heal', 'fx_hit_2', 'fx_revive_3', 'fx_marker', 'ui_heart_half', 'ui_down', 'ui_key_2',
    ]) {
      expect(hasFrame(n), n).toBe(true);
      expect(atlas.frames[n], n).toBeDefined();
    }
    expect(hasFrame('nope')).toBe(false);
    expect(ATLAS_KEY).toBe('atlas');
  });
});

describe('atlas : géométrie', () => {
  it('dimensions en puissance de 2, ≤ 1024', () => {
    const pow2 = (n: number) => n > 0 && (n & (n - 1)) === 0;
    expect(pow2(atlas.width)).toBe(true);
    expect(pow2(atlas.height)).toBe(true);
    expect(atlas.width).toBeLessThanOrEqual(1024);
    expect(atlas.height).toBeLessThanOrEqual(1024);
    expect(atlas.pixels.length).toBe(atlas.width * atlas.height * 4);
  });

  it('toutes les frames sont dans les bornes, sans chevauchement, avec 1 px de marge', () => {
    const rects = Object.entries(atlas.frames);
    for (const [name, r] of rects) {
      expect(r.x, name).toBeGreaterThanOrEqual(0);
      expect(r.y, name).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w, name).toBeLessThanOrEqual(atlas.width);
      expect(r.y + r.h, name).toBeLessThanOrEqual(atlas.height);
    }
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const [na, a] = rects[i];
        const [nb, b] = rects[j];
        // a et b étendus de 1 px à droite/en bas ne doivent pas se recouvrir
        const overlap = a.x < b.x + b.w + 1 && b.x < a.x + a.w + 1 && a.y < b.y + b.h + 1 && b.y < a.y + a.h + 1;
        expect(overlap, `${na} / ${nb}`).toBe(false);
      }
    }
  });
});

describe('atlas : pixels et palettes', () => {
  it('alpha strictement 0 ou 255 ; aucun pixel hors palette', () => {
    const bad = new Set<number>();
    let badAlpha = 0;
    let dirtyTransparent = 0;
    for (let i = 0; i < atlas.pixels.length; i += 4) {
      const a = atlas.pixels[i + 3];
      if (a !== 0 && a !== 255) badAlpha++;
      if (a === 255) {
        const c = (atlas.pixels[i] << 16) | (atlas.pixels[i + 1] << 8) | atlas.pixels[i + 2];
        if (!ALL_PALETTE_COLORS.has(c)) bad.add(c);
      }
      if (a === 0 && atlas.pixels[i] + atlas.pixels[i + 1] + atlas.pixels[i + 2] !== 0) dirtyTransparent++;
    }
    expect(badAlpha).toBe(0);
    expect(dirtyTransparent).toBe(0);
    expect([...bad].map((c) => '#' + c.toString(16).padStart(6, '0'))).toEqual([]);
  });

  it('chaque thème tient en 12 couleurs distinctes au plus', () => {
    for (const t of THEMES) expect(themeColorCount(t), t).toBeLessThanOrEqual(12);
    expect(Object.keys(THEME_PALETTES).sort()).toEqual([...THEMES].sort());
  });

  it('aucune frame n’est vide ; les tuiles sont entièrement opaques', () => {
    for (const name of FRAME_NAMES) {
      const px = framePixels(name);
      expect(px.some((c) => c >= 0), name).toBe(true);
    }
    for (const t of THEMES) {
      for (const k of ['floor', 'floor_alt', 'wall', 'wall_top', 'pillar', 'pit', 'void']) {
        expect(framePixels(`tile_${t}_${k}`).every((c) => c >= 0), `${t} ${k}`).toBe(true);
      }
    }
  });

  it('chaque sprite de personnage a un contour sombre (pixel opaque le plus à gauche de chaque ligne)', () => {
    for (const id of HEROES) {
      const px = framePixels(`hero_${id}_down_0`);
      let edges = 0;
      for (let y = 0; y < 16; y++) {
        const row = px.slice(y * 16, y * 16 + 16);
        const first = row.find((c) => c >= 0);
        if (first !== undefined && first === 0x14121f) edges++;
      }
      expect(edges, id).toBeGreaterThan(8);
    }
  });
});

describe('héros : lisibilité et distinction', () => {
  it('les 8 héros sont visuellement distincts (pixels et silhouettes de down_0)', () => {
    for (let i = 0; i < HEROES.length; i++) {
      for (let j = i + 1; j < HEROES.length; j++) {
        const a = framePixels(`hero_${HEROES[i]}_down_0`);
        const b = framePixels(`hero_${HEROES[j]}_down_0`);
        expect(diffCount(a, b), `${HEROES[i]} vs ${HEROES[j]}`).toBeGreaterThan(60);
        expect(maskDiff(a, b), `silhouette ${HEROES[i]} vs ${HEROES[j]}`).toBeGreaterThan(15);
      }
    }
  });

  it('les 4 directions sont différentes (up≠down, left≠right) pour chaque héros', () => {
    for (const id of HEROES) {
      const px = (d: Dir) => framePixels(`hero_${id}_${d}_0`);
      expect(diffCount(px('up'), px('down')), `${id} up/down`).toBeGreaterThan(20);
      expect(diffCount(px('left'), px('right')), `${id} left/right`).toBeGreaterThan(10);
      expect(diffCount(px('left'), px('down')), `${id} left/down`).toBeGreaterThan(20);
      expect(diffCount(px('right'), px('up')), `${id} right/up`).toBeGreaterThan(20);
    }
  });

  it('left est le miroir exact de right', () => {
    for (const id of HEROES) {
      for (const f of ['0', '1', 'attack']) {
        const r = framePixels(`hero_${id}_right_${f}`);
        const l = framePixels(`hero_${id}_left_${f}`);
        const flipped: number[] = [];
        for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) flipped.push(r[y * 16 + (15 - x)]);
        expect(l, `${id} ${f}`).toEqual(flipped);
      }
    }
  });

  it('animation de marche : frames 0 et 1 différentes ; attaque et « à terre » différentes de la marche', () => {
    for (const id of HEROES) {
      for (const d of DIRS) {
        const f0 = framePixels(`hero_${id}_${d}_0`);
        const f1 = framePixels(`hero_${id}_${d}_1`);
        const at = framePixels(`hero_${id}_${d}_attack`);
        expect(diffCount(f0, f1), `${id} ${d} marche`).toBeGreaterThan(2);
        expect(diffCount(f0, at), `${id} ${d} attaque`).toBeGreaterThan(2);
      }
      const down = framePixels(`hero_${id}_downed`);
      expect(diffCount(down, framePixels(`hero_${id}_down_0`)), `${id} à terre`).toBeGreaterThan(40);
    }
  });

  it('les sprites de héros restent dans la toile (le contour n’est pas rogné)', () => {
    for (const id of HEROES) {
      for (const d of DIRS) {
        for (const f of ['0', '1', 'attack']) {
          const px = framePixels(`hero_${id}_${d}_${f}`);
          // aucune case de la rangée 0 / colonne 0 ne doit être un pixel de corps (seul le contour peut y toucher)
          const dark = 0x14121f;
          for (let i = 0; i < 16; i++) {
            for (const c of [px[i], px[15 * 16 + i], px[i * 16], px[i * 16 + 15]]) {
              expect(c < 0 || c === dark, `${id} ${d} ${f} bord`).toBe(true);
            }
          }
        }
      }
    }
  });

  it('les ennemis ont 2 frames d’animation différentes', () => {
    for (const k of ENEMIES) {
      expect(diffCount(framePixels(`enemy_${k}_0`), framePixels(`enemy_${k}_1`)), k).toBeGreaterThan(2);
    }
    for (const k of ['golem', 'morvane']) {
      expect(diffCount(framePixels(`boss_${k}_0`), framePixels(`boss_${k}_1`)), k).toBeGreaterThan(10);
      expect(diffCount(framePixels(`boss_${k}_0`), framePixels(`boss_${k}_hurt`)), `${k} hurt`).toBeGreaterThan(100);
    }
  });

  it('les 4 clés ont des couleurs de slot différentes', () => {
    for (let i = 0; i < 4; i++) {
      for (let j = i + 1; j < 4; j++) {
        expect(diffCount(framePixels(`key_${i}`), framePixels(`key_${j}`))).toBeGreaterThan(5);
        expect(diffCount(framePixels(`ui_key_${i}`), framePixels(`ui_key_${j}`))).toBeGreaterThan(2);
      }
    }
  });

  it('les 6 runes sont différentes entre elles', () => {
    const r = ['sun', 'moon', 'star', 'eye', 'flame', 'wave'];
    for (let i = 0; i < r.length; i++) {
      for (let j = i + 1; j < r.length; j++) {
        expect(diffCount(framePixels(`rune_${r[i]}`), framePixels(`rune_${r[j]}`)), `${r[i]}/${r[j]}`).toBeGreaterThan(20);
      }
    }
  });
});

describe('déterminisme', () => {
  it('deux constructions de l’atlas donnent exactement les mêmes octets et les mêmes frames', () => {
    const a = buildAtlasData();
    const b = buildAtlasData();
    expect(a.width).toBe(b.width);
    expect(a.height).toBe(b.height);
    expect(a.pixels.length).toBe(b.pixels.length);
    expect(a.pixels.every((v, i) => v === b.pixels[i])).toBe(true);
    expect(a.frames).toEqual(b.frames);
  });
});

describe('animations.ts : noms de frames', () => {
  it('heroFrame couvre toutes les combinaisons et retourne des frames existantes', () => {
    for (const id of HEROES) {
      for (const d of DIRS) {
        for (const s of [0, 1] as const) {
          expect(hasFrame(heroFrame(id, d, s, 'walk'))).toBe(true);
          expect(hasFrame(heroFrame(id, d, s, 'attack'))).toBe(true);
          expect(hasFrame(heroFrame(id, d, s, 'downed'))).toBe(true);
        }
      }
    }
    expect(heroFrame('david', 'left', 1, 'walk')).toBe('hero_david_left_1');
    expect(heroFrame('david', 'up', 0, 'attack')).toBe('hero_david_up_attack');
    expect(heroFrame('mira', 'down', 1, 'downed')).toBe('hero_mira_downed');
  });

  it('enemyFrame / bossFrame', () => {
    for (const k of ENEMIES) for (const s of [0, 1, 2, 3, -1]) expect(hasFrame(enemyFrame(k, s)), `${k} ${s}`).toBe(true);
    expect(enemyFrame('slime', 3)).toBe('enemy_slime_1');
    expect(enemyFrame('golem', 1)).toBe('boss_golem_1');
    expect(enemyFrame('morvane', 0)).toBe('boss_morvane_0');
    expect(bossFrame('golem', 1)).toBe('boss_golem_1');
    expect(bossFrame('morvane', 0, true)).toBe('boss_morvane_hurt');
    expect(hasFrame(bossFrame('golem', 0, true))).toBe(true);
  });

  it('tileFrame : glyphes, thèmes, variantes déterministes', () => {
    const glyphs: TileGlyph[] = ['#', '.', ',', 'o', '~', ' '];
    for (const t of THEMES) {
      for (const g of glyphs) {
        for (let x = 0; x < 6; x++) for (let y = 0; y < 6; y++) expect(hasFrame(tileFrame(t, g, x, y))).toBe(true);
      }
      expect(tileFrame(t, ',', 0, 0)).toBe(`tile_${t}_floor_alt`);
      expect(tileFrame(t, 'o', 3, 3)).toBe(`tile_${t}_pillar`);
      expect(tileFrame(t, '~', 3, 3)).toBe(`tile_${t}_pit`);
      expect(tileFrame(t, ' ', 3, 3)).toBe(`tile_${t}_void`);
    }
    // '#' : face par défaut, dessus si le voisin sud est un mur / vide / hors grille
    expect(tileFrame('crypt', '#', 1, 1)).toBe('tile_crypt_wall');
    expect(tileFrame('crypt', '#', 1, 1, '.')).toBe('tile_crypt_wall');
    expect(tileFrame('crypt', '#', 1, 1, '#')).toBe('tile_crypt_wall_top');
    expect(tileFrame('crypt', '#', 1, 1, ' ')).toBe('tile_crypt_wall_top');
    expect(tileFrame('crypt', '#', 1, 1, null)).toBe('tile_crypt_wall_top');
    // déterminisme du choix floor/floor_alt + mélange des deux
    let alt = 0;
    for (let x = 0; x < 40; x++) {
      for (let y = 0; y < 40; y++) {
        const a = tileFrame('grove', '.', x, y);
        expect(a).toBe(tileFrame('grove', '.', x, y));
        if (a.endsWith('_alt')) alt++;
      }
    }
    expect(alt).toBeGreaterThan(100);
    expect(alt).toBeLessThan(500);
  });

  it('runeFrame / keyFrame / extras', () => {
    for (const s of ['sun', 'moon', 'star', 'eye', 'flame', 'wave']) expect(runeFrame(s)).toBe(`rune_${s}`);
    expect(runeFrame('inconnu')).toBe('rune_frame');
    for (let s = -2; s < 9; s++) {
      expect(hasFrame(keyFrame(s))).toBe(true);
      expect(hasFrame(uiKeyFrame(s))).toBe(true);
    }
    expect(keyFrame(5)).toBe('key_1');
    for (const d of DIRS) expect(hasFrame(slashFrame(d))).toBe(true);
    for (const k of ['arrow', 'bolt', 'orb', 'shard', 'heal'] as const) expect(hasFrame(projectileFrame(k))).toBe(true);
    for (let i = -1; i < 5; i++) {
      expect(hasFrame(hitFrame(i))).toBe(true);
      expect(hasFrame(reviveFrame(i))).toBe(true);
    }
    for (const b of [true, false]) {
      expect(hasFrame(plateFrame(b))).toBe(true);
      expect(hasFrame(leverFrame(b))).toBe(true);
      expect(hasFrame(doorFrame(b))).toBe(true);
      expect(hasFrame(socketFrame(b))).toBe(true);
      expect(hasFrame(exitFrame(b))).toBe(true);
      expect(hasFrame(exitFrame(b, true))).toBe(true);
    }
    expect(hasFrame(torchFrame(0))).toBe(true);
    expect(hasFrame(torchFrame(333))).toBe(true);
    expect(heartFrame(0, 10, 10)).toBe('ui_heart_full');
    expect(heartFrame(0, 5, 10)).toBe('ui_heart_half');
    expect(heartFrame(1, 10, 10)).toBe('ui_heart_empty');
  });
});

describe('manifeste des sprites', () => {
  it('chaque frame de l’atlas est couverte par une entrée du manifeste', () => {
    const uncovered = FRAME_NAMES.filter((n) => !manifestCovers(n));
    expect(uncovered).toEqual([]);
  });

  it('chaque entrée est complète (description, taille, consigne de remplacement)', () => {
    for (const [k, v] of Object.entries(SPRITE_MANIFEST)) {
      expect(v.description.length, k).toBeGreaterThan(5);
      expect(v.replaceWith.length, k).toBeGreaterThan(5);
      expect(v.size[0] > 0 && v.size[1] > 0, k).toBe(true);
      // chaque motif correspond à au moins une frame réelle
      const hit = FRAME_NAMES.some((n) => (k.includes('*') ? new RegExp('^' + k.split('*').join('.*') + '$').test(n) : k === n));
      expect(hit, k).toBe(true);
    }
  });
});
