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
    expect(content).toContain("score: 0");
    expect(content).toContain("has-blocker: false");
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
