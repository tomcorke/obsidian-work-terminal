/**
 * Detect Copilot session IDs from log files after a fresh context launch.
 *
 * When a Copilot session is launched with `-i <prompt>` (without `--resume`),
 * the session ID is not known at spawn time. Copilot writes its session ID to
 * a log file at `~/.copilot/logs/process-<epoch_ms>-<pid>.log` shortly after
 * starting. This detector polls for new log files created after the spawn time,
 * searches them for the session UUID pattern, and fires a callback when found.
 *
 * The detector is intentionally standalone so it can be unit-tested without
 * pulling in TerminalTab or the full agent framework.
 */
import { expandTilde, electronRequire } from "../utils";

const POLL_INTERVAL_MS = 1000;
const MAX_POLL_ATTEMPTS = 15; // Give up after ~15s
const MAX_CONSECUTIVE_ERRORS = 3;

export interface CopilotSessionDetectorDeps {
  fs?: typeof import("fs");
  pathModule?: typeof import("path");
}

export interface CopilotSessionDetectorOptions {
  /** Directory containing Copilot log files. */
  logDir: string;
  /** Regex pattern with a capture group to extract the session UUID. */
  logPattern: string;
  /** Timestamp (ms) of the PTY spawn - only log files newer than this are considered. */
  spawnTime: number;
  /** Injected dependencies for testing. */
  deps?: CopilotSessionDetectorDeps;
}

export class CopilotSessionDetector {
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _disposed = false;
  private _attempts = 0;
  private _consecutiveErrors = 0;
  private _logDir: string;
  private _logPattern: RegExp;
  private _spawnTime: number;
  private _fs: typeof import("fs");
  private _path: typeof import("path");

  /** Callback fired when a session ID is detected. */
  onSessionDetected?: (sessionId: string) => void;

  constructor(options: CopilotSessionDetectorOptions) {
    this._logDir = expandTilde(options.logDir);
    this._logPattern = new RegExp(options.logPattern);
    this._spawnTime = options.spawnTime;
    this._fs = options.deps?.fs ?? (electronRequire("fs") as typeof import("fs"));
    this._path = options.deps?.pathModule ?? (electronRequire("path") as typeof import("path"));
  }

  /** Start polling for the session ID in Copilot log files. */
  start(): void {
    if (this._disposed) return;
    this._timer = setInterval(() => this._safePoll(), POLL_INTERVAL_MS);
    // Run once immediately
    this._safePoll();
  }

  /** Stop polling. Idempotent. */
  dispose(): void {
    this._disposed = true;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  private _safePoll(): void {
    if (this._disposed) {
      this.dispose();
      return;
    }
    this._attempts++;
    if (this._attempts > MAX_POLL_ATTEMPTS) {
      console.warn("[CopilotSessionDetector] Max attempts reached, giving up");
      this.dispose();
      return;
    }
    try {
      this._poll();
      this._consecutiveErrors = 0;
    } catch (err) {
      this._consecutiveErrors++;
      console.warn("[CopilotSessionDetector] Poll error:", err);
      if (this._consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        console.warn("[CopilotSessionDetector] Too many errors, stopping");
        this.dispose();
      }
    }
  }

  private _poll(): void {
    if (!this._fs.existsSync(this._logDir)) return;

    // Find log files modified after spawn time, caching mtime for sort
    const mtimeCache = new Map<string, number>();
    const files = this._fs.readdirSync(this._logDir).filter((name) => {
      if (!name.startsWith("process-") || !name.endsWith(".log")) return false;
      try {
        const stat = this._fs.statSync(this._path.join(this._logDir, name));
        // Use mtime with a small buffer (500ms) for filesystem granularity
        if (stat.mtimeMs >= this._spawnTime - 500) {
          mtimeCache.set(name, stat.mtimeMs);
          return true;
        }
        return false;
      } catch {
        return false;
      }
    });

    // Sort by modification time descending (newest first) using cached values
    files.sort((a, b) => (mtimeCache.get(b) ?? 0) - (mtimeCache.get(a) ?? 0));

    for (const file of files) {
      try {
        const content = this._fs.readFileSync(this._path.join(this._logDir, file), "utf8");
        const match = this._logPattern.exec(content);
        if (match?.[1]) {
          const sessionId = match[1];
          console.log("[CopilotSessionDetector] Detected session ID:", sessionId, "from", file);
          this.dispose();
          try {
            this.onSessionDetected?.(sessionId);
          } catch (err) {
            console.warn("[CopilotSessionDetector] onSessionDetected callback error:", err);
          }
          return;
        }
      } catch (err) {
        // File may have been deleted between readdirSync and readFileSync - skip it
        console.warn("[CopilotSessionDetector] Skipping unreadable file:", file, err);
      }
    }
  }
}
