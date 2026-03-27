## ADDED Requirements

### Requirement: Parse task files from vault frontmatter
The TaskParser SHALL implement WorkItemParser and parse markdown files from a configurable basePath (default: `"2 - Areas/Tasks"`) read from adapter settings. It SHALL scan the `priority/`, `todo/`, `active/`, and `archive/` subdirectories for `.md` files. The `basePath` parameter from `createParser(app, basePath)` is ignored - the adapter reads its own `taskBasePath` setting.

#### Scenario: Valid task file parsed
- **WHEN** a markdown file exists with valid frontmatter containing `state`, `title`, `id`, `source`, `priority`, `tags`, `goal`, `created`, `updated` fields
- **THEN** the parser returns a WorkItem with `id`, `path`, `title`, `state` from frontmatter, and all task-specific fields in `metadata`

#### Scenario: Missing frontmatter
- **WHEN** a markdown file has no frontmatter or MetadataCache returns no cache
- **THEN** the parser returns null

#### Scenario: Invalid state
- **WHEN** frontmatter `state` is not one of `priority`, `todo`, `active`, `done`, `abandoned`
- **THEN** the parser returns null

#### Scenario: Invalid or corrupt YAML frontmatter
- **WHEN** a markdown file has malformed YAML that MetadataCache cannot parse
- **THEN** the parser returns null (does not throw)

### Requirement: Filter abandoned tasks from column grouping
The parser's `groupByColumn()` SHALL exclude tasks with `state: "abandoned"` from all columns.

#### Scenario: Abandoned task excluded
- **WHEN** groupByColumn is called with a list containing an abandoned task
- **THEN** the abandoned task does not appear in any column group

### Requirement: Normalise goal field
The parser SHALL normalise the `goal` frontmatter field: arrays pass through, non-empty strings become `[string]`, null/undefined/missing becomes `[]`.

#### Scenario: String goal normalised to array
- **WHEN** frontmatter contains `goal: "improve-perf"`
- **THEN** the parsed metadata contains `goal: ["improve-perf"]`

#### Scenario: Missing goal normalised to empty array
- **WHEN** frontmatter has no `goal` field
- **THEN** the parsed metadata contains `goal: []`

#### Scenario: Null goal normalised to empty array
- **WHEN** frontmatter contains `goal: null`
- **THEN** the parsed metadata contains `goal: []`

#### Scenario: Array goal passes through
- **WHEN** frontmatter contains `goal: ["perf", "reliability"]`
- **THEN** the parsed metadata contains `goal: ["perf", "reliability"]`

### Requirement: Fallback defaults for missing fields
The parser SHALL use fallback defaults: `title` defaults to file basename, `source.type` defaults to `"other"`, `priority.score` defaults to 0, `priority.impact` defaults to `"medium"`, boolean fields (`has-blocker`, `agent-actionable`) default to false, string fields default to empty string.

#### Scenario: Missing title uses basename
- **WHEN** frontmatter has no `title` field and the file is named `my-task.md`
- **THEN** the parsed WorkItem has `title: "my-task"`

#### Scenario: Missing source type defaults to other
- **WHEN** frontmatter has no `source` field
- **THEN** the parsed metadata has `source.type: "other"`

### Requirement: Default sort order within columns
The parser's `groupByColumn()` SHALL sort tasks within each column by `priority.score` descending, then by `updated` timestamp descending as tiebreaker.

#### Scenario: Higher score sorts first
- **WHEN** two tasks in the same column have scores 80 and 40
- **THEN** the score-80 task appears before the score-40 task

#### Scenario: Equal scores sorted by updated timestamp
- **WHEN** two tasks have the same score but different updated timestamps
- **THEN** the more recently updated task appears first

### Requirement: Identify task files by path
The `isItemFile(path)` method SHALL return true for any `.md` file under the configured basePath.

#### Scenario: Task file identified
- **WHEN** isItemFile is called with `"2 - Areas/Tasks/active/my-task.md"`
- **THEN** it returns true (assuming basePath is `"2 - Areas/Tasks"`)

#### Scenario: Non-task file rejected
- **WHEN** isItemFile is called with `"3 - Resources/notes.md"`
- **THEN** it returns false

### Requirement: Backfill missing UUIDs
The parser SHALL provide a `backfillIds()` method that adds a `crypto.randomUUID()` id to any task file missing one, inserted after the opening `---`. If a file save fails, the method SHALL log the error and continue processing remaining files.

#### Scenario: Task without ID gets UUID
- **WHEN** backfillIds is called and a task file has no `id` field
- **THEN** a UUID is inserted into the frontmatter and the file is saved

#### Scenario: File save error handled gracefully
- **WHEN** backfillIds encounters a file that cannot be written
- **THEN** the error is logged and remaining files are still processed
