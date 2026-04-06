/**
 * AgentProfileModal - modal for editing a single agent profile.
 * Covers all profile fields: name, agent type, command, CWD, arguments,
 * context prompt, button configuration, and parameter pass mode.
 */
import { App, Modal, Notice, Setting } from "obsidian";
import type {
  AgentProfile,
  AgentType,
  BorderStyle,
  ParamPassMode,
  ProfileIcon,
} from "../core/agents/AgentProfile";
import {
  AGENT_TYPES,
  BORDER_STYLES,
  BRAND_COLORS,
  PARAM_PASS_MODES,
  PROFILE_ICONS,
  createDefaultProfile,
} from "../core/agents/AgentProfile";
import {
  isAbsoluteCommandPath,
  isPathLikeCommand,
  resolveCommandInfo,
} from "../core/agents/AgentLauncher";
import { expandTilde, isValidCssColor } from "../core/utils";

const AGENT_TYPE_LABELS: Record<AgentType, string> = {
  claude: "Claude",
  copilot: "Copilot",
  strands: "Strands",
  shell: "Shell",
};

const BORDER_STYLE_LABELS: Record<BorderStyle, string> = {
  solid: "Solid",
  dashed: "Dashed",
  dotted: "Dotted",
  thick: "Thick",
};

const PARAM_PASS_MODE_LABELS: Record<ParamPassMode, string> = {
  "launch-only": "Launch only",
  "resume-only": "Resume only",
  both: "Both",
};

const ICON_LABELS: Record<ProfileIcon, string> = {
  terminal: "Terminal",
  bot: "Bot",
  brain: "Brain",
  code: "Code",
  rocket: "Rocket",
  zap: "Zap",
  cog: "Cog",
  wrench: "Wrench",
  shield: "Shield",
  globe: "Globe",
  search: "Search",
  lightbulb: "Lightbulb",
  flask: "Flask",
  book: "Book",
  puzzle: "Puzzle",
  bee: "Bee",
  claude: "Claude (branded)",
  copilot: "Copilot (branded)",
  aws: "AWS (branded)",
  skyscanner: "Skyscanner (branded)",
};

export class AgentProfileEditModal extends Modal {
  private draft: AgentProfile;
  private isNew: boolean;

  constructor(
    app: App,
    profile: AgentProfile | null,
    private onSave: (profile: AgentProfile) => void,
    private onDelete?: (id: string) => void,
    private adapterPromptDescription?: string,
  ) {
    super(app);
    this.isNew = !profile;
    this.draft = profile ? { ...profile, button: { ...profile.button } } : createDefaultProfile();
    // Normalize imported whitespace-only color values
    if (this.draft.button.color !== undefined) {
      const trimmed = this.draft.button.color.trim();
      this.draft.button.color = trimmed || undefined;
    }
  }

