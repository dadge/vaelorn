/**
 * APPEL AUTOMATIQUE — un joueur qui passe sur un objet au sol qu'il NE PREND PAS prévient ses coéquipiers pour qui l'objet serait utile.
 *
 * Logique PURE et déterministe (aucun Phaser/DOM/horloge, AUCUN tirage de flux aléatoire) ; purement INFORMATIVE : le signal ne change aucun comportement de
 * gameplay (pas de déplacement, de dégâts, de ramassage). Constantes dans `balance.ts` [B28].
 *
 * ── Règles ──
 *  1. Déclencheur : un joueur VIVANT chevauche (même rayon que le ramassage : `PICKUP_RADIUS` / `GEAR_PICKUP_RADIUS`) un objet au sol qu'il ne prend pas :
 *      - cœur ou demi-cœur : il ne peut pas le consommer (`canConsumeHeart` : PV pleins ; aucun seuil, un seul PV manquant suffit à le consommer) ;
 *      - objet d'équipement : `pickupDecision(...) === 'ignore'` (même emplacement et niveau inférieur ou égal ; accessoire de même sorte de niveau inférieur ou
 *        égal ; anneau du vampire hors niveau III…). PAS de déclenchement pour un objet verrouillé pour lui (ses propres objets lâchés), une décision 'swap'
 *        (échange manuel au choix du joueur : ce n'est pas un refus), les bonus temporaires (toujours pris), un objet ramassé (il a disparu) ni un objet
 *        simplement attiré par un aimant sans chevauchement.
 *  2. Destinataires utiles : alliés VIVANTS pour qui l'objet serait réellement utile (cœur : un allié qui peut le consommer ; équipement : 'equip' ou 'upgrade' et pas
 *     verrouillé sur cet objet). La distance ne compte pas. Aucun destinataire → AUCUN appel. Évalués au déclenchement (`AutoCallState.to`).
 *  3. Signal automatique ≠ appel manuel : il ne fige pas le joueur, ne consomme pas le délai de l'appel manuel, dure `AUTO_CALL_DURATION_MS`. Un appel manuel
 *     en cours n'est jamais interrompu par un automatique ; un appel manuel qui démarre efface l'icône automatique (`startCall`).
 *  4. Anti-spam : un seul déclenchement par couple (joueur, objet) tant que le joueur reste dans le rayon (+ `AUTO_CALL_REARM_MARGIN`) ; par joueur, délai de
 *     récupération `AUTO_CALL_COOLDOWN_MS` (> durée du signal : un signal actif n'est jamais remplacé par un autre objet).
 *  5. Un signal s'arrête quand son objet disparaît (ramassé par un allié, périmé).
 * Solo (un seul joueur) : aucun appel. L'activation (démo, tutoriel, bots) est décidée par l'appelant (`GameState.autoCallDisabled`).
 */
import { AUTO_CALL_COOLDOWN_MS, AUTO_CALL_DURATION_MS, AUTO_CALL_REARM_MARGIN, GEAR_PICKUP_RADIUS, PICKUP_RADIUS } from './balance';
import { ACCESSORY_KINDS, GEAR_LEVELS, GEAR_SLOTS, pickupDecision } from './gear';
import { distSq } from './geometry';
import { canConsumeHeart } from './loot';
import { CALL_EPSILON_MS } from './players';
import type { AutoCallIcon, AutoCallState, GearDropState, GearItem, PickupState, PlayerId, PlayerState, SimEvent } from './types';

/** Référence d'une nourriture au sol (`AutoCallState.ref`). */
export function pickupRef(id: number): string {
  return `p${id}`;
}

/** Référence d'un objet d'équipement au sol (`AutoCallState.ref`). */
export function gearRef(id: number): string {
  return `g${id}`;
}

/** Un cœur / demi-cœur est-il utile à ce joueur (vivant ET blessé) ? */
export function heartUsefulTo(p: Pick<PlayerState, 'hp' | 'maxHp' | 'status'>): boolean {
  return canConsumeHeart(p);
}

/** Ce joueur refuse-t-il (ne prend pas) cet objet d'équipement s'il le chevauche ? Vrai si vivant, non verrouillé et `pickupDecision` vaut 'ignore'. */
export function gearRefusedBy(p: Pick<PlayerState, 'status' | 'id' | 'loadout'>, drop: Pick<GearDropState, 'item' | 'lockedFor'>): boolean {
  if (p.status !== 'alive' || drop.lockedFor === p.id) return false;
  return pickupDecision(p.loadout, drop.item) === 'ignore';
}

