/**
 * CONTRATS PARTAGÉS — logique pure (aucune dépendance à Phaser, au DOM, à Math.random, à Date).
 *
 * Tout ce qui est dans GameState est du JSON pur : sérialisable, copiable (structuredClone),
 * comparable. C'est la base du futur multijoueur en ligne (on synchronise l'état, pas les pixels).
 *
 * Voir docs/DESIGN.md pour les règles de conception (coop adaptative, clés i18n, noms de frames…).
 */

// ───────────────────────────── Primitives ─────────────────────────────

export interface Vec2 {
  x: number;
  y: number;
}

/** Coordonnées de tuile [colonne, ligne]. */
export type TileXY = [number, number];

export interface TileRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Dir = 'up' | 'down' | 'left' | 'right';

export type PlayerId = 0 | 1 | 2 | 3;
export type Difficulty = 1 | 2 | 3;

// ───────────────────────────── Entrées (abstraites) ─────────────────────────────

/** Noms des actions de jeu (couche d'abstraction, remappables, branchables sur tactile/réseau). */
export type ActionName = 'move' | 'attack' | 'interact' | 'revive' | 'special';

/**
 * État des entrées d'UN joueur pour UN pas de simulation. Valeurs « tenues » (held) :
 * la simulation détecte elle-même les fronts montants (appui) en mémorisant le pas précédent.
 * moveX/moveY ∈ [-1, 1] (la simulation normalise la diagonale).
 */
export interface ActionFrame {
  moveX: number;
  moveY: number;
  attack: boolean;
  interact: boolean;
  revive: boolean;
  /** Attaque spéciale (bouton dédié ; absent = false). Front montant détecté par la simulation. */
  special?: boolean;
}

export const EMPTY_ACTION_FRAME: Readonly<ActionFrame> = Object.freeze({
  moveX: 0,
  moveY: 0,
  attack: false,
  interact: false,
  revive: false,
});

// ───────────────────────────── Personnages ─────────────────────────────

export type CharacterId =
  | 'david'
  | 'sandrine'
  | 'romain'
  | 'valentine'
  | 'aelith'
  | 'brokk'
  | 'grok'
  | 'mira';

export type ProjectileKind = 'arrow' | 'bolt' | 'orb' | 'shard' | 'heal';

export interface AttackDef {
  kind: 'melee' | 'ranged';
  /** Délai entre deux attaques (ms). */
  cooldownMs: number;
  /** Mêlée : portée de l'arc (px) ; distance max du projectile pour le ranged (≈ speed*life). */
  range: number;
  /** Mêlée : ouverture de l'arc en degrés. */
  arcDeg?: number;
  /** Durée visuelle de l'animation d'attaque (ms). */
  animMs: number;
  /** Multiplicateur appliqué aux dégâts de base (force). */
  damageMult: number;
  projectile?: {
    kind: ProjectileKind;
    speed: number; // px/s
    lifeMs: number;
    radius: number;
    pierce: boolean;
  };
}

/** Famille d'attaque spéciale (une par personnage, voir SpecialDef). */
export type SpecialKind =
  | 'whirlwind'
  | 'fireNova'
  | 'dash'
  | 'healNova'
  | 'arrowFan'
  | 'quake'
  | 'smash'
  | 'bladeDance';

/**
 * Attaque spéciale : bien plus puissante que l'attaque normale, rechargeable (cooldownMs), sur un bouton dédié.
 * Clés i18n : character.<id>.special.name / .desc.
 */
export interface SpecialDef {
  kind: SpecialKind;
  nameKey: string;
  descKey: string;
  /** Temps de recharge (ms). */
  cooldownMs: number;
  /** Multiplicateur des dégâts de base du joueur (force, sans attack.damageMult). */
  damageMult: number;
  /** Rayon d'effet (px) : zone / rayon de la ruée / cône. */
  radius: number;
  /** Portée (px) : distance de ruée, centre de la nova devant le héros, longueur du cône… */
  range: number;
  /** Durée de l'animation/exécution (ms). */
  animMs: number;
  invulnMs?: number;
  stunMs?: number;
  healFraction?: number;
  /** Ouverture totale (degrés) du cône (smash). */
  arcDeg?: number;
  /** Nombre de projectiles (arrowFan) ou de coups (bladeDance). */
  count?: number;
  /** Demi-ouverture (degrés) de l'éventail de projectiles (arrowFan : ±spreadDeg). */
  spreadDeg?: number;
}

