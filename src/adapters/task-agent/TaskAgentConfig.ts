import type { CardFlagRule, CreationColumn, ListColumn, PluginConfig } from "../../core/interfaces";
import { titleCase } from "../../core/utils";
import { KANBAN_COLUMNS, COLUMN_LABELS, STATE_FOLDER_MAP } from "./types";

/**
 * Default card flag rules for the task-agent adapter.
 * Replicates the previously hard-coded blocker badge behavior.
 */
export const DEFAULT_CARD_FLAGS: CardFlagRule[] = [
  {
    field: "priority.has-blocker",
    value: true,
    label: "BLOCKED",
    style: "badge",
    color: "#e5484d",
    tooltip: "{{priority.blocker-context}}",
  },
];

export const TASK_AGENT_CONFIG: PluginConfig = {
  columns: KANBAN_COLUMNS.map((col) => ({
    id: col,
    label: COLUMN_LABELS[col],
    folderName: STATE_FOLDER_MAP[col],
  })),
  creationColumns: [
    { id: "todo", label: "To Do" },
    { id: "active", label: "Active", default: true },
  ],
  settingsSchema: [
    {
      key: "taskBasePath",
      name: "Task base path",
      description: "Vault path containing task folders (priority, todo, active, archive)",
      type: "text",
      default: "2 - Areas/Tasks",
    },
    {
      key: "stateStrategy",
      name: "State resolution strategy",
      description:
        "How task state is determined. Folder: derived from folder location (default). Frontmatter: reads from the state frontmatter field, falling back to folder location if the field is missing. Composite: check frontmatter first, fall back to folder, and apply both on transition.",
      type: "dropdown",
      default: "folder",
      choices: {
        folder: "Folder-based (default)",
        frontmatter: "Frontmatter field",
        composite: "Composite (frontmatter + folder fallback)",
      },
    },
    {
      key: "jiraBaseUrl",
      name: "Jira base URL",
      description:
        "Browse URL used to turn Jira keys like PROJ-1234 into clickable external links (e.g. https://your-org.atlassian.net/browse)",
      type: "text",
      default: "",
    },
    {
      key: "enrichmentEnabled",
      name: "Enable background enrichment",
      description:
        "Automatically enrich new tasks in the background using a headless agent session",
      type: "toggle",
      default: true,
    },
    {
      key: "enrichmentPrompt",
      name: "Enrichment prompt",
      description:
        "Prompt sent to the headless agent for background enrichment. Use $filePath as a placeholder for the task file path. Leave empty for default.",
      type: "text",
      default: "",
    },
    {
      key: "retryEnrichmentPrompt",
      name: "Retry enrichment prompt",
      description:
        "Prompt used when retrying enrichment via right-click menu. Use $filePath as a placeholder. Leave empty for default.",
      type: "text",
      default: "",
    },
    {
      key: "enrichmentProfile",
      name: "Enrichment agent profile",
      description:
        "Agent profile to use for background enrichment. The profile's command, arguments, and working directory will be used. Select 'Default' to use the core Claude command settings.",
      type: "dropdown",
      default: "",
      choices: "profiles",
    },
    {
      key: "enrichmentTimeout",
      name: "Enrichment timeout (seconds)",
      description:
        "Maximum time in seconds for background enrichment before it is killed. Leave empty for default (300s / 5 min).",
      type: "text",
      default: "",
    },
    {
      key: "splitTaskProfile",
      name: "Split task agent profile",
      description:
        "Agent profile to use when launching Claude for Split Task. Select 'Default' to fall back through the built-in Claude-with-context profile and any other available Claude-family profiles.",
      type: "dropdown",
      default: "",
      choices: "profiles",
    },
    {
      key: "retryEnrichmentProfile",
      name: "Retry enrichment agent profile",
      description:
        "Agent profile to use for the 'Retry Enrichment' context-menu action. Select 'Default' to fall back to the background enrichment profile, then the built-in Claude (ctx) profile.",
      type: "dropdown",
      default: "",
      choices: "profiles",
    },
    {
      key: "showCardIndicators",
      name: "Show card indicators",
      description:
        "Show metadata indicators on task cards. In standard mode this is the metadata row (source badge, priority score, goal tags, card flags). In compact mode this is the indicator dots. Agent session badges remain visible regardless of this setting.",
      type: "toggle",
      default: true,
    },
    {
      key: "taskCardIcons",
      name: "Task card icons",
      description:
        "Show icons on task cards. Custom per-task icons are set via frontmatter or the context menu. Automatic icons are assigned based on the selected mode below.",
      type: "toggle",
      default: false,
    },
    {
      key: "autoIconMode",
      name: "Automatic icon mode",
      description:
        "How automatic icons are assigned when a task has no custom icon. Source-based: icon reflects the task source (Jira, Slack, terminal). State-based: icon reflects the kanban column (flame, play, check). None: only custom per-task icons are shown.",
      type: "dropdown",
      default: "none",
      choices: {
        none: "None (custom icons only)",
        source: "Source-based (Jira, Slack, terminal...)",
        state: "State-based (flame, play, check...)",
      },
    },
  ],
  defaultSettings: {
    taskBasePath: "2 - Areas/Tasks",
    stateStrategy: "folder",
    columnOrder: "",
    creationColumnIds: "",
    pinnedCustomStates: "[]",
    jiraBaseUrl: "",
    enrichmentEnabled: true,
    enrichmentPrompt: "",
    retryEnrichmentPrompt: "",
    enrichmentProfile: "",
    enrichmentTimeout: "",
    splitTaskProfile: "",
    retryEnrichmentProfile: "",
    showCardIndicators: true,
    taskCardIcons: false,
    autoIconMode: "none",
    customCardFlags: "[]",
  },
  itemName: "task",
  terminalStates: ["done", "abandoned"],
  cardFlags: DEFAULT_CARD_FLAGS,
};

