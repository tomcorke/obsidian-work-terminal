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
    const updated = this.upsertFrontmatterField(content, newState);
    if (updated === null) return false;
    await app.vault.modify(file, updated);
    return true;
  }

  /**
   * Update or insert the field within frontmatter. Only touches content
   * inside the opening `--- ... ---` block. Returns null if there is no
   * frontmatter block at all (caller should decide how to handle).
   */
  private upsertFrontmatterField(content: string, newState: string): string | null {
    const fmMatch = content.match(/^(---\r?\n)([\s\S]*?)(^---(?:\r?\n|$))/m);
    if (!fmMatch) return null;

    const [fullMatch, openFence, body, closeFence] = fmMatch;
    const eol = openFence.endsWith("\r\n") ? "\r\n" : "\n";
    const fieldPattern = new RegExp(`^${escapeRegex(this.fieldName)}:\\s*.*$`, "m");

    let updatedBody: string;
    if (fieldPattern.test(body)) {
      // Field exists (even if blank like `state:`) - replace it
      updatedBody = body.replace(fieldPattern, `${this.fieldName}: ${newState}`);
    } else {
      // Field missing - append before closing fence
      const trimmedBody = body.endsWith(eol) ? body : body + eol;
      updatedBody = `${trimmedBody}${this.fieldName}: ${newState}${eol}`;
    }

    return content.replace(fullMatch, `${openFence}${updatedBody}${closeFence}`);
  }

  getValidStates(): string[] {
    return [...this.validStates];
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
