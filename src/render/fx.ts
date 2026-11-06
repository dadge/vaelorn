/**
 * Effets visuels (FX) de la scène de jeu : impacts, nombres de dégâts flottants, morts d'ennemis, particules,
 * anneaux, poussière, confettis, effet de relevage… Tout est POOLÉ (aucune création d'objet Phaser en régime établi).
 *
 * La partie pure (interpolations, textes de dégâts, couleurs) est testée sans Phaser ; Phaser n'est utilisé que
 * par TYPE (import type), les objets sont créés via `scene.add.*`.
 *
 * Textures annexes générées à l'exécution par `ensureFxTextures` : `fx_px` (carré blanc 2×2, particules)
 * et `fx_glow` (halo radial, lueurs de torches/cristaux/impacts).
 */
import type Phaser from 'phaser';
import { PLAYER_COLORS } from '../core/constants';
import { BOSS_COLORS, ENEMY_COLORS, hex } from './palettes';
import { ATLAS_KEY } from './art';
import { enemyFrame, hitFrame, reviveFrame } from './art/animations';
import type { EnemyKind, PlayerId } from '../core/types';
import type { ViewRig } from './camera';

export const FX_PIXEL_KEY = 'fx_px';
export const FX_GLOW_KEY = 'fx_glow';

/** Profondeur des FX (au-dessus des entités triées par Y, sous les étiquettes). */
export const DEPTH_FX = 5000;
/** Profondeur des étiquettes flottantes du monde. */
export const DEPTH_LABELS = 6000;

// ───────────────────────────── Fonctions pures ─────────────────────────────

