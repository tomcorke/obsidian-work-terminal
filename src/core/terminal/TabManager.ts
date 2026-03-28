/**
 * TabManager - manages tab groups keyed by work item ID.
 *
 * Handles tab creation, closing, switching, drag-drop reordering,
 * active tab memory per work item, session recovery, and Claude state
 * aggregation across tabs.
 *
 * Ported from TerminalPanel's tab management logic with work-item-agnostic
 * interfaces for adapter extensibility.
 */
import { TerminalTab, type ClaudeState } from "./TerminalTab";
import { aggregateState } from "../claude/ClaudeStateDetector";
import { SessionStore } from "../session/SessionStore";
import type { StoredSession, SessionType } from "../session/types";

export class TabManager {
  private sessions: Map<string, TerminalTab[]> = new Map();
  private activeItemId: string | null = null;
  private activeTabIndex = 0;
  private recoveredItemId: string | null = null;
  private recoveredTabIndex = 0;
  private lastActiveTab: Map<string, number> = new Map();
  /** Timestamp (ms) when each item last entered idle state. */
  private idleSince: Map<string, number> = new Map();
  private dragSourceIndex: number | null = null;

  /** Called when session count changes (tab created/closed). */
  onSessionChange?: () => void;
  /** Called when aggregate Claude state changes for an item. */
  onClaudeStateChange?: (itemId: string, state: ClaudeState) => void;
  /** Called when sessions should be persisted to disk. */
  onPersistRequest?: () => void;

  constructor(private terminalWrapperEl: HTMLElement) {
    // Recover sessions from a previous reload
    const stored = SessionStore.retrieve();
    if (stored) {
      for (const [itemId, storedSessions] of stored.sessions) {
        const tabs: TerminalTab[] = [];
        for (const ss of storedSessions) {
          const tab = TerminalTab.fromStored(ss, this.terminalWrapperEl);
          tab.onLabelChange = () => {
            if (this.activeItemId === itemId) this._notifyLabelChange();
          };
          tab.onStateChange = () => {
            this.onClaudeStateChange?.(itemId, this.getClaudeState(itemId));
          };
          tab.hide();
          tabs.push(tab);
        }
        this.sessions.set(itemId, tabs);
      }
      this.activeTabIndex = stored.activeTabIndex;
      this.recoveredItemId = stored.activeTaskPath;
      this.recoveredTabIndex = stored.activeTabIndex;

      // Pre-seed idleSince for recovered items with Claude sessions so
      // idle animations start fully stale (300s ago) instead of fresh.
      const fullyStale = Date.now() - 300_000;
      for (const [itemId, tabs] of this.sessions) {
        if (tabs.some((t) => t.isClaudeSession)) {
          this.idleSince.set(itemId, fullyStale);
        }
      }

      console.log("[work-terminal] Recovered", this.sessions.size, "item groups");
    }
  }

  // ---------------------------------------------------------------------------
  // Item selection
  // ---------------------------------------------------------------------------

  /** Return recovered active item ID from a previous reload (consumed once). */
  getRecoveredItemId(): string | null {
    const id = this.recoveredItemId;
    this.recoveredItemId = null;
    return id;
  }

  /** Get the currently active item ID. */
  getActiveItemId(): string | null {
    return this.activeItemId;
  }

  /** Get the active tab index. */
  getActiveTabIndex(): number {
    return this.activeTabIndex;
  }

  /**
   * Switch active work item. Hides all terminals, shows the correct tab
   * for the new item. Pass null to deselect.
   */
  setActiveItem(itemId: string | null): void {
    // Save current active tab index before switching away
    if (this.activeItemId) {
      this.lastActiveTab.set(this.activeItemId, this.activeTabIndex);
    }

    this.hideAllTerminals();
    this.activeItemId = itemId;
    this.activeTabIndex = 0;

    if (!itemId) return;

    const tabs = this.sessions.get(itemId) || [];
    if (tabs.length > 0) {
      // Restore recovered tab index if this is a reload re-selection
      let targetIdx = 0;
      if (this.recoveredTabIndex > 0 && this.recoveredTabIndex < tabs.length) {
        targetIdx = this.recoveredTabIndex;
        this.recoveredTabIndex = 0;
      } else {
        const remembered = this.lastActiveTab.get(itemId);
        if (remembered !== undefined && remembered < tabs.length) {
          targetIdx = remembered;
        }
      }
      tabs[targetIdx].show();
      tabs[targetIdx].clearWaiting();
      this.activeTabIndex = targetIdx;
    }
  }

