// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderMarkdown, replaceLatexSymbols } from "../src/markdown.js";

describe("markdown", () => {
  let root: HTMLElement;
  beforeEach(() => {
    root = document.createElement("div");
  });
  const render = (md: string): HTMLElement => {
    root.replaceChildren(renderMarkdown(md));
    return root;
  };

  it("renders bold, italics, strike and inline code", () => {
    render("**Goal:** a *b* ~~c~~ `**x**`");
    expect(root.querySelector("strong")?.textContent).toBe("Goal:");
    expect(root.querySelector("em")?.textContent).toBe("b");
    expect(root.querySelector("del")?.textContent).toBe("c");
    expect(root.querySelector("code")?.textContent).toBe("**x**");
  });

  it("renders lists, headings, quotes and fences", () => {
    render("## Plan\n1. one\n2. two\n\n- a\n- b\n\n> quoted\n\n```sh\necho <b>\n```");
    expect(root.querySelector("h4")?.textContent).toBe("Plan");
    expect(root.querySelectorAll("ol li")).toHaveLength(2);
    expect(root.querySelectorAll("ul li")).toHaveLength(2);
    expect(root.querySelector("blockquote")?.textContent).toBe("quoted");
    expect(root.querySelector("pre.code code")?.textContent).toBe("echo <b>");
    expect(root.querySelector("b")).toBeNull();
  });

  it("adds a copy button that copies the raw code", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render("```\nline 1\n  line 2\n```");
    const btn = root.querySelector<HTMLButtonElement>(".code-block > button.copy-code");
    expect(btn?.getAttribute("aria-label")).toBe("Copy code");
    btn?.click();
    expect(writeText).toHaveBeenCalledWith("line 1\n  line 2");
    await Promise.resolve();
    expect(btn?.getAttribute("aria-label")).toBe("Copied");
  });

  it("replaces LaTeX symbols outside code", () => {
    expect(replaceLatexSymbols("Research $\\rightarrow$ Interview \\to done")).toBe("Research → Interview → done");
    render("`$\\rightarrow$`");
    expect(root.querySelector("code")?.textContent).toBe("$\\rightarrow$");
  });

  it("only links safe URLs and never parses HTML", () => {
    render('[ok](https://x.dev) [bad](javascript:alert(1)) <img src=x onerror="1">');
    const links = root.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("https://x.dev");
    expect(root.querySelector("img")).toBeNull();
    expect(root.textContent).toContain("[bad](javascript:alert(1))");
  });
});
