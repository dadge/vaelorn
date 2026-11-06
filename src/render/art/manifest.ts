/**
 * Manifeste des sprites placeholder : tout ce qui doit être REMPLACÉ par de vrais assets pixel art.
 * Clés = motifs de noms de frames (joker `*`). Sert au README et à docs/SPRITES.md.
 * Un test vérifie que chaque frame de l'atlas est couverte par au moins un motif.
 */
export interface SpriteManifestEntry {
  description: string;
  /** Taille d'une frame [largeur, hauteur] en px. */
  size: [number, number];
  /** Consigne pour l'artiste / le remplaçant. */
  replaceWith: string;
}

const e = (description: string, size: [number, number], replaceWith: string): SpriteManifestEntry => ({ description, size, replaceWith });

const HERO_DESC: Record<string, string> = {
  david: 'Guerrier : casque d\'acier à plumet rouge, tabard bleu, épée et bouclier',
  sandrine: 'Magicienne : grand chapeau pointu violet, robe, cheveux auburn, bâton à orbe cyan',
  romain: 'Éclaireur : petit, capuche verte pointue, tunique de cuir, écharpe orange, lame courte',
  valentine: 'Guérisseuse-archère : cape claire évasée, cheveux blonds, robe rose, arc doré, étoile de soin',
  aelith: 'Elfe archère : oreilles pointues, cheveux argentés, tenue verte, grand arc',
  brokk: 'Nain tank : casque de fer à cornes, grande barbe orange, hache',
  grok: 'Troll brute : peau verte, pagne, massue cloutée',
  mira: 'Maraudeuse : capuche sombre aux yeux dorés, écharpe cramoisie, deux dagues',
};

const heroEntries = Object.fromEntries(
  Object.entries(HERO_DESC).map(([id, d]) => [
    `hero_${id}_*`,
    e(
      `${d}. Frames : hero_${id}_<down|up|left|right>_<0|1> (marche), hero_${id}_<dir>_attack, hero_${id}_downed`,
      [16, 16],
      `Feuille pixel art 16×16 « ${id} » : 13 frames (marche 2×4 directions, attaque ×4, à terre ×1), contour sombre 1 px, silhouette lisible à zoom 2`,
    ),
  ]),
);

const ENEMY_DESC: Record<string, string> = {
  slime: 'Blob vert qui s\'écrase',
  bat: 'Chauve-souris violette (ailes haut/bas)',
  skeleton: 'Squelette à épée rouillée',
  archer: 'Archer encapuchonné rouge',
  spider: 'Araignée sombre à sablier rouge',
  wisp: 'Feu follet cyan',
  knight: 'Chevalier maudit à bouclier doré et plumet magenta',
};

const enemyEntries = Object.fromEntries(
  Object.entries(ENEMY_DESC).map(([k, d]) => [
    `enemy_${k}_*`,
    e(`${d}. Frames : enemy_${k}_0, enemy_${k}_1 (le rendu fait flipX)`, [16, 16], `Animation pixel art 16×16 à 2 frames de « ${k} » (vue de dessus, 3/4 face)`),
  ]),
);

