/**
 * Géométrie PURE des télégraphes d'attaque ennemis (aucune dépendance Phaser) : traduit les clés `data.telegraph*`
 * renseignées par ai.ts / bosses.ts (« à l'usage du rendu ») en formes à dessiner, pour que la zone annoncée soit
 * exactement la zone qui frappera.
 *
 *  - éventail : `telegraphSpread` > 0 (rayon = `telegraphLength`, ou la portée de visée à défaut) ;
 *  - couloir  : `telegraphLength` > 0 (bond, charge, racines) de demi-largeur `telegraphRadius` (ou le rayon du corps) ;
 *  - cercle   : `telegraphRadius` > 0, centré à `telegraphDist` le long de `aimAngle` ;
 *  - ligne de visée : tireurs sans zone (archer) ;
 *  - anneau discret : attaque de boss sans zone (invocation, rugissement…).
 */
import { ENEMIES } from '../core/enemies';
import type { EnemyState } from '../core/types';

export type TelegraphShape =
  | { kind: 'circle'; x: number; y: number; r: number }
  | { kind: 'corridor'; x0: number; y0: number; x1: number; y1: number; halfWidth: number }
  | { kind: 'fan'; x: number; y: number; r: number; a0: number; a1: number }
  | { kind: 'line'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'ring'; x: number; y: number; r: number };

const AIM_MIN_LEN = 36;
const AIM_MAX_LEN = 160;
const MIN_CORRIDOR_HALF_WIDTH = 6;

function pos(v: number | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/** Formes du télégraphe d'un ennemi en 'windup', centrées sur sa position de rendu (x, y). */
export function telegraphShapes(e: EnemyState, x: number, y: number): TelegraphShape[] {
  const def = ENEMIES[e.kind];
  const d = e.data;
  const aim = typeof d.aimAngle === 'number' && Number.isFinite(d.aimAngle) ? d.aimAngle : 0;
  const radius = pos(d.telegraphRadius);
  const dist = typeof d.telegraphDist === 'number' && Number.isFinite(d.telegraphDist) ? d.telegraphDist : 0;
  const length = pos(d.telegraphLength);
  const spread = pos(d.telegraphSpread);
  const cos = Math.cos(aim);
  const sin = Math.sin(aim);
  const aimLen = Math.max(AIM_MIN_LEN, Math.min(def.attackRange, AIM_MAX_LEN));

  if (spread > 0) {
    const r = length > 0 ? length : aimLen;
    return [{ kind: 'fan', x, y, r, a0: aim - spread / 2, a1: aim + spread / 2 }];
  }
  if (length > 0) {
    const halfWidth = radius > 0 ? radius : Math.max(MIN_CORRIDOR_HALF_WIDTH, def.radius);
    return [{ kind: 'corridor', x0: x, y0: y, x1: x + cos * length, y1: y + sin * length, halfWidth }];
  }
  if (radius > 0) {
    return [{ kind: 'circle', x: x + cos * dist, y: y + sin * dist, r: radius }];
  }
  if (def.ai === 'ranged') {
    return [{ kind: 'line', x0: x, y0: y, x1: x + cos * aimLen, y1: y + sin * aimLen }];
  }
  return [{ kind: 'ring', x, y, r: def.radius + 6 }];
}
