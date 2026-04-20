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
import {
  describePromptPlaceholder,
  resolvePromptPreview,
  DEFAULT_PREVIEW_VARS,
} from "./enrichmentPromptPreview";
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
        "$filePath as a placeholder for the task file path.",
      "adapter.enrichmentPrompt",
      DEFAULT_ENRICHMENT_PROMPT,
      settings,
    );
    this.renderPromptField(
      containerEl,
      "Retry enrichment prompt",
      "Prompt used when retrying enrichment via the right-click menu. Use " +
        "$filePath as a placeholder for the task file path.",
      "adapter.retryEnrichmentPrompt",
      DEFAULT_RETRY_ENRICHMENT_PROMPT,
      settings,
    );
    this.renderProfileDropdown(containerEl, settings);
    this.renderRetryProfileDropdown(containerEl, settings);
    this.renderTimeoutField(containerEl, settings);
    this.renderPreviewPanel(containerEl, settings);
  }

  /**
   * Render a "Preview resolved prompt" section that substitutes `$filePath`
   * (and any other known placeholder) using a fixed example path. Gives users
   * a concrete view of what the agent will receive without actually creating
   * a task. The substitution is synchronous and purely string-based; we do
   * not load a real task or reach into BackgroundEnrich internals.
   */
  private renderPreviewPanel(containerEl: HTMLElement, settings: Record<string, unknown>): void {
    const section = containerEl.createDiv({ cls: "wt-enrichment-dialog__preview" });
    section.createEl("h4", { text: "Preview resolved prompt" });
    section.createEl("p", {
      text:
        "Show the selected prompt with placeholders substituted using the example " +
        `path ${DEFAULT_PREVIEW_VARS.filePath}. Useful for sanity-checking a customised prompt ` +
        "before creating a real task.",
      cls: "wt-enrichment-dialog__help",
    });

    const actions = section.createDiv({ cls: "wt-enrichment-dialog__preview-actions" });
    const select = actions.createEl("select", {
      cls: "wt-enrichment-dialog__preview-select",
    });
    const opts: Array<{ value: "prompt" | "retry"; label: string }> = [
      { value: "prompt", label: "Enrichment prompt" },
      { value: "retry", label: "Retry enrichment prompt" },
    ];
    for (const opt of opts) {
      const el = select.createEl("option", { text: opt.label });
      el.value = opt.value;
    }

    const output = section.createEl("pre", {
      cls: "wt-enrichment-dialog__preview-output",
    });
    // Seed the preview with the currently-persisted enrichment prompt so the
    // panel is useful immediately, without requiring the user to click Preview
    // just to see what their saved prompt resolves to.
    const initialTemplate =
      (settings["adapter.enrichmentPrompt"] as string) || DEFAULT_ENRICHMENT_PROMPT;
    output.textContent = resolvePromptPreview(initialTemplate);

    const previewBtn = actions.createEl("button", { text: "Preview" });
    previewBtn.addEventListener("click", async () => {
      // Re-read settings so the preview reflects any edits the user has made
      // since the dialog was opened. saveSettings writes are debounced via
      // mergeAndSavePluginData but have already resolved by the time onChange
      // returns, so loadData here sees the latest values.
      const latestData = (await this.plugin.loadData()) || {};
      const latestSettings: Record<string, unknown> = latestData.settings || {};
      const selected = (select.value as "prompt" | "retry") || "prompt";
      const template =
        selected === "retry"
          ? (latestSettings["adapter.retryEnrichmentPrompt"] as string) ||
            DEFAULT_RETRY_ENRICHMENT_PROMPT
          : (latestSettings["adapter.enrichmentPrompt"] as string) || DEFAULT_ENRICHMENT_PROMPT;
      output.textContent = resolvePromptPreview(template);
    });
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

  /**
   * Render the Retry enrichment profile dropdown. Lives alongside the main
   * enrichment profile so users can configure everything enrichment-related
   * in one place (issue #464). Only Claude-family profiles are surfaced
   * because the Retry Enrichment action launches through spawnClaudeWithPrompt
   * which rejects non-Claude profiles at launch time.
   */
  private renderRetryProfileDropdown(
    containerEl: HTMLElement,
    settings: Record<string, unknown>,
  ): void {
    const value = (settings["adapter.retryEnrichmentProfile"] as string) || "";
    const claudeProfiles = this.profileManager.getProfilesByType("claude");
    new Setting(containerEl)
      .setName("Retry enrichment profile")
      .setDesc(
        "Profile used when re-running enrichment from the card context menu. " +
          "Default: the background enrichment profile above if it is Claude-family; " +
          "otherwise the built-in Claude (ctx) profile.",
      )
      .addDropdown((dropdown) => {
        dropdown.addOption("", "Default (see description)");
        for (const profile of claudeProfiles) {
          dropdown.addOption(profile.id, profile.name);
        }
        dropdown.setValue(value).onChange(async (newValue) => {
          await this.saveSettings((s) => {
            s["adapter.retryEnrichmentProfile"] = newValue;
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
