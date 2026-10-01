/** App controller: wires the connection, transcript model, renderer and composer together. */
import {
  chipWarning,
  showNotice,
  textOnly,
  classify,
  DEFAULT_MAX_BYTES,
  http as uploadsHttp,
  MAX_ATTACHMENTS,
  renderChips,
  renderConfirm,
  sendWithAttachments,
  startUpload,
  type Http,
  type Pending,
  type UploadsConfig,
} from "./attachments.js";
import { GEAR_PATH, icon } from "./markdown.js";
import { MergeModePicker } from "./merge-mode.js";
import { StatusPanel } from "./status-panel.js";
import {
  addBudgetRow,
  bannerFromReport,
  formatUsd,
  parseSessionUsage,
  readBudgetForm,
  renderBudgetForm,
  renderUsage,
  sessionUsageText,
  type SessionUsage,
  type UsageReport,
} from "./usage.js";
import { CommandMenu, parseCommands } from "./commands.js";
import {
  autocompactCommand,
  defaultThreshold,
  groupDigits,
  contextText,
  parseContextUsage,
  type ContextInfo,
} from "./context.js";
import {
  DialogQueue,
  renderDialog,
  type Dialog,
  type DialogAnswer,
} from "./questions.js";
import { TranscriptView } from "./render.js";
import {
  applyEvent,
  emptyTranscript,
  fromMessages,
  type Transcript,
} from "./transcript.js";
import {
  CAPABILITIES,
  CHEAP_INPUT_MAX,
  filterModels,
  LONG_CONTEXT_MIN,
  groupByVendor,
  loadRecent,
  parseModel,
  pushRecent,
  recentKey,
  resolveRecent,
  rowDetail,
  sheetState,
  vendorOf,
  type Capability,
  type ModelInfo,
  type RecentStorage,
  type SheetState,
} from "./models.js";
import {
  emptyQueue,
  itemsFromQueue,
  parseQueue,
  planRewrite,
  renderQueueChips,
  restoreText,
  targetAt,
  type PiQueue,
  type QueueItem,
  type QueueTarget,
} from "./queue.js";
import {
  Connection,
  type PiResponse,
  type ServerFrame,
  type SessionInfo,
} from "./ws.js";
import {
  disablePush,
  enablePush,
  getNotifyPrefs,
  pushHint,
  pushState,
  setNotifyPref,
  type NotifyPrefs,
} from "./push.js";

export function appTitle(): string {
  return "Porcupine";
}

export interface ComposerActions {
  send(): void;
  /** Esc: pop the last queued message into the composer; returns false when nothing is queued. */
  popQueue(): boolean;
}

/** Overlays close in this order on Esc: the topmost one wins. */
export type Overlay = "sheet" | "sidebar" | "settings" | "dialog";

export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i >= 0 ? trimmed.slice(i + 1) || "/" : trimmed;
}

declare const __APP_VERSION__: string | undefined;
export const APP_VERSION: string =
  typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/**
 * Enter sends, Shift+Enter inserts a newline. Esc never aborts: it pops the last queued message into
 * the composer, or blurs the input when nothing is queued (open overlays take Esc first, see App.bind).
 * Returns true when the key was handled.
 */
export function handleComposerKey(
  e: KeyboardEvent,
  actions: ComposerActions,
): boolean {
  if (e.isComposing) return false;
  if (e.key === "Escape") {
    e.preventDefault();
    if (!actions.popQueue() && e.target instanceof HTMLElement) e.target.blur();
    return true;
  }
  if (
    e.key === "Enter" &&
    !e.shiftKey &&
    !e.altKey &&
    !e.ctrlKey &&
    !e.metaKey
  ) {
    e.preventDefault();
    actions.send();
    return true;
  }
  return false;
}

export type StreamingBehavior = "followUp" | "steer";

/** The prompt command. `images` is always present (empty until attachments land). */
export function buildPrompt(
  message: string,
  streaming: boolean,
  behavior: StreamingBehavior,
): Record<string, unknown> & { type: string } {
  const cmd: Record<string, unknown> & { type: string } = {
    type: "prompt",
    message,
    images: [],
  };
  if (streaming) cmd.streamingBehavior = behavior;
  return cmd;
}

export { filterModels, type ModelInfo } from "./models.js";

