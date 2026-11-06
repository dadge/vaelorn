import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Phaser from 'phaser';
import { PLAYER_COLORS } from '../core/constants';
import { resetI18nStateForTests, setLanguage } from '../i18n/i18n';
import {
  FONT_SIZES,
  PANEL_STYLES,
  PORTRAIT_ALDRIC,
  PORTRAIT_ALDRIC_COLORS,
  PORTRAIT_NARRATOR,
  PORTRAIT_NARRATOR_COLORS,
  Typewriter,
  barFill,
  beginScene,
  bindLanguage,
  css,
  drawPanel,
  drawPixelMatrix,
  fontPx,
  heroesPortraitScale,
  makePanelStyle,
  panelRects,
  playerColor,
  playerColorCss,
  playerPanelStyle,
  transitionTo,
  typewriterTimeline,
  visibleCountAt,
  type RectFiller,
} from './ui';

// ───────────────────────────── Doublures ─────────────────────────────

/** Mini émetteur d'événements (même contrat on/once/off que Phaser.Events.EventEmitter). */
class FakeEmitter {
  private handlers = new Map<string, Array<{ fn: (...a: unknown[]) => void; once: boolean }>>();
  on(ev: string, fn: (...a: unknown[]) => void): this {
    this.add(ev, fn, false);
    return this;
  }
  once(ev: string, fn: (...a: unknown[]) => void): this {
    this.add(ev, fn, true);
    return this;
  }
  off(ev: string, fn: (...a: unknown[]) => void): this {
    this.handlers.set(
      ev,
      (this.handlers.get(ev) ?? []).filter((h) => h.fn !== fn),
    );
    return this;
  }
  emit(ev: string, ...args: unknown[]): void {
    for (const h of [...(this.handlers.get(ev) ?? [])]) {
      if (h.once) this.off(ev, h.fn);
      h.fn(...args);
    }
  }
  count(ev: string): number {
    return (this.handlers.get(ev) ?? []).length;
  }
  private add(ev: string, fn: (...a: unknown[]) => void, once: boolean): void {
    const list = this.handlers.get(ev) ?? [];
    list.push({ fn, once });
    this.handlers.set(ev, list);
  }
}

function fakeScene(): { scene: Phaser.Scene; events: FakeEmitter; cam: FakeEmitter & { fadeOut: ReturnType<typeof vi.fn>; fadeIn: ReturnType<typeof vi.fn> }; start: ReturnType<typeof vi.fn>; timers: Array<() => void> } {
  const events = new FakeEmitter();
  const cam = Object.assign(new FakeEmitter(), { fadeOut: vi.fn(), fadeIn: vi.fn() });
  const start = vi.fn();
  const timers: Array<() => void> = [];
  const scene = {
    events,
    cameras: { main: cam },
    scene: { start },
    time: { delayedCall: (_ms: number, cb: () => void) => void timers.push(cb) },
  } as unknown as Phaser.Scene;
  return { scene, events, cam, start, timers };
}

function fakeStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => (data.has(k) ? (data.get(k) as string) : null),
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

beforeEach(() => {
  resetI18nStateForTests();
  vi.stubGlobal('localStorage', fakeStorage());
  vi.stubGlobal('navigator', { language: 'fr-FR' });
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetI18nStateForTests();
});

// ───────────────────────────── Thème ─────────────────────────────

