/**
 * Équipement — rendu PUR : frames d'atlas (présentes, tailles, palette blanche, manifeste), libellés fr/en (parité, texte flottant « Bottes ailées III : +30 %
 * vitesse »), clignotement (≤ 3 Hz, mouvement réduit), flottement, rangée d'icônes du HUD (ordre, pastilles de niveau, emplacements vides).
 */
import { describe, expect, it } from 'vitest';
import { GEAR_BLINK_MS } from '../core/balance';
import { GEAR_SLOTS, createGear } from '../core/gear';
import type { GearItem, PlayerGear } from '../core/types';
import { setLanguage, t } from '../i18n/i18n';
import { ALL_PALETTE_COLORS } from './palettes';
import { FRAME_NAMES, buildAtlasData, hasFrame, manifestCovers } from './art';
import { GEAR_ART_SLOTS, gearIconFrame, gearWorldFrame } from './art/gear';
import {
  BUFF_HUD_ORDER,
  GEAR_REDUCED_ALPHA,
  GEAR_SWAP_PROMPT_KEY,
  buffColor,
  buffEffect,
  buffFrame,
  buffHudEntries,
  buffHudSignature,
  buffIconFrameOf,
  buffNameKey,
  buffStartedText,
  buffTotalMs,
  gearAlpha,
  gearBob,
  gearEffect,
  gearEmptyFrame,
  gearFrame,
  gearHudSignature,
  gearHudSlots,
  gearIconFrameOf,
  gearLabel,
  gearLevelColor,
  gearNameKey,
  gearPickedColor,
  gearPickedText,
  gearSlotKey,
} from './gearFx';

const ITEMS: GearItem[] = GEAR_ART_SLOTS.flatMap((slot) => [1, 2, 3].map((level) => ({ slot, level }) as GearItem));

describe('sprites provisoires de l\'équipement', () => {
  it('15 objets au sol 16×16 et 15 icônes 8×8, tous dans l\'atlas, sans doublon de nom', () => {
    const atlas = buildAtlasData();
    for (const slot of GEAR_ART_SLOTS) {
      for (const level of [1, 2, 3]) {
        const w = gearWorldFrame(slot, level);
        const i = gearIconFrame(slot, level);
        expect(hasFrame(w), w).toBe(true);
        expect(hasFrame(i), i).toBe(true);
        expect(FRAME_NAMES).toContain(w);
        expect([atlas.frames[w].w, atlas.frames[w].h], w).toEqual([16, 16]);
        expect([atlas.frames[i].w, atlas.frames[i].h], i).toEqual([8, 8]);
      }
    }
    expect(new Set(FRAME_NAMES).size).toBe(FRAME_NAMES.length);
  });
  it('les noms de frames du rendu correspondent à ceux de l\'art', () => {
    for (const it of ITEMS) {
      expect(gearFrame(it)).toBe(gearWorldFrame(it.slot, it.level));
      expect(gearIconFrameOf(it)).toBe(gearIconFrame(it.slot, it.level));
      expect(hasFrame(gearFrame(it))).toBe(true);
    }
  });
  it('couverts par le manifeste (SPRITES.md) ; aucun pixel hors palette, aucun pixel semi-transparent, dessin non vide', () => {
    const atlas = buildAtlasData();
    for (const slot of GEAR_ART_SLOTS) {
      for (const level of [1, 2, 3]) {
        for (const n of [gearWorldFrame(slot, level), gearIconFrame(slot, level)]) {
          expect(manifestCovers(n), n).toBe(true);
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
          expect(opaque, n).toBeGreaterThan(r.w === 16 ? 40 : 14);
        }
      }
    }
  });
  it('objet au sol sans cadre ni boîte : les coins de la frame restent transparents', () => {
    const atlas = buildAtlasData();
    for (const it of ITEMS) {
      const r = atlas.frames[gearFrame(it)];
      for (const [x, y] of [[0, 0], [15, 0], [0, 15], [15, 15]]) expect(atlas.pixels[((r.y + y) * atlas.width + (r.x + x)) * 4 + 3], gearFrame(it)).toBe(0);
    }
  });
  it('les 3 niveaux d\'un emplacement ont des dessins différents', () => {
    const atlas = buildAtlasData();
    const sig = (n: string): string => {
      const r = atlas.frames[n];
      let s = '';
      for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) s += atlas.pixels.slice(((r.y + y) * atlas.width + (r.x + x)) * 4, ((r.y + y) * atlas.width + (r.x + x)) * 4 + 4).join(',') + ';';
      return s;
    };
    for (const slot of GEAR_ART_SLOTS) {
      const sigs = new Set([1, 2, 3].map((l) => sig(gearWorldFrame(slot, l))));
      expect(sigs.size, slot).toBe(3);
    }
  });
});

