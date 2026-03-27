import type { App, TFile } from "obsidian";
import type { WorkItemMover } from "../../core/interfaces";
import { type KanbanColumn, STATE_FOLDER_MAP } from "./types";

export class TaskMover implements WorkItemMover {
  private basePath: string;

  constructor(
    private app: App,
    _basePath: string,
    private settings: Record<string, any>,
  ) {
    this.basePath = this.settings["adapter.taskBasePath"] || "2 - Areas/Tasks";
  }

  async move(file: TFile, targetColumnId: string): Promise<boolean> {
    const newColumn = targetColumnId as KanbanColumn;
    const targetFolder = STATE_FOLDER_MAP[newColumn];
    if (!targetFolder) return false;

    try {
      const content = await this.app.vault.read(file);

      // Determine current state from frontmatter
      const stateMatch = content.match(/^state:\s*(.+)$/m);
      const oldState = stateMatch ? stateMatch[1].trim() : "todo";

      if (oldState === newColumn) return true;

      let updated = content;

      // Update state field
      updated = updated.replace(/^state:\s*.+$/m, `state: ${newColumn}`);

      // Update task tag
      const oldTagPattern = new RegExp(`(- task/)(?:priority|todo|active|done|abandoned)`, "m");
      updated = updated.replace(oldTagPattern, `$1${newColumn}`);

      // Update the updated timestamp (no milliseconds)
      const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      updated = updated.replace(/^updated:\s*.+$/m, `updated: ${now}`);

      // Append to activity log
      const dateStr = this.formatActivityDate(new Date());
      const logEntry = `- **${dateStr}** - Moved to ${newColumn} (via kanban board)`;

      const logIndex = updated.indexOf("## Activity Log");
      if (logIndex !== -1) {
        const afterLog = updated.substring(logIndex + "## Activity Log".length);
        const nextSection = afterLog.search(/\n## /);
        const insertPos =
          nextSection !== -1 ? logIndex + "## Activity Log".length + nextSection : updated.length;
        updated =
          updated.substring(0, insertPos).trimEnd() +
          "\n" +
          logEntry +
          "\n" +
          updated.substring(insertPos);
      } else {
        // Create Activity Log section if missing
        updated = updated.trimEnd() + "\n\n## Activity Log\n" + logEntry + "\n";
      }

      // Write updated content first (write-then-move pattern)
      await this.app.vault.modify(file, updated);

      // Move file to target folder
      const newFolderPath = `${this.basePath}/${targetFolder}`;
      const newPath = `${newFolderPath}/${file.name}`;

      if (file.path !== newPath) {
        // Ensure target folder exists
        const folder = this.app.vault.getAbstractFileByPath(newFolderPath);
        if (!folder) {
          await this.app.vault.createFolder(newFolderPath);
        }
        await this.app.vault.rename(file, newPath);
      }

      return true;
    } catch (err) {
      console.error("[work-terminal] TaskMover.move failed:", err);
      return false;
    }
  }

  private formatActivityDate(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    const h = String(date.getHours()).padStart(2, "0");
    const min = String(date.getMinutes()).padStart(2, "0");
    return `${y}-${m}-${d} ${h}:${min}`;
  }
}
