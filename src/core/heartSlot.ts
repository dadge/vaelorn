/**
 * EMPLACEMENT CŒUR — chaque joueur garde UN cœur (10 PV) ou UN demi-cœur (5 PV) dans un emplacement et l'utilise VOLONTAIREMENT (bouton B). Rien n'est jamais consommé au contact.
 *
 * Logique PURE et déterministe (aucun Phaser/DOM/horloge, AUCUN tirage de flux aléatoire). Activée par `SimConfig.heartSlot` (`GameState.heartSlot`) ; sans elle, l'ancien comportement
 * (consommation au contact, `loot.ts`) est strictement conservé (bots, calibration, démo). Constantes dans `balance.ts` ([B29] `HEART_HEAL_RADIUS`, [B10] valeurs de soin).
 *
 * ── Règles (validées) ──
 *  1. RANGER / FUSIONNER : un cœur / demi-cœur au sol touché (`PICKUP_RADIUS`) par un joueur VIVANT qui PEUT l'accepter (`canAcceptHeart` : emplacement VIDE ou contenant un DEMI-cœur) est ramassé et
 *     disparaît du sol, que le joueur soit blessé ou non (`heartCollectorFor`) :
 *       - emplacement VIDE : l'objet est rangé tel quel (demi → demi, entier → entier) ;
 *       - emplacement DEMI-cœur : FUSION, l'emplacement passe à CŒUR ENTIER (10 PV) — demi + demi = entier, demi + entier = entier (le surplus d'un demi-cœur est perdu : règle validée, `mergeHeart`) ;
 *       - emplacement ENTIER : rien n'est ramassé, l'objet reste au sol (un allié peut le prendre) et l'appel automatique part (`autoCall.ts`).
 *     Un seul objet à la fois : jamais de cumul au-delà d'un cœur entier, jamais de remplacement.
 *  2. UTILISER = bouton B (front montant), un seul effet par appui, jamais pendant le gel d'un appel manuel ni à terre ; le relevage (A) garde la priorité. Cible, par ordre de priorité
 *     (`planHeartUse`) :
 *       (a) un coéquipier VIVANT et BLESSÉ à portée de contact (`HEART_HEAL_RADIUS`, le plus proche ; égalité : premier dans l'ordre des joueurs (= ids, l'état les trie)) ET un cœur rangé → on LE SOIGNE (cœur consommé) ;
 *       (b) sinon un cristal de soin intact sous les pieds ET le joueur blessé → on utilise le CRISTAL (le cœur rangé n'est pas touché) ;
 *       (c) sinon le joueur est blessé ET a un cœur → il se soigne LUI-MÊME ;
 *       (d) sinon RIEN (aucun gaspillage : pas de cœur consommé si personne n'a besoin de soin ; retour discret `heartRefused`).
 *     Le soin est plafonné au manque (le reste est perdu) : +5 pour un demi-cœur, +10 pour un cœur entier.
 *  3. PERTE : à la chute (au combat ou scénarisée), le cœur rangé est perdu comme l'équipement MAIS tombe au sol aux pieds du joueur à terre (ramassable, sans verrou, durée de vie habituelle) ;
 *     même règle quand l'équipe est battue (emplacement strictement vide à la reprise : la salle recommence avec un sol neuf).
 */
import { HEART_HEAL_RADIUS } from './balance';
import { distSq } from './geometry';
import { healAmountFor, pickupHealValue } from './loot';
import type { PickupKind, PlayerId, PlayerState, Vec2 } from './types';

/** Valeur valide d'un emplacement ('half' | 'full') ? Sert à la lecture tolérante (sauvegarde, état ancien ou construit à la main). */
export function isHeartKind(v: unknown): v is PickupKind {
  return v === 'half' || v === 'full';
}

/** Le joueur peut-il RANGER un cœur dans un emplacement VIDE ? Vivant et emplacement vide (sans fusion : voir `canAcceptHeart`). */
export function canStoreHeart(p: Pick<PlayerState, 'status' | 'heart'>): boolean {
  return p.status === 'alive' && p.heart === undefined;
}

/** Le joueur peut-il ACCEPTER un cœur / demi-cœur au sol ? Vivant et emplacement VIDE (on range) ou contenant un DEMI-cœur (on fusionne : il passe à l'entier). Emplacement ENTIER : non. */
export function canAcceptHeart(p: Pick<PlayerState, 'status' | 'heart'>): boolean {
  return p.status === 'alive' && p.heart !== 'full';
}

/**
 * Contenu de l'emplacement après avoir accepté `incoming` : vide → `incoming` ; demi-cœur → 'full' (FUSION : demi + demi = entier, demi + entier = entier, le surplus est perdu) ; entier → null
 * (refusé : rien ne change). Pur.
 */
