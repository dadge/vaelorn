/**
 * Voile d'obscurité des salles sombres (système de torches).
 *
 * Un `RenderTexture` unique, en espace monde, couvre toute la salle, au-dessus du monde et sous le HUD.
 * À chaque `update(lights, timeMs)` : il est rempli d'un noir bleuté quasi opaque (`DARK_COLORS`), puis chaque source
 * de lumière y EFFACE (blend ERASE) un pinceau pixel art en 4 à 6 paliers nets (pas de flou) ; les lueurs chaudes
 * (braseros, torches murales, torches de joueurs) ajoutent une très légère teinte orangée dans la zone éclairée.
 *
 * Intégration (GameScene) :
 *   const dark = new DarknessLayer(scene, room.width * TILE, room.height * TILE, { depth: DEPTH_DARKNESS });
 *   views.registerWorld(dark.object);                    // visible par les caméras joueur, ignoré par la caméra d'interface
 *   dark.update(lightSources(state, room), scene.time.now);   // chaque frame, salle sombre uniquement
 *   dark.destroy();                                      // au changement de salle / à l'arrêt de la scène
 *
 * Ce module est importable sous Node (Phaser n'est utilisé que par TYPE) : toute la partie « calcul » est pure
 * et testée dans darkness.test.ts (paliers du pinceau, scintillement, `lightAt`, échelle de texture).
 */
import type Phaser from 'phaser';
import { textureFilterMode } from './smoothing';
import type { LightKind, LightSource } from '../core/light';
import { DARK_COLORS } from './palettes';

export type { LightKind, LightSource } from '../core/light';

// ───────────────────────────── Paramètres ─────────────────────────────

/** Nombre maximal de sources dessinées par frame (au-delà : torches des joueurs d'abord, puis les plus proches d'eux). */
export const MAX_LIGHTS = 24;
/** Rayon maximal d'un pinceau (px de texture) : au-delà, le pinceau est plafonné. */
export const MAX_BRUSH_RADIUS = 640;
/** Rayon minimal d'un pinceau (px de texture). */
export const MIN_BRUSH_RADIUS = 4;
/** Taille maximale supposée d'une texture GPU (limite minimale garantie en pratique). */
export const DEFAULT_MAX_TEXTURE = 4096;
/** Amplitude relative maximale du scintillement (intensité 1 → ±10 % du rayon). */
export const FLICKER_AMPLITUDE = 0.1;
/** Période (ms) des deux composantes du scintillement (par paliers : pixel art). */
export const FLICKER_PERIOD_FAST_MS = 110;
export const FLICKER_PERIOD_SLOW_MS = 330;

/** Un palier du pinceau : de `outer` (px, rayon extérieur) vers l'intérieur ; `erase` = part du voile effacée (0..1). */
export interface LightBand {
  outer: number;
  erase: number;
}

/** Profils : fractions du rayon (bord extérieur de chaque palier, du centre vers le bord) et opacité d'effacement. */
const PROFILES: Readonly<Record<4 | 5 | 6, { outer: readonly number[]; erase: readonly number[] }>> = {
  4: { outer: [0.35, 0.62, 0.84, 1], erase: [1, 0.74, 0.44, 0.16] },
  5: { outer: [0.3, 0.52, 0.72, 0.88, 1], erase: [1, 0.82, 0.58, 0.34, 0.14] },
  6: { outer: [0.26, 0.44, 0.6, 0.76, 0.9, 1], erase: [1, 0.88, 0.7, 0.5, 0.3, 0.12] },
};

function profileFor(radiusPx: number): 4 | 5 | 6 {
  return radiusPx < 20 ? 4 : radiusPx < 64 ? 5 : 6;
}

// ───────────────────────────── Fonctions pures ─────────────────────────────

/**
 * Paliers du pinceau lumineux de rayon `radiusPx` : 4 paliers (petits rayons), 5 ou 6 (grands), du centre
 * (effacement total) vers le bord (très léger éclairage ambiant). Rayon invalide ou ≤ 0 → tableau vide.
 */
export function lightBrushBands(radiusPx: number): LightBand[] {
  if (!Number.isFinite(radiusPx) || radiusPx <= 0) return [];
  const p = PROFILES[profileFor(radiusPx)];
  return p.outer.map((f, i) => ({ outer: f * radiusPx, erase: p.erase[i] }));
}