export const SPRITE_MANIFEST: Record<string, SpriteManifestEntry> = {
  ...heroEntries,
  ...enemyEntries,
  'boss_golem_*': e('Gorgrim, golem de racines (niveau 2) : boss_golem_0, boss_golem_1, boss_golem_hurt (silhouette de dégâts)', [48, 48], 'Sprite boss 48×48 à 2 frames d\'idle/attaque + frame de dégâts (flash rouge/blanc)'),
  'boss_morvane_*': e('Morvane, seigneur déchu (niveau 3) : boss_morvane_0, boss_morvane_1, boss_morvane_hurt', [48, 48], 'Sprite boss 48×48 à 2 frames (cape qui ondule) + frame de dégâts'),
  'tile_crypt_*': e('Crypte (L1) : sol de dalles bleu-gris, mur de briques, dessus de mur, pilier, fosse, vide', [16, 16], 'Tileset 16×16 de 7 tuiles raccordables, palette pierre bleu-gris + accents orange'),
  'tile_grove_*': e('Bosquet putride (L2) : herbe/terre, mur d\'écorce, canopée, souche, mare toxique, vide', [16, 16], 'Tileset 16×16 de 7 tuiles raccordables, verts/ocres + champignons luisants'),
  'tile_citadel_*': e('Citadelle de Morvane (L3) : dalles d\'obsidienne, mur incrusté de cristaux, pilier à cristal, abysse, vide', [16, 16], 'Tileset 16×16 de 7 tuiles raccordables, violets/noirs + cristaux cyan'),
  'plate_*': e('Plaque de pression (plate_up / plate_down), centre clair teintable', [16, 16], 'Plaque pierre 16×16, 2 états'),
  'lever_*': e('Levier (lever_off pommeau rouge / lever_on pommeau vert)', [16, 16], 'Levier 16×16, 2 états'),
  'door_closed': e('Porte de bois cerclée de fer, tuile raccordable', [16, 16], 'Tuile de porte 16×16 raccordable'),
  'door_open': e('Porte ouverte : simples gonds au sol (le sol reste visible)', [16, 16], 'Tuile de porte ouverte 16×16, mostly transparent'),
  'door_sealed': e('Sortie scellée : dalle de pierre au sceau violet', [16, 16], 'Tuile 16×16 de porte magique scellée'),
  'key_*': e('Clé personnelle : anneau de la couleur du slot (key_0 bleu, key_1 rouge, key_2 vert, key_3 jaune)', [16, 16], 'Clé 16×16 en 4 variantes de couleur'),
  'block': e('Bloc poussable 2×2 tuiles : pierre biseautée à losange gravé', [32, 32], 'Bloc de pierre 32×32'),
  'socket*': e('Réceptacle 2×2 tuiles : creux violet (socket) / rempli vert lumineux (socket_filled)', [32, 32], 'Réceptacle 32×32, 2 états'),
  'exit_*': e('Sortie : disque doré à flèche (exit_open) / disque gris à cadenas (exit_closed)', [16, 16], 'Marqueur de sortie 16×16, 2 états'),
  'pedestal': e('Piédestal de pierre (énigme de runes)', [16, 16], 'Piédestal 16×16'),
  'rune_*': e('Glyphes de runes : sun, moon, star, eye, flame, wave + rune_frame (cadre doré d\'affichage)', [16, 16], '6 glyphes symboliques lisibles + cadre 16×16'),
  'decor_torch_*': e('Torche (2 frames de flamme)', [16, 16], 'Torche animée 16×16, 2 frames'),
  'decor_*': e('Décors : statue, bannière, caisse, ossements, plante, cristal', [16, 16], 'Décors 16×16 (un par type de DecorDef)'),
  'sign': e('Panneau de bois avec parchemin', [16, 16], 'Panneau 16×16'),
  'fx_slash_*': e('Arc d\'épée blanc-bleuté, 4 directions (teintable)', [24, 24], 'Animation d\'arc 24×24 (4 directions)'),
  'fx_arrow': e('Flèche (orientée vers la droite, le rendu pivote)', [8, 8], 'Projectile 8×8'),
  'fx_bolt': e('Trait magique cyan', [8, 8], 'Projectile 8×8'),
  'fx_orb': e('Orbe magique magenta', [8, 8], 'Projectile 8×8'),
  'fx_shard': e('Éclat de cristal violet', [8, 8], 'Projectile 8×8'),
  'fx_heal': e('Croix de soin verte', [8, 8], 'Projectile 8×8'),
  'fx_hit_*': e('Impact en 3 frames (étincelle, gerbe, éclats)', [16, 16], 'Animation d\'impact 16×16, 3 frames'),
  'fx_revive_*': e('Relevage : anneau et étincelles montantes, 4 frames', [16, 16], 'Animation de relevage 16×16, 4 frames'),
  'fx_marker': e('Triangle blanc pointant vers le bas, à teinter (couleur du joueur)', [8, 8], 'Marqueur 8×8 blanc'),
  'fx_shadow': e('Ombre ovale au sol (alpha réglé par le rendu)', [16, 8], 'Ombre 16×8'),
  'fx_star': e('Étoile à quatre branches blanche/dorée (à teinter) : lancement des spéciaux, soin', [8, 8], 'Éclat 8×8'),
  'fx_ember': e('Braise orange 4×4 (nova de feu)', [4, 4], 'Particule 4×4'),
  'brazier_unlit': e('Brasero de métal sur pied, éteint : bûches non brûlées dans la vasque', [16, 16], 'Brasero 16×16 éteint'),
  'brazier_lit_*': e('Brasero allumé : flamme vive orange/jaune sur un lit de braises (2 frames d’animation, brazier_lit_0 / brazier_lit_1)', [16, 16], 'Brasero allumé 16×16, flamme animée sur 2 frames'),
  'ui_torch_*': e('Icône de torche du HUD : ui_torch_full (flamme haute), ui_torch_half (petite flamme), ui_torch_empty (bout calciné)', [8, 8], 'Icônes 8×8 en 3 niveaux de combustible'),
  'fx_ember_*': e('Étincelles qui montent et retombent : fx_ember_0 (vive), fx_ember_1 (orange), fx_ember_2 (mourante)', [8, 8], 'Particules 8×8, 3 étapes'),
  'ui_special': e('Étoile dorée : indicateur de l’attaque spéciale du HUD (teintée en gris pendant la recharge)', [8, 8], 'Icône 8×8'),
  'ui_heart_*': e('Cœurs de PV : plein, demi, vide', [8, 8], 'Icônes 8×8'),
  'ui_check': e('Coche verte (objectif accompli)', [8, 8], 'Icône 8×8'),
  'ui_cross': e('Croix rouge', [8, 8], 'Icône 8×8'),
  'ui_down': e('Crâne : joueur à terre', [8, 8], 'Icône 8×8'),
  'ui_key_*': e('Icône de clé (couleur du slot)', [8, 8], 'Icône 8×8 en 4 couleurs'),
};

/** Vrai si `name` est couvert par au moins un motif du manifeste. */
export function manifestCovers(name: string): boolean {
  return Object.keys(SPRITE_MANIFEST).some((pattern) => {
    if (!pattern.includes('*')) return pattern === name;
    const re = new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
    return re.test(name);
  });
}
