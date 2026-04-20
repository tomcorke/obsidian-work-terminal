import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import * as path from "node:path";
import type { ActiveTabInfo, TabDiagnostics } from "../core/session/types";
import type { WorkItemPromptBuilder } from "../core/interfaces";
import { electronRequire, expandTilde } from "../core/utils";
import * as AgentLauncher from "../core/agents/AgentLauncher";
import { TerminalPanelView } from "./TerminalPanelView";

const createdViews: TerminalPanelView[] = [];

const mockState = vi.hoisted(() => ({
  activeSessions: new Map<string, Array<{ sessionType: string }>>(),
  activeTabs: [] as ActiveTabInfo[],
  activeItemId: null as string | null,
  tabsByItem: new Map<string, any[]>(),
  activeTabIndex: 0,
  tabDiagnostics: [] as TabDiagnostics[],
  idleSinceByItem: new Map<string, number>(),
  menuTitles: [] as string[],
  menuActions: new Map<string, () => void>(),
  notices: [] as string[],
  clipboardWriteText: vi.fn(),
  latestCreateTabArgs: null as unknown[] | null,
  tabManagerCalls: [] as string[],
  openExternal: vi.fn(),
  latestTabManager: null as {
    onSessionChange?: () => void;
    onAgentStateChange?: (itemId: string, state: string) => void;
    onPersistRequest?: () => void;
    onTabClosed?: (itemId: string, tab: unknown) => void;
  } | null,
  latestTabManagerCtorArgs: null as unknown[] | null,
}));

vi.mock("../core/utils", async () => {
  const actual = await vi.importActual<typeof import("../core/utils")>("../core/utils");
  return {
    ...actual,
    electronRequire: vi.fn((moduleName: string) => {
      if (moduleName === "electron") {
        return {
          shell: {
            openExternal: mockState.openExternal,
          },
          clipboard: {
            writeText: mockState.clipboardWriteText,
          },
        };
      }
      return actual.electronRequire(moduleName);
    }),
  };
});

