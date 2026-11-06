/**
 * Effets visuels des 8 ATTAQUES SPÉCIALES (événement `specialUsed`) : tourbillon, nova de feu, ruée, lumière salvatrice,
 * volée d'étoiles, séisme, fracas du troll, danse des lames.
 *
 * Style : pixel art net. Les formes (anneaux, arcs, fissures, rayons, éclairs) sont dessinées pixel par pixel dans des
 * `Graphics` POOLÉS à des positions entières, en quelques PALIERS (l'anneau grandit par à-coups, jamais en continu) ;
 * les éclats utilisent les frames d'atlas (`fx_slash_*`, `fx_star`, `fx_ember`, `fx_heal`, `fx_hit_*`) à l'échelle 1.
 * Aucun flou, aucun agrandissement de sprite. Aucune création d'objet en régime établi (pool de Graphics + pool d'images
 * du FxManager) ; tout est détruit par `destroy()`.
 *
 * La partie PURE (spans d'anneaux/disques, points d'arcs/lignes/fissures, palettes, paliers, secousses) est testée sans Phaser.
 */
import type Phaser from 'phaser';
import { CosmeticRng, DEPTH_FX, FX_PIXEL_KEY, type FxManager, easeOutCubic } from './fx';
import type { ViewRig } from './camera';
import type { Dir, PlayerId, SpecialDef, SpecialKind, Vec2 } from '../core/types';

// ───────────────────────────── Partie pure ─────────────────────────────

/** Rectangle entier (relatif au centre d'une forme). */
export interface PxRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Sous-ensemble de `Phaser.GameObjects.Graphics` utilisé (permet de tester avec un enregistreur). */
export interface GfxLike {
  clear(): unknown;
  fillStyle(color: number, alpha?: number): unknown;
  fillRect(x: number, y: number, w: number, h: number): unknown;
}

/** Palette d'une attaque spéciale. */
export interface SpecialPalette {
  /** Couleur dominante. */
  main: number;
  /** Éclat clair. */
  light: number;
  /** Teinte sombre / contour. */
  dark: number;
  /** Accent lié au joueur. */
  accent: number;
}

/** Mélange linéaire de deux couleurs 0xRRGGBB (t ∈ [0,1]). */
export function mixColor(a: number, b: number, t: number): number {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  const r = Math.round(((a >> 16) & 255) * (1 - k) + ((b >> 16) & 255) * k);
  const g = Math.round(((a >> 8) & 255) * (1 - k) + ((b >> 8) & 255) * k);
  const bl = Math.round((a & 255) * (1 - k) + (b & 255) * k);
  return (r << 16) | (g << 8) | bl;
}

/** Palette de l'attaque `kind`, l'accent étant la couleur du joueur. */
export function specialPalette(kind: SpecialKind, playerColor: number): SpecialPalette {
  switch (kind) {
    case 'whirlwind':
      return { main: 0xb8cbff, light: 0xf4f8ff, dark: 0x7e92d8, accent: playerColor };
    case 'fireNova':
      return { main: 0xff9a3c, light: 0xffe27a, dark: 0xc0243c, accent: playerColor };
    case 'dash':
      return { main: mixColor(playerColor, 0xffffff, 0.35), light: 0xffffff, dark: mixColor(playerColor, 0x000000, 0.35), accent: playerColor };
    case 'healNova':
      return { main: 0xfff08a, light: 0xffffff, dark: 0x7dffb0, accent: playerColor };
    case 'arrowFan':
      return { main: 0x9affc8, light: 0xffffff, dark: 0x2fb87a, accent: playerColor };
    case 'quake':
      return { main: 0xc9c2b4, light: 0xffe27a, dark: 0x4a3034, accent: playerColor };
    case 'smash':
      return { main: 0xffe27a, light: 0xffffff, dark: 0xff9a3c, accent: playerColor };
    case 'bladeDance':
      return { main: 0x66f2ff, light: 0xe8ffff, dark: 0xe05aff, accent: playerColor };
    default:
      return { main: 0xffffff, light: 0xffffff, dark: 0x808080, accent: playerColor };
  }
}

/** Rayon d'effet par défaut (px) quand la définition du spécial n'est pas disponible. */
export function defaultSpecialRadius(kind: SpecialKind): number {
  switch (kind) {
    case 'whirlwind':
      return 28;
    case 'fireNova':
      return 40;
    case 'healNova':
      return 64;
    case 'quake':
      return 56;
    case 'smash':
      return 48;
    case 'bladeDance':
      return 30;
    case 'arrowFan':
      return 44;
    default:
      return 24;
  }
}

