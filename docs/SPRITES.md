# SPRITES — art placeholder des Fragments de l'Aube

Tous les sprites du jeu sont des **placeholders générés par code** (aucun fichier image binaire dans le dépôt).
Ils sont dessinés pixel par pixel au démarrage (`BootScene` → `buildAtlas(scene)`), assemblés en **un seul atlas runtime**
(texture `'atlas'`, ≤ 1024×1024, côtés puissances de 2, packing « shelf » déterministe, 1 px de marge entre frames),
puis référencés par nom de frame. Le style vise l'esprit *Link's Awakening* / *Shovel Knight* : contours sombres nets de 1 px,
aplats de couleurs vives, aucun dégradé, aucun pixel semi-transparent, 8–12 couleurs par thème de donjon.

Quand de vrais assets pixel art seront disponibles, il suffira de remplacer le contenu de l'atlas en **conservant les noms
de frames** (voir le tableau ci-dessous) : aucun autre code n'a à changer.

## Organisation du code (`src/render/art/`)

| Fichier | Rôle |
|---|---|
| `index.ts` | API publique : `buildAtlasData()` (pur, testable sous Node), `buildAtlas(scene)` (Phaser), `FRAME_NAMES`, `hasFrame`, `requiredFrames`, `SPRITE_MANIFEST`, `ATLAS_KEY` + réexport des helpers d'`animations.ts` |
| `animations.ts` | Helpers purs de noms de frames : `heroFrame`, `enemyFrame`, `bossFrame`, `tileFrame`, `runeFrame`, `keyFrame`, `slashFrame`, `plateFrame`, … |
| `contract.ts` | Liste exhaustive des frames exigées (DESIGN.md §4) et de leurs tailles (`requiredFrameSpecs()`) |
| `manifest.ts` | `SPRITE_MANIFEST` : motifs de frames → description / taille / consigne de remplacement |
| `bitmap.ts` | Toile de pixels 0xRRGGBB (rect, ligne, ellipse ombrée, polygone, contour, rotation, miroir…) |
| `atlas.ts` | `packAtlas()` : bitmaps → RGBA + rectangles de frames |
| `heroKit.ts`, `heroes.ts` | Gabarit corps 16×16 paramétrique + 8 héros (4 directions × 2 marche + attaque + « à terre ») |
| `enemies.ts`, `bosses.ts`, `tiles.ts`, `mechanisms.ts`, `decor.ts`, `fx.ts`, `ui.ts` | Une famille de sprites par fichier |
| `light.ts` | Torches / salles sombres : `brazier_*`, `ui_torch_*`, `fx_ember_0..2` (voir « Lumière et obscurité ») |
| `../darkness.ts` | `DarknessLayer` : voile d'obscurité (RenderTexture) + pinceaux lumineux générés par code (hors atlas) |
| `../palettes.ts` | Toutes les couleurs (thèmes `crypt`/`grove`/`citadel`, héros, ennemis, boss, mécanismes, FX, UI) ; `ALL_PALETTE_COLORS` = liste blanche testée |

## Conventions d'usage (pour le rendu)

- **Échelle 1:1** : tous les sprites sont à l'échelle de pixel native ; seul le zoom entier de la caméra les agrandit.
- **Héros** : `left` est le miroir exact de `right`. Pieds posés sur la rangée y = 14 de la frame 16×16 ; origine conseillée (0.5, 0.75).
  Les frames « attaque » montrent la pose ; l'arc d'épée est un FX séparé (`fx_slash_<dir>`, 24×24, à centrer devant le héros).
- **Ennemis** : 2 frames, pas de gauche/droite (`flipX`). Boss 48×48 : `boss_<kind>_hurt` est une silhouette de dégâts (flash) à afficher quelques frames.
- **Tuiles** (toutes opaques et raccordables) : `wall` = *face* d'un mur (tuile dont le voisin du bas est praticable), `wall_top` = *dessus* (voisin du bas = mur/vide),
  `pillar` et `pit` incluent leur fond de sol, `void` = hors-salle. `tileFrame(theme, glyph, x, y, below?)` fait ce choix (variante `floor_alt` déterministe selon x,y).
