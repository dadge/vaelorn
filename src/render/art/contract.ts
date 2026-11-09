/**
 * CONTRAT art ↔ rendu (docs/DESIGN.md §4) : liste exhaustive des frames obligatoires et de leurs tailles.
 * Volontairement écrit « à plat », indépendamment des générateurs, pour que les tests vérifient
 * que l'atlas respecte bien le contrat.
 */
import type { CharacterId, Dir, EnemyKind, ZoneTheme } from '../../core/types';

/** Clé de la texture d'atlas dans Phaser. */
export const ATLAS_KEY = 'atlas';

export interface FrameSpec {
  name: string;
  /** [largeur, hauteur] en pixels. */
  size: [number, number];
}

const CHARACTERS: readonly CharacterId[] = ['david', 'sandrine', 'romain', 'valentine', 'aelith', 'brokk', 'grok', 'mira'];
const DIRS: readonly Dir[] = ['down', 'up', 'left', 'right'];
const ENEMIES: readonly EnemyKind[] = ['slime', 'bat', 'skeleton', 'archer', 'spider', 'wisp', 'knight'];
const BOSSES = ['golem', 'morvane', 'frostqueen', 'forgelord', 'voidlord'] as const;
/** Demi-boss (niveaux 4-6) : frames 32×32 `miniboss_<kind>_<0|1|hurt>`. */
const MINIBOSSES = ['warden', 'pyromancer', 'wraith'] as const;
const THEMES: readonly ZoneTheme[] = ['crypt', 'grove', 'citadel', 'frost', 'ember', 'void'];
const TILE_KINDS = ['floor', 'floor_alt', 'wall', 'wall_top', 'pillar', 'pit', 'void'] as const;
const RUNES = ['sun', 'moon', 'star', 'eye', 'flame', 'wave'] as const;

/** Symboles de runes disponibles (ids de `RunePuzzleDef.pedestals[].symbol`). */
export const RUNE_NAMES: readonly string[] = RUNES;

/** Frames supplémentaires (hors contrat de DESIGN.md), ajoutées par l'art. */
export const EXTRA_FRAME_SPECS: readonly FrameSpec[] = [
  /** Ombre ovale pleine (couleur de contour) : le rendu règle l'alpha (~0.35). */
  { name: 'fx_shadow', size: [16, 8] },
  /** Étoile 8×8 (lancement des spéciaux, soin) à teinter. */
  { name: 'fx_star', size: [8, 8] },
  /** Braise 4×4 (nova de feu). */
  { name: 'fx_ember', size: [4, 4] },
  /** Étoile dorée de l'indicateur d'attaque spéciale (HUD). */
  { name: 'ui_special', size: [8, 8] },
  // ── Torches / salles sombres (src/render/art/light.ts) ──
  /** Brasero 16×16 : éteint (bois non allumé) / allumé (2 frames de flamme). */
  { name: 'brazier_unlit', size: [16, 16] },
  { name: 'brazier_lit_0', size: [16, 16] },
  { name: 'brazier_lit_1', size: [16, 16] },
  /** Icône de torche du HUD : combustible plein / moitié / vide. */
  { name: 'ui_torch_full', size: [8, 8] },
  { name: 'ui_torch_half', size: [8, 8] },
  { name: 'ui_torch_empty', size: [8, 8] },
  /** Étincelles (3 étapes de vie : vive, orange, mourante). */
  { name: 'fx_ember_0', size: [8, 8] },
  { name: 'fx_ember_1', size: [8, 8] },
  { name: 'fx_ember_2', size: [8, 8] },
  // ── Mécanismes des niveaux 4-6 (src/render/art/mechanisms46.ts) ──
  /** Statues jumelles : 4 directions, état normal (yeux cyan) et résolu (`_lit`, vert) ; socle d'activation au sol. */
  ...(['up', 'down', 'left', 'right'] as const).flatMap((d): FrameSpec[] => [
    { name: `statuepair_${d}`, size: [16, 16] },
    { name: `statuepair_${d}_lit`, size: [16, 16] },
  ]),
  { name: 'statuepair_stand', size: [16, 16] },
  /** Sablier : niveau de sable du haut 0 (vide) … 4 (plein) ; herse fermée / relevée. */
  ...[0, 1, 2, 3, 4].map((l): FrameSpec => ({ name: `hourglass_${l}`, size: [16, 16] })),
  { name: 'gate_closed', size: [16, 16] },
  { name: 'gate_open', size: [16, 16] },
  /** Pont de lumière : planches lumineuses / abîme étoilé. */
  { name: 'bridge_lit', size: [16, 16] },
  { name: 'bridge_dark', size: [16, 16] },
  /** Lanterne du porteur (2 frames de flamme), aussi utilisée par le HUD. */
  { name: 'lantern_0', size: [8, 8] },
  { name: 'lantern_1', size: [8, 8] },
  // ── Sources de vie (src/render/art/loot.ts) ──
  /** Nourriture au sol : le cœur de l'interface agrandi ×2 (demi-cœur / cœur entier), sans cadre ; le halo est un effet de rendu. */
  { name: 'pickup_half', size: [16, 16] },
  { name: 'pickup_full', size: [16, 16] },
  /** Cristal de soin : 2 frames d'éclat (intact) et frame « vidée » (grise, après usage). */
  { name: 'heal_crystal_0', size: [16, 16] },
  { name: 'heal_crystal_1', size: [16, 16] },
  { name: 'heal_crystal_used', size: [16, 16] },
];