describe('clignotement, flottement, couleurs', () => {
  it('opaque tant qu\'il reste plus de 4 s ; clignote ensuite à 2 Hz puis 3 Hz (dernière seconde), jamais plus de 3 flashs/s', () => {
    expect(GEAR_BLINK_MS).toBe(4000);
    for (let tm = 0; tm < 5000; tm += 33) expect(gearAlpha(GEAR_BLINK_MS + 1, tm)).toBe(1);
    // fréquence maximale : compter les montées d'opacité (= flashs) par seconde, sur 4 s de jeu
    const rises = (ttl: number): number => {
      let n = 0;
      let prev = gearAlpha(ttl, 0);
      for (let tm = 1; tm < 4000; tm++) {
        const a = gearAlpha(ttl, tm);
        if (a > prev) n++;
        prev = a;
      }
      return n / 4;
    };
    expect(rises(3000)).toBeLessThanOrEqual(3);
    expect(rises(3000)).toBeGreaterThanOrEqual(1.5);
    expect(rises(500)).toBeLessThanOrEqual(3);
    const values = new Set<number>();
    for (let tm = 0; tm < 2000; tm += 10) values.add(gearAlpha(2000, tm));
    expect(values).toEqual(new Set([1, 0.2]));
  });
  it('prefers-reduced-motion : aucun clignotement (opacité fixe) et aucun flottement', () => {
    for (let tm = 0; tm < 3000; tm += 37) {
      expect(gearAlpha(2000, tm, true)).toBe(GEAR_REDUCED_ALPHA);
      expect(gearAlpha(GEAR_BLINK_MS + 100, tm, true)).toBe(1);
      expect(gearBob(tm, 3, true)).toBe(0);
    }
  });
  it('flottement borné à ±1,2 px et déphasé par l\'id', () => {
    for (let tm = 0; tm < 3000; tm += 41) expect(Math.abs(gearBob(tm, 7))).toBeLessThanOrEqual(1.2 + 1e-9);
    expect(gearBob(500, 1)).not.toBe(gearBob(500, 2));
  });
  it('couleur par niveau : I argenté, II bleu, III doré, vide gris ; toutes distinctes ; valeur hors plage bornée', () => {
    const cols = [0, 1, 2, 3].map(gearLevelColor);
    expect(new Set(cols).size).toBe(4);
    expect(gearLevelColor(9)).toBe(gearLevelColor(3));
    expect(gearLevelColor(-2)).toBe(gearLevelColor(0));
    expect(gearPickedColor({ slot: 'boots', level: 3 })).toBe(gearLevelColor(3));
  });
});

describe('libellés (i18n fr / en)', () => {
  it('toutes les clés de noms, d\'emplacements et d\'effets existent en français ET en anglais (aucune clé nue)', () => {
    for (const lang of ['fr', 'en'] as const) {
      setLanguage(lang);
      const keys: string[] = ['gear.lost', 'gear.picked'];
      for (const it of ITEMS) {
        keys.push(gearNameKey(it));
        keys.push(gearEffect(it, false).key, gearEffect(it, true).key);
      }
      for (const s of GEAR_SLOTS) keys.push(gearSlotKey(s));
      for (const k of keys) expect(t(k, { n: 1, m: 1 }), `${lang} : ${k}`).not.toBe(k);
    }
    setLanguage('fr');
  });
  it('texte flottant du ramassage : « Bottes ailées III : +30 % vitesse »', () => {
    setLanguage('fr');
    expect(gearPickedText({ slot: 'boots', level: 3 }, false, t)).toBe('Bottes ailées III : +30 % vitesse');
    expect(gearLabel({ slot: 'magic', level: 3 }, t)).toBe('Chapeau de sorcier III');
    expect(gearPickedText({ slot: 'protection', level: 1 }, false, t)).toBe('Casque I : -10 % dégâts reçus');
    expect(gearPickedText({ slot: 'weapon', level: 2 }, false, t)).toBe('Hache II : +35 % dégâts, attaque 20 % plus lente');
    expect(gearPickedText({ slot: 'weapon', level: 3 }, false, t)).toBe('Arc III : tir à distance');
    expect(gearPickedText({ slot: 'weapon', level: 3 }, true, t)).toBe('Arc III : +15 % dégâts');
    setLanguage('en');
    expect(gearPickedText({ slot: 'boots', level: 3 }, false, t)).toBe('Winged boots III : +30% speed');
    expect(gearPickedText({ slot: 'artifact', level: 2 }, false, t)).toBe('Hourglass II : -25% special cooldown');
    setLanguage('fr');
  });
  it('les pourcentages affichés viennent de balance.ts (jamais recopiés)', () => {
    expect(gearEffect({ slot: 'boots', level: 1 }).params).toEqual({ n: 10 });
    expect(gearEffect({ slot: 'artifact', level: 3 }).params).toEqual({ n: 35 });
    expect(gearEffect({ slot: 'magic', level: 3 }).params).toEqual({ n: 50 });
    expect(gearEffect({ slot: 'weapon', level: 1 }).params).toEqual({ n: 20 });
    expect(gearEffect({ slot: 'weapon', level: 2 }).params).toEqual({ n: 35, m: 20 });
  });
});

