/** Web Push subscription from the settings toggle. iOS only allows it from a home-screen install. */

export type PushState = "unsupported" | "denied" | "off" | "on";

function supported(): boolean {
  return typeof navigator !== "undefined" && "serviceWorker" in navigator && typeof window !== "undefined" && "PushManager" in window && "Notification" in window;
}

export async function pushState(): Promise<PushState> {
  if (!supported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    return (await reg?.pushManager.getSubscription()) ? "on" : "off";
  } catch {
    return "off";
  }
}

export function pushHint(s: PushState): string {
  switch (s) {
    case "unsupported":
      return "This browser has no Web Push. On iPhone and iPad, add Porcupine to the home screen and open it from there.";
    case "denied":
      return "Notifications are blocked for this site. Allow them in the browser's site settings.";
    case "on":
      return "Only for sessions you are not looking at. At most one per session every 2 minutes.";
    case "off":
      return "Off.";
  }
}

export function fromB64u(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function post(path: string, body: unknown): Promise<void> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
}

export async function enablePush(): Promise<void> {
  if (!supported()) throw new Error("not supported in this browser");
  if ((await Notification.requestPermission()) !== "granted") throw new Error("permission not granted");
  const res = await fetch("/api/push/key", { credentials: "same-origin" });
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
  const { publicKey } = (await res.json()) as { publicKey: string };
  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  const sub = existing ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64u(publicKey) }));
  await post("/api/push/subscribe", sub.toJSON());
}

export async function disablePush(): Promise<void> {
  if (!supported()) return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await post("/api/push/unsubscribe", { endpoint: sub.endpoint }).catch(() => undefined);
  await sub.unsubscribe();
}

export interface NotifyPrefs {
  input: boolean;
  finished: boolean;
  budget: boolean;
}

export async function getNotifyPrefs(): Promise<NotifyPrefs> {
  const res = await fetch("/api/push/prefs", { credentials: "same-origin" });
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
  return (await res.json()) as NotifyPrefs;
}

export async function setNotifyPref(key: keyof NotifyPrefs, on: boolean): Promise<void> {
  await post("/api/push/prefs", { [key]: on });
}
