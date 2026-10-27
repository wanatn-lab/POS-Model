// Kitchen screen service worker: keeps the SCREEN (html/css/js) available when the wifi blips.
// It NEVER caches /api/*: order data is always fetched live, so old orders can't pass as current.
const CACHE = "kitchen-shell-v1";
const SHELL = [
  "/kitchen",
  "/kitchen-assets/kitchen.css",
  "/kitchen-assets/main.js",
  "/kitchen-assets/logic.js",
  "/kitchen-assets/view.js",
  "/kitchen-assets/gestures.js",
  "/kitchen-assets/icon-192.png",
  "/kitchen-manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.pathname.startsWith("/api/")) return; // live data: straight to network
  const isShell = url.origin === location.origin && (url.pathname === "/kitchen" || url.pathname.startsWith("/kitchen-"));
  const isFont = url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
  if (!isShell && !isFont) return;
  // network first (so a new version arrives as soon as there is signal), cache as the offline fallback
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok || res.type === "opaque") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true })),
  );
});
