import { describe, it, expect, vi } from "vitest";
import { CompositeStateResolver } from "./CompositeStateResolver";
import type { StateResolver } from "../interfaces";
import type { App, TFile } from "obsidian";

function createMockResolver(overrides: Partial<StateResolver> = {}): StateResolver {
  return {
    resolveState: vi.fn().mockReturnValue(null),
    applyState: vi.fn().mockResolvedValue(true),
    getFolderForState: vi.fn().mockReturnValue(null),
    getValidStates: vi.fn().mockReturnValue([]),
    ...overrides,
  };
}

describe("CompositeStateResolver", () => {
  describe("resolveState", () => {
    it("returns the first non-null result", () => {
      const r1 = createMockResolver({ resolveState: vi.fn().mockReturnValue(null) });
      const r2 = createMockResolver({ resolveState: vi.fn().mockReturnValue("active") });
      const r3 = createMockResolver({ resolveState: vi.fn().mockReturnValue("done") });

      const composite = new CompositeStateResolver([r1, r2, r3]);
      expect(composite.resolveState("path.md", {})).toBe("active");
      // r3 should not be called since r2 returned a value
      expect(r3.resolveState).not.toHaveBeenCalled();
    });

    it("returns null when all resolvers return null", () => {
      const r1 = createMockResolver();
      const r2 = createMockResolver();

      const composite = new CompositeStateResolver([r1, r2]);
      expect(composite.resolveState("path.md", {})).toBeNull();
    });

    it("passes filePath and frontmatter to each resolver", () => {
      const r1 = createMockResolver();
      const fm = { state: "test" };

      const composite = new CompositeStateResolver([r1]);
      composite.resolveState("my/path.md", fm);

      expect(r1.resolveState).toHaveBeenCalledWith("my/path.md", fm);
    });

    it("handles empty resolver list", () => {
      const composite = new CompositeStateResolver([]);
      expect(composite.resolveState("path.md", {})).toBeNull();
    });
  });

  describe("applyState", () => {
    const mockApp = {} as App;
    const mockFile = {} as TFile;

    it("runs all resolvers and returns true if any succeed", async () => {
      const r1 = createMockResolver({ applyState: vi.fn().mockResolvedValue(true) });
      const r2 = createMockResolver({ applyState: vi.fn().mockResolvedValue(false) });

      const composite = new CompositeStateResolver([r1, r2]);
      const result = await composite.applyState(mockApp, mockFile, "active", "todo", "/base");

      expect(result).toBe(true);
      expect(r1.applyState).toHaveBeenCalled();
      expect(r2.applyState).toHaveBeenCalled();
    });

    it("returns false when all resolvers fail", async () => {
      const r1 = createMockResolver({ applyState: vi.fn().mockResolvedValue(false) });
      const r2 = createMockResolver({ applyState: vi.fn().mockResolvedValue(false) });

      const composite = new CompositeStateResolver([r1, r2]);
      const result = await composite.applyState(mockApp, mockFile, "active", "todo", "/base");

      expect(result).toBe(false);
    });

    it("continues running resolvers even if one throws", async () => {
      const r1 = createMockResolver({
        applyState: vi.fn().mockRejectedValue(new Error("fail")),
      });
      const r2 = createMockResolver({ applyState: vi.fn().mockResolvedValue(true) });

      const composite = new CompositeStateResolver([r1, r2]);
      const result = await composite.applyState(mockApp, mockFile, "active", "todo", "/base");

      expect(result).toBe(true);
      expect(r2.applyState).toHaveBeenCalled();
    });

    it("passes correct arguments to each resolver", async () => {
      const r1 = createMockResolver();

      const composite = new CompositeStateResolver([r1]);
      await composite.applyState(mockApp, mockFile, "done", "active", "/base/path");

      expect(r1.applyState).toHaveBeenCalledWith(mockApp, mockFile, "done", "active", "/base/path");
    });
  });

  describe("getFolderForState", () => {
    it("returns the first non-null folder", () => {
      const r1 = createMockResolver({ getFolderForState: vi.fn().mockReturnValue(null) });
      const r2 = createMockResolver({ getFolderForState: vi.fn().mockReturnValue("archive") });

      const composite = new CompositeStateResolver([r1, r2]);
      expect(composite.getFolderForState("done")).toBe("archive");
    });

    it("returns null when no resolver has a folder mapping", () => {
      const r1 = createMockResolver();
      const composite = new CompositeStateResolver([r1]);
      expect(composite.getFolderForState("done")).toBeNull();
    });

    it("handles resolvers without getFolderForState", () => {
      const r1: StateResolver = {
        resolveState: vi.fn().mockReturnValue(null),
        applyState: vi.fn().mockResolvedValue(true),
        // No getFolderForState
      };

      const composite = new CompositeStateResolver([r1]);
      expect(composite.getFolderForState("done")).toBeNull();
    });
  });

  describe("getValidStates", () => {
    it("merges valid states from all resolvers", () => {
      const r1 = createMockResolver({ getValidStates: vi.fn().mockReturnValue(["a", "b"]) });
      const r2 = createMockResolver({ getValidStates: vi.fn().mockReturnValue(["b", "c"]) });

      const composite = new CompositeStateResolver([r1, r2]);
      const states = composite.getValidStates();
      expect(states).toEqual(expect.arrayContaining(["a", "b", "c"]));
      expect(states).toHaveLength(3); // no duplicates
    });

    it("handles resolvers without getValidStates", () => {
      const r1: StateResolver = {
        resolveState: vi.fn().mockReturnValue(null),
        applyState: vi.fn().mockResolvedValue(true),
      };

      const composite = new CompositeStateResolver([r1]);
      expect(composite.getValidStates()).toEqual([]);
    });
  });
});
