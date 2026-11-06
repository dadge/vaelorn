# src/net — préparation du multijoueur en ligne

Ce dossier ne contient **aucune dépendance réseau réelle**. Il fixe le contrat (`NetAdapter`) pour que la
simulation et les scènes n'aient pas à changer le jour où le réseau arrive.

- `NetAdapter.ts` : interface (`mode: 'local' | 'host' | 'client'`, `start/stop`, `sendInputs`, `onRemoteInputs`,
  `sendSnapshot`, `onSnapshot`, `ping`) + `LocalNetAdapter` (no-op, ou loopback pour les tests).
- `RemoteInputSource.ts` : `InputSource` de type `network` à brancher avec `inputManager.registerSource(id, src)`.

## Pourquoi c'est faisable

`src/core` est déterministe (PRNG seedé, pas de `Date.now`), pas fixe `SIM_STEP_MS`, et `GameState` est du JSON pur.
On peut donc synchroniser des **entrées** (peu de données) ou des **états** (snapshots).

## Points restant à décider

1. **Modèle de synchronisation** : *lockstep* (chaque pair simule avec les mêmes entrées par tick : léger mais exige
   un déterminisme strict, y compris entre navigateurs, et attend le plus lent) **ou** *hôte autoritaire* (le client
   envoie ses entrées, l'hôte simule et diffuse des snapshots ; plus tolérant, coût en bande passante, besoin
   d'interpolation côté client). L'interface supporte les deux ; le choix pèse sur `sendSnapshot` (utile seulement en hôte autoritaire).
2. **Transport** : WebRTC DataChannel (pair-à-pair, nécessite un serveur de signalisation + STUN/TURN) vs WebSocket
   via un petit serveur relais. Fiabilité/ordre : entrées en canal non fiable avec redondance, snapshots idem.
3. **Découverte / appariement** : code de salle à 4–6 caractères, lien d'invitation, ou LAN uniquement ?
4. **Latence** : tampon d'entrées (délai d'entrée fixe de N ticks en lockstep), prédiction côté client et
   réconciliation, ou simple interpolation de snapshots. `RemoteInputSource` rejoue pour l'instant la dernière frame reçue.
5. **Mapping joueurs ↔ pairs** : chaque pair contrôle un ou plusieurs `PlayerId` ; les joueurs locaux restent
   pilotés par `InputManager`, les distants par `registerSource(playerId, new RemoteInputSource(playerId))`.
   Le nombre de joueurs (`playerCount`) doit être identique chez tous (coop adaptative).
6. **Déconnexion / reconnexion** : un pair perdu = frame vide (`RemoteInputSource.setConnected(false)`) ; faut-il
   permettre de reprendre en cours de salle (snapshot complet) ou mettre en pause ?
7. **Sécurité / triche** : à ignorer pour la coop entre amis ; à revoir si un serveur public est envisagé.
8. **Versionnage** : `GameState.version` doit être vérifié à la connexion (mêmes niveaux, mêmes constantes d'équilibrage).
9. **Menus et sélection de personnage** : synchroniser `GameSession` avant le lancement du niveau.
