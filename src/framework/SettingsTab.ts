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
import type { AdapterBundle, CardFlagRule, SettingField } from "../core/interfaces";
import { checkHookStatus, installHooks, removeHooks } from "../core/claude/ClaudeHookManager";
import { mergeAndSavePluginData } from "../core/PluginDataStore";
import { resetGuidedTourStatus } from "./GuidedTour";
import { expandTilde } from "../core/utils";
import type { AgentProfileManager } from "../core/agents/AgentProfileManager";
import { AgentProfileManagerModal } from "./AgentProfileManagerModal";
import { CardFlagManagerModal } from "./CardFlagManagerModal";
import { parseCardFlagRulesJson, serializeCardFlagRules } from "../core/cardFlags";

interface CoreSettings {
  "core.claudeCommand": string;
  "core.claudeExtraArgs": string;
  "core.copilotCommand": string;
  "core.copilotExtraArgs": string;
  "core.copilotSessionLogDir": string;
  "core.strandsCommand": string;
  "core.strandsExtraArgs": string;
  "core.additionalAgentContext": string;
  "core.defaultShell": string;
  "core.defaultTerminalCwd": string;
  "core.exposeDebugApi": boolean;
  "core.keepSessionsAlive": boolean;
  "core.acceptNoResumeHooks": boolean;
}

export const SETTINGS_CHANGED_EVENT = "work-terminal:settings-changed";

const CORE_DEFAULTS: CoreSettings = {
  "core.claudeCommand": "claude",
  "core.claudeExtraArgs": "",
  "core.copilotCommand": "copilot",
  "core.copilotExtraArgs": "",
  "core.copilotSessionLogDir": "~/.copilot/logs",
  "core.strandsCommand": "strands",
  "core.strandsExtraArgs": "",
  "core.additionalAgentContext": "",
  "core.defaultShell": process.env.SHELL || "/bin/zsh",
  "core.defaultTerminalCwd": "~",
  "core.exposeDebugApi": false,
  "core.keepSessionsAlive": true,
  "core.acceptNoResumeHooks": false,
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
    this.addCoreSetting(
      containerEl,
      "core.copilotSessionLogDir",
      "Copilot session log directory",
      "Directory where Copilot CLI writes session logs. Used for deferred session ID detection. Supports ~ expansion.",
    );
    this.addCoreToggle(
      containerEl,
      "core.keepSessionsAlive",
      "Keep sessions alive when tab is closed",
      "Stash terminal sessions to memory instead of killing them when the Work Terminal tab is closed. Reopening the tab restores sessions with full PTY state. Sessions are also persisted to disk as a fallback.",
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

    // Session Resume Tracking section
    containerEl.createEl("h2", { text: "Claude /resume hooks" });
    containerEl.createEl("p", {
      text: "These hooks are only for Claude CLI. Copilot restart resume uses Copilot's native --resume[=sessionId] support and does not require hooks. If you switch sessions manually inside Copilot, Work Terminal keeps tracking the original session ID.",
      cls: "wt-custom-spawn-help",
    });
    this.renderHookStatus(containerEl);

    // Adapter settings section
    const schema = this.adapter.config.settingsSchema;
    if (schema.length > 0) {
      containerEl.createEl("h2", { text: "Adapter" });
      for (const field of schema) {
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
    window.dispatchEvent(
      new CustomEvent(SETTINGS_CHANGED_EVENT, {
        detail: await loadAllSettings(this.plugin, this.adapter),
      }),
    );
  }

  private async renderHookStatus(containerEl: HTMLElement): Promise<void> {
    const data = (await this.plugin.loadData()) || {};
    const settings = data.settings || {};
    const cwd = expandTilde(
      settings["core.defaultTerminalCwd"] || CORE_DEFAULTS["core.defaultTerminalCwd"],
    );
    const status = checkHookStatus(cwd);

    // Status indicator
    const statusContainer = containerEl.createDiv({ cls: "wt-hook-status" });

    const badgeEl = statusContainer.createSpan({ cls: "wt-hook-status-badge" });
    if (status.scriptExists && status.hooksConfigured) {
      badgeEl.addClass("wt-hook-status-ok");
      badgeEl.textContent = "Configured";
    } else if (status.scriptExists || status.hooksConfigured) {
      badgeEl.addClass("wt-hook-status-partial");
      badgeEl.textContent = "Partial";
    } else {
      badgeEl.addClass("wt-hook-status-missing");
      badgeEl.textContent = "Not configured";
    }

    // Install button (shown when not fully configured)
    if (!(status.scriptExists && status.hooksConfigured)) {
      new Setting(containerEl)
        .setName("Install hooks")
        .setDesc(
          "Install the Claude session-change hook script and add entries to .claude/settings.local.json",
        )
        .addButton((btn) =>
          btn
            .setButtonText("Install")
            .setCta()
            .onClick(async () => {
              await installHooks(cwd);
              this.display(); // refresh
            }),
        );
    }

    // Remove button (shown when any hooks are installed)
    if (status.scriptExists || status.hooksConfigured) {
      new Setting(containerEl)
        .setName("Remove hooks")
        .setDesc("Remove Claude hook entries from settings and delete the hook script")
        .addButton((btn) =>
          btn
            .setButtonText("Remove")
            .setWarning()
            .onClick(async () => {
              await removeHooks(cwd);
              this.display(); // refresh
            }),
        );
    }

    // Accept reduced functionality checkbox
    const acceptValue =
      settings["core.acceptNoResumeHooks"] ?? CORE_DEFAULTS["core.acceptNoResumeHooks"];
    new Setting(containerEl)
      .setName("I accept reduced functionality")
      .setDesc(
        "Check this to dismiss the warning banner without installing Claude hooks. Claude session tracking after /resume will not work.",
      )
      .addToggle((toggle) =>
        toggle.setValue(!!acceptValue).onChange(async (newValue) => {
          await this.saveSettings((settings) => {
            settings["core.acceptNoResumeHooks"] = newValue;
          });
        }),
      );
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
   * buttons and a reset-to-default action.
   */
  private async renderColumnOrderControls(containerEl: HTMLElement): Promise<void> {
    const data = (await this.plugin.loadData()) || {};
    const settings = data.settings || {};
    const orderJson = (settings["adapter.columnOrder"] as string) || "";

    // Resolve effective column order (current config reflects it)
    const columns = this.adapter.config.columns;

    const desc = new Setting(containerEl)
      .setName("Column display order")
      .setDesc(
        "Drag or use arrow buttons to reorder kanban board columns. Changes take effect immediately.",
      );

    // Reset button
    desc.addButton((btn) =>
      btn.setButtonText("Reset to default").onClick(async () => {
        await this.saveSettings((settings) => {
          settings["adapter.columnOrder"] = "";
        });
        this.display();
      }),
    );

    const listEl = containerEl.createDiv({ cls: "wt-column-order-list" });

    for (let i = 0; i < columns.length; i++) {
      const col = columns[i];
      const rowEl = listEl.createDiv({ cls: "wt-column-order-row" });

      // Column label
      rowEl.createSpan({ text: col.label, cls: "wt-column-order-label" });

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
  }

  /**
   * Render creation column selection: checkboxes for each column, with
   * the ability to toggle which columns appear in the new item prompt
   * and reorder them.
   */
  private async renderCreationColumnControls(containerEl: HTMLElement): Promise<void> {
    const data = (await this.plugin.loadData()) || {};
    const settings = data.settings || {};

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
