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

/** Known kanban column IDs. Dynamic columns use arbitrary string IDs. */
export type KanbanColumn = "priority" | "todo" | "active" | "done";

export interface TaskFile {
  id: string;
  path: string;
  filename: string;
  /** Task state - either a known TaskState or a dynamic/custom state string. */
  state: string;
  title: string;
  tags: string[];
  source: TaskSource;
  priority: TaskPriority;
  agentActionable: boolean;
  goal: string[];
  color?: string;
  /** Custom icon - Lucide icon name or emoji string. */
  icon?: string;
  backgroundIngestion?: "failed" | "retrying";
  created: string;
  updated: string;
  lastActive: string;
}

/** Automatic icon assignment mode. */
export type AutoIconMode = "none" | "source" | "state";

/** Source-based auto-icon mapping: source type -> Lucide icon name. */
export const SOURCE_AUTO_ICONS: Record<string, string> = {
  jira: "ticket",
  slack: "message-square",
  confluence: "file-text",
  prompt: "terminal",
  other: "circle",
};

/** State-based auto-icon mapping: kanban column -> Lucide icon name. */
export const STATE_AUTO_ICONS: Record<string, string> = {
  priority: "flame",
  active: "play",
  todo: "list-todo",
  done: "check",
};

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
