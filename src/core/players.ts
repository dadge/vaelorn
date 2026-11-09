/**
 * Joueurs : PV, dégâts reçus, relevage, mort d'équipe (DESIGN.md §3 « Relevage, mort d'équipe »).
 *
 * Logique pure : aucune dépendance Phaser/DOM, aucun aléatoire. Les fonctions MUTENT uniquement les
 * `PlayerState` qu'on leur passe (documenté pour chacune).
 *
 * Intégration côté simulation (pour chaque pas) :
 *  1. `stepPlayerTimers(p, dt)` pour chaque joueur ;
 *  2. gel du mouvement ET de l'attaque des joueurs pour lesquels `isRescuing(p)` est vrai ;
 *  3. `updateRevive(players, id => frame[id].revive, downed => ennemiProche(downed), dt)` → événements à relayer ;
 *  4. dégâts : `applyDamageToPlayer(p, brut)` → si `downed`, émettre `playerDown` (+ `teamWipe` si `isTeamWiped`).
 *
 * Priorité d'arbitrage du bouton action (rappel DESIGN §5) : relevage > interaction > attaque. La sim doit donc
 * passer `reviveHeld = true` pour un joueur dont le bouton d'action est tenu ET qui a un allié à terre à portée
 * (ou simplement `frame.revive` ; `updateRevive` vérifie lui-même la portée).
 */
import { CALL_COOLDOWN_MS, CALL_DURATION_MS, CALL_FREEZE_MS, TORCH_LOW_FRACTION, TORCH_MAX_MS } from './constants';
import { PLAYER_INVULN_MS, REVIVE_DURATION_MS, REVIVE_RANGE, REVIVE_THREAT_SLOW } from './constants';
import { damageToPlayer, maxHpFor, REVIVE_INVULN_MS } from './balance';
import { getCharacter } from './characters';
import { distSq } from './geometry';
import type { PlayerId, PlayerSetup, PlayerState, SimEvent, Vec2 } from './types';

/**
 * Crée l'état initial d'un joueur : PV pleins (selon résistance, indépendants de la difficulté), vivant,
 * orienté vers le bas, sans clé, compteurs à zéro.
 * @param setup choix du joueur (id, personnage, difficulté)
 * @param spawnPx position de départ en pixels (copiée)
 */
export function createPlayerState(setup: PlayerSetup, spawnPx: Vec2): PlayerState {
  const maxHp = maxHpFor(getCharacter(setup.characterId));
  return {
    id: setup.id,
    characterId: setup.characterId,
    difficulty: setup.difficulty,
    pos: { x: spawnPx.x, y: spawnPx.y },
    facing: 'down',
    hp: maxHp,
    maxHp,
    status: 'alive',
    invulnMs: 0,
    attackCooldownMs: 0,
    attackAnimMs: 0,
    attackDir: 'down',
    revivingId: null,
    reviveProgressMs: 0,
    reviverId: null,
    keys: [],
    kills: 0,
    downCount: 0,
    prev: { attack: false, interact: false, revive: false, special: false, call: false },
    specialCooldownMs: 0,
    specialAnimMs: 0,
    torchMs: TORCH_MAX_MS,
    callMs: 0,
    callCooldownMs: 0,
    moving: false,
  };
}

/**
 * Applique des dégâts BRUTS à un joueur (muté : `hp`, `invulnMs`, et si KO `status`, liens de relevage, `downCount`).
 *
 * - Joueur déjà à terre : AUCUN effet (il ne peut pas être achevé) → `{applied:0, downed:false}`.
 * - Joueur invulnérable (`invulnMs > 0`) : aucun effet.
 * - Sinon : dégâts réels = `damageToPlayer(brut, personnage, p.difficulty)` (difficulté du joueur × résistance, ≥ 1).
 *   Les PV descendent à 0 au minimum. Si PV = 0 → `status:'down'`, `revivingId/reviverId = null`, `reviveProgressMs = 0`,
 *   `downCount++`, `downed:true`. Sinon `invulnMs = PLAYER_INVULN_MS`.
 * - Un sauveteur touché mais pas à terre garde son relevage en cours (pas d'interruption sur simple coup).
 *   S'il tombe, `updateRevive` interrompra le relevage au prochain appel (raison `reviverDown`).
 *
 * @param p joueur ciblé (muté)
 * @param rawDamage dégâts bruts (EnemyDef.damage, ProjectileState.damage…)
 * @returns `applied` : dégâts réels calculés (0 si ignoré) ; `downed` : true si CE coup met le joueur à terre
 */
