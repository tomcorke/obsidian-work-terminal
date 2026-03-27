import { describe, it, expect, vi, beforeEach } from "vitest";
import { TaskMover } from "./TaskMover";
import type { App, TFile } from "obsidian";

const SAMPLE_CONTENT = `---
id: abc-123
tags:
  - task
  - task/todo
state: todo
title: "Test Task"
priority:
  score: 50
updated: 2026-03-26T00:00:00Z
created: 2026-03-26T00:00:00Z
---
# Test Task

## Activity Log
- **2026-03-26 12:00** - Task created
`;

function createMockApp() {
  const modify = vi.fn();
  const rename = vi.fn();
  const createFolder = vi.fn();
  const getAbstractFileByPath = vi.fn().mockReturnValue(null);
  const read = vi.fn().mockResolvedValue(SAMPLE_CONTENT);

  const app = {
    vault: { read, modify, rename, createFolder, getAbstractFileByPath },
  } as unknown as App;

  return { app, modify, rename, createFolder, getAbstractFileByPath, read };
}

describe("TaskMover", () => {
  const defaultSettings = { "adapter.taskBasePath": "2 - Areas/Tasks" };

  it("updates state field", async () => {
    const { app, modify } = createMockApp();
    const mover = new TaskMover(app, "", defaultSettings);
    const file = { path: "2 - Areas/Tasks/todo/task.md", name: "task.md" } as TFile;

    await mover.move(file, "active");

    const content = modify.mock.calls[0][1] as string;
    expect(content).toMatch(/^state: active$/m);
  });

  it("updates task tag", async () => {
    const { app, modify } = createMockApp();
    const mover = new TaskMover(app, "", defaultSettings);
    const file = { path: "2 - Areas/Tasks/todo/task.md", name: "task.md" } as TFile;

    await mover.move(file, "active");

    const content = modify.mock.calls[0][1] as string;
    expect(content).toMatch(/- task\/active/);
    expect(content).not.toMatch(/- task\/todo/);
  });

  it("uses timestamp without milliseconds", async () => {
    const { app, modify } = createMockApp();
    const mover = new TaskMover(app, "", defaultSettings);
    const file = { path: "2 - Areas/Tasks/todo/task.md", name: "task.md" } as TFile;

    await mover.move(file, "active");

    const content = modify.mock.calls[0][1] as string;
    const match = content.match(/^updated:\s*(.+)$/m);
    expect(match).not.toBeNull();
    // Should end with Z, not .123Z
    expect(match![1]).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
    expect(match![1]).not.toMatch(/\.\d{3}Z/);
  });

  it("appends activity log entry", async () => {
    const { app, modify } = createMockApp();
    const mover = new TaskMover(app, "", defaultSettings);
    const file = { path: "2 - Areas/Tasks/todo/task.md", name: "task.md" } as TFile;

    await mover.move(file, "active");

    const content = modify.mock.calls[0][1] as string;
    expect(content).toMatch(/Moved to active \(via kanban board\)/);
  });

  it("inserts activity log before next section", async () => {
    const contentWithNextSection = SAMPLE_CONTENT.trimEnd() + "\n\n## Notes\nSome notes\n";
    const { app, modify, read } = createMockApp();
    read.mockResolvedValue(contentWithNextSection);
    const mover = new TaskMover(app, "", defaultSettings);
    const file = { path: "2 - Areas/Tasks/todo/task.md", name: "task.md" } as TFile;

    await mover.move(file, "active");

    const content = modify.mock.calls[0][1] as string;
    const logIdx = content.indexOf("Moved to active");
    const notesIdx = content.indexOf("## Notes");
    expect(logIdx).toBeLessThan(notesIdx);
  });

  it("creates activity log section when missing", async () => {
    const contentNoLog = `---
id: abc-123
tags:
  - task
  - task/todo
state: todo
title: "Test Task"
updated: 2026-03-26T00:00:00Z
created: 2026-03-26T00:00:00Z
---
# Test Task
`;
    const { app, modify, read } = createMockApp();
    read.mockResolvedValue(contentNoLog);
    const mover = new TaskMover(app, "", defaultSettings);
    const file = { path: "2 - Areas/Tasks/todo/task.md", name: "task.md" } as TFile;

    await mover.move(file, "active");

    const content = modify.mock.calls[0][1] as string;
    expect(content).toContain("## Activity Log");
    expect(content).toMatch(/Moved to active \(via kanban board\)/);
  });

  it("does nothing when target is same column", async () => {
    const { app, modify } = createMockApp();
    const mover = new TaskMover(app, "", defaultSettings);
    const file = { path: "2 - Areas/Tasks/todo/task.md", name: "task.md" } as TFile;

    await mover.move(file, "todo");

    expect(modify).not.toHaveBeenCalled();
  });

  it("writes content before moving file (write-then-move)", async () => {
    const callOrder: string[] = [];
    const { app, modify, rename, getAbstractFileByPath } = createMockApp();
    modify.mockImplementation(() => {
      callOrder.push("modify");
      return Promise.resolve();
    });
    rename.mockImplementation(() => {
      callOrder.push("rename");
      return Promise.resolve();
    });
    getAbstractFileByPath.mockReturnValue(null);

    const mover = new TaskMover(app, "", defaultSettings);
    const file = { path: "2 - Areas/Tasks/todo/task.md", name: "task.md" } as TFile;

    await mover.move(file, "active");

    expect(callOrder).toEqual(["modify", "rename"]);
  });

  it("maps done column to archive folder", async () => {
    const { app, rename, getAbstractFileByPath } = createMockApp();
    getAbstractFileByPath.mockReturnValue(null);

    const mover = new TaskMover(app, "", defaultSettings);
    const file = { path: "2 - Areas/Tasks/todo/task.md", name: "task.md" } as TFile;

    await mover.move(file, "done");

    expect(rename).toHaveBeenCalledWith(file, "2 - Areas/Tasks/archive/task.md");
  });

  it("creates target folder if it doesn't exist", async () => {
    const { app, createFolder, getAbstractFileByPath } = createMockApp();
    getAbstractFileByPath.mockReturnValue(null);

    const mover = new TaskMover(app, "", defaultSettings);
    const file = { path: "2 - Areas/Tasks/todo/task.md", name: "task.md" } as TFile;

    await mover.move(file, "active");

    expect(createFolder).toHaveBeenCalledWith("2 - Areas/Tasks/active");
  });
});
