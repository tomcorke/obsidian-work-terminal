/**
 * AgentProfileManagerModal - settings modal listing all agent profiles.
 * Supports add, edit, delete, reorder, import, and export.
 */
import { App, Modal, Notice } from "obsidian";
import type { AgentProfileManager } from "../core/agents/AgentProfileManager";
import type { AgentProfile } from "../core/agents/AgentProfile";
import { AgentProfileEditModal } from "./AgentProfileModal";
import { electronRequire, isValidCssColor } from "../core/utils";

const AGENT_TYPE_LABELS: Record<string, string> = {
  claude: "Claude",
  copilot: "Copilot",
  strands: "Strands",
  shell: "Shell",
};

export class AgentProfileManagerModal extends Modal {
  constructor(
    app: App,
    private manager: AgentProfileManager,
  ) {
    super(app);
  }

  onOpen(): void {
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("wt-profile-manager-modal");

    contentEl.createEl("h3", { text: "Agent Profiles" });
    contentEl.createEl("p", {
      text: "Configure reusable agent launch profiles. Each profile can show a button in the tab bar for quick access.",
      cls: "wt-profile-manager-help",
    });

    const profiles = this.manager.getProfiles();

    // Profile list
    const listEl = contentEl.createDiv({ cls: "wt-profile-list" });

    if (profiles.length === 0) {
      listEl.createEl("p", {
        text: "No profiles configured. Add one to get started.",
        cls: "wt-profile-empty",
      });
    }

    for (const profile of profiles) {
      this.renderProfileRow(listEl, profile, profiles);
    }

    // Action buttons
    const actions = contentEl.createDiv({ cls: "wt-profile-manager-actions" });

    const addBtn = actions.createEl("button", { text: "+ Add Profile", cls: "mod-cta" });
    addBtn.addEventListener("click", () => {
      new AgentProfileEditModal(this.app, null, async (saved) => {
        const maxOrder = profiles.reduce((max, p) => Math.max(max, p.sortOrder), -1);
        saved.sortOrder = maxOrder + 1;
        await this.manager.addProfile(saved);
        this.render();
      }).open();
    });

    const importBtn = actions.createEl("button", { text: "Import" });
    importBtn.addEventListener("click", () => this.handleImport());

    const exportBtn = actions.createEl("button", { text: "Export" });
    exportBtn.addEventListener("click", () => this.handleExport());

    // Close button
    const closeActions = contentEl.createDiv({ cls: "wt-profile-manager-close" });
    const closeBtn = closeActions.createEl("button", { text: "Done" });
    closeBtn.addEventListener("click", () => this.close());
  }

  private renderProfileRow(
    container: HTMLElement,
    profile: AgentProfile,
    allProfiles: AgentProfile[],
  ): void {
    const row = container.createDiv({ cls: "wt-profile-row" });

    // Reorder buttons
    const reorderEl = row.createDiv({ cls: "wt-profile-reorder" });
    const currentIndex = allProfiles.findIndex((p) => p.id === profile.id);

    const upBtn = reorderEl.createEl("button", { text: "\u25B2", cls: "wt-profile-reorder-btn" });
    upBtn.disabled = currentIndex === 0;
    upBtn.addEventListener("click", async () => {
      const ids = allProfiles.map((p) => p.id);
      if (currentIndex > 0) {
        [ids[currentIndex - 1], ids[currentIndex]] = [ids[currentIndex], ids[currentIndex - 1]];
        await this.manager.reorderProfiles(ids);
        this.render();
      }
    });

    const downBtn = reorderEl.createEl("button", { text: "\u25BC", cls: "wt-profile-reorder-btn" });
    downBtn.disabled = currentIndex === allProfiles.length - 1;
    downBtn.addEventListener("click", async () => {
      const ids = allProfiles.map((p) => p.id);
      if (currentIndex < ids.length - 1) {
        [ids[currentIndex], ids[currentIndex + 1]] = [ids[currentIndex + 1], ids[currentIndex]];
        await this.manager.reorderProfiles(ids);
        this.render();
      }
    });

    // Color swatch (only for valid CSS colors)
    if (profile.button.color && isValidCssColor(profile.button.color)) {
      const swatch = row.createDiv({ cls: "wt-profile-color-swatch" });
      swatch.style.backgroundColor = profile.button.color.trim();
    }

    // Profile info
    const infoEl = row.createDiv({ cls: "wt-profile-info" });
    infoEl.createDiv({ text: profile.name, cls: "wt-profile-name" });

    const metaEl = infoEl.createDiv({ cls: "wt-profile-meta" });
    metaEl.createSpan({
      text: AGENT_TYPE_LABELS[profile.agentType] || profile.agentType,
      cls: "wt-profile-type-badge",
    });
    if (profile.useContext) {
      metaEl.createSpan({ text: "ctx", cls: "wt-profile-ctx-badge" });
    }
    if (profile.button.enabled) {
      metaEl.createSpan({ text: "button", cls: "wt-profile-button-badge" });
    }
    if (profile.command) {
      metaEl.createSpan({
        text: profile.command,
        cls: "wt-profile-command-badge",
      });
    }

    // Edit button
    const editBtn = row.createEl("button", { text: "Edit", cls: "wt-profile-edit-btn" });
    editBtn.addEventListener("click", () => {
      new AgentProfileEditModal(
        this.app,
        profile,
        async (saved) => {
          await this.manager.updateProfile(saved.id, saved);
          this.render();
        },
        async (id) => {
          await this.manager.deleteProfile(id);
          this.render();
        },
      ).open();
    });
  }

  private async handleImport(): Promise<void> {
    // Create a file input to read JSON
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const result = await this.manager.importProfiles(text);
        if (result.errors.length > 0) {
          new Notice(`Import errors:\n${result.errors.join("\n")}`);
        }
        if (result.imported > 0) {
          new Notice(`Imported ${result.imported} profile(s)`);
          this.render();
        }
      } catch (err) {
        new Notice(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    input.click();
  }

  private handleExport(): void {
    const json = this.manager.exportProfiles();
    const profiles = this.manager.getProfiles();
    if (profiles.length === 0) {
      new Notice("No profiles to export");
      return;
    }

    // Copy to clipboard and notify
    navigator.clipboard
      .writeText(json)
      .then(() => {
        new Notice(`${profiles.length} profile(s) copied to clipboard as JSON`);
      })
      .catch(() => {
        // Fallback: write to a file
        try {
          const fs = electronRequire("fs") as typeof import("fs");
          const path = electronRequire("path") as typeof import("path");
          const os = electronRequire("os") as typeof import("os");
          const filePath = path.join(os.tmpdir(), "work-terminal-profiles.json");
          fs.writeFileSync(filePath, json, "utf-8");
          new Notice(`Profiles exported to ${filePath}`);
        } catch {
          new Notice("Could not export profiles. Check console for details.");
          console.error("[work-terminal] Export failed, JSON:", json);
        }
      });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
