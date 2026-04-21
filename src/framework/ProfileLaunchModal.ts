import { App, Modal, Setting } from "obsidian";
import type { AgentProfile } from "../core/agents/AgentProfile";
import { isValidCssColor } from "../core/utils";
import { createProfileIcon } from "../ui/ProfileIcons";

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
  private cwdInput: HTMLInputElement | null = null;
  private labelInput: HTMLInputElement | null = null;
  private argsInput: HTMLTextAreaElement | null = null;

  constructor(
    app: App,
    private profiles: AgentProfile[],
    private defaultCwd: string,
    private onSubmit: (overrides: ProfileLaunchOverrides) => void,
    private onManageProfiles?: () => void,
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
    this.renderLaunchTab(contentEl);
  }

  private renderLaunchTab(contentEl: HTMLElement): void {
    contentEl.createEl("h3", { text: "Launch profile" });

    const helpEl = contentEl.createEl("p", { cls: "wt-custom-spawn-help" });
    helpEl.appendChild(
      document.createTextNode("Pick a profile and optionally override settings for this launch."),
    );
    if (this.onManageProfiles) {
      helpEl.appendChild(document.createTextNode(" "));
      const link = helpEl.createEl("a", {
        text: "Manage profiles",
        cls: "wt-custom-spawn-manage-profiles-link",
        attr: { href: "#" },
      });
      link.addEventListener("click", (e) => {
        e.preventDefault();
        this.close();
        this.onManageProfiles?.();
      });
    }

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
          this.updatePlaceholders();
        });
      });

    const summaryContainer = contentEl.createDiv({ cls: "wt-launch-summary" });
    this.renderProfileSummary(summaryContainer);

    new Setting(contentEl)
      .setName("Working directory")
      .setDesc("Override the working directory (leave blank to use the profile default)")
      .addText((text) => {
        text
          .setPlaceholder(this.getCwdPlaceholder())
          .setValue(this.cwdOverride)
          .onChange((value) => {
            this.cwdOverride = value;
          });
        text.inputEl.addClass("wt-custom-spawn-input");
        this.cwdInput = text.inputEl;
      });

    new Setting(contentEl)
      .setName("Tab label")
      .setDesc("Override the tab label (leave blank to use the profile default)")
      .addText((text) => {
        text
          .setPlaceholder(this.getLabelPlaceholder())
          .setValue(this.labelOverride)
          .onChange((value) => {
            this.labelOverride = value;
          });
        text.inputEl.addClass("wt-custom-spawn-input");
        this.labelInput = text.inputEl;
      });

    new Setting(contentEl)
      .setName("Extra arguments")
      .setDesc("Additional CLI arguments appended to the profile arguments")
      .addTextArea((text) => {
        text
          .setPlaceholder(this.getArgsPlaceholder())
          .setValue(this.extraArgsOverride)
          .onChange((value) => {
            this.extraArgsOverride = value;
          });
        text.inputEl.addClass("wt-custom-spawn-textarea");
        this.argsInput = text.inputEl;
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

  private getCwdPlaceholder(): string {
    return this.selectedProfile?.defaultCwd || this.defaultCwd || "Profile default";
  }

  private getLabelPlaceholder(): string {
    const profile = this.selectedProfile;
    return profile?.button.label || profile?.name || "";
  }

  private getArgsPlaceholder(): string {
    return this.selectedProfile?.arguments || "Optional extra arguments";
  }

  private updatePlaceholders(): void {
    if (this.cwdInput) this.cwdInput.placeholder = this.getCwdPlaceholder();
    if (this.labelInput) this.labelInput.placeholder = this.getLabelPlaceholder();
    if (this.argsInput) this.argsInput.placeholder = this.getArgsPlaceholder();
  }

  private renderProfileSummary(container: HTMLElement): void {
    renderProfileSummary(container, this.selectedProfile);
  }

  onClose(): void {
    this.contentEl.empty();
    this.cwdInput = null;
    this.labelInput = null;
    this.argsInput = null;
  }
}

export function renderProfileSummary(container: HTMLElement, profile: AgentProfile | null): void {
  container.empty();
  if (!profile) return;

  const color = profile.button.color;
  if (color && isValidCssColor(color)) {
    container.style.borderLeftColor = color;
  }

  const header = container.createDiv({ cls: "wt-launch-summary-header" });
  const icon = createProfileIcon(profile.button.icon, 18);
  if (icon) {
    icon.style.marginRight = "0";
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
