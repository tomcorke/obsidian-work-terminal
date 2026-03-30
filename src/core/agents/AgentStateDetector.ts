/**
 * Standalone agent state detection from xterm.js terminal buffer.
 *
 * Reads the terminal screen buffer directly to determine interactive agent state,
 * avoiding the fundamental problem of classifying raw stdout (status line
 * redraws produce continuous output even when idle).
 */
import type { Terminal } from "@xterm/xterm";
import { stripAnsi } from "../utils";

export type AgentState = "inactive" | "active" | "idle" | "waiting";
export type ClaudeState = AgentState;

function normalizeWaitingLine(line: string): string {
  return line
    .replace(/[│┃║╭╮╰╯─═]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const GENERIC_WAITING_QUESTION_WINDOW = 5;
const HIDDEN_CLAUDE_QUESTION_WINDOW = 10;
const HIDDEN_CLAUDE_PROMPT_CHROME_SCAN_LINES = 6;

function looksLikeHiddenClaudePrompt(tail: string[], questionIndex: number): boolean {
  const normalizedQuestion = normalizeWaitingLine(tail[questionIndex]);
  if (
    questionIndex < tail.length - HIDDEN_CLAUDE_QUESTION_WINDOW ||
    !normalizedQuestion.endsWith("?") ||
    normalizedQuestion.length <= 10
  ) {
    return false;
  }

  const normalizedAfterQuestion = tail
    .slice(
      questionIndex + 1,
      Math.min(
        tail.length,
        questionIndex + 1 + HIDDEN_CLAUDE_PROMPT_CHROME_SCAN_LINES,
      ),
    )
    .map((line) => normalizeWaitingLine(line))
    .filter((line) => line.length > 0);
  const promptIndex = normalizedAfterQuestion.findIndex((line) => line === "❯");
  if (promptIndex === -1) return false;
  if (
    normalizedAfterQuestion
      .slice(0, promptIndex)
      .some((line) => /^❯\s+\S/.test(line))
  ) {
    return false;
  }

  return normalizedAfterQuestion
    .slice(promptIndex + 1)
    .some((line) => /^➜\s+\S/.test(line) || /^⏵⏵/.test(line));
}

function findLastWaitingLineIndex(lines: string[]): number {
  if (lines.length === 0) return -1;

  const tailStart = Math.max(0, lines.length - 20);
  const tail = lines.slice(tailStart);

  for (let i = tail.length - 1; i >= Math.max(0, tail.length - 15); i--) {
    const normalizedLine = normalizeWaitingLine(tail[i]);
    if (!normalizedLine) continue;

    if (/Enter to (?:select|confirm)|to navigate/i.test(normalizedLine)) return tailStart + i;

    if (/\bAllow\b.*\?/i.test(normalizedLine)) return tailStart + i;
    if (/\ballowOnce\b|\bdenyOnce\b|\ballowAlways\b/i.test(normalizedLine)) return tailStart + i;

    if (/^\s*[>\u276f]\s*\d+\.\s+\S/.test(normalizedLine)) return tailStart + i;
    if (/^\s*\(?\d+\)?\s+\S/.test(normalizedLine) && i > 0) {
      for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
        const normalizedPreviousLine = normalizeWaitingLine(tail[j]);
        if (normalizedPreviousLine.endsWith("?")) return tailStart + i;
      }
    }

    if (looksLikeHiddenClaudePrompt(tail, i)) return tailStart + i;

    if (
      i >= tail.length - GENERIC_WAITING_QUESTION_WINDOW &&
      normalizedLine.endsWith("?") &&
      normalizedLine.length > 10
    ) {
      return tailStart + i;
    }

    if (/^\s*(Yes|No)\s*$/i.test(normalizedLine)) return tailStart + i;
  }

  return -1;
}

export function hasAgentWaitingIndicator(
  screenLines: string[] = [],
  recentCleanLines: string[] = [],
): boolean {
  const waitingIndex = findLastWaitingLineIndex(screenLines);
  if (waitingIndex !== -1) {
    if (hasAgentActiveIndicator(screenLines.slice(waitingIndex + 1))) return false;
    return true;
  }
  if (screenLines.length > 0) return false;
  return findLastWaitingLineIndex(recentCleanLines.slice(-15)) !== -1;
}

export class AgentStateDetector {
  private _state: AgentState = "inactive";
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _suppressActiveUntil = 0;
  private _recentCleanLines: string[] = [];
  onChange?: (state: AgentState) => void;

  constructor(
    private terminal: Terminal,
    private isVisible: () => boolean,
  ) {}

  get state(): AgentState {
    return this._state;
  }

  /**
   * Start periodic state checking.
   * @param suppressActive If true, suppress "active" detection for 2s (used after reload).
   */
  start(suppressActive = false): void {
    this._state = suppressActive ? "idle" : "active";
    if (suppressActive) this._suppressActiveUntil = Date.now() + 2000;
    this._timer = setInterval(() => this._check(), 2000);
  }

  stop(): void {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Track output data for pattern matching. Call on each chunk of stdout/stderr.
   * Buffers recent clean lines (last 30) for waiting-state detection.
   */
  trackOutput(data: Buffer | string): void {
    const text = typeof data === "string" ? data : data.toString("utf8");
    const lines = stripAnsi(text)
      .split(/\r\n|\n|\r/)
      .filter((l) => l.trim().length > 0);

    this._recentCleanLines.push(...lines);
    if (this._recentCleanLines.length > 30) {
      this._recentCleanLines = this._recentCleanLines.slice(-30);
    }
  }

  /**
   * Read the visible terminal screen content for state detection.
   * Uses xterm.js buffer API to get the actual rendered lines, which is
   * far more reliable than trying to classify raw stdout chunks.
   */
  private _readScreen(): string[] {
    const buf = this.terminal.buffer.active;
    const lines: string[] = [];
    // The cursor position (baseY + cursorY) marks where content ends; rows below
    // are empty padding. Reading from the bottom of buf.length would miss
    // everything when the terminal is taller than the content.
    const contentEnd = buf.baseY + buf.cursorY + 2;
    const start = Math.max(0, contentEnd - 30);
    for (let i = start; i < contentEnd; i++) {
      const line = buf.getLine(i);
      if (line) {
        const text = line.translateToString(true).trim();
        if (text.length > 0) lines.push(text);
      }
    }
    return lines;
  }

  private _check(): void {
    // Read the terminal screen directly to determine the agent state.
    const screenLines = this._readScreen();

    // Check for waiting patterns first (highest priority).
    // Suppress waiting if the tab is currently visible - the user can already see it.
    if (this._looksLikeWaiting(screenLines)) {
      this._setState(this.isVisible() ? "idle" : "waiting");
      return;
    }

    // Need screen content for idle/active detection
    if (screenLines.length === 0) return;

    const hasActiveIndicator = hasAgentActiveIndicator(screenLines);

    if (hasActiveIndicator) {
      // During post-reload grace period, treat "active" as "idle"
      if (Date.now() < this._suppressActiveUntil) {
        this._setState("idle");
      } else {
        this._setState("active");
      }
    } else {
      // Real output clears the suppression early
      this._suppressActiveUntil = 0;
      this._setState("idle");
    }
  }

  /**
   * Check if the agent is waiting for user input by inspecting both the terminal
   * screen buffer and recent output lines. The screen buffer is the primary
   * source since it shows the current rendered state.
   */
  private _looksLikeWaiting(screenLines?: string[]): boolean {
    return hasAgentWaitingIndicator(screenLines || [], this._recentCleanLines || []);
  }

  /** Clear the waiting state (e.g. when the user activates this tab). */
  clearWaiting(): void {
    if (this._state === "waiting") {
      this._setState("idle");
    }
  }

  private _setState(s: AgentState): void {
    if (this._state === s) return;
    this._state = s;
    this.onChange?.(s);
  }
}

/**
 * Aggregate multiple agent states into a single state.
 * Priority: waiting > active > idle > inactive.
 */
export function aggregateState(states: AgentState[]): AgentState {
  for (const s of states) {
    if (s === "waiting") return "waiting";
  }
  for (const s of states) {
    if (s === "active") return "active";
  }
  for (const s of states) {
    if (s === "idle") return "idle";
  }
  return "inactive";
}

/**
 * Detect whether the visible terminal tail shows an in-progress agent status.
 * Supports Claude's ellipsis-based spinner/tool rows and Copilot's rotating
 * Thinking indicator.
 */
export function hasAgentActiveIndicator(screenLines: string[]): boolean {
  // Look for structural indicators in the last few lines only (near the status bar).
  //   \u2733 <text>... - Claude spinner line with ellipsis means work in progress
  //   \u23bf  <text>... - Claude tool output with ellipsis means tool still running
  //   \u25c9/\u25ce/\u25cb/\u25cf <status> (Esc to cancel) - Copilot activity indicator
  //   \u25c9/\u25ce/\u25cb/\u25cf Executing|Cancelling - Copilot fixed activity labels
  // On narrow terminals these status lines can wrap across multiple visual
  // rows, so we check both per-line and joined tail strings.
  const tail = screenLines.slice(-6);
  const tailJoined = tail.join(" ");
  const tailCompactJoined = tail.map((line) => line.trim()).join("");
  const copilotSpinnerRowPattern = /^\s*[\u25c9\u25ce\u25cb\u25cf]\s+(?!\(Esc\b)\S/;
  const copilotKnownStatusPattern = /\b(?:Thinking|Executing|Cancelling)\b/;
  const copilotCancelHintPattern = /\(Esc\s+to\s+cancel(?:\s+\u00b7\s+[^)]*)?\)/;
  const hasClaudeActiveIndicator =
    tail.some(
      (line) =>
        /^\s*\u2733.*\u2026/.test(line) || // spinner with ellipsis = in progress
        /^\s*\u23bf\s+.*\u2026/.test(line), // tool output with ellipsis = running
    ) ||
    // Wrapped lines: spinner char on one visual row, ellipsis on another
    (/\u2733/.test(tailJoined) &&
      /\u2026/.test(tailJoined) &&
      tail.some((line) => /^\s*\u2733/.test(line)));
  const hasCopilotActiveIndicator =
    tail.some(
      (line) =>
        /^\s*[\u25c9\u25ce\u25cb\u25cf]\s+(?:Thinking|Executing|Cancelling)\b/.test(line) ||
        (copilotSpinnerRowPattern.test(line) && copilotCancelHintPattern.test(line)),
    ) ||
    (tail.some((line) => copilotSpinnerRowPattern.test(line)) &&
      (copilotKnownStatusPattern.test(tailCompactJoined) ||
        copilotCancelHintPattern.test(tailJoined) ||
        copilotCancelHintPattern.test(tailCompactJoined)));
  return hasClaudeActiveIndicator || hasCopilotActiveIndicator;
}

export { AgentStateDetector as ClaudeStateDetector };
