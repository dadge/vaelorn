/**
 * Tests de l'encodeur de QR codes : aller-retour avec le vrai décodeur `jsqr` sur des codes d'invitation RÉELS (250, 400 et 600 caractères), choix du niveau de
 * correction, refus des textes trop longs, dessin dans un canvas (tailles entières, marge, lissage, devicePixelRatio) comparé pixel à pixel à `qrToRgba`.
 */
import jsQR from 'jsqr';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanCode, encodeSignalCode, type SignalCandidate, type SignalDesc } from '../rtcCodec';
import { type QrMatrix, QR_MAX_VERSION, QR_MAX_VERSION_FOR_M, QR_QUIET_ZONE, drawQrToCanvas, qrMatrix, qrToRgba } from './qrCode';

const FP = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

const H = (foundation: string, priority: number, address: string, port: number, type: SignalCandidate['type'] = 'host'): SignalCandidate => ({
  foundation,
  priority,
  address,
  port,
  type,
});

/** Candidats réalistes d'un téléphone : adresses locales IPv4 (hotspot, Wi-Fi), adresse publique « srflx »… */
const CANDIDATES: SignalCandidate[] = [
  H('1', 2113937151, '192.168.43.1', 40000),
  H('2', 2113932031, '10.0.0.42', 55321),
  H('842163049', 1677729535, '203.0.113.9', 51234, 'srflx'),
  H('3', 2113929471, '172.16.5.9', 40001),
  H('4', 2113925119, '192.168.1.2', 49152),
  H('5', 1677721855, '198.51.100.7', 61234, 'srflx'),
  H('6', 2113921023, '192.168.9.15', 45000),
  H('7', 2113916927, '10.10.10.10', 47000),
];

/** Pire cas réaliste : moitié d'adresses IPv6 (beaucoup plus longues que l'IPv4). */
const LONG_CANDIDATES: SignalCandidate[] = Array.from({ length: 8 }, (_, i) =>
  i % 2 === 0 ? H(String(i + 1), 2113937151 - i, `192.168.${i}.20`, 40000 + i) : H(String(i + 1), 2113932031 - i, `2a01:cb04:1234:5678:9abc:def0:1234:567${i}`, 49152 + i),
);

/** Cas extrême (hors réel) : 8 noms mDNS + IPv6 d'un navigateur qui masque ses adresses : dépasse la version 20, le QR est alors refusé. */
const EXTREME_CANDIDATES: SignalCandidate[] = Array.from({ length: 8 }, (_, i) =>
  H(String(3412947290 + i), 2113937151 - i, `3f2a1c2e-5b6e-4a9a-8c1d-0a1b2c3d4e${i}f.local`, 56789 + i),
);

function realDesc(candidates: SignalCandidate[]): SignalDesc {
  return {
    ufrag: 'aBcD',
    pwd: '0123456789abcdefghijklmn',
    fingerprint: FP,
    setup: 'actpass',
    mid: '0',
    sctpPort: 5000,
    maxMessageSize: 262144,
    candidates,
  };
}

/** Code RÉEL nettoyé (sans espaces) tel que l'écran le fera encoder dans le QR : `count` premiers candidats de la liste. */
async function realCode(count: number, kind: 'invite' | 'answer' = 'invite', list: SignalCandidate[] = CANDIDATES): Promise<string> {
  return cleanCode(await encodeSignalCode(kind, realDesc(list.slice(0, count))));
}

afterEach(() => vi.unstubAllGlobals());

