/**
 * CardFlagRuleModal - modal for editing a single custom card flag rule.
 * Covers all rule fields: field path, operator, operand, label, style, color, tooltip.
 */
import { App, Modal, Setting } from "obsidian";
import type { CardFlagRule, CardFlagOperator, CardFlagStyle } from "../core/interfaces";

const OPERATOR_LABELS: Record<CardFlagOperator, string> = {
  eq: "equals",
  neq: "not equals",
  gt: "greater than",
  lt: "less than",
  gte: "greater than or equal",
  lte: "less than or equal",
  contains: "contains",
  regex: "matches regex",
};

const STYLE_LABELS: Record<CardFlagStyle, string> = {
  badge: "Badge",
  "accent-border": "Accent border",
  "background-tint": "Background tint",
};

function createDefaultRule(): CardFlagRule {
  return {
    field: "",
    operator: "eq",
    operand: "",
    label: "",
    style: "badge",
    color: "",
  };
}

export class CardFlagRuleModal extends Modal {
  private draft: CardFlagRule;
  private isNew: boolean;
  private _previewEl: HTMLElement | null = null;

  constructor(
    app: App,
    rule: CardFlagRule | null,
    private onSave: (rule: CardFlagRule) => void,
    private onDelete?: (rule: CardFlagRule) => void,
  ) {
    super(app);
    this.isNew = !rule;
    this.draft = rule ? { ...rule } : createDefaultRule();
  }

