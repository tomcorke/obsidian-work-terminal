import { describe, expect, it, vi } from "vitest";
import { parseCustomCardFlags, serializeCustomCardFlags } from "./customCardFlags";
import type { CardFlagRule } from "../../core/interfaces";

describe("parseCustomCardFlags", () => {
  it("parses valid JSON array of rules", () => {
    const json = JSON.stringify([
      {
        field: "priority.score",
        operator: "gt",
        operand: "80",
        label: "HIGH",
        style: "badge",
        color: "red",
      },
    ]);
    const rules = parseCustomCardFlags(json);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toEqual({
      field: "priority.score",
      operator: "gt",
      operand: "80",
      label: "HIGH",
      style: "badge",
      color: "red",
    });
  });

  it("returns empty array for empty JSON array", () => {
    expect(parseCustomCardFlags("[]")).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(parseCustomCardFlags("")).toEqual([]);
  });

  it("returns empty array for invalid JSON", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseCustomCardFlags("{invalid}")).toEqual([]);
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it("returns empty array for non-array JSON", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseCustomCardFlags('"string"')).toEqual([]);
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it("skips rules with missing field", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const json = JSON.stringify([{ label: "TEST" }]);
    expect(parseCustomCardFlags(json)).toEqual([]);
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it("skips rules with missing label", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const json = JSON.stringify([{ field: "test" }]);
    expect(parseCustomCardFlags(json)).toEqual([]);
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it("skips null/non-object entries", () => {
    const json = JSON.stringify([null, 42, "string", { field: "x", label: "X" }]);
    const rules = parseCustomCardFlags(json);
    expect(rules).toHaveLength(1);
    expect(rules[0].field).toBe("x");
  });

  it("ignores invalid operator values", () => {
    const json = JSON.stringify([{ field: "x", label: "X", operator: "invalid", operand: "5" }]);
    const rules = parseCustomCardFlags(json);
    expect(rules).toHaveLength(1);
    expect(rules[0].operator).toBeUndefined();
  });

  it("ignores invalid style values", () => {
    const json = JSON.stringify([{ field: "x", label: "X", style: "invalid" }]);
    const rules = parseCustomCardFlags(json);
    expect(rules).toHaveLength(1);
    expect(rules[0].style).toBeUndefined();
  });

  it("trims whitespace from field, label, color, and tooltip", () => {
    const json = JSON.stringify([
      { field: "  x  ", label: " Y ", color: "  red  ", tooltip: " tip " },
    ]);
    const rules = parseCustomCardFlags(json);
    expect(rules[0].field).toBe("x");
    expect(rules[0].label).toBe("Y");
    expect(rules[0].color).toBe("red");
    expect(rules[0].tooltip).toBe("tip");
  });

  it("parses all valid styles", () => {
    for (const style of ["badge", "accent-border", "background-tint"]) {
      const json = JSON.stringify([{ field: "x", label: "X", style }]);
      const rules = parseCustomCardFlags(json);
      expect(rules[0].style).toBe(style);
    }
  });

  it("parses all valid operators", () => {
    for (const operator of ["eq", "neq", "gt", "lt", "gte", "lte", "contains", "regex"]) {
      const json = JSON.stringify([{ field: "x", label: "X", operator, operand: "v" }]);
      const rules = parseCustomCardFlags(json);
      expect(rules[0].operator).toBe(operator);
      expect(rules[0].operand).toBe("v");
    }
  });

  it("coerces non-string operand to string", () => {
    const json = JSON.stringify([{ field: "x", label: "X", operator: "gt", operand: 42 }]);
    const rules = parseCustomCardFlags(json);
    expect(rules[0].operand).toBe("42");
  });

  it("preserves legacy value field when no operator", () => {
    const json = JSON.stringify([{ field: "x", label: "X", value: true }]);
    const rules = parseCustomCardFlags(json);
    expect(rules[0].value).toBe(true);
    expect(rules[0].operator).toBeUndefined();
  });

  it("ignores legacy value/contains when operator is set", () => {
    const json = JSON.stringify([
      { field: "x", label: "X", operator: "eq", operand: "y", value: true, contains: "z" },
    ]);
    const rules = parseCustomCardFlags(json);
    expect(rules[0].operator).toBe("eq");
    expect(rules[0].value).toBeUndefined();
    expect(rules[0].contains).toBeUndefined();
  });
});

describe("serializeCustomCardFlags", () => {
  it("serializes rules to JSON", () => {
    const rules: CardFlagRule[] = [
      {
        field: "priority.score",
        operator: "gt",
        operand: "80",
        label: "HIGH",
        style: "badge",
        color: "red",
      },
    ];
    const json = serializeCustomCardFlags(rules);
    const parsed = JSON.parse(json);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({
      field: "priority.score",
      operator: "gt",
      operand: "80",
      label: "HIGH",
      style: "badge",
      color: "red",
    });
  });

  it("omits undefined optional fields", () => {
    const rules: CardFlagRule[] = [{ field: "x", label: "X" }];
    const json = serializeCustomCardFlags(rules);
    const parsed = JSON.parse(json);
    expect(Object.keys(parsed[0])).toEqual(["field", "label"]);
  });

  it("round-trips through parse", () => {
    const original: CardFlagRule[] = [
      {
        field: "tags",
        operator: "contains",
        operand: "blocked",
        label: "BLOCKED",
        style: "accent-border",
        color: "#e5484d",
        tooltip: "{{priority.blocker-context}}",
      },
      { field: "hot", label: "HOT" },
    ];
    const json = serializeCustomCardFlags(original);
    const parsed = parseCustomCardFlags(json);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].field).toBe("tags");
    expect(parsed[0].operator).toBe("contains");
    expect(parsed[0].operand).toBe("blocked");
    expect(parsed[0].tooltip).toBe("{{priority.blocker-context}}");
    expect(parsed[1].field).toBe("hot");
    expect(parsed[1].label).toBe("HOT");
  });

  it("serializes empty array", () => {
    expect(serializeCustomCardFlags([])).toBe("[]");
  });
});