/** Secousse de caméra associée (durée ms, intensité) ; null = aucune. */
export function specialShake(kind: SpecialKind): { durationMs: number; intensity: number } | null {
  switch (kind) {
    case 'fireNova':
      return { durationMs: 220, intensity: 0.007 };
    case 'quake':
      return { durationMs: 400, intensity: 0.012 };
    case 'smash':
      return { durationMs: 320, intensity: 0.013 };
    case 'whirlwind':
      return { durationMs: 120, intensity: 0.003 };
    case 'bladeDance':
      return { durationMs: 100, intensity: 0.002 };
    default:
      return null;
  }
}

/**
 * Centre de la zone d'effet. L'événement `specialUsed.pos` est déjà le centre réel (devant la lanceuse pour la nova de feu,
 * sur le héros sinon, point de départ pour la ruée) : on le reprend tel quel, copié.
 */
export function specialCenter(pos: Vec2): Vec2 {
  return { x: pos.x, y: pos.y };
}

/** Vecteur unitaire d'une direction cardinale. */
export function dirUnit(dir: Dir): Vec2 {
  switch (dir) {
    case 'up':
      return { x: 0, y: -1 };
    case 'down':
      return { x: 0, y: 1 };
    case 'left':
      return { x: -1, y: 0 };
    default:
      return { x: 1, y: 0 };
  }
}

/** Angle (rad, y vers le bas) d'une direction cardinale. */
export function dirAngle(dir: Dir): number {
  switch (dir) {
    case 'up':
      return -Math.PI / 2;
    case 'down':
      return Math.PI / 2;
    case 'left':
      return Math.PI;
    default:
      return 0;
  }
}

/** Direction cardinale la plus proche d'un angle (rad). */
export function dirOfAngle(angle: number): Dir {
  const a = Math.atan2(Math.sin(angle), Math.cos(angle));
  if (a >= -Math.PI / 4 && a < Math.PI / 4) return 'right';
  if (a >= Math.PI / 4 && a < (3 * Math.PI) / 4) return 'down';
  if (a >= -(3 * Math.PI) / 4 && a < -Math.PI / 4) return 'up';
  return 'left';
}

/** Demi-largeur entière d'un disque de rayon `r` à la ligne `dy` ; -1 hors du disque. */
export function discHalfWidth(r: number, dy: number): number {
  const v = r * r - dy * dy;
  return v < 0 ? -1 : Math.floor(Math.sqrt(v) + 0.5);
}

/** Lignes (1 px de haut) d'un disque plein de rayon `r`, relatives au centre. */
export function discSpans(r: number): PxRect[] {
  const out: PxRect[] = [];
  const rr = Math.max(0, Math.round(r));
  for (let dy = 0 - rr; dy <= rr; dy++) {
    const hw = discHalfWidth(rr, dy);
    if (hw >= 0) out.push({ x: 0 - hw, y: dy, w: 2 * hw + 1, h: 1 });
  }
  return out;
}

/** Lignes d'un anneau de rayon extérieur `r` et d'épaisseur `thick` (≥ 1 px partout), relatives au centre. */
export function ringSpans(r: number, thick: number): PxRect[] {
  const out: PxRect[] = [];
  const ro = Math.max(1, Math.round(r));
  const ri = Math.max(0, ro - Math.max(1, Math.round(thick)));
  for (let dy = -ro; dy <= ro; dy++) {
    const ho = discHalfWidth(ro, dy);
    if (ho < 0) continue;
    let hi = Math.abs(dy) < ri ? discHalfWidth(ri, dy) : -1;
    if (hi >= ho) hi = ho - 1;
    if (hi < 0) out.push({ x: -ho, y: dy, w: 2 * ho + 1, h: 1 });
    else {
      out.push({ x: -ho, y: dy, w: ho - hi, h: 1 });
      out.push({ x: hi + 1, y: dy, w: ho - hi, h: 1 });
    }
  }
  return out;
}

/** Palier courant (0..steps-1) pour une progression `t` ∈ [0,1]. */
export function stageOf(t: number, steps: number): number {
  const n = Math.max(1, Math.floor(steps));
  const s = Math.floor((t < 0 ? 0 : t) * n);
  return s >= n ? n - 1 : s;
}

/** Rayon d'un anneau au palier `stage` : croît par à-coups (ralentissement en fin de course), jamais en continu. */
export function stagedRadius(r1: number, stage: number, steps: number): number {
  const n = Math.max(1, Math.floor(steps));
  const k = (Math.min(Math.max(stage, 0), n - 1) + 1) / n;
  return Math.max(2, Math.round(r1 * easeOutCubic(k)));
}