/** Part du voile effacée (0..1) à la distance `distPx` du centre, pour des paliers donnés (0 au-delà du dernier). */
export function bandEraseAt(distPx: number, bands: readonly LightBand[]): number {
  for (const b of bands) if (distPx <= b.outer) return b.erase;
  return 0;
}

/**
 * Quantifie un rayon de pinceau (px de texture) pour limiter le nombre de textures en cache :
 * pas de 2 px sous 48 px, de 4 px au-delà ; borné à [MIN_BRUSH_RADIUS, MAX_BRUSH_RADIUS].
 */
export function quantizeBrushRadius(radiusPx: number): number {
  if (!Number.isFinite(radiusPx) || radiusPx <= 0) return 0;
  const step = radiusPx < 48 ? 2 : 4;
  const q = Math.round(radiusPx / step) * step;
  return Math.max(MIN_BRUSH_RADIUS, Math.min(MAX_BRUSH_RADIUS, q));
}

/**
 * Pixels RGBA d'un pinceau de rayon `radiusPx` (entier ≥ 1) : carré de côté 2×rayon, RVB blanc, alpha = part effacée
 * (paliers nets ; un damier d'un pixel adoucit la frontière entre deux paliers, pas le bord extérieur).
 */
export function brushPixels(radiusPx: number): { size: number; data: Uint8ClampedArray } {
  const R = Math.max(1, Math.round(radiusPx));
  const size = 2 * R;
  const bands = lightBrushBands(R);
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - R;
      const dy = y + 0.5 - R;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > R) continue;
      let k = 0;
      while (k < bands.length - 1 && d > bands[k].outer) k++;
      // damier sur 1 px autour de la frontière interne entre paliers k-1 | k | k+1
      if ((x + y) & 1) {
        if (k < bands.length - 1 && bands[k].outer - d < 1) k++;
        else if (k > 0 && d - bands[k - 1].outer < 1) k--;
      }
      const o = (y * size + x) * 4;
      data[o] = 255;
      data[o + 1] = 255;
      data[o + 2] = 255;
      data[o + 3] = Math.round(bands[k].erase * 255);
    }
  }
  return { size, data };
}

