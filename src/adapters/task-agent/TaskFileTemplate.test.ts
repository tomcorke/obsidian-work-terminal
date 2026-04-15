import { describe, it, expect } from "vitest";
import { generateTaskContent, generateTaskFilename } from "./TaskFileTemplate";

describe("generateTaskContent", () => {
  it("generates valid YAML frontmatter", () => {
    const content = generateTaskContent("Fix login bug", "todo");
    expect(content).toMatch(/^---\n/);
    expect(content).toMatch(/\n---\n/);
  });

  it("includes a UUID id", () => {
    const content = generateTaskContent("Test", "todo");
    // UUID v4 pattern
    expect(content).toMatch(/id: [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });

  it("sets correct tags for todo column", () => {
    const content = generateTaskContent("Test", "todo");
    expect(content).toContain("- task\n");
    expect(content).toContain("- task/todo\n");
  });

  it("sets correct tags for active column", () => {
    const content = generateTaskContent("Test", "active");
    expect(content).toContain("- task/active\n");
  });

  it("sets state matching the column", () => {
    const content = generateTaskContent("Test", "active");
    expect(content).toMatch(/^state: active$/m);
  });

  it("includes the title in frontmatter and heading", () => {
    const content = generateTaskContent("Fix login bug", "todo");
    expect(content).toContain('title: "Fix login bug"');
    expect(content).toContain("# Fix login bug");
  });

  it("quotes title with special characters", () => {
    const content = generateTaskContent('Fix: the "auth" bug', "todo");
    expect(content).toContain('title: "Fix: the \\"auth\\" bug"');
  });

  it("uses timestamps without milliseconds", () => {
    const content = generateTaskContent("Test", "todo");
    const match = content.match(/created:\s*(.+)/);
    expect(match).not.toBeNull();
    expect(match![1]).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
    expect(match![1]).not.toMatch(/\.\d{3}Z/);
  });

  it("includes Activity Log section with creation entry", () => {
    const content = generateTaskContent("Test", "todo");
    expect(content).toContain("## Activity Log");
    expect(content).toMatch(/- \*\*\d{4}-\d{2}-\d{2} \d{2}:\d{2}\*\* - Task created/);
  });

  it("includes default empty fields", () => {
    const content = generateTaskContent("Test", "todo");
    expect(content).toContain("agent-actionable: false");
    expect(content).toContain("goal: []");
    expect(content).toContain("related: []");
    expect(content).toMatch(/^priority:\n\s+score: 0$/m);
    expect(content).toMatch(/^priority:[\s\S]*?has-blocker: false$/m);
  });

  it("uses nested YAML for source fields", () => {
    const content = generateTaskContent("Test", "todo");
    expect(content).toMatch(/^source:\n\s+type: prompt$/m);
    expect(content).toMatch(/^source:[\s\S]*?\s+id:/m);
    expect(content).toMatch(/^source:[\s\S]*?\s+url:/m);
    expect(content).toMatch(/^source:[\s\S]*?\s+captured:/m);
    // Must NOT contain dot-notation source keys
    expect(content).not.toMatch(/^source\./m);
  });

  it("uses nested YAML for priority fields", () => {
    const content = generateTaskContent("Test", "todo");
    expect(content).toMatch(/^priority:\n\s+score: 0$/m);
    expect(content).toMatch(/^priority:[\s\S]*?\s+deadline: ""$/m);
    expect(content).toMatch(/^priority:[\s\S]*?\s+impact: medium$/m);
    expect(content).toMatch(/^priority:[\s\S]*?\s+has-blocker: false$/m);
    expect(content).toMatch(/^priority:[\s\S]*?\s+blocker-context: ""$/m);
    // Must NOT contain dot-notation priority keys
    expect(content).not.toMatch(/^priority\./m);
  });

  it("has no blank lines within frontmatter fences", () => {
    const content = generateTaskContent("Test", "todo");
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
    expect(fmMatch).not.toBeNull();
    const frontmatter = fmMatch![1];
    // Every line within the frontmatter block should be non-empty
    const lines = frontmatter.split("\n");
    const blankLines = lines.filter((line) => line.trim() === "");
    expect(blankLines).toHaveLength(0);
  });

  it("uses block list syntax for split task related links", () => {
    const content = generateTaskContent("Split task", "todo", {
      filename: "TASK-20260327-1200-source-task.md",
      title: "Source task",
    });

    expect(content).toMatch(/^related:$/m);
    expect(content).toContain('related:\n  - "[[TASK-20260327-1200-source-task]]"');
    expect(content).not.toContain("\n related:");
    expect(content).not.toContain('related: []\n  - "[[TASK-20260327-1200-source-task]]"');
  });

  it("includes enrichment block when enrichment metadata is provided", () => {
    const content = generateTaskContent("Test", "todo", undefined, "test-id", {
      profile: "pi",
      command: "pi",
      args: "--model sonnet",
      prompt: "Enrich the task at /path/to/file",
      cwd: "/home/user/work",
    });
    expect(content).toContain("enrichment:");
    expect(content).toMatch(/^\s+profile: "pi"$/m);
    expect(content).toMatch(/^\s+command: "pi"$/m);
    expect(content).toMatch(/^\s+args: "--model sonnet"$/m);
    expect(content).toMatch(/^\s+prompt: "Enrich the task at \/path\/to\/file"$/m);
    expect(content).toMatch(/^\s+cwd: "\/home\/user\/work"$/m);
  });

  it("omits enrichment block when no enrichment metadata is provided", () => {
    const content = generateTaskContent("Test", "todo");
    expect(content).not.toContain("enrichment:");
  });

  it("escapes quotes in enrichment prompt", () => {
    const content = generateTaskContent("Test", "todo", undefined, "test-id", {
      command: "claude",
      args: "",
      prompt: 'Review "this" task',
      cwd: "/home/user",
    });
    expect(content).toContain('prompt: "Review \\"this\\" task"');
  });

  it("escapes newlines in enrichment prompt", () => {
    const content = generateTaskContent("Test", "todo", undefined, "test-id", {
      command: "claude",
      args: "",
      prompt: "Line one\nLine two\r\nLine three",
      cwd: "/home/user",
    });
    expect(content).toContain('prompt: "Line one\\nLine two\\r\\nLine three"');
  });

  it("uses empty string for enrichment profile when not provided", () => {
    const content = generateTaskContent("Test", "todo", undefined, "test-id", {
      command: "claude",
      args: "",
      prompt: "Enrich",
      cwd: "/home/user",
    });
    expect(content).toMatch(/^\s+profile: ""$/m);
  });
});

describe("generateTaskFilename", () => {
  it("generates correct format", () => {
    const filename = generateTaskFilename("Fix login bug");
    expect(filename).toMatch(/^TASK-\d{8}-\d{4}-fix-login-bug\.md$/);
  });

  it("slugifies the title", () => {
    const filename = generateTaskFilename("Fix: Special Characters!");
    expect(filename).toMatch(/^TASK-\d{8}-\d{4}-fix-special-characters\.md$/);
  });

  it("handles empty title", () => {
    const filename = generateTaskFilename("");
    expect(filename).toMatch(/^TASK-\d{8}-\d{4}-\.md$/);
  });
});
