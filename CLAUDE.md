# obsidian-work-terminal

Modular Obsidian plugin: work item kanban board with per-item tabbed terminals and adapter-based extensibility.

## Architecture

Three-layer design. Each layer has clear responsibilities and boundaries:

```
src/
  core/           # Terminal infrastructure + agent integrations
    utils.ts      # expandTilde, stripAnsi, electronRequire, slugify
    interfaces.ts # All extension point interfaces + BaseAdapter
    terminal/     # XtermCss, ScrollButton, KeyboardCapture, TerminalTab, TabManager
    agents/       # AgentLauncher, AgentStateDetector
    claude/       # HeadlessClaude
    session/      # SessionStore (window-global), types

  framework/      # Obsidian plugin scaffolding - delegates to adapters
    PluginBase.ts          # Abstract Plugin subclass, view/command/settings registration
    MainView.ts            # 2-panel ItemView (list | terminals), vault events, rename detection
    ListPanel.ts           # Column-based kanban, drag-drop, filtering, badges, state indicators
    TerminalPanelView.ts   # Tab bar, Shell/Claude/Claude(ctx) spawn, state aggregation
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

### Extension model

The adapter provides 5 required implementations (parser, mover, card renderer, prompt builder, config) plus optional hooks (detail view, item creation, session label transform). The framework handles everything else: terminals, Claude integration, hot-reload session stash, drag-drop, state detection, keyboard capture.

To create a custom adapter: extend `BaseAdapter`, implement the abstract methods, change the import in `main.ts`.

### Key design decisions

- **Agent integration owned by framework, not adapter** - AgentLauncher and AgentStateDetector are framework code. Adapters only provide a `WorkItemPromptBuilder` for context prompts.
- **UUID-based keying** - Custom order and selection use frontmatter UUIDs, not file paths. Survives renames without re-keying.
- **2-panel ItemView + workspace leaf detail** - The detail panel is a native Obsidian MarkdownView created via `createLeafBySplit`, not a custom CSS column. Gives live preview, frontmatter editing, backlinks for free.
- **CSS prefix `wt-`** - All plugin CSS classes use `wt-` prefix. No CSS modules.

## Development workflow

- **Build**: `pnpm run build` (production) or `pnpm run dev` (watch mode with CDP hot-reload)
- **Test**: `pnpm exec vitest run` (104 tests covering utils, state detection, session types, parser, mover, template, prompt builder, automation helpers)
- **Output**: esbuild outputs `main.js` to repo root. `manifest.json` and `styles.css` already at repo root.
- **Vault link**: `.obsidian/plugins/work-terminal` is a symlink to this repo directory. No copy step.
- **Hot reload**: Requires Obsidian with `open -a Obsidian --args --remote-debugging-port=9222`
- **CDP helper**: `node cdp.js '<expression>'` evaluates JS in Obsidian's renderer. Default: triggers hot-reload. It also supports `open-view`, `wait-for`, `click`, `type`, and `screenshot`.
- **Isolated test vault**: `pnpm run obsidian:test:open -- --vault .claude/testing/<name> --clean` creates a dedicated vault with plugin symlink and sample tasks, launches a separate Obsidian instance on a random port, hides the window, and opens the Work Terminal view. Each test scenario should use its own `--vault` path. Use `pnpm run obsidian:test:stop -- --vault .claude/testing/<name>` or `kill <pid>` (from the launch JSON output) to stop it. See `docs/development.md` for full instructions including how to seed test tasks via the filesystem.
  - **IMPORTANT**: Launching briefly steals focus (~2-3s). Never trigger automatically - only with explicit user consent.
  - **IMPORTANT**: Do NOT launch agent sessions (Claude/Copilot/Strands) in isolated instances unless very explicitly approved by the user. Test with filesystem task manipulation + CDP interaction instead.

**IMPORTANT**: Never reload via raw `app.plugins.disablePlugin/enablePlugin` or Cmd+R - these destroy terminal sessions. Always use:
- `pnpm run dev` watch mode (preferred - auto-reloads on save)
- Command palette: "Work Terminal: Reload Plugin (preserve terminals)"
- CDP: `node cdp.js`

## Development rules

### Branching and worktrees
- **NEVER modify the project root** by checking out other branches. The repo root is symlinked as an Obsidian plugin - switching branches disrupts the user's live vault. All development work must be done in **git worktrees** (`.claude/worktrees/`), not by checking out branches in the project root.
- **New branches must always be based on `origin/main`** to avoid including unrelated changes. Before creating a branch, fetch and branch from `origin/main`, not from whatever the local `main` happens to be.
- Ask the user before creating a worktree or switching branches if there is any ambiguity.

### Commits
Commit each discrete change individually with a clear message. Do not batch unrelated changes. Commit regularly - do not accumulate large uncommitted diffs.

### Issue tracking
Use GitHub Issues as the project TODO list (`gh issue list`, `gh issue create`, `gh issue close`).
- Log new TODOs, feature requests, and bugs as GitHub issues.
- When starting work on something, find or create the matching issue and reference it in commits.
- Add progress notes and findings as issue comments (`gh issue comment`).
- Use `Closes #N` or `Fixes #N` in commit messages to auto-close issues on push.
- **After committing**, push to origin so issue references take effect. Do not leave commits unpushed with dangling issue references.
- **Verify** issues are updated after push: run `gh issue list --state all` to confirm closed issues, and check that investigation-only issues have comments with findings.

