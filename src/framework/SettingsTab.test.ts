// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  isAbsoluteCommandPathMock,
  isPathLikeCommandMock,
  resolveCommandInfoMock,
  splitConfiguredCommandMock,
  checkHookStatusMock,
} = vi.hoisted(() => ({
  isAbsoluteCommandPathMock: vi.fn(),
  isPathLikeCommandMock: vi.fn(),
  resolveCommandInfoMock: vi.fn(),
  splitConfiguredCommandMock: vi.fn(),
  checkHookStatusMock: vi.fn(() => ({
    scriptExists: false,
    hooksConfigured: false,
  })),
}));

vi.mock("obsidian", () => {
  class App {}

  class PluginSettingTab {
    app: unknown;
    plugin: unknown;
    containerEl: HTMLElement;

    constructor(app: unknown, plugin: unknown) {
      this.app = app;
      this.plugin = plugin;
      this.containerEl = document.createElement("div");
    }
  }

  class Setting {
    settingEl: HTMLDivElement;
    nameEl: HTMLDivElement;
    descEl: HTMLDivElement;
    controlEl: HTMLDivElement;

    constructor(containerEl: HTMLElement) {
      this.settingEl = document.createElement("div");
      this.nameEl = document.createElement("div");
      this.descEl = document.createElement("div");
      this.controlEl = document.createElement("div");
      this.settingEl.append(this.nameEl, this.descEl, this.controlEl);
      containerEl.appendChild(this.settingEl);
    }

    setName(name: string) {
      this.nameEl.textContent = name;
      return this;
    }

    setDesc(description: string) {
      this.descEl.textContent = description;
      return this;
    }

    addText(
      callback: (text: {
        inputEl: HTMLInputElement;
        setValue: (value: string) => any;
        onChange: (handler: (value: string) => void) => any;
      }) => void,
    ) {
      const inputEl = document.createElement("input");
      this.controlEl.appendChild(inputEl);
      const text = {
        inputEl,
        setValue(value: string) {
          inputEl.value = value;
          return text;
        },
        onChange(handler: (value: string) => void) {
          inputEl.addEventListener("input", () => handler(inputEl.value));
          return text;
        },
      };
      callback(text);
      return this;
    }

    addTextArea(
      callback: (text: {
        inputEl: HTMLTextAreaElement;
        setValue: (value: string) => any;
        onChange: (handler: (value: string) => void) => any;
      }) => void,
    ) {
      const inputEl = document.createElement("textarea");
      this.controlEl.appendChild(inputEl);
      const text = {
        inputEl,
        setValue(value: string) {
          inputEl.value = value;
          return text;
        },
        onChange(handler: (value: string) => void) {
          inputEl.addEventListener("input", () => handler(inputEl.value));
          return text;
        },
      };
      callback(text);
      return this;
    }

    addToggle(
      callback: (toggle: {
        setValue: (value: boolean) => any;
        onChange: (handler: (value: boolean) => void) => any;
      }) => void,
    ) {
      const inputEl = document.createElement("input");
      inputEl.type = "checkbox";
      this.controlEl.appendChild(inputEl);
      const toggle = {
        setValue(value: boolean) {
          inputEl.checked = value;
          return toggle;
        },
        onChange(handler: (value: boolean) => void) {
          inputEl.addEventListener("change", () => handler(inputEl.checked));
          return toggle;
        },
      };
      callback(toggle);
      return this;
    }

    addButton(
      callback: (button: {
        setButtonText: (value: string) => any;
        setCta: () => any;
        setWarning: () => any;
        onClick: (handler: () => void | Promise<void>) => any;
      }) => void,
    ) {
      const buttonEl = document.createElement("button");
      this.controlEl.appendChild(buttonEl);
      const button = {
        setButtonText(value: string) {
          buttonEl.textContent = value;
          return button;
        },
        setCta() {
          return button;
        },
        setWarning() {
          return button;
        },
        onClick(handler: () => void | Promise<void>) {
          buttonEl.addEventListener("click", () => void handler());
          return button;
        },
      };
      callback(button);
      return this;
    }
  }

  return { App, PluginSettingTab, Setting };
});

vi.mock("../core/claude/ClaudeHookManager", () => ({
  checkHookStatus: checkHookStatusMock,
  installHooks: vi.fn(),
  removeHooks: vi.fn(),
}));

vi.mock("../core/PluginDataStore", () => ({
  mergeAndSavePluginData: async (
    plugin: { loadData: () => Promise<Record<string, any> | null>; saveData: (data: Record<string, any>) => Promise<void> },
    update: (data: Record<string, any>) => void | Promise<void>,
  ) => {
    const data = (await plugin.loadData()) || {};
    await update(data);
    await plugin.saveData(data);
  },
}));

