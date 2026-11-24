/**
 * MINICARTE (logique PURE) : plan translucide de la salle courante, au centre de l'écran partagé, qui se complète au fur
 * et à mesure que les héros découvrent la salle, avec un pion par héros (appel, soins, à terre).
 *
 * Aucune dépendance à Phaser ni au DOM (testé sous Node) : ce module calcule, `MiniMapHud.ts` dessine.
 * Aucune donnée de la carte n'entre dans `GameState`, dans le snapshot réseau ni dans la sauvegarde : tout est DÉRIVÉ de
 * `GameState` + `RoomDef`, donc l'invité réseau (état miroir) obtient exactement le même plan que l'hôte.
 *
 * ── API (câblée par le lot C) ──
 *  Mémoire de découverte (côté rendu, jamais dans l'état de simulation) :
 *   - `createMapMemory(room)`                           : mémoire vide pour une salle ;
 *   - `updateMapMemory(memory, room, players, elapsedMs)` -> `{ changed, reset }` : MUTE la mémoire. Remise à zéro AUTOMATIQUE
 *     quand l'id de la salle change OU que `elapsedMs` (temps écoulé dans la salle, `state.room.elapsedMs`) recule (= salle
 *     redémarrée après une défaite). Sans allocation quand rien ne bouge (le chemin chaud est appelé à chaque frame) ;
 *   - `isTileKnown(memory, tx, ty)`, `memory.knownCount`, `memory.revision` (incrémenté à chaque changement).
 *  Pions :
 *   - `computeMarkers(players, out?)`                   : un pion par joueur PRÉSENT (les absents n'en ont pas) ; réutilise `out`
 *     (aucune allocation par frame). État = drapeaux cumulables `down` / `heal` / `calling` (priorité d'affichage : à terre >
 *     à soigner > appel ; appel et soins se cumulent) ;
 *   - `markerVisual(marker, timeMs, out)`               : alpha / échelle du clignotement et formes à montrer (basé sur le temps).
 *  Placement :
 *   - `mapBoxFor(layout, width?, height?)`              : boîte où la carte DOIT tenir (zone centrale de `mapZone.ts` à 2-4 joueurs,
 *     boîte plus petite sur le bord droit, centrée verticalement, à 1 joueur / invité réseau) ;
 *   - `mapPlacement(layout, cols, rows, width?, height?)` : échelle ENTIÈRE (>= 1 dès que ça tient), rectangle de la carte et du
 *     panneau (carte + marge), toujours inclus dans la boîte ; `tileToMapPx(...)` : tuile / pixel monde -> pixel d'écran ;
 *   - `heroUnderMap(...)`                               : un héros passerait-il sous le panneau ? ; `heroesUnderMap(...)` : même test pour TOUTES les vues
 *     (une vue unique, ou chaque vue du partage d'écran) : la carte s'estompe alors.
 *  Pions (affichage) : `markerPriority(m)` / `markerDotDepth(...)` : ordre de dessin (à terre > à soigner > appel > normal) ; `markerSizeFactor(scale)` : taille
 *  des pions selon l'échelle de la carte (plus gros quand la carte est petite : ils restent lisibles).
 *  Préférence :
 *   - `loadMapVisible()` / `saveMapVisible(v)`          : visible / masquée (touche Tab), en localStorage, tout en try/catch.
 *  Textes : clés `map.shown` / `map.hidden` (toast de bascule, `mapToggleMessageKey(visible)`) et `map.help` (ligne d'aide du menu pause : touche Tab).
 */
import { GAME_HEIGHT, GAME_WIDTH, LIGHT_EMPTY_TILES, MAX_PLAYERS, PLAYER_COLORS, TILE } from '../core/constants';
import { isCrossLow } from '../core/autoCall';
import { torchRadiusPx } from '../core/light';
import { CALL_EPSILON_MS, hasAutoCall } from '../core/players';
import type { PlayerId, PlayerState, RoomDef, Vec2 } from '../core/types';
import { mapZone } from './mapZone';
import type { ScreenRect, SplitLayout, Viewport } from './splitscreen';

// ───────────────────────────── Constantes : découverte ─────────────────────────────

