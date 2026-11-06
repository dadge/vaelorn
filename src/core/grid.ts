import { TILE } from './constants';
import type { TileGlyph } from './types';

/**
 * Grille statique d'une salle (dérivée de RoomDef.layout). Ne fait PAS partie de GameState :
 * elle se reconstruit à l'identique depuis le niveau. Portes fermées et blocs sont gérés ailleurs
 * (mécanismes) et s'ajoutent à cette grille pour les collisions.
 */
export class RoomGrid {
  readonly width: number; // en tuiles
  readonly height: number; // en tuiles
  private readonly rows: string[];

  constructor(layout: readonly string[]) {
    this.rows = layout.slice();
    this.height = layout.length;
    this.width = layout.reduce((m, r) => Math.max(m, r.length), 0);
  }

  get pixelWidth(): number {
    return this.width * TILE;
  }
  get pixelHeight(): number {
    return this.height * TILE;
  }

  /** Glyphe à (tx,ty). Hors grille ou caractère inconnu → ' ' (vide, plein). */
  glyphAt(tx: number, ty: number): TileGlyph {
    if (ty < 0 || ty >= this.height || tx < 0) return ' ';
    const ch = this.rows[ty][tx];
    switch (ch) {
      case '#':
      case '.':
      case ',':
      case 'o':
      case '~':
        return ch;
      default:
        return ' ';
    }
  }

  isWall(tx: number, ty: number): boolean {
    const g = this.glyphAt(tx, ty);
    return g === '#' || g === 'o' || g === ' ';
  }

  isPit(tx: number, ty: number): boolean {
    return this.glyphAt(tx, ty) === '~';
  }

  /** Bloque le déplacement des personnages (mur, pilier, vide, fosse). */
  blocksMovement(tx: number, ty: number): boolean {
    return this.isWall(tx, ty) || this.isPit(tx, ty);
  }

  /** Bloque les projectiles (mur, pilier, vide) — pas les fosses. */
  blocksProjectile(tx: number, ty: number): boolean {
    return this.isWall(tx, ty);
  }

  /** Tuile contenant le point pixel (px,py). */
  tileAt(px: number, py: number): [number, number] {
    return [Math.floor(px / TILE), Math.floor(py / TILE)];
  }
}
