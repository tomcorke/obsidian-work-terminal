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
 *   1. A hidden off-screen workspace split hosts a leaf whose content
 *      element we reparent into our own host. The split is never added
 *      to the visible workspace layout.
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
  // Off-screen container for the hidden workspace split that hosts our
  // leaf. Kept alive for the lifetime of the view so Obsidian doesn't
  // garbage-collect the split or its children.
  private hiddenContainer: HTMLElement | null = null;

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
      // Create a leaf inside a hidden off-screen workspace split. This
      // avoids getLeaf("window") which spawns a visible pop-out
      // Electron BrowserWindow that lingers after reparenting.
      const ws = this.app.workspace as any;
      if (typeof ws.createLeafInParent !== "function") {
        console.warn(
          "[work-terminal] EmbeddedDetailView: workspace.createLeafInParent not available",
        );
        return;
      }
      // Build a hidden container that Obsidian's layout won't touch.
      this.hiddenContainer = document.createElement("div");
      this.hiddenContainer.style.cssText =
        "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;overflow:hidden;pointer-events:none;";
      document.body.appendChild(this.hiddenContainer);

      // Create a root-level split inside the hidden container. The
      // WorkspaceSplit constructor is on the workspace module; fall back
      // to duplicating the rootSplit's constructor if available.
      const SplitCtor = ws.rootSplit?.constructor;
      if (!SplitCtor) {
        console.warn(
          "[work-terminal] EmbeddedDetailView: cannot resolve WorkspaceSplit constructor",
        );
        this.hiddenContainer.remove();
        this.hiddenContainer = null;
        return;
      }
      const hiddenSplit = new SplitCtor(ws, "vertical");
      this.hiddenContainer.appendChild(hiddenSplit.containerEl);

      this.leaf = ws.createLeafInParent(hiddenSplit, 0);
      if (!this.leaf) {
        // Leaf creation failed - tear down the hidden container we
        // already attached so we don't leak DOM nodes (or the created
        // split) across repeated show() calls.
        console.warn("[work-terminal] EmbeddedDetailView: createLeafInParent returned no leaf");
        try {
          hiddenSplit.containerEl?.remove?.();
        } catch {
          // Best-effort cleanup; ignore if the split has no removable element.
        }
        this.hiddenContainer.remove();
        this.hiddenContainer = null;
        return;
      }
    }

    await this.leaf.openFile(file);

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
    if (this.hiddenContainer) {
      this.hiddenContainer.remove();
      this.hiddenContainer = null;
    }
    this.leaf = null;
    this.reparentedEl = null;
    this.originalParent = null;
    this.host = null;
  }
}
