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
export type ActionName = 'move' | 'attack' | 'interact' | 'revive' | 'special' | 'call' | 'heart';

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
  /** Appel (bouton dédié ; absent = false) : signal vers l'équipe, voir `CALL_*` (constants.ts). Front montant détecté par la simulation. */
  call?: boolean;
  /**
   * Utiliser le cœur rangé (bouton DÉDIÉ : clavier B, manette B ; absent = false). Front montant détecté par la simulation ; sans effet si `SimConfig.heartSlot` est faux
   * (voir `heartSlot.ts`). Jamais lié à l'action contextuelle (attaque / interaction / relevage) : B ne déclenche aucune autre action.
   */
  heart?: boolean;
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

/**
 * TRAITS D'APPEL d'un personnage (DATA, voir `callTraits.ts` et `balance.ts` [B31]) : valeurs EXPLICITES qui remplacent, pour CE héros seulement, les délais de l'appel manuel et de l'appel automatique.
 * Un personnage sans `callTraits` (ou avec un champ absent) garde exactement les valeurs par défaut (`DEFAULT_CALL_TRAITS`). Lu par des fonctions pures (`callCooldownFor`, `autoCallCooldownFor`, `crossRepeatMsFor`).
 */
export interface CallTraits {
  /** Délai de récupération (ms) de l'appel MANUEL, mesuré depuis l'appui (0 = aucune attente : on relance dès que le signal en cours est fini). */
  manualCooldownMs: number;
  /** Délai de récupération (ms) de l'appel AUTOMATIQUE d'objet entre deux appels (0 = aucune attente : un signal d'objet peut être remplacé tout de suite par celui d'un autre objet). */
  autoCooldownMs: number;
  /** Répétition (ms) de la CROIX ROUGE tant que le joueur reste à 30 % de ses PV max ou moins. */
  crossRepeatMs: number;
  /** Les RÉPÉTITIONS de la croix (pas la première) jouent un son plus court et plus doux (`repeat` de l'événement `autoCallStarted`) : à un rythme rapide, le son ne doit pas devenir agressif. */
  crossSoftRepeat: boolean;
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
  /** Traits d'appel propres au héros (ex. Romain « parle beaucoup ») : champs absents = valeurs par défaut. Absent = comportement standard. */
  callTraits?: Partial<CallTraits>;
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
  | 'morvane' // boss final niveau 3
  // ── Niveaux 4-6 : un demi-boss par « famille » (obligatoires à vaincre) + un boss de fin par niveau ──
  | 'warden' // demi-boss niveau 4 (gardien de givre)
  | 'frostqueen' // boss final niveau 4
  | 'pyromancer' // demi-boss niveau 5
  | 'forgelord' // boss final niveau 5
  | 'wraith' // demi-boss niveau 6
  | 'voidlord'; // boss final niveau 6

export type EnemyAI =
  | 'wander-chase'
  | 'erratic-flyer'
  | 'melee'
  | 'ranged'
  | 'caster'
  | 'boss-golem'
  | 'boss-morvane'
  | 'miniboss-warden'
  | 'boss-frostqueen'
  | 'miniboss-pyromancer'
  | 'boss-forgelord'
  | 'miniboss-wraith'
  | 'boss-voidlord';

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
  /** Boss de fin de niveau (plafond de dégâts par fenêtre, barre de vie de boss…). */
  isBoss: boolean;
  /**
   * Demi-boss (niveaux 4-6) : ennemi nettement plus puissant qu'un ennemi normal, placé à mi-parcours ou dans une salle clé,
   * à vaincre pour terminer le niveau (la sortie de sa salle exige 'clear'). `isBoss` reste false pour un demi-boss.
   */
  isMiniBoss?: boolean;
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

// ───────────────────────────── Équipement ─────────────────────────────

/** Emplacements « simples » de l'équipement : un objet par niveau (I, II, III). Voir `balance.ts` [B18]. */
export type BasicGearSlot = 'boots' | 'protection' | 'artifact' | 'magic' | 'weapon';

/** Les 6 emplacements d'équipement (ordre d'affichage du HUD) : les 5 simples + l'accessoire (une seule sorte à la fois, étape accessoires). */
export type GearSlot = BasicGearSlot | 'accessory';

/** Niveau d'un objet d'équipement : 1 (I), 2 (II) ou 3 (III). */
export type GearLevel = 1 | 2 | 3;

/** Sortes d'accessoires (6e emplacement) : lanterne, aimant à cœurs, cor de guerre, anneau du vampire (niveau III seulement). */
export type AccessoryKind = 'lantern' | 'magnet' | 'warhorn' | 'vampire';

/** Accessoire équipé : sorte + niveau. */
export interface EquippedAccessory {
  kind: AccessoryKind;
  level: GearLevel;
}

/**
 * Objet d'équipement (au sol ou équipé) : emplacement + niveau ; `accessory` précise la sorte pour l'emplacement 'accessory'.
 * JSON pur.
 */
export interface GearItem {
  slot: GearSlot;
  level: GearLevel;
  accessory?: AccessoryKind;
}

/**
 * Équipement PERMANENT d'un joueur (conservé de salle en salle jusqu'à la fin du niveau, sauvegardé par l'autosave) : niveau équipé par
 * emplacement simple (0 = vide, 1..3) et accessoire. Ne contient PAS les buffs temporaires (voir `PlayerLoadout`).
 */
export interface PlayerGear {
  boots: number;
  protection: number;
  artifact: number;
  magic: number;
  weapon: number;
  accessory: EquippedAccessory | null;
}

/**
 * Bonus temporaires (perdus à la chute) : potion de vitesse (+40 %, 8 s), éclair de rage (+50 % dégâts, 8 s), étoile (invulnérabilité, 4 s), et
 * 'horn' = bonus de vitesse reçu de l'APPEL d'un allié porteur du cor de guerre (3 s ; `power` = fraction de vitesse).
 */
export type BuffKind = 'speed' | 'rage' | 'star' | 'horn';

/** Bonus temporaires RAMASSABLES au sol (tous sauf 'horn', qui vient du cor de guerre d'un allié). */
export type DroppedBuffKind = 'speed' | 'rage' | 'star';

/** Bonus temporaire actif. */
export interface ActiveBuff {
  kind: BuffKind;
  /** Temps restant (ms). */
  remainingMs: number;
  /** Force du bonus (fraction) : seulement pour 'horn' (+20 / +30 / +40 % selon le niveau du cor). */
  power?: number;
}

/** Équipement + bonus temporaires d'un joueur (`PlayerState.loadout`). Valeurs par défaut : tout vide (voir `createLoadout`). */
export interface PlayerLoadout extends PlayerGear {
  buffs: ActiveBuff[];
  /** Ennemis tués depuis le dernier soin de l'anneau du vampire (0..2) ; remis à 0 quand l'anneau n'est plus porté. Absent = 0. */
  ringKills?: number;
}

/**
 * Symbole d'un appel AUTOMATIQUE : cœur entier, demi-cœur, objet d'équipement (icône 8×8 de l'objet, voir `AutoCallState.item`) ou CROIX ROUGE (demande de soins : le joueur est à 30 % de ses PV max ou moins,
 * voir `CROSS_CALL_THRESHOLD`).
 */
export type AutoCallIcon = 'heart' | 'half' | 'gear' | 'cross';

/**
 * Signal d'APPEL AUTOMATIQUE d'un joueur : il vient de passer sur un objet au sol qu'il ne prend pas (cœur alors qu'il est plein, objet d'équipement
 * pas meilleur que le sien) et prévient ses coéquipiers, pour qui l'objet serait utile, de le leur laisser. Contrairement à l'appel manuel, il ne fige
 * pas le joueur et ne consomme pas son délai de récupération d'appel. JSON pur, transitoire (jamais sauvegardé par l'autosave).
 */
export interface AutoCallState {
  /** Symbole affiché à la place du point de l'indicateur d'appel. */
  icon: AutoCallIcon;
  /** Pour `icon === 'gear'` : l'objet (emplacement, niveau, sorte d'accessoire) dont on affiche l'icône ; absent pour un cœur. */
  item?: GearItem;
  /** Référence de l'objet au sol : 'p<id>' (nourriture) ou 'g<id>' (équipement) ; 'x' pour la croix rouge (aucun objet). Le signal d'un objet s'arrête quand l'objet disparaît (ramassé, périmé). */
  ref: string;
  /** Durée restante du signal (ms) : `AUTO_CALL_DURATION_MS` au déclenchement, 0 = terminé (le champ est alors supprimé). */
  ms: number;
  /** Ids des alliés vivants pour qui l'objet est utile au déclenchement : seuls eux voient l'indicateur et entendent le son. */
  to: PlayerId[];
}

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
  prev: { attack: boolean; interact: boolean; revive: boolean; special?: boolean; call?: boolean; heart?: boolean };
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
  /**
   * Temps restant (ms) du signal d'appel de ce joueur (0 = aucun appel en cours ; `CALL_DURATION_MS` à l'appui).
   * Le joueur est immobilisé tant que `callMs > CALL_DURATION_MS - CALL_FREEZE_MS`. Remis à 0 s'il tombe à terre et à chaque (re)démarrage de salle.
   */
  callMs: number;
  /** Délai de récupération restant (ms) avant de pouvoir rappeler (`CALL_COOLDOWN_MS` à l'appui, décompté depuis l'appui ; toujours 0 pour un héros sans attente, Romain : `CallTraits.manualCooldownMs`). */
  callCooldownMs: number;
  /**
   * Appel AUTOMATIQUE en cours (objet laissé aux coéquipiers), voir `AutoCallState`. Absent = aucun. Champ optionnel, créé au déclenchement puis supprimé à son terme :
   * un état sans appel automatique est identique à celui d'avant l'ajout. Remis à zéro à chaque (re)démarrage de salle, à la chute et quand le joueur lance un appel manuel.
   */
  autoCall?: AutoCallState;
  /** Délai de récupération restant (ms) de l'appel AUTOMATIQUE (distinct de `callCooldownMs`, celui de l'appel manuel). Absent = 0. */
  autoCallCooldownMs?: number;
  /** Objets au sol (références 'p<id>' / 'g<id>') déjà signalés par ce joueur et dont il n'est pas encore sorti du rayon : un seul appel par couple (joueur, objet). Absent = aucun. */
  autoCallSeen?: string[];
  /**
   * Suivi de la CROIX ROUGE (demande de soins, `autoCall.ts`) : présent = la croix est déjà partie pour ce joueur depuis qu'il est tombé à 30 % de ses PV max ou moins (désarmée) ; `ms` = temps restant avant sa prochaine
   * RÉPÉTITION (≥ 0 ; la croix ne repart que si ce délai est écoulé ET que le joueur est toujours à 30 % ou moins). Supprimé quand les PV remontent à 60 % ou plus et à chaque entrée de salle. Absent = armée.
   * `idleMs` (héros à répétition douce SEULEMENT, Romain : `CallTraits.crossSoftRepeat`) : temps écoulé depuis que le délai de répétition est à 0 sans qu'une croix soit repartie (plafonné) ; sert à distinguer une
   * vraie RÉPÉTITION (son doux) d'une nouvelle alerte après une longue pause (son complet). Absent pour tous les autres héros : leur état est inchangé.
   */
  autoCallCross?: { ms: number; idleMs?: number };
  /**
   * EMPLACEMENT CŒUR (`heartSlot.ts`, option `SimConfig.heartSlot`) : le cœur (10 PV) ou demi-cœur (5 PV) rangé, utilisé volontairement avec le bouton B. Un seul objet, jamais cumulé.
   * Champ OPTIONNEL : absent = emplacement vide, donc un état sans cœur rangé (ou sans l'option) est identique à celui d'avant l'ajout. Perdu à la chute (il tombe alors au sol).
   */
  heart?: PickupKind;
  /**
   * Équipement et bonus temporaires (vides par défaut). Perdus à la chute du joueur (RÈGLE STRICTE, y compris à la défaite d'équipe),
   * conservés d'une salle à l'autre, réinitialisés au niveau suivant. Un ancien snapshot n'a pas ce champ : valeur par défaut posée à la restauration.
   */
  loadout: PlayerLoadout;
}

