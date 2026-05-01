import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkItem } from "../core/interfaces";
import { expandProfilePlaceholders } from "./AgentContextPrompt";

const item: WorkItem = {
  id: "task-123",
  path: "2 - Areas/Tasks/priority/task.md",
  title: "Fix prompt sync",
  state: "priority",
  metadata: {},
};

describe("expandProfilePlaceholders", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

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

  it("expands parent placeholders for sub-tasks", () => {
    const child: WorkItem = {
      ...item,
      metadata: {
        parent: {
          id: "parent-123",
          title: "Parent task",
          path: "2 - Areas/Tasks/active/parent.md",
        },
      },
    };

    const result = expandProfilePlaceholders(
      "$parentTitle|$parentId|$parentFilePath|$parentAbsoluteFilePath",
      child,
      "sess-abc",
      undefined,
      "/vault/2 - Areas/Tasks/priority/task.md",
    );

    expect(result).toBe(
      "Parent task|parent-123|2 - Areas/Tasks/active/parent.md|/vault/2 - Areas/Tasks/active/parent.md",
    );
  });

  it("expands parent placeholders to empty strings for top-level tasks", () => {
    const result = expandProfilePlaceholders(
      "$parentTitle|$parentId|$parentFilePath|$parentAbsoluteFilePath",
      item,
      "sess-abc",
      undefined,
      "/vault/2 - Areas/Tasks/priority/task.md",
    );

    expect(result).toBe("|||");
  });

  it("returns template unchanged when no placeholders present", () => {
    const result = expandProfilePlaceholders("--verbose --model opus", item, "sess-abc");
    expect(result).toBe("--verbose --model opus");
  });

  it("keeps $filePath vault-relative even when an absolute path is provided", () => {
    const result = expandProfilePlaceholders(
      "--path $filePath",
      item,
      "sess-abc",
      undefined,
      "/vault/2 - Areas/Tasks/priority/task.md",
    );
    expect(result).toBe("--path 2 - Areas/Tasks/priority/task.md");
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
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("falls back to item.path for $absoluteFilePath and warns when not provided", () => {
    const result = expandProfilePlaceholders("--path $absoluteFilePath", item, "sess-abc");
    expect(result).toBe("--path 2 - Areas/Tasks/priority/task.md");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("$absoluteFilePath");
  });

  it("falls back to item.path for $absoluteFilePath and warns when a relative path is provided", () => {
    const result = expandProfilePlaceholders(
      "--path $absoluteFilePath",
      item,
      "sess-abc",
      undefined,
      "2 - Areas/Tasks/priority/task.md",
    );
    expect(result).toBe("--path 2 - Areas/Tasks/priority/task.md");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("not absolute");
  });

  it("does not warn about absolute fallback when the template does not reference $absoluteFilePath", () => {
    expandProfilePlaceholders("--path $filePath", item, "sess-abc");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("expands $absoluteFilePath and $filePath to distinct values when both are meaningful", () => {
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

  it("expands $absoluteFilePath for a Windows drive-letter absolute path (backslashes)", () => {
    const result = expandProfilePlaceholders(
      "--path $absoluteFilePath",
      item,
      "sess-abc",
      undefined,
      "C:\\vault\\2 - Areas\\Tasks\\priority\\task.md",
    );
    expect(result).toBe("--path C:\\vault\\2 - Areas\\Tasks\\priority\\task.md");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("expands $absoluteFilePath for a Windows drive-letter absolute path (forward slashes)", () => {
    const result = expandProfilePlaceholders(
      "--path $absoluteFilePath",
      item,
      "sess-abc",
      undefined,
      "C:/vault/2 - Areas/Tasks/priority/task.md",
    );
    expect(result).toBe("--path C:/vault/2 - Areas/Tasks/priority/task.md");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("expands $absoluteFilePath for a Windows UNC path", () => {
    const result = expandProfilePlaceholders(
      "--path $absoluteFilePath",
      item,
      "sess-abc",
      undefined,
      "\\\\server\\share\\vault\\task.md",
    );
    expect(result).toBe("--path \\\\server\\share\\vault\\task.md");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("expands $absoluteFilePath for a POSIX-style UNC path (double slash)", () => {
    const result = expandProfilePlaceholders(
      "--path $absoluteFilePath",
      item,
      "sess-abc",
      undefined,
      "//server/share/vault/task.md",
    );
    expect(result).toBe("--path //server/share/vault/task.md");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("falls back and warns when $absoluteFilePath is given a Windows-style relative path", () => {
    const result = expandProfilePlaceholders(
      "--path $absoluteFilePath",
      item,
      "sess-abc",
      undefined,
      "vault\\task.md",
    );
    expect(result).toBe("--path 2 - Areas/Tasks/priority/task.md");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("not absolute");
  });

  it("expands $absoluteFilePath alongside all other placeholders", () => {
    const result = expandProfilePlaceholders(
      "--title $title --abs $absoluteFilePath --rel $filePath --id $id --session $sessionId",
      item,
      "sess-abc",
      undefined,
      "/vault/task.md",
    );
    expect(result).toBe(
      "--title Fix prompt sync --abs /vault/task.md --rel 2 - Areas/Tasks/priority/task.md --id task-123 --session sess-abc",
    );
  });
});
