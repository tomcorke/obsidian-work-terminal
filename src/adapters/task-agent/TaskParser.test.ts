import { describe, it, expect, vi } from "vitest";
import { TaskParser } from "./TaskParser";
import type { App, TFile, CachedMetadata } from "obsidian";

function mockApp(
  files: Array<{ path: string; name: string; basename: string; extension: string }>,
  caches: Record<string, CachedMetadata | null>
): App {
  return {
    metadataCache: {
      getFileCache: (file: TFile) => caches[file.path] ?? null,
    },
    vault: {
      getAbstractFileByPath: (path: string) => {
        if (path.endsWith("/")) return null;
        // For folder checks, return truthy for known folders
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

function makeFile(path: string): { path: string; name: string; basename: string; extension: string } {
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
      priority: { score: 50, deadline: "", impact: "medium", "has-blocker": false, "blocker-context": "" },
      "agent-actionable": false,
      goal: ["improve-perf"],
      created: "2026-03-27T00:00:00Z",
      updated: "2026-03-27T12:00:00Z",
      ...overrides,
    },
  } as unknown as CachedMetadata;
}

describe("TaskParser", () => {
  const defaultSettings = { "adapter.taskBasePath": "2 - Areas/Tasks" };

  describe("parse", () => {
    it("extracts all fields from valid frontmatter", () => {
      const file = makeFile("2 - Areas/Tasks/active/task.md");
      const app = mockApp([file], {
        [file.path]: makeFrontmatter(),
      });
      const parser = new TaskParser(app, "", defaultSettings);
      const item = parser.parse(file as unknown as TFile);

      expect(item).not.toBeNull();
      expect(item!.id).toBe("test-uuid");
      expect(item!.title).toBe("Test Task");
      expect(item!.state).toBe("active");
      expect(item!.path).toBe(file.path);
      expect((item!.metadata as any).source.type).toBe("prompt");
      expect((item!.metadata as any).priority.score).toBe(50);
      expect((item!.metadata as any).goal).toEqual(["improve-perf"]);
    });

    it("returns null for missing frontmatter", () => {
      const file = makeFile("2 - Areas/Tasks/active/task.md");
      const app = mockApp([file], { [file.path]: null });
      const parser = new TaskParser(app, "", defaultSettings);
      expect(parser.parse(file as unknown as TFile)).toBeNull();
    });

    it("returns null for empty frontmatter", () => {
      const file = makeFile("2 - Areas/Tasks/active/task.md");
      const app = mockApp([file], {
        [file.path]: { frontmatter: undefined } as unknown as CachedMetadata,
      });
      const parser = new TaskParser(app, "", defaultSettings);
      expect(parser.parse(file as unknown as TFile)).toBeNull();
    });

    it("returns null for invalid state", () => {
      const file = makeFile("2 - Areas/Tasks/active/task.md");
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({ state: "invalid" }),
      });
      const parser = new TaskParser(app, "", defaultSettings);
      expect(parser.parse(file as unknown as TFile)).toBeNull();
    });

    it("uses file basename when title is missing", () => {
      const file = makeFile("2 - Areas/Tasks/active/my-task.md");
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({ title: undefined }),
      });
      const parser = new TaskParser(app, "", defaultSettings);
      const item = parser.parse(file as unknown as TFile);
      expect(item!.title).toBe("my-task");
    });

    it("defaults source.type to 'other' when missing", () => {
      const file = makeFile("2 - Areas/Tasks/active/task.md");
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({ source: undefined }),
      });
      const parser = new TaskParser(app, "", defaultSettings);
      const item = parser.parse(file as unknown as TFile);
      expect((item!.metadata as any).source.type).toBe("other");
    });

    it("defaults priority.score to 0 when missing", () => {
      const file = makeFile("2 - Areas/Tasks/active/task.md");
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({ priority: undefined }),
      });
      const parser = new TaskParser(app, "", defaultSettings);
      const item = parser.parse(file as unknown as TFile);
      expect((item!.metadata as any).priority.score).toBe(0);
    });
  });

  describe("goal normalisation", () => {
    it("passes through array goal", () => {
      const file = makeFile("2 - Areas/Tasks/active/task.md");
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({ goal: ["a", "b"] }),
      });
      const parser = new TaskParser(app, "", defaultSettings);
      const item = parser.parse(file as unknown as TFile);
      expect((item!.metadata as any).goal).toEqual(["a", "b"]);
    });

    it("wraps string goal in array", () => {
      const file = makeFile("2 - Areas/Tasks/active/task.md");
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({ goal: "single-goal" }),
      });
      const parser = new TaskParser(app, "", defaultSettings);
      const item = parser.parse(file as unknown as TFile);
      expect((item!.metadata as any).goal).toEqual(["single-goal"]);
    });

    it("returns empty array for missing goal", () => {
      const file = makeFile("2 - Areas/Tasks/active/task.md");
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({ goal: undefined }),
      });
      const parser = new TaskParser(app, "", defaultSettings);
      const item = parser.parse(file as unknown as TFile);
      expect((item!.metadata as any).goal).toEqual([]);
    });

    it("returns empty array for null goal", () => {
      const file = makeFile("2 - Areas/Tasks/active/task.md");
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({ goal: null }),
      });
      const parser = new TaskParser(app, "", defaultSettings);
      const item = parser.parse(file as unknown as TFile);
      expect((item!.metadata as any).goal).toEqual([]);
    });
  });

  describe("groupByColumn", () => {
    it("excludes abandoned tasks", () => {
      const parser = new TaskParser({} as App, "", defaultSettings);
      const items = [
        { id: "1", path: "a", title: "A", state: "active", metadata: { priority: { score: 0 }, updated: "" } },
        { id: "2", path: "b", title: "B", state: "abandoned", metadata: { priority: { score: 0 }, updated: "" } },
      ];
      const groups = parser.groupByColumn(items);
      expect(groups["active"].length).toBe(1);
      expect(groups["priority"].length).toBe(0);
      expect(groups["todo"].length).toBe(0);
      expect(groups["done"].length).toBe(0);
    });

    it("sorts by score descending", () => {
      const parser = new TaskParser({} as App, "", defaultSettings);
      const items = [
        { id: "1", path: "a", title: "Low", state: "active", metadata: { priority: { score: 20 }, updated: "" } },
        { id: "2", path: "b", title: "High", state: "active", metadata: { priority: { score: 80 }, updated: "" } },
      ];
      const groups = parser.groupByColumn(items);
      expect(groups["active"][0].title).toBe("High");
      expect(groups["active"][1].title).toBe("Low");
    });

    it("uses updated timestamp as tiebreaker", () => {
      const parser = new TaskParser({} as App, "", defaultSettings);
      const items = [
        { id: "1", path: "a", title: "Old", state: "todo", metadata: { priority: { score: 50 }, updated: "2026-03-01" } },
        { id: "2", path: "b", title: "New", state: "todo", metadata: { priority: { score: 50 }, updated: "2026-03-27" } },
      ];
      const groups = parser.groupByColumn(items);
      expect(groups["todo"][0].title).toBe("New");
    });
  });

  describe("isItemFile", () => {
    it("matches files under basePath", () => {
      const parser = new TaskParser({} as App, "", defaultSettings);
      expect(parser.isItemFile("2 - Areas/Tasks/active/my-task.md")).toBe(true);
    });

    it("rejects files outside basePath", () => {
      const parser = new TaskParser({} as App, "", defaultSettings);
      expect(parser.isItemFile("3 - Resources/notes.md")).toBe(false);
    });

    it("rejects non-md files", () => {
      const parser = new TaskParser({} as App, "", defaultSettings);
      expect(parser.isItemFile("2 - Areas/Tasks/active/data.json")).toBe(false);
    });
  });
});
