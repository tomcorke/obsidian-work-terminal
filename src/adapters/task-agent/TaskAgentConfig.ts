import type { PluginConfig } from "../../core/interfaces";
import { KANBAN_COLUMNS, COLUMN_LABELS, STATE_FOLDER_MAP } from "./types";

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
    jiraBaseUrl: "",
    enrichmentEnabled: true,
    enrichmentPrompt: "",
    retryEnrichmentPrompt: "",
    enrichmentTimeout: "",
  },
  itemName: "task",
  terminalStates: ["done", "abandoned"],
};
