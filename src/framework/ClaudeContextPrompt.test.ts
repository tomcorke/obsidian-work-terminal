import { describe, expect, it } from "vitest";
import type { WorkItem } from "../core/interfaces";
import { buildClaudeContextPrompt, getClaudeContextTemplate } from "./ClaudeContextPrompt";

const item: WorkItem = {
  id: "task-123",
  path: "2 - Areas/Tasks/priority/task.md",
  title: "Fix prompt sync",
  state: "priority",
  metadata: {},
};

describe("buildClaudeContextPrompt", () => {
  it("uses the fresh template when available", () => {
    const prompt = buildClaudeContextPrompt(item, {
      "core.additionalAgentContext": "Task: $title\nState: $state\nPath: $filePath\nId: $id",
    });

    expect(prompt).toBe(
      "Task: Fix prompt sync\nState: priority\nPath: 2 - Areas/Tasks/priority/task.md\nId: task-123",
    );
  });

  it("uses the resolved absolute path when provided", () => {
    const prompt = buildClaudeContextPrompt(
      item,
      {
        "core.additionalAgentContext": "Path: $filePath",
      },
      "/vault/2 - Areas/Tasks/priority/task.md",
    );

    expect(prompt).toBe("Path: /vault/2 - Areas/Tasks/priority/task.md");
  });

  it("treats an explicitly cleared template as unavailable", () => {
    const prompt = buildClaudeContextPrompt(item, {
      "core.additionalAgentContext": "",
    });

    expect(prompt).toBeNull();
  });

  it("treats whitespace-only templates as unavailable", () => {
    expect(
      getClaudeContextTemplate({
        "core.additionalAgentContext": "  \n\t  ",
      }),
    ).toBeNull();

    const prompt = buildClaudeContextPrompt(item, {
      "core.additionalAgentContext": "  \n\t  ",
    });

    expect(prompt).toBeNull();
  });

  it("returns null when no template is saved", () => {
    const prompt = buildClaudeContextPrompt(item, {});

    expect(prompt).toBeNull();
  });
});