/** Points entiers uniques d'une bande d'arc : rayons [r0, r1), angles [a0, a1] (rad). */
export function arcPoints(r0: number, r1: number, a0: number, a1: number): Vec2[] {
  const out: Vec2[] = [];
  const seen = new Set<number>();
  const lo = Math.max(1, Math.round(r0));
  const hi = Math.max(lo + 1, Math.round(r1));
  for (let r = lo; r < hi; r++) {
    const n = Math.max(2, Math.ceil(Math.abs(a1 - a0) * r * 1.25));
    for (let i = 0; i <= n; i++) {
      const a = a0 + ((a1 - a0) * i) / n;
      const x = Math.round(Math.cos(a) * r);
      const y = Math.round(Math.sin(a) * r);
      const key = (x + 512) * 1024 + (y + 512);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ x, y });
    }
  }
  return out;
}

/** Points d'une ligne de Bresenham entre deux points entiers (extrémités incluses). */
export function linePoints(x0: number, y0: number, x1: number, y1: number): Vec2[] {
  const out: Vec2[] = [];
  let x = Math.round(x0);
  let y = Math.round(y0);
  const ex = Math.round(x1);
  const ey = Math.round(y1);
  const dx = Math.abs(ex - x);
  const dy = -Math.abs(ey - y);
  const sx = x < ex ? 1 : -1;
  const sy = y < ey ? 1 : -1;
  let err = dx + dy;
  for (let guard = 0; guard < 4096; guard++) {
    out.push({ x, y });
    if (x === ex && y === ey) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
  return out;
}

/** Tracé irrégulier d'une fissure : partant de (0,0), longueur ≈ `len` px, direction `angle` avec écarts aléatoires. */
export function crackPath(rng: CosmeticRng, len: number, angle: number): Vec2[] {
  const out: Vec2[] = [];
  let x = 0;
  let y = 0;
  let a = angle;
  const n = Math.max(1, Math.round(len));
  for (let i = 0; i < n; i++) {
    if (i % 4 === 0) a = angle + rng.range(-0.55, 0.55);
    x += Math.cos(a);
    y += Math.sin(a);
    const px = Math.round(x);
    const py = Math.round(y);
    const last = out[out.length - 1];
    if (!last || last.x !== px || last.y !== py) out.push({ x: px, y: py });
  }
  return out;
}

/** Dessine un anneau net de couleur `color`. */
export function drawRing(g: GfxLike, r: number, thick: number, color: number, alpha = 1): void {
  g.fillStyle(color, alpha);
  for (const s of ringSpans(r, thick)) g.fillRect(s.x, s.y, s.w, s.h);
}

/** Dessine un disque plein. */
export function drawDisc(g: GfxLike, r: number, color: number, alpha = 1): void {
  g.fillStyle(color, alpha);
  for (const s of discSpans(r)) g.fillRect(s.x, s.y, s.w, s.h);
}

/** Dessine des points (carrés `size`×`size`). */
export function drawPoints(g: GfxLike, pts: readonly Vec2[], color: number, size = 2, alpha = 1, ox = 0, oy = 0): void {
  g.fillStyle(color, alpha);
  for (const p of pts) g.fillRect(p.x + ox, p.y + oy, size, size);
}

/** Description d'une forme pixel animée par paliers. */
export interface ShapeSpec {
  x: number;
  y: number;
  /** Durée totale (ms). */
  dur: number;
  /** Nombre de paliers de dessin. */
  steps: number;
  delay?: number;
  /** Profondeur (défaut : au-dessus des entités). */
  depth?: number;
  /** Alpha de départ (défaut 1). */
  alpha?: number;
  /** Part de la durée pendant laquelle la forme reste pleinement opaque avant de s'estomper (défaut 0.45). */
  hold?: number;
  /** Dessine le palier `stage` (le Graphics est déjà vidé ; l'origine est le centre de la forme). */
  render: (g: GfxLike, stage: number, steps: number) => void;
}

/** Alpha d'une forme à la progression `t` : plein jusqu'à `hold`, puis fondu linéaire. */
export function shapeAlpha(t: number, a0: number, hold: number): number {
  if (t <= hold) return a0;
  const k = (t - hold) / Math.max(0.0001, 1 - hold);
  return a0 * Math.max(0, 1 - k);
}

// ───────────────────────────── Pool de formes (Phaser) ─────────────────────────────

interface ShapeItem {
  g: Phaser.GameObjects.Graphics;
  active: boolean;
  age: number;
  delay: number;
  spec: ShapeSpec | null;
  stage: number;
}

const MAX_SHAPES = 24;

/** Informations nécessaires au déclenchement d'un spécial. */
export interface SpecialPlay {
  playerId: PlayerId;
  kind: SpecialKind;
  /** Position de l'événement `specialUsed` (centre réel de l'effet). */
  pos: Vec2;
  dir: Dir;
  /** Position actuelle de la lanceuse/du lanceur (texte flottant, arrivée de la ruée) ; défaut : `pos`. */
  casterPos?: Vec2;
  /** Frame d'atlas du héros (images rémanentes de la ruée). */
  heroFrame?: string;
  /** Couleur du joueur. */
  playerColor: number;
  /** Définition du spécial (rayon, portée, durée…), si connue. */
  def?: SpecialDef;
  /** Nom traduit affiché en texte flottant (vide = aucun). */
  name?: string;
  /** Alliés vivants à portée (lumière salvatrice) : jaillissement de soin sur chacun. */
  allies?: ReadonlyArray<{ id: PlayerId; x: number; y: number }>;
  /** Texte flottant affiché sur les alliés soignés. */
  healText?: string;
}

/** Gestionnaire des effets de spéciaux : un par scène de jeu. */
export class SpecialFx {
  private readonly shapes: ShapeItem[] = [];
  private nextShape = 0;
  private readonly rng = new CosmeticRng(0x5eed1e55);

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly rig: ViewRig,
    private readonly fx: FxManager,
  ) {}

  // ── pool ──

  private acquire(): ShapeItem {
    for (const s of this.shapes) if (!s.active) return s;
    if (this.shapes.length < MAX_SHAPES) {
      const g = this.scene.add.graphics();
      this.rig.registerWorld(g);
      g.setVisible(false);
      const it: ShapeItem = { g, active: false, age: 0, delay: 0, spec: null, stage: -1 };
      this.shapes.push(it);
      return it;
    }
    const it = this.shapes[this.nextShape];
    this.nextShape = (this.nextShape + 1) % this.shapes.length;
    return it;
  }

  /** Lance une forme pixel par paliers. */
  shape(spec: ShapeSpec): void {
    const it = this.acquire();
    it.active = true;
    it.age = 0;
    it.delay = spec.delay && spec.delay > 0 ? spec.delay : 0;
    it.spec = spec;
    it.stage = -1;
    it.g.clear();
    it.g.setPosition(Math.round(spec.x), Math.round(spec.y));
    it.g.setDepth(spec.depth ?? DEPTH_FX - 1);
    it.g.setAlpha(spec.alpha ?? 1);
    it.g.setVisible(false);
  }

  /** Anneau net qui grandit par paliers jusqu'au rayon `r1`. */
  private ring(x: number, y: number, r1: number, thick: number, color: number, o: { dur?: number; steps?: number; delay?: number; inner?: number; fill?: number; fillAlpha?: number; depth?: number; alpha?: number; hold?: number } = {}): void {
    const steps = o.steps ?? 4;
    this.shape({
      x,
      y,
      dur: o.dur ?? 380,
      steps,
      delay: o.delay,
      depth: o.depth,
      alpha: o.alpha,
      hold: o.hold,
      render: (g, stage) => {
        const r = stagedRadius(r1, stage, steps);
        if (o.fill !== undefined) drawDisc(g, Math.max(1, r - 1), o.fill, o.fillAlpha ?? 0.3);
        drawRing(g, r, thick, color, 1);
        if (o.inner !== undefined && r > thick + 3) drawRing(g, r - thick, 1, o.inner, 1);
      },
    });
  }

  // ── déclenchement ──

  /** Joue l'effet complet d'un spécial (formes, éclats, texte flottant, secousse). */
  play(p: SpecialPlay): void {
    const pal = specialPalette(p.kind, p.playerColor);
    const def = p.def;
    const radius = def && def.radius > 0 ? def.radius : defaultSpecialRadius(p.kind);
    const range = def && def.range > 0 ? def.range : 0;
    const animMs = def && def.animMs > 0 ? def.animMs : 400;
    const c = specialCenter(p.pos);
    switch (p.kind) {
      case 'whirlwind':
        this.whirlwind(p, pal, radius, animMs);
        break;
      case 'fireNova':
        this.fireNova(c, pal, radius);
        break;
      case 'dash':
        this.dash(p, pal);
        break;
      case 'healNova':
        this.healNova(p, pal, radius);
        break;
      case 'arrowFan':
        this.arrowFan(p, pal);
        break;
      case 'quake':
        this.quake(c, pal, radius);
        break;
      case 'smash':
        this.smash(p, pal, Math.max(range, 30), def?.arcDeg ?? 150);
        break;
      case 'bladeDance':
        this.bladeDance(p, pal, radius, animMs);
        break;
      default:
        break;
    }
    const who = p.casterPos ?? p.pos;
    if (p.name) this.fx.floatText(Math.round(who.x), Math.round(who.y - 18), p.name, pal.accent, 1000, 12, 8);
    const sh = specialShake(p.kind);
    if (sh) this.rig.shake(sh.durationMs, sh.intensity, p.playerId);
  }

  /** Tourbillon : arc tournant avec traînée, éclats de lame en spirale, onde au sol. */
  private whirlwind(p: SpecialPlay, pal: SpecialPalette, radius: number, animMs: number): void {
    const { x, y } = p.pos;
    const steps = 12;
    const arcR = Math.max(10, Math.min(radius, 40));
    this.shape({
      x,
      y: y - 2,
      dur: animMs,
      steps,
      hold: 0.8,
      render: (g, stage) => {
        const a = stage * ((Math.PI * 4) / steps) + dirAngle(p.dir);
        for (let k = 3; k >= 0; k--) {
          const pts = arcPoints(arcR - 3, arcR, a - 1.0 - k * 0.55, a - k * 0.55);
          const col = k === 0 ? pal.light : k === 1 ? pal.main : k === 2 ? pal.dark : pal.accent;
          drawPoints(g, pts, col, 2, k === 3 ? 0.55 : 1);
        }
      },
    });
    this.ring(x, y + 3, radius, 3, pal.main, { dur: 360, steps: 4, inner: pal.light, depth: 7, alpha: 0.9 });
    this.ring(x, y + 3, radius, 2, pal.accent, { dur: 320, steps: 4, delay: animMs * 0.5, depth: 7, alpha: 0.8 });
    const d = Math.max(8, Math.min(20, radius * 0.6));
    const n = 8;
    for (let k = 0; k < n; k++) {
      const a = dirAngle(p.dir) + (k * Math.PI * 2) / n;
      this.fx.sprite({
        x: Math.round(x + Math.cos(a) * d),
        y: Math.round(y - 2 + Math.sin(a) * d),
        dur: 200,
        delay: (k * animMs) / n,
        frame: `fx_slash_${dirOfAngle(a)}`,
        tint: k % 2 === 0 ? pal.light : pal.main,
        additive: true,
        a0: 1,
        a1: 0,
      });
    }
    this.fx.dust(x, y + 4, 8, Math.round(radius * 0.5));
  }

  /** Nova de feu : anneaux enflammés par paliers, cœur blanc, braises. */
  private fireNova(c: Vec2, pal: SpecialPalette, radius: number): void {
    this.shape({
      x: c.x,
      y: c.y,
      dur: 160,
      steps: 2,
      depth: DEPTH_FX - 1,
      render: (g, stage) => {
        drawDisc(g, stage === 0 ? Math.round(radius * 0.4) : Math.round(radius * 0.25), pal.light, stage === 0 ? 0.95 : 0.8);
      },
    });
    this.ring(c.x, c.y, radius, 5, pal.main, { dur: 480, steps: 5, inner: pal.light, fill: pal.dark, fillAlpha: 0.38, depth: 7 });
    this.ring(c.x, c.y, Math.round(radius * 0.7), 3, pal.dark, { dur: 420, steps: 4, delay: 90, depth: 7, alpha: 0.9 });
    this.ring(c.x, c.y, Math.round(radius * 1.12), 2, pal.accent, { dur: 380, steps: 4, delay: 140, depth: 7, alpha: 0.7 });
    for (let i = 0; i < 18; i++) {
      const a = this.rng.range(0, Math.PI * 2);
      const v = this.rng.range(18, radius * 1.6);
      this.fx.sprite({
        x: Math.round(c.x),
        y: Math.round(c.y),
        dur: this.rng.range(450, 900),
        frame: 'fx_ember',
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v * 0.7 - 12,
        ay: -14,
        a0: 1,
        a1: 0,
        additive: true,
      });
    }
    this.fx.burst(c.x, c.y, 10, pal.light, 70, 380, 40, 1);
    this.fx.sprite({ x: Math.round(c.x), y: Math.round(c.y), dur: 260, frame: 'fx_star', tint: pal.light, additive: true, a0: 1, a1: 0, eased: true });
  }

  /** Ruée : traits de vitesse derrière le héros et poussière (les images rémanentes sont dans PlayerView). */
  private dash(p: SpecialPlay, pal: SpecialPalette): void {
    const { x, y } = p.pos;
    const back = dirAngle(p.dir) + Math.PI;
    this.shape({
      x,
      y: y - 2,
      dur: 300,
      steps: 4,
      hold: 0.3,
      render: (g, stage) => {
        for (let k = -2; k <= 2; k++) {
          const a = back + k * 0.2;
          const r0 = 6 + stage * 3 + Math.abs(k) * 2;
          const pts: Vec2[] = linePoints(Math.cos(a) * r0, Math.sin(a) * r0, Math.cos(a) * (r0 + 12 - Math.abs(k) * 2), Math.sin(a) * (r0 + 12 - Math.abs(k) * 2));
          drawPoints(g, pts, k === 0 ? pal.light : pal.main, 1);
        }
      },
    });
    const v = dirUnit(p.dir);
    for (let i = 0; i < 8; i++) {
      this.fx.sprite({
        x: Math.round(x - v.x * this.rng.range(2, 8) + this.rng.range(-3, 3)),
        y: Math.round(y + 4 - v.y * this.rng.range(2, 8) + this.rng.range(-2, 2)),
        dur: this.rng.range(300, 520),
        key: FX_PIXEL_KEY,
        vx: -v.x * this.rng.range(10, 30) + this.rng.range(-8, 8),
        vy: -v.y * this.rng.range(10, 30) - this.rng.range(2, 10),
        s0: this.rng.range(1.5, 2.6),
        s1: 0.8,
        a0: 0.8,
        a1: 0,
        tint: 0xc9c2b4,
      });
    }
    this.fx.sparkles(x, y - 2, pal.main, 6, 6);
    // images rémanentes le long du trajet (le héros arrive instantanément : on matérialise le chemin parcouru)
    const end = p.casterPos ?? p.pos;
    const dist = Math.hypot(end.x - x, end.y - y);
    if (p.heroFrame && dist > 6) {
      const n = Math.min(10, Math.max(2, Math.floor(dist / 9)));
      for (let i = 0; i < n; i++) {
        const k = i / n;
        this.fx.sprite({
          x: Math.round(x + (end.x - x) * k),
          y: Math.round(y + (end.y - y) * k - 3),
          dur: 300 + i * 20,
          delay: i * 12,
          frame: p.heroFrame,
          tint: mixColor(p.playerColor, 0xffffff, 0.45),
          fill: true,
          a0: 0.65,
          a1: 0,
          depth: DEPTH_FX - 2,
        });
        if (i % 2 === 0) this.fx.dust(x + (end.x - x) * k, y + 4 + (end.y - y) * k, 2, 3);
      }
    }
  }

  /** Lumière salvatrice : onde dorée qui s'étend, étoiles montantes, soin sur chaque allié. */
  private healNova(p: SpecialPlay, pal: SpecialPalette, radius: number): void {
    const { x, y } = p.pos;
    const dur = 620;
    this.ring(x, y, radius, 4, pal.main, { dur, steps: 6, fill: pal.light, fillAlpha: 0.18, inner: pal.light, depth: 7, hold: 0.55 });
    this.ring(x, y, Math.round(radius * 0.6), 2, pal.dark, { dur: 480, steps: 5, delay: 120, depth: 7, alpha: 0.85 });
    for (let i = 0; i < 6; i++) {
      this.fx.sprite({
        x: Math.round(x + this.rng.range(-8, 8)),
        y: Math.round(y - 2 + this.rng.range(-3, 3)),
        dur: this.rng.range(600, 900),
        delay: i * 60,
        frame: 'fx_star',
        tint: i % 2 === 0 ? pal.light : pal.main,
        additive: true,
        vy: -this.rng.range(16, 34),
        a0: 1,
        a1: 0,
      });
    }
    const allies = p.allies ?? [];
    for (const a of allies) {
      const dist = Math.hypot(a.x - x, a.y - y);
      const delay = Math.min(dur * 0.7, (dist / Math.max(1, radius)) * dur * 0.8);
      this.ring(a.x, a.y + 2, 11, 2, pal.dark, { dur: 380, steps: 3, delay, depth: 7, alpha: 0.95 });
      for (let i = 0; i < 4; i++) {
        this.fx.sprite({
          x: Math.round(a.x + this.rng.range(-7, 7)),
          y: Math.round(a.y + this.rng.range(-2, 4)),
          dur: this.rng.range(520, 820),
          delay: delay + i * 70,
          frame: 'fx_heal',
          vy: -this.rng.range(14, 28),
          a0: 1,
          a1: 0,
          eased: true,
        });
      }
      this.fx.sparkles(a.x, a.y - 2, pal.dark, 8, 8);
      if (p.healText) this.fx.floatText(Math.round(a.x), Math.round(a.y - 34), p.healText, pal.dark, 900, 12, 7);
    }
  }

  /** Volée d'étoiles : éclat de lancement et éventail de rayons devant le héros. */
  private arrowFan(p: SpecialPlay, pal: SpecialPalette): void {
    const { x, y } = p.pos;
    const base = dirAngle(p.dir);
    const reach = 44;
    const steps = 4;
    this.shape({
      x,
      y: y - 3,
      dur: 300,
      steps,
      hold: 0.4,
      render: (g, stage) => {
        for (let k = -2; k <= 2; k++) {
          const a = base + k * 0.36;
          const r0 = 8 + stage * Math.round(reach / 4);
          const pts = linePoints(Math.cos(a) * r0, Math.sin(a) * r0, Math.cos(a) * (r0 + 12), Math.sin(a) * (r0 + 12));
          drawPoints(g, pts, k === 0 ? pal.light : pal.main, 2, 1);
        }
      },
    });
    const v = dirUnit(p.dir);
    this.fx.sprite({ x: Math.round(x + v.x * 9), y: Math.round(y - 3 + v.y * 9), dur: 260, frame: 'fx_star', tint: pal.light, additive: true, a0: 1, a1: 0, eased: true });
    for (let i = 0; i < 8; i++) {
      const a = base + this.rng.range(-0.7, 0.7);
      const s = this.rng.range(30, 80);
      this.fx.sprite({
        x: Math.round(x + v.x * 8),
        y: Math.round(y - 3 + v.y * 8),
        dur: this.rng.range(260, 480),
        key: FX_PIXEL_KEY,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s,
        s0: this.rng.range(1, 1.8),
        s1: 0.3,
        tint: i % 2 === 0 ? pal.light : pal.main,
        additive: true,
      });
    }
  }

  /** Séisme : fissures qui s'étendent, anneaux de poussière échelonnés, débris. */
  private quake(c: Vec2, pal: SpecialPalette, radius: number): void {
    const n = 9;
    const paths: Vec2[][] = [];
    for (let i = 0; i < n; i++) paths.push(crackPath(this.rng, radius * this.rng.range(0.7, 1.05), (i * Math.PI * 2) / n + this.rng.range(-0.2, 0.2)));
    const steps = 6;
    this.shape({
      x: c.x,
      y: c.y,
      dur: 900,
      steps,
      hold: 0.7,
      depth: 7,
      render: (g, stage) => {
        const frac = (stage + 1) / steps;
        for (const path of paths) {
          const upto = Math.max(1, Math.round(path.length * frac));
          const part = path.slice(0, upto);
          drawPoints(g, part, pal.dark, 3, 0.95, -1, -1);
          drawPoints(g, part, 0xff9a3c, 1, 1, 0, 0);
        }
      },
    });
    this.ring(c.x, c.y, radius, 4, pal.main, { dur: 520, steps: 5, depth: 7, alpha: 0.9 });
    this.ring(c.x, c.y, Math.round(radius * 0.72), 3, pal.main, { dur: 460, steps: 4, delay: 110, depth: 7, alpha: 0.8 });
    this.ring(c.x, c.y, Math.round(radius * 0.44), 2, pal.light, { dur: 400, steps: 3, delay: 220, depth: 7, alpha: 0.7 });
    this.fx.dust(c.x, c.y, 16, Math.round(radius * 0.8));
    this.fx.burst(c.x, c.y, 16, 0x7a5a48, 80, 600, 150, 1.2);
    this.fx.burst(c.x, c.y, 6, pal.light, 60, 420, 100, 1);
  }

  /** Fracas du troll : grand arc d'impact en cône, éclats de lame, étincelles. */
  private smash(p: SpecialPlay, pal: SpecialPalette, reach: number, arcDeg: number): void {
    const { x, y } = p.pos;
    const base = dirAngle(p.dir);
    const steps = 5;
    this.shape({
      x,
      y: y - 1,
      dur: 380,
      steps,
      hold: 0.45,
      render: (g, stage) => {
        const rEnd = Math.round(reach * easeOutCubic((stage + 1) / steps));
        const half = Math.max(0.4, (arcDeg * Math.PI) / 360);
        drawPoints(g, arcPoints(Math.max(4, rEnd - 9), rEnd - 5, base - half, base + half), pal.dark, 2, 0.85);
        drawPoints(g, arcPoints(Math.max(4, rEnd - 5), rEnd - 1, base - half, base + half), pal.main, 2, 1);
        drawPoints(g, arcPoints(Math.max(4, rEnd - 2), rEnd + 1, base - half * 0.9, base + half * 0.9), pal.light, 2, 1);
      },
    });
    const v = dirUnit(p.dir);
    for (let i = 0; i < 3; i++) {
      this.fx.sprite({
        x: Math.round(x + v.x * (10 + i * 8)),
        y: Math.round(y - 2 + v.y * (10 + i * 8)),
        dur: 260,
        delay: i * 45,
        frame: `fx_slash_${p.dir}`,
        tint: i === 2 ? pal.light : pal.main,
        additive: true,
        a0: 1,
        a1: 0,
      });
    }
    const tip = Math.round(reach * 0.75);
    for (let i = -1; i <= 1; i++) {
      const a = base + i * 0.6;
      this.fx.sprite({
        x: Math.round(x + Math.cos(a) * tip),
        y: Math.round(y - 2 + Math.sin(a) * tip),
        dur: 240,
        delay: 70 + (i + 1) * 40,
        frames: ['fx_hit_0', 'fx_hit_1', 'fx_hit_2'],
        frameMs: 80,
        a0: 1,
        a1: 1,
      });
    }
    this.fx.burst(x + v.x * tip * 0.6, y + v.y * tip * 0.6, 14, pal.main, 90, 420, 90, 1.2);
    this.fx.dust(x + v.x * tip * 0.7, y + 4 + v.y * tip * 0.7, 8, 12);
  }

  /** Danse des lames : éclairs de lames tout autour du héros. */
  private bladeDance(p: SpecialPlay, pal: SpecialPalette, radius: number, animMs: number): void {
    const { x, y } = p.pos;
    const steps = Math.max(4, Math.round(animMs / 55));
    const reach = Math.max(12, Math.min(radius, 34));
    const seed = Math.floor(this.rng.range(1, 1e6));
    this.shape({
      x,
      y: y - 3,
      dur: animMs,
      steps,
      hold: 0.85,
      render: (g, stage) => {
        const r = new CosmeticRng(seed + stage * 977);
        for (let i = 0; i < 6; i++) {
          const a = r.range(0, Math.PI * 2);
          const r0 = r.range(3, 7);
          const r1 = r0 + r.range(8, reach - 3);
          const pts = linePoints(Math.cos(a) * r0, Math.sin(a) * r0, Math.cos(a) * r1, Math.sin(a) * r1);
          drawPoints(g, pts, pal.dark, 3, 0.7, -1, -1);
          drawPoints(g, pts, i % 2 === 0 ? pal.light : pal.main, 1, 1);
        }
      },
    });
    const n = 10;
    const dirs: Dir[] = ['up', 'right', 'down', 'left'];
    for (let i = 0; i < n; i++) {
      const a = this.rng.range(0, Math.PI * 2);
      const d = this.rng.range(8, reach);
      this.fx.sprite({
        x: Math.round(x + Math.cos(a) * d),
        y: Math.round(y - 3 + Math.sin(a) * d * 0.8),
        dur: 170,
        delay: (i * animMs) / n,
        frame: `fx_slash_${dirs[i % 4]}`,
        tint: i % 2 === 0 ? pal.light : pal.main,
        additive: true,
        a0: 1,
        a1: 0,
      });
    }
    this.ring(x, y + 3, Math.round(reach * 0.9), 2, pal.accent, { dur: 360, steps: 4, depth: 7, alpha: 0.8 });
    this.fx.sparkles(x, y - 3, pal.light, 8, 12);
  }

  /** Petit éclat quand le spécial est de nouveau prêt (au-dessus de la tête du héros). */
  readyFlash(x: number, y: number, color: number): void {
    this.fx.sprite({ x: Math.round(x), y: Math.round(y - 16), dur: 420, frame: 'fx_star', tint: color, additive: true, a0: 1, a1: 0, eased: true, vy: -6 });
    this.fx.sparkles(x, y - 12, color, 6, 7);
  }

  // ── cycle de vie ──

  /** Avance les formes actives (redessin uniquement au changement de palier). */
  update(dtMs: number): void {
    const dt = dtMs > 0 ? Math.min(dtMs, 100) : 0;
    for (let i = 0; i < this.shapes.length; i++) {
      const it = this.shapes[i];
      if (!it.active || !it.spec) continue;
      if (it.delay > 0) {
        it.delay -= dt;
        if (it.delay > 0) continue;
      }
      it.age += dt;
      const spec = it.spec;
      if (it.age >= spec.dur) {
        it.active = false;
        it.g.setVisible(false);
        continue;
      }
      const t = it.age / spec.dur;
      const stage = stageOf(t, spec.steps);
      if (stage !== it.stage) {
        it.stage = stage;
        it.g.clear();
        spec.render(it.g, stage, spec.steps);
        it.g.setVisible(true);
      }
      it.g.setAlpha(shapeAlpha(t, spec.alpha ?? 1, spec.hold ?? 0.45));
    }
  }

  /** Nombre de formes actives (tests/debug). */
  activeCount(): number {
    let n = 0;
    for (const s of this.shapes) if (s.active) n++;
    return n;
  }

  /** Arrête toutes les formes (changement de salle). */
  clear(): void {
    for (const s of this.shapes) {
      s.active = false;
      s.g.setVisible(false);
    }
  }

  /** Détruit les Graphics du pool. */
  destroy(): void {
    for (const s of this.shapes) s.g.destroy();
    this.shapes.length = 0;
  }
}
