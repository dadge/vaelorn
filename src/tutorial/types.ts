/**
 * Types du tutoriel (PUR : aucune dépendance à Phaser, au DOM, à Date ni à Math.random).
 *
 * Le tutoriel est un niveau-données (`src/levels/tutorial.ts`) joué par `GameScene` avec 2 joueurs simulés : le joueur
 * (id 0) et un PARTENAIRE SCRIPTÉ (id 1) piloté par une mini machine virtuelle (`partnerScript.ts`). Un DIRECTEUR
 * (`TutorialDirector.ts`) observe la simulation (événements + état) et enchaîne les ÉTAPES (`steps.ts`) : chaque étape
 * est validée par une ACTION du joueur (`Condition`), jamais par une simple lecture.
 * Tout l'état du directeur (`TutorialState`) est du JSON pur (snapshot / restore, déterminisme).
 */
import type { GearItem, PlayerId, SimEvent, TileXY, Vec2 } from '../core/types';

/** Famille d'appareil dont on affiche les noms de boutons. */
export type DeviceKind = 'keyboard' | 'gamepad' | 'gamepadPs' | 'touch';

/** Noms de boutons utilisables dans les textes (jetons `{move}`, `{action}`…). */
export type ButtonName = 'move' | 'action' | 'attack' | 'interact' | 'special' | 'call' | 'heart' | 'skip' | 'pause';

/** Zones du HUD que le tutoriel peut mettre en évidence (rectangles fournis par `PlayerHud.regions()`). */
export type HudRegionId = 'roomGoals' | 'personalGoal' | 'hearts' | 'heartSlot' | 'gear' | 'special' | 'keys' | 'torch' | 'prompt' | 'sign';

/** Condition évaluée sur l'état de la simulation (lecture seule). */
export type Condition =
  /** Déplacement cumulé du joueur (px) depuis le début de l'étape. */
  | { k: 'moved'; px: number }
  /** Le joueur est resté `ms` millisecondes devant le panneau `id` (même portée que la bulle du panneau). */
  | { k: 'nearSign'; id: string; ms: number }
  /**
   * Événement `type` survenu depuis le début de l'étape. `by` : joueur acteur (`playerId`, `byPlayer` ou `reviverId`) ;
   * `match` : champs de l'événement qui doivent être égaux ; `count` : nombre minimal d'occurrences (défaut 1).
   */
  | { k: 'event'; type: SimEvent['type']; by?: PlayerId; count?: number; match?: Record<string, unknown> }
  /** Exigence au sens de `isRequirementMet` (mécanisme actif, 'clear', 'obj:<id>'…). */
  | { k: 'req'; token: string }
  /** Objectif personnel accompli. */
  | { k: 'objective'; id: string }
  /** Plus aucun ennemi vivant ni apparition en attente. */
  | { k: 'enemiesGone' }
  /** La sortie de la salle est ouverte. */
  | { k: 'exitOpen' }
  /** Distance joueur ↔ partenaire (en tuiles) inférieure (`near`) ou supérieure (`far`) à `tiles`. */
  | { k: 'near' | 'far'; tiles: number }
  /** La torche du joueur s'est un peu consumée (elle n'est plus pleine). */
  | { k: 'torchUsed' }
  /** Le joueur porte au moins une clé. */
  | { k: 'holdsKey' }
  /** Le joueur a un cœur / demi-cœur rangé dans son emplacement cœur. */
  | { k: 'holdsHeart' }
  /** Le bloc poussable `id` est irrécupérable (collé à une paroi sur un axe où le socle est ailleurs : plus personne ne peut le ramener). */
  | { k: 'blockDead'; id: string }
  /** La zone du HUD est actuellement visible à l'écran. */
  | { k: 'regionVisible'; id: HudRegionId }
  | { k: 'all' | 'any'; of: Condition[] };

/** Cible d'un déplacement du partenaire. */
export type Target =
  | { tile: TileXY }
  | { mech: string }
  | { zone: string }
  | { spawn: number }
  | { exit: true }
  | { human: true }
  /** Le cœur / demi-cœur au sol le plus proche du partenaire (aucune cible = arrivé : rien à ramasser). */
  | { pickup: true }
  /** L'objet d'équipement au sol le plus proche du partenaire (aucune cible = arrivé : rien à ramasser). */
  | { gear: true };

/** Instruction de la machine virtuelle du partenaire. `essential` : doit être terminée même si l'étape est sautée. */
export type PartnerOp =
  /** Ne rien faire ; avec `until`, attendre la condition puis passer à la suite. */
  | { op: 'idle'; until?: Condition }
  | { op: 'walk'; at: Target; essential?: boolean }
  /** Marcher puis tenir la position (plaque, cercle) jusqu'à `until`. */
  | { op: 'stand'; at: Target; until?: Condition; essential?: boolean }
  /** Impulsion d'UN pas (front montant) puis relâchement. */
  | { op: 'press'; button: 'interact' | 'call'; essential?: boolean }
  /** Appeler toutes les `ms` (≥ 5200 : délai de récupération de l'appel = 5000) jusqu'à `until`. */
  | { op: 'callEvery'; ms: number; until: Condition }
  /** Marcher vers le joueur (à terre) et maintenir le relevage. */
  | { op: 'reviveHuman' }
  /** Rejoindre la zone de sortie et y rester. */
  | { op: 'goExit' };

