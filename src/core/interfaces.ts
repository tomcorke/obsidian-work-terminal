import type { TFile, App, MenuItem, WorkspaceLeaf } from "obsidian";

/**
 * A work item that owns terminal tabs. Adapters parse domain-specific files
 * into WorkItems; the framework manages terminals, layout, and persistence
 * using only this interface.
 */
export interface WorkItem {
  /** Unique identifier used as the session map key. Usually a frontmatter UUID, with path fallback during ID backfill. */
  id: string;
  /** Vault-relative file path. */
  path: string;
  /** Display title shown on cards and in prompts. */
  title: string;
  /** Current state/column (e.g. "active", "todo", "done"). */
  state: string;
  /** Adapter-specific metadata (scores, tags, deadlines, etc.). */
  metadata: Record<string, unknown>;
}

/** A column in the kanban list panel. Optionally maps to a folder on disk. */
export interface ListColumn {
  /** Column identifier used as group key. */
  id: string;
  /** Display label shown in the section header. */
  label: string;
  /** Folder name within the base path. Optional for API-backed adapters that map columns to status values instead of folders. */
  folderName?: string;
}

/** A column available for item creation via the PromptBox. */
export interface CreationColumn {
  /** Column identifier matching a ListColumn.id. */
  id: string;
  /** Display label shown in the column selector. */
  label: string;
  /** If true, this column is pre-selected in the PromptBox. */
  default?: boolean;
}

/** Schema for a single setting field rendered in the settings tab. */
export interface SettingField {
  /** Namespaced key (e.g. "adapter.taskBasePath"). */
  key: string;
  /** Human-readable label. */
  name: string;
  /** Help text shown below the setting. */
  description: string;
  /** Input type. */
  type: "text" | "toggle" | "dropdown";
  /** Default value. */
  default: unknown;
  /**
   * Dropdown choices. Either a static map (value -> display label) or the
   * string `"profiles"` to dynamically populate from agent profiles.
   * Only used when `type` is `"dropdown"`.
   */
  choices?: Record<string, string> | "profiles";
}

/** Visual treatment style for a card flag. */
export type CardFlagStyle = "badge" | "accent-border" | "background-tint";

/** Comparison operator for numeric/string field matching. */
export type CardFlagOperator = "eq" | "neq" | "gt" | "lt" | "gte" | "lte" | "contains" | "regex";

/**
 * Describes a single flag rule that maps a frontmatter field to a visual
 * treatment on a work item card. Adapters supply default rules via
 * `PluginConfig.cardFlags`; end users may override via settings in future.
 *
 * Matching modes (evaluated in this priority order):
 * 1. `operator` + `operand` - flexible operator-based matching (eq, neq, gt, lt, gte, lte, contains, regex)
 * 2. `contains` - legacy shorthand for operator: "contains"
 * 3. `value` - legacy shorthand for operator: "eq"
 * 4. No match fields - matches on truthy field value
 */
export interface CardFlagRule {
  /** Dot-path into WorkItem.metadata (e.g. "priority.has-blocker"). */
  field: string;
  /** Match when the resolved field equals this value. Mutually exclusive with `contains`. Legacy; prefer `operator`+`operand`. */
  value?: unknown;
  /** Match when the resolved field (string or array) contains this value. Mutually exclusive with `value`. Legacy; prefer `operator`+`operand`. */
  contains?: string;
  /** Comparison operator for flexible matching. When set, `operand` provides the comparison value. */
  operator?: CardFlagOperator;
  /** The value to compare against when using `operator`. Interpreted as a number for gt/lt/gte/lte, a string for contains/regex/eq/neq. */
  operand?: string;
  /** Label text rendered on the card (e.g. "BLOCKED", "URGENT"). */
  label: string;
  /** Visual treatment to apply. Defaults to "badge". */
  style?: CardFlagStyle;
  /** CSS colour value. For badge: background colour; for accent-border: border colour; for background-tint: background colour. */
  color?: string;
  /** Optional tooltip text. Supports a dot-path placeholder like `{{priority.blocker-context}}` resolved from metadata. */
  tooltip?: string;
}

/**
 * Adapter-provided plugin configuration. Defines the kanban columns,
 * creation options, settings schema, and display name for items.
 */
export interface PluginConfig {
  /** Kanban columns rendered as collapsible sections. */
  columns: ListColumn[];
  /** Columns available in the PromptBox for new item creation. */
  creationColumns: CreationColumn[];
  /** Adapter-specific settings rendered in the settings tab under "adapter.*". */
  settingsSchema: SettingField[];
  /** Default values for adapter settings. */
  defaultSettings: Record<string, unknown>;
  /** Singular noun for items (e.g. "task", "ticket"). Used in UI labels. */
  itemName: string;
  /** Column/state IDs considered terminal (completed/archived). Items in these states are excluded from "Move to Item" menus and similar UI elements. */
  terminalStates?: string[];
  /** Flag rules that map frontmatter fields to visual treatments on cards. Evaluated in order; all matching rules are applied. */
  cardFlags?: CardFlagRule[];
}

