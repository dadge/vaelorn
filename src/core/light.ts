/**
 * Lumière (salles sombres) — fonctions PURES : rayons de lumière des torches/braseros et liste des sources.
 * Utilisé par la simulation (tests, IA éventuelle) et par le rendu (src/render/darkness.ts).
 */

import {
  BRAZIER_LIGHT_TILES,
  LIGHT_EMPTY_TILES,
  LIGHT_FULL_TILES,
  LIGHT_LOW_TILES,
  TILE,
  TORCH_LOW_FRACTION,
  TORCH_MAX_MS,
} from './constants';
import type { GameState, RoomDef, Vec2 } from './types';

export type LightKind = 'torch' | 'brazier' | 'decor';

/** Source de lumière en coordonnées monde (pixels). */
export interface LightSource {
  x: number;
  y: number;
  /** Rayon en pixels. */
  radius: number;
  kind: LightKind;
  /** Joueur porteur (kind 'torch'). */
  playerId?: number;
  /** Intensité de scintillement suggérée 0..1 (0 = stable). */
  flicker?: number;
}

/** Rayon en tuiles de la lumière d'un décor 'torch' fixé au mur. */
export const DECOR_TORCH_LIGHT_TILES = 3;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.max(0, Math.min(1, t));
}

/**
 * Rayon de lumière (px) d'une torche selon son combustible (f = torchMs / TORCH_MAX_MS, borné à [0, 1]) :
 *  - f ≥ TORCH_LOW_FRACTION : LIGHT_FULL_TILES (plein) ;
 *  - de 0.8×seuil à 1×seuil : transition douce vers LIGHT_LOW_TILES ;
 *  - de 0.3×seuil à 0.8×seuil : LIGHT_LOW_TILES (faiblissante) ;
 *  - de 0 à 0.3×seuil : décroît jusqu'à LIGHT_EMPTY_TILES (torche éteinte, f = 0).
 * Continue et monotone croissante en torchMs. Valeur non finie ⇒ traitée comme 0.
 */
export function torchRadiusPx(torchMs: number): number {
  const f = Math.max(0, Math.min(1, (Number.isFinite(torchMs) ? torchMs : 0) / TORCH_MAX_MS));
  const low = TORCH_LOW_FRACTION;
  let tiles: number;
  if (f >= low) tiles = LIGHT_FULL_TILES;
  else if (f >= low * 0.8) tiles = lerp(LIGHT_LOW_TILES, LIGHT_FULL_TILES, (f - low * 0.8) / (low * 0.2));
  else if (f >= low * 0.3) tiles = LIGHT_LOW_TILES;
  else tiles = lerp(LIGHT_EMPTY_TILES, LIGHT_LOW_TILES, f / (low * 0.3));
  return tiles * TILE;
}

/** Rayon (px) d'un brasero. */
export function brazierRadiusPx(lightRadiusTiles?: number): number {
  return (lightRadiusTiles ?? BRAZIER_LIGHT_TILES) * TILE;
}

/**
 * Sources de lumière de la salle courante : torches des joueurs (à terre : faible lueur), braseros allumés ou
 * neutralisés (waived), décors 'torch'. Les décors ne comptent que dans une salle sombre.
 */
export function lightSources(state: GameState, room: RoomDef): LightSource[] {
  const out: LightSource[] = [];
  for (const p of state.players) {
    const r = torchRadiusPx(p.torchMs);
    out.push({
      x: p.pos.x,
      y: p.pos.y,
      radius: p.status === 'down' ? Math.min(r, LIGHT_EMPTY_TILES * TILE) : r,
      kind: 'torch',
      playerId: p.id,
      flicker: p.torchMs < TORCH_MAX_MS * TORCH_LOW_FRACTION ? 0.6 : 0.15,
    });
  }
  room.mechanisms.forEach((def, i) => {
    if (def.type !== 'brazier') return;
    const st = state.room.mechanisms[i];
    if (!st || st.type !== 'brazier' || !(st.active || st.waived)) return;
    out.push({
      x: def.tile[0] * TILE + TILE / 2,
      y: def.tile[1] * TILE + TILE / 2,
      radius: brazierRadiusPx(def.lightRadiusTiles),
      kind: 'brazier',
      flicker: 0.3,
    });
  });
  if (room.dark) {
    for (const d of room.decor ?? []) {
      if (d.type !== 'torch') continue;
      out.push({
        x: d.tile[0] * TILE + TILE / 2,
        y: d.tile[1] * TILE + TILE / 2,
        radius: DECOR_TORCH_LIGHT_TILES * TILE,
        kind: 'decor',
        flicker: 0.3,
      });
    }
  }
  return out;
}

/** Vrai si le point est éclairé par au moins une source. */
export function isLit(pos: Vec2, sources: readonly LightSource[]): boolean {
  for (const s of sources) {
    const dx = pos.x - s.x;
    const dy = pos.y - s.y;
    if (dx * dx + dy * dy <= s.radius * s.radius) return true;
  }
  return false;
}