  onOpen(): void {
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("wt-profile-edit-modal");

    contentEl.createEl("h3", { text: this.isNew ? "New Agent Profile" : "Edit Agent Profile" });

    // Name
    new Setting(contentEl)
      .setName("Profile name")
      .setDesc("Display name for this profile")
      .addText((text) => {
        text
          .setPlaceholder("My Agent")
          .setValue(this.draft.name)
          .onChange((value) => {
            this.draft.name = value;
          });
        text.inputEl.addClass("wt-profile-input");
      });

    // Agent type
    new Setting(contentEl)
      .setName("Agent type")
      .setDesc("Determines how sessions are launched and resumed")
      .addDropdown((dropdown) => {
        for (const type of AGENT_TYPES) {
          dropdown.addOption(type, AGENT_TYPE_LABELS[type]);
        }
        dropdown.setValue(this.draft.agentType).onChange((value) => {
          this.draft.agentType = value as AgentType;
        });
      });

    // Command
    const commandSetting = new Setting(contentEl)
      .setName("Executable path")
      .setDesc(
        "Path or name of the CLI binary. Leave blank to use the global setting for this agent type.",
      )
      .addText((text) => {
        text
          .setPlaceholder("(use global default)")
          .setValue(this.draft.command)
          .onChange((value) => {
            this.draft.command = value;
            this.updateCommandValidation(commandSetting.descEl);
          });
        text.inputEl.addClass("wt-profile-input");
      });
    this.addCommandValidation(commandSetting.descEl);

    // Default CWD
    new Setting(contentEl)
      .setName("Working directory")
      .setDesc(
        "Default CWD for sessions. Leave blank to use the global setting. Supports ~ expansion.",
      )
      .addText((text) => {
        text
          .setPlaceholder("(use global default)")
          .setValue(this.draft.defaultCwd)
          .onChange((value) => {
            this.draft.defaultCwd = value;
          });
        text.inputEl.addClass("wt-profile-input");
      });

    // Arguments
    const argsSetting = new Setting(contentEl)
      .setName("Arguments")
      .setDesc(
        "Extra CLI arguments. Merged with global defaults. Placeholders: $title, $state, $filePath, $id, $sessionId, $workTerminalPrompt (full assembled context prompt)",
      )
      .addTextArea((ta) => {
        ta.setValue(this.draft.arguments).onChange((value) => {
          this.draft.arguments = value;
        });
        ta.inputEl.style.width = "100%";
        ta.inputEl.style.minHeight = "60px";
      });
    argsSetting.settingEl.style.flexWrap = "wrap";
    argsSetting.controlEl.style.width = "100%";

    // Use context
    new Setting(contentEl)
      .setName("Include context prompt")
      .setDesc("Send the adapter prompt and context template as the initial message")
      .addToggle((toggle) => {
        toggle.setValue(this.draft.useContext).onChange((value) => {
          this.draft.useContext = value;
        });
      });

    // Adapter prompt preview - always shown when the adapter provides a description,
    // regardless of useContext state, so users can see what gets prepended.
    if (this.adapterPromptDescription) {
      const previewEl = contentEl.createDiv({ cls: "wt-adapter-prompt-preview" });
      previewEl.createDiv({
        text: "Adapter base prompt",
        cls: "wt-adapter-prompt-preview-label",
      });
      previewEl.createDiv({
        text: "When context is enabled, the adapter prepends the following to every context prompt:",
        cls: "wt-adapter-prompt-preview-help",
      });
      const codeEl = previewEl.createEl("pre", { cls: "wt-adapter-prompt-preview-code" });
      codeEl.createEl("code", { text: this.adapterPromptDescription });
    }

    // Suppress adapter prompt
    new Setting(contentEl)
      .setName("Suppress adapter prompt")
      .setDesc(
        "When enabled, the adapter's base prompt is not prepended - your context template is used as the full prompt. Use $title, $state, $filePath, $id placeholders for item data.",
      )
      .addToggle((toggle) => {
        toggle.setValue(this.draft.suppressAdapterPrompt).onChange((value) => {
          this.draft.suppressAdapterPrompt = value;
        });
      });

    // Context prompt
    const ctxSetting = new Setting(contentEl)
      .setName("Context prompt template")
      .setDesc(
        "Custom context template for this profile. Leave blank to use the global additional context. Placeholders: $title, $state, $filePath, $id, $sessionId",
      )
      .addTextArea((ta) => {
        ta.setValue(this.draft.contextPrompt).onChange((value) => {
          this.draft.contextPrompt = value;
        });
        ta.inputEl.style.width = "100%";
        ta.inputEl.style.minHeight = "80px";
      });
    ctxSetting.settingEl.style.flexWrap = "wrap";
    ctxSetting.controlEl.style.width = "100%";

    // Parameter pass mode
    new Setting(contentEl)
      .setName("Parameter pass mode")
      .setDesc("When to pass arguments and context prompt: on initial launch, on resume, or both")
      .addDropdown((dropdown) => {
        for (const mode of PARAM_PASS_MODES) {
          dropdown.addOption(mode, PARAM_PASS_MODE_LABELS[mode]);
        }
        dropdown.setValue(this.draft.paramPassMode).onChange((value) => {
          this.draft.paramPassMode = value as ParamPassMode;
        });
      });

    // ---------------------------------------------------------------------------
    // Button configuration
    // ---------------------------------------------------------------------------

    contentEl.createEl("h4", { text: "Tab bar button" });

    new Setting(contentEl)
      .setName("Show button in tab bar")
      .setDesc("Display a launch button outside the '...' menu")
      .addToggle((toggle) => {
        toggle.setValue(this.draft.button.enabled).onChange((value) => {
          this.draft.button.enabled = value;
        });
      });

    new Setting(contentEl)
      .setName("Button label")
      .setDesc("Text shown on the button. Leave blank to use the profile name.")
      .addText((text) => {
        text
          .setPlaceholder(this.draft.name || "Profile name")
          .setValue(this.draft.button.label)
          .onChange((value) => {
            this.draft.button.label = value;
          });
        text.inputEl.addClass("wt-profile-input");
      });

    let colorInputEl: HTMLInputElement | null = null;
    let colorSettingEl: HTMLElement | null = null;

    new Setting(contentEl)
      .setName("Button icon")
      .setDesc("Icon shown on the button")
      .addDropdown((dropdown) => {
        dropdown.addOption("", "(none)");
        for (const icon of PROFILE_ICONS) {
          dropdown.addOption(icon, ICON_LABELS[icon]);
        }
        dropdown.setValue(this.draft.button.icon || "").onChange((value) => {
          this.draft.button.icon = (value || undefined) as ProfileIcon | undefined;
          // Auto-populate brand color when selecting a branded icon with no color set
          const brandColor = value ? BRAND_COLORS[value as ProfileIcon] : undefined;
          if (brandColor && !this.draft.button.color) {
            this.draft.button.color = brandColor;
            if (colorInputEl) colorInputEl.value = brandColor;
            if (colorSettingEl) this.updateColorPreview(colorSettingEl);
          }
        });
      });

    new Setting(contentEl)
      .setName("Border style")
      .setDesc("Button border appearance")
      .addDropdown((dropdown) => {
        for (const style of BORDER_STYLES) {
          dropdown.addOption(style, BORDER_STYLE_LABELS[style]);
        }
        dropdown.setValue(this.draft.button.borderStyle || "solid").onChange((value) => {
          this.draft.button.borderStyle = value as BorderStyle;
        });
      });

    const colorSetting = new Setting(contentEl)
      .setName("Button color")
      .setDesc("CSS color for the button border and icon (e.g. #e67e22, var(--text-accent))")
      .addText((text) => {
        text
          .setPlaceholder("(default)")
          .setValue((this.draft.button.color || "").trim())
          .onChange((value) => {
            this.draft.button.color = value.trim() || undefined;
            this.updateColorPreview(colorSetting.controlEl);
          });
        text.inputEl.addClass("wt-profile-input");
        colorInputEl = text.inputEl;
      });
    colorSettingEl = colorSetting.controlEl;
    this.addColorPreview(colorSetting.controlEl);

    // ---------------------------------------------------------------------------
    // Action buttons
    // ---------------------------------------------------------------------------

    const buttons = contentEl.createDiv({ cls: "wt-profile-edit-buttons" });

    if (!this.isNew && this.onDelete) {
      const deleteBtn = buttons.createEl("button", { text: "Delete", cls: "mod-warning" });
      deleteBtn.addEventListener("click", () => {
        if (confirm(`Delete profile "${this.draft.name}"?`)) {
          this.onDelete!(this.draft.id);
          this.close();
        }
      });
    }

    // Spacer
    buttons.createDiv({ cls: "wt-profile-edit-spacer" });

    const cancelBtn = buttons.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.close());

