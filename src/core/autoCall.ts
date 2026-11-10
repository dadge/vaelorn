/**
 * APPEL AUTOMATIQUE — un joueur qui passe sur un objet au sol qu'il NE PREND PAS prévient ses coéquipiers pour qui l'objet serait utile.
 *
 * Logique PURE et déterministe (aucun Phaser/DOM/horloge, AUCUN tirage de flux aléatoire) ; purement INFORMATIVE : le signal ne change aucun comportement de
 * gameplay (pas de déplacement, de dégâts, de ramassage). Constantes dans `balance.ts` [B28].
 *
 * ── Règles ──
 *  1. Déclencheur : un joueur VIVANT chevauche (même rayon que le ramassage : `PICKUP_RADIUS` / `GEAR_PICKUP_RADIUS`) un objet au sol qu'il ne prend pas :
 *      - cœur ou demi-cœur, règle d'ORIGINE (sans emplacement cœur) : il ne peut pas le consommer (`canConsumeHeart` : PV pleins ; aucun seuil, un seul PV manquant suffit à le consommer) ;
 *      - cœur ou demi-cœur, règle de l'EMPLACEMENT CŒUR (`options.heartSlot`, `heartSlot.ts`) : son emplacement contient un cœur ENTIER (`PlayerState.heart === 'full'`), quels que soient ses PV : il ne peut ni le ranger ni fusionner (vide ou demi-cœur : il l'accepte) ;
 *      - objet d'équipement : `pickupDecision(...) === 'ignore'` (même emplacement et niveau inférieur ou égal ; accessoire de même sorte de niveau inférieur ou
 *        égal ; anneau du vampire hors niveau III…). PAS de déclenchement pour un objet verrouillé pour lui (ses propres objets lâchés), une décision 'swap'
 *        (échange manuel au choix du joueur : ce n'est pas un refus), les bonus temporaires (toujours pris), un objet ramassé (il a disparu) ni un objet
 *        simplement attiré par un aimant sans chevauchement.
 *  2. Destinataires utiles : alliés VIVANTS pour qui l'objet serait réellement utile (cœur : un allié qui peut le consommer, ou avec l'emplacement cœur un allié dont l'emplacement est LIBRE ou contient un DEMI-cœur (il le range ou le fusionne) ;
 *     équipement : 'equip' ou 'upgrade' et pas verrouillé sur cet objet). La distance ne compte pas. Aucun destinataire → AUCUN appel. Évalués au déclenchement (`AutoCallState.to`).
 *  3. Signal automatique ≠ appel manuel : il ne fige pas le joueur, ne consomme pas le délai de l'appel manuel, dure `AUTO_CALL_DURATION_MS`. Un appel manuel
 *     en cours n'est jamais interrompu par un automatique ; un appel manuel qui démarre efface l'icône automatique (`startCall`).
 *  4. Anti-spam : un seul déclenchement par couple (joueur, objet) tant que le joueur reste dans le rayon (+ `AUTO_CALL_REARM_MARGIN`) ; par joueur, délai de
 *     récupération `AUTO_CALL_COOLDOWN_MS` (> durée du signal : un signal actif n'est jamais remplacé par un autre objet).
 *     TRAIT « PARLE BEAUCOUP » (Romain, `callTraits.ts`, [B31]) : AUCUN délai entre deux appels d'objet (`autoCallCooldownMs` n'est jamais armé) ; son signal d'objet en cours PEUT être remplacé par
 *     celui d'un autre objet dès qu'il a été AFFICHÉ `AUTO_CALL_MIN_SHOW_MS_CHATTY` (1 s : le temps d'être lu par ses destinataires ; ce n'est pas une attente entre deux appels) : nouvelle icône, signal relancé à 3 s ; l'objet remplacé n'est PAS « oublié » : l'anti-spam par couple reste, sinon deux objets voisins se remplaceraient en boucle. L'appel manuel en cours
 *     n'est jamais interrompu et l'emporte, et une croix en cours n'est jamais remplacée, pour lui comme pour les autres.
 *  5. Un signal s'arrête quand son objet disparaît (ramassé par un allié, périmé).
 *  6. ÉCHANGE D'ACCESSOIRE : un joueur qui ÉCHANGE à la main un accessoire d'une autre sorte (bouton A, `swapAccessory` de la simulation) pose l'ANCIEN à ses pieds, verrouillé pour lui tant qu'il n'a pas quitté
 *     le rayon (`lockMode === 'leave'`) : c'est un objet qu'il LAISSE (`gearLeftBy`). Un appel part alors avec l'icône de l'objet posé, aux mêmes conditions que pour un objet refusé (destinataires : alliés vivants
 *     pour qui l'objet serait utile, mêmes délais, un seul déclenchement par couple joueur / objet). Le verrou ne l'empêche pas : il EST le déclencheur. L'appel après échange part à l'instant du geste : il n'est PAS soumis au délai de `AUTO_CALL_COOLDOWN_MS` ni à un signal d'objet en cours (qu'il remplace) ; seuls un appel manuel en cours (cas rare : il l'emporte) ou une croix en cours le retardent ; si le joueur quitte l'objet avant la fin de ce retard, l'appel est perdu (écart accepté, TODO.md). Les objets ÉPARPILLÉS par une chute (`lockMode === 'life'`,
 *     le joueur est à terre) et le cœur qui tombe ne déclenchent rien (ce n'est pas un choix du joueur).
 *  7. CROIX ROUGE = DEMANDE DE SOINS (`stepCross`, constantes [B30]) : un joueur VIVANT dont les PV tombent à `CROSS_CALL_THRESHOLD` (30 %) de ses PV max ou MOINS prévient les alliés VIVANTS qui PEUVENT réellement le
 *     soigner (`canHealWithCross` : emplacement cœur contenant un cœur utilisable — avec `options.heartSlot` —, ou VALENTINE, qui soigne avec sa flèche et son onde sans cœur), évalués au déclenchement ; aucun
 *     soigneur = aucun appel. Symbole : une croix rouge (`icon: 'cross'`, `ref: 'x'`). Un joueur à terre ne la déclenche pas (il a déjà sa flèche). Répétition : un nouvel appel au plus toutes les
 *     `CROSS_CALL_REPEAT_MS` (10 s ; 3 s pour un héros qui parle beaucoup, Romain : `crossRepeatMsFor`, la croix est alors quasi continue, sans trou, et ses vraies répétitions jouent un son plus doux ; une nouvelle alerte après une longue pause garde le son complet : `autoCallCross.idleMs`) tant que le joueur reste à 30 % ou moins ; entre 30 % et 60 % le délai CONTINUE de courir (un rebond juste au-dessus du seuil ne fait pas taire la demande) ; le suivi (`PlayerState.autoCallCross`) est supprimé (croix réarmée)
 *     quand les PV remontent à `CROSS_CALL_REARM_FRACTION` (60 %) ou plus et à chaque entrée de salle. Un signal de croix en cours s'arrête dès que le joueur repasse au-dessus du seuil (soigné). Priorité : la croix PEUT remplacer un appel automatique d'objet en cours (plus urgent) ; un appel MANUEL
 *     en cours n'est jamais interrompu et l'emporte (un signal d'objet remplacé par la croix est « oublié » et repart ensuite) ; elle n'est pas soumise au délai de `AUTO_CALL_COOLDOWN_MS` (4 s) des objets et ne le consomme pas, ni celui de l'appel manuel.
 * Solo (un seul joueur) : aucun appel. L'activation (démo, bots) est décidée par l'appelant (`GameState.autoCallDisabled`) ; le tutoriel l'active.
 */
