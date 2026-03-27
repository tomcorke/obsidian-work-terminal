## ADDED Requirements

### Requirement: WorkItem interface

The system SHALL define a `WorkItem` interface representing any work item that owns terminal tabs.

The interface MUST include:
- `id: string` - unique identifier (UUID)
- `path: string` - vault-relative file path
- `title: string` - display title
- `state: string` - current state/column identifier
- `metadata: Record<string, unknown>` - adapter-specific extra data

#### Scenario: WorkItem used across layers
- **WHEN** a framework component receives a `WorkItem`
- **THEN** it can access `id`, `path`, `title`, `state`, and `metadata` without knowledge of the adapter's domain model

---

### Requirement: ListColumn and CreationColumn interfaces

The system SHALL define a `ListColumn` interface with:
- `id: string` - column identifier
- `label: string` - display label
- `folderName: string` - corresponding folder name on disk

The system SHALL define a `CreationColumn` interface with:
- `id: string` - column identifier
- `label: string` - display label
- `default?: boolean` - optional flag marking the default creation column

#### Scenario: Framework renders columns from config
- **WHEN** the framework reads `PluginConfig.columns`
- **THEN** it renders one list section per `ListColumn` using `label` for display and `folderName` for file system operations

#### Scenario: PromptBox uses creation columns
- **WHEN** the framework renders the new-item creation UI
- **THEN** it shows a column selector populated from `PluginConfig.creationColumns`, with the `default: true` column pre-selected

---

### Requirement: SettingField interface

The system SHALL define a `SettingField` interface for adapter settings schema declarations, containing at minimum:
- `key: string` - the setting key (namespaced under `adapter.*` at runtime)
- `name: string` - display label
- `description: string` - help text
- `type: string` - input type (e.g., `"text"`, `"toggle"`, `"dropdown"`)
- `default: unknown` - default value

#### Scenario: Adapter declares custom settings
- **WHEN** an adapter provides `settingsSchema` in its `PluginConfig`
- **THEN** the framework's `SettingsTab` renders appropriate input controls for each `SettingField`

---

### Requirement: PluginConfig interface

The system SHALL define a `PluginConfig` interface with:
- `columns: ListColumn[]` - the columns displayed in the list panel
- `creationColumns: CreationColumn[]` - columns available when creating new items
- `settingsSchema: SettingField[]` - adapter-specific settings declarations
- `defaultSettings: Record<string, unknown>` - default values for adapter settings
- `itemName: string` - human-readable item type name (e.g., "task", "ticket") used in framework UI labels (e.g., "New {itemName}")

#### Scenario: Framework uses itemName for UI labels
- **WHEN** the framework renders a "New item" button
- **THEN** it uses `config.itemName` to produce "New task" or "New ticket" as appropriate

---

### Requirement: WorkItemParser interface

The system SHALL define a `WorkItemParser` interface with:
- `basePath: string` - the vault-relative base path for work item files
- `parse(file: TFile): WorkItem | null` - parse a single file into a WorkItem, returning null if the file is not a valid work item
- `loadAll(): Promise<WorkItem[]>` - load all work items from the base path
- `groupByColumn(items: WorkItem[]): Record<string, WorkItem[]>` - group items by their column/state
- `isItemFile(path: string): boolean` - determine if a path belongs to a work item file

#### Scenario: Parser filters invalid files
- **WHEN** `parse` is called with a file that does not match the adapter's work item format
- **THEN** it returns `null`

#### Scenario: Parser groups items by column
- **WHEN** `groupByColumn` is called with a list of WorkItems
- **THEN** it returns a Record keyed by column ID with arrays of WorkItems in each column

---

### Requirement: WorkItemMover interface

The system SHALL define a `WorkItemMover` interface with:
- `move(file: TFile, targetColumnId: string): Promise<void>` - move a work item to a different column/state

The `move` method SHALL handle all state transition side effects (metadata updates, file relocation, activity logging) as defined by the adapter.

#### Scenario: Move updates item state
- **WHEN** `move` is called with a file and a target column ID
- **THEN** the work item's state is updated and the file is relocated to the appropriate folder

