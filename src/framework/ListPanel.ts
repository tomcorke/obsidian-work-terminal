/**
 * ListPanel - column-based work item list with collapsible sections,
 * drag-drop reordering, filtering, selection, session badges, and
 * agent state indicators.
 */
import { Menu, Notice } from "obsidian";
import type { Plugin, TFile } from "obsidian";
import type {
  AdapterBundle,
  WorkItem,
  CardRenderer,
  WorkItemMover,
  WorkItemParser,
  CardActionContext,
  CardDisplayMode,
} from "../core/interfaces";
import type { TerminalPanelView } from "./TerminalPanelView";
import type { PinStore } from "../core/PinStore";
import type { AgentProfileManager } from "../core/agents/AgentProfileManager";
import type { AgentProfile } from "../core/agents/AgentProfile";
import { DangerConfirm } from "./DangerConfirm";
import { electronRequire, slugify, titleCase } from "../core/utils";
import { resolveRetryEnrichmentProfile, resolveSplitTaskProfile } from "./splitTaskProfile";
import {
  type ActivityTracker,
  type ViewMode,
  type RecentThreshold,
  type ActivityBucket,
  ACTIVITY_BUCKETS,
  ACTIVITY_BUCKET_LABELS,
} from "./ActivityTracker";

/** Virtual column ID for the pinned section. Not a real adapter column. */
const PINNED_COLUMN_ID = "__pinned__";

export class ListPanel {
  private containerEl: HTMLElement;
  private listEl: HTMLElement;
  private filterEl: HTMLInputElement;
  private sessionFilterEl: HTMLInputElement;
  private adapter: AdapterBundle;
  private cardRenderer: CardRenderer;
  private mover: WorkItemMover;
  private plugin: Plugin;
  private terminalPanel: TerminalPanelView;

  private settings: Record<string, unknown>;
  private onSelect: (item: WorkItem | null) => void;
  private onCustomOrderChange: (order: Record<string, string[]>) => void;
  private onSessionFilterChange: (active: boolean) => void;
  private pinStore: PinStore | null = null;
  private activityTracker: ActivityTracker | null = null;
  private profileManager: AgentProfileManager | null = null;
  private pinnedCustomStates: Set<string> = new Set();

  // State
  private selectedId: string | null = null;
  private collapsedSections: Set<string> = new Set();
  private filterTerm = "";
  private sessionFilterActive = false;
  private filterDebounce: ReturnType<typeof setTimeout> | null = null;
  private items: WorkItem[] = [];
  private groups: Record<string, WorkItem[]> = {};
  private customOrder: Record<string, string[]> = {};

  // Activity mode: previous bucket assignment per item ID for cross-bucket detection
  private previousBuckets: Map<string, ActivityBucket> = new Map();

  // Placeholders for enrichment
  private placeholders: Map<string, HTMLElement> = new Map();

  // Agent state tracking
  private agentStates: Map<string, string> = new Map();
  private idleSinceMap: Map<string, number> = new Map();

  // Background enrichment tracking
  private ingestingIds: Set<string> = new Set();
  private pendingCreatedIdsByPlaceholder: Map<string, string> = new Map();
  private activeSuccessIds: Set<string> = new Set();
  private successTimeouts: Map<string, ReturnType<typeof setTimeout>> = new Map();

  // Drag state
  private dragSourceId: string | null = null;
  private dragSourceColumn: string | null = null;

  constructor(
    parentEl: HTMLElement,
    adapter: AdapterBundle,
    cardRenderer: CardRenderer,
    mover: WorkItemMover,
    plugin: Plugin,
    terminalPanel: TerminalPanelView,
    settings: Record<string, unknown>,
    onSelect: (item: WorkItem | null) => void,
    onCustomOrderChange: (order: Record<string, string[]>) => void,
    onSessionFilterChange?: (active: boolean) => void,
  ) {
    this.adapter = adapter;
    this.cardRenderer = cardRenderer;
    this.mover = mover;
    this.plugin = plugin;
    this.terminalPanel = terminalPanel;
    this.settings = settings;
    this.onSelect = onSelect;
    this.onCustomOrderChange = onCustomOrderChange;
    this.onSessionFilterChange = onSessionFilterChange ?? (() => {});

    // Restore session filter state from settings
    this.sessionFilterActive = !!settings["core.sessionFilterActive"];

    // Filter input
    const filterContainer = parentEl.createDiv({ cls: "wt-filter-container" });
    this.filterEl = filterContainer.createEl("input", {
      cls: "wt-filter-input",
      attr: { type: "text", placeholder: `Filter ${adapter.config.itemName}s...` },
    });
    this.filterEl.addEventListener("input", () => {
      if (this.filterDebounce) clearTimeout(this.filterDebounce);
      this.filterDebounce = setTimeout(() => {
        this.filterTerm = this.filterEl.value.toLowerCase();
        this.applyFilter();
      }, 100);
    });

    // Session filter toggle (input wrapped in label to avoid duplicate DOM IDs)
    const sessionFilterContainer = filterContainer.createDiv({ cls: "wt-session-filter" });
    const sessionFilterLabel = sessionFilterContainer.createEl("label", {
      cls: "wt-session-filter-label",
    });
    this.sessionFilterEl = sessionFilterLabel.createEl("input", {
      cls: "wt-session-filter-checkbox",
      attr: { type: "checkbox" },
    });
    this.sessionFilterEl.checked = this.sessionFilterActive;
    sessionFilterLabel.createSpan({ text: "Active sessions only" });
    this.sessionFilterEl.addEventListener("change", () => {
      this.sessionFilterActive = this.sessionFilterEl.checked;
      this.onSessionFilterChange(this.sessionFilterActive);
      this.applyFilter();
    });

    // List container
    this.containerEl = parentEl;
    this.listEl = parentEl.createDiv({
      cls: "wt-list-panel",
      attr: { "data-wt-tour": "list-panel" },
    });
    this.listEl.style.cssText = "flex: 1; overflow-y: auto; overflow-x: hidden;";

    // Collapse last section by default
    const cols = adapter.config.columns;
    if (cols.length > 0) {
      this.collapsedSections.add(cols[cols.length - 1].id);
    }
  }

  /** Update cached settings (called by MainView when settings change). */
  updateSettings(settings: Record<string, unknown>): void {
    this.settings = settings;
  }

  getParser(): WorkItemParser | null {
    return null; // Parser is owned by MainView, not ListPanel
  }

  /** Inject a PinStore after construction (created by MainView). */
  setPinStore(pinStore: PinStore): void {
    this.pinStore = pinStore;
  }

  /** Inject an ActivityTracker after construction (created by MainView). */
  setActivityTracker(tracker: ActivityTracker): void {
    this.activityTracker = tracker;
  }

  /**
   * Inject an AgentProfileManager after construction (created by MainView).
   * Optional: when absent, Split Task / Retry Enrichment fall through to the
   * legacy non-profile spawn path. This keeps ListPanel usable in test
   * harnesses that don't wire the profile manager.
   */
  setProfileManager(profileManager: AgentProfileManager | null): void {
    this.profileManager = profileManager;
  }

