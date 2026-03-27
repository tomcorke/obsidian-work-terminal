## Context

The work-terminal framework (Phases 0-3.5) provides a complete plugin shell with terminal management, Claude integration, session persistence, and a column-based list UI - but uses a stub adapter that renders nothing. The task-agent adapter must implement the AdapterBundle interface to replicate all task-specific behaviour from the original obsidian-task-terminal plugin.

The original plugin has ~4,500 lines of tightly-coupled code. The adapter extracts only the task-specific logic (~800-1000 lines across 10 files), delegating all terminal, Claude, and UI framework concerns to the core and framework layers.

Key constraint: the adapter has **zero Claude knowledge**. It doesn't know about terminals, sessions, or state detection. It provides data (parse, move, render, prompt) and the framework handles everything else.

## Goals / Non-Goals

**Goals:**
- Full feature parity with the original plugin's task-specific behaviour
- Clean separation: adapter knows tasks, framework knows terminals/Claude
- All pure logic testable with vitest (parser, mover, template, prompt builder)
- Adapter extends BaseAdapter, implementing 5 required + 3 optional methods

**Non-Goals:**
- New task features not in the original plugin
- Changes to the framework layer or core interfaces
- CSS changes (framework's existing wt-prefixed styles handle card rendering)
- Supporting adapters other than task-agent (that's the extension model, not this phase)

## Decisions

### 1. Port directly from original, adapting to new interfaces

The original TaskParser, TaskMover, TaskCard, and PromptBox contain battle-tested logic with many subtle details (goal normalisation, abandoned filtering, write-then-move pattern, activity log insertion). Port this logic directly, restructuring to fit the AdapterBundle interface.

Alternative: Rewrite from scratch using only the spec. Rejected because the original code encodes many edge cases that are easy to miss (e.g. regex-based frontmatter updates preserving spacing, timestamp format without milliseconds, activity log inserting before next section not at EOF).

### 2. TaskFile as metadata, WorkItem as framework interface

The adapter internally uses a `TaskFile` type with all task-specific fields (source, priority, goal, agentActionable, etc.). The `parse()` method returns a `WorkItem` with task-specific data in `metadata`. The card renderer reads from `metadata` to render badges.

Alternative: Flatten all fields into WorkItem. Rejected because WorkItem is a framework type - task-specific fields belong in metadata.

### 3. Card rendering with framework CardActionContext

The original TaskCard takes 12+ callback parameters. The new TaskCard receives a `CardActionContext` from the framework for standard actions (select, move, delete, close sessions) and adds adapter-specific menu items (Copy Name, Copy Path, Copy Prompt, Split Task, Done & Close Sessions).

The "Done & Close Sessions" compound action composes `ctx.onMoveToColumn("done")` + `ctx.onCloseSessions()`. This is best-effort: if `onCloseSessions()` throws after the move succeeds, the task remains in done with sessions still open. The user can close sessions manually. This matches the original plugin's behaviour where the two operations were also non-transactional.

### 4. Detail panel as workspace leaf (adapter-managed)

The adapter's `createDetailView(item, app, ownerLeaf)` creates/reuses an Obsidian MarkdownView via `createLeafBySplit`. The `ownerLeaf` parameter is the MainView's own workspace leaf (not an existing editor leaf). The adapter tracks the leaf reference, checks survival before reuse, and applies min editor width from CSS variable `--file-line-width` + 80px (fallback 700px if variable unset). Width applied with 100ms defer to let Obsidian's layout pass complete. Flex sizing targets the grandparent's children (not parent - `createLeafBySplit` wraps each side in its own split container).

### 5. File creation is an adapter concern

The `onItemCreated(title, settings)` hook receives the user's title string and a settings object containing `_columnId` (target column) and `_placeholderPath` (for framework placeholder lifecycle). The adapter is responsible for the full creation flow:

1. Generate file content via TaskFileTemplate (frontmatter with UUID, tags, state, title, defaults)
2. Generate filename as `TASK-YYYYMMDD-HHMM-<slug>.md`
3. Create the file in the vault via `app.vault.create(path, content)`
4. Spawn headless Claude for background enrichment via framework's `spawnHeadlessClaude(prompt, cwd)`

The adapter does not need to return the file path to PromptBox. The framework's vault event listeners (MetadataCache "changed" event) detect the new file, re-render the list, and the placeholder is resolved by PromptBox's success/failure callback on the onItemCreated promise.

Alternative: Have the framework create the file and pass the path. Rejected because file creation logic (template, filename format, folder structure) is adapter-specific.

### 6. Background enrichment via framework's HeadlessClaude

After file creation, the adapter builds an enrichment prompt and delegates to `spawnHeadlessClaude(prompt, cwd)`. The adapter only provides the prompt text - it doesn't resolve Claude binaries, manage PATH, or handle process lifecycle.

Alternative: Port the original PromptBox.runBackgroundEnrich() directly. Rejected because Claude spawning is a framework concern.

### 7. Settings via adapter schema

The adapter declares its settings in `PluginConfig.settingsSchema` (e.g. `adapter.taskBasePath`). The framework's SettingsTab renders them alongside core settings. The adapter reads settings via the framework-provided settings object.

### 8. Adapter manages its own basePath

The framework passes `""` (empty string) for `basePath` when calling `createParser(app, basePath)` and `createMover(app, basePath)`. The adapter ignores this parameter and reads `taskBasePath` from its own settings (default: `"2 - Areas/Tasks"`). This keeps path configuration in the adapter's settings schema rather than requiring framework knowledge of task folder structure.

## Risks / Trade-offs

- **MetadataCache timing** - Parser depends on Obsidian's MetadataCache which may not be populated on file create. The framework already handles this with a metadata-changed event fallback (from Phase 3). [Risk: stale parse results] -> Mitigation: framework's existing debounce + metadata event handling.

- **Card rendering performance** - Rich cards with multiple badges and metadata are more expensive than stub cards. With dozens of tasks visible, re-renders need to be efficient. [Risk: sluggish UI] -> Mitigation: framework's existing badge-update-in-place pattern (updateSessionBadge) avoids full re-renders for session state changes.

- **PromptBox column mapping** - The original has a simple "Active" checkbox. The new adapter uses `creationColumns` with "To Do" (default) and "Active". Framework's PromptBox renders this as a column selector. [Risk: UX regression] -> Mitigation: matches original behaviour (default todo, optional active).

- **Background enrichment failure** - HeadlessClaude may fail (missing plugins, timeout). The framework's PromptBox already handles this with placeholder lifecycle (5s dismiss on failure, checkmark on success). [Risk: silent failure] -> Mitigation: adapter logs errors, framework handles UI.

- **Placeholder path collision** - PromptBox uses `Date.now()` for placeholder paths. Rapid sequential creates in the same millisecond could collide. [Risk: placeholder mismatch] -> Mitigation: unlikely in practice; if it occurs, the worst case is a placeholder not resolving (auto-dismissed after 5s).
