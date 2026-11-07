/**
 * Vue d'une salle : tuiles cuites UNE fois dans un RenderTexture, décors (torches animées + lueurs), panneaux,
 * mécanismes (voir MechanismViews), sortie (ouverte / fermée / scellée), zones d'objectifs et étiquettes de proximité.
 *
 * Une RoomView vit le temps d'une salle : `destroy()` libère TOUS ses objets Phaser (aucune fuite entre salles).
 * Elle LIT GameState (mécanismes, objectifs, joueurs) : zéro règle de jeu.
 */
import type Phaser from 'phaser';
import { RoomGrid } from '../core/grid';
import { PLAYER_COLORS, TILE } from '../core/constants';
import { resolveSlot } from '../core/slots';
import type {
  DecorDef,
  GameState,
  KeyDef,
  LevelDef,
  MechanismDef,
  ObjectiveDef,
  ObjectiveState,
  PlayerId,
  RoomDef,
  SignDef,
  Vec2,
} from '../core/types';
import { t } from '../i18n/i18n';
import { ATLAS_KEY } from '../render/art';
import { exitFrame, tileFrame, torchFrame } from '../render/art/animations';
import { DEPTH_LABELS, FX_GLOW_KEY, makeWorldText } from '../render/fx';
import { THEME_PALETTES } from '../render/palettes';
import { DEPTH, ySortDepth, type ViewContext } from './common';
import { createMechView, isRuneView, slotColor, type MechView } from './MechanismViews';

type Obj = Phaser.GameObjects.GameObject;

/** Panneau posé dans la salle (le texte s'affiche dans le HUD du joueur proche). */
export interface SignInfo {
  id: string;
  textKey: string;
  /** Centre en pixels monde. */
  x: number;
  y: number;
}

interface TorchView {
  sprite: Phaser.GameObjects.Image;
  glow: Phaser.GameObjects.Image;
  phase: number;
  base: number;
  /** true : torche (frames animées) ; false : cristal (lueur seule). */
  animated: boolean;
}

interface LabelView {
  text: Phaser.GameObjects.Text;
  key: string;
  /** Vue de mécanisme dont le centre sert d'ancre (sinon `fixed`). */
  view: MechView | null;
  fixed: Vec2;
  offsetY: number;
  radius: number;
  shownAlpha: number;
}

interface ZoneView {
  def: ObjectiveDef;
  fill: Phaser.GameObjects.Rectangle;
  progress: Phaser.GameObjects.Rectangle;
  label: Phaser.GameObjects.Text;
  x: number;
  y: number;
  w: number;
  h: number;
  color: number;
}

/** Rayon (px) autour d'un mécanisme dans lequel son étiquette apparaît. */
export const LABEL_RADIUS = 56;

export class RoomView {
  readonly widthPx: number;
  readonly heightPx: number;
  readonly backgroundColor: number;
  readonly signs: SignInfo[] = [];

  private readonly ctx: ViewContext;
  private readonly room: RoomDef;
  private readonly objs: Obj[] = [];
  private readonly mechViews: MechView[] = [];
  private readonly torches: TorchView[] = [];
  private readonly labels: LabelView[] = [];
  private readonly zones: ZoneView[] = [];
  private readonly exitSprites: Phaser.GameObjects.Image[] = [];
  private readonly exitGlow: Phaser.GameObjects.Rectangle;
  private readonly exitCenter: Vec2;
  private lastExitOpen: boolean | null = null;
  private readonly sealed: boolean;

  constructor(ctx: ViewContext, level: LevelDef, room: RoomDef) {
    this.ctx = ctx;
    this.room = room;
    const grid = new RoomGrid(room.layout);
    this.widthPx = grid.pixelWidth;
    this.heightPx = grid.pixelHeight;
    this.backgroundColor = THEME_PALETTES[room.theme].void;
    this.sealed = room.exit.sealed === true;

    this.bakeFloor(grid);
    this.buildDecor(room.decor ?? []);
    this.buildSigns(room.signs ?? []);

    // sortie
    const er = room.exit.rect;
    for (let ty = er.y; ty < er.y + er.h; ty++) {
      for (let tx = er.x; tx < er.x + er.w; tx++) {
        const s = this.add(ctx.scene.add.image((tx + 0.5) * TILE, (ty + 0.5) * TILE, ATLAS_KEY, exitFrame(false, this.sealed)));
        s.setDepth(DEPTH.decal + 0.1);
        this.exitSprites.push(s);
      }
    }
    this.exitCenter = { x: (er.x + er.w / 2) * TILE, y: (er.y + er.h / 2) * TILE };
    this.exitGlow = this.add(ctx.scene.add.rectangle(this.exitCenter.x, this.exitCenter.y, er.w * TILE, er.h * TILE, 0xfff6c8, 0));
    this.exitGlow.setStrokeStyle(1, 0xfff6c8, 0.9).setDepth(DEPTH.decal + 0.2).setVisible(false);

    // zones d'objectifs
    this.buildZones(level, room);

    // mécanismes
    for (const def of room.mechanisms) {
      const v = createMechView(ctx, room, def);
      if (v) this.mechViews.push(v);
      else this.mechViews.push(NULL_VIEW(def.id));
    }
    this.buildLabels(room);
  }

