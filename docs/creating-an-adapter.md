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
- Reusable agent profiles (Claude, Copilot, Strands, custom) with the Profile Manager
- Profile launch modal ("..." button in tab bar) for selecting and launching profiles
- Session hot-reload stash (preserves PTY state across plugin reloads)
- Agent state detection (active/waiting/idle) with card and tab indicators
- Keyboard capture (Option+Arrow, Option+B/F/D, Shift+Enter, Option+digit printable chars preserved, other Option shortcuts keep terminal Meta behavior)
- xterm.js rendering with PTY wrapper, resize protocol, scroll-to-bottom
- Drag-drop reordering (within-section and cross-section, including cross-column moves)
- Collapsible kanban sections with custom sort order
- Pinned items section at the top of the board
- Activity view mode (group by recency instead of state columns)
- Card display modes (standard, compact with indicator dots, comfortable)
- Task card icons (custom per-item or automatic by source/state)
- Card indicator rules (custom visual flags based on frontmatter field values)
- Dynamic columns (custom states beyond the built-in set, auto-created and auto-cleaned)
- Detail view with six placement strategies (split, tab, navigate, preview, embedded, disabled)
- Text and active-session filtering
- Settings UI organised into five sections (your adapter settings appear alongside core settings)
- Background enrichment pipeline with configurable prompts, profiles, timeouts, failure logging, and retry
- Split Task flow (create a linked sub-item and launch an agent session)
- First-run guided tour
- Delete-create rename detection for shell `mv` operations
- Hot-reload via command palette or CDP
- Debug API (`window.__workTerminalDebug`) for CDP automation

## Optional hooks

Override these in your adapter for extra functionality:

- `createDetailView(item, app, ownerLeaf, embeddedHost?, previewHost?)` - Open a detail panel when an item is selected. The `embeddedHost` and `previewHost` params receive DOM elements for the embedded and preview placements respectively
- `detachDetailView()` - Clean up the detail panel on close/reload
- `rekeyDetailPath(oldPath, newPath)` - Update detail view tracking when an item file is renamed
- `onItemCreated(title, settings)` - Create the file and run post-creation logic (e.g. background enrichment). Returns `{ id, columnId, enrichmentDone? }`
- `onSplitItem(sourceItem, columnId, settings)` - Split an existing item into a new linked task
- `transformSessionLabel(oldLabel, detectedLabel)` - Transform detected agent session labels
- `onSettingsChanged(settings)` - React to plugin settings changes (e.g. update card flag rules)
- `getRetryEnrichPrompt(item)` - Prepare a retry enrichment prompt for a failed enrichment
- `onDelete(item)` - Called before deletion; return false to prevent the default `vault.trash()` behaviour
- `getStyles()` - Return adapter-specific CSS to inject into the document