/** Repère affiché dans le monde (flèche qui rebondit au-dessus de la cible). */
export type MarkerSpec =
  | { tile: TileXY }
  | { mech: string }
  | { sign: string }
  | { partner: true }
  | { exit: true }
  | { nearestEnemy: true };

export interface TutorialStepDef {
  /** Identifiant unique ; la clé de texte est `tutorial.step.<id>`. Les étapes `exit.*` mènent à la salle suivante. */
  id: string;
  /** Salle (id) où se joue l'étape. */
  room: string;
  /** `do` : validée par une action ; `tip` : se ferme seule après `minMs`, ne bloque jamais. */
  kind: 'do' | 'tip';
  /** Durée minimale d'affichage (ms de SIMULATION en jeu, hors pause). */
  minMs: number;
  /** Clé i18n du texte (jetons {move} {action} {attack} {interact} {special} {call} {skip} {pause} {name} {specialName}). */
  textKey: string;
  /** Tant que fausse : carte « en attente » ; le temps d'affichage ne court pas. */
  gate?: Condition;
  /** Condition de réussite (étape `do`). */
  done?: Condition;
  /** Boutons nommés par l'étape (repli compact « n/total · Attaque : X »). */
  buttons?: ButtonName[];
  /** Ne jamais replier la carte en une ligne : la consigne contient une contrainte (maintenir, durées) que le bouton seul ne résume pas. */
  noCompact?: boolean;
  /**
   * Étape PRÉREQUIS : la suite de la salle dépend de son résultat dans le monde (levier qui ouvre la herse, bloc sur le socle).
   * La sauter n'a aucun sens (les étapes suivantes seraient impossibles) : la puce devient « Salle suivante ».
   */
  prerequisite?: boolean;
  /** Condition qui rend l'étape irrécupérable (ex. bloc coincé) : l'astuce « bloqué » apparaît tout de suite au lieu d'attendre 45 s. */
  stuckWhen?: Condition;
  /** Zones du HUD à encadrer (celles qui n'existent pas à l'écran sont ignorées). */
  highlights?: HudRegionId[];
  markers?: MarkerSpec[];
  /** Barre pulsante au bord de la vue qui regarde le partenaire (s'il est hors champ). */
  edgeToPartner?: boolean;
  /** Programme du partenaire pendant l'étape (défaut : immobile). */
  partner?: PartnerOp[];
  /** Mise à terre scénarisée, `afterMs` après le début effectif de l'étape. */
  knockDown?: { afterMs: number; ids: PlayerId[] };
  /**
   * Mise en scène du SOIN et de l'ÉQUIPEMENT, `afterMs` après le début effectif de l'étape (une seule fois) : blessure d'un joueur (PV ramenés à `fraction` de ses PV max, sans jamais le mettre à terre ni
   * le soigner), cœurs posés au sol (durée de vie longue, `TUTORIAL_HEART_TTL_MS`), cœur rangé d'office, équipement porté et objets d'équipement posés au sol (`TUTORIAL_GEAR_TTL_MS`). Appliquée par la scène via `takeScripted()` (comme `knockDown`) : aucune règle de jeu ici.
   */
  script?: {
    afterMs: number;
    /** Équipe un joueur d'un objet (lui donner de quoi refuser un objet moins bon, ou un accessoire à échanger). Appliqué EN PREMIER. */
    equip?: { id: PlayerId; item: GearItem }[];
    /** Range un cœur dans l'emplacement d'un joueur s'il est vide (jamais de remplacement : un cœur déjà rangé est conservé). */
    giveHeart?: { id: PlayerId; kind: 'half' | 'full' }[];
    /**
     * Avec `giveHeart` : le cœur est REDONNÉ (même règle : emplacement vide seulement) tant que l'étape n'est pas finie et que ce joueur ne l'a pas utilisé sur un AUTRE joueur. Évite le blocage d'un appui
     * prématuré sur B (le cœur serait consommé sur soi, loin du partenaire, et la démonstration ne pourrait plus aboutir). Sans effet une fois le joueur soigné (B ne consomme rien à PV pleins).
     */
    keepHeart?: boolean;
    wound?: { id: PlayerId; fraction: number }[];
    hearts?: { tile: TileXY; kind: 'half' | 'full' }[];
    /** Objets d'équipement posés au sol (durée de vie longue), non verrouillés. */
    gear?: { tile: TileXY; item: GearItem }[];
  };
}

/** Action de mise en scène à appliquer à la simulation (voir `TutorialStepDef.script`) : coordonnées déjà résolues en pixels. */
export type ScriptedAction =
  | { k: 'wound'; id: PlayerId; fraction: number }
  | { k: 'heart'; x: number; y: number; kind: 'half' | 'full' }
  | { k: 'equip'; id: PlayerId; item: GearItem }
  | { k: 'giveHeart'; id: PlayerId; kind: 'half' | 'full' }
  | { k: 'gear'; x: number; y: number; item: GearItem };

