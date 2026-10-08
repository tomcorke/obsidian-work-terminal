import type {
  AdapterBundle,
  WorkItem,
  WorkItemParser,
  WorkItemRelationships,
} from "../core/interfaces";
import { titleCase } from "../core/utils";

export const TASK_LIST_DEFAULT_LIMIT = 50;
export const TASK_LIST_MAX_LIMIT = 200;
export const TASK_HIERARCHY_DEFAULT_DEPTH = 8;
export const TASK_HIERARCHY_MAX_DEPTH = 32;
export const TASK_HIERARCHY_MAX_RESULTS = 500;

export interface TaskCategorySummary {
  id: string;
  label: string;
}

export interface TaskSummary {
  id: string;
  title: string;
  state: string;
  categoryId: string;
  reference: string;
  directParentIds: string[];
  directChildIds: string[];
}

export interface TaskListResult {
  tasks: TaskSummary[];
  truncated: boolean;
}

export interface TaskRelationshipSummary extends TaskSummary {
  depth: number;
  direct: boolean;
}

export interface TaskRelationshipCycle {
  fromId: string;
  toId: string;
}

export interface TaskTraversalResult {
  tasks: TaskRelationshipSummary[];
  missingIds: string[];
  cycles: TaskRelationshipCycle[];
  truncated: boolean;
  truncation: {
    depthLimitReached: boolean;
    resultLimitReached: boolean;
  };
}

export interface TaskTraversalOptions {
  maxDepth?: number;
  maxResults?: number;
}

export class TaskCatalogue {
  constructor(
    private parser: WorkItemParser,
    private adapter: AdapterBundle,
  ) {}

  async listCategories(): Promise<TaskCategorySummary[]> {
    const items = await this.parser.loadAll();
    const configured = this.adapter.config.columns.map(({ id, label }) => ({ id, label }));
    const configuredIds = new Set(configured.map(({ id }) => id));
    const dynamicIds = [...new Set(items.map(({ state }) => state))]
      .filter((id) => !configuredIds.has(id))
      .sort(compareText);
    return [...configured, ...dynamicIds.map((id) => ({ id, label: titleCase(id) }))];
  }

  async listTasks(options: { categoryId?: string; limit?: number } = {}): Promise<TaskListResult> {
    const limit = boundedInteger(options.limit, TASK_LIST_DEFAULT_LIMIT, TASK_LIST_MAX_LIMIT);
    const snapshot = await this.loadSnapshot();
    const matching = snapshot.filter(
      ({ categoryId }) => options.categoryId === undefined || categoryId === options.categoryId,
    );
    return {
      tasks: matching.slice(0, limit),
      truncated: matching.length > limit,
    };
  }

  async getTask(taskId: string): Promise<TaskSummary | null> {
    return (await this.loadSnapshot()).find(({ id }) => id === taskId) ?? null;
  }

  async getSubtasks(
    taskId: string,
    options: TaskTraversalOptions = {},
  ): Promise<TaskTraversalResult | null> {
    return this.traverse(taskId, "directChildIds", options);
  }

  async getParentTasks(
    taskId: string,
    options: TaskTraversalOptions = {},
  ): Promise<TaskTraversalResult | null> {
    return this.traverse(taskId, "directParentIds", options);
  }

