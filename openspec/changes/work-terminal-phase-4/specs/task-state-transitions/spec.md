## ADDED Requirements

### Requirement: Move task between columns
The TaskMover SHALL implement WorkItemMover and transition a task to a new column by updating the file content and moving the physical file. It SHALL use a write-then-move pattern: modify content first via `vault.modify()`, then rename to the target folder via `vault.rename()`. The `basePath` parameter from `createMover(app, basePath)` is ignored - the adapter reads its own `taskBasePath` setting.

#### Scenario: Move task from todo to active
- **WHEN** move is called with targetColumnId "active" on a task in the todo folder
- **THEN** the file's `state` field is updated to "active", the `task/todo` tag is changed to `task/active`, the `updated` timestamp is set to the current time, an activity log entry is appended, and the file is moved to the `active/` folder

#### Scenario: No-op when already in target column
- **WHEN** move is called with the task's current column
- **THEN** no changes are made to the file

### Requirement: Update frontmatter state field
The mover SHALL update the `state:` line in frontmatter using regex replacement to preserve surrounding whitespace and formatting.

#### Scenario: State field updated
- **WHEN** a task with `state: todo` is moved to active
- **THEN** the line becomes `state: active`

### Requirement: Update task tag
The mover SHALL update the `task/<state>` tag in the tags array using regex replacement, matching `priority`, `todo`, `active`, `done`, or `abandoned`.

#### Scenario: Tag updated
- **WHEN** a task with tag `- task/todo` is moved to active
- **THEN** the tag becomes `- task/active`

### Requirement: Update timestamp without milliseconds
The mover SHALL update the `updated:` field to the current ISO timestamp without milliseconds (e.g. `2026-03-27T14:15:30Z` not `2026-03-27T14:15:30.123Z`).

#### Scenario: Timestamp format
- **WHEN** a task is moved at 2026-03-27T14:15:30.456Z
- **THEN** the `updated` field reads `2026-03-27T14:15:30Z`

### Requirement: Append activity log entry
The mover SHALL append an activity log entry in the format `- **YYYY-MM-DD HH:MM** - Moved to <state> (via kanban board)`. The entry SHALL be inserted before the next `## ` section heading after the Activity Log header (or at EOF if no next section). If no `## Activity Log` section exists, the mover SHALL create it at the end of the file before appending the entry.

#### Scenario: Activity log entry appended
- **WHEN** a task is moved to active on 2026-03-27 at 14:15
- **THEN** the line `- **2026-03-27 14:15** - Moved to active (via kanban board)` is added to the Activity Log section

#### Scenario: Activity log section created if missing
- **WHEN** a task file has no `## Activity Log` section and is moved
- **THEN** a `## Activity Log` section is created at EOF and the entry is appended beneath it

### Requirement: Ensure target folder exists
The mover SHALL create the target folder if it does not exist before moving the file.

#### Scenario: Missing folder created
- **WHEN** move targets the `archive/` folder and it doesn't exist
- **THEN** the folder is created before the file is renamed

### Requirement: Column-to-folder mapping
The mover SHALL map columns to folders: `priority` -> `priority/`, `todo` -> `todo/`, `active` -> `active/`, `done` -> `archive/`.

#### Scenario: Done maps to archive
- **WHEN** a task is moved to the "done" column
- **THEN** the file is moved to the `archive/` subfolder
