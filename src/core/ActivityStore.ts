/**
 * ActivityStore - tracks last-active timestamps for work items.
 *
 * Maintains two layers:
 * 1. In-memory timestamps (accurate to the second) for responsive UI ordering.
 * 2. Persistent frontmatter `last-active` field (throttled to at most once per
 *    minute per item to avoid excessive file writes).
 *
 * The store is initialized from frontmatter during list refresh and updated
 * whenever tab creation or activity occurs for an item.
 */
import type { App, TFile } from "obsidian";

/** Minimum interval (ms) between frontmatter writes for the same item. */
const FRONTMATTER_THROTTLE_MS = 60_000;

export class ActivityStore {
  /** In-memory timestamps keyed by item ID. */
  private timestamps: Map<string, number> = new Map();

  /** Last frontmatter write time per item ID (to enforce throttle). */
  private lastWriteTime: Map<string, number> = new Map();

  /** Pending write timeouts per item ID (for deferred flush). */
  private pendingWrites: Map<string, ReturnType<typeof setTimeout>> = new Map();

  private app: App | null = null;

  /** Map from item ID to vault-relative file path (for frontmatter writes). */
  private itemPaths: Map<string, string> = new Map();

  /** Set the Obsidian App reference for vault operations. */
  setApp(app: App): void {
    this.app = app;
  }

  /**
   * Seed timestamps from parsed work items. Called during list refresh to
   * initialize from frontmatter values for items not yet seen in this session.
   */
  seedFromItems(
    items: Array<{ id: string; path: string; metadata: Record<string, unknown> }>,
  ): void {
    for (const item of items) {
      this.itemPaths.set(item.id, item.path);

      // Don't overwrite in-memory timestamps from this session - they're more accurate
      if (this.timestamps.has(item.id)) continue;

      // Try reading from metadata (TaskParser puts frontmatter fields in metadata)
      const lastActive = item.metadata?.["last-active"];
      if (typeof lastActive === "string" && lastActive) {
        const parsed = Date.parse(lastActive);
        if (!isNaN(parsed)) {
          this.timestamps.set(item.id, parsed);
        }
      }
    }
  }

  /**
   * Record activity for an item. Updates the in-memory timestamp immediately
   * and schedules a throttled frontmatter write.
   */
  recordActivity(itemId: string): void {
    const now = Date.now();
    this.timestamps.set(itemId, now);
    this.scheduleFrontmatterWrite(itemId, now);
  }

  /** Get the last-active timestamp for an item, or undefined if never active. */
  getTimestamp(itemId: string): number | undefined {
    return this.timestamps.get(itemId);
  }

  /** Get all timestamps as a map (for grouping). */
  getAllTimestamps(): Map<string, number> {
    return new Map(this.timestamps);
  }

  /** Update the file path mapping when an item is re-keyed. */
  rekeyItem(oldId: string, newId: string): void {
    const ts = this.timestamps.get(oldId);
    if (ts !== undefined) {
      this.timestamps.delete(oldId);
      this.timestamps.set(newId, ts);
    }

    const lastWrite = this.lastWriteTime.get(oldId);
    if (lastWrite !== undefined) {
      this.lastWriteTime.delete(oldId);
      this.lastWriteTime.set(newId, lastWrite);
    }

    const path = this.itemPaths.get(oldId);
    if (path !== undefined) {
      this.itemPaths.delete(oldId);
      this.itemPaths.set(newId, path);
    }

    const pending = this.pendingWrites.get(oldId);
    if (pending !== undefined) {
      clearTimeout(pending);
      this.pendingWrites.delete(oldId);
      // Re-schedule for the new ID
      this.scheduleFrontmatterWrite(newId, this.timestamps.get(newId) ?? Date.now());
    }
  }

  /** Clean up pending writes on dispose. */
  dispose(): void {
    for (const timeout of this.pendingWrites.values()) {
      clearTimeout(timeout);
    }
    this.pendingWrites.clear();
  }

  /**
   * Flush all pending writes immediately. Call before plugin unload to ensure
   * in-session timestamps are persisted to frontmatter.
   */
  async flushAll(): Promise<void> {
    // Clear all pending timeouts
    for (const timeout of this.pendingWrites.values()) {
      clearTimeout(timeout);
    }
    this.pendingWrites.clear();

    // Write all items that have in-memory timestamps
    const promises: Promise<void>[] = [];
    for (const [itemId, timestamp] of this.timestamps) {
      promises.push(this.writeFrontmatter(itemId, timestamp));
    }
    await Promise.allSettled(promises);
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private scheduleFrontmatterWrite(itemId: string, timestamp: number): void {
    if (!this.app) return;

    const lastWrite = this.lastWriteTime.get(itemId) ?? 0;
    const elapsed = Date.now() - lastWrite;

    if (elapsed >= FRONTMATTER_THROTTLE_MS) {
      // Enough time has passed - write immediately
      this.clearPending(itemId);
      void this.writeFrontmatter(itemId, timestamp);
    } else if (!this.pendingWrites.has(itemId)) {
      // Schedule a deferred write
      const delay = FRONTMATTER_THROTTLE_MS - elapsed;
      const timeout = setTimeout(() => {
        this.pendingWrites.delete(itemId);
        const currentTs = this.timestamps.get(itemId);
        if (currentTs !== undefined) {
          void this.writeFrontmatter(itemId, currentTs);
        }
      }, delay);
      this.pendingWrites.set(itemId, timeout);
    }
    // If a write is already pending, it will use the latest timestamp
  }

  private clearPending(itemId: string): void {
    const existing = this.pendingWrites.get(itemId);
    if (existing !== undefined) {
      clearTimeout(existing);
      this.pendingWrites.delete(itemId);
    }
  }

  private async writeFrontmatter(itemId: string, timestamp: number): Promise<void> {
    if (!this.app) return;

    const filePath = this.itemPaths.get(itemId);
    if (!filePath) return;

    const file = this.app.vault.getAbstractFileByPath(filePath) as TFile | null;
    if (!file) return;

    try {
      const content = await this.app.vault.read(file);
      const isoDate = new Date(timestamp).toISOString().replace(/\.\d{3}Z$/, "Z");

      let updated: string;
      if (/^last-active:\s*.+$/m.test(content)) {
        // Update existing field
        updated = content.replace(/^last-active:\s*.+$/m, `last-active: ${isoDate}`);
      } else {
        // Insert into frontmatter block
        const fmMatch = content.match(/^(---\r?\n)([\s\S]*?)(^---(?:\r?\n|$))/m);
        if (!fmMatch) return; // No frontmatter block - skip

        const [fullMatch, openFence, body, closeFence] = fmMatch;
        const eol = openFence.endsWith("\r\n") ? "\r\n" : "\n";
        const trimmedBody = body.endsWith(eol) ? body : body + eol;
        updated = content.replace(
          fullMatch,
          `${openFence}${trimmedBody}last-active: ${isoDate}${eol}${closeFence}`,
        );
      }

      if (updated !== content) {
        await this.app.vault.modify(file, updated);
      }

      this.lastWriteTime.set(itemId, Date.now());
    } catch (err) {
      console.error(
        `[work-terminal] ActivityStore: failed to write last-active for ${filePath}:`,
        err,
      );
    }
  }
}
