// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "../src/theme-init.js"), "utf8");
const loginHtml = readFileSync(join(here, "../src/login.html"), "utf8");

function run(): void {
  new Function(source)();
}

function button(): HTMLButtonElement {
  const b = document.querySelector<HTMLButtonElement>("button.theme-toggle");
  if (!b) throw new Error("no toggle");
  return b;
}

function visibleIcon(): string | null {
  return button().querySelector("[data-icon]:not([hidden])")?.getAttribute("data-icon") ?? null;
}

function metas(): string[] {
  return [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.getAttribute("content") ?? "");
}

beforeEach(() => {
  delete document.documentElement.dataset.theme;
  sessionStorage.clear();
  document.head.innerHTML = /<head>([\s\S]*)<\/head>/.exec(loginHtml)?.[1]?.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<link[^>]*>/g, "") ?? "";
  document.body.innerHTML = (/<body>([\s\S]*)<\/body>/.exec(loginHtml)?.[1] ?? "");
  vi.spyOn(window, "matchMedia").mockImplementation((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);
});

afterEach(() => vi.restoreAllMocks());

describe("theme-init", () => {
  it("applies a stored choice", () => {
    sessionStorage.setItem("porcupine-theme", "dark");
    run();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(button().getAttribute("aria-label")).toBe("Switch to light theme");
    expect(visibleIcon()).toBe("sun");
  });

  it("leaves dataset empty with no stored choice", () => {
    run();
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(button().getAttribute("aria-label")).toBe("Switch to dark theme");
    expect(visibleIcon()).toBe("moon");
  });

  it("toggle flips, saves, updates label, icon and theme-color metas", () => {
    run();
    button().click();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(sessionStorage.getItem("porcupine-theme")).toBe("dark");
    expect(button().getAttribute("aria-label")).toBe("Switch to light theme");
    expect(visibleIcon()).toBe("sun");
    expect(metas()).toEqual(["#24122a", "#24122a"]);
    button().click();
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(sessionStorage.getItem("porcupine-theme")).toBe("light");
    expect(button().getAttribute("aria-label")).toBe("Switch to dark theme");
    expect(metas()).toEqual(["#f6efe0", "#f6efe0"]);
  });

  it("follows the system theme when nothing is stored", () => {
    vi.spyOn(window, "matchMedia").mockImplementation((q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);
    run();
    expect(button().getAttribute("aria-label")).toBe("Switch to light theme");
    button().click();
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("tolerates storage that throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(run).not.toThrow();
    expect(document.documentElement.dataset.theme).toBeUndefined();
    button().click();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(button().getAttribute("aria-label")).toBe("Switch to light theme");
  });
});
