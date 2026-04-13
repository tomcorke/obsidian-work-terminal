import type { App, TFile } from "obsidian";
import type { StateResolver } from "../interfaces";

/**
 * Resolves state from the file's folder location within the base path.
 * Applies state changes by moving the file to the corresponding folder.
 *
 * This is the default resolver and preserves the original behavior where
 * folder names map directly to states (e.g. `priority/`, `todo/`, `active/`,
 * `archive/` -> done).
 */
export class FolderStateResolver implements StateResolver {
  /**
   * Maps state IDs to folder names. The folder name is the directory
   * within the base path where items in that state are stored.
   * Example: { priority: "priority", todo: "todo", active: "active", done: "archive" }
   */
  private stateToFolder: Record<string, string>;
  /**
   * Reverse map: folder name -> state ID.
   * Example: { priority: "priority", todo: "todo", active: "active", archive: "done" }
   */
  private folderToState: Record<string, string>;
  /**
   * Base path for resolving relative folder positions. Set at construction
   * time so resolveState() doesn't need extra parameters.
   */
  private basePath: string;

  constructor(stateToFolder: Record<string, string>, basePath = "") {
    this.stateToFolder = stateToFolder;
    this.basePath = basePath.replace(/\/+$/, "");
    this.folderToState = {};
    for (const [state, folder] of Object.entries(stateToFolder)) {
      this.folderToState[folder] = state;
    }
  }

  /** Update the base path after construction (e.g. when settings change). */
  setBasePath(basePath: string): void {
    this.basePath = basePath.replace(/\/+$/, "");
  }

  resolveState(filePath: string, _frontmatter: Record<string, unknown> | undefined): string | null {
    // Extract the first folder segment relative to basePath
    const prefix = this.basePath ? `${this.basePath}/` : "";
    const relativePath =
      prefix && filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath;
    const folder = relativePath.split("/")[0];
    return this.folderToState[folder] ?? null;
  }

  async applyState(
    app: App,
    file: TFile,
    newState: string,
    _oldState: string,
    basePath: string,
  ): Promise<boolean> {
    const targetFolder = this.stateToFolder[newState];
    if (!targetFolder) return false;

    const newFolderPath = `${basePath}/${targetFolder}`;
    const newPath = `${newFolderPath}/${file.name}`;

    if (file.path === newPath) return true;

    // Ensure target folder exists
    const folder = app.vault.getAbstractFileByPath(newFolderPath);
    if (!folder) {
      await app.vault.createFolder(newFolderPath);
    }
    await app.vault.rename(file, newPath);
    return true;
  }

  getFolderForState(state: string): string | null {
    return this.stateToFolder[state] ?? null;
  }

  getValidStates(): string[] {
    return Object.keys(this.stateToFolder);
  }
}
