# Initial Implementation History

> **Note:** This document is a historical record only. It describes the spec-driven process used to build the first working version of this plugin. The implementation has diverged significantly from these original specs - file names, interfaces, behaviours, and architectural decisions have all evolved. Do not treat this as documentation of current behaviour; see [CLAUDE.md](../CLAUDE.md) and [README.md](../README.md) for that.

---

This project was bootstrapped using [OpenSpec](https://github.com/tomcorke/openspec) - a structured spec-to-implementation workflow. The original `openspec/` directory has been removed, but this summary captures what was planned in each phase and why, as context for anyone curious about the project's origins.

## Background

This plugin was built as a clean-room rewrite of an earlier plugin (`obsidian-task-terminal`), which had grown to ~4,500 lines of tightly-coupled, untested code built in a single day. The goal was a modular, adapter-based architecture that others could fork and adapt to their own work-item systems.

---

## Phase 0 - Project Scaffold

**Goal:** Establish the repo, build tooling, and a minimal smoke-test plugin.

Covered: new GitHub repo, `package.json` / `tsconfig.json` / `manifest.json`, esbuild config, `cdp.js` (CDP hot-reload helper), `pty-wrapper.py` (Python PTY bridge for Electron sandbox), and a minimal Obsidian `ItemView` proving the build pipeline and xterm.js rendering both worked.

---

## Phase 1 - Core Utils and Interfaces

**Goal:** Define shared utilities and the adapter extension contract before writing any implementation code.

- `src/core/utils.ts` - utility functions (`expandTilde`, `stripAnsi`, `electronRequire`, `slugify`) extracted from the original plugin and made testable in isolation.
- `src/core/interfaces.ts` - all adapter-boundary types: `WorkItem`, `WorkItemParser`, `WorkItemMover`, `CardRenderer`, `WorkItemPromptBuilder`, `PluginConfig`, `AdapterBundle`, and the `BaseAdapter` abstract class.

The interface design was the most important output of this phase: it defines the extension model that lets anyone swap in a different work-item backend without touching the terminal infrastructure.

---

## Phase 2 - Terminal Core

**Goal:** Port terminal, Claude CLI, and session persistence from the original plugin into clean, focused modules.

Replaced a monolithic ~740-line `TerminalTab.ts` with:

- **Terminal primitives:** `XtermCss.ts` (CSS injection), `ScrollButton.ts`, `KeyboardCapture.ts` (two-layer Obsidian keystroke interception)
- **PTY wiring:** `TerminalTab.ts` rebuilt - Python PTY via `pty-wrapper.py`, xterm.js, OSC resize protocol, spawn delay, SIGTERM/SIGKILL dispose
- **Tab management:** `TabManager.ts` - groups keyed by item ID, session type tracking, tab bar, drag-drop
- **Claude integration:** `ClaudeLauncher.ts`, `ClaudeStateDetector.ts` (buffer-reading state detection), `ClaudeSessionRename.ts`, `HeadlessClaude.ts`
- **Session persistence:** `SessionStore.ts` (window-global hot-reload stash), `SessionPersistence.ts` (versioned disk persistence, 7-day retention, UUID-based resume)

---

## Phase 3 - Framework (Obsidian Plugin Wiring)

**Goal:** Compose the core modules into a working Obsidian plugin with adapter-driven UI.

Introduced all framework files: `PluginBase.ts`, `MainView.ts`, `ListPanel.ts`, `TerminalPanelView.ts`, `PromptBox.ts`, `SettingsTab.ts`, `DangerConfirm.ts`, and `styles.css`.

The original spec called for a 3-column layout (list | detail | terminals). This was revised in Phase 3.5.

---

## Phase 3.5 - Detail Layout Fix

**Goal:** Replace the custom CSS 3-column layout with Obsidian's native workspace leaf API.

The Phase 3 detail panel was a custom `<div>` container - it worked, but couldn't give users live preview, frontmatter editing, or backlinks. This phase rebuilt it as a proper Obsidian `MarkdownView` created via `workspace.createLeafBySplit()`, making the adapter's `createDetailView` signature `(item, app, ownerLeaf)` instead of `(item, containerEl)`.

This was a breaking interface change that also simplified the main layout to 2 panels (list | terminals), with detail as a separate workspace leaf.

---

## Phase 4 - Task-Agent Adapter

**Goal:** Build the concrete adapter that makes the plugin useful for task management.

`src/adapters/task-agent/` implements the full `AdapterBundle` against Obsidian vault frontmatter:

- `TaskParser.ts` - reads `MetadataCache`, normalises fields, filters abandoned tasks
- `TaskMover.ts` - regex frontmatter updates, write-then-move, activity log
- `TaskCard.ts` - score/goal/source/blocker badges, compound context menu
- `TaskFileTemplate.ts` - UUID + YAML frontmatter + slug filename
- `TaskPromptBuilder.ts` - title/state/path + conditional deadline/blocker for Claude context
- `TaskDetailView.ts` - `MarkdownView` via `createLeafBySplit`, flex sizing
- `BackgroundEnrich.ts` - headless Claude enrichment on task creation

---

## Phase 5 - Regression Testing

**Goal:** Verify feature parity between the new plugin and the original `obsidian-task-terminal` before polish work.

Produced a formal regression test document covering all 34 feature inventory items plus undocumented implementation details (hot-reload terminal preservation, session persistence tiers, rename detection, Claude state indicator animations). Used as a manual test plan run against a live Obsidian instance via CDP.

---

## What Has Diverged

Since these phases were completed, the implementation has continued to evolve:

- The layout and session model have been extended (e.g. Copilot CLI session support).
- Interface signatures and module boundaries have been refined.
- New features have been added that were never in the original spec.

For current architecture, see [CLAUDE.md](../CLAUDE.md). For usage, see [README.md](../README.md).
