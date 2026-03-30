import { App, Modal, Setting } from "obsidian";
import type { CustomSessionConfig } from "./CustomSessionConfig";
import type { ClosedSessionEntry } from "../core/session/RecentlyClosedStore";
import {
  CUSTOM_SESSION_TYPE_OPTIONS,
  getDefaultSessionLabel,
  getSessionTypeHelp,
  supportsExtraArgs,
} from "./CustomSessionConfig";

function formatTimeAgo(closedAt: number): string {
  const seconds = Math.floor((Date.now() - closedAt) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes === 1) return "1m ago";
  return `${minutes}m ago`;
}

export class CustomSessionModal extends Modal {
  private draft: CustomSessionConfig;
  private activeTab: "new" | "restore" = "new";

  constructor(
    app: App,
    initial: CustomSessionConfig,
    private onSubmit: (config: CustomSessionConfig) => void,
    private closedSessions: ClosedSessionEntry[] = [],
    private onRestore?: (entry: ClosedSessionEntry) => void,
  ) {
    super(app);
    this.draft = { ...initial };
  }

  onOpen(): void {
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("wt-custom-spawn-modal");

    const hasClosedSessions = this.closedSessions.length > 0;

    // Tab bar (only show if there are closed sessions to restore)
    if (hasClosedSessions) {
      const tabBar = contentEl.createDiv({ cls: "wt-custom-spawn-tabs" });

      const newTab = tabBar.createEl("button", {
        text: "New session",
        cls: `wt-custom-spawn-tab${this.activeTab === "new" ? " wt-custom-spawn-tab-active" : ""}`,
      });
      newTab.addEventListener("click", () => {
        this.activeTab = "new";
        this.render();
      });

      const restoreTab = tabBar.createEl("button", {
        text: "Restore recent",
        cls: `wt-custom-spawn-tab${this.activeTab === "restore" ? " wt-custom-spawn-tab-active" : ""}`,
      });
      restoreTab.addEventListener("click", () => {
        this.activeTab = "restore";
        this.render();
      });
    }

    if (this.activeTab === "restore" && hasClosedSessions) {
      this.renderRestoreTab(contentEl);
    } else {
      this.renderNewSessionTab(contentEl);
    }
  }

  private renderNewSessionTab(contentEl: HTMLElement): void {
    contentEl.createEl("h3", { text: "Custom session" });
    contentEl.createEl("p", {
      text: "Choose a session type and overrides for this task. The last custom settings you use are remembered per task.",
      cls: "wt-custom-spawn-help",
    });

    const sessionTypeHelpEl = contentEl.createEl("p", {
      text: getSessionTypeHelp(this.draft.sessionType),
      cls: "wt-custom-spawn-help",
    });

    let extraArgsSetting: Setting | null = null;

    const refreshVisibility = () => {
      if (!extraArgsSetting) return;
      extraArgsSetting.settingEl.style.display = supportsExtraArgs(this.draft.sessionType)
        ? ""
        : "none";
      sessionTypeHelpEl.textContent = getSessionTypeHelp(this.draft.sessionType);
    };

    new Setting(contentEl)
      .setName("Session type")
      .setDesc("What kind of tab to spawn")
      .addDropdown((dropdown) => {
        for (const option of CUSTOM_SESSION_TYPE_OPTIONS) {
          dropdown.addOption(option.value, option.label);
        }
        dropdown.setValue(this.draft.sessionType).onChange((value) => {
          this.draft.sessionType = value as CustomSessionConfig["sessionType"];
          refreshVisibility();
        });
      });

    new Setting(contentEl)
      .setName("Working directory")
      .setDesc("Override the terminal working directory for this spawned tab")
      .addText((text) => {
        text
          .setPlaceholder("~")
          .setValue(this.draft.cwd)
          .onChange((value) => {
            this.draft.cwd = value;
          });
        text.inputEl.addClass("wt-custom-spawn-input");
      });

    new Setting(contentEl)
      .setName("Tab label")
      .setDesc("Optional tab label override; leave blank to use the default label")
      .addText((text) => {
        text
          .setPlaceholder(getDefaultSessionLabel(this.draft.sessionType))
          .setValue(this.draft.label)
          .onChange((value) => {
            this.draft.label = value;
          });
        text.inputEl.addClass("wt-custom-spawn-input");
      });

    extraArgsSetting = new Setting(contentEl)
      .setName("Extra arguments")
      .setDesc("Additional CLI arguments for this tab only (space-separated)")
      .addTextArea((text) => {
        text
          .setPlaceholder("--model gpt-5.4")
          .setValue(this.draft.extraArgs)
          .onChange((value) => {
            this.draft.extraArgs = value;
          });
        text.inputEl.addClass("wt-custom-spawn-textarea");
      });
    extraArgsSetting.settingEl.addClass("wt-custom-spawn-setting");
    refreshVisibility();

    const buttons = contentEl.createDiv({ cls: "wt-custom-spawn-buttons" });
    const cancelBtn = buttons.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.close());

    const spawnBtn = buttons.createEl("button", { text: "Spawn", cls: "mod-cta" });
    spawnBtn.addEventListener("click", () => {
      this.onSubmit({
        sessionType: this.draft.sessionType,
        cwd: this.draft.cwd,
        extraArgs: this.draft.extraArgs,
        label: this.draft.label,
      });
      this.close();
    });
  }

  private renderRestoreTab(contentEl: HTMLElement): void {
    contentEl.createEl("h3", { text: "Restore recent sessions" });
    contentEl.createEl("p", {
      text: "Sessions closed within the past 30 minutes. Click to reopen.",
      cls: "wt-custom-spawn-help",
    });

    const listEl = contentEl.createDiv({ cls: "wt-recently-closed-list" });

    for (const entry of this.closedSessions) {
      const row = listEl.createEl("button", { cls: "wt-recently-closed-row" });

      const labelEl = row.createDiv({ cls: "wt-recently-closed-label" });
      labelEl.createSpan({ text: entry.label, cls: "wt-recently-closed-name" });
      labelEl.createSpan({
        text: getDefaultSessionLabel(entry.sessionType),
        cls: "wt-recently-closed-type",
      });

      row.createDiv({
        text: formatTimeAgo(entry.closedAt),
        cls: "wt-recently-closed-time",
      });

      row.addEventListener("click", () => {
        this.onRestore?.(entry);
        this.close();
      });
    }

    const buttons = contentEl.createDiv({ cls: "wt-custom-spawn-buttons" });
    const cancelBtn = buttons.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
