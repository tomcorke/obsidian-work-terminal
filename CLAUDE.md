# obsidian-work-terminal

Obsidian plugin: modular work item board with per-item tabbed terminals and adapter-based extensibility.

## Development workflow

- **Build**: `npm run build` (production) or `npm run dev` (watch mode)
- **Output**: esbuild outputs `main.js` to repo root. `manifest.json` and `styles.css` are already at repo root.
- **Vault link**: The vault's `.obsidian/plugins/work-terminal` is a symlink to this repo directory. No copy step needed.
- **Hot reload**: In watch mode, esbuild triggers reload via CDP. Requires Obsidian with `open -a Obsidian --args --remote-debugging-port=9222`.

**IMPORTANT**: Never reload via raw `app.plugins.disablePlugin/enablePlugin` or Cmd+R - these destroy terminal sessions. Always use:
- `npm run dev` watch mode (preferred - auto-reloads on save)
- Command palette: "Work Terminal: Reload Plugin (preserve terminals)"
- CDP: `node cdp.js`

## Commit discipline

Commit each discrete change individually with a clear message. Do not batch unrelated changes.

## Architecture

Three-layer design: core (terminal/Claude), framework (Obsidian plugin), adapters (work item implementations).

Source: `src/`
- Phase 0: `src/main.ts` - minimal smoke test plugin
- Build: `esbuild.config.mjs` (bundles to plugin dir), `cdp.js` (CDP helper)
- PTY: `pty-wrapper.py` (Python PTY allocator at repo root)

## Known constraints

- **PTY**: Electron sandbox blocks pty.spawn. Python `pty.fork()` via `pty-wrapper.py` is the workaround.
- **xterm.js CSS**: `require.resolve` unavailable in bundle. Full CSS embedded inline at runtime.
- **Tilde expansion**: Always expand `~` via `process.env.HOME` before passing to spawn.
- **Node builtins**: Use `window.require` for `child_process`, `fs`, `path`, `os` in Electron. Externalized in esbuild.
- **Resize protocol**: `ESC]777;resize;COLS;ROWS BEL` through stdin; pty-wrapper.py intercepts and applies.
