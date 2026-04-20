/**
 * TerminalSettingsDialog - dedicated modal housing terminal-behaviour settings
 * that used to live inline in the main settings page. Extracted so the
 * top-level settings page stays scannable (issue #462) and future
 * terminal-specific controls (keyboard-capture toggles, resize behaviour,
 * etc.) have room to grow without adding noise to the main list.
 *
 * Currently houses:
 *   - core.defaultShell
 *   - core.defaultTerminalCwd
 *
 * Settings are persisted through the same `plugin.loadData`/saveData path as
 * the rest of the settings UI using the existing core keys, so behaviour is
 * identical for users who never open the dialog. Mirrors the structure of
 * EnrichmentSettingsDialog and AgentActionsDialog - the pattern is
 * deliberately duplicated (not extracted to a base class) so each dialog
 * stays small and self-contained.
 */
import { App, Modal, Setting } from "obsidian";
import type { Plugin } from "obsidian";
import type { AdapterBundle } from "../core/interfaces";
import { mergeAndSavePluginData } from "../core/PluginDataStore";
import { SETTINGS_CHANGED_EVENT, loadAllSettings } from "./SettingsTab";

export class TerminalSettingsDialog extends Modal {
  protected plugin: Plugin;
  protected adapter: AdapterBundle;

  constructor(app: App, plugin: Plugin, adapter: AdapterBundle) {
    super(app);
    this.plugin = plugin;
    this.adapter = adapter;
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
    contentEl.addClass("wt-terminal-dialog");

    contentEl.createEl("h3", { text: "Terminal" });
    contentEl.createEl("p", {
      text:
        "Configure how terminal tabs are launched. These settings apply to " +
        "new terminal tabs - existing tabs keep whatever shell and working " +
        "directory they were opened with.",
      cls: "wt-terminal-dialog__help",
    });

    const bodyEl = contentEl.createDiv({ cls: "wt-terminal-dialog__body" });
    await this.renderFields(bodyEl);

    const actions = contentEl.createDiv({ cls: "wt-terminal-dialog__actions" });
    const closeBtn = actions.createEl("button", { text: "Done" });
    closeBtn.addEventListener("click", () => this.close());
  }

  protected async renderFields(containerEl: HTMLElement): Promise<void> {
    const data = (await this.plugin.loadData()) || {};
    const settings: Record<string, unknown> = data.settings || {};

    this.renderTextField(
      containerEl,
      "Default shell",
      "Shell used for new terminal tabs. Defaults to $SHELL at plugin load time.",
      "core.defaultShell",
      (settings["core.defaultShell"] as string | null | undefined) ??
        process.env.SHELL ??
        "/bin/zsh",
    );
    this.renderTextField(
      containerEl,
      "Default terminal CWD",
      "Working directory for new terminal tabs. Supports ~ which expands to your home directory.",
      "core.defaultTerminalCwd",
      (settings["core.defaultTerminalCwd"] as string | null | undefined) ?? "~",
    );
  }

  private renderTextField(
    containerEl: HTMLElement,
    name: string,
    description: string,
    key: string,
    value: string,
  ): void {
    new Setting(containerEl)
      .setName(name)
      .setDesc(description)
      .addText((text) => {
        text.inputEl.dataset.settingKey = key;
        text.setValue(value).onChange(async (newValue) => {
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
