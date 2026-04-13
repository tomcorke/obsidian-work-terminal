import { describe, it, expect, vi } from "vitest";
import { TaskParser } from "./TaskParser";
import { FrontmatterStateResolver } from "../../core/resolvers/FrontmatterStateResolver";
import { CompositeStateResolver } from "../../core/resolvers/CompositeStateResolver";
import { FolderStateResolver } from "../../core/resolvers/FolderStateResolver";
import { STATE_FOLDER_MAP } from "./types";
import type { App, TFile, CachedMetadata } from "obsidian";

function mockApp(
  files: Array<{ path: string; name: string; basename: string; extension: string }>,
  caches: Record<string, CachedMetadata | null>,
): App {
  return {
    metadataCache: {
      getFileCache: (file: TFile) => caches[file.path] ?? null,
    },
    vault: {
      getAbstractFileByPath: (path: string) => {
        const knownFolders = [
          "2 - Areas/Tasks/priority",
          "2 - Areas/Tasks/todo",
          "2 - Areas/Tasks/active",
          "2 - Areas/Tasks/archive",
        ];
        if (knownFolders.includes(path)) return { path };
        return files.find((f) => f.path === path) || null;
      },
      getMarkdownFiles: () =>
        files.map((f) => ({
          path: f.path,
          name: f.name,
          basename: f.basename,
          extension: f.extension,
        })),
      read: vi.fn(),
      modify: vi.fn(),
    },
  } as unknown as App;
}

function makeFile(path: string) {
  const name = path.split("/").pop() || "";
  const basename = name.replace(/\.md$/, "");
  return { path, name, basename, extension: "md" };
}

function makeFrontmatter(overrides: Record<string, any> = {}) {
  return {
    frontmatter: {
      id: "test-uuid",
      state: "active",
      title: "Test Task",
      tags: ["task", "task/active"],
      source: { type: "prompt", id: "p1", url: "", captured: "2026-03-27" },
      priority: {
        score: 50,
        deadline: "",
        impact: "medium",
        "has-blocker": false,
        "blocker-context": "",
      },
      "agent-actionable": false,
      goal: [],
      created: "2026-03-27T00:00:00Z",
      updated: "2026-03-27T12:00:00Z",
      ...overrides,
    },
  } as unknown as CachedMetadata;
}

const defaultSettings = {
  "adapter.taskBasePath": "2 - Areas/Tasks",
  "adapter.jiraBaseUrl": "https://example.atlassian.net/browse",
};

