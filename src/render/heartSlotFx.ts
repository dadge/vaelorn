/**
 * EMPLACEMENT CŒUR — retour visuel et textuel (fonctions PURES, testées) : clé i18n du texte flottant du rangement, couleur et densité des éclats de l'utilisation. Aucune dépendance à
 * Phaser ; GameScene les applique aux événements `heartStored` / `heartUsed`.
 */
import { LOOT_FULL_HEAL } from '../core/balance';
import type { PickupKind } from '../core/types';
import { pickupTextColor } from './lifeFx';

/**
 * Clé i18n du texte flottant d'un RANGEMENT : « ♥ rangé » (cœur entier) / « ½ ♥ rangé » (demi-cœur) ; FUSION (`merged` : l'emplacement tenait un demi-cœur et passe à l'entier) : « ♥ Cœur complet »,
 * quel que soit l'objet ramassé.
 */
export function heartStoredTextKey(kind: PickupKind, merged = false): string {
  if (merged) return 'heart.merged';
  return kind === 'full' ? 'heart.stored.full' : 'heart.stored.half';
}

/** Aspect des éclats d'une UTILISATION : couleur du cœur (entier : rouge vif ; demi : rose) et nombre d'étincelles (proportionnel au soin effectif, 4..9). */
export function heartUsedFx(kind: PickupKind, amount: number): { color: number; sparkles: number } {
  const a = Number.isFinite(amount) ? Math.max(0, amount) : 0;
  return { color: pickupTextColor(kind), sparkles: Math.max(4, Math.min(9, Math.round(4 + (a / LOOT_FULL_HEAL) * 5))) };
}
