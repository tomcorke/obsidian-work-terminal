# Development

[Back to README](../README.md)

## Build and test

```bash
pnpm run build          # production build
pnpm run dev            # watch mode with CDP hot-reload
pnpm exec vitest run         # run tests
```

- **Output**: esbuild outputs `main.js` to repo root. `manifest.json` and `styles.css` already at repo root.
- **Vault link**: `.obsidian/plugins/work-terminal` is a symlink to this repo directory. No copy step.
- When packaging or distributing the plugin, keep `pty-wrapper.py` in the plugin directory alongside `main.js`, `manifest.json`, and `styles.css`.

## Hot reload

Requires Obsidian with remote debugging: `open -a Obsidian --args --remote-debugging-port=9222`

**Important**: Never reload via raw `app.plugins.disablePlugin/enablePlugin` or Cmd+R - these destroy terminal sessions. Always use:

- `pnpm run dev` watch mode (preferred - auto-reloads on save)
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

The isolated launcher creates a temporary vault with the plugin installed, launches a
separate Obsidian instance (independent of your main one), and connects via CDP for
automation and screenshots.

**WARNING**: Launching briefly steals user focus (~2-3 seconds) while Obsidian starts
up before the window is hidden. This must NOT be triggered automatically - only with
explicit user consent for testing or bug replication.

### Quick start

Each isolated instance should use its own vault directory to avoid conflicts:

```bash
# 1. Create a dedicated vault and launch Obsidian
pnpm run obsidian:test:open -- --vault .claude/testing/my-test --clean

# 2. Interact via CDP using the port from the JSON output
CDP_PORT=<port> node cdp.js screenshot output/test.png
CDP_PORT=<port> node cdp.js click '.wt-task-card'

# 3. Stop the isolated instance when done
pnpm run obsidian:test:stop -- --vault .claude/testing/my-test
# Or kill by PID from the JSON output: kill <pid>
```

Using `--vault` with a unique name per test scenario keeps instances isolated from
each other. The default vault (`.claude/testing/obsidian-vault`) works for one-off
debugging but should not be shared across concurrent instances.

### Step by step

#### 1. Create the vault

`pnpm run obsidian:test:init` creates `.claude/testing/obsidian-vault/` with:
- `.obsidian/plugins/work-terminal` symlinked to this repo
- Community plugin enablement config
- Two seed tasks under `2 - Areas/Tasks/` (one active, one todo)

Use `--clean` to wipe and recreate, `--no-sample-data` to skip seed tasks.

#### 2. Seed test content via the filesystem

Create tasks directly as markdown files - do NOT use the "New task" UI or agent
sessions unless explicitly testing those features:

```bash
VAULT=".claude/testing/my-test"  # match the --vault path used at launch

# Create a priority task
cat > "$VAULT/2 - Areas/Tasks/priority/TASK-test-priority.md" << 'EOF'
---
id: test-priority-001
tags:
  - task
  - task/priority
state: priority
title: "Test priority task"
source:
  type: prompt
  id: "test"
  url: ""
  captured: 2026-01-01T00:00:00Z
priority:
  score: 90
  deadline: "2026-04-01"
  impact: high
  has-blocker: false
  blocker-context: ""
agent-actionable: false
goal: []
related: []
created: 2026-01-01T00:00:00Z
updated: 2026-01-01T00:00:00Z
---
# Test priority task

Test content for isolated UI verification.
EOF

# Create an active task with a blocker
cat > "$VAULT/2 - Areas/Tasks/active/TASK-test-blocked.md" << 'EOF'
---
id: test-blocked-001
tags:
  - task
  - task/active
state: active
title: "Blocked test task"
source:
  type: prompt
  id: "test"
  url: ""
  captured: 2026-01-01T00:00:00Z
priority:
  score: 40
  deadline: ""
  impact: medium
  has-blocker: true
  blocker-context: "Waiting on upstream API"
agent-actionable: false
goal: []
related: []
created: 2026-01-01T00:00:00Z
updated: 2026-01-01T00:00:00Z
---
# Blocked test task

Test content for blocker badge verification.
EOF
```

After writing files, reload the plugin or wait for Obsidian's file watcher to pick
them up. The kanban board updates automatically when vault files change.

#### 3. Launch the isolated instance

