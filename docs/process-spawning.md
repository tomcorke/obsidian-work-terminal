# Process Spawning & Filesystem Disclosure

[Back to README](../README.md)

This plugin spawns external processes and performs filesystem operations to provide terminal and AI agent functionality. This document is a complete, source-verified inventory of what the plugin executes, reads, and writes.

## Processes spawned

### 1. Shell tabs

`python3 pty-wrapper.py <cols> <rows> -- <shell>` where `<shell>` is the user's configured shell (defaults to `$SHELL` or `/bin/zsh`).

- **Trigger**: User clicks "+ Shell" button
- **Source**: `src/core/terminal/TerminalTab.ts` - `spawnPty()` method (line 631)
- **Mechanism**: `child_process.spawn()` with array args (no shell interpretation)

### 2. Claude CLI

User-configured command (default: `claude`) with `--session-id <uuid>` and optional context prompt as a positional argument. Extra args from settings are prepended.

- **Trigger**: User clicks "Claude" or "Claude (ctx)" button
- **Source**: `src/core/agents/AgentLauncher.ts` - `buildClaudeArgs()` (line 307)
- **Mechanism**: Spawned inside `pty-wrapper.py` via `TerminalTab.spawnPty()`

### 3. GitHub Copilot CLI

User-configured command (default: `copilot`) with optional `-i <prompt>`.

- **Trigger**: User launches a Copilot session via custom session modal
- **Source**: `src/core/agents/AgentLauncher.ts` - `buildCopilotArgs()` (line 335)
- **Mechanism**: Spawned inside `pty-wrapper.py` via `TerminalTab.spawnPty()`

### 4. AWS Strands

User-configured command with optional positional prompt argument. Extra args from settings are prepended.

- **Trigger**: User launches a Strands session via custom session modal
- **Source**: `src/core/agents/AgentLauncher.ts` - `buildStrandsArgs()` (line 357)
- **Mechanism**: Spawned inside `pty-wrapper.py` via `TerminalTab.spawnPty()`

### 5. Headless Claude

One-shot `claude -p <prompt> --output-format text` for background task enrichment. Extra args from settings are prepended.

- **Trigger**: User triggers "Enrich with Claude" action on a work item (via `BackgroundEnrich.ts`)
- **Source**: `src/core/claude/HeadlessClaude.ts` - `spawnHeadlessClaude()` (line 24)
- **Mechanism**: `child_process.spawn()` with array args (no shell interpretation)

### 6. VS Code

`code --goto "{file}:{line}"` on terminal file-link clicks (Cmd+click on file paths in terminal output). Falls back to `shell.openPath()` if VS Code is not available.

- **Trigger**: User Cmd+clicks a file path in terminal output
- **Source**: `src/core/terminal/TerminalTab.ts` - link provider `activate` callback (line 542)
- **Mechanism**: `child_process.exec()` (string form, with shell interpretation)

**Note**: All terminal processes (Shell, Claude, Copilot, Strands) run inside `pty-wrapper.py`, a Python script that uses `pty.fork()` to provide a real pseudo-terminal. Electron's sandbox blocks native PTY access, so this Python wrapper is the necessary bridge between xterm.js and the child process.

## Filesystem access

### Inside the vault (Obsidian API only)

All vault operations use Obsidian's `app.vault.*` API, never direct `fs.*` writes:

| Operation | Source file | API used |
|-----------|------------|----------|
| Task file creation | `src/adapters/task-agent/BackgroundEnrich.ts` | `app.vault.create()`, `app.vault.createFolder()` |
| Task file reading | `src/adapters/task-agent/TaskParser.ts`, `TaskMover.ts` | `app.vault.read()` |
| Task file modification (state, frontmatter) | `src/adapters/task-agent/TaskMover.ts` | `app.vault.modify()` |
| Task file movement between state folders | `src/adapters/task-agent/TaskMover.ts` | `app.vault.rename()` |
| Task folder creation when state folders don't exist | `src/adapters/task-agent/TaskMover.ts`, `BackgroundEnrich.ts` | `app.vault.createFolder()` |
| UUID backfill into task frontmatter | `src/adapters/task-agent/TaskParser.ts` | `app.vault.read()`, `app.vault.modify()` |
| Task file metadata reading | `src/adapters/task-agent/TaskParser.ts` | `app.metadataCache.getFileCache()` |
| Detail view opening | `src/adapters/task-agent/TaskDetailView.ts` | `app.vault.getAbstractFileByPath()` |

### Plugin data (Obsidian plugin API)

Uses `plugin.loadData()` / `plugin.saveData()`, stored in `.obsidian/plugins/work-terminal/data.json`:

- Settings (core + adapter)
- Guided tour completion state
- Custom session defaults

Source: `src/core/PluginDataStore.ts`, `src/framework/GuidedTour.ts`, `src/framework/TerminalPanelView.ts`, `src/framework/MainView.ts`

### Outside the vault (direct `fs.*`)

| Path | Operation | Trigger | Source file |
|------|-----------|---------|-------------|
| `pty-wrapper.py` | Read-only existence check | Terminal tab spawn | `src/core/terminal/TerminalTab.ts` - `resolvePtyWrapperPath()` (line 77) |
| Command binary paths | Read-only existence + executable check | Terminal tab spawn, headless Claude spawn | `src/core/agents/AgentLauncher.ts` - `resolveCommandInfo()` (line 155) |

## Security properties

- **All external commands are user-configured** - Shell, Claude, Copilot, and Strands commands are set in plugin settings, not hardcoded. The plugin resolves them against `$PATH` via `resolveCommandInfo()` and validates they exist before spawning. (`src/core/agents/AgentLauncher.ts`)
- **`child_process.spawn()` array form - no shell interpretation** - Arguments are constructed as arrays and passed to `spawn()`, which invokes executables directly without a shell. This prevents command injection. The one exception is the VS Code `code --goto` call which uses `exec()` with a quoted path. (`src/core/terminal/TerminalTab.ts`, `src/core/claude/HeadlessClaude.ts`)
- **Zero outbound network requests from the plugin itself** - The plugin makes no network calls. Any network activity comes from the spawned processes (e.g. Claude CLI communicating with Anthropic's API).
- **Vault modifications exclusively through Obsidian API** - Vault file operations use `app.vault.create()` / `app.vault.modify()` / `app.vault.rename()`, never direct `fs.*` writes to vault files.
- **Minimal direct filesystem writes** - Direct `fs.*` writes are limited to reading `pty-wrapper.py` and checking command binary paths. All other filesystem operations go through Obsidian's API.
- **Plugin data via Obsidian API** - Settings use `plugin.loadData()` / `plugin.saveData()`, stored in the vault's `.obsidian/plugins/work-terminal/data.json`.
