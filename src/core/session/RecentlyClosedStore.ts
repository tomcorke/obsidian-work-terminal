/**
 * RecentlyClosedStore - tracks sessions closed within the last 30 minutes
 * so users can restore them from the custom session spawner dialog.
 */
import { isSessionType, type DurableRecoveryMode, type SessionType } from "./types";

export interface ClosedSessionEntry {
  sessionType: SessionType;
  label: string;
  agentSessionId?: string | null;
  claudeSessionId?: string | null;
  durableSessionId?: string;
  durableSessionIdGenerated?: boolean;
  closedAt: number; // Date.now() timestamp
  itemId: string;
  recoveryMode: DurableRecoveryMode;
  cwd?: string;
  command?: string;
  commandArgs?: string[];
  profileColor?: string;
}

export interface RecentlyClosedState {
  entries: ClosedSessionEntry[];
  hydratedFromDisk: boolean;
}

const MAX_ENTRIES = 20; // Keep more than 5 internally for filtering
const EXPIRY_MS = 30 * 60 * 1000; // 30 minutes
const WINDOW_STATE_KEY = Symbol.for("work-terminal.recently-closed-state");

export class RecentlyClosedStore {
  private readonly state: RecentlyClosedState;

  constructor(
    initialEntries: ClosedSessionEntry[] = [],
    state: RecentlyClosedState = { entries: [], hydratedFromDisk: false },
  ) {
    this.state = state;
    if (initialEntries.length > 0) {
      this.replaceAll(initialEntries);
    } else {
      this.prune();
    }
  }

  static createWindowScoped(): RecentlyClosedStore {
    return new RecentlyClosedStore([], this.getWindowState());
  }

  static claimWindowHydration(): boolean {
    const state = this.getWindowState();
    if (state.hydratedFromDisk) {
      return false;
    }
    state.hydratedFromDisk = true;
    return true;
  }

  /** Record a closed session. */
  add(entry: ClosedSessionEntry): void {
    const normalized = RecentlyClosedStore.normalizeEntry(entry);
    if (!normalized) {
      return;
    }
    const key = RecentlyClosedStore.entryKey(normalized);
    this.state.entries = this.state.entries.filter(
      (existing) => RecentlyClosedStore.entryKey(existing) !== key,
    );
    this.state.entries.unshift(normalized);
    this.prune();
  }

  remove(entry: ClosedSessionEntry): void {
    const key = RecentlyClosedStore.entryKey(entry);
    this.state.entries = this.state.entries.filter(
      (existing) => RecentlyClosedStore.entryKey(existing) !== key,
    );
  }

  take(entry: ClosedSessionEntry): ClosedSessionEntry | null {
    this.prune();
    const key = RecentlyClosedStore.entryKey(entry);
    const index = this.state.entries.findIndex(
      (existing) => RecentlyClosedStore.entryKey(existing) === key,
    );
    if (index === -1) {
      return null;
    }
    const [claimed] = this.state.entries.splice(index, 1);
    return claimed ? RecentlyClosedStore.cloneEntry(claimed) : null;
  }

  replaceAll(entries: ClosedSessionEntry[]): void {
    this.state.entries = entries
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
    for (const entry of this.state.entries) {
      if (result.length >= limit) break;
      // Skip if the session is currently active (reopened by any means)
      const sessionId = entry.claudeSessionId ?? entry.agentSessionId;
      if (sessionId && activeSessionIds.has(sessionId)) {
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
    return this.state.entries.map((entry) => RecentlyClosedStore.cloneEntry(entry));
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
    const sessionType = isSessionType(candidate.sessionType) ? candidate.sessionType : null;
    const claudeSessionId =
      typeof candidate.claudeSessionId === "string"
        ? candidate.claudeSessionId
        : typeof candidate.agentSessionId === "string"
          ? candidate.agentSessionId
          : null;
    const durableSessionId =
      typeof candidate.durableSessionId === "string" ? candidate.durableSessionId : undefined;
    const durableSessionIdGenerated = candidate.durableSessionIdGenerated === true;
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
    const profileColor =
      typeof candidate.profileColor === "string" ? candidate.profileColor : undefined;

    if (!itemId || !label || !sessionType || !Number.isFinite(closedAt) || !recoveryMode) {
      return null;
    }

    if (recoveryMode === "resume" && !claudeSessionId) {
      return null;
    }

    if (recoveryMode === "relaunch" && (!cwd || !command)) {
      return null;
    }

    const generatedDurableSessionId =
      recoveryMode === "relaunch" && !durableSessionId ? globalThis.crypto.randomUUID() : undefined;

    return {
      itemId,
      label,
      sessionType,
      claudeSessionId,
      durableSessionId:
        recoveryMode === "relaunch" ? durableSessionId || generatedDurableSessionId : undefined,
      durableSessionIdGenerated:
        recoveryMode === "relaunch" && (durableSessionIdGenerated || !!generatedDurableSessionId)
          ? true
          : undefined,
      closedAt,
      recoveryMode,
      cwd,
      command,
      commandArgs,
      profileColor,
    };
  }

  private static entryKey(entry: ClosedSessionEntry): string {
    if (entry.recoveryMode === "resume" && entry.claudeSessionId) {
      return `resume:${entry.claudeSessionId}`;
    }

    if (entry.durableSessionId) {
      return `relaunch:${entry.itemId}\u0001${entry.durableSessionId}`;
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
    this.state.entries = this.state.entries.filter((e) => e.closedAt > cutoff);
    if (this.state.entries.length > MAX_ENTRIES) {
      this.state.entries.length = MAX_ENTRIES;
    }
  }

  private static cloneEntry(entry: ClosedSessionEntry): ClosedSessionEntry {
    return {
      ...entry,
      durableSessionIdGenerated: entry.durableSessionIdGenerated ? true : undefined,
      commandArgs: entry.commandArgs ? [...entry.commandArgs] : undefined,
    };
  }

  private static getWindowState(): RecentlyClosedState {
    const target = (typeof window !== "undefined" ? window : globalThis) as typeof globalThis & {
      [WINDOW_STATE_KEY]?: RecentlyClosedState;
    };
    if (!target[WINDOW_STATE_KEY]) {
      target[WINDOW_STATE_KEY] = {
        entries: [],
        hydratedFromDisk: false,
      };
    }
    return target[WINDOW_STATE_KEY];
  }
}
