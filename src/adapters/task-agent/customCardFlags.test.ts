import { describe, expect, it } from "vitest";
import { parseCustomCardFlags, serializeCustomCardFlags } from "./customCardFlags";

describe("customCardFlags re-exports", () => {
  it("parseCustomCardFlags is a function", () => {
    expect(typeof parseCustomCardFlags).toBe("function");
  });

  it("serializeCustomCardFlags is a function", () => {
    expect(typeof serializeCustomCardFlags).toBe("function");
  });

  it("round-trips through parse and serialize", () => {
    const json = JSON.stringify([{ field: "x", label: "X", operator: "eq", operand: "y" }]);
    const rules = parseCustomCardFlags(json);
    expect(rules).toHaveLength(1);
    const serialized = serializeCustomCardFlags(rules);
    const reparsed = parseCustomCardFlags(serialized);
    expect(reparsed).toEqual(rules);
  });
});
