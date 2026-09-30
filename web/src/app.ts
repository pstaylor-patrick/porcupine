/** App controller: wires the connection, transcript model, renderer and composer together. */
import { DialogQueue, renderDialog, type Dialog, type DialogAnswer } from "./questions.js";
import { TranscriptView } from "./render.js";
import { applyEvent, emptyTranscript, fromMessages, type Transcript } from "./transcript.js";
import { filterModels, parseModel, sheetState, type ModelInfo, type SheetState } from "./models.js";
import { Connection, type PiResponse, type ServerFrame, type SessionInfo } from "./ws.js";

export function appTitle(): string {
  return "Porcupine";
}

export interface ComposerActions {
  send(): void;
  abort(): void;
}

/** Overlays close in this order on Esc: the topmost one wins. */
export type Overlay = "sheet" | "sidebar" | "settings" | "dialog";

export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i >= 0 ? trimmed.slice(i + 1) || "/" : trimmed;
}

declare const __APP_VERSION__: string | undefined;
export const APP_VERSION: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/** Enter sends, Shift+Enter inserts a newline, Esc aborts (open overlays take Esc first, see App.bind). Returns true when the key was handled. */
export function handleComposerKey(e: KeyboardEvent, actions: ComposerActions): boolean {
  if (e.isComposing) return false;
  if (e.key === "Escape") {
    e.preventDefault();
    actions.abort();
    return true;
  }
  if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    actions.send();
    return true;
  }
  return false;
}

export type StreamingBehavior = "followUp" | "steer";

/** The prompt command. `images` is always present (empty until attachments land). */
export function buildPrompt(message: string, streaming: boolean, behavior: StreamingBehavior): Record<string, unknown> & { type: string } {
  const cmd: Record<string, unknown> & { type: string } = { type: "prompt", message, images: [] };
  if (streaming) cmd.streamingBehavior = behavior;
  return cmd;
}

export { filterModels, type ModelInfo } from "./models.js";

const SHEET_MESSAGES: Record<Exclude<SheetState, "ready" | "error">, string> = {
  detached: "Not attached: pick a session",
  loading: "Loading models",
  empty: "No models available (check the provider key)",
};

