import type { App, TFile } from "obsidian";
import type { WorkItem, WorkItemParser } from "../../core/interfaces";
import { type TaskFile, type TaskState, type KanbanColumn, KANBAN_COLUMNS } from "./types";

const VALID_STATES: TaskState[] = ["priority", "todo", "active", "done", "abandoned"];

export class TaskParser implements WorkItemParser {
  basePath: string;

  constructor(
    private app: App,
    _basePath: string,
    private settings: Record<string, any>,
  ) {
    this.basePath = this.settings["adapter.taskBasePath"] || "2 - Areas/Tasks";
  }

  parse(file: TFile): WorkItem | null {
    const taskFile = this.parseTaskFile(file);
    if (!taskFile) return null;
    return this.toWorkItem(taskFile);
  }

  parseTaskFile(file: TFile): TaskFile | null {
    const cache = this.app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter;
    const fallbackState = this.getStateFromPath(file.path);
    if (!fm) {
      return this.createFallbackTaskFile(file, fallbackState);
    }

    const state = this.normaliseState(fm.state, fallbackState);
    if (!state) return null;

    const source = fm.source || {};
    const priority = fm.priority || {};
    const tags: string[] = fm.tags || [];
    const goal: string[] = Array.isArray(fm.goal) ? fm.goal : fm.goal ? [fm.goal] : [];

    return {
      id: fm.id || "",
      path: file.path,
      filename: file.name,
      state,
      title: fm.title || file.basename,
      tags,
      source: {
        type: source.type || "other",
        id: source.id || "",
        url: source.url || "",
        captured: source.captured || "",
      },
      priority: {
        score: priority.score ?? 0,
        deadline: priority.deadline || "",
        impact: priority.impact || "medium",
        "has-blocker": priority["has-blocker"] ?? false,
        "blocker-context": priority["blocker-context"] || "",
      },
      agentActionable: fm["agent-actionable"] ?? false,
      goal,
      color: fm.color || undefined,
      created: fm.created || "",
      updated: fm.updated || "",
    };
  }

  private normaliseState(
    frontmatterState: unknown,
    fallbackState: TaskState | null,
  ): TaskState | null {
    if (
      typeof frontmatterState === "string" &&
      VALID_STATES.includes(frontmatterState as TaskState)
    ) {
      return frontmatterState as TaskState;
    }

    return fallbackState;
  }

  private getStateFromPath(path: string): TaskState | null {
    const relativePath = path.startsWith(this.basePath + "/")
      ? path.slice(this.basePath.length + 1)
      : path;
    const folder = relativePath.split("/")[0];
    switch (folder) {
      case "priority":
      case "todo":
      case "active":
        return folder;
      case "archive":
        return "done";
      default:
        return null;
    }
  }

  private createFallbackTaskFile(file: TFile, state: TaskState | null): TaskFile | null {
    if (!state) return null;

    console.warn(
      `[work-terminal] Falling back to path-based task parsing for malformed frontmatter: ${file.path}`,
    );

    return {
      id: file.path,
      path: file.path,
      filename: file.name,
      state,
      title: file.basename,
      tags: ["task", `task/${state}`],
      source: {
        type: "other",
        id: "",
        url: "",
        captured: "",
      },
      priority: {
        score: 0,
        deadline: "",
        impact: "medium",
        "has-blocker": false,
        "blocker-context": "",
      },
      agentActionable: false,
      goal: [],
      color: undefined,
      created: "",
      updated: "",
    };
  }

  private toWorkItem(task: TaskFile): WorkItem {
    return {
      id: task.id,
      path: task.path,
      title: task.title,
      state: task.state,
      metadata: {
        filename: task.filename,
        tags: task.tags,
        source: task.source,
        priority: task.priority,
        agentActionable: task.agentActionable,
        goal: task.goal,
        color: task.color,
        created: task.created,
        updated: task.updated,
      },
    };
  }

  async loadAll(): Promise<WorkItem[]> {
    const items: WorkItem[] = [];
    const folders = ["priority", "todo", "active", "archive"];

    for (const folder of folders) {
      const folderPath = `${this.basePath}/${folder}`;
      const abstractFile = this.app.vault.getAbstractFileByPath(folderPath);
      if (!abstractFile) continue;

      const files = this.app.vault
        .getMarkdownFiles()
        .filter((f) => f.path.startsWith(folderPath + "/") && f.extension === "md");

      for (const file of files) {
        const item = this.parse(file);
        if (item) items.push(item);
      }
    }

    return items;
  }

  groupByColumn(items: WorkItem[]): Record<string, WorkItem[]> {
    const groups: Record<string, WorkItem[]> = {};
    for (const col of KANBAN_COLUMNS) {
      groups[col] = [];
    }

    for (const item of items) {
      if (item.state === "abandoned") continue;

      const column = item.state === "done" ? "done" : item.state;
      if (KANBAN_COLUMNS.includes(column as KanbanColumn)) {
        groups[column].push(item);
      }
    }

    // Sort each column: score desc, then updated desc
    for (const col of KANBAN_COLUMNS) {
      groups[col].sort((a, b) => {
        const aPriority = (a.metadata as any)?.priority || { score: 0 };
        const bPriority = (b.metadata as any)?.priority || { score: 0 };
        const scoreDiff = bPriority.score - aPriority.score;
        if (scoreDiff !== 0) return scoreDiff;
        const aUpdated = (a.metadata as any)?.updated || "";
        const bUpdated = (b.metadata as any)?.updated || "";
        return bUpdated.localeCompare(aUpdated);
      });
    }

    return groups;
  }

  isItemFile(path: string): boolean {
    return path.startsWith(this.basePath + "/") && path.endsWith(".md");
  }

  async backfillIds(): Promise<number> {
    let count = 0;
    const items = await this.loadAll();
    for (const item of items) {
      if (item.id) continue;
      const file = this.app.vault.getAbstractFileByPath(item.path) as TFile;
      if (!file) continue;

      try {
        const content = await this.app.vault.read(file);
        const uuid = crypto.randomUUID();
        const updated = content.replace(/^---\n/, `---\nid: ${uuid}\n`);
        if (updated !== content) {
          await this.app.vault.modify(file, updated);
          count++;
        }
      } catch (err) {
        console.error(`[work-terminal] Failed to backfill ID for ${item.path}:`, err);
      }
    }
    return count;
  }
}