// ───────────────────────────── Données de niveau ─────────────────────────────

export type ZoneTheme = 'crypt' | 'grove' | 'citadel' | 'frost' | 'ember' | 'void';

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
  /**
   * Clé i18n du libellé affiché une fois le brasero ALLUMÉ (état `active || waived`), à la place de `labelKey` (celui d'avant
   * l'allumage). Reprend la forme des braseros déjà allumés du niveau/de la salle (« Brasero (recharge) »). Absent : `labelKey`
   * reste affiché en toute circonstance. Exige `labelKey` (validé par `validateLevel`). Voir `mechanismLabelKey`.
   */
  litLabelKey?: string;
}

/**
 * STATUE JUMELLE (niveau 4) : deux statues identiques. Un joueur VIVANT qui se tient sur la `standTile` d'une statue et
 * appuie sur `interact` fait pivoter l'AUTRE statue d'un quart de tour (sens horaire : up → right → down → left → up).
 * Résolue (verrouillante) quand les deux statues regardent `targetDir`. Les statues sont solides (comme un brasero).
 * Chaque statue a un `standTile` éloigné de l'autre : il faut se coordonner (un joueur à chaque socle, ou faire des allers-retours en solo).
 * Waived : statues déjà orientées vers `targetDir`, mécanisme résolu.
 */
