/**
 * Minuterie d'inactivité du mode démo. Module PUR : l'horloge est INJECTÉE (`() => ms`), aucun DOM, aucun `Date.now`.
 *
 * Le compteur n'avance que si la minuterie est ARMÉE (l'écran-titre principal est affiché) ET non mise en PAUSE (onglet caché).
 * Toute activité (`reset`) le remet à zéro. `poll()` retourne true UNE seule fois quand le seuil est atteint ; il faut ensuite
 * `reset()` / `setActive(true)` pour la réarmer (la scène de menu la recrée de toute façon à chaque retour de démo).
 */
export interface IdleTimerOptions {
  /** Seuil d'inactivité (ms), > 0. */
  thresholdMs: number;
  /** Horloge monotone en ms (ex. `performance.now`). */
  clock: () => number;
  /** Armée dès la création (défaut true). */
  active?: boolean;
}

export class IdleTimer {
  private readonly thresholdMs: number;
  private readonly clock: () => number;
  private active: boolean;
  private paused = false;
  private fired = false;
  /** Temps d'inactivité accumulé (ms) jusqu'à `lastTick`. */
  private accumulatedMs = 0;
  private lastTick: number;

  constructor(opts: IdleTimerOptions) {
    this.thresholdMs = Number.isFinite(opts.thresholdMs) && opts.thresholdMs > 0 ? opts.thresholdMs : 1;
    this.clock = opts.clock;
    this.active = opts.active ?? true;
    this.lastTick = this.clock();
  }

  /** Ajoute le temps écoulé depuis le dernier appel, si la minuterie tourne. */
  private advance(): void {
    const now = this.clock();
    if (this.active && !this.paused && !this.fired) {
      const dt = now - this.lastTick;
      if (dt > 0) this.accumulatedMs += dt;
    }
    this.lastTick = now;
  }

  /** Temps d'inactivité accumulé (ms). */
  get elapsedMs(): number {
    this.advance();
    return this.accumulatedMs;
  }

  /** Temps restant avant le déclenchement (ms, ≥ 0). */
  get remainingMs(): number {
    return Math.max(0, this.thresholdMs - this.elapsedMs);
  }

  get isActive(): boolean {
    return this.active;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** Une activité a eu lieu : le compteur repart de zéro (et la minuterie est réarmée si elle avait déclenché). */
  reset(): void {
    this.accumulatedMs = 0;
    this.fired = false;
    this.lastTick = this.clock();
  }

  /**
   * Arme / désarme (écran-titre principal affiché ou non). Changer d'état remet le compteur à zéro : revenir d'un sous-écran
   * relance un compte complet, jamais un reliquat.
   */
  setActive(active: boolean): void {
    if (active === this.active) return;
    this.advance();
    this.active = active;
    this.reset();
  }

  /** Pause (onglet caché) / reprise : le temps passé en pause n'est PAS compté, le reste est conservé. */
  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.advance();
    this.paused = paused;
    this.lastTick = this.clock();
  }

  /** true UNE fois quand le seuil d'inactivité est atteint (minuterie armée et non en pause). */
  poll(): boolean {
    this.advance();
    if (!this.active || this.paused || this.fired) return false;
    if (this.accumulatedMs >= this.thresholdMs) {
      this.fired = true;
      return true;
    }
    return false;
  }
}
