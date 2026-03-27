/**
 * TerminalPanelView - wraps TabManager with Claude launch buttons,
 * state aggregation, session resume, tab context menu, and inline rename.
 */
import { Menu, Notice } from "obsidian";
import type { Plugin } from "obsidian";
import { TabManager } from "../core/terminal/TabManager";
import type { TerminalTab, ClaudeState } from "../core/terminal/TerminalTab";
import {
  resolveCommand,
  augmentPath,
  buildClaudeArgs,
} from "../core/claude/ClaudeLauncher";
import { SessionPersistence } from "../core/session/SessionPersistence";
import type { PersistedSession, SessionType } from "../core/session/types";
import { expandTilde } from "../core/utils";
import type {
  AdapterBundle,
  WorkItem,
  WorkItemPromptBuilder,
} from "../core/interfaces";

export class TerminalPanelView {
  private tabManager: TabManager;
  private plugin: Plugin;
  private adapter: AdapterBundle;
  private settings: Record<string, any>;
  private promptBuilder: WorkItemPromptBuilder;
  private onClaudeStateChange: (itemId: string, state: string) => void;
  private onSessionChange: () => void;

  // DOM elements
  private panelEl: HTMLElement;
  private tabBarEl: HTMLElement;
  private terminalWrapperEl: HTMLElement;

  // Persisted sessions from disk
  private persistedSessions: PersistedSession[] = [];

  // Active items reference (for tab context menu "Move to Item")
  private allItems: WorkItem[] = [];

  // Tab rename state
  private renameActive = false;

  constructor(
    panelEl: HTMLElement,
    terminalWrapperEl: HTMLElement,
    plugin: Plugin,
    adapter: AdapterBundle,
    settings: Record<string, any>,
    promptBuilder: WorkItemPromptBuilder,
    onClaudeStateChange: (itemId: string, state: string) => void,
    onSessionChange: () => void
  ) {
    this.panelEl = panelEl;
    this.terminalWrapperEl = terminalWrapperEl;
    this.plugin = plugin;
    this.adapter = adapter;
    this.settings = settings;
    this.promptBuilder = promptBuilder;
    this.onClaudeStateChange = onClaudeStateChange;
    this.onSessionChange = onSessionChange;

    // Tab bar at top of panel
    this.tabBarEl = panelEl.createDiv({ cls: "wt-tab-bar" });
    // Move tab bar before terminal wrapper
    panelEl.insertBefore(this.tabBarEl, terminalWrapperEl);

    // Initialize TabManager
    this.tabManager = new TabManager(terminalWrapperEl);
    this.tabManager.onSessionChange = () => {
      this.renderTabBar();
      this.onSessionChange();
    };
    this.tabManager.onClaudeStateChange = (itemId: string, state: ClaudeState) => {
      this.onClaudeStateChange(itemId, state);
      this.updateTabStateClasses();
    };
    this.tabManager.onPersistRequest = () => {
      this.persistSessions();
    };

    // Load persisted sessions from disk
    this.loadPersistedSessions();

    // Initial tab bar render
    this.renderTabBar();
  }

  // ---------------------------------------------------------------------------
  // Tab bar rendering
  // ---------------------------------------------------------------------------

