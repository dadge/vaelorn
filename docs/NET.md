# Multijoueur réseau local — conception du prototype (lot 1)

Statut : conception figée pour le prototype. Les contrats TypeScript qui en découlent sont dans `src/net/contracts.ts` (types, constantes, petites fonctions pures) et `src/net/netRuntime.ts` ; le champ de session est `GameSession.net` (`src/render/session.ts`). Les trois lots d'implémentation (A, B, C, § 10) **importent** ces fichiers et ne les modifient pas : un besoin de changement se signale (« deviations » du compte rendu), il ne se fait pas en douce.

## 1. Objectif et périmètre

Jouer ensemble **la même partie, un joueur par téléphone**, sur le même réseau local. Une version du jeu (PWA) est installée sur chaque téléphone ; l'un d'eux sert d'**hôte** (le partage de connexion Wi-Fi est activé **à la main** par l'utilisateur : une page web ne peut ni créer de point d'accès ni écouter sur un port, d'où WebRTC + signalisation manuelle).

Décisions déjà prises (non rediscutées ici, seulement mises en œuvre) :

1. **Hôte autoritaire.** L'hôte exécute `GameSimulation` à 60 Hz avec ses entrées et celles des invités. Les invités **n'exécutent pas** la simulation : ils **miroitent** l'état reçu et envoient leurs entrées (`ActionFrame`). Pas de lockstep (les flottants peuvent différer entre iPhone et Android).
2. L'hôte est le joueur 0 ; les invités prennent 1..3 dans l'ordre d'arrivée ; 2 à 4 joueurs. Chacun choisit son personnage au salon (unicité imposée par l'hôte).
3. **Un canal fiable et ordonné** (messages JSON texte) ; messages > 12 000 caractères fragmentés ; instantanés d'état à **20 Hz** (1 tous les 3 pas) **avec** les événements de simulation produits depuis l'instantané précédent (sons, FX, textes flottants) ; l'invité n'applique que le plus récent ; l'hôte n'envoie pas sur un canal saturé (`bufferedAmount`) ; l'invité interpole en affichant avec un intervalle de retard (mécanisme `stepped` / `alpha` des vues existantes).
4. Une interface **`Transport`** minimale, trois implémentations : Loopback en mémoire (tests), BroadcastChannel (développement, `?net=bc`, deux fenêtres du même navigateur, sans signalisation manuelle), WebRTC DataChannel avec signalisation **manuelle sans serveur** (code d'invitation / code de réponse copiés-collés, un code par invité, attente de la fin de la collecte ICE, aucun STUN/TURN en LAN). QR codes hors lot 1 (le code reste une courte chaîne copiable).
5. **Vérification de version** à la connexion : version de protocole + libellé de build (`src/buildInfo.ts`) + nombre de niveaux ; refus explicite avec message traduit.
6. **Hors lot 1** : sauvegarde (jamais écrite en partie réseau, ni côté hôte ni côté invité), tutoriel, démo / attract, pause qui fige, prédiction côté invité, reconnexion en cours de partie, QR codes, hôte natif Capacitor. Fin de niveau : retour de tous au salon avec un message (pas de campagne enchaînée).
7. **Déconnexion** : un invité perdu = frame d'entrée vide côté hôte (`RemoteInputSource.setConnected(false)`), la partie continue ; l'hôte perdu = les invités reviennent au menu avec un message.

Garantie transversale : **tout chemin de jeu local** (1 à 4 joueurs sur le même écran, tutoriel, démo), les 4 premiers niveaux de règles, les bots et tous les tests existants restent **octet pour octet** identiques. Tout ajout au cœur ou à `GameScene` est additif et gardé (`if (this.net)`, paramètre optionnel dont la valeur par défaut est l'ancien comportement).

## 2. Mesures : taille réelle d'un `GameState` sérialisé

Méthode : script Node jetable (hors dépôt), `createSimulation` à 1 et 4 joueurs (David, Sandrine, Romain, Valentine, difficulté 2, `heartSlot`), **chaque salle de chacun des 9 niveaux** prise comme salle de départ, 1 800 pas (30 s) par salle avec des entrées scriptées (déplacement en cercle, attaque quasi continue, spécial toutes les 5 s), un instantané `JSON.stringify(state)` tous les 3 pas.

| Niveau | 1 joueur : pire cas | 1 joueur : moyenne | 4 joueurs : pire cas | 4 joueurs : moyenne | pire salle (4 j.) |
|---|---|---|---|---|---|
| 1 | 14 065 o | 9 103 o | 24 944 o | 16 154 o | cells |
| 2 | 13 533 o | 11 120 o | 21 983 o | 18 981 o | nid |
| 3 | 14 225 o | 9 127 o | 27 570 o | 17 593 o | balconies |
| 4 | 21 878 o | 14 609 o | 33 947 o | 25 834 o | deepdark |
| 5 | 21 339 o | 15 181 o | 34 060 o | 26 520 o | emberhold |
| 6 | 17 640 o | 9 442 o | 30 967 o | 15 452 o | hearth |
| 7 | 24 333 o | 12 923 o | 33 523 o | 24 306 o | glassheart |
| 8 | 22 278 o | 15 502 o | 33 217 o | 27 776 o | armurerie |
| 9 | 25 686 o | 13 057 o | 33 151 o | 23 424 o | gallery |

Constats :

- **Maximum mesuré : 34 060 octets** (4 joueurs, niveau 5, salle `emberhold`, 40 ennemis). Le plafond `MAX_ALIVE_ENEMIES = 40` borne la croissance : pire cas réaliste ≈ 36–38 Ko. Compressé (gzip, indicatif, **non utilisé**) : 4,9 Ko.
- **Les champs statiques de la salle ne sont déjà pas dans l'état** : la grille, les mécanismes (définitions), les décors vivent dans `LevelDef`, que l'invité possède. `GameState` ne contient que du dynamique. Un « instantané compact grâce à `LevelDef` » n'a donc presque rien à retirer.
- **Ce qui pèse** : les ennemis (≈ 28 Ko sur 34, soit ≈ 700 o par ennemi dont ≈ 470 o de `data`, un dictionnaire de ~30 champs presque tous à 0) ; les joueurs ≈ 0,7 Ko chacun ; les projectiles ≤ 1,9 Ko ; le reste (objectifs, mécanismes, aléa, compteurs) < 1,5 Ko.
- **Événements** produits entre deux instantanés (3 pas) : moyenne 11 o (1 joueur) à 55 o (4 joueurs), **maximum 4 139 o** (gros combat).
- **Fragmentation** : le pire message (34,2 Ko) donne 3 fragments ; l'échappement JSON des guillemets dans `d` ajoute **+15 %** (39,3 Ko sur le fil), chaque fragment ≤ 13,8 Ko (< 16 Ko : limite d'interopérabilité des piles DataChannel).
- **Débit au pire cas** : 39,3 Ko × 20 Hz ≈ 785 Ko/s ≈ **6,3 Mbit/s par invité** ; l'hôte avec 3 invités émet ≈ **19 Mbit/s** ; cas courant (moyennes à 4 joueurs : 15–28 Ko) ≈ 2,8–5,1 Mbit/s par invité. Un point d'accès téléphone en 802.11n/ac tient ces débits mais sans grande marge au pire cas.
- **Coût CPU** (ordinateur, indicatif) : `JSON.stringify` ≈ 0,1 ms, `JSON.parse` ≈ 0,35–0,5 ms par instantané ; sur un téléphone d'entrée de gamme, ×5 à ×10 : < 5 ms, négligeable devant le rendu.
- **Compaction possible plus tard** (mesure sur le pire état) : retirer les champs `data` d'ennemi égaux à 0 et arrondir les flottants à 2 décimales donne **−46 %** (18,5 Ko) ; fragments sans échappement JSON : −13 % de plus.

**Conclusion : l'instantané complet fragmenté suffit à 20 Hz sur un Wi-Fi local** pour le prototype. Le protocole le déclare (`MsgSnap.st` = `GameState` entier, « format full ») ; une compaction ultérieure incrémente `NET_PROTOCOL_VERSION` (refus net en cas de mélange). Filets de sécurité déjà prévus dans le lot 1 : l'hôte saute un instantané pour un invité dont `bufferedAmount` dépasse `NET.BUFFERED_HIGH_WATER` (la cadence se dégrade seule, jamais de file qui grossit), et l'invité n'applique que le plus récent.

## 3. Architecture

```
                 HÔTE (joueur 0)                                   INVITÉ (joueur 1..3)
 entrées locales ─┐                                              entrées locales ─┐
                  ▼                                                               ▼
  GameScene ──► sim.step(60 Hz) ◄── pollRemoteInputs() ◄── input (30 Hz) ◄── ClientSession.sendInput
       │              │ events                                                    ▲
       │              ▼                                                           │
       │      HostSession.afterStep ──► snap (20 Hz, fragmenté) ──► ClientSession.takeSnapshot
       ▼                                                                          │
  vues Phaser                                                      sim.applyMirrorState(state) + handleEvent(events)
                                                                                  ▼
                                                                          vues Phaser (interpolées, 1 intervalle de retard)
```

Couches (de bas en haut) : `Transport` (canal de texte fiable) → `protocol.ts` (JSON, fragmentation, validation stricte) → `HostSession` / `ClientSession` (salon, partie, battements, entrées) → scènes (`NetLobbyScene`, `GameScene`). Le `Transport` ne connaît ni JSON ni fragmentation. Les sessions n'ont **aucun timer interne** et **aucune horloge** : la scène appelle `update(nowMs)` à chaque frame (salon **et** partie, avec `performance.now()`), ce qui rend toute la logique testable avec une horloge factice.

Objets vivants (sessions, transports, invitations WebRTC en attente) : singleton de module `src/net/netRuntime.ts` (`setNetRuntime`, `getHostSession`, `getClientSession`, `clearNetRuntime`). `GameSession` reste du **JSON pur** : seul le champ `net?: NetSessionInfo` y est ajouté (rôle, `gameId`, `localPlayerId`, type de transport, graine, noms). Il est posé par `NetLobbyScene` au lancement, **jamais** par le jeu local. La session survit aux parties (retour au salon avec les mêmes liaisons) ; `clearNetRuntime()` n'est appelé qu'en quittant le multijoueur (retour au menu).

## 4. Transports

Contrat `Transport` (`contracts.ts`) : canal **fiable et ordonné** de messages **texte** entre deux pairs (hôte ↔ un invité). `state` (`connecting | open | closed`), `bufferedAmount`, `maxMessageChars`, `send`, `onMessage`, `onState`, `close`. Un message est livré en entier ou pas du tout, dans l'ordre. Les rappels sont asynchrones par rapport au `send` du pair (jamais appelés depuis l'intérieur de `send`), sauf le Loopback en mode synchrone.

