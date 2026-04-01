// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentProfile } from "../core/agents/AgentProfile";
import { createDefaultClaudeProfile, createDefaultProfile } from "../core/agents/AgentProfile";
import { ProfileLaunchModal, renderProfileSummary } from "./ProfileLaunchModal";

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
    app: unknown;
    contentEl = document.createElement("div");
    constructor(app: unknown) {
      this.app = app;
    }
    open() {
      (this as any).onOpen?.();
    }
    close() {
      (this as any).onClose?.();
    }
  },
  Setting: class {
    private el: HTMLElement;
    constructor(containerEl: HTMLElement) {
      this.el = containerEl.createDiv({ cls: "setting-item" }) as unknown as HTMLElement;
    }
    setName() {
      return this;
    }
    setDesc() {
      return this;
    }
    addDropdown(cb: (dropdown: any) => void) {
      const select = document.createElement("select");
      this.el.appendChild(select);
      const dropdown = {
        addOption(value: string, label: string) {
          const opt = document.createElement("option");
          opt.value = value;
          opt.textContent = label;
          select.appendChild(opt);
          return dropdown;
        },
        setValue(value: string) {
          select.value = value;
          return dropdown;
        },
        onChange(cb: (value: string) => void) {
          select.addEventListener("change", () => cb(select.value));
          return dropdown;
        },
      };
      cb(dropdown);
      return this;
    }
    addText(cb: (text: any) => void) {
      const input = document.createElement("input");
      this.el.appendChild(input);
      const text = {
        inputEl: input,
        setPlaceholder(p: string) {
          input.placeholder = p;
          return text;
        },
        setValue(v: string) {
          input.value = v;
          return text;
        },
        onChange(cb: (v: string) => void) {
          input.addEventListener("input", () => cb(input.value));
          return text;
        },
      };
      cb(text);
      return this;
    }
    addTextArea(cb: (text: any) => void) {
      const textarea = document.createElement("textarea");
      this.el.appendChild(textarea);
      const text = {
        inputEl: textarea,
        setPlaceholder(p: string) {
          textarea.placeholder = p;
          return text;
        },
        setValue(v: string) {
          textarea.value = v;
          return text;
        },
        onChange(cb: (v: string) => void) {
          textarea.addEventListener("input", () => cb(textarea.value));
          return text;
        },
      };
      cb(text);
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

  it("does not set inline border color when no button color (CSS handles fallback)", () => {
    const container = document.createElement("div");
    renderProfileSummary(container, makeProfile());

    expect(container.style.borderLeftColor).toBe("");
  });

  it("renders icon with profile color and no margin-right", () => {
    const container = document.createElement("div");
    const claudeProfile = createDefaultClaudeProfile();
    renderProfileSummary(container, claudeProfile);

    const header = container.querySelector(".wt-launch-summary-header");
    const svg = header?.querySelector("svg") as SVGSVGElement;
    expect(svg).not.toBeNull();
    expect(svg?.style.color).toBeTruthy();
    expect(svg?.style.marginRight).toBe("0px");
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

describe("ProfileLaunchModal placeholders", () => {
  function createModal(profiles: AgentProfile[], defaultCwd = "/vault") {
    const modal = new ProfileLaunchModal({} as any, profiles, defaultCwd, vi.fn());
    modal.open();
    return modal;
  }

  function getInputs(modal: ProfileLaunchModal) {
    const el = (modal as any).contentEl as HTMLElement;
    const inputs = el.querySelectorAll<HTMLInputElement>("input");
    const textareas = el.querySelectorAll<HTMLTextAreaElement>("textarea");
    return {
      cwd: inputs[0],
      label: inputs[1],
      args: textareas[0],
    };
  }

  it("shows profile defaultCwd as cwd placeholder", () => {
    const modal = createModal([makeProfile({ defaultCwd: "/custom/path" })]);
    const { cwd } = getInputs(modal);
    expect(cwd.placeholder).toBe("/custom/path");
  });

  it("falls back to vault default cwd when profile has no defaultCwd", () => {
    const modal = createModal([makeProfile()], "/vault/default");
    const { cwd } = getInputs(modal);
    expect(cwd.placeholder).toBe("/vault/default");
  });

  it("shows button.label as label placeholder when set", () => {
    const modal = createModal([
      makeProfile({ name: "Claude", button: { enabled: true, label: "My Claude" } }),
    ]);
    const { label } = getInputs(modal);
    expect(label.placeholder).toBe("My Claude");
  });

  it("falls back to profile name when button.label is empty", () => {
    const modal = createModal([makeProfile({ name: "Strands", button: { enabled: true } })]);
    const { label } = getInputs(modal);
    expect(label.placeholder).toBe("Strands");
  });

  it("shows profile arguments as args placeholder", () => {
    const modal = createModal([makeProfile({ arguments: "--model opus" })]);
    const { args } = getInputs(modal);
    expect(args.placeholder).toBe("--model opus");
  });

  it("shows generic text when profile has no arguments", () => {
    const modal = createModal([makeProfile()]);
    const { args } = getInputs(modal);
    expect(args.placeholder).toBe("Optional extra arguments");
  });

  it("updates placeholders when profile changes", () => {
    const profiles = [
      makeProfile({ id: "p1", name: "Claude", defaultCwd: "/claude", arguments: "--fast" }),
      makeProfile({
        id: "p2",
        name: "Copilot",
        defaultCwd: "/copilot",
        arguments: "--model gpt-5",
        button: { enabled: true, label: "GH Copilot" },
      }),
    ];
    const modal = createModal(profiles);
    const { cwd, label, args } = getInputs(modal);

    // Initial state - first profile
    expect(cwd.placeholder).toBe("/claude");
    expect(label.placeholder).toBe("Claude");
    expect(args.placeholder).toBe("--fast");

    // Switch to second profile via dropdown
    const select = (modal as any).contentEl.querySelector("select") as HTMLSelectElement;
    select.value = "p2";
    select.dispatchEvent(new Event("change"));

    expect(cwd.placeholder).toBe("/copilot");
    expect(label.placeholder).toBe("GH Copilot");
    expect(args.placeholder).toBe("--model gpt-5");
  });

  it("nulls out DOM refs on close", () => {
    const modal = createModal([makeProfile()]);
    expect((modal as any).cwdInput).not.toBeNull();
    modal.close();
    expect((modal as any).cwdInput).toBeNull();
    expect((modal as any).labelInput).toBeNull();
    expect((modal as any).argsInput).toBeNull();
  });
});
