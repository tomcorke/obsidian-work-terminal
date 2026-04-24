# obsidian-work-terminal

Obsidian plugin that turns your vault into a work item board with per-item tabbed terminals. Built for extensibility - swap in your own work item system while keeping the terminal infrastructure.

## Screenshots

<!-- Screenshots captured from isolated test vault with sample data.
     Click any image to view full resolution. -->

<table>
<tr>
<td width="50%"><a href="docs/screenshots/main-view.png"><img src="docs/screenshots/main-view.png" alt="Main layout with kanban board, terminal tabs, task icons, and detail panel" width="100%"></a><br><sub>Kanban board with tabbed terminals and detail view</sub></td>
<td width="50%"><a href="docs/screenshots/agent-session.png"><img src="docs/screenshots/agent-session.png" alt="Agent CLI session running in a terminal tab with state detection" width="100%"></a><br><sub>Agent session with activity state detection</sub></td>
</tr>
<tr>
<td width="50%"><a href="docs/screenshots/compact-mode.png"><img src="docs/screenshots/compact-mode.png" alt="Kanban board in compact display mode with single-line cards and indicator dots" width="100%"></a><br><sub>Compact card mode with indicator dots</sub></td>
<td width="50%"><a href="docs/screenshots/settings-general.png"><img src="docs/screenshots/settings-general.png" alt="Plugin settings organised into sections with sub-dialogs" width="100%"></a><br><sub>Settings organised into sections with sub-dialogs</sub></td>
</tr>
</table>

See the **[User Guide](docs/user-guide.md)** for more screenshots covering every feature.

## Features

- **Kanban board** with collapsible sections, drag-drop reordering, custom sort order, and dynamic columns for custom states
- **Tabbed terminals** per work item - Shell, Claude, contextual Claude, and custom agent profiles (Copilot, Strands, or any CLI)
- **Agent integration** - reusable profiles with the Profile Manager, agent state detection (active/waiting/idle), background enrichment with retry and failure logging
- **Multiple view modes** - standard kanban columns, compact single-line cards with indicator dots, comfortable density, or activity view grouped by recency
- **Task card customisation** - custom icons (Lucide or emoji), card indicator rules for visual flags, pinned tasks section, configurable badges
- **Detail view placements** - split, tab, navigate, read-only preview tab, embedded editor tab (experimental), or disabled
- **Session persistence** - hot-reload preserves live terminals with full PTY state
- **First-run guided tour** - focused walkthrough for task creation, session launch, tab management, and key settings
- **Adapter architecture** - swap the work item system without touching terminal code

## Installation

**Requirements**: Node.js 20.19.0+ and Python 3 (for PTY-backed terminal tabs).

Run these commands from the directory where you want to keep the plugin source:

```bash
git clone https://github.com/tomcorke/obsidian-work-terminal.git
cd obsidian-work-terminal
pnpm install
pnpm run build
```

Then symlink this repo directory into your vault. Replace `"/path/to/your/vault"` with your vault path:

```bash
VAULT="/path/to/your/vault"
mkdir -p "$VAULT/.obsidian/plugins"
ln -s "$(pwd)" "$VAULT/.obsidian/plugins/work-terminal"
```

If `work-terminal` already exists in `.obsidian/plugins`, remove that directory or symlink first. After pulling updates, run `pnpm run build` again before reopening Obsidian. Then enable **Work Terminal** in Obsidian's **Community plugins** settings.

## Quick start

1. Enable the plugin in Obsidian's Community plugins settings
2. Open the Work Terminal view from the command palette ("Work Terminal: Open View") or click the terminal icon in the ribbon
3. A guided tour walks you through the key features on first open - follow along or dismiss it
4. Create a work item using the prompt box at the top of the kanban board
5. Click "+ Shell" to open a terminal tab, or "Claude" / "Claude (ctx)" for an AI agent session

## Process spawning & security

This plugin spawns external processes to provide terminal and AI agent functionality. All commands are user-configured and resolved against `$PATH` (augmented with login shell and version-manager paths). Arguments are passed as arrays via `child_process.spawn()` (no shell interpretation, with one exception: Cmd+clicking a file path in terminal output runs `code --goto` via `exec()` to open the file in VS Code). The plugin makes zero outbound network requests. Vault files are modified through the Obsidian API (`app.vault.*` and `app.vault.adapter.*`), not raw `fs.*` writes.

For a complete, source-verified inventory of every process spawned, every file read or written, and all security properties, see **[Process Spawning & Filesystem Disclosure](docs/process-spawning.md)**.

## Documentation

- **[Changelog](CHANGELOG.md)** - concise release history using the same structure as the GitHub release notes
- **[User Guide](docs/user-guide.md)** - comprehensive guide covering all features with screenshots
- **[Process Spawning & Filesystem Disclosure](docs/process-spawning.md)** - full inventory of spawned processes, filesystem access, and security properties
- **[Architecture](docs/architecture.md)** - three-layer design, extension model, key design decisions
- **[Creating an Adapter](docs/creating-an-adapter.md)** - build your own work item system with code examples
- **[Development](docs/development.md)** - build, test, hot-reload, CDP helper, isolated test vault
- **[Release Process](docs/release-process.md)** - version bump, changelog, tagging, and GitHub release workflow

## License

MIT
