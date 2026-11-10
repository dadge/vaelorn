/**
 * Partenaire SCRIPTÉ du tutoriel : mini machine virtuelle PURE (état JSON dans `VmState`) qui produit une `ActionFrame` par pas
 * de simulation pour le joueur 1. Il se déplace en ligne droite (les cibles du niveau sont alignées sur la rangée 6, voir
 * `levels/tutorial.ts`), avec un détour perpendiculaire de déblocage si une collision l'immobilise.
 *
 * Règles de sûreté :
 *  - il N'ATTAQUE JAMAIS (ni attaque, ni spécial) : il ne tue rien et ne risque pas de provoquer de relevage involontaire ;
 *  - les impulsions (`press`, appel) durent UN pas puis sont relâchées : la simulation détecte les fronts montants ;
 *  - `callEvery` respecte le délai de récupération de l'appel (≥ 5200 ms > CALL_COOLDOWN_MS) : aucun appel n'est perdu ;
 *  - tout est déterministe : aucune horloge, aucun aléa ; seul `dtMs` (pas de simulation) fait avancer les minuteurs.
 */
import { TILE } from '../core/constants';
import { tileCenterPx } from '../core/mechanisms';
import type { ActionFrame, GameState, LevelDef, MechanismDef, RoomDef, Vec2 } from '../core/types';
import { HUMAN_ID, PARTNER_ID } from './conditions';
import type { Condition, PartnerOp, Target, VmState } from './types';

/** Rayon d'arrivée (px) selon la cible. */
export const ARRIVE_TILE_PX = 3;
export const ARRIVE_MECH_PX = 6;
export const ARRIVE_EXIT_PX = 6;
/** Distance à laquelle le partenaire relève le joueur à terre (REVIVE_RANGE = 22 px). */
export const ARRIVE_HUMAN_REVIVE_PX = 12;
export const ARRIVE_HUMAN_PX = 28;
/** Durée (ms) d'immobilité qui déclenche un détour, et durée du détour. */
export const STUCK_AFTER_MS = 1500;
export const DETOUR_MS = 800;

export function newVm(): VmState {
  return { prog: [{ op: 'idle' }], pc: 0, gap: false, callCdMs: 0, stuckMs: 0, detourMs: 0, detourSign: 1 };
}

/** Charge un nouveau programme (les minuteurs sont remis à zéro ; `callCdMs = 0` : le premier appel part tout de suite). */
export function loadProgram(vm: VmState, ops: readonly PartnerOp[]): void {
  vm.prog = ops.length > 0 ? ops.map((o) => ({ ...o })) : [{ op: 'idle' }];
  vm.pc = 0;
  vm.gap = false;
  vm.callCdMs = 0;
  vm.stuckMs = 0;
  vm.detourMs = 0;
}

/** Frame vide (aucune entrée). */
export function emptyPartnerFrame(): ActionFrame {
  return { moveX: 0, moveY: 0, attack: false, interact: false, revive: false, special: false, call: false, heart: false };
}

/** Centre (px) de la tuile occupée par un mécanisme (2×2 : centre du carré ; porte : tuile du milieu). */
function mechanismCenter(def: MechanismDef): Vec2 | null {
  switch (def.type) {
    case 'plate':
    case 'lever':
    case 'key':
    case 'brazier':
      return tileCenterPx(def.tile);
    case 'block':
    case 'socket':
      return { x: (def.tile[0] + 1) * TILE, y: (def.tile[1] + 1) * TILE };
    case 'door':
      return def.tiles.length > 0 ? tileCenterPx(def.tiles[Math.floor(def.tiles.length / 2)]) : null;
    default:
      return null;
  }
}

/** Position monde (px) d'une cible, ou null si elle n'existe pas dans la salle courante. */
export function resolveTarget(target: Target, room: RoomDef, state: GameState): Vec2 | null {
  if ('tile' in target) return tileCenterPx(target.tile);
  if ('mech' in target) {
    const def = room.mechanisms.find((m) => m.id === target.mech);
    return def ? mechanismCenter(def) : null;
  }
  if ('zone' in target) {
    const z = (room.zones ?? []).find((q) => q.id === target.zone);
    return z ? { x: (z.rect.x + z.rect.w / 2) * TILE, y: (z.rect.y + z.rect.h / 2) * TILE } : null;
  }
  if ('spawn' in target) {
    const s = room.playerSpawns[target.spawn];
    return s ? tileCenterPx(s) : null;
  }
  if ('exit' in target) {
    const r = room.exit.rect;
    return { x: (r.x + r.w / 2) * TILE, y: (r.y + r.h / 2) * TILE };
  }
  if ('pickup' in target) {
    const me = state.players[PARTNER_ID];
    let best: Vec2 | null = null;
    let bestD = Infinity;
    for (const pk of state.room.pickups ?? []) {
      const d = me ? Math.hypot(pk.pos.x - me.pos.x, pk.pos.y - me.pos.y) : 0;
      if (d < bestD) {
        bestD = d;
        best = { x: pk.pos.x, y: pk.pos.y };
      }
    }
    return best;
  }
  return state.players[HUMAN_ID]?.pos ?? null;
}