export interface CharacterDef {
  id: CharacterId;
  /** Clés i18n : character.<id>.name / .class / .desc */
  nameKey: string;
  classKey: string;
  descKey: string;
  /** Inspiré d'un membre de la famille (Sandrine, David, Valentine, Romain). */
  family: boolean;
  /** Couleur dominante du sprite (0xRRGGBB), utilisée par l'écran de sélection. */
  color: number;
  /** Force 1..10 : dégâts infligés. */
  strength: number;
  /** Résistance 1..10 : PV max + réduction de dégâts. */
  resistance: number;
  /** Vitesse de déplacement en px/s. */
  speed: number;
  /** Multiplicateur de vitesse de relevage (1 = nominal, <1 = plus rapide ... voir REVIVE : durée = nominale × reviveTimeMult). */
  reviveTimeMult: number;
  attack: AttackDef;
  /** Attaque spéciale du personnage. */
  special?: SpecialDef;
}

// ───────────────────────────── Ennemis ─────────────────────────────

export type EnemyKind =
  | 'slime'
  | 'bat'
  | 'skeleton'
  | 'archer'
  | 'spider'
  | 'wisp'
  | 'knight'
  | 'golem' // boss niveau 2 (Gorgrim)
  | 'morvane'; // boss final niveau 3

export type EnemyAI =
  | 'wander-chase'
  | 'erratic-flyer'
  | 'melee'
  | 'ranged'
  | 'caster'
  | 'boss-golem'
  | 'boss-morvane';

export interface EnemyDef {
  kind: EnemyKind;
  /** Clé i18n : enemy.<kind> */
  nameKey: string;
  /** PV de base (avant l'effet de difficulté, appliqué côté dégâts reçus). */
  hp: number;
  /** Dégâts de base infligés au contact / par attaque (avant difficulté et résistance du joueur). */
  damage: number;
  speed: number;
  radius: number;
  ai: EnemyAI;
  /** Portée à partir de laquelle l'ennemi déclenche son attaque (px). */
  attackRange: number;
  attackCooldownMs: number;
  /** Rayon d'aggro (px). */
  aggroRadius: number;
  isBoss: boolean;
  /** Sprite : enemy_<kind>_<0|1> ou boss_<kind>_<0|1>. */
}

export interface EnemyState {
  id: number;
  kind: EnemyKind;
  pos: Vec2;
  facing: Dir;
  hp: number;
  maxHp: number;
  /** Machine à états libre propre à l'IA (ex. 'idle','chase','windup','attack','recover','dead'). */
  mode: string;
  /** Compte à rebours générique de l'état courant (ms). */
  modeTimerMs: number;
  attackCooldownMs: number;
  hitFlashMs: number;
  /** Données libres de l'IA (cibles, angles, compteurs de phase…) — nombres uniquement (sérialisable). */
  data: Record<string, number>;
  /** Phase de boss (0 pour les ennemis normaux). */
  phase: number;
  /** Id du joueur ciblé, ou -1. */
  targetId: number;
  /** Vague d'apparition (pour la logique de vagues). */
  wave: number;
  dead: boolean;
}

export type ProjectileOwner = { type: 'player'; id: PlayerId } | { type: 'enemy'; id: number };

export interface ProjectileState {
  id: number;
  kind: ProjectileKind;
  owner: ProjectileOwner;
  pos: Vec2;
  vel: Vec2; // px/s
  /** Dégâts BRUTS déjà calculés à la création (force du tireur) — difficulté/résistance appliquées à l'impact. */
  damage: number;
  radius: number;
  lifeMs: number;
  pierce: boolean;
  /** Ids d'ennemis/joueurs déjà touchés (pour les projectiles perforants). */
  hitIds: number[];
}

// ───────────────────────────── Joueurs ─────────────────────────────

export type PlayerStatus = 'alive' | 'down';

