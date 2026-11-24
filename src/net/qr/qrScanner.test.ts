/**
 * Tests du lecteur de QR codes : prise en charge, ouverture de la caméra et erreurs, arrêt des pistes, cadence, lecteur natif (BarcodeDetector) et repli `jsqr`
 * (avec de VRAIES images de QR décodées par `jsqr`), puis la porte de validation `createScanGate`. Tout est simulé : navigator, vidéo, canvas, BarcodeDetector.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { qrMatrix, qrToRgba } from './qrCode';
import { SCAN_INTERVAL_MS, SCAN_MAX_WIDTH, SCAN_REPEAT_MS, createScanGate, qrScanSupport, startQrScanner, type QrScanError, type QrScanner } from './qrScanner';

// ───────────────────────────── Doublures ─────────────────────────────

class FakeTrack {
  stopCount = 0;
  private ended: (() => void)[] = [];
  stop(): void {
    this.stopCount++;
  }
  addEventListener(type: string, l: () => void): void {
    if (type === 'ended') this.ended.push(l);
  }
  removeEventListener(type: string, l: () => void): void {
    if (type === 'ended') this.ended = this.ended.filter((x) => x !== l);
  }
  get listenerCount(): number {
    return this.ended.length;
  }
  /** Le navigateur coupe la caméra (onglet en arrière-plan, caméra reprise par une autre application). */
  fireEnded(): void {
    for (const l of this.ended.slice()) l();
  }
}

class FakeStream {
  constructor(readonly tracks: FakeTrack[] = [new FakeTrack(), new FakeTrack()]) {}
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
}

class FakeVideo {
  muted = false;
  playsInline = false;
  srcObject: unknown = null;
  readyState = 4;
  videoWidth = 1280;
  videoHeight = 720;
  playCalls = 0;
  pauseCalls = 0;
  playError: unknown = null;
  play(): Promise<void> {
    this.playCalls++;
    return this.playError ? Promise.reject(this.playError) : Promise.resolve();
  }
  pause(): void {
    this.pauseCalls++;
  }
}

/** Cadrage réaliste d'un QR dans une scène de 1280 × 720 (voir `FakeCamera.frame`) : part de la hauteur occupée par le QR (marge comprise) et décalage sous-pixel. */
interface Framing {
  frac: number;
  dx: number;
  dy: number;
}

/** Canvas de travail factice : `getImageData` rend l'image courante de la « caméra » (blanche, avec un QR au centre si `qrText` est défini). */
class FakeCamera {
  qrText: string | null = null;
  /** Défini : le QR est vu comme par une vraie caméra (cadrage partiel, moyenne des pixels), à la résolution demandée à `getImageData`. */
  framing: Framing | null = null;
  drawCalls: { w: number; h: number }[] = [];
  imageDataCalls = 0;
  created = 0;
  canvas = {
    width: 300,
    height: 150,
    getContext: (_type: string, _opts?: unknown) => ({
      drawImage: (_v: unknown, _x: number, _y: number, w: number, h: number) => {
        this.drawCalls.push({ w, h });
      },
      getImageData: (_x: number, _y: number, w: number, h: number) => {
        this.imageDataCalls++;
        return { data: this.frame(w, h), width: w, height: h };
      },
    }),
  };
  /** Image RGBA `w × h` : fond blanc, QR (modules de 4 px) centré. */
  frame(w: number, h: number): Uint8ClampedArray {
    const data = new Uint8ClampedArray(w * h * 4).fill(255);
    if (this.qrText === null) return data;
    if (this.framing) return this.realisticFrame(w, h, this.framing);
    const qr = qrToRgba(qrMatrix(this.qrText), 4);
    const ox = Math.max(0, Math.floor((w - qr.width) / 2));
    const oy = Math.max(0, Math.floor((h - qr.height) / 2));
    for (let y = 0; y < Math.min(qr.height, h - oy); y++) {
      for (let x = 0; x < Math.min(qr.width, w - ox); x++) {
        const s = (y * qr.width + x) * 4;
        const d = ((y + oy) * w + (x + ox)) * 4;
        data[d] = qr.data[s];
        data[d + 1] = qr.data[s + 1];
        data[d + 2] = qr.data[s + 2];
      }
    }
    return data;
  }

  private matrixCache: { text: string; modules: readonly (readonly boolean[])[]; size: number } | null = null;

