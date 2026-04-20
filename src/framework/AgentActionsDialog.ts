/**
 * AgentActionsDialog - dedicated modal housing profile bindings for
 * agent-driven adapter actions (Split Task, and future per-action hooks).
 *
 * Mirrors the structure of EnrichmentSettingsDialog - the pattern is
 * deliberately duplicated (not extracted to a base class) so each dialog
 * stays small and self-contained.
 *
 * Settings are persisted through the same `plugin.loadData`/saveData path
 * as the rest of the adapter schema. Keys written here are:
 *   - adapter.splitTaskProfile
 *
 * The `adapter.retryEnrichmentProfile` binding used to live here too but
 * moved to EnrichmentSettingsDialog (issue #464) so all enrichment-related
 * settings are configurable in one place.
 *
 * The resolution chain (see splitTaskProfile.ts) means that leaving the
 * dropdown on "Default" still produces sensible behaviour: Split Task
 * falls back to the built-in Claude-with-context profile, then to any
 * remaining Claude-family profile.
 */
import { App, Modal, Setting } from "obsidian";
import type { Plugin } from "obsidian";
import type { AdapterBundle } from "../core/interfaces";
import { mergeAndSavePluginData } from "../core/PluginDataStore";
import type { AgentProfileManager } from "../core/agents/AgentProfileManager";
import { SETTINGS_CHANGED_EVENT, loadAllSettings } from "./SettingsTab";

export class AgentActionsDialog extends Modal {
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
    contentEl.addClass("wt-agent-actions-dialog");

    contentEl.createEl("h3", { text: "Agent actions" });
    contentEl.createEl("p", {
      text:
        "Choose which agent profile is launched by adapter-driven actions. " +
        "Leave a selection on 'Default' to follow the built-in fallback chain " +
        "described under each field.",
      cls: "wt-agent-actions-dialog__help",
    });

    const bodyEl = contentEl.createDiv({ cls: "wt-agent-actions-dialog__body" });
    await this.renderFields(bodyEl);

    const actions = contentEl.createDiv({ cls: "wt-agent-actions-dialog__actions" });
    const closeBtn = actions.createEl("button", { text: "Done" });
    closeBtn.addEventListener("click", () => this.close());
  }

  protected async renderFields(containerEl: HTMLElement): Promise<void> {
    const data = (await this.plugin.loadData()) || {};
    const settings: Record<string, unknown> = data.settings || {};

    this.renderProfileDropdown(
      containerEl,
      "Split task profile",
      "Profile used when launching Claude for the Split Task context menu action. " +
        "Default: the first available Claude-family profile (preferring the built-in " +
        "Claude-with-context profile when present). Renaming or deleting profiles does " +
        "not break this binding - the fallback chain still resolves to any remaining Claude profile.",
      "adapter.splitTaskProfile",
      settings,
    );
  }

  private renderProfileDropdown(
    containerEl: HTMLElement,
    name: string,
    description: string,
    key: string,
    settings: Record<string, unknown>,
  ): void {
    const value = (settings[key] as string) || "";
    // Split Task / Retry Enrichment actions launch Claude specifically - the
    // resolution helpers and spawnClaudeWithPrompt assume a Claude profile.
    // Only surface Claude profiles in the dropdown so users cannot bind a
    // shell/copilot/custom profile that would be rejected at launch time.
    const claudeProfiles = this.profileManager.getProfilesByType("claude");
    new Setting(containerEl)
      .setName(name)
      .setDesc(description)
      .addDropdown((dropdown) => {
        dropdown.addOption("", "Default (see description)");
        for (const profile of claudeProfiles) {
          dropdown.addOption(profile.id, profile.name);
        }
        dropdown.setValue(value).onChange(async (newValue) => {
          await this.saveSettings((s) => {
            s[key] = newValue;
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
