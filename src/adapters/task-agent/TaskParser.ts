import type { App, TFile } from "obsidian";
import type { WorkItem, WorkItemParser, StateResolver } from "../../core/interfaces";
import { extractYamlFrontmatterString } from "../../core/frontmatter";
import {
  type TaskFile,
  type TaskPriority,
  type TaskSource,
  type TaskState,
  type KanbanColumn,
  KANBAN_COLUMNS,
} from "./types";
import { TASK_AGENT_CONFIG } from "./TaskAgentConfig";

const VALID_STATES: TaskState[] = ["priority", "todo", "active", "done", "abandoned"];
const JIRA_KEY_RE = /\b([A-Z][A-Z0-9]+-\d+)\b/i;

export class TaskParser implements WorkItemParser {
  basePath: string;
  private static loggedFallbackPaths = new Set<string>();
  private transientIdsByPath = new Map<string, string>();
  private backfillPromisesByPath = new Map<string, Promise<WorkItem | null>>();
  private stateResolver: StateResolver | null;

  constructor(
    private app: App,
    _basePath: string,
    private settings: Record<string, any>,
    stateResolver?: StateResolver,
  ) {
    this.basePath = this.normaliseBasePath(
      this.settings["adapter.taskBasePath"] || "2 - Areas/Tasks",
    );
    this.stateResolver = stateResolver ?? null;
  }

  parse(file: TFile): WorkItem | null {
    const taskFile = this.parseTaskFile(file);
    if (!taskFile) return null;
    return this.toWorkItem(taskFile);
  }

  parseTaskFile(file: TFile): TaskFile | null {
    const cache = this.app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter;
    const transientId = this.transientIdsByPath.get(file.path);
    const fallbackState = this.resolveStateFromFile(file.path, fm);
    if (!fm) {
      return this.createFallbackTaskFile(file, fallbackState, transientId);
    }

    if (typeof fm.id === "string" && fm.id.trim()) {
      this.transientIdsByPath.delete(file.path);
    }

    const state: string | null = this.normaliseState(fm.state, fallbackState);
    if (!state) return null;

    const priority = this.resolvePriority(fm);
    const tags = this.normaliseTags(fm.tags);
    const goal: string[] = Array.isArray(fm.goal) ? fm.goal : fm.goal ? [fm.goal] : [];

    const bgIngestion = fm["background-ingestion"];
    const backgroundIngestion =
      bgIngestion === "failed" || bgIngestion === "retrying" ? bgIngestion : undefined;

    return {
      id: this.resolveTaskId(fm.id, file.path, transientId),
      path: file.path,
      filename: file.name,
      state,
      title: fm.title || file.basename,
      tags,
      source: this.resolveSource(fm, tags),
      priority,
      agentActionable: fm["agent-actionable"] ?? false,
      goal,
      color: fm.color || undefined,
      icon: typeof fm.icon === "string" && fm.icon.trim() ? fm.icon.trim() : undefined,
      backgroundIngestion,
      created: fm.created || "",
      updated: fm.updated || "",
    };
  }

  private resolveTaskId(frontmatterId: unknown, filePath: string, transientId?: string): string {
    if (typeof frontmatterId === "string" && frontmatterId.trim()) {
      return frontmatterId;
    }

    if (transientId) {
      return transientId;
    }

    return filePath;
  }

  private normaliseState(frontmatterState: unknown, fallbackState: string | null): string | null {
    // When a state resolver is configured, it has already resolved the state
    // (possibly a dynamic/custom value). Use its result as the fallback.
    // Direct frontmatter values are still accepted if they match known states
    // (backward compat for folder-only mode without resolver).
    if (
      typeof frontmatterState === "string" &&
      VALID_STATES.includes(frontmatterState as TaskState)
    ) {
      return frontmatterState as TaskState;
    }

    return fallbackState;
  }

  private normaliseTags(rawTags: unknown): string[] {
    if (Array.isArray(rawTags)) {
      return rawTags.filter((tag): tag is string => typeof tag === "string");
    }
    if (typeof rawTags === "string" && rawTags.trim()) {
      return [rawTags.trim()];
    }
    return [];
  }

