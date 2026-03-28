import { App, Modal, Setting } from "obsidian";
import type { CustomSessionConfig } from "./CustomSessionConfig";
import {
  CUSTOM_SESSION_TYPE_OPTIONS,
  getDefaultSessionLabel,
  supportsExtraArgs,
} from "./CustomSessionConfig";

export class CustomSessionModal extends Modal {
  private draft: CustomSessionConfig;

  constructor(
    app: App,
    initial: CustomSessionConfig,
    private onSubmit: (config: CustomSessionConfig) => void,
  ) {
    super(app);
    this.draft = { ...initial };
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("wt-custom-spawn-modal");

    contentEl.createEl("h3", { text: "Custom session" });
    contentEl.createEl("p", {
      text: "Choose a session type and overrides for this task. The last custom settings you use are remembered per task.",
      cls: "wt-custom-spawn-help",
    });

    let extraArgsSetting: Setting | null = null;

    const refreshVisibility = () => {
      if (!extraArgsSetting) return;
      extraArgsSetting.settingEl.style.display = supportsExtraArgs(this.draft.sessionType)
        ? ""
        : "none";
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

  onClose(): void {
    this.contentEl.empty();
  }
}
