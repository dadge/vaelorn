/**
 * LECTEUR de QR codes par la caméra (multijoueur réseau : lecture de l'invitation par l'invité, de la réponse par l'hôte ; docs/NET.md § 4.3).
 *
 * Aucune image n'est jamais envoyée, enregistrée ni conservée : les images de la vidéo sont analysées sur place (BarcodeDetector, ou `jsqr` sur une copie réduite
 * dans un canvas), puis oubliées. Seul le TEXTE d'un QR lu est transmis à `onText`.
 *
 * Décodage : `BarcodeDetector` (formats `['qr_code']`) quand il existe et gère le QR, sinon `jsqr` (Apache-2.0, sans dépendance, importée statiquement : hors ligne).
 * Si `BarcodeDetector` lève une erreur en cours de route, on bascule définitivement sur `jsqr`. Cadence : une analyse toutes les `SCAN_INTERVAL_MS` (≈ 10 par seconde),
 * jamais deux en parallèle ; avec `jsqr` l'image de travail est bornée à `SCAN_MAX_WIDTH` pixels de large.
 *
 * Cycle de vie : `startQrScanner` ne rejette JAMAIS (les échecs passent par `onError`, puis un lecteur inerte est rendu). `stop()` est idempotent : il arrête TOUTES les
 * pistes du flux, vide la vidéo et annule le minuteur ; plus aucune analyse ni aucun rappel après. Si `stop()` doit être appelé avant la résolution de la promesse
 * (la scène est fermée pendant la demande d'autorisation), l'appelant l'appelle sur le lecteur dès qu'il est rendu : la caméra est alors coupée aussitôt.
 * L'onglet en arrière-plan, l'annulation et la fermeture de la scène sont du ressort de l'appelant (il appelle `stop()`) ; si le navigateur coupe lui-même la piste,
 * le lecteur le détecte (`ended`) et signale `failed`.
 */
import jsQR from 'jsqr';

export type QrScanError = 'unsupported' | 'insecure' | 'denied' | 'noCamera' | 'failed';

export interface QrScanner {
  /** Coupe la caméra (toutes les pistes) et arrête l'analyse. Idempotent. */
  stop(): void;
}

/** Délai (ms) entre deux analyses : ≈ 10 par seconde au plus. */
export const SCAN_INTERVAL_MS = 100;
/**
 * Largeur maximale (px) de l'image analysée par `jsqr`. On demande une vidéo de 1280 × 720 : ne PAS la réduire. `jsqr` a besoin d'au moins 3,5 à 4 pixels par module,
 * et les codes denses du jeu (400 à 600 caractères, 77 à 93 modules avec la marge) cadrés à 50 / 70 % de la hauteur de l'image n'en ont que 1,9 à 2,7 à 640 px de large
 * (mesuré avec des images synthétiques à bords flous : un code de 600 caractères à 65 % de la hauteur est lu 7 fois sur 12 à 640 px contre 12 sur 12 à 1280 px). Le coût reste acceptable : une analyse toutes les
 * `SCAN_INTERVAL_MS`, jamais deux en parallèle.
 */
export const SCAN_MAX_WIDTH = 1280;
/** Délai (ms) avant de renvoyer à `onText` un texte identique au précédent (le QR reste simplement dans le champ de la caméra). */
export const SCAN_REPEAT_MS = 1500;

// ───────────────────────────── Prise en charge ─────────────────────────────

interface MediaDevicesLike {
  getUserMedia?: (constraints: unknown) => Promise<MediaStreamLike>;
}
interface MediaStreamLike {
  getTracks(): MediaTrackLike[];
}
interface MediaTrackLike {
  stop(): void;
  addEventListener?(type: 'ended', listener: () => void): void;
  removeEventListener?(type: 'ended', listener: () => void): void;
}
interface BarcodeDetectorLike {
  detect(source: unknown): Promise<{ rawValue?: unknown }[]>;
}
interface BarcodeDetectorCtor {
  new (options: { formats: string[] }): BarcodeDetectorLike;
  getSupportedFormats?: () => Promise<string[]>;
}

