import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { ListPanel } from "./ListPanel";
import type { WorkItem } from "../core/interfaces";

vi.mock("obsidian", () => ({
  Menu: class {
    addSeparator() {}
    addItem(callback: (item: { setTitle: () => any; onClick: () => any }) => void) {
      callback({
        setTitle() {
          return this;
        },
        onClick() {
          return this;
        },
      });
    }
    showAtMouseEvent() {}
  },
  Notice: class {
    constructor(_message: string) {}
  },
  Modal: class {},
}));

type DomGlobals = {
  window: Window & typeof globalThis;
  document: Document;
  HTMLElement: typeof HTMLElement;
  Element: typeof Element;
  Node: typeof Node;
};

function installDomHelpers(globals: DomGlobals) {
  const { HTMLElement } = globals;
  const createEl = function (
    this: HTMLElement,
    tag: string,
    options: { cls?: string; text?: string; attr?: Record<string, string> } = {},
  ) {
    const el = globals.document.createElement(tag) as HTMLElement;
    if (options.cls) {
      el.className = options.cls;
    }
    if (options.text) {
      el.textContent = options.text;
    }
    if (options.attr) {
      for (const [key, value] of Object.entries(options.attr)) {
        el.setAttribute(key, value);
      }
    }
    this.appendChild(el);
    return el;
  };

  HTMLElement.prototype.createEl = createEl;
  HTMLElement.prototype.createDiv = function (
    options: { cls?: string; text?: string; attr?: Record<string, string> } = {},
  ) {
    return createEl.call(this, "div", options);
  };
  HTMLElement.prototype.createSpan = function (
    options: { cls?: string; text?: string; attr?: Record<string, string> } = {},
  ) {
    return createEl.call(this, "span", options);
  };
  HTMLElement.prototype.addClass = function (...classes: string[]) {
    this.classList.add(...classes);
  };
  HTMLElement.prototype.removeClass = function (...classes: string[]) {
    this.classList.remove(...classes);
  };
  HTMLElement.prototype.empty = function () {
    this.replaceChildren();
  };
}

function makeItem(id: string, title = `Task ${id}`): WorkItem {
  return {
    id,
    path: `Tasks/${id}.md`,
    title,
    state: "todo",
    metadata: {},
  };
}

function createListPanel() {
  const parentEl = document.createElement("div") as HTMLElement & {
    createDiv: HTMLElement["createDiv"];
  };
  document.body.appendChild(parentEl);

  const adapter = {
    config: {
      itemName: "task",
      columns: [{ id: "todo", label: "To Do", folderName: "todo" }],
      creationColumns: [{ id: "todo", label: "To Do", default: true }],
    },
  };

  const cardRenderer = {
    render(item: WorkItem) {
      const cardEl = document.createElement("div") as HTMLElement & {
        addClass: HTMLElement["addClass"];
      };
      cardEl.textContent = item.title;
      const actionsEl = document.createElement("div");
      actionsEl.className = "wt-card-actions";
      cardEl.appendChild(actionsEl);
      return cardEl;
    },
    getContextMenuItems() {
      return [];
    },
  };

  const terminalPanel = {
    closeAllSessions: vi.fn(),
    getClaudeContextPrompt: vi.fn(),
    getSessionCounts: vi.fn(() => ({ shells: 0, claudes: 0 })),
    getPersistedSessions: vi.fn(() => []),
    getIdleSince: vi.fn(() => null),
    resumeSession: vi.fn(),
  };

  const plugin = {
    app: {
      vault: {
        getAbstractFileByPath: vi.fn(),
        adapter: { basePath: "/vault" },
        trash: vi.fn(),
      },
    },
  };

  const panel = new ListPanel(
    parentEl,
    adapter as any,
    cardRenderer as any,
    { move: vi.fn() } as any,
    plugin as any,
    terminalPanel as any,
    {},
    vi.fn(),
    vi.fn(),
  );

  return { panel, parentEl };
}

describe("ListPanel", () => {
  let dom: JSDOM;

  beforeEach(() => {
    dom = new JSDOM("<!doctype html><html><body></body></html>");
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
    vi.stubGlobal("Element", dom.window.Element);
    vi.stubGlobal("Node", dom.window.Node);
    installDomHelpers({
      window: dom.window,
      document: dom.window.document,
      HTMLElement: dom.window.HTMLElement,
      Element: dom.window.Element,
      Node: dom.window.Node,
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    dom.window.close();
  });

  it("keeps success animation pending until the new card renders", () => {
    const { panel } = createListPanel();
    panel.render({ todo: [] }, {});

    panel.prependToColumn("task-1", "todo", "placeholder-1");
    panel.resolvePlaceholder("placeholder-1", true);

    panel.render({ todo: [makeItem("task-1")] }, { todo: ["task-1"] });

    expect(
      document.querySelector('[data-item-id="task-1"]')?.classList.contains("wt-card-new-success"),
    ).toBe(true);
  });

  it("matches success animations to the correct placeholder when completions arrive out of order", () => {
    const { panel } = createListPanel();
    panel.render({ todo: [makeItem("task-1"), makeItem("task-2")] }, {});

    panel.prependToColumn("task-1", "todo", "placeholder-1");
    panel.prependToColumn("task-2", "todo", "placeholder-2");
    panel.resolvePlaceholder("placeholder-2", true);

    expect(
      document.querySelector('[data-item-id="task-2"]')?.classList.contains("wt-card-new-success"),
    ).toBe(true);
    expect(
      document.querySelector('[data-item-id="task-1"]')?.classList.contains("wt-card-new-success"),
    ).toBe(false);
  });

  it("drops failed placeholder mappings so later successes do not animate the wrong card", () => {
    const { panel } = createListPanel();
    panel.render({ todo: [makeItem("task-1"), makeItem("task-2")] }, {});

    panel.prependToColumn("task-1", "todo", "placeholder-1");
    panel.prependToColumn("task-2", "todo", "placeholder-2");
    panel.resolvePlaceholder("placeholder-1", false);
    panel.resolvePlaceholder("placeholder-2", true);

    expect(
      document.querySelector('[data-item-id="task-2"]')?.classList.contains("wt-card-new-success"),
    ).toBe(true);
    expect(
      document.querySelector('[data-item-id="task-1"]')?.classList.contains("wt-card-new-success"),
    ).toBe(false);
  });

  it("reuses the existing placeholder element on creation failure", () => {
    const { panel } = createListPanel();
    panel.render({ todo: [] }, {});

    panel.addPlaceholder("placeholder-1");
    const cardsEl = document.querySelector('[data-column="todo"] .wt-section-cards') as HTMLElement;
    const placeholderEl = cardsEl.firstElementChild;

    panel.resolvePlaceholder("placeholder-1", false);

    expect(cardsEl.childElementCount).toBe(1);
    expect(cardsEl.firstElementChild).toBe(placeholderEl);
    expect(placeholderEl?.textContent).toBe("Creation failed");
    expect(placeholderEl?.classList.contains("wt-card-placeholder-error")).toBe(true);

    vi.advanceTimersByTime(5000);
    expect(cardsEl.childElementCount).toBe(0);
  });

  it("uses the renamed ingesting state class on the card wrapper", () => {
    const { panel } = createListPanel();
    panel.render({ todo: [makeItem("task-1")] }, {});

    panel.setIngesting("task-1");

    const cardEl = document.querySelector('[data-item-id="task-1"]');
    expect(cardEl?.classList.contains("wt-card-is-ingesting")).toBe(true);
    expect(cardEl?.classList.contains("wt-card-ingesting")).toBe(false);
  });
});