describe('qrMatrix + qrToRgba + jsqr : aller-retour sur des codes réels', () => {
  const cases = [
    { candidates: 1, min: 240, max: 260 }, // ~ 250 caractères
    { candidates: 4, min: 390, max: 430 }, // ~ 400
    { candidates: 8, min: 560, max: 640 }, // ~ 600
  ];

  for (const { candidates, min, max } of cases) {
    it(`${candidates} candidat(s) : le décodeur relit EXACTEMENT le code, pour plusieurs tailles de module`, async () => {
      const code = await realCode(candidates);
      expect(code.length).toBeGreaterThanOrEqual(min);
      expect(code.length).toBeLessThanOrEqual(max);
      expect(code).not.toMatch(/\s/);
      const matrix = qrMatrix(code);
      expect(matrix.size).toBe(17 + 4 * matrix.version);
      for (const modulePx of [2, 3, 4, 6]) {
        const { data, width, height } = qrToRgba(matrix, modulePx);
        expect(width).toBe((matrix.size + 2 * QR_QUIET_ZONE) * modulePx);
        const found = jsQR(data, width, height, { inversionAttempts: 'dontInvert' });
        expect(found, `module de ${modulePx} px`).not.toBeNull();
        expect(found?.data).toBe(code);
        expect(found?.version).toBe(matrix.version);
      }
    });
  }

  it('code de réponse (genre A) : aller-retour identique', async () => {
    const code = await realCode(2, 'answer');
    expect(code.startsWith('V1A')).toBe(true);
    const { data, width, height } = qrToRgba(qrMatrix(code), 3);
    expect(jsQR(data, width, height)?.data).toBe(code);
  });

  it('pire cas réaliste (8 candidats mDNS / IPv6, ~ 780 caractères) : tient encore et se relit', async () => {
    const code = await realCode(8, 'invite', LONG_CANDIDATES);
    expect(code.length).toBeGreaterThan(700);
    const matrix = qrMatrix(code);
    expect(matrix.ecc).toBe('L');
    expect(matrix.version).toBeLessThanOrEqual(QR_MAX_VERSION);
    const { data, width, height } = qrToRgba(matrix, 3);
    expect(jsQR(data, width, height, { inversionAttempts: 'dontInvert' })?.data).toBe(code);
  });

  it('cas extrême (8 noms mDNS, plus de 900 caractères) : qrMatrix refuse, l écran doit se rabattre sur le texte', async () => {
    const code = await realCode(8, 'invite', EXTREME_CANDIDATES);
    expect(code.length).toBeGreaterThan(858);
    expect(() => qrMatrix(code)).toThrow(/trop long/);
  });

  it('mesure : version, niveau et taille des codes de ~250, ~400 et ~600 caractères', async () => {
    const measures: string[] = [];
    for (const candidates of [1, 4, 8]) {
      const code = await realCode(candidates);
      const m = qrMatrix(code);
      measures.push(`${code.length} car. -> v${m.version} ${m.ecc} ${m.size}x${m.size}`);
      expect(m.version).toBeLessThanOrEqual(QR_MAX_VERSION);
    }
    // figées dans l'en-tête de qrCode.ts
    expect(measures).toEqual(['245 car. -> v11 M 61x61', '415 car. -> v13 L 69x69', '637 car. -> v17 L 85x85']);
  });

  it('qrToRgba : opaque, noir et blanc uniquement, marge blanche de 4 modules, un module = modulePx pixels, refuse un module non entier', async () => {
    const matrix = qrMatrix('V1OHello');
    const px = 3;
    const { data, width, height } = qrToRgba(matrix, px);
    expect(data.length).toBe(width * height * 4);
    for (let i = 0; i < data.length; i += 4) {
      const v = data[i];
      expect(v === 0 || v === 255).toBe(true);
      expect(data[i + 1]).toBe(v);
      expect(data[i + 2]).toBe(v);
      expect(data[i + 3]).toBe(255);
    }
    const dark = (x: number, y: number): boolean => data[(y * width + x) * 4] === 0;
    const margin = QR_QUIET_ZONE * px;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (x < margin || y < margin || x >= width - margin || y >= height - margin) expect(dark(x, y)).toBe(false);
      }
    }
    // chaque module occupe un bloc px × px uniforme, conforme à la matrice
    for (let r = 0; r < matrix.size; r++) {
      for (let c = 0; c < matrix.size; c++) {
        for (let dy = 0; dy < px; dy++) {
          for (let dx = 0; dx < px; dx++) expect(dark(margin + c * px + dx, margin + r * px + dy)).toBe(matrix.modules[r][c]);
        }
      }
    }
    // motif de repérage : le coin haut-gauche de la matrice est un module sombre
    expect(matrix.modules[0][0]).toBe(true);
    expect(() => qrToRgba(matrix, 0)).toThrow(/modulePx/);
    expect(() => qrToRgba(matrix, 2.5)).toThrow(/modulePx/);
  });
});

