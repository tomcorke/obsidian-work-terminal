import { beforeEach, describe, expect, it, vi } from "vitest";

const hoistedMocks = vi.hoisted(() => {
  const profileManagerLoadMock = vi.fn(() => Promise.resolve([]));
  const registerViewMock = vi.fn();
  const addRibbonIconMock = vi.fn();
  const addCommandMock = vi.fn();
  const addSettingTabMock = vi.fn();
  const NoticeMock = vi.fn();
  const AgentProfileManagerMock = vi.fn(function (this: Record<string, unknown>, plugin: unknown) {
    this.plugin = plugin;
    this.load = profileManagerLoadMock;
  });
  const MainViewMock = vi.fn(function (
    this: Record<string, unknown>,
    leaf: unknown,
    adapter: unknown,
    plugin: unknown,
  ) {
    this.leaf = leaf;
    this.adapter = adapter;
    this.plugin = plugin;
  });
  const WorkTerminalSettingsTabMock = vi.fn(function (
    this: Record<string, unknown>,
    app: unknown,
    plugin: unknown,
    adapter: unknown,
    profileManager: unknown,
  ) {
    this.app = app;
    this.plugin = plugin;
    this.adapter = adapter;
    this.profileManager = profileManager;
  });

  return {
    AgentProfileManagerMock,
    MainViewMock,
    NoticeMock,
    WorkTerminalSettingsTabMock,
    addCommandMock,
    addRibbonIconMock,
    addSettingTabMock,
    profileManagerLoadMock,
    registerViewMock,
  };
});

vi.mock("../core/agents/AgentProfileManager", () => ({
  AgentProfileManager: hoistedMocks.AgentProfileManagerMock,
}));

vi.mock("./MainView", () => ({ MainView: hoistedMocks.MainViewMock }));
vi.mock("./SettingsTab", () => ({
  WorkTerminalSettingsTab: hoistedMocks.WorkTerminalSettingsTabMock,
}));

vi.mock("obsidian", () => {
  class Plugin {
    app: unknown;
    manifest: unknown;
    registerView: typeof registerViewMock;
    addRibbonIcon: typeof addRibbonIconMock;
    addCommand: typeof addCommandMock;
    addSettingTab: typeof addSettingTabMock;
    constructor(app: unknown, manifest: unknown) {
      this.app = app;
      this.manifest = manifest;
      this.registerView = hoistedMocks.registerViewMock;
      this.addRibbonIcon = hoistedMocks.addRibbonIconMock;
      this.addCommand = hoistedMocks.addCommandMock;
      this.addSettingTab = hoistedMocks.addSettingTabMock;
    }
  }
  class Notice {
    constructor(msg: string) {
      hoistedMocks.NoticeMock(msg);
    }
  }
  return { Plugin, Notice };
});

const {
  AgentProfileManagerMock,
  MainViewMock,
  NoticeMock,
  WorkTerminalSettingsTabMock,
  addCommandMock,
  addRibbonIconMock,
  addSettingTabMock,
  profileManagerLoadMock,
  registerViewMock,
} = hoistedMocks;

import { PluginBase, VIEW_TYPE } from "./PluginBase";

// Minimal concrete subclass - PluginBase is abstract.
class TestPlugin extends PluginBase {}

function makeAdapter() {
  return {} as any;
}

function makeApp(overrides: Record<string, unknown> = {}) {
  return {
    workspace: {
      getLeavesOfType: vi.fn(() => []),
      getLeaf: vi.fn(() => ({
        setViewState: vi.fn(() => Promise.resolve()),
      })),
      revealLeaf: vi.fn(),
      activeLeaf: undefined,
      ...overrides,
    },
    plugins: {
      disablePlugin: vi.fn(() => Promise.resolve()),
      enablePlugin: vi.fn(() => Promise.resolve()),
      plugins: {} as Record<string, unknown>,
    },
  } as any;
}

function makeManifest() {
  return { id: "work-terminal", name: "Work Terminal", version: "0.1.0" } as any;
}

