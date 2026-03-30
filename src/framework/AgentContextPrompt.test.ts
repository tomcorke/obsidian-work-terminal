import { describe, expect, it } from "vitest";
import type { WorkItem } from "../core/interfaces";
import {
  buildAgentContextPrompt,
  buildClaudeContextPrompt,
  getAgentContextTemplate,
  getClaudeContextTemplate,
} from "./AgentContextPrompt";

const item: WorkItem = {
  id: "task-123",
  path: "2 - Areas/Tasks/priority/task.md",
  title: "Fix prompt sync",
  state: "priority",
  metadata: {},
};

describe("buildAgentContextPrompt", () => {
  it("uses the fresh template when available", () => {
    const prompt = buildAgentContextPrompt(item, {
      "core.additionalAgentContext": "Task: $title\nState: $state\nPath: $filePath\nId: $id",
    });

    expect(prompt).toBe(
      "Task: Fix prompt sync\nState: priority\nPath: 2 - Areas/Tasks/priority/task.md\nId: task-123",
    );
  });

  it("uses the resolved absolute path when provided", () => {
    const prompt = buildAgentContextPrompt(
      item,
      {
        "core.additionalAgentContext": "Path: $filePath",
      },
      "/vault/2 - Areas/Tasks/priority/task.md",
    );

    expect(prompt).toBe("Path: /vault/2 - Areas/Tasks/priority/task.md");
  });

  it("treats an explicitly cleared template as unavailable", () => {
    const prompt = buildAgentContextPrompt(item, {
      "core.additionalAgentContext": "",
    });

    expect(prompt).toBeNull();
  });

  it("treats whitespace-only templates as unavailable", () => {
    expect(
      getAgentContextTemplate({
        "core.additionalAgentContext": "  \n\t  ",
      }),
    ).toBeNull();
  });

  it("keeps Claude alias exports working", () => {
    const prompt = buildClaudeContextPrompt(item, {
      "core.additionalAgentContext": "Task: $title",
    });

    expect(getClaudeContextTemplate({ "core.additionalAgentContext": "Task: $title" })).toBe(
      "Task: $title",
    );
    expect(prompt).toBe("Task: Fix prompt sync");
  });

  it("returns null when no template is configured", () => {
    const prompt = buildAgentContextPrompt(item, {});

    expect(prompt).toBeNull();
  });
});
