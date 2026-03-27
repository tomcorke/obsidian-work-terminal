## Context

Phase 2 ports the core terminal infrastructure and Claude integration from the original `obsidian-task-terminal` plugin into clean, modular components for `obsidian-work-terminal`. The original code is battle-tested across 40 commits but lives in monolithic files - `TerminalTab.ts` (740 lines) handles everything from PTY spawning to Claude state detection, and `TerminalPanel.ts` mixes tab management with session persistence and state aggregation.

This phase extracts that code into focused modules under three directories: `src/core/terminal/` (xterm + PTY primitives), `src/core/claude/` (Claude CLI integration), and `src/core/session/` (persistence). The framework layer (Phase 3) will compose these modules into Obsidian views.

Phase 2 depends on Phase 0 (repo, build, `pty-wrapper.py`) and Phase 1 (`utils.ts` with `expandTilde`/`stripAnsi`/`electronRequire`, `interfaces.ts` with type definitions).

## Goals / Non-Goals

**Goals:**
- Port all terminal primitives with full fidelity to the original plugin's battle-tested behaviour
- Separate Claude-specific logic from generic terminal infrastructure so the adapter boundary works cleanly
- Establish session persistence with forward-compatible versioning (`version: 1`) from day one
- Write tests for pure-logic components: state detection, ANSI stripping, state aggregation, session serialization
- Verify xterm + Claude session renders correctly in Obsidian

**Non-Goals:**
- Building the framework UI layer (TerminalPanelView, tab bar buttons, state badge CSS) - that is Phase 3
- Building adapter-specific features (task cards, prompt builders) - that is Phase 4
- Tab inline rename UI or context menus - those are framework concerns in Phase 3
- CSS for state indicators (idle arc, waiting glow) - Phase 3

## Decisions

### D1: Python PTY wrapper ported as-is

**Choice**: Copy `pty-wrapper.py` directly from the original plugin (done in Phase 0). All terminal spawning goes through it.

**Rationale**: Electron blocks `pty.spawn()`. Python `pty.fork()` is the only viable workaround. The wrapper handles resize via custom OSC sequence interception, stdin buffering (only holds back potential resize sequence starts, not regular CSI escapes), login shell wrapping for non-shell commands, post-exit output flush, and SIGWINCH to process group. This code is non-negotiable and proven.

### D2: Two-layer keyboard interception

**Choice**: `KeyboardCapture.ts` implements both bubble-phase `stopPropagation` on the terminal container AND capture-phase interception on `document` for specific modifier combos.

**Rationale**: Obsidian has both bubble-phase and capture-phase keyboard handlers. Bubble-phase alone misses Shift+Enter, Option+Arrow, Option+Backspace which Obsidian captures before they reach xterm. The capture-phase handler synthesizes terminal escape sequences directly to PTY stdin (e.g. `\x1b[13;2u` for Shift+Enter, `\x1bb`/`\x1bf` for Option+Arrow) then kills the event. This is the proven two-layer approach from the original plugin.

### D3: State detection reads xterm buffer, not stdout

**Choice**: `ClaudeStateDetector` reads the terminal's rendered screen buffer via `buffer.active` using cursor position (`baseY + cursorY`), not raw stdout data.

**Rationale**: Claude's status bar redraws produce continuous stdout output even when idle. Classifying raw output would false-positive on these redraws. Reading the rendered screen at the cursor position captures what the user actually sees. Only the last 6 lines are checked for active indicators (spinner `*` with ellipsis, tool output `⎿` with ellipsis) to avoid false-positives on Claude's response text.

### D4: Three-stage ANSI stripping for session rename detection

**Choice**: `ClaudeSessionRename.ts` uses a three-stage strip: (1) replace CSI cursor-forward sequences with equivalent spaces to preserve text alignment, (2) strip all remaining ANSI/control sequences, (3) use `StringDecoder` for UTF-8 multi-byte characters split across data chunks.

**Rationale**: Simple ANSI stripping breaks TUI output alignment because cursor-forward sequences (`ESC[nC`) represent whitespace. The first pass converts them to spaces before the second pass strips control sequences. StringDecoder handles characters like `+` split across chunk boundaries. Both complete lines and the incomplete buffer are checked for rename patterns, since Claude may return to waiting without a trailing newline after `/rename`.

### D5: Window-global stash for hot-reload, disk persistence for resume

**Choice**: Two-tier persistence. `SessionStore` uses `window.__taskTerminalStore` (read-once, deleted after retrieval) for hot-reload. `SessionPersistence` writes to Obsidian's `data.json` with `version: 1` schema, 7-day retention, and UUID-based `--session-id` for Claude `--resume`.

**Rationale**: Hot-reload needs to preserve live PTY/xterm/DOM objects which cannot be serialized to disk. Window-global stash survives module re-evaluation. Disk persistence handles plugin restart/Obsidian restart where live objects are gone but Claude sessions can be resumed by UUID. The 5s grace period before cleanup on resume failure allows retry if the process exits immediately due to bad args.

### D6: State aggregation priority order

**Choice**: When aggregating state across multiple tabs for a single work item: `waiting > active > idle > inactive`. Short-circuits on first `waiting`.

**Rationale**: Waiting is the most actionable state (user input needed). Active means work is happening. Idle means nothing is happening. Inactive means no Claude sessions. This priority ensures the most important state surfaces to the framework's badge rendering.

### D7: Post-reload active suppression

**Choice**: After restoring a session from stash, suppress "active" detection for 2 seconds (`_suppressActiveUntil`). During this grace period, active detections are downgraded to idle. Pre-seed `idleSince` to `Date.now() - 300_000` so idle animations start fully stale.

**Rationale**: Stale xterm buffer content after reload contains active indicators from the last render, triggering a false active flash on all cards. The 2s suppression lets the buffer update with fresh content. Pre-seeding idleSince prevents idle animations from replaying from the start on every reload.

## Risks / Trade-offs

- **[Risk] Claude CLI output format changes** - State detection and session rename detection depend on specific Claude CLI output patterns (spinner `*` with ellipsis, `⎿` with ellipsis, "Session renamed to:" line format). If Claude CLI updates change these patterns, detection breaks silently. Mitigation: document exact patterns and the Claude CLI version they were tested against. Tests pin expected patterns.
- **[Risk] Session persistence format migration** - The `version: 1` schema must remain forward-compatible. If Phase 3 or later needs additional fields, they must be additive. Mitigation: versioned from day one; deserializer checks version and can migrate.
- **[Trade-off] Porting vs rewriting** - Terminal primitives (PTY, keyboard, resize) are ported with minimal changes rather than rewritten. This preserves battle-tested edge case handling but carries forward any latent bugs. Accepted: the original code has been running in production for weeks with no terminal-related bugs.
- **[Trade-off] Python dependency** - The PTY wrapper requires Python 3 on the user's system. Accepted: macOS ships with Python 3, and there is no viable pure-Node alternative in Electron's sandbox.
- **[Risk] StringDecoder chunk boundary edge cases** - Multi-byte UTF-8 characters split across data chunks could theoretically produce false rename detections on partial matches. Mitigation: the rename pattern is anchored to start-of-line and requires the full "Session renamed to:" prefix.
