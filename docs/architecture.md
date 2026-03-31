# Architecture

[Back to README](../README.md)

Three-layer design. Each layer has clear responsibilities and boundaries:

```
src/
  core/           # Terminal infrastructure + agent integrations
    utils.ts      # expandTilde, stripAnsi, electronRequire, slugify
    interfaces.ts # All extension point interfaces + BaseAdapter
    terminal/     # XtermCss, ScrollButton, KeyboardCapture, TerminalTab, TabManager
    agents/       # AgentLauncher, AgentStateDetector, AgentSessionRename, AgentSessionTracker
    claude/       # ClaudeHookManager, HeadlessClaude
    session/      # SessionStore (window-global), SessionPersistence (disk), types

  framework/      # Obsidian plugin scaffolding - delegates to adapters
    PluginBase.ts          # Abstract Plugin subclass, view/command/settings registration
    MainView.ts            # 2-panel ItemView (list | terminals), vault events, rename detection
    ListPanel.ts           # Column-based kanban, drag-drop, filtering, badges, state indicators
    TerminalPanelView.ts   # Tab bar, Shell/Claude/Claude(ctx) spawn, state aggregation, resume
    PromptBox.ts           # Item creation UI with column selector
    SettingsTab.ts         # Core + adapter namespaced settings
    DangerConfirm.ts       # Modal confirmation for destructive actions

  adapters/
    task-agent/   # Task-agent adapter (reference implementation)
      index.ts             # AdapterBundle assembly extending BaseAdapter
      types.ts             # TaskFile, TaskState, KanbanColumn, STATE_FOLDER_MAP
      TaskAgentConfig.ts   # PluginConfig: columns, creationColumns, settings, itemName
      TaskParser.ts        # MetadataCache parsing, abandoned filtering, goal normalisation
      TaskMover.ts         # Regex frontmatter updates, write-then-move, activity log
      TaskCard.ts          # Source/score/goal/blocker badges, compound context menu
      TaskFileTemplate.ts  # UUID + YAML frontmatter + slug filename generation
      TaskPromptBuilder.ts # Title/state/path + conditional deadline/blocker
      TaskDetailView.ts    # MarkdownView via createLeafBySplit, flex sizing
      BackgroundEnrich.ts  # File creation + headless Claude enrichment

  main.ts         # Entry point: hardcoded import of task-agent adapter
```

## Extension model

The adapter provides 5 required implementations (parser, mover, card renderer, prompt builder, config) plus optional hooks (detail view, item creation, session label transform). The framework handles everything else: terminals, Claude integration, session persistence, drag-drop, state detection, keyboard capture.

To create a custom adapter: extend `BaseAdapter`, implement the abstract methods, change the import in `main.ts`. See [Creating an Adapter](creating-an-adapter.md) for a full walkthrough.

## Key design decisions

- **Agent integration owned by framework, not adapter** - AgentLauncher, AgentStateDetector, and AgentSessionRename are framework code. Adapters only provide a `WorkItemPromptBuilder` for context prompts.
- **UUID-based keying** - Sessions, custom order, and selection all use frontmatter UUIDs, not file paths. Survives renames without re-keying.
- **2-panel ItemView + workspace leaf detail** - The detail panel is a native Obsidian MarkdownView created via `createLeafBySplit`, not a custom CSS column. Gives live preview, frontmatter editing, backlinks for free.
- **CSS prefix `wt-`** - All plugin CSS classes use `wt-` prefix. No CSS modules.
