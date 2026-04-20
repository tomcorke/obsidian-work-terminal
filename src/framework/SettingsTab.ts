/**
 * WorkTerminalSettingsTab - single settings UI combining core framework
 * settings with adapter-provided settings via namespaced keys.
 *
 * Core settings: core.defaultShell, core.defaultTerminalCwd, toggles
 * Agent settings: managed via Agent Profile Manager (profiles replace
 *   the legacy per-agent command/args/context fields)
 * Adapter settings: adapter.* (from adapter.config.settingsSchema)
 */
import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type { Plugin } from "obsidian";
import type {
  AdapterBundle,
  CardDisplayMode,
  CardFlagRule,
  SettingField,
} from "../core/interfaces";
import { mergeAndSavePluginData } from "../core/PluginDataStore";
import { resetGuidedTourStatus } from "./GuidedTour";
import type { AgentProfileManager } from "../core/agents/AgentProfileManager";
import { AgentProfileManagerModal } from "./AgentProfileManagerModal";
import { CardFlagManagerModal } from "./CardFlagManagerModal";
import { EnrichmentSettingsDialog } from "./EnrichmentSettingsDialog";
import { parseCardFlagRulesJson, serializeCardFlagRules } from "../core/cardFlags";
import type { ViewMode, RecentThreshold } from "./ActivityTracker";
import type { DetailViewPlacement, DetailViewSplitDirection } from "../core/detailViewPlacement";
import { resolveDetailViewOptions } from "../core/detailViewPlacement";

interface CoreSettings {
  "core.claudeCommand": string;
  "core.claudeExtraArgs": string;
  "core.copilotCommand": string;
  "core.copilotExtraArgs": string;
  "core.strandsCommand": string;
  "core.strandsExtraArgs": string;
  "core.additionalAgentContext": string;
  "core.defaultShell": string;
  "core.defaultTerminalCwd": string;
  "core.exposeDebugApi": boolean;
  "core.keepSessionsAlive": boolean;
  "core.enrichmentLogging": boolean;
  "core.cardDisplayMode": CardDisplayMode;
  "core.viewMode": ViewMode;
  "core.recentThreshold": RecentThreshold;
  "core.detailViewPlacement": DetailViewPlacement;
  "core.detailViewWidthOverride": boolean;
  "core.detailViewAutoClose": boolean;
  "core.detailViewSplitDirection": DetailViewSplitDirection;
}

export const SETTINGS_CHANGED_EVENT = "work-terminal:settings-changed";

const CORE_DEFAULTS: CoreSettings = {
  "core.claudeCommand": "claude",
  "core.claudeExtraArgs": "",
  "core.copilotCommand": "copilot",
  "core.copilotExtraArgs": "",
  "core.strandsCommand": "strands",
  "core.strandsExtraArgs": "",
  "core.additionalAgentContext": "",
  "core.defaultShell": process.env.SHELL || "/bin/zsh",
  "core.defaultTerminalCwd": "~",
  "core.exposeDebugApi": false,
  "core.keepSessionsAlive": true,
  "core.enrichmentLogging": true,
  "core.cardDisplayMode": "standard",
  "core.viewMode": "kanban",
  "core.recentThreshold": "3h",
  "core.detailViewPlacement": "split",
  "core.detailViewWidthOverride": true,
  "core.detailViewAutoClose": false,
  "core.detailViewSplitDirection": "vertical",
};

export class WorkTerminalSettingsTab extends PluginSettingTab {
  private adapter: AdapterBundle;
  private plugin: Plugin;
  private profileManager: AgentProfileManager;
  private adapterPromptDescription?: string;

