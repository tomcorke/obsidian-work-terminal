// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskCard } from "./TaskCard";
import type { CardActionContext, CardFlagRule, WorkItem } from "../../core/interfaces";
import { DEFAULT_CARD_FLAGS } from "./TaskAgentConfig";

type CreateChildOptions = { cls?: string; text?: string };
type ObsidianHTMLElementPrototype = typeof HTMLElement.prototype & {
  addClass(cls: string): HTMLElement;
  removeClass(cls: string): HTMLElement;
  createDiv(options?: CreateChildOptions): HTMLDivElement;
  createSpan(options?: CreateChildOptions): HTMLSpanElement;
};

vi.mock("obsidian", () => ({
  Notice: class Notice {
    constructor(_message: string) {}
  },
  setIcon: (el: HTMLElement, iconName: string) => {
    // Simulate Obsidian's setIcon: insert an SVG for known Lucide icon names
    const KNOWN_ICONS = [
      "rocket",
      "terminal",
      "ticket",
      "message-square",
      "file-text",
      "circle",
      "flame",
      "play",
      "list-todo",
      "check",
      "circle-dot",
    ];
    if (KNOWN_ICONS.includes(iconName)) {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("data-icon", iconName);
      el.appendChild(svg);
    }
  },
}));

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
  prototype.createSpan = function (options?: CreateChildOptions) {
    const el = document.createElement("span");
    if (options?.cls) el.classList.add(...options.cls.split(" "));
    if (options?.text) el.textContent = options.text;
    this.appendChild(el);
    return el;
  };
});

function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "task-1",
    path: "2 - Areas/Tasks/priority/task.md",
    title: "Fix context prompt",
    state: "priority",
    metadata: {},
    ...overrides,
  };
}

function makeContext(overrides: Partial<CardActionContext> = {}): CardActionContext {
  return {
    onSelect: vi.fn(),
    onMoveToTop: vi.fn(),
    onMoveToColumn: vi.fn(),
    onInsertAfter: vi.fn(),
    onSplitTask: vi.fn(),
    onDelete: vi.fn(),
    onCloseSessions: vi.fn(),
    getContextPrompt: vi.fn().mockResolvedValue("Task: Fix context prompt\nState: priority"),
    onRetryEnrich: vi.fn(),
    ...overrides,
  };
}

