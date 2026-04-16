import { describe, expect, it } from "vitest";
import type { WorkItem } from "../core/interfaces";
import {
  buildAgentContextPrompt,
  buildClaudeContextPrompt,
  expandProfilePlaceholders,
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

  it("expands $absoluteFilePath to the resolved absolute path", () => {
    const prompt = buildAgentContextPrompt(
      item,
      {
        "core.additionalAgentContext": "Abs: $absoluteFilePath\nRel: $filePath",
      },
      "/vault/2 - Areas/Tasks/priority/task.md",
    );

    expect(prompt).toBe(
      "Abs: /vault/2 - Areas/Tasks/priority/task.md\nRel: /vault/2 - Areas/Tasks/priority/task.md",
    );
  });

  it("falls back to item.path for $absoluteFilePath when no fullPath provided", () => {
    const prompt = buildAgentContextPrompt(item, {
      "core.additionalAgentContext": "Abs: $absoluteFilePath",
    });

    expect(prompt).toBe("Abs: 2 - Areas/Tasks/priority/task.md");
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

describe("expandProfilePlaceholders", () => {
  it("expands $title, $state, $filePath, $id", () => {
    const result = expandProfilePlaceholders(
      "--title $title --state $state --path $filePath --id $id",
      item,
      "sess-abc",
    );
    expect(result).toBe(
      "--title Fix prompt sync --state priority --path 2 - Areas/Tasks/priority/task.md --id task-123",
    );
  });

  it("expands $sessionId", () => {
    const result = expandProfilePlaceholders("--session $sessionId", item, "sess-abc");
    expect(result).toBe("--session sess-abc");
  });

  it("expands $workTerminalPrompt to the assembled context prompt", () => {
    const contextPrompt = "Task: Fix prompt sync\nState: priority";
    const result = expandProfilePlaceholders(
      '--prompt "$workTerminalPrompt"',
      item,
      "sess-abc",
      contextPrompt,
    );
    expect(result).toBe('--prompt "Task: Fix prompt sync\nState: priority"');
  });

  it("expands $workTerminalPrompt to empty string when no context provided", () => {
    const result = expandProfilePlaceholders("--prompt $workTerminalPrompt", item, "sess-abc");
    expect(result).toBe("--prompt ");
  });

  it("expands $workTerminalPrompt to empty string when context is undefined", () => {
    const result = expandProfilePlaceholders(
      "--prompt $workTerminalPrompt",
      item,
      "sess-abc",
      undefined,
    );
    expect(result).toBe("--prompt ");
  });

  it("handles multiple occurrences of the same placeholder", () => {
    const result = expandProfilePlaceholders("$title and $title again", item, "sess-abc");
    expect(result).toBe("Fix prompt sync and Fix prompt sync again");
  });

  it("expands all placeholders together including $workTerminalPrompt", () => {
    const result = expandProfilePlaceholders(
      "--task $title --ctx $workTerminalPrompt --id $id",
      item,
      "sess-abc",
      "full context here",
    );
    expect(result).toBe("--task Fix prompt sync --ctx full context here --id task-123");
  });

  it("returns template unchanged when no placeholders present", () => {
    const result = expandProfilePlaceholders("--verbose --model opus", item, "sess-abc");
    expect(result).toBe("--verbose --model opus");
  });

  it("expands $absoluteFilePath when provided", () => {
    const result = expandProfilePlaceholders(
      "--path $absoluteFilePath",
      item,
      "sess-abc",
      undefined,
      "/vault/2 - Areas/Tasks/priority/task.md",
    );
    expect(result).toBe("--path /vault/2 - Areas/Tasks/priority/task.md");
  });

  it("falls back to item.path for $absoluteFilePath when not provided", () => {
    const result = expandProfilePlaceholders("--path $absoluteFilePath", item, "sess-abc");
    expect(result).toBe("--path 2 - Areas/Tasks/priority/task.md");
  });

  it("expands $absoluteFilePath and $filePath independently", () => {
    const result = expandProfilePlaceholders(
      "--abs $absoluteFilePath --rel $filePath",
      item,
      "sess-abc",
      undefined,
      "/vault/2 - Areas/Tasks/priority/task.md",
    );
    expect(result).toBe(
      "--abs /vault/2 - Areas/Tasks/priority/task.md --rel 2 - Areas/Tasks/priority/task.md",
    );
  });

  it("expands $absoluteFilePath alongside all other placeholders", () => {
    const result = expandProfilePlaceholders(
      "--title $title --abs $absoluteFilePath --id $id --session $sessionId",
      item,
      "sess-abc",
      undefined,
      "/vault/task.md",
    );
    expect(result).toBe(
      "--title Fix prompt sync --abs /vault/task.md --id task-123 --session sess-abc",
    );
  });
});