/**
 * Demi-largeur (tuiles) de la zone découverte autour d'un héros (salle éclairée). La vue la plus étroite du jeu (4 joueurs,
 * zoom 2 : 638 / 2 px = ~20 tuiles de large, ~11 de haut) est celle d'un quadrant : « environ la moitié de la vue de chaque
 * côté du héros » = ce que le héros VOIT sûrement. Un rectangle (et non un disque) : c'est la forme de la caméra.
 */
export const MAP_REVEAL_HALF_W_TILES = 10;
/** Demi-hauteur (tuiles) de la zone découverte (la vue d'un quadrant fait ~11,2 tuiles de haut : demi-vue = 5,6, arrondie à 6). */
export const MAP_REVEAL_HALF_H_TILES = 6;

/** Classes de tuile de la carte (valeurs de `MapMemory.tiles`). */
export const MAP_TILE = {
  /** Hors salle (' ') : jamais dessinée. */
  void: 0,
  /** Sol praticable ('.', ','). */
  floor: 1,
  /** Mur ou pilier qui borde une zone praticable : tracé clair, c'est le « trait » du plan. */
  edge: 2,
  /** Masse de mur sans voisin praticable : à peine visible. */
  solid: 3,
  /** Fosse ('~'). */
  pit: 4,
} as const;
export type MapTileClass = (typeof MAP_TILE)[keyof typeof MAP_TILE];

// ───────────────────────────── Constantes : placement ─────────────────────────────

/** Marge (px, écran logique 1280 de large ; mise à l'échelle des autres tailles d'écran) entre la carte et le bord de son panneau. */
export const MAP_PAD_PX = 3;
/** Échelle maximale (px par tuile) quand la carte occupe la zone centrale partagée (2 à 4 joueurs). */
export const MAP_SCALE_MAX_SHARED = 3;
/** Échelle maximale (px par tuile) à 1 vue : plus petite, la carte ne doit pas gêner le jeu plein écran. */
export const MAP_SCALE_MAX_SINGLE = 2;
/** Boîte de la carte à 1 vue : part de la largeur / de la hauteur de l'écran (192 x 158 px à 1280 x 720). */
export const MAP_SINGLE_W_RATIO = 0.15;
export const MAP_SINGLE_H_RATIO = 0.22;
/** Marge (part de la largeur de l'écran) entre la carte à 1 vue et le bord droit de l'écran. */
export const MAP_SINGLE_MARGIN_RATIO = 0.008;
/** Marge (px écran) autour du héros dans le test de recouvrement : on estompe un peu avant le contact. */
export const MAP_HERO_AVOID_MARGIN_PX = 14;

// ───────────────────────────── Constantes : pions ─────────────────────────────

/** Période (ms) du clignotement d'un héros qui appelle : 2 Hz, lent et non agressif (sous le seuil des 3 Hz des clignotements gênants). */
export const MARKER_BLINK_PERIOD_MS = 500;
/** Opacité du point d'un héros à terre (atténué : la croix rouge porte l'information). */
export const MARKER_DOWN_DOT_ALPHA = 0.4;
/** Opacité minimale du point d'un héros qui appelle (il pulse entre cette valeur et 1). */
export const MARKER_CALL_MIN_ALPHA = 0.35;
/** Rayon (px écran) du point d'un héros (à l'échelle de carte >= 3 px par tuile ; voir `markerSizeFactor`). */
export const MARKER_DOT_RADIUS = 4;
/** Rayon de base (px écran) de l'anneau de l'appel ; il grossit de `MARKER_RING_GROWTH` au maximum de la pulsation. */
export const MARKER_RING_RADIUS = 7;
export const MARKER_RING_GROWTH = 0.9;
/** Demi-côté (px écran) de la croix médicale et de la croix « à terre » (formes nettement plus grandes que le point : lisibles à petite taille). */
export const MARKER_HEAL_HALF = 5;
export const MARKER_DOWN_HALF = 6;
/** Épaisseur (px écran) des bras de la croix médicale (rouge) et du trait rouge de la croix « à terre » ; leur contour sombre fait 2 px de plus. */
export const MARKER_HEAL_ARM = 3;
export const MARKER_DOWN_LINE = 4;
/** Décalage (px écran) de la croix médicale par rapport au point (en haut à droite : le point reste visible). */
export const MARKER_HEAL_OFFSET = 7;
/** Échelle de carte (px par tuile) en dessous de laquelle les pions grossissent (carte à 1 vue : 2 px par tuile au plus ; salle immense : moins). */
export const MARKER_SMALL_MAP_SCALE = 3;
/** Facteur de taille des pions sur une carte à moins de `MARKER_SMALL_MAP_SCALE` px par tuile (ils restent lisibles quand la carte, donc l'écran, est petit). */
export const MARKER_SMALL_MAP_FACTOR = 1.3;