/** Cet objet d'équipement serait-il utile à ce joueur (vivant, non verrouillé, 'equip' ou 'upgrade') ? ('swap' = échange manuel : pas utile.) */
export function gearUsefulTo(p: Pick<PlayerState, 'status' | 'id' | 'loadout'>, drop: Pick<GearDropState, 'item' | 'lockedFor'>): boolean {
  if (p.status !== 'alive' || drop.lockedFor === p.id) return false;
  const decision = pickupDecision(p.loadout, drop.item);
  return decision === 'equip' || decision === 'upgrade';
}

/** Symbole d'un cœur au sol : 'heart' (entier) ou 'half'. */
export function heartIcon(kind: PickupState['kind']): AutoCallIcon {
  return kind === 'full' ? 'heart' : 'half';
}

/** Ids des alliés (hors `except`) vivants qui satisfont `useful`, dans l'ordre du tableau. */
function recipients(players: readonly PlayerState[], except: PlayerId, useful: (q: PlayerState) => boolean): PlayerId[] {
  const out: PlayerId[] = [];
  for (const q of players) if (q.id !== except && q.status === 'alive' && useful(q)) out.push(q.id);
  return out;
}

/** Nourriture au sol de référence `ref` ('p<id>'), ou undefined. */
function findPickup(ref: string, pickups: readonly PickupState[]): PickupState | undefined {
  for (const pk of pickups) if (pickupRef(pk.id) === ref) return pk;
  return undefined;
}

/** Objet d'équipement au sol de référence `ref` ('g<id>'), ou undefined. */
function findGear(ref: string, gearDrops: readonly GearDropState[]): GearDropState | undefined {
  for (const d of gearDrops) if (gearRef(d.id) === ref) return d;
  return undefined;
}

/** L'objet de référence `ref` est-il encore au sol ? */
function refExists(ref: string, pickups: readonly PickupState[], gearDrops: readonly GearDropState[]): boolean {
  return findPickup(ref, pickups) !== undefined || findGear(ref, gearDrops) !== undefined;
}

/** Candidat à un appel : un objet au sol refusé par le joueur. */
interface Candidate {
  ref: string;
  icon: AutoCallIcon;
  item?: GearItem;
  to: PlayerId[];
}

/**
 * Pas de l'appel automatique (à appeler en phase 'playing' ET 'roomCleared' — l'équipement y reste ramassable —, APRÈS le ramassage des cœurs et de l'équipement : un objet
 * pris a disparu et ne déclenche rien, et le signal de l'objet disparu est purgé dans les deux phases).
 * MUTE `players` (`autoCall`, `autoCallCooldownMs`, `autoCallSeen`) et retourne les événements `autoCallStarted`. Sans effet avec moins de 2 joueurs.
 * Sans allocation tant qu'aucun appel ne part (recherche linéaire : quelques objets au sol au plus).
 *
 * @param players tous les joueurs
 * @param pickups nourriture au sol de la salle
 * @param gearDrops objets d'équipement au sol de la salle
 * @param events tableau où ajouter les événements (défaut : un nouveau tableau) ; retourné
 */
