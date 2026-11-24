/**
 * MINICARTE (dessin Phaser) : plan translucide de la salle courante, au centre de l'écran partagé (ou sur le bord droit à 1 vue),
 * complété au fil de la découverte, avec un pion par héros. Toute la logique (découverte, pions, placement, clignotement) est dans
 * `miniMap.ts` (pure, testée) ; ce fichier ne fait que dessiner.
 *
 * Intégration (lot C) :
 *   const map = new MiniMapHud({ ctx, layout });           // une seule instance pour toute la partie (pas une par vue)
 *   map.setVisible(loadMapVisible());                      // préférence mémorisée (touche Tab : `saveMapVisible`)
 *   map.update(state, room, dtMs, timeMs, centerOf);       // chaque frame, MÊME carte masquée (la découverte continue)
 *   map.destroy();                                         // à l'arrêt de la scène
 * `centerOf(v)` (centre monde de la caméra de la vue `v`, optionnel) : la carte s'estompe quand un héros passe sous elle dans l'une des vues (bord droit à 1 vue, centre de l'écran à 2-4 vues).
 *
 * Rendu : le terrain est un `CanvasTexture` d'UN pixel par tuile (mis à jour tuile par tuile, uniquement pour les tuiles nouvellement découvertes),
 * affiché à l'échelle entière choisie, filtrage NEAREST (traits nets). Les pions sont des objets créés une fois (cercles, croix) dont on ne
 * change que la position / l'opacité / l'échelle : aucune géométrie reconstruite et aucune allocation par frame.
 * Profondeur (`HUD_DEPTH.map`) : au-dessus du monde, des séparateurs et du HUD permanent (qui ne s'étend jamais dans sa zone) ; SOUS les éléments transitoires qui peuvent y entrer
 * (invite, bulle de panneau, flèches et demi-cercles d'appel : `HUD_DEPTH.transient`) et sous les bandeaux / notifications (`HUD_DEPTH.banner`).
 * Aucun texte : rien à retraduire (`retranslate` existe pour symétrie avec les autres blocs du HUD).
 */
import type Phaser from 'phaser';
import { PLAYER_COLORS } from '../core/constants';
import type { GameState, RoomDef, Vec2 } from '../core/types';
import type { ViewContext } from '../entities/common';
import { HUD_DEPTH } from './hud';
import {
  MAP_TILE,
  MARKER_DOT_RADIUS,
  MARKER_DOWN_HALF,
  MARKER_DOWN_LINE,
  MARKER_HEAL_ARM,
  MARKER_HEAL_HALF,
  MARKER_HEAL_OFFSET,
  MARKER_RING_RADIUS,
  computeMarkers,
  createMapMemory,
  createMarkerVisual,
  heroesUnderMap,
  mapPlacement,
  markerDotDepth,
  markerSizeFactor,
  markerVisual,
  updateMapMemory,
  worldToMapPx,
  type MapMarker,
  type MapMemory,
  type MapPlacement,
} from './miniMap';
import type { SplitLayout } from './splitscreen';

/** Profondeur de la carte : au-dessus des séparateurs (`bg + 5`), sous les éléments transitoires (`transient` = 17 : invite, bulle, appels) et les bandeaux (`banner` = 20). Pions et croix : au plus `+ 0.7`. */
export const MAP_DEPTH = HUD_DEPTH.map;
/** Fond du panneau : bleu-nuit presque noir (comme les séparateurs), translucide pour laisser voir le jeu dessous. */
export const MAP_PANEL_COLOR = 0x0b0912;
export const MAP_PANEL_ALPHA = 0.42;
/** Liseré du panneau. */
export const MAP_FRAME_COLOR = 0xcfc8e8;
export const MAP_FRAME_ALPHA = 0.45;
/** Liseré clair des pions (lisible sur tout fond) et sombre des croix. */
export const MAP_MARKER_OUTLINE = 0xf4f0ff;
export const MAP_MARKER_DARK = 0x0b0912;
/** Rouge de la croix médicale et de la croix « à terre ». */
export const MAP_CROSS_RED = 0xe0303a;
/** Couleurs (CSS) d'une tuile découverte, par classe : sol discret, trait des murs clair, masse pleine à peine visible, fosse bleutée. */
export const MAP_TILE_CSS: Readonly<Record<number, string>> = {
  [MAP_TILE.floor]: 'rgba(190,205,255,0.30)',
  [MAP_TILE.edge]: 'rgba(236,232,255,0.95)',
  [MAP_TILE.solid]: 'rgba(150,150,190,0.12)',
  [MAP_TILE.pit]: 'rgba(70,110,190,0.55)',
};
/** Opacité minimale de la carte quand un héros (dans l'une des vues) passe dessous. */
export const MAP_HERO_FADE_ALPHA = 0.25;
/** Constante de temps (ms) du fondu quand un héros passe sous la carte. */
export const MAP_FADE_MS = 150;

