/**
 * Logique PURE de la boucle de jeu de GameScene : accumulateur de temps réel → pas de simulation fixes,
 * et verrouillage des appuis courts (un bouton pressé puis relâché entre deux pas n'est jamais perdu).
 */
import { MAX_PLAYERS, SIM_STEP_MS } from '../core/constants';
import type { ActionFrame, PlayerId, TickInputs } from '../core/types';

/** Identifiants de joueur possibles (0..MAX_PLAYERS-1). */
const PLAYER_IDS: readonly PlayerId[] = Array.from({ length: MAX_PLAYERS }, (_, i) => i as PlayerId);

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
    // idem pour `call` (optionnel) : un appui court sur « appeler » entre deux pas ne doit pas être perdu
    call: a.call === true || b.call === true,
    // idem pour `heart` (B, utiliser le cœur) : un appui court entre deux pas ne doit pas être perdu
    heart: a.heart === true || b.heart === true,
  };
}

/**
 * Fusionne deux relevés d'entrées successifs : les BOUTONS sont combinés en OU (un appui court entre deux pas est
 * conservé), les AXES prennent la valeur la plus récente (`next`). `prev` peut être null.
 */
export function mergeTickInputs(prev: TickInputs | null, next: TickInputs): TickInputs {
  if (!prev) return next;
  const out: TickInputs = {};
  for (const id of PLAYER_IDS) {
    const m = mergeFrame(prev[id], next[id]);
    if (m) out[id] = m;
  }
  return out;
}

/**
 * Entrées avec `heart` (B) forcé à faux pour tous les joueurs, SANS modifier l'argument. Renvoie l'argument lui-même s'il n'y a rien à masquer (aucune allocation).
 */
export function maskHeartInputs(inputs: TickInputs): TickInputs {
  let any = false;
  for (const id of PLAYER_IDS) if (inputs[id]?.heart === true) any = true;
  if (!any) return inputs;
  const out: TickInputs = {};
  for (const id of PLAYER_IDS) {
    const f = inputs[id];
    if (f) out[id] = f.heart === true ? { ...f, heart: false } : f;
  }
  return out;
}

/**
 * GARDE du bouton B (« utiliser le cœur »), PAR JOUEUR. Dans les menus, la pause et les dialogues, B est « retour » : le B qui vient de fermer la pause (ou qui était encore tenu à l'ouverture de la
 * scène) ne doit JAMAIS soigner au pas suivant. Armée, la garde masque le B de chaque joueur jusqu'à ce qu'un relevé le montre RELÂCHÉ chez CE joueur : il se désarme alors seul et son prochain
 * appui est un vrai front montant pour la simulation. Un joueur qui garde B enfoncé n'empêche donc jamais un autre joueur d'utiliser le sien. Pure (aucune horloge) et déterministe.
 */
export class HeartInputGuard {
  private readonly armed: boolean[] = PLAYER_IDS.map(() => false);

  /** @param armed armée dès la création (défaut true : une scène qui démarre avec B encore tenu ne soigne pas) */
  constructor(armed = true) {
    if (armed) this.arm();
  }

  /** Arme la garde pour tous les joueurs (fermeture de la pause, reprise après un menu). */
  arm(): void {
    this.armed.fill(true);
  }

  get isArmed(): boolean {
    return this.armed.some(Boolean);
  }

  /** Filtre les entrées d'un relevé : masque le B des joueurs armés qui le tiennent ; un joueur armé dont B est relâché (ou absent) est désarmé. */
  filter(inputs: TickInputs): TickInputs {
    if (!this.isArmed) return inputs;
    let out = inputs;
    for (const id of PLAYER_IDS) {
      if (!this.armed[id]) continue;
      const f = inputs[id];
      if (f?.heart === true) {
        if (out === inputs) out = { ...inputs };
        out[id] = { ...f, heart: false };
      } else {
        this.armed[id] = false;
      }
    }
    return out;
  }
}

/** Options de simulation qui dépendent du MODE de la scène (partie normale, tutoriel, démo). Pure : testée, GameScene n'a plus qu'à la déballer. */
export interface ModeSimFlags {
  /** équipement : partie normale ET tutoriel (il y enseigne l'objet refusé et l'échange d'accessoire : objets POSÉS par script), pas en démo */
  gear: boolean;
  /** butin d'équipement ALÉATOIRE (objets et bonus des ennemis) : partie normale uniquement ; le tutoriel pose ses objets par script (aucun tirage parasite) */
  gearDrops: boolean;
  /** butin de vie aléatoire : partie normale et démo (le tutoriel pose ses cœurs par script) */
  loot: boolean;
  /** appel automatique : partie normale et tutoriel (il y enseigne les 4 déclencheurs : cœur, objet moins puissant, échange d'accessoire, croix rouge), pas en démo */
  autoCall: boolean;
  /** emplacement cœur : partie normale et tutoriel (il l'enseigne), PAS en démo (les pilotes automatiques n'utilisent pas B : ancien comportement) */
  heartSlot: boolean;
}

export function modeSimFlags(mode: { tutorial: boolean; demo: boolean }): ModeSimFlags {
  return { gear: !mode.demo, gearDrops: !mode.tutorial && !mode.demo, loot: !mode.tutorial, autoCall: !mode.demo, heartSlot: !mode.demo };
}