export interface PlayerState {
  id: PlayerId;
  characterId: CharacterId;
  difficulty: Difficulty;
  pos: Vec2;
  facing: Dir;
  hp: number;
  maxHp: number;
  status: PlayerStatus;
  /** Invulnérabilité résiduelle après un coup (ms). */
  invulnMs: number;
  attackCooldownMs: number;
  /** Temps restant d'animation d'attaque (ms), pour le rendu. */
  attackAnimMs: number;
  /** Direction de la dernière attaque (pour le rendu de l'arc). */
  attackDir: Dir;
  /** Id du joueur que CE joueur est en train de relever, sinon null. */
  revivingId: PlayerId | null;
  /** Progression du relevage SUR ce joueur (ms effectives accumulées), 0 si pas relevé. */
  reviveProgressMs: number;
  /** Id du sauveteur actuel (joueur à terre uniquement), sinon null. */
  reviverId: PlayerId | null;
  /** Clés détenues (ids de mécanismes 'key'). */
  keys: string[];
  /** Ennemis tués par ce joueur dans la salle courante + niveau (objectifs 'kills'). */
  kills: number;
  /** Nombre de fois à terre dans le niveau (stat). */
  downCount: number;
  /** Mémoire des entrées du pas précédent (détection de fronts montants). */
  prev: { attack: boolean; interact: boolean; revive: boolean; special?: boolean };
  /** Dernier mouvement effectif (pour animation de marche) : true si le joueur s'est déplacé ce pas. */
  moving: boolean;
  /** Temps de recharge restant de l'attaque spéciale (ms) ; 0 = prête. */
  specialCooldownMs: number;
  /** Temps restant d'animation/exécution du spécial (ms), pour le rendu. */
  specialAnimMs: number;
  /**
   * Combustible de la torche personnelle (ms, 0..TORCH_MAX_MS). Ne s'use que dans les salles sombres (RoomDef.dark) ;
   * se recharge au contact d'un brasero allumé (interaction). Détermine le rayon de lumière.
   */
  torchMs: number;
}

// ───────────────────────────── Données de niveau ─────────────────────────────

export type ZoneTheme = 'crypt' | 'grove' | 'citadel';

/**
 * Glyphes de la grille (RoomDef.layout) :
 *  '#' mur (plein)         '.' sol                 ',' sol variante (décor, praticable)
 *  'o' pilier (plein)      '~' fosse (bloque les déplacements, pas les projectiles)
 *  ' ' vide hors-salle (plein, non rendu)
 * Tout le reste (ennemis, mécanismes, joueurs) est placé via des coordonnées de tuile.
 */
export type TileGlyph = '#' | '.' | ',' | 'o' | '~' | ' ';

export interface DialogueLine {
  /** Identifiant d'orateur → clé i18n speaker.<id>. */
  speaker: string;
  /** Clé i18n du texte. */
  textKey: string;
}

/** Jeton d'exigence (portes, apparitions d'ennemis, sortie) :
 *  - '<mechanismId>' : le mécanisme est actif/ouvert/résolu
 *  - 'clear'        : plus aucun ennemi vivant dans la salle (toutes vagues incluses)
 *  - 'obj:<id>'     : l'objectif personnel <id> est accompli
 *  - 'zone:<objId>' : le propriétaire de l'objectif 'zone' <objId> est en ce moment dans sa zone
 *  - 'enter:<zoneId>' : au moins un joueur VIVANT se trouve en ce moment dans la ZoneDef `zoneId` de la salle
 *                       (déclencheur d'embuscade : EnemySpawnDef.when = 'enter:<zoneId>')
 */
export type Requirement = string;

export interface MechanismBase {
  id: string;
  /**
   * Coop adaptative : le mécanisme n'existe « pour de vrai » que si nbJoueurs >= minPlayers.
   * Sinon il est « waived » (résolu d'office, rendu comme déjà activé). Défaut : 1.
   */
  minPlayers?: number;
  /** Clé i18n d'un libellé court affiché près du mécanisme (ex. "Plaque A"). Optionnel. */
  labelKey?: string;
}

/** Plaque de pression : active tant qu'un joueur (vivant) ou un bloc est dessus. Non verrouillante. */
export interface PlateDef extends MechanismBase {
  type: 'plate';
  tile: TileXY;
  /** Slot (0..3) dont la couleur est affichée sur la plaque (« qui doit faire quoi »). Optionnel. */
  colorSlot?: number;
}

/**
 * Levier : activé par `interact` (front montant) quand on est à portée. Si windowMs > 0 le levier
 * se désactive tout seul après windowMs (« à peu près au même moment ») ; sinon il est verrouillant.
 * Si ownerSlot est défini, seul le joueur (ownerSlot % nbJoueurs) peut l'actionner.
 */