import {
  AUTO_CALL_COOLDOWN_MS,
  AUTO_CALL_DURATION_MS,
  AUTO_CALL_MIN_SHOW_MS_CHATTY,
  AUTO_CALL_REARM_MARGIN,
  CROSS_CALL_REARM_FRACTION,
  CROSS_CALL_REPEAT_MS,
  CROSS_CALL_THRESHOLD,
  GEAR_PICKUP_RADIUS,
  PICKUP_RADIUS,
} from './balance';
import { ACCESSORY_KINDS, GEAR_LEVELS, GEAR_SLOTS, pickupDecision } from './gear';
import { distSq } from './geometry';
import { canAcceptHeart, heartUseAmount } from './heartSlot';
import { canConsumeHeart } from './loot';
import { autoCallCooldownFor, autoCallsWithoutWait, crossRepeatMsFor, crossSoftRepeatFor, crossSoftWindowMs } from './callTraits';
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

/** Un cœur / demi-cœur est-il utile à ce joueur (vivant ET blessé) ? Règle d'origine (sans emplacement cœur). */
export function heartUsefulTo(p: Pick<PlayerState, 'hp' | 'maxHp' | 'status'>): boolean {
  return canConsumeHeart(p);
}

/**
 * Un cœur / demi-cœur est-il utile à ce joueur avec l'EMPLACEMENT CŒUR ? Vivant ET il peut l'accepter : emplacement LIBRE (il le range) OU contenant un DEMI-cœur (il fusionne et monte à l'entier :
 * utile même si l'objet au sol est un demi-cœur). Emplacement ENTIER : inutile.
 */
