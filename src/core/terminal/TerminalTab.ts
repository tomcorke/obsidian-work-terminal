/**
 * TerminalTab - xterm.js terminal + Python PTY wrapper spawn.
 *
 * Each tab owns a Terminal instance, FitAddon, ResizeObserver, PTY child process,
 * and agent state detection. Supports stash/restore for hot-reload persistence.
 */
import { Terminal, type IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import type { ChildProcess } from "child_process";
import { StringDecoder } from "string_decoder";
import { Notice } from "obsidian";
import { expandTilde, stripAnsi, electronRequire } from "../utils";
import { injectXtermCss } from "./XtermCss";
import { attachScrollButton } from "./ScrollButton";
import { attachBubbleCapture, attachCapturePhase } from "./KeyboardCapture";
import {
  checkPython3Available,
  hasPython3BeenNotified,
  markPython3Notified,
  PYTHON3_MISSING_MESSAGE,
} from "./PythonCheck";
import {
  type AgentRuntimeState,
  type StoredSession,
  type SessionType,
  type TerminalTabDiagnostics,
  type TabProcessDiagnostics,
  isResumableSessionType,
} from "../session/types";
import { AgentSessionTracker } from "../agents/AgentSessionTracker";
import { CopilotSessionDetector } from "../agents/CopilotSessionDetector";
import { hasAgentActiveIndicator, hasAgentWaitingIndicator } from "../agents/AgentStateDetector";
import {
  type ParamPassMode,
  sessionTypeToAgentType,
  getResumeConfig,
} from "../agents/AgentProfile";
import { getFullPath } from "../agents/AgentLauncher";

export type AgentState = AgentRuntimeState;
export type ClaudeState = AgentState;

let sessionCounter = 0;

type TerminalWithAddonManager = Terminal & {
  _addonManager?: {
    _addons?: Array<{
      instance?: unknown;
      isDisposed?: boolean;
    }>;
  };
  _linkProviderService?: {
    linkProviders: unknown[];
  };
};

/**
 * Open a URL via Electron's shell.openExternal, with error handling.
 * Used by the OSC 8 linkHandler and WebLinksAddon to route link clicks
 * through the system browser instead of xterm's default window.open()
 * which is a no-op in Electron/Obsidian.
 */
function openUrlViaElectron(uri: string): void {
  try {
    const shell = electronRequire("electron").shell;
    void Promise.resolve(shell.openExternal(uri)).catch((err: unknown) => {
      console.error("[work-terminal] shell.openExternal failed:", err);
    });
  } catch (err) {
    console.error("[work-terminal] Failed to open URL:", err);
  }
}

function shouldPreservePrintableOptionCombo(event: KeyboardEvent): boolean {
  if (!event.altKey || event.ctrlKey || event.metaKey) return false;
  if (event.getModifierState?.("AltGraph")) return false;
  return /^Digit\d$/.test(event.code);
}

export function resolvePtyWrapperPath(pluginDir?: string): string {
  const path = electronRequire("path") as typeof import("path");
  const fs = electronRequire("fs") as typeof import("fs");
  const candidates = [
    ...(pluginDir ? [path.join(pluginDir, "pty-wrapper.py")] : []),
    path.join(__dirname, "pty-wrapper.py"),
  ];

  return (
    candidates.find((candidate) => {
      try {
        return fs.existsSync(candidate);
      } catch {
        return false;
      }
    }) ||
    candidates[0] ||
    "pty-wrapper.py"
  );
}

export class TerminalTab {
  id: string;
  label: string;
  taskPath: string | null;
  agentSessionId: string | null = null;
  durableSessionId: string | null = null;
  sessionType: SessionType;
  profileId: string | undefined;
  profileColor: string | undefined;
  paramPassMode: import("../agents/AgentProfile").ParamPassMode | undefined;

  terminal: Terminal;
  containerEl: HTMLElement;
  process: ChildProcess | null = null;

  onOutputData?: (data: Buffer | string) => void;
  onLabelChange?: () => void;
  onProcessExit?: (code: number | null, signal: string | null) => void;
  onStateChange?: (state: AgentState) => void;

  private fitAddon: FitAddon | undefined;
  private searchAddon: SearchAddon | undefined;
  private webLinksAddon: WebLinksAddon | undefined;
  private linkProviderDisposable: IDisposable | null = null;
  private unicode11Addon: Unicode11Addon | undefined;
  private webglAddon: WebglAddon | null = null;
  private webglContextLossListener: IDisposable | null = null;
  private resizeObserver: ResizeObserver;
  private _documentCleanups: (() => void)[] = [];
  private _searchBarEl: HTMLElement | null = null;
  private _resizeDebounce: ReturnType<typeof setTimeout> | null = null;
  private _spawnTimeout: ReturnType<typeof setTimeout> | null = null;
  private _isDisposed = false;
  /** True when WebGL was intentionally suspended for a background tab. */
  private _webglSuspended = false;

  // Minimum container width for fitAddon.fit(). When the plugin view is
  // momentarily narrow (e.g. switching between plugins), skip the fit so the
  // terminal keeps its last good dimensions and content doesn't reflow.
  private static MIN_FIT_WIDTH = 200;
  private cwd: string = "";
  private spawnTime = 0;

  // Agent state detection
  private _agentState: AgentState = "inactive";
  private _recentCleanLines: string[] = [];
  private _stateTimer: ReturnType<typeof setInterval> | null = null;
  private _isResumableAgent = false;
  /** Suppress "active" detection until this timestamp (ms). Used after reload
   *  to prevent stale xterm buffer content from triggering false active state. */
  _suppressActiveUntil = 0;
  /** Previous screen content fingerprint for change-based activity detection. */
  private _prevScreenFingerprint = "";
  /** How many consecutive polls the screen content has remained unchanged. */
  private _unchangedPolls = 0;

  // User-initiated scroll tracking: true when the user has explicitly scrolled
  // up via wheel/touchmove/keyboard. Auto-scroll is suppressed while this flag
  // is set. Reset when the user scrolls back to the bottom or clicks the
  // scroll-to-bottom button.
  _userScrolledUp = false;
  _programmaticScrollGuards = 0;
  _pendingBottomCheck = false;

  // Session tracking (/resume detection)
  private _sessionTracker: AgentSessionTracker | null = null;

  // Deferred session ID detection (Copilot context sessions)
  private _sessionDetector: CopilotSessionDetector | null = null;

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
    agentSessionId?: string | null,
    durableSessionId?: string | null,
    private pluginDir?: string,
  ) {
    this.agentSessionId = agentSessionId || null;
    this.durableSessionId =
      durableSessionId || (agentSessionId ? null : globalThis.crypto?.randomUUID?.() || null);
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
      // Handle OSC 8 hyperlinks (e.g. Claude Code issue/PR links) via Electron
      // shell instead of xterm's default confirm() + window.open() which fails
      // in Obsidian's Electron renderer.
      linkHandler: {
        activate: (_event: MouseEvent, uri: string) => {
          openUrlViaElectron(uri);
        },
      },
    });
    this.configureOptionKeyHandling();

    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);

    // Search addon (Cmd+F)
    this.searchAddon = new SearchAddon();
    this.terminal.loadAddon(this.searchAddon);

    // Web links - Cmd+click to open URLs in browser via Electron shell
    this.webLinksAddon = new WebLinksAddon((_event, uri) => {
      openUrlViaElectron(uri);
    });
    this.terminal.loadAddon(this.webLinksAddon);

    // Unicode 11 - correct emoji/CJK character widths
    this.unicode11Addon = new Unicode11Addon();
    this.terminal.loadAddon(this.unicode11Addon);
    this.terminal.unicode.activeVersion = "11";

    this.terminal.open(this.containerEl);

    // WebGL renderer - GPU-accelerated rendering, fall back to canvas.
    // Subscribe to onContextLoss: idle tabs can have their GPU context
    // reclaimed by the OS, leaving a blank/white canvas. Disposing the
    // WebglAddon on context loss causes xterm to fall back to its canvas
    // renderer automatically, recovering the display.
    this.loadWebglAddon();

    // File path link provider - Cmd+click on paths like src/main.ts:42
    this.registerFilePathLinks();

    // Scroll-to-bottom button
    const scrollCleanup = attachScrollButton(this.containerEl, this.terminal, () => {
      this._userScrolledUp = false;
    });
    this._documentCleanups.push(scrollCleanup);

    // User-initiated scroll detection
    this._wireUserScrollDetection();

    // Keyboard capture - two layers
    const bubbleCleanup = attachBubbleCapture(this.containerEl);
    this._documentCleanups.push(bubbleCleanup);
    const captureCleanup = attachCapturePhase(
      this.containerEl,
      () => this.process,
      () => this.toggleSearchBar(),
    );
    this._documentCleanups.push(captureCleanup);

    // Ensure clicking the terminal area gives xterm focus
    const clickHandler = () => {
      if (this._isDisposed) return;
      this.terminal.focus();
    };
    this.containerEl.addEventListener("click", clickHandler);
    this._documentCleanups.push(() => {
      this.containerEl.removeEventListener("click", clickHandler);
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
        const python3Path = checkPython3Available();
        if (!python3Path) {
          console.error("[work-terminal] python3 not found - cannot spawn PTY");
          this.terminal.write(`\r\n[${PYTHON3_MISSING_MESSAGE}]\r\n`);
          if (!hasPython3BeenNotified()) {
            new Notice(PYTHON3_MISSING_MESSAGE, 10_000);
            markPython3Notified();
          }
          return;
        }
        this.spawnTime = Date.now();
        const proc = this.spawnPty(cols, rows, command, python3Path);
        console.log("[work-terminal] Spawned pid:", proc.pid, "cols:", cols, "rows:", rows);
        this.process = proc;
        this.wireProcess(proc);
        this._initSessionTracker();
        this.startStateTracking();
        this.terminal.scrollToBottom();
      } catch (err) {
        console.error("[work-terminal] Failed to spawn:", err);
        this.terminal.write(`\r\n[Failed to spawn: ${err}]\r\n`);
      }
    };

    // Delay spawn to let CSS layout happen first
    this._spawnTimeout = setTimeout(() => {
      this._spawnTimeout = null;
      if (this._isDisposed) return;
      spawnWithFit();
    }, 150);

    // Send resize control sequence to PTY wrapper on terminal resize
    this.terminal.onResize(({ cols, rows }) => {
      if (this._isDisposed) return;
      if (this.process?.stdin && !this.process.stdin.destroyed) {
        // Custom OSC sequence that pty-wrapper.py intercepts
        const resizeCmd = `\x1b]777;resize;${cols};${rows}\x07`;
        this.process.stdin.write(resizeCmd);
      }
    });

    // Resize observer - debounced to avoid fitting during tab transition
    // animations where the container has intermediate (narrow) widths.
    this.resizeObserver = new ResizeObserver(() => {
      if (this._isDisposed) return;
      if (this.containerEl.hasClass("hidden")) return;
      if (this._resizeDebounce) clearTimeout(this._resizeDebounce);
      this._resizeDebounce = setTimeout(() => {
        if (this._isDisposed) return;
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

  private disposeWebglContextLossListener(): void {
    this.webglContextLossListener?.dispose();
    this.webglContextLossListener = null;
  }

  private trackWebglAddon(addon: WebglAddon): void {
    this.disposeWebglContextLossListener();
    this.webglAddon = addon;
    this.webglContextLossListener = addon.onContextLoss(() => {
      if (this.webglAddon !== addon) return;
      this.disposeWebglContextLossListener();
      console.warn("[work-terminal] WebGL context lost, falling back to canvas renderer");
      addon.dispose();
      this.webglAddon = null;
      // After disposing the WebGL addon, xterm falls back to its canvas
      // renderer. Force a refresh so the canvas renderer paints the buffer
      // content immediately, preventing a blank terminal.
      requestAnimationFrame(() => {
        if (this._isDisposed) return;
        this.terminal.refresh(0, this.terminal.rows - 1);
      });
    });
  }

  private loadWebglAddon(): void {
    let addon: WebglAddon | null = null;
    try {
      addon = new WebglAddon();
      this.trackWebglAddon(addon);
      this.terminal.loadAddon(addon);
    } catch (e) {
      console.warn("[work-terminal] WebGL addon failed, using canvas renderer:", e);
      this.disposeWebglContextLossListener();
      addon?.dispose();
      if (this.webglAddon === addon) {
        this.webglAddon = null;
      }
    }
  }

  /**
   * Dispose the WebGL addon for a background tab, falling back to canvas.
   * The terminal keeps running - only the GPU context is released.
   */
  suspendWebGl(): void {
    if (this._isDisposed || this._webglSuspended) return;
    if (!this.webglAddon) {
      // Mark suspended so resumeWebGl retries WebGL initialization when the tab
      // becomes visible, even if the previous WebGL context was lost.
      this._webglSuspended = true;
      return;
    }

    // Capture addon before detach clears the reference, then dispose it
    // to release the GPU context. detachTrackedWebglAddon removes it from
    // xterm's addon manager; dispose() releases the actual GL resources.
    const addon = this.webglAddon;
    this.detachTrackedWebglAddon(addon);
    try {
      addon.dispose();
    } catch {
      // WebGL addon may not have been fully loaded (e.g. process spawn failed
      // before the addon was registered with xterm's addon manager).
    }
    this._webglSuspended = true;

    // Force canvas renderer to paint the buffer content
    requestAnimationFrame(() => {
      if (this._isDisposed) return;
      this.terminal.refresh(0, this.terminal.rows - 1);
    });
  }

  /**
   * Re-initialize WebGL for a tab that was previously suspended.
   * Called when the tab becomes the visible/active tab.
   */
  resumeWebGl(): void {
    if (this._isDisposed || !this._webglSuspended) return;

    this.loadWebglAddon();

    // Only clear suspended if WebGL actually loaded; otherwise keep the flag
    // so the next visibility transition retries.
    this._webglSuspended = !this.webglAddon;

    if (!this._webglSuspended) {
      // Repaint and re-fit after WebGL is loaded
      requestAnimationFrame(() => {
        if (this._isDisposed) return;
        this.safeFit();
        this.terminal.refresh(0, this.terminal.rows - 1);
      });
    }
  }

  /** Whether WebGL is currently suspended for this tab. */
  get webglSuspended(): boolean {
    return this._webglSuspended;
  }

  private getTrackedWebglAddonEntry(addon: WebglAddon) {
    return (this.terminal as TerminalWithAddonManager)._addonManager?._addons?.find(
      (entry) => entry.instance === addon,
    );
  }

  private hasRenderableSessionContent(): boolean {
    if (this.process && this.process.exitCode === null && this.process.signalCode === null) {
      return true;
    }
    return this._readTerminalScreen().length > 0;
  }

  private hasBlankRenderSurface(): boolean {
    const terminalElement = (this.terminal as Terminal & { element?: ParentNode | null })
      .element as ParentNode | null | undefined;
    const renderRoot =
      terminalElement && typeof terminalElement.querySelectorAll === "function"
        ? terminalElement
        : ((this.containerEl as ParentNode | null | undefined) ?? null);
    if (!renderRoot || typeof renderRoot.querySelectorAll !== "function") {
      return false;
    }
    return renderRoot.querySelectorAll(".xterm-screen canvas").length === 0;
  }

  private recoverBlankRendererIfNeeded(): void {
    if (this._isDisposed || !this.isVisible || !this.webglAddon) return;
    if (!this.hasRenderableSessionContent() || !this.hasBlankRenderSurface()) return;
    const staleAddon = this.webglAddon;
    const addonEntry = this.getTrackedWebglAddonEntry(staleAddon);
    if (!addonEntry?.isDisposed) return;

    console.warn("[work-terminal] Recovering blank renderer from stale disposed WebGL addon");
    this.detachTrackedWebglAddon(staleAddon);
    this.loadWebglAddon();
    this.safeFit();
    this.terminal.refresh(0, this.terminal.rows - 1);
    this.terminal.scrollToBottom();
  }

  // ---------------------------------------------------------------------------
  // Process wiring
  // ---------------------------------------------------------------------------

  private wireProcess(proc: ChildProcess): void {
    this.terminal.onData((data) => {
      if (this._isDisposed) return;
      this._sessionTracker?.feedInput(data);
      if (proc.stdin && !proc.stdin.destroyed) {
        proc.stdin.write(data);
      }
    });

    // Auto-scroll: always scroll to bottom after each write UNLESS the user
    // has explicitly scrolled up (tracked via wheel/touchmove/keydown events).
    // This replaces the per-write wasAtBottom snapshot approach which was
    // defeated by DOM scroll events firing during screen clear/redraw cycles.
    const writeWithAutoScroll = (data: string | Uint8Array) => {
      this._programmaticScrollGuards += 1;
      this.terminal.write(data, () => {
        if (!this._userScrolledUp) {
          this.terminal.scrollToBottom();
        }
        requestAnimationFrame(() => {
          this._programmaticScrollGuards = Math.max(0, this._programmaticScrollGuards - 1);
          if (this._programmaticScrollGuards === 0 && this._pendingBottomCheck) {
            this._pendingBottomCheck = false;
            const buf = this.terminal.buffer.active;
            if (buf.viewportY >= buf.baseY) {
              this._userScrolledUp = false;
            }
          }
        });
      });
    };

    proc.stdout?.on("data", (data: Buffer) => {
      if (this._isDisposed) return;
      this._checkRename(data);
      this._trackOutput(data);
      this.onOutputData?.(data);
      writeWithAutoScroll(data);
    });

    proc.stderr?.on("data", (data: Buffer) => {
      if (this._isDisposed) return;
      this._checkRename(data);
      this._trackOutput(data);
      this.onOutputData?.(data);
      writeWithAutoScroll(data);
    });

    proc.on("error", (err) => {
      if (this._isDisposed) return;
      console.error("[work-terminal] Process error:", err);
      writeWithAutoScroll(`\r\n[Process error: ${err.message}]\r\n`);
    });

    proc.on("exit", (code, signal) => {
      if (this._isDisposed) return;
      writeWithAutoScroll(`\r\n[Process exited (code: ${code}, signal: ${signal})]\r\n`);
      this.onProcessExit?.(code, signal);
    });
  }

  /**
   * Attach event listeners to detect user-initiated scrolls (wheel, touchmove,
   * keyboard Page Up/Down/Home/End). Sets `_userScrolledUp = true` when the
   * user scrolls away from the bottom, and resets it when they return.
   */
  _wireUserScrollDetection(): void {
    const viewport = this.containerEl.querySelector(".xterm-viewport");
    if (!viewport) return;

    const SCROLL_KEYS = new Set(["PageUp", "PageDown", "Home", "End"]);
    const IMMEDIATE_SCROLL_UP_KEYS = new Set(["PageUp", "Home"]);

    const checkIfAtBottom = () => {
      if (this._programmaticScrollGuards > 0) {
        this._pendingBottomCheck = true;
        return;
      }
      this._pendingBottomCheck = false;
      const buf = this.terminal.buffer.active;
      if (buf.viewportY >= buf.baseY) {
        this._userScrolledUp = false;
      }
    };

    const onUserScroll = () => {
      const buf = this.terminal.buffer.active;
      if (buf.viewportY < buf.baseY) {
        this._userScrolledUp = true;
      } else {
        this._userScrolledUp = false;
      }
    };

    // Use requestAnimationFrame to read scroll position after the browser
    // has applied the scroll delta from wheel/touch events.
    const onUserScrollDeferred = () => {
      requestAnimationFrame(onUserScroll);
    };

    const onWheel = (e: Event) => {
      const wheelEvent = e as WheelEvent;
      if (wheelEvent.deltaY < 0) {
        this._userScrolledUp = true;
      }
      onUserScrollDeferred();
    };
    viewport.addEventListener("wheel", onWheel, { passive: true });
    viewport.addEventListener("touchmove", onUserScrollDeferred, { passive: true });

    const onKeydown = (e: Event) => {
      const ke = e as KeyboardEvent;
      if (IMMEDIATE_SCROLL_UP_KEYS.has(ke.key)) {
        this._userScrolledUp = true;
      }
      if (SCROLL_KEYS.has(ke.key)) {
        onUserScrollDeferred();
      }
    };
    viewport.addEventListener("keydown", onKeydown, { passive: true });

    // Also check on native scroll events to catch edge cases (e.g. trackpad
    // inertia scrolling back to the bottom).
    const onScroll = () => requestAnimationFrame(checkIfAtBottom);
    viewport.addEventListener("scroll", onScroll, { passive: true });

    this._documentCleanups.push(() => {
      viewport.removeEventListener("wheel", onWheel);
      viewport.removeEventListener("touchmove", onUserScrollDeferred);
      viewport.removeEventListener("keydown", onKeydown);
      viewport.removeEventListener("scroll", onScroll);
    });
  }

  private configureOptionKeyHandling(): void {
    const terminal = this.terminal as Terminal & {
      options?: { macOptionIsMeta?: boolean };
      attachCustomKeyEventHandler?: (handler: (event: KeyboardEvent) => boolean) => void;
    };
    if (!terminal.options || typeof terminal.attachCustomKeyEventHandler !== "function") return;

    terminal.options.macOptionIsMeta = true;
    terminal.attachCustomKeyEventHandler((event) => {
      terminal.options!.macOptionIsMeta = !shouldPreservePrintableOptionCombo(event);
      return true;
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
      if (this._isDisposed) return;
      const width = this.containerEl.clientWidth;
      if (width < TerminalTab.MIN_FIT_WIDTH) return;
      this.fitAddon?.fit();
    } catch {
      /* ignore fit errors during cleanup */
    }
  }

  // ---------------------------------------------------------------------------
  // File path link provider
  // ---------------------------------------------------------------------------

  /** Register a custom link provider for file paths like src/main.ts:42:10 */
  private registerFilePathLinks(): void {
    const fs = electronRequire("fs") as typeof import("fs");
    const path = electronRequire("path") as typeof import("path");
    const shell = electronRequire("electron").shell;

    // Match paths with optional line:col - e.g. src/main.ts, ./foo/bar.js:42, /abs/path.ts:10:5
    const pathRegex = /(?:\.\/|\.\.\/|\/|[a-zA-Z][\w.-]*\/)[^\s:,;'")\]}>]+?(?::\d+(?::\d+)?)?/g;

    this.linkProviderDisposable = this.terminal.registerLinkProvider({
      provideLinks: (lineNumber: number, callback: (links: any[] | undefined) => void) => {
        if (this._isDisposed) {
          callback(undefined);
          return;
        }
        const line = this.terminal.buffer.active.getLine(lineNumber - 1)?.translateToString() || "";
        const links: any[] = [];
        let match: RegExpExecArray | null;
        pathRegex.lastIndex = 0;

        while ((match = pathRegex.exec(line)) !== null) {
          const raw = match[0];
          // Strip trailing punctuation that's not part of the path
          const cleaned = raw.replace(/[.,;:!?)}\]]+$/, "");
          // Split off line:col suffix
          const lineColMatch = cleaned.match(/^(.+?):(\d+)(?::(\d+))?$/);
          const filePath = lineColMatch ? lineColMatch[1] : cleaned;

          // Resolve relative to terminal's cwd
          const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(this.cwd, filePath);

          // Only create a link if the file exists
          if (!fs.existsSync(absPath)) continue;

          const startIdx = match.index;
          links.push({
            range: {
              start: { x: startIdx + 1, y: lineNumber },
              end: { x: startIdx + cleaned.length + 1, y: lineNumber },
            },
            text: cleaned,
            activate: () => {
              // Open in VS Code with line:col if available
              const lineNum = lineColMatch ? lineColMatch[2] : undefined;
              const colNum = lineColMatch ? lineColMatch[3] : undefined;
              const target = lineNum
                ? `${absPath}:${lineNum}${colNum ? ":" + colNum : ""}`
                : absPath;
              const cp = electronRequire("child_process") as typeof import("child_process");
              cp.exec(`code --goto "${target}"`, (err) => {
                if (err) shell.openPath(absPath);
              });
            },
          });
        }
        callback(links.length > 0 ? links : undefined);
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Search bar (Cmd+F)
  // ---------------------------------------------------------------------------

  toggleSearchBar(): void {
    if (this._searchBarEl) {
      this._searchBarEl.remove();
      this._searchBarEl = null;
      this.terminal.focus();
      return;
    }

    const bar = document.createElement("div");
    bar.className = "wt-search-bar";

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Search...";
    input.className = "wt-search-input";

    const prevBtn = document.createElement("button");
    prevBtn.textContent = "\u2191";
    prevBtn.className = "wt-search-nav";
    prevBtn.title = "Previous match";

    const nextBtn = document.createElement("button");
    nextBtn.textContent = "\u2193";
    nextBtn.className = "wt-search-nav";
    nextBtn.title = "Next match";

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "\u00d7";
    closeBtn.className = "wt-search-close";
    closeBtn.title = "Close";

    bar.appendChild(input);
    bar.appendChild(prevBtn);
    bar.appendChild(nextBtn);
    bar.appendChild(closeBtn);
    this.containerEl.appendChild(bar);
    this._searchBarEl = bar;

    input.addEventListener("input", () => {
      if (input.value) {
        this.searchAddon?.findNext(input.value, {
          decorations: { activeMatchColorOverviewRuler: "#ffa500" },
        });
      } else {
        this.searchAddon?.clearDecorations();
      }
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (e.shiftKey) {
          this.searchAddon?.findPrevious(input.value);
        } else {
          this.searchAddon?.findNext(input.value);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.toggleSearchBar();
      }
      e.stopPropagation();
    });

    prevBtn.addEventListener("click", () => this.searchAddon?.findPrevious(input.value));
    nextBtn.addEventListener("click", () => this.searchAddon?.findNext(input.value));
    closeBtn.addEventListener("click", () => this.toggleSearchBar());

    input.focus();
  }

  // ---------------------------------------------------------------------------
  // PTY spawn
  // ---------------------------------------------------------------------------

  private spawnPty(
    cols: number,
    rows: number,
    command?: string[],
    python3Path = "python3",
  ): ChildProcess {
    const cp = electronRequire("child_process") as typeof import("child_process");
    const wrapperPath = resolvePtyWrapperPath(this.pluginDir);

    const cmd = command || [this.shell, "-i"];
    const args = [wrapperPath, String(cols), String(rows), "--", ...cmd];

    console.log("[work-terminal] Spawning via pty-wrapper:", python3Path, args.join(" "));
    console.log("[work-terminal] cwd:", this.cwd);

    const proc = cp.spawn(python3Path, args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLUMNS: String(cols),
        LINES: String(rows),
        PATH: getFullPath(),
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

  get isDisposed(): boolean {
    return this._isDisposed;
  }

  get launchShell(): string {
    return this.shell;
  }

  get launchCwd(): string {
    return this.cwd;
  }

  get launchCommandArgs(): string[] | undefined {
    return this.commandArgs ? [...this.commandArgs] : undefined;
  }

  show(): void {
    // Backfill linkHandler for already-live terminals that were created before
    // the Electron openExternal handler was added (pre-#156 fix). Without this,
    // OSC 8 link clicks fall through to xterm's confirm() + window.open() no-op.
    if (this.terminal.options && !this.terminal.options.linkHandler) {
      this.terminal.options.linkHandler = {
        activate: (_event: MouseEvent, uri: string) => {
          openUrlViaElectron(uri);
        },
      };
    }
    this.containerEl.removeClass("hidden");
    // Double-rAF: first frame makes the element visible and triggers layout,
    // second frame has correct dimensions for fitAddon to measure.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (this._isDisposed) return;
        this.safeFit();
        // Force a full re-render of all rows. If the renderer changed while
        // the tab was hidden (e.g. WebGL context loss fell back to canvas),
        // xterm may not have painted anything. Refreshing ensures the canvas
        // renderer draws the buffer content.
        this.terminal.refresh(0, this.terminal.rows - 1);
        this.terminal.scrollToBottom();
        this.terminal.focus();
        requestAnimationFrame(() => {
          if (this._isDisposed) return;
          this.recoverBlankRendererIfNeeded();
        });
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
  // Agent state detection
  // ---------------------------------------------------------------------------

  get agentState(): AgentState {
    return this._agentState;
  }

  get claudeState(): AgentState {
    return this.agentState;
  }

  get claudeSessionId(): string | null {
    return this.agentSessionId;
  }

  set claudeSessionId(value: string | null) {
    this.agentSessionId = value;
  }

  get isResumableAgent(): boolean {
    return this._isResumableAgent;
  }

  private getProcessStatus(): TabProcessDiagnostics["status"] {
    if (!this.process) return "missing";
    if (this.process.exitCode !== null || this.process.signalCode !== null) {
      return this.process.signalCode ? "killed" : "exited";
    }
    if (this.process.killed) return "killed";
    return "alive";
  }

  private getRendererCanvasCount(): number {
    const terminalElement = (this.terminal as Terminal & { element?: ParentNode | null })
      .element as ParentNode | null | undefined;
    const renderRoot =
      terminalElement && typeof terminalElement.querySelectorAll === "function"
        ? terminalElement
        : ((this.containerEl as ParentNode | null | undefined) ?? null);
    if (!renderRoot || typeof renderRoot.querySelectorAll !== "function") {
      return 0;
    }
    return renderRoot.querySelectorAll(".xterm-screen canvas").length;
  }

  private redactDiagnosticLine(line: string): string {
    const trimmed = line.trim();
    if (!trimmed) return "";
    return `[redacted:${trimmed.length} chars]`;
  }

  getDiagnostics(): TerminalTabDiagnostics {
    const screenLines = this._readTerminalScreen();
    const processStatus = this.getProcessStatus();
    const trackedWebglAddonPresent = !!this.webglAddon;
    const trackedWebglAddonDisposed = Boolean(
      this.webglAddon && this.getTrackedWebglAddonEntry(this.webglAddon)?.isDisposed,
    );
    const canvasCount = this.getRendererCanvasCount();
    const hasRenderableContent = this.hasRenderableSessionContent();
    const hasBlankRenderSurface = canvasCount === 0;
    const blankButLiveRenderer =
      processStatus === "alive" && hasRenderableContent && hasBlankRenderSurface;
    return {
      tabId: this.id,
      label: this.label,
      sessionId: this.agentSessionId,
      sessionType: this.sessionType,
      claudeState: this.claudeState,
      isResumableAgent: this.isResumableAgent,
      isVisible: this.isVisible,
      isDisposed: this.isDisposed,
      process: {
        pid: typeof this.process?.pid === "number" ? this.process.pid : null,
        status: processStatus,
        killed: this.process?.killed === true,
        exitCode: this.process?.exitCode ?? null,
        signalCode: this.process?.signalCode ?? null,
        spawnTime: this.spawnTime > 0 ? this.spawnTime : null,
        uptimeMs: this.spawnTime > 0 ? Math.max(0, Date.now() - this.spawnTime) : null,
      },
      renderer: {
        canvasCount,
        hasRenderableContent,
        hasBlankRenderSurface,
        trackedWebglAddonPresent,
        trackedWebglAddonDisposed,
        webglSuspended: this._webglSuspended,
        staleDisposedWebglOwnership: trackedWebglAddonPresent && trackedWebglAddonDisposed,
      },
      buffer: {
        screenLineCount: screenLines.length,
        screenTail: screenLines.slice(-6).map((line) => this.redactDiagnosticLine(line)),
      },
      derived: {
        blankButLiveRenderer,
        staleDisposedWebglOwnership: trackedWebglAddonPresent && trackedWebglAddonDisposed,
      },
    };
  }

  /** Start state tracking for Claude/Agent sessions. Call after label is known. */
  startStateTracking(): void {
    this._isResumableAgent = this._detectResumableAgent();
    if (!this._isResumableAgent || this._stateTimer) return;

    // On fresh spawn, assume active. After reload, start as idle to avoid
    // false active flash from stale buffer content.
    this._agentState = this._suppressActiveUntil > 0 ? "idle" : "active";
    if (!this._recentCleanLines) this._recentCleanLines = [];

    // Check state every 2 seconds
    this._stateTimer = setInterval(() => this._checkState(), 2000);
  }

  /** Initialize session tracker for agent sessions that support session tracking. */
  private _initSessionTracker(): void {
    if (!this.agentSessionId) {
      // No session ID yet - check if this agent type supports deferred detection
      this._initDeferredSessionDetector();
      return;
    }
    const { agentType } = sessionTypeToAgentType(this.sessionType);
    const resumeConfig = getResumeConfig(agentType);
    if (!resumeConfig.sessionTracking) return;

    this._sessionTracker = new AgentSessionTracker(this.cwd, this.agentSessionId);
    this._sessionTracker.onSessionChange = (newId) => {
      this.agentSessionId = newId;
      console.log("[work-terminal] Session ID updated via /resume:", newId);
    };
  }

  /**
   * Start deferred session ID detection for agents that discover their session
   * ID from log files after spawn (e.g. Copilot context sessions launched
   * without --resume).
   */
  private _initDeferredSessionDetector(): void {
    const { agentType } = sessionTypeToAgentType(this.sessionType);
    const resumeConfig = getResumeConfig(agentType);
    if (
      !resumeConfig.deferSessionId ||
      !resumeConfig.sessionLogDir ||
      !resumeConfig.sessionLogPattern
    ) {
      return;
    }

    this._sessionDetector = new CopilotSessionDetector({
      logDir: resumeConfig.sessionLogDir,
      logPattern: resumeConfig.sessionLogPattern,
      spawnTime: this.spawnTime,
    });
    this._sessionDetector.onSessionDetected = (sessionId) => {
      this.agentSessionId = sessionId;
      this._isResumableAgent = this._detectResumableAgent();
      console.log("[work-terminal] Deferred session ID detected:", sessionId);
      this._sessionDetector = null;
      // Start state tracking if it was skipped during initial setup
      // (safety net for cases where detector didn't exist yet at startStateTracking time)
      if (this._isResumableAgent && !this._stateTimer) {
        this.startStateTracking();
      }
    };
    this._sessionDetector.start();
  }

  private _detectResumableAgent(): boolean {
    if (!isResumableSessionType(this.sessionType)) return false;
    // Either we already have a session ID, or we're actively detecting one
    return !!this.agentSessionId || !!this._sessionDetector;
  }

  /** Called on each chunk of output data to track activity. */
  private _trackOutput(data: Buffer | string): void {
    if (!this._isResumableAgent) return;

    // Buffer recent clean lines for pattern matching (keep last 30 lines)
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
    if (!this._isResumableAgent) return;

    const screenLines = this._readTerminalScreen();

    // Check for waiting patterns first (highest priority).
    // Suppress waiting if the tab is currently visible - the user can already see it.
    if (this._looksLikeWaiting(screenLines)) {
      this._prevScreenFingerprint = "";
      this._unchangedPolls = 0;
      this._setAgentState("waiting");
      return;
    }

    // Need screen content for idle/active detection
    if (screenLines.length === 0) return;

    // Track buffer content changes: if the visible screen changed since the
    // last poll, the agent is producing output (text streaming, tool results)
    // even when no spinner/ellipsis pattern is visible.
    const fingerprint = screenLines.join("\n");
    const screenChanged =
      this._prevScreenFingerprint !== "" && fingerprint !== this._prevScreenFingerprint;
    this._prevScreenFingerprint = fingerprint;
    if (screenChanged) {
      this._unchangedPolls = 0;
    } else {
      this._unchangedPolls++;
    }

    const hasActiveIndicator = hasAgentActiveIndicator(screenLines);

    if (hasActiveIndicator || screenChanged) {
      // During post-reload grace period, treat "active" as "idle"
      if (Date.now() < this._suppressActiveUntil) {
        this._setAgentState("idle");
      } else {
        this._setAgentState("active");
      }
    } else {
      // Real output clears the suppression early
      this._suppressActiveUntil = 0;
      this._setAgentState("idle");
    }
  }

  /**
   * Check if Claude is waiting for user input by inspecting both the terminal
   * screen buffer and recent output lines.
   */
  private _looksLikeWaiting(screenLines?: string[]): boolean {
    return hasAgentWaitingIndicator(screenLines || [], this._recentCleanLines || []);
  }

  /**
   * Reset the screen fingerprint baseline. Call when the viewed terminal
   * changes (tab/item switch) so the first poll compares against the new
   * content rather than the previous terminal's content.
   */
  resetScreenFingerprint(): void {
    this._prevScreenFingerprint = "";
    this._unchangedPolls = 0;
  }

  /** Clear the waiting state (e.g. when the user activates this tab to respond). */
  clearWaiting(): void {
    if (this._agentState === "waiting") {
      this._setAgentState("idle");
    }
  }

  private _setAgentState(state: AgentState): void {
    if (this._agentState === state) return;
    this._agentState = state;
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
      agentSessionId: this.agentSessionId,
      claudeSessionId: this.claudeSessionId,
      durableSessionId: this.durableSessionId,
      sessionType: this.sessionType,
      profileId: this.profileId,
      profileColor: this.profileColor,
      paramPassMode: this.paramPassMode,
      shell: this.shell,
      cwd: this.cwd,
      commandArgs: this.commandArgs ? [...this.commandArgs] : undefined,
      terminal: this.terminal,
      fitAddon: this.fitAddon!,
      searchAddon: this.searchAddon!,
      webLinksAddon: this.webLinksAddon,
      linkProviderDisposable: this.linkProviderDisposable,
      unicode11Addon: this.unicode11Addon,
      webglAddon: this.webglAddon,
      webglContextLossListener: this.webglContextLossListener,
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
    tab.agentSessionId = stored.agentSessionId ?? stored.claudeSessionId ?? null;
    tab.durableSessionId =
      stored.durableSessionId ||
      (tab.agentSessionId ? null : globalThis.crypto?.randomUUID?.() || null);
    tab.sessionType = stored.sessionType;
    tab.profileId = stored.profileId;
    tab.profileColor = stored.profileColor;
    tab.paramPassMode = stored.paramPassMode;
    tab.shell = stored.shell || process.env.SHELL || "/bin/zsh";
    tab.cwd = stored.cwd || process.env.HOME || "~";
    tab.commandArgs = stored.commandArgs ? [...stored.commandArgs] : undefined;
    tab.terminal = stored.terminal;
    // Ensure linkHandler is set on restored terminals - older sessions or
    // terminals from prior plugin versions may not have this option, causing
    // OSC 8 hyperlink clicks to fall through to xterm's default confirm() +
    // window.open() which is a no-op in Electron/Obsidian.
    if (tab.terminal.options && !tab.terminal.options.linkHandler) {
      tab.terminal.options.linkHandler = {
        activate: (_event: MouseEvent, uri: string) => {
          openUrlViaElectron(uri);
        },
      };
    }
    tab.configureOptionKeyHandling();
    tab.fitAddon = stored.fitAddon;
    tab.searchAddon = stored.searchAddon;
    tab.webLinksAddon = stored.webLinksAddon;
    tab.linkProviderDisposable = stored.linkProviderDisposable ?? null;
    tab.unicode11Addon = stored.unicode11Addon;
    tab.containerEl = stored.containerEl;
    tab.process = stored.process;
    tab.webglAddon = stored.webglAddon ?? null;
    tab.webglContextLossListener = null;
    tab.recoverLegacyAddonRefs();
    // Restore the live webglAddon reference so recovered tabs still dispose it
    // correctly, then re-subscribe onContextLoss with a callback bound to the
    // new tab instance created during reload recovery.
    const restoredWebglAddon = tab.webglAddon;
    stored.webglContextLossListener?.dispose();
    if (restoredWebglAddon) {
      tab.trackWebglAddon(restoredWebglAddon);
    }
    tab._webglSuspended = false;
    tab._documentCleanups = [];
    tab._agentState = "inactive" as AgentState;
    tab._recentCleanLines = [];
    tab._stateTimer = null;
    tab._isResumableAgent = false;
    tab._isDisposed = false;
    tab._sessionTracker = null;
    tab._renameDecoder = new StringDecoder("utf8");
    tab._renameLineBuffer = "";
    tab._renamePattern = /^\s*[^\w]*Session renamed to:\s*(.+?)\s*$/;
    tab.spawnTime = 0;

    // Re-attach container DOM to the new parent
    parentEl.appendChild(stored.containerEl);

    // Re-register keyboard interception
    const bubbleCleanup = attachBubbleCapture(stored.containerEl);
    const captureCleanup = attachCapturePhase(
      stored.containerEl,
      () => tab.process,
      () => tab.toggleSearchBar(),
    );
    tab._documentCleanups = [bubbleCleanup, captureCleanup];

    // Click-to-focus
    const clickHandler = () => {
      stored.terminal.focus();
    };
    stored.containerEl.addEventListener("click", clickHandler);
    tab._documentCleanups.push(() => {
      stored.containerEl.removeEventListener("click", clickHandler);
    });

    // Scroll-to-bottom button
    const scrollCleanup = attachScrollButton(stored.containerEl, stored.terminal, () => {
      tab._userScrolledUp = false;
    });
    tab._documentCleanups.push(scrollCleanup);

    // User-initiated scroll detection
    tab._wireUserScrollDetection();

    // Re-attach resize observer - debounced to avoid fitting during transitions
    stored.resizeObserver.disconnect();
    tab._resizeDebounce = null;
    tab.resizeObserver = new ResizeObserver(() => {
      if (tab._isDisposed) return;
      if (stored.containerEl.hasClass("hidden")) return;
      if (tab._resizeDebounce) clearTimeout(tab._resizeDebounce);
      tab._resizeDebounce = setTimeout(() => {
        if (tab._isDisposed) return;
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
      if (tab._isDisposed) return;
      stored.terminal.scrollToBottom();
    });

    return tab;
  }

  private recoverLegacyAddonRefs(): void {
    const addonEntries = (this.terminal as TerminalWithAddonManager)._addonManager?._addons;
    if (!addonEntries?.length) return;
    for (const addonEntry of addonEntries) {
      const addon = addonEntry.instance;
      if (!addon) continue;
      if (this.isLegacyFitAddon(addon)) {
        this.fitAddon ??= addon;
        continue;
      }
      if (this.isLegacySearchAddon(addon)) {
        this.searchAddon ??= addon;
        continue;
      }
      if (this.isLegacyWebLinksAddon(addon)) {
        this.webLinksAddon ??= addon;
        continue;
      }
      if (this.isLegacyWebglAddon(addon)) {
        if (!this.webglAddon) {
          this.webglAddon = addon;
        }
        continue;
      }
      if (this.isLegacyUnicode11Addon(addon)) {
        this.unicode11Addon ??= addon;
      }
    }
  }

  private isLegacyFitAddon(addon: unknown): addon is FitAddon {
    if (!addon || typeof addon !== "object") return false;
    return (
      typeof (addon as { fit?: unknown }).fit === "function" &&
      typeof (addon as { proposeDimensions?: unknown }).proposeDimensions === "function"
    );
  }

  private isLegacySearchAddon(addon: unknown): addon is SearchAddon {
    if (!addon || typeof addon !== "object") return false;
    return (
      typeof (addon as { findNext?: unknown }).findNext === "function" &&
      typeof (addon as { findPrevious?: unknown }).findPrevious === "function" &&
      typeof (addon as { clearDecorations?: unknown }).clearDecorations === "function"
    );
  }

  private isLegacyWebLinksAddon(addon: unknown): addon is WebLinksAddon {
    if (!addon || typeof addon !== "object") return false;
    return (
      typeof (addon as { activate?: unknown }).activate === "function" &&
      typeof (addon as { dispose?: unknown }).dispose === "function" &&
      "_handler" in addon &&
      "_options" in addon
    );
  }

  private isLegacyUnicode11Addon(addon: unknown): addon is Unicode11Addon {
    if (!addon || typeof addon !== "object") return false;
    if (
      this.isLegacyFitAddon(addon) ||
      this.isLegacySearchAddon(addon) ||
      this.isLegacyWebLinksAddon(addon) ||
      this.isLegacyWebglAddon(addon)
    ) {
      return false;
    }
    const activate = (addon as { activate?: unknown }).activate;
    return typeof activate === "function" && activate.toString().includes("unicode.register");
  }

  private isLegacyWebglAddon(addon: unknown): addon is WebglAddon {
    if (!addon || typeof addon !== "object") return false;
    return (
      typeof (addon as { clearTextureAtlas?: unknown }).clearTextureAtlas === "function" &&
      "onContextLoss" in addon
    );
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  dispose(): void {
    if (this._isDisposed) return;
    this._isDisposed = true;
    // Stop session tracker and deferred session detector
    this._sessionTracker?.dispose();
    this._sessionTracker = null;
    this._sessionDetector?.dispose();
    this._sessionDetector = null;
    // Stop state tracking
    if (this._stateTimer) {
      clearInterval(this._stateTimer);
      this._stateTimer = null;
    }
    if (this._resizeDebounce) {
      clearTimeout(this._resizeDebounce);
      this._resizeDebounce = null;
    }
    if (this._spawnTimeout) {
      clearTimeout(this._spawnTimeout);
      this._spawnTimeout = null;
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
    this.disposeAddonsBeforeTerminal();
    this.terminal.dispose();
    // Container may already have been removed from DOM by orphan cleanup
    if (this.containerEl.parentElement) {
      this.containerEl.remove();
    }
  }

  private disposeAddonsBeforeTerminal(): void {
    // Dispose addons before terminal.dispose() so they can clean up while
    // xterm's internal services (renderer, buffer) are still alive.
    // Disposing in reverse load order mirrors standard teardown conventions.
    if (this.linkProviderDisposable) {
      this.linkProviderDisposable.dispose();
      this.linkProviderDisposable = null;
    } else {
      // Hot-reload sessions stashed before the link-provider disposable was
      // tracked still carry the custom provider inside xterm's private
      // service registry. Clear that registry before terminal.dispose() so the
      // provider cannot outlive the buffer teardown sequence.
      (this.terminal as TerminalWithAddonManager)._linkProviderService?.linkProviders.splice(0);
    }
    this.detachTrackedWebglAddon();
    this.unicode11Addon?.dispose();
    this.unicode11Addon = undefined;
    this.webLinksAddon?.dispose();
    this.webLinksAddon = undefined;
    this.searchAddon?.dispose();
    this.searchAddon = undefined;
    this.fitAddon?.dispose();
    this.fitAddon = undefined;
  }

  private detachTrackedWebglAddon(targetAddon: WebglAddon | null = this.webglAddon): void {
    const webglAddon = targetAddon;
    this.disposeWebglContextLossListener();
    if (this.webglAddon === webglAddon) {
      this.webglAddon = null;
    }
    if (!webglAddon) return;

    const addonEntries = (this.terminal as TerminalWithAddonManager)._addonManager?._addons;
    if (!addonEntries?.length) return;

    const addonIndex = addonEntries.findIndex((entry) => entry.instance === webglAddon);
    if (addonIndex !== -1) {
      addonEntries.splice(addonIndex, 1);
    }
  }
}
