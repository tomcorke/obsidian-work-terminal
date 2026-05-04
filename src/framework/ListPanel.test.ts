import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { ListPanel } from "./ListPanel";
import type { WorkItem } from "../core/interfaces";

const { noticeMock } = vi.hoisted(() => ({ noticeMock: vi.fn() }));

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
    constructor(message: string) {
      noticeMock(message);
    }
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
    onSessionFilterChange?: ReturnType<typeof vi.fn>;
    onCreateSubTask?: ReturnType<typeof vi.fn>;
    cardClasses?: string[];
    includeMetaRow?: boolean;
    itemName?: string;
    settings?: Record<string, unknown>;
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
    onCreateSubTask: options.onCreateSubTask,
  };

  const cardRenderer = {
    render(item: WorkItem) {
      const cardEl = document.createElement("div") as HTMLElement & {
        addClass: HTMLElement["addClass"];
      };
      const titleEl = document.createElement("div");
      titleEl.textContent = item.title;
      cardEl.appendChild(titleEl);
      if (options.includeMetaRow) {
        const metaEl = document.createElement("div");
        metaEl.className = "wt-card-meta";
        metaEl.textContent = "meta";
        cardEl.appendChild(metaEl);
      }
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
    getSessionItemIds: vi.fn(() => [] as string[]),
    hasResumableAgentSessions: vi.fn(() => false),
    getPersistedSessions: vi.fn(() => []),
    getIdleSince: vi.fn(() => null),
    resumeSession: vi.fn(),
    spawnClaudeWithPrompt: vi.fn(),
    clearResumeSessionsForItem: vi.fn().mockResolvedValue(undefined),
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

  const onSessionFilterChange = options.onSessionFilterChange ?? vi.fn();
  const settings = options.settings ?? {};

  const onSelect = vi.fn();
  const panel = new ListPanel(
    parentEl,
    adapter as any,
    cardRenderer as any,
    mover as any,
    plugin as any,
    terminalPanel as any,
    settings,
    onSelect,
    onCustomOrderChange,
    onSessionFilterChange,
  );

  return {
    panel,
    parentEl,
    mover,
    onCustomOrderChange,
    onSessionFilterChange,
    onSelect,
    plugin,
    terminalPanel,
  };
}

describe("ListPanel", () => {
  let dom: JSDOM;
  let originalGetBoundingClientRect: typeof HTMLElement.prototype.getBoundingClientRect;

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
    originalGetBoundingClientRect = dom.window.HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(dom.window.HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains("wt-success-bar")) {
          const height = this.isConnected ? 18 : 0;
          return {
            x: 0,
            y: 0,
            bottom: height,
            height,
            left: 0,
            right: 0,
            top: 0,
            width: 0,
            toJSON() {
              return {};
            },
          } as DOMRect;
        }
        return originalGetBoundingClientRect.call(this);
      },
    );
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    noticeMock.mockReset();
    dom.window.close();
  });

  it("renders sub-tasks immediately after their parent with nested styling", () => {
    const { panel } = createListPanel();
    const parent = makeItem("parent", "Parent");
    const child: WorkItem = {
      ...makeItem("child", "Child"),
      metadata: { parent: { id: "parent", title: "Parent", path: "Tasks/parent.md" } },
    };
    const sibling = makeItem("sibling", "Sibling");

    panel.render({ todo: [child, sibling, parent] }, { todo: ["sibling", "parent", "child"] });

    const ids = Array.from(document.querySelectorAll(".wt-card-wrapper")).map((el) =>
      el.getAttribute("data-item-id"),
    );
    expect(ids).toEqual(["sibling", "parent", "child"]);
    const childEl = document.querySelector('[data-item-id="child"]') as HTMLElement;
    expect(childEl.classList.contains("wt-card-subtask")).toBe(true);
    expect(childEl.style.getPropertyValue("--wt-subtask-depth")).toBe("1");
  });

  it("renders matching sub-tasks as top-level when their parent is filtered out", () => {
    const { panel, parentEl } = createListPanel();
    const parent = makeItem("parent", "Unrelated parent");
    const child: WorkItem = {
      ...makeItem("child", "Needle child"),
      metadata: { parent: { id: "parent", title: "Unrelated parent", path: "Tasks/parent.md" } },
    };

    panel.render({ todo: [parent, child] }, { todo: ["parent", "child"] });
    const input = parentEl.querySelector(".wt-filter-input") as HTMLInputElement;
    input.value = "needle";
    input.dispatchEvent(new window.Event("input"));
    vi.advanceTimersByTime(100);

    const parentElCard = document.querySelector('[data-item-id="parent"]') as HTMLElement;
    const childEl = document.querySelector('[data-item-id="child"]') as HTMLElement;
    expect(parentElCard.style.display).toBe("none");
    expect(childEl.style.display).toBe("");
    expect(childEl.classList.contains("wt-card-subtask-orphaned")).toBe(true);
  });

  it("creates sub-tasks from activity sections using the parent task state", async () => {
    const onCreateSubTask = vi.fn().mockResolvedValue({
      id: "child",
      path: "Tasks/active/child.md",
      title: "Child focus",
    });
    const { panel } = createListPanel({
      columns: [
        { id: "todo", label: "To Do", folderName: "todo" },
        { id: "active", label: "Active", folderName: "active" },
      ],
      settings: { "core.viewMode": "activity" },
      onCreateSubTask,
    });
    const parent = { ...makeItem("parent", "Parent"), state: "active" };

    panel.render({ active: [parent] }, {});
    await (panel as any).createSubTask(parent, "recent", "Child focus");

    expect(onCreateSubTask).toHaveBeenCalledWith(
      parent,
      "Child focus",
      "active",
      expect.any(Object),
    );
  });

  it("launches a scoping session after creating a sub-task", async () => {
    const onCreateSubTask = vi.fn().mockResolvedValue({
      id: "child",
      path: "Tasks/todo/child.md",
      title: "Child focus",
    });
    const { panel, terminalPanel } = createListPanel({ onCreateSubTask });
    const parent = makeItem("parent", "Parent");

    await (panel as any).createSubTask(parent, "todo", "Child focus");

    expect(terminalPanel.spawnClaudeWithPrompt).toHaveBeenCalledWith(
      expect.stringContaining(
        "Read the parent task file at /vault/Tasks/parent.md and the new sub-task file at /vault/Tasks/todo/child.md.",
      ),
      "Sub-task scope",
      undefined,
    );
    expect(terminalPanel.spawnClaudeWithPrompt.mock.calls[0][0]).toContain(
      "The new file currently uses a temporary placeholder title and pending filename.",
    );
    expect(terminalPanel.spawnClaudeWithPrompt.mock.calls[0][0]).toContain(
      "User provided this description of the intended scope for this sub-task: Child focus.",
    );
  });

  it("pins a new sub-task directly under a pinned parent", async () => {
    const onCreateSubTask = vi.fn().mockResolvedValue({
      id: "child",
      path: "Tasks/todo/child.md",
      title: "Child focus",
    });
    const { panel } = createListPanel({ onCreateSubTask });
    const pinStore = createMockPinStore(["parent"]);
    panel.setPinStore(pinStore as any);

    const parent = makeItem("parent", "Parent");
    panel.render({ todo: [parent] }, { todo: ["parent"] });

    await (panel as any).createSubTask(parent, "__pinned__", "Child focus");

    expect(pinStore.pin).toHaveBeenCalledWith("child");
    expect(pinStore.reorder).toHaveBeenCalledWith(["parent", "child"]);
    const pinnedCards = Array.from(
      document.querySelectorAll('[data-column="__pinned__"] [data-item-id]'),
    );
    expect(pinnedCards.map((el) => el.getAttribute("data-item-id"))).toEqual(["parent", "child"]);
    const childEl = document.querySelector(
      '[data-column="__pinned__"] [data-item-id="child"]',
    ) as HTMLElement;
    expect(childEl.classList.contains("wt-card-subtask")).toBe(true);
  });

  it("still renders a new sub-task when pin mirroring fails", async () => {
    const onCreateSubTask = vi.fn().mockResolvedValue({
      id: "child",
      path: "Tasks/todo/child.md",
      title: "Child focus",
    });
    const { panel } = createListPanel({ onCreateSubTask });
    const pinStore = createMockPinStore(["parent"]);
    pinStore.reorder.mockRejectedValueOnce(new Error("write failed"));
    panel.setPinStore(pinStore as any);

    const parent = makeItem("parent", "Parent");
    panel.render({ todo: [parent] }, { todo: ["parent"] });

    await (panel as any).createSubTask(parent, "__pinned__", "Child focus");

    expect(document.querySelector('[data-item-id="child"]')).not.toBeNull();
    expect(noticeMock).toHaveBeenCalledWith(
      "Sub-task created, but pin mirroring failed. See console for details.",
    );
    expect(noticeMock).toHaveBeenCalledWith("Created sub-task: Child focus");
  });

  it("shows a notice when sub-task scoping session launch fails", async () => {
    const onCreateSubTask = vi.fn().mockResolvedValue({
      id: "child",
      path: "Tasks/todo/child.md",
      title: "Child focus",
    });
    const { panel, terminalPanel } = createListPanel({ onCreateSubTask });
    terminalPanel.spawnClaudeWithPrompt.mockRejectedValueOnce(new Error("spawn failed"));

    await (panel as any).createSubTask(makeItem("parent", "Parent"), "todo", "Child focus");
    await Promise.resolve();

    expect(noticeMock).toHaveBeenCalledWith(
      "Failed to start scoping session. See console for details.",
    );
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
    const successBar = cardEl.querySelector(".wt-success-bar");
    expect(successBar?.textContent).toBe("new ticket created");

    vi.advanceTimersByTime(4500);

    expect(cardEl.classList.contains("wt-card-new-success")).toBe(false);
    expect(cardEl.querySelector(".wt-success-bar")).toBeNull();
  });

  it("measures the rerendered success bar after the card is attached to the DOM", () => {
    const { panel } = createListPanel();
    panel.render({ todo: [] }, {});

    panel.prependToColumn("task-1", "todo", "placeholder-1");
    panel.resolvePlaceholder("placeholder-1", true);
    panel.render({ todo: [makeItem("task-1")] }, { todo: ["task-1"] });

    const slot = document.querySelector(
      '[data-item-id="task-1"] > .wt-success-bar-slot',
    ) as HTMLElement;
    expect(slot.style.getPropertyValue("--wt-success-bar-height")).toBe("18px");
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

  it("hides the active success bar with its card when filtering removes the match", () => {
    const { panel } = createListPanel();
    panel.render({ todo: [] }, {});

    panel.prependToColumn("task-1", "todo", "placeholder-1");
    panel.resolvePlaceholder("placeholder-1", true);
    panel.render({ todo: [makeItem("task-1")] }, { todo: ["task-1"] });

    const cardEl = document.querySelector('[data-item-id="task-1"]') as HTMLElement;
    const filterEl = document.querySelector(".wt-filter-input") as HTMLInputElement;

    expect(cardEl.querySelector(".wt-success-bar")).not.toBeNull();

    filterEl.value = "no match";
    filterEl.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    vi.advanceTimersByTime(100);

    expect(cardEl.style.display).toBe("none");
    expect(cardEl.querySelector(".wt-success-bar")).not.toBeNull();
    expect(document.querySelector(".wt-section")?.getAttribute("style")).toContain("display: none");
  });

  it("inserts and removes the ingesting badge exactly once", () => {
    const { panel } = createListPanel({ includeMetaRow: true });
    panel.render({ todo: [makeItem("task-1")] }, {});

    panel.setIngesting("task-1");
    panel.setIngesting("task-1");

    const cardEl = document.querySelector('[data-item-id="task-1"]') as HTMLElement;
    const badges = cardEl.querySelectorAll(".wt-card-ingesting-badge");
    expect(badges).toHaveLength(1);
    expect(badges[0].parentElement?.classList.contains("wt-card-meta")).toBe(true);

    panel.clearIngesting("task-1");

    expect(cardEl.querySelector(".wt-card-ingesting-badge")).toBeNull();
  });

  it("keeps placeholder visible until the real card renders", () => {
    const { panel } = createListPanel();
    panel.render({ todo: [] }, {});

    // Simulate: placeholder added, file created, prependToColumn called
    panel.addPlaceholder("placeholder-1");
    panel.prependToColumn("task-1", "todo", "placeholder-1");

    // Before the real card renders, placeholder should still be in the DOM
    let cardsEl = document.querySelector('[data-column="todo"] .wt-section-cards') as HTMLElement;
    expect(cardsEl.querySelector(".wt-card-placeholder")).not.toBeNull();

    // Render with the real card - placeholder should be auto-resolved
    panel.render({ todo: [makeItem("task-1")] }, { todo: ["task-1"] });

    // Re-query after render() since it rebuilds the DOM
    cardsEl = document.querySelector('[data-column="todo"] .wt-section-cards') as HTMLElement;
    expect(cardsEl.querySelector(".wt-card-placeholder")).toBeNull();
    expect(
      document.querySelector('[data-item-id="task-1"]')?.classList.contains("wt-card-new-success"),
    ).toBe(true);
  });

  it("preserves placeholder across re-renders when card has not yet appeared", () => {
    const { panel } = createListPanel();
    panel.render({ todo: [] }, {});

    panel.addPlaceholder("placeholder-1");
    panel.prependToColumn("task-1", "todo", "placeholder-1");

    // Re-render without the card (metadata cache hasn't updated yet)
    panel.render({ todo: [] }, {});

    const cardsEl = document.querySelector('[data-column="todo"] .wt-section-cards') as HTMLElement;
    expect(cardsEl.querySelector(".wt-card-placeholder")).not.toBeNull();
    expect(cardsEl.querySelector(".wt-card-placeholder")?.textContent).toBe("Ingesting...");
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

  it("can preselect an item before its card is rendered", () => {
    const { panel, onSelect } = createListPanel();
    const item = makeItem("new-task", "New task");

    panel.selectById(item.id, item);

    expect((panel as any).selectedId).toBe(item.id);
    expect(onSelect).toHaveBeenCalledWith(item);

    panel.render({ todo: [item] }, { todo: [] });

    expect(
      document.querySelector(`[data-item-id="${item.id}"]`)?.classList.contains("wt-card-selected"),
    ).toBe(true);
  });

  it("rekeys stored order and ID-keyed UI state when a task gets a durable ID", () => {
    const { panel } = createListPanel();
    const oldId = "2 - Areas/Tasks/todo/task-1.md";
    const newId = "uuid-123";
    const item = {
      ...makeItem(oldId, "Backfilled task"),
      path: oldId,
    };

    panel.render({ todo: [item] }, { todo: [oldId, newId] });
    (panel as any).selectedId = oldId;
    (panel as any).dragSourceId = oldId;
    panel.updateAgentState(oldId, "idle");

    const changed = panel.rekeyCustomOrder(oldId, newId);

    expect(changed).toBe(true);
    expect(panel.getCustomOrder()).toEqual({ todo: [newId] });
    expect((panel as any).selectedId).toBe(newId);
    expect((panel as any).dragSourceId).toBe(newId);
    expect((panel as any).agentStates.get(newId)).toBe("idle");
    expect((panel as any).agentStates.has(oldId)).toBe(false);
    expect((panel as any).idleSinceMap.has(newId)).toBe(true);
    expect((panel as any).idleSinceMap.has(oldId)).toBe(false);
  });

  it("restarts active success animations under the new task ID", () => {
    const { panel } = createListPanel();
    const oldId = "2 - Areas/Tasks/todo/task-1.md";
    const newId = "uuid-123";
    const oldItem = {
      ...makeItem(oldId, "Backfilled task"),
      path: oldId,
    };
    const newItem = {
      ...oldItem,
      id: newId,
    };

    panel.render({ todo: [oldItem] }, { todo: [oldId] });
    (panel as any).applyNewSuccessAnimation(oldId);

    const changed = panel.rekeyCustomOrder(oldId, newId);
    panel.render({ todo: [newItem] }, { todo: [newId] });

    expect(changed).toBe(true);
    const cardEl = document.querySelector(`[data-item-id="${newId}"]`) as HTMLElement | null;
    expect(cardEl?.classList.contains("wt-card-new-success")).toBe(true);

    vi.advanceTimersByTime(4500);

    expect(cardEl?.classList.contains("wt-card-new-success")).toBe(false);
    expect((panel as any).activeSuccessIds.has(newId)).toBe(false);
    expect((panel as any).successTimeouts.has(newId)).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Pinned section
  // ---------------------------------------------------------------------------

  function createMockPinStore(pinnedIds: string[] = []) {
    const ids = [...pinnedIds];
    return {
      getPinnedIds: vi.fn(() => [...ids]),
      isPinned: vi.fn((id: string) => ids.includes(id)),
      pin: vi.fn(async (id: string) => {
        if (!ids.includes(id)) ids.push(id);
      }),
      unpin: vi.fn(async (id: string) => {
        const idx = ids.indexOf(id);
        if (idx >= 0) ids.splice(idx, 1);
      }),
      toggle: vi.fn(async (id: string) => {
        const idx = ids.indexOf(id);
        if (idx >= 0) {
          ids.splice(idx, 1);
          return false;
        }
        ids.push(id);
        return true;
      }),
      reorder: vi.fn(async (newOrder: string[]) => {
        ids.length = 0;
        ids.push(...newOrder);
      }),
      rekey: vi.fn((oldId: string, newId: string) => {
        const idx = ids.indexOf(oldId);
        if (idx < 0) return false;
        ids[idx] = newId;
        return true;
      }),
      load: vi.fn(async () => {}),
    };
  }

  it("renders a pinned section above regular columns when items are pinned", () => {
    const { panel } = createListPanel();
    const pinStore = createMockPinStore(["task-1"]);
    panel.setPinStore(pinStore as any);

    const item1 = makeItem("task-1", "Pinned Task");
    const item2 = makeItem("task-2", "Regular Task");

    panel.render({ todo: [item1, item2] }, {});

    const sections = Array.from(document.querySelectorAll(".wt-section"));
    expect(sections.length).toBe(2); // pinned + todo
    expect(sections[0].getAttribute("data-column")).toBe("__pinned__");
    expect(sections[1].getAttribute("data-column")).toBe("todo");

    // Pinned section has the item
    const pinnedCards = sections[0].querySelectorAll("[data-item-id]");
    expect(pinnedCards.length).toBe(1);
    expect(pinnedCards[0].getAttribute("data-item-id")).toBe("task-1");

    // Regular column excludes the pinned item
    const todoCards = sections[1].querySelectorAll("[data-item-id]");
    expect(todoCards.length).toBe(1);
    expect(todoCards[0].getAttribute("data-item-id")).toBe("task-2");
  });

  it("does not render pinned section when no items are pinned", () => {
    const { panel } = createListPanel();
    const pinStore = createMockPinStore([]);
    panel.setPinStore(pinStore as any);

    panel.render({ todo: [makeItem("task-1")] }, {});

    const sections = Array.from(document.querySelectorAll(".wt-section"));
    expect(sections.length).toBe(1);
    expect(sections[0].getAttribute("data-column")).toBe("todo");
  });

  it("adds wt-card-pinned class to pinned cards", () => {
    const { panel } = createListPanel({ includeMetaRow: true });
    const pinStore = createMockPinStore(["task-1"]);
    panel.setPinStore(pinStore as any);

    panel.render({ todo: [makeItem("task-1")] }, {});

    const card = document.querySelector('[data-item-id="task-1"]');
    expect(card?.classList.contains("wt-card-pinned")).toBe(true);
  });

  it("shows real state badge on pinned cards", () => {
    const { panel } = createListPanel({
      columns: [
        { id: "priority", label: "Priority", folderName: "priority" },
        { id: "todo", label: "To Do", folderName: "todo" },
      ],
      includeMetaRow: true,
    });
    const pinStore = createMockPinStore(["task-1"]);
    panel.setPinStore(pinStore as any);

    const item = { ...makeItem("task-1"), state: "priority" };
    panel.render({ priority: [item] }, {});

    const badge = document.querySelector(".wt-card-state-badge");
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe("Priority");
    expect(badge?.classList.contains("wt-state-badge-priority")).toBe(true);
  });

  it("exposes isPinned in card action context", () => {
    const { panel } = createListPanel();
    const pinStore = createMockPinStore(["task-1"]);
    panel.setPinStore(pinStore as any);

    const item = makeItem("task-1");
    const ctx = (panel as any).buildCardActionContext(item, "todo");

    expect(ctx.isPinned?.()).toBe(true);
  });

  it("returns isPinned false when item is not pinned", () => {
    const { panel } = createListPanel();
    const pinStore = createMockPinStore([]);
    panel.setPinStore(pinStore as any);

    const item = makeItem("task-1");
    const ctx = (panel as any).buildCardActionContext(item, "todo");

    expect(ctx.isPinned?.()).toBe(false);
  });

  it("returns an awaitable onUnpin action context callback", async () => {
    const { panel, onSelect } = createListPanel();
    const item = makeItem("task-1");
    const ids = ["task-1"];
    let resolveUnpin!: () => void;
    const unpinFinished = new Promise<void>((resolve) => {
      resolveUnpin = () => {
        const idx = ids.indexOf(item.id);
        if (idx >= 0) ids.splice(idx, 1);
        resolve();
      };
    });
    const pinStore = {
      ...createMockPinStore(["task-1"]),
      getPinnedIds: vi.fn(() => [...ids]),
      isPinned: vi.fn((id: string) => ids.includes(id)),
      unpin: vi.fn(() => unpinFinished),
    };
    panel.setPinStore(pinStore as any);
    panel.render({ todo: [item] }, {});

    const ctx = (panel as any).buildCardActionContext(item, "todo");
    const unpinResult = ctx.onUnpin?.();

    expect(unpinResult).toBeInstanceOf(Promise);
    let settled = false;
    void unpinResult.then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(pinStore.unpin).toHaveBeenCalledWith("task-1");

    resolveUnpin();
    await unpinResult;

    expect(settled).toBe(true);
    expect(onSelect).toHaveBeenLastCalledWith(item);
    expect(document.querySelector('[data-column="__pinned__"]')).toBeNull();
  });

  it("rekeys pinned items when rekeyCustomOrder is called", () => {
    const { panel } = createListPanel();
    const pinStore = createMockPinStore(["old-id"]);
    panel.setPinStore(pinStore as any);

    panel.render({ todo: [makeItem("old-id")] }, { todo: ["old-id"] });

    const changed = panel.rekeyCustomOrder("old-id", "new-id");

    expect(changed).toBe(true);
    expect(pinStore.rekey).toHaveBeenCalledWith("old-id", "new-id");
  });

  it("renders pinned items in pinned ID order, not by custom column order", () => {
    const { panel } = createListPanel();
    const pinStore = createMockPinStore(["task-2", "task-1"]);
    panel.setPinStore(pinStore as any);

    const item1 = makeItem("task-1", "First");
    const item2 = makeItem("task-2", "Second");

    panel.render({ todo: [item1, item2] }, {});

    const pinnedCards = Array.from(
      document.querySelectorAll('[data-column="__pinned__"] [data-item-id]'),
    );
    expect(pinnedCards.map((el) => el.getAttribute("data-item-id"))).toEqual(["task-2", "task-1"]);
  });

  it("works without a pin store (backward-compatible)", () => {
    const { panel } = createListPanel();
    // No pinStore set - should render normally without errors

    panel.render({ todo: [makeItem("task-1")] }, {});

    const sections = Array.from(document.querySelectorAll(".wt-section"));
    expect(sections.length).toBe(1);
    expect(sections[0].getAttribute("data-column")).toBe("todo");
  });

  describe("dynamic columns", () => {
    it("skips empty dynamic columns persisted in config", () => {
      // Dynamic columns (no folderName) with zero items should not render
      const { panel } = createListPanel({
        columns: [
          { id: "todo", label: "To Do", folderName: "todo" },
          { id: "review", label: "Review", folderName: undefined as any },
        ],
      });

      panel.render({ todo: [makeItem("task-1")] }, {});

      const sections = Array.from(document.querySelectorAll(".wt-section"));
      expect(sections.length).toBe(1);
      expect(sections[0].getAttribute("data-column")).toBe("todo");
    });

    it("renders dynamic columns that have items", () => {
      const { panel } = createListPanel({
        columns: [
          { id: "todo", label: "To Do", folderName: "todo" },
          { id: "review", label: "Review", folderName: undefined as any },
        ],
      });

      const reviewItem = { ...makeItem("task-2"), state: "review" };
      panel.render({ todo: [makeItem("task-1")], review: [reviewItem] }, {});

      const sections = Array.from(document.querySelectorAll(".wt-section"));
      expect(sections.length).toBe(2);
      expect(sections[1].getAttribute("data-column")).toBe("review");
    });

    it("always renders built-in columns even when empty", () => {
      const { panel } = createListPanel({
        columns: [
          { id: "todo", label: "To Do", folderName: "todo" },
          { id: "active", label: "Active", folderName: "active" },
        ],
      });

      panel.render({ todo: [makeItem("task-1")] }, {});

      const sections = Array.from(document.querySelectorAll(".wt-section"));
      expect(sections.length).toBe(2);
      expect(sections[0].getAttribute("data-column")).toBe("todo");
      expect(sections[1].getAttribute("data-column")).toBe("active");
    });

    it("sanitizes column IDs in CSS class names", () => {
      const { panel } = createListPanel({
        columns: [{ id: "blocked upstream", label: "Blocked Upstream", folderName: "todo" }],
      });

      panel.render({ "blocked upstream": [makeItem("task-1")] }, {});

      const header = document.querySelector(".wt-section-header");
      expect(header?.classList.contains("wt-section-header-blocked-upstream")).toBe(true);
      // Should not contain the raw unsanitized class
      expect(header?.classList.contains("wt-section-header-blocked upstream")).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Session filter toggle
  // ---------------------------------------------------------------------------

  describe("session filter", () => {
    it("renders the session filter checkbox in the filter container", () => {
      createListPanel();

      const checkbox = document.querySelector(".wt-session-filter-checkbox") as HTMLInputElement;
      expect(checkbox).not.toBeNull();
      expect(checkbox.type).toBe("checkbox");
      expect(checkbox.checked).toBe(false);

      const label = document.querySelector(".wt-session-filter-label");
      expect(label).not.toBeNull();
      expect(label?.textContent).toBe("Active sessions only");
    });

    it("hides cards without active sessions when the toggle is checked", () => {
      const { panel, terminalPanel } = createListPanel();
      terminalPanel.getSessionItemIds.mockReturnValue(["task-1"]);

      panel.render({ todo: [makeItem("task-1"), makeItem("task-2")] }, {});

      const checkbox = document.querySelector(".wt-session-filter-checkbox") as HTMLInputElement;
      checkbox.checked = true;
      checkbox.dispatchEvent(new dom.window.Event("change", { bubbles: true }));

      const card1 = document.querySelector('[data-item-id="task-1"]') as HTMLElement;
      const card2 = document.querySelector('[data-item-id="task-2"]') as HTMLElement;
      expect(card1.style.display).toBe("");
      expect(card2.style.display).toBe("none");
    });

    it("shows all cards when the toggle is unchecked", () => {
      const { panel, terminalPanel } = createListPanel();
      terminalPanel.getSessionItemIds.mockReturnValue(["task-1"]);

      panel.render({ todo: [makeItem("task-1"), makeItem("task-2")] }, {});

      const checkbox = document.querySelector(".wt-session-filter-checkbox") as HTMLInputElement;

      // Enable filter
      checkbox.checked = true;
      checkbox.dispatchEvent(new dom.window.Event("change", { bubbles: true }));

      // Disable filter
      checkbox.checked = false;
      checkbox.dispatchEvent(new dom.window.Event("change", { bubbles: true }));

      const card1 = document.querySelector('[data-item-id="task-1"]') as HTMLElement;
      const card2 = document.querySelector('[data-item-id="task-2"]') as HTMLElement;
      expect(card1.style.display).toBe("");
      expect(card2.style.display).toBe("");
    });

    it("combines session filter with text filter", () => {
      const { panel, terminalPanel } = createListPanel();
      terminalPanel.getSessionItemIds.mockReturnValue(["task-1", "task-2"]);

      panel.render(
        {
          todo: [
            makeItem("task-1", "Alpha"),
            makeItem("task-2", "Beta"),
            makeItem("task-3", "Alpha Clone"),
          ],
        },
        {},
      );

      // Enable session filter
      const checkbox = document.querySelector(".wt-session-filter-checkbox") as HTMLInputElement;
      checkbox.checked = true;
      checkbox.dispatchEvent(new dom.window.Event("change", { bubbles: true }));

      // Also apply text filter for "Alpha"
      const filterEl = document.querySelector(".wt-filter-input") as HTMLInputElement;
      filterEl.value = "alpha";
      filterEl.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      vi.advanceTimersByTime(100);

      // task-1 matches both filters (has session + matches "alpha")
      const card1 = document.querySelector('[data-item-id="task-1"]') as HTMLElement;
      expect(card1.style.display).toBe("");

      // task-2 has session but does not match "alpha"
      const card2 = document.querySelector('[data-item-id="task-2"]') as HTMLElement;
      expect(card2.style.display).toBe("none");

      // task-3 matches "alpha" but has no session
      const card3 = document.querySelector('[data-item-id="task-3"]') as HTMLElement;
      expect(card3.style.display).toBe("none");
    });

    it("hides sections with no visible cards when session filter is active", () => {
      const { panel, terminalPanel } = createListPanel({
        columns: [
          { id: "todo", label: "To Do", folderName: "todo" },
          { id: "active", label: "Active", folderName: "active" },
        ],
      });
      terminalPanel.getSessionItemIds.mockReturnValue(["task-2"]);

      const activeItem = { ...makeItem("task-2"), state: "active" };
      panel.render({ todo: [makeItem("task-1")], active: [activeItem] }, {});

      const checkbox = document.querySelector(".wt-session-filter-checkbox") as HTMLInputElement;
      checkbox.checked = true;
      checkbox.dispatchEvent(new dom.window.Event("change", { bubbles: true }));

      const todoSection = document.querySelector('[data-column="todo"]') as HTMLElement;
      const activeSection = document.querySelector('[data-column="active"]') as HTMLElement;
      expect(todoSection.style.display).toBe("none");
      expect(activeSection.style.display).toBe("");
    });

    it("calls onSessionFilterChange when the toggle is clicked", () => {
      const onSessionFilterChange = vi.fn();
      createListPanel({ onSessionFilterChange });

      const checkbox = document.querySelector(".wt-session-filter-checkbox") as HTMLInputElement;
      checkbox.checked = true;
      checkbox.dispatchEvent(new dom.window.Event("change", { bubbles: true }));

      expect(onSessionFilterChange).toHaveBeenCalledWith(true);

      checkbox.checked = false;
      checkbox.dispatchEvent(new dom.window.Event("change", { bubbles: true }));

      expect(onSessionFilterChange).toHaveBeenCalledWith(false);
    });

    it("restores session filter state from settings", () => {
      createListPanel({
        settings: { "core.sessionFilterActive": true },
      });

      const checkbox = document.querySelector(".wt-session-filter-checkbox") as HTMLInputElement;
      expect(checkbox.checked).toBe(true);
    });

    it("re-applies session filter when session badges update", () => {
      const { panel, terminalPanel } = createListPanel();

      panel.render({ todo: [makeItem("task-1"), makeItem("task-2")] }, {});

      // Enable session filter with task-1 having a session
      terminalPanel.getSessionItemIds.mockReturnValue(["task-1"]);
      const checkbox = document.querySelector(".wt-session-filter-checkbox") as HTMLInputElement;
      checkbox.checked = true;
      checkbox.dispatchEvent(new dom.window.Event("change", { bubbles: true }));

      const card2 = document.querySelector('[data-item-id="task-2"]') as HTMLElement;
      expect(card2.style.display).toBe("none");

      // Now task-2 also gets a session - updateSessionBadges should re-apply filter
      terminalPanel.getSessionItemIds.mockReturnValue(["task-1", "task-2"]);
      panel.updateSessionBadges();

      expect(card2.style.display).toBe("");
    });
  });

  describe("comfortable display mode", () => {
    it("adds wt-comfortable class to list panel when cardDisplayMode is comfortable", () => {
      const { panel } = createListPanel({
        settings: { "core.cardDisplayMode": "comfortable" },
      });
      panel.render({ todo: [makeItem("task-1")] }, {});

      const listEl = document.querySelector(".wt-list-panel") as HTMLElement;
      expect(listEl.classList.contains("wt-comfortable")).toBe(true);
    });

    it("does not add wt-comfortable class when cardDisplayMode is standard", () => {
      const { panel } = createListPanel({
        settings: { "core.cardDisplayMode": "standard" },
      });
      panel.render({ todo: [makeItem("task-1")] }, {});

      const listEl = document.querySelector(".wt-list-panel") as HTMLElement;
      expect(listEl.classList.contains("wt-comfortable")).toBe(false);
    });

    it("does not add wt-comfortable class when cardDisplayMode is not set", () => {
      const { panel } = createListPanel({
        settings: {},
      });
      panel.render({ todo: [makeItem("task-1")] }, {});

      const listEl = document.querySelector(".wt-list-panel") as HTMLElement;
      expect(listEl.classList.contains("wt-comfortable")).toBe(false);
    });

    it("removes wt-comfortable class when mode changes from comfortable to standard", () => {
      const settings: Record<string, any> = { "core.cardDisplayMode": "comfortable" };
      const { panel } = createListPanel({ settings });

      panel.render({ todo: [makeItem("task-1")] }, {});
      const listEl = document.querySelector(".wt-list-panel") as HTMLElement;
      expect(listEl.classList.contains("wt-comfortable")).toBe(true);

      // Simulate settings change
      settings["core.cardDisplayMode"] = "standard";
      panel.render({ todo: [makeItem("task-1")] }, {});

      expect(listEl.classList.contains("wt-comfortable")).toBe(false);
    });

    it("passes comfortable displayMode to card renderer", () => {
      const renderSpy = vi.fn((_item: WorkItem) => {
        const el = document.createElement("div");
        el.createDiv({ cls: "wt-card-actions" });
        return el;
      });

      const { panel } = createListPanel({
        settings: { "core.cardDisplayMode": "comfortable" },
      });

      const cardRenderer = (panel as any).cardRenderer;
      cardRenderer.render = renderSpy;

      panel.render({ todo: [makeItem("task-1")] }, {});

      expect(renderSpy).toHaveBeenCalledWith(
        expect.objectContaining({ id: "task-1" }),
        expect.anything(),
        "comfortable",
      );
    });
  });

  describe("compact display mode", () => {
    it("adds wt-compact class to list panel when cardDisplayMode is compact", () => {
      const { panel } = createListPanel({
        settings: { "core.cardDisplayMode": "compact" },
      });
      panel.render({ todo: [makeItem("task-1")] }, {});

      const listEl = document.querySelector(".wt-list-panel") as HTMLElement;
      expect(listEl.classList.contains("wt-compact")).toBe(true);
    });

    it("does not add wt-compact class when cardDisplayMode is standard", () => {
      const { panel } = createListPanel({
        settings: { "core.cardDisplayMode": "standard" },
      });
      panel.render({ todo: [makeItem("task-1")] }, {});

      const listEl = document.querySelector(".wt-list-panel") as HTMLElement;
      expect(listEl.classList.contains("wt-compact")).toBe(false);
    });

    it("does not add wt-compact class when cardDisplayMode is not set", () => {
      const { panel } = createListPanel({
        settings: {},
      });
      panel.render({ todo: [makeItem("task-1")] }, {});

      const listEl = document.querySelector(".wt-list-panel") as HTMLElement;
      expect(listEl.classList.contains("wt-compact")).toBe(false);
    });

    it("removes wt-compact class when mode changes from compact to standard", () => {
      const settings: Record<string, unknown> = { "core.cardDisplayMode": "compact" };
      const { panel } = createListPanel({ settings });

      panel.render({ todo: [makeItem("task-1")] }, {});
      const listEl = document.querySelector(".wt-list-panel") as HTMLElement;
      expect(listEl.classList.contains("wt-compact")).toBe(true);

      // Simulate settings change
      settings["core.cardDisplayMode"] = "standard";
      panel.render({ todo: [makeItem("task-1")] }, {});

      expect(listEl.classList.contains("wt-compact")).toBe(false);
    });

    it("passes displayMode to card renderer", () => {
      const renderSpy = vi.fn((_item: WorkItem) => {
        const el = document.createElement("div");
        el.createDiv({ cls: "wt-card-actions" });
        return el;
      });

      const { panel } = createListPanel({
        settings: { "core.cardDisplayMode": "compact" },
      });

      // Replace the card renderer's render with a spy to verify the displayMode argument
      const cardRenderer = (panel as any).cardRenderer;
      cardRenderer.render = renderSpy;

      panel.render({ todo: [makeItem("task-1")] }, {});

      expect(renderSpy).toHaveBeenCalledWith(
        expect.objectContaining({ id: "task-1" }),
        expect.anything(),
        "compact",
      );
    });

    it("picks up a new settings object via updateSettings on the next render", () => {
      const { panel } = createListPanel({
        settings: { "core.cardDisplayMode": "standard" },
      });
      panel.render({ todo: [makeItem("task-1")] }, {});

      const listEl = document.querySelector(".wt-list-panel") as HTMLElement;
      expect(listEl.classList.contains("wt-compact")).toBe(false);

      // MainView replaces the settings object on change
      panel.updateSettings({ "core.cardDisplayMode": "compact" });
      panel.render({ todo: [makeItem("task-1")] }, {});

      expect(listEl.classList.contains("wt-compact")).toBe(true);

      // Switch back to standard
      panel.updateSettings({ "core.cardDisplayMode": "standard" });
      panel.render({ todo: [makeItem("task-1")] }, {});

      expect(listEl.classList.contains("wt-compact")).toBe(false);
    });

    it("passes standard displayMode to card renderer when not compact", () => {
      const renderSpy = vi.fn((_item: WorkItem) => {
        const el = document.createElement("div");
        el.createDiv({ cls: "wt-card-actions" });
        return el;
      });

      const { panel } = createListPanel({
        settings: { "core.cardDisplayMode": "standard" },
      });

      const cardRenderer = (panel as any).cardRenderer;
      cardRenderer.render = renderSpy;

      panel.render({ todo: [makeItem("task-1")] }, {});

      expect(renderSpy).toHaveBeenCalledWith(
        expect.objectContaining({ id: "task-1" }),
        expect.anything(),
        "standard",
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Activity mode
  // ---------------------------------------------------------------------------

  function makeMockTracker(bucketMap: Record<string, string>) {
    return {
      getBucket: (itemId: string) => bucketMap[itemId] || "older",
      recordActivity: vi.fn(),
      seedTimestamp: vi.fn(),
      getTimestamp: vi.fn(),
      rekey: vi.fn(),
      dispose: vi.fn(),
      setFlushCallback: vi.fn(),
    };
  }

  describe("activity mode", () => {
    it("groups items into activity buckets instead of kanban columns", () => {
      const { panel } = createListPanel({
        columns: [
          { id: "active", label: "Active", folderName: "active" },
          { id: "todo", label: "To Do", folderName: "todo" },
        ],
        settings: { "core.viewMode": "activity", "core.recentThreshold": "3h" },
      });

      panel.setActivityTracker(
        makeMockTracker({
          "task-1": "recent",
          "task-2": "recent",
          "task-3": "last-7-days",
          "task-4": "older",
        }) as any,
      );

      const groups = {
        active: [makeItem("task-1"), makeItem("task-3")],
        todo: [makeItem("task-2"), makeItem("task-4")],
      };
      panel.render(groups, {});

      const sections = Array.from(document.querySelectorAll(".wt-section"));
      const sectionColumns = sections.map((s) => s.getAttribute("data-column"));
      expect(sectionColumns).toEqual(["recent", "last-7-days", "older"]);

      const recentCards = Array.from(
        document.querySelectorAll('[data-column="recent"] .wt-card-wrapper'),
      );
      expect(recentCards.map((c) => c.getAttribute("data-item-id"))).toEqual(["task-1", "task-2"]);
    });

    it("respects custom order within activity buckets", () => {
      const { panel } = createListPanel({
        settings: { "core.viewMode": "activity", "core.recentThreshold": "3h" },
      });

      panel.setActivityTracker(
        makeMockTracker({
          "task-1": "recent",
          "task-2": "recent",
          "task-3": "recent",
        }) as any,
      );

      const groups = {
        todo: [makeItem("task-1"), makeItem("task-2"), makeItem("task-3")],
      };
      panel.render(groups, { recent: ["task-3", "task-1", "task-2"] });

      const recentCards = Array.from(
        document.querySelectorAll('[data-column="recent"] .wt-card-wrapper'),
      );
      expect(recentCards.map((c) => c.getAttribute("data-item-id"))).toEqual([
        "task-3",
        "task-1",
        "task-2",
      ]);
    });

    it("drag-drop reorders within an activity bucket using DOM-derived order", () => {
      const onCustomOrderChange = vi.fn();
      const { panel } = createListPanel({
        settings: { "core.viewMode": "activity", "core.recentThreshold": "3h" },
        onCustomOrderChange,
      });

      panel.setActivityTracker(
        makeMockTracker({
          "task-1": "recent",
          "task-2": "recent",
          "task-3": "recent",
        }) as any,
      );

      const groups = {
        todo: [makeItem("task-1"), makeItem("task-2"), makeItem("task-3")],
      };
      panel.render(groups, {});

      // "recent" is NOT in groups (groups has "todo"), so reorderWithinSection
      // must fall back to DOM-based order reading.
      (panel as any).reorderWithinSection("recent", "task-3", 0);

      expect(onCustomOrderChange).toHaveBeenCalled();
      const lastCall = onCustomOrderChange.mock.calls[onCustomOrderChange.mock.calls.length - 1][0];
      expect(lastCall["recent"]).toEqual(["task-3", "task-1", "task-2"]);
    });

    it("cross-bucket drag is treated as reorder in destination bucket", () => {
      const onCustomOrderChange = vi.fn();
      const { panel } = createListPanel({
        settings: { "core.viewMode": "activity", "core.recentThreshold": "3h" },
        onCustomOrderChange,
      });

      panel.setActivityTracker(
        makeMockTracker({
          "task-1": "recent",
          "task-2": "last-7-days",
          "task-3": "last-7-days",
        }) as any,
      );

      const groups = {
        todo: [makeItem("task-1"), makeItem("task-2"), makeItem("task-3")],
      };
      panel.render(groups, {});

      (panel as any).reorderWithinSection("last-7-days", "task-3", 0);

      expect(onCustomOrderChange).toHaveBeenCalled();
      const lastCall = onCustomOrderChange.mock.calls[onCustomOrderChange.mock.calls.length - 1][0];
      expect(lastCall["last-7-days"]).toEqual(["task-3", "task-2"]);
    });

    it("places item at top of destination bucket on bucket crossing", () => {
      const onCustomOrderChange = vi.fn();
      const { panel } = createListPanel({
        settings: { "core.viewMode": "activity", "core.recentThreshold": "3h" },
        onCustomOrderChange,
      });

      // First render: task-1 is in "recent"
      panel.setActivityTracker(
        makeMockTracker({
          "task-1": "recent",
          "task-2": "last-7-days",
          "task-3": "last-7-days",
        }) as any,
      );

      const groups = {
        todo: [makeItem("task-1"), makeItem("task-2"), makeItem("task-3")],
      };
      panel.render(groups, { "last-7-days": ["task-2", "task-3"] });
      onCustomOrderChange.mockClear();

      // Second render: task-1 has aged to "last-7-days"
      panel.setActivityTracker(
        makeMockTracker({
          "task-1": "last-7-days",
          "task-2": "last-7-days",
          "task-3": "last-7-days",
        }) as any,
      );

      panel.render(groups, { "last-7-days": ["task-2", "task-3"] });

      expect(onCustomOrderChange).toHaveBeenCalled();
      const lastCall = onCustomOrderChange.mock.calls[onCustomOrderChange.mock.calls.length - 1][0];
      expect(lastCall["last-7-days"][0]).toBe("task-1");
    });

    it("does not trigger bucket crossing on first render", () => {
      const onCustomOrderChange = vi.fn();
      const { panel } = createListPanel({
        settings: { "core.viewMode": "activity", "core.recentThreshold": "3h" },
        onCustomOrderChange,
      });

      panel.setActivityTracker(
        makeMockTracker({ "task-1": "recent", "task-2": "last-7-days" }) as any,
      );

      const groups = { todo: [makeItem("task-1"), makeItem("task-2")] };
      panel.render(groups, {});

      expect(onCustomOrderChange).not.toHaveBeenCalled();
    });

    it("does not trigger crossing when item stays in same bucket", () => {
      const onCustomOrderChange = vi.fn();
      const { panel } = createListPanel({
        settings: { "core.viewMode": "activity", "core.recentThreshold": "3h" },
        onCustomOrderChange,
      });

      panel.setActivityTracker(makeMockTracker({ "task-1": "recent" }) as any);

      const groups = { todo: [makeItem("task-1")] };

      panel.render(groups, {});
      onCustomOrderChange.mockClear();

      panel.render(groups, {});

      expect(onCustomOrderChange).not.toHaveBeenCalled();
    });
  });
});