describe("TaskCard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it("copies the exact context prompt from the framework callback", async () => {
    const item = makeItem();
    const ctx = makeContext();
    const card = new TaskCard();

    const menuItems = card.getContextMenuItems(item, ctx);
    const copyItem = menuItems.find(
      (menuItem) => (menuItem as any).title === "Copy Context Prompt",
    ) as { callback: () => Promise<void> } | undefined;

    expect(copyItem).toBeDefined();

    await copyItem?.callback();

    expect(ctx.getContextPrompt).toHaveBeenCalledTimes(1);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "Task: Fix context prompt\nState: priority",
    );
  });

  it("does not write to the clipboard when no Claude context prompt is available", async () => {
    const item = makeItem();
    const ctx = makeContext({
      getContextPrompt: vi.fn().mockResolvedValue(null),
    });
    const card = new TaskCard();

    const menuItems = card.getContextMenuItems(item, ctx);
    const copyItem = menuItems.find(
      (menuItem) => (menuItem as any).title === "Copy Context Prompt",
    ) as { callback: () => Promise<void> } | undefined;

    await copyItem?.callback();

    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(ctx.getContextPrompt).toHaveBeenCalledTimes(1);
  });

  describe("Jira badge rendering", () => {
    it("applies wt-card-source--jira class to Jira source badges", () => {
      const item = makeItem({
        metadata: {
          source: { type: "jira", id: "PROJ-123", url: "", captured: "" },
        },
      });
      const ctx = makeContext();
      const card = new TaskCard();

      const el = card.render(item, ctx);
      const badge = el.querySelector(".wt-card-source") as HTMLElement;

      expect(badge).not.toBeNull();
      expect(badge.textContent).toBe("PROJ-123");
      expect(badge.classList.contains("wt-card-source--jira")).toBe(true);
    });

    it("does not apply wt-card-source--jira class to non-Jira source badges", () => {
      const item = makeItem({
        metadata: {
          source: { type: "slack", id: "", url: "", captured: "" },
        },
      });
      const ctx = makeContext();
      const card = new TaskCard();

      const el = card.render(item, ctx);
      const badge = el.querySelector(".wt-card-source") as HTMLElement;

      expect(badge).not.toBeNull();
      expect(badge.classList.contains("wt-card-source--jira")).toBe(false);
    });
  });

  describe("task color property", () => {
    it("sets --wt-task-color CSS variable when color is provided", () => {
      const item = makeItem({ metadata: { color: "#ff0000" } });
      const ctx = makeContext();
      const card = new TaskCard();

      const el = card.render(item, ctx);

      expect(el.style.getPropertyValue("--wt-task-color")).toBe("#ff0000");
    });

    it("does not set --wt-task-color when no color is provided", () => {
      const item = makeItem({ metadata: {} });
      const ctx = makeContext();
      const card = new TaskCard();

      const el = card.render(item, ctx);

      expect(el.style.getPropertyValue("--wt-task-color")).toBe("");
    });
  });

  describe("goal badge rendering", () => {
    it("strips Obsidian link brackets from goal badges", () => {
      const item = makeItem({
        metadata: {
          goal: ["[[Ship Feature]]"],
        },
      });
      const ctx = makeContext();
      const card = new TaskCard();

      const el = card.render(item, ctx);
      const badge = el.querySelector(".wt-card-goal") as HTMLElement;

      expect(badge.textContent).toBe("Ship Feature");
      expect(badge.title).toBe("Ship Feature");
    });

    it("uses Obsidian link alias text when present", () => {
      const item = makeItem({
        metadata: {
          goal: ["[[Ship Feature|Readable Goal]]"],
        },
      });
      const ctx = makeContext();
      const card = new TaskCard();

      const el = card.render(item, ctx);
      const badge = el.querySelector(".wt-card-goal") as HTMLElement;

      expect(badge.textContent).toBe("Readable Goal");
      expect(badge.title).toBe("Readable Goal");
    });

    it("still replaces hyphens after normalizing the goal text", () => {
      const item = makeItem({
        metadata: {
          goal: ["[[ship-feature]]"],
        },
      });
      const ctx = makeContext();
      const card = new TaskCard();

      const el = card.render(item, ctx);
      const badge = el.querySelector(".wt-card-goal") as HTMLElement;

      expect(badge.textContent).toBe("ship feature");
    });
  });

  describe("enrichment failed badge and retry menu", () => {
    it("renders an enrichment failed badge when backgroundIngestion is failed", () => {
      const item = makeItem({
        metadata: { backgroundIngestion: "failed" },
      });
      const ctx = makeContext();
      const card = new TaskCard();

      const el = card.render(item, ctx);
      const badge = el.querySelector(".wt-card-enrich-failed") as HTMLElement;

      expect(badge).not.toBeNull();
      expect(badge.textContent).toBe("enrichment failed");
    });

    it("does not render enrichment failed badge when backgroundIngestion is absent", () => {
      const item = makeItem({ metadata: {} });
      const ctx = makeContext();
      const card = new TaskCard();

      const el = card.render(item, ctx);
      const badge = el.querySelector(".wt-card-enrich-failed");

      expect(badge).toBeNull();
    });

    it("shows Retry Enrichment context menu item when backgroundIngestion is failed", () => {
      const item = makeItem({
        metadata: { backgroundIngestion: "failed" },
      });
      const ctx = makeContext();
      const card = new TaskCard();

      const menuItems = card.getContextMenuItems(item, ctx);
      const retryItem = menuItems.find(
        (menuItem) => (menuItem as any).title === "Retry Enrichment",
      );

      expect(retryItem).toBeDefined();
    });

    it("does not show Retry Enrichment when backgroundIngestion is not failed", () => {
      const item = makeItem({ metadata: {} });
      const ctx = makeContext();
      const card = new TaskCard();

      const menuItems = card.getContextMenuItems(item, ctx);
      const retryItem = menuItems.find(
        (menuItem) => (menuItem as any).title === "Retry Enrichment",
      );

      expect(retryItem).toBeUndefined();
    });

    it("calls onRetryEnrich when Retry Enrichment is triggered", () => {
      const item = makeItem({
        metadata: { backgroundIngestion: "failed" },
      });
      const ctx = makeContext();
      const card = new TaskCard();

      const menuItems = card.getContextMenuItems(item, ctx);
      const retryItem = menuItems.find(
        (menuItem) => (menuItem as any).title === "Retry Enrichment",
      ) as { callback: () => void } | undefined;

      retryItem?.callback();

      expect(ctx.onRetryEnrich).toHaveBeenCalledTimes(1);
    });
  });

  describe("blocker badge rendering (via card flags)", () => {
    it("renders BLOCKED badge using default card flag rules", () => {
      const item = makeItem({
        metadata: {
          priority: {
            "has-blocker": true,
            "blocker-context": "waiting on deploy",
          },
        },
      });
      const ctx = makeContext();
      const card = new TaskCard(DEFAULT_CARD_FLAGS);

      const el = card.render(item, ctx);
      const badge = el.querySelector(".wt-card-flag--badge") as HTMLElement;

      expect(badge).not.toBeNull();
      expect(badge.textContent).toBe("BLOCKED");
      // jsdom normalizes hex colours to rgb()
      expect(badge.style.background).toBe("rgb(229, 72, 77)");
      expect(badge.style.color).toBe("var(--text-on-accent, white)");
    });

    it("normalizes Obsidian link aliases in blocker tooltips", () => {
      const item = makeItem({
        metadata: {
          priority: {
            "has-blocker": true,
            "blocker-context": "[[Doc|Alias]]",
          },
        },
      });
      const ctx = makeContext();
      const card = new TaskCard(DEFAULT_CARD_FLAGS);

      const el = card.render(item, ctx);
      const badge = el.querySelector(".wt-card-flag--badge") as HTMLElement;

      expect(badge).toBeDefined();
      expect(badge?.title).toBe("Alias");
      expect(badge?.title).not.toContain("[[");
      expect(badge?.title).not.toContain("]]");
    });

    it("does not render BLOCKED badge when has-blocker is false", () => {
      const item = makeItem({
        metadata: {
          priority: { "has-blocker": false },
        },
      });
      const ctx = makeContext();
      const card = new TaskCard(DEFAULT_CARD_FLAGS);

      const el = card.render(item, ctx);
      const badge = el.querySelector(".wt-card-flag--badge");

      expect(badge).toBeNull();
    });
  });

  describe("card flag visual treatments", () => {
    it("renders accent-border style with left border class and CSS variable", () => {
      const rules: CardFlagRule[] = [
        { field: "hot", value: true, label: "HOT", style: "accent-border", color: "orange" },
      ];
      const item = makeItem({ metadata: { hot: true } });
      const ctx = makeContext();
      const card = new TaskCard(rules);

      const el = card.render(item, ctx);

      expect(el.classList.contains("wt-card-flag--accent-border")).toBe(true);
      expect(el.style.getPropertyValue("--wt-flag-accent-color")).toBe("orange");
      const label = el.querySelector(".wt-card-flag--accent-label") as HTMLElement;
      expect(label).not.toBeNull();
      expect(label.textContent).toBe("HOT");
      expect(label.style.color).toBe("orange");
    });

    it("renders background-tint style with bg class and CSS variable", () => {
      const rules: CardFlagRule[] = [
        {
          field: "priority.impact",
          value: "critical",
          label: "CRITICAL",
          style: "background-tint",
          color: "rgba(255,0,0,0.08)",
        },
      ];
      const item = makeItem({
        metadata: { priority: { impact: "critical" } },
      });
      const ctx = makeContext();
      const card = new TaskCard(rules);

      const el = card.render(item, ctx);

      expect(el.classList.contains("wt-card-flag--bg-tint")).toBe(true);
      expect(el.style.getPropertyValue("--wt-flag-bg-tint")).toBe("rgba(255,0,0,0.08)");
      const label = el.querySelector(".wt-card-flag--tint-label") as HTMLElement;
      expect(label).not.toBeNull();
      expect(label.textContent).toBe("CRITICAL");
    });

    it("renders multiple flags from different rules", () => {
      const rules: CardFlagRule[] = [
        { field: "blocked", value: true, label: "BLOCKED", style: "badge", color: "red" },
        { field: "hot", value: true, label: "HOT", style: "accent-border", color: "orange" },
      ];
      const item = makeItem({ metadata: { blocked: true, hot: true } });
      const ctx = makeContext();
      const card = new TaskCard(rules);

      const el = card.render(item, ctx);
      const badges = el.querySelectorAll(".wt-card-flag");

      expect(badges.length).toBe(2);
    });

    it("renders no flags when no rules are configured", () => {
      const item = makeItem({ metadata: { priority: { "has-blocker": true } } });
      const ctx = makeContext();
      const card = new TaskCard([]);

      const el = card.render(item, ctx);
      const flags = el.querySelectorAll(".wt-card-flag");

      expect(flags.length).toBe(0);
    });
  });

  describe("compact display mode", () => {
    it("renders wt-card-compact class in compact mode", () => {
      const item = makeItem();
      const ctx = makeContext();
      const card = new TaskCard();

      const el = card.render(item, ctx, "compact");

      expect(el.classList.contains("wt-card-compact")).toBe(true);
    });

    it("does not render wt-card-compact class in standard mode", () => {
      const item = makeItem();
      const ctx = makeContext();
      const card = new TaskCard();

      const el = card.render(item, ctx, "standard");

      expect(el.classList.contains("wt-card-compact")).toBe(false);
    });

    it("does not render wt-card-compact class when displayMode is undefined", () => {
      const item = makeItem();
      const ctx = makeContext();
      const card = new TaskCard();

      const el = card.render(item, ctx);

      expect(el.classList.contains("wt-card-compact")).toBe(false);
    });

    it("renders compact row layout with title and dots container", () => {
      const item = makeItem();
      const ctx = makeContext();
      const card = new TaskCard();

      const el = card.render(item, ctx, "compact");

      const compactRow = el.querySelector(".wt-card-compact-row");
      expect(compactRow).not.toBeNull();

      const title = el.querySelector(".wt-card-compact-title");
      expect(title).not.toBeNull();
      expect(title!.textContent).toBe("Fix context prompt");

      const dots = el.querySelector(".wt-card-compact-dots");
      expect(dots).not.toBeNull();
    });

    it("renders icon slot placeholder in compact mode (hidden)", () => {
      const item = makeItem();
      const ctx = makeContext();
      const card = new TaskCard();

      const el = card.render(item, ctx, "compact");

      const iconSlot = el.querySelector(".wt-card-icon-slot") as HTMLElement;
      expect(iconSlot).not.toBeNull();
      expect(iconSlot.style.display).toBe("none");
    });

    it("renders icon slot placeholder in standard mode (hidden)", () => {
      const item = makeItem();
      const ctx = makeContext();
      const card = new TaskCard();

      const el = card.render(item, ctx, "standard");

      const iconSlot = el.querySelector(".wt-card-icon-slot") as HTMLElement;
      expect(iconSlot).not.toBeNull();
      expect(iconSlot.style.display).toBe("none");
    });

    it("does not render meta row in compact mode", () => {
      const item = makeItem({
        metadata: {
          source: { type: "jira", id: "PROJ-123" },
          priority: { score: 50 },
          goal: ["Ship Feature"],
        },
      });
      const ctx = makeContext();
      const card = new TaskCard();

      const el = card.render(item, ctx, "compact");

      expect(el.querySelector(".wt-card-meta")).toBeNull();
      expect(el.querySelector(".wt-card-source")).toBeNull();
      expect(el.querySelector(".wt-card-score")).toBeNull();
      expect(el.querySelector(".wt-card-goal")).toBeNull();
    });

    it("renders Jira indicator dot with blue color and tooltip", () => {
      const item = makeItem({
        metadata: {
          source: { type: "jira", id: "CASTLE-1234" },
        },
      });
      const ctx = makeContext();
      const card = new TaskCard();

      const el = card.render(item, ctx, "compact");

      const jiraDot = el.querySelector(".wt-compact-dot--jira") as HTMLElement;
      expect(jiraDot).not.toBeNull();
      expect(jiraDot.title).toBe("CASTLE-1234");
    });

    it("renders priority indicator dot with correct tier class", () => {
      const highItem = makeItem({
        metadata: { priority: { score: 75 } },
      });
      const ctx = makeContext();
      const card = new TaskCard();

      const highEl = card.render(highItem, ctx, "compact");
      expect(highEl.querySelector(".wt-compact-dot--priority-high")).not.toBeNull();
      expect(highEl.querySelector(".wt-compact-dot--priority-high")!.getAttribute("title")).toBe(
        "Priority: 75",
      );

      const medItem = makeItem({
        metadata: { priority: { score: 40 } },
      });
      const medEl = card.render(medItem, ctx, "compact");
      expect(medEl.querySelector(".wt-compact-dot--priority-medium")).not.toBeNull();

      const lowItem = makeItem({
        metadata: { priority: { score: 10 } },
      });
      const lowEl = card.render(lowItem, ctx, "compact");
      expect(lowEl.querySelector(".wt-compact-dot--priority-low")).not.toBeNull();
    });

    it("does not render priority dot when score is 0", () => {
      const item = makeItem({
        metadata: { priority: { score: 0 } },
      });
      const ctx = makeContext();
      const card = new TaskCard();

      const el = card.render(item, ctx, "compact");
      const dots = el.querySelectorAll(".wt-compact-dot");
      const priorityDots = Array.from(dots).filter(
        (d) =>
          d.classList.contains("wt-compact-dot--priority-high") ||
          d.classList.contains("wt-compact-dot--priority-medium") ||
          d.classList.contains("wt-compact-dot--priority-low"),
      );

      expect(priorityDots.length).toBe(0);
    });

    it("renders goal indicator dot with tooltip", () => {
      const item = makeItem({
        metadata: {
          goal: ["[[Ship Feature|My Goal]]"],
        },
      });
      const ctx = makeContext();
      const card = new TaskCard();

      const el = card.render(item, ctx, "compact");

      const goalDot = el.querySelector(".wt-compact-dot--goal") as HTMLElement;
      expect(goalDot).not.toBeNull();
      expect(goalDot.title).toBe("My Goal");
    });

    it("renders flag indicator dots with flag color and tooltip", () => {
      const rules: CardFlagRule[] = [
        {
          field: "priority.has-blocker",
          value: true,
          label: "BLOCKED",
          style: "badge",
          color: "#e5484d",
          tooltip: "{{priority.blocker-context}}",
        },
      ];
      const item = makeItem({
        metadata: {
          priority: {
            "has-blocker": true,
            "blocker-context": "waiting on deploy",
          },
        },
      });
      const ctx = makeContext();
      const card = new TaskCard(rules);

      const el = card.render(item, ctx, "compact");

      const flagDot = el.querySelector(".wt-compact-dot--flag") as HTMLElement;
      expect(flagDot).not.toBeNull();
      expect(flagDot.style.backgroundColor).toBe("rgb(229, 72, 77)");
      expect(flagDot.title).toBe("waiting on deploy");
    });

    it("renders no dots for a plain task with no metadata", () => {
      const item = makeItem({ metadata: {} });
      const ctx = makeContext();
      const card = new TaskCard();

      const el = card.render(item, ctx, "compact");

      const dots = el.querySelectorAll(".wt-compact-dot");
      expect(dots.length).toBe(0);
    });

    it("renders actions container inside compact row for framework badges", () => {
      const item = makeItem();
      const ctx = makeContext();
      const card = new TaskCard();

      const el = card.render(item, ctx, "compact");

      const actions = el.querySelector(".wt-card-compact-row .wt-card-actions");
      expect(actions).not.toBeNull();
    });

    it("sets title attribute on compact title for tooltip on hover", () => {
      const item = makeItem({ title: "A very long task title that would be truncated" });
      const ctx = makeContext();
      const card = new TaskCard();

      const el = card.render(item, ctx, "compact");

      const title = el.querySelector(".wt-card-compact-title") as HTMLElement;
      expect(title.getAttribute("title")).toBe("A very long task title that would be truncated");
    });
  });

  describe("comfortable display mode", () => {
    it("renders wt-card-compact class in comfortable mode", () => {
      const item = makeItem();
      const ctx = makeContext();
      const card = new TaskCard();

      const el = card.render(item, ctx, "comfortable");

      expect(el.classList.contains("wt-card-compact")).toBe(true);
    });

    it("renders compact row layout with title and dots container in comfortable mode", () => {
      const item = makeItem({
        metadata: {
          source: { type: "jira", id: "CASTLE-42" },
          priority: { score: 60 },
          goal: ["Ship Feature"],
        },
      });
      const ctx = makeContext();
      const card = new TaskCard();

      const el = card.render(item, ctx, "comfortable");

      const compactRow = el.querySelector(".wt-card-compact-row");
      expect(compactRow).not.toBeNull();

      const title = el.querySelector(".wt-card-compact-title");
      expect(title).not.toBeNull();
      expect(title!.textContent).toBe("Fix context prompt");

      const dots = el.querySelector(".wt-card-compact-dots");
      expect(dots).not.toBeNull();

      // Should have indicator dots, not full badges
      expect(el.querySelector(".wt-compact-dot--jira")).not.toBeNull();
      expect(el.querySelector(".wt-compact-dot--priority-high")).not.toBeNull();
      expect(el.querySelector(".wt-compact-dot--goal")).not.toBeNull();
    });

    it("does not render standard meta row in comfortable mode", () => {
      const item = makeItem({
        metadata: {
          source: { type: "jira", id: "PROJ-123" },
          priority: { score: 50 },
          goal: ["Ship Feature"],
        },
      });
      const ctx = makeContext();
      const card = new TaskCard();

      const el = card.render(item, ctx, "comfortable");

      expect(el.querySelector(".wt-card-meta")).toBeNull();
      expect(el.querySelector(".wt-card-source")).toBeNull();
      expect(el.querySelector(".wt-card-score")).toBeNull();
      expect(el.querySelector(".wt-card-goal")).toBeNull();
    });
  });

  describe("icon rendering", () => {
    it("hides icon slot when icons are disabled (default)", () => {
      const item = makeItem({ metadata: { icon: "rocket" } });
      const ctx = makeContext();
      const card = new TaskCard();

      const el = card.render(item, ctx, "standard");
      const iconSlot = el.querySelector(".wt-card-icon-slot") as HTMLElement;

      expect(iconSlot).not.toBeNull();
      expect(iconSlot.style.display).toBe("none");
    });

    it("renders Lucide icon when icons are enabled and custom icon is set", () => {
      const item = makeItem({ metadata: { icon: "rocket" } });
      const ctx = makeContext();
      const card = new TaskCard();
      card.updateIconSettings(true, "none");

      const el = card.render(item, ctx, "standard");
      const iconSlot = el.querySelector(".wt-card-icon-slot") as HTMLElement;

      expect(iconSlot.style.display).not.toBe("none");
      expect(iconSlot.classList.contains("wt-card-icon-standard")).toBe(true);
      expect(iconSlot.querySelector("svg")).not.toBeNull();
    });

    it("renders emoji icon as text content", () => {
      const item = makeItem({ metadata: { icon: "\uD83D\uDE80" } });
      const ctx = makeContext();
      const card = new TaskCard();
      card.updateIconSettings(true, "none");

      const el = card.render(item, ctx, "standard");
      const iconSlot = el.querySelector(".wt-card-icon-slot") as HTMLElement;

      expect(iconSlot.style.display).not.toBe("none");
      expect(iconSlot.textContent).toBe("\uD83D\uDE80");
      expect(iconSlot.classList.contains("wt-card-icon-emoji")).toBe(true);
    });

    it("hides icon slot for unrecognised Lucide icon name", () => {
      const item = makeItem({ metadata: { icon: "nonexistent-icon-xyz" } });
      const ctx = makeContext();
      const card = new TaskCard();
      card.updateIconSettings(true, "none");

      const el = card.render(item, ctx, "standard");
      const iconSlot = el.querySelector(".wt-card-icon-slot") as HTMLElement;

      expect(iconSlot.style.display).toBe("none");
    });

    it("renders source-based auto-icon for Jira task", () => {
      const item = makeItem({
        metadata: { source: { type: "jira", id: "PROJ-1" } },
      });
      const ctx = makeContext();
      const card = new TaskCard();
      card.updateIconSettings(true, "source");

      const el = card.render(item, ctx, "standard");
      const iconSlot = el.querySelector(".wt-card-icon-slot") as HTMLElement;

      expect(iconSlot.style.display).not.toBe("none");
      const svg = iconSlot.querySelector("svg");
      expect(svg).not.toBeNull();
      expect(svg!.getAttribute("data-icon")).toBe("ticket");
    });

    it("renders source-based auto-icon for Slack task", () => {
      const item = makeItem({
        metadata: { source: { type: "slack", id: "" } },
      });
      const ctx = makeContext();
      const card = new TaskCard();
      card.updateIconSettings(true, "source");

      const el = card.render(item, ctx, "standard");
      const iconSlot = el.querySelector(".wt-card-icon-slot") as HTMLElement;
      const svg = iconSlot.querySelector("svg");
      expect(svg).not.toBeNull();
      expect(svg!.getAttribute("data-icon")).toBe("message-square");
    });

    it("renders state-based auto-icon for priority column", () => {
      const item = makeItem({ state: "priority" });
      const ctx = makeContext();
      const card = new TaskCard();
      card.updateIconSettings(true, "state");

      const el = card.render(item, ctx, "standard");
      const iconSlot = el.querySelector(".wt-card-icon-slot") as HTMLElement;
      const svg = iconSlot.querySelector("svg");
      expect(svg).not.toBeNull();
      expect(svg!.getAttribute("data-icon")).toBe("flame");
    });

    it("custom per-task icon overrides auto-icon mode", () => {
      const item = makeItem({
        metadata: {
          icon: "rocket",
          source: { type: "jira", id: "PROJ-1" },
        },
      });
      const ctx = makeContext();
      const card = new TaskCard();
      card.updateIconSettings(true, "source");

      const el = card.render(item, ctx, "standard");
      const iconSlot = el.querySelector(".wt-card-icon-slot") as HTMLElement;
      const svg = iconSlot.querySelector("svg");
      expect(svg).not.toBeNull();
      expect(svg!.getAttribute("data-icon")).toBe("rocket");
    });

    it("renders compact icon with compact class", () => {
      const item = makeItem({ metadata: { icon: "terminal" } });
      const ctx = makeContext();
      const card = new TaskCard();
      card.updateIconSettings(true, "none");

      const el = card.render(item, ctx, "compact");
      const iconSlot = el.querySelector(".wt-card-icon-slot") as HTMLElement;

      expect(iconSlot.classList.contains("wt-card-icon-compact")).toBe(true);
      expect(iconSlot.classList.contains("wt-card-icon-standard")).toBe(false);
    });

    it("hides icon slot when icons enabled but no custom icon and auto-mode is none", () => {
      const item = makeItem({ metadata: {} });
      const ctx = makeContext();
      const card = new TaskCard();
      card.updateIconSettings(true, "none");

      const el = card.render(item, ctx, "standard");
      const iconSlot = el.querySelector(".wt-card-icon-slot") as HTMLElement;

      expect(iconSlot.style.display).toBe("none");
    });

    it("includes Set Icon and Clear Icon in context menu when icons enabled", () => {
      const item = makeItem({ metadata: { icon: "rocket" } });
      const ctx = makeContext();
      const card = new TaskCard();
      card.updateIconSettings(true, "none");
      card.setIconOperations({
        promptSetIcon: vi.fn(),
        clearIcon: vi.fn(),
      });

      const menuItems = card.getContextMenuItems(item, ctx);
      const setItem = menuItems.find((m) => (m as any).title === "Set Icon...");
      const clearItem = menuItems.find((m) => (m as any).title === "Clear Icon");

      expect(setItem).toBeDefined();
      expect(clearItem).toBeDefined();
    });

    it("does not include Clear Icon when no custom icon is set", () => {
      const item = makeItem({ metadata: {} });
      const ctx = makeContext();
      const card = new TaskCard();
      card.updateIconSettings(true, "none");
      card.setIconOperations({
        promptSetIcon: vi.fn(),
        clearIcon: vi.fn(),
      });

      const menuItems = card.getContextMenuItems(item, ctx);
      const clearItem = menuItems.find((m) => (m as any).title === "Clear Icon");

      expect(clearItem).toBeUndefined();
    });

    it("does not include icon menu items when icons are disabled", () => {
      const item = makeItem({ metadata: { icon: "rocket" } });
      const ctx = makeContext();
      const card = new TaskCard();
      // icons disabled by default

      const menuItems = card.getContextMenuItems(item, ctx);
      const setItem = menuItems.find((m) => (m as any).title === "Set Icon...");

      expect(setItem).toBeUndefined();
    });
  });
});
