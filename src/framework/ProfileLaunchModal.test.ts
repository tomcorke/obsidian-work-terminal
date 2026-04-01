// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentProfile } from "../core/agents/AgentProfile";
import { createDefaultClaudeProfile, createDefaultProfile } from "../core/agents/AgentProfile";
import { renderProfileSummary } from "./ProfileLaunchModal";

type CreateChildOptions = { cls?: string; text?: string };
type ObsidianHTMLElementPrototype = typeof HTMLElement.prototype & {
  empty(): void;
  addClass(cls: string): HTMLElement;
  createDiv(options?: CreateChildOptions): HTMLDivElement;
  createSpan(options?: CreateChildOptions): HTMLSpanElement;
  createEl(tag: string, options?: CreateChildOptions): HTMLElement;
};

vi.mock("obsidian", () => ({
  Modal: class {
    contentEl = document.createElement("div");
    close() {}
  },
  Setting: class {
    constructor() {}
    setName() {
      return this;
    }
    setDesc() {
      return this;
    }
    addDropdown() {
      return this;
    }
    addText() {
      return this;
    }
    addTextArea() {
      return this;
    }
  },
}));

// Polyfill Obsidian HTMLElement augmentations for jsdom
beforeAll(() => {
  const prototype = HTMLElement.prototype as ObsidianHTMLElementPrototype;

  prototype.empty = function () {
    this.innerHTML = "";
  };
  prototype.addClass = function (cls: string) {
    this.classList.add(...cls.split(" "));
    return this;
  };
  prototype.createDiv = function (options?: CreateChildOptions) {
    const el = document.createElement("div");
    if (options?.cls) el.classList.add(...options.cls.split(" "));
    if (options?.text) el.textContent = options.text;
    this.appendChild(el);
    return el;
  };
  prototype.createSpan = function (options?: CreateChildOptions) {
    const el = document.createElement("span");
    if (options?.cls) el.classList.add(...options.cls.split(" "));
    if (options?.text) el.textContent = options.text;
    this.appendChild(el);
    return el;
  };
  prototype.createEl = function (tag: string, options?: CreateChildOptions) {
    const el = document.createElement(tag);
    if (options?.cls) el.classList.add(...options.cls.split(" "));
    if (options?.text) el.textContent = options.text;
    this.appendChild(el);
    return el;
  };

  // CSS.supports is not available in jsdom
  if (!globalThis.CSS) {
    (globalThis as Record<string, unknown>).CSS = { supports: () => true };
  } else if (!CSS.supports) {
    (CSS as Record<string, unknown>).supports = () => true;
  }
});

function makeProfile(overrides?: Partial<AgentProfile>): AgentProfile {
  return createDefaultProfile(overrides);
}

describe("renderProfileSummary", () => {
  it("shows profile name in header", () => {
    const container = document.createElement("div");
    renderProfileSummary(container, makeProfile({ name: "My Agent" }));

    const nameEl = container.querySelector(".wt-launch-summary-name");
    expect(nameEl?.textContent).toBe("My Agent");
  });

  it("shows 'Using default settings' when all fields are empty", () => {
    const container = document.createElement("div");
    renderProfileSummary(container, makeProfile());

    const defaultRow = container.querySelector(".wt-launch-summary-default");
    expect(defaultRow?.textContent).toBe("Using default settings");
  });

  it("shows command, arguments, cwd, and context when set", () => {
    const container = document.createElement("div");
    renderProfileSummary(
      container,
      makeProfile({
        command: "/usr/bin/claude",
        arguments: "--model opus",
        defaultCwd: "~/projects",
        contextPrompt: "You are a helpful assistant",
      }),
    );

    const rows = container.querySelectorAll(".wt-launch-summary-row");
    const texts = Array.from(rows).map((r) => r.textContent);
    expect(texts).toContain("Command: /usr/bin/claude");
    expect(texts).toContain("Arguments: --model opus");
    expect(texts).toContain("CWD: ~/projects");
    expect(texts).toContain("Context: You are a helpful assistant");
  });

  it("truncates context prompt longer than 80 chars", () => {
    const container = document.createElement("div");
    const longPrompt = "A".repeat(100);
    renderProfileSummary(container, makeProfile({ contextPrompt: longPrompt }));

    const rows = container.querySelectorAll(".wt-launch-summary-row");
    const contextRow = Array.from(rows).find((r) => r.textContent?.startsWith("Context:"));
    expect(contextRow?.textContent).toBe(`Context: ${"A".repeat(80)}...`);
  });

  it("does not show 'Using default settings' when any field is set", () => {
    const container = document.createElement("div");
    renderProfileSummary(container, makeProfile({ command: "claude" }));

    const defaultRow = container.querySelector(".wt-launch-summary-default");
    expect(defaultRow).toBeNull();
  });

  it("sets border-left-color from profile button color", () => {
    const container = document.createElement("div");
    renderProfileSummary(
      container,
      makeProfile({ button: { enabled: true, label: "Test", color: "#D97757" } }),
    );

    expect(container.style.borderLeftColor).toBeTruthy();
  });

  it("uses fallback border color when no button color", () => {
    const container = document.createElement("div");
    renderProfileSummary(container, makeProfile());

    expect(container.style.borderLeftColor).toContain("var(--background-modifier-border");
  });

  it("renders icon with profile color", () => {
    const container = document.createElement("div");
    const claudeProfile = createDefaultClaudeProfile();
    renderProfileSummary(container, claudeProfile);

    const header = container.querySelector(".wt-launch-summary-header");
    const svg = header?.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.style.color).toBeTruthy();
  });

  it("clears container before rendering", () => {
    const container = document.createElement("div");
    container.innerHTML = "<div>old content</div>";
    renderProfileSummary(container, makeProfile({ name: "Fresh" }));

    expect(container.querySelector(".wt-launch-summary-name")?.textContent).toBe("Fresh");
    expect(container.textContent).not.toContain("old content");
  });

  it("clears container and does nothing for null profile", () => {
    const container = document.createElement("div");
    container.innerHTML = "<div>old content</div>";
    renderProfileSummary(container, null);

    expect(container.innerHTML).toBe("");
  });
});
