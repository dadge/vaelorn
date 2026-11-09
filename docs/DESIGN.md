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
  `KeyboardSource`, `GamepadSource` implémentent l'interface ; la **manette virtuelle** tactile (`VirtualPad`, `src/mobile/touchControls.ts`) est une manette standard injectée via `registerExtraGamepad` (pas de `TouchSource`) ; plus tard `NetworkSource`.
- Bindings **remappables** (`Bindings` = objet JSON : action → liste d'entrées), valeurs par défaut dans `src/input/defaultBindings.ts`,
  persistance optionnelle dans `localStorage` (try/catch).
- Clavier J1 : flèches = déplacement, `Espace` = action (déclenche attack + interact + revive en même temps ; la simulation
  arbitre : relevage si un allié à terre est à portée > interaction si un mécanisme est à portée > attaque). Alternatives : `W/A/S/D` + `E`
  pour une seconde disposition (même joueur, aide au confort).
- **Attaque spéciale** : action `special` (clavier `F` ou `X`, manette `Y` seul) ; jamais mêlée à l'action contextuelle.
- **Appel** : action `call` (clavier `C`, manette `X` seul), champ optionnel `ActionFrame.call`, front montant détecté par la simulation (bouton dédié, jamais mêlé à l'action contextuelle).
  Règles dans le cœur (`CALL_FREEZE_MS` 1 s d'immobilisation, `CALL_DURATION_MS` 3 s de signal, `CALL_COOLDOWN_MS` 5 s depuis l'appui ; `PlayerState.callMs` / `callCooldownMs` ;
  événement `callStarted`) ; rendu pur dans `src/render/callIndicator.ts` (projection au bord via `edgeIndicator`, phases des 3 arcs, point au bord, anneaux du monde), dessin dans `callHud.ts`.
- Manettes (schéma à TROIS boutons) : stick gauche/croix = déplacement ; `A` (bouton 0) = action contextuelle (attack+interact+revive) ;
  `X` (2) = appel ; `Y` (3) = spécial ; `Start` (9) = pause (lu par `GameScene.pollPadStart`, hors bindings). TOUS les autres boutons
  (B, LB, RB, LT, RT, Back hors tutoriel, appuis de sticks, Home) sont SANS EFFET en jeu. Exceptions hors jeu : dans les menus A = confirmer et B = retour ;
  `Back / Select` (8) = « passer » du tutoriel (`GameScene.pollTutorialPad`). Dead-zone 0.25. Manettes non « standard » : mappage de repli
  (mêmes indices 0 / 2 / 3) signalé dans l'UI. Manette virtuelle tactile : A / B / X / Y envoient les VRAIS boutons 0 / 1 / 2 / 3, pause = Start.
  Persistance des bindings : clé `vaelorn.bindings.v2` ; l'ancienne clé `v1` (ancien schéma) est ignorée.
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
ses fragments dans les profondeurs du royaume. Quatre héros partent les récupérer, à travers six niveaux.

| Niveau | Id | Thème | Nom FR | Contenu |
|---|---|---|---|---|
| 1 | `level1` | crypt | Les Cryptes Oubliées | Tutoriel : déplacement, attaque, relevage, 1ʳᵉ porte à plaques coopératives, clés personnelles simples. Sortie scellée à la fin (pas de boss). ~5–6 salles, 5–7 min. |
| 2 | `level2` | grove | Le Bosquet Putride | Mécanismes séparés simultanés (leviers à fenêtre, runes à vision partagée), premier boss : **Gorgrim**, golem de racines. ~6–7 salles, 6–8 min. |
| 3 | `level3` | citadel | La Citadelle de Morvane | Plus long (~8–9 salles, 8–10 min) : combine tout (plaques, leviers, clés, blocs 2 joueurs, runes), boss **Morvane** (3 phases). |
| 4 | `level4` | frost | Les Cavernes de Givre | Statue jumelle, salle sombre, deux demi-boss (gardien de givre), boss **reine du givre** (voir §10). |
| 5 | `level5` | ember | Les Forges Ardentes | Sablier partagé, bloc 2×2, salle sombre, deux demi-boss pyromanciens, boss **seigneur de la forge** (voir §10). |
| 6 | `level6` | void | Les Abysses du Néant | **Dernier niveau** (9 salles, ~9–10 min) : pont de lumière (porteur de lanterne par slot, repris par le joueur vivant le plus proche s'il tombe), salles sombres, embuscades de rive d'arrivée, deux demi-boss spectres, boss final **Seigneur du Néant** (voir §10). |

Personnages secondaires (proposés, documentés au README) : **Maître Aldric** (archiviste du roi, donne la mission), **Lyssa** (esprit du cristal,
voix dans les fragments), **Gorgrim** (golem gardien corrompu), **Morvane**, **le Seigneur du Néant**. Fin : Morvane vaincu, Lyssa révèle
qu'une ombre plus ancienne dort sous Vaelorn ; au niveau 6 les héros la vainquent (le Seigneur du Néant), le Cristal rayonne enfin sans ombre et le jeu
se termine (plus d'« à suivre »). Chaque niveau : intro (3–5 répliques) et conclusion (2–4 répliques) qui relie à la suite.

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

### Sauvegarde et reprise (ajout)

Sauvegarde de progression : `src/core/save.ts` (format `SaveGame`, validation, migrations v0 → v1 → v2, mises à jour « salle atteinte » /
« niveau terminé »), `src/core/saveRepository.ts` (`SaveRepository` + `LocalStorageSaveRepository` / `MemorySaveRepository`),
`src/core/autoSave.ts` (`AutoSaver` : branché sur les `SimEvent` `roomEntered` start|next et `levelCompleted`, jamais sur `restart`),
`src/render/saveMenuLogic.ts` (règles du menu et des dialogues, testables), `src/render/saveStore.ts` (dépôt par défaut = localStorage).
`SimConfig.startRoomIndex` (optionnel) fait démarrer la simulation dans une salle donnée. `Menu` → « Continuer » → `CharacterSelect`
en mode `resume` (équipe verrouillée, seuls les appareils sont attribués) → `Game` (ou `Dialogue` d'intro si reprise en salle 0).
`GameSession.completedLevelIds` porte les niveaux terminés d'un niveau à l'autre. Détails et choix : README « Sauvegarde de la progression ».

## 8 bis. Tutoriel

Un tutoriel jouable (« La cour d'entraînement ») explique toutes les mécaniques en les faisant faire. Principe : **un niveau-données joué par `GameScene` avec 2 joueurs simulés pour UNE vue**, un partenaire scripté, et un directeur pur qui observe la simulation.

- **Niveau** : `src/levels/tutorial.ts` (`tutorialLevel`, id `tutorial`, graine fixe `TUTORIAL_SEED`). Il n'est **jamais** dans `LEVELS` : ni campagne, ni sauvegarde (`saveContextFromLevels(LEVELS)` ne le connaît pas, `GameScene` ne construit pas d'`AutoSaver`, `isSavingAllowed({ tutorial: true })` → false). Il est validé par `validateLevel` comme les autres (chaque salle a un vrai mécanisme ou un brasero allumé de décor ; intro/outro jamais jouées mais exigées ; 4 objectifs couvrant les slots 0-3 : avec 2 joueurs, slots 0 et 2 → joueur, 1 et 3 → partenaire).
- **Logique pure** (`src/tutorial/`, aucune dépendance à Phaser/DOM/Date/Math.random) : `TutorialDirector` (une étape de `steps.ts` à la fois, validée par une `Condition` sur l'état/les événements ; temps = temps de SIMULATION ; état JSON : `snapshot()` / `restore()`), `partnerScript.ts` (mini machine virtuelle qui produit une `ActionFrame` par pas pour le joueur 1 : marche en ligne droite sur la rangée 6, tient une plaque, appuie une impulsion d'un pas, appelle toutes les ≥ 5,2 s, relève le joueur à terre ; il n'attaque jamais), `deviceHints.ts` (appareil et libellés de boutons par appareil). Le partenaire est piloté À CHAQUE pas de simulation (`decorate` dans la boucle de pas de `GameScene`), jamais via `mergeTickInputs`.
- **Changement du cœur (minimal, déterministe, testé)** : `markPlayerDown` (extrait de `applyDamageToPlayer`, comportement identique) et `GameSimulation.knockDown(id)` (hors `IGameSimulation`, à appeler ENTRE deux pas ; l'événement `playerDown` sort au pas suivant). Nécessaire parce qu'aucune `ActionFrame` ne peut mettre un joueur à terre et qu'une chute provoquée par un ennemi serait non déterministe (invulnérabilité, difficulté) ; muter `sim.state` depuis la scène contournerait `downCount`, l'annulation d'appel et l'événement. `step()` et `IGameSimulation` ne changent pas. Si un réseau est ajouté un jour, `knockDown` devra devenir une entrée datée.
- **Écarts assumés** : joué à 2 joueurs (en solo de campagne, plaque B / relevage / appel n'ont pas d'effet : la carte de fin le dit) ; bloc poussable à 1 héros (`playersRequired: 1`) ; une seule vue (zoom 3) donc le HUD enseigné est celui « 1 joueur » ; pas de vue du partenaire (le joueur voit l'indicateur réel quand il l'appelle) ; le partenaire ne combat pas ; pas de drapeau « tutoriel déjà vu » (rien n'est écrit).
- **Saut** : par étape (Entrée / Select / puce) ; sur une étape de sortie ou après 45 s sans progrès : relance de la scène à `startRoomIndex = roomIndex + 1` (les salles et objectifs précédents sont considérés faits par `createSimulation`). Les opérations « essentielles » du partenaire des étapes sautées sont conservées (backlog).

## 8 ter. Mode démo (attract mode)

Flux : `Menu` (écran-titre principal, minuterie d'inactivité `IdleTimer`) → `Game` avec `session.demo` (pilote automatique `DemoPilot`, aucune
entrée humaine dans la simulation, ni sauvegarde ni pause) → `Menu` (`afterDemo`, entrées avalées pendant une fenêtre de grâce). Toute
la logique de `src/attract/` est PURE (horloge et hasard injectés, aucun accès à Phaser / DOM sauf `ActivityWatcher`, couche fine) ; le
coeur (`src/core`) n'est pas modifié et ne voit jamais `Math.random` : seule `MenuScene` tire au hasard (`buildDemoSession(Math.random)`).
Détail, durées et paramètres d'URL : README « Mode démo (attract mode) ».

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

## 10. Demi-boss et boss des niveaux 4-6

Six ennemis à IA de boss (`src/core/bosses.ts` = moteur, `src/core/bossData.ts` = données : attaques, séquences par phase, profils).
Un **demi-boss** (`EnemyDef.isMiniBoss`, `isBoss = false`) est à vaincre dans sa salle (la sortie `'clear'` reste fermée tant qu'il vit,
sbires invoqués compris) ; un **boss de fin** (`isBoss`) a une barre de boss. Helpers pour le rendu et les niveaux (`enemies.ts`) :
`isBossKind`, `isMiniBossKind`, `isAnyBossKind`, `isFlyingKind`, listes `BOSS_KINDS` / `MINI_BOSS_KINDS` / `FLYING_KINDS`.
Clés i18n : `enemy.<kind>` (nom) et `enemy.<kind>.desc` (`src/i18n/parts/bosses.{fr,en}.json`).

| Ennemi | Niv. | Rôle | PV | Dégâts | Phases (seuils) | Particularités |
|---|---|---|---|---|---|---|
| `warden` gardien de givre | 4 | demi-boss | 270 (≈ 3 × chevalier) | 16 | 2 (rage à 50 %) | mêlée : coup lourd (zone 24 px à 18 px devant), coup de sol (zone 46 px ; + 10 éclats en rage), charge télégraphée ≥ 900 ms ; rage = ×1,35 vitesse, coup lourd enchaîné |
| `frostqueen` reine du givre | 4 | boss de fin | 1600 | 20 | 3 (70 / 40 %) | éventail de 5 (9 en phase 3) éclats, blizzard = anneau avec 2 brèches, invoque chauves-souris/squelettes (≤ 4), téléportation dès la phase 2, glissade avec trace d'éclats en phase 3 |
| `pyromancer` pyromancien | 5 | demi-boss | 320 | 14 | 2 (50 %) | garde ses distances (85-140 px), boules de feu en éventail (3, puis 5), nova télégraphée (zone 46 px + 12/16 orbes) lancée aussi en « panique » si on le colle, se replie en se téléportant après la nova, invoque ≤ 2 feux follets |
| `forgelord` seigneur de la forge | 5 | boss de fin | 1900 | 24 | 3 (70 / 35 %) | marteau (zone 36 px à 30 px devant) + onde de choc (14/16/20 orbes), rafale balayée de 6/8/10 boules de feu, invoque ≤ 2 chevaliers (phases 1-2 seulement), phase 3 « enrage » : ×1,45 vitesse, marteaux enchaînés, charge |
| `wraith` spectre | 6 | demi-boss, **volant** | 380 | 16 | 2 (50 %) | éventail de traits sombres (3, puis 5), anneau d'orbes en rage, disparaît/réapparaît (téléportation de 560 ms, destination connue) après chaque attaque |
| `voidlord` seigneur du Néant | 6 | boss de fin, **volant** | 2000 | 17 | 4 (75 / 50 / 25 %) | traits sombres, anneaux (18-24), spirales (2 puis 3 bras), **zones de danger** (2-3 cercles posés sous les joueurs, verrouillés puis persistants 1,4 s), invoque ≤ 3 chauves-souris/feux follets (phases 2-3), charge, téléportation après chaque attaque |

Règles communes (équité, 1 à 4 joueurs) :
- toute attaque est précédée d'un télégraphe (`windup`) d'au moins 600 ms ; fenêtres de récupération ×1,2 à 1 joueur, ×1,1 à 2 ; phase suivante = rugissement d'1 s sans attaque ;
- jamais étourdis ni repoussés (`stunEnemy`/`knockEnemy` : simple retard d'attaque ≤ 400 ms) ; aggro illimité une fois engagés ;
- invocations : plafond de sbires **vivants** par boss (les sbires invoqués portent `data.summoner` = id du boss ; seuls ceux-là comptent) ; la salle est limitée à `MAX_ALIVE_ENEMIES` ;
- la difficulté (1-3) n'est lue nulle part dans l'IA : le nombre d'ennemis, les attaques et les invocations sont identiques, seuls PV (÷ 0,7 / 1 / 1,4 sur les dégâts infligés) et dégâts reçus (× 0,6 / 1 / 1,5) changent ;
- **plafond de dégâts glissant** (`combat.damageEnemy`, état dans `enemy.data.dmgWinStartMs/dmgWinTaken`, fenêtre 2 s) : 20 % des PV max pour un boss de fin (`BOSS_DAMAGE_CAP_FRACTION`), 35 % pour un demi-boss (`MINIBOSS_DAMAGE_CAP_FRACTION`) ;
- une salle de demi-boss compte comme salle de boss : après un redémarrage, les spéciaux repartent à demi-recharge.

Équilibrage vérifié par `src/core/miniBosses.test.ts` (4 joueurs de difficulté 2, toutes les équipes possibles de 4 personnages, boss immobile et
tous les joueurs à portée) : en n'enchaînant que les spéciaux, le pire cas est ≈ 17 s pour un demi-boss (cible ≥ 12 s) et ≈ 36 s / 48 s / 52 s pour la reine
du givre / le seigneur de la forge / le seigneur du Néant (cible ≥ 35 s) ; en frappant sans arrêt avec attaques normales + spéciaux, le plafond impose ≥ 4 s
(demi-boss) et ≥ 9 s (boss). Un joueur seul de difficulté 3 vient à bout de chacun (< 45 s / < 150 s d'attaque continue idéale).

Données `enemy.data` utiles au rendu (en plus de celles de `ai.ts`) : `special` (`ENEMY_SPECIALS`, ajouts : SHOCKWAVE 16, FIREBALL 17, NOVA 18, DARKBOLT 19,
VOIDZONE 20, BLIZZARD 21, SLIDE 22), `telegraphRadius/Dist/Length/Spread`, `teleportToX/Y`, et pour VOIDZONE `zoneCount`, `zoneX0..2`, `zoneY0..2`,
`zoneRadius`. Projectiles utilisés : `shard` (glace), `orb` (feu / néant), `bolt` (traits sombres).
