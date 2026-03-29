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
import { ItemView, TFile, WorkspaceLeaf } from "obsidian";
import type { Plugin, EventRef } from "obsidian";
import type { AdapterBundle, WorkItem, WorkItemParser } from "../core/interfaces";
import { VIEW_TYPE } from "./PluginBase";
import { ListPanel } from "./ListPanel";
import { TerminalPanelView } from "./TerminalPanelView";
import { PromptBox } from "./PromptBox";
import { loadAllSettings } from "./SettingsTab";
import { SessionStore } from "../core/session/SessionStore";
import { mergeAndSavePluginData } from "../core/PluginDataStore";

interface PendingRename {
  uuid: string | null;
  path: string;
  timeout: ReturnType<typeof setTimeout>;
}

export class MainView extends ItemView {
  private adapter: AdapterBundle;
  private pluginRef: Plugin & { isReloading: boolean };

  // Panels
  private listPanel: ListPanel | null = null;
  private terminalPanel: TerminalPanelView | null = null;
  private promptBox: PromptBox | null = null;

  // Layout elements
  private leftPanelEl: HTMLElement | null = null;
  private rightPanelEl: HTMLElement | null = null;

  // Vault event handling
  private vaultEventRefs: EventRef[] = [];
  private refreshDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingRenames: Map<string, PendingRename> = new Map();

  // Cached settings for parser/mover creation in refreshList
  private settings: Record<string, unknown> = {};

  // Cached parser instance (created once in initPanels, reused in refreshList)
  private parser: WorkItemParser | null = null;

  // Adapter-contributed style element
  private adapterStyleEl: HTMLStyleElement | null = null;

  // Resize observer for terminal refit on view switch
  private containerObserver: ResizeObserver | null = null;

  // Close guard
  private _beforeUnloadHandler: ((e: BeforeUnloadEvent) => void) | null = null;
  private _origLeafDetach: (() => void) | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    adapter: AdapterBundle,
    plugin: Plugin & { isReloading: boolean },
  ) {
    super(leaf);
    this.adapter = adapter;
    this.pluginRef = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Work Terminal";
  }

  getIcon(): string {
    return "terminal";
  }

  async onOpen(): Promise<void> {
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
    await this.refreshList();

    // Recover selection from hot-reload AFTER list is populated
    const recoveredId = this.terminalPanel?.getRecoveredItemId();
    if (recoveredId) {
      this.listPanel?.selectById(recoveredId);
    }

    // Broadcast Claude states for any recovered sessions so ListPanel
    // picks up state indicators that were set before it existed.
    this.terminalPanel?.broadcastClaudeStates();
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

      // Check for active sessions
      if (this.terminalPanel?.hasAnySessions()) {
        const confirmed = confirm(
          "This tab has active terminal sessions. Closing will end them.\n\nClose anyway?",
        );
        if (!confirmed) return;
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
      (id: string, columnId: string, placeholderPath: string, enrichmentDone?: Promise<void>) => {
        // New item created - prepend to top of column and track enrichment
        this.listPanel?.prependToColumn(id, columnId, placeholderPath);
        if (enrichmentDone) {
          this.listPanel?.setIngesting(id);
          enrichmentDone.then(
            () => this.listPanel?.clearIngesting(id),
            () => this.listPanel?.clearIngesting(id),
          );
        }
      },
    );

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
      // onClaudeStateChange callback
      (itemId: string, state: string) => {
        this.listPanel?.updateClaudeState(itemId, state);
      },
      // onSessionChange callback
      () => {
        this.listPanel?.updateSessionBadges();
        // Persist sessions to disk
        this.terminalPanel?.persistSessions();
      },
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
          this.adapter.createDetailView(item, this.app, this.leaf);
        }
      },
      // onCustomOrderChange callback
      async (order: Record<string, string[]>) => {
        await mergeAndSavePluginData(this.pluginRef, async (data) => {
          data.customOrder = order;
        });
      },
    );
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
            const match = content.match(/^id:\s*(.+)$/m);
            if (match) newUuid = match[1].trim();
          } catch {
            // File may not be readable yet; fall through to folder heuristic
          }
        }
        if (newUuid && newUuid === pending.uuid) {
          this.completeRename(oldPath, path);
          return;
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
    this.listPanel?.rekeyCustomOrder(oldPath, newPath);
    // Persist updated session paths to disk so they survive a full reload
    this.terminalPanel?.persistSessions();
  }

  private completeRename(oldPath: string, newPath: string): void {
    const pending = this.pendingRenames.get(oldPath);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingRenames.delete(oldPath);
    }
    this.terminalPanel?.rekeyItem(oldPath, newPath);
    this.listPanel?.rekeyCustomOrder(oldPath, newPath);
    this.adapter.rekeyDetailPath?.(oldPath, newPath);
    // Persist updated session paths to disk so they survive a full reload
    this.terminalPanel?.persistSessions();
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

  private async refreshList(): Promise<void> {
    if (!this.listPanel || !this.parser) return;
    const items = await this.parser.loadAll();
    const groups = this.parser.groupByColumn(items);
    const data = (await this.pluginRef.loadData()) || {};
    const customOrder = data.customOrder || {};
    this.listPanel.render(groups, customOrder);
    this.terminalPanel?.setItems(items);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async onClose(): Promise<void> {
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
    if (this.pluginRef.isReloading) {
      // Only stash if not already stashed (hotReload pre-stashes explicitly)
      if (!SessionStore.isReload()) {
        this.terminalPanel?.stashAll();
      }
    } else {
      // Persist sessions to disk before disposing so they can be resumed
      await this.terminalPanel?.persistSessions();
      this.terminalPanel?.disposeAll();
    }

    // Detach adapter's detail leaf
    this.adapter.detachDetailView?.();

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