function mediaDevices(): MediaDevicesLike | undefined {
  const nav = (globalThis as { navigator?: { mediaDevices?: MediaDevicesLike } }).navigator;
  return nav?.mediaDevices;
}

function barcodeDetectorCtor(): BarcodeDetectorCtor | undefined {
  const ctor = (globalThis as { BarcodeDetector?: unknown }).BarcodeDetector;
  return typeof ctor === 'function' ? (ctor as BarcodeDetectorCtor) : undefined;
}

/**
 * La caméra est-elle utilisable ? Sans l'ouvrir. `insecure` : page ni HTTPS ni localhost (le navigateur n'expose alors pas la caméra) ; `unsupported` : pas d'API caméra.
 * Le décodage (`jsqr`) est toujours disponible, il ne conditionne donc rien.
 */
export function qrScanSupport(): 'ok' | QrScanError {
  if ((globalThis as { isSecureContext?: boolean }).isSecureContext === false) return 'insecure';
  if (typeof mediaDevices()?.getUserMedia !== 'function') return 'unsupported';
  return 'ok';
}

/** Erreur de `getUserMedia` → type d'erreur du lecteur. */
function mapCameraError(e: unknown): QrScanError {
  const name = typeof e === 'object' && e !== null ? String((e as { name?: unknown }).name ?? '') : '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError': // bloqué par une politique de permissions : l'utilisateur doit autoriser
      return 'denied';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'noCamera';
    default:
      return 'failed'; // NotReadableError (caméra prise par une autre application), AbortError, etc.
  }
}

// ───────────────────────────── Lecteur ─────────────────────────────

/** Les deux méthodes d'analyse d'une image de la vidéo : textes de TOUS les QR trouvés (vide : aucun). `jsqr` n'en trouve qu'un seul par image (limite connue). */
type Analyzer = (video: HTMLVideoElement) => Promise<string[]>;

/** Analyse par `jsqr` : image de la vidéo recopiée dans un canvas de travail (≤ `SCAN_MAX_WIDTH` de large). Lève si le canvas est indisponible. */
function createJsqrAnalyzer(): Analyzer {
  const doc = (globalThis as { document?: Document }).document;
  const canvas = doc?.createElement?.('canvas');
  const ctx = canvas?.getContext?.('2d', { willReadFrequently: true });
  if (!canvas || !ctx) throw new Error('canvas indisponible');
  return (video) => {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!(vw > 0 && vh > 0)) return Promise.resolve([]);
    const scale = Math.min(1, SCAN_MAX_WIDTH / vw);
    const w = Math.max(1, Math.round(vw * scale));
    const h = Math.max(1, Math.round(vh * scale));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    ctx.drawImage(video, 0, 0, w, h);
    const image = ctx.getImageData(0, 0, w, h);
    // les QR affichés par le jeu sont noir sur blanc : inutile de tenter l'inversion (deux fois plus lent)
    const found = jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' });
    return Promise.resolve(found && found.data.length > 0 ? [found.data] : []);
  };
}

/** `BarcodeDetector` pour les QR, ou null s'il est absent, ne gère pas `qr_code` ou échoue à se construire. */
async function createNativeAnalyzer(): Promise<Analyzer | null> {
  const Ctor = barcodeDetectorCtor();
  if (!Ctor) return null;
  try {
    if (typeof Ctor.getSupportedFormats === 'function') {
      const formats = await Ctor.getSupportedFormats();
      if (!Array.isArray(formats) || !formats.includes('qr_code')) return null;
    }
    const detector = new Ctor({ formats: ['qr_code'] });
    return async (video) => {
      const codes = await detector.detect(video);
      const texts: string[] = [];
      for (const c of codes) if (typeof c.rawValue === 'string' && c.rawValue.length > 0) texts.push(c.rawValue);
      return texts;
    };
  } catch {
    return null;
  }
}

const INERT: QrScanner = { stop() {} };