export interface LeverDef extends MechanismBase {
  type: 'lever';
  tile: TileXY;
  ownerSlot?: number;
  windowMs?: number;
}

/** Clé personnelle : seul le joueur (ownerSlot % nbJoueurs) peut la ramasser ; elle n'ouvre que doorId. */
export interface KeyDef extends MechanismBase {
  type: 'key';
  tile: TileXY;
  ownerSlot: number;
  doorId: string;
}

/**
 * Porte : occupe `tiles` (bloquantes) tant qu'elle est fermée. S'ouvre quand toutes les `requires`
 * sont satisfaites ET (si keyId) quand le propriétaire de la clé interagit à portée avec la clé en main.
 * Une porte ouverte le reste (verrouillage définitif).
 */
export interface DoorDef extends MechanismBase {
  type: 'door';
  tiles: TileXY[];
  requires: Requirement[];
  keyId?: string;
}

/** Bloc poussable 2×2 : ne bouge que si au moins `playersRequired` (défaut 2, plafonné au nb de joueurs) le poussent. */
export interface BlockDef extends MechanismBase {
  type: 'block';
  /** Tuile du coin haut-gauche. */
  tile: TileXY;
  playersRequired?: number;
}

/** Réceptacle 2×2 : actif quand un bloc (blockId, ou n'importe lequel) est exactement dessus. */
export interface SocketDef extends MechanismBase {
  type: 'socket';
  tile: TileXY;
  blockId?: string;
}

/**
 * Vision partagée : la séquence de symboles n'est VISIBLE que pour le joueur (visibleToSlot % nbJoueurs)
 * (rendu : visible seulement dans sa vue). Les autres voient des piédestaux et doivent actionner
 * (`interact`) dans le bon ordre d'après la description orale du premier. Erreur = remise à zéro.
 */
export interface RunePuzzleDef extends MechanismBase {
  type: 'runePuzzle';
  /** Tuile où la séquence est affichée (rendu réservé au joueur voyant). */
  displayTile: TileXY;
  visibleToSlot: number;
  /** Séquence attendue = liste de symboles (ids de pedestals[].symbol). */
  sequence: string[];
  pedestals: { symbol: string; tile: TileXY }[];
}

/**
 * Brasero (système de torches, salles sombres) :
 *  - déjà allumé (`lit: true`) : source de lumière permanente ET point de recharge : `interact` (front montant) à portée
 *    recharge la torche du joueur au maximum ;
 *  - éteint (`lit` absent/false) : un joueur dont la torche n'est pas vide l'allume avec `interact` ; il reste allumé
 *    (verrouillant) et devient point de recharge. État `active` = allumé (utilisable dans les `requires` d'une porte :
 *    « allumer les 4 braseros »). `ownerSlot` : si défini, seul le joueur (ownerSlot % nbJoueurs) peut l'allumer.
 * Waived (nbJoueurs < minPlayers) : rendu allumé d'office.
 */
export interface BrazierDef extends MechanismBase {
  type: 'brazier';
  tile: TileXY;
  lit?: boolean;
  ownerSlot?: number;
  /** Rayon de lumière en tuiles (défaut BRAZIER_LIGHT_TILES). */
  lightRadiusTiles?: number;
}

export type MechanismDef =
  | PlateDef
  | LeverDef
  | KeyDef
  | DoorDef
  | BlockDef
  | SocketDef
  | RunePuzzleDef
  | BrazierDef;

export interface EnemySpawnDef {
  kind: EnemyKind;
  tile: TileXY;
  /** Vague (0 = au démarrage ; k>0 = quand toutes les vagues < k sont vaincues). Défaut 0. */
  wave?: number;
  /** Condition supplémentaire (jeton Requirement) avant l'apparition. */
  when?: Requirement;
  /** N'apparaît que si nbJoueurs >= minPlayers (le nombre d'ennemis suit les JOUEURS, jamais la difficulté). */
  minPlayers?: number;
}

export interface ZoneDef {
  id: string;
  rect: TileRect;
}

export interface SignDef {
  id: string;
  tile: TileXY;
  /** Clé i18n du texte affiché quand un joueur est proche. */
  textKey: string;
}

