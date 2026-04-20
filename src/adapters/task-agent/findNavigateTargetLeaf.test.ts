import { describe, expect, it } from "vitest";
import { findNavigateTargetLeaf } from "./findNavigateTargetLeaf";

const WT = "work-terminal-view";

type FakeLeaf = {
  view: { getViewType: () => string };
  activeTime?: number;
  parent?: FakeSplit;
};

type FakeSplit = {
  children: Array<FakeLeaf | FakeSplit>;
};

function leaf(viewType: string, activeTime = 0): FakeLeaf {
  return {
    view: { getViewType: () => viewType },
    activeTime,
  };
}

function split(...children: Array<FakeLeaf | FakeSplit>): FakeSplit {
  const s: FakeSplit = { children };
  for (const child of children) {
    if ("view" in child) {
      child.parent = s;
    }
  }
  return s;
}

function makeApp(params: { activeLeaf?: FakeLeaf | null; rootSplit?: FakeSplit | null }): any {
  return {
    workspace: {
      activeLeaf: params.activeLeaf ?? null,
      rootSplit: params.rootSplit ?? null,
    },
  };
}

describe("findNavigateTargetLeaf", () => {
  it("returns the active leaf when it is not the Work Terminal view", () => {
    const md = leaf("markdown", 100);
    const root = split(md);
    const app = makeApp({ activeLeaf: md, rootSplit: root });

    expect(findNavigateTargetLeaf(app, WT)).toBe(md);
  });

  it("skips the Work Terminal active leaf and returns the most recent editor leaf", () => {
    const wt = leaf(WT, 200);
    const mdOld = leaf("markdown", 50);
    const mdNew = leaf("markdown", 150);
    const root = split(wt, mdOld, mdNew);
    const app = makeApp({ activeLeaf: wt, rootSplit: root });

    expect(findNavigateTargetLeaf(app, WT)).toBe(mdNew);
  });

  it("prefers a non-WT leaf in the active leaf's tab group over other groups", () => {
    const wt = leaf(WT, 300);
    const sibling = leaf("markdown", 100);
    const wtGroup = split(wt, sibling);

    const otherMoreRecent = leaf("markdown", 500);
    const otherGroup = split(otherMoreRecent);

    const root: FakeSplit = { children: [wtGroup, otherGroup] };
    wtGroup.children.forEach((c) => {
      if ("view" in c) c.parent = wtGroup;
    });
    otherGroup.children.forEach((c) => {
      if ("view" in c) c.parent = otherGroup;
    });

    const app = makeApp({ activeLeaf: wt, rootSplit: root });

    // Sibling wins even though the other group has a more recent leaf
    expect(findNavigateTargetLeaf(app, WT)).toBe(sibling);
  });

  it("falls back to the workspace-wide most recent editor leaf when WT is alone in its tab group", () => {
    const wt = leaf(WT, 100);
    const wtGroup = split(wt);

    const mdOld = leaf("markdown", 50);
    const mdNew = leaf("markdown", 200);
    const otherGroup = split(mdOld, mdNew);

    const root: FakeSplit = { children: [wtGroup, otherGroup] };

    const app = makeApp({ activeLeaf: wt, rootSplit: root });

    expect(findNavigateTargetLeaf(app, WT)).toBe(mdNew);
  });

  it("treats 'empty' view type as a valid editor leaf", () => {
    const wt = leaf(WT, 100);
    const empty = leaf("empty", 10);
    const root = split(wt, empty);
    const app = makeApp({ activeLeaf: wt, rootSplit: root });

    expect(findNavigateTargetLeaf(app, WT)).toBe(empty);
  });

  it("ignores non-editor view types (e.g. file-explorer, outline)", () => {
    const wt = leaf(WT, 100);
    const sidebar = leaf("file-explorer", 999);
    const root = split(wt, sidebar);
    const app = makeApp({ activeLeaf: wt, rootSplit: root });

    expect(findNavigateTargetLeaf(app, WT)).toBeNull();
  });

  it("skips a non-editor active leaf (file-explorer) and falls through to the recent markdown leaf", () => {
    const sidebar = leaf("file-explorer", 500);
    const mdOld = leaf("markdown", 50);
    const mdNew = leaf("markdown", 150);
    const root = split(sidebar, mdOld, mdNew);
    const app = makeApp({ activeLeaf: sidebar, rootSplit: root });

    // file-explorer active leaf must NOT be returned - we'd replace the
    // sidebar with the task file otherwise. Fall through to the recent
    // markdown leaf instead.
    expect(findNavigateTargetLeaf(app, WT)).toBe(mdNew);
  });

  it("skips a non-editor active leaf (outline) even when no markdown leaves exist", () => {
    const outline = leaf("outline", 500);
    const wt = leaf(WT, 100);
    const root = split(outline, wt);
    const app = makeApp({ activeLeaf: outline, rootSplit: root });

    // No editor leaves at all, so returns null - caller will open a new tab.
    expect(findNavigateTargetLeaf(app, WT)).toBeNull();
  });

  it("returns null when only Work Terminal leaves exist", () => {
    const wt1 = leaf(WT, 100);
    const wt2 = leaf(WT, 200);
    const root = split(wt1, wt2);
    const app = makeApp({ activeLeaf: wt1, rootSplit: root });

    expect(findNavigateTargetLeaf(app, WT)).toBeNull();
  });

  it("returns null when there are no leaves at all", () => {
    const app = makeApp({ activeLeaf: null, rootSplit: null });
    expect(findNavigateTargetLeaf(app, WT)).toBeNull();
  });

  it("handles nested splits when walking for leaves", () => {
    const wt = leaf(WT, 100);
    const wtGroup = split(wt);

    const md1 = leaf("markdown", 50);
    const md2 = leaf("markdown", 300);
    const innerSplit = split(md1, md2);
    const outerGroup: FakeSplit = { children: [innerSplit] };

    const root: FakeSplit = { children: [wtGroup, outerGroup] };

    const app = makeApp({ activeLeaf: wt, rootSplit: root });

    expect(findNavigateTargetLeaf(app, WT)).toBe(md2);
  });

  it("handles leaves with missing activeTime by treating them as never-focused", () => {
    const wt = leaf(WT, 100);
    // No activeTime set (undefined) -> treated as 0
    const mdNoTime: FakeLeaf = { view: { getViewType: () => "markdown" } };
    const mdWithTime = leaf("markdown", 10);
    const root = split(wt, mdNoTime, mdWithTime);
    // Set parent refs so walk works
    mdNoTime.parent = root;
    const app = makeApp({ activeLeaf: wt, rootSplit: root });

    // mdWithTime (time 10) beats mdNoTime (time 0)
    expect(findNavigateTargetLeaf(app, WT)).toBe(mdWithTime);
  });
});