function $(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node;
}

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export class App {
  t: Transcript = emptyTranscript();
  sessions: SessionInfo[] = [];
  models: ModelInfo[] = [];
  model: ModelInfo | null = null;
  thinkingLevel = "off";
  connState: "connecting" | "open" | "closed" = "closed";
  /** Open overlays, bottom to top. */
  readonly overlays: Overlay[] = [];
  /** Wide layout: sidebar docked, sheet as a right panel. Overridable for tests. */
  isDesktop: () => boolean = () => typeof window.matchMedia === "function" && window.matchMedia("(min-width: 900px)").matches;
  navigate: (url: string) => void = (url) => location.assign(url);
  readonly dialogs = new DialogQueue();
  /** The dialog shown in the sheet; hiding the sheet keeps it pending. */
  private shownDialog: Dialog | null = null;
  private readonly returnFocus = new Map<Overlay, HTMLElement | null>();
  private modelsRequest: Promise<void> | null = null;
  /** Session the in-flight model request was sent for; a response for another session is dropped. */
  private modelsFor: string | null = null;
  private modelsSeq = 0;
  modelsLoading = false;
  modelsError: string | null = null;
  private resetting = false;
  private resetBuffer: Record<string, unknown>[] = [];
  private renderQueued = false;
  private readonly view: TranscriptView;
  private readonly input = $("input") as HTMLTextAreaElement;
  private readonly main = $("main");

  constructor(readonly conn: Connection) {
    this.view = new TranscriptView($("transcript"));
  }

  handlers() {
    return {
      onFrame: (f: ServerFrame) => this.onFrame(f),
      onStatus: (s: "connecting" | "open" | "closed") => {
        this.connState = s;
        const label = s === "open" ? "Connected" : s === "connecting" ? "Connecting" : "Disconnected";
        const dot = $("conn-dot");
        dot.dataset.state = s;
        dot.setAttribute("aria-label", label);
        $("settings-conn").textContent = label;
      },
    };
  }

  bind(): void {
    const form = $("composer") as HTMLFormElement;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.send();
    });
    // Capture phase: an open overlay swallows Esc before the composer can turn it into an abort.
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Escape" && !e.isComposing && this.overlays.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          this.closeTop();
        } else if (e.key === "Tab") this.trapFocus(e);
      },
      true,
    );
    this.input.addEventListener("keydown", (e) => {
      handleComposerKey(e, { send: () => void this.send(), abort: () => void this.abort() });
    });
    this.input.addEventListener("input", () => {
      this.autogrow();
      this.queueRender();
    });
    $("abort").addEventListener("click", () => void this.abort());
    $("menu-button").addEventListener("click", () => this.toggleSidebar());
    $("sheet-button").addEventListener("click", () => (this.overlays.includes("sheet") ? this.close("sheet") : this.openSheet()));
    $("sheet-close").addEventListener("click", () => this.close("sheet"));
    $("scrim").addEventListener("click", () => this.closeTop());
    $("dialog-close").addEventListener("click", () => this.close("dialog"));
    $("dialog-reopen").addEventListener("click", () => this.showDialog());
    $("settings-link").addEventListener("click", () => this.openSettings());
    $("settings-back").addEventListener("click", () => this.close("settings"));
    $("logout").addEventListener("click", () => void this.logout());
    ($("thinking-select") as HTMLSelectElement).addEventListener("change", (e) => {
      void this.setThinking((e.target as HTMLSelectElement).value);
    });
    ($("model-filter") as HTMLInputElement).addEventListener("input", () => this.renderModels());
    $("new-session").addEventListener("click", () => void this.newSession());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && e.target !== this.input && document.activeElement !== this.input && this.t.isStreaming) void this.abort();
    });
    $("settings-app-version").textContent = APP_VERSION;
    this.syncOverlays();
  }

  // ---- overlays -------------------------------------------------------

  private open(o: Overlay, focusId: string): void {
    if (!this.overlays.includes(o)) {
      const active = document.activeElement;
      // Safari does not focus buttons on tap, so fall back to the control that opens this overlay.
      const opener = document.getElementById(o === "sheet" ? "sheet-button" : o === "dialog" ? "input" : "menu-button");
      this.returnFocus.set(o, active instanceof HTMLElement && active !== document.body ? active : opener);
      this.overlays.push(o);
    }
    this.syncOverlays();
    document.getElementById(focusId)?.focus();
  }

  close(o: Overlay): void {
    const i = this.overlays.indexOf(o);
    if (i < 0) return;
    this.overlays.splice(i, 1);
    this.syncOverlays();
    const back = this.returnFocus.get(o);
    this.returnFocus.delete(o);
    if (back && back.isConnected) back.focus();
  }

  closeTop(): void {
    const top = this.overlays[this.overlays.length - 1];
    if (top) this.close(top);
  }

  toggleSidebar(): void {
    if (this.isDesktop()) {
      // Docked: the hamburger collapses and expands the sidebar instead of opening a modal.
      const layout = $("app");
      const collapsed = layout.classList.toggle("sidebar-collapsed");
      $("menu-button").setAttribute("aria-expanded", String(!collapsed));
      return;
    }
    if (this.overlays.includes("sidebar")) this.close("sidebar");
    else this.open("sidebar", this.firstSessionButtonId());
  }

  private firstSessionButtonId(): string {
    const current = document.querySelector<HTMLElement>('#session-list [aria-current="true"]');
    return current?.id || document.querySelector<HTMLElement>("#session-list button")?.id || "settings-link";
  }

  openSheet(): void {
    this.open("sheet", "model-filter");
    this.renderHeader();
    void this.loadModels();
  }

  openSettings(): void {
    if (this.overlays.includes("sidebar")) this.close("sidebar");
    this.renderSettings();
    this.open("settings", "settings-back");
  }

  private syncOverlays(): void {
    const desktop = this.isDesktop();
    const sidebarOpen = this.overlays.includes("sidebar");
    const sheetOpen = this.overlays.includes("sheet");
    const settingsOpen = this.overlays.includes("settings");
    const dialogOpen = this.overlays.includes("dialog");
    $("dialog").dataset.open = String(dialogOpen);
    const sidebar = $("sidebar");
    sidebar.dataset.open = String(sidebarOpen);
    if (sidebarOpen) {
      sidebar.setAttribute("role", "dialog");
      sidebar.setAttribute("aria-modal", "true");
    } else {
      sidebar.removeAttribute("role");
      sidebar.removeAttribute("aria-modal");
    }
    if (!desktop) $("menu-button").setAttribute("aria-expanded", String(sidebarOpen));
    $("sheet").dataset.open = String(sheetOpen);
    $("sheet-button").setAttribute("aria-expanded", String(sheetOpen));
    $("settings").hidden = !settingsOpen;
    $("scrim").hidden = !(sheetOpen || sidebarOpen || dialogOpen);
    $("scrim").dataset.for = sheetOpen || dialogOpen ? "sheet" : "sidebar";
  }

  private overlayElement(o: Overlay): HTMLElement {
    return $(o);
  }

  /** Keep Tab inside the topmost overlay. */
  private trapFocus(e: KeyboardEvent): void {
    const top = this.overlays[this.overlays.length - 1];
    if (!top) return;
    const nodes = [...this.overlayElement(top).querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !this.overlayElement(top).contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !this.overlayElement(top).contains(active))) {
      e.preventDefault();
      first.focus();
    }
  }

  // ---- extension dialogs ----------------------------------------------

  /** Opens the sheet for a newly arrived dialog and closes it once the dialog is answered anywhere. */
  syncDialog(): void {
    const d = this.dialogs.current;
    $("dialog-reopen").hidden = d === null;
    if (d === null) {
      this.shownDialog = null;
      this.close("dialog");
      return;
    }
    if (d !== this.shownDialog) this.showDialog();
  }

  showDialog(): void {
    const d = this.dialogs.current;
    if (!d) return;
    this.shownDialog = d;
    const { title, body } = renderDialog(d, (a) => void this.answerDialog(a));
    $("dialog-title").textContent = title;
    $("dialog-body").replaceChildren(body);
    const first = body.querySelector<HTMLElement>("input, textarea, button");
    if (first) first.id ||= "dialog-first";
    this.open("dialog", first?.id ?? "dialog-close");
  }

  async answerDialog(a: DialogAnswer): Promise<void> {
    const r = await this.conn.command(a);
    if (!r.success) this.notice("error", `answer not delivered: ${r.error ?? "unknown error"}`);
  }

  // ---- settings -------------------------------------------------------

  renderSettings(): void {
    const s = this.sessions.find((x) => x.id === this.conn.sessionId);
    const pi = s?.piVersion ?? null;
    $("settings-pi-row").hidden = !pi;
    $("settings-pi-version").textContent = pi ?? "";
    $("settings-app-version").textContent = APP_VERSION;
  }

  async logout(): Promise<void> {
    try {
      await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
    } catch {
      // offline: the cookie stays, but the login page is still the right place to land
    }
    this.navigate("/login");
  }

  // ---- frames ---------------------------------------------------------

  private autogrow(): void {
    this.input.style.height = "auto";
    this.input.style.height = `${Math.min(this.input.scrollHeight, 240)}px`;
  }

  onFrame(f: ServerFrame): void {
    switch (f.t) {
      case "sessions":
        this.sessions = f.sessions;
        if (!this.conn.sessionId && f.sessions.length === 1 && f.sessions[0]) this.attach(f.sessions[0].id);
        else if (this.conn.sessionId && !f.sessions.some((s) => s.id === this.conn.sessionId)) this.sessionGone();
        this.renderSessions();
        return;
      case "attached":
        void this.refreshState();
        return;
      case "reset":
        void this.rebuild();
        return;
      case "event":
        if (this.resetting) this.resetBuffer.push(f.event);
        else {
          applyEvent(this.t, f.event);
          if (this.dialogs.apply(f.event)) this.syncDialog();
          if (f.event.type === "thinking_level_changed" && typeof f.event.level === "string") {
            this.thinkingLevel = f.event.level;
            this.renderHeader();
          }
          this.queueRender();
        }
        return;
      case "session_ended":
        if (f.session === this.conn.sessionId) this.sessionGone();
        return;
      case "error":
        this.notice("error", f.message);
        return;
      default:
        return;
    }
  }

  attach(id: string): void {
    if (id !== this.conn.sessionId) {
      this.dialogs.clear();
      this.syncDialog();
      this.t = emptyTranscript();
      this.view.clear();
      this.model = null;
    }
    this.resetModels();
    this.conn.attach(id);
    this.renderSessions();
    this.renderHeader();
    this.queueRender();
  }

  /** Tap on a sidebar entry: attach and, on the phone layout, get the flyout out of the way. */
  selectSession(id: string): void {
    this.attach(id);
    if (this.overlays.includes("sidebar")) this.close("sidebar");
    if (!this.isDesktop()) this.input.focus();
  }

  private sessionGone(): void {
    this.notice("warn", "session ended");
    this.conn.detach();
    this.resetModels();
    this.renderModels();
    this.renderSessions();
  }

  notice(level: "info" | "warn" | "error", text: string): void {
    applyEvent(this.t, { type: "porcupine_notice", level, text });
    this.queueRender();
  }

  /** Reset path: rebuild from get_messages, then apply events buffered meanwhile (deduplicated). */
  async rebuild(): Promise<void> {
    this.resetting = true;
    this.resetBuffer = [];
    const r = await this.conn.command({ type: "get_messages" });
    const t = r.success && isRec(r.data) ? fromMessages(r.data.messages) : emptyTranscript();
    const buffered = this.resetBuffer;
    this.resetting = false;
    this.resetBuffer = [];
    for (const ev of buffered) applyEvent(t, ev);
    this.t = t;
    this.view.clear();
    if (!r.success) this.notice("error", `could not load history: ${r.error ?? "unknown error"}`);
    void this.refreshState();
    this.queueRender();
  }

  async refreshState(): Promise<void> {
    const r = await this.conn.command({ type: "get_state" });
    if (!r.success || !isRec(r.data)) return;
    const d = r.data;
    if ("model" in d) this.model = parseModel(d.model);
    if (typeof d.thinkingLevel === "string") this.thinkingLevel = d.thinkingLevel;
    if (typeof d.isStreaming === "boolean") this.t.isStreaming = d.isStreaming;
    this.renderHeader();
    this.queueRender();
  }

  // ---- commands -------------------------------------------------------

  async send(): Promise<void> {
    const text = this.input.value;
    if (!text.trim() || !this.conn.sessionId) return;
    const steer = ($("steer") as HTMLInputElement).checked;
    const cmd = buildPrompt(text, this.t.isStreaming, steer ? "steer" : "followUp");
    this.input.value = "";
    this.autogrow();
    const r = await this.conn.command(cmd);
    if (!r.success) {
      if (!this.input.value) this.input.value = text;
      this.notice("error", `prompt rejected: ${r.error ?? "unknown error"}`);
      void this.refreshState();
    }
  }

  async abort(): Promise<void> {
    if (!this.conn.sessionId) return;
    const r = await this.conn.command({ type: "abort" });
    if (!r.success) this.notice("error", `abort failed: ${r.error ?? "unknown error"}`);
  }

  async setThinking(level: string): Promise<void> {
    const r = await this.conn.command({ type: "set_thinking_level", level });
    if (r.success) this.thinkingLevel = level;
    else this.notice("error", `thinking level: ${r.error ?? "failed"}`);
    this.renderHeader();
  }

  async setModel(m: ModelInfo): Promise<void> {
    const r = await this.conn.command({ type: "set_model", provider: m.provider, modelId: m.id });
    if (r.success) this.model = parseModel(r.data) ?? m;
    else this.notice("error", `set model: ${r.error ?? "failed"}`);
    this.renderHeader();
    this.renderModels();
  }

  async newSession(): Promise<void> {
    if (!this.conn.sessionId) return;
    if (!window.confirm("Start a new conversation in this pi process? The current one stays in its session file.")) return;
    const r: PiResponse = await this.conn.command({ type: "new_session" });
    if (!r.success) {
      this.notice("error", `new session: ${r.error ?? "failed"}`);
      return;
    }
    if (isRec(r.data) && r.data.cancelled === true) {
      this.notice("warn", "new session cancelled by an extension");
      return;
    }
    this.close("sheet");
    this.t = emptyTranscript();
    this.view.clear();
    void this.refreshState();
    this.queueRender();
  }

  private resetModels(): void {
    this.models = [];
    this.modelsError = null;
    this.modelsLoading = false;
    this.modelsRequest = null;
    this.modelsFor = null;
    this.modelsSeq++;
  }

  loadModels(): Promise<void> {
    const sid = this.conn.sessionId;
    if (this.models.length > 0 || !sid) {
      this.renderModels();
      return Promise.resolve();
    }
    if (this.modelsRequest && this.modelsFor === sid) return this.modelsRequest;
    this.modelsFor = sid;
    this.modelsLoading = true;
    this.modelsError = null;
    this.renderModels();
    const seq = ++this.modelsSeq;
    const req = (async () => {
      const r = await this.conn.command({ type: "get_available_models" });
      if (seq !== this.modelsSeq || this.conn.sessionId !== sid) return;
      if (r.success && isRec(r.data) && Array.isArray(r.data.models)) {
        this.models = r.data.models.map(parseModel).filter((m): m is ModelInfo => m !== null);
      } else {
        this.modelsError = r.error ?? "failed";
        this.notice("error", `models: ${this.modelsError}`);
      }
      this.modelsLoading = false;
      this.modelsRequest = null;
      this.renderModels();
    })();
    this.modelsRequest = req;
    return req;
  }

  // ---- rendering ------------------------------------------------------

  renderModels(): void {
    const list = $("model-list");
    const status = $("model-state");
    const state = sheetState({
      attached: this.conn.sessionId !== null,
      loading: this.modelsLoading,
      error: this.modelsError,
      models: this.models,
    });
    status.hidden = state === "ready";
    status.dataset.state = state;
    if (state === "error") status.textContent = `Could not load models: ${this.modelsError ?? "failed"}`;
    else if (state !== "ready") status.textContent = SHEET_MESSAGES[state];
    else status.textContent = "";
    const q = ($("model-filter") as HTMLInputElement).value;
    const shown = filterModels(this.models, q).slice(0, 200);
    list.replaceChildren(
      ...shown.map((m) => {
        const li = document.createElement("li");
        const b = document.createElement("button");
        b.type = "button";
        b.className = "model-option";
        b.setAttribute("role", "option");
        const current = this.model && this.model.id === m.id && this.model.provider === m.provider;
        b.setAttribute("aria-selected", current ? "true" : "false");
        b.textContent = `${m.provider}/${m.id}`;
        b.addEventListener("click", () => void this.setModel(m));
        li.append(b);
        return li;
      }),
    );
  }

  renderHeader(): void {
    $("model-current").textContent = this.model ? `${this.model.provider}/${this.model.id}` : "No model";
    const thinking = $("thinking-select") as HTMLSelectElement;
    const noReasoning = this.model?.reasoning === false;
    thinking.disabled = noReasoning;
    thinking.value = noReasoning ? "off" : this.thinkingLevel;
    const s = this.sessions.find((x) => x.id === this.conn.sessionId);
    const title = $("session-title");
    title.textContent = s ? s.name : "Porcupine";
    title.title = s ? s.cwd : "";
    const attached = this.conn.sessionId !== null;
    ($("new-session") as HTMLButtonElement).disabled = !attached;
  }

  renderSessions(): void {
    const list = $("session-list");
    list.replaceChildren(
      ...this.sessions.map((s) => {
        const li = document.createElement("li");
        const b = document.createElement("button");
        b.type = "button";
        b.className = "session-item";
        b.id = `session-${s.id}`;
        if (s.id === this.conn.sessionId) b.setAttribute("aria-current", "true");
        const name = document.createElement("span");
        name.className = "session-name";
        name.textContent = s.name;
        if (s.isStreaming) {
          const dot = document.createElement("span");
          dot.className = "session-streaming";
          dot.setAttribute("role", "img");
          dot.setAttribute("aria-label", "running");
          name.append(dot);
        }
        const cwd = document.createElement("span");
        cwd.className = "session-cwd";
        cwd.textContent = basename(s.cwd);
        b.title = s.cwd;
        b.append(name, cwd);
        b.addEventListener("click", () => this.selectSession(s.id));
        li.append(b);
        return li;
      }),
    );
    $("session-empty").hidden = this.sessions.length > 0;
    $("empty").hidden = this.conn.sessionId !== null;
    this.renderHeader();
    if (!$("settings").hidden) this.renderSettings();
  }

  private queueRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (fn: () => void) => setTimeout(fn, 16);
    raf(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  render(): void {
    const nearBottom = this.main.scrollHeight - this.main.scrollTop - this.main.clientHeight < 120;
    this.view.render(this.t);
    const streaming = this.t.isStreaming;
    $("abort").hidden = !streaming;
    $("send").hidden = streaming && !this.input.value.trim();
    $("run-status").textContent = streaming ? "Running" : "Idle";
    $("empty").hidden = this.conn.sessionId !== null;
    if (nearBottom) this.main.scrollTop = this.main.scrollHeight;
  }
}

async function checkAuth(): Promise<void> {
  try {
    const r = await fetch("/api/me", { credentials: "same-origin" });
    if (r.status === 401) location.assign("/login");
  } catch {
    // offline: keep retrying the socket
  }
}

export function start(): void {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  let storage: Storage | null = null;
  try {
    storage = window.sessionStorage;
  } catch {
    storage = null;
  }
  let app: App | null = null;
  const conn = new Connection(
    { url: `${proto}//${location.host}/ws`, storage },
    {
      onFrame: (f) => app?.onFrame(f),
      onStatus: (s) => {
        app?.handlers().onStatus(s);
        if (s === "closed") void checkAuth();
      },
    },
  );
  app = new App(conn);
  app.bind();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") conn.kick();
  });
  window.addEventListener("online", () => conn.kick());
  conn.connect();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }
}

if (typeof document !== "undefined" && document.getElementById("app")) start();
