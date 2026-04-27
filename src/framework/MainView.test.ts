import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { TFile } from "obsidian";
import type { WorkItem } from "../core/interfaces";
import { mergeAndSavePluginData } from "../core/PluginDataStore";
import type { TerminalPanelView } from "./TerminalPanelView";

vi.mock("obsidian", () => ({
  ItemView: class {
    app: unknown;
    leaf: unknown;
    contentEl: HTMLElement;

    constructor(leaf: unknown) {
      this.leaf = leaf;
      this.app = {};
      this.contentEl = document.createElement("div");
    }
  },
  TFile: class {},
  WorkspaceLeaf: class {},
}));

vi.mock("./ListPanel", () => ({
  ListPanel: class {},
}));

vi.mock("./TerminalPanelView", () => ({
  TerminalPanelView: class {},
}));

vi.mock("./PromptBox", () => ({
  PromptBox: class {},
}));

vi.mock("./SettingsTab", () => ({
  loadAllSettings: vi.fn(),
  SETTINGS_CHANGED_EVENT: "work-terminal:settings-changed",
}));

vi.mock("./PluginBase", () => ({
  VIEW_TYPE: "work-terminal-view",
}));

vi.mock("./version", () => ({
  formatVersionForTabTitle: (enabled: boolean) => (enabled ? " (test-version)" : ""),
}));

const { sessionStoreIsReloadMock } = vi.hoisted(() => ({
  sessionStoreIsReloadMock: vi.fn(() => false),
}));
vi.mock("../core/session/SessionStore", () => ({
  SessionStore: {
    isReload: sessionStoreIsReloadMock,
  },
}));

vi.mock("../core/PluginDataStore", () => ({
  mergeAndSavePluginData: vi.fn(),
}));

import { MainView } from "./MainView";

function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "2 - Areas/Tasks/active/task.md",
    path: "2 - Areas/Tasks/active/task.md",
    title: "Task",
    state: "active",
    metadata: {},
    ...overrides,
  };
}