// ───────────────────────────── Mémoire de découverte ─────────────────────────────

/** Mémoire de découverte de la salle courante (côté rendu uniquement). */
export interface MapMemory {
  roomId: string;
  /** Colonnes / lignes de la grille de la salle. */
  cols: number;
  rows: number;
  /** Classe (`MAP_TILE`) de chaque tuile, rangée ligne par ligne (calculée une fois par salle). */
  tiles: Uint8Array;
  /** 1 = tuile découverte (ensemble qui ne fait que croître jusqu'à la remise à zéro). */
  known: Uint8Array;
  /** Nombre de tuiles découvertes. */
  knownCount: number;
  /** Compteur incrémenté à chaque changement (découverte ou remise à zéro) : le dessin ne se refait que s'il change. */
  revision: number;
  /** Dernier temps écoulé dans la salle (ms) vu : s'il RECULE, la salle a redémarré. */
  lastElapsedMs: number;
  /** Signature par joueur (3 entiers : tuile x, tuile y, rayon de lumière) de la dernière révélation : évite de refaire le même calcul. */
  sig: Int32Array;
}

const SIG_NONE = -2147483648;

/** Dimensions (colonnes, lignes) de la grille d'une salle (lignes de longueurs inégales : la plus longue fait foi). */
export function roomGridSize(room: Pick<RoomDef, 'layout'>): { cols: number; rows: number } {
  let cols = 0;
  for (const row of room.layout) cols = Math.max(cols, row.length);
  return { cols, rows: room.layout.length };
}

function isPassableGlyph(g: string): boolean {
  return g === '.' || g === ',';
}

/** Classe de chaque tuile : sol, mur de contour (voisin praticable, diagonales comprises), masse pleine, fosse, vide. */
function classifyTiles(room: Pick<RoomDef, 'layout'>, cols: number, rows: number): Uint8Array {
  const out = new Uint8Array(cols * rows);
  const glyph = (x: number, y: number): string => (x < 0 || y < 0 || y >= rows ? ' ' : (room.layout[y][x] ?? ' '));
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const g = glyph(x, y);
      let c: MapTileClass = MAP_TILE.void;
      if (isPassableGlyph(g)) c = MAP_TILE.floor;
      else if (g === '~') c = MAP_TILE.pit;
      else if (g === '#' || g === 'o') {
        c = MAP_TILE.solid;
        for (let dy = -1; dy <= 1 && c === MAP_TILE.solid; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const n = glyph(x + dx, y + dy);
            if (isPassableGlyph(n) || n === '~') {
              c = MAP_TILE.edge;
              break;
            }
          }
        }
      }
      out[y * cols + x] = c;
    }
  }
  return out;
}

/** Mémoire vide pour une salle (aucune tuile découverte). */
export function createMapMemory(room: Pick<RoomDef, 'id' | 'layout'>): MapMemory {
  const { cols, rows } = roomGridSize(room);
  return {
    roomId: room.id,
    cols,
    rows,
    tiles: classifyTiles(room, cols, rows),
    known: new Uint8Array(cols * rows),
    knownCount: 0,
    revision: 0,
    lastElapsedMs: 0,
    sig: new Int32Array(MAX_PLAYERS * 3).fill(SIG_NONE),
  };
}

/** Remet la mémoire à zéro pour `room` (même objet : l'identité reste stable ; la révision avance). */
export function resetMapMemory(memory: MapMemory, room: Pick<RoomDef, 'id' | 'layout'>): void {
  const { cols, rows } = roomGridSize(room);
  const rev = memory.revision + 1;
  memory.roomId = room.id;
  memory.cols = cols;
  memory.rows = rows;
  memory.tiles = classifyTiles(room, cols, rows);
  memory.known = new Uint8Array(cols * rows);
  memory.knownCount = 0;
  memory.revision = rev;
  memory.lastElapsedMs = 0;
  memory.sig.fill(SIG_NONE);
}

