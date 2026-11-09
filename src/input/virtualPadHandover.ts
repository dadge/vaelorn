/**
 * Passage de relais entre la manette virtuelle (indice `VIRTUAL_PAD_INDEX`) et les VRAIES manettes, LOGIQUE PURE.
 *
 * Problème : en attribution explicite (écran « rejoindre »), un joueur reste lié à l'indice de manette choisi. Quand
 * l'overlay tactile se masque (une vraie manette apparaît) ou se réaffiche (la vraie manette disparaît), l'appareil du
 * joueur change sans que l'attribution suive : le joueur serait « déconnecté » en permanence (pause sans issue) alors
 * qu'un appareil utilisable est là. Ces fonctions réattribuent le joueur concerné, sans rien changer d'autre.
 *
 * Aucune règle de jeu ici ; l'InputManager (ou tout objet de même forme) est passé en paramètre.
 */
import type { PlayerId } from '../core/types';
import type { DeviceAssignment } from './actions';
import { VIRTUAL_PAD_INDEX } from './VirtualPad';

/** Ce dont on a besoin de l'InputManager (sous-ensemble, pour les tests). */
export interface HandoverTarget {
  getAssignedDevice(playerId: PlayerId): DeviceAssignment | null;
  assignDevice(playerId: PlayerId, device: DeviceAssignment | null): void;
}

const PLAYERS: readonly PlayerId[] = [0, 1, 2, 3];

function padIndexOf(target: HandoverTarget, playerId: PlayerId): number | null {
  const d = target.getAssignedDevice(playerId);
  return d && d.kind === 'gamepad' ? d.index : null;
}

/**
 * Une vraie manette est apparue (l'overlay se masque) : le joueur attribué à la manette virtuelle reprend la première
 * vraie manette connectée qu'AUCUN autre joueur n'utilise. Retourne les joueurs réattribués (vide si rien à faire).
 * @param connectedRealIndices indices (navigateur) des vraies manettes connectées
 */
export function handOverToRealPad(target: HandoverTarget, connectedRealIndices: readonly number[]): PlayerId[] {
  const owned = new Set<number>();
  for (const p of PLAYERS) {
    const idx = padIndexOf(target, p);
    if (idx !== null) owned.add(idx);
  }
  const free = [...connectedRealIndices].filter((i) => i < VIRTUAL_PAD_INDEX && !owned.has(i)).sort((a, b) => a - b);
  const moved: PlayerId[] = [];
  for (const p of PLAYERS) {
    if (padIndexOf(target, p) !== VIRTUAL_PAD_INDEX) continue;
    const next = free.shift();
    if (next === undefined) break;
    target.assignDevice(p, { kind: 'gamepad', index: next });
    moved.push(p);
  }
  return moved;
}

/**
 * L'overlay se réaffiche (la vraie manette a disparu) : le premier joueur dont la vraie manette attribuée est absente
 * reprend la manette virtuelle (un seul appareil virtuel : rien n'est fait s'il est déjà attribué).
 * Retourne les joueurs réattribués.
 * @param connectedIndices indices (navigateur) de TOUTES les manettes connectées
 */
export function handOverToVirtualPad(target: HandoverTarget, connectedIndices: readonly number[]): PlayerId[] {
  for (const p of PLAYERS) if (padIndexOf(target, p) === VIRTUAL_PAD_INDEX) return [];
  const connected = new Set(connectedIndices);
  for (const p of PLAYERS) {
    const idx = padIndexOf(target, p);
    if (idx !== null && idx < VIRTUAL_PAD_INDEX && !connected.has(idx)) {
      target.assignDevice(p, { kind: 'gamepad', index: VIRTUAL_PAD_INDEX });
      return [p];
    }
  }
  return [];
}
