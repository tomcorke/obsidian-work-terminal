// @vitest-environment jsdom
/**
 * Adapter-level tests for the embedded detail auto-close behaviour.
 * See issue #479 Copilot review comment 3.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

const embeddedShowMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const embeddedDetachMock = vi.hoisted(() => vi.fn());
const embeddedRekeyMock = vi.hoisted(() => vi.fn());
let embeddedInstanceCount = 0;

vi.mock("./EmbeddedDetailView", () => ({
  EmbeddedDetailView: class {
    constructor() {
      embeddedInstanceCount += 1;
    }
    show = embeddedShowMock;
    detach = embeddedDetachMock;
    rekeyPath = embeddedRekeyMock;
  },
}));

// TaskDetailView isn't exercised by these tests but is imported from index.
// Provide a minimal stub so `new TaskDetailView(app)` doesn't touch Obsidian.
vi.mock("./TaskDetailView", () => ({
  TaskDetailView: class {
    show = vi.fn().mockResolvedValue(undefined);
    detach = vi.fn();
    rekeyPath = vi.fn();
  },
}));

// Stub SetIconModal - it extends Modal and we don't want Obsidian's base classes.
vi.mock("./SetIconModal", () => ({
  SetIconModal: class {
    open() {}
  },
}));

vi.mock("./BackgroundEnrich", () => ({
  handleItemCreated: vi.fn(),
  handleSplitTaskCreated: vi.fn(),
  prepareRetryEnrichment: vi.fn(),
}));

vi.mock("obsidian", () => ({
  App: class {},
}));

import { TaskAgentAdapter } from "./index";

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

describe("TaskAgentAdapter embedded auto-close (issue #479)", () => {
  let adapter: TaskAgentAdapter;
  let host: HTMLElement;
  const app = {} as any;
  const ownerLeaf = {} as any;

  beforeEach(() => {
    embeddedShowMock.mockClear();
    embeddedDetachMock.mockClear();
    embeddedRekeyMock.mockClear();
    embeddedInstanceCount = 0;

    adapter = new TaskAgentAdapter();
    host = document.createElement("div");
  });

  it("detaches the embedded view when selection changes with autoClose enabled", () => {
    (adapter as any)._settings = {
      "core.detailViewPlacement": "embedded",
      "core.detailViewAutoClose": true,
    };

    adapter.createDetailView(makeItem("task-1"), app, ownerLeaf, host);
    expect(embeddedShowMock).toHaveBeenCalledTimes(1);
    expect(embeddedDetachMock).not.toHaveBeenCalled();
    expect(embeddedInstanceCount).toBe(1);

    // Select a different item - should detach and mount fresh
    adapter.createDetailView(makeItem("task-2"), app, ownerLeaf, host);
    expect(embeddedDetachMock).toHaveBeenCalledTimes(1);
    expect(embeddedShowMock).toHaveBeenCalledTimes(2);
    expect(embeddedInstanceCount).toBe(2);
  });

  it("reuses the embedded view when re-selecting the same item even with autoClose enabled", () => {
    (adapter as any)._settings = {
      "core.detailViewPlacement": "embedded",
      "core.detailViewAutoClose": true,
    };

    adapter.createDetailView(makeItem("task-1"), app, ownerLeaf, host);
    adapter.createDetailView(makeItem("task-1"), app, ownerLeaf, host);

    expect(embeddedDetachMock).not.toHaveBeenCalled();
    expect(embeddedShowMock).toHaveBeenCalledTimes(2);
    expect(embeddedInstanceCount).toBe(1);
  });

  it("reuses the embedded view when autoClose is disabled and selection changes", () => {
    (adapter as any)._settings = {
      "core.detailViewPlacement": "embedded",
      "core.detailViewAutoClose": false,
    };

    adapter.createDetailView(makeItem("task-1"), app, ownerLeaf, host);
    adapter.createDetailView(makeItem("task-2"), app, ownerLeaf, host);

    expect(embeddedDetachMock).not.toHaveBeenCalled();
    expect(embeddedShowMock).toHaveBeenCalledTimes(2);
    expect(embeddedInstanceCount).toBe(1);
  });
});
