import type { App, TFile, WorkspaceLeaf } from "obsidian";
import type { WorkItem } from "../../core/interfaces";
import { DETAIL_VIEW_DEFAULTS, type DetailViewOptions } from "../../core/detailViewPlacement";
import { VIEW_TYPE } from "../../framework/PluginBase";
import { findNavigateTargetLeaf } from "../../core/workspace/findNavigateTargetLeaf";
import { TaskPreviewView } from "./TaskPreviewView";

export class TaskDetailView {
  private editorLeaf: WorkspaceLeaf | null = null;
  private _showInProgress = false;
  // Track whether we created the leaf (true) or adopted an existing one (false).
  // We only detach leaves we created - adopted leaves belong to the user.
  private leafIsOwned = false;
  // Paths we've opened - used to identify leaves safe to adopt (they're showing
  // a file we put there, not something the user or another plugin opened).
  private openedPaths = new Set<string>();
  // Containers whose flex styles we modified via applyMinEditorWidth. We track
  // them so we can restore them when the width override is turned off.
  private widthOverrideContainers: HTMLElement[] = [];
  // Tracks whether the width override is currently enabled. Checked inside
  // applyMinEditorWidth() so a deferred timeout can't re-apply styles after
  // the setting has been turned off or placement has switched away from split.
  private widthOverrideActive = false;
  // Pending timeout handle for applyMinEditorWidth. Cleared when placement
  // changes or width override is disabled to prevent races.
  private applyWidthTimer: ReturnType<typeof setTimeout> | null = null;
  // Identifier of the last item we opened a detail view for. Used by the
  // auto-close behaviour to detach the previous leaf when the selection moves
  // to a different item.
  private lastItemId: string | null = null;
  // Lazily-initialised preview overlay used by the `preview` placement. A
  // single instance is reused across show() calls; detached (and nulled)
  // when placement switches away from preview so its DOM and modify listener
  // are released.
  private previewView: TaskPreviewView | null = null;

  constructor(private app: App) {}

