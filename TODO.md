# TODO — Les Fragments de l'Aube

## À faire en priorité (avant de montrer le jeu largement)

- [x] **Tester avec de vraies manettes** : validé par David sur le PC du salon (4 manettes PlayStation en Bluetooth, navigateur, télé) — « parfaitement ». Reste à tester : manettes Xbox/génériques, USB, et l'ordre des indices au rebranchement (`/gamepad-test.html` pour diagnostiquer).
- [ ] **Playtest de l'équilibrage** : PV et dégâts des ennemis, puissance et recharges des attaques spéciales, durée de la torche (75 s), nombre d'ennemis par salle à 1 et à 4 joueurs. Les valeurs sont dans `src/core/balance.ts`, `characters.ts`, `enemies.ts`, `constants.ts`.
- [ ] **Vérifier la durée réelle** de chaque niveau (cible 5–10 min) avec de vrais joueurs ; ajuster le nombre/la taille des salles.
- [x] **Lisibilité en splitscreen à 4 joueurs** sur une vraie télé : retour de David — l'écran divisé en 4 sur grande télé « marche bien ». À revérifier avec les salles sombres et les nouveaux niveaux 4-6 (HUD sablier, lanterne).
- [ ] Remplacer les **sprites placeholder** par de vrais assets pixel art (liste : `docs/SPRITES.md`).
- [ ] Ajouter **sons et musique** (seuls des appels de sons placeholder existent dans `src/entities/sfx.ts`).

## Gameplay / contenu

