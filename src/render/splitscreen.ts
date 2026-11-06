/**
 * Disposition de l'écran partagé (PUR : aucune dépendance à Phaser ni au DOM).
 *
 * Canvas logique 1280×720 (DESIGN.md §4) :
 *  - 1 joueur  : plein écran, zoom 3 ;
 *  - 2 joueurs : deux moitiés côte à côte (638×720 + séparateur de 4 px), zoom 3 ;
 *  - 3 joueurs : trois quadrants (638×358) + 4ᵉ quadrant = panneau d'équipe, zoom 2 ;
 *  - 4 joueurs : quatre quadrants, zoom 2.
 *
 * Invariant (testé) : viewports + panneau + séparateurs recouvrent TOUT l'écran, sans aucun recouvrement.
 * Le zoom est toujours entier (pixels nets).
 */
import { GAME_HEIGHT, GAME_WIDTH, MAX_PLAYERS } from '../core/constants';

/** Épaisseur (px) des séparateurs entre les vues. */
export const SEPARATOR_PX = 4;
/** Couleur des séparateurs (bleu-nuit presque noir, comme le contour des sprites). */
export const SEPARATOR_COLOR = 0x0b0912;
/** Zoom de caméra pour 1 ou 2 joueurs. */
export const ZOOM_LARGE = 3;
/** Zoom de caméra pour 3 ou 4 joueurs. */
export const ZOOM_SMALL = 2;

/** Rectangle en pixels d'écran. */
export interface ScreenRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Vue d'un joueur : rectangle d'écran + zoom entier de la caméra. */
export interface Viewport extends ScreenRect {
  zoom: number;
}

export interface SplitLayout {
  /** Nombre de joueurs (1..4) pour lequel la disposition a été calculée. */
  playerCount: number;
  /** Zoom entier commun à toutes les vues. */
  zoom: number;
  /** Une vue par joueur (index = PlayerId). */
  viewports: Viewport[];
  /** 3 joueurs uniquement : 4ᵉ quadrant réservé au panneau d'équipe. */
  teamPanel?: ScreenRect;
  /** Séparateurs (rectangles pleins de `SEPARATOR_COLOR`), sans recouvrement entre eux. */
  separators: ScreenRect[];
}

/** Zoom entier selon le nombre de joueurs : 3 pour 1-2, 2 pour 3-4. */
export function zoomForPlayerCount(playerCount: number): number {
  return normalizePlayerCount(playerCount) <= 2 ? ZOOM_LARGE : ZOOM_SMALL;
}

/** Borne un nombre de joueurs (éventuellement invalide) dans 1..4. */
export function normalizePlayerCount(playerCount: number): number {
  if (!Number.isFinite(playerCount)) return 1;
  return Math.max(1, Math.min(MAX_PLAYERS, Math.floor(playerCount)));
}

/**
 * Calcule la disposition de l'écran partagé.
 *
 * @param playerCount nombre de joueurs (borné à 1..4)
 * @param width largeur de l'écran logique (défaut 1280)
 * @param height hauteur de l'écran logique (défaut 720)
 */
export function computeLayout(playerCount: number, width: number = GAME_WIDTH, height: number = GAME_HEIGHT): SplitLayout {
  const n = normalizePlayerCount(playerCount);
  const zoom = zoomForPlayerCount(n);
  const sep = SEPARATOR_PX;

  if (n === 1) {
    return { playerCount: 1, zoom, viewports: [{ x: 0, y: 0, w: width, h: height, zoom }], separators: [] };
  }

  const leftW = Math.floor((width - sep) / 2);
  const rightX = leftW + sep;
  const rightW = width - rightX;

  if (n === 2) {
    return {
      playerCount: 2,
      zoom,
      viewports: [
        { x: 0, y: 0, w: leftW, h: height, zoom },
        { x: rightX, y: 0, w: rightW, h: height, zoom },
      ],
      separators: [{ x: leftW, y: 0, w: sep, h: height }],
    };
  }

  const topH = Math.floor((height - sep) / 2);
  const bottomY = topH + sep;
  const bottomH = height - bottomY;
  const q: Viewport[] = [
    { x: 0, y: 0, w: leftW, h: topH, zoom },
    { x: rightX, y: 0, w: rightW, h: topH, zoom },
    { x: 0, y: bottomY, w: leftW, h: bottomH, zoom },
    { x: rightX, y: bottomY, w: rightW, h: bottomH, zoom },
  ];
  const separators: ScreenRect[] = [
    // vertical : pleine hauteur (inclut l'intersection)
    { x: leftW, y: 0, w: sep, h: height },
    // horizontal : deux segments qui excluent l'intersection
    { x: 0, y: topH, w: leftW, h: sep },
    { x: rightX, y: topH, w: rightW, h: sep },
  ];

  if (n === 3) {
    return {
      playerCount: 3,
      zoom,
      viewports: [q[0], q[1], q[2]],
      teamPanel: { x: q[3].x, y: q[3].y, w: q[3].w, h: q[3].h },
      separators,
    };
  }
  return { playerCount: 4, zoom, viewports: q, separators };
}

/** Taille (px monde) de la zone visible d'une vue : `w / zoom` × `h / zoom`. */
export function worldViewSize(vp: Viewport): { w: number; h: number } {
  return { w: vp.w / vp.zoom, h: vp.h / vp.zoom };
}

/** Rectangle de tous les éléments « pleins » de la disposition (vues, panneau, séparateurs) — utile aux tests. */
export function allLayoutRects(layout: SplitLayout): ScreenRect[] {
  const out: ScreenRect[] = layout.viewports.map((v) => ({ x: v.x, y: v.y, w: v.w, h: v.h }));
  if (layout.teamPanel) out.push(layout.teamPanel);
  for (const s of layout.separators) out.push(s);
  return out;
}

/** Vrai si deux rectangles se recouvrent (les bords qui se touchent ne comptent pas). */
export function rectsOverlap(a: ScreenRect, b: ScreenRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
