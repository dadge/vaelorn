/**
 * TRAITS D'APPEL des personnages (data-driven) : quels délais s'appliquent aux appels d'UN héros.
 *
 * Logique PURE et déterministe (aucun Phaser/DOM/horloge/aléatoire). Un personnage déclare des valeurs EXPLICITES dans `CharacterDef.callTraits` (`characters.ts`, constantes [B31] de `balance.ts`) ;
 * le jeu lit ces valeurs UNIQUEMENT par les fonctions ci-dessous (jamais de `characterId === 'romain'` dispersé). Le trait suit le HÉROS (le personnage choisi), pas l'indice du joueur ni son emplacement.
 *
 * Sans trait, ou pour un champ absent, la valeur est le comportement d'origine EXACT (`DEFAULT_CALL_TRAITS`) : l'état et les événements d'un héros sans trait sont identiques à ceux d'avant l'ajout.
 *
 * Trait actuel : Romain « parle beaucoup » — appel manuel et appel automatique d'objet SANS attente, croix rouge répétée toutes les 3 s.
 */
import { AUTO_CALL_COOLDOWN_MS, CROSS_CALL_REPEAT_MS } from './balance';
import { CHARACTERS } from './characters';
import { CALL_COOLDOWN_MS } from './constants';
import type { CallTraits, PlayerState } from './types';

/** Valeurs par défaut (tous les héros sans trait) : celles d'origine. */
export const DEFAULT_CALL_TRAITS: Readonly<CallTraits> = Object.freeze({
  manualCooldownMs: CALL_COOLDOWN_MS,
  autoCooldownMs: AUTO_CALL_COOLDOWN_MS,
  crossRepeatMs: CROSS_CALL_REPEAT_MS,
  crossSoftRepeat: false,
});

/** Traits résolus (défauts + surcharges du héros), mémorisés par personnage CONNU (un identifiant inconnu n'est jamais mémorisé : pas de croissance non bornée). */
const RESOLVED = new Map<string, Readonly<CallTraits>>();

/** Vide la mémoire des traits résolus (tests qui modifieraient `CHARACTERS` à chaud ; le jeu n'en a jamais besoin). */
export function resetCallTraitsCache(): void {
  RESOLVED.clear();
}

/** Une durée explicite valide : nombre fini et positif ou nul (une valeur hostile retombe sur le défaut). */
function validMs(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
}

/**
 * Traits d'appel RÉSOLUS d'un personnage (les champs absents prennent la valeur par défaut). Un identifiant inconnu (état corrompu) vaut le défaut. Ne lève jamais ; sans allocation après le 1er appel d'un personnage connu.
 * @param characterId identifiant du personnage
 */
export function callTraitsOfCharacter(characterId: PlayerState['characterId']): Readonly<CallTraits> {
  const hit = RESOLVED.get(characterId);
  if (hit) return hit;
  const def = Object.prototype.hasOwnProperty.call(CHARACTERS, characterId) ? CHARACTERS[characterId] : undefined;
  const own = def?.callTraits;
  const resolved: Readonly<CallTraits> = own
    ? Object.freeze({
        manualCooldownMs: validMs(own.manualCooldownMs, DEFAULT_CALL_TRAITS.manualCooldownMs),
        autoCooldownMs: validMs(own.autoCooldownMs, DEFAULT_CALL_TRAITS.autoCooldownMs),
        crossRepeatMs: validMs(own.crossRepeatMs, DEFAULT_CALL_TRAITS.crossRepeatMs),
        crossSoftRepeat: own.crossSoftRepeat === true,
      })
    : DEFAULT_CALL_TRAITS;
  if (def) RESOLVED.set(characterId, resolved); // identifiant inconnu (état corrompu) : valeur par défaut, non mémorisée
  return resolved;
}

/** Traits d'appel du HÉROS de ce joueur (le trait suit le personnage choisi, pas l'indice du joueur). */
export function callTraitsFor(p: Pick<PlayerState, 'characterId'>): Readonly<CallTraits> {
  return callTraitsOfCharacter(p.characterId);
}

/** Délai de récupération (ms) de l'appel MANUEL de ce joueur, posé à l'appui (`startCall`) : 5 s par défaut, 0 pour un héros qui parle beaucoup. */
export function callCooldownFor(p: Pick<PlayerState, 'characterId'>): number {
  return callTraitsFor(p).manualCooldownMs;
}

/** Délai de récupération (ms) de l'appel AUTOMATIQUE d'objet de ce joueur : 4 s par défaut, 0 (jamais armé) pour un héros qui parle beaucoup. */
export function autoCallCooldownFor(p: Pick<PlayerState, 'characterId'>): number {
  return callTraitsFor(p).autoCooldownMs;
}

/** Répétition (ms) de la croix rouge de ce joueur : 10 s par défaut, 3 s pour un héros qui parle beaucoup. */
export function crossRepeatMsFor(p: Pick<PlayerState, 'characterId'>): number {
  return callTraitsFor(p).crossRepeatMs;
}

/**
 * Fenêtre (ms) de la RÉPÉTITION douce de la croix : une croix qui repart au plus ce temps après la fin du délai de répétition est une répétition (son doux) ; au-delà (longue pause : PV remontés puis
 * retombés, aucun soigneur pendant un moment…) c'est une NOUVELLE alerte, au son complet. Deux périodes de répétition.
 */
export function crossSoftWindowMs(p: Pick<PlayerState, 'characterId'>): number {
  return 2 * crossRepeatMsFor(p);
}

/** Ce joueur n'attend JAMAIS entre deux appels d'objet (délai automatique nul) : un signal d'objet en cours peut être remplacé tout de suite par celui d'un autre objet. */
export function autoCallsWithoutWait(p: Pick<PlayerState, 'characterId'>): boolean {
  return autoCallCooldownFor(p) <= 0;
}

/** Les répétitions de la croix de ce joueur jouent-elles un son plus doux ? (voir `CallTraits.crossSoftRepeat`) */
export function crossSoftRepeatFor(p: Pick<PlayerState, 'characterId'>): boolean {
  return callTraitsFor(p).crossSoftRepeat;
}