- [ ] Plus d'ennemis différents et de variété par donjon ; mini-boss intermédiaires.
- [ ] Objets, coffres, récompenses, upgrades de personnages entre les niveaux.
- [ ] Menu de pause enrichi (remappage des touches/boutons — le moteur de bindings existe, il manque l'écran).
- [x] Sauvegarde de progression (automatique, début de salle / fin de niveau, « Continuer ») — voir README « Sauvegarde de la progression » et la section « Sauvegarde » ci-dessous pour les vérifications sur PC.
- [ ] Sélecteur de niveau selon la progression (niveaux débloqués = `completedLevelIds`) ; aujourd'hui : « niveau de départ » libre dans le menu.
- [ ] Carte/mini-carte et flèche vers la sortie dans les grandes salles.
- [ ] Salles sombres supplémentaires et variantes du système de torches (ennemis sensibles à la lumière, braseros à entretenir…).
- [ ] Les jetons d'exigence `enter:<zone>` ne sont pas évalués dans le HUD (`src/render/hud.ts`) ni dans les bots (`src/testing/botKit.ts`) : à brancher si un niveau s'en sert pour une porte ou une sortie.
- [ ] Le brasero est solide et bloque aussi les projectiles (limitation du moteur : une seule liste de solides).
- [ ] Texte d'aide du menu pause en jeu (`src/entities/overlay.ts`) : n'indique pas encore le bouton spécial.

- [ ] **Niveau 6 en solo à la difficulté 2** : le seigneur du Néant a été rééquilibré (2000 PV, dégâts 17) et les bots le battent maintenant en solo difficulté 2 (David, Mira, Aelith) ; Brokk (très lent) n'y arrive toujours pas avec ces bots. À confirmer à la main, solo et difficulté 3.
- [ ] Boss final en solo (niveau 3) : pic de difficulté ; équilibrer selon le nombre de joueurs si besoin (les spéciaux sont plafonnés à 20 % des PV du boss par fenêtre de 2 s).
- [ ] Bibliothèque de bots (`src/testing`) : bug connu `engageRanged` qui se fige contre un pilier (un test est mis de côté avec `it.skip`).
- [ ] Indicateur HUD de la fenêtre restante des leviers à fenêtre (niveaux 1 et 2).

## Niveaux 4 à 6 (voir README, « Niveaux 4 à 6 »)

À vérifier sur PC avec de vrais joueurs (tout a été prouvé uniquement par des bots, jamais joué à la main) :

- [ ] **Jouer les niveaux 4, 5, 6 de bout en bout** à 1, 2, 3 et 4 joueurs (`?quick=1&players=N&level=4|5|6`, ou `&room=N` pour une salle) : durée réelle (cible 5–10 min ; les bots donnent 7–11 min en solo, ≈ 8–9 min à 2–4), fluidité (grandes salles, ≈ 300 ennemis à 4 joueurs), lisibilité.
- [ ] **Statue jumelle (niveau 4)** : vraie pression de touche sur le socle ; l'autre statue est-elle visible dans l'écran du partenaire ? Les indications (panneaux) suffisent-elles à comprendre ?
- [ ] **Sablier (niveau 5)** : durée du sable (30 s / 16–22 s / ×2 en solo) trop courte ou trop longue ? Relais entre joueurs naturel ? HUD du sablier lisible en écran divisé à 3–4 joueurs.
- [ ] **Pont de lumière (niveau 6)** : le bandeau « Tu portes la lanterne… » peut être masqué quelques secondes par la bannière de nom de salle ; halo assez visible ; softlock connu si le porteur tombe en plein pont avec un suiveur sur le pont (relever tout de suite, sinon défaite d'équipe).
- [ ] **Boss et demi-boss en combat réel** : télégraphes lisibles, plafond de dégâts (20 % / 35 % par 2 s) ressenti comme juste ; barres de vie empilées ; zone de danger du seigneur du Néant ; demi-boss ≈ 17 s avec spéciaux (cible visée 12 s) : ajuster les PV (`src/core/bossData.ts`) si trop long.
- [ ] Portraits dédiés pour les orateurs `frostqueen`, `forgelord`, `voidlord` (aujourd'hui portrait du narrateur avec une couleur de nom propre : `src/render/menuLogic.ts`).
- [ ] Mécanismes non réalisés, pistes pour de futurs niveaux : **miroir de rôles**, **courant d'eau**, **masque d'écho**.
- [ ] Remplacer les sprites placeholder des nouveaux boss/thèmes (liste dans `docs/SPRITES.md`).

## Technique

- [ ] **Rendu adouci** (par défaut, `?smooth=0` pour les pixels francs) : à juger sur la vraie télé ; si c'est trop flou, ajouter un réglage dans le menu, ou redessiner les sprites en plus haute résolution (`docs/SPRITES.md`).

- [ ] Reprise automatique d'une manette qui change d'indice navigateur à la reconnexion.
- [ ] Manettes non « standard » : mappage de repli fourni mais peu testé.
- [ ] Les appuis de manette plus courts qu'une frame ne sont pas rattrapés dans les menus.
- [ ] Taille du bundle (~1,5 Mo) : découpage en chunks, chargement paresseux des scènes.
- [ ] Sauvegarde automatique des réglages (langue, bindings, difficulté) — la langue et les bindings sont déjà persistés.
- [ ] Intégration continue : le workflow GitHub Pages lance déjà `npm test` et `npm run build`.

## Sauvegarde (voir README, « Sauvegarde de la progression »)

À vérifier sur PC (rien de tout cela n'a été testé dans un vrai navigateur) :

- [ ] **Reprise après fermeture du navigateur** : jouer jusqu'à la salle 2, fermer l'onglet/le navigateur, rouvrir → « Continuer (Niveau 1 — Salle 2) » est proposé et reprend au début de la bonne salle, avec la bonne équipe, les bons personnages et difficultés.
- [ ] **Fin de niveau** : terminer le niveau 1, quitter pendant le dialogue de fin → « Continuer » propose « Niveau 2 — Salle 1 ».
- [ ] **Défaite collective** : perdre dans une salle, quitter, rouvrir → la sauvegarde est inchangée (début de la salle sauvegardée).
- [ ] **Corruption manuelle de la clé** : DevTools → Application → Local Storage → modifier `vaelorn.save` (JSON cassé, `schemaVersion` à 99, personnage inconnu, niveau inconnu) → le menu ne plante pas, affiche l'alerte « Sauvegarde illisible », la donnée brute reste intacte tant qu'on n'a pas confirmé « Repartir de zéro » ; « Nouvelle partie » demande confirmation.
- [ ] **Mode navigation privée** (Chrome/Firefox/Safari) : le jeu se lance et se joue ; en cas de stockage refusé, le message « Sauvegarde impossible… » apparaît en jeu sans bloquer ; pas de « Continuer ».
- [ ] **Quota localStorage** : remplir le stockage de l'origine (console : `localStorage.setItem('x','y'.repeat(5e6))` jusqu'à l'erreur) puis changer de salle → message « stockage plein », jeu non interrompu, ancienne sauvegarde conservée.
- [ ] **Reprise avec manettes** : sauvegarder une équipe de 2–4 joueurs, relancer, « Continuer » à la manette puis au clavier, avec 1, 2 et 4 manettes (dont des manettes branchées après coup) : l'écran « rejoindre » attribue bien les places 1..N, la manette qui valide « Continuer » prend la place 1, B libère une place, aucun joueur ne se retrouve sans appareil.
- [ ] **Navigation clavier ET manette** dans « Continuer », « Nouvelle partie » (confirmation), « Effacer la sauvegarde » (confirmation), alerte « sauvegarde illisible » (le choix par défaut est toujours l'option sûre ; B / Échap l'active).
- [ ] **Plusieurs onglets / origines** : deux onglets du même jeu écrasent la même clé (dernier écrit gagne) ; `localhost:5173` et `localhost:4173` ont des sauvegardes distinctes.
- [ ] **Paramètres de dev** : `?quick=1`, `?nosave=1`, `?dark=1` ne modifient pas la clé `vaelorn.save` (observer le Local Storage pendant une partie).
- [ ] Les textes (fr/en) des nouveaux écrans tiennent dans leurs cadres (menu à 4 joueurs + Continuer + Effacer, dialogues, écran « reprise »).
- [ ] Stockage multi-supports : fichier local (Electron/Tauri), Capacitor Preferences / fichier (Android), serveur / cloud (compte, conflits entre appareils) derrière `SaveRepository` ; interface asynchrone.
- [ ] Plusieurs emplacements de sauvegarde (une équipe par emplacement) ; sauvegarde de secours avant d'écraser une donnée illisible.

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
