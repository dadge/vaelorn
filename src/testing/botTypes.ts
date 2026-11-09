/**
 * Types et valeurs par défaut partagés par la bibliothèque de bots de test (src/testing).
 *
 * Ce module ne contient AUCUNE logique de simulation : uniquement des contrats (actions de script, options de
 * comportements de fond, statistiques) importés par `botKit.ts`, `botBrain.ts`, `botActions.ts` et `diagnostics.ts`.
 */
import { TILE } from '../core/constants';
import type { ActionFrame, PlayerId, PlayerState, TileXY, Vec2 } from '../core/types';
import type { BotPlayer, BotRun } from './botKit';

// ───────────────────────────── Cibles de déplacement ─────────────────────────────

/** Cible : un tableau `[colonne, ligne]` = TUILE (on vise son centre) ; un objet `{x, y}` = point en PIXELS. */
export type Target = TileXY | Vec2;
/** Cible statique, ou fonction évaluée à chaque pas (cible mobile, mécanisme retrouvé par id…). */
export type TargetLike = Target | ((run: BotRun, bot: BotPlayer) => Target);
/** Condition évaluée sur la partie en cours (pour `waitUntil`, `standOn({until})`, `runUntil`…). */
export type Cond = (run: BotRun) => boolean;

/** Vrai si la cible est une tuile `[x, y]`. */
export function isTileTarget(t: Target): t is TileXY {
  return Array.isArray(t);
}

/** Convertit une cible en point pixel (centre de la tuile pour une tuile). */
export function targetToPx(t: Target): Vec2 {
  if (Array.isArray(t)) return { x: (t[0] + 0.5) * TILE, y: (t[1] + 0.5) * TILE };
  return { x: t.x, y: t.y };
}

/** Évalue une `TargetLike` (fonction ou valeur) et la convertit en point pixel. */
export function resolveTarget(t: TargetLike, run: BotRun, bot: BotPlayer): Vec2 {
  return targetToPx(typeof t === 'function' ? t(run, bot) : t);
}

// ───────────────────────────── Actions de script ─────────────────────────────

/** Résultat d'un `tick` d'action : en cours, terminée, ou échouée (voir `ActionCtx.fail`). */
export type ActionStatus = 'running' | 'done' | 'failed';

/** Drapeaux d'activation des comportements de fond pour un appel ponctuel. */
export interface BackgroundFlags {
  combat: boolean;
  revive: boolean;
  regroup: boolean;
  /** Ramassage de la nourriture / des cristaux de soin proches quand les PV sont bas (ignoré si l'option `eat` du bot est fausse ; défaut : actif). */
  eat?: boolean;
  /** Ramassage de l'équipement au sol proche (ignoré si l'option `pickGear` du bot est fausse ; défaut : actif). */
  gear?: boolean;
}

/**
 * Contexte passé à une action à chaque pas. L'action écrit sa sortie via `set` (ce qui « consomme » le pas) ou
 * délègue aux comportements de fond via `useBackground`.
 */
export interface ActionCtx {
  readonly run: BotRun;
  readonly bot: BotPlayer;
  readonly id: PlayerId;
  /** État vivant du joueur (lecture seule). */
  readonly player: PlayerState;
  readonly dtMs: number;
  /** Temps simulé écoulé depuis le début de l'action (hors temps passé à terre), en ms. */
  readonly elapsedMs: number;
  /** Frame de sortie du pas (mutable via `set`). */
  readonly frame: ActionFrame;
  /** Vrai si l'action courante a déjà produit la frame de ce pas. */
  consumed: boolean;
  /** Fusionne `partial` dans la frame de sortie et marque le pas comme consommé. */
  set(partial: Partial<ActionFrame>): void;
  /**
   * Laisse les comportements de fond (combat, relevage, regroupement selon `flags`) produire la frame du pas.
   * @returns true si l'un d'eux a agi (le pas est alors consommé)
   */
  useBackground(flags?: Partial<BackgroundFlags>): boolean;
  /** Déclare l'échec de l'action (raison lisible, reprise dans `run.failures` et les diagnostics) et retourne 'failed'. */
  fail(reason: string): 'failed';
}

/** Exécuteur pas à pas d'une action (créé à l'activation de l'action : il peut porter un état). */
export interface ActionRunner {
  /**
   * Appelé à chaque pas tant que l'action est en tête de file. Retourne 'running' (l'action garde la main ce pas),
   * 'done' (terminée : si aucune frame n'a été écrite, l'action suivante démarre dans le MÊME pas) ou 'failed'.
   */
  tick(ctx: ActionCtx): ActionStatus;
}

/** Action de script : un libellé (diagnostics) et une fabrique d'exécuteur (réutilisable : un exécuteur par activation). */
export interface BotAction {
  readonly label: string;
  create(): ActionRunner;
  /**
   * Vrai pour les actions passives (attente) pendant lesquelles les comportements de fond (combat, relevage) peuvent agir :
   * le joueur est alors considéré « disponible » (désignation du sauveteur).
   */
  readonly background?: boolean;
}

/** Fabrique d'action (aide). */
export function makeAction(label: string, create: () => ActionRunner): BotAction {
  return { label, create };
}

