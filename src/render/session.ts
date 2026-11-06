import type { PlayerId, PlayerSetup } from '../core/types';

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
}

/** Données de MenuScene : session précédente (pour restaurer les choix en revenant au menu). */
export interface MenuSceneData {
  session?: GameSession;
}

/** Données de CharacterSelectScene : session construite par le menu (joueurs, difficultés, niveau de départ). */
export interface CharacterSelectSceneData {
  session: GameSession;
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
