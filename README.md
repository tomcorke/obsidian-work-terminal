# obsidian-work-terminal

Obsidian plugin that turns your vault into a work item board with per-item tabbed terminals. Built for extensibility - swap in your own work item system while keeping the terminal infrastructure.

## Installation

Use Node.js 20.19.0 or newer (`node -v` to check), then run these commands from the directory where you want to keep the plugin source:

```bash
git clone https://github.com/tomcorke/obsidian-work-terminal.git
cd obsidian-work-terminal
npm install
npm run build
```

Then symlink this repo directory into your vault. Replace `"/path/to/your/vault"` with your vault path:

```bash
VAULT="/path/to/your/vault"
mkdir -p "$VAULT/.obsidian/plugins"
ln -s "$(pwd)" "$VAULT/.obsidian/plugins/work-terminal"
```

If `work-terminal` already exists in `.obsidian/plugins`, remove that directory or symlink first. After pulling updates, run `npm run build` again before reopening Obsidian. Then enable **Work Terminal** in Obsidian's **Community plugins** settings.

## What you get

- **Kanban board** with collapsible sections, drag-drop reordering, and custom sort order
- **Tabbed terminals** per work item - Shell, Claude, contextual Claude, and custom sessions (including GitHub Copilot CLI)
- **Agent integration** - Claude/Copilot command resolution, agent state detection (active/waiting/idle), session rename detection, headless spawning
- **Session persistence** - hot-reload preserves live terminals; disk persistence enables session resume after restart. Copilot uses native `--resume[=sessionId]`, while Claude hook setup is only needed if you use Claude's in-app `/resume`.
- **First-run guided tour** - new users get a focused walkthrough for task creation, session launch controls, tab management, custom sessions, and the key Claude settings
- **Detail panel** - native Obsidian MarkdownView via workspace leaf splitting

## Development

```bash
npm run dev          # watch mode with CDP hot-reload
npx vitest run       # 104 tests
npm run obsidian:test:init
npm run obsidian:test:open
```

Requires Obsidian with remote debugging: `open -a Obsidian --args --remote-debugging-port=9222`

The vault's `.obsidian/plugins/work-terminal` should be a symlink to this repo directory.

When packaging or distributing the plugin, keep `pty-wrapper.py` in the plugin directory alongside `main.js`, `manifest.json`, and `styles.css`.

## UI automation first slice

The repo now includes a repo-local automation path for isolated manual or agent-driven checks:

- `npm run obsidian:test:init` creates `.claude/testing/obsidian-vault/` with:
  - `.obsidian/plugins/work-terminal` symlinked to this worktree
  - community plugin enablement files
  - seed task data under `2 - Areas/Tasks/`
- `npm run obsidian:test:open` launches a fresh Obsidian app instance against that vault on CDP port `9222` and opens the Work Terminal view.
- `node scripts/obsidian-isolated-instance.js status` inspects the configured vault without creating or modifying it.
- `node cdp.js` still reloads the plugin, but now also supports:
  - `node cdp.js open-view`
  - `node cdp.js wait-for '.wt-main-layout'`
  - `node cdp.js click '.wt-task-card'`
  - `node cdp.js type 'textarea' 'hello from automation'`
  - `node cdp.js screenshot output/work-terminal.png --selector '.wt-main-layout'`

Use `--port` or `OBSIDIAN_REMOTE_DEBUG_PORT` if you need a non-default debugger port. The launcher now fails fast if that debugger port is already occupied, and it also stops early with a clear singleton warning when another Obsidian app process is already running instead of timing out against an unusable second-instance launch.

## Process Spawning & Security

This plugin spawns external processes to provide terminal and AI agent functionality. This section documents exactly what gets executed and how.

### What gets spawned

| Process | How it runs | Trigger |
|---------|------------|---------|
| **Shell** | `python3 pty-wrapper.py <cols> <rows> -- <shell>` where `<shell>` is `$SHELL` or `/bin/zsh` | User clicks "+ Shell" button |
| **Claude CLI** | User-configured command (default: `claude`) with `--session-id <uuid>` and optional context prompt as positional arg | User clicks "Claude" or "Claude (ctx)" button |
| **GitHub Copilot CLI** | User-configured command (default: `copilot`) with `--resume=<sessionId>` and optional `-i <prompt>` | User launches a Copilot session via custom session modal |
| **AWS Strands** | User-configured command with optional positional prompt arg | User launches a Strands session via custom session modal |
| **Headless Claude** | `claude -p <prompt> --output-format text` (one-shot, non-interactive) | User triggers "Enrich with Claude" action on a work item |
| **Hook script** | `~/.work-terminal/hooks/session-change.sh` - reads Claude hook JSON from stdin, writes event files to `~/.work-terminal/events/` | Installed explicitly via plugin settings UI; invoked by Claude CLI on session start/end |

All terminal processes run inside `pty-wrapper.py`, a Python script that uses `pty.fork()` to provide a real pseudo-terminal. Electron's sandbox blocks native PTY access, so this Python wrapper is the necessary bridge between xterm.js and the child process.

### Security properties