  private renderTabBar(): void {
    this.tabBarEl.empty();

    const tabsContainer = this.tabBarEl.createDiv({ cls: "wt-tabs-container" });
    const buttonsContainer = this.tabBarEl.createDiv({ cls: "wt-tab-buttons" });

    const activeItemId = this.tabManager.getActiveItemId();
    if (activeItemId) {
      const tabs = this.tabManager.getTabs(activeItemId);
      const activeIdx = this.tabManager.getActiveTabIndex();

      for (let i = 0; i < tabs.length; i++) {
        const tab = tabs[i];
        const tabEl = tabsContainer.createDiv({ cls: "wt-tab" });
        if (i === activeIdx) tabEl.addClass("wt-tab-active");
        if (tab.isClaudeSession) {
          const state = tab.claudeState;
          if (state !== "inactive") tabEl.addClass(`wt-tab-claude-${state}`);
        }
        tabEl.setAttribute("draggable", "true");
        tabEl.setAttribute("data-tab-index", String(i));

        // Tab label
        const labelEl = tabEl.createSpan({ cls: "wt-tab-label", text: tab.label });

        // Double-click to rename
        labelEl.addEventListener("dblclick", (e) => {
          e.stopPropagation();
          this.startTabRename(tabEl, labelEl, tab, i);
        });

        // Click to switch
        tabEl.addEventListener("click", () => {
          if (this.renameActive) return;
          this.tabManager.switchToTab(i);
          this.renderTabBar();
        });

        // Close button
        const closeBtn = tabEl.createSpan({ cls: "wt-tab-close", text: "\u00d7" });
        closeBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          this.tabManager.closeTab(i);
          this.renderTabBar();
        });

        // Tab context menu
        tabEl.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          this.showTabContextMenu(tab, i, e);
        });

        // Tab drag-and-drop
        this.setupTabDragDrop(tabEl, i);
      }
    }

    // Spawn buttons (always visible)
    const shellBtn = buttonsContainer.createEl("button", { cls: "wt-spawn-btn", text: "+ Shell" });
    shellBtn.addEventListener("click", () => this.spawnShell());

    const claudeBtn = buttonsContainer.createEl("button", { cls: "wt-spawn-btn wt-spawn-claude", text: "+ Claude" });
    claudeBtn.addEventListener("click", () => this.spawnClaude());

    if (this.settings["core.additionalAgentContext"]) {
      const claudeCtxBtn = buttonsContainer.createEl("button", { cls: "wt-spawn-btn wt-spawn-claude-ctx", text: "+ Claude (ctx)" });
      claudeCtxBtn.addEventListener("click", () => this.spawnClaudeWithContext());
    }
  }

  /** Update Claude state classes on existing tab elements without full re-render. */
  private updateTabStateClasses(): void {
    const activeItemId = this.tabManager.getActiveItemId();
    if (!activeItemId) return;
    const tabs = this.tabManager.getTabs(activeItemId);
    const tabEls = this.tabBarEl.querySelectorAll(".wt-tab");
    const stateClasses = ["wt-tab-claude-waiting", "wt-tab-claude-active", "wt-tab-claude-idle"];
    for (let i = 0; i < tabs.length && i < tabEls.length; i++) {
      const el = tabEls[i] as HTMLElement;
      for (const cls of stateClasses) el.removeClass(cls);
      if (tabs[i].isClaudeSession) {
        const state = tabs[i].claudeState;
        if (state !== "inactive") el.addClass(`wt-tab-claude-${state}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Tab drag-and-drop
  // ---------------------------------------------------------------------------

  private setupTabDragDrop(tabEl: HTMLElement, index: number): void {
    tabEl.addEventListener("dragstart", (e: DragEvent) => {
      this.tabManager.setDragSourceIndex(index);
      tabEl.addClass("wt-tab-dragging");
      e.dataTransfer?.setData("text/plain", String(index));
    });

    tabEl.addEventListener("dragend", () => {
      this.tabManager.setDragSourceIndex(null);
      tabEl.removeClass("wt-tab-dragging");
    });

    tabEl.addEventListener("dragover", (e: DragEvent) => {
      e.preventDefault();
      const sourceIdx = this.tabManager.getDragSourceIndex();
      if (sourceIdx === null || sourceIdx === index) return;
      tabEl.addClass("wt-tab-drop-target");
    });

    tabEl.addEventListener("dragleave", () => {
      tabEl.removeClass("wt-tab-drop-target");
    });

    tabEl.addEventListener("drop", (e: DragEvent) => {
      e.preventDefault();
      tabEl.removeClass("wt-tab-drop-target");
      const sourceIdx = this.tabManager.getDragSourceIndex();
      if (sourceIdx === null) return;

      // Determine drop side (left or right of midpoint)
      const rect = tabEl.getBoundingClientRect();
      const dropAfter = e.clientX > rect.left + rect.width / 2;

      this.tabManager.reorderTab(sourceIdx, index, dropAfter);
      this.renderTabBar();
    });
  }

  // ---------------------------------------------------------------------------
  // Tab inline rename
  // ---------------------------------------------------------------------------

  private startTabRename(tabEl: HTMLElement, labelEl: HTMLElement, tab: TerminalTab, _index: number): void {
    this.renameActive = true;
    const input = document.createElement("input");
    input.type = "text";
    input.value = tab.label;
    input.addClass("wt-tab-rename-input");

    labelEl.replaceWith(input);
    input.focus();
    input.select();

    // Stop propagation to prevent terminal/Obsidian focus stealing
    input.addEventListener("keydown", (e) => e.stopPropagation());
    input.addEventListener("mousedown", (e) => e.stopPropagation());

    // Armed blur - ignore blur events for 200ms to prevent premature commit
    let armed = false;
    setTimeout(() => { armed = true; }, 200);

    const commit = () => {
      if (!armed) return;
      const newLabel = input.value.trim() || tab.label;
      tab.label = newLabel;
      this.renameActive = false;
      this.renderTabBar();
      this.tabManager.onPersistRequest?.();
    };

    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        armed = true;
        commit();
      }
      if (e.key === "Escape") {
        armed = true;
        this.renameActive = false;
        this.renderTabBar();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Tab context menu
  // ---------------------------------------------------------------------------

  private showTabContextMenu(tab: TerminalTab, index: number, e: MouseEvent): void {
    const menu = new Menu();

    menu.addItem((item) => {
      item.setTitle("Rename").onClick(() => {
        const tabEl = this.tabBarEl.querySelector(`[data-tab-index="${index}"]`) as HTMLElement;
        const labelEl = tabEl?.querySelector(".wt-tab-label") as HTMLElement;
        if (tabEl && labelEl) this.startTabRename(tabEl, labelEl, tab, index);
      });
    });

    if (tab.isClaudeSession) {
      menu.addItem((item) => {
        item.setTitle("Restart").onClick(() => {
          this.tabManager.closeTab(index);
          this.spawnClaude();
        });
      });
    }

    // Move to Item submenu - grouped by column with headers
    if (this.allItems.length > 0) {
      menu.addSeparator();
      const activeItemId = this.tabManager.getActiveItemId();
      const excludedStates = new Set(["done", "abandoned", "archive"]);
      const available = this.allItems.filter(
        (wi) => wi.id !== activeItemId && !excludedStates.has(wi.state)
      );

      const columns = this.adapter.config.columns;
      for (const col of columns) {
        if (excludedStates.has(col.id)) continue;
        const inColumn = available.filter((wi) => wi.state === col.id);
        if (inColumn.length === 0) continue;

        // Section header (disabled item acts as label)
        menu.addItem((item) => {
          item.setTitle(`Move to ${col.label}`).setDisabled(true);
        });
        for (const workItem of inColumn) {
          menu.addItem((item) => {
            item.setTitle(workItem.title).onClick(() => {
              this.moveTabToItem(tab, index, workItem.id);
            });
          });
        }
      }
    }

    menu.showAtMouseEvent(e);
  }

  private moveTabToItem(tab: TerminalTab, index: number, targetItemId: string): void {
    // Remove from current item, add to target
    const currentItemId = this.tabManager.getActiveItemId();
    if (!currentItemId) return;

    const currentTabs = this.tabManager.getTabs(currentItemId);
    if (index < 0 || index >= currentTabs.length) return;

    // Re-key the tab
    tab.taskPath = targetItemId;

    // Move tab between groups using TabManager internals
    currentTabs.splice(index, 1);
    const targetTabs = this.tabManager.getTabs(targetItemId);
    targetTabs.push(tab);
    tab.hide();

    // Adjust active tab
    if (currentTabs.length > 0) {
      const newIdx = Math.min(index, currentTabs.length - 1);
      this.tabManager.switchToTab(newIdx);
    }

    this.renderTabBar();
    this.onSessionChange();

    // Notify both source and destination for badge updates
    this.onClaudeStateChange(currentItemId, this.tabManager.getClaudeState(currentItemId));
    this.onClaudeStateChange(targetItemId, this.tabManager.getClaudeState(targetItemId));
  }

  // ---------------------------------------------------------------------------
  // Spawn operations
  // ---------------------------------------------------------------------------

  private spawnShell(): void {
    const shell = this.settings["core.defaultShell"] || process.env.SHELL || "/bin/zsh";
    const cwd = expandTilde(this.settings["core.defaultTerminalCwd"] || "~");
    this.tabManager.createTab(shell, cwd, "Shell", "shell");
    this.renderTabBar();
  }

  private async spawnClaude(): Promise<void> {
    const fresh = ((await this.plugin.loadData()) || {}).settings || {};
    const claudeCmd = fresh["core.claudeCommand"] || this.settings["core.claudeCommand"] || "claude";
    const resolved = resolveCommand(claudeCmd);
    const sessionId = crypto.randomUUID();
    const args = buildClaudeArgs(
      {
        claudeExtraArgs: fresh["core.claudeExtraArgs"] || this.settings["core.claudeExtraArgs"] || "",
      },
      sessionId
    );

    const cwd = expandTilde(fresh["core.defaultTerminalCwd"] || this.settings["core.defaultTerminalCwd"] || "~");
    const tab = this.tabManager.createTab(
      resolved,
      cwd,
      "Claude",
      "claude",
      undefined,
      [resolved, ...args],
      sessionId
    );
    if (tab && this.adapter.transformSessionLabel) {
      tab.transformLabel = (old, detected) => this.adapter.transformSessionLabel!(old, detected);
    }
    this.renderTabBar();
  }

  private async spawnClaudeWithContext(): Promise<void> {
    const activeItemId = this.tabManager.getActiveItemId();
    if (!activeItemId) {
      new Notice("Select a task first to launch Claude with context");
      return;
    }

    const item = this.allItems.find((i) => i.id === activeItemId);
    if (!item) {
      new Notice("Could not find the selected task");
      return;
    }

    // Read settings fresh from disk so edits take effect without reload
    const fresh = ((await this.plugin.loadData()) || {}).settings || {};
    const template = fresh["core.additionalAgentContext"] || "";
    if (!template) {
      new Notice("Set 'Claude (ctx) prompt template' in settings to use Claude (ctx)");
      return;
    }

    // Substitute placeholders in the template
    const prompt = template
      .replace(/\$title/g, item.title)
      .replace(/\$state/g, item.state)
      .replace(/\$filePath/g, item.path)
      .replace(/\$id/g, item.id);

    const claudeCmd = fresh["core.claudeCommand"] || this.settings["core.claudeCommand"] || "claude";
    const resolved = resolveCommand(claudeCmd);
    const sessionId = crypto.randomUUID();
    const extraArgs = fresh["core.claudeExtraArgs"] || this.settings["core.claudeExtraArgs"] || "";
    const args = buildClaudeArgs(
      { claudeExtraArgs: extraArgs },
      sessionId,
      prompt
    );

    const cwd = expandTilde(fresh["core.defaultTerminalCwd"] || this.settings["core.defaultTerminalCwd"] || "~");
    const tab = this.tabManager.createTab(
      resolved,
      cwd,
      "Claude (ctx)",
      "claude-with-context",
      undefined,
      [resolved, ...args],
      sessionId
    );
    if (tab && this.adapter.transformSessionLabel) {
      tab.transformLabel = (old, detected) => this.adapter.transformSessionLabel!(old, detected);
    }
    this.renderTabBar();
  }

  resumeSession(persisted: PersistedSession): void {
    const claudeCmd = this.settings["core.claudeCommand"] || "claude";
    const resolved = resolveCommand(claudeCmd);
    const args = ["--resume", persisted.claudeSessionId];

    if (this.settings["core.claudeExtraArgs"]) {
      args.unshift(...this.settings["core.claudeExtraArgs"].split(/\s+/).filter(Boolean));
    }

    const cwd = expandTilde(this.settings["core.defaultTerminalCwd"] || "~");
    const tab = this.tabManager.createTab(
      resolved,
      cwd,
      persisted.label,
      persisted.sessionType,
      undefined,
      [resolved, ...args],
      persisted.claudeSessionId
    );

    // Wire adapter's session label transform hook
    if (tab && this.adapter.transformSessionLabel) {
      tab.transformLabel = (old, detected) => this.adapter.transformSessionLabel!(old, detected);
    }

    // 5s grace period: if process exits quickly, keep persisted entry for retry
    if (tab) {
      const spawnTime = Date.now();
      const origExit = tab.onProcessExit;
      tab.onProcessExit = (code, signal) => {
        const lived = Date.now() - spawnTime;
        if (lived < 5000) {
          // Failed resume - don't remove persisted entry
          console.log("[work-terminal] Resume failed (exited in", lived, "ms), keeping for retry");
        } else {
          // Successful resume - remove from persisted list
          this.persistedSessions = this.persistedSessions.filter(
            (s) => s.claudeSessionId !== persisted.claudeSessionId
          );
        }
        origExit?.(code, signal);
      };
    }

    this.renderTabBar();
  }

  // ---------------------------------------------------------------------------
  // Session persistence
  // ---------------------------------------------------------------------------

  private async loadPersistedSessions(): Promise<void> {
    this.persistedSessions = await SessionPersistence.loadFromDisk(this.plugin);
  }

  async persistSessions(): Promise<void> {
    await SessionPersistence.saveToDisk(this.plugin, this.tabManager.getSessions());
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  setActiveItem(itemId: string | null): void {
    this.tabManager.setActiveItem(itemId);
    this.renderTabBar();
  }

  getRecoveredItemId(): string | null {
    return this.tabManager.getRecoveredItemId();
  }

  refitActive(): void {
    this.tabManager.refitActive();
  }

  hasSessions(itemId: string): boolean {
    return this.tabManager.hasSessions(itemId);
  }

  hasAnySessions(): boolean {
    return this.tabManager.getSessionItemIds().length > 0;
  }

  getSessionCounts(itemId: string): { shells: number; claudes: number } {
    return this.tabManager.getSessionCounts(itemId);
  }

  getIdleSince(itemId: string): number | undefined {
    return this.tabManager.getIdleSince(itemId);
  }

  closeAllSessions(itemId: string): void {
    this.tabManager.closeAllSessions(itemId);
    this.renderTabBar();
  }

  getPersistedSessions(itemId: string): PersistedSession[] {
    return this.persistedSessions.filter((s) => s.taskPath === itemId);
  }

  /**
   * Broadcast current Claude state for all items with sessions.
   * Call after initial list render to sync state indicators that may have been
   * set before the ListPanel existed (e.g. recovered from hot-reload).
   */
  broadcastClaudeStates(): void {
    for (const itemId of this.tabManager.getSessionItemIds()) {
      const state = this.tabManager.getClaudeState(itemId);
      this.onClaudeStateChange(itemId, state);
    }
  }

  rekeyItem(oldId: string, newId: string): void {
    this.tabManager.rekeyItem(oldId, newId);
  }

  stashAll(): void {
    this.tabManager.stashAll();
  }

  disposeAll(): void {
    this.tabManager.disposeAll();
  }

  setItems(items: WorkItem[]): void {
    this.allItems = items;
  }

  getClaudeState(itemId: string): ClaudeState {
    return this.tabManager.getClaudeState(itemId);
  }
}