### Debugger-driven development
When Obsidian is running with remote debugging enabled (check by hitting `http://localhost:9222/json`, or your configured port):
- **After code changes**: reload the plugin via `node cdp.js` (preserves terminal sessions) rather than asking the user to reload manually.
- **While debugging**: use CDP to inspect DOM, evaluate expressions, read console logs, wait for selectors, click, type, and capture screenshots before asking the user to perform manual actions. Only ask the user when the debugger cannot see or do what's needed.
- **CDP helper**: `node cdp.js '<expression>'` evaluates JS in Obsidian's renderer. No arguments = trigger plugin reload. Screenshots can be captured with `node cdp.js screenshot output/work-terminal.png --selector '.wt-main-layout'`.
- **Automation safety**: the isolated-instance launcher uses a separate Electron `--user-data-dir` and a direct binary launch on a random free port (9300-9399), so it runs alongside the user's live Obsidian without conflict. Isolated instances are the expected way to test PRs and reproduce bugs even when the user's live Obsidian is open. The launcher does fail fast if the requested debugger port is already occupied. Reusing the same `--vault` path concurrently can still conflict or hang, so prefer a unique `--vault` path (vault directory) per run rather than assuming live Obsidian is the blocker.
- **Concurrent debugging limitation**: The user may be actively using the plugin (e.g. running Claude sessions, testing UI) while you are developing. Plugin reloads and screen navigation can interrupt their testing. Coordinate with the user before reloading, and batch changes where possible to minimise reload frequency. Do not reload mid-test unless the user confirms it is safe.

### Testing
Run `pnpm exec vitest run` after changes to verify nothing is broken. Build with `pnpm run build` to catch type/bundle errors.

### UI requirement
Every user-visible feature must have an appropriate settings UI or interaction surface. Features shipped without UI are incomplete - do not merge PRs that add backend/logic without a corresponding way for users to access or configure the feature.

### Documentation requirement
Updates to the user guide (`docs/user-guide.md`) are always part of implementing a feature. PRs that add user-visible features or change existing behaviour must include corresponding user guide updates. Treat missing documentation the same as missing tests - the feature is not done.

### Placeholder format
All new placeholder variables must use the `$name` form (camelCase, dollar prefix), matching the existing `AgentContextPrompt` / profile-template resolver. Do not introduce `{{NAME}}` or `{name}` forms. When extending a resolver with a new placeholder, add it to `AgentContextPrompt.expandProfilePlaceholders` / `buildAgentContextPrompt` or the adjacent enrichment resolver rather than inventing a new parallel placeholder syntax.

## Known constraints

- **PTY**: Electron sandbox blocks pty.spawn. Python `pty.fork()` via `pty-wrapper.py` is the workaround. Non-negotiable.
- **xterm.js CSS**: `require.resolve` unavailable in bundle. Full CSS embedded inline at runtime via `XtermCss.ts`.
- **Tilde expansion**: Always expand `~` via `process.env.HOME` before passing to spawn.
- **Node builtins**: Use `window.require` for `child_process`, `fs`, `path`, `os` in Electron. Externalized in esbuild.
- **Resize protocol**: `ESC]777;resize;COLS;ROWS BEL` through stdin; pty-wrapper.py intercepts and applies.
- **Keyboard capture**: Two layers (bubble + capture phase) intercept keys before Obsidian. Option+Arrow, Option+B/F/D, Shift+Enter, Option+Backspace, Cmd+Left/Right. xterm keeps Meta behavior by default, while Option+digit printable combos are preserved for layout-specific characters.
- **State detection reads xterm buffer, not stdout**: Immune to status line redraws. Checks last 6 visual lines. Handles narrow terminal wrapping via joined-tail fallback.
