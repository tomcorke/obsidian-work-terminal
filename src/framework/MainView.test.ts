import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import type { WorkItem } from "../core/interfaces";

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
}));

vi.mock("./PluginBase", () => ({
  VIEW_TYPE: "work-terminal-view",
}));

vi.mock("../core/session/SessionStore", () => ({
  SessionStore: {
    isReload: vi.fn(() => false),
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
      selectById: vi.fn(),
    };
    const terminalPanel = {
      getActiveItemId: vi.fn(() => item.id),
      rekeyItem: vi.fn(),
      persistSessions: vi.fn().mockResolvedValue(undefined),
      setActiveItem: vi.fn(),
      setTitle: vi.fn(),
    };

    (view as any).parser = parser;
    (view as any).listPanel = listPanel;
    (view as any).terminalPanel = terminalPanel;

    await (view as any).ensureSelectedItemHasDurableId(item);

    expect(parser.backfillItemId).toHaveBeenCalledWith(item);
    expect(terminalPanel.rekeyItem).toHaveBeenCalledWith(item.id, updatedItem.id);
    expect(refreshSpy).toHaveBeenCalled();
    expect(terminalPanel.persistSessions).toHaveBeenCalled();
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
      selectById: vi.fn(),
    };
    const terminalPanel = {
      getActiveItemId: vi.fn(() => "different-item"),
      rekeyItem: vi.fn(),
      persistSessions: vi.fn().mockResolvedValue(undefined),
      setActiveItem: vi.fn(),
      setTitle: vi.fn(),
    };

    (view as any).parser = parser;
    (view as any).listPanel = listPanel;
    (view as any).terminalPanel = terminalPanel;

    await (view as any).ensureSelectedItemHasDurableId(item);

    expect(terminalPanel.rekeyItem).toHaveBeenCalledWith(item.id, updatedItem.id);
    expect(refreshSpy).toHaveBeenCalled();
    expect(terminalPanel.persistSessions).toHaveBeenCalled();
    expect(listPanel.selectById).not.toHaveBeenCalled();
    expect(terminalPanel.setActiveItem).not.toHaveBeenCalled();
    expect(terminalPanel.setTitle).not.toHaveBeenCalled();
  });
});