/** Nombre maximal de textes mémorisés par l'anti-rebond (deux ou trois QR dans le champ suffisent : on borne pour ne jamais grossir). */
const REPEAT_MEMORY_MAX = 8;

/**
 * Mémoire d'anti-rebond PAR TEXTE : `recent(texte)` dit si ce texte a été noté il y a moins de `repeatMs`, `note(texte)` le note. Les entrées échues sont purgées et la
 * taille est bornée (la plus ancienne part la première). Sert au lecteur (même QR resté dans le champ) comme à `createScanGate` (même QR rejeté) : deux QR qui alternent
 * ne se « chassent » pas l'un l'autre.
 */
function createRepeatMemory(repeatMs: number): { recent(text: string): boolean; note(text: string): void } {
  const seen = new Map<string, number>();
  return {
    recent(text) {
      const at = seen.get(text);
      return at !== undefined && Date.now() - at < repeatMs;
    },
    note(text) {
      const now = Date.now();
      seen.delete(text); // ré-insertion : l'ordre du Map reste celui de la dernière note
      seen.set(text, now);
      for (const [key, at] of seen) if (now - at >= repeatMs) seen.delete(key);
      while (seen.size > REPEAT_MEMORY_MAX) seen.delete(seen.keys().next().value as string);
    },
  };
}

/** Un texte a-t-il la forme d'un code du jeu (`V<version>` puis `O` ou `A`, blancs ignorés) ? Simple tri de priorité : la validation est faite par l'appelant. */
function looksLikeGameCode(text: string): boolean {
  return /^\s*V\d{1,3}[OA]/.test(text);
}

/**
 * Ouvre la caméra arrière (`facingMode: environment`, « idéal » : un ordinateur sans caméra arrière prend sa webcam) dans `video` et lit les QR codes.
 * `onText` reçoit le texte de chaque QR lu ; un même texte n'est renvoyé qu'après `SCAN_REPEAT_MS` (utiliser `createScanGate` pour décider). Ne rejette jamais :
 * en cas d'échec `onError(kind)` est appelé UNE fois et un lecteur inerte est rendu. Si la caméra est coupée ensuite par le navigateur : `onError('failed')`.
 */
