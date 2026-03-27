## Why

The original `obsidian-task-terminal` plugin was built iteratively in a single day, accumulating ~4,500 lines of tightly-coupled code with zero tests. Rather than refactoring in-place, a new plugin (`obsidian-work-terminal`) is being built from scratch in a new repo with clean foundations, proper structure, and an adapter-based architecture that allows others to fork and plug in their own task system.

Phase 0 establishes the repository, build tooling, and a minimal working plugin that proves the core infrastructure works: esbuild bundling, CDP hot-reload, and xterm.js terminal rendering inside Obsidian. This is the foundation that all subsequent phases build on.

## What Changes

- Create a new GitHub repo `tomcorke/obsidian-work-terminal` and clone to `~/working/obsidian-work-terminal/`
- Scaffold project files: `package.json`, `tsconfig.json`, `manifest.json` (plugin ID: `work-terminal`)
- Port build tooling from the original plugin: `esbuild.config.mjs` (updated for new plugin ID and output path) and `cdp.js`
- Port `pty-wrapper.py` as-is from the original plugin
- Create `CLAUDE.md` with project rules and development workflow
- Implement a minimal working plugin: an Obsidian `ItemView` with an empty split layout and one xterm.js terminal rendering
- Build output targets `~/working/obsidian/test-vault/Test/.obsidian/plugins/work-terminal/`

## Capabilities

### New Capabilities
- `project-scaffold`: Repository creation, project file scaffolding (`package.json`, `tsconfig.json`, `manifest.json`), build tooling (`esbuild.config.mjs`, `cdp.js`), PTY wrapper, and project documentation (`CLAUDE.md`)
- `smoke-test`: Minimal working Obsidian plugin - registers a view, renders an empty split layout with one xterm.js terminal, verifies build + CDP hot-reload + terminal rendering

### Modified Capabilities
(none)

## Impact

- **New repository**: `github.com/tomcorke/obsidian-work-terminal` with initial project structure
- **Build output**: Plugin files written to `~/working/obsidian/test-vault/Test/.obsidian/plugins/work-terminal/`
- **Dependencies**: `@xterm/xterm`, `@xterm/addon-fit` (runtime); `esbuild`, `typescript`, `obsidian`, `@types/node` (dev)
- **No impact on original plugin**: `obsidian-task-terminal` remains untouched as a working reference
