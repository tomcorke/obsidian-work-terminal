/**
 * WorkTerminalSettingsTab - single settings UI combining core framework
 * settings with adapter-provided settings via namespaced keys.
 *
 * Core settings: core.claudeCommand, core.claudeExtraArgs (default args), core.additionalAgentContext (ctx template),
 *                core.defaultShell, core.defaultTerminalCwd
 * Adapter settings: adapter.* (from adapter.config.settingsSchema)
 */
import { App, PluginSettingTab, Setting } from "obsidian";
import type { Plugin } from "obsidian";
import type { AdapterBundle, SettingField } from "../core/interfaces";

interface CoreSettings {
  "core.claudeCommand": string;
  "core.claudeExtraArgs": string;
  "core.additionalAgentContext": string;
  "core.defaultShell": string;
  "core.defaultTerminalCwd": string;
}

const CORE_DEFAULTS: CoreSettings = {
  "core.claudeCommand": "claude",
  "core.claudeExtraArgs": "",
  "core.additionalAgentContext": "",
  "core.defaultShell": process.env.SHELL || "/bin/zsh",
  "core.defaultTerminalCwd": "~",
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

    this.addCoreSetting(containerEl, "core.claudeCommand", "Claude command", "Path or name of the Claude CLI binary");
    this.addCoreTextArea(containerEl, "core.claudeExtraArgs", "Default Claude arguments", "Arguments passed to every Claude session (space-separated). Applied to both + Claude and + Claude (ctx).");
    this.addCoreTextArea(containerEl, "core.additionalAgentContext", "Claude (ctx) prompt template", "Template for '+ Claude (ctx)' button. Placeholders: $title, $state, $filePath, $id. Button hidden when empty.");
    this.addCoreSetting(containerEl, "core.defaultShell", "Default shell", "Shell used for new terminal tabs");
    this.addCoreSetting(containerEl, "core.defaultTerminalCwd", "Default terminal CWD", "Working directory for new terminals (supports ~)");

    // Adapter settings section
    const schema = this.adapter.config.settingsSchema;
    if (schema.length > 0) {
      containerEl.createEl("h2", { text: "Adapter" });
      for (const field of schema) {
        this.addAdapterSetting(containerEl, field);
      }
    }
  }

  private async addCoreSetting(containerEl: HTMLElement, key: keyof CoreSettings, name: string, description: string): Promise<void> {
    const data = (await this.plugin.loadData()) || {};
    const settings = data.settings || {};
    const value = settings[key] ?? CORE_DEFAULTS[key];

    new Setting(containerEl)
      .setName(name)
      .setDesc(description)
      .addText((text) =>
        text
          .setValue(String(value))
          .onChange(async (newValue) => {
            const d = (await this.plugin.loadData()) || {};
            if (!d.settings) d.settings = {};
            d.settings[key] = newValue;
            await this.plugin.saveData(d);
          })
      );
  }

  private async addCoreTextArea(containerEl: HTMLElement, key: keyof CoreSettings, name: string, description: string): Promise<void> {
    const data = (await this.plugin.loadData()) || {};
    const settings = data.settings || {};
    const value = settings[key] ?? CORE_DEFAULTS[key];

    const setting = new Setting(containerEl)
      .setName(name)
      .setDesc(description)
      .addTextArea((ta) => {
        ta
          .setValue(String(value))
          .onChange(async (newValue) => {
            const d = (await this.plugin.loadData()) || {};
            if (!d.settings) d.settings = {};
            d.settings[key] = newValue;
            await this.plugin.saveData(d);
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

    const setting = new Setting(containerEl)
      .setName(field.name)
      .setDesc(field.description);

    if (field.type === "text") {
      setting.addText((text) =>
        text
          .setValue(String(value))
          .onChange(async (newValue) => {
            const d = (await this.plugin.loadData()) || {};
            if (!d.settings) d.settings = {};
            d.settings[key] = newValue;
            await this.plugin.saveData(d);
          })
      );
    } else if (field.type === "toggle") {
      setting.addToggle((toggle) =>
        toggle
          .setValue(!!value)
          .onChange(async (newValue) => {
            const d = (await this.plugin.loadData()) || {};
            if (!d.settings) d.settings = {};
            d.settings[key] = newValue;
            await this.plugin.saveData(d);
          })
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
export async function loadAllSettings(plugin: Plugin, adapter: AdapterBundle): Promise<Record<string, any>> {
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