export function mergeHeart(current: PickupKind | undefined, incoming: PickupKind): PickupKind | null {
  if (current === 'full') return null;
  if (current === 'half') return 'full';
  return incoming;
}

/** Le joueur est-il vivant ET blessé (PV < max) ? Un seul PV manquant suffit. */
export function isWounded(p: Pick<PlayerState, 'hp' | 'maxHp' | 'status'>): boolean {
  return p.status === 'alive' && p.hp < p.maxHp;
}

/**
 * Joueur qui RANGE (ou FUSIONNE) le cœur posé en `pos` (rayon de contact `radius`) : le joueur VIVANT le plus proche dans le rayon dont l'emplacement est VIDE ou contient un DEMI-cœur (`canAcceptHeart` ;
 * égalité : premier dans l'ordre des joueurs (= ids, l'état les trie)), ou null. Blessé ou non.
 */
export function heartCollectorFor(players: readonly PlayerState[], pos: Vec2, radius: number): PlayerState | null {
  let best: PlayerState | null = null;
  let bestD = Infinity;
  const r2 = radius * radius;
  for (const p of players) {
    if (!canAcceptHeart(p)) continue;
    const d = distSq(p.pos, pos);
    if (d <= r2 && d < bestD) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

/** Coéquipier VIVANT et BLESSÉ le plus proche de `user` dans `radius` (centre à centre ; égalité : premier dans l'ordre des joueurs (= ids, l'état les trie)), hors `user` lui-même ; null s'il n'y en a pas. */
export function woundedAllyNear(players: readonly PlayerState[], user: Pick<PlayerState, 'id' | 'pos'>, radius: number = HEART_HEAL_RADIUS): PlayerState | null {
  let best: PlayerState | null = null;
  let bestD = Infinity;
  const r2 = radius * radius;
  for (const q of players) {
    if (q.id === user.id || !isWounded(q)) continue;
    const d = distSq(q.pos, user.pos);
    if (d <= r2 && d < bestD) {
      best = q;
      bestD = d;
    }
  }
  return best;
}

/** Décision d'un appui sur B (voir l'en-tête du module). */
export type HeartUsePlan =
  | { kind: 'ally'; target: PlayerState }
  | { kind: 'crystal'; crystalId: string }
  | { kind: 'self' }
  | { kind: 'none' };

/**
 * Cible d'un appui sur B pour `user` : (a) allié blessé à portée + cœur rangé → 'ally' ; (b) cristal de soin utilisable sous les pieds (`crystalId`, fourni par la simulation) + `user` blessé →
 * 'crystal' ; (c) `user` blessé + cœur rangé → 'self' ; (d) sinon 'none'. Un joueur à terre n'utilise rien. Ne mute rien.
 * @param crystalId id du cristal de soin INTACT sous les pieds de `user` (dans `HEAL_CRYSTAL_RADIUS`), ou null
 */
export function planHeartUse(players: readonly PlayerState[], user: PlayerState, crystalId: string | null): HeartUsePlan {
  if (user.status !== 'alive') return { kind: 'none' };
  if (user.heart !== undefined) {
    const ally = woundedAllyNear(players, user);
    if (ally) return { kind: 'ally', target: ally };
  }
  if (crystalId !== null && isWounded(user)) return { kind: 'crystal', crystalId };
  if (user.heart !== undefined && isWounded(user)) return { kind: 'self' };
  return { kind: 'none' };
}

/** PV rendus par le cœur rangé de `user` à `target` : min(valeur du cœur, manque de la cible) ; 0 si pas de cœur. */
export function heartUseAmount(user: Pick<PlayerState, 'heart'>, target: Pick<PlayerState, 'hp' | 'maxHp' | 'status'>): number {
  return user.heart === undefined ? 0 : healAmountFor(target, pickupHealValue(user.heart));
}

/**
 * Tolérance : assainit le champ `heart` d'un joueur issu d'un état ancien, d'une sauvegarde ou construit à la main. Valeur inconnue = emplacement vide (champ supprimé) ; sans l'option
 * (`enabled` faux), l'emplacement est toujours vide. N'AJOUTE JAMAIS de champ. MUTE `p`.
 */
export function normalizeHeartField(p: PlayerState, enabled: boolean): void {
  if (p.heart === undefined) return;
  if (!enabled || !isHeartKind(p.heart)) delete p.heart;
}

/** Identifiants des joueurs dont l'emplacement est plein (aide de test / HUD). */
export function playersHoldingHeart(players: readonly PlayerState[]): PlayerId[] {
  return players.filter((p) => p.heart !== undefined).map((p) => p.id);
}