/** Toutes les frames du contrat, avec leurs tailles. */
export function requiredFrameSpecs(): FrameSpec[] {
  const out: FrameSpec[] = [];
  const add = (name: string, w = 16, h = w) => out.push({ name, size: [w, h] });
  for (const id of CHARACTERS) {
    for (const d of DIRS) {
      add(`hero_${id}_${d}_0`);
      add(`hero_${id}_${d}_1`);
      add(`hero_${id}_${d}_attack`);
    }
    add(`hero_${id}_downed`);
  }
  for (const k of ENEMIES) {
    add(`enemy_${k}_0`);
    add(`enemy_${k}_1`);
  }
  for (const b of BOSSES) {
    add(`boss_${b}_0`, 48);
    add(`boss_${b}_1`, 48);
    add(`boss_${b}_hurt`, 48);
  }
  for (const m of MINIBOSSES) {
    add(`miniboss_${m}_0`, 32);
    add(`miniboss_${m}_1`, 32);
    add(`miniboss_${m}_hurt`, 32);
  }
  for (const t of THEMES) for (const k of TILE_KINDS) add(`tile_${t}_${k}`);
  add('plate_up');
  add('plate_down');
  add('lever_off');
  add('lever_on');
  add('door_closed');
  add('door_open');
  add('door_sealed');
  for (let i = 0; i < 4; i++) add(`key_${i}`);
  add('block', 32);
  add('socket', 32);
  add('socket_filled', 32);
  add('exit_open');
  add('exit_closed');
  add('pedestal');
  for (const r of RUNES) add(`rune_${r}`);
  add('rune_frame');
  add('decor_torch_0');
  add('decor_torch_1');
  for (const n of ['statue', 'banner', 'crate', 'bones', 'plant', 'crystal']) add(`decor_${n}`);
  add('sign');
  for (const d of ['up', 'down', 'left', 'right']) add(`fx_slash_${d}`, 24);
  for (const n of ['arrow', 'bolt', 'orb', 'shard', 'heal']) add(`fx_${n}`, 8);
  for (let i = 0; i < 3; i++) add(`fx_hit_${i}`);
  for (let i = 0; i < 4; i++) add(`fx_revive_${i}`);
  add('fx_marker', 8);
  for (const n of ['heart_full', 'heart_half', 'heart_empty', 'check', 'cross', 'down']) add(`ui_${n}`, 8);
  for (let i = 0; i < 4; i++) add(`ui_key_${i}`, 8);
  return out;
}

/** Noms de toutes les frames exigées par le contrat (DESIGN.md §4), sans doublon. */
export function requiredFrames(): string[] {
  return requiredFrameSpecs().map((s) => s.name);
}
