import type { CardFlagRule, PluginConfig } from "../../core/interfaces";
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
        "Prompt sent to the headless agent for background enrichment. Use {{FILE_PATH}} as a placeholder for the task file path. Leave empty for default.",
      type: "text",
      default: "",
    },
    {
      key: "retryEnrichmentPrompt",
      name: "Retry enrichment prompt",
      description:
        "Prompt used when retrying enrichment via right-click menu. Use {{FILE_PATH}} as a placeholder. Leave empty for default.",
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
  ],
  defaultSettings: {
    taskBasePath: "2 - Areas/Tasks",
    stateStrategy: "folder",
    jiraBaseUrl: "",
    enrichmentEnabled: true,
    enrichmentPrompt: "",
    retryEnrichmentPrompt: "",
    enrichmentProfile: "",
    enrichmentTimeout: "",
    customCardFlags: "[]",
  },
  itemName: "task",
  terminalStates: ["done", "abandoned"],
  cardFlags: DEFAULT_CARD_FLAGS,
};