describe('thème', () => {
  it('toutes les tailles de police sont des multiples de 8', () => {
    for (const px of Object.values(FONT_SIZES)) expect(px % 8).toBe(0);
    expect(fontPx('lg')).toBe(32);
    expect(fontPx(40)).toBe(40);
    expect(fontPx(undefined)).toBe(24);
  });

  it('css et couleurs de joueur', () => {
    expect(css(0xffd36b)).toBe('#ffd36b');
    expect(css('#123456')).toBe('#123456');
    expect(playerColor(0)).toBe(PLAYER_COLORS[0]);
    expect(playerColor(3)).toBe(PLAYER_COLORS[3]);
    expect(playerColor(4)).toBe(PLAYER_COLORS[0]); // repli
    expect(playerColor(-1)).toBe(PLAYER_COLORS[3]);
    expect(playerColorCss(1)).toBe('#ff5a5a');
  });

  it('playerPanelStyle : liseré à la couleur du joueur, « prêt » change le fond', () => {
    const idle = playerPanelStyle(2, false);
    const ready = playerPanelStyle(2, true);
    expect(idle.edge).toBe(PLAYER_COLORS[2]);
    expect(ready.edge).toBe(PLAYER_COLORS[2]);
    expect(ready.fill).not.toBe(idle.fill);
  });
});

// ───────────────────────────── Panneaux ─────────────────────────────