export interface StatuePairDef extends MechanismBase {
  type: 'statuePair';
  statues: [
    { tile: TileXY; standTile: TileXY; facing: Dir },
    { tile: TileXY; standTile: TileXY; facing: Dir },
  ];
  targetDir: Dir;
}

/**
 * SABLIER PARTAGÉ (niveau 5) : le sable s'écoule en permanence. Tant qu'il en reste (`sandMs > 0`), la herse (`gate`) est
 * ouverte ; quand il est vide la herse se referme PROGRESSIVEMENT (une tuile toutes les `closeStepMs`, dans l'ordre de `gate`,
 * une tuile occupée par un joueur/ennemi attend). `interact` à portée d'un des `levers` retourne le sablier : sable = période
 * (et la herse se rouvre d'un coup). `periodMs` est doublée en solo (effectiveHourglassPeriodMs). Un joueur doit donc rester
 * près d'un levier pendant que les autres passent, puis un autre prend le relais au levier suivant.
 * `active` = sable restant (> 0). Waived : herse ouverte en permanence.
 */
export interface HourglassDef extends MechanismBase {
  type: 'hourglass';
  /** Tuiles des leviers du sablier (≥ 2, de part et d'autre de la herse). */
  levers: TileXY[];
  /** Tuiles de la herse, dans l'ordre de fermeture. */
  gate: TileXY[];
  /** Durée du sable après chaque retournement (ms). */
  periodMs: number;
  /** Délai entre la fermeture de deux tuiles de la herse (ms, défaut 700). */
  closeStepMs?: number;
  /** Tuile où le sablier est affiché (rendu). */
  displayTile: TileXY;
}

