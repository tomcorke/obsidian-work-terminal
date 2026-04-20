import { describe, it, expect } from "vitest";
import { TaskPromptBuilder } from "./TaskPromptBuilder";
import type { WorkItem } from "../../core/interfaces";

function makeItem(
  overrides: Partial<WorkItem> = {},
  metaOverrides: Record<string, any> = {},
): WorkItem {
  return {
    id: "test-id",
    path: "2 - Areas/Tasks/active/task.md",
    title: "Fix login bug",
    state: "active",
    metadata: {
      priority: {
        score: 50,
        deadline: "",
        impact: "medium",
        "has-blocker": false,
        "blocker-context": "",
      },
      ...metaOverrides,
    },
    ...overrides,
  };
}

describe("TaskPromptBuilder", () => {
  const builder = new TaskPromptBuilder();

  it("includes title, state, and path", () => {
    const item = makeItem();
    const prompt = builder.buildPrompt(item, "/full/path/to/task.md");
    expect(prompt).toContain("Task: Fix login bug");
    expect(prompt).toContain("State: active");
    expect(prompt).toContain("File: /full/path/to/task.md");
  });

  it("includes deadline when present", () => {
    const item = makeItem(
      {},
      {
        priority: {
          score: 50,
          deadline: "2026-04-01",
          impact: "medium",
          "has-blocker": false,
          "blocker-context": "",
        },
      },
    );
    const prompt = builder.buildPrompt(item, "/path");
    expect(prompt).toContain("Deadline: 2026-04-01");
  });

  it("excludes deadline when empty", () => {
    const item = makeItem();
    const prompt = builder.buildPrompt(item, "/path");
    expect(prompt).not.toContain("Deadline:");
  });

  it("includes blocker when has-blocker is true", () => {
    const item = makeItem(
      {},
      {
        priority: {
          score: 50,
          deadline: "",
          impact: "medium",
          "has-blocker": true,
          "blocker-context": "Waiting on API team",
        },
      },
    );
    const prompt = builder.buildPrompt(item, "/path");
    expect(prompt).toContain("Blocker: Waiting on API team");
  });

  it("excludes blocker when has-blocker is false", () => {
    const item = makeItem();
    const prompt = builder.buildPrompt(item, "/path");
    expect(prompt).not.toContain("Blocker:");
  });

  it("handles special characters in title", () => {
    const item = makeItem({ title: "Fix: the 'auth' bug" });
    const prompt = builder.buildPrompt(item, "/path");
    expect(prompt).toContain("Task: Fix: the 'auth' bug");
  });

  it("handles missing metadata gracefully", () => {
    const item: WorkItem = {
      id: "test",
      path: "path.md",
      title: "Test",
      state: "todo",
      metadata: {},
    };
    const prompt = builder.buildPrompt(item, "/path");
    expect(prompt).toContain("Task: Test");
    expect(prompt).not.toContain("Deadline:");
    expect(prompt).not.toContain("Blocker:");
  });

  it("describes prompt format for settings UI using $name placeholders", () => {
    const description = builder.describePromptFormat();
    expect(description).toContain("$title");
    expect(description).toContain("$state");
    expect(description).toContain("$filePath");
    expect(description).toContain("$deadline");
    expect(description).toContain("$blocker");
    // Should not regress to older brace-style placeholders.
    expect(description).not.toContain("{title}");
    expect(description).not.toContain("{state}");
    expect(description).not.toContain("{path}");
    expect(description).not.toContain("{deadline}");
    expect(description).not.toContain("{blocker}");
  });
});
