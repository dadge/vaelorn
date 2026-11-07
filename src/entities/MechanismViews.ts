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
  Dir,
  HourglassDef,
  HourglassState,
  LightBridgeDef,
  LightBridgeState,
  StatuePairDef,
  StatuePairState,
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
import { bridgeFrame, brazierFrame, doorFrame, emberFrame, gateFrame, hourglassFrame, keyFrame, leverFrame, plateFrame, runeFrame, socketFrame, statueFrame } from '../render/art/animations';
import { bridgeTileLit, gateClosedFlags, hourglassBlinkAlpha, hourglassStatus, sandJumped, statueTargetArrow, statuesSolved } from '../render/mechHud';
import { FX_GLOW_KEY, makeWorldText } from '../render/fx';
import { DEPTH, ySortDepth, type ViewContext } from './common';

type Img = Phaser.GameObjects.Image;

/** Une vue de mécanisme : `update` à chaque frame avec l'état courant. */
export interface MechView {
  readonly id: string;
  /** Centre (px monde) utilisé pour les FX et les étiquettes. */
  readonly center: Vec2;
  update(st: MechanismState, timeMs: number): void;
  /** Centre (px monde) d'une partie du mécanisme (statue, tuile de herse ou de pont) pour les FX ciblés ; absent = `center`. */
  partCenter?(index: number): Vec2 | null;
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

// ───────────────────────────── Statues jumelles (niveau 4) ─────────────────────────────

/** Couleur de repérage des socles : le socle `i` fait pivoter l'AUTRE statue, qui porte un anneau de la même couleur. */
const STAND_COLORS = [0x7af0ff, 0xffc24a] as const;
/** Durée (ms) du flash de rotation d'une statue. */
const STATUE_FLASH_MS = 380;

interface StatuePart {
  sprite: Img;
  glow: Img;
  arrow: Img;
  ring: Phaser.GameObjects.Ellipse;
  center: Vec2;
  lastFacing: Dir | null;
  flashUntilMs: number;
  lastFrame: string;
}

/**
 * Deux statues solides orientées selon `facings[i]` (yeux + pointe de flèche sur la poitrine), socles `standTile` marqués
 * (disque gravé + anneau coloré, rappelé sur la statue qu'il fait pivoter), flèche dorée flottante vers `targetDir` tant que la
 * statue ne la regarde pas, flash/rebond à chaque rotation, lueur verte une fois résolu. LIT StatuePairState.
 */
class StatuePairView implements MechView {
  readonly id: string;
  readonly center: Vec2;
  private readonly bag: Phaser.GameObjects.GameObject[] = [];
  private readonly parts: StatuePart[] = [];
  private readonly stands: { pad: Img; ring: Phaser.GameObjects.Ellipse }[] = [];
  private readonly def: StatuePairDef;

  constructor(ctx: ViewContext, def: StatuePairDef) {
    this.id = def.id;
    this.def = def;
    const c0 = tileCenter(def.statues[0].tile);
    const c1 = tileCenter(def.statues[1].tile);
    this.center = { x: (c0.x + c1.x) / 2, y: (c0.y + c1.y) / 2 };
    for (const i of [0, 1] as const) {
      const c = i === 0 ? c0 : c1;
      const foot = ySortDepth(c.y + 6);
      const ring = ctx.scene.add.ellipse(c.x, c.y + 6, 19, 9, STAND_COLORS[1 - i], 0.18);
      ring.setStrokeStyle(1, STAND_COLORS[1 - i], 0.9).setDepth(DEPTH.flat + 0.1);
      ctx.rig.registerWorld(ring);
      this.bag.push(ring);
      const glow = mkImage(ctx, this.bag, c.x, c.y - 2, undefined, FX_GLOW_KEY);
      glow.setBlendMode(1).setTint(0x7dffb0).setScale(1.5).setAlpha(0).setDepth(foot - 0.5).setVisible(false);
      const sprite = mkImage(ctx, this.bag, c.x, c.y, statueFrame(def.statues[i].facing, false));
      sprite.setDepth(foot);
      const arrow = mkImage(ctx, this.bag, c.x, c.y, 'fx_marker');
      arrow.setTint(0xffd24a).setDepth(foot + 2);
      this.parts.push({ sprite, glow, arrow, ring, center: c, lastFacing: null, flashUntilMs: 0, lastFrame: '' });
      // socle d'activation
      const sc = tileCenter(def.statues[i].standTile);
      const pad = mkImage(ctx, this.bag, sc.x, sc.y, 'statuepair_stand');
      pad.setDepth(DEPTH.flat);
      const padRing = ctx.scene.add.ellipse(sc.x, sc.y + 1, 18, 11, STAND_COLORS[i], 0.16);
      padRing.setStrokeStyle(1, STAND_COLORS[i], 0.95).setDepth(DEPTH.flat + 0.1);
      ctx.rig.registerWorld(padRing);
      this.bag.push(padRing);
      this.stands.push({ pad, ring: padRing });
    }
  }