export function applyDamageToPlayer(p: PlayerState, rawDamage: number): { applied: number; downed: boolean } {
  if (p.status === 'down' || p.invulnMs > 0 || !(rawDamage > 0)) {
    return { applied: 0, downed: false };
  }
  const applied = damageToPlayer(rawDamage, getCharacter(p.characterId), p.difficulty);
  p.hp = Math.max(0, p.hp - applied);
  if (p.hp <= 0) {
    p.hp = 0;
    p.status = 'down';
    p.invulnMs = 0;
    p.attackAnimMs = 0;
    p.specialAnimMs = 0;
    p.callMs = 0; // l'appel est annulé quand l'appelant tombe (le délai de récupération continue de courir)
    p.moving = false;
    p.revivingId = null;
    p.reviverId = null;
    p.reviveProgressMs = 0;
    p.downCount += 1;
    return { applied, downed: true };
  }
  p.invulnMs = PLAYER_INVULN_MS;
  return { applied, downed: false };
}

/**
 * Le joueur est-il en train de relever un allié ? Vrai si vivant et `revivingId !== null`.
 * La simulation fige alors son mouvement et son attaque.
 */
export function isRescuing(p: PlayerState): boolean {
  return p.status === 'alive' && p.revivingId !== null;
}

/** Durée de relevage nominale (ms) quand `reviver` relève quelqu'un : `REVIVE_DURATION_MS × reviveTimeMult`. */
export function reviveDurationFor(reviver: PlayerState): number {
  return REVIVE_DURATION_MS * getCharacter(reviver.characterId).reviveTimeMult;
}

/**
 * Fait avancer le relevage de tous les joueurs à terre d'UN pas `dtMs`. MUTE les joueurs (statut, PV, liens, progression).
 *
 * Règles (DESIGN §3) :
 *  - sauveteur = joueur VIVANT, distinct de la cible, à ≤ `REVIVE_RANGE` (centre à centre) qui MAINTIENT `reviveHeld(id)`
 *    et ne relève pas déjà quelqu'un d'autre ;
 *  - un seul sauveteur par joueur à terre : le premier arrivé garde la main tant qu'il est valide (si plusieurs
 *    candidats sur un même pas, le plus proche, puis le plus petit id) ;
 *  - progression += `dtMs` × (`REVIVE_THREAT_SLOW` si `enemyThreatNear(cible)` sinon 1) ; durée requise =
 *    `REVIVE_DURATION_MS × reviveTimeMult(sauveteur)` ;
 *  - interruption (progression remise à 0, `reviverId/revivingId` effacés, événement `reviveInterrupted`) si le sauveteur est
 *    à terre (`reviverDown`), relâche le bouton (`released`) ou s'éloigne (`range`). Précédence en cas de cumul :
 *    reviverDown > released > range. La cible RESTE à terre dans tous les cas ;
 *  - un sauveteur qui reçoit des dégâts sans tomber n'est pas interrompu ;
 *  - complétion : `hp = maxHp`, `status:'alive'`, `invulnMs = REVIVE_INVULN_MS`, progression 0, liens effacés,
 *    événement `playerRevived`. Peut se répéter indéfiniment.
 *
 * `enemyThreatNear` n'est appelé que pour les cibles dont le relevage progresse ce pas (testez-y
 * `DOWNED_THREAT_RADIUS` autour de `downed.pos`).
 *
 * @param players tous les joueurs (muté)
 * @param reviveHeld le bouton de relevage de ce joueur est-il tenu ce pas ?
 * @param enemyThreatNear un ennemi vivant menace-t-il ce joueur à terre ? (rayon DOWNED_THREAT_RADIUS)
 * @param dtMs durée du pas (ms)
 * @returns événements : `reviveStarted`, `reviveInterrupted`, `playerRevived` (dans l'ordre d'occurrence)
 */