export async function startQrScanner(opts: { video: HTMLVideoElement; onText(text: string): void; onError(kind: QrScanError): void }): Promise<QrScanner> {
  const { video, onText, onError } = opts;
  const support = qrScanSupport();
  if (support !== 'ok') {
    onError(support);
    return INERT;
  }
  // pas de lecteur natif ET pas de canvas pour `jsqr` : inutile de demander la caméra (aucune fenêtre d'autorisation pour rien)
  let native = barcodeDetectorCtor() !== undefined;
  if (!native) {
    try {
      createJsqrAnalyzer();
    } catch {
      onError('unsupported');
      return INERT;
    }
  }

  let stream: MediaStreamLike;
  try {
    stream = await (mediaDevices() as MediaDevicesLike).getUserMedia!({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
  } catch (e) {
    onError(mapCameraError(e));
    return INERT;
  }

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const memory = createRepeatMemory(SCAN_REPEAT_MS);
  const tracks = stream.getTracks();

  const onTrackEnded = (): void => {
    if (stopped) return;
    stop();
    onError('failed');
  };

  function stop(): void {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    for (const t of tracks) {
      t.removeEventListener?.('ended', onTrackEnded);
      try {
        t.stop();
      } catch {
        /* piste déjà arrêtée */
      }
    }
    try {
      video.pause();
    } catch {
      /* vidéo détachée */
    }
    video.srcObject = null;
  }
  const scanner: QrScanner = { stop };

  for (const t of tracks) t.addEventListener?.('ended', onTrackEnded);

  try {
    video.muted = true;
    video.playsInline = true; // iOS : sans cela la vidéo s'ouvre en plein écran
    video.srcObject = stream as unknown as MediaStream;
    await video.play();
  } catch {
    stop();
    onError('failed');
    return INERT;
  }
  if (stopped) return scanner; // la piste s'est terminée pendant le démarrage : `onError` a déjà été appelé

  let analyzer: Analyzer | null = native ? await createNativeAnalyzer() : null;
  if (stopped) return scanner;
  if (!analyzer) {
    native = false;
    try {
      analyzer = createJsqrAnalyzer();
    } catch {
      stop();
      onError('unsupported');
      return INERT;
    }
  }
  let current: Analyzer = analyzer;

  const analyse = async (): Promise<string[]> => {
    if (video.readyState < 2) return []; // pas encore d'image
    try {
      return await current(video);
    } catch {
      if (!native) return []; // `jsqr` ne devrait pas lever ; en cas d'image illisible on réessaie à la prochaine
      // le lecteur natif a échoué (non pris en charge réellement, flux incompatible) : repli définitif sur `jsqr`
      native = false;
      try {
        current = createJsqrAnalyzer();
        return await current(video);
      } catch {
        return [];
      }
    }
  };

  const tick = async (): Promise<void> => {
    timer = undefined;
    if (stopped) return;
    const texts = await analyse();
    if (stopped) return; // `stop()` pendant l'analyse : aucun rappel
    // UN seul texte par analyse : d'abord ceux qui ont la forme d'un code du jeu (un QR étranger, une affiche, ne doit pas masquer l'écran de l'autre téléphone), parmi
    // eux le premier qui n'a pas été transmis depuis moins de `SCAN_REPEAT_MS` ; les autres passent aux analyses suivantes (100 ms plus tard), le texte transmis étant écarté.
    const ordered = [...texts.filter(looksLikeGameCode), ...texts.filter((x) => !looksLikeGameCode(x))];
    const text = ordered.find((x) => !memory.recent(x));
    if (text !== undefined) {
      memory.note(text);
      try {
        onText(text);
      } catch {
        /* une erreur de l'appelant ne doit pas arrêter la lecture */
      }
    }
    if (!stopped) timer = setTimeout(() => void tick(), SCAN_INTERVAL_MS);
  };
  timer = setTimeout(() => void tick(), SCAN_INTERVAL_MS);
  return scanner;
}

// ───────────────────────────── Porte de validation ─────────────────────────────

/**
 * Petite logique PURE entre le lecteur et la validation du code : on lui donne `accept` (vrai = le texte est un code valide et il a été pris en compte) et elle
 * renvoie la fonction à brancher sur `onText`.
 *  - UNE SEULE acceptation : après un `accept` vrai, tout est ignoré ;
 *  - pas de réentrance : tant qu'une validation (asynchrone) est en cours, les textes lus sont ignorés ;
 *  - anti-rebond : un texte REJETÉ (`false`, ou `accept` qui lève) n'est pas revalidé avant `repeatMs` (défaut `SCAN_REPEAT_MS`) ; un AUTRE texte l'est tout de suite.
 * Les erreurs de `accept` valent un rejet (jamais propagées : le lecteur ne s'arrête pas).
 */
export function createScanGate(accept: (text: string) => Promise<boolean> | boolean, opts: { repeatMs?: number } = {}): (text: string) => void {
  const repeatMs = opts.repeatMs ?? SCAN_REPEAT_MS;
  let busy = false;
  let accepted = false;
  const rejected = createRepeatMemory(repeatMs); // un anti-rebond PAR texte rejeté (deux QR étrangers qui alternent ne se revalident pas à chaque lecture)

  const reject = (text: string): void => rejected.note(text);

  return (text: string): void => {
    if (accepted || busy) return;
    if (rejected.recent(text)) return;
    busy = true;
    let outcome: Promise<boolean> | boolean;
    try {
      outcome = accept(text);
    } catch {
      busy = false;
      reject(text);
      return;
    }
    if (typeof outcome === 'boolean') {
      busy = false;
      if (outcome) accepted = true;
      else reject(text);
      return;
    }
    void outcome.then(
      (ok) => {
        busy = false;
        if (ok) accepted = true;
        else reject(text);
      },
      () => {
        busy = false;
        reject(text);
      },
    );
  };
}
