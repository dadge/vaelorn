/**
 * Vues des mécanismes coopératifs : plaques, leviers, clés, portes, blocs, réceptacles, énigme de runes.
 * Chaque vue LIT son MechanismState (jamais d'écriture) et affiche la couleur du joueur résolu (resolveSlot) quand
 * le mécanisme est lié à un slot (« qui doit faire quoi »). Vision partagée : les glyphes de la séquence de runes
 * ne sont enregistrés que dans la caméra du joueur voyant ; les piédestaux sont visibles pour tous.
 */
import type Phaser from 'phaser';
import { BLOCK_SIZE_TILES, PLAYER_COLORS, TILE } from '../core/constants';
import { effectiveLeverWindowMs, requiredPushers } from '../core/mechanisms';
import { resolveSlot } from '../core/slots';
import type {
  BlockDef,
  BrazierDef,
  BrazierState,
  BlockState,
  DoorDef,
  DoorState,
  KeyDef,
  KeyState,
  LeverDef,
  LeverState,
  MechanismDef,
  MechanismState,
  PlateDef,
  PlateState,
  PlayerId,
  RoomDef,
  RunePuzzleDef,
  RuneState,
  SocketDef,
  SocketState,
  Vec2,
} from '../core/types';
import { ATLAS_KEY } from '../render/art';
import { brazierFrame, doorFrame, emberFrame, keyFrame, leverFrame, plateFrame, runeFrame, socketFrame } from '../render/art/animations';
import { FX_GLOW_KEY, makeWorldText } from '../render/fx';
import { DEPTH, ySortDepth, type ViewContext } from './common';

type Img = Phaser.GameObjects.Image;

/** Une vue de mécanisme : `update` à chaque frame avec l'état courant. */
export interface MechView {
  readonly id: string;
  /** Centre (px monde) utilisé pour les FX et les étiquettes. */
  readonly center: Vec2;
  update(st: MechanismState, timeMs: number): void;
  destroy(): void;
}

/** Couleur du joueur résolu pour un slot (coop adaptative : slot % nbJoueurs). */
export function slotColor(slot: number, playerCount: number): number {
  return PLAYER_COLORS[resolveSlot(slot, playerCount)];
}

function tileCenter(tile: readonly [number, number]): Vec2 {
  return { x: (tile[0] + 0.5) * TILE, y: (tile[1] + 0.5) * TILE };
}

function bob(timeMs: number, phase = 0, amp = 1.2): number {
  return Math.sin(timeMs / 260 + phase) * amp;
}

/** Aide : crée une image du monde, enregistrée et suivie dans `bag` pour la destruction. */
function mkImage(ctx: ViewContext, bag: Phaser.GameObjects.GameObject[], x: number, y: number, frame: string | undefined, key: string = ATLAS_KEY): Img {
  const img = ctx.scene.add.image(x, y, key, frame);
  ctx.rig.registerWorld(img);
  bag.push(img);
  return img;
}

function destroyAll(bag: Phaser.GameObjects.GameObject[]): void {
  for (const o of bag) o.destroy();
  bag.length = 0;
}

// ───────────────────────────── Plaque ─────────────────────────────

class PlateView implements MechView {
  readonly id: string;
  readonly center: Vec2;
  private readonly bag: Phaser.GameObjects.GameObject[] = [];
  private readonly sprite: Img;
  private readonly outline: Phaser.GameObjects.Rectangle | null;
  private lastFrame = '';

  constructor(ctx: ViewContext, def: PlateDef) {
    this.id = def.id;
    this.center = tileCenter(def.tile);
    this.sprite = mkImage(ctx, this.bag, this.center.x, this.center.y, plateFrame(false));
    this.sprite.setDepth(DEPTH.flat);
    if (def.colorSlot !== undefined && (def.minPlayers ?? 1) <= ctx.playerCount) {
      const c = slotColor(def.colorSlot, ctx.playerCount);
      this.outline = ctx.scene.add.rectangle(this.center.x, this.center.y, TILE - 1, TILE - 1, c, 0.18);
      this.outline.setStrokeStyle(1, c, 1);
      this.outline.setDepth(DEPTH.flat + 0.1);
      ctx.rig.registerWorld(this.outline);
      this.bag.push(this.outline);
    } else {
      this.outline = null;
    }
  }

