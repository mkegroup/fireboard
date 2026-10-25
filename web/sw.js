// Caches the app shell so the board opens even with weak signal.
// Data always comes from the network. Bump VERSION on every release.
const VERSION = "fgb-2.3.0";
const SHELL = [
  "./", "index.html", "css/app.css", "manifest.json",
  "js/app.js", "js/api.js", "js/native.js", "js/demo.js", "js/board.js", "js/records.js", "js/state.js", "js/ui.js", "js/util.js", "js/config.js",
  "vendor/supabase.js", "vendor/leaflet.js", "vendor/leaflet.css", "vendor/qrcode.js",
  "vendor/fonts/barlow-condensed-latin-600-normal.woff2", "vendor/fonts/barlow-condensed-latin-700-normal.woff2",
  "vendor/fonts/barlow-condensed-latin-800-normal.woff2", "vendor/fonts/barlow-latin-400-normal.woff2",
  "vendor/fonts/barlow-latin-500-normal.woff2", "vendor/fonts/barlow-latin-600-normal.woff2",
  "img/icon-192.png", "img/icon-512.png", "img/favicon-64.png", "img/logo.png", "img/logo-dark.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // API, tiles, Stripe: straight to network
  // Network first so updates land right away, cache as the fallback for bad signal.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("index.html"))),
  );
});
