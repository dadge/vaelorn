/* eslint-disable */
/*
 * Service worker de « Les Fragments de l'Aube » — GÉNÉRÉ au build par scripts/pwa-build.mjs
 * (la version et la liste de pré-cache sont injectées ; ne pas éditer dist/sw.js à la main).
 *
 * Stratégie :
 *  - installation : pré-cache de TOUS les fichiers du build (le jeu fonctionne ensuite hors ligne) ;
 *  - navigation (la page) : réseau d'abord, avec repli sur le cache après 4 s ou hors ligne ; les paramètres d'URL
 *    (?quick=1…) sont ignorés pour retrouver la page en cache ;
 *  - autres fichiers (JS/CSS/images au nom haché…) : cache d'abord, puis réseau ;
 *  - une nouvelle version s'active tout de suite (skipWaiting + claim) et supprime les anciens caches ;
 *  - requêtes d'autres origines et requêtes non GET : jamais interceptées.
 * Le cache est propre à la version (hash du contenu du build) : un nouveau déploiement = un nouveau cache.
 */
const VERSION = '__VERSION__';
const CACHE_PREFIX = 'vaelorn-';
const CACHE = CACHE_PREFIX + VERSION;
const PRECACHE = __PRECACHE__;
const NAVIGATION_TIMEOUT_MS = 4000;

/** URL absolue d'un chemin relatif à la portée du service worker (indépendant du sous-dossier GitHub Pages). */
function scopeUrl(path) {
  return new URL(path, self.registration.scope).href;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE.map((p) => new Request(scopeUrl(p), { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function cachedPage(request) {
  const exact = await caches.match(request, { ignoreSearch: true, ignoreVary: true });
  return exact || caches.match(scopeUrl('./index.html'), { ignoreSearch: true, ignoreVary: true });
}

async function handleNavigation(request) {
  const cached = await cachedPage(request);
  const network = fetch(request);
  if (!cached) return network;
  network.catch(() => {});
  try {
    const response = await Promise.race([
      network,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), NAVIGATION_TIMEOUT_MS)),
    ]);
    return response.ok ? response : cached;
  } catch (e) {
    return cached;
  }
}

async function handleAsset(request) {
  // ignoreVary : le serveur répond « Vary: Origin » et une requête de module (crossorigin) n'envoie pas le même Origin que le pré-cache
  const hit = await caches.match(request, { ignoreVary: true });
  if (hit) return hit;
  const response = await fetch(request);
  if (response && response.ok && response.type === 'basic') {
    const cache = await caches.open(CACHE);
    cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(request.mode === 'navigate' ? handleNavigation(request) : handleAsset(request));
});