### 4.1 Loopback (tests) — `src/net/transportLoopback.ts`

`createLoopbackPair(options?) → LoopbackPair { a, b, flush(), pending(), setBufferedAmount(n), cut(reason?) }`. Par défaut les messages sont **mis en file** et livrés par `flush()` (tests déterministes d'ordre et de retard) ; `synchronous: true` livre à `send`. `maxMessageChars` par défaut = `NET.FRAGMENT_CHARS` + marge d'enveloppe : un test qui oublie de fragmenter échoue. `setBufferedAmount` simule la saturation, `cut` une coupure franche.

### 4.2 BroadcastChannel (développement) — `src/net/transportBroadcast.ts`

Activé par `?net=bc` (`parseNetTransportParam`). Deux **fenêtres** du même navigateur et de la même origine (pas deux onglets d'une même fenêtre : l'onglet en arrière-plan voit sa boucle Phaser suspendue et ses minuteries bridées, l'hôte « gèlerait »). `createBroadcastHost(channelName = NET_BC_CHANNEL) → BroadcastHostLink` (`onGuest`, `close`) et `connectBroadcastGuest(channelName?, timeoutMs = 5000) → Promise<Transport>`. Multiplexage point à point sur un seul canal, enveloppe `{ k, … }` :

| `k` | sens | rôle |
|---|---|---|
| `discover` | invité → tous | `{ k, from }` : l'invité cherche un hôte (`from` = id aléatoire de l'invité) |
| `offer` | hôte → invité | `{ k, to, link }` : l'hôte propose une liaison (`link` = id de liaison) |
| `join` | invité → hôte | `{ k, from, link }` : l'invité accepte ; les deux `Transport` passent à `open` |
| `data` | les deux sens | `{ k, link, side: 'h' \| 'g', text }` : un message de la couche protocole |
| `close` | les deux sens | `{ k, link }` |

Les messages `data` / `close` d'une liaison inconnue sont ignorés. Un seul hôte par canal : un second hôte qui détecte un `offer` étranger lève une erreur claire au lancement.

### 4.3 WebRTC DataChannel, signalisation manuelle — `src/net/rtcSignaling.ts` (+ `transportRtc.ts`)

`createRtcHostSignaling(options?) → RtcHostSignaling { createInvite() }`, `createRtcGuestSignaling(options?) → RtcGuestSignaling { join(code) }`, `RtcSignalingError` (champ `code` : `unsupported | badCode | wrongVersion | iceTimeout | failed | cancelled`), `isRtcSupported()`.

Déroulé (un code par invité, UNE invitation à la fois : pour inviter le suivant, l'hôte refait l'étape 3 ; jusqu'à 3 invités au total) :

1. **Hôte** : « Inviter » → `createInvite()` : `new RTCPeerConnection({ iceServers: [] })` (**aucun** STUN/TURN : réseau local seulement), un `RTCDataChannel` **négocié** (`negotiated: true, id: 0, ordered: true`, fiable) créé des deux côtés pour éviter `ondatachannel`, `createOffer`, `setLocalDescription`, puis **attente de la fin de la collecte ICE** (`iceGatheringState === 'complete'`, plafonnée à `iceTimeoutMs`, 4 000 ms par défaut ; zéro candidat = `iceTimeout`). Le **code d'invitation** exporte la description locale *après* la collecte.
2. **Invité** : colle le code → `join(code)` → `setRemoteDescription(offer)`, `createAnswer`, attente de la fin de la collecte, rend `{ answerCode, transport }`. Il affiche le **code de réponse**.
3. **Hôte** : colle le code de réponse → `invite.accept(answerCode)` → `setRemoteDescription(answer)` ; quand le canal s'ouvre la promesse rend le `Transport` ouvert → `host.addGuest(transport)`.
4. **Invité** : `transport` se résout à l'ouverture → `createClientSession(transport, …)` → `hello`.

Format du code (recommandation au lot A ; seul le contrat TypeScript est imposé) : préfixe de version et de genre (`V1O` invitation, `V1A` réponse), charge utile en **base64url** `[A-Za-z0-9_-]`, somme de contrôle courte (24 bits, 4 caractères) en fin de chaîne ; groupes de 5 caractères séparés par des **espaces** (jamais `-`, qui fait partie de l'alphabet) ; tous les blancs sont ignorés à la lecture. Charge utile : une description compacte (`SignalDesc` : identifiants ICE, empreinte, rôle `setup`, candidats les plus utiles) dont `rtcCodec.ts` reconstruit le SDP, en JSON UTF-8 **brut** (un octet d'indicateur : 0 = brut ; 1 = `deflate-raw`, lisible mais jamais produit par défaut : l'émetteur ignore si le lecteur dispose de `DecompressionStream`, et le gain est faible), le tout ≤ `NET.CODE_MAX_CHARS` (4 096) et typiquement 250–600 caractères. Erreurs : mauvaise somme = `badCode` ; code d'une autre version = `wrongVersion` ; réponse collée à la place d'une invitation (ou l'inverse) = `badCode` ; le code n'est jamais interprété autrement que par `setRemoteDescription` après validation de forme.

Limites connues : voir § 11 (candidats mDNS `.local`, isolation des clients Wi-Fi, interface du point d'accès iOS).

## 5. Protocole

Tout est du **JSON texte** : un objet avec un champ `t` (type). Les types sont répartis par direction (`GUEST_TO_HOST_TYPES`, `HOST_TO_GUEST_TYPES` dans `contracts.ts`) : tout type hors de la liste de la direction est un message invalide.

### 5.1 Messages

| Type | Sens | Champs | Rôle |
|---|---|---|---|
| `hello` | invité → hôte | `proto`, `build` (`{version, commit, date}`), `levels`, `name` | premier message après l'ouverture du canal ; le nom est assaini (`sanitizeNetName`) |
| `welcome` | hôte → invité | `proto`, `build`, `levels`, `slot`, `lobby` | accepté ; `slot` = emplacement provisoire de salon |
| `reject` | hôte → invité | `proto`, `build`, `levels`, `reason` ∈ `protocol \| build \| levels \| started \| full \| malformed` | refusé ; porte les données de **l'hôte** pour afficher la différence ; l'hôte ferme ensuite le canal |
| `lobby` | hôte → invité | `lobby` (`LobbyState`), `you` | état autoritaire du salon, un message **par invité** (`you` = son emplacement), à chaque changement |
| `choice` | invité → hôte | `characterId`, `difficulty`, `ready` | choix du participant ; l'hôte tranche et rediffuse `lobby` (l'invité n'applique rien en local) |
| `start` | hôte → invité | `gid`, `you`, `levelIndex`, `seed`, `players` (`{id, characterId, difficulty, name}[]`) | la partie démarre ; `you` = identifiant de jeu définitif ; ids **contigus** 0..n−1, l'hôte = 0 |
| `input` | invité → hôte | `gid`, `seq`, `x`, `y`, `b` | entrée « tenue » du joueur ; `x`, `y` entiers −100..100 (centièmes) ; `b` = masque de boutons (`FRAME_BIT` : attack 1, interact 2, revive 4, special 8, call 16, heart 32) ; `seq` croissant |
| `snap` | hôte → invité | `gid`, `n`, `tick`, `pc`, `st` (`GameState`), `ev` (`SimEvent[]`) | instantané autoritaire + événements depuis le **précédent envoyé à CET invité** ; `pc` = masque des joueurs connectés |
| `end` | hôte → invités | `gid`, `reason` ∈ `levelCompleted \| hostQuit \| aborted` | la partie se termine pour tous ; la liaison reste ouverte, retour au salon |
| `leave` | les deux sens | — | départ propre, suivi de la fermeture du canal |
| `ping` | hôte → invité | `n`, `ts` | battement et mesure d'aller-retour (`ts` = horloge de l'hôte, renvoyée telle quelle) |
| `pong` | invité → hôte | `n`, `ts` | réponse |
| `frag` | les deux sens | `id`, `i`, `n`, `d` | fragment d'un message long (§ 5.2) |

`LobbyState` = `{ seq, slots: LobbySlot[], levelIndex, levelCount }` ; `LobbySlot` = `{ slot, name, isHost, connected, characterId, difficulty, ready, pingMs? }`. `seq` croît à chaque diffusion : un invité ignore un `lobby` de `seq` ≤ au dernier appliqué.

Exemple d'`input` (≈ 55 octets, 30 Hz ≈ 1,6 Ko/s) : `{"t":"input","gid":123456789,"seq":42,"x":100,"y":-30,"b":1}`.

L'identité d'un joueur **n'est jamais un champ du message** : elle vient du canal (chaque invité a son propre `Transport`), donc un invité ne peut pas piloter le joueur d'un autre.

### 5.2 Fragmentation

- Un message sérialisé de plus de `NET.FRAGMENT_CHARS` (12 000) caractères est découpé en tranches de 12 000 ; chaque tranche est envoyée dans un `frag` `{ t, id, i, n, d }` (`d` = tranche du JSON d'origine, `i` ∈ [0, n[, `id` croît à chaque message fragmenté, par émetteur).
- Les fragments d'**un** message sont émis **à la suite**, dans une même boucle synchrone, **jamais entrelacés** avec d'autres messages : un seul réassemblage en cours par sens. Le canal étant ordonné et fiable, aucune numérotation de reprise n'est nécessaire ; un `id` qui n'est pas strictement croissant, un `i` inattendu, un `n` incohérent ou > `NET.MAX_FRAGMENTS` (32) abandonne le réassemblage (message invalide).
- Réassemblage plafonné à `NET.MAX_MESSAGE_CHARS` (262 144) ; un réassemblage incomplet depuis plus de `REASSEMBLY_TIMEOUT_MS` (3 000 ms) est abandonné (`update(nowMs)`).
- Un message brut de plus de `MAX_MESSAGE_CHARS` est rejeté **avant** `JSON.parse`.
- Couper en unités UTF-16 est sûr : `JSON.stringify` échappe les moitiés de paires de substitution isolées et la concaténation après analyse les recolle.
- Optimisation sans changement de contrat possible plus tard : hôte qui sérialise `st` **une seule fois** par instantané et assemble le message de chaque invité par concaténation de chaînes (`'{"t":"snap","gid":…,"st":' + stJson + ',"ev":' + evJson + '}'`) au lieu de re-sérialiser l'état par invité.

### 5.3 Rythme

| Flux | Cadence | Remarque |
|---|---|---|
| Simulation hôte | 60 Hz (pas fixe `SIM_STEP_MS`) | inchangée |
| `snap` | 20 Hz : après le pas `t` si `snapshotDue(t)` (t multiple de 3) | sauté pour un invité dont `bufferedAmount > BUFFERED_HIGH_WATER` ; ses événements restent en attente |
| `input` | ≤ 30 Hz (`INPUT_SEND_MS` = 33 ms), appelé à chaque frame de rendu, la session cadence | les boutons sont combinés en OU entre deux envois (un appui court n'est jamais perdu) ; les axes prennent la dernière valeur |
| `ping` | toutes les 2 s (`PING_INTERVAL_MS`), salon **et** partie | alimente `pingMs` du salon et `rttMs()` |

Entrée distante côté hôte : `pollRemoteInputs()` rend, à chaque pas, la **dernière** frame reçue de chaque invité connecté ; plus vieille que `INPUT_STALE_MS` (250 ms) ou invité perdu = **frame vide** (jamais d'attaque « collée »). Les ids hors partie, les `seq` ≤ au dernier, les cadences au-delà de `MAX_INPUT_PER_SEC` (120/s) sont ignorés. La détection de front montant reste celle de la simulation (elle compare les frames d'un pas à l'autre).

### 5.4 Événements de simulation

`SimEvent` est transporté tel quel dans `snap.ev`. L'hôte accumule, **par invité**, tous les événements des pas écoulés depuis le dernier instantané réellement émis **à cet invité** (si des instantanés sont sautés, ils s'accumulent) ; l'invité accumule de même ceux de tous les instantanés reçus entre deux `takeSnapshot()` (il n'applique que le plus récent **état**, mais **jamais** ne perd un événement). Bornes : `MAX_PENDING_EVENTS` (512) de chaque côté ; au-delà, on jette les plus anciens **sauf** `SIM_EVENTS_NEVER_DROPPED` (`roomEntered`, `levelCompleted`, `teamWipe`, `playerDown`, `playerRevived` : ils pilotent l'interface). Le type de chaque événement reçu est filtré sur `SIM_EVENT_TYPES` ; cette liste est **vérifiée à la compilation** (`MissingSimEventTypes` doit rester `never` : ajouter un événement à `SimEvent` sans l'ajouter à la liste fait échouer `tsc`).

### 5.5 Validation stricte de tout message entrant (sécurité minimale)

Appliquée dans `protocol.ts` (lot A) à **chaque** message, côté hôte comme côté invité ; jamais d'exception qui remonte : un message invalide est ignoré et compté.

1. Longueur ≤ `MAX_MESSAGE_CHARS` avant `JSON.parse` ; `JSON.parse` dans un `try`.
2. Le résultat est un objet simple (ni tableau, ni `null`), `t` est une chaîne **de la liste de la direction**.
3. Chaque champ : type exact, entiers dans leur plage (`x`, `y` ∈ [−100, 100], `b` ∈ [0, 63], `seq` entier ≥ 0, `gid` entier 32 bits, `characterId` ∈ `CHARACTER_IDS`, `difficulty` ∈ {1, 2, 3}, `ready` booléen, `name` assaini et ≤ 16 points de code, tailles de tableaux bornées). Aucun spread d'un objet reçu dans un état interne ; champs inconnus ignorés ; clés `__proto__` / `constructor` jamais copiées.
4. `gid` doit être celui de la partie en cours (`input`, `snap`, `end`) ; `seq` / `n` strictement croissants, sinon ignoré.
5. Cadences plafonnées (`MAX_INPUT_PER_SEC`, `MAX_CHOICE_PER_SEC`) : le surplus est ignoré.
6. Après `MAX_MALFORMED` (20) messages invalides d'un pair, sa liaison est fermée (côté invité : `protocolError`).
7. `snap.st` : enveloppe validée par `protocol.ts` (objet, `version === 1`, `levelId` chaîne égale à celle du niveau en cours) ; **validation complète** par `GameSimulation.applyMirrorState` (§ 7.3), qui ne modifie rien en cas d'échec. Les événements : type dans `SIM_EVENT_TYPES` + objet ; en plus `GameScene` côté invité protège chaque `handleEvent` d'un `try/catch` (un événement mal formé ne fait pas tomber le rendu).
8. Un invité n'agit que sur **son** emplacement ; l'hôte ne fait confiance à aucune valeur du message pour décider d'un identifiant, d'un niveau ou d'un état.

Hors périmètre (coop entre amis) : anti-triche, chiffrement applicatif (DTLS du DataChannel protège le canal), authentification au-delà du code collé.

## 6. Machines d'états

### 6.1 Session hôte (`HostPhase` : `lobby | playing | closed`)

```
 (création) ─► lobby ──startGame(seed) [checkStart ok]──► playing ──endGame(reason)──► lobby
                 │                                          │
                 └──────────────── close() ─────────────────┴──► closed (idempotent)
```

Salon (`lobby`) :

- `addGuest(transport)` : le `Transport` est surveillé ; `hello` doit arriver sous `HELLO_TIMEOUT_MS` (5 s) sinon fermeture. À `hello` : vérification dans l'ordre **protocole → build → niveaux → partie en cours (`started`) → salon plein (`full`) → message invalide (`malformed`)** (`compatibilityCheck` pour les trois premiers). Succès : emplacement libre le plus bas (1..3), personnage par défaut = premier de `CHARACTER_IDS` non utilisé, `welcome`, puis `lobby` à tous. Refus : `reject` puis fermeture.
- Arbitrage des `choice` (l'hôte tranche) : changer de personnage ou de difficulté est toujours accepté tant que `ready` est faux ; passer à `ready: true` est refusé (remis à `false`) si un **autre participant prêt** a déjà ce personnage → « deux participants prêts n'ont jamais le même personnage ». Redevenir non prêt est toujours possible. `setLocalChoice` (hôte) suit la même règle.
- `setLevel(i)` : réservé à l'hôte, borné à [0, `levelCount`[ ; remet tout le monde à « pas prêt ».
- `checkStart()` : `{ ok: false, reason: 'needTwo' }` si moins de 2 participants connectés ; `'notReady'` si l'un n'est pas prêt ; sinon `ok`.
- Un invité perdu (canal fermé ou silence > `PEER_TIMEOUT_MS`) ou parti (`leave`) est **retiré** du salon ; les autres gardent leur emplacement ; `NetPeerEvent` `left` / `lost`.
- `startGame(seed)` : numérote les participants en ids contigus 0..n−1 (hôte = 0, puis ordre des emplacements), envoie `start` (un message par invité : `you` propre), passe en `playing`, retourne `NetStartInfo` (l'hôte vaut `localPlayerId` 0).

Partie (`playing`) :

- `pollRemoteInputs()` (à chaque pas) ; `afterStep(state, events)` (après chaque pas) ; `update(nowMs)` (chaque frame).
- Un invité perdu : `connected = false`, `pc` mis à jour, entrée = frame vide, **le joueur reste dans la simulation** (immobile, relevable) ; `NetPeerEvent` `lost`.
- Une nouvelle liaison pendant la partie : `reject` `started`.
- `endGame(reason)` : `end` à tous les invités connectés, retour à `lobby`, choix remis à « pas prêt » ; après `levelCompleted`, niveau suivant présélectionné (borné au dernier).

### 6.2 Session invité (`ClientPhase` : `connecting | handshaking | lobby | playing | closed`)

```
 connecting ─(transport open)─► handshaking ──welcome──► lobby ──start──► playing ──end──► lobby
      │                              │                     │                │
      └─ échec ──────────────────────┴── reject ───────────┴── perte ────────┴──► closed
```

- `connecting` : le transport s'ouvre (WebRTC : après le collage du code de réponse côté hôte). `handshaking` : `hello` envoyé, attente de `welcome` ou `reject` (`HELLO_TIMEOUT_MS`).
- `lobby` : `onLobby` à chaque `lobby` (ignoré si `seq` ≤ dernier) ; `sendChoice`.
- `playing` : après `start` (`onStart` avec `NetStartInfo`) ; `sendInput` chaque frame, `takeSnapshot` chaque frame ; `ping` → `pong`.
- `end` (de la partie en cours) : retour à `lobby` (`onEnd`), la liaison reste ouverte ; l'hôte rediffuse `lobby`.
- `closed` : **une seule** notification `onClosed(info)` avec `NetCloseReason` : `userLeft` (aucun message), `hostLeft` (l'hôte a envoyé `leave`), `hostLost` (silence > `PEER_TIMEOUT_MS`), `transportFailed`, `protocolError`, `rejected` (avec `info.reject` = données de l'hôte).

### 6.3 Scènes et sessions (qui fait quoi à la sortie)

| Événement | Hôte | Invité |
|---|---|---|
| Niveau terminé (`levelCompleted` + célébration `CELEBRATION_MS`) | `host.endGame('levelCompleted')`, `scene.start(NetLobby, { entry: 'return', notice: noticeForEnd(...) })` | reçoit `end` → même retour au salon avec le même message |
| L'hôte quitte via le menu pause | `host.endGame('hostQuit')`, retour au salon | reçoit `end(hostQuit)` → salon avec message |
| L'hôte ferme le salon (retour au menu depuis le salon) | `clearNetRuntime()` (envoie `leave`), `Menu` | `onClosed(hostLeft)` → `Menu` avec message |
| Un invité quitte (pause → quitter, ou retour au menu) | voit un pair `left` : sa partie continue | `client.leave()`, `clearNetRuntime()`, `Menu` sans message |
| Un invité est perdu | frame vide, partie continue, toast `net.game.peerLost` | — |
| L'hôte est perdu | — | `onClosed(hostLost \| transportFailed)` → `clearNetRuntime()`, `Menu` avec message |
| Refus à la connexion | — | `onClosed(rejected)` → reste sur l'écran de connexion avec le message `reject.*` (et la différence de build) |
| État de jeu rejeté (`applyMirrorState` échoue) | — | `leave()`, `Menu` avec `protocolError` |

La **défaite** n'existe pas comme fin de partie : la mort d'équipe (`teamWipe`, phase `wipe`) redémarre la salle automatiquement dans la simulation, donc aussi en réseau.

## 7. Cœur et scène de jeu

### 7.1 Modes de `GameScene`

`GameScene.create()` lit `session.net` : absent = **chemin local strictement inchangé**. Tous les ajouts sont gardés par `if (this.net)` (même discipline que `if (this.tutorial)` / `if (this.demoFlow)`).

Commun aux deux rôles : niveau = `getLevelByIndex(session.levelIndex)` (les paramètres `?dev=` / `?dark=` / `?room=` / démarrage rapide sont **ignorés**) ; graine = `session.net.seed` (aucune graine tirée par la scène) ; `createSimulation({ levelId, players: session.players, seed, ...modeSimFlags({ tutorial: false, demo: false }) }, level)` **sans** `startRoomIndex`, `initialGear` ni `initialHearts` ; **aucun `AutoSaver`** ; pas de tutoriel ni de démo ; `viewCount = 1` (une vue plein écran pour l'appareil local, comme le tutoriel qui simule 2 joueurs pour 1 vue) ; `inputManager.setPlayerCount(1)` (le joueur local utilise clavier / manette / manette virtuelle tactile comme en solo). L'entrée locale passe par `HeartInputGuard` avant d'être utilisée ou envoyée.

**Hôte** (`role: 'host'`) :

```ts
host.update(now);                                  // chaque frame
for (let i = 0; i < plan.steps; i++) {
  const inputs = { ...host.pollRemoteInputs(), 0: localFrame };   // hôte = joueur 0 ; le latch d'appuis courts est celui du jeu local
  const events = this.sim.step(SIM_STEP_MS, inputs);
  host.afterStep(this.sim.state, events);          // accumule, émet un instantané tous les 3 pas
  for (const e of events) this.handleEvent(e, state);   // sons / FX locaux, inchangés
}
```

**Invité** (`role: 'client'`) : la scène crée tout de même une `GameSimulation` (état initial valide, `sim.room`, `sim.grid`, `isExitOpen()`, `level` dont les vues ont besoin) mais **n'appelle jamais `sim.step`** ; à chaque frame :

```ts
client.update(now);
client.sendInput(this.heartGuard.filter(inputManager.poll())[0] ?? emptyFrame(), now);
const snap = client.takeSnapshot();
if (snap) {
  const r = this.sim.applyMirrorState(snap.state);          // valide puis copie sur place
  if (!r.ok) return this.leaveToMenu({ code: 'protocolError' });
  this.mirror.feed(snap, now);                               // nouvel intervalle d'interpolation
  for (const e of snap.events) this.handleEventSafe(e, state);   // try/catch
  if (r.roomChanged || this.forceRebuild) this.buildRoom(this.pendingReason);
}
const view = this.mirror.advance(dt);                        // { stepped, alpha, timeMs }
this.syncViews(dt, view.stepped, view.alpha, view.timeMs);
```

### 7.2 Un identifiant de joueur n'est pas un indice de vue

Le code actuel suppose `huds[i]` = joueur `i` = vue `i` (vrai en écran partagé et dans le tutoriel où l'humain est le joueur 0). En réseau l'invité local est le joueur `localPlayerId` ∈ 1..3 dans **une seule** vue d'indice 0 : le lot B introduit une correspondance explicite (`viewOf(playerId)` : 0 pour le joueur local, absent pour les autres ; `hudOf(playerId)`), applicable partout où le code indexe par `playerId` :

- `PlayerHud` : ajouter un paramètre **optionnel** `viewIndex = playerId` (la ligne `layout.viewports[playerId]` devient `layout.viewports[viewIndex]`) ; valeur par défaut = ancien comportement. Seul changement de `src/render/hud.ts`.
- Caméra : `rig.follow(0, positionDeLaVueDuJoueurLocal)` seulement ; `rig.shake(…, playerId)` : secousse de la vue 0 uniquement quand l'événement concerne le joueur local, **pas** de secousse globale pour les autres (`playerId` indéfini secoue toutes les vues).
- `handleEvent` : les `this.huds[e.playerId]?.…` ne s'appliquent qu'au HUD du joueur local (`hudOf`) ; les toasts adressés aux autres joueurs sont adaptés (par exemple `game.allyDown` à l'invité local quand un autre tombe).
- **Panneau d'équipe** : `computeLayout(1)` n'a pas de `teamPanel` ; recommandé de créer un `TeamPanelHud` avec un rectangle propre à l'écran réseau (bandeau en coin, `ScreenRect` fourni par la scène) pour voir les PV des autres joueurs. À défaut, c'est une limite connue du prototype (§ 11).

### 7.3 `GameSimulation.applyMirrorState` (lot B, `src/core/simulation.ts`)

Méthode **additive** (aucune règle de jeu touchée) :

```ts
applyMirrorState(next: unknown): MirrorApplyResult   // type dans contracts.ts
```

1. **Valide** `next` en entier avant toute écriture : objet, `version === 1`, `levelId === this.level.id`, `players` tableau de 1..4 joueurs de même longueur que l'état courant, `roomIndex` entier ∈ [0, nombre de salles[, `room`, `objectives`, `clearedRooms` de forme attendue, nombres **finis** (positions, PV, minuteurs), tailles de tableaux bornées (ennemis ≤ 64, projectiles ≤ 256, objets au sol ≤ 128…), `characterId` / types d'ennemis connus (sinon l'IA de vue lèverait). Validation de **forme** (rapide), pas de re-simulation.
2. **Copie sur place** dans `this.state` (l'identité de l'objet est conservée : la scène et les vues gardent leurs références) : suppression des clés de premier niveau absentes, puis affectation de chacune.
3. Applique les mêmes normalisations qu'à la construction / `restore` (`normalizeLootState`, `normalizeGearState`, champs d'appel automatique, emplacement cœur).
4. Reconstruit `roomGrid` **seulement si** `roomIndex` a changé (`roomChanged: true`).
5. Ne touche ni `pending`, ni `lastEvents`, ni le PRNG, et ne fait **aucun** pas.

Test (lot B) : une simulation hôte avance de N pas avec des entrées scriptées ; à chaque instantané, `JSON.parse(JSON.stringify(host.state))` appliqué à une simulation miroir donne `JSON.stringify(mirror.state) === JSON.stringify(host.state)` ; passage de salle, mort d'équipe et fin de niveau compris ; états invalides (mauvais niveau, `players` vide, `NaN` injecté à la main, `roomIndex` hors plage, ennemi inconnu) rejetés **sans** modifier l'état.

### 7.4 Interpolation côté invité (réutilise `stepped` / `alpha`)

Les vues (`PlayerView`, `EnemyViews`, `ProjectileViews`) reçoivent déjà `stepped` (un nouvel état est arrivé : `PosInterp.push`) et `alpha` ∈ [0,1] (part de l'intervalle écoulée : `PosInterp.at(alpha)` interpole entre la position précédente et la courante ; un saut > `INTERP_TELEPORT_DISTANCE`, par exemple une nouvelle salle, n'est pas lissé). Côté invité on réutilise le mécanisme **tel quel**, avec l'intervalle d'instantané à la place du pas de 16,7 ms :

- à la réception d'un instantané : `stepped = true`, `sinceSnapMs = 0` ;
- chaque frame : `sinceSnapMs += dt`, `alpha = clamp(sinceSnapMs / intervalMs, 0, 1)` avec `intervalMs` = `NetSnapshot.intervalMs` (moyenne mobile des intervalles d'arrivée bornée à [`INTERP_MIN_MS` 40, `INTERP_MAX_MS` 120], donc ≈ 50 ms) ;
- on **affiche donc toujours un intervalle de retard** (l'état précédent glisse vers le courant) ; si l'instantané suivant tarde, on **tient** la dernière position (`alpha` = 1), sans extrapolation ;
- le temps d'animation transmis aux vues (`timeMs`) est interpolé de la même façon entre `timeMs` du précédent et du courant instantané (animations fluides à 60 Hz alors que l'état change à 20 Hz) ;
- `stepped` ne vaut vrai que la frame de l'arrivée ; sans nouvel instantané, les vues ne re-poussent rien.

Fonction pure recommandée (lot B, testée) `src/entities/netView.ts` : `class MirrorClock { feed(snapshotTimeMs, intervalMs): void; advance(dtMs): { stepped: boolean; alpha: number; timeMs: number } }`. Défaut connu : un instantané qui arrive tôt (alpha < 1) fait « sauter » la position affichée de (1 − alpha) × déplacement d'un intervalle (au plus quelques pixels) ; l'améliorer (repartir de la position affichée) est une optimisation du lot suivant.

Les événements du `snap` sont joués **à l'arrivée** (au plus ~50 ms avant l'affichage interpolé correspondant). `roomEntered` reconstruit la salle (`forceRebuild`) ; `roomEntered` de raison `start` pour la salle déjà construite est ignoré par le code existant. Les effets très brefs portés par l'état (`hitFlashMs`, `attackAnimMs`) peuvent être manqués à 20 Hz : les événements (`playerHit`, `enemyHit`, `playerAttack`…) couvrent le son et les FX ; limite connue (§ 11).

### 7.5 Pause, déconnexion de manette, fin de niveau

- **Pause** : `GameScene` ouvre le menu de pause existant (reprendre / quitter) mais, en réseau, **la simulation continue** (hôte) / **l'affichage continue** (invité) ; l'entrée locale est remplacée par une frame vide tant que le menu est ouvert ; une note (`net.game.pauseNote`) le dit. Quitter : hôte = `host.endGame('hostQuit')` puis salon ; invité = `client.leave()` + `clearNetRuntime()` + menu.
- Pause « manette déconnectée » : désactivée en réseau.
- **Fin de niveau** : `levelCompleted` → célébration (`CELEBRATION_MS`) → pas de `finishLevel()` (ni statistiques, ni dialogue, ni résultat) ; l'hôte appelle `endGame('levelCompleted')` ; l'invité attend le `end` (ou la fermeture du canal) et retourne au salon.
- **Garde** : sans session réseau dans `netRuntime` (`getHostSession()` / `getClientSession()` nul alors que `session.net` est présent), `showFatalError()` puis menu.
- **Invité avant le premier instantané** : écran du niveau construit, texte « En attente de l'hôte… » (`net.game.waiting`) ; sans instantané depuis `NET.STALL_WARN_MS` (1 s) : « Connexion instable » (`net.game.lag`).
- Changements de `pc` (masque des connectés) : toast `net.game.peerLost` `{name}` (côté invité par comparaison de masques, côté hôte par `onPeerEvent`) ; le joueur reste affiché.

## 8. Budget de latence (estimation, sans prédiction)

| Étape | Délai typique |
|---|---|
| Envoi de l'entrée (cadence 30 Hz, appel à chaque frame) | 0–33 ms |
| Réseau invité → hôte (Wi-Fi local) | 3–20 ms |
| Prise en compte au pas suivant de l'hôte | 0–17 ms |
| Attente du prochain instantané (20 Hz) | 0–50 ms |
| Réseau hôte → invité | 3–20 ms |
| Interpolation (un intervalle de retard) | ≈ 50 ms |
| Rendu (frame) | 0–17 ms |
| **Total entrée → écran, invité** | **≈ 100–200 ms** (médiane ≈ 130–150 ms) |

L'hôte joue sans latence supplémentaire. Acceptable pour un jeu coopératif de donjon (le combat se joue à la distance et au rythme) mais perceptible : c'est la motivation de la **prédiction côté invité** (§ 13). Le mesurer sur téléphones fait partie de la recette du prototype.

## 9. Textes (i18n)

Aucune chaîne en dur : tout passe par `t('clé')`. Les nouvelles clés vont dans `src/i18n/parts/net.fr.json` et `net.en.json` (mêmes clés des deux côtés, mêmes `{placeholders}` ; un test de parité existe). **Le lot C écrit tous les fichiers de parts**, y compris les clés `net.game.*` consommées par le lot B ; l'espace de noms ci-dessous est réservé et fait contrat (le lot C peut **ajouter** des clés `net.lobby.*` / `net.rtc.*`, pas renommer celles-ci).

| Clé | Usage | Placeholders |
|---|---|---|
| `menu.net` | ligne « Multijoueur réseau » du menu principal | — |
| `net.notice.levelCompleted` | « Niveau terminé : retour au salon » | — |
| `net.notice.hostQuit` | « L'hôte a mis fin à la partie » | — |
| `net.notice.aborted` | « La partie a été interrompue » | — |
| `net.notice.hostLeft` | « L'hôte a fermé le salon » | — |
| `net.notice.hostLost` | « La connexion avec l'hôte est perdue » | — |
| `net.notice.transportFailed` | « La liaison réseau a échoué » | — |
| `net.notice.protocolError` | « Données invalides reçues de l'hôte » | — |
| `net.notice.reject.protocol` | « Version du protocole réseau différente » | — |
| `net.notice.reject.build` | « Version du jeu différente : l'hôte est en {host}, tu es en {you} » | `host`, `you` (`formatBuildLabel`) |
| `net.notice.reject.levels` | « Nombre de niveaux différent : l'hôte {host}, toi {you} » | `host`, `you` |
| `net.notice.reject.started` | « La partie a déjà commencé » | — |
| `net.notice.reject.full` | « Le salon est complet » | — |
| `net.notice.reject.malformed` | « Message de connexion invalide » | — |
| `net.game.waiting` | « En attente de l'hôte… » | — |
| `net.game.lag` | « Connexion instable… » | — |
| `net.game.peerLost` | « {name} a perdu la connexion » | `name` |
| `net.game.pauseNote` | « La partie continue pendant ce menu » | — |
| `net.rtc.error.unsupported`, `.badCode`, `.wrongVersion`, `.iceTimeout`, `.failed`, `.cancelled` | erreurs de signalisation (une clé par `RtcSignalingErrorCode`) | — |

`noticeKey(code)` (`contracts.ts`) donne la clé `net.notice.<code>` ; `NetNotice.params` porte les valeurs d'interpolation (le salon calcule `host` / `you` avec `formatBuildLabel(info, getLanguage())`).

## 10. Répartition en trois lots disjoints

Règles communes : n'utiliser **jamais** `git worktree` ; **aucun commit ni push** (le chef de projet commit) ; ne toucher qu'aux fichiers du lot ; un besoin hors lot = note « deviations » ; pas de suite complète (≈ 5 min) : `npx vitest run <fichiers>` ciblés et `npx tsc --noEmit` ; les tests tournent sous Node (`environment: 'node'`) : ni `RTCPeerConnection` ni `BroadcastChannel` garantis, donc tester avec des `Transport` factices / Loopback ; serveur de dev : `npx vite --port <p> --strictPort` en arrière-plan ; commentaires et docs en français ; zéro `Date.now` / `Math.random` dans `src/core`.

Fichiers de l'**architecte** (déjà écrits, figés) : `docs/NET.md`, `src/net/contracts.ts`, `src/net/contracts.test.ts`, `src/net/netRuntime.ts`, `src/net/netRuntime.test.ts`, `src/net/README.md`, `src/render/session.ts` (champs `net`, `NetLobby`, `MenuSceneData.notice`, `NetLobbySceneData`). Fichiers existants **réutilisés sans modification** : `src/net/NetAdapter.ts` (type `Unsubscribe`), `src/net/RemoteInputSource.ts` (le lot A l'utilise dans l'hôte : `push`, `setConnected`, `poll`), `src/buildInfo.ts`, `src/input/*`.

### LOT A — protocole, transports, sessions (propriétaire de `src/net/` hors fichiers de l'architecte)

Fichiers : `src/net/protocol.ts`, `src/net/protocol.test.ts` · `src/net/transportLoopback.ts`, `src/net/transportBroadcast.ts`, `src/net/transportRtc.ts` (+ `*.test.ts` de chacun, au minimum Loopback ; le BroadcastChannel testable sous Node 20 via `BroadcastChannel` global si présent, sinon doublure) · `src/net/rtcSignaling.ts`, `src/net/rtcCodec.ts` (code d'invitation : encodage, somme de contrôle, compression ; pur et testable) + `rtcCodec.test.ts` · `src/net/hostSession.ts`, `src/net/hostSession.test.ts` · `src/net/clientSession.ts`, `src/net/clientSession.test.ts` · `src/net/netTestKit.ts` (aides de test : horloge factice, paire hôte + invité sur Loopback ; réservé aux tests).

À livrer (exports **exacts**, typés par les alias de `contracts.ts`) : `createHostSession: CreateHostSession`, `createClientSession: CreateClientSession`, `createLoopbackPair: CreateLoopbackPair`, `createBroadcastHost: CreateBroadcastHost`, `connectBroadcastGuest: ConnectBroadcastGuest`, `createRtcHostSignaling: CreateRtcHostSignaling`, `createRtcGuestSignaling: CreateRtcGuestSignaling`, `RtcSignalingError`, `isRtcSupported()`. En interne : `encodeMessage` / `decodeMessage` (JSON + fragmentation + réassemblage + validation § 5.5), un `RemoteInputSource` par invité (`setConnected(false)` à la perte).

Tests à écrire : fragmentation (aller-retour, ordre, `id`, plafonds, réassemblage expiré, fragment hors séquence, message > `MAX_MESSAGE_CHARS`) ; validation (chaque type, champs hors plage, `__proto__`, types inconnus, mauvaise direction, `MAX_MALFORMED`) ; vérification de version (les 3 refus dans l'ordre, `started`, `full`) ; salon complet (arrivée de 3 invités, ids, unicité des personnages, `setLevel`, `checkStart`, départ / perte avant le début, renumérotation contiguë au `start`) ; partie (`pollRemoteInputs` : dernière frame, péremption à 250 ms, invité perdu, `seq` rétrograde ignoré, cadence plafonnée ; `afterStep` : 1 instantané tous les 3 pas, `n` croissant, événements accumulés par invité, saturation `bufferedAmount` saute l'envoi et conserve les événements, débordement `MAX_PENDING_EVENTS` en gardant `SIM_EVENTS_NEVER_DROPPED`) ; invité (`takeSnapshot` : le plus récent + tous les événements, `intervalMs` borné, `rttMs`, silence → `hostLost`, `leave`, `reject` avec données de l'hôte) ; **bout en bout sur Loopback** : une vraie `GameSimulation` côté hôte avancée avec des entrées scriptées, l'invité reçoit les instantanés (état fragmenté 3 morceaux au besoin) et `JSON.stringify(received) === JSON.stringify(host.state)` ; code d'invitation : aller-retour, somme de contrôle, mauvaise version, genre inversé, blancs et sauts de ligne ignorés, longueur ≤ 4096 ; fumée WebRTC **uniquement si** `RTCPeerConnection` existe (sinon `skip`).

### LOT B — cœur et scène de jeu

Fichiers : `src/core/simulation.ts` (méthode `applyMirrorState` seule, additive) · `src/core/mirror.test.ts` · `src/scenes/GameScene.ts` (modes hôte et invité, gardés par `session.net`) · `src/entities/netView.ts` + `src/entities/netView.test.ts` (horloge d'interpolation `MirrorClock`, helpers purs de correspondance joueur / vue) · `src/render/hud.ts` (paramètre optionnel `viewIndex` de `PlayerHud`, **rien d'autre**) · `src/render/hud.test.ts` seulement si un test est ajouté pour ce paramètre.

Dépend du lot A à l'exécution (`getHostSession()` / `getClientSession()`), mais **pas à la compilation** : il code contre `HostSessionApi` / `ClientSessionApi` de `contracts.ts` et teste avec des doublures. Ne crée aucune clé i18n (liste du § 9, écrites par le lot C) : il peut utiliser `t('net.game.waiting')` etc. dès que le lot C les fournit ; avant, `t` renvoie la clé et émet un avertissement (sans casser).

Tests : voir § 7.3 (miroir exact) ; `MirrorClock` (alpha, retard d'un intervalle, instantané tardif tenu, instantané précoce, `timeMs` interpolé) ; **non-régression locale** : les tests existants du cœur, des bots et de `loopLogic` sont relancés sans modification ; un test vérifie que `createSimulation` + `step` n'est pas affecté (la méthode ajoutée n'est jamais appelée hors réseau).

### LOT C — salon et menu

Fichiers : `src/scenes/NetLobbyScene.ts` · `src/scenes/netLobbyDom.ts` (éléments DOM superposés au canvas : zones de texte pour copier / coller les codes, boutons « Copier » / « Coller » ; styles en ligne, positionnement sur le rectangle du canvas, retrait au `shutdown`) · `src/render/netLobbyLogic.ts` + `src/render/netLobbyLogic.test.ts` (logique pure : étapes de l'écran, formatage de l'état du salon, choix du premier personnage libre côté interface, messages d'erreur, valeurs `host` / `you` des refus) · `src/scenes/MenuScene.ts` (ligne « Multijoueur réseau », affichage de `MenuSceneData.notice` avec le mécanisme de message existant, adaptation de la densité des lignes : le menu compte déjà jusqu'à 15 lignes sélectionnables) · `src/render/menuLogic.ts` (seulement une fonction pure si utile) · `src/main.ts` (enregistrement de `NetLobbyScene`) · `src/i18n/parts/net.fr.json`, `src/i18n/parts/net.en.json` + `src/i18n/net.test.ts` (parité, couverture des 13 codes de `NetNoticeCode`, des clés `net.game.*` du § 9).

Comportement : § 6 et § 9. `NetLobbyScene` : écran de choix hôte / invité ; **hôte** : nom, personnage, difficulté, niveau, liste des participants ; WebRTC : bouton « Inviter » (un code par invité, une invitation à la fois jusqu'à 3 invités, copie, zone de collage de la réponse, état de chaque invitation) ; `?net=bc` : les invités apparaissent seuls ; « Lancer » (`checkStart`, graine tirée **ici** : `Date.now` autorisé dans une scène) → `sessionFromNetStart(info, 'host', transport)` → `scene.start(Game, { session })`. **Invité** : nom, collage du code d'invitation, affichage du code de réponse à copier, attente, puis salon (personnage, prêt) ; `onStart` → `sessionFromNetStart(info, 'client', transport)` → `Game`. **Retour** (`entry: 'return'`) : la session existe déjà dans `netRuntime`, la scène affiche le salon et le `notice`. Menu : `MenuSceneData.notice` traduit par `noticeKey` / `params`. Appels `host.update(now)` / `client.update(now)` à chaque frame du salon. Nom par défaut : un nom neutre traduit (`net.lobby.defaultName`, à ajouter), mémorisé en `localStorage` (`vaelorn.net.name`, dans un `try/catch`). Aperçu mobile : vérifier le salon en paysage téléphone (≈ 812 × 375) avec `resize_window` (préréglage mobile, puis inversé) ; clavier virtuel et zones de texte accessibles ; boutons ≥ 44 px.

Tests : logique pure uniquement (étapes, validations de collage — vide, trop long, caractères hors alphabet —, formatage des différences de build, liste des clés i18n utilisées par la scène présentes dans les deux dictionnaires).

### Disjonction

Aucun fichier n'est dans deux lots : A = `src/net/{protocol*,transport*,rtc*,hostSession*,clientSession*,netTestKit*}` ; B = `src/core/{simulation.ts,mirror.test.ts}`, `src/scenes/GameScene.ts`, `src/entities/netView*`, `src/render/hud.ts` ; C = `src/scenes/{NetLobbyScene,netLobbyDom,MenuScene}.ts`, `src/render/{netLobbyLogic*,menuLogic.ts}`, `src/main.ts`, `src/i18n/{parts/net.*.json,net.test.ts}`. L'architecte garde `contracts*`, `netRuntime*`, `README.md`, `session.ts`, `docs/NET.md`.

### Recette d'intégration (chef de projet, après les trois lots)

1. `npx tsc --noEmit` et la suite complète : **aucun test existant ne change de résultat**.
2. Deux fenêtres de navigateur côte à côte, `?net=bc` : hôte + invité arrivent au salon, choisissent deux personnages différents, l'hôte lance ; les deux se déplacent et attaquent ; un ennemi tué est vu des deux ; passage de salle ; fin de niveau → retour au salon avec message ; l'invité ferme sa fenêtre → l'hôte continue ; l'hôte ferme → l'invité revient au menu avec message.
3. Deux onglets WebRTC manuel sur la même machine : codes copiés / collés, connexion, une salle jouée.
4. Deux téléphones sur un point d'accès (recette réelle, § 11) : latence ressentie, débit, durée de tenue.
5. Local : un niveau en solo, à 2 joueurs sur le même écran, le tutoriel et la démo se lancent comme avant ; aucune sauvegarde n'est écrite pendant une partie réseau (vérifier le stockage local avant / après).

## 11. Limites connues et risques

1. **Topologie du point d'accès (risque majeur, à tester tôt).** Les navigateurs masquent par défaut les adresses locales derrière des noms mDNS `xxxx.local` ; le pair doit les résoudre en mDNS multicast, que certains points d'accès téléphone filtrent (isolation des clients, multicast bloqué). Sur iOS, l'interface « Partage de connexion » n'est pas toujours utilisée pour la collecte ICE du téléphone qui partage. Mitigation prototype : message d'erreur explicite (`iceTimeout` / `failed`) et recette sur appareils dès que possible ; repli prévu au plan (§ 13) : hôte natif / relais WebSocket local.
2. **Débit au pire cas** : ≈ 19 Mbit/s en émission pour l'hôte avec 3 invités et 40 ennemis (§ 2). Mitigations déjà dans le lot 1 : saut d'instantané sur canal saturé (dégradation en douceur) ; compaction ensuite (−46 %, protocole v2).
3. **Latence invité** ≈ 100–200 ms d'entrée à l'écran (§ 8), sans prédiction.
4. **Canal fiable et ordonné** : une perte de paquet bloque la file derrière elle (blocage en tête) ; les instantanés s'accumulent puis arrivent en rafale, l'invité n'applique que le dernier (les événements, eux, sont tous gardés).
5. **Veille / arrière-plan** : un téléphone dont l'écran s'éteint ou dont l'application passe en arrière-plan suspend la boucle de jeu ; l'hôte déclare perdu un invité réellement silencieux pendant 6 s (un appareil gelé n'envoie plus ses `pong`) ; la fausse détection côté appareil suspendu est corrigée : le silence se mesure à la granularité des `update`, et un message reçu pendant la suspension compte comme reçu au réveil. Mitigation recommandée plus tard : verrou d'écran (`navigator.wakeLock`). En développement, utiliser deux **fenêtres**, pas deux onglets.
6. **Effets très brefs** (`hitFlashMs`, `attackAnimMs` de quelques dizaines de ms) possiblement manqués à 20 Hz ; sons et FX sont portés par les événements.
7. **Pause qui ne fige pas** en réseau (menu de pause = sortie seulement).
8. **Pas de panneau d'équipe** garanti en réseau (§ 7.2) : on ne voit les PV des autres que dans le monde si le lot B ne l'ajoute pas.
9. **Pas de reconnexion** : un invité perdu en cours de partie reste immobile jusqu'à la fin du niveau ; sa nouvelle liaison est refusée (`started`).
10. **Menu** : une ligne de plus pour des menus déjà denses (16 lignes sélectionnables avec la ligne réseau) ; la densité est ajustée par le lot C.
11. **Copier / coller sur mobile** : l'API presse-papiers exige un contexte sécurisé ou une autorisation ; prévoir le repli « sélectionner le texte d'une zone de saisie » (`select()` + `execCommand('copy')`) et le collage manuel dans la zone de saisie (appui long).
12. **Version** : deux builds doivent être **identiques** (version + hash + date) ; une PWA mise en cache sur un téléphone après un déploiement provoque `reject.build` (message qui indique les deux versions).
13. **Complexité de `GameScene`** (1 300 lignes déjà chargées de gardes tutoriel / démo) : tout ajout reste gardé par `this.net` pour ne pas toucher au chemin local.
14. **Sécurité** : prototype entre amis ; validation de forme seulement (§ 5.5).

## 12. Dépannage et développement

- Deux fenêtres d'un même navigateur, même origine : `http://localhost:<port>/?net=bc` dans les deux ; hôte dans l'une, invité dans l'autre, pas de code à copier. Serveur : `npx vite --port <p> --strictPort`.
- Essai sur téléphone en développement : `npx vite --host --port <p> --strictPort`, ouvrir `http://<ip-du-pc>:<p>` (WebRTC n'exige pas de contexte sécurisé ; l'installation PWA, si).
- Journaliser, côté hôte, `pingMs` de chaque participant et `bufferedAmount` ; côté invité `rttMs()` et l'intervalle d'instantané estimé : ce sont les trois chiffres à relever pendant la recette.

## 13. Plan des lots suivants

1. **Lot 2 — fiabilité d'usage** : compaction de l'instantané (protocole v2 : champs `data` d'ennemi à 0 omis, flottants à 2 décimales, fragments sans échappement JSON), verrou d'écran, repli de l'interface de collage, meilleure position de départ de l'interpolation après un instantané précoce, panneau d'équipe réseau définitif, pause réseau (avec accord des joueurs).
2. **Lot 3 — QR codes** : le code d'invitation / de réponse (≤ 600 caractères typiques) tient dans un QR ; génération locale (bibliothèque embarquée) et lecture caméra (`getUserMedia`, contexte sécurisé) ; collage manuel conservé.
3. **Lot 4 — prédiction côté invité** : le joueur local est simulé localement avec ses propres entrées (même `GameSimulation` restreinte au déplacement) et **réconcilié** à chaque instantané (rejeu des entrées non acquittées) ; les autres entités restent interpolées. Exige un `ack` d'entrée (`seq` rendu dans `snap`) : **changement de protocole** (v2 ou v3).
4. **Lot 5 — reconnexion en cours de partie** : réattribution du joueur « immobile » à un invité qui revient (jeton de reprise émis au `start`, `rejoin` accepté pendant `playing`), instantané complet immédiat.
5. **Lot 6 — hôte natif Capacitor** : l'application Android / iOS écoute sur un vrai port (WebSocket local) et joue le rôle d'hôte pour des invités PWA ; nouvelle implémentation de `Transport` (`transportWs.ts`), plus de signalisation manuelle ni de problème mDNS ; mêmes messages et mêmes sessions.
6. **Plus tard** : parties au-delà du réseau local (serveur de signalisation + STUN/TURN), sauvegarde d'une partie réseau (côté hôte seulement), tutoriel à plusieurs, campagne enchaînée en réseau.
