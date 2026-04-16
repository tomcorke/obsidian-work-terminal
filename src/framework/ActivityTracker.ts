/**
 * ActivityTracker - maintains in-memory last-activity timestamps for work items
 * and periodically flushes them to frontmatter for persistence across restarts.
 *
 * Design:
 * - In-memory timestamps are accurate to the second for precise ordering
 * - Frontmatter writes are throttled to at most once per minute per item
 * - On load, reads `last-active` from frontmatter as the initial timestamp
 * - Grouping into recency buckets is handled by the framework (ListPanel)
 */

/** Recency threshold options for the most recent section. */
export type RecentThreshold = "1h" | "3h" | "24h";

/** View mode for the list panel. */
export type ViewMode = "kanban" | "activity";

/** Activity bucket identifiers for grouping. */
export type ActivityBucket = "recent" | "last-7-days" | "last-30-days" | "older";

/** All bucket IDs in display order. */
export const ACTIVITY_BUCKETS: ActivityBucket[] = [
  "recent",
  "last-7-days",
  "last-30-days",
  "older",
];

/** Human-readable labels for each bucket. */
export const ACTIVITY_BUCKET_LABELS: Record<ActivityBucket, string> = {
  recent: "Recent",
  "last-7-days": "Last 7 Days",
  "last-30-days": "Last 30 Days",
  older: "Older",
};

/** Convert a threshold setting to milliseconds. */
export function thresholdToMs(threshold: RecentThreshold): number {
  switch (threshold) {
    case "1h":
      return 60 * 60 * 1000;
    case "3h":
      return 3 * 60 * 60 * 1000;
    case "24h":
      return 24 * 60 * 60 * 1000;
  }
}

/**
 * Determine which activity bucket a timestamp falls into.
 *
 * The "recent" bucket is "today OR last N hours" (whichever is longer).
 */
export function classifyActivity(
  timestamp: number | undefined,
  now: number,
  recentThreshold: RecentThreshold,
): ActivityBucket {
  if (!timestamp) return "older";

  const age = now - timestamp;

  // Calculate "today" boundary: midnight of the current day
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const todayMs = now - today.getTime();

  // "Recent" = today OR last N hours, whichever is longer
  const thresholdMs = thresholdToMs(recentThreshold);
  const recentMs = Math.max(todayMs, thresholdMs);

  if (age <= recentMs) return "recent";
  if (age <= 7 * 24 * 60 * 60 * 1000) return "last-7-days";
  if (age <= 30 * 24 * 60 * 60 * 1000) return "last-30-days";
  return "older";
}

/**
 * Minimum interval (ms) between frontmatter writes for a single item.
 * The issue spec requires at most once per minute.
 */
const FLUSH_THROTTLE_MS = 60_000;

/**
 * Tracks last-activity timestamps for work items.
 *
 * Responsibilities:
 * - Maintain in-memory timestamps (accurate to the second)
 * - Throttle frontmatter flushes (at most once per minute per item)
 * - Provide the current bucket for each item
 * - Provide a custom order within buckets based on manual ordering
 */
export class ActivityTracker {
  /** In-memory timestamps (ms since epoch). Updated on every activity event. */
  private timestamps: Map<string, number> = new Map();

  /** Last time we flushed each item's timestamp to frontmatter. */
  private lastFlushTime: Map<string, number> = new Map();

  /** Pending flush timers per item (for debounced write). */
  private flushTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  /** Callback to write last-active to frontmatter. */
  private onFlush: ((itemId: string, isoTimestamp: string) => Promise<void>) | null = null;

  /** Set the flush callback (called by MainView when the adapter is ready). */
  setFlushCallback(callback: (itemId: string, isoTimestamp: string) => Promise<void>): void {
    this.onFlush = callback;
  }

  /**
   * Record activity for an item. Updates the in-memory timestamp immediately
   * and schedules a throttled frontmatter flush.
   */
  recordActivity(itemId: string): void {
    const now = Date.now();
    this.timestamps.set(itemId, now);
    this.scheduleFlush(itemId, now);
  }

  /**
   * Seed a timestamp from frontmatter (used when parsing items on load).
   * Only updates if no in-memory timestamp exists yet (in-memory is more accurate).
   */
  seedFromFrontmatter(itemId: string, isoTimestamp: string | undefined): void {
    if (this.timestamps.has(itemId)) return;
    if (!isoTimestamp) return;

    const parsed = Date.parse(isoTimestamp);
    if (!isNaN(parsed)) {
      this.timestamps.set(itemId, parsed);
    }
  }

  /** Get the in-memory timestamp for an item. */
  getTimestamp(itemId: string): number | undefined {
    return this.timestamps.get(itemId);
  }

  /** Get the activity bucket for an item given the current time and threshold. */
  getBucket(itemId: string, now: number, recentThreshold: RecentThreshold): ActivityBucket {
    return classifyActivity(this.timestamps.get(itemId), now, recentThreshold);
  }

  /** Re-key an item (e.g. after file rename / ID backfill). */
  rekey(oldId: string, newId: string): boolean {
    const ts = this.timestamps.get(oldId);
    if (ts === undefined) return false;

    this.timestamps.delete(oldId);
    this.timestamps.set(newId, ts);

    const flushTime = this.lastFlushTime.get(oldId);
    if (flushTime !== undefined) {
      this.lastFlushTime.delete(oldId);
      this.lastFlushTime.set(newId, flushTime);
    }

    const timer = this.flushTimers.get(oldId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.flushTimers.delete(oldId);
    }

    return true;
  }

  /** Clean up timers on dispose. */
  dispose(): void {
    for (const timer of this.flushTimers.values()) {
      clearTimeout(timer);
    }
    this.flushTimers.clear();
  }

  private scheduleFlush(itemId: string, now: number): void {
    if (!this.onFlush) return;

    const lastFlush = this.lastFlushTime.get(itemId) ?? 0;
    const elapsed = now - lastFlush;

    // Clear any existing pending timer for this item
    const existingTimer = this.flushTimers.get(itemId);
    if (existingTimer) clearTimeout(existingTimer);

    if (elapsed >= FLUSH_THROTTLE_MS) {
      // Enough time has passed - flush immediately
      this.doFlush(itemId, now);
    } else {
      // Schedule flush for when the throttle window expires
      const delay = FLUSH_THROTTLE_MS - elapsed;
      const timer = setTimeout(() => {
        this.flushTimers.delete(itemId);
        // Use the latest timestamp, not the one from when we scheduled
        const currentTs = this.timestamps.get(itemId);
        if (currentTs !== undefined) {
          this.doFlush(itemId, currentTs);
        }
      }, delay);
      this.flushTimers.set(itemId, timer);
    }
  }

  private doFlush(itemId: string, timestamp: number): void {
    this.lastFlushTime.set(itemId, Date.now());
    const iso = new Date(timestamp).toISOString().replace(/\.\d{3}Z$/, "Z");
    this.onFlush?.(itemId, iso).catch((err) => {
      console.error(`[work-terminal] Failed to flush last-active for ${itemId}:`, err);
    });
  }
}
