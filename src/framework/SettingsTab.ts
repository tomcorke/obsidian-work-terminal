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
import type { AdapterBundle, SettingField } from "../core/interfaces";
import { checkHookStatus, installHooks, removeHooks } from "../core/claude/ClaudeHookManager";
import { mergeAndSavePluginData } from "../core/PluginDataStore";
import { resetGuidedTourStatus } from "./GuidedTour";
import { expandTilde } from "../core/utils";
import type { AgentProfileManager } from "../core/agents/AgentProfileManager";
import { AgentProfileManagerModal } from "./AgentProfileManagerModal";

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
