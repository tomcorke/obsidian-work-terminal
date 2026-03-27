import type { App, WorkspaceLeaf } from "obsidian";
import {
  BaseAdapter,
  type WorkItem,
  type WorkItemParser,
  type WorkItemMover,
  type CardRenderer,
  type WorkItemPromptBuilder,
  type PluginConfig,
} from "../../core/interfaces";
import { TASK_AGENT_CONFIG } from "./TaskAgentConfig";
import { TaskParser } from "./TaskParser";
import { TaskMover } from "./TaskMover";
import { TaskCard } from "./TaskCard";
import { TaskPromptBuilder } from "./TaskPromptBuilder";
import { TaskDetailView } from "./TaskDetailView";
import { handleItemCreated, handleSplitTaskCreated } from "./BackgroundEnrich";
import type { KanbanColumn } from "./types";

export class TaskAgentAdapter extends BaseAdapter {
  config: PluginConfig = TASK_AGENT_CONFIG;

  // Cached from framework calls - the framework always passes app to factory methods,
  // and settings are passed via onItemCreated's settings parameter
  private _app: App | null = null;
  private detailView: TaskDetailView | null = null;

  createParser(app: App, basePath: string): WorkItemParser {
    this._app = app;
    return new TaskParser(app, basePath, {});
  }

  createMover(app: App, basePath: string): WorkItemMover {
    this._app = app;
    return new TaskMover(app, basePath, {});
  }

  createCardRenderer(): CardRenderer {
    return new TaskCard();
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
    settings: Record<string, any>
  ): Promise<{ id: string; columnId: string }> {
    if (!this._app) {
      throw new Error("TaskAgentAdapter: app not available (no view opened yet)");
    }
    return handleItemCreated(this._app, title, settings);
  }

  async onSplitItem(
    sourceItem: WorkItem,
    columnId: string,
    settings: Record<string, any>
  ): Promise<{ path: string; id: string } | null> {
    if (!this._app) {
      throw new Error("TaskAgentAdapter: app not available (no view opened yet)");
    }
    const basePath = settings["adapter.taskBasePath"] || "2 - Areas/Tasks";
    const sourceFilename = sourceItem.path.split("/").pop() || sourceItem.path;
    const title = `Split from: ${sourceItem.title}`;

    return handleSplitTaskCreated(
      this._app,
      title,
      columnId as KanbanColumn,
      basePath,
      { filename: sourceFilename, title: sourceItem.title }
    );
  }

  transformSessionLabel(
    _oldLabel: string,
    detectedLabel: string
  ): string {
    return detectedLabel;
  }
}
