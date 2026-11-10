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
  'miniboss_warden_*': e('Gardien de givre (demi-boss, niveau 4) : cuirasse de glace, heaume à cornes, bouclier et marteau de givre. Frames : miniboss_warden_0, miniboss_warden_1, miniboss_warden_hurt', [32, 32], 'Sprite demi-boss 32×32 à 2 frames + frame de dégâts'),
  'miniboss_pyromancer_*': e('Pyromancien (demi-boss, niveau 5) : robe cramoisie à capuche pointue, bâton de flamme, boule de feu. Frames : miniboss_pyromancer_0/1/hurt', [32, 32], 'Sprite demi-boss 32×32 à 2 frames + frame de dégâts'),
  'miniboss_wraith_*': e('Spectre (demi-boss, niveau 6) : manteau en lambeaux flottant, capuche creuse aux yeux spectraux, faux en os. Frames : miniboss_wraith_0/1/hurt', [32, 32], 'Sprite demi-boss 32×32 à 2 frames + frame de dégâts'),
  'boss_frostqueen_*': e('Reine des glaces (boss, niveau 4) : robe de givre, couronne d’éclats, sceptre de cristal, orbe de glace. Frames : boss_frostqueen_0/1/hurt', [48, 48], 'Sprite boss 48×48 à 2 frames + frame de dégâts'),
  'boss_forgelord_*': e('Seigneur de la forge (boss, niveau 5) : armure d’acier noir, cœur et fissures de lave, casque à cornes, marteau. Frames : boss_forgelord_0/1/hurt', [48, 48], 'Sprite boss 48×48 à 2 frames + frame de dégâts'),
  'boss_voidlord_*': e('Seigneur du Vide (boss, niveau 6) : robe étoilée, œil unique, couronne d’éclats, orbes d’abysse. Frames : boss_voidlord_0/1/hurt', [48, 48], 'Sprite boss 48×48 à 2 frames + frame de dégâts'),
  'tile_crypt_*': e('Crypte (L1) : sol de dalles bleu-gris, mur de briques, dessus de mur, pilier, fosse, vide', [16, 16], 'Tileset 16×16 de 7 tuiles raccordables, palette pierre bleu-gris + accents orange'),
  'tile_grove_*': e('Bosquet putride (L2) : herbe/terre, mur d\'écorce, canopée, souche, mare toxique, vide', [16, 16], 'Tileset 16×16 de 7 tuiles raccordables, verts/ocres + champignons luisants'),
  'tile_citadel_*': e('Citadelle de Morvane (L3) : dalles d\'obsidienne, mur incrusté de cristaux, pilier à cristal, abysse, vide', [16, 16], 'Tileset 16×16 de 7 tuiles raccordables, violets/noirs + cristaux cyan'),
  'tile_frost_*': e('Cavernes de glace (L4) : dalles givrées, mur de blocs de glace à stalactites, dessus de mur, pilier de glace, crevasse, vide', [16, 16], 'Tileset 16×16 de 7 tuiles raccordables, bleus/blancs + éclats cyan'),
  'tile_ember_*': e('Forge volcanique (L5) : dalles de basalte à fissures de lave, mur de colonnes, pilier à braise, lac de lave (fosse), vide', [16, 16], 'Tileset 16×16 de 7 tuiles raccordables, noirs/rouges + lave orange'),
  'tile_void_*': e('Abysse astral (L6) : sol cristallin étoilé, mur de cristal sombre, pilier de cristal, vide étoilé (fosse), vide', [16, 16], 'Tileset 16×16 de 7 tuiles raccordables, violets/noirs + étoiles'),
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
  'statuepair_stand': e('Statues jumelles (L4) : socle d’activation au sol (disque de pierre à anneau de runes cyan)', [16, 16], 'Socle 16×16 à fond transparent'),
  'statuepair_*': e('Statue jumelle : gardien de pierre regardant up/down/left/right (yeux et chevron cyan) ; variante _lit = puzzle résolu (vert). Frames : statuepair_<dir>, statuepair_<dir>_lit', [16, 16], 'Statue 16×16 en 4 directions × 2 états'),
  'hourglass_*': e('Sablier partagé (L5) : verre et cadre de bronze, niveau de sable du haut de 0 (vide) à 4 (plein). Frames : hourglass_0 … hourglass_4', [16, 16], 'Sablier 16×16 en 5 niveaux de sable'),
  'gate_*': e('Herse du sablier : gate_closed (grille de fer opaque), gate_open (herse relevée, sol visible)', [16, 16], 'Tuile de herse 16×16, 2 états'),
  'bridge_*': e('Pont de lumière (L6) : bridge_lit (planches de lumière dorées sur abîme), bridge_dark (abîme étoilé aux planches fantômes)', [16, 16], 'Tuile de pont 16×16 opaque, 2 états'),
  'lantern_*': e('Lanterne du porteur (HUD et héros) : cage de fer, verre doré, flamme vacillante. Frames : lantern_0, lantern_1', [8, 8], 'Icône 8×8 à 2 frames'),
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
  'pickup_*': e('Nourriture laissée par les ennemis (PROVISOIRE) : le cœur de l’interface seul, agrandi ×2, sans cadre — pickup_half (demi-cœur, +5 PV), pickup_full (cœur entier, +10 PV). Le halo et le clignotement (3 dernières secondes) sont des effets de rendu', [16, 16], 'Objet 16×16 en 2 variantes (demi / entier), lisible à zoom 2'),
  'heal_crystal_*': e('Cristal de soin (PROVISOIRE) : cristal émeraude sur socle de pierre, 2 frames d’éclat (heal_crystal_0/1) et frame vidée grise (heal_crystal_used) ; usage unique, 50 PV', [16, 16], 'Cristal 16×16 : 2 frames animées + 1 frame vidée'),
  'gear_icon_*': e('Icône d’équipement du HUD (PROVISOIRE) : gear_icon_<boots|protection|artifact|magic|weapon>_<1|2|3>, gear_icon_accessory_<lantern|magnet|warhorn>_<1|2|3> + gear_icon_accessory_vampire_3, gear_icon_buff_<speed|rage|star> ; même dessin que l’objet au sol en 8×8 (pastille de niveau / anneau de compte à rebours ajoutés au rendu)', [8, 8], 'Icônes 8×8 : 5 emplacements × 3 niveaux + 10 accessoires + 3 bonus temporaires, lisibles à 640×360'),
  'gear_*': e('Équipement au sol (PROVISOIRE) : gear_<boots|protection|artifact|magic|weapon>_<1|2|3> — Sandales / Bottes de cuir / Bottes ailées, Casque / Bouclier / Armure, Amulette / Sablier / Orbe, Potion / Baguette / Chapeau de sorcier, Épée / Hache / Arc ; gear_accessory_<lantern|magnet|warhorn>_<1|2|3> (teinte cuir / métal / or selon le niveau) et gear_accessory_vampire_3 (anneau du vampire) ; gear_buff_<speed|rage|star> (potion de vitesse, éclair de rage, étoile). Dessin seul, sans cadre ; le halo doux et le clignotement (4 dernières secondes) sont des effets de rendu', [16, 16], 'Objets 16×16 : 5 emplacements × 3 niveaux, 10 accessoires, 3 bonus temporaires ; niveau lisible à la forme et à la couleur'),
  'ui_special': e('Étoile dorée : indicateur de l’attaque spéciale du HUD (teintée en gris pendant la recharge)', [8, 8], 'Icône 8×8'),
  'ui_heart_*': e('Cœurs de PV : plein, demi, vide', [8, 8], 'Icônes 8×8'),
  'ui_check': e('Coche verte (objectif accompli)', [8, 8], 'Icône 8×8'),
  'ui_cross': e('Croix rouge', [8, 8], 'Icône 8×8'),
  'ui_medcross': e('Croix médicale rouge (demande de soins, appel automatique)', [8, 8], 'Icône 8×8'),
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
