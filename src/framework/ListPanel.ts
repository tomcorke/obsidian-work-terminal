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
} from "../core/interfaces";
import type { TerminalPanelView } from "./TerminalPanelView";
import { DangerConfirm } from "./DangerConfirm";

export class ListPanel {
  private containerEl: HTMLElement;
  private listEl: HTMLElement;
  private filterEl: HTMLInputElement;
  private adapter: AdapterBundle;
  private cardRenderer: CardRenderer;
  private mover: WorkItemMover;
  private plugin: Plugin;
  private terminalPanel: TerminalPanelView;

  private settings: Record<string, any>;
  private onSelect: (item: WorkItem | null) => void;
  private onCustomOrderChange: (order: Record<string, string[]>) => void;

  // State
  private selectedId: string | null = null;
  private collapsedSections: Set<string> = new Set();
  private filterTerm = "";
  private filterDebounce: ReturnType<typeof setTimeout> | null = null;
  private items: WorkItem[] = [];
  private groups: Record<string, WorkItem[]> = {};
  private customOrder: Record<string, string[]> = {};

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
    settings: Record<string, any>,
    onSelect: (item: WorkItem | null) => void,
    onCustomOrderChange: (order: Record<string, string[]>) => void,
  ) {
    this.adapter = adapter;
    this.cardRenderer = cardRenderer;
    this.mover = mover;
    this.plugin = plugin;
    this.terminalPanel = terminalPanel;
    this.settings = settings;
    this.onSelect = onSelect;
    this.onCustomOrderChange = onCustomOrderChange;

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

    // List container
    this.containerEl = parentEl;
    this.listEl = parentEl.createDiv({ cls: "wt-list-panel" });
    this.listEl.style.cssText = "flex: 1; overflow-y: auto; overflow-x: hidden;";

    // Collapse last section by default
    const cols = adapter.config.columns;
    if (cols.length > 0) {
      this.collapsedSections.add(cols[cols.length - 1].id);
    }
  }

  getParser(): WorkItemParser | null {
    return null; // Parser is owned by MainView, not ListPanel
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  render(groups: Record<string, WorkItem[]>, customOrder: Record<string, string[]>): void {
    this.groups = groups;
    this.customOrder = customOrder;

    // Flatten all items for lookup
    this.items = [];
    for (const items of Object.values(groups)) {
      this.items.push(...items);
    }

    this.listEl.empty();

    for (const col of this.adapter.config.columns) {
      const colItems = groups[col.id] || [];
      const sortedItems = this.sortItems(colItems, col.id);

      // Section container
      const sectionEl = this.listEl.createDiv({
        cls: "wt-section",
        attr: { "data-column": col.id },
      });

      // Section header
      const headerEl = sectionEl.createDiv({ cls: "wt-section-header" });
      headerEl.addClass(`wt-section-header-${col.id}`);

      const collapseIcon = headerEl.createSpan({ cls: "wt-collapse-icon" });
      collapseIcon.textContent = this.collapsedSections.has(col.id) ? "\u25b6" : "\u25bc";

      headerEl.createSpan({
        text: `${col.label} (${sortedItems.length})`,
        cls: "wt-section-label",
      });

      headerEl.addEventListener("click", () => {
        if (this.collapsedSections.has(col.id)) {
          this.collapsedSections.delete(col.id);
        } else {
          this.collapsedSections.add(col.id);
        }
        this.render(this.groups, this.customOrder);
      });

      // Cards container
      const cardsEl = sectionEl.createDiv({ cls: "wt-section-cards" });
      if (this.collapsedSections.has(col.id)) {
        cardsEl.style.display = "none";
      }

      // Drop zone for drag-drop
      this.setupDropZone(cardsEl, sectionEl, headerEl, col.id);

      for (const item of sortedItems) {
        const ctx = this.buildCardActionContext(item, col.id);
        const cardEl = this.cardRenderer.render(item, ctx);
        cardEl.addClass("wt-card-wrapper");
        cardEl.setAttribute("data-item-id", item.id);
        cardEl.setAttribute("draggable", "true");

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
          this.showCardContextMenu(item, col.id, e);
        });

        // Drag source
        this.setupDragSource(cardEl, item, col.id);

        // Agent state indicators (applied as class on card wrapper)
        this.renderAgentStateIndicator(cardEl, item);

        // Actions container: session badge + resume badge + move-to-top (top-right)
        // Order: [session badge] [resume badge] [move-to-top (on hover)]
        const actionsEl = this.getCardActionsContainer(cardEl);
        this.renderSessionBadges(actionsEl, item);
        this.renderResumeBadge(actionsEl, item);
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

      // Re-insert any active placeholders for this column
      for (const [, placeholderEl] of this.placeholders) {
        // Simple heuristic: add placeholder to first visible column
        if (
          cardsEl.children.length === 0 ||
          col.id === this.adapter.config.creationColumns.find((c) => c.default)?.id
        ) {
          cardsEl.appendChild(placeholderEl);
        }
      }
    }

    this.applyFilter();
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
      getContextPrompt: () => this.terminalPanel.getAgentContextPrompt(item),
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
    const order = this.customOrder[columnId] || [];
    const filtered = order.filter((id) => id !== item.id);
    this.customOrder[columnId] = [item.id, ...filtered];
    this.onCustomOrderChange(this.customOrder);
    this.render(this.groups, this.customOrder);
    this.selectItem(item);
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

  private async insertAfter(
    existingId: string,
    newItem: WorkItem,
    columnId: string,
  ): Promise<void> {
    if (!this.adapter.onItemCreated) {
      console.warn("[work-terminal] insertAfter: adapter has no onItemCreated");
      return;
    }

    try {
      await this.adapter.onItemCreated(newItem.title, {
        ...this.settings,
        _columnId: columnId,
        _splitFromId: existingId,
      });
      console.log(`[work-terminal] Split task created: "${newItem.title}" after ${existingId}`);
    } catch (err) {
      console.error("[work-terminal] Split task creation failed:", err);
    }
  }

  private async splitTask(sourceItem: WorkItem, columnId: string): Promise<void> {
    if (!this.adapter.onSplitItem) {
      console.warn("[work-terminal] splitTask: adapter has no onSplitItem");
      return;
    }

    try {
      const result = await this.adapter.onSplitItem(sourceItem, columnId, this.settings);
      if (!result) {
        console.error("[work-terminal] splitTask: adapter returned no result");
        return;
      }
      console.log(`[work-terminal] Split task created: ${result.path} (id: ${result.id})`);

      // Resolve full filesystem paths (CWD may differ from vault location)
      const vaultBase = this.resolveVaultPath();
      const sourceFullPath = `${vaultBase}/${sourceItem.path}`;
      const newFullPath = `${vaultBase}/${result.path}`;

      // Build the split-scoping prompt
      const prompt =
        `Read the task file at "${sourceFullPath}". ` +
        `A new split task has been created at "${newFullPath}" as a sub-scope of the original. ` +
        `Ask the user what the scope of this new split task should be. ` +
        `Once the user answers, immediately update the new task file: ` +
        `set the title, write a brief description with relevant context and references from the original task, ` +
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
        state: columnId,
        metadata: {},
      };
      this.items.push(newItem);
      this.selectItem(newItem);
      this.terminalPanel.spawnClaudeWithPrompt(prompt, "Split scope");
    } catch (err) {
      console.error("[work-terminal] splitTask failed:", err);
    }
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

    cardsEl.addEventListener("dragleave", () => {
      cardsEl.querySelectorAll(".wt-drop-indicator").forEach((el) => el.remove());
    });

    cardsEl.addEventListener("drop", async (e: DragEvent) => {
      e.preventDefault();
      if (!this.dragSourceId) return;

      const dropIndex = this.getDropIndex(cardsEl, e.clientY);
      const sourceColumn = this.dragSourceColumn;

      // Remove drop indicators
      cardsEl.querySelectorAll(".wt-drop-indicator").forEach((el) => el.remove());

      if (sourceColumn === columnId) {
        // Within-section reorder
        this.reorderWithinSection(columnId, this.dragSourceId, dropIndex);
      } else {
        // Cross-section move
        const item = this.items.find((i) => i.id === this.dragSourceId);
        const dragId = this.dragSourceId;
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
    // Remove existing indicators
    cardsEl.querySelectorAll(".wt-drop-indicator").forEach((el) => el.remove());

    const cards = Array.from(cardsEl.querySelectorAll(".wt-card-wrapper:not(.wt-card-dragging)"));
    let insertBefore: Element | null = null;

    for (const card of cards) {
      const rect = card.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        insertBefore = card;
        break;
      }
    }

    const indicator = document.createElement("div");
    indicator.addClass("wt-drop-indicator");

    if (insertBefore) {
      cardsEl.insertBefore(indicator, insertBefore);
    } else {
      cardsEl.appendChild(indicator);
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
    // Build the full current visual order: items already in customOrder first,
    // then remaining items in their default sort order. This ensures ALL items
    // in the section are tracked, not just previously-ordered ones.
    const colItems = this.sortItems(this.groups[columnId] || [], columnId);
    const order = colItems.map((i) => i.id);

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

  // ---------------------------------------------------------------------------
  // Filter
  // ---------------------------------------------------------------------------

  private applyFilter(): void {
    const sections = this.listEl.querySelectorAll(".wt-section");
    for (const section of Array.from(sections)) {
      const cards = section.querySelectorAll(".wt-card-wrapper");
      let visibleCount = 0;

      for (const card of Array.from(cards)) {
        const text = card.textContent?.toLowerCase() || "";
        const match = !this.filterTerm || text.includes(this.filterTerm);
        (card as HTMLElement).style.display = match ? "" : "none";
        if (match) visibleCount++;
      }

      // Hide section if all cards filtered out
      (section as HTMLElement).style.display = visibleCount > 0 || !this.filterTerm ? "" : "none";
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

  private renderResumeBadge(containerEl: HTMLElement, item: WorkItem): void {
    const persisted = this.terminalPanel.getPersistedSessions(item.id);
    if (!persisted || persisted.length === 0) return;

    // Only show resume badge if there are no active resumable agent sessions
    if (this.terminalPanel.hasResumableAgentSessions(item.id)) return;

    const badge = containerEl.createDiv({ cls: "wt-resume-badge" });
    let resumeInProgress = false;
    badge.textContent = "\u21bb"; // Clockwise arrow
    badge.setAttribute("title", `${persisted.length} resumable session(s) - click to resume`);
    badge.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (resumeInProgress) return;
      resumeInProgress = true;

      try {
        // Select the item first so resumed tabs appear in the terminal panel
        this.selectItem(item);
        // Resume all persisted sessions for this item
        for (const session of persisted) {
          await this.terminalPanel.resumeSession(session, item.id);
        }
      } catch (error) {
        console.error("Failed to resume persisted sessions for item", item.id, error);
        new Notice("Failed to resume previous sessions. See console for details.");
      } finally {
        resumeInProgress = false;
      }
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
      cardEl.querySelectorAll(".wt-resume-badge").forEach((el) => el.remove());
      const actionsEl = this.getCardActionsContainer(cardEl);
      // Re-render in order: session badge | resume badge | move-to-top (on hover)
      const moveBtn = actionsEl.querySelector(".wt-move-to-top");
      this.renderSessionBadges(actionsEl, item);
      this.renderResumeBadge(actionsEl, item);
      if (moveBtn) actionsEl.appendChild(moveBtn); // re-append to keep it last
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

  rekeyCustomOrder(oldPath: string, newPath: string): void {
    // Custom order uses UUIDs, not paths, so usually no action needed.
    // But track for any path-based references.
    void oldPath;
    void newPath;
  }

  private findItemColumn(itemId: string): string | null {
    for (const [colId, items] of Object.entries(this.groups)) {
      if (items.some((i) => i.id === itemId)) return colId;
    }
    return null;
  }
}
