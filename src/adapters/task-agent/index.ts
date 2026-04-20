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
  type StateResolver,
} from "../../core/interfaces";
import { TASK_AGENT_CONFIG, resolveColumns, resolveCreationColumns } from "./TaskAgentConfig";
import { TaskParser } from "./TaskParser";
import { TaskMover } from "./TaskMover";
import { TaskCard } from "./TaskCard";
import { TaskPromptBuilder } from "./TaskPromptBuilder";
import { TaskDetailView } from "./TaskDetailView";
import { resolveDetailViewOptions } from "../../core/detailViewPlacement";
import {
  handleItemCreated,
  handleSplitTaskCreated,
  prepareRetryEnrichment,
  type EnrichmentProfileOverride,
} from "./BackgroundEnrich";
import type { KanbanColumn, AutoIconMode } from "./types";
import { parseCustomCardFlags } from "./customCardFlags";
import { createStateResolver, type StateStrategy } from "./stateResolverFactory";
import { SetIconModal } from "./SetIconModal";
import { yamlQuoteValue } from "../../core/utils";

export class TaskAgentAdapter extends BaseAdapter {
  config: PluginConfig = TASK_AGENT_CONFIG;

  // Cached from framework calls - the framework passes app and settings to factory methods
  private _app: App | null = null;
  private _settings: Record<string, unknown> = {};
  private detailView: TaskDetailView | null = null;
  private _cardRenderer: TaskCard | null = null;
  private _stateResolver: StateResolver | null = null;
  private _resolverStrategy: StateStrategy | null = null;
  private _resolverBasePath: string | null = null;

  /** Get or create the state resolver based on current settings. */
  private getStateResolver(basePath: string, settings: Record<string, unknown>): StateResolver {
    const strategy = ((settings["adapter.stateStrategy"] as string) || "folder") as StateStrategy;
    // Recreate resolver if strategy or basePath changed
    if (
      !this._stateResolver ||
      this._resolverStrategy !== strategy ||
      this._resolverBasePath !== basePath
    ) {
      this._stateResolver = createStateResolver(strategy, basePath);
      this._resolverStrategy = strategy;
      this._resolverBasePath = basePath;
    }
    return this._stateResolver;
  }

  createParser(app: App, basePath: string, settings?: Record<string, unknown>): WorkItemParser {
    const resolvedSettings = settings ?? {};
    this._app = app;
    this._settings = resolvedSettings;
    // Apply column settings on first load
    this.config.columns = resolveColumns(
      resolvedSettings["adapter.columnOrder"] as string | undefined,
    );
    this.config.creationColumns = resolveCreationColumns(
      resolvedSettings["adapter.creationColumnIds"] as string | undefined,
    );
    const taskBasePath = (resolvedSettings["adapter.taskBasePath"] as string) || "2 - Areas/Tasks";
    const resolver = this.getStateResolver(taskBasePath, resolvedSettings);
    return new TaskParser(app, basePath, resolvedSettings, resolver);
  }

  createMover(app: App, basePath: string, settings?: Record<string, unknown>): WorkItemMover {
    const resolvedSettings = settings ?? {};
    this._app = app;
    this._settings = resolvedSettings;
    const taskBasePath = (resolvedSettings["adapter.taskBasePath"] as string) || "2 - Areas/Tasks";
    const resolver = this.getStateResolver(taskBasePath, resolvedSettings);
    return new TaskMover(app, basePath, resolvedSettings, resolver);
  }

  createCardRenderer(): CardRenderer {
    const mergedRules = this.getMergedFlagRules();
    this._cardRenderer = new TaskCard(mergedRules);
    this.applyIconSettings();
    this.applyIndicatorSettings();
    this._cardRenderer.setIconOperations({
      promptSetIcon: (item: WorkItem) => this.promptSetIcon(item),
      clearIcon: (item: WorkItem) => this.clearIcon(item),
    });
    return this._cardRenderer;
  }