  private async traverse(
    taskId: string,
    direction: "directParentIds" | "directChildIds",
    options: TaskTraversalOptions,
  ): Promise<TaskTraversalResult | null> {
    const snapshot = await this.loadSnapshot();
    const byId = new Map(snapshot.map((task) => [task.id, task]));
    const root = byId.get(taskId);
    if (!root) return null;

    const maxDepth = boundedInteger(
      options.maxDepth,
      TASK_HIERARCHY_DEFAULT_DEPTH,
      TASK_HIERARCHY_MAX_DEPTH,
    );
    const maxResults = boundedInteger(
      options.maxResults,
      TASK_HIERARCHY_MAX_RESULTS,
      TASK_HIERARCHY_MAX_RESULTS,
    );
    const tasks: TaskRelationshipSummary[] = [];
    const missingIds = new Set<string>();
    const seen = new Set([taskId]);
    const queue = root[direction].map((id) => ({ id, depth: 1 }));
    let depthLimitReached = false;
    let resultLimitReached = false;

    while (queue.length > 0) {
      const next = queue.shift()!;
      if (seen.has(next.id)) continue;
      const task = byId.get(next.id);
      if (!task) {
        missingIds.add(next.id);
        continue;
      }
      if (tasks.length >= maxResults) {
        resultLimitReached = true;
        break;
      }
      seen.add(task.id);
      tasks.push({ ...task, depth: next.depth, direct: next.depth === 1 });

      for (const id of task[direction]) {
        if (next.depth >= maxDepth) {
          if (!seen.has(id)) depthLimitReached = true;
        } else {
          queue.push({ id, depth: next.depth + 1 });
        }
      }
    }

    const truncated = depthLimitReached || resultLimitReached;
    return {
      tasks,
      missingIds: [...missingIds].sort(compareText),
      cycles: findCycles(root, direction, byId, seen),
      truncated,
      truncation: { depthLimitReached, resultLimitReached },
    };
  }

  private async loadSnapshot(): Promise<TaskSummary[]> {
    const items = await this.parser.loadAll();
    const itemIds = new Set(items.map(({ id }) => id));
    const relationships = new Map<string, WorkItemRelationships>();
    for (const item of items) {
      const direct = this.adapter.getWorkItemRelationships?.(item) ?? emptyRelationships();
      relationships.set(item.id, {
        parentIds: uniqueSorted(direct.parentIds),
        childIds: uniqueSorted(direct.childIds),
      });
    }
    for (const [itemId, direct] of relationships) {
      for (const parentId of direct.parentIds) {
        if (itemIds.has(parentId)) relationships.get(parentId)?.childIds.push(itemId);
      }
      for (const childId of direct.childIds) {
        if (itemIds.has(childId)) relationships.get(childId)?.parentIds.push(itemId);
      }
    }
    return items
      .map((item) => this.toSummary(item, relationships.get(item.id) ?? emptyRelationships()))
      .sort((a, b) => compareText(a.id, b.id));
  }

  private toSummary(item: WorkItem, relationships: WorkItemRelationships): TaskSummary {
    return {
      id: item.id,
      title: item.title,
      state: item.state,
      categoryId: item.state,
      reference: item.path,
      directParentIds: uniqueSorted(relationships.parentIds),
      directChildIds: uniqueSorted(relationships.childIds),
    };
  }
}

function emptyRelationships(): WorkItemRelationships {
  return { parentIds: [], childIds: [] };
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function findCycles(
  root: TaskSummary,
  direction: "directParentIds" | "directChildIds",
  byId: Map<string, TaskSummary>,
  includedIds: Set<string>,
): TaskRelationshipCycle[] {
  const state = new Map<string, "visiting" | "visited">();
  const cycles = new Map<string, TaskRelationshipCycle>();

  const visit = (task: TaskSummary): void => {
    state.set(task.id, "visiting");
    for (const relatedId of task[direction]) {
      if (!includedIds.has(relatedId)) continue;
      if (state.get(relatedId) === "visiting") {
        cycles.set(`${task.id}\0${relatedId}`, { fromId: task.id, toId: relatedId });
      } else if (!state.has(relatedId)) {
        const related = byId.get(relatedId);
        if (related) visit(related);
      }
    }
    state.set(task.id, "visited");
  };

  visit(root);
  return [...cycles.values()].sort(compareCycles);
}

function compareCycles(a: TaskRelationshipCycle, b: TaskRelationshipCycle): number {
  return compareText(a.fromId, b.fromId) || compareText(a.toId, b.toId);
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.floor(value), maximum));
}
