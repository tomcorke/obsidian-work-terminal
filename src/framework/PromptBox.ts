/**
 * PromptBox - inline item creation UI with title input and column selector.
 * Enter to submit, Shift+Enter for newline.
 * Coordinates with adapter.onItemCreated for background enrichment.
 */
import type { Plugin } from "obsidian";
import type { AdapterBundle } from "../core/interfaces";

export class PromptBox {
  private containerEl: HTMLElement;
  private inputEl: HTMLTextAreaElement;
  private columnSelect: HTMLSelectElement;
  private adapter: AdapterBundle;
  private plugin: Plugin;
  private settings: Record<string, any>;
  private onPlaceholderAdd: (path: string) => void;
  private onPlaceholderResolve: (path: string, success: boolean) => void;
  private onNewItemCreated: (
    id: string,
    columnId: string,
    placeholderPath: string,
    enrichmentDone?: Promise<void>,
  ) => void;
  private expanded = false;

  constructor(
    parentEl: HTMLElement,
    adapter: AdapterBundle,
    plugin: Plugin,
    settings: Record<string, any>,
    onPlaceholderAdd: (path: string) => void,
    onPlaceholderResolve: (path: string, success: boolean) => void,
    onNewItemCreated: (
      id: string,
      columnId: string,
      placeholderPath: string,
      enrichmentDone?: Promise<void>,
    ) => void,
  ) {
    this.adapter = adapter;
    this.plugin = plugin;
    this.settings = settings;
    this.onPlaceholderAdd = onPlaceholderAdd;
    this.onPlaceholderResolve = onPlaceholderResolve;
    this.onNewItemCreated = onNewItemCreated;

    this.containerEl = parentEl.createDiv({
      cls: "wt-prompt-box",
      attr: { "data-wt-tour": "prompt-box" },
    });

    // Toggle button
    const toggleBtn = this.containerEl.createEl("button", {
      cls: "wt-prompt-toggle",
      text: `+ New ${adapter.config.itemName}`,
    });

    // Expanded content (hidden by default)
    const expandedEl = this.containerEl.createDiv({ cls: "wt-prompt-expanded" });
    expandedEl.style.display = "none";

    // Title input
    this.inputEl = expandedEl.createEl("textarea", {
      cls: "wt-prompt-input",
      attr: { placeholder: `${adapter.config.itemName} title...`, rows: "2" },
    });

    // Column selector
    const selectorRow = expandedEl.createDiv({ cls: "wt-prompt-selector-row" });
    this.columnSelect = selectorRow.createEl("select", { cls: "wt-prompt-column-select" });
    for (const col of adapter.config.creationColumns) {
      const opt = this.columnSelect.createEl("option", {
        text: col.label,
        value: col.id,
      });
      if (col.default) opt.selected = true;
    }

    // Send button
    const sendBtn = selectorRow.createEl("button", {
      cls: "wt-prompt-send",
      text: "Create",
    });

    // Toggle behavior
    toggleBtn.addEventListener("click", () => {
      this.expanded = !this.expanded;
      expandedEl.style.display = this.expanded ? "" : "none";
      if (this.expanded) {
        this.inputEl.focus();
      }
    });

    // Enter to submit, Shift+Enter for newline
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.submit();
      }
      // Stop propagation to prevent Obsidian shortcuts
      e.stopPropagation();
    });

    sendBtn.addEventListener("click", () => this.submit());
  }

  private async submit(): Promise<void> {
    const title = this.inputEl.value.trim();
    if (!title) return;

    const columnId = this.columnSelect.value;

    // Clear input before callback (so user can type next item)
    this.inputEl.value = "";

    // Create placeholder path (adapter will provide real path)
    const placeholderPath = `__pending_${Date.now()}`;
    this.onPlaceholderAdd(placeholderPath);

    try {
      // Adapter handles actual file creation
      let hasCardMapping = false;
      if (this.adapter.onItemCreated) {
        const result = await this.adapter.onItemCreated(title, {
          ...this.settings,
          _columnId: columnId,
          _placeholderPath: placeholderPath,
        });
        if (result && result.id) {
          this.onNewItemCreated(result.id, result.columnId, placeholderPath, result.enrichmentDone);
          hasCardMapping = true;
        }
      }
      // If onNewItemCreated was called, ListPanel will auto-resolve the
      // placeholder when the real card renders. Otherwise fall back to
      // immediate resolution so the placeholder doesn't get stuck.
      if (!hasCardMapping) {
        this.onPlaceholderResolve(placeholderPath, true);
      }
    } catch (err) {
      console.error("[work-terminal] Item creation failed:", err);
      this.onPlaceholderResolve(placeholderPath, false);
    }
  }
}
