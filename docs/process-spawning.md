# Process Spawning & Filesystem Disclosure

[Back to README](../README.md)

This plugin spawns external processes and performs filesystem operations to provide terminal and AI agent functionality. This document is a complete, source-verified inventory of what the plugin executes, reads, and writes.

## Processes spawned

### 1. Shell tabs

`python3 pty-wrapper.py <cols> <rows> -- <shell>` where `<shell>` is the user's configured shell (defaults to `$SHELL` or `/bin/zsh`).

- **Trigger**: User clicks "+ Shell" button
- **Source**: `src/core/terminal/TerminalTab.ts` - `spawnPty()`
- **Mechanism**: `child_process.spawn()` with array args (no shell interpretation)

### 2. Claude CLI

User-configured command (default: `claude`) with `--session-id <uuid>` and optional context prompt as a positional argument. Extra args from settings are prepended.

- **Trigger**: User clicks "Claude" or "Claude (ctx)" button, or launches a Claude-type agent profile
- **Source**: `src/core/agents/AgentLauncher.ts` - `buildClaudeArgs()`
- **Mechanism**: Spawned inside `pty-wrapper.py` via `TerminalTab.spawnPty()`

### 3. GitHub Copilot CLI

User-configured command (default: `copilot`) with optional `-i <prompt>`.

- **Trigger**: User launches a Copilot session via profile launch modal or tab bar button
- **Source**: `src/core/agents/AgentLauncher.ts` - `buildCopilotArgs()`
- **Mechanism**: Spawned inside `pty-wrapper.py` via `TerminalTab.spawnPty()`

### 4. OpenCode CLI

Profile-configured command (default: `opencode`) with optional `--prompt <prompt>`. The prompt is passed as one argv value.

- **Trigger**: User launches an OpenCode session via profile launch modal or tab bar button
- **Source**: `src/core/agents/AgentProfile.ts` launch configuration and the shared `src/core/agents/AgentLauncher.ts` pipeline
- **Mechanism**: Spawned inside `pty-wrapper.py` via `TerminalTab.spawnPty()`

### 5. AWS Strands

User-configured command with optional positional prompt argument. Extra args from settings are prepended.

- **Trigger**: User launches a Strands session via profile launch modal or tab bar button
- **Source**: `src/core/agents/AgentLauncher.ts` - `buildStrandsArgs()`
- **Mechanism**: Spawned inside `pty-wrapper.py` via `TerminalTab.spawnPty()`

### 6. Custom agent profiles

User-configured command with user-configured arguments. Any executable can be launched as a custom agent type.

- **Trigger**: User launches a custom-type agent profile via profile launch modal or tab bar button
- **Source**: `src/core/agents/AgentLauncher.ts` - `buildCustomArgs()`
- **Mechanism**: Spawned inside `pty-wrapper.py` via `TerminalTab.spawnPty()`

### 7. Headless agent (background enrichment)

One-shot `claude -p <prompt> --output-format text` (or the configured enrichment profile command) for background task enrichment. Extra args from the profile are prepended.

- **Trigger**: Task creation with background enrichment enabled, or "Retry Enrichment" context menu action
- **Source**: `src/core/claude/HeadlessClaude.ts` - `spawnHeadlessClaude()`
- **Mechanism**: `child_process.spawn()` with array args (no shell interpretation)

### 8. Pi automatic tab title generation

One-shot `pi [user-configured arguments] --print --no-session --no-tools --no-context-files <prompt>` generates a short title from recent agent terminal output. Model, provider, and thinking arguments are visible and editable in settings; blank uses the user's Pi defaults.

- **Trigger**: An active agent work cycle becomes idle or waiting while "Automatically rename agent tabs" is enabled (disabled by default); unchanged output and requests within the five-minute cooldown are skipped
- **Source**: `src/core/terminal/PiTabTitle.ts` - `generateTabTitleWithPi()`
- **Mechanism**: `child_process.spawn()` with array args (no shell interpretation); skipped when `pi` cannot be resolved

### 9. VS Code

`code --goto "{file}:{line}"` on terminal file-link clicks (Cmd+click on file paths in terminal output). Falls back to `shell.openPath()` if VS Code is not available.

- **Trigger**: User Cmd+clicks a file path in terminal output
- **Source**: `src/core/terminal/TerminalTab.ts` - link provider `activate` callback
- **Mechanism**: `child_process.exec()` (string form, with shell interpretation)

**Note**: All terminal processes (Shell, Claude, Copilot, OpenCode, Strands, custom agents) run inside `pty-wrapper.py`, a Python script that uses `pty.fork()` to provide a real pseudo-terminal. Electron's sandbox blocks native PTY access, so this Python wrapper is the necessary bridge between xterm.js and the child process.

### Task tab broker child environment

When the global task tab broker is enabled and an agent profile has at least one explicit capability grant, the terminal child additionally receives `WORK_TERMINAL_BROKER_PROTOCOL`, `WORK_TERMINAL_BROKER_ENDPOINT`, `WORK_TERMINAL_TASK_ID`, `WORK_TERMINAL_TAB_ID`, `WORK_TERMINAL_TAB_GENERATION`, and `WORK_TERMINAL_BROKER_TOKEN`. Profiles without grants receive none of these values. The endpoint and token are sensitive local capability material and are excluded from ordinary logs and diagnostics.

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
| Icon frontmatter update | `src/adapters/task-agent/index.ts` | `app.vault.read()`, `app.vault.modify()` |
| Task file deletion | `src/framework/ListPanel.ts` | `app.vault.trash()` |

