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
});
