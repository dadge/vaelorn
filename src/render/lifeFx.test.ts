/**
 * Sources de vie — rendu (parties PURES) : clignotement des 3 dernières secondes, frames, textes flottants et i18n (parité fr/en),
 * sprites provisoires dans l'atlas et le manifeste, sons associés aux événements, cœur du HUD partagé avec l'équilibrage.
 */
import { describe, expect, it } from 'vitest';
import { HP_PER_HEART as BALANCE_HP_PER_HEART, PICKUP_BLINK_MS, PICKUP_TTL_MS } from '../core/balance';
import { sfxForEvent } from '../entities/sfx';
import enLoot from '../i18n/parts/loot.en.json';
import frLoot from '../i18n/parts/loot.fr.json';
import { FRAME_NAMES, buildAtlasData, hasFrame, manifestCovers } from './art';
import { ALL_PALETTE_COLORS } from './palettes';
import { HP_PER_HEART } from './hud';
import { PICKUP_REDUCED_ALPHA, crystalFrame, pickupAlpha, pickupBob, pickupFrame, pickupHaloColor, pickupTextColor, pickupTextFor, pickupTextKey } from './lifeFx';

describe('clignotement de la nourriture (3 dernières secondes)', () => {
  it('opacité pleine tant qu\'il reste plus de 3 s', () => {
    for (const ttl of [PICKUP_TTL_MS, PICKUP_TTL_MS - 1, PICKUP_BLINK_MS + 1]) {
      for (const t of [0, 100, 777, 5000]) expect(pickupAlpha(ttl, t)).toBe(1);
    }
  });
  it('à partir de 3 s restantes elle alterne plein / presque éteint', () => {
    const seen = new Set<number>();
    for (let t = 0; t < 2000; t += 25) seen.add(pickupAlpha(2500, t));
    expect([...seen].sort()).toEqual([0.2, 1]);
  });
  it('clignote plus vite pendant la dernière seconde', () => {
    const switches = (ttl: number): number => {
      let n = 0;
      let last = pickupAlpha(ttl, 0);
      for (let t = 1; t < 2000; t++) {
        const a = pickupAlpha(ttl, t);
        if (a !== last) n++;
        last = a;
      }
      return n;
    };
    expect(switches(500)).toBeGreaterThan(switches(2500) * 1.3);
  });
  it('ne dépasse jamais 3 flashs par seconde (photosensibilité), même dans la dernière seconde', () => {
    for (const ttl of [2500, 900]) {
      let flashes = 0;
      let last = pickupAlpha(ttl, 0);
      for (let t = 1; t < 1000; t++) {
        const a = pickupAlpha(ttl, t);
        if (a === 1 && last !== 1) flashes++;
        last = a;
      }
      expect(flashes, `ttl ${ttl}`).toBeLessThanOrEqual(3);
    }
  });
  it('prefers-reduced-motion : opacité fixe sur les 3 dernières secondes, plus aucun flottement', () => {
    for (let t = 0; t < 2000; t += 13) {
      expect(pickupAlpha(2500, t, true)).toBe(pickupAlpha(2500, 0, true));
      expect(pickupAlpha(800, t, true)).toBe(PICKUP_REDUCED_ALPHA);
      expect(pickupBob(t, 3, true)).toBe(0);
    }
    expect(pickupAlpha(PICKUP_TTL_MS, 123, true)).toBe(1);
  });
  it('texte flottant : valeur nominale si soin complet, « +N PV » si le soin est plafonné au manque', () => {
    expect(pickupTextFor('full', 10)).toEqual({ key: 'loot.pickup.full' });
    expect(pickupTextFor('half', 5)).toEqual({ key: 'loot.pickup.half' });
    expect(pickupTextFor('full', 1)).toEqual({ key: 'loot.crystal.heal', params: { n: 1 } });
    expect(pickupTextFor('half', 2.4)).toEqual({ key: 'loot.crystal.heal', params: { n: 2 } });
  });
  it('le flottement reste dans ±1,2 px et dépend de l\'id', () => {
    for (let t = 0; t < 3000; t += 37) expect(Math.abs(pickupBob(t, 4))).toBeLessThanOrEqual(1.2 + 1e-9);
    expect(pickupBob(500, 1)).not.toBe(pickupBob(500, 2));
  });
});

