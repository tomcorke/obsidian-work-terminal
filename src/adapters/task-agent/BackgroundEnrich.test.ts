import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnHeadlessClaudeMock } = vi.hoisted(() => ({
  spawnHeadlessClaudeMock: vi.fn(),
}));

vi.mock("../../core/claude/HeadlessClaude", () => ({
  spawnHeadlessClaude: spawnHeadlessClaudeMock,
}));

import {
  handleItemCreated,
  insertIngestionFailedFlag,
  prepareRetryEnrichment,
  findFileByUuid,
} from "./BackgroundEnrich";

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

  describe("prepareRetryEnrichment", () => {
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

    it("returns enrichment prompt containing the full file path", async () => {
      const content = `---\nid: abc\nbackground-ingestion: failed\nstate: todo\n---\n# Task\n`;
      const app = makeApp(content);

      const prompt = await prepareRetryEnrichment(app, "tasks/test.md");

      expect(prompt).toContain("/vault/tasks/test.md");
      expect(prompt).toContain("needs enrichment");
      expect(prompt).toContain("rename the file to match the convention");
    });

    it("fully removes ingestion flag and callout from non-pending files", async () => {
      const content =
        `---\nid: abc\nbackground-ingestion: failed\nstate: todo\n---\n# Task\n\n` +
        `> [!warning] Background ingestion incomplete\n` +
        `> Automatic enrichment was attempted but did not complete successfully.\n`;
      const app = makeApp(content);

      await prepareRetryEnrichment(app, "tasks/test.md");

      expect(app.vault.modify).toHaveBeenCalled();
      const written = app.vault.modify.mock.calls.at(-1)![1] as string;
      expect(written).not.toContain("background-ingestion");
      expect(written).not.toContain("Background ingestion incomplete");
      expect(written).toContain("---\nid: abc\nstate: todo\n---");
    });

    it("fully removes ingestion flag and callout from pending files too", async () => {
      const content =
        `---\nid: abc\nbackground-ingestion: failed\nstate: todo\n---\n# Task\n\n` +
        `> [!warning] Background ingestion incomplete\n`;
      const app = makeApp(content);

      await prepareRetryEnrichment(app, "tasks/TASK-20260403-0126-pending-bf7a0012.md");

      expect(app.vault.modify).toHaveBeenCalled();
      const written = app.vault.modify.mock.calls.at(-1)![1] as string;
      expect(written).not.toContain("background-ingestion");
      expect(written).not.toContain("Background ingestion incomplete");
    });

    it("does not spawn headless Claude", async () => {
      const content = `---\nid: abc\nbackground-ingestion: failed\nstate: todo\n---\n# Task\n`;
      const app = makeApp(content);

      await prepareRetryEnrichment(app, "tasks/test.md");

      expect(spawnHeadlessClaudeMock).not.toHaveBeenCalled();
    });

    it("does not use a slash-command skill invocation in the prompt", async () => {
      const content = `---\nid: abc\nbackground-ingestion: failed\nstate: todo\n---\n# Task\n`;
      const app = makeApp(content);

      const prompt = await prepareRetryEnrichment(app, "tasks/test.md");

      expect(prompt).not.toMatch(/^\/tc-tasks:/);
      expect(prompt).not.toMatch(/^\/task-agent/);
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

    it("marks ingestion failed and reports timeout when headless Claude times out", async () => {
      spawnHeadlessClaudeMock.mockResolvedValue({
        exitCode: -1,
        stdout: "",
        stderr: "Headless Claude timed out after 300s",
        timedOut: true,
      });
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

    it("marks ingestion failed when task is moved during enrichment", async () => {
      spawnHeadlessClaudeMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

      // Simulate: file created at todo/, then moved to active/ during enrichment.
      // The key is that getAbstractFileByPath must NOT find the original path
      // after enrichment completes, simulating the move. We track whether
      // create has been called; after that, the spawned enrichment resolves,
      // and by that time the file has been "moved".
      const movedPath = "2 - Areas/Tasks/active/TASK-20260406-1200-pending-abcd1234.md";
      let createdUuid = "";
      let originalPath = "";
      let fileMoved = false;
      let storedContent = "";

      const app = {
        vault: {
          adapter: {
            basePath: "/vault",
            exists: vi.fn().mockResolvedValue(false),
          },
          getAbstractFileByPath(path: string) {
            // After the file is "moved", the original path is gone
            if (fileMoved && path === originalPath) return null;
            if (path === movedPath) return { path: movedPath };
            if (path === "2 - Areas/Tasks/todo") return { path };
            return null;
          },
          getMarkdownFiles() {
            return [{ path: movedPath }];
          },
          async createFolder(path: string) {
            return { path };
          },
          async create(path: string, content: string) {
            originalPath = path;
            storedContent = content;
            const idMatch = content.match(/^id:\s*(.+)$/m);
            if (idMatch) createdUuid = idMatch[1].trim();
            // Simulate the move happening before enrichment completes
            fileMoved = true;
            return { path, content };
          },
          read: vi.fn(async () => storedContent),
          modify: vi.fn(async (_file: any, content: string) => {
            storedContent = content;
          }),
        },
        metadataCache: {
          getFileCache(file: any) {
            if (file.path === movedPath) {
              return { frontmatter: { id: createdUuid } };
            }
            return null;
          },
        },
      } as any;

      const result = await handleItemCreated(app, "My task", defaultSettings);
      await result.enrichmentDone;

      // Should have called modify to mark ingestion as failed on the moved file
      expect(app.vault.modify).toHaveBeenCalled();
      const finalContent = app.vault.modify.mock.calls.at(-1)![1] as string;
      expect(finalContent).toContain("background-ingestion: failed");
    });

    it("marks ingestion failed at moved path when enrichment errors and file was moved", async () => {
      spawnHeadlessClaudeMock.mockRejectedValue(new Error("spawn failed"));

      const movedPath = "2 - Areas/Tasks/active/TASK-20260406-1200-pending-abcd1234.md";
      let createdUuid = "";
      let originalPath = "";
      let fileMoved = false;

      const app = {
        vault: {
          adapter: { basePath: "/vault" },
          getAbstractFileByPath(path: string) {
            if (fileMoved && path === originalPath) return null;
            if (path === movedPath) return { path: movedPath };
            if (path === "2 - Areas/Tasks/todo") return { path };
            return null;
          },
          getMarkdownFiles() {
            return [{ path: movedPath }];
          },
          async createFolder(path: string) {
            return { path };
          },
          async create(path: string, content: string) {
            originalPath = path;
            const idMatch = content.match(/^id:\s*(.+)$/m);
            if (idMatch) createdUuid = idMatch[1].trim();
            fileMoved = true;
            return { path, content };
          },
          read: vi.fn(async () => `---\nid: ${createdUuid}\nstate: active\n---\n# Task\n`),
          modify: vi.fn(async () => {}),
        },
        metadataCache: {
          getFileCache(file: any) {
            if (file.path === movedPath) {
              return { frontmatter: { id: createdUuid } };
            }
            return null;
          },
        },
      } as any;

      const result = await handleItemCreated(app, "My task", defaultSettings);
      await result.enrichmentDone;

      expect(app.vault.modify).toHaveBeenCalled();
      // The modify call should target the moved file path
      const modifyCall = app.vault.modify.mock.calls.at(-1)!;
      expect(modifyCall[0].path).toBe(movedPath);
    });
  });

  describe("findFileByUuid", () => {
    it("returns the file when UUID matches", () => {
      const file = { path: "2 - Areas/Tasks/todo/my-task.md" };
      const app = {
        vault: {
          getMarkdownFiles: () => [file],
        },
        metadataCache: {
          getFileCache: () => ({ frontmatter: { id: "test-uuid-123" } }),
        },
      } as any;

      const result = findFileByUuid(app, "test-uuid-123", "2 - Areas/Tasks");
      expect(result).toBe(file);
    });

    it("returns null when UUID does not match", () => {
      const file = { path: "2 - Areas/Tasks/todo/my-task.md" };
      const app = {
        vault: {
          getMarkdownFiles: () => [file],
        },
        metadataCache: {
          getFileCache: () => ({ frontmatter: { id: "different-uuid" } }),
        },
      } as any;

      const result = findFileByUuid(app, "test-uuid-123", "2 - Areas/Tasks");
      expect(result).toBeNull();
    });

    it("only searches files under the base path", () => {
      const taskFile = { path: "2 - Areas/Tasks/todo/my-task.md" };
      const otherFile = { path: "3 - Resources/notes.md" };
      const app = {
        vault: {
          getMarkdownFiles: () => [otherFile, taskFile],
        },
        metadataCache: {
          getFileCache: (f: any) => {
            if (f === taskFile) return { frontmatter: { id: "target-uuid" } };
            if (f === otherFile) return { frontmatter: { id: "target-uuid" } };
            return null;
          },
        },
      } as any;

      const result = findFileByUuid(app, "target-uuid", "2 - Areas/Tasks");
      expect(result).toBe(taskFile);
    });
  });
});
