import { Notice, type MenuItem } from "obsidian";
import type {
  WorkItem,
  CardRenderer,
  CardActionContext,
  CardFlagRule,
  CardDisplayMode,
} from "../../core/interfaces";
import { matchCardFlags, type MatchedCardFlag } from "../../core/cardFlags";
import { normalizeObsidianDisplayText } from "../../core/utils";
import { KANBAN_COLUMNS, COLUMN_LABELS, SOURCE_LABELS } from "./types";

export class TaskCard implements CardRenderer {
  private flagRules: CardFlagRule[];

  constructor(flagRules: CardFlagRule[] = []) {
    this.flagRules = flagRules;
  }

  /** Replace the active flag rules (e.g. after a settings change merges default + user rules). */
  updateFlagRules(rules: CardFlagRule[]): void {
    this.flagRules = rules;
  }

  render(item: WorkItem, ctx: CardActionContext, displayMode?: CardDisplayMode): HTMLElement {
    const meta = (item.metadata || {}) as Record<string, any>;
    const source = meta.source || { type: "other" };
    const priority = meta.priority || { score: 0 };
    const goal: string[] = meta.goal || [];
    const ingesting = !!meta.ingesting;
    const taskColor: string | undefined = meta.color;

    const card = document.createElement("div");
    card.addClass("wt-card");
    if (ingesting) card.addClass("ingesting");
    card.dataset.path = item.path;
    card.draggable = true;

    if (taskColor) {
      card.style.setProperty("--wt-task-color", taskColor);
    }

    if (displayMode === "compact") {
      card.addClass("wt-card-compact");
      this.renderCompact(card, item, meta, source, priority, goal);
    } else {
      this.renderStandard(card, item, meta, source, priority, goal, ingesting);
    }

    // Click to select
    card.addEventListener("click", (e) => {
      e.stopPropagation();
      ctx.onSelect();
    });

    // Drag events
    card.addEventListener("dragstart", (e) => {
      card.addClass("dragging");
      e.dataTransfer?.setData("text/plain", item.path);
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
      }
    });

    card.addEventListener("dragend", () => {
      card.removeClass("dragging");
    });

