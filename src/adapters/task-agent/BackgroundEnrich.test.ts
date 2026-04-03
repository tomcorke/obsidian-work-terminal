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
          adapter: {
            basePath: "/vault",
            exists: vi.fn().mockResolvedValue(false),
          },
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

  describe("handleItemCreated", () => {
    function makeItemCreatedApp({ fileExistsAfterEnrich = false } = {}) {
      const existingPaths = new Set<string>();
      const createdFolders: string[] = [];
      const createdFiles: Array<{ path: string; content: string }> = [];
      let storedContent = "";
      const modifyCalls: Array<{ path: string; content: string }> = [];

      return {
        vault: {
          adapter: {
            basePath: "/vault",
            exists: vi.fn().mockResolvedValue(fileExistsAfterEnrich),
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
            existingPaths.add(path);
            createdFiles.push({ path, content });
            storedContent = content;
            return { path, content };
          },
          read: vi.fn(async () => storedContent),
          modify: vi.fn(async (_file: any, content: string) => {
            storedContent = content;
            modifyCalls.push({ path: _file.path, content });
          }),
        },
        createdFolders,
        createdFiles,
        modifyCalls,
        getStoredContent: () => storedContent,
      } as any;
    }

    const defaultSettings = {
      _columnId: "todo",
      "adapter.taskBasePath": "2 - Areas/Tasks",
      "core.claudeCommand": "claude",
      "core.defaultTerminalCwd": "~/work",
      "core.claudeExtraArgs": "",
    };

    it("resolves relative Claude wrapper commands from core.defaultTerminalCwd", async () => {
      spawnHeadlessClaudeMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
      const app = makeItemCreatedApp({ fileExistsAfterEnrich: false });

      const result = await handleItemCreated(app, "Fix relative wrapper launch", {
        _columnId: "todo",
        "adapter.taskBasePath": "2 - Areas/Tasks",
        "core.claudeCommand": "./bin/claude-wrapper",
        "core.defaultTerminalCwd": "~/launch-root",
        "core.claudeExtraArgs": "--allowedTools Edit",
      });

      await result.enrichmentDone;

      expect(app.createdFolders).toEqual(["2 - Areas/Tasks/todo"]);
      expect(app.createdFiles).toHaveLength(1);
      expect(spawnHeadlessClaudeMock).toHaveBeenCalledWith(
        expect.stringContaining("/vault/2 - Areas/Tasks/todo/"),
        "/Users/tester/launch-root",
        "./bin/claude-wrapper",
        "--allowedTools Edit",
      );
    });

    it("does not use a slash-command skill invocation in the enrich prompt", async () => {
      spawnHeadlessClaudeMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
      const app = makeItemCreatedApp({ fileExistsAfterEnrich: false });

      const result = await handleItemCreated(app, "My task", defaultSettings);
      await result.enrichmentDone;

      const [promptArg] = spawnHeadlessClaudeMock.mock.calls[0];
      expect(promptArg).not.toMatch(/^\/tc-tasks:/);
      expect(promptArg).not.toMatch(/^\/task-agent/);
    });

    it("marks ingestion failed when stdout contains 'Unknown skill' even on exit 0", async () => {
      spawnHeadlessClaudeMock.mockResolvedValue({
        exitCode: 0,
        stdout: "Unknown skill: tc-tasks:task-agent\n",
        stderr: "",
      });
      const app = makeItemCreatedApp({ fileExistsAfterEnrich: true });

      const result = await handleItemCreated(app, "My task", defaultSettings);
      await result.enrichmentDone;

      expect(app.vault.modify).toHaveBeenCalled();
      const finalContent = app.vault.modify.mock.calls.at(-1)![1] as string;
      expect(finalContent).toContain("background-ingestion: failed");
    });

    it("marks ingestion failed when pending file is unchanged after exit 0 (no-op enrichment)", async () => {
      spawnHeadlessClaudeMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
      // fileExistsAfterEnrich: true simulates Claude exiting 0 without renaming the file
      const app = makeItemCreatedApp({ fileExistsAfterEnrich: true });

      const result = await handleItemCreated(app, "My task", defaultSettings);
      await result.enrichmentDone;

      expect(app.vault.modify).toHaveBeenCalled();
      const finalContent = app.vault.modify.mock.calls.at(-1)![1] as string;
      expect(finalContent).toContain("background-ingestion: failed");
    });

    it("does not mark ingestion failed when pending file was renamed away on exit 0", async () => {
      spawnHeadlessClaudeMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
      // fileExistsAfterEnrich: false simulates Claude successfully renaming the file
      const app = makeItemCreatedApp({ fileExistsAfterEnrich: false });

      const result = await handleItemCreated(app, "My task", defaultSettings);
      await result.enrichmentDone;

      // modify should NOT have been called (no failure marking)
      expect(app.vault.modify).not.toHaveBeenCalled();
    });
  });

  describe("retryEnrichment - silent failure detection", () => {
    function makeApp(fileContent: string) {
      let storedContent = fileContent;
      return {
        vault: {
          adapter: {
            basePath: "/vault",
            exists: vi.fn().mockResolvedValue(false),
          },
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

    it("marks ingestion failed when retry stdout contains 'Unknown skill' on exit 0", async () => {
      const content = `---\nid: abc\nbackground-ingestion: failed\nstate: todo\n---\n# Task\n`;
      spawnHeadlessClaudeMock.mockResolvedValue({
        exitCode: 0,
        stdout: "Unknown skill: tc-tasks:task-agent\n",
        stderr: "",
      });
      const app = makeApp(content);

      await retryEnrichment(app, "tasks/test.md", defaultSettings);

      expect(app.vault.modify).toHaveBeenCalled();
      const finalContent = app.vault.modify.mock.calls.at(-1)![1] as string;
      expect(finalContent).toContain("background-ingestion: failed");
    });

    it("marks ingestion failed when pending file still exists after retry exit 0", async () => {
      const content = `---\nid: abc\nbackground-ingestion: failed\nstate: todo\n---\n# Task\n`;
      spawnHeadlessClaudeMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
      const app = makeApp(content);
      // Simulate the pending file still existing after enrichment
      app.vault.adapter.exists.mockResolvedValue(true);

      await retryEnrichment(app, "tasks/TASK-20260403-0126-pending-bf7a0012.md", defaultSettings);

      expect(app.vault.modify).toHaveBeenCalled();
      const finalContent = app.vault.modify.mock.calls.at(-1)![1] as string;
      expect(finalContent).toContain("background-ingestion: failed");
    });

    it("does not apply pending-file check for non-pending retry paths", async () => {
      const content = `---\nid: abc\nbackground-ingestion: failed\nstate: todo\n---\n# Task\n`;
      spawnHeadlessClaudeMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
      const app = makeApp(content);
      // exists returns true, but the path has no "pending-" so check should be skipped
      app.vault.adapter.exists.mockResolvedValue(true);

      await retryEnrichment(app, "tasks/TASK-20260403-0126-my-task.md", defaultSettings);

      // Should have succeeded (modify called only for clearIngestionFailedFlag + success cleanup)
      const lastContent = app.vault.modify.mock.calls.at(-1)![1] as string;
      expect(lastContent).not.toContain("background-ingestion: failed");
    });

    it("does not use a slash-command skill invocation in the retry prompt", async () => {
      const content = `---\nid: abc\nbackground-ingestion: failed\nstate: todo\n---\n# Task\n`;
      spawnHeadlessClaudeMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
      const app = makeApp(content);

      await retryEnrichment(app, "tasks/test.md", defaultSettings);

      const [promptArg] = spawnHeadlessClaudeMock.mock.calls[0];
      expect(promptArg).not.toMatch(/^\/tc-tasks:/);
      expect(promptArg).not.toMatch(/^\/task-agent/);
    });
  });
});