describe('qrMatrix : niveau de correction et limites', () => {
  it('M tant que la matrice reste en version 14 au plus, sinon L ; la bascule est nette', () => {
    const eccOf = (n: number): QrMatrix => qrMatrix('a'.repeat(n));
    // petits et moyens textes : M ; grands : L (échantillon, puis recherche fine de la frontière)
    for (const n of [1, 14, 100, 250, 300]) {
      expect(eccOf(n).ecc).toBe('M');
      expect(eccOf(n).version).toBeLessThanOrEqual(QR_MAX_VERSION_FOR_M);
    }
    for (const n of [400, 500, 600]) expect(eccOf(n).ecc).toBe('L');
    let lastM = 300;
    while (eccOf(lastM + 1).ecc === 'M') lastM++;
    // la version 14 en M contient 362 octets : 363 octets passent en L
    expect(qrMatrix('a'.repeat(lastM), 'M').version).toBe(QR_MAX_VERSION_FOR_M);
    expect(qrMatrix('a'.repeat(lastM + 1), 'M').version).toBeGreaterThan(QR_MAX_VERSION_FOR_M);
    expect(eccOf(lastM + 1).ecc).toBe('L');
    expect(eccOf(lastM + 1).version).toBeLessThanOrEqual(QR_MAX_VERSION_FOR_M);
    expect(lastM).toBe(362);
  });

  it('un petit texte tient en niveau M, version 1', () => {
    const m = qrMatrix('V1O');
    expect(m.ecc).toBe('M');
    expect(m.version).toBe(1);
    expect(m.size).toBe(21);
    expect(m.modules).toHaveLength(21);
    expect(m.modules.every((row) => row.length === 21)).toBe(true);
  });

  it('un niveau explicite est imposé', () => {
    expect(qrMatrix('abc', 'L').ecc).toBe('L');
    expect(qrMatrix('abc', 'M').ecc).toBe('M');
    expect(qrMatrix('a'.repeat(400), 'L').version).toBeLessThan(qrMatrix('a'.repeat(400), 'M').version);
  });

  it('texte trop long (> version 20) : Error claire, jamais une chaîne', () => {
    // la version 20 en L contient 858 octets : 858 passent, 859 non
    const biggest = qrMatrix('a'.repeat(858));
    expect(biggest.version).toBe(QR_MAX_VERSION);
    expect(biggest.ecc).toBe('L');
    expect(biggest.size).toBe(97);
    expect(() => qrMatrix('a'.repeat(859))).toThrow(Error);
    expect(() => qrMatrix('a'.repeat(859))).toThrow(/trop long/);
    expect(() => qrMatrix('a'.repeat(5000))).toThrow(/trop long/);
    expect(() => qrMatrix('a'.repeat(700), 'M')).toThrow(/trop long/); // M imposé : version 21
    try {
      qrMatrix('a'.repeat(5000));
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
    }
  });

  it('refuse un texte vide ou non ASCII (la bibliothèque tronquerait en silence)', () => {
    expect(() => qrMatrix('')).toThrow(/vide/);
    expect(() => qrMatrix('é')).toThrow(/ASCII/);
    expect(() => qrMatrix('V1O€')).toThrow(/ASCII/);
  });
});

// ───────────────────────────── drawQrToCanvas ─────────────────────────────

interface FakeCtx {
  imageSmoothingEnabled: boolean;
  fillStyle: string;
  fillRect(x: number, y: number, w: number, h: number): void;
}

