import type { App, TFile } from "obsidian";
import type { WorkItemMover, StateResolver } from "../../core/interfaces";
import { yamlQuoteValue } from "../../core/utils";
import { type KanbanColumn, STATE_FOLDER_MAP } from "./types";

export class TaskMover implements WorkItemMover {
  private basePath: string;
  private stateResolver: StateResolver | null;

  constructor(
    private app: App,
    _basePath: string,
    private settings: Record<string, any>,
    stateResolver?: StateResolver,
  ) {
    this.basePath = this.settings["adapter.taskBasePath"] || "2 - Areas/Tasks";
    this.stateResolver = stateResolver ?? null;
  }

  async move(file: TFile, targetColumnId: string): Promise<boolean> {
    const newColumn = targetColumnId;

    try {
      const content = await this.app.vault.read(file);

      // Determine current state from frontmatter
      const stateMatch = content.match(/^state:\s*(.+)$/m);
      const oldState = stateMatch ? stateMatch[1].trim() : "todo";

      if (oldState === newColumn) return true;

      let updated = content;

      // Quote the state value to handle YAML-sensitive characters
      const safeState = yamlQuoteValue(newColumn);

      // Update state field (or insert it if missing)
      if (/^state:\s*.+$/m.test(updated)) {
        updated = updated.replace(/^state:\s*.+$/m, `state: ${safeState}`);
      } else {
        // Insert state field into frontmatter
        const fmMatch = updated.match(/^(---\r?\n)([\s\S]*?)(^---(?:\r?\n|$))/m);
        if (fmMatch) {
          const [fullMatch, openFence, body, closeFence] = fmMatch;
          const eol = openFence.endsWith("\r\n") ? "\r\n" : "\n";
          const trimmedBody = body.endsWith(eol) ? body : body + eol;
          updated = updated.replace(
            fullMatch,
            `${openFence}${trimmedBody}state: ${safeState}${eol}${closeFence}`,
          );
        }
      }

      // Update task tag - match both known and dynamic state values.
      // Tags are YAML list items where the value follows "task/", so special
      // characters in the state need the whole tag value quoted.
      const rawTag = `task/${newColumn}`;
      const safeTagEntry = yamlQuoteValue(rawTag);
      const oldTagPattern = new RegExp(
        `- (?:task/)(?:priority|todo|active|done|abandoned|${this.escapeRegex(oldState)})`,
        "m",
      );
      updated = updated.replace(oldTagPattern, `- ${safeTagEntry}`);

      // Update the updated timestamp (no milliseconds)
      const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      updated = updated.replace(/^updated:\s*.+$/m, `updated: ${now}`);

      // Intentionally do not append automatic activity-log entries here.
      // Routine board moves should update state metadata without adding note noise.

      // Write updated content first (write-then-move pattern)
      await this.app.vault.modify(file, updated);

      // Apply the state transition (file move or other mechanism).
      // For dynamic states without folder mappings, the resolver's applyState
      // handles updating frontmatter (already done above) and may skip the
      // folder move. The FolderStateResolver returns false for unknown states,
      // which is fine - the frontmatter update above is sufficient.
      if (this.stateResolver) {
        // Only attempt applyState if the resolver has a folder mapping for this state.
        // For dynamic states (no folder mapping), frontmatter is already updated above.
        const folder = this.stateResolver.getFolderForState?.(newColumn);
        const hasFolder = folder !== null && folder !== undefined;
        if (hasFolder) {
          const stateApplied = await this.stateResolver.applyState(
            this.app,
            file,
            newColumn,
            oldState,
            this.basePath,
          );
          if (!stateApplied) {
            return false;
          }
        }
      } else {
        // Legacy fallback: direct folder move using STATE_FOLDER_MAP
        const targetFolder = STATE_FOLDER_MAP[newColumn as KanbanColumn];
        if (targetFolder) {
          const newFolderPath = `${this.basePath}/${targetFolder}`;
          const newPath = `${newFolderPath}/${file.name}`;

          if (file.path !== newPath) {
            const folder = this.app.vault.getAbstractFileByPath(newFolderPath);
            if (!folder) {
              await this.app.vault.createFolder(newFolderPath);
            }
            await this.app.vault.rename(file, newPath);
          }
        }
      }

      return true;
    } catch (err) {
      console.error("[work-terminal] TaskMover.move failed:", err);
      return false;
    }
  }

  private escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}
