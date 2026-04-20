/**
 * TerminalPanelView - wraps TabManager with terminal launch buttons,
 * custom session spawning, state aggregation, tab context menu, and
 * inline rename.
 */
import { Menu, Notice } from "obsidian";

import type { Plugin } from "obsidian";
import { TabManager } from "../core/terminal/TabManager";
import type { TerminalTab, AgentState } from "../core/terminal/TerminalTab";
import {
  buildMissingCliNotice,
  resolveCommandInfo,
  buildAgentArgs,
  mergeExtraArgs,
  parseExtraArgs,
} from "../core/agents/AgentLauncher";
import { SessionStore } from "../core/session/SessionStore";
import type {
  ActiveTabInfo,
  AgentRuntimeState,
  SessionType,
  TabDiagnostics,
} from "../core/session/types";
import { electronRequire, expandTilde } from "../core/utils";
import type { AdapterBundle, WorkItem, WorkItemPromptBuilder } from "../core/interfaces";
import { mergeAndSavePluginData } from "../core/PluginDataStore";
import { buildAgentContextPrompt, expandProfilePlaceholders } from "./AgentContextPrompt";
import { ProfileLaunchModal, type ProfileLaunchOverrides } from "./ProfileLaunchModal";
import { SETTINGS_CHANGED_EVENT } from "./SettingsTab";
import { getDefaultSessionLabel } from "./CustomSessionConfig";
import type { AgentProfileManager } from "../core/agents/AgentProfileManager";
import { PROFILES_CHANGED_EVENT } from "../core/agents/AgentProfileManager";
import type { AgentProfile, AgentType } from "../core/agents/AgentProfile";
import {
  agentTypeToSessionType,
  sessionTypeToAgentType,
  getLaunchConfig,
  getProfileLaunchConfig,
  type AgentLaunchConfig,
} from "../core/agents/AgentProfile";
import { createProfileIcon } from "../ui/ProfileIcons";

interface WorkTerminalDebugSnapshot {
  version: 1;
  activeItemId: string | null;
  activeTabIndex: number;
  activeTabs: ActiveTabInfo[];
  hasHotReloadStore: boolean;
}

interface WorkTerminalDebugApi extends WorkTerminalDebugSnapshot {
  getSnapshot(): WorkTerminalDebugSnapshot;
  getAllActiveTabs(): ActiveTabInfo[];
  findTabsByLabel(label: string): ActiveTabInfo[];
  getSessionDiagnostics(): WorkTerminalSessionDiagnosticsSnapshot;
}

interface DiagnosticsSummary {
  activeItemId: string | null;
  activeTabIndex: number;
  activeItemCount: number;
  activeTabCount: number;
  hasHotReloadStore: boolean;
  derivedCounts: {
    blankButLiveRenderer: number;
    staleDisposedWebglOwnership: number;
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

  // Active items reference (for tab context menu "Move to Item")
  private allItems: WorkItem[] = [];

  // Active inline rename input, if any
  private activeRenameInput: HTMLInputElement | null = null;

  // Delayed click timer for tab switching (cancelled on double-click)
  private tabClickTimer: ReturnType<typeof setTimeout> | null = null;

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
      this.onSessionChange();
    };
    this.tabManager.onAgentStateChange = (itemId: string, state: AgentState) => {
      this.onAgentStateChange(itemId, state);
      this.updateTabStateClasses();
    };