  // ---------------------------------------------------------------------------
  // Tab creation
  // ---------------------------------------------------------------------------

  /**
   * Create a new terminal tab for the active item.
   *
   * @returns The created TerminalTab, or null if no active item.
   */
  createTab(
    shell: string,
    cwd: string,
    label: string,
    sessionType: SessionType,
    preCommand?: string,
    commandArgs?: string[],
    claudeSessionId?: string | null,
  ): TerminalTab | null {
    if (!this.activeItemId) return null;

    const itemId = this.activeItemId;
    const tabs = this.sessions.get(itemId) || [];
    const spawnTime = Date.now();

    const tab = new TerminalTab(
      this.terminalWrapperEl,
      shell,
      cwd,
      label,
      itemId,
      sessionType,
      preCommand,
      commandArgs,
      claudeSessionId,
    );

    tab.onLabelChange = () => {
      if (this.activeItemId === itemId) this._notifyLabelChange();
    };
    tab.onProcessExit = (_code, _signal) => {
      const idx = tabs.indexOf(tab);
      if (idx === -1) return;
      // If the process exited within 3 seconds, it likely errored -
      // keep the tab open so the user can see the error message.
      const lived = Date.now() - spawnTime;
      if (lived < 3000) return;
      this.closeTab(idx);
    };
    tab.onStateChange = () => {
      this.onClaudeStateChange?.(itemId, this.getClaudeState(itemId));
    };

    tabs.push(tab);
    this.sessions.set(itemId, tabs);

    // Hide others, show new
    this.hideAllTerminals();
    tab.show();
    this.activeTabIndex = tabs.length - 1;

    this.onSessionChange?.();
    return tab;
  }

  // ---------------------------------------------------------------------------
  // Tab switching & reordering
  // ---------------------------------------------------------------------------

  switchToTab(index: number): void {
    if (!this.activeItemId) return;
    const tabs = this.sessions.get(this.activeItemId) || [];
    if (index < 0 || index >= tabs.length) return;

    this.hideAllTerminals();
    tabs[index].show();
    tabs[index].clearWaiting();
    this.activeTabIndex = index;
  }

  reorderTab(fromIndex: number, toIndex: number, dropAfter: boolean): void {
    if (!this.activeItemId) return;
    const tabs = this.sessions.get(this.activeItemId) || [];
    if (fromIndex < 0 || fromIndex >= tabs.length) return;
    if (toIndex < 0 || toIndex >= tabs.length) return;

    // Remember which tab object is currently active
    const activeTabObj = tabs[this.activeTabIndex];

    // Remove the dragged tab
    const [movedTab] = tabs.splice(fromIndex, 1);

    // Calculate insertion index after removal
    let insertAt = toIndex;
    if (fromIndex < toIndex) insertAt--;
    if (dropAfter) insertAt++;

    tabs.splice(insertAt, 0, movedTab);

    // Update activeTabIndex to follow the previously active tab
    this.activeTabIndex = tabs.indexOf(activeTabObj);

    this.onSessionChange?.();
    this.onPersistRequest?.();
  }

  /** Get/set the drag source index for tab reordering UI. */
  getDragSourceIndex(): number | null {
    return this.dragSourceIndex;
  }

  setDragSourceIndex(index: number | null): void {
    this.dragSourceIndex = index;
  }

  // ---------------------------------------------------------------------------
  // Tab closing
  // ---------------------------------------------------------------------------

  closeTab(index: number): void {
    if (!this.activeItemId) return;
    const itemId = this.activeItemId;
    const tabs = this.sessions.get(itemId) || [];
    if (index < 0 || index >= tabs.length) return;

    tabs[index].dispose();
    tabs.splice(index, 1);

    if (tabs.length === 0) {
      this.sessions.delete(itemId);
      this.activeTabIndex = 0;
    } else {
      this.activeTabIndex = Math.min(this.activeTabIndex, tabs.length - 1);
      tabs[this.activeTabIndex].show();
    }

    this.onSessionChange?.();
    this.onClaudeStateChange?.(itemId, this.getClaudeState(itemId));
  }

