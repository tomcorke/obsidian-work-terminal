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
import {
  REASONING_EFFORTS,
  supportsEffortOverride,
  supportsModelOverride,
} from "./actionProfileOverrides";
import { resolveCreateSubTaskProfile, resolveSplitTaskProfile } from "./splitTaskProfile";

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

    this.renderAction(containerEl, "Split task", "adapter.splitTask", settings);
    this.renderAction(containerEl, "Create sub-task", "adapter.createSubTask", settings);
  }

  private renderAction(
    containerEl: HTMLElement,
    name: string,
    prefix: string,
    settings: Record<string, unknown>,
  ): void {
    const profileKey = `${prefix}Profile`;
    const profiles = this.profileManager.getProfiles();
    const value = (settings[profileKey] as string) || "";
    const selected =
      prefix === "adapter.createSubTask"
        ? resolveCreateSubTaskProfile(settings, profiles)
        : resolveSplitTaskProfile(settings, profiles);

    new Setting(containerEl)
      .setName(`${name} profile`)
      .setDesc(
        "Profile used by this action. Default prefers Claude (ctx), then any available profile.",
      )
      .addDropdown((dropdown) => {
        dropdown.addOption("", "Default (see description)");
        for (const profile of profiles) dropdown.addOption(profile.id, profile.name);
        dropdown.setValue(value).onChange(async (newValue) => {
          await this.saveSettings((s) => {
            s[profileKey] = newValue;
          });
          await this.render();
        });
      });

    if (selected && supportsModelOverride(selected)) {
      this.renderTextOverride(containerEl, `${name} model`, `${prefix}Model`, settings);
    }
    if (selected && supportsEffortOverride(selected)) {
      new Setting(containerEl)
        .setName(`${name} reasoning effort`)
        .setDesc("Optional typed override. Leave default to use profile arguments.")
        .addDropdown((dropdown) => {
          dropdown.addOption("", "Profile default");
          for (const effort of REASONING_EFFORTS.slice(1)) dropdown.addOption(effort, effort);
          dropdown
            .setValue((settings[`${prefix}Effort`] as string) || "")
            .onChange(async (newValue) => {
              await this.saveSettings((s) => {
                s[`${prefix}Effort`] = newValue;
              });
            });
        });
    }
  }

  private renderTextOverride(
    containerEl: HTMLElement,
    name: string,
    key: string,
    settings: Record<string, unknown>,
  ): void {
    new Setting(containerEl)
      .setName(name)
      .setDesc("Optional model ID override. Leave blank to use profile arguments.")
      .addText((text) => {
        text.setValue((settings[key] as string) || "").onChange(async (newValue) => {
          await this.saveSettings((s) => {
            s[key] = newValue.trim();
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
