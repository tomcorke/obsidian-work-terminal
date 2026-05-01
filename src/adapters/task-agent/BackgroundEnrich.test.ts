import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnHeadlessClaudeMock, spawnHeadlessAgentMock, writeEnrichmentLogMock } = vi.hoisted(
  () => ({
    spawnHeadlessClaudeMock: vi.fn(),
    spawnHeadlessAgentMock: vi.fn(),
    writeEnrichmentLogMock: vi.fn(),
  }),
);

vi.mock("../../core/claude/HeadlessClaude", () => ({
  spawnHeadlessClaude: spawnHeadlessClaudeMock,
  spawnHeadlessAgent: spawnHeadlessAgentMock,
  DEFAULT_TIMEOUT_MS: 300_000,
}));

vi.mock("./EnrichmentLogger", () => ({
  writeEnrichmentLog: writeEnrichmentLogMock,
}));

import {
  handleItemCreated,
  handleSubTaskCreated,
  insertIngestionFailedFlag,
  prepareRetryEnrichment,
  findFileByUuid,
  resolveEnrichmentTimeout,
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
    spawnHeadlessAgentMock.mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    writeEnrichmentLogMock.mockResolvedValue(undefined);
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

    it("returns enrichment prompt containing the absolute file path", async () => {
      const content = `---\nid: abc\nbackground-ingestion: failed\nstate: todo\n---\n# Task\n`;
      const app = makeApp(content);

      const prompt = await prepareRetryEnrichment(app, "tasks/test.md");

      // The default retry prompt uses $absoluteFilePath, so the absolute
      // filesystem path ("/vault/tasks/test.md") must appear in the resolved
      // prompt and the vault-relative path ("tasks/test.md") must not appear
      // as a bare substring unless part of the absolute path.
      expect(prompt).toContain("/vault/tasks/test.md");
      expect(prompt).toContain("needs enrichment");
      expect(prompt).toContain("rename the file to match the convention");
    });

    it("substitutes $filePath with vault-relative and $absoluteFilePath with absolute path", async () => {
      const content = `---\nid: abc\nbackground-ingestion: failed\nstate: todo\n---\n# Task\n`;
      const app = makeApp(content);

      const prompt = await prepareRetryEnrichment(
        app,
        "tasks/test.md",
        "relative=$filePath absolute=$absoluteFilePath",
      );

      expect(prompt).toBe("relative=tasks/test.md absolute=/vault/tasks/test.md");
    });

    it("does not mangle $filePathX / $filePathBasename identifiers", async () => {
      const content = `---\nid: abc\nbackground-ingestion: failed\nstate: todo\n---\n# Task\n`;
      const app = makeApp(content);

      const prompt = await prepareRetryEnrichment(
        app,
        "tasks/test.md",
        "path=$filePath custom=$filePathX basename=$filePathBasename absCustom=$absoluteFilePathX",
      );

      expect(prompt).toBe(
        "path=tasks/test.md custom=$filePathX basename=$filePathBasename absCustom=$absoluteFilePathX",
      );
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

    it("uses custom retry prompt template when provided", async () => {
      const content = `---\nid: abc\nbackground-ingestion: failed\nstate: todo\n---\n# Task\n`;
      const app = makeApp(content);

      const prompt = await prepareRetryEnrichment(
        app,
        "tasks/test.md",
        "Custom retry for $filePath with extra instructions",
      );

      expect(prompt).toBe("Custom retry for tasks/test.md with extra instructions");
    });

    it("uses default retry prompt when no template is provided", async () => {
      const content = `---\nid: abc\nbackground-ingestion: failed\nstate: todo\n---\n# Task\n`;
      const app = makeApp(content);

      const prompt = await prepareRetryEnrichment(app, "tasks/test.md");

      expect(prompt).toContain("needs enrichment");
      // Default prompt uses $absoluteFilePath, so the absolute path appears.
      expect(prompt).toContain("/vault/tasks/test.md");
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
        300_000,
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

    it("succeeds when Claude renames the pending file during enrichment (UUID resolves to new name in same folder)", async () => {
      spawnHeadlessClaudeMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

      // Simulate: Claude renames the pending file to a proper slug name in the same folder.
      // The original path is gone, but UUID lookup finds the renamed file.
      const renamedPath = "2 - Areas/Tasks/todo/TASK-20260406-1200-fix-the-widget.md";
      let createdUuid = "";
      let originalPath = "";
      let storedContent = "";

      const app = {
        vault: {
          adapter: {
            basePath: "/vault",
            // Original pending path no longer exists
            exists: vi.fn().mockResolvedValue(false),
          },
          getAbstractFileByPath(path: string) {
            // Original path is gone (Claude renamed it)
            if (path === originalPath) return null;
            if (path === renamedPath) return { path: renamedPath };
            if (path === "2 - Areas/Tasks/todo") return { path };
            return null;
          },
          getMarkdownFiles() {
            return [{ path: renamedPath }];
          },
          async createFolder(path: string) {
            return { path };
          },
          async create(path: string, content: string) {
            originalPath = path;
            storedContent = content;
            const idMatch = content.match(/^id:\s*(.+)$/m);
            if (idMatch) createdUuid = idMatch[1].trim();
            return { path, content };
          },
          read: vi.fn(async () => storedContent),
          modify: vi.fn(async (_file: any, content: string) => {
            storedContent = content;
          }),
        },
        metadataCache: {
          getFileCache(file: any) {
            if (file.path === renamedPath) {
              return { frontmatter: { id: createdUuid } };
            }
            return null;
          },
        },
      } as any;

      const result = await handleItemCreated(app, "Fix the widget", defaultSettings);
      await result.enrichmentDone;

      // modify should NOT have been called - this is a successful enrichment
      expect(app.vault.modify).not.toHaveBeenCalled();
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
      expect(app.vault.modify.mock.calls.at(-1)![0].path).toBe(movedPath);
      const finalContent = app.vault.modify.mock.calls.at(-1)![1] as string;
      expect(finalContent).toContain("background-ingestion: failed");
    });

    it("skips enrichment when adapter.enrichmentEnabled is false", async () => {
      const app = makeItemCreatedApp({ fileExistsAfterEnrich: true });

      const result = await handleItemCreated(app, "My task", {
        ...defaultSettings,
        "adapter.enrichmentEnabled": false,
      });
      await result.enrichmentDone;

      expect(spawnHeadlessClaudeMock).not.toHaveBeenCalled();
      expect(app.vault.modify).not.toHaveBeenCalled();
    });

    it("returns a foreground enrichment prompt without spawning headless enrichment", async () => {
      const app = makeItemCreatedApp({ fileExistsAfterEnrich: true });

      const result = await handleItemCreated(app, "Foreground enrich", {
        ...defaultSettings,
        "adapter.enrichmentMode": "foreground",
      });
      await result.enrichmentDone;

      expect(spawnHeadlessClaudeMock).not.toHaveBeenCalled();
      expect(spawnHeadlessAgentMock).not.toHaveBeenCalled();
      expect(result.path).toMatch(/^2 - Areas\/Tasks\/todo\/TASK-\d{8}-\d{4}-pending-/);
      expect(result.title).toBe("Foreground enrich");
      expect(result.foregroundEnrichment).toEqual({
        prompt: expect.stringContaining("/vault/2 - Areas/Tasks/todo/"),
        label: "Enrich",
      });
      expect(app.createdFiles[0].content).toContain("enrichment:");
    });

    it("uses a custom enrichment prompt for foreground enrichment", async () => {
      const app = makeItemCreatedApp({ fileExistsAfterEnrich: true });

      const result = await handleItemCreated(app, "Foreground custom", {
        ...defaultSettings,
        "adapter.enrichmentMode": "foreground",
        "adapter.enrichmentPrompt": "Review $filePath and $absoluteFilePath",
      });

      expect(result.foregroundEnrichment?.prompt).toContain("Review 2 - Areas/Tasks/todo/");
      expect(result.foregroundEnrichment?.prompt).toContain("/vault/2 - Areas/Tasks/todo/");
      expect(spawnHeadlessClaudeMock).not.toHaveBeenCalled();
    });

    it("uses custom enrichment prompt when adapter.enrichmentPrompt is set", async () => {
      spawnHeadlessClaudeMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
      const app = makeItemCreatedApp({ fileExistsAfterEnrich: false });
      const customPrompt = "Custom enrich: $filePath please do things";

      const result = await handleItemCreated(app, "My task", {
        ...defaultSettings,
        "adapter.enrichmentPrompt": customPrompt,
      });
      await result.enrichmentDone;

      const [promptArg] = spawnHeadlessClaudeMock.mock.calls[0];
      expect(promptArg).toContain("Custom enrich:");
      // $filePath substitutes to the vault-relative path, not the absolute
      // path, so expect the base path prefix rather than the vault root.
      expect(promptArg).toContain("2 - Areas/Tasks/todo/");
      expect(promptArg).not.toContain("/vault/2 - Areas/Tasks/todo/");
      expect(promptArg).toContain("please do things");
      expect(promptArg).not.toContain("$filePath");
    });

    it("substitutes $filePath with vault-relative and $absoluteFilePath with absolute path", async () => {
      spawnHeadlessClaudeMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
      const app = makeItemCreatedApp({ fileExistsAfterEnrich: false });
      const customPrompt = "rel=$filePath abs=$absoluteFilePath";

      const result = await handleItemCreated(app, "Both placeholders", {
        ...defaultSettings,
        "adapter.enrichmentPrompt": customPrompt,
      });
      await result.enrichmentDone;

      const [promptArg] = spawnHeadlessClaudeMock.mock.calls[0];
      // Two segments separated by " abs=". The vault-relative one must not
      // start with "/vault"; the absolute one must.
      const match = promptArg.match(/^rel=(.+?) abs=(.+)$/);
      expect(match).not.toBeNull();
      const [, rel, abs] = match!;
      expect(rel.startsWith("2 - Areas/Tasks/todo/")).toBe(true);
      expect(abs.startsWith("/vault/2 - Areas/Tasks/todo/")).toBe(true);
      // Absolute path should end with the vault-relative path.
      expect(abs.endsWith(rel)).toBe(true);
    });

    it("does not substitute $filePath embedded in longer identifiers like $filePathBasename", async () => {
      spawnHeadlessClaudeMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
      const app = makeItemCreatedApp({ fileExistsAfterEnrich: false });
      // Mix of real placeholders and prefix-colliding identifiers. The real
      // placeholders must substitute; the prefixed identifiers must not.
      const customPrompt =
        "path=$filePath custom=$filePathBasename other=$filePathX absCustom=$absoluteFilePathBasename";

      const result = await handleItemCreated(app, "Prefix test", {
        ...defaultSettings,
        "adapter.enrichmentPrompt": customPrompt,
      });
      await result.enrichmentDone;

      const [promptArg] = spawnHeadlessClaudeMock.mock.calls[0];
      expect(promptArg).toContain("custom=$filePathBasename");
      expect(promptArg).toContain("other=$filePathX");
      expect(promptArg).toContain("absCustom=$absoluteFilePathBasename");
      // The "path=" value should be the vault-relative path and must not
      // include the $filePath literal (i.e. substitution still happened).
      expect(promptArg).toMatch(/path=2 - Areas\/Tasks\/todo\//);
    });

    it("uses default enrichment prompt when adapter.enrichmentPrompt is empty", async () => {
      spawnHeadlessClaudeMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
      const app = makeItemCreatedApp({ fileExistsAfterEnrich: false });

      const result = await handleItemCreated(app, "My task", {
        ...defaultSettings,
        "adapter.enrichmentPrompt": "",
      });
      await result.enrichmentDone;

      const [promptArg] = spawnHeadlessClaudeMock.mock.calls[0];
      expect(promptArg).toContain("was just created with minimal data");
    });

    it("failure note does not reference environment-specific skills", () => {
      const content = `---\nid: test-123\nstate: todo\n---\n# My Task\n`;
      const result = insertIngestionFailedFlag(content);

      expect(result).not.toContain("task-agent skill");
      expect(result).toContain("enrich the task manually");
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

    it("passes custom enrichment timeout to spawnHeadlessClaude", async () => {
      spawnHeadlessClaudeMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
      const app = makeItemCreatedApp({ fileExistsAfterEnrich: false });
      const settings = {
        ...defaultSettings,
        "adapter.enrichmentTimeout": "120",
      };

      const result = await handleItemCreated(app, "Timeout test", settings);
      await result.enrichmentDone;

      expect(spawnHeadlessClaudeMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(String),
        expect.any(String),
        120_000,
      );
    });

    it("uses profile override command, args, and cwd when provided", async () => {
      spawnHeadlessClaudeMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
      const app = makeItemCreatedApp({ fileExistsAfterEnrich: false });

      const profileOverride = {
        command: "/custom/agent",
        args: "--model gpt-4",
        cwd: "~/projects",
      };

      const result = await handleItemCreated(app, "Profile test", defaultSettings, profileOverride);
      await result.enrichmentDone;

      expect(spawnHeadlessClaudeMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining("projects"), // expanded from ~/projects
        "/custom/agent",
        "--model gpt-4",
        expect.any(Number),
      );
    });

    it("uses spawnHeadlessAgent with flag mode for non-Claude profiles", async () => {
      const app = makeItemCreatedApp({ fileExistsAfterEnrich: false });

      const profileOverride = {
        command: "/usr/local/bin/my-agent",
        args: "--verbose",
        cwd: "~/work",
        agentName: "MyAgent",
        promptMode: "flag" as const,
        promptFlag: "-i",
      };

      const result = await handleItemCreated(
        app,
        "Flag mode test",
        defaultSettings,
        profileOverride,
      );
      await result.enrichmentDone;

      // Should use spawnHeadlessAgent, not spawnHeadlessClaude
      expect(spawnHeadlessClaudeMock).not.toHaveBeenCalled();
      expect(spawnHeadlessAgentMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          command: "/usr/local/bin/my-agent",
          extraArgs: "--verbose",
          promptMode: "flag",
          promptFlag: "-i",
          agentName: "MyAgent",
        }),
      );
    });

    it("uses spawnHeadlessAgent with positional mode for positional profiles", async () => {
      const app = makeItemCreatedApp({ fileExistsAfterEnrich: false });

      const profileOverride = {
        command: "custom-cli",
        args: "",
        cwd: "~/work",
        promptMode: "positional" as const,
      };

      const result = await handleItemCreated(
        app,
        "Positional test",
        defaultSettings,
        profileOverride,
      );
      await result.enrichmentDone;

      expect(spawnHeadlessClaudeMock).not.toHaveBeenCalled();
      expect(spawnHeadlessAgentMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          command: "custom-cli",
          promptMode: "positional",
        }),
      );
    });

    it("uses spawnHeadlessClaude for profiles with claude promptMode", async () => {
      spawnHeadlessClaudeMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
      const app = makeItemCreatedApp({ fileExistsAfterEnrich: false });

      const profileOverride = {
        command: "pi",
        args: "--model sonnet",
        cwd: "~/work",
        promptMode: "claude" as const,
      };

      const result = await handleItemCreated(
        app,
        "Claude mode profile",
        defaultSettings,
        profileOverride,
      );
      await result.enrichmentDone;

      // Should use spawnHeadlessClaude (Claude-compatible agent)
      expect(spawnHeadlessClaudeMock).toHaveBeenCalled();
      expect(spawnHeadlessAgentMock).not.toHaveBeenCalled();
    });

    it("includes enrichment metadata in the created file content", async () => {
      spawnHeadlessClaudeMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
      const app = makeItemCreatedApp({ fileExistsAfterEnrich: false });

      const result = await handleItemCreated(app, "Enrich meta test", defaultSettings);
      await result.enrichmentDone;

      expect(app.createdFiles).toHaveLength(1);
      const fileContent = app.createdFiles[0].content;
      expect(fileContent).toContain("enrichment:");
      expect(fileContent).toMatch(/^\s+command: "claude"$/m);
      expect(fileContent).toMatch(/^\s+args: ""$/m);
      expect(fileContent).toMatch(/^\s+prompt: "/m);
      expect(fileContent).toMatch(/^\s+cwd: "/m);
    });

    it("includes profile name in enrichment metadata when profile override is provided", async () => {
      spawnHeadlessClaudeMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
      const app = makeItemCreatedApp({ fileExistsAfterEnrich: false });

      const profileOverride = {
        command: "pi",
        args: "--model sonnet",
        cwd: "~/projects",
        agentName: "pi",
      };

      const result = await handleItemCreated(
        app,
        "Profile meta test",
        defaultSettings,
        profileOverride,
      );
      await result.enrichmentDone;

      const fileContent = app.createdFiles[0].content;
      expect(fileContent).toContain("enrichment:");
      expect(fileContent).toMatch(/^\s+profile: "pi"$/m);
      expect(fileContent).toMatch(/^\s+command: "pi"$/m);
      expect(fileContent).toMatch(/^\s+args: "--model sonnet"$/m);
    });

    it("omits enrichment metadata when enrichment is disabled", async () => {
      const app = makeItemCreatedApp({ fileExistsAfterEnrich: true });

      const result = await handleItemCreated(app, "No enrich", {
        ...defaultSettings,
        "adapter.enrichmentEnabled": false,
      });
      await result.enrichmentDone;

      const fileContent = app.createdFiles[0].content;
      expect(fileContent).not.toContain("enrichment:");
    });

    it("falls back to core settings when no profile override is provided", async () => {
      spawnHeadlessClaudeMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
      const app = makeItemCreatedApp({ fileExistsAfterEnrich: false });

      const result = await handleItemCreated(app, "Default test", defaultSettings);
      await result.enrichmentDone;

      expect(spawnHeadlessClaudeMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        "claude",
        "",
        expect.any(Number),
      );
    });
  });

  describe("enrichment failure logging", () => {
    const defaultSettings = {
      _columnId: "todo",
      "adapter.taskBasePath": "2 - Areas/Tasks",
      "core.claudeCommand": "claude",
      "core.defaultTerminalCwd": "~/work",
      "core.claudeExtraArgs": "",
    };

    function makeItemCreatedApp({ fileExistsAfterEnrich = false } = {}) {
      const existingPaths = new Set<string>();
      let storedContent = "";
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
            return { path };
          },
          async create(path: string, content: string) {
            existingPaths.add(path);
            storedContent = content;
            return { path, content };
          },
          read: vi.fn(async () => storedContent),
          modify: vi.fn(async (_file: any, content: string) => {
            storedContent = content;
          }),
        },
      } as any;
    }

    it("logs on timeout with timeout category and captured stderr", async () => {
      spawnHeadlessClaudeMock.mockResolvedValue({
        exitCode: -1,
        stdout: "partial",
        stderr: "Headless Claude timed out after 300s",
        timedOut: true,
      });
      const app = makeItemCreatedApp({ fileExistsAfterEnrich: true });

      const result = await handleItemCreated(app, "Logged timeout", defaultSettings);
      await result.enrichmentDone;

      expect(writeEnrichmentLogMock).toHaveBeenCalledTimes(1);
      const [, params] = writeEnrichmentLogMock.mock.calls[0];
      expect(params.category).toBe("timeout");
      expect(params.stderr).toContain("timed out");
      expect(params.titleHint).toBe("Logged timeout");
      expect(params.prompt).toContain("/vault/2 - Areas/Tasks/todo/");
    });

    it("logs on non-zero exit with exit code", async () => {
      spawnHeadlessClaudeMock.mockResolvedValue({
        exitCode: 1,
        stdout: "",
        stderr: "boom",
      });
      const app = makeItemCreatedApp({ fileExistsAfterEnrich: true });

      const result = await handleItemCreated(app, "Exit 1", defaultSettings);
      await result.enrichmentDone;

      expect(writeEnrichmentLogMock).toHaveBeenCalledTimes(1);
      const [, params] = writeEnrichmentLogMock.mock.calls[0];
      expect(params.category).toBe("non-zero-exit");
      expect(params.exitCode).toBe(1);
    });

    it("logs on silent failure (Unknown skill stdout + exit 0)", async () => {
      spawnHeadlessClaudeMock.mockResolvedValue({
        exitCode: 0,
        stdout: "Unknown skill: foo\n",
        stderr: "",
      });
      const app = makeItemCreatedApp({ fileExistsAfterEnrich: true });

      const result = await handleItemCreated(app, "Silent failure", defaultSettings);
      await result.enrichmentDone;

      expect(writeEnrichmentLogMock).toHaveBeenCalledTimes(1);
      const [, params] = writeEnrichmentLogMock.mock.calls[0];
      expect(params.category).toBe("silent-failure");
      expect(params.adapterValidation).toContain("Unknown skill");
    });

    it("logs on pending-not-renamed validation failure", async () => {
      spawnHeadlessClaudeMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
      const app = makeItemCreatedApp({ fileExistsAfterEnrich: true });

      const result = await handleItemCreated(app, "Pending stuck", defaultSettings);
      await result.enrichmentDone;

      expect(writeEnrichmentLogMock).toHaveBeenCalledTimes(1);
      const [, params] = writeEnrichmentLogMock.mock.calls[0];
      expect(params.category).toBe("pending-not-renamed");
    });

    it("logs on spawn rejection with the original error", async () => {
      spawnHeadlessClaudeMock.mockRejectedValue(new Error("ENOENT"));
      const app = makeItemCreatedApp({ fileExistsAfterEnrich: true });

      const result = await handleItemCreated(app, "Spawn fail", defaultSettings);
      await result.enrichmentDone;

      expect(writeEnrichmentLogMock).toHaveBeenCalledTimes(1);
      const [, params] = writeEnrichmentLogMock.mock.calls[0];
      expect(params.category).toBe("spawn-error");
      expect(params.error).toBeInstanceOf(Error);
      expect((params.error as Error).message).toBe("ENOENT");
    });

    it("does not log on success", async () => {
      spawnHeadlessClaudeMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
      const app = makeItemCreatedApp({ fileExistsAfterEnrich: false });

      const result = await handleItemCreated(app, "Success path", defaultSettings);
      await result.enrichmentDone;

      expect(writeEnrichmentLogMock).not.toHaveBeenCalled();
    });

    it("respects core.enrichmentLogging=false and skips logging", async () => {
      spawnHeadlessClaudeMock.mockResolvedValue({
        exitCode: 1,
        stdout: "",
        stderr: "nope",
      });
      const app = makeItemCreatedApp({ fileExistsAfterEnrich: true });

      const result = await handleItemCreated(app, "No logs please", {
        ...defaultSettings,
        "core.enrichmentLogging": false,
      });
      await result.enrichmentDone;

      expect(writeEnrichmentLogMock).not.toHaveBeenCalled();
    });
  });

  describe("handleSubTaskCreated", () => {
    function makeSubTaskApp(existingFolders: string[] = []) {
      const existingPaths = new Set(existingFolders);
      const createdFolders: string[] = [];
      const createdFiles: Array<{ path: string; content: string }> = [];

      return {
        vault: {
          adapter: {
            exists: vi.fn().mockResolvedValue(false),
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
            return { path, content };
          },
        },
        createdFolders,
        createdFiles,
      } as any;
    }

    it("uses a resolved folder mapping for custom sub-task states", async () => {
      const app = makeSubTaskApp();

      await handleSubTaskCreated(
        app,
        {
          id: "parent-id",
          title: "Parent task",
          path: "2 - Areas/Tasks/todo/parent.md",
          filename: "parent.md",
          tags: ["task", "task/todo", "jira/ABC-123"],
        },
        "Review contract",
        "blocked",
        "2 - Areas/Tasks",
        "blocked-work",
      );

      expect(app.createdFolders).toEqual(["2 - Areas/Tasks/blocked-work"]);
      expect(app.createdFiles[0].path).toContain("2 - Areas/Tasks/blocked-work/");
      expect(app.createdFiles[0].content).toContain("state: blocked");
      expect(app.createdFiles[0].content).toContain("  - task/blocked");
      expect(app.createdFiles[0].content).toContain("  - jira/ABC-123");
    });

    it("falls back to the parent folder for dynamic states without a folder mapping", async () => {
      const app = makeSubTaskApp(["2 - Areas/Tasks/custom-folder"]);

      await handleSubTaskCreated(
        app,
        {
          id: "parent-id",
          title: "Parent task",
          path: "2 - Areas/Tasks/custom-folder/parent.md",
          filename: "parent.md",
        },
        "Investigate API",
        "needs-review",
        "2 - Areas/Tasks",
      );

      expect(app.createdFolders).toEqual([]);
      expect(app.createdFiles[0].path).toContain("2 - Areas/Tasks/custom-folder/");
      expect(app.createdFiles[0].content).toContain("state: needs-review");
      expect(app.createdFiles[0].content).toContain("  - task/needs-review");
    });

    it("creates sub-tasks with a placeholder title and pending filename", async () => {
      const app = makeSubTaskApp(["2 - Areas/Tasks/todo"]);

      const result = await handleSubTaskCreated(
        app,
        {
          id: "parent-id",
          title: "Parent task",
          path: "2 - Areas/Tasks/todo/parent.md",
          filename: "parent.md",
        },
        "Investigate API",
        "todo",
        "2 - Areas/Tasks",
      );

      expect(result.title).toBe("Sub-task from: Parent task");
      expect(app.createdFiles[0].path).toMatch(/TASK-\d{8}-\d{4}-pending-[a-f0-9]{8}\.md$/);
      expect(app.createdFiles[0].content).toContain('title: "Sub-task from: Parent task"');
      expect(app.createdFiles[0].content).toContain("goal: []");
      expect(app.createdFiles[0].content).toContain("Requested scope: Investigate API");
      expect(result.task.parent).toEqual({
        id: "parent-id",
        title: "Parent task",
        path: "2 - Areas/Tasks/todo/parent.md",
        link: "[[parent|Parent task]]",
      });
      expect(result.task.source.type).toBe("prompt");
      expect(result.task.isSubTask).toBe(true);
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

    it("does not match sibling paths with a shared prefix", () => {
      const archiveFile = { path: "2 - Areas/Tasks Archive/old-task.md" };
      const app = {
        vault: {
          getMarkdownFiles: () => [archiveFile],
        },
        metadataCache: {
          getFileCache: () => ({ frontmatter: { id: "target-uuid" } }),
        },
      } as any;

      const result = findFileByUuid(app, "target-uuid", "2 - Areas/Tasks");
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

  describe("resolveEnrichmentTimeout", () => {
    it("returns DEFAULT_TIMEOUT_MS when setting is empty string", () => {
      expect(resolveEnrichmentTimeout({ "adapter.enrichmentTimeout": "" })).toBe(300_000);
    });

    it("returns DEFAULT_TIMEOUT_MS when setting is undefined", () => {
      expect(resolveEnrichmentTimeout({})).toBe(300_000);
    });

    it("returns DEFAULT_TIMEOUT_MS when setting is null", () => {
      expect(resolveEnrichmentTimeout({ "adapter.enrichmentTimeout": null })).toBe(300_000);
    });

    it("converts seconds to milliseconds", () => {
      expect(resolveEnrichmentTimeout({ "adapter.enrichmentTimeout": "120" })).toBe(120_000);
    });

    it("handles string numbers correctly", () => {
      expect(resolveEnrichmentTimeout({ "adapter.enrichmentTimeout": "600" })).toBe(600_000);
    });

    it("returns DEFAULT_TIMEOUT_MS for non-numeric strings", () => {
      expect(resolveEnrichmentTimeout({ "adapter.enrichmentTimeout": "abc" })).toBe(300_000);
    });

    it("returns DEFAULT_TIMEOUT_MS for zero", () => {
      expect(resolveEnrichmentTimeout({ "adapter.enrichmentTimeout": "0" })).toBe(300_000);
    });

    it("returns DEFAULT_TIMEOUT_MS for negative values", () => {
      expect(resolveEnrichmentTimeout({ "adapter.enrichmentTimeout": "-10" })).toBe(300_000);
    });

    it("rounds fractional seconds to whole milliseconds", () => {
      expect(resolveEnrichmentTimeout({ "adapter.enrichmentTimeout": "1.5" })).toBe(1500);
    });
  });
});