export function updateRevive(
  players: PlayerState[],
  reviveHeld: (id: PlayerId) => boolean,
  enemyThreatNear: (downed: PlayerState) => boolean,
  dtMs: number,
): SimEvent[] {
  const events: SimEvent[] = [];
  const byId = (id: PlayerId | null): PlayerState | undefined =>
    id === null ? undefined : players.find((q) => q.id === id);

  // Assainissement : un « revivingId » orphelin (cible relevée/changée par ailleurs) est effacé sans événement.
  for (const r of players) {
    if (r.revivingId === null) continue;
    const t = byId(r.revivingId);
    if (r.status !== 'alive' || !t || t.status !== 'down' || t.reviverId !== r.id) r.revivingId = null;
  }

  for (const target of players) {
    if (target.status !== 'down') {
      // Un joueur vivant ne porte ni progression ni sauveteur.
      target.reviverId = null;
      target.reviveProgressMs = 0;
      continue;
    }

    // 1) Validation du sauveteur courant.
    if (target.reviverId !== null) {
      const r = byId(target.reviverId);
      let reason: 'released' | 'reviverDown' | 'range' | null = null;
      if (!r || r.status !== 'alive') reason = 'reviverDown';
      else if (!reviveHeld(r.id)) reason = 'released';
      else if (distSq(r.pos, target.pos) > REVIVE_RANGE * REVIVE_RANGE) reason = 'range';
      if (reason !== null) {
        events.push({ type: 'reviveInterrupted', reviverId: target.reviverId, targetId: target.id, reason });
        if (r && r.revivingId === target.id) r.revivingId = null;
        target.reviverId = null;
        target.reviveProgressMs = 0;
      }
    }

    // 2) Recherche d'un sauveteur si la place est libre.
    if (target.reviverId === null) {
      let best: PlayerState | null = null;
      let bestD = Infinity;
      for (const c of players) {
        if (c.id === target.id || c.status !== 'alive' || c.revivingId !== null) continue;
        if (!reviveHeld(c.id)) continue;
        const d = distSq(c.pos, target.pos);
        if (d > REVIVE_RANGE * REVIVE_RANGE) continue;
        if (d < bestD || (d === bestD && best !== null && c.id < best.id)) {
          best = c;
          bestD = d;
        }
      }
      if (best) {
        best.revivingId = target.id;
        target.reviverId = best.id;
        target.reviveProgressMs = 0;
        events.push({ type: 'reviveStarted', reviverId: best.id, targetId: target.id });
      }
    }

    // 3) Progression.
    if (target.reviverId !== null) {
      const reviver = byId(target.reviverId);
      if (!reviver) continue;
      const rate = enemyThreatNear(target) ? REVIVE_THREAT_SLOW : 1;
      target.reviveProgressMs += dtMs * rate;
      if (target.reviveProgressMs >= reviveDurationFor(reviver)) {
        target.hp = target.maxHp;
        target.status = 'alive';
        target.invulnMs = REVIVE_INVULN_MS;
        target.attackCooldownMs = 0;
        target.attackAnimMs = 0;
        target.reviveProgressMs = 0;
        target.reviverId = null;
        target.revivingId = null;
        reviver.revivingId = null;
        events.push({ type: 'playerRevived', playerId: target.id, reviverId: reviver.id });
      }
    }
  }
  return events;
}

/** Tous les joueurs sont-ils à terre ? (liste vide ⇒ faux). En solo, 1 joueur à terre = défaite. */
export function isTeamWiped(players: readonly PlayerState[]): boolean {
  return players.length > 0 && players.every((p) => p.status === 'down');
}

/** Nombre de joueurs debout (`status === 'alive'`). */
export function countAlive(players: readonly PlayerState[]): number {
  let n = 0;
  for (const p of players) if (p.status === 'alive') n++;
  return n;
}

/**
 * Relève d'office tous les joueurs à terre (passage à la salle suivante) : PV pleins, `status:'alive'`, invulnérabilité courte.
 * Efface aussi tous les liens/progressions de relevage (même des joueurs debout). MUTE les joueurs.
 * @returns ids des joueurs qui étaient à terre (pour émettre des effets), dans l'ordre du tableau
 */