export function heartSlotUsefulTo(p: Pick<PlayerState, 'status' | 'heart'>): boolean {
  return canAcceptHeart(p);
}

/** Options de `stepAutoCalls`. */
export interface AutoCallOptions {
  /**
   * Règle de l'EMPLACEMENT CŒUR (`SimConfig.heartSlot`) : l'appel de cœur part quand l'emplacement du joueur est ENTIER (quels que soient ses PV : un emplacement vide ou à demi-cœur ramasse / fusionne, il ne refuse rien)
   * et les destinataires sont les alliés vivants qui PEUVENT ranger : emplacement LIBRE ou contenant un DEMI-cœur (fusion). Faux / absent : règle d'origine (PV pleins ; alliés blessés).
   */
  heartSlot?: boolean;
}

/** Ce joueur refuse-t-il (ne prend pas) cet objet d'équipement s'il le chevauche ? Vrai si vivant, non verrouillé et `pickupDecision` vaut 'ignore'. */
export function gearRefusedBy(p: Pick<PlayerState, 'status' | 'id' | 'loadout'>, drop: Pick<GearDropState, 'item' | 'lockedFor'>): boolean {
  if (p.status !== 'alive' || drop.lockedFor === p.id) return false;
  return pickupDecision(p.loadout, drop.item) === 'ignore';
}

/**
 * Ce joueur vient-il de LAISSER cet objet d'équipement par un échange manuel d'accessoire ? Vrai si vivant et si l'objet est verrouillé POUR LUI en mode 'leave' (le seul mode que pose `swapAccessory` : « tant qu'il n'a
 * pas quitté le rayon »). Les objets éparpillés par une chute (mode 'life') ne comptent pas : ce n'est pas un choix du joueur.
 */
export function gearLeftBy(p: Pick<PlayerState, 'status' | 'id'>, drop: Pick<GearDropState, 'lockedFor' | 'lockMode'>): boolean {
  return p.status === 'alive' && drop.lockMode === 'leave' && drop.lockedFor === p.id;
}

/** Cet objet d'équipement serait-il utile à ce joueur (vivant, non verrouillé, 'equip' ou 'upgrade') ? ('swap' = échange manuel : pas utile.) */
export function gearUsefulTo(p: Pick<PlayerState, 'status' | 'id' | 'loadout'>, drop: Pick<GearDropState, 'item' | 'lockedFor'>): boolean {
  if (p.status !== 'alive' || drop.lockedFor === p.id) return false;
  const decision = pickupDecision(p.loadout, drop.item);
  return decision === 'equip' || decision === 'upgrade';
}

/** Référence du signal de la croix rouge (`AutoCallState.ref`) : aucun objet au sol, donc jamais purgée avec les objets. */
export const CROSS_REF = 'x';

/** Tolérance (fractions de PV) sur les comparaisons de seuil : `0,3 × 10` n'est pas exactement 3 en virgule flottante. */
const HP_EPSILON = 1e-9;

/** Ce joueur est-il à `CROSS_CALL_THRESHOLD` de ses PV max ou MOINS ? (PV non finis ou PV max nuls : non). Ne regarde pas son statut. */
export function isCrossLow(p: Pick<PlayerState, 'hp' | 'maxHp'>): boolean {
  return Number.isFinite(p.hp) && Number.isFinite(p.maxHp) && p.maxHp > 0 && p.hp <= p.maxHp * CROSS_CALL_THRESHOLD + HP_EPSILON;
}

/** Ce joueur est-il remonté à `CROSS_CALL_REARM_FRACTION` de ses PV max ou PLUS ? (la croix est alors réarmée) */
export function isCrossRearmed(p: Pick<PlayerState, 'hp' | 'maxHp'>): boolean {
  return Number.isFinite(p.hp) && Number.isFinite(p.maxHp) && p.maxHp > 0 && p.hp >= p.maxHp * CROSS_CALL_REARM_FRACTION - HP_EPSILON;
}

/** Valentine soigne sans cœur (flèche de soin, onde `healNova`) : elle reçoit toujours la croix quand elle est vivante dans l'équipe. */
export function isHealerCharacter(p: Pick<PlayerState, 'characterId'>): boolean {
  return p.characterId === 'valentine';
}

