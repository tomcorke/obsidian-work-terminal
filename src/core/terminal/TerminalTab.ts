/**
 * TerminalTab - xterm.js terminal + Python PTY wrapper spawn.
 *
 * Each tab owns a Terminal instance, FitAddon, ResizeObserver, PTY child process,
 * and Claude state detection. Supports stash/restore for hot-reload persistence.
 */
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { ChildProcess } from "child_process";
import { StringDecoder } from "string_decoder";
import { expandTilde, stripAnsi, electronRequire } from "../utils";
import { injectXtermCss } from "./XtermCss";
import { attachScrollButton } from "./ScrollButton";
import { attachBubbleCapture, attachCapturePhase } from "./KeyboardCapture";
import type { StoredSession, SessionType } from "../session/types";

export type ClaudeState = "inactive" | "active" | "idle" | "waiting";

let sessionCounter = 0;

export class TerminalTab {
  id: string;
  label: string;
  taskPath: string | null;
  claudeSessionId: string | null = null;
  sessionType: SessionType;

  terminal: Terminal;
  containerEl: HTMLElement;
  process: ChildProcess | null = null;

  onOutputData?: (data: Buffer | string) => void;
  onLabelChange?: () => void;
  onProcessExit?: (code: number | null, signal: string | null) => void;
  onStateChange?: (state: ClaudeState) => void;

  private fitAddon: FitAddon;
  private resizeObserver: ResizeObserver;
  private _documentCleanups: (() => void)[] = [];
  private _resizeDebounce: ReturnType<typeof setTimeout> | null = null;

  // Minimum container width for fitAddon.fit(). When the plugin view is
  // momentarily narrow (e.g. switching between plugins), skip the fit so the
  // terminal keeps its last good dimensions and content doesn't reflow.
  private static MIN_FIT_WIDTH = 200;
  private cwd: string = "";
  private spawnTime = 0;

  // Claude state detection
  private _claudeState: ClaudeState = "inactive";
  private _recentCleanLines: string[] = [];
  private _stateTimer: ReturnType<typeof setInterval> | null = null;
  private _isClaudeSession = false;
  /** Suppress "active" detection until this timestamp (ms). Used after reload
   *  to prevent stale xterm buffer content from triggering false active state. */
  _suppressActiveUntil = 0;

  // Rename detection
  private _renameDecoder = new StringDecoder("utf8");
  private _renameLineBuffer = "";
  private _renamePattern = /^\s*[^\w]*Session renamed to:\s*(.+?)\s*$/;
  /** Optional hook for adapters to transform detected rename labels. */
  transformLabel?: (oldLabel: string, detected: string) => string;

