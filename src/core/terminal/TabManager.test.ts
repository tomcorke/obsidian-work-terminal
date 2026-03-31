/**
 * TabManager tests - covers state aggregation and agent state notification
 * on tab lifecycle events.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionType } from "../session/types";

const terminalTabMock = vi.hoisted(() => {
  class MockTerminalTab {
    static constructorArgs: any[][] = [];

    id = "mock-tab";
    label = "Shell";
    agentState: AgentState = "inactive";
    isResumableAgent = false;
    sessionType: SessionType = "shell";
    agentSessionId: string | null = null;
    taskPath = "item-1";
    isDisposed = false;
    onStateChange?: (state: AgentState) => void;
    onLabelChange?: () => void;
    onProcessExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
    dispose = vi.fn();
    show = vi.fn();
    hide = vi.fn();
    clearWaiting = vi.fn();
    getDiagnostics = vi.fn(() => ({
      tabId: this.id,
      label: this.label,
      sessionId: this.agentSessionId,
      sessionType: this.sessionType,
      claudeState: this.agentState,
      isResumableAgent: this.isResumableAgent,
      isVisible: true,
      isDisposed: this.isDisposed,
      process: {
        pid: null,
        status: "alive",
        killed: false,
        exitCode: null,
        signalCode: null,
        spawnTime: null,
        uptimeMs: null,
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
        screenLineCount: 0,
        screenTail: [],
      },
      derived: {
        blankButLiveRenderer: false,
        staleDisposedWebglOwnership: false,
      },
    }));

    constructor(...args: any[]) {
      MockTerminalTab.constructorArgs.push(args);
    }
  }

  return { MockTerminalTab };
});

// Mock TerminalTab before importing TabManager to prevent xterm.js loading
// in a Node.js environment where `self` is not defined.
vi.mock("./TerminalTab", () => ({
  TerminalTab: terminalTabMock.MockTerminalTab,
}));

// Prevent SessionStore from reading a browser `window` global.
vi.mock("../session/SessionStore", () => ({
  SessionStore: {
    retrieve: vi.fn(() => null),
    stash: vi.fn(),
  },
}));

import { TabManager } from "./TabManager";
import type { AgentState } from "./TerminalTab";

// ---------------------------------------------------------------------------
// Minimal TerminalTab stub
// ---------------------------------------------------------------------------

function makeStubTab(
  overrides: {
    agentState?: AgentState;
    isResumableAgent?: boolean;
    sessionType?: SessionType;
    label?: string;
    id?: string;
    agentSessionId?: string | null;
    taskPath?: string;
    isDisposed?: boolean;
    processStatus?: "alive" | "exited" | "killed" | "missing";
  } = {},
): {
  id: string;
  label: string;
  agentState: AgentState;
  isResumableAgent: boolean;
  sessionType: SessionType;
  agentSessionId: string | null;
  onStateChange?: (state: AgentState) => void;
  onLabelChange?: () => void;
  onProcessExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  dispose: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  clearWaiting: ReturnType<typeof vi.fn>;
  taskPath: string;
  isDisposed: boolean;
  getDiagnostics: ReturnType<typeof vi.fn>;
} {
  const isDisposed = overrides.isDisposed ?? false;
  const processStatus = overrides.processStatus ?? "alive";
  return {
    id: overrides.id ?? "tab-1",
    label: overrides.label ?? "Shell",
    agentState: overrides.agentState ?? "inactive",
    isResumableAgent: overrides.isResumableAgent ?? false,
    sessionType: overrides.sessionType ?? "shell",
    agentSessionId: overrides.agentSessionId ?? null,
    dispose: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    clearWaiting: vi.fn(),
    taskPath: overrides.taskPath ?? "item-1",
    isDisposed,
    getDiagnostics: vi.fn(() => ({
      tabId: overrides.id ?? "tab-1",
      label: overrides.label ?? "Shell",
      sessionId: overrides.agentSessionId ?? null,
      sessionType: overrides.sessionType ?? "shell",
      claudeState: overrides.agentState ?? "inactive",
      isResumableAgent: overrides.isResumableAgent ?? false,
      isVisible: true,
      isDisposed,
      process: {
        pid: null,
        status: processStatus,
        killed: processStatus === "killed",
        exitCode: processStatus === "exited" ? 0 : null,
        signalCode: processStatus === "killed" ? "SIGTERM" : null,
        spawnTime: null,
        uptimeMs: null,
      },
      renderer: {
        canvasCount: 1,
        hasRenderableContent: processStatus === "alive",
        hasBlankRenderSurface: false,
        trackedWebglAddonPresent: false,
        trackedWebglAddonDisposed: false,
        staleDisposedWebglOwnership: false,
      },
      buffer: {
        screenLineCount: 0,
        screenTail: [],
      },
      derived: {
        blankButLiveRenderer: false,
        staleDisposedWebglOwnership: false,
      },
    })),
  };
}

// ---------------------------------------------------------------------------
// Helpers to bypass TerminalTab construction and inject stubs
// ---------------------------------------------------------------------------

/**
 * Creates a TabManager with a pre-populated sessions map so we can test
 * closeTab/closeAllSessions behaviour without needing real xterm terminals.
 */
