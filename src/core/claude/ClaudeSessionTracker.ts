/**
 * Monitor for session ID changes when a user does /resume inside Claude.
 *
 * Continuously polls ~/.work-terminal/events/ for hook event files matching
 * this session's ID. When a SessionEnd event appears for our session, pairs
 * it with the closest SessionStart event to discover the new session ID.
 *
 * Input detection of "/resume" is NOT reliable because Claude CLI handles
 * slash commands via an internal autocomplete UI - the characters never
 * flow through terminal.onData(). Instead we poll unconditionally.
 */
import { expandTilde } from "../utils";
import { readResumeEvent, cleanupStaleEvents } from "./ClaudeHookManager";

const POLL_INTERVAL_MS = 2000;

export class ClaudeSessionTracker {
  private _sessionId: string;
  private _pollTimer: ReturnType<typeof setInterval> | null = null;
  private _disposed = false;

  /** Callback fired when the session ID changes after a /resume. */
  onSessionChange?: (newId: string) => void;

  constructor(_cwd: string, initialSessionId: string) {
    this._sessionId = initialSessionId;
    this._startPolling();
  }

  get sessionId(): string {
    return this._sessionId;
  }

  /** Feed terminal stdin data. Kept for interface compatibility but no longer used for detection. */
  feedInput(_data: string): void {
    // No-op: /resume is handled via Claude's autocomplete UI, not raw keystrokes
  }

  /** Clean up polling timer. */
  dispose(): void {
    this._disposed = true;
    this._stopPolling();
  }

  private _startPolling(): void {
    this._pollTimer = setInterval(() => this._pollForHookEvent(), POLL_INTERVAL_MS);
  }

  private _stopPolling(): void {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  private _pollForHookEvent(): void {
    if (this._disposed) return;

    const result = readResumeEvent(this._sessionId);
    if (result) {
      const newId = result.newSessionId;
      this._sessionId = newId;

      // Clean up consumed event files
      cleanupStaleEvents();

      console.log("[ClaudeSessionTracker] Session ID changed:", newId);
      this.onSessionChange?.(newId);
    }
  }
}