describe('rangée d\'icônes du HUD', () => {
  it('toujours 6 cases, dans l\'ordre bottes, protection, artefact, magie, arme, accessoire', () => {
    expect(gearHudSlots(undefined).map((s) => s.slot)).toEqual(['boots', 'protection', 'artifact', 'magic', 'weapon', 'accessory']);
    expect(gearHudSlots(createGear())).toHaveLength(6);
  });
  it('emplacement vide : pas d\'icône, pas de pastille ; garni : icône 8×8 et pastille du niveau (I, II, III)', () => {
    const g: PlayerGear = { boots: 3, protection: 0, artifact: 1, magic: 0, weapon: 2, accessory: null };
    const row = gearHudSlots(g);
    expect(row.map((s) => s.level)).toEqual([3, 0, 1, 0, 2, 0]);
    expect(row.map((s) => s.pip)).toEqual(['III', '', 'I', '', 'II', '']);
    expect(row[0].frame).toBe('gear_icon_boots_3');
    expect(row[1].frame).toBeNull();
    expect(row[4].frame).toBe('gear_icon_weapon_2');
    for (const s of row) if (s.frame) expect(hasFrame(s.frame), s.frame).toBe(true);
    expect(row[0].color).toBe(gearLevelColor(3));
    expect(row[1].color).toBe(gearLevelColor(0));
  });
  it('signature : change avec l\'équipement, stable sinon', () => {
    const a = createGear();
    const b = { ...createGear(), boots: 1 };
    expect(gearHudSignature(a)).toBe(gearHudSignature(createGear()));
    expect(gearHudSignature(a)).not.toBe(gearHudSignature(b));
    expect(gearHudSignature({ ...b, boots: 2 })).not.toBe(gearHudSignature(b));
  });
});

// ───────────────────────────── Accessoires et bonus temporaires ─────────────────────────────

const ACC_ITEMS: GearItem[] = [
  ...(['lantern', 'magnet', 'warhorn'] as const).flatMap((accessory) => ([1, 2, 3] as const).map((level): GearItem => ({ slot: 'accessory', level, accessory }))),
  { slot: 'accessory', level: 3, accessory: 'vampire' },
];

