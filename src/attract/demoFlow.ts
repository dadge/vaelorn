/**
 * Déroulement d'une démo (PUR, testé sous Node) : chronomètre en temps réel, sortie (fin de durée OU action du joueur), clignotement
 * des libellés et fenêtre de grâce qui avale l'entrée ayant interrompu la démo.
 *
 * La scène de jeu ne fait que : (1) appeler `flow.update(dtMs, activité)` à chaque image, (2) lancer le fondu de sortie quand
 * `flow.exit` apparaît, (3) dessiner. Aucune règle ici n'a besoin de Phaser ni du DOM.
 */
import { ATTRACT_INPUT_FADE_MS, ATTRACT_RETURN_GRACE_MS, ATTRACT_TIMEOUT_FADE_MS } from './config';

/** Pourquoi la démo se termine. */
export type DemoExitReason = 'timeout' | 'input';

/** Sortie décidée : raison et durée du fondu au noir (ms) avant de revenir au menu. */
export interface DemoExit {
  reason: DemoExitReason;
  fadeMs: number;
}

/** Plafond (ms) d'un `dtMs` pris en compte : une image très longue (machine saturée) ne « consomme » pas la démo d'un coup. */
const MAX_DT_MS = 250;

export class DemoFlow {
  private elapsed = 0;
  private decided: DemoExit | null = null;

  /** @param durationMs durée de la démo en temps réel (ms) */
  constructor(readonly durationMs: number) {}

  /** Temps réel écoulé depuis le début de la démo (ms). */
  get elapsedMs(): number {
    return this.elapsed;
  }

  /** Temps restant (ms, ≥ 0). */
  get remainingMs(): number {
    return Math.max(0, this.durationMs - this.elapsed);
  }

  /** Sortie décidée (null tant que la démo continue). */
  get exit(): DemoExit | null {
    return this.decided;
  }

  /**
   * Fait avancer le chronomètre et décide de la sortie. Une action du joueur l'emporte sur la fin de durée (elle est décidée la
   * première) ; une fois la sortie décidée, elle ne change plus.
   * @param dtMs temps réel écoulé depuis l'image précédente
   * @param activity true si le joueur a fait quelque chose (touche, clic, manette…)
   * @returns la sortie décidée à CET appel (une seule fois), sinon null
   */
  update(dtMs: number, activity: boolean): DemoExit | null {
    if (this.decided) return null;
    if (activity) return this.interrupt();
    const dt = Number.isFinite(dtMs) && dtMs > 0 ? Math.min(dtMs, MAX_DT_MS) : 0;
    this.elapsed += dt;
    if (this.elapsed >= this.durationMs) {
      this.decided = { reason: 'timeout', fadeMs: ATTRACT_TIMEOUT_FADE_MS };
      return this.decided;
    }
    return null;
  }

  /** Interrompt la démo par une action du joueur (sortie immédiate, fondu court). Sans effet si la sortie est déjà décidée. */
  interrupt(): DemoExit | null {
    if (this.decided) return null;
    this.decided = { reason: 'input', fadeMs: ATTRACT_INPUT_FADE_MS };
    return this.decided;
  }
}

/** Période (ms) du clignotement des libellés « DÉMO » et de l'invite. */
export const BLINK_PERIOD_MS = 1000;
/** Part de la période pendant laquelle le libellé est visible. */
export const BLINK_VISIBLE_FRACTION = 0.65;

/**
 * Le libellé clignotant est-il visible à l'instant `timeMs` ? Cycle de `BLINK_PERIOD_MS`, visible `BLINK_VISIBLE_FRACTION` du cycle
 * (début de cycle visible). `phaseMs` décale le cycle (l'invite clignote en décalé de la bannière).
 */
export function blinkVisible(timeMs: number, phaseMs = 0): boolean {
  if (!Number.isFinite(timeMs)) return true;
  const t = (((timeMs + phaseMs) % BLINK_PERIOD_MS) + BLINK_PERIOD_MS) % BLINK_PERIOD_MS;
  return t < BLINK_PERIOD_MS * BLINK_VISIBLE_FRACTION;
}

/**
 * Fenêtre de grâce : après un retour de démo, les entrées sont avalées pendant `graceMs`.
 * @param nowMs horloge courante (ms) ; `untilMs` : fin de la grâce (null = pas de grâce)
 */
export function graceActive(nowMs: number, untilMs: number | null): boolean {
  return untilMs !== null && nowMs < untilMs;
}

/** Fin de la fenêtre de grâce pour un retour de démo survenu à `nowMs` (ms). */
export function graceUntil(nowMs: number, graceMs: number = ATTRACT_RETURN_GRACE_MS): number {
  return nowMs + graceMs;
}

/** Clé i18n de l'invite du bas : libellé « toucher l'écran » sur appareil tactile, libellé générique « touche » sinon. */
export function demoPromptKey(touch: boolean): 'attract.prompt' | 'attract.prompt.touch' {
  return touch ? 'attract.prompt.touch' : 'attract.prompt';
}