- **Plaques / leviers** : centre clair, teintables (couleur du slot « qui doit faire quoi »). `door_closed` se répète sur chaque tuile de porte ;
  `door_open` est presque vide (le sol reste visible) ; `door_sealed` sert à la sortie scellée.
- **Runes** : glyphes seuls sur fond transparent ; `rune_frame` est le cadre doré d'affichage de la séquence (vision partagée).
- **Projectiles** (8×8) sont orientés vers la **droite** : le rendu applique la rotation selon la vitesse. `fx_marker` est blanc : le rendu le teinte avec `PLAYER_COLORS[id]`.
- **Clés** : `key_<n>` / `ui_key_<n>` = anneau de la couleur du slot n (bleu, rouge, vert, jaune).
- **Frames supplémentaires (hors contrat)** : `fx_star` (8×8), `fx_ember` (4×4), `ui_special` (8×8) — attaques spéciales ; `fx_shadow` (16×8) — ombre ovale pleine, le rendu règle l'alpha (~0,35).
- **Lumière et obscurité** (salles `dark: true`) :
  - `brazier_unlit` / `brazier_lit_0` / `brazier_lit_1` (16×16) : brasero de métal sur pied ; helper `brazierFrame(lit, timeMs)` (alternance ≈ 5,5 Hz si allumé). Origine par défaut = tuile du `BrazierDef`.
  - `ui_torch_full` / `ui_torch_half` / `ui_torch_empty` (8×8) : icône de combustible du HUD ; helper `torchIconFrame(fraction)` (≥ 50 % plein, > 0 moitié, sinon vide).
  - `fx_ember_0..2` (8×8) : étincelles (vive, orange, mourante) ; helper `emberFrame(progress)` ; sans contour, à faire monter/dériver puis disparaître (à ne pas confondre avec `fx_ember` 4×4 de la nova de feu).
  - **Voile** : `new DarknessLayer(scene, widthPx, heightPx, { depth })` (src/render/darkness.ts) ; `layer.object` = le `RenderTexture` (objet MONDE à enregistrer auprès des caméras, ignoré par la caméra d'interface) ;
    `layer.update(lightSources(state, room), scene.time.now)` à chaque frame ; `layer.destroy()` au changement de salle (libère aussi les pinceaux ; auto-détruit à l'arrêt de la scène).
    Noir bleuté `DARK_COLORS.veil` à 94 % d'opacité (≈ 6 % de décor visible hors lumière), pinceaux en 4 à 6 paliers nets (damier d'un pixel entre paliers), scintillement par paliers, légère teinte chaude (`lightGlow(kind)`).
    Fonctions pures : `lightBrushBands`, `flickerRadius`, `lightAt(point, sources)` (0..1, pour le HUD / les ennemis), `darknessScale` (≤ 4096 px de texture, sinon résolution réduite).
    Le brasero et la torche ne sont PAS dessinés dans le voile : ce sont des sprites du monde, sous le voile mais éclairés par leur propre pinceau (ils restent donc visibles au centre de la lumière).

## Tableau des sprites à remplacer

Taille = taille d'UNE frame. Les motifs utilisent `*` comme joker.

### Héros (jouables)

| Frame(s) | Taille | Description | À remplacer par |
|---|---|---|---|
| `hero_david_*` | 16×16 | Guerrier : casque d'acier à plumet rouge, tabard bleu, épée et bouclier. Frames : hero_david_<down|up|left|right>_<0|1> (marche), hero_david_<dir>_attack, hero_david_downed | Feuille pixel art 16×16 « david » : 13 frames (marche 2×4 directions, attaque ×4, à terre ×1), contour sombre 1 px, silhouette lisible à zoom 2 |
| `hero_sandrine_*` | 16×16 | Magicienne : grand chapeau pointu violet, robe, cheveux auburn, bâton à orbe cyan. Frames : hero_sandrine_<down|up|left|right>_<0|1> (marche), hero_sandrine_<dir>_attack, hero_sandrine_downed | Feuille pixel art 16×16 « sandrine » : 13 frames (marche 2×4 directions, attaque ×4, à terre ×1), contour sombre 1 px, silhouette lisible à zoom 2 |
| `hero_romain_*` | 16×16 | Éclaireur : petit, capuche verte pointue, tunique de cuir, écharpe orange, lame courte. Frames : hero_romain_<down|up|left|right>_<0|1> (marche), hero_romain_<dir>_attack, hero_romain_downed | Feuille pixel art 16×16 « romain » : 13 frames (marche 2×4 directions, attaque ×4, à terre ×1), contour sombre 1 px, silhouette lisible à zoom 2 |
| `hero_valentine_*` | 16×16 | Guérisseuse-archère : cape claire évasée, cheveux blonds, robe rose, arc doré, étoile de soin. Frames : hero_valentine_<down|up|left|right>_<0|1> (marche), hero_valentine_<dir>_attack, hero_valentine_downed | Feuille pixel art 16×16 « valentine » : 13 frames (marche 2×4 directions, attaque ×4, à terre ×1), contour sombre 1 px, silhouette lisible à zoom 2 |
| `hero_aelith_*` | 16×16 | Elfe archère : oreilles pointues, cheveux argentés, tenue verte, grand arc. Frames : hero_aelith_<down|up|left|right>_<0|1> (marche), hero_aelith_<dir>_attack, hero_aelith_downed | Feuille pixel art 16×16 « aelith » : 13 frames (marche 2×4 directions, attaque ×4, à terre ×1), contour sombre 1 px, silhouette lisible à zoom 2 |
| `hero_brokk_*` | 16×16 | Nain tank : casque de fer à cornes, grande barbe orange, hache. Frames : hero_brokk_<down|up|left|right>_<0|1> (marche), hero_brokk_<dir>_attack, hero_brokk_downed | Feuille pixel art 16×16 « brokk » : 13 frames (marche 2×4 directions, attaque ×4, à terre ×1), contour sombre 1 px, silhouette lisible à zoom 2 |
| `hero_grok_*` | 16×16 | Troll brute : peau verte, pagne, massue cloutée. Frames : hero_grok_<down|up|left|right>_<0|1> (marche), hero_grok_<dir>_attack, hero_grok_downed | Feuille pixel art 16×16 « grok » : 13 frames (marche 2×4 directions, attaque ×4, à terre ×1), contour sombre 1 px, silhouette lisible à zoom 2 |
| `hero_mira_*` | 16×16 | Maraudeuse : capuche sombre aux yeux dorés, écharpe cramoisie, deux dagues. Frames : hero_mira_<down|up|left|right>_<0|1> (marche), hero_mira_<dir>_attack, hero_mira_downed | Feuille pixel art 16×16 « mira » : 13 frames (marche 2×4 directions, attaque ×4, à terre ×1), contour sombre 1 px, silhouette lisible à zoom 2 |

### Ennemis

| Frame(s) | Taille | Description | À remplacer par |
|---|---|---|---|
| `enemy_slime_*` | 16×16 | Blob vert qui s'écrase. Frames : enemy_slime_0, enemy_slime_1 (le rendu fait flipX) | Animation pixel art 16×16 à 2 frames de « slime » (vue de dessus, 3/4 face) |
| `enemy_bat_*` | 16×16 | Chauve-souris violette (ailes haut/bas). Frames : enemy_bat_0, enemy_bat_1 (le rendu fait flipX) | Animation pixel art 16×16 à 2 frames de « bat » (vue de dessus, 3/4 face) |
| `enemy_skeleton_*` | 16×16 | Squelette à épée rouillée. Frames : enemy_skeleton_0, enemy_skeleton_1 (le rendu fait flipX) | Animation pixel art 16×16 à 2 frames de « skeleton » (vue de dessus, 3/4 face) |
| `enemy_archer_*` | 16×16 | Archer encapuchonné rouge. Frames : enemy_archer_0, enemy_archer_1 (le rendu fait flipX) | Animation pixel art 16×16 à 2 frames de « archer » (vue de dessus, 3/4 face) |
| `enemy_spider_*` | 16×16 | Araignée sombre à sablier rouge. Frames : enemy_spider_0, enemy_spider_1 (le rendu fait flipX) | Animation pixel art 16×16 à 2 frames de « spider » (vue de dessus, 3/4 face) |
| `enemy_wisp_*` | 16×16 | Feu follet cyan. Frames : enemy_wisp_0, enemy_wisp_1 (le rendu fait flipX) | Animation pixel art 16×16 à 2 frames de « wisp » (vue de dessus, 3/4 face) |
| `enemy_knight_*` | 16×16 | Chevalier maudit à bouclier doré et plumet magenta. Frames : enemy_knight_0, enemy_knight_1 (le rendu fait flipX) | Animation pixel art 16×16 à 2 frames de « knight » (vue de dessus, 3/4 face) |

### Boss

| Frame(s) | Taille | Description | À remplacer par |
|---|---|---|---|
| `boss_golem_*` | 48×48 | Gorgrim, golem de racines (niveau 2) : boss_golem_0, boss_golem_1, boss_golem_hurt (silhouette de dégâts) | Sprite boss 48×48 à 2 frames d'idle/attaque + frame de dégâts (flash rouge/blanc) |
| `boss_morvane_*` | 48×48 | Morvane, seigneur déchu (niveau 3) : boss_morvane_0, boss_morvane_1, boss_morvane_hurt | Sprite boss 48×48 à 2 frames (cape qui ondule) + frame de dégâts |

### Tuiles de donjon

| Frame(s) | Taille | Description | À remplacer par |
|---|---|---|---|
| `tile_crypt_*` | 16×16 | Crypte (L1) : sol de dalles bleu-gris, mur de briques, dessus de mur, pilier, fosse, vide | Tileset 16×16 de 7 tuiles raccordables, palette pierre bleu-gris + accents orange |
| `tile_grove_*` | 16×16 | Bosquet putride (L2) : herbe/terre, mur d'écorce, canopée, souche, mare toxique, vide | Tileset 16×16 de 7 tuiles raccordables, verts/ocres + champignons luisants |
| `tile_citadel_*` | 16×16 | Citadelle de Morvane (L3) : dalles d'obsidienne, mur incrusté de cristaux, pilier à cristal, abysse, vide | Tileset 16×16 de 7 tuiles raccordables, violets/noirs + cristaux cyan |

### Mécanismes

| Frame(s) | Taille | Description | À remplacer par |
|---|---|---|---|
| `plate_*` | 16×16 | Plaque de pression (plate_up / plate_down), centre clair teintable | Plaque pierre 16×16, 2 états |
| `lever_*` | 16×16 | Levier (lever_off pommeau rouge / lever_on pommeau vert) | Levier 16×16, 2 états |
| `door_closed` | 16×16 | Porte de bois cerclée de fer, tuile raccordable | Tuile de porte 16×16 raccordable |
| `door_open` | 16×16 | Porte ouverte : simples gonds au sol (le sol reste visible) | Tuile de porte ouverte 16×16, mostly transparent |
| `door_sealed` | 16×16 | Sortie scellée : dalle de pierre au sceau violet | Tuile 16×16 de porte magique scellée |
| `key_*` | 16×16 | Clé personnelle : anneau de la couleur du slot (key_0 bleu, key_1 rouge, key_2 vert, key_3 jaune) | Clé 16×16 en 4 variantes de couleur |
| `block` | 32×32 | Bloc poussable 2×2 tuiles : pierre biseautée à losange gravé | Bloc de pierre 32×32 |
| `socket*` | 32×32 | Réceptacle 2×2 tuiles : creux violet (socket) / rempli vert lumineux (socket_filled) | Réceptacle 32×32, 2 états |
| `exit_*` | 16×16 | Sortie : disque doré à flèche (exit_open) / disque gris à cadenas (exit_closed) | Marqueur de sortie 16×16, 2 états |
| `pedestal` | 16×16 | Piédestal de pierre (énigme de runes) | Piédestal 16×16 |
| `rune_*` | 16×16 | Glyphes de runes : sun, moon, star, eye, flame, wave + rune_frame (cadre doré d'affichage) | 6 glyphes symboliques lisibles + cadre 16×16 |

### Décors

| Frame(s) | Taille | Description | À remplacer par |
|---|---|---|---|
| `decor_torch_*` | 16×16 | Torche (2 frames de flamme) | Torche animée 16×16, 2 frames |
| `decor_*` | 16×16 | Décors : statue, bannière, caisse, ossements, plante, cristal | Décors 16×16 (un par type de DecorDef) |
| `sign` | 16×16 | Panneau de bois avec parchemin | Panneau 16×16 |

### Effets (FX)

| Frame(s) | Taille | Description | À remplacer par |
|---|---|---|---|
| `fx_slash_*` | 24×24 | Arc d'épée blanc-bleuté, 4 directions (teintable) | Animation d'arc 24×24 (4 directions) |
| `fx_arrow` | 8×8 | Flèche (orientée vers la droite, le rendu pivote) | Projectile 8×8 |
| `fx_bolt` | 8×8 | Trait magique cyan | Projectile 8×8 |
| `fx_orb` | 8×8 | Orbe magique magenta | Projectile 8×8 |
| `fx_shard` | 8×8 | Éclat de cristal violet | Projectile 8×8 |
| `fx_heal` | 8×8 | Croix de soin verte | Projectile 8×8 |
| `fx_hit_*` | 16×16 | Impact en 3 frames (étincelle, gerbe, éclats) | Animation d'impact 16×16, 3 frames |
| `fx_revive_*` | 16×16 | Relevage : anneau et étincelles montantes, 4 frames | Animation de relevage 16×16, 4 frames |
| `fx_marker` | 8×8 | Triangle blanc pointant vers le bas, à teinter (couleur du joueur) | Marqueur 8×8 blanc |
| `fx_shadow` | 16×8 | Ombre ovale au sol (alpha réglé par le rendu) | Ombre 16×8 |

### Interface (UI)

| Frame(s) | Taille | Description | À remplacer par |
|---|---|---|---|
| `fx_star` | 8×8 | Étoile à quatre branches blanche/dorée (à teinter) : lancement des spéciaux, soin | Éclat 8×8 |
| `fx_ember` | 4×4 | Braise orange (nova de feu) | Particule 4×4 |
| `ui_special` | 8×8 | Étoile dorée : indicateur d'attaque spéciale du HUD | Icône 8×8 |
| `brazier_unlit` | 16×16 | Brasero de métal sur pied, éteint : bûches non brûlées dans la vasque | Brasero 16×16 éteint |
| `brazier_lit_*` | 16×16 | Brasero allumé : flamme vive orange/jaune sur un lit de braises (brazier_lit_0 / brazier_lit_1) | Brasero allumé 16×16, flamme animée sur 2 frames |
| `ui_torch_*` | 8×8 | Icône de torche du HUD : ui_torch_full (flamme haute), ui_torch_half (petite flamme), ui_torch_empty (bout calciné) | Icônes 8×8 en 3 niveaux de combustible |
| `fx_ember_*` | 8×8 | Étincelles : fx_ember_0 (vive), fx_ember_1 (orange), fx_ember_2 (mourante) | Particules 8×8, 3 étapes |
| `ui_heart_*` | 8×8 | Cœurs de PV : plein, demi, vide | Icônes 8×8 |
| `ui_check` | 8×8 | Coche verte (objectif accompli) | Icône 8×8 |
| `ui_cross` | 8×8 | Croix rouge | Icône 8×8 |
| `ui_down` | 8×8 | Crâne : joueur à terre | Icône 8×8 |
| `ui_key_*` | 8×8 | Icône de clé (couleur du slot) | Icône 8×8 en 4 couleurs |

## Aperçus visuels

```
node scripts/preview-atlas.mjs [dossierDeSortie] [échelle]
node scripts/preview-atlas.mjs <dossier> 6 hero_david_down_0 boss_golem_0   # zoom sur des frames précises (custom.png)
```

Écrit des PNG agrandis (atlas complet, planches des héros marche / attaque, ennemis, boss, tuiles des 3 thèmes, salle d'exemple,
mécanismes, décors, FX et UI). L'encodeur PNG est minimal (zlib de Node) ; le module d'art est empaqueté à la volée avec esbuild (déjà présent via Vite).

## Tests

`npx vitest run src/render/art/art.test.ts` vérifie : contrat des noms et tailles, absence de doublon, bornes et marges de l'atlas,
alpha ∈ {0, 255}, aucun pixel hors palette, 12 couleurs max par thème, héros tous distincts (pixels + silhouettes), 4 directions différentes,
`left` = miroir de `right`, frames de marche différentes, déterminisme (deux builds → mêmes octets), helpers d'`animations.ts`, couverture du manifeste.
