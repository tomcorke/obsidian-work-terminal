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
  buildAgentArgs,
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
import { buildAgentContextPrompt, expandProfilePlaceholders } from "./AgentContextPrompt";
import { ProfileLaunchModal, type ProfileLaunchOverrides } from "./ProfileLaunchModal";
import { RecentlyClosedStore, type ClosedSessionEntry } from "../core/session/RecentlyClosedStore";
import { SETTINGS_CHANGED_EVENT } from "./SettingsTab";
import { getDefaultSessionLabel, isSessionTrackingSession } from "./CustomSessionConfig";
import type { AgentProfileManager } from "../core/agents/AgentProfileManager";
import { PROFILES_CHANGED_EVENT } from "../core/agents/AgentProfileManager";
import type { AgentProfile, AgentType, ParamPassMode } from "../core/agents/AgentProfile";
import {
  agentTypeToSessionType,
  sessionTypeToAgentType,
  getResumeConfig,
  getProfileResumeConfig,
  getAllResumeFlags,
  type AgentResumeConfig,
} from "../core/agents/AgentProfile";
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
        if (isSessionTrackingSession(tab.sessionType)) {
          return true;
        }
      }
    }

    return (
      this.persistedSessions.some(
        (session) =>
          session.recoveryMode === "resume" && isSessionTrackingSession(session.sessionType),
      ) ||
      this.recentlyClosedStore
        .serialize()
        .some(
          (entry) => entry.recoveryMode === "resume" && isSessionTrackingSession(entry.sessionType),
        )
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

        // Tab drag start/end (source identification)
        this.setupTabDragStartEnd(tabEl, i);
      }

      // Container-level drag-drop for positional indicator
      this.setupContainerDragDrop(tabsContainer);
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
      // for accurate measurement (expanded mode changes flex-direction)
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

  private setupTabDragStartEnd(tabEl: HTMLElement, index: number): void {
    tabEl.addEventListener("dragstart", (e: DragEvent) => {
      this.tabManager.setDragSourceIndex(index);
      tabEl.addClass("wt-tab-dragging");
      e.dataTransfer?.setData("text/plain", String(index));
    });

    tabEl.addEventListener("dragend", () => {
      this.tabManager.setDragSourceIndex(null);
      tabEl.removeClass("wt-tab-dragging");
    });
  }

  private setupContainerDragDrop(container: HTMLElement): void {
    container.addEventListener("dragover", (e: DragEvent) => {
      e.preventDefault();
      const sourceIdx = this.tabManager.getDragSourceIndex();
      if (sourceIdx === null) return;

      const tabs = Array.from(container.querySelectorAll(".wt-tab")) as HTMLElement[];
      if (tabs.length === 0) return;

      // Find insertion index by comparing clientX against tab midpoints
      let insertBeforeIndex = tabs.length;
      for (let i = 0; i < tabs.length; i++) {
        const rect = tabs[i].getBoundingClientRect();
        const midpoint = rect.left + rect.width / 2;
        if (e.clientX < midpoint) {
          insertBeforeIndex = i;
          break;
        }
      }

      // Skip if indicator would be right next to the dragged tab (no-op position)
      if (insertBeforeIndex === sourceIdx || insertBeforeIndex === sourceIdx + 1) {
        this.removeDropIndicators(container);
        return;
      }

      // Remove existing indicator
      this.removeDropIndicators(container);

      // Insert indicator at the calculated position
      const indicator = document.createElement("div");
      indicator.className = "wt-tab-drop-indicator";
      if (insertBeforeIndex < tabs.length) {
        container.insertBefore(indicator, tabs[insertBeforeIndex]);
      } else {
        container.appendChild(indicator);
      }
    });

    container.addEventListener("dragleave", (e: DragEvent) => {
      const related = e.relatedTarget as Node | null;
      if (!related || !container.contains(related)) {
        this.removeDropIndicators(container);
      }
    });

    container.addEventListener("drop", (e: DragEvent) => {
      e.preventDefault();
      const sourceIdx = this.tabManager.getDragSourceIndex();

      // Derive target index from indicator position.
      // Capture nextElementSibling BEFORE removing the indicator from the DOM,
      // otherwise it will always be null once the element is detached.
      const indicator = container.querySelector(".wt-tab-drop-indicator");
      const indicatorNext = indicator?.nextElementSibling as HTMLElement | null;
      this.removeDropIndicators(container);

      if (sourceIdx === null || !indicator) return;

      const tabs = Array.from(container.querySelectorAll(".wt-tab")) as HTMLElement[];

      if (!indicatorNext || !indicatorNext.classList.contains("wt-tab")) {
        // Indicator is at the end - drop after the last tab
        const lastIndex = tabs.length - 1;
        if (lastIndex >= 0 && lastIndex !== sourceIdx) {
          this.tabManager.reorderTab(sourceIdx, lastIndex, true);
        }
      } else {
        // Indicator is before a tab - find that tab's index
        const tabIndexAttr = indicatorNext.getAttribute("data-tab-index");
        if (tabIndexAttr === null) {
          console.warn(
            "work-terminal: drop target tab missing data-tab-index attribute, aborting reorder",
          );
          this.renderTabBar();
          return;
        }
        const targetIndex = parseInt(tabIndexAttr, 10);
        // dropAfter=false because we're inserting before this tab
        this.tabManager.reorderTab(sourceIdx, targetIndex, false);
      }

      this.renderTabBar();
    });
  }

  /** Remove all drop indicator elements from the given container. */
  private removeDropIndicators(container: HTMLElement): void {
    container.querySelectorAll(".wt-tab-drop-indicator").forEach((el) => el.remove());
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

    if (isResumableSessionType(tab.sessionType)) {
      menu.addItem((item) => {
        item.setTitle("Restart").onClick(() => {
          this.launchAction("Agent restart", () => this.restartAgentTab(tab, index));
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
    tab.suspendWebGl();

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
    if (tab.isResumableAgent && (tab.agentSessionId || tab.claudeSessionId)) {
      const sessionId = tab.agentSessionId ?? tab.claudeSessionId;
      return {
        sessionType: tab.sessionType,
        label: tab.label,
        agentSessionId: sessionId!,
        claudeSessionId: sessionId!,
        durableSessionId: tab.durableSessionId ?? undefined,
        closedAt: Date.now(),
        itemId,
        recoveryMode: "resume",
        cwd: tab.launchCwd,
        command: tab.launchCommandArgs?.[0] || tab.launchShell,
        commandArgs: tab.launchCommandArgs,
        profileId: tab.profileId,
        profileColor: tab.profileColor,
        paramPassMode: tab.paramPassMode,
      };
    }

    const command = tab.launchCommandArgs?.[0] || tab.launchShell;
    if (!command || !tab.launchCwd) {
      return null;
    }

    return {
      sessionType: tab.sessionType,
      label: tab.label,
      agentSessionId: null,
      claudeSessionId: null,
      durableSessionId: tab.durableSessionId ?? undefined,
      closedAt: Date.now(),
      itemId,
      recoveryMode: "relaunch",
      cwd: tab.launchCwd,
      command,
      commandArgs: tab.launchCommandArgs,
      profileId: tab.profileId,
      profileColor: tab.profileColor,
      paramPassMode: tab.paramPassMode,
    };
  }

  private matchesRecoverySession(
    tab: TerminalTab,
    session: Pick<
      PersistedSession | ClosedSessionEntry,
      | "sessionType"
      | "label"
      | "agentSessionId"
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
      const sessionId = session.agentSessionId || session.claudeSessionId;
      const tabSessionId = tab.agentSessionId || tab.claudeSessionId;
      return !!sessionId && tabSessionId === sessionId;
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
            agentSessionId: session.agentSessionId,
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
      agentSessionId?: string | null;
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
      const entrySessionId = entry.agentSessionId || entry.claudeSessionId;
      const candidateSessionId = candidate.agentSessionId || candidate.claudeSessionId;
      return !!entrySessionId && candidateSessionId === entrySessionId;
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
      agentSessionId: session.agentSessionId,
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
    const sessionType = agentTypeToSessionType(
      profile.agentType,
      profile.useContext,
      profile.agentType === "custom" ? profile.id : undefined,
    );
    const command = this.profileManager.resolveCommand(profile, fresh);
    const cwd = this.profileManager.resolveCwd(profile, fresh);
    const extraArgs = this.profileManager.resolveArguments(profile, fresh);
    const label = profile.button.label || profile.name;

    // Determine whether params (arguments + context prompt) should be passed on launch
    const passParamsOnLaunch =
      profile.paramPassMode === "launch-only" || profile.paramPassMode === "both";

    const item = this.getActiveItem();

    if (profile.agentType === "shell") {
      // Expand item placeholders in arguments for shell profiles
      let expandedArgs = passParamsOnLaunch ? extraArgs : "";
      if (item && expandedArgs) {
        expandedArgs = expandProfilePlaceholders(expandedArgs, item, "$sessionId");
      }
      const commandArgs = expandedArgs ? parseExtraArgs(expandedArgs) : [];
      const expandedCwd = expandTilde(cwd);
      const tab = this.tabManager.createTab(
        command,
        expandedCwd,
        label,
        "shell",
        undefined,
        commandArgs.length > 0 ? commandArgs : undefined,
      );
      if (tab) {
        tab.profileId = profile.id;
        if (profile.button.color) tab.profileColor = profile.button.color;
      }
      this.renderTabBar();
      return;
    }

    // Build context prompt first so $workTerminalPrompt can be resolved in args
    let prompt: string | undefined;
    if (passParamsOnLaunch && profile.useContext && item) {
      const contextTemplate = this.profileManager.resolveContextPrompt(profile, fresh);
      if (contextTemplate) {
        // Build from adapter prompt + profile context template
        const adapterPrompt = profile.suppressAdapterPrompt
          ? null
          : this.promptBuilder.buildPrompt(item, this.resolveWorkItemPath(item.path));
        // Defer $sessionId in context template too (no $workTerminalPrompt in context itself)
        const expandedContext = expandProfilePlaceholders(contextTemplate, item, "$sessionId");
        prompt = adapterPrompt ? adapterPrompt + "\n\n" + expandedContext : expandedContext;
      } else {
        // Fall back to standard context prompt building
        prompt = await this.getAgentContextPrompt(item, fresh, profile.suppressAdapterPrompt);
      }
      if (!prompt) {
        if (!profile.suppressAdapterPrompt) {
          new Notice("Could not build a contextual prompt for this item");
          return;
        }
        // suppressAdapterPrompt is on but no template exists - launch without context.
        // Use empty string (not undefined) so spawnAgentSession knows prompt was
        // intentionally omitted and won't auto-build one from the adapter.
        prompt = "";
      }
    }

    // Expand item placeholders in arguments (defer $sessionId until the real ID is known)
    // $workTerminalPrompt resolves to the assembled context prompt above
    let expandedArgs = passParamsOnLaunch ? extraArgs : "";
    if (item && expandedArgs) {
      expandedArgs = expandProfilePlaceholders(expandedArgs, item, "$sessionId", prompt);
    }

    // Profile's resolveArguments() already includes global args, so skip the
    // global merge inside spawnAgentSession to avoid doubling them.
    const resumeConfigOverrides =
      profile.agentType === "custom" ? getProfileResumeConfig(profile) : undefined;
    await this.spawnAgentSession({
      agentType: profile.agentType,
      sessionType,
      command,
      cwd,
      extraArgs: expandedArgs,
      skipGlobalArgs: true,
      label,
      prompt,
      freshSettings: fresh,
      resumeConfigOverrides,
    });

    // Apply profile metadata to the newly created tab
    const activeItemId = this.tabManager.getActiveItemId();
    if (activeItemId) {
      const tabs = this.tabManager.getTabs(activeItemId);
      const lastTab = tabs[tabs.length - 1];
      if (lastTab) {
        lastTab.profileId = profile.id;
        if (profile.button.color) lastTab.profileColor = profile.button.color;
        if (profile.paramPassMode !== "launch-only") {
          lastTab.paramPassMode = profile.paramPassMode;
        }
        // Set activity patterns from the resolved resume config
        const resolvedConfig = resumeConfigOverrides ?? getResumeConfig(profile.agentType);
        if (resolvedConfig.activityPatterns) {
          lastTab.activityPatterns = resolvedConfig.activityPatterns;
        }
        this.renderTabBar();
      }
    }
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
    await this.spawnAgentSession({ agentType: "claude", sessionType: "claude" });
  }

  private async spawnClaudeWithContext(): Promise<void> {
    await this.spawnAgentSession({ agentType: "claude", sessionType: "claude-with-context" });
  }

  async spawnClaudeWithPrompt(prompt: string, label?: string): Promise<void> {
    await this.spawnAgentSession({
      agentType: "claude",
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
              paramPassMode: persisted.paramPassMode,
              profileId: persisted.profileId,
              ...this.getSavedResumeLaunchContext(persisted),
            })
          : null;

    if (!tab) return;

    if (persisted.profileId) {
      tab.profileId = persisted.profileId;
      const profile = this.profileManager?.getProfile(persisted.profileId);
      if (profile?.button.color) {
        tab.profileColor = profile.button.color;
      } else if (persisted.profileColor) {
        tab.profileColor = persisted.profileColor;
      }
    } else if (persisted.profileColor) {
      tab.profileColor = persisted.profileColor;
    }
    if (persisted.paramPassMode) {
      tab.paramPassMode = persisted.paramPassMode;
    }

    // Remove eagerly so data.json reflects the live session, not a pending
    // resume.  If the process dies within 5s, re-add so the user can retry.
    this.removePersistedSession(persisted);
    this.persistSessions().catch(() => {});

    this.trackRecoverySuccess(
      tab,
      () => {}, // success - already removed, nothing to do
      () => {
        // Process died within 5s - restore so the user can retry
        this.persistedSessions.push(persisted);
        this.persistSessions().catch(() => {});
      },
    );

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
    paramPassMode?: ParamPassMode;
    profileId?: string;
  }): TerminalTab | null {
    const { agentType } = sessionTypeToAgentType(options.sessionType);

    // Look up originating profile if available
    const profile = options.profileId
      ? this.profileManager?.getProfile(options.profileId)
      : undefined;
    const resumeConfig =
      profile && profile.agentType === "custom"
        ? getProfileResumeConfig(profile)
        : getResumeConfig(agentType);

    const configuredCwd = expandTilde(
      this.getStringSetting(options.freshSettings, "core.defaultTerminalCwd", "~"),
    );
    const cwd = options.cwd || configuredCwd;
    const configuredCommand =
      profile?.command?.trim() ||
      this.getStringSetting(
        options.freshSettings,
        resumeConfig.commandSettingKey,
        resumeConfig.defaultCommand,
      );
    const savedResolution = options.resolvedCommand
      ? resolveCommandInfo(options.resolvedCommand, cwd)
      : null;
    const command = savedResolution?.found
      ? savedResolution.resolved
      : this.resolveAgentCommandOrNotice(agentType, configuredCommand, configuredCwd);
    if (!command) {
      return null;
    }

    // Build resume flag based on agent type's format
    const args =
      resumeConfig.resumeFlagFormat === "flag-equals"
        ? [`${resumeConfig.resumeFlag}=${options.sessionId}`]
        : [resumeConfig.resumeFlag, options.sessionId];

    // When paramPassMode is "launch-only", skip stored profile args on resume
    // and fall through to global defaults only
    const passParamsOnResume =
      options.paramPassMode === "resume-only" || options.paramPassMode === "both";
    const globalExtraArgs = resumeConfig.extraArgsSettingKey
      ? this.getStringSetting(options.freshSettings, resumeConfig.extraArgsSettingKey, "")
      : "";
    const extraArgs = passParamsOnResume ? options.extraArgs || globalExtraArgs : globalExtraArgs;
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

  private async restartAgentTab(tab: TerminalTab, _index: number): Promise<void> {
    const targetItemId = tab.taskPath ?? this.tabManager.getActiveItemId();
    if (!targetItemId) return;

    // Record the old tab's position so the replacement can take its place
    const oldTabs = this.tabManager.getTabs(targetItemId);
    const oldIndex = oldTabs.indexOf(tab);

    const fresh = await this.loadFreshSettings();
    const fallbackCwd = expandTilde(this.getStringSetting(fresh, "core.defaultTerminalCwd", "~"));
    const { agentType } = sessionTypeToAgentType(tab.sessionType);
    const profile = tab.profileId ? this.profileManager?.getProfile(tab.profileId) : undefined;
    const resumeConfig =
      profile && profile.agentType === "custom"
        ? getProfileResumeConfig(profile)
        : getResumeConfig(agentType);
    let replacement: TerminalTab | null;
    if (tab.agentSessionId) {
      const fallbackCommand = profile?.command?.trim();
      replacement = this.createResumedTab({
        targetItemId,
        sessionType: tab.sessionType,
        label: tab.label,
        sessionId: tab.agentSessionId,
        freshSettings: fresh,
        cwd: tab.launchCommandArgs?.length ? tab.launchCwd : fallbackCwd,
        resolvedCommand:
          tab.launchCommandArgs?.[0] ||
          resolveCommand(
            fallbackCommand ||
              this.getStringSetting(
                fresh,
                resumeConfig.commandSettingKey,
                resumeConfig.defaultCommand,
              ),
          ),
        extraArgs: this.extractResumeExtraArgs(tab.sessionType, tab.launchCommandArgs),
        paramPassMode: tab.paramPassMode,
        profileId: tab.profileId,
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
      replacement = await this.spawnAgentSession({
        agentType,
        sessionType: tab.sessionType,
        cwd: fallbackCwd,
        label: tab.label,
        freshSettings: fresh,
        targetItemId,
      });
    }

    if (!replacement) return;

    // Close the old tab first, then move replacement to the old position
    this.tabManager.closeTabInstance(targetItemId, tab);
    if (oldIndex >= 0) {
      this.tabManager.moveTabToIndex(targetItemId, replacement, oldIndex);
    }
  }

  /**
   * Extract extra args from a previous launch's command args, stripping the
   * resume flag (and its value) plus any context prompt so they can be
   * regenerated fresh on resume.
   *
   * Uses AgentResumeConfig rather than per-agent branching:
   * - All known resume flags (from every agent type) are stripped, since
   *   persisted command args may contain flags from any historical launch.
   * - `promptInjectionMode` + `promptFlag` from the current agent's config
   *   determine how to recognise and strip the context prompt.
   *
   * For "positional" prompt injection, the context prompt is the argument
   * immediately after the resume flag + value pair. For "flag" injection
   * (e.g. copilot's "-i"), the prompt flag and its value are stripped
   * wherever they appear in the arg list.
   */
  private extractResumeExtraArgs(
    sessionType: PersistedSession["sessionType"],
    commandArgs?: string[],
  ): string[] {
    if (!commandArgs?.length) {
      return [];
    }
    const args = commandArgs.slice(1);
    const { withContext } = sessionTypeToAgentType(sessionType);
    const resumeConfig = getResumeConfig(sessionTypeToAgentType(sessionType).agentType);
    const { promptInjectionMode, promptFlag } = resumeConfig;

    // Collect all known resume flags so we strip any that appear in
    // historical command args, regardless of which agent spawned them.
    const allResumeFlags = getAllResumeFlags();
    const allResumePrefixes = allResumeFlags.map((f) => f + "=");

    const extraArgs: string[] = [];

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];

      // Strip flag-based context prompt (e.g. copilot's "-i <prompt>")
      if (withContext && promptInjectionMode === "flag" && promptFlag && arg === promptFlag) {
        if (i + 1 < args.length) {
          i++; // skip the prompt value
        }
        continue;
      }

      // Strip any known resume flag in "flag-space" format (e.g. "--session-id <id>")
      if (allResumeFlags.includes(arg)) {
        if (i + 1 < args.length) {
          i++; // skip the session-id value
        }
        // For positional prompt injection, the context prompt follows the
        // resume flag + value pair as the next argument
        if (withContext && promptInjectionMode === "positional" && i + 1 < args.length) {
          i++; // skip the trailing context prompt
        }
        continue;
      }

      // Strip any known resume flag in "flag-equals" format (e.g. "--resume=<id>")
      if (allResumePrefixes.some((prefix) => arg.startsWith(prefix))) {
        // For positional prompt injection, context prompt follows as the next arg
        if (withContext && promptInjectionMode === "positional" && i + 1 < args.length) {
          i++; // skip the trailing context prompt
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

  /**
   * @deprecated Use getAgentContextPrompt instead. Kept for backward compatibility.
   */
  async getClaudeContextPrompt(
    item: WorkItem,
    freshSettings?: Record<string, unknown>,
    suppressAdapterPrompt = false,
  ): Promise<string | null> {
    return this.getAgentContextPrompt(item, freshSettings, suppressAdapterPrompt);
  }

  async getAgentContextPrompt(
    item: WorkItem,
    freshSettings?: Record<string, unknown>,
    suppressAdapterPrompt = false,
  ): Promise<string | null> {
    const settings = freshSettings ?? (await this.loadFreshSettings());
    const resolvedPath = this.resolveWorkItemPath(item.path);
    const basePrompt = suppressAdapterPrompt
      ? null
      : this.promptBuilder.buildPrompt(item, resolvedPath);
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
    return entry.agentSessionId || entry.claudeSessionId || null;
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
      // NOTE: duplicated settings-open logic (see also ~line 297). Extract a helper in a follow-up.
      () => {
        (this.plugin.app as any).setting.open();
        (this.plugin.app as any).setting.openTabById(this.plugin.manifest.id);
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
              paramPassMode: claimedEntry.paramPassMode,
              profileId: claimedEntry.profileId,
              ...this.getSavedResumeLaunchContext(claimedEntry),
            })
          : null;

    if (!tab) {
      this.recentlyClosedStore.add(claimedEntry);
      this.syncRecentlyClosedState();
      this.persistRecentlyClosedSessions().catch(() => {});
      return;
    }

    if (claimedEntry.profileId) {
      tab.profileId = claimedEntry.profileId;
      const profile = this.profileManager?.getProfile(claimedEntry.profileId);
      if (profile?.button.color) {
        tab.profileColor = profile.button.color;
      } else if (claimedEntry.profileColor) {
        tab.profileColor = claimedEntry.profileColor;
      }
    } else if (claimedEntry.profileColor) {
      tab.profileColor = claimedEntry.profileColor;
    }
    if (claimedEntry.paramPassMode) {
      tab.paramPassMode = claimedEntry.paramPassMode;
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

  /**
   * Unified agent session spawner. Dispatches via AgentResumeConfig to handle
   * command resolution, session ID generation, argument building, and tab
   * creation for any agent type.
   */
  private async spawnAgentSession(options: {
    agentType: AgentType;
    sessionType: SessionType;
    cwd?: string;
    command?: string;
    extraArgs?: string;
    skipGlobalArgs?: boolean;
    label?: string;
    prompt?: string;
    freshSettings?: Record<string, unknown>;
    /** Override the base resume config (used for custom agent profiles). */
    resumeConfigOverrides?: AgentResumeConfig;
  }): Promise<TerminalTab | null> {
    const resumeConfig = options.resumeConfigOverrides ?? getResumeConfig(options.agentType);
    const { withContext } = sessionTypeToAgentType(options.sessionType);

    // Build context prompt on demand if this is a context session without one.
    // Check for undefined (not falsy) so callers can pass "" to explicitly skip
    // auto-building a context prompt (e.g. when suppressAdapterPrompt is set).
    let prompt = options.prompt;
    if (withContext && prompt === undefined) {
      const item = this.getActiveItem();
      if (!item) {
        new Notice(
          `Select a ${this.adapter.config.itemName} first to launch ${resumeConfig.cliDisplayName} with context`,
        );
        return null;
      }
      const fresh = options.freshSettings ?? (await this.loadFreshSettings());
      prompt = await this.getAgentContextPrompt(item, fresh);
      if (!prompt) {
        new Notice("Could not build a contextual prompt for this item");
        return null;
      }
      options.freshSettings = fresh;
    }

    const fresh = options.freshSettings ?? (await this.loadFreshSettings());
    const agentCmd =
      options.command ||
      this.getStringSetting(fresh, resumeConfig.commandSettingKey, resumeConfig.defaultCommand);
    const cwd = expandTilde(
      options.cwd || this.getStringSetting(fresh, "core.defaultTerminalCwd", "~"),
    );
    const resolved = this.resolveAgentCommandOrNotice(options.agentType, agentCmd, cwd);
    if (!resolved) {
      return null;
    }

    // Generate session ID for resumable agents, unless this agent type defers
    // session ID detection when a prompt is present (e.g. Copilot's --resume
    // flag conflicts with -i, so fresh context sessions omit it and discover
    // the session ID from log files after spawn).
    const deferDetection = resumeConfig.deferSessionId && !!prompt;
    const sessionId = resumeConfig.resumable && !deferDetection ? crypto.randomUUID() : undefined;

    // Merge extra args (skip global merge when profile already includes them)
    const rawExtraArgs = options.skipGlobalArgs
      ? options.extraArgs || ""
      : mergeExtraArgs(
          this.getStringSetting(fresh, resumeConfig.extraArgsSettingKey, ""),
          options.extraArgs || "",
        );
    // Replace or strip deferred $sessionId placeholders in extra args and prompt
    const mergedExtraArgs = rawExtraArgs.replace(/\$sessionId/g, sessionId || "");
    if (prompt) {
      prompt = prompt.replace(/\$sessionId/g, sessionId || "");
    }

    // Build args via the unified buildAgentArgs helper
    const baseArgs = buildAgentArgs(
      options.agentType,
      mergedExtraArgs,
      prompt,
      undefined,
      options.resumeConfigOverrides,
    );

    // Prepend session/resume flag for resumable agents (skip when deferring)
    let args: string[];
    if (sessionId) {
      if (resumeConfig.resumeFlagFormat === "flag-equals") {
        args = [`${resumeConfig.resumeFlag}=${sessionId}`, ...baseArgs];
      } else {
        args = [resumeConfig.resumeFlag, sessionId, ...baseArgs];
      }
    } else {
      args = baseArgs;
    }

    const label = options.label || getDefaultSessionLabel(options.sessionType);
    const tab = this.tabManager.createTab(
      resolved,
      cwd,
      label,
      options.sessionType,
      undefined,
      [resolved, ...args],
      sessionId ?? null,
    );
    if (tab && this.adapter.transformSessionLabel) {
      tab.transformLabel = (old, detected) => this.adapter.transformSessionLabel!(old, detected);
    }
    this.renderTabBar();
    return tab;
  }

  private resolveAgentCommandOrNotice(
    agent: AgentType,
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

  /**
   * Clear all persisted and recently-closed resume sessions for an item.
   * Removes the indicator from the card by triggering a session badge refresh.
   */
  async clearResumeSessionsForItem(itemId: string): Promise<void> {
    // Remove from persisted sessions (both pending and durable)
    this.pendingPersistedSessions = this.pendingPersistedSessions.filter(
      (session) => session.taskPath !== itemId,
    );
    this.persistedSessions = this.persistedSessions.filter(
      (session) => session.taskPath !== itemId,
    );
    this.syncPersistedSessionState(this.persistedSessions);

    // Remove from recently-closed store
    this.recentlyClosedStore.removeByItemId(itemId);
    this.syncRecentlyClosedState();

    try {
      await this.persistClearedResumeState();
    } catch (error) {
      console.error("[work-terminal] Failed to persist cleared resume sessions:", error);
      new Notice("Cleared resume sessions in the UI, but failed to save the updated resume state.");
    } finally {
      // Trigger session badge refresh (via the onSessionChange callback)
      this.onSessionChange();
    }
  }

  getPendingPersistedSessionsForPersist(): PersistedSession[] {
    return this.pendingPersistedSessions.map((session) => ({
      ...session,
      commandArgs: session.commandArgs ? [...session.commandArgs] : undefined,
    }));
  }

  private async persistClearedResumeState(): Promise<void> {
    if (this.isDisposed) return;
    this.recalculatePendingPersistedSessions();
    const persistedSessions = SessionPersistence.mergePersistedSessions(
      this.pendingPersistedSessions,
      this.getLiveSessionsAcrossViews(),
    );
    const recentlyClosed = this.recentlyClosedStore.serialize();
    await mergeAndSavePluginData(this.plugin, async (data) => {
      SessionPersistence.setPersistedSessions(data, persistedSessions);
      if (recentlyClosed.length > 0) {
        data.recentlyClosedSessions = recentlyClosed;
      } else {
        delete data.recentlyClosedSessions;
      }
    });
    if (this.isDisposed) return;
    this.syncPersistedSessionState(persistedSessions);
    this.syncRecentlyClosedState();
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
