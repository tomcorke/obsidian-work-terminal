# Creating Your Own Adapter

[Back to README](../README.md)

The plugin is designed around a clean adapter interface. To build your own work item system (Jira tickets, GitHub issues, plain markdown notes, etc.):

## 1. Fork and clean up

```bash
git clone https://github.com/tomcorke/obsidian-work-terminal
cd obsidian-work-terminal
rm -rf src/adapters/task-agent/    # Remove the reference adapter
```

## 2. Create your adapter

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

## 3. Wire it up

Change `src/main.ts`:

```typescript
import { MyAdapter } from "./adapters/my-adapter";

const adapter = new MyAdapter();
// ... rest of main.ts stays the same
```

## What you get for free

Your adapter inherits all of this without writing any terminal code:

- Shell + Claude + Claude-with-context terminal tabs per item
- Session persistence (hot-reload stash preserves PTY state across plugin reloads)
- Agent state detection (active/waiting/idle) with card indicators
- Agent session rename detection with adapter hook
- Keyboard capture (Option+Arrow, Option+B/F/D, Shift+Enter, Option+digit printable chars preserved, other Option shortcuts keep terminal Meta behavior)
- xterm.js rendering with PTY wrapper, resize protocol, scroll-to-bottom
- Drag-drop reordering (within-section and cross-section)
- Collapsible kanban sections with custom sort order
- Settings UI (your adapter settings appear alongside core settings)
- Delete-create rename detection for shell `mv` operations
- Hot-reload via command palette or CDP

## Optional hooks

Override these in your adapter for extra functionality:

- `createDetailView(item, app, ownerLeaf)` - Open a detail panel (e.g. MarkdownView) when an item is selected
- `detachDetailView()` - Clean up the detail panel on close/reload
- `onItemCreated(path, settings)` - Run post-creation logic (e.g. background AI enrichment)
- `transformSessionLabel(oldLabel, detectedLabel)` - Transform detected agent session labels
