import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import type { PersistedSession } from "../core/session/types";
import { expandTilde } from "../core/utils";
import { TerminalPanelView } from "./TerminalPanelView";

const mockState = vi.hoisted(() => ({
  activeSessions: new Map<string, Array<{ sessionType: string }>>(),
  activeItemId: null as string | null,
  persistedSessions: [] as PersistedSession[],
  menuTitles: [] as string[],
  notices: [] as string[],
  latestCreateTabArgs: null as unknown[] | null,
  hookStatus: {
    scriptExists: false,
    hooksConfigured: false,
  },
  latestTabManager: null as {
    onSessionChange?: () => void;
    onClaudeStateChange?: (itemId: string, state: string) => void;
    onPersistRequest?: () => void;
  } | null,
  stopPeriodicPersist: vi.fn(),
}));

vi.mock("obsidian", () => ({
  App: class {},
  Menu: class {
    addSeparator() {}
    addItem(callback: (item: { setTitle: (title: string) => any; onClick: () => any }) => void) {
      callback({
        setTitle(title: string) {
          mockState.menuTitles.push(title);
          return this;
        },
        onClick() {
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

    getTabs() {
      return [];
    }

    getActiveTabIndex() {
      return 0;
    }

    createTab(...args: unknown[]) {
      mockState.latestCreateTabArgs = args;
      return null;
    }

    createTabForItem(...args: unknown[]) {
      mockState.latestCreateTabArgs = args;
      return null;
    }

    setActiveItem(_itemId: string | null) {}

    getSessionItemIds() {
      return [];
    }

    getClaudeState() {
      return "inactive";
    }

    closeAllSessions(_itemId: string) {}

    closeTab(_index: number) {}

    switchToTab(_index: number) {}
  },
}));

vi.mock("../core/session/SessionPersistence", () => ({
  PERSIST_INTERVAL_MS: 30000,
  SessionPersistence: {
    startPeriodicPersist: vi.fn(() => mockState.stopPeriodicPersist),
    loadFromDisk: vi.fn(async () => mockState.persistedSessions),
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
    },
    manifest: {
      id: "work-terminal",
    },
  };
}

function createView(
  settings: Record<string, unknown> = {},
  pluginOverrides: Partial<ReturnType<typeof createPlugin>> = {},
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
    { config: { itemName: "task" } } as any,
    { "core.defaultTerminalCwd": "~" },
    {} as any,
    vi.fn(),
    vi.fn(),
  );

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
    mockState.activeItemId = null;
    mockState.persistedSessions = [];
    mockState.menuTitles = [];
    mockState.notices = [];
    mockState.latestCreateTabArgs = null;
    mockState.hookStatus = { scriptExists: false, hooksConfigured: false };
    mockState.latestTabManager = null;
    mockState.stopPeriodicPersist.mockClear();
  });

  afterEach(() => {
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
    const getClaudeContextPrompt = vi
      .spyOn(view as any, "getClaudeContextPrompt")
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
    expect(getClaudeContextPrompt).toHaveBeenCalledWith(item, fresh);
    expect(spawnCopilotSession).toHaveBeenCalledWith({
      sessionType: "copilot-with-context",
      cwd: "~/custom",
      extraArgs: "--flag",
      label: "Custom Copilot",
      prompt: "Prompt A for Task One",
      freshSettings: fresh,
    });
  });
});
