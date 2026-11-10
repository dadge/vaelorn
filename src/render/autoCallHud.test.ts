/**
 * Indicateur d'APPEL AUTOMATIQUE (symbole à la place du point) : modèle pur (quel symbole, pour qui, où, quelle taille) et dessin avec de faux objets Phaser.
 * Non-régression : l'appel manuel garde son point (aucune image de symbole créée).
 */
import { describe, expect, it } from 'vitest';
import { AUTO_CALL_DURATION_MS } from '../core/balance';
import { CALL_DURATION_MS } from '../core/constants';
import { makeTestLevel } from '../core/levelValidation';
import { createSimulation } from '../core/simulation';
import type { AutoCallState, GameState, PlayerId, Vec2 } from '../core/types';
import type { ViewContext } from '../entities/common';
import { buildAtlasData, hasFrame } from './art';
import { CallEdgeHud } from './callHud';
import {
  CALL_DOT_RADIUS,
  CALL_SYMBOL_BACK_ALPHA,
  CALL_SYMBOL_BACK_RADIUS,
  CALL_SYMBOL_CROSS_BACK_ALPHA,
  CALL_SYMBOL_CROSS_BACK_COLOR,
  CALL_SYMBOL_CROSS_FRAME,
  CALL_SYMBOL_HEART_BACK_ALPHA,
  CALL_SYMBOL_HEART_BACK_COLOR,
  CALL_SYMBOL_OVERHEAD_WORLD,
  CALL_SYMBOL_SIZE,
  autoCallOverheadPos,
  autoCallSymbolFrame,
  callSymbolBack,
  callEdgeMargin,
  callSignalElapsedMs,
  callSymbolDisplayScale,
  callSymbolEdgeMargin,
  callSymbolFor,
  collectCallers,
  isAutoCallVisibleTo,
} from './callIndicator';
import { gearIconFrameOf } from './gearFx';
import { computeLayout } from './splitscreen';

function makeState(n = 4): GameState {
  const level = makeTestLevel();
  const players = Array.from({ length: n }, (_, i) => ({ id: i as PlayerId, characterId: 'david' as const, difficulty: 2 as const }));
  return createSimulation({ levelId: 'test', seed: 1, players }, level).state;
}

const heartCall = (to: PlayerId[] = [0], ms = AUTO_CALL_DURATION_MS): AutoCallState => ({ icon: 'heart', ref: 'p1', ms, to });

