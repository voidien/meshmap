/* meshmap service worker: lets the app, the project you opened, and the map/terrain tiles you saved work without a connection.
   Only GET requests are kept; nothing is ever written offline except field readings, which the page queues itself. */
const SHELL = "meshmap-shell-v1";
const API = "meshmap-api-v1";
const TILES = "meshmap-tiles-v1";
const KEEP = [SHELL, API, TILES];
const INDEX = new URL("./", self.registration.scope).href;
const TILE_HOSTS = ["tile.openstreetmap.org", "s3.amazonaws.com", "demotiles.maplibre.org"];
const MAX_TILES = 14000;
// what may be kept from the API: the data Field mode needs, never jobs, admin, sign-in or passkey calls
const API_KEEP = /\/api\/(session|projects|packs|docs|published|artifacts)(\/|$)/;

self.addEventListener("install", (e) => {
  e.waitUntil(
    (async () => {
      try {
        await (await caches.open(SHELL)).add(new Request(INDEX, { cache: "reload" }));
      } catch {
        /* offline install: the page will be cached on its next visit */
      }
      // a new version waits until the page says so (an "update available" message), so nobody is switched mid-edit
    })(),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (!KEEP.includes(k)) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

const ok = (r) => r.ok && r.status < 500;

async function networkFirst(req, name, key, ms) {
  const cache = await caches.open(name);
  const net = fetch(req).then((r) => {
    if (!ok(r)) throw r;
    cache.put(key || req, r.clone());
    return r;
  });
  net.catch(() => undefined);
  try {
    return await Promise.race([net, new Promise((_, rej) => setTimeout(() => rej(new Error("slow")), ms))]);
  } catch (err) {
    const hit = await cache.match(key || req);
    if (hit) return hit;
    if (err instanceof Response) return err;
    return net.catch((x) => (x instanceof Response ? x : Response.error()));
  }
}

async function cacheFirst(req, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const r = await fetch(req);
  if (r.ok) {
    cache.put(req, r.clone());
    if (name === TILES && Math.random() < 0.005) trimTiles();
  }
  return r;
}

async function trimTiles() {
  const cache = await caches.open(TILES);
  const keys = await cache.keys();
  if (keys.length > MAX_TILES) for (const k of keys.slice(0, keys.length - MAX_TILES + 1000)) await cache.delete(k);
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  const same = url.origin === self.location.origin;
  if (req.method === "POST" && same && url.pathname.endsWith("/api/logout")) {
    // signing out must not leave the account's data on the device
    e.respondWith(fetch(req).then(async (r) => (await Promise.all([caches.delete(API)]), r)));
    return;
  }
  if (req.method !== "GET") return;
  if (same) {
    if (req.mode === "navigate") return void e.respondWith(networkFirst(req, SHELL, INDEX, 4000));
    if (url.pathname.includes("/api/")) {
      if (!API_KEEP.test(url.pathname)) return;
      if (url.pathname.includes("/api/artifacts/")) return void e.respondWith(cacheFirst(req, API));
      return void e.respondWith(networkFirst(req, API, undefined, 6000));
    }
    if (/\/assets\/|\.(wasm|png|svg|webmanifest|js)$/.test(url.pathname) && !url.pathname.endsWith("/sw.js")) return void e.respondWith(cacheFirst(req, SHELL));
    return;
  }
  if (TILE_HOSTS.includes(url.hostname)) e.respondWith(cacheFirst(req, TILES));
});

self.addEventListener("message", (e) => {
  const d = e.data || {};
  if (d.type === "skip-waiting") return void self.skipWaiting();
  if (d.type === "cache-urls" && Array.isArray(d.urls)) {
    e.waitUntil(
      (async () => {
        const cache = await caches.open(SHELL);
        for (const u of d.urls) {
          try {
            if (new URL(u).origin === self.location.origin && !(await cache.match(u))) await cache.add(u);
          } catch {
            /* skip what cannot be fetched */
          }
        }
      })(),
    );
  }
});