  update(st: MechanismState, timeMs: number): void {
    if (st.type !== 'statuePair') return;
    const s: StatuePairState = st;
    const solved = statuesSolved(s);
    for (const i of [0, 1] as const) {
      const part = this.parts[i];
      const facing = s.facings[i];
      if (part.lastFacing !== null && part.lastFacing !== facing) part.flashUntilMs = timeMs + STATUE_FLASH_MS;
      part.lastFacing = facing;
      const f = statueFrame(facing, solved);
      if (f !== part.lastFrame) {
        part.sprite.setFrame(f);
        part.lastFrame = f;
      }
      const k = timeMs < part.flashUntilMs ? (part.flashUntilMs - timeMs) / STATUE_FLASH_MS : 0;
      if (k > 0.55) part.sprite.setTintFill(0xffffff);
      else part.sprite.clearTint();
      part.sprite.setScale(1 + 0.16 * k);
      part.glow.setVisible(solved && !s.waived);
      if (solved && !s.waived) part.glow.setAlpha(0.28 + 0.12 * Math.sin(timeMs / 260 + i));
      const a = statueTargetArrow(this.def, s, i, timeMs);
      part.arrow.setVisible(a.visible);
      if (a.visible) {
        part.arrow.setPosition(part.center.x + a.dx, part.center.y + a.dy).setRotation(a.rotation).setAlpha(a.alpha);
      }
      part.ring.setVisible(!s.waived);
      part.ring.setFillStyle(part.ring.fillColor, solved ? 0.06 : 0.14 + 0.08 * (0.5 + 0.5 * Math.sin(timeMs / 300 + i)));
      const stand = this.stands[i];
      stand.pad.setAlpha(s.waived ? 0.4 : 1);
      stand.ring.setVisible(!s.waived);
      stand.ring.setFillStyle(stand.ring.fillColor, solved ? 0.06 : 0.12 + 0.1 * (0.5 + 0.5 * Math.sin(timeMs / 300 + i * 1.7)));
    }
  }

  /** Centre de la statue d'indice `i` (FX de rotation). */
  partCenter(i: number): Vec2 | null {
    return this.parts[i]?.center ?? null;
  }

  destroy(): void {
    destroyAll(this.bag);
    this.parts.length = 0;
    this.stands.length = 0;
  }
}

// ───────────────────────────── Sablier partagé (niveau 5) ─────────────────────────────

/** Durée (ms) de la rotation du sablier retourné. */
const HOURGLASS_FLIP_MS = 520;
/** Durée (ms) pendant laquelle le levier utilisé reste affiché « actionné ». */
const HOURGLASS_LEVER_MS = 650;
/** Durée (ms) du flash d'une tuile de herse qui se ferme. */
const GATE_FLASH_MS = 320;

/**
 * Sablier affiché sur `displayTile` (frame selon le sable restant, clignotement rouge quand il est presque vide, rotation au
 * retournement), leviers marqués (anneau ambre + marqueur flottant, levier « actionné » un instant après le retournement),
 * herse dessinée tuile par tuile (barreaux pour les `closedCount` premières tuiles, relevée sinon), contour rouge clignotant sur
 * la prochaine tuile à se fermer. LIT HourglassState.
 */
class HourglassView implements MechView {
  readonly id: string;
  readonly center: Vec2;
  private readonly bag: Phaser.GameObjects.GameObject[] = [];
  private readonly sprite: Img;
  private readonly glow: Img;
  private readonly levers: { sprite: Img; marker: Img; ring: Phaser.GameObjects.Ellipse; center: Vec2; lastFrame: string }[] = [];
  private readonly gate: { sprite: Img; outline: Phaser.GameObjects.Rectangle; center: Vec2; closed: boolean | null; flashUntilMs: number }[] = [];
  private readonly def: HourglassDef;
  private readonly playerCount: number;
  private lastSand = -1;
  private flipStartMs = -1e9;
  private leverUntilMs = 0;
  private lastFrame = '';