export function reviveAllDowned(players: PlayerState[]): PlayerId[] {
  const revived: PlayerId[] = [];
  for (const p of players) {
    if (p.status === 'down') {
      p.status = 'alive';
      p.hp = p.maxHp;
      p.invulnMs = REVIVE_INVULN_MS;
      p.attackCooldownMs = 0;
      p.attackAnimMs = 0;
      revived.push(p.id);
    }
    p.revivingId = null;
    p.reviverId = null;
    p.reviveProgressMs = 0;
  }
  return revived;
}

/** Options de `resetPlayersForRoom`. */
export interface ResetPlayersOptions {
  /** Remet `kills` à 0 (défaut : false — `kills` est conservé). */
  resetKills?: boolean;
}

/**
 * Réinitialise les joueurs pour (re)démarrer une salle : position (`spawnsPx[i % spawnsPx.length]`, i = index du joueur
 * dans le tableau), PV pleins, `status:'alive'`, timers (invuln, cooldown, anim) à 0, liens de relevage effacés,
 * `moving=false`, `keys=[]` (les clés sont propres à une salle), spécial PRÊT (`specialCooldownMs = specialAnimMs = 0`),
 * torche REMPLIE (`torchMs = TORCH_MAX_MS`), appel remis à zéro (`callMs = callCooldownMs = 0`).
 *
 * CONSERVÉS : `downCount` (stat de niveau), `kills` (sauf `opts.resetKills`), `facing`/`attackDir`, `prev` (pas de faux front
 * montant si un bouton est tenu pendant le chargement). MUTE les joueurs.
 *
 * @param players joueurs (mutés)
 * @param spawnsPx positions de départ en pixels (au moins 1 ; les valeurs sont copiées)
 * @param opts options
 */
export function resetPlayersForRoom(players: PlayerState[], spawnsPx: readonly Vec2[], opts: ResetPlayersOptions = {}): void {
  players.forEach((p, i) => {
    if (spawnsPx.length > 0) {
      const s = spawnsPx[i % spawnsPx.length];
      p.pos = { x: s.x, y: s.y };
    }
    p.hp = p.maxHp;
    p.status = 'alive';
    p.invulnMs = 0;
    p.attackCooldownMs = 0;
    p.attackAnimMs = 0;
    p.specialCooldownMs = 0;
    p.specialAnimMs = 0;
    p.torchMs = TORCH_MAX_MS;
    p.callMs = 0;
    p.callCooldownMs = 0;
    p.revivingId = null;
    p.reviverId = null;
    p.reviveProgressMs = 0;
    p.keys = [];
    p.moving = false;
    if (opts.resetKills) p.kills = 0;
  });
}

/**
 * Décrémente les timers d'un joueur de `dtMs` (planchers à 0) : `invulnMs`, `attackCooldownMs`, `attackAnimMs`,
 * `specialCooldownMs` (recharge du spécial), `specialAnimMs`, `callMs` (signal d'appel) et `callCooldownMs` (délai de récupération de l'appel).
 * S'applique aussi aux joueurs à terre. MUTE `p`.
 */
export function stepPlayerTimers(p: PlayerState, dtMs: number): void {
  p.invulnMs = Math.max(0, p.invulnMs - dtMs);
  p.attackCooldownMs = Math.max(0, p.attackCooldownMs - dtMs);
  p.attackAnimMs = Math.max(0, p.attackAnimMs - dtMs);
  p.specialCooldownMs = Math.max(0, (Number.isFinite(p.specialCooldownMs) ? p.specialCooldownMs : 0) - dtMs);
  p.specialAnimMs = Math.max(0, (Number.isFinite(p.specialAnimMs) ? p.specialAnimMs : 0) - dtMs);
  p.callMs = stepCallTimer(p.callMs, dtMs);
  p.callCooldownMs = stepCallTimer(p.callCooldownMs, dtMs);
}

// ───────────────────────────── Appel ─────────────────────────────

/**
 * Tolérance (ms) sur les minuteurs d'appel : le pas fixe vaut 1000/60 ms, et soustraire 60 fois ce pas à 3000 laisse un reste
 * de l'ordre de 1e-12 qui ferait durer l'immobilisation ou le signal un pas de trop. Un minuteur sous ce seuil vaut 0.
 */
