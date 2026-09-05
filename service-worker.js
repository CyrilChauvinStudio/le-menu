const CACHE = "le-menu-v6";
const STATIC = [
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-512-maskable.png",
  "./apple-touch-icon-180.png",
];
const CORE = ["./", "./index.html", "./app.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll([...CORE, ...STATIC])));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((ks) =>
      Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname.includes("api.anthropic.com")) return;

  const isCore =
    req.mode === "navigate" ||
    url.pathname.endsWith("/app.js") ||
    url.pathname.endsWith("/index.html") ||
    url.pathname.endsWith("/");

  if (isCore) {
    // network-first : on prend toujours la dernière version en ligne si possible
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() =>
          caches.match(req).then((r) => r || caches.match("./index.html"))
        )
    );
  } else {
    // cache-first pour les fichiers statiques (icônes, manifeste)
    e.respondWith(caches.match(req).then((r) => r || fetch(req)));
  }
});