function makeTabManagerWithSessions(
  itemId: string,
  tabs: ReturnType<typeof makeStubTab>[],
): TabManager {
  // null is safe here because TerminalTab is mocked and the wrapper element
  // is only used during real tab construction/resize, not in close logic.
  const mgr = new TabManager(null as any);

  // Inject sessions directly (bypasses TerminalTab construction)
  (mgr as any).sessions.set(itemId, tabs);
  (mgr as any).activeItemId = itemId;

  return mgr;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TabManager - closeTab", () => {
  it("fires onAgentStateChange with inactive when the only Claude tab (waiting) is closed", () => {
    const tab = makeStubTab({
      agentState: "waiting",
      isResumableAgent: true,
      sessionType: "claude",
    });
    const mgr = makeTabManagerWithSessions("item-1", [tab]);

    const stateChanges: Array<{ itemId: string; state: AgentState }> = [];
    mgr.onAgentStateChange = (itemId, state) => stateChanges.push({ itemId, state });

    mgr.closeTab(0);

    expect(stateChanges).toHaveLength(1);
    expect(stateChanges[0]).toEqual({ itemId: "item-1", state: "inactive" });
  });

  it("fires onAgentStateChange with waiting when a non-waiting tab is closed but a waiting tab remains", () => {
    const waitingTab = makeStubTab({
      agentState: "waiting",
      isResumableAgent: true,
      sessionType: "copilot",
    });
    const shellTab = makeStubTab({ agentState: "inactive", isResumableAgent: false });
    const mgr = makeTabManagerWithSessions("item-1", [shellTab, waitingTab]);

    const stateChanges: Array<{ itemId: string; state: AgentState }> = [];
    mgr.onAgentStateChange = (itemId, state) => stateChanges.push({ itemId, state });

    mgr.closeTab(0); // close shellTab

    expect(stateChanges).toHaveLength(1);
    expect(stateChanges[0]).toEqual({ itemId: "item-1", state: "waiting" });
  });

  it("fires onAgentStateChange with active after closing a waiting tab when an active tab remains", () => {
    const waitingTab = makeStubTab({
      agentState: "waiting",
      isResumableAgent: true,
      sessionType: "claude",
    });
    const activeTab = makeStubTab({
      agentState: "active",
      isResumableAgent: true,
      sessionType: "copilot",
    });
    const mgr = makeTabManagerWithSessions("item-1", [waitingTab, activeTab]);
    (mgr as any).activeTabIndex = 0;

    const stateChanges: Array<{ itemId: string; state: AgentState }> = [];
    mgr.onAgentStateChange = (itemId, state) => stateChanges.push({ itemId, state });

    mgr.closeTab(0); // close waitingTab

    expect(stateChanges).toHaveLength(1);
    // Priority is waiting > active, but waiting tab is gone now
    expect(stateChanges[0]).toEqual({ itemId: "item-1", state: "active" });
  });

  it("fires onSessionChange alongside onAgentStateChange", () => {
    const tab = makeStubTab({
      agentState: "waiting",
      isResumableAgent: true,
      sessionType: "claude",
    });
    const mgr = makeTabManagerWithSessions("item-1", [tab]);

    const sessionChangeOrder: string[] = [];
    mgr.onSessionChange = () => sessionChangeOrder.push("session");
    mgr.onAgentStateChange = () => sessionChangeOrder.push("state");

    mgr.closeTab(0);

    expect(sessionChangeOrder).toEqual(["session", "state"]);
  });
});

