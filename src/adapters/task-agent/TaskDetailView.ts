import type { App, TFile, WorkspaceLeaf } from "obsidian";
import type { WorkItem } from "../../core/interfaces";

export class TaskDetailView {
  private editorLeaf: WorkspaceLeaf | null = null;
  private _showInProgress = false;
  // Track whether we created the leaf (true) or adopted an existing one (false).
  // We only detach leaves we created - adopted leaves belong to the user.
  private leafIsOwned = false;
  // Paths we've opened - used to identify leaves safe to adopt (they're showing
  // a file we put there, not something the user or another plugin opened).
  private openedPaths = new Set<string>();

  constructor(private app: App) {}

  async show(item: WorkItem, ownerLeaf: WorkspaceLeaf): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(item.path) as TFile;
    if (!file) return;

    // Guard against re-entrant calls (e.g. rapid selection changes)
    if (this._showInProgress) return;
    this._showInProgress = true;
    try {
      this.ensureEditorLeaf(ownerLeaf);

      if (this.editorLeaf) {
        await this.editorLeaf.openFile(file);
        this.openedPaths.add(item.path);

        // If our leaf is a background tab, activate it so the user sees it
        const tabGroup = (this.editorLeaf as any).parent;
        if (tabGroup?.selectTab) {
          tabGroup.selectTab(this.editorLeaf);
        }
      }
    } finally {
      this._showInProgress = false;
    }
  }

  private ensureEditorLeaf(ownerLeaf: WorkspaceLeaf): void {
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
        this.editorLeaf = (this.app.workspace as any).createLeafInParent(
          tabGroup,
          -1
        );
        return;
      }
    }

    // No editor leaves at all - create a new split off our owner leaf
    this.leafIsOwned = true;
    this.editorLeaf = this.app.workspace.createLeafBySplit(
      ownerLeaf,
      "vertical",
      false
    );

    // Defer width application to let Obsidian's layout pass complete
    setTimeout(() => this.applyMinEditorWidth(), 100);
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
    const lineWidthRaw = rootStyle
      .getPropertyValue("--file-line-width")
      .trim();
    const lineWidth = parseInt(lineWidthRaw, 10) || 700;
    const editorWidth = lineWidth + 80;

    // Editor split: fixed width, no grow
    if (editorChild?.containerEl) {
      editorChild.containerEl.style.flexGrow = "0";
      editorChild.containerEl.style.flexShrink = "0";
      editorChild.containerEl.style.flexBasis = `${editorWidth}px`;
    }
    // Terminal split: fill remaining space
    if (ttChild?.containerEl) {
      ttChild.containerEl.style.flexGrow = "1";
      ttChild.containerEl.style.flexShrink = "1";
      ttChild.containerEl.style.flexBasis = "0%";
    }
  }

  rekeyPath(oldPath: string, newPath: string): void {
    if (this.openedPaths.delete(oldPath)) {
      this.openedPaths.add(newPath);
    }
  }

  detach(): void {
    if (this.editorLeaf) {
      // Only detach leaves we created via split - leave adopted leaves intact
      if (this.leafIsOwned) {
        this.editorLeaf.detach();
      }
      this.editorLeaf = null;
      this.leafIsOwned = false;
    }
  }
}