  /**
   * Called by the framework when settings change. Updates the card renderer's
   * flag rules, invalidates the cached state resolver so it's recreated
   * with the new strategy on next use, and applies column order/creation
   * column overrides from user settings.
   */
  onSettingsChanged(settings: Record<string, unknown>): void {
    this._settings = settings;
    // Invalidate the cached resolver so it's recreated with new settings
    this._stateResolver = null;
    if (this._cardRenderer) {
      this._cardRenderer.updateFlagRules(this.getMergedFlagRules());
      this.applyIconSettings();
      this.applyIndicatorSettings();
    }
    // Update column order and creation columns from settings
    this.config.columns = resolveColumns(settings["adapter.columnOrder"] as string | undefined);
    this.config.creationColumns = resolveCreationColumns(
      settings["adapter.creationColumnIds"] as string | undefined,
    );
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
    const options = resolveDetailViewOptions(this._settings);
    // "Disabled" placement means: do not instantiate a detail view at all.
    // Early-return also prevents opening the file so the user's layout is
    // left untouched on selection.
    if (options.placement === "disabled") {
      return;
    }
    if (!this.detailView) {
      this.detailView = new TaskDetailView(app);
    }
    this.detailView.show(item, ownerLeaf, options);
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

  /** Apply current card indicator visibility setting to the card renderer. */
  private applyIndicatorSettings(): void {
    if (!this._cardRenderer) return;
    // Default to true (show indicators) when setting is absent
    const show = this._settings["adapter.showCardIndicators"] !== false;
    this._cardRenderer.updateIndicatorVisibility(show);
  }

  /** Apply current icon settings to the card renderer. */
  private applyIconSettings(): void {
    if (!this._cardRenderer) return;
    const enabled = !!this._settings["adapter.taskCardIcons"];
    const autoMode = (this._settings["adapter.autoIconMode"] as AutoIconMode) || "none";
    this._cardRenderer.updateIconSettings(enabled, autoMode);
  }

  /** Show the Set Icon modal and update frontmatter on confirm. */
  private promptSetIcon(item: WorkItem): void {
    if (!this._app) return;
    const meta = (item.metadata || {}) as Record<string, any>;
    const currentIcon = typeof meta.icon === "string" ? meta.icon : "";

    new SetIconModal(this._app, currentIcon, async (iconValue: string) => {
      await this.updateFrontmatterIcon(item.path, iconValue);
    }).open();
  }

  /** Remove the icon field from a task's frontmatter. */
  private async clearIcon(item: WorkItem): Promise<void> {
    await this.updateFrontmatterIcon(item.path, null);
  }

  /**
   * Update (or remove) the `icon` field in a task file's YAML frontmatter.
   * Follows the same regex-based approach used by TaskMover for frontmatter updates.
   */
  private async updateFrontmatterIcon(filePath: string, icon: string | null): Promise<void> {
    if (!this._app) return;
    const file = this._app.vault.getAbstractFileByPath(filePath) as import("obsidian").TFile | null;
    if (!file) return;

    try {
      const content = await this._app.vault.read(file);
      let updated: string;

      if (icon === null) {
        // Remove the icon field entirely
        updated = content.replace(/^icon:[ \t]*[^\r\n]*\r?\n/m, "");
      } else {
        const safeIcon = yamlQuoteValue(icon);
        if (/^icon:[ \t]*[^\r\n]*$/m.test(content)) {
          // Update existing icon field (also matches empty `icon:` lines)
          updated = content.replace(/^icon:[ \t]*[^\r\n]*$/m, `icon: ${safeIcon}`);
        } else {
          // Insert icon field into frontmatter
          const fmMatch = content.match(/^(---\r?\n)([\s\S]*?)(^---(?:\r?\n|$))/m);
          if (!fmMatch) return;
          const [fullMatch, openFence, body, closeFence] = fmMatch;
          const eol = openFence.endsWith("\r\n") ? "\r\n" : "\n";
          // When body is empty (---\n---), insert directly after opening fence
          // to avoid a leading blank line.
          const prefix = body.length === 0 ? "" : body.endsWith(eol) ? body : body + eol;
          updated = content.replace(
            fullMatch,
            `${openFence}${prefix}icon: ${safeIcon}${eol}${closeFence}`,
          );
        }
      }

      if (updated !== content) {
        await this._app.vault.modify(file, updated);
      }
    } catch (err) {
      console.error(`[work-terminal] Failed to update icon for ${filePath}:`, err);
    }
  }
}