  constructor(ctx: ViewContext, def: HourglassDef) {
    this.id = def.id;
    this.def = def;
    this.playerCount = ctx.playerCount;
    this.center = tileCenter(def.displayTile);
    this.glow = mkImage(ctx, this.bag, this.center.x, this.center.y, undefined, FX_GLOW_KEY);
    this.glow.setBlendMode(1).setTint(0xffc24a).setScale(1.4).setAlpha(0.18).setDepth(DEPTH.decal - 1);
    this.sprite = mkImage(ctx, this.bag, this.center.x, this.center.y - 1, hourglassFrame(1));
    this.sprite.setDepth(ySortDepth(this.center.y + 6));
    for (const t of def.levers) {
      const c = tileCenter(t);
      const ring = ctx.scene.add.ellipse(c.x, c.y + 5, 17, 8, 0xffc24a, 0.2);
      ring.setStrokeStyle(1, 0xffc24a, 1).setDepth(DEPTH.flat + 0.1);
      ctx.rig.registerWorld(ring);
      this.bag.push(ring);
      const sprite = mkImage(ctx, this.bag, c.x, c.y, leverFrame(false));
      sprite.setDepth(ySortDepth(c.y + 6));
      const marker = mkImage(ctx, this.bag, c.x, c.y - 13, 'fx_marker');
      marker.setTint(0xffc24a).setDepth(ySortDepth(c.y) + 200);
      this.levers.push({ sprite, marker, ring, center: c, lastFrame: '' });
    }
    for (const t of def.gate) {
      const c = tileCenter(t);
      const sprite = mkImage(ctx, this.bag, c.x, c.y, gateFrame(false));
      sprite.setDepth(DEPTH.flat);
      const outline = ctx.scene.add.rectangle(c.x, c.y, TILE - 1, TILE - 1, 0xff3a3a, 0);
      outline.setStrokeStyle(1, 0x7dffb0, 0.3).setDepth(DEPTH.flat + 0.2);
      ctx.rig.registerWorld(outline);
      this.bag.push(outline);
      this.gate.push({ sprite, outline, center: c, closed: null, flashUntilMs: 0 });
    }
  }

  update(st: MechanismState, timeMs: number): void {
    if (st.type !== 'hourglass') return;
    const s: HourglassState = st;
    const status = hourglassStatus(this.def, s, this.playerCount);
    // retournement : le sable vient d'augmenter d'un coup
    if (this.lastSand >= 0 && sandJumped(this.lastSand, s.sandMs)) {
      this.flipStartMs = timeMs;
      this.leverUntilMs = timeMs + HOURGLASS_LEVER_MS;
    }
    this.lastSand = s.sandMs;

    const f = hourglassFrame(status.ratio);
    if (f !== this.lastFrame) {
      this.sprite.setFrame(f);
      this.lastFrame = f;
    }
    const flipK = Math.max(0, Math.min(1, (timeMs - this.flipStartMs) / HOURGLASS_FLIP_MS));
    const flipping = flipK > 0 && flipK < 1;
    const eased = 1 - Math.pow(1 - flipK, 3);
    this.sprite.setRotation(flipping ? Math.PI * 2 * eased : 0);
    this.sprite.setScale(flipping ? 1 + 0.25 * Math.sin(flipK * Math.PI) : 1);
    this.sprite.setAlpha(s.waived ? 0.5 : 1);
    const blink = s.waived ? 1 : hourglassBlinkAlpha(status.level, timeMs);
    if (status.level === 'ok' || s.waived) this.sprite.clearTint();
    else this.sprite.setTint(blink > 0.65 ? 0xffffff : 0xff6a5a);
    this.glow.setTint(status.level === 'ok' ? 0xffc24a : 0xff4a3a);
    this.glow.setAlpha(s.waived ? 0 : 0.14 + 0.1 * (status.level === 'ok' ? 0.5 + 0.5 * Math.sin(timeMs / 400) : 1 - blink) + (flipping ? 0.3 * (1 - flipK) : 0));

    // leviers
    for (let i = 0; i < this.levers.length; i++) {
      const lv = this.levers[i];
      const on = timeMs < this.leverUntilMs && s.lastLever === i;
      const lf = leverFrame(on);
      if (lf !== lv.lastFrame) {
        lv.sprite.setFrame(lf);
        lv.lastFrame = lf;
      }
      lv.marker.setVisible(!s.waived);
      lv.marker.setY(lv.center.y - 13 + bob(timeMs, i, 1.5));
      lv.ring.setVisible(!s.waived);
      lv.ring.setFillStyle(lv.ring.fillColor, 0.14 + 0.1 * (0.5 + 0.5 * Math.sin(timeMs / 300 + i)));
    }

    // herse
    const flags = gateClosedFlags(s.waived ? 0 : s.closedCount, this.gate.length);
    for (let i = 0; i < this.gate.length; i++) {
      const g = this.gate[i];
      const closed = flags[i];
      if (g.closed !== null && closed && !g.closed) g.flashUntilMs = timeMs + GATE_FLASH_MS;
      if (closed !== g.closed) {
        g.closed = closed;
        g.sprite.setFrame(gateFrame(closed));
        g.sprite.setDepth(closed ? ySortDepth(g.center.y + TILE / 2 - 1) : DEPTH.flat);
      }
      const k = timeMs < g.flashUntilMs ? (g.flashUntilMs - timeMs) / GATE_FLASH_MS : 0;
      if (k > 0.5) g.sprite.setTintFill(0xffffff);
      else g.sprite.clearTint();
      // contour : vert discret (passable), rouge clignotant sur la prochaine tuile à fermer quand le sable est vide
      const next = !s.waived && status.level === 'empty' && i === status.closed;
      const warn = !s.waived && status.level === 'low' && !closed;
      g.outline.setVisible(!s.waived && !closed);
      if (next) g.outline.setStrokeStyle(2, 0xff3a3a, 0.45 + 0.5 * blink);
      else if (warn) g.outline.setStrokeStyle(1, 0xff9a3a, 0.25 + 0.5 * (1 - blink));
      else g.outline.setStrokeStyle(1, 0x7dffb0, 0.28);
    }
  }