  /** Close and dispose all terminal sessions for an item. */
  closeAllSessions(itemId: string): void {
    const tabs = this.sessions.get(itemId);
    if (!tabs || tabs.length === 0) return;

    for (const tab of tabs) {
      tab.dispose();
    }
    this.sessions.delete(itemId);

    if (this.activeItemId === itemId) {
      this.activeTabIndex = 0;
    }

    this.onSessionChange?.();
    this.onClaudeStateChange?.(itemId, this.getClaudeState(itemId));
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  /** Get tabs for an item. */
  getTabs(itemId: string): TerminalTab[] {
    return this.sessions.get(itemId) || [];
  }

  /** Get the currently active tab, or null. */
  getActiveTab(): TerminalTab | null {
    if (!this.activeItemId) return null;
    const tabs = this.sessions.get(this.activeItemId) || [];
    if (this.activeTabIndex < tabs.length) return tabs[this.activeTabIndex];
    return null;
  }

  /** Check if an item has any terminal sessions. */
  hasSessions(itemId: string): boolean {
    const tabs = this.sessions.get(itemId);
    return !!tabs && tabs.length > 0;
  }

  /** Return item IDs that have terminal sessions. */
  getSessionItemIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  /** Return the count of shell and agent tabs for an item. */
  getSessionCounts(itemId: string): { shells: number; claudes: number } {
    const tabs = this.sessions.get(itemId) || [];
    let claudes = 0;
    let shells = 0;
    for (const tab of tabs) {
      if (tab.isClaudeSession) {
        claudes++;
      } else {
        shells++;
      }
    }
    return { shells, claudes };
  }

  /** Re-fit the active terminal to its container dimensions. */
  refitActive(): void {
    if (!this.activeItemId) return;
    const tabs = this.sessions.get(this.activeItemId) || [];
    if (tabs.length > 0 && this.activeTabIndex < tabs.length) {
      tabs[this.activeTabIndex].refit();
    }
  }

  // ---------------------------------------------------------------------------
  // Claude state
  // ---------------------------------------------------------------------------

  /**
   * Get the aggregate Claude state for an item.
   * Priority: waiting > active > idle > inactive.
   */
  getClaudeState(itemId: string): ClaudeState {
    const tabs = this.sessions.get(itemId) || [];
    const states: ClaudeState[] = [];
    for (const tab of tabs) {
      if (tab.isClaudeSession) {
        states.push(tab.claudeState);
      }
    }
    const result = aggregateState(states);

    // Track idle-since timestamp for staleness animation continuity
    if (result === "idle") {
      if (!this.idleSince.has(itemId)) {
        this.idleSince.set(itemId, Date.now());
      }
    } else {
      this.idleSince.delete(itemId);
    }

    return result;
  }

  /** Get the timestamp (ms) when this item entered idle, or undefined. */
  getIdleSince(itemId: string): number | undefined {
    return this.idleSince.get(itemId);
  }

  // ---------------------------------------------------------------------------
  // Item re-keying (path changes)
  // ---------------------------------------------------------------------------

  rekeyItem(oldId: string, newId: string): void {
    const tabs = this.sessions.get(oldId);
    if (!tabs) return;

    this.sessions.delete(oldId);
    this.sessions.set(newId, tabs);

    for (const tab of tabs) {
      tab.taskPath = newId;
    }

    if (this.activeItemId === oldId) {
      this.activeItemId = newId;
    }
  }

  // ---------------------------------------------------------------------------
  // Stash / dispose
  // ---------------------------------------------------------------------------

  /**
   * Stash all sessions into the global store for reload recovery.
   * Does NOT kill processes or dispose terminals.
   */
  stashAll(): void {
    const stashMap = new Map<string, StoredSession[]>();
    for (const [itemId, tabs] of this.sessions) {
      stashMap.set(
        itemId,
        tabs.map((t) => t.stash()),
      );
    }
    SessionStore.stash(stashMap, this.activeItemId, this.activeTabIndex);
    // Clear local references without disposing
    this.sessions.clear();
  }

  /** Dispose all sessions and clean up. */
  disposeAll(): void {
    for (const tabs of this.sessions.values()) {
      for (const tab of tabs) {
        tab.dispose();
      }
    }
    this.sessions.clear();
  }

  /** Expose the sessions map (for persistence layer). */
  getSessions(): Map<string, TerminalTab[]> {
    return this.sessions;
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private hideAllTerminals(): void {
    for (const tabs of this.sessions.values()) {
      for (const tab of tabs) {
        tab.hide();
      }
    }
  }

  private _notifyLabelChange(): void {
    // Bubble up to trigger tab bar re-render
    this.onSessionChange?.();
  }
}
