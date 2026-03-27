import type { MenuItem } from "obsidian";
import type { WorkItem, CardRenderer, CardActionContext } from "../../core/interfaces";
import { KANBAN_COLUMNS, COLUMN_LABELS, SOURCE_LABELS, type KanbanColumn } from "./types";

export class TaskCard implements CardRenderer {
  render(item: WorkItem, ctx: CardActionContext): HTMLElement {
    const meta = (item.metadata || {}) as Record<string, any>;
    const source = meta.source || { type: "other" };
    const priority = meta.priority || { score: 0 };
    const goal: string[] = meta.goal || [];
    const ingesting = !!meta.ingesting;

    const card = document.createElement("div");
    card.addClass("wt-card");
    if (ingesting) card.addClass("ingesting");
    card.dataset.path = item.path;
    card.draggable = true;

    // Title row
    const titleRow = card.createDiv({ cls: "wt-card-title-row" });
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
      } else {
        sourceBadge.textContent = SOURCE_LABELS[source.type] || "---";
      }
    }

    // Ingesting indicator
    if (ingesting) {
      const badge = metaRow.createSpan({ cls: "wt-card-ingesting" });
      badge.textContent = "ingesting...";
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
      const goalEl = metaRow.createSpan({ cls: "wt-card-goal" });
      goalEl.textContent = g.replace(/-/g, " ");
      goalEl.title = g;
    }

    // Blocker indicator
    if (priority["has-blocker"]) {
      const blockerEl = metaRow.createSpan({ cls: "wt-card-source" });
      blockerEl.textContent = "BLOCKED";
      blockerEl.style.background = "#e5484d";
      blockerEl.style.color = "white";
      if (priority["blocker-context"]) {
        blockerEl.title = priority["blocker-context"];
      }
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

  getContextMenuItems(item: WorkItem, ctx: CardActionContext): MenuItem[] {
    const items: MenuItem[] = [];
    const meta = (item.metadata || {}) as Record<string, any>;

    // Move to top
    (items as any[]).push({
      title: "Move to Top",
      callback: () => ctx.onMoveToTop(),
    });

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
      callback: () => {
        const prompt = this.buildQuickPrompt(item);
        navigator.clipboard.writeText(prompt);
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

  private buildQuickPrompt(item: WorkItem): string {
    const meta = (item.metadata || {}) as Record<string, any>;
    const priority = meta.priority || {};
    let prompt = `Task: ${item.title}\nState: ${item.state}\nPath: ${item.path}`;
    if (priority.deadline) {
      prompt += `\nDeadline: ${priority.deadline}`;
    }
    if (priority["has-blocker"] && priority["blocker-context"]) {
      prompt += `\nBlocker: ${priority["blocker-context"]}`;
    }
    return prompt;
  }
}
