/**
 * ENCODEUR de QR codes pour les codes d'invitation / de réponse du multijoueur réseau (docs/NET.md § 4.3). Remplace le copier-coller : l'hôte affiche le QR de
 * son invitation, l'invité le lit, puis affiche à son tour le QR de sa réponse. Le texte encodé est le code NETTOYÉ (`cleanCode`, sans espaces).
 *
 * Bibliothèque : `qrcode-generator` (MIT, sans dépendance, importée statiquement : le jeu doit fonctionner hors ligne). Elle ne fournit que la matrice de modules ;
 * le dessin (`drawQrToCanvas`) et la conversion en pixels (`qrToRgba`) sont faits ici, ce qui permet de maîtriser la netteté (pixels entiers, aucun lissage)
 * et de tester l'aller-retour sous Node avec le décodeur `jsqr`.
 *
 * Niveau de correction et version :
 *  - on essaie d'abord le niveau M (15 % de correction, très robuste à une caméra de téléphone) ; si la matrice dépasse la version 14 (73 modules de côté),
 *    on passe au niveau L (7 %) qui reste plus petit, donc avec des modules plus gros à l'écran. Au-delà de la version 20 (97 modules), on refuse (`Error`) :
 *    les modules deviendraient trop petits pour un écran de téléphone.
 *  - mode « octets » (8 bits) : l'alphabet des codes mélange minuscules et majuscules, le mode alphanumérique (majuscules seules) ne s'applique pas.
 *
 * Mesures (codes RÉELS produits par `encodeSignalCode` avec 1, 4 et 8 candidats ICE IPv4 ; qrCode.test.ts les recalcule, les compare à ces valeurs et vérifie le décodage) :
 *   -  245 caractères (1 candidat)  : version 11, niveau M, 61 × 61 modules (69 × 69 avec la marge de 4 modules) ;
 *   -  415 caractères (4 candidats) : version 13, niveau L, 69 × 69 modules (77 × 77 avec la marge) ;
 *   -  637 caractères (8 candidats) : version 17, niveau L, 85 × 85 modules (93 × 93 avec la marge).
 *  Capacités en octets : niveau M, 362 jusqu'à la version 14 ; niveau L, 644 en version 17, 858 en version 20 (le maximum accepté : 97 × 97 modules).
 *  Au-delà de 858 caractères `qrMatrix` lève une `Error` : l'écran doit alors se rabattre sur le seul texte. Cela n'arrive que dans un cas extrême (8 candidats
 *  tous en noms mDNS / IPv6 : ~ 990 caractères) ; un code de 8 candidats dont la moitié en IPv6 fait ~ 780 caractères (version 19, niveau L, 93 × 93 modules).
 *  Sur un téléphone de 360 px de large (DPR 3 : 1080 px physiques) tenu en PORTRAIT, le QR de 637 caractères (93 modules avec la marge) occupe 11 px physiques par module :
 *  très lisible. En PAYSAGE (le jeu impose ce sens sur téléphone) le QR est limité par la hauteur de l'écran : ≈ 217 px CSS soit 7 px physiques par module (3,7 cm de côté) ;
 *  vu à 10 cm de la caméra de l'autre téléphone il occupe environ la moitié de la hauteur de l'image, d'où une analyse en 1280 px de large (`SCAN_MAX_WIDTH`).
 */
import qrcode from 'qrcode-generator';

export type QrEcc = 'L' | 'M';

export interface QrMatrix {
  /** Nombre de modules par côté, SANS marge (17 + 4 × version). */
  readonly size: number;
  /** Version du QR (1 à 40 ; 20 au plus ici). */
  readonly version: number;
  readonly ecc: QrEcc;
  /** `modules[ligne][colonne]` ; `true` = module sombre. SANS marge. */
  readonly modules: readonly (readonly boolean[])[];
}

/** Marge blanche obligatoire autour du QR (zone de silence), en modules. */
export const QR_QUIET_ZONE = 4;
/** Plus grande version de QR acceptée : au-delà, les modules sont trop petits pour un écran de téléphone. */
export const QR_MAX_VERSION = 20;
/** Plus grande version avec laquelle on garde le niveau de correction M (au-delà on bascule sur L). */
export const QR_MAX_VERSION_FOR_M = 14;

/** Construit la matrice pour un niveau donné ; `version` = version choisie par la bibliothèque (la plus petite qui contient les données). */
function build(text: string, ecc: QrEcc): QrMatrix {
  let qr: ReturnType<typeof qrcode>;
  try {
    qr = qrcode(0, ecc); // 0 = version automatique
    qr.addData(text, 'Byte');
    qr.make();
  } catch (e) {
    // la bibliothèque lève une CHAÎNE (« code length overflow ») : on la convertit en vraie Error
    throw new Error(`QR code : texte trop long (${text.length} caractères, niveau ${ecc})${typeof e === 'string' ? ` : ${e}` : ''}`);
  }
  const size = qr.getModuleCount();
  const modules: boolean[][] = [];
  for (let r = 0; r < size; r++) {
    const row: boolean[] = [];
    for (let c = 0; c < size; c++) row.push(qr.isDark(r, c));
    modules.push(row);
  }
  return { size, version: (size - 17) / 4, ecc, modules };
}

