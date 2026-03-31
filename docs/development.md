# Development

[Back to README](../README.md)

## Build and test

```bash
npm run build          # production build
npm run dev            # watch mode with CDP hot-reload
npx vitest run         # run tests
```

- **Output**: esbuild outputs `main.js` to repo root. `manifest.json` and `styles.css` already at repo root.
- **Vault link**: `.obsidian/plugins/work-terminal` is a symlink to this repo directory. No copy step.
- When packaging or distributing the plugin, keep `pty-wrapper.py` in the plugin directory alongside `main.js`, `manifest.json`, and `styles.css`.

## Hot reload

Requires Obsidian with remote debugging: `open -a Obsidian --args --remote-debugging-port=9222`

**Important**: Never reload via raw `app.plugins.disablePlugin/enablePlugin` or Cmd+R - these destroy terminal sessions. Always use:

- `npm run dev` watch mode (preferred - auto-reloads on save)
- Command palette: "Work Terminal: Reload Plugin (preserve terminals)"
- CDP: `node cdp.js`

## CDP helper

`node cdp.js '<expression>'` evaluates JS in Obsidian's renderer. Default (no arguments): triggers hot-reload. Also supports:

- `node cdp.js open-view`
- `node cdp.js wait-for '.wt-main-layout'`
- `node cdp.js click '.wt-task-card'`
- `node cdp.js type 'textarea' 'hello from automation'`
- `node cdp.js screenshot output/work-terminal.png --selector '.wt-main-layout'`

Use `--port` or `OBSIDIAN_REMOTE_DEBUG_PORT` if you need a non-default debugger port.

## Isolated test vault

- `npm run obsidian:test:init` creates `.claude/testing/obsidian-vault/` with:
  - `.obsidian/plugins/work-terminal` symlinked to this worktree
  - Community plugin enablement files
  - Seed task data under `2 - Areas/Tasks/`
- `npm run obsidian:test:open` launches a fresh Obsidian app instance against that vault on CDP port `9222` and opens the Work Terminal view.
- `node scripts/obsidian-isolated-instance.js status` inspects the configured vault without creating or modifying it.

The launcher fails fast if the debugger port is already occupied, and stops early with a singleton warning when another Obsidian app process is already running.

## Known constraints

- **PTY**: Electron sandbox blocks pty.spawn. Python `pty.fork()` via `pty-wrapper.py` is the workaround. Non-negotiable.
- **xterm.js CSS**: `require.resolve` unavailable in bundle. Full CSS embedded inline at runtime via `XtermCss.ts`.
- **Tilde expansion**: Always expand `~` via `process.env.HOME` before passing to spawn.
- **Node builtins**: Use `window.require` for `child_process`, `fs`, `path`, `os` in Electron. Externalized in esbuild.
- **Resize protocol**: `ESC]777;resize;COLS;ROWS BEL` through stdin; pty-wrapper.py intercepts and applies.
- **Keyboard capture**: Two layers (bubble + capture phase) intercept keys before Obsidian. Option+Arrow, Option+B/F/D, Shift+Enter, Option+Backspace, Cmd+Left/Right. xterm keeps Meta behavior by default, while Option+digit printable combos are preserved for layout-specific characters.
- **State detection reads xterm buffer, not stdout**: Immune to status line redraws. Checks last 6 visual lines. Handles narrow terminal wrapping via joined-tail fallback.
- **Session persistence**: Two tiers - window-global stash for hot-reload (survives module re-evaluation), disk persistence for full restart (7-day retention, UUID-based resume). Copilot restart resume uses native `--resume[=sessionId]`; Claude still needs hooks if users trigger Claude's in-app `/resume` and change session IDs.