  update(st: MechanismState, timeMs: number): void {
    if (st.type !== 'plate') return;
    const s: PlateState = st;
    const pressed = s.active || s.waived;
    const f = plateFrame(pressed);
    if (f !== this.lastFrame) {
      this.sprite.setFrame(f);
      this.lastFrame = f;
    }
    this.sprite.setAlpha(s.waived ? 0.5 : 1);
    if (this.outline) {
      this.outline.setVisible(!s.waived);
      this.outline.setFillStyle(this.outline.fillColor, pressed ? 0.5 : 0.14 + 0.1 * (0.5 + 0.5 * Math.sin(timeMs / 300)));
    }
  }

  destroy(): void {
    destroyAll(this.bag);
  }
}

// ───────────────────────────── Levier ─────────────────────────────

class LeverView implements MechView {
  readonly id: string;
  readonly center: Vec2;
  private readonly bag: Phaser.GameObjects.GameObject[] = [];
  private readonly sprite: Img;
  private readonly marker: Img | null;
  private readonly ring: Phaser.GameObjects.Ellipse | null;
  private readonly barBg: Phaser.GameObjects.Rectangle;
  private readonly barFill: Phaser.GameObjects.Rectangle;
  private readonly windowMs: number;
  private readonly color: number;
  private lastFrame = '';

  constructor(ctx: ViewContext, def: LeverDef, room: RoomDef) {
    this.id = def.id;
    this.center = tileCenter(def.tile);
    this.windowMs = effectiveLeverWindowMs(room, ctx.playerCount, def);
    this.sprite = mkImage(ctx, this.bag, this.center.x, this.center.y, leverFrame(false));
    this.sprite.setDepth(ySortDepth(this.center.y + 6));
    const slotted = def.ownerSlot !== undefined && (def.minPlayers ?? 1) <= ctx.playerCount;
    this.color = slotted ? slotColor(def.ownerSlot as number, ctx.playerCount) : 0xffe27a;
    if (slotted) {
      this.marker = mkImage(ctx, this.bag, this.center.x, this.center.y - 13, 'fx_marker');
      this.marker.setTint(this.color);
      this.ring = ctx.scene.add.ellipse(this.center.x, this.center.y + 5, 16, 8, this.color, 0.25);
      this.ring.setStrokeStyle(1, this.color, 1);
      this.ring.setDepth(DEPTH.flat + 0.1);
      ctx.rig.registerWorld(this.ring);
      this.bag.push(this.ring);
    } else {
      this.marker = null;
      this.ring = null;
    }
    this.barBg = ctx.scene.add.rectangle(this.center.x, this.center.y - 11, 18, 4, 0x14121f, 0.9);
    this.barFill = ctx.scene.add.rectangle(this.center.x - 8, this.center.y - 11, 16, 2, this.color, 1);
    this.barFill.setOrigin(0, 0.5);
    for (const o of [this.barBg, this.barFill]) {
      o.setVisible(false);
      o.setDepth(ySortDepth(this.center.y) + 200);
      ctx.rig.registerWorld(o);
      this.bag.push(o);
    }
  }

  update(st: MechanismState, timeMs: number): void {
    if (st.type !== 'lever') return;
    const s: LeverState = st;
    const on = s.active || s.waived;
    const f = leverFrame(on);
    if (f !== this.lastFrame) {
      this.sprite.setFrame(f);
      this.lastFrame = f;
    }
    this.sprite.setAlpha(s.waived ? 0.5 : 1);
    if (this.marker) {
      this.marker.setVisible(!s.waived && !on);
      this.marker.setY(this.center.y - 13 + bob(timeMs, 0, 1.5));
    }
    this.ring?.setVisible(!s.waived);
    const showBar = !s.waived && s.active && this.windowMs > 0 && s.remainingMs > 0;
    this.barBg.setVisible(showBar);
    this.barFill.setVisible(showBar);
    if (showBar) {
      const r = Math.max(0, Math.min(1, s.remainingMs / this.windowMs));
      this.barFill.setSize(Math.max(1, 16 * r), 2);
    }
  }