  onOpen(): void {
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("wt-card-flag-rule-modal");

    contentEl.createEl("h3", { text: this.isNew ? "Add Card Flag Rule" : "Edit Card Flag Rule" });

    // Field path
    new Setting(contentEl)
      .setName("Field path")
      .setDesc("Dot-separated path into task frontmatter (e.g. priority.score, tags, source.type)")
      .addText((text) =>
        text
          .setPlaceholder("priority.score")
          .setValue(this.draft.field)
          .onChange((v) => {
            this.draft.field = v.trim();
            this.refreshPreview();
          }),
      );

    // Operator
    new Setting(contentEl)
      .setName("Operator")
      .setDesc("How to compare the field value against the operand")
      .addDropdown((dropdown) => {
        for (const [op, label] of Object.entries(OPERATOR_LABELS)) {
          dropdown.addOption(op, label);
        }
        dropdown.setValue(this.draft.operator || "eq").onChange((v) => {
          this.draft.operator = v as CardFlagOperator;
          this.updateOperandHint();
          this.refreshPreview();
        });
      });

    // Operand
    const operandSetting = new Setting(contentEl)
      .setName("Value")
      .setDesc(this.getOperandHint())
      .addText((text) =>
        text
          .setPlaceholder("80")
          .setValue(this.draft.operand || "")
          .onChange((v) => {
            this.draft.operand = v;
            this.refreshPreview();
          }),
      );
    this._operandSetting = operandSetting;

    // Label
    new Setting(contentEl)
      .setName("Label")
      .setDesc("Text displayed on the card when this rule matches")
      .addText((text) =>
        text
          .setPlaceholder("HIGH")
          .setValue(this.draft.label)
          .onChange((v) => {
            this.draft.label = v.trim();
            this.refreshPreview();
          }),
      );

    // Style
    new Setting(contentEl)
      .setName("Style")
      .setDesc(
        "Visual treatment: badge (coloured pill), accent-border (left border), background-tint (subtle background)",
      )
      .addDropdown((dropdown) => {
        for (const [style, label] of Object.entries(STYLE_LABELS)) {
          dropdown.addOption(style, label);
        }
        dropdown.setValue(this.draft.style || "badge").onChange((v) => {
          this.draft.style = v as CardFlagStyle;
          this.refreshPreview();
        });
      });

    // Color
    new Setting(contentEl)
      .setName("Color")
      .setDesc("CSS colour value (e.g. red, #e5484d, rgba(255,0,0,0.3)). Leave empty for default.")
      .addText((text) =>
        text
          .setPlaceholder("#e5484d")
          .setValue(this.draft.color || "")
          .onChange((v) => {
            this.draft.color = v.trim() || undefined;
            this.refreshPreview();
          }),
      );

    // Tooltip
    new Setting(contentEl)
      .setName("Tooltip")
      .setDesc(
        "Hover text. Supports {{field.path}} placeholders resolved from frontmatter. Leave empty for none.",
      )
      .addText((text) =>
        text
          .setPlaceholder("{{priority.blocker-context}}")
          .setValue(this.draft.tooltip || "")
          .onChange((v) => {
            this.draft.tooltip = v.trim() || undefined;
          }),
      );

    // Preview (stored for live updates)
    this._previewEl = contentEl.createDiv();
    this.refreshPreview();

    // Action buttons
    const actions = contentEl.createDiv({ cls: "wt-card-flag-rule-actions" });

    const saveBtn = actions.createEl("button", { text: "Save", cls: "mod-cta" });
    saveBtn.addEventListener("click", () => {
      if (!this.draft.field || !this.draft.label) {
        // Highlight missing fields
        if (!this.draft.field) {
          contentEl.querySelector<HTMLInputElement>('input[placeholder="priority.score"]')?.focus();
        } else {
          contentEl.querySelector<HTMLInputElement>('input[placeholder="HIGH"]')?.focus();
        }
        return;
      }
      // Clean up empty optional fields
      if (!this.draft.color) delete this.draft.color;
      if (!this.draft.tooltip) delete this.draft.tooltip;
      this.onSave(this.draft);
      this.close();
    });

    if (!this.isNew && this.onDelete) {
      const deleteBtn = actions.createEl("button", {
        text: "Delete",
        cls: "mod-warning",
      });
      deleteBtn.addEventListener("click", () => {
        this.onDelete?.(this.draft);
        this.close();
      });
    }

    const cancelBtn = actions.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.close());
  }

  private _operandSetting: Setting | null = null;

  private getOperandHint(): string {
    const op = this.draft.operator || "eq";
    switch (op) {
      case "gt":
      case "lt":
      case "gte":
      case "lte":
        return "Numeric value to compare against";
      case "regex":
        return "Regular expression pattern (e.g. ^PROJ-\\d+$)";
      case "contains":
        return "Substring or array element to look for";
      case "eq":
      case "neq":
        return "Exact string value to compare (values are coerced to strings)";
      default:
        return "Comparison value";
    }
  }

  private updateOperandHint(): void {
    if (this._operandSetting) {
      this._operandSetting.setDesc(this.getOperandHint());
    }
  }

  /** Re-render only the preview section without rebuilding the entire form. */
  private refreshPreview(): void {
    if (!this._previewEl) return;
    this.renderPreview(this._previewEl);
  }

  private renderPreview(containerEl: HTMLElement): void {
    containerEl.empty();

    const previewSection = containerEl.createDiv({ cls: "wt-card-flag-rule-preview" });
    previewSection.createEl("h4", { text: "Preview" });

    const previewCard = previewSection.createDiv({ cls: "wt-card-flag-rule-preview-card" });

    const label = this.draft.label || "(label)";
    const style = this.draft.style || "badge";
    const color = this.draft.color;

    const badgeEl = previewCard.createSpan({ cls: "wt-card-flag-rule-preview-badge" });
    badgeEl.textContent = label;

    if (style === "badge" && color) {
      badgeEl.style.background = color;
      badgeEl.style.color = "var(--text-on-accent, white)";
    } else if (style === "accent-border" && color) {
      previewCard.style.borderLeft = `3px solid ${color}`;
      badgeEl.style.color = color;
    } else if (style === "background-tint" && color) {
      previewCard.style.background = color;
    }

    const desc = previewSection.createDiv({ cls: "wt-card-flag-rule-preview-desc" });
    const field = this.draft.field || "(field)";
    const op = OPERATOR_LABELS[this.draft.operator || "eq"] || "equals";
    const operand = this.draft.operand || "(value)";
    desc.textContent = `When ${field} ${op} ${operand}`;
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
