/**
 * Couche d'obscurité d'une salle sombre côté scène : crée la `DarknessLayer` (src/render/darkness.ts) à la construction
 * d'une salle `dark`, la met à jour à chaque frame avec les sources de lumière (torches des joueurs placées sur la
 * position INTERPOLÉE du héros, braseros allumés, décors torche) et la détruit proprement (changement de salle,
 * redémarrage, arrêt de la scène — aucune fuite).
 *
 * Visibilité : la couche est un objet du MONDE (rendue par les caméras joueur, jamais par la caméra d'interface) ; tout le
 * HUD (noms, cœurs, objectifs, invites, bannières, flèches) vit sur la caméra d'interface et reste donc lisible.
 * Profondeur : au-dessus du monde (sprites, ennemis, projectiles, FX : < DEPTH_LABELS) mais sous les étiquettes du monde.
 */
import type Phaser from 'phaser';
import { lightSources, type LightSource } from '../core/light';
import type { GameState, RoomDef } from '../core/types';
import { DarknessLayer } from '../render/darkness';
import type { ViewRig } from '../render/camera';
import { DEPTH_LABELS } from '../render/fx';

/** Profondeur de la couche d'obscurité : au-dessus des FX (5000), sous les étiquettes du monde (6000). */
export const DARKNESS_DEPTH = DEPTH_LABELS - 0.5;

/** Position (px monde) où se trouve la lumière d'un héros, pour un héros dessiné en (x, y) : légèrement au-dessus des pieds. */
export function torchLightPos(viewX: number, viewY: number): { x: number; y: number } {
  return { x: viewX, y: viewY - 3 };
}

/** Une salle sombre vivante : à détruire quand on quitte la salle. */
export class DarkRoomView {
  private layer: DarknessLayer | null;
  private readonly room: RoomDef;

  constructor(scene: Phaser.Scene, rig: ViewRig, room: RoomDef, widthPx: number, heightPx: number) {
    this.room = room;
    this.layer = new DarknessLayer(scene, widthPx, heightPx, { depth: DARKNESS_DEPTH });
    // le voile est un objet du MONDE : rendu par les caméras joueur, ignoré par la caméra d'interface (le HUD reste net)
    const rt = this.layer.object;
    if (rt) rig.registerWorld(rt);
  }

  /**
   * Met à jour la couche. `heroPos(playerId)` renvoie la position interpolée affichée du héros (ou null) :
   * la lumière suit ainsi le sprite sans à-coup.
   */
  update(state: GameState, timeMs: number, heroPos: (playerId: number) => { x: number; y: number } | null): void {
    const layer = this.layer;
    if (!layer) return;
    const lights: LightSource[] = lightSources(state, this.room);
    for (const l of lights) {
      if (l.kind !== 'torch' || l.playerId === undefined) continue;
      const pos = heroPos(l.playerId);
      if (pos) {
        l.x = pos.x;
        l.y = pos.y;
      }
    }
    layer.update(lights, timeMs);
  }

  /** Détruit la couche (idempotent). */
  destroy(): void {
    this.layer?.destroy();
    this.layer = null;
  }
}
