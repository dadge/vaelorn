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
- [ ] Le jeton d'exigence `enter:<zone>` est maintenant évalué et décrit par le HUD (`src/render/roomGoals.ts`, « Rejoindre la zone »), mais pas par les bots (`src/testing/botKit.ts`) : à brancher si un niveau s'en sert pour une porte ou une sortie.
- [ ] Le brasero est solide et bloque aussi les projectiles (limitation du moteur : une seule liste de solides).
- [x] Texte d'aide du menu pause en jeu (`src/entities/overlay.ts`) : indique maintenant les boutons spécial et appeler (à vérifier à la main : la ligne de commandes tient-elle dans le cadre en français et en anglais ?).
- [ ] **Appeler (à vérifier à la main, voir README « Appeler »)** : (1) lisibilité du point + des 3 arcs au bord de la vue à 4 joueurs (vues 640×360, rayons 10/18/26 px × zoom/2) et à 2 joueurs (×1,5), en coin de vue, avec 2 appelants en même temps, et quand une flèche d'allié à terre ou d'ennemi est au même endroit (l'indicateur d'appel glisse le long du bord) ; (2) durées ressenties : immobilisation 1 s, signal 3 s, délai 5 s depuis l'appui (`CALL_*` dans `src/core/constants.ts`) ; (3) **dessin** : point collé au bord + 3 arcs de 90° qui partent vers l'intérieur de l'écran, du plus petit au plus grand (demandé par David, d'après une icône « signal ») : à valider en jeu (épaisseur, taille, couleur); (4) cadence (cycle 900 ms, 300 ms par arc, fondu de queue 100 ms) et visibilité des anneaux d'onde du monde (taille, opacité, en salle sombre) ; (5) pendant un relevage l'appel est ignoré, et un appelant immobilisé ne peut pas relever pendant 1 s : cela surprend-il ? ; (6) **son réel** à ajouter (aujourd'hui deux bips synthétisés, `sfx.ts`) ; (7) bouton **C** (clavier) et **X** (manette) : confort selon les dispositions AZERTY/QWERTY et les manettes ; bouton tactile « appeler » = X de la manette virtuelle ; (8) un spécial/une attaque/une interaction pressés au MÊME pas que l'appui d'appel sont perdus (l'appel prime, `prev` consommé) et les coups différés de la Danse des lames de Mira continuent pendant l'immobilisation : acceptable ou faut-il refuser l'appel pendant un spécial en cours ? ; (9) les arcs passent sous les textes du HUD (nom, PV, objectif, bandeaux) : vérifier qu'ils restent lisibles vers les coins, et ajouter une zone d'exclusion si besoin ; (10) une sauvegarde de touches personnalisées (clé v2) qui utilise C / X pour une direction est rejetée en bloc (repli sur les défauts) : à traiter avec l'écran de remappage ; les sauvegardes de l'ancienne clé v1 sont ignorées.

