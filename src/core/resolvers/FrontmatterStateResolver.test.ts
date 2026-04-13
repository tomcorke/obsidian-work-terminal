import { describe, it, expect, vi } from "vitest";
import { FrontmatterStateResolver } from "./FrontmatterStateResolver";
import type { App, TFile } from "obsidian";

describe("FrontmatterStateResolver", () => {
  describe("resolveState", () => {
    it("resolves state from the default 'state' field", () => {
      const resolver = new FrontmatterStateResolver();
      expect(resolver.resolveState("any/path.md", { state: "active" })).toBe("active");
    });

    it("resolves state from a custom field name", () => {
      const resolver = new FrontmatterStateResolver("status");
      expect(resolver.resolveState("any/path.md", { status: "in-progress" })).toBe("in-progress");
    });

    it("returns null when frontmatter is undefined", () => {
      const resolver = new FrontmatterStateResolver();
      expect(resolver.resolveState("any/path.md", undefined)).toBeNull();
    });

    it("returns null when the field is missing", () => {
      const resolver = new FrontmatterStateResolver();
      expect(resolver.resolveState("any/path.md", { title: "Test" })).toBeNull();
    });

    it("returns null when the field is not a string", () => {
      const resolver = new FrontmatterStateResolver();
      expect(resolver.resolveState("any/path.md", { state: 42 })).toBeNull();
      expect(resolver.resolveState("any/path.md", { state: true })).toBeNull();
      expect(resolver.resolveState("any/path.md", { state: null })).toBeNull();
    });

    it("returns null when the field is an empty string", () => {
      const resolver = new FrontmatterStateResolver();
      expect(resolver.resolveState("any/path.md", { state: "" })).toBeNull();
      expect(resolver.resolveState("any/path.md", { state: "   " })).toBeNull();
    });

    it("validates against valid states when provided", () => {
      const resolver = new FrontmatterStateResolver("state", ["active", "done"]);
      expect(resolver.resolveState("any/path.md", { state: "active" })).toBe("active");
      expect(resolver.resolveState("any/path.md", { state: "invalid" })).toBeNull();
    });

    it("accepts any string when no valid states are specified", () => {
      const resolver = new FrontmatterStateResolver();
      expect(resolver.resolveState("any/path.md", { state: "custom-state" })).toBe("custom-state");
    });

    it("trims whitespace from the value", () => {
      const resolver = new FrontmatterStateResolver();
      expect(resolver.resolveState("any/path.md", { state: "  active  " })).toBe("active");
    });

    it("ignores file path entirely", () => {
      const resolver = new FrontmatterStateResolver();
      // Same frontmatter, different paths - should return the same result
      expect(resolver.resolveState("folder-a/task.md", { state: "done" })).toBe("done");
      expect(resolver.resolveState("folder-b/task.md", { state: "done" })).toBe("done");
    });
  });

  describe("applyState", () => {
    function createMockApp(content: string) {
      const modify = vi.fn().mockResolvedValue(undefined);
      const read = vi.fn().mockResolvedValue(content);
      return {
        app: { vault: { read, modify } } as unknown as App,
        modify,
        read,
      };
    }

    const sampleContent = `---
id: abc-123
state: todo
title: "Test Task"
---
# Test Task
`;

    it("updates the state field in frontmatter", async () => {
      const { app, modify } = createMockApp(sampleContent);
      const resolver = new FrontmatterStateResolver();
      const file = { path: "task.md" } as TFile;

      const result = await resolver.applyState(app, file, "active", "todo", "");

      expect(result).toBe(true);
      const written = modify.mock.calls[0][1] as string;
      expect(written).toMatch(/^state: active$/m);
      expect(written).not.toMatch(/^state: todo$/m);
    });

    it("inserts the field when it is missing from frontmatter", async () => {
      const contentNoState = `---
id: abc-123
title: "Test Task"
---
# Test Task
`;
      const { app, modify } = createMockApp(contentNoState);
      const resolver = new FrontmatterStateResolver();
      const file = { path: "task.md" } as TFile;

      const result = await resolver.applyState(app, file, "active", "todo", "");

      expect(result).toBe(true);
      const written = modify.mock.calls[0][1] as string;
      expect(written).toMatch(/^state: active$/m);
      // Field should be inside frontmatter, before closing ---
      expect(written).toMatch(/state: active\n---/);
    });

    it("returns false when there is no frontmatter block", async () => {
      const contentNoFrontmatter = `# Just a heading\nSome content\n`;
      const { app, modify } = createMockApp(contentNoFrontmatter);
      const resolver = new FrontmatterStateResolver();
      const file = { path: "task.md" } as TFile;

      const result = await resolver.applyState(app, file, "active", "todo", "");

      expect(result).toBe(false);
      expect(modify).not.toHaveBeenCalled();
    });

    it("updates a blank field value (e.g. 'state:')", async () => {
      const contentBlankState = `---
id: abc-123
state:
title: "Test Task"
---
# Test Task
`;
      const { app, modify } = createMockApp(contentBlankState);
      const resolver = new FrontmatterStateResolver();
      const file = { path: "task.md" } as TFile;

      const result = await resolver.applyState(app, file, "active", "todo", "");

      expect(result).toBe(true);
      const written = modify.mock.calls[0][1] as string;
      expect(written).toMatch(/^state: active$/m);
    });

    it("works with custom field names", async () => {
      const customContent = `---
id: abc-123
status: pending
title: "Test Task"
---
`;
      const { app, modify } = createMockApp(customContent);
      const resolver = new FrontmatterStateResolver("status");
      const file = { path: "task.md" } as TFile;

      const result = await resolver.applyState(app, file, "approved", "pending", "");

      expect(result).toBe(true);
      const written = modify.mock.calls[0][1] as string;
      expect(written).toMatch(/^status: approved$/m);
    });
  });

  describe("getValidStates", () => {
    it("returns the configured valid states", () => {
      const resolver = new FrontmatterStateResolver("state", ["a", "b", "c"]);
      expect(resolver.getValidStates()).toEqual(["a", "b", "c"]);
    });

    it("returns empty array when no valid states configured", () => {
      const resolver = new FrontmatterStateResolver();
      expect(resolver.getValidStates()).toEqual([]);
    });

    it("returns a copy, not a reference", () => {
      const resolver = new FrontmatterStateResolver("state", ["a", "b"]);
      const states = resolver.getValidStates();
      states.push("c");
      expect(resolver.getValidStates()).toEqual(["a", "b"]);
    });
  });
});