describe('sprites provisoires des accessoires et des bonus temporaires', () => {
  it('10 accessoires et 3 bonus : objets 16×16 et icônes 8×8 dans l\'atlas, couverts par le manifeste, sans pixel hors palette ni semi-transparent', () => {
    const atlas = buildAtlasData();
    const names = [
      ...ACC_ITEMS.flatMap((it) => [gearFrame(it), gearIconFrameOf(it)]),
      ...(['speed', 'rage', 'star'] as const).flatMap((k) => [buffFrame(k), `gear_icon_buff_${k}`]),
    ];
    expect(names).toHaveLength(26);
    for (const n of names) {
      expect(hasFrame(n), n).toBe(true);
      expect(manifestCovers(n), n).toBe(true);
      const r = atlas.frames[n];
      expect([r.w, r.h]).toEqual(n.startsWith('gear_icon') ? [8, 8] : [16, 16]);
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
      expect(opaque, n).toBeGreaterThan(n.startsWith('gear_icon') ? 14 : 40);
    }
  });
  it('les 3 niveaux d\'un accessoire ont des dessins (teintes) différents ; coins des objets au sol transparents (pas de cadre)', () => {
    const atlas = buildAtlasData();
    const sig = (n: string): string => {
      const r = atlas.frames[n];
      let s = '';
      for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) s += atlas.pixels.slice(((r.y + y) * atlas.width + (r.x + x)) * 4, ((r.y + y) * atlas.width + (r.x + x)) * 4 + 4).join(',') + ';';
      return s;
    };
    for (const kind of ['lantern', 'magnet', 'warhorn'] as const) {
      expect(new Set([1, 2, 3].map((l) => sig(`gear_accessory_${kind}_${l}`))).size, kind).toBe(3);
    }
    for (const it of ACC_ITEMS) {
      const r = atlas.frames[gearFrame(it)];
      for (const [x, y] of [[0, 0], [15, 0], [0, 15], [15, 15]]) expect(atlas.pixels[((r.y + y) * atlas.width + (r.x + x)) * 4 + 3], gearFrame(it)).toBe(0);
    }
  });
});

describe('libellés des accessoires et des bonus (i18n fr / en)', () => {
  it('toutes les clés existent en français ET en anglais (noms, effets, bonus, invite d\'échange)', () => {
    for (const lang of ['fr', 'en'] as const) {
      setLanguage(lang);
      const keys: string[] = [GEAR_SWAP_PROMPT_KEY, 'gear.vampire.heal'];
      for (const it of ACC_ITEMS) keys.push(gearNameKey(it), gearEffect(it).key);
      for (const k of ['speed', 'rage', 'star', 'horn'] as const) keys.push(buffNameKey(k), buffEffect(k, 0.3).key);
      for (const k of keys) expect(t(k, { n: 1, k: 3, s: 1 }), `${lang} : ${k}`).not.toBe(k);
    }
    setLanguage('fr');
  });
  it('textes : « Lanterne II : la torche s\'use 50 % moins vite », « Anneau du vampire : +1 PV tous les 3 ennemis tués », invite « A : échanger »', () => {
    setLanguage('fr');
    expect(gearPickedText({ slot: 'accessory', level: 2, accessory: 'lantern' }, false, t)).toBe('Lanterne II : la torche s\'use 50 % moins vite');
    expect(gearPickedText({ slot: 'accessory', level: 3, accessory: 'magnet' }, false, t)).toBe('Aimant à cœurs III : attire cœurs et objets (120 px)');
    expect(gearPickedText({ slot: 'accessory', level: 1, accessory: 'warhorn' }, false, t)).toBe('Cor de guerre I : l\'appel donne +20 % de vitesse aux alliés');
    expect(gearPickedText({ slot: 'accessory', level: 3, accessory: 'vampire' }, false, t)).toBe('Anneau du vampire : +1 PV tous les 3 ennemis tués');
    expect(gearLabel({ slot: 'accessory', level: 3, accessory: 'vampire' }, t)).toBe('Anneau du vampire');
    expect(t(GEAR_SWAP_PROMPT_KEY)).toBe('A : échanger');
    setLanguage('en');
    expect(gearPickedText({ slot: 'accessory', level: 2, accessory: 'lantern' }, false, t)).toBe('Lantern II : torch burns 50% slower');
    expect(t(GEAR_SWAP_PROMPT_KEY)).toBe('A: swap');
    setLanguage('fr');
  });
  it('bonus temporaires : « Potion de vitesse : +40 % vitesse, 8 s », « Étoile : invulnérable 4 s », cor reçu « +30 % vitesse, 3 s » ; valeurs lues dans balance.ts', () => {
    setLanguage('fr');
    expect(buffStartedText('speed', undefined, 8000, t)).toBe('Potion de vitesse : +40 % vitesse, 8 s');
    expect(buffStartedText('rage', undefined, 8000, t)).toBe('Éclair de rage : +50 % dégâts, 8 s');
    expect(buffStartedText('star', undefined, 4000, t)).toBe('Étoile : invulnérable 4 s');
    expect(buffStartedText('horn', 0.3, 3000, t)).toBe('Cor de guerre : +30 % vitesse, 3 s');
    expect(buffEffect('speed').params).toEqual({ n: 40, s: 8 });
    expect(buffEffect('star').params).toEqual({ s: 4 });
  });
  it('effets d\'accessoire : paramètres issus de ACCESSORY_BONUS (30 / 50 / 70, 50 / 80 / 120, 20 / 30 / 40)', () => {
    expect([1, 2, 3].map((l) => gearEffect({ slot: 'accessory', level: l as 1, accessory: 'lantern' }).params?.n)).toEqual([30, 50, 70]);
    expect([1, 2, 3].map((l) => gearEffect({ slot: 'accessory', level: l as 1, accessory: 'magnet' }).params?.n)).toEqual([50, 80, 120]);
    expect([1, 2, 3].map((l) => gearEffect({ slot: 'accessory', level: l as 1, accessory: 'warhorn' }).params?.n)).toEqual([20, 30, 40]);
  });
});

