/**
 * TerminalPanelView - wraps TabManager with terminal launch buttons,
 * custom session spawning, state aggregation, session resume, tab context
 * menu, and inline rename.
 */
import { Menu, Notice } from "obsidian";

function createClaudeLogo(size = 14): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 110 130");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.style.verticalAlign = "middle";
  svg.style.marginRight = "4px";
  svg.style.flexShrink = "0";
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("fill", "currentColor");
  path.setAttribute(
    "d",
    "m 29.05,98.54 29.14,-16.35 0.49,-1.42 -0.49,-0.79 h -1.42 l -4.87,-0.3 -16.65,-0.45 -14.44,-0.6 -13.99,-0.75 -3.52,-0.75 -3.3,-4.35 0.34,-2.17 2.96,-1.99 4.24,0.37 9.37,0.64 14.06,0.97 10.2,0.6 15.11,1.57 h 2.4 l 0.34,-0.97 -0.82,-0.6 -0.64,-0.6 -14.55,-9.86 -15.75,-10.42 -8.25,-6 -4.46,-3.04 -2.25,-2.85 -0.97,-6.22 4.05,-4.46 5.44,0.37 1.39,0.37 5.51,4.24 11.77,9.11 15.37,11.32 2.25,1.87 0.9,-0.64 0.11,-0.45 -1.01,-1.69 -8.36,-15.11 -8.92,-15.37 -3.97,-6.37 -1.05,-3.82 c -0.37,-1.57 -0.64,-2.89 -0.64,-4.5 l 4.61,-6.26 2.55,-0.82 6.15,0.82 2.59,2.25 3.82,8.74 6.19,13.76 9.6,18.71 2.81,5.55 1.5,5.14 0.56,1.57 h 0.97 v -0.9 l 0.79,-10.54 1.46,-12.94 1.42,-16.65 0.49,-4.69 2.32,-5.62 4.61,-3.04 3.6,1.72 2.96,4.24 -0.41,2.74 -1.76,11.44 -3.45,17.92 -2.25,12 h 1.31 l 1.5,-1.5 6.07,-8.06 10.2,-12.75 4.5,-5.06 5.25,-5.59 3.37,-2.66 h 6.37 l 4.69,6.97 -2.1,7.2 -6.56,8.32 -5.44,7.05 -7.8,10.5 -4.87,8.4 0.45,0.67 1.16,-0.11 17.62,-3.75 9.52,-1.72 11.36,-1.95 5.14,2.4 0.56,2.44 -2.02,4.99 -12.15,3 -14.25,2.85 -21.22,5.02 -0.26,0.19 0.3,0.37 9.56,0.9 4.09,0.22 h 10.01 l 18.64,1.39 4.87,3.22 2.92,3.94 -0.49,3 -7.5,3.82 -10.12,-2.4 -23.62,-5.62 -8.1,-2.02 h -1.12 v 0.67 l 6.75,6.6 12.37,11.17 15.49,14.4 0.79,3.56 -1.99,2.81 -2.1,-0.3 -13.61,-10.24 -5.25,-4.61 -11.89,-10.01 h -0.79 v 1.05 l 2.74,4.01 14.47,21.75 0.75,6.67 -1.05,2.17 -3.75,1.31 -4.12,-0.75 -8.47,-11.89 -8.74,-13.39 -7.05,-12 -0.86,0.49 -4.16,44.81 -1.95,2.29 -4.5,1.72 -3.75,-2.85 -1.99,-4.61 1.99,-9.11 2.4,-11.89 1.95,-9.45 1.76,-11.74 1.05,-3.9 -0.07,-0.26 -0.86,0.11 -8.85,12.15 -13.46,18.19 -10.65,11.4 -2.55,1.01 -4.42,-2.29 0.41,-4.09 2.47,-3.64 14.74,-18.75 8.89,-11.62 5.74,-6.71 -0.04,-0.97 h -0.34 l -39.15,25.42 -6.97,0.9 -3,-2.81 0.37,-4.61 1.42,-1.5 11.77,-8.1 -0.04,0.04 z",
  );
  svg.appendChild(path);
  return svg;
}
import type { Plugin } from "obsidian";
import { TabManager } from "../core/terminal/TabManager";
import type { TerminalTab, ClaudeState } from "../core/terminal/TerminalTab";
import {
  resolveCommand,
  buildClaudeArgs,
  buildCopilotArgs,
  buildStrandsArgs,
} from "../core/claude/ClaudeLauncher";
import { SessionPersistence, PERSIST_INTERVAL_MS } from "../core/session/SessionPersistence";
import type { PersistedSession } from "../core/session/types";
import { expandTilde } from "../core/utils";
import { checkHookStatus } from "../core/claude/ClaudeHookManager";
import type { AdapterBundle, WorkItem, WorkItemPromptBuilder } from "../core/interfaces";
import { buildClaudeContextPrompt } from "./ClaudeContextPrompt";
import { CustomSessionModal } from "./CustomSessionModal";
import {
  getDefaultSessionLabel,
  isClaudeSession,
  isContextSession,
  isCopilotSession,
  isStrandsSession,
  sanitizeCustomSessionConfig,
  type CustomSessionConfig,
} from "./CustomSessionConfig";

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
  private titleEl: HTMLElement;
  private tabBarEl: HTMLElement;
  private terminalWrapperEl: HTMLElement;

  // Persisted sessions from disk
  private persistedSessions: PersistedSession[] = [];

  // Active items reference (for tab context menu "Move to Item")
  private allItems: WorkItem[] = [];

  // Tab rename state
  private renameActive = false;

  // Periodic persist stop function
  private stopPeriodicPersist: (() => void) | null = null;

  // Hook warning banner element
  private hookWarningEl: HTMLElement | null = null;

  // Interval ID for hook-status polling while warning is visible
  private hookWarningPollId: ReturnType<typeof setInterval> | null = null;

  // In-flight guard to prevent overlapping async checkHookWarning() calls
  private hookWarningCheckInFlight = false;
  private hookWarningCheckQueued = false;

  // Serialises plugin data writes to avoid clobbering unrelated keys.
  private pluginDataWrite: Promise<void> = Promise.resolve();

  constructor(
    panelEl: HTMLElement,
    terminalWrapperEl: HTMLElement,
    plugin: Plugin,
    adapter: AdapterBundle,
    settings: Record<string, any>,
    promptBuilder: WorkItemPromptBuilder,
    onClaudeStateChange: (itemId: string, state: string) => void,
    onSessionChange: () => void,
  ) {
    this.panelEl = panelEl;
    this.terminalWrapperEl = terminalWrapperEl;
    this.plugin = plugin;
    this.adapter = adapter;
    this.settings = settings;
    this.promptBuilder = promptBuilder;
    this.onClaudeStateChange = onClaudeStateChange;
    this.onSessionChange = onSessionChange;

    // Task title heading above tab bar
    this.titleEl = panelEl.createDiv({ cls: "wt-task-title" });
    panelEl.insertBefore(this.titleEl, terminalWrapperEl);

    // Tab bar at top of panel
    this.tabBarEl = panelEl.createDiv({ cls: "wt-tab-bar" });
    // Move tab bar before terminal wrapper
    panelEl.insertBefore(this.tabBarEl, terminalWrapperEl);

    // Initialize TabManager
    this.tabManager = new TabManager(terminalWrapperEl);
    this.tabManager.onSessionChange = () => {
      this.renderTabBar();
      void this.checkHookWarning();
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

    // Start periodic disk persist as safety net (every 30s)
    this.stopPeriodicPersist = SessionPersistence.startPeriodicPersist(
      () => this.persistSessions(),
      PERSIST_INTERVAL_MS,
    );

    // Initial tab bar render
    this.renderTabBar();

    // Check hook status and show warning banner if needed
    this.checkHookWarning();
  }

  // ---------------------------------------------------------------------------
  // Hook warning banner
  // ---------------------------------------------------------------------------

  private async checkHookWarning(): Promise<void> {
    if (this.hookWarningCheckInFlight) {
      this.hookWarningCheckQueued = true;
      return;
    }
    this.hookWarningCheckInFlight = true;
    try {
      const fresh = ((await this.plugin.loadData()) || {}).settings || {};
      const accepted = fresh["core.acceptNoResumeHooks"] ?? false;
      const cwd = expandTilde(
        fresh["core.defaultTerminalCwd"] || this.settings["core.defaultTerminalCwd"] || "~",
      );
      const status = checkHookStatus(cwd);
      const hooksOk = status.scriptExists && status.hooksConfigured;
      const hasClaudeUsage = this.hasClaudeHookDependentUsage();

      if (!hooksOk && !accepted && hasClaudeUsage) {
        // Only create the banner on the transition from no-banner -> banner needed
        if (!this.hookWarningEl) {
          this.hookWarningEl = this.panelEl.createDiv({ cls: "wt-hook-warning-banner" });
          // Insert at the very top of the panel
          this.panelEl.insertBefore(this.hookWarningEl, this.panelEl.firstChild);

          const textEl = this.hookWarningEl.createSpan();
          textEl.textContent =
            "Claude /resume tracking requires Claude hooks. Copilot restart resume works without them.";

          const openBtn = this.hookWarningEl.createEl("button", {
            cls: "wt-hook-warning-btn",
            text: "Open Settings",
          });
          openBtn.addEventListener("click", () => {
            (this.plugin.app as any).setting.open();
            (this.plugin.app as any).setting.openTabById(this.plugin.manifest.id);
          });

          const dismissBtn = this.hookWarningEl.createEl("button", {
            cls: "wt-hook-warning-btn",
            text: "Dismiss",
          });
          dismissBtn.addEventListener("click", async () => {
            const d = (await this.plugin.loadData()) || {};
            if (!d.settings) d.settings = {};
            d.settings["core.acceptNoResumeHooks"] = true;
            await this.plugin.saveData(d);
            this.hookWarningEl?.remove();
            this.hookWarningEl = null;
            this.stopHookWarningPoller();
          });

          // Poll hook status while warning is visible so it auto-dismisses when
          // the user installs hooks via settings without manually reloading.
          this.startHookWarningPoller();
        }
        // else: banner already visible, nothing to change
      } else {
        // Hooks OK or accepted: remove banner and stop polling on transition
        if (this.hookWarningEl) {
          this.hookWarningEl.remove();
          this.hookWarningEl = null;
        }
        this.stopHookWarningPoller();
      }
    } finally {
      this.hookWarningCheckInFlight = false;
      if (this.hookWarningCheckQueued) {
        this.hookWarningCheckQueued = false;
        void this.checkHookWarning();
      }
    }
  }

  private startHookWarningPoller(): void {
    this.stopHookWarningPoller();
    this.hookWarningPollId = setInterval(() => {
      this.checkHookWarning().catch((err) =>
        console.error("[work-terminal] hook warning check failed:", err),
      );
    }, 2000);
  }

  private stopHookWarningPoller(): void {
    if (this.hookWarningPollId !== null) {
      clearInterval(this.hookWarningPollId);
      this.hookWarningPollId = null;
    }
  }

  private hasClaudeHookDependentUsage(): boolean {
    for (const tabs of this.tabManager.getSessions().values()) {
      for (const tab of tabs) {
        if (isClaudeSession(tab.sessionType)) {
          return true;
        }
      }
    }

    return this.persistedSessions.some((session) => isClaudeSession(session.sessionType));
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
    shellBtn.addEventListener("click", () => void this.spawnShell());

    const claudeBtn = buttonsContainer.createEl("button", { cls: "wt-spawn-btn wt-spawn-claude" });
    claudeBtn.appendChild(createClaudeLogo());
    claudeBtn.appendText("Claude");
    claudeBtn.addEventListener("click", () => void this.spawnClaude());

    const claudeCtxBtn = buttonsContainer.createEl("button", {
      cls: "wt-spawn-btn wt-spawn-claude-ctx",
    });
    claudeCtxBtn.appendChild(createClaudeLogo());
    claudeCtxBtn.appendText("Claude (ctx)");
    claudeCtxBtn.addEventListener("click", () => void this.spawnClaudeWithContext());

    const customBtn = buttonsContainer.createEl("button", {
      cls: "wt-spawn-btn wt-spawn-custom",
      text: "...",
    });
    customBtn.setAttribute("aria-label", "Custom session");
    customBtn.setAttribute("title", "Custom session");
    customBtn.addEventListener("click", () => void this.openCustomSessionModal());
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

  private startTabRename(
    tabEl: HTMLElement,
    labelEl: HTMLElement,
    tab: TerminalTab,
    _index: number,
  ): void {
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
    setTimeout(() => {
      armed = true;
    }, 200);

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
        (wi) => wi.id !== activeItemId && !excludedStates.has(wi.state),
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

  private async loadFreshSettings(): Promise<Record<string, unknown>> {
    return ((await this.plugin.loadData()) || {}).settings || {};
  }

  private getStringSetting(
    settings: Record<string, unknown>,
    key: string,
    defaultValue: string,
  ): string {
    const value = settings[key];
    return typeof value === "string" ? value : defaultValue;
  }

  private async spawnShell(): Promise<void> {
    const fresh = await this.loadFreshSettings();
    const shell = this.getStringSetting(
      fresh,
      "core.defaultShell",
      process.env.SHELL || "/bin/zsh",
    );
    const cwd = expandTilde(this.getStringSetting(fresh, "core.defaultTerminalCwd", "~"));
    this.tabManager.createTab(shell, cwd, "Shell", "shell");
    this.renderTabBar();
  }

  private async spawnClaude(): Promise<void> {
    await this.spawnClaudeSession({ sessionType: "claude" });
  }

  private async spawnClaudeWithContext(): Promise<void> {
    await this.spawnClaudeSession({ sessionType: "claude-with-context" });
  }

  async spawnClaudeWithPrompt(prompt: string, label?: string): Promise<void> {
    await this.spawnClaudeSession({
      sessionType: "claude-with-context",
      prompt,
      label: label || "Claude (ctx)",
    });
  }

  async resumeSession(persisted: PersistedSession, itemId?: string): Promise<void> {
    const fresh = await this.loadFreshSettings();
    const targetItemId = itemId || this.tabManager.getActiveItemId();
    if (!targetItemId) return;
    const isCopilot =
      persisted.sessionType === "copilot" || persisted.sessionType === "copilot-with-context";
    const command = isCopilot
      ? this.getStringSetting(fresh, "core.copilotCommand", "copilot")
      : this.getStringSetting(fresh, "core.claudeCommand", "claude");
    const resolved = resolveCommand(command);
    const args = isCopilot
      ? [`--resume=${persisted.claudeSessionId}`]
      : ["--resume", persisted.claudeSessionId];
    const extraArgs = isCopilot
      ? this.getStringSetting(fresh, "core.copilotExtraArgs", "")
      : this.getStringSetting(fresh, "core.claudeExtraArgs", "");

    if (extraArgs) {
      args.unshift(...String(extraArgs).split(/\s+/).filter(Boolean));
    }

    const cwd = expandTilde(this.getStringSetting(fresh, "core.defaultTerminalCwd", "~"));
    const tab = this.tabManager.createTabForItem(
      targetItemId,
      resolved,
      cwd,
      persisted.label,
      persisted.sessionType,
      undefined,
      [resolved, ...args],
      persisted.claudeSessionId,
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
          // Successful resume - remove from persisted list and sync to disk
          this.persistedSessions = this.persistedSessions.filter(
            (s) => s.claudeSessionId !== persisted.claudeSessionId,
          );
          this.persistSessions().catch(() => {});
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
    await this.checkHookWarning();
  }

  async persistSessions(): Promise<void> {
    await this.updatePluginData(async (data) => {
      SessionPersistence.setPersistedSessions(data, this.tabManager.getSessions());
    });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  setActiveItem(itemId: string | null): void {
    this.tabManager.setActiveItem(itemId);
    this.renderTabBar();
  }

  setTitle(title: string | null): void {
    if (title) {
      this.titleEl.textContent = title;
      this.titleEl.style.display = "block";
    } else {
      this.titleEl.textContent = "";
      this.titleEl.style.display = "none";
    }
  }

  async getClaudeContextPrompt(item: WorkItem): Promise<string | null> {
    const fresh = await this.loadFreshSettings();
    return buildClaudeContextPrompt(item, fresh);
  }

  private async updatePluginData(
    update: (data: Record<string, any>) => void | Promise<void>,
  ): Promise<void> {
    const run = async () => {
      const data = ((await this.plugin.loadData()) || {}) as Record<string, any>;
      await update(data);
      await this.plugin.saveData(data);
    };
    const queued = this.pluginDataWrite.then(run, run);
    this.pluginDataWrite = queued.catch(() => {});
    return queued;
  }

  private getActiveItem(): WorkItem | null {
    const activeItemId = this.tabManager.getActiveItemId();
    if (!activeItemId) return null;
    return this.allItems.find((item) => item.id === activeItemId) || null;
  }

  private mergeExtraArgs(baseArgs: string, extraArgs: string): string {
    return [baseArgs.trim(), extraArgs.trim()].filter(Boolean).join(" ");
  }

  private async loadCustomSessionDefaults(
    itemId: string,
    freshSettings: Record<string, unknown>,
  ): Promise<CustomSessionConfig> {
    const data = (await this.plugin.loadData()) || {};
    const saved = data.customSessionDefaults?.[itemId];
    const defaultCwd = this.getStringSetting(freshSettings, "core.defaultTerminalCwd", "~");
    return sanitizeCustomSessionConfig(saved, defaultCwd);
  }

  private async saveCustomSessionDefaults(
    itemId: string,
    config: CustomSessionConfig,
  ): Promise<void> {
    await this.updatePluginData(async (data) => {
      if (!data.customSessionDefaults) data.customSessionDefaults = {};
      data.customSessionDefaults[itemId] = config;
    });
  }

  private async openCustomSessionModal(): Promise<void> {
    const item = this.getActiveItem();
    if (!item) {
      new Notice(`Select a ${this.adapter.config.itemName} first to launch a custom session`);
      return;
    }

    const fresh = await this.loadFreshSettings();
    const initial = await this.loadCustomSessionDefaults(item.id, fresh);
    new CustomSessionModal(this.plugin.app, initial, (config) => {
      void this.spawnCustomSession(item, config);
    }).open();
  }

  private async spawnCustomSession(item: WorkItem, rawConfig: CustomSessionConfig): Promise<void> {
    const fresh = await this.loadFreshSettings();
    const defaultCwd = this.getStringSetting(fresh, "core.defaultTerminalCwd", "~");
    const config = sanitizeCustomSessionConfig(rawConfig, defaultCwd);
    const prompt = isContextSession(config.sessionType)
      ? await this.getClaudeContextPrompt(item)
      : undefined;

    if (isContextSession(config.sessionType) && !prompt) {
      new Notice("Set 'Context prompt template' in settings to use contextual sessions");
      return;
    }

    await this.saveCustomSessionDefaults(item.id, config);

    if (config.sessionType === "shell") {
      const shell = this.getStringSetting(
        fresh,
        "core.defaultShell",
        process.env.SHELL || "/bin/zsh",
      );
      this.tabManager.createTab(
        shell,
        expandTilde(config.cwd),
        config.label || getDefaultSessionLabel(config.sessionType),
        "shell",
      );
      this.renderTabBar();
      return;
    }

    if (isCopilotSession(config.sessionType)) {
      await this.spawnCopilotSession({
        sessionType: config.sessionType,
        cwd: config.cwd,
        extraArgs: config.extraArgs,
        label: config.label || getDefaultSessionLabel(config.sessionType),
        prompt,
      });
      return;
    }

    if (isStrandsSession(config.sessionType)) {
      await this.spawnStrandsSession({
        sessionType: config.sessionType,
        cwd: config.cwd,
        extraArgs: config.extraArgs,
        label: config.label || getDefaultSessionLabel(config.sessionType),
        prompt,
      });
      return;
    }

    await this.spawnClaudeSession({
      sessionType: config.sessionType as "claude" | "claude-with-context",
      cwd: config.cwd,
      extraArgs: config.extraArgs,
      label: config.label || getDefaultSessionLabel(config.sessionType),
      prompt,
    });
  }

  private async spawnClaudeSession(options: {
    sessionType: "claude" | "claude-with-context";
    cwd?: string;
    extraArgs?: string;
    label?: string;
    prompt?: string;
  }): Promise<void> {
    let prompt = options.prompt;
    if (options.sessionType === "claude-with-context" && !prompt) {
      const item = this.getActiveItem();
      if (!item) {
        new Notice(`Select a ${this.adapter.config.itemName} first to launch Claude with context`);
        return;
      }
      prompt = await this.getClaudeContextPrompt(item);
      if (!prompt) {
        new Notice("Set 'Context prompt template' in settings to use contextual sessions");
        return;
      }
    }

    const fresh = await this.loadFreshSettings();
    const claudeCmd = this.getStringSetting(fresh, "core.claudeCommand", "claude");
    const resolved = resolveCommand(claudeCmd);
    const sessionId = crypto.randomUUID();
    const mergedExtraArgs = this.mergeExtraArgs(
      this.getStringSetting(fresh, "core.claudeExtraArgs", ""),
      options.extraArgs || "",
    );
    const args = buildClaudeArgs({ claudeExtraArgs: mergedExtraArgs }, sessionId, prompt);
    const cwd = expandTilde(
      options.cwd || this.getStringSetting(fresh, "core.defaultTerminalCwd", "~"),
    );
    const label = options.label || getDefaultSessionLabel(options.sessionType);
    const tab = this.tabManager.createTab(
      resolved,
      cwd,
      label,
      options.sessionType,
      undefined,
      [resolved, ...args],
      sessionId,
    );
    if (tab && this.adapter.transformSessionLabel) {
      tab.transformLabel = (old, detected) => this.adapter.transformSessionLabel!(old, detected);
    }
    this.renderTabBar();
  }

  private async spawnCopilotSession(options: {
    sessionType: "copilot" | "copilot-with-context";
    cwd?: string;
    extraArgs?: string;
    label?: string;
    prompt?: string;
  }): Promise<void> {
    const fresh = await this.loadFreshSettings();
    const copilotCmd = this.getStringSetting(fresh, "core.copilotCommand", "copilot");
    const resolved = resolveCommand(copilotCmd);
    const sessionId = crypto.randomUUID();
    const mergedExtraArgs = this.mergeExtraArgs(
      this.getStringSetting(fresh, "core.copilotExtraArgs", ""),
      options.extraArgs || "",
    );
    const args = [
      `--resume=${sessionId}`,
      ...buildCopilotArgs({ copilotExtraArgs: mergedExtraArgs }, options.prompt),
    ];
    const cwd = expandTilde(
      options.cwd || this.getStringSetting(fresh, "core.defaultTerminalCwd", "~"),
    );
    const label = options.label || getDefaultSessionLabel(options.sessionType);
    this.tabManager.createTab(
      resolved,
      cwd,
      label,
      options.sessionType,
      undefined,
      [resolved, ...args],
      sessionId,
    );
    this.renderTabBar();
  }

  private async spawnStrandsSession(options: {
    sessionType: "strands" | "strands-with-context";
    cwd?: string;
    extraArgs?: string;
    label?: string;
    prompt?: string;
  }): Promise<void> {
    const fresh = await this.loadFreshSettings();
    const strandsCmd = expandTilde(this.getStringSetting(fresh, "core.strandsCommand", "strands"));
    const [cmdToken, ...cmdArgs] = strandsCmd.trim().split(/\s+/);
    const resolved = resolveCommand(cmdToken);
    const mergedExtraArgs = this.mergeExtraArgs(
      this.getStringSetting(fresh, "core.strandsExtraArgs", ""),
      options.extraArgs || "",
    );
    const args = buildStrandsArgs({ strandsExtraArgs: mergedExtraArgs }, options.prompt);
    const cwd = expandTilde(
      options.cwd || this.getStringSetting(fresh, "core.defaultTerminalCwd", "~"),
    );
    const label = options.label || getDefaultSessionLabel(options.sessionType);
    this.tabManager.createTab(resolved, cwd, label, options.sessionType, undefined, [
      resolved,
      ...cmdArgs,
      ...args,
    ]);
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
    this.stopPeriodicPersist?.();
    this.stopPeriodicPersist = null;
    this.stopHookWarningPoller();
    this.tabManager.stashAll();
  }

  disposeAll(): void {
    this.stopPeriodicPersist?.();
    this.stopPeriodicPersist = null;
    this.stopHookWarningPoller();
    this.tabManager.disposeAll();
  }

  setItems(items: WorkItem[]): void {
    this.allItems = items;
  }

  getClaudeState(itemId: string): ClaudeState {
    return this.tabManager.getClaudeState(itemId);
  }
}
