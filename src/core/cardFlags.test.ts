import { describe, expect, it, vi } from "vitest";
import {
  resolveDotPath,
  resolveTooltipTemplate,
  matchCardFlags,
  evaluateOperator,
  parseCardFlagRulesJson,
  serializeCardFlagRules,
} from "./cardFlags";
import type { CardFlagRule } from "./interfaces";

describe("resolveDotPath", () => {
  it("resolves a top-level key", () => {
    expect(resolveDotPath({ foo: 42 }, "foo")).toBe(42);
  });

  it("resolves a nested dot path", () => {
    expect(resolveDotPath({ a: { b: { c: "deep" } } }, "a.b.c")).toBe("deep");
  });

  it("returns undefined for missing paths", () => {
    expect(resolveDotPath({ a: 1 }, "b")).toBeUndefined();
    expect(resolveDotPath({ a: { b: 1 } }, "a.c")).toBeUndefined();
  });

  it("returns undefined when traversing through a non-object", () => {
    expect(resolveDotPath({ a: "string" }, "a.b")).toBeUndefined();
  });

  it("resolves hyphenated keys", () => {
    expect(resolveDotPath({ priority: { "has-blocker": true } }, "priority.has-blocker")).toBe(
      true,
    );
  });
});

describe("resolveTooltipTemplate", () => {
  it("replaces a single placeholder", () => {
    const result = resolveTooltipTemplate("Blocked by: {{priority.blocker-context}}", {
      priority: { "blocker-context": "waiting on API" },
    });
    expect(result).toBe("Blocked by: waiting on API");
  });

  it("replaces multiple placeholders", () => {
    const result = resolveTooltipTemplate("{{name}} - {{status}}", {
      name: "task-1",
      status: "blocked",
    });
    expect(result).toBe("task-1 - blocked");
  });

  it("replaces missing values with empty string", () => {
    const result = resolveTooltipTemplate("{{missing}}", {});
    expect(result).toBe("");
  });

  it("handles templates with no placeholders", () => {
    expect(resolveTooltipTemplate("plain text", {})).toBe("plain text");
  });
});

