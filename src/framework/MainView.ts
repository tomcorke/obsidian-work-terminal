/**
 * MainView - ItemView with 2-panel resizable split layout.
 *
 * Left: ListPanel (work items)
 * Right: TerminalPanelView (terminals)
 *
 * Detail panel (if adapter provides createDetailView) is an Obsidian workspace
 * leaf created via createLeafBySplit - managed entirely by the adapter.
 *
 * Handles vault events (create/delete/rename) with debounced refresh and
 * delete-create rename detection for shell mv operations.
 */
import { ItemView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import type { Plugin, EventRef } from "obsidian";
import type { AdapterBundle, WorkItem, WorkItemParser } from "../core/interfaces";
import { VIEW_TYPE } from "./PluginBase";
import { ListPanel } from "./ListPanel";
import { TerminalPanelView } from "./TerminalPanelView";
import { PromptBox } from "./PromptBox";
import { loadAllSettings, SETTINGS_CHANGED_EVENT } from "./SettingsTab";
import { formatVersionForTabTitle } from "./version";
import { SessionStore } from "../core/session/SessionStore";
import { mergeAndSavePluginData } from "../core/PluginDataStore";
import { PinStore } from "../core/PinStore";
import { LastActiveStore } from "../core/LastActiveStore";
import { extractYamlFrontmatterString } from "../core/frontmatter";
import { titleCase } from "../core/utils";
import { GuidedTourController, shouldAutoStartGuidedTour } from "./GuidedTour";
import type { AgentProfileManager } from "../core/agents/AgentProfileManager";
import type { AgentProfile } from "../core/agents/AgentProfile";
import { ActivityTracker } from "./ActivityTracker";

interface PendingRename {
  uuid: string | null;
  path: string;
  timeout: ReturnType<typeof setTimeout>;
}

export class MainView extends ItemView {
  private adapter: AdapterBundle;
  private pluginRef: Plugin & { isReloading: boolean; profileManager: AgentProfileManager | null };

  // Panels
  private listPanel: ListPanel | null = null;
  private terminalPanel: TerminalPanelView | null = null;
  private promptBox: PromptBox | null = null;
  private guidedTour: GuidedTourController | null = null;

  // Layout elements
  private leftPanelEl: HTMLElement | null = null;
  private rightPanelEl: HTMLElement | null = null;

  // Vault event handling
  private vaultEventRefs: EventRef[] = [];
  private refreshDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingRenames: Map<string, PendingRename> = new Map();
  private pendingSelectionBackfills: Map<string, Promise<void>> = new Map();
  private pendingCustomOrderOverride: Record<string, string[]> | null = null;
  private pendingCustomOrderWriteId = 0;

  // Cached settings for parser/mover creation in refreshList
  private settings: Record<string, unknown> = {};

  // Cached parser instance (created once in initPanels, reused in refreshList)
  private parser: WorkItemParser | null = null;

  // Agent profile manager
  private profileManager: AgentProfileManager | null = null;

  // Activity tracking
  private activityTracker: ActivityTracker = new ActivityTracker();
  private lastActiveStore: LastActiveStore;

  // Adapter-contributed style element
  private adapterStyleEl: HTMLStyleElement | null = null;

  // Resize observer for terminal refit on view switch
  private containerObserver: ResizeObserver | null = null;

  // Close guard
  private _beforeUnloadHandler: ((e: BeforeUnloadEvent) => void) | null = null;
  private _origLeafDetach: (() => void) | null = null;

  // Settings change handler - keeps this.settings in sync and notifies adapter
  private readonly _handleSettingsChanged = (event: Event) => {
    const prevCreationColumnIds = this.adapter.config.creationColumns;
    const prevPlacement = this.settings["core.detailViewPlacement"];
    const prevShowVersion = this.settings["core.showVersionInTabTitle"];
    this.settings = { ...(event as CustomEvent<Record<string, any>>).detail };
    // Re-render the tab header if the version-in-tab-title toggle changed.
    // Obsidian re-reads `getDisplayText()` during `leaf.updateHeader()`.
    if (prevShowVersion !== this.settings["core.showVersionInTabTitle"]) {
      (this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
    }
    // Notify adapter so it can update internal state (e.g. card flag rules, column order)
    this.adapter.onSettingsChanged?.(this.settings);
    // Keep ListPanel's cached settings in sync so card display mode etc. take effect
    this.listPanel?.updateSettings(this.settings);
    // Only rebuild PromptBox creation columns when they actually changed
    const newCreationColumnIds = this.adapter.config.creationColumns;
    if (prevCreationColumnIds !== newCreationColumnIds) {
      this.promptBox?.updateCreationColumns();
    }
    // If the detail view placement changed, force a clean detach of the
    // previous placement's resources (leaf, embedded reparent, preview
    // overlay + vault modify listener) and re-mount the current selection
    // at the new placement. Without this, switching away from "preview"
    // would only hide the DOM while leaving TaskPreviewView's modify
    // listener alive; switching *to* preview while an item was already
    // selected would render the Preview pseudo-tab without ever calling
    // createDetailView, so the host / content would stay unmounted until
    // the next reselect.
    const newPlacement = this.settings["core.detailViewPlacement"];
    if (prevPlacement !== newPlacement) {
      this.remountDetailViewForCurrentSelection();
    }
    this.scheduleRefresh();
  };

  /**
   * Detach the adapter's detail view and re-mount it for the currently
   * selected item (if any) at the current placement. Called when the
   * detail view placement setting changes so the switch takes effect
   * without requiring the user to reselect an item. Safe to call when
   * nothing is selected or when the adapter does not provide a detail
   * view - both short-circuit to the detach-only path.
   */
  private remountDetailViewForCurrentSelection(): void {
    this.adapter.detachDetailView?.();
    if (typeof this.adapter.createDetailView !== "function") return;
    const activeItemId = this.terminalPanel?.getActiveItemId() ?? null;
    if (!activeItemId) return;
    const item = this.allItems.find((i) => i.id === activeItemId) ?? null;
    if (!item) return;
    const placement = this.settings["core.detailViewPlacement"];
    const embeddedHost =
      placement === "embedded" ? (this.terminalPanel?.getEmbeddedDetailHost() ?? null) : null;
    const previewHost =
      placement === "preview" ? (this.terminalPanel?.getPreviewDetailHost() ?? null) : null;
    this.adapter.createDetailView(item, this.app, this.leaf, embeddedHost, previewHost);
    if (placement === "embedded" && embeddedHost) {
      this.terminalPanel?.activateEmbeddedDetail();
    } else {
      this.terminalPanel?.deactivateEmbeddedDetail();
    }
    if (placement === "preview" && previewHost) {
      this.terminalPanel?.activatePreviewDetail();
    } else {
      this.terminalPanel?.deactivatePreviewDetail();
    }
  }

  constructor(
    leaf: WorkspaceLeaf,
    adapter: AdapterBundle,
    plugin: Plugin & { isReloading: boolean; profileManager: AgentProfileManager | null },
  ) {
    super(leaf);
    this.adapter = adapter;
    this.pluginRef = plugin;
    this.lastActiveStore = new LastActiveStore(plugin);
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    // Version suffix is gated behind `core.showVersionInTabTitle` (default
    // true). `this.settings` may be empty before `initPanels()` has run -
    // Obsidian calls getDisplayText() during view registration, well before
    // onOpen(). Treat an absent setting as "enabled" so the first paint
    // matches the default-on behaviour.
    const showVersion = this.settings["core.showVersionInTabTitle"] !== false;
    return "Work Terminal" + formatVersionForTabTitle(showVersion);
  }

  getIcon(): string {
    return "terminal";
  }

  async onOpen(): Promise<void> {
    (this.pluginRef as any).rememberWorkTerminalLeaf?.(this.leaf);
    const container = this.contentEl;
    container.empty();
    container.addClass("wt-main-view");

    // Build layout
    this.buildLayout(container);

    // Initialize framework components
    await this.initPanels();

    // Register vault events
    this.registerVaultEvents();

    // Intercept tab close to confirm when active sessions exist
    this.installCloseGuard();

    // Listen for settings changes to keep cached settings current
    window.addEventListener(SETTINGS_CHANGED_EVENT, this._handleSettingsChanged as EventListener);

    // Warn on app quit with active sessions
    this._beforeUnloadHandler = (e: BeforeUnloadEvent) => {
      if (this.terminalPanel?.hasAnySessions()) {
        e.preventDefault();
        e.returnValue = "Active terminal sessions will be lost. Close anyway?";
      }
    };
    window.addEventListener("beforeunload", this._beforeUnloadHandler);

    // ResizeObserver for terminal refit on view show
    this.containerObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        this.terminalPanel?.refitActive();
      });
    });
    this.containerObserver.observe(container);

    // Refit terminals when this leaf becomes active (e.g. switching from
    // another plugin tab in the same pane). The container size may not
    // change, so ResizeObserver alone won't trigger.
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf === this.leaf) {
          (this.pluginRef as any).rememberWorkTerminalLeaf?.(this.leaf);
          // Double-rAF: first frame for layout, second for correct dimensions
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              this.terminalPanel?.refitActive();
            });
          });
        }
      }),
    );

    // Initial data load
    const items = await this.refreshList();

    // Recover selection from hot-reload AFTER list is populated
    const recoveredId = this.terminalPanel?.getRecoveredItemId();
    if (recoveredId) {
      this.listPanel?.selectById(recoveredId);
    }

    // Broadcast agent states for any recovered sessions so ListPanel
    // picks up state indicators that were set before it existed.
    this.terminalPanel?.broadcastAgentStates();

    if (await shouldAutoStartGuidedTour(this.pluginRef, { hasExistingItems: items.length > 0 })) {
      this.guidedTour = new GuidedTourController(this.pluginRef);
      await this.guidedTour.start();
    }
  }

  async copySessionDiagnostics(): Promise<boolean> {
    return (await this.terminalPanel?.copySessionDiagnostics()) ?? false;
  }

  /**
   * Monkey-patch the leaf's detach to show a confirmation dialog when
   * there are active terminal sessions. This prevents accidental close
   * of the plugin tab from killing running sessions.
   */
  private installCloseGuard(): void {
    const leaf = this.leaf as any;
    this._origLeafDetach = leaf.detach.bind(leaf);

    leaf.detach = () => {
      // Allow through if reloading (hot-reload)
      if (this.pluginRef.isReloading) {
        this._origLeafDetach?.();
        return;
      }

      // Check for active sessions - skip confirmation when stash-on-close
      // is enabled since sessions will be preserved in memory
      if (this.terminalPanel?.hasAnySessions()) {
        const keepAlive = this.settings["core.keepSessionsAlive"] ?? true;
        if (!keepAlive) {
          const confirmed = confirm(
            "This tab has active terminal sessions. Closing will end them.\n\nClose anyway?",
          );
          if (!confirmed) return;
        }
      }

      this._origLeafDetach?.();
    };
  }

  private buildLayout(container: HTMLElement): void {
    container.style.display = "flex";
    container.style.height = "100%";
    container.style.overflow = "hidden";

    // Left panel - list
    this.leftPanelEl = container.createDiv({ cls: "wt-left-panel" });
    this.leftPanelEl.style.cssText =
      "width: 280px; min-width: 200px; flex-shrink: 0; display: flex; flex-direction: column; overflow: hidden; border-right: 1px solid var(--background-modifier-border);";

    // Single divider
    this.createDivider(container);

    // Right panel - terminals
    this.rightPanelEl = container.createDiv({ cls: "wt-right-panel" });
    this.rightPanelEl.style.cssText =
      "flex: 1; min-width: 300px; overflow: hidden; position: relative; display: flex; flex-direction: column;";
  }

  private createDivider(container: HTMLElement): HTMLElement {
    const divider = container.createDiv({ cls: "wt-divider" });
    divider.style.cssText = "width: 5px; cursor: col-resize; flex-shrink: 0;";

    let startX = 0;
    let startWidth = 0;

    const onMouseDown = (e: MouseEvent) => {
      e.preventDefault();
      startX = e.clientX;
      if (this.leftPanelEl) {
        startWidth = this.leftPanelEl.offsetWidth;
      }
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      divider.addClass("wt-divider-active");
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!this.leftPanelEl) return;
      const delta = e.clientX - startX;
      const newWidth = Math.max(200, startWidth + delta);
      this.leftPanelEl.style.width = newWidth + "px";
      this.leftPanelEl.style.flexBasis = newWidth + "px";
      this.leftPanelEl.style.flexGrow = "0";
      this.leftPanelEl.style.flexShrink = "0";
      // Trigger terminal refit
      this.terminalPanel?.refitActive();
    };

    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      divider.removeClass("wt-divider-active");
    };

    divider.addEventListener("mousedown", onMouseDown);
    return divider;
  }

  private async initPanels(): Promise<void> {
    if (!this.leftPanelEl || !this.rightPanelEl) return;

    const settings = await loadAllSettings(this.pluginRef, this.adapter);
    this.settings = settings;
    await this.lastActiveStore.load();

    // Allow adapter to perform async initialization (credential fetch, API sync, etc.)
    await this.adapter.onLoad?.(this.app, settings);

    // Inject adapter-contributed CSS
    if (typeof this.adapter.getStyles === "function") {
      const css = this.adapter.getStyles();
      if (css) {
        this.adapterStyleEl = document.createElement("style");
        this.adapterStyleEl.setAttribute("data-work-terminal-adapter", "true");
        this.adapterStyleEl.textContent = css;
        document.head.appendChild(this.adapterStyleEl);
      }
    }

    // Provide adapters with a way to trigger UI refresh (e.g. after API fetch)
    this.adapter.requestRefresh = () => this.scheduleRefresh();

    this.parser = this.adapter.createParser(this.app, "", settings);
    const mover = this.adapter.createMover(this.app, "", settings);
    const cardRenderer = this.adapter.createCardRenderer();
    const promptBuilder = this.adapter.createPromptBuilder();

    // PromptBox at top of left panel
    this.promptBox = new PromptBox(
      this.leftPanelEl,
      this.adapter,
      this.pluginRef,
      settings,
      (path: string) => {
        // Placeholder card callback
        this.listPanel?.addPlaceholder(path);
      },
      (path: string, success: boolean) => {
        // Placeholder resolution callback
        this.listPanel?.resolvePlaceholder(path, success);
      },
      (result, placeholderPath: string) => {
        // New item created - prepend to top of column and track enrichment.
        this.listPanel?.prependToColumn(result.id, result.columnId, placeholderPath);
        if (result.foregroundEnrichment) {
          this.launchForegroundEnrichment(result);
          return;
        }
        if (result.enrichmentDone) {
          this.listPanel?.setIngesting(result.id);
          result.enrichmentDone.then(
            () => this.listPanel?.clearIngesting(result.id),
            () => this.listPanel?.clearIngesting(result.id),
          );
        }
      },
    );

    // Use the profile manager created at plugin load time
    this.profileManager = this.pluginRef.profileManager;

    // Terminal wrapper for TabManager
    const terminalWrapperEl = this.rightPanelEl.createDiv({ cls: "wt-terminal-wrapper" });
    terminalWrapperEl.style.cssText = "flex: 1; overflow: hidden; position: relative;";

    // TerminalPanel
    this.terminalPanel = new TerminalPanelView(
      this.rightPanelEl,
      terminalWrapperEl,
      this.pluginRef,
      this.adapter,
      settings,
      promptBuilder,
      // onAgentStateChange callback
      (itemId: string, state: string) => {
        this.listPanel?.updateAgentState(itemId, state);
        // Record activity for agent state changes (indicates tab usage)
        if (state !== "inactive") {
          this.activityTracker.recordActivity(itemId);
        }
      },
      // onSessionChange callback
      () => {
        this.listPanel?.updateSessionBadges();
        // Record activity for the currently active item when sessions change
        const activeId = this.terminalPanel?.getActiveItemId();
        if (activeId) {
          this.activityTracker.recordActivity(activeId);
        }
      },
      // profileManager
      this.profileManager,
    );

    // ListPanel
    this.listPanel = new ListPanel(
      this.leftPanelEl,
      this.adapter,
      cardRenderer,
      mover,
      this.pluginRef,
      this.terminalPanel,
      settings,
      // onSelect callback
      (item: WorkItem | null) => {
        this.terminalPanel?.setActiveItem(item?.id ?? null);
        this.terminalPanel?.setTitle(item);
        if (item && typeof this.adapter.createDetailView === "function") {
          // Supply a framework host that matches the current placement so
          // the adapter can mount into the right slot. Embedded and preview
          // each own their own sibling slot next to the terminal wrapper;
          // placement-based visibility is toggled via the pseudo-tabs.
          const placement = this.settings?.["core.detailViewPlacement"];
          const embeddedHost =
            placement === "embedded" ? (this.terminalPanel?.getEmbeddedDetailHost() ?? null) : null;
          const previewHost =
            placement === "preview" ? (this.terminalPanel?.getPreviewDetailHost() ?? null) : null;
          this.adapter.createDetailView(item, this.app, this.leaf, embeddedHost, previewHost);
          if (placement === "embedded" && embeddedHost) {
            // Auto-focus the Detail pseudo-tab whenever a new item is
            // selected under embedded placement. Users can still click a
            // terminal tab to flip back to the shell view.
            this.terminalPanel?.activateEmbeddedDetail();
          } else {
            // Placement changed away from embedded: make sure we are not
            // still showing a stale embedded host.
            this.terminalPanel?.deactivateEmbeddedDetail();
          }
          if (placement === "preview" && previewHost) {
            // Auto-focus the Preview pseudo-tab whenever a new item is
            // selected under preview placement. Users can still click a
            // terminal tab to flip back to the shell view.
            this.terminalPanel?.activatePreviewDetail();
          } else {
            // Placement changed away from preview: make sure we are not
            // still showing a stale preview host.
            this.terminalPanel?.deactivatePreviewDetail();
          }
        }
        if (item) {
          void this.ensureSelectedItemHasDurableId(item);
        }
      },
      // onCustomOrderChange callback
      async (order: Record<string, string[]>) => {
        await this.persistCustomOrder(order);
      },
      // onSessionFilterChange callback - persist toggle state
      async (active: boolean) => {
        await mergeAndSavePluginData(this.pluginRef, async (data) => {
          if (!data.settings) data.settings = {};
          data.settings["core.sessionFilterActive"] = active;
        });
      },
    );

    // Initialize PinStore and inject into ListPanel
    const pinStore = new PinStore(this.pluginRef);
    await pinStore.load();
    this.listPanel.setPinStore(pinStore);

    // Initialize ActivityTracker and inject into ListPanel
    this.activityTracker.setFlushCallback(async (itemId: string, isoTimestamp: string) => {
      this.lastActiveStore.set(itemId, isoTimestamp);
    });
    this.listPanel.setActivityTracker(this.activityTracker);

    // Inject profile manager so Split Task / Retry Enrichment can resolve
    // the configured agent profile (#448).
    this.listPanel.setProfileManager(this.profileManager);
  }

  private launchForegroundEnrichment(result: {
    id: string;
    columnId: string;
    path?: string;
    title?: string;
    foregroundEnrichment?: { prompt: string; label?: string };
  }): void {
    const foreground = result.foregroundEnrichment;
    if (!foreground) return;
    if (!result.path) {
      console.warn("[work-terminal] Foreground enrichment requested without a created item path");
      new Notice("Task created, but foreground enrichment could not start: missing task path.");
      return;
    }

    const item: WorkItem = {
      id: result.id,
      path: result.path,
      title: result.title || this.adapter.config.itemName,
      state: result.columnId,
      metadata: {},
    };

    this.allItems = [item, ...this.allItems.filter((existing) => existing.id !== item.id)];
    this.terminalPanel?.setItems(this.allItems);
    this.terminalPanel?.setActiveItem(item.id);
    this.terminalPanel?.setTitle(item);
    this.listPanel?.selectById(item.id, item);

    const launchPromise = this.terminalPanel?.spawnClaudeWithPrompt(
      foreground.prompt,
      foreground.label || "Enrich",
      this.resolveForegroundEnrichmentLaunchOverride() ?? undefined,
      item,
    );
    void launchPromise?.catch((err) => {
      console.error("[work-terminal] foreground enrichment launch failed:", err);
      new Notice("Failed to start foreground enrichment session. See console for details.");
    });
  }

  private resolveForegroundEnrichmentLaunchOverride(): {
    profile: AgentProfile;
    cwdOverride: string;
  } | null {
    if (!this.profileManager) return null;
    const profileId = this.settings["adapter.enrichmentProfile"];
    if (typeof profileId !== "string" || !profileId.trim()) return null;
    const profile = this.profileManager.getProfile(profileId.trim());
    if (!profile) return null;
    return {
      profile,
      cwdOverride: this.profileManager.resolveCwd(profile, this.settings),
    };
  }

  // ---------------------------------------------------------------------------
  // Vault events
  // ---------------------------------------------------------------------------

  private registerVaultEvents(): void {
    const vault = this.app.vault;
    const cache = this.app.metadataCache;

    this.vaultEventRefs.push(
      vault.on("create", (file) => {
        this.handleCreate(file.path);
        this.scheduleRefresh();
      }),
    );

    this.vaultEventRefs.push(
      vault.on("delete", (file) => {
        this.handleDelete(file.path);
        this.scheduleRefresh();
      }),
    );

    this.vaultEventRefs.push(
      vault.on("rename", (file, oldPath) => {
        this.handleRename(file.path, oldPath);
        this.scheduleRefresh();
      }),
    );

    // MetadataCache "changed" as fallback for create - frontmatter
    // isn't parsed when the vault create event fires
    this.vaultEventRefs.push(
      cache.on("changed", (file) => {
        if (this.parser?.isItemFile(file.path)) {
          this.scheduleRefresh();
        }
      }),
    );
  }

  private async handleCreate(path: string): Promise<void> {
    // Check if this resolves a pending rename
    for (const [oldPath, pending] of this.pendingRenames) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!file) continue;

      // Try UUID match first.
      // On just-created files the metadata cache is often empty (race condition),
      // so fall back to reading the raw file content.
      if (pending.uuid) {
        let newUuid = this.app.metadataCache.getCache(path)?.frontmatter?.id ?? null;
        if (!newUuid && file instanceof TFile) {
          try {
            const content = await this.app.vault.cachedRead(file);
            newUuid = extractYamlFrontmatterString(content, "id");
          } catch {
            // File may not be readable yet; fall through to folder heuristic
          }
        }
        if (newUuid && newUuid === pending.uuid) {
          this.completeRename(oldPath, path);
          return;
        }
        if (newUuid) {
          continue;
        }
      }

      // Folder heuristic fallback: same parent folder.
      // Works even when the old entry has a UUID (covers metadata cache misses).
      const oldFolder = oldPath.substring(0, oldPath.lastIndexOf("/"));
      const newFolder = path.substring(0, path.lastIndexOf("/"));
      if (oldFolder === newFolder) {
        this.completeRename(oldPath, path);
        return;
      }
    }
  }

  private handleDelete(path: string): void {
    // Only buffer deletes for items with active terminal sessions
    if (!this.terminalPanel?.hasSessions(path)) return;

    // Capture UUID from MetadataCache before it's cleared
    const cache = this.app.metadataCache.getCache(path);
    const uuid = cache?.frontmatter?.id ?? null;

    const timeout = setTimeout(() => {
      // Rename window expired - treat as real delete
      this.pendingRenames.delete(path);
    }, 2000);

    this.pendingRenames.set(path, { uuid, path, timeout });
  }

  private handleRename(newPath: string, oldPath: string): void {
    // Obsidian's own rename event - update sessions directly
    this.terminalPanel?.rekeyItem(oldPath, newPath);
    this.activityTracker.rekey(oldPath, newPath);
    this.lastActiveStore.rekey(oldPath, newPath);
    if (this.listPanel?.rekeyCustomOrder(oldPath, newPath)) {
      void this.persistCustomOrder();
    }
  }

  private completeRename(oldPath: string, newPath: string): void {
    const pending = this.pendingRenames.get(oldPath);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingRenames.delete(oldPath);
    }
    this.terminalPanel?.rekeyItem(oldPath, newPath);
    this.activityTracker.rekey(oldPath, newPath);
    this.lastActiveStore.rekey(oldPath, newPath);
    if (this.listPanel?.rekeyCustomOrder(oldPath, newPath)) {
      void this.persistCustomOrder();
    }
    this.adapter.rekeyDetailPath?.(oldPath, newPath);
  }

  private scheduleRefresh(): void {
    if (this.refreshDebounceTimer) {
      clearTimeout(this.refreshDebounceTimer);
    }
    this.refreshDebounceTimer = setTimeout(() => {
      this.refreshList();
    }, 150);
  }

  resetParser(): void {
    this.parser = this.adapter.createParser(this.app, "", this.settings);
  }

  private async ensureSelectedItemHasDurableId(item: WorkItem): Promise<void> {
    if (!this.parser?.backfillItemId || item.id !== item.path) {
      return;
    }

    const existing = this.pendingSelectionBackfills.get(item.path);
    if (existing) {
      return existing;
    }

    const task = this.performSelectionBackfill(item).finally(() => {
      this.pendingSelectionBackfills.delete(item.path);
    });
    this.pendingSelectionBackfills.set(item.path, task);
    return task;
  }

  private async performSelectionBackfill(item: WorkItem): Promise<void> {
    const updatedItem = await this.parser?.backfillItemId?.(item);
    if (!updatedItem || updatedItem.id === item.id) {
      return;
    }

    const shouldReselect = this.terminalPanel?.getActiveItemId() === item.id;
    this.terminalPanel?.rekeyItem(item.id, updatedItem.id);
    this.activityTracker.rekey(item.id, updatedItem.id);
    this.lastActiveStore.rekey(item.id, updatedItem.id);
    if (this.listPanel?.rekeyCustomOrder(item.id, updatedItem.id)) {
      await this.persistCustomOrder();
    }
    await this.refreshList();

    if (!shouldReselect) {
      return;
    }

    this.listPanel?.selectById(updatedItem.id);
  }

  private async persistCustomOrder(order?: Record<string, string[]>): Promise<void> {
    const sourceOrder = order || this.listPanel?.getCustomOrder();
    const customOrder = sourceOrder ? this.cloneCustomOrder(sourceOrder) : null;
    if (!customOrder) {
      return;
    }

    const writeId = ++this.pendingCustomOrderWriteId;
    this.pendingCustomOrderOverride = customOrder;
    try {
      await mergeAndSavePluginData(this.pluginRef, async (data) => {
        data.customOrder = customOrder;
      });
    } finally {
      if (this.pendingCustomOrderWriteId === writeId) {
        this.pendingCustomOrderOverride = null;
      }
    }
  }

  private cloneCustomOrder(order: Record<string, string[]>): Record<string, string[]> {
    return Object.fromEntries(
      Object.entries(order).map(([columnId, itemIds]) => [columnId, [...itemIds]]),
    );
  }

  private seedActivityTimestamps(items: WorkItem[]): void {
    for (const item of items) {
      const persisted = this.lastActiveStore.get(item.id);
      if (persisted && !Number.isNaN(Date.parse(persisted))) {
        this.activityTracker.seedTimestamp(item.id, persisted);
        continue;
      }

      const lastActive = (item.metadata as Record<string, unknown>)?.lastActive;
      if (typeof lastActive === "string" && lastActive) {
        this.activityTracker.seedTimestamp(item.id, lastActive);
      }
    }
  }

  /** Cached items reference from the last refreshList call. */
  private allItems: WorkItem[] = [];

  private async refreshList(): Promise<WorkItem[]> {
    if (!this.listPanel || !this.parser) return [];
    const items = await this.parser.loadAll();
    this.allItems = items;
    const groups = this.parser.groupByColumn(items);
    this.seedActivityTimestamps(items);
    if (items.length > 0) {
      this.lastActiveStore.pruneMissingPathIds(items.map((item) => item.id));
    }

    // Parse pinned custom states from settings
    const pinnedJson = (this.settings["adapter.pinnedCustomStates"] as string) || "[]";
    let pinnedCustomStates: string[] = [];
    try {
      const parsed = JSON.parse(pinnedJson);
      if (Array.isArray(parsed)) pinnedCustomStates = parsed;
    } catch {
      /* empty */
    }
    const pinnedSet = new Set(pinnedCustomStates);

    // Determine which columns are predefined (have a folderName)
    const predefinedIds = new Set(
      this.adapter.config.columns.filter((c) => c.folderName).map((c) => c.id),
    );

    // Discover dynamic columns (states in items not in configured columns)
    // and update the adapter config so the SettingsTab column ordering UI
    // includes them. Dynamic columns appear after configured columns.
    const configuredIds = new Set(this.adapter.config.columns.map((c) => c.id));
    const dynamicIds = Object.keys(groups)
      .filter((id) => !configuredIds.has(id) && (groups[id]?.length ?? 0) > 0)
      .sort();
    if (dynamicIds.length > 0) {
      const dynamicColumns = dynamicIds.map((id) => ({
        id,
        label: titleCase(id),
      }));
      // Merge without duplicates - re-add configured columns then dynamic
      this.adapter.config.columns = [
        ...this.adapter.config.columns,
        ...dynamicColumns.filter((dc) => !configuredIds.has(dc.id)),
      ];
    }

    // Auto-cleanup: remove empty, unpinned dynamic columns from the column
    // order settings. Only affects dynamic columns (no folderName) - never
    // predefined ones. Pinned columns are preserved regardless of task count.
    const columnOrderJson = (this.settings["adapter.columnOrder"] as string) || "";
    if (columnOrderJson) {
      let orderIds: string[] = [];
      try {
        const parsed = JSON.parse(columnOrderJson);
        if (Array.isArray(parsed)) orderIds = parsed;
      } catch {
        /* empty */
      }

      const cleanedIds = orderIds.filter((id) => {
        // Keep predefined columns always
        if (predefinedIds.has(id)) return true;
        // Keep pinned dynamic columns even if empty
        if (pinnedSet.has(id)) return true;
        // Keep dynamic columns that have tasks
        if ((groups[id]?.length ?? 0) > 0) return true;
        // Remove empty unpinned dynamic columns
        return false;
      });

      if (cleanedIds.length !== orderIds.length) {
        // Remove cleaned-out columns from the adapter config too
        this.adapter.config.columns = this.adapter.config.columns.filter(
          (c) => c.folderName || pinnedSet.has(c.id) || (groups[c.id]?.length ?? 0) > 0,
        );
        // Persist the cleaned column order
        const newOrderJson = JSON.stringify(cleanedIds);
        this.settings["adapter.columnOrder"] = newOrderJson;
        await mergeAndSavePluginData(this.pluginRef, async (data) => {
          if (!data.settings) data.settings = {};
          data.settings["adapter.columnOrder"] = newOrderJson;
        });
      }
    }

    // Ensure pinned custom state columns appear in the adapter config even
    // when they have zero tasks, so they render as empty columns on the board.
    for (const pinnedId of pinnedCustomStates) {
      if (!this.adapter.config.columns.some((c) => c.id === pinnedId)) {
        this.adapter.config.columns.push({
          id: pinnedId,
          label: titleCase(pinnedId),
        });
      }
    }

    // Pass pinned custom states to ListPanel so it renders empty pinned columns
    this.listPanel.setPinnedCustomStates(pinnedCustomStates);

    const data = (await this.pluginRef.loadData()) || {};
    const customOrder = this.pendingCustomOrderOverride || data.customOrder || {};
    this.listPanel.render(groups, customOrder);
    this.terminalPanel?.setItems(items);
    return items;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async onClose(): Promise<void> {
    if ((this.pluginRef as any)._lastWorkTerminalLeaf === this.leaf) {
      (this.pluginRef as any).rememberWorkTerminalLeaf?.(null);
    }
    // Remove close guards
    if (this._beforeUnloadHandler) {
      window.removeEventListener("beforeunload", this._beforeUnloadHandler);
      this._beforeUnloadHandler = null;
    }
    // Restore original detach if we monkey-patched it
    if (this._origLeafDetach) {
      (this.leaf as any).detach = this._origLeafDetach;
      this._origLeafDetach = null;
    }

    // Stash/dispose terminals FIRST before any other cleanup, because
    // subsequent cleanup (detaching detail view, unregistering events)
    // can trigger selection changes that reset activeItemId to null.
    // Skip stash if already stashed by hotReload() (sessions would be empty).
    const keepAlive = this.settings["core.keepSessionsAlive"] ?? true;
    if (this.pluginRef.isReloading || keepAlive) {
      // Stash sessions to window-global store so PTY processes survive
      // and can be restored when the view is reopened.
      // Only stash if not already stashed (hotReload pre-stashes explicitly)
      if (!SessionStore.isReload()) {
        this.terminalPanel?.stashAll();
      }
    } else {
      this.terminalPanel?.disposeAll();
    }

    this.listPanel?.dispose();
    this.activityTracker.dispose();
    try {
      await this.lastActiveStore.flushNow();
    } catch (err) {
      console.error("[work-terminal] Failed to flush last-active store on close:", err);
    }
    this.lastActiveStore.dispose();

    // Stop listening for settings changes
    window.removeEventListener(
      SETTINGS_CHANGED_EVENT,
      this._handleSettingsChanged as EventListener,
    );

    // Detach adapter's detail leaf
    this.adapter.detachDetailView?.();

    // Clean up guided tour
    this.guidedTour?.dispose();
    this.guidedTour = null;

    // Clean up vault event refs
    for (const ref of this.vaultEventRefs) {
      this.app.vault.offref(ref);
    }
    this.vaultEventRefs = [];

    // Clean up pending renames
    for (const pending of this.pendingRenames.values()) {
      clearTimeout(pending.timeout);
    }
    this.pendingRenames.clear();

    // Clean up resize observer
    this.containerObserver?.disconnect();

    // Clean up adapter-contributed CSS
    if (this.adapterStyleEl) {
      this.adapterStyleEl.remove();
      this.adapterStyleEl = null;
    }

    // Clear adapter refresh callback to prevent refreshes against disposed DOM
    this.adapter.requestRefresh = undefined;

    // Clean up cached parser
    this.parser = null;

    // Clean up debounce timer
    if (this.refreshDebounceTimer) {
      clearTimeout(this.refreshDebounceTimer);
    }
  }
}
