import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LastActiveStore } from "./LastActiveStore";

function createMockPlugin(initialData: Record<string, any> = {}) {
  let data = structuredClone(initialData);
  return {
    loadData: vi.fn(async () => structuredClone(data)),
    saveData: vi.fn(async (nextData: Record<string, any>) => {
      data = structuredClone(nextData);
    }),
    getData: () => structuredClone(data),
  };
}

describe("LastActiveStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads persisted timestamps from plugin data", async () => {
    const plugin = createMockPlugin({
      lastActiveById: {
        "uuid-1": "2026-04-27T12:00:00Z",
        "uuid-2": "2026-04-27T12:05:00Z",
      },
    });
    const store = new LastActiveStore(plugin);

    await store.load();

    expect(store.get("uuid-1")).toBe("2026-04-27T12:00:00Z");
    expect(store.get("uuid-2")).toBe("2026-04-27T12:05:00Z");
  });

  it("ignores malformed persisted data", async () => {
    const plugin = createMockPlugin({
      lastActiveById: {
        good: "2026-04-27T12:00:00Z",
        bad: 123,
        empty: "",
      },
    });
    const store = new LastActiveStore(plugin);

    await store.load();

    expect(store.get("good")).toBe("2026-04-27T12:00:00Z");
    expect(store.get("bad")).toBeUndefined();
    expect(store.get("empty")).toBeUndefined();
  });

  it("debounces multiple updates into one save", async () => {
    const plugin = createMockPlugin();
    const store = new LastActiveStore(plugin);
    await store.load();

    store.set("uuid-1", "2026-04-27T12:00:00Z");
    store.set("uuid-2", "2026-04-27T12:01:00Z");

    expect(plugin.saveData).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1_000);
    await vi.runAllTimersAsync();

    expect(plugin.saveData).toHaveBeenCalledTimes(1);
    expect(plugin.getData()).toEqual({
      lastActiveById: {
        "uuid-1": "2026-04-27T12:00:00Z",
        "uuid-2": "2026-04-27T12:01:00Z",
      },
    });
  });

  it("flushNow persists immediately and cancels the debounce timer", async () => {
    const plugin = createMockPlugin();
    const store = new LastActiveStore(plugin);
    await store.load();

    store.set("uuid-1", "2026-04-27T12:00:00Z");
    await store.flushNow();

    expect(plugin.saveData).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1_000);
    await vi.runAllTimersAsync();

    expect(plugin.saveData).toHaveBeenCalledTimes(1);
  });

  it("rekeys an existing timestamp and removes the old key on flush", async () => {
    const plugin = createMockPlugin({
      lastActiveById: {
        "old/path.md": "2026-04-27T12:00:00Z",
      },
    });
    const store = new LastActiveStore(plugin);
    await store.load();

    expect(store.rekey("old/path.md", "uuid-1")).toBe(true);
    await store.flushNow();

    expect(store.get("old/path.md")).toBeUndefined();
    expect(store.get("uuid-1")).toBe("2026-04-27T12:00:00Z");
    expect(plugin.getData()).toEqual({
      lastActiveById: {
        "uuid-1": "2026-04-27T12:00:00Z",
      },
    });
  });

  it("prunes stale path ids but keeps durable ids", async () => {
    const plugin = createMockPlugin({
      lastActiveById: {
        "2 - Areas/Tasks/todo/stale.md": "2026-04-27T12:00:00Z",
        "uuid-1": "2026-04-27T12:01:00Z",
      },
    });
    const store = new LastActiveStore(plugin);
    await store.load();

    expect(store.pruneMissingPathIds(["uuid-2"])).toBe(true);
    await store.flushNow();

    expect(plugin.getData()).toEqual({
      lastActiveById: {
        "uuid-1": "2026-04-27T12:01:00Z",
      },
    });
  });

  it("merges with unrelated plugin data keys", async () => {
    const plugin = createMockPlugin({
      settings: { foo: true },
      pinnedItems: ["uuid-1"],
    });
    const store = new LastActiveStore(plugin);
    await store.load();

    store.set("uuid-1", "2026-04-27T12:00:00Z");
    await store.flushNow();

    expect(plugin.getData()).toEqual({
      settings: { foo: true },
      pinnedItems: ["uuid-1"],
      lastActiveById: {
        "uuid-1": "2026-04-27T12:00:00Z",
      },
    });
  });

  it("prefers the newer timestamp when rekey target already exists", async () => {
    const plugin = createMockPlugin({
      lastActiveById: {
        old: "2026-04-27T12:00:00Z",
        new: "2026-04-27T12:05:00Z",
      },
    });
    const store = new LastActiveStore(plugin);
    await store.load();

    expect(store.rekey("old", "new")).toBe(true);
    await store.flushNow();

    expect(plugin.getData()).toEqual({
      lastActiveById: {
        new: "2026-04-27T12:05:00Z",
      },
    });
  });

  it("keeps dirty ids queued if a save fails, so a later retry can persist them", async () => {
    let data: Record<string, any> = {};
    const firstSave = new Error("save failed");
    const plugin = {
      loadData: vi.fn(async () => structuredClone(data)),
      saveData: vi
        .fn()
        .mockRejectedValueOnce(firstSave)
        .mockImplementation(async (nextData: Record<string, any>) => {
          data = structuredClone(nextData);
        }),
      getData: () => structuredClone(data),
    };
    const store = new LastActiveStore(plugin);
    await store.load();

    store.set("uuid-1", "2026-04-27T12:00:00Z");
    await expect(store.flushNow()).rejects.toThrow("save failed");
    await store.flushNow();

    expect(plugin.saveData).toHaveBeenCalledTimes(2);
    expect(plugin.getData()).toEqual({
      lastActiveById: {
        "uuid-1": "2026-04-27T12:00:00Z",
      },
    });
  });
});
