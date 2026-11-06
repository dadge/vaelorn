# DESIGN — Les Fragments de l'Aube

Document de conception **contractuel** : toutes les parties du code (core, niveaux, rendu, scènes, entrées, i18n)
s'y conforment. Si tu dois dévier d'une règle, documente-le ici (section « Déviations ») et dans ton rapport.

## 1. Architecture en couches

```
src/core/      LOGIQUE PURE — aucune dépendance à Phaser/DOM/Math.random/Date.now/window. Déterministe, JSON-sérialisable.
src/levels/    Données de niveaux (TS typé LevelDef) : level1.ts, level2.ts, level3.ts, index.ts
src/input/     Couche d'abstraction des entrées (clavier, manettes) → ActionFrame par joueur
src/i18n/      Internationalisation : fr.json, en.json, i18n.ts (+ parts/ temporaire, voir §6)
src/net/       Interface NetAdapter (vide de logique) pour le futur multijoueur en ligne
src/render/    Génération des sprites placeholder (atlas runtime), palettes, helpers de rendu Phaser
src/entities/  Vues Phaser (PlayerView, EnemyView, MechanismView, …) : LECTURE de GameState, zéro règle de jeu
src/scenes/    Scènes Phaser : Boot, Menu, CharacterSelect, Dialogue, Game, (Hud), Result
src/main.ts    Config Phaser (Scale.FIT, pixelArt) + liste des scènes
```

Règle d'or : **Phaser ne décide jamais d'une règle de jeu**. Les scènes lisent les entrées (src/input), les
envoient à `IGameSimulation.step()`, puis synchronisent des sprites avec `GameState` et jouent les `SimEvent`.

Fichiers déjà fournis (ne pas réécrire, seulement les utiliser) :
`src/core/types.ts` (tous les contrats), `src/core/constants.ts`, `src/core/slots.ts`, `src/core/grid.ts`.
Si un contrat de `types.ts` est insuffisant ou ambigu, tu peux faire une modification **additive et minimale**
(nouveau champ optionnel, nouveau type), jamais renommer/supprimer, et tu la signales dans ton rapport.

## 2. Propriétaires de fichiers (aucun fichier n'a deux propriétaires)

| Zone | Propriétaire (agent) |
|---|---|
| `src/core/{rng,geometry,balance,characters,enemies,players}.ts` + tests | core-team |
| `src/core/{mechanisms,objectives,levelValidation}.ts` + tests | core-mech |
| `src/input/**`, `src/net/**` | input |
| `src/i18n/{i18n.ts,fr.json,en.json}`, `scripts/merge-i18n.mjs`, tests i18n | i18n |
| `src/render/art/**`, `src/render/palettes.ts` | art |
| `src/levels/level1.ts` + `src/i18n/parts/level1.*.json` | level1 |
| `src/levels/level2.ts` + `src/i18n/parts/level2.*.json` | level2 |
| `src/levels/level3.ts` + `src/i18n/parts/level3.*.json` | level3 |
| `src/core/{simulation,collision,combat}.ts` + tests | sim |
| `src/core/{ai,bosses}.ts` + tests | ai |
| `src/main.ts`, `src/scenes/{Boot,Menu,CharacterSelect,Dialogue,Result}Scene.ts`, `src/render/{session,ui}.ts` | scenes-ui |
| `src/scenes/GameScene.ts`, `src/entities/**`, `src/render/{camera,splitscreen,hud,fx}.ts` | scenes-game |
| `src/levels/index.ts` | level1 (le premier à finir ; les autres n'y touchent pas — l'intégrateur le finalise) |