/** Interpolation linéaire. */
export function fxLerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Progression bornée dans [0,1] ; durée nulle ⇒ 1. */
export function fxProgress(ageMs: number, durMs: number): number {
  if (!(durMs > 0)) return 1;
  const t = ageMs / durMs;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** Ralentissement en fin de course (cubique). */
export function easeOutCubic(t: number): number {
  const u = 1 - (t < 0 ? 0 : t > 1 ? 1 : t);
  return 1 - u * u * u;
}

/** Frame d'une animation à `frameMs` par image ; reste sur la dernière frame une fois terminée. */
export function fxFrameAt(frames: readonly string[], ageMs: number, frameMs: number): string {
  if (frames.length === 0) return '';
  if (!(frameMs > 0)) return frames[0];
  const i = Math.min(frames.length - 1, Math.max(0, Math.floor(ageMs / frameMs)));
  return frames[i];
}

/** Texte d'un nombre de dégâts : entier ≥ 1, jamais NaN. */
export function damageNumberText(damage: number): string {
  if (!Number.isFinite(damage)) return '1';
  return String(Math.max(1, Math.round(damage)));
}

/** Couleur d'un nombre de dégâts infligé à un ennemi (couleur du joueur auteur, blanc sinon). */
export function damageNumberColor(byPlayer: PlayerId | null): number {
  if (byPlayer === null) return 0xffffff;
  return PLAYER_COLORS[byPlayer] ?? 0xffffff;
}

/** Couleur dominante de la mort d'un ennemi (particules). */
export function enemyDeathColor(kind: EnemyKind): number {
  switch (kind) {
    case 'slime':
      return ENEMY_COLORS.slime.base;
    case 'bat':
      return ENEMY_COLORS.bat.wing;
    case 'skeleton':
      return ENEMY_COLORS.skeleton.bone;
    case 'archer':
      return ENEMY_COLORS.archer.hood;
    case 'spider':
      return ENEMY_COLORS.spider.mark;
    case 'wisp':
      return ENEMY_COLORS.wisp.base;
    case 'knight':
      return ENEMY_COLORS.knight.steelLight;
    case 'golem':
      return BOSS_COLORS.golem.glow;
    case 'morvane':
      return BOSS_COLORS.morvane.red;
    default:
      return 0xffffff;
  }
}

/** Petit générateur pseudo-aléatoire COSMÉTIQUE (xorshift32) : les FX ne touchent jamais au PRNG de la simulation. */
export class CosmeticRng {
  private s: number;
  constructor(seed = 0x9e3779b9) {
    this.s = seed | 0 || 1;
  }
  /** Réel dans [0,1). */
  next(): number {
    let x = this.s;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.s = x | 0;
    return ((x >>> 0) % 100000) / 100000;
  }
  /** Réel dans [min,max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }
}

// ───────────────────────────── Textures annexes ─────────────────────────────

/** Crée (si absentes) les textures `fx_px` et `fx_glow`. Idempotent ; ne lève jamais. */
export function ensureFxTextures(scene: Phaser.Scene): void {
  try {
    const tm = scene.textures;
    if (!tm.exists(FX_PIXEL_KEY)) {
      const tex = tm.createCanvas(FX_PIXEL_KEY, 2, 2);
      const ctx = tex?.getContext();
      if (tex && ctx) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, 2, 2);
        tex.refresh();
      }
    }
    if (!tm.exists(FX_GLOW_KEY)) {
      const size = 64;
      const tex = tm.createCanvas(FX_GLOW_KEY, size, size);
      const ctx = tex?.getContext();
      if (tex && ctx) {
        const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
        g.addColorStop(0, 'rgba(255,255,255,1)');
        g.addColorStop(0.35, 'rgba(255,255,255,0.45)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, size, size);
        tex.refresh();
        tex.setFilter(0 as Phaser.Textures.FilterMode); // LINEAR : halo doux
      }
    }
  } catch {
    /* contexte canvas indisponible : les FX concernés seront simplement invisibles */
  }
}

// ───────────────────────────── Texte « monde » net ─────────────────────────────

export interface WorldTextOptions {
  /** Taille en pixels MONDE (défaut 7). */
  size?: number;
  /** Couleur 0xRRGGBB (défaut blanc). */
  color?: number;
  /** Largeur max (pixels monde) avant retour à la ligne ; 0 = pas de retour. */
  wrap?: number;
  originX?: number;
  originY?: number;
}

/**
 * Crée un texte posé dans le monde mais NET à l'écran : police à `size × zoom` px, échelle `1/zoom`
 * (la caméra zoomée le remet à la taille voulue sans le flouter). Ne l'enregistre dans aucune caméra : à faire par l'appelant.
 */
export function makeWorldText(scene: Phaser.Scene, zoom: number, str: string, opts: WorldTextOptions = {}): Phaser.GameObjects.Text {
  const z = zoom > 0 ? zoom : 1;
  const px = Math.max(8, Math.round((opts.size ?? 7) * z));
  const txt = scene.add.text(0, 0, str, {
    fontFamily: 'monospace',
    fontStyle: 'bold',
    fontSize: `${px}px`,
    color: hex(opts.color ?? 0xffffff),
    stroke: '#0b0912',
    strokeThickness: Math.max(2, Math.round(px / 5)),
    align: 'center',
    wordWrap: opts.wrap && opts.wrap > 0 ? { width: Math.round(opts.wrap * z), useAdvancedWrap: true } : undefined,
  });
  txt.setResolution(1);
  txt.setScale(1 / z);
  txt.setOrigin(opts.originX ?? 0.5, opts.originY ?? 1);
  return txt;
}

// ───────────────────────────── Pool d'effets ─────────────────────────────

interface FxItem {
  img: Phaser.GameObjects.Image | null;
  txt: Phaser.GameObjects.Text | null;
  active: boolean;
  age: number;
  dur: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  ax: number;
  ay: number;
  s0: number;
  s1: number;
  a0: number;
  a1: number;
  rot: number;
  vrot: number;
  frames: readonly string[] | null;
  frameMs: number;
  /** Fondu progressif de l'alpha en `easeOut` plutôt que linéaire. */
  eased: boolean;
  /** Retard (ms) avant l'apparition de l'effet (invisible tant que > 0). */
  delay: number;
}

/** Description d'un effet sprite (tous les champs sauf `x`, `y`, `dur` sont optionnels). */
export interface SpriteFxSpec {
  x: number;
  y: number;
  dur: number;
  /** Clé de texture (défaut : atlas). */
  key?: string;
  /** Frame statique. */
  frame?: string;
  /** Frames animées (prioritaires sur `frame`), `frameMs` par image. */
  frames?: readonly string[];
  frameMs?: number;
  vx?: number;
  vy?: number;
  ax?: number;
  ay?: number;
  s0?: number;
  s1?: number;
  a0?: number;
  a1?: number;
  rot?: number;
  vrot?: number;
  tint?: number;
  /** Silhouette unie de la couleur `tint` (flash) au lieu d'une teinte multiplicative. */
  fill?: boolean;
  additive?: boolean;
  depth?: number;
  eased?: boolean;
  /** Retard (ms) avant apparition (effets échelonnés des attaques spéciales). */
  delay?: number;
}

const MAX_IMAGES = 520;
const MAX_TEXTS = 48;

/** Gestionnaire d'effets : un seul par scène de jeu. `update(dtMs)` à chaque frame. */
export class FxManager {
  private readonly images: FxItem[] = [];
  private readonly texts: FxItem[] = [];
  private nextImg = 0;
  private nextTxt = 0;
  private readonly rng = new CosmeticRng();

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly rig: ViewRig,
    private readonly zoom: number,
  ) {}

  // ── pool ──

  private newItem(): FxItem {
    return {
      img: null,
      txt: null,
      active: false,
      age: 0,
      dur: 1,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      ax: 0,
      ay: 0,
      s0: 1,
      s1: 1,
      a0: 1,
      a1: 0,
      rot: 0,
      vrot: 0,
      frames: null,
      frameMs: 0,
      eased: false,
      delay: 0,
    };
  }

  private acquireImage(): FxItem {
    for (const it of this.images) if (!it.active) return it;
    if (this.images.length < MAX_IMAGES) {
      const it = this.newItem();
      const img = this.scene.add.image(0, 0, ATLAS_KEY);
      this.rig.registerWorld(img);
      img.setVisible(false);
      img.setDepth(DEPTH_FX);
      it.img = img;
      this.images.push(it);
      return it;
    }
    // pool saturé : on recycle en rotation (le plus ancien effet est sacrifié)
    const it = this.images[this.nextImg];
    this.nextImg = (this.nextImg + 1) % this.images.length;
    return it;
  }

  private acquireText(): FxItem {
    for (const it of this.texts) if (!it.active) return it;
    if (this.texts.length < MAX_TEXTS) {
      const it = this.newItem();
      const txt = makeWorldText(this.scene, this.zoom, '', { size: 7, originY: 0.5 });
      this.rig.registerWorld(txt);
      txt.setVisible(false);
      txt.setDepth(DEPTH_FX + 10);
      it.txt = txt;
      this.texts.push(it);
      return it;
    }
    const it = this.texts[this.nextTxt];
    this.nextTxt = (this.nextTxt + 1) % this.texts.length;
    return it;
  }

  /** Lance un effet sprite. */
  sprite(spec: SpriteFxSpec): void {
    const it = this.acquireImage();
    const img = it.img;
    if (!img) return;
    it.active = true;
    it.age = 0;
    it.dur = Math.max(1, spec.dur);
    it.x = spec.x;
    it.y = spec.y;
    it.vx = spec.vx ?? 0;
    it.vy = spec.vy ?? 0;
    it.ax = spec.ax ?? 0;
    it.ay = spec.ay ?? 0;
    it.s0 = spec.s0 ?? 1;
    it.s1 = spec.s1 ?? it.s0;
    it.a0 = spec.a0 ?? 1;
    it.a1 = spec.a1 ?? 0;
    it.rot = spec.rot ?? 0;
    it.vrot = spec.vrot ?? 0;
    it.frames = spec.frames ?? null;
    it.frameMs = spec.frameMs ?? 0;
    it.eased = spec.eased ?? false;
    it.delay = spec.delay && spec.delay > 0 ? spec.delay : 0;
    const first = spec.frames && spec.frames.length > 0 ? spec.frames[0] : spec.frame;
    img.setTexture(spec.key ?? ATLAS_KEY, first);
    img.clearTint();
    if (spec.tint !== undefined) {
      if (spec.fill) img.setTintFill(spec.tint);
      else img.setTint(spec.tint);
    }
    img.setBlendMode(spec.additive ? 1 : 0); // 1 = ADD, 0 = NORMAL
    img.setDepth(spec.depth ?? DEPTH_FX);
    img.setPosition(it.x, it.y);
    img.setScale(it.s0);
    img.setRotation(it.rot);
    img.setAlpha(it.a0);
    img.setVisible(it.delay <= 0);
  }

  /** Lance un nombre/texte flottant (monte et s'estompe). */
  floatText(x: number, y: number, str: string, color: number, durMs = 700, rise = 16, size = 7): void {
    const it = this.acquireText();
    const txt = it.txt;
    if (!txt) return;
    it.active = true;
    it.age = 0;
    it.dur = durMs;
    it.x = x;
    it.y = y;
    it.vx = 0;
    it.vy = -rise / (durMs / 1000);
    it.ax = 0;
    it.ay = 0;
    it.s0 = 1;
    it.s1 = 1;
    it.a0 = 1;
    it.a1 = 0;
    it.eased = true;
    it.frames = null;
    txt.setText(str);
    txt.setColor(hex(color));
    txt.setFontSize(Math.max(8, Math.round(size * this.zoom)));
    txt.setPosition(x, y);
    txt.setAlpha(1);
    txt.setVisible(true);
  }

  // ── effets nommés ──

  /** Étincelle d'impact (3 frames). */
  hit(x: number, y: number): void {
    this.sprite({ x, y, dur: 210, frames: [hitFrame(0), hitFrame(1), hitFrame(2)], frameMs: 70, a1: 1 });
  }

  /** Nombre de dégâts flottant. `big` pour les coups reçus par un joueur. */
  damageNumber(x: number, y: number, damage: number, color: number, big = false): void {
    this.floatText(x + this.rng.range(-3, 3), y - 6, damageNumberText(damage), color, big ? 850 : 650, big ? 20 : 15, big ? 9 : 7);
  }

  /** Éclaboussure de particules carrées. */
  burst(x: number, y: number, count: number, color: number, speed = 60, durMs = 420, gravity = 90, size = 1): void {
    for (let i = 0; i < count; i++) {
      const a = this.rng.range(0, Math.PI * 2);
      const v = this.rng.range(speed * 0.35, speed);
      this.sprite({
        x,
        y,
        dur: durMs * this.rng.range(0.7, 1.15),
        key: FX_PIXEL_KEY,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v - speed * 0.25,
        ay: gravity,
        s0: size * this.rng.range(0.8, 1.6),
        s1: 0.3,
        a0: 1,
        a1: 0,
        tint: color,
      });
    }
  }

  /** Halo qui grossit et s'estompe (onde de choc, activation d'un mécanisme). */
  ring(x: number, y: number, color: number, radius = 18, durMs = 380, additive = true): void {
    const s1 = radius / 32;
    this.sprite({ x, y, dur: durMs, key: FX_GLOW_KEY, s0: s1 * 0.25, s1, a0: 0.9, a1: 0, tint: color, additive, eased: true, depth: DEPTH_FX - 1 });
  }

  /** Étincelles montantes (ramassage, validation). */
  sparkles(x: number, y: number, color: number, count = 8, spread = 8): void {
    for (let i = 0; i < count; i++) {
      this.sprite({
        x: x + this.rng.range(-spread, spread),
        y: y + this.rng.range(-spread * 0.5, spread * 0.5),
        dur: this.rng.range(450, 800),
        key: FX_PIXEL_KEY,
        vy: -this.rng.range(14, 34),
        vx: this.rng.range(-6, 6),
        s0: this.rng.range(0.8, 1.5),
        s1: 0.2,
        tint: color,
        additive: true,
      });
    }
  }

  /** Nuage de poussière (ouverture de porte, atterrissage). */
  dust(x: number, y: number, count = 6, spread = 8): void {
    for (let i = 0; i < count; i++) {
      this.sprite({
        x: x + this.rng.range(-spread, spread),
        y: y + this.rng.range(-spread * 0.4, spread * 0.4),
        dur: this.rng.range(380, 620),
        key: FX_PIXEL_KEY,
        vx: this.rng.range(-18, 18),
        vy: -this.rng.range(4, 18),
        ay: 10,
        s0: this.rng.range(1.5, 2.6),
        s1: 0.8,
        a0: 0.7,
        a1: 0,
        tint: 0xc9c2b4,
      });
    }
  }

  /** Mort d'un ennemi : silhouette blanche qui s'élève + éclats. Les boss explosent en grand. */
  enemyDeath(x: number, y: number, kind: EnemyKind, boss: boolean): void {
    const color = enemyDeathColor(kind);
    this.sprite({ x, y: y - 2, dur: boss ? 600 : 280, frame: enemyFrame(kind, 0), tint: 0xffffff, fill: true, vy: -22, a0: 1, a1: 0, depth: DEPTH_FX - 2 });
    this.burst(x, y, boss ? 46 : 10, color, boss ? 140 : 70, boss ? 800 : 450, 110, boss ? 1.4 : 1);
    this.burst(x, y, boss ? 18 : 4, 0xffffff, boss ? 100 : 50, 380, 60, 1);
    this.ring(x, y, color, boss ? 64 : 20, boss ? 700 : 320);
    if (boss) this.hit(x, y);
  }

  /** Apparition d'un ennemi. */
  spawnPoof(x: number, y: number, color = 0xffffff): void {
    this.ring(x, y, color, 16, 300);
    this.burst(x, y, 6, color, 30, 360, -10);
  }

  /** Relevage terminé : étoile d'animation + étincelles vertes + anneau. */
  reviveBurst(x: number, y: number): void {
    this.sprite({ x, y: y - 4, dur: 560, frames: [reviveFrame(0), reviveFrame(1), reviveFrame(2), reviveFrame(3)], frameMs: 140, vy: -10, a0: 1, a1: 0.6 });
    this.sparkles(x, y - 2, 0x7dffb0, 14, 9);
    this.ring(x, y, 0x7dffb0, 26, 520);
  }

  /** Joueur à terre : anneau rouge et éclats. */
  downBurst(x: number, y: number): void {
    this.ring(x, y, 0xff4058, 28, 500);
    this.burst(x, y, 12, 0xff5a5a, 55, 500, 80);
  }

  /** Plaques/leviers : onde de couleur. */
  pulse(x: number, y: number, color: number): void {
    this.ring(x, y, color, 20, 360);
    this.sparkles(x, y, color, 5, 6);
  }

  /** Confettis colorés (fin de niveau) sur une zone `w` de large autour de (cx, cy). */
  confetti(cx: number, cy: number, w: number, count = 40): void {
    const colors = [0xf5c53d, 0xff5a5a, 0x4aa3ff, 0x5be37d, 0xe05aff, 0xffffff];
    for (let i = 0; i < count; i++) {
      this.sprite({
        x: cx + this.rng.range(-w / 2, w / 2),
        y: cy - this.rng.range(0, 30),
        dur: this.rng.range(1100, 1900),
        key: FX_PIXEL_KEY,
        vx: this.rng.range(-20, 20),
        vy: this.rng.range(-30, 10),
        ay: 55,
        s0: this.rng.range(1, 2),
        s1: 1,
        a0: 1,
        a1: 0.2,
        rot: this.rng.range(0, 3),
        vrot: this.rng.range(-8, 8),
        tint: colors[Math.floor(this.rng.range(0, colors.length))],
      });
    }
  }

  // ── cycle de vie ──

  /** Avance tous les effets actifs de `dtMs` ms. Aucune allocation. */
  update(dtMs: number): void {
    const dt = dtMs > 0 ? Math.min(dtMs, 100) : 0;
    const ds = dt / 1000;
    for (let i = 0; i < this.images.length; i++) {
      const it = this.images[i];
      if (!it.active || !it.img) continue;
      if (it.delay > 0) {
        it.delay -= dt;
        if (it.delay > 0) continue;
        it.img.setVisible(true);
      }
      it.age += dt;
      if (it.age >= it.dur) {
        it.active = false;
        it.img.setVisible(false);
        continue;
      }
      const t = it.age / it.dur;
      it.vx += it.ax * ds;
      it.vy += it.ay * ds;
      it.x += it.vx * ds;
      it.y += it.vy * ds;
      it.rot += it.vrot * ds;
      const img = it.img;
      img.setPosition(it.x, it.y);
      img.setScale(fxLerp(it.s0, it.s1, it.eased ? easeOutCubic(t) : t));
      img.setAlpha(fxLerp(it.a0, it.a1, it.eased ? easeOutCubic(t) * 0.9 + t * 0.1 : t));
      img.setRotation(it.rot);
      if (it.frames) img.setFrame(fxFrameAt(it.frames, it.age, it.frameMs));
    }
    for (let i = 0; i < this.texts.length; i++) {
      const it = this.texts[i];
      if (!it.active || !it.txt) continue;
      it.age += dt;
      if (it.age >= it.dur) {
        it.active = false;
        it.txt.setVisible(false);
        continue;
      }
      const t = it.age / it.dur;
      it.y += it.vy * ds;
      it.txt.setPosition(it.x, it.y);
      // visible plein pendant la première moitié, puis fondu
      it.txt.setAlpha(t < 0.55 ? 1 : 1 - (t - 0.55) / 0.45);
    }
  }

  /** Nombre d'effets actifs (tests/debug). */
  activeCount(): number {
    let n = 0;
    for (const it of this.images) if (it.active) n++;
    for (const it of this.texts) if (it.active) n++;
    return n;
  }

  /** Arrête tous les effets (changement de salle). */
  clear(): void {
    for (const it of this.images) {
      it.active = false;
      it.img?.setVisible(false);
    }
    for (const it of this.texts) {
      it.active = false;
      it.txt?.setVisible(false);
    }
  }

  /** Détruit les objets Phaser du pool. */
  destroy(): void {
    for (const it of this.images) it.img?.destroy();
    for (const it of this.texts) it.txt?.destroy();
    this.images.length = 0;
    this.texts.length = 0;
  }
}