  // ───────── construction ─────────

  private add<T extends Obj>(o: T): T {
    this.ctx.rig.registerWorld(o);
    this.objs.push(o);
    return o;
  }

  /** Cuit toutes les tuiles dans un seul RenderTexture (une seule image à dessiner par frame). */
  private bakeFloor(grid: RoomGrid): void {
    const { scene } = this.ctx;
    const rt = scene.add.renderTexture(0, 0, Math.max(1, this.widthPx), Math.max(1, this.heightPx));
    rt.setOrigin(0, 0).setDepth(DEPTH.floor);
    this.add(rt);
    rt.beginDraw();
    for (let ty = 0; ty < grid.height; ty++) {
      for (let tx = 0; tx < grid.width; tx++) {
        const g = grid.glyphAt(tx, ty);
        if (g === ' ') continue;
        rt.batchDrawFrame(ATLAS_KEY, tileFrame(this.room.theme, g, tx, ty, grid.glyphAt(tx, ty + 1)), tx * TILE, ty * TILE);
      }
    }
    rt.endDraw();
  }

  private buildDecor(decor: readonly DecorDef[]): void {
    const { scene } = this.ctx;
    decor.forEach((d, i) => {
      const cx = (d.tile[0] + 0.5) * TILE;
      const cy = (d.tile[1] + 0.5) * TILE;
      if (d.type === 'torch') {
        const glow = this.add(scene.add.image(cx, cy - 2, FX_GLOW_KEY));
        glow.setBlendMode(1).setTint(0xff9a3c).setScale(1.5).setAlpha(0.22).setDepth(DEPTH.decal - 1);
        const sprite = this.add(scene.add.image(cx, cy, ATLAS_KEY, torchFrame(0)));
        sprite.setDepth(ySortDepth(cy + TILE / 2));
        this.torches.push({ sprite, glow, phase: i * 1.7, base: 0.22, animated: true });
        return;
      }
      const sprite = this.add(scene.add.image(cx, cy, ATLAS_KEY, `decor_${d.type}`));
      sprite.setDepth(ySortDepth(cy + TILE / 2 - 2));
      if (d.type === 'crystal') {
        const glow = this.add(scene.add.image(cx, cy, FX_GLOW_KEY));
        glow.setBlendMode(1).setTint(0x46e6ff).setScale(1.1).setAlpha(0.2).setDepth(DEPTH.decal - 1);
        this.torches.push({ sprite, glow, phase: i * 2.3, base: 0.2, animated: false });
      }
    });
  }

  private buildSigns(signs: readonly SignDef[]): void {
    for (const s of signs) {
      const cx = (s.tile[0] + 0.5) * TILE;
      const cy = (s.tile[1] + 0.5) * TILE;
      const sprite = this.add(this.ctx.scene.add.image(cx, cy, ATLAS_KEY, 'sign'));
      sprite.setDepth(ySortDepth(cy + TILE / 2 - 2));
      this.signs.push({ id: s.id, textKey: s.textKey, x: cx, y: cy });
    }
  }

  private buildZones(level: LevelDef, room: RoomDef): void {
    const { scene, playerCount } = this.ctx;
    for (const def of level.objectives) {
      if (def.kind !== 'zone' || def.roomId !== room.id) continue;
      const zone = room.zones?.find((z) => z.id === def.zoneId);
      if (!zone) continue;
      const color = PLAYER_COLORS[resolveSlot(def.slot, playerCount)];
      const x = zone.rect.x * TILE;
      const y = zone.rect.y * TILE;
      const w = zone.rect.w * TILE;
      const h = zone.rect.h * TILE;
      const fill = this.add(scene.add.rectangle(x + w / 2, y + h / 2, w, h, color, 0.1));
      fill.setStrokeStyle(1, color, 0.8).setDepth(DEPTH.decal);
      const progress = this.add(scene.add.rectangle(x, y + h, w, 0, color, 0.28));
      progress.setOrigin(0, 1).setDepth(DEPTH.decal + 0.05);
      const label = this.add(makeWorldText(scene, this.ctx.zoom, t(def.labelKey), { size: 6, color, wrap: Math.max(48, w - 4), originX: 0.5, originY: 0 }));
      label.setPosition(x + w / 2, y + 2).setDepth(DEPTH_LABELS - 1);
      this.zones.push({ def, fill, progress, label, x, y, w, h, color });
    }
  }

