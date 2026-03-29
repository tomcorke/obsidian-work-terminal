# obsidian-work-terminal

Modular Obsidian plugin: work item kanban board with per-item tabbed terminals and adapter-based extensibility.

## Architecture

Three-layer design. Each layer has clear responsibilities and boundaries:

```
src/
  core/           # Terminal infrastructure + Claude CLI integration
    utils.ts      # expandTilde, stripAnsi, electronRequire, slugify
    interfaces.ts # All extension point interfaces + BaseAdapter
    terminal/     # XtermCss, ScrollButton, KeyboardCapture, TerminalTab, TabManager
    claude/       # ClaudeLauncher, ClaudeStateDetector, ClaudeSessionRename, HeadlessClaude
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

### Extension model

The adapter provides 5 required implementations (parser, mover, card renderer, prompt builder, config) plus optional hooks (detail view, item creation, session label transform). The framework handles everything else: terminals, Claude integration, session persistence, drag-drop, state detection, keyboard capture.

To create a custom adapter: extend `BaseAdapter`, implement the abstract methods, change the import in `main.ts`.

### Key design decisions

- **Claude owned by framework, not adapter** - ClaudeLauncher, StateDetector, SessionRename are framework code. Adapters only provide a `WorkItemPromptBuilder` for context prompts.
- **UUID-based keying** - Sessions, custom order, and selection all use frontmatter UUIDs, not file paths. Survives renames without re-keying.
- **2-panel ItemView + workspace leaf detail** - The detail panel is a native Obsidian MarkdownView created via `createLeafBySplit`, not a custom CSS column. Gives live preview, frontmatter editing, backlinks for free.
- **CSS prefix `wt-`** - All plugin CSS classes use `wt-` prefix. No CSS modules.

## Development workflow

- **Build**: `npm run build` (production) or `npm run dev` (watch mode with CDP hot-reload)
- **Test**: `npx vitest run` (102 tests covering utils, state detection, session types, parser, mover, template, prompt builder)
- **Output**: esbuild outputs `main.js` to repo root. `manifest.json` and `styles.css` already at repo root.
- **Vault link**: `.obsidian/plugins/work-terminal` is a symlink to this repo directory. No copy step.
- **Hot reload**: Requires Obsidian with `open -a Obsidian --args --remote-debugging-port=9222`
- **CDP helper**: `node cdp.js '<expression>'` evaluates JS in Obsidian's renderer. Default: triggers hot-reload. It also supports `open-view`, `wait-for`, `click`, `type`, and `screenshot`.
- **Isolated test vault**: `npm run obsidian:test:init` seeds `.claude/testing/obsidian-vault/` with a plugin symlink and sample tasks. `npm run obsidian:test:open` launches a fresh Obsidian instance against that vault and opens the Work Terminal view.

**IMPORTANT**: Never reload via raw `app.plugins.disablePlugin/enablePlugin` or Cmd+R - these destroy terminal sessions. Always use:
- `npm run dev` watch mode (preferred - auto-reloads on save)
- Command palette: "Work Terminal: Reload Plugin (preserve terminals)"
- CDP: `node cdp.js`

## Development rules

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
- **Concurrent debugging limitation**: The user may be actively using the plugin (e.g. running Claude sessions, testing UI) while you are developing. Plugin reloads and screen navigation can interrupt their testing. Coordinate with the user before reloading, and batch changes where possible to minimise reload frequency. Do not reload mid-test unless the user confirms it is safe.

### Testing
Run `npx vitest run` after changes to verify nothing is broken. Build with `npm run build` to catch type/bundle errors.

## Known constraints

- **PTY**: Electron sandbox blocks pty.spawn. Python `pty.fork()` via `pty-wrapper.py` is the workaround. Non-negotiable.
- **xterm.js CSS**: `require.resolve` unavailable in bundle. Full CSS embedded inline at runtime via `XtermCss.ts`.
- **Tilde expansion**: Always expand `~` via `process.env.HOME` before passing to spawn.
- **Node builtins**: Use `window.require` for `child_process`, `fs`, `path`, `os` in Electron. Externalized in esbuild.
- **Resize protocol**: `ESC]777;resize;COLS;ROWS BEL` through stdin; pty-wrapper.py intercepts and applies.
- **Keyboard capture**: Two layers (bubble + capture phase) intercept keys before Obsidian. Option+Arrow, Shift+Enter, Option+Backspace, macOptionIsMeta.
- **State detection reads xterm buffer, not stdout**: Immune to status line redraws. Checks last 6 visual lines. Handles narrow terminal wrapping via joined-tail fallback.
- **Session persistence**: Two tiers - window-global stash for hot-reload (survives module re-evaluation), disk persistence for full restart (7-day retention, UUID-based resume). Copilot restart resume uses native `--resume[=sessionId]`; Claude still needs hooks if users trigger Claude's in-app `/resume` and change session IDs.
