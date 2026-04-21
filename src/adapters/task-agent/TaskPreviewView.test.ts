// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type CreateChildOptions = { cls?: string; text?: string };
type ObsidianHTMLElementPrototype = typeof HTMLElement.prototype & {
  addClass(cls: string): HTMLElement;
  removeClass(cls: string): HTMLElement;
  createDiv(options?: CreateChildOptions): HTMLDivElement;
  createEl<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    options?: CreateChildOptions,
  ): HTMLElementTagNameMap[K];
  empty(): void;
  setAttr(name: string, value: string): void;
};

// Track each created Component so tests can assert unload behaviour.
const { componentInstances, markdownRenderMock } = vi.hoisted(() => ({
  componentInstances: [] as Array<{ loaded: boolean; unload: ReturnType<typeof vi.fn> }>,
  markdownRenderMock: vi.fn(async () => {}),
}));

vi.mock("obsidian", () => {
  class TFileMock {
    path = "";
  }
  class ComponentMock {
    loaded = false;
    unload = vi.fn(() => {
      this.loaded = false;
    });
    load() {
      this.loaded = true;
      componentInstances.push(this);
    }
  }
  class NoopBase {}
  return {
    Component: ComponentMock,
    MarkdownRenderer: { render: markdownRenderMock },
    TFile: TFileMock,
    // Stubs for symbols pulled in by transitive imports (PluginBase etc.).
    Plugin: NoopBase,
    PluginSettingTab: NoopBase,
    ItemView: NoopBase,
    MarkdownView: NoopBase,
    WorkspaceLeaf: NoopBase,
    Notice: class Notice {
      constructor(_message: string) {}
    },
    Modal: NoopBase,
    TFolder: NoopBase,
  };
});

vi.mock("../../framework/PluginBase", () => ({
  VIEW_TYPE: "work-terminal-view",
}));

import { Component, TFile } from "obsidian";
import { TaskPreviewView } from "./TaskPreviewView";
import type { WorkItem } from "../../core/interfaces";

// Polyfill Obsidian HTMLElement augmentations for jsdom
beforeAll(() => {
  const prototype = HTMLElement.prototype as ObsidianHTMLElementPrototype;

  prototype.addClass = function (cls: string) {
    this.classList.add(cls);
    return this;
  };
  prototype.removeClass = function (cls: string) {
    this.classList.remove(cls);
    return this;
  };
  prototype.createDiv = function (options?: CreateChildOptions) {
    const el = document.createElement("div");
    if (options?.cls) el.classList.add(...options.cls.split(" "));
    if (options?.text) el.textContent = options.text;
    this.appendChild(el);
    return el;
  };
  prototype.createEl = function <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    options?: CreateChildOptions,
  ) {
    const el = document.createElement(tag);
    if (options?.cls) el.classList.add(...options.cls.split(" "));
    if (options?.text) el.textContent = options.text;
    this.appendChild(el);
    return el as HTMLElementTagNameMap[K];
  };
  prototype.empty = function () {
    while (this.firstChild) this.removeChild(this.firstChild);
  };
  prototype.setAttr = function (name: string, value: string) {
    this.setAttribute(name, value);
  };
});

function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "task-1",
    path: "Tasks/task.md",
    title: "Task",
    state: "priority",
    metadata: {},
    ...overrides,
  } as WorkItem;
}

type FakeApp = {
  vault: {
    getAbstractFileByPath: ReturnType<typeof vi.fn>;
    cachedRead: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    offref: ReturnType<typeof vi.fn>;
  };
  workspace: {
    getLeaf: ReturnType<typeof vi.fn>;
    activeLeaf: unknown;
    rootSplit: unknown;
  };
};

function makeFakeApp(filesByPath: Record<string, InstanceType<typeof TFile>>): FakeApp {
  return {
    vault: {
      getAbstractFileByPath: vi.fn((p: string) => filesByPath[p] ?? null),
      cachedRead: vi.fn(async () => "# Hello"),
      on: vi.fn((event: string, _cb: unknown) => {
        return { event };
      }),
      offref: vi.fn(),
    },
    workspace: {
      getLeaf: vi.fn(() => null),
      activeLeaf: null,
      rootSplit: null,
    },
  };
}

function makeFile(path: string) {
  const file = new TFile();
  (file as unknown as { path: string }).path = path;
  return file as unknown as InstanceType<typeof TFile>;
}

describe("TaskPreviewView", () => {
  beforeEach(() => {
    componentInstances.length = 0;
    markdownRenderMock.mockClear();
  });

  describe("openInEditor does not dismiss the overlay", () => {
    it("leaves the overlay mounted and the modify listener registered after clicking Open in editor", async () => {
      const hostEl = document.createElement("div");
      document.body.appendChild(hostEl);
      const file = makeFile("Tasks/task.md");
      const app = makeFakeApp({ "Tasks/task.md": file });

      // Provide a workspace leaf so openFile has somewhere to go.
      const openFile = vi.fn(async () => {});
      app.workspace.getLeaf = vi.fn(() => ({ openFile }));

      const view = new TaskPreviewView(app as unknown as Parameters<typeof TaskPreviewView>[0]);
      await view.show(makeItem(), hostEl);

      const btn = hostEl.querySelector<HTMLButtonElement>(".wt-preview-open-btn");
      expect(btn).not.toBeNull();
      // Sanity: overlay mounted and modify listener registered.
      expect(hostEl.querySelector(".wt-preview-overlay")).not.toBeNull();
      expect(app.vault.on).toHaveBeenCalledTimes(1);

      btn!.click();
      // Let the async click handler settle.
      await new Promise((r) => setTimeout(r, 0));

      // Overlay still mounted.
      expect(hostEl.querySelector(".wt-preview-overlay")).not.toBeNull();
      // Listener still registered (offref not called).
      expect(app.vault.offref).not.toHaveBeenCalled();
      // File was opened via the resolved leaf.
      expect(openFile).toHaveBeenCalledWith(file);
    });
  });
});

// Silence the unused-import lint for Component - we reference it via the mock.
void Component;
