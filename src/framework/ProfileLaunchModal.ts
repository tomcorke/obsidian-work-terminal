import { App, Modal, Setting } from "obsidian";
import type { AgentProfile } from "../core/agents/AgentProfile";
import type { ClosedSessionEntry } from "../core/session/RecentlyClosedStore";
import { isValidCssColor } from "../core/utils";
import { createProfileIcon } from "../ui/ProfileIcons";
import { getDefaultSessionLabel } from "./CustomSessionConfig";

function formatTimeAgo(closedAt: number): string {
  const seconds = Math.floor((Date.now() - closedAt) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes === 1) return "1m ago";
  return `${minutes}m ago`;
}

export interface ProfileLaunchOverrides {
  profile: AgentProfile;
  cwd: string;
  extraArgs: string;
  label: string;
}

export class ProfileLaunchModal extends Modal {
  private selectedProfile: AgentProfile;
  private cwdOverride = "";
  private extraArgsOverride = "";
  private labelOverride = "";
  private activeTab: "new" | "restore" = "new";

  constructor(
    app: App,
    private profiles: AgentProfile[],
    private defaultCwd: string,
    private onSubmit: (overrides: ProfileLaunchOverrides) => void,
    private closedSessions: ClosedSessionEntry[] = [],
    private onRestore?: (entry: ClosedSessionEntry) => void,
  ) {
    super(app);
    this.selectedProfile = profiles[0];
  }

  onOpen(): void {
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("wt-custom-spawn-modal");

    const hasClosedSessions = this.closedSessions.length > 0;

    if (hasClosedSessions) {
      const tabBar = contentEl.createDiv({ cls: "wt-custom-spawn-tabs" });

      const newTab = tabBar.createEl("button", {
        text: "Launch profile",
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
      this.renderLaunchTab(contentEl);
    }
  }

  private renderLaunchTab(contentEl: HTMLElement): void {
    contentEl.createEl("h3", { text: "Launch profile" });
    contentEl.createEl("p", {
      text: "Pick a profile and optionally override settings for this launch.",
      cls: "wt-custom-spawn-help",
    });

    const summaryContainer = contentEl.createDiv({ cls: "wt-launch-summary" });

    new Setting(contentEl)
      .setName("Profile")
      .setDesc("Agent profile to launch")
      .addDropdown((dropdown) => {
        for (const profile of this.profiles) {
          dropdown.addOption(profile.id, profile.name);
        }
        if (this.selectedProfile) {
          dropdown.setValue(this.selectedProfile.id);
        }
        dropdown.onChange((value) => {
          this.selectedProfile = this.profiles.find((p) => p.id === value) || this.profiles[0];
          this.renderProfileSummary(summaryContainer);
        });
      });

    this.renderProfileSummary(summaryContainer);

    new Setting(contentEl)
      .setName("Working directory")
      .setDesc("Override the working directory (leave blank to use the profile default)")
      .addText((text) => {
        text
          .setPlaceholder(this.defaultCwd)
          .setValue(this.cwdOverride)
          .onChange((value) => {
            this.cwdOverride = value;
          });
        text.inputEl.addClass("wt-custom-spawn-input");
      });

    new Setting(contentEl)
      .setName("Tab label")
      .setDesc("Override the tab label (leave blank to use the profile default)")
      .addText((text) => {
        text
          .setPlaceholder(this.selectedProfile?.name || "")
          .setValue(this.labelOverride)
          .onChange((value) => {
            this.labelOverride = value;
          });
        text.inputEl.addClass("wt-custom-spawn-input");
      });

    new Setting(contentEl)
      .setName("Extra arguments")
      .setDesc("Additional CLI arguments appended to the profile arguments")
      .addTextArea((text) => {
        text
          .setPlaceholder("--model gpt-5.4")
          .setValue(this.extraArgsOverride)
          .onChange((value) => {
            this.extraArgsOverride = value;
          });
        text.inputEl.addClass("wt-custom-spawn-textarea");
      });

    const buttons = contentEl.createDiv({ cls: "wt-custom-spawn-buttons" });
    const cancelBtn = buttons.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.close());

    const spawnBtn = buttons.createEl("button", { text: "Launch", cls: "mod-cta" });
    spawnBtn.addEventListener("click", () => {
      this.onSubmit({
        profile: this.selectedProfile,
        cwd: this.cwdOverride.trim(),
        extraArgs: this.extraArgsOverride.trim(),
        label: this.labelOverride.trim(),
      });
      this.close();
    });
  }

  private renderProfileSummary(container: HTMLElement): void {
    renderProfileSummary(container, this.selectedProfile);
  }

  private renderRestoreTab(contentEl: HTMLElement): void {
    contentEl.createEl("h3", { text: "Restore recent sessions" });
    contentEl.createEl("p", {
      text: "Resume reopens the original agent session. Relaunch starts a fresh terminal, so prior scrollback is not restored.",
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
      labelEl.createSpan({
        text: entry.recoveryMode === "resume" ? "Resume exact session" : "Relaunch fresh session",
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

export function renderProfileSummary(container: HTMLElement, profile: AgentProfile | null): void {
  container.empty();
  if (!profile) return;

  const color = profile.button.color;
  if (color && isValidCssColor(color)) {
    container.style.borderLeftColor = color;
  } else {
    container.style.borderLeftColor = "var(--background-modifier-border)";
  }

  const header = container.createDiv({ cls: "wt-launch-summary-header" });
  const icon = createProfileIcon(profile.button.icon, 18);
  if (icon) {
    if (color && isValidCssColor(color)) {
      icon.style.color = color;
    }
    header.appendChild(icon);
  }
  header.createSpan({ text: profile.name, cls: "wt-launch-summary-name" });

  const details = container.createDiv({ cls: "wt-launch-summary-details" });

  if (profile.command) {
    details.createDiv({
      cls: "wt-launch-summary-row",
      text: `Command: ${profile.command}`,
    });
  }
  if (profile.arguments) {
    details.createDiv({
      cls: "wt-launch-summary-row",
      text: `Arguments: ${profile.arguments}`,
    });
  }
  if (profile.defaultCwd) {
    details.createDiv({
      cls: "wt-launch-summary-row",
      text: `CWD: ${profile.defaultCwd}`,
    });
  }
  if (profile.contextPrompt) {
    const snippet =
      profile.contextPrompt.length > 80
        ? profile.contextPrompt.slice(0, 80) + "..."
        : profile.contextPrompt;
    details.createDiv({
      cls: "wt-launch-summary-row",
      text: `Context: ${snippet}`,
    });
  }

  if (!profile.command && !profile.arguments && !profile.defaultCwd && !profile.contextPrompt) {
    details.createDiv({
      cls: "wt-launch-summary-row wt-launch-summary-default",
      text: "Using default settings",
    });
  }
}
