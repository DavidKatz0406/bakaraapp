/* Service worker — בקרה / ט.ש. מי-רון
   Bump CACHE whenever a shell file changes. */
const CACHE = "bakara-v21";

const SHELL = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "vendor/react.production.min.js",
  "vendor/react-dom.production.min.js",
  "vendor/htm.umd.js",
  "vendor/firebase-app-compat.js",
  "vendor/firebase-auth-compat.js",
  "vendor/firebase-firestore-compat.js",
  "favicon.ico",
  "favicon-32.png",
  "favicon-16.png",
  "apple-touch-icon.png",
  "apple-touch-icon-precomposed.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-192-maskable.png",
  "icons/icon-512-maskable.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // Cache each item independently: one 404 must not abort the whole install.
    await Promise.allSettled(SHELL.map((u) => c.add(u)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Page navigations: network first, fall back to cached shell when offline.
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req).catch(() => caches.match("index.html").then((r) => r || caches.match("./")))
    );
    return;
  }

  // Same-origin assets: cache first, then network. NEVER substitute HTML for an asset.
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(req).then((hit) => {
        if (hit) return hit;
        return fetch(req).then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        });
      })
    );
    return;
  }

  // Google Fonts: stale-while-revalidate.
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    e.respondWith(
      caches.open(CACHE).then((c) =>
        c.match(req).then((hit) => {
          const net = fetch(req).then((res) => { c.put(req, res.clone()); return res; }).catch(() => hit);
          return hit || net;
        })
      )
    );
  }
});