describe('frames, couleurs et textes', () => {
  it('frames d\'atlas de la nourriture et du cristal : toutes présentes dans l\'atlas, en 16×16', () => {
    const names = [pickupFrame('half'), pickupFrame('full'), 'heal_crystal_0', 'heal_crystal_1', 'heal_crystal_used'];
    const atlas = buildAtlasData();
    for (const n of names) {
      expect(hasFrame(n), n).toBe(true);
      expect(FRAME_NAMES).toContain(n);
      expect([atlas.frames[n].w, atlas.frames[n].h], n).toEqual([16, 16]);
    }
    expect(pickupFrame('half')).not.toBe(pickupFrame('full'));
  });
  it('sprites provisoires : couverts par le manifeste (SPRITES.md) ; couleurs dans la palette blanche (aucun pixel hors palette)', () => {
    for (const n of ['pickup_half', 'pickup_full', 'heal_crystal_0', 'heal_crystal_1', 'heal_crystal_used']) expect(manifestCovers(n), n).toBe(true);
    const atlas = buildAtlasData();
    for (const n of ['pickup_half', 'pickup_full', 'heal_crystal_0', 'heal_crystal_1', 'heal_crystal_used']) {
      const r = atlas.frames[n];
      let opaque = 0;
      for (let y = 0; y < r.h; y++) {
        for (let x = 0; x < r.w; x++) {
          const o = ((r.y + y) * atlas.width + (r.x + x)) * 4;
          const a = atlas.pixels[o + 3];
          expect([0, 255], `${n} alpha`).toContain(a);
          if (a === 255) {
            opaque++;
            const c = (atlas.pixels[o] << 16) | (atlas.pixels[o + 1] << 8) | atlas.pixels[o + 2];
            expect(ALL_PALETTE_COLORS.has(c), `${n} couleur ${c.toString(16)}`).toBe(true);
          }
        }
      }
      expect(opaque, n).toBeGreaterThan(40);
    }
  });
  it('le cristal alterne 2 frames d\'éclat et passe à la frame « vidée » après usage', () => {
    const frames = new Set<string>();
    for (let t = 0; t < 2000; t += 50) frames.add(crystalFrame(false, t));
    expect([...frames].sort()).toEqual(['heal_crystal_0', 'heal_crystal_1']);
    expect(crystalFrame(true, 0)).toBe('heal_crystal_used');
    expect(crystalFrame(true, 1234)).toBe('heal_crystal_used');
  });
  it('halo et texte distincts pour le demi-cœur et le cœur entier', () => {
    expect(pickupHaloColor('half')).not.toBe(pickupHaloColor('full'));
    expect(pickupTextColor('half')).not.toBe(pickupTextColor('full'));
    expect(pickupTextKey('half')).toBe('loot.pickup.half');
    expect(pickupTextKey('full')).toBe('loot.pickup.full');
  });
  it('le cœur du HUD est celui de l\'équilibrage (10 PV)', () => {
    expect(HP_PER_HEART).toBe(BALANCE_HP_PER_HEART);
    expect(HP_PER_HEART).toBe(10);
  });
});

describe('i18n des sources de vie (parité fr / en)', () => {
  const fr = frLoot as Record<string, string>;
  const en = enLoot as Record<string, string>;
  it('mêmes clés, valeurs non vides, mêmes placeholders', () => {
    expect(Object.keys(fr).sort()).toEqual(Object.keys(en).sort());
    for (const [k, v] of Object.entries(fr)) {
      expect(v.trim().length, k).toBeGreaterThan(0);
      expect(en[k].trim().length, k).toBeGreaterThan(0);
      const ph = (s: string): string => (s.match(/\{\w+\}/g) ?? []).sort().join(',');
      expect(ph(en[k]), k).toBe(ph(v));
    }
  });
  it('contient toutes les clés utilisées : textes flottants (+½ ♥ / +♥), +N PV du cristal, étiquette', () => {
    for (const k of [pickupTextKey('half'), pickupTextKey('full'), 'loot.crystal.heal', 'loot.crystal.label']) {
      expect(fr[k], k).toBeTruthy();
      expect(en[k], k).toBeTruthy();
    }
    expect(fr[pickupTextKey('half')]).toBe('+½ ♥');
    expect(fr[pickupTextKey('full')]).toBe('+♥');
    expect(fr['loot.crystal.heal']).toContain('{n}');
  });
});

describe('sons associés aux événements', () => {
  const pos = { x: 0, y: 0 };
  it('apparition, ramassage et cristal ont chacun leur son', () => {
    expect(sfxForEvent({ type: 'pickupDropped', pickupId: 1, kind: 'half', pos })).toBe('pickupDrop');
    expect(sfxForEvent({ type: 'pickupCollected', pickupId: 1, playerId: 0, kind: 'full', healed: 10, pos })).toBe('pickup');
    expect(sfxForEvent({ type: 'crystalUsed', crystalId: 'c1', playerId: 0, healed: 50, pos })).toBe('crystalHeal');
  });
});