describe("matchCardFlags", () => {
  const blockerRule: CardFlagRule = {
    field: "priority.has-blocker",
    value: true,
    label: "BLOCKED",
    style: "badge",
    color: "#e5484d",
    tooltip: "{{priority.blocker-context}}",
  };

  const urgentTagRule: CardFlagRule = {
    field: "tags",
    contains: "urgent",
    label: "URGENT",
    style: "accent-border",
    color: "orange",
  };

  const criticalRule: CardFlagRule = {
    field: "priority.impact",
    value: "critical",
    label: "CRITICAL",
    style: "background-tint",
    color: "rgba(255,0,0,0.08)",
  };

  it("matches a value-based rule", () => {
    const flags = matchCardFlags([blockerRule], {
      priority: { "has-blocker": true, "blocker-context": "waiting on deploy" },
    });
    expect(flags).toHaveLength(1);
    expect(flags[0].label).toBe("BLOCKED");
    expect(flags[0].style).toBe("badge");
    expect(flags[0].color).toBe("#e5484d");
    expect(flags[0].tooltip).toBe("waiting on deploy");
  });

  it("does not match when value differs", () => {
    const flags = matchCardFlags([blockerRule], {
      priority: { "has-blocker": false },
    });
    expect(flags).toHaveLength(0);
  });

  it("matches a contains-based rule with array field", () => {
    const flags = matchCardFlags([urgentTagRule], {
      tags: ["bug", "urgent", "p1"],
    });
    expect(flags).toHaveLength(1);
    expect(flags[0].label).toBe("URGENT");
    expect(flags[0].style).toBe("accent-border");
  });

  it("matches a contains-based rule with string field", () => {
    const flags = matchCardFlags([urgentTagRule], {
      tags: "this is urgent work",
    });
    expect(flags).toHaveLength(1);
  });

  it("does not match contains when value is absent from array", () => {
    const flags = matchCardFlags([urgentTagRule], {
      tags: ["bug", "p1"],
    });
    expect(flags).toHaveLength(0);
  });

  it("matches multiple rules simultaneously", () => {
    const flags = matchCardFlags([blockerRule, criticalRule], {
      priority: {
        "has-blocker": true,
        "blocker-context": "API down",
        impact: "critical",
      },
    });
    expect(flags).toHaveLength(2);
    expect(flags[0].label).toBe("BLOCKED");
    expect(flags[1].label).toBe("CRITICAL");
  });

  it("returns empty array when no rules match", () => {
    const flags = matchCardFlags([blockerRule, urgentTagRule, criticalRule], {
      priority: { "has-blocker": false, impact: "low" },
      tags: ["minor"],
    });
    expect(flags).toHaveLength(0);
  });

  it("defaults style to badge when not specified", () => {
    const rule: CardFlagRule = { field: "active", value: true, label: "ACTIVE" };
    const flags = matchCardFlags([rule], { active: true });
    expect(flags[0].style).toBe("badge");
  });

  it("warns when both value and contains are set on a rule", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rule: CardFlagRule = {
      field: "tags",
      value: "exact",
      contains: "partial",
      label: "AMBIGUOUS",
    };
    matchCardFlags([rule], { tags: "has partial match" });
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain("AMBIGUOUS");
    expect(warnSpy.mock.calls[0][0]).toContain("both");
    warnSpy.mockRestore();
  });

  it("matches truthy when no value or contains is specified", () => {
    const rule: CardFlagRule = { field: "hot", label: "HOT" };
    expect(matchCardFlags([rule], { hot: true })).toHaveLength(1);
    expect(matchCardFlags([rule], { hot: "yes" })).toHaveLength(1);
    expect(matchCardFlags([rule], { hot: false })).toHaveLength(0);
    expect(matchCardFlags([rule], { hot: 0 })).toHaveLength(0);
    expect(matchCardFlags([rule], {})).toHaveLength(0);
  });

  describe("operator-based matching", () => {
    it("matches with operator: eq", () => {
      const rule: CardFlagRule = {
        field: "source.type",
        operator: "eq",
        operand: "slack",
        label: "SLACK",
      };
      expect(matchCardFlags([rule], { source: { type: "slack" } })).toHaveLength(1);
      expect(matchCardFlags([rule], { source: { type: "jira" } })).toHaveLength(0);
    });

    it("matches with operator: neq", () => {
      const rule: CardFlagRule = {
        field: "source.type",
        operator: "neq",
        operand: "prompt",
        label: "EXTERNAL",
      };
      expect(matchCardFlags([rule], { source: { type: "slack" } })).toHaveLength(1);
      expect(matchCardFlags([rule], { source: { type: "prompt" } })).toHaveLength(0);
    });

    it("matches with operator: gt for numeric comparison", () => {
      const rule: CardFlagRule = {
        field: "priority.score",
        operator: "gt",
        operand: "80",
        label: "HIGH",
        color: "red",
      };
      expect(matchCardFlags([rule], { priority: { score: 90 } })).toHaveLength(1);
      expect(matchCardFlags([rule], { priority: { score: 80 } })).toHaveLength(0);
      expect(matchCardFlags([rule], { priority: { score: 50 } })).toHaveLength(0);
    });

    it("matches with operator: gte", () => {
      const rule: CardFlagRule = {
        field: "priority.score",
        operator: "gte",
        operand: "80",
        label: "HIGH",
      };
      expect(matchCardFlags([rule], { priority: { score: 80 } })).toHaveLength(1);
      expect(matchCardFlags([rule], { priority: { score: 79 } })).toHaveLength(0);
    });

    it("matches with operator: lt", () => {
      const rule: CardFlagRule = {
        field: "priority.score",
        operator: "lt",
        operand: "20",
        label: "LOW",
      };
      expect(matchCardFlags([rule], { priority: { score: 10 } })).toHaveLength(1);
      expect(matchCardFlags([rule], { priority: { score: 20 } })).toHaveLength(0);
    });

    it("matches with operator: lte", () => {
      const rule: CardFlagRule = {
        field: "priority.score",
        operator: "lte",
        operand: "20",
        label: "LOW",
      };
      expect(matchCardFlags([rule], { priority: { score: 20 } })).toHaveLength(1);
      expect(matchCardFlags([rule], { priority: { score: 21 } })).toHaveLength(0);
    });

    it("matches with operator: contains on array", () => {
      const rule: CardFlagRule = {
        field: "tags",
        operator: "contains",
        operand: "blocked",
        label: "BLOCKED",
      };
      expect(matchCardFlags([rule], { tags: ["wip", "blocked"] })).toHaveLength(1);
      expect(matchCardFlags([rule], { tags: ["wip", "ready"] })).toHaveLength(0);
    });

    it("matches with operator: contains on string", () => {
      const rule: CardFlagRule = {
        field: "notes",
        operator: "contains",
        operand: "urgent",
        label: "URGENT",
      };
      expect(matchCardFlags([rule], { notes: "this is urgent work" })).toHaveLength(1);
      expect(matchCardFlags([rule], { notes: "this is normal work" })).toHaveLength(0);
    });

    it("matches with operator: regex", () => {
      const rule: CardFlagRule = {
        field: "source.id",
        operator: "regex",
        operand: "^PROJ-\\d+$",
        label: "JIRA",
      };
      expect(matchCardFlags([rule], { source: { id: "PROJ-123" } })).toHaveLength(1);
      expect(matchCardFlags([rule], { source: { id: "OTHER-456" } })).toHaveLength(0);
    });

    it("handles invalid regex gracefully (no match, no throw)", () => {
      const rule: CardFlagRule = {
        field: "name",
        operator: "regex",
        operand: "[invalid(",
        label: "BAD",
      };
      expect(matchCardFlags([rule], { name: "test" })).toHaveLength(0);
    });

    it("returns false for numeric operators on non-numeric values", () => {
      const rule: CardFlagRule = {
        field: "name",
        operator: "gt",
        operand: "50",
        label: "HIGH",
      };
      expect(matchCardFlags([rule], { name: "not-a-number" })).toHaveLength(0);
    });

    it("operator takes priority over legacy value/contains fields", () => {
      const rule: CardFlagRule = {
        field: "priority.score",
        operator: "gt",
        operand: "50",
        value: true, // legacy field - should be ignored
        label: "HIGH",
      };
      // operator: gt with operand: "50" should match score=60, regardless of legacy value
      expect(matchCardFlags([rule], { priority: { score: 60 } })).toHaveLength(1);
      expect(matchCardFlags([rule], { priority: { score: 40 } })).toHaveLength(0);
    });
  });
});