  /** Centre de la tuile de herse d'indice `i` (FX de fermeture). */
  partCenter(i: number): Vec2 | null {
    return this.gate[i]?.center ?? null;
  }

  destroy(): void {
    destroyAll(this.bag);
    this.levers.length = 0;
    this.gate.length = 0;
  }
}

// ───────────────────────────── Pont de lumière (niveau 6) ─────────────────────────────

/** Durée (ms) du flash d'une planche qui s'allume. */
const BRIDGE_FLASH_MS = 300;

/**
 * Tuiles du pont dessinées PAR-DESSUS le sol '.' : planches de lumière dorées quand `lit[i]`, abîme étoilé aux planches
 * fantômes sinon (le sol réel sous-jacent est praticable dans la grille : c'est la simulation qui décide, ici on ne fait que
 * montrer). Flash à l'allumage, lueur dorée pulsée sur les planches éclairées. LIT LightBridgeState.
 */
class LightBridgeView implements MechView {
  readonly id: string;
  readonly center: Vec2;
  private readonly bag: Phaser.GameObjects.GameObject[] = [];
  private readonly tiles: { img: Img; glow: Img; lit: boolean | null; flashUntilMs: number }[] = [];

  constructor(ctx: ViewContext, def: LightBridgeDef) {
    this.id = def.id;
    let sx = 0;
    let sy = 0;
    for (const t of def.tiles) {
      const c = tileCenter(t);
      sx += c.x;
      sy += c.y;
      const img = mkImage(ctx, this.bag, c.x, c.y, bridgeFrame(false));
      img.setDepth(DEPTH.floor + 1);
      const glow = mkImage(ctx, this.bag, c.x, c.y, undefined, FX_GLOW_KEY);
      glow.setBlendMode(1).setTint(0xffd86a).setScale(0.8).setAlpha(0).setDepth(DEPTH.floor + 1.5).setVisible(false);
      this.tiles.push({ img, glow, lit: null, flashUntilMs: 0 });
    }
    const n = Math.max(1, def.tiles.length);
    this.center = { x: sx / n, y: sy / n };
  }

  update(st: MechanismState, timeMs: number): void {
    if (st.type !== 'lightBridge') return;
    const s: LightBridgeState = st;
    for (let i = 0; i < this.tiles.length; i++) {
      const t = this.tiles[i];
      const lit = bridgeTileLit(s, i);
      if (lit !== t.lit) {
        if (t.lit === false && lit) t.flashUntilMs = timeMs + BRIDGE_FLASH_MS;
        t.lit = lit;
        t.img.setFrame(bridgeFrame(lit));
        t.glow.setVisible(lit);
      }
      const k = timeMs < t.flashUntilMs ? (t.flashUntilMs - timeMs) / BRIDGE_FLASH_MS : 0;
      if (k > 0.5) t.img.setTintFill(0xffffff);
      else t.img.clearTint();
      if (lit) t.glow.setAlpha(0.16 + 0.08 * Math.sin(timeMs / 220 + i * 0.7) + 0.35 * k);
    }
  }

  /** Centre de la tuile de pont d'indice `i`. */
  partCenter(i: number): Vec2 | null {
    const t = this.tiles[i];
    return t ? { x: t.img.x, y: t.img.y } : null;
  }

  destroy(): void {
    destroyAll(this.bag);
    this.tiles.length = 0;
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
    case 'statuePair':
      return new StatuePairView(ctx, def);
    case 'hourglass':
      return new HourglassView(ctx, def);
    case 'lightBridge':
      return new LightBridgeView(ctx, def);
    default:
      return null;
  }
}

/** Vue d'énigme de runes (accès aux centres de piédestaux depuis RoomView). */
export function isRuneView(v: MechView): v is MechView & { pedestalCenter(i: number): Vec2 | null } {
  return v instanceof RuneView;
}