describe("MainView selection ID backfill", () => {
  let dom: JSDOM;

  beforeEach(() => {
    vi.clearAllMocks();
    dom = new JSDOM("<!doctype html><html><body></body></html>");
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    dom.window.close();
  });

  it("rekeys the active selection after a missing ID is backfilled", async () => {
    const view = new MainView({} as any, {} as any, {} as any);
    const item = makeItem();
    const updatedItem = makeItem({ id: "uuid-123" });
    const refreshSpy = vi.spyOn(view as any, "refreshList").mockResolvedValue(undefined);
    const parser = {
      backfillItemId: vi.fn().mockResolvedValue(updatedItem),
    };
    const listPanel = {
      rekeyCustomOrder: vi.fn(() => true),
      getCustomOrder: vi.fn(() => ({ active: [updatedItem.id] })),
      selectById: vi.fn(),
    };
    const terminalPanel: Pick<
      TerminalPanelView,
      "getActiveItemId" | "rekeyItem" | "setActiveItem" | "setTitle"
    > = {
      getActiveItemId: vi.fn(() => item.id),
      rekeyItem: vi.fn(),
      setActiveItem: vi.fn(),
      setTitle: vi.fn(),
    };
    const lastActiveStore = { rekey: vi.fn() };

    (view as any).parser = parser;
    (view as any).listPanel = listPanel;
    (view as any).terminalPanel = terminalPanel;
    (view as any).lastActiveStore = lastActiveStore;

    await (view as any).ensureSelectedItemHasDurableId(item);

    expect(parser.backfillItemId).toHaveBeenCalledWith(item);
    expect(terminalPanel.rekeyItem).toHaveBeenCalledWith(item.id, updatedItem.id);
    expect(lastActiveStore.rekey).toHaveBeenCalledWith(item.id, updatedItem.id);
    expect(listPanel.rekeyCustomOrder).toHaveBeenCalledWith(item.id, updatedItem.id);
    expect(mergeAndSavePluginData).toHaveBeenCalledTimes(1);
    expect(mergeAndSavePluginData).toHaveBeenCalledWith(expect.anything(), expect.any(Function));
    expect(refreshSpy).toHaveBeenCalled();
    expect(listPanel.selectById).toHaveBeenCalledWith(updatedItem.id);
    expect(terminalPanel.setActiveItem).not.toHaveBeenCalled();
    expect(terminalPanel.setTitle).not.toHaveBeenCalled();
  });

  it("does not steal selection back if another item becomes active first", async () => {
    const view = new MainView({} as any, {} as any, {} as any);
    const item = makeItem();
    const updatedItem = makeItem({ id: "uuid-123" });
    const refreshSpy = vi.spyOn(view as any, "refreshList").mockResolvedValue(undefined);
    const parser = {
      backfillItemId: vi.fn().mockResolvedValue(updatedItem),
    };
    const listPanel = {
      rekeyCustomOrder: vi.fn(() => false),
      selectById: vi.fn(),
    };
    const terminalPanel: Pick<
      TerminalPanelView,
      "getActiveItemId" | "rekeyItem" | "setActiveItem" | "setTitle"
    > = {
      getActiveItemId: vi.fn(() => "different-item"),
      rekeyItem: vi.fn(),
      setActiveItem: vi.fn(),
      setTitle: vi.fn(),
    };
    const lastActiveStore = { rekey: vi.fn() };

    (view as any).parser = parser;
    (view as any).listPanel = listPanel;
    (view as any).terminalPanel = terminalPanel;
    (view as any).lastActiveStore = lastActiveStore;

    await (view as any).ensureSelectedItemHasDurableId(item);

    expect(terminalPanel.rekeyItem).toHaveBeenCalledWith(item.id, updatedItem.id);
    expect(lastActiveStore.rekey).toHaveBeenCalledWith(item.id, updatedItem.id);
    expect(listPanel.rekeyCustomOrder).toHaveBeenCalledWith(item.id, updatedItem.id);
    expect(mergeAndSavePluginData).not.toHaveBeenCalled();
    expect(refreshSpy).toHaveBeenCalled();
    expect(listPanel.selectById).not.toHaveBeenCalled();
    expect(terminalPanel.setActiveItem).not.toHaveBeenCalled();
    expect(terminalPanel.setTitle).not.toHaveBeenCalled();
  });

  it("uses YAML-normalized ids when recovering rename matches from raw frontmatter", async () => {
    const view = new MainView({} as any, {} as any, {} as any);
    const oldPath = "2 - Areas/Tasks/todo/task.md";
    const newPath = "2 - Areas/Tasks/active/task.md";
    const file = new TFile();
    Object.assign(file, { path: newPath });

    const listPanel = {
      rekeyCustomOrder: vi.fn(() => true),
      getCustomOrder: vi.fn(() => ({ active: ["uuid-123"] })),
    };
    const terminalPanel: Pick<TerminalPanelView, "rekeyItem"> = {
      rekeyItem: vi.fn(),
    };

    (view as any).listPanel = listPanel;
    (view as any).terminalPanel = terminalPanel;
    (view as any).pendingRenames.set(oldPath, {
      uuid: "uuid-123",
      path: oldPath,
      timeout: setTimeout(() => {}, 1000),
    });
    (view as any).app = {
      metadataCache: {
        getCache: vi.fn(() => ({ frontmatter: { id: undefined } })),
      },
      vault: {
        getAbstractFileByPath: vi.fn(() => file),
        cachedRead: vi
          .fn()
          .mockResolvedValue('---\nid: "uuid-123" # comment\nstate: active\n---\nBody'),
      },
    };

    await (view as any).handleCreate(newPath);

    expect(terminalPanel.rekeyItem).toHaveBeenCalledWith(oldPath, newPath);
    expect(listPanel.rekeyCustomOrder).toHaveBeenCalledWith(oldPath, newPath);
    expect(mergeAndSavePluginData).toHaveBeenCalledTimes(1);
  });

  it("does not fall back to same-folder matching when a different durable ID is present", async () => {
    const view = new MainView({} as any, {} as any, {} as any);
    const oldPath = "2 - Areas/Tasks/todo/task.md";
    const newPath = "2 - Areas/Tasks/todo/other-task.md";
    const file = new TFile();
    Object.assign(file, { path: newPath });

    const listPanel = {
      rekeyCustomOrder: vi.fn(() => true),
      getCustomOrder: vi.fn(() => ({ todo: ["uuid-123"] })),
    };
    const terminalPanel: Pick<TerminalPanelView, "rekeyItem"> = {
      rekeyItem: vi.fn(),
    };

    (view as any).listPanel = listPanel;
    (view as any).terminalPanel = terminalPanel;
    (view as any).pendingRenames.set(oldPath, {
      uuid: "uuid-123",
      path: oldPath,
      timeout: setTimeout(() => {}, 1000),
    });
    (view as any).app = {
      metadataCache: {
        getCache: vi.fn(() => ({ frontmatter: { id: undefined } })),
      },
      vault: {
        getAbstractFileByPath: vi.fn(() => file),
        cachedRead: vi.fn().mockResolvedValue('---\nid: "different-uuid"\nstate: todo\n---\nBody'),
      },
    };

    await (view as any).handleCreate(newPath);

    expect(terminalPanel.rekeyItem).not.toHaveBeenCalled();
    expect(listPanel.rekeyCustomOrder).not.toHaveBeenCalled();
    expect(mergeAndSavePluginData).not.toHaveBeenCalled();
  });

  it("renders with the in-memory rekeyed custom order until rename persistence completes", async () => {
    const view = new MainView(
      {} as any,
      {} as any,
      {
        loadData: vi.fn().mockResolvedValue({ customOrder: { todo: ["stale-path"] } }),
      } as any,
    );
    const persistPromise = new Promise<void>(() => {});
    vi.mocked(mergeAndSavePluginData).mockReturnValue(persistPromise);

    const listPanel = {
      getCustomOrder: vi.fn(() => ({ todo: ["uuid-123"] })),
      rekeyCustomOrder: vi.fn(() => true),
      render: vi.fn(),
      setPinnedCustomStates: vi.fn(),
    };
    const parser = {
      loadAll: vi.fn().mockResolvedValue([]),
      groupByColumn: vi.fn(() => ({ todo: [] })),
    };
    const terminalPanel: Pick<TerminalPanelView, "rekeyItem" | "setItems"> = {
      rekeyItem: vi.fn(),
      setItems: vi.fn(),
    };

    (view as any).listPanel = listPanel;
    (view as any).parser = parser;
    (view as any).terminalPanel = terminalPanel;
    (view as any).adapter = {
      config: { columns: [{ id: "todo", label: "To Do", folderName: "todo" }] },
    };

    (view as any).handleRename("2 - Areas/Tasks/todo/task-renamed.md", "stale-path");
    await (view as any).refreshList();

    expect(listPanel.render).toHaveBeenCalledWith({ todo: [] }, { todo: ["uuid-123"] });
  });
});

