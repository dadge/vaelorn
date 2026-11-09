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

Paramètres d'URL de développement : `?tutorial=1[&room=N]` (lance directement le [tutoriel](#tutoriel)), `?quick=1&players=2&level=2&chars=david,sandrine&diff=1,2&lang=fr&room=3` (saute les menus), `&pads=1` (tous les joueurs sur manettes 0..N-1), `&kb=<n>` (le joueur n au clavier), `&dark=1` (force toutes les salles sombres, pour tester les torches), `&smooth=0|1` (rendu : `1` = adouci, par défaut ; `0` = pixels francs ; le choix est mémorisé dans `localStorage['vaelorn.smooth']`), `&nosave=1` (la partie n'écrit pas la sauvegarde : voir [Sauvegarde de la progression](#sauvegarde-de-la-progression) ; le mode `quick` et `dark` ne sauvegardent jamais non plus).

### Déployer

Le jeu est un site **statique** : aucun serveur applicatif. Attention : les navigateurs ne donnent accès aux **manettes qu'en contexte sécurisé (HTTPS ou `localhost`)**.

- **GitHub Pages (le plus simple)** : le workflow `.github/workflows/deploy.yml` teste, construit et publie à chaque push sur `main`. Activer une fois *Settings → Pages → Source : GitHub Actions*.
- **PC du salon** : `npm run dev` (ou `npm run build && npm run preview`) puis `http://localhost:…` — les manettes fonctionnent.
- **Home Assistant** : copier le contenu de `dist/` dans `/config/www/vaelorn/` → `/local/vaelorn/index.html` ; les manettes ne marcheront que si l'accès est en HTTPS.

### Application installable (PWA) et hors ligne

Le jeu est une **PWA** (*Progressive Web App*) : on peut l'installer sur l'écran d'accueil / le bureau et il se lance ensuite **sans connexion**.

- **Installer** : Chrome (PC ou Android) → menu ⋮ → *Installer l'application* / *Ajouter à l'écran d'accueil* (ou l'icône d'installation dans la barre d'adresse). Sur iPhone/iPad (Safari) : *Partager → Sur l'écran d'accueil*. Il faut **HTTPS** (GitHub Pages convient) ou `localhost`.
- **Hors ligne** : au premier chargement, un *service worker* (`sw.js`, généré au build par `scripts/pwa-build.mjs`) met en cache **tous** les fichiers du jeu. La page est ensuite servie depuis le cache si le réseau est coupé ou lent (> 4 s) ; en ligne, c'est toujours la version la plus récente qui est chargée. Les sauvegardes (`localStorage`) restent locales à l'appareil.
- **Mises à jour** : chaque déploiement change la version du cache (hash du contenu du build) ; la nouvelle version s'active dès le prochain chargement et supprime l'ancien cache. Pour forcer : fermer et rouvrir l'application.
- **Réglages** : `public/manifest.webmanifest` (nom, couleurs, plein écran, orientation paysage). Les icônes (`public/icons/`) sont générées par `node scripts/make-icons.mjs` (soleil levant et fragments) ; refaire cette commande seulement pour changer le dessin.
- Le service worker n'est **pas** enregistré en développement (`npm run dev`). Pour l'essayer : `npm run build && npm run preview`, puis ouvrir `http://localhost:4173` dans Chrome (le navigateur intégré à certains éditeurs ne gère pas les service workers).

### Sur téléphone / tablette

Le jeu s'adapte à l'écran (canvas 16:9 centré, `Scale.FIT`) et se joue en **paysage**.