  private resolvePriority(fm: Record<string, any>): TaskPriority {
    // Support flat dot-notation keys (new format) with fallback to nested (old format)
    // Use ?? (not ||) for string fields so empty strings from flat keys are preserved
    const nested = fm.priority || {};
    return {
      score: fm["priority.score"] ?? nested.score ?? 0,
      deadline: fm["priority.deadline"] ?? nested.deadline ?? "",
      impact: fm["priority.impact"] ?? nested.impact ?? "medium",
      "has-blocker": fm["priority.has-blocker"] ?? nested["has-blocker"] ?? false,
      "blocker-context": fm["priority.blocker-context"] ?? nested["blocker-context"] ?? "",
    };
  }

  private extractSourceFromFrontmatter(fm: Record<string, any>): Record<string, any> {
    // Support flat dot-notation keys (new format) with fallback to nested (old format)
    const nested = fm.source || {};
    const hasFlat =
      fm["source.type"] !== undefined ||
      fm["source.id"] !== undefined ||
      fm["source.url"] !== undefined ||
      fm["source.captured"] !== undefined;
    if (hasFlat) {
      return {
        type: fm["source.type"] ?? nested.type,
        id: fm["source.id"] ?? nested.id,
        url: fm["source.url"] ?? nested.url,
        captured: fm["source.captured"] ?? nested.captured,
      };
    }
    return nested;
  }

  private resolveSource(frontmatter: Record<string, any>, tags: string[]): TaskSource {
    const source = this.extractSourceFromFrontmatter(frontmatter);
    const explicit = this.normaliseSource(source);
    if (explicit.type === "jira") {
      const explicitJira = this.detectJiraSource([explicit.id, explicit.url, explicit.captured]);
      return {
        type: "jira",
        id: explicitJira?.id || explicit.id || "",
        url: explicitJira?.url || explicit.url || "",
        captured: explicit.captured || explicitJira?.captured || "",
      };
    }

    if (explicit.type !== "other") {
      return explicit;
    }

    if (explicit.id || explicit.url || explicit.captured) {
      const explicitJira = this.detectJiraSource([explicit.id, explicit.url, explicit.captured]);
      if (explicitJira) {
        return {
          type: "jira",
          ...explicitJira,
        };
      }
      return explicit;
    }

    const discreteJiraValue = this.getDiscreteJiraValue(frontmatter);
    const detected = this.detectJiraSource([discreteJiraValue, ...tags]);
    if (detected) {
      return {
        type: "jira",
        ...detected,
      };
    }

    return explicit;
  }

  private normaliseSource(source: Record<string, any>): TaskSource {
    return {
      type: source.type || "other",
      id: typeof source.id === "string" ? source.id : "",
      url: typeof source.url === "string" ? source.url : "",
      captured: typeof source.captured === "string" ? source.captured : "",
    };
  }

  private getDiscreteJiraValue(frontmatter: Record<string, any>): unknown {
    for (const [key, value] of Object.entries(frontmatter)) {
      if (key.toLowerCase() === "jira") {
        return value;
      }
    }
    return undefined;
  }

  private detectJiraSource(values: unknown[]): Omit<TaskSource, "type"> | null {
    for (const value of values) {
      const raw = this.extractStringValue(value);
      if (!raw) continue;

      const trimmed = raw.trim();
      if (!trimmed) continue;

      const tagMatch = trimmed.match(/^jira(?:[/:_-])(.*)$/i);
      const candidate = (tagMatch?.[1] || trimmed).trim();
      if (!candidate) continue;

      if (/^https?:\/\//i.test(candidate)) {
        const id = this.extractJiraKey(candidate);
        if (!id) continue;
        return { id, url: candidate, captured: trimmed };
      }

      const id = this.extractJiraKey(candidate);
      if (!id) continue;
      return {
        id,
        url: this.buildJiraUrl(id),
        captured: trimmed,
      };
    }
    return null;
  }