/** Rayon d'arrivée (px) pour une cible. */
export function arrivalRadius(target: Target): number {
  if ('tile' in target || 'spawn' in target || 'pickup' in target) return ARRIVE_TILE_PX;
  if ('exit' in target) return ARRIVE_EXIT_PX;
  if ('human' in target) return ARRIVE_HUMAN_PX;
  return ARRIVE_MECH_PX;
}

/** Environnement d'un pas de la machine virtuelle. */
export interface VmEnv {
  dtMs: number;
  state: GameState;
  room: RoomDef;
  level: LevelDef;
  /** Évalue une condition (`until`) dans le contexte courant. */
  evalCond: (c: Condition) => boolean;
}

interface Move {
  arrived: boolean;
  moveX: number;
  moveY: number;
}

/** Avance vers `to` : renvoie le vecteur de déplacement (norme 1) ou « arrivé ». Gère le déblocage (détour perpendiculaire). */
function moveToward(vm: VmState, from: Vec2, moving: boolean, to: Vec2 | null, radius: number, dtMs: number): Move {
  if (!to) return { arrived: true, moveX: 0, moveY: 0 };
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const d = Math.hypot(dx, dy);
  if (d <= radius) {
    vm.stuckMs = 0;
    vm.detourMs = 0;
    return { arrived: true, moveX: 0, moveY: 0 };
  }
  let ux = dx / d;
  let uy = dy / d;
  // Immobile alors qu'il veut avancer ? (collision) → après STUCK_AFTER_MS, un court détour perpendiculaire.
  if (moving) vm.stuckMs = 0;
  else vm.stuckMs += dtMs;
  if (vm.stuckMs >= STUCK_AFTER_MS) {
    vm.stuckMs = 0;
    vm.detourMs = DETOUR_MS;
    vm.detourSign = vm.detourSign === 1 ? -1 : 1;
  }
  if (vm.detourMs > 0) {
    vm.detourMs -= dtMs;
    const px = -uy * vm.detourSign;
    const py = ux * vm.detourSign;
    const mx = px * 0.85 + ux * 0.15;
    const my = py * 0.85 + uy * 0.15;
    const n = Math.hypot(mx, my) || 1;
    ux = mx / n;
    uy = my / n;
  }
  return { arrived: false, moveX: ux, moveY: uy };
}

/**
 * Un pas de la machine virtuelle : retourne la frame du partenaire. `override` remplace l'instruction courante SANS faire avancer
 * le compteur (interruption : relever le joueur tombé). Un partenaire à terre ne produit aucune entrée.
 */
export function stepVm(vm: VmState, env: VmEnv, override?: PartnerOp): ActionFrame {
  const frame = emptyPartnerFrame();
  const { state, room, dtMs } = env;
  const me = state.players[PARTNER_ID];
  vm.callCdMs = Math.max(0, vm.callCdMs - dtMs);
  if (!me || me.status !== 'alive') return frame;
  if (vm.gap) {
    vm.gap = false;
    return frame;
  }
  const op = override ?? vm.prog[vm.pc];
  if (!op) return frame;
  const advance = (): void => {
    if (!override) vm.pc += 1;
  };

  switch (op.op) {
    case 'idle':
      if (op.until && env.evalCond(op.until)) advance();
      return frame;
    case 'walk': {
      const mv = moveToward(vm, me.pos, me.moving, resolveTarget(op.at, room, state), arrivalRadius(op.at), dtMs);
      if (mv.arrived) {
        advance();
        return frame;
      }
      frame.moveX = mv.moveX;
      frame.moveY = mv.moveY;
      return frame;
    }
    case 'stand': {
      // déjà satisfait (ex. étape sautée alors que la porte est ouverte) : on ne se déplace pas pour rien
      if (op.until && env.evalCond(op.until)) {
        advance();
        return frame;
      }
      const mv = moveToward(vm, me.pos, me.moving, resolveTarget(op.at, room, state), arrivalRadius(op.at), dtMs);
      if (!mv.arrived) {
        frame.moveX = mv.moveX;
        frame.moveY = mv.moveY;
        return frame;
      }
      return frame; // arrivé : on tient la position jusqu'à ce que `until` soit vraie (testée en début de cas)
    }
    case 'press':
      if (op.button === 'interact') frame.interact = true;
      else frame.call = true;
      vm.gap = true;
      advance();
      return frame;
    case 'callEvery':
      if (env.evalCond(op.until)) {
        advance();
        return frame;
      }
      if (vm.callCdMs <= 0) {
        frame.call = true;
        vm.callCdMs = Math.max(op.ms, 5200);
      }
      return frame;
    case 'reviveHuman': {
      const human = state.players[HUMAN_ID];
      if (!human || human.status === 'alive') {
        advance();
        return frame;
      }
      const mv = moveToward(vm, me.pos, me.moving, human.pos, ARRIVE_HUMAN_REVIVE_PX, dtMs);
      if (!mv.arrived) {
        frame.moveX = mv.moveX;
        frame.moveY = mv.moveY;
        return frame;
      }
      frame.revive = true; // maintenu tant que le joueur est à terre
      return frame;
    }
    case 'goExit': {
      const mv = moveToward(vm, me.pos, me.moving, resolveTarget({ exit: true }, room, state), ARRIVE_EXIT_PX, dtMs);
      if (!mv.arrived) {
        frame.moveX = mv.moveX;
        frame.moveY = mv.moveY;
      }
      return frame; // arrivé : il reste dans la zone de sortie
    }
    default:
      return frame;
  }
}