/**
 * `healer` peut-il RÉELLEMENT soigner `patient` ? Vivant, autre que le patient, et soit Valentine (soigne sans cœur), soit (règle de l'EMPLACEMENT CŒUR, `heartSlot`) un cœur rangé UTILISABLE : au moins un PV à rendre
 * au patient (`heartUseAmount`). Sans `heartSlot` (règle d'origine : cœur consommé au contact, pas d'emplacement) seule Valentine peut soigner à la demande.
 */
export function canHealWithCross(
  healer: Pick<PlayerState, 'id' | 'status' | 'characterId' | 'heart'>,
  patient: Pick<PlayerState, 'id' | 'hp' | 'maxHp'>,
  heartSlot: boolean,
): boolean {
  if (healer.status !== 'alive' || healer.id === patient.id) return false;
  if (isHealerCharacter(healer)) return true;
  return heartSlot && healer.heart !== undefined && heartUseAmount(healer, { hp: patient.hp, maxHp: patient.maxHp, status: 'alive' }) > 0;
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
 * @param options règle des cœurs (voir `AutoCallOptions`)
 */
export function stepAutoCalls(
  players: PlayerState[],
  pickups: readonly PickupState[],
  gearDrops: readonly GearDropState[],
  events: SimEvent[] = [],
  options: AutoCallOptions = {},
): SimEvent[] {
  const slot = options.heartSlot === true;
  if (players.length < 2) return events;
  if (pickups.length === 0 && gearDrops.length === 0) {
    // plus aucun objet au sol : les signaux d'objet en cours s'arrêtent (pas la croix rouge, qui n'a pas d'objet) et la mémoire des objets signalés est vidée
    for (const p of players) {
      if (p.autoCall && p.autoCall.icon !== 'cross') delete p.autoCall;
      delete p.autoCallSeen;
      stepCross(p, players, slot, events);
    }
    return events;
  }
  const rr = PICKUP_RADIUS * PICKUP_RADIUS;
  const gr = GEAR_PICKUP_RADIUS * GEAR_PICKUP_RADIUS;
  const rearmP = (PICKUP_RADIUS + AUTO_CALL_REARM_MARGIN) * (PICKUP_RADIUS + AUTO_CALL_REARM_MARGIN);
  const rearmG = (GEAR_PICKUP_RADIUS + AUTO_CALL_REARM_MARGIN) * (GEAR_PICKUP_RADIUS + AUTO_CALL_REARM_MARGIN);
  for (const p of players) {
    // l'objet d'un signal en cours a disparu (ramassé par un allié, périmé) : le signal s'arrête
    if (p.autoCall && p.autoCall.icon !== 'cross' && !refExists(p.autoCall.ref, pickups, gearDrops)) delete p.autoCall;
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
    // croix rouge (demande de soins) : prioritaire sur un appel d'objet en cours (elle le remplace), évaluée avant les objets
    stepCross(p, players, slot, events);
    if (p.status !== 'alive') continue;
    // un appel manuel en cours n'est jamais interrompu ; une croix en cours n'est jamais remplacée (plus urgente)
    if (p.callMs > CALL_EPSILON_MS || p.autoCall?.icon === 'cross') continue;
    // un signal d'objet actif n'est pas remplacé par un autre objet ; délai de récupération propre à l'appel automatique. Seul l'appel APRÈS ÉCHANGE d'accessoire (règle 6) y échappe : il part
    // à l'instant du geste du joueur, qui s'éloigne naturellement de l'objet (le verrou 'leave' tombe alors et l'appel serait perdu s'il devait attendre la fin d'un délai) ; il REMPLACE un signal d'objet en cours
    // Trait « sans attente » (Romain) : aucun délai armé, et un signal d'objet en cours peut être remplacé tout de suite par un autre objet (l'anti-spam par couple, `autoCallSeen`, reste)
    const noWait = autoCallsWithoutWait(p);
    // Un signal d'objet de ce héros doit avoir été AFFICHÉ au moins `AUTO_CALL_MIN_SHOW_MS_CHATTY` avant d'être remplacé (lisible par ses destinataires) : ce n'est pas une attente entre deux appels, seulement le temps de lire
    const unreadable = noWait && p.autoCall !== undefined && AUTO_CALL_DURATION_MS - p.autoCall.ms < AUTO_CALL_MIN_SHOW_MS_CHATTY - CALL_EPSILON_MS;
    const busy = (p.autoCall !== undefined && !noWait) || unreadable || (p.autoCallCooldownMs ?? 0) > CALL_EPSILON_MS;

    const seen = p.autoCallSeen;
    let found: Candidate | null = null;
    // nourriture d'abord, puis équipement (ordre des tableaux : déterministe)
    if (!busy && (slot ? !canAcceptHeart(p) : !canConsumeHeart(p))) {
      for (const pk of pickups) {
        const ref = pickupRef(pk.id);
        if (seen?.includes(ref) || distSq(p.pos, pk.pos) > rr) continue;
        const to = recipients(players, p.id, slot ? heartSlotUsefulTo : heartUsefulTo);
        if (to.length === 0) continue;
        found = { ref, icon: heartIcon(pk.kind), to };
        break;
      }
    }
    if (!found) {
      for (const d of gearDrops) {
        const ref = gearRef(d.id);
        // objet refusé (décision 'ignore') OU objet que ce joueur vient de LAISSER par un échange d'accessoire (verrou 'leave' : le verrou est ici le déclencheur, pas un obstacle)
        if (seen?.includes(ref) || distSq(p.pos, d.pos) > gr || !((!busy && gearRefusedBy(p, d)) || gearLeftBy(p, d))) continue;
        const to = recipients(players, p.id, (q) => gearUsefulTo(q, d));
        if (to.length === 0) continue;
        found = { ref, icon: 'gear', item: { ...d.item }, to };
        break;
      }
    }
    if (!found) continue;
    const call: AutoCallState = { icon: found.icon, ref: found.ref, ms: AUTO_CALL_DURATION_MS, to: found.to };
    if (found.item) call.item = found.item;
    // un signal d'objet remplacé (appel après échange) pourra repartir ; sans attente (Romain) l'objet remplacé reste « vu » (le délai ne le ferait pas repartir, et l'oublier ferait se remplacer deux objets voisins en boucle)
    if (!noWait) forgetReplacedRef(p);
    p.autoCall = call;
    const cooldown = autoCallCooldownFor(p);
    if (cooldown > 0) p.autoCallCooldownMs = cooldown; // sans attente : le champ n'est jamais armé
    p.autoCallSeen = p.autoCallSeen ? [...p.autoCallSeen, found.ref] : [found.ref];
    events.push({ type: 'autoCallStarted', playerId: p.id, icon: found.icon, to: found.to.slice() });
  }
  return events;
}

/**
 * Le signal d'OBJET en cours de `p` (s'il y en a un) va être remplacé (par la croix ou par l'appel après échange) : on oublie sa référence dans `autoCallSeen`, sinon l'objet ne serait JAMAIS re-signalé tant que le
 * joueur reste dessus (les alliés l'auraient vu une fraction de seconde puis plus jamais). Il repartira, une fois le délai de récupération écoulé, si le joueur est toujours dessus. MUTE `p`.
 */
function forgetReplacedRef(p: PlayerState): void {
  const prev = p.autoCall;
  if (!prev || prev.icon === 'cross' || !p.autoCallSeen) return;
  const rest = p.autoCallSeen.filter((r) => r !== prev.ref);
  if (rest.length === 0) delete p.autoCallSeen;
  else p.autoCallSeen = rest;
}

/** Au moins un allié vivant peut-il soigner `patient` ? Parcours sans allocation (la liste des destinataires n'est construite qu'au déclenchement). */
function hasHealer(players: readonly PlayerState[], patient: PlayerState, heartSlot: boolean): boolean {
  for (const q of players) if (q.id !== patient.id && canHealWithCross(q, patient, heartSlot)) return true;
  return false;
}

/**
 * Croix rouge d'UN joueur (voir règle 7 de l'en-tête) : réarmement (PV >= 60 %), répétition, déclenchement. MUTE `p` (`autoCall`, `autoCallCross`, `autoCallSeen` si un signal d'objet est remplacé) et ajoute
 * l'événement `autoCallStarted` à `events`. Sans allocation tant que rien ne part. N'a aucun effet sur `callMs`, `callCooldownMs` ni `autoCallCooldownMs`.
 */
function stepCross(p: PlayerState, players: readonly PlayerState[], heartSlot: boolean, events: SimEvent[]): void {
  if (p.status !== 'alive') return; // à terre : pas de croix (flèche vers l'allié à terre) ; le suivi a été remis à zéro à la chute
  if (p.autoCall?.icon === 'cross' && !isCrossLow(p)) delete p.autoCall; // soigné au-dessus du seuil : la demande n'a plus lieu d'être, le signal s'arrête
  const tracking = p.autoCallCross;
  if (tracking && isCrossRearmed(p)) {
    delete p.autoCallCross; // soigné : la croix est réarmée
    return;
  }
  // entre 30 % et 60 % depuis un premier déclenchement : pas de croix, mais le délai de répétition CONTINUE de courir (`stepAutoCallTimers`) : un petit soin ou des PV qui rebondissent juste au-dessus du seuil
  // ne font pas taire la demande (hystérésis : seul le réarmement à 60 % ou une nouvelle salle remet le suivi à zéro)
  if (!isCrossLow(p)) return;
  if (tracking && tracking.ms > CALL_EPSILON_MS) return; // répétition : pas avant la fin du délai
  if (p.callMs > CALL_EPSILON_MS) return; // un appel manuel en cours n'est jamais interrompu (il l'emporte) ; la croix part dès qu'il est fini si le joueur est toujours bas
  if (p.autoCall?.icon === 'cross') return; // déjà en train de la montrer
  if (!hasHealer(players, p, heartSlot)) return; // personne ne peut soigner : aucun appel (réévalué à chaque pas tant que le joueur est bas)
  const to = recipients(players, p.id, (q) => canHealWithCross(q, p, heartSlot));
  forgetReplacedRef(p); // l'appel d'objet remplacé repartira après la croix (délai de récupération écoulé)
  p.autoCall = { icon: 'cross', ref: CROSS_REF, ms: AUTO_CALL_DURATION_MS, to };
  p.autoCallCross = { ms: crossRepeatMsFor(p) };
  const started: SimEvent = { type: 'autoCallStarted', playerId: p.id, icon: 'cross', to: to.slice() };
  // vraie RÉPÉTITION d'un héros à croix fréquente (Romain, toutes les 3 s) : le son est plus court et plus doux (le champ n'existe jamais pour les autres héros). Une NOUVELLE alerte après une longue pause (PV remontés
  // puis retombés, aucun soigneur pendant un moment : `idleMs` au-delà de la fenêtre) garde le son complet
  if (tracking && crossSoftRepeatFor(p) && (tracking.idleMs ?? 0) <= crossSoftWindowMs(p)) started.repeat = true;
  events.push(started);
}

/** L'objet d'un signal 'gear' désigne-t-il une frame d'icône existante (emplacement connu, niveau 1..3, accessoire connu pour un accessoire) ? */
export function validGearItem(item: unknown): boolean {
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
      (o.icon === 'heart' || o.icon === 'half' || o.icon === 'gear' || o.icon === 'cross') &&
      typeof o.ref === 'string' &&
      (o.icon !== 'cross' || o.ref === CROSS_REF) &&
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
  // bornes = le plus grand de la valeur par défaut et de celle du trait du héros (un trait data-driven peut en déclarer une plus grande)
  const maxCd = Math.max(AUTO_CALL_COOLDOWN_MS, autoCallCooldownFor(p));
  if (cd !== undefined && !(typeof cd === 'number' && Number.isFinite(cd) && cd > 0 && cd <= maxCd)) delete p.autoCallCooldownMs;
  const seen = p.autoCallSeen as unknown;
  if (seen !== undefined && !(Array.isArray(seen) && seen.length > 0 && seen.every((r) => typeof r === 'string'))) delete p.autoCallSeen;
  const cross = p.autoCallCross as unknown;
  if (cross !== undefined) {
    const c = cross as { ms?: unknown; idleMs?: unknown } | null;
    const maxRepeat = Math.max(CROSS_CALL_REPEAT_MS, crossRepeatMsFor(p));
    const ok = !!c && typeof c === 'object' && typeof c.ms === 'number' && Number.isFinite(c.ms) && c.ms >= 0 && c.ms <= maxRepeat;
    if (!ok) delete p.autoCallCross;
    else if (c.idleMs !== undefined) {
      // durée d'inactivité (héros à répétition douce) : un champ mal formé est supprimé (son complet), jamais ajouté
      const idle = c.idleMs;
      if (!(crossSoftRepeatFor(p) && typeof idle === 'number' && Number.isFinite(idle) && idle >= 0 && idle <= crossSoftWindowMs(p) * 2)) delete (c as { idleMs?: unknown }).idleMs;
    }
  }
}