vi.mock("../core/agents/AgentLauncher", () => ({
  isAbsoluteCommandPath: isAbsoluteCommandPathMock,
  isPathLikeCommand: isPathLikeCommandMock,
  resolveCommandInfo: resolveCommandInfoMock,
  splitConfiguredCommand: splitConfiguredCommandMock,
}));

import { WorkTerminalSettingsTab } from "./SettingsTab";

type CreateChildOptions = {
  cls?: string;
  text?: string;
  attr?: Record<string, string>;
};

type ObsidianHTMLElement = HTMLElement & {
  createEl: (tag: string, options?: CreateChildOptions) => HTMLElement;
  createDiv: (options?: CreateChildOptions) => HTMLDivElement;
  createSpan: (options?: CreateChildOptions) => HTMLSpanElement;
  addClass: (...classes: string[]) => void;
  empty: () => void;
};

type ObsidianHTMLElementPrototype = typeof HTMLElement.prototype & {
  createEl: ObsidianHTMLElement["createEl"];
  createDiv: ObsidianHTMLElement["createDiv"];
  createSpan: ObsidianHTMLElement["createSpan"];
  addClass: ObsidianHTMLElement["addClass"];
  empty: ObsidianHTMLElement["empty"];
};

type MockPlugin = {
  loadData: ReturnType<typeof vi.fn>;
  saveData: ReturnType<typeof vi.fn>;
};

function makePlugin(initialSettings: Record<string, unknown>): MockPlugin {
  let stored = { settings: { ...initialSettings } };
  return {
    loadData: vi.fn(async () => stored),
    saveData: vi.fn(async (nextData: Record<string, any>) => {
      stored = nextData as typeof stored;
    }),
  };
}

const adapter = {
  config: {
    settingsSchema: [],
    defaultSettings: {},
  },
} as any;

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function installDomHelpers() {
  const prototype = HTMLElement.prototype as ObsidianHTMLElementPrototype;
  const createEl = function (
    this: ObsidianHTMLElement,
    tag: string,
    options: CreateChildOptions = {},
  ) {
    const el = document.createElement(tag) as ObsidianHTMLElement;
    if (options.cls) el.className = options.cls;
    if (options.text) el.textContent = options.text;
    if (options.attr) {
      for (const [key, value] of Object.entries(options.attr)) {
        el.setAttribute(key, value);
      }
    }
    this.appendChild(el);
    return el;
  };

  prototype.createEl = createEl;
  prototype.createDiv = function (this: ObsidianHTMLElement, options: CreateChildOptions = {}) {
    return createEl.call(this, "div", options) as HTMLDivElement;
  };
  prototype.createSpan = function (this: ObsidianHTMLElement, options: CreateChildOptions = {}) {
    return createEl.call(this, "span", options) as HTMLSpanElement;
  };
  prototype.addClass = function (...classes: string[]) {
    this.classList.add(...classes);
  };
  prototype.empty = function () {
    this.replaceChildren();
  };
}

