/**
 * Indicateur d'« appel » : PARTIE PURE (aucune dépendance à Phaser, au DOM ni à l'horloge ; testée sous Node).
 *
 * Quand un joueur lance un appel (voir `CALL_*` dans core/constants.ts), les AUTRES joueurs voient pendant `CALL_DURATION_MS` :
 *  - si l'appelant est HORS de leur vue : un POINT collé au BORD de la vue, dans la direction de l'appelant, et 3 arcs concentriques
 *    (rayons croissants, ~90° chacun) qui partent de ce point VERS L'INTÉRIEUR de l'écran, vers celui qui entend l'appel (icône
 *    « signal / onde »). Les arcs s'allument CHACUN À LEUR TOUR du plus petit au plus grand, en boucle (cycle `CALL_CYCLE_MS`),
 *    comme une onde sonore qui arrive ; couleur du joueur appelant ;
 *  - si l'appelant est VISIBLE dans leur vue : aucun indicateur de bord, mais des anneaux concentriques qui s'étendent autour
 *    de l'appelant dans le monde (vus par tous les joueurs dont la vue le contient, l'appelant compris).
 *
 * La géométrie de projection au bord est celle des flèches existantes vers les alliés à terre et les ennemis restants
 * (`edgeIndicator`, camera.ts) : on ne la duplique pas. Le temps d'animation est DÉRIVÉ de l'état de simulation
 * (`CALL_DURATION_MS - callMs`) : l'animation se fige avec la pause et ne dépend d'aucune horloge de rendu.
 * `callHud.ts` (Phaser) ne fait que dessiner ce que ce module calcule.
 */
import { CALL_DURATION_MS, PLAYER_COLORS } from '../core/constants';
import type { PlayerState, Vec2 } from '../core/types';
import { edgeIndicator, type EdgeIndicator } from './camera';

// ───────────────────────────── Constantes ─────────────────────────────

/** Nombre d'arcs de l'onde (et d'anneaux du monde). */
export const CALL_WAVE_COUNT = 3;
/** Durée (ms) d'un cycle complet : les 3 demi-cercles s'allument chacun à leur tour puis ça recommence. */
export const CALL_CYCLE_MS = 900;
/** Durée (ms) pendant laquelle UN demi-cercle est allumé (3 × 300 = un cycle, donc toujours exactement un allumé). */
export const CALL_STEP_MS = CALL_CYCLE_MS / CALL_WAVE_COUNT;
/** Durée (ms) du fondu de queue d'un demi-cercle qui vient de s'éteindre. */
export const CALL_FADE_MS = 100;
/** Opacité d'un demi-cercle ÉTEINT (fantôme : la forme à 3 arcs reste lisible entre deux éclats). */
export const CALL_GHOST_ALPHA = 0.16;
/** Opacité maximale du fondu de queue (juste après l'extinction). */
export const CALL_TAIL_ALPHA = 0.5;
/** Seuil d'opacité à partir duquel un demi-cercle est considéré « allumé » (un seul à la fois). */
export const CALL_LIT_THRESHOLD = 0.9;

/** Rayons de base (px logiques) des 3 demi-cercles, du plus petit au plus grand ; multipliés par `callHudScale`. */
export const CALL_RADII: readonly number[] = [10, 18, 26];
/** Épaisseur de base (px logiques) du trait des demi-cercles. */
export const CALL_LINE_WIDTH = 3;
/** Marge (px logiques de base) entre le bord de la vue et le point d'origine (le point est collé au bord). */
export const CALL_EDGE_PADDING = 3;
/** Rayon (px logiques de base) du point d'origine de l'onde. */
export const CALL_DOT_RADIUS = 2.5;
/** Ouverture (rad) de chaque arc : un quart de cercle, comme l'icône « signal ». */
export const CALL_ARC_SPAN = Math.PI / 2;
/** Durée (ms) du fondu de sortie global (derniers instants du signal) : l'indicateur ne disparaît pas d'un coup. */
export const CALL_END_FADE_MS = 150;
/**
 * Distance minimale (px logiques de base) entre le point d'origine de l'indicateur d'appel et un autre indicateur de bord : la
 * largeur, le long du bord, du plus grand arc (corde 2 × R × sin(ouverture / 2)), trait compris, pour que les arcs de deux
 * appelants ne se croisent pas.
 */