### Plugin data (Obsidian plugin API)

Uses `plugin.loadData()` / `plugin.saveData()`, stored in `.obsidian/plugins/work-terminal/data.json`:

- Settings (core + adapter)
- Guided tour completion state
- Custom session defaults
- Activity timestamps for the activity view (`lastActiveById`)

Source: `src/core/PluginDataStore.ts`, `src/core/LastActiveStore.ts`, `src/framework/GuidedTour.ts`, `src/framework/TerminalPanelView.ts`, `src/framework/MainView.ts`

### Agent profiles file (raw `fs`)

Agent profiles live in `~/.config/obsidian-work-terminal/profiles.json`, outside plugin data, so they can be hand-edited, bulk-edited, and version-controlled. The file is a JSON array of profiles, shared across vaults. Reads treat a missing or empty file as "no profiles yet" and migrate from the plugin data key `agentProfiles`; an unreadable or non-array file is left untouched and built-in defaults are used in memory.

Source: `src/core/agents/ProfileFileStore.ts`, `src/core/agents/AgentProfileManager.ts`

### Plugin directory (Obsidian vault adapter)

Enrichment failure logs are written to `<vault>/<configDir>/plugins/work-terminal/logs/` using `app.vault.adapter.write()` (not raw `fs.*`). Logs contain the enrichment prompt, agent stdout/stderr, exit code, and error details. Retention is capped at 50 files and 7 days.

| Operation | Trigger | Source file |
|-----------|---------|-------------|
| Write diagnostic log | Background enrichment failure | `src/adapters/task-agent/EnrichmentLogger.ts` |
| Prune old logs | Each new log write | `src/adapters/task-agent/EnrichmentLogger.ts` |
| List log directory | Pruning | `src/adapters/task-agent/EnrichmentLogger.ts` |

### Outside the vault (direct `fs.*`)

| Path | Operation | Trigger | Source file |
|------|-----------|---------|-------------|
| `pty-wrapper.py` | Read-only existence check | Terminal tab spawn | `src/core/terminal/TerminalTab.ts` - `resolvePtyWrapperPath()` |
| Command binary paths | Read-only existence + executable check | Terminal tab spawn, headless agent spawn | `src/core/agents/AgentLauncher.ts` - `resolveCommandInfo()` |
| User-private runtime directory | Create/remove one Unix-domain socket; directory mode `0700`, socket mode `0600` | Task tab broker enabled, disabled, or reloaded | `src/core/broker/TaskTabBrokerTransport.ts` |

On Windows the broker uses a named pipe instead of a filesystem socket. It never opens a TCP or other network listener. A stale Unix path is removed only when it is a socket; the plugin refuses to replace a regular file at the endpoint.

## Security properties

- **External commands are profile-configurable** - Shell and agent commands can be overridden in profiles or settings; built-in types provide defaults including `claude`, `copilot`, and `opencode`. The plugin resolves them via `resolveCommandInfo()`, which searches an augmented PATH that includes `$PATH`, the user's login shell PATH (via `$SHELL -lc 'echo $PATH'`), and nvm/fnm version-manager directories as a fallback. It validates commands exist before spawning. (`src/core/agents/AgentLauncher.ts`)
- **`child_process.spawn()` array form - no shell interpretation** - Arguments are constructed as arrays and passed to `spawn()`, which invokes executables directly without a shell. This prevents command injection. The one exception is the VS Code `code --goto` call which uses `exec()` with a quoted path. (`src/core/terminal/TerminalTab.ts`, `src/core/claude/HeadlessClaude.ts`)
- **Zero outbound network requests from the plugin itself** - The plugin makes no network calls. Any network activity comes from the spawned processes (e.g. Claude CLI communicating with Anthropic's API).
- **Vault modifications exclusively through Obsidian API** - Vault file operations use `app.vault.create()` / `app.vault.modify()` / `app.vault.rename()` / `app.vault.trash()`, never direct `fs.*` writes to vault files. Enrichment logs use the lower-level `app.vault.adapter.write()` but this is still within the Obsidian API surface.
- **Minimal direct filesystem access** - Direct `fs.*` calls cover read-only checks on `pty-wrapper.py` and command binary paths, profile-file storage, and creation/removal of the private local broker socket. Enrichment failure logs are written via `app.vault.adapter`, not raw `fs.*`; vault content operations go through Obsidian's API.
- **Plugin data via Obsidian API** - Settings use `plugin.loadData()` / `plugin.saveData()`, stored in the vault's `.obsidian/plugins/work-terminal/data.json`.
- **Task tab broker is default-off and least-privilege** - Both the global broker setting and exact per-profile grants are required. Tokens bind the caller's vault, task, tab generation, profile, and launch-time grant snapshot. Removed grants revoke live access; added grants require a new session.
- **Local IPC is not a same-user sandbox** - Socket permissions and random tokens prevent casual unrelated access, but another process running as the same OS user may be able to inspect process environments or memory. The broker therefore exposes only bounded vault-local task/tab methods and never arbitrary shell, filesystem, DOM, xterm, process-handle, or workspace access.
- **Bounded protocol** - IPC is versioned newline-delimited JSON with 65,536-byte frames, bounded connections and in-flight requests, request/result limits, rate limits, exact tab generations, and structured failures. Reload closes clients; opted-in live sessions reconnect to the same endpoint and reconcile current state.
