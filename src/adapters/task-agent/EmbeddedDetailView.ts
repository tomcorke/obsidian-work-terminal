/**
 * EmbeddedDetailView - EXPERIMENTAL.
 *
 * Renders the task detail MarkdownView inside a caller-provided host element
 * (a DOM slot owned by TerminalPanelView) by reparenting a hidden workspace
 * leaf's `contentEl` into the host. This gives us full MarkdownView
 * functionality - live preview, frontmatter editor, backlinks - without
 * requiring a dedicated workspace leaf.
 *
 * This relies on two undocumented / internal Obsidian behaviours:
 *   1. `workspace.getLeaf("window")` returns a leaf whose root element is
 *      detached from the workspace split. We keep the leaf alive but move
 *      its content element into our own host.
 *   2. MarkdownView renders into `leaf.view.contentEl`. Reparenting that
 *      element preserves its internal editor state because CodeMirror is
 *      content-agnostic about its mount location.
 *
 * Both may break across Obsidian versions. The placement is marked
 * experimental in settings to set expectations accordingly.
 */
import type { App, TFile, WorkspaceLeaf } from "obsidian";

export class EmbeddedDetailView {
  private leaf: WorkspaceLeaf | null = null;
  private reparentedEl: HTMLElement | null = null;
  private host: HTMLElement | null = null;
  private originalParent: HTMLElement | null = null;
  private currentPath: string | null = null;

  constructor(private app: App) {}

  /**
   * Open (or update) the embedded detail view for a file, mounting its
   * MarkdownView content into the supplied host element.
   */
  async show(path: string, host: HTMLElement): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path) as TFile | null;
    if (!file) return;

    // Host changed (MainView re-rendered / panel was recreated): fully reset
    // so we mount cleanly into the new host element.
    if (this.host && this.host !== host) {
      this.detach();
    }

    if (!this.leaf) {
      // "window" leaves are created detached from the workspace split which
      // lets us reparent their content element without Obsidian fighting us
      // for layout. We never actually pop it out into a window - we reparent
      // immediately.
      const createLeaf = (
        this.app.workspace as unknown as {
          getLeaf: (how: "window" | "tab" | "split" | boolean) => WorkspaceLeaf;
        }
      ).getLeaf;
      this.leaf = createLeaf.call(this.app.workspace, "window");
      if (!this.leaf) return;
    }

    await this.leaf.openFile(file);
    this.currentPath = path;

    const view = this.leaf.view as unknown as { contentEl?: HTMLElement } | null;
    const contentEl = view?.contentEl;
    if (!contentEl) return;

    if (!this.reparentedEl || this.reparentedEl !== contentEl) {
      // First mount, or the MarkdownView swapped out contentEl.
      this.originalParent = contentEl.parentElement;
      host.empty();
      host.appendChild(contentEl);
      this.reparentedEl = contentEl;
      this.host = host;
      host.addClass("wt-embedded-detail-active");
    }
  }

  /**
   * Update tracking for a renamed file so a subsequent `show()` on the new
   * path does not flash-close the view when the same file was in-place.
   */
  rekeyPath(oldPath: string, newPath: string): void {
    if (this.currentPath === oldPath) {
      this.currentPath = newPath;
    }
  }

  /**
   * Tear down: restore the content element to its original parent (so
   * Obsidian can safely close the hidden leaf) and detach the leaf.
   */
  detach(): void {
    if (this.reparentedEl && this.originalParent) {
      try {
        this.originalParent.appendChild(this.reparentedEl);
      } catch {
        // If the original parent is gone (e.g. the hidden leaf was already
        // collected), let the element be garbage collected - the leaf detach
        // below will clean up the rest.
      }
    }
    if (this.host) {
      this.host.removeClass("wt-embedded-detail-active");
      this.host.empty();
    }
    if (this.leaf) {
      try {
        this.leaf.detach();
      } catch (err) {
        console.warn("[work-terminal] EmbeddedDetailView: leaf detach failed", err);
      }
    }
    this.leaf = null;
    this.reparentedEl = null;
    this.originalParent = null;
    this.host = null;
    this.currentPath = null;
  }
}