export const CALL_MIN_SEPARATION = Math.ceil(2 * (CALL_RADII[CALL_WAVE_COUNT - 1] * Math.sin(CALL_ARC_SPAN / 2) + CALL_LINE_WIDTH));
/** Nombre maximal d'appelants simultanés pour un spectateur (4 joueurs − lui-même). */
export const CALL_MAX_CALLERS = 3;

/** Rayon minimal / maximal (px monde) des anneaux d'onde autour d'un appelant visible. */
export const CALL_WORLD_RADIUS_MIN = 6;
export const CALL_WORLD_RADIUS_MAX = 44;
/** Opacité maximale d'un anneau du monde. */
export const CALL_WORLD_ALPHA = 0.85;

// ───────────────────────────── Temps et phases ─────────────────────────────

/** Échelle de l'indicateur selon le zoom d'écran partagé : 1 à 4 joueurs-quadrants (zoom 2), 1,5 pour 1-2 joueurs (zoom 3). */
export function callHudScale(zoom: number): number {
  return Number.isFinite(zoom) && zoom > 0 ? zoom / 2 : 1;
}

/** Le signal d'appel de ce joueur est-il affichable ? (vivant et `callMs > 0`) */
export function isCallSignalActive(p: Pick<PlayerState, 'status' | 'callMs'>): boolean {
  return p.status === 'alive' && Number.isFinite(p.callMs) && p.callMs > 0;
}

/** Temps écoulé (ms) depuis l'appui, dérivé de `callMs` : 0 à l'appui, jusqu'à `CALL_DURATION_MS`. */
export function callElapsedMs(p: Pick<PlayerState, 'callMs'>): number {
  const ms = Number.isFinite(p.callMs) ? p.callMs : 0;
  return Math.max(0, Math.min(CALL_DURATION_MS, CALL_DURATION_MS - ms));
}

/** Indice (0 = le plus petit) du demi-cercle ALLUMÉ à cet instant : toujours exactement un, qui avance de 300 ms en 300 ms. */
export function callWaveIndex(elapsedMs: number): number {
  const t = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
  const phase = t % CALL_CYCLE_MS;
  return Math.min(CALL_WAVE_COUNT - 1, Math.floor(phase / CALL_STEP_MS));
}

/**
 * Opacités (0..1) des 3 demi-cercles à cet instant, du plus petit au plus grand, écrites dans `out` (retourné) :
 *  - allumé (un seul) : 1 ;
 *  - celui qui vient de s'éteindre : fondu de queue (≤ `CALL_TAIL_ALPHA`) sur `CALL_FADE_MS` ;
 *  - les autres : opacité « fantôme » `CALL_GHOST_ALPHA`.
 * Pur et sans allocation si `out` est fourni.
 */
export function callWaveAlphas(elapsedMs: number, out: number[] = []): number[] {
  const t = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
  const phase = t % CALL_CYCLE_MS;
  const lit = Math.min(CALL_WAVE_COUNT - 1, Math.floor(phase / CALL_STEP_MS));
  const sinceLit = phase - lit * CALL_STEP_MS; // temps depuis l'allumage du demi-cercle courant
  const prev = (lit + CALL_WAVE_COUNT - 1) % CALL_WAVE_COUNT;
  for (let i = 0; i < CALL_WAVE_COUNT; i++) {
    if (i === lit) out[i] = 1;
    else if (i === prev && t >= CALL_STEP_MS && sinceLit < CALL_FADE_MS) {
      // (t >= CALL_STEP_MS : au tout premier tour, le plus grand n'a jamais été allumé, donc pas de queue)
      const k = 1 - sinceLit / CALL_FADE_MS;
      out[i] = CALL_GHOST_ALPHA + (CALL_TAIL_ALPHA - CALL_GHOST_ALPHA) * k;
    } else out[i] = CALL_GHOST_ALPHA;
  }
  out.length = CALL_WAVE_COUNT;
  return out;
}