- [ ] **Niveau 6 en solo à la difficulté 2** : le seigneur du Néant a été rééquilibré (2000 PV, dégâts 17) et les bots le battent maintenant en solo difficulté 2 (David, Mira, Aelith) ; Brokk (très lent) n'y arrive toujours pas avec ces bots. À confirmer à la main, solo et difficulté 3.
- [ ] Boss final en solo (niveau 3) : pic de difficulté ; équilibrer selon le nombre de joueurs si besoin (les spéciaux sont plafonnés à 20 % des PV du boss par fenêtre de 2 s).
- [ ] Bibliothèque de bots (`src/testing`) : bug connu `engageRanged` qui se fige contre un pilier (un test est mis de côté avec `it.skip`).
- [ ] Indicateur HUD de la fenêtre restante des leviers à fenêtre (niveaux 1 et 2).
- [ ] **À vérifier à la main sur la télé** : lisibilité du nouveau bloc « Objectif de la salle » à 4 joueurs (vues 640×360 : jusqu'à 7 lignes dans les salles à 4 portes + ennemis + objectifs, par ex. niveau 5 salle 8), chevauchement avec le bloc d'objectif perso (haut gauche), les bandeaux sablier/lanterne et les notifications ; le bloc s'efface ~4 à 7 s à l'arrivée dans une salle (bandeaux de nom de salle / d'indice, vues de gauche) : trop long ? les flèches rouges vers les derniers ennemis peuvent encore passer sur l'en-tête du bloc ; envisager de replier les lignes déjà cochées si c'est trop encombrant.
- [ ] Panneau d'équipe (3 joueurs) : il pourrait aussi afficher l'objectif de la salle (place disponible) ; pas fait.
- [ ] Objectifs perso : la clé `hud.objective.progress` (« {done}/{total} ») ne sert plus qu'à l'écran de résultats, sous le libellé « Objectifs personnels accomplis ».

## Tutoriel (voir README « Tutoriel » ; tout a été prouvé par simulation headless et vérifié dans un navigateur de bureau, jamais sur un vrai téléphone)

À vérifier à la main :

- [ ] `npm run dev` : `?tutorial=1` au clavier (AZERTY **et** QWERTY : le texte du déplacement dit « W A S D (Z Q S D en AZERTY) »), puis `?tutorial=1&touch=1` à la souris, puis émulation téléphone paysage 800×360 : lisibilité de la carte (police 22 px, 26 px en tactile), cadres et légendes, repères, carte de fin.
- [ ] **Vrai téléphone** : la puce **« Passer »** est-elle cliquable au doigt ? (elle n'est enregistrée que sur la caméra d'interface de Phaser ; si le hit-test échoue sur appareil, repli : un bouton DOM dans `src/mobile/touchControls.ts`). Taille de la puce (300×70 px logiques en tactile) sous le bouton pause DOM. Un doigt sur le stick DOM + un doigt sur la puce en même temps. Dans tous les cas « Quitter » reste possible par la pause.
- [ ] Le cadre du bloc « Objectif de la salle » (haut à droite) n'est pas masqué par la bannière de nom de salle à l'arrivée (l'étape `roomGoals` attend que le bloc soit visible : combien de temps ?).
- [ ] **Indicateur d'appel** : point + 3 arcs bien visibles au bord pendant `callReceive` (le partenaire appelle toutes les 5,2 s depuis 47 tuiles) ; la flèche pulsante dorée au bord de l'écran ne gêne pas les arcs.
- [ ] **Vraie manette PlayStation** (libellés croix = action, carré = appel, triangle = spécial ; détection par le nom « 054c / DualSense ») et manette Xbox (A action / Y spécial / X appel ; B, LB, RB, LT, RT sans effet en jeu) ; **Select** (Share / Create) saute bien l'étape ; **A** confirme la carte de fin.
- [ ] Changement de langue pendant le tutoriel (`retranslate` : carte, légendes, puce, carte de fin) ; lisibilité de la carte à l'échelle d'un téléphone (canvas ramené à 640×360 : le texte de 22-26 px logiques y fait 11-13 px).
- [ ] Échap → « Quitter » → Oui ; relancer le tutoriel **deux fois de suite** ; au retour, une partie à 2 joueurs réattribue bien les appareils (`clearAssignments` / `setPlayerCount`).
- [ ] **Aucune écriture de sauvegarde** : dans les outils du navigateur, `localStorage['vaelorn.save']` (et la clé des choix du menu) restent inchangées après un tutoriel complet et après un abandon.
- [ ] Menu à **13 lignes** (4 joueurs + « Continuer » + « Effacer » + « Tutoriel ») en français et en anglais : tout tient au-dessus de la ligne d'aide (lignes de 31 px quand il y a plus de 12 lignes sélectionnables).
- [ ] Durée ressentie (~3 min simulées pour un joueur efficace) ; la salle sombre avant le relevage ; le **spécial** de chaque personnage peut-il être lancé tout de suite (il démarre prêt) ?
- [ ] Idées non faites : surlignage DOM des boutons tactiles (`setTouchHint`), vue de la moitié d'écran du partenaire pendant l'appel, drapeau « tutoriel déjà vu » (contredirait « ne sauvegarde rien »), entrée « Tutoriel » dans le menu pause, partenaire qui combat en assistance, mode tutoriel à plusieurs humains.

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
- [ ] **Affichage mobile** (vérifié seulement en émulation) : sur le vrai téléphone, dans Chrome : le jeu remplit la zone visible en paysage sans bande ni coupure sous la barre d'adresse, l'invite de rotation apparaît en portrait puis disparaît à la rotation, le bouton plein écran (haut droite) fonctionne et verrouille le paysage, l'écran ne s'éteint pas, pas de zoom/rafraîchissement accidentel. Lisibilité des textes du HUD sur petit écran (envisager une échelle de police minimale ou un HUD « mobile »).
- [ ] **Manette virtuelle tactile** (voir README « Sur téléphone / tablette » ; vérifiée seulement dans un navigateur de bureau avec `?touch=1`, jamais sur un vrai téléphone) : à tester sur **Android (Chrome) ET iPhone (Safari / PWA installée)** : (1) **taille et position** des boutons A/B/X/Y (losange serré : ~38 % de la base du stick pour B, X et Y — le X est l'appel), du bouton pause ; (2) **confort du stick** (rayon, zone morte 0,03 côté stick + 0,25 en aval, zone tactile agrandie de 30 %) et fatigue du pouce ; (3) **latence** doigt → action ; (4) **vibration** (10 ms ; absente sur iPhone) ; (5) **chevauchement** avec le HUD (bouton pause en haut au centre vs. titre / panneau d'équipe), avec les bandes latérales des téléphones plus allongés que 16:9 et avec le bouton plein écran ; (6) **multi-touch** (stick + 2-3 boutons en même temps, pas de touche collée après un `pointercancel`, un appel système ou un changement d'application) ; (7) la **rotation** relâche tout, et la partie se met en pause (« manette virtuelle masquée ») si un joueur inscrit avec la manette virtuelle repasse en portrait : acceptable ? ; (8) brancher une vraie manette en pleine partie (le pad Bluetooth n'est exposé par Chrome Android qu'au premier appui) : l'overlay disparaît et le joueur reprend la vraie manette (`virtualPadHandover.ts`, testé sous Node) ; la débrancher / la laisser s'endormir : l'overlay revient et le joueur reprend la manette virtuelle : à vérifier sur téléphone ; (9) **plein écran** (bouton, option du menu, iPad) : l'overlay est rattaché à l'élément plein écran de Phaser puis ramené dans la page à la sortie : vérifier qu'il reste visible et utilisable (Android Chrome, iPad), sans appui collé à l'entrée/sortie ; (9 bis) taille des zones tactiles sur très petit écran paysage (568×320 : ~44 px minimum visé), bouton du stick contenu dans sa base ; accessibilité : les commandes tactiles portent des `aria-label` traduits et `aria-pressed` mais ne sont pas opérables au lecteur d'écran / clavier (redondantes avec le clavier et la manette) ; (10) un appui plus court qu'une frame est perdu dans les menus (limite connue des manettes) : cela se sent-il au doigt ? Idées : **proposer / forcer 1 joueur** quand la seule manette est virtuelle (aujourd'hui le menu laisse choisir 2-4 joueurs, et la sélection n'aboutit pas), **stick flottant** (apparaît là où le pouce se pose), **tailles et opacité réglables**, **mode gaucher** (inverser les côtés), glisser d'un bouton à l'autre, zone de repli du bouton pause pour éviter les appuis involontaires, rappel des boutons tactiles dans les menus Contrôles et pause.
- [ ] **PWA** : vérifié dans Chrome sur PC (installation du service worker, mise à jour du cache, lancement hors ligne). À vérifier sur le téléphone : installation depuis Chrome Android (*Installer l'application*), icône, plein écran paysage, lancement hors ligne, iPhone/Safari (ajout à l'écran d'accueil). Possible : bouton « Installer » dans le menu (événement `beforeinstallprompt`), invite de mise à jour.
- [ ] Taille du bundle (~1,5 Mo) : découpage en chunks, chargement paresseux des scènes.
- [ ] Sauvegarde automatique des réglages (langue, bindings, difficulté) — la langue et les bindings sont déjà persistés.
- [ ] Intégration continue : le workflow GitHub Pages lance déjà `npm test` et `npm run build`.

## Mode démo / attract mode (voir README « Mode démo (attract mode) » ; prouvé par simulation headless, jamais vérifié dans un vrai navigateur ni sur un téléphone)

À vérifier à la main :

- [ ] `npm run dev` puis `http://localhost:5173/?attractIdle=5&attractDemo=10` : sur l'écran-titre, ne rien toucher 5 s → fondu, démo (bandeau « DÉMO » et invite clignotants, héros qui avance et se bat), retour au menu après 10 s, puis la démo se relance 5 s plus tard (boucle). `?attract=0` : jamais de démo. `?quick=1` / `?tutorial=1` / `?nosave=1` : pas de démo, sauf avec `&attract=1`.
- [ ] **Interruption** : pendant la démo, appuyer sur une touche, cliquer, bouger franchement la souris, tourner la molette, appuyer sur un bouton de manette, pousser un stick, toucher l'écran (téléphone), toucher la manette virtuelle : retour immédiat au menu (fondu court) et **aucun élément du menu n'est validé** par l'entrée qui a interrompu (essayer Entrée, Espace, A, clic, toucher d'une ligne du menu ; la fenêtre de grâce est de 400 ms : trop court / trop long ?).
- [ ] **Sous-écrans** : ouvrir « Contrôles » ou une confirmation (« Nouvelle partie » avec une sauvegarde, « Effacer la sauvegarde ») et attendre plus que le délai : la démo ne doit PAS se lancer ; en revenir, le compte à rebours repart de zéro. Changer de langue relance le compte à rebours.
- [ ] **Onglet caché** : changer d'onglet pendant le compte à rebours (puis revenir) : le temps passé caché ne compte pas ; téléphone en **portrait** (invite de rotation) : pas de démo ; repasser en paysage : le compte à rebours repart.
- [ ] **Lisibilité** : le bandeau « DÉMO » (haut centre) et l'invite (bas centre, 28 px logiques ; critère : ≥ 12 px physiques et lisible sur 800×360) ne recouvrent pas le HUD (objectif en haut, barres de PV / spécial, barre de boss en bas) en 1920×1080, sur téléphone en paysage 800×360, en français et en anglais ; le clignotement (1 s, visible 65 %) est-il agréable ? Les bannières de salle sont volontairement masquées pendant la démo.
- [ ] **Retour de démo** : le nombre de joueurs et la ligne sélectionnée sont conservés ; stick tenu pendant le retour puis relâché : la démo repart bien après le délai ; avec `prefers-reduced-motion` activé, bandeau et invite ne clignotent pas ; sur téléphone, l'invite dit « Touche l'écran pour jouer ».
- [ ] **Sauvegarde intacte** : avec une sauvegarde existante, laisser tourner plusieurs démos ; observer le Local Storage (`vaelorn.save`, `vaelorn.menu.v1`) : rien ne change ; « Continuer » propose toujours la même reprise.
- [ ] **Variété et intérêt** : laisser tourner 10 à 15 démos : niveaux / héros / salles variés ? Le héros combat-il et bouge-t-il vraiment (pas de longue immobilité dans une salle à énigme, pas de collision bizarre contre un décor) ? Certains héros lents (Grok, Brokk) ou fragiles (Sandrine) sont-ils trop souvent à terre ? (en simulation : 0 mort d'équipe sur 96 runs de 30 s).
- [ ] **Durées** : 60 s d'attente et 30 s de démo sont les valeurs d'arcade retenues ; à ajuster dans `src/attract/config.ts` si cela paraît trop court / long sur la télé du salon. Idées : démo à plusieurs joueurs (coop) ou énigmes simples (levier, plaque) résolues par le pilote ; esquive des projectiles ; musique d'ambiance (aujourd'hui aucun son en démo) ; masquer vraiment la manette virtuelle (elle est seulement inopérante) ; démo à relancer aussi depuis l'écran des résultats.

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

- [x] Contrôles tactiles : livrés sous forme de manette virtuelle (voir « Manette virtuelle tactile » plus haut ; à valider sur téléphone).
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
