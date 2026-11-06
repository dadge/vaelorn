# TODO — Les Fragments de l'Aube

## À faire en priorité (avant de montrer le jeu largement)

- [ ] **Tester avec de vraies manettes** (4 manettes simultanées, Xbox/PlayStation/génériques, USB et Bluetooth) : tout a été testé avec des manettes simulées. Utiliser `/gamepad-test.html` pour diagnostiquer. Vérifier l'ordre des indices au rebranchement.
- [ ] **Playtest de l'équilibrage** : PV et dégâts des ennemis, puissance et recharges des attaques spéciales, durée de la torche (75 s), nombre d'ennemis par salle à 1 et à 4 joueurs. Les valeurs sont dans `src/core/balance.ts`, `characters.ts`, `enemies.ts`, `constants.ts`.
- [ ] **Vérifier la durée réelle** de chaque niveau (cible 5–10 min) avec de vrais joueurs ; ajuster le nombre/la taille des salles.
- [ ] **Lisibilité en splitscreen à 4 joueurs** sur une vraie télé (taille du texte du HUD, marqueurs de couleur).
- [ ] Remplacer les **sprites placeholder** par de vrais assets pixel art (liste : `docs/SPRITES.md`).
- [ ] Ajouter **sons et musique** (seuls des appels de sons placeholder existent dans `src/entities/sfx.ts`).

## Gameplay / contenu

- [ ] Plus d'ennemis différents et de variété par donjon ; mini-boss intermédiaires.
- [ ] Objets, coffres, récompenses, upgrades de personnages entre les niveaux.
- [ ] Menu de pause enrichi (remappage des touches/boutons — le moteur de bindings existe, il manque l'écran).
- [ ] Sélecteur de niveau / sauvegarde de progression (aujourd'hui : « niveau de départ » dans le menu uniquement).
- [ ] Carte/mini-carte et flèche vers la sortie dans les grandes salles.
- [ ] Salles sombres supplémentaires et variantes du système de torches (ennemis sensibles à la lumière, braseros à entretenir…).
- [ ] Les jetons d'exigence `enter:<zone>` ne sont pas évalués dans le HUD (`src/render/hud.ts`) ni dans les bots (`src/testing/botKit.ts`) : à brancher si un niveau s'en sert pour une porte ou une sortie.
- [ ] Le brasero est solide et bloque aussi les projectiles (limitation du moteur : une seule liste de solides).
- [ ] Texte d'aide du menu pause en jeu (`src/entities/overlay.ts`) : n'indique pas encore le bouton spécial.

- [ ] Boss final en solo (niveau 3) : pic de difficulté ; équilibrer selon le nombre de joueurs si besoin (les spéciaux sont plafonnés à 20 % des PV du boss par fenêtre de 2 s).
- [ ] Bibliothèque de bots (`src/testing`) : bug connu `engageRanged` qui se fige contre un pilier (un test est mis de côté avec `it.skip`).
- [ ] Indicateur HUD de la fenêtre restante des leviers à fenêtre (niveaux 1 et 2).

## Technique

- [ ] Reprise automatique d'une manette qui change d'indice navigateur à la reconnexion.
- [ ] Manettes non « standard » : mappage de repli fourni mais peu testé.
- [ ] Les appuis de manette plus courts qu'une frame ne sont pas rattrapés dans les menus.
- [ ] Taille du bundle (~1,5 Mo) : découpage en chunks, chargement paresseux des scènes.
- [ ] Sauvegarde automatique des réglages (langue, bindings, difficulté) — la langue et les bindings sont déjà persistés.
- [ ] Intégration continue : le workflow GitHub Pages lance déjà `npm test` et `npm run build`.

## Portage Android (voir README, « Portage futur »)

- [ ] Contrôles tactiles (`TouchSource` : stick virtuel + boutons action/spécial) branchés sur `InputManager.registerSource`.
- [ ] Packaging Capacitor, icônes, écran de démarrage, orientation paysage.
- [ ] Adaptation aux tailles d'écran / HUD pour petit écran ; tests de performance sur appareils modestes.

## Multijoueur en ligne (voir README, « Multijoueur en ligne futur »)

- [ ] Choisir le modèle réseau (lockstep déterministe ou hôte autoritaire) et le transport (WebRTC/WebSocket).
- [ ] Implémenter `NetAdapter` (serveur/relais, appariement, reconnexion) et `RemoteInputSource` côté jeu.
- [ ] Définir le protocole (versionnage), la gestion de la latence (prédiction/réconciliation) et l'anti-triche.
- [ ] Mixer joueurs locaux (splitscreen) et distants.

## Documentation

- [ ] Compléter `docs/DESIGN.md` §9 (« Déviations ») avec les changements faits par les différents modules (système de parts i18n fusionné, attaques spéciales, torches).
- [ ] Choisir une licence.
