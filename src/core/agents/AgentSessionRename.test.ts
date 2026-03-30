import { describe, it, expect, beforeEach } from "vitest";
import { AgentSessionRename } from "./AgentSessionRename";

describe("AgentSessionRename", () => {
  let monitor: AgentSessionRename;

  beforeEach(() => {
    monitor = new AgentSessionRename();
  });

  it("detects rename on complete line", () => {
    const data = Buffer.from("  \u2514 Session renamed to: my-new-session\n");
    const result = monitor.processChunk(data);
    expect(result).toBe("my-new-session");
  });

  it("detects rename on partial line (no trailing newline)", () => {
    const data = Buffer.from("  \u2514 Session renamed to: partial-name");
    const result = monitor.processChunk(data);
    expect(result).toBe("partial-name");
  });

  it("handles rename split across chunks", () => {
    // First chunk has start of line
    const result1 = monitor.processChunk(Buffer.from("  \u2514 Session renamed"));
    // No rename detected yet (incomplete pattern)
    expect(result1).toBeNull();

    // Second chunk completes the line
    const result2 = monitor.processChunk(Buffer.from(" to: split-rename\n"));
    expect(result2).toBe("split-rename");
  });

  it("strips ANSI sequences before matching", () => {
    const data = Buffer.from(
      "  \x1b[32m\u2514\x1b[0m Session renamed to: \x1b[1mansi-name\x1b[0m\n",
    );
    const result = monitor.processChunk(data);
    expect(result).toBe("ansi-name");
  });

  it("returns null when no rename pattern", () => {
    const data = Buffer.from("Just some regular output line\n");
    const result = monitor.processChunk(data);
    expect(result).toBeNull();
  });

  it("returns null for empty data", () => {
    const result = monitor.processChunk(Buffer.from(""));
    expect(result).toBeNull();
  });

  it("handles multiple lines, returning the last rename", () => {
    const data = Buffer.from(
      "line one\n\u2514 Session renamed to: first\nline two\n\u2514 Session renamed to: second\n",
    );
    const result = monitor.processChunk(data);
    expect(result).toBe("second");
  });

  it("trims whitespace from detected name", () => {
    const data = Buffer.from("  \u2514 Session renamed to:   padded-name   \n");
    const result = monitor.processChunk(data);
    expect(result).toBe("padded-name");
  });

  it("does not match rename text in middle of a word", () => {
    const data = Buffer.from("The text says Session renamed to: embedded but with prefix\n");
    // This should still match because the pattern is anchored to start-of-line
    // with optional leading whitespace and non-word characters
    const result = monitor.processChunk(data);
    // "The text" is a word character prefix, so the pattern should NOT match
    expect(result).toBeNull();
  });

  it("handles multi-byte UTF-8 split across chunks", () => {
    // The box-drawing character \u2514 is 3 bytes in UTF-8: E2 94 94
    // Split it across two chunks
    const fullString = "  \u2514 Session renamed to: utf8-name\n";
    const fullBuf = Buffer.from(fullString);

    // Split at a point that breaks the UTF-8 character
    const chunk1 = fullBuf.subarray(0, 3); // Includes partial UTF-8
    const chunk2 = fullBuf.subarray(3);

    const result1 = monitor.processChunk(Buffer.from(chunk1));
    // May or may not detect yet
    const result2 = monitor.processChunk(Buffer.from(chunk2));

    // At least one of the results should have the rename
    const detected = result1 || result2;
    expect(detected).toBe("utf8-name");
  });

  it("reset clears internal state", () => {
    // Feed a partial line
    monitor.processChunk(Buffer.from("  \u2514 Session renamed"));
    monitor.reset();

    // After reset, the partial should be gone
    const result = monitor.processChunk(Buffer.from("some other line\n"));
    expect(result).toBeNull();
  });
});
