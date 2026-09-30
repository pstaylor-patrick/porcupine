/** App controller: wires the connection, transcript model, renderer and composer together. */
import { TranscriptView } from "./render.js";
import { applyEvent, emptyTranscript, fromMessages, type Transcript } from "./transcript.js";
import { Connection, type PiResponse, type ServerFrame, type SessionInfo } from "./ws.js";

export function appTitle(): string {
  return "Porcupine";
}

export interface ComposerActions {
  send(): void;
  abort(): void;
}

/** Enter sends, Shift+Enter inserts a newline, Esc aborts. Returns true when the key was handled. */
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

export interface ModelInfo {
  id: string;
  name?: string;
  provider: string;
  reasoning?: boolean;
}

export function filterModels(models: ModelInfo[], query: string): ModelInfo[] {
  const q = query.trim().toLowerCase();
  if (!q) return models;
  const terms = q.split(/\s+/);
  return models.filter((m) => {
    const hay = `${m.provider}/${m.id} ${m.name ?? ""}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

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
        const dot = $("conn-dot");
        dot.dataset.state = s;
        dot.setAttribute("aria-label", s === "open" ? "Connected" : s === "connecting" ? "Connecting" : "Disconnected");
      },
    };
  }

  bind(): void {
    const form = $("composer") as HTMLFormElement;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.send();
    });
    this.input.addEventListener("keydown", (e) => {
      handleComposerKey(e, { send: () => void this.send(), abort: () => void this.abort() });
    });
    this.input.addEventListener("input", () => {
      this.autogrow();
      this.queueRender();
    });
    $("abort").addEventListener("click", () => void this.abort());
    ($("session-select") as HTMLSelectElement).addEventListener("change", (e) => {
      const v = (e.target as HTMLSelectElement).value;
      if (v) this.attach(v);
    });
    ($("thinking-select") as HTMLSelectElement).addEventListener("change", (e) => {
      void this.setThinking((e.target as HTMLSelectElement).value);
    });
    $("model-button").addEventListener("click", () => void this.openModels());
    ($("model-filter") as HTMLInputElement).addEventListener("input", () => this.renderModels());
    $("new-session").addEventListener("click", () => void this.newSession());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && document.activeElement !== this.input && this.t.isStreaming) void this.abort();
    });
  }

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
      this.t = emptyTranscript();
      this.view.clear();
    }
    this.conn.attach(id);
    this.renderSessions();
    this.queueRender();
  }

  private sessionGone(): void {
    this.notice("warn", "session ended");
    this.conn.detach();
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
    if (isRec(d.model) && typeof d.model.id === "string") this.model = d.model as unknown as ModelInfo;
    if (typeof d.thinkingLevel === "string") this.thinkingLevel = d.thinkingLevel;
    if (typeof d.isStreaming === "boolean") this.t.isStreaming = d.isStreaming;
    this.renderHeader();
    this.queueRender();
  }

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
    if (r.success) this.model = isRec(r.data) && typeof r.data.id === "string" ? (r.data as unknown as ModelInfo) : m;
    else this.notice("error", `set model: ${r.error ?? "failed"}`);
    this.renderHeader();
  }

  async newSession(): Promise<void> {
    if (!this.conn.sessionId) return;
    if (!window.confirm("Start a new pi session in this process? The current conversation stays in its session file.")) return;
    const r: PiResponse = await this.conn.command({ type: "new_session" });
    if (!r.success) {
      this.notice("error", `new session: ${r.error ?? "failed"}`);
      return;
    }
    if (isRec(r.data) && r.data.cancelled === true) {
      this.notice("warn", "new session cancelled by an extension");
      return;
    }
    this.t = emptyTranscript();
    this.view.clear();
    void this.refreshState();
    this.queueRender();
  }

  async openModels(): Promise<void> {
    const dialog = $("model-dialog") as HTMLDialogElement;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    ($("model-filter") as HTMLInputElement).focus();
    if (this.models.length === 0) {
      const r = await this.conn.command({ type: "get_available_models" });
      if (r.success && isRec(r.data) && Array.isArray(r.data.models)) {
        this.models = (r.data.models as unknown[]).filter(
          (m): m is ModelInfo => isRec(m) && typeof m.id === "string" && typeof m.provider === "string",
        );
      } else this.notice("error", `models: ${r.error ?? "failed"}`);
    }
    this.renderModels();
  }

  renderModels(): void {
    const list = $("model-list");
    const q = ($("model-filter") as HTMLInputElement).value;
    const shown = filterModels(this.models, q).slice(0, 200);
    list.replaceChildren(
      ...shown.map((m) => {
        const li = document.createElement("li");
        const b = document.createElement("button");
        b.type = "button";
        b.className = "model-option";
        const current = this.model && this.model.id === m.id && this.model.provider === m.provider;
        b.setAttribute("aria-selected", current ? "true" : "false");
        b.textContent = `${m.provider}/${m.id}`;
        b.addEventListener("click", () => {
          ($("model-dialog") as HTMLDialogElement).close();
          void this.setModel(m);
        });
        li.append(b);
        return li;
      }),
    );
  }

  renderHeader(): void {
    const mb = $("model-button");
    mb.textContent = this.model ? this.model.id : "model";
    const ts = $("thinking-select") as HTMLSelectElement;
    ts.value = this.thinkingLevel;
  }

  renderSessions(): void {
    const sel = $("session-select") as HTMLSelectElement;
    const opts = this.sessions.map((s) => {
      const o = document.createElement("option");
      o.value = s.id;
      o.textContent = `${s.isStreaming ? "● " : ""}${s.name}`;
      return o;
    });
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = this.sessions.length ? "Choose session" : "No sessions";
    sel.replaceChildren(placeholder, ...opts);
    sel.value = this.conn.sessionId ?? "";
    const list = $("session-list");
    list.replaceChildren(
      ...this.sessions.map((s) => {
        const li = document.createElement("li");
        const b = document.createElement("button");
        b.type = "button";
        b.className = "session-item";
        if (s.id === this.conn.sessionId) b.setAttribute("aria-current", "true");
        const name = document.createElement("span");
        name.className = "session-name";
        name.textContent = `${s.isStreaming ? "● " : ""}${s.name}`;
        const cwd = document.createElement("span");
        cwd.className = "session-cwd";
        cwd.textContent = s.cwd;
        b.append(name, cwd);
        b.addEventListener("click", () => this.attach(s.id));
        li.append(b);
        return li;
      }),
    );
    $("empty").hidden = this.conn.sessionId !== null;
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
    $("steer-wrap").hidden = !streaming;
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