/** Ce dont la carte a besoin : le contexte de vue et la disposition de l'écran (un `HudEnv` convient). */
export interface MiniMapEnv {
  ctx: ViewContext;
  layout: SplitLayout;
}

type Arc = Phaser.GameObjects.Arc;
type Gfx = Phaser.GameObjects.Graphics;

/** Objets d'un pion. */
interface MarkerObjs {
  ring: Arc;
  dot: Arc;
  heal: Gfx;
  down: Gfx;
}

let instanceCounter = 0;

export class MiniMapHud {
  private readonly ctx: ViewContext;
  private readonly layout: SplitLayout;
  private readonly textureBase: string;
  private readonly panel: Phaser.GameObjects.Rectangle;
  private readonly frame: Gfx;
  private readonly markerObjs: MarkerObjs[] = [];
  private image: Phaser.GameObjects.Image | null = null;
  private texture: Phaser.Textures.CanvasTexture | null = null;
  private textureKey = '';
  private textureGen = 0;
  private memory: MapMemory | null = null;
  private placement: MapPlacement | null = null;
  /** Tuiles déjà peintes dans le canvas (1 = peinte) : seules les nouvelles sont dessinées. */
  private painted = new Uint8Array(0);
  private dirty = false;
  private visible = true;
  /** Opacité globale (fondu quand un héros passe sous la carte) et dernière valeur appliquée au terrain. */
  private fade = 1;
  private appliedFade = -1;
  private readonly markers: MapMarker[] = [];
  private readonly visual = createMarkerVisual();
  private readonly scratch = { x: 0, y: 0 };
  private destroyed = false;

  constructor(env: MiniMapEnv) {
    this.ctx = env.ctx;
    this.layout = env.layout;
    this.textureBase = `minimap_${instanceCounter++}`;
    const scene = env.ctx.scene;
    const reg = <T extends Phaser.GameObjects.GameObject>(o: T): T => env.ctx.rig.registerHud(o);

    this.panel = reg(scene.add.rectangle(0, 0, 10, 10, MAP_PANEL_COLOR, MAP_PANEL_ALPHA));
    this.panel.setOrigin(0, 0).setDepth(MAP_DEPTH);
    this.frame = reg(scene.add.graphics());
    this.frame.setDepth(MAP_DEPTH + 0.1);

    for (let id = 0; id < 4; id++) {
      const color = PLAYER_COLORS[id] ?? 0xffffff;
      const ring = reg(scene.add.circle(0, 0, MARKER_RING_RADIUS));
      ring.setStrokeStyle(1.5, color, 1).setDepth(MAP_DEPTH + 0.2).setVisible(false);
      const dot = reg(scene.add.circle(0, 0, MARKER_DOT_RADIUS, color));
      dot.setStrokeStyle(1, MAP_MARKER_OUTLINE, 1).setDepth(MAP_DEPTH + 0.3).setVisible(false);
      const heal = reg(scene.add.graphics());
      heal.setDepth(MAP_DEPTH + 0.5 + id * 0.002).setVisible(false); // la croix « à terre » (+ 0.6) passe toujours au-dessus de la croix médicale
      this.drawHealCross(heal);
      const down = reg(scene.add.graphics());
      down.setDepth(MAP_DEPTH + 0.6 + id * 0.002).setVisible(false);
      this.drawDownCross(down);
      this.markerObjs.push({ ring, dot, heal, down });
    }
    this.panel.setVisible(false);
    this.frame.setVisible(false);
  }

  /** Croix médicale : carré blanc cerclé de sombre, croix rouge (forme distincte du point et de la croix « à terre »). */
  private drawHealCross(g: Gfx): void {
    const h = MARKER_HEAL_HALF;
    const a = MARKER_HEAL_ARM / 2;
    g.fillStyle(MAP_MARKER_DARK, 1).fillRect(-h - 1, -h - 1, 2 * h + 2, 2 * h + 2);
    g.fillStyle(0xffffff, 1).fillRect(-h, -h, 2 * h, 2 * h);
    g.fillStyle(MAP_CROSS_RED, 1);
    g.fillRect(-a, -h + 1, MARKER_HEAL_ARM, 2 * h - 2);
    g.fillRect(-h + 1, -a, 2 * h - 2, MARKER_HEAL_ARM);
  }

