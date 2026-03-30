/**
 * PluginBase - abstract Plugin subclass that wires an AdapterBundle to
 * the framework lifecycle: view registration, commands, settings, hot-reload.
 */
import { Plugin } from "obsidian";
import type { AdapterBundle } from "../core/interfaces";
import { SessionPersistence } from "../core/session/SessionPersistence";

export const VIEW_TYPE = "work-terminal-view";

export abstract class PluginBase extends Plugin {
  protected adapter: AdapterBundle;
  private _isReloading = false;

  constructor(app: any, manifest: any, adapter: AdapterBundle) {
    super(app, manifest);
    this.adapter = adapter;
  }

  async onload(): Promise<void> {
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

    this.addSettingTab(new WorkTerminalSettingsTab(this.app, this, this.adapter));
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
      SessionPersistence.saveToDisk(this, shutdownSessions, shutdownPendingPersisted).catch(() => {});
    }
  }
}