  /** Update the set of pinned custom state IDs (columns kept visible when empty). */
  setPinnedCustomStates(pinnedIds: string[]): void {
    this.pinnedCustomStates = new Set(pinnedIds);
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  /** Resolve the current card display mode from settings. */
  private getDisplayMode(): CardDisplayMode {
    const value = this.settings["core.cardDisplayMode"];
    if (value === "compact") return "compact";
    if (value === "comfortable") return "comfortable";
    return "standard";
  }

  /** Resolve the current view mode from settings. */
  private getViewMode(): ViewMode {
    const value = this.settings["core.viewMode"];
    return value === "activity" ? "activity" : "kanban";
  }

  /** Resolve the recent threshold from settings. */
  private getRecentThreshold(): RecentThreshold {
    const value = this.settings["core.recentThreshold"];
    if (value === "1h" || value === "3h" || value === "24h") return value;
    return "3h";
  }

  render(groups: Record<string, WorkItem[]>, customOrder: Record<string, string[]>): void {
    this.groups = groups;
    this.customOrder = customOrder;

    // Flatten all items for lookup
    this.items = [];
    for (const items of Object.values(groups)) {
      this.items.push(...items);
    }

    this.listEl.empty();

    // Apply display mode class to list panel container
    const displayMode = this.getDisplayMode();
    this.listEl.removeClass("wt-compact", "wt-comfortable");
    if (displayMode === "compact") {
      this.listEl.addClass("wt-compact");
    } else if (displayMode === "comfortable") {
      this.listEl.addClass("wt-comfortable");
    }

    // Branch on view mode
    const viewMode = this.getViewMode();
    if (viewMode === "activity") {
      this.listEl.addClass("wt-activity-view");
      this.listEl.removeClass("wt-kanban-view");
      this.renderActivityMode();
    } else {
      this.listEl.addClass("wt-kanban-view");
      this.listEl.removeClass("wt-activity-view");
      this.renderKanbanMode(groups);
    }

    // Auto-resolve placeholders whose real cards have now rendered
    for (const [placeholderPath, cardId] of this.pendingCreatedIdsByPlaceholder) {
      if (this.listEl.querySelector(`[data-item-id="${cardId}"]`)) {
        const placeholderEl = this.placeholders.get(placeholderPath);
        if (placeholderEl) {
          placeholderEl.remove();
          this.placeholders.delete(placeholderPath);
        }
        this.pendingCreatedIdsByPlaceholder.delete(placeholderPath);
        this.applyNewSuccessAnimation(cardId);
      }
    }

    this.applyFilter();
  }

  /** Render the standard kanban view (groups by state columns). */
  private renderKanbanMode(groups: Record<string, WorkItem[]>): void {
    // Collect pinned item IDs and build a lookup of all items by ID
    const pinnedIds = this.pinStore?.getPinnedIds() ?? [];
    const pinnedSet = new Set(pinnedIds);
    const itemById = new Map<string, WorkItem>();
    for (const item of this.items) {
      itemById.set(item.id, item);
    }

    // Render virtual "Pinned" section at the top if there are pinned items
    if (pinnedIds.length > 0) {
      const pinnedItems = pinnedIds
        .map((id) => itemById.get(id))
        .filter((item): item is WorkItem => item != null);

      if (pinnedItems.length > 0) {
        this.renderSection(
          PINNED_COLUMN_ID,
          "Pinned",
          pinnedItems,
          true, // isPinnedSection
        );
      }
    }

    // Render regular columns, excluding pinned items.
    // Dynamic columns (no folderName) that were persisted via column ordering
    // are skipped when they have zero items to avoid cluttering the board.
    const configuredColumnIds = new Set(this.adapter.config.columns.map((c) => c.id));
    for (const col of this.adapter.config.columns) {
      const colItems = (groups[col.id] || []).filter((item) => !pinnedSet.has(item.id));
      const isDynamic = !col.folderName;
      if (isDynamic && colItems.length === 0 && !this.pinnedCustomStates.has(col.id)) continue;
      const sortedItems = this.sortItems(colItems, col.id);

      this.renderSection(col.id, col.label, sortedItems, false);
    }

    // Render dynamic columns: states present in items but not in configured columns.
    // These appear after the configured columns, sorted alphabetically.
    const dynamicIds = Object.keys(groups)
      .filter((id) => !configuredColumnIds.has(id))
      .sort();
    for (const id of dynamicIds) {
      const colItems = (groups[id] || []).filter((item) => !pinnedSet.has(item.id));
      if (colItems.length === 0) continue;
      const sortedItems = this.sortItems(colItems, id);
      const label = titleCase(id);
      this.renderSection(id, label, sortedItems, false);
    }
  }

  /**
   * Render the activity view (groups by recency buckets).
   * Task states in frontmatter are ignored - all items are grouped by
   * their last-activity timestamp.
   */
  private renderActivityMode(): void {
    const now = Date.now();
    const threshold = this.getRecentThreshold();
    const tracker = this.activityTracker;

    // Classify all items into buckets
    const bucketItems: Record<ActivityBucket, WorkItem[]> = {
      recent: [],
      "last-7-days": [],
      "last-30-days": [],
      older: [],
    };

    for (const item of this.items) {
      const bucket = tracker ? tracker.getBucket(item.id, now, threshold) : "older";
      bucketItems[bucket].push(item);

      // Detect bucket crossing: if an item moved to a different bucket,
      // place it at the top of the destination bucket's custom order.
      const prevBucket = this.previousBuckets.get(item.id);
      if (prevBucket !== undefined && prevBucket !== bucket) {
        const order = this.customOrder[bucket] || [];
        if (!order.includes(item.id)) {
          this.customOrder[bucket] = [item.id, ...order];
        } else {
          // Already in the order array - move to front
          this.customOrder[bucket] = [item.id, ...order.filter((id) => id !== item.id)];
        }
        this.onCustomOrderChange(this.customOrder);
      }
    }

    // Update previous bucket assignments for next render cycle
    const newBuckets = new Map<string, ActivityBucket>();
    for (const item of this.items) {
      const bucket = tracker ? tracker.getBucket(item.id, now, threshold) : "older";
      newBuckets.set(item.id, bucket);
    }
    this.previousBuckets = newBuckets;

    // Render each non-empty bucket as a section.
    // Within each bucket, respect custom order (manual ordering).
    for (const bucketId of ACTIVITY_BUCKETS) {
      const items = bucketItems[bucketId];
      if (items.length === 0) continue;

      const sortedItems = this.sortItems(items, bucketId);
      this.renderSection(bucketId, ACTIVITY_BUCKET_LABELS[bucketId], sortedItems, false);
    }
  }

  /**
   * Render a single section (column) of the kanban board. Used for both
   * regular columns and the virtual pinned section.
   */
  private renderSection(
    columnId: string,
    label: string,
    items: WorkItem[],
    isPinnedSection: boolean,
  ): void {
    const sectionEl = this.listEl.createDiv({
      cls: "wt-section",
      attr: { "data-column": columnId },
    });

    // Section header
    const headerEl = sectionEl.createDiv({ cls: "wt-section-header" });
    const safeColumnSlug = slugify(columnId);
    if (safeColumnSlug) headerEl.addClass(`wt-section-header-${safeColumnSlug}`);

    const collapseIcon = headerEl.createSpan({ cls: "wt-collapse-icon" });
    collapseIcon.textContent = this.collapsedSections.has(columnId) ? "\u25b6" : "\u25bc";

    headerEl.createSpan({
      text: `${label} (${items.length})`,
      cls: "wt-section-label",
    });

    headerEl.addEventListener("click", () => {
      if (this.collapsedSections.has(columnId)) {
        this.collapsedSections.delete(columnId);
      } else {
        this.collapsedSections.add(columnId);
      }
      this.render(this.groups, this.customOrder);
    });

    // Cards container
    const cardsEl = sectionEl.createDiv({ cls: "wt-section-cards" });
    if (this.collapsedSections.has(columnId)) {
      cardsEl.style.display = "none";
    }

    // Drop zone for drag-drop
    this.setupDropZone(cardsEl, sectionEl, headerEl, columnId);

    const displayMode = this.getDisplayMode();

    for (const item of items) {
      // For pinned items, use the pinned column as the visual column
      // but track the real column for move operations
      const effectiveColumn = isPinnedSection ? PINNED_COLUMN_ID : columnId;
      const ctx = this.buildCardActionContext(item, effectiveColumn);
      const cardEl = this.cardRenderer.render(item, ctx, displayMode);
      cardEl.addClass("wt-card-wrapper");
      cardEl.setAttribute("data-item-id", item.id);
      cardEl.setAttribute("draggable", "true");

      // State badge for pinned items - shows the real column/state
      if (isPinnedSection) {
        cardEl.addClass("wt-card-pinned");
        const realColumn = this.adapter.config.columns.find((c) => c.id === item.state);
        const stateLabel = realColumn?.label ?? titleCase(item.state);
        const stateBadge = document.createElement("span");
        const stateSlug = slugify(item.state);
        stateBadge.addClass("wt-card-state-badge", `wt-state-badge-${stateSlug}`);
        stateBadge.textContent = stateLabel;
        stateBadge.title = `Real state: ${stateLabel}`;
        // Insert badge into the meta row, compact dots container, or card root
        const metaRow = cardEl.querySelector(".wt-card-meta");
        const compactDots = cardEl.querySelector(".wt-card-compact-dots");
        if (metaRow) {
          metaRow.insertBefore(stateBadge, metaRow.firstChild);
        } else if (compactDots) {
          compactDots.insertBefore(stateBadge, compactDots.firstChild);
        } else {
          cardEl.appendChild(stateBadge);
        }
      }

      // Selection
      if (item.id === this.selectedId) {
        cardEl.addClass("wt-card-selected");
      }

      cardEl.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest(".wt-move-to-top")) return;
        this.selectItem(item);
      });

