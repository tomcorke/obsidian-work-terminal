## Why

Phase 2 builds the core infrastructure that makes `obsidian-work-terminal` a real terminal plugin rather than a smoke-test shell. The original plugin's terminal, Claude integration, and session persistence code was battle-tested but monolithic - a single 740-line `TerminalTab.ts` handling PTY spawning, keyboard capture, xterm CSS injection, scroll buttons, ANSI processing, state detection, and session rename all in one class.

Phase 2 extracts this into clean, focused modules: terminal primitives (PTY, keyboard, resize, CSS), Claude-specific logic (launcher, state detector, session rename, headless spawning), and session persistence (window-global hot-reload stash, versioned disk persistence with resume). This separation is what makes the adapter architecture work - the framework owns Claude integration, and adapters never touch terminal internals.

## What Changes

- Port terminal primitives as standalone modules: `XtermCss.ts` (singleton CSS injection), `ScrollButton.ts` (scroll-to-bottom overlay), `KeyboardCapture.ts` (two-layer Obsidian keystroke interception with escape sequence synthesis)
- Port `TerminalTab.ts` core: Python PTY spawning via `pty-wrapper.py`, xterm.js wiring, custom OSC resize protocol, `onOutputData` callback, 150ms spawn delay, double-rAF on show, 3s early-exit keep-alive, SIGTERM/SIGKILL dispose
- Build `TabManager.ts`: tab groups keyed by item ID, session type tracking (shell / claude / claude-with-context), tab bar rendering, drag-drop reordering, create/close/switch
- Build Claude integration: `ClaudeLauncher.ts` (binary resolution via `resolveCommand()`, PATH augmentation for Electron, arg building from settings), `ClaudeStateDetector.ts` (xterm buffer reading via cursor position, spinner/waiting/idle detection, multi-line question detection, state aggregation), `ClaudeSessionRename.ts` (output stream monitoring with three-stage ANSI stripping, StringDecoder for UTF-8 chunks, adapter hook), `HeadlessClaude.ts` (utility for adapter background operations)
- Build session persistence: `SessionStore.ts` (window-global `__taskTerminalStore` stash/retrieve for hot-reload), `SessionPersistence.ts` (disk persistence with `version: 1`, 7-day retention, UUID session IDs, `--resume` support, 5s grace period on resume failure)
- Write vitest tests for `ClaudeStateDetector`, `stripAnsi`, state aggregation, session serialization round-trips

## Capabilities

### New Capabilities
- `terminal-core`: PTY spawning, xterm.js terminal rendering, keyboard interception, resize protocol, scroll-to-bottom button, and terminal lifecycle management
- `claude-integration`: Claude CLI binary resolution, state detection from xterm buffer, session rename monitoring, and headless Claude spawning utility
- `session-persistence`: Two-tier session persistence - window-global stash for hot-reload survival and versioned disk persistence for session resume across plugin restarts
- `tab-management`: Tab groups keyed by work item ID with session type tracking, tab bar UI, drag-drop reordering, and active tab memory

### Modified Capabilities
(none)

## Impact

- **New files**: 10 source modules in `src/core/terminal/`, `src/core/claude/`, `src/core/session/`
- **New test files**: Tests for ClaudeStateDetector, stripAnsi, state aggregation, session serialization
- **Dependencies**: Relies on Phase 0 (`pty-wrapper.py`, esbuild, project scaffold) and Phase 1 (`utils.ts` for expandTilde/stripAnsi, `interfaces.ts` for type definitions)
- **No framework or adapter code**: This phase builds core infrastructure only - framework wiring (TerminalPanelView, state aggregation UI) comes in Phase 3
