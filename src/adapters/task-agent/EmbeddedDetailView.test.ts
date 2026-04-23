// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { EmbeddedDetailView } from "./EmbeddedDetailView";
import type { App } from "obsidian";

// Polyfill Obsidian HTMLElement augmentations used by EmbeddedDetailView.
beforeAll(() => {
  const prototype = HTMLElement.prototype as typeof HTMLElement.prototype & {
    addClass(cls: string): HTMLElement;
    removeClass(cls: string): HTMLElement;
    empty(): HTMLElement;
  };
  prototype.addClass = function (cls: string) {
    this.classList.add(cls);
    return this;
  };
  prototype.removeClass = function (cls: string) {
    this.classList.remove(cls);
    return this;
  };
  prototype.empty = function () {
    while (this.firstChild) this.removeChild(this.firstChild);
    return this;
  };
});

/**
 * Fabricate a minimal Obsidian App/Workspace/Leaf shape for EmbeddedDetailView.
 * The class uses `workspace.createLeafInParent` with a hidden off-screen
 * WorkspaceSplit, then `leaf.openFile` / `leaf.view.contentEl` / `leaf.detach`.
 */
function makeApp(opts: { fileExists?: boolean; contentEl?: HTMLElement | null } = {}): {
  app: App;
  leaf: { openFile: ReturnType<typeof vi.fn>; detach: ReturnType<typeof vi.fn>; view: any };
  createLeafInParent: ReturnType<typeof vi.fn>;
} {
  const contentEl = opts.contentEl === undefined ? document.createElement("div") : opts.contentEl;
  if (contentEl) {
    // Place content under an "original parent" to match what Obsidian would do.
    const originalParent = document.createElement("div");
    originalParent.appendChild(contentEl);
  }
  const leaf = {
    openFile: vi.fn().mockResolvedValue(undefined),
    detach: vi.fn(),
    view: contentEl ? { contentEl } : null,
  };
  const createLeafInParent = vi.fn().mockReturnValue(leaf);
  // Minimal WorkspaceSplit constructor mock - creates a containerEl
  function FakeSplit() {
    (this as any).containerEl = document.createElement("div");
  }
  const app = {
    vault: {
      getAbstractFileByPath: (p: string) =>
        opts.fileExists === false ? null : ({ path: p } as unknown),
    },
    workspace: {
      createLeafInParent,
      rootSplit: { constructor: FakeSplit },
    },
  } as unknown as App;
  return { app, leaf, createLeafInParent };
}

describe("EmbeddedDetailView", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("does nothing when the file does not exist", async () => {
    const { app, createLeafInParent } = makeApp({ fileExists: false });
    const view = new EmbeddedDetailView(app);
    const host = document.createElement("div");
    await view.show("missing.md", host);
    expect(createLeafInParent).not.toHaveBeenCalled();
    expect(host.children.length).toBe(0);
  });

  it("creates a hidden leaf and reparents contentEl into the host", async () => {
    const contentEl = document.createElement("div");
    contentEl.className = "markdown-source-view";
    document.body.appendChild(document.createElement("div")).appendChild(contentEl);

    const { app, leaf, createLeafInParent } = makeApp({ contentEl });
    const view = new EmbeddedDetailView(app);
    const host = document.createElement("div");
    document.body.appendChild(host);

    await view.show("task.md", host);

    expect(createLeafInParent).toHaveBeenCalled();
    expect(leaf.openFile).toHaveBeenCalled();
    expect(contentEl.parentElement).toBe(host);
    expect(host.classList.contains("wt-embedded-detail-active")).toBe(true);
  });

  it("reuses the existing leaf on subsequent shows and does not re-create one", async () => {
    const contentEl = document.createElement("div");
    document.body.appendChild(document.createElement("div")).appendChild(contentEl);
    const { app, leaf, createLeafInParent } = makeApp({ contentEl });
    const view = new EmbeddedDetailView(app);
    const host = document.createElement("div");

    await view.show("a.md", host);
    await view.show("b.md", host);

    expect(createLeafInParent).toHaveBeenCalledTimes(1);
    expect(leaf.openFile).toHaveBeenCalledTimes(2);
    expect(contentEl.parentElement).toBe(host);
  });

  it("moves contentEl into a new host when host changes", async () => {
    const contentEl = document.createElement("div");
    document.body.appendChild(document.createElement("div")).appendChild(contentEl);
    const { app } = makeApp({ contentEl });
    const view = new EmbeddedDetailView(app);

    const hostA = document.createElement("div");
    const hostB = document.createElement("div");

    await view.show("a.md", hostA);
    expect(contentEl.parentElement).toBe(hostA);

    await view.show("a.md", hostB);
    expect(contentEl.parentElement).toBe(hostB);
    expect(hostA.classList.contains("wt-embedded-detail-active")).toBe(false);
    expect(hostB.classList.contains("wt-embedded-detail-active")).toBe(true);
  });

  it("detaches the leaf and restores the reparented element on detach", async () => {
    const contentEl = document.createElement("div");
    const { app, leaf } = makeApp({ contentEl });
    // Track the parent the helper assigned so we can assert restore goes back to it.
    const originalParent = contentEl.parentElement as HTMLElement;
    expect(originalParent).not.toBeNull();

    const view = new EmbeddedDetailView(app);
    const host = document.createElement("div");
    await view.show("a.md", host);
    expect(contentEl.parentElement).toBe(host);

    view.detach();

    expect(leaf.detach).toHaveBeenCalled();
    expect(contentEl.parentElement).toBe(originalParent);
    expect(host.classList.contains("wt-embedded-detail-active")).toBe(false);
    expect(host.children.length).toBe(0);
  });

  it("handles show() on a new path after rename without tracking internal path state", async () => {
    const contentEl = document.createElement("div");
    document.body.appendChild(document.createElement("div")).appendChild(contentEl);
    const { app } = makeApp({ contentEl });
    const view = new EmbeddedDetailView(app);
    const host = document.createElement("div");
    await view.show("old.md", host);

    // A subsequent show() on the new path reuses the leaf and keeps the
    // content mounted in the same host - no explicit rekey required.
    await view.show("new.md", host);
    expect(contentEl.parentElement).toBe(host);
  });
});
