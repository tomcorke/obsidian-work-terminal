import type { App, TFile } from "obsidian";
import type { StateResolver } from "../interfaces";

/**
 * Resolves state from a frontmatter field. Applies state changes by
 * updating the frontmatter field in the file content.
 *
 * This resolver does not move files - state is purely metadata-driven.
 * Use CompositeStateResolver to combine with folder moves.
 */
export class FrontmatterStateResolver implements StateResolver {
  private fieldName: string;
  private validStates: string[];

  /**
   * @param fieldName - The frontmatter field to read/write (default: "state")
   * @param validStates - List of valid state values. If empty, any string value is accepted.
   */
  constructor(fieldName = "state", validStates: string[] = []) {
    this.fieldName = fieldName;
    this.validStates = validStates;
  }

  resolveState(_filePath: string, frontmatter: Record<string, unknown> | undefined): string | null {
    if (!frontmatter) return null;
    const value = frontmatter[this.fieldName];
    if (typeof value !== "string" || !value.trim()) return null;
    const state = value.trim();
    if (this.validStates.length > 0 && !this.validStates.includes(state)) {
      return null;
    }
    return state;
  }

  async applyState(
    app: App,
    file: TFile,
    newState: string,
    _oldState: string,
    _basePath: string,
  ): Promise<boolean> {
    const content = await app.vault.read(file);
    const fieldPattern = new RegExp(`^${escapeRegex(this.fieldName)}:\\s*.+$`, "m");
    if (!fieldPattern.test(content)) return false;

    const updated = content.replace(fieldPattern, `${this.fieldName}: ${newState}`);
    await app.vault.modify(file, updated);
    return true;
  }

  getValidStates(): string[] {
    return [...this.validStates];
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
