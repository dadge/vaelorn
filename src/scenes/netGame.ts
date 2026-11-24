/**
 * Logique PURE de `GameScene` en partie RÉSEAU (docs/NET.md § 7) : aucun Phaser, aucune horloge système (les instants sont fournis par la scène). Extraite pour être testée sous Node
 * et pour que la scène (déjà longue) ne porte que le branchement.
 *
 *  - entrées de l'HÔTE : les siennes (joueur 0) + celles des invités ;
 *  - garde des instantanés de l'INVITÉ : un instantané (état ET événements) n'est appliqué qu'une fois, dans l'ordre ;
 *  - état de la liaison (« en attente de l'hôte », « connexion instable ») ;
 *  - joueurs perdus d'après le masque des connectés ; entrées du bandeau d'équipe ;
 *  - décision de fin de niveau.
 */
import type { ActionFrame, GameState, PlayerId, TickInputs } from '../core/types';
import { NET, peerConnected, type NetRole } from '../net/contracts';

/** Frame d'entrée vide (jamais mutée). */
export const NET_EMPTY_FRAME: Readonly<ActionFrame> = Object.freeze({ moveX: 0, moveY: 0, attack: false, interact: false, revive: false, special: false, call: false, heart: false });

/**
 * Entrées d'un pas de l'HÔTE : celles des invités (`remote`, déjà par identifiant de jeu) + la frame du joueur local, qui est TOUJOURS le joueur 0. Une entrée distante qui porterait
 * la clé 0 est ignorée : un invité ne peut pas piloter l'hôte. Sans frame locale (menu de pause ouvert), le joueur 0 reçoit une frame vide.
 */
export function composeHostInputs(remote: TickInputs, local: ActionFrame | undefined): TickInputs {
  const out: TickInputs = {};
  for (const key of [1, 2, 3] as const) {
    const f = remote[key];
    if (f) out[key] = f;
  }
  out[0] = local ?? NET_EMPTY_FRAME;
  return out;
}

/** Garde des instantanés reçus : l'état ET les événements d'un instantané ne sont appliqués qu'une seule fois, et jamais un instantané plus ancien que le dernier appliqué. */
export class SnapshotGate {
  private lastN = -1;
  private lastTick = -1;

  /** Dernier compteur `n` accepté (-1 : aucun). */
  get last(): number {
    return this.lastN;
  }

  /**
   * Faut-il appliquer cet instantané ? Vrai si son compteur `n` est strictement supérieur au dernier accepté ET son numéro de pas n'a pas reculé. Un doublon (même `n` ou même
   * numéro de pas livré deux fois) rend faux : ses événements ne sont pas rejoués.
   */
  accept(snap: { n: number; tick: number }): boolean {
    if (!Number.isFinite(snap.n) || !Number.isFinite(snap.tick)) return false;
    if (snap.n <= this.lastN || snap.tick < this.lastTick) return false;
    this.lastN = snap.n;
    this.lastTick = snap.tick;
    return true;
  }

  reset(): void {
    this.lastN = -1;
    this.lastTick = -1;
  }
}

/** Ce que l'invité affiche de la liaison : `waiting` = aucun instantané encore reçu, `lag` = le silence dure, `ok` = tout va bien. */
export type NetStall = 'waiting' | 'lag' | 'ok';

/** État de la liaison d'un invité. @param lastSnapMs instant (même horloge que `nowMs`) du dernier instantané reçu, ou null s'il n'y en a pas eu. */
export function stallStatus(nowMs: number, lastSnapMs: number | null): NetStall {
  if (lastSnapMs === null) return 'waiting';
  return nowMs - lastSnapMs > NET.STALL_WARN_MS ? 'lag' : 'ok';
}

/** Joueurs (hors joueur local) qui étaient connectés au masque précédent et ne le sont plus : ceux dont on annonce la perte. */
export function lostPeers(prevMask: number | null, mask: number, playerCount: number, localPlayerId: number): PlayerId[] {
  const out: PlayerId[] = [];
  if (prevMask === null) return out;
  for (let id = 0; id < Math.min(playerCount, NET.MAX_PLAYERS); id++) {
    if (id !== localPlayerId && peerConnected(prevMask, id) && !peerConnected(mask, id)) out.push(id as PlayerId);
  }
  return out;
}

/** Nom affiché d'un joueur d'après les noms de la session (repli : « J<n> »). */
export function playerDisplayName(names: readonly string[], id: number): string {
  const n = names[id];
  return typeof n === 'string' && n.length > 0 ? n : `J${id + 1}`;
}

/** Ligne du bandeau d'équipe (les autres joueurs seulement). */
export interface TeamStripEntry {
  id: PlayerId;
  name: string;
  hp: number;
  maxHp: number;
  down: boolean;
  /** Joueur déconnecté (son héros reste immobile). */
  lost: boolean;
}

/** Entrées du bandeau d'équipe : un par AUTRE joueur de la partie, dans l'ordre des identifiants. `connectedMask` null = on ne sait pas (tous connectés). */
export function teamStripEntries(state: GameState, localPlayerId: number, names: readonly string[], connectedMask: number | null): TeamStripEntry[] {
  const out: TeamStripEntry[] = [];
  for (const p of state.players) {
    if (p.id === localPlayerId) continue;
    out.push({
      id: p.id,
      name: playerDisplayName(names, p.id),
      hp: Math.max(0, Math.ceil(p.hp)),
      maxHp: p.maxHp,
      down: p.status === 'down',
      lost: connectedMask !== null && !peerConnected(connectedMask, p.id),
    });
  }
  return out;
}

/** Que faire de la fin de niveau ? `endGame` : l'hôte met fin à la partie pour tous (la célébration est terminée) ; `await` : l'invité attend le message `end` de l'hôte ; `none` : rien encore. */
export type LevelEndAction = 'none' | 'await' | 'endGame';

export function levelEndAction(role: NetRole, finishing: boolean, finishMs: number, celebrationMs: number): LevelEndAction {
  if (!finishing) return 'none';
  if (role === 'client') return 'await';
  return finishMs >= celebrationMs ? 'endGame' : 'none';
}

/** Entrée locale à utiliser : vide tant que le menu de pause est ouvert (la partie continue, mais le joueur ne la pilote plus), sinon celle de l'appareil. */
export function localNetFrame(paused: boolean, inputs: TickInputs): ActionFrame | undefined {
  return paused ? undefined : inputs[0];
}
