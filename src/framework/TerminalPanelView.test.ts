import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import * as path from "node:path";
import type { ActiveTabInfo, PersistedSession, TabDiagnostics } from "../core/session/types";
import { SessionPersistence } from "../core/session/SessionPersistence";
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
    onAgentStateChange?: (itemId: string, state: string) => void;
    onPersistRequest?: () => void;
    onTabClosed?: (itemId: string, tab: unknown) => void;
  } | null,
  latestTabManagerCtorArgs: null as unknown[] | null,
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

    getActiveSessionIds() {
      return new Set(mockState.activeTabs.flatMap((tab) => (tab.sessionId ? [tab.sessionId] : [])));
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
  },
}));

vi.mock("../core/session/SessionPersistence", () => ({
  PERSIST_INTERVAL_MS: 30000,
  SessionPersistence: {
    startPeriodicPersist: vi.fn(() => mockState.stopPeriodicPersist),
    loadFromDisk: vi.fn(async () =>
      mockState.persistedSessions.map((session) => ({
        ...session,
        claudeSessionId: session.claudeSessionId ?? session.agentSessionId ?? null,
        recoveryMode:
          session.recoveryMode ??
          ((session.claudeSessionId ?? session.agentSessionId) ? "resume" : "relaunch"),
        commandArgs: session.commandArgs ? [...session.commandArgs] : undefined,
      })),
    ),
    buildPersistedSessions: vi.fn((sessions: Map<string, any[]>) =>
      Array.from(sessions.entries()).flatMap(([taskPath, tabs]) =>
        tabs.map((tab) => ({
          version: 2 as const,
          taskPath,
          claudeSessionId: tab.claudeSessionId ?? tab.agentSessionId ?? null,
          durableSessionId:
            tab.recoveryMode === "relaunch" || !(tab.claudeSessionId ?? tab.agentSessionId)
              ? (tab.durableSessionId ?? `durable-${taskPath}-${tab.label}`)
              : undefined,
          label: tab.label,
          sessionType: tab.sessionType,
          savedAt: "2026-03-28T20:00:00.000Z",
          recoveryMode:
            tab.recoveryMode ??
            ((tab.claudeSessionId ?? tab.agentSessionId) ? "resume" : "relaunch"),
          cwd: tab.launchCwd ?? "/vault",
          command: tab.launchCommandArgs?.[0] ?? tab.launchShell ?? "/bin/zsh",
          commandArgs: tab.launchCommandArgs,
        })),
      ),
    ),
    mergePersistedSessions: vi.fn((existing: PersistedSession[], sessions: Map<string, any[]>) => {
      const active = Array.from(sessions.entries()).flatMap(([taskPath, tabs]) =>
        tabs.map((tab) => ({
          version: 2 as const,
          taskPath,
          claudeSessionId: tab.claudeSessionId ?? tab.agentSessionId ?? null,
          durableSessionId:
            tab.recoveryMode === "relaunch" || !(tab.claudeSessionId ?? tab.agentSessionId)
              ? (tab.durableSessionId ?? `durable-${taskPath}-${tab.label}`)
              : undefined,
          label: tab.label,
          sessionType: tab.sessionType,
          savedAt: "2026-03-28T20:00:00.000Z",
          recoveryMode:
            tab.recoveryMode ??
            ((tab.claudeSessionId ?? tab.agentSessionId) ? "resume" : "relaunch"),
          cwd: tab.launchCwd ?? "/vault",
          command: tab.launchCommandArgs?.[0] ?? tab.launchShell ?? "/bin/zsh",
          commandArgs: tab.launchCommandArgs,
        })),
      );
      const activeKeys = new Set(
        active.map((session) =>
          session.recoveryMode === "resume"
            ? `resume:${session.claudeSessionId ?? ""}`
            : session.durableSessionId
              ? `relaunch:${session.taskPath}${session.durableSessionId}`
              : `legacy:${session.taskPath}${session.label}${session.command ?? ""}${JSON.stringify(session.commandArgs ?? [])}`,
        ),
      );
      return [
        ...active,
        ...existing.filter((session) => {
          const key =
            session.recoveryMode === "resume"
              ? `resume:${session.claudeSessionId ?? ""}`
              : session.durableSessionId
                ? `relaunch:${session.taskPath}${session.durableSessionId}`
                : `legacy:${session.taskPath}${session.label}${session.command ?? ""}${JSON.stringify(session.commandArgs ?? [])}`;
          return !activeKeys.has(key);
        }),
      ];
    }),
    setPersistedSessions: vi.fn(
      (data: Record<string, unknown>, persistedSessions: PersistedSession[]) => {
        data.persistedSessions = persistedSessions.map((session) => ({
          ...session,
          commandArgs: session.commandArgs ? [...session.commandArgs] : undefined,
        }));
      },
    ),
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

async function flushAsync(ticks = 3) {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
  }
}

function makePersistedSession(
  sessionType: PersistedSession["sessionType"],
  overrides: Partial<PersistedSession> = {},
): PersistedSession {
  return {
    version: 2,
    taskPath: "Tasks/task-1.md",
    claudeSessionId: sessionType === "shell" ? null : "session-1",
    durableSessionId:
      overrides.durableSessionId ??
      ((overrides.recoveryMode ?? (sessionType === "shell" ? "relaunch" : "resume")) === "relaunch"
        ? "durable-shell-1"
        : undefined),
    label: "Session",
    sessionType,
    savedAt: "2026-03-28T20:00:00.000Z",
    recoveryMode: sessionType === "shell" ? "relaunch" : "resume",
    cwd: "/vault",
    command: sessionType === "shell" ? "/bin/zsh" : "agent",
    commandArgs: sessionType === "shell" ? undefined : ["agent", "--resume", "session-1"],
    ...overrides,
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
    mockState.latestTabManagerCtorArgs = null;
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

  it("refreshes persisted-session state from the latest active sessions on save", async () => {
    mockState.activeSessions = new Map([
      [
        "Tasks/task-1.md",
        [
          {
            sessionType: "copilot",
            label: "Session",
            claudeSessionId: "session-1",
            launchShell: "agent",
            launchCwd: "/vault",
            launchCommandArgs: ["agent", "--resume", "session-1"],
          },
        ],
      ],
    ]);

    const saveData = vi.fn(async () => {});
    const { view } = createView({ "core.exposeDebugApi": true }, { saveData });
    await flushAsync();

    await view.persistSessions();

    expect(window.__workTerminalDebug?.persistedSessions).toEqual([
      expect.objectContaining({
        taskPath: "Tasks/task-1.md",
        recoveryMode: "resume",
      }),
    ]);
    expect(saveData.mock.calls.at(-1)?.[0].persistedSessions).toEqual(
      window.__workTerminalDebug?.persistedSessions,
    );
  });

  it("preserves cold-start persisted sessions until they are resumed or removed", async () => {
    mockState.persistedSessions = [
      makePersistedSession("shell", {
        label: "Shell",
        durableSessionId: "durable-cold-shell",
      }),
    ];
    mockState.activeSessions = new Map();

    const saveData = vi.fn(async () => {});
    const { view } = createView({ "core.exposeDebugApi": true }, { saveData });
    await flushAsync();

    await view.persistSessions();

    expect(window.__workTerminalDebug?.persistedSessions).toEqual([
      expect.objectContaining({
        label: "Shell",
        durableSessionId: "durable-cold-shell",
      }),
    ]);
    expect(saveData.mock.calls.at(-1)?.[0].persistedSessions).toEqual(
      window.__workTerminalDebug?.persistedSessions,
    );
  });

  it("filters persisted sessions that already match a recovered active tab", async () => {
    mockState.persistedSessions = [
      makePersistedSession("copilot", { label: "Original label" }),
      makePersistedSession("shell"),
    ];
    mockState.activeItemId = "Tasks/task-1.md";
    mockState.tabsByItem = new Map([
      [
        "Tasks/task-1.md",
        [
          {
            sessionType: "copilot",
            label: "Renamed label",
            claudeSessionId: "session-1",
            launchShell: "agent",
            launchCwd: "/vault",
            launchCommandArgs: ["agent", "--resume", "session-1"],
          },
          {
            sessionType: "shell",
            label: "Session",
            launchShell: "/bin/zsh",
            launchCwd: "/vault",
            launchCommandArgs: undefined,
          },
        ],
      ],
    ]);

    const { view } = createView();
    await flushAsync();

    expect(view.getPersistedSessions("Tasks/task-1.md")).toEqual([]);
  });

  it("keeps distinct relaunch sessions recoverable when only labels differ", async () => {
    mockState.persistedSessions = [
      makePersistedSession("shell", { label: "Shell A" }),
      makePersistedSession("shell", { label: "Shell B" }),
    ];
    mockState.activeItemId = "Tasks/task-1.md";
    mockState.tabsByItem = new Map([
      [
        "Tasks/task-1.md",
        [
          {
            sessionType: "shell",
            label: "Shell A",
            launchShell: "/bin/zsh",
            launchCwd: "/vault",
            launchCommandArgs: undefined,
          },
        ],
      ],
    ]);

    const { view } = createView();
    await flushAsync();

    expect(view.getPersistedSessions("Tasks/task-1.md")).toEqual([
      expect.objectContaining({ label: "Shell B" }),
    ]);
  });

  it("keeps identical relaunch sessions recoverable when only durable identities differ", async () => {
    mockState.persistedSessions = [
      makePersistedSession("shell", {
        label: "Shell",
        durableSessionId: "durable-shell-1",
      }),
      makePersistedSession("shell", {
        label: "Shell",
        durableSessionId: "durable-shell-2",
      }),
    ];
    mockState.activeItemId = "Tasks/task-1.md";
    mockState.tabsByItem = new Map([
      [
        "Tasks/task-1.md",
        [
          {
            sessionType: "shell",
            label: "Shell",
            durableSessionId: "durable-shell-1",
            launchShell: "/bin/zsh",
            launchCwd: "/vault",
            launchCommandArgs: undefined,
          },
        ],
      ],
    ]);

    const { view } = createView();
    await flushAsync();

    expect(view.getPersistedSessions("Tasks/task-1.md")).toEqual([
      expect.objectContaining({ durableSessionId: "durable-shell-2" }),
    ]);
  });

  it("falls back to legacy relaunch matching when durable identities were synthesized during migration", async () => {
    mockState.persistedSessions = [
      makePersistedSession("shell", {
        label: "Shell",
        durableSessionId: "durable-from-disk",
        durableSessionIdGenerated: true,
      }),
    ];
    mockState.activeItemId = "Tasks/task-1.md";
    mockState.tabsByItem = new Map([
      [
        "Tasks/task-1.md",
        [
          {
            sessionType: "shell",
            label: "Shell",
            durableSessionId: "durable-from-hot-reload",
            launchShell: "/bin/zsh",
            launchCwd: "/vault",
            launchCommandArgs: undefined,
          },
        ],
      ],
    ]);

    const { view } = createView();
    await flushAsync();

    expect(view.getPersistedSessions("Tasks/task-1.md")).toEqual([]);
  });

  it("adopts synthesized durable identities before persisting legacy relaunch recoveries", async () => {
    const activeShell = {
      sessionType: "shell",
      label: "Shell",
      durableSessionId: "durable-from-hot-reload",
      launchShell: "/bin/zsh",
      launchCwd: "/vault",
      launchCommandArgs: undefined,
    };
    mockState.persistedSessions = [
      makePersistedSession("shell", {
        label: "Shell",
        durableSessionId: "durable-from-disk",
        durableSessionIdGenerated: true,
      }),
    ];
    mockState.activeSessions = new Map([["Tasks/task-1.md", [activeShell]]]);
    mockState.activeItemId = "Tasks/task-1.md";
    mockState.tabsByItem = new Map([["Tasks/task-1.md", [activeShell]]]);

    const saveData = vi.fn(async () => {});
    const { view } = createView({}, { saveData });
    await flushAsync();

    await view.persistSessions();

    expect(saveData.mock.calls.at(-1)?.[0].persistedSessions).toEqual([
      expect.objectContaining({
        durableSessionId: "durable-from-disk",
      }),
    ]);
  });

  it("keeps failed legacy relaunch recoveries hidden after another view reopens the same session", async () => {
    const loadData = vi.fn(async () => ({
      settings: {},
      recentlyClosedSessions: [
        {
          sessionType: "shell",
          label: "Shell",
          claudeSessionId: null,
          closedAt: Date.now(),
          itemId: "Tasks/task-1.md",
          recoveryMode: "relaunch",
          cwd: "/vault",
          command: "/bin/zsh",
        },
      ],
    }));

    const failedRestoreTab: { onProcessExit?: (code?: number, signal?: number) => void } = {};
    const { view: firstView } = createView({}, { loadData });
    const { view: secondView } = createView({}, { loadData });
    await flushAsync();

    const [legacyEntry] = (firstView as any).recentlyClosedStore.serialize();
    expect(legacyEntry).toMatchObject({
      durableSessionId: expect.any(String),
      durableSessionIdGenerated: true,
    });

    (firstView as any).tabManager.createTabForItem = vi.fn(() => failedRestoreTab);
    await (firstView as any).restoreClosedSession(legacyEntry);
    failedRestoreTab.onProcessExit?.(1, 0);
    await flushAsync();

    const [readdedEntry] = (secondView as any).recentlyClosedStore.serialize();
    expect(readdedEntry).toMatchObject({
      durableSessionId: legacyEntry.durableSessionId,
      durableSessionIdGenerated: true,
    });

    mockState.activeItemId = "Tasks/task-1.md";
    mockState.tabsByItem = new Map([
      [
        "Tasks/task-1.md",
        [
          {
            id: "live-shell",
            sessionType: "shell",
            label: "Shell",
            durableSessionId: "durable-manual-reopen",
            launchShell: "/bin/zsh",
            launchCwd: "/vault",
            launchCommandArgs: undefined,
          },
        ],
      ],
    ]);

    const hiddenEntries = (secondView as any).recentlyClosedStore.getEntries(
      new Set(),
      5,
      (entry: any) => (secondView as any).isClosedSessionActiveAcrossViews(entry),
    );
    expect(hiddenEntries).toEqual([]);
  });

  it("drops stale migrated relaunch aliases before persisting a manual reopen", async () => {
    const saveData = vi.fn(async () => {});
    mockState.persistedSessions = [
      makePersistedSession("shell", {
        label: "Shell",
        durableSessionId: "durable-from-migration",
        durableSessionIdGenerated: true,
      }),
    ];

    const { view } = createView({}, { saveData });
    await flushAsync();

    const liveShell = {
      sessionType: "shell",
      label: "Shell",
      durableSessionId: "durable-manual-reopen",
      launchShell: "/bin/zsh",
      launchCwd: "/vault",
      launchCommandArgs: undefined,
    };
    mockState.activeItemId = "Tasks/task-1.md";
    mockState.activeSessions = new Map([["Tasks/task-1.md", [liveShell]]]);
    mockState.tabsByItem = new Map([["Tasks/task-1.md", [liveShell]]]);

    await view.persistSessions();

    const persistedSessions = saveData.mock.calls.at(-1)?.[0].persistedSessions;
    expect(persistedSessions).toHaveLength(1);
    expect(persistedSessions[0]).toMatchObject({
      durableSessionId: "durable-manual-reopen",
    });
    expect(persistedSessions[0]).not.toHaveProperty("durableSessionIdGenerated");
  });

  it("keeps one migrated relaunch alias pending when identical aliases are reopened one at a time", async () => {
    const saveData = vi.fn(async () => {});
    mockState.persistedSessions = [
      makePersistedSession("shell", {
        label: "Shell",
        durableSessionId: "durable-from-migration-1",
        durableSessionIdGenerated: true,
      }),
      makePersistedSession("shell", {
        label: "Shell",
        durableSessionId: "durable-from-migration-2",
        durableSessionIdGenerated: true,
      }),
    ];

    const { view } = createView({}, { saveData });
    await flushAsync();

    const liveShell = {
      id: "live-shell",
      sessionType: "shell",
      label: "Shell",
      durableSessionId: "durable-manual-reopen",
      launchShell: "/bin/zsh",
      launchCwd: "/vault",
      launchCommandArgs: undefined,
    };
    mockState.activeItemId = "Tasks/task-1.md";
    mockState.activeSessions = new Map([["Tasks/task-1.md", [liveShell]]]);
    mockState.tabsByItem = new Map([["Tasks/task-1.md", [liveShell]]]);

    await view.persistSessions();

    const pendingSessions = view.getPersistedSessions("Tasks/task-1.md");
    expect(pendingSessions).toHaveLength(1);
    expect(pendingSessions[0]).toMatchObject({
      durableSessionIdGenerated: true,
    });
    expect(["durable-from-migration-1", "durable-from-migration-2"]).toContain(
      pendingSessions[0].durableSessionId,
    );

    const persistedSessions = saveData.mock.calls.at(-1)?.[0].persistedSessions;
    expect(persistedSessions).toHaveLength(2);
    expect(
      persistedSessions.filter((session: PersistedSession) => session.durableSessionIdGenerated),
    ).toHaveLength(1);
    expect(persistedSessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          durableSessionId: "durable-manual-reopen",
        }),
      ]),
    );
  });

  it("rekeys pending durable recovery entries when an item path changes", async () => {
    mockState.persistedSessions = [
      makePersistedSession("shell", {
        taskPath: "Tasks/old-task.md",
        durableSessionId: "durable-shell-1",
      }),
    ];

    const { view } = createView({ "core.exposeDebugApi": true });
    await flushAsync();

    view.rekeyItem("Tasks/old-task.md", "Tasks/new-task.md");

    expect(window.__workTerminalDebug?.persistedSessions).toEqual([
      expect.objectContaining({
        taskPath: "Tasks/new-task.md",
        durableSessionId: "durable-shell-1",
      }),
    ]);
    expect(view.getPersistedSessions("Tasks/new-task.md")).toEqual([
      expect.objectContaining({
        taskPath: "Tasks/new-task.md",
        durableSessionId: "durable-shell-1",
      }),
    ]);
  });

  it("shows the hook warning for recently closed Claude resume entries", async () => {
    const loadData = vi.fn(async () => ({
      settings: {},
      recentlyClosedSessions: [
        {
          sessionType: "claude",
          label: "Claude",
          claudeSessionId: "recent-session",
          closedAt: Date.now(),
          itemId: "Tasks/task-1.md",
          recoveryMode: "resume",
          cwd: "/vault",
          command: "claude",
          commandArgs: ["claude", "--resume", "recent-session"],
        },
      ],
    }));

    const { panelEl } = createView({}, { loadData });
    await flushAsync();

    expect(panelEl.querySelector(".wt-hook-warning-banner")).not.toBeNull();
  });

  it("persists recently closed sessions with durable relaunch metadata", async () => {
    const saveData = vi.fn(async () => {});
    createView({}, { saveData });
    await flushAsync();

    mockState.latestTabManager?.onTabClosed?.("Tasks/task-1.md", {
      sessionType: "shell",
      label: "Shell",
      claudeSessionId: null,
      launchShell: "/bin/zsh",
      launchCwd: "/vault",
      launchCommandArgs: undefined,
      isResumableAgent: false,
    } as any);
    await flushAsync();

    expect(saveData).toHaveBeenCalled();
    const payload = saveData.mock.calls.at(-1)?.[0];
    expect(payload.recentlyClosedSessions).toEqual([
      expect.objectContaining({
        itemId: "Tasks/task-1.md",
        recoveryMode: "relaunch",
        command: "/bin/zsh",
        cwd: "/vault",
      }),
    ]);
  });

  it("removes a closed resume session from persisted sessions to prevent auto-restore", async () => {
    mockState.persistedSessions = [
      makePersistedSession("claude", { claudeSessionId: "agent-session-1" }),
      makePersistedSession("shell", { durableSessionId: "durable-shell-1" }),
    ];

    const saveData = vi.fn(async () => {});
    const { view } = createView({ "core.exposeDebugApi": true }, { saveData });
    await flushAsync();

    // Simulate user explicitly closing the Claude tab
    mockState.latestTabManager?.onTabClosed?.("Tasks/task-1.md", {
      sessionType: "claude",
      label: "Session",
      claudeSessionId: "agent-session-1",
      agentSessionId: "agent-session-1",
      launchShell: "agent",
      launchCwd: "/vault",
      launchCommandArgs: ["agent", "--resume", "agent-session-1"],
      isResumableAgent: true,
    } as any);
    await flushAsync();

    // The closed session should be removed from persisted sessions
    const persisted = window.__workTerminalDebug?.persistedSessions ?? [];
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      sessionType: "shell",
      durableSessionId: "durable-shell-1",
    });
  });

  it("removes a closed relaunch session from persisted sessions to prevent auto-restore", async () => {
    mockState.persistedSessions = [
      makePersistedSession("shell", { durableSessionId: "durable-shell-1" }),
      makePersistedSession("claude", { claudeSessionId: "agent-session-1" }),
    ];

    const saveData = vi.fn(async () => {});
    const { view } = createView({ "core.exposeDebugApi": true }, { saveData });
    await flushAsync();

    // Simulate user explicitly closing the shell tab
    mockState.latestTabManager?.onTabClosed?.("Tasks/task-1.md", {
      sessionType: "shell",
      label: "Session",
      claudeSessionId: null,
      durableSessionId: "durable-shell-1",
      launchShell: "/bin/zsh",
      launchCwd: "/vault",
      launchCommandArgs: undefined,
      isResumableAgent: false,
    } as any);
    await flushAsync();

    // The closed session should be removed from persisted sessions
    const persisted = window.__workTerminalDebug?.persistedSessions ?? [];
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      sessionType: "claude",
      claudeSessionId: "agent-session-1",
    });
  });

  it("restores relaunchable persisted sessions with their saved command metadata", async () => {
    const { view } = createView();
    await flushAsync();

    await view.resumeSession(
      makePersistedSession("shell", { durableSessionId: "durable-shell-1" }),
      "Tasks/task-1.md",
    );

    expect(mockState.tabManagerCalls).toContain("createTabForItem");
    expect(mockState.latestCreateTabArgs).toEqual([
      "Tasks/task-1.md",
      "/bin/zsh",
      "/vault",
      "Session",
      "shell",
      undefined,
      undefined,
      null,
      "durable-shell-1",
    ]);
  });

  it("preserves durable relaunch identity when restoring recently closed sessions", async () => {
    const { view } = createView();
    await flushAsync();

    const entry = {
      sessionType: "shell",
      label: "Shell",
      claudeSessionId: null,
      durableSessionId: "durable-shell-1",
      closedAt: Date.now(),
      itemId: "Tasks/task-1.md",
      recoveryMode: "relaunch",
      cwd: "/vault",
      command: "/bin/zsh",
      commandArgs: undefined,
    };
    (view as any).recentlyClosedStore.add(entry);

    await (view as any).restoreClosedSession(entry);

    expect(mockState.latestCreateTabArgs).toEqual([
      "Tasks/task-1.md",
      "/bin/zsh",
      "/vault",
      "Shell",
      "shell",
      undefined,
      undefined,
      null,
      "durable-shell-1",
    ]);
  });

  it("hydrates recently closed sessions from disk only once across live views", async () => {
    const loadData = vi.fn(async () => ({
      settings: {},
      recentlyClosedSessions: [
        {
          sessionType: "shell",
          label: "Shell",
          claudeSessionId: null,
          closedAt: Date.now(),
          itemId: "Tasks/task-1.md",
          recoveryMode: "relaunch",
          cwd: "/vault",
          command: "/bin/zsh",
        },
      ],
    }));

    const { view: firstView } = createView({}, { loadData });
    const { view: secondView } = createView({}, { loadData });
    await flushAsync();

    expect((firstView as any).recentlyClosedStore.serialize()).toHaveLength(1);
    expect((secondView as any).recentlyClosedStore.serialize()).toHaveLength(1);
  });

  it("claims recently closed entries once across concurrent live views", async () => {
    const entry = {
      sessionType: "shell",
      label: "Shell",
      claudeSessionId: null,
      durableSessionId: "durable-shell-1",
      closedAt: Date.now(),
      itemId: "Tasks/task-1.md",
      recoveryMode: "relaunch" as const,
      cwd: "/vault",
      command: "/bin/zsh",
      commandArgs: undefined,
    };
    const loadData = vi.fn(async () => ({
      settings: {},
      recentlyClosedSessions: [entry],
    }));

    const { view: firstView } = createView({}, { loadData });
    const { view: secondView } = createView({}, { loadData });
    await flushAsync(10);
    mockState.tabManagerCalls = [];

    await Promise.all([
      (firstView as any).restoreClosedSession(entry),
      (secondView as any).restoreClosedSession(entry),
    ]);

    expect(mockState.tabManagerCalls.filter((call) => call === "createTabForItem")).toHaveLength(1);
    expect((firstView as any).recentlyClosedStore.serialize()).toEqual([]);
    expect((secondView as any).recentlyClosedStore.serialize()).toEqual([]);
  });

  it("claims recently closed resumable entries once across concurrent live views", async () => {
    const resolveStub = vi
      .spyOn(AgentLauncher, "resolveCommandInfo")
      .mockReturnValue({ found: true, resolved: "claude" });

    const entry = {
      sessionType: "claude",
      label: "Claude",
      claudeSessionId: "session-1",
      closedAt: Date.now(),
      itemId: "Tasks/task-1.md",
      recoveryMode: "resume" as const,
      cwd: "/vault",
      command: "claude",
      commandArgs: ["claude", "--resume", "session-1"],
    };
    const loadData = vi.fn(async () => ({
      settings: {},
      recentlyClosedSessions: [entry],
    }));

    const { view: firstView } = createView({}, { loadData });
    const { view: secondView } = createView({}, { loadData });
    await flushAsync(10);
    mockState.tabManagerCalls = [];

    await Promise.all([
      (firstView as any).restoreClosedSession(entry),
      (secondView as any).restoreClosedSession(entry),
    ]);

    expect(mockState.tabManagerCalls.filter((call) => call === "createTabForItem")).toHaveLength(1);
    expect((firstView as any).recentlyClosedStore.serialize()).toEqual([]);
    expect((secondView as any).recentlyClosedStore.serialize()).toEqual([]);
    resolveStub.mockRestore();
  });

  it("restores persisted resumable sessions with their saved launch context", async () => {
    const { view } = createView({
      "core.copilotCommand": "copilot-current",
      "core.copilotExtraArgs": "--current-default",
      "core.defaultTerminalCwd": "~/current-default",
    });
    await flushAsync();

    await view.resumeSession(
      makePersistedSession("copilot", {
        label: "Copilot",
        cwd: "/saved-cwd",
        command: "/bin/echo",
        commandArgs: [
          "/bin/echo",
          "--saved-flag",
          "value",
          "--resume=old-session",
          "--another=saved",
        ],
        claudeSessionId: "saved-session",
      }),
      "Tasks/task-1.md",
    );

    expect(mockState.latestCreateTabArgs).toEqual([
      "Tasks/task-1.md",
      "/bin/echo",
      "/saved-cwd",
      "Copilot",
      "copilot",
      undefined,
      ["/bin/echo", "--saved-flag", "value", "--another=saved", "--resume=saved-session"],
      "saved-session",
    ]);
  });

  it("falls back to the current configured command when a saved Copilot path is stale", async () => {
    const { view } = createView({
      "core.copilotCommand": "/bin/echo",
      "core.copilotExtraArgs": "--current-default",
      "core.defaultTerminalCwd": "~/current-default",
    });
    await flushAsync();

    await view.resumeSession(
      makePersistedSession("copilot", {
        label: "Copilot",
        cwd: "/saved-cwd",
        command: "/definitely/not/here/copilot",
        commandArgs: [
          "/definitely/not/here/copilot",
          "--saved-flag",
          "value",
          "--resume=old-session",
        ],
        claudeSessionId: "saved-session",
      }),
      "Tasks/task-1.md",
    );

    expect(mockState.latestCreateTabArgs).toEqual([
      "Tasks/task-1.md",
      "/bin/echo",
      "/saved-cwd",
      "Copilot",
      "copilot",
      undefined,
      ["/bin/echo", "--saved-flag", "value", "--resume=saved-session"],
      "saved-session",
    ]);
    expect(mockState.notices).toEqual([]);
  });

  it("falls back to the current configured command when a saved relative Copilot wrapper path is stale", async () => {
    const { view } = createView({
      "core.copilotCommand": "/bin/echo",
      "core.copilotExtraArgs": "--current-default",
      "core.defaultTerminalCwd": "~/current-default",
    });
    await flushAsync();

    await view.resumeSession(
      makePersistedSession("copilot", {
        label: "Copilot",
        cwd: "/saved-cwd",
        command: "./missing/copilot-wrapper",
        commandArgs: ["./missing/copilot-wrapper", "--saved-flag", "value", "--resume=old-session"],
        claudeSessionId: "saved-session",
      }),
      "Tasks/task-1.md",
    );

    expect(mockState.latestCreateTabArgs).toEqual([
      "Tasks/task-1.md",
      "/bin/echo",
      "/saved-cwd",
      "Copilot",
      "copilot",
      undefined,
      ["/bin/echo", "--saved-flag", "value", "--resume=saved-session"],
      "saved-session",
    ]);
    expect(mockState.notices).toEqual([]);
  });

  it("resolves the current relative Copilot command against the current configured cwd after a stale saved wrapper path", async () => {
    const { view } = createView({
      "core.copilotCommand": "./sh",
      "core.defaultTerminalCwd": "/bin",
    });
    await flushAsync();

    await view.resumeSession(
      makePersistedSession("copilot", {
        label: "Copilot",
        cwd: "/saved-cwd",
        command: "./missing/copilot-wrapper",
        commandArgs: ["./missing/copilot-wrapper", "--saved-flag", "value", "--resume=old-session"],
        claudeSessionId: "saved-session",
      }),
      "Tasks/task-1.md",
    );

    expect(mockState.latestCreateTabArgs).toEqual([
      "Tasks/task-1.md",
      "/bin/sh",
      "/saved-cwd",
      "Copilot",
      "copilot",
      undefined,
      ["/bin/sh", "--saved-flag", "value", "--resume=saved-session"],
      "saved-session",
    ]);
    expect(mockState.notices).toEqual([]);
  });

  it("restores recently closed resumable sessions with their saved launch context", async () => {
    const { view } = createView({
      "core.claudeCommand": "claude-current",
      "core.claudeExtraArgs": "--current-default",
      "core.defaultTerminalCwd": "~/current-default",
    });
    await flushAsync();

    const entry = {
      sessionType: "claude",
      label: "Claude",
      claudeSessionId: "saved-session",
      closedAt: Date.now(),
      itemId: "Tasks/task-1.md",
      recoveryMode: "resume",
      cwd: "/saved-cwd",
      command: "/bin/echo",
      commandArgs: [
        "/bin/echo",
        "--saved-flag",
        "value",
        "--resume",
        "old-session",
        "--session-id=legacy",
      ],
    };
    (view as any).recentlyClosedStore.add(entry);

    await (view as any).restoreClosedSession(entry);

    expect(mockState.latestCreateTabArgs).toEqual([
      "Tasks/task-1.md",
      "/bin/echo",
      "/saved-cwd",
      "Claude",
      "claude",
      undefined,
      ["/bin/echo", "--saved-flag", "value", "--resume", "saved-session"],
      "saved-session",
    ]);
  });

  it("does not replay Claude context prompts when resuming persisted sessions", async () => {
    const { view } = createView({
      "core.claudeCommand": "claude-current",
      "core.claudeExtraArgs": "--current-default",
      "core.defaultTerminalCwd": "~/current-default",
    });
    await flushAsync();

    await view.resumeSession(
      makePersistedSession("claude-with-context", {
        label: "Claude (ctx)",
        cwd: "/saved-cwd",
        command: "/bin/echo",
        commandArgs: [
          "/bin/echo",
          "--model",
          "sonnet",
          "--session-id",
          "old-session",
          "Prompt that should not replay",
        ],
        claudeSessionId: "saved-session",
      }),
      "Tasks/task-1.md",
    );

    expect(mockState.latestCreateTabArgs).toEqual([
      "Tasks/task-1.md",
      "/bin/echo",
      "/saved-cwd",
      "Claude (ctx)",
      "claude-with-context",
      undefined,
      ["/bin/echo", "--model", "sonnet", "--resume", "saved-session"],
      "saved-session",
    ]);
  });

  it("does not replay Copilot context prompts when restoring recently closed sessions", async () => {
    const { view } = createView({
      "core.copilotCommand": "copilot-current",
      "core.copilotExtraArgs": "--current-default",
      "core.defaultTerminalCwd": "~/current-default",
    });
    await flushAsync();

    const entry = {
      sessionType: "copilot-with-context",
      label: "Copilot (ctx)",
      claudeSessionId: "saved-session",
      closedAt: Date.now(),
      itemId: "Tasks/task-1.md",
      recoveryMode: "resume",
      cwd: "/saved-cwd",
      command: "/bin/echo",
      commandArgs: [
        "/bin/echo",
        "--resume=old-session",
        "--model",
        "gpt-5.4",
        "-i",
        "Prompt that should not replay",
      ],
    };
    (view as any).recentlyClosedStore.add(entry);

    await (view as any).restoreClosedSession(entry);

    expect(mockState.latestCreateTabArgs).toEqual([
      "Tasks/task-1.md",
      "/bin/echo",
      "/saved-cwd",
      "Copilot (ctx)",
      "copilot-with-context",
      undefined,
      ["/bin/echo", "--model", "gpt-5.4", "--resume=saved-session"],
      "saved-session",
    ]);
  });

  it("refreshes persisted diagnostics immediately after saving active sessions", async () => {
    mockState.activeSessions = new Map([
      [
        "Tasks/task-1.md",
        [
          {
            label: "Automatic Issues",
            taskPath: "Tasks/task-1.md",
            agentSessionId: "copilot-123",
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

  it("dedupes loaded legacy persisted sessions against fresh agent session ids", async () => {
    mockState.persistedSessions = [
      {
        version: 1,
        taskPath: "Tasks/task-1.md",
        claudeSessionId: "copilot-123",
        label: "Automatic Issues",
        sessionType: "copilot",
        savedAt: "2026-03-28T20:00:00.000Z",
      } as PersistedSession,
    ];
    mockState.activeSessions = new Map([
      [
        "Tasks/task-1.md",
        [
          {
            label: "Automatic Issues",
            taskPath: "Tasks/task-1.md",
            agentSessionId: "copilot-123",
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
    const persisted = view.getPersistedSessions("Tasks/task-1.md");
    const snapshot = view.getSessionDiagnosticsSnapshot();

    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ claudeSessionId: "copilot-123" });
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
        agentSessionId: "session-123",
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
        agentSessionId: "session-123",
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
        agentSessionId: null,
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

  it("preserves durable relaunch identity when restart relaunches a non-resumable tab", async () => {
    mockState.activeItemId = "task-1";
    const { view } = createView();
    await flushAsync();

    (view as any).showTabContextMenu(
      {
        sessionType: "claude",
        label: "Claude",
        claudeSessionId: null,
        durableSessionId: "durable-claude-relaunch",
        launchShell: "/bin/echo",
        launchCwd: "/vault",
        launchCommandArgs: ["/bin/echo", "--flag"],
      },
      0,
      new dom.window.MouseEvent("contextmenu"),
    );

    mockState.menuActions.get("Restart")?.();
    await flushAsync();

    expect(mockState.latestCreateTabArgs).toEqual([
      "task-1",
      "/bin/echo",
      "/vault",
      "Claude",
      "claude",
      undefined,
      ["/bin/echo", "--flag"],
      null,
      "durable-claude-relaunch",
    ]);
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
        agentSessionId: "session-456",
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

  it("normalizes multiline continuation args when restoring a closed session from settings", async () => {
    const { view } = createView({
      "core.claudeCommand": "/bin/echo",
      "core.defaultTerminalCwd": "~/fallback",
      "core.claudeExtraArgs": `--dangerously-skip-permissions \\
        --plugin-dir /path/a`,
    });
    await flushAsync();

    await (view as any).restoreClosedSession({
      sessionType: "claude",
      label: "Recovered Claude",
      agentSessionId: "session-456",
      closedAt: Date.now(),
      itemId: "task-1",
    });
    await flushAsync();

    expect(mockState.latestCreateTabArgs).toEqual([
      "task-1",
      "/bin/echo",
      expandTilde("~/fallback"),
      "Recovered Claude",
      "claude",
      undefined,
      [
        "/bin/echo",
        "--dangerously-skip-permissions",
        "--plugin-dir",
        "/path/a",
        "--resume",
        "session-456",
      ],
      "session-456",
    ]);
  });

  it("restores recently closed legacy entries using claudeSessionId fallback", async () => {
    const { view } = createView({
      "core.copilotCommand": "/bin/echo",
      "core.defaultTerminalCwd": "~/fallback",
    });
    await flushAsync();

    await (view as any).restoreClosedSession({
      sessionType: "copilot",
      label: "Recovered Copilot",
      claudeSessionId: "session-legacy",
      closedAt: Date.now(),
      itemId: "task-1",
    });

    expect(mockState.latestCreateTabArgs).toEqual([
      "task-1",
      "/bin/echo",
      expandTilde("~/fallback"),
      "Recovered Copilot",
      "copilot",
      undefined,
      ["/bin/echo", "--resume=session-legacy"],
      "session-legacy",
    ]);
  });

  it("shows install guidance when restoring a Claude session without an available CLI", async () => {
    const { view } = createView({
      "core.claudeCommand": "definitely-not-a-real-command-issue-158",
      "core.defaultTerminalCwd": "~/fallback",
    });
    await flushAsync();

    const entry = {
      sessionType: "claude",
      label: "Recovered Claude",
      claudeSessionId: "session-456",
      closedAt: Date.now(),
      itemId: "task-1",
      recoveryMode: "resume" as const,
    };
    (view as any).recentlyClosedStore.add(entry);

    await (view as any).restoreClosedSession(entry);

    expect(mockState.latestCreateTabArgs).toBeNull();
    expect(mockState.notices).toContain(
      `Claude Code CLI not found for "definitely-not-a-real-command-issue-158". Install it first, for example with brew install --cask claude-code, then update Work Terminal's Claude command setting if needed.`,
    );
    expect((view as any).recentlyClosedStore.serialize()).toEqual([
      expect.objectContaining({
        label: "Recovered Claude",
        itemId: "task-1",
      }),
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

    // Simulate browser behavior: click fires first, then dblclick
    secondTab.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
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
        agentSessionId: "session-456",
      },
      0,
      new dom.window.MouseEvent("contextmenu"),
    );

    mockState.menuActions.get("Restart")?.();
    await flushAsync();

    expect(mockState.latestCreateTabArgs?.[0]).toBe("task-1");
  });

  it("shows install guidance when restarting a Claude tab without an available CLI", async () => {
    const { view } = createView({
      "core.claudeCommand": "definitely-not-a-real-command-issue-158",
      "core.defaultTerminalCwd": "~/fallback",
    });
    await flushAsync();

    (view as any).showTabContextMenu(
      {
        sessionType: "claude",
        label: "Recovered Claude",
        taskPath: "task-1",
        agentSessionId: "session-456",
      },
      0,
      new dom.window.MouseEvent("contextmenu"),
    );

    mockState.menuActions.get("Restart")?.();
    await flushAsync();

    expect(mockState.latestCreateTabArgs).toBeNull();
    expect(mockState.notices).toContain(
      `Claude Code CLI not found for "definitely-not-a-real-command-issue-158". Install it first, for example with brew install --cask claude-code, then update Work Terminal's Claude command setting if needed.`,
    );
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

    await (view as any).spawnClaudeSession({ sessionType: "claude" });

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

    await (view as any).spawnCopilotSession({ sessionType: "copilot" });

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

  it("merges multiline continuation args from settings and custom launches", async () => {
    const { view } = createView({
      "core.claudeCommand": "/bin/echo",
      "core.defaultTerminalCwd": "~/ctx",
      "core.claudeExtraArgs": `--dangerously-skip-permissions \\
        --plugin-dir /path/a`,
    });
    await flushAsync();

    await (view as any).spawnClaudeSession({
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

  it("shows a notice instead of launching Strands when the configured command is blank", async () => {
    const { view } = createView({
      "core.strandsCommand": "   ",
      "core.defaultTerminalCwd": "~/one",
    });
    await flushAsync();

    await (view as any).spawnStrandsSession({
      sessionType: "strands",
      freshSettings: {
        "core.strandsCommand": "   ",
        "core.defaultTerminalCwd": "~/one",
      },
    });

    expect(mockState.latestCreateTabArgs).toBeNull();
    expect(mockState.notices).toContain(
      "Set a Strands command in Work Terminal settings before launching Strands sessions.",
    );
  });

  it("launches Strands with quoted POSIX executable paths intact", async () => {
    const { view } = createView({
      "core.strandsCommand": `"/Applications/Strands Agent/bin/python3" "./agents/agent.py"`,
      "core.strandsExtraArgs": "--mode interactive",
      "core.defaultTerminalCwd": "~/one",
    });
    await flushAsync();

    await (view as any).spawnStrandsSession({
      sessionType: "strands",
      prompt: "Review this task",
      freshSettings: {
        "core.strandsCommand": `"/Applications/Strands Agent/bin/python3" "./agents/agent.py"`,
        "core.strandsExtraArgs": "--mode interactive",
        "core.defaultTerminalCwd": "~/one",
      },
    });

    expect(mockState.notices).toEqual([]);
    expect(mockState.latestCreateTabArgs).toEqual([
      "/Applications/Strands Agent/bin/python3",
      expandTilde("~/one"),
      "Strands",
      "strands",
      undefined,
      [
        "/Applications/Strands Agent/bin/python3",
        "./agents/agent.py",
        "--mode",
        "interactive",
        "Review this task",
      ],
    ]);
  });

  it("keeps Windows absolute vault paths intact for Claude context prompts", async () => {
    const defaultElectronRequire = vi.mocked(electronRequire).getMockImplementation();
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
    expect(jiraLink?.textContent).toContain("↗");
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