    return card;
  }

  /**
   * Render the standard multi-line card layout with full badges and metadata.
   */
  private renderStandard(
    card: HTMLElement,
    item: WorkItem,
    meta: Record<string, any>,
    source: Record<string, any>,
    priority: Record<string, any>,
    goal: string[],
    ingesting: boolean,
  ): void {
    // Title row
    const titleRow = card.createDiv({ cls: "wt-card-title-row" });

    // TODO(icons): Render item icon in this slot when icon support is implemented
    const iconSlot = titleRow.createDiv({ cls: "wt-card-icon-slot" });
    iconSlot.style.display = "none";

    const titleEl = titleRow.createDiv({ cls: "wt-card-title" });
    titleEl.textContent = item.title;

    // Actions container (session badge + move-to-top added by framework)
    titleRow.createDiv({ cls: "wt-card-actions" });

    // Meta row
    const metaRow = card.createDiv({ cls: "wt-card-meta" });

    // Source badge - hide for CLI-created tasks, show Jira key when available
    if (source.type !== "prompt") {
      const sourceBadge = metaRow.createSpan({ cls: "wt-card-source" });
      if (source.type === "jira" && source.id) {
        sourceBadge.textContent = source.id.toUpperCase();
        sourceBadge.addClass("wt-card-source--jira");
      } else {
        sourceBadge.textContent = SOURCE_LABELS[source.type] || "---";
      }
    }

    // Ingesting indicator
    if (ingesting) {
      const badge = metaRow.createSpan({ cls: "wt-card-ingesting" });
      badge.textContent = "ingesting...";
    }

    // Enrichment failed indicator
    const backgroundIngestion = meta.backgroundIngestion;
    if (backgroundIngestion === "failed") {
      const failBadge = metaRow.createSpan({ cls: "wt-card-enrich-failed" });
      failBadge.textContent = "enrichment failed";
      failBadge.title = "Background ingestion did not complete. Right-click to retry.";
    }

    // Priority score badge
    if (priority.score > 0) {
      const scoreBadge = metaRow.createSpan({ cls: "wt-card-score" });
      scoreBadge.textContent = String(priority.score);
      if (priority.score >= 60) {
        scoreBadge.addClass("score-high");
      } else if (priority.score >= 30) {
        scoreBadge.addClass("score-medium");
      } else {
        scoreBadge.addClass("score-low");
      }
    }

    // Goal tags (max 2)
    for (const g of goal.slice(0, 2)) {
      const displayGoal = normalizeObsidianDisplayText(g);
      const goalEl = metaRow.createSpan({ cls: "wt-card-goal" });
      goalEl.textContent = displayGoal.replace(/-/g, " ");
      goalEl.title = displayGoal;
    }

    // Configurable card flags (replaces hard-coded blocker indicator)
    const matchedFlags = matchCardFlags(this.flagRules, meta);
    for (const flag of matchedFlags) {
      this.renderFlag(metaRow, card, flag);
    }
  }

  /**
   * Render a compact single-line card layout with indicator dots replacing
   * verbose badges.
   */
  private renderCompact(
    card: HTMLElement,
    item: WorkItem,
    meta: Record<string, any>,
    source: Record<string, any>,
    priority: Record<string, any>,
    goal: string[],
  ): void {
    const compactRow = card.createDiv({ cls: "wt-card-compact-row" });

    // TODO(icons): Render item icon in this slot when icon support is implemented
    const iconSlot = compactRow.createDiv({ cls: "wt-card-icon-slot" });
    iconSlot.style.display = "none";

    // Title - single line with ellipsis truncation
    const titleEl = compactRow.createDiv({ cls: "wt-card-compact-title" });
    titleEl.textContent = item.title;
    titleEl.title = item.title;

    // Indicator dots container
    const dotsEl = compactRow.createDiv({ cls: "wt-card-compact-dots" });
    this.renderIndicatorDots(dotsEl, meta, source, priority, goal);

    // Actions container (session badge + move-to-top added by framework)
    compactRow.createDiv({ cls: "wt-card-actions" });
  }

  /**
   * Render coloured indicator dots for compact mode. Each dot replaces a
   * verbose badge with a small coloured circle and tooltip.
   */
  private renderIndicatorDots(
    container: HTMLElement,
    meta: Record<string, any>,
    source: Record<string, any>,
    priority: Record<string, any>,
    goal: string[],
  ): void {
    // Jira source dot
    if (source.type === "jira" && source.id) {
      const dot = container.createSpan({ cls: "wt-compact-dot wt-compact-dot--jira" });
      dot.title = source.id.toUpperCase();
    }

    // Priority score dot
    if (priority.score > 0) {
      const tierClass =
        priority.score >= 60
          ? "wt-compact-dot--priority-high"
          : priority.score >= 30
            ? "wt-compact-dot--priority-medium"
            : "wt-compact-dot--priority-low";
      const dot = container.createSpan({ cls: `wt-compact-dot ${tierClass}` });
      dot.title = `Priority: ${priority.score}`;
    }

    // Goal dot
    if (goal.length > 0) {
      const displayGoal = normalizeObsidianDisplayText(goal[0]);
      const dot = container.createSpan({ cls: "wt-compact-dot wt-compact-dot--goal" });
      dot.title = displayGoal.replace(/-/g, " ");
    }

    // Card flag dots
    const matchedFlags = matchCardFlags(this.flagRules, meta);
    for (const flag of matchedFlags) {
      const dot = container.createSpan({ cls: "wt-compact-dot wt-compact-dot--flag" });
      if (flag.color) {
        dot.style.backgroundColor = flag.color;
      }
      dot.title = flag.tooltip || flag.label;
    }
  }

  /**
   * Render a single matched card flag using the appropriate visual treatment.
   */
  private renderFlag(metaRow: HTMLElement, card: HTMLElement, flag: MatchedCardFlag): void {
    const tooltip = flag.tooltip ? normalizeObsidianDisplayText(flag.tooltip) : undefined;

    switch (flag.style) {
      case "badge": {
        const el = metaRow.createSpan({ cls: "wt-card-flag wt-card-flag--badge" });
        el.textContent = flag.label;
        if (flag.color) {
          el.style.background = flag.color;
          el.style.color = "var(--text-on-accent, white)";
        }
        if (tooltip) el.title = tooltip;
        break;
      }
      case "accent-border": {
        card.addClass("wt-card-flag--accent-border");
        if (flag.color) {
          card.style.setProperty("--wt-flag-accent-color", flag.color);
        }
        // Also add a small label in the meta row
        const el = metaRow.createSpan({ cls: "wt-card-flag wt-card-flag--accent-label" });
        el.textContent = flag.label;
        if (flag.color) el.style.color = flag.color;
        if (tooltip) el.title = tooltip;
        break;
      }
      case "background-tint": {
        card.addClass("wt-card-flag--bg-tint");
        if (flag.color) {
          card.style.setProperty("--wt-flag-bg-tint", flag.color);
        }
        // Also add a small label in the meta row
        const el = metaRow.createSpan({ cls: "wt-card-flag wt-card-flag--tint-label" });
        el.textContent = flag.label;
        if (tooltip) el.title = tooltip;
        break;
      }
      default: {
        const _exhaustive: never = flag.style;
        break;
      }
    }
  }

  getContextMenuItems(item: WorkItem, ctx: CardActionContext): MenuItem[] {
    const items: MenuItem[] = [];

    // Move to top
    (items as any[]).push({
      title: "Move to Top",
      callback: () => ctx.onMoveToTop(),
    });

    // Retry enrichment (shown only when background ingestion failed)
    const meta = (item.metadata || {}) as Record<string, any>;
    if (meta.backgroundIngestion === "failed") {
      (items as any[]).push({
        title: "Retry Enrichment",
        callback: () => ctx.onRetryEnrich(),
      });
    }

    // Split task: create new task with reference, spawn Claude to scope it
    (items as any[]).push({
      title: "Split Task",
      callback: () => ctx.onSplitTask(item),
    });

    (items as any[]).push({ separator: true });

    // Move to other columns
    for (const col of KANBAN_COLUMNS) {
      if (col === item.state) continue;
      (items as any[]).push({
        title: `Move to ${COLUMN_LABELS[col]}`,
        callback: () => ctx.onMoveToColumn(col),
      });
      // Done & Close Sessions right after Move to Done
      if (col === "done") {
        (items as any[]).push({
          title: "Done & Close Sessions",
          callback: () => {
            ctx.onMoveToColumn("done");
            try {
              ctx.onCloseSessions();
            } catch (err) {
              console.error("[work-terminal] Failed to close sessions:", err);
            }
          },
        });
      }
    }

    (items as any[]).push({ separator: true });

    // Copy actions
    (items as any[]).push({
      title: "Copy Name",
      callback: () => navigator.clipboard.writeText(item.title),
    });
    (items as any[]).push({
      title: "Copy Path",
      callback: () => navigator.clipboard.writeText(item.path),
    });
    (items as any[]).push({
      title: "Copy Context Prompt",
      callback: async () => {
        const prompt = await ctx.getContextPrompt();
        if (!prompt) {
          new Notice("Could not build a context prompt for this task");
          return;
        }
        await navigator.clipboard.writeText(prompt);
      },
    });

    (items as any[]).push({ separator: true });

    // Delete (danger)
    (items as any[]).push({
      title: "Delete Task",
      danger: true,
      callback: () => ctx.onDelete(),
    });

    return items;
  }
}