describe("MainView stash-on-close (keepSessionsAlive)", () => {
  let dom: JSDOM;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionStoreIsReloadMock.mockReturnValue(false);
    dom = new JSDOM("<!doctype html><html><body></body></html>");
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    dom.window.close();
  });

  function makeView(settings: Record<string, unknown> = {}) {
    const view = new MainView({} as any, {} as any, { isReloading: false } as any);
    (view as any).settings = { "core.keepSessionsAlive": true, ...settings };
    return view;
  }

  function makeTerminalPanel(): Pick<
    TerminalPanelView,
    "stashAll" | "disposeAll" | "hasAnySessions"
  > {
    return {
      stashAll: vi.fn(),
      disposeAll: vi.fn(),
      hasAnySessions: vi.fn(() => true),
    };
  }

  it("stashes sessions instead of disposing when keepSessionsAlive is enabled", async () => {
    const view = makeView({ "core.keepSessionsAlive": true });
    const terminalPanel = makeTerminalPanel();
    (view as any).terminalPanel = terminalPanel;
    (view as any).listPanel = { dispose: vi.fn() };
    (view as any).vaultEventRefs = [];
    (view as any).pendingRenames = new Map();
    (view as any).adapter = {};

    await view.onClose();

    expect(terminalPanel.stashAll).toHaveBeenCalled();
    expect(terminalPanel.disposeAll).not.toHaveBeenCalled();
  });

  it("disposes sessions when keepSessionsAlive is disabled", async () => {
    const view = makeView({ "core.keepSessionsAlive": false });
    const terminalPanel = makeTerminalPanel();
    (view as any).terminalPanel = terminalPanel;
    (view as any).listPanel = { dispose: vi.fn() };
    (view as any).vaultEventRefs = [];
    (view as any).pendingRenames = new Map();
    (view as any).adapter = {};

    await view.onClose();

    expect(terminalPanel.disposeAll).toHaveBeenCalled();
    expect(terminalPanel.stashAll).not.toHaveBeenCalled();
  });

  it("defaults to stashing when keepSessionsAlive setting is absent", async () => {
    const view = makeView({});
    // Remove the setting entirely to test the default
    delete (view as any).settings["core.keepSessionsAlive"];
    const terminalPanel = makeTerminalPanel();
    (view as any).terminalPanel = terminalPanel;
    (view as any).listPanel = { dispose: vi.fn() };
    (view as any).vaultEventRefs = [];
    (view as any).pendingRenames = new Map();
    (view as any).adapter = {};

    await view.onClose();

    expect(terminalPanel.stashAll).toHaveBeenCalled();
    expect(terminalPanel.disposeAll).not.toHaveBeenCalled();
  });

  it("does not double-stash if SessionStore already has stashed data", async () => {
    sessionStoreIsReloadMock.mockReturnValue(true);
    const view = makeView({ "core.keepSessionsAlive": true });
    const terminalPanel = makeTerminalPanel();
    (view as any).terminalPanel = terminalPanel;
    (view as any).listPanel = { dispose: vi.fn() };
    (view as any).vaultEventRefs = [];
    (view as any).pendingRenames = new Map();
    (view as any).adapter = {};

    await view.onClose();

    expect(terminalPanel.stashAll).not.toHaveBeenCalled();
  });

  it("skips close guard confirmation when keepSessionsAlive is enabled", () => {
    const view = makeView({ "core.keepSessionsAlive": true });
    const terminalPanel = makeTerminalPanel();
    (view as any).terminalPanel = terminalPanel;

    const origDetach = vi.fn();
    const leaf = { detach: origDetach };
    (view as any).leaf = leaf;
    (view as any)._origLeafDetach = origDetach;

    // Install the close guard
    (view as any).installCloseGuard();

    // Spy on confirm - should NOT be called
    const confirmSpy = vi.spyOn(dom.window, "confirm" as any).mockReturnValue(false);
    vi.stubGlobal("confirm", confirmSpy);

    // Trigger detach
    leaf.detach();

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(origDetach).toHaveBeenCalled();
  });

  it("shows close guard confirmation when keepSessionsAlive is disabled", () => {
    const view = makeView({ "core.keepSessionsAlive": false });
    const terminalPanel = makeTerminalPanel();
    (view as any).terminalPanel = terminalPanel;

    const origDetach = vi.fn();
    const leaf = { detach: origDetach };
    (view as any).leaf = leaf;
    (view as any)._origLeafDetach = origDetach;

    // Install the close guard
    (view as any).installCloseGuard();

    const confirmSpy = vi.fn().mockReturnValue(true);
    vi.stubGlobal("confirm", confirmSpy);

    // Trigger detach
    leaf.detach();

    expect(confirmSpy).toHaveBeenCalled();
    expect(origDetach).toHaveBeenCalled();
  });
});