/**
 * Texte → matrice de QR. Sans `ecc` : niveau M, ou L si la matrice M dépasserait la version `QR_MAX_VERSION_FOR_M` (14). Avec `ecc` : ce niveau est imposé.
 * @throws Error si le texte contient un caractère hors ASCII (la bibliothèque tronquerait silencieusement à 8 bits) ou ne tient pas dans la version `QR_MAX_VERSION` (20).
 */
export function qrMatrix(text: string, ecc?: QrEcc): QrMatrix {
  if (typeof text !== 'string' || text.length === 0) throw new Error('QR code : texte vide');
  if (!/^[\x00-\x7f]*$/.test(text)) throw new Error('QR code : texte non ASCII non pris en charge');
  let result: QrMatrix | null = null;
  if (ecc === undefined) {
    // M d'abord ; s'il est trop gros (ou ne tient pas du tout), L
    try {
      const m = build(text, 'M');
      if (m.version <= QR_MAX_VERSION_FOR_M) result = m;
    } catch {
      /* trop gros même pour la version 40 en M : L sera tenté et lèvera l'erreur claire s'il ne tient pas non plus */
    }
    result ??= build(text, 'L');
  } else {
    result = build(text, ecc);
  }
  if (result.version > QR_MAX_VERSION) {
    throw new Error(`QR code : texte trop long (${text.length} caractères : version ${result.version} > ${QR_MAX_VERSION}, niveau ${result.ecc})`);
  }
  return result;
}

/** Longueur (en modules) du côté du QR AVEC sa marge. */
function paddedSize(matrix: QrMatrix): number {
  return matrix.size + 2 * QR_QUIET_ZONE;
}

/**
 * Dessine le QR (noir sur blanc, marge de 4 modules incluse) dans `canvas`, le plus grand possible dans `maxCssPx` pixels CSS (carré), avec un nombre ENTIER de
 * pixels PHYSIQUES par module (netteté : pas de module flou) et sans lissage. Le canvas est dimensionné en pixels physiques (`width`/`height`) et affiché en pixels CSS
 * (`style.width`/`height` = `width / devicePixelRatio`), avec `image-rendering: pixelated`.
 * @returns `cssPx` : côté affiché (pixels CSS) ; `modulePx` : pixels PHYSIQUES (ceux du canvas) par module, au moins 1. Si `maxCssPx` est trop petit pour 1 pixel par
 *   module, le QR est dessiné à 1 pixel par module et dépasse `maxCssPx` (à l'appelant de juger qu'il est illisible : `modulePx < 2`).
 */
export function drawQrToCanvas(canvas: HTMLCanvasElement, matrix: QrMatrix, maxCssPx: number): { cssPx: number; modulePx: number } {
  const dprRaw = (globalThis as { devicePixelRatio?: number }).devicePixelRatio;
  const dpr = typeof dprRaw === 'number' && Number.isFinite(dprRaw) && dprRaw > 0 ? dprRaw : 1;
  const count = paddedSize(matrix);
  const budget = Number.isFinite(maxCssPx) && maxCssPx > 0 ? maxCssPx : 0;
  // petite tolérance : 100 × 1,1 / 1,1 ne doit pas perdre un pixel à cause d'un arrondi flottant
  const modulePx = Math.max(1, Math.floor((budget * dpr) / count + 1e-9));
  const px = count * modulePx;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('QR code : contexte 2D indisponible');
  canvas.width = px;
  canvas.height = px;
  const cssPx = px / dpr;
  canvas.style.width = `${cssPx}px`;
  canvas.style.height = `${cssPx}px`;
  canvas.style.imageRendering = 'pixelated';
  // changer la taille du canvas réinitialise le contexte : le lissage se règle APRÈS
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = '#000000';
  for (let r = 0; r < matrix.size; r++) {
    const row = matrix.modules[r];
    let c = 0;
    while (c < matrix.size) {
      if (!row[c]) {
        c++;
        continue;
      }
      let end = c + 1;
      while (end < matrix.size && row[end]) end++; // une seule fillRect par série de modules sombres
      ctx.fillRect((QR_QUIET_ZONE + c) * modulePx, (QR_QUIET_ZONE + r) * modulePx, (end - c) * modulePx, modulePx);
      c = end;
    }
  }
  return { cssPx, modulePx };
}

/** Image RGBA (opaque, noir sur blanc, marge de 4 modules incluse) du QR, `modulePx` pixels par module : pour les tests Node et pour alimenter un décodeur. */
export function qrToRgba(matrix: QrMatrix, modulePx: number): { data: Uint8ClampedArray; width: number; height: number } {
  if (!Number.isInteger(modulePx) || modulePx < 1) throw new Error('QR code : modulePx doit être un entier >= 1');
  const width = paddedSize(matrix) * modulePx;
  const height = width;
  const data = new Uint8ClampedArray(width * height * 4).fill(255); // blanc opaque
  for (let r = 0; r < matrix.size; r++) {
    for (let c = 0; c < matrix.size; c++) {
      if (!matrix.modules[r][c]) continue;
      const x0 = (QR_QUIET_ZONE + c) * modulePx;
      const y0 = (QR_QUIET_ZONE + r) * modulePx;
      for (let y = y0; y < y0 + modulePx; y++) {
        let i = (y * width + x0) * 4;
        for (let x = 0; x < modulePx; x++, i += 4) {
          data[i] = 0;
          data[i + 1] = 0;
          data[i + 2] = 0; // alpha reste à 255
        }
      }
    }
  }
  return { data, width, height };
}
