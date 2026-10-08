import type { PluginDataStore } from "./PluginDataStore";
import { mergeAndSavePluginData } from "./PluginDataStore";

/**
 * Maintains the ordered cache of pinned item IDs in plugin data. Durable pin
 * membership lives in each item's source; this cache controls display order
 * and supplies legacy migration input.
 */
export class PinStore {
  private pinnedIds: string[] = [];
  private plugin: PluginDataStore;

  constructor(plugin: PluginDataStore) {
    this.plugin = plugin;
  }

  /** Load pinned IDs from plugin data. Call once during initialization. */
  async load(): Promise<void> {
    const data = (await this.plugin.loadData()) || {};
    this.pinnedIds = Array.isArray(data.pinnedItems) ? this.normalize(data.pinnedItems) : [];
  }

  /** Get the ordered list of pinned item IDs. */
  getPinnedIds(): string[] {
    return [...this.pinnedIds];
  }

  /** Check whether an item is pinned. */
  isPinned(itemId: string): boolean {
    return this.pinnedIds.includes(itemId);
  }

  /** Pin an item. Adds to the end of the pinned list. */
  async pin(itemId: string): Promise<void> {
    if (this.pinnedIds.includes(itemId)) return;
    this.pinnedIds.push(itemId);
    await this.persist();
  }

  /** Unpin an item. */
  async unpin(itemId: string): Promise<void> {
    const idx = this.pinnedIds.indexOf(itemId);
    if (idx < 0) return;
    this.pinnedIds.splice(idx, 1);
    await this.persist();
  }

  /**
   * Replace membership while retaining the relative order of existing IDs.
   * Returns false when persistence fails, but keeps memory aligned with the
   * durable item sources.
   */
  async reconcile(desiredIds: string[]): Promise<boolean> {
    const desired = this.normalize(desiredIds);
    const desiredSet = new Set(desired);
    const previous = this.pinnedIds;
    const next = [
      ...previous.filter((id) => desiredSet.has(id)),
      ...desired.filter((id) => !previous.includes(id)),
    ];
    this.pinnedIds = next;
    if (next.length === previous.length && next.every((id, i) => id === previous[i])) return true;
    try {
      await this.persist();
      return true;
    } catch {
      return false;
    }
  }

  /** Toggle pin state. Returns the new pinned state. */
  async toggle(itemId: string): Promise<boolean> {
    if (this.isPinned(itemId)) {
      await this.unpin(itemId);
      return false;
    } else {
      await this.pin(itemId);
      return true;
    }
  }

  /**
   * Reorder pinned items. Accepts a full replacement array of pinned IDs.
   * Only IDs that are currently pinned are kept (prevents stale IDs).
   */
  async reorder(newOrder: string[]): Promise<boolean> {
    const pinSet = new Set(this.pinnedIds);
    this.pinnedIds = this.normalize(newOrder).filter((id) => pinSet.has(id));
    try {
      await this.persist();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Re-key a pinned item when its ID changes (e.g. UUID backfill).
   * Returns true if the item was found and re-keyed.
   */
  rekey(oldId: string, newId: string): boolean {
    const idx = this.pinnedIds.indexOf(oldId);
    if (idx < 0) return false;
    // Remove any existing entry for newId to prevent duplicates
    const existingNewIdx = this.pinnedIds.indexOf(newId);
    if (existingNewIdx >= 0) {
      this.pinnedIds.splice(existingNewIdx, 1);
    }
    // Re-locate idx after potential splice (may have shifted)
    const adjustedIdx = this.pinnedIds.indexOf(oldId);
    this.pinnedIds[adjustedIdx] = newId;
    void this.persist().catch((err) => {
      console.error("[work-terminal] Failed to persist pin order:", err);
    });
    return true;
  }

  private normalize(ids: unknown[]): string[] {
    return [...new Set(ids.filter((id): id is string => typeof id === "string"))];
  }

  private async persist(): Promise<void> {
    const pinnedItems = [...this.pinnedIds];
    await mergeAndSavePluginData(this.plugin, (data) => {
      data.pinnedItems = pinnedItems;
    });
  }
}