/** The built-in default columns before any user customisation. */
export const DEFAULT_COLUMNS: ListColumn[] = KANBAN_COLUMNS.map((col) => ({
  id: col,
  label: COLUMN_LABELS[col],
  folderName: STATE_FOLDER_MAP[col],
}));

/** The built-in default creation columns before any user customisation. */
export const DEFAULT_CREATION_COLUMNS: CreationColumn[] = [
  { id: "todo", label: "To Do" },
  { id: "active", label: "Active", default: true },
];

/**
 * Parse a JSON string containing an array of column IDs.
 * Returns an empty array on invalid/empty input.
 */
export function parseColumnOrderJson(json: string | undefined): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return parsed;
    }
  } catch {
    // Invalid JSON - fall back to empty
  }
  return [];
}

/**
 * Resolve the effective column list from a custom order setting.
 * Re-orders DEFAULT_COLUMNS to match the provided column IDs.
 * Unknown IDs in the order are preserved as dynamic columns (created from
 * frontmatter states not in the predefined column list). Default columns
 * missing from the order are appended at the end.
 */
export function resolveColumns(columnOrderJson: string | undefined): ListColumn[] {
  const order = parseColumnOrderJson(columnOrderJson);
  if (order.length === 0) return DEFAULT_COLUMNS;

  const columnById = new Map(DEFAULT_COLUMNS.map((col) => [col.id, col]));
  const result: ListColumn[] = [];
  const seen = new Set<string>();

  for (const id of order) {
    if (seen.has(id)) continue;
    const col = columnById.get(id);
    if (col) {
      result.push(col);
    } else {
      // Dynamic column - created from a custom frontmatter state that was
      // previously reordered in settings. Preserve it with a title-cased label.
      result.push(makeDynamicColumn(id));
    }
    seen.add(id);
  }

  // Append any default columns not mentioned in the custom order
  for (const col of DEFAULT_COLUMNS) {
    if (!seen.has(col.id)) {
      result.push(col);
    }
  }

  return result;
}

/**
 * Create a ListColumn for a dynamic state ID (not in the predefined list).
 * Uses a title-cased version of the ID as the display label
 * (splits on `-`/`_` separators, capitalizes each word, joins with spaces).
 * No folderName since dynamic states are frontmatter-only.
 */
export function makeDynamicColumn(stateId: string): ListColumn {
  return {
    id: stateId,
    label: titleCase(stateId),
  };
}

/**
 * Parse a JSON string containing an array of pinned custom state IDs.
 * Returns an empty array on invalid/empty input.
 */
export function parsePinnedCustomStates(json: string | undefined): string[] {
  return parseColumnOrderJson(json);
}

/**
 * Check whether a custom state ID is pinned.
 */
export function isCustomStatePinned(pinnedJson: string | undefined, stateId: string): boolean {
  return parsePinnedCustomStates(pinnedJson).includes(stateId);
}

/**
 * Resolve the effective creation columns from a custom setting.
 * The first column in the list is marked as the default.
 * Accepts both predefined and dynamic column IDs.
 */
export function resolveCreationColumns(
  creationColumnIdsJson: string | undefined,
): CreationColumn[] {
  const ids = parseColumnOrderJson(creationColumnIdsJson);
  if (ids.length === 0) return DEFAULT_CREATION_COLUMNS;

  const labelById = new Map(DEFAULT_COLUMNS.map((col) => [col.id, col.label]));
  const result: CreationColumn[] = [];
  const seen = new Set<string>();

  for (const id of ids) {
    if (seen.has(id)) continue;
    const label = labelById.get(id);
    if (label) {
      result.push({ id, label, ...(result.length === 0 ? { default: true } : {}) });
      seen.add(id);
    } else {
      // Dynamic column - use title-cased ID as label
      const dynLabel = titleCase(id);
      result.push({ id, label: dynLabel, ...(result.length === 0 ? { default: true } : {}) });
      seen.add(id);
    }
  }

  return result.length > 0 ? result : DEFAULT_CREATION_COLUMNS;
}
