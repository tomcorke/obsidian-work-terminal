/**
 * PluginBase - abstract Plugin subclass that wires an AdapterBundle to
 * the framework lifecycle: view registration, commands, settings, hot-reload.
 */
import { type App, Notice, type PluginManifest, Plugin } from "obsidian";
import type { AdapterBundle } from "../core/interfaces";
import { AgentProfileManager } from "../core/agents/AgentProfileManager";
import type { WorkTerminalSettingsTab } from "./SettingsTab";
import { SessionPersistence } from "../core/session/SessionPersistence";

export const VIEW_TYPE = "work-terminal-view";

export abstract class PluginBase extends Plugin {
  protected adapter: AdapterBundle;
  private _isReloading = false;
  private _lastWorkTerminalLeaf: unknown = null;
  private _settingsTab: WorkTerminalSettingsTab | null = null;
  private _profileManager: AgentProfileManager | null = null;

  constructor(app: App, manifest: PluginManifest, adapter: AdapterBundle) {
    super(app, manifest);
    this.adapter = adapter;
  }

  /** Profile manager instance, available after onload(). */
  get profileManager(): AgentProfileManager | null {
    return this._profileManager;
  }

  async onload(): Promise<void> {
    // Initialize agent profile manager early so both views and settings can use it
    this._profileManager = new AgentProfileManager(this);
    await this._profileManager.load();

    // Defer view/settings registration to allow lazy imports
    const { MainView } = await import("./MainView");
    const { WorkTerminalSettingsTab } = await import("./SettingsTab");

    this.registerView(VIEW_TYPE, (leaf) => new MainView(leaf, this.adapter, this));

    this.addRibbonIcon("terminal", "Work Terminal", () => this.activateView());

    this.addCommand({
      id: "open-work-terminal",
      name: "Open Work Terminal",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "reload-plugin",
      name: "Reload Plugin (preserve terminals)",
      callback: () => this.hotReload(),
    });

    this.addCommand({
      id: "copy-session-diagnostics",
      name: "Copy Session Diagnostics",
      callback: async () => this.copySessionDiagnostics(),
    });

    this._settingsTab = new WorkTerminalSettingsTab(
      this.app,
      this,
      this.adapter,
      this._profileManager,
    );
    this.addSettingTab(this._settingsTab);
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      const newLeaf = workspace.getLeaf("tab");
      await newLeaf.setViewState({ type: VIEW_TYPE, active: true });
      leaf = newLeaf;
    }
    workspace.revealLeaf(leaf);
  }

  async hotReload(): Promise<void> {
    this._isReloading = true;
    console.log("[work-terminal] Hot reload...");

    // Explicitly stash terminal sessions BEFORE disabling, because
    // disablePlugin's cleanup sequence may trigger selection changes
    // that reset activeItemId before onClose can stash.
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const view = leaf.view as any;
      view?.terminalPanel?.stashAll();
    }

    const appRef = this.app;
    const plugins = (appRef as any).plugins;
    await plugins.disablePlugin("work-terminal");
    await plugins.enablePlugin("work-terminal");

    // The new plugin instance re-registered the view type. Open the view
    // so onOpen() fires and picks up stashed sessions from window store.
    const newPlugin = plugins.plugins["work-terminal"];
    if (newPlugin && typeof newPlugin.activateView === "function") {
      await newPlugin.activateView();
    }
    console.log("[work-terminal] Hot reload complete");
  }

  get isReloading(): boolean {
    return this._isReloading;
  }

  rememberWorkTerminalLeaf(leaf: unknown): void {
    this._lastWorkTerminalLeaf = leaf;
  }

  private async copySessionDiagnostics(): Promise<void> {
    const openWorkTerminalLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    const activeLeaf = (this.app.workspace as { activeLeaf?: unknown }).activeLeaf as
      | { view?: { getViewType?: () => string; copySessionDiagnostics?: () => Promise<boolean> } }
      | undefined;
    const rememberedLeaf = this._lastWorkTerminalLeaf as
      | { view?: { getViewType?: () => string; copySessionDiagnostics?: () => Promise<boolean> } }
      | undefined;
    const lastWorkTerminalLeaf = openWorkTerminalLeaves.find(
      (leaf: unknown) => leaf === rememberedLeaf,
    ) as
      | { view?: { getViewType?: () => string; copySessionDiagnostics?: () => Promise<boolean> } }
      | undefined;
    const workTerminalLeaf =
      activeLeaf?.view?.getViewType?.() === VIEW_TYPE
        ? activeLeaf
        : lastWorkTerminalLeaf?.view?.getViewType?.() === VIEW_TYPE
          ? lastWorkTerminalLeaf
          : openWorkTerminalLeaves[0];
    const copyDiagnostics = (workTerminalLeaf?.view as any)?.copySessionDiagnostics;
    if (typeof copyDiagnostics !== "function") {
      new Notice("Open Work Terminal first to copy session diagnostics");
      return;
    }
    await copyDiagnostics.call(workTerminalLeaf?.view);
  }

  onunload(): void {
    // Best-effort persist as backup - onClose() should have already persisted,
    // but Obsidian may not always honor async cleanup in onClose during shutdown.
    if (!this._isReloading) {
      // Iterate all leaves to persist sessions from every open Work Terminal view
      const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
      const shutdownSessions = new Map<string, any[]>();
      let shutdownPendingPersisted: any[] | undefined;
      for (const leaf of leaves) {
        const view = leaf.view as any;
        const sessions = view?.terminalPanel?.tabManager?.getSessions?.();
        const pendingPersisted = view?.terminalPanel?.getPendingPersistedSessionsForPersist?.();
        if (sessions) {
          for (const [itemId, tabs] of sessions as Map<string, any[]>) {
            const existingTabs = shutdownSessions.get(itemId) || [];
            shutdownSessions.set(itemId, [...existingTabs, ...tabs]);
          }
        }
        if (
          Array.isArray(pendingPersisted) &&
          (!shutdownPendingPersisted || pendingPersisted.length > shutdownPendingPersisted.length)
        ) {
          shutdownPendingPersisted = pendingPersisted;
        }
      }
      if (shutdownSessions.size === 0 && !shutdownPendingPersisted?.length) {
        return;
      }
      // Fire-and-forget: onunload is sync, so we can't await this,
      // but it gives us one more chance to persist before shutdown.
      SessionPersistence.saveToDisk(this, shutdownSessions, shutdownPendingPersisted).catch(
        () => {},
      );
    }
  }
}
