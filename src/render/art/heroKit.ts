/**
 * Boîte à outils de dessin des héros : gabarit « Humanoid » paramétrique (tête, torse, bras, jambes,
 * vues avant / arrière / côté droit, foulée à 2 frames, pose d'attaque) + armes en matrices de caractères.
 *
 * Convention de dessin : toile 16×16, contenu dans x ∈ [1, 14], y ∈ [1, 14] (le contour auto de 1 px
 * est ajouté ensuite autour). Les pieds reposent sur y = 14.
 */
import { EYE, WHITE, type HeroColors } from '../palettes';
import { Bitmap, CLEAR, type ColorMap } from './bitmap';

export type HeroView = 'down' | 'up' | 'right';
/** 0/1 = frames de marche, 'attack' = pose d'attaque. */
export type HeroPose = 0 | 1 | 'attack';

export interface Build {
  headW: number;
  headH: number;
  torsoW: number;
  torsoH: number;
  legH: number;
  /** Nombre de rangées de la tête qui recouvrent le haut du torse (dos voûté). */
  overlap: number;
  /** Largeur d'une jambe (défaut : (torsoW-1)/2 arrondi bas). */
  legW?: number;
  /** Décalage horizontal global du corps (px), pour laisser la place d'une arme large. */
  shiftX?: number;
}

/** Table lettre → couleur des matrices de sprites d'un héros. */
export function heroLetters(c: HeroColors): ColorMap {
  return {
    s: c.skin, t: c.skinShade, h: c.hair, H: c.hairShade,
    a: c.main, A: c.mainShade, c: c.cloak, C: c.cloakShade,
    y: c.trim, Y: c.trimShade, p: c.pants, b: c.boots,
    m: c.metal, M: c.metalShade, w: c.wood, W: c.woodShade,
    g: c.glow, G: c.glowShade, e: EYE, '#': WHITE,
  };
}

/** Rotation d'un point (x,y) d'une matrice w×h de k quarts de tour horaires. */
export function rotPoint(x: number, y: number, w: number, h: number, k: number): [number, number] {
  switch (((k % 4) + 4) % 4) {
    case 1: return [h - 1 - y, x];
    case 2: return [w - 1 - x, h - 1 - y];
    case 3: return [y, w - 1 - x];
    default: return [x, y];
  }
}

/** Corps humanoïde paramétrique + primitives de dessin décalées (lunge d'attaque). */
export class Humanoid {
  readonly c = new Bitmap(16, 16);
  readonly L: ColorMap;
  ox = 0;
  oy = 0;
  tx0 = 0; tx1 = 0; ty0 = 0; ty1 = 0;
  hx0 = 0; hx1 = 0; hy0 = 0; hy1 = 0;
  legY0 = 0;

  constructor(
    readonly col: HeroColors,
    readonly view: HeroView,
    readonly pose: HeroPose,
    readonly b: Build,
  ) {
    this.L = heroLetters(col);
    const tw = view === 'right' ? Math.max(4, b.torsoW - 2) : b.torsoW;
    const sx = b.shiftX ?? 0;
    this.tx0 = 8 - tw / 2 + sx;
    this.tx1 = this.tx0 + tw - 1;
    this.ty1 = 14 - b.legH;
    this.ty0 = this.ty1 - b.torsoH + 1;
    this.legY0 = this.ty1 + 1;
    this.hy1 = this.ty0 - 1 + b.overlap;
    this.hy0 = this.hy1 - b.headH + 1;
    this.hx0 = 8 - b.headW / 2 + sx;
    this.hx1 = this.hx0 + b.headW - 1;
    if (pose === 'attack' && view === 'right') this.ox = 1;
  }

  get attack(): boolean {
    return this.pose === 'attack';
  }
  get step(): number {
    return this.pose === 1 ? 1 : 0;
  }
  /** Colonne centrale du torse. */
  get cx(): number {
    return Math.floor((this.tx0 + this.tx1) / 2);
  }

  put(x: number, y: number, c: number): void {
    this.c.set(x + this.ox, y + this.oy, c);
  }
  box(x0: number, y0: number, x1: number, y1: number, c: number): void {
    this.c.box(x0 + this.ox, y0 + this.oy, x1 + this.ox, y1 + this.oy, c);
  }
  hline(x0: number, x1: number, y: number, c: number): void {
    this.c.hline(x0 + this.ox, x1 + this.ox, y + this.oy, c);
  }
  vline(x: number, y0: number, y1: number, c: number): void {
    this.c.vline(x + this.ox, y0 + this.oy, y1 + this.oy, c);
  }
  line(x0: number, y0: number, x1: number, y1: number, c: number): void {
    this.c.line(x0 + this.ox, y0 + this.oy, x1 + this.ox, y1 + this.oy, c);
  }
  stamp(rows: readonly string[], x: number, y: number): void {
    this.c.stamp(rows, this.L, x + this.ox, y + this.oy);
  }
  /** Efface un pixel (coins arrondis). */
  clear(x: number, y: number): void {
    this.put(x, y, CLEAR);
  }