```bash
# Use a unique vault name per test scenario
pnpm run obsidian:test:open -- --vault .claude/testing/my-test --clean
```

This:
1. Creates/resets the test vault with plugin symlink and seed tasks
2. Pre-seeds the Electron user-data-dir so Obsidian opens the vault directly
3. Launches Obsidian on a random free port (9300-9399) via direct binary
4. Waits for CDP, dismisses the "Trust author" dialog on first run
5. Hides the window via CDP
6. Opens the Work Terminal view
7. Prints JSON with `vaultDir`, `port`, `pid`, `userDataDir`

Use `--no-hide` to keep the window visible for visual debugging. Use `--port 9350`
to pin a specific port.

#### 4. Interact via CDP

```bash
# Screenshot the full window
CDP_PORT=<port> node cdp.js screenshot output/test.png

# Click a task card
CDP_PORT=<port> node cdp.js click '.wt-task-card'

# Check plugin state
CDP_PORT=<port> node cdp.js 'JSON.stringify(Object.keys(app.plugins.plugins))'

# Wait for a selector to appear
CDP_PORT=<port> node cdp.js wait-for '.wt-task-card[data-task-state="active"]'
```

#### 5. Modify tasks and verify UI changes

```bash
VAULT=".claude/testing/my-test"

# Move a task from active to todo by changing frontmatter
sed -i '' 's/state: active/state: todo/' "$VAULT/2 - Areas/Tasks/active/TASK-test-blocked.md"
mv "$VAULT/2 - Areas/Tasks/active/TASK-test-blocked.md" "$VAULT/2 - Areas/Tasks/todo/"

# Wait for UI to update, then screenshot
sleep 1
CDP_PORT=<port> node cdp.js screenshot output/after-move.png
```

#### 6. Stop the instance

```bash
pnpm run obsidian:test:stop -- --vault .claude/testing/my-test
# Or kill by PID from the JSON output: kill <pid>
```

**Important**: Do not use `pnpm run obsidian:test:open -- ... stop` - the `open`
script hardcodes the `open` command, so `stop` is silently ignored. Always use the
dedicated `obsidian:test:stop` script or `kill <pid>` from the launch output.

### Other commands

```bash
# Inspect vault status without modifying anything
node scripts/obsidian-isolated-instance.js status

# Init vault only (no launch)
pnpm run obsidian:test:init
```

### Testing guidelines

- **Use filesystem operations** for task creation and modification, not the "New task"
  prompt box or agent sessions
- **Agent sessions** (Claude, Copilot, Strands) must NOT be launched unless very
  explicitly approved by the user - most things are testable with shell sessions and
  direct filesystem task changes, then CDP interaction to verify UI state
- **Shell sessions** are fine for testing terminal integration without the cost of
  agent API calls
- Prefer `CDP_PORT=<port> node cdp.js screenshot` for verification over visual
  inspection of the hidden window

## Known constraints

- **PTY**: Electron sandbox blocks pty.spawn. Python `pty.fork()` via `pty-wrapper.py` is the workaround. Non-negotiable.
- **xterm.js CSS**: `require.resolve` unavailable in bundle. Full CSS embedded inline at runtime via `XtermCss.ts`.
- **Tilde expansion**: Always expand `~` via `process.env.HOME` before passing to spawn.
- **Node builtins**: Use `window.require` for `child_process`, `fs`, `path`, `os` in Electron. Externalized in esbuild.
- **Resize protocol**: `ESC]777;resize;COLS;ROWS BEL` through stdin; pty-wrapper.py intercepts and applies.
- **Keyboard capture**: Two layers (bubble + capture phase) intercept keys before Obsidian. Option+Arrow, Option+B/F/D, Shift+Enter, Option+Backspace, Cmd+Left/Right. xterm keeps Meta behavior by default, while Option+digit printable combos are preserved for layout-specific characters.
- **State detection reads xterm buffer, not stdout**: Immune to status line redraws. Checks last 6 visual lines. Handles narrow terminal wrapping via joined-tail fallback.
- **Session persistence**: Two tiers - window-global stash for hot-reload (survives module re-evaluation), disk persistence for full restart (7-day retention, UUID-based resume). Copilot restart resume uses native `--resume[=sessionId]`; Claude still needs hooks if users trigger Claude's in-app `/resume` and change session IDs.