export function stepAutoCalls(
  players: PlayerState[],
  pickups: readonly PickupState[],
  gearDrops: readonly GearDropState[],
  events: SimEvent[] = [],
): SimEvent[] {
  if (players.length < 2) return events;
  if (pickups.length === 0 && gearDrops.length === 0) {
    // plus aucun objet au sol : les signaux en cours s'arrêtent et la mémoire des objets signalés est vidée
    for (const p of players) {
      delete p.autoCall;
      delete p.autoCallSeen;
    }
    return events;
  }
  const rr = PICKUP_RADIUS * PICKUP_RADIUS;
  const gr = GEAR_PICKUP_RADIUS * GEAR_PICKUP_RADIUS;
  const rearmP = (PICKUP_RADIUS + AUTO_CALL_REARM_MARGIN) * (PICKUP_RADIUS + AUTO_CALL_REARM_MARGIN);
  const rearmG = (GEAR_PICKUP_RADIUS + AUTO_CALL_REARM_MARGIN) * (GEAR_PICKUP_RADIUS + AUTO_CALL_REARM_MARGIN);
  for (const p of players) {
    // l'objet d'un signal en cours a disparu (ramassé par un allié, périmé) : le signal s'arrête
    if (p.autoCall && !refExists(p.autoCall.ref, pickups, gearDrops)) delete p.autoCall;
    // ré-armement : un objet signalé n'est oublié qu'une fois le joueur sorti du rayon + marge (ou l'objet disparu)
    if (p.autoCallSeen) {
      const kept = p.autoCallSeen.filter((ref) => {
        const pk = findPickup(ref, pickups);
        if (pk) return distSq(p.pos, pk.pos) <= rearmP;
        const d = findGear(ref, gearDrops);
        return d ? distSq(p.pos, d.pos) <= rearmG : false;
      });
      if (kept.length === 0) delete p.autoCallSeen;
      else if (kept.length !== p.autoCallSeen.length) p.autoCallSeen = kept;
    }
    if (p.status !== 'alive') continue;
    // un signal automatique actif n'est pas remplacé ; un appel manuel en cours n'est pas interrompu ; délai de récupération propre à l'appel automatique
    if (p.autoCall || p.callMs > CALL_EPSILON_MS || (p.autoCallCooldownMs ?? 0) > CALL_EPSILON_MS) continue;

    const seen = p.autoCallSeen;
    let found: Candidate | null = null;
    // nourriture d'abord, puis équipement (ordre des tableaux : déterministe)
    if (!canConsumeHeart(p)) {
      for (const pk of pickups) {
        const ref = pickupRef(pk.id);
        if (seen?.includes(ref) || distSq(p.pos, pk.pos) > rr) continue;
        const to = recipients(players, p.id, heartUsefulTo);
        if (to.length === 0) continue;
        found = { ref, icon: heartIcon(pk.kind), to };
        break;
      }
    }
    if (!found) {
      for (const d of gearDrops) {
        const ref = gearRef(d.id);
        if (seen?.includes(ref) || distSq(p.pos, d.pos) > gr || !gearRefusedBy(p, d)) continue;
        const to = recipients(players, p.id, (q) => gearUsefulTo(q, d));
        if (to.length === 0) continue;
        found = { ref, icon: 'gear', item: { ...d.item }, to };
        break;
      }
    }
    if (!found) continue;
    const call: AutoCallState = { icon: found.icon, ref: found.ref, ms: AUTO_CALL_DURATION_MS, to: found.to };
    if (found.item) call.item = found.item;
    p.autoCall = call;
    p.autoCallCooldownMs = AUTO_CALL_COOLDOWN_MS;
    p.autoCallSeen = seen ? [...seen, found.ref] : [found.ref];
    events.push({ type: 'autoCallStarted', playerId: p.id, icon: found.icon, to: found.to.slice() });
  }
  return events;
}

/** L'objet d'un signal 'gear' désigne-t-il une frame d'icône existante (emplacement connu, niveau 1..3, accessoire connu pour un accessoire) ? */
function validGearItem(item: unknown): boolean {
  if (!item || typeof item !== 'object') return false;
  const it = item as Partial<GearItem>;
  if (!GEAR_SLOTS.includes(it.slot as GearItem['slot']) || !GEAR_LEVELS.includes(it.level as GearItem['level'])) return false;
  return it.slot === 'accessory' ? it.accessory === undefined || ACCESSORY_KINDS.includes(it.accessory) : true;
}

/**
 * Tolérance : assainit les champs d'appel automatique d'un joueur issus d'un état ancien ou construit à la main (champ absent = valide ; champ mal formé = supprimé).
 * N'AJOUTE JAMAIS de champ. MUTE `p`.
 */
export function normalizeAutoCallFields(p: PlayerState): void {
  const ac = p.autoCall as unknown;
  if (ac !== undefined) {
    const o = ac as Partial<AutoCallState> | null;
    const ok =
      !!o &&
      typeof o === 'object' &&
      (o.icon === 'heart' || o.icon === 'half' || o.icon === 'gear') &&
      typeof o.ref === 'string' &&
      typeof o.ms === 'number' &&
      Number.isFinite(o.ms) &&
      o.ms > 0 &&
      o.ms <= AUTO_CALL_DURATION_MS &&
      Array.isArray(o.to) &&
      o.to.every((id) => typeof id === 'number') &&
      (o.icon !== 'gear' || validGearItem(o.item));
    if (!ok) delete p.autoCall;
  }
  const cd = p.autoCallCooldownMs as unknown;
  if (cd !== undefined && !(typeof cd === 'number' && Number.isFinite(cd) && cd > 0 && cd <= AUTO_CALL_COOLDOWN_MS)) delete p.autoCallCooldownMs;
  const seen = p.autoCallSeen as unknown;
  if (seen !== undefined && !(Array.isArray(seen) && seen.length > 0 && seen.every((r) => typeof r === 'string'))) delete p.autoCallSeen;
}