describe('modèle pur : symbole de l\'appel automatique', () => {
  it("frame : cœur plein, demi-cœur, ou icône 8×8 de l'objet (frames qui existent dans l'atlas)", () => {
    expect(autoCallSymbolFrame({ icon: 'heart' })).toBe('ui_heart_full');
    expect(autoCallSymbolFrame({ icon: 'half' })).toBe('ui_heart_half');
    expect(autoCallSymbolFrame({ icon: 'gear', item: { slot: 'weapon', level: 2 } })).toBe(gearIconFrameOf({ slot: 'weapon', level: 2 }));
    expect(autoCallSymbolFrame({ icon: 'gear', item: { slot: 'accessory', level: 3, accessory: 'vampire' } })).toBe('gear_icon_accessory_vampire_3');
    for (const f of ['ui_heart_full', 'ui_heart_half', 'gear_icon_weapon_2', 'gear_icon_accessory_vampire_3']) expect(hasFrame(f), f).toBe(true);
  });

  it('visible seulement par les destinataires utiles, jamais par l\'émetteur, jamais si l\'émetteur est à terre', () => {
    const s = makeState(3);
    const p = s.players[0];
    p.autoCall = heartCall([1]);
    expect(isAutoCallVisibleTo(p, 1)).toBe(true);
    expect(isAutoCallVisibleTo(p, 2)).toBe(false); // allié pour qui l'objet est inutile
    expect(isAutoCallVisibleTo(p, 0)).toBe(false); // l'émetteur
    p.status = 'down';
    expect(isAutoCallVisibleTo(p, 1)).toBe(false);
  });

  it("signal terminé (ms = 0) : invisible ; appel manuel en cours : le point habituel (pas de symbole)", () => {
    const s = makeState(2);
    const p = s.players[0];
    p.autoCall = heartCall([1], 0);
    expect(isAutoCallVisibleTo(p, 1)).toBe(false);
    p.autoCall = heartCall([1]);
    expect(callSymbolFor(p, 1)).toBe('ui_heart_full');
    p.callMs = CALL_DURATION_MS; // l'appel manuel l'emporte
    expect(callSymbolFor(p, 1)).toBeNull();
  });

  it('collectCallers : les émetteurs automatiques destinés au spectateur sont listés avec les appelants manuels', () => {
    const s = makeState(4);
    s.players[1].autoCall = heartCall([0]);
    s.players[2].autoCall = heartCall([3]); // pas pour le spectateur 0
    s.players[3].callMs = 1000; // manuel
    const out: typeof s.players = [];
    const n = collectCallers(s.players, 0, out);
    expect(n).toBe(2);
    expect(out.map((q) => q.id)).toEqual([1, 3]);
  });

  it('temps écoulé : dérivé de autoCall.ms (3 s au total), manuel inchangé', () => {
    const s = makeState(2);
    const p = s.players[0];
    p.autoCall = heartCall([1], AUTO_CALL_DURATION_MS);
    expect(callSignalElapsedMs(p)).toBe(0);
    p.autoCall.ms = 600;
    expect(callSignalElapsedMs(p)).toBe(AUTO_CALL_DURATION_MS - 600);
    p.callMs = 2000;
    expect(callSignalElapsedMs(p)).toBe(CALL_DURATION_MS - 2000);
  });

  it("taille lisible : 16 px d'écran à l'échelle de base (icône de 8 px × 2), proportionnelle au zoom, TOUJOURS un facteur entier aux deux zooms du jeu ; le disque tient dans la marge", () => {
    expect(CALL_SYMBOL_SIZE).toBe(16);
    expect(callSymbolDisplayScale(1)).toBe(2); // zoom 2 (4 joueurs)
    expect(callSymbolDisplayScale(1.5)).toBe(3); // zoom 3 (1-2 joueurs)
    expect(callSymbolDisplayScale(1) * 8).toBeCloseTo(CALL_SYMBOL_SIZE);
    expect(callSymbolDisplayScale(1.5) * 8).toBeCloseTo(CALL_SYMBOL_SIZE * 1.5);
    expect(callSymbolEdgeMargin(1)).toBeGreaterThan(CALL_SYMBOL_BACK_RADIUS); // disque + liseré entièrement dans la vue
    expect(callSymbolEdgeMargin(1)).toBeGreaterThan(callEdgeMargin(1)); // plus grande que celle du point
    expect(CALL_SYMBOL_BACK_RADIUS).toBeGreaterThan(CALL_DOT_RADIUS); // le symbole remplace le point en restant lisible
  });
});

// ───────────────────────────── Dessin (faux Phaser) ─────────────────────────────

