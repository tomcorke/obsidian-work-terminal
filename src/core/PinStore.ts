import type { PluginDataStore } from "./PluginDataStore";
import { mergeAndSavePluginData } from "./PluginDataStore";

/**
 * Manages pinned item IDs. Pin state is stored in plugin data (data.json)
 * under the `pinnedItems` key as an ordered array of item UUIDs. The array
 * order defines the display order in the pinned section.
 *
 * This is a display-only concept - pinning does not change the item's actual
 * state/column, just its visual position at the top of the kanban board.
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
    this.pinnedIds = Array.isArray(data.pinnedItems) ? [...data.pinnedItems] : [];
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
  async reorder(newOrder: string[]): Promise<void> {
    const pinSet = new Set(this.pinnedIds);
    this.pinnedIds = newOrder.filter((id) => pinSet.has(id));
    await this.persist();
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
    // Persist asynchronously - caller is responsible for triggering save
    void this.persist();
    return true;
  }

  private async persist(): Promise<void> {
    const pinnedItems = [...this.pinnedIds];
    await mergeAndSavePluginData(this.plugin, (data) => {
      data.pinnedItems = pinnedItems;
    });
  }
}