/**
 * Parses vault files into WorkItems and groups them by column.
 * Created by the adapter via `createParser()`.
 */
export interface WorkItemParser {
  /** Root vault path for item files. */
  basePath: string;
  /** Parse a single file into a WorkItem, or null if not a valid item. */
  parse(file: TFile): WorkItem | null;
  /** Parse raw data into a WorkItem without requiring a TFile. Optional; may be omitted by adapters. */
  parseData?(data: Record<string, unknown>): WorkItem | null;
  /** Load all items from the vault. */
  loadAll(): Promise<WorkItem[]>;
  /** Group items by column ID for kanban rendering. */
  groupByColumn(items: WorkItem[]): Record<string, WorkItem[]>;
  /** Check if a vault path belongs to this adapter's item files. */
  isItemFile(path: string): boolean;
  /** Backfill a durable item ID when the current ID is only a path fallback. */
  backfillItemId?(item: WorkItem): Promise<WorkItem | null>;
}

/**
 * Moves a work item between columns (states). Handles frontmatter updates,
 * file renames, and activity log entries.
 */
export interface WorkItemMover {
  /** Move an item file to the target column, updating state/tags/timestamps. Returns true on success, false on failure. */
  move(file: TFile, targetColumnId: string): Promise<boolean>;
}

/**
 * Framework-provided callbacks for standard card actions. Passed to
 * CardRenderer so adapters can trigger framework operations without
 * coupling to framework internals.
 */
export interface CardActionContext {
  /** Select this item in the list and show its terminals. */
  onSelect(): void;
  /** Move this item to the top of its current section. */
  onMoveToTop(): void;
  /** Move this item to a different column (triggers WorkItemMover). */
  onMoveToColumn(columnId: string): void;
  /** Insert a new item immediately after an existing one in custom order. */
  onInsertAfter(existingId: string, newItem: WorkItem): void;
  /** Split this item: create a new task with a related reference, then spawn Claude (ctx) to scope it. */
  onSplitTask(sourceItem: WorkItem): void;
  /** Delete this item (moves to trash). */
  onDelete(): void;
  /** Close all terminal sessions for this item. */
  onCloseSessions(): void;
  /** Build the exact prompt used by "Claude (ctx)" for this item, or null when unavailable. */
  getContextPrompt(): Promise<string | null>;
  /** Retry background enrichment for this item. */
  onRetryEnrich(): void;
  /** Clear stored resume sessions for this item and remove the resume indicator. */
  onClearResumeSessions(): Promise<void>;
  /** Whether this item currently shows the framework resume indicator. */
  hasResumeSessions(): boolean;
  /** Pin this item to the top of the kanban board. */
  onPin(): void;
  /** Unpin this item, returning it to its real state column. */
  onUnpin(): void;
  /** Whether this item is currently pinned. */
  isPinned(): boolean;
}

/**
 * Renders a work item as a DOM card element and provides context menu items.
 * Adapters control the visual appearance of cards (badges, icons, layout)
 * while using CardActionContext for framework actions.
 */
export interface CardRenderer {
  /** Create the card DOM element for a work item. */
  render(item: WorkItem, ctx: CardActionContext): HTMLElement;
  /** Return context menu items for right-click on a card. */
  getContextMenuItems(item: WorkItem, ctx: CardActionContext): MenuItem[];
}

/**
 * Builds the context prompt sent to Claude when launching a
 * "Claude (with context)" session for a work item.
 */
export interface WorkItemPromptBuilder {
  /** Build a prompt string including item title, state, path, and any relevant metadata. */
  buildPrompt(item: WorkItem, fullPath: string): string;
  /**
   * Return a human-readable description of the prompt format this builder produces.
   * Used in the profile settings UI to show users what the adapter prepends.
   * Example: "Task: {title}\nState: {state}\nFile: {path}"
   */
  describePromptFormat?(): string;
}

/**
 * The adapter bundle is the single extension point for adapters.
 * Implement all required factory methods; optional methods have defaults
 * in BaseAdapter.
 *
 * To create a custom adapter: extend BaseAdapter, implement the 5 required
 * abstract methods, and change the import in main.ts.
 */