  async show(
    item: WorkItem,
    ownerLeaf: WorkspaceLeaf,
    options: DetailViewOptions = DETAIL_VIEW_DEFAULTS,
    previewHost?: HTMLElement | null,
  ): Promise<void> {
    // Any non-split placement must clear the split width override so stale
    // inline flex styles from a previous split don't persist after the user
    // switches placement. Runs before early returns for "disabled" etc.
    if (options.placement !== "split") {
      this.clearWidthOverride();
    }

    // Switching away from preview: dispose the overlay so the terminal area
    // is visible again and the modify listener is released. Runs before the
    // "disabled" short-circuit so disabling the detail view still cleans up
    // a previously-active preview overlay.
    if (options.placement !== "preview" && this.previewView) {
      this.previewView.detach();
      this.previewView = null;
    }

    // "Disabled" short-circuits: no leaf creation, no file open. Respect the
    // user's current workspace arrangement entirely.
    if (options.placement === "disabled") {
      return;
    }

    if (options.placement === "preview") {
      // Tear down any leaf we own from a previous split/tab placement so it
      // doesn't linger in the workspace while the preview tab is showing.
      this.detachLeaf();
      // Auto-close: when the selection moves to a different item with
      // autoClose enabled, detach the preview so show() remounts fresh for
      // the new item. Mirrors the leaf/embedded auto-close pattern.
      if (options.autoClose && this.lastItemId && this.lastItemId !== item.id && this.previewView) {
        this.previewView.detach();
        this.previewView = null;
      }
      this.lastItemId = item.id;
      // Prefer the framework-supplied host (the sibling preview slot owned
      // by TerminalPanelView). Fall back to the legacy wrapper query when
      // the framework does not supply one - keeps older callers working.
      const hostEl = previewHost ?? this.resolvePreviewHost(ownerLeaf);
      if (!hostEl) return;
      if (!this.previewView) {
        this.previewView = new TaskPreviewView(this.app);
      }
      await this.previewView.show(item, hostEl);
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(item.path) as TFile;
    if (!file) return;

    // Guard against re-entrant calls (e.g. rapid selection changes)
    if (this._showInProgress) return;
    this._showInProgress = true;
    try {
      // Auto-close: when the selection moves to a different item, detach the
      // previously-opened leaf so the detail view always opens fresh at the
      // current placement target. Re-selecting the same item keeps the leaf.
      if (options.autoClose && this.lastItemId && this.lastItemId !== item.id) {
        this.detachLeaf();
      }
      this.lastItemId = item.id;

      if (options.placement === "navigate") {
        // The click target is inside the Work Terminal ItemView, so a naive
        // `getLeaf(false)` returns the Work Terminal leaf and `openFile`
        // replaces the entire workspace with the task file (#457). Find the
        // most recent editor leaf that is NOT Work Terminal; fall back to a
        // fresh tab if none exists.

        // Clean up any leaf we own from a previous placement (split/tab) so
        // it doesn't linger in the workspace. Doing this before opening the
        // file also means `this.editorLeaf`/`this.leafIsOwned` are cleared,
        // so a later switch back to split/tab won't short-circuit in
        // `ensureEditorLeaf`/`ensureTabLeaf` and try to reuse the user leaf
        // we're about to open the task file in.
        this.detachLeaf();

        let targetLeaf = findNavigateTargetLeaf(this.app, VIEW_TYPE);
        if (!targetLeaf) {
          targetLeaf = this.app.workspace.getLeaf("tab");
        }
        if (!targetLeaf) return;
        // Deliberately do NOT assign `this.editorLeaf` / `this.leafIsOwned`
        // here: the target is a user leaf we've adopted for this single
        // openFile call. Tracking it would let a subsequent split/tab
        // placement short-circuit its ensureXxxLeaf() check and overwrite
        // the user's leaf content. Also don't add the path to `openedPaths`.
        await targetLeaf.openFile(file);
        return;
      }

      if (options.placement === "tab") {
        // Create a new tab in the active tab group. No splitting; no width
        // override. If the file is already open in a tab we own we reuse it,
        // matching the split-mode adoption behaviour.
        this.ensureTabLeaf();
        if (this.editorLeaf) {
          await this.editorLeaf.openFile(file);
          this.openedPaths.add(item.path);
          const tabGroup = (this.editorLeaf as any).parent;
          if (tabGroup?.selectTab) {
            tabGroup.selectTab(this.editorLeaf);
          }
        }
        return;
      }

      // Default: "split" - preserve the original behaviour, with configurable
      // direction and an optional width override.
      this.ensureEditorLeaf(ownerLeaf, options.splitDirection);

      if (this.editorLeaf) {
        await this.editorLeaf.openFile(file);
        this.openedPaths.add(item.path);

        // If our leaf is a background tab, activate it so the user sees it
        const tabGroup = (this.editorLeaf as any).parent;
        if (tabGroup?.selectTab) {
          tabGroup.selectTab(this.editorLeaf);
        }

        if (options.widthOverride) {
          // Mark the override as active and schedule application once
          // Obsidian's layout pass settles. The flag is also checked inside
          // applyMinEditorWidth so a stale timer can't re-apply styles after
          // the setting has flipped off or placement has changed.
          this.widthOverrideActive = true;
          this.scheduleApplyMinEditorWidth();
        } else {
          // The override may have been applied in a previous show() call.
          // Clear any inline styles we set so Obsidian's flex layout takes over.
          this.clearWidthOverride();
        }
      }
    } finally {
      this._showInProgress = false;
    }
  }

  /**
   * Ensure we have an editor leaf to render the detail view into, for the
   * "split" placement. Prefers reusing an owned leaf or an existing editor
   * leaf in a sibling tab group; falls back to creating a fresh split.
   */
  private ensureEditorLeaf(
    ownerLeaf: WorkspaceLeaf,
    splitDirection: "vertical" | "horizontal",
  ): void {
    // Check if our managed leaf is still attached to the workspace.
    // Uses parent reference instead of getLeavesOfType("markdown") because
    // a freshly-split leaf starts as type "empty" before openFile completes.
    if (this.editorLeaf) {
      const parent = (this.editorLeaf as any).parent;
      if (!parent) {
        this.editorLeaf = null;
        this.leafIsOwned = false;
      }
    }

    if (this.editorLeaf) return;

    // Two-tier search:
    // 1. Look for a leaf we own (showing a file we previously opened) - adopt it
    // 2. If not found, look for the rightmost editor leaf as a location hint -
    //    add a new tab in its tab group rather than replacing its content
    const { ownedLeaf, locationLeaf } = this.findEditorLeaves();

    if (ownedLeaf) {
      this.editorLeaf = ownedLeaf;
      this.leafIsOwned = false;
      return;
    }

    if (locationLeaf) {
      // Found a rightmost editor leaf we don't own - create a new tab beside it
      // in the same tab group, preserving the existing tab's content
      const tabGroup = (locationLeaf as any).parent;
      if (tabGroup) {
        this.leafIsOwned = true;
        this.editorLeaf = (this.app.workspace as any).createLeafInParent(tabGroup, -1);
        return;
      }
    }

    // No editor leaves at all - create a new split off our owner leaf
    this.leafIsOwned = true;
    this.editorLeaf = this.app.workspace.createLeafBySplit(ownerLeaf, splitDirection, false);
  }

  /**
   * Schedule a deferred width override application once Obsidian's layout
   * pass has settled. Any pending timer is cleared first so rapid placement
   * changes can't stack or race.
   */
  private scheduleApplyMinEditorWidth(): void {
    if (this.applyWidthTimer !== null) {
      clearTimeout(this.applyWidthTimer);
    }
    this.applyWidthTimer = setTimeout(() => {
      this.applyWidthTimer = null;
      this.applyMinEditorWidth();
    }, 100);
  }

  /**
   * Ensure we have a leaf to render the detail view into for the "tab"
   * placement. Prefers the currently-managed leaf if still attached; falls
   * back to a fresh tab in the active tab group via `getLeaf("tab")`.
   *
   * Deliberately does NOT scan the workspace for arbitrary owned leaves -
   * doing so can adopt a leaf that lives in a different tab group than the
   * active one, which would violate the documented "open in the active tab
   * group" semantics of this placement.
   */
  private ensureTabLeaf(): void {
    // Reuse our managed leaf if still attached
    if (this.editorLeaf) {
      const parent = (this.editorLeaf as any).parent;
      if (!parent) {
        this.editorLeaf = null;
        this.leafIsOwned = false;
      }
    }
    if (this.editorLeaf) return;

    // Open a fresh tab in the currently active tab group.
    this.leafIsOwned = true;
    this.editorLeaf = this.app.workspace.getLeaf("tab");
  }

  /**
   * Scan the workspace for editor leaves, returning two results:
   * - ownedLeaf: a leaf showing a file we previously opened (safe to reuse directly)
   * - locationLeaf: the rightmost editor/empty leaf (use as placement hint for a new tab)
   */
  private findEditorLeaves(): {
    ownedLeaf: WorkspaceLeaf | null;
    locationLeaf: WorkspaceLeaf | null;
  } {
    const rootSplit = this.app.workspace.rootSplit;
    if (!rootSplit) return { ownedLeaf: null, locationLeaf: null };

    const leaves: WorkspaceLeaf[] = [];
    this.collectLeaves(rootSplit, leaves);

    let ownedLeaf: WorkspaceLeaf | null = null;
    let locationLeaf: WorkspaceLeaf | null = null;

    // Walk right-to-left
    for (let i = leaves.length - 1; i >= 0; i--) {
      const leaf = leaves[i];
      const viewType = leaf.view?.getViewType();

      if (viewType === "markdown") {
        const filePath = (leaf.view as any)?.file?.path;
        // First matching owned leaf wins
        if (!ownedLeaf && filePath && this.openedPaths.has(filePath)) {
          ownedLeaf = leaf;
        }
        // First editor leaf (rightmost) is the location hint
        if (!locationLeaf) {
          locationLeaf = leaf;
        }
      } else if (viewType === "empty" && !locationLeaf) {
        locationLeaf = leaf;
      }

      // Found both - done
      if (ownedLeaf && locationLeaf) break;
    }

    return { ownedLeaf, locationLeaf };
  }

  /** Recursively collect all leaves from a workspace split in document order. */
  private collectLeaves(node: any, result: WorkspaceLeaf[]): void {
    if (node.children) {
      for (const child of node.children) {
        this.collectLeaves(child, result);
      }
    } else if (node.view) {
      result.push(node as WorkspaceLeaf);
    }
  }

  private applyMinEditorWidth(): void {
    // Defensive check - a stale timer may fire after the override was turned
    // off or placement changed. Don't write inline styles unless the override
    // is still the active configuration.
    if (!this.widthOverrideActive) return;
    if (!this.editorLeaf) return;

    // createLeafBySplit wraps each side in its own split container,
    // so the two siblings we need to resize live one level higher
    const editorSplit = (this.editorLeaf as any).parent;
    const rootSplit = editorSplit?.parent;
    if (!rootSplit?.children || rootSplit.children.length < 2) return;

    const editorIdx = rootSplit.children.indexOf(editorSplit);
    if (editorIdx === -1) return;
    const ttIdx = editorIdx === 0 ? 1 : 0;

    const editorChild = rootSplit.children[editorIdx];
    const ttChild = rootSplit.children[ttIdx];

    // Read Obsidian's readable line width from CSS variable, fallback 700px
    const rootStyle = getComputedStyle(document.body);
    const lineWidthRaw = rootStyle.getPropertyValue("--file-line-width").trim();
    const lineWidth = parseInt(lineWidthRaw, 10) || 700;
    const editorWidth = lineWidth + 80;

    // Editor split: fixed width, no grow
    if (editorChild?.containerEl) {
      editorChild.containerEl.style.flexGrow = "0";
      editorChild.containerEl.style.flexShrink = "0";
      editorChild.containerEl.style.flexBasis = `${editorWidth}px`;
      this.widthOverrideContainers.push(editorChild.containerEl);
    }
    // Terminal split: fill remaining space
    if (ttChild?.containerEl) {
      ttChild.containerEl.style.flexGrow = "1";
      ttChild.containerEl.style.flexShrink = "1";
      ttChild.containerEl.style.flexBasis = "0%";
      this.widthOverrideContainers.push(ttChild.containerEl);
    }
  }

  /**
   * Restore the flex styles on any containers we previously modified via
   * applyMinEditorWidth(). Called when the width override setting is turned
   * off so Obsidian's default flex layout resumes controlling the split.
   */
  private clearWidthOverride(): void {
    // Mark inactive first so any in-flight timer becomes a no-op.
    this.widthOverrideActive = false;
    if (this.applyWidthTimer !== null) {
      clearTimeout(this.applyWidthTimer);
      this.applyWidthTimer = null;
    }
    for (const el of this.widthOverrideContainers) {
      el.style.flexGrow = "";
      el.style.flexShrink = "";
      el.style.flexBasis = "";
    }
    this.widthOverrideContainers = [];
  }

  rekeyPath(oldPath: string, newPath: string): void {
    if (this.openedPaths.delete(oldPath)) {
      this.openedPaths.add(newPath);
    }
    this.previewView?.rekeyPath(oldPath, newPath);
  }

  /**
   * Resolve the host element the preview overlay should attach to. Prefers
   * the terminal wrapper inside the Work Terminal view so the overlay
   * visually occupies the same region as the tab content. Falls back to
   * the view's container element when the wrapper cannot be found.
   */
  private resolvePreviewHost(ownerLeaf: WorkspaceLeaf): HTMLElement | null {
    const containerEl = (ownerLeaf.view as { containerEl?: HTMLElement } | undefined)?.containerEl;
    if (!containerEl) return null;
    const wrapper = containerEl.querySelector<HTMLElement>(".wt-terminal-wrapper");
    return wrapper ?? containerEl;
  }

  /**
   * Detach the managed leaf (if we own it) and clear width override styles.
   * Leaves the `openedPaths` set intact so future adoption still works.
   * Used by auto-close and `detach()`.
   */
  private detachLeaf(): void {
    if (this.editorLeaf) {
      if (this.leafIsOwned) {
        this.editorLeaf.detach();
      }
      this.editorLeaf = null;
      this.leafIsOwned = false;
    }
    this.clearWidthOverride();
  }

  detach(): void {
    this.detachLeaf();
    if (this.previewView) {
      this.previewView.detach();
      this.previewView = null;
    }
    this.lastItemId = null;
  }
}