describe("evaluateOperator", () => {
  it("eq: matches string equality via coercion", () => {
    expect(evaluateOperator("slack", "eq", "slack")).toBe(true);
    expect(evaluateOperator("jira", "eq", "slack")).toBe(false);
    expect(evaluateOperator(42, "eq", "42")).toBe(true);
    expect(evaluateOperator(true, "eq", "true")).toBe(true);
  });

  it("neq: matches string inequality", () => {
    expect(evaluateOperator("slack", "neq", "jira")).toBe(true);
    expect(evaluateOperator("slack", "neq", "slack")).toBe(false);
  });

  it("gt/lt/gte/lte: numeric comparisons", () => {
    expect(evaluateOperator(90, "gt", "80")).toBe(true);
    expect(evaluateOperator(80, "gt", "80")).toBe(false);
    expect(evaluateOperator(70, "lt", "80")).toBe(true);
    expect(evaluateOperator(80, "lt", "80")).toBe(false);
    expect(evaluateOperator(80, "gte", "80")).toBe(true);
    expect(evaluateOperator(80, "lte", "80")).toBe(true);
  });

  it("gt/lt/gte/lte: returns false for NaN", () => {
    expect(evaluateOperator("abc", "gt", "80")).toBe(false);
    expect(evaluateOperator(90, "gt", "abc")).toBe(false);
    expect(evaluateOperator(undefined, "gt", "80")).toBe(false);
  });

  it("contains: array and string matching", () => {
    expect(evaluateOperator(["a", "b", "c"], "contains", "b")).toBe(true);
    expect(evaluateOperator(["a", "b"], "contains", "c")).toBe(false);
    expect(evaluateOperator("hello world", "contains", "world")).toBe(true);
    expect(evaluateOperator("hello", "contains", "world")).toBe(false);
    expect(evaluateOperator(42, "contains", "4")).toBe(false);
  });

  it("regex: pattern matching", () => {
    expect(evaluateOperator("PROJ-123", "regex", "^PROJ-\\d+$")).toBe(true);
    expect(evaluateOperator("OTHER", "regex", "^PROJ-\\d+$")).toBe(false);
    expect(evaluateOperator(null, "regex", "^$")).toBe(true); // null ?? "" = ""
    expect(evaluateOperator(undefined, "regex", "^$")).toBe(true); // undefined ?? "" = ""
  });

  it("regex: handles invalid patterns without throwing", () => {
    expect(evaluateOperator("test", "regex", "[bad(")).toBe(false);
  });

  it("contains: empty operand does not match", () => {
    expect(evaluateOperator("hello", "contains", "")).toBe(false);
    expect(evaluateOperator(["a", "b"], "contains", "")).toBe(false);
  });

  it("regex: empty operand does not match", () => {
    expect(evaluateOperator("anything", "regex", "")).toBe(false);
    expect(evaluateOperator("", "regex", "")).toBe(false);
  });
});