vi.mock("obsidian", () => ({
  App: class {},
  PluginSettingTab: class {
    app: unknown;
    plugin: unknown;
    containerEl: HTMLElement;

    constructor(app: unknown, plugin: unknown) {
      this.app = app;
      this.plugin = plugin;
      this.containerEl = document.createElement("div");
    }
  },
  Menu: class {
    addSeparator() {}
    addItem(
      callback: (item: {
        setTitle: (title: string) => any;
        onClick: (handler: (evt: MouseEvent | KeyboardEvent) => any) => any;
        setDisabled: (disabled: boolean) => any;
      }) => void,
    ) {
      let currentTitle = "";
      callback({
        setTitle(title: string) {
          currentTitle = title;
          mockState.menuTitles.push(title);
          return this;
        },
        onClick(handler: (evt: MouseEvent | KeyboardEvent) => any) {
          if (currentTitle) {
            mockState.menuActions.set(currentTitle, () => handler({ type: "click" } as MouseEvent));
          }
          return this;
        },
        setDisabled() {
          return this;
        },
      });
    }
    showAtMouseEvent() {}
  },
  Notice: class {
    constructor(message: string) {
      mockState.notices.push(message);
    }
  },
  Modal: class {
    app: unknown;
    contentEl: HTMLElement;

    constructor(app: unknown) {
      this.app = app;
      this.contentEl = document.createElement("div");
    }

    open() {}
    close() {}
  },
  Setting: class {
    settingEl: HTMLElement;

    constructor(_containerEl: HTMLElement) {
      this.settingEl = document.createElement("div");
    }

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

vi.mock("../core/terminal/TabManager", () => ({
  TabManager: class {
    onSessionChange?: () => void;
    onAgentStateChange?: (itemId: string, state: string) => void;
    onPersistRequest?: () => void;
    onTabClosed?: (itemId: string, tab: unknown) => void;

    constructor(...args: unknown[]) {
      mockState.latestTabManager = this;
      mockState.latestTabManagerCtorArgs = args;
    }

    getSessions() {
      return mockState.activeSessions as any;
    }

    getActiveItemId() {
      return mockState.activeItemId;
    }

    getTabs(itemId?: string) {
      return mockState.tabsByItem.get(itemId || mockState.activeItemId || "") || [];
    }

    getActiveTabIndex() {
      return mockState.activeTabIndex;
    }

    createTab(...args: unknown[]) {
      mockState.latestCreateTabArgs = args;
      mockState.tabManagerCalls.push("createTab");
      return {} as any;
    }

    createTabForItem(...args: unknown[]) {
      mockState.latestCreateTabArgs = args;
      mockState.tabManagerCalls.push("createTabForItem");
      return {} as any;
    }

    setActiveItem(itemId: string | null) {
      mockState.activeItemId = itemId;
    }

    getSessionItemIds() {
      return Array.from(new Set(mockState.tabDiagnostics.map((tab) => tab.itemId)));
    }

    getAllActiveTabs() {
      return mockState.activeTabs;
    }

    getTabDiagnostics() {
      return mockState.tabDiagnostics;
    }

    findTabsByLabel(label: string) {
      const normalizedLabel = label.trim().toLowerCase();
      if (!normalizedLabel) return [];
      return mockState.activeTabs.filter(
        (tab) => tab.label.trim().toLowerCase() === normalizedLabel,
      );
    }

    getAgentState() {
      return "inactive";
    }

    getSessionCounts(itemId: string) {
      const tabs = mockState.tabDiagnostics.filter((tab) => tab.itemId === itemId);
      return {
        shells: tabs.filter((tab) => tab.sessionType === "shell").length,
        agents: tabs.filter((tab) => tab.sessionType !== "shell").length,
      };
    }

    getIdleSince(itemId: string) {
      return mockState.idleSinceByItem.get(itemId);
    }

    closeAllSessions(_itemId: string) {}

    disposeAll() {}

    stashAll() {}

    rekeyItem(_oldId: string, _newId: string) {}

    closeTab(_index: number) {
      mockState.tabManagerCalls.push("closeTab");
    }

    closeTabInstance(_itemId: string, _tab: unknown) {
      mockState.tabManagerCalls.push("closeTabInstance");
    }

    switchToTab(index: number) {
      mockState.activeTabIndex = index;
      mockState.tabManagerCalls.push(`switchToTab:${index}`);
    }

    getRecoveredItemId() {
      return null;
    }

    setDragSourceIndex() {}

    getDragSourceIndex() {
      return null;
    }

    refitActive() {}

    hasSessions() {
      return false;
    }

    broadcastAgentStates() {}
  },
}));

type DomGlobals = {
  window: Window & typeof globalThis;
  document: Document;
  HTMLElement: typeof HTMLElement;
  Element: typeof Element;
  Node: typeof Node;
};

function installDomHelpers(globals: DomGlobals) {
  const { HTMLElement } = globals;
  const createEl = function (
    this: HTMLElement,
    tag: string,
    options: { cls?: string; text?: string; attr?: Record<string, string> } = {},
  ) {
    const el = globals.document.createElement(tag) as HTMLElement;
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

  HTMLElement.prototype.createEl = createEl;
  HTMLElement.prototype.createDiv = function (
    options: { cls?: string; text?: string; attr?: Record<string, string> } = {},
  ) {
    return createEl.call(this, "div", options);
  };
  HTMLElement.prototype.createSpan = function (
    options: { cls?: string; text?: string; attr?: Record<string, string> } = {},
  ) {
    return createEl.call(this, "span", options);
  };
  HTMLElement.prototype.addClass = function (...classes: string[]) {
    this.classList.add(...classes);
  };
  HTMLElement.prototype.toggleClass = function (cls: string, force: boolean) {
    this.classList.toggle(cls, force);
  };
  HTMLElement.prototype.removeClass = function (...classes: string[]) {
    this.classList.remove(...classes);
  };
  HTMLElement.prototype.empty = function () {
    this.replaceChildren();
  };
  HTMLElement.prototype.appendText = function (text: string) {
    this.appendChild(globals.document.createTextNode(text));
  };
}

function createPlugin(settings: Record<string, unknown> = {}) {
  const loadData = vi.fn(async () => ({ settings }));
  return {
    loadData,
    saveData: vi.fn(async () => {}),
    app: {
      setting: {
        open: vi.fn(),
        openTabById: vi.fn(),
      },
      vault: {
        adapter: {
          basePath: "/vault",
        },
      },
    },
    manifest: {
      id: "work-terminal",
    },
  };
}

function createView(
  settings: Record<string, unknown> = {},
  pluginOverrides: Partial<ReturnType<typeof createPlugin>> = {},
  promptBuilder: WorkItemPromptBuilder = { buildPrompt: () => "" },
) {
  const panelEl = document.createElement("div") as HTMLElement & {
    createDiv: HTMLElement["createDiv"];
  };
  const terminalWrapperEl = document.createElement("div") as HTMLElement & {
    createDiv: HTMLElement["createDiv"];
  };
  panelEl.appendChild(terminalWrapperEl);
  document.body.appendChild(panelEl);

  const plugin = {
    ...createPlugin(settings),
    ...pluginOverrides,
  };
  const view = new TerminalPanelView(
    panelEl,
    terminalWrapperEl,
    plugin as any,
    { config: { itemName: "task", columns: [] } } as any,
    { "core.defaultTerminalCwd": "~", ...settings },
    promptBuilder,
    vi.fn(),
    vi.fn(),
  );
  createdViews.push(view);

  return { panelEl, plugin, view };
}

async function flushAsync(ticks = 3) {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
  }
}

describe("TerminalPanelView", () => {
  let dom: JSDOM;

  beforeEach(() => {
    dom = new JSDOM("<!doctype html><html><body></body></html>");
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
    vi.stubGlobal("Element", dom.window.Element);
    vi.stubGlobal("Node", dom.window.Node);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    installDomHelpers({
      window: dom.window,
      document: dom.window.document,
      HTMLElement: dom.window.HTMLElement,
      Element: dom.window.Element,
      Node: dom.window.Node,
    });

    mockState.activeSessions = new Map();
    mockState.activeTabs = [];
    mockState.activeItemId = null;
    mockState.tabsByItem = new Map();
    mockState.activeTabIndex = 0;
    mockState.tabDiagnostics = [];
    mockState.idleSinceByItem = new Map();
    mockState.menuTitles = [];
    mockState.menuActions = new Map();
    mockState.notices = [];
    mockState.clipboardWriteText.mockClear();
    mockState.latestCreateTabArgs = null;
    mockState.tabManagerCalls = [];
    mockState.openExternal.mockClear();
    mockState.latestTabManager = null;
    mockState.latestTabManagerCtorArgs = null;
  });

  afterEach(() => {
    while (createdViews.length > 0) {
      createdViews.pop()?.disposeAll();
    }
    vi.unstubAllGlobals();
    dom.window.close();
  });

  it("keeps the debug global disabled by default", async () => {
    createView();
    await flushAsync();

    expect(window.__workTerminalDebug).toBeUndefined();
  });

  it("publishes a debug global only when explicitly enabled", async () => {
    mockState.activeItemId = "task-2";
    mockState.activeTabs = [
      {
        tabId: "tab-1",
        itemId: "task-1",
        label: "Shell",
        sessionType: "shell",
      },
      {
        tabId: "tab-2",
        itemId: "task-2",
        label: "Automatic Issues",
        sessionType: "copilot",
      },
    ];

    createView({ "core.exposeDebugApi": true });
    await flushAsync();

    expect(window.__workTerminalDebug?.activeItemId).toBe("task-2");
    expect(window.__workTerminalDebug?.activeTabs).toEqual(mockState.activeTabs);
    expect(window.__workTerminalDebug?.findTabsByLabel("automatic issues")).toEqual([
      mockState.activeTabs[1],
    ]);
    expect(window.__workTerminalDebug?.getSnapshot()).toMatchObject({
      version: 1,
      hasHotReloadStore: false,
      activeItemId: "task-2",
    });
  });

  it("keeps the debug global live as tab state changes", async () => {
    createView({ "core.exposeDebugApi": true });
    await flushAsync();
    expect(window.__workTerminalDebug?.activeTabs).toEqual([]);

    mockState.activeTabs = [
      {
        tabId: "tab-2",
        itemId: "task-9",
        label: "Automatic Issues",
        sessionType: "claude",
      },
    ];
    mockState.activeItemId = "task-9";
    mockState.activeTabIndex = 2;

    expect(window.__workTerminalDebug?.activeItemId).toBe("task-9");
    expect(window.__workTerminalDebug?.activeTabIndex).toBe(2);
    expect(window.__workTerminalDebug?.activeTabs).toEqual(mockState.activeTabs);
    expect(window.__workTerminalDebug?.getAllActiveTabs()).toEqual(mockState.activeTabs);
  });

  it("clears the debug global when the setting is disabled", async () => {
    createView({ "core.exposeDebugApi": true });
    await flushAsync();

    expect(window.__workTerminalDebug).toBeDefined();

    window.dispatchEvent(
      new window.CustomEvent("work-terminal:settings-changed", {
        detail: {
          "core.defaultTerminalCwd": "~",
          "core.exposeDebugApi": false,
        },
      }),
    );
    await flushAsync();

    expect(window.__workTerminalDebug).toBeUndefined();
  });

  it("does not republish the debug global when public updates arrive after disposal", async () => {
    const { view } = createView({ "core.exposeDebugApi": true });
    await flushAsync();

    expect(window.__workTerminalDebug).toBeDefined();

    view.disposeAll();
    view.setItems([
      {
        id: "task-1",
        path: "Tasks/task-1.md",
        title: "Task 1",
        state: "todo",
        metadata: {},
      },
    ] as any);

    expect(window.__workTerminalDebug).toBeUndefined();
  });

  it("restores another live view's debug global when the current owner is disposed", async () => {
    createView({ "core.exposeDebugApi": true });
    await flushAsync();
    const firstDebugRef = window.__workTerminalDebug;

    const { view: secondView } = createView({ "core.exposeDebugApi": true });
    await flushAsync();
    const secondDebugRef = window.__workTerminalDebug;

    expect(secondDebugRef).toBeDefined();
    expect(secondDebugRef).not.toBe(firstDebugRef);

    secondView.disposeAll();

    expect(window.__workTerminalDebug).toBeDefined();
    expect(window.__workTerminalDebug).not.toBe(secondDebugRef);
  });

  it("keeps tab clicks working after rename mode is torn down by a task switch", async () => {
    mockState.tabsByItem = new Map([
      [
        "task-1",
        [
          {
            label: "Shell",
            sessionType: "shell",
            isResumableAgent: false,
            agentState: "inactive",
          },
        ],
      ],
      [
        "task-2",
        [
          {
            label: "Shell",
            sessionType: "shell",
            isResumableAgent: false,
            agentState: "inactive",
          },
          {
            label: "Claude",
            sessionType: "claude",
            isResumableAgent: true,
            agentState: "inactive",
          },
        ],
      ],
    ]);

    const { panelEl, view } = createView();
    await flushAsync();

    view.setActiveItem("task-1");
    const firstLabel = panelEl.querySelector(".wt-tab-label") as HTMLElement;
    firstLabel.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true }));
    expect(panelEl.querySelector(".wt-tab-rename-input")).not.toBeNull();

    view.setActiveItem("task-2");
    expect(panelEl.querySelector(".wt-tab-rename-input")).toBeNull();

    vi.useFakeTimers();
    const secondTab = panelEl.querySelectorAll(".wt-tab")[1] as HTMLElement;
    secondTab.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));

    // Click is now delayed by 250ms to allow double-click cancellation
    expect(mockState.tabManagerCalls).not.toContain("switchToTab:1");
    vi.advanceTimersByTime(250);
    expect(mockState.tabManagerCalls).toContain("switchToTab:1");
    vi.useRealTimers();
  });

  it("lets active tab double-click enter rename mode without replacing the label first", async () => {
    mockState.tabsByItem = new Map([
      [
        "task-1",
        [
          {
            label: "Shell",
            sessionType: "shell",
            isResumableAgent: false,
            agentState: "inactive",
          },
        ],
      ],
    ]);

    const { panelEl, view } = createView();
    await flushAsync();

    view.setActiveItem("task-1");
    const activeTab = panelEl.querySelector(".wt-tab") as HTMLElement;
    const labelEl = panelEl.querySelector(".wt-tab-label") as HTMLElement;

    activeTab.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));

    expect(panelEl.querySelector(".wt-tab-label")).toBe(labelEl);
    expect(labelEl.isConnected).toBe(true);
    expect(mockState.tabManagerCalls).not.toContain("switchToTab:0");

    labelEl.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true }));

    expect(panelEl.querySelector(".wt-tab-rename-input")).not.toBeNull();
  });

  it("single-clicks a non-active tab to switch after the debounce delay", async () => {
    mockState.tabsByItem = new Map([
      [
        "task-1",
        [
          {
            label: "Shell",
            sessionType: "shell",
            isResumableAgent: false,
            agentState: "inactive",
          },
          {
            label: "Claude",
            sessionType: "claude",
            isResumableAgent: true,
            agentState: "inactive",
          },
        ],
      ],
    ]);

    const { panelEl, view } = createView();
    await flushAsync();
    view.setActiveItem("task-1");

    vi.useFakeTimers();
    const secondTab = panelEl.querySelectorAll(".wt-tab")[1] as HTMLElement;
    secondTab.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));

    // Should not switch immediately
    expect(mockState.tabManagerCalls).not.toContain("switchToTab:1");

    // Should switch after the 250ms delay
    vi.advanceTimersByTime(250);
    expect(mockState.tabManagerCalls).toContain("switchToTab:1");
    vi.useRealTimers();
  });

  it("double-clicking a non-active tab cancels the switch and enters rename mode", async () => {
    mockState.tabsByItem = new Map([
      [
        "task-1",
        [
          {
            label: "Shell",
            sessionType: "shell",
            isResumableAgent: false,
            agentState: "inactive",
          },
          {
            label: "Claude",
            sessionType: "claude",
            isResumableAgent: true,
            agentState: "inactive",
          },
        ],
      ],
    ]);

    const { panelEl, view } = createView();
    await flushAsync();
    view.setActiveItem("task-1");

    vi.useFakeTimers();
    const secondTab = panelEl.querySelectorAll(".wt-tab")[1] as HTMLElement;
    const secondLabel = secondTab.querySelector(".wt-tab-label") as HTMLElement;

    // Simulate real browser behavior: click, click, dblclick
    secondTab.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, detail: 1 }));
    secondTab.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, detail: 2 }));
    secondLabel.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true }));

    // The delayed switch should have been cancelled
    vi.advanceTimersByTime(250);

    // switchToTab should be called exactly once (from the dblclick handler), not twice
    const switchCalls = mockState.tabManagerCalls.filter((c) => c.startsWith("switchToTab:"));
    expect(switchCalls).toEqual(["switchToTab:1"]);

    // Rename input should be present
    expect(panelEl.querySelector(".wt-tab-rename-input")).not.toBeNull();
    vi.useRealTimers();
  });

  it("shows a notice when a spawn button launch rejects", async () => {
    const { panelEl, view } = createView();
    await flushAsync();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const spawnShell = vi.spyOn(view as any, "spawnShell").mockRejectedValue(new Error("boom"));

    (panelEl.querySelector(".wt-spawn-btn") as HTMLButtonElement).click();
    await flushAsync();

    expect(spawnShell).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledWith(
      "[work-terminal] Failed to launch shell",
      expect.any(Error),
    );
    expect(mockState.notices).toContain("Failed to launch shell: boom");

    errorSpy.mockRestore();
  });

  it("shows a notice instead of launching Claude when the CLI is unavailable", async () => {
    const { view } = createView({
      "core.claudeCommand": "definitely-not-a-real-command-issue-158",
    });
    await flushAsync();

    await (view as any).spawnAgentSession({ agentType: "claude", sessionType: "claude" });

    expect(mockState.latestCreateTabArgs).toBeNull();
    expect(mockState.notices).toContain(
      `Claude Code CLI not found for "definitely-not-a-real-command-issue-158". Install it first, for example with brew install --cask claude-code, then update Work Terminal's Claude command setting if needed.`,
    );
  });

  it("shows a notice instead of launching Copilot when the CLI is unavailable", async () => {
    const { view } = createView({
      "core.copilotCommand": "definitely-not-a-real-command-issue-158",
    });
    await flushAsync();

    await (view as any).spawnAgentSession({ agentType: "copilot", sessionType: "copilot" });

    expect(mockState.latestCreateTabArgs).toBeNull();
    expect(mockState.notices).toContain(
      `GitHub Copilot CLI not found for "definitely-not-a-real-command-issue-158". Install it first, for example with brew install copilot-cli, then update Work Terminal's Copilot command setting if needed.`,
    );
  });

  it("reuses one settings snapshot for contextual Claude launch", async () => {
    const loadData = vi.fn(async () => ({ settings: {} }));
    const { view, plugin } = createView({}, { loadData });
    await flushAsync();
    (plugin.loadData as any).mockClear();
    (plugin.loadData as any)
      .mockResolvedValueOnce({
        settings: {
          "core.additionalAgentContext": "Prompt A for $title",
          "core.claudeCommand": "/bin/echo",
          "core.defaultTerminalCwd": "~/one",
        },
      })
      .mockResolvedValueOnce({
        settings: {
          "core.additionalAgentContext": "Prompt B for $title",
          "core.claudeCommand": "/bin/false",
          "core.defaultTerminalCwd": "~/two",
        },
      });
    mockState.activeItemId = "task-1";
    view.setItems([
      {
        id: "task-1",
        title: "Task One",
        state: "doing",
        path: "Tasks/task-1.md",
      } as any,
    ]);

    await (view as any).spawnClaudeWithContext();

    expect(plugin.loadData).toHaveBeenCalledOnce();
    expect(mockState.latestCreateTabArgs).not.toBeNull();
    expect(mockState.latestCreateTabArgs?.[0]).toBe("/bin/echo");
    expect(mockState.latestCreateTabArgs?.[1]).toBe(expandTilde("~/one"));
    expect(mockState.latestCreateTabArgs?.[5]).toEqual(
      expect.arrayContaining([expect.stringContaining("Prompt A for Task One")]),
    );
    expect(mockState.latestCreateTabArgs?.[5]).not.toEqual(
      expect.arrayContaining([expect.stringContaining("Prompt B for Task One")]),
    );
  });

  it("falls back to adapter prompt for Claude-with-context when no template is configured", async () => {
    mockState.activeItemId = "task-1";
    const promptBuilder = {
      buildPrompt: vi.fn((_item, fullPath) => `Built prompt for ${fullPath}`),
    };
    const { view } = createView(
      {
        "core.claudeCommand": "/bin/echo",
        "core.defaultTerminalCwd": "~/ctx",
      },
      {},
      promptBuilder,
    );
    view.setItems([
      {
        id: "task-1",
        title: "Task One",
        state: "doing",
        path: "Tasks/task-1.md",
      } as any,
    ]);
    await flushAsync();

    await (view as any).spawnClaudeWithContext();

    expect(promptBuilder.buildPrompt).toHaveBeenCalledOnce();
    expect(mockState.latestCreateTabArgs?.[5]).toEqual([
      "/bin/echo",
      "Built prompt for /vault/Tasks/task-1.md",
    ]);
  });

  it("falls back to adapter prompt for Claude-with-context when template is whitespace only", async () => {
    mockState.activeItemId = "task-1";
    const promptBuilder = {
      buildPrompt: vi.fn((_item, fullPath) => `Built prompt for ${fullPath}`),
    };
    const { view } = createView(
      {
        "core.additionalAgentContext": "  \n\t  ",
        "core.claudeCommand": "/bin/echo",
        "core.defaultTerminalCwd": "~/ctx",
      },
      {},
      promptBuilder,
    );
    view.setItems([
      {
        id: "task-1",
        title: "Task One",
        state: "doing",
        path: "Tasks/task-1.md",
      } as any,
    ]);
    await flushAsync();

    await (view as any).spawnClaudeWithContext();

    expect(promptBuilder.buildPrompt).toHaveBeenCalledOnce();
    expect(mockState.latestCreateTabArgs?.[5]).toEqual([
      "/bin/echo",
      "Built prompt for /vault/Tasks/task-1.md",
    ]);
  });

  it("combines adapter prompt and context template for Claude-with-context sessions", async () => {
    mockState.activeItemId = "task-1";
    const promptBuilder = {
      buildPrompt: vi.fn(() => "Built prompt"),
    };
    const { view } = createView(
      {
        "core.additionalAgentContext": "Template for $title in $state",
        "core.claudeCommand": "/bin/echo",
        "core.defaultTerminalCwd": "~/ctx",
      },
      {},
      promptBuilder,
    );
    view.setItems([
      {
        id: "task-1",
        title: "Task One",
        state: "doing",
        path: "Tasks/task-1.md",
      } as any,
    ]);
    await flushAsync();

    await (view as any).spawnClaudeWithContext();

    expect(promptBuilder.buildPrompt).toHaveBeenCalledOnce();
    expect(mockState.latestCreateTabArgs?.[5]).toEqual([
      "/bin/echo",
      "Built prompt\n\nTemplate for Task One in doing",
    ]);
  });

  it("keeps template $filePath vault-relative and expands $absoluteFilePath to the resolved absolute path", async () => {
    mockState.activeItemId = "task-1";
    const promptBuilder = {
      buildPrompt: vi.fn(() => "Built prompt"),
    };
    const { view } = createView(
      {
        "core.additionalAgentContext": "Rel: $filePath\nAbs: $absoluteFilePath",
        "core.claudeCommand": "/bin/echo",
        "core.defaultTerminalCwd": "~/ctx",
      },
      {},
      promptBuilder,
    );
    view.setItems([
      {
        id: "task-1",
        title: "Task One",
        state: "doing",
        path: "Tasks/task-1.md",
      } as any,
    ]);
    await flushAsync();

    await (view as any).spawnClaudeWithContext();

    expect(promptBuilder.buildPrompt).toHaveBeenCalledOnce();
    expect(mockState.latestCreateTabArgs?.[5]).toEqual([
      "/bin/echo",
      "Built prompt\n\nRel: Tasks/task-1.md\nAbs: /vault/Tasks/task-1.md",
    ]);
  });

  it("launches the same prompt exposed by getClaudeContextPrompt", async () => {
    mockState.activeItemId = "task-1";
    const { view } = createView({
      "core.additionalAgentContext": "Template for $title in $state",
      "core.claudeCommand": "/bin/echo",
      "core.defaultTerminalCwd": "~/ctx",
    });
    const item = {
      id: "task-1",
      title: "Task One",
      state: "doing",
      path: "Tasks/task-1.md",
    } as any;
    view.setItems([item]);
    await flushAsync();

    const prompt = await (view as any).getClaudeContextPrompt(item);
    await (view as any).spawnClaudeWithContext();

    expect(mockState.latestCreateTabArgs?.[5]).toEqual(["/bin/echo", prompt]);
  });

  it("does not inject the context template into plain Claude sessions", async () => {
    mockState.activeItemId = "task-1";
    const { view } = createView({
      "core.additionalAgentContext": "Template path: $filePath",
      "core.claudeCommand": "/bin/echo",
      "core.defaultTerminalCwd": "~/ctx",
    });
    await flushAsync();

    await (view as any).spawnClaude();

    expect(mockState.latestCreateTabArgs?.[5]).toEqual(["/bin/echo"]);
  });

  it("injects context prompt into Copilot-with-context sessions", async () => {
    mockState.activeItemId = "task-1";
    const promptBuilder = {
      buildPrompt: vi.fn(() => "Built prompt"),
    };
    const { view } = createView(
      {
        "core.additionalAgentContext": "Template for $title in $state",
        "core.copilotCommand": "/bin/echo",
        "core.defaultTerminalCwd": "~/ctx",
      },
      {},
      promptBuilder,
    );
    view.setItems([
      {
        id: "task-1",
        title: "Task One",
        state: "doing",
        path: "Tasks/task-1.md",
      } as any,
    ]);
    await flushAsync();

    await (view as any).spawnAgentSession({
      agentType: "copilot",
      sessionType: "copilot-with-context",
    });

    expect(mockState.latestCreateTabArgs?.[5]).toEqual([
      "/bin/echo",
      "-i",
      "Built prompt\n\nTemplate for Task One in doing",
    ]);
  });

  it("does not inject context prompt into plain Copilot sessions", async () => {
    mockState.activeItemId = "task-1";
    const { view } = createView({
      "core.additionalAgentContext": "Template path: $filePath",
      "core.copilotCommand": "/bin/echo",
      "core.defaultTerminalCwd": "~/ctx",
    });
    view.setItems([
      {
        id: "task-1",
        title: "Task One",
        state: "doing",
        path: "Tasks/task-1.md",
      } as any,
    ]);
    await flushAsync();

    await (view as any).spawnAgentSession({ agentType: "copilot", sessionType: "copilot" });

    expect(mockState.latestCreateTabArgs?.[5]).toEqual(["/bin/echo"]);
  });

  it("injects context prompt into Strands-with-context sessions", async () => {
    mockState.activeItemId = "task-1";
    const promptBuilder = {
      buildPrompt: vi.fn(() => "Built prompt"),
    };
    const { view } = createView(
      {
        "core.additionalAgentContext": "Template for $title in $state",
        "core.strandsCommand": "/bin/echo",
        "core.defaultTerminalCwd": "~/ctx",
      },
      {},
      promptBuilder,
    );
    view.setItems([
      {
        id: "task-1",
        title: "Task One",
        state: "doing",
        path: "Tasks/task-1.md",
      } as any,
    ]);
    await flushAsync();

    await (view as any).spawnAgentSession({
      agentType: "strands",
      sessionType: "strands-with-context",
    });

    expect(mockState.latestCreateTabArgs?.[5]).toEqual([
      "/bin/echo",
      "Built prompt\n\nTemplate for Task One in doing",
    ]);
  });

  it("merges multiline continuation args from settings and custom launches", async () => {
    const { view } = createView({
      "core.claudeCommand": "/bin/echo",
      "core.defaultTerminalCwd": "~/ctx",
      "core.claudeExtraArgs": `--dangerously-skip-permissions \\
        --plugin-dir /path/a`,
    });
    await flushAsync();

    await (view as any).spawnAgentSession({
      agentType: "claude",
      sessionType: "claude",
      extraArgs: `--plugin-dir /path/b \\
        --verbose`,
      freshSettings: {
        "core.claudeCommand": "/bin/echo",
        "core.defaultTerminalCwd": "~/ctx",
        "core.claudeExtraArgs": `--dangerously-skip-permissions \\
          --plugin-dir /path/a`,
      },
    });

    expect(mockState.latestCreateTabArgs?.[5]).toEqual([
      "/bin/echo",
      "--dangerously-skip-permissions",
      "--plugin-dir",
      "/path/a",
      "--plugin-dir",
      "/path/b",
      "--verbose",
    ]);
  });

  it("hides the Claude-with-context button when no template is configured", async () => {
    const { panelEl } = createView({
      "core.additionalAgentContext": "",
    });
    await flushAsync();

    expect(panelEl.querySelector(".wt-spawn-claude-ctx")).toBeNull();
  });

  it("shows a notice instead of launching Strands when the configured command is blank", async () => {
    const { view } = createView({
      "core.strandsCommand": "   ",
      "core.defaultTerminalCwd": "~/one",
    });
    await flushAsync();

    await (view as any).spawnAgentSession({
      agentType: "strands",
      sessionType: "strands",
      freshSettings: {
        "core.strandsCommand": "   ",
        "core.defaultTerminalCwd": "~/one",
      },
    });

    expect(mockState.latestCreateTabArgs).toBeNull();
    expect(mockState.notices[0]).toContain("Strands agent not found");
  });

  it("treats Strands command as a simple binary path like Claude/Copilot", async () => {
    const { view } = createView({
      "core.strandsCommand": "/bin/echo",
      "core.strandsExtraArgs": "--mode interactive",
      "core.defaultTerminalCwd": "~/one",
    });
    await flushAsync();

    await (view as any).spawnAgentSession({
      agentType: "strands",
      sessionType: "strands",
      prompt: "Review this task",
      freshSettings: {
        "core.strandsCommand": "/bin/echo",
        "core.strandsExtraArgs": "--mode interactive",
        "core.defaultTerminalCwd": "~/one",
      },
    });

    expect(mockState.notices).toEqual([]);
    expect(mockState.latestCreateTabArgs).toEqual([
      "/bin/echo",
      expandTilde("~/one"),
      "Strands",
      "strands",
      undefined,
      ["/bin/echo", "--mode", "interactive", "Review this task"],
    ]);
  });

  it("copies session diagnostics to the clipboard", async () => {
    mockState.activeItemId = "Tasks/task-1.md";
    mockState.tabDiagnostics = [
      {
        tabId: "tab-1",
        itemId: "Tasks/task-1.md",
        tabIndex: 0,
        label: "Shell",
        sessionType: "shell",
        claudeState: "inactive",
        isVisible: true,
        isDisposed: false,
        isSelected: true,
        process: {
          pid: 50,
          status: "alive",
          killed: false,
          exitCode: null,
          signalCode: null,
          spawnTime: 1000,
          uptimeMs: 1000,
        },
        renderer: {
          canvasCount: 1,
          hasRenderableContent: true,
          hasBlankRenderSurface: false,
          trackedWebglAddonPresent: false,
          trackedWebglAddonDisposed: false,
          webglSuspended: false,
          staleDisposedWebglOwnership: false,
        },
        buffer: {
          screenLineCount: 1,
          screenTail: ["$"],
        },
        derived: {
          blankButLiveRenderer: false,
          staleDisposedWebglOwnership: false,
          disposedTabStillSelected: false,
        },
      },
    ];

    const { view } = createView();
    await flushAsync();

    await expect(view.copySessionDiagnostics()).resolves.toBe(true);
    expect(mockState.clipboardWriteText).toHaveBeenCalledTimes(1);
    expect(mockState.clipboardWriteText.mock.calls[0][0]).toContain('"activeTabCount": 1');
    expect(mockState.notices).toContain("Session diagnostics copied to clipboard");
  });

  it("keeps Windows absolute vault paths intact for Claude context prompts", async () => {
    const defaultElectronRequire = vi.mocked(electronRequire).getMockImplementation();
    const { view } = createView(
      {
        "core.additionalAgentContext": "Path: $absoluteFilePath",
      },
      {
        app: {
          setting: {
            open: vi.fn(),
            openTabById: vi.fn(),
          },
          vault: {
            adapter: {
              basePath: "C:\\Users\\me\\Vault",
            },
          },
        },
      },
    );
    await flushAsync();
    vi.mocked(electronRequire).mockImplementation((moduleName: string) =>
      moduleName === "path" ? path.win32 : defaultElectronRequire?.(moduleName),
    );

    try {
      const prompt = await (view as any).getAgentContextPrompt({
        id: "task-1",
        title: "Task One",
        state: "doing",
        path: "Tasks\\task-1.md",
      });

      expect(prompt).toBe("Path: C:\\Users\\me\\Vault\\Tasks\\task-1.md");
    } finally {
      if (defaultElectronRequire) {
        vi.mocked(electronRequire).mockImplementation(defaultElectronRequire);
      } else {
        vi.mocked(electronRequire).mockReset();
      }
    }
  });

  it("keeps UNC vault paths intact for Claude context prompts", async () => {
    const defaultElectronRequire = vi.mocked(electronRequire).getMockImplementation();
    const { view } = createView(
      {
        "core.additionalAgentContext": "Path: $absoluteFilePath",
      },
      {
        app: {
          setting: {
            open: vi.fn(),
            openTabById: vi.fn(),
          },
          vault: {
            adapter: {
              basePath: "\\\\server\\share\\Vault",
            },
          },
        },
      },
    );
    await flushAsync();
    vi.mocked(electronRequire).mockImplementation((moduleName: string) =>
      moduleName === "path" ? path.win32 : defaultElectronRequire?.(moduleName),
    );

    try {
      const prompt = await (view as any).getAgentContextPrompt({
        id: "task-1",
        title: "Task One",
        state: "doing",
        path: "Tasks\\task-1.md",
      });

      expect(prompt).toBe("Path: \\\\server\\share\\Vault\\Tasks\\task-1.md");
    } finally {
      if (defaultElectronRequire) {
        vi.mocked(electronRequire).mockImplementation(defaultElectronRequire);
      } else {
        vi.mocked(electronRequire).mockReset();
      }
    }
  });

  it("resolves pluginDir from a relative vault path using USERPROFILE semantics", async () => {
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = "";
    process.env.USERPROFILE = "C:\\Users\\me";

    try {
      const defaultElectronRequire = vi.mocked(electronRequire).getMockImplementation();
      vi.mocked(electronRequire).mockImplementation((moduleName: string) =>
        moduleName === "path" ? path.win32 : defaultElectronRequire?.(moduleName),
      );
      try {
        createView(
          {},
          {
            app: {
              setting: {
                open: vi.fn(),
                openTabById: vi.fn(),
              },
              vault: {
                adapter: {
                  basePath: "Vault",
                },
              },
            },
          },
        );
        await flushAsync();

        expect(mockState.latestTabManagerCtorArgs).not.toBeNull();
        expect(mockState.latestTabManagerCtorArgs?.[1]).toBe(
          "C:\\Users\\me\\Vault\\.obsidian\\plugins\\work-terminal",
        );
      } finally {
        if (defaultElectronRequire) {
          vi.mocked(electronRequire).mockImplementation(defaultElectronRequire);
        } else {
          vi.mocked(electronRequire).mockReset();
        }
      }
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      if (originalUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = originalUserProfile;
      }
    }
  });

  it("renders a Jira link badge ahead of the selected title and opens it externally", async () => {
    const { panelEl, view } = createView();
    await flushAsync();

    view.setTitle({
      id: "task-1",
      path: "Tasks/task-1.md",
      title: "Fix restart issue",
      state: "active",
      metadata: {
        color: "#005cc5",
        source: {
          type: "jira",
          id: "proj-1234",
          url: "https://example.atlassian.net/browse/PROJ-1234",
        },
      },
    });

    const jiraLink = panelEl.querySelector(".wt-task-jira-link") as HTMLAnchorElement | null;
    expect(jiraLink).not.toBeNull();
    expect(jiraLink?.textContent).toContain("PROJ-1234");
    expect(jiraLink?.textContent).toContain("\u2197");
    expect(panelEl.querySelector(".wt-task-title-text")?.textContent).toBe("Fix restart issue");
    expect(panelEl.querySelector(".wt-task-title")?.getAttribute("style")).toContain(
      "--wt-task-color: #005cc5",
    );

    jiraLink?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    expect(mockState.openExternal).toHaveBeenCalledWith(
      "https://example.atlassian.net/browse/PROJ-1234",
    );
  });

  it("logs a clear error when opening a Jira link externally throws", async () => {
    const { panelEl, view } = createView();
    await flushAsync();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockState.openExternal.mockImplementation(() => {
      throw new Error("shell unavailable");
    });

    view.setTitle({
      id: "task-1",
      path: "Tasks/task-1.md",
      title: "Fix restart issue",
      state: "active",
      metadata: {
        source: {
          type: "jira",
          id: "proj-1234",
          url: "https://example.atlassian.net/browse/PROJ-1234",
        },
      },
    });

    const jiraLink = panelEl.querySelector(".wt-task-jira-link") as HTMLAnchorElement | null;
    expect(jiraLink).not.toBeNull();

    expect(() =>
      jiraLink?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })),
    ).not.toThrow();

    expect(errorSpy).toHaveBeenCalledWith(
      "[work-terminal] Failed to open Jira link externally: https://example.atlassian.net/browse/PROJ-1234",
      expect.any(Error),
    );

    errorSpy.mockRestore();
  });

  it("logs a clear error when opening a Jira link externally rejects", async () => {
    const { panelEl, view } = createView();
    await flushAsync();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockState.openExternal.mockRejectedValue(new Error("openExternal rejected"));

    view.setTitle({
      id: "task-1",
      path: "Tasks/task-1.md",
      title: "Fix restart issue",
      state: "active",
      metadata: {
        source: {
          type: "jira",
          id: "proj-1234",
          url: "https://example.atlassian.net/browse/PROJ-1234",
        },
      },
    });

    const jiraLink = panelEl.querySelector(".wt-task-jira-link") as HTMLAnchorElement | null;
    expect(jiraLink).not.toBeNull();

    jiraLink?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await flushAsync();

    expect(errorSpy).toHaveBeenCalledWith(
      "[work-terminal] Failed to open Jira link externally: https://example.atlassian.net/browse/PROJ-1234",
      expect.any(Error),
    );

    errorSpy.mockRestore();
  });

  it("shows only the title text when the selected item has no Jira source", async () => {
    const { panelEl, view } = createView();
    await flushAsync();

    view.setTitle({
      id: "task-2",
      path: "Tasks/task-2.md",
      title: "Plain task",
      state: "todo",
      metadata: {
        source: {
          type: "prompt",
          id: "",
          url: "",
        },
      },
    });

    expect(panelEl.querySelector(".wt-task-jira-link")).toBeNull();
    expect(panelEl.querySelector(".wt-task-title-text")?.textContent).toBe("Plain task");
  });
});

