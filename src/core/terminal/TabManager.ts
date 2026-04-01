/**
 * TabManager - manages tab groups keyed by work item ID.
 *
 * Handles tab creation, closing, switching, drag-drop reordering,
 * active tab memory per work item, session recovery, and agent state
 * aggregation across tabs.
 *
 * Ported from TerminalPanel's tab management logic with work-item-agnostic
 * interfaces for adapter extensibility.
 */
import { TerminalTab, type AgentState } from "./TerminalTab";
import { aggregateState } from "../agents/AgentStateDetector";
import { SessionStore } from "../session/SessionStore";
import type { ActiveTabInfo, StoredSession, SessionType, TabDiagnostics } from "../session/types";

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
  /** Called when aggregate agent state changes for an item. */
  onAgentStateChange?: (itemId: string, state: AgentState) => void;
  /** Called when sessions should be persisted to disk. */
  onPersistRequest?: () => void;
  /** Called when a tab is closed, before disposal, with metadata for recently-closed tracking. */
  onTabClosed?: (itemId: string, tab: TerminalTab) => void;

  constructor(
    private terminalWrapperEl: HTMLElement,
    private pluginDir = "",
  ) {
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
            this.onAgentStateChange?.(itemId, this.getAgentState(itemId));
          };
          tab.hide();
          tabs.push(tab);
        }
        this.sessions.set(itemId, tabs);
      }
      this.activeTabIndex = stored.activeTabIndex;
      this.recoveredItemId = stored.activeTaskPath;
      this.recoveredTabIndex = stored.activeTabIndex;

      // Pre-seed idleSince for recovered items with resumable agent sessions so
      // idle animations start fully stale (300s ago) instead of fresh.
      const fullyStale = Date.now() - 300_000;
      for (const [itemId, tabs] of this.sessions) {
        if (tabs.some((t) => t.isResumableAgent)) {
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
      tabs[targetIdx].resetScreenFingerprint();
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
    agentSessionId?: string | null,
    durableSessionId?: string | null,
  ): TerminalTab | null {
    if (!this.activeItemId) return null;

    return this.createTabForItem(
      this.activeItemId,
      shell,
      cwd,
      label,
      sessionType,
      preCommand,
      commandArgs,
      agentSessionId,
      durableSessionId,
    );
  }

  createTabForItem(
    itemId: string,
    shell: string,
    cwd: string,
    label: string,
    sessionType: SessionType,
    preCommand?: string,
    commandArgs?: string[],
    agentSessionId?: string | null,
    durableSessionId?: string | null,
  ): TerminalTab {
    const isActiveItem = this.activeItemId === itemId;

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
      agentSessionId,
      durableSessionId,
      this.pluginDir,
    );

    tab.onLabelChange = () => {
      if (this.activeItemId === itemId) this._notifyLabelChange();
    };
    tab.onProcessExit = (code, _signal) => {
      const idx = tabs.indexOf(tab);
      if (idx === -1) return;
      const lived = Date.now() - spawnTime;
      // Short-lived processes (under 30s): always keep the tab open so the
      // user can see startup errors or unexpected early exits.
      if (lived < 30_000) return;
      // Long-lived processes: only auto-close on a clean exit (code 0).
      // Non-zero exit codes keep the tab open so the user can read the error.
      if (code !== 0) return;
      this.closeTabForItem(itemId, idx);
    };
    tab.onStateChange = () => {
      this.onAgentStateChange?.(itemId, this.getAgentState(itemId));
    };

    tabs.push(tab);
    this.sessions.set(itemId, tabs);

    if (isActiveItem) {
      // Hide others, show new
      this.hideAllTerminals();
      tab.show();
      this.activeTabIndex = tabs.length - 1;
    } else {
      tab.hide();
    }

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
    tabs[index].resetScreenFingerprint();
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

  /**
   * Move a tab from its current position to a target index within the same item.
   * Used by restart to place the replacement tab where the old one was.
   *
   * Note: targetIndex refers to the position in the original array before the
   * tab is removed. For forward moves (where currentIndex < targetIndex), the
   * tab's final position will be targetIndex - 1, because removing the tab
   * first shifts subsequent indices down by one.
   */
  moveTabToIndex(itemId: string, tab: TerminalTab, targetIndex: number): void {
    const tabs = this.sessions.get(itemId);
    if (!tabs) return;
    const currentIndex = tabs.indexOf(tab);
    if (currentIndex === -1) return;
    if (currentIndex === targetIndex) return;

    // Remember which tab object is currently active so we can preserve it
    const isActiveItem = this.activeItemId === itemId;
    const activeTabObj = isActiveItem ? tabs[this.activeTabIndex] : null;

    tabs.splice(currentIndex, 1);

    // After removing at currentIndex, indices shift down for forward moves
    let insertAt = targetIndex;
    if (currentIndex < targetIndex) insertAt--;

    tabs.splice(insertAt, 0, tab);

    // Restore activeTabIndex to follow the previously active tab
    if (isActiveItem && activeTabObj) {
      this.activeTabIndex = tabs.indexOf(activeTabObj);
    }

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
    this.closeTabForItem(this.activeItemId, index);
  }

  closeTabInstance(itemId: string, tab: TerminalTab): void {
    const tabs = this.sessions.get(itemId) || [];
    const index = tabs.indexOf(tab);
    if (index === -1) return;
    this.closeTabForItem(itemId, index);
  }

  closeTabForItem(itemId: string, index: number): void {
    const tabs = this.sessions.get(itemId) || [];
    if (index < 0 || index >= tabs.length) return;

    // Notify before disposal so metadata can be captured
    this.onTabClosed?.(itemId, tabs[index]);

    tabs[index].dispose();
    tabs.splice(index, 1);

    const isActiveItem = this.activeItemId === itemId;

    if (tabs.length === 0) {
      this.sessions.delete(itemId);
      this.lastActiveTab.delete(itemId);
      if (isActiveItem) this.activeTabIndex = 0;
    } else if (isActiveItem) {
      this.activeTabIndex = Math.min(this.activeTabIndex, tabs.length - 1);
      tabs[this.activeTabIndex].show();
    } else {
      const remembered = this.lastActiveTab.get(itemId) ?? 0;
      const adjusted = index < remembered ? remembered - 1 : remembered;
      this.lastActiveTab.set(itemId, Math.min(adjusted, tabs.length - 1));
    }

    this.onSessionChange?.();
    this.onAgentStateChange?.(itemId, this.getAgentState(itemId));
  }

  /** Close and dispose all terminal sessions for an item. */
  closeAllSessions(itemId: string): void {
    const tabs = this.sessions.get(itemId);
    if (!tabs || tabs.length === 0) return;

    for (const tab of tabs) {
      this.onTabClosed?.(itemId, tab);
      tab.dispose();
    }
    this.sessions.delete(itemId);

    if (this.activeItemId === itemId) {
      this.activeTabIndex = 0;
    }

    this.onSessionChange?.();
    this.onAgentStateChange?.(itemId, this.getAgentState(itemId));
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

  hasResumableAgentSessions(itemId: string): boolean {
    const tabs = this.sessions.get(itemId) || [];
    return tabs.some((tab) => tab.isResumableAgent);
  }

  /** Return item IDs that have terminal sessions. */
  getSessionItemIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  /** Return the count of shell and agent tabs for an item. */
  getSessionCounts(itemId: string): { shells: number; agents: number } {
    const tabs = this.sessions.get(itemId) || [];
    let agents = 0;
    let shells = 0;
    for (const tab of tabs) {
      if (tab.sessionType === "shell") {
        shells++;
      } else {
        agents++;
      }
    }
    return { shells, agents };
  }

  /** Return metadata for every active tab across every item. */
  getAllActiveTabs(): ActiveTabInfo[] {
    const activeTabs: ActiveTabInfo[] = [];
    for (const [itemId, tabs] of this.sessions) {
      for (const tab of tabs) {
        activeTabs.push({
          tabId: tab.id,
          itemId: tab.taskPath ?? itemId,
          label: tab.label,
          sessionId: tab.agentSessionId,
          sessionType: tab.sessionType,
          isResumableAgent: tab.isResumableAgent,
        });
      }
    }
    return activeTabs;
  }

  /** Return diagnostics for every live tab across every item. */
  getTabDiagnostics(): TabDiagnostics[] {
    const diagnostics: TabDiagnostics[] = [];
    for (const [itemId, tabs] of this.sessions) {
      for (const [tabIndex, tab] of tabs.entries()) {
        const tabDiagnostics = tab.getDiagnostics();
        const lifecycle =
          tab.isDisposed || tabDiagnostics.isDisposed
            ? "disposed"
            : tabDiagnostics.process.status === "alive"
              ? "live"
              : "lost";
        diagnostics.push({
          itemId: tab.taskPath ?? itemId,
          tabIndex,
          isSelected: this.activeItemId === itemId && this.activeTabIndex === tabIndex,
          recovery: {
            resumable: tab.isResumableAgent,
            relaunchable: !tab.isResumableAgent,
            hasPersistedSession: false,
            canResumeAfterRestart: false,
            missingPersistedMetadata: false,
            wouldBeLostOnFullClose: false,
            lifecycle,
          },
          ...tabDiagnostics,
          derived: {
            ...tabDiagnostics.derived,
            disposedTabStillSelected:
              tab.isDisposed && this.activeItemId === itemId && this.activeTabIndex === tabIndex,
          },
        });
      }
    }
    return diagnostics;
  }

  /** Find active tabs whose labels exactly match the supplied label. */
  findTabsByLabel(label: string): ActiveTabInfo[] {
    const normalizedLabel = label.trim().toLowerCase();
    if (!normalizedLabel) return [];
    return this.getAllActiveTabs().filter(
      (tab) => tab.label.trim().toLowerCase() === normalizedLabel,
    );
  }

  /** Return a set of all active agentSessionIds across all items. */
  getActiveSessionIds(): Set<string> {
    const ids = new Set<string>();
    for (const tab of this.getAllActiveTabs()) {
      if (tab.sessionId) ids.add(tab.sessionId);
    }
    return ids;
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
  // Agent state
  // ---------------------------------------------------------------------------

  /**
   * Get the aggregate agent state for an item.
   * Priority: waiting > active > idle > inactive.
   */
  getAgentState(itemId: string): AgentState {
    const tabs = this.sessions.get(itemId) || [];
    const states: AgentState[] = [];
    for (const tab of tabs) {
      if (tab.isResumableAgent) {
        states.push(tab.agentState);
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