describe("WorkTerminalSettingsTab", () => {
  const originalHome = process.env.HOME;

  beforeEach(() => {
    process.env.HOME = "/Users/tester";
    document.body.innerHTML = "";
    installDomHelpers();
    isAbsoluteCommandPathMock.mockReset();
    isPathLikeCommandMock.mockReset();
    resolveCommandInfoMock.mockReset();
    splitConfiguredCommandMock.mockReset();
    isAbsoluteCommandPathMock.mockImplementation((command: string) => {
      const path = require("path") as typeof import("path");
      return path.isAbsolute(command) || path.win32.isAbsolute(command);
    });
    isPathLikeCommandMock.mockImplementation(
      (command: string) => command.includes("/") || command.includes("\\"),
    );
    resolveCommandInfoMock.mockImplementation((command: string, cwd?: string) => {
      if (command === "claude") {
        return {
          requested: command,
          resolved: "/opt/homebrew/bin/claude",
          found: true,
        };
      }
      if (command === "./agent.sh") {
        return {
          requested: command,
          resolved: `${cwd}/agent.sh`,
          found: cwd === "/Users/tester/vault",
        };
      }
      return {
        requested: command,
        resolved: command,
        found: false,
      };
    });
    splitConfiguredCommandMock.mockImplementation((command: string) => command.trim().split(/\s+/));
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    vi.clearAllMocks();
  });

  it("renders found and not found badges for configured command settings", async () => {
    const plugin = makePlugin({
      "core.claudeCommand": "claude",
      "core.copilotCommand": "missing-copilot",
      "core.strandsCommand": "./agent.sh",
      "core.defaultTerminalCwd": "~/vault",
    });
    const tab = new WorkTerminalSettingsTab({} as any, plugin as any, adapter);

    tab.display();
    await flushAsyncWork();

    const badges = Array.from(
      tab.containerEl.querySelectorAll<HTMLElement>(".wt-command-status-badge"),
    ).map((badge) => badge.textContent?.trim());

    expect(badges).toEqual(["Found", "Not found", "Found"]);
    expect(tab.containerEl.textContent).toContain("Resolved from /Users/tester/vault");
    expect(resolveCommandInfoMock).toHaveBeenCalledWith("claude", "/Users/tester/vault");
    expect(resolveCommandInfoMock).toHaveBeenCalledWith("missing-copilot", "/Users/tester/vault");
    expect(resolveCommandInfoMock).toHaveBeenCalledWith("./agent.sh", "/Users/tester/vault");
  });

  it("refreshes binary validation when the default cwd changes", async () => {
    const plugin = makePlugin({
      "core.claudeCommand": "claude",
      "core.copilotCommand": "missing-copilot",
      "core.strandsCommand": "./agent.sh",
      "core.defaultTerminalCwd": "~/missing",
    });
    const tab = new WorkTerminalSettingsTab({} as any, plugin as any, adapter);

    tab.display();
    await flushAsyncWork();

    const strandsBadge = tab.containerEl.querySelector<HTMLElement>(
      '[data-command-validation-key="core.strandsCommand"] .wt-command-status-badge',
    );
    expect(strandsBadge?.textContent).toBe("Not found");

    const cwdInput = tab.containerEl.querySelector<HTMLInputElement>(
      '[data-setting-key="core.defaultTerminalCwd"]',
    );
    if (!cwdInput) {
      throw new Error("Missing defaultTerminalCwd input");
    }
    cwdInput.value = "~/vault";
    cwdInput.dispatchEvent(new Event("input"));
    await flushAsyncWork();

    expect(strandsBadge?.textContent).toBe("Found");
    expect(plugin.saveData).toHaveBeenCalled();
    expect(resolveCommandInfoMock).toHaveBeenLastCalledWith("./agent.sh", "/Users/tester/vault");
  });

  it("validates the executable token for multi-token Strands commands", async () => {
    resolveCommandInfoMock.mockImplementation((command: string, cwd?: string) => {
      if (command === "uv") {
        return {
          requested: command,
          resolved: "/opt/homebrew/bin/uv",
          found: true,
        };
      }
      return {
        requested: command,
        resolved: `${cwd}/${command}`,
        found: false,
      };
    });
    const plugin = makePlugin({
      "core.claudeCommand": "claude",
      "core.copilotCommand": "./package.json",
      "core.strandsCommand": "uv run python agent.py",
      "core.defaultTerminalCwd": "~/vault",
    });
    const tab = new WorkTerminalSettingsTab({} as any, plugin as any, adapter);

    tab.display();
    await flushAsyncWork();

    const strandsBadge = tab.containerEl.querySelector<HTMLElement>(
      '[data-command-validation-key="core.strandsCommand"] .wt-command-status-badge',
    );
    expect(strandsBadge?.textContent).toBe("Found");
    expect(tab.containerEl.textContent).toContain("Inline args: run python agent.py");
    expect(resolveCommandInfoMock).toHaveBeenCalledWith("uv", "/Users/tester/vault");

    const copilotBadge = tab.containerEl.querySelector<HTMLElement>(
      '[data-command-validation-key="core.copilotCommand"] .wt-command-status-badge',
    );
    expect(copilotBadge?.textContent).toBe("Not found");
  });

  it("labels Windows absolute and relative command paths correctly", async () => {
    resolveCommandInfoMock.mockImplementation((command: string, cwd?: string) => {
      if (command === "C:\\Tools\\claude.exe") {
        return {
          requested: command,
          resolved: command,
          found: true,
        };
      }
      if (command === "\\\\server\\share\\copilot.cmd") {
        return {
          requested: command,
          resolved: command,
          found: true,
        };
      }
      if (command === ".\\agent.cmd") {
        return {
          requested: command,
          resolved: "C:\\vault\\agent.cmd",
          found: true,
        };
      }
      return {
        requested: command,
        resolved: `${cwd}/${command}`,
        found: false,
      };
    });
    const plugin = makePlugin({
      "core.claudeCommand": "C:\\Tools\\claude.exe",
      "core.copilotCommand": "\\\\server\\share\\copilot.cmd",
      "core.strandsCommand": ".\\agent.cmd",
      "core.defaultTerminalCwd": "C:\\vault",
    });
    const tab = new WorkTerminalSettingsTab({} as any, plugin as any, adapter);

    tab.display();
    await flushAsyncWork();

    expect(tab.containerEl.textContent).toContain("Using configured path: C:\\Tools\\claude.exe");
    expect(tab.containerEl.textContent).toContain(
      "Using configured path: \\\\server\\share\\copilot.cmd",
    );
    expect(tab.containerEl.textContent).toContain("Resolved from C:\\vault: C:\\vault\\agent.cmd");
  });
});
