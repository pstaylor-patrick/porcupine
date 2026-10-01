// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { CommandMenu, matchCommands, parseCommands, slashQuery } from "../src/commands.js";

const cmds = parseCommands({
  commands: [
    { name: "plan", description: "Toggle plan mode", source: "extension" },
    { name: "loop", description: "Repeat a prompt", source: "extension" },
    { name: "cf:plan", description: "<b>plan</b>", source: "skill" },
    { bad: true },
  ],
});

describe("slash commands", () => {
  it("parses, queries and matches", () => {
    expect(cmds.map((c) => c.name)).toEqual(["cf:plan", "loop", "plan"]);
    expect(slashQuery("/pl")).toBe("pl");
    expect(slashQuery("/plan x")).toBeNull();
    expect(slashQuery("hi")).toBeNull();
    expect(matchCommands(cmds, "pl").map((c) => c.name)).toEqual(["plan", "cf:plan"]);
  });

  it("opens on '/', completes with Tab and renders text only", () => {
    const root = document.createElement("ul");
    const input = document.createElement("textarea");
    const menu = new CommandMenu(root, input);
    menu.setCommands(cmds);
    input.value = "/";
    menu.update();
    expect(root.hidden).toBe(false);
    expect(root.querySelectorAll("li")).toHaveLength(3);
    expect(root.querySelector("b")).toBeNull();
    menu.handleKey(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    expect(menu.handleKey(new KeyboardEvent("keydown", { key: "Tab" }))).toBe(true);
    expect(input.value).toBe("/loop ");
    expect(root.hidden).toBe(true);
    input.value = "/p";
    menu.update();
    menu.handleKey(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(menu.open).toBe(false);
    expect(menu.handleKey(new KeyboardEvent("keydown", { key: "Enter" }))).toBe(false);
  });
});