  private mechCenterOf(def: MechanismDef): MechView | null {
    return this.mechViews.find((v) => v.id === def.id) ?? null;
  }

  private buildLabels(room: RoomDef): void {
    const { playerCount } = this.ctx;
    for (const def of room.mechanisms) {
      if (!def.labelKey) continue;
      const view = this.mechCenterOf(def);
      if (!view) continue;
      let color = 0xffffff;
      if (def.type === 'plate' && def.colorSlot !== undefined) color = slotColor(def.colorSlot, playerCount);
      else if (def.type === 'lever' && def.ownerSlot !== undefined) color = slotColor(def.ownerSlot, playerCount);
      else if (def.type === 'key') color = slotColor(def.ownerSlot, playerCount);
      else if (def.type === 'brazier') color = def.ownerSlot !== undefined ? slotColor(def.ownerSlot, playerCount) : 0xffc86a;
      else if (def.type === 'door' && def.keyId !== undefined) {
        const k = room.mechanisms.find((m): m is KeyDef => m.type === 'key' && m.id === def.keyId);
        if (k) color = slotColor(k.ownerSlot, playerCount);
      }
      else if (def.type === 'statuePair') color = 0x7af0ff;
      else if (def.type === 'hourglass') color = 0xffc24a;
      else if (def.type === 'lightBridge') color = 0xffe27a;
      if (def.type === 'statuePair') {
        // une étiquette près de chaque statue (le centre du mécanisme est entre les deux, hors de portée)
        for (const st of def.statues) this.addLabel(def.labelKey, color, null, { x: (st.tile[0] + 0.5) * TILE, y: (st.tile[1] + 0.5) * TILE }, 20, LABEL_RADIUS);
        continue;
      }
      const big = def.type === 'block' || def.type === 'socket' || def.type === 'door' || def.type === 'lightBridge';
      this.addLabel(def.labelKey, color, view, { x: 0, y: 0 }, big ? 26 : 16, big ? LABEL_RADIUS + 16 : LABEL_RADIUS);
    }
    // étiquette de sortie
    this.addLabel(this.sealed ? 'mech.sealedExit' : 'mech.exit', 0xfff6c8, null, this.exitCenter, room.exit.rect.h * TILE / 2 + 8, LABEL_RADIUS + room.exit.rect.w * TILE / 2);
    // noms des symboles de runes sur les piédestaux
    for (const def of room.mechanisms) {
      if (def.type !== 'runePuzzle') continue;
      for (const ped of def.pedestals) {
        const c = { x: (ped.tile[0] + 0.5) * TILE, y: (ped.tile[1] + 0.5) * TILE };
        this.addLabel(`mech.symbol.${ped.symbol}`, 0xffffff, null, c, 22, 30);
      }
    }
  }

  private addLabel(key: string, color: number, view: MechView | null, fixed: Vec2, offsetY: number, radius: number): void {
    const text = this.add(makeWorldText(this.ctx.scene, this.ctx.zoom, t(key), { size: 6, color, wrap: 72 }));
    text.setDepth(DEPTH_LABELS).setAlpha(0);
    this.labels.push({ text, key, view, fixed: { x: fixed.x, y: fixed.y }, offsetY, radius, shownAlpha: 0 });
  }

  // ───────── lecture ─────────

  /** Centre (px monde) du mécanisme `id`, ou null. */
  centerOfMechanism(id: string): Vec2 | null {
    const v = this.mechViews.find((m) => m.id === id);
    return v ? v.center : null;
  }

  /** Centre de la partie `index` d'un mécanisme composite (statue, tuile de herse ou de pont), à défaut son centre ; null si inconnu. */
  mechanismPartCenter(id: string, index: number): Vec2 | null {
    const v = this.mechViews.find((m) => m.id === id);
    if (!v) return null;
    return v.partCenter?.(index) ?? v.center;
  }

  /** Centre du piédestal `index` de l'énigme `id` (pour les FX), ou null. */
  pedestalCenter(id: string, index: number): Vec2 | null {
    const v = this.mechViews.find((m) => m.id === id);
    return v && isRuneView(v) ? v.pedestalCenter(index) : null;
  }

  /** Centre de la zone de sortie (px monde). */
  get exitCenterPx(): Vec2 {
    return this.exitCenter;
  }

  /** Re-traduit les textes (changement de langue). */
  retranslate(): void {
    for (const l of this.labels) l.text.setText(t(l.key));
    for (const z of this.zones) z.label.setText(t(z.def.labelKey));
  }

  // ───────── mise à jour ─────────