  destroy(): void {
    destroyAll(this.bag);
  }
}

// ───────────────────────────── Clé ─────────────────────────────

class KeyView implements MechView {
  readonly id: string;
  readonly center: Vec2;
  private readonly bag: Phaser.GameObjects.GameObject[] = [];
  private readonly sprite: Img;
  private readonly glow: Img;

  constructor(ctx: ViewContext, def: KeyDef) {
    this.id = def.id;
    this.center = tileCenter(def.tile);
    const c = slotColor(def.ownerSlot, ctx.playerCount);
    this.glow = mkImage(ctx, this.bag, this.center.x, this.center.y, undefined, FX_GLOW_KEY);
    this.glow.setBlendMode(1).setTint(c).setScale(0.55).setDepth(DEPTH.decal);
    this.sprite = mkImage(ctx, this.bag, this.center.x, this.center.y, keyFrame(def.ownerSlot));
    this.sprite.setDepth(ySortDepth(this.center.y + 6));
  }

  update(st: MechanismState, timeMs: number): void {
    if (st.type !== 'key') return;
    const s: KeyState = st;
    const visible = !s.waived && !s.collected && !s.active;
    this.sprite.setVisible(visible);
    this.glow.setVisible(visible);
    if (visible) {
      this.sprite.setY(this.center.y - 2 + bob(timeMs, 1, 1.6));
      this.glow.setAlpha(0.5 + 0.2 * Math.sin(timeMs / 240));
    }
  }

  destroy(): void {
    destroyAll(this.bag);
  }
}

// ───────────────────────────── Porte ─────────────────────────────

class DoorView implements MechView {
  readonly id: string;
  readonly center: Vec2;
  private readonly bag: Phaser.GameObjects.GameObject[] = [];
  private readonly tiles: { sprite: Img; footY: number }[] = [];
  private readonly lock: Img | null;
  private lastOpen: boolean | null = null;

  constructor(ctx: ViewContext, def: DoorDef, keyOwnerSlot: number | undefined) {
    this.id = def.id;
    let sx = 0;
    let sy = 0;
    for (const t of def.tiles) {
      const c = tileCenter(t);
      sx += c.x;
      sy += c.y;
      const sprite = mkImage(ctx, this.bag, c.x, c.y, doorFrame(false));
      this.tiles.push({ sprite, footY: c.y + TILE / 2 });
    }
    const n = Math.max(1, def.tiles.length);
    this.center = { x: sx / n, y: sy / n };
    if (keyOwnerSlot !== undefined) {
      this.lock = mkImage(ctx, this.bag, this.center.x, this.center.y - 11, keyFrame(keyOwnerSlot));
      this.lock.setDepth(ySortDepth(this.center.y) + 250);
    } else {
      this.lock = null;
    }
  }

  update(st: MechanismState, timeMs: number): void {
    if (st.type !== 'door') return;
    const s: DoorState = st;
    const open = s.open || s.waived;
    if (open !== this.lastOpen) {
      this.lastOpen = open;
      const f = doorFrame(open);
      for (const t of this.tiles) {
        t.sprite.setFrame(f);
        t.sprite.setDepth(open ? DEPTH.flat : ySortDepth(t.footY - 1));
      }
    }
    if (this.lock) {
      this.lock.setVisible(!open);
      if (!open) {
        this.lock.setY(this.center.y - 11 + bob(timeMs, 2, 1.4));
      }
    }
  }

  destroy(): void {
    destroyAll(this.bag);
  }
}

// ───────────────────────────── Bloc ─────────────────────────────

class BlockView implements MechView {
  readonly id: string;
  readonly center: Vec2;
  private readonly bag: Phaser.GameObjects.GameObject[] = [];
  private readonly sprite: Img;
  private readonly badge: Phaser.GameObjects.Text | null;
  private readonly size = BLOCK_SIZE_TILES * TILE;

