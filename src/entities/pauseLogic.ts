/**
 * Logique PURE du menu pause (constat 4) : propriétaire de la pause et confirmation avant de quitter.
 *  - Seul le périphérique qui a ouvert la pause (Échap = 'keyboard', Start = 'gamepad:<i>') pilote le menu ;
 *    une pause sans propriétaire (déconnexion de manette) reste pilotable par tous.
 *  - « Quitter vers le menu » exige une confirmation « Oui / Non », « Non » étant sélectionné par défaut.
 */
import type { PauseChoice } from './overlay';

/** Identifiant de périphérique des menus ('keyboard' | 'gamepad:<indice>'). */
export function pauseOwnerForPad(index: number): string {
  return `gamepad:${index}`;
}

/**
 * Une intention de menu venant de `source` doit-elle être prise en compte ?
 * `owner` = null (aucun propriétaire) ⇒ toutes les sources ; sinon uniquement la source propriétaire.
 */
export function pauseIntentAllowed(owner: string | null, source: string): boolean {
  return owner === null || owner === source;
}

/**
 * Propriétaire effectif : si la manette propriétaire a disparu, la pause redevient pilotable par tous
 * (évite de bloquer la partie quand la manette qui a ouvert la pause est débranchée).
 */
export function effectivePauseOwner(owner: string | null, connectedPadIndexes: readonly number[]): string | null {
  if (owner === null || !owner.startsWith('gamepad:')) return owner;
  return connectedPadIndexes.some((i) => pauseOwnerForPad(i) === owner) ? owner : null;
}

export type PauseConfirmResult = 'resume' | 'askQuit' | 'quit' | 'cancelQuit';

/** Résultat d'un « confirmer » : `confirming` = l'écran « Quitter ? Oui / Non » est affiché ; `choice` = ligne sélectionnée. */
export function resolvePauseConfirm(confirming: boolean, choice: PauseChoice): PauseConfirmResult {
  if (!confirming) return choice === 'resume' ? 'resume' : 'askQuit';
  return choice === 'quit' ? 'quit' : 'cancelQuit';
}

/** Résultat d'un « retour » : annule la confirmation si elle est affichée, sinon reprend la partie. */
export function resolvePauseBack(confirming: boolean): 'resume' | 'cancelQuit' {
  return confirming ? 'cancelQuit' : 'resume';
}