  private extractStringValue(value: unknown): string | null {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      const firstString = value.find((entry): entry is string => typeof entry === "string");
      return firstString ?? null;
    }
    return null;
  }

  private extractJiraKey(value: string): string {
    const match = value.match(JIRA_KEY_RE);
    return match?.[1]?.toUpperCase() || "";
  }

  private buildJiraUrl(id: string): string {
    const defaultJiraBaseUrl =
      typeof TASK_AGENT_CONFIG.defaultSettings.jiraBaseUrl === "string"
        ? TASK_AGENT_CONFIG.defaultSettings.jiraBaseUrl
        : "";
    const baseUrl =
      typeof this.settings["adapter.jiraBaseUrl"] === "string" &&
      this.settings["adapter.jiraBaseUrl"].trim()
        ? this.settings["adapter.jiraBaseUrl"].trim()
        : defaultJiraBaseUrl;
    return `${baseUrl.replace(/\/+$/, "")}/${id}`;
  }

  /**
   * Resolve state for a file using the configured StateResolver if available,
   * falling back to the legacy path-based resolution.
   *
   * When a resolver is present, any non-null string it returns is accepted -
   * including dynamic/custom states not in the predefined VALID_STATES list.
   * This enables the open state set feature where frontmatter can contain
   * arbitrary state values that create dynamic kanban columns.
   */
  private resolveStateFromFile(
    path: string,
    frontmatter: Record<string, unknown> | undefined,
  ): string | null {
    if (this.stateResolver) {
      const resolved = this.stateResolver.resolveState(path, frontmatter);
      if (resolved !== null) {
        return resolved;
      }
      // If resolver returned null, fall back to the legacy path-based
      // resolution below.
    }
    return this.getStateFromPath(path);
  }

  private getStateFromPath(path: string): TaskState | null {
    const relativePath = path.startsWith(`${this.basePath}/`)
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

  private createFallbackTaskFile(
    file: TFile,
    state: string | null,
    transientId?: string,
  ): TaskFile | null {
    if (!state) return null;

    if (!TaskParser.loggedFallbackPaths.has(file.path)) {
      TaskParser.loggedFallbackPaths.add(file.path);
      console.debug(
        `[work-terminal] Falling back to path-based task parsing for malformed frontmatter: ${file.path}`,
      );
    }

    return {
      id: transientId || file.path,
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
        icon: task.icon,
        backgroundIngestion: task.backgroundIngestion,
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
      } else {
        // Dynamic/custom state - create a group for it
        if (!groups[column]) {
          groups[column] = [];
        }
        groups[column].push(item);
      }
    }

    // Sort each column: score desc, then updated desc
    for (const col of Object.keys(groups)) {
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

  private normaliseBasePath(path: string): string {
    return path.replace(/\/+$/, "");
  }

  async backfillItemId(item: WorkItem): Promise<WorkItem | null> {
    if (item.id !== item.path) {
      return item;
    }

    const inFlight = this.backfillPromisesByPath.get(item.path);
    if (inFlight) {
      return inFlight;
    }

    const promise = this.performIdBackfill(item).finally(() => {
      this.backfillPromisesByPath.delete(item.path);
    });
    this.backfillPromisesByPath.set(item.path, promise);
    return promise;
  }

  private async performIdBackfill(item: WorkItem): Promise<WorkItem | null> {
    const file = this.app.vault.getAbstractFileByPath(item.path) as TFile | null;
    if (!file) {
      return item;
    }

    try {
      const content = await this.app.vault.read(file);
      const existingId = this.extractFrontmatterId(content);
      if (existingId) {
        this.transientIdsByPath.set(item.path, existingId);
        return { ...item, id: existingId };
      }

      const uuid = crypto.randomUUID();
      const updated = this.insertFrontmatterId(content, uuid);
      if (!updated) {
        return item;
      }

      await this.app.vault.modify(file, updated);
      this.transientIdsByPath.set(item.path, uuid);
      return { ...item, id: uuid };
    } catch (err) {
      console.error(`[work-terminal] Failed to backfill ID for ${item.path}:`, err);
      return item;
    }
  }

  private extractFrontmatterId(content: string): string | null {
    return extractYamlFrontmatterString(content, "id");
  }

  private insertFrontmatterId(content: string, id: string): string | null {
    const match = content.match(/^(---\r?\n)([\s\S]*?)(^---(?:\r?\n|$))/m);
    if (!match) {
      return null;
    }

    const [, openingFence, frontmatter, closingFence] = match;
    const newline = openingFence.endsWith("\r\n") ? "\r\n" : "\n";
    const updatedFrontmatter = frontmatter.match(/^id:[ \t]*[^\r\n]*$/m)
      ? frontmatter.replace(/^id:[ \t]*[^\r\n]*$/m, `id: ${id}`)
      : frontmatter
        ? `id: ${id}${newline}${frontmatter}`
        : `id: ${id}${newline}`;

    return content.replace(match[0], `${openingFence}${updatedFrontmatter}${closingFence}`);
  }

  async backfillIds(): Promise<number> {
    let count = 0;
    const items = await this.loadAll();
    for (const item of items) {
      if (item.id !== item.path) {
        continue;
      }

      const backfilled = await this.backfillItemId(item);
      if (backfilled?.id && backfilled.id !== item.id) {
        count++;
      }
    }
    return count;
  }
}