  constructor(
    parentEl: HTMLElement,
    private shell: string,
    cwd: string,
    label: string,
    taskPath: string | null,
    sessionType: SessionType,
    preCommand?: string,
    private commandArgs?: string[],
    claudeSessionId?: string | null
  ) {
    this.claudeSessionId = claudeSessionId || null;
    this.taskPath = taskPath;
    this.label = label;
    this.sessionType = sessionType;

    // Expand ~ in cwd
    this.cwd = expandTilde(cwd);
    if (!this.cwd.startsWith("/")) {
      const home = process.env.HOME || process.env.USERPROFILE || "";
      if (home) this.cwd = home + "/" + this.cwd;
    }

    injectXtermCss();

    this.id = `term-${Date.now()}-${++sessionCounter}`;

    this.containerEl = document.createElement("div");
    this.containerEl.addClass("wt-terminal-instance");
    parentEl.appendChild(this.containerEl);

    this.terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "Menlo, Monaco, 'Courier New', monospace",
      macOptionIsMeta: true,
      theme: {
        background: "#1e1e1e",
        foreground: "#d4d4d4",
        cursor: "#d4d4d4",
        selectionBackground: "#264f78",
      },
      allowProposedApi: true,
    });

    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.open(this.containerEl);

    // Scroll-to-bottom button
    attachScrollButton(this.containerEl, this.terminal);

    // Keyboard capture - two layers
    attachBubbleCapture(this.containerEl);
    const captureCleanup = attachCapturePhase(
      this.containerEl,
      () => this.process
    );
    this._documentCleanups.push(captureCleanup);

    // Ensure clicking the terminal area gives xterm focus
    this.containerEl.addEventListener("click", () => {
      this.terminal.focus();
    });

    // commandArgs takes precedence over preCommand (which is a single string)
    const command = this.commandArgs || (preCommand ? [preCommand] : undefined);
    let spawned = false;

    const spawnWithFit = () => {
      this.safeFit();
      if (spawned) return;
      spawned = true;

      const cols = this.terminal.cols || 80;
      const rows = this.terminal.rows || 24;
      try {
        this.spawnTime = Date.now();
        const proc = this.spawnPty(cols, rows, command);
        console.log("[work-terminal] Spawned pid:", proc.pid, "cols:", cols, "rows:", rows);
        this.process = proc;
        this.wireProcess(proc);
        this.startStateTracking();
        this.terminal.scrollToBottom();
      } catch (err) {
        console.error("[work-terminal] Failed to spawn:", err);
        this.terminal.write(`\r\n[Failed to spawn: ${err}]\r\n`);
      }
    };

    // Delay spawn to let CSS layout happen first
    setTimeout(spawnWithFit, 150);

    // Send resize control sequence to PTY wrapper on terminal resize
    this.terminal.onResize(({ cols, rows }) => {
      if (this.process?.stdin && !this.process.stdin.destroyed) {
        // Custom OSC sequence that pty-wrapper.py intercepts
        const resizeCmd = `\x1b]777;resize;${cols};${rows}\x07`;
        this.process.stdin.write(resizeCmd);
      }
    });

    // Resize observer - debounced to avoid fitting during tab transition
    // animations where the container has intermediate (narrow) widths.
    this.resizeObserver = new ResizeObserver(() => {
      if (this.containerEl.hasClass("hidden")) return;
      if (this._resizeDebounce) clearTimeout(this._resizeDebounce);
      this._resizeDebounce = setTimeout(() => {
        if (this.containerEl.hasClass("hidden")) return;
        const prevCols = this.terminal.cols;
        this.safeFit();
        // If columns changed, scroll to bottom to prevent losing position
        if (this.terminal.cols !== prevCols) {
          this.terminal.scrollToBottom();
        }
      }, 100);
    });
    this.resizeObserver.observe(this.containerEl);
  }

  // ---------------------------------------------------------------------------
  // Process wiring
  // ---------------------------------------------------------------------------

  private wireProcess(proc: ChildProcess): void {
    this.terminal.onData((data) => {
      if (proc.stdin && !proc.stdin.destroyed) {
        proc.stdin.write(data);
      }
    });

    proc.stdout?.on("data", (data: Buffer) => {
      this._checkRename(data);
      this._trackOutput(data);
      this.onOutputData?.(data);
      this.terminal.write(data);
    });

    proc.stderr?.on("data", (data: Buffer) => {
      this._checkRename(data);
      this._trackOutput(data);
      this.onOutputData?.(data);
      this.terminal.write(data);
    });

    proc.on("error", (err) => {
      console.error("[work-terminal] Process error:", err);
      this.terminal.write(`\r\n[Process error: ${err.message}]\r\n`);
    });

    proc.on("exit", (code, signal) => {
      this.terminal.write(`\r\n[Process exited (code: ${code}, signal: ${signal})]\r\n`);
      this.onProcessExit?.(code, signal);
    });
  }

  // ---------------------------------------------------------------------------
  // PTY spawn
  // ---------------------------------------------------------------------------

  /** Call fitAddon.fit() only if the container is wide enough.
   *  When the container is too narrow, the terminal keeps its last
   *  good dimensions and content doesn't reflow. */
  private safeFit(): void {
    try {
      const width = this.containerEl.clientWidth;
      if (width < TerminalTab.MIN_FIT_WIDTH) return;
      this.fitAddon.fit();
    } catch { /* ignore fit errors during cleanup */ }
  }

  private spawnPty(cols: number, rows: number, command?: string[]): ChildProcess {
    const cp = electronRequire("child_process") as typeof import("child_process");
    const path = electronRequire("path") as typeof import("path");
    const fs = electronRequire("fs") as typeof import("fs");
    const home = process.env.HOME || "";

    // Find pty-wrapper.py
    let wrapperPath: string;
    const candidates = [
      path.join(home, "working/obsidian-work-terminal/pty-wrapper.py"),
      path.join(__dirname, "pty-wrapper.py"),
    ];
    wrapperPath = candidates.find((p: string) => {
      try { return fs.existsSync(p); } catch { return false; }
    }) || candidates[0];

    const cmd = command || [this.shell, "-i"];
    const args = [wrapperPath, String(cols), String(rows), "--", ...cmd];

    console.log("[work-terminal] Spawning via pty-wrapper:", args.join(" "));
    console.log("[work-terminal] cwd:", this.cwd);

    const proc = cp.spawn("python3", args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLUMNS: String(cols),
        LINES: String(rows),
        PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      },
    });

    console.log("[work-terminal] spawn pid:", proc.pid);
    return proc;
  }

  // ---------------------------------------------------------------------------
  // Rename detection
  // ---------------------------------------------------------------------------

  private _checkRename(data: Buffer): void {
    this._renameLineBuffer += this._renameDecoder.write(data);
    // Split on any line ending style: \r\n, \n, or bare \r
    const lines = this._renameLineBuffer.split(/\r\n|\n|\r/);
    // Keep the last (possibly incomplete) chunk
    this._renameLineBuffer = lines.pop() || "";

    for (const line of lines) {
      this._processRenameLine(line);
    }
    // Also check the incomplete line buffer - handles the case where
    // rename output arrives without a trailing newline
    if (this._renameLineBuffer) {
      this._processRenameLine(this._renameLineBuffer);
    }
  }

  private _processRenameLine(line: string): void {
    const clean = stripAnsi(line);
    const match = clean.match(this._renamePattern);
    if (match) {
      let newLabel = match[1].trim();
      console.log("[work-terminal] Rename detected:", newLabel);
      if (this.transformLabel) {
        newLabel = this.transformLabel(this.label, newLabel);
      }
      this.label = newLabel;
      this.onLabelChange?.();
    }
  }

  // ---------------------------------------------------------------------------
  // Visibility & layout
  // ---------------------------------------------------------------------------

  get isVisible(): boolean {
    return !this.containerEl.hasClass("hidden");
  }

  show(): void {
    this.containerEl.removeClass("hidden");
    // Double-rAF: first frame makes the element visible and triggers layout,
    // second frame has correct dimensions for fitAddon to measure.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this.safeFit();
        this.terminal.scrollToBottom();
        this.terminal.focus();
      });
    });
  }

  hide(): void {
    this.containerEl.addClass("hidden");
  }

  refit(): void {
    if (this.containerEl.hasClass("hidden")) return;
    requestAnimationFrame(() => {
      this.safeFit();
    });
  }

  // ---------------------------------------------------------------------------
  // Claude state detection
  // ---------------------------------------------------------------------------

  get claudeState(): ClaudeState {
    return this._claudeState;
  }

  get isClaudeSession(): boolean {
    return this._isClaudeSession;
  }

  /** Start state tracking for Claude/Agent sessions. Call after label is known. */
  startStateTracking(): void {
    this._isClaudeSession = this._detectClaudeSession();
    if (!this._isClaudeSession) return;

    // On fresh spawn, assume active. After reload, start as idle to avoid
    // false active flash from stale buffer content.
    this._claudeState = this._suppressActiveUntil > 0 ? "idle" : "active";
    if (!this._recentCleanLines) this._recentCleanLines = [];

    // Check state every 2 seconds
    this._stateTimer = setInterval(() => this._checkState(), 2000);
  }

  private _detectClaudeSession(): boolean {
    return !!this.claudeSessionId;
  }

  /** Called on each chunk of output data to track activity. */
  private _trackOutput(data: Buffer | string): void {
    if (!this._isClaudeSession) return;

    // Buffer recent clean lines for pattern matching (keep last 30 lines)
    const text = typeof data === "string" ? data : data.toString("utf8");
    const lines = stripAnsi(text).split(/\r\n|\n|\r/).filter(l => l.trim().length > 0);

    this._recentCleanLines.push(...lines);
    if (this._recentCleanLines.length > 30) {
      this._recentCleanLines = this._recentCleanLines.slice(-30);
    }
  }

  /**
   * Read the visible terminal screen content for state detection.
   * Uses xterm.js buffer API to get the actual rendered lines.
   */
  private _readTerminalScreen(): string[] {
    const buf = this.terminal.buffer.active;
    const lines: string[] = [];
    // The cursor position (baseY + cursorY) marks where content ends
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

  private _checkState(): void {
    if (!this._isClaudeSession) return;

    const screenLines = this._readTerminalScreen();

    // Check for waiting patterns first (highest priority).
    // Suppress waiting if the tab is currently visible - the user can already see it.
    if (this._looksLikeWaiting(screenLines)) {
      this._setClaudeState("waiting");
      return;
    }

    // Need screen content for idle/active detection
    if (screenLines.length === 0) return;

    // Look for structural indicators in the last few lines only (near the status bar).
    //   \u2733 <text>... - spinner line with ellipsis means work in progress
    //   \u23bf  <text>... - tool output with ellipsis means tool still running
    // On narrow terminals the spinner line wraps across multiple visual rows,
    // so we check both per-line AND a joined tail string.
    const tail = screenLines.slice(-6);
    const tailJoined = tail.join(" ");
    const hasActiveIndicator = tail.some(line =>
      /^\s*\u2733.*\u2026/.test(line) ||    // spinner with ellipsis = in progress
      /^\s*\u23bf\s+.*\u2026/.test(line)    // tool output with ellipsis = running
    ) || (
      // Wrapped lines: spinner char on one visual row, ellipsis on another
      /\u2733/.test(tailJoined) && /\u2026/.test(tailJoined) &&
      tail.some(line => /^\s*\u2733/.test(line))
    );

    if (hasActiveIndicator) {
      // During post-reload grace period, treat "active" as "idle"
      if (Date.now() < this._suppressActiveUntil) {
        this._setClaudeState("idle");
      } else {
        this._setClaudeState("active");
      }
    } else {
      // Real output clears the suppression early
      this._suppressActiveUntil = 0;
      this._setClaudeState("idle");
    }
  }

  /**
   * Check if Claude is waiting for user input by inspecting both the terminal
   * screen buffer and recent output lines.
   */
  private _looksLikeWaiting(screenLines?: string[]): boolean {
    const sources = [
      ...(screenLines || []),
      ...(this._recentCleanLines || []).slice(-15),
    ];
    if (sources.length === 0) return false;

    const tail = sources.slice(-20);

    for (let i = tail.length - 1; i >= Math.max(0, tail.length - 15); i--) {
      const line = tail[i].trim();

      // Interactive selection UI: "Enter to select", "up/down to navigate"
      if (/Enter to select|to navigate/i.test(line)) return true;

      // Permission prompt patterns
      if (/\bAllow\b.*\?/i.test(line)) return true;
      if (/\ballowOnce\b|\bdenyOnce\b|\ballowAlways\b/i.test(line)) return true;

      // AskUserQuestion patterns: numbered options with ">" selector or "(N)"
      if (/^\s*[>\u276f]\s*\d+\.\s+\S/.test(line)) return true;
      if (/^\s*\(?\d+\)?\s+\S/.test(line) && i > 0) {
        for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
          if (tail[j].trim().endsWith("?")) return true;
        }
      }

      // Generic question pattern near the bottom
      if (i >= tail.length - 5 && line.endsWith("?") && line.length > 10) return true;

      // "Yes" / "No" option pair
      if (/^\s*(Yes|No)\s*$/i.test(line)) return true;
    }

    return false;
  }

  /** Clear the waiting state (e.g. when the user activates this tab to respond). */
  clearWaiting(): void {
    if (this._claudeState === "waiting") {
      this._setClaudeState("idle");
    }
  }

  private _setClaudeState(state: ClaudeState): void {
    if (this._claudeState === state) return;
    this._claudeState = state;
    this.onStateChange?.(state);
  }

  // ---------------------------------------------------------------------------
  // Stash / restore for hot-reload
  // ---------------------------------------------------------------------------

  /**
   * Extract live state for reload persistence. Does NOT dispose anything.
   * The returned StoredSession holds references to live objects.
   */
  stash(): StoredSession {
    // Stop state timer during stash - will be restarted by fromStored
    if (this._stateTimer) {
      clearInterval(this._stateTimer);
      this._stateTimer = null;
    }
    return {
      id: this.id,
      taskPath: this.taskPath,
      label: this.label,
      claudeSessionId: this.claudeSessionId,
      sessionType: this.sessionType,
      terminal: this.terminal,
      fitAddon: this.fitAddon,
      containerEl: this.containerEl,
      process: this.process,
      documentListeners: this._documentCleanups.map((fn, i) => ({
        event: `cleanup-${i}`,
        handler: fn as unknown as EventListener,
      })),
      resizeObserver: this.resizeObserver,
    };
  }

  /**
   * Create a TerminalTab wrapping an existing stored session (after reload).
   * Re-attaches DOM, re-registers keyboard listeners, but does NOT re-spawn a process.
   */
  static fromStored(stored: StoredSession, parentEl: HTMLElement): TerminalTab {
    injectXtermCss();

    const tab = Object.create(TerminalTab.prototype) as TerminalTab;
    tab.id = stored.id;
    tab.label = stored.label;
    tab.taskPath = stored.taskPath;
    tab.claudeSessionId = stored.claudeSessionId || null;
    tab.sessionType = stored.sessionType;
    tab.terminal = stored.terminal;
    tab.fitAddon = stored.fitAddon;
    tab.containerEl = stored.containerEl;
    tab.process = stored.process;
    tab._documentCleanups = [];
    tab._claudeState = "inactive" as ClaudeState;
    tab._recentCleanLines = [];
    tab._stateTimer = null;
    tab._isClaudeSession = false;
    tab._renameDecoder = new StringDecoder("utf8");
    tab._renameLineBuffer = "";
    tab._renamePattern = /^\s*[^\w]*Session renamed to:\s*(.+?)\s*$/;
    tab.spawnTime = 0;

    // Re-attach container DOM to the new parent
    parentEl.appendChild(stored.containerEl);

    // Re-register keyboard interception
    attachBubbleCapture(stored.containerEl);
    const captureCleanup = attachCapturePhase(
      stored.containerEl,
      () => tab.process
    );
    tab._documentCleanups = [captureCleanup];

    // Click-to-focus
    stored.containerEl.addEventListener("click", () => {
      stored.terminal.focus();
    });

    // Scroll-to-bottom button
    attachScrollButton(stored.containerEl, stored.terminal);

    // Re-attach resize observer - debounced to avoid fitting during transitions
    stored.resizeObserver.disconnect();
    tab._resizeDebounce = null;
    tab.resizeObserver = new ResizeObserver(() => {
      if (stored.containerEl.hasClass("hidden")) return;
      if (tab._resizeDebounce) clearTimeout(tab._resizeDebounce);
      tab._resizeDebounce = setTimeout(() => {
        if (stored.containerEl.hasClass("hidden")) return;
        const prevCols = tab.terminal.cols;
        tab.safeFit();
        if (tab.terminal.cols !== prevCols) {
          tab.terminal.scrollToBottom();
        }
      }, 100);
    });
    tab.resizeObserver.observe(stored.containerEl);

    // Resume state tracking for Claude sessions.
    // Suppress "active" detection for 2s to prevent stale xterm buffer
    // content from causing a false active flash on all cards after reload.
    tab._suppressActiveUntil = Date.now() + 2000;
    tab.startStateTracking();

    // Scroll to bottom after recovery - terminal buffer is preserved but
    // viewport resets to top during the DOM re-attach.
    requestAnimationFrame(() => {
      stored.terminal.scrollToBottom();
    });

    return tab;
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  dispose(): void {
    // Stop state tracking
    if (this._stateTimer) {
      clearInterval(this._stateTimer);
      this._stateTimer = null;
    }
    if (this._resizeDebounce) {
      clearTimeout(this._resizeDebounce);
      this._resizeDebounce = null;
    }
    // Remove document-level keyboard listeners
    for (const cleanup of this._documentCleanups) {
      cleanup();
    }
    this._documentCleanups = [];
    this.resizeObserver.disconnect();
    if (this.process && !this.process.killed) {
      this.process.kill("SIGTERM");
      // Force kill after 1s if not exited
      const procRef = this.process;
      setTimeout(() => {
        if (procRef && !procRef.killed) {
          procRef.kill("SIGKILL");
        }
      }, 1000);
    }
    this.terminal.dispose();
    this.containerEl.remove();
  }
}