  /** Jambes avec foulée : pose 0/1 = un pied levé ; attaque = jambes écartées. */
  legs(opts: { pants?: number; boots?: number } = {}): void {
    const { b } = this;
    const pants = opts.pants ?? this.col.pants;
    const boots = opts.boots ?? this.col.boots;
    const y0 = this.legY0;
    if (this.view === 'right') {
      const lw = b.legW ? b.legW - 1 : 2;
      const sx = b.shiftX ?? 0;
      const apart = this.attack || this.step === 0;
      const backX = (apart ? 5 : 6) + sx;
      const frontX = (apart ? 9 : 8) + sx;
      const backBottom = this.attack ? 14 : this.step === 0 ? 13 : 14;
      const frontBottom = this.attack ? 14 : this.step === 0 ? 14 : 13;
      this.leg(backX, backX + lw - 1, backBottom, pants, boots, y0);
      this.leg(frontX, frontX + lw - 1, frontBottom, pants, boots, y0);
      return;
    }
    const lw = b.legW ?? Math.floor((b.torsoW - 1) / 2);
    const leftRaised = !this.attack && this.step === 1;
    const rightRaised = !this.attack && this.step === 0;
    this.hline(this.tx0, this.tx1, y0, pants);
    this.leg(this.tx0, this.tx0 + lw - 1, leftRaised ? 13 : 14, pants, boots, y0);
    this.leg(this.tx1 - lw + 1, this.tx1, rightRaised ? 13 : 14, pants, boots, y0);
  }

  private leg(x0: number, x1: number, bottom: number, pants: number, boots: number, top: number): void {
    for (let y = top; y < bottom; y++) this.hline(x0, x1, y, pants);
    this.hline(x0, x1, bottom, boots);
  }

  /** Torse rectangulaire (ombre sur la colonne droite et la rangée basse). */
  torso(main = this.col.main, shade = this.col.mainShade): void {
    this.box(this.tx0, this.ty0, this.tx1, this.ty1, main);
    this.vline(this.tx1, this.ty0 + 1, this.ty1, shade);
    this.hline(this.tx0 + 1, this.tx1, this.ty1, shade);
  }

  /** Bras le long du corps (vues avant/arrière) ou bras de balancier (vue de côté). */
  arms(sleeve: number, hand: number = this.col.skin, opts: { left?: boolean; right?: boolean } = {}): void {
    const bottom = this.ty1 - 1;
    if (this.view === 'right') {
      const x = this.attack ? this.cx + 1 : this.cx + (this.step === 0 ? 1 : -1);
      this.vline(x, this.ty0 + 1, bottom - 1, sleeve);
      this.put(x, bottom, hand);
      return;
    }
    if (opts.left !== false) {
      this.vline(this.tx0 - 1, this.ty0 + 1, bottom - 1, sleeve);
      this.put(this.tx0 - 1, bottom, hand);
    }
    if (opts.right !== false) {
      this.vline(this.tx1 + 1, this.ty0 + 1, bottom - 1, sleeve);
      this.put(this.tx1 + 1, bottom, hand);
    }
  }

  /** Position (absolue, lunge inclus) de la main « arme » : écran droit en vues avant/arrière, avant en vue de côté. */
  hand(): [number, number] {
    const bottom = this.ty1 - 1;
    if (this.view === 'right') {
      const x = this.attack ? this.cx + 1 : this.cx + (this.step === 0 ? 1 : -1);
      return [x + this.ox, bottom + this.oy];
    }
    return [this.tx1 + 1 + this.ox, bottom + this.oy];
  }

  /** Visage de base (peau, yeux) — sans cheveux ni coiffe. */
  face(): void {
    const { hx0, hx1, hy0, hy1, view, col } = this;
    this.box(hx0, hy0, hx1, hy1, col.skin);
    this.clear(hx0, hy0);
    this.clear(hx1, hy0);
    this.clear(hx0, hy1);
    this.clear(hx1, hy1);
    this.hline(hx0 + 1, hx1 - 1, hy1, col.skinShade);
    const ey = hy0 + Math.max(2, this.b.headH - 3);
    if (view === 'down') {
      const inset = this.b.headW >= 8 ? 2 : 1;
      this.put(hx0 + inset, ey, EYE);
      this.put(hx1 - inset, ey, EYE);
    } else if (view === 'right') {
      this.vline(hx0, hy0 + 1, hy1 - 1, col.skinShade);
      this.put(hx1 - 1, ey, EYE);
      this.put(hx1 + 1, ey + 1, col.skin); // nez
    }
  }

