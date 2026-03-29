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
        "Browse URL used to turn Jira keys like CASTLE-1234 into clickable external links",
      type: "text",
      default: "https://skyscanner.atlassian.net/browse",
    },
  ],
  defaultSettings: {
    taskBasePath: "2 - Areas/Tasks",
    jiraBaseUrl: "https://skyscanner.atlassian.net/browse",
  },
  itemName: "task",
};
