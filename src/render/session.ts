import type { PlayerId, PlayerSetup } from '../core/types';
import type { DeviceKind } from '../tutorial/types';

/** Clés de scènes Phaser (une seule source de vérité). */
export const SCENE_KEYS = {
  Boot: 'Boot',
  Menu: 'Menu',
  CharacterSelect: 'CharacterSelect',
  Dialogue: 'Dialogue',
  Game: 'Game',
  Result: 'Result',
} as const;

/** Statistiques cumulées sur la session (affichées à l'écran de résultat). */
export interface SessionStats {
  timeMs: number;
  /** Par joueur (index = PlayerId) : nombre de fois à terre. */
  downs: number[];
  /** Par joueur : ennemis vaincus. */
  kills: number[];
}

/**
 * Session de jeu : JSON pur, passée de scène en scène via scene.start(key, data).
 * Ne contient AUCUN objet Phaser (sérialisable, utile plus tard pour le réseau / la reprise).
 */
export interface GameSession {
  playerCount: number;
  /** Un PlayerSetup par joueur actif (id 0..playerCount-1), personnage unique par joueur. */
  players: PlayerSetup[];
  /** Indice (0-based) du niveau courant dans LEVELS. */
  levelIndex: number;
  stats: SessionStats;
  /**
   * Dev/test uniquement (paramètre d'URL ?room=N) : indice 0-based de la salle de départ du niveau courant.
   * GameScene LIT `session.startRoomIndex` à la création de la simulation (défaut : 0) ; il ne doit s'appliquer
   * qu'au PREMIER niveau lancé (le flux normal ne le renseigne jamais). DialogueScene le supprime en passant au
   * niveau suivant.
   */
  startRoomIndex?: number;
  /**
   * Niveaux (identifiants) déjà terminés dans cette partie : reportés dans la sauvegarde (voir src/core/save.ts).
   * Renseigné à la reprise (« Continuer ») ; GameScene le met à jour à la fin de chaque niveau pour le niveau suivant.
   */
  completedLevelIds?: string[];
  /**
   * Tutoriel (menu « Tutoriel » ou `?tutorial=1`) : `GameScene` joue `tutorialLevel` (hors campagne, hors sauvegarde) avec un partenaire
   * scripté. JSON pur. `initialDevice` : appareil qui l'a lancé (libellés de boutons avant la première entrée) ;
   * `campaignPlayers` : nombre de joueurs choisi au menu (la carte de fin précise l'effet en partie solo).
   */
  tutorial?: { initialDevice?: DeviceKind; campaignPlayers?: number };
  /**
   * Mode DÉMO (« attract mode », src/attract/) : `GameScene` joue la partie toute seule (pilote automatique), sans sauvegarde, sans
   * pause, sans son, pendant `durationMs` ms de temps réel, puis revient au menu. `seed` = graine de la simulation (tirée par la
   * scène de menu avec `Math.random`, jamais par le coeur). JSON pur.
   */
  demo?: { seed: number; durationMs: number };
}

/** Données de MenuScene : session précédente (pour restaurer les choix en revenant au menu). */
export interface MenuSceneData {
  session?: GameSession;
  /**
   * true quand on revient d'une démo (mode « attract ») : le menu avale les entrées pendant `ATTRACT_RETURN_GRACE_MS` (l'entrée qui
   * a interrompu la démo ne doit pas valider un élément) et n'applique aucune session (la démo ne modifie pas les choix du joueur).
   */
  afterDemo?: boolean;
}

/** Données de CharacterSelectScene : session construite par le menu (joueurs, difficultés, niveau de départ). */
export interface CharacterSelectSceneData {
  session: GameSession;
  /**
   * Reprise d'une sauvegarde : l'équipe (personnages, difficultés) est FIGÉE et verrouillée ; l'écran ne sert qu'à
   * attribuer les appareils (chaque joueur appuie sur un bouton pour rejoindre). Voir `src/render/saveMenuLogic.ts`.
   */
  resume?: boolean;
}

/** Événement DOM de dev émis sur `window` quand le démarrage rapide (?quick=1) lance Game ; `detail` = GameSession. */
export const DEV_QUICK_START_EVENT = 'vaelorn:quickstart';

export interface DialogueSceneData {
  session: GameSession;
  stage: 'intro' | 'outro';
}

export interface GameSceneData {
  session: GameSession;
}

export interface ResultSceneData {
  session: GameSession;
  outcome: 'victory' | 'defeat';
}

export function emptyStats(playerCount = 4): SessionStats {
  return {
    timeMs: 0,
    downs: Array.from({ length: playerCount }, () => 0),
    kills: Array.from({ length: playerCount }, () => 0),
  };
}

/** Session par défaut (1 joueur David, difficulté 2, niveau 1). */
export function createDefaultSession(): GameSession {
  return {
    playerCount: 1,
    players: [{ id: 0 as PlayerId, characterId: 'david', difficulty: 2 }],
    levelIndex: 0,
    stats: emptyStats(1),
  };
}
