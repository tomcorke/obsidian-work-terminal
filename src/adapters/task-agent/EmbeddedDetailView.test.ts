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

  it("attaches a hidden off-screen container to document.body on show() and removes it on detach()", async () => {
    const contentEl = document.createElement("div");
    const { app } = makeApp({ contentEl });
    const view = new EmbeddedDetailView(app);
    const host = document.createElement("div");
    document.body.appendChild(host);

    const bodyChildrenBefore = document.body.children.length;

    await view.show("a.md", host);

    // After show(), a new hidden container should be attached directly to
    // document.body (positioned off-screen so it never renders for the user).
    expect(document.body.children.length).toBe(bodyChildrenBefore + 1);
    const hiddenContainer = Array.from(document.body.children).find(
      (el) => el !== host && (el as HTMLElement).style.position === "fixed",
    ) as HTMLElement | undefined;
    expect(hiddenContainer).toBeDefined();
    expect(hiddenContainer!.style.left).toBe("-9999px");

    view.detach();

    // After detach(), the hidden container should be gone from document.body.
    expect(document.body.contains(hiddenContainer!)).toBe(false);
    expect(document.body.children.length).toBe(bodyChildrenBefore);
  });

  it("does not accumulate hidden containers across repeated show() calls", async () => {
    const contentEl = document.createElement("div");
    const { app } = makeApp({ contentEl });
    const view = new EmbeddedDetailView(app);
    const host = document.createElement("div");
    document.body.appendChild(host);

    const countHiddenContainers = () =>
      Array.from(document.body.children).filter(
        (el) => el !== host && (el as HTMLElement).style.position === "fixed",
      ).length;

    await view.show("a.md", host);
    expect(countHiddenContainers()).toBe(1);

    await view.show("b.md", host);
    await view.show("c.md", host);
    await view.show("d.md", host);

    // Repeated shows on the same host must reuse the existing leaf and
    // hidden container - they must not accumulate.
    expect(countHiddenContainers()).toBe(1);
  });

  it("cleans up the hidden container when createLeafInParent returns falsy", async () => {
    const contentEl = document.createElement("div");
    const { app, createLeafInParent } = makeApp({ contentEl });
    // Simulate the Obsidian internal API returning no leaf.
    createLeafInParent.mockReturnValueOnce(null);

    const view = new EmbeddedDetailView(app);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const bodyChildrenBefore = document.body.children.length;

    await view.show("a.md", host);

    expect(createLeafInParent).toHaveBeenCalled();
    // No leak: hidden container and split should have been torn down.
    expect(document.body.children.length).toBe(bodyChildrenBefore);
    expect(host.children.length).toBe(0);

    // A second show() should be able to retry cleanly (not throw, no
    // accumulated container from the failed attempt).
    await view.show("a.md", host);
    const hiddenCount = Array.from(document.body.children).filter(
      (el) => el !== host && (el as HTMLElement).style.position === "fixed",
    ).length;
    expect(hiddenCount).toBe(1);
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
