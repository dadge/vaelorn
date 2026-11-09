import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildServiceWorker, computeVersion, listBuildFiles } from '../../scripts/pwa-build.mjs';
import { shouldRegisterServiceWorker } from './register';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = join(ROOT, 'public');

interface Manifest {
  id: string;
  name: string;
  short_name: string;
  lang: string;
  start_url: string;
  scope: string;
  display: string;
  orientation: string;
  background_color: string;
  theme_color: string;
  icons: { src: string; sizes: string; type: string; purpose: string }[];
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(join(PUBLIC, 'manifest.webmanifest'), 'utf8')) as Manifest;
}

/** Dimensions lues dans l'en-tête IHDR d'un PNG (octets 16..23). */
function pngSize(file: string): { w: number; h: number; ok: boolean } {
  const bytes = readFileSync(file, 'latin1');
  const ok = bytes.startsWith('\x89PNG\r\n\x1a\n') && bytes.slice(12, 16) === 'IHDR';
  const u32 = (o: number): number => (bytes.charCodeAt(o) << 24) | (bytes.charCodeAt(o + 1) << 16) | (bytes.charCodeAt(o + 2) << 8) | bytes.charCodeAt(o + 3);
  return { w: u32(16), h: u32(20), ok };
}

describe('manifeste PWA', () => {
  const m = readManifest();

  it('est installable : nom, démarrage relatif, portée, affichage, couleurs', () => {
    expect(m.name.length).toBeGreaterThan(3);
    expect(m.short_name.length).toBeGreaterThan(0);
    expect(m.short_name.length).toBeLessThanOrEqual(12);
    // relatif : le jeu est servi dans un sous-dossier (GitHub Pages) et le build utilise base './'
    expect(m.start_url).toBe('./');
    expect(m.scope).toBe('./');
    expect(['fullscreen', 'standalone', 'minimal-ui']).toContain(m.display);
    expect(m.orientation).toBe('landscape');
    expect(m.background_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(m.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('déclare une icône 192, une icône 512 et une icône masquable, toutes présentes avec la bonne taille', () => {
    const sizes = m.icons.map((i) => i.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
    expect(m.icons.some((i) => i.purpose === 'maskable')).toBe(true);
    for (const icon of m.icons) {
      const file = join(PUBLIC, icon.src);
      expect(existsSync(file), icon.src).toBe(true);
      const png = pngSize(file);
      expect(png.ok, `${icon.src} est un PNG`).toBe(true);
      expect(`${png.w}x${png.h}`, icon.src).toBe(icon.sizes);
      expect(icon.type).toBe('image/png');
    }
  });

  it('index.html référence le manifeste et des icônes qui existent', () => {
    const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
    expect(html).toContain('rel="manifest"');
    expect(html).toContain('name="theme-color"');
    const hrefs = [...html.matchAll(/href="\/([^"]+)"/g)].map((x) => x[1]);
    expect(hrefs).toContain('manifest.webmanifest');
    for (const h of hrefs) expect(existsSync(join(PUBLIC, h)), h).toBe(true);
  });
});

describe('enregistrement du service worker', () => {
  it("n'enregistre qu'en production, sur un navigateur compatible, en contexte sécurisé", () => {
    expect(shouldRegisterServiceWorker({ production: true, supported: true, secure: true })).toBe(true);
    expect(shouldRegisterServiceWorker({ production: false, supported: true, secure: true })).toBe(false);
    expect(shouldRegisterServiceWorker({ production: true, supported: false, secure: true })).toBe(false);
    expect(shouldRegisterServiceWorker({ production: true, supported: true, secure: false })).toBe(false);
  });
});

describe('outillage de build PWA', () => {
  function tempBuild(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'vaelorn-pwa-'));
    for (const [rel, content] of Object.entries(files)) {
      const full = join(dir, rel);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, content, 'utf8');
    }
    return dir;
  }

  it('liste récursivement les fichiers (triés, sans sw.js ni cartes de sources)', () => {
    const dir = tempBuild({ 'index.html': '<html>', 'assets/a-1.js': 'a', 'assets/a-1.js.map': '{}', 'icons/i.png': 'x', 'sw.js': 'old' });
    try {
      expect(listBuildFiles(dir)).toEqual(['assets/a-1.js', 'icons/i.png', 'index.html']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('la version change quand le contenu change et reste stable sinon', () => {
    const a = tempBuild({ 'index.html': 'v1', 'assets/x.js': 'x' });
    const b = tempBuild({ 'index.html': 'v1', 'assets/x.js': 'x' });
    const c = tempBuild({ 'index.html': 'v2', 'assets/x.js': 'x' });
    try {
      const va = computeVersion(a, listBuildFiles(a));
      expect(va).toMatch(/^[0-9a-f]{12}$/);
      expect(computeVersion(b, listBuildFiles(b))).toBe(va);
      expect(computeVersion(c, listBuildFiles(c))).not.toBe(va);
      // le modèle du service worker compte aussi dans la version
      expect(computeVersion(a, listBuildFiles(a), 'modèle A')).not.toBe(computeVersion(a, listBuildFiles(a), 'modèle B'));
    } finally {
      for (const d of [a, b, c]) rmSync(d, { recursive: true, force: true });
    }
  });

  it('refuse une version invalide ou un modèle sans marqueurs', () => {
    expect(() => buildServiceWorker({ files: ['index.html'], version: 'x y' })).toThrow();
    expect(() => buildServiceWorker({ files: ['index.html'], version: 'abcdef123456', template: 'rien' })).toThrow();
  });

  it('le service worker généré est du JavaScript valide, versionné, avec une liste de pré-cache relative', () => {
    const files = ['index.html', 'assets/index-abc.js', 'icons/icon-192.png', 'manifest.webmanifest'];
    const src = buildServiceWorker({ files, version: 'abcdef123456' });
    expect(src).not.toContain('__VERSION__');
    expect(src).not.toContain('__PRECACHE__');
    expect(src).toContain("'abcdef123456'");
    expect(() => new Function('self', 'caches', 'fetch', src)).not.toThrow();
    for (const f of files) expect(src).toContain(`"./${f}"`);
  });
});

// ───────────── Exécution du service worker généré dans un faux environnement ─────────────

type Listener = (event: Record<string, unknown>) => void;

class FakeResponse {
  type = 'basic';
  /** En-tête Vary : un serveur comme Vite répond « Origin ». */
  vary = 'Origin';
  constructor(
    public body: string,
    public ok = true,
  ) {}
  clone(): FakeResponse {
    const c = new FakeResponse(this.body, this.ok);
    c.vary = this.vary;
    return c;
  }
}

class FakeRequest {
  url: string;
  method: string;
  mode: string;
  /** Vrai pour une requête qui envoie un en-tête Origin (ex. <script type=module crossorigin>). */
  sendsOrigin: boolean;
  constructor(url: string, init: { method?: string; mode?: string; sendsOrigin?: boolean } = {}) {
    this.sendsOrigin = init.sendsOrigin ?? false;
    this.url = url;
    this.method = init.method ?? 'GET';
    this.mode = init.mode ?? 'no-cors';
  }
}

interface Harness {
  listeners: Record<string, Listener>;
  stores: Map<string, Map<string, FakeResponse>>;
  network: Map<string, FakeResponse>;
  networkDown: { value: boolean };
  fetched: string[];
  claimed: { value: boolean };
  skipped: { value: boolean };
}

const SCOPE = 'https://example.test/vaelorn/';
const FILES = ['index.html', 'assets/app-1.js', 'manifest.webmanifest', 'gamepad-test.html'];

function loadServiceWorker(version = 'a1a1a1a1a1a1', existing: Record<string, Record<string, string>> = {}): Harness {
  const stripSearch = (u: string): string => u.split('?')[0];
  const stores = new Map<string, Map<string, FakeResponse>>();
  for (const [name, entries] of Object.entries(existing)) {
    stores.set(name, new Map(Object.entries(entries).map(([k, v]) => [k, new FakeResponse(v)])));
  }
  const network = new Map<string, FakeResponse>();
  for (const f of FILES) network.set(SCOPE + f, new FakeResponse(`net:${f}`));
  const h: Harness = { listeners: {}, stores, network, networkDown: { value: false }, fetched: [], claimed: { value: false }, skipped: { value: false } };

  const caches = {
    async open(name: string) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name)!;
      return {
        async addAll(reqs: FakeRequest[]) {
          for (const r of reqs) {
            const res = network.get(r.url);
            if (!res || h.networkDown.value) throw new Error(`addAll: ${r.url}`);
            store.set(r.url, res.clone());
          }
        },
        async put(req: FakeRequest, res: FakeResponse) {
          store.set(req.url, res);
        },
      };
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name: string) {
      return stores.delete(name);
    },
    async match(req: FakeRequest | string, opts: { ignoreSearch?: boolean; ignoreVary?: boolean } = {}) {
      const url = typeof req === 'string' ? req : req.url;
      const sendsOrigin = typeof req === 'string' ? false : req.sendsOrigin;
      const key = opts.ignoreSearch ? stripSearch(url) : url;
      for (const store of stores.values()) {
        for (const [k, v] of store) {
          if ((opts.ignoreSearch ? stripSearch(k) : k) !== key) continue;
          // comme un vrai navigateur : « Vary: Origin » rend la réponse inutilisable pour une requête qui envoie un Origin
          if (!opts.ignoreVary && v.vary === 'Origin' && sendsOrigin) continue;
          return v;
        }
      }
      return undefined;
    },
  };
  const fakeFetch = async (req: FakeRequest): Promise<FakeResponse> => {
    h.fetched.push(req.url);
    if (h.networkDown.value) throw new TypeError('offline');
    const path = stripSearch(req.url);
    // comme un vrai serveur statique : la racine du dossier sert index.html
    const res = network.get(path === SCOPE ? SCOPE + 'index.html' : path);
    return res ? res.clone() : new FakeResponse('404', false);
  };
  const self = {
    registration: { scope: SCOPE },
    location: { origin: 'https://example.test' },
    clients: { claim: async () => void (h.claimed.value = true) },
    skipWaiting: async () => void (h.skipped.value = true),
    addEventListener: (type: string, fn: Listener) => void (h.listeners[type] = fn),
  };
  const src = buildServiceWorker({ files: FILES, version });
  new Function('self', 'caches', 'fetch', 'Request', 'URL', 'setTimeout', src)(self, caches, fakeFetch, FakeRequest, URL, setTimeout);
  return h;
}

async function dispatchLifecycle(h: Harness, type: 'install' | 'activate'): Promise<void> {
  let pending: Promise<unknown> = Promise.resolve();
  h.listeners[type]({ waitUntil: (p: Promise<unknown>) => void (pending = p) });
  await pending;
}

async function dispatchFetch(h: Harness, req: FakeRequest): Promise<FakeResponse | null> {
  let answer: Promise<FakeResponse> | null = null;
  h.listeners.fetch({ request: req, respondWith: (p: Promise<FakeResponse>) => void (answer = p) });
  return answer ? await answer : null;
}

describe('service worker généré (exécuté dans un environnement simulé)', () => {
  it("à l'installation, pré-cache tous les fichiers dans un cache versionné puis s'active aussitôt", async () => {
    const h = loadServiceWorker('a1a1a1a1a1a1');
    await dispatchLifecycle(h, 'install');
    const cache = h.stores.get('vaelorn-a1a1a1a1a1a1')!;
    expect([...cache.keys()].sort()).toEqual(FILES.map((f) => SCOPE + f).sort());
    expect(h.skipped.value).toBe(true);
  });

  it("une installation incomplète (réseau coupé) échoue au lieu de laisser un cache à moitié rempli actif", async () => {
    const h = loadServiceWorker();
    h.networkDown.value = true;
    await expect(dispatchLifecycle(h, 'install')).rejects.toThrow();
    expect(h.skipped.value).toBe(false);
  });

  it("à l'activation, supprime les anciens caches du jeu (et seulement eux) puis prend le contrôle", async () => {
    const h = loadServiceWorker('b2b2b2b2b2b2', { 'vaelorn-c0c0c0c0c0c0': { a: '1' }, 'autre-site': { b: '2' } });
    await dispatchLifecycle(h, 'install');
    await dispatchLifecycle(h, 'activate');
    expect([...h.stores.keys()].sort()).toEqual(['autre-site', 'vaelorn-b2b2b2b2b2b2']);
    expect(h.claimed.value).toBe(true);
  });

  it("ne touche ni aux requêtes non GET ni à celles d'une autre origine", async () => {
    const h = loadServiceWorker();
    await dispatchLifecycle(h, 'install');
    expect(await dispatchFetch(h, new FakeRequest(SCOPE + 'index.html', { method: 'POST' }))).toBeNull();
    expect(await dispatchFetch(h, new FakeRequest('https://cdn.autre.test/x.js'))).toBeNull();
  });

  it('sert les fichiers depuis le cache sans toucher au réseau', async () => {
    const h = loadServiceWorker();
    await dispatchLifecycle(h, 'install');
    h.fetched.length = 0;
    const res = await dispatchFetch(h, new FakeRequest(SCOPE + 'assets/app-1.js'));
    expect(res?.body).toBe('net:assets/app-1.js');
    expect(h.fetched).toEqual([]);
  });

  it('un module <script crossorigin> (en-tête Origin, réponse « Vary: Origin ») est quand même servi depuis le cache hors ligne', async () => {
    const h = loadServiceWorker();
    await dispatchLifecycle(h, 'install');
    h.networkDown.value = true;
    const res = await dispatchFetch(h, new FakeRequest(SCOPE + 'assets/app-1.js', { mode: 'cors', sendsOrigin: true }));
    expect(res?.body).toBe('net:assets/app-1.js');
  });

  it('hors ligne, la page (avec ses paramètres ?quick=1…) est servie depuis le cache', async () => {
    const h = loadServiceWorker();
    await dispatchLifecycle(h, 'install');
    h.networkDown.value = true;
    const root = await dispatchFetch(h, new FakeRequest(SCOPE + '?quick=1&players=2', { mode: 'navigate' }));
    expect(root?.body).toBe('net:index.html');
    const page = await dispatchFetch(h, new FakeRequest(SCOPE + 'gamepad-test.html', { mode: 'navigate' }));
    expect(page?.body).toBe('net:gamepad-test.html');
  });

  it('en ligne, la page vient du réseau (mise à jour immédiate) ; une erreur serveur retombe sur le cache', async () => {
    const h = loadServiceWorker();
    await dispatchLifecycle(h, 'install');
    h.network.set(SCOPE + 'index.html', new FakeResponse('net:index.html:nouveau'));
    expect((await dispatchFetch(h, new FakeRequest(SCOPE, { mode: 'navigate' })))?.body).toBe('net:index.html:nouveau');
    h.network.set(SCOPE + 'index.html', new FakeResponse('erreur', false));
    expect((await dispatchFetch(h, new FakeRequest(SCOPE, { mode: 'navigate' })))?.body).toBe('net:index.html');
  });

  it('met en cache un fichier hors liste récupéré avec succès, mais pas une erreur', async () => {
    const h = loadServiceWorker();
    await dispatchLifecycle(h, 'install');
    h.network.set(SCOPE + 'extra.json', new FakeResponse('extra'));
    await dispatchFetch(h, new FakeRequest(SCOPE + 'extra.json'));
    await dispatchFetch(h, new FakeRequest(SCOPE + 'absent.json'));
    const cache = h.stores.get('vaelorn-a1a1a1a1a1a1')!;
    expect(cache.has(SCOPE + 'extra.json')).toBe(true);
    expect(cache.has(SCOPE + 'absent.json')).toBe(false);
  });
});