// ───────────────────────────── Comportements de fond ─────────────────────────────

/** Options des comportements de fond d'un bot (modifiables par joueur via `run.setBackground`). */
export interface BackgroundOptions {
  /** Auto-combat : approche l'ennemi le plus proche et l'attaque. */
  combat: boolean;
  /** Auto-relevage d'un allié à terre. */
  revive: boolean;
  /** Regroupement : rejoint l'allié le plus proche quand on est inactif et loin. */
  regroup: boolean;
  /** Esquive simple (projectiles, télégraphes d'attaque). */
  dodge: boolean;
  /** Rayon (px) dans lequel l'auto-combat de fond prend une cible. */
  engageRadius: number;
  /** Rayon (px) dans lequel un ennemi interrompt un `goTo` (si `fight` actif). */
  reactRadius: number;
  /** Aucun ennemi dans ce rayon (px) autour de l'allié à terre pour commencer à le relever. */
  reviveSafeRadius: number;
  /** En dessous de cette fraction de PV, avec un ennemi proche, le bot abandonne le relevage et se bat. */
  criticalHpFrac: number;
  /** Distance (px) à partir de laquelle un bot inactif rejoint ses alliés. */
  regroupRadius: number;
  /** Distance minimale (px) que les tireurs essaient de garder avec les ennemis. */
  kiteDistance: number;
  /**
   * Brique « sources de vie » : quand ses PV sont sous `eatBelowFrac`, le bot va ramasser la nourriture au sol ou utiliser un cristal de soin intact
   * situé à moins de `eatRadius` px (avant de combattre). Désactivée par défaut : les bots existants ne ramassent rien (leurs résultats sont inchangés) ;
   * la calibration de l'équilibrage l'active.
   */
  eat: boolean;
  /** Fraction de PV (0..1) sous laquelle le bot va chercher de la nourriture (défaut 0,7). */
  eatBelowFrac: number;
  /** Rayon (px) dans lequel le bot repère nourriture et cristaux (défaut 160). */
  eatRadius: number;
  /**
   * Brique « équipement » : le bot va ramasser l'objet d'équipement au sol, à moins de `gearRadius` px, qui est STRICTEMENT meilleur que le sien et qui ne lui
   * est pas verrouillé (le contact suffit : ramassage automatique). Désactivée par défaut (les bots existants ne ramassent rien) ; la calibration l'active.
   */
  pickGear: boolean;
  /** Rayon (px) dans lequel le bot repère l'équipement au sol (défaut 140). */
  gearRadius: number;
}

/** Valeurs par défaut des comportements de fond (tous activés). */
export const DEFAULT_BACKGROUND: Readonly<BackgroundOptions> = Object.freeze({
  combat: true,
  revive: true,
  regroup: true,
  dodge: true,
  engageRadius: 150,
  reactRadius: 36,
  reviveSafeRadius: 48,
  criticalHpFrac: 0.25,
  regroupRadius: 90,
  kiteDistance: 30,
  eat: false,
  eatBelowFrac: 0.7,
  eatRadius: 160,
  pickGear: false,
  gearRadius: 140,
});

// ───────────────────────────── Statistiques ─────────────────────────────

/** Statistiques cumulées d'un joueur pendant la partie. */
export interface PlayerRunStats {
  /** Nombre de fois mis à terre. */
  downs: number;
  /** Points de vie perdus (somme des dégâts réellement subis). */
  hpLost: number;
  /** Relevages réussis EFFECTUÉS par ce joueur (comme sauveteur). */
  revivesDone: number;
  /** Nombre de fois relevé par un allié. */
  revivedTimes: number;
  /** Ennemis tués par ce joueur. */
  kills: number;
}

/** Statistiques d'une salle (cumul sur toutes les tentatives de la salle). */
export interface RoomRunStats {
  roomId: string;
  roomIndex: number;
  /** Nombre d'entrées dans la salle (1 + nombre de redémarrages). */
  entries: number;
  /** Temps simulé passé dans la salle (ms), tentatives et délais de transition inclus. */
  timeMs: number;
  /** Instant (temps de jeu, ms) où la salle a été validée, ou null. */
  clearedAtMs: number | null;
  /** Défaites collectives dans cette salle. */
  wipes: number;
  /** Par joueur (index = PlayerId) : fois à terre dans cette salle. */
  downs: number[];
  /** Par joueur : PV perdus dans cette salle. */
  hpLost: number[];
  /** Par joueur : relevages effectués dans cette salle. */
  revivesDone: number[];
  /** Par joueur : ennemis tués dans cette salle. */
  kills: number[];
}

/** Statistiques globales d'une partie de bots. */
export interface RunStats {
  /** Temps de jeu simulé total (ms). */
  timeMs: number;
  /** Défaites collectives totales. */
  wipes: number;
  players: PlayerRunStats[];
  rooms: RoomRunStats[];
}

/** Échec d'une action de script (voir `BotRun.failures`). */
export interface ActionFailure {
  timeMs: number;
  playerId: PlayerId;
  roomId: string;
  label: string;
  reason: string;
}

/** Entrée du journal d'événements récents (diagnostics). */
export interface LoggedEvent {
  timeMs: number;
  text: string;
}