/**
 * Facteur d'opacité global (0..1) du fondu de sortie : 1 jusqu'aux `CALL_END_FADE_MS` dernières millisecondes du signal, puis
 * décroît linéairement jusqu'à 0 à `CALL_DURATION_MS`. À MULTIPLIER aux opacités (demi-cercles de bord et anneaux du monde).
 */
export function callEndFade(elapsedMs: number): number {
  const t = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
  const remaining = CALL_DURATION_MS - t;
  if (remaining >= CALL_END_FADE_MS) return 1;
  return Math.max(0, remaining / CALL_END_FADE_MS);
}

/** Couleur (0xRRGGBB) de l'indicateur : celle du joueur appelant. */
export function callColor(callerId: number): number {
  return PLAYER_COLORS[callerId] ?? 0xffffff;
}

// ───────────────────────────── Spectateurs / appelants ─────────────────────────────

/**
 * Remplit `out` avec les joueurs dont le signal d'appel est en cours, SAUF le spectateur `viewerId` (l'appelant ne voit pas
 * d'indicateur de bord de son propre appel). Retourne leur nombre. Sans allocation (`out` est réutilisé par l'appelant).
 */
export function collectCallers(players: readonly PlayerState[], viewerId: number, out: PlayerState[]): number {
  let n = 0;
  for (let i = 0; i < players.length; i++) {
    const q = players[i];
    if (q.id === viewerId || !isCallSignalActive(q)) continue;
    out[n++] = q;
  }
  out.length = n;
  return n;
}

// ───────────────────────────── Projection au bord ─────────────────────────────

/**
 * Marge (px d'écran) entre le bord de la vue et le POINT d'origine : le point est collé au bord ; les arcs partent de là vers
 * l'intérieur de la vue, donc tout l'indicateur reste dans la vue.
 */
export function callEdgeMargin(scale: number): number {
  return (CALL_DOT_RADIUS + CALL_EDGE_PADDING) * scale;
}

/**
 * Angle (rad) du CENTRE des arcs, pour un appelant dans la direction `angleToCaller` : à l'opposé, c'est-à-dire vers l'intérieur de la
 * vue (vers le joueur qui entend l'appel). Les arcs couvrent [centre − CALL_ARC_SPAN / 2, centre + CALL_ARC_SPAN / 2].
 */
export function callArcCenterAngle(angleToCaller: number): number {
  return angleToCaller + Math.PI;
}

/**
 * Projection d'un appelant sur le bord de la vue du spectateur : même géométrie que les flèches vers les alliés à terre
 * (`edgeIndicator`). `visible` = l'appelant est HORS de la vue (indicateur de bord à afficher) ; `angle` = direction de
 * l'appelant depuis le centre de la vue (rad, 0 = droite, y vers le bas) ; les arcs, eux, pointent à l'opposé (`callArcCenterAngle`).
 *
 * @param callerPos position monde de l'appelant
 * @param camCenter centre monde de la caméra du spectateur
 * @param zoom zoom de la caméra (px écran par px monde)
 * @param viewW largeur de la vue (px écran)
 * @param viewH hauteur de la vue (px écran)
 * @param margin marge (px écran) point d'origine ↔ bord ; défaut `callEdgeMargin(zoom / 2)`
 */
export function callEdgeIndicator(
  callerPos: Vec2,
  camCenter: Vec2,
  zoom: number,
  viewW: number,
  viewH: number,
  margin: number = callEdgeMargin(callHudScale(zoom)),
): EdgeIndicator {
  return edgeIndicator((callerPos.x - camCenter.x) * zoom, (callerPos.y - camCenter.y) * zoom, viewW, viewH, margin);
}

/** Les 4 « bords » d'une vue rectangulaire, pour le glissement le long du bord. */
type Axis = 'x' | 'y';

