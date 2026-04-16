import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { ActivityStore } from "./ActivityStore";

describe("ActivityStore", () => {
  let store: ActivityStore;

  beforeEach(() => {
    store = new ActivityStore();
    vi.useFakeTimers();
  });

  afterEach(() => {
    store.dispose();
    vi.useRealTimers();
  });

  describe("in-memory timestamps", () => {
    it("records and retrieves activity timestamps", () => {
      const before = Date.now();
      store.recordActivity("item-1");
      const after = Date.now();

      const ts = store.getTimestamp("item-1");
      expect(ts).toBeDefined();
      expect(ts!).toBeGreaterThanOrEqual(before);
      expect(ts!).toBeLessThanOrEqual(after);
    });

    it("returns undefined for unknown items", () => {
      expect(store.getTimestamp("unknown")).toBeUndefined();
    });

    it("updates timestamp on repeated activity", () => {
      store.recordActivity("item-1");
      const first = store.getTimestamp("item-1")!;

      vi.advanceTimersByTime(5000);
      store.recordActivity("item-1");
      const second = store.getTimestamp("item-1")!;

      expect(second).toBeGreaterThan(first);
    });

    it("returns all timestamps via getAllTimestamps", () => {
      store.recordActivity("a");
      store.recordActivity("b");

      const all = store.getAllTimestamps();
      expect(all.size).toBe(2);
      expect(all.has("a")).toBe(true);
      expect(all.has("b")).toBe(true);
    });
  });

  describe("seedFromItems", () => {
    it("seeds timestamps from item metadata", () => {
      store.seedFromItems([
        {
          id: "item-1",
          path: "tasks/item-1.md",
          metadata: { "last-active": "2025-06-15T10:00:00Z" },
        },
      ]);

      const ts = store.getTimestamp("item-1");
      expect(ts).toBe(Date.parse("2025-06-15T10:00:00Z"));
    });

    it("does not overwrite in-memory timestamps", () => {
      store.recordActivity("item-1");
      const inMemory = store.getTimestamp("item-1")!;

      store.seedFromItems([
        {
          id: "item-1",
          path: "tasks/item-1.md",
          metadata: { "last-active": "2020-01-01T00:00:00Z" },
        },
      ]);

      expect(store.getTimestamp("item-1")).toBe(inMemory);
    });

    it("ignores items with no last-active metadata", () => {
      store.seedFromItems([{ id: "item-1", path: "tasks/item-1.md", metadata: {} }]);

      expect(store.getTimestamp("item-1")).toBeUndefined();
    });

    it("ignores invalid date strings", () => {
      store.seedFromItems([
        {
          id: "item-1",
          path: "tasks/item-1.md",
          metadata: { "last-active": "not-a-date" },
        },
      ]);

      expect(store.getTimestamp("item-1")).toBeUndefined();
    });
  });

  describe("rekeyItem", () => {
    it("transfers timestamp to new ID", () => {
      store.recordActivity("old-id");
      const ts = store.getTimestamp("old-id")!;

      store.rekeyItem("old-id", "new-id");

      expect(store.getTimestamp("old-id")).toBeUndefined();
      expect(store.getTimestamp("new-id")).toBe(ts);
    });

    it("handles re-keying non-existent items gracefully", () => {
      store.rekeyItem("nonexistent", "new-id");
      expect(store.getTimestamp("new-id")).toBeUndefined();
    });
  });

  describe("dispose", () => {
    it("clears pending writes", () => {
      store.recordActivity("item-1");
      store.dispose();
      // No assertion needed - just verifying no errors
    });
  });
});
