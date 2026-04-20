import type { App, WorkspaceLeaf } from "obsidian";

/**
 * Resolve a target leaf for the "navigate" detail view placement that is not
 * the Work Terminal view itself.
 *
 * Problem: the user triggers detail view by clicking a card inside the Work
 * Terminal ItemView, which makes Work Terminal the active leaf. A naive
 * `workspace.getLeaf(false)` then returns the Work Terminal leaf, and
 * `openFile` replaces the entire kanban + terminal workspace with a markdown
 * file.
 *
 * Strategy (most specific to most general):
 *   1. If the currently active leaf is not Work Terminal, use it. Handles the
 *      case where the user tabbed focus to another leaf and is using Work
 *      Terminal in a split.
 *   2. Otherwise, search the active leaf's tab group for a non-Work-Terminal
 *      markdown/empty leaf, pick the most recently active. Keeps navigation
 *      inside the tab group the user is already looking at.
 *   3. Otherwise, walk the whole workspace for a non-Work-Terminal
 *      markdown/empty leaf, pick the most recently active. Handles layouts
 *      where Work Terminal lives alone in its tab group.
 *   4. Return null if no suitable leaf exists. Caller should fall back to
 *      `workspace.getLeaf("tab")` which safely opens a new tab.
 *
 * Pure over its inputs: reads only from the provided `app.workspace`. Exported
 * as a module function so it can be unit-tested without instantiating
 * TaskDetailView.
 */
export function findNavigateTargetLeaf(
  app: App,
  workTerminalViewType: string,
): WorkspaceLeaf | null {
  const workspace = app.workspace as unknown as {
    activeLeaf?: WorkspaceLeaf | null;
    rootSplit?: unknown;
  };

  const isWorkTerminal = (leaf: WorkspaceLeaf | null | undefined): boolean =>
    leaf?.view?.getViewType?.() === workTerminalViewType;

  const isEditorLeaf = (leaf: WorkspaceLeaf): boolean => {
    const viewType = leaf.view?.getViewType?.();
    return viewType === "markdown" || viewType === "empty";
  };

  // activeTime is a numeric timestamp Obsidian maintains on each leaf.
  // Missing or 0 means "never focused" - sort those last.
  const activeTimeOf = (leaf: WorkspaceLeaf): number => {
    const t = (leaf as unknown as { activeTime?: number }).activeTime;
    return typeof t === "number" ? t : 0;
  };

  // 1. Active leaf shortcut. If the user has focused a non-WT leaf we already
  //    have our answer, regardless of whether it is markdown or something
  //    else - matches "replace active leaf" semantics for non-WT cases.
  const activeLeaf = workspace.activeLeaf ?? null;
  if (activeLeaf && !isWorkTerminal(activeLeaf)) {
    return activeLeaf;
  }

  // Collect all leaves from the root split for the broader searches below.
  const allLeaves: WorkspaceLeaf[] = [];
  const rootSplit = workspace.rootSplit;
  if (rootSplit) {
    collectLeaves(rootSplit, allLeaves);
  }

  // 2. Search the active leaf's tab group for a non-WT editor leaf.
  const activeParent = (activeLeaf as unknown as { parent?: unknown } | null)?.parent;
  if (activeParent) {
    const siblingLeaves: WorkspaceLeaf[] = [];
    collectLeaves(activeParent, siblingLeaves);
    const candidate = pickMostRecentEditorLeaf(
      siblingLeaves,
      isEditorLeaf,
      isWorkTerminal,
      activeTimeOf,
    );
    if (candidate) return candidate;
  }

  // 3. Fall back to the workspace-wide search.
  const candidate = pickMostRecentEditorLeaf(allLeaves, isEditorLeaf, isWorkTerminal, activeTimeOf);
  if (candidate) return candidate;

  // 4. No suitable leaf.
  return null;
}

/**
 * Pick the most recently active editor leaf that is not the Work Terminal
 * view. Ties on activeTime resolve to document order (later wins -
 * right/bottom-most) which matches how the "split" placement already picks a
 * location hint.
 */
function pickMostRecentEditorLeaf(
  leaves: WorkspaceLeaf[],
  isEditorLeaf: (leaf: WorkspaceLeaf) => boolean,
  isWorkTerminal: (leaf: WorkspaceLeaf) => boolean,
  activeTimeOf: (leaf: WorkspaceLeaf) => number,
): WorkspaceLeaf | null {
  let best: WorkspaceLeaf | null = null;
  let bestTime = -1;
  for (const leaf of leaves) {
    if (isWorkTerminal(leaf)) continue;
    if (!isEditorLeaf(leaf)) continue;
    const t = activeTimeOf(leaf);
    if (t >= bestTime) {
      best = leaf;
      bestTime = t;
    }
  }
  return best;
}

/** Recursively walk a workspace split node and collect all leaves. */
function collectLeaves(node: unknown, result: WorkspaceLeaf[]): void {
  const n = node as { children?: unknown[]; view?: unknown };
  if (n.children) {
    for (const child of n.children) {
      collectLeaves(child, result);
    }
  } else if (n.view) {
    result.push(node as WorkspaceLeaf);
  }
}