export interface AdapterBundle {
  /** Plugin configuration (columns, settings, item name). */
  config: PluginConfig;
  /**
   * Optional async initialization hook called once during view setup,
   * before createParser/createMover. Use for async setup like credential
   * fetching, API client initialization, or initial data sync.
   */
  onLoad?(app: App, settings: Record<string, unknown>): Promise<void>;
  /** Create a parser for loading/parsing work items from the vault. */
  createParser(app: App, basePath: string, settings?: Record<string, unknown>): WorkItemParser;
  /** Create a mover for state transitions between columns. */
  createMover(app: App, basePath: string, settings?: Record<string, unknown>): WorkItemMover;
  /** Create a card renderer for the list panel. */
  createCardRenderer(): CardRenderer;
  /** Create a prompt builder for Claude context sessions. */
  createPromptBuilder(): WorkItemPromptBuilder;
  /**
   * Open a detail view for the selected item. The adapter manages its own
   * Obsidian workspace leaf via `app.workspace.createLeafBySplit(ownerLeaf)`.
   * If undefined, the plugin renders a 2-column layout without a detail panel.
   */
  createDetailView?(item: WorkItem, app: App, ownerLeaf: WorkspaceLeaf): void;
  /** Detach the detail view leaf on close/reload. */
  detachDetailView?(): void;
  /** Update detail view tracking when an item file is renamed. */
  rekeyDetailPath?(oldPath: string, newPath: string): void;
  /**
   * Called after a new item is created via the PromptBox. Creates the file
   * and kicks off background enrichment. Returns the new item's UUID, column,
   * and an enrichmentDone promise for tracking when background work finishes.
   */
  onItemCreated?(
    title: string,
    settings: Record<string, unknown>,
  ): Promise<{ id: string; columnId: string; enrichmentDone?: Promise<void> } | void>;
  /**
   * Split an existing item: create a new task file with a related reference
   * to the source item. Returns the vault path and UUID of the new file.
   */
  onSplitItem?(
    sourceItem: WorkItem,
    columnId: string,
    settings: Record<string, unknown>,
  ): Promise<{ path: string; id: string } | null>;
  /**
   * Transform a detected agent session rename label before applying it.
   * Called when Claude outputs "Session renamed to: <name>".
   * Return the label to use (default: return detectedLabel unchanged).
   */
  transformSessionLabel?(oldLabel: string, detectedLabel: string): string;
  /**
   * Called by the framework when plugin settings change. Adapters can use
   * this to update internal state that depends on settings (e.g. card flag
   * rules). The framework triggers a UI refresh after calling this.
   */
  onSettingsChanged?(settings: Record<string, unknown>): void;
  /**
   * Framework-set callback that triggers a debounced UI refresh.
   * API-backed adapters can call this after fetching external data
   * to update the list without relying on vault file events.
   */
  requestRefresh?: () => void;
  /**
   * Prepare a retry enrichment for an item whose initial enrichment failed.
   * Removes the background-ingestion flag and warning callout, then returns
   * the enrichment prompt to use in a foreground Claude session.
   * Returns null if retry is not applicable.
   */
  getRetryEnrichPrompt?(item: WorkItem): Promise<string | null>;
  /**
   * Called before deleting an item. Return false to prevent the
   * default vault.trash() behavior (e.g. for API-backed items that
   * need custom deletion logic). If not implemented, defaults to true.
   */
  onDelete?(item: WorkItem): Promise<boolean>;
  /**
   * Return adapter-specific CSS to inject into the document.
   * Called once during view setup; the framework manages the style
   * element lifecycle (injection on init, cleanup on close).
   */
  getStyles?(): string;
}

/**
 * Base class with sensible defaults for optional AdapterBundle methods.
 * Extend this and implement the 5 abstract methods to create an adapter.
 */
export abstract class BaseAdapter implements AdapterBundle {
  abstract config: PluginConfig;
  abstract createParser(
    app: App,
    basePath: string,
    settings?: Record<string, unknown>,
  ): WorkItemParser;
  abstract createMover(
    app: App,
    basePath: string,
    settings?: Record<string, unknown>,
  ): WorkItemMover;
  abstract createCardRenderer(): CardRenderer;
  abstract createPromptBuilder(): WorkItemPromptBuilder;

  async onLoad(_app: App, _settings: Record<string, unknown>): Promise<void> {
    // no-op by default
  }

  createDetailView?(_item: WorkItem, _app: App, _ownerLeaf: WorkspaceLeaf): void {
    return undefined;
  }

  detachDetailView?(): void {
    // no-op by default
  }

  rekeyDetailPath?(_oldPath: string, _newPath: string): void {
    // no-op by default
  }

  async onItemCreated(
    _title: string,
    _settings: Record<string, unknown>,
  ): Promise<{ id: string; columnId: string; enrichmentDone?: Promise<void> } | void> {
    // no-op by default
  }

  async onSplitItem(
    _sourceItem: WorkItem,
    _columnId: string,
    _settings: Record<string, unknown>,
  ): Promise<{ path: string; id: string } | null> {
    return null;
  }

  transformSessionLabel(_oldLabel: string, detectedLabel: string): string {
    return detectedLabel;
  }

  async onDelete(_item: WorkItem): Promise<boolean> {
    return true;
  }
}
