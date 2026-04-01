// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { checkHookStatusMock, resetGuidedTourStatusMock, NoticeMock } = vi.hoisted(() => ({
  checkHookStatusMock: vi.fn(() => ({
    scriptExists: false,
    hooksConfigured: false,
  })),
  resetGuidedTourStatusMock: vi.fn(async () => {}),
  NoticeMock: vi.fn(),
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

  class Modal {
    app: unknown;
    contentEl: HTMLElement;
    constructor(app: unknown) {
      this.app = app;
      this.contentEl = document.createElement("div");
    }
    open() {}
    close() {}
    onOpen() {}
    onClose() {}
  }

  return { App, Modal, Notice: NoticeMock, PluginSettingTab, Setting };
});

vi.mock("./GuidedTour", () => ({
  resetGuidedTourStatus: resetGuidedTourStatusMock,
}));

vi.mock("../core/claude/ClaudeHookManager", () => ({
  checkHookStatus: checkHookStatusMock,
  installHooks: vi.fn(),
  removeHooks: vi.fn(),
}));

vi.mock("../core/PluginDataStore", () => ({
  mergeAndSavePluginData: async (
    plugin: {
      loadData: () => Promise<Record<string, any> | null>;
      saveData: (data: Record<string, any>) => Promise<void>;
    },
    update: (data: Record<string, any>) => void | Promise<void>,
  ) => {
    const data = (await plugin.loadData()) || {};
    await update(data);
    await plugin.saveData(data);
  },
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

const mockProfileManager = {
  getProfiles: vi.fn(() => []),
  getButtonProfiles: vi.fn(() => []),
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
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    vi.clearAllMocks();
  });

  it("does not render legacy agent command settings", async () => {
    const plugin = makePlugin({
      "core.claudeCommand": "claude",
      "core.copilotCommand": "copilot",
    });
    const tab = new WorkTerminalSettingsTab({} as any, plugin as any, adapter, mockProfileManager);

    tab.display();
    await flushAsyncWork();

    expect(tab.containerEl.querySelector('[data-setting-key="core.claudeCommand"]')).toBeNull();
    expect(tab.containerEl.querySelector('[data-setting-key="core.copilotCommand"]')).toBeNull();
    expect(tab.containerEl.querySelector('[data-setting-key="core.strandsCommand"]')).toBeNull();
    expect(tab.containerEl.querySelector('[data-setting-key="core.claudeExtraArgs"]')).toBeNull();
    expect(
      tab.containerEl.querySelector('[data-setting-key="core.additionalAgentContext"]'),
    ).toBeNull();
    // But core settings like defaultShell should still be present
    expect(tab.containerEl.querySelector('[data-setting-key="core.defaultShell"]')).not.toBeNull();
  });

  it("renders a reset guided tour button that calls resetGuidedTourStatus and shows a Notice", async () => {
    const plugin = makePlugin({});
    const tab = new WorkTerminalSettingsTab({} as any, plugin as any, adapter, mockProfileManager);

    tab.display();
    await flushAsyncWork();

    const allButtons = Array.from(tab.containerEl.querySelectorAll("button"));
    const resetButton = allButtons.find((btn) => btn.textContent === "Reset");
    expect(resetButton).toBeDefined();

    expect(tab.containerEl.textContent).toContain("Reset guided tour");

    resetGuidedTourStatusMock.mockClear();
    NoticeMock.mockClear();

    resetButton!.click();
    await flushAsyncWork();

    expect(resetGuidedTourStatusMock).toHaveBeenCalledWith(plugin);
    expect(NoticeMock).toHaveBeenCalledWith(
      "Guided tour will start next time you open Work Terminal",
    );
  });
});