  constructor(ctx: ViewContext, def: BlockDef) {
    this.id = def.id;
    this.center = { x: def.tile[0] * TILE + this.size / 2, y: def.tile[1] * TILE + this.size / 2 };
    this.sprite = mkImage(ctx, this.bag, def.tile[0] * TILE, def.tile[1] * TILE, 'block');
    this.sprite.setOrigin(0, 0);
    const need = requiredPushers(def, ctx.playerCount);
    if (need > 1) {
      this.badge = makeWorldText(ctx.scene, ctx.zoom, String(need), { size: 8, color: 0xffe27a, originY: 0.5 });
      ctx.rig.registerWorld(this.badge);
      this.bag.push(this.badge);
    } else {
      this.badge = null;
    }
  }

  update(st: MechanismState): void {
    if (st.type !== 'block') return;
    const s: BlockState = st;
    this.sprite.setPosition(s.pos.x, s.pos.y);
    this.sprite.setDepth(ySortDepth(s.pos.y + this.size - 3));
    this.center.x = s.pos.x + this.size / 2;
    this.center.y = s.pos.y + this.size / 2;
    if (this.badge) {
      this.badge.setPosition(this.center.x, s.pos.y + 6);
      this.badge.setDepth(ySortDepth(s.pos.y + this.size) + 2);
      this.badge.setVisible(!s.waived);
    }
  }

  destroy(): void {
    destroyAll(this.bag);
  }
}

// ───────────────────────────── Réceptacle ─────────────────────────────

class SocketView implements MechView {
  readonly id: string;
  readonly center: Vec2;
  private readonly bag: Phaser.GameObjects.GameObject[] = [];
  private readonly sprite: Img;
  private lastFrame = '';

  constructor(ctx: ViewContext, def: SocketDef) {
    this.id = def.id;
    const size = BLOCK_SIZE_TILES * TILE;
    this.center = { x: def.tile[0] * TILE + size / 2, y: def.tile[1] * TILE + size / 2 };
    this.sprite = mkImage(ctx, this.bag, def.tile[0] * TILE, def.tile[1] * TILE, socketFrame(false));
    this.sprite.setOrigin(0, 0).setDepth(DEPTH.flat);
  }

  update(st: MechanismState): void {
    if (st.type !== 'socket') return;
    const s: SocketState = st;
    const f = socketFrame(s.active || s.waived);
    if (f !== this.lastFrame) {
      this.sprite.setFrame(f);
      this.lastFrame = f;
    }
  }

  destroy(): void {
    destroyAll(this.bag);
  }
}

// ───────────────────────────── Énigme de runes ─────────────────────────────

const RUNE_SPACING = 18;

class RuneView implements MechView {
  readonly id: string;
  readonly center: Vec2;
  private readonly bag: Phaser.GameObjects.GameObject[] = [];
  private readonly frames: Img[] = [];
  private readonly glyphs: Img[] = [];
  private readonly checks: Img[] = [];
  private readonly pedestalGlyphs: Img[] = [];
  private readonly pedestalBase: Vec2[] = [];
  private readonly def: RunePuzzleDef;
  private readonly seesSequence: PlayerId;

  constructor(ctx: ViewContext, def: RunePuzzleDef) {
    this.id = def.id;
    this.def = def;
    this.center = tileCenter(def.displayTile);
    this.seesSequence = resolveSlot(def.visibleToSlot, ctx.playerCount);
    const n = def.sequence.length;
    for (let i = 0; i < n; i++) {
      const x = this.center.x + (i - (n - 1) / 2) * RUNE_SPACING;
      // cadres visibles par TOUS (on voit qu'il y a une séquence, pas laquelle)
      const fr = mkImage(ctx, this.bag, x, this.center.y, 'rune_frame');
      fr.setDepth(DEPTH.decal + 0.2);
      this.frames.push(fr);
      // glyphes et coches : visibles UNIQUEMENT par le joueur voyant
      const gl = ctx.scene.add.image(x, this.center.y, ATLAS_KEY, runeFrame(def.sequence[i]));
      gl.setDepth(DEPTH.decal + 0.4);
      ctx.rig.registerVision(gl, this.seesSequence);
      this.bag.push(gl);
      this.glyphs.push(gl);
      const ck = ctx.scene.add.image(x + 4, this.center.y + 4, ATLAS_KEY, 'ui_check');
      ck.setDepth(DEPTH.decal + 0.5).setVisible(false);
      ctx.rig.registerVision(ck, this.seesSequence);
      this.bag.push(ck);
      this.checks.push(ck);
    }
    // piédestaux visibles par tous
    for (const ped of def.pedestals) {
      const c = tileCenter(ped.tile);
      const base = mkImage(ctx, this.bag, c.x, c.y + 2, 'pedestal');
      base.setDepth(ySortDepth(c.y + 8));
      const g = mkImage(ctx, this.bag, c.x, c.y - 8, runeFrame(ped.symbol));
      g.setDepth(ySortDepth(c.y + 8) + 1);
      this.pedestalGlyphs.push(g);
      this.pedestalBase.push({ x: c.x, y: c.y - 8 });
    }
  }

