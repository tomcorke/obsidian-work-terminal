## 1. Types and Configuration

- [x] 1.1 Create `src/adapters/task-agent/types.ts` with TaskFile, TaskState, KanbanColumn, STATE_FOLDER_MAP, COLUMN_LABELS, KANBAN_COLUMNS, SOURCE_LABELS constants
- [x] 1.2 Create `src/adapters/task-agent/TaskAgentConfig.ts` with PluginConfig (columns, creationColumns with todo default, settingsSchema with taskBasePath text setting defaulting to "2 - Areas/Tasks", itemName: "task")

## 2. Task Parser

- [x] 2.1 Create `src/adapters/task-agent/TaskParser.ts` implementing WorkItemParser - ignore framework basePath param, read taskBasePath from settings. Parse frontmatter via MetadataCache, loadAll from 4 subdirectories, groupByColumn with abandoned filtering and score/updated sort, isItemFile, backfillIds with error-per-file handling
- [x] 2.2 Create `src/adapters/task-agent/TaskParser.test.ts` with tests for: field extraction with defaults, abandoned filtering, goal normalisation (array/string/null/missing), fallback basename for missing title, source type default "other", score sorting and updated timestamp tiebreaker, isItemFile path matching, invalid/missing frontmatter returns null

## 3. Task Mover

- [x] 3.1 Create `src/adapters/task-agent/TaskMover.ts` implementing WorkItemMover - ignore framework basePath param, read taskBasePath from settings. Regex-based state/tag/timestamp updates, activity log insertion before next section (create section if missing), write-then-move pattern, folder creation, column-to-folder mapping (done -> archive), no-op for same column
- [x] 3.2 Create `src/adapters/task-agent/TaskMover.test.ts` with tests for: state field update, tag update, timestamp format (no ms), activity log entry format and insertion position, activity log section creation when missing, no-op for same column, write-then-move call order, done maps to archive folder

## 4. Task File Template

- [x] 4.1 Create `src/adapters/task-agent/TaskFileTemplate.ts` - generate task file content with UUID, tags, state, quoted title, empty defaults, timestamps without ms, Activity Log section with creation entry. Generate filename as TASK-YYYYMMDD-HHMM-<slug>.md
- [x] 4.2 Create `src/adapters/task-agent/TaskFileTemplate.test.ts` with tests for: valid YAML output, UUID present, correct tags for each column (todo/active), filename format, slugification, title with special characters properly quoted

## 5. Card Renderer and Prompt Builder

- [x] 5.1 Create `src/adapters/task-agent/TaskCard.ts` implementing CardRenderer - read from WorkItem metadata, title row with actions container, source badge (JIRA/SLK/CONF/CLI/---), score badge with severity classes (high>=60/medium>=30/low), goal tags (max 2), blocker indicator, ingesting state with CSS class and badge, draggable with path data transfer, click-to-select via ctx. Context menu: Resume Last Session, Move to Top, Split Task, Move to columns, Done & Close Sessions (best-effort compound), Copy Name/Path/Prompt, Delete (danger). Graceful fallback for missing metadata fields.
- [x] 5.2 Create `src/adapters/task-agent/TaskPromptBuilder.ts` implementing WorkItemPromptBuilder - include title, state, path, conditional deadline when non-empty, conditional blocker context when has-blocker true. Handle special characters in metadata.
- [x] 5.3 Create `src/adapters/task-agent/TaskPromptBuilder.test.ts` with tests for: basic prompt includes title/state/path, deadline included when present, deadline excluded when empty, blocker included when has-blocker true, blocker excluded when false, special characters in title handled

## 6. Detail View and Background Enrichment

- [x] 6.1 Create `src/adapters/task-agent/TaskDetailView.ts` - createDetailView using createLeafBySplit(ownerLeaf=MainView leaf, "vertical", false), leaf survival check via getLeavesOfType("markdown"), min editor width from --file-line-width + 80px (fallback 700px if unset/unparseable) with 100ms defer, flex sizing on grandparent's children (editor: no-grow fixed basis, terminal: grow), leave last file on deselect, detachDetailView cleanup
- [x] 6.2 Create `src/adapters/task-agent/BackgroundEnrich.ts` - onItemCreated hook: extract title and _columnId from params, generate file via TaskFileTemplate, create in vault, then spawn enrichment via framework's spawnHeadlessClaude. Log and swallow enrichment errors (file creation already succeeded).

## 7. Assembly and Integration

- [x] 7.1 Create `src/adapters/task-agent/index.ts` assembling AdapterBundle extending BaseAdapter - wire all components, pass app and settings to parser/mover/detail/enrich. Implement optional methods (createDetailView, detachDetailView, onItemCreated, transformSessionLabel)
- [x] 7.2 Update `src/main.ts` to import TaskAgentAdapter instead of StubAdapter
- [x] 7.3 Build, run tests, verify plugin loads via CDP with task cards rendering from vault