/** La tuile (tx, ty) est-elle découverte ? (hors grille : non) */
export function isTileKnown(memory: MapMemory, tx: number, ty: number): boolean {
  if (tx < 0 || ty < 0 || tx >= memory.cols || ty >= memory.rows) return false;
  return memory.known[ty * memory.cols + tx] === 1;
}

/** Marque comme découvertes les tuiles du rectangle [x0..x1] x [y0..y1] (borné à la grille). Renvoie vrai si une tuile est nouvelle. */
function revealRect(m: MapMemory, x0: number, y0: number, x1: number, y1: number): boolean {
  let changed = false;
  const ya = Math.max(0, y0);
  const yb = Math.min(m.rows - 1, y1);
  const xa = Math.max(0, x0);
  const xb = Math.min(m.cols - 1, x1);
  for (let y = ya; y <= yb; y++) {
    const base = y * m.cols;
    for (let x = xa; x <= xb; x++) {
      if (m.known[base + x] === 0) {
        m.known[base + x] = 1;
        m.knownCount++;
        changed = true;
      }
    }
  }
  return changed;
}

/** Marque comme découvertes les tuiles du disque de centre (cx, cy) et de rayon `r` tuiles. */
function revealDisc(m: MapMemory, cx: number, cy: number, r: number): boolean {
  let changed = false;
  const ri = Math.ceil(r);
  const r2 = r * r;
  for (let y = Math.max(0, cy - ri); y <= Math.min(m.rows - 1, cy + ri); y++) {
    const base = y * m.cols;
    for (let x = Math.max(0, cx - ri); x <= Math.min(m.cols - 1, cx + ri); x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2 && m.known[base + x] === 0) {
        m.known[base + x] = 1;
        m.knownCount++;
        changed = true;
      }
    }
  }
  return changed;
}

/**
 * Rayon (tuiles) de la lumière d'un héros dans une salle sombre : celui de sa torche (`torchRadiusPx`), plafonné à la lueur minimale
 * s'il est à terre (comme `lightSources`, core/light.ts). Pas de rayon de lumière hors salle sombre : voir `MAP_REVEAL_*`.
 */
export function heroLightRadiusTiles(p: Pick<PlayerState, 'torchMs' | 'status'>): number {
  const r = torchRadiusPx(p.torchMs) / TILE;
  return p.status === 'down' ? Math.min(r, LIGHT_EMPTY_TILES) : r;
}

/** Résultat de `updateMapMemory`. */
export interface MapMemoryUpdate {
  /** De nouvelles tuiles ont été découvertes (ou la mémoire a été remise à zéro) : le dessin doit être refait. */
  changed: boolean;
  /** La mémoire vient d'être remise à zéro (changement de salle ou salle redémarrée). */
  reset: boolean;
}

const UPDATE_RESULT: MapMemoryUpdate = { changed: false, reset: false };

/**
 * Met à jour la découverte (MUTE `memory`) : union, dans le temps, de la zone vue autour de CHAQUE héros — vivant ou à terre (un
 * héros à terre a vu ce qu'il a vu avant, et sa position reste connue). Salle claire : rectangle `MAP_REVEAL_HALF_*` ; salle sombre
 * (`room.dark`) : disque du rayon de lumière de sa torche. Remise à zéro si l'id de salle change ou si `elapsedMs` recule.
 *
 * Aucune allocation : l'objet renvoyé est PARTAGÉ (à lire tout de suite, ne pas le conserver).
 */