describe("TabManager - createTab", () => {
  it("forwards pluginDir to new TerminalTab instances", () => {
    terminalTabMock.MockTerminalTab.constructorArgs.length = 0;
    const pluginDir = "/vault/.obsidian/plugins/work-terminal";
    const mgr = new TabManager(null as any, pluginDir);

    mgr.setActiveItem("item-1");
    mgr.createTab("/bin/zsh", "~", "Shell", "shell");

    expect(terminalTabMock.MockTerminalTab.constructorArgs).toHaveLength(1);
    const firstCallArgs = terminalTabMock.MockTerminalTab.constructorArgs[0];
    expect(firstCallArgs[firstCallArgs.length - 1]).toBe(pluginDir);
  });
});

describe("TabManager - closeAllSessions", () => {
  it("fires onAgentStateChange with inactive after closing all sessions for an item", () => {
    const tab = makeStubTab({
      agentState: "waiting",
      isResumableAgent: true,
      sessionType: "copilot",
    });
    const mgr = makeTabManagerWithSessions("item-1", [tab]);

    const stateChanges: Array<{ itemId: string; state: AgentState }> = [];
    mgr.onAgentStateChange = (itemId, state) => stateChanges.push({ itemId, state });

    mgr.closeAllSessions("item-1");

    expect(stateChanges).toHaveLength(1);
    expect(stateChanges[0]).toEqual({ itemId: "item-1", state: "inactive" });
  });

  it("does not fire onAgentStateChange when called for an item with no sessions", () => {
    const mgr = new TabManager(null as any);

    const stateChanges: Array<{ itemId: string; state: AgentState }> = [];
    mgr.onAgentStateChange = (itemId, state) => stateChanges.push({ itemId, state });

    mgr.closeAllSessions("nonexistent-item");

    expect(stateChanges).toHaveLength(0);
  });

  it("counts shell tabs separately from agent tabs", () => {
    const mgr = makeTabManagerWithSessions("item-1", [
      makeStubTab({ sessionType: "shell" }),
      makeStubTab({ sessionType: "copilot", isResumableAgent: true }),
      makeStubTab({ sessionType: "strands" }),
    ]);

    expect(mgr.getSessionCounts("item-1")).toEqual({ shells: 1, agents: 2 });
  });
});

