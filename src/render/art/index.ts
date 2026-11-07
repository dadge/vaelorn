/**
 * Point d'entrée de l'art placeholder : atlas runtime unique (clé 'atlas') généré par code.
 *
 *  - buildAtlasData() : PUR (aucun DOM) → pixels RGBA + rectangles des frames (testable sous Node).
 *  - buildAtlas(scene) : crée la texture Phaser 'atlas' (canvas + frames, filtre NEAREST). À appeler dans BootScene.
 *  - FRAME_NAMES / hasFrame / requiredFrames : contrat des noms (voir docs/DESIGN.md §4 et docs/SPRITES.md).
 *  - SPRITE_MANIFEST : sprites « à remplacer par de vrais assets pixel art ».
 *  - animations.ts : helpers purs de noms de frames (heroFrame, enemyFrame, tileFrame…).
 */
import type Phaser from 'phaser';
import { packAtlas, type AtlasData, type FrameRect } from './atlas';
import { ATLAS_KEY, EXTRA_FRAME_SPECS, requiredFrameSpecs, requiredFrames } from './contract';
import { buildAllFrames } from './frames';

export { ATLAS_KEY, requiredFrames, requiredFrameSpecs, EXTRA_FRAME_SPECS, RUNE_NAMES } from './contract';
export type { FrameSpec } from './contract';
export type { AtlasData, FrameRect } from './atlas';
export { SPRITE_MANIFEST, manifestCovers } from './manifest';
export type { SpriteManifestEntry } from './manifest';
export * from './animations';
export * from './enemyTiers';

/** Noms de toutes les frames de l'atlas (contrat DESIGN.md §4 + extras listées dans EXTRA_FRAME_SPECS). */
export const FRAME_NAMES: readonly string[] = Object.freeze([...requiredFrames(), ...EXTRA_FRAME_SPECS.map((s) => s.name)]);

const FRAME_SET: ReadonlySet<string> = new Set(FRAME_NAMES);

/** Vrai si `name` est une frame de l'atlas. */
export function hasFrame(name: string): boolean {
  return FRAME_SET.has(name);
}

/**
 * Construit l'atlas complet (déterministe : deux appels donnent exactement les mêmes octets).
 * Pur : n'accède ni au DOM ni à Phaser. `pixels` est en RGBA (alpha 0 ou 255 uniquement).
 */
export function buildAtlasData(): { width: number; height: number; pixels: Uint8ClampedArray; frames: Record<string, FrameRect> } {
  const data: AtlasData = packAtlas(buildAllFrames());
  return data;
}

/**
 * Crée la texture Phaser 'atlas' à partir des pixels générés : canvas 2D + `texture.add(frame…)`,
 * filtre NEAREST. Remplace proprement une texture 'atlas' déjà présente (rechargement à chaud).
 * Doit tourner dans un navigateur (utilise `document`).
 */
export function buildAtlas(scene: Phaser.Scene): void {
  const data = buildAtlasData();
  const textures = scene.textures;
  if (textures.exists(ATLAS_KEY)) textures.remove(ATLAS_KEY);
  const canvas = document.createElement('canvas');
  canvas.width = data.width;
  canvas.height = data.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('buildAtlas: contexte 2D indisponible');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(data.pixels), data.width, data.height), 0, 0);
  const texture = textures.addCanvas(ATLAS_KEY, canvas);
  if (!texture) throw new Error('buildAtlas: addCanvas a échoué');
  for (const [name, r] of Object.entries(data.frames)) texture.add(name, 0, r.x, r.y, r.w, r.h);
  // Phaser.Textures.FilterMode.NEAREST === 1 (import de type seulement : pas de Phaser au chargement du module)
  texture.setFilter(1 as Phaser.Textures.FilterMode);
}
