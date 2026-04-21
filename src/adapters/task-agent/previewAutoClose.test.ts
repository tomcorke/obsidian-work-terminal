// @vitest-environment jsdom
/**
 * TaskDetailView preview auto-close tests (issue #487).
 *
 * The preview placement, having moved from overlay to a sibling host slot
 * toggled by a Preview pseudo-tab, now also gains an `autoClose` story
 * that mirrors the leaf/embedded placements: when selection moves to a
 * different item with autoClose enabled, the preview is torn down and
 * remounted for the new item. Re-selecting the same item keeps the
 * existing preview.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

const previewShowMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const previewDetachMock = vi.hoisted(() => vi.fn());
let previewInstanceCount = 0;

vi.mock("./TaskPreviewView", () => ({
  TaskPreviewView: class {
    constructor() {
      previewInstanceCount += 1;
    }
    show = previewShowMock;
    detach = previewDetachMock;
    rekeyPath = vi.fn();
  },
}));

vi.mock("obsidian", () => ({
  App: class {},
}));

vi.mock("../../framework/PluginBase", () => ({
  VIEW_TYPE: "work-terminal-view",
}));

import { TaskDetailView } from "./TaskDetailView";

beforeAll(() => {
  const prototype = HTMLElement.prototype as typeof HTMLElement.prototype & {
    addClass(cls: string): HTMLElement;
    removeClass(cls: string): HTMLElement;
    empty(): HTMLElement;
  };
  prototype.addClass ??= function (cls: string) {
    this.classList.add(cls);
    return this;
  };
  prototype.removeClass ??= function (cls: string) {
    this.classList.remove(cls);
    return this;
  };
  prototype.empty ??= function () {
    while (this.firstChild) this.removeChild(this.firstChild);
    return this;
  };
});

function makeItem(id: string, path = `Tasks/${id}.md`) {
  return {
    id,
    path,
    title: id,
    state: "todo",
    metadata: {},
  } as any;
}

describe("TaskDetailView preview auto-close (issue #487)", () => {
  let view: TaskDetailView;
  let previewHost: HTMLElement;
  const app = {} as any;
  const ownerLeaf = {} as any;

  beforeEach(() => {
    previewShowMock.mockClear();
    previewDetachMock.mockClear();
    previewInstanceCount = 0;

    view = new TaskDetailView(app);
    previewHost = document.createElement("div");
  });

  it("detaches the preview when selection changes with autoClose enabled", async () => {
    await view.show(
      makeItem("task-1"),
      ownerLeaf,
      { placement: "preview", autoClose: true } as any,
      previewHost,
    );
    expect(previewShowMock).toHaveBeenCalledTimes(1);
    expect(previewDetachMock).not.toHaveBeenCalled();
    expect(previewInstanceCount).toBe(1);

    await view.show(
      makeItem("task-2"),
      ownerLeaf,
      { placement: "preview", autoClose: true } as any,
      previewHost,
    );
    expect(previewDetachMock).toHaveBeenCalledTimes(1);
    expect(previewShowMock).toHaveBeenCalledTimes(2);
    expect(previewInstanceCount).toBe(2);
  });

  it("reuses the preview when re-selecting the same item even with autoClose enabled", async () => {
    await view.show(
      makeItem("task-1"),
      ownerLeaf,
      { placement: "preview", autoClose: true } as any,
      previewHost,
    );
    await view.show(
      makeItem("task-1"),
      ownerLeaf,
      { placement: "preview", autoClose: true } as any,
      previewHost,
    );

    expect(previewDetachMock).not.toHaveBeenCalled();
    expect(previewShowMock).toHaveBeenCalledTimes(2);
    expect(previewInstanceCount).toBe(1);
  });

  it("reuses the preview when autoClose is disabled and selection changes", async () => {
    await view.show(
      makeItem("task-1"),
      ownerLeaf,
      { placement: "preview", autoClose: false } as any,
      previewHost,
    );
    await view.show(
      makeItem("task-2"),
      ownerLeaf,
      { placement: "preview", autoClose: false } as any,
      previewHost,
    );

    expect(previewDetachMock).not.toHaveBeenCalled();
    expect(previewShowMock).toHaveBeenCalledTimes(2);
    expect(previewInstanceCount).toBe(1);
  });

  it("uses the framework-supplied preview host rather than querying the workspace", async () => {
    await view.show(
      makeItem("task-1"),
      ownerLeaf,
      { placement: "preview", autoClose: true } as any,
      previewHost,
    );

    // The preview mock records the host passed through to `show()`.
    const firstCall = previewShowMock.mock.calls[0];
    expect(firstCall[1]).toBe(previewHost);
  });

  it("detaches the preview when placement switches away from preview", async () => {
    await view.show(
      makeItem("task-1"),
      ownerLeaf,
      { placement: "preview", autoClose: true } as any,
      previewHost,
    );
    expect(previewInstanceCount).toBe(1);

    // Switching away from preview must detach. A minimal fake vault/TFile
    // pair keeps the non-preview branches happy even though we never reach
    // them (we expect the placement-change branch to fire before any file
    // lookups).
    (app as any).vault = {
      getAbstractFileByPath: () => null,
    };
    await view.show(
      makeItem("task-1"),
      ownerLeaf,
      { placement: "disabled", autoClose: true } as any,
      previewHost,
    );

    expect(previewDetachMock).toHaveBeenCalledTimes(1);
  });
});
