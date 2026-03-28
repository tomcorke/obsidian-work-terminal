import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaskCard } from "./TaskCard";
import type { CardActionContext, WorkItem } from "../../core/interfaces";

vi.mock("obsidian", () => ({
  Notice: class Notice {
    constructor(_message: string) {}
  },
}));

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
});
