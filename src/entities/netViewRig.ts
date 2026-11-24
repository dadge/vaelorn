/**
 * Caméras d'une partie RÉSEAU : même `ViewRig` (une seule vue, indice 0), mais les méthodes qui désignent un JOUEUR (et non un indice de vue) tiennent compte du fait que l'appareil
 * local est le joueur `localPlayerId` (1..3 pour un invité) dans l'unique vue 0 (docs/NET.md § 7.2). `follow` et `centerOf` restent indexées par VUE (la scène leur passe 0).
 *
 *  - `registerVision(obj, joueur)` : objet visible seulement du joueur (vision partagée, énigme de runes) : visible dans la vue 0 si c'est le joueur local, caché partout sinon ;
 *  - `shake(durée, intensité, joueur)` : secousse de la vue seulement quand l'événement concerne le joueur local, jamais pour un autre (sans joueur : la vue, comme avant).
 */
import type Phaser from 'phaser';
import type { PlayerId } from '../core/types';
import { ViewRig } from '../render/camera';
import type { SplitLayout } from '../render/splitscreen';
import { viewOfPlayer } from './netView';

export class NetViewRig extends ViewRig {
  constructor(
    scene: Phaser.Scene,
    layout: SplitLayout,
    private readonly localPlayerId: number,
  ) {
    super(scene, layout);
  }

  override registerVision<T extends Phaser.GameObjects.GameObject>(obj: T, playerId: PlayerId): T {
    const view = viewOfPlayer(this.localPlayerId, playerId);
    if (view >= 0) return super.registerVision(obj, view as PlayerId);
    this.uiCam.ignore(obj);
    for (const cam of this.playerCams) cam.ignore(obj);
    return obj;
  }

  override shake(durationMs: number, intensity: number, playerId?: number): void {
    if (playerId === undefined) {
      super.shake(durationMs, intensity);
      return;
    }
    const view = viewOfPlayer(this.localPlayerId, playerId);
    if (view >= 0) super.shake(durationMs, intensity, view);
  }
}
