import { describe, it, expect, afterEach } from "vitest";
import {
  expandTilde,
  normalizeObsidianDisplayText,
  stripAnsi,
  slugify,
  titleCase,
  yamlQuoteValue,
} from "./utils";

describe("expandTilde", () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;

  afterEach(() => {
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
  });

  it("expands ~/path to home directory", () => {
    process.env.HOME = "/home/user";
    expect(expandTilde("~/Documents/notes")).toBe("/home/user/Documents/notes");
  });

  it("expands bare tilde", () => {
    process.env.HOME = "/home/user";
    expect(expandTilde("~")).toBe("/home/user");
  });

  it("does not expand tilde in middle of path", () => {
    process.env.HOME = "/home/user";
    expect(expandTilde("/some/~path")).toBe("/some/~path");
  });

  it("does not change absolute paths", () => {
    process.env.HOME = "/home/user";
    expect(expandTilde("/usr/local/bin")).toBe("/usr/local/bin");
  });

  it("falls back to USERPROFILE", () => {
    delete process.env.HOME;
    process.env.USERPROFILE = "C:\\Users\\me";
    expect(expandTilde("~/file")).toBe("C:\\Users\\me/file");
  });

  it("returns original when no home directory", () => {
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    expect(expandTilde("~/file")).toBe("~/file");
  });
});

describe("stripAnsi", () => {
  it("strips simple colour codes", () => {
    expect(stripAnsi("\x1b[31mred text\x1b[0m")).toBe("red text");
  });

  it("preserves cursor-forward alignment with spaces", () => {
    expect(stripAnsi("hello\x1b[5Cworld")).toBe("hello     world");
  });

  it("strips OSC sequences", () => {
    expect(stripAnsi("\x1b]777;resize;80;24\x07")).toBe("");
  });

  it("returns plain text unchanged", () => {
    expect(stripAnsi("plain text with no escapes")).toBe("plain text with no escapes");
  });

  it("handles empty string", () => {
    expect(stripAnsi("")).toBe("");
  });

  it("strips control characters", () => {
    expect(stripAnsi("hello\x00\x08\x0eworld")).toBe("helloworld");
  });

  it("preserves tabs and newlines", () => {
    expect(stripAnsi("hello\tworld\nfoo")).toBe("hello\tworld\nfoo");
  });
});

describe("slugify", () => {
  it("converts simple title", () => {
    expect(slugify("My Task Title")).toBe("my-task-title");
  });

  it("replaces special characters", () => {
    expect(slugify("Fix bug #123 (urgent!)")).toBe("fix-bug-123-urgent");
  });

  it("truncates long titles to 40 chars without trailing hyphen", () => {
    const result = slugify("this is a very long title that exceeds the forty character limit");
    expect(result.length).toBeLessThanOrEqual(40);
    expect(result).not.toMatch(/-$/);
    expect(result).toMatch(/^[a-z0-9-]+$/);
  });

  it("strips leading and trailing special characters", () => {
    expect(slugify("---hello world---")).toBe("hello-world");
  });

  it("returns empty string for empty input", () => {
    expect(slugify("")).toBe("");
  });

  it("preserves already valid slug", () => {
    expect(slugify("already-valid")).toBe("already-valid");
  });

  it("collapses consecutive special characters", () => {
    expect(slugify("hello!!!...world")).toBe("hello-world");
  });
});

describe("titleCase", () => {
  it("capitalizes a single word", () => {
    expect(titleCase("review")).toBe("Review");
  });

  it("splits and capitalizes hyphenated words", () => {
    expect(titleCase("blocked-upstream")).toBe("Blocked Upstream");
  });

  it("splits and capitalizes underscored words", () => {
    expect(titleCase("my_custom_state")).toBe("My Custom State");
  });

  it("handles mixed separators", () => {
    expect(titleCase("in-progress_now")).toBe("In Progress Now");
  });

  it("returns empty string for empty input", () => {
    expect(titleCase("")).toBe("");
  });

  it("handles single character", () => {
    expect(titleCase("x")).toBe("X");
  });

  it("preserves already capitalized words", () => {
    expect(titleCase("API-ready")).toBe("API Ready");
  });
});

describe("yamlQuoteValue", () => {
  it("does not quote simple values", () => {
    expect(yamlQuoteValue("active")).toBe("active");
    expect(yamlQuoteValue("review")).toBe("review");
    expect(yamlQuoteValue("blocked-upstream")).toBe("blocked-upstream");
  });

  it("quotes YAML boolean literals", () => {
    expect(yamlQuoteValue("yes")).toBe('"yes"');
    expect(yamlQuoteValue("true")).toBe('"true"');
    expect(yamlQuoteValue("on")).toBe('"on"');
    expect(yamlQuoteValue("no")).toBe('"no"');
    expect(yamlQuoteValue("false")).toBe('"false"');
    expect(yamlQuoteValue("off")).toBe('"off"');
  });

  it("quotes case-insensitive booleans", () => {
    expect(yamlQuoteValue("Yes")).toBe('"Yes"');
    expect(yamlQuoteValue("TRUE")).toBe('"TRUE"');
    expect(yamlQuoteValue("On")).toBe('"On"');
  });

  it("quotes values with hash character", () => {
    expect(yamlQuoteValue("state#1")).toBe('"state#1"');
  });

  it("quotes values with colon", () => {
    expect(yamlQuoteValue("key: value")).toBe('"key: value"');
  });

  it("quotes values with leading whitespace", () => {
    expect(yamlQuoteValue(" leading")).toBe('" leading"');
  });

  it("quotes values with trailing whitespace", () => {
    expect(yamlQuoteValue("trailing ")).toBe('"trailing "');
  });

  it("escapes embedded double quotes", () => {
    expect(yamlQuoteValue('say "hi"')).toBe('"say \\"hi\\""');
  });

  it("escapes embedded newlines", () => {
    expect(yamlQuoteValue("line1\nline2")).toBe('"line1\\nline2"');
  });

  it("quotes null keyword", () => {
    expect(yamlQuoteValue("null")).toBe('"null"');
  });

  it("quotes empty string", () => {
    expect(yamlQuoteValue("")).toBe('""');
  });
});

describe("normalizeObsidianDisplayText", () => {
  it("strips brackets from plain Obsidian links", () => {
    expect(normalizeObsidianDisplayText("[[Some Doc]]")).toBe("Some Doc");
  });

  it("prefers alias text when the link defines one", () => {
    expect(normalizeObsidianDisplayText("[[Some Doc|Readable Label]]")).toBe("Readable Label");
  });

  it("replaces embedded links inside longer text", () => {
    expect(normalizeObsidianDisplayText("Blocked by [[Some Doc]] today")).toBe(
      "Blocked by Some Doc today",
    );
  });

  it("falls back to the target when alias text is empty", () => {
    expect(normalizeObsidianDisplayText("[[Some Doc|]]")).toBe("Some Doc");
  });

  it("leaves plain text unchanged", () => {
    expect(normalizeObsidianDisplayText("plain text")).toBe("plain text");
  });
});
