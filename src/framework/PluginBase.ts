/**
 * PluginBase - abstract Plugin subclass that wires an AdapterBundle to
 * the framework lifecycle: view registration, commands, settings, hot-reload.
 */
import { type App, Notice, type PluginManifest, Plugin } from "obsidian";
import type { AdapterBundle } from "../core/interfaces";
import { AgentProfileManager } from "../core/agents/AgentProfileManager";
import type { AgentProfile } from "../core/agents/AgentProfile";
import {
  TaskTabBroker,
  type BrokerRuntimeState,
  type BrokerTerminalHost,
} from "../core/broker/TaskTabBroker";
import {
  createBrokerEndpoint,
  TaskTabBrokerTransport,
} from "../core/broker/TaskTabBrokerTransport";
import type { TerminalTabTarget } from "../core/terminal/TerminalHost";
import { electronRequire } from "../core/utils";
import { resolveVaultBasePath } from "../core/workspace/pluginPaths";
import { TaskCatalogue } from "./TaskCatalogue";
import type { WorkTerminalSettingsTab } from "./SettingsTab";
import { VIEW_TYPE } from "./viewType";

export { VIEW_TYPE };

declare global {
  interface Window {
    __workTerminalBrokerHandoff?: {
      state: BrokerRuntimeState;
      stopping: Promise<void>;
    };
  }
}

export abstract class PluginBase extends Plugin {
  protected adapter: AdapterBundle;
  private _isReloading = false;
  private _lastWorkTerminalLeaf: unknown = null;
  private _settingsTab: WorkTerminalSettingsTab | null = null;
  private _profileManager: AgentProfileManager | null = null;
  private _taskTabBroker: TaskTabBroker | null = null;
  private _taskTabBrokerTransport: TaskTabBrokerTransport | null = null;
  private _brokerVaultId = "";
  private _brokerCatalogue: TaskCatalogue | null = null;
  private _brokerEnabled = false;
  private readonly _handleSettingsChanged = (event: Event) => {
    const settings = (event as CustomEvent<Record<string, unknown>>).detail;
    this._brokerCatalogue = new TaskCatalogue(
      this.adapter.createParser(this.app, "", settings),
      this.adapter,
    );
    void this.setTaskTabBrokerEnabled(settings["core.taskTabBrokerEnabled"] === true);
  };

  constructor(app: App, manifest: PluginManifest, adapter: AdapterBundle) {
    super(app, manifest);
    this.adapter = adapter;
  }

  /** Profile manager instance, available after onload(). */
  get profileManager(): AgentProfileManager | null {
    return this._profileManager;
  }

  async onload(): Promise<void> {
    // Initialize agent profile manager early so both views and settings can use it.
    // Use a local const so the non-null type is retained after the await.
    const profileManager = new AgentProfileManager(this);
    await profileManager.load();
    this._profileManager = profileManager;

    // Defer view/settings registration to allow lazy imports
    const { MainView } = await import("./MainView");
    const { WorkTerminalSettingsTab, loadAllSettings, SETTINGS_CHANGED_EVENT } =
      await import("./SettingsTab");
    const settings = await loadAllSettings(this, this.adapter);
    this._brokerCatalogue = new TaskCatalogue(
      this.adapter.createParser(this.app, "", settings),
      this.adapter,
    );
    this._brokerVaultId = this.resolveBrokerVaultId();
    const handoff = window.__workTerminalBrokerHandoff;
    if (handoff) {
      await handoff.stopping;
      delete window.__workTerminalBrokerHandoff;
    }
    this._taskTabBroker = new TaskTabBroker({
      vaultId: this._brokerVaultId,
      catalogue: {
        listCategories: () => this.requireBrokerCatalogue().listCategories(),
        listTasks: (options) => this.requireBrokerCatalogue().listTasks(options),
        getTask: (taskId) => this.requireBrokerCatalogue().getTask(taskId),
        getSubtasks: (taskId, options) =>
          this.requireBrokerCatalogue().getSubtasks(taskId, options),
        getParentTasks: (taskId, options) =>
          this.requireBrokerCatalogue().getParentTasks(taskId, options),
      },
      getProfileCapabilities: (profileId) =>
        this._profileManager?.getProfile(profileId)?.brokerCapabilities ?? [],
      ...(handoff ? { runtimeState: handoff.state } : {}),
    });
    this._taskTabBrokerTransport = new TaskTabBrokerTransport(
      this._taskTabBroker,
      createBrokerEndpoint(this.resolveBrokerVaultIdentity()),
    );
    this._brokerEnabled = settings["core.taskTabBrokerEnabled"] === true;
    if (this._brokerEnabled) {
      try {
        await this._taskTabBrokerTransport.start();
      } catch {
        console.error("[work-terminal] Could not start the task tab broker");
      }
    }
    window.addEventListener(SETTINGS_CHANGED_EVENT, this._handleSettingsChanged as EventListener);

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

    this._settingsTab = new WorkTerminalSettingsTab(this.app, this, this.adapter, profileManager);
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

    // The new plugin instance re-registered the view type. Force the
    // existing leaf to re-create its view so onOpen() fires and picks
    // up stashed sessions from window store. A plain activateView()
    // would find the stale leaf via getLeavesOfType and just reveal it
    // without re-initialising the view, leaving a blank pane.
    const existingLeaves = appRef.workspace.getLeavesOfType(VIEW_TYPE);
    if (existingLeaves.length > 0) {
      for (const existingLeaf of existingLeaves) {
        await existingLeaf.setViewState({ type: VIEW_TYPE, active: true });
      }
      appRef.workspace.revealLeaf(existingLeaves[0]);
    } else {
      const newPlugin = plugins.plugins["work-terminal"];
      if (newPlugin && typeof newPlugin.activateView === "function") {
        await newPlugin.activateView();
      }
    }
    console.log("[work-terminal] Hot reload complete");
  }