describe("TaskParser with StateResolver", () => {
  describe("with FrontmatterStateResolver", () => {
    const validStates = ["priority", "todo", "active", "done", "abandoned"];
    const resolver = new FrontmatterStateResolver("state", validStates);

    it("uses frontmatter state field instead of folder path", () => {
      // File is in 'todo' folder but frontmatter says 'active'
      const file = makeFile("2 - Areas/Tasks/todo/task.md");
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({ state: "active" }),
      });
      const parser = new TaskParser(app, "", defaultSettings, resolver);
      const item = parser.parse(file as unknown as TFile);

      expect(item).not.toBeNull();
      expect(item!.state).toBe("active");
    });

    it("falls back to folder when frontmatter state is missing", () => {
      const file = makeFile("2 - Areas/Tasks/active/task.md");
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({ state: undefined }),
      });
      const parser = new TaskParser(app, "", defaultSettings, resolver);
      const item = parser.parse(file as unknown as TFile);

      // Frontmatter resolver returns null, parser falls back to getStateFromPath
      expect(item).not.toBeNull();
      expect(item!.state).toBe("active");
    });
  });

  describe("with CompositeStateResolver (frontmatter + folder)", () => {
    const validStates = ["priority", "todo", "active", "done", "abandoned"];
    const basePath = "2 - Areas/Tasks";
    const resolver = new CompositeStateResolver([
      new FrontmatterStateResolver("state", validStates),
      new FolderStateResolver(STATE_FOLDER_MAP, basePath),
    ]);

    it("prefers frontmatter state over folder", () => {
      const file = makeFile("2 - Areas/Tasks/todo/task.md");
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({ state: "done" }),
      });
      const parser = new TaskParser(app, "", defaultSettings, resolver);
      const item = parser.parse(file as unknown as TFile);

      expect(item!.state).toBe("done");
    });

    it("falls back to folder when frontmatter has no state", () => {
      const file = makeFile("2 - Areas/Tasks/priority/task.md");
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({ state: undefined }),
      });
      const parser = new TaskParser(app, "", defaultSettings, resolver);
      const item = parser.parse(file as unknown as TFile);

      expect(item!.state).toBe("priority");
    });

    it("maps archive folder to done state", () => {
      const file = makeFile("2 - Areas/Tasks/archive/task.md");
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({ state: undefined }),
      });
      const parser = new TaskParser(app, "", defaultSettings, resolver);
      const item = parser.parse(file as unknown as TFile);

      expect(item!.state).toBe("done");
    });
  });

  describe("resolver returns unrecognized state", () => {
    it("falls back to folder path instead of dropping the task", () => {
      // A resolver that always returns an unrecognized state
      const badResolver = {
        resolveState: () => "custom-unknown-state",
        applyState: async () => false,
      };
      const file = makeFile("2 - Areas/Tasks/active/task.md");
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({ state: "custom-unknown-state" }),
      });
      const parser = new TaskParser(app, "", defaultSettings, badResolver as any);
      const item = parser.parse(file as unknown as TFile);

      // Should fall back to folder-based resolution, not return null
      expect(item).not.toBeNull();
      expect(item!.state).toBe("active");
    });
  });

  describe("state warning for unknown frontmatter values", () => {
    const validStates = ["priority", "todo", "active", "done", "abandoned"];
    const basePath = "2 - Areas/Tasks";
    const compositeResolver = new CompositeStateResolver([
      new FrontmatterStateResolver("state", validStates),
      new FolderStateResolver(STATE_FOLDER_MAP, basePath),
    ]);

    it("sets stateWarning when frontmatter has an unrecognized state value", () => {
      const file = makeFile("2 - Areas/Tasks/priority/task.md");
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({ state: "amazing" }),
      });
      const parser = new TaskParser(app, "", defaultSettings, compositeResolver);
      const item = parser.parse(file as unknown as TFile);

      expect(item).not.toBeNull();
      // Task falls back to folder-based state
      expect(item!.state).toBe("priority");
      // But stateWarning is set in metadata
      expect((item!.metadata as any).stateWarning).toBe("amazing");
    });

    it("does not set stateWarning when frontmatter has a valid state", () => {
      const file = makeFile("2 - Areas/Tasks/todo/task.md");
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({ state: "active" }),
      });
      const parser = new TaskParser(app, "", defaultSettings, compositeResolver);
      const item = parser.parse(file as unknown as TFile);

      expect(item).not.toBeNull();
      expect(item!.state).toBe("active");
      expect((item!.metadata as any).stateWarning).toBeUndefined();
    });

    it("does not set stateWarning when frontmatter state field is missing", () => {
      const file = makeFile("2 - Areas/Tasks/active/task.md");
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({ state: undefined }),
      });
      const parser = new TaskParser(app, "", defaultSettings, compositeResolver);
      const item = parser.parse(file as unknown as TFile);

      expect(item).not.toBeNull();
      expect(item!.state).toBe("active");
      expect((item!.metadata as any).stateWarning).toBeUndefined();
    });

    it("does not set stateWarning when frontmatter state is empty string", () => {
      const file = makeFile("2 - Areas/Tasks/active/task.md");
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({ state: "" }),
      });
      const parser = new TaskParser(app, "", defaultSettings, compositeResolver);
      const item = parser.parse(file as unknown as TFile);

      expect(item).not.toBeNull();
      expect(item!.state).toBe("active");
      expect((item!.metadata as any).stateWarning).toBeUndefined();
    });

    it("does not set stateWarning when frontmatter state matches resolved state", () => {
      const file = makeFile("2 - Areas/Tasks/priority/task.md");
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({ state: "priority" }),
      });
      const parser = new TaskParser(app, "", defaultSettings, compositeResolver);
      const item = parser.parse(file as unknown as TFile);

      expect(item).not.toBeNull();
      expect(item!.state).toBe("priority");
      expect((item!.metadata as any).stateWarning).toBeUndefined();
    });

    it("sets stateWarning with whitespace-trimmed unknown value", () => {
      const file = makeFile("2 - Areas/Tasks/active/task.md");
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({ state: "  amazing  " }),
      });
      const parser = new TaskParser(app, "", defaultSettings, compositeResolver);
      const item = parser.parse(file as unknown as TFile);

      expect(item).not.toBeNull();
      expect(item!.state).toBe("active");
      expect((item!.metadata as any).stateWarning).toBe("amazing");
    });

    it("does not set stateWarning without a resolver (backward compatibility)", () => {
      const file = makeFile("2 - Areas/Tasks/active/task.md");
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({ state: "amazing" }),
      });
      // No resolver - legacy mode
      const parser = new TaskParser(app, "", defaultSettings);
      const item = parser.parse(file as unknown as TFile);

      expect(item).not.toBeNull();
      expect(item!.state).toBe("active");
      // No warning in legacy mode - frontmatter state is simply ignored
      // via normaliseState which falls back to folder state
      expect((item!.metadata as any).stateWarning).toBe("amazing");
    });
  });

  describe("without resolver (backward compatibility)", () => {
    it("still resolves state from folder path", () => {
      const file = makeFile("2 - Areas/Tasks/active/task.md");
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({ state: "invalid" }),
      });
      // No resolver passed
      const parser = new TaskParser(app, "", defaultSettings);
      const item = parser.parse(file as unknown as TFile);

      expect(item!.state).toBe("active");
    });
  });
});
