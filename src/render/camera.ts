/**
 * Caméras du jeu : une caméra Phaser indépendante par joueur (suivi du héros avec léger lissage, bornes = taille
 * de la salle, centrage si la salle est plus petite que la vue) + une caméra d'interface plein écran.
 *
 * La partie PURE (clamp, snap, lissage, indicateurs de bord) est testée sans Phaser ; la classe `ViewRig`
 * n'utilise Phaser que par TYPE (import type) : ce module reste importable sous Node.
 *
 * Visibilité (« qui voit quoi ») : Phaser n'a pas de calques par caméra, on utilise `Camera.ignore` :
 *  - `registerWorld(obj)`  : objet du monde → ignoré par la caméra d'interface ;
 *  - `registerHud(obj)`    : objet d'interface (coordonnées écran) → ignoré par toutes les caméras joueur ;
 *  - `registerVision(obj, p)` : objet du monde visible UNIQUEMENT dans la caméra du joueur p (vision partagée).
 */
import type Phaser from 'phaser';
import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import type { PlayerId, Vec2 } from '../core/types';
import type { SplitLayout } from './splitscreen';

// ───────────────────────────── Fonctions pures ─────────────────────────────

/** Demi-vie (ms) du lissage du suivi de caméra : plus petit = plus nerveux. */
export const CAMERA_HALF_LIFE_MS = 70;
/** Au-delà de cette distance (px monde) entre caméra et cible, la caméra « saute » (changement de salle, téléport). */
export const CAMERA_SNAP_DISTANCE = 160;

/**
 * Borne le centre de caméra sur un axe. Salle plus petite que la vue → centrée sur la salle ;
 * sinon `center` est borné pour que la vue ne dépasse pas de la salle.
 *
 * @param center centre souhaité (px monde)
 * @param viewSize taille de la vue sur cet axe (px monde, = viewport / zoom)
 * @param roomSize taille de la salle sur cet axe (px monde)
 */
export function clampCameraAxis(center: number, viewSize: number, roomSize: number): number {
  if (!Number.isFinite(center)) return roomSize / 2;
  if (roomSize <= viewSize) return roomSize / 2;
  const half = viewSize / 2;
  return Math.max(half, Math.min(roomSize - half, center));
}

/** Aligne une coordonnée monde sur la grille des pixels d'écran (multiples de 1/zoom) : pixels nets. */
export function snapToScreenPixel(v: number, zoom: number): number {
  if (!(zoom > 0)) return v;
  return Math.round(v * zoom) / zoom;
}

/** Facteur de lissage exponentiel indépendant du framerate : part de l'écart comblée en `dtMs` pour une demi-vie donnée. */
export function followFactor(dtMs: number, halfLifeMs: number = CAMERA_HALF_LIFE_MS): number {
  if (!(dtMs > 0)) return 0;
  if (!(halfLifeMs > 0)) return 1;
  return 1 - Math.pow(0.5, dtMs / halfLifeMs);
}

/**
 * Fait avancer le centre `cur` (MUTÉ) vers `target`, borné à la salle, aligné sur les pixels d'écran.
 * `snap = true` (ou cible très lointaine) → placement immédiat.
 */
export function stepCameraCenter(
  cur: Vec2,
  target: Vec2,
  dtMs: number,
  view: { w: number; h: number },
  room: { w: number; h: number },
  zoom: number,
  snap = false,
  halfLifeMs: number = CAMERA_HALF_LIFE_MS,
): void {
  const tx = clampCameraAxis(target.x, view.w, room.w);
  const ty = clampCameraAxis(target.y, view.h, room.h);
  const far = Math.abs(tx - cur.x) > CAMERA_SNAP_DISTANCE || Math.abs(ty - cur.y) > CAMERA_SNAP_DISTANCE;
  if (snap || far || !Number.isFinite(cur.x) || !Number.isFinite(cur.y)) {
    cur.x = tx;
    cur.y = ty;
  } else {
    const k = followFactor(dtMs, halfLifeMs);
    cur.x += (tx - cur.x) * k;
    cur.y += (ty - cur.y) * k;
    cur.x = clampCameraAxis(cur.x, view.w, room.w);
    cur.y = clampCameraAxis(cur.y, view.h, room.h);
  }
}

/** Résultat de `edgeIndicator`. */
export interface EdgeIndicator {
  /** La cible est hors de la vue (l'indicateur doit être affiché). */
  visible: boolean;
  /** Position de l'indicateur dans le repère de la vue (px écran de la vue, origine en haut à gauche). */
  x: number;
  y: number;
  /** Angle (rad) de la direction vers la cible (0 = vers la droite). */
  angle: number;
}

/**
 * Indicateur de bord : où afficher une flèche pointant vers une cible hors de vue.
 *
 * @param dx écart horizontal cible − centre de la vue (px d'écran, donc monde × zoom)
 * @param dy écart vertical cible − centre de la vue (px d'écran)
 * @param viewW largeur de la vue (px d'écran)
 * @param viewH hauteur de la vue (px d'écran)
 * @param margin marge intérieure (px d'écran) entre le bord et l'indicateur
 */
export function edgeIndicator(dx: number, dy: number, viewW: number, viewH: number, margin = 12): EdgeIndicator {
  const halfW = viewW / 2;
  const halfH = viewH / 2;
  const angle = Math.atan2(dy, dx);
  if (Math.abs(dx) <= halfW && Math.abs(dy) <= halfH) {
    return { visible: false, x: halfW + dx, y: halfH + dy, angle };
  }
  const iw = Math.max(1, halfW - margin);
  const ih = Math.max(1, halfH - margin);
  // intersection du rayon centre→cible avec le rectangle intérieur
  const sx = dx === 0 ? Infinity : iw / Math.abs(dx);
  const sy = dy === 0 ? Infinity : ih / Math.abs(dy);
  const s = Math.min(sx, sy);
  return { visible: true, x: halfW + dx * s, y: halfH + dy * s, angle };
}