  /** Croix « à terre » : ✕ rouge cerclé de sombre (deux diagonales). */
  private drawDownCross(g: Gfx): void {
    const h = MARKER_DOWN_HALF;
    g.lineStyle(MARKER_DOWN_LINE + 2, MAP_MARKER_DARK, 1);
    g.lineBetween(-h, -h, h, h);
    g.lineBetween(-h, h, h, -h);
    g.lineStyle(MARKER_DOWN_LINE, MAP_CROSS_RED, 1);
    g.lineBetween(-h, -h, h, h);
    g.lineBetween(-h, h, h, -h);
  }

  /** Placement courant (après le premier `update`), `null` avant. */
  get currentPlacement(): MapPlacement | null {
    return this.placement;
  }

  get isVisible(): boolean {
    return this.visible;
  }

  /** Affiche / masque la carte (la découverte continue à se mettre à jour masquée). */
  setVisible(visible: boolean): void {
    if (this.destroyed) return;
    this.visible = visible;
    this.applyVisibility();
  }

  private applyVisibility(): void {
    const show = this.visible && this.placement !== null;
    this.panel.setVisible(show);
    this.frame.setVisible(show);
    this.image?.setVisible(show);
    if (!show) {
      for (const m of this.markerObjs) {
        m.ring.setVisible(false);
        m.dot.setVisible(false);
        m.heal.setVisible(false);
        m.down.setVisible(false);
      }
    }
  }

  /** La carte ne contient aucun texte : rien à retraduire (méthode présente pour symétrie avec les autres blocs du HUD). */
  retranslate(): void {
    /* aucun texte */
  }

  /**
   * Met à jour la découverte, le dessin du terrain (seulement si quelque chose a changé) et les pions.
   * @param centerOf centre monde de la caméra de la vue `v` (une par vue de la disposition) : sert à estomper la carte quand un héros passe dessous dans une vue ; absent : pas de fondu.
   */
  update(state: GameState, room: RoomDef, dtMs: number, timeMs: number, centerOf?: (viewIndex: number) => Vec2): void {
    if (this.destroyed) return;
    if (!this.memory) this.memory = createMapMemory(room);
    const mem = this.memory;
    const upd = updateMapMemory(mem, room, state.players, state.room.elapsedMs);
    if (!this.placement || upd.reset) this.layoutRoom(mem);
    if (upd.changed) this.dirty = true;
    const placement = this.placement;
    if (!this.visible || !placement) return;

    if (this.dirty) {
      this.paintNewTiles(mem);
      this.dirty = false;
    }
    this.updateFade(state, placement, dtMs, centerOf);
    this.updateMarkers(state, placement, timeMs);
  }

  /** (Re)calcule le placement pour la salle de `mem` et prépare le terrain (nouveau canvas si la taille change). */
  private layoutRoom(mem: MapMemory): void {
    const placement = mapPlacement(this.layout, mem.cols, mem.rows);
    this.placement = placement;
    const { panel, map, scale } = placement;
    this.panel.setPosition(panel.x, panel.y).setSize(panel.w, panel.h);
    this.frame.clear();
    this.frame.lineStyle(1, MAP_FRAME_COLOR, MAP_FRAME_ALPHA);
    this.frame.strokeRect(panel.x + 0.5, panel.y + 0.5, panel.w - 1, panel.h - 1);

    const sameSize = this.texture !== null && this.texture.width === mem.cols && this.texture.height === mem.rows;
    if (!sameSize) this.makeTexture(mem.cols, mem.rows);
    else this.clearTexture();
    this.painted = new Uint8Array(mem.cols * mem.rows);
    if (this.image) this.image.setPosition(map.x, map.y).setScale(scale).setAlpha(this.fade);
    this.dirty = true;
    this.applyVisibility();
  }

  private makeTexture(cols: number, rows: number): void {
    const scene = this.ctx.scene;
    this.dropTexture();
    this.textureKey = `${this.textureBase}_${this.textureGen++}`;
    const tex = scene.textures.createCanvas(this.textureKey, cols, rows);
    this.texture = tex;
    if (!tex) {
      this.textureKey = '';
      return;
    }
    tex.setFilter(1 as Phaser.Textures.FilterMode); // NEAREST : traits nets, quelle que soit l'option de lissage
    if (!this.image) {
      const img = this.ctx.rig.registerHud(scene.add.image(0, 0, this.textureKey));
      img.setOrigin(0, 0).setDepth(MAP_DEPTH + 0.05);
      this.image = img;
    } else {
      this.image.setTexture(this.textureKey);
    }
  }

  private clearTexture(): void {
    const g = this.texture?.getContext();
    if (!this.texture || !g) return;
    g.clearRect(0, 0, this.texture.width, this.texture.height);
    this.texture.refresh();
  }