export function updateMapMemory(
  memory: MapMemory,
  room: Pick<RoomDef, 'id' | 'layout' | 'dark'>,
  players: readonly Pick<PlayerState, 'id' | 'pos' | 'status' | 'torchMs'>[],
  elapsedMs: number,
): MapMemoryUpdate {
  let reset = false;
  const elapsed = Number.isFinite(elapsedMs) ? elapsedMs : 0;
  if (memory.roomId !== room.id || elapsed < memory.lastElapsedMs) {
    resetMapMemory(memory, room);
    reset = true;
  }
  memory.lastElapsedMs = elapsed;
  let changed = reset;
  const dark = room.dark === true;
  for (let i = 0; i < players.length && i < MAX_PLAYERS; i++) {
    const p = players[i];
    if (!Number.isFinite(p.pos.x) || !Number.isFinite(p.pos.y)) continue;
    const tx = Math.floor(p.pos.x / TILE);
    const ty = Math.floor(p.pos.y / TILE);
    const radius = dark ? heroLightRadiusTiles(p) : 0;
    const rk = Math.round(radius * 2);
    const s = i * 3;
    if (memory.sig[s] === tx && memory.sig[s + 1] === ty && memory.sig[s + 2] === rk) continue;
    memory.sig[s] = tx;
    memory.sig[s + 1] = ty;
    memory.sig[s + 2] = rk;
    const grew = dark
      ? revealDisc(memory, tx, ty, Math.max(0.5, radius))
      : revealRect(memory, tx - MAP_REVEAL_HALF_W_TILES, ty - MAP_REVEAL_HALF_H_TILES, tx + MAP_REVEAL_HALF_W_TILES, ty + MAP_REVEAL_HALF_H_TILES);
    if (grew) changed = true;
  }
  if (changed) memory.revision++;
  UPDATE_RESULT.changed = changed;
  UPDATE_RESULT.reset = reset;
  return UPDATE_RESULT;
}

// ───────────────────────────── Pions ─────────────────────────────

/** Pion d'un héros sur la carte. */
export interface MapMarker {
  id: PlayerId;
  /** Position monde (px) du héros ; à terre : l'endroit où il est tombé. */
  x: number;
  y: number;
  /** Couleur du joueur (`PLAYER_COLORS`). */
  color: number;
  /** À terre : croix rouge (✕) à son emplacement, point atténué. Prioritaire sur tout le reste. */
  down: boolean;
  /** À soigner (vivant) : croix médicale à côté du point. */
  heal: boolean;
  /** En appel (manuel ou automatique) : le point clignote. Cumulable avec `heal`. */
  calling: boolean;
}

/** Appel en cours : appel manuel (`callMs` > 0) OU appel automatique d'objet / croix (`autoCall`). */
export function isCalling(p: Pick<PlayerState, 'status' | 'callMs' | 'autoCall'>): boolean {
  if (p.status !== 'alive') return false;
  return (Number.isFinite(p.callMs) && p.callMs > CALL_EPSILON_MS) || hasAutoCall(p);
}

/**
 * Héros à soigner : vivant ET (la croix rouge est partie pour lui — `autoCallCross` présent — OU ses PV sont à
 * `CROSS_CALL_THRESHOLD` ou moins : mêmes règles que `autoCall.ts`, aucune valeur dupliquée).
 */
export function needsHealing(p: Pick<PlayerState, 'status' | 'hp' | 'maxHp' | 'autoCallCross'>): boolean {
  if (p.status !== 'alive') return false;
  return p.autoCallCross !== undefined || isCrossLow(p);
}

/**
 * Pions des joueurs PRÉSENTS (un par entrée de `players`, dans l'ordre). `out` est réutilisé et tronqué à la bonne longueur (aucune
 * allocation par frame une fois la liste créée) ; sans `out`, un nouveau tableau est renvoyé.
 */
export function computeMarkers(players: readonly PlayerState[], out: MapMarker[] = []): MapMarker[] {
  const n = Math.min(players.length, MAX_PLAYERS);
  for (let i = 0; i < n; i++) {
    const p = players[i];
    const down = p.status === 'down';
    let m = out[i];
    if (!m) {
      m = { id: p.id, x: 0, y: 0, color: 0, down: false, heal: false, calling: false };
      out[i] = m;
    }
    m.id = p.id;
    m.x = p.pos.x;
    m.y = p.pos.y;
    m.color = PLAYER_COLORS[p.id] ?? 0xffffff;
    m.down = down;
    m.heal = !down && needsHealing(p);
    m.calling = !down && isCalling(p);
  }
  out.length = n;
  return out;
}

/** Aspect d'un pion à un instant donné (sortie de `markerVisual`, réutilisable). */
export interface MarkerVisual {
  /** Opacité du point (0..1). */
  dotAlpha: number;
  /** Anneau de l'appel visible ? */
  ringVisible: boolean;
  /** Opacité et échelle (>= 1) de l'anneau de l'appel. */
  ringAlpha: number;
  ringScale: number;
  /** Croix médicale visible ? */
  healCross: boolean;
  /** Croix rouge « à terre » visible ? */
  downCross: boolean;
}