      // Context menu
      cardEl.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.showCardContextMenu(item, effectiveColumn, e);
      });

      // Drag source
      this.setupDragSource(cardEl, item, effectiveColumn);

      // Agent state indicators (applied as class on card wrapper)
      this.renderAgentStateIndicator(cardEl, item);

      // Actions container: session badge + move-to-top (top-right)
      const actionsEl = this.getCardActionsContainer(cardEl);
      this.renderSessionBadges(actionsEl, item);
      this.renderMoveToTop(actionsEl, item);

      // Ingesting shine + badge: card-level class drives the CSS animation
      if (this.ingestingIds.has(item.id)) {
        cardEl.addClass("wt-card-is-ingesting");
        this.ensureIngestingBadge(cardEl);
      }

      if (this.activeSuccessIds.has(item.id)) {
        cardEl.addClass("wt-card-new-success");
      }

      cardsEl.appendChild(cardEl);

      if (this.activeSuccessIds.has(item.id)) {
        this.appendSuccessBar(cardEl);
      }
    }

    // Re-insert any active placeholders for this column, but only those
    // whose real card has NOT yet appeared in this render cycle.
    // (Only for non-pinned sections - placeholders belong to real columns)
    if (!isPinnedSection) {
      for (const [placeholderPath, placeholderEl] of this.placeholders) {
        const cardId = this.pendingCreatedIdsByPlaceholder.get(placeholderPath);
        // If the real card rendered, skip re-inserting the placeholder
        if (cardId && this.listEl.querySelector(`[data-item-id="${cardId}"]`)) {
          continue;
        }
        // Simple heuristic: add placeholder to first visible column
        if (
          cardsEl.children.length === 0 ||
          columnId === this.adapter.config.creationColumns.find((c) => c.default)?.id
        ) {
          cardsEl.appendChild(placeholderEl);
        }
      }
    }
  }

  private sortItems(items: WorkItem[], columnId: string): WorkItem[] {
    const order = this.customOrder[columnId] || [];
    if (order.length === 0) return [...items];

    const orderMap = new Map(order.map((id, idx) => [id, idx]));
    const ordered: WorkItem[] = [];
    const unordered: WorkItem[] = [];

    for (const item of items) {
      if (orderMap.has(item.id)) {
        ordered.push(item);
      } else {
        unordered.push(item);
      }
    }

    ordered.sort((a, b) => (orderMap.get(a.id) ?? 0) - (orderMap.get(b.id) ?? 0));
    return [...ordered, ...unordered];
  }

  // ---------------------------------------------------------------------------
  // Card Action Context
  // ---------------------------------------------------------------------------

  private buildCardActionContext(item: WorkItem, currentColumn: string): CardActionContext {
    return {
      onSelect: () => this.selectItem(item),
      onMoveToTop: () => this.moveToTop(item, currentColumn),
      onMoveToColumn: (columnId: string) => this.moveToColumn(item, columnId),
      onInsertAfter: (existingId: string, newItem: WorkItem) => {
        this.insertAfter(existingId, newItem, currentColumn);
      },
      onSplitTask: (sourceItem: WorkItem) => {
        this.splitTask(sourceItem, currentColumn);
      },
      onDelete: () => this.deleteItem(item),
      onCloseSessions: () => this.terminalPanel.closeAllSessions(item.id),
      // Used for "Copy Context Prompt" in the card context menu - a profile-independent
      // preview, so suppressAdapterPrompt does not apply (always includes adapter prompt).
      getContextPrompt: () => this.terminalPanel.getAgentContextPrompt(item),
      onRetryEnrich: () => this.retryEnrichment(item),
      onPin: () => this.pinItem(item),
      onUnpin: () => this.unpinItem(item),
      isPinned: () => this.pinStore?.isPinned(item.id) ?? false,
    };
  }

  // ---------------------------------------------------------------------------
  // Selection
  // ---------------------------------------------------------------------------

  selectItem(item: WorkItem): void {
    this.selectedId = item.id;
    // Update visual selection
    this.listEl.querySelectorAll(".wt-card-selected").forEach((el) => {
      el.removeClass("wt-card-selected");
    });
    const cardEl = this.listEl.querySelector(`[data-item-id="${item.id}"]`);
    if (cardEl) cardEl.addClass("wt-card-selected");
    this.onSelect(item);
  }

  selectById(id: string): void {
    const item = this.items.find((i) => i.id === id);
    if (item) this.selectItem(item);
  }

  // ---------------------------------------------------------------------------
  // Move operations
  // ---------------------------------------------------------------------------

  private moveToTop(item: WorkItem, columnId: string): void {
    // For pinned section, reorder within pinned list
    if (columnId === PINNED_COLUMN_ID) {
      void this.pinStore?.reorder([
        item.id,
        ...(this.pinStore?.getPinnedIds().filter((id) => id !== item.id) ?? []),
      ]);
      this.render(this.groups, this.customOrder);
      this.selectItem(item);
      return;
    }
    const order = this.customOrder[columnId] || [];
    const filtered = order.filter((id) => id !== item.id);
    this.customOrder[columnId] = [item.id, ...filtered];
    this.onCustomOrderChange(this.customOrder);
    this.render(this.groups, this.customOrder);
    this.selectItem(item);
  }

  private pinItem(item: WorkItem): void {
    if (!this.pinStore) return;
    void this.pinStore.pin(item.id).then(() => {
      this.render(this.groups, this.customOrder);
      this.selectItem(item);
    });
  }

  private unpinItem(item: WorkItem): void {
    if (!this.pinStore) return;
    void this.pinStore.unpin(item.id).then(() => {
      this.render(this.groups, this.customOrder);
      this.selectItem(item);
    });
  }

  setIngesting(id: string): void {
    this.ingestingIds.add(id);
    const cardEl = this.listEl.querySelector(`[data-item-id="${id}"]`);
    if (cardEl) {
      cardEl.addClass("wt-card-is-ingesting");
      this.ensureIngestingBadge(cardEl);
    }
  }

  clearIngesting(id: string): void {
    this.ingestingIds.delete(id);
    const cardEl = this.listEl.querySelector(`[data-item-id="${id}"]`);
    if (cardEl) {
      cardEl.removeClass("wt-card-is-ingesting");
      cardEl.querySelector(".wt-card-ingesting-badge")?.remove();
    }
  }

  private ensureIngestingBadge(cardEl: Element): void {
    if (cardEl.querySelector(".wt-card-ingesting-badge")) return;
    const metaRow = cardEl.querySelector(".wt-card-meta");
    if (!metaRow) return;
    const badge = document.createElement("span");
    badge.addClass("wt-card-ingesting-badge");
    badge.textContent = "ingesting...";
    // Insert as first child so it appears prominently
    metaRow.insertBefore(badge, metaRow.firstChild);
  }

  prependToColumn(id: string, columnId: string, placeholderPath?: string): void {
    const order = this.customOrder[columnId] || [];
    // Avoid duplicates
    if (!order.includes(id)) {
      this.customOrder[columnId] = [id, ...order];
      this.onCustomOrderChange(this.customOrder);
    }
    if (placeholderPath) {
      this.pendingCreatedIdsByPlaceholder.set(placeholderPath, id);
    }
  }

  private async moveToColumn(item: WorkItem, targetColumnId: string): Promise<boolean> {
    // Guard: the pinned column is virtual - never pass it to the mover
    if (targetColumnId === PINNED_COLUMN_ID) return false;
    const file = this.app.vault.getAbstractFileByPath(item.path) as TFile;
    if (!file) return false;
    const success = await this.mover.move(file, targetColumnId);
    if (!success) {
      new Notice(`Failed to move "${item.title}" to ${targetColumnId}`);
      return false;
    }
    // Wait for metadata cache update
    setTimeout(() => {
      this.onCustomOrderChange(this.customOrder);
    }, 200);
    return true;
  }

  private get app() {
    return (this.plugin as any).app;
  }

  private resolveVaultPath(): string {
    const adapter = this.app.vault.adapter as any;
    let vaultPath: string = adapter.basePath || adapter.getBasePath?.() || "";
    const home = process.env.HOME || "";
    if (vaultPath.startsWith("~/") || vaultPath === "~") {
      vaultPath = home + vaultPath.slice(1);
    } else if (!vaultPath.startsWith("/") && home) {
      vaultPath = home + "/" + vaultPath;
    }
    return vaultPath;
  }

  /**
   * Resolve a vault-relative work item path to an absolute filesystem path
   * using Node's `path.resolve`, so platform-specific separators are handled
   * correctly (rather than the previous `${base}/${path}` concat which could
   * produce mixed-separator strings on Windows). Returns null when the vault
   * base path is not available.
   */
  private resolveWorkItemAbsPath(itemPath: string): string | null {
    const vaultBase = this.resolveVaultPath();
    if (!vaultBase) return null;
    const path = electronRequire("path") as typeof import("path");
    return path.resolve(vaultBase, itemPath);
  }

  private async insertAfter(
    existingId: string,
    newItem: WorkItem,
    columnId: string,
  ): Promise<void> {
    // For pinned items, resolve to the real column for file creation
    const effectiveColumnId = columnId === PINNED_COLUMN_ID ? newItem.state : columnId;
    if (!this.adapter.onItemCreated) {
      console.warn("[work-terminal] insertAfter: adapter has no onItemCreated");
      return;
    }

    try {
      await this.adapter.onItemCreated(newItem.title, {
        ...this.settings,
        _columnId: effectiveColumnId,
        _splitFromId: existingId,
      });
      console.log(`[work-terminal] Split task created: "${newItem.title}" after ${existingId}`);
    } catch (err) {
      console.error("[work-terminal] Split task creation failed:", err);
    }
  }

  private async splitTask(sourceItem: WorkItem, columnId: string): Promise<void> {
    // For pinned items, use the real state column for the split
    const effectiveColumnId = columnId === PINNED_COLUMN_ID ? sourceItem.state : columnId;
    if (!this.adapter.onSplitItem) {
      console.warn("[work-terminal] splitTask: adapter has no onSplitItem");
      return;
    }

    try {
      const result = await this.adapter.onSplitItem(sourceItem, effectiveColumnId, this.settings);
      if (!result) {
        console.error("[work-terminal] splitTask: adapter returned no result");
        return;
      }
      console.log(`[work-terminal] Split task created: ${result.path} (id: ${result.id})`);

      // Resolve full filesystem paths (CWD may differ from vault location).
      // Use path.resolve so the cross-platform separator is honoured.
      const sourceFullPath = this.resolveWorkItemAbsPath(sourceItem.path) ?? sourceItem.path;
      const newFullPath = this.resolveWorkItemAbsPath(result.path) ?? result.path;

      // Build the split-scoping prompt.
      // Paths are NOT quoted to avoid Claude including literal quote characters
      // in tool parameters (causes "Invalid tool parameters" errors).
      const prompt =
        `Read the original task file at ${sourceFullPath} and the new split task file at ${newFullPath}. ` +
        `The new file was created as a sub-scope of the original. ` +
        `Ask the user what the scope of this new split task should be. ` +
        `Once the user answers, update the new task file in place: ` +
        `set the title, write a brief description with relevant context from the original task, ` +
        `and log the scope in the activity log. ` +
        `Then rename the file to match the convention TASK-YYYYMMDD-HHMM-slugified-title.md ` +
        `(use the existing date prefix, replace the "pending-XXXXXXXX" segment with a slug of the final title).`;

      // Select the new item directly (construct a minimal WorkItem rather than
      // waiting for MetadataCache to index the file, which can be unreliable
      // for newly-created files).
      const newItem: WorkItem = {
        id: result.id,
        path: result.path,
        title: `Split from: ${sourceItem.title}`,
        state: effectiveColumnId,
        metadata: {},
      };
      this.items.push(newItem);
      this.selectItem(newItem);

      // Route the launch through the split-task profile so the session inherits
      // the user's Claude profile settings (command, args, cwd, login shell wrap).
      // resolveOverride returns null when no profile manager is wired, in which
      // case spawnClaudeWithPrompt falls back to the pre-448 non-profile path.
      const override = this.resolveSplitLaunchOverride();
      this.terminalPanel.spawnClaudeWithPrompt(prompt, "Split scope", override ?? undefined);
    } catch (err) {
      console.error("[work-terminal] splitTask failed:", err);
    }
  }

  private retryEnrichment(item: WorkItem): void {
    if (!this.adapter.getRetryEnrichPrompt) {
      console.warn("[work-terminal] retryEnrichment: adapter has no getRetryEnrichPrompt");
      return;
    }

    void (async () => {
      try {
        const prompt = await this.adapter.getRetryEnrichPrompt!(item);
        if (!prompt) {
          console.warn("[work-terminal] retryEnrichment: adapter returned no prompt for", item.id);
          return;
        }
        this.selectItem(item);

        // Retry-enrichment launches now follow the configured enrichment
        // profile (see splitTaskProfile.resolveRetryEnrichmentProfile for
        // the fallback chain) so they match what background enrichment
        // would have used.
        const override = this.resolveRetryLaunchOverride();
        this.terminalPanel.spawnClaudeWithPrompt(prompt, "Enrich", override ?? undefined);
      } catch (err) {
        console.error("[work-terminal] retryEnrichment failed:", err);
        new Notice("Failed to start enrichment session. See console for details.");
      }
    })();
  }

  /**
   * Resolve the profile + cwd override used when launching a Claude session
   * for Split Task. Returns null when no profile manager is wired so callers
   * fall back to the legacy non-profile path.
   *
   * Cwd resolution delegates to `AgentProfileManager.resolveCwd` so this path
   * uses the same chain as every other profile-driven launch
   * (profile.defaultCwd -> core.defaultTerminalCwd -> "~"). See issue #504
   * for why the task file's parent directory is deliberately NOT considered.
   */
  private resolveSplitLaunchOverride(): {
    profile: AgentProfile;
    cwdOverride: string;
  } | null {
    if (!this.profileManager) return null;
    const profile = resolveSplitTaskProfile(this.settings, this.profileManager.getProfiles());
    if (!profile) return null;
    const cwdOverride = this.profileManager.resolveCwd(profile, this.settings);
    return { profile, cwdOverride };
  }

  private resolveRetryLaunchOverride(): {
    profile: AgentProfile;
    cwdOverride: string;
  } | null {
    if (!this.profileManager) return null;
    const profile = resolveRetryEnrichmentProfile(this.settings, this.profileManager.getProfiles());
    if (!profile) return null;
    const cwdOverride = this.profileManager.resolveCwd(profile, this.settings);
    return { profile, cwdOverride };
  }

  private deleteItem(item: WorkItem): void {
    new DangerConfirm(this.app, `Delete "${item.title}"`, () => {
      void (async () => {
        // Let adapter intercept deletion (e.g. API-backed items)
        if (this.adapter.onDelete) {
          const proceed = await this.adapter.onDelete(item);
          if (!proceed) return;
        }
        const file = this.app.vault.getAbstractFileByPath(item.path) as TFile;
        if (!file) return;
        await this.app.vault.trash(file, false);
      })().catch((err) => {
        console.error("[work-terminal] deleteItem failed:", err);
      });
    }).open();
  }

  // ---------------------------------------------------------------------------
  // Drag-and-drop
  // ---------------------------------------------------------------------------

  private setupDragSource(cardEl: HTMLElement, item: WorkItem, columnId: string): void {
    cardEl.addEventListener("dragstart", (e: DragEvent) => {
      this.dragSourceId = item.id;
      this.dragSourceColumn = columnId;
      cardEl.addClass("wt-card-dragging");
      e.dataTransfer?.setData("text/plain", item.id);
    });

    cardEl.addEventListener("dragend", () => {
      this.dragSourceId = null;
      this.dragSourceColumn = null;
      cardEl.removeClass("wt-card-dragging");
      // Remove all drop indicators
      this.listEl.querySelectorAll(".wt-drop-indicator").forEach((el) => el.remove());
    });
  }

  private setupDropZone(
    cardsEl: HTMLElement,
    sectionEl: HTMLElement,
    headerEl: HTMLElement,
    columnId: string,
  ): void {
    // Auto-expand collapsed sections on drag-over
    headerEl.addEventListener("dragover", (e: DragEvent) => {
      e.preventDefault();
      if (this.collapsedSections.has(columnId)) {
        this.collapsedSections.delete(columnId);
        this.render(this.groups, this.customOrder);
      }
    });

    cardsEl.addEventListener("dragover", (e: DragEvent) => {
      e.preventDefault();
      if (!this.dragSourceId) return;

      // Auto-expand if collapsed
      if (this.collapsedSections.has(columnId)) {
        this.collapsedSections.delete(columnId);
        this.render(this.groups, this.customOrder);
        return;
      }

      // Position drop indicator
      this.positionDropIndicator(cardsEl, e.clientY);
    });

    cardsEl.addEventListener("dragleave", (e: DragEvent) => {
      const related = e.relatedTarget as Node | null;
      if (!related || !cardsEl.contains(related)) {
        cardsEl.querySelectorAll(".wt-drop-indicator").forEach((el) => el.remove());
      }
    });

    cardsEl.addEventListener("drop", async (e: DragEvent) => {
      e.preventDefault();
      if (!this.dragSourceId) return;

      const dropIndex = this.getDropIndex(cardsEl, e.clientY);
      const sourceColumn = this.dragSourceColumn;

      // Remove drop indicators
      cardsEl.querySelectorAll(".wt-drop-indicator").forEach((el) => el.remove());

      // Handle drops involving the pinned section
      const item = this.items.find((i) => i.id === this.dragSourceId);
      const dragId = this.dragSourceId;

      if (columnId === PINNED_COLUMN_ID) {
        // Dropping into pinned section
        if (item && dragId && this.pinStore) {
          if (sourceColumn === PINNED_COLUMN_ID) {
            // Reorder within pinned section
            this.reorderWithinPinnedSection(dragId, dropIndex);
          } else {
            // Pin the item
            await this.pinStore.pin(dragId);
            // Reorder to drop position
            const pinnedIds = this.pinStore.getPinnedIds();
            const filtered = pinnedIds.filter((id) => id !== dragId);
            filtered.splice(dropIndex, 0, dragId);
            await this.pinStore.reorder(filtered);
            this.render(this.groups, this.customOrder);
          }
        }
        return;
      }

      if (sourceColumn === PINNED_COLUMN_ID) {
        // Dragging FROM pinned TO a regular column: move first, then unpin.
        // This avoids a race where a failed move leaves the item unpinned
        // with no UI re-render.
        if (item && dragId && this.pinStore) {
          if (item.state !== columnId) {
            const didMove = await this.moveToColumn(item, columnId);
            if (!didMove) return;
          }
          await this.pinStore.unpin(dragId);
          // Set drop position in the target column
          setTimeout(
            () => {
              const colItems = this.sortItems(this.groups[columnId] || [], columnId);
              const order = colItems.map((i) => i.id);
              const filtered = order.filter((id) => id !== dragId);
              filtered.splice(dropIndex, 0, dragId);
              this.customOrder[columnId] = filtered;
              this.onCustomOrderChange(this.customOrder);
              this.render(this.groups, this.customOrder);
            },
            item.state !== columnId ? 200 : 0,
          );
        }
        return;
      }

      if (sourceColumn === columnId) {
        // Within-section reorder
        this.reorderWithinSection(columnId, this.dragSourceId, dropIndex);
      } else if (this.getViewMode() === "activity") {
        // Activity mode: cross-section drag = reorder within destination section.
        // Sections are time-based, not user-controlled, so we never change state.
        if (dragId) {
          this.reorderWithinSection(columnId, dragId, dropIndex);
        }
      } else {
        // Cross-section move between regular columns (kanban mode)
        if (item && dragId) {
          const didMove = await this.moveToColumn(item, columnId);
          if (!didMove) return;
          // After file move + metadata cache update, set drop position.
          // Build full order from current items + the moved item at drop index.
          setTimeout(() => {
            const colItems = this.sortItems(this.groups[columnId] || [], columnId);
            const order = colItems.map((i) => i.id);
            // Item may already be in the list from metadata cache update
            const filtered = order.filter((id) => id !== dragId);
            filtered.splice(dropIndex, 0, dragId);
            this.customOrder[columnId] = filtered;
            this.onCustomOrderChange(this.customOrder);
            this.render(this.groups, this.customOrder);
          }, 200);
        }
      }
    });
  }

  private positionDropIndicator(cardsEl: HTMLElement, clientY: number): void {
    const cards = Array.from(cardsEl.querySelectorAll(".wt-card-wrapper:not(.wt-card-dragging)"));
    let insertBefore: Element | null = null;

    for (const card of cards) {
      const rect = card.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        insertBefore = card;
        break;
      }
    }

    // Reuse existing indicator if present, only move when insertion point changes
    let indicator = cardsEl.querySelector(".wt-drop-indicator") as HTMLElement | null;
    const currentNext = indicator?.nextElementSibling ?? null;

    if (indicator) {
      // Indicator already at correct position - nothing to do
      if (insertBefore === currentNext) return;
      // Move existing indicator to new position
      if (insertBefore) {
        cardsEl.insertBefore(indicator, insertBefore);
      } else {
        cardsEl.appendChild(indicator);
      }
    } else {
      // Create new indicator
      indicator = document.createElement("div");
      indicator.addClass("wt-drop-indicator");
      if (insertBefore) {
        cardsEl.insertBefore(indicator, insertBefore);
      } else {
        cardsEl.appendChild(indicator);
      }
    }
  }

  private getDropIndex(cardsEl: HTMLElement, clientY: number): number {
    const cards = Array.from(cardsEl.querySelectorAll(".wt-card-wrapper:not(.wt-card-dragging)"));
    for (let i = 0; i < cards.length; i++) {
      const rect = cards[i].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        return i;
      }
    }
    return cards.length;
  }

  private reorderWithinSection(columnId: string, itemId: string, targetIndex: number): void {
    // Build the full current visual order. In kanban mode this comes from
    // this.groups[columnId]; in activity mode the groups map contains kanban
    // state columns, not bucket IDs, so we derive the order from the DOM.
    let order: string[];

    if (this.groups[columnId]) {
      const colItems = this.sortItems(this.groups[columnId], columnId);
      order = colItems.map((i) => i.id);
    } else {
      // Activity mode: read current card order from the rendered section
      const sectionEl = this.listEl.querySelector(`[data-column="${columnId}"]`);
      const cards = sectionEl ? Array.from(sectionEl.querySelectorAll(".wt-card-wrapper")) : [];
      order = cards
        .map((el) => el.getAttribute("data-item-id"))
        .filter((id): id is string => id != null);
    }

    const fromIndex = order.indexOf(itemId);
    if (fromIndex < 0) return; // Item not in this section

    // getDropIndex counts cards excluding the dragged one, so targetIndex
    // is already in the "after removal" index space - no adjustment needed.
    order.splice(fromIndex, 1);
    order.splice(targetIndex, 0, itemId);

    this.customOrder[columnId] = order;
    this.onCustomOrderChange(this.customOrder);
    this.render(this.groups, this.customOrder);
  }

  private reorderWithinPinnedSection(itemId: string, targetIndex: number): void {
    if (!this.pinStore) return;
    const order = this.pinStore.getPinnedIds();
    const fromIndex = order.indexOf(itemId);
    if (fromIndex < 0) return;

    order.splice(fromIndex, 1);
    order.splice(targetIndex, 0, itemId);

    void this.pinStore.reorder(order).then(() => {
      this.render(this.groups, this.customOrder);
    });
  }

  // ---------------------------------------------------------------------------
  // Filter
  // ---------------------------------------------------------------------------

  private applyFilter(): void {
    // Build a set of item IDs with active sessions when session filter is on
    const sessionItemIds = this.sessionFilterActive
      ? new Set(this.terminalPanel.getSessionItemIds())
      : null;
    const hasAnyFilter = !!this.filterTerm || this.sessionFilterActive;

    const sections = this.listEl.querySelectorAll(".wt-section");
    for (const section of Array.from(sections)) {
      const cards = section.querySelectorAll(".wt-card-wrapper");
      let visibleCount = 0;

      for (const card of Array.from(cards)) {
        const textMatch =
          !this.filterTerm || (card.textContent?.toLowerCase() || "").includes(this.filterTerm);
        const sessionMatch =
          !sessionItemIds || sessionItemIds.has(card.getAttribute("data-item-id") || "");
        const match = textMatch && sessionMatch;
        (card as HTMLElement).style.display = match ? "" : "none";
        if (match) visibleCount++;
      }

      // Hide section if all cards filtered out
      (section as HTMLElement).style.display = visibleCount > 0 || !hasAnyFilter ? "" : "none";
    }
  }

  // ---------------------------------------------------------------------------
  // Badges and indicators
  // ---------------------------------------------------------------------------

  private renderSessionBadges(containerEl: HTMLElement, item: WorkItem): void {
    const counts = this.terminalPanel.getSessionCounts(item.id);
    const total = counts.shells + counts.agents;
    if (total === 0) return;

    const badgeEl = containerEl.createDiv({ cls: "wt-session-badge" });
    if (counts.agents > 0 && counts.shells > 0) {
      badgeEl.addClass("wt-badge-mixed");
    } else if (counts.agents > 0) {
      badgeEl.addClass("wt-badge-agent");
    } else {
      badgeEl.addClass("wt-badge-shell");
    }
    badgeEl.textContent = String(total);
  }

  private renderAgentStateIndicator(cardEl: HTMLElement, item: WorkItem): void {
    const state = this.agentStates.get(item.id);
    this.applyAgentStateClass(cardEl, state);
    if (!state || state === "inactive") return;

    if (state === "idle") {
      const idleSince = this.idleSinceMap.get(item.id) ?? this.terminalPanel.getIdleSince(item.id);
      if (idleSince) {
        const elapsed = (Date.now() - idleSince) / 1000;
        const offset = -elapsed;
        cardEl.style.setProperty("--idle-offset", `${offset}s`);
        this.idleSinceMap.set(item.id, idleSince);
      }
    }
  }

  private applyAgentStateClass(cardEl: HTMLElement, state: string | undefined): void {
    cardEl.removeClass(
      "wt-agent-active",
      "wt-agent-waiting",
      "wt-agent-idle",
      "wt-claude-active",
      "wt-claude-waiting",
      "wt-claude-idle",
    );
    if (!state || state === "inactive") {
      cardEl.style.removeProperty("--idle-offset");
      return;
    }
    cardEl.addClass(`wt-agent-${state}`);
  }

  private renderMoveToTop(containerEl: HTMLElement, item: WorkItem): void {
    const btn = containerEl.createDiv({ cls: "wt-move-to-top", attr: { title: "Move to top" } });
    btn.textContent = "\u2191";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const columnId = this.findItemColumn(item.id);
      if (columnId) this.moveToTop(item, columnId);
    });
  }

  private getCardActionsContainer(cardEl: HTMLElement): HTMLElement {
    return (cardEl.querySelector(".wt-card-actions") as HTMLElement) || cardEl;
  }

  // ---------------------------------------------------------------------------
  // Context menu
  // ---------------------------------------------------------------------------

  private showCardContextMenu(item: WorkItem, columnId: string, e: MouseEvent): void {
    const menu = new Menu();
    const ctx = this.buildCardActionContext(item, columnId);

    // Framework-injected pin/unpin action at the top of the menu
    if (this.pinStore) {
      const pinned = this.pinStore.isPinned(item.id);
      menu.addItem((menuItem) => {
        menuItem.setTitle(pinned ? "Unpin" : "Pin to Top").onClick(() => {
          if (pinned) {
            ctx.onUnpin?.();
          } else {
            ctx.onPin?.();
          }
        });
      });
      menu.addSeparator();
    }

    // Adapter provides the full menu structure. Framework provides
    // CardActionContext so the adapter can call framework primitives.
    const adapterItems = this.cardRenderer.getContextMenuItems(item, ctx);
    for (const adapterItem of adapterItems) {
      const ai = adapterItem as any;
      if (ai.separator) {
        menu.addSeparator();
      } else {
        menu.addItem((menuItem) => {
          menuItem.setTitle(ai.title || "Action").onClick(() => {
            void Promise.resolve()
              .then(() => ai.callback?.())
              .catch((err) => {
                console.error("[work-terminal] Card action failed:", err);
                new Notice("Card action failed; see console for details");
              });
          });
        });
      }
    }

    menu.showAtMouseEvent(e);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  updateAgentState(itemId: string, state: string): void {
    this.agentStates.set(itemId, state);
    if (state === "idle") {
      if (!this.idleSinceMap.has(itemId)) {
        // Use TabManager's pre-seeded timestamp (300s ago for recovered sessions)
        // so idle animations don't reset to full duration on reload.
        const seeded = this.terminalPanel.getIdleSince(itemId);
        this.idleSinceMap.set(itemId, seeded ?? Date.now());
      }
    } else {
      this.idleSinceMap.delete(itemId);
    }
    // Update card classes without full re-render
    const cardEl = this.listEl.querySelector(`[data-item-id="${itemId}"]`) as HTMLElement;
    if (cardEl) {
      this.applyAgentStateClass(cardEl, state);
      if (state === "idle") {
        const idleSince = this.idleSinceMap.get(itemId);
        if (idleSince) {
          const elapsed = (Date.now() - idleSince) / 1000;
          cardEl.style.setProperty("--idle-offset", `${-elapsed}s`);
        }
      } else {
        cardEl.style.removeProperty("--idle-offset");
      }
    }
  }

  updateSessionBadges(): void {
    // Re-render session badges on all cards without full re-render
    for (const item of this.items) {
      const cardEl = this.listEl.querySelector(`[data-item-id="${item.id}"]`) as HTMLElement;
      if (!cardEl) continue;
      // Remove existing badges
      cardEl.querySelectorAll(".wt-session-badge").forEach((el) => el.remove());
      const actionsEl = this.getCardActionsContainer(cardEl);
      // Re-render in order: session badge | move-to-top (on hover)
      const moveBtn = actionsEl.querySelector(".wt-move-to-top");
      this.renderSessionBadges(actionsEl, item);
      if (moveBtn) actionsEl.appendChild(moveBtn); // re-append to keep it last
    }

    // Re-apply filter so session-only toggle reflects current session state
    if (this.sessionFilterActive) {
      this.applyFilter();
    }
  }

  addPlaceholder(path: string): void {
    const placeholderEl = document.createElement("div");
    placeholderEl.addClass("wt-card-placeholder");
    placeholderEl.textContent = "Ingesting...";
    this.placeholders.set(path, placeholderEl);

    // Add to first visible cards container
    const defaultCol =
      this.adapter.config.creationColumns.find((c) => c.default)?.id ||
      this.adapter.config.columns[0]?.id;
    const cardsEl = this.listEl.querySelector(`[data-column="${defaultCol}"] .wt-section-cards`);
    if (cardsEl) {
      cardsEl.appendChild(placeholderEl);
    }
  }

  resolvePlaceholder(path: string, success: boolean): void {
    const placeholderEl = this.placeholders.get(path);

    if (success) {
      if (placeholderEl) {
        placeholderEl.remove();
        this.placeholders.delete(path);
      }

      const cardId = this.pendingCreatedIdsByPlaceholder.get(path);
      this.pendingCreatedIdsByPlaceholder.delete(path);
      if (cardId) {
        this.applyNewSuccessAnimation(cardId);
      }
      return;
    }

    this.pendingCreatedIdsByPlaceholder.delete(path);

    if (placeholderEl) {
      if (!placeholderEl.isConnected) {
        const cardsEl = this.getDefaultColumnCardsEl();
        if (cardsEl) {
          cardsEl.appendChild(placeholderEl);
        }
      }

      placeholderEl.addClass("wt-card-placeholder-error");
      placeholderEl.textContent = "Creation failed";
      setTimeout(() => {
        placeholderEl.remove();
        this.placeholders.delete(path);
      }, 5000);
      return;
    }

    const errorEl = document.createElement("div");
    errorEl.addClass("wt-card-placeholder", "wt-card-placeholder-error");
    errorEl.textContent = "Creation failed";
    const cardsEl = this.getDefaultColumnCardsEl();
    if (cardsEl) {
      cardsEl.appendChild(errorEl);
    }
    setTimeout(() => errorEl.remove(), 5000);
  }

  private applyNewSuccessAnimation(id: string): void {
    const existing = this.successTimeouts.get(id);
    if (existing) clearTimeout(existing);

    this.activeSuccessIds.add(id);
    const cardEl = this.listEl.querySelector(`[data-item-id="${id}"]`) as HTMLElement | null;
    if (cardEl) {
      cardEl.addClass("wt-card-new-success");
      this.appendSuccessBar(cardEl);
    }

    const timeout = setTimeout(() => {
      this.activeSuccessIds.delete(id);
      const el = this.listEl.querySelector(`[data-item-id="${id}"]`);
      if (el) {
        el.removeClass("wt-card-new-success");
        this.removeSuccessBar(el);
      }
      this.successTimeouts.delete(id);
    }, 4500);
    this.successTimeouts.set(id, timeout);
  }

  private appendSuccessBar(cardEl: Element): void {
    if (cardEl.querySelector(":scope > .wt-success-bar-slot")) return;

    const slot = document.createElement("div");
    slot.addClass("wt-success-bar-slot");

    const bar = document.createElement("div");
    bar.addClass("wt-success-bar");
    bar.textContent = `new ${this.adapter.config.itemName} created`;
    slot.appendChild(bar);
    cardEl.appendChild(slot);

    this.measureSuccessBarHeight(slot, bar);
  }

  private measureSuccessBarHeight(slot: HTMLElement, bar: HTMLElement): void {
    const applyHeight = () => {
      if (!slot.isConnected || !bar.isConnected) return;
      const height = bar.getBoundingClientRect().height || bar.scrollHeight || bar.offsetHeight;
      if (height > 0) {
        slot.style.setProperty("--wt-success-bar-height", `${height}px`);
      }
    };

    if (slot.isConnected && bar.isConnected) {
      applyHeight();
      return;
    }

    setTimeout(applyHeight, 0);
  }

  private removeSuccessBar(cardEl: Element): void {
    cardEl.querySelector(":scope > .wt-success-bar-slot")?.remove();
  }

  dispose(): void {
    if (this.filterDebounce) {
      clearTimeout(this.filterDebounce);
      this.filterDebounce = null;
    }

    for (const timeout of this.successTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.successTimeouts.clear();
    this.activeSuccessIds.clear();
  }

  private getDefaultColumnCardsEl(): Element | null {
    const defaultCol =
      this.adapter.config.creationColumns.find((c) => c.default)?.id ||
      this.adapter.config.columns[0]?.id;
    if (!defaultCol) return null;
    return this.listEl.querySelector(`[data-column="${defaultCol}"] .wt-section-cards`);
  }

  getCustomOrder(): Record<string, string[]> {
    return Object.fromEntries(
      Object.entries(this.customOrder).map(([columnId, itemIds]) => [columnId, [...itemIds]]),
    );
  }

  rekeyCustomOrder(oldId: string, newId: string): boolean {
    let changed = false;

    for (const [columnId, order] of Object.entries(this.customOrder)) {
      if (!order.includes(oldId)) {
        continue;
      }

      const seen = new Set<string>();
      const rekeyed = order
        .map((itemId) => (itemId === oldId ? newId : itemId))
        .filter((itemId) => {
          if (seen.has(itemId)) {
            return false;
          }
          seen.add(itemId);
          return true;
        });
      this.customOrder[columnId] = rekeyed;
      changed = true;
    }

    if (this.selectedId === oldId) {
      this.selectedId = newId;
      changed = true;
    }

    if (this.dragSourceId === oldId) {
      this.dragSourceId = newId;
      changed = true;
    }

    // Rekey pinned items
    if (this.pinStore?.rekey(oldId, newId)) {
      changed = true;
    }

    changed = this.rekeyMapEntry(this.agentStates, oldId, newId) || changed;
    changed = this.rekeyMapEntry(this.idleSinceMap, oldId, newId) || changed;
    changed = this.rekeySetEntry(this.ingestingIds, oldId, newId) || changed;
    changed = this.rekeySuccessAnimation(oldId, newId) || changed;

    for (const [placeholderPath, itemId] of this.pendingCreatedIdsByPlaceholder.entries()) {
      if (itemId !== oldId) {
        continue;
      }

      this.pendingCreatedIdsByPlaceholder.set(placeholderPath, newId);
      changed = true;
    }

    return changed;
  }

  private rekeyMapEntry<T>(map: Map<string, T>, oldId: string, newId: string): boolean {
    if (!map.has(oldId)) {
      return false;
    }

    const value = map.get(oldId) as T;
    map.delete(oldId);
    map.set(newId, value);
    return true;
  }

  private rekeySetEntry(set: Set<string>, oldId: string, newId: string): boolean {
    if (!set.has(oldId)) {
      return false;
    }

    set.delete(oldId);
    set.add(newId);
    return true;
  }

  private rekeySuccessAnimation(oldId: string, newId: string): boolean {
    const hadSuccessAnimation = this.activeSuccessIds.has(oldId) || this.successTimeouts.has(oldId);
    if (!hadSuccessAnimation) {
      return false;
    }

    const existingTimeout = this.successTimeouts.get(oldId);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
      this.successTimeouts.delete(oldId);
    }

    this.activeSuccessIds.delete(oldId);
    this.applyNewSuccessAnimation(newId);
    return true;
  }

  private findItemColumn(itemId: string): string | null {
    // Check pinned section first
    if (this.pinStore?.isPinned(itemId)) return PINNED_COLUMN_ID;
    for (const [colId, items] of Object.entries(this.groups)) {
      if (items.some((i) => i.id === itemId)) return colId;
    }
    return null;
  }
}
