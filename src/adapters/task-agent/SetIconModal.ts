/**
 * SetIconModal - simple modal for entering a Lucide icon name or emoji
 * to assign as a task's custom icon.
 */
import { Modal, Setting, type App } from "obsidian";

export class SetIconModal extends Modal {
  private currentValue: string;
  private onSubmit: (value: string) => void;

  constructor(app: App, currentValue: string, onSubmit: (value: string) => void) {
    super(app);
    this.currentValue = currentValue;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "Set task icon" });
    contentEl.createEl("p", {
      text: "Enter a Lucide icon name (e.g. rocket, terminal, flame) or an emoji character.",
      cls: "wt-set-icon-help",
    });

    let inputValue = this.currentValue;

    new Setting(contentEl).setName("Icon").addText((text) => {
      text
        .setPlaceholder("e.g. rocket or \uD83D\uDE80")
        .setValue(this.currentValue)
        .onChange((value) => {
          inputValue = value;
        });
      // Focus the input and select all text
      setTimeout(() => {
        text.inputEl.focus();
        text.inputEl.select();
      }, 50);
      // Submit on Enter
      text.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter") {
          e.preventDefault();
          if (inputValue.trim()) {
            this.onSubmit(inputValue.trim());
            this.close();
          }
        }
      });
    });

    const btnContainer = contentEl.createDiv({ cls: "wt-set-icon-buttons" });
    btnContainer.style.cssText =
      "display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px;";

    const cancelBtn = btnContainer.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.close());

    const confirmBtn = btnContainer.createEl("button", { text: "Set Icon", cls: "mod-cta" });
    confirmBtn.addEventListener("click", () => {
      if (inputValue.trim()) {
        this.onSubmit(inputValue.trim());
        this.close();
      }
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
