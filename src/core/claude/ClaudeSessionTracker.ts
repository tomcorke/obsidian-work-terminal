/**
 * Detect `/resume` commands in terminal input and monitor for session ID changes.
 *
 * Two detection strategies:
 * 1. Primary (hooks): poll ~/.work-terminal/events/ for end/resume event files
 * 2. Fallback (mtime): scan .jsonl session files if hooks don't fire within 30s
 */
import { electronRequire, expandTilde } from "../utils";
import { readResumeEvent, cleanupStaleEvents } from "./ClaudeHookManager";

const fs = electronRequire("fs") as typeof import("fs");
const path = electronRequire("path") as typeof import("path");

const POLL_INTERVAL_MS = 2000;
const HOOK_TIMEOUT_MS = 30000;

export class ClaudeSessionTracker {
  private _sessionId: string;
  private _cwd: string;
  private _inputBuffer = "";
  private _pendingResume = false;
  private _pollTimer: ReturnType<typeof setInterval> | null = null;
  private _fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private _disposed = false;

  /** Callback fired when the session ID changes after a /resume. */
  onSessionChange?: (newId: string) => void;

  constructor(cwd: string, initialSessionId: string) {
    this._cwd = cwd;
    this._sessionId = initialSessionId;
  }

  get sessionId(): string {
    return this._sessionId;
  }

  /**
   * Feed terminal stdin data for /resume detection.
   * Terminal sends individual keystrokes via onData, so we buffer
   * character-by-character and detect line completion on \r or \n.
   */
  feedInput(data: string): void {
    for (const ch of data) {
      if (ch === "\r" || ch === "\n") {
        this._processLine(this._inputBuffer);
        this._inputBuffer = "";
      } else if (ch === "\x7f" || ch === "\b") {
        // Backspace - remove last character from buffer
        this._inputBuffer = this._inputBuffer.slice(0, -1);
      } else if (ch.charCodeAt(0) >= 32) {
        // Printable characters only
        this._inputBuffer += ch;
      }
    }
  }

  /** Clean up all timers and watchers. */
  dispose(): void {
    this._disposed = true;
    this._stopPolling();
  }

  private _processLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed === "/resume") {
      this._pendingResume = true;
      this._startMonitoring();
    }
  }

  private _startMonitoring(): void {
    // Reset any existing monitoring (handles multiple /resume in sequence)
    this._stopPolling();

    this._pendingResume = true;

    // Start polling for hook events
    this._pollTimer = setInterval(() => this._pollForHookEvent(), POLL_INTERVAL_MS);

    // Set up fallback timeout
    this._fallbackTimer = setTimeout(() => {
      if (this._pendingResume && !this._disposed) {
        this._attemptMtimeFallback();
      }
    }, HOOK_TIMEOUT_MS);
  }

  private _stopPolling(): void {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    if (this._fallbackTimer) {
      clearTimeout(this._fallbackTimer);
      this._fallbackTimer = null;
    }
    this._pendingResume = false;
  }

  private _pollForHookEvent(): void {
    if (this._disposed || !this._pendingResume) return;

    const eventsDir = expandTilde("~/.work-terminal/events");
    const endFile = path.join(eventsDir, `${this._sessionId}-end.json`);

    try {
      if (!fs.existsSync(endFile)) return;
    } catch {
      return;
    }

    // Found the end event - read the resume event for the new session ID
    const result = readResumeEvent(this._sessionId);
    if (result) {
      this._sessionId = result.newSessionId;
      this._stopPolling();

      // Clean up consumed event files
      cleanupStaleEvents();

      this.onSessionChange?.(result.newSessionId);
    }
  }

  /**
   * Fallback: scan .jsonl files to find the new session by mtime.
   * Used when hook events don't appear within the timeout.
   */
  private _attemptMtimeFallback(): void {
    if (this._disposed || !this._pendingResume) return;

    const cwdKey = this._cwd.replace(/\//g, "-");
    const projectDir = expandTilde(`~/.claude/projects/${cwdKey}`);

    let files: string[];
    try {
      files = fs.readdirSync(projectDir).filter((f: string) => f.endsWith(".jsonl"));
    } catch {
      console.warn(
        "[ClaudeSessionTracker] Could not read project dir for mtime fallback:",
        projectDir,
      );
      this._stopPolling();
      return;
    }

    // Find candidates: recently modified .jsonl files that aren't the current session
    const candidates: { name: string; mtime: number }[] = [];
    const now = Date.now();

    for (const file of files) {
      try {
        const stat = fs.statSync(path.join(projectDir, file));
        const age = now - stat.mtimeMs;
        // Only consider files modified in the last 60s and not the current session
        if (age < 60000 && !file.includes(this._sessionId)) {
          candidates.push({ name: file, mtime: stat.mtimeMs });
        }
      } catch {
        // Skip unreadable files
      }
    }

    if (candidates.length === 1) {
      // Unambiguous - extract session ID from filename
      const newId = candidates[0].name.replace(/\.jsonl$/, "");
      this._sessionId = newId;
      this._stopPolling();
      console.warn("[ClaudeSessionTracker] Session change detected via mtime fallback:", newId);
      this.onSessionChange?.(newId);
    } else if (candidates.length > 1) {
      console.warn(
        "[ClaudeSessionTracker] Ambiguous mtime fallback - multiple candidates:",
        candidates.map((c) => c.name),
      );
      this._stopPolling();
    } else {
      // No candidates - /resume may have been cancelled (Ctrl+C)
      this._stopPolling();
    }
  }
}