    const saveBtn = buttons.createEl("button", {
      text: this.isNew ? "Create" : "Save",
      cls: "mod-cta",
    });
    saveBtn.addEventListener("click", () => {
      if (!this.draft.name.trim()) {
        new Notice("Profile name is required");
        return;
      }
      this.onSave(this.draft);
      this.close();
    });
  }

  private addColorPreview(controlEl: HTMLElement): void {
    const preview = controlEl.createDiv({ cls: "wt-color-preview" });
    this.updateColorPreview(controlEl);
    controlEl.prepend(preview);
  }

  private updateColorPreview(controlEl: HTMLElement): void {
    const preview = controlEl.querySelector<HTMLElement>(".wt-color-preview");
    if (!preview) return;
    const color = this.draft.button.color;
    if (color && isValidCssColor(color)) {
      preview.style.backgroundColor = color;
      preview.classList.remove("wt-color-preview-empty");
    } else {
      preview.style.backgroundColor = "";
      preview.classList.add("wt-color-preview-empty");
    }
  }

  private addCommandValidation(descEl: HTMLElement): void {
    const validationEl = descEl.createDiv({ cls: "wt-command-validation" });
    validationEl.createSpan({ cls: "wt-command-status-badge" });
    validationEl.createDiv({ cls: "wt-command-validation-note" });
    this.updateCommandValidation(descEl);
  }

  private updateCommandValidation(descEl: HTMLElement): void {
    const validationEl = descEl.querySelector(".wt-command-validation");
    if (!validationEl) return;
    const badgeEl = validationEl.querySelector<HTMLElement>(".wt-command-status-badge");
    const noteEl = validationEl.querySelector<HTMLElement>(".wt-command-validation-note");
    if (!badgeEl || !noteEl) return;

    const command = this.draft.command.trim();
    if (!command) {
      badgeEl.textContent = "";
      badgeEl.className = "wt-command-status-badge";
      noteEl.textContent = "Will use the global default for this agent type";
      noteEl.className = "wt-command-validation-note";
      return;
    }

    const cwd = expandTilde(this.draft.defaultCwd.trim() || "~");
    const resolution = resolveCommandInfo(command, cwd);
    const locationLabel = isAbsoluteCommandPath(command)
      ? "Using configured path"
      : isPathLikeCommand(command)
        ? `Resolved from ${cwd}`
        : "Searched PATH";

    badgeEl.textContent = resolution.found ? "Found" : "Not found";
    badgeEl.className = "wt-command-status-badge";
    badgeEl.classList.add(resolution.found ? "wt-command-status-ok" : "wt-command-status-missing");
    noteEl.textContent = `${locationLabel}: ${resolution.resolved || command}`;
    noteEl.className = "wt-command-validation-note";
    noteEl.classList.add(
      resolution.found ? "wt-command-validation-note-found" : "wt-command-validation-note-missing",
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