    // Initial tab bar render
    this.renderTabBar();
    this.refreshDebugGlobal();
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
        if (tab.isAgentTab) {
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

    // Move to Item submenu - grouped by column with headers
    if (this.allItems.length > 0) {
      menu.addSeparator();
      const activeItemId = this.tabManager.getActiveItemId();
      const excludedStates = new Set(this.adapter.config.terminalStates ?? []);
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

    const item = this.getActiveItem();

    if (profile.agentType === "shell") {
      // Expand item placeholders in arguments for shell profiles
      let expandedArgs = extraArgs;
      if (item && expandedArgs) {
        const absPath = this.resolveWorkItemPath(item.path);
        expandedArgs = expandProfilePlaceholders(
          expandedArgs,
          item,
          "$sessionId",
          undefined,
          absPath,
        );
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
        if (profile.loginShellWrap) tab.loginShellWrap = true;
      }
      this.renderTabBar();
      return;
    }

    // Build context prompt first so $workTerminalPrompt can be resolved in args
    let prompt: string | undefined;
    if (profile.useContext && item) {
      const contextTemplate = this.profileManager.resolveContextPrompt(profile, fresh);
      if (contextTemplate) {
        // Build from adapter prompt + profile context template
        const adapterPrompt = profile.suppressAdapterPrompt
          ? null
          : this.promptBuilder.buildPrompt(item, this.resolveWorkItemPath(item.path));
        // Defer $sessionId in context template too (no $workTerminalPrompt in context itself)
        const absPath = this.resolveWorkItemPath(item.path);
        const expandedContext = expandProfilePlaceholders(
          contextTemplate,
          item,
          "$sessionId",
          undefined,
          absPath,
        );
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
    let expandedArgs = extraArgs;
    if (item && expandedArgs) {
      const absPath = this.resolveWorkItemPath(item.path);
      expandedArgs = expandProfilePlaceholders(expandedArgs, item, "$sessionId", prompt, absPath);
    }

    // Profile's resolveArguments() already includes global args, so skip the
    // global merge inside spawnAgentSession to avoid doubling them.
    const resolvedConfig = this.resolveLaunchConfig(profile.agentType, profile);
    const launchConfigOverrides = profile.agentType === "custom" ? resolvedConfig : undefined;
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
      launchConfigOverrides,
      loginShellWrap: profile.loginShellWrap,
    });

    // Apply profile metadata to the newly created tab
    const activeItemId = this.tabManager.getActiveItemId();
    if (activeItemId) {
      const tabs = this.tabManager.getTabs(activeItemId);
      const lastTab = tabs[tabs.length - 1];
      if (lastTab) {
        lastTab.profileId = profile.id;
        if (profile.button.color) lastTab.profileColor = profile.button.color;
        // Set activity patterns from the resolved launch config.
        // For custom profiles, explicitly set empty patterns when none are
        // configured so active-indicator checks don't fall back to legacy
        // Claude/Copilot detection.
        lastTab.activityPatterns =
          resolvedConfig.activityPatterns ??
          (profile.agentType === "custom"
            ? { activeLinePatterns: [], activeJoinedPatterns: [] }
            : undefined);
        // Launch through login shell when profile requests it
        if (profile.loginShellWrap) {
          lastTab.loginShellWrap = true;
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

  /**
   * Spawn an agent with a pre-built prompt. Optionally routes through a
   * resolved agent profile so the launched session inherits the profile's
   * command, arguments, cwd, and login-shell wrapping.
   *
   * When `profileOverride` is provided:
   *   - agentType/sessionType come from the profile
   *   - command / cwd / extraArgs are resolved via AgentProfileManager
   *   - `skipGlobalArgs` is set so profile-level arg merging is not doubled
   *   - an explicit `cwd` override wins over the profile's defaultCwd
   *
   * When `profileOverride` is omitted, behaviour matches the legacy call
   * site: plain `claude-with-context` spawn using core settings only.
   */
  async spawnClaudeWithPrompt(
    prompt: string,
    label?: string,
    profileOverride?: {
      profile: AgentProfile;
      cwdOverride?: string;
    },
  ): Promise<void> {
    if (!profileOverride) {
      await this.spawnAgentSession({
        agentType: "claude",
        sessionType: "claude-with-context",
        prompt,
        label: label || "Claude (ctx)",
      });
      return;
    }

    await this.spawnFromResolvedProfile(profileOverride.profile, prompt, {
      label,
      cwdOverride: profileOverride.cwdOverride,
    });
  }

  /**
   * Launch a session for a concrete profile with a pre-assembled prompt.
   * Mirrors `spawnFromProfile` but accepts a caller-supplied prompt and
   * cwd override, used by action-driven launches (split-task, retry-enrichment)
   * rather than interactive button clicks.
   */
  private async spawnFromResolvedProfile(
    profile: AgentProfile,
    prompt: string,
    options: {
      label?: string;
      cwdOverride?: string;
    },
  ): Promise<void> {
    if (!this.profileManager) {
      // Should never happen - fall back to the legacy path rather than throwing.
      await this.spawnAgentSession({
        agentType: "claude",
        sessionType: "claude-with-context",
        prompt,
        label: options.label || "Claude (ctx)",
      });
      return;
    }

    const fresh = await this.loadFreshSettings();
    const sessionType = agentTypeToSessionType(
      profile.agentType,
      profile.useContext,
      profile.agentType === "custom" ? profile.id : undefined,
    );
    const command = this.profileManager.resolveCommand(profile, fresh);
    const cwd = options.cwdOverride || this.profileManager.resolveCwd(profile, fresh);
    const extraArgs = this.profileManager.resolveArguments(profile, fresh);
    const label = options.label || profile.button.label || profile.name;

    // Expand $sessionId lazily (TabManager resolves it) and $workTerminalPrompt now.
    const item = this.getActiveItem();
    let expandedArgs = extraArgs;
    if (item && expandedArgs) {
      const absPath = this.resolveWorkItemPath(item.path);
      expandedArgs = expandProfilePlaceholders(expandedArgs, item, "$sessionId", prompt, absPath);
    }

    const resolvedConfig = this.resolveLaunchConfig(profile.agentType, profile);
    const launchConfigOverrides = profile.agentType === "custom" ? resolvedConfig : undefined;

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
      launchConfigOverrides,
      loginShellWrap: profile.loginShellWrap,
    });

    // Apply profile metadata to the newly created tab so it styles / rekeys
    // identically to button-launched profile sessions.
    const activeItemId = this.tabManager.getActiveItemId();
    if (activeItemId) {
      const tabs = this.tabManager.getTabs(activeItemId);
      const lastTab = tabs[tabs.length - 1];
      if (lastTab) {
        lastTab.profileId = profile.id;
        if (profile.button.color) lastTab.profileColor = profile.button.color;
        lastTab.activityPatterns =
          resolvedConfig.activityPatterns ??
          (profile.agentType === "custom"
            ? { activeLinePatterns: [], activeJoinedPatterns: [] }
            : undefined);
        if (profile.loginShellWrap) {
          lastTab.loginShellWrap = true;
        }
        this.renderTabBar();
      }
    }
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

  private buildSessionDiagnosticsSnapshot(): WorkTerminalSessionDiagnosticsSnapshot {
    const activeTabs = this.tabManager.getTabDiagnostics();
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
    const summary: DiagnosticsSummary = {
      activeItemId: this.tabManager.getActiveItemId(),
      activeTabIndex: this.tabManager.getActiveTabIndex(),
      activeItemCount: items.length,
      activeTabCount: activeTabs.length,
      hasHotReloadStore: SessionStore.isReload(),
      derivedCounts: {
        blankButLiveRenderer: activeTabs.filter((tab) => tab.derived.blankButLiveRenderer).length,
        staleDisposedWebglOwnership: activeTabs.filter(
          (tab) => tab.derived.staleDisposedWebglOwnership,
        ).length,
        disposedTabStillSelected: activeTabs.filter((tab) => tab.derived.disposedTabStillSelected)
          .length,
      },
    };

    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      summary,
      items,
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
    new ProfileLaunchModal(
      this.plugin.app,
      profiles,
      defaultCwd,
      (overrides) => {
        this.launchAction("profile launch", () => this.spawnFromProfileWithOverrides(overrides));
      },
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

  /**
   * Unified agent session spawner. Resolves command, builds arguments, and
   * creates a tab for any agent type.
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
    /** Override the base launch config (used for custom agent profiles). */
    launchConfigOverrides?: AgentLaunchConfig;
    /**
     * When true, use the original unresolved command name in commandArgs
     * instead of the resolved absolute path, so the login shell can invoke
     * shell functions/aliases defined in ~/.zshrc etc.
     */
    loginShellWrap?: boolean;
    /** Create tab for a specific item instead of the active item. */
    targetItemId?: string;
  }): Promise<TerminalTab | null> {
    const launchConfig = options.launchConfigOverrides ?? getLaunchConfig(options.agentType);
    const { withContext } = sessionTypeToAgentType(options.sessionType);

    // Build context prompt on demand if this is a context session without one.
    // Check for undefined (not falsy) so callers can pass "" to explicitly skip
    // auto-building a context prompt (e.g. when suppressAdapterPrompt is set).
    let prompt = options.prompt;
    if (withContext && prompt === undefined) {
      const item = this.getActiveItem();
      if (!item) {
        new Notice(
          `Select a ${this.adapter.config.itemName} first to launch ${launchConfig.cliDisplayName} with context`,
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
      this.getStringSetting(fresh, launchConfig.commandSettingKey, launchConfig.defaultCommand);
    const cwd = expandTilde(
      options.cwd || this.getStringSetting(fresh, "core.defaultTerminalCwd", "~"),
    );
    const resolved = this.resolveAgentCommandOrNotice(options.agentType, agentCmd, cwd);
    if (!resolved) {
      return null;
    }

    // Merge extra args (skip global merge when profile already includes them)
    const mergedExtraArgs = options.skipGlobalArgs
      ? options.extraArgs || ""
      : mergeExtraArgs(
          this.getStringSetting(fresh, launchConfig.extraArgsSettingKey, ""),
          options.extraArgs || "",
        );

    // Build args via the unified buildAgentArgs helper
    const args = buildAgentArgs(
      options.agentType,
      mergedExtraArgs,
      prompt,
      undefined,
      options.launchConfigOverrides,
    );

    const label = options.label || getDefaultSessionLabel(options.sessionType);
    const cmdForArgs = options.loginShellWrap ? agentCmd.trim() : resolved;
    const tab = this.tabManager.createTab(resolved, cwd, label, options.sessionType, undefined, [
      cmdForArgs,
      ...args,
    ]);
    if (tab) {
      if (options.loginShellWrap) {
        tab.loginShellWrap = true;
      }
      if (this.adapter.transformSessionLabel) {
        tab.transformLabel = (old, detected) => this.adapter.transformSessionLabel!(old, detected);
      }
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

  /**
   * Resolve the launch config for an agent type, using profile-level overrides
   * for custom profiles when available.
   */
  private resolveLaunchConfig(
    agentType: AgentType,
    profile?: AgentProfile | null,
  ): AgentLaunchConfig {
    if (profile && profile.agentType === "custom") {
      return getProfileLaunchConfig(profile);
    }
    return getLaunchConfig(agentType);
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

  hasAnySessions(): boolean {
    return this.tabManager.getSessionItemIds().length > 0;
  }

  /** Return item IDs that have active terminal sessions. */
  getSessionItemIds(): string[] {
    return this.tabManager.getSessionItemIds();
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
  }

  stashAll(): void {
    this.isDisposed = true;
    this.detachSettingsListener();
    this.tabBarResizeObserver?.disconnect();
    this.tabBarResizeObserver = null;
    this.tabManager.stashAll();
    this.clearDebugGlobal();
  }

  disposeAll(): void {
    this.isDisposed = true;
    liveTerminalViews.delete(this);
    if (this.tabClickTimer !== null) {
      clearTimeout(this.tabClickTimer);
      this.tabClickTimer = null;
    }
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
      hasHotReloadStore: SessionStore.isReload(),
    };
  }

  private buildRevokedDebugSnapshot(): WorkTerminalDebugSnapshot {
    return {
      version: 1,
      activeItemId: null,
      activeTabIndex: 0,
      activeTabs: [],
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
      get hasHotReloadStore() {
        return getSnapshot().hasHotReloadStore;
      },
      getSnapshot,
      getAllActiveTabs: () => getSnapshot().activeTabs,
      findTabsByLabel: (label: string) =>
        this.canExposeDebugApi() ? this.findTabsByLabel(label) : [],
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
                hasHotReloadStore: false,
                derivedCounts: {
                  blankButLiveRenderer: 0,
                  staleDisposedWebglOwnership: 0,
                  disposedTabStillSelected: 0,
                },
              },
              items: [],
            },
    };
  }
}