// ───────────────────────────── ViewRig (Phaser) ─────────────────────────────

type Cam = Phaser.Cameras.Scene2D.Camera;
type Obj = Phaser.GameObjects.GameObject;

/**
 * Ensemble des caméras de la scène de jeu : N caméras joueur (une par vue) + une caméra d'interface plein écran
 * créée EN DERNIER (rendue par-dessus tout). Gère aussi la visibilité des objets (voir en-tête du module).
 */
export class ViewRig {
  readonly layout: SplitLayout;
  readonly playerCams: Cam[] = [];
  readonly uiCam: Cam;
  /** Taille de la salle courante (px monde). */
  roomW = 0;
  roomH = 0;
  private readonly centers: Vec2[] = [];
  private readonly view: { w: number; h: number }[] = [];
  private readonly scene: Phaser.Scene;
  private destroyed = false;

  constructor(scene: Phaser.Scene, layout: SplitLayout) {
    this.scene = scene;
    this.layout = layout;
    const mgr = scene.cameras;
    layout.viewports.forEach((vp, i) => {
      // la caméra principale (créée par Phaser) sert de caméra du joueur 0 ; les autres sont ajoutées ensuite
      const cam: Cam = i === 0 ? mgr.main : mgr.add(vp.x, vp.y, vp.w, vp.h);
      cam.setViewport(vp.x, vp.y, vp.w, vp.h);
      cam.setZoom(vp.zoom);
      cam.setRoundPixels(true);
      cam.setScroll(0, 0);
      cam.setName(`player${i}`);
      this.playerCams.push(cam);
      this.centers.push({ x: Number.NaN, y: Number.NaN });
      this.view.push({ w: vp.w / vp.zoom, h: vp.h / vp.zoom });
    });
    this.uiCam = mgr.add(0, 0, GAME_WIDTH, GAME_HEIGHT);
    this.uiCam.setName('ui');
    this.uiCam.setRoundPixels(true);
    this.uiCam.setZoom(1);
  }

  /** Enregistre un objet du monde : visible par les caméras joueur, jamais par la caméra d'interface. */
  registerWorld<T extends Obj>(obj: T): T {
    this.uiCam.ignore(obj);
    return obj;
  }

  /** Enregistre un objet d'interface (coordonnées écran) : visible seulement par la caméra d'interface. */
  registerHud<T extends Obj>(obj: T): T {
    for (const cam of this.playerCams) cam.ignore(obj);
    return obj;
  }

  /** Enregistre un objet du monde visible UNIQUEMENT dans la vue du joueur `playerId` (vision partagée). */
  registerVision<T extends Obj>(obj: T, playerId: PlayerId): T {
    this.uiCam.ignore(obj);
    for (let i = 0; i < this.playerCams.length; i++) {
      if (i !== playerId) this.playerCams[i].ignore(obj);
    }
    return obj;
  }

  /** Nouvelle salle : taille en pixels et couleur de fond (hors salle) ; les caméras sautent sur leur cible au prochain `follow`. */
  setRoom(widthPx: number, heightPx: number, backgroundColor: number): void {
    this.roomW = widthPx;
    this.roomH = heightPx;
    for (const cam of this.playerCams) cam.setBackgroundColor(backgroundColor);
    for (const c of this.centers) {
      c.x = Number.NaN;
      c.y = Number.NaN;
    }
  }

  /** Suit la cible (px monde) pour le joueur `playerId`. `snap` = placement immédiat. */
  follow(playerId: number, target: Vec2, dtMs: number, snap = false): void {
    const cam = this.playerCams[playerId];
    const c = this.centers[playerId];
    if (!cam || !c) return;
    const vp = this.layout.viewports[playerId];
    stepCameraCenter(c, target, dtMs, this.view[playerId], { w: this.roomW, h: this.roomH }, vp.zoom, snap);
    const sx = snapToScreenPixel(c.x, vp.zoom);
    const sy = snapToScreenPixel(c.y, vp.zoom);
    cam.centerOn(sx, sy);
  }

  /** Centre courant (px monde) de la caméra d'un joueur. */
  centerOf(playerId: number): Vec2 {
    return this.centers[playerId] ?? { x: 0, y: 0 };
  }

  /** Taille de la zone monde visible par un joueur (px monde). */
  viewSize(playerId: number): { w: number; h: number } {
    return this.view[playerId] ?? { w: 0, h: 0 };
  }

  /** Secousse de la caméra d'un joueur (ou de toutes si `playerId` est omis). */
  shake(durationMs: number, intensity: number, playerId?: number): void {
    if (playerId === undefined) {
      for (const cam of this.playerCams) cam.shake(durationMs, intensity);
    } else {
      this.playerCams[playerId]?.shake(durationMs, intensity);
    }
  }

  /** Retire les caméras ajoutées et rend la caméra principale à l'état par défaut. Idempotent. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    const mgr = this.scene.cameras;
    try {
      for (let i = 1; i < this.playerCams.length; i++) mgr.remove(this.playerCams[i], true);
      mgr.remove(this.uiCam, true);
      const main = this.playerCams[0];
      main.setViewport(0, 0, GAME_WIDTH, GAME_HEIGHT);
      main.setZoom(1);
      main.setScroll(0, 0);
      main.setBackgroundColor('rgba(0,0,0,0)');
      main.resetFX();
    } catch {
      /* scène déjà détruite : rien à nettoyer */
    }
  }
}
