# src/net — multijoueur réseau (prototype local, lot 1)

**Conception complète : [`docs/NET.md`](../../docs/NET.md)** (modèle, protocole, machines d'états, mesures, répartition des lots, risques, plan).

Principe retenu : **hôte autoritaire** (l'hôte, joueur 0, simule à 60 Hz ; les invités miroitent l'état reçu à 20 Hz et envoient leurs entrées), un joueur par téléphone sur le même réseau local, WebRTC DataChannel à signalisation manuelle sans serveur (BroadcastChannel en développement avec `?net=bc`, Loopback en test).

## Fichiers

- `contracts.ts` : **contrat figé** du lot 1 (types de messages, `Transport`, rôles, phases, API des sessions, constantes `NET`, petites fonctions pures). Les trois lots d'implémentation l'importent sans le redéfinir.
- `netRuntime.ts` : singleton des objets vivants (session hôte / invité) ; `GameSession.net` (JSON pur) ne porte que les informations sérialisables.
- `NetAdapter.ts` : ancien contrat générique (type `Unsubscribe` réutilisé) et `LocalNetAdapter` (no-op / loopback de test). Le prototype ne l'implémente pas : il passe par `Transport` + sessions.
- `RemoteInputSource.ts` : `InputSource` réseau réutilisé par la session hôte (une instance par invité ; `setConnected(false)` à la perte = frame vide).
- `protocol.ts` (validation stricte, fragmentation, file d'événements), `transportLoopback.ts`, `transportBroadcast.ts`, `transportRtc.ts` (+ `rtcSignaling.ts`, `rtcCodec.ts`, `rtcErrors.ts` : code d'invitation / de réponse), `hostSession.ts`, `clientSession.ts` : livrés ; `netTestKit.ts` et `rtcTestKit.ts` : outils de test (horloge factice, rig hôte + invités sur Loopback, fausses connexions WebRTC).
- Branchement : `NetLobbyScene` (src/scenes) crée les sessions et les range dans `netRuntime` ; `GameScene` les lit (mode hôte / invité, `session.net`) ; la session est libérée (`clearNetRuntime`) à la sortie du multijoueur (retour au menu, hôte perdu, refus), pas à la fin d'une partie. Horloge commune : `performance.now()`.

## Pourquoi c'est faisable

`src/core` est déterministe (PRNG seedé, pas de `Date.now`), pas fixe `SIM_STEP_MS`, et `GameState` est du JSON pur. Mesures : au pire 34 Ko sérialisés (4 joueurs, 40 ennemis), l'instantané complet fragmenté à 20 Hz suffit sur un Wi-Fi local (docs/NET.md § 2).

## Points ouverts du premier jet : état

| # | Point | Décision |
|---|---|---|
| 1 | Modèle de synchronisation | **Tranché : hôte autoritaire.** Pas de lockstep (flottants différents entre iPhone et Android). |
| 2 | Transport | **Tranché :** un canal fiable et ordonné ; WebRTC DataChannel avec signalisation **manuelle** (aucun serveur, aucun STUN / TURN en LAN), BroadcastChannel (dev), Loopback (tests). Pas de WebSocket / relais dans le lot 1 (hôte natif Capacitor au plan, lot 6). |
| 3 | Découverte / appariement | **Tranché :** code d'invitation texte copié-collé (un par invité) et code de réponse. QR codes : lot 3. |
| 4 | Latence | **Tranché pour le lot 1 :** interpolation d'un intervalle de retard côté invité, pas de prédiction (lot 4). Estimation ≈ 100–200 ms d'entrée à l'écran. |
| 5 | Mapping joueurs ↔ pairs | **Tranché :** un joueur par appareil ; l'hôte = joueur 0, les invités 1..3 dans l'ordre d'arrivée, ids contigus au lancement ; personnage choisi au salon, unicité imposée par l'hôte. |
| 6 | Déconnexion / reconnexion | **Tranché :** invité perdu = frame vide, la partie continue ; hôte perdu = retour au menu avec message. **Reconnexion en cours de partie : hors lot 1** (lot 5). |
| 7 | Sécurité / triche | **Tranché :** ignorées (coop entre amis) ; validation stricte de forme de tout message entrant (docs/NET.md § 5.5). |
| 8 | Versionnage | **Tranché :** à la connexion, version de protocole + libellé de build (`src/buildInfo.ts`) + nombre de niveaux ; refus explicite avec message traduit. |
| 9 | Menus et sélection de personnage | **Tranché :** `NetLobbyScene` (salon) ; chaque participant choisit son personnage, l'hôte arbitre ; `GameSession.net` posé au lancement. |

Hors lot 1 : sauvegarde (jamais écrite en partie réseau), tutoriel, démo, pause qui fige, prédiction, reconnexion, QR codes, hôte natif.