describe('rangée d\'icônes du HUD : accessoire et bonus temporaires', () => {
  it('accessoire équipé : icône et pastille de niveau en 6e case ; l\'anneau du vampire est de niveau III ; case vide : silhouette atténuée', () => {
    const g: PlayerGear = { ...createGear(), accessory: { kind: 'magnet', level: 2 } };
    const row = gearHudSlots(g);
    expect(row[5]).toMatchObject({ slot: 'accessory', level: 2, pip: 'II', frame: 'gear_icon_accessory_magnet_2' });
    expect(gearHudSlots({ ...createGear(), accessory: { kind: 'vampire', level: 3 } })[5]).toMatchObject({ pip: 'III', frame: 'gear_icon_accessory_vampire_3' });
    expect(gearHudSlots(createGear())[5].frame).toBeNull();
    for (const s of GEAR_SLOTS) expect(hasFrame(gearEmptyFrame(s)), s).toBe(true);
    expect(gearHudSignature(g)).not.toBe(gearHudSignature({ ...g, accessory: { kind: 'lantern', level: 2 } }));
  });
  it('icônes de bonus : seulement les bonus actifs, dans l\'ordre vitesse, rage, étoile, cor ; fraction restante et secondes (arrondies au-dessus)', () => {
    expect(BUFF_HUD_ORDER).toEqual(['speed', 'rage', 'star', 'horn']);
    const e = buffHudEntries([
      { kind: 'star', remainingMs: 1000 },
      { kind: 'horn', remainingMs: 1500, power: 0.4 },
      { kind: 'speed', remainingMs: 8000 },
      { kind: 'rage', remainingMs: 0 },
    ]);
    expect(e.map((x) => x.kind)).toEqual(['speed', 'star', 'horn']);
    expect(e[0]).toMatchObject({ fraction: 1, seconds: 8, frame: 'gear_icon_buff_speed' });
    expect(e[1]).toMatchObject({ fraction: 0.25, seconds: 1 });
    expect(e[2]).toMatchObject({ fraction: 0.5, seconds: 2, frame: 'gear_icon_accessory_warhorn_3' });
    for (const x of e) expect(hasFrame(x.frame), x.frame).toBe(true);
    expect(buffHudEntries(undefined)).toEqual([]);
    expect(buffHudEntries([{ kind: 'speed', remainingMs: 0.5 }])[0].seconds).toBe(1);
  });
  it('icône du bonus du cor : niveau déduit de la puissance ; signature stable tant que l\'ensemble ne change pas', () => {
    expect([0.2, 0.3, 0.4].map((p) => buffIconFrameOf({ kind: 'horn', power: p }))).toEqual([
      'gear_icon_accessory_warhorn_1',
      'gear_icon_accessory_warhorn_2',
      'gear_icon_accessory_warhorn_3',
    ]);
    const a = buffHudSignature([{ kind: 'speed', remainingMs: 5000 }]);
    expect(buffHudSignature([{ kind: 'speed', remainingMs: 100 }])).toBe(a);
    expect(buffHudSignature([{ kind: 'speed', remainingMs: 100 }, { kind: 'rage', remainingMs: 100 }])).not.toBe(a);
  });
  it('couleurs des bonus distinctes ; durée totale : 8 s, 8 s, 4 s, 3 s', () => {
    expect(new Set(BUFF_HUD_ORDER.map(buffColor)).size).toBe(4);
    expect(BUFF_HUD_ORDER.map(buffTotalMs)).toEqual([8000, 8000, 4000, 3000]);
  });
});
