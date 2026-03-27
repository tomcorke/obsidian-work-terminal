## ADDED Requirements

### Requirement: Render task card with title and metadata
The TaskCard SHALL implement CardRenderer and produce an HTMLElement with the task title, source badge, priority score badge, goal tags (max 2), and blocker indicator. All task-specific data is read from the WorkItem's `metadata` field.

#### Scenario: Full card rendered
- **WHEN** render is called with a task that has title, source "jira", score 80, goals ["perf", "reliability"], and has-blocker true
- **THEN** the card shows the title, "JIRA" source badge, score "80" with high class, two goal tags, and a "BLOCKED" indicator

#### Scenario: Minimal card rendered
- **WHEN** render is called with a task that has only a title and score 0
- **THEN** the card shows the title and source badge only (no score, no goals, no blocker)

#### Scenario: Missing or corrupt metadata
- **WHEN** render is called with a WorkItem whose metadata lacks expected fields
- **THEN** the card renders with title only (no crash), using fallback defaults for missing fields

### Requirement: Source badge labels
The card SHALL map source types to badge labels: `jira` -> "JIRA", `slack` -> "SLK", `confluence` -> "CONF", `prompt` -> "CLI", `other` -> "---".

#### Scenario: Slack source badge
- **WHEN** a task has source.type "slack"
- **THEN** the source badge shows "SLK"

### Requirement: Score badge with severity classes
The card SHALL show a score badge when score > 0, with CSS classes: `score-high` for >= 60, `score-medium` for >= 30, `score-low` for < 30.

#### Scenario: High score styling
- **WHEN** a task has score 75
- **THEN** the score badge has class `score-high`

### Requirement: Card is draggable
The card element SHALL have `draggable: true` and set `text/plain` data transfer with the task path on dragstart.

#### Scenario: Drag initiated
- **WHEN** the user starts dragging a task card
- **THEN** the card gets a "dragging" class and the data transfer contains the task path

### Requirement: Click selects task
The card SHALL call `ctx.onSelect()` when clicked.

#### Scenario: Card clicked
- **WHEN** the user clicks a task card
- **THEN** the framework's onSelect callback is invoked

### Requirement: Context menu with adapter-specific actions
The card's `getContextMenuItems()` SHALL return menu items for: Resume Last Session (if resumable), Move to Top, Split Task, Move to each other column, Done & Close Sessions (after Move to Done), Copy Name, Copy Path, Copy Context Prompt, Delete Task (danger).

#### Scenario: Context menu for active task
- **WHEN** getContextMenuItems is called for a task in the "active" column
- **THEN** items include Move to Priority, Move to To Do, Move to Done, Done & Close Sessions, plus copy and delete actions

### Requirement: Done & Close Sessions compound action
The "Done & Close Sessions" menu item SHALL call `ctx.onMoveToColumn("done")` followed by `ctx.onCloseSessions()`, composing framework primitives. This is best-effort: if `onCloseSessions()` throws after the move succeeds, the task remains in done with sessions still open.

#### Scenario: Done and close triggered
- **WHEN** the user selects "Done & Close Sessions" from the context menu
- **THEN** the task is moved to done AND all terminal sessions are closed

#### Scenario: Close sessions fails after move
- **WHEN** onCloseSessions throws after onMoveToColumn("done") succeeds
- **THEN** the task remains in done, the error is logged, and no crash occurs

### Requirement: Ingesting state on card
The card SHALL check for an `ingesting` flag in the WorkItem metadata. When true, the card gets an "ingesting" CSS class and shows an "ingesting..." badge in the meta row. The ingesting flag is set by the adapter during background enrichment and cleared when enrichment completes or the task file is updated by Claude.

#### Scenario: Ingesting card
- **WHEN** render is called with metadata containing `ingesting: true`
- **THEN** the card has class "ingesting" and displays an ingesting badge