  constructor(
    app: App,
    plugin: Plugin,
    adapter: AdapterBundle,
    profileManager: AgentProfileManager,
  ) {
    super(app, plugin);
    this.plugin = plugin;
    this.adapter = adapter;
    this.profileManager = profileManager;

    // Get the adapter's prompt format description for the profile UI
    try {
      const promptBuilder = adapter.createPromptBuilder();
      if (promptBuilder?.describePromptFormat) {
        this.adapterPromptDescription = promptBuilder.describePromptFormat();
      }
    } catch (error) {
      // createPromptBuilder() or describePromptFormat() threw at construction time
      console.warn("[work-terminal] Failed to get adapter prompt format description", error);
    }
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // Agent Profiles section
    containerEl.createEl("h2", { text: "Agent Profiles" });
    new Setting(containerEl)
      .setName("Manage agent profiles")
      .setDesc(
        "Configure reusable agent launch profiles with custom commands, arguments, and tab bar buttons.",
      )
      .addButton((btn) =>
        btn
          .setButtonText("Open Profile Manager")
          .setCta()
          .onClick(() => {
            new AgentProfileManagerModal(
              this.app,
              this.profileManager,
              this.adapterPromptDescription,
            ).open();
          }),
      );

    // Core settings section
    containerEl.createEl("h2", { text: "Core" });

    this.addCoreSetting(
      containerEl,
      "core.defaultShell",
      "Default shell",
      "Shell used for new terminal tabs",
    );
    this.addCoreSetting(
      containerEl,
      "core.defaultTerminalCwd",
      "Default terminal CWD",
      "Working directory for new terminals (supports ~)",
    );
    this.addCoreToggle(
      containerEl,
      "core.keepSessionsAlive",
      "Keep sessions alive when tab is closed",
      "Stash terminal sessions to memory instead of killing them when the Work Terminal tab is closed. Reopening the tab restores sessions with full PTY state.",
    );
    this.addCoreToggle(
      containerEl,
      "core.enrichmentLogging",
      "Enrichment failure logs",
      "When a background enrichment attempt fails, write a detailed log file (prompt, agent stdout/stderr, error details) to the plugin's logs/ directory. Logs older than 7 days are auto-pruned and only the 50 most recent are retained. Logs may contain task content and agent output - see the user guide for details.",
    );
    this.addCoreDropdown(
      containerEl,
      "core.cardDisplayMode",
      "Card display mode",
      "Standard shows full card details. Comfortable adds extra padding and spacing for easier scanning. Compact shows single-line cards with indicator dots replacing verbose badges.",
      { standard: "Standard", comfortable: "Comfortable", compact: "Compact" },
    );
    this.addCoreDropdown(
      containerEl,
      "core.viewMode",
      "View mode",
      "Kanban groups tasks by state columns. Activity groups tasks by recency (recent, last 7 days, last 30 days, older).",
      { kanban: "Kanban (by state)", activity: "Activity (by recency)" },
    );
    this.addCoreDropdown(
      containerEl,
      "core.recentThreshold",
      "Recent activity threshold",
      'How far back the "Recent" section extends in activity view. The section always includes today, or the configured threshold, whichever is longer.',
      { "1h": "Last hour", "3h": "Last 3 hours (default)", "24h": "Last 24 hours" },
    );

    this.addCoreToggle(
      containerEl,
      "core.exposeDebugApi",
      "Expose debug API",
      "Publishes window.__workTerminalDebug for CDP inspection. Disabled by default because it exposes active session metadata to other renderer plugins.",
    );

    new Setting(containerEl)
      .setName("Reset guided tour")
      .setDesc(
        "Clear guided tour completion status so it starts again next time you open Work Terminal.",
      )
      .addButton((btn) =>
        btn.setButtonText("Reset").onClick(async () => {
          await resetGuidedTourStatus(this.plugin);
          new Notice("Guided tour will start next time you open Work Terminal");
        }),
      );

    // Detail view section - controls how task detail files are opened when
    // a work item is selected. Placement-dependent controls are only shown
    // when they apply.
    containerEl.createEl("h2", { text: "Detail view" });
    this.renderDetailViewSettings(containerEl);

    // Adapter settings section
    const schema = this.adapter.config.settingsSchema;
    // Enrichment settings live behind a dedicated dialog to reduce clutter in
    // the main adapter section. The enrichmentEnabled toggle stays top-level
    // so users see at a glance that enrichment exists and can switch it off
    // without opening the dialog.
    const enrichmentDialogKeys = new Set([
      "enrichmentEnabled",
      "enrichmentPrompt",
      "retryEnrichmentPrompt",
      "enrichmentProfile",
      "enrichmentTimeout",
    ]);
    const hasEnrichmentSchema = schema.some((field) => enrichmentDialogKeys.has(field.key));
    const nonEnrichmentSchema = schema.filter((field) => !enrichmentDialogKeys.has(field.key));

    if (hasEnrichmentSchema) {
      containerEl.createEl("h2", { text: "Background enrichment" });
      // Render the enabled toggle if it is in the schema (keeps the default
      // wiring intact for non-task-agent adapters that might omit it).
      const enabledField = schema.find((f) => f.key === "enrichmentEnabled");
      if (enabledField) {
        this.addAdapterSetting(containerEl, enabledField);
      }
      new Setting(containerEl)
        .setName("Configure enrichment")
        .setDesc(
          "Open a dialog to customise the enrichment prompt, retry prompt, agent " +
            "profile, and timeout. The built-in default prompts are displayed inside " +
            "the dialog so you can read them before deciding whether to override.",
        )
        .addButton((btn) =>
          btn
            .setButtonText("Configure enrichment...")
            .setCta()
            .onClick(() => {
              new EnrichmentSettingsDialog(
                this.app,
                this.plugin,
                this.adapter,
                this.profileManager,
              ).open();
            }),
        );
    }

    if (nonEnrichmentSchema.length > 0) {
      containerEl.createEl("h2", { text: "Adapter" });
      for (const field of nonEnrichmentSchema) {
        this.addAdapterSetting(containerEl, field);
      }
    }

    // Column management section (shown when the adapter has columns)
    if (this.adapter.config.columns.length > 0) {
      containerEl.createEl("h2", { text: "Column Order & Creation" });
      this.renderColumnOrderControls(containerEl);
      this.renderCreationColumnControls(containerEl);
    }

    // Card flag rules section (shown when the adapter provides cardFlags)
    if (this.adapter.config.cardFlags !== undefined) {
      containerEl.createEl("h2", { text: "Card Indicators" });
      this.addCardFlagRulesButton(containerEl);
    }
  }