/** Impulsion 0..1 (sinusoïdale, période `MARKER_BLINK_PERIOD_MS`) : dépend UNIQUEMENT du temps, jamais du nombre d'images par seconde. */
export function blinkPulse(timeMs: number): number {
  if (!Number.isFinite(timeMs)) return 1;
  return 0.5 + 0.5 * Math.sin((2 * Math.PI * timeMs) / MARKER_BLINK_PERIOD_MS);
}

/**
 * Aspect d'un pion. Priorité : à terre > à soigner > appel. À terre : point atténué + croix rouge, rien d'autre. Vivant : appel =
 * point qui pulse + anneau qui grossit ; à soigner = croix médicale (cumulable avec l'appel). Écrit dans `out` (renvoyé).
 */
export function markerVisual(m: Pick<MapMarker, 'down' | 'heal' | 'calling'>, timeMs: number, out: MarkerVisual): MarkerVisual {
  if (m.down) {
    out.dotAlpha = MARKER_DOWN_DOT_ALPHA;
    out.ringVisible = false;
    out.ringAlpha = 0;
    out.ringScale = 1;
    out.healCross = false;
    out.downCross = true;
    return out;
  }
  const pulse = m.calling ? blinkPulse(timeMs) : 1;
  out.dotAlpha = m.calling ? MARKER_CALL_MIN_ALPHA + (1 - MARKER_CALL_MIN_ALPHA) * pulse : 1;
  out.ringVisible = m.calling;
  out.ringAlpha = m.calling ? 1 - pulse * 0.75 : 0;
  out.ringScale = m.calling ? 1 + MARKER_RING_GROWTH * pulse : 1;
  out.healCross = m.heal;
  out.downCross = false;
  return out;
}

/** Rang de priorité d'affichage d'un pion : 3 = à terre, 2 = à soigner, 1 = appel, 0 = normal (priorité : à terre > à soigner > appel). */
export function markerPriority(m: Pick<MapMarker, 'down' | 'heal' | 'calling'>): 0 | 1 | 2 | 3 {
  if (m.down) return 3;
  if (m.heal) return 2;
  return m.calling ? 1 : 0;
}

/**
 * Profondeur d'un point : `base` + un décalage qui croît avec la priorité (le point d'un héros à terre / à soigner / qui appelle passe au-dessus de celui d'un héros normal quand
 * ils se superposent), puis avec l'identifiant (ordre stable entre pions de même priorité). Reste dans `[base, base + 0.1)` : sous les croix (`base + 0.2`).
 */
export function markerDotDepth(base: number, m: Pick<MapMarker, 'id' | 'down' | 'heal' | 'calling'>): number {
  return base + markerPriority(m) * 0.02 + m.id * 0.002;
}

/** Facteur de taille des pions selon l'échelle de la carte (px par tuile) : 1 à partir de `MARKER_SMALL_MAP_SCALE`, `MARKER_SMALL_MAP_FACTOR` en dessous. */
export function markerSizeFactor(mapScale: number): number {
  return mapScale >= MARKER_SMALL_MAP_SCALE ? 1 : MARKER_SMALL_MAP_FACTOR;
}

/** Aspect neutre (valeur initiale d'un `MarkerVisual` réutilisable). */
export function createMarkerVisual(): MarkerVisual {
  return { dotAlpha: 1, ringVisible: false, ringAlpha: 0, ringScale: 1, healCross: false, downCross: false };
}

// ───────────────────────────── Placement ─────────────────────────────

/**
 * Boîte (px écran) où la carte, panneau compris, doit tenir. 2 à 4 joueurs : la zone réservée au centre (`mapZone.ts`). 1 joueur /
 * vue réseau invité (`playerCount` 1) : boîte plus petite sur le bord droit, centrée verticalement.
 */