describe("PluginBase", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    profileManagerLoadMock.mockResolvedValue(undefined);
  });

  describe("VIEW_TYPE constant", () => {
    it("exports the canonical view type string", () => {
      expect(VIEW_TYPE).toBe("work-terminal-view");
    });
  });

  describe("constructor", () => {
    it("stores adapter and exposes null profileManager before onload", () => {
      const app = makeApp();
      const adapter = makeAdapter();
      const plugin = new TestPlugin(app, makeManifest(), adapter);
      expect((plugin as any).adapter).toBe(adapter);
      expect(plugin.profileManager).toBeNull();
    });

    it("isReloading is false initially", () => {
      const app = makeApp();
      const plugin = new TestPlugin(app, makeManifest(), makeAdapter());
      expect(plugin.isReloading).toBe(false);
    });
  });

  describe("onload", () => {
    it("initialises AgentProfileManager and exposes it via getter", async () => {
      const app = makeApp();
      const plugin = new TestPlugin(app, makeManifest(), makeAdapter());
      await plugin.onload();
      expect(AgentProfileManagerMock).toHaveBeenCalledWith(plugin);
      expect(profileManagerLoadMock).toHaveBeenCalledTimes(1);
      expect(plugin.profileManager).toBe(AgentProfileManagerMock.mock.instances[0]);
    });

    it("registers the work-terminal view type", async () => {
      const app = makeApp();
      const plugin = new TestPlugin(app, makeManifest(), makeAdapter());
      await plugin.onload();
      expect(registerViewMock).toHaveBeenCalledWith(VIEW_TYPE, expect.any(Function));
    });

    it("view factory constructs a MainView instance without throwing", async () => {
      const app = makeApp();
      const adapter = makeAdapter();
      const plugin = new TestPlugin(app, makeManifest(), adapter);
      await plugin.onload();
      const [, factory] = registerViewMock.mock.calls[0];
      const leaf = { view: null };
      const mainView = factory(leaf);
      expect(MainViewMock).toHaveBeenCalledWith(leaf, adapter, plugin);
      expect(mainView).toBe(MainViewMock.mock.instances[0]);
    });

    it("adds ribbon icon and three commands", async () => {
      const app = makeApp();
      const plugin = new TestPlugin(app, makeManifest(), makeAdapter());
      await plugin.onload();
      expect(addRibbonIconMock).toHaveBeenCalledWith(
        "terminal",
        "Work Terminal",
        expect.any(Function),
      );
      expect(addCommandMock).toHaveBeenCalledTimes(3);
      const ids = addCommandMock.mock.calls.map((c: any[]) => c[0].id);
      expect(ids).toContain("open-work-terminal");
      expect(ids).toContain("reload-plugin");
      expect(ids).toContain("copy-session-diagnostics");
    });

    it("registers the settings tab", async () => {
      const app = makeApp();
      const adapter = makeAdapter();
      const plugin = new TestPlugin(app, makeManifest(), adapter);
      await plugin.onload();
      expect(WorkTerminalSettingsTabMock).toHaveBeenCalledWith(
        app,
        plugin,
        adapter,
        plugin.profileManager,
      );
      expect(addSettingTabMock).toHaveBeenCalledTimes(1);
      expect(addSettingTabMock).toHaveBeenCalledWith(WorkTerminalSettingsTabMock.mock.instances[0]);
    });
  });

  describe("activateView", () => {
    it("reveals existing leaf when view is already open", async () => {
      const existingLeaf = { setViewState: vi.fn(), view: {} };
      const app = makeApp();
      (app.workspace.getLeavesOfType as any).mockReturnValue([existingLeaf]);
      const plugin = new TestPlugin(app, makeManifest(), makeAdapter());
      await plugin.activateView();
      expect(app.workspace.getLeaf).not.toHaveBeenCalled();
      expect(app.workspace.revealLeaf).toHaveBeenCalledWith(existingLeaf);
    });

    it("creates a new tab leaf and sets view state when no view is open", async () => {
      const newLeaf = { setViewState: vi.fn(() => Promise.resolve()), view: {} };
      const app = makeApp();
      (app.workspace.getLeavesOfType as any).mockReturnValue([]);
      (app.workspace.getLeaf as any).mockReturnValue(newLeaf);
      const plugin = new TestPlugin(app, makeManifest(), makeAdapter());
      await plugin.activateView();
      expect(app.workspace.getLeaf).toHaveBeenCalledWith("tab");
      expect(newLeaf.setViewState).toHaveBeenCalledWith({ type: VIEW_TYPE, active: true });
      expect(app.workspace.revealLeaf).toHaveBeenCalledWith(newLeaf);
    });
  });

  describe("rememberWorkTerminalLeaf", () => {
    it("stores the leaf reference internally", () => {
      const app = makeApp();
      const plugin = new TestPlugin(app, makeManifest(), makeAdapter());
      const leaf = { view: {} };
      plugin.rememberWorkTerminalLeaf(leaf);
      expect((plugin as any)._lastWorkTerminalLeaf).toBe(leaf);
    });
  });

  describe("isReloading", () => {
    it("remains false until hotReload is called", () => {
      const app = makeApp();
      const plugin = new TestPlugin(app, makeManifest(), makeAdapter());
      expect(plugin.isReloading).toBe(false);
    });
  });

  describe("hotReload", () => {
    it("stashes terminal sessions before reloading", async () => {
      const stashAll = vi.fn();
      const fakeLeaf = { view: { terminalPanel: { stashAll } } };
      const app = makeApp();
      (app.workspace.getLeavesOfType as any).mockReturnValue([fakeLeaf]);
      app.plugins.plugins["work-terminal"] = {
        activateView: vi.fn(() => Promise.resolve()),
      };
      const plugin = new TestPlugin(app, makeManifest(), makeAdapter());
      await plugin.hotReload();
      expect(stashAll).toHaveBeenCalledTimes(1);
    });

    it("disables then enables the plugin", async () => {
      const app = makeApp();
      app.plugins.plugins["work-terminal"] = {
        activateView: vi.fn(() => Promise.resolve()),
      };
      const plugin = new TestPlugin(app, makeManifest(), makeAdapter());
      await plugin.hotReload();
      expect(app.plugins.disablePlugin).toHaveBeenCalledWith("work-terminal");
      expect(app.plugins.enablePlugin).toHaveBeenCalledWith("work-terminal");
    });

    it("calls activateView on the new plugin instance after reload", async () => {
      const newActivateView = vi.fn(() => Promise.resolve());
      const app = makeApp();
      app.plugins.plugins["work-terminal"] = { activateView: newActivateView };
      const plugin = new TestPlugin(app, makeManifest(), makeAdapter());
      await plugin.hotReload();
      expect(newActivateView).toHaveBeenCalledTimes(1);
    });

    it("tolerates missing terminalPanel gracefully", async () => {
      const fakeLeaf = { view: {} };
      const app = makeApp();
      (app.workspace.getLeavesOfType as any).mockReturnValue([fakeLeaf]);
      app.plugins.plugins["work-terminal"] = { activateView: vi.fn(() => Promise.resolve()) };
      const plugin = new TestPlugin(app, makeManifest(), makeAdapter());
      await expect(plugin.hotReload()).resolves.toBeUndefined();
    });
  });

  describe("copySessionDiagnostics (via command callback)", () => {
    it("calls copySessionDiagnostics on the active work-terminal view", async () => {
      const copyDiagnostics = vi.fn(() => Promise.resolve(true));
      const fakeView = {
        getViewType: () => VIEW_TYPE,
        copySessionDiagnostics: copyDiagnostics,
      };
      const fakeLeaf = { view: fakeView };
      const app = makeApp({ activeLeaf: fakeLeaf });
      (app.workspace.getLeavesOfType as any).mockReturnValue([fakeLeaf]);
      const plugin = new TestPlugin(app, makeManifest(), makeAdapter());
      await plugin.onload();
      // Find the copy-session-diagnostics command callback.
      const copyCmd = addCommandMock.mock.calls.find(
        (c: any[]) => c[0].id === "copy-session-diagnostics",
      )?.[0];
      expect(copyCmd).toBeDefined();
      await copyCmd!.callback();
      expect(copyDiagnostics).toHaveBeenCalledTimes(1);
    });

    it("shows Notice when no work-terminal leaf is open", async () => {
      const app = makeApp();
      (app.workspace.getLeavesOfType as any).mockReturnValue([]);
      const plugin = new TestPlugin(app, makeManifest(), makeAdapter());
      await plugin.onload();
      const copyCmd = addCommandMock.mock.calls.find(
        (c: any[]) => c[0].id === "copy-session-diagnostics",
      )?.[0];
      await copyCmd!.callback();
      expect(NoticeMock).toHaveBeenCalledTimes(1);
    });

    it("prefers remembered leaf over first leaf in list", async () => {
      const copyA = vi.fn(() => Promise.resolve(true));
      const copyB = vi.fn(() => Promise.resolve(true));
      const leafA = { view: { getViewType: () => VIEW_TYPE, copySessionDiagnostics: copyA } };
      const leafB = { view: { getViewType: () => VIEW_TYPE, copySessionDiagnostics: copyB } };
      const app = makeApp();
      (app.workspace.getLeavesOfType as any).mockReturnValue([leafA, leafB]);
      const plugin = new TestPlugin(app, makeManifest(), makeAdapter());
      plugin.rememberWorkTerminalLeaf(leafB);
      await plugin.onload();
      const copyCmd = addCommandMock.mock.calls.find(
        (c: any[]) => c[0].id === "copy-session-diagnostics",
      )?.[0];
      await copyCmd!.callback();
      expect(copyB).toHaveBeenCalledTimes(1);
      expect(copyA).not.toHaveBeenCalled();
    });
  });
});
