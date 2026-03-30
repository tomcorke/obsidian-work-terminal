import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnHeadlessClaudeMock } = vi.hoisted(() => ({
  spawnHeadlessClaudeMock: vi.fn(),
}));

vi.mock("../../core/claude/HeadlessClaude", () => ({
  spawnHeadlessClaude: spawnHeadlessClaudeMock,
}));

import { handleItemCreated } from "./BackgroundEnrich";

describe("BackgroundEnrich", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.HOME = "/Users/tester";
    spawnHeadlessClaudeMock.mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
  });

  it("resolves relative Claude wrapper commands from core.defaultTerminalCwd during background enrichment", async () => {
    const existingPaths = new Set<string>();
    const createdFolders: string[] = [];
    const createdFiles: Array<{ path: string; content: string }> = [];

    const app = {
      vault: {
        adapter: {
          basePath: "/vault",
        },
        getAbstractFileByPath(path: string) {
          return existingPaths.has(path) ? { path } : null;
        },
        async createFolder(path: string) {
          existingPaths.add(path);
          createdFolders.push(path);
          return { path };
        },
        async create(path: string, content: string) {
          createdFiles.push({ path, content });
          return { path, content };
        },
      },
    } as any;

    const result = await handleItemCreated(app, "Fix relative wrapper launch", {
      _columnId: "todo",
      "adapter.taskBasePath": "2 - Areas/Tasks",
      "core.claudeCommand": "./bin/claude-wrapper",
      "core.defaultTerminalCwd": "~/launch-root",
      "core.claudeExtraArgs": "--allowedTools Edit",
    });

    await result.enrichmentDone;

    expect(createdFolders).toEqual(["2 - Areas/Tasks/todo"]);
    expect(createdFiles).toHaveLength(1);
    expect(spawnHeadlessClaudeMock).toHaveBeenCalledTimes(1);
    expect(spawnHeadlessClaudeMock).toHaveBeenCalledWith(
      expect.stringContaining("/vault/2 - Areas/Tasks/todo/"),
      "/Users/tester/launch-root",
      "./bin/claude-wrapper",
      "--allowedTools Edit",
    );
  });
});
