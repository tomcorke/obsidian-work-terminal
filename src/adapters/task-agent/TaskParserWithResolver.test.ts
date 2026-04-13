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

  describe("resolver returns dynamic/custom state", () => {
    it("accepts custom state from resolver (open state set)", () => {
      // A resolver that returns a custom state not in the predefined list
      const customResolver = {
        resolveState: () => "custom-unknown-state",
        applyState: async () => false,
      };
      const file = makeFile("2 - Areas/Tasks/active/task.md");
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({ state: "custom-unknown-state" }),
      });
      const parser = new TaskParser(app, "", defaultSettings, customResolver as any);
      const item = parser.parse(file as unknown as TFile);

      // Custom states are now accepted - they create dynamic columns
      expect(item).not.toBeNull();
      expect(item!.state).toBe("custom-unknown-state");
    });

    it("groups custom state items into dynamic columns", () => {
      const customResolver = {
        resolveState: (_path: string, fm: Record<string, unknown> | undefined) => {
          return (fm as any)?.state ?? null;
        },
        applyState: async () => true,
      };
      const file1 = makeFile("2 - Areas/Tasks/active/task1.md");
      const file2 = makeFile("2 - Areas/Tasks/active/task2.md");
      const app = mockApp([file1, file2], {
        [file1.path]: makeFrontmatter({ state: "amazing" }),
        [file2.path]: makeFrontmatter({ state: "active" }),
      });
      const parser = new TaskParser(app, "", defaultSettings, customResolver as any);
      const item1 = parser.parse(file1 as unknown as TFile);
      const item2 = parser.parse(file2 as unknown as TFile);

      expect(item1!.state).toBe("amazing");
      expect(item2!.state).toBe("active");

      const groups = parser.groupByColumn([item1!, item2!]);
      expect(groups["amazing"]).toHaveLength(1);
      expect(groups["active"]).toHaveLength(1);
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
