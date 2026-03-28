/**
 * TabManager tests - covers state aggregation and Claude state notification
 * on tab lifecycle events.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock TerminalTab before importing TabManager to prevent xterm.js loading
// in a Node.js environment where `self` is not defined.
vi.mock("./TerminalTab", () => ({
  TerminalTab: class MockTerminalTab {},
}));

// Prevent SessionStore from reading a browser `window` global.
vi.mock("../session/SessionStore", () => ({
  SessionStore: {
    retrieve: vi.fn(() => null),
    stash: vi.fn(),
  },
}));

import { TabManager } from "./TabManager";
import type { ClaudeState } from "./TerminalTab";

// ---------------------------------------------------------------------------
// Minimal TerminalTab stub
// ---------------------------------------------------------------------------

function makeStubTab(
  overrides: {
    claudeState?: ClaudeState;
    isClaudeSession?: boolean;
  } = {},
): {
  claudeState: ClaudeState;
  isClaudeSession: boolean;
  onStateChange?: (state: ClaudeState) => void;
  onLabelChange?: () => void;
  onProcessExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  dispose: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  clearWaiting: ReturnType<typeof vi.fn>;
  taskPath: string;
} {
  return {
    claudeState: overrides.claudeState ?? "inactive",
    isClaudeSession: overrides.isClaudeSession ?? false,
    dispose: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    clearWaiting: vi.fn(),
    taskPath: "item-1",
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
  it("fires onClaudeStateChange with inactive when the only Claude tab (waiting) is closed", () => {
    const tab = makeStubTab({ claudeState: "waiting", isClaudeSession: true });
    const mgr = makeTabManagerWithSessions("item-1", [tab]);

    const stateChanges: Array<{ itemId: string; state: ClaudeState }> = [];
    mgr.onClaudeStateChange = (itemId, state) => stateChanges.push({ itemId, state });

    mgr.closeTab(0);

    expect(stateChanges).toHaveLength(1);
    expect(stateChanges[0]).toEqual({ itemId: "item-1", state: "inactive" });
  });

  it("fires onClaudeStateChange with waiting when a non-waiting tab is closed but a waiting tab remains", () => {
    const waitingTab = makeStubTab({ claudeState: "waiting", isClaudeSession: true });
    const shellTab = makeStubTab({ claudeState: "inactive", isClaudeSession: false });
    const mgr = makeTabManagerWithSessions("item-1", [shellTab, waitingTab]);

    const stateChanges: Array<{ itemId: string; state: ClaudeState }> = [];
    mgr.onClaudeStateChange = (itemId, state) => stateChanges.push({ itemId, state });

    mgr.closeTab(0); // close shellTab

    expect(stateChanges).toHaveLength(1);
    expect(stateChanges[0]).toEqual({ itemId: "item-1", state: "waiting" });
  });

  it("fires onClaudeStateChange with active after closing a waiting tab when an active tab remains", () => {
    const waitingTab = makeStubTab({ claudeState: "waiting", isClaudeSession: true });
    const activeTab = makeStubTab({ claudeState: "active", isClaudeSession: true });
    const mgr = makeTabManagerWithSessions("item-1", [waitingTab, activeTab]);
    (mgr as any).activeTabIndex = 0;

    const stateChanges: Array<{ itemId: string; state: ClaudeState }> = [];
    mgr.onClaudeStateChange = (itemId, state) => stateChanges.push({ itemId, state });

    mgr.closeTab(0); // close waitingTab

    expect(stateChanges).toHaveLength(1);
    // Priority is waiting > active, but waiting tab is gone now
    expect(stateChanges[0]).toEqual({ itemId: "item-1", state: "active" });
  });

  it("fires onSessionChange alongside onClaudeStateChange", () => {
    const tab = makeStubTab({ claudeState: "waiting", isClaudeSession: true });
    const mgr = makeTabManagerWithSessions("item-1", [tab]);

    const sessionChangeOrder: string[] = [];
    mgr.onSessionChange = () => sessionChangeOrder.push("session");
    mgr.onClaudeStateChange = () => sessionChangeOrder.push("state");

    mgr.closeTab(0);

    expect(sessionChangeOrder).toEqual(["session", "state"]);
  });
});

describe("TabManager - closeAllSessions", () => {
  it("fires onClaudeStateChange with inactive after closing all sessions for an item", () => {
    const tab = makeStubTab({ claudeState: "waiting", isClaudeSession: true });
    const mgr = makeTabManagerWithSessions("item-1", [tab]);

    const stateChanges: Array<{ itemId: string; state: ClaudeState }> = [];
    mgr.onClaudeStateChange = (itemId, state) => stateChanges.push({ itemId, state });

    mgr.closeAllSessions("item-1");

    expect(stateChanges).toHaveLength(1);
    expect(stateChanges[0]).toEqual({ itemId: "item-1", state: "inactive" });
  });

  it("does not fire onClaudeStateChange when called for an item with no sessions", () => {
    const mgr = new TabManager(null as any);

    const stateChanges: Array<{ itemId: string; state: ClaudeState }> = [];
    mgr.onClaudeStateChange = (itemId, state) => stateChanges.push({ itemId, state });

    mgr.closeAllSessions("nonexistent-item");

    expect(stateChanges).toHaveLength(0);
  });
});