  private async saveSettings(update: (settings: Record<string, unknown>) => void): Promise<void> {
    await mergeAndSavePluginData(this.plugin, async (data) => {
      if (!data.settings) data.settings = {};
      update(data.settings);
    });
    const allSettings = await loadAllSettings(this.plugin, this.adapter);
    // Update adapter config directly so settings UI stays current even when
    // the Work Terminal view is not open (and thus no MainView listener exists).
    this.adapter.onSettingsChanged?.(allSettings);
    window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT, { detail: allSettings }));
  }

  private async addCoreSetting(
    containerEl: HTMLElement,
    key: keyof CoreSettings,
    name: string,
    description: string,
    tourId?: string,
  ): Promise<void> {
    const data = (await this.plugin.loadData()) || {};
    const settings = data.settings || {};
    const value = settings[key] ?? CORE_DEFAULTS[key];

    const setting = new Setting(containerEl)
      .setName(name)
      .setDesc(description)
      .addText((text) => {
        text.inputEl.dataset.settingKey = key;
        text.setValue(String(value)).onChange(async (newValue) => {
          await this.saveSettings((settings) => {
            settings[key] = newValue;
          });
        });
      });
    if (tourId) {
      setting.settingEl.setAttribute("data-wt-tour", tourId);
    }
  }

  private async addCoreToggle(
    containerEl: HTMLElement,
    key: keyof CoreSettings,
    name: string,
    description: string,
    tourId?: string,
  ): Promise<void> {
    const data = (await this.plugin.loadData()) || {};
    const settings = data.settings || {};
    const value = settings[key] ?? CORE_DEFAULTS[key];

    const setting = new Setting(containerEl)
      .setName(name)
      .setDesc(description)
      .addToggle((toggle) =>
        toggle.setValue(!!value).onChange(async (newValue) => {
          await this.saveSettings((settings) => {
            settings[key] = newValue;
          });
        }),
      );
    if (tourId) {
      setting.settingEl.setAttribute("data-wt-tour", tourId);
    }
  }

  private async addCoreDropdown(
    containerEl: HTMLElement,
    key: keyof CoreSettings,
    name: string,
    description: string,
    choices: Record<string, string>,
  ): Promise<void> {
    const data = (await this.plugin.loadData()) || {};
    const settings = data.settings || {};
    const value = settings[key] ?? CORE_DEFAULTS[key];

    new Setting(containerEl)
      .setName(name)
      .setDesc(description)
      .addDropdown((dropdown) => {
        for (const [val, label] of Object.entries(choices)) {
          dropdown.addOption(val, label);
        }
        dropdown.setValue(String(value || "")).onChange(async (newValue) => {
          await this.saveSettings((settings) => {
            settings[key] = newValue;
          });
        });
      });
  }

  /**
   * Render the Detail view settings group: placement dropdown plus
   * placement-dependent width override, auto-close, and split direction
   * controls. Re-renders the whole settings page on placement change so the
   * conditional controls appear or disappear.
   */
  private async renderDetailViewSettings(containerEl: HTMLElement): Promise<void> {
    const data = (await this.plugin.loadData()) || {};
    const settings = data.settings || {};
    // Resolve via resolveDetailViewOptions so invalid persisted values (from
    // manual edits or older plugin versions) fall back to the default and
    // the dropdown/conditional rendering stay consistent.
    const placement = resolveDetailViewOptions(settings).placement;

    // Placement dropdown - drives visibility of other fields in this section.
    new Setting(containerEl)
      .setName("Placement")
      .setDesc(
        "How the task file opens when you select a work item. " +
          "Split opens a new split beside the Work Terminal view (default). " +
          "Tab opens a new tab in the active tab group. " +
          "Navigate replaces the contents of the active editor. " +
          "Disabled does nothing - open files manually via the file explorer or quick switcher.",
      )
      .addDropdown((dropdown) => {
        dropdown.addOption("split", "Split (default)");
        dropdown.addOption("tab", "Tab in active group");
        dropdown.addOption("navigate", "Navigate active leaf");
        dropdown.addOption("disabled", "Disabled");
        dropdown.setValue(placement).onChange(async (newValue) => {
          await this.saveSettings((s) => {
            s["core.detailViewPlacement"] = newValue;
          });
          // Re-render to update visibility of placement-dependent settings
          this.display();
        });
      });

    // Auto-close applies to any placement except "disabled" (where nothing is
    // opened anyway). It's a general behaviour toggle, not split-specific.
    if (placement !== "disabled") {
      this.addCoreToggle(
        containerEl,
        "core.detailViewAutoClose",
        "Auto-close on selection change",
        "Detach the detail leaf when you select a different item, opening a fresh one at the current placement target. When off, the same leaf is reused across selections.",
      );
    }

    // Width override and split direction only apply when placement is "split".
    if (placement === "split") {
      this.addCoreToggle(
        containerEl,
        "core.detailViewWidthOverride",
        "Apply readable line-width override to split",
        "Forces the editor split to the Obsidian readable line width and lets the terminal panel fill the rest. Turn off if you prefer Obsidian's default flex sizing for the split.",
      );
      this.addCoreDropdown(
        containerEl,
        "core.detailViewSplitDirection",
        "Split direction",
        "Orientation of the split created alongside the Work Terminal view. Vertical stacks side-by-side; horizontal stacks top-and-bottom.",
        { vertical: "Vertical (side by side)", horizontal: "Horizontal (top and bottom)" },
      );
    }
  }

  private async addCardFlagRulesButton(containerEl: HTMLElement): Promise<void> {
    const data = (await this.plugin.loadData()) || {};
    const settings = data.settings || {};
    const customJson = (settings["adapter.customCardFlags"] as string) || "[]";
    const customRules = parseCardFlagRulesJson(customJson);
    const defaultRules = this.adapter.config.cardFlags || [];

    const ruleCount = customRules.length;
    const description =
      ruleCount === 0
        ? "Define custom rules that match frontmatter fields and display visual indicators on task cards."
        : `${ruleCount} custom rule${ruleCount === 1 ? "" : "s"} defined. Click to manage.`;

    new Setting(containerEl)
      .setName("Custom card flag rules")
      .setDesc(description)
      .addButton((btn) =>
        btn
          .setButtonText("Manage Rules")
          .setCta()
          .onClick(() => {
            new CardFlagManagerModal(
              this.app,
              customRules,
              defaultRules,
              async (updatedRules: CardFlagRule[]) => {
                const json = serializeCardFlagRules(updatedRules);
                await this.saveSettings((settings) => {
                  settings["adapter.customCardFlags"] = json;
                });
                // Refresh the settings display to update the rule count
                this.display();
              },
            ).open();
          }),
      );
  }

  /**
   * Render column display order controls: a list of columns with up/down
   * buttons, pin toggles for dynamic columns, and a reset-to-default action.
   */
  private async renderColumnOrderControls(containerEl: HTMLElement): Promise<void> {
    // Resolve effective column order (current config reflects it)
    const columns = this.adapter.config.columns;

    // Load pinned custom states
    const data = (await this.plugin.loadData()) || {};
    const settings = data.settings || {};
    const pinnedJson = (settings["adapter.pinnedCustomStates"] as string) || "[]";
    let pinnedStates: string[] = [];
    try {
      const parsed = JSON.parse(pinnedJson);
      if (Array.isArray(parsed)) pinnedStates = parsed;
    } catch {
      /* empty */
    }
    const pinnedSet = new Set(pinnedStates);

    const hasDynamic = columns.some((c) => !c.folderName);
    const desc = new Setting(containerEl)
      .setName("Column display order")
      .setDesc(
        hasDynamic
          ? "Use arrow buttons to reorder kanban board columns. Dynamic columns (from custom frontmatter states) are shown with a star. Use the pin button to keep a dynamic column visible even when it has no tasks. Changes take effect immediately."
          : "Use arrow buttons to reorder kanban board columns. Changes take effect immediately.",
      );

    // Reset button
    desc.addButton((btn) =>
      btn.setButtonText("Reset to default").onClick(async () => {
        await this.saveSettings((settings) => {
          settings["adapter.columnOrder"] = "";
          settings["adapter.pinnedCustomStates"] = "[]";
        });
        this.display();
      }),
    );

    const listEl = containerEl.createDiv({ cls: "wt-column-order-list" });

    for (let i = 0; i < columns.length; i++) {
      const col = columns[i];
      const rowEl = listEl.createDiv({ cls: "wt-column-order-row" });

      // Column label (with dynamic indicator for custom frontmatter states)
      const isDynamic = !col.folderName;
      const isPinned = isDynamic && pinnedSet.has(col.id);
      const labelText = isDynamic ? `${col.label} *${isPinned ? " (pinned)" : ""}` : col.label;
      rowEl.createSpan({ text: labelText, cls: "wt-column-order-label" });

      // Pin toggle for dynamic columns
      if (isDynamic) {
        const pinBtn = rowEl.createEl("button", {
          text: isPinned ? "Unpin" : "Pin",
          cls: "wt-column-order-btn wt-column-pin-btn",
          attr: { "aria-label": isPinned ? `Unpin ${col.label}` : `Pin ${col.label}` },
        });
        pinBtn.addEventListener("click", async () => {
          const currentPinned = new Set(pinnedStates);
          if (isPinned) {
            currentPinned.delete(col.id);
          } else {
            currentPinned.add(col.id);
          }
          await this.saveSettings((settings) => {
            settings["adapter.pinnedCustomStates"] = JSON.stringify([...currentPinned]);
          });
          this.display();
        });
      }

      // Up button
      const upBtn = rowEl.createEl("button", {
        text: "\u2191",
        cls: "wt-column-order-btn",
        attr: { "aria-label": `Move ${col.label} up` },
      });
      if (i === 0) upBtn.setAttribute("disabled", "true");
      upBtn.addEventListener("click", async () => {
        if (i === 0) return;
        const ids = columns.map((c) => c.id);
        [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
        await this.saveSettings((settings) => {
          settings["adapter.columnOrder"] = JSON.stringify(ids);
        });
        this.display();
      });

      // Down button
      const downBtn = rowEl.createEl("button", {
        text: "\u2193",
        cls: "wt-column-order-btn",
        attr: { "aria-label": `Move ${col.label} down` },
      });
      if (i === columns.length - 1) downBtn.setAttribute("disabled", "true");
      downBtn.addEventListener("click", async () => {
        if (i === columns.length - 1) return;
        const ids = columns.map((c) => c.id);
        [ids[i], ids[i + 1]] = [ids[i + 1], ids[i]];
        await this.saveSettings((settings) => {
          settings["adapter.columnOrder"] = JSON.stringify(ids);
        });
        this.display();
      });
    }

    // "Create custom state" input
    this.renderCreateCustomStateInput(containerEl, pinnedStates);
  }

  /**
   * Render an input for creating a new custom state column.
   * Newly created states are pinned by default so they remain visible.
   */
  private renderCreateCustomStateInput(
    containerEl: HTMLElement,
    currentPinnedStates: string[],
  ): void {
    const existingIds = new Set(this.adapter.config.columns.map((c) => c.id));

    new Setting(containerEl)
      .setName("Create custom state")
      .setDesc(
        "Add a new custom state column. The column will be pinned by default so it stays visible even with no tasks. Use lowercase identifiers with hyphens (e.g. review, blocked-upstream).",
      )
      .addText((text) => {
        text.inputEl.placeholder = "e.g. review";
        text.inputEl.addEventListener("keydown", async (e: KeyboardEvent) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          const value = text.inputEl.value.trim().toLowerCase().replace(/\s+/g, "-");
          if (!value) return;
          if (existingIds.has(value)) {
            new Notice(`Column "${value}" already exists`);
            return;
          }

          // Add to column order and pin it
          const columns = this.adapter.config.columns;
          const ids = columns.map((c) => c.id);
          ids.push(value);
          const newPinned = [...currentPinnedStates, value];

          await this.saveSettings((settings) => {
            settings["adapter.columnOrder"] = JSON.stringify(ids);
            settings["adapter.pinnedCustomStates"] = JSON.stringify(newPinned);
          });
          new Notice(`Custom state "${value}" created and pinned`);
          this.display();
        });
      });
  }

  /**
   * Render creation column selection: checkboxes for each column, with
   * the ability to toggle which columns appear in the new item prompt
   * and reorder them.
   */
  private renderCreationColumnControls(containerEl: HTMLElement): void {
    // All available columns from the adapter
    const allColumns = this.adapter.config.columns;
    // Current creation columns
    const creationColumns = this.adapter.config.creationColumns;
    const creationIds = new Set(creationColumns.map((c) => c.id));
    const defaultId = creationColumns.find((c) => c.default)?.id || creationColumns[0]?.id;

    const desc = new Setting(containerEl)
      .setName("New item column selector")
      .setDesc(
        `Choose which columns appear in the "${this.adapter.config.itemName}" creation prompt. The first checked column is the default. Uncheck to hide a column from the creation dropdown.`,
      );

    desc.addButton((btn) =>
      btn.setButtonText("Reset to default").onClick(async () => {
        await this.saveSettings((settings) => {
          settings["adapter.creationColumnIds"] = "";
        });
        this.display();
      }),
    );

    const listEl = containerEl.createDiv({ cls: "wt-creation-column-list" });

    // Show creation columns first (in order), then unchecked columns
    const orderedColumns = [
      ...creationColumns.map((cc) => allColumns.find((ac) => ac.id === cc.id)!).filter(Boolean),
      ...allColumns.filter((ac) => !creationIds.has(ac.id)),
    ];

    for (let i = 0; i < orderedColumns.length; i++) {
      const col = orderedColumns[i];
      const isChecked = creationIds.has(col.id);
      const isDefault = col.id === defaultId;

      const rowEl = listEl.createDiv({ cls: "wt-creation-column-row" });

      // Checkbox
      const checkbox = rowEl.createEl("input", {
        attr: {
          type: "checkbox",
          ...(isChecked ? { checked: "" } : {}),
        },
      });
      checkbox.checked = isChecked;

      // Label with default indicator
      const labelText = isDefault ? `${col.label} (default)` : col.label;
      rowEl.createSpan({ text: labelText, cls: "wt-creation-column-label" });

      // Up button (only for checked items)
      if (isChecked) {
        const creationIdx = creationColumns.findIndex((c) => c.id === col.id);
        const upBtn = rowEl.createEl("button", {
          text: "\u2191",
          cls: "wt-column-order-btn",
          attr: { "aria-label": `Move ${col.label} up` },
        });
        if (creationIdx === 0) upBtn.setAttribute("disabled", "true");
        upBtn.addEventListener("click", async () => {
          if (creationIdx === 0) return;
          const ids = creationColumns.map((c) => c.id);
          [ids[creationIdx - 1], ids[creationIdx]] = [ids[creationIdx], ids[creationIdx - 1]];
          await this.saveSettings((settings) => {
            settings["adapter.creationColumnIds"] = JSON.stringify(ids);
          });
          this.display();
        });

        const downBtn = rowEl.createEl("button", {
          text: "\u2193",
          cls: "wt-column-order-btn",
          attr: { "aria-label": `Move ${col.label} down` },
        });
        if (creationIdx === creationColumns.length - 1) downBtn.setAttribute("disabled", "true");
        downBtn.addEventListener("click", async () => {
          if (creationIdx === creationColumns.length - 1) return;
          const ids = creationColumns.map((c) => c.id);
          [ids[creationIdx], ids[creationIdx + 1]] = [ids[creationIdx + 1], ids[creationIdx]];
          await this.saveSettings((settings) => {
            settings["adapter.creationColumnIds"] = JSON.stringify(ids);
          });
          this.display();
        });
      }

      // Toggle checkbox handler
      checkbox.addEventListener("change", async () => {
        const currentIds = creationColumns.map((c) => c.id);
        if (checkbox.checked) {
          // Add this column at the end
          currentIds.push(col.id);
        } else {
          // Remove this column (must keep at least one)
          const idx = currentIds.indexOf(col.id);
          if (idx >= 0 && currentIds.length > 1) {
            currentIds.splice(idx, 1);
          } else if (currentIds.length <= 1) {
            checkbox.checked = true; // Prevent unchecking the last one
            new Notice("At least one creation column must remain selected");
            return;
          }
        }
        await this.saveSettings((settings) => {
          settings["adapter.creationColumnIds"] = JSON.stringify(currentIds);
        });
        this.display();
      });
    }
  }

  private async addAdapterSetting(containerEl: HTMLElement, field: SettingField): Promise<void> {
    const key = `adapter.${field.key}`;
    const data = (await this.plugin.loadData()) || {};
    const settings = data.settings || {};
    const defaultVal = this.adapter.config.defaultSettings[field.key] ?? field.default;
    const value = settings[key] ?? defaultVal;

    const setting = new Setting(containerEl).setName(field.name).setDesc(field.description);

    if (field.type === "text") {
      setting.addText((text) =>
        text.setValue(String(value)).onChange(async (newValue) => {
          await this.saveSettings((settings) => {
            settings[key] = newValue;
          });
        }),
      );
    } else if (field.type === "toggle") {
      setting.addToggle((toggle) =>
        toggle.setValue(!!value).onChange(async (newValue) => {
          await this.saveSettings((settings) => {
            settings[key] = newValue;
          });
        }),
      );
    } else if (field.type === "dropdown") {
      let choices: Record<string, string>;
      if (field.choices === "profiles") {
        // Dynamically populate from agent profiles
        choices = { "": "Default (core settings)" };
        for (const profile of this.profileManager.getProfiles()) {
          choices[profile.id] = profile.name;
        }
      } else {
        choices = (field.choices as Record<string, string>) || {};
      }
      setting.addDropdown((dropdown) => {
        for (const [val, label] of Object.entries(choices)) {
          dropdown.addOption(val, label);
        }
        dropdown.setValue(String(value || "")).onChange(async (newValue) => {
          await this.saveSettings((settings) => {
            settings[key] = newValue;
          });
        });
      });
    }
  }
}

/**
 * Load a specific setting value from plugin data.
 * Used by framework components to read settings at runtime.
 */
export async function loadSetting(plugin: Plugin, key: string): Promise<any> {
  const data = (await plugin.loadData()) || {};
  const settings = data.settings || {};
  if (key in settings) return settings[key];
  if (key in CORE_DEFAULTS) return CORE_DEFAULTS[key as keyof CoreSettings];
  return undefined;
}

/**
 * Load all settings as a flat object (merged defaults + saved).
 */
export async function loadAllSettings(
  plugin: Plugin,
  adapter: AdapterBundle,
): Promise<Record<string, any>> {
  const data = (await plugin.loadData()) || {};
  const saved = data.settings || {};
  const result: Record<string, any> = { ...CORE_DEFAULTS };

  // Merge adapter defaults
  for (const field of adapter.config.settingsSchema) {
    const key = `adapter.${field.key}`;
    result[key] = adapter.config.defaultSettings[field.key] ?? field.default;
  }

  // Override with saved values
  for (const [k, v] of Object.entries(saved)) {
    result[k] = v;
  }

  return result;
}
