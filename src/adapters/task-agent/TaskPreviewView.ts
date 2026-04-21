import { Component, MarkdownRenderer, TFile, type App, type EventRef } from "obsidian";
import type { WorkItem } from "../../core/interfaces";
import { VIEW_TYPE } from "../../framework/PluginBase";
import { findNavigateTargetLeaf } from "../../core/workspace/findNavigateTargetLeaf";

/**
 * Read-only preview of a task file rendered inline inside the Work Terminal
 * panel. Implements the `preview` detail-view placement from #480.
 *
 * The preview lives as an overlay `div` layered on top of the terminal
 * wrapper element. When active it fully covers the tab content - the
 * terminal is still mounted underneath but is hidden from view. Clicking
 * "Open in editor" opens the file in a workspace leaf via the same
 * target-leaf resolution the `navigate` placement uses, but leaves the
 * preview overlay in place. The preview is only dismissed when the user
 * changes the detail-view placement setting away from `preview`, which is
 * handled by `TaskDetailView` calling `detach()`.
 *
 * Rendering uses `MarkdownRenderer.render` (public Obsidian API). A vault
 * `modify` listener re-renders the preview when the currently-displayed
 * file changes so the user sees live updates without switching placement.
 */
export class TaskPreviewView {
  private overlayEl: HTMLElement | null = null;
  private contentEl: HTMLElement | null = null;
  private openInEditorBtn: HTMLButtonElement | null = null;
  private renderComponent: Component | null = null;
  private currentPath: string | null = null;
  private modifyRef: EventRef | null = null;
  // Monotonic render sequence so out-of-order async renders (caused by a
  // rapid selection change) cannot overwrite the content of a newer render.
  private renderSeq = 0;

  constructor(private app: App) {}

  /**
   * Show the preview for the given work item. Creates the overlay on first
   * call and reuses it thereafter. The `hostEl` is the container we attach
   * the overlay to - typically the terminal wrapper inside the Work Terminal
   * panel so the preview visually occupies the same region as the tabs.
   */
  async show(item: WorkItem, hostEl: HTMLElement): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(item.path);
    if (!(file instanceof TFile)) return;

    this.ensureOverlay(hostEl);
    this.currentPath = item.path;
    this.ensureModifyListener();

    await this.renderFile(file);
  }

  /**
   * Hide and dispose the overlay. Safe to call when no overlay is currently
   * mounted. Clears the modify listener and the render component so we do
   * not leak event refs across placement switches.
   */
  detach(): void {
    if (this.modifyRef) {
      this.app.vault.offref(this.modifyRef);
      this.modifyRef = null;
    }
    if (this.renderComponent) {
      this.renderComponent.unload();
      this.renderComponent = null;
    }
    if (this.overlayEl) {
      this.overlayEl.remove();
      this.overlayEl = null;
    }
    this.contentEl = null;
    this.openInEditorBtn = null;
    this.currentPath = null;
  }

  /** Update the tracked path when the file is renamed externally. */
  rekeyPath(oldPath: string, newPath: string): void {
    if (this.currentPath === oldPath) {
      this.currentPath = newPath;
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private ensureOverlay(hostEl: HTMLElement): void {
    // If the overlay was attached to a different host (e.g. the user closed
    // and reopened the Work Terminal view so the DOM was rebuilt) fully tear
    // down the previous overlay before recreating it. `detach()` removes the
    // DOM, unloads the render component (releasing any rendered embed
    // children), and unregisters the vault `modify` listener - without this
    // we would leak rendered components and leave a listener running with
    // nothing mounted.
    if (this.overlayEl && this.overlayEl.parentElement !== hostEl) {
      this.detach();
    }
    if (this.overlayEl) return;

    const overlay = hostEl.createDiv({ cls: "wt-preview-overlay" });
    const toolbar = overlay.createDiv({ cls: "wt-preview-toolbar" });
    const title = toolbar.createDiv({ cls: "wt-preview-title", text: "Preview" });
    title.setAttr("aria-hidden", "true");
    const openBtn = toolbar.createEl("button", {
      cls: "wt-preview-open-btn",
      text: "Open in editor",
    });
    openBtn.setAttr("aria-label", "Open task file in editor");
    openBtn.addEventListener("click", () => {
      void this.openInEditor();
    });

    const content = overlay.createDiv({ cls: "wt-preview-content markdown-preview-view" });

    this.overlayEl = overlay;
    this.openInEditorBtn = openBtn;
    this.contentEl = content;
  }

  private ensureModifyListener(): void {
    if (this.modifyRef) return;
    this.modifyRef = this.app.vault.on("modify", (file) => {
      // Only re-render when the currently-visible file changes.
      if (!this.currentPath || file.path !== this.currentPath) return;
      if (!(file instanceof TFile)) return;
      void this.renderFile(file);
    });
  }

  private async renderFile(file: TFile): Promise<void> {
    if (!this.contentEl) return;

    // Tear down the previous component so its rendered children (embeds,
    // etc.) unload cleanly before we render the next document.
    if (this.renderComponent) {
      this.renderComponent.unload();
      this.renderComponent = null;
    }

    const seq = ++this.renderSeq;
    const component = new Component();
    component.load();
    this.renderComponent = component;

    let markdown: string;
    try {
      markdown = await this.app.vault.cachedRead(file);
    } catch (err) {
      console.error(`[work-terminal] Failed to read task file for preview: ${file.path}`, err);
      return;
    }

    // Bail if a newer render started while we were awaiting the read. The
    // newer render will have already reassigned `renderComponent`.
    if (seq !== this.renderSeq) return;
    if (!this.contentEl) return;

    this.contentEl.empty();
    await MarkdownRenderer.render(this.app, markdown, this.contentEl, file.path, component);
  }

  private async openInEditor(): Promise<void> {
    if (!this.currentPath) return;
    const file = this.app.vault.getAbstractFileByPath(this.currentPath);
    if (!(file instanceof TFile)) return;

    // Reuse the same resolution the `navigate` placement uses: find the
    // most recent non-WorkTerminal editor leaf, fall back to a fresh tab.
    let targetLeaf = findNavigateTargetLeaf(this.app, VIEW_TYPE);
    if (!targetLeaf) {
      targetLeaf = this.app.workspace.getLeaf("tab");
    }
    if (!targetLeaf) return;
    await targetLeaf.openFile(file);
  }
}
