import type { App, WorkspaceLeaf } from "obsidian";
import {
  BaseAdapter,
  type WorkItem,
  type WorkItemParser,
  type WorkItemMover,
  type CardRenderer,
  type WorkItemPromptBuilder,
  type CardFlagRule,
  type PluginConfig,
} from "../../core/interfaces";
import { TASK_AGENT_CONFIG } from "./TaskAgentConfig";
import { TaskParser } from "./TaskParser";
import { TaskMover } from "./TaskMover";
import { TaskCard } from "./TaskCard";
import { TaskPromptBuilder } from "./TaskPromptBuilder";
import { TaskDetailView } from "./TaskDetailView";
import {
  handleItemCreated,
  handleSplitTaskCreated,
  prepareRetryEnrichment,
  type EnrichmentProfileOverride,
} from "./BackgroundEnrich";
import type { KanbanColumn } from "./types";
import { parseCustomCardFlags } from "./customCardFlags";

export class TaskAgentAdapter extends BaseAdapter {
  config: PluginConfig = TASK_AGENT_CONFIG;

  // Cached from framework calls - the framework passes app and settings to factory methods
  private _app: App | null = null;
  private _settings: Record<string, unknown> = {};
  private detailView: TaskDetailView | null = null;
  private _cardRenderer: TaskCard | null = null;

  createParser(app: App, basePath: string, settings?: Record<string, unknown>): WorkItemParser {
    const resolvedSettings = settings ?? {};
    this._app = app;
    this._settings = resolvedSettings;
    return new TaskParser(app, basePath, resolvedSettings);
  }

  createMover(app: App, basePath: string, settings?: Record<string, unknown>): WorkItemMover {
    const resolvedSettings = settings ?? {};
    this._app = app;
    this._settings = resolvedSettings;
    return new TaskMover(app, basePath, resolvedSettings);
  }

  createCardRenderer(): CardRenderer {
    const mergedRules = this.getMergedFlagRules();
    this._cardRenderer = new TaskCard(mergedRules);
    return this._cardRenderer;
  }

  /**
   * Called by the framework when settings change. Updates the card renderer's
   * flag rules so the next list refresh picks up user-defined card flags.
   */
  onSettingsChanged(settings: Record<string, unknown>): void {
    this._settings = settings;
    if (this._cardRenderer) {
      this._cardRenderer.updateFlagRules(this.getMergedFlagRules());
    }
  }

  /** Merge adapter-default card flags with user-defined custom flags from settings. */
  private getMergedFlagRules(): CardFlagRule[] {
    const defaults = this.config.cardFlags || [];
    const customJson = (this._settings["adapter.customCardFlags"] as string) || "[]";
    const custom = parseCustomCardFlags(customJson);
    return [...defaults, ...custom];
  }

  createPromptBuilder(): WorkItemPromptBuilder {
    return new TaskPromptBuilder();
  }

  createDetailView(item: WorkItem, app: App, ownerLeaf: WorkspaceLeaf): void {
    this._app = app;
    if (!this.detailView) {
      this.detailView = new TaskDetailView(app);
    }
    this.detailView.show(item, ownerLeaf);
  }

  rekeyDetailPath(oldPath: string, newPath: string): void {
    this.detailView?.rekeyPath(oldPath, newPath);
  }

  detachDetailView(): void {
    if (this.detailView) {
      this.detailView.detach();
      this.detailView = null;
    }
  }

  async onItemCreated(
    title: string,
    settings: Record<string, any>,
  ): Promise<{ id: string; columnId: string }> {
    if (!this._app) {
      throw new Error("TaskAgentAdapter: app not available (no view opened yet)");
    }
    const profileOverride = settings._enrichmentProfile as EnrichmentProfileOverride | undefined;
    return handleItemCreated(this._app, title, settings, profileOverride);
  }

  async onSplitItem(
    sourceItem: WorkItem,
    columnId: string,
    settings: Record<string, any>,
  ): Promise<{ path: string; id: string } | null> {
    if (!this._app) {
      throw new Error("TaskAgentAdapter: app not available (no view opened yet)");
    }
    const basePath = settings["adapter.taskBasePath"] || "2 - Areas/Tasks";
    const sourceFilename = sourceItem.path.split("/").pop() || sourceItem.path;
    const title = `Split from: ${sourceItem.title}`;

    return handleSplitTaskCreated(this._app, title, columnId as KanbanColumn, basePath, {
      filename: sourceFilename,
      title: sourceItem.title,
    });
  }

  async getRetryEnrichPrompt(item: WorkItem): Promise<string | null> {
    if (!this._app) {
      throw new Error("TaskAgentAdapter: app not available (no view opened yet)");
    }
    const retryPromptTemplate = this._settings["adapter.retryEnrichmentPrompt"] as
      | string
      | undefined;
    return prepareRetryEnrichment(this._app, item.path, retryPromptTemplate);
  }

  transformSessionLabel(_oldLabel: string, detectedLabel: string): string {
    return detectedLabel;
  }
}
