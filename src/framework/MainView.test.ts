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

    (view as any).parser = parser;
    (view as any).listPanel = listPanel;
    (view as any).terminalPanel = terminalPanel;

    await (view as any).ensureSelectedItemHasDurableId(item);

    expect(parser.backfillItemId).toHaveBeenCalledWith(item);
    expect(terminalPanel.rekeyItem).toHaveBeenCalledWith(item.id, updatedItem.id);
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

    (view as any).parser = parser;
    (view as any).listPanel = listPanel;
    (view as any).terminalPanel = terminalPanel;

    await (view as any).ensureSelectedItemHasDurableId(item);

    expect(terminalPanel.rekeyItem).toHaveBeenCalledWith(item.id, updatedItem.id);
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
      config: { columns: [{ id: "todo", label: "To Do" }] },
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

describe("MainView writeLastActive", () => {
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

  function makeWriteView() {
    const view = new MainView({} as any, {} as any, {} as any);
    const file = new TFile();
    const modifyFn = vi.fn().mockResolvedValue(undefined);
    (view as any).allItems = [makeItem({ id: "item-1", path: "tasks/test.md" })];
    (view as any).app = {
      vault: {
        getAbstractFileByPath: vi.fn(() => file),
        read: vi.fn(),
        modify: modifyFn,
      },
    };
    return { view, file, modifyFn, readFn: (view as any).app.vault.read };
  }

  it("does not create a blank line when frontmatter body is empty", async () => {
    const { view, modifyFn, readFn } = makeWriteView();
    readFn.mockResolvedValue("---\n---\nBody content");

    await (view as any).writeLastActive("item-1", "2026-04-16T10:00:00Z");

    expect(modifyFn).toHaveBeenCalledTimes(1);
    const written = modifyFn.mock.calls[0][1] as string;
    // Should not have a blank line between opening --- and last-active
    expect(written).toBe("---\nlast-active: 2026-04-16T10:00:00Z\n---\nBody content");
  });

  it("preserves existing frontmatter fields when inserting last-active", async () => {
    const { view, modifyFn, readFn } = makeWriteView();
    readFn.mockResolvedValue("---\nid: uuid-123\nstate: active\n---\nBody");

    await (view as any).writeLastActive("item-1", "2026-04-16T10:00:00Z");

    const written = modifyFn.mock.calls[0][1] as string;
    expect(written).toBe(
      "---\nid: uuid-123\nstate: active\nlast-active: 2026-04-16T10:00:00Z\n---\nBody",
    );
  });

  it("updates existing last-active field", async () => {
    const { view, modifyFn, readFn } = makeWriteView();
    readFn.mockResolvedValue("---\nid: uuid-123\nlast-active: 2026-04-15T08:00:00Z\n---\nBody");

    await (view as any).writeLastActive("item-1", "2026-04-16T10:00:00Z");

    const written = modifyFn.mock.calls[0][1] as string;
    expect(written).toBe("---\nid: uuid-123\nlast-active: 2026-04-16T10:00:00Z\n---\nBody");
  });

  it("does not match last-active in markdown body outside frontmatter", async () => {
    const { view, modifyFn, readFn } = makeWriteView();
    readFn.mockResolvedValue(
      "---\nid: uuid-123\n---\nSome content\nlast-active: 2026-01-01T00:00:00Z\nMore content",
    );

    await (view as any).writeLastActive("item-1", "2026-04-16T10:00:00Z");

    const written = modifyFn.mock.calls[0][1] as string;
    // Should insert into frontmatter and leave body unchanged
    expect(written).toBe(
      "---\nid: uuid-123\nlast-active: 2026-04-16T10:00:00Z\n---\nSome content\nlast-active: 2026-01-01T00:00:00Z\nMore content",
    );
  });
});