describe("parseCardFlagRulesJson", () => {
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
    const rules = parseCardFlagRulesJson(json);
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
    expect(parseCardFlagRulesJson("[]")).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(parseCardFlagRulesJson("")).toEqual([]);
  });

  it("returns empty array for invalid JSON", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseCardFlagRulesJson("{invalid}")).toEqual([]);
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it("returns empty array for non-array JSON", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseCardFlagRulesJson('"string"')).toEqual([]);
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it("skips rules with missing field", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const json = JSON.stringify([{ label: "TEST" }]);
    expect(parseCardFlagRulesJson(json)).toEqual([]);
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it("skips rules with missing label", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const json = JSON.stringify([{ field: "test" }]);
    expect(parseCardFlagRulesJson(json)).toEqual([]);
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it("skips null/non-object entries", () => {
    const json = JSON.stringify([null, 42, "string", { field: "x", label: "X" }]);
    const rules = parseCardFlagRulesJson(json);
    expect(rules).toHaveLength(1);
    expect(rules[0].field).toBe("x");
  });

  it("ignores invalid operator values", () => {
    const json = JSON.stringify([{ field: "x", label: "X", operator: "invalid", operand: "5" }]);
    const rules = parseCardFlagRulesJson(json);
    expect(rules).toHaveLength(1);
    expect(rules[0].operator).toBeUndefined();
  });

  it("ignores invalid style values", () => {
    const json = JSON.stringify([{ field: "x", label: "X", style: "invalid" }]);
    const rules = parseCardFlagRulesJson(json);
    expect(rules).toHaveLength(1);
    expect(rules[0].style).toBeUndefined();
  });

  it("trims whitespace from field, label, color, and tooltip", () => {
    const json = JSON.stringify([
      { field: "  x  ", label: " Y ", color: "  red  ", tooltip: " tip " },
    ]);
    const rules = parseCardFlagRulesJson(json);
    expect(rules[0].field).toBe("x");
    expect(rules[0].label).toBe("Y");
    expect(rules[0].color).toBe("red");
    expect(rules[0].tooltip).toBe("tip");
  });

  it("parses all valid styles", () => {
    for (const style of ["badge", "accent-border", "background-tint"]) {
      const json = JSON.stringify([{ field: "x", label: "X", style }]);
      const rules = parseCardFlagRulesJson(json);
      expect(rules[0].style).toBe(style);
    }
  });

  it("parses all valid operators", () => {
    for (const operator of ["eq", "neq", "gt", "lt", "gte", "lte", "contains", "regex"]) {
      const json = JSON.stringify([{ field: "x", label: "X", operator, operand: "v" }]);
      const rules = parseCardFlagRulesJson(json);
      expect(rules[0].operator).toBe(operator);
      expect(rules[0].operand).toBe("v");
    }
  });

  it("coerces non-string operand to string", () => {
    const json = JSON.stringify([{ field: "x", label: "X", operator: "gt", operand: 42 }]);
    const rules = parseCardFlagRulesJson(json);
    expect(rules[0].operand).toBe("42");
  });

  it("preserves legacy value field when no operator", () => {
    const json = JSON.stringify([{ field: "x", label: "X", value: true }]);
    const rules = parseCardFlagRulesJson(json);
    expect(rules[0].value).toBe(true);
    expect(rules[0].operator).toBeUndefined();
  });

  it("ignores legacy value/contains when operator is set", () => {
    const json = JSON.stringify([
      { field: "x", label: "X", operator: "eq", operand: "y", value: true, contains: "z" },
    ]);
    const rules = parseCardFlagRulesJson(json);
    expect(rules[0].operator).toBe("eq");
    expect(rules[0].value).toBeUndefined();
    expect(rules[0].contains).toBeUndefined();
  });
});

describe("serializeCardFlagRules", () => {
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
    const json = serializeCardFlagRules(rules);
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
    const json = serializeCardFlagRules(rules);
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
    const json = serializeCardFlagRules(original);
    const parsed = parseCardFlagRulesJson(json);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].field).toBe("tags");
    expect(parsed[0].operator).toBe("contains");
    expect(parsed[0].operand).toBe("blocked");
    expect(parsed[0].tooltip).toBe("{{priority.blocker-context}}");
    expect(parsed[1].field).toBe("hot");
    expect(parsed[1].label).toBe("HOT");
  });

  it("serializes empty array", () => {
    expect(serializeCardFlagRules([])).toBe("[]");
  });
});
