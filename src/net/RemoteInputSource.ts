/**
 * Source d'entrée « réseau » : mémorise la dernière frame reçue d'un joueur distant et la rejoue à chaque `poll()`.
 * À brancher avec `inputManager.registerSource(playerId, source)` ; alimenter via `push()` depuis
 * `NetAdapter.onRemoteInputs`. (Squelette : pas de tampon de gigue ni de prédiction — voir README.md.)
 */
import type { ActionFrame, PlayerId } from '../core/types';
import type { InputSource } from '../input/actions';
import { emptyFrame } from '../input/mapping';

export class RemoteInputSource implements InputSource {
  readonly kind = 'network' as const;
  readonly id: string;
  private last: ActionFrame = emptyFrame();
  private isConnected = true;

  constructor(playerId: PlayerId) {
    this.id = `network:${playerId}`;
  }

  /** Enregistre la dernière frame reçue (copiée). */
  push(frame: ActionFrame): void {
    this.last = { ...frame };
  }

  /** Marque le pair comme connecté/déconnecté (déconnecté ⇒ frame vide côté InputManager). */
  setConnected(connected: boolean): void {
    this.isConnected = connected;
    if (!connected) this.last = emptyFrame();
  }

  connected(): boolean {
    return this.isConnected;
  }

  poll(): ActionFrame {
    return { ...this.last };
  }

  reset(): void {
    this.last = emptyFrame();
  }
}