export const CALL_EPSILON_MS = 1e-6;

/** Décrémente un minuteur d'appel (absent / non fini → 0 ; plancher 0 ; reste sous `CALL_EPSILON_MS` ramené à 0). */
function stepCallTimer(valueMs: number | undefined, dtMs: number): number {
  const v = typeof valueMs === 'number' && Number.isFinite(valueMs) ? valueMs : 0;
  const next = v - dtMs;
  return next > CALL_EPSILON_MS ? next : 0;
}

/** Le signal d'appel de ce joueur est-il en cours ? (joueur vivant et `callMs > 0`). */
export function isCalling(p: Pick<PlayerState, 'status' | 'callMs'>): boolean {
  return p.status === 'alive' && p.callMs > CALL_EPSILON_MS;
}

/**
 * Le joueur est-il IMMOBILISÉ par son appel ? Vrai pendant la 1re `CALL_FREEZE_MS` du signal, soit tant que
 * `callMs > CALL_DURATION_MS - CALL_FREEZE_MS`. Il ne se déplace pas, n'attaque pas, n'utilise pas son spécial, n'interagit pas et
 * ne relève personne (il peut encore subir des dégâts).
 */
export function isCallFrozen(p: Pick<PlayerState, 'status' | 'callMs'>): boolean {
  return p.status === 'alive' && p.callMs > CALL_DURATION_MS - CALL_FREEZE_MS + CALL_EPSILON_MS;
}

/** Peut-on lancer un appel ? Joueur vivant, aucun appel en cours, délai de récupération écoulé (la phase 'playing' est vérifiée par la simulation). */
export function canStartCall(p: Pick<PlayerState, 'status' | 'callMs' | 'callCooldownMs'>): boolean {
  const cd = typeof p.callCooldownMs === 'number' && Number.isFinite(p.callCooldownMs) ? p.callCooldownMs : 0;
  return p.status === 'alive' && !(p.callMs > CALL_EPSILON_MS) && cd <= CALL_EPSILON_MS;
}

/** Lance l'appel : `callMs = CALL_DURATION_MS`, `callCooldownMs = CALL_COOLDOWN_MS`. MUTE `p`. */
export function startCall(p: PlayerState): void {
  p.callMs = CALL_DURATION_MS;
  p.callCooldownMs = CALL_COOLDOWN_MS;
}

/** Annule le signal d'appel en cours (le délai de récupération n'est pas modifié). MUTE `p`. */
export function cancelCall(p: PlayerState): void {
  p.callMs = 0;
}

/**
 * Consomme le combustible de la torche d'un joueur pour UN pas (salle sombre uniquement). MUTE `p.torchMs`.
 *
 * Sans effet si la salle n'est pas sombre (`roomDark` faux), si le joueur est à terre ou si `dtMs` n'est pas > 0.
 * Sinon `torchMs` diminue de `dtMs` (plancher 0). Événements, détectés par franchissement de seuil (donc émis UNE seule fois
 * par descente, et de nouveau après une recharge) :
 *  - `torchLow` quand `torchMs` passe de > TORCH_MAX_MS × TORCH_LOW_FRACTION à ≤ ce seuil ;
 *  - `torchOut` quand `torchMs` atteint 0.
 *
 * @param p joueur (muté)
 * @param dtMs durée du pas (ms)
 * @param roomDark la salle courante est-elle sombre (`RoomDef.dark === true`) ?
 * @returns événements `torchLow` / `torchOut` éventuels
 */
export function stepPlayerTorch(p: PlayerState, dtMs: number, roomDark: boolean): SimEvent[] {
  if (!roomDark || p.status !== 'alive' || !(dtMs > 0)) return [];
  const before = Number.isFinite(p.torchMs) ? Math.max(0, p.torchMs) : 0;
  if (before <= 0) {
    p.torchMs = 0;
    return [];
  }
  const after = Math.max(0, before - dtMs);
  p.torchMs = after;
  const events: SimEvent[] = [];
  const threshold = TORCH_MAX_MS * TORCH_LOW_FRACTION;
  if (before > threshold && after <= threshold) events.push({ type: 'torchLow', playerId: p.id });
  if (after <= 0) events.push({ type: 'torchOut', playerId: p.id });
  return events;
}