export interface DecorDef {
  type: 'torch' | 'statue' | 'banner' | 'crate' | 'bones' | 'plant' | 'crystal';
  tile: TileXY;
}

export type ObjectiveKind = 'mechanism' | 'zone' | 'kills';

/**
 * Objectif personnel. Slot 0..3 → joueur (slot % nbJoueurs). Accompli une fois pour toutes (persiste entre salles).
 *  - 'mechanism' : accompli quand le mécanisme `mechanismId` devient actif/ouvert/résolu (porte à clé, levier, etc.)
 *  - 'zone'      : le propriétaire doit cumuler `seconds` secondes dans la zone `zoneId` (zone à protéger/tenir)
 *  - 'kills'     : le propriétaire doit vaincre `count` ennemis (de `enemyKind` si précisé) dans roomId
 */
export interface ObjectiveDef {
  id: string;
  slot: number;
  roomId: string;
  kind: ObjectiveKind;
  /** Clé i18n du libellé court affiché dans le HUD du joueur. */
  labelKey: string;
  mechanismId?: string;
  zoneId?: string;
  seconds?: number;
  count?: number;
  enemyKind?: EnemyKind;
}

export interface RoomDef {
  id: string;
  /** Clé i18n du nom de la salle. */
  nameKey: string;
  theme: ZoneTheme;
  /** Grille de glyphes (voir TileGlyph). Toutes les lignes ont la même longueur. */
  layout: string[];
  /** Positions de départ des joueurs (au moins 4 tuiles, J1..J4). */
  playerSpawns: TileXY[];
  enemies: EnemySpawnDef[];
  mechanisms: MechanismDef[];
  zones?: ZoneDef[];
  signs?: SignDef[];
  decor?: DecorDef[];
  /**
   * Sortie : zone où tous les joueurs VIVANTS doivent se tenir quand `requires` est satisfait
   * pour terminer la salle. `final: true` → terminer cette salle termine le niveau.
   * `sealed: true` → la sortie est une « porte scellée » rendue comme telle tant que requires n'est pas satisfait.
   */
  exit: { rect: TileRect; requires: Requirement[]; final?: boolean; sealed?: boolean };
  /** Indice de mécanique affiché à l'arrivée dans la salle (clé i18n), optionnel. */
  introHintKey?: string;
  /**
   * Salle sombre : tout est noir hors des sources de lumière (torches des joueurs, braseros allumés, décors 'torch').
   * La torche de chaque joueur vivant s'use (PlayerState.torchMs) dans une salle sombre ; sans combustible son rayon
   * de lumière devient minimal. Aucun dégât lié à l'obscurité.
   */
  dark?: boolean;
}

export interface LevelDef {
  id: string;
  /** Clés i18n : level.<id>.name etc. */
  nameKey: string;
  theme: ZoneTheme;
  /** Durée estimée (minutes) — documentation. */
  estimatedMinutes: number;
  intro: DialogueLine[];
  outro: DialogueLine[];
  rooms: RoomDef[];
  /** Objectifs personnels (au moins 4 slots couverts : un par slot 0..3). */
  objectives: ObjectiveDef[];
}

// ───────────────────────────── États de mécanismes ─────────────────────────────

interface MechanismStateBase {
  id: string;
  /** Mécanisme neutralisé par la coop adaptative (nbJoueurs < minPlayers) : considéré résolu. */
  waived: boolean;
  /** État logique unifié : plaque pressée / levier actif / porte ouverte / réceptacle rempli / énigme résolue / clé utilisée. */
  active: boolean;
}

export interface PlateState extends MechanismStateBase {
  type: 'plate';
  /** Qui appuie : id joueur, 'block', ou null. */
  pressedBy: PlayerId | 'block' | null;
}

export interface LeverState extends MechanismStateBase {
  type: 'lever';
  /** Temps restant avant désactivation (ms), 0 si verrouillé ou inactif. */
  remainingMs: number;
}

export interface KeyState extends MechanismStateBase {
  type: 'key';
  /** Ramassée (dans l'inventaire d'un joueur). */
  collected: boolean;
  holderId: PlayerId | null;
  /** Utilisée sur sa porte (active = used). */
}

export interface DoorState extends MechanismStateBase {
  type: 'door';
  /** active === open. */
  open: boolean;
}

