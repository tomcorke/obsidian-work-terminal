# Regression Test Document - obsidian-work-terminal

**Plugin:** work-terminal (obsidian-work-terminal v2)
**Reference:** obsidian-task-terminal (original, ~/working/claude-sandbox/obsidian-task-terminal/)
**Test method:** Manual via CDP remote debugging (port 9222)
**Date:** _______________
**Tester:** _______________

## How to Use

1. Build the plugin: `pnpm run build` in `~/working/obsidian-work-terminal/`
2. Enable "Work Terminal" in Obsidian Settings > Community Plugins
3. Open the Work Terminal view via command palette
4. Work through each test case, marking Status as PASS / FAIL / SKIP
5. Record any issues in the Notes column
6. For ambiguous behaviours, load the original plugin side-by-side for comparison

**Status key:** PASS | FAIL | SKIP | N/A

---

## 1. Terminal Core

### Preconditions
- Plugin loaded and view open
- At least one task card visible in the list panel
- A task selected (click on a card)

| ID | Description | Steps | Expected Result | Status | Notes |
|----|-------------|-------|-----------------|--------|-------|
| TC-01 | Python PTY wrapper spawns shell | Click "+ Shell" button in tab bar | pty-wrapper.py spawns a login interactive shell (`-l -i`). Terminal shows shell prompt. `ps` shows python3 pty-wrapper.py process. | | |
| TC-02 | Tilde expansion in cwd | Check spawned shell's working directory (`pwd`) | Should be expanded home directory, not literal `~` | | |
| TC-03 | Keyboard: Option+Arrow | Focus terminal, press Option+Right Arrow | Cursor moves forward one word (escape sequence sent, not Obsidian shortcut) | | |
| TC-04 | Keyboard: Shift+Enter | Focus terminal, press Shift+Enter | Newline sent to terminal (not Obsidian's default behaviour) | | |
| TC-05 | Keyboard: Option+Backspace | Focus terminal, type a word, press Option+Backspace | Deletes previous word (escape sequence sent) | | |
| TC-06 | Keyboard: Option+B / Option+F / Option+D | Focus terminal, press Option+B / Option+F / Option+D | Word navigation/delete works via explicit escape-sequence handling. Option+B / Option+F / Option+D are reserved for terminal editing even on layouts where they would otherwise be printable. | | |
| TC-06a | Keyboard: Option+3 on macOS UK | Focus terminal, press Option+3 | `#` is inserted into the terminal input instead of being swallowed, while other non-digit Option shortcuts still follow terminal Meta handling. | | |
| TC-06b | Keyboard: restored terminal Option handling | Hot-reload with an existing terminal tab, then press Option+3 and Option+T | Restored tabs match fresh tabs: Option+3 inserts the printable character, while Option+T still follows terminal Meta behavior. | | |
| TC-07 | Resize protocol | Drag the divider to resize the terminal panel | Terminal re-fits to new dimensions. No truncated lines. OSC `ESC]777;resize;COLS;ROWS BEL` sent to pty-wrapper.py (check pty-wrapper.py handles it). | | |
| TC-08 | Double-rAF on tab show | Switch between tabs, observe terminal rendering | No blank/misrendered terminal. fitAddon measurements correct (double requestAnimationFrame ensures layout). | | |
| TC-09 | Screen reading via cursor position | Run a command with short output (e.g. `echo hello`) in a tall terminal | State detector reads content at `baseY + cursorY`, not buffer bottom. Should find the prompt correctly. | | |
| TC-10 | Scroll-to-bottom button | Run a long command (e.g. `seq 1000`), scroll up | Scroll-to-bottom overlay button appears. Clicking it scrolls to bottom. Button disappears when at bottom. | | |
| TC-11 | 3s tab keep-alive on early exit | Run a command that fails immediately: `false` or spawn a process that exits instantly | Tab stays open for 3 seconds showing error output before closing (or stays open permanently if configured). | | |
| TC-12 | xterm.js CSS injection | Inspect the DOM for xterm CSS | CSS injected via singleton XtermCss. Terminal renders with correct fonts, colours, cursor. No missing styles. | | |
| TC-13 | resolveCommand() for Claude | Check Claude binary resolution | Claude binary found via PATH augmentation (prepends ~/.local/bin, nvm, /usr/local/bin, /opt/homebrew/bin). Works even in Electron's limited PATH. | | |
| TC-14 | 150ms spawn delay | Open a new terminal tab, observe timing | Brief delay before shell prompt appears (150ms for CSS layout to complete). Initial terminal dimensions should be correct (not 80x24 default). | | |
| TC-15 | Silent fitAddon.fit() errors | Rapidly resize, switch tabs, or trigger lifecycle transitions | No uncaught exceptions from fitAddon.fit(). Errors silently caught. | | |
| TC-16 | ResizeObserver skips fit when hidden | Have multiple tabs, resize while a tab is hidden | Hidden tabs should not attempt fit (avoids zero-dimension errors). Fit deferred via rAF. | | |
| TC-17 | SIGTERM then SIGKILL on dispose | Close a tab with a running process | Process receives SIGTERM. If still running after 1s, SIGKILL sent. No orphan processes. | | |
| TC-18 | Timestamp + counter terminal IDs | Rapidly open multiple terminals | Each terminal has a unique ID (no collision from Date.now() alone). | | |

## 2. Tab Management

### Preconditions
- Plugin loaded, task selected, at least 2 terminal tabs open

| ID | Description | Steps | Expected Result | Status | Notes |
|----|-------------|-------|-----------------|--------|-------|
| TM-01 | Tab bar layout | Open 3+ tabs for a task | Tabs in flex-wrap container, max-width 200px with text ellipsis. Action buttons (+ Shell, + Claude, + Claude with context) pinned top-right in separate flex-shrink:0 container. | | |
| TM-02 | Tab drag-and-drop reorder | Drag a tab to a new position | Accent border drop indicator shows during drag. Tab moves to new position. Active tab follows the moved tab. | | |
| TM-03 | Tab order persistence | Reorder tabs, reload plugin (hot-reload) | Tab order preserved after reload. | | |
| TM-04 | Tab context menu: Rename | Right-click tab > Rename | Enters inline edit mode on the tab label. | | |
| TM-05 | Tab context menu: Restart | Right-click a Claude tab > Restart | Available for all Claude sessions (identified by `isClaudeSession` flag, not label). Restarts by resuming the existing Claude session ID when available, while keeping a live replacement tab visible during the swap. | | |
| TM-06 | Tab context menu: Move to Task | Right-click tab > Move to Task | Shows submenu grouped by state headers (Priority, Active, To Do). Excludes archived tasks. Moving a tab re-keys it to the target task. | | |
| TM-07 | Remember active tab per task | Open 3 tabs on Task A (select tab 2). Switch to Task B. Switch back to Task A. | Tab 2 is active (remembered per task path). | | |
| TM-08 | Active tab memory on reload | Select tab 2, hot-reload plugin | Tab 2 restored as active (plugin reload recovery takes precedence). | | |
| TM-09 | Tab inline rename | Trigger rename (via context menu or double-click if supported) | Inline edit field appears. Type new name, press Enter. Label updates. "Armed blur" pattern handles Obsidian/xterm focus competition (blur doesn't cancel immediately). | | |

## 3. Session Persistence

### Preconditions
- Plugin loaded, at least one Claude session running

| ID | Description | Steps | Expected Result | Status | Notes |
|----|-------------|-------|-----------------|--------|-------|
| SP-01 | Window-global stash on hot-reload | Run "Reload Plugin (preserve terminals)" from command palette | All terminal sessions survive. PTY processes still running. xterm instances still rendering. DOM state preserved via window.__workTerminalStore. | | |
| SP-02 | Window store deleted after read | Hot-reload, then check `window.__workTerminalStore` in console | Store should be deleted immediately after read (prevents accidental reuse). | | |
| SP-03 | Session types tracked | Spawn Shell, Claude, and Claude-with-context tabs | Each session has correct type: shell / claude / claude-with-context. | | |
| SP-09 | Hot-reload command registered | Open command palette, search for "reload" | "Reload Plugin (preserve terminals)" command appears and executes hot-reload. | | |
| SP-10 | Stash pauses state tracking | Hot-reload while Claude is active | State detection timer paused during stash. No errors from checking stale session objects. | | |
| SP-11 | 2s active suppression after reload | Hot-reload. Check Claude state indicators immediately after. | Active detections suppressed for 2s (downgraded to idle) - stale buffer content triggers false active. Clears early if screen genuinely updates. | | |
| SP-12 | Pre-seeded idleSince on reload | Hot-reload Claude sessions that were idle. | Recovered sessions get `idleSince = Date.now() - 300_000` so idle animations start fully stale (depleted arc, desaturated badge). | | |

## 4. Task List (Left Panel)

### Preconditions
- Plugin loaded with multiple tasks in different states (priority, active, todo, done)

| ID | Description | Steps | Expected Result | Status | Notes |
|----|-------------|-------|-----------------|--------|-------|
| TL-01 | Collapsible sections | Open the view | Sections render: Priority, Active, To Do, Done. Done section collapsed by default. Others expanded. | | |
| TL-02 | Section collapse/expand | Click section headers | Sections toggle between collapsed and expanded. | | |
| TL-03 | Section header colours | Inspect section headers | Priority: red border, Active: accent colour, To Do: muted, Done: green. | | |
| TL-04 | Within-section drag reorder | Drag a task card within its section | Blue drop indicator appears. Card moves to drop position. | | |
| TL-05 | Custom order persistence | Reorder cards, reload plugin | Custom order preserved (UUID-keyed, not file path). | | |
| TL-06 | Custom order sorting | Have both ordered and unordered tasks | Ordered tasks sort first. Unordered tasks fall through to default sort (score desc, then updated timestamp desc). | | |
| TL-07 | Cross-section drag | Drag a task from "To Do" to "Active" | Task state changes to active. Task appears at drop position in target section (respects position). | | |
| TL-08 | Cross-section drag delay | Perform cross-section drag, observe timing | 200ms delay after move for file physical move + metadata cache update before re-render. | | |
| TL-09 | Auto-expand on drag-over | Collapse a section. Drag a card over the collapsed section header. | Section auto-expands to allow drop. | | |
| TL-10 | Drop indicator excludes dragged card | Drag a card, observe drop indicators | Blue indicator appears on valid drop targets. The dragging card itself does not show an indicator (`:not(.dragging)`). | | |
| TL-11 | Move-to-top button | Hover over a task card | Accent-coloured move-to-top button appears in flex `.task-card-actions` container. Clicking it moves the task to top of its section AND selects it. | | |
| TL-12 | Session count badges | Open terminal sessions for a task | Badge on the task card shows number of open sessions. Updates when sessions are opened/closed. | | |
| TL-13 | Claude state: active | Have Claude actively generating output | Green arc spinner on the session badge. | | |
| TL-14 | Claude state: waiting | Have Claude showing a question/prompt | Amber pulsing glow on the badge. | | |
| TL-15 | Claude state: idle | Claude session idle (prompt visible, no activity) | Badge desaturates with depleting arc over 300s. | | |
| TL-16 | Idle animation continuity | Re-render the task list while a session is idle | `idleSince` timestamp tracked. Negative `animation-delay` via `--idle-offset` CSS variable fast-forwards animation to correct position. Animation doesn't restart from fresh on re-render. | | |
| TL-17 | Idle default on plugin load | Load plugin with pre-existing idle Claude sessions | Idle cards default to 300s (fully stale) - don't animate from fresh. | | |
| TL-18 | State class update without full re-render | Watch task card DOM while Claude state changes | Classes updated in-place. Running CSS animations (idle depletion arc) not interrupted. Badges updated in-place (not full card re-render). | | |
| TL-19 | Suppress waiting on visible tabs | Have a Claude tab visible that's showing a prompt | Card reports idle (not waiting) - user can already see the prompt. | | |
| TL-20 | Filter input | Type in the filter box | Case-insensitive task search. 100ms debounce. | | |
| TL-22 | Selection restoration across renders | Trigger a board refresh while a task is selected | Same task remains selected after re-render. | | |
| TL-23 | Context menu: Move to column | Right-click card > Move to <column> | Task moves to selected column. | | |
| TL-24 | Context menu: Move to Top | Right-click card > Move to Top | Task moves to top of its section. | | |
| TL-25 | Context menu: Copy Name | Right-click card > Copy Name | Task name copied to clipboard. | | |
| TL-26 | Context menu: Copy Path | Right-click card > Copy Path | Task file path copied to clipboard. | | |
| TL-27 | Context menu: Copy Context Prompt | Right-click card > Copy Context Prompt | Task agent context prompt copied to clipboard. | | |
| TL-28 | Context menu: Done & Close Sessions | Right-click card > Done & Close Sessions | DangerConfirm modal appears. On confirm: task moves to Done AND all terminal sessions for that task are closed. | | |
| TL-29 | Abandoned tasks filtered | Have a task with state "abandoned" | Task does not appear in the kanban view. | | |
| TL-30 | Ingesting placeholder | Create a new task | "Ingesting" placeholder shown on card during AI enrichment. Auto-dismissed after 5s on failure. Resolved with checkmark on success. | | |
| TL-31 | Ingesting badge deduplication | Trigger multiple enrichment events for same task | Only one ingesting badge per card (checks DOM before inserting). | | |
| TL-32 | Split task insert position | Create a "split" task from an existing one | New task inserted immediately after original in custom order. | | |
| TL-33 | Dual state notification on tab move | Move a tab from Task A to Task B via context menu | Both Task A and Task B cards update their badges. | | |

## 5. Layout & Detail

### Preconditions
- Plugin loaded, multiple tasks visible

| ID | Description | Steps | Expected Result | Status | Notes |
|----|-------------|-------|-----------------|--------|-------|
| LD-01 | 2-panel split layout | Open the Work Terminal view | Two panels: task list (left) and terminals (right). One draggable divider between them. | | |
| LD-02 | Divider resize | Drag the divider left and right | Both panels resize. Min-width constraints respected. | | |
| LD-03 | Detail panel as workspace leaf | Select a task that has a detail view | Obsidian MarkdownView opens via createLeafBySplit off the ItemView's leaf. Shows live preview, frontmatter properties, backlinks. | | |
| LD-04 | Detail panel leaf reuse | Select different tasks in sequence | Same editor leaf reused (not creating new leaves each time). | | |
| LD-05 | Detail panel leaf survival check | Manually close the detail leaf, then select another task | New leaf created (survival check via `workspace.getLeavesOfType("markdown")` detects closed leaf). | | |
| LD-06 | Detail panel min width | Open detail panel, check its width | Min width from CSS variable `--file-line-width` + 80px (scrollbar/gutters). Applied after 100ms defer. | | |
| LD-07 | Detail panel flex sizing | Inspect the DOM hierarchy of the split | Flex sizing targets grandparent's children (not parent - `createLeafBySplit` wraps each side). | | |
| LD-08 | Detail panel on deselect | Deselect a task (click empty area or different action) | Last viewed file remains showing in the detail leaf (not detached). | | |
| LD-09 | Detail panel cleanup on close | Close the Work Terminal view | adapter.detachDetailView() called. No orphan workspace leaves. | | |
| LD-10 | Detail panel cleanup on hot-reload | Hot-reload the plugin | Detail leaf detached. No orphan leaves after reload. | | |
| LD-11 | Rename detection: delete+create | Rename a task file via `mv` in a terminal | Within 2s: UUID captured from MetadataCache before cache clear. UUID-first matching (confident, cross-folder). Updates task order, terminal session keys, and selection. | | |
| LD-12 | Rename detection: two-pass matching | Rename a task without a UUID | Falls back to folder heuristic matching (second pass). | | |

## 6. Task Operations

### Preconditions
- Plugin loaded, PromptBox visible at top of task list

| ID | Description | Steps | Expected Result | Status | Notes |
|----|-------------|-------|-----------------|--------|-------|
| TO-01 | Task creation via PromptBox | Enter a title in the PromptBox, select a column, press Enter | Task file created with: UUID in frontmatter, YAML frontmatter, slugified filename. File appears in correct state folder. | | |
| TO-02 | PromptBox column selector | Click the column selector in PromptBox | Shows adapter-defined creation columns. Default column pre-selected. | | |
| TO-03 | PromptBox input clearing | Submit a task title | Input cleared before onSubmit callback fires (user can type next prompt while Claude processes). | | |
| TO-04 | PromptBox Shift+Enter | Press Shift+Enter in the PromptBox | Newline inserted (not submit). Enter alone submits. | | |
| TO-05 | Background enrichment | Create a new task | Headless Claude spawns for enrichment. Ingesting placeholder shown. On success: task file updated with enriched content. | | |
| TO-06 | Background enrichment failure | Create a task when Claude is unavailable | Ingesting placeholder auto-dismissed after 5s. Original task file remains intact. | | |
| TO-07 | Background enrichment PATH | Check enrichment spawn | PATH augmented for Electron (~/.local/bin, nvm, /usr/local/bin, /opt/homebrew/bin). Plugin directory validated (tc-services, tc-tools, tc-tasks, tc-core exist). | | |
| TO-08 | Background enrichment timeout | Long-running enrichment | 120s timeout with SIGTERM kill. Settled guard prevents double callback. Stderr truncated to 500 chars. | | |
| TO-09 | Claude context prompt content | Open "+ Claude (with context)" for a task | Prompt includes: task title, state, file path. Conditionally includes deadline and blocker info when present. | | |
| TO-10 | Claude context prompt: no deadline | Open Claude(ctx) for a task without a deadline | Prompt does not include deadline section. | | |
| TO-11 | Claude session rename detection | Start a Claude session that renames itself | Output stream monitored for "Session renamed to:" pattern. ANSI stripped (3-stage). StringDecoder handles UTF-8 chunks. Tab label updates. | | |
| TO-12 | Session rename: adapter hook | Claude renames session | `adapter.transformSessionLabel(oldLabel, detectedLabel)` called if provided. Adapter can transform the label. | | |

## 7. Undocumented Implementation Details

### Preconditions
- Deep inspection via console/CDP. Some tests require code reading + runtime verification.

| ID | Description | Steps | Expected Result | Status | Notes |
|----|-------------|-------|-----------------|--------|-------|
| UD-01 | Three-stage ANSI stripping | Examine stripAnsi output with CSI cursor-forward sequences | (1) CSI cursor-forward replaced with spaces (preserves alignment), (2) all remaining ANSI/control sequences stripped. Two passes needed. | | |
| UD-02 | StringDecoder for UTF-8 | Verify rename detection handles multi-byte chars split across chunks | StringDecoder used to handle split UTF-8 characters. Pattern checked on both complete lines AND incomplete buffer. | | |
| UD-03 | Multi-line question detection | Claude asks a numbered question | State detector finds numbered options preceded by `?` within 5 lines. Reports "waiting". | | |
| UD-04 | State aggregation priority | Task with multiple tabs in different states | Aggregation: waiting > active > idle > inactive. Short-circuits on first "waiting". | | |
| UD-05 | Last 6 lines only for active detection | Claude outputs `*` + ellipsis in response body (not at bottom) | Only last 6 screen lines checked for active indicators. Mid-response content doesn't false-positive. | | |
| UD-06 | MetadataCache "changed" fallback | Create a new task file programmatically | MetadataCache "changed" event used as fallback for vault "create" (frontmatter not parsed when create fires). | | |
| UD-07 | Delete event session check | Delete a task file without terminal sessions | Delete event only buffers rename if task has terminal sessions (avoids polluting pending renames map). | | |
| UD-08 | UUID captured on delete | Delete a task file (part of rename) | UUID captured from metadata cache immediately on delete (cache is about to be cleared). | | |
| UD-09 | Metadata cache wait timeout | Inspect metadata-dependent operations | 3-5s timeout fallback. UI does not hang if cache gets stuck. | | |
| UD-10 | Custom order: ordered first | Mix of tasks with and without custom order | Ordered tasks sort first. Unordered fall through to score desc, then updated desc. | | |
| UD-11 | Task parser: goal normalisation | Task with `goal: "single-string"` | Normalised to array. Missing goal field becomes empty array. | | |
| UD-12 | Task parser: fallback basename | Task with missing `title` field | Uses filename basename as fallback. | | |
| UD-13 | Task parser: source type default | Task with missing `source.type` | Defaults to `"other"`. | | |
| UD-14 | Task parser: backfill IDs | Task without UUID in frontmatter | ID backfilled on load (only processes tasks without existing UUID). | | |
| UD-15 | Task mover: regex preserves spacing | Move a task with custom frontmatter spacing | State/tag updates via regex preserve original YAML spacing. | | |
| UD-16 | Task mover: ISO without milliseconds | Move a task, check `updated` timestamp | Format: `2025-03-26T14:15:30Z` (not `.123Z`). | | |
| UD-17 | Task mover: activity log position | Move a task with existing sections below activity log | New activity log entry inserts before next `##` section, not at end of file. | | |
| UD-18 | Task mover: write-then-move | Move a task to a different column, observe file operations | Content modified first (state/tags/timestamp/activity), THEN file renamed to new folder. | | |
| UD-19 | pty-wrapper.py: stdin buffering | Send input to terminal | Only holds back potential resize sequence starts (`ESC ]`). Regular CSI escapes (`ESC [`) pass through immediately (prevents deadlock). | | |
| UD-20 | pty-wrapper.py: login shell wrapping | Check how non-shell commands are spawned | Wrapped with `-l -i` for .zprofile/.zshrc sourcing (ensures PATH). | | |
| UD-21 | pty-wrapper.py: 50ms select timeout | Check pty-wrapper select loop | Non-blocking 50ms timeout (not blocking select). Enables responsive signal handling. | | |
| UD-22 | pty-wrapper.py: post-exit flush | Kill a child process, check for remaining output | Flush loop reads remaining master_fd data after child exits. No data loss. | | |
| UD-23 | pty-wrapper.py: SIGWINCH to process group | Resize terminal with nested program (e.g. vim, less) | SIGWINCH sent to process group (not just child pid). Nested programs resize correctly. | | |
| UD-24 | CSS: idle badge animation | Inspect idle badge CSS | Custom property `--idle-arc` with `syntax: "<angle>"` for animatable conic-gradient. 300s depletion + desaturation. Both use `animation-delay: var(--idle-offset, 0s)`. | | |
| UD-25 | CSS: ingesting shine | Create a task, observe card during enrichment | 2s horizontal gradient sweep animation. | | |
| UD-26 | CSS: xterm overflow fixes | Inspect xterm container CSS | `!important` on width/overflow-y. Inactive tabs: `visibility: hidden` (not `display: none`) + `z-index: -1`. | | |
| UD-27 | CSS: section header borders | Inspect section headers | Hardcoded colours: priority=red, active=accent, todo=muted, done=green. | | |
| UD-28 | 100ms filter debounce | Type rapidly in filter | Input debounced at 100ms. | | |
| UD-29 | 150ms render debounce | Trigger multiple vault events rapidly | Renders batched at 150ms. Claude states reapplied after render. | | |
| UD-30 | Conditional cleanup on close | Close view vs hot-reload | `onClose()` checks `_isReloading` flag. Hot-reload: skips disposal. Normal close: full cleanup. | | |

---

## Summary

| Section | Total | Pass | Fail | Skip | N/A |
|---------|-------|------|------|------|-----|
| 1. Terminal Core | 18 | | | | |
| 2. Tab Management | 9 | | | | |
| 3. Session Persistence | 8 | | | | |
| 4. Task List | 32 | | | | |
| 5. Layout & Detail | 12 | | | | |
| 6. Task Operations | 12 | | | | |
| 7. Undocumented Details | 30 | | | | |
| **Total** | **121** | | | | |

## Issues Found

<!-- Track bugs discovered during testing -->

| ID | Test Case | Description | Severity | Fixed? | Fix Details |
|----|-----------|-------------|----------|--------|-------------|
| | | | | | |
