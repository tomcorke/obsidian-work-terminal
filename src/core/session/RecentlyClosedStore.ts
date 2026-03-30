/**
 * RecentlyClosedStore - tracks sessions closed within the last 30 minutes
 * so users can restore them from the custom session spawner dialog.
 */
import type { SessionType } from "./types";

export interface ClosedSessionEntry {
  sessionType: SessionType;
  label: string;
  agentSessionId: string | null;
  closedAt: number; // Date.now() timestamp
  itemId: string;
}

const MAX_ENTRIES = 20; // Keep more than 5 internally for filtering
const EXPIRY_MS = 30 * 60 * 1000; // 30 minutes

export class RecentlyClosedStore {
  private entries: ClosedSessionEntry[] = [];

  /** Record a closed session. */
  add(entry: ClosedSessionEntry): void {
    this.entries.unshift(entry);
    this.prune();
  }

  /**
   * Get recently closed sessions, filtered to exclude currently active session IDs.
   * Returns newest first, max `limit` entries.
   */
  getEntries(activeSessionIds: Set<string>, limit = 5): ClosedSessionEntry[] {
    this.prune();
    const result: ClosedSessionEntry[] = [];
    for (const entry of this.entries) {
      if (result.length >= limit) break;
      // Skip if the session is currently active (reopened by any means)
      if (entry.agentSessionId && activeSessionIds.has(entry.agentSessionId)) {
        continue;
      }
      result.push(entry);
    }
    return result;
  }

  /** Remove expired entries (older than 30 minutes). */
  private prune(): void {
    const cutoff = Date.now() - EXPIRY_MS;
    this.entries = this.entries.filter((e) => e.closedAt > cutoff);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.length = MAX_ENTRIES;
    }
  }
}