/**
 * PONT DE LUMIÈRE (niveau 6) : les `tiles` du pont (sol '.' dans la grille) ne sont praticables que lorsqu'elles sont
 * ÉCLAIRÉES : à moins de `radiusTiles` tuiles du porteur de la lanterne (joueur `lanternSlot % nbJoueurs`, vivant), ou occupées
 * par un joueur vivant (on ne piège jamais quelqu'un). Les tuiles non éclairées sont solides (vide). Le porteur doit guider les
 * autres : ils ne traversent que dans le halo. Waived : pont toujours éclairé.
 */
export interface LightBridgeDef extends MechanismBase {
  type: 'lightBridge';
  tiles: TileXY[];
  lanternSlot: number;
  radiusTiles: number;
}

export type MechanismDef =
  | PlateDef
  | LeverDef
  | KeyDef
  | DoorDef
  | BlockDef
  | SocketDef
  | RunePuzzleDef
  | BrazierDef
  | StatuePairDef
  | HourglassDef
  | LightBridgeDef;

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
  /**
   * Cristaux de soin (sources de vie FIXES, salles de boss / demi-boss) : voir `HealCrystalDef`. Absent = aucun.
   * Un cristal n'existe que si nbJoueurs >= minPlayers (sinon il est simplement absent, comme un ennemi `minPlayers`).
   */
  healCrystals?: HealCrystalDef[];
}

/**
 * Cristal de soin : source de vie fixe à USAGE UNIQUE (se recharge au (re)démarrage de la salle). Le premier joueur vivant blessé
 * qui le touche récupère `HEAL_CRYSTAL_HEAL` PV (plafonnés à son manque) et le cristal se vide. Un joueur aux PV pleins ne le consomme pas.
 * Voir `balance.ts` [B17] et `levelValidation.ts` (tuile de sol, accessible, loin du départ des joueurs et des boss).
 */
