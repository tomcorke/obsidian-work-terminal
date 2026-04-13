import { describe, expect, it, vi } from "vitest";
import { resolveDotPath, resolveTooltipTemplate, matchCardFlags } from "./cardFlags";
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
});