  get isReloading(): boolean {
    return this._isReloading;
  }

  registerTaskTabBrokerHost(host: BrokerTerminalHost): () => void {
    return this._taskTabBroker?.registerHost(this._brokerVaultId, host) ?? (() => undefined);
  }

  createTaskTabBrokerLaunchEnvironment(
    profile: AgentProfile,
    caller: TerminalTabTarget,
  ): NodeJS.ProcessEnv | undefined {
    const capabilities = profile.brokerCapabilities ?? [];
    if (
      !this._brokerEnabled ||
      capabilities.length === 0 ||
      !this._taskTabBroker ||
      !this._taskTabBrokerTransport?.isListening
    ) {
      return undefined;
    }
    try {
      return this._taskTabBroker.issueLaunchContext(
        {
          vaultId: this._brokerVaultId,
          caller,
          profileId: profile.id,
          capabilities,
        },
        this._taskTabBrokerTransport.endpoint,
      );
    } catch (error) {
      console.error("[work-terminal] Could not issue task tab broker context", error);
      return undefined;
    }
  }

  private requireBrokerCatalogue(): TaskCatalogue {
    if (!this._brokerCatalogue) throw new Error("Task catalogue is unavailable");
    return this._brokerCatalogue;
  }

  private resolveBrokerVaultIdentity(): string {
    return resolveVaultBasePath(this.app) || this.app.vault.getName();
  }

  private resolveBrokerVaultId(): string {
    const crypto = electronRequire("crypto") as typeof import("crypto");
    return crypto
      .createHash("sha256")
      .update(this.resolveBrokerVaultIdentity())
      .digest("hex")
      .slice(0, 32);
  }

  private async setTaskTabBrokerEnabled(enabled: boolean): Promise<void> {
    this._brokerEnabled = enabled;
    if (!this._taskTabBroker || !this._taskTabBrokerTransport) return;
    if (enabled) {
      if (!this._taskTabBrokerTransport.isListening) {
        try {
          await this._taskTabBrokerTransport.start();
        } catch {
          console.error("[work-terminal] Could not start the task tab broker");
        }
      }
      return;
    }
    this._taskTabBroker.revokeAllCallers();
    try {
      await this._taskTabBrokerTransport.stop();
    } catch {
      console.error("[work-terminal] Could not cleanly stop the task tab broker");
    }
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
    window.removeEventListener(
      "work-terminal:settings-changed",
      this._handleSettingsChanged as EventListener,
    );
    if (!this._taskTabBroker || !this._taskTabBrokerTransport) return;
    if (this._isReloading) {
      window.__workTerminalBrokerHandoff = {
        state: this._taskTabBroker.exportRuntimeState(),
        stopping: this._taskTabBrokerTransport.stop({ reloading: true }).catch(() => {
          console.error("[work-terminal] Could not cleanly stop the task tab broker for reload");
        }),
      };
      return;
    }
    this._taskTabBroker.revokeAllCallers();
    void this._taskTabBrokerTransport.stop().catch(() => {
      console.error("[work-terminal] Could not cleanly stop the task tab broker");
    });
  }
}
