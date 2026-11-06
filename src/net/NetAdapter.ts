/**
 * Interface réseau (DESIGN.md §1) pour le futur multijoueur EN LIGNE. Aucune dépendance réseau réelle ici :
 * seulement le contrat et un adaptateur local. La simulation (`src/core`) est déterministe et son état est du
 * JSON pur, ce qui autorise deux modèles (voir README.md) :
 *  - lockstep / entrées : on échange des `ActionFrame` par tick et chaque pair simule ;
 *  - autoritaire hôte : le client envoie ses entrées, l'hôte simule et diffuse des `GameState` (snapshots).
 * Cette interface supporte les deux.
 */
import type { ActionFrame, GameState, PlayerId } from '../core/types';

/** `local` = partie locale (aucun réseau) ; `host` = héberge et fait autorité ; `client` = rejoint un hôte. */
export type NetMode = 'local' | 'host' | 'client';

/** Fonction de désabonnement retournée par les `on…`. */
export type Unsubscribe = () => void;

/** Rappel de réception d'entrées distantes : entrée `frame` du joueur `playerId` pour le pas `tick`. */
export type RemoteInputsCallback = (tick: number, playerId: PlayerId, frame: ActionFrame) => void;

/** Rappel de réception d'un snapshot d'état (client : état autoritaire de l'hôte). */
export type SnapshotCallback = (state: GameState) => void;

export interface NetAdapter {
  /** Rôle de cet adaptateur. */
  readonly mode: NetMode;
  /** true quand la liaison est établie (toujours true en `local`). */
  readonly connected: boolean;

  /** Démarre l'adaptateur (ouverture de connexion pour host/client). Résout quand prêt. */
  start(): Promise<void>;
  /** Arrête l'adaptateur et libère les ressources. Idempotent. */
  stop(): void;

  /**
   * Envoie les entrées d'un joueur LOCAL pour le pas `tick` (numéro de tick de simulation, `GameState.tick`).
   * Le `frame` est une valeur « tenue » (voir `ActionFrame`) ; l'implémentation doit le copier si elle le conserve.
   */
  sendInputs(tick: number, playerId: PlayerId, frame: ActionFrame): void;
  /** Abonne un rappel aux entrées reçues des pairs distants. Retourne la fonction de désabonnement. */
  onRemoteInputs(cb: RemoteInputsCallback): Unsubscribe;

  /** Hôte : diffuse l'état autoritaire (JSON pur, copier avant envoi). Sans effet côté client/local. */
  sendSnapshot(state: GameState): void;
  /** Client : abonne un rappel aux snapshots de l'hôte. Retourne la fonction de désabonnement. */
  onSnapshot(cb: SnapshotCallback): Unsubscribe;

  /** Mesure l'aller-retour (ms) vers le pair distant. `local` : 0. */
  ping(): Promise<number>;
}

/** Copie profonde d'une valeur JSON pure (isole l'émetteur du récepteur dans le loopback). */
function cloneJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export interface LocalNetAdapterOptions {
  /**
   * Si true, `sendInputs`/`sendSnapshot` rappellent immédiatement (de façon synchrone, sur des COPIES)
   * les abonnés `onRemoteInputs`/`onSnapshot` de ce même adaptateur : utile pour tester le flux réseau
   * sans réseau. Défaut false : no-op total (partie locale classique).
   */
  loopback?: boolean;
}

/**
 * Adaptateur « local » : aucune communication. En mode `loopback`, renvoie ce qu'on lui envoie à ses propres abonnés.
 */
export class LocalNetAdapter implements NetAdapter {
  readonly mode: NetMode = 'local';
  private running = false;
  private readonly loopback: boolean;
  private readonly inputCbs = new Set<RemoteInputsCallback>();
  private readonly snapshotCbs = new Set<SnapshotCallback>();

  constructor(opts: LocalNetAdapterOptions = {}) {
    this.loopback = opts.loopback ?? false;
  }

  get connected(): boolean {
    return true;
  }

  /** true entre `start()` et `stop()`. */
  get isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    this.running = true;
  }

  stop(): void {
    this.running = false;
  }

  sendInputs(tick: number, playerId: PlayerId, frame: ActionFrame): void {
    if (!this.loopback) return;
    for (const cb of Array.from(this.inputCbs)) cb(tick, playerId, cloneJson(frame));
  }

  onRemoteInputs(cb: RemoteInputsCallback): Unsubscribe {
    this.inputCbs.add(cb);
    return () => {
      this.inputCbs.delete(cb);
    };
  }

  sendSnapshot(state: GameState): void {
    if (!this.loopback) return;
    for (const cb of Array.from(this.snapshotCbs)) cb(cloneJson(state));
  }

  onSnapshot(cb: SnapshotCallback): Unsubscribe {
    this.snapshotCbs.add(cb);
    return () => {
      this.snapshotCbs.delete(cb);
    };
  }

  async ping(): Promise<number> {
    return 0;
  }
}
