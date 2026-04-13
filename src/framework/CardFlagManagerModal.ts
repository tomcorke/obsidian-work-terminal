/**
 * CardFlagManagerModal - settings modal listing custom card flag rules.
 * Supports add, edit, delete, and reorder operations.
 * Rules are persisted as a JSON string in adapter.customCardFlags setting.
 */
import { App, Modal, Notice } from "obsidian";
import type { CardFlagRule, CardFlagOperator, CardFlagStyle } from "../core/interfaces";
import { CardFlagRuleModal } from "./CardFlagRuleModal";

const OPERATOR_LABELS: Record<CardFlagOperator, string> = {
  eq: "=",
  neq: "!=",
  gt: ">",
  lt: "<",
  gte: ">=",
  lte: "<=",
  contains: "contains",
  regex: "regex",
};

const STYLE_LABELS: Record<CardFlagStyle, string> = {
  badge: "badge",
  "accent-border": "border",
  "background-tint": "tint",
};

export class CardFlagManagerModal extends Modal {
  private rules: CardFlagRule[];

  constructor(
    app: App,
    rules: CardFlagRule[],
    private defaultRules: CardFlagRule[],
    private onSave: (rules: CardFlagRule[]) => void,
  ) {
    super(app);
    // Deep copy to avoid mutating the original array
    this.rules = rules.map((r) => ({ ...r }));
  }

  onOpen(): void {
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("wt-card-flag-manager-modal");

    contentEl.createEl("h3", { text: "Card Flag Rules" });

    const helpEl = contentEl.createDiv({ cls: "wt-card-flag-manager-help" });
    helpEl.createEl("p", {
      text: "Define rules that match frontmatter fields and display visual indicators on task cards. All matching rules are applied (not just the first match).",
    });

    // Default rules (read-only display)
    if (this.defaultRules.length > 0) {
      const defaultSection = contentEl.createDiv({ cls: "wt-card-flag-defaults" });
      defaultSection.createEl("h4", { text: "Default rules (built-in)" });
      for (const rule of this.defaultRules) {
        this.renderRuleRow(defaultSection, rule, -1, true);
      }
    }

    // Custom rules (editable)
    const customSection = contentEl.createDiv({ cls: "wt-card-flag-custom" });
    customSection.createEl("h4", { text: "Custom rules" });

    if (this.rules.length === 0) {
      customSection.createEl("p", {
        text: "No custom rules defined. Add one to get started.",
        cls: "wt-card-flag-empty",
      });
    }

    const listEl = customSection.createDiv({ cls: "wt-card-flag-list" });
    for (let i = 0; i < this.rules.length; i++) {
      this.renderRuleRow(listEl, this.rules[i], i, false);
    }

    // Action buttons
    const actions = contentEl.createDiv({ cls: "wt-card-flag-manager-actions" });

    const addBtn = actions.createEl("button", { text: "+ Add Rule", cls: "mod-cta" });
    addBtn.addEventListener("click", () => {
      new CardFlagRuleModal(this.app, null, (saved) => {
        this.rules.push(saved);
        this.saveAndRender();
      }).open();
    });

    const importBtn = actions.createEl("button", { text: "Import JSON" });
    importBtn.addEventListener("click", () => this.handleImport());

    const exportBtn = actions.createEl("button", { text: "Export JSON" });
    exportBtn.addEventListener("click", () => this.handleExport());

    // Close button
    const closeActions = contentEl.createDiv({ cls: "wt-card-flag-manager-close" });
    const doneBtn = closeActions.createEl("button", { text: "Done" });
    doneBtn.addEventListener("click", () => this.close());
  }