- **User-configured commands** - all external binaries (shell, Claude, Copilot, Strands) are set in plugin settings, not hardcoded. The plugin resolves them against `$PATH` via `resolveCommandInfo()` and validates they exist before spawning.
- **No shell interpretation** - arguments are constructed as arrays and passed to Node.js `child_process.spawn()`, which invokes executables directly without a shell. This prevents command injection.
- **No network requests** - the plugin itself makes zero network calls. Any network activity comes from the spawned processes (e.g. Claude CLI communicating with Anthropic's API).
- **Vault access via Obsidian API** - vault file operations use `app.vault.create()` / `app.vault.modify()`, never direct filesystem writes to the vault.
- **Limited direct filesystem writes** - the only direct filesystem writes are to `~/.work-terminal/` (hook scripts, event files) and `~/.claude/settings.local.json` (hook configuration), both triggered explicitly by the user through the settings UI.
- **Plugin data via Obsidian API** - settings and session state use `plugin.loadData()` / `plugin.saveData()`, stored in the vault's `.obsidian/plugins/work-terminal/data.json`.

### Source locations

The spawning code lives in these files:

- `src/core/terminal/TerminalTab.ts` - PTY wrapper spawn (`python3 pty-wrapper.py ... -- <command>`)
- `src/core/agents/AgentLauncher.ts` - command resolution, PATH augmentation, argument builders for Claude/Copilot/Strands
- `src/core/claude/HeadlessClaude.ts` - one-shot `claude -p` for background enrichment
- `src/core/claude/ClaudeHookManager.ts` - hook script installation and `~/.claude/settings.local.json` management
- `pty-wrapper.py` - Python PTY bridge (uses `pty.fork()` and `os.execvp()`)

## Creating Your Own Adapter

The plugin is designed around a clean adapter interface. To build your own work item system (Jira tickets, GitHub issues, plain markdown notes, etc.):

### 1. Fork and clean up

```bash
git clone https://github.com/tomcorke/obsidian-work-terminal
cd obsidian-work-terminal
rm -rf src/adapters/task-agent/    # Remove the reference adapter
```

### 2. Create your adapter

Create `src/adapters/my-adapter/index.ts`:

```typescript
import type { App, WorkspaceLeaf } from "obsidian";
import {
  BaseAdapter,
  type WorkItem,
  type WorkItemParser,
  type WorkItemMover,
  type CardRenderer,
  type WorkItemPromptBuilder,
  type PluginConfig,
} from "../../core/interfaces";

export class MyAdapter extends BaseAdapter {
  config: PluginConfig = {
    columns: [
      { id: "todo", label: "To Do", folderName: "todo" },
      { id: "doing", label: "Doing", folderName: "doing" },
      { id: "done", label: "Done", folderName: "done" },
    ],
    creationColumns: [
      { id: "todo", label: "To Do", default: true },
    ],
    settingsSchema: [],
    defaultSettings: {},
    itemName: "item",  // Used in UI: "New item", "Filter items..."
  };

  createParser(app: App, basePath: string): WorkItemParser {
    // Parse your vault files into WorkItems
    // See task-agent/TaskParser.ts for a full example
  }

  createMover(app: App, basePath: string): WorkItemMover {
    // Move items between columns (update frontmatter, rename file)
    // See task-agent/TaskMover.ts for a full example
  }

  createCardRenderer(): CardRenderer {
    // Render card DOM elements and context menu items
    // See task-agent/TaskCard.ts for a full example
  }

  createPromptBuilder(): WorkItemPromptBuilder {
    // Build context prompts for agent sessions
    // See task-agent/TaskPromptBuilder.ts for a full example
  }
}
```

### 3. Wire it up

Change `src/main.ts`:

```typescript
import { MyAdapter } from "./adapters/my-adapter";

const adapter = new MyAdapter();
// ... rest of main.ts stays the same
```

### What you get for free

Your adapter inherits all of this without writing any terminal code:

- Shell + Claude + Claude-with-context terminal tabs per item
- Session persistence (hot-reload + disk resume with 7-day retention)
- Agent state detection (active/waiting/idle) with card indicators
- Agent session rename detection with adapter hook
- Keyboard capture (Option+Arrow, Option+B/F/D, Shift+Enter, Option+digit printable chars preserved, other Option shortcuts keep terminal Meta behavior)
- xterm.js rendering with PTY wrapper, resize protocol, scroll-to-bottom
- Drag-drop reordering (within-section and cross-section)
- Collapsible kanban sections with custom sort order
- Settings UI (your adapter settings appear alongside core settings)
- Delete-create rename detection for shell `mv` operations
- Hot-reload via command palette or CDP

### Optional hooks

Override these in your adapter for extra functionality:

- `createDetailView(item, app, ownerLeaf)` - Open a detail panel (e.g. MarkdownView) when an item is selected
- `detachDetailView()` - Clean up the detail panel on close/reload
- `onItemCreated(path, settings)` - Run post-creation logic (e.g. background AI enrichment)
- `transformSessionLabel(oldLabel, detectedLabel)` - Transform detected agent session labels

## Architecture

See [CLAUDE.md](CLAUDE.md) for the full architecture documentation.

## License

MIT
