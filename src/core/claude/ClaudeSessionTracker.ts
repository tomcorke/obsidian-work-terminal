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
 *
 * Safety: all poll callbacks are wrapped in try/catch to prevent orphan
 * intervals. Consecutive errors stop polling to avoid log spam. dispose()
 * is idempotent and always clears the timer.
 */
import { readResumeEvent, cleanupStaleEvents } from "./ClaudeHookManager";

const POLL_INTERVAL_MS = 2000;
/** Stop polling after this many consecutive errors to avoid log spam. */
const MAX_CONSECUTIVE_ERRORS = 5;

export class ClaudeSessionTracker {
  private _sessionId: string;
  private _pollTimer: ReturnType<typeof setInterval> | null = null;
  private _disposed = false;
  private _consecutiveErrors = 0;

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

  /** Clean up polling timer. Idempotent - safe to call multiple times. */
  dispose(): void {
    this._disposed = true;
    this._stopPolling();
  }

  private _startPolling(): void {
    this._stopPolling(); // Ensure no duplicate timers
    this._pollTimer = setInterval(() => this._safePoll(), POLL_INTERVAL_MS);
  }

  private _stopPolling(): void {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  /** Wrapped poll that catches all errors to prevent orphan intervals. */
  private _safePoll(): void {
    if (this._disposed) {
      this._stopPolling();
      return;
    }

    try {
      this._pollForHookEvent();
      this._consecutiveErrors = 0;
    } catch (err) {
      this._consecutiveErrors++;
      console.warn("[ClaudeSessionTracker] Poll error:", err);
      if (this._consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        console.warn("[ClaudeSessionTracker] Too many errors, stopping poll");
        this._stopPolling();
      }
    }
  }

  private _pollForHookEvent(): void {
    const result = readResumeEvent(this._sessionId);
    if (!result) return;

    const newId = result.newSessionId;
    this._sessionId = newId;

    // Clean up consumed event files (best-effort, don't let failure block the update)
    try {
      cleanupStaleEvents();
    } catch {
      // Stale files will be cleaned on next successful poll
    }

    console.log("[ClaudeSessionTracker] Session ID changed:", newId);

    // Fire callback - catch errors so tracker state stays consistent
    try {
      this.onSessionChange?.(newId);
    } catch (err) {
      console.warn("[ClaudeSessionTracker] onSessionChange callback error:", err);
    }
  }
}