export function mapBoxFor(layout: SplitLayout, width: number = GAME_WIDTH, height: number = GAME_HEIGHT): ScreenRect {
  const zone = mapZone(layout, width, height);
  if (zone) return zone;
  const w = Math.round(width * MAP_SINGLE_W_RATIO);
  const h = Math.round(height * MAP_SINGLE_H_RATIO);
  const margin = Math.max(1, Math.round(width * MAP_SINGLE_MARGIN_RATIO));
  return { x: width - margin - w, y: Math.round((height - h) / 2), w, h };
}

/** Placement de la carte : échelle, rectangle des tuiles et rectangle du panneau (tuiles + marge). */
export interface MapPlacement {
  /** Boîte d'origine. */
  box: ScreenRect;
  /** Pixels d'écran par tuile : ENTIER >= 1 dès que la salle tient à cette taille (fraction < 1 seulement pour une salle démesurée). */
  scale: number;
  /** Marge (px) entre les tuiles et le bord du panneau. */
  pad: number;
  /** Rectangle des tuiles (cols x scale, rows x scale). */
  map: ScreenRect;
  /** Panneau : `map` élargi de `pad` ; toujours inclus dans `box`. */
  panel: ScreenRect;
}

/** Marge du panneau pour un écran de largeur `width` (3 px à 1280, au moins 1). */
export function mapPadFor(width: number = GAME_WIDTH): number {
  return Math.max(1, Math.round((MAP_PAD_PX * width) / GAME_WIDTH));
}

/**
 * Échelle (px par tuile) et placement d'une salle de `cols` x `rows` tuiles dans `box` : le plus grand entier <= `maxScale` qui tient
 * (marge comprise), centré dans la boîte (`align: 'right'` : collé au bord droit de la boîte). Si même 1 px par tuile ne tient pas
 * (salle démesurée, boîte minuscule), l'échelle devient fractionnaire : la carte tient TOUJOURS, jamais de taille nulle ou négative.
 */
export function placeMap(
  cols: number,
  rows: number,
  box: ScreenRect,
  pad: number,
  maxScale: number = MAP_SCALE_MAX_SHARED,
  align: 'center' | 'right' = 'center',
): MapPlacement {
  const c = Math.max(1, Math.floor(Number.isFinite(cols) ? cols : 1));
  const r = Math.max(1, Math.floor(Number.isFinite(rows) ? rows : 1));
  const p = Math.max(0, Math.min(pad, Math.floor((Math.min(box.w, box.h) - 2) / 2)));
  const availW = Math.max(1, box.w - 2 * p);
  const availH = Math.max(1, box.h - 2 * p);
  const fit = Math.min(availW / c, availH / r);
  const scale = Math.max(0.01, fit >= 1 ? Math.min(Math.floor(fit), Math.max(1, Math.floor(maxScale))) : fit);
  const mw = c * scale;
  const mh = r * scale;
  const pw = mw + 2 * p;
  const ph = mh + 2 * p;
  const px = align === 'right' ? box.x + box.w - pw : box.x + (box.w - pw) / 2;
  const py = box.y + (box.h - ph) / 2;
  // Arrondi au pixel d'écran vers l'intérieur de la boîte (les bords restent dans la boîte).
  const panelX = Math.max(box.x, Math.min(Math.round(px), box.x + box.w - pw));
  const panelY = Math.max(box.y, Math.min(Math.round(py), box.y + box.h - ph));
  return {
    box,
    scale,
    pad: p,
    map: { x: panelX + p, y: panelY + p, w: mw, h: mh },
    panel: { x: panelX, y: panelY, w: pw, h: ph },
  };
}

/** Placement complet pour une disposition et une salle de `cols` x `rows` tuiles (boîte, marge, échelle maximale et alignement selon le nombre de vues). */
export function mapPlacement(layout: SplitLayout, cols: number, rows: number, width: number = GAME_WIDTH, height: number = GAME_HEIGHT): MapPlacement {
  const box = mapBoxFor(layout, width, height);
  const single = layout.playerCount < 2;
  return placeMap(cols, rows, box, mapPadFor(width), single ? MAP_SCALE_MAX_SINGLE : MAP_SCALE_MAX_SHARED, single ? 'right' : 'center');
}