  /** Chevelure courte : calotte + frange (avant), tout (arrière), arrière-crâne (côté). */
  hairShort(hair = this.col.hair, shade = this.col.hairShade): void {
    const { hx0, hx1, hy0, view } = this;
    if (view === 'down') {
      this.hline(hx0 + 1, hx1 - 1, hy0, hair);
      this.hline(hx0, hx1, hy0 + 1, hair);
      this.put(hx0, hy0 + 2, hair);
      this.put(hx1, hy0 + 2, hair);
      this.hline(hx0 + 1, hx0 + 2, hy0 + 2, hair);
      this.hline(hx1 - 2, hx1 - 1, hy0 + 2, hair);
      this.put(hx0, hy0 + 3, shade);
      this.put(hx1, hy0 + 3, shade);
    } else if (view === 'up') {
      this.box(hx0, hy0, hx1, this.hy1 - 1, hair);
      this.clear(hx0, hy0);
      this.clear(hx1, hy0);
      this.hline(hx0 + 1, hx1 - 1, this.hy1 - 1, shade);
      this.hline(hx0 + 1, hx1 - 1, this.hy1, this.col.skinShade);
    } else {
      this.hline(hx0 + 1, hx1 - 1, hy0, hair);
      this.hline(hx0, hx1 - 1, hy0 + 1, hair);
      this.box(hx0, hy0 + 2, hx0 + 2, hy0 + 3, hair);
      this.put(hx0, hy0 + 4, shade);
    }
  }
}

// ───────────────────────────── Armes & accessoires (matrices pointant vers le haut) ─────────────────────────────

/** Dépose une matrice (pointant vers le haut) tournée de k quarts de tour, la poignée (gx,gy) sur `at`. */
export function weapon(h: Humanoid, rows: readonly string[], grip: [number, number], k: number, at: [number, number]): void {
  const bm = Bitmap.fromRows(rows, h.L);
  const rot = bm.rotate(k);
  const [rx, ry] = rotPoint(grip[0], grip[1], bm.w, bm.h, k);
  // la matrice doit rester entière dans [1, 14] (le contour de 1 px est ajouté ensuite)
  const x0 = Math.max(1, Math.min(15 - rot.w, at[0] - rx));
  const y0 = Math.max(1, Math.min(15 - rot.h, at[1] - ry));
  h.c.blit(rot, x0, y0);
}

/** Arc dessiné par code, ouvert vers la droite : longueur, creux, bois, ombre, poignée, corde. */
export function bowBitmap(len: number, bulge: number, wood: number, shade: number, grip: number, string: number): Bitmap {
  const bm = new Bitmap(bulge + 1, len);
  const limbX = (t: number) => Math.round(bulge * (1 - Math.sin((Math.PI * (t + 0.5)) / len)));
  for (let t = 0; t < len; t++) {
    bm.set(bulge, t, string);
    bm.set(limbX(t), t, t >= len / 2 ? shade : wood);
  }
  const mid = Math.floor(len / 2);
  for (let t = mid - 1; t <= mid; t++) bm.set(limbX(t), t, grip);
  return bm;
}

export const SWORD = [
  '..m.',
  '.mM.',
  '.mM.',
  '.mM.',
  '.mM.',
  '.mM.',
  'yyyy',
  '.wW.',
  '.yY.',
];

export const SHIELD = ['yyyy', 'yccy', 'ycCy', 'yccy', '.yy.'];

export const STAFF = [
  '.gg.',
  'g#gG',
  '.GG.',
  '..w.',
  '..w.',
  '..w.',
  '..w.',
  '..w.',
  '..w.',
  '..W.',
  '..W.',
  '..W.',
];

export const DAGGER = ['m', 'm', 'M', 'y', 'w'];
export const BLADE = ['m', 'm', 'M', 'y', 'w'];

export const AXE = [
  '..mM',
  'Mwmm',
  '.wmm',
  '.wmM',
  '.w..',
  '.w..',
  '.w..',
  '.w..',
  '.w..',
  '.W..',
  '.W..',
];

export const CLUB = [
  '.ww.',
  'wMww',
  'wwMw',
  'wwww',
  '.ww.',
  '.ww.',
  '.ww.',
  '.W..',
  '.W..',
];

/** Pose d'une arme tenue (marche) ou tendue (attaque) : point d'ancrage de la poignée + quarts de tour. */
export function weaponPose(h: Humanoid, dxWalk = 0, dyWalk = 0): { at: [number, number]; k: number } {
  const [hx, hy] = h.hand();
  if (!h.attack) return { at: [hx + dxWalk, hy + dyWalk], k: 0 };
  switch (h.view) {
    case 'down': return { at: [hx, hy - 1], k: 2 };
    case 'up': return { at: [hx, hy - 2], k: 0 };
    default: return { at: [hx + 1, hy - 1], k: 1 };
  }
}
