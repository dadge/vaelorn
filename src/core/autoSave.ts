/**
 * SAUVEGARDE AUTOMATIQUE — branche les événements de la simulation sur le `SaveRepository`.
 *
 * Aucune dépendance à Phaser/DOM/Date : la scène de jeu n'a qu'à appeler `handleEvents(events)` avec les `SimEvent` de chaque
 * pas de simulation. Écritures :
 *  - `roomEntered` 'start' | 'next' : début de salle (jamais en pleine salle / plein combat) ;
 *  - `levelCompleted` : niveau terminé, AVANT de passer au niveau suivant (reprise = salle 0 du niveau suivant) ;
 *  - `gearLost` (un joueur tombe et perd tout son équipement) : l'équipement sauvegardé de CE joueur est vidé IMMÉDIATEMENT, sans changer la salle de reprise
 *    (règle stricte : quitter la partie puis « Continuer » ne restitue pas l'équipement perdu, y compris pendant le délai de la défaite d'équipe) ;
 *  - `roomEntered` 'restart' (défaite collective) et tous les autres événements : la salle de reprise n'est ni modifiée ni supprimée (on reprendra au début de la
 *    salle sauvegardée).
 * ÉQUIPEMENT (schéma v3) : avec `gearProvider` (équipement courant de chaque joueur, lu au moment de l'événement), le début de salle ('start' | 'next') sauvegarde
 * l'équipement porté à cet instant (l'équipement perdu n'y est évidemment plus) ; la fin d'un niveau le remet à zéro (équipement valable jusqu'à la fin du
 * niveau). La perte (`gearLost`) est écrite au moment même de la chute ; une défaite collective ('restart') ne change PAS la salle de reprise, mais enregistre
 * l'équipement (alors vide : règle stricte, pas de point de reprise) : « Continuer » ne ressuscite donc jamais l'équipement perdu. Écrit seulement si l'équipement
 * a réellement changé.
 * Une écriture identique à la dernière valeur connue du stockage est sautée. Une écriture qui échoue est signalée via
 * `onError` (une seule fois par type d'erreur consécutif) et retentée à la prochaine salle.
 *
 * `enabled: false` (mode `?quick=1`, `?nosave=1`, paramètres de dev) : l'état est suivi mais RIEN n'est jamais écrit.
 */
import { applySimEvents, newGameSave, serializeSave, withGear, type SaveContext, type SaveGame } from './save';
import type { SaveRepository, SaveStorageError } from './saveRepository';
import type { PlayerGear, PlayerSetup, SimEvent } from './types';

export interface AutoSaverOptions {
  repository: SaveRepository;
  context: SaveContext;
  /** Niveau joué par la simulation. */
  levelId: string;
  /** Équipe de la partie (figée dans la sauvegarde). */
  players: readonly PlayerSetup[];
  /** Niveaux déjà terminés avant ce niveau (reprise d'une partie / enchaînement des niveaux). */
  completedLevelIds?: readonly string[];
  /**
   * Sauvegarde déjà présente dans le stockage et correspondant à cette partie (cas « Continuer ») : sert de point de départ,
   * et n'est pas réécrite tant qu'elle ne change pas. Absent : nouvelle partie (la 1re salle atteinte écrit la sauvegarde).
   */
  existing?: SaveGame | null;
  /** false : suit l'état mais n'écrit jamais (démarrage rapide, `?nosave=1`). Défaut true. */
  enabled?: boolean;
  /** Équipement courant de chaque joueur (dans l'ordre de `players`), lu à chaque début de salle. Absent : l'équipement n'est pas sauvegardé. */
  gearProvider?: () => readonly PlayerGear[];
  /** Appelé quand une écriture échoue (quota, stockage bloqué). */
  onError?: (error: SaveStorageError) => void;
}

export class AutoSaver {
  private current: SaveGame;
  /** Dernière valeur sérialisée connue du stockage (null = rien d'écrit par cette partie). */
  private lastWritten: string | null;
  private errorCode: string | null = null;
  private readonly repository: SaveRepository;
  private readonly context: SaveContext;
  private readonly levelId: string;
  private readonly enabled: boolean;
  private readonly onError?: (error: SaveStorageError) => void;
  private readonly gearProvider?: () => readonly PlayerGear[];
  /** Dernière erreur d'écriture (null après une écriture réussie). */
  lastError: SaveStorageError | null = null;
  /** Nombre d'écritures réussies. */
  writeCount = 0;

  constructor(options: AutoSaverOptions) {
    this.repository = options.repository;
    this.context = options.context;
    this.levelId = options.levelId;
    this.enabled = options.enabled !== false;
    this.onError = options.onError;
    this.gearProvider = options.gearProvider;
    if (options.existing) {
      this.current = options.existing;
      this.lastWritten = serializeSave(options.existing);
    } else {
      const base = newGameSave(options.players, options.levelId);
      this.current = { ...base, completedLevelIds: [...(options.completedLevelIds ?? [])] };
      this.lastWritten = null;
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Sauvegarde courante (suivie même si `enabled` est faux). */
  get save(): SaveGame {
    return this.current;
  }

  /** Niveaux terminés (à reporter dans la session pour le niveau suivant). */
  get completedLevelIds(): readonly string[] {
    return this.current.completedLevelIds;
  }

  /** À appeler avec les événements de chaque pas de simulation. Retourne true si une écriture a eu lieu. */
  handleEvents(events: readonly SimEvent[]): boolean {
    const relevant = events.some(
      (e) => (e.type === 'roomEntered' && (e.reason === 'start' || e.reason === 'next')) || e.type === 'levelCompleted' || e.type === 'gearLost',
    );
    // défaite collective : la salle de reprise ne change pas, mais l'équipement (perdu) est enregistré
    const restart = this.gearProvider !== undefined && events.some((e) => e.type === 'roomEntered' && e.reason === 'restart');
    if (!relevant && !restart) return false;
    this.current = applySimEvents(this.current, this.levelId, events, this.context);
    if (this.gearProvider && events.some((e) => e.type === 'roomEntered') && !events.some((e) => e.type === 'levelCompleted')) {
      this.current = withGear(this.current, this.gearProvider());
    }
    if (!this.enabled) return false;
    const data = serializeSave(this.current);
    if (data === this.lastWritten) return false;
    const res = this.repository.save(this.current);
    if (res.ok) {
      this.lastWritten = data;
      this.lastError = null;
      this.errorCode = null;
      this.writeCount++;
      return true;
    }
    this.lastError = res.error;
    if (this.errorCode !== res.error.code) {
      this.errorCode = res.error.code;
      try {
        this.onError?.(res.error);
      } catch {
        /* un callback d'interface défaillant ne doit jamais casser la partie */
      }
    }
    return false;
  }
}
