# Architecture

[Back to README](../README.md)

Three-layer design. Each layer has clear responsibilities and boundaries:

```
src/
  core/           # Terminal infrastructure + agent integrations
    utils.ts              # expandTilde, stripAnsi, electronRequire, slugify
    interfaces.ts         # All extension point interfaces + BaseAdapter
    cardFlags.ts          # Card indicator rule parsing and serialisation
    detailViewPlacement.ts # Detail view placement enum and option resolution
    frontmatter.ts        # Frontmatter field helpers
    PinStore.ts           # Pinned-task persistence (UUID set)
    PluginDataStore.ts    # Typed read/write for plugin data.json
    terminal/             # XtermCss, ScrollButton, KeyboardCapture, TerminalTab, TabManager, PythonCheck
    agents/               # AgentLauncher, AgentStateDetector, AgentProfile, AgentProfileManager
    claude/               # HeadlessClaude
    resolvers/            # FolderStateResolver, FrontmatterStateResolver, CompositeStateResolver
    session/              # SessionStore (window-global), types
    workspace/            # findNavigateTargetLeaf (detail view target resolution)

  framework/      # Obsidian plugin scaffolding - delegates to adapters
    PluginBase.ts              # Abstract Plugin subclass, view/command/settings registration
    MainView.ts                # 2-panel ItemView (list | terminals), vault events, rename detection
    ListPanel.ts               # Column-based kanban, drag-drop, filtering, badges, state indicators
    TerminalPanelView.ts       # Tab bar, Shell/Claude/Claude(ctx) spawn, state aggregation
    PromptBox.ts               # Item creation UI with column selector
    SettingsTab.ts             # 5-section settings UI (General, Board, Terminal, Detail, Agents)
    DangerConfirm.ts           # Modal confirmation for destructive actions
    ActivityTracker.ts         # Activity-view recency tracking and section assignment
    AgentContextPrompt.ts      # $placeholder expansion for agent context prompts
    AgentProfileManagerModal.ts # Profile list/edit modal
    AgentProfileModal.ts       # Single profile edit form
    ProfileLaunchModal.ts      # Profile selection dialog from "..." tab bar button
    AgentActionsDialog.ts      # Split Task profile binding dialog
    EnrichmentSettingsDialog.ts # Background enrichment sub-dialog
    TerminalSettingsDialog.ts  # Shell and CWD sub-dialog
    CardFlagManagerModal.ts    # Card indicator rule list
    CardFlagRuleModal.ts       # Single card flag rule editor
    CustomSessionConfig.ts     # Custom session type configuration
    GuidedTour.ts              # First-run walkthrough
    enrichmentPromptPreview.ts # Resolved-prompt preview helper
    splitTaskProfile.ts        # Split Task profile resolution chain
    viewType.ts                # VIEW_TYPE constant

  adapters/
    task-agent/   # Task-agent adapter (reference implementation)
      index.ts               # AdapterBundle assembly extending BaseAdapter
      types.ts               # TaskFile, TaskState, KanbanColumn, STATE_FOLDER_MAP
      TaskAgentConfig.ts     # PluginConfig: columns, creationColumns, settings, itemName
      TaskParser.ts          # MetadataCache parsing, abandoned filtering, goal normalisation
      TaskMover.ts           # Regex frontmatter updates, write-then-move, activity log
      TaskCard.ts            # Source/score/goal/blocker badges, compound context menu
      TaskFileTemplate.ts    # UUID + YAML frontmatter + slug filename generation
      TaskPromptBuilder.ts   # Title/state/path + conditional deadline/blocker
      TaskDetailView.ts      # MarkdownView via createLeafBySplit, flex sizing
      TaskPreviewView.ts     # Read-only markdown preview pseudo-tab
      EmbeddedDetailView.ts  # Reparented MarkdownView pseudo-tab (experimental)
      BackgroundEnrich.ts    # File creation + headless agent enrichment
      EnrichmentLogger.ts    # Failure diagnostic logs with retention/pruning
      SetIconModal.ts        # Custom icon input modal
      customCardFlags.ts     # Adapter-specific default card flag rules
      stateResolverFactory.ts # Factory for folder/frontmatter/composite resolvers

  main.ts         # Entry point: hardcoded import of task-agent adapter
```

## Extension model

The adapter provides 5 required implementations (parser, mover, card renderer, prompt builder, config) plus optional hooks (detail view, detach, rekey, item creation, split item, session label transform, settings change, retry enrichment, delete, custom styles). The framework handles everything else: terminals, agent integration, hot-reload session stash, drag-drop, state detection, keyboard capture, activity tracking, pinning, and card flag rules.

To create a custom adapter: extend `BaseAdapter`, implement the abstract methods, change the import in `main.ts`. See [Creating an Adapter](creating-an-adapter.md) for a full walkthrough.

## Key design decisions

- **Agent integration owned by framework, not adapter** - AgentLauncher and AgentStateDetector are framework code. Adapters only provide a `WorkItemPromptBuilder` for context prompts.
- **UUID-based keying** - Sessions, custom order, pinned state, and selection all use frontmatter UUIDs, not file paths. Survives renames without re-keying.
- **2-panel ItemView + flexible detail placement** - The default detail panel is a native Obsidian MarkdownView created via `createLeafBySplit`. Alternative placements (tab, navigate, preview pseudo-tab, embedded pseudo-tab) are available. Split gives live preview, frontmatter editing, backlinks for free.
- **State resolution is pluggable** - Three strategies (folder, frontmatter, composite) are implemented via `core/resolvers/`. The adapter selects one via `stateResolverFactory`. Custom states create dynamic columns automatically.
- **CSS prefix `wt-`** - All plugin CSS classes use `wt-` prefix. No CSS modules.