- **Zone visible** : `#game` occupe exactement la fenêtre visible (`position: fixed` + marges de sécurité `safe-area` pour encoches et barres système) au lieu de `100vh`, qui dépasse sous la barre d'adresse de Chrome Android. Le canvas est recalé (`scale.refresh()`) à chaque rotation, changement de taille, apparition/disparition de la barre d'adresse et passage en plein écran.
- **Portrait** : sur un appareil tactile (pointeur principal grossier), un écran « Tourne ton téléphone » remplace le jeu (`src/mobile/`).
- **Plein écran** : bouton en haut à droite (appareil tactile seulement, absent si l'application est installée ou déjà en plein écran) ; il cache la barre d'adresse et tente de verrouiller le paysage. Sur iPhone/Safari l'API n'existe pas : installer la PWA (*Sur l'écran d'accueil*).
- **Gestes du navigateur désactivés** pendant le jeu : zoom par pincement, rafraîchir en tirant vers le bas, sélection de texte, menu contextuel. L'écran reste allumé (Screen Wake Lock) tant que la page est visible.
- **Manette virtuelle** (`src/input/VirtualPad.ts` pour la logique pure, `src/mobile/touchControls.ts` pour le DOM) : affichée sur un appareil tactile **en paysage**. À gauche, un **stick analogique** (déplacement) ; à droite, un losange de 4 boutons : **A** (action, le plus gros, en bas), **B** (à droite : « retour » dans les menus, sans effet en jeu), **Y** (en haut, attaque spéciale) et **X** (à gauche, **appeler** les alliés). Chaque bouton envoie le **vrai** bouton standard du même nom (A = 0, B = 1, X = 2, Y = 3). En haut au centre, un petit bouton **pause** (= Start). Elle est translucide au repos (~45 %), s'éclaire et grossit quand on appuie, fait vibrer brièvement (là où le navigateur le permet), suit plusieurs doigts à la fois (stick + plusieurs boutons) ; glisser un doigt hors d'un bouton le relâche. Les tailles sont relatives à l'écran (utilisable de 360 à 900 px de large, ≤ ~35 % de la largeur de chaque côté) et respectent les marges de sécurité (encoches). Il n'y a **aucune règle propre au tactile** : c'est une **manette standard virtuelle** (indice `VIRTUAL_PAD_INDEX` = 4, libellé « Manette virtuelle ») injectée dans le fournisseur de manettes (`registerExtraGamepad`), donc rejoindre la partie (A), naviguer dans les menus, la pause, l'action (A), le spécial (Y), l'appel (X) et le retour de menu (B) fonctionnent comme avec une vraie manette, sans toucher à `InputManager`, aux menus ni aux scènes.
  - **Avec une vraie manette** (Bluetooth/USB, indice 0 à 3) : la manette virtuelle se **masque** automatiquement (et se déconnecte, tous les appuis remis à zéro) ; elle réapparaît quand la vraie manette disparaît. Le joueur inscrit avec la manette virtuelle **reprend automatiquement la vraie manette** (la première que personne n'utilise), et inversement : si la vraie manette inscrite disparaît (batterie, veille), l'overlay revient et le joueur reprend la manette virtuelle (`src/input/virtualPadHandover.ts`). Sans vraie manette libre, il reste signalé « manette déconnectée » (pause, message adapté au tactile) jusqu'au retour de l'overlay ; elle est aussi masquée en portrait (invite de rotation). En **plein écran**, l'overlay suit l'élément plein écran de Phaser (il y est rattaché puis revient dans la page à la sortie).
  - **Forcer** : `?touch=1` l'affiche partout (pour tester sur PC, à la souris ; elle se masque toujours si une vraie manette est branchée), `?touch=0` la masque (même sur téléphone).
  - **Limites de la manette virtuelle** : **1 joueur par téléphone** (la manette virtuelle occupe une seule place ; pas d'écran divisé à plusieurs sur un seul téléphone : pour jouer à plusieurs, brancher d'autres manettes ou utiliser plusieurs appareils) ; à plusieurs joueurs, la manette virtuelle n'est utilisable qu'après l'inscription par bouton à l'écran de sélection (les attributions par défaut visent les manettes 0 à 3) ; **avec la seule manette virtuelle, choisir 1 joueur** au menu (à 2-4 joueurs, la sélection attend les autres places et ne démarre pas ; B pour revenir) ; les boutons ne « glissent » pas d'un bouton à l'autre (relever le doigt puis réappuyer) ; aucun retour haptique sur iPhone (l'API `vibrate` n'y existe pas).
- **Limites de l'affichage mobile** : les textes du HUD sont petits sur un téléphone (le canvas logique 1280×720 est réduit à ~0,6) et le jeu à 3-4 joueurs en écran divisé n'y est pas lisible.

Diagnostic des manettes : ouvrir `/gamepad-test.html` (liste les manettes détectées, boutons et axes en direct).

## Contrôles

Chaque joueur **rejoint** sa place à l'écran de sélection en appuyant sur **A** (manette) ou **Entrée/Espace** (clavier) : tout le monde peut jouer à la manette, sans clavier. Un appareil = un joueur. Le clavier peut occuper n'importe quelle place.

| Action | Clavier | Manette | Tactile (manette virtuelle) |
|---|---|---|---|
| Se déplacer | Flèches (ou ZQSD/WASD) | Stick gauche / croix | Stick à gauche |
| **Action** (relever un allié > interagir > attaquer, selon le contexte) | Espace (ou E) | **A** | Bouton **A** (le plus gros) |
| **Appeler** (signal vers les alliés) | **C** | **X** | Bouton **X** (à gauche dans le losange) |
| **Attaque spéciale** (rechargeable) | **F** ou **X** | **Y** | Bouton **Y** |
| Pause | Échap | **Start** | Petit bouton pause en haut au centre (= Start) |

**Manette : trois boutons de jeu seulement** (A = action, X = appeler, Y = attaque spéciale) **plus Start (pause)**. **Tous les autres boutons sont sans effet en jeu** : B, LB, RB, LT, RT, Back / Select (hors tutoriel), appuis de sticks, Home (le test `src/input/padScheme.test.ts` parcourt les 17 boutons du mapping standard). Pour la manette PlayStation, A = croix, B = rond, X = carré, Y = triangle.

Exceptions assumées, **hors jeu** :
- **Menus** (principal, sélection, pause, dialogues, résultats) : croix / stick = naviguer, **A = valider**, **B = retour** (sans B, on ne pourrait plus annuler ni libérer une place à l'écran de sélection). Au clavier : flèches, Entrée / Espace, Échap. B reste donc sans effet **en jeu** mais sert à revenir dans les menus (le bouton B de la manette virtuelle aussi).
- **Tutoriel** : **Select / Back** (manette, bouton 8) reste le « passer » de l'étape (lu par `GameScene.pollTutorialPad`, hors bindings d'action) ; A confirme la carte de fin.

Les boutons sont définis dans `src/input/defaultBindings.ts` (aucun écran de remappage). La persistance `localStorage` des bindings utilise la clé **`vaelorn.bindings.v2`** : l'ancienne clé `vaelorn.bindings.v1` (ancien schéma, avec B / X d'attaque, RB / RT de spécial, LB / LT d'appel) est **ignorée** (jamais relue ni écrasée), pour qu'une vieille sauvegarde ne ressuscite pas d'anciens boutons ni ne crée de conflit. Le rappel des commandes est affiché dans le menu **Contrôles** et dans le menu **pause**.

### Appeler (appel)

Un bouton dédié (**C** au clavier, **X** à la manette) fait « appeler » à l'équipe : les autres joueurs voient dans quelle direction tu te trouves, sans que tu aies à te montrer.

- **Déroulé** : à l'appui, le héros est **immobilisé 1 s** (`CALL_FREEZE_MS` : ni déplacement, ni attaque, ni spécial, ni interaction, ni relevage ; il peut encore subir des dégâts, sa torche continue de s'user). Le **signal dure 3 s depuis l'appui** (`CALL_DURATION_MS`, la 1re seconde étant celle de l'immobilisation : il peut donc repartir après 1 s, le signal continue 2 s de plus).
- **Délai de récupération** : 5 s **depuis l'appui** (`CALL_COOLDOWN_MS`), donc 2 s de repos après la fin du signal. Ce délai évite le spam.
- **Appel impossible** si le joueur est à terre, s'il a déjà un appel en cours, si le délai n'est pas écoulé, si la partie n'est pas en phase de jeu (salle terminée, défaite…), ou **pendant un relevage** : le relevage est prioritaire, un appui d'appel alors que le joueur relève est ignoré (il faut réappuyer une fois le relevage fini). À l'inverse, un joueur immobilisé par son appel ne peut pas commencer à relever avant la fin de la 1re seconde. L'appui d'appel **prime** sur une attaque, un spécial ou une interaction demandés au même pas (ils ne sont pas rejoués à la fin de l'immobilisation : il faut relâcher puis réappuyer). Un spécial **déjà lancé** va jusqu'au bout : les coups différés de la Danse des lames de Mira continuent de frapper pendant l'immobilisation (seuls les nouveaux déclenchements sont bloqués).
- **Annulation / remise à zéro** : l'appel s'arrête si l'appelant tombe à terre (le délai de récupération continue de courir). Appel et délai sont remis à zéro au début de chaque salle et après une défaite collective.
- **Ce que voient les autres joueurs** (l'appelant n'a pas d'indicateur de bord de son propre appel) :
  - appelant **hors de leur vue** : au bord de leur vue, dans sa direction (coins compris), un **point collé au bord** (côté de l'appelant) et **3 arcs concentriques de 90°** (rayons ≈ 10 / 18 / 26 px × échelle du HUD) qui partent de ce point **vers l'intérieur de l'écran, vers celui qui entend l'appel** (comme l'icône « signal »). Ils s'allument **chacun à leur tour du plus petit au plus grand**, en boucle (cycle 900 ms, 300 ms par arc), comme une onde sonore, à la **couleur du joueur appelant**. Même placement que les flèches vers les alliés à terre et les ennemis restants (qui ne changent pas) ; si deux indicateurs tomberaient au même endroit (moins de la largeur du grand arc le long du bord, ≈ 43 px × échelle), celui de l'appel glisse le long du bord. Le signal s'estompe sur ses 150 dernières ms. Les arcs sont dessinés **sous** les textes du HUD (nom, PV, objectif) : ils peuvent passer derrière un texte vers un coin de la vue, jamais devant ;
  - appelant **visible dans leur vue** : pas d'indicateur de bord, mais des **anneaux concentriques** qui s'étendent autour de lui dans le monde (vus par tous les joueurs dont la vue le contient, l'appelant compris). Ces anneaux se voient aussi dans une salle sombre.
- **Son** : l'événement de simulation `callStarted` déclenche un son placeholder (`src/entities/sfx.ts`).
- **Choix et limites** : rien ne change dans la difficulté, les ennemis, les niveaux ni le format de sauvegarde (la sauvegarde ne contient aucun état de simulation) ; l'appel n'attire ni n'éloigne les ennemis ; en solo il fonctionne (aucun indicateur n'est alors visible, mais les anneaux du monde le sont) ; le dessin (point au bord + arcs vers l'intérieur) et les durées ressenties sont à valider en jeu (voir `TODO.md`). Le cœur ne contient rien de spécifique au clavier ou à la manette : le bouton tactile « appel » est simplement le **X** de la manette virtuelle.

## Tutoriel

Entrée **« Tutoriel »** du menu principal (juste sous « Jouer »), ou directement `?tutorial=1` (`&room=N` : salle de départ 0-6, `&lang=en`, `&touch=1`, `&chars=` : personnage). Il explique **toutes les mécaniques en les faisant faire** : chaque étape se valide par une action du joueur (pas par la lecture d'un pavé de texte).

- **Ce qu'il couvre** (31 étapes, 7 salles, ~3 minutes) : déplacement ; **lire les panneaux** (objectif de la salle, indices) ; **où sont les objectifs à l'écran** — le bloc « Objectif de la salle » en haut à droite (ennemis restants, portes à ouvrir, « objectifs personnels accomplis x/y » avec les joueurs en attente) et « Ton objectif » en haut à gauche, puis la sortie qui s'ouvre ; points de vie ; attaque (bouton d'action contextuelle : Espace / A) ; **attaque spéciale** et sa recharge ; interaction (levier, plaques de pression, porte, bloc poussable, clé et porte de couleur) ; **salle sombre**, torche et braseros ; **relevage d'un allié à terre** (maintenir l'action ~3 s) ; **appel** (recevoir : point + 3 arcs au bord de l'écran, lancer : 1 s immobile, signal 3 s, délai 5 s) ; **mort d'équipe** et retour au début de salle.
- **Solo, y compris sur téléphone** : le relevage, l'appel et la plaque B exigent un 2e joueur. Le tutoriel joue donc avec un **partenaire scripté** (un personnage de la famille différent du tien, contrôlé par le jeu : `src/tutorial/partnerScript.ts`). Il tient la plaque B, tire son levier, tient le cercle du sceau, **tombe pour que tu le relèves** et **t'appelle depuis l'autre bout d'une grande salle**. Il n'attaque jamais et ne perd jamais de PV. Seul le joueur humain contrôle un héros (une seule vue, une seule manette virtuelle suffit).
- **S'adapte à l'appareil et à la langue** : les textes citent les boutons de ton appareil — clavier (touches courantes des bindings, remappage respecté), manette Xbox (A = action, Y = spécial, X = appel), manette PlayStation (croix = action, triangle = spécial, carré = appel) ou tactile (boutons de la manette virtuelle) — en français comme en anglais (`src/tutorial/deviceHints.ts`).
- **Mise en évidence** : une carte d'instruction en bas de l'écran (qui se replie sur une ligne après lecture), des cadres pulsants avec légende autour des zones du HUD concernées, des flèches qui rebondissent sur les cibles (panneau, levier, plaque, clé, porte, partenaire, sortie) et, pour l'appel, une flèche pulsante au bord de l'écran vers le partenaire hors champ.
- **Saute-able à tout moment** : **Entrée** (clavier), **Select / Back** (manette) ou la puce **« Passer »** (en haut au centre ; au bord droit de l'écran en tactile ; cliquable à la souris et au doigt) saute l'étape. Sur une étape de sortie, ou après 45 s sans progrès, la puce devient **« Salle suivante »** (le tutoriel est relancé à la salle suivante). Le menu pause (**Échap** / **Start**) → « Quitter » sort du tutoriel à tout moment. Les actions du partenaire dont la suite dépend (plaque tenue, levier tiré, cercle tenu) sont conservées quand on saute : sauter ne bloque jamais.
- **Rejouable** : il se relance depuis le menu autant de fois qu'on veut.
- **Ne sauvegarde rien** : le niveau-tutoriel (`src/levels/tutorial.ts`) n'est **pas** dans `LEVELS` (ni campagne, ni « niveau de départ », ni sauvegarde) ; `GameScene` ne construit aucun `AutoSaver` pour lui et `isSavingAllowed` le refuse (`tutorial: true` / `?tutorial=1`). Il ne lit ni n'écrit aucune clé `localStorage` du jeu (progression, choix du menu).
- **Choix et limites** : le tutoriel est joué à 2 joueurs simulés ; en partie solo (1 joueur) la plaque B, le relevage et l'appel n'ont pas d'effet visible (la carte de fin le précise). Le bloc poussable n'y demande qu'un héros (dans un vrai donjon, deux poussent ensemble). L'écran est celui d'un joueur (zoom 3) : à 3-4 joueurs les blocs du HUD sont plus petits, aux mêmes positions. Le surlignage DOM des boutons tactiles n'est pas fait (les boutons sont nommés dans le texte). Détail technique : le seul changement du cœur est `GameSimulation.knockDown(id)` (mise à terre scénarisée, appelée entre deux pas : démonstration du relevage et de la mort d'équipe) ; voir `docs/DESIGN.md` (« Tutoriel »).
- **Code** : `src/tutorial/` (logique PURE et testée : directeur d'étapes, conditions, partenaire scripté, étapes, libellés par appareil), `src/levels/tutorial.ts` (7 salles en données), `src/entities/tutorialRuntime.ts` (colle sans Phaser), `src/render/tutorialHud.ts` + `tutorialHudLogic.ts` (interface), crochets gardés par `if (this.tutorial)` dans `GameScene`. Textes : `src/i18n/parts/tutorial*.json`. Test d'intégration headless : `src/testing/tutorial.run.test.ts` (un « humain » scripté joue tout le tutoriel).

## Règles du jeu

- **1 à 4 joueurs**, écran splitté : 1 plein écran, 2 moitiés, 3 quadrants (+ panneau d'équipe), 4 quadrants. Chaque joueur a sa caméra, un marqueur de couleur (bleu, rouge, vert, jaune) et son HUD dans sa vue.
- **Difficulté par joueur** (1 facile, 2 normal, 3 difficile) : n'influence **que** les PV et les dégâts des ennemis — jamais leur nombre, les mécanismes ni les PV des joueurs.
- **PV, relevage, défaite** : à 0 PV un joueur est **à terre** (ne bouge plus, ne peut pas être achevé). Un allié le relève en restant immobile à côté en **maintenant l'action ~3 s** ; le sauveteur reste vulnérable (s'il tombe, le relevage est interrompu) ; un ennemi proche ralentit le relevage ; relevage illimité, PV pleins au retour. Tous à terre = défaite : retour au début de la **salle en cours**, salles validées conservées.
- **Attaque spéciale** : chaque personnage en a une, nettement plus puissante que l'attaque normale, qui se recharge (9 à 20 s).
- **Objectifs personnels** : chaque joueur a son objectif (clé, levier, zone à tenir, ennemis à vaincre…). Le niveau n'est terminé que lorsque **tous** sont remplis ET la sortie finale franchie (boss vaincu ou porte scellée ouverte).
- **Objectifs « ennemis à vaincre »** : si la salle est vidée avant que le propriétaire ait ses coups, l'objectif s'accomplit d'office (pas de blocage).
- **Coopération adaptative** : tous les niveaux sont faisables à 1, 2, 3 ou 4 joueurs (`minPlayers`, slots repliés `slot % nbJoueurs`, blocs poussables par `min(2, n)` joueurs…).
- **Mécanismes coopératifs** : plaques de pression simultanées, leviers séparés à fenêtre de temps, clés personnelles (une clé = une porte = un joueur), blocs 2×2 poussés à deux vers un socle, vision partagée (un joueur voit une séquence de runes que les autres doivent saisir), braseros, et les trois mécanismes inédits des niveaux 4 à 6 (statue jumelle, sablier partagé, pont de lumière — voir « Niveaux 4 à 6 »).
- **Torches** : certaines salles sont **sombres**. Chaque joueur porte une torche dont le combustible s'use (75 s) ; il faut la recharger aux **braseros allumés** (action à côté), sinon on ne voit presque rien. Des braseros éteints peuvent être allumés avec sa torche.

### Lire les objectifs à l'écran

Deux blocs distincts dans la vue de chaque joueur (`src/render/roomGoals.ts` pour la logique pure, `src/render/hud.ts` pour le dessin) :

- **« Objectif de la salle »** (haut à droite, **identique pour tous**) : ce qu'il faut faire pour ouvrir la sortie, une ligne cochable par exigence de `room.exit.requires`.
  - *Vaincre tous les ennemis* (ou *le boss* / *le boss et ses sbires* si un boss ou demi-boss est vivant ou en attente), suivi de « (N restants) ». Le libellé est déduit de la salle (boss, escorte) : il ne change pas pendant le combat.
  - *Ouvrir : porte / herse / grille* (avec « (1/2) » quand elle a plusieurs prérequis et qu'elle est encore fermée) ou *Activer : levier, plaque, brasero, sablier…*.
  - *Objectifs personnels accomplis : x/y* : **une seule ligne** pour tous les objectifs de la sortie ; elle nomme les joueurs en attente (2 au plus, sinon leur nombre) — la sortie attend **tout le monde**. Dans la salle finale, les objectifs de tout le niveau sont comptés.
  - Tout satisfait : **« Sortie ouverte : rejoins-la ! »** (en évidence) ; aucune exigence : « Rejoins la sortie ».
- **« Ton objectif » / « Tes objectifs »** (haut gauche, **propre au joueur**) : le libellé de ton objectif, puis sa progression — « Coups fatals portés : 1/3 » (les **tiens**), « Tiens la zone : 4 s (50 %) », « Accompli ». Un objectif d'une salle passée non accompli rappelle sa salle. Le bloc n'apparaît que s'il y a au moins une ligne ; « 1/4 accomplis » (en toutes lettres, avec le pluriel « Tes objectifs ») n'est ajouté que si tu as plusieurs objectifs sur le niveau. L'écran de résultat compte les objectifs personnels des **niveaux joués** (« 6/12 accomplis »). Dans le panneau d'équipe (3 joueurs) : une ligne par joueur, « Pas d'objectif perso ici » quand son objectif est ailleurs.

**Compteur d'ennemis et vagues** : « (N restants) » est affiché quand N ≤ 5, ou quand plus aucune apparition n'est en attente ; sinon seul le libellé apparaît (on garde la surprise des vagues suivantes). Un boss seul n'a pas de compteur. Les flèches rouges vers les 3 derniers ennemis restent inchangées. Le bloc est masqué quand le joueur est à terre, les bandeaux sablier/lanterne se placent sous lui et les notifications se décalent à sa gauche. À l'arrivée dans une salle, le bloc s'efface tant que le bandeau de nom de salle / d'indice (centré sur tout l'écran) passerait dessus, puis réapparaît.

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

Personnages secondaires (proposés) : **Maître Aldric** (archiviste du roi, donne la mission), **Lyssa** (esprit du Cristal, voix dans les fragments), **Gorgrim** (golem de racines, boss du niveau 2), **Morvane** (boss du niveau 3), **le Seigneur du Néant** (boss final, niveau 6). **Fin** : Morvane vaincu, Lyssa révèle qu'une ombre plus ancienne dort sous le royaume ; les héros descendent au fond de l'abîme, vainquent le Seigneur du Néant, et le Cristal de l'Aube rayonne enfin sans ombre sur Vaelorn (le jeu se termine au niveau 6).

## Niveaux

| # | Donjon | Thème | Contenu |
|---|---|---|---|
| 1 | Les Cryptes Oubliées | crypte | Tutoriel : déplacement, attaque, plaques coopératives, relevage, clés personnelles, leviers, première salle sombre ; sortie scellée |
| 2 | Le Bosquet Putride | bosquet | Leviers séparés simultanés, runes à vision partagée, boss **Gorgrim** |
| 3 | La Citadelle de Morvane | citadelle | Combine tout, blocs à deux joueurs, plusieurs salles sombres, boss **Morvane** (3 phases) |
| 4 | Les Cavernes de Givre | givre | **Statue jumelle** (agir ici pour faire pivoter une statue là-bas), salle sombre, deux demi-boss (dont le gardien de givre), boss **reine du givre** (3 phases) |
| 5 | Les Forges Ardentes | forge | **Sablier partagé** (herse qui se referme tuile par tuile), bloc 2×2 à pousser à deux, salle sombre, deux demi-boss pyromanciens, boss **seigneur de la forge** (3 phases) |
| 6 | Les Abysses du Néant | néant | **Pont de lumière** (le porteur de la lanterne éclaire le pont, chacun à son tour), salles sombres, embuscades, deux demi-boss spectres, boss final **Seigneur du Néant** (4 phases, volant) |

Chaque niveau dure environ 7 à 10 minutes (durée mesurée avec des bots de test, qui ne s'arrêtent jamais : prévoir un peu plus pour des joueurs humains) ; les salles sont grandes (la caméra défile) et peuplées de groupes d'ennemis.

### Niveaux 4 à 6 : demi-boss, boss et mécanismes inédits

Chaque niveau dure 7 à 10 min (bots), compte nettement plus d'ennemis que les niveaux 1 à 3 (au moins +25 % à 1 comme à 4 joueurs ; le nombre ne dépend que du nombre de joueurs, jamais de la difficulté), contient **deux demi-boss obligatoires** (leur salle ne se quitte qu'une fois vidée : la sortie exige `clear`) et un **boss final** plus fort dans la dernière salle (sortie finale scellée).

| Niveau | Demi-boss n°1 | Demi-boss n°2 (salle clé) | Boss final |
|---|---|---|---|
| 4 — Cavernes de Givre (8 salles) | salle 4/8 « L'Antre du Gardien » (mi-parcours, arène pure) : **gardien de givre** | salle 7/8 « L'Antichambre du Trône » (devant la grande porte du boss) : **gardien de givre** | salle 8/8 « Le Trône de la Reine » : **reine du givre**, gardée par 4/8/12 sbires à 2/3/4 joueurs |
| 5 — Forges Ardentes (9 salles) | salle 5/9 « cinderpit » (mi-parcours, arène pure) : **pyromancien** | salle 8/9 « emberhold » (salle des quatre portes à clé) : **pyromancien** | salle 9/9 « forgeheart » : **seigneur de la forge** |
| 6 — Abysses du Néant (9 salles) | salle 4/9 « wraithhall » : **spectre** | salle 7/9 « hearth » (salle clé) : **spectre** | salle 9/9 « throne » : **Seigneur du Néant** (4 phases) |

Les profils des boss sont dans `src/core/bossData.ts`. Tous les boss ont un **plafond de dégâts** par fenêtre de 2 s (20 % de leurs PV pour les boss finaux, 35 % pour les demi-boss) pour que les attaques spéciales ne les évaporent pas ; jusqu'à trois barres de vie s'empilent en haut de l'écran.

#### Niveau 4 — la **statue jumelle**

Deux statues solides, aux deux bouts d'une caverne, ont chacune un **socle** à côté d'elle. Un héros debout sur le socle d'une statue qui appuie sur Action fait **pivoter l'autre statue** d'un quart de tour dans le sens horaire (haut → droite → bas → gauche). Le mécanisme est résolu pour de bon quand les deux statues regardent la direction cible. **Solution :** un partenaire regarde la statue lointaine (son écran la montre) et annonce combien d'appuis il faut ; en solo, on fait l'aller-retour entre les deux socles. Pas de simultanéité, rotations illimitées (4 appuis = retour au départ), aucun blocage possible. Utilisée dans « Le Seuil de Givre » (apprentissage calme), « La Caverne des Échos » (pendant des vagues d'ennemis) et « L'Antichambre » (avec des plaques de garde pour la porte du boss).

#### Niveau 5 — le **sablier partagé**

Une herse de 3 tuiles ferme un couloir obligatoire ; un **levier du sablier** se trouve de chaque côté. Au départ le sable est vide et la herse fermée. **Solution :** un joueur (le « tenant ») retourne le levier de son côté : le sable se remplit (30 s à l'apprentissage, 16 à 22 s ensuite, **doublé en solo**) et la herse s'ouvre ; les autres traversent pendant que le sable coule. Quand il est vide, la herse se referme **tuile par tuile** (une tuile occupée par un joueur ou un ennemi attend). Le tenant retourne le levier avant la fin ; un autre joueur, une fois passé, peut prendre le relais au levier de l'autre côté ; le dernier retourne une dernière fois et traverse. En solo : retourner, puis courir. Les deux côtés ont toujours un levier atteignable (même après une défaite d'équipe). Le sablier est un obstacle physique : aucune porte ni sortie ne l'exige.

#### Niveau 6 — le **pont de lumière**

Les tuiles d'un pont au-dessus de l'abîme ne sont **praticables que dans le halo de la lanterne** (rayon 2,5 à 3,5 tuiles) ou sous un joueur vivant. **Solution :** le **porteur** de la lanterne (le joueur de slot `lanternSlot % nbJoueurs`, qui change de salle en salle et de pont en pont) avance tuile par tuile ; les autres le suivent à une tuile derrière, dans sa lumière. Les ponts font une tuile de large, à sens unique. Il faut **vaincre la rive de départ** avant de s'engager : les ennemis de la rive d'arrivée n'apparaissent qu'en embuscade, à plus de 6 tuiles de l'atterrissage. Limite connue : si le porteur tombe en plein pont, les suiveurs restent bloqués sur leur tuile — le relever tout de suite (il est à moins d'une tuile) ; sinon, défaite d'équipe et retour au début de la salle. Hors pont, les autres mécanismes sont individuels (une clé, un levier, une plaque, un brasero par joueur).

#### Choix et limites (niveaux 4 à 6)

- Mécanismes choisis dans la liste proposée : **statue jumelle**, **sablier partagé**, **pont de lumière**. Les trois autres (**miroir de rôles**, **courant d'eau**, **masque d'écho**) ne sont pas réalisés : pistes pour de futurs niveaux (voir `TODO.md`).
- Niveaux ajoutés comme données (`src/levels/level4.ts` à `level6.ts`) ; contrats `statuePair` / `hourglass` / `lightBridge` dans `src/core/types.ts`, logique dans `src/core/mechanisms.ts`, tests dans `src/core/novelMechanisms.test.ts`.
- Les PV des joueurs ne se régénèrent pas d'une salle à l'autre : l'usure compte, d'où des ennemis surtout légers et un effectif qui monte vite entre 3 et 4 joueurs.
- Le téléport des boss tire des points dans toute la salle : aucune herse de sablier ni porte ne se trouve dans une salle de boss.
- Trois nouveaux thèmes graphiques (givre, braise, néant) ; sprites de boss de 32 et 48 px (liste dans `docs/SPRITES.md`).
- **Salles de test de dev** : `?dev=statues`, `?dev=hourglass`, `?dev=bridge`, `?dev=bosses` (jamais de sauvegarde).
- **Seigneur du Néant rééquilibré** (2000 PV, dégâts 17 ; avant : 2300 PV, dégâts 24) : un bot de mêlée le vainc maintenant seul à la difficulté 2, et le niveau 6 complet est prouvé en solo à la difficulté 2 (≈ 11-12 min simulées avec 2-3 défaites de bot). À confirmer à la main.
- **À équilibrer** : durée des demi-boss avec spéciaux (≈ 17 s mesurées pour une cible de 12 s).

## Structure du code

```
src/core/      LOGIQUE PURE (aucune dépendance à Phaser/DOM, ni Math.random/Date) — déterministe, état JSON sérialisable
  types.ts       tous les contrats (GameState, LevelDef, MechanismDef, SimEvent, …)
  simulation.ts  GameSimulation : step(dt, inputs) → événements ; serialize()/restore()
  players.ts     PV, relevage, mort d'équipe, torche, appel (immobilisation, signal, délai) ; balance.ts : formules d'équilibrage
  save.ts        sauvegarde : format versionné, validation, migrations, reprise (voir « Sauvegarde de la progression »)
  saveRepository.ts  SaveRepository (load/save/clear) + LocalStorage/Memory ; autoSave.ts : écriture au début de salle / fin de niveau
  mechanisms.ts  plaques, leviers, clés, portes, blocs, runes, braseros ; objectives.ts ; levelValidation.ts
  combat.ts, collision.ts, ai.ts, bosses.ts, characters.ts, enemies.ts, light.ts, rng.ts, geometry.ts, grid.ts
src/levels/    niveaux en données TS typées (level1.ts … level6.ts, index.ts)
  tutorial.ts   niveau-tutoriel (7 salles) : HORS campagne (pas dans LEVELS), jamais sauvegardé
src/tutorial/  tutoriel, logique PURE : TutorialDirector (étapes validées par l'action du joueur), partenaire scripté (VM), conditions, libellés par appareil
src/input/     couche d'abstraction des entrées : ActionFrame par joueur (clavier, manettes, réseau/tactile plus tard)
src/pwa/       enregistrement du service worker (PWA) ; scripts/pwa-build.mjs (sw.js au build), make-icons.mjs (icônes)
src/net/       interface NetAdapter (prévue, sans implémentation réseau)
src/i18n/      fr.json, en.json, i18n.ts (clés plates, aucune chaîne en dur dans le code)
src/render/    atlas de sprites runtime (art/), palettes, splitscreen, caméras, HUD, obscurité, effets, indicateur d'appel (callIndicator.ts pur, callHud.ts dessin)
src/entities/  vues Phaser (joueurs, ennemis, mécanismes, salle) — lecture seule de GameState
src/scenes/    Boot, Menu, CharacterSelect, Dialogue, Game, Result
src/testing/   bots de test qui jouent la simulation (déterministes)
docs/          DESIGN.md (architecture détaillée), SPRITES.md (sprites à remplacer)
```

Principe : **Phaser ne décide d'aucune règle**. `GameScene` accumule le temps réel, appelle `sim.step()` à pas fixe (60 Hz) avec les `ActionFrame` des joueurs, puis synchronise des sprites avec `GameState` et joue les `SimEvent`.

### Ajouter un niveau

1. Créer `src/levels/level7.ts` (par exemple) exportant un `LevelDef` (salles en grilles de caractères : `#` mur, `.` sol, `,` sol variante, `o` pilier, `~` fosse ; mécanismes, ennemis, objectifs, panneaux, sortie ; voir `level1.ts` comme modèle).
2. L'ajouter à la liste `LEVELS` de `src/levels/index.ts`.
3. Écrire ses textes (`level.level7.*`, `room.level7.*`, `objective.level7.*`, `sign.level7.*`, …) dans `src/i18n/parts/level7.fr.json` et `level7.en.json` (les parts sont fusionnées automatiquement).
4. Écrire un test qui appelle `validateLevel(level7, { dictionaries: { fr, en }, checkSpeakers: true })` (voir `src/levels/level1.test.ts`) : il vérifie ids, géométrie, atteignabilité à 1..4 joueurs, clés i18n, etc.

### Équilibrage

Toutes les formules sont centralisées et commentées dans `src/core/balance.ts` (PV max = 50 + 10 × résistance ; réduction de dégâts 2 % × résistance ; dégâts de base = 6 + 2,5 × force ; multiplicateurs de difficulté PV ennemis ×0,7/1/1,4 et dégâts ennemis ×0,6/1/1,5). Statistiques des personnages : `src/core/characters.ts` ; des ennemis : `src/core/enemies.ts`. Ce sont des valeurs de premier jet, à affiner en jouant.

### Sprites à remplacer

Tous les sprites sont des **placeholders** générés par code (`src/render/art/`), assemblés dans un atlas unique (`atlas`) avec une échelle de pixel commune et une palette par donjon. La liste complète des frames, tailles et noms à respecter pour les remplacer par de vrais assets est dans **[docs/SPRITES.md](docs/SPRITES.md)**.

## Sauvegarde de la progression

**Quand** : automatiquement au **début de chaque salle** (cohérent avec le redémarrage de salle après une défaite) et à la **fin de chaque niveau** — jamais en pleine salle. Terminer un niveau l'ajoute aux niveaux terminés et place la reprise en **salle 0 du niveau suivant** (après le dernier niveau, la reprise reste sur celui-ci). Une **défaite collective ne touche pas à la sauvegarde** : on reprend au début de la salle sauvegardée.

**Contenu** (une sauvegarde = une **équipe**, pas un joueur local) : niveau et salle de reprise, nombre de joueurs, personnage et difficulté de chaque joueur, niveaux terminés. Aucun PV, objet ni position : on reprend en PV pleins au début de la salle.

**Menu** :
- **Continuer (Niveau X — Salle Y)** : visible **uniquement** si une sauvegarde valide existe ; sélectionnée par défaut.
- **Nouvelle partie** (« Jouer » tant qu'il n'y a pas de sauvegarde) : demande confirmation avant d'écraser une sauvegarde existante, valide ou illisible (la sauvegarde n'est réellement remplacée qu'à l'entrée dans la première salle).
- **Effacer la sauvegarde** (en bas du menu principal, qui tient lieu d'options) : toujours confirmé.
- **Sauvegarde illisible** (corrompue, version inconnue ou plus récente que le jeu) : le jeu ne plante pas, signale le problème et propose **Conserver** ou **Repartir de zéro** (confirmation supplémentaire). La donnée brute reste en place tant que le joueur n'a pas confirmé l'effacement ; une ligne rouge en tête du menu permet d'y revenir. Les dialogues se pilotent au clavier, à la manette et à la souris ; « retour » choisit toujours l'option sûre.

**Reprise et appareils** : l'équipe est **figée** (personnages et difficultés non modifiables). « Continuer » ouvre l'écran de sélection en **mode reprise** : les personnages sont pré-remplis et verrouillés, il ne reste qu'à **rejoindre** (chaque joueur appuie sur A / Entrée / Espace). Choix retenu pour attribuer les appareils (au lieu de deviner des manettes) : l'appareil qui a validé « Continuer » prend automatiquement la **place 1** ; les suivants prennent les places 2, 3, 4 **dans l'ordre d'arrivée** (la place 1 est le premier personnage sauvegardé, etc. ; clic souris sur un panneau libre = clavier sur cette place). Quand toutes les places sont prises, compte à rebours puis lancement directement dans la salle sauvegardée (le dialogue d'introduction n'est joué que si l'on reprend en salle 0 d'un niveau). Les garanties habituelles (manette débranchée → pause) s'appliquent.

**Objectifs personnels à la reprise** : ceux des salles **précédentes** sont considérés **accomplis** (ils persistent entre salles) et ces salles sont marquées validées ; ceux de la salle de reprise et des suivantes sont à faire. Ce comportement est celui de `SimConfig.startRoomIndex` (valeur optionnelle, défaut 0, bornée à la liste des salles ; événement `roomEntered` de raison `start`), aussi utilisé par le paramètre de dev `?room=N`.

**Parties qui ne sauvegardent pas** : le démarrage rapide (`?quick=1`), `?nosave=1` et `?dark=1` (paramètres de dev) n'écrivent jamais la vraie sauvegarde (elle reste visible dans le menu, et « Effacer » y reste possible). Un test (`src/core/save.test.ts`) vérifie que le dépôt n'est pas touché.

**Où est-elle stockée ?** Dans le `localStorage` du navigateur, clé **`vaelorn.save`** (une seule sauvegarde, JSON). Le stockage est derrière l'interface `SaveRepository` (`load` / `save` / `clear`, `src/core/saveRepository.ts`) ; chaque lecture/écriture est dans un `try/catch` : stockage indisponible (navigation privée stricte, cookies bloqués) ou plein (quota) → le jeu continue, un message court s'affiche en jeu et la sauvegarde reste sur son ancienne valeur. Le stockage est lié au navigateur **et à l'origine** (`localhost:5173` ≠ `localhost:4173` ≠ le site déployé).

**L'effacer à la main** : menu principal → *Effacer la sauvegarde* ; ou DevTools → Application → Local Storage → supprimer la clé `vaelorn.save` ; ou dans la console : `localStorage.removeItem('vaelorn.save')`.

**Format, versions, migration** (`src/core/save.ts`, pur et testé) : `{ "schemaVersion": 2, "levelId": "level2", "roomIndex": 2, "players": [{ "characterId": "david", "difficulty": 2 }, …], "completedLevelIds": ["level1"] }`. Le nombre de joueurs est `players.length` (1 à 4). À la lecture, la donnée est **validée** (JSON, champs, version, personnage, niveau, salle, doublons). Les anciennes versions sont **migrées** vers la version courante (v0 prototype sans `schemaVersion` → v1 par indices de niveau → v2 par identifiants de niveau) sans réécrire le stockage ; la prochaine sauvegarde automatique l'écrit en version courante. Une version **plus récente** que celle du jeu est refusée (traitée comme illisible, jamais écrasée sans confirmation). Pour changer le format : incrémenter `SAVE_SCHEMA_VERSION`, ajouter la migration `n → n+1` dans `MIGRATIONS` et ses tests (`src/core/save.test.ts`). Ajouter un niveau ne casse pas les sauvegardes (références par identifiant).

**Reste à faire** (voir TODO.md) : brancher d'autres supports derrière `SaveRepository` — fichier local (Electron/Tauri), **Capacitor Preferences / fichier** sur Android, **serveur / cloud** (compte, synchronisation, résolution de conflits entre appareils) ; interface **asynchrone** (aujourd'hui synchrone, car `localStorage` l'est) ; **plusieurs emplacements** de sauvegarde (une équipe par emplacement, choix dans le menu) ; sauvegarde de secours avant écrasement d'une donnée illisible ; sélecteur de niveaux débloqués selon `completedLevelIds`.

## Portage futur (Android)

**Prêt** : logique de jeu totalement séparée du rendu et des entrées (`src/core`) ; entrées abstraites en `ActionFrame` (les contrôles tactiles sont livrés : une **manette virtuelle** injectée comme manette « extra », voir « Sur téléphone / tablette ») ; build statique à chemins relatifs (`base: './'`), compatible Capacitor ; aucune dépendance à des API de bureau côté `core`.
**Reste à faire** : réglages tactiles (stick flottant, mode gaucher, tailles) ; packaging Capacitor (Android Studio, icônes, écran de démarrage) ; orientation paysage verrouillée ; adaptation aux tailles d'écran et densités (le canvas est en 1280×720 avec `Phaser.Scale.FIT`) ; HUD et splitscreen pensés pour un petit écran (probablement 1–2 joueurs sur téléphone, plus sur tablette/TV) ; test de performances sur appareils modestes ; manettes Bluetooth via la Gamepad API du WebView.

## Multijoueur en ligne futur

- **L'état de jeu est sérialisable** : `GameState` est du JSON pur (aucune classe, `Map` ni fonction), `GameSimulation.serialize()/restore()` fonctionne, la simulation est déterministe (PRNG dans l'état, pas d'horloge) et avance par pas fixe.
- **À envoyer au serveur / aux pairs** : uniquement les `ActionFrame` de chaque joueur par tick (déplacement, attaque, interaction, relevage, spécial, appel) ; en retour, soit les entrées des autres joueurs (lockstep), soit des instantanés/diffs de `GameState` (hôte autoritaire). `src/net/NetAdapter.ts` et `RemoteInputSource` posent l'interface.
- **À décider** : modèle (lockstep déterministe vs serveur autoritaire avec prédiction/réconciliation), transport (WebRTC pair-à-pair vs WebSocket + relais), appariement (salons, codes de partie), gestion de la latence et des déconnexions/reconnexions en cours de partie, versionnage du protocole et des niveaux, triche, découpage splitscreen local + joueurs distants.

## Choix et déviations documentés

- Textes : tout passe par `t('clé')` ; fichiers plats `fr.json`/`en.json`. Les noms propres des quatre membres de la famille sont identiques dans les deux langues.
- Coopération adaptative et slots (voir plus haut) pour que 1 joueur puisse tout finir.
- Les manettes ne sont accessibles qu'en HTTPS/localhost (limite des navigateurs).
- Détails d'architecture et conventions : [docs/DESIGN.md](docs/DESIGN.md).

- Les deux salles de boss n'ont pas de mécanisme propre (assouplissement de « chaque salle en utilise au moins un »), voir DESIGN §9.

## Licence

À définir.
