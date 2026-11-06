/**
 * Bitmap : petite toile de pixels indexés en couleur 0xRRGGBB (−1 = transparent).
 * PUR : aucun accès DOM / Phaser. Sert à dessiner les sprites placeholder par code.
 *
 * Toutes les opérations ignorent silencieusement les pixels hors toile (clipping).
 */

/** Valeur d'un pixel transparent. */
export const CLEAR = -1;

/** Correspondance lettre → couleur pour les matrices de caractères ('.' et ' ' = transparent). */
export type ColorMap = Readonly<Record<string, number>>;

export class Bitmap {
  readonly w: number;
  readonly h: number;
  readonly px: Int32Array;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.px = new Int32Array(w * h).fill(CLEAR);
  }

  /** Construit une bitmap depuis des lignes de caractères et une table lettre → couleur. */
  static fromRows(rows: readonly string[], map: ColorMap): Bitmap {
    const h = rows.length;
    const w = rows.reduce((m, r) => Math.max(m, r.length), 0);
    const b = new Bitmap(w, h);
    b.stamp(rows, map, 0, 0);
    return b;
  }

  clone(): Bitmap {
    const b = new Bitmap(this.w, this.h);
    b.px.set(this.px);
    return b;
  }

  inside(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  get(x: number, y: number): number {
    return this.inside(x, y) ? this.px[y * this.w + x] : CLEAR;
  }

  /** Pose un pixel (couleur −1 = efface). */
  set(x: number, y: number, c: number): void {
    x = Math.floor(x);
    y = Math.floor(y);
    if (this.inside(x, y)) this.px[y * this.w + x] = c;
  }

  /** Pose un pixel uniquement si la case est encore transparente. */
  setBehind(x: number, y: number, c: number): void {
    if (this.get(x, y) === CLEAR) this.set(x, y, c);
  }

  rect(x: number, y: number, w: number, h: number, c: number): void {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c);
  }

  /** Rectangle défini par ses bornes incluses (x0..x1, y0..y1). */
  box(x0: number, y0: number, x1: number, y1: number, c: number): void {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.set(x, y, c);
  }

  hline(x0: number, x1: number, y: number, c: number): void {
    for (let x = x0; x <= x1; x++) this.set(x, y, c);
  }

  vline(x: number, y0: number, y1: number, c: number): void {
    for (let y = y0; y <= y1; y++) this.set(x, y, c);
  }

  /** Cadre 1 px (bornes incluses). */
  frame(x0: number, y0: number, x1: number, y1: number, c: number): void {
    this.hline(x0, x1, y0, c);
    this.hline(x0, x1, y1, c);
    this.vline(x0, y0, y1, c);
    this.vline(x1, y0, y1, c);
  }

  /** Ligne de Bresenham. */
  line(x0: number, y0: number, x1: number, y1: number, c: number): void {
    x0 = Math.round(x0);
    y0 = Math.round(y0);
    x1 = Math.round(x1);
    y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.set(x0, y0, c);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
  }

  /** Ellipse pleine (centre en coordonnées flottantes, rayons flottants). */
  ellipse(cx: number, cy: number, rx: number, ry: number, c: number): void {
    const x0 = Math.floor(cx - rx - 1);
    const x1 = Math.ceil(cx + rx + 1);
    const y0 = Math.floor(cy - ry - 1);
    const y1 = Math.ceil(cy + ry + 1);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = (x + 0.5 - cx) / rx;
        const dy = (y + 0.5 - cy) / ry;
        if (dx * dx + dy * dy <= 1) this.set(x, y, c);
      }
    }
  }

  /**
   * Ellipse ombrée « cel-shading » (3 aplats, sans dégradé ni dither) : lumière venant du haut-gauche.
   * hi = reflet, base = teinte, shade = ombre.
   */
  shadedEllipse(
    cx: number,
    cy: number,
    rx: number,
    ry: number,
    cols: { hi: number; base: number; shade: number },
    light: { x: number; y: number } = { x: -0.55, y: -0.75 },
  ): void {
    const x0 = Math.floor(cx - rx - 1);
    const x1 = Math.ceil(cx + rx + 1);
    const y0 = Math.floor(cy - ry - 1);
    const y1 = Math.ceil(cy + ry + 1);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = (x + 0.5 - cx) / rx;
        const dy = (y + 0.5 - cy) / ry;
        if (dx * dx + dy * dy > 1) continue;
        const v = -(dx * light.x + dy * light.y);
        const col = v > 0.55 ? cols.hi : v > -0.15 ? cols.base : cols.shade;
        this.set(x, y, col);
      }
    }
  }

  /** Polygone plein (remplissage par balayage, règle pair-impair) sur les centres de pixels. */
  polygon(pts: ReadonlyArray<readonly [number, number]>, c: number): void {
    if (pts.length < 3) return;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of pts) {
      minY = Math.min(minY, p[1]);
      maxY = Math.max(maxY, p[1]);
    }
    for (let y = Math.floor(minY); y <= Math.ceil(maxY); y++) {
      const sy = y + 0.5;
      const xs: number[] = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        if ((a[1] <= sy && b[1] > sy) || (b[1] <= sy && a[1] > sy)) {
          xs.push(a[0] + ((sy - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
        }
      }
      xs.sort((p, q) => p - q);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        for (let x = Math.ceil(xs[i] - 0.5); x <= Math.floor(xs[i + 1] - 0.5); x++) this.set(x, y, c);
      }
    }
  }

  /**
   * Dépose une matrice de caractères à (ox, oy). '.' et ' ' = transparent (ne touche pas le fond).
   * Lettre inconnue de la table : erreur (détecte les fautes de frappe dans les sprites).
   */
  stamp(rows: readonly string[], map: ColorMap, ox: number, oy: number): void {
    for (let j = 0; j < rows.length; j++) {
      const row = rows[j];
      for (let i = 0; i < row.length; i++) {
        const ch = row[i];
        if (ch === '.' || ch === ' ') continue;
        const col = map[ch];
        if (col === undefined) throw new Error(`Bitmap.stamp: lettre '${ch}' absente de la palette (ligne ${j}, col ${i})`);
        this.set(ox + i, oy + j, col);
      }
    }
  }

  /** Copie une autre bitmap par-dessus (les pixels transparents de la source sont ignorés). */
  blit(src: Bitmap, ox: number, oy: number): void {
    for (let j = 0; j < src.h; j++) {
      for (let i = 0; i < src.w; i++) {
        const c = src.px[j * src.w + i];
        if (c !== CLEAR) this.set(ox + i, oy + j, c);
      }
    }
  }

  /** Miroir horizontal (nouvelle bitmap). */
  flipH(): Bitmap {
    const b = new Bitmap(this.w, this.h);
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) b.px[y * this.w + (this.w - 1 - x)] = this.px[y * this.w + x];
    return b;
  }

  /** Rotation de k quarts de tour horaires (nouvelle bitmap, k ∈ 0..3). */
  rotate(k: number): Bitmap {
    k = ((k % 4) + 4) % 4;
    if (k === 0) return this.clone();
    const swap = k % 2 === 1;
    const b = swap ? new Bitmap(this.h, this.w) : new Bitmap(this.w, this.h);
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const c = this.px[y * this.w + x];
        let nx = x;
        let ny = y;
        if (k === 1) {
          nx = this.h - 1 - y;
          ny = x;
        } else if (k === 2) {
          nx = this.w - 1 - x;
          ny = this.h - 1 - y;
        } else {
          nx = y;
          ny = this.w - 1 - x;
        }
        b.px[ny * b.w + nx] = c;
      }
    }
    return b;
  }

  /** Décale tout le contenu de (dx, dy) (nouvelle bitmap, même taille). */
  shifted(dx: number, dy: number): Bitmap {
    const b = new Bitmap(this.w, this.h);
    b.blit(this, dx, dy);
    return b;
  }

  /**
   * Contour 1 px : toute case transparente voisine (4 ou 8 voisins) d'un pixel opaque devient `color`.
   * Les pixels existants ne sont jamais modifiés.
   */
  outline(color: number, eight = false): this {
    const add: number[] = [];
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (this.px[y * this.w + x] !== CLEAR) continue;
        let near = this.get(x - 1, y) !== CLEAR || this.get(x + 1, y) !== CLEAR || this.get(x, y - 1) !== CLEAR || this.get(x, y + 1) !== CLEAR;
        if (!near && eight) {
          near = this.get(x - 1, y - 1) !== CLEAR || this.get(x + 1, y - 1) !== CLEAR || this.get(x - 1, y + 1) !== CLEAR || this.get(x + 1, y + 1) !== CLEAR;
        }
        if (near) add.push(y * this.w + x);
      }
    }
    for (const i of add) this.px[i] = color;
    return this;
  }

  /** Remplace chaque couleur via une fonction (retourner −1 pour effacer). */
  recolor(fn: (c: number) => number): this {
    for (let i = 0; i < this.px.length; i++) if (this.px[i] !== CLEAR) this.px[i] = fn(this.px[i]);
    return this;
  }

  /** Remplace une couleur par une autre. */
  swap(from: number, to: number): this {
    for (let i = 0; i < this.px.length; i++) if (this.px[i] === from) this.px[i] = to;
    return this;
  }

  /** Nombre de pixels opaques. */
  count(): number {
    let n = 0;
    for (let i = 0; i < this.px.length; i++) if (this.px[i] !== CLEAR) n++;
    return n;
  }
}

/** Hachage déterministe 2D → [0, 1) (textures : fissures, mousse, cailloux). */
export function hash2(x: number, y: number, seed = 0): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}