  update(st: MechanismState, timeMs: number): void {
    if (st.type !== 'runePuzzle') return;
    const s: RuneState = st;
    const solved = s.active || s.waived;
    const error = s.errorFlashMs > 0;
    const frameTint = solved ? 0x7dffb0 : error ? 0xff5a5a : 0xffffff;
    for (let i = 0; i < this.frames.length; i++) {
      this.frames[i].setTint(frameTint);
      const entered = i < s.progress || solved;
      this.glyphs[i].setAlpha(entered ? 0.35 : 1);
      this.checks[i].setVisible(entered);
    }
    for (let i = 0; i < this.pedestalGlyphs.length; i++) {
      const g = this.pedestalGlyphs[i];
      const base = this.pedestalBase[i];
      const pressed = s.lastPedestal === i && !solved;
      g.setY(base.y + bob(timeMs, i, 1.1) - (pressed ? 2 : 0));
      g.setAlpha(error ? 0.6 + 0.4 * Math.sin(timeMs / 50) : 1);
      if (solved) g.setTint(0xb8ffd0);
      else if (pressed) g.setTint(0xfff0a0);
      else g.clearTint();
    }
  }

  /** Centre du piédestal d'indice `i` (FX ciblés). */
  pedestalCenter(i: number): Vec2 | null {
    const p = this.def.pedestals[i];
    return p ? tileCenter(p.tile) : null;
  }

  destroy(): void {
    destroyAll(this.bag);
  }
}

// ───────────────────────────── Brasero ─────────────────────────────

/** Nombre de braises qui montent autour d'un brasero allumé. */
const EMBER_COUNT = 4;
/** Période (ms) d'un cycle de braise. */
const EMBER_PERIOD_MS = 1500;

/**
 * Position et opacité d'une braise à l'instant `timeMs` (pure, déterministe : aucune allocation d'objet Phaser par frame).
 * `i` = indice de la braise (déphasage). `dx`/`dy` : décalage depuis le centre du brasero (px monde).
 */
export function emberState(i: number, timeMs: number): { dx: number; dy: number; alpha: number; phase: number } {
  const phase = (((timeMs / EMBER_PERIOD_MS + i / EMBER_COUNT) % 1) + 1) % 1;
  const dx = Math.sin(phase * Math.PI * 2 + i * 2.1) * (3 + (i % 2) * 2) + (i - 1.5) * 1.6;
  const dy = -6 - phase * 20;
  const alpha = Math.sin(phase * Math.PI) * 0.95;
  return { dx, dy, alpha, phase };
}

/**
 * Brasero : sprite éteint / allumé (animé), anneau de la couleur du slot propriétaire, lueur chaude et braises quand il
 * est allumé. Un flash d'allumage se joue à la transition éteint → allumé. LIT BrazierState (jamais d'écriture).
 */
class BrazierView implements MechView {
  readonly id: string;
  readonly center: Vec2;
  private readonly bag: Phaser.GameObjects.GameObject[] = [];
  private readonly sprite: Img;
  private readonly glow: Img;
  private readonly ring: Phaser.GameObjects.Ellipse | null;
  private readonly embers: Img[] = [];
  private lastFrame = '';
  private lastLit: boolean | null = null;
  private flareUntilMs = 0;

