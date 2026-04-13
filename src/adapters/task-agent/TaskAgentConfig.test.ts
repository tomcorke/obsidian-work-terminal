import { describe, it, expect } from "vitest";
import {
  parseColumnOrderJson,
  resolveColumns,
  resolveCreationColumns,
  DEFAULT_COLUMNS,
  DEFAULT_CREATION_COLUMNS,
  TASK_AGENT_CONFIG,
} from "./TaskAgentConfig";

describe("TaskAgentConfig column helpers", () => {
  describe("parseColumnOrderJson", () => {
    it("returns empty array for undefined input", () => {
      expect(parseColumnOrderJson(undefined)).toEqual([]);
    });

    it("returns empty array for empty string", () => {
      expect(parseColumnOrderJson("")).toEqual([]);
    });

    it("returns empty array for invalid JSON", () => {
      expect(parseColumnOrderJson("not json")).toEqual([]);
    });

    it("returns empty array for non-array JSON", () => {
      expect(parseColumnOrderJson('{"a": 1}')).toEqual([]);
    });

    it("returns empty array for array with non-string elements", () => {
      expect(parseColumnOrderJson("[1, 2, 3]")).toEqual([]);
    });

    it("parses valid JSON array of strings", () => {
      expect(parseColumnOrderJson('["todo", "active", "done"]')).toEqual([
        "todo",
        "active",
        "done",
      ]);
    });

    it("returns empty array for mixed-type array", () => {
      expect(parseColumnOrderJson('["todo", 1, "active"]')).toEqual([]);
    });
  });

  describe("resolveColumns", () => {
    it("returns default columns for empty/undefined input", () => {
      expect(resolveColumns(undefined)).toEqual(DEFAULT_COLUMNS);
      expect(resolveColumns("")).toEqual(DEFAULT_COLUMNS);
    });

    it("reorders columns according to provided order", () => {
      const result = resolveColumns('["done", "todo", "active", "priority"]');
      expect(result.map((c) => c.id)).toEqual(["done", "todo", "active", "priority"]);
    });

    it("preserves column metadata (label, folderName) during reorder", () => {
      const result = resolveColumns('["done", "priority"]');
      const doneCol = result.find((c) => c.id === "done");
      expect(doneCol?.label).toBe("Done");
      expect(doneCol?.folderName).toBe("archive");
    });

    it("appends missing columns at the end", () => {
      const result = resolveColumns('["todo", "active"]');
      expect(result.map((c) => c.id)).toEqual(["todo", "active", "priority", "done"]);
    });

    it("ignores unknown column IDs", () => {
      const result = resolveColumns('["todo", "unknown", "active"]');
      expect(result.map((c) => c.id)).toEqual(["todo", "active", "priority", "done"]);
    });

    it("deduplicates repeated IDs", () => {
      const result = resolveColumns('["todo", "todo", "active"]');
      expect(result.map((c) => c.id)).toEqual(["todo", "active", "priority", "done"]);
    });

    it("returns default columns for invalid JSON", () => {
      expect(resolveColumns("not json")).toEqual(DEFAULT_COLUMNS);
    });
  });

  describe("resolveCreationColumns", () => {
    it("returns default creation columns for empty/undefined input", () => {
      expect(resolveCreationColumns(undefined)).toEqual(DEFAULT_CREATION_COLUMNS);
      expect(resolveCreationColumns("")).toEqual(DEFAULT_CREATION_COLUMNS);
    });

    it("creates creation columns from provided IDs", () => {
      const result = resolveCreationColumns('["active", "priority"]');
      expect(result).toEqual([
        { id: "active", label: "Active", default: true },
        { id: "priority", label: "Priority" },
      ]);
    });

    it("marks the first column as default", () => {
      const result = resolveCreationColumns('["todo", "active"]');
      expect(result[0].default).toBe(true);
      expect(result[1].default).toBeUndefined();
    });

    it("ignores unknown column IDs", () => {
      const result = resolveCreationColumns('["unknown", "todo"]');
      expect(result).toEqual([{ id: "todo", label: "To Do", default: true }]);
    });

    it("falls back to default when all IDs are invalid", () => {
      expect(resolveCreationColumns('["x", "y"]')).toEqual(DEFAULT_CREATION_COLUMNS);
    });

    it("falls back to default for invalid JSON", () => {
      expect(resolveCreationColumns("bad")).toEqual(DEFAULT_CREATION_COLUMNS);
    });

    it("uses a single column as both the only option and default", () => {
      const result = resolveCreationColumns('["done"]');
      expect(result).toEqual([{ id: "done", label: "Done", default: true }]);
    });

    it("deduplicates repeated IDs", () => {
      const result = resolveCreationColumns('["todo", "todo", "active"]');
      expect(result).toEqual([
        { id: "todo", label: "To Do", default: true },
        { id: "active", label: "Active" },
      ]);
    });
  });

  describe("TASK_AGENT_CONFIG defaults", () => {
    it("has columnOrder and creationColumnIds in defaultSettings", () => {
      expect(TASK_AGENT_CONFIG.defaultSettings).toHaveProperty("columnOrder", "");
      expect(TASK_AGENT_CONFIG.defaultSettings).toHaveProperty("creationColumnIds", "");
    });

    it("does not expose columnOrder or creationColumnIds in settingsSchema", () => {
      const schemaKeys = TASK_AGENT_CONFIG.settingsSchema.map((f) => f.key);
      expect(schemaKeys).not.toContain("columnOrder");
      expect(schemaKeys).not.toContain("creationColumnIds");
    });

    it("default columns match KANBAN_COLUMNS order", () => {
      expect(DEFAULT_COLUMNS.map((c) => c.id)).toEqual(["priority", "active", "todo", "done"]);
    });
  });
});
