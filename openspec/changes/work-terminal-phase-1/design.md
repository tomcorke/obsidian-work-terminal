## Context

`obsidian-work-terminal` is a new Obsidian plugin built from scratch with a three-layer architecture: core (terminal infrastructure), framework (Obsidian plugin scaffolding), and adapters (work-item implementations). Phase 0 established the repo with esbuild, TypeScript config, manifest, and a minimal smoke-test plugin.

Phase 1 creates the foundational files that all subsequent phases depend on: shared utility functions and the complete set of TypeScript interfaces defining the adapter extension model.

The original `obsidian-task-terminal` plugin contains inline implementations of these utilities and implicit interfaces embedded in ~4,500 lines of coupled code. This phase extracts and formalises them.

## Goals / Non-Goals

**Goals:**
- Port `expandTilde`, `stripAnsi`, `electronRequire`, `slugify` to `src/core/utils.ts` as clean, tested, exported functions
- Define all adapter-boundary interfaces in `src/core/interfaces.ts` matching the architecture spec
- Provide `BaseAdapter` abstract class with sensible defaults for optional methods
- Add vitest with a test suite covering all utility function edge cases
- Verify the project still builds cleanly with esbuild after adding new files

**Non-Goals:**
- Wiring utils or interfaces into any runtime code path (that happens in Phase 2+)
- Implementing any interface (adapters are Phase 4)
- Adding DOM-dependent or Obsidian-dependent tests (those are out of scope per test strategy)
- Modifying the Phase 0 smoke-test plugin entry point

## Decisions

### D1: stripAnsi uses a two-stage approach

**Decision:** `stripAnsi` first replaces CSI cursor-forward sequences (`ESC[nC`) with equivalent spaces, then strips all remaining ANSI/control sequences in a second pass.

**Rationale:** This is the battle-tested approach from the original plugin. A single-pass strip breaks TUI-rendered text alignment because cursor-forward sequences represent whitespace positioning. The two-stage approach preserves word gaps while removing all escape formatting. This function is critical for Claude state detection and session rename parsing.

### D2: electronRequire wraps window.require with fallback

**Decision:** `electronRequire` returns `window.require(module)` when available, falling back to Node `require(module)`.

**Rationale:** Obsidian runs in Electron where Node built-ins (`child_process`, `fs`, `path`, `os`) must be accessed via `window.require`. The wrapper centralises this pattern, which is currently duplicated across multiple files in the original plugin. The esbuild config externalises these modules.

### D3: slugify truncates to 40 characters with clean trailing

**Decision:** `slugify` lowercases, replaces non-alphanumeric runs with hyphens, strips leading/trailing hyphens, truncates to 40 characters, then strips any trailing hyphen created by truncation.

**Rationale:** Matches the original plugin's inline slug generation used for task filenames. The 40-character limit keeps filenames reasonable. The final trailing-hyphen strip prevents filenames like `my-very-long-task-title-that-gets-trun-`.

### D4: Interfaces reference Obsidian types as type-only imports

**Decision:** `interfaces.ts` uses `import type { TFile, App, MenuItem } from "obsidian"` for Obsidian API types.

**Rationale:** Type-only imports are erased at compile time and do not create runtime dependencies. This keeps the interfaces file as a pure type definition that can be consumed by tests and adapters without pulling in the Obsidian runtime.

### D5: BaseAdapter is an abstract class, not a mixin or utility

**Decision:** `BaseAdapter` is an `abstract class` implementing `AdapterBundle` with default implementations for optional methods (`createDetailView`, `onItemCreated`, `transformSessionLabel`).

**Rationale:** An abstract class provides the clearest TypeScript experience: adapters `extend BaseAdapter` and get compile-time enforcement of required methods while inheriting sensible defaults. This matches the architecture decision (D4 in the task file).

### D6: SettingField defined alongside PluginConfig

**Decision:** `SettingField` interface (used by `PluginConfig.settingsSchema`) is defined in `interfaces.ts` with fields for `key`, `name`, `description`, `type`, and `default`.

**Rationale:** The settings schema is part of the adapter contract - adapters declare their settings via `PluginConfig.settingsSchema`. Defining it alongside `PluginConfig` keeps the full adapter contract in one file.

### D7: vitest chosen over jest

**Decision:** Use vitest for unit testing.

**Rationale:** Matches the test strategy in the task file. vitest has native TypeScript and ESM support, faster execution than jest, and a compatible API. It integrates cleanly with the esbuild-based build without additional transform configuration.

## Risks / Trade-offs

- **[Interface stability]** - Interfaces defined now may need adjustment as Phase 2-4 implementation reveals edge cases. Mitigation: interfaces are type-only with no runtime cost, so changes are low-friction. The comprehensive architecture spec reduces the likelihood of surprises.
- **[stripAnsi regex complexity]** - The two-stage ANSI stripping regex is complex and handles edge cases discovered through production use. Mitigation: thorough test coverage of known edge cases from the original plugin.
- **[Obsidian type dependency]** - `interfaces.ts` depends on `obsidian` types (`TFile`, `App`, `MenuItem`). If the Obsidian API changes these types, interfaces need updating. Mitigation: type-only imports, and Obsidian's API is stable for these core types.
