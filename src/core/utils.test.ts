import { describe, it, expect, afterEach } from "vitest";
import { expandTilde, normalizeObsidianDisplayText, stripAnsi, slugify } from "./utils";

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
