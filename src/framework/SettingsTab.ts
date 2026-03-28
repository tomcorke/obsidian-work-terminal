/**
 * WorkTerminalSettingsTab - single settings UI combining core framework
 * settings with adapter-provided settings via namespaced keys.
 *
 * Core settings: core.claudeCommand/core.copilotCommand/core.strandsCommand, their default args,
 *                core.additionalAgentContext (ctx template),
 *                core.defaultShell, core.defaultTerminalCwd
 * Adapter settings: adapter.* (from adapter.config.settingsSchema)
 */
import { App, PluginSettingTab, Setting } from "obsidian";
import type { Plugin } from "obsidian";
import type { AdapterBundle, SettingField } from "../core/interfaces";
import { checkHookStatus, installHooks, removeHooks } from "../core/claude/ClaudeHookManager";
import { expandTilde } from "../core/utils";

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
  "core.acceptNoResumeHooks": boolean;
}

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
  "core.acceptNoResumeHooks": false,
};

export class WorkTerminalSettingsTab extends PluginSettingTab {
  private adapter: AdapterBundle;
  private plugin: Plugin;

  constructor(app: App, plugin: Plugin, adapter: AdapterBundle) {
    super(app, plugin);
    this.plugin = plugin;
    this.adapter = adapter;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // Core settings section
    containerEl.createEl("h2", { text: "Core" });

    this.addCoreSetting(
      containerEl,
      "core.claudeCommand",
      "Claude command",
      "Path or name of the Claude CLI binary",
    );
    this.addCoreTextArea(
      containerEl,
      "core.claudeExtraArgs",
      "Default Claude arguments",
      "Arguments passed to every Claude session (space-separated). Applied to both + Claude and + Claude (ctx).",
    );
    this.addCoreSetting(
      containerEl,
      "core.copilotCommand",
      "Copilot command",
      "Path or name of the GitHub Copilot CLI binary",
    );
    this.addCoreTextArea(
      containerEl,
      "core.copilotExtraArgs",
      "Default Copilot arguments",
      "Arguments passed to Copilot sessions launched from the custom session spawner.",
    );
    this.addCoreSetting(
      containerEl,
      "core.strandsCommand",
      "Strands command",
      "Path or name of the AWS Strands agent entry-point. The Strands SDK has no universal binary - set this to your project's runner script or wrapper (e.g. ~/my-project/run-agent.sh or uv run python agent.py). Tilde (~) is expanded. Do not include extra arguments here; use \"Default Strands arguments\" below.",
    );
    this.addCoreTextArea(
      containerEl,
      "core.strandsExtraArgs",
      "Default Strands arguments",
      "Arguments passed to Strands sessions launched from the custom session spawner (space-separated).",
    );
    this.addCoreTextArea(
      containerEl,
      "core.additionalAgentContext",
      "Context prompt template",
      "Template for contextual Claude, Copilot, and Strands sessions. Placeholders: $title, $state, $filePath, $id. When empty, contextual launches show a notice instead of spawning.",
    );
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

    // Session Resume Tracking section
    containerEl.createEl("h2", { text: "Session Resume Tracking" });
    this.renderHookStatus(containerEl);

    // Adapter settings section
    const schema = this.adapter.config.settingsSchema;
    if (schema.length > 0) {
      containerEl.createEl("h2", { text: "Adapter" });
      for (const field of schema) {
        this.addAdapterSetting(containerEl, field);
      }
    }
  }

  private async saveSettings(update: (settings: Record<string, unknown>) => void): Promise<void> {
    const data = (await this.plugin.loadData()) || {};
    if (!data.settings) data.settings = {};
    update(data.settings);
    await this.plugin.saveData(data);
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
          "Install the session-change hook script and add entries to .claude/settings.local.json",
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
        .setDesc("Remove hook entries from settings and delete the hook script")
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
        "Check this to dismiss the warning banner without installing hooks. Session tracking after /resume will not work.",
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
  ): Promise<void> {
    const data = (await this.plugin.loadData()) || {};
    const settings = data.settings || {};
    const value = settings[key] ?? CORE_DEFAULTS[key];

    new Setting(containerEl)
      .setName(name)
      .setDesc(description)
      .addText((text) =>
        text.setValue(String(value)).onChange(async (newValue) => {
          await this.saveSettings((settings) => {
            settings[key] = newValue;
          });
        }),
      );
  }

  private async addCoreTextArea(
    containerEl: HTMLElement,
    key: keyof CoreSettings,
    name: string,
    description: string,
  ): Promise<void> {
    const data = (await this.plugin.loadData()) || {};
    const settings = data.settings || {};
    const value = settings[key] ?? CORE_DEFAULTS[key];

    const setting = new Setting(containerEl)
      .setName(name)
      .setDesc(description)
      .addTextArea((ta) => {
        ta.setValue(String(value)).onChange(async (newValue) => {
          await this.saveSettings((settings) => {
            settings[key] = newValue;
          });
        });
        ta.inputEl.style.width = "100%";
        ta.inputEl.style.minHeight = "80px";
      });
    // Let the textarea span the full width below the label
    setting.settingEl.style.flexWrap = "wrap";
    setting.controlEl.style.width = "100%";
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