export interface BlockState extends MechanismStateBase {
  type: 'block';
  /** Position courante en pixels (coin haut-gauche), interpolée pendant le déplacement. */
  pos: Vec2;
  /** Tuile du coin haut-gauche (logique, après le déplacement en cours). */
  tile: TileXY;
  /** Déplacement en cours : tuile cible et progression 0..1, sinon null. */
  moving: { to: TileXY; progress: number } | null;
  /** Accumulateur de poussée (ms) pour exiger une poussée soutenue avant de bouger. */
  pushMs: number;
}

export interface SocketState extends MechanismStateBase {
  type: 'socket';
}

export interface RuneState extends MechanismStateBase {
  type: 'runePuzzle';
  /** Nombre de symboles déjà bien saisis. */
  progress: number;
  /** Flash d'erreur résiduel (ms). */
  errorFlashMs: number;
  /** Dernier piédestal actionné (index dans pedestals), -1 sinon (rendu). */
  lastPedestal: number;
}

export interface BrazierState extends MechanismStateBase {
  type: 'brazier';
  /** active === allumé. */
  /** Joueur qui l'a allumé (null si allumé d'office / waived). */
  litBy: PlayerId | null;
}

export type MechanismState =
  | PlateState
  | LeverState
  | KeyState
  | DoorState
  | BlockState
  | SocketState
  | RuneState
  | BrazierState;

// ───────────────────────────── État de jeu ─────────────────────────────

export interface ObjectiveState {
  id: string;
  /** Joueur propriétaire (slot résolu). */
  ownerId: PlayerId;
  done: boolean;
  /** Progression 0..1 (zone : temps cumulé / seconds ; kills : count atteint / count). */
  progress: number;
}

export interface RoomState {
  roomId: string;
  enemies: EnemyState[];
  projectiles: ProjectileState[];
  mechanisms: MechanismState[];
  /** Vagues d'ennemis déjà déclenchées (indices de vague) ; chaque EnemySpawnDef n'apparaît qu'une fois. */
  spawnedSpawnIdx: number[];
  /** Temps écoulé dans la salle (ms). */
  elapsedMs: number;
}

export type GamePhase =
  | 'playing'
  | 'roomCleared' // fanfare avant chargement de la salle suivante
  | 'levelComplete'
  | 'wipe'; // tous à terre : attente avant redémarrage automatique de la salle

export interface GameState {
  version: 1;
  tick: number;
  timeMs: number;
  /** État du PRNG déterministe (mulberry32). */
  rngState: number;
  nextEntityId: number;
  levelId: string;
  playerCount: number;
  players: PlayerState[];
  roomIndex: number;
  phase: GamePhase;
  /** Temps écoulé dans la phase courante (ms). */
  phaseTimerMs: number;
  room: RoomState;
  objectives: ObjectiveState[];
  /** Ids des salles validées (conservées en cas de défaite collective). */
  clearedRooms: string[];
}

// ───────────────────────────── Événements (sons, FX, HUD) ─────────────────────────────

export type SimEvent =
  | { type: 'roomEntered'; roomId: string; roomIndex: number; reason: 'start' | 'next' | 'restart' }
  | { type: 'playerHit'; playerId: PlayerId; damage: number; pos: Vec2 }
  | { type: 'playerDown'; playerId: PlayerId }
  | { type: 'reviveStarted'; reviverId: PlayerId; targetId: PlayerId }
  | { type: 'reviveInterrupted'; reviverId: PlayerId; targetId: PlayerId; reason: 'released' | 'reviverDown' | 'range' }
  | { type: 'playerRevived'; playerId: PlayerId; reviverId: PlayerId }
  | { type: 'teamWipe' }
  | { type: 'enemyHit'; enemyId: number; damage: number; pos: Vec2; byPlayer: PlayerId | null }
  | { type: 'enemyDied'; enemyId: number; kind: EnemyKind; pos: Vec2; byPlayer: PlayerId | null }
  | { type: 'enemySpawned'; enemyId: number; kind: EnemyKind; pos: Vec2 }
  | { type: 'playerAttack'; playerId: PlayerId; dir: Dir }
  | { type: 'projectileFired'; projectileId: number; kind: ProjectileKind; pos: Vec2 }
  | { type: 'bossPhase'; enemyId: number; kind: EnemyKind; phase: number }
  | { type: 'mechanismChanged'; mechanismId: string; active: boolean }
  | { type: 'keyPicked'; playerId: PlayerId; keyId: string }
  | { type: 'doorOpened'; doorId: string }
  | { type: 'runeProgress'; mechanismId: string; progress: number; ok: boolean }
  | { type: 'objectiveCompleted'; objectiveId: string; playerId: PlayerId }
  | { type: 'roomCleared'; roomId: string }
  | { type: 'levelCompleted'; levelId: string }
  | { type: 'specialUsed'; playerId: PlayerId; kind: SpecialKind; pos: Vec2; dir: Dir }
  | { type: 'specialReady'; playerId: PlayerId }
  | { type: 'brazierLit'; brazierId: string; playerId: PlayerId }
  | { type: 'torchRefueled'; playerId: PlayerId; brazierId: string }
  | { type: 'torchLow'; playerId: PlayerId }
  | { type: 'torchOut'; playerId: PlayerId };