Les agents n'éditent PAS les fichiers des autres. Ils lisent librement. Les erreurs `tsc` dans des fichiers qui
ne sont pas à toi (travail en cours d'un autre agent) sont à ignorer ; les tiennes doivent être à zéro.

## 3. Règles de la logique pure (src/core)

- Pas de `Math.random` : utiliser le PRNG `nextRandom(holder)` (mulberry32) dont l'état est dans `GameState.rngState`.
- Pas de `Date.now`/`performance.now` : le temps vient de `dtMs` passé à `step()`.
- Pas de classes/Map/Set/fonctions **dans GameState** : objets/tableaux/nombres/booléens/chaînes uniquement.
  (Des `Set`/`Map` temporaires locaux dans une fonction sont ok.)
- Mêmes entrées + même seed ⇒ même état (test de déterminisme obligatoire dans simulation).
- Pas mutation des définitions (`LevelDef`, `CHARACTERS`, `ENEMIES` sont en lecture seule).
- `step(dtMs, inputs)` : un pas fixe (`SIM_STEP_MS`). Le rendu accumule le temps réel et appelle step 0..N fois.
- Les fonctions de logique prennent/retournent des données ; elles mutent uniquement l'état qu'on leur passe
  explicitement (documenté dans leur JSDoc).

### Formules d'équilibrage (centralisées dans `src/core/balance.ts`, documentées dans le README)

- PV max joueur : `50 + 10 × résistance` (résistance 1..10).
- Réduction de dégâts du joueur : `2 % × résistance` (max 20 %).
- Dégâts de base du joueur : `(6 + 2.5 × force) × attack.damageMult`.
- Difficulté (par joueur, **n'affecte QUE les PV et dégâts des ennemis**, jamais leur nombre ni les mécanismes ni les PV joueur) :

  | Difficulté | PV ennemis ×  | Dégâts ennemis × |
  |---|---|---|
  | 1 facile | 0.7 | 0.6 |
  | 2 normal | 1.0 | 1.0 |
  | 3 difficile | 1.4 | 1.5 |

  Implémentation par joueur (ennemis partagés par tous) : dégâts infligés à un ennemi par le joueur P = brut ÷ multPV(diff(P)) ;
  dégâts reçus par P = brut × multDégâts(diff(P)) × (1 − réduction(P)).
- Invulnérabilité après coup : `PLAYER_INVULN_MS`. Les dégâts ne descendent jamais sous 1 une fois appliqués les multiplicateurs.

### Relevage, mort d'équipe (src/core/players.ts)

- À 0 PV → `status:'down'` : ne bouge plus, n'attaque plus, `reviveProgressMs=0`.
- Un allié **vivant** à ≤ `REVIVE_RANGE` d'un joueur à terre, qui **maintient** `revive` (et ne bouge pas : la simulation
  fige son mouvement tant que `revivingId !== null`), accumule la progression. Durée nominale `REVIVE_DURATION_MS × reviveTimeMult(sauveteur)`.
- Pendant le relevage le sauveteur subit les dégâts normalement (pas d'interruption sur simple coup).
  Si le sauveteur **tombe à terre**, ou relâche le bouton, ou s'éloigne : relevage interrompu ; la progression **retombe à 0**.
- Un ennemi dans `DOWNED_THREAT_RADIUS` d'un joueur à terre multiplie la vitesse de relevage par `REVIVE_THREAT_SLOW`.
  Un joueur à terre ne peut jamais être achevé (aucun dégât appliqué aux joueurs `down`).
- Terminé : `hp = maxHp`, `status:'alive'`, invulnérabilité courte, événement `playerRevived`. Illimité.
- Un seul sauveteur à la fois par joueur à terre (le premier arrivé garde la main).
- Tous les joueurs à terre simultanément ⇒ `teamWipe`, phase `'wipe'` puis la simulation recharge **la salle courante** :
  salles déjà validées conservées (`clearedRooms`, objectifs accomplis conservés), PV pleins, ennemis/mécanismes de la salle réinitialisés.
  (Un objectif accompli dans une salle précédente le reste. Dans la salle courante, les objectifs non accomplis se réinitialisent.)
- Passage à la salle suivante : les joueurs à terre sont relevés d'office à PV pleins sur le seuil de la nouvelle salle.

### Coop adaptative (1 à 4 joueurs)

Tous les niveaux doivent être faisables de bout en bout à 1, 2, 3 et 4 joueurs :
- Slots → joueurs : `resolveSlot(slot, n) = slot % n` (clés, leviers `ownerSlot`, vision `visibleToSlot`, objectifs `slot`, `colorSlot`).
- `MechanismBase.minPlayers` : un mécanisme (plaque, levier…) avec `minPlayers > n` est **waived** (résolu d'office, rendu « déjà activé »).
  Ex. : porte à 3 plaques [A (min 1), B (min 2), C (min 3)] → à 1 joueur seule A est requise ; à 2 : A et B ; à 3+ : toutes.
- Bloc poussable : `playersRequired` (défaut 2) plafonné au nombre de joueurs (1 joueur peut pousser seul).
- Levier à fenêtre `windowMs` : la fenêtre effective est multipliée par `ceil(nbLeviersNonWaived / nbJoueurs)`.
- Le nombre d'ennemis dépend des joueurs via `EnemySpawnDef.minPlayers` (JAMAIS de la difficulté).
- La séquence de runes est visible pour `visibleToSlot % n` ; en solo c'est le même joueur (énigme de mémoire).
- Les objectifs de slots sans joueur propre sont assignés à `slot % n` (un joueur peut avoir plusieurs objectifs à 1–3 joueurs).

## 4. Rendu : écran, caméras, pixel art

- Canvas logique **1280×720** (`GAME_WIDTH/HEIGHT`), `Phaser.Scale.FIT` + `autoCenter`, `pixelArt: true`, `roundPixels: true`.
- Tuile = 16 px. **Tous les sprites partagent l'échelle de pixel 1:1** (aucun sprite agrandi à une échelle différente) ;
  seul le zoom de caméra (entier) agrandit : **zoom 3** pour 1 et 2 joueurs, **zoom 2** pour 3 et 4 joueurs.
- Splitscreen : 1 joueur = plein écran ; 2 joueurs = 2 moitiés côte à côte (640×720) ; 3 = 3 quadrants 640×360 + 4ᵉ quadrant occupé par
  un panneau d'équipe (PV/objectifs) ; 4 = 4 quadrants. Séparateurs nets (lignes 4 px de couleur sombre).
- Chaque joueur a une `Phaser.Cameras.Scene2D.Camera` indépendante, suivant son héros, bornée à la salle.
  Les éléments de HUD ne sont dessinés que dans la bonne vue (caméra HUD dédiée ou `cameras.ignore`).
- Vision partagée : les sprites de runes ne sont rendus que dans la caméra du joueur `resolveSlot(visibleToSlot, n)` (les autres caméras les ignorent).
- Marqueur de couleur par joueur : triangle/anneau de la couleur `PLAYER_COLORS[id]` sous/au-dessus du héros + liseré sur le HUD.
- Les sprites doivent rester lisibles à zoom 2 : contours sombres de 1 px, silhouettes distinctes, couleurs vives.

### Atlas de sprites et noms de frames (contrat art ↔ rendu)

Un seul atlas runtime, clé de texture `'atlas'`, construit dans `BootScene` par `buildAtlas(scene)` (module `src/render/art/index.ts`) :
dessin sur Canvas 2D depuis des matrices de pixels (chaînes de caractères + palette) puis `textures.addCanvas` + `texture.add(frame…)`.
Chaque frame est un rectangle de l'atlas. Tailles : 16×16 sauf mention. Le module exporte aussi :
`FRAME_NAMES: readonly string[]` (liste de toutes les frames), `hasFrame(name)`, `SPRITE_MANIFEST` (nom → description/« à remplacer par un vrai asset »).

| Famille | Noms de frames |
|---|---|
| Héros (16×16) | `hero_<characterId>_<down\|up\|left\|right>_<0\|1>` (marche 2 frames), `hero_<characterId>_<dir>_attack`, `hero_<characterId>_downed` |
| Ennemis (16×16) | `enemy_<kind>_<0\|1>` pour slime, bat, skeleton, archer, spider, wisp, knight (pas de frames gauche/droite : flipX) |
| Boss (48×48) | `boss_golem_<0\|1>`, `boss_morvane_<0\|1>`, `boss_<kind>_hurt` |
| Tuiles (16×16) | `tile_<theme>_floor`, `tile_<theme>_floor_alt`, `tile_<theme>_wall`, `tile_<theme>_wall_top`, `tile_<theme>_pillar`, `tile_<theme>_pit`, `tile_<theme>_void` — theme ∈ `crypt`,`grove`,`citadel` |
| Mécanismes | `plate_up`, `plate_down` (16), `lever_off`, `lever_on` (16), `door_closed`, `door_open` (16 par tuile de porte), `door_sealed` (16, sortie scellée), `key_<0..3>` (couleur du slot), `block` (32×32), `socket` (32×32), `socket_filled` (32×32), `exit_open`, `exit_closed` (16), `pedestal` (16), `rune_<sun\|moon\|star\|eye\|flame\|wave>` (16, glyphes symboliques), `rune_frame` (16) |
| Décors (16) | `decor_torch_<0\|1>`, `decor_statue`, `decor_banner`, `decor_crate`, `decor_bones`, `decor_plant`, `decor_crystal`, `sign` |
| FX | `fx_slash_<up\|down\|left\|right>` (24×24), `fx_arrow`, `fx_bolt`, `fx_orb`, `fx_shard`, `fx_heal` (8×8, orientés vers la droite → rotation), `fx_hit_<0\|1\|2>` (16), `fx_revive_<0..3>` (16), `fx_marker` (8×8 triangle blanc à teinter) |
| UI | `ui_heart_full`, `ui_heart_half`, `ui_heart_empty` (8×8), `ui_check`, `ui_cross`, `ui_down` (8×8), `ui_key_<0..3>` (8×8) |

Palettes (`src/render/palettes.ts`) : une palette cohérente par thème de donjon.
`crypt` (L1) : pierre bleu-gris, torches orange. `grove` (L2) : verts/ocres, racines, champignons lumineux.
`citadel` (L3) : violets/noirs, cristaux cyan, rouge Morvane. Contours sombres nets, 8–12 couleurs max par thème, pas de dégradés.

## 5. Entrées (src/input)

- `ActionFrame` par joueur (voir types.ts). Couche d'abstraction : `InputSource` (interface) → `poll(): ActionFrame` ;
  `KeyboardSource`, `GamepadSource` implémentent l'interface ; plus tard `TouchSource`, `NetworkSource`.
- Bindings **remappables** (`Bindings` = objet JSON : action → liste d'entrées), valeurs par défaut dans `src/input/defaultBindings.ts`,
  persistance optionnelle dans `localStorage` (try/catch).
- Clavier J1 : flèches = déplacement, `Espace` = action (déclenche attack + interact + revive en même temps ; la simulation
  arbitre : relevage si un allié à terre est à portée > interaction si un mécanisme est à portée > attaque). Alternatives : `W/A/S/D` + `E`
  pour une seconde disposition (même joueur, aide au confort).
- **Attaque spéciale** : action `special` (clavier `F` ou `X`, manette `Y`, `RB` ou `RT`) ; jamais mêlée à l'action contextuelle.
- Manettes : stick gauche/croix = déplacement, `A` (bouton 0) = action contextuelle (attack+interact+revive), `X` (2) = attaque seule,
  `B` (1) = interact+revive, `Y` (3) = spécial. Dead-zone 0.25. Manettes non « standard » : mappage de repli signalé dans l'UI.
- **Attribution par réclamation d'emplacement** (écran de sélection) : chaque emplacement 1..N est libre jusqu'à ce qu'un appareil le réclame
  (A / Entrée / Espace) ; B / Échap annule « prêt » ou relâche l'emplacement ; un appareil = un emplacement ; le clavier peut occuper n'importe quel
  emplacement ; 4 joueurs peuvent jouer chacun à la manette. La sélection est appliquée à `inputManager.assignDevice` avant l'intro du niveau.
  Les attributions par défaut (J1 clavier, J2..J4 manettes d'indice 0..2, solo « première source utilisée ») ne subsistent que dans
  `InputManager` pour le démarrage rapide (`?quick=1`, `&pads=1`, `&kb=<n>`). L'option de menu « J1 = manette » a été remplacée par ce choix.
- Sources lisent l'état « tenu » ; aucune logique de jeu.

## 6. i18n

- `src/i18n/fr.json` et `en.json` : objets **plats** (clés pointées → chaîne). Aucune chaîne en dur dans `src/` (hors clés).
- API : `t(key, params?)` (paramètres `{name}`), `setLanguage('fr'|'en')`, `getLanguage()`, `onLanguageChange(cb)`.
  Langue persistée dans `localStorage` (try/catch). Clé manquante : retourne la clé et `console.warn` (une fois).
- Convention des clés :
  `menu.*`, `hud.*`, `select.*`, `result.*`, `hint.controls.*` (UI) ;
  `character.<id>.name|class|desc` ; `enemy.<kind>` ; `speaker.<id>` ;
  `level.<levelId>.name|intro.<n>|outro.<n>` ; `room.<levelId>.<roomId>.name` ;
  `objective.<levelId>.<objectiveId>` (libellé court) ; `mech.<levelId>.<…>` (étiquettes) ; `sign.<levelId>.<id>` ; `hintroom.<levelId>.<roomId>`.
- **Parts temporaires** : pour éviter les écritures concurrentes sur fr.json/en.json, chaque agent écrit ses clés dans
  `src/i18n/parts/<zone>.fr.json` et `src/i18n/parts/<zone>.en.json` (objets plats). À l'intégration, `npm run i18n:merge`
  (`scripts/merge-i18n.mjs`) fusionne les parts dans fr.json/en.json (tri alphabétique) puis supprime les parts.
  Un test (`i18n.test.ts`) vérifie la parité fr/en et l'absence de valeurs vides.
- Les noms de personnages familiaux (Sandrine, David, Valentine, Romain) sont des noms propres identiques en FR/EN.

## 7. Scénario et progression

Royaume de **Vaelorn**. Le **Cristal de l'Aube**, source de sa lumière, s'est brisé : l'ancien seigneur déchu **Morvane** a dispersé
ses fragments dans trois donjons. Quatre héros partent les récupérer.

| Niveau | Id | Thème | Nom FR | Contenu |
|---|---|---|---|---|
| 1 | `level1` | crypt | Les Cryptes Oubliées | Tutoriel : déplacement, attaque, relevage, 1ʳᵉ porte à plaques coopératives, clés personnelles simples. Sortie scellée à la fin (pas de boss). ~5–6 salles, 5–7 min. |
| 2 | `level2` | grove | Le Bosquet Putride | Mécanismes séparés simultanés (leviers à fenêtre, runes à vision partagée), premier boss : **Gorgrim**, golem de racines. ~6–7 salles, 6–8 min. |
| 3 | `level3` | citadel | La Citadelle de Morvane | Plus long (~8–9 salles, 8–10 min) : combine tout (plaques, leviers, clés, blocs 2 joueurs, runes), boss final **Morvane** (3 phases). |

Personnages secondaires (proposés, documentés au README) : **Maître Aldric** (archiviste du roi, donne la mission), **Lyssa** (esprit du cristal,
voix dans les fragments), **Gorgrim** (golem gardien corrompu), **Morvane**. Fin : Morvane vaincu, le Cristal est reconstitué mais Lyssa révèle
qu'une ombre plus ancienne dort sous Vaelorn (ouverture vers une suite). Chaque niveau : intro (3–5 répliques) et conclusion (2–4 répliques) qui relie à la suite.

Familles (personnages jouables inspirés de proches, stylisés heroic fantasy) :
**David** — guerrier (fort, très résistant). **Sandrine** — magicienne (très offensive, fragile). **Romain** — éclaireur (rapide, moyen).
**Valentine** — guérisseuse-archère (portée, relevage plus rapide). Libres : **Aelith** (elfe archère), **Brokk** (nain tank),
**Grok** (troll brute), **Mira** (maraudeuse, dagues rapides).

Chaque salle contient au moins un mécanisme coopératif ; chaque niveau en combine plusieurs ; chaque joueur a un objectif personnel ;
le niveau n'est terminé que quand tous les objectifs sont remplis ET que la sortie finale (boss vaincu ou porte scellée ouverte) est franchie.
Alterner : salles où il faut coopérer ensemble (plaques, bloc 2 joueurs) et salles où chacun agit séparément et simultanément (leviers distincts, clés personnelles).
Chaque mécanisme porte une indication « qui doit faire quoi » (couleur du slot sur la plaque/levier/clé + panneau/hint).

## 8. Flot des scènes

`Boot` (génère l'atlas, charge i18n) → `Menu` (nb joueurs 1–4, difficulté par joueur 1–3, langue FR/EN, jouer) →
`CharacterSelect` (chaque joueur choisit un personnage unique, avec stats force/résistance) → `Dialogue` (intro niveau) →
`Game` (+ `Hud`) → `Dialogue` (outro) → niveau suivant, ou `Result` (fin) / retour menu.
Les scènes se passent un objet `GameSession` (voir `src/render/session.ts`) via `scene.start(key, data)` :
`{ playerCount, players: PlayerSetup[], levelIndex, language }` — sérialisable.

## 9. Déviations

- **Salles de boss sans mécanisme** : les deux salles de boss (niveau 2 « arene », niveau 3 « throne »/« arena » selon le cas) n'ont pas de
  mécanisme coopératif propre (règle « chaque salle en utilise au moins un » assouplie : `levelValidation` admet la « salle de boss pure »).
  Les objectifs personnels du niveau y sont néanmoins répartis (zone à tenir, kills…).
- **Objectifs « kills » accomplis d'office** : si la salle est vidée (aucun ennemi vivant ni en attente d'apparition) alors qu'un objectif
  `kills` n'est pas accompli, il s'accomplit d'office (`roomCleared` dans `updateObjectives`) : évite un blocage définitif quand les autres joueurs
  achèvent tous les ennemis.
- **Attaque spéciale** (ajout) : une par personnage, recharge 9–20 s, `special` dans `ActionFrame` ; plafond de dégâts par fenêtre sur les boss.
- **Torches** (ajout) : `RoomDef.dark`, `PlayerState.torchMs`, mécanisme `brazier`, jeton d'exigence `enter:<zoneId>`, couche d'obscurité
  (`src/render/darkness.ts`). Un brasero est solide (il bloque aussi les projectiles).
- **i18n** : les « parts » temporaires ont été fusionnées dans `fr.json`/`en.json` (`npm run i18n:merge`) ; le mécanisme de parts reste
  disponible (fusion automatique sous Vite/Vitest via `import.meta.glob`).
- **Entrées** : voir §5 (réclamation d'emplacement, plus d'option « J1 = manette »).