describe("MainView activity timestamp seeding", () => {
  let dom: JSDOM;

  beforeEach(() => {
    vi.clearAllMocks();
    dom = new JSDOM("<!doctype html><html><body></body></html>");
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    dom.window.close();
  });

  it("prefers plugin-data timestamps over legacy frontmatter fallback", async () => {
    const view = new MainView({} as any, {} as any, {} as any);
    const item = makeItem({
      id: "uuid-123",
      metadata: { lastActive: "2026-04-15T08:00:00Z" },
    });
    const activityTracker = {
      seedTimestamp: vi.fn(),
    };
    const lastActiveStore = {
      get: vi.fn((itemId: string) => (itemId === "uuid-123" ? "2026-04-16T10:00:00Z" : undefined)),
      pruneMissingPathIds: vi.fn(),
    };
    const listPanel = {
      render: vi.fn(),
      setPinnedCustomStates: vi.fn(),
    };
    const parser = {
      loadAll: vi.fn(async () => [item]),
      groupByColumn: vi.fn(() => ({ active: [item] })),
    };
    const terminalPanel = {
      setItems: vi.fn(),
    };

    (view as any).activityTracker = activityTracker;
    (view as any).lastActiveStore = lastActiveStore;
    (view as any).listPanel = listPanel;
    (view as any).parser = parser;
    (view as any).terminalPanel = terminalPanel;
    (view as any).settings = { "adapter.pinnedCustomStates": "[]" };
    (view as any).adapter = {
      config: { columns: [{ id: "active", label: "Active", folderName: "active" }] },
    };
    (view as any).pluginRef = { loadData: vi.fn(async () => ({ customOrder: {} })) };

    await (view as any).refreshList();

    expect(activityTracker.seedTimestamp).toHaveBeenCalledWith("uuid-123", "2026-04-16T10:00:00Z");
    expect(activityTracker.seedTimestamp).toHaveBeenCalledTimes(1);
    expect(lastActiveStore.pruneMissingPathIds).toHaveBeenCalledWith(["uuid-123"]);
  });

  it("falls back to legacy frontmatter when plugin data is missing or invalid", async () => {
    const view = new MainView({} as any, {} as any, {} as any);
    const item = makeItem({
      id: "uuid-123",
      metadata: { lastActive: "2026-04-15T08:00:00Z" },
    });
    const activityTracker = {
      seedTimestamp: vi.fn(),
    };
    const lastActiveStore = {
      get: vi.fn(() => "not-a-date"),
      pruneMissingPathIds: vi.fn(),
    };
    const listPanel = {
      render: vi.fn(),
      setPinnedCustomStates: vi.fn(),
    };
    const parser = {
      loadAll: vi.fn(async () => [item]),
      groupByColumn: vi.fn(() => ({ active: [item] })),
    };
    const terminalPanel = {
      setItems: vi.fn(),
    };

    (view as any).activityTracker = activityTracker;
    (view as any).lastActiveStore = lastActiveStore;
    (view as any).listPanel = listPanel;
    (view as any).parser = parser;
    (view as any).terminalPanel = terminalPanel;
    (view as any).settings = { "adapter.pinnedCustomStates": "[]" };
    (view as any).adapter = {
      config: { columns: [{ id: "active", label: "Active", folderName: "active" }] },
    };
    (view as any).pluginRef = { loadData: vi.fn(async () => ({ customOrder: {} })) };

    await (view as any).refreshList();

    expect(activityTracker.seedTimestamp).toHaveBeenCalledWith("uuid-123", "2026-04-15T08:00:00Z");
  });
});

