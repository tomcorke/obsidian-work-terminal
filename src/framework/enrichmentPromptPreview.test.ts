import { describe, it, expect } from "vitest";
import {
  resolvePromptPreview,
  describePromptPlaceholder,
  DEFAULT_PREVIEW_VARS,
} from "./enrichmentPromptPreview";

describe("resolvePromptPreview", () => {
  it("substitutes a known placeholder with the default example vars", () => {
    const template = "Review the task file at {{FILE_PATH}} and enrich it.";
    expect(resolvePromptPreview(template)).toBe(
      `Review the task file at ${DEFAULT_PREVIEW_VARS.FILE_PATH} and enrich it.`,
    );
  });

  it("substitutes multiple occurrences of the same placeholder", () => {
    const template = "{{FILE_PATH}} then again {{FILE_PATH}}";
    const expected = `${DEFAULT_PREVIEW_VARS.FILE_PATH} then again ${DEFAULT_PREVIEW_VARS.FILE_PATH}`;
    expect(resolvePromptPreview(template)).toBe(expected);
  });

  it("leaves unknown placeholders untouched", () => {
    const template = "Hello {{UNKNOWN}} world {{FILE_PATH}}";
    expect(resolvePromptPreview(template)).toBe(
      `Hello {{UNKNOWN}} world ${DEFAULT_PREVIEW_VARS.FILE_PATH}`,
    );
  });

  it("accepts a custom vars map", () => {
    const template = "Path is {{FILE_PATH}} and id {{ITEM_ID}}";
    expect(resolvePromptPreview(template, { FILE_PATH: "/tmp/a.md", ITEM_ID: "abc-123" })).toBe(
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
