# obsidian-work-terminal

Obsidian plugin that turns your vault into a work item board with per-item tabbed terminals. Built for extensibility - swap in your own work item system while keeping the terminal infrastructure.

## What you get

- **Kanban board** with collapsible sections, drag-drop reordering, and custom sort order
- **Tabbed terminals** per work item - Shell, Claude, contextual Claude, and custom sessions (including GitHub Copilot CLI)
- **Agent integration** - Claude/Copilot command resolution, agent state detection (active/waiting/idle), session rename detection, headless spawning
- **Session persistence** - hot-reload preserves live terminals; disk persistence enables session resume after restart. Copilot uses native `--resume[=sessionId]`, while Claude hook setup is only needed if you use Claude's in-app `/resume`.
- **Detail panel** - native Obsidian MarkdownView via workspace leaf splitting

## Development

```bash
npm install
npm run build        # production build
npm run dev          # watch mode with CDP hot-reload
npx vitest run       # 104 tests
npm run obsidian:test:init
npm run obsidian:test:open
```

Requires Obsidian with remote debugging: `open -a Obsidian --args --remote-debugging-port=9222`

The vault's `.obsidian/plugins/work-terminal` should be a symlink to this repo directory.

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
- Keyboard capture (Option+Arrow, Shift+Enter, macOptionIsMeta)
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