describe("MainView dynamic column cleanup", () => {
  let dom: JSDOM;

  beforeEach(() => {
    vi.clearAllMocks();
    dom = new JSDOM("<!doctype html><html><body></body></html>");
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    dom.window.close();
  });

  function makeRefreshView(opts: {
    columnOrder: string;
    pinnedCustomStates?: string;
    groups: Record<string, WorkItem[]>;
    columns: { id: string; label: string; folderName?: string }[];
  }) {
    const savedData: Record<string, any> = {
      settings: {
        "adapter.columnOrder": opts.columnOrder,
        "adapter.pinnedCustomStates": opts.pinnedCustomStates || "[]",
      },
      customOrder: {},
    };
    const pluginRef = {
      loadData: vi.fn(async () => savedData),
      saveData: vi.fn(async (data: Record<string, any>) => {
        Object.assign(savedData, data);
      }),
    };
    // Override the mergeAndSavePluginData mock to actually run the update
    vi.mocked(mergeAndSavePluginData).mockImplementation(async (plugin, update) => {
      const data = (await (plugin as any).loadData()) || {};
      await update(data);
      await (plugin as any).saveData(data);
    });
    const view = new MainView({} as any, {} as any, pluginRef as any);

    const listPanel = {
      render: vi.fn(),
      setPinnedCustomStates: vi.fn(),
    };
    const parser = {
      loadAll: vi.fn(async () => {
        const items: WorkItem[] = [];
        for (const group of Object.values(opts.groups)) {
          items.push(...group);
        }
        return items;
      }),
      groupByColumn: vi.fn(() => opts.groups),
    };
    const terminalPanel = {
      setItems: vi.fn(),
    };

    (view as any).listPanel = listPanel;
    (view as any).parser = parser;
    (view as any).terminalPanel = terminalPanel;
    (view as any).settings = savedData.settings;
    (view as any).adapter = {
      config: { columns: [...opts.columns] },
    };

    return { view, listPanel, savedData };
  }

  it("removes empty unpinned dynamic columns from column order", async () => {
    const { view, savedData } = makeRefreshView({
      columnOrder: '["priority", "review", "active", "todo", "done"]',
      columns: [
        { id: "priority", label: "Priority", folderName: "priority" },
        { id: "review", label: "Review" },
        { id: "active", label: "Active", folderName: "active" },
        { id: "todo", label: "To Do", folderName: "todo" },
        { id: "done", label: "Done", folderName: "archive" },
      ],
      groups: {
        priority: [],
        active: [makeItem({ id: "t1", state: "active" })],
        todo: [],
        done: [],
        // "review" has zero tasks - should be removed
      },
    });

    await (view as any).refreshList();

    // The column order should have "review" removed
    expect(savedData.settings["adapter.columnOrder"]).toBe('["priority","active","todo","done"]');
  });

  it("preserves pinned dynamic columns even when empty", async () => {
    const { view, savedData, listPanel } = makeRefreshView({
      columnOrder: '["priority", "review", "active", "todo", "done"]',
      pinnedCustomStates: '["review"]',
      columns: [
        { id: "priority", label: "Priority", folderName: "priority" },
        { id: "review", label: "Review" },
        { id: "active", label: "Active", folderName: "active" },
        { id: "todo", label: "To Do", folderName: "todo" },
        { id: "done", label: "Done", folderName: "archive" },
      ],
      groups: {
        priority: [],
        active: [],
        todo: [],
        done: [],
        // "review" has zero tasks but is pinned - should be preserved
      },
    });

    await (view as any).refreshList();

    // Column order should NOT have been changed (review is pinned)
    expect(savedData.settings["adapter.columnOrder"]).toBe(
      '["priority", "review", "active", "todo", "done"]',
    );

    // ListPanel should be told about pinned custom states
    expect(listPanel.setPinnedCustomStates).toHaveBeenCalledWith(["review"]);
  });

  it("never removes predefined columns even when empty", async () => {
    const { view, savedData } = makeRefreshView({
      columnOrder: '["priority", "active", "todo", "done"]',
      columns: [
        { id: "priority", label: "Priority", folderName: "priority" },
        { id: "active", label: "Active", folderName: "active" },
        { id: "todo", label: "To Do", folderName: "todo" },
        { id: "done", label: "Done", folderName: "archive" },
      ],
      groups: {
        // All columns empty
        priority: [],
        active: [],
        todo: [],
        done: [],
      },
    });

    await (view as any).refreshList();

    // Predefined columns are always kept
    expect(savedData.settings["adapter.columnOrder"]).toBe(
      '["priority", "active", "todo", "done"]',
    );
  });

  it("keeps dynamic columns that still have tasks", async () => {
    const { view, savedData } = makeRefreshView({
      columnOrder: '["priority", "review", "active", "todo", "done"]',
      columns: [
        { id: "priority", label: "Priority", folderName: "priority" },
        { id: "review", label: "Review" },
        { id: "active", label: "Active", folderName: "active" },
        { id: "todo", label: "To Do", folderName: "todo" },
        { id: "done", label: "Done", folderName: "archive" },
      ],
      groups: {
        priority: [],
        review: [makeItem({ id: "t1", state: "review" })],
        active: [],
        todo: [],
        done: [],
      },
    });

    await (view as any).refreshList();

    // "review" has tasks so should be kept
    expect(savedData.settings["adapter.columnOrder"]).toBe(
      '["priority", "review", "active", "todo", "done"]',
    );
  });
});

