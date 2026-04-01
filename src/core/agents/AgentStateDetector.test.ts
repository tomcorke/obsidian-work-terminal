import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentStateDetector, aggregateState, type AgentState } from "./AgentStateDetector";

/**
 * Create a minimal mock Terminal with a buffer that returns the given lines.
 * The buffer is set up so _readScreen() will read all lines:
 * baseY=0, cursorY=lines.length - 1, and getLine returns the lines array.
 */
function mockTerminal(lines: string[]) {
  const lineObjs = lines.map((text) => ({
    translateToString: (_trim?: boolean) => text,
  }));
  return {
    buffer: {
      active: {
        get baseY() {
          return 0;
        },
        get cursorY() {
          return Math.max(0, lines.length - 1);
        },
        getLine: (i: number) => lineObjs[i] || null,
      },
    },
  } as any;
}

/**
 * Create a mock terminal whose content can be updated between polls.
 */
function mutableMockTerminal(initialLines: string[]) {
  let currentLines = initialLines;
  const terminal = {
    buffer: {
      active: {
        get baseY() {
          return 0;
        },
        get cursorY() {
          return Math.max(0, currentLines.length - 1);
        },
        getLine: (i: number) => {
          const text = currentLines[i];
          return text != null ? { translateToString: (_trim?: boolean) => text } : null;
        },
      },
    },
    setLines(lines: string[]) {
      currentLines = lines;
    },
  } as any;
  return terminal;
}