class FakeGraphics {
  calls: { fn: string; args: unknown[] }[] = [];
  private rec(fn: string, args: unknown[]): this {
    this.calls.push({ fn, args });
    return this;
  }
  setDepth(): this {
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
  destroy(): void {}
  count(fn: string): number {
    return this.calls.filter((c) => c.fn === fn).length;
  }
}

class FakeImage {
  frame: string;
  x: number;
  y: number;
  scale = 1;
  alpha = 1;
  visible = true;
  depth = 0;
  destroyed = false;
  constructor(x: number, y: number, frame: string) {
    this.x = x;
    this.y = y;
    this.frame = frame;
  }
  setOrigin(): this {
    return this;
  }
  setDepth(d: number): this {
    this.depth = d;
    return this;
  }
  setFrame(f: string): this {
    this.frame = f;
    return this;
  }
  setPosition(x: number, y: number): this {
    this.x = x;
    this.y = y;
    return this;
  }
  setScale(s: number): this {
    this.scale = s;
    return this;
  }
  setAlpha(a: number): this {
    this.alpha = a;
    return this;
  }
  setVisible(v: boolean): this {
    this.visible = v;
    return this;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

function setup() {
  const layout = computeLayout(4);
  const vp = layout.viewports[0];
  const g = new FakeGraphics();
  const images: FakeImage[] = [];
  const hudRegistered: unknown[] = [];
  const ctx = {
    scene: {
      add: {
        graphics: () => g,
        image: (x: number, y: number, _key: string, frame: string) => {
          const im = new FakeImage(x, y, frame);
          images.push(im);
          return im;
        },
      },
    },
    rig: {
      registerHud: (o: unknown) => {
        hudRegistered.push(o);
        return o;
      },
      registerWorld: (o: unknown) => o,
    },
    zoom: layout.zoom,
    playerCount: 4,
  } as unknown as ViewContext;
  const hud = new CallEdgeHud(ctx, vp, 20, 6);
  return { layout, vp, g, images, hudRegistered, hud, state: makeState(), cam: { x: 400, y: 300 } as Vec2 };
}

describe('disque du symbole et position au-dessus de la tête', () => {
  it('cœur et demi-cœur : disque CLAIR (le demi-cœur se distingue) ; objet : disque sombre', () => {
    expect(callSymbolBack('ui_heart_full', 0x111111)).toEqual({ color: CALL_SYMBOL_HEART_BACK_COLOR, alpha: CALL_SYMBOL_HEART_BACK_ALPHA });
    expect(callSymbolBack('ui_heart_half', 0x111111)).toEqual({ color: CALL_SYMBOL_HEART_BACK_COLOR, alpha: CALL_SYMBOL_HEART_BACK_ALPHA });
    expect(callSymbolBack('gear_icon_weapon_2', 0x111111)).toEqual({ color: 0x111111, alpha: CALL_SYMBOL_BACK_ALPHA });
  });

  it("position flottante : au-dessus de l'émetteur, ramenée dans la vue (marge) près des bords", () => {
    const out = { x: 0, y: 0 };
    autoCallOverheadPos({ x: 400, y: 300 }, { x: 400, y: 300 }, 2, 400, 300, 10, out);
    expect(out).toEqual({ x: 200, y: 150 - CALL_SYMBOL_OVERHEAD_WORLD * 2 });
    autoCallOverheadPos({ x: 400, y: 300 - 74 }, { x: 400, y: 300 }, 2, 400, 300, 10, out); // tête collée au bord haut
    expect(out.y).toBe(10);
    autoCallOverheadPos({ x: 400 + 99, y: 300 + 200 }, { x: 400, y: 300 }, 2, 400, 300, 10, out);
    expect(out.x).toBeLessThanOrEqual(390);
    expect(out.y).toBe(290);
  });
});

describe('CallEdgeHud : symbole à la place du point', () => {
  it("appel automatique pour le spectateur : un disque sombre + liseré + UNE image de symbole à l'emplacement du point, et les 3 arcs inchangés", () => {
    const { g, images, hudRegistered, hud, state, cam, vp, layout } = setup();
    state.players[1].pos = { x: cam.x + 1000, y: cam.y };
    state.players[1].autoCall = heartCall([0]);
    hud.update(state, 0, cam, [], 0);
    expect(g.count('arc')).toBe(3 * 2); // 3 arcs (contour + couleur), comme l'appel manuel
    expect(images).toHaveLength(1);
    const im = images[0];
    expect(im.frame).toBe('ui_heart_full');
    expect(im.visible).toBe(true);
    expect(im.scale).toBeCloseTo(callSymbolDisplayScale(layout.zoom / 2));
    expect(hudRegistered).toContain(im); // objet d'interface : ignoré des caméras du monde
    // le symbole est exactement au centre des arcs
    const arc = g.calls.find((c) => c.fn === 'arc');
    expect([im.x, im.y]).toEqual([arc?.args[0], arc?.args[1]]);
    expect(im.x).toBeGreaterThan(vp.x + vp.w - 12 * (layout.zoom / 2)); // collé au bord droit, sans déborder
    expect(im.x).toBeLessThanOrEqual(vp.x + vp.w - callSymbolEdgeMargin(layout.zoom / 2) + 1e-6);
    // pas de point plein : le disque du symbole est plus grand que celui du point
    const circles = g.calls.filter((c) => c.fn === 'fillCircle').map((c) => c.args[2] as number);
    expect(circles).toEqual([CALL_SYMBOL_BACK_RADIUS * (layout.zoom / 2)]);
  });

  it('demi-cœur et icône d\'objet : la frame suit l\'objet ; un changement d\'objet met à jour la même image', () => {
    const { images, hud, state, cam } = setup();
    const e = state.players[1];
    e.pos = { x: cam.x + 1000, y: cam.y };
    e.autoCall = { icon: 'half', ref: 'p2', ms: 2500, to: [0] };
    hud.update(state, 0, cam, [], 0);
    expect(images[0].frame).toBe('ui_heart_half');
    e.autoCall = { icon: 'gear', ref: 'g1', ms: 2400, to: [0], item: { slot: 'boots', level: 3 } };
    hud.update(state, 0, cam, [], 0);
    expect(images).toHaveLength(1);
    expect(images[0].frame).toBe('gear_icon_boots_3');
  });

  it("allié pour qui l'objet est inutile (hors destinataires) : rien n'est dessiné", () => {
    const { g, images, hud, state, cam } = setup();
    state.players[1].pos = { x: cam.x + 1000, y: cam.y };
    state.players[1].autoCall = heartCall([2]);
    hud.update(state, 0, cam, [], 0);
    expect(g.calls).toHaveLength(0);
    expect(images).toHaveLength(0);
  });

  it("émetteur visible dans la vue d'un destinataire : ni arcs ni indicateur de bord, mais le symbole flotte au-dessus de sa tête (son seul HUD)", () => {
    const { g, images, hud, state, cam, vp, layout } = setup();
    state.players[1].pos = { x: cam.x + 20, y: cam.y + 10 };
    state.players[1].autoCall = heartCall([0]);
    hud.update(state, 0, cam, [], 0);
    expect(g.count('arc')).toBe(0);
    expect(g.count('fillCircle')).toBe(1);
    expect(g.count('strokeCircle')).toBe(1);
    expect(images).toHaveLength(1);
    expect(images[0].frame).toBe('ui_heart_full');
    expect(images[0].visible).toBe(true);
    // au-dessus de la tête de l'émetteur (CALL_SYMBOL_OVERHEAD_WORLD px monde plus haut), en repère de la vue décalé de la vue
    expect(images[0].x).toBeCloseTo(vp.x + vp.w / 2 + 20 * layout.zoom);
    expect(images[0].y).toBeCloseTo(vp.y + vp.h / 2 + (10 - CALL_SYMBOL_OVERHEAD_WORLD) * layout.zoom);
  });

  it("émetteur visible mais spectateur hors destinataires, ou appel MANUEL d'un émetteur visible : rien dans ce HUD (le manuel garde les anneaux du monde)", () => {
    const { g, images, hud, state, cam } = setup();
    state.players[1].pos = { x: cam.x + 20, y: cam.y + 10 };
    state.players[1].autoCall = heartCall([3]);
    hud.update(state, 0, cam, [], 0);
    expect(g.calls).toHaveLength(0);
    expect(images).toHaveLength(0);
    delete state.players[1].autoCall;
    state.players[1].callMs = 2000;
    hud.update(state, 0, cam, [], 0);
    expect(g.calls).toHaveLength(0);
    expect(images).toHaveLength(0);
  });

  it("fin du signal : l'image est masquée et la zone vidée une seule fois", () => {
    const { g, images, hud, state, cam } = setup();
    const e = state.players[1];
    e.pos = { x: cam.x + 1000, y: cam.y };
    e.autoCall = heartCall([0], 500);
    hud.update(state, 0, cam, [], 0);
    expect(images[0].visible).toBe(true);
    const before = g.count('clear');
    delete e.autoCall;
    hud.update(state, 0, cam, [], 0);
    hud.update(state, 0, cam, [], 0);
    expect(images[0].visible).toBe(false);
    expect(g.count('clear')).toBe(before + 1);
  });

  it('fondu de sortie : l\'opacité du symbole suit celle des arcs dans les derniers instants', () => {
    const { images, hud, state, cam } = setup();
    const e = state.players[1];
    e.pos = { x: cam.x + 1000, y: cam.y };
    e.autoCall = heartCall([0], 1500);
    hud.update(state, 0, cam, [], 0);
    expect(images[0].alpha).toBeCloseTo(1);
    e.autoCall.ms = 30;
    hud.update(state, 0, cam, [], 0);
    expect(images[0].alpha).toBeCloseTo(0.2, 1);
  });

  it('le symbole est FIXE : même opacité à tous les instants hors fondu (aucun clignotement)', () => {
    const { images, hud, state, cam } = setup();
    const e = state.players[1];
    e.pos = { x: cam.x + 1000, y: cam.y };
    const alphas = new Set<number>();
    for (let ms = AUTO_CALL_DURATION_MS; ms > 400; ms -= 37) {
      e.autoCall = heartCall([0], ms);
      hud.update(state, 0, cam, [], 0);
      alphas.add(images[0].alpha);
    }
    expect([...alphas]).toEqual([1]);
  });

  it("deux émetteurs : deux images, deux positions distinctes ; un seul reste après l'extinction de l'un", () => {
    const { images, hud, state, cam } = setup();
    state.players[1].pos = { x: cam.x + 1000, y: cam.y };
    state.players[2].pos = { x: cam.x + 1000, y: cam.y };
    state.players[1].autoCall = heartCall([0]);
    state.players[2].autoCall = { icon: 'half', ref: 'p9', ms: 2000, to: [0] };
    hud.update(state, 0, cam, [], 0);
    expect(images).toHaveLength(2);
    expect(`${images[0].x},${images[0].y}`).not.toBe(`${images[1].x},${images[1].y}`);
    delete state.players[2].autoCall;
    hud.update(state, 0, cam, [], 0);
    expect(images.filter((i) => i.visible)).toHaveLength(1);
  });

  it("appel MANUEL : le point habituel (rayon CALL_DOT_RADIUS), aucune image de symbole n'est créée", () => {
    const { g, images, hud, state, cam, layout } = setup();
    state.players[1].pos = { x: cam.x + 1000, y: cam.y };
    state.players[1].callMs = CALL_DURATION_MS;
    hud.update(state, 0, cam, [], 0);
    expect(images).toHaveLength(0);
    const radii = g.calls.filter((c) => c.fn === 'fillCircle').map((c) => c.args[2] as number);
    const s = layout.zoom / 2;
    expect(radii).toEqual([CALL_DOT_RADIUS * s, (CALL_DOT_RADIUS - 1) * s]);
    expect(g.count('strokeCircle')).toBe(0);
  });

  it("appel manuel qui remplace l'automatique : retour au point, symbole masqué", () => {
    const { g, images, hud, state, cam } = setup();
    const e = state.players[1];
    e.pos = { x: cam.x + 1000, y: cam.y };
    e.autoCall = heartCall([0]);
    hud.update(state, 0, cam, [], 0);
    delete e.autoCall;
    e.callMs = CALL_DURATION_MS;
    hud.update(state, 0, cam, [], 0);
    expect(images[0].visible).toBe(false);
    expect(g.count('strokeCircle')).toBe(1); // celui du symbole du 1er dessin seulement
  });

  it('destroy détruit les images', () => {
    const { images, hud, state, cam } = setup();
    state.players[1].pos = { x: cam.x + 1000, y: cam.y };
    state.players[1].autoCall = heartCall([0]);
    hud.update(state, 0, cam, [], 0);
    hud.destroy();
    expect(images.every((i) => i.destroyed)).toBe(true);
  });
});

// ───────────────────────────── Croix rouge (demande de soins) ─────────────────────────────

const crossCall = (to: PlayerId[] = [0], ms = AUTO_CALL_DURATION_MS): AutoCallState => ({ icon: 'cross', ref: 'x', ms, to });

describe('croix rouge : symbole, disque, dessin', () => {
  it("frame d'atlas `ui_medcross` (existe dans l'atlas), visible seulement par les destinataires qui peuvent soigner, jamais par l'émetteur ni si l'appel manuel l'emporte", () => {
    expect(autoCallSymbolFrame({ icon: 'cross' })).toBe('ui_medcross');
    expect(autoCallSymbolFrame({ icon: 'cross' })).toBe(CALL_SYMBOL_CROSS_FRAME);
    expect(hasFrame('ui_medcross')).toBe(true);
    const s = makeState(3);
    const p = s.players[0];
    p.autoCall = crossCall([1]);
    expect(callSymbolFor(p, 1)).toBe('ui_medcross');
    expect(callSymbolFor(p, 2)).toBeNull(); // ne peut pas soigner : ne voit rien
    expect(callSymbolFor(p, 0)).toBeNull(); // l'émetteur
    p.callMs = 2000; // appel manuel en cours : il l'emporte (le point habituel)
    expect(callSymbolFor(p, 1)).toBeNull();
  });

  it('disque BLANC CASSÉ derrière la croix (rouge sur blanc, lisible sur tout fond) ; cœurs et objets inchangés', () => {
    expect(callSymbolBack('ui_medcross', 0x111111)).toEqual({ color: CALL_SYMBOL_CROSS_BACK_COLOR, alpha: CALL_SYMBOL_CROSS_BACK_ALPHA });
    expect(callSymbolBack('ui_heart_full', 0x111111)).toEqual({ color: CALL_SYMBOL_HEART_BACK_COLOR, alpha: CALL_SYMBOL_HEART_BACK_ALPHA });
    expect(callSymbolBack('gear_icon_weapon_2', 0x111111)).toEqual({ color: 0x111111, alpha: CALL_SYMBOL_BACK_ALPHA });
    const lum = (c: number): number => ((c >> 16) & 255) * 0.3 + ((c >> 8) & 255) * 0.59 + (c & 255) * 0.11;
    expect(lum(CALL_SYMBOL_CROSS_BACK_COLOR)).toBeGreaterThan(220); // clair : la croix rouge ressort
  });

  it("la croix a EXACTEMENT les mêmes tailles que les autres symboles (icône 8×8 agrandie, même échelle, même disque, même marge)", () => {
    const { images, hud, state, cam, layout } = setup();
    const e = state.players[1];
    e.pos = { x: cam.x + 1000, y: cam.y };
    e.autoCall = heartCall([0]);
    hud.update(state, 0, cam, [], 0);
    const heartScale = images[0].scale;
    e.autoCall = crossCall([0]);
    hud.update(state, 0, cam, [], 0);
    expect(images).toHaveLength(1);
    expect(images[0].frame).toBe('ui_medcross');
    expect(images[0].scale).toBe(heartScale);
    expect(images[0].scale).toBeCloseTo(callSymbolDisplayScale(layout.zoom / 2));
    expect(images[0].scale * 8).toBeCloseTo(CALL_SYMBOL_SIZE * (layout.zoom / 2));
    // les frames sont toutes en 8×8 : la croix tient dans le même carré que les cœurs
    const atlas = buildAtlasData();
    for (const f of ['ui_medcross', 'ui_heart_full', 'ui_heart_half', 'gear_icon_weapon_2']) expect([atlas.frames[f].w, atlas.frames[f].h], f).toEqual([8, 8]);
  });

  it("dessin : 3 arcs inchangés, disque blanc cassé de même rayon que les autres symboles, liseré de la couleur de l'émetteur, UNE image de croix à la place du point", () => {
    const { g, images, hud, state, cam, layout } = setup();
    const e = state.players[1];
    e.pos = { x: cam.x + 1000, y: cam.y };
    e.autoCall = crossCall([0]);
    hud.update(state, 0, cam, [], 0);
    expect(g.count('arc')).toBe(3 * 2);
    expect(images).toHaveLength(1);
    expect(images[0].frame).toBe('ui_medcross');
    const fill = g.calls.find((c) => c.fn === 'fillStyle');
    expect(fill?.args[0]).toBe(CALL_SYMBOL_CROSS_BACK_COLOR);
    expect(g.calls.filter((c) => c.fn === 'fillCircle').map((c) => c.args[2])).toEqual([CALL_SYMBOL_BACK_RADIUS * (layout.zoom / 2)]);
    const arc = g.calls.find((c) => c.fn === 'arc');
    expect([images[0].x, images[0].y]).toEqual([arc?.args[0], arc?.args[1]]);
  });

  it("émetteur visible dans la vue d'un destinataire : la croix flotte au-dessus de sa tête (HUD de ce seul destinataire) ; un allié qui ne peut pas soigner ne voit rien", () => {
    const { g, images, hud, state, cam } = setup();
    state.players[1].pos = { x: cam.x + 20, y: cam.y + 10 };
    state.players[1].autoCall = crossCall([2]); // pas le spectateur 0
    hud.update(state, 0, cam, [], 0);
    expect(g.calls).toHaveLength(0);
    expect(images).toHaveLength(0);
    state.players[1].autoCall = crossCall([0]);
    hud.update(state, 0, cam, [], 0);
    expect(g.count('arc')).toBe(0);
    expect(images).toHaveLength(1);
    expect(images[0].frame).toBe('ui_medcross');
  });
});

describe('croix rouge : dessin de l atlas provisoire (`ui_medcross`)', () => {
  const atlas = buildAtlasData();
  const r = atlas.frames['ui_medcross'];
  const px = (x: number, y: number): [number, number, number, number] => {
    const i = ((r.y + y) * atlas.width + (r.x + x)) * 4;
    return [atlas.pixels[i], atlas.pixels[i + 1], atlas.pixels[i + 2], atlas.pixels[i + 3]];
  };

  it('8×8, AUCUN pixel semi-transparent (alpha 0 ou 255)', () => {
    expect([r.w, r.h]).toEqual([8, 8]);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) expect([0, 255], `(${x},${y})`).toContain(px(x, y)[3]);
  });

  it('une croix médicale : deux barres rouges vif (centre plein, bras sur les 4 côtés), contour sombre, reflet blanc', () => {
    let red = 0;
    let dark = 0;
    let white = 0;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const [pr, pg, pb, pa] = px(x, y);
        if (pa === 0) continue;
        if (pr > 200 && pg < 60 && pb < 70) red++;
        else if (pr < 40 && pg < 40 && pb < 70) dark++;
        else if (pr > 240 && pg > 240 && pb > 240) white++;
      }
    }
    expect(red).toBeGreaterThanOrEqual(16); // les barres (2 × 6 − 4 au centre = 20, moins les reflets)
    expect(dark).toBeGreaterThanOrEqual(14); // le contour
    expect(white).toBeGreaterThanOrEqual(1);
    // le centre est rouge ; les 4 coins sont transparents (forme de croix, pas un carré)
    for (const [x, y] of [[3, 3], [4, 3], [3, 4], [4, 4]]) expect(px(x, y).slice(0, 3), `${x},${y}`).toEqual([0xe8, 0x14, 0x2a]);
    for (const [x, y] of [[0, 0], [7, 0], [0, 7], [7, 7]]) expect(px(x, y)[3], `coin ${x},${y}`).toBe(0);
    // bras sur les 4 côtés
    for (const [x, y] of [[3, 1], [1, 3], [6, 4], [4, 6]]) expect(px(x, y)[3], `bras ${x},${y}`).toBe(255);
  });
});