describe("MainView detail placement remount on settings change", () => {
  let dom: JSDOM;

  beforeEach(() => {
    vi.clearAllMocks();
    dom = new JSDOM("<!doctype html><html><body></body></html>");
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    dom.window.close();
  });

  function setupView(initialPlacement: string) {
    const view = new MainView({} as any, {} as any, {} as any);
    const detachDetailView = vi.fn();
    const createDetailView = vi.fn();
    const embeddedHost = document.createElement("div");
    const previewHost = document.createElement("div");
    const terminalPanel = {
      getActiveItemId: vi.fn(() => "task-1"),
      getEmbeddedDetailHost: vi.fn(() => embeddedHost),
      getPreviewDetailHost: vi.fn(() => previewHost),
      activateEmbeddedDetail: vi.fn(),
      deactivateEmbeddedDetail: vi.fn(),
      activatePreviewDetail: vi.fn(),
      deactivatePreviewDetail: vi.fn(),
    };
    const adapter = {
      config: { creationColumns: [] },
      onSettingsChanged: vi.fn(),
      detachDetailView,
      createDetailView,
    };
    const item = makeItem({ id: "task-1", path: "Tasks/task-1.md" });
    (view as any).adapter = adapter;
    (view as any).terminalPanel = terminalPanel;
    (view as any).listPanel = { updateSettings: vi.fn() };
    (view as any).promptBox = { updateCreationColumns: vi.fn() };
    (view as any).allItems = [item];
    (view as any).settings = { "core.detailViewPlacement": initialPlacement };
    (view as any).app = {};
    (view as any).leaf = {};
    // Stub scheduleRefresh to avoid triggering a real timer-backed refresh
    vi.spyOn(view as any, "scheduleRefresh").mockImplementation(() => {});
    return { view, adapter, terminalPanel, item, embeddedHost, previewHost };
  }

  it("re-mounts the detail view when placement changes away from preview", () => {
    const { view, adapter, terminalPanel, item } = setupView("preview");
    const event = new dom.window.CustomEvent("work-terminal:settings-changed", {
      detail: { "core.detailViewPlacement": "split" },
    });
    (view as any)._handleSettingsChanged(event);

    expect(adapter.detachDetailView).toHaveBeenCalledTimes(1);
    // Non-embedded / non-preview placements receive null for both hosts
    expect(adapter.createDetailView).toHaveBeenCalledWith(item, {}, {}, null, null);
    // Should flip both detail modes off so neither pseudo-tab host lingers
    expect(terminalPanel.deactivatePreviewDetail).toHaveBeenCalled();
    expect(terminalPanel.deactivateEmbeddedDetail).toHaveBeenCalled();
  });

  it("re-mounts the detail view when placement changes TO preview", () => {
    const { view, adapter, terminalPanel, item, previewHost } = setupView("split");
    const event = new dom.window.CustomEvent("work-terminal:settings-changed", {
      detail: { "core.detailViewPlacement": "preview" },
    });
    (view as any)._handleSettingsChanged(event);

    expect(adapter.detachDetailView).toHaveBeenCalledTimes(1);
    // Preview placement should receive the preview host and no embedded host
    expect(adapter.createDetailView).toHaveBeenCalledWith(item, {}, {}, null, previewHost);
    // Preview pseudo-tab should be activated so the new host becomes visible
    // without requiring a reselect
    expect(terminalPanel.activatePreviewDetail).toHaveBeenCalled();
  });

  it("does not remount when placement is unchanged", () => {
    const { view, adapter } = setupView("split");
    const event = new dom.window.CustomEvent("work-terminal:settings-changed", {
      detail: { "core.detailViewPlacement": "split", "core.other": "changed" },
    });
    (view as any)._handleSettingsChanged(event);

    expect(adapter.detachDetailView).not.toHaveBeenCalled();
    expect(adapter.createDetailView).not.toHaveBeenCalled();
  });

  it("still detaches the detail view when placement changes but no item is selected", () => {
    const { view, adapter, terminalPanel } = setupView("preview");
    terminalPanel.getActiveItemId.mockReturnValue(null);
    const event = new dom.window.CustomEvent("work-terminal:settings-changed", {
      detail: { "core.detailViewPlacement": "split" },
    });
    (view as any)._handleSettingsChanged(event);

    // Detach runs unconditionally so the preview view's vault modify
    // listener is released even when no item is currently selected.
    expect(adapter.detachDetailView).toHaveBeenCalledTimes(1);
    expect(adapter.createDetailView).not.toHaveBeenCalled();
  });
});