/** Hachage entier déterministe → [0, 1). */
function hash01(a: number, b: number): number {
  let h = Math.imul(Math.floor(a) | 0, 374761393) + Math.imul(Math.floor(b) | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * Rayon scintillant d'une flamme : fonction PURE et déterministe de (`base`, `timeMs`, `seed`) — deux composantes
 * à paliers (≈ 9 Hz et ≈ 3 Hz) pour un effet « pixel » sans lissage. `intensity` 0..1 (0 = stable, défaut 0,3) ;
 * l'écart reste dans ±FLICKER_AMPLITUDE × intensité × base. Entrées invalides tolérées (base ≤ 0 → 0).
 */
export function flickerRadius(base: number, timeMs: number, seed: number, intensity = 0.3): number {
  if (!Number.isFinite(base) || base <= 0) return 0;
  const k = Number.isFinite(intensity) ? Math.max(0, Math.min(1, intensity)) : 0;
  if (k === 0) return base;
  const t = Number.isFinite(timeMs) ? timeMs : 0;
  const s = Number.isFinite(seed) ? seed : 0;
  const fast = hash01(Math.floor(t / FLICKER_PERIOD_FAST_MS), s) * 2 - 1;
  const slow = hash01(Math.floor(t / FLICKER_PERIOD_SLOW_MS), s + 7919) * 2 - 1;
  const n = fast * 0.65 + slow * 0.35;
  return base * (1 + FLICKER_AMPLITUDE * k * n);
}

/**
 * Visibilité (0..1) d'un point : la plus forte part du voile effacée par une source (0 = noir complet, 1 = en pleine
 * lumière). Utilise les paliers du pinceau, sans scintillement : cohérent avec ce qui est affiché. Utilisable par le HUD
 * ou les ennemis (repérage dans le noir).
 */
export function lightAt(point: { x: number; y: number }, sources: readonly LightSource[]): number {
  let best = 0;
  for (const s of sources) {
    if (!(s.radius > 0)) continue;
    const dx = point.x - s.x;
    const dy = point.y - s.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > s.radius * s.radius) continue;
    const e = bandEraseAt(Math.sqrt(d2), lightBrushBands(s.radius));
    if (e > best) {
      best = e;
      if (best >= 1) break;
    }
  }
  return best;
}

/**
 * Échelle de résolution de la texture du voile (≤ 1) pour que la plus grande dimension tienne dans `maxTexture`
 * (rendu à résolution réduite puis agrandi, pixels plus gros). 1 = pleine résolution.
 */
export function darknessScale(widthPx: number, heightPx: number, maxTexture = DEFAULT_MAX_TEXTURE): number {
  const m = Math.max(widthPx, heightPx);
  if (!Number.isFinite(m) || m <= 0 || !Number.isFinite(maxTexture) || maxTexture <= 0) return 1;
  return m <= maxTexture ? 1 : maxTexture / m;
}

/** Teinte chaude et opacité (très faible) de la lueur d'une source, selon sa nature. */
export function lightGlow(kind: LightKind): { tint: number; alpha: number } {
  switch (kind) {
    case 'brazier':
      return { tint: DARK_COLORS.glowBrazier, alpha: 0.28 };
    case 'decor':
      return { tint: DARK_COLORS.glowDecor, alpha: 0.2 };
    default:
      return { tint: DARK_COLORS.glowTorch, alpha: 0.12 };
  }
}

/** Graine du scintillement d'une source : l'id du joueur pour une torche (elle bouge), la position sinon (stable). */
export function lightSeed(s: LightSource): number {
  if (s.kind === 'torch' && s.playerId !== undefined) return 1000 + s.playerId * 31;
  return Math.floor(hash01(Math.round(s.x), Math.round(s.y)) * 1e6);
}

// ───────────────────────────── Cache des pinceaux ─────────────────────────────

/**
 * Choisit les sources à dessiner quand il y en a plus que `max` (constat 5) : les sources invalides sont écartées, les
 * torches des joueurs sont TOUJOURS conservées, puis les autres sources par distance croissante au joueur le plus proche
 * (distance au bord du cercle : `distance - rayon`). Sans torche de joueur, l'ordre d'origine est conservé.
 * Renvoie `lights` tel quel (aucune allocation) quand `lights.length <= max`.
 */
export function selectLights(lights: readonly LightSource[], max: number = MAX_LIGHTS): readonly LightSource[] {
  if (lights.length <= max) return lights;
  const valid = lights.filter((l) => !!l && l.radius > 0 && Number.isFinite(l.x) && Number.isFinite(l.y));
  if (valid.length <= max) return valid;
  const anchors = valid.filter((l) => l.kind === 'torch' && l.playerId !== undefined);
  const others = valid.filter((l) => !(l.kind === 'torch' && l.playerId !== undefined));
  const keep = anchors.slice(0, max);
  const slots = max - keep.length;
  if (slots <= 0) return keep;
  if (anchors.length === 0) return others.slice(0, slots);
  const scored = others.map((l, index) => {
    let best = Infinity;
    for (const a of anchors) best = Math.min(best, Math.hypot(l.x - a.x, l.y - a.y));
    return { l, index, score: best - l.radius };
  });
  scored.sort((p, q) => p.score - q.score || p.index - q.index);
  for (let i = 0; i < slots && i < scored.length; i++) keep.push(scored[i].l);
  return keep;
}

/** Comptage de références des textures de pinceau, par gestionnaire de textures (partagées entre calques). */
const brushRefs = new WeakMap<Phaser.Textures.TextureManager, Map<string, number>>();

function brushKey(radius: number): string {
  return `darkbrush_${radius}`;
}

function acquireBrush(textures: Phaser.Textures.TextureManager, radius: number): void {
  const key = brushKey(radius);
  let refs = brushRefs.get(textures);
  if (!refs) brushRefs.set(textures, (refs = new Map()));
  const n = refs.get(key) ?? 0;
  if (n === 0 && !textures.exists(key)) {
    const { size, data } = brushPixels(radius);
    const tex = textures.createCanvas(key, size, size);
    const ctx = tex?.getContext();
    if (tex && ctx) {
      ctx.putImageData(new ImageData(new Uint8ClampedArray(data), size, size), 0, 0);
      tex.refresh();
      tex.setFilter(textureFilterMode() as Phaser.Textures.FilterMode);
    }
  }
  refs.set(key, n + 1);
}

function releaseBrush(textures: Phaser.Textures.TextureManager, radius: number): void {
  const key = brushKey(radius);
  const refs = brushRefs.get(textures);
  if (!refs) return;
  const n = (refs.get(key) ?? 0) - 1;
  if (n > 0) {
    refs.set(key, n);
    return;
  }
  refs.delete(key);
  if (textures.exists(key)) textures.remove(key);
}

// ───────────────────────────── Calque ─────────────────────────────

export interface DarknessOptions {
  /** Profondeur d'affichage (au-dessus du monde, sous le HUD). Défaut 500. */
  depth?: number;
  /** Échelle de résolution forcée (0 < s ≤ 1) ; défaut : automatique selon la taille de texture maximale. */
  scale?: number;
}

/** Nombre d'`update` sans usage au bout duquel un pinceau du cache de CE calque est libéré. */
const BRUSH_IDLE_TICKS = 600;
const PRUNE_EVERY = 240;

interface PendingLight {
  key: string;
  x: number;
  y: number;
  glowAlpha: number;
  glowTint: number;
}

/**
 * Calque d'obscurité d'une salle (voir l'en-tête du module). Un calque par salle ; `destroy()` libère le
 * RenderTexture ET les textures de pinceau (comptage de références : aucune fuite entre salles).
 */
export class DarknessLayer {
  private readonly scene: Phaser.Scene;
  private rt: Phaser.GameObjects.RenderTexture | null;
  private widthPx: number;
  private heightPx: number;
  private readonly fixedScale: number | null;
  private scale: number;
  private visible = true;
  private tick = 0;
  /** Pinceaux acquis par ce calque : rayon → dernier `tick` d'usage. */
  private readonly brushes = new Map<number, number>();
  private readonly onShutdown = (): void => this.destroy();

  /**
   * @param scene scène hôte
   * @param widthPx largeur de la salle en pixels monde
   * @param heightPx hauteur de la salle en pixels monde
   * @param opts profondeur (défaut 500) et échelle de résolution éventuelle
   */
  constructor(scene: Phaser.Scene, widthPx: number, heightPx: number, opts: DarknessOptions = {}) {
    this.scene = scene;
    this.widthPx = Math.max(1, Math.ceil(widthPx));
    this.heightPx = Math.max(1, Math.ceil(heightPx));
    this.fixedScale = opts.scale !== undefined && opts.scale > 0 ? Math.min(1, opts.scale) : null;
    this.scale = this.computeScale();
    const rt = scene.add.renderTexture(0, 0, Math.ceil(this.widthPx * this.scale), Math.ceil(this.heightPx * this.scale));
    rt.setOrigin(0, 0).setDepth(opts.depth ?? 500).setScale(1 / this.scale);
    rt.texture.setFilter(textureFilterMode() as Phaser.Textures.FilterMode);
    this.rt = rt;
    scene.events.once('shutdown', this.onShutdown);
  }

  /**
   * Le RenderTexture (objet du monde) : à enregistrer auprès des caméras (`registerWorld`) ; null après `destroy()`.
   */
  get object(): Phaser.GameObjects.RenderTexture | null {
    return this.rt;
  }

  /** Vrai tant que le calque n'est pas détruit. */
  get alive(): boolean {
    return this.rt !== null;
  }

  /** Échelle de résolution courante de la texture (1 = pleine résolution). */
  get resolutionScale(): number {
    return this.scale;
  }

  /** Nombre de pinceaux (textures) actuellement acquis par ce calque. */
  get brushCount(): number {
    return this.brushes.size;
  }

  private computeScale(): number {
    if (this.fixedScale !== null) return this.fixedScale;
    const r = this.scene.game?.renderer as { getMaxTextureSize?: () => number } | undefined;
    const max = typeof r?.getMaxTextureSize === 'function' ? r.getMaxTextureSize() : DEFAULT_MAX_TEXTURE;
    return darknessScale(this.widthPx, this.heightPx, Math.min(DEFAULT_MAX_TEXTURE, max || DEFAULT_MAX_TEXTURE));
  }

  /** Change la profondeur d'affichage. */
  setDepth(depth: number): this {
    this.rt?.setDepth(depth);
    return this;
  }

  /** Affiche / masque le voile (masqué : `update` ne dessine rien, pour économiser le GPU). */
  setVisible(visible: boolean): this {
    this.visible = visible;
    this.rt?.setVisible(visible);
    return this;
  }

  /** Redimensionne le calque (nouvelle salle de taille différente, réutilisation du même calque). */
  resize(widthPx: number, heightPx: number): this {
    if (!this.rt) return this;
    this.widthPx = Math.max(1, Math.ceil(widthPx));
    this.heightPx = Math.max(1, Math.ceil(heightPx));
    this.scale = this.computeScale();
    this.rt.resize(Math.ceil(this.widthPx * this.scale), Math.ceil(this.heightPx * this.scale));
    this.rt.setScale(1 / this.scale);
    this.releaseAll(); // les pinceaux dépendent de l'échelle : ils sont reconstruits à la demande
    return this;
  }

  /**
   * Redessine le voile : remplit de noir bleuté puis efface un pinceau par source (≤ MAX_LIGHTS), avec un scintillement
   * déterministe selon `timeMs`. Les sources sont en pixels MONDE (celles de `lightSources(state, room)`).
   */
  update(lights: readonly LightSource[], timeMs: number): void {
    const rt = this.rt;
    if (!rt || !this.visible) return;
    this.tick++;
    const s = this.scale;
    const maxX = this.widthPx * s;
    const maxY = this.heightPx * s;
    const pending: PendingLight[] = [];
    const chosen = selectLights(lights, MAX_LIGHTS);
    const n = chosen.length;
    for (let i = 0; i < n; i++) {
      const l = chosen[i];
      if (!l || !(l.radius > 0) || !Number.isFinite(l.x) || !Number.isFinite(l.y)) continue;
      const R = quantizeBrushRadius(flickerRadius(l.radius * s, timeMs, lightSeed(l), l.flicker ?? 0.3));
      if (R <= 0) continue;
      const cx = Math.round(l.x * s);
      const cy = Math.round(l.y * s);
      if (cx + R < 0 || cy + R < 0 || cx - R > maxX || cy - R > maxY) continue; // entièrement hors salle
      this.useBrush(R);
      const glow = lightGlow(l.kind);
      pending.push({ key: brushKey(R), x: cx - R, y: cy - R, glowAlpha: glow.alpha, glowTint: glow.tint });
    }

    rt.clear();
    rt.fill(DARK_COLORS.veil, DARK_COLORS.veilAlpha);
    if (pending.length > 0) {
      const webgl = !!(rt.texture as unknown as { renderTarget?: unknown }).renderTarget;
      if (webgl) {
        // WebGL : un seul lot pour l'effacement (union des pinceaux), un second pour les lueurs chaudes
        rt.beginDraw();
        for (const p of pending) rt.batchDrawFrame(p.key, undefined, p.x, p.y);
        rt.endDraw(true);
        rt.beginDraw();
        for (const p of pending) rt.batchDrawFrame(p.key, undefined, p.x, p.y, p.glowAlpha, p.glowTint);
        rt.endDraw(false);
      } else {
        // Canvas : effacement source par source (pas de teinte)
        for (const p of pending) {
          const frame = this.scene.textures.getFrame(p.key);
          if (frame) rt.erase(frame, p.x, p.y);
        }
      }
    }
    if (this.tick % PRUNE_EVERY === 0) this.pruneIdle();
  }

  private useBrush(radius: number): void {
    if (!this.brushes.has(radius)) acquireBrush(this.scene.textures, radius);
    this.brushes.set(radius, this.tick);
  }

  private pruneIdle(): void {
    for (const [r, last] of this.brushes) {
      if (this.tick - last > BRUSH_IDLE_TICKS) {
        releaseBrush(this.scene.textures, r);
        this.brushes.delete(r);
      }
    }
  }

  private releaseAll(): void {
    for (const r of this.brushes.keys()) releaseBrush(this.scene.textures, r);
    this.brushes.clear();
  }

  /** Détruit le RenderTexture et libère les textures de pinceau (idempotent). */
  destroy(): void {
    if (!this.rt) return;
    try {
      this.scene.events.off('shutdown', this.onShutdown);
    } catch {
      /* scène déjà détruite */
    }
    this.releaseAll();
    this.rt.destroy();
    this.rt = null;
  }
}