/**
 * Évite le chevauchement de deux indicateurs de bord : si le centre d'indicateur `anchor` (repère de la vue, px écran) est à
 * moins de `minDist` d'un des `count` premiers points de `others`, on le fait glisser LE LONG du bord sur lequel il se trouve
 * (par pas de `minDist`, alternativement dans un sens puis dans l'autre) jusqu'à trouver une place libre ; sans place libre, on
 * garde la position la plus dégagée. Reste toujours dans le rectangle intérieur (marge `margin`). MUTE `anchor`.
 *
 * @param anchor point d'ancrage (muté) ; doit déjà être sur le rectangle intérieur (sortie de `callEdgeIndicator`)
 * @param others autres indicateurs de bord déjà placés (repère de la vue)
 * @param count nombre d'éléments significatifs de `others`
 */
export function separateFromAnchors(
  anchor: Vec2,
  others: readonly Vec2[],
  count: number,
  viewW: number,
  viewH: number,
  margin: number,
  minDist: number,
): void {
  const halfW = viewW / 2;
  const halfH = viewH / 2;
  const iw = Math.max(1, halfW - margin);
  const ih = Math.max(1, halfH - margin);
  const minD2 = minDist * minDist;
  const clearance = (x: number, y: number): number => {
    let best = Infinity;
    for (let i = 0; i < count; i++) {
      const dx = others[i].x - x;
      const dy = others[i].y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 < best) best = d2;
    }
    return best;
  };
  if (count <= 0 || clearance(anchor.x, anchor.y) >= minD2) return;

  // bord sur lequel se trouve l'ancre : celui dont le rapport |écart au centre| / demi-côté intérieur est le plus grand
  const rx = Math.abs(anchor.x - halfW) / iw;
  const ry = Math.abs(anchor.y - halfH) / ih;
  const axis: Axis = rx >= ry ? 'y' : 'x'; // sur un bord vertical (gauche/droite) on glisse en y, sur un bord horizontal en x
  const origin = axis === 'x' ? anchor.x : anchor.y;
  const lo = axis === 'x' ? halfW - iw : halfH - ih;
  const hi = axis === 'x' ? halfW + iw : halfH + ih;

  let bestPos = origin;
  let bestClear = clearance(anchor.x, anchor.y);
  for (let k = 1; k <= 8; k++) {
    const sign = k % 2 === 1 ? 1 : -1;
    const step = Math.ceil(k / 2) * minDist * sign;
    const pos = Math.max(lo, Math.min(hi, origin + step));
    const x = axis === 'x' ? pos : anchor.x;
    const y = axis === 'y' ? pos : anchor.y;
    const c = clearance(x, y);
    if (c > bestClear) {
      bestClear = c;
      bestPos = pos;
    }
    if (c >= minD2) break;
  }
  if (axis === 'x') anchor.x = bestPos;
  else anchor.y = bestPos;
}

// ───────────────────────────── Anneaux du monde (appelant visible) ─────────────────────────────

/** Un anneau d'onde du monde : rayon (px monde) et opacité (0..1). */
export interface CallWorldRing {
  radius: number;
  alpha: number;
}

/**
 * Anneaux concentriques qui s'étendent autour de l'appelant : l'anneau k démarre `k × CALL_STEP_MS` après le début du signal puis se
 * répète tous les `CALL_CYCLE_MS` ; il grandit de `CALL_WORLD_RADIUS_MIN` à `CALL_WORLD_RADIUS_MAX` en s'estompant. Écrit dans
 * `out` (un objet par anneau, réutilisés) et retourne le nombre d'anneaux actifs (ceux pas encore démarrés sont omis).
 */
export function callWorldRings(elapsedMs: number, out: CallWorldRing[]): number {
  const t = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
  let n = 0;
  for (let k = 0; k < CALL_WAVE_COUNT; k++) {
    const local = t - k * CALL_STEP_MS;
    if (local < 0) continue;
    const phase = (local % CALL_CYCLE_MS) / CALL_CYCLE_MS; // 0..1 dans le cycle de cet anneau
    const eased = 1 - (1 - phase) * (1 - phase); // départ vif, fin douce
    const ring = out[n] ?? (out[n] = { radius: 0, alpha: 0 });
    ring.radius = CALL_WORLD_RADIUS_MIN + (CALL_WORLD_RADIUS_MAX - CALL_WORLD_RADIUS_MIN) * eased;
    ring.alpha = CALL_WORLD_ALPHA * (1 - phase);
    n++;
  }
  return n;
}