describe("TabManager - moveTabToIndex", () => {
  it("moves a tab forward correctly (no off-by-one)", () => {
    const tabs = [makeStubTab(), makeStubTab(), makeStubTab(), makeStubTab()];
    const mgr = makeTabManagerWithSessions("item-1", tabs);
    (mgr as any).activeTabIndex = 0;

    // Move tab[0] to pre-removal index 3 - ends up at position 2 (forward move adjusts by -1)
    const tabToMove = tabs[0];
    mgr.moveTabToIndex("item-1", tabToMove as any, 3);

    const result = mgr.getTabs("item-1");
    expect(result[2]).toBe(tabToMove);
    expect(result).toHaveLength(4);
  });

  it("moves a tab backward correctly", () => {
    const tabs = [makeStubTab(), makeStubTab(), makeStubTab(), makeStubTab()];
    const mgr = makeTabManagerWithSessions("item-1", tabs);
    (mgr as any).activeTabIndex = 0;

    // Move tab[3] to index 1
    const tabToMove = tabs[3];
    mgr.moveTabToIndex("item-1", tabToMove as any, 1);

    const result = mgr.getTabs("item-1");
    expect(result[1]).toBe(tabToMove);
    expect(result).toHaveLength(4);
  });

  it("preserves the active tab when moving a different tab forward", () => {
    const tabs = [makeStubTab(), makeStubTab(), makeStubTab()];
    const mgr = makeTabManagerWithSessions("item-1", tabs);
    const activeTab = tabs[1];
    (mgr as any).activeTabIndex = 1;

    // Move tab[0] to index 2 - active tab (originally at 1) should stay active
    mgr.moveTabToIndex("item-1", tabs[0] as any, 2);

    expect(mgr.getActiveTabIndex()).toBe(mgr.getTabs("item-1").indexOf(activeTab as any));
    expect(mgr.getActiveTab()).toBe(activeTab);
  });

  it("preserves the active tab when moving a different tab backward", () => {
    const tabs = [makeStubTab(), makeStubTab(), makeStubTab()];
    const mgr = makeTabManagerWithSessions("item-1", tabs);
    const activeTab = tabs[1];
    (mgr as any).activeTabIndex = 1;

    // Move tab[2] to index 0 - active tab (originally at 1) should stay active
    mgr.moveTabToIndex("item-1", tabs[2] as any, 0);

    expect(mgr.getActiveTabIndex()).toBe(mgr.getTabs("item-1").indexOf(activeTab as any));
    expect(mgr.getActiveTab()).toBe(activeTab);
  });

  it("updates activeTabIndex when the active tab itself is moved", () => {
    const tabs = [makeStubTab(), makeStubTab(), makeStubTab()];
    const mgr = makeTabManagerWithSessions("item-1", tabs);
    const activeTab = tabs[0];
    (mgr as any).activeTabIndex = 0;

    // Move the active tab to index 2
    mgr.moveTabToIndex("item-1", activeTab as any, 2);

    expect(mgr.getActiveTab()).toBe(activeTab);
    expect(mgr.getActiveTabIndex()).toBe(mgr.getTabs("item-1").indexOf(activeTab as any));
  });

  it("calls onPersistRequest after reordering", () => {
    const tabs = [makeStubTab(), makeStubTab()];
    const mgr = makeTabManagerWithSessions("item-1", tabs);
    const persistSpy = vi.fn();
    mgr.onPersistRequest = persistSpy;

    mgr.moveTabToIndex("item-1", tabs[0] as any, 1);

    expect(persistSpy).toHaveBeenCalledTimes(1);
  });

  it("calls onSessionChange after reordering", () => {
    const tabs = [makeStubTab(), makeStubTab()];
    const mgr = makeTabManagerWithSessions("item-1", tabs);
    const sessionChangeSpy = vi.fn();
    mgr.onSessionChange = sessionChangeSpy;

    mgr.moveTabToIndex("item-1", tabs[0] as any, 1);

    expect(sessionChangeSpy).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when currentIndex equals targetIndex", () => {
    const tabs = [makeStubTab(), makeStubTab()];
    const mgr = makeTabManagerWithSessions("item-1", tabs);
    const sessionChangeSpy = vi.fn();
    const persistSpy = vi.fn();
    mgr.onSessionChange = sessionChangeSpy;
    mgr.onPersistRequest = persistSpy;

    mgr.moveTabToIndex("item-1", tabs[0] as any, 0);

    expect(sessionChangeSpy).not.toHaveBeenCalled();
    expect(persistSpy).not.toHaveBeenCalled();
  });

  it("does not change activeTabIndex for non-active items", () => {
    const tabs = [makeStubTab(), makeStubTab(), makeStubTab()];
    const mgr = makeTabManagerWithSessions("item-1", tabs);
    // Set up a second item and make it active
    const otherTabs = [makeStubTab()];
    (mgr as any).sessions.set("item-2", otherTabs);
    (mgr as any).activeItemId = "item-2";
    (mgr as any).activeTabIndex = 0;

    // Move a tab in item-1 (not the active item)
    mgr.moveTabToIndex("item-1", tabs[0] as any, 2);

    // activeTabIndex should still reflect item-2's state
    expect(mgr.getActiveTabIndex()).toBe(0);
  });
});

describe("TabManager - active tab discovery", () => {
  it("returns metadata for all active tabs across items", () => {
    const mgr = new TabManager(null as any);
    (mgr as any).sessions.set("item-1", [
      makeStubTab({
        id: "tab-claude",
        label: "Automatic Issues",
        sessionType: "claude",
        isResumableAgent: true,
        agentSessionId: "session-1",
        taskPath: "item-1",
      }),
      makeStubTab({
        id: "tab-shell",
        label: "Shell",
        sessionType: "shell",
        isResumableAgent: false,
        agentSessionId: null,
        taskPath: "item-1",
      }),
    ]);
    (mgr as any).sessions.set("item-2", [
      makeStubTab({
        id: "tab-copilot",
        label: "Automatic Issues",
        sessionType: "copilot",
        isResumableAgent: true,
        agentSessionId: "session-2",
        taskPath: "item-2",
      }),
    ]);

    expect(mgr.getAllActiveTabs()).toEqual([
      {
        tabId: "tab-claude",
        itemId: "item-1",
        label: "Automatic Issues",
        sessionId: "session-1",
        sessionType: "claude",
        isResumableAgent: true,
      },
      {
        tabId: "tab-shell",
        itemId: "item-1",
        label: "Shell",
        sessionId: null,
        sessionType: "shell",
        isResumableAgent: false,
      },
      {
        tabId: "tab-copilot",
        itemId: "item-2",
        label: "Automatic Issues",
        sessionId: "session-2",
        sessionType: "copilot",
        isResumableAgent: true,
      },
    ]);
  });

  it("finds tabs by normalized label and returns active session IDs from the same source", () => {
    const mgr = new TabManager(null as any);
    (mgr as any).sessions.set("item-1", [
      makeStubTab({
        id: "tab-claude",
        label: "Automatic Issues",
        sessionType: "claude",
        isResumableAgent: true,
        agentSessionId: "session-1",
      }),
      makeStubTab({
        id: "tab-copilot",
        label: " automatic issues ",
        sessionType: "copilot",
        isResumableAgent: true,
        agentSessionId: "session-2",
      }),
      makeStubTab({
        id: "tab-shell",
        label: "Shell",
        sessionType: "shell",
      }),
    ]);

    expect(mgr.findTabsByLabel("automatic issues")).toEqual([
      {
        tabId: "tab-claude",
        itemId: "item-1",
        label: "Automatic Issues",
        sessionId: "session-1",
        sessionType: "claude",
        isResumableAgent: true,
      },
      {
        tabId: "tab-copilot",
        itemId: "item-1",
        label: " automatic issues ",
        sessionId: "session-2",
        sessionType: "copilot",
        isResumableAgent: true,
      },
    ]);
    expect(mgr.getActiveSessionIds()).toEqual(new Set(["session-1", "session-2"]));
  });
});

