import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import * as path from "node:path";
import type { ActiveTabInfo, PersistedSession, TabDiagnostics } from "../core/session/types";
import { SessionPersistence } from "../core/session/SessionPersistence";
import type { WorkItemPromptBuilder } from "../core/interfaces";
import { electronRequire, expandTilde } from "../core/utils";
import { TerminalPanelView } from "./TerminalPanelView";

const createdViews: TerminalPanelView[] = [];

const mockState = vi.hoisted(() => ({
  activeSessions: new Map<string, Array<{ sessionType: string }>>(),
  activeTabs: [] as ActiveTabInfo[],
  activeItemId: null as string | null,
  tabsByItem: new Map<string, any[]>(),
  activeTabIndex: 0,
  persistedSessions: [] as PersistedSession[],
  tabDiagnostics: [] as TabDiagnostics[],
  idleSinceByItem: new Map<string, number>(),
  menuTitles: [] as string[],
  menuActions: new Map<string, () => void>(),
  notices: [] as string[],
  clipboardWriteText: vi.fn(),
  latestCreateTabArgs: null as unknown[] | null,
  tabManagerCalls: [] as string[],
  hookStatus: {
    scriptExists: false,
    hooksConfigured: false,
  },
  openExternal: vi.fn(),
  latestTabManager: null as {
    onSessionChange?: () => void;
    onClaudeStateChange?: (itemId: string, state: string) => void;
    onPersistRequest?: () => void;
  } | null,
  stopPeriodicPersist: vi.fn(),
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
    onClaudeStateChange?: (itemId: string, state: string) => void;
    onPersistRequest?: () => void;

    constructor(_terminalWrapperEl: HTMLElement) {
      mockState.latestTabManager = this;
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

    getActiveSessionIds() {
      return new Set(
        mockState.activeTabs.flatMap((tab) => (tab.sessionId ? [tab.sessionId] : [])),
      );
    }

    getClaudeState() {
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
  },
}));

vi.mock("../core/session/SessionPersistence", () => ({
  PERSIST_INTERVAL_MS: 30000,
  SessionPersistence: {
    startPeriodicPersist: vi.fn(() => mockState.stopPeriodicPersist),
    loadFromDisk: vi.fn(async () => mockState.persistedSessions),
    buildPersistedSessions: vi.fn((sessions: Map<string, any[]>) => {
      const persisted: PersistedSession[] = [];
      for (const [taskPath, tabs] of sessions) {
        for (const tab of tabs) {
          if (tab.isResumableAgent && tab.claudeSessionId) {
            persisted.push({
              version: 1,
              taskPath,
              claudeSessionId: tab.claudeSessionId,
              label: tab.label,
              sessionType: tab.sessionType,
              savedAt: "2026-03-28T20:00:00.000Z",
            });
          }
        }
      }
      return persisted;
    }),
    setPersistedSessions: vi.fn(),
  },
}));

vi.mock("../core/claude/ClaudeHookManager", () => ({
  checkHookStatus: vi.fn(() => mockState.hookStatus),
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

async function flushAsync() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function makePersistedSession(sessionType: PersistedSession["sessionType"]): PersistedSession {
  return {
    version: 1,
    taskPath: "Tasks/task-1.md",
    claudeSessionId: "session-1",
    label: "Session",
    sessionType,
    savedAt: "2026-03-28T20:00:00.000Z",
  };
}

describe("TerminalPanelView hook warning", () => {
  let dom: JSDOM;

  beforeEach(() => {
    dom = new JSDOM("<!doctype html><html><body></body></html>");
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
    vi.stubGlobal("Element", dom.window.Element);
    vi.stubGlobal("Node", dom.window.Node);
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
    mockState.persistedSessions = [];
    mockState.tabDiagnostics = [];
    mockState.idleSinceByItem = new Map();
    mockState.menuTitles = [];
    mockState.menuActions = new Map();
    mockState.notices = [];
    mockState.clipboardWriteText.mockClear();
    mockState.latestCreateTabArgs = null;
    mockState.tabManagerCalls = [];
    mockState.hookStatus = { scriptExists: false, hooksConfigured: false };
    mockState.openExternal.mockClear();
    mockState.latestTabManager = null;
    mockState.stopPeriodicPersist.mockClear();
  });

  afterEach(() => {
    while (createdViews.length > 0) {
      createdViews.pop()?.disposeAll();
    }
    vi.unstubAllGlobals();
    dom.window.close();
  });

  it("hides the warning when only Copilot sessions exist", async () => {
    mockState.activeSessions.set("task-1", [{ sessionType: "copilot" }]);

    const { panelEl } = createView();
    await flushAsync();

    expect(panelEl.querySelector(".wt-hook-warning-banner")).toBeNull();
  });

  it("shows the warning when an active Claude session exists", async () => {
    mockState.activeSessions.set("task-1", [{ sessionType: "claude" }]);

    const { panelEl } = createView();
    await flushAsync();

    expect(panelEl.querySelector(".wt-hook-warning-banner")?.textContent).toContain(
      "Claude /resume tracking requires Claude hooks",
    );
  });

  it("shows the warning when persisted Claude resume state exists", async () => {
    mockState.persistedSessions = [makePersistedSession("claude")];

    const { panelEl } = createView();
    await flushAsync();

    expect(panelEl.querySelector(".wt-hook-warning-banner")).not.toBeNull();
  });

  it("hides the warning when persisted sessions are Copilot-only", async () => {
    mockState.persistedSessions = [makePersistedSession("copilot")];

    const { panelEl } = createView();
    await flushAsync();

    expect(panelEl.querySelector(".wt-hook-warning-banner")).toBeNull();
  });

  it("re-checks when session mix changes so Claude usage starts warning immediately", async () => {
    const { panelEl } = createView();
    await flushAsync();
    expect(panelEl.querySelector(".wt-hook-warning-banner")).toBeNull();

    mockState.activeSessions.set("task-1", [{ sessionType: "claude-with-context" }]);
    mockState.latestTabManager?.onSessionChange?.();
    await flushAsync();

    expect(panelEl.querySelector(".wt-hook-warning-banner")).not.toBeNull();
  });

  it("keeps the warning hidden after dismissal even with Claude sessions", async () => {
    mockState.activeSessions.set("task-1", [{ sessionType: "claude" }]);

    const { panelEl } = createView({ "core.acceptNoResumeHooks": true });
    await flushAsync();

    expect(panelEl.querySelector(".wt-hook-warning-banner")).toBeNull();
  });

  it("replays a skipped startup check after persisted Claude sessions finish loading", async () => {
    mockState.persistedSessions = [makePersistedSession("claude")];

    let resolveLoadData: ((value: { settings: Record<string, unknown> }) => void) | null = null;
    const loadData = vi.fn(
      () =>
        new Promise<{ settings: Record<string, unknown> }>((resolve) => {
          resolveLoadData = resolve;
        }),
    );

    const { panelEl } = createView({}, { loadData });
    await Promise.resolve();

    expect(panelEl.querySelector(".wt-hook-warning-banner")).toBeNull();
    resolveLoadData?.({ settings: {} });
    await flushAsync();

    expect(panelEl.querySelector(".wt-hook-warning-banner")).not.toBeNull();
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
        sessionId: null,
        sessionType: "shell",
        isResumableAgent: false,
      },
      {
        tabId: "tab-2",
        itemId: "task-2",
        label: "Automatic Issues",
        sessionId: "copilot-123",
        sessionType: "copilot",
        isResumableAgent: true,
      },
    ];
    mockState.persistedSessions = [makePersistedSession("copilot")];

    createView({ "core.exposeDebugApi": true });
    await flushAsync();

    expect(window.__workTerminalDebug?.activeItemId).toBe("task-2");
    expect(window.__workTerminalDebug?.activeTabs).toEqual(mockState.activeTabs);
    expect(window.__workTerminalDebug?.activeSessionIds).toEqual(["copilot-123"]);
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
        sessionId: "session-9",
        sessionType: "claude",
        isResumableAgent: true,
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

  it("revokes captured debug references when the setting is disabled", async () => {
    mockState.activeItemId = "task-2";
    mockState.activeTabs = [
      {
        tabId: "tab-2",
        itemId: "task-2",
        label: "Automatic Issues",
        sessionId: "copilot-123",
        sessionType: "copilot",
        isResumableAgent: true,
      },
    ];

    createView({ "core.exposeDebugApi": true });
    await flushAsync();

    const debugRef = window.__workTerminalDebug;
    expect(debugRef?.activeItemId).toBe("task-2");

    window.dispatchEvent(
      new window.CustomEvent("work-terminal:settings-changed", {
        detail: {
          "core.defaultTerminalCwd": "~",
          "core.exposeDebugApi": false,
        },
      }),
    );
    await flushAsync();

    mockState.activeItemId = "task-9";
    mockState.activeTabs = [
      {
        tabId: "tab-9",
        itemId: "task-9",
        label: "Claude",
        sessionId: "claude-9",
        sessionType: "claude",
        isResumableAgent: true,
      },
    ];

    expect(debugRef?.activeItemId).toBeNull();
    expect(debugRef?.activeTabs).toEqual([]);
    expect(debugRef?.getSnapshot()).toMatchObject({
      activeItemId: null,
      activeSessionIds: [],
      persistedSessions: [],
    });
  });

  it("does not republish the debug global after disposal when persisted sessions finish loading", async () => {
    let resolvePersistedSessions: ((value: PersistedSession[]) => void) | null = null;
    vi.mocked(SessionPersistence.loadFromDisk).mockImplementationOnce(
      () =>
        new Promise<PersistedSession[]>((resolve) => {
          resolvePersistedSessions = resolve;
        }),
    );

    const { view } = createView({ "core.exposeDebugApi": true });
    await Promise.resolve();

    expect(window.__workTerminalDebug).toBeDefined();

    view.disposeAll();
    expect(window.__workTerminalDebug).toBeUndefined();

    resolvePersistedSessions?.([makePersistedSession("copilot")]);
    await flushAsync();

    expect(window.__workTerminalDebug).toBeUndefined();
  });

  it("does not republish the debug global after disposal when persistence finishes", async () => {
    let resolveSaveData: (() => void) | null = null;
    const saveData = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSaveData = resolve;
        }),
    );

    const { view } = createView({ "core.exposeDebugApi": true }, { saveData });
    const persistPromise = view.persistSessions();
    await flushAsync();

    expect(saveData).toHaveBeenCalledTimes(1);

    expect(window.__workTerminalDebug).toBeDefined();

    view.disposeAll();
    expect(window.__workTerminalDebug).toBeUndefined();

    resolveSaveData?.();
    await persistPromise;

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

  it("keeps loaded persisted sessions available after saving active sessions", async () => {
    mockState.persistedSessions = [makePersistedSession("copilot")];

    const { view } = createView({ "core.exposeDebugApi": true });
    await flushAsync();

    await view.persistSessions();

    expect(view.getPersistedSessions("Tasks/task-1.md")).toEqual(mockState.persistedSessions);
    expect(window.__workTerminalDebug?.persistedSessions).toEqual(mockState.persistedSessions);
  });

  it("refreshes persisted diagnostics immediately after saving active sessions", async () => {
    mockState.activeSessions = new Map([
      [
        "Tasks/task-1.md",
        [
          {
            label: "Automatic Issues",
            taskPath: "Tasks/task-1.md",
            claudeSessionId: "copilot-123",
            isResumableAgent: true,
            sessionType: "copilot",
          },
        ],
      ],
    ]) as any;
    mockState.activeItemId = "Tasks/task-1.md";
    mockState.tabDiagnostics = [
      {
        tabId: "tab-1",
        itemId: "Tasks/task-1.md",
        tabIndex: 0,
        label: "Automatic Issues",
        sessionId: "copilot-123",
        sessionType: "copilot",
        claudeState: "idle",
        isResumableAgent: true,
        isVisible: true,
        isDisposed: false,
        isSelected: true,
        process: {
          pid: 100,
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
          staleDisposedWebglOwnership: false,
        },
        buffer: {
          screenLineCount: 1,
          screenTail: ["[redacted:5 chars]"],
        },
        recovery: {
          resumable: true,
          relaunchable: false,
          hasPersistedSession: false,
          canResumeAfterRestart: false,
          missingPersistedMetadata: true,
          wouldBeLostOnFullClose: false,
          lifecycle: "live",
        },
        derived: {
          blankButLiveRenderer: false,
          staleDisposedWebglOwnership: false,
          disposedTabStillSelected: false,
        },
      },
    ];

    const { view } = createView({ "core.exposeDebugApi": true });
    await flushAsync();

    await view.persistSessions();
    const snapshot = view.getSessionDiagnosticsSnapshot();

    expect(snapshot.persistedSessions).toHaveLength(1);
    expect(snapshot.items[0].tabs[0].recovery).toMatchObject({
      hasPersistedSession: true,
      canResumeAfterRestart: true,
      missingPersistedMetadata: false,
    });
  });

  it("builds session diagnostics with renderer and recovery flags", async () => {
    mockState.activeItemId = "Tasks/task-1.md";
    mockState.activeTabIndex = 0;
    mockState.idleSinceByItem.set("Tasks/task-1.md", 1234);
    mockState.tabDiagnostics = [
      {
        tabId: "tab-1",
        itemId: "Tasks/task-1.md",
        tabIndex: 0,
        label: "Automatic Issues",
        sessionId: "copilot-123",
        sessionType: "copilot",
        claudeState: "idle",
        isResumableAgent: true,
        isVisible: true,
        isDisposed: false,
        isSelected: true,
        process: {
          pid: 123,
          status: "alive",
          killed: false,
          exitCode: null,
          signalCode: null,
          spawnTime: 1000,
          uptimeMs: 5000,
        },
        renderer: {
          canvasCount: 0,
          hasRenderableContent: true,
          hasBlankRenderSurface: true,
          trackedWebglAddonPresent: true,
          trackedWebglAddonDisposed: true,
          staleDisposedWebglOwnership: true,
        },
        buffer: {
          screenLineCount: 2,
          screenTail: ["ready", "waiting"],
        },
        recovery: {
          resumable: true,
          relaunchable: false,
          hasPersistedSession: false,
          canResumeAfterRestart: false,
          missingPersistedMetadata: false,
          wouldBeLostOnFullClose: false,
          lifecycle: "live",
        },
        derived: {
          blankButLiveRenderer: true,
          staleDisposedWebglOwnership: true,
          disposedTabStillSelected: false,
        },
      },
    ];

    const { view } = createView({ "core.exposeDebugApi": true });
    await flushAsync();

    const snapshot = view.getSessionDiagnosticsSnapshot();
    expect(snapshot.summary).toMatchObject({
      activeItemId: "Tasks/task-1.md",
      activeTabCount: 1,
      activeItemCount: 1,
      persistedSessionCount: 0,
      derivedCounts: {
        blankButLiveRenderer: 1,
        staleDisposedWebglOwnership: 1,
        missingPersistedMetadata: 1,
        liveNonResumableSessions: 0,
      },
    });
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]).toMatchObject({
      itemId: "Tasks/task-1.md",
      activeTabIndex: 0,
      idleSince: 1234,
      sessionCounts: { shells: 0, agents: 1 },
    });
    expect(snapshot.items[0].tabs[0].recovery).toMatchObject({
      resumable: true,
      hasPersistedSession: false,
      missingPersistedMetadata: true,
      lifecycle: "live",
    });
    expect(window.__workTerminalDebug?.getSessionDiagnostics().summary.activeTabCount).toBe(1);
  });

  it("copies session diagnostics to the clipboard", async () => {
    mockState.activeItemId = "Tasks/task-1.md";
    mockState.tabDiagnostics = [
      {
        tabId: "tab-1",
        itemId: "Tasks/task-1.md",
        tabIndex: 0,
        label: "Shell",
        sessionId: null,
        sessionType: "shell",
        claudeState: "inactive",
        isResumableAgent: false,
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
          staleDisposedWebglOwnership: false,
        },
        buffer: {
          screenLineCount: 1,
          screenTail: ["$"],
        },
        recovery: {
          resumable: false,
          relaunchable: true,
          hasPersistedSession: false,
          canResumeAfterRestart: false,
          missingPersistedMetadata: false,
          wouldBeLostOnFullClose: true,
          lifecycle: "live",
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

  it("keeps Copilot tabs out of the Claude-only restart menu action", async () => {
    const { view } = createView();
    await flushAsync();

    (view as any).showTabContextMenu(
      {
        sessionType: "copilot",
        label: "Copilot",
      },
      0,
      new dom.window.MouseEvent("contextmenu"),
    );

    expect(mockState.menuTitles).toContain("Rename");
    expect(mockState.menuTitles).not.toContain("Restart");
  });

  it("keeps the restart menu action available for Claude tabs", async () => {
    const { view } = createView();
    await flushAsync();

    (view as any).showTabContextMenu(
      {
        sessionType: "claude",
        label: "Claude",
      },
      0,
      new dom.window.MouseEvent("contextmenu"),
    );

    expect(mockState.menuTitles).toContain("Restart");
  });

  it("restarts Claude tabs by creating a resumed replacement before closing the old tab", async () => {
    mockState.activeItemId = "task-1";
    const { view } = createView({
      "core.claudeCommand": "/bin/echo",
      "core.claudeExtraArgs": "--dangerously-skip-permissions",
      "core.defaultTerminalCwd": "~/resume",
    });
    await flushAsync();

    (view as any).showTabContextMenu(
      {
        sessionType: "claude",
        label: "Claude",
        claudeSessionId: "session-123",
        launchShell: "/bin/echo",
        launchCwd: expandTilde("~/resume"),
        launchCommandArgs: [
          "/bin/echo",
          "--dangerously-skip-permissions",
          "--session-id",
          "old-id",
        ],
      },
      0,
      new dom.window.MouseEvent("contextmenu"),
    );

    mockState.menuActions.get("Restart")?.();
    await flushAsync();

    expect(mockState.tabManagerCalls).toEqual(["createTabForItem", "closeTabInstance"]);
    expect(mockState.latestCreateTabArgs).toEqual([
      "task-1",
      "/bin/echo",
      expandTilde("~/resume"),
      "Claude",
      "claude",
      undefined,
      ["/bin/echo", "--dangerously-skip-permissions", "--resume", "session-123"],
      "session-123",
    ]);
  });

  it("preserves non-session args around restart resume metadata", async () => {
    mockState.activeItemId = "task-1";
    const { view } = createView({
      "core.claudeCommand": "/bin/echo",
      "core.defaultTerminalCwd": "~/resume",
    });
    await flushAsync();

    (view as any).showTabContextMenu(
      {
        sessionType: "claude",
        label: "Claude",
        taskPath: "task-1",
        claudeSessionId: "session-123",
        launchShell: "/bin/echo",
        launchCwd: expandTilde("~/resume"),
        launchCommandArgs: [
          "/bin/echo",
          "--flag-before",
          "alpha",
          "--session-id",
          "old-id",
          "--flag-after",
          "beta",
          "--resume",
          "old-resume",
          "--another=option",
          "--resume=legacy",
          "--session-id=legacy-2",
          "--tail",
        ],
      },
      0,
      new dom.window.MouseEvent("contextmenu"),
    );

    mockState.menuActions.get("Restart")?.();
    await flushAsync();

    expect(mockState.latestCreateTabArgs).toEqual([
      "task-1",
      "/bin/echo",
      expandTilde("~/resume"),
      "Claude",
      "claude",
      undefined,
      [
        "/bin/echo",
        "--flag-before",
        "alpha",
        "--flag-after",
        "beta",
        "--another=option",
        "--tail",
        "--resume",
        "session-123",
      ],
      "session-123",
    ]);
  });

  it("preserves Claude-with-context when restart falls back to a fresh launch", async () => {
    mockState.activeItemId = "task-1";
    const { view } = createView({
      "core.claudeCommand": "/bin/echo",
      "core.defaultTerminalCwd": "~/fresh",
      "core.additionalAgentContext": "Prompt for $title",
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

    (view as any).showTabContextMenu(
      {
        sessionType: "claude-with-context",
        label: "Claude (ctx)",
        claudeSessionId: null,
        launchShell: "/bin/echo",
        launchCwd: expandTilde("~/fresh"),
        launchCommandArgs: ["/bin/echo", "--session-id", "old-id", "Prompt for Task One"],
      },
      0,
      new dom.window.MouseEvent("contextmenu"),
    );

    mockState.menuActions.get("Restart")?.();
    await flushAsync();

    expect(mockState.tabManagerCalls).toEqual(["createTabForItem", "closeTabInstance"]);
    expect(mockState.latestCreateTabArgs?.[0]).toBe("task-1");
    expect(mockState.latestCreateTabArgs?.[1]).toBe("/bin/echo");
    expect(mockState.latestCreateTabArgs?.[2]).toBe(expandTilde("~/fresh"));
    expect(mockState.latestCreateTabArgs?.[3]).toBe("Claude (ctx)");
    expect(mockState.latestCreateTabArgs?.[4]).toBe("claude-with-context");
  });

  it("falls back to fresh settings for restart when recovered tabs lack launch metadata", async () => {
    mockState.activeItemId = "task-1";
    const { view } = createView({
      "core.claudeCommand": "/bin/echo",
      "core.defaultTerminalCwd": "~/fallback",
    });
    await flushAsync();

    (view as any).showTabContextMenu(
      {
        sessionType: "claude",
        label: "Recovered Claude",
        claudeSessionId: "session-456",
      },
      0,
      new dom.window.MouseEvent("contextmenu"),
    );

    mockState.menuActions.get("Restart")?.();
    await flushAsync();

    expect(mockState.tabManagerCalls).toEqual(["createTabForItem", "closeTabInstance"]);
    expect(mockState.latestCreateTabArgs).toEqual([
      "task-1",
      "/bin/echo",
      expandTilde("~/fallback"),
      "Recovered Claude",
      "claude",
      undefined,
      ["/bin/echo", "--resume", "session-456"],
      "session-456",
    ]);
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
            claudeState: "inactive",
          },
        ],
      ],
      [
        "task-2",
        [
          {
            label: "Claude",
            sessionType: "claude",
            isResumableAgent: true,
            claudeState: "inactive",
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

    const secondTab = panelEl.querySelector(".wt-tab") as HTMLElement;
    secondTab.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));

    expect(mockState.tabManagerCalls).toContain("switchToTab:0");
  });

  it("restarts tabs against the tab item before falling back to the active item", async () => {
    mockState.activeItemId = "other-task";
    const { view } = createView({
      "core.claudeCommand": "/bin/echo",
      "core.defaultTerminalCwd": "~/fallback",
    });
    await flushAsync();

    (view as any).showTabContextMenu(
      {
        sessionType: "claude",
        label: "Recovered Claude",
        taskPath: "task-1",
        claudeSessionId: "session-456",
      },
      0,
      new dom.window.MouseEvent("contextmenu"),
    );

    mockState.menuActions.get("Restart")?.();
    await flushAsync();

    expect(mockState.latestCreateTabArgs?.[0]).toBe("task-1");
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

  it("refuses Claude-with-context launches when no template is configured", async () => {
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

    expect(promptBuilder.buildPrompt).not.toHaveBeenCalled();
    expect(mockState.latestCreateTabArgs).toBeNull();
    expect(mockState.notices).toContain("Could not build a contextual prompt for this item");
  });

  it("refuses Claude-with-context launches when the template is whitespace only", async () => {
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

    expect(promptBuilder.buildPrompt).not.toHaveBeenCalled();
    expect(mockState.latestCreateTabArgs).toBeNull();
    expect(mockState.notices).toContain("Could not build a contextual prompt for this item");
  });

  it("uses only the configured context template for Claude-with-context sessions", async () => {
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

    expect(promptBuilder.buildPrompt).not.toHaveBeenCalled();
    expect(mockState.latestCreateTabArgs?.[5]).toEqual([
      "/bin/echo",
      "--session-id",
      expect.any(String),
      "Template for Task One in doing",
    ]);
  });

  it("expands template $filePath with the resolved absolute work item path", async () => {
    mockState.activeItemId = "task-1";
    const promptBuilder = {
      buildPrompt: vi.fn(() => "Built prompt"),
    };
    const { view } = createView(
      {
        "core.additionalAgentContext": "Template path: $filePath",
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

    expect(promptBuilder.buildPrompt).not.toHaveBeenCalled();
    expect(mockState.latestCreateTabArgs?.[5]).toEqual([
      "/bin/echo",
      "--session-id",
      expect.any(String),
      "Template path: /vault/Tasks/task-1.md",
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

    expect(mockState.latestCreateTabArgs?.[5]).toEqual([
      "/bin/echo",
      "--session-id",
      expect.any(String),
      prompt,
    ]);
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

    expect(mockState.latestCreateTabArgs?.[5]).toEqual([
      "/bin/echo",
      "--session-id",
      expect.any(String),
    ]);
  });

  it("hides the Claude-with-context button when no template is configured", async () => {
    const { panelEl } = createView({
      "core.additionalAgentContext": "",
    });
    await flushAsync();

    expect(panelEl.querySelector(".wt-spawn-claude-ctx")).toBeNull();
  });

  it("hides the Claude-with-context button when the template is whitespace only", async () => {
    const { panelEl } = createView({
      "core.additionalAgentContext": "  \n\t  ",
    });
    await flushAsync();

    expect(panelEl.querySelector(".wt-spawn-claude-ctx")).toBeNull();
  });

  it("rerenders the Claude-with-context button when the template setting changes", async () => {
    const { panelEl } = createView({
      "core.additionalAgentContext": "",
    });
    await flushAsync();

    expect(panelEl.querySelector(".wt-spawn-claude-ctx")).toBeNull();

    window.dispatchEvent(
      new window.CustomEvent("work-terminal:settings-changed", {
        detail: {
          "core.additionalAgentContext": "Template for $title",
          "core.defaultTerminalCwd": "~",
        },
      }),
    );
    await flushAsync();

    expect(panelEl.querySelector(".wt-spawn-claude-ctx")).not.toBeNull();
  });

  it("reuses one settings snapshot for custom contextual Claude sessions", async () => {
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

    await (view as any).spawnCustomSession(
      {
        id: "task-1",
        title: "Task One",
        state: "doing",
        path: "Tasks/task-1.md",
      },
      {
        sessionType: "claude-with-context",
        cwd: "~/custom",
        extraArgs: "",
        label: "Custom Claude",
      },
    );

    expect(plugin.loadData).toHaveBeenCalledTimes(2);
    expect(mockState.latestCreateTabArgs).not.toBeNull();
    expect(mockState.latestCreateTabArgs?.[0]).toBe("/bin/echo");
    expect(mockState.latestCreateTabArgs?.[1]).toBe(expandTilde("~/custom"));
    expect(mockState.latestCreateTabArgs?.[5]).toEqual(
      expect.arrayContaining([expect.stringContaining("Prompt A for Task One")]),
    );
    expect(mockState.latestCreateTabArgs?.[5]).not.toEqual(
      expect.arrayContaining([expect.stringContaining("Prompt B for Task One")]),
    );
  });

  it("passes one fresh settings snapshot through custom contextual Copilot launches", async () => {
    const { view } = createView();
    await flushAsync();
    const fresh = {
      "core.additionalAgentContext": "Prompt A for $title",
      "core.copilotCommand": "/bin/echo",
      "core.defaultTerminalCwd": "~/one",
    };
    const item = {
      id: "task-1",
      title: "Task One",
      state: "doing",
      path: "Tasks/task-1.md",
    };
    const loadFreshSettings = vi.spyOn(view as any, "loadFreshSettings").mockResolvedValue(fresh);
    const getAgentContextPrompt = vi
      .spyOn(view as any, "getAgentContextPrompt")
      .mockResolvedValue("Prompt A for Task One");
    const spawnCopilotSession = vi
      .spyOn(view as any, "spawnCopilotSession")
      .mockResolvedValue(undefined);

    await (view as any).spawnCustomSession(item, {
      sessionType: "copilot-with-context",
      cwd: "~/custom",
      extraArgs: "--flag",
      label: "Custom Copilot",
    });

    expect(loadFreshSettings).toHaveBeenCalledOnce();
    expect(getAgentContextPrompt).toHaveBeenCalledWith(item, fresh);
    expect(spawnCopilotSession).toHaveBeenCalledWith({
      sessionType: "copilot-with-context",
      cwd: "~/custom",
      extraArgs: "--flag",
      label: "Custom Copilot",
      prompt: "Prompt A for Task One",
      freshSettings: fresh,
    });
  });

  it("keeps Windows absolute vault paths intact for Claude context prompts", async () => {
    const { view } = createView(
      {
        "core.additionalAgentContext": "Path: $filePath",
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
    vi.mocked(electronRequire).mockImplementationOnce(() => path.win32);

    const prompt = await (view as any).getClaudeContextPrompt({
      id: "task-1",
      title: "Task One",
      state: "doing",
      path: "Tasks\\task-1.md",
    });

    expect(prompt).toBe("Path: C:\\Users\\me\\Vault\\Tasks\\task-1.md");
  });

  it("keeps UNC vault paths intact for Claude context prompts", async () => {
    const { view } = createView(
      {
        "core.additionalAgentContext": "Path: $filePath",
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
    vi.mocked(electronRequire).mockImplementationOnce(() => path.win32);

    const prompt = await (view as any).getClaudeContextPrompt({
      id: "task-1",
      title: "Task One",
      state: "doing",
      path: "Tasks\\task-1.md",
    });

    expect(prompt).toBe("Path: \\\\server\\share\\Vault\\Tasks\\task-1.md");
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
          id: "castle-1234",
          url: "https://skyscanner.atlassian.net/browse/CASTLE-1234",
        },
      },
    });

    const jiraLink = panelEl.querySelector(".wt-task-jira-link") as HTMLAnchorElement | null;
    expect(jiraLink).not.toBeNull();
    expect(jiraLink?.textContent).toContain("CASTLE-1234");
    expect(jiraLink?.textContent).toContain("↗");
    expect(panelEl.querySelector(".wt-task-title-text")?.textContent).toBe("Fix restart issue");
    expect(panelEl.querySelector(".wt-task-title")?.getAttribute("style")).toContain(
      "--wt-task-color: #005cc5",
    );

    jiraLink?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    expect(mockState.openExternal).toHaveBeenCalledWith(
      "https://skyscanner.atlassian.net/browse/CASTLE-1234",
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
          id: "castle-1234",
          url: "https://skyscanner.atlassian.net/browse/CASTLE-1234",
        },
      },
    });

    const jiraLink = panelEl.querySelector(".wt-task-jira-link") as HTMLAnchorElement | null;
    expect(jiraLink).not.toBeNull();

    expect(() =>
      jiraLink?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })),
    ).not.toThrow();

    expect(errorSpy).toHaveBeenCalledWith(
      "[work-terminal] Failed to open Jira link externally: https://skyscanner.atlassian.net/browse/CASTLE-1234",
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
          id: "castle-1234",
          url: "https://skyscanner.atlassian.net/browse/CASTLE-1234",
        },
      },
    });

    const jiraLink = panelEl.querySelector(".wt-task-jira-link") as HTMLAnchorElement | null;
    expect(jiraLink).not.toBeNull();

    jiraLink?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await flushAsync();

    expect(errorSpy).toHaveBeenCalledWith(
      "[work-terminal] Failed to open Jira link externally: https://skyscanner.atlassian.net/browse/CASTLE-1234",
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
