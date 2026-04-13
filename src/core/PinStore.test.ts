import { describe, expect, it, vi } from "vitest";
import { PinStore } from "./PinStore";

function createMockPlugin(initialData: Record<string, any> = {}) {
  let data = { ...initialData };
  return {
    loadData: vi.fn(async () => ({ ...data })),
    saveData: vi.fn(async (next: Record<string, any>) => {
      await Promise.resolve();
      data = next;
    }),
    getData: () => data,
  };
}

describe("PinStore", () => {
  it("loads pinned IDs from plugin data", async () => {
    const plugin = createMockPlugin({ pinnedItems: ["id-1", "id-2"] });
    const store = new PinStore(plugin);
    await store.load();

    expect(store.getPinnedIds()).toEqual(["id-1", "id-2"]);
    expect(store.isPinned("id-1")).toBe(true);
    expect(store.isPinned("id-3")).toBe(false);
  });

  it("handles missing pinnedItems gracefully", async () => {
    const plugin = createMockPlugin({});
    const store = new PinStore(plugin);
    await store.load();

    expect(store.getPinnedIds()).toEqual([]);
  });

  it("pins an item and persists", async () => {
    const plugin = createMockPlugin({});
    const store = new PinStore(plugin);
    await store.load();

    await store.pin("id-1");

    expect(store.isPinned("id-1")).toBe(true);
    expect(plugin.getData().pinnedItems).toEqual(["id-1"]);
  });

  it("does not duplicate when pinning an already-pinned item", async () => {
    const plugin = createMockPlugin({ pinnedItems: ["id-1"] });
    const store = new PinStore(plugin);
    await store.load();

    await store.pin("id-1");

    expect(store.getPinnedIds()).toEqual(["id-1"]);
  });

  it("unpins an item and persists", async () => {
    const plugin = createMockPlugin({ pinnedItems: ["id-1", "id-2"] });
    const store = new PinStore(plugin);
    await store.load();

    await store.unpin("id-1");

    expect(store.isPinned("id-1")).toBe(false);
    expect(store.getPinnedIds()).toEqual(["id-2"]);
    expect(plugin.getData().pinnedItems).toEqual(["id-2"]);
  });

  it("unpin is a no-op for non-pinned items", async () => {
    const plugin = createMockPlugin({ pinnedItems: ["id-1"] });
    const store = new PinStore(plugin);
    await store.load();

    await store.unpin("id-999");

    expect(store.getPinnedIds()).toEqual(["id-1"]);
  });

  it("toggles pin state", async () => {
    const plugin = createMockPlugin({});
    const store = new PinStore(plugin);
    await store.load();

    const pinned = await store.toggle("id-1");
    expect(pinned).toBe(true);
    expect(store.isPinned("id-1")).toBe(true);

    const unpinned = await store.toggle("id-1");
    expect(unpinned).toBe(false);
    expect(store.isPinned("id-1")).toBe(false);
  });

  it("reorders pinned items, filtering out non-pinned IDs", async () => {
    const plugin = createMockPlugin({ pinnedItems: ["id-1", "id-2", "id-3"] });
    const store = new PinStore(plugin);
    await store.load();

    await store.reorder(["id-3", "id-1", "id-unknown"]);

    expect(store.getPinnedIds()).toEqual(["id-3", "id-1"]);
  });

  it("re-keys a pinned item ID", async () => {
    const plugin = createMockPlugin({ pinnedItems: ["old-id", "id-2"] });
    const store = new PinStore(plugin);
    await store.load();

    const result = store.rekey("old-id", "new-id");

    expect(result).toBe(true);
    expect(store.isPinned("new-id")).toBe(true);
    expect(store.isPinned("old-id")).toBe(false);
    expect(store.getPinnedIds()).toEqual(["new-id", "id-2"]);
  });

  it("rekey returns false when the old ID is not pinned", async () => {
    const plugin = createMockPlugin({ pinnedItems: ["id-1"] });
    const store = new PinStore(plugin);
    await store.load();

    const result = store.rekey("id-unknown", "new-id");

    expect(result).toBe(false);
    expect(store.getPinnedIds()).toEqual(["id-1"]);
  });

  it("returns a defensive copy from getPinnedIds", async () => {
    const plugin = createMockPlugin({ pinnedItems: ["id-1"] });
    const store = new PinStore(plugin);
    await store.load();

    const ids = store.getPinnedIds();
    ids.push("id-rogue");

    expect(store.getPinnedIds()).toEqual(["id-1"]);
  });
});