const RECENT_RAIL_KEY = "__recent";

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
  /** Session named by a notification click, attached once the session list arrives. */
  pendingOpen: string | null = null;
  /** False until the hub's first session list, so a reload doesn't flash the empty states. */
  private sessionsLoaded = false;
  models: ModelInfo[] = [];
  model: ModelInfo | null = null;
  context: ContextInfo | null = null;
  sessionUsage: SessionUsage | null = null;
  usage: UsageReport | null = null;
  compacting = false;
  /** Prompts submitted during compaction, held client-side and flushed when it ends. */
  held: string[] = [];
  private flushing = false;
  thinkingLevel = "off";
  connState: "connecting" | "open" | "closed" = "closed";
  /** Open overlays, bottom to top. */
  readonly overlays: Overlay[] = [];
  /** Wide layout: sidebar docked, sheet as a right panel. Overridable for tests. */
  isDesktop: () => boolean = () =>
    typeof window.matchMedia === "function" &&
    window.matchMedia("(min-width: 900px)").matches;
  navigate: (url: string) => void = (url) => location.assign(url);
  readonly dialogs = new DialogQueue();
  /** pi's queue, mirrored from queue_update (last write wins; the reset snapshot replays it). */
  queue: PiQueue = emptyQueue();
  /** A clear-and-requeue is in flight; chip actions and Esc pops wait for it. */
  queueBusy = false;
  readonly statusPanel = new StatusPanel();
  private mergeMode: MergeModePicker | null = null;
  /** The dialog shown in the sheet; hiding the sheet keeps it pending. */
  private shownDialog: Dialog | null = null;
  private readonly returnFocus = new Map<Overlay, HTMLElement | null>();
  /** Selected capability chips; memory only, kept across sheet open and close. */
  private readonly caps = new Set<Capability>();
  /** Vendor selected in the desktop rail; null picks the current model's vendor. */
  private railVendor: string | null = null;
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
  readonly commandMenu = new CommandMenu($("command-menu"), this.input);
  /** Files attached to the next message; nothing is uploaded until Send. */
  pending: Pending[] = [];
  uploadsHttp: Http = uploadsHttp;
  private uploadsConfig: UploadsConfig | null = null;
  private sending = false;
  private readonly main = $("main");

  constructor(readonly conn: Connection) {
    this.view = new TranscriptView($("transcript"));
  }

  handlers() {
    return {
      onFrame: (f: ServerFrame) => this.onFrame(f),
      onStatus: (s: "connecting" | "open" | "closed") => {
        this.connState = s;
        if (s === "open" && this.queueBusy) {
          this.queueBusy = false;
          this.renderQueue();
        }
        const label =
          s === "open"
            ? "Connected"
            : s === "connecting"
              ? "Connecting"
              : "Disconnected";
        $("settings-conn").textContent = label;
        if (s === "open") void this.loadUsage();
      },
    };
  }

  bind(): void {
    const form = $("composer") as HTMLFormElement;
    const jump = $("jump-bottom");
    // pointerdown default would blur the input and drop the keyboard.
    jump.addEventListener("pointerdown", (e) => e.preventDefault());
    jump.addEventListener("click", () => {
      this.main.scrollTo({ top: this.main.scrollHeight, behavior: "smooth" });
    });
    this.main.addEventListener("scroll", () => this.syncJump(), {
      passive: true,
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.send();
    });
    // Capture phase: an open overlay swallows Esc before the composer can pop the queue.
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Escape" && !e.isComposing && this.overlays.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          this.closeTop();
        } else if (e.key === "Tab") this.trapFocus(e);
        else if (this.handleShortcut(e)) e.preventDefault();
      },
      true,
    );
    this.input.addEventListener("keydown", (e) => {
      if (this.commandMenu.handleKey(e)) return;
      handleComposerKey(e, {
        send: () => void this.send(),
        popQueue: () => this.popQueue(),
      });
    });
    this.input.addEventListener("input", () => {
      this.commandMenu.update();
      this.autogrow();
      this.queueRender();
    });
    $("abort").addEventListener("click", () => void this.abort());
    const fileInput = $("file-input") as HTMLInputElement;
    const allTypes = fileInput.accept;
    $("attach").addEventListener("click", () => {
      if (!textOnly(this.model)) {
        fileInput.accept = allTypes;
        fileInput.click();
        return;
      }
      showNotice(
        `${this.model?.name ?? "This model"} can't see images`,
        "Pick a vision model in settings to attach images. PDFs, audio, video and text still work: the model gets their text and transcripts, without pictures.",
        [
          { label: "OK", primary: true },
          {
            label: "Attach other files",
            run: () => {
              fileInput.accept = allTypes
                .split(",")
                .filter((t) => t !== "image/*")
                .join(",");
              fileInput.click();
            },
          },
        ],
      );
    });
    fileInput.addEventListener("change", () => {
      this.addFiles(Array.from(fileInput.files ?? []));
      fileInput.value = "";
    });
    $("menu-button").addEventListener("click", () => this.toggleSidebar());
    $("session-title").addEventListener("click", () =>
      this.overlays.includes("sheet")
        ? this.close("sheet")
        : this.openSheet($("session-title")),
    );
    const gear = $("session-gear");
    gear.append(icon(GEAR_PATH));
    gear.addEventListener("click", () =>
      this.overlays.includes("sheet")
        ? this.close("sheet")
        : this.openSheet(gear),
    );
    const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? "Cmd" : "Ctrl";
    gear.title = `Session settings (${mod}+.)`;
    $("session-title").title = `Session settings (${mod}+.)`;
    $("settings-link").title = `Settings (${mod}+,)`;
    $("menu-button").title = `Sessions (${mod}+B)`;
    $("sheet-close").addEventListener("click", () => this.close("sheet"));
    $("scrim").addEventListener("click", () => this.closeTop());
    $("dialog-close").addEventListener("click", () => this.close("dialog"));
    $("dialog-reopen").addEventListener("click", () => this.showDialog());
    $("settings-link").addEventListener("click", () => this.openSettings());
    // Settings is reached from the sessions drawer; its menu button goes back there.
    // On desktop it is a plain close button and leaves the docked sidebar as it was.
    $("settings-back").addEventListener("click", () => {
      this.close("settings");
      if (!this.isDesktop() && !this.overlays.includes("sidebar"))
        this.toggleSidebar();
    });
    const tabs = this.settingsTabs();
    for (const tab of tabs) {
      tab.addEventListener("click", () => this.selectSettingsTab(tab.id));
      tab.addEventListener("keydown", (e) => {
        const step =
          e.key === "ArrowDown" || e.key === "ArrowRight"
            ? 1
            : e.key === "ArrowUp" || e.key === "ArrowLeft"
              ? -1
              : 0;
        if (!step) return;
        e.preventDefault();
        const i = tabs.indexOf(tab);
        const next = tabs[(i + step + tabs.length) % tabs.length];
        if (!next) return;
        this.selectSettingsTab(next.id);
        next.focus();
      });
    }
    // Crossing 900px swaps layouts in place; open overlays stay open.
    if (typeof window.matchMedia === "function")
      window
        .matchMedia("(min-width: 900px)")
        .addEventListener?.("change", () => this.onBreakpointChange());
    $("logout").addEventListener("click", () => void this.logout());
    $("reload-app").addEventListener("click", () => void reloadLatest());
    $("push-toggle").addEventListener(
      "change",
      (e) => void this.togglePush((e.target as HTMLInputElement).checked),
    );
    for (const input of $("notify-prefs").querySelectorAll<HTMLInputElement>(
      "input[data-pref]",
    )) {
      input.addEventListener("change", () => {
        const key = input.dataset.pref as keyof NotifyPrefs;
        setNotifyPref(key, input.checked).catch((e: unknown) => {
          input.checked = !input.checked;
          $("push-status").textContent =
            `Notifications: ${e instanceof Error ? e.message : String(e)}`;
        });
      });
    }
    $("budget-add").addEventListener("click", () => {
      const row = addBudgetRow($("budget-rows"));
      if (row) row.scrollIntoView({ block: "center", behavior: "smooth" });
      else
        $("budget-status").textContent = "Every provider already has a budget.";
    });
    $("budget-form").addEventListener("submit", (e) => {
      e.preventDefault();
      void this.saveBudgets();
    });
    $("budget-banner-close").addEventListener(
      "click",
      () => ($("budget-banner").hidden = true),
    );
    ($("thinking-select") as HTMLSelectElement).addEventListener(
      "change",
      (e) => {
        void this.setThinking((e.target as HTMLSelectElement).value);
      },
    );
    ($("model-filter") as HTMLInputElement).addEventListener("input", () =>
      this.renderModels(),
    );
    this.buildChips();
    ($("vendor-jump") as HTMLSelectElement).addEventListener("change", (e) =>
      this.jumpToVendor(e.target as HTMLSelectElement),
    );
    $("new-session").addEventListener("click", () => void this.newSession());
    $("abort-retry").addEventListener("click", () => void this.abortRetry());
    $("compact-now").addEventListener("click", () => void this.compactNow());
    $("autocompact-save").addEventListener(
      "click",
      () => void this.saveAutocompact(),
    );
    const threshold = $("autocompact-input") as HTMLInputElement;
    threshold.addEventListener("input", () => {
      const fromEnd =
        threshold.value.length -
        (threshold.selectionStart ?? threshold.value.length);
      threshold.value = groupDigits(threshold.value);
      const at = Math.max(0, threshold.value.length - fromEnd);
      threshold.setSelectionRange(at, at);
    });
    $("autocompact-on").addEventListener("change", (e) => {
      threshold.disabled = !(e.target as HTMLInputElement).checked;
    });
    $("settings-app-version").textContent = APP_VERSION;
    this.syncOverlays();
  }

  // ---- overlays -------------------------------------------------------

  private open(
    o: Overlay,
    focusId: string,
    explicitOpener?: HTMLElement,
  ): void {
    if (!this.overlays.includes(o)) {
      const active = document.activeElement;
      // Safari does not focus buttons on tap, so fall back to the control that opens this overlay.
      const opener = document.getElementById(
        o === "sheet"
          ? "session-title"
          : o === "dialog"
            ? "input"
            : "menu-button",
      );
      this.returnFocus.set(
        o,
        explicitOpener ??
          (active instanceof HTMLElement && active !== document.body
            ? active
            : opener),
      );
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

  /** Cmd/Ctrl+, Settings; Cmd/Ctrl+. session settings; Cmd/Ctrl+B sidebar. True when handled. */
  private handleShortcut(e: KeyboardEvent): boolean {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.isComposing)
      return false;
    // A replaced shell (tests reload it) leaves this instance's listener behind; only the live one acts.
    if (!this.input.isConnected) return false;
    if (e.key === ",") {
      if (this.overlays.includes("sheet")) this.close("sheet");
      if (!this.overlays.includes("settings")) this.openSettings();
      return true;
    }
    if (e.key === ".") {
      if (!this.conn.sessionId) return false;
      if (this.overlays.includes("settings")) this.close("settings");
      if (!this.overlays.includes("sheet")) this.openSheet($("session-gear"));
      return true;
    }
    if (e.key === "b" || e.key === "B") {
      this.toggleSidebar();
      return true;
    }
    return false;
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
    const current = document.querySelector<HTMLElement>(
      '#session-list [aria-current="true"]',
    );
    return (
      current?.id ||
      document.querySelector<HTMLElement>("#session-list button")?.id ||
      "settings-link"
    );
  }

  openSheet(opener?: HTMLElement): void {
    // Focusing the filter on iOS pops the keyboard over the list, so land on the heading.
    this.open("sheet", "sheet-title", opener);
    this.renderHeader();
    void this.loadModels();
    void this.refreshContext();
    this.mergeMode ??= new MergeModePicker(
      $("merge-mode-select") as HTMLSelectElement,
      $("merge-mode-status"),
    );
    void this.mergeMode.load(this.conn.sessionId);
  }

  openSettings(): void {
    if (this.overlays.includes("sidebar")) this.close("sidebar");
    this.renderSettings();
    void this.loadUsage(true);
    this.syncSettingsMode();
    this.open("settings", "settings-back");
  }

  private settingsTab = "settings-tab-general";

  private settingsTabs(): HTMLElement[] {
    return [
      ...document.querySelectorAll<HTMLElement>('#settings-tabs [role="tab"]'),
    ];
  }

  selectSettingsTab(id: string): void {
    this.settingsTab = id;
    this.syncSettingsMode();
  }

  /** Desktop: one tab panel at a time and an X close button. Phones: every section and the Sessions menu button. */
  syncSettingsMode(): void {
    const desktop = this.isDesktop();
    for (const tab of this.settingsTabs()) {
      const selected = tab.id === this.settingsTab;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      const panel = document.getElementById(
        tab.getAttribute("aria-controls") ?? "",
      );
      if (panel) panel.hidden = desktop && !selected;
    }
    const back = $("settings-back");
    back.setAttribute("aria-label", desktop ? "Close settings" : "Sessions");
    for (const svg of back.querySelectorAll<SVGElement>("svg[data-icon]")) {
      const show = svg.dataset.icon === (desktop ? "close" : "menu");
      if (show) svg.removeAttribute("hidden");
      else svg.setAttribute("hidden", "");
    }
  }

  /** Re-renders layout-dependent pieces after the 900px breakpoint flips, keeping the overlay stack. */
  onBreakpointChange(): void {
    this.syncSettingsMode();
    this.renderModels();
    this.syncOverlays();
    const top = this.overlays[this.overlays.length - 1];
    if (!top) return;
    const el = this.overlayElement(top);
    if (el.contains(document.activeElement)) return;
    const first = el.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? el).focus();
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
    if (!desktop)
      $("menu-button").setAttribute("aria-expanded", String(sidebarOpen));
    $("sheet").dataset.open = String(sheetOpen);
    $("session-title").setAttribute("aria-expanded", String(sheetOpen));
    $("settings").hidden = !settingsOpen;
    $("scrim").hidden = !(
      sheetOpen ||
      sidebarOpen ||
      dialogOpen ||
      (desktop && settingsOpen)
    );
    $("scrim").dataset.for = sheetOpen || dialogOpen ? "sheet" : "sidebar";
  }

  private overlayElement(o: Overlay): HTMLElement {
    return $(o);
  }

  /** Keep Tab inside the topmost overlay. */
  private trapFocus(e: KeyboardEvent): void {
    const top = this.overlays[this.overlays.length - 1];
    if (!top) return;
    const nodes = [
      ...this.overlayElement(top).querySelectorAll<HTMLElement>(FOCUSABLE),
    ];
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    if (
      e.shiftKey &&
      (active === first || !this.overlayElement(top).contains(active))
    ) {
      e.preventDefault();
      last.focus();
    } else if (
      !e.shiftKey &&
      (active === last || !this.overlayElement(top).contains(active))
    ) {
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
    if (!r.success)
      this.notice(
        "error",
        `answer not delivered: ${r.error ?? "unknown error"}`,
      );
  }

  // ---- settings -------------------------------------------------------

  renderSettings(): void {
    const s = this.sessions.find((x) => x.id === this.conn.sessionId);
    const pi = s?.piVersion ?? null;
    $("settings-pi-row").hidden = !pi;
    $("settings-pi-version").textContent = pi ?? "";
    $("settings-app-version").textContent = APP_VERSION;
    void this.syncPush();
  }

  async syncPush(): Promise<void> {
    const toggle = $("push-toggle") as HTMLInputElement;
    const st = await pushState();
    toggle.disabled = st === "unsupported" || st === "denied";
    toggle.checked = st === "on";
    $("push-status").textContent = pushHint(st);
    const prefs = $("notify-prefs");
    prefs.hidden = st !== "on";
    if (st !== "on") return;
    try {
      const p = await getNotifyPrefs();
      for (const input of prefs.querySelectorAll<HTMLInputElement>(
        "input[data-pref]",
      ))
        input.checked = p[input.dataset.pref as keyof NotifyPrefs];
    } catch {
      prefs.hidden = true;
    }
  }

  async togglePush(on: boolean): Promise<void> {
    $("push-status").textContent = on ? "Subscribing..." : "Turning off...";
    try {
      if (on) await enablePush();
      else await disablePush();
    } catch (e) {
      $("push-status").textContent = `Notifications: ${(e as Error).message}`;
      ($("push-toggle") as HTMLInputElement).checked = !on;
      return;
    }
    await this.syncPush();
  }

  /** Fetches GET /api/usage; refreshes the banner and, with `form`, the budget form. */
  async loadUsage(form = false): Promise<void> {
    let r: UsageReport;
    try {
      const res = await fetch("/api/usage", { credentials: "same-origin" });
      if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
      r = (await res.json()) as UsageReport;
    } catch (e) {
      if (form)
        $("usage-body").replaceChildren(
          document.createTextNode(`Usage unavailable: ${(e as Error).message}`),
        );
      return;
    }
    this.usage = r;
    renderUsage($("usage-body"), r);
    if (form)
      renderBudgetForm(
        $("budget-rows"),
        r.budgets,
        r.providers.map((p) => p.provider),
      );
    const b = bannerFromReport(r);
    if (b) this.showBanner(b.level, b.text);
  }

  showBanner(level: "info" | "warn" | "error", text: string): void {
    const banner = $("budget-banner");
    banner.dataset.level = level;
    $("budget-banner-text").textContent = text;
    banner.hidden = false;
  }

  async saveBudgets(): Promise<void> {
    const status = $("budget-status");
    const budgets = readBudgetForm($("budget-rows"));
    if (typeof budgets === "string") {
      status.textContent = budgets;
      return;
    }
    status.textContent = "Saving...";
    try {
      const res = await fetch("/api/budgets", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ budgets }),
      });
      const body = (await res.json()) as { error?: string };
      status.textContent = res.ok
        ? "Saved."
        : `Not saved: ${body.error ?? `HTTP ${String(res.status)}`}`;
      if (res.ok) await this.loadUsage(true);
    } catch (e) {
      status.textContent = `Not saved: ${(e as Error).message}`;
    }
  }

  async logout(): Promise<void> {
    try {
      await fetch("/api/logout", {
        method: "POST",
        credentials: "same-origin",
      });
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
        this.sessionsLoaded = true;
        if (
          this.pendingOpen &&
          f.sessions.some((s) => s.id === this.pendingOpen)
        ) {
          this.attach(this.pendingOpen);
          this.pendingOpen = null;
        } else if (
          !this.conn.sessionId &&
          f.sessions.length === 1 &&
          f.sessions[0]
        )
          this.attach(f.sessions[0].id);
        else if (
          this.conn.sessionId &&
          !f.sessions.some((s) => s.id === this.conn.sessionId)
        )
          this.sessionGone();
        this.renderSessions();
        return;
      case "attached":
        void this.refreshState();
        void this.loadCommands();
        return;
      case "reset":
        void this.rebuild();
        return;
      case "event":
        if (this.statusPanel.apply(f.event)) this.renderStatusPanel();
        if (f.event.type === "queue_update") {
          this.queue = parseQueue(f.event);
          this.renderQueue();
        }
        if (this.resetting) this.resetBuffer.push(f.event);
        else {
          applyEvent(this.t, f.event);
          if (this.dialogs.apply(f.event)) this.syncDialog();
          if (f.event.type === "agent_end" || f.event.type === "compaction_end")
            void this.refreshContext();
          if (f.event.type === "agent_settled") void this.loadCommands();
          this.applyRetry(f.event);
          if (f.event.type === "compaction_start") {
            this.compacting = true;
            this.renderContext();
          }
          if (f.event.type === "compaction_end") {
            this.compacting = false;
            this.renderContext();
            void this.flushHeld();
          }
          if (
            f.event.type === "thinking_level_changed" &&
            typeof f.event.level === "string"
          ) {
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
      case "notice":
        this.notice(f.level, f.text);
        this.showBanner(f.level, f.text);
        return;
      default:
        return;
    }
  }

  attach(id: string): void {
    if (id !== this.conn.sessionId) {
      this.dialogs.clear();
      this.syncDialog();
      this.statusPanel.clear();
      this.renderStatusPanel();
      this.queue = emptyQueue();
      this.held = [];
      this.renderQueue();
      this.t = emptyTranscript();
      this.view.clear();
      this.model = null;
      this.context = null;
      this.sessionUsage = null;
      this.compacting = false;
      this.renderContext();
      this.commandMenu.setCommands([]);
      $("retry-banner").hidden = true;
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
    const t =
      r.success && isRec(r.data)
        ? fromMessages(r.data.messages)
        : emptyTranscript();
    const buffered = this.resetBuffer;
    this.resetting = false;
    this.resetBuffer = [];
    for (const ev of buffered) applyEvent(t, ev);
    this.t = t;
    this.view.clear();
    if (!r.success)
      this.notice(
        "error",
        `could not load history: ${r.error ?? "unknown error"}`,
      );
    void this.refreshState();
    this.queueRender();
  }

  async refreshState(): Promise<void> {
    const r = await this.conn.command({ type: "get_state" });
    if (!r.success || !isRec(r.data)) return;
    const d = r.data;
    if ("model" in d) this.model = parseModel(d.model);
    if (typeof d.thinkingLevel === "string")
      this.thinkingLevel = d.thinkingLevel;
    if (typeof d.isStreaming === "boolean") this.t.isStreaming = d.isStreaming;
    if (typeof d.isCompacting === "boolean") this.compacting = d.isCompacting;
    this.renderHeader();
    void this.refreshContext();
    this.renderAttachments();
    this.queueRender();
  }

  // ---- commands -------------------------------------------------------

  // ---- attachments ----------------------------------------------------

  addFiles(files: File[]): void {
    for (const file of files) {
      if (this.pending.length >= MAX_ATTACHMENTS) {
        this.notice(
          "warn",
          `at most ${MAX_ATTACHMENTS} attachments per message; ${file.name} not added`,
        );
        continue;
      }
      this.pending.push({ file, kind: classify(file) });
    }
    this.renderAttachments();
    if (!this.uploadsConfig) void this.loadUploadsConfig();
    // Upload right away so Send only has to wait for the cost step.
    const sid = this.conn.sessionId;
    const max = this.uploadsConfig?.maxBytes ?? DEFAULT_MAX_BYTES;
    if (sid === null) return;
    for (const p of this.pending) {
      if (p.file.size <= max)
        void startUpload(p, sid, this.uploadsHttp, () =>
          this.renderAttachments(),
        ).catch(() => undefined);
    }
  }

  removeAttachment(i: number): void {
    this.pending.splice(i, 1);
    this.renderAttachments();
  }

  private async loadUploadsConfig(): Promise<UploadsConfig | null> {
    try {
      this.uploadsConfig = await this.uploadsHttp.getConfig();
    } catch (e) {
      this.notice("error", `attachments: ${(e as Error).message}`);
      return null;
    }
    this.renderAttachments();
    return this.uploadsConfig;
  }

  renderAttachments(): void {
    if (
      !this.sending &&
      textOnly(this.model) &&
      this.pending.some((p) => p.kind === "image")
    ) {
      const n = this.pending.length;
      this.pending = [];
      showNotice(
        `${this.model?.name ?? "This model"} can't see images`,
        `Removed ${n === 1 ? "the attachment" : `all ${n} attachments`}. Pick a vision model in settings, then attach again.`,
      );
    }
    const cfg = this.uploadsConfig;
    for (const p of this.pending) {
      p.warn = chipWarning(
        p.kind,
        p.file.size,
        cfg?.maxBytes ?? DEFAULT_MAX_BYTES,
        cfg?.whisper ?? true,
      );
    }
    renderChips(
      $("attachments"),
      this.pending,
      (i) => this.removeAttachment(i),
      this.sending,
    );
    ($("attach") as HTMLButtonElement).disabled =
      this.sending || this.conn.sessionId === null;
    ($("send") as HTMLButtonElement).disabled = this.sending;
    this.queueRender();
  }

  private attachStatus(text: string): void {
    const el = $("attach-status");
    el.textContent = text;
    el.hidden = text === "";
  }

  private async sendAttachments(
    text: string,
    sid: string,
  ): Promise<string | null> {
    const cfg = this.uploadsConfig ?? (await this.loadUploadsConfig());
    if (!cfg) return null;
    const tooBig = this.pending.find((p) => p.file.size > cfg.maxBytes);
    if (tooBig) {
      this.notice("error", `${tooBig.file.name} is too large`);
      return null;
    }
    this.sending = true;
    this.renderAttachments();
    try {
      return await sendWithAttachments({
        session: sid,
        message: text,
        pending: this.pending,
        model: this.model,
        http: this.uploadsHttp,
        config: cfg,
        rerender: () => this.renderAttachments(),
        status: (t) => this.attachStatus(t),
        confirm: (b) => renderConfirm($("attach-confirm"), b),
      });
    } catch (e) {
      this.notice("error", `attachments: ${(e as Error).message}`);
      return null;
    } finally {
      this.sending = false;
      this.attachStatus("");
      this.renderAttachments();
    }
  }

  async send(): Promise<void> {
    if (this.sending) return;
    let text = this.input.value;
    const sid = this.conn.sessionId;
    if (!sid) return;
    const withFiles = this.pending.length > 0;
    if (!text.trim() && !withFiles) return;
    if (withFiles) {
      const full = await this.sendAttachments(text, sid);
      if (full === null || this.conn.sessionId !== sid) return;
      text = full;
    }
    if (this.compacting) {
      this.held.push(text);
      this.input.value = "";
      this.autogrow();
      if (withFiles) {
        this.pending = [];
        this.renderAttachments();
      }
      this.renderQueue();
      this.queueRender();
      return;
    }
    const cmd = buildPrompt(text, this.t.isStreaming, "followUp");
    const typed = this.input.value;
    this.input.value = "";
    this.autogrow();
    const r = await this.conn.command(cmd);
    if (r.success && withFiles) {
      this.pending = [];
      this.renderAttachments();
    }
    if (!r.success) {
      if (!this.input.value) this.input.value = typed;
      this.notice("error", `prompt rejected: ${r.error ?? "unknown error"}`);
      void this.refreshState();
    }
  }

  /** Polls get_session_stats and get_state for the context meter. */
  async refreshContext(): Promise<void> {
    const sid = this.conn.sessionId;
    if (!sid) {
      this.context = null;
      this.renderContext();
      return;
    }
    const [stats, state] = await Promise.all([
      this.conn.command({ type: "get_session_stats" }),
      this.conn.command({ type: "get_state" }),
    ]);
    if (this.conn.sessionId !== sid) return;
    this.context = stats.success ? parseContextUsage(stats.data) : null;
    this.sessionUsage = stats.success ? parseSessionUsage(stats.data) : null;
    if (
      state.success &&
      isRec(state.data) &&
      typeof state.data.isCompacting === "boolean"
    )
      this.compacting = state.data.isCompacting;
    this.renderContext();
    if (!this.compacting) void this.flushHeld();
  }

  /**
   * Sends held prompts in order once compaction is over: followUp while streaming, else the first as a
   * plain prompt. A compaction rejection keeps the rest held for the next compaction end; any other
   * rejection puts the unsent texts back into the composer.
   */
  async flushHeld(): Promise<void> {
    if (
      this.flushing ||
      this.compacting ||
      this.held.length === 0 ||
      !this.conn.sessionId
    )
      return;
    this.flushing = true;
    let started = false;
    try {
      while (this.held.length > 0 && !this.compacting) {
        const text = this.held[0] as string;
        const r = await this.conn.command(
          buildPrompt(text, started || this.t.isStreaming, "followUp"),
        );
        if (!r.success) {
          if (/compaction/i.test(r.error ?? "")) {
            this.compacting = true;
            this.renderContext();
          } else {
            this.input.value = restoreText(
              { steering: [], followUp: this.held },
              this.input.value,
            );
            this.held = [];
            this.autogrow();
            this.notice(
              "error",
              `prompt rejected: ${r.error ?? "unknown error"}`,
            );
          }
          break;
        }
        this.held.shift();
        // The first plain prompt starts a turn; the rest queue behind it.
        started = true;
        this.renderQueue();
      }
    } finally {
      this.flushing = false;
      this.renderQueue();
      this.queueRender();
    }
  }

  renderContext(): void {
    const c = this.context;
    const pctUsed = Math.min(100, Math.max(0, c?.percent ?? 0));
    const meter = $("context-meter");
    meter.setAttribute("aria-valuenow", String(Math.round(pctUsed)));
    meter.dataset.level = pctUsed >= 80 ? "high" : "ok";
    (meter.firstElementChild as HTMLElement).style.width = `${pctUsed}%`;
    $("context-text").textContent = this.compacting
      ? `${contextText(c)} (compacting)`
      : contextText(c);
    const attached = this.conn.sessionId !== null;
    const u = this.sessionUsage;
    $("session-usage").textContent = sessionUsageText(u);
    const cost = $("session-cost");
    cost.textContent = u ? formatUsd(u.cost) : "";
    cost.title = u ? `Session cost: ${sessionUsageText(u)}` : "";
    cost.hidden = !u || !attached || u.cost === 0;
    ($("compact-now") as HTMLButtonElement).disabled =
      !attached || this.compacting;
    ($("autocompact-save") as HTMLButtonElement).disabled = !attached;
    ($("autocompact-input") as HTMLInputElement).placeholder = groupDigits(
      String(defaultThreshold(this.model?.contextWindow)),
    );
  }

  // ---- slash commands, retry -------------------------------

  async loadCommands(): Promise<void> {
    const sid = this.conn.sessionId;
    if (!sid) return;
    const r = await this.conn.command({ type: "get_commands" });
    if (this.conn.sessionId !== sid || !r.success) return;
    this.commandMenu.setCommands(parseCommands(r.data));
  }

  applyRetry(ev: Record<string, unknown>): void {
    const banner = $("retry-banner");
    if (ev.type === "auto_retry_start") {
      $("retry-banner-text").textContent =
        `Retrying (${String(ev.attempt)}/${String(ev.maxAttempts)})`;
      banner.hidden = false;
    } else if (
      ev.type === "auto_retry_end" ||
      ev.type === "agent_end" ||
      ev.type === "agent_settled"
    )
      banner.hidden = true;
  }

  async abortRetry(): Promise<void> {
    if (!this.conn.sessionId) return;
    const r = await this.conn.command({ type: "abort_retry" });
    if (r.success) $("retry-banner").hidden = true;
    else this.notice("error", `stop retrying: ${r.error ?? "failed"}`);
  }

  async compactNow(): Promise<void> {
    if (!this.conn.sessionId || this.compacting) return;
    this.compacting = true;
    this.renderContext();
    const r = await this.conn.command({ type: "compact" });
    this.compacting = false;
    if (!r.success) this.notice("error", `compact: ${r.error ?? "failed"}`);
    void this.refreshContext();
  }

  async saveAutocompact(): Promise<void> {
    if (!this.conn.sessionId) return;
    const msg = autocompactCommand(
      ($("autocompact-input") as HTMLInputElement).value,
      !($("autocompact-on") as HTMLInputElement).checked,
    );
    if (msg === null) {
      this.notice(
        "error",
        "auto-compact: enter a positive whole number of tokens",
      );
      return;
    }
    const r = await this.conn.command(
      buildPrompt(msg, this.t.isStreaming, "followUp"),
    );
    if (!r.success)
      this.notice("error", `auto-compact: ${r.error ?? "failed"}`);
  }

  async abort(): Promise<void> {
    if (!this.conn.sessionId) return;
    // pi's abort leaves the queue intact; clear it first so stale items do not ride along with the next prompt.
    const cleared = await this.conn.command({ type: "clear_queue" });
    const r = await this.conn.command({ type: "abort" });
    if (!r.success)
      this.notice("error", `abort failed: ${r.error ?? "unknown error"}`);
    const held = this.held;
    this.held = [];
    this.renderQueue();
    if (cleared.success || held.length) {
      const q = cleared.success
        ? parseQueue((cleared.data ?? {}) as Record<string, unknown>)
        : emptyQueue();
      this.input.value = restoreText(
        { steering: q.steering, followUp: [...q.followUp, ...held] },
        this.input.value,
      );
      this.autogrow();
      this.queueRender();
      this.input.focus();
    }
  }

  async setThinking(level: string): Promise<void> {
    const r = await this.conn.command({ type: "set_thinking_level", level });
    if (r.success) this.thinkingLevel = level;
    else this.notice("error", `thinking level: ${r.error ?? "failed"}`);
    this.renderHeader();
  }

  async setModel(m: ModelInfo): Promise<void> {
    const r = await this.conn.command({
      type: "set_model",
      provider: m.provider,
      modelId: m.id,
    });
    if (r.success) {
      this.model = parseModel(r.data) ?? m;
      pushRecent(
        recentStorage(),
        recentKey(this.model),
        this.models,
        this.model.provider,
      );
    } else this.notice("error", `set model: ${r.error ?? "failed"}`);
    this.renderHeader();
    this.renderAttachments();
    this.renderModels();
  }

  async newSession(): Promise<void> {
    if (!this.conn.sessionId) return;
    if (
      !window.confirm(
        "Start a new conversation in this pi process? The current one stays in its session file.",
      )
    )
      return;
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
        this.models = r.data.models
          .map(parseModel)
          .filter((m): m is ModelInfo => m !== null);
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
    const status = $("model-state");
    const recent = $("model-recent");
    const groups = $("model-groups");
    const state = sheetState({
      attached: this.conn.sessionId !== null,
      loading: this.modelsLoading,
      error: this.modelsError,
      models: this.models,
    });
    const q = ($("model-filter") as HTMLInputElement).value.trim();
    const filtering = q !== "" || this.caps.size > 0;
    const shown =
      state === "ready" ? filterModels(this.models, q, this.caps) : [];
    const noMatches = state === "ready" && shown.length === 0;
    status.hidden = state === "ready" && !noMatches;
    status.dataset.state = noMatches ? "no-matches" : state;
    if (state === "error")
      status.textContent = `Could not load models: ${this.modelsError ?? "failed"}`;
    else if (state !== "ready") status.textContent = SHEET_MESSAGES[state];
    else
      status.textContent = noMatches
        ? this.caps.size > 0
          ? "No models match these filters"
          : "No matches"
        : "";

    const recentModels =
      filtering || state !== "ready"
        ? []
        : resolveRecent(
            loadRecent(recentStorage()),
            this.models,
            this.model?.provider,
          );
    recent.hidden = recentModels.length === 0;
    $("model-recent-list").replaceChildren(
      ...recentModels.map((m) => this.modelOption(m)),
    );

    const currentVendor = this.model
      ? vendorOf(this.model.id, this.model.provider)
      : null;
    const grouped = groupByVendor(shown);
    const jump = $("vendor-jump") as HTMLSelectElement;
    if (this.isDesktop()) {
      recent.hidden = true;
      jump.replaceChildren();
      jump.hidden = true;
      this.renderVendorRail(groups, grouped, recentModels, currentVendor);
      return;
    }
    groups.classList.remove("model-rail-layout");
    groups.replaceChildren(
      ...grouped.map((g) => {
        const details = document.createElement("details");
        details.className = "model-group";
        details.dataset.vendor = g.vendor;
        details.open = filtering || g.vendor === currentVendor;
        const summary = document.createElement("summary");
        summary.append(g.vendor);
        const count = document.createElement("span");
        count.className = "model-group-count";
        count.textContent = `(${g.count})`;
        summary.append(count);
        const ul = document.createElement("ul");
        ul.className = "model-list";
        ul.setAttribute("role", "listbox");
        ul.setAttribute("aria-label", g.vendor);
        ul.append(...g.models.map((m) => this.modelOption(m)));
        details.append(summary, ul);
        return details;
      }),
    );

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Jump to vendor";
    jump.replaceChildren(
      placeholder,
      ...grouped.map((g) => {
        const o = document.createElement("option");
        o.value = g.vendor;
        o.textContent = `${g.vendor} (${g.count})`;
        return o;
      }),
    );
    jump.value = "";
    jump.hidden = grouped.length < 2;
  }

  /** Desktop picker: a vendor rail (Recently used first) beside the selected vendor's models. */
  private renderVendorRail(
    groups: HTMLElement,
    grouped: ReturnType<typeof groupByVendor>,
    recentModels: ModelInfo[],
    currentVendor: string | null,
  ): void {
    const entries: { key: string; label: string; models: ModelInfo[] }[] = [];
    if (recentModels.length > 0)
      entries.push({
        key: RECENT_RAIL_KEY,
        label: "Recently used",
        models: recentModels,
      });
    for (const g of grouped)
      entries.push({
        key: g.vendor,
        label: `${g.vendor} (${g.count})`,
        models: g.models,
      });
    groups.classList.toggle("model-rail-layout", entries.length > 0);
    if (entries.length === 0) {
      groups.replaceChildren();
      return;
    }
    const has = (k: string | null) =>
      k !== null && entries.some((e) => e.key === k);
    if (!has(this.railVendor))
      this.railVendor = has(currentVendor)
        ? currentVendor
        : (grouped[0]?.vendor ?? entries[0]!.key);
    const selected = entries.find((e) => e.key === this.railVendor)!;

    const rail = document.createElement("div");
    rail.className = "vendor-rail";
    rail.setAttribute("role", "tablist");
    rail.setAttribute("aria-label", "Vendors");
    rail.setAttribute("aria-orientation", "vertical");
    const tabs = entries.map((e) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "vendor-tab";
      b.setAttribute("role", "tab");
      b.dataset.vendor = e.key;
      b.id = `vendor-tab-${e.key}`;
      b.setAttribute("aria-controls", "vendor-pane");
      const on = e === selected;
      b.setAttribute("aria-selected", on ? "true" : "false");
      b.tabIndex = on ? 0 : -1;
      b.textContent = e.label;
      b.addEventListener("click", () => {
        this.railVendor = e.key;
        this.renderModels();
        groups
          .querySelector<HTMLButtonElement>(
            `.vendor-tab[data-vendor="${CSS.escape(e.key)}"]`,
          )
          ?.focus();
      });
      return b;
    });
    rail.addEventListener("keydown", (ev) => {
      const i = tabs.indexOf(document.activeElement as HTMLButtonElement);
      if (i < 0) return;
      const next =
        ev.key === "ArrowDown"
          ? tabs[(i + 1) % tabs.length]
          : ev.key === "ArrowUp"
            ? tabs[(i - 1 + tabs.length) % tabs.length]
            : undefined;
      if (!next) return;
      ev.preventDefault();
      next.click();
    });
    rail.append(...tabs);

    const pane = document.createElement("div");
    pane.className = "vendor-pane";
    pane.id = "vendor-pane";
    pane.setAttribute("role", "tabpanel");
    pane.setAttribute("aria-labelledby", `vendor-tab-${selected.key}`);
    const ul = document.createElement("ul");
    ul.className = "model-list";
    ul.setAttribute("role", "listbox");
    ul.setAttribute("aria-label", selected.label);
    ul.append(...selected.models.map((m) => this.modelOption(m)));
    pane.append(ul);
    groups.replaceChildren(rail, pane);
  }

  private buildChips(): void {
    const titles: Record<Capability, { label: string; title: string }> = {
      thinking: { label: "Thinking", title: "Supports extended thinking" },
      images: { label: "Images", title: "Accepts image input" },
      long: {
        label: `${LONG_CONTEXT_MIN / 1000}K+`,
        title: `Context window of ${LONG_CONTEXT_MIN.toLocaleString("en-US")} tokens or more`,
      },
      cheap: {
        label: "Cheap",
        title: `Input $${CHEAP_INPUT_MAX.toFixed(2)} per million tokens or less`,
      },
    };
    $("model-chips").replaceChildren(
      ...CAPABILITIES.map(({ key }) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "filter-chip";
        b.dataset.cap = key;
        b.textContent = titles[key].label;
        b.title = titles[key].title;
        b.setAttribute("aria-pressed", this.caps.has(key) ? "true" : "false");
        b.addEventListener("click", () => {
          if (this.caps.has(key)) this.caps.delete(key);
          else this.caps.add(key);
          b.setAttribute("aria-pressed", this.caps.has(key) ? "true" : "false");
          this.renderModels();
        });
        return b;
      }),
    );
  }

  private jumpToVendor(select: HTMLSelectElement): void {
    const vendor = select.value;
    select.value = "";
    if (!vendor) return;
    const details = [
      ...$("model-groups").querySelectorAll<HTMLDetailsElement>(
        "details.model-group",
      ),
    ].find((d) => d.dataset.vendor === vendor);
    if (!details) return;
    details.open = true;
    const browser = details.closest<HTMLElement>(".model-browser");
    if (browser) browser.scrollTop = details.offsetTop - browser.offsetTop;
    details.querySelector("summary")?.focus();
  }

  private modelOption(m: ModelInfo): HTMLLIElement {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.className = "model-option";
    b.setAttribute("role", "option");
    const current =
      this.model !== null &&
      this.model.id === m.id &&
      this.model.provider === m.provider;
    b.setAttribute("aria-selected", current ? "true" : "false");
    const name = document.createElement("span");
    name.className = "model-option-name";
    name.textContent = m.name ?? m.id;
    b.append(name);
    const detail = rowDetail(m);
    if (detail) {
      const d = document.createElement("span");
      d.className = "model-option-detail";
      d.textContent = detail;
      b.append(d);
    }
    b.addEventListener("click", () => void this.setModel(m));
    li.append(b);
    return li;
  }

  renderModelCard(): void {
    const card = $("model-card");
    const m = this.model;
    card.dataset.empty = m ? "false" : "true";
    const name = document.createElement("p");
    name.className = "model-card-name";
    if (!m) {
      name.textContent = "No model selected";
      card.replaceChildren(name);
      return;
    }
    name.textContent = m.name ?? m.id;
    const vendor = document.createElement("p");
    vendor.className = "model-card-vendor";
    vendor.textContent = vendorOf(m.id, m.provider);
    card.replaceChildren(name, vendor);
    const detail = rowDetail(m);
    if (detail) {
      const d = document.createElement("p");
      d.className = "model-card-detail";
      d.textContent = detail;
      card.append(d);
    }
  }

  queueItems(): QueueItem[] {
    return itemsFromQueue(this.queue, this.held);
  }

  renderQueue(): void {
    const disabled =
      this.queueBusy ||
      this.conn.sessionId === null ||
      this.connState === "closed";
    renderQueueChips(
      $("queue-chips"),
      this.queueItems(),
      {
        edit: (i) => void this.queueAction(i, "edit"),
        cancel: (i) => void this.queueAction(i, "cancel"),
        sendNow: (i) => void this.queueAction(i, "sendNow"),
      },
      disabled,
    );
  }

  /** Esc: pops the last queued item into the composer. Returns false when nothing is queued. */
  popQueue(): boolean {
    const items = this.queueItems();
    if (items.length === 0) return false;
    if (!this.queueBusy || items[items.length - 1]?.pending)
      void this.queueAction(items.length - 1, "edit");
    return true;
  }

  async queueAction(
    i: number,
    op: "edit" | "cancel" | "sendNow",
  ): Promise<void> {
    const items = this.queueItems();
    if (items[i]?.pending) {
      const h = i - (items.length - this.held.length);
      const [text] = this.held.splice(h, 1);
      this.renderQueue();
      if (text !== undefined && op === "edit") this.prependDraft(text);
      return;
    }
    if (this.queueBusy || !this.conn.sessionId) return;
    const target = targetAt(items, i);
    if (!target) return;
    const removed = await this.rewriteQueue(target, op === "sendNow");
    if (removed !== null && op === "edit") this.prependDraft(removed);
  }

  private prependDraft(text: string): void {
    this.input.value = [text, this.input.value]
      .filter((s) => s.trim() !== "")
      .join("\n\n");
    this.autogrow();
    this.queueRender();
    this.input.focus();
  }

  /**
   * clear_queue, then re-adds the cleared items in order (steer / follow_up, one at a time) minus the
   * target, or with it promoted to a leading steer. Works from the cleared response, not local chips,
   * so items another device added survive. Chips re-render from pi's queue_update events.
   * Returns the removed text, or null when nothing was removed.
   */
  async rewriteQueue(
    target: QueueTarget,
    promote = false,
  ): Promise<string | null> {
    this.queueBusy = true;
    this.renderQueue();
    try {
      const cleared = await this.conn.command({ type: "clear_queue" });
      if (!cleared.success) {
        this.notice("error", `queue: ${cleared.error ?? "clear failed"}`);
        return null;
      }
      const plan = planRewrite(
        parseQueue(isRec(cleared.data) ? cleared.data : {}),
        target,
        promote,
      );
      if (plan.removed === null)
        this.notice("warn", "Queue changed, try again");
      for (let k = 0; k < plan.next.length; k++) {
        const item = plan.next[k] as QueueItem;
        const r = await this.conn.command(
          item.kind === "steer"
            ? { type: "steer", message: item.text }
            : { type: "follow_up", message: item.text },
        );
        if (!r.success) {
          const rest = plan.next.slice(k);
          const lost = {
            steering: rest.filter((x) => x.kind === "steer").map((x) => x.text),
            followUp: rest
              .filter((x) => x.kind === "followUp")
              .map((x) => x.text),
          };
          this.input.value = restoreText(lost, this.input.value);
          this.autogrow();
          this.notice("error", `queue: ${r.error ?? "requeue failed"}`);
          break;
        }
      }
      return plan.removed;
    } finally {
      this.queueBusy = false;
      this.renderQueue();
      this.queueRender();
    }
  }

  renderStatusPanel(): void {
    this.statusPanel.render($("status-panel"));
    this.renderHeader();
  }

  renderHeader(): void {
    this.renderModelCard();
    const thinking = $("thinking-select") as HTMLSelectElement;
    const noReasoning = this.model?.reasoning === false;
    thinking.disabled = noReasoning;
    thinking.value = noReasoning ? "off" : this.thinkingLevel;
    const s = this.sessions.find((x) => x.id === this.conn.sessionId);
    const title = $("session-title");
    const name = s ? (this.statusPanel.title ?? s.name) : "Porcupine";
    title.textContent = name;
    title.title = s ? name : "";
    title.setAttribute(
      "aria-label",
      s ? `Session settings for ${s.name}` : "Session settings",
    );
    $("session-card-name").textContent = s ? s.name : "No session";
    const cwd = $("session-card-cwd");
    cwd.textContent = s ? s.cwd : "";
    cwd.hidden = !s;
    const attached = this.conn.sessionId !== null;
    ($("new-session") as HTMLButtonElement).disabled = !attached;
    ($("attach") as HTMLButtonElement).disabled = this.sending || !attached;
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
        if (s.id === this.conn.sessionId)
          b.setAttribute("aria-current", "true");
        const name = document.createElement("span");
        name.className = "session-name";
        name.textContent = s.name;
        if (s.needsInput) {
          const q = document.createElement("span");
          q.className = "session-badge session-needs-input";
          q.textContent = "?";
          q.setAttribute("role", "img");
          q.setAttribute("aria-label", "needs input");
          name.append(q);
        } else if (s.unread && !s.isStreaming && s.id !== this.conn.sessionId) {
          const u = document.createElement("span");
          u.className = "session-unread";
          u.setAttribute("role", "img");
          u.setAttribute("aria-label", "unread");
          name.append(u);
        }
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
    $("session-empty").hidden =
      !this.sessionsLoaded || this.sessions.length > 0;
    this.syncEmpty();
    this.renderHeader();
    if (!$("settings").hidden) this.renderSettings();
  }

  private queueRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    const raf =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : (fn: () => void) => setTimeout(fn, 16);
    raf(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  private syncEmpty(): void {
    $("empty").hidden = !this.sessionsLoaded || this.conn.sessionId !== null;
  }

  /** Shows the jump button whenever the thread is scrolled up from the bottom. */
  syncJump(): void {
    const gap =
      this.main.scrollHeight - this.main.scrollTop - this.main.clientHeight;
    $("jump-bottom").hidden = gap < 80;
  }

  render(): void {
    const nearBottom =
      this.main.scrollHeight - this.main.scrollTop - this.main.clientHeight <
      120;
    this.view.render(this.t);
    const streaming = this.t.isStreaming;
    // While streaming, Stop shows only for an empty composer; anything typed or staged turns it into Send.
    const showStop =
      streaming && !this.input.value.trim() && this.pending.length === 0;
    $("abort").hidden = !showStop;
    $("send").hidden = showStop;
    $("run-status").textContent = streaming ? "Running" : "Idle";
    document.body.classList.toggle("is-streaming", streaming);
    this.syncEmpty();
    if (nearBottom) this.main.scrollTop = this.main.scrollHeight;
    this.syncJump();
  }
}

/**
 * iOS Safari ignores interactive-widget=resizes-content: the keyboard overlays
 * the layout and pans the page, pushing the header off screen. Size the layout
 * to the visual viewport and undo the pan so the header and composer stay put.
 */
function pinToVisualViewport(): void {
  const vv = window.visualViewport;
  if (!vv) return;
  // Only while a text field has focus (the keyboard is up): an installed iOS
  // PWA reports a visual viewport shorter than the screen, which left a gap
  // under the composer when pinned all the time.
  const sync = (): void => {
    const el = document.activeElement;
    const typing =
      el instanceof HTMLTextAreaElement ||
      (el instanceof HTMLInputElement &&
        el.type !== "checkbox" &&
        el.type !== "radio");
    const root = document.documentElement.style;
    if (typing) {
      root.setProperty("--app-height", `${vv.height}px`);
      // Bottom sheets are fixed to the layout viewport, which the keyboard covers; lift them above it.
      root.setProperty(
        "--kb-inset",
        `${Math.max(0, window.innerHeight - vv.height - vv.offsetTop)}px`,
      );
    } else {
      root.removeProperty("--app-height");
      root.removeProperty("--kb-inset");
    }
    if (window.scrollY !== 0) window.scrollTo(0, 0);
    // Settings scroll internally; keep the focused field above the keyboard.
    // Desktop modals have no on-screen keyboard to dodge.
    const desktop = window.matchMedia?.("(min-width: 900px)").matches ?? false;
    if (typing && !desktop && el.closest(".settings, .sheet"))
      el.scrollIntoView({ block: "center" });
  };
  vv.addEventListener("resize", sync);
  vv.addEventListener("scroll", sync);
  document.addEventListener("focusin", sync);
  document.addEventListener("focusout", () => setTimeout(sync, 0));
  sync();
}

/** Drops the service worker and its cache so the next load fetches the newest build. */
export async function reloadLatest(): Promise<void> {
  try {
    const regs = (await navigator.serviceWorker?.getRegistrations()) ?? [];
    await Promise.all(regs.map((r) => r.unregister()));
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  } finally {
    location.reload();
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
  if (stylesMissing()) return;
  app = new App(conn);
  app.bind();
  pinToVisualViewport();
  app.pendingOpen = new URLSearchParams(location.search).get("session");
  if (app.pendingOpen) history.replaceState(null, "", "/");
  document.addEventListener("visibilitychange", () => {
    const visible = document.visibilityState === "visible";
    conn.setVisible(visible);
    if (visible) conn.kick();
  });
  if (document.visibilityState === "hidden") conn.setVisible(false);
  navigator.serviceWorker?.addEventListener(
    "message",
    (e: MessageEvent<unknown>) => {
      const d = e.data as { type?: unknown; session?: unknown } | null;
      if (d?.type === "open-session" && typeof d.session === "string") {
        if (app.sessions.some((s) => s.id === d.session))
          app.selectSession(d.session);
        else app.pendingOpen = d.session;
      }
    },
  );
  window.addEventListener("online", () => conn.kick());
  conn.connect();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }
}

if (typeof document !== "undefined" && document.getElementById("app")) start();

function recentStorage(): RecentStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * A PWA has no reload control, so a page whose stylesheet failed to load (an
 * old shell, a deploy mid-flight) reloads itself, at most once a minute.
 */
function stylesMissing(): boolean {
  if (
    getComputedStyle(document.documentElement)
      .getPropertyValue("--bg")
      .trim() !== ""
  )
    return false;
  try {
    const last = Number(
      sessionStorage.getItem("porcupine-style-reload") ?? "0",
    );
    if (Date.now() - last < 60_000) return false;
    sessionStorage.setItem("porcupine-style-reload", String(Date.now()));
  } catch {
    return false;
  }
  void reloadLatest();
  return true;
}
