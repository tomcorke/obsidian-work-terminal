import { describe, it, expect } from "vitest";
import { createStateResolver } from "./stateResolverFactory";
import { FolderStateResolver } from "../../core/resolvers/FolderStateResolver";
import { FrontmatterStateResolver } from "../../core/resolvers/FrontmatterStateResolver";
import { CompositeStateResolver } from "../../core/resolvers/CompositeStateResolver";

describe("stateResolverFactory", () => {
  describe("createStateResolver", () => {
    it("creates a FolderStateResolver for 'folder' strategy", () => {
      const resolver = createStateResolver("folder", "2 - Areas/Tasks");
      expect(resolver).toBeInstanceOf(FolderStateResolver);
    });

    it("creates a FrontmatterStateResolver for 'frontmatter' strategy", () => {
      const resolver = createStateResolver("frontmatter", "2 - Areas/Tasks");
      expect(resolver).toBeInstanceOf(FrontmatterStateResolver);
    });

    it("creates a CompositeStateResolver for 'composite' strategy", () => {
      const resolver = createStateResolver("composite", "2 - Areas/Tasks");
      expect(resolver).toBeInstanceOf(CompositeStateResolver);
    });

    it("defaults to FolderStateResolver for unknown strategy", () => {
      const resolver = createStateResolver("unknown" as any, "2 - Areas/Tasks");
      expect(resolver).toBeInstanceOf(FolderStateResolver);
    });

    it("folder resolver uses STATE_FOLDER_MAP mappings", () => {
      const resolver = createStateResolver("folder", "Tasks");
      // Verify the folder-to-state mapping works
      expect(resolver.resolveState("Tasks/archive/task.md", undefined)).toBe("done");
      expect(resolver.resolveState("Tasks/active/task.md", undefined)).toBe("active");
      expect(resolver.resolveState("Tasks/priority/task.md", undefined)).toBe("priority");
      expect(resolver.resolveState("Tasks/todo/task.md", undefined)).toBe("todo");
    });

    it("frontmatter resolver accepts any string state (open state set)", () => {
      const resolver = createStateResolver("frontmatter", "Tasks");
      expect(resolver.resolveState("any.md", { state: "active" })).toBe("active");
      expect(resolver.resolveState("any.md", { state: "done" })).toBe("done");
      expect(resolver.resolveState("any.md", { state: "abandoned" })).toBe("abandoned");
      // Dynamic/custom states are accepted - no validation against a fixed list
      expect(resolver.resolveState("any.md", { state: "amazing" })).toBe("amazing");
      expect(resolver.resolveState("any.md", { state: "custom-state" })).toBe("custom-state");
    });

    it("composite resolver checks frontmatter first, then folder", () => {
      const resolver = createStateResolver("composite", "Tasks");
      // Frontmatter wins when present
      expect(resolver.resolveState("Tasks/active/task.md", { state: "done" })).toBe("done");
      // Folder fallback when frontmatter is absent
      expect(resolver.resolveState("Tasks/active/task.md", undefined)).toBe("active");
      // Folder fallback when frontmatter state field is missing
      expect(resolver.resolveState("Tasks/active/task.md", { title: "test" })).toBe("active");
    });

    it("composite resolver folder mapping is available via getFolderForState", () => {
      const resolver = createStateResolver("composite", "Tasks");
      expect(resolver.getFolderForState!("done")).toBe("archive");
      expect(resolver.getFolderForState!("active")).toBe("active");
    });

    it("composite resolver accepts dynamic frontmatter states", () => {
      const resolver = createStateResolver("composite", "Tasks");
      // Custom state in frontmatter is returned as-is (open state set)
      expect(resolver.resolveState("Tasks/active/task.md", { state: "amazing" })).toBe("amazing");
      expect(resolver.resolveState("Tasks/todo/task.md", { state: "review" })).toBe("review");
    });

    it("composite resolver returns null folder for dynamic states", () => {
      const resolver = createStateResolver("composite", "Tasks");
      expect(resolver.getFolderForState!("amazing")).toBeNull();
      expect(resolver.getFolderForState!("review")).toBeNull();
    });

    it("frontmatter resolver accepts dynamic states", () => {
      const resolver = createStateResolver("frontmatter", "Tasks");
      expect(resolver.resolveState("any.md", { state: "waiting-on-review" })).toBe(
        "waiting-on-review",
      );
      expect(resolver.resolveState("any.md", { state: "testing" })).toBe("testing");
    });

    it("folder resolver does not accept dynamic states", () => {
      const resolver = createStateResolver("folder", "Tasks");
      // Folder resolver only knows about states that map to folders
      expect(resolver.resolveState("Tasks/amazing/task.md", undefined)).toBeNull();
    });
  });
});
