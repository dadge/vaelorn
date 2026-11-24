/**
 * Rendu d'un INVITÉ réseau (docs/NET.md § 7.2 et § 7.4) : logique PURE (aucun Phaser, aucune horloge système : le temps réel est fourni par l'appelant).
 *
 *  - `MirrorClock` : l'invité reçoit un état à 20 Hz (toutes les ~50 ms) ; les vues, elles, savent déjà interpoler entre deux états (`PosInterp.push` à `stepped`, `at(alpha)` à
 *    chaque frame). L'horloge réutilise ce mécanisme TEL QUEL, avec l'intervalle d'instantané à la place du pas de 16,7 ms : on affiche donc toujours un intervalle de retard
 *    (l'état précédent glisse vers le courant), et si l'instantané suivant tarde, la dernière position est TENUE (`alpha` = 1, aucune extrapolation) ;
 *    les instantanés ne font avancer l'affichage que sur la cadence régulière de l'intervalle (jamais à l'instant d'arrivée) : la gigue du réseau n'est pas rejouée à l'écran ;
 *  - correspondance joueur / vue : en partie réseau l'appareil local est le joueur `localPlayerId` (1..3 pour un invité) dans l'UNIQUE vue 0 ; les autres joueurs n'ont pas de vue.
 */
import { NET } from '../net/contracts';

/** Ce que l'horloge dit aux vues pour une frame de rendu. */
export interface MirrorFrame {
  /** Un nouvel instantané vient d'arriver (à vrai UNE seule frame : les vues poussent alors leur nouvelle position). */
  stepped: boolean;
  /** Part de l'intervalle d'instantané écoulée, dans [0, 1] (1 = on tient la dernière position). */
  alpha: number;
  /** Temps d'animation à passer aux vues (`GameState.timeMs` interpolé entre le précédent et le courant instantané : animations fluides à 60 Hz). */
  timeMs: number;
}

/** Intervalle d'interpolation utilisable : borné à [`NET.INTERP_MIN_MS`, `NET.INTERP_MAX_MS`], valeur nominale si non fini. */
export function clampSnapshotInterval(intervalMs: number): number {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return NET.SNAPSHOT_INTERVAL_MS;
  return Math.max(NET.INTERP_MIN_MS, Math.min(NET.INTERP_MAX_MS, intervalMs));
}

export class MirrorClock {
  private prevTimeMs = 0;
  private curTimeMs = 0;
  private sinceMs = 0;
  private interval: number = NET.SNAPSHOT_INTERVAL_MS;
  /** Le tout premier instantané : affiché tout de suite (stepped à la frame suivante). */
  private fresh = false;
  private fed = false;
  /** Temps d'état du plus récent instantané reçu mais pas encore « avancé » à l'écran (null : rien en attente). */
  private pendingTimeMs: number | null = null;
  /** La position est tenue (intervalle écoulé sans instantané en attente) : le prochain instantané repart de la position tenue, sans saut. */
  private held = false;

  /** Au moins un instantané a-t-il été reçu ? (avant : le temps d'animation est celui de l'état local, aucune interpolation.) */
  get hasSnapshot(): boolean {
    return this.fed;
  }

  /** Intervalle d'interpolation courant (ms). */
  get intervalMs(): number {
    return this.interval;
  }

  /**
   * Un NOUVEL instantané est appliqué. @param stateTimeMs `state.timeMs` de l'instantané @param intervalMs intervalle estimé entre instantanés (`NetSnapshot.intervalMs`).
   * Le premier instantané n'a pas de précédent : précédent = courant (aucun mouvement de temps à rattraper). Les suivants sont MIS EN ATTENTE : c'est `advance` qui les
   * fait avancer à l'écran sur la cadence régulière de l'intervalle (tampon de gigue d'un intervalle au plus), pas leur instant d'arrivée.
   */
  feed(stateTimeMs: number, intervalMs: number = NET.SNAPSHOT_INTERVAL_MS): void {
    const t = Number.isFinite(stateTimeMs) ? stateTimeMs : (this.pendingTimeMs ?? this.curTimeMs);
    this.interval = clampSnapshotInterval(intervalMs);
    if (!this.fed) {
      this.prevTimeMs = t;
      this.curTimeMs = t;
      this.sinceMs = 0;
      this.fresh = true;
      this.fed = true;
      this.held = false;
      this.pendingTimeMs = null;
      return;
    }
    this.pendingTimeMs = t; // un instantané plus récent écrase celui en attente (seul le dernier compte)
  }

  /**
   * Une frame de rendu de `dtMs` ms (négatif ou non fini : 0). La frame de l'arrivée du premier instantané affiche alpha = 0 (l'état précédent) : on a un intervalle de retard.
   *
   * Pas de gigue visible : un instantané arrivé EN AVANCE attend la fin de l'intervalle en cours (la phase `alpha` est conservée, le reste de l'intervalle est reporté sur le
   * segment suivant : aucun saut) ; un instantané en RETARD trouve la position tenue à la fin du segment précédent et repart de là avec alpha = 0 (aucun saut non plus).
   */
  advance(dtMs: number): MirrorFrame {
    if (!this.fed) return { stepped: false, alpha: 1, timeMs: 0 };
    let stepped = false;
    if (this.fresh) {
      this.fresh = false;
      stepped = true;
    } else {
      if (Number.isFinite(dtMs) && dtMs > 0) this.sinceMs += dtMs;
      if (this.pendingTimeMs !== null && this.sinceMs >= this.interval) {
        stepped = true;
        // retard : on tenait la fin du segment (alpha 1), le nouveau repart de 0 ; sinon on reporte le dépassement (plafonné : après une longue suspension, pas de saut)
        this.sinceMs = this.held ? 0 : Math.min(this.sinceMs - this.interval, this.interval * 0.5);
        this.prevTimeMs = this.curTimeMs;
        this.curTimeMs = this.pendingTimeMs;
        this.pendingTimeMs = null;
        this.held = false;
      } else if (this.sinceMs >= this.interval) {
        this.held = true; // intervalle écoulé, rien de nouveau : position tenue (aucune extrapolation)
      }
    }
    const alpha = Math.max(0, Math.min(1, this.sinceMs / this.interval));
    return { stepped, alpha, timeMs: this.prevTimeMs + (this.curTimeMs - this.prevTimeMs) * alpha };
  }

  /** Oublie tout (nouvelle partie dans la même scène : non utilisé aujourd'hui, une scène par partie). */
  reset(): void {
    this.prevTimeMs = 0;
    this.curTimeMs = 0;
    this.sinceMs = 0;
    this.interval = NET.SNAPSHOT_INTERVAL_MS;
    this.fresh = false;
    this.fed = false;
    this.pendingTimeMs = null;
    this.held = false;
  }
}

/**
 * Indice de la VUE d'un joueur : partie locale (`localPlayerId` null) = identité (joueur i = vue i, comme en écran partagé et dans le tutoriel) ; partie réseau = 0 pour le joueur
 * local, -1 (aucune vue) pour les autres. Un indice -1 donne `undefined` quand on indexe un tableau de HUD : les lectures existantes (`huds[...]?.`) deviennent des no-op.
 */
export function viewOfPlayer(localPlayerId: number | null, playerId: number): number {
  if (localPlayerId === null) return playerId;
  return playerId === localPlayerId ? 0 : -1;
}

/** Identifiant du joueur affiché dans la vue `viewIndex` (réciproque de `viewOfPlayer`) : en réseau, la seule vue est celle du joueur local. */
export function playerOfView(localPlayerId: number | null, viewIndex: number): number {
  return localPlayerId === null ? viewIndex : localPlayerId;
}