/** Canvas factice : enregistre les `fillRect` ; changer `width`/`height` réinitialise le contexte (comme un vrai canvas : lissage de nouveau actif). */
function fakeCanvas(options: { noContext?: boolean } = {}) {
  const rects: { x: number; y: number; w: number; h: number; color: string; smoothing: boolean }[] = [];
  let w = 300;
  let h = 150;
  const ctx: FakeCtx = {
    imageSmoothingEnabled: true,
    fillStyle: '#000000',
    fillRect(x, y, rw, rh) {
      rects.push({ x, y, w: rw, h: rh, color: ctx.fillStyle, smoothing: ctx.imageSmoothingEnabled });
    },
  };
  const canvas = {
    get width() {
      return w;
    },
    set width(v: number) {
      w = v;
      ctx.imageSmoothingEnabled = true;
      ctx.fillStyle = '#000000';
    },
    get height() {
      return h;
    },
    set height(v: number) {
      h = v;
      ctx.imageSmoothingEnabled = true;
    },
    style: {} as Record<string, string>,
    getContext: (type: string) => (type === '2d' && !options.noContext ? ctx : null),
  };
  return { canvas: canvas as unknown as HTMLCanvasElement, raw: canvas, rects, ctx };
}

/** Rastérise les `fillRect` enregistrés (dans l'ordre) en RGBA. */
function rasterize(rects: { x: number; y: number; w: number; h: number; color: string }[], size: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(size * size * 4);
  for (const r of rects) {
    const v = r.color === '#ffffff' ? 255 : r.color === '#000000' ? 0 : -1;
    expect(v).not.toBe(-1);
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        const i = (y * size + x) * 4;
        out[i] = out[i + 1] = out[i + 2] = v;
        out[i + 3] = 255;
      }
    }
  }
  return out;
}