  /**
   * Met la salle à jour depuis l'état. `exitOpen` : toutes les exigences de sortie sont satisfaites (calculé par l'appelant).
   */
  update(state: GameState, timeMs: number, exitOpen: boolean): void {
    const states = state.room.mechanisms;
    for (let i = 0; i < this.mechViews.length; i++) {
      const view = this.mechViews[i];
      let st = states[i];
      if (!st || st.id !== view.id) st = states.find((m) => m.id === view.id) as typeof st;
      if (st) view.update(st, timeMs);
    }

    // torches / cristaux : animation et vacillement de la lueur
    for (const tv of this.torches) {
      if (tv.animated) tv.sprite.setFrame(torchFrame(timeMs + tv.phase * 100));
      tv.glow.setAlpha(tv.base + 0.06 * Math.sin(timeMs / 130 + tv.phase) + 0.03 * Math.sin(timeMs / 47 + tv.phase * 3));
    }

    // sortie
    if (exitOpen !== this.lastExitOpen) {
      this.lastExitOpen = exitOpen;
      const f = exitFrame(exitOpen, this.sealed);
      for (const s of this.exitSprites) s.setFrame(f);
    }
    this.exitGlow.setVisible(exitOpen);
    if (exitOpen) this.exitGlow.setFillStyle(0xfff6c8, 0.1 + 0.08 * (0.5 + 0.5 * Math.sin(timeMs / 260)));

    this.updateZones(state, timeMs);
    this.updateLabels(state);
  }

  private updateZones(state: GameState, timeMs: number): void {
    for (const z of this.zones) {
      const st: ObjectiveState | undefined = state.objectives.find((o) => o.id === z.def.id);
      const done = st?.done === true;
      const prog = st ? st.progress : 0;
      const owner = st ? state.players[st.ownerId] : undefined;
      const inside =
        !!owner &&
        owner.status === 'alive' &&
        owner.pos.x >= z.x &&
        owner.pos.x < z.x + z.w &&
        owner.pos.y >= z.y &&
        owner.pos.y < z.y + z.h;
      z.fill.setFillStyle(z.color, done ? 0.05 : inside ? 0.2 : 0.08 + 0.04 * Math.sin(timeMs / 400));
      z.fill.setStrokeStyle(1, z.color, done ? 0.25 : 0.55 + 0.35 * (inside ? 1 : 0.5 + 0.5 * Math.sin(timeMs / 300)));
      z.progress.setSize(z.w, Math.max(0, Math.min(1, prog)) * z.h);
      z.progress.setVisible(prog > 0 && !done);
      z.label.setVisible(!done);
    }
  }

  private updateLabels(state: GameState): void {
    const players = state.players;
    for (const l of this.labels) {
      const ax = l.view ? l.view.center.x : l.fixed.x;
      const ay = (l.view ? l.view.center.y : l.fixed.y) - l.offsetY;
      let best = Infinity;
      for (let i = 0; i < players.length; i++) {
        const p = players[i];
        if (p.status !== 'alive') continue;
        const dx = p.pos.x - ax;
        const dy = p.pos.y - (ay + l.offsetY);
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < best) best = d;
      }
      const target = best <= l.radius ? 1 : best <= l.radius + 24 ? 1 - (best - l.radius) / 24 : 0;
      l.shownAlpha += (target - l.shownAlpha) * 0.25;
      if (l.shownAlpha < 0.02) {
        l.text.setVisible(false);
      } else {
        l.text.setVisible(true).setAlpha(l.shownAlpha).setPosition(ax, ay);
      }
    }
  }

  /** Détruit tous les objets de la salle. */
  destroy(): void {
    for (const v of this.mechViews) v.destroy();
    this.mechViews.length = 0;
    for (const o of this.objs) o.destroy();
    this.objs.length = 0;
    this.torches.length = 0;
    this.labels.length = 0;
    this.zones.length = 0;
    this.exitSprites.length = 0;
    this.signs.length = 0;
  }
}

/** Vue vide pour un type de mécanisme inconnu (garde l'alignement des indices). */
function NULL_VIEW(id: string): MechView {
  return { id, center: { x: 0, y: 0 }, update() {}, destroy() {} };
}

/** Joueur le plus proche d'un point parmi les vivants (utilitaire de tests/HUD) — retourne l'id ou null. */
export function nearestAlivePlayer(state: GameState, x: number, y: number): PlayerId | null {
  let best = Infinity;
  let id: PlayerId | null = null;
  for (const p of state.players) {
    if (p.status !== 'alive') continue;
    const d = Math.hypot(p.pos.x - x, p.pos.y - y);
    if (d < best) {
      best = d;
      id = p.id;
    }
  }
  return id;
}
