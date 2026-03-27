## Context

This is Phase 0 of a multi-phase rewrite of `obsidian-task-terminal` into a new plugin `obsidian-work-terminal`. The original plugin uses esbuild for bundling, a Python PTY wrapper for terminal spawning (Electron blocks `pty.spawn`), and CDP (Chrome DevTools Protocol) for hot-reload during development. These patterns are battle-tested and will be ported directly.

The new plugin builds to `~/working/obsidian/test-vault/Test/.obsidian/plugins/work-terminal/` and can run alongside the original plugin during development.

Key technical constraints from the original plugin that carry forward:
- Electron sandbox blocks `pty.spawn` - Python `pty.fork()` via `pty-wrapper.py` is the workaround
- `require.resolve` is unavailable in the bundled context - xterm.js CSS must be embedded inline
- Node builtins must be externalized in esbuild (`child_process`, `fs`, `path`, `os`, `string_decoder`) and accessed via `window.require` at runtime
- Obsidian uses `~` in paths - always expand via `process.env.HOME` before passing to spawn
- Terminal resize uses a custom OSC protocol (`ESC]777;resize;COLS;ROWS BEL`) intercepted by the PTY wrapper

## Goals / Non-Goals

**Goals:**
- Create the GitHub repo and clone locally
- Scaffold all project configuration files with correct settings for the `work-terminal` plugin ID
- Port esbuild config updated for the new plugin ID, output path, and CSS approach (`wt-` prefix, no CSS modules)
- Port `cdp.js` updated for the new plugin command ID
- Port `pty-wrapper.py` as-is (battle-tested, no changes needed)
- Create `CLAUDE.md` documenting project rules, build workflow, and architecture constraints
- Implement the smallest possible working plugin: an `ItemView` subclass that registers with Obsidian and renders a split layout container with one xterm.js terminal
- Verify the full loop: esbuild build succeeds, plugin loads in Obsidian, terminal renders, CDP hot-reload works

**Non-Goals:**
- Any adapter or framework architecture (Phase 1+)
- Tab management, session persistence, or Claude integration (Phase 2+)
- Task parsing, kanban board, or task operations (Phase 3-4)
- Tests (Phase 1 introduces vitest)
- CSS styling beyond what xterm.js needs to render

## Decisions

### D1: Port build tooling directly from original

**Decision:** Port `esbuild.config.mjs` and `cdp.js` from the original plugin with minimal changes (plugin ID, output path).

**Rationale:** The esbuild config handles Obsidian-specific externals (obsidian, electron, codemirror, lezer), the copy-assets plugin for deploying to the vault, and CDP hot-reload triggering. This is all battle-tested. The only changes needed are: plugin dir path (`plugins/work-terminal` instead of `plugins/task-terminal`), command ID (`work-terminal:reload-plugin`), and removing any CSS module handling.

### D2: Port pty-wrapper.py as-is

**Decision:** Copy `pty-wrapper.py` without modifications.

**Rationale:** The PTY wrapper handles stdin buffering for resize sequences, login/interactive shell wrapping, post-exit output flushing, process group SIGWINCH, and 50ms select timeout for responsive signal handling. These are all subtle behaviours discovered through debugging. No reason to change any of it.

### D3: CSS approach - `wt-` prefix, no CSS modules

**Decision:** Use a `wt-` class name prefix for all plugin CSS instead of CSS modules.

**Rationale:** Resolved design decision #9. CSS modules add build complexity (esbuild plugin, import handling) for a plugin where class name collisions are manageable with a short prefix. The `wt-` prefix is short, unique, and simple. The esbuild config stays simpler without needing a CSS modules plugin.

### D4: Smoke test scope - minimal ItemView with one terminal

**Decision:** The Phase 0 smoke test is the smallest possible working plugin: a registered `ItemView` that renders a container div with one xterm.js terminal instance.

**Rationale:** This proves the entire toolchain works end-to-end (TypeScript compilation, esbuild bundling, Obsidian plugin loading, xterm.js rendering, PTY spawning) without building any of the framework or adapter architecture. The split layout is just two divs with a basic flex arrangement - enough to visually confirm the terminal renders in the right place.

### D5: styles.css as empty placeholder

**Decision:** Ship an empty `styles.css` file. The esbuild config copies it to the plugin dir on each build.

**Rationale:** The original plugin's esbuild config copies `styles.css` alongside `manifest.json`. Keeping this pattern means the build config works identically. Actual CSS will be added in later phases. xterm.js CSS is injected inline at runtime (not via styles.css) due to the `require.resolve` limitation.

## Risks / Trade-offs

- **[PTY wrapper Python dependency]** The plugin requires Python 3 on the user's system. This is a known constraint inherited from the original plugin - there is no pure-Node alternative that works within Electron's sandbox. macOS ships with Python 3.
- **[CDP port assumption]** The hot-reload mechanism assumes Obsidian is launched with `--remote-debugging-port=9222`. If the port is different or CDP is not available, hot-reload fails silently and the developer must reload manually. This matches the original plugin's behaviour.
- **[xterm.js inline CSS]** Embedding the full xterm.js CSS as a string in the bundle increases bundle size but is the only viable approach given `require.resolve` unavailability. This is the same approach used by the original plugin.