/** Repère résolu en coordonnées monde (pixels). */
export interface ResolvedMarker {
  x: number;
  y: number;
}

/** Ce que l'interface doit afficher à l'instant courant. */
export interface TutorialView {
  /** false : rien à afficher (salle terminée, mort d'équipe, tutoriel terminé…). */
  visible: boolean;
  stepId: string;
  /** Numéro (1-based) de l'étape parmi toutes. */
  index: number;
  total: number;
  /** Clé de texte (étape, ou carte d'interruption prioritaire). */
  textKey: string;
  /** Carte « en attente du partenaire » : la porte (`gate`) de l'étape n'est pas ouverte. */
  waiting: boolean;
  /** Carte d'interruption prioritaire en cours (`youDown`, `partnerDown`, `reviveInterrupted`), sinon null. */
  interrupt: 'youDown' | 'partnerDown' | 'reviveInterrupted' | null;
  /** Astuce « bloqué » (45 s sans progrès) : la puce devient « Salle suivante ». */
  stuck: boolean;
  /** Ce que fait `skipStep()` : sauter l'étape, ou toute la salle. */
  skipKind: 'step' | 'room';
  buttons: ButtonName[];
  /** Ne pas replier la carte en une ligne (voir `TutorialStepDef.noCompact`). */
  noCompact: boolean;
  highlights: HudRegionId[];
  markers: ResolvedMarker[];
  edgeToPartner: boolean;
  /** Position monde du partenaire (barre de bord, repère), ou null. */
  partnerPos: Vec2 | null;
  /** Temps (ms de simulation) passé sur l'étape affichée (repli compact de la carte). */
  activeMs: number;
  /** Tutoriel terminé (salle finale quittée). */
  finished: boolean;
}

/** Événement conservé depuis le début de l'étape (JSON pur). */
export type LoggedEvent = SimEvent;

/** État de la machine virtuelle du partenaire (JSON pur). */
export interface VmState {
  /** Programme courant : opérations « essentielles » restantes des étapes sautées, puis celles de l'étape. */
  prog: PartnerOp[];
  pc: number;
  /** Relâchement obligatoire au prochain pas (après une impulsion). */
  gap: boolean;
  /** Délai restant (ms) avant le prochain appel de `callEvery`. */
  callCdMs: number;
  /** Durée (ms) pendant laquelle le partenaire n'a pas bougé alors qu'il voulait avancer. */
  stuckMs: number;
  /** Temps restant (ms) d'un détour perpendiculaire (déblocage) et son sens. */
  detourMs: number;
  detourSign: 1 | -1;
}

/** État complet du directeur (JSON pur : snapshot / restore, déterminisme). */
export interface TutorialState {
  v: 1;
  /** Salle (id) où se trouve la simulation, d'après les événements `roomEntered`. */
  roomId: string;
  /** Indice de l'étape courante dans `TUTORIAL_STEPS` (jamais hors bornes tant que `finished` est faux). */
  stepIndex: number;
  /** En attente de `roomEntered` : l'étape courante est la dernière de sa salle et vient d'être validée. */
  holding: boolean;
  finished: boolean;
  /** Ids des étapes validées ou sautées. */
  done: string[];
  /** La porte (`gate`) de l'étape courante s'est ouverte au moins une fois : elle ne referme plus l'étape (la torche pleine après avoir été rechargée…). */
  started: boolean;
  /** Temps d'affichage cumulé de l'étape courante (ms de simulation, porte ouverte, phase 'playing'). */
  activeMs: number;
  /** Temps depuis le dernier progrès (changement d'étape) — astuce « bloqué ». */
  sinceProgressMs: number;
  stuck: boolean;
  events: LoggedEvent[];
  movedPx: number;
  lastPos: Vec2 | null;
  signNear: { id: string | null; ms: number };
  /** La démonstration de mort d'équipe a déjà eu lieu (ou été sautée). */
  wipeDone: boolean;
  /** La mise à terre scénarisée de l'étape courante a déjà été déclenchée. */
  knocked: boolean;
  /** Mises à terre à demander à la simulation (`takeKnockDowns`). */
  pendingKnock: PlayerId[];
  /** La mise en scène du soin (`TutorialStepDef.script`) de l'étape courante a déjà été déclenchée. */
  scripted: boolean;
  /** Actions de mise en scène à appliquer à la simulation (`takeScripted`). */
  pendingScript: ScriptedAction[];
  /** Carte d'interruption temporaire (relevage interrompu). */
  flash: { kind: 'reviveInterrupted'; ms: number } | null;
  /** Dernière phase de la simulation observée. */
  phase: string;
  /** Opérations « essentielles » d'étapes sautées, encore à exécuter. */
  backlog: PartnerOp[];
  /** Nombre d'opérations de `backlog` placées en tête du programme courant (retirées au fur et à mesure qu'elles sont exécutées). */
  backlogN: number;
  vm: VmState;
}