export interface HealCrystalDef {
  id: string;
  tile: TileXY;
  /** N'existe que si nbJoueurs >= minPlayers (défaut 1) : le 3e cristal d'une salle de boss exige 3 joueurs. */
  minPlayers?: number;
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

export interface StatuePairState extends MechanismStateBase {
  type: 'statuePair';
  /** Orientation courante des deux statues. active === les deux regardent targetDir. */
  facings: [Dir, Dir];
  /** Dernière statue pivotée (0/1), -1 sinon (rendu). */
  lastRotated: -1 | 0 | 1;
}

export interface HourglassState extends MechanismStateBase {
  type: 'hourglass';
  /** Sable restant (ms) ; 0 = vide (la herse se ferme). */
  sandMs: number;
  /** Nombre de tuiles de herse fermées (0..gate.length). */
  closedCount: number;
  /** Chrono avant la fermeture de la prochaine tuile (ms). */
  stepMs: number;
  /** Index du dernier levier utilisé, -1 sinon (rendu). */
  lastLever: number;
}

export interface LightBridgeState extends MechanismStateBase {
  type: 'lightBridge';
  /** Porteur de la lanterne (null si à terre / waived). */
  bearerId: PlayerId | null;
  /** Par tuile du pont (même ordre que def.tiles) : true = éclairée, donc praticable. */
  lit: boolean[];
}

export type MechanismState =
  | PlateState
  | LeverState
  | KeyState
  | DoorState
  | BlockState
  | SocketState
  | RuneState
  | BrazierState
  | StatuePairState
  | HourglassState
  | LightBridgeState;

// ───────────────────────────── État de jeu ─────────────────────────────

export interface ObjectiveState {
  id: string;
  /** Joueur propriétaire (slot résolu). */
  ownerId: PlayerId;
  done: boolean;
  /** Progression 0..1 (zone : temps cumulé / seconds ; kills : count atteint / count). */
  progress: number;
}

/** Valeur d'un objet de soin ramassable : demi-cœur (5 PV) ou cœur entier (10 PV), voir `LOOT_HALF_HEAL` / `LOOT_FULL_HEAL`. */
export type PickupKind = 'half' | 'full';

/**
 * Objet de soin posé au sol (nourriture laissée par un ennemi vaincu). Ramassé au contact (`PICKUP_RADIUS`) par un joueur vivant
 * dont les PV < max ; disparaît au bout de `PICKUP_TTL_MS`. Effacé à chaque (re)démarrage et changement de salle.
 */
export interface PickupState {
  /** Identifiant propre aux objets de soin (compteur `GameState.nextPickupId`, distinct de `nextEntityId`). */
  id: number;
  kind: PickupKind;
  pos: Vec2;
  /** Durée de vie restante (ms) ; les `PICKUP_BLINK_MS` dernières millisecondes, le rendu fait clignoter l'objet. */
  ttlMs: number;
}

/** État d'un cristal de soin de la salle (voir `HealCrystalDef`). */
export interface HealCrystalState {
  /** Id du `HealCrystalDef` correspondant. */
  id: string;
  /** Vrai une fois utilisé (usage unique ; remis à neuf par le (re)démarrage de salle). */
  used: boolean;
}

/** Verrouillage d'un objet d'équipement au sol pour un joueur : pendant toute la vie de l'objet ('life') ou tant que le joueur n'a pas quitté son rayon ('leave'). */
export type GearLockMode = 'life' | 'leave';

/**
 * Objet d'équipement posé au sol (laissé par un ennemi, ou ÉPARPILLÉ par un joueur tombé). Ramassé automatiquement au contact par un
 * joueur vivant pour qui il est STRICTEMENT meilleur que son objet de l'emplacement ; disparaît au bout de `GEAR_TTL_MS`.
 * Effacé à chaque (re)démarrage et changement de salle.
 */
export interface GearDropState {
  /** Identifiant propre aux objets d'équipement (compteur `GameState.nextGearDropId`). */
  id: number;
  item: GearItem;
  pos: Vec2;
  /** Durée de vie restante (ms) ; les `GEAR_BLINK_MS` dernières millisecondes, le rendu fait clignoter l'objet. */
  ttlMs: number;
  /** Joueur qui ne peut PAS le ramasser (propriétaire qui l'a perdu / lâché), ou null. */
  lockedFor: PlayerId | null;
  lockMode: GearLockMode;
}

/**
 * Bonus temporaire posé au sol (laissé par un ennemi). Ramassé au contact par le joueur vivant le plus proche ; disparaît au bout de `GEAR_TTL_MS`.
 * Effacé à chaque (re)démarrage et changement de salle.
 */
export interface BuffDropState {
  /** Identifiant (compteur `GameState.nextGearDropId`, partagé avec les objets d'équipement). */
  id: number;
  kind: DroppedBuffKind;
  pos: Vec2;
  /** Durée de vie restante (ms) ; les `GEAR_BLINK_MS` dernières millisecondes, le rendu fait clignoter l'objet. */
  ttlMs: number;
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
  /**
   * Objets de soin au sol. Optionnel dans le type (ajout après coup : un ancien snapshot ou un état construit à la main n'a pas
   * ce champ) mais TOUJOURS présent dans l'état d'une `GameSimulation` (valeur par défaut `[]` posée à la construction / `restore`).
   */
  pickups?: PickupState[];
  /** Cristaux de soin de la salle (uniquement ceux présents à ce nombre de joueurs) ; même convention d'optionnalité que `pickups`. */
  healCrystals?: HealCrystalState[];
  /** Objets d'équipement au sol (même convention d'optionnalité que `pickups`). */
  gearDrops?: GearDropState[];
  /** Budget d'objets d'équipement RESTANT dans la salle (nombre de joueurs au début de la salle, décrémenté à chaque objet tiré). Absent = 0. */
  gearBudget?: number;
  /** Bonus temporaires au sol (même convention d'optionnalité que `pickups`). */
  buffDrops?: BuffDropState[];
  /** Budget de bonus temporaires RESTANT dans la salle (entier tiré à l'entrée : floor(0,3 n) + 1 avec la probabilité du reste). Absent = 0. */
  buffBudget?: number;
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
  /**
   * Butin de vie (nourriture des ennemis) ET cristaux de soin actifs ? Défaut true (`SimConfig.loot`). false = aucune source de vie
   * (mesures « sans » de la calibration). Champ optionnel : absent d'un ancien snapshot = true.
   */
  lootEnabled?: boolean;
  /**
   * État du PRNG DÉDIÉ au butin (mulberry32, graine dérivée de celle de la simulation, `LOOT_SEED_XOR`) : isolé de `rngState` pour que
   * les tirages de butin ne décalent JAMAIS le flux de la simulation (les parties existantes restent identiques). Absent d'un ancien snapshot :
   * dérivé de `rngState` à la restauration.
   */
  lootRngState?: number;
  /** Compteur anti-malchance : morts d'ennemis (non invoqués) sans butin depuis le dernier butin / le début de salle. Absent = 0. */
  lootDryKills?: number;
  /** Prochain id d'objet de soin. Absent = 1. */
  nextPickupId?: number;
  /** Équipement actif (option `SimConfig.gear`, défaut true) : tirages d'objets par les ennemis vaincus ET ramassage. Absent = true. */
  gearEnabled?: boolean;
  /**
   * État du PRNG ISOLÉ de l'équipement (graine dérivée de celle de la simulation, `GEAR_SEED_XOR`) : distinct de `rngState` ET de `lootRngState`,
   * donc les tirages d'équipement ne décalent jamais les autres flux. Absent d'un ancien snapshot : dérivé de `rngState`.
   */
  gearRngState?: number;
  /** Prochain id d'objet d'équipement au sol. Absent = 1. */
  nextGearDropId?: number;
  /**
   * Appel AUTOMATIQUE désactivé ? (`SimConfig.autoCall === false` : démo, tutoriel, bots de calibration). Champ posé UNIQUEMENT quand il vaut false : absent = actif,
   * donc un état de partie normale reste identique à celui d'avant l'ajout.
   */
  autoCallDisabled?: boolean;
  /**
   * Butin d'équipement ALÉATOIRE désactivé ? (`SimConfig.gearDrops === false` : tutoriel) : les ennemis ne laissent ni objet d'équipement ni bonus temporaire (aucun tirage du flux `gearRngState`), mais l'équipement
   * (objets posés par script, ramassage, échange, appel automatique) fonctionne. Champ posé UNIQUEMENT quand il vaut true : absent = butin actif, donc un état de partie normale reste identique à celui d'avant.
   */
  gearDropsDisabled?: boolean;
  /**
   * Emplacement cœur actif ? (`SimConfig.heartSlot === true`). Champ posé UNIQUEMENT quand il vaut true : absent = ancien comportement exact (cœur consommé au contact, cristal au
   * contact, aucun bouton B), donc un état sans l'option est identique à celui d'avant son ajout.
   */
  heartSlot?: boolean;
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
  | { type: 'torchOut'; playerId: PlayerId }
  | { type: 'statueRotated'; mechanismId: string; index: 0 | 1; facing: Dir; playerId: PlayerId }
  | { type: 'hourglassFlipped'; mechanismId: string; leverIndex: number; playerId: PlayerId }
  | { type: 'hourglassEmpty'; mechanismId: string }
  | { type: 'gateClosed'; mechanismId: string; closedCount: number }
  | { type: 'callStarted'; playerId: PlayerId }
  /**
   * Appel AUTOMATIQUE : `playerId` laisse un objet (`icon`) à ses coéquipiers `to` (alliés vivants pour qui il est utile). Aucune immobilisation, aucune animation d'appel manuel.
   * `repeat: true` : RÉPÉTITION d'une croix rouge d'un héros à répétition douce (`CallTraits.crossSoftRepeat`, Romain) : son plus doux ; absent pour tous les autres cas (événements des autres héros inchangés).
   */
  | { type: 'autoCallStarted'; playerId: PlayerId; icon: AutoCallIcon; to: PlayerId[]; repeat?: true }
  // ── Sources de vie (butin des ennemis, cristaux de soin) ──
  | { type: 'pickupDropped'; pickupId: number; kind: PickupKind; pos: Vec2 }
  | { type: 'pickupCollected'; pickupId: number; playerId: PlayerId; kind: PickupKind; healed: number; pos: Vec2 }
  | { type: 'crystalUsed'; crystalId: string; playerId: PlayerId; healed: number; pos: Vec2 }
  // ── Emplacement cœur (`SimConfig.heartSlot`) ──
  /**
   * Un joueur RANGE le cœur / demi-cœur qu'il touche dans son emplacement (il disparaît du sol, aucun soin). `kind` = l'objet ramassé. `merged: true` (champ ABSENT sinon) : l'emplacement contenait déjà un
   * DEMI-cœur, il passe à CŒUR ENTIER (fusion : demi + demi ou demi + entier ; le surplus d'un demi-cœur est perdu).
   */
  | { type: 'heartStored'; playerId: PlayerId; pickupId: number; kind: PickupKind; pos: Vec2; merged?: true }
  /** B : `playerId` utilise le cœur rangé sur `targetId` (lui-même ou un allié blessé) : `amount` PV rendus (plafonnés au manque), le cœur est consommé. */
  | { type: 'heartUsed'; playerId: PlayerId; targetId: PlayerId; kind: PickupKind; amount: number; pos: Vec2 }
  /** B sans effet (personne n'a besoin de soin, ou emplacement vide) : rien n'est consommé ; retour discret. */
  | { type: 'heartRefused'; playerId: PlayerId }
  /** Un joueur tombé perd le cœur rangé : il tombe au sol à ses pieds (`pickupDropped` suit). Sert à la sauvegarde (la perte est écrite dès la chute). */
  | { type: 'heartLost'; playerId: PlayerId; kind: PickupKind; pos: Vec2 }
  // ── Équipement ──
  /** Un objet d'équipement apparaît au sol (butin d'un ennemi, ou `scattered` : équipement perdu éparpillé par un joueur tombé). */
  | { type: 'gearDropped'; dropId: number; item: GearItem; pos: Vec2; scattered: boolean }
  /** Un joueur ramasse (équipe) un objet ; `replaced` = l'objet qu'il remplace (disparu), ou null si l'emplacement était vide. */
  | { type: 'gearPicked'; dropId: number; playerId: PlayerId; item: GearItem; replaced: GearItem | null; pos: Vec2 }
  /** Un joueur tombé perd tout son équipement (`items`, éparpillés au sol) et ses bonus temporaires. */
  | { type: 'gearLost'; playerId: PlayerId; items: GearItem[]; pos: Vec2 }
  /** Un échange MANUEL d'accessoire (action A) : l'ancien, lâché aux pieds du joueur, est dans le `gearDropped` suivant. */
  | { type: 'gearSwapped'; playerId: PlayerId; item: GearItem; dropped: GearItem; pos: Vec2 }
  /** Un bonus temporaire apparaît au sol (butin d'un ennemi). */
  | { type: 'buffDropped'; dropId: number; kind: DroppedBuffKind; pos: Vec2 }
  /** Un bonus temporaire démarre (ramassé, ou reçu du cor de guerre d'un allié : `fromPlayerId`). */
  | { type: 'buffStarted'; playerId: PlayerId; kind: BuffKind; durationMs: number; fromPlayerId?: PlayerId; pos?: Vec2 }
  /** L'anneau du vampire rend des PV à son porteur (tous les 3 ennemis tués). */
  | { type: 'vampireHeal'; playerId: PlayerId; healed: number; pos: Vec2 };

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
  /**
   * Salle de départ (indice 0-based, défaut 0) : reprise d'une sauvegarde / dev `?room=N`. Borné à [0, nbSalles - 1] ;
   * valeur non finie = 0. Les salles précédentes sont considérées validées (`clearedRooms`) et leurs objectifs personnels
   * accomplis ; l'événement `roomEntered` a la raison 'start'.
   */
  startRoomIndex?: number;
  /**
   * Sources de vie actives (défaut true) : butin de nourriture des ennemis ET cristaux de soin. false = aucune (comparaisons
   * « avec / sans » de la calibration) ; les parties sont alors strictement celles d'avant l'ajout des sources de vie.
   */
  loot?: boolean;
  /**
   * Équipement actif (défaut true) : les ennemis vaincus laissent des objets d'équipement et les joueurs les ramassent. false = aucun
   * objet (mesures « avec / sans » de la calibration) ; les parties sont alors strictement celles d'avant l'ajout de l'équipement.
   */
  gear?: boolean;
  /**
   * Butin d'équipement ALÉATOIRE actif (défaut true ; sans effet si `gear` est faux) : false = les ennemis ne laissent ni objet ni bonus temporaire (le tutoriel : l'équipement y est posé par script, aucun tirage parasite).
   * Les objets posés (`spawnScriptedGear`), le ramassage, l'échange et l'appel automatique fonctionnent normalement.
   */
  gearDrops?: boolean;
  /**
   * Appel AUTOMATIQUE actif (défaut true) : un joueur qui passe sur un objet qu'il ne prend pas (cœur alors qu'il est plein, objet d'équipement pas meilleur que le sien), qui échange un accessoire (l'ancien est signalé)
   * ou qui tombe à 30 % de ses PV max (croix rouge) prévient ses coéquipiers pour qui c'est utile. false = désactivé (démo, bots). Purement informatif : n'a AUCUN effet sur le gameplay ni sur les flux aléatoires.
   */
  autoCall?: boolean;
  /**
   * Emplacement CŒUR (défaut false pour le cœur du moteur, TRUE posé par le jeu et le tutoriel) : un cœur / demi-cœur touché est rangé (jamais consommé au contact), le bouton B l'utilise
   * (voir `heartSlot.ts`), l'appel automatique part quand l'emplacement est ENTIER (vide ou à demi-cœur : on range / on fusionne), le cristal de soin devient volontaire. false / absent = ancien comportement exact (bots, calibration, démo).
   */
  heartSlot?: boolean;
  /** Cœur rangé au départ par indice de joueur (reprise d'une sauvegarde « Continuer ») : 'half' | 'full' ; absent, indéfini ou valeur inconnue = emplacement vide. Sans effet si `heartSlot` est faux. */
  initialHearts?: readonly (PickupKind | undefined)[];
  /** Équipement de départ par indice de joueur (reprise d'une sauvegarde « Continuer ») ; absent / indéfini = équipement vide. */
  initialGear?: readonly (PlayerGear | undefined)[];
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
