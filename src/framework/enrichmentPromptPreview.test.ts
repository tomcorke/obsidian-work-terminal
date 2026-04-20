import { describe, it, expect } from "vitest";
import {
  resolvePromptPreview,
  describePromptPlaceholder,
  DEFAULT_PREVIEW_VARS,
} from "./enrichmentPromptPreview";

describe("resolvePromptPreview", () => {
  it("substitutes a known placeholder with the default example vars", () => {
    const template = "Review the task file at $filePath and enrich it.";
    expect(resolvePromptPreview(template)).toBe(
      `Review the task file at ${DEFAULT_PREVIEW_VARS.filePath} and enrich it.`,
    );
  });

  it("substitutes multiple occurrences of the same placeholder", () => {
    const template = "$filePath then again $filePath";
    const expected = `${DEFAULT_PREVIEW_VARS.filePath} then again ${DEFAULT_PREVIEW_VARS.filePath}`;
    expect(resolvePromptPreview(template)).toBe(expected);
  });

  it("leaves unknown placeholders untouched", () => {
    const template = "Hello $unknown world $filePath";
    expect(resolvePromptPreview(template)).toBe(
      `Hello $unknown world ${DEFAULT_PREVIEW_VARS.filePath}`,
    );
  });

  it("accepts a custom vars map", () => {
    const template = "Path is $filePath and id $itemId";
    expect(resolvePromptPreview(template, { filePath: "/tmp/a.md", itemId: "abc-123" })).toBe(
      "Path is /tmp/a.md and id abc-123",
    );
  });

  it("returns empty string for empty template", () => {
    expect(resolvePromptPreview("")).toBe("");
  });

  it("returns the template verbatim when no placeholders present", () => {
    expect(resolvePromptPreview("no placeholders here")).toBe("no placeholders here");
  });
});

describe("describePromptPlaceholder", () => {
  it("returns just the hint for an empty default", () => {
    expect(describePromptPlaceholder("")).toBe("(default - leave blank to use)");
  });

  it("uses the first sentence of the default when short", () => {
    const defaultText = "Review the task. Then do more stuff.";
    expect(describePromptPlaceholder(defaultText)).toBe(
      "Review the task. (default - leave blank to use)",
    );
  });

  it("truncates long first sentences with ellipsis", () => {
    const long = "a".repeat(200);
    const result = describePromptPlaceholder(long, 60);
    // Must end with `... (default - leave blank to use)` and not contain
    // the full 200 character run.
    expect(result.endsWith("(default - leave blank to use)")).toBe(true);
    expect(result).toContain("...");
    // The snippet preceding the suffix must be 60 chars or fewer.
    const snippet = result.replace(" (default - leave blank to use)", "");
    expect(snippet.length).toBeLessThanOrEqual(60);
  });

  it("trims whitespace from the default", () => {
    const defaultText = "   Leading whitespace. And more.   ";
    expect(describePromptPlaceholder(defaultText)).toBe(
      "Leading whitespace. (default - leave blank to use)",
    );
  });
});
