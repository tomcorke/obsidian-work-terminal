## ADDED Requirements

### Requirement: onItemCreated creates file and triggers enrichment
The adapter's `onItemCreated(title, settings)` hook receives the user's title string and a settings object containing `_columnId` (target column) and `_placeholderPath` (framework placeholder lifecycle). The adapter SHALL:
1. Generate file content via TaskFileTemplate
2. Generate filename as `TASK-YYYYMMDD-HHMM-<slugified-title>.md`
3. Determine the target folder from column-to-folder mapping and basePath
4. Create the file in the vault via `app.vault.create(path, content)`
5. Spawn headless Claude for background enrichment

The adapter does not return the file path. The framework detects the new file via vault events and updates the list automatically.

#### Scenario: Task created in todo column
- **WHEN** onItemCreated is called with title "Fix login bug" and settings `{ _columnId: "todo" }`
- **THEN** a file is created at `<basePath>/todo/TASK-YYYYMMDD-HHMM-fix-login-bug.md` with correct frontmatter, and enrichment is spawned

#### Scenario: Task created in active column
- **WHEN** onItemCreated is called with settings `{ _columnId: "active" }`
- **THEN** the file is created in the `active/` folder with `state: active` and tag `task/active`

### Requirement: Generate task file from template
The TaskFileTemplate SHALL generate markdown file content with valid YAML frontmatter including: a `crypto.randomUUID()` id, tags array with `task` and `task/<state>`, the provided state, title (quoted to handle special characters), empty source/priority/goal defaults, `agent-actionable: false`, current timestamps (ISO without milliseconds), and an `## Activity Log` section with a creation entry.

#### Scenario: Valid YAML generated
- **WHEN** generateContent is called with title "Fix login bug" and state "todo"
- **THEN** the output is valid YAML frontmatter with `state: todo`, `tags: [task, task/todo]`, a UUID id, `title: "Fix login bug"`, and standard defaults

#### Scenario: Title with special characters
- **WHEN** generateContent is called with a title containing colons or quotes
- **THEN** the title is properly quoted in the YAML frontmatter

### Requirement: Task filename format
The template SHALL generate filenames in the format `TASK-YYYYMMDD-HHMM-<slugified-title>.md` using the slugify utility.

#### Scenario: Filename from title
- **WHEN** a task is created with title "Fix login bug" on 2026-03-27 at 14:15
- **THEN** the filename is `TASK-20260327-1415-fix-login-bug.md`

### Requirement: Creation columns configuration
The adapter's PluginConfig SHALL declare creationColumns as `[{ id: "todo", label: "To Do", default: true }, { id: "active", label: "Active" }]`.

#### Scenario: Default creation column
- **WHEN** the PromptBox renders column options
- **THEN** "To Do" is selected by default

### Requirement: Background enrichment via headless Claude
After file creation, `onItemCreated` SHALL spawn a headless Claude process using the framework's `spawnHeadlessClaude(prompt, cwd)` utility. The prompt SHALL invoke `/tc-tasks:task-agent` with instructions to review the task file, run duplicate check, goal alignment, and related task detection. If enrichment fails (timeout, missing plugins, process error), the error SHALL be logged but the promise SHALL still resolve (file creation succeeded).

#### Scenario: Enrichment triggered
- **WHEN** a new task file is created successfully
- **THEN** a headless Claude process is spawned with a task-agent enrichment prompt referencing the file path

#### Scenario: Enrichment fails gracefully
- **WHEN** headless Claude exits with an error
- **THEN** the error is logged, but onItemCreated does not throw (the file was already created)

### Requirement: Adapter settings schema
The adapter SHALL declare a `taskBasePath` setting (type: text, default: `"2 - Areas/Tasks"`) in its settingsSchema, used by the parser and mover as the root directory for task files.

#### Scenario: Custom base path
- **WHEN** the user changes taskBasePath to `"Tasks"`
- **THEN** the parser scans `Tasks/priority/`, `Tasks/todo/`, etc.