  private renderRuleRow(
    container: HTMLElement,
    rule: CardFlagRule,
    index: number,
    isDefault: boolean,
  ): void {
    const row = container.createDiv({
      cls: `wt-card-flag-row${isDefault ? " wt-card-flag-row--default" : ""}`,
    });

    // Reorder buttons (only for custom rules)
    if (!isDefault) {
      const reorderEl = row.createDiv({ cls: "wt-card-flag-reorder" });

      const upBtn = reorderEl.createEl("button", {
        text: "\u25B2",
        cls: "wt-card-flag-reorder-btn",
        attr: { "aria-label": "Move rule up" },
      });
      upBtn.disabled = index === 0;
      upBtn.addEventListener("click", () => {
        if (index > 0) {
          [this.rules[index - 1], this.rules[index]] = [this.rules[index], this.rules[index - 1]];
          this.saveAndRender();
        }
      });

      const downBtn = reorderEl.createEl("button", {
        text: "\u25BC",
        cls: "wt-card-flag-reorder-btn",
        attr: { "aria-label": "Move rule down" },
      });
      downBtn.disabled = index === this.rules.length - 1;
      downBtn.addEventListener("click", () => {
        if (index < this.rules.length - 1) {
          [this.rules[index], this.rules[index + 1]] = [this.rules[index + 1], this.rules[index]];
          this.saveAndRender();
        }
      });
    }

    // Rule summary
    const infoEl = row.createDiv({ cls: "wt-card-flag-info" });

    // Label badge preview
    const labelBadge = infoEl.createSpan({ cls: "wt-card-flag-label-preview" });
    labelBadge.textContent = rule.label;
    if (rule.color && (rule.style || "badge") === "badge") {
      labelBadge.style.background = rule.color;
      labelBadge.style.color = "var(--text-on-accent, white)";
    } else if (rule.color) {
      labelBadge.style.color = rule.color;
    }

    // Condition description
    const condEl = infoEl.createDiv({ cls: "wt-card-flag-condition" });
    const condText = this.formatCondition(rule);
    condEl.textContent = condText;

    // Style tag
    const styleTag = infoEl.createSpan({ cls: "wt-card-flag-style-tag" });
    styleTag.textContent = STYLE_LABELS[rule.style || "badge"];

    // Edit button (only for custom rules)
    if (!isDefault) {
      const editBtn = row.createEl("button", { text: "Edit", cls: "wt-card-flag-edit-btn" });
      editBtn.addEventListener("click", () => {
        new CardFlagRuleModal(
          this.app,
          rule,
          (saved) => {
            this.rules[index] = saved;
            this.saveAndRender();
          },
          () => {
            this.rules.splice(index, 1);
            this.saveAndRender();
          },
        ).open();
      });
    } else {
      // Read-only indicator
      const readOnly = row.createSpan({ cls: "wt-card-flag-readonly" });
      readOnly.textContent = "built-in";
    }
  }

  private formatCondition(rule: CardFlagRule): string {
    const field = rule.field;

    if (rule.operator && rule.operand !== undefined) {
      const opLabel = OPERATOR_LABELS[rule.operator] || rule.operator;
      return `${field} ${opLabel} ${rule.operand}`;
    }

    if (rule.contains !== undefined) {
      return `${field} contains "${rule.contains}"`;
    }

    if (rule.value !== undefined) {
      return `${field} = ${JSON.stringify(rule.value)}`;
    }

    return `${field} is truthy`;
  }

  private async saveAndRender(): Promise<void> {
    await this.onSave(this.rules.map((r) => ({ ...r })));
    this.render();
  }

  private handleImport(): void {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed)) {
          new Notice("Import failed: expected a JSON array of rules");
          return;
        }
        // Validate each rule has at minimum field + label
        let imported = 0;
        for (const entry of parsed) {
          if (entry && typeof entry === "object" && entry.field && entry.label) {
            this.rules.push(entry as CardFlagRule);
            imported++;
          }
        }
        if (imported > 0) {
          new Notice(`Imported ${imported} rule(s)`);
          this.saveAndRender();
        } else {
          new Notice("No valid rules found in import file");
        }
      } catch (err) {
        new Notice(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    input.click();
  }

  private handleExport(): void {
    if (this.rules.length === 0) {
      new Notice("No custom rules to export");
      return;
    }
    const json = JSON.stringify(this.rules, null, 2);
    navigator.clipboard
      .writeText(json)
      .then(() => {
        new Notice(`${this.rules.length} rule(s) copied to clipboard as JSON`);
      })
      .catch(() => {
        console.error("[work-terminal] Failed to copy rules to clipboard:", json);
        new Notice("Could not copy to clipboard. Check console for JSON output.");
      });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
