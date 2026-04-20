/**
 * EnrichmentSettingsDialog - dedicated modal housing the background-enrichment
 * settings group. Extracted from the main SettingsTab so the growing surface
 * (toggle, prompt, retry prompt, agent profile, timeout, plus default-prompt
 * previews) has room to breathe without cluttering the top-level settings page.
 *
 * Settings are persisted through the same `plugin.saveSettings` path as the
 * rest of the adapter fields. The existing `adapter.enrichment*` keys are
 * reused verbatim, so opening the dialog does not change enrichment behaviour
 * for users who never open it.
 *
 * The pattern is kept deliberately generic so sibling dialogs (e.g. a future
 * split-task settings dialog) can mirror the structure without sharing a base
 * class.
 */
import { App, Modal, Setting } from "obsidian";
import type { Plugin } from "obsidian";
import type { AdapterBundle } from "../core/interfaces";
import { mergeAndSavePluginData } from "../core/PluginDataStore";
import type { AgentProfileManager } from "../core/agents/AgentProfileManager";
import {
  DEFAULT_ENRICHMENT_PROMPT,
  DEFAULT_RETRY_ENRICHMENT_PROMPT,
} from "../adapters/task-agent/BackgroundEnrich";
import { describePromptPlaceholder } from "./enrichmentPromptPreview";
import { SETTINGS_CHANGED_EVENT, loadAllSettings } from "./SettingsTab";

export class EnrichmentSettingsDialog extends Modal {
  protected plugin: Plugin;
  protected adapter: AdapterBundle;
  protected profileManager: AgentProfileManager;

  constructor(
    app: App,
    plugin: Plugin,
    adapter: AdapterBundle,
    profileManager: AgentProfileManager,
  ) {
    super(app);
    this.plugin = plugin;
    this.adapter = adapter;
    this.profileManager = profileManager;
  }

  onOpen(): void {
    void this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async render(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("wt-enrichment-dialog");

    contentEl.createEl("h3", { text: "Background enrichment" });
    contentEl.createEl("p", {
      text:
        "Configure how newly created tasks are enriched by a headless agent. " +
        "Leave the prompt fields blank to use the built-in defaults shown below each field.",
      cls: "wt-enrichment-dialog__help",
    });

    const bodyEl = contentEl.createDiv({ cls: "wt-enrichment-dialog__body" });
    await this.renderFields(bodyEl);

    // Close button. Settings persist on change, so no Save button is needed.
    const actions = contentEl.createDiv({ cls: "wt-enrichment-dialog__actions" });
    const closeBtn = actions.createEl("button", { text: "Done" });
    closeBtn.addEventListener("click", () => this.close());
  }

  protected async renderFields(containerEl: HTMLElement): Promise<void> {
    const data = (await this.plugin.loadData()) || {};
    const settings: Record<string, unknown> = data.settings || {};

    this.renderEnabledToggle(containerEl, settings);
    this.renderPromptField(
      containerEl,
      "Enrichment prompt",
      "Prompt sent to the headless agent for background enrichment. Use " +
        "{{FILE_PATH}} as a placeholder for the task file path.",
      "adapter.enrichmentPrompt",
      DEFAULT_ENRICHMENT_PROMPT,
      settings,
    );
    this.renderPromptField(
      containerEl,
      "Retry enrichment prompt",
      "Prompt used when retrying enrichment via the right-click menu. Use " +
        "{{FILE_PATH}} as a placeholder for the task file path.",
      "adapter.retryEnrichmentPrompt",
      DEFAULT_RETRY_ENRICHMENT_PROMPT,
      settings,
    );
    this.renderProfileDropdown(containerEl, settings);
    this.renderTimeoutField(containerEl, settings);
  }

  private renderEnabledToggle(containerEl: HTMLElement, settings: Record<string, unknown>): void {
    const value = settings["adapter.enrichmentEnabled"] !== false;
    new Setting(containerEl)
      .setName("Enable background enrichment")
      .setDesc("Automatically enrich new tasks in the background using a headless agent session.")
      .addToggle((toggle) =>
        toggle.setValue(value).onChange(async (newValue) => {
          await this.saveSettings((s) => {
            s["adapter.enrichmentEnabled"] = newValue;
          });
        }),
      );
  }

  /**
   * Render a prompt textarea with a collapsible "View default prompt"
   * disclosure block beneath. The default prompt is rendered verbatim in a
   * preformatted read-only block so users can read and copy from it.
   */
  private renderPromptField(
    containerEl: HTMLElement,
    name: string,
    description: string,
    key: string,
    defaultPrompt: string,
    settings: Record<string, unknown>,
  ): void {
    const value = (settings[key] as string) || "";
    const placeholder = describePromptPlaceholder(defaultPrompt);

    const setting = new Setting(containerEl).setName(name).setDesc(description);
    setting.settingEl.style.flexWrap = "wrap";
    setting.controlEl.style.width = "100%";
    setting.addTextArea((ta) => {
      ta.setPlaceholder(placeholder);
      ta.setValue(value);
      ta.onChange(async (newValue) => {
        await this.saveSettings((s) => {
          s[key] = newValue;
        });
      });
      ta.inputEl.addClass("wt-enrichment-dialog__prompt-input");
    });

    // Collapsible default prompt disclosure. Users can expand to read the
    // full default text and copy from it if they want to customise.
    const disclosure = containerEl.createEl("details", {
      cls: "wt-enrichment-dialog__default-prompt-toggle",
    });
    disclosure.createEl("summary", { text: "View default prompt" });
    const pre = disclosure.createEl("pre", {
      cls: "wt-enrichment-dialog__default-prompt",
    });
    pre.textContent = defaultPrompt;
  }

  private renderProfileDropdown(containerEl: HTMLElement, settings: Record<string, unknown>): void {
    const value = (settings["adapter.enrichmentProfile"] as string) || "";
    new Setting(containerEl)
      .setName("Enrichment agent profile")
      .setDesc(
        "Agent profile to use for background enrichment. The profile's command, " +
          "arguments, and working directory are used. Select 'Default' to use the " +
          "core Claude command settings.",
      )
      .addDropdown((dropdown) => {
        dropdown.addOption("", "Default (core settings)");
        for (const profile of this.profileManager.getProfiles()) {
          dropdown.addOption(profile.id, profile.name);
        }
        dropdown.setValue(value).onChange(async (newValue) => {
          await this.saveSettings((s) => {
            s["adapter.enrichmentProfile"] = newValue;
          });
        });
      });
  }

  private renderTimeoutField(containerEl: HTMLElement, settings: Record<string, unknown>): void {
    const value = (settings["adapter.enrichmentTimeout"] as string) || "";
    new Setting(containerEl)
      .setName("Enrichment timeout (seconds)")
      .setDesc(
        "Maximum time in seconds for background enrichment before it is killed. " +
          "Leave empty for default (300s / 5 min).",
      )
      .addText((text) => {
        text.inputEl.placeholder = "300";
        text.setValue(value).onChange(async (newValue) => {
          await this.saveSettings((s) => {
            s["adapter.enrichmentTimeout"] = newValue;
          });
        });
      });
  }

  private async saveSettings(update: (settings: Record<string, unknown>) => void): Promise<void> {
    await mergeAndSavePluginData(this.plugin, async (data) => {
      if (!data.settings) data.settings = {};
      update(data.settings);
    });
    const allSettings = await loadAllSettings(this.plugin, this.adapter);
    this.adapter.onSettingsChanged?.(allSettings);
    window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT, { detail: allSettings }));
  }
}