describe("AgentStateDetector", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("waiting pattern detection", () => {
    it("detects 'Enter to select' as waiting", () => {
      const terminal = mockTerminal([
        "  Choose an option:",
        "  > 1. First choice",
        "    2. Second choice",
        "  Enter to select, up/down to navigate",
      ]);
      const detector = new AgentStateDetector(terminal, () => false);
      detector.start();

      // Advance past the initial "active" state by triggering the interval
      vi.advanceTimersByTime(2100);
      expect(detector.state).toBe("waiting");
      detector.stop();
    });

    it("detects permission prompt as waiting", () => {
      const terminal = mockTerminal([
        "  Claude wants to run a command.",
        "  Allow this action?",
        "  allowOnce  denyOnce  allowAlways",
      ]);
      const detector = new AgentStateDetector(terminal, () => false);
      detector.start();

      vi.advanceTimersByTime(2100);
      expect(detector.state).toBe("waiting");
      detector.stop();
    });

    it("detects numbered options with ? as waiting", () => {
      const terminal = mockTerminal([
        "  Which file should I modify?",
        "  (1) src/main.ts",
        "  (2) src/utils.ts",
        "  (3) src/index.ts",
      ]);
      const detector = new AgentStateDetector(terminal, () => false);
      detector.start();

      vi.advanceTimersByTime(2100);
      expect(detector.state).toBe("waiting");
      detector.stop();
    });

    it("detects Yes/No as waiting", () => {
      const terminal = mockTerminal(["  Do you want to continue?", "  Yes", "  No"]);
      const detector = new AgentStateDetector(terminal, () => false);
      detector.start();

      vi.advanceTimersByTime(2100);
      expect(detector.state).toBe("waiting");
      detector.stop();
    });

    it("suppresses waiting to idle when tab is visible", () => {
      const terminal = mockTerminal(["  Enter to select, up/down to navigate"]);
      const detector = new AgentStateDetector(terminal, () => true);
      detector.start();

      vi.advanceTimersByTime(2100);
      expect(detector.state).toBe("idle");
      detector.stop();
    });

    it("keeps hidden Claude prompts waiting when the question is six lines from the end", () => {
      const terminal = mockTerminal([
        "  Want me to fix this and open a PR?",
        "  ✻ Sautéed for 3m 51s",
        "  ────────────────",
        "  ❯",
        "  ────────────────",
        "  ➜  obsidian-work-terminal git:(main) cwd context",
        "  ⏵⏵ permissions",
      ]);
      const detector = new AgentStateDetector(terminal, () => false);
      detector.start();

      vi.advanceTimersByTime(2100);
      expect(detector.state).toBe("waiting");
      detector.stop();
    });

    it("keeps hidden Claude prompts waiting from recent output when the screen is empty", () => {
      const detector = new AgentStateDetector(mockTerminal([]), () => false);
      detector.trackOutput(
        [
          "Who do you actually want using this on day one?",
          "✻ Sautéed for 3m 51s",
          "────────────────",
          "❯",
          "────────────────",
          "➜  obsidian-work-terminal git:(main) cwd context",
          "⏵⏵ permissions",
        ].join("\n"),
      );
      detector.start();

      vi.advanceTimersByTime(2100);
      expect(detector.state).toBe("waiting");
      detector.stop();
    });

    it("does not treat a plain hidden question without Claude prompt chrome as waiting", () => {
      const terminal = mockTerminal([
        "  Should I refactor this?",
        "  Done.",
        "  Tests passed.",
        "  Working tree clean.",
        "  Ready for the next step.",
        "  ➜  obsidian-work-terminal git:(main) cwd context",
        "  plain status line",
      ]);
      const detector = new AgentStateDetector(terminal, () => false);
      detector.start(true);

      vi.advanceTimersByTime(2100);
      expect(detector.state).toBe("idle");
      detector.stop();
    });

    it("does not treat recent output without Claude prompt chrome as waiting", () => {
      const detector = new AgentStateDetector(mockTerminal([]), () => false);
      detector.trackOutput(
        [
          "Should I refactor this?",
          "Done.",
          "Tests passed.",
          "Working tree clean.",
          "Ready for the next step.",
          "➜  obsidian-work-terminal git:(main) cwd context",
          "plain status line",
        ].join("\n"),
      );
      detector.start(true);

      vi.advanceTimersByTime(2100);
      expect(detector.state).toBe("idle");
      detector.stop();
    });

    it("does not treat answered hidden Claude questions on screen as waiting", () => {
      const terminal = mockTerminal([
        "Want me to request a review from someone specific?",
        "❯ no",
        "⏺ OK. What do you need done on this PR?",
        "❯ nothing for now",
        "⏺ Got it. Standing by.",
        "──────────────────────────────────────────────",
        "❯",
        "──────────────────────────────────────────────",
        "➜  obsidian-work-terminal git:(main) Opus 4.6",
        "⏵⏵ bypass permissions on (shift+tab to cycle)",
      ]);
      const detector = new AgentStateDetector(terminal, () => false);
      detector.start(true);

      vi.advanceTimersByTime(2100);
      expect(detector.state).toBe("idle");
      detector.stop();
    });

    it("does not treat answered hidden Claude questions in recent output as waiting", () => {
      const detector = new AgentStateDetector(mockTerminal([]), () => false);
      detector.trackOutput(
        [
          "Want me to request a review from someone specific?",
          "❯ no",
          "⏺ OK. What do you need done on this PR?",
          "❯ nothing for now",
          "⏺ Got it. Standing by.",
          "──────────────────────────────────────────────",
          "❯",
          "──────────────────────────────────────────────",
          "➜  obsidian-work-terminal git:(main) Opus 4.6",
          "⏵⏵ bypass permissions on (shift+tab to cycle)",
        ].join("\n"),
      );
      detector.start(true);

      vi.advanceTimersByTime(2100);
      expect(detector.state).toBe("idle");
      detector.stop();
    });

    it("still treats a newer unanswered hidden Claude question as waiting", () => {
      const terminal = mockTerminal([
        "Want me to request a review from someone specific?",
        "❯ no",
        "⏺ OK. What do you need done on this PR?",
        "❯ nothing for now",
        "⏺ Got it. Standing by.",
        "⏺ Need anything else before I stop here?",
        "──────────────────────────────────────────────",
        "❯",
        "──────────────────────────────────────────────",
        "➜  obsidian-work-terminal git:(main) Opus 4.6",
        "⏵⏵ bypass permissions on (shift+tab to cycle)",
      ]);
      const detector = new AgentStateDetector(terminal, () => false);
      detector.start();

      vi.advanceTimersByTime(2100);
      expect(detector.state).toBe("waiting");
      detector.stop();
    });

    it("keeps a visible asking-user prompt in range even with a full recent-output tail", () => {
      const terminal = mockTerminal([
        "  ○ Asking user What kind of question would you like me to ask?",
      ]);
      const detector = new AgentStateDetector(terminal, () => false);
      detector.trackOutput(
        [
          "╭────────────────────────────────────────────────────────────╮",
          "│ What kind of question would you like me to ask?           │",
          "│ ❯ 1. Something thoughtful (Recommended)                   │",
          "│   2. Something fun                                        │",
          "│   3. Something practical                                  │",
          "│   4. Surprise me                                          │",
          "│   5. Other (type your answer)                             │",
          "│ ↑↓ to select · Enter to confirm · Esc to cancel           │",
          "╰────────────────────────────────────────────────────────────╯",
          "○ Asking user What kind of question would you like me to ask?",
          "history line 1",
          "history line 2",
          "history line 3",
          "history line 4",
          "history line 5",
        ].join("\n"),
      );
      detector.start();

      vi.advanceTimersByTime(2100);
      expect(detector.state).toBe("waiting");
      detector.stop();
    });

    it("detects boxed Copilot ask_user prompts on the visible screen", () => {
      const terminal = mockTerminal([
        "╭────────────────────────────────────────────────────────────╮",
        "│ What kind of question would you like me to ask?           │",
        "│ ❯ 1. Something thoughtful (Recommended)                   │",
        "│   2. Something fun                                        │",
        "│ ↑↓ to select · Enter to confirm · Esc to cancel           │",
        "╰────────────────────────────────────────────────────────────╯",
      ]);
      const detector = new AgentStateDetector(terminal, () => false);
      detector.start();

      vi.advanceTimersByTime(2100);
      expect(detector.state).toBe("waiting");
      detector.stop();
    });

    it("prefers a newer active status below an older visible prompt box", () => {
      const terminal = mockTerminal([
        "╭────────────────────────────────────────────────────────────╮",
        "│ What kind of question would you like me to ask?           │",
        "│ ❯ 1. Something thoughtful (Recommended)                   │",
        "│   2. Something fun                                        │",
        "╰────────────────────────────────────────────────────────────╯",
        "○ Thinking (Esc to cancel)",
      ]);
      const detector = new AgentStateDetector(terminal, () => false);
      detector.start();

      vi.advanceTimersByTime(2100);
      expect(detector.state).toBe("active");
      detector.stop();
    });

    it("does not keep waiting from stale boxed recent output after the screen moves on", () => {
      const terminal = mockTerminal(["  ○ Thinking (Esc to cancel)"]);
      const detector = new AgentStateDetector(terminal, () => false);
      detector.trackOutput(
        [
          "╭────────────────────────────────────────────────────────────╮",
          "│ What kind of question would you like me to ask?           │",
          "│ ❯ 1. Something thoughtful (Recommended)                   │",
          "│   2. Something fun                                        │",
          "│ ↑↓ to select · Enter to confirm · Esc to cancel           │",
          "╰────────────────────────────────────────────────────────────╯",
        ].join("\n"),
      );
      detector.start();

      vi.advanceTimersByTime(2100);
      expect(detector.state).toBe("active");
      detector.stop();
    });

    it("does not treat Tip lines ending in ? as waiting", () => {
      const terminal = mockTerminal([
        "  some previous output",
        "  Tip: Did you know you can drag and drop image files into your terminal?",
      ]);
      const detector = new AgentStateDetector(terminal, () => false);
      detector.start();

      vi.advanceTimersByTime(2100);
      expect(detector.state).toBe("idle");
      detector.stop();
    });

    it("does not treat other informational prefixes ending in ? as waiting", () => {
      const prefixes = [
        "Hint: Have you tried using the keyboard shortcut?",
        "Note: Did you know this feature supports multiple formats?",
        "Pro tip: Want to speed things up with parallel execution?",
        "FYI: Did you know about the new caching feature?",
      ];
      for (const line of prefixes) {
        const terminal = mockTerminal(["  some previous output", `  ${line}`]);
        const detector = new AgentStateDetector(terminal, () => false);
        detector.start();

        vi.advanceTimersByTime(2100);
        expect(detector.state).toBe("idle");
        detector.stop();
      }
    });

    it("does not treat Tip lines in hidden Claude prompt context as waiting", () => {
      const terminal = mockTerminal([
        "  Tip: Did you know you can drag and drop image files into your terminal?",
        "  ────────────────",
        "  ❯",
        "  ────────────────",
        "  ➜  obsidian-work-terminal git:(main) cwd context",
        "  ⏵⏵ permissions",
      ]);
      const detector = new AgentStateDetector(terminal, () => false);
      detector.start();

      vi.advanceTimersByTime(2100);
      expect(detector.state).toBe("idle");
      detector.stop();
    });

    it("still detects real questions ending in ? as waiting", () => {
      const terminal = mockTerminal([
        "  some previous output",
        "  Would you like me to proceed with this change?",
      ]);
      const detector = new AgentStateDetector(terminal, () => false);
      detector.start();

      vi.advanceTimersByTime(2100);
      expect(detector.state).toBe("waiting");
      detector.stop();
    });

    it("does not treat ordinary boxed output as waiting", () => {
      const terminal = mockTerminal(["  some previous output"]);
      const detector = new AgentStateDetector(terminal, () => false);
      detector.trackOutput(
        [
          "╭────────────────────────────────────────────────────────────╮",
          "│ Repository summary                                        │",
          "│ Build completed successfully                              │",
          "╰────────────────────────────────────────────────────────────╯",
        ].join("\n"),
      );
      detector.start();

      vi.advanceTimersByTime(2100);
      expect(detector.state).toBe("idle");
      detector.stop();
    });

    it("falls back to recent boxed output only when the visible screen is empty", () => {
      const terminal = mockTerminal([]);
      const detector = new AgentStateDetector(terminal, () => false);
      detector.trackOutput(
        [
          "╭────────────────────────────────────────────────────────────╮",
          "│ What kind of question would you like me to ask?           │",
          "│ ❯ 1. Something thoughtful (Recommended)                   │",
          "│   2. Something fun                                        │",
          "│ ↑↓ to select · Enter to confirm · Esc to cancel           │",
          "╰────────────────────────────────────────────────────────────╯",
        ].join("\n"),
      );
      detector.start();

      vi.advanceTimersByTime(2100);
      expect(detector.state).toBe("waiting");
      detector.stop();
    });
  });

  describe("active indicator detection", () => {
    it("detects spinner with ellipsis as active", () => {
      const terminal = mockTerminal(["  some previous output", "  \u2733 Reading files\u2026"]);
      const detector = new AgentStateDetector(terminal, () => false);
      detector.start();

      vi.advanceTimersByTime(2100);
      expect(detector.state).toBe("active");
      detector.stop();
    });

    it("detects tool output with ellipsis as active", () => {
      const terminal = mockTerminal(["  some output", "  \u23bf  Running command\u2026"]);
      const detector = new AgentStateDetector(terminal, () => false);
      detector.start();

      vi.advanceTimersByTime(2100);
      expect(detector.state).toBe("active");
      detector.stop();
    });

    it("detects Copilot thinking spinner as active", () => {
      const terminal = mockTerminal(["  some output", "  \u25c9 Thinking (Esc to cancel)"]);
      const detector = new AgentStateDetector(terminal, () => false);
      detector.start();

      vi.advanceTimersByTime(2100);
      expect(detector.state).toBe("active");
      detector.stop();
    });

    it("detects Copilot custom intent with cancel hint as active", () => {
      const terminal = mockTerminal([
        "  some output",
        "  \u25ce Reading repository (Esc to cancel)",
      ]);
      const detector = new AgentStateDetector(terminal, () => false);
      detector.start();

      vi.advanceTimersByTime(2100);
      expect(detector.state).toBe("active");
      detector.stop();
    });

    it("does not detect Copilot cancel hint without intent text as active", () => {
      const terminal = mockTerminal(["  some output", "  \u25ce (Esc to cancel)"]);
      const detector = new AgentStateDetector(terminal, () => false);
      detector.start();

      vi.advanceTimersByTime(2100);
      expect(detector.state).toBe("idle");
      detector.stop();
    });

    it("detects Copilot executing status as active", () => {
      const terminal = mockTerminal(["  some output", "  \u25cb Executing"]);
      const detector = new AgentStateDetector(terminal, () => false);
      detector.start();

      vi.advanceTimersByTime(2100);
      expect(detector.state).toBe("active");
      detector.stop();
    });

    it("detects Copilot cancelling status as active", () => {
      const terminal = mockTerminal(["  some output", "  \u25cf Cancelling"]);
      const detector = new AgentStateDetector(terminal, () => false);
      detector.start();

      vi.advanceTimersByTime(2100);
      expect(detector.state).toBe("active");
      detector.stop();
    });

    it("detects spinner + ellipsis split across wrapped lines (narrow terminal)", () => {
      // On a 10-col terminal, "\u2733 Reading files\u2026" wraps to:
      // "\u2733 Reading" on one visual row and "files\u2026" on the next
      const terminal = mockTerminal([
        "  some output",
        "  \u2733 Readi", // spinner on first wrapped row
        "  ng files\u2026", // ellipsis on second wrapped row
      ]);
      const detector = new AgentStateDetector(terminal, () => false);
      detector.start();

      vi.advanceTimersByTime(2100);
      expect(detector.state).toBe("active");
      detector.stop();
    });

    it("detects wrapped Copilot thinking indicator as active", () => {
      const terminal = mockTerminal(["  some output", "  \u25c9 Thin", "  king (Esc to cancel)"]);
      const detector = new AgentStateDetector(terminal, () => false);
      detector.start();

      vi.advanceTimersByTime(2100);
      expect(detector.state).toBe("active");
      detector.stop();
    });

    it("detects wrapped Copilot custom intent as active", () => {
      const terminal = mockTerminal([
        "  some output",
        "  \u25ce Reading",
        "  repository (Esc to cancel \u00b7 1.2k)",
      ]);
      const detector = new AgentStateDetector(terminal, () => false);
      detector.start();

      vi.advanceTimersByTime(2100);
      expect(detector.state).toBe("active");
      detector.stop();
    });

    it("detects Copilot custom intent when cancel hint wraps mid-phrase", () => {
      const terminal = mockTerminal([
        "  some output",
        "  \u25ce Reading repository (Esc to",
        "  cancel \u00b7 1.2k)",
      ]);
      const detector = new AgentStateDetector(terminal, () => false);
      detector.start();

      vi.advanceTimersByTime(2100);
      expect(detector.state).toBe("active");
      detector.stop();
    });

    it("does not detect wrapped Copilot cancel hint without intent text as active", () => {
      const terminal = mockTerminal(["  some output", "  \u25ce", "  (Esc to cancel)"]);
      const detector = new AgentStateDetector(terminal, () => false);
      detector.start();

      vi.advanceTimersByTime(2100);
      expect(detector.state).toBe("idle");
      detector.stop();
    });

    it("does not detect active indicator beyond last 6 lines", () => {
      // Active indicator on line far from bottom should not trigger
      const lines: string[] = [];
      lines.push("  \u2733 Reading files\u2026"); // active indicator at top
      for (let i = 0; i < 20; i++) {
        lines.push("  normal output line " + i);
      }
      const terminal = mockTerminal(lines);
      const detector = new AgentStateDetector(terminal, () => false);
      detector.start();

      vi.advanceTimersByTime(2100);
      // Should be idle since the active indicator is far from the bottom
      expect(detector.state).toBe("idle");
      detector.stop();
    });
  });

  describe("screen-change-based active detection", () => {
    it("detects active state when screen content changes between polls (text streaming)", () => {
      const terminal = mutableMockTerminal(["  plain text line 1"]);
      const detector = new AgentStateDetector(terminal, () => false);
      detector.start();

      // First poll at 2000ms: sets the baseline fingerprint, no previous to compare
      vi.advanceTimersByTime(2100);
      // First poll after start has no previous fingerprint, falls through to idle
      expect(detector.state).toBe("idle");

      // Change the screen content (simulates Claude streaming text)
      terminal.setLines(["  plain text line 1", "  plain text line 2"]);
      // Second poll at 4000ms: detects screen changed
      vi.advanceTimersByTime(2000);
      expect(detector.state).toBe("active");
      detector.stop();
    });

    it("returns to idle when screen content stops changing", () => {
      const terminal = mutableMockTerminal(["  line 1"]);
      const detector = new AgentStateDetector(terminal, () => false);
      detector.start();

      // First poll: baseline
      vi.advanceTimersByTime(2100);

      // Change content
      terminal.setLines(["  line 1", "  line 2"]);
      vi.advanceTimersByTime(2000);
      expect(detector.state).toBe("active");

      // Content stops changing - next poll should go idle
      vi.advanceTimersByTime(2000);
      expect(detector.state).toBe("idle");
      detector.stop();
    });

    it("does not treat the first poll as a screen change", () => {
      const terminal = mutableMockTerminal(["  Ready for input"]);
      const detector = new AgentStateDetector(terminal, () => false);
      detector.start();

      vi.advanceTimersByTime(2100);
      // Should be idle, not active - first poll has no previous fingerprint
      expect(detector.state).toBe("idle");
      detector.stop();
    });

    it("screen change detection respects suppression grace period", () => {
      const terminal = mutableMockTerminal(["  line 1"]);
      const detector = new AgentStateDetector(terminal, () => false);
      detector.start(true); // suppressActive

      // First poll: baseline (within suppression)
      vi.advanceTimersByTime(100);
      expect(detector.state).toBe("idle");

      // Still within suppression window - change content
      terminal.setLines(["  line 1", "  line 2"]);
      vi.advanceTimersByTime(1900); // now at 2000ms total, first interval fires
      // Suppression ends at ~2000ms, so first check is right at boundary
      // Either way it should not be active during suppression
      expect(detector.state).toBe("idle");
      detector.stop();
    });

    it("waiting state takes priority over screen changes", () => {
      const terminal = mutableMockTerminal(["  plain text"]);
      const detector = new AgentStateDetector(terminal, () => false);
      detector.start();

      // First poll: baseline
      vi.advanceTimersByTime(2100);

      // Change screen to show a waiting prompt
      terminal.setLines(["  Allow this action?", "  allowOnce  denyOnce"]);
      vi.advanceTimersByTime(2000);
      expect(detector.state).toBe("waiting");
      detector.stop();
    });

    it("resetScreenFingerprint prevents false active after tab/item switch", () => {
      const terminal = mutableMockTerminal(["  line 1"]);
      const detector = new AgentStateDetector(terminal, () => false);
      detector.start();

      // First poll: baseline
      vi.advanceTimersByTime(2100);
      expect(detector.state).toBe("idle");

      // Simulate a tab switch: content changes completely (different terminal)
      terminal.setLines(["  completely different content from another tab"]);

      // Reset fingerprint before the next poll (as TabManager would do)
      detector.resetScreenFingerprint();

      // Next poll: should treat this as a new baseline, not a change
      vi.advanceTimersByTime(2000);
      expect(detector.state).toBe("idle");
      detector.stop();
    });
  });

  describe("active suppression during grace period", () => {
    it("treats active as idle during suppression", () => {
      const terminal = mockTerminal(["  \u2733 Reading files\u2026"]);
      const detector = new AgentStateDetector(terminal, () => false);
      detector.start(true); // suppressActive = true

      // First check fires at 2000ms. _suppressActiveUntil = start + 2000.
      // At exactly 2000ms, Date.now() == _suppressActiveUntil so the check
      // `Date.now() < _suppressActiveUntil` is false. We need to be under 2s.
      // Advance to 1999ms so the first interval hasn't fired yet, then to 1ms
      // more so it fires within the window.
      // Actually, the interval fires at exactly 2000ms. We need a check that
      // fires BEFORE 2000ms. Use a shorter initial advance.
      vi.advanceTimersByTime(100);
      // state was set to "idle" by start(true), no interval fired yet
      expect(detector.state).toBe("idle");
      detector.stop();
    });

    it("allows active after suppression period expires", () => {
      const terminal = mockTerminal(["  \u2733 Reading files\u2026"]);
      const detector = new AgentStateDetector(terminal, () => false);
      detector.start(true);

      // Advance past the 2s suppression + enough intervals
      vi.advanceTimersByTime(4100);
      expect(detector.state).toBe("active");
      detector.stop();
    });
  });

  describe("clean screen -> idle", () => {
    it("returns idle when screen has no active indicators", () => {
      const terminal = mockTerminal(["  > some prompt", "  Ready for input"]);
      const detector = new AgentStateDetector(terminal, () => false);
      detector.start();

      vi.advanceTimersByTime(2100);
      expect(detector.state).toBe("idle");
      detector.stop();
    });
  });

  describe("clearWaiting", () => {
    it("transitions from waiting to idle", () => {
      const terminal = mockTerminal(["  Enter to select"]);
      const detector = new AgentStateDetector(terminal, () => false);
      detector.start();

      vi.advanceTimersByTime(2100);
      expect(detector.state).toBe("waiting");

      detector.clearWaiting();
      expect(detector.state).toBe("idle");
      detector.stop();
    });
  });

  describe("stop", () => {
    it("stops the timer without error", () => {
      const terminal = mockTerminal(["test"]);
      const detector = new AgentStateDetector(terminal, () => false);
      detector.start();
      detector.stop();
      // No error thrown, timer cleared
    });
  });

  describe("onChange callback", () => {
    it("fires on state transitions", () => {
      const terminal = mockTerminal(["  Enter to select"]);
      const detector = new AgentStateDetector(terminal, () => false);
      const changes: AgentState[] = [];
      detector.onChange = (s) => changes.push(s);
      detector.start(); // starts as "active"

      vi.advanceTimersByTime(2100);
      // Should have transitioned from active -> waiting
      expect(changes).toContain("waiting");
      detector.stop();
    });
  });
});

describe("aggregateState", () => {
  it("returns waiting if any state is waiting", () => {
    expect(aggregateState(["idle", "waiting", "active"])).toBe("waiting");
  });

  it("returns active if any state is active (no waiting)", () => {
    expect(aggregateState(["idle", "active", "idle"])).toBe("active");
  });

  it("returns idle if any state is idle (no waiting/active)", () => {
    expect(aggregateState(["inactive", "idle", "inactive"])).toBe("idle");
  });

  it("returns inactive for all inactive", () => {
    expect(aggregateState(["inactive", "inactive"])).toBe("inactive");
  });

  it("returns inactive for empty array", () => {
    expect(aggregateState([])).toBe("inactive");
  });

  it("waiting takes priority over everything", () => {
    expect(aggregateState(["waiting"])).toBe("waiting");
    expect(aggregateState(["active", "waiting"])).toBe("waiting");
    expect(aggregateState(["idle", "inactive", "waiting"])).toBe("waiting");
  });
});
