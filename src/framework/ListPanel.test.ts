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

function createListPanel(
  options: {
    columns?: { id: string; label: string; folderName: string }[];
    creationColumns?: { id: string; label: string; default?: boolean }[];
    mover?: { move: ReturnType<typeof vi.fn> };
    onCustomOrderChange?: ReturnType<typeof vi.fn>;
    cardClasses?: string[];
    itemName?: string;
  } = {},
) {
  const parentEl = document.createElement("div") as HTMLElement & {
    createDiv: HTMLElement["createDiv"];
  };
  document.body.appendChild(parentEl);

  const columns = options.columns ?? [{ id: "todo", label: "To Do", folderName: "todo" }];
  const creationColumns = options.creationColumns ?? [
    { id: "todo", label: "To Do", default: true },
  ];
  const mover = options.mover ?? { move: vi.fn() };
  const onCustomOrderChange = options.onCustomOrderChange ?? vi.fn();

  const adapter = {
    config: {
      itemName: options.itemName ?? "task",
      columns,
      creationColumns,
    },
  };

  const cardRenderer = {
    render(item: WorkItem) {
      const cardEl = document.createElement("div") as HTMLElement & {
        addClass: HTMLElement["addClass"];
      };
      cardEl.textContent = item.title;
      if (options.cardClasses?.length) {
        cardEl.classList.add(...options.cardClasses);
      }
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
    getAgentContextPrompt: vi.fn(),
    getSessionCounts: vi.fn(() => ({ shells: 0, agents: 0 })),
    hasResumableAgentSessions: vi.fn(() => false),
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
    mover as any,
    plugin as any,
    terminalPanel as any,
    {},
    vi.fn(),
    onCustomOrderChange,
  );

  return { panel, parentEl, mover, onCustomOrderChange, plugin, terminalPanel };
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

  it("uses the adapter item name in the success bar copy and removes the bar after the timeout", () => {
    const { panel } = createListPanel({ itemName: "ticket" });
    panel.render({ todo: [] }, {});

    panel.prependToColumn("task-1", "todo", "placeholder-1");
    panel.resolvePlaceholder("placeholder-1", true);
    panel.render({ todo: [makeItem("task-1")] }, { todo: ["task-1"] });

    const cardEl = document.querySelector('[data-item-id="task-1"]') as HTMLElement;
    const successBar = cardEl.nextElementSibling;
    expect(successBar?.classList.contains("wt-success-bar")).toBe(true);
    expect(successBar?.textContent).toBe("new ticket created");

    vi.advanceTimersByTime(4500);

    expect(cardEl.classList.contains("wt-card-new-success")).toBe(false);
    expect(cardEl.nextElementSibling?.classList.contains("wt-success-bar")).toBeFalsy();
  });

  it("clears pending success animation timers on dispose", () => {
    const { panel } = createListPanel();
    panel.render({ todo: [] }, {});

    panel.prependToColumn("task-1", "todo", "placeholder-1");
    panel.resolvePlaceholder("placeholder-1", true);
    panel.render({ todo: [makeItem("task-1")] }, { todo: ["task-1"] });

    expect(vi.getTimerCount()).toBe(1);

    panel.dispose();

    expect(vi.getTimerCount()).toBe(0);
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

  it("keeps the resume badge visible when only non-resumable agent tabs are active", () => {
    const { panel, terminalPanel } = createListPanel();
    terminalPanel.getSessionCounts.mockReturnValue({ shells: 0, agents: 1 });
    terminalPanel.getPersistedSessions.mockReturnValue([
      {
        version: 1,
        taskPath: "Tasks/task-1.md",
        agentSessionId: "session-1",
        label: "Claude",
        sessionType: "claude",
        savedAt: new Date().toISOString(),
      },
    ]);
    terminalPanel.hasResumableAgentSessions.mockReturnValue(false);

    panel.render({ todo: [makeItem("task-1")] }, {});

    expect(document.querySelector('[data-item-id="task-1"] .wt-resume-badge')?.textContent).toBe(
      "↻",
    );
  });

  it("uses wt-agent classes on initial render and clears legacy wt-claude classes", () => {
    const { panel } = createListPanel({ cardClasses: ["wt-claude-active"] });
    panel.updateAgentState("task-1", "waiting");

    panel.render({ todo: [makeItem("task-1")] }, {});

    const cardEl = document.querySelector('[data-item-id="task-1"]') as HTMLElement;
    expect(cardEl.classList.contains("wt-agent-waiting")).toBe(true);
    expect(cardEl.classList.contains("wt-claude-active")).toBe(false);
    expect(cardEl.classList.contains("wt-claude-waiting")).toBe(false);
  });

  it("uses wt-agent classes on incremental updates and removes stale legacy classes", () => {
    const { panel } = createListPanel();
    panel.render({ todo: [makeItem("task-1")] }, {});

    const cardEl = document.querySelector('[data-item-id="task-1"]') as HTMLElement;
    cardEl.classList.add("wt-claude-active", "wt-claude-idle");

    panel.updateAgentState("task-1", "idle");

    expect(cardEl.classList.contains("wt-agent-idle")).toBe(true);
    expect(cardEl.classList.contains("wt-claude-active")).toBe(false);
    expect(cardEl.classList.contains("wt-claude-idle")).toBe(false);
  });

  it("does not reorder the destination column when a cross-column move fails", async () => {
    const file = { path: "Tasks/task-1.md" };
    const mover = { move: vi.fn().mockResolvedValue(false) };
    const onCustomOrderChange = vi.fn();
    const { panel, plugin } = createListPanel({
      columns: [
        { id: "todo", label: "To Do", folderName: "todo" },
        { id: "active", label: "Active", folderName: "active" },
      ],
      creationColumns: [{ id: "todo", label: "To Do", default: true }],
      mover,
      onCustomOrderChange,
    });

    const sourceItem = makeItem("task-1");
    const destinationItem = { ...makeItem("task-2"), state: "active" };
    const customOrder = { todo: ["task-1"], active: ["task-2"] };

    (plugin.app.vault.getAbstractFileByPath as ReturnType<typeof vi.fn>).mockReturnValue(file);

    panel.render(
      {
        todo: [sourceItem],
        active: [destinationItem],
      },
      customOrder,
    );

    (panel as any).dragSourceId = "task-1";
    (panel as any).dragSourceColumn = "todo";

    const activeCardsEl = document.querySelector(
      '[data-column="active"] .wt-section-cards',
    ) as HTMLElement;

    activeCardsEl.dispatchEvent(
      new dom.window.MouseEvent("drop", { bubbles: true, cancelable: true, clientY: 0 }),
    );
    await vi.runAllTimersAsync();

    expect(mover.move).toHaveBeenCalledWith(file, "active");
    expect(onCustomOrderChange).not.toHaveBeenCalled();
    expect((panel as any).customOrder.active).toEqual(["task-2"]);
    expect(
      Array.from(document.querySelectorAll('[data-column="active"] [data-item-id]')).map((el) =>
        el.getAttribute("data-item-id"),
      ),
    ).toEqual(["task-2"]);
    expect(
      Array.from(document.querySelectorAll('[data-column="todo"] [data-item-id]')).map((el) =>
        el.getAttribute("data-item-id"),
      ),
    ).toEqual(["task-1"]);
  });
});
