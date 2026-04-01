/**
 * TerminalPanelView - wraps TabManager with terminal launch buttons,
 * custom session spawning, state aggregation, session resume, tab context
 * menu, and inline rename.
 */
import { Menu, Notice } from "obsidian";

import type { Plugin } from "obsidian";
import { TabManager } from "../core/terminal/TabManager";
import type { TerminalTab, AgentState } from "../core/terminal/TerminalTab";
import {
  buildMissingCliNotice,
  resolveCommand,
  resolveCommandInfo,
  splitConfiguredCommand,
  buildClaudeArgs,
  buildCopilotArgs,
  buildStrandsArgs,
  mergeExtraArgs,
  parseExtraArgs,
} from "../core/agents/AgentLauncher";
import { SessionPersistence, PERSIST_INTERVAL_MS } from "../core/session/SessionPersistence";
import { SessionStore } from "../core/session/SessionStore";
import { isResumableSessionType } from "../core/session/types";
import type {
  ActiveTabInfo,
  AgentRuntimeState,
  DurableRecoveryMode,
  PersistedSession,
  SessionType,
  TabDiagnostics,
} from "../core/session/types";
import { electronRequire, expandTilde } from "../core/utils";
import { checkHookStatus } from "../core/claude/ClaudeHookManager";
import type { AdapterBundle, WorkItem, WorkItemPromptBuilder } from "../core/interfaces";
import { mergeAndSavePluginData } from "../core/PluginDataStore";
import { buildAgentContextPrompt } from "./AgentContextPrompt";
import { ProfileLaunchModal, type ProfileLaunchOverrides } from "./ProfileLaunchModal";
import { RecentlyClosedStore, type ClosedSessionEntry } from "../core/session/RecentlyClosedStore";
import { SETTINGS_CHANGED_EVENT } from "./SettingsTab";
import { getDefaultSessionLabel, isClaudeSession } from "./CustomSessionConfig";
import type { AgentProfileManager } from "../core/agents/AgentProfileManager";
import { PROFILES_CHANGED_EVENT } from "../core/agents/AgentProfileManager";
import type { AgentProfile } from "../core/agents/AgentProfile";
import { agentTypeToSessionType } from "../core/agents/AgentProfile";
import { createProfileIcon } from "../ui/ProfileIcons";

interface WorkTerminalDebugSnapshot {
  version: 1;
  activeItemId: string | null;
  activeTabIndex: number;
  activeTabs: ActiveTabInfo[];
  activeSessionIds: string[];
  persistedSessions: PersistedSession[];
  hasHotReloadStore: boolean;
}

interface WorkTerminalDebugApi extends WorkTerminalDebugSnapshot {
  getSnapshot(): WorkTerminalDebugSnapshot;
  getAllActiveTabs(): ActiveTabInfo[];
  findTabsByLabel(label: string): ActiveTabInfo[];
  getActiveSessionIds(): string[];
  getPersistedSessions(itemId?: string): PersistedSession[];
  getSessionDiagnostics(): WorkTerminalSessionDiagnosticsSnapshot;
}

interface DiagnosticsSummary {
  activeItemId: string | null;
  activeTabIndex: number;
  activeItemCount: number;
  activeTabCount: number;
  persistedSessionCount: number;
  recentlyClosedCount: number;
  hasHotReloadStore: boolean;
  derivedCounts: {
    blankButLiveRenderer: number;
    staleDisposedWebglOwnership: number;
    missingPersistedMetadata: number;
    liveNonResumableSessions: number;
    disposedTabStillSelected: number;
  };
}

interface DiagnosticsItemSnapshot {
  itemId: string;
  isActiveItem: boolean;
  activeTabIndex: number;
  aggregateState: AgentRuntimeState;
  idleSince: number | null;
  sessionCounts: { shells: number; agents: number };
  tabs: TabDiagnostics[];
}

interface WorkTerminalSessionDiagnosticsSnapshot {
  version: 1;
  generatedAt: string;
  summary: DiagnosticsSummary;
  items: DiagnosticsItemSnapshot[];
  persistedSessions: PersistedSession[];
  recentlyClosedSessions: Array<
    ClosedSessionEntry & {
      recoveryAvailable: boolean;
    }
  >;
}

const DEBUG_API_OWNER = Symbol("work-terminal-debug-owner");
const debugApiOwners = new Set<TerminalPanelView>();
const liveTerminalViews = new Set<TerminalPanelView>();

type OwnedWorkTerminalDebugApi = WorkTerminalDebugApi & {
  [DEBUG_API_OWNER]: TerminalPanelView;
};

declare global {
  interface Window {
    __workTerminalDebug?: WorkTerminalDebugApi;
  }
}

export class TerminalPanelView {
  private tabManager: TabManager;
  private plugin: Plugin;
  private adapter: AdapterBundle;
  private settings: Record<string, any>;
  private promptBuilder: WorkItemPromptBuilder;
  private onAgentStateChange: (itemId: string, state: string) => void;
  private onSessionChange: () => void;

  // DOM elements
  private panelEl: HTMLElement;
  private titleEl: HTMLElement;
  private tabBarEl: HTMLElement;
  private terminalWrapperEl: HTMLElement;

  // Persisted sessions from disk
  private persistedSessions: PersistedSession[] = [];
  private pendingPersistedSessions: PersistedSession[] = [];
  private durablePersistedSessions: PersistedSession[] = [];

  // Active items reference (for tab context menu "Move to Item")
  private allItems: WorkItem[] = [];

  // Active inline rename input, if any
  private activeRenameInput: HTMLInputElement | null = null;

  // Delayed click timer for tab switching (cancelled on double-click)
  private tabClickTimer: ReturnType<typeof setTimeout> | null = null;

  // Periodic persist stop function
  private stopPeriodicPersist: (() => void) | null = null;

  // Recently closed sessions store
  private recentlyClosedStore = RecentlyClosedStore.createWindowScoped();

  // Hook warning banner element
  private hookWarningEl: HTMLElement | null = null;

  // Interval ID for hook-status polling while warning is visible
  private hookWarningPollId: ReturnType<typeof setInterval> | null = null;

  // In-flight guard to prevent overlapping async checkHookWarning() calls
  private hookWarningCheckInFlight = false;
  private hookWarningCheckQueued = false;
  private isDisposed = false;
  private profileManager: AgentProfileManager | null = null;
  private tabBarResizeObserver: ResizeObserver | null = null;
  private readonly handleSettingsChanged = (event: Event) => {
    this.settings = { ...(event as CustomEvent<Record<string, any>>).detail };
    this.renderTabBar();
    this.refreshDebugGlobal();
  };
  private readonly handleProfilesChanged = () => {
    this.renderTabBar();
  };

  constructor(
    panelEl: HTMLElement,
    terminalWrapperEl: HTMLElement,
    plugin: Plugin,
    adapter: AdapterBundle,
    settings: Record<string, any>,
    promptBuilder: WorkItemPromptBuilder,
    onAgentStateChange: (itemId: string, state: string) => void,
    onSessionChange: () => void,
    profileManager?: AgentProfileManager,
  ) {
    this.panelEl = panelEl;
    this.terminalWrapperEl = terminalWrapperEl;
    this.plugin = plugin;
    this.adapter = adapter;
    this.settings = settings;
    this.promptBuilder = promptBuilder;
    this.onAgentStateChange = onAgentStateChange;
    this.onSessionChange = onSessionChange;
    this.profileManager = profileManager ?? null;
    liveTerminalViews.add(this);
    window.addEventListener(SETTINGS_CHANGED_EVENT, this.handleSettingsChanged as EventListener);
    window.addEventListener(PROFILES_CHANGED_EVENT, this.handleProfilesChanged as EventListener);

    // Task title heading above tab bar
    this.titleEl = panelEl.createDiv({ cls: "wt-task-title" });
    panelEl.insertBefore(this.titleEl, terminalWrapperEl);

    // Tab bar at top of panel
    this.tabBarEl = panelEl.createDiv({
      cls: "wt-tab-bar",
      attr: { "data-wt-tour": "tab-bar" },
    });
    // Move tab bar before terminal wrapper
    panelEl.insertBefore(this.tabBarEl, terminalWrapperEl);

    // Initialize TabManager
    this.tabManager = new TabManager(terminalWrapperEl, this.resolvePluginDir());
    this.tabManager.onSessionChange = () => {
      this.refreshDebugGlobal();
      this.renderTabBar();
      void this.checkHookWarning();
      this.onSessionChange();
    };
    this.tabManager.onAgentStateChange = (itemId: string, state: AgentState) => {
      this.onAgentStateChange(itemId, state);
      this.updateTabStateClasses();
    };
    this.tabManager.onPersistRequest = () => {
      void this.persistSessions().catch((error) => {
        console.error("[work-terminal] Failed to persist sessions:", error);
      });
    };
    this.tabManager.onTabClosed = (itemId, tab) => {
      const entry = this.buildClosedSessionEntry(itemId, tab);
      if (!entry) return;
      this.recentlyClosedStore.add(entry);
      this.removePersistedSessionForClosedEntry(entry);
      this.syncRecentlyClosedState();
      void this.persistRecentlyClosedSessions();
    };

    // Load durable recovery state from disk
    this.fireAndForget("load persisted sessions", () => this.loadPersistedSessions());
    this.fireAndForget("load recently closed sessions", () => this.loadRecentlyClosedSessions());

    // Start periodic disk persist as safety net (every 30s)
    this.stopPeriodicPersist = SessionPersistence.startPeriodicPersist(
      () => this.persistSessions(),
      PERSIST_INTERVAL_MS,
    );

    // Initial tab bar render
    this.renderTabBar();
    this.refreshDebugGlobal();

    // Check hook status and show warning banner if needed
    this.fireAndForget("check hook warning", () => this.checkHookWarning());
  }

