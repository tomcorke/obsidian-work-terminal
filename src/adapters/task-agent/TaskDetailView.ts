import type { App, TFile, WorkspaceLeaf } from "obsidian";
import type { WorkItem } from "../../core/interfaces";

export class TaskDetailView {
  private editorLeaf: WorkspaceLeaf | null = null;

  constructor(private app: App) {}

  async show(item: WorkItem, ownerLeaf: WorkspaceLeaf): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(item.path) as TFile;
    if (!file) return;

    await this.ensureEditorLeaf(ownerLeaf);

    if (this.editorLeaf) {
      await this.editorLeaf.openFile(file);
    }
  }

  private async ensureEditorLeaf(ownerLeaf: WorkspaceLeaf): Promise<void> {
    // Check if our leaf is still alive
    if (this.editorLeaf) {
      const found = this.app.workspace
        .getLeavesOfType("markdown")
        .some((l) => l === this.editorLeaf);
      if (!found) {
        this.editorLeaf = null;
      }
    }

    if (this.editorLeaf) return;

    // Create a new leaf by splitting the MainView's leaf
    this.editorLeaf = this.app.workspace.createLeafBySplit(
      ownerLeaf,
      "vertical",
      false
    );

    // Defer width application to let Obsidian's layout pass complete
    setTimeout(() => this.applyMinEditorWidth(), 100);
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

  detach(): void {
    if (this.editorLeaf) {
      this.editorLeaf.detach();
      this.editorLeaf = null;
    }
  }
}