describe("MainView getDisplayText version suffix", () => {
  let dom: JSDOM;

  beforeEach(() => {
    vi.clearAllMocks();
    dom = new JSDOM("<!doctype html><html><body></body></html>");
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    dom.window.close();
  });

  it("includes the version suffix when core.showVersionInTabTitle is true", () => {
    const view = new MainView({} as any, {} as any, {} as any);
    (view as any).settings = { "core.showVersionInTabTitle": true };
    expect(view.getDisplayText()).toBe("Work Terminal (test-version)");
  });

  it("omits the version suffix when core.showVersionInTabTitle is false", () => {
    const view = new MainView({} as any, {} as any, {} as any);
    (view as any).settings = { "core.showVersionInTabTitle": false };
    expect(view.getDisplayText()).toBe("Work Terminal");
  });

  it("defaults to including the suffix when the setting is absent", () => {
    const view = new MainView({} as any, {} as any, {} as any);
    // Settings object exists but the key is absent - default should be enabled
    (view as any).settings = {};
    expect(view.getDisplayText()).toBe("Work Terminal (test-version)");
  });

  it("defaults to including the suffix when the setting is explicitly undefined", () => {
    const view = new MainView({} as any, {} as any, {} as any);
    (view as any).settings = { "core.showVersionInTabTitle": undefined };
    expect(view.getDisplayText()).toBe("Work Terminal (test-version)");
  });
});

