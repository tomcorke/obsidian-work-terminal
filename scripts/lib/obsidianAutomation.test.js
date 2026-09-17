import { describe, expect, it } from "vitest";
import { findObsidianPageTarget } from "./obsidianAutomation.js";

const settingsTarget = {
  type: "page",
  title: "Settings - Test - Obsidian 1.13.4",
  url: "about:blank",
  webSocketDebuggerUrl: "ws://settings",
};

const vaultTarget = {
  type: "page",
  title: "New tab - Test - Obsidian 1.13.4",
  url: "app://obsidian.md/index.html",
  webSocketDebuggerUrl: "ws://vault",
};

describe("findObsidianPageTarget", () => {
  it("prefers the vault renderer when the Settings window appears first", () => {
    expect(findObsidianPageTarget([settingsTarget, vaultTarget])).toBe(vaultTarget);
  });

  it("keeps the title-based fallback for older Obsidian targets", () => {
    expect(findObsidianPageTarget([settingsTarget])).toBe(settingsTarget);
  });
});