  /**
   * Scène de 1280 × 720 contenant le QR (côté = `frac` × 720, décalé de `dx`, `dy` pixels de la scène), échantillonnée à `w × h` : chaque pixel est la MOYENNE d'une grille
   * 3 × 3 de points (filtre en boîte, comme une réduction d'image) ; les modules ont donc des bords flous et une taille non entière, comme sur une vraie caméra.
   */
  private realisticFrame(w: number, h: number, f: Framing): Uint8ClampedArray {
    if (this.matrixCache?.text !== this.qrText) {
      const m = qrMatrix(this.qrText as string);
      this.matrixCache = { text: this.qrText as string, modules: m.modules, size: m.size };
    }
    const { modules, size } = this.matrixCache;
    const padded = size + 8;
    const side = f.frac * 720;
    const mod = side / padded;
    const ox = (1280 - side) / 2 + f.dx;
    const oy = (720 - side) / 2 + f.dy;
    const step = 1280 / w; // pixels de la scène par pixel de l'image
    const N = 3;
    const data = new Uint8ClampedArray(w * h * 4).fill(255);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let dark = 0;
        for (let sy = 0; sy < N; sy++) {
          const my = Math.floor((((y + (sy + 0.5) / N) * step) - oy) / mod) - 4;
          if (my < 0 || my >= size) continue;
          const row = modules[my];
          for (let sx = 0; sx < N; sx++) {
            const mx = Math.floor((((x + (sx + 0.5) / N) * step) - ox) / mod) - 4;
            if (mx >= 0 && mx < size && row[mx]) dark++;
          }
        }
        const v = Math.round(255 * (1 - dark / (N * N)));
        const d = (y * w + x) * 4;
        data[d] = v;
        data[d + 1] = v;
        data[d + 2] = v;
      }
    }
    return data;
  }
}

interface World {
  video: FakeVideo;
  stream: FakeStream;
  camera: FakeCamera;
  getUserMedia: ReturnType<typeof vi.fn>;
  texts: string[];
  errors: QrScanError[];
}

/** Monde par défaut : page sécurisée, caméra disponible, canvas disponible, pas de BarcodeDetector. */
function setup(over: { getUserMedia?: () => Promise<unknown>; secure?: boolean | undefined; canvas?: boolean } = {}): World {
  const stream = new FakeStream();
  const camera = new FakeCamera();
  const getUserMedia = vi.fn(over.getUserMedia ?? (() => Promise.resolve(stream)));
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.stubGlobal('isSecureContext', 'secure' in over ? over.secure : true);
  vi.stubGlobal(
    'document',
    over.canvas === false
      ? { createElement: () => ({ getContext: () => null }) }
      : {
          createElement: (tag: string) => {
            expect(tag).toBe('canvas');
            camera.created++;
            return camera.canvas;
          },
        },
  );
  return { video: new FakeVideo(), stream, camera, getUserMedia, texts: [], errors: [] };
}

function start(w: World): Promise<QrScanner> {
  return startQrScanner({
    video: w.video as unknown as HTMLVideoElement,
    onText: (t) => w.texts.push(t),
    onError: (k) => w.errors.push(k),
  });
}

interface DetectorSpec {
  formats?: string[] | 'throw' | 'absentMethod';
  ctorThrows?: boolean;
  detect: (source: unknown) => Promise<{ rawValue?: unknown }[]>;
}

/** Installe un faux `BarcodeDetector` global ; rend ses espions. */
function installDetector(spec: DetectorSpec) {
  const detect = vi.fn(spec.detect);
  const ctorOptions: unknown[] = [];
  const getSupportedFormats = vi.fn(async () => {
    if (spec.formats === 'throw') throw new Error('boom');
    return spec.formats ?? ['qr_code', 'ean_13'];
  });
  class FakeDetector {
    constructor(options: unknown) {
      ctorOptions.push(options);
      if (spec.ctorThrows) throw new Error('constructeur');
    }
    detect(source: unknown) {
      return detect(source);
    }
    static getSupportedFormats = spec.formats === 'absentMethod' ? undefined : getSupportedFormats;
  }
  vi.stubGlobal('BarcodeDetector', FakeDetector);
  return { detect, ctorOptions, getSupportedFormats };
}

