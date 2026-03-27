## Why

The `obsidian-work-terminal` plugin (Phase 0) has a working repo scaffold with esbuild, manifest, and a smoke-test split layout. Phase 1 establishes the foundational layer that every subsequent phase builds on: shared utility functions and the full set of TypeScript interfaces that define the adapter extension model. Without these, Phase 2 (terminal core) and Phase 3 (framework) cannot be built, and the adapter boundary cannot be enforced.

The utility functions (`expandTilde`, `stripAnsi`, `electronRequire`, `slugify`) are extracted from inline implementations scattered across the original plugin's `TerminalTab.ts`, `TaskTerminalView.ts`, and `TaskListPanel.ts`. Centralising them in `src/core/utils.ts` eliminates duplication and makes them testable in isolation.

The interfaces in `src/core/interfaces.ts` define the contract between the framework and any adapter. This is the extension model - anyone forking the repo to build a different work-item type (Jira tickets, GitHub issues, etc.) needs only implement `AdapterBundle` and its sub-interfaces. Getting these right before writing implementation code prevents costly rework.

## What Changes

- New `src/core/utils.ts` - four utility functions ported from the original plugin, consolidated and cleaned up
- New `src/core/interfaces.ts` - all adapter-boundary interfaces (`WorkItem`, `WorkItemParser`, `WorkItemMover`, `CardRenderer`, `CardActionContext`, `WorkItemPromptBuilder`, `PluginConfig`, `ListColumn`, `CreationColumn`, `AdapterBundle`) plus `BaseAdapter` abstract class with sensible defaults
- New vitest configuration and test suite for utils
- Build verification (esbuild still produces valid output with new files)

## Capabilities

### New Capabilities
- `core-utils`: Shared utility functions - `expandTilde`, `stripAnsi`, `electronRequire`, `slugify` - available for import by all layers
- `core-interfaces`: Full adapter-boundary type definitions and `BaseAdapter` abstract class for the extension model

### Modified Capabilities

_(none - Phase 0 artifacts are unchanged)_

## Impact

- **`src/core/utils.ts`**: New file. Pure functions with no Obsidian or DOM dependencies. `electronRequire` wraps `window.require` for Electron context.
- **`src/core/interfaces.ts`**: New file. TypeScript interfaces and one abstract class. References Obsidian API types (`TFile`, `App`, `MenuItem`) as type-only imports.
- **`vitest.config.ts`** (or equivalent): New dev dependency and config for vitest.
- **`package.json`**: Adds `vitest` as a dev dependency and a `test` script.
- **No runtime behaviour change** - the plugin still loads and renders the Phase 0 smoke-test layout. These files are not yet wired into any runtime code path.