describe("profile launch", () => {
  let dom: JSDOM;

  beforeEach(() => {
    dom = new JSDOM("<!doctype html><html><body></body></html>");
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
    vi.stubGlobal("Element", dom.window.Element);
    vi.stubGlobal("Node", dom.window.Node);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    installDomHelpers({
      window: dom.window,
      document: dom.window.document,
      HTMLElement: dom.window.HTMLElement,
      Element: dom.window.Element,
      Node: dom.window.Node,
    });

    mockState.activeSessions = new Map();
    mockState.activeTabs = [];
    mockState.activeItemId = null;
    mockState.tabsByItem = new Map();
    mockState.activeTabIndex = 0;
    mockState.tabDiagnostics = [];
    mockState.idleSinceByItem = new Map();
    mockState.menuTitles = [];
    mockState.menuActions = new Map();
    mockState.notices = [];
    mockState.clipboardWriteText.mockClear();
    mockState.latestCreateTabArgs = null;
    mockState.tabManagerCalls = [];
    mockState.openExternal.mockClear();
    mockState.latestTabManager = null;
    mockState.latestTabManagerCtorArgs = null;
  });

  afterEach(() => {
    while (createdViews.length > 0) {
      createdViews.pop()?.disposeAll();
    }
    vi.unstubAllGlobals();
    dom.window.close();
  });

  function makeProfile(overrides: Record<string, unknown> = {}) {
    return {
      id: "profile-1",
      name: "Claude",
      agentType: "claude",
      command: "claude",
      defaultCwd: "~/projects",
      arguments: "--model opus",
      contextPrompt: "",
      useContext: false,
      button: { enabled: true, label: "Claude", icon: "claude", borderStyle: "solid" },
      sortOrder: 0,
      ...overrides,
    };
  }

  it("applies defaultCwd override in spawnFromProfileWithOverrides", async () => {
    const { view } = createView();
    await flushAsync();

    const spawnSpy = vi.spyOn(view as any, "spawnFromProfile").mockResolvedValue(undefined);
    const profile = makeProfile();

    await (view as any).spawnFromProfileWithOverrides({
      profile,
      cwd: "~/override-dir",
      extraArgs: "",
      label: "",
    });

    expect(spawnSpy).toHaveBeenCalledOnce();
    const passedProfile = spawnSpy.mock.calls[0][0];
    expect(passedProfile.defaultCwd).toBe("~/override-dir");
    expect(passedProfile.arguments).toBe("--model opus");
  });

  it("appends extra arguments in spawnFromProfileWithOverrides", async () => {
    const { view } = createView();
    await flushAsync();

    const spawnSpy = vi.spyOn(view as any, "spawnFromProfile").mockResolvedValue(undefined);
    const profile = makeProfile();

    await (view as any).spawnFromProfileWithOverrides({
      profile,
      cwd: "",
      extraArgs: "--verbose",
      label: "",
    });

    expect(spawnSpy).toHaveBeenCalledOnce();
    const passedProfile = spawnSpy.mock.calls[0][0];
    expect(passedProfile.arguments).toBe("--model opus --verbose");
    expect(passedProfile.defaultCwd).toBe("~/projects");
  });

  it("sets extra arguments as-is when profile has no existing arguments", async () => {
    const { view } = createView();
    await flushAsync();

    const spawnSpy = vi.spyOn(view as any, "spawnFromProfile").mockResolvedValue(undefined);
    const profile = makeProfile({ arguments: "" });

    await (view as any).spawnFromProfileWithOverrides({
      profile,
      cwd: "",
      extraArgs: "--fast",
      label: "",
    });

    const passedProfile = spawnSpy.mock.calls[0][0];
    expect(passedProfile.arguments).toBe("--fast");
  });

  it("applies label override to button.label", async () => {
    const { view } = createView();
    await flushAsync();

    const spawnSpy = vi.spyOn(view as any, "spawnFromProfile").mockResolvedValue(undefined);
    const profile = makeProfile();

    await (view as any).spawnFromProfileWithOverrides({
      profile,
      cwd: "",
      extraArgs: "",
      label: "My Custom Label",
    });

    const passedProfile = spawnSpy.mock.calls[0][0];
    expect(passedProfile.button.label).toBe("My Custom Label");
  });

  it("preserves original profile values when overrides are empty", async () => {
    const { view } = createView();
    await flushAsync();

    const spawnSpy = vi.spyOn(view as any, "spawnFromProfile").mockResolvedValue(undefined);
    const profile = makeProfile();

    await (view as any).spawnFromProfileWithOverrides({
      profile,
      cwd: "",
      extraArgs: "",
      label: "",
    });

    const passedProfile = spawnSpy.mock.calls[0][0];
    expect(passedProfile.defaultCwd).toBe("~/projects");
    expect(passedProfile.arguments).toBe("--model opus");
    expect(passedProfile.button.label).toBe("Claude");
  });

  it("shows a notice when openProfileLaunchModal is called without an active item", async () => {
    const { view } = createView();
    await flushAsync();

    mockState.activeItemId = null;
    await (view as any).openProfileLaunchModal();

    expect(mockState.notices).toContain("Select a task first to launch a profile");
  });

  it("shows a notice when no profiles are configured", async () => {
    const { view } = createView();
    await flushAsync();

    mockState.activeItemId = "task-1";
    (view as any).allItems = [{ id: "task-1", title: "Task", state: "doing", path: "t.md" }];
    (view as any).profileManager = { getProfiles: () => [] };

    await (view as any).openProfileLaunchModal();

    expect(mockState.notices).toContain(
      "No agent profiles configured. Open Settings to create one.",
    );
  });

  it("calls promptBuilder.buildPrompt (not .build) for context profiles", async () => {
    const promptBuilder = {
      buildPrompt: vi.fn(() => "adapter prompt"),
    };
    const { view } = createView({}, {}, promptBuilder);
    await flushAsync();

    mockState.activeItemId = "task-1";
    (view as any).allItems = [
      { id: "task-1", title: "Task", state: "doing", path: "Tasks/task-1.md" },
    ];
    (view as any).profileManager = {
      resolveCommand: () => "copilot",
      resolveCwd: () => "~/projects",
      resolveArguments: () => "",
      resolveContextPrompt: () => "Context for $title",
    };

    const spawnAgentSpy = vi.spyOn(view as any, "spawnAgentSession").mockResolvedValue(undefined);

    await (view as any).spawnFromProfile(
      makeProfile({
        agentType: "copilot",
        useContext: true,
        contextPrompt: "Context for $title",
      }),
    );

    expect(promptBuilder.buildPrompt).toHaveBeenCalledOnce();
    expect(spawnAgentSpy).toHaveBeenCalledOnce();
    const callArgs = spawnAgentSpy.mock.calls[0][0];
    expect(callArgs.prompt).toContain("adapter prompt");
    expect(callArgs.prompt).toContain("Context for Task");
  });

  it("excludes adapter base prompt when suppressAdapterPrompt is true", async () => {
    const promptBuilder = {
      buildPrompt: vi.fn(() => "adapter prompt"),
    };
    const { view } = createView(
      { "core.additionalAgentContext": "Template for $title" },
      {},
      promptBuilder,
    );
    await flushAsync();

    mockState.activeItemId = "task-1";
    (view as any).allItems = [
      { id: "task-1", title: "Task", state: "doing", path: "Tasks/task-1.md" },
    ];
    (view as any).profileManager = {
      resolveCommand: () => "claude",
      resolveCwd: () => "~/projects",
      resolveArguments: () => "",
      resolveContextPrompt: () => "",
    };

    const spawnAgentSpy = vi.spyOn(view as any, "spawnAgentSession").mockResolvedValue(undefined);

    await (view as any).spawnFromProfile(
      makeProfile({
        useContext: true,
        suppressAdapterPrompt: true,
        contextPrompt: "",
      }),
    );

    expect(promptBuilder.buildPrompt).not.toHaveBeenCalled();
    expect(spawnAgentSpy).toHaveBeenCalledOnce();
    const callArgs = spawnAgentSpy.mock.calls[0][0];
    // Should contain only the template, not the adapter prompt
    expect(callArgs.prompt).not.toContain("adapter prompt");
    expect(callArgs.prompt).toContain("Template for Task");
  });

  it("excludes adapter base prompt from profile context template when suppressAdapterPrompt is true", async () => {
    const promptBuilder = {
      buildPrompt: vi.fn(() => "adapter prompt"),
    };
    const { view } = createView({}, {}, promptBuilder);
    await flushAsync();

    mockState.activeItemId = "task-1";
    (view as any).allItems = [
      { id: "task-1", title: "Task", state: "doing", path: "Tasks/task-1.md" },
    ];
    (view as any).profileManager = {
      resolveCommand: () => "claude",
      resolveCwd: () => "~/projects",
      resolveArguments: () => "",
      resolveContextPrompt: () => "Custom prompt for $title",
    };

    const spawnAgentSpy = vi.spyOn(view as any, "spawnAgentSession").mockResolvedValue(undefined);

    await (view as any).spawnFromProfile(
      makeProfile({
        useContext: true,
        suppressAdapterPrompt: true,
        contextPrompt: "Custom prompt for $title",
      }),
    );

    expect(promptBuilder.buildPrompt).not.toHaveBeenCalled();
    expect(spawnAgentSpy).toHaveBeenCalledOnce();
    const callArgs = spawnAgentSpy.mock.calls[0][0];
    expect(callArgs.prompt).toBe("Custom prompt for Task");
    expect(callArgs.prompt).not.toContain("adapter prompt");
  });

  it("launches without aborting when suppressAdapterPrompt is true and no template exists", async () => {
    const promptBuilder = {
      buildPrompt: vi.fn(() => "adapter prompt"),
    };
    const { view } = createView({}, {}, promptBuilder);
    await flushAsync();

    mockState.activeItemId = "task-1";
    (view as any).allItems = [
      { id: "task-1", title: "Task", state: "doing", path: "Tasks/task-1.md" },
    ];
    (view as any).profileManager = {
      resolveCommand: () => "claude",
      resolveCwd: () => "~/projects",
      resolveArguments: () => "",
      resolveContextPrompt: () => "",
    };

    const spawnAgentSpy = vi.spyOn(view as any, "spawnAgentSession").mockResolvedValue(undefined);

    await (view as any).spawnFromProfile(
      makeProfile({
        useContext: true,
        suppressAdapterPrompt: true,
        contextPrompt: "",
      }),
    );

    // Should NOT abort - spawnAgentSession should be called
    expect(spawnAgentSpy).toHaveBeenCalledOnce();
    const callArgs = spawnAgentSpy.mock.calls[0][0];
    // prompt should be empty string (not undefined) so spawnAgentSession
    // won't auto-build a context prompt from the adapter
    expect(callArgs.prompt).toBe("");
    expect(promptBuilder.buildPrompt).not.toHaveBeenCalled();
  });

  it("does not auto-build adapter prompt in spawnAgentSession when suppressAdapterPrompt with no template", async () => {
    const promptBuilder = {
      buildPrompt: vi.fn(() => "adapter prompt"),
    };
    const { view } = createView({}, {}, promptBuilder);
    await flushAsync();

    mockState.activeItemId = "task-1";
    (view as any).allItems = [
      { id: "task-1", title: "Task", state: "doing", path: "Tasks/task-1.md" },
    ];
    (view as any).profileManager = {
      resolveCommand: () => "claude",
      resolveCwd: () => "~/projects",
      resolveArguments: () => "",
      resolveContextPrompt: () => "",
    };

    // Add getButtonProfiles so renderTabBar (called at end of spawnAgentSession) works
    (view as any).profileManager.getButtonProfiles = () => [];

    // Do NOT mock spawnAgentSession - let it run through to createTab
    const resolveStub = vi
      .spyOn(AgentLauncher, "resolveCommandInfo")
      .mockReturnValue({ found: true, resolved: "claude" });

    await (view as any).spawnFromProfile(
      makeProfile({
        useContext: true,
        suppressAdapterPrompt: true,
        contextPrompt: "",
      }),
    );

    // spawnAgentSession should have called createTab
    expect(mockState.tabManagerCalls).toContain("createTab");
    // The full command array (6th arg, index 5) should not contain the adapter prompt
    const cmdArray = mockState.latestCreateTabArgs?.[5] as string[];
    expect(cmdArray).toBeDefined();
    const joinedArgs = cmdArray.join(" ");
    expect(joinedArgs).not.toContain("adapter prompt");
    // buildPrompt should never have been called
    expect(promptBuilder.buildPrompt).not.toHaveBeenCalled();

    resolveStub.mockRestore();
  });

  it("always passes arguments on launch", async () => {
    const { view } = createView();
    await flushAsync();

    mockState.activeItemId = "task-1";
    (view as any).allItems = [
      { id: "task-1", title: "Task", state: "doing", path: "Tasks/task-1.md" },
    ];
    (view as any).profileManager = {
      resolveCommand: () => "claude",
      resolveCwd: () => "~/projects",
      resolveArguments: () => "--model opus",
      resolveContextPrompt: () => "",
    };

    const spawnAgentSpy = vi.spyOn(view as any, "spawnAgentSession").mockResolvedValue(undefined);

    await (view as any).spawnFromProfile(makeProfile({ arguments: "--model opus" }));

    expect(spawnAgentSpy).toHaveBeenCalledOnce();
    const callArgs = spawnAgentSpy.mock.calls[0][0];
    expect(callArgs.extraArgs).toBe("--model opus");
  });

  it("always passes arguments and prompt on launch when useContext is enabled", async () => {
    const promptBuilder = {
      buildPrompt: vi.fn(() => "adapter prompt"),
    };
    const { view } = createView({}, {}, promptBuilder);
    await flushAsync();

    mockState.activeItemId = "task-1";
    (view as any).allItems = [
      { id: "task-1", title: "Task", state: "doing", path: "Tasks/task-1.md" },
    ];
    (view as any).profileManager = {
      resolveCommand: () => "claude",
      resolveCwd: () => "~/projects",
      resolveArguments: () => "--verbose",
      resolveContextPrompt: () => "Context for $title",
    };

    const spawnAgentSpy = vi.spyOn(view as any, "spawnAgentSession").mockResolvedValue(undefined);

    await (view as any).spawnFromProfile(
      makeProfile({
        useContext: true,
        arguments: "--verbose",
        contextPrompt: "Context for $title",
      }),
    );

    expect(promptBuilder.buildPrompt).toHaveBeenCalledOnce();
    expect(spawnAgentSpy).toHaveBeenCalledOnce();
    const callArgs = spawnAgentSpy.mock.calls[0][0];
    expect(callArgs.extraArgs).toBe("--verbose");
    expect(callArgs.prompt).toContain("adapter prompt");
    expect(callArgs.prompt).toContain("Context for Task");
  });

  it("passes loginShellWrap to spawnAgentSession when profile has it enabled", async () => {
    const { view } = createView();
    await flushAsync();

    mockState.activeItemId = "task-1";
    (view as any).allItems = [
      { id: "task-1", title: "Task", state: "doing", path: "Tasks/task-1.md" },
    ];
    (view as any).profileManager = {
      resolveCommand: () => "pi",
      resolveCwd: () => "~/projects",
      resolveArguments: () => "",
      resolveContextPrompt: () => "",
    };

    const spawnAgentSpy = vi.spyOn(view as any, "spawnAgentSession").mockResolvedValue(undefined);

    await (view as any).spawnFromProfile(
      makeProfile({
        agentType: "custom",
        command: "pi",
        loginShellWrap: true,
      }),
    );

    expect(spawnAgentSpy).toHaveBeenCalledOnce();
    const callArgs = spawnAgentSpy.mock.calls[0][0];
    expect(callArgs.loginShellWrap).toBe(true);
    expect(callArgs.command).toBe("pi");
  });

  it("does not pass loginShellWrap when profile has it disabled", async () => {
    const { view } = createView();
    await flushAsync();

    mockState.activeItemId = "task-1";
    (view as any).allItems = [
      { id: "task-1", title: "Task", state: "doing", path: "Tasks/task-1.md" },
    ];
    (view as any).profileManager = {
      resolveCommand: () => "claude",
      resolveCwd: () => "~/projects",
      resolveArguments: () => "",
      resolveContextPrompt: () => "",
    };

    const spawnAgentSpy = vi.spyOn(view as any, "spawnAgentSession").mockResolvedValue(undefined);

    await (view as any).spawnFromProfile(makeProfile({ loginShellWrap: false }));

    expect(spawnAgentSpy).toHaveBeenCalledOnce();
    const callArgs = spawnAgentSpy.mock.calls[0][0];
    expect(callArgs.loginShellWrap).toBe(false);
  });

  it("uses unresolved command name in commandArgs when loginShellWrap is true", async () => {
    const resolveStub = vi
      .spyOn(AgentLauncher, "resolveCommandInfo")
      .mockReturnValue({ requested: "pi", found: true, resolved: "/usr/local/bin/pi" });

    const { view } = createView({
      "core.defaultTerminalCwd": "~/projects",
    });
    await flushAsync();

    (view as any).profileManager = {
      getButtonProfiles: () => [],
      getProfile: () => null,
    };

    const tab = await (view as any).spawnAgentSession({
      agentType: "custom",
      sessionType: "custom",
      command: "pi",
      loginShellWrap: true,
    });

    expect(mockState.tabManagerCalls).toContain("createTab");
    const commandArgs = mockState.latestCreateTabArgs?.[5] as string[];
    expect(commandArgs).toBeDefined();
    // commandArgs[0] should be the unresolved name, not the absolute path
    expect(commandArgs[0]).toBe("pi");
    expect(commandArgs[0]).not.toBe("/usr/local/bin/pi");

    resolveStub.mockRestore();
  });

  it("uses resolved command in commandArgs when loginShellWrap is false", async () => {
    const resolveStub = vi
      .spyOn(AgentLauncher, "resolveCommandInfo")
      .mockReturnValue({ requested: "claude", found: true, resolved: "/usr/local/bin/claude" });

    const { view } = createView({
      "core.defaultTerminalCwd": "~/projects",
    });
    await flushAsync();

    (view as any).profileManager = {
      getButtonProfiles: () => [],
      getProfile: () => null,
    };

    await (view as any).spawnAgentSession({
      agentType: "claude",
      sessionType: "claude",
      command: "claude",
      loginShellWrap: false,
    });

    expect(mockState.tabManagerCalls).toContain("createTab");
    const commandArgs = mockState.latestCreateTabArgs?.[5] as string[];
    expect(commandArgs).toBeDefined();
    expect(commandArgs[0]).toBe("/usr/local/bin/claude");

    resolveStub.mockRestore();
  });

  it("trims whitespace from unresolved command in loginShellWrap mode", async () => {
    const resolveStub = vi
      .spyOn(AgentLauncher, "resolveCommandInfo")
      .mockReturnValue({ requested: " pi ", found: true, resolved: "/usr/local/bin/pi" });

    const { view } = createView({
      "core.defaultTerminalCwd": "~/projects",
    });
    await flushAsync();

    (view as any).profileManager = {
      getButtonProfiles: () => [],
      getProfile: () => null,
    };

    await (view as any).spawnAgentSession({
      agentType: "custom",
      sessionType: "custom",
      command: " pi ",
      loginShellWrap: true,
    });

    expect(mockState.tabManagerCalls).toContain("createTab");
    const commandArgs = mockState.latestCreateTabArgs?.[5] as string[];
    expect(commandArgs).toBeDefined();
    expect(commandArgs[0]).toBe("pi");

    resolveStub.mockRestore();
  });
});