  private dropTexture(): void {
    if (this.textureKey && this.ctx.scene.textures.exists(this.textureKey)) {
      // L'image garde une référence : on la bascule sur la nouvelle texture juste après (voir `makeTexture`).
      this.ctx.scene.textures.remove(this.textureKey);
    }
    this.texture = null;
    this.textureKey = '';
  }

  /** Peint dans le canvas les tuiles découvertes pas encore peintes (une `fillRect` de 1 px par tuile nouvelle) ; un seul `refresh`. */
  private paintNewTiles(mem: MapMemory): void {
    const tex = this.texture;
    const g = tex?.getContext();
    if (!tex || !g) return;
    let lastClass = -1;
    let any = false;
    const { cols, known, tiles } = mem;
    for (let i = 0; i < known.length; i++) {
      if (known[i] === 0 || this.painted[i] === 1) continue;
      this.painted[i] = 1;
      const c = tiles[i];
      if (c === MAP_TILE.void) continue;
      if (c !== lastClass) {
        g.fillStyle = MAP_TILE_CSS[c];
        lastClass = c;
      }
      g.fillRect(i % cols, Math.floor(i / cols), 1, 1);
      any = true;
    }
    if (any) tex.refresh();
  }

  /**
   * Estompe la carte quand un héros passerait dessous dans l'une des vues (bord droit d'une vue unique ; centre de l'écran à 2-4 vues, où la carte chevauche les vues voisines : une sortie
   * ou un héros qui longe le mur est ne doit pas disparaître sous elle) ; fondu lissé, indépendant du nombre d'images par seconde.
   */
  private updateFade(state: GameState, placement: MapPlacement, dtMs: number, centerOf?: (viewIndex: number) => Vec2): void {
    const under = centerOf !== undefined && heroesUnderMap(this.layout.viewports, placement.panel, state.players, centerOf);
    const target = under ? MAP_HERO_FADE_ALPHA : 1;
    const k = dtMs > 0 ? 1 - Math.exp(-dtMs / MAP_FADE_MS) : 1;
    this.fade += (target - this.fade) * k;
    if (Math.abs(this.fade - target) < 0.01) this.fade = target;
    if (Math.abs(this.fade - this.appliedFade) > 0.005) {
      this.appliedFade = this.fade;
      this.panel.setAlpha(this.fade);
      this.frame.setAlpha(this.fade);
      this.image?.setAlpha(this.fade);
    }
  }

  /** Place et anime les pions : position, opacité et échelle d'objets existants uniquement. */
  private updateMarkers(state: GameState, placement: MapPlacement, timeMs: number): void {
    const list = computeMarkers(state.players, this.markers);
    const fade = this.fade;
    const size = markerSizeFactor(placement.scale);
    for (let i = 0; i < this.markerObjs.length; i++) {
      const o = this.markerObjs[i];
      const m = list[i];
      if (!m) {
        o.ring.setVisible(false);
        o.dot.setVisible(false);
        o.heal.setVisible(false);
        o.down.setVisible(false);
        continue;
      }
      markerVisual(m, timeMs, this.visual);
      const v = this.visual;
      const pos = worldToMapPx(placement, m.x, m.y, this.scratch);
      const x = Math.round(pos.x);
      const y = Math.round(pos.y);
      // ordre de dessin par priorité (à terre > à soigner > appel > normal) : un point sain ne cache jamais le point ni la croix d'un héros qui a besoin d'aide ; Phaser ne retrie que si la profondeur change
      const depth = markerDotDepth(MAP_DEPTH + 0.3, m);
      if (o.dot.depth !== depth) o.dot.setDepth(depth);
      o.dot.setPosition(x, y).setScale(size).setAlpha(v.dotAlpha * fade).setVisible(true);
      o.ring.setVisible(v.ringVisible);
      if (v.ringVisible) o.ring.setPosition(x, y).setScale(v.ringScale * size).setAlpha(v.ringAlpha * fade);
      o.heal.setVisible(v.healCross);
      if (v.healCross) o.heal.setPosition(x + MARKER_HEAL_OFFSET * size, y - MARKER_HEAL_OFFSET * size).setScale(size).setAlpha(fade);
      o.down.setVisible(v.downCross);
      if (v.downCross) o.down.setPosition(x, y).setScale(size).setAlpha(fade);
    }
  }

  /** Détruit les objets et la texture (idempotent). */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.panel.destroy();
    this.frame.destroy();
    this.image?.destroy();
    this.image = null;
    for (const o of this.markerObjs) {
      o.ring.destroy();
      o.dot.destroy();
      o.heal.destroy();
      o.down.destroy();
    }
    this.markerObjs.length = 0;
    this.dropTexture();
    this.memory = null;
    this.placement = null;
  }
}