describe("MainView settings-driven tab title refresh", () => {
  let dom: JSDOM;

  beforeEach(() => {
    vi.clearAllMocks();
    dom = new JSDOM("<!doctype html><html><body></body></html>");
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    dom.window.close();
  });

  function setupView(initialShowVersion: boolean | undefined, leafOverrides: any = {}) {
    const updateHeader = vi.fn();
    const leaf = { updateHeader, ...leafOverrides };
    const view = new MainView(leaf as any, {} as any, {} as any);
    const adapter = {
      config: { creationColumns: [] },
      onSettingsChanged: vi.fn(),
    };
    (view as any).adapter = adapter;
    (view as any).listPanel = { updateSettings: vi.fn() };
    (view as any).promptBox = { updateCreationColumns: vi.fn() };
    (view as any).settings =
      initialShowVersion === undefined ? {} : { "core.showVersionInTabTitle": initialShowVersion };
    vi.spyOn(view as any, "scheduleRefresh").mockImplementation(() => {});
    return { view, updateHeader, leaf };
  }

  it("calls leaf.updateHeader when core.showVersionInTabTitle toggles from true to false", () => {
    const { view, updateHeader } = setupView(true);
    const event = new dom.window.CustomEvent("work-terminal:settings-changed", {
      detail: { "core.showVersionInTabTitle": false },
    });
    (view as any)._handleSettingsChanged(event);

    expect(updateHeader).toHaveBeenCalledTimes(1);
    // getDisplayText should now reflect the new value
    expect(view.getDisplayText()).toBe("Work Terminal");
  });

  it("calls leaf.updateHeader when core.showVersionInTabTitle toggles from false to true", () => {
    const { view, updateHeader } = setupView(false);
    const event = new dom.window.CustomEvent("work-terminal:settings-changed", {
      detail: { "core.showVersionInTabTitle": true },
    });
    (view as any)._handleSettingsChanged(event);

    expect(updateHeader).toHaveBeenCalledTimes(1);
    expect(view.getDisplayText()).toBe("Work Terminal (test-version)");
  });

  it("does not call leaf.updateHeader when core.showVersionInTabTitle is unchanged", () => {
    const { view, updateHeader } = setupView(true);
    const event = new dom.window.CustomEvent("work-terminal:settings-changed", {
      detail: { "core.showVersionInTabTitle": true, "core.other": "changed" },
    });
    (view as any)._handleSettingsChanged(event);

    expect(updateHeader).not.toHaveBeenCalled();
  });

  it("does not throw when the leaf does not expose updateHeader", () => {
    const { view } = setupView(true, { updateHeader: undefined });
    // Remove updateHeader entirely to simulate an older Obsidian leaf shape
    delete ((view as any).leaf as any).updateHeader;
    const event = new dom.window.CustomEvent("work-terminal:settings-changed", {
      detail: { "core.showVersionInTabTitle": false },
    });
    expect(() => (view as any)._handleSettingsChanged(event)).not.toThrow();
    expect(view.getDisplayText()).toBe("Work Terminal");
  });
});
