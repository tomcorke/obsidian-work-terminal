## 1. Terminal Primitives

- [ ] 1.1 Create `src/core/terminal/XtermCss.ts` - singleton CSS injection with `xterm-css` style element and guard flag
- [ ] 1.2 Create `src/core/terminal/ScrollButton.ts` - scroll-to-bottom overlay button with viewport tracking, click handler, and existing-button cleanup on reload
- [ ] 1.3 Create `src/core/terminal/KeyboardCapture.ts` - two-layer keyboard interception: bubble-phase stopPropagation on container, capture-phase escape sequence synthesis for Shift+Enter (`\x1b[13;2u`), Option+Arrow (`\x1bb`/`\x1bf`), Option+Backspace (`\x1b\x7f`), Option+d (`\x1bd`). Only intercepts when terminal helper textarea is focused.

## 2. Terminal Tab Core

- [ ] 2.1 Create `src/core/terminal/TerminalTab.ts` - xterm.js + PTY spawn via `pty-wrapper.py`. Includes: 150ms spawn delay, tilde expansion, timestamp+counter unique IDs, macOptionIsMeta, ResizeObserver with rAF and hidden-skip, silent fitAddon error catching, double-rAF on show(), custom OSC resize protocol (`ESC]777;resize;COLS;ROWS BEL`), SIGTERM/SIGKILL dispose, 3s early-exit keep-alive, screen reading via `baseY + cursorY`, onOutputData callback, onLabelChange/onProcessExit/onStateChange hooks
- [ ] 2.2 Implement `stash()` method - extract live state (Terminal, FitAddon, containerEl, process, documentListeners, ResizeObserver) into StoredSession, stop state timer during stash
- [ ] 2.3 Implement `fromStored()` static method - restore TerminalTab from StoredSession: re-attach DOM, re-register keyboard listeners, reconnect ResizeObserver, re-create scroll button, set `_suppressActiveUntil = Date.now() + 2000`

## 3. Claude Integration

- [ ] 3.1 Create `src/core/claude/ClaudeLauncher.ts` - `resolveCommand()` for Claude binary resolution via augmented PATH (prepend `~/.local/bin`, `~/.nvm/versions/node/current/bin`, `/usr/local/bin`, `/opt/homebrew/bin`, deduplicate with Set). Arg building from settings: claudeCommand, claudeExtraArgs (split on whitespace), additionalAgentContext appended to prompt. Session ID passed as `--session-id <uuid>`.
- [ ] 3.2 Create `src/core/claude/ClaudeStateDetector.ts` - reads xterm buffer via cursor position (baseY + cursorY, not buffer bottom). Checks last 6 lines for active indicators: spinner `*` + ellipsis, tool output `⎿` + ellipsis. Waiting detection: "Enter to select", permission prompts, numbered options with `?` within 5 lines, generic `?`-ending lines near bottom. State check every 2s. Visible tab suppresses waiting to idle. 2s active suppression after reload. Pre-seeded idleSince on reload (`Date.now() - 300_000`).
- [ ] 3.3 Create `src/core/claude/ClaudeSessionRename.ts` - output stream monitoring for `Session renamed to:` pattern. Three-stage ANSI stripping: CSI cursor-forward to spaces, then strip remaining sequences. StringDecoder for UTF-8 multi-byte chars across chunks. Checks both complete lines and incomplete buffer. Calls adapter `transformSessionLabel?()` hook.
- [ ] 3.4 Create `src/core/claude/HeadlessClaude.ts` - `spawnHeadlessClaude(prompt, cwd)` utility using ClaudeLauncher for binary resolution and PATH augmentation

## 4. Tab Manager

- [ ] 4.1 Create `src/core/terminal/TabManager.ts` - tab groups keyed by work item ID, session type tracking (shell / claude / claude-with-context), active tab memory per work item, recovered tab index precedence, tab create/close/switch with show/hide coordination
- [ ] 4.2 Implement tab drag-drop reordering - accent border drop indicator, active tab follows moved tab, persisted new order
- [ ] 4.3 Implement state aggregation helper - priority: waiting > active > idle > inactive, short-circuit on first waiting

## 5. Session Persistence

- [ ] 5.1 Create `src/core/session/types.ts` - StoredSession type (live objects for hot-reload), PersistedSession type (serializable for disk, includes `version: 1`)
- [ ] 5.2 Create `src/core/session/SessionStore.ts` - window-global stash (`window.__taskTerminalStore`), retrieve-and-delete pattern, stores active task path and tab index
- [ ] 5.3 Create `src/core/session/SessionPersistence.ts` - disk persistence to data.json with loadData-merge-saveData pattern. UUID session IDs for `--session-id`. 7-day retention for Claude sessions. `--resume` support. 5s grace period before cleanup on resume failure. Persist on spawn and close.

## 6. Tests

- [ ] 6.1 Write tests for ClaudeStateDetector: spinner -> active, tool output -> active, prompts -> waiting, clean screen -> idle, state aggregation priority, last-6-lines constraint, visible tab suppresses waiting
- [ ] 6.2 Write tests for ANSI stripping: cursor-forward to spaces preserving alignment, multi-stage strip, multi-byte UTF-8 handling via StringDecoder
- [ ] 6.3 Write tests for session serialization: round-trip preserves all fields, version field present, 7-day retention prunes old sessions

## 7. Integration Verification

- [ ] 7.1 Build project and verify no TypeScript compilation errors
- [ ] 7.2 Load plugin in Obsidian and verify xterm terminal renders correctly
- [ ] 7.3 Verify Claude session spawns and renders in Obsidian (binary resolution, PTY wiring, output display)
- [ ] 7.4 Verify hot-reload preserves terminal sessions via window-global stash
