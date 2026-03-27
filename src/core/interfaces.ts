import type { TFile, App, MenuItem, WorkspaceLeaf } from "obsidian";

/**
 * A work item that owns terminal tabs. Adapters parse domain-specific files
 * into WorkItems; the framework manages terminals, layout, and persistence
 * using only this interface.
 */
export interface WorkItem {
  /** Unique identifier (UUID from frontmatter). Used as session map key. */
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

/** A column in the kanban list panel. Maps to a folder on disk. */
export interface ListColumn {
  /** Column identifier used as group key. */
  id: string;
  /** Display label shown in the section header. */
  label: string;
  /** Folder name within the base path. */
  folderName: string;
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
  /** Load all items from the vault. */
  loadAll(): Promise<WorkItem[]>;
  /** Group items by column ID for kanban rendering. */
  groupByColumn(items: WorkItem[]): Record<string, WorkItem[]>;
  /** Check if a vault path belongs to this adapter's item files. */
  isItemFile(path: string): boolean;
}

/**
 * Moves a work item between columns (states). Handles frontmatter updates,
 * file renames, and activity log entries.
 */
export interface WorkItemMover {
  /** Move an item file to the target column, updating state/tags/timestamps. */
  move(file: TFile, targetColumnId: string): Promise<void>;
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
  /** Create a parser for loading/parsing work items from the vault. */
  createParser(app: App, basePath: string): WorkItemParser;
  /** Create a mover for state transitions between columns. */
  createMover(app: App, basePath: string): WorkItemMover;
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
  /**
   * Called after a new item is created via the PromptBox. Creates the file
   * and kicks off background enrichment. Returns the new item's UUID and column
   * so the framework can prepend it to the custom order.
   */
  onItemCreated?(title: string, settings: Record<string, unknown>): Promise<{ id: string; columnId: string } | void>;
  /**
   * Split an existing item: create a new task file with a related reference
   * to the source item. Returns the vault path and UUID of the new file.
   */
  onSplitItem?(sourceItem: WorkItem, columnId: string, settings: Record<string, unknown>): Promise<{ path: string; id: string } | null>;
  /**
   * Transform a detected Claude session rename label before applying it.
   * Called when Claude outputs "Session renamed to: <name>".
   * Return the label to use (default: return detectedLabel unchanged).
   */
  transformSessionLabel?(oldLabel: string, detectedLabel: string): string;
}

/**
 * Base class with sensible defaults for optional AdapterBundle methods.
 * Extend this and implement the 5 abstract methods to create an adapter.
 */
export abstract class BaseAdapter implements AdapterBundle {
  abstract config: PluginConfig;
  abstract createParser(app: App, basePath: string): WorkItemParser;
  abstract createMover(app: App, basePath: string): WorkItemMover;
  abstract createCardRenderer(): CardRenderer;
  abstract createPromptBuilder(): WorkItemPromptBuilder;

  createDetailView?(_item: WorkItem, _app: App, _ownerLeaf: WorkspaceLeaf): void {
    return undefined;
  }

  detachDetailView?(): void {
    // no-op by default
  }

  async onItemCreated(_title: string, _settings: Record<string, unknown>): Promise<{ id: string; columnId: string } | void> {
    // no-op by default
  }

  async onSplitItem(_sourceItem: WorkItem, _columnId: string, _settings: Record<string, unknown>): Promise<{ path: string; id: string } | null> {
    return null;
  }

  transformSessionLabel(_oldLabel: string, detectedLabel: string): string {
    return detectedLabel;
  }
}