  constructor(ctx: ViewContext, def: BrazierDef) {
    this.id = def.id;
    this.center = tileCenter(def.tile);
    this.glow = mkImage(ctx, this.bag, this.center.x, this.center.y - 3, undefined, FX_GLOW_KEY);
    this.glow.setBlendMode(1).setTint(0xff9a3c).setScale(2).setAlpha(0).setDepth(DEPTH.decal - 1).setVisible(false);
    const slotted = def.ownerSlot !== undefined && (def.minPlayers ?? 1) <= ctx.playerCount;
    if (slotted) {
      const c = slotColor(def.ownerSlot as number, ctx.playerCount);
      this.ring = ctx.scene.add.ellipse(this.center.x, this.center.y + 6, 20, 9, c, 0.22);
      this.ring.setStrokeStyle(1, c, 1);
      this.ring.setDepth(DEPTH.flat + 0.1);
      ctx.rig.registerWorld(this.ring);
      this.bag.push(this.ring);
    } else {
      this.ring = null;
    }
    this.sprite = mkImage(ctx, this.bag, this.center.x, this.center.y, brazierFrame(false, 0));
    this.sprite.setDepth(ySortDepth(this.center.y + 6));
    for (let i = 0; i < EMBER_COUNT; i++) {
      const e = mkImage(ctx, this.bag, this.center.x, this.center.y, emberFrame(i / EMBER_COUNT));
      e.setBlendMode(1).setDepth(ySortDepth(this.center.y + 6) + 3).setVisible(false);
      this.embers.push(e);
    }
  }

  update(st: MechanismState, timeMs: number): void {
    if (st.type !== 'brazier') return;
    const s: BrazierState = st;
    const lit = s.active || s.waived;
    if (this.lastLit !== null && lit && !this.lastLit) this.flareUntilMs = timeMs + 450;
    this.lastLit = lit;
    const f = brazierFrame(lit, timeMs);
    if (f !== this.lastFrame) {
      this.sprite.setFrame(f);
      this.lastFrame = f;
    }
    this.ring?.setFillStyle(this.ring.fillColor, lit ? 0.12 : 0.18 + 0.12 * (0.5 + 0.5 * Math.sin(timeMs / 300)));
    this.glow.setVisible(lit);
    if (lit) {
      const flare = timeMs < this.flareUntilMs ? (this.flareUntilMs - timeMs) / 450 : 0;
      this.glow.setAlpha(0.3 + 0.07 * Math.sin(timeMs / 120) + 0.04 * Math.sin(timeMs / 41) + flare * 0.5);
      this.glow.setScale(2 + flare * 1.2);
    }
    for (let i = 0; i < this.embers.length; i++) {
      const e = this.embers[i];
      e.setVisible(lit);
      if (!lit) continue;
      const es = emberState(i, timeMs);
      e.setPosition(this.center.x + es.dx, this.center.y + es.dy);
      e.setAlpha(es.alpha);
      e.setFrame(emberFrame(es.phase));
    }
  }

  destroy(): void {
    destroyAll(this.bag);
    this.embers.length = 0;
  }
}

// ───────────────────────────── Fabrique ─────────────────────────────

/** Retrouve le slot propriétaire de la clé qui ouvre une porte (couleur du verrou), ou undefined. */
export function keyOwnerSlotForDoor(room: RoomDef, def: DoorDef): number | undefined {
  if (def.keyId === undefined) return undefined;
  const k = room.mechanisms.find((m): m is KeyDef => m.type === 'key' && m.id === def.keyId);
  return k?.ownerSlot;
}

/** Crée la vue du mécanisme `def` (ou null si le type est inconnu). */
export function createMechView(ctx: ViewContext, room: RoomDef, def: MechanismDef): MechView | null {
  switch (def.type) {
    case 'plate':
      return new PlateView(ctx, def);
    case 'lever':
      return new LeverView(ctx, def, room);
    case 'key':
      return new KeyView(ctx, def);
    case 'door':
      return new DoorView(ctx, def, keyOwnerSlotForDoor(room, def));
    case 'block':
      return new BlockView(ctx, def);
    case 'socket':
      return new SocketView(ctx, def);
    case 'runePuzzle':
      return new RuneView(ctx, def);
    case 'brazier':
      return new BrazierView(ctx, def);
    default:
      return null;
  }
}

/** Vue d'énigme de runes (accès aux centres de piédestaux depuis RoomView). */
export function isRuneView(v: MechView): v is MechView & { pedestalCenter(i: number): Vec2 | null } {
  return v instanceof RuneView;
}
