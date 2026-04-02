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
    includeMetaRow?: boolean;
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
    hasResumableAgentSessions: vi.fn(() => false),
    getPersistedSessions: vi.fn(() => []),
    getIdleSince: vi.fn(() => null),
    resumeSession: vi.fn(),
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

  it("hides the resume context action when a resumable agent session is already active", () => {
    const item = makeItem("task-1");
    const { panel, terminalPanel } = createListPanel();
    terminalPanel.getPersistedSessions.mockReturnValue([
      {
        version: 2,
        taskPath: "task-1",
        claudeSessionId: "session-1",
        label: "Claude",
        sessionType: "claude",
        savedAt: new Date().toISOString(),
        recoveryMode: "resume",
        cwd: "/vault",
        command: "claude",
        commandArgs: ["claude", "--resume", "session-1"],
      },
    ]);
    terminalPanel.hasResumableAgentSessions.mockReturnValue(true);

    const ctx = (panel as any).buildCardActionContext(item, "todo");

    expect(ctx.hasResumeSessions()).toBe(false);
  });

  it("shows the resume context action when the resume badge is visible", () => {
    const item = makeItem("task-1");
    const { panel, terminalPanel } = createListPanel();
    terminalPanel.getPersistedSessions.mockReturnValue([
      {
        version: 2,
        taskPath: "task-1",
        claudeSessionId: "session-1",
        label: "Claude",
        sessionType: "claude",
        savedAt: new Date().toISOString(),
        recoveryMode: "resume",
        cwd: "/vault",
        command: "claude",
        commandArgs: ["claude", "--resume", "session-1"],
      },
    ]);
    terminalPanel.hasResumableAgentSessions.mockReturnValue(false);

    const ctx = (panel as any).buildCardActionContext(item, "todo");

    expect(ctx.hasResumeSessions()).toBe(true);
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
});