---

### Requirement: CardActionContext interface

The system SHALL define a `CardActionContext` interface providing framework-owned callbacks for standard card interactions:
- `onSelect(): void` - select this item in the list
- `onMoveToTop(): void` - move this item to the top of its column's sort order
- `onMoveToColumn(columnId: string): void` - move this item to a different column
- `onInsertAfter(existingId: string, newItem: WorkItem): void` - insert a new item after an existing item in sort order
- `onDelete(): void` - delete this item (with confirmation via DangerConfirm)
- `onCloseSessions(): void` - close all terminal sessions for this item

The framework SHALL construct and provide a `CardActionContext` to the adapter's `CardRenderer` for each item.

#### Scenario: Adapter composes compound actions
- **WHEN** an adapter wants a "Done & Close Sessions" context menu action
- **THEN** it calls `ctx.onMoveToColumn("done")` followed by `ctx.onCloseSessions()` using the framework-provided context

---

### Requirement: CardRenderer interface

The system SHALL define a `CardRenderer` interface with:
- `render(item: WorkItem, ctx: CardActionContext): HTMLElement` - render a card element for the given item
- `getContextMenuItems(item: WorkItem, ctx: CardActionContext): MenuItem[]` - return context menu items for the given item

The adapter SHALL use `CardActionContext` callbacks for framework actions and may add adapter-specific menu items alongside them.

#### Scenario: Card rendered with framework actions
- **WHEN** `render` is called
- **THEN** the returned HTMLElement includes interactive elements wired to `CardActionContext` callbacks (e.g., a move-to-top button calling `ctx.onMoveToTop()`)

---

### Requirement: WorkItemPromptBuilder interface

The system SHALL define a `WorkItemPromptBuilder` interface with:
- `buildPrompt(item: WorkItem, fullPath: string): string` - build a context prompt string for the given item

The prompt string SHALL be used by the framework when launching Claude sessions with context for a specific work item.

#### Scenario: Prompt includes item context
- **WHEN** `buildPrompt` is called
- **THEN** the returned string includes the item's title, state, and file path at minimum

---

### Requirement: AdapterBundle interface

The system SHALL define an `AdapterBundle` interface as the primary extension point:
- `config: PluginConfig` - the adapter's configuration
- `createParser(app: App, basePath: string): WorkItemParser` - factory for the parser
- `createMover(app: App, basePath: string): WorkItemMover` - factory for the mover
- `createCardRenderer(): CardRenderer` - factory for the card renderer
- `createPromptBuilder(): WorkItemPromptBuilder` - factory for the prompt builder
- `createDetailView?(item: WorkItem, containerEl: HTMLElement): void` - optional: render a detail view for an item (null means framework uses 2-column layout)
- `onItemCreated?(path: string, settings: Record<string, unknown>): Promise<void>` - optional: hook called after a new item is created
- `transformSessionLabel?(oldLabel: string, detectedLabel: string): string` - optional: transform a detected session rename label

#### Scenario: Minimal adapter implementation
- **WHEN** a developer creates a new adapter
- **THEN** they implement `config`, `createParser`, `createMover`, `createCardRenderer`, and `createPromptBuilder`
- **AND** optional methods default to no-op behaviour via `BaseAdapter`

---

### Requirement: BaseAdapter abstract class

The system SHALL define a `BaseAdapter` abstract class implementing `AdapterBundle` with:
- Abstract (required): `config`, `createParser`, `createMover`, `createCardRenderer`, `createPromptBuilder`
- Default `createDetailView`: returns undefined (framework uses 2-column layout)
- Default `onItemCreated`: no-op (returns resolved promise)
- Default `transformSessionLabel`: returns `detectedLabel` unchanged

#### Scenario: Adapter extends BaseAdapter
- **WHEN** an adapter extends `BaseAdapter` and implements the five required members
- **THEN** it compiles successfully and optional methods use sensible defaults

#### Scenario: Adapter overrides optional method
- **WHEN** an adapter overrides `createDetailView`
- **THEN** the framework calls the adapter's implementation instead of the default