function domError(name: string): Error {
  const e = new Error(name);
  e.name = name;
  return e;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Laisse passer `ms` millisecondes simulées (et les micro-tâches). */
const advance = async (ms: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};

// ───────────────────────────── qrScanSupport ─────────────────────────────

describe('qrScanSupport', () => {
  it('ok : contexte sécurisé et getUserMedia présent', () => {
    setup();
    expect(qrScanSupport()).toBe('ok');
  });

  it('insecure : page non sécurisée (même si une API existait)', () => {
    setup({ secure: false });
    expect(qrScanSupport()).toBe('insecure');
  });

  it('unsupported : pas de navigator, pas de mediaDevices ou pas de getUserMedia', () => {
    setup();
    vi.stubGlobal('navigator', undefined);
    expect(qrScanSupport()).toBe('unsupported');
    vi.stubGlobal('navigator', {});
    expect(qrScanSupport()).toBe('unsupported');
    vi.stubGlobal('navigator', { mediaDevices: {} });
    expect(qrScanSupport()).toBe('unsupported');
  });

  it('insecure prime sur unsupported (un contexte non sécurisé n expose pas mediaDevices)', () => {
    setup({ secure: false });
    vi.stubGlobal('navigator', {});
    expect(qrScanSupport()).toBe('insecure');
  });

  it('isSecureContext absent (vieil environnement) : on tente quand même', () => {
    setup({ secure: undefined });
    expect(qrScanSupport()).toBe('ok');
  });

  it('ne demande jamais la caméra', () => {
    const w = setup();
    qrScanSupport();
    expect(w.getUserMedia).not.toHaveBeenCalled();
  });
});

// ───────────────────────────── Erreurs d'ouverture ─────────────────────────────

describe('startQrScanner : erreurs', () => {
  const cases: [string, QrScanError][] = [
    ['NotAllowedError', 'denied'],
    ['PermissionDeniedError', 'denied'],
    ['SecurityError', 'denied'],
    ['NotFoundError', 'noCamera'],
    ['DevicesNotFoundError', 'noCamera'],
    ['OverconstrainedError', 'noCamera'],
    ['NotReadableError', 'failed'],
    ['AbortError', 'failed'],
    ['TypeError', 'failed'],
  ];
  for (const [name, kind] of cases) {
    it(`getUserMedia rejette ${name} -> ${kind} (une seule fois, lecteur inerte, aucun flux)`, async () => {
      const w = setup({ getUserMedia: () => Promise.reject(domError(name)) });
      const scanner = await start(w);
      expect(w.errors).toEqual([kind]);
      expect(w.video.srcObject).toBeNull();
      expect(w.video.playCalls).toBe(0);
      expect(() => scanner.stop()).not.toThrow();
      await advance(1000);
      expect(w.errors).toEqual([kind]);
      expect(w.texts).toEqual([]);
    });
  }

  it('rejet qui n est pas une Error (valeur quelconque) -> failed', async () => {
    const w = setup({ getUserMedia: () => Promise.reject('boum') });
    await start(w);
    expect(w.errors).toEqual(['failed']);
  });

  it('contexte non sécurisé -> insecure SANS demander la caméra', async () => {
    const w = setup({ secure: false });
    await start(w);
    expect(w.errors).toEqual(['insecure']);
    expect(w.getUserMedia).not.toHaveBeenCalled();
  });

  it('aucune API caméra -> unsupported', async () => {
    const w = setup();
    vi.stubGlobal('navigator', {});
    await start(w);
    expect(w.errors).toEqual(['unsupported']);
  });

  it('ni BarcodeDetector ni canvas pour jsqr -> unsupported, sans ouvrir la caméra', async () => {
    const w = setup({ canvas: false });
    await start(w);
    expect(w.errors).toEqual(['unsupported']);
    expect(w.getUserMedia).not.toHaveBeenCalled();
  });

  it('document absent et pas de BarcodeDetector -> unsupported', async () => {
    const w = setup();
    vi.stubGlobal('document', undefined);
    await start(w);
    expect(w.errors).toEqual(['unsupported']);
    expect(w.getUserMedia).not.toHaveBeenCalled();
  });

  it('video.play() refusé -> les pistes sont arrêtées et failed', async () => {
    const w = setup();
    w.video.playError = domError('NotAllowedError');
    const scanner = await start(w);
    expect(w.errors).toEqual(['failed']);
    expect(w.stream.tracks.every((t) => t.stopCount === 1)).toBe(true);
    expect(w.video.srcObject).toBeNull();
    scanner.stop();
    expect(w.stream.tracks.every((t) => t.stopCount === 1)).toBe(true);
    await advance(1000);
    expect(w.texts).toEqual([]);
  });
});

// ───────────────────────────── Lecture, arrêt, cadence ─────────────────────────────

describe('startQrScanner : caméra, arrêt et cadence', () => {
  it('demande la caméra arrière, sans micro, et prépare la vidéo (muette, en ligne, lue)', async () => {
    const w = setup();
    installDetector({ detect: () => Promise.resolve([]) });
    await start(w);
    expect(w.getUserMedia).toHaveBeenCalledTimes(1);
    const constraints = w.getUserMedia.mock.calls[0][0] as { video: { facingMode: unknown }; audio: unknown };
    expect(constraints.audio).toBe(false);
    expect(constraints.video.facingMode).toEqual({ ideal: 'environment' });
    expect(w.video.srcObject).toBe(w.stream);
    expect(w.video.muted).toBe(true);
    expect(w.video.playsInline).toBe(true);
    expect(w.video.playCalls).toBe(1);
    expect(w.errors).toEqual([]);
  });

  it('stop() arrête TOUTES les pistes, vide la vidéo, est idempotent, et plus aucune analyse ni rappel ensuite', async () => {
    const w = setup();
    const d = installDetector({ detect: () => Promise.resolve([{ rawValue: 'V1Otexte' }]) });
    const scanner = await start(w);
    await advance(SCAN_INTERVAL_MS);
    expect(d.detect).toHaveBeenCalledTimes(1);
    expect(w.texts).toEqual(['V1Otexte']);
    expect(w.stream.tracks.every((t) => t.stopCount === 0)).toBe(true);

    scanner.stop();
    expect(w.stream.tracks.map((t) => t.stopCount)).toEqual([1, 1]);
    expect(w.video.srcObject).toBeNull();
    expect(w.video.pauseCalls).toBe(1);
    expect(w.stream.tracks.every((t) => t.listenerCount === 0)).toBe(true);

    scanner.stop(); // idempotent
    expect(w.stream.tracks.map((t) => t.stopCount)).toEqual([1, 1]);

    const detectsAtStop = d.detect.mock.calls.length;
    await advance(10_000);
    expect(d.detect.mock.calls.length).toBe(detectsAtStop);
    expect(w.texts).toEqual(['V1Otexte']);
    expect(vi.getTimerCount()).toBe(0); // aucun minuteur ne traîne
  });

  it('stop() pendant une analyse en cours : le résultat tardif est ignoré', async () => {
    const w = setup();
    let release: (v: { rawValue: string }[]) => void = () => undefined;
    const d = installDetector({ detect: () => new Promise((resolve) => (release = resolve)) });
    const scanner = await start(w);
    await advance(SCAN_INTERVAL_MS);
    expect(d.detect).toHaveBeenCalledTimes(1);
    scanner.stop();
    release([{ rawValue: 'V1Otardif' }]);
    await advance(5000);
    expect(w.texts).toEqual([]);
    expect(d.detect).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stop() appelé depuis onText : la boucle ne repart pas', async () => {
    const w = setup();
    const d = installDetector({ detect: () => Promise.resolve([{ rawValue: 'V1Ouno' }]) });
    let scanner: QrScanner | null = null;
    scanner = await startQrScanner({
      video: w.video as unknown as HTMLVideoElement,
      onText: (t) => {
        w.texts.push(t);
        scanner?.stop();
      },
      onError: (k) => w.errors.push(k),
    });
    await advance(5000);
    expect(w.texts).toEqual(['V1Ouno']);
    expect(d.detect).toHaveBeenCalledTimes(1);
    expect(w.stream.tracks.map((t) => t.stopCount)).toEqual([1, 1]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cadence bornée : environ 10 analyses par seconde, jamais deux en parallèle même si l analyse est lente', async () => {
    const w = setup();
    let running = 0;
    let maxRunning = 0;
    const d = installDetector({
      detect: async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((r) => setTimeout(r, 250)); // analyse lente
        running--;
        return [];
      },
    });
    const scanner = await start(w);
    await advance(3500);
    scanner.stop();
    expect(maxRunning).toBe(1);
    // une analyse = 250 ms + 100 ms d'attente : 10 analyses en 3,5 s au plus
    expect(d.detect.mock.calls.length).toBeLessThanOrEqual(10);
    expect(d.detect.mock.calls.length).toBeGreaterThanOrEqual(9);
  });

  it('cadence bornée avec une analyse instantanée : au plus 10 par seconde', async () => {
    const w = setup();
    const d = installDetector({ detect: () => Promise.resolve([]) });
    const scanner = await start(w);
    await advance(1000);
    expect(d.detect.mock.calls.length).toBeLessThanOrEqual(1000 / SCAN_INTERVAL_MS);
    expect(d.detect.mock.calls.length).toBeGreaterThanOrEqual(8);
    scanner.stop();
  });

  it('un même texte vu en continu n est renvoyé qu après SCAN_REPEAT_MS ; un autre texte passe tout de suite', async () => {
    const w = setup();
    let current = 'V1Oaaa';
    installDetector({ detect: () => Promise.resolve([{ rawValue: current }]) });
    const scanner = await start(w);
    await advance(1000);
    expect(w.texts).toEqual(['V1Oaaa']);
    await advance(SCAN_REPEAT_MS); // plus de 1,5 s écoulées depuis la première lecture
    expect(w.texts).toEqual(['V1Oaaa', 'V1Oaaa']);
    current = 'V1Obbb';
    await advance(SCAN_INTERVAL_MS);
    expect(w.texts).toEqual(['V1Oaaa', 'V1Oaaa', 'V1Obbb']);
    scanner.stop();
  });

  it('une exception dans onText n arrête pas la lecture', async () => {
    const w = setup();
    let calls = 0;
    installDetector({ detect: () => Promise.resolve([{ rawValue: `V1O${calls}` }]) });
    const scanner = await startQrScanner({
      video: w.video as unknown as HTMLVideoElement,
      onText: () => {
        calls++;
        throw new Error('bug de l appelant');
      },
      onError: () => undefined,
    });
    await advance(500);
    expect(calls).toBeGreaterThanOrEqual(3);
    scanner.stop();
  });

  it('la caméra coupée par le navigateur (piste « ended ») : failed une fois, pistes arrêtées, boucle stoppée', async () => {
    const w = setup();
    const d = installDetector({ detect: () => Promise.resolve([]) });
    await start(w);
    await advance(300);
    w.stream.tracks[0].fireEnded();
    expect(w.errors).toEqual(['failed']);
    expect(w.stream.tracks.map((t) => t.stopCount)).toEqual([1, 1]);
    const calls = d.detect.mock.calls.length;
    await advance(2000);
    expect(d.detect.mock.calls.length).toBe(calls);
    expect(vi.getTimerCount()).toBe(0);
    w.stream.tracks[1].fireEnded(); // un second évènement tardif ne rappelle rien
    expect(w.errors).toEqual(['failed']);
  });

  it('après stop(), une piste « ended » tardive ne signale rien', async () => {
    const w = setup();
    installDetector({ detect: () => Promise.resolve([]) });
    const scanner = await start(w);
    scanner.stop();
    w.stream.tracks[0].fireEnded();
    expect(w.errors).toEqual([]);
  });

  it('pas d image prête (readyState < 2) : aucune analyse', async () => {
    const w = setup();
    w.video.readyState = 0;
    const d = installDetector({ detect: () => Promise.resolve([{ rawValue: 'V1Oxx' }]) });
    const scanner = await start(w);
    await advance(1000);
    expect(d.detect).not.toHaveBeenCalled();
    expect(w.texts).toEqual([]);
    w.video.readyState = 4;
    await advance(SCAN_INTERVAL_MS);
    expect(w.texts).toEqual(['V1Oxx']);
    scanner.stop();
  });
});

// ───────────────────────────── BarcodeDetector et repli jsqr ─────────────────────────────

describe('startQrScanner : BarcodeDetector et repli jsqr', () => {
  it('BarcodeDetector présent : utilisé avec formats [qr_code] ; jsqr et le canvas ne servent pas', async () => {
    const w = setup();
    const d = installDetector({ detect: () => Promise.resolve([{ rawValue: '' }, { rawValue: 'V1Onatif' }]) });
    const scanner = await start(w);
    await advance(SCAN_INTERVAL_MS);
    expect(d.ctorOptions).toEqual([{ formats: ['qr_code'] }]);
    expect(d.detect).toHaveBeenCalledWith(w.video);
    expect(w.texts).toEqual(['V1Onatif']);
    expect(w.camera.imageDataCalls).toBe(0);
    scanner.stop();
  });

  it('BarcodeDetector : plusieurs QR dans l\'image, un QR étranger EN TÊTE ne masque pas le code du jeu (priorité aux codes du jeu, un texte par analyse)', async () => {
    const w = setup();
    installDetector({ detect: () => Promise.resolve([{ rawValue: 'https://exemple.fr/affiche' }, { rawValue: 'V1Obon-code' }, { rawValue: 'texte libre' }]) });
    const scanner = await start(w);
    await advance(SCAN_INTERVAL_MS);
    expect(w.texts).toEqual(['V1Obon-code']); // le code du jeu d'abord
    await advance(SCAN_INTERVAL_MS); // le code du jeu vient d'être transmis : place aux autres, un par analyse
    expect(w.texts).toEqual(['V1Obon-code', 'https://exemple.fr/affiche']);
    await advance(SCAN_INTERVAL_MS);
    expect(w.texts).toEqual(['V1Obon-code', 'https://exemple.fr/affiche', 'texte libre']);
    await advance(SCAN_INTERVAL_MS * 5); // tout a été transmis : plus rien avant SCAN_REPEAT_MS
    expect(w.texts).toHaveLength(3);
    await advance(SCAN_REPEAT_MS);
    expect(w.texts[3]).toBe('V1Obon-code');
    scanner.stop();
  });

  it('BarcodeDetector : deux QR qui alternent d\'une image à l\'autre ne sont chacun renvoyés qu\'après SCAN_REPEAT_MS', async () => {
    const w = setup();
    let n = 0;
    installDetector({ detect: () => Promise.resolve([{ rawValue: n++ % 2 === 0 ? 'V1Oaaa' : 'V1Obbb' }]) });
    const scanner = await start(w);
    await advance(SCAN_REPEAT_MS - SCAN_INTERVAL_MS);
    expect(w.texts).toEqual(['V1Oaaa', 'V1Obbb']);
    scanner.stop();
  });

  it('BarcodeDetector sans getSupportedFormats : utilisé quand même', async () => {
    const w = setup();
    const d = installDetector({ formats: 'absentMethod', detect: () => Promise.resolve([{ rawValue: 'V1Ouno' }]) });
    await start(w);
    await advance(SCAN_INTERVAL_MS);
    expect(d.detect).toHaveBeenCalled();
    expect(w.texts).toEqual(['V1Ouno']);
  });

  it('BarcodeDetector sans qr_code dans ses formats : repli jsqr', async () => {
    const w = setup();
    w.camera.qrText = 'V1Ojsqr-pour-de-vrai';
    const d = installDetector({ formats: ['ean_13'], detect: () => Promise.resolve([{ rawValue: 'NE-DOIT-PAS-ETRE-LU' }]) });
    const scanner = await start(w);
    await advance(SCAN_INTERVAL_MS);
    expect(d.detect).not.toHaveBeenCalled();
    expect(w.texts).toEqual(['V1Ojsqr-pour-de-vrai']);
    scanner.stop();
  });

  it('getSupportedFormats qui lève : repli jsqr', async () => {
    const w = setup();
    w.camera.qrText = 'V1Orepli';
    const d = installDetector({ formats: 'throw', detect: () => Promise.resolve([]) });
    await start(w);
    await advance(SCAN_INTERVAL_MS);
    expect(d.detect).not.toHaveBeenCalled();
    expect(w.texts).toEqual(['V1Orepli']);
  });

  it('constructeur de BarcodeDetector qui lève : repli jsqr', async () => {
    const w = setup();
    w.camera.qrText = 'V1Octor';
    const d = installDetector({ ctorThrows: true, detect: () => Promise.resolve([]) });
    await start(w);
    await advance(SCAN_INTERVAL_MS);
    expect(d.detect).not.toHaveBeenCalled();
    expect(w.texts).toEqual(['V1Octor']);
  });

  it('BarcodeDetector qui lève pendant la lecture : repli jsqr sur cette image ET sur les suivantes, sans rappeler le lecteur natif', async () => {
    const w = setup();
    w.camera.qrText = 'V1Opanne';
    const d = installDetector({ detect: () => Promise.reject(domError('NotSupportedError')) });
    const scanner = await start(w);
    await advance(SCAN_INTERVAL_MS);
    expect(d.detect).toHaveBeenCalledTimes(1);
    expect(w.texts).toEqual(['V1Opanne']);
    await advance(1000);
    expect(d.detect).toHaveBeenCalledTimes(1); // plus jamais
    expect(w.camera.imageDataCalls).toBeGreaterThanOrEqual(8);
    scanner.stop();
  });

  it('BarcodeDetector qui ne trouve rien : on ne bascule PAS sur jsqr', async () => {
    const w = setup();
    w.camera.qrText = 'V1Opas-lu';
    const d = installDetector({ detect: () => Promise.resolve([]) });
    const scanner = await start(w);
    await advance(1000);
    expect(d.detect.mock.calls.length).toBeGreaterThan(5);
    expect(w.camera.imageDataCalls).toBe(0);
    expect(w.texts).toEqual([]);
    scanner.stop();
  });

  it('sans BarcodeDetector : jsqr décode une vraie image de QR (code réel de 300 caractères)', async () => {
    const w = setup();
    const code = 'V1O' + 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_'.repeat(8) + 'Zz9_';
    w.camera.qrText = code;
    const scanner = await start(w);
    await advance(SCAN_INTERVAL_MS);
    expect(w.texts).toEqual([code]);
    scanner.stop();
  });

  it('jsqr : image de travail bornée à SCAN_MAX_WIDTH de large, proportions conservées', async () => {
    const w = setup();
    w.video.videoWidth = 1920;
    w.video.videoHeight = 1080;
    const scanner = await start(w);
    await advance(SCAN_INTERVAL_MS * 3);
    expect(w.camera.drawCalls.length).toBeGreaterThan(0);
    for (const c of w.camera.drawCalls) {
      expect(c.w).toBe(SCAN_MAX_WIDTH);
      expect(c.h).toBe(Math.round((1080 * SCAN_MAX_WIDTH) / 1920));
    }
    scanner.stop();
  });

  it('SCAN_MAX_WIDTH : la vidéo 1280 × 720 demandée à la caméra est analysée telle quelle (pas de réduction qui rendrait les QR denses illisibles)', async () => {
    expect(SCAN_MAX_WIDTH).toBeGreaterThanOrEqual(1280);
    const w = setup();
    const scanner = await start(w); // 1280 × 720
    await advance(SCAN_INTERVAL_MS);
    expect(w.camera.drawCalls[0]).toEqual({ w: 1280, h: 720 });
    scanner.stop();
  });

  it('jsqr : un code RÉEL dense de 600 caractères, cadré à 60-65 % de la hauteur d\'une image 1280 × 720 (pixels moyennés, décalages sous-pixel), est lu à chaque cadrage', async () => {
    // 600 caractères d'alphabet base64url, pseudo-aléatoires mais déterministes : version 17 en niveau L, 93 modules avec la marge, ≈ 3,9 px par module dans la scène
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let seed = 12345;
    let code = 'V1O';
    while (code.length < 600) {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      code += alphabet[(seed >>> 16) % 64];
    }
    // cadrages choisis parmi ceux que `jsqr` rate à 640 px de large (mesuré : 5 sur 12 à 65 % de la hauteur) et lit tous à 1280 px
    const framings: Framing[] = [
      { frac: 0.65, dx: 0, dy: 0 },
      { frac: 0.65, dx: 0.74, dy: 1.06 },
      { frac: 0.65, dx: 1.11, dy: 1.59 },
      { frac: 0.65, dx: 2.22, dy: 0.18 },
      { frac: 0.65, dx: 2.96, dy: 1.24 },
      { frac: 0.65, dx: 3.7, dy: 2.3 },
      { frac: 0.6, dx: 0, dy: 0 },
    ];
    const failures: Framing[] = [];
    for (const framing of framings) {
      const w = setup();
      w.camera.qrText = code;
      w.camera.framing = framing;
      const scanner = await start(w);
      await advance(SCAN_INTERVAL_MS * 2);
      scanner.stop();
      if (!w.texts.includes(code)) failures.push(framing);
      vi.unstubAllGlobals();
    }
    expect(failures).toEqual([]);
  });

  it('jsqr : une petite vidéo n est pas agrandie', async () => {
    const w = setup();
    w.video.videoWidth = 320;
    w.video.videoHeight = 240;
    await start(w);
    await advance(SCAN_INTERVAL_MS);
    expect(w.camera.drawCalls[0]).toEqual({ w: 320, h: 240 });
  });

  it('jsqr : vidéo sans dimensions (pas encore décodée) : aucune analyse', async () => {
    const w = setup();
    w.video.videoWidth = 0;
    w.video.videoHeight = 0;
    await start(w);
    await advance(1000);
    expect(w.camera.imageDataCalls).toBe(0);
  });

  it('jsqr : image sans QR -> aucun texte ; QR illisible (bruit) -> aucun texte, la lecture continue', async () => {
    const w = setup();
    const scanner = await start(w);
    await advance(500);
    expect(w.texts).toEqual([]);
    expect(w.camera.imageDataCalls).toBeGreaterThanOrEqual(4);
    w.camera.qrText = 'V1Oarrive';
    await advance(SCAN_INTERVAL_MS);
    expect(w.texts).toEqual(['V1Oarrive']);
    scanner.stop();
  });

  it('stop() avec jsqr : plus aucune copie d image ensuite', async () => {
    const w = setup();
    const scanner = await start(w);
    await advance(300);
    scanner.stop();
    const n = w.camera.imageDataCalls;
    await advance(3000);
    expect(w.camera.imageDataCalls).toBe(n);
    expect(w.stream.tracks.map((t) => t.stopCount)).toEqual([1, 1]);
  });
});

// ───────────────────────────── createScanGate ─────────────────────────────

describe('createScanGate', () => {
  it('une SEULE acceptation : ensuite tout est ignoré, même un autre texte', async () => {
    const accept = vi.fn(async (t: string) => t === 'bon');
    const gate = createScanGate(accept);
    gate('bon');
    await advance(0);
    expect(accept).toHaveBeenCalledTimes(1);
    gate('bon');
    gate('autre');
    await advance(10_000);
    gate('bon');
    expect(accept).toHaveBeenCalledTimes(1);
  });

  it('accept synchrone : mêmes règles', () => {
    const accept = vi.fn((t: string) => t === 'bon');
    const gate = createScanGate(accept);
    gate('mauvais');
    gate('mauvais'); // anti-rebond
    expect(accept).toHaveBeenCalledTimes(1);
    gate('bon');
    expect(accept).toHaveBeenCalledTimes(2);
    gate('bon');
    gate('encore');
    expect(accept).toHaveBeenCalledTimes(2);
  });

  it('anti-rebond : un texte rejeté n est pas revalidé avant repeatMs, un autre texte l est tout de suite, puis le premier de nouveau après repeatMs', async () => {
    const accept = vi.fn(async () => false);
    const gate = createScanGate(accept, { repeatMs: 2000 });
    gate('A');
    await advance(0);
    expect(accept).toHaveBeenCalledTimes(1);
    await advance(1999);
    gate('A');
    await advance(0);
    expect(accept).toHaveBeenCalledTimes(1); // trop tôt
    gate('B'); // autre texte : validé tout de suite
    await advance(0);
    expect(accept).toHaveBeenCalledTimes(2);
    expect(accept).toHaveBeenLastCalledWith('B');
    await advance(1); // 2000 ms depuis le rejet de A
    gate('A');
    await advance(0);
    expect(accept).toHaveBeenCalledTimes(3);
    expect(accept).toHaveBeenLastCalledWith('A');
  });

  it('anti-rebond PAR texte : A, B, A dans les délais ne rappelle accept que 2 fois (deux QR étrangers qui alternent)', async () => {
    const accept = vi.fn(async () => false);
    const gate = createScanGate(accept, { repeatMs: 2000 });
    gate('A');
    await advance(0);
    gate('B');
    await advance(0);
    gate('A');
    gate('B');
    await advance(500);
    gate('A');
    gate('B');
    expect(accept).toHaveBeenCalledTimes(2);
    await advance(1500); // A (rejeté à 0) et B (rejeté à 0) sont de nouveau admis
    gate('A');
    await advance(0);
    gate('B');
    expect(accept).toHaveBeenCalledTimes(4);
  });

  it('anti-rebond : la mémoire est bornée (beaucoup de textes différents), les plus anciens sont oubliés', async () => {
    const accept = vi.fn(async () => false);
    const gate = createScanGate(accept, { repeatMs: 100_000 });
    for (let i = 0; i < 30; i++) {
      gate(`texte-${i}`);
      await advance(0);
    }
    expect(accept).toHaveBeenCalledTimes(30);
    gate('texte-29'); // récent : toujours retenu
    expect(accept).toHaveBeenCalledTimes(30);
    gate('texte-0'); // très ancien : oublié (mémoire bornée), revalidé
    expect(accept).toHaveBeenCalledTimes(31);
  });

  it('rejet puis nouvelle lecture après repeatMs : acceptée si elle est valide cette fois', async () => {
    let valid = false;
    const accept = vi.fn(async () => valid);
    const gate = createScanGate(accept, { repeatMs: 1000 });
    gate('code');
    await advance(0);
    valid = true;
    await advance(500);
    gate('code');
    await advance(0);
    expect(accept).toHaveBeenCalledTimes(1);
    await advance(500);
    gate('code');
    await advance(0);
    expect(accept).toHaveBeenCalledTimes(2);
    gate('code');
    await advance(5000);
    gate('code');
    expect(accept).toHaveBeenCalledTimes(2); // déjà acceptée : fini
  });

  it('délai par défaut = SCAN_REPEAT_MS', async () => {
    const accept = vi.fn(async () => false);
    const gate = createScanGate(accept);
    gate('x');
    await advance(SCAN_REPEAT_MS - 1);
    gate('x');
    expect(accept).toHaveBeenCalledTimes(1);
    await advance(1);
    gate('x');
    expect(accept).toHaveBeenCalledTimes(2);
  });

  it('pas de réentrance pendant une validation asynchrone : les textes lus entre-temps sont perdus, pas empilés', async () => {
    let resolve: (v: boolean) => void = () => undefined;
    const accept = vi.fn(() => new Promise<boolean>((r) => (resolve = r)));
    const gate = createScanGate(accept);
    gate('A');
    gate('A');
    gate('B');
    gate('C');
    await advance(5000);
    expect(accept).toHaveBeenCalledTimes(1); // validation toujours en cours
    resolve(false);
    await advance(0);
    gate('B'); // la porte est libre de nouveau
    expect(accept).toHaveBeenCalledTimes(2);
    expect(accept).toHaveBeenLastCalledWith('B');
  });

  it('pas de réentrance : une validation en cours qui réussit ferme la porte pour de bon', async () => {
    let resolve: (v: boolean) => void = () => undefined;
    const accept = vi.fn(() => new Promise<boolean>((r) => (resolve = r)));
    const gate = createScanGate(accept);
    gate('A');
    gate('B');
    resolve(true);
    await advance(0);
    gate('C');
    gate('A');
    expect(accept).toHaveBeenCalledTimes(1);
  });

  it('accept qui lève ou rejette = rejet (jamais propagé), avec anti-rebond, et la porte reste utilisable', async () => {
    const accept = vi.fn((t: string): Promise<boolean> | boolean => {
      if (t === 'sync') throw new Error('bug synchrone');
      if (t === 'async') return Promise.reject(new Error('bug asynchrone'));
      return true;
    });
    const gate = createScanGate(accept, { repeatMs: 1000 });
    expect(() => gate('sync')).not.toThrow();
    gate('sync');
    expect(accept).toHaveBeenCalledTimes(1); // anti-rebond
    gate('async');
    await advance(0);
    gate('async');
    expect(accept).toHaveBeenCalledTimes(2);
    await advance(1000);
    gate('sync');
    expect(accept).toHaveBeenCalledTimes(3);
    gate('ok');
    expect(accept).toHaveBeenCalledTimes(4);
    gate('autre');
    expect(accept).toHaveBeenCalledTimes(4);
  });
});

// ───────────────────────────── Intégration lecteur + porte ─────────────────────────────

describe('lecteur + createScanGate', () => {
  it('un QR invalide est ignoré (caméra ouverte), le bon est accepté une seule fois, puis la caméra peut être coupée', async () => {
    const w = setup();
    w.camera.qrText = 'V1Oautre-contenu';
    const seen: string[] = [];
    let scanner: QrScanner | null = null;
    const gate = createScanGate((text) => {
      seen.push(text);
      return text === 'V1Obon-code';
    });
    scanner = await startQrScanner({ video: w.video as unknown as HTMLVideoElement, onText: gate, onError: (k) => w.errors.push(k) });
    await advance(1200);
    expect(seen).toEqual(['V1Oautre-contenu']); // rejeté une fois, anti-rebond ensuite
    expect(w.stream.tracks.every((t) => t.stopCount === 0)).toBe(true); // la caméra reste ouverte
    w.camera.qrText = 'V1Obon-code';
    await advance(SCAN_INTERVAL_MS);
    expect(seen).toEqual(['V1Oautre-contenu', 'V1Obon-code']);
    scanner.stop();
    expect(w.stream.tracks.map((t) => t.stopCount)).toEqual([1, 1]);
    expect(w.errors).toEqual([]);
  });
});
