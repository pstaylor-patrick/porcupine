/** Service worker: caches the app shell only. Never touches /api or /ws. */

declare const __SHELL__: string[];
declare const __VERSION__: string;

const sw = self as unknown as ServiceWorkerGlobalScope;
const CACHE = `porcupine-shell-${__VERSION__}`;

function isShellRequest(url: URL, origin: string): boolean {
  if (url.origin !== origin) return false;
  return !(url.pathname.startsWith("/api/") || url.pathname === "/ws" || url.pathname === "/login");
}

function isHashed(pathname: string): boolean {
  return /-[A-Za-z0-9_]{8,}\.[a-z0-9]+$/.test(pathname);
}

sw.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(__SHELL__))
      .then(() => sw.skipWaiting()),
  );
});

sw.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("porcupine-shell-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => sw.clients.claim()),
  );
});

sw.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (!isShellRequest(url, sw.location.origin)) return;
  if (isHashed(url.pathname)) {
    e.respondWith(caches.match(req).then((hit) => hit ?? fetch(req)));
    return;
  }
  if (req.mode === "navigate" || url.pathname === "/" || url.pathname === "/index.html") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          // A redirect to /login means the cookie expired: pass it through, do not cache it.
          if (res.ok && !res.redirected) {
            const copy = res.clone();
            void caches.open(CACHE).then((c) => c.put("/", copy));
          }
          return res;
        })
        .catch(() => caches.match("/").then((hit) => hit ?? Response.error())),
    );
  }
});
