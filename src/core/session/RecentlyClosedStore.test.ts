import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RecentlyClosedStore, type ClosedSessionEntry } from "./RecentlyClosedStore";

function makeEntry(overrides: Partial<ClosedSessionEntry> = {}): ClosedSessionEntry {
  return {
    sessionType: "claude",
    label: "Claude",
    agentSessionId: `session-${Math.random().toString(36).slice(2)}`,
    closedAt: Date.now(),
    itemId: "item-1",
    ...overrides,
  };
}

describe("RecentlyClosedStore", () => {
  let store: RecentlyClosedStore;

  beforeEach(() => {
    store = new RecentlyClosedStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns entries newest first", () => {
    const older = makeEntry({ label: "First", closedAt: Date.now() - 5000 });
    const newer = makeEntry({ label: "Second", closedAt: Date.now() });
    store.add(older);
    store.add(newer);
    const entries = store.getEntries(new Set());
    expect(entries[0].label).toBe("Second");
    expect(entries[1].label).toBe("First");
  });

  it("limits results to the requested count", () => {
    for (let i = 0; i < 10; i++) {
      store.add(makeEntry({ label: `Tab ${i}` }));
    }
    expect(store.getEntries(new Set(), 5)).toHaveLength(5);
    expect(store.getEntries(new Set(), 3)).toHaveLength(3);
  });

  it("filters out currently active session IDs", () => {
    const activeId = "active-session";
    store.add(makeEntry({ agentSessionId: activeId, label: "Active" }));
    store.add(makeEntry({ agentSessionId: "other", label: "Other" }));

    const entries = store.getEntries(new Set([activeId]));
    expect(entries).toHaveLength(1);
    expect(entries[0].label).toBe("Other");
  });

  it("prunes entries older than 30 minutes", () => {
    const old = makeEntry({ closedAt: Date.now() - 31 * 60 * 1000, label: "Old" });
    const recent = makeEntry({ closedAt: Date.now(), label: "Recent" });
    store.add(old);
    store.add(recent);

    const entries = store.getEntries(new Set());
    expect(entries).toHaveLength(1);
    expect(entries[0].label).toBe("Recent");
  });

  it("returns empty array when no entries exist", () => {
    expect(store.getEntries(new Set())).toEqual([]);
  });

  it("does not filter out shell sessions without agentSessionId when applying active filter", () => {
    store.add(makeEntry({ sessionType: "shell", agentSessionId: null, label: "Shell" }));
    // Even when filtering with active IDs, shell sessions (null ID) are not filtered
    const entries = store.getEntries(new Set(["some-id"]));
    expect(entries).toHaveLength(1);
    expect(entries[0].label).toBe("Shell");
  });
});
