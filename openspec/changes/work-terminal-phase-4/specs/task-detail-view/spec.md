## ADDED Requirements

### Requirement: Create detail view as workspace leaf
The adapter's `createDetailView(item, app, ownerLeaf)` SHALL create an Obsidian MarkdownView by calling `app.workspace.createLeafBySplit(ownerLeaf, "vertical", false)` and opening the task's file in it. The `ownerLeaf` is the MainView's own workspace leaf (not an existing editor leaf).

#### Scenario: First task selected
- **WHEN** createDetailView is called for the first time with a task
- **THEN** a new workspace leaf is created by splitting the MainView's leaf, and the task file is opened in it

### Requirement: Reuse existing editor leaf
The adapter SHALL track the created leaf and reuse it for subsequent task selections, checking survival via `workspace.getLeavesOfType("markdown")` before reuse.

#### Scenario: Second task selected
- **WHEN** createDetailView is called again with a different task
- **THEN** the existing leaf is reused (not a new split) and the new task file is opened

#### Scenario: Leaf was closed externally
- **WHEN** the user closes the editor leaf manually, then selects a new task
- **THEN** a new leaf is created by splitting the owner leaf

### Requirement: Apply minimum editor width
The adapter SHALL set the editor leaf's width based on the CSS variable `--file-line-width` plus 80px (for scrollbar/gutters), with a fallback of 700px if the CSS variable is unset or unparseable. Width is applied via flex properties on the grandparent's children (not parent - `createLeafBySplit` wraps each side in its own split container). Width application SHALL be deferred 100ms to let Obsidian's layout pass complete.

The editor split gets `flexGrow: 0`, `flexShrink: 0`, `flexBasis: <width>px`. The terminal split (sibling) gets `flexGrow: 1`, `flexShrink: 1`, `flexBasis: 0%`.

#### Scenario: Editor width set with CSS variable
- **WHEN** `--file-line-width` is set to `700px`
- **THEN** the editor split gets `flexBasis: 780px` (700 + 80)

#### Scenario: Editor width fallback
- **WHEN** `--file-line-width` is not set or cannot be parsed
- **THEN** the editor split gets `flexBasis: 780px` (700 fallback + 80)

### Requirement: Leave last file on deselect
The adapter SHALL NOT detach the editor leaf when no task is selected. The last viewed file remains visible.

#### Scenario: Task deselected
- **WHEN** no task is selected after previously viewing one
- **THEN** the editor leaf remains showing the last file

### Requirement: Detach leaf on cleanup
The `detachDetailView()` method SHALL detach the managed leaf to prevent orphan workspace leaves during plugin unload or hot-reload.

#### Scenario: Plugin unloaded
- **WHEN** detachDetailView is called
- **THEN** the editor leaf is detached and the reference is cleared
