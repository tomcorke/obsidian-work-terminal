import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  RecentlyClosedStore,
  type ClosedSessionEntry,
  type RecentlyClosedState,
} from "./RecentlyClosedStore";

function makeEntry(overrides: Partial<ClosedSessionEntry> = {}): ClosedSessionEntry {
  return {
    sessionType: "claude",
    label: "Claude",
    claudeSessionId: `session-${Math.random().toString(36).slice(2)}`,
    durableSessionId:
      overrides.durableSessionId ??
      (overrides.recoveryMode === "relaunch" ? "durable-session" : undefined),
    closedAt: Date.now(),
    itemId: "item-1",
    recoveryMode: "resume",
    cwd: "/vault",
    command: "claude",
    commandArgs: ["claude"],
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
    store.add(makeEntry({ claudeSessionId: activeId, label: "Active" }));
    store.add(makeEntry({ claudeSessionId: "other", label: "Other" }));

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

  it("does not filter out shell sessions without claudeSessionId when applying active filter", () => {
    store.add(
      makeEntry({
        sessionType: "shell",
        claudeSessionId: null,
        label: "Shell",
        recoveryMode: "relaunch",
        command: "/bin/zsh",
      }),
    );
    // Even when filtering with active IDs, shell sessions (null ID) are not filtered
    const entries = store.getEntries(new Set(["some-id"]));
    expect(entries).toHaveLength(1);
    expect(entries[0].label).toBe("Shell");
  });

  it("deduplicates repeated restore entries for the same resumable session", () => {
    store.add(
      makeEntry({
        claudeSessionId: "same-session",
        label: "Old label",
        closedAt: Date.now() - 1000,
      }),
    );
    store.add(makeEntry({ claudeSessionId: "same-session", label: "New label" }));

    const entries = store.serialize();
    expect(entries).toHaveLength(1);
    expect(entries[0].label).toBe("New label");
  });

  it("round-trips persisted relaunch entries", () => {
    const entry = makeEntry({
      sessionType: "shell",
      claudeSessionId: null,
      durableSessionId: "durable-shell",
      label: "Shell",
      recoveryMode: "relaunch",
      command: "/bin/zsh",
      commandArgs: undefined,
    });

    const restored = RecentlyClosedStore.fromData([entry]);
    expect(restored).toEqual([entry]);
  });

  it("drops entries with invalid disk session types", () => {
    const restored = RecentlyClosedStore.fromData([
      makeEntry({ sessionType: "claude" }),
      { ...makeEntry(), sessionType: "not-a-session-type" },
    ]);

    expect(restored).toEqual([
      expect.objectContaining({
        sessionType: "claude",
      }),
    ]);
  });

  it("keeps identical relaunch entries distinct when their durable identities differ", () => {
    store.add(
      makeEntry({
        sessionType: "shell",
        claudeSessionId: null,
        durableSessionId: "durable-shell-1",
        label: "Shell",
        recoveryMode: "relaunch",
        command: "/bin/zsh",
      }),
    );
    store.add(
      makeEntry({
        sessionType: "shell",
        claudeSessionId: null,
        durableSessionId: "durable-shell-2",
        label: "Shell",
        recoveryMode: "relaunch",
        command: "/bin/zsh",
      }),
    );

    const entries = store.serialize();
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.durableSessionId)).toEqual([
      "durable-shell-2",
      "durable-shell-1",
    ]);
  });

  it("assigns durable identities to legacy relaunch entries loaded from disk", () => {
    const restored = RecentlyClosedStore.fromData([
      {
        sessionType: "shell",
        label: "Shell",
        claudeSessionId: null,
        closedAt: Date.now(),
        itemId: "item-1",
        recoveryMode: "relaunch",
        cwd: "/vault",
        command: "/bin/zsh",
      },
      {
        sessionType: "shell",
        label: "Shell",
        claudeSessionId: null,
        closedAt: Date.now(),
        itemId: "item-1",
        recoveryMode: "relaunch",
        cwd: "/vault",
        command: "/bin/zsh",
      },
    ]);

    expect(restored).toHaveLength(2);
    expect(restored[0].durableSessionId).toEqual(expect.any(String));
    expect(restored[1].durableSessionId).toEqual(expect.any(String));
    expect(restored[0].durableSessionId).not.toBe(restored[1].durableSessionId);
  });

  it("filters entries with a custom activity predicate", () => {
    store.add(makeEntry({ label: "Active shell", recoveryMode: "relaunch", claudeSessionId: null }));
    store.add(makeEntry({ label: "Inactive shell", recoveryMode: "relaunch", claudeSessionId: null }));

    const entries = store.getEntries(new Set(), 5, (entry) => entry.label === "Active shell");
    expect(entries).toHaveLength(1);
    expect(entries[0].label).toBe("Inactive shell");
  });

  it("shares add and take operations across stores backed by the same state", () => {
    const sharedState: RecentlyClosedState = {
      entries: [],
      hydratedFromDisk: false,
    };
    const firstStore = new RecentlyClosedStore([], sharedState);
    const secondStore = new RecentlyClosedStore([], sharedState);
    const entry = makeEntry({
      sessionType: "shell",
      claudeSessionId: null,
      durableSessionId: "durable-shell-1",
      label: "Shell",
      recoveryMode: "relaunch",
      command: "/bin/zsh",
      commandArgs: undefined,
    });

    firstStore.add(entry);

    expect(secondStore.serialize()).toEqual([
      expect.objectContaining({
        durableSessionId: "durable-shell-1",
        label: "Shell",
      }),
    ]);
    expect(secondStore.take(entry)).toEqual(
      expect.objectContaining({
        durableSessionId: "durable-shell-1",
        label: "Shell",
      }),
    );
    expect(firstStore.serialize()).toEqual([]);
  });
});
