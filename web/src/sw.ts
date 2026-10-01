/** Service worker: caches the app shell (never /api or /ws) and shows Web Push notifications. */

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
          // Safari shows a blank page when a service worker answers a navigation
          // with a redirected response, so hand the redirect back to the browser.
          return res.redirected ? Response.redirect(res.url, 303) : res;
        })
        .catch(() => caches.match("/").then((hit) => hit ?? Response.error())),
    );
  }
});

interface PushPayload {
  title?: string;
  body?: string;
  session?: string;
  tag?: string;
}

sw.addEventListener("push", (e) => {
  let p: PushPayload = {};
  try {
    p = (e.data?.json() ?? {}) as PushPayload;
  } catch {
    p = { body: e.data?.text() ?? "" };
  }
  const opts: NotificationOptions = { body: p.body ?? "", icon: "/icons/icon-192.png", data: { session: p.session ?? null } };
  if (p.tag) opts.tag = p.tag;
  e.waitUntil(sw.registration.showNotification(p.title ?? "Porcupine", opts));
});

sw.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const data = e.notification.data as { session?: string | null } | null;
  const session = data?.session ?? null;
  e.waitUntil(
    sw.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (wins) => {
      const win = wins.find((w) => new URL(w.url).origin === sw.location.origin);
      if (win) {
        if (session) win.postMessage({ type: "open-session", session });
        await win.focus();
        return;
      }
      await sw.clients.openWindow(session ? `/?session=${encodeURIComponent(session)}` : "/");
    }),
  );
});