describe('panelRects (nine-slice par code)', () => {
  const sizes: Array<[number, number]> = [
    [200, 80],
    [1200, 214],
    [48, 20],
    [12, 12],
    [3, 3],
    [0, 0],
    [100.7, 50.2],
  ];

  it('tous les rectangles sont dans les bornes et non dégénérés', () => {
    for (const [w, h] of sizes) {
      for (const style of Object.values(PANEL_STYLES)) {
        for (const r of panelRects(w, h, style)) {
          expect(r.w, `w ${w}x${h}`).toBeGreaterThan(0);
          expect(r.h, `h ${w}x${h}`).toBeGreaterThan(0);
          expect(r.x).toBeGreaterThanOrEqual(0);
          expect(r.y).toBeGreaterThanOrEqual(0);
          expect(r.x + r.w).toBeLessThanOrEqual(Math.floor(w));
          expect(r.y + r.h).toBeLessThanOrEqual(Math.floor(h));
          expect(r.alpha).toBeGreaterThan(0);
          expect(r.alpha).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('couches : contour sombre d\'abord, puis liseré, puis remplissage ; coins en escalier', () => {
    const style = makePanelStyle(0x112233, 0xaabbcc);
    const rects = panelRects(100, 60, style);
    expect(rects[0].color).toBe(style.shadow);
    expect(rects.some((r) => r.color === style.edge)).toBe(true);
    expect(rects.some((r) => r.color === style.fill)).toBe(true);
    expect(rects.some((r) => r.color === style.highlight)).toBe(true);
    // Le pixel (0,0) n'est couvert par aucun rectangle : coin « encoché »
    const covers = (x: number, y: number): boolean => rects.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
    expect(covers(0, 0)).toBe(false);
    expect(covers(99, 59)).toBe(false);
    expect(covers(50, 30)).toBe(true);
    expect(covers(0, 30)).toBe(true);
    // Le centre est rempli de la couleur de fond (dernier rectangle qui le couvre)
    const top = [...rects].reverse().find((r) => 50 >= r.x && 50 < r.x + r.w && 30 >= r.y && 30 < r.y + r.h);
    expect(top?.color).toBe(style.fill);
  });

  it('géométrie déterministe', () => {
    expect(panelRects(321, 123, PANEL_STYLES.raised)).toEqual(panelRects(321, 123, PANEL_STYLES.raised));
  });

  it('drawPanel émet un fillStyle + fillRect par rectangle, décalés de (x, y)', () => {
    const calls: Array<[string, ...number[]]> = [];
    const g: RectFiller = {
      fillStyle: (c: number, a?: number) => void calls.push(['style', c, a ?? 1]),
      fillRect: (x: number, y: number, w: number, h: number) => void calls.push(['rect', x, y, w, h]),
    };
    drawPanel(g, 10, 20, 100, 40, PANEL_STYLES.default);
    const rects = panelRects(100, 40, PANEL_STYLES.default);
    expect(calls).toHaveLength(rects.length * 2);
    expect(calls[1]).toEqual(['rect', 10 + rects[0].x, 20 + rects[0].y, rects[0].w, rects[0].h]);
  });
});

// ───────────────────────────── Matrices de pixels ─────────────────────────────

describe('matrices de pixels et portraits', () => {
  it('portraits 16×16, toutes les lettres ont une couleur', () => {
    for (const [rows, colors] of [
      [PORTRAIT_ALDRIC, PORTRAIT_ALDRIC_COLORS],
      [PORTRAIT_NARRATOR, PORTRAIT_NARRATOR_COLORS],
    ] as const) {
      expect(rows).toHaveLength(16);
      for (const row of rows) {
        expect(row).toHaveLength(16);
        for (const ch of row) if (ch !== '.') expect(colors[ch], `lettre ${ch}`).toBeDefined();
      }
    }
  });

  it('drawPixelMatrix fusionne les pixels contigus, ignore . et les lettres inconnues, applique l\'échelle', () => {
    const rects: Array<[number, number, number, number, number]> = [];
    let color = 0;
    const g: RectFiller = {
      fillStyle: (c: number) => void (color = c),
      fillRect: (x: number, y: number, w: number, h: number) => void rects.push([color, x, y, w, h]),
    };
    drawPixelMatrix(g, ['.aab', 'b?..'], { a: 1, b: 2 }, 100, 200, 4);
    expect(rects).toEqual([
      [1, 104, 200, 8, 4],
      [2, 112, 200, 4, 4],
      [2, 100, 204, 4, 4],
    ]);
  });

  it('chaque portrait dessine au moins un rectangle dans sa grille', () => {
    for (const [rows, colors] of [
      [PORTRAIT_ALDRIC, PORTRAIT_ALDRIC_COLORS],
      [PORTRAIT_NARRATOR, PORTRAIT_NARRATOR_COLORS],
    ] as const) {
      const out: number[][] = [];
      const g: RectFiller = { fillStyle: () => undefined, fillRect: (x, y, w, h) => void out.push([x, y, w, h]) };
      drawPixelMatrix(g, rows, colors, 0, 0, 1);
      expect(out.length).toBeGreaterThan(10);
      for (const [x, y, w, h] of out) {
        expect(x + w).toBeLessThanOrEqual(16);
        expect(y + h).toBeLessThanOrEqual(16);
      }
    }
  });

  it('heroesPortraitScale : la rangée de héros tient dans 192 px', () => {
    for (let n = 1; n <= 4; n++) expect(n * 16 * heroesPortraitScale(n)).toBeLessThanOrEqual(192);
    expect(heroesPortraitScale(1)).toBeGreaterThan(heroesPortraitScale(4));
  });
});

// ───────────────────────────── Machine à écrire ─────────────────────────────

describe('typewriter', () => {
  it('timeline : croissante, longueur = nombre de caractères, vitesse respectée', () => {
    const chars = Array.from('Salut le monde');
    const tl = typewriterTimeline(chars, { charsPerSecond: 50 });
    expect(tl).toHaveLength(chars.length);
    for (let i = 1; i < tl.length; i++) expect(tl[i]).toBeGreaterThan(tl[i - 1]);
    expect(tl[0]).toBeCloseTo(20, 5);
    expect(tl[tl.length - 1]).toBeCloseTo(chars.length * 20, 5);
  });

  it('la ponctuation ajoute une pause avant le caractère suivant (jamais en fin de texte)', () => {
    const tl = typewriterTimeline(Array.from('Ah. Oui, non'), { charsPerSecond: 100, sentencePauseMs: 300, commaPauseMs: 100 });
    // 'A'(10) 'h'(20) '.'(30) puis pause 300 puis ' '(340)
    expect(tl[2]).toBeCloseTo(30, 5);
    expect(tl[3]).toBeCloseTo(340, 5);
    // 'Oui' 'O'(350) 'u'(360) 'i'(370) ','(380) +100 → ' '(490)
    expect(tl[7]).toBeCloseTo(380, 5);
    expect(tl[8]).toBeCloseTo(490, 5);
    // pas de pause après un point final
    const end = typewriterTimeline(Array.from('Fin.'), { charsPerSecond: 100, sentencePauseMs: 300 });
    expect(end[3]).toBeCloseTo(40, 5);
    // une ponctuation au milieu d'un mot (« 3.14 ») ne pause pas
    const mid = typewriterTimeline(Array.from('3.14'), { charsPerSecond: 100, sentencePauseMs: 300 });
    expect(mid[3]).toBeCloseTo(40, 5);
  });

  it('les retours à la ligne sont instantanés', () => {
    const tl = typewriterTimeline(Array.from('ab\ncd'), { charsPerSecond: 100 });
    expect(tl[2]).toBe(tl[1]); // '\n' n'ajoute aucun délai
    expect(tl[3]).toBeCloseTo(tl[2] + 10, 5);
  });

  it('visibleCountAt : recherche dichotomique', () => {
    const tl = [10, 20, 30, 40];
    expect(visibleCountAt(tl, 0)).toBe(0);
    expect(visibleCountAt(tl, 10)).toBe(1);
    expect(visibleCountAt(tl, 25)).toBe(2);
    expect(visibleCountAt(tl, 40)).toBe(4);
    expect(visibleCountAt(tl, 1e9)).toBe(4);
    expect(visibleCountAt([], 5)).toBe(0);
  });

  it('Typewriter : révélation progressive, skip, fin', () => {
    const tw = new Typewriter('Bonjour', { charsPerSecond: 100, sentencePauseMs: 0, commaPauseMs: 0 });
    expect(tw.total).toBe(7);
    expect(tw.visible).toBe('');
    expect(tw.done).toBe(false);
    expect(tw.update(25)).toBe(true);
    expect(tw.visible).toBe('Bo');
    expect(tw.update(1)).toBe(false); // pas de nouveau caractère
    tw.update(30);
    expect(tw.visible).toBe('Bonjo');
    tw.skip();
    expect(tw.visible).toBe('Bonjour');
    expect(tw.done).toBe(true);
    expect(tw.update(100)).toBe(false);
    expect(tw.full).toBe('Bonjour');
  });

  it('Typewriter : reset avec un nouveau texte, texte vide, dt invalide', () => {
    const tw = new Typewriter('');
    expect(tw.done).toBe(true);
    expect(tw.visible).toBe('');
    tw.reset('Salut');
    expect(tw.done).toBe(false);
    expect(tw.update(Number.NaN)).toBe(false);
    expect(tw.update(-50)).toBe(false);
    expect(tw.visible).toBe('');
    tw.update(10_000);
    expect(tw.visible).toBe('Salut');
    tw.reset();
    expect(tw.visible).toBe('');
    expect(tw.total).toBe(5);
  });

  it('Typewriter compte des points de code (pas de paire de substitution coupée)', () => {
    const tw = new Typewriter('a😀b', { charsPerSecond: 1000 });
    expect(tw.total).toBe(3);
    tw.update(2.5); // 2 caractères
    expect(tw.visible).toBe('a😀');
    tw.skip();
    expect(tw.visible).toBe('a😀b');
  });

  it('texte long : atteint toujours la fin en temps fini', () => {
    const text = 'Les fragments s\'assemblent, la lumière revient ! '.repeat(8);
    const tw = new Typewriter(text);
    let t = 0;
    while (!tw.done && t < 120_000) {
      tw.update(16);
      t += 16;
    }
    expect(tw.done).toBe(true);
    expect(tw.visible).toBe(text);
  });
});

// ───────────────────────────── Barres ─────────────────────────────

describe('barFill', () => {
  it('segments allumés, bornés', () => {
    expect(barFill(5, 10, 10)).toBe(5);
    expect(barFill(0, 10, 10)).toBe(0);
    expect(barFill(10, 10, 10)).toBe(10);
    expect(barFill(15, 10, 10)).toBe(10);
    expect(barFill(-3, 10, 10)).toBe(0);
    expect(barFill(0.5, 1, 20)).toBe(10);
    expect(barFill(3, 0, 10)).toBe(0);
    expect(barFill(Number.NaN, 10, 10)).toBe(0);
  });
});

// ───────────────────────────── Langue : pas de fuite ─────────────────────────────

describe('bindLanguage', () => {
  it('appelle le callback au changement de langue puis se désabonne à shutdown', () => {
    const { scene, events } = fakeScene();
    setLanguage('fr');
    const cb = vi.fn();
    bindLanguage(scene, cb);
    setLanguage('en');
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith('en');
    events.emit('shutdown');
    setLanguage('fr');
    expect(cb).toHaveBeenCalledTimes(1);
    // les écouteurs de la scène sont retirés
    expect(events.count('shutdown')).toBe(0);
    expect(events.count('destroy')).toBe(0);
  });

  it('se désabonne aussi à destroy', () => {
    const { scene, events } = fakeScene();
    setLanguage('fr');
    const cb = vi.fn();
    bindLanguage(scene, cb);
    events.emit('destroy');
    setLanguage('en');
    expect(cb).not.toHaveBeenCalled();
    expect(events.count('shutdown')).toBe(0);
  });

  it('le désabonnement manuel est idempotent', () => {
    const { scene } = fakeScene();
    setLanguage('fr');
    const cb = vi.fn();
    const off = bindLanguage(scene, cb);
    off();
    off();
    setLanguage('en');
    expect(cb).not.toHaveBeenCalled();
  });

  it('redémarrages successifs de la scène : un seul abonné actif à la fois', () => {
    const { scene, events } = fakeScene();
    setLanguage('fr');
    const calls: string[] = [];
    for (let run = 0; run < 5; run++) {
      bindLanguage(scene, () => calls.push(`run${run}`));
      events.emit('shutdown');
    }
    bindLanguage(scene, () => calls.push('live'));
    setLanguage('en');
    expect(calls).toEqual(['live']);
  });
});

// ───────────────────────────── Transitions ─────────────────────────────

describe('transitions de scène', () => {
  it('transitionTo : fondu de sortie puis start, une seule fois même si rappelé', () => {
    const { scene, cam, start, timers } = fakeScene();
    beginScene(scene, 0);
    transitionTo(scene, 'Menu', { a: 1 }, 200);
    transitionTo(scene, 'Result', { b: 2 }, 200); // ignoré : transition en cours
    expect(cam.fadeOut).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
    cam.emit('camerafadeoutcomplete');
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith('Menu', { a: 1 });
    // le filet de sécurité temporel ne relance pas la scène
    for (const t of timers) t();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('filet de sécurité : le changement a lieu même sans événement de fin de fondu', () => {
    const { scene, start, timers } = fakeScene();
    transitionTo(scene, 'Game', undefined, 250);
    expect(start).not.toHaveBeenCalled();
    for (const t of timers) t();
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith('Game', undefined);
  });

  it('durée 0 : démarrage immédiat sans fondu', () => {
    const { scene, cam, start } = fakeScene();
    transitionTo(scene, 'Menu', {}, 0);
    expect(cam.fadeOut).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('beginScene réarme les transitions (scène réutilisée) et lance le fondu d\'entrée', () => {
    const { scene, cam, start } = fakeScene();
    transitionTo(scene, 'A', {}, 0);
    expect(start).toHaveBeenCalledTimes(1);
    transitionTo(scene, 'B', {}, 0); // ignoré tant que la scène n'a pas été relancée
    expect(start).toHaveBeenCalledTimes(1);
    beginScene(scene, 300);
    expect(cam.fadeIn).toHaveBeenCalledWith(300, 0, 0, 0);
    transitionTo(scene, 'C', {}, 0);
    expect(start).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenLastCalledWith('C', {});
  });
});
