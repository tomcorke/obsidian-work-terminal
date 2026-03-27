## ADDED Requirements

### Requirement: Tab groups keyed by work item ID
`TabManager` MUST maintain tab groups keyed by work item ID (not file path), where each group contains zero or more terminal tabs.

#### Scenario: Tabs associated with work item
- **WHEN** a terminal is created for work item "abc-123"
- **THEN** the terminal tab is stored in the tab group for "abc-123"

#### Scenario: Multiple tabs per work item
- **WHEN** three terminals are created for the same work item
- **THEN** all three appear in the same tab group and share the same tab bar

#### Scenario: Tab count per work item
- **WHEN** the framework queries the session count for a work item
- **THEN** the count reflects the number of open tabs in that work item's group

### Requirement: Session type tracking
`TabManager` MUST track the session type of each tab as `shell`, `claude`, or `claude-with-context`.

#### Scenario: Shell session type
- **WHEN** a terminal is created via the "+ Shell" action
- **THEN** its session type is tracked as `shell`

#### Scenario: Claude session type
- **WHEN** a terminal is created via the "+ Claude" action
- **THEN** its session type is tracked as `claude`

#### Scenario: Claude-with-context session type
- **WHEN** a terminal is created via the "+ Claude (with context)" action
- **THEN** its session type is tracked as `claude-with-context`

#### Scenario: Claude session identification via session ID
- **WHEN** a terminal has a non-null `claudeSessionId`
- **THEN** it is identified as a Claude session for state tracking purposes (not by label text)

### Requirement: Active tab memory per work item
`TabManager` MUST remember which tab was last active for each work item and restore it when switching back.

#### Scenario: Tab index saved on switch away
- **WHEN** the user switches from work item A (viewing tab 2) to work item B
- **THEN** tab index 2 is stored for work item A

#### Scenario: Tab index restored on switch back
- **WHEN** the user switches back to work item A which had tab 2 active
- **THEN** tab 2 is shown (if it still exists), not tab 0

#### Scenario: Recovered tab index from reload
- **WHEN** a reload recovery restores a previously active tab index
- **THEN** the recovered index takes precedence over the remembered index for the first selection

### Requirement: Tab drag-drop reordering
Tabs within a group MUST support drag-and-drop reordering with visual feedback.

#### Scenario: Drag reorder updates tab order
- **WHEN** a tab is dragged from position 2 to position 0
- **THEN** the tab array is reordered, the active tab follows the moved tab, and the new order persists

#### Scenario: Drop indicator during drag
- **WHEN** a tab is being dragged over another tab
- **THEN** an accent border drop indicator is shown at the insertion point

### Requirement: Tab create and close
`TabManager` MUST support creating new tabs and closing existing tabs with proper cleanup.

#### Scenario: New tab becomes active
- **WHEN** a new terminal tab is created
- **THEN** all other tabs in the group are hidden, the new tab is shown, and the tab bar re-renders

#### Scenario: Close tab disposes resources
- **WHEN** a tab is closed
- **THEN** the tab's `dispose()` is called, it is removed from the group, and the tab bar re-renders

#### Scenario: 3-second keep-alive on early exit
- **WHEN** a terminal process exits within 3 seconds of spawn
- **THEN** the tab remains open for 3 seconds so error messages are visible before auto-closing

#### Scenario: Close last tab shows placeholder
- **WHEN** the last tab in a group is closed
- **THEN** the terminal wrapper shows the placeholder state
