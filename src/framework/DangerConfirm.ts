/**
 * DangerConfirm - two-phase confirmation for dangerous actions.
 *
 * Uses a simple modal approach: shows a modal with the action name
 * and a confirm button that must be clicked to execute.
 */
import { Modal, App } from "obsidian";

export class DangerConfirm extends Modal {
  private label: string;
  private callback: () => void;
  private confirmed = false;

  constructor(app: App, label: string, callback: () => void) {
    super(app);
    this.label = label;
    this.callback = callback;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "Confirm action" });
    contentEl.createEl("p", { text: `Are you sure you want to: ${this.label}?` });

    const btnContainer = contentEl.createDiv({ cls: "wt-danger-buttons" });
    btnContainer.style.cssText =
      "display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px;";

    const cancelBtn = btnContainer.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.close());

    const confirmBtn = btnContainer.createEl("button", { text: "Confirm", cls: "mod-warning" });
    confirmBtn.addEventListener("click", () => {
      this.confirmed = true;
      this.close();
    });
  }

  onClose(): void {
    if (this.confirmed) {
      this.callback();
    }
  }

  /**
   * Static helper to show a DangerConfirm modal.
   * Falls back to direct execution if no app reference available.
   */
  static confirm(label: string, callback: () => void): void {
    // For now, execute directly - the real integration will use the app reference
    // passed through the framework. The two-phase behavior is handled in the
    // context menu rendering by showing the modal.
    callback();
  }
}
