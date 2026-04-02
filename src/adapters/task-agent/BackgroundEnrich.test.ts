import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnHeadlessClaudeMock } = vi.hoisted(() => ({
  spawnHeadlessClaudeMock: vi.fn(),
}));

vi.mock("../../core/claude/HeadlessClaude", () => ({
  spawnHeadlessClaude: spawnHeadlessClaudeMock,
}));

import { handleItemCreated, insertIngestionFailedFlag, retryEnrichment } from "./BackgroundEnrich";

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

  describe("insertIngestionFailedFlag", () => {
    it("inserts background-ingestion: failed into frontmatter", () => {
      const content = `---\nid: test-123\nstate: todo\n---\n# My Task\n`;
      const result = insertIngestionFailedFlag(content);

      expect(result).toContain("background-ingestion: failed");
      expect(result).toContain("Background ingestion incomplete");
    });

    it("replaces existing background-ingestion field", () => {
      const content = `---\nid: test-123\nbackground-ingestion: retrying\nstate: todo\n---\n# My Task\n`;
      const result = insertIngestionFailedFlag(content);

      expect(result).toContain("background-ingestion: failed");
      expect(result).not.toContain("background-ingestion: retrying");
    });

    it("does not duplicate the callout note", () => {
      const content = `---\nid: test-123\nstate: todo\n---\n# My Task\n\n> [!warning] Background ingestion incomplete\n`;
      const result = insertIngestionFailedFlag(content);

      const matches = result.match(/Background ingestion incomplete/g);
      expect(matches).toHaveLength(1);
    });

    it("returns content unchanged when no frontmatter present", () => {
      const content = "# No frontmatter here\n";
      const result = insertIngestionFailedFlag(content);

      expect(result).toBe(content);
    });

    it("does not treat a horizontal rule --- as frontmatter", () => {
      const content = "# Title\n\nSome text\n\n---\n\nMore text\n";
      const result = insertIngestionFailedFlag(content);

      expect(result).toBe(content);
    });
  });

  describe("retryEnrichment", () => {
    function makeApp(fileContent: string) {
      let storedContent = fileContent;
      return {
        vault: {
          adapter: { basePath: "/vault" },
          getAbstractFileByPath: (path: string) => ({ path }),
          read: vi.fn(async () => storedContent),
          modify: vi.fn(async (_file: any, content: string) => {
            storedContent = content;
          }),
        },
        getStoredContent: () => storedContent,
      } as any;
    }

    const defaultSettings = {
      "core.claudeCommand": "claude",
      "core.defaultTerminalCwd": "~/work",
      "core.claudeExtraArgs": "",
    };

    it("clears ingestion flag and callout on success", async () => {
      const content =
        `---\nid: abc\nbackground-ingestion: failed\nstate: todo\n---\n# Task\n\n` +
        `> [!warning] Background ingestion incomplete\n` +
        `> Automatic enrichment was attempted but did not complete successfully.\n` +
        `> To enrich this task, right-click the card and select **Retry Enrichment**,\n` +
        `> or open a Claude session and use the task-agent skill manually.\n`;

      spawnHeadlessClaudeMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
      const app = makeApp(content);

      await retryEnrichment(app, "tasks/test.md", defaultSettings);

      expect(app.vault.modify).toHaveBeenCalled();
      const finalContent = app.vault.modify.mock.calls.at(-1)![1] as string;
      expect(finalContent).not.toContain("background-ingestion");
      expect(finalContent).not.toContain("Background ingestion incomplete");
    });

    it("marks ingestion failed again on non-zero exit", async () => {
      const content = `---\nid: abc\nbackground-ingestion: failed\nstate: todo\n---\n# Task\n`;
      spawnHeadlessClaudeMock.mockResolvedValue({
        exitCode: 1,
        stdout: "",
        stderr: "something went wrong",
      });
      const app = makeApp(content);

      await retryEnrichment(app, "tasks/test.md", defaultSettings);

      // Should have been called at least twice: once for clearIngestionFailedFlag, once for markIngestionFailed
      expect(app.vault.modify).toHaveBeenCalled();
      const finalContent = app.vault.modify.mock.calls.at(-1)![1] as string;
      expect(finalContent).toContain("background-ingestion: failed");
    });

    it("marks ingestion failed when CLI is missing", async () => {
      const content = `---\nid: abc\nbackground-ingestion: failed\nstate: todo\n---\n# Task\n`;
      spawnHeadlessClaudeMock.mockResolvedValue({
        exitCode: 1,
        stdout: "",
        stderr: "claude: command not found",
        missingCli: true,
      });
      const app = makeApp(content);

      await retryEnrichment(app, "tasks/test.md", defaultSettings);

      expect(app.vault.modify).toHaveBeenCalled();
      const finalContent = app.vault.modify.mock.calls.at(-1)![1] as string;
      expect(finalContent).toContain("background-ingestion: failed");
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