  // ---------------------------------------------------------------------------
  // Hook warning banner
  // ---------------------------------------------------------------------------

  private async checkHookWarning(): Promise<void> {
    if (this.isDisposed) return;
    if (this.hookWarningCheckInFlight) {
      this.hookWarningCheckQueued = true;
      return;
    }
    this.hookWarningCheckInFlight = true;
    try {
      const fresh = ((await this.plugin.loadData()) || {}).settings || {};
      if (this.isDisposed) return;
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
            await mergeAndSavePluginData(this.plugin, async (data) => {
              if (!data.settings) data.settings = {};
              data.settings["core.acceptNoResumeHooks"] = true;
            });
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

    return (
      this.persistedSessions.some(
        (session) => session.recoveryMode === "resume" && isClaudeSession(session.sessionType),
      ) ||
      this.recentlyClosedStore
        .serialize()
        .some((entry) => entry.recoveryMode === "resume" && isClaudeSession(entry.sessionType))
    );
  }

  // ---------------------------------------------------------------------------
  // Tab bar rendering
  // ---------------------------------------------------------------------------

  private renderTabBar(): void {
    this.tabBarEl.empty();

    const tabsContainer = this.tabBarEl.createDiv({ cls: "wt-tabs-container" });
    const buttonsContainer = this.tabBarEl.createDiv({
      cls: "wt-tab-buttons",
      attr: { "data-wt-tour": "launch-buttons" },
    });

    const activeItemId = this.tabManager.getActiveItemId();
    if (activeItemId) {
      const tabs = this.tabManager.getTabs(activeItemId);
      const activeIdx = this.tabManager.getActiveTabIndex();

      for (let i = 0; i < tabs.length; i++) {
        const tab = tabs[i];
        const tabEl = tabsContainer.createDiv({ cls: "wt-tab" });
        if (i === activeIdx) tabEl.addClass("wt-tab-active");
        if (tab.isResumableAgent) {
          const state = tab.agentState;
          if (state !== "inactive") tabEl.addClass(`wt-tab-agent-${state}`);
        }
        tabEl.setAttribute("draggable", "true");
        tabEl.setAttribute("data-tab-index", String(i));

        // Profile color triangle indicator
        if (tab.profileColor) {
          const triangle = tabEl.createDiv({ cls: "wt-tab-color-indicator" });
          triangle.style.borderTopColor = tab.profileColor;
          triangle.style.borderLeftColor = tab.profileColor;
        }

        // Tab label
        const labelEl = tabEl.createSpan({ cls: "wt-tab-label", text: tab.label });

        // Click to switch (delayed to allow double-click cancellation)
        tabEl.addEventListener("click", (event) => {
          if (this.isRenameActive()) return;
          if (i === activeIdx) return;
          if ((event as MouseEvent).detail > 1) return;
          if (this.tabClickTimer !== null) {
            clearTimeout(this.tabClickTimer);
            this.tabClickTimer = null;
          }
          this.tabClickTimer = setTimeout(() => {
            this.tabClickTimer = null;
            this.tabManager.switchToTab(i);
            this.renderTabBar();
          }, 250);
        });

        // Double-click to rename (cancels pending click)
        labelEl.addEventListener("dblclick", (e) => {
          e.stopPropagation();
          if (this.tabClickTimer !== null) {
            clearTimeout(this.tabClickTimer);
            this.tabClickTimer = null;
          }
          // Switch to the target tab first without re-rendering
          if (i !== activeIdx) {
            const currentActive = tabEl.parentElement?.querySelector(".wt-tab-active");
            if (currentActive) currentActive.removeClass("wt-tab-active");
            tabEl.addClass("wt-tab-active");
            this.tabManager.switchToTab(i);
          }
          this.startTabRename(tabEl, labelEl, tab, i);
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

    // Spawn buttons
    const shellBtn = buttonsContainer.createEl("button", { cls: "wt-spawn-btn", text: "+ Shell" });
    shellBtn.addEventListener("click", () => {
      this.launchAction("shell", () => this.spawnShell());
    });

    // Profile-driven agent buttons
    const buttonProfiles = this.profileManager?.getButtonProfiles() ?? [];
    for (const profile of buttonProfiles) {
      const btn = buttonsContainer.createEl("button", {
        cls: "wt-spawn-btn wt-spawn-profile",
      });

      // Apply button styling
      if (profile.button.color) {
        btn.style.borderColor = profile.button.color;
        btn.style.color = profile.button.color;
      }
      if (profile.button.borderStyle) {
        if (profile.button.borderStyle === "thick") {
          btn.style.borderStyle = "solid";
          btn.style.borderWidth = "2px";
        } else {
          btn.style.borderStyle = profile.button.borderStyle;
        }
      }

      // Icon
      const icon = createProfileIcon(profile.button.icon);
      if (icon) {
        if (profile.button.color) icon.style.color = profile.button.color;
        btn.appendChild(icon);
      }

      // Label
      const label = profile.button.label || profile.name;
      btn.appendText(label);

      btn.setAttribute("aria-label", `Launch ${profile.name}`);
      btn.setAttribute("title", profile.name);

      btn.addEventListener("click", () => {
        this.launchAction(profile.name, () => this.spawnFromProfile(profile));
      });
    }

    const customBtn = buttonsContainer.createEl("button", {
      cls: "wt-spawn-btn wt-spawn-custom",
      text: "...",
      attr: { "data-wt-tour": "custom-session-button" },
    });
    customBtn.setAttribute("aria-label", "Launch profile");
    customBtn.setAttribute("title", "Launch profile");
    customBtn.addEventListener("click", () => {
      this.launchAction("profile launch", () => this.openProfileLaunchModal());
    });

    // Detect overflow: when tabs compete with buttons for space, switch to expanded layout
    this.setupTabBarOverflowDetection(tabsContainer, buttonsContainer);
  }

  /**
   * Monitor tab bar for overflow and toggle expanded layout when tabs crowd buttons.
   * Uses a ResizeObserver so the layout adapts responsively without fixed breakpoints.
   */
  private setupTabBarOverflowDetection(
    tabsContainer: HTMLElement,
    buttonsContainer: HTMLElement,
  ): void {
    // Clean up previous observer
    this.tabBarResizeObserver?.disconnect();
    this.tabBarResizeObserver = null;

    const checkOverflow = () => {
      const tabEls = tabsContainer.querySelectorAll(".wt-tab");
      if (tabEls.length === 0) {
        this.tabBarEl.removeClass("wt-tab-bar-expanded");
        return;
      }

      // Temporarily remove expanded class so tabs return to natural inline size
      // for accurate measurement (expanded mode sets max-width: none + column layout)
      const wasExpanded = this.tabBarEl.classList.contains("wt-tab-bar-expanded");
      if (wasExpanded) {
        this.tabBarEl.removeClass("wt-tab-bar-expanded");
      }

      // Measure total width of all tabs (natural size)
      let totalTabWidth = 0;
      for (const tab of Array.from(tabEls)) {
        totalTabWidth += (tab as HTMLElement).offsetWidth;
      }
      // Add gaps between tabs
      totalTabWidth += (tabEls.length - 1) * 4;

      const barWidth = this.tabBarEl.offsetWidth;
      const buttonsWidth = buttonsContainer.offsetWidth;

      // Switch to expanded layout when tabs would use more than the space left by buttons
      const shouldExpand = totalTabWidth > barWidth - buttonsWidth - 20;
      this.tabBarEl.toggleClass("wt-tab-bar-expanded", shouldExpand);
    };

    // Check immediately after render
    checkOverflow();

    // Re-check on resize
    this.tabBarResizeObserver = new ResizeObserver(checkOverflow);
    this.tabBarResizeObserver.observe(this.tabBarEl);
  }

  /** Update agent state classes on existing tab elements without full re-render. */
  private updateTabStateClasses(): void {
    const activeItemId = this.tabManager.getActiveItemId();
    if (!activeItemId) return;
    const tabs = this.tabManager.getTabs(activeItemId);
    const tabEls = this.tabBarEl.querySelectorAll(".wt-tab");
    const stateClasses = ["wt-tab-agent-waiting", "wt-tab-agent-active", "wt-tab-agent-idle"];
    for (let i = 0; i < tabs.length && i < tabEls.length; i++) {
      const el = tabEls[i] as HTMLElement;
      for (const cls of stateClasses) el.removeClass(cls);
      if (tabs[i].isResumableAgent) {
        const state = tabs[i].agentState;
        if (state !== "inactive") el.addClass(`wt-tab-agent-${state}`);
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

  private isRenameActive(): boolean {
    return this.activeRenameInput?.isConnected === true;
  }

  private startTabRename(
    tabEl: HTMLElement,
    labelEl: HTMLElement,
    tab: TerminalTab,
    _index: number,
  ): void {
    const input = document.createElement("input");
    this.activeRenameInput = input;
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
      if (this.activeRenameInput === input) {
        this.activeRenameInput = null;
      }
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
        if (this.activeRenameInput === input) {
          this.activeRenameInput = null;
        }
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

    if (isClaudeSession(tab.sessionType)) {
      menu.addItem((item) => {
        item.setTitle("Restart").onClick(() => {
          this.launchAction("Claude restart", () => this.restartClaudeTab(tab, index));
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
    this.onAgentStateChange(currentItemId, this.tabManager.getAgentState(currentItemId));
    this.onAgentStateChange(targetItemId, this.tabManager.getAgentState(targetItemId));
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

  private launchAction(actionLabel: string, launch: () => Promise<void>): void {
    void launch().catch((error: unknown) => {
      console.error(`[work-terminal] Failed to launch ${actionLabel}`, error);
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Failed to launch ${actionLabel}: ${message}`);
    });
  }

  private buildClosedSessionEntry(itemId: string, tab: TerminalTab): ClosedSessionEntry | null {
    if (tab.isResumableAgent && tab.claudeSessionId) {
      return {
        sessionType: tab.sessionType,
        label: tab.label,
        claudeSessionId: tab.claudeSessionId,
        durableSessionId: tab.durableSessionId ?? undefined,
        closedAt: Date.now(),
        itemId,
        recoveryMode: "resume",
        cwd: tab.launchCwd,
        command: tab.launchCommandArgs?.[0] || tab.launchShell,
        commandArgs: tab.launchCommandArgs,
        profileColor: tab.profileColor,
      };
    }

    const command = tab.launchCommandArgs?.[0] || tab.launchShell;
    if (!command || !tab.launchCwd) {
      return null;
    }

    return {
      sessionType: tab.sessionType,
      label: tab.label,
      claudeSessionId: null,
      durableSessionId: tab.durableSessionId ?? undefined,
      closedAt: Date.now(),
      itemId,
      recoveryMode: "relaunch",
      cwd: tab.launchCwd,
      command,
      commandArgs: tab.launchCommandArgs,
      profileColor: tab.profileColor,
    };
  }

  private matchesRecoverySession(
    tab: TerminalTab,
    session: Pick<
      PersistedSession | ClosedSessionEntry,
      | "sessionType"
      | "label"
      | "claudeSessionId"
      | "durableSessionId"
      | "durableSessionIdGenerated"
      | "recoveryMode"
      | "cwd"
      | "command"
      | "commandArgs"
    >,
  ): boolean {
    if (tab.sessionType !== session.sessionType) {
      return false;
    }

    if (session.recoveryMode === "resume") {
      return !!session.claudeSessionId && tab.claudeSessionId === session.claudeSessionId;
    }

    if (session.durableSessionId && tab.durableSessionId) {
      if (session.durableSessionId === tab.durableSessionId) {
        return true;
      }
      if (!session.durableSessionIdGenerated) {
        return false;
      }
    }

    const tabCommand = tab.launchCommandArgs?.[0] || tab.launchShell;
    const tabArgs = tab.launchCommandArgs || [];
    const sessionArgs = session.commandArgs || [];
    return (
      tab.launchCwd === session.cwd &&
      tabCommand === session.command &&
      tab.label === session.label &&
      tabArgs.length === sessionArgs.length &&
      tabArgs.every((arg, index) => arg === sessionArgs[index])
    );
  }

  private adoptSynthesizedDurableSessionIds(sessions: PersistedSession[]): void {
    const claimedTabIds = new Set<string>();
    for (const session of sessions) {
      if (
        session.recoveryMode !== "relaunch" ||
        !session.durableSessionIdGenerated ||
        !session.durableSessionId
      ) {
        continue;
      }

      const matchingTab = this.tabManager.getTabs(session.taskPath).find(
        (tab) =>
          !claimedTabIds.has(tab.id) &&
          this.matchesRecoverySession(tab, {
            sessionType: session.sessionType,
            label: session.label,
            claudeSessionId: session.claudeSessionId,
            durableSessionId: undefined,
            durableSessionIdGenerated: undefined,
            recoveryMode: session.recoveryMode,
            cwd: session.cwd,
            command: session.command,
            commandArgs: session.commandArgs,
          }),
      );
      if (matchingTab) {
        claimedTabIds.add(matchingTab.id);
        matchingTab.durableSessionId = session.durableSessionId;
        session.durableSessionIdGenerated = undefined;
      }
    }
  }

  private findPersistedSessionTabAcrossViews(
    session: PersistedSession,
    claimedTabs: Set<TerminalTab>,
    candidate: Pick<
      PersistedSession,
      | "sessionType"
      | "label"
      | "claudeSessionId"
      | "durableSessionId"
      | "durableSessionIdGenerated"
      | "recoveryMode"
      | "cwd"
      | "command"
      | "commandArgs"
    >,
  ): TerminalTab | null {
    const views = Array.from(liveTerminalViews).filter((view) => !view.isDisposed);
    for (const view of views) {
      const matchingTab = view.tabManager
        .getTabs(session.taskPath)
        .find((tab) => !claimedTabs.has(tab) && view.matchesRecoverySession(tab, candidate));
      if (matchingTab) {
        return matchingTab;
      }
    }
    return null;
  }

  private findPersistedSessionExactMatchAcrossViews(
    session: PersistedSession,
    claimedTabs: Set<TerminalTab>,
  ): TerminalTab | null {
    if (session.recoveryMode === "relaunch" && session.durableSessionId) {
      const views = Array.from(liveTerminalViews).filter((view) => !view.isDisposed);
      for (const view of views) {
        const matchingTab = view.tabManager
          .getTabs(session.taskPath)
          .find(
            (tab) =>
              !claimedTabs.has(tab) &&
              tab.sessionType === session.sessionType &&
              tab.durableSessionId === session.durableSessionId,
          );
        if (matchingTab) {
          return matchingTab;
        }
      }
      return null;
    }

    return this.findPersistedSessionTabAcrossViews(session, claimedTabs, session);
  }

  private findPersistedSessionFallbackMatchAcrossViews(
    session: PersistedSession,
    claimedTabs: Set<TerminalTab>,
  ): TerminalTab | null {
    return this.findPersistedSessionTabAcrossViews(session, claimedTabs, {
      sessionType: session.sessionType,
      label: session.label,
      claudeSessionId: session.claudeSessionId,
      durableSessionId: undefined,
      durableSessionIdGenerated: undefined,
      recoveryMode: session.recoveryMode,
      cwd: session.cwd,
      command: session.command,
      commandArgs: session.commandArgs,
    });
  }

  private applyPersistedSessionState(persistedSessions: PersistedSession[]): void {
    this.persistedSessions = persistedSessions.map((session) => ({
      ...session,
      commandArgs: session.commandArgs ? [...session.commandArgs] : undefined,
    }));
    this.durablePersistedSessions = this.persistedSessions.map((session) => ({
      ...session,
      commandArgs: session.commandArgs ? [...session.commandArgs] : undefined,
    }));
    this.recalculatePendingPersistedSessions();
    this.refreshDebugGlobal();
  }

  private recalculatePendingPersistedSessions(): void {
    const claimedTabs = new Set<TerminalTab>();
    const pendingGeneratedAliases: PersistedSession[] = [];
    const pendingSessions: PersistedSession[] = [];

    for (const session of this.persistedSessions) {
      const exactMatch = this.findPersistedSessionExactMatchAcrossViews(session, claimedTabs);
      if (exactMatch) {
        claimedTabs.add(exactMatch);
        continue;
      }

      if (
        session.recoveryMode === "relaunch" &&
        session.durableSessionIdGenerated &&
        session.durableSessionId
      ) {
        pendingGeneratedAliases.push(session);
        continue;
      }

      const fallbackMatch = this.findPersistedSessionTabAcrossViews(session, claimedTabs, session);
      if (fallbackMatch) {
        claimedTabs.add(fallbackMatch);
        continue;
      }

      pendingSessions.push(session);
    }

    for (const session of pendingGeneratedAliases) {
      const fallbackMatch = this.findPersistedSessionFallbackMatchAcrossViews(session, claimedTabs);
      if (fallbackMatch) {
        claimedTabs.add(fallbackMatch);
        continue;
      }

      pendingSessions.push(session);
    }

    this.pendingPersistedSessions = pendingSessions;
  }

  private syncPersistedSessionState(persistedSessions: PersistedSession[]): void {
    for (const view of liveTerminalViews) {
      if (!view.isDisposed) {
        view.applyPersistedSessionState(persistedSessions);
      }
    }
  }

  private getLiveSessionsAcrossViews(): Map<string, TerminalTab[]> {
    const sessions = new Map<string, TerminalTab[]>();
    for (const view of liveTerminalViews) {
      if (view.isDisposed) {
        continue;
      }
      for (const [itemId, tabs] of view.tabManager.getSessions()) {
        const existingTabs = sessions.get(itemId) || [];
        sessions.set(itemId, [...existingTabs, ...tabs]);
      }
    }
    return sessions;
  }

  private fireAndForget(taskName: string, task: () => Promise<void>): void {
    void task().catch((error) => {
      console.error(`[work-terminal] Failed to ${taskName}:`, error);
    });
  }

  private getSavedResumeLaunchContext(
    session: Pick<
      PersistedSession | ClosedSessionEntry,
      "sessionType" | "cwd" | "command" | "commandArgs"
    >,
  ): {
    cwd?: string;
    resolvedCommand?: string;
    extraArgs?: string[];
  } {
    const resolvedCommand = session.commandArgs?.[0] || session.command;
    const extraArgs = session.commandArgs
      ? this.extractResumeExtraArgs(session.sessionType, session.commandArgs)
      : resolvedCommand || session.cwd
        ? []
        : undefined;

    return {
      cwd: session.cwd,
      resolvedCommand,
      extraArgs,
    };
  }

  private isPersistedSessionActive(session: PersistedSession): boolean {
    return this.tabManager
      .getTabs(session.taskPath)
      .some((tab) => this.matchesRecoverySession(tab, session));
  }

  private isClosedSessionActive(entry: ClosedSessionEntry): boolean {
    return this.tabManager
      .getTabs(entry.itemId)
      .some((tab) => this.matchesRecoverySession(tab, entry));
  }

  private isClosedSessionActiveAcrossViews(entry: ClosedSessionEntry): boolean {
    return Array.from(liveTerminalViews).some((view) =>
      view.tabManager.getTabs(entry.itemId).some((tab) => view.matchesRecoverySession(tab, entry)),
    );
  }

  private getActiveSessionIdsAcrossViews(): Set<string> {
    const activeIds = new Set<string>();
    for (const view of liveTerminalViews) {
      if (view.isDisposed) {
        continue;
      }
      for (const sessionId of view.tabManager.getActiveSessionIds()) {
        activeIds.add(sessionId);
      }
    }
    return activeIds;
  }

  private syncRecentlyClosedState(): void {
    for (const view of liveTerminalViews) {
      if (view.isDisposed) {
        continue;
      }
      view.refreshDebugGlobal();
      void view.checkHookWarning();
    }
  }

  /**
   * Shared predicate: does `candidate` match the given entry fields?
   * Used by both removePersistedSession and removePersistedSessionForClosedEntry
   * to avoid duplicating the matching logic.
   */
  private matchesPersistedSessionForEntry(
    candidate: PersistedSession,
    entry: {
      itemId: string;
      recoveryMode?: DurableRecoveryMode;
      claudeSessionId?: string | null;
      durableSessionId?: string;
      sessionType: SessionType;
      label: string;
      cwd?: string;
      command?: string;
      commandArgs?: string[];
    },
  ): boolean {
    if (candidate.recoveryMode !== entry.recoveryMode) {
      return false;
    }

    if (entry.recoveryMode === "resume") {
      return !!entry.claudeSessionId && candidate.claudeSessionId === entry.claudeSessionId;
    }

    if (entry.durableSessionId && candidate.durableSessionId) {
      return (
        candidate.taskPath === entry.itemId && candidate.durableSessionId === entry.durableSessionId
      );
    }

    return (
      candidate.taskPath === entry.itemId &&
      candidate.sessionType === entry.sessionType &&
      candidate.label === entry.label &&
      candidate.cwd === entry.cwd &&
      candidate.command === entry.command &&
      JSON.stringify(candidate.commandArgs || []) === JSON.stringify(entry.commandArgs || [])
    );
  }

  private removePersistedSession(session: PersistedSession): void {
    const entry = {
      itemId: session.taskPath,
      recoveryMode: session.recoveryMode,
      claudeSessionId: session.claudeSessionId,
      durableSessionId: session.durableSessionId,
      sessionType: session.sessionType,
      label: session.label,
      cwd: session.cwd,
      command: session.command,
      commandArgs: session.commandArgs,
    };
    const matches = (candidate: PersistedSession) =>
      this.matchesPersistedSessionForEntry(candidate, entry);

    this.pendingPersistedSessions = this.pendingPersistedSessions.filter(
      (candidate) => !matches(candidate),
    );
    this.persistedSessions = this.persistedSessions.filter((candidate) => !matches(candidate));
    this.syncPersistedSessionState(this.persistedSessions);
  }

  /**
   * Remove a persisted session that corresponds to a tab the user explicitly closed.
   * Prevents recently-closed sessions from leaking back into auto-restore via
   * pendingPersistedSessions on the next periodic persist cycle.
   */
  private removePersistedSessionForClosedEntry(entry: ClosedSessionEntry): void {
    const matches = (candidate: PersistedSession) =>
      this.matchesPersistedSessionForEntry(candidate, entry);

    this.pendingPersistedSessions = this.pendingPersistedSessions.filter(
      (candidate) => !matches(candidate),
    );
    this.persistedSessions = this.persistedSessions.filter((candidate) => !matches(candidate));
    this.syncPersistedSessionState(this.persistedSessions);
  }

  private trackRecoverySuccess(
    tab: TerminalTab,
    onRecovered: () => void,
    onFailed?: () => void,
  ): void {
    const spawnTime = Date.now();
    const origExit = tab.onProcessExit;
    tab.onProcessExit = (code, signal) => {
      const lived = Date.now() - spawnTime;
      if (lived < 5000) {
        onFailed?.();
      } else {
        onRecovered();
      }
      origExit?.(code, signal);
    };
  }

  /**
   * Spawn a session from an agent profile.
   * Resolves profile settings, builds the appropriate session type, and delegates
   * to the existing spawn methods.
   */
  async spawnFromProfile(profile: AgentProfile): Promise<void> {
    if (!this.profileManager) return;
    const fresh = await this.loadFreshSettings();
    const sessionType = agentTypeToSessionType(profile.agentType, profile.useContext);
    const command = this.profileManager.resolveCommand(profile, fresh);
    const cwd = this.profileManager.resolveCwd(profile, fresh);
    const extraArgs = this.profileManager.resolveArguments(profile, fresh);
    const label = profile.button.label || profile.name;

    // Expand item placeholders in arguments (defer $sessionId until the real ID is known)
    const item = this.getActiveItem();
    let expandedArgs = extraArgs;
    if (item) {
      expandedArgs = this.expandProfilePlaceholders(expandedArgs, item, "$sessionId");
    }

    if (profile.agentType === "shell") {
      const expandedCwd = expandTilde(cwd);
      const tab = this.tabManager.createTab(command, expandedCwd, label, "shell");
      if (tab && profile.button.color) tab.profileColor = profile.button.color;
      this.renderTabBar();
      return;
    }

    // Build context prompt if the profile uses context
    let prompt: string | undefined;
    if (profile.useContext && item) {
      const contextTemplate = this.profileManager.resolveContextPrompt(profile, fresh);
      if (contextTemplate) {
        // Build from adapter prompt + profile context template
        const adapterPrompt = this.promptBuilder.buildPrompt(
          item,
          this.resolveWorkItemPath(item.path),
        );
        // Defer $sessionId in context template too
        const expandedContext = this.expandProfilePlaceholders(contextTemplate, item, "$sessionId");
        prompt = adapterPrompt ? adapterPrompt + "\n\n" + expandedContext : expandedContext;
      } else {
        // Fall back to standard context prompt building
        prompt =
          profile.agentType === "claude"
            ? await this.getClaudeContextPrompt(item, fresh)
            : await this.getAgentContextPrompt(item, fresh);
      }
      if (!prompt) {
        new Notice("Could not build a contextual prompt for this item");
        return;
      }
    }

    // Profile's resolveArguments() already includes global args, so skip the
    // global merge inside spawn*Session to avoid doubling them.
    switch (profile.agentType) {
      case "claude":
        await this.spawnClaudeSession({
          sessionType: sessionType as "claude" | "claude-with-context",
          command,
          cwd,
          extraArgs: expandedArgs,
          skipGlobalArgs: true,
          label,
          prompt,
          freshSettings: fresh,
        });
        break;
      case "copilot":
        await this.spawnCopilotSession({
          sessionType: sessionType as "copilot" | "copilot-with-context",
          command,
          cwd,
          extraArgs: expandedArgs,
          skipGlobalArgs: true,
          label,
          prompt,
          freshSettings: fresh,
        });
        break;
      case "strands":
        await this.spawnStrandsSession({
          sessionType: sessionType as "strands" | "strands-with-context",
          command,
          cwd,
          extraArgs: expandedArgs,
          skipGlobalArgs: true,
          label,
          prompt,
          freshSettings: fresh,
        });
        break;
    }

    // Apply profile color to the newly created tab
    if (profile.button.color) {
      const activeItemId = this.tabManager.getActiveItemId();
      if (activeItemId) {
        const tabs = this.tabManager.getTabs(activeItemId);
        const lastTab = tabs[tabs.length - 1];
        if (lastTab) {
          lastTab.profileColor = profile.button.color;
          this.renderTabBar();
        }
      }
    }
  }

  private expandProfilePlaceholders(template: string, item: WorkItem, sessionId: string): string {
    return template
      .replace(/\$title/g, item.title)
      .replace(/\$state/g, item.state)
      .replace(/\$filePath/g, item.path)
      .replace(/\$id/g, item.id)
      .replace(/\$sessionId/g, sessionId);
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
    const targetItemId = itemId || this.tabManager.getActiveItemId();
    if (!targetItemId) return;
    const fresh = await this.loadFreshSettings();
    const tab =
      persisted.recoveryMode === "relaunch"
        ? this.createRelaunchedTab({
            targetItemId,
            sessionType: persisted.sessionType,
            label: persisted.label,
            command: persisted.command,
            cwd: persisted.cwd,
            commandArgs: persisted.commandArgs,
            durableSessionId: persisted.durableSessionId,
          })
        : this.getPersistedSessionId(persisted)
          ? this.createResumedTab({
              targetItemId,
              sessionType: persisted.sessionType,
              label: persisted.label,
              sessionId: this.getPersistedSessionId(persisted) || "",
              freshSettings: fresh,
              ...this.getSavedResumeLaunchContext(persisted),
            })
          : null;

    if (!tab) return;

    if (persisted.profileColor) {
      tab.profileColor = persisted.profileColor;
    }

    this.trackRecoverySuccess(tab, () => {
      this.removePersistedSession(persisted);
      this.persistSessions().catch(() => {});
    });

    this.renderTabBar();
  }

  private createRelaunchedTab(options: {
    targetItemId: string;
    sessionType: PersistedSession["sessionType"];
    label: string;
    command?: string;
    cwd?: string;
    commandArgs?: string[];
    durableSessionId?: string;
  }): TerminalTab | null {
    if (!options.command || !options.cwd) {
      return null;
    }

    return this.tabManager.createTabForItem(
      options.targetItemId,
      options.command,
      options.cwd,
      options.label,
      options.sessionType,
      undefined,
      options.commandArgs,
      null,
      options.durableSessionId,
    );
  }

  private createResumedTab(options: {
    targetItemId: string;
    sessionType: PersistedSession["sessionType"];
    label: string;
    sessionId: string;
    freshSettings: Record<string, unknown>;
    cwd?: string;
    resolvedCommand?: string;
    extraArgs?: string[];
  }): TerminalTab | null {
    const isCopilot =
      options.sessionType === "copilot" || options.sessionType === "copilot-with-context";
    const agent = isCopilot ? "copilot" : "claude";
    const configuredCwd = expandTilde(
      this.getStringSetting(options.freshSettings, "core.defaultTerminalCwd", "~"),
    );
    const cwd = options.cwd || configuredCwd;
    const configuredCommand = this.getStringSetting(
      options.freshSettings,
      isCopilot ? "core.copilotCommand" : "core.claudeCommand",
      isCopilot ? "copilot" : "claude",
    );
    const savedResolution = options.resolvedCommand
      ? resolveCommandInfo(options.resolvedCommand, cwd)
      : null;
    const command = savedResolution?.found
      ? savedResolution.resolved
      : this.resolveAgentCommandOrNotice(agent, configuredCommand, configuredCwd);
    if (!command) {
      return null;
    }
    const args = isCopilot ? [`--resume=${options.sessionId}`] : ["--resume", options.sessionId];
    const extraArgs =
      options.extraArgs ||
      (isCopilot
        ? this.getStringSetting(options.freshSettings, "core.copilotExtraArgs", "")
        : this.getStringSetting(options.freshSettings, "core.claudeExtraArgs", ""));
    const parsedExtraArgs = Array.isArray(extraArgs) ? extraArgs : parseExtraArgs(extraArgs);

    if (parsedExtraArgs.length > 0) {
      args.unshift(...parsedExtraArgs);
    }

    const tab = this.tabManager.createTabForItem(
      options.targetItemId,
      command,
      cwd,
      options.label,
      options.sessionType,
      undefined,
      [command, ...args],
      options.sessionId,
    );

    if (tab && this.adapter.transformSessionLabel) {
      tab.transformLabel = (old, detected) => this.adapter.transformSessionLabel!(old, detected);
    }

    return tab;
  }

  private async restartClaudeTab(tab: TerminalTab, _index: number): Promise<void> {
    const targetItemId = tab.taskPath ?? this.tabManager.getActiveItemId();
    if (!targetItemId) return;

    // Record the old tab's position so the replacement can take its place
    const oldTabs = this.tabManager.getTabs(targetItemId);
    const oldIndex = oldTabs.indexOf(tab);

    const fresh = await this.loadFreshSettings();
    const fallbackCwd = expandTilde(this.getStringSetting(fresh, "core.defaultTerminalCwd", "~"));
    let replacement: TerminalTab | null;
    if (tab.agentSessionId) {
      replacement = this.createResumedTab({
        targetItemId,
        sessionType: tab.sessionType,
        label: tab.label,
        sessionId: tab.agentSessionId,
        freshSettings: fresh,
        cwd: tab.launchCommandArgs?.length ? tab.launchCwd : fallbackCwd,
        resolvedCommand:
          tab.launchCommandArgs?.[0] ||
          resolveCommand(this.getStringSetting(fresh, "core.claudeCommand", "claude")),
        extraArgs: this.extractResumeExtraArgs(tab.sessionType, tab.launchCommandArgs),
      });
    } else if (tab.launchCommandArgs?.length) {
      replacement = this.tabManager.createTabForItem(
        targetItemId,
        tab.launchCommandArgs[0],
        tab.launchCwd,
        tab.label,
        tab.sessionType,
        undefined,
        tab.launchCommandArgs,
        null,
        tab.durableSessionId,
      );
    } else {
      replacement = await this.spawnClaudeSession({
        sessionType: tab.sessionType === "claude-with-context" ? "claude-with-context" : "claude",
        cwd: fallbackCwd,
        label: tab.label,
        freshSettings: fresh,
      });
    }

    if (!replacement) return;

    // Close the old tab first, then move replacement to the old position
    this.tabManager.closeTabInstance(targetItemId, tab);
    if (oldIndex >= 0) {
      this.tabManager.moveTabToIndex(targetItemId, replacement, oldIndex);
    }
  }

  private extractResumeExtraArgs(
    sessionType: PersistedSession["sessionType"],
    commandArgs?: string[],
  ): string[] {
    if (!commandArgs?.length) {
      return [];
    }
    const args = commandArgs.slice(1);
    const extraArgs: string[] = [];
    const stripClaudeContextPrompt = sessionType === "claude-with-context";
    const stripCopilotContextPrompt = sessionType === "copilot-with-context";

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (stripCopilotContextPrompt && arg === "-i") {
        if (i + 1 < args.length) {
          i++;
        }
        continue;
      }
      if (arg === "--session-id" || arg === "--resume") {
        if (i + 1 < args.length) {
          i++;
        }
        if (stripClaudeContextPrompt && arg === "--session-id" && i + 1 < args.length) {
          i++;
        }
        continue;
      }
      if (arg.startsWith("--session-id=") || arg.startsWith("--resume=")) {
        if (stripClaudeContextPrompt && arg.startsWith("--session-id=") && i + 1 < args.length) {
          i++;
        }
        continue;
      }
      extraArgs.push(arg);
    }

    return extraArgs;
  }

  // ---------------------------------------------------------------------------
  // Session persistence
  // ---------------------------------------------------------------------------

  private async loadPersistedSessions(): Promise<void> {
    const persistedSessions = await SessionPersistence.loadFromDisk(this.plugin);
    if (this.isDisposed) return;
    this.adoptSynthesizedDurableSessionIds(persistedSessions);
    this.syncPersistedSessionState(persistedSessions);
    await this.checkHookWarning();
  }

  private async loadRecentlyClosedSessions(): Promise<void> {
    const data = (await this.plugin.loadData()) || {};
    if (this.isDisposed) return;
    if (RecentlyClosedStore.claimWindowHydration()) {
      for (const entry of RecentlyClosedStore.fromData(data.recentlyClosedSessions || [])) {
        this.recentlyClosedStore.add(entry);
      }
    }
    this.syncRecentlyClosedState();
    await this.checkHookWarning();
  }

  async persistSessions(): Promise<void> {
    if (this.isDisposed) return;
    this.recalculatePendingPersistedSessions();
    const persistedSessions = SessionPersistence.mergePersistedSessions(
      this.pendingPersistedSessions,
      this.getLiveSessionsAcrossViews(),
    );
    await mergeAndSavePluginData(this.plugin, async (data) => {
      SessionPersistence.setPersistedSessions(data, persistedSessions);
    });
    if (this.isDisposed) return;
    this.syncPersistedSessionState(persistedSessions);
  }

  private async persistRecentlyClosedSessions(): Promise<void> {
    if (this.isDisposed) return;
    const recentlyClosed = this.recentlyClosedStore.serialize();
    await mergeAndSavePluginData(this.plugin, async (data) => {
      if (recentlyClosed.length > 0) {
        data.recentlyClosedSessions = recentlyClosed;
      } else {
        delete data.recentlyClosedSessions;
      }
    });
    if (this.isDisposed) return;
    this.syncRecentlyClosedState();
    this.refreshDebugGlobal();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  setActiveItem(itemId: string | null): void {
    this.tabManager.setActiveItem(itemId);
    this.refreshDebugGlobal();
    this.renderTabBar();
  }

  setTitle(item: WorkItem | null): void {
    this.titleEl.empty();
    this.titleEl.style.removeProperty("--wt-task-color");

    if (!item) {
      this.titleEl.style.display = "none";
      return;
    }

    const meta = (item.metadata || {}) as Record<string, any>;
    const source = meta.source || {};
    const taskColor = typeof meta.color === "string" ? meta.color : "";
    if (taskColor) {
      this.titleEl.style.setProperty("--wt-task-color", taskColor);
    }

    const titleRow = this.titleEl.createDiv({ cls: "wt-task-title-row" });
    const jiraUrl = typeof source.url === "string" ? source.url.trim() : "";
    const jiraId = typeof source.id === "string" ? source.id.trim().toUpperCase() : "";
    if (source.type === "jira" && jiraUrl) {
      const jiraLink = titleRow.createEl("a", {
        cls: "wt-task-jira-link",
        attr: {
          href: jiraUrl,
          "aria-label": `Open Jira ${jiraId || "ticket"} externally`,
          title: jiraUrl,
        },
      });
      jiraLink.createSpan({
        cls: "wt-task-jira-link-label",
        text: jiraId || "JIRA",
      });
      jiraLink.createSpan({
        cls: "wt-task-jira-link-icon",
        text: "↗",
      });
      jiraLink.addEventListener("click", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        const logOpenExternalError = (error: unknown) => {
          console.error(`[work-terminal] Failed to open Jira link externally: ${jiraUrl}`, error);
        };
        try {
          const shell = electronRequire("electron").shell;
          void Promise.resolve(shell.openExternal(jiraUrl)).catch(logOpenExternalError);
        } catch (error) {
          logOpenExternalError(error);
        }
      });
    }

    const titleText = titleRow.createSpan({ cls: "wt-task-title-text" });
    titleText.textContent = item.title;
    titleText.title = item.title;
    this.titleEl.style.display = "block";
  }

  async getClaudeContextPrompt(
    item: WorkItem,
    freshSettings?: Record<string, unknown>,
  ): Promise<string | null> {
    const settings = freshSettings ?? (await this.loadFreshSettings());
    return buildAgentContextPrompt(item, settings, this.resolveWorkItemPath(item.path));
  }

  async getAgentContextPrompt(
    item: WorkItem,
    freshSettings?: Record<string, unknown>,
  ): Promise<string | null> {
    const settings = freshSettings ?? (await this.loadFreshSettings());
    const resolvedPath = this.resolveWorkItemPath(item.path);
    const basePrompt = this.promptBuilder.buildPrompt(item, resolvedPath);
    const templatePrompt = buildAgentContextPrompt(item, settings, resolvedPath);

    if (!basePrompt && !templatePrompt) {
      return null;
    }
    if (!basePrompt) {
      return templatePrompt;
    }
    if (!templatePrompt) {
      return basePrompt;
    }
    return `${basePrompt}\n\n${templatePrompt}`;
  }

  private resolveVaultBasePath(): string {
    const path = electronRequire("path") as typeof import("path");
    const adapter = (this.plugin.app as any)?.vault?.adapter as any;
    let vaultPath = expandTilde(adapter?.basePath || adapter?.getBasePath?.() || "");
    const homeDir = process.env.HOME || process.env.USERPROFILE || "";

    if (vaultPath && !path.isAbsolute(vaultPath)) {
      vaultPath = homeDir ? path.resolve(homeDir, vaultPath) : path.resolve(vaultPath);
    }

    return vaultPath;
  }

  private resolvePluginDir(): string {
    const path = electronRequire("path") as typeof import("path");
    const manifestDir = this.plugin.manifest.dir || `.obsidian/plugins/${this.plugin.manifest.id}`;
    if (path.isAbsolute(manifestDir)) {
      return manifestDir;
    }

    const vaultBasePath = this.resolveVaultBasePath();
    return vaultBasePath ? path.resolve(vaultBasePath, manifestDir) : path.resolve(manifestDir);
  }

  private resolveWorkItemPath(itemPath: string): string {
    const path = electronRequire("path") as typeof import("path");
    const vaultPath = this.resolveVaultBasePath();
    if (!vaultPath) {
      return itemPath;
    }
    return path.resolve(vaultPath, itemPath);
  }

  getAllActiveTabs(): ActiveTabInfo[] {
    return this.tabManager.getAllActiveTabs();
  }

  findTabsByLabel(label: string): ActiveTabInfo[] {
    return this.tabManager.findTabsByLabel(label);
  }

  getActiveSessionIds(): string[] {
    return Array.from(this.tabManager.getActiveSessionIds());
  }

  private getPersistedSessionId(session: PersistedSession): string | null {
    return session.agentSessionId || session.claudeSessionId || null;
  }

  private getClosedSessionId(entry: ClosedSessionEntry): string | null {
    return (
      entry.agentSessionId || (entry as { claudeSessionId?: string | null }).claudeSessionId || null
    );
  }

  private buildSessionDiagnosticsSnapshot(): WorkTerminalSessionDiagnosticsSnapshot {
    const activeSessionIds = this.tabManager.getActiveSessionIds();
    const activeTabs = this.tabManager.getTabDiagnostics().map((tab) => {
      const hasPersistedSession =
        !!tab.sessionId &&
        this.durablePersistedSessions.some(
          (session) =>
            session.taskPath === tab.itemId &&
            this.getPersistedSessionId(session) === tab.sessionId &&
            session.sessionType === tab.sessionType,
        );
      const missingPersistedMetadata = tab.isResumableAgent && !hasPersistedSession;
      const wouldBeLostOnFullClose = tab.process.status === "alive" && !tab.isResumableAgent;
      const lifecycle = tab.isDisposed
        ? "disposed"
        : tab.process.status === "alive"
          ? "live"
          : tab.isResumableAgent && hasPersistedSession
            ? "resumable"
            : missingPersistedMetadata
              ? "resume-metadata-missing"
              : "lost";
      return {
        ...tab,
        recovery: {
          resumable: tab.isResumableAgent,
          relaunchable: !tab.isResumableAgent,
          hasPersistedSession,
          canResumeAfterRestart: tab.isResumableAgent && hasPersistedSession,
          missingPersistedMetadata,
          wouldBeLostOnFullClose,
          lifecycle,
        },
      };
    });
    const itemIds = this.tabManager.getSessionItemIds();
    const items = itemIds.map((itemId) => ({
      itemId,
      isActiveItem: itemId === this.tabManager.getActiveItemId(),
      activeTabIndex:
        itemId === this.tabManager.getActiveItemId() ? this.tabManager.getActiveTabIndex() : 0,
      aggregateState: this.tabManager.getAgentState(itemId),
      idleSince: this.tabManager.getIdleSince(itemId) ?? null,
      sessionCounts: this.tabManager.getSessionCounts(itemId),
      tabs: activeTabs.filter((tab) => tab.itemId === itemId),
    }));
    const recentlyClosedSessions = this.recentlyClosedStore
      .getEntries(activeSessionIds, 20)
      .map((entry) => ({
        ...entry,
        recoveryAvailable:
          isResumableSessionType(entry.sessionType) && !!this.getClosedSessionId(entry),
      }));
    const summary: DiagnosticsSummary = {
      activeItemId: this.tabManager.getActiveItemId(),
      activeTabIndex: this.tabManager.getActiveTabIndex(),
      activeItemCount: items.length,
      activeTabCount: activeTabs.length,
      persistedSessionCount: this.durablePersistedSessions.length,
      recentlyClosedCount: recentlyClosedSessions.length,
      hasHotReloadStore: SessionStore.isReload(),
      derivedCounts: {
        blankButLiveRenderer: activeTabs.filter((tab) => tab.derived.blankButLiveRenderer).length,
        staleDisposedWebglOwnership: activeTabs.filter(
          (tab) => tab.derived.staleDisposedWebglOwnership,
        ).length,
        missingPersistedMetadata: activeTabs.filter((tab) => tab.recovery.missingPersistedMetadata)
          .length,
        liveNonResumableSessions: activeTabs.filter((tab) => tab.recovery.wouldBeLostOnFullClose)
          .length,
        disposedTabStillSelected: activeTabs.filter((tab) => tab.derived.disposedTabStillSelected)
          .length,
      },
    };

    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      summary,
      items,
      persistedSessions: [...this.durablePersistedSessions],
      recentlyClosedSessions,
    };
  }

  getSessionDiagnosticsSnapshot(): WorkTerminalSessionDiagnosticsSnapshot {
    return this.buildSessionDiagnosticsSnapshot();
  }

  getSessionDiagnosticsJson(): string {
    return JSON.stringify(this.buildSessionDiagnosticsSnapshot(), null, 2);
  }

  async copySessionDiagnostics(): Promise<boolean> {
    try {
      const diagnosticsJson = this.getSessionDiagnosticsJson();
      const electron = electronRequire("electron") as
        | {
            clipboard?: {
              writeText?: (text: string) => void;
            };
          }
        | undefined;
      if (electron?.clipboard?.writeText) {
        electron.clipboard.writeText(diagnosticsJson);
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(diagnosticsJson);
      } else {
        throw new Error("Clipboard API unavailable");
      }
      new Notice("Session diagnostics copied to clipboard");
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[work-terminal] Failed to copy session diagnostics:", error);
      new Notice(`Failed to copy session diagnostics: ${message}`);
      return false;
    }
  }

  private getActiveItem(): WorkItem | null {
    const activeItemId = this.tabManager.getActiveItemId();
    if (!activeItemId) return null;
    return this.allItems.find((item) => item.id === activeItemId) || null;
  }

  private async openProfileLaunchModal(): Promise<void> {
    const item = this.getActiveItem();
    if (!item) {
      new Notice(`Select a ${this.adapter.config.itemName} first to launch a profile`);
      return;
    }

    const profiles = this.profileManager?.getProfiles() ?? [];
    if (profiles.length === 0) {
      new Notice("No agent profiles configured. Open Settings to create one.");
      return;
    }

    const fresh = await this.loadFreshSettings();
    const defaultCwd = this.getStringSetting(fresh, "core.defaultTerminalCwd", "~");
    const activeIds = this.getActiveSessionIdsAcrossViews();
    const closedSessions = this.recentlyClosedStore.getEntries(activeIds, 5, (entry) =>
      this.isClosedSessionActiveAcrossViews(entry),
    );
    new ProfileLaunchModal(
      this.plugin.app,
      profiles,
      defaultCwd,
      (overrides) => {
        this.launchAction("profile launch", () => this.spawnFromProfileWithOverrides(overrides));
      },
      closedSessions,
      (entry) => {
        this.launchAction("restore session", () => this.restoreClosedSession(entry));
      },
    ).open();
  }

  private async spawnFromProfileWithOverrides(overrides: ProfileLaunchOverrides): Promise<void> {
    const profile = overrides.profile;

    const effectiveProfile = {
      ...profile,
      defaultCwd: overrides.cwd || profile.defaultCwd,
      button: {
        ...profile.button,
        label: overrides.label || profile.button.label,
      },
    };

    if (overrides.extraArgs) {
      effectiveProfile.arguments = effectiveProfile.arguments
        ? `${effectiveProfile.arguments} ${overrides.extraArgs}`
        : overrides.extraArgs;
    }

    await this.spawnFromProfile(effectiveProfile);
  }

  private async restoreClosedSession(entry: ClosedSessionEntry): Promise<void> {
    const claimedFromStore = this.recentlyClosedStore.take(entry);
    const entryRecoveryMode = (entry as { recoveryMode?: ClosedSessionEntry["recoveryMode"] })
      .recoveryMode;
    const fallbackEntry =
      claimedFromStore ||
      entryRecoveryMode === "resume" ||
      entryRecoveryMode === "relaunch" ||
      !this.getClosedSessionId(entry)
        ? undefined
        : RecentlyClosedStore.fromData([entry])[0];
    const claimedEntry = claimedFromStore ?? fallbackEntry;
    if (!claimedEntry) {
      return;
    }

    if (claimedFromStore) {
      this.syncRecentlyClosedState();
      this.persistRecentlyClosedSessions().catch(() => {});
    }

    const fresh = await this.loadFreshSettings();
    const sessionId = this.getClosedSessionId(claimedEntry);
    const tab =
      claimedEntry.recoveryMode === "relaunch"
        ? this.createRelaunchedTab({
            targetItemId: claimedEntry.itemId,
            sessionType: claimedEntry.sessionType,
            label: claimedEntry.label,
            command: claimedEntry.command,
            cwd: claimedEntry.cwd,
            commandArgs: claimedEntry.commandArgs,
            durableSessionId: claimedEntry.durableSessionId,
          })
        : sessionId
          ? this.createResumedTab({
              targetItemId: claimedEntry.itemId,
              sessionType: claimedEntry.sessionType,
              label: claimedEntry.label,
              sessionId,
              freshSettings: fresh,
              ...this.getSavedResumeLaunchContext(claimedEntry),
            })
          : null;

    if (!tab) {
      this.recentlyClosedStore.add(claimedEntry);
      this.syncRecentlyClosedState();
      this.persistRecentlyClosedSessions().catch(() => {});
      return;
    }

    if (claimedEntry.profileColor) {
      tab.profileColor = claimedEntry.profileColor;
    }

    this.trackRecoverySuccess(
      tab,
      () => {
        this.syncRecentlyClosedState();
        this.persistRecentlyClosedSessions().catch(() => {});
      },
      () => {
        this.recentlyClosedStore.add(claimedEntry);
        this.syncRecentlyClosedState();
        this.persistRecentlyClosedSessions().catch(() => {});
      },
    );
    this.renderTabBar();
  }

  private async spawnClaudeSession(options: {
    sessionType: "claude" | "claude-with-context";
    cwd?: string;
    command?: string;
    extraArgs?: string;
    skipGlobalArgs?: boolean;
    label?: string;
    prompt?: string;
    freshSettings?: Record<string, unknown>;
  }): Promise<TerminalTab | null> {
    let prompt = options.prompt;
    if (options.sessionType === "claude-with-context" && !prompt) {
      const item = this.getActiveItem();
      if (!item) {
        new Notice(`Select a ${this.adapter.config.itemName} first to launch Claude with context`);
        return null;
      }
      const fresh = options.freshSettings ?? (await this.loadFreshSettings());
      prompt = await this.getClaudeContextPrompt(item, fresh);
      if (!prompt) {
        new Notice("Could not build a contextual prompt for this item");
        return null;
      }
      options.freshSettings = fresh;
    }

    const fresh = options.freshSettings ?? (await this.loadFreshSettings());
    const claudeCmd =
      options.command || this.getStringSetting(fresh, "core.claudeCommand", "claude");
    const cwd = expandTilde(
      options.cwd || this.getStringSetting(fresh, "core.defaultTerminalCwd", "~"),
    );
    const resolved = this.resolveAgentCommandOrNotice("claude", claudeCmd, cwd);
    if (!resolved) {
      return null;
    }
    const sessionId = crypto.randomUUID();
    const rawExtraArgs = options.skipGlobalArgs
      ? options.extraArgs || ""
      : mergeExtraArgs(
          this.getStringSetting(fresh, "core.claudeExtraArgs", ""),
          options.extraArgs || "",
        );
    // Replace deferred $sessionId placeholders with the real session ID
    const mergedExtraArgs = rawExtraArgs.replace(/\$sessionId/g, sessionId);
    const args = buildClaudeArgs({ claudeExtraArgs: mergedExtraArgs }, sessionId, prompt);
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
    return tab;
  }

  private async spawnCopilotSession(options: {
    sessionType: "copilot" | "copilot-with-context";
    cwd?: string;
    command?: string;
    extraArgs?: string;
    skipGlobalArgs?: boolean;
    label?: string;
    prompt?: string;
    freshSettings?: Record<string, unknown>;
  }): Promise<void> {
    const fresh = options.freshSettings ?? (await this.loadFreshSettings());
    const copilotCmd =
      options.command || this.getStringSetting(fresh, "core.copilotCommand", "copilot");
    const cwd = expandTilde(
      options.cwd || this.getStringSetting(fresh, "core.defaultTerminalCwd", "~"),
    );
    const resolved = this.resolveAgentCommandOrNotice("copilot", copilotCmd, cwd);
    if (!resolved) {
      return;
    }
    const sessionId = crypto.randomUUID();
    const rawExtraArgs = options.skipGlobalArgs
      ? options.extraArgs || ""
      : mergeExtraArgs(
          this.getStringSetting(fresh, "core.copilotExtraArgs", ""),
          options.extraArgs || "",
        );
    const mergedExtraArgs = rawExtraArgs.replace(/\$sessionId/g, sessionId);
    const args = [
      `--resume=${sessionId}`,
      ...buildCopilotArgs({ copilotExtraArgs: mergedExtraArgs }, options.prompt),
    ];
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
    command?: string;
    extraArgs?: string;
    skipGlobalArgs?: boolean;
    label?: string;
    prompt?: string;
    freshSettings?: Record<string, unknown>;
  }): Promise<void> {
    const fresh = options.freshSettings ?? (await this.loadFreshSettings());
    const strandsCmd = expandTilde(
      options.command || this.getStringSetting(fresh, "core.strandsCommand", "strands"),
    );
    const [cmdToken, ...cmdArgs] = splitConfiguredCommand(strandsCmd);
    if (!cmdToken) {
      new Notice(
        "Set a Strands command in Work Terminal settings before launching Strands sessions.",
      );
      return;
    }
    const resolved = resolveCommand(cmdToken);
    const rawExtraArgs = options.skipGlobalArgs
      ? options.extraArgs || ""
      : mergeExtraArgs(
          this.getStringSetting(fresh, "core.strandsExtraArgs", ""),
          options.extraArgs || "",
        );
    // Strands has no session ID - strip any deferred $sessionId placeholders
    const mergedExtraArgs = rawExtraArgs.replace(/\$sessionId/g, "");
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

  private resolveAgentCommandOrNotice(
    agent: "claude" | "copilot",
    command: string,
    cwd?: string,
  ): string | null {
    const resolution = resolveCommandInfo(command, cwd);
    if (resolution.found) {
      return resolution.resolved;
    }
    new Notice(buildMissingCliNotice(agent, command));
    return null;
  }

  getRecoveredItemId(): string | null {
    return this.tabManager.getRecoveredItemId();
  }

  getActiveItemId(): string | null {
    return this.tabManager.getActiveItemId();
  }

  refitActive(): void {
    this.tabManager.refitActive();
  }

  hasSessions(itemId: string): boolean {
    return this.tabManager.hasSessions(itemId);
  }

  hasResumableAgentSessions(itemId: string): boolean {
    return this.tabManager.hasResumableAgentSessions(itemId);
  }

  hasAnySessions(): boolean {
    return this.tabManager.getSessionItemIds().length > 0;
  }

  getSessionCounts(itemId: string): { shells: number; agents: number } {
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
    this.recalculatePendingPersistedSessions();
    return this.pendingPersistedSessions.filter((session) => session.taskPath === itemId);
  }

  getPendingPersistedSessionsForPersist(): PersistedSession[] {
    return this.pendingPersistedSessions.map((session) => ({
      ...session,
      commandArgs: session.commandArgs ? [...session.commandArgs] : undefined,
    }));
  }

  /**
   * Broadcast current agent state for all items with sessions.
   * Call after initial list render to sync state indicators that may have been
   * set before the ListPanel existed (e.g. recovered from hot-reload).
   */
  broadcastAgentStates(): void {
    for (const itemId of this.tabManager.getSessionItemIds()) {
      const state = this.tabManager.getAgentState(itemId);
      this.onAgentStateChange(itemId, state);
    }
  }

  broadcastClaudeStates(): void {
    this.broadcastAgentStates();
  }

  rekeyItem(oldId: string, newId: string): void {
    this.tabManager.rekeyItem(oldId, newId);
    this.persistedSessions = this.persistedSessions.map((session) =>
      session.taskPath === oldId ? { ...session, taskPath: newId } : session,
    );
    this.pendingPersistedSessions = this.pendingPersistedSessions.map((session) =>
      session.taskPath === oldId ? { ...session, taskPath: newId } : session,
    );
    this.syncPersistedSessionState(this.persistedSessions);
  }

  stashAll(): void {
    this.isDisposed = true;
    this.stopPeriodicPersist?.();
    this.stopPeriodicPersist = null;
    this.stopHookWarningPoller();
    this.detachSettingsListener();
    this.tabBarResizeObserver?.disconnect();
    this.tabBarResizeObserver = null;
    this.tabManager.stashAll();
    this.clearDebugGlobal();
  }

  disposeAll(): void {
    const persistedSessions = this.persistedSessions.map((session) => ({
      ...session,
      commandArgs: session.commandArgs ? [...session.commandArgs] : undefined,
    }));
    this.isDisposed = true;
    liveTerminalViews.delete(this);
    this.syncPersistedSessionState(persistedSessions);
    this.stopPeriodicPersist?.();
    this.stopPeriodicPersist = null;
    if (this.tabClickTimer !== null) {
      clearTimeout(this.tabClickTimer);
      this.tabClickTimer = null;
    }
    this.stopHookWarningPoller();
    this.detachSettingsListener();
    this.tabBarResizeObserver?.disconnect();
    this.tabBarResizeObserver = null;
    this.tabManager.disposeAll();
    this.clearDebugGlobal();
  }

  setItems(items: WorkItem[]): void {
    this.allItems = items;
    this.refreshDebugGlobal();
  }

  getAgentState(itemId: string): AgentState {
    return this.tabManager.getAgentState(itemId);
  }

  getClaudeState(itemId: string): AgentState {
    return this.getAgentState(itemId);
  }

  private detachSettingsListener(): void {
    window.removeEventListener(SETTINGS_CHANGED_EVENT, this.handleSettingsChanged as EventListener);
    window.removeEventListener(PROFILES_CHANGED_EVENT, this.handleProfilesChanged as EventListener);
  }

  private isDebugApiEnabled(): boolean {
    return this.settings["core.exposeDebugApi"] === true;
  }

  private canExposeDebugApi(): boolean {
    return !this.isDisposed && this.isDebugApiEnabled();
  }

  private clearDebugGlobal(): void {
    debugApiOwners.delete(this);
    const currentOwner = (window.__workTerminalDebug as OwnedWorkTerminalDebugApi | undefined)?.[
      DEBUG_API_OWNER
    ];
    if (currentOwner !== this) {
      return;
    }

    const replacementOwner = Array.from(debugApiOwners).find((owner) => owner.canExposeDebugApi());
    if (replacementOwner) {
      window.__workTerminalDebug = replacementOwner.buildDebugApi();
      return;
    }

    delete window.__workTerminalDebug;
  }

  private refreshDebugGlobal(): void {
    if (!this.canExposeDebugApi()) {
      this.clearDebugGlobal();
      return;
    }

    debugApiOwners.add(this);
    window.__workTerminalDebug = this.buildDebugApi();
  }

  private buildDebugSnapshot(): WorkTerminalDebugSnapshot {
    return {
      version: 1,
      activeItemId: this.tabManager.getActiveItemId(),
      activeTabIndex: this.tabManager.getActiveTabIndex(),
      activeTabs: this.getAllActiveTabs(),
      activeSessionIds: this.getActiveSessionIds(),
      persistedSessions: [...this.persistedSessions],
      hasHotReloadStore: SessionStore.isReload(),
    };
  }

  private buildRevokedDebugSnapshot(): WorkTerminalDebugSnapshot {
    return {
      version: 1,
      activeItemId: null,
      activeTabIndex: 0,
      activeTabs: [],
      activeSessionIds: [],
      persistedSessions: [],
      hasHotReloadStore: false,
    };
  }

  private buildDebugApi(): OwnedWorkTerminalDebugApi {
    const getSnapshot = () =>
      this.canExposeDebugApi() ? this.buildDebugSnapshot() : this.buildRevokedDebugSnapshot();
    return {
      [DEBUG_API_OWNER]: this,
      get version() {
        return 1 as const;
      },
      get activeItemId() {
        return getSnapshot().activeItemId;
      },
      get activeTabIndex() {
        return getSnapshot().activeTabIndex;
      },
      get activeTabs() {
        return getSnapshot().activeTabs;
      },
      get activeSessionIds() {
        return getSnapshot().activeSessionIds;
      },
      get persistedSessions() {
        return getSnapshot().persistedSessions;
      },
      get hasHotReloadStore() {
        return getSnapshot().hasHotReloadStore;
      },
      getSnapshot,
      getAllActiveTabs: () => getSnapshot().activeTabs,
      findTabsByLabel: (label: string) =>
        this.canExposeDebugApi() ? this.findTabsByLabel(label) : [],
      getActiveSessionIds: () => getSnapshot().activeSessionIds,
      getPersistedSessions: (itemId?: string) =>
        this.canExposeDebugApi()
          ? itemId
            ? getPersistedSessions(itemId)
            : [...this.persistedSessions]
          : [],
      getSessionDiagnostics: () =>
        this.canExposeDebugApi()
          ? this.getSessionDiagnosticsSnapshot()
          : {
              version: 1,
              generatedAt: new Date(0).toISOString(),
              summary: {
                activeItemId: null,
                activeTabIndex: 0,
                activeItemCount: 0,
                activeTabCount: 0,
                persistedSessionCount: 0,
                recentlyClosedCount: 0,
                hasHotReloadStore: false,
                derivedCounts: {
                  blankButLiveRenderer: 0,
                  staleDisposedWebglOwnership: 0,
                  missingPersistedMetadata: 0,
                  liveNonResumableSessions: 0,
                  disposedTabStillSelected: 0,
                },
              },
              items: [],
              persistedSessions: [],
              recentlyClosedSessions: [],
            },
    };
  }
}
