/* Tadaa! service worker — offline shell. GitHub API is never cached. */
const CACHE = "tadaa-v1";
const CORE = [
  "./", "./index.html", "./manifest.webmanifest",
  "./assets/css/base.css", "./assets/css/components.css", "./assets/css/animations.css",
  "./assets/js/theme-init.js", "./assets/js/lib.js", "./assets/js/app.js",
  "./assets/fonts/vazirmatn-arabic-wght-normal.woff2",
  "./assets/fonts/vazirmatn-latin-wght-normal.woff2",
  "./assets/fonts/fredoka-latin-wght-normal.woff2",
  "./assets/img/favicon.svg",
];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.hostname === "api.github.com") return; // sync traffic: network only
  if (url.pathname.endsWith("todolist/vault.json")) { e.respondWith(fetch(e.request, { cache: "no-store" }).catch(() => caches.match(e.request))); return; }
  e.respondWith(
    caches.match(e.request).then((hit) => {
      const net = fetch(e.request).then((res) => {
        if (res.ok && url.origin === location.origin) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
