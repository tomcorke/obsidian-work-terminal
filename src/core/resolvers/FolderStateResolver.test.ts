import { describe, it, expect, vi } from "vitest";
import { FolderStateResolver } from "./FolderStateResolver";
import type { App, TFile } from "obsidian";

const STATE_TO_FOLDER: Record<string, string> = {
  priority: "priority",
  todo: "todo",
  active: "active",
  done: "archive",
};

describe("FolderStateResolver", () => {
  describe("resolveState", () => {
    it("resolves state from folder name within basePath", () => {
      const resolver = new FolderStateResolver(STATE_TO_FOLDER, "2 - Areas/Tasks");
      expect(resolver.resolveState("2 - Areas/Tasks/active/task.md", undefined)).toBe("active");
    });

    it("resolves done from archive folder", () => {
      const resolver = new FolderStateResolver(STATE_TO_FOLDER, "2 - Areas/Tasks");
      expect(resolver.resolveState("2 - Areas/Tasks/archive/task.md", undefined)).toBe("done");
    });

    it("resolves all mapped states", () => {
      const resolver = new FolderStateResolver(STATE_TO_FOLDER, "2 - Areas/Tasks");
      expect(resolver.resolveState("2 - Areas/Tasks/priority/task.md", undefined)).toBe("priority");
      expect(resolver.resolveState("2 - Areas/Tasks/todo/task.md", undefined)).toBe("todo");
      expect(resolver.resolveState("2 - Areas/Tasks/active/task.md", undefined)).toBe("active");
      expect(resolver.resolveState("2 - Areas/Tasks/archive/task.md", undefined)).toBe("done");
    });

    it("returns null for unknown folders", () => {
      const resolver = new FolderStateResolver(STATE_TO_FOLDER, "2 - Areas/Tasks");
      expect(resolver.resolveState("2 - Areas/Tasks/unknown/task.md", undefined)).toBeNull();
    });

    it("returns null for files outside basePath", () => {
      const resolver = new FolderStateResolver(STATE_TO_FOLDER, "2 - Areas/Tasks");
      expect(resolver.resolveState("3 - Resources/notes/task.md", undefined)).toBeNull();
    });

    it("ignores frontmatter (folder-only resolution)", () => {
      const resolver = new FolderStateResolver(STATE_TO_FOLDER, "2 - Areas/Tasks");
      const fm = { state: "done" };
      // Should resolve from folder, not frontmatter
      expect(resolver.resolveState("2 - Areas/Tasks/active/task.md", fm)).toBe("active");
    });

    it("handles basePath with trailing slash", () => {
      const resolver = new FolderStateResolver(STATE_TO_FOLDER, "2 - Areas/Tasks/");
      expect(resolver.resolveState("2 - Areas/Tasks/active/task.md", undefined)).toBe("active");
    });

    it("handles empty basePath", () => {
      const resolver = new FolderStateResolver(STATE_TO_FOLDER);
      expect(resolver.resolveState("active/task.md", undefined)).toBe("active");
    });

    it("works after setBasePath", () => {
      const resolver = new FolderStateResolver(STATE_TO_FOLDER, "old/path");
      expect(resolver.resolveState("new/path/todo/task.md", undefined)).toBeNull();
      resolver.setBasePath("new/path");
      expect(resolver.resolveState("new/path/todo/task.md", undefined)).toBe("todo");
    });
  });

  describe("applyState", () => {
    function createMockApp() {
      return {
        vault: {
          rename: vi.fn().mockResolvedValue(undefined),
          createFolder: vi.fn().mockResolvedValue(undefined),
          getAbstractFileByPath: vi.fn().mockReturnValue(null),
        },
      } as unknown as App;
    }

    it("moves file to the target folder", async () => {
      const app = createMockApp();
      const resolver = new FolderStateResolver(STATE_TO_FOLDER, "Tasks");
      const file = { path: "Tasks/todo/task.md", name: "task.md" } as TFile;

      const result = await resolver.applyState(app, file, "active", "todo", "Tasks");

      expect(result).toBe(true);
      expect(app.vault.rename).toHaveBeenCalledWith(file, "Tasks/active/task.md");
    });

    it("creates target folder if missing", async () => {
      const app = createMockApp();
      const resolver = new FolderStateResolver(STATE_TO_FOLDER, "Tasks");
      const file = { path: "Tasks/todo/task.md", name: "task.md" } as TFile;

      await resolver.applyState(app, file, "active", "todo", "Tasks");

      expect(app.vault.createFolder).toHaveBeenCalledWith("Tasks/active");
    });

    it("skips rename when path is unchanged", async () => {
      const app = createMockApp();
      const resolver = new FolderStateResolver(STATE_TO_FOLDER, "Tasks");
      const file = { path: "Tasks/active/task.md", name: "task.md" } as TFile;

      const result = await resolver.applyState(app, file, "active", "active", "Tasks");

      expect(result).toBe(true);
      expect(app.vault.rename).not.toHaveBeenCalled();
    });

    it("maps done state to archive folder", async () => {
      const app = createMockApp();
      const resolver = new FolderStateResolver(STATE_TO_FOLDER, "Tasks");
      const file = { path: "Tasks/todo/task.md", name: "task.md" } as TFile;

      await resolver.applyState(app, file, "done", "todo", "Tasks");

      expect(app.vault.rename).toHaveBeenCalledWith(file, "Tasks/archive/task.md");
    });

    it("returns false for unknown state", async () => {
      const app = createMockApp();
      const resolver = new FolderStateResolver(STATE_TO_FOLDER, "Tasks");
      const file = { path: "Tasks/todo/task.md", name: "task.md" } as TFile;

      const result = await resolver.applyState(app, file, "nonexistent", "todo", "Tasks");

      expect(result).toBe(false);
    });

    it("does not create folder when it already exists", async () => {
      const app = createMockApp();
      (app.vault.getAbstractFileByPath as ReturnType<typeof vi.fn>).mockReturnValue({
        path: "Tasks/active",
      });
      const resolver = new FolderStateResolver(STATE_TO_FOLDER, "Tasks");
      const file = { path: "Tasks/todo/task.md", name: "task.md" } as TFile;

      await resolver.applyState(app, file, "active", "todo", "Tasks");

      expect(app.vault.createFolder).not.toHaveBeenCalled();
    });
  });

  describe("getFolderForState", () => {
    it("returns folder name for valid state", () => {
      const resolver = new FolderStateResolver(STATE_TO_FOLDER);
      expect(resolver.getFolderForState("done")).toBe("archive");
      expect(resolver.getFolderForState("active")).toBe("active");
    });

    it("returns null for unknown state", () => {
      const resolver = new FolderStateResolver(STATE_TO_FOLDER);
      expect(resolver.getFolderForState("nonexistent")).toBeNull();
    });
  });

  describe("getValidStates", () => {
    it("returns all state keys", () => {
      const resolver = new FolderStateResolver(STATE_TO_FOLDER);
      expect(resolver.getValidStates()).toEqual(
        expect.arrayContaining(["priority", "todo", "active", "done"]),
      );
    });
  });
});
