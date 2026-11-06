/**
 * Logique PURE de la boucle de jeu de GameScene : accumulateur de temps réel → pas de simulation fixes,
 * et verrouillage des appuis courts (un bouton pressé puis relâché entre deux pas n'est jamais perdu).
 */
import { SIM_STEP_MS } from '../core/constants';
import type { ActionFrame, PlayerId, TickInputs } from '../core/types';

/** Nombre maximal de pas de simulation par frame de rendu (évite la spirale de la mort). */
export const MAX_STEPS_PER_FRAME = 5;
/** Plafond (ms) du temps réel pris en compte par frame (onglet en arrière-plan, point d'arrêt…). */
export const MAX_FRAME_MS = 250;

export interface StepPlan {
  /** Nombre de pas de simulation à exécuter cette frame (0..maxSteps). */
  steps: number;
  /** Reste de l'accumulateur (ms) après les pas (toujours dans [0, stepMs)). */
  accumulatorMs: number;
  /** Part du pas courant déjà écoulée (0..1) : sert à l'interpolation de rendu. */
  alpha: number;
  /** Vrai si du retard a été abandonné (plus de `maxSteps` pas dus). */
  dropped: boolean;
}

/**
 * Planifie les pas de simulation d'une frame.
 *
 * @param accumulatorMs reste de l'accumulateur de la frame précédente
 * @param frameDtMs temps réel écoulé depuis la frame précédente (négatif/NaN ⇒ 0 ; plafonné à `MAX_FRAME_MS`)
 * @param stepMs durée d'un pas (défaut `SIM_STEP_MS`)
 * @param maxSteps plafond de pas par frame (défaut 5) ; au-delà, le retard est abandonné
 */
export function planSteps(accumulatorMs: number, frameDtMs: number, stepMs: number = SIM_STEP_MS, maxSteps: number = MAX_STEPS_PER_FRAME): StepPlan {
  const dt = Number.isFinite(frameDtMs) && frameDtMs > 0 ? Math.min(frameDtMs, MAX_FRAME_MS) : 0;
  const base = Number.isFinite(accumulatorMs) && accumulatorMs > 0 ? accumulatorMs : 0;
  let acc = base + dt;
  let steps = Math.floor(acc / stepMs + 1e-9);
  let dropped = false;
  if (steps > maxSteps) {
    steps = maxSteps;
    acc = 0;
    dropped = true;
  } else {
    acc -= steps * stepMs;
    if (acc < 0) acc = 0;
  }
  return { steps, accumulatorMs: acc, alpha: stepMs > 0 ? Math.min(1, acc / stepMs) : 0, dropped };
}

function mergeFrame(a: ActionFrame | undefined, b: ActionFrame | undefined): ActionFrame | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    moveX: b.moveX,
    moveY: b.moveY,
    attack: a.attack || b.attack,
    interact: a.interact || b.interact,
    revive: a.revive || b.revive,
    // `special` est optionnel dans ActionFrame : il doit être fusionné comme les autres boutons, sinon le spécial est perdu
    // dès qu'une frame sans pas précède une frame fusionnée (écrans >= 120 Hz).
    special: a.special === true || b.special === true,
  };
}

/**
 * Fusionne deux relevés d'entrées successifs : les BOUTONS sont combinés en OU (un appui court entre deux pas est
 * conservé), les AXES prennent la valeur la plus récente (`next`). `prev` peut être null.
 */
export function mergeTickInputs(prev: TickInputs | null, next: TickInputs): TickInputs {
  if (!prev) return next;
  const out: TickInputs = {};
  for (const id of [0, 1, 2, 3] as PlayerId[]) {
    const m = mergeFrame(prev[id], next[id]);
    if (m) out[id] = m;
  }
  return out;
}