/** Pixel d'écran de la position monde (px) `(wx, wy)` sur la carte, borné au rectangle des tuiles. Écrit dans `out`. */
export function worldToMapPx(placement: MapPlacement, wx: number, wy: number, out: { x: number; y: number }): { x: number; y: number } {
  const { map, scale } = placement;
  const x = map.x + (wx / TILE) * scale;
  const y = map.y + (wy / TILE) * scale;
  out.x = Math.max(map.x, Math.min(map.x + map.w, Number.isFinite(x) ? x : map.x));
  out.y = Math.max(map.y, Math.min(map.y + map.h, Number.isFinite(y) ? y : map.y));
  return out;
}

/**
 * La carte passerait-elle sous le héros ? Vrai si le sprite du héros (une tuile de côté à l'échelle de la caméra, plus `margin` px)
 * recouvre le panneau. `heroScreenX/Y` : position du héros à l'écran. (Toutes les vues : `heroesUnderMap`.)
 */
export function heroUnderMap(panel: ScreenRect, heroScreenX: number, heroScreenY: number, zoom: number, margin: number = MAP_HERO_AVOID_MARGIN_PX): boolean {
  if (!Number.isFinite(heroScreenX) || !Number.isFinite(heroScreenY)) return false;
  const half = (TILE * Math.max(1, zoom)) / 2 + margin;
  return heroScreenX + half > panel.x && heroScreenX - half < panel.x + panel.w && heroScreenY + half > panel.y && heroScreenY - half < panel.y + panel.h;
}

/**
 * Un héros (vivant ou à terre) passerait-il sous le panneau dans UNE des vues ? Pour chaque vue `v` (`centerOf(v)` = centre monde de sa caméra), la position écran de chaque héros
 * est celle de la caméra de cette vue ; un héros hors du rectangle de la vue n'y est pas dessiné et ne compte pas. Une vue unique (1 joueur, invité réseau) = une seule boucle : même
 * résultat que `heroUnderMap` sur chaque héros. Aucune allocation (appelé à chaque frame).
 */
export function heroesUnderMap(
  viewports: readonly Viewport[],
  panel: ScreenRect,
  heroes: readonly { readonly pos: Vec2 }[],
  centerOf: (viewIndex: number) => Vec2,
  margin: number = MAP_HERO_AVOID_MARGIN_PX,
): boolean {
  for (let v = 0; v < viewports.length; v++) {
    const vp = viewports[v];
    const c = centerOf(v);
    for (let i = 0; i < heroes.length; i++) {
      const pos = heroes[i].pos;
      const sx = vp.x + vp.w / 2 + (pos.x - c.x) * vp.zoom;
      const sy = vp.y + vp.h / 2 + (pos.y - c.y) * vp.zoom;
      if (sx < vp.x || sx > vp.x + vp.w || sy < vp.y || sy > vp.y + vp.h) continue; // hors de cette vue : n'y est pas dessiné
      if (heroUnderMap(panel, sx, sy, vp.zoom, margin)) return true;
    }
  }
  return false;
}

// ───────────────────────────── Préférence (touche Tab) ─────────────────────────────

/** Clé `localStorage` de l'état visible / masqué de la carte. */
export const MAP_VISIBLE_STORAGE_KEY = 'vaelorn.minimap';

/** Accès (minimal) au stockage : `localStorage` en jeu, un faux objet dans les tests. */
export interface MapStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): MapStorage | null {
  try {
    return (globalThis as { localStorage?: MapStorage }).localStorage ?? null;
  } catch {
    return null;
  }
}

/** Carte visible ? Défaut : OUI (aucun stockage, valeur inconnue ou accès refusé : visible). */
export function loadMapVisible(storage: MapStorage | null = defaultStorage()): boolean {
  try {
    return storage?.getItem(MAP_VISIBLE_STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

/** Mémorise visible / masquée ; sans effet (et sans erreur) si le stockage est indisponible. */
export function saveMapVisible(visible: boolean, storage: MapStorage | null = defaultStorage()): void {
  try {
    storage?.setItem(MAP_VISIBLE_STORAGE_KEY, visible ? '1' : '0');
  } catch {
    /* stockage indisponible : le choix vaut pour cette session seulement */
  }
}

/** Clé i18n du toast de bascule (touche Tab) selon le nouvel état. */
export function mapToggleMessageKey(visible: boolean): 'map.shown' | 'map.hidden' {
  return visible ? 'map.shown' : 'map.hidden';
}
