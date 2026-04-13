export interface TaskSource {
  type: "slack" | "jira" | "confluence" | "prompt" | "other";
  id: string;
  url: string;
  captured: string;
}

export interface TaskPriority {
  score: number;
  deadline: string;
  impact: "low" | "medium" | "high" | "critical";
  "has-blocker": boolean;
  "blocker-context": string;
}

export type TaskState = "priority" | "todo" | "active" | "done" | "abandoned";

export type KanbanColumn = "priority" | "todo" | "active" | "done";

export interface TaskFile {
  id: string;
  path: string;
  filename: string;
  state: TaskState;
  title: string;
  tags: string[];
  source: TaskSource;
  priority: TaskPriority;
  agentActionable: boolean;
  goal: string[];
  color?: string;
  backgroundIngestion?: "failed" | "retrying";
  /** Set when frontmatter contains a state value that doesn't match any known column. Holds the unrecognized value for display in the warning badge. */
  stateWarning?: string;
  created: string;
  updated: string;
}

export const STATE_FOLDER_MAP: Record<KanbanColumn, string> = {
  priority: "priority",
  todo: "todo",
  active: "active",
  done: "archive",
};

export const COLUMN_LABELS: Record<KanbanColumn, string> = {
  priority: "Priority",
  active: "Active",
  todo: "To Do",
  done: "Done",
};

export const KANBAN_COLUMNS: KanbanColumn[] = ["priority", "active", "todo", "done"];

export const SOURCE_LABELS: Record<string, string> = {
  jira: "JIRA",
  slack: "SLK",
  confluence: "CONF",
  prompt: "CLI",
  other: "---",
};
