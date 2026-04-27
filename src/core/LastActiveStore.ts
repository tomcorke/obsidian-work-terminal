import type { PluginDataStore } from "./PluginDataStore";
import { mergeAndSavePluginData } from "./PluginDataStore";

const LAST_ACTIVE_FLUSH_DEBOUNCE_MS = 1_000;

function sanitizeLastActiveMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(raw).filter(
      ([itemId, isoTimestamp]) =>
        typeof itemId === "string" &&
        !!itemId &&
        typeof isoTimestamp === "string" &&
        !!isoTimestamp &&
        !Number.isNaN(Date.parse(isoTimestamp)),
    ),
  );
}

/**
 * Persists activity timestamps in plugin data (`data.json`) keyed by work-item id.
 *
 * Writes are debounced so bursts of activity across multiple items coalesce into
 * a single `saveData()` operation, while `mergeAndSavePluginData()` still
 * serialises concurrent writes with the rest of the plugin.
 */
export class LastActiveStore {
  private timestampsById: Record<string, string> = {};
  private dirtyIds = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private loaded = false;

  constructor(private plugin: PluginDataStore) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    const data = (await this.plugin.loadData()) || {};
    this.timestampsById = sanitizeLastActiveMap(data.lastActiveById);
    this.loaded = true;
  }

  get(itemId: string): string | undefined {
    return this.timestampsById[itemId];
  }

  set(itemId: string, isoTimestamp: string): void {
    if (!itemId || !isoTimestamp) return;
    this.timestampsById[itemId] = isoTimestamp;
    this.markDirty(itemId);
  }

  rekey(oldId: string, newId: string): boolean {
    if (!oldId || !newId || oldId === newId) return false;
    const existing = this.timestampsById[oldId];
    if (!existing) return false;

    const replacement = this.timestampsById[newId];
    if (!replacement || Date.parse(existing) >= Date.parse(replacement)) {
      this.timestampsById[newId] = existing;
    }
    delete this.timestampsById[oldId];
    this.markDirty(oldId);
    this.markDirty(newId);
    return true;
  }

  /**
   * Remove stale path-keyed entries that no longer match any current item.
   *
   * Durable UUID ids are left alone here. They are harmless if retained and
   * can still be useful if a task temporarily drops out of the parsed item set.
   */
  pruneMissingPathIds(validIds: Iterable<string>): boolean {
    const validSet = new Set(validIds);
    let changed = false;

    for (const itemId of Object.keys(this.timestampsById)) {
      if (validSet.has(itemId) || !looksLikePathId(itemId)) {
        continue;
      }
      delete this.timestampsById[itemId];
      this.markDirty(itemId);
      changed = true;
    }

    return changed;
  }

  async flushNow(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.dirtyIds.size === 0) return;
    const dirtyIds = [...this.dirtyIds];
    this.dirtyIds.clear();

    try {
      await mergeAndSavePluginData(this.plugin, (data) => {
        const lastActiveById = sanitizeLastActiveMap(data.lastActiveById);
        for (const itemId of dirtyIds) {
          const isoTimestamp = this.timestampsById[itemId];
          if (isoTimestamp) {
            lastActiveById[itemId] = isoTimestamp;
          } else {
            delete lastActiveById[itemId];
          }
        }

        if (Object.keys(lastActiveById).length > 0) {
          data.lastActiveById = lastActiveById;
        } else {
          delete data.lastActiveById;
        }
      });
    } catch (err) {
      for (const itemId of dirtyIds) {
        this.dirtyIds.add(itemId);
      }
      throw err;
    }
  }

  dispose(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private markDirty(itemId: string): void {
    this.dirtyIds.add(itemId);
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushNow().catch((err) => {
        console.error("[work-terminal] Failed to flush last-active store:", err);
      });
    }, LAST_ACTIVE_FLUSH_DEBOUNCE_MS);
  }
}

function looksLikePathId(itemId: string): boolean {
  return itemId.includes("/") || itemId.endsWith(".md") || itemId.startsWith("~/");
}