describe("TabManager - onProcessExit auto-close behaviour", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the tab open when the process exits quickly (under 30s)", () => {
    terminalTabMock.MockTerminalTab.constructorArgs.length = 0;
    const mgr = new TabManager(null as any);
    mgr.setActiveItem("item-1");
    const tab = mgr.createTab("/bin/zsh", "~", "Shell", "shell")!;

    // Simulate an immediate exit (within 30s of spawn)
    const closeSpy = vi.fn();
    mgr.onSessionChange = closeSpy;
    tab.onProcessExit?.(1, null);

    // Tab should still exist - no close triggered
    expect(mgr.getTabs("item-1")).toHaveLength(1);
  });

  it("auto-closes the tab when a long-running process exits with code 0", () => {
    terminalTabMock.MockTerminalTab.constructorArgs.length = 0;
    const baseTime = 1000000;
    // First call (spawnTime) returns baseTime, subsequent calls return 31s later
    const nowMock = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(baseTime) // spawnTime in createTabForItem
      .mockReturnValue(baseTime + 31_000); // exit check in onProcessExit

    const mgr = new TabManager(null as any);
    mgr.setActiveItem("item-1");

    const tab = mgr.createTab("/bin/zsh", "~", "Shell", "shell")!;
    tab.onProcessExit?.(0, null);

    // Tab should have been closed
    expect(mgr.getTabs("item-1")).toHaveLength(0);
  });

  it("keeps the tab open when a long-running process exits with non-zero code", () => {
    terminalTabMock.MockTerminalTab.constructorArgs.length = 0;
    const baseTime = 1000000;
    const nowMock = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(baseTime)
      .mockReturnValue(baseTime + 31_000);

    const mgr = new TabManager(null as any);
    mgr.setActiveItem("item-1");

    const tab = mgr.createTab("/bin/zsh", "~", "Shell", "shell")!;
    tab.onProcessExit?.(1, null);

    // Tab should still exist - non-zero exit keeps it open
    expect(mgr.getTabs("item-1")).toHaveLength(1);
  });
});

describe("TabManager - diagnostics lifecycle", () => {
  it("marks exited and missing processes as lost instead of live", () => {
    const exitedTab = makeStubTab({
      id: "tab-exited",
      processStatus: "exited",
      taskPath: "item-1",
    });
    const missingTab = makeStubTab({
      id: "tab-missing",
      processStatus: "missing",
      taskPath: "item-1",
    });
    const mgr = makeTabManagerWithSessions("item-1", [exitedTab, missingTab]);

    expect(mgr.getTabDiagnostics().map((tab) => tab.recovery.lifecycle)).toEqual(["lost", "lost"]);
  });

  it("marks disposed tabs as disposed even when diagnostics still report an alive process", () => {
    const disposedTab = makeStubTab({
      id: "tab-disposed",
      isDisposed: true,
      processStatus: "alive",
      taskPath: "item-1",
    });
    const mgr = makeTabManagerWithSessions("item-1", [disposedTab]);

    expect(mgr.getTabDiagnostics()[0].recovery.lifecycle).toBe("disposed");
  });
});
