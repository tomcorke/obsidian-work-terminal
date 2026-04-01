/**
 * WorkTerminalSettingsTab - single settings UI combining core framework
 * settings with adapter-provided settings via namespaced keys.
 *
 * Core settings: core.claudeCommand/core.copilotCommand/core.strandsCommand, their default args,
 *                core.additionalAgentContext (extra ctx template),
 *                core.defaultShell, core.defaultTerminalCwd
 * Adapter settings: adapter.* (from adapter.config.settingsSchema)
 */
import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type { Plugin } from "obsidian";
import type { AdapterBundle, SettingField } from "../core/interfaces";
import {
  isAbsoluteCommandPath,
  isPathLikeCommand,
  resolveCommandInfo,
  splitConfiguredCommand,
} from "../core/agents/AgentLauncher";
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
  "core.strandsCommand": string;
  "core.strandsExtraArgs": string;
  "core.additionalAgentContext": string;
  "core.defaultShell": string;
  "core.defaultTerminalCwd": string;
  "core.exposeDebugApi": boolean;
  "core.keepSessionsAlive": boolean;
  "core.acceptNoResumeHooks": boolean;
}

type BinaryCommandKey = "core.claudeCommand" | "core.copilotCommand" | "core.strandsCommand";

type BinaryValidationState = {
  found: boolean;
  resolved: string;
  message: string;
};

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
  "core.acceptNoResumeHooks": false,
};

export class WorkTerminalSettingsTab extends PluginSettingTab {
  private adapter: AdapterBundle;
  private plugin: Plugin;
  private profileManager: AgentProfileManager;

  private static readonly BINARY_COMMAND_KEYS: BinaryCommandKey[] = [
    "core.claudeCommand",
    "core.copilotCommand",
    "core.strandsCommand",
  ];

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
            new AgentProfileManagerModal(this.app, this.profileManager).open();
          }),
      );

    // Core settings section
    containerEl.createEl("h2", { text: "Core" });

    this.addCoreBinarySetting(
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
      "core.claudeExtraArgs",
    );
    this.addCoreBinarySetting(
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
    this.addCoreBinarySetting(
      containerEl,
      "core.strandsCommand",
      "Strands command",
      'Path or name of the AWS Strands agent entry-point. The Strands SDK has no universal binary - set this to your project\'s runner script or wrapper (e.g. ~/my-project/run-agent.sh or uv run python agent.py). Tilde (~) is expanded. Inline runner arguments are supported here for wrapper commands like "uv run python agent.py". Use "Default Strands arguments" below for extra arguments that should be appended to every Strands launch.',
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
      "Additional context template",
      "Optional template used as the initial prompt for Claude (ctx), and appended after the adapter prompt for contextual custom Copilot and Strands sessions. The Claude (ctx) button is hidden when this is empty. Placeholders: $title, $state, $filePath, $id.",
      "core.additionalAgentContext",
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
          if (key === "core.defaultTerminalCwd") {
            this.refreshBinaryValidationState();
          }
          await this.saveSettings((settings) => {
            settings[key] = newValue;
          });
        });
      });
    if (tourId) {
      setting.settingEl.setAttribute("data-wt-tour", tourId);
    }
    if (key === "core.defaultTerminalCwd") {
      this.refreshBinaryValidationState();
    }
  }

  private async addCoreBinarySetting(
    containerEl: HTMLElement,
    key: BinaryCommandKey,
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
          this.refreshBinaryValidationState();
          await this.saveSettings((currentSettings) => {
            currentSettings[key] = newValue;
          });
        });
      });

    if (tourId) {
      setting.settingEl.setAttribute("data-wt-tour", tourId);
    }

    const validationEl = setting.descEl.createDiv({
      cls: "wt-command-validation",
    });
    validationEl.dataset.commandValidationKey = key;
    validationEl.createSpan({ cls: "wt-command-status-badge" });
    validationEl.createDiv({ cls: "wt-command-validation-note" });
    this.updateBinaryValidationStateForKey(key);
  }

  private async addCoreTextArea(
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

  private refreshBinaryValidationState(): void {
    for (const key of WorkTerminalSettingsTab.BINARY_COMMAND_KEYS) {
      this.updateBinaryValidationStateForKey(key);
    }
  }

  private updateBinaryValidationStateForKey(key: BinaryCommandKey): void {
    const container = this.containerEl.querySelector<HTMLElement>(
      `[data-command-validation-key="${key}"]`,
    );
    if (!container) return;
    const badgeEl = container.querySelector<HTMLElement>(".wt-command-status-badge");
    const noteEl = container.querySelector<HTMLElement>(".wt-command-validation-note");
    if (!badgeEl || !noteEl) return;
    const command = this.getCoreInputValue(key);
    const cwd = this.getCoreInputValue("core.defaultTerminalCwd");
    const state = this.resolveBinaryValidationState(key, command, cwd);

    badgeEl.textContent = state.found ? "Found" : "Not found";
    badgeEl.className = "wt-command-status-badge";
    badgeEl.classList.add(state.found ? "wt-command-status-ok" : "wt-command-status-missing");
    noteEl.textContent = state.message;
    noteEl.className = "wt-command-validation-note";
    noteEl.classList.add(
      state.found ? "wt-command-validation-note-found" : "wt-command-validation-note-missing",
    );
  }

  private getCoreInputValue(key: keyof CoreSettings): string {
    const input = this.containerEl.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      `input[data-setting-key="${key}"], textarea[data-setting-key="${key}"]`,
    );
    if (input) {
      return input.value;
    }
    return String(CORE_DEFAULTS[key] ?? "");
  }

  private resolveBinaryValidationState(
    key: BinaryCommandKey,
    command: string,
    cwd: string,
  ): BinaryValidationState {
    const trimmedCommand = String(command ?? "").trim();
    if (!trimmedCommand) {
      return {
        found: false,
        resolved: "",
        message: "Enter a binary name or path to validate it.",
      };
    }
    const normalizedCwd = expandTilde(
      String(cwd ?? "").trim() || CORE_DEFAULTS["core.defaultTerminalCwd"],
    );
    const commandTokens =
      key === "core.strandsCommand" ? splitConfiguredCommand(trimmedCommand) : [trimmedCommand];
    const executableToken = commandTokens[0] ?? trimmedCommand;
    const inlineArgs = key === "core.strandsCommand" ? commandTokens.slice(1).join(" ") : "";
    const resolution = resolveCommandInfo(executableToken, normalizedCwd);
    const locationLabel = isAbsoluteCommandPath(executableToken)
      ? "Using configured path"
      : isPathLikeCommand(executableToken)
        ? `Resolved from ${normalizedCwd}`
        : "Searched PATH";
    const inlineArgsLabel = inlineArgs ? ` Inline args: ${inlineArgs}` : "";
    return {
      found: resolution.found,
      resolved: resolution.resolved,
      message: resolution.found
        ? `${locationLabel}: ${resolution.resolved}${inlineArgsLabel}`
        : `${locationLabel}: ${resolution.resolved || executableToken}${inlineArgsLabel}`,
    };
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
