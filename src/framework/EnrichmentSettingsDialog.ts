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
import { App, Modal } from "obsidian";
import type { Plugin } from "obsidian";
import type { AdapterBundle } from "../core/interfaces";
import type { AgentProfileManager } from "../core/agents/AgentProfileManager";

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

  /**
   * Render the body of the dialog. Subclasses and future commits add the
   * actual setting fields and prompt previews here.
   */
  protected async renderFields(containerEl: HTMLElement): Promise<void> {
    containerEl.createEl("p", {
      text: "Enrichment settings will appear here.",
      cls: "wt-enrichment-dialog__placeholder",
    });
  }
}