// ───────────────────────────── Simulation (interface publique) ─────────────────────────────

export interface PlayerSetup {
  id: PlayerId;
  characterId: CharacterId;
  difficulty: Difficulty;
}

export interface SimConfig {
  levelId: string;
  players: PlayerSetup[];
  seed: number;
}

/** Entrées d'un pas pour tous les joueurs (absent = aucune entrée). */
export type TickInputs = Partial<Record<PlayerId, ActionFrame>>;

/**
 * Interface publique de la simulation. Implémentée par src/core/simulation.ts (GameSimulation).
 * Les scènes Phaser n'utilisent QUE cette interface + GameState : aucune règle de jeu côté rendu.
 */
export interface IGameSimulation {
  /** État courant (JSON pur). Lecture seule côté appelant : ne pas muter. */
  readonly state: GameState;
  /** Définition de la salle courante. */
  readonly room: RoomDef;
  readonly level: LevelDef;
  /** Avance d'UN pas fixe (SIM_STEP_MS recommandé). Retourne les événements produits. */
  step(dtMs: number, inputs: TickInputs): SimEvent[];
  /** Snapshot JSON (GameState). */
  serialize(): string;
}

// ───────────────────────────── Contexte d'IA ennemie ─────────────────────────────

/**
 * Contexte passé par la simulation à l'IA d'un ennemi (src/core/ai.ts, bosses.ts).
 * Permet à l'IA de rester pure et testable sans connaître la simulation entière.
 */
export interface EnemyAIContext {
  dtMs: number;
  players: readonly PlayerState[];
  /** Ennemis vivants de la salle (lecture, ex. pour compter les invocations). */
  enemies: readonly EnemyState[];
  /** Tire un nombre dans [0,1) du PRNG déterministe. */
  random(): number;
  /** Collision tuiles/portes/blocs : true si un disque (centre, rayon) peut occuper cette position. */
  canOccupy(pos: Vec2, radius: number, flying?: boolean): boolean;
  /** Déplace en glissant le long des murs et retourne la nouvelle position. */
  moveWithCollision(pos: Vec2, delta: Vec2, radius: number, flying?: boolean): Vec2;
  // NB (ajout additif, agent « ai ») : `flying === true` => les fosses ('~') ne bloquent pas (chauve-souris,
  // feu follet, Morvane) ; les murs, piliers, portes fermées et blocs bloquent toujours. Absent/false = comportement historique.
  /** Crée un projectile ennemi. `damage` = dégâts bruts (difficulté/résistance appliquées à l'impact). */
  spawnProjectile(p: { kind: ProjectileKind; pos: Vec2; vel: Vec2; damage: number; radius: number; lifeMs: number; pierce?: boolean; enemyId: number }): void;
  /** Invoque un ennemi (ex. boss) — respecte la salle ; retourne son id ou -1 si impossible. */
  spawnEnemy(kind: EnemyKind, pos: Vec2): number;
  /** Inflige une attaque de zone/contact : touche tous les joueurs vivants dont le disque intersecte le cercle. */
  damageCircle(center: Vec2, radius: number, damage: number, enemyId: number): void;
  /** Dimensions de la salle en pixels. */
  roomBounds: { width: number; height: number };
  /** Émet un événement (ex. changement de phase de boss). */
  emit(e: SimEvent): void;
}
