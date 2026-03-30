/**
 * In-memory session store for hot-reload persistence.
 *
 * Uses a window global (__workTerminalStore) that survives module re-evaluation
 * during Obsidian plugin hot-reload. Sessions are stashed before unload and
 * retrieved on the next load cycle, preserving live Terminal instances,
 * child processes, and DOM elements.
 */
import type { StoredSession, StoredState } from "./types";

declare global {
  interface Window {
    __workTerminalStore?: StoredState;
  }
}

export class SessionStore {
  /**
   * Stash session state into the global store for reload recovery.
   * Does NOT kill processes or dispose terminals.
   */
  static stash(
    sessions: Map<string, StoredSession[]>,
    activeTaskPath: string | null,
    activeTabIndex: number,
  ): void {
    const existing = window.__workTerminalStore;
    const mergedSessions = new Map(existing?.sessions || []);
    for (const [itemId, tabs] of sessions) {
      const existingTabs = mergedSessions.get(itemId) || [];
      mergedSessions.set(itemId, [...existingTabs, ...tabs]);
    }
    window.__workTerminalStore = {
      sessions: mergedSessions,
      activeTaskPath: activeTaskPath ?? existing?.activeTaskPath ?? null,
      activeTabIndex:
        activeTaskPath !== null || !existing ? activeTabIndex : (existing.activeTabIndex ?? 0),
    };
    console.log("[work-terminal] Stashed", mergedSessions.size, "task groups for reload");
  }

  /**
   * Retrieve stashed session state. Delete-after-read: the store is cleared
   * after retrieval to prevent double-consumption.
   */
  static retrieve(): StoredState | null {
    const store = window.__workTerminalStore;
    if (!store) return null;
    delete window.__workTerminalStore;
    console.log("[work-terminal] Retrieved", store.sessions.size, "task groups from store");
    return store;
  }

  /** Check if there is a stashed store from a previous reload. */
  static isReload(): boolean {
    return !!window.__workTerminalStore;
  }
}
