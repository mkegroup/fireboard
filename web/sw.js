// Caches the app shell so the board opens even with weak signal.
// Data always comes from the network. Bump VERSION on every release.
const VERSION = "fgb-2.7.2";
const SHELL = [
  "./", "index.html", "css/app.css", "manifest.json",
  "js/app.js", "js/api.js", "js/connections.js", "js/i18n.js", "js/maps.js", "js/chat.js", "js/admin.js", "js/importer.js", "js/i18n/fr.js", "js/i18n/es.js", "js/native.js", "js/demo.js", "js/board.js", "js/records.js", "js/state.js", "js/ui.js", "js/util.js", "js/config.js",
  "vendor/capacitor.js", "vendor/supabase.js", "vendor/leaflet.js", "vendor/leaflet.css", "vendor/qrcode.js",
  "vendor/fonts/barlow-condensed-latin-600-normal.woff2", "vendor/fonts/barlow-condensed-latin-700-normal.woff2",
  "vendor/fonts/barlow-condensed-latin-800-normal.woff2", "vendor/fonts/barlow-latin-400-normal.woff2",
  "vendor/fonts/barlow-latin-500-normal.woff2", "vendor/fonts/barlow-latin-600-normal.woff2",
  "img/icon-192.png", "img/icon-512.png", "img/badge-96.png", "img/favicon-64.png", "img/logo.png", "img/logo-dark.png",
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

// ---------------- call alerts (Android phones and computers) ----------------
// The server sends the same alerts the iPhone app gets. PAR and Missing stay on
// screen until tapped and vibrate hard; chat is quiet.
self.addEventListener("push", (e) => {
  let a = {};
  try { a = e.data ? e.data.json() : {}; } catch { a = { title: "Fire Ground Board", body: e.data ? e.data.text() : "" }; }
  const urgent = a.kind === "par" || a.kind === "missing";
  e.waitUntil(self.registration.showNotification(a.title || "Fire Ground Board", {
    body: a.body || "",
    tag: a.tag || a.kind || "fgb",
    renotify: true,
    requireInteraction: urgent,
    silent: a.loud === false,
    vibrate: urgent ? [600, 200, 600, 200, 600] : a.loud === false ? [] : [300, 120, 300],
    icon: "img/icon-192.png",
    badge: "img/badge-96.png",
    data: { url: a.url || "/" },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = new URL(e.notification.data?.url || "/", self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = wins.find((w) => new URL(w.url).origin === self.location.origin);
    if (open) {
      await open.focus();
      try { await open.navigate(target); } catch { open.postMessage({ type: "open", url: target }); }
      return;
    }
    await self.clients.openWindow(target);
  })());
});

// Browsers sometimes swap the alert subscription. Let the app re-save it next time it opens.
self.addEventListener("pushsubscriptionchange", () => {});
