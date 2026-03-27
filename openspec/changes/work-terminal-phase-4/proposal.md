## Why

The framework layer (Phases 0-3.5) is complete with a stub adapter, but the plugin can't do anything useful yet. Phase 4 builds the task-agent adapter - the concrete implementation that makes work-terminal a task management tool. This is the adapter that replicates all task-specific behaviour from the original obsidian-task-terminal plugin, plugging into the framework's extension points.

## What Changes

- New `src/adapters/task-agent/` directory with 10 modules implementing the full AdapterBundle
- Replace stub adapter import in `main.ts` with task-agent adapter
- Add task-agent-specific settings (taskBasePath) to the adapter's settings schema
- Task file parsing from Obsidian vault frontmatter (MetadataCache)
- Task state transitions with frontmatter/tag/folder/activity-log updates
- Rich card rendering with score badges, goal tags, source badges, blocker indicators, session badges, resume badges
- Context menu with adapter-specific actions (Copy Name, Copy Path, Copy Context Prompt, Split Task, Done & Close Sessions, Delete Task)
- Detail panel via Obsidian MarkdownView (createLeafBySplit)
- Background enrichment of new tasks via headless Claude
- Task file template generation with UUID and proper frontmatter schema
- Context prompt building for Claude sessions
- Tests for parser, mover, template, and prompt builder

## Capabilities

### New Capabilities
- `task-parsing`: Parse task files from Obsidian vault frontmatter into WorkItem objects, including field normalisation, abandoned filtering, goal array coercion, and ID backfilling
- `task-state-transitions`: Move tasks between columns by updating frontmatter state/tags, updated timestamp, activity log, and physical file location (write-then-move pattern)
- `task-card-rendering`: Rich card rendering with metadata badges (score, goals, source, blockers), session counts, resume indicators, and adapter-specific context menu actions
- `task-detail-view`: Obsidian MarkdownView detail panel via workspace leaf splitting, with editor width management and leaf lifecycle handling
- `task-creation`: Task file template generation and background enrichment via headless Claude
- `task-prompt-building`: Context prompt construction for Claude sessions with task metadata

### Modified Capabilities
<!-- No existing specs to modify -->

## Impact

- `src/main.ts` - Import changes from stub to task-agent adapter
- `src/adapters/task-agent/` - 10 new files (~800-1000 lines total)
- `src/adapters/stub.ts` - Remains for reference but no longer imported by default
- Test files - 4 new test files for parser, mover, template, prompt builder
- Framework interfaces unchanged - adapter implements existing extension points
