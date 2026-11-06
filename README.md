# Les Fragments de l'Aube

Dungeon crawler **coopératif local** (1 à 4 joueurs sur le même écran), en vue de dessus, inspiré de *Zelda* (A Link to the Past / Link's Awakening), dans un univers d'heroic fantasy. Pixel art placeholder généré par code, **Phaser 3 + TypeScript + Vite**. Cible : PC (navigateur) ; conçu pour être porté sur Android et accueillir du multijoueur en ligne plus tard.

> Le royaume de **Vaelorn** a perdu son **Cristal de l'Aube**, source de sa lumière. L'ancien seigneur déchu **Morvane** en a dispersé les fragments dans trois donjons. Quatre héros sont envoyés les récupérer.

## Lancer le jeu

Prérequis : Node.js ≥ 20.19 (ou ≥ 22.12) — exigence de Vite 7.

```bash
npm install
npm run dev
```

Puis ouvrir <http://localhost:5173>. Autres commandes :

| Commande | Rôle |
|---|---|
| `npm run build` | Typecheck + build de production dans `dist/` (fichiers statiques, chemins relatifs) |
| `npm run preview` | Sert `dist/` en local |
| `npm test` | Tests unitaires (Vitest) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run i18n:merge` | Fusionne d'éventuels fichiers `src/i18n/parts/*.json` dans `fr.json`/`en.json` |

Paramètres d'URL de développement : `?quick=1&players=2&level=2&chars=david,sandrine&diff=1,2&lang=fr&room=3` (saute les menus), `&pads=1` (tous les joueurs sur manettes 0..N-1), `&kb=<n>` (le joueur n au clavier), `&dark=1` (force toutes les salles sombres, pour tester les torches).

### Déployer

Le jeu est un site **statique** : aucun serveur applicatif. Attention : les navigateurs ne donnent accès aux **manettes qu'en contexte sécurisé (HTTPS ou `localhost`)**.

- **GitHub Pages (le plus simple)** : le workflow `.github/workflows/deploy.yml` teste, construit et publie à chaque push sur `main`. Activer une fois *Settings → Pages → Source : GitHub Actions*.
- **PC du salon** : `npm run dev` (ou `npm run build && npm run preview`) puis `http://localhost:…` — les manettes fonctionnent.
- **Home Assistant** : copier le contenu de `dist/` dans `/config/www/vaelorn/` → `/local/vaelorn/index.html` ; les manettes ne marcheront que si l'accès est en HTTPS.

Diagnostic des manettes : ouvrir `/gamepad-test.html` (liste les manettes détectées, boutons et axes en direct).

## Contrôles

Chaque joueur **rejoint** sa place à l'écran de sélection en appuyant sur **A** (manette) ou **Entrée/Espace** (clavier) : tout le monde peut jouer à la manette, sans clavier. Un appareil = un joueur. Le clavier peut occuper n'importe quelle place.

| Action | Clavier | Manette |
|---|---|---|
| Se déplacer | Flèches (ou ZQSD/WASD) | Stick gauche / croix |
| **Action** (relever un allié > interagir > attaquer, selon le contexte) | Espace (ou E) | **A** |
| Attaque seule | — (Espace fait l'action contextuelle) | **X** |
| Interagir / relever seulement | — | **B** |
| **Attaque spéciale** (rechargeable) | **F** ou **X** | **Y**, **RB** ou **RT** |
| Pause | Échap | Start |

Les menus se pilotent aux mêmes entrées (flèches/croix, Entrée/A, Échap/B). Les boutons sont remappables côté code (`src/input/defaultBindings.ts`, persistance `localStorage`).

## Règles du jeu

- **1 à 4 joueurs**, écran splitté : 1 plein écran, 2 moitiés, 3 quadrants (+ panneau d'équipe), 4 quadrants. Chaque joueur a sa caméra, un marqueur de couleur (bleu, rouge, vert, jaune) et son HUD dans sa vue.
- **Difficulté par joueur** (1 facile, 2 normal, 3 difficile) : n'influence **que** les PV et les dégâts des ennemis — jamais leur nombre, les mécanismes ni les PV des joueurs.
- **PV, relevage, défaite** : à 0 PV un joueur est **à terre** (ne bouge plus, ne peut pas être achevé). Un allié le relève en restant immobile à côté en **maintenant l'action ~3 s** ; le sauveteur reste vulnérable (s'il tombe, le relevage est interrompu) ; un ennemi proche ralentit le relevage ; relevage illimité, PV pleins au retour. Tous à terre = défaite : retour au début de la **salle en cours**, salles validées conservées.
- **Attaque spéciale** : chaque personnage en a une, nettement plus puissante que l'attaque normale, qui se recharge (9 à 20 s).
- **Objectifs personnels** : chaque joueur a son objectif (clé, levier, zone à tenir, ennemis à vaincre…). Le niveau n'est terminé que lorsque **tous** sont remplis ET la sortie finale franchie (boss vaincu ou porte scellée ouverte).
- **Objectifs « ennemis à vaincre »** : si la salle est vidée avant que le propriétaire ait ses coups, l'objectif s'accomplit d'office (pas de blocage).
- **Coopération adaptative** : tous les niveaux sont faisables à 1, 2, 3 ou 4 joueurs (`minPlayers`, slots repliés `slot % nbJoueurs`, blocs poussables par `min(2, n)` joueurs…).
- **Mécanismes coopératifs** : plaques de pression simultanées, leviers séparés à fenêtre de temps, clés personnelles (une clé = une porte = un joueur), blocs 2×2 poussés à deux vers un socle, vision partagée (un joueur voit une séquence de runes que les autres doivent saisir), braseros.
- **Torches** : certaines salles sont **sombres**. Chaque joueur porte une torche dont le combustible s'use (75 s) ; il faut la recharger aux **braseros allumés** (action à côté), sinon on ne voit presque rien. Des braseros éteints peuvent être allumés avec sa torche.

## Personnages

8 personnages jouables (chacun unique dans une partie), force et résistance différentes, plus une attaque spéciale. Les quatre premiers sont inspirés de la famille (stylisés heroic fantasy, pas des portraits).

| Personnage | Classe | Force | Résist. | Vitesse | Spécial (recharge) |
|---|---|---|---|---|---|
| **David** (famille) | Guerrier | 8 | 9 | 68 | Tourbillon d'acier — 360° (14 s) |
| **Sandrine** (famille) | Magicienne | 10 | 2 | 72 | Nova ardente — explosion de feu (18 s) |
| **Romain** (famille) | Éclaireur | 5 | 5 | 106 | Ruée de l'éclaireur — charge invulnérable (9 s) |
| **Valentine** (famille) | Guérisseuse-archère | 4 | 4 | 80 | Lumière salvatrice — soigne les alliés (20 s) ; relève 35 % plus vite |
| Aelith | Elfe archère | 7 | 3 | 86 | Volée d'étoiles — 9 flèches (13 s) |
| Brokk | Nain protecteur | 6 | 10 | 58 | Séisme — onde de choc qui étourdit (16 s) |
| Grok | Troll | 9 | 7 | 54 | Fracas du troll — énorme coup en cône (17 s) |
| Mira | Maraudeuse | 6 | 3 | 102 | Danse des lames — rafale invulnérable (12 s) |

Personnages secondaires (proposés) : **Maître Aldric** (archiviste du roi, donne la mission), **Lyssa** (esprit du Cristal, voix dans les fragments), **Gorgrim** (golem de racines, boss du niveau 2), **Morvane** (boss final). **Fin** : Morvane vaincu, le Cristal est reconstitué et l'aube revient sur Vaelorn — mais Lyssa révèle qu'une ombre plus ancienne dort sous le royaume (ouverture vers une suite).

## Niveaux

| # | Donjon | Thème | Contenu |
|---|---|---|---|
| 1 | Les Cryptes Oubliées | crypte | Tutoriel : déplacement, attaque, plaques coopératives, relevage, clés personnelles, leviers, première salle sombre ; sortie scellée |
| 2 | Le Bosquet Putride | bosquet | Leviers séparés simultanés, runes à vision partagée, boss **Gorgrim** |
| 3 | La Citadelle de Morvane | citadelle | Combine tout, blocs à deux joueurs, plusieurs salles sombres, boss final **Morvane** (3 phases) |

Chaque niveau dure environ 7 à 10 minutes ; les salles sont grandes (la caméra défile) et peuplées de groupes d'ennemis.

## Structure du code

```
src/core/      LOGIQUE PURE (aucune dépendance à Phaser/DOM, ni Math.random/Date) — déterministe, état JSON sérialisable
  types.ts       tous les contrats (GameState, LevelDef, MechanismDef, SimEvent, …)
  simulation.ts  GameSimulation : step(dt, inputs) → événements ; serialize()/restore()
  players.ts     PV, relevage, mort d'équipe, torche ; balance.ts : formules d'équilibrage
  mechanisms.ts  plaques, leviers, clés, portes, blocs, runes, braseros ; objectives.ts ; levelValidation.ts
  combat.ts, collision.ts, ai.ts, bosses.ts, characters.ts, enemies.ts, light.ts, rng.ts, geometry.ts, grid.ts
src/levels/    niveaux en données TS typées (level1.ts, level2.ts, level3.ts, index.ts)
src/input/     couche d'abstraction des entrées : ActionFrame par joueur (clavier, manettes, réseau/tactile plus tard)
src/net/       interface NetAdapter (prévue, sans implémentation réseau)
src/i18n/      fr.json, en.json, i18n.ts (clés plates, aucune chaîne en dur dans le code)
src/render/    atlas de sprites runtime (art/), palettes, splitscreen, caméras, HUD, obscurité, effets
src/entities/  vues Phaser (joueurs, ennemis, mécanismes, salle) — lecture seule de GameState
src/scenes/    Boot, Menu, CharacterSelect, Dialogue, Game, Result
src/testing/   bots de test qui jouent la simulation (déterministes)
docs/          DESIGN.md (architecture détaillée), SPRITES.md (sprites à remplacer)
```

Principe : **Phaser ne décide d'aucune règle**. `GameScene` accumule le temps réel, appelle `sim.step()` à pas fixe (60 Hz) avec les `ActionFrame` des joueurs, puis synchronise des sprites avec `GameState` et joue les `SimEvent`.

### Ajouter un niveau

1. Créer `src/levels/level4.ts` exportant un `LevelDef` (salles en grilles de caractères : `#` mur, `.` sol, `,` sol variante, `o` pilier, `~` fosse ; mécanismes, ennemis, objectifs, panneaux, sortie ; voir `level1.ts` comme modèle).
2. L'ajouter à la liste `LEVELS` de `src/levels/index.ts`.
3. Écrire ses textes (`level.level4.*`, `room.level4.*`, `objective.level4.*`, `sign.level4.*`, …) dans `fr.json` et `en.json`.
4. Écrire un test qui appelle `validateLevel(level4, { dictionaries: { fr, en }, checkSpeakers: true })` (voir `src/levels/level1.test.ts`) : il vérifie ids, géométrie, atteignabilité à 1..4 joueurs, clés i18n, etc.

### Équilibrage

Toutes les formules sont centralisées et commentées dans `src/core/balance.ts` (PV max = 50 + 10 × résistance ; réduction de dégâts 2 % × résistance ; dégâts de base = 6 + 2,5 × force ; multiplicateurs de difficulté PV ennemis ×0,7/1/1,4 et dégâts ennemis ×0,6/1/1,5). Statistiques des personnages : `src/core/characters.ts` ; des ennemis : `src/core/enemies.ts`. Ce sont des valeurs de premier jet, à affiner en jouant.

### Sprites à remplacer

Tous les sprites sont des **placeholders** générés par code (`src/render/art/`), assemblés dans un atlas unique (`atlas`) avec une échelle de pixel commune et une palette par donjon. La liste complète des frames, tailles et noms à respecter pour les remplacer par de vrais assets est dans **[docs/SPRITES.md](docs/SPRITES.md)**.

## Portage futur (Android)

**Prêt** : logique de jeu totalement séparée du rendu et des entrées (`src/core`) ; entrées abstraites en `ActionFrame` (un `TouchSource` se branche comme les autres sources) ; build statique à chemins relatifs (`base: './'`), compatible Capacitor ; aucune dépendance à des API de bureau côté `core`.
**Reste à faire** : contrôles tactiles (stick virtuel + boutons action/spécial) ; packaging Capacitor (Android Studio, icônes, écran de démarrage) ; orientation paysage verrouillée ; adaptation aux tailles d'écran et densités (le canvas est en 1280×720 avec `Phaser.Scale.FIT`) ; HUD et splitscreen pensés pour un petit écran (probablement 1–2 joueurs sur téléphone, plus sur tablette/TV) ; test de performances sur appareils modestes ; manettes Bluetooth via la Gamepad API du WebView.

## Multijoueur en ligne futur

- **L'état de jeu est sérialisable** : `GameState` est du JSON pur (aucune classe, `Map` ni fonction), `GameSimulation.serialize()/restore()` fonctionne, la simulation est déterministe (PRNG dans l'état, pas d'horloge) et avance par pas fixe.
- **À envoyer au serveur / aux pairs** : uniquement les `ActionFrame` de chaque joueur par tick (déplacement, attaque, interaction, relevage, spécial) ; en retour, soit les entrées des autres joueurs (lockstep), soit des instantanés/diffs de `GameState` (hôte autoritaire). `src/net/NetAdapter.ts` et `RemoteInputSource` posent l'interface.
- **À décider** : modèle (lockstep déterministe vs serveur autoritaire avec prédiction/réconciliation), transport (WebRTC pair-à-pair vs WebSocket + relais), appariement (salons, codes de partie), gestion de la latence et des déconnexions/reconnexions en cours de partie, versionnage du protocole et des niveaux, triche, découpage splitscreen local + joueurs distants.

## Choix et déviations documentés

- Textes : tout passe par `t('clé')` ; fichiers plats `fr.json`/`en.json`. Les noms propres des quatre membres de la famille sont identiques dans les deux langues.
- Coopération adaptative et slots (voir plus haut) pour que 1 joueur puisse tout finir.
- Les manettes ne sont accessibles qu'en HTTPS/localhost (limite des navigateurs).
- Détails d'architecture et conventions : [docs/DESIGN.md](docs/DESIGN.md).

- Les deux salles de boss n'ont pas de mécanisme propre (assouplissement de « chaque salle en utilise au moins un »), voir DESIGN §9.

## Licence

À définir.
