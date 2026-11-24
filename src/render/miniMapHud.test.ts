/**
 * Dessin de la minicarte avec une scène Phaser factice : texture créée à la taille de la salle, tuiles peintes UNE fois (nouvelles
 * seulement), rien repeint quand rien ne change, pions (point / anneau / croix) selon l'état, carte masquée mais découverte qui continue,
 * remise à zéro par salle, estompage sous un héros (1 vue), destruction propre.
 */
import { describe, expect, it } from 'vitest';
import { TILE } from '../core/constants';
import { makeTestRoom } from '../core/levelValidation';
import { createPlayerState } from '../core/players';
import type { GameState, PlayerId, PlayerState, RoomDef } from '../core/types';
import type { ViewContext } from '../entities/common';
import { MAP_HERO_FADE_ALPHA, MAP_DEPTH, MiniMapHud } from './MiniMapHud';
import { mapZone } from './mapZone';
import { MARKER_DOWN_DOT_ALPHA, MARKER_SMALL_MAP_FACTOR } from './miniMap';
import { computeLayout } from './splitscreen';

// ───────────────────────────── Faux Phaser ─────────────────────────────

class FakeObj {
  kind: string;
  x = 0;
  y = 0;
  alpha = 1;
  scale = 1;
  depth = 0;
  visible = true;
  destroyed = false;
  w = 0;
  h = 0;
  textureKey = '';
  draws = 0;
  constructor(kind: string) {
    this.kind = kind;
  }
  setOrigin(): this {
    return this;
  }
  setDepth(d: number): this {
    this.depth = d;
    return this;
  }
  setVisible(v: boolean): this {
    this.visible = v;
    return this;
  }
  setPosition(x: number, y: number): this {
    this.x = x;
    this.y = y;
    return this;
  }
  setSize(w: number, h: number): this {
    this.w = w;
    this.h = h;
    return this;
  }
  setAlpha(a: number): this {
    this.alpha = a;
    return this;
  }
  setScale(s: number): this {
    this.scale = s;
    return this;
  }
  setStrokeStyle(): this {
    return this;
  }
  setFillStyle(): this {
    return this;
  }
  setTexture(k: string): this {
    this.textureKey = k;
    return this;
  }
  // Graphics
  fillStyle(): this {
    return this;
  }
  fillRect(): this {
    this.draws++;
    return this;
  }
  lineStyle(): this {
    return this;
  }
  lineBetween(): this {
    this.draws++;
    return this;
  }
  strokeRect(): this {
    this.draws++;
    return this;
  }
  clear(): this {
    return this;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

class FakeCanvasTexture {
  fills: { x: number; y: number; style: string }[] = [];
  refreshes = 0;
  clears = 0;
  filter = -1;
  private style = '';
  readonly ctx2d: { fillStyle: string; fillRect: (x: number, y: number) => void; clearRect: () => void };
  constructor(
    readonly key: string,
    readonly width: number,
    readonly height: number,
  ) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    this.ctx2d = {
      get fillStyle(): string {
        return self.style;
      },
      set fillStyle(v: string) {
        self.style = v;
      },
      fillRect: (x: number, y: number) => {
        this.fills.push({ x, y, style: this.style });
      },
      clearRect: () => {
        this.clears++;
        this.fills.length = 0;
      },
    };
  }
  getContext(): unknown {
    return this.ctx2d;
  }
  refresh(): void {
    this.refreshes++;
  }
  setFilter(f: number): void {
    this.filter = f;
  }
}

function makeEnv(playerCount: number) {
  const objs: FakeObj[] = [];
  const textures = new Map<string, FakeCanvasTexture>();
  const make = (kind: string) => (): FakeObj => {
    const o = new FakeObj(kind);
    objs.push(o);
    return o;
  };
  const scene = {
    add: {
      rectangle: make('rect'),
      circle: make('circle'),
      graphics: make('gfx'),
      image: (_x: number, _y: number, key: string) => {
        const o = make('image')();
        o.textureKey = key;
        return o;
      },
    },
    textures: {
      createCanvas: (key: string, w: number, h: number) => {
        if (textures.has(key)) return null;
        const t = new FakeCanvasTexture(key, w, h);
        textures.set(key, t);
        return t;
      },
      exists: (k: string) => textures.has(k),
      remove: (k: string) => void textures.delete(k),
    },
  };
  const registered: unknown[] = [];
  const layout = computeLayout(playerCount);
  const ctx = {
    scene,
    rig: {
      registerHud: (o: unknown) => {
        registered.push(o);
        return o;
      },
    },
    zoom: layout.zoom,
    playerCount,
  } as unknown as ViewContext;
  return { ctx, layout, objs, textures, registered };
}

function hero(id: PlayerId, tx: number, ty: number, over: Partial<PlayerState> = {}): PlayerState {
  const p = createPlayerState({ id, characterId: (['david', 'sandrine', 'romain', 'valentine'] as const)[id], difficulty: 2 }, { x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2 });
  return Object.assign(p, over);
}

function stateOf(players: PlayerState[], elapsedMs = 0): GameState {
  return { players, room: { elapsedMs } } as unknown as GameState;
}

function room(id = 'r', cols = 40, rows = 30): RoomDef {
  const layout: string[] = [];
  for (let y = 0; y < rows; y++) layout.push(y === 0 || y === rows - 1 ? '#'.repeat(cols) : `#${'.'.repeat(cols - 2)}#`);
  return makeTestRoom({ id, layout });
}

const visibleOfKind = (objs: FakeObj[], kind: string): FakeObj[] => objs.filter((o) => o.kind === kind && o.visible && !o.destroyed);

describe('MiniMapHud (scène factice)', () => {
  it('crée la texture à la taille de la salle, peint les tuiles découvertes et place le panneau dans la zone centrale', () => {
    const env = makeEnv(4);
    const hud = new MiniMapHud(env);
    const r = room('a', 40, 30);
    hud.update(stateOf([hero(0, 20, 15)]), r, 16, 0);
    const tex = [...env.textures.values()][0];
    expect([tex.width, tex.height]).toEqual([40, 30]);
    expect(tex.filter).toBe(1);
    expect(tex.fills.length).toBeGreaterThan(50);
    expect(tex.refreshes).toBe(1);
    const zone = mapZone(env.layout)!;
    const pl = hud.currentPlacement!;
    expect(pl.panel.x).toBeGreaterThanOrEqual(zone.x);
    expect(pl.panel.x + pl.panel.w).toBeLessThanOrEqual(zone.x + zone.w);
    const panel = env.objs.find((o) => o.kind === 'rect')!;
    expect([panel.x, panel.y, panel.w, panel.h]).toEqual([pl.panel.x, pl.panel.y, pl.panel.w, pl.panel.h]);
    expect(panel.depth).toBe(MAP_DEPTH);
    const img = env.objs.find((o) => o.kind === 'image')!;
    expect([img.x, img.y, img.scale]).toEqual([pl.map.x, pl.map.y, pl.scale]);
  });

  it('tous les objets sont des objets d\'interface (enregistrés auprès de la caméra d\'interface)', () => {
    const env = makeEnv(4);
    const hud = new MiniMapHud(env);
    hud.update(stateOf([hero(0, 20, 15)]), room(), 16, 0);
    expect(env.registered.length).toBe(env.objs.length);
  });

  it('ne repeint rien quand rien ne change (même tuile) et ne peint que les nouvelles tuiles quand un héros avance', () => {
    const env = makeEnv(4);
    const hud = new MiniMapHud(env);
    const r = room();
    const p = hero(0, 20, 15);
    hud.update(stateOf([p], 0), r, 16, 0);
    const tex = [...env.textures.values()][0];
    const first = tex.fills.length;
    const refreshes = tex.refreshes;
    for (let i = 1; i <= 30; i++) hud.update(stateOf([p], i * 16), r, 16, i * 16);
    expect(tex.fills.length).toBe(first);
    expect(tex.refreshes).toBe(refreshes);
    p.pos.x += TILE;
    hud.update(stateOf([p], 600), r, 16, 600);
    expect(tex.fills.length).toBeGreaterThan(first);
    expect(tex.fills.length - first).toBeLessThanOrEqual(13); // une colonne de la zone découverte
    expect(tex.refreshes).toBe(refreshes + 1);
    // Aucun doublon : chaque tuile n'est peinte qu'une fois.
    const keys = new Set(tex.fills.map((f) => `${f.x},${f.y}`));
    expect(keys.size).toBe(tex.fills.length);
  });

  it('carte masquée : rien ne s\'affiche, mais la découverte continue ; réaffichée, tout apparaît', () => {
    const env = makeEnv(4);
    const hud = new MiniMapHud(env);
    const r = room();
    hud.setVisible(false);
    const p = hero(0, 5, 15);
    hud.update(stateOf([p], 0), r, 16, 0);
    for (let x = 6; x <= 30; x++) {
      p.pos.x = x * TILE;
      hud.update(stateOf([p], x * 100), r, 16, x * 100);
    }
    expect(env.objs.filter((o) => o.visible)).toHaveLength(0);
    hud.setVisible(true);
    hud.update(stateOf([p], 4000), r, 16, 4000);
    const tex = [...env.textures.values()][0];
    expect(tex.fills.length).toBeGreaterThan(21 * 13 * 1.5); // beaucoup plus que la zone initiale
    expect(env.objs.find((o) => o.kind === 'rect')!.visible).toBe(true);
    expect(visibleOfKind(env.objs, 'circle').length).toBeGreaterThan(0);
  });

  it('un pion par joueur présent : point, anneau si appel, croix médicale si à soigner, croix ✕ si à terre', () => {
    const env = makeEnv(4);
    const hud = new MiniMapHud(env);
    const r = room();
    const players = [
      hero(0, 10, 10),
      hero(1, 12, 10, { callMs: 1000 }),
      hero(2, 14, 10, { maxHp: 100, hp: 20 }),
      hero(3, 16, 10, { status: 'down', hp: 0 }),
    ];
    hud.update(stateOf(players), r, 16, 120);
    const circles = env.objs.filter((o) => o.kind === 'circle'); // [ring0, dot0, ring1, dot1, ...]
    const gfx = env.objs.filter((o) => o.kind === 'gfx').slice(1); // [0] = liseré ; ensuite heal0, down0, heal1, down1...
    const ring = (i: number): FakeObj => circles[i * 2];
    const dot = (i: number): FakeObj => circles[i * 2 + 1];
    const heal = (i: number): FakeObj => gfx[i * 2];
    const down = (i: number): FakeObj => gfx[i * 2 + 1];
    for (let i = 0; i < 4; i++) expect(dot(i).visible).toBe(true);
    expect([ring(0).visible, heal(0).visible, down(0).visible]).toEqual([false, false, false]);
    expect(ring(1).visible).toBe(true); // appel : anneau
    expect([heal(2).visible, down(2).visible, ring(2).visible]).toEqual([true, false, false]); // à soigner : croix médicale
    expect([down(3).visible, heal(3).visible, ring(3).visible]).toEqual([true, false, false]); // à terre
    expect(dot(3).alpha).toBeCloseTo(MARKER_DOWN_DOT_ALPHA, 9);
    // Les pions sont posés à des positions différentes, dans la carte.
    const pl = hud.currentPlacement!;
    for (let i = 0; i < 4; i++) {
      expect(dot(i).x).toBeGreaterThanOrEqual(pl.map.x);
      expect(dot(i).x).toBeLessThanOrEqual(pl.map.x + pl.map.w);
    }
    expect(new Set([0, 1, 2, 3].map((i) => dot(i).x)).size).toBe(4);
  });

  it('pions superposés : le point d\'un héros à terre / à soigner passe au-dessus de celui d\'un héros normal, et la croix « à terre » au-dessus des croix médicales', () => {
    const env = makeEnv(4);
    const hud = new MiniMapHud(env);
    // les 4 héros sur la MÊME tuile : seul l'ordre de dessin les distingue
    const players = [hero(0, 10, 10, { status: 'down', hp: 0 }), hero(1, 10, 10, { maxHp: 100, hp: 20 }), hero(2, 10, 10, { callMs: 1000 }), hero(3, 10, 10)];
    hud.update(stateOf(players), room(), 16, 120);
    const circles = env.objs.filter((o) => o.kind === 'circle');
    const dot = (i: number): FakeObj => circles[i * 2 + 1];
    const gfx = env.objs.filter((o) => o.kind === 'gfx').slice(1);
    const heal = (i: number): FakeObj => gfx[i * 2];
    const down = (i: number): FakeObj => gfx[i * 2 + 1];
    expect(dot(0).depth).toBeGreaterThan(dot(1).depth); // à terre > à soigner
    expect(dot(1).depth).toBeGreaterThan(dot(2).depth); // à soigner > appel
    expect(dot(2).depth).toBeGreaterThan(dot(3).depth); // appel > normal (id plus élevé)
    // la croix médicale du héros 1 est sous la croix « à terre » du héros 0 (id plus bas), et tout reste sous les éléments transitoires
    expect(down(0).depth).toBeGreaterThan(heal(1).depth);
    for (const o of [...circles, ...gfx.slice(0, 8)]) expect(o.depth).toBeLessThan(MAP_DEPTH + 0.7);
  });

  it('pions : plus gros quand la carte est petite (1 vue : 2 px par tuile), taille normale sur la grande carte partagée', () => {
    const big = makeEnv(4);
    const hudBig = new MiniMapHud(big);
    hudBig.update(stateOf([hero(0, 10, 10)]), room('a', 40, 30), 16, 0);
    expect(hudBig.currentPlacement!.scale).toBe(3);
    expect(big.objs.filter((o) => o.kind === 'circle')[1].scale).toBe(1);
    const small = makeEnv(1);
    const hudSmall = new MiniMapHud(small);
    hudSmall.update(stateOf([hero(0, 10, 10)]), room('a', 40, 30), 16, 0);
    expect(hudSmall.currentPlacement!.scale).toBeLessThan(3);
    expect(small.objs.filter((o) => o.kind === 'circle')[1].scale).toBe(MARKER_SMALL_MAP_FACTOR);
  });

  it('les joueurs absents n\'ont pas de pion (2 joueurs : 2 points visibles)', () => {
    const env = makeEnv(2);
    const hud = new MiniMapHud(env);
    hud.update(stateOf([hero(0, 10, 10), hero(1, 12, 10)]), room(), 16, 0);
    expect(visibleOfKind(env.objs, 'circle').filter((o) => o.alpha > 0).length).toBe(2);
  });

  it('le clignotement ne fait que changer alpha / échelle d\'objets existants (aucune création, aucun dessin de géométrie)', () => {
    const env = makeEnv(4);
    const hud = new MiniMapHud(env);
    const r = room();
    const p = hero(0, 10, 10, { callMs: 2500 });
    hud.update(stateOf([p]), r, 16, 0);
    const objectCount = env.objs.length;
    const draws = env.objs.reduce((n, o) => n + o.draws, 0);
    const ring = env.objs.filter((o) => o.kind === 'circle')[0];
    const alphas = new Set<number>();
    for (let t = 16; t < 1000; t += 16) {
      hud.update(stateOf([p], t), r, 16, t);
      alphas.add(Math.round(ring.alpha * 100));
    }
    expect(env.objs.length).toBe(objectCount);
    expect(env.objs.reduce((n, o) => n + o.draws, 0)).toBe(draws);
    expect(alphas.size).toBeGreaterThan(5); // il pulse bel et bien
  });

  it('changement de salle : mémoire remise à zéro et nouvelle texture à la taille de la nouvelle salle', () => {
    const env = makeEnv(4);
    const hud = new MiniMapHud(env);
    hud.update(stateOf([hero(0, 20, 15)], 9000), room('a', 40, 30), 16, 0);
    expect([...env.textures.values()][0].width).toBe(40);
    hud.update(stateOf([hero(0, 3, 3)], 0), room('b', 60, 38), 16, 16);
    expect(env.textures.size).toBe(1); // l'ancienne est retirée
    const tex = [...env.textures.values()][0];
    expect([tex.width, tex.height]).toEqual([60, 38]);
    expect(tex.fills.length).toBeLessThanOrEqual(21 * 13);
    expect(env.objs.filter((o) => o.kind === 'image')).toHaveLength(1);
    expect(env.objs.find((o) => o.kind === 'image')!.textureKey).toBe(tex.key);
  });

  it('salle redémarrée (même id, le temps recule) : le canvas est vidé et la découverte repart de zéro', () => {
    const env = makeEnv(4);
    const hud = new MiniMapHud(env);
    const r = room('a', 40, 30);
    const p = hero(0, 5, 5);
    hud.update(stateOf([p], 0), r, 16, 0);
    p.pos.x = 35 * TILE;
    hud.update(stateOf([p], 5000), r, 16, 5000);
    const tex = [...env.textures.values()][0];
    const big = tex.fills.length;
    const p2 = hero(0, 5, 5);
    hud.update(stateOf([p2], 0), r, 16, 5016);
    expect(tex.clears).toBe(1);
    expect(tex.fills.length).toBeLessThan(big);
    expect(env.textures.size).toBe(1);
  });

  it('1 vue : estompée quand un héros passe dessous, normale sinon', () => {
    const env = makeEnv(1);
    const hud = new MiniMapHud(env);
    const r = room();
    const hp = hero(0, 20, 15);
    hud.update(stateOf([hp]), r, 16, 0, () => ({ x: hp.pos.x, y: hp.pos.y })); // héros au centre de l'écran
    const panel = env.objs.find((o) => o.kind === 'rect')!;
    expect(panel.alpha).toBe(1);
    const pl = hud.currentPlacement!;
    const vp = env.layout.viewports[0];
    // Caméra décalée : le héros apparaît au milieu du panneau.
    const cam = { x: hp.pos.x - (pl.panel.x + pl.panel.w / 2 - (vp.x + vp.w / 2)) / vp.zoom, y: hp.pos.y - (pl.panel.y + pl.panel.h / 2 - (vp.y + vp.h / 2)) / vp.zoom };
    for (let t = 16; t < 1500; t += 16) hud.update(stateOf([hp]), r, 16, t, () => cam);
    expect(panel.alpha).toBeCloseTo(MAP_HERO_FADE_ALPHA, 2);
    for (let t = 1500; t < 3000; t += 16) hud.update(stateOf([hp]), r, 16, t, () => ({ x: hp.pos.x, y: hp.pos.y }));
    expect(panel.alpha).toBe(1);
  });

  it('2-4 vues : sans centres de caméra, jamais estompée ; héros loin du panneau : opacité pleine', () => {
    const env = makeEnv(4);
    const hud = new MiniMapHud(env);
    const hp = hero(0, 20, 15);
    for (let t = 0; t < 600; t += 16) hud.update(stateOf([hp]), room(), 16, t);
    expect(env.objs.find((o) => o.kind === 'rect')!.alpha).toBe(1);
    for (let t = 600; t < 1200; t += 16) hud.update(stateOf([hp]), room(), 16, t, () => ({ x: hp.pos.x, y: hp.pos.y })); // héros au centre de SA vue : loin du panneau central
    expect(env.objs.find((o) => o.kind === 'rect')!.alpha).toBe(1);
  });

  it.each([2, 3, 4])('%i vues : estompée quand le héros d\'une vue longe le mur est et passe sous le panneau central (caméra bloquée contre le mur)', (n) => {
    const env = makeEnv(n);
    const hud = new MiniMapHud(env);
    const r = room('gauntlet', 86, 52);
    const hp = n === 2 ? hero(0, 83, 20) : hero(0, 83, 50); // 2 vues : mur est à mi-hauteur ; 3-4 vues : coin sud-est de la vue du haut gauche (la carte la chevauche)
    const vp = env.layout.viewports[0];
    // caméra de la vue 0 plaquée contre le coin sud-est de la salle (comme `stepCameraCenter` la borne) : le héros apparaît près du centre de l'écran
    const cam = { x: 86 * TILE - vp.w / vp.zoom / 2, y: Math.min(52 * TILE - vp.h / vp.zoom / 2, hp.pos.y) };
    for (let t = 0; t < 1500; t += 16) hud.update(stateOf([hp]), r, 16, t, (v) => (v === 0 ? cam : { x: -1e6, y: -1e6 }));
    expect(env.objs.find((o) => o.kind === 'rect')!.alpha).toBeCloseTo(MAP_HERO_FADE_ALPHA, 2);
    // la caméra suit de nouveau le héros : la carte redevient opaque
    for (let t = 1500; t < 3000; t += 16) hud.update(stateOf([hp]), r, 16, t, (v) => (v === 0 ? { x: hp.pos.x, y: hp.pos.y } : { x: -1e6, y: -1e6 }));
    expect(env.objs.find((o) => o.kind === 'rect')!.alpha).toBe(1);
  });

  it('destroy : tout est détruit, la texture retirée, appels suivants sans effet ni erreur', () => {
    const env = makeEnv(3);
    const hud = new MiniMapHud(env);
    hud.update(stateOf([hero(0, 10, 10), hero(1, 12, 10), hero(2, 14, 10)]), room(), 16, 0);
    hud.destroy();
    expect(env.objs.every((o) => o.destroyed)).toBe(true);
    expect(env.textures.size).toBe(0);
    expect(() => {
      hud.update(stateOf([hero(0, 10, 10)]), room(), 16, 16);
      hud.setVisible(true);
      hud.retranslate();
      hud.destroy();
    }).not.toThrow();
  });

  it('plusieurs instances ne se disputent pas la clé de texture', () => {
    const a = makeEnv(4);
    const b = makeEnv(4);
    const h1 = new MiniMapHud(a);
    const h2 = new MiniMapHud(b);
    h1.update(stateOf([hero(0, 10, 10)]), room(), 16, 0);
    h2.update(stateOf([hero(0, 10, 10)]), room(), 16, 0);
    expect([...a.textures.keys()][0]).not.toBe([...b.textures.keys()][0]);
  });
});