describe('drawQrToCanvas', () => {
  const matrix = qrMatrix('V1OSalutAvent'); // version 1 : 21 modules, 29 avec la marge

  it('DPR 1 : pixels entiers par module, le plus grand possible dans maxCssPx, marge de 4 modules, lissage coupé', () => {
    vi.stubGlobal('devicePixelRatio', 1);
    const f = fakeCanvas();
    const total = matrix.size + 2 * QR_QUIET_ZONE;
    expect(total).toBe(29);
    const res = drawQrToCanvas(f.canvas, matrix, 300);
    expect(res.modulePx).toBe(Math.floor(300 / total)); // 10
    expect(res.cssPx).toBe(total * res.modulePx);
    expect(res.cssPx).toBeLessThanOrEqual(300);
    expect(300 - res.cssPx).toBeLessThan(total); // le plus grand possible : on ne perd pas un module entier
    expect(f.raw.width).toBe(res.cssPx);
    expect(f.raw.height).toBe(res.cssPx);
    expect(f.raw.style.width).toBe(`${res.cssPx}px`);
    expect(f.raw.style.height).toBe(`${res.cssPx}px`);
    expect(f.raw.style.imageRendering).toBe('pixelated');
    expect(f.rects.length).toBeGreaterThan(2);
    expect(f.rects.every((r) => r.smoothing === false)).toBe(true);
    // fond blanc couvrant tout le canvas, puis des rectangles noirs alignés sur la grille de modules
    expect(f.rects[0]).toMatchObject({ x: 0, y: 0, w: f.raw.width, h: f.raw.height, color: '#ffffff' });
    for (const r of f.rects.slice(1)) {
      expect(r.color).toBe('#000000');
      expect(Number.isInteger(r.x) && Number.isInteger(r.y) && Number.isInteger(r.w) && Number.isInteger(r.h)).toBe(true);
      expect(r.x % res.modulePx).toBe(0);
      expect(r.y % res.modulePx).toBe(0);
      expect(r.w % res.modulePx).toBe(0);
      expect(r.h).toBe(res.modulePx);
      expect(r.x).toBeGreaterThanOrEqual(QR_QUIET_ZONE * res.modulePx);
      expect(r.y).toBeGreaterThanOrEqual(QR_QUIET_ZONE * res.modulePx);
      expect(r.x + r.w).toBeLessThanOrEqual(f.raw.width - QR_QUIET_ZONE * res.modulePx);
      expect(r.y + r.h).toBeLessThanOrEqual(f.raw.height - QR_QUIET_ZONE * res.modulePx);
    }
  });

  it('le dessin est identique pixel à pixel à qrToRgba (donc relu par jsqr)', () => {
    vi.stubGlobal('devicePixelRatio', 1);
    const f = fakeCanvas();
    const res = drawQrToCanvas(f.canvas, matrix, 233);
    const expected = qrToRgba(matrix, res.modulePx);
    expect(f.raw.width).toBe(expected.width);
    const drawn = rasterize(f.rects, f.raw.width);
    expect(Array.from(drawn)).toEqual(Array.from(expected.data));
    expect(jsQR(drawn, expected.width, expected.height, { inversionAttempts: 'dontInvert' })?.data).toBe('V1OSalutAvent');
  });

  it('devicePixelRatio 2 : le canvas est en pixels physiques, l affichage en pixels CSS', () => {
    vi.stubGlobal('devicePixelRatio', 2);
    const f = fakeCanvas();
    const res = drawQrToCanvas(f.canvas, matrix, 300);
    expect(res.modulePx).toBe(Math.floor(600 / 29)); // 20 pixels physiques par module
    expect(f.raw.width).toBe(29 * res.modulePx);
    expect(res.cssPx).toBe(f.raw.width / 2);
    expect(res.cssPx).toBeLessThanOrEqual(300);
    expect(f.raw.style.width).toBe(`${res.cssPx}px`);
    expect(f.rects.every((r) => r.smoothing === false)).toBe(true);
  });

  it('devicePixelRatio fractionnaire (1,5) : toujours un nombre entier de pixels physiques par module', () => {
    vi.stubGlobal('devicePixelRatio', 1.5);
    const f = fakeCanvas();
    const res = drawQrToCanvas(f.canvas, matrix, 300);
    expect(Number.isInteger(res.modulePx)).toBe(true);
    expect(res.modulePx).toBe(Math.floor(450 / 29)); // 15
    expect(res.cssPx).toBeLessThanOrEqual(300);
    expect(f.raw.width).toBe(29 * 15);
  });

  it('DPR absent ou aberrant : traité comme 1', () => {
    for (const dpr of [undefined, 0, -2, Number.NaN]) {
      vi.stubGlobal('devicePixelRatio', dpr);
      const f = fakeCanvas();
      expect(drawQrToCanvas(f.canvas, matrix, 290).modulePx).toBe(10);
    }
  });

  it('zone trop petite : 1 pixel par module au minimum (l appelant juge si c est lisible)', () => {
    vi.stubGlobal('devicePixelRatio', 1);
    const f = fakeCanvas();
    const res = drawQrToCanvas(f.canvas, matrix, 10);
    expect(res.modulePx).toBe(1);
    expect(res.cssPx).toBe(29);
    const nothing = drawQrToCanvas(fakeCanvas().canvas, matrix, 0);
    expect(nothing.modulePx).toBe(1);
  });

  it('un code réel de 600 caractères tient et reste lisible dans 340 px à DPR 3', async () => {
    vi.stubGlobal('devicePixelRatio', 3);
    const code = await realCode(8);
    const big = qrMatrix(code);
    const f = fakeCanvas();
    const res = drawQrToCanvas(f.canvas, big, 340);
    expect(res.cssPx).toBeLessThanOrEqual(340);
    expect(res.modulePx).toBeGreaterThanOrEqual(10);
    const expected = qrToRgba(big, res.modulePx);
    expect(jsQR(rasterize(f.rects, f.raw.width), expected.width, expected.height)?.data).toBe(code);
  });

  it('redessiner dans le même canvas (taille changée) repart d un fond blanc, lissage coupé', () => {
    vi.stubGlobal('devicePixelRatio', 1);
    const f = fakeCanvas();
    drawQrToCanvas(f.canvas, matrix, 200);
    f.rects.length = 0;
    const res = drawQrToCanvas(f.canvas, matrix, 400);
    expect(res.modulePx).toBe(13);
    expect(f.rects[0]).toMatchObject({ w: 29 * 13, h: 29 * 13, color: '#ffffff', smoothing: false });
  });

  it('lève une Error si le contexte 2D est indisponible', () => {
    expect(() => drawQrToCanvas(fakeCanvas({ noContext: true }).canvas, matrix, 200)).toThrow(/contexte 2D/);
  });
});
