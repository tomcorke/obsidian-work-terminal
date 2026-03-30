/**
 * RecentlyClosedStore - tracks sessions closed within the last 30 minutes
 * so users can restore them from the custom session spawner dialog.
 */
import type { DurableRecoveryMode, SessionType } from "./types";

export interface ClosedSessionEntry {
  sessionType: SessionType;
  label: string;
  claudeSessionId: string | null;
  closedAt: number; // Date.now() timestamp
  itemId: string;
  recoveryMode: DurableRecoveryMode;
  cwd?: string;
  command?: string;
  commandArgs?: string[];
}

const MAX_ENTRIES = 20; // Keep more than 5 internally for filtering
const EXPIRY_MS = 30 * 60 * 1000; // 30 minutes

export class RecentlyClosedStore {
  private entries: ClosedSessionEntry[] = [];

  constructor(initialEntries: ClosedSessionEntry[] = []) {
    this.replaceAll(initialEntries);
  }

  /** Record a closed session. */
  add(entry: ClosedSessionEntry): void {
    const normalized = RecentlyClosedStore.normalizeEntry(entry);
    if (!normalized) {
      return;
    }
    const key = RecentlyClosedStore.entryKey(normalized);
    this.entries = this.entries.filter((existing) => RecentlyClosedStore.entryKey(existing) !== key);
    this.entries.unshift(normalized);
    this.prune();
  }

  remove(entry: ClosedSessionEntry): void {
    const key = RecentlyClosedStore.entryKey(entry);
    this.entries = this.entries.filter((existing) => RecentlyClosedStore.entryKey(existing) !== key);
  }

  replaceAll(entries: ClosedSessionEntry[]): void {
    this.entries = entries
      .map((entry) => RecentlyClosedStore.normalizeEntry(entry))
      .filter((entry): entry is ClosedSessionEntry => !!entry);
    this.prune();
  }

  /**
   * Get recently closed sessions, filtered to exclude currently active session IDs.
   * Returns newest first, max `limit` entries.
   */
  getEntries(
    activeSessionIds: Set<string>,
    limit = 5,
    isEntryActive?: (entry: ClosedSessionEntry) => boolean,
  ): ClosedSessionEntry[] {
    this.prune();
    const result: ClosedSessionEntry[] = [];
    for (const entry of this.entries) {
      if (result.length >= limit) break;
      // Skip if the session is currently active (reopened by any means)
      if (entry.claudeSessionId && activeSessionIds.has(entry.claudeSessionId)) {
        continue;
      }
      if (isEntryActive?.(entry)) {
        continue;
      }
      result.push(entry);
    }
    return result;
  }

  serialize(): ClosedSessionEntry[] {
    this.prune();
    return this.entries.map((entry) => ({
      ...entry,
      commandArgs: entry.commandArgs ? [...entry.commandArgs] : undefined,
    }));
  }

  static fromData(raw: unknown): ClosedSessionEntry[] {
    if (!Array.isArray(raw)) {
      return [];
    }

    return raw
      .map((entry) => this.normalizeEntry(entry))
      .filter((entry): entry is ClosedSessionEntry => !!entry);
  }

  private static normalizeEntry(raw: unknown): ClosedSessionEntry | null {
    if (!raw || typeof raw !== "object") {
      return null;
    }

    const candidate = raw as Record<string, unknown>;
    const itemId = typeof candidate.itemId === "string" ? candidate.itemId : null;
    const label = typeof candidate.label === "string" ? candidate.label : null;
    const sessionType = typeof candidate.sessionType === "string" ? candidate.sessionType : null;
    const claudeSessionId =
      typeof candidate.claudeSessionId === "string" ? candidate.claudeSessionId : null;
    const closedAt =
      typeof candidate.closedAt === "number"
        ? candidate.closedAt
        : typeof candidate.closedAt === "string"
          ? Number(candidate.closedAt)
          : NaN;
    const recoveryMode =
      candidate.recoveryMode === "resume" || candidate.recoveryMode === "relaunch"
        ? candidate.recoveryMode
        : claudeSessionId
          ? "resume"
          : null;
    const cwd = typeof candidate.cwd === "string" ? candidate.cwd : undefined;
    const command = typeof candidate.command === "string" ? candidate.command : undefined;
    const commandArgs = Array.isArray(candidate.commandArgs)
      ? candidate.commandArgs.filter((value): value is string => typeof value === "string")
      : undefined;

    if (!itemId || !label || !sessionType || !Number.isFinite(closedAt) || !recoveryMode) {
      return null;
    }

    if (recoveryMode === "resume" && !claudeSessionId) {
      return null;
    }

    if (recoveryMode === "relaunch" && (!cwd || !command)) {
      return null;
    }

    return {
      itemId,
      label,
      sessionType: sessionType as SessionType,
      claudeSessionId,
      closedAt,
      recoveryMode,
      cwd,
      command,
      commandArgs,
    };
  }

  private static entryKey(entry: ClosedSessionEntry): string {
    if (entry.recoveryMode === "resume" && entry.claudeSessionId) {
      return `resume:${entry.claudeSessionId}`;
    }

    const args = entry.commandArgs?.join("\u0000") || "";
    return [
      "relaunch",
      entry.itemId,
      entry.sessionType,
      entry.label,
      entry.cwd || "",
      entry.command || "",
      args,
    ].join("\u0001");
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
