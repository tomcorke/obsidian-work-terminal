import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockWebglAddon {
    static instances: MockWebglAddon[] = [];

    clearTextureAtlas = vi.fn();
    dispose = vi.fn();
    onContextLoss = vi.fn((handler: () => void) => {
      this.handlers.push(handler);
      return {
        dispose: vi.fn(() => {
          this.handlers = this.handlers.filter((candidate) => candidate !== handler);
        }),
      };
    });

    private handlers: Array<() => void> = [];

    constructor() {
      MockWebglAddon.instances.push(this);
    }

    emitContextLoss(): void {
      for (const handler of this.handlers) {
        handler();
      }
    }

    getHandlerCount(): number {
      return this.handlers.length;
    }
  }

  let copilotSessionDetectorStartImpl: ((detector: MockCopilotSessionDetector) => void) | null =
    null;

  class MockCopilotSessionDetector {
    static instances: MockCopilotSessionDetector[] = [];

    onSessionDetected: ((sessionId: string) => void) | null = null;
    start = vi.fn(() => {
      copilotSessionDetectorStartImpl?.(this);
    });
    dispose = vi.fn();

    constructor(_config: unknown) {
      MockCopilotSessionDetector.instances.push(this);
    }
  }

  return {
    injectXtermCss: vi.fn(),
    attachScrollButton: vi.fn(() => vi.fn()),
    attachBubbleCapture: vi.fn(() => vi.fn()),
    attachCapturePhase: vi.fn(() => vi.fn()),
    electronShell: { openExternal: vi.fn() },
    fsModule: {
      existsSync: vi.fn(() => false),
    },
    pathModule: {
      join: (...parts: string[]) => parts.join("/").replace(/\/{2,}/g, "/"),
    },
    MockWebglAddon,
    MockCopilotSessionDetector,
    setCopilotSessionDetectorStartImpl: (
      impl: ((detector: MockCopilotSessionDetector) => void) | null,
    ) => {
      copilotSessionDetectorStartImpl = impl;
    },
  };
});

vi.mock("./XtermCss", () => ({
  injectXtermCss: mocks.injectXtermCss,
}));

vi.mock("./ScrollButton", () => ({
  attachScrollButton: mocks.attachScrollButton,
}));

vi.mock("./KeyboardCapture", () => ({
  attachBubbleCapture: mocks.attachBubbleCapture,
  attachCapturePhase: mocks.attachCapturePhase,
}));

vi.mock("../utils", () => ({
  expandTilde: (value: string) => value,
  stripAnsi: (value: string) => value,
  electronRequire: (moduleName: string) => {
    if (moduleName === "electron") {
      return { shell: mocks.electronShell };
    }
    if (moduleName === "fs") {
      return mocks.fsModule;
    }
    if (moduleName === "path") {
      return mocks.pathModule;
    }
    return {};
  },
}));

vi.mock("../agents/AgentSessionTracker", () => ({
  AgentSessionTracker: class {
    dispose(): void {}
  },
}));

vi.mock("../agents/CopilotSessionDetector", () => ({
  CopilotSessionDetector: mocks.MockCopilotSessionDetector,
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options: Record<string, unknown> = {};
    attachCustomKeyEventHandler = vi.fn();
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {},
}));

vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class {},
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class {},
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: mocks.MockWebglAddon,
}));

vi.mock("@xterm/addon-unicode11", () => ({
  Unicode11Addon: class {},
}));

vi.mock("obsidian", () => ({
  Notice: vi.fn(),
}));

vi.mock("./PythonCheck", () => ({
  checkPython3Available: vi.fn(() => "/usr/bin/python3"),
  hasPython3BeenNotified: vi.fn(() => false),
  markPython3Notified: vi.fn(),
  PYTHON3_MISSING_MESSAGE:
    "Python 3 is required for terminal tabs. Install Python 3.7+ and ensure `python3` is on your PATH.",
}));

import { resolvePtyWrapperPath, TerminalTab } from "./TerminalTab";

class FakeElement {
  appendChild = vi.fn();
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  remove = vi.fn();
  hasClass = vi.fn(() => false);
  addClass = vi.fn();
  removeClass = vi.fn();
  querySelector = vi.fn(() => null);
  querySelectorAll = vi.fn(() => []);
}

class MockResizeObserver {
  observe = vi.fn();
  disconnect = vi.fn();

  constructor(_callback: ResizeObserverCallback) {}
}

describe("TerminalTab hot-reload addon handling", () => {
  beforeEach(() => {
    mocks.MockWebglAddon.instances.length = 0;
    mocks.MockCopilotSessionDetector.instances.length = 0;
    mocks.setCopilotSessionDetectorStartImpl(null);
    vi.restoreAllMocks();
    mocks.injectXtermCss.mockClear();
    mocks.attachScrollButton.mockClear();
    mocks.attachBubbleCapture.mockClear();
    mocks.attachCapturePhase.mockClear();
    mocks.electronShell.openExternal.mockClear();
    vi.stubGlobal("ResizeObserver", MockResizeObserver as unknown as typeof ResizeObserver);
    vi.stubGlobal("requestAnimationFrame", ((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }) as typeof requestAnimationFrame);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(TerminalTab.prototype as never, "startStateTracking").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("stashes addon references needed to preserve disposal order after reload", () => {
    const fitAddon = { dispose: vi.fn(), fit: vi.fn() };
    const searchAddon = { dispose: vi.fn() };
    const webLinksAddon = { dispose: vi.fn() };
    const linkProviderDisposable = { dispose: vi.fn() };
    const unicode11Addon = { dispose: vi.fn() };
    const webglAddon = { dispose: vi.fn() };
    const resizeObserver = { disconnect: vi.fn(), observe: vi.fn() };

    const tab = Object.assign(Object.create(TerminalTab.prototype), {
      id: "term-1",
      taskPath: "task.md",
      label: "Claude",
      agentSessionId: "session-1",
      sessionType: "claude",
      terminal: {},
      fitAddon,
      searchAddon,
      webLinksAddon,
      linkProviderDisposable,
      unicode11Addon,
      webglAddon,
      containerEl: {},
      process: null,
      _documentCleanups: [],
      resizeObserver,
      _stateTimer: null,
      webglContextLossListener: null,
    }) as TerminalTab;

    const stored = tab.stash();

    expect(stored.fitAddon).toBe(fitAddon);
    expect(stored.searchAddon).toBe(searchAddon);
    expect(stored.webLinksAddon).toBe(webLinksAddon);
    expect(stored.linkProviderDisposable).toBe(linkProviderDisposable);
    expect(stored.unicode11Addon).toBe(unicode11Addon);
    expect(stored.webglAddon).toBe(webglAddon);
  });

  it("restores addon references from hot-reload storage", () => {
    const focus = vi.fn();
    const scrollToBottom = vi.fn();
    const terminal = { focus, scrollToBottom, cols: 80 };
    const fitAddon = { dispose: vi.fn(), fit: vi.fn() };
    const searchAddon = { dispose: vi.fn() };
    const webLinksAddon = { dispose: vi.fn() };
    const linkProviderDisposable = { dispose: vi.fn() };
    const unicode11Addon = { dispose: vi.fn() };
    const webglAddon = { dispose: vi.fn(), onContextLoss: vi.fn(() => ({ dispose: vi.fn() })) };
    const resizeObserver = { disconnect: vi.fn(), observe: vi.fn() };
    const addEventListener = vi.fn();
    const containerEl = {
      addEventListener,
      removeEventListener: vi.fn(),
      hasClass: vi.fn(() => false),
      querySelector: vi.fn(() => null),
    };
    const parentEl = { appendChild: vi.fn() };

    const restored = TerminalTab.fromStored(
      {
        id: "term-1",
        taskPath: "task.md",
        label: "Claude",
        agentSessionId: "session-1",
        sessionType: "claude",
        terminal: terminal as any,
        fitAddon: fitAddon as any,
        searchAddon: searchAddon as any,
        webLinksAddon: webLinksAddon as any,
        linkProviderDisposable: linkProviderDisposable as any,
        unicode11Addon: unicode11Addon as any,
        webglAddon: webglAddon as any,
        webglContextLossListener: null,
        containerEl: containerEl as any,
        process: null,
        documentListeners: [],
        resizeObserver: resizeObserver as any,
      },
      parentEl as any,
    );

    expect((restored as any).fitAddon).toBe(fitAddon);
    expect((restored as any).searchAddon).toBe(searchAddon);
    expect((restored as any).webLinksAddon).toBe(webLinksAddon);
    expect((restored as any).linkProviderDisposable).toBe(linkProviderDisposable);
    expect((restored as any).unicode11Addon).toBe(unicode11Addon);
    expect((restored as any).webglAddon).toBe(webglAddon);
    expect(parentEl.appendChild).toHaveBeenCalledWith(containerEl);
    expect(scrollToBottom).toHaveBeenCalled();
  });

  it("restores legacy session ids from hot-reload storage when agentSessionId is missing", () => {
    const restored = TerminalTab.fromStored(
      {
        id: "term-1",
        taskPath: "task.md",
        label: "Claude",
        claudeSessionId: "legacy-session-1",
        sessionType: "claude",
        terminal: { focus: vi.fn(), scrollToBottom: vi.fn(), cols: 80 } as any,
        fitAddon: {} as any,
        searchAddon: {} as any,
        containerEl: {
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          hasClass: vi.fn(() => false),
          querySelector: vi.fn(() => null),
        } as any,
        process: null,
        webglAddon: null,
        webglContextLossListener: null,
        documentListeners: [],
        resizeObserver: { disconnect: vi.fn(), observe: vi.fn() } as any,
      } as any,
      { appendChild: vi.fn() } as any,
    );

    expect(restored.agentSessionId).toBe("legacy-session-1");
  });

  it("sets linkHandler on restored terminals that lack one (pre-fix sessions)", () => {
    const terminal = {
      options: {} as Record<string, unknown>,
      focus: vi.fn(),
      scrollToBottom: vi.fn(),
      cols: 80,
    };

    TerminalTab.fromStored(
      {
        id: "term-1",
        taskPath: "task.md",
        label: "Shell",
        sessionType: "shell",
        terminal: terminal as any,
        fitAddon: {} as any,
        searchAddon: {} as any,
        containerEl: {
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          hasClass: vi.fn(() => false),
          querySelector: vi.fn(() => null),
        } as any,
        process: null,
        webglAddon: null,
        webglContextLossListener: null,
        documentListeners: [],
        resizeObserver: { disconnect: vi.fn(), observe: vi.fn() } as any,
      } as any,
      { appendChild: vi.fn() } as any,
    );

    expect(terminal.options.linkHandler).toBeDefined();
    const handler = terminal.options.linkHandler as {
      activate: (e: MouseEvent, uri: string) => void;
    };
    expect(typeof handler.activate).toBe("function");

    // Verify the handler calls openExternal
    handler.activate({} as MouseEvent, "https://example.com");
    expect(mocks.electronShell.openExternal).toHaveBeenCalledWith("https://example.com");
  });

  it("preserves existing linkHandler on restored terminals", () => {
    const existingHandler = { activate: vi.fn() };
    const terminal = {
      options: { linkHandler: existingHandler } as Record<string, unknown>,
      focus: vi.fn(),
      scrollToBottom: vi.fn(),
      cols: 80,
    };

    TerminalTab.fromStored(
      {
        id: "term-1",
        taskPath: "task.md",
        label: "Shell",
        sessionType: "shell",
        terminal: terminal as any,
        fitAddon: {} as any,
        searchAddon: {} as any,
        containerEl: {
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          hasClass: vi.fn(() => false),
          querySelector: vi.fn(() => null),
        } as any,
        process: null,
        webglAddon: null,
        webglContextLossListener: null,
        documentListeners: [],
        resizeObserver: { disconnect: vi.fn(), observe: vi.fn() } as any,
      } as any,
      { appendChild: vi.fn() } as any,
    );

    // Should not overwrite the existing handler
    expect(terminal.options.linkHandler).toBe(existingHandler);
  });

  it("backfills linkHandler on show() for live terminals missing the handler", () => {
    const tab = Object.assign(Object.create(TerminalTab.prototype), {
      terminal: {
        options: {} as Record<string, unknown>,
        refresh: vi.fn(),
        scrollToBottom: vi.fn(),
        focus: vi.fn(),
        rows: 24,
      },
      containerEl: {
        removeClass: vi.fn(),
        hasClass: vi.fn(() => false),
        querySelectorAll: vi.fn(() => []),
      },
      _isDisposed: false,
      fitAddon: { fit: vi.fn() },
    }) as TerminalTab;

    tab.show();

    const handler = (tab as any).terminal.options.linkHandler as {
      activate: (e: MouseEvent, uri: string) => void;
    };
    expect(handler).toBeDefined();
    expect(typeof handler.activate).toBe("function");

    handler.activate({} as MouseEvent, "https://example.com");
    expect(mocks.electronShell.openExternal).toHaveBeenCalledWith("https://example.com");
  });

  it("disposes the custom link provider before terminal teardown", () => {
    const order: string[] = [];
    const tab = Object.assign(Object.create(TerminalTab.prototype), {
      _sessionTracker: { dispose: vi.fn(() => order.push("tracker")) },
      _stateTimer: null,
      _resizeDebounce: null,
      _spawnTimeout: null,
      _documentCleanups: [],
      resizeObserver: { disconnect: vi.fn(() => order.push("resize-observer")) },
      process: null,
      fitAddon: undefined,
      searchAddon: undefined,
      webLinksAddon: undefined,
      linkProviderDisposable: { dispose: vi.fn(() => order.push("link-provider")) },
      unicode11Addon: undefined,
      webglAddon: null,
      webglContextLossListener: null,
      terminal: {
        _addonManager: { dispose: vi.fn(() => order.push("addon-manager")) },
        dispose: vi.fn(() => order.push("terminal")),
      },
      containerEl: { parentElement: {}, remove: vi.fn(() => order.push("container")) },
    }) as TerminalTab;

    tab.dispose();

    expect(order).toEqual(["tracker", "resize-observer", "link-provider", "terminal", "container"]);
  });

  it("clears legacy link providers for restored sessions created before tracking them", () => {
    const linkProviders = [{ id: "custom-provider" }];
    const terminalDispose = vi.fn();
    const tab = Object.assign(Object.create(TerminalTab.prototype), {
      _sessionTracker: { dispose: vi.fn() },
      _stateTimer: null,
      _resizeDebounce: null,
      _spawnTimeout: null,
      _documentCleanups: [],
      resizeObserver: { disconnect: vi.fn() },
      process: null,
      fitAddon: { dispose: vi.fn() },
      searchAddon: undefined,
      webLinksAddon: undefined,
      linkProviderDisposable: null,
      unicode11Addon: undefined,
      webglAddon: null,
      webglContextLossListener: null,
      terminal: {
        _linkProviderService: { linkProviders },
        _addonManager: { dispose: vi.fn() },
        dispose: terminalDispose,
      },
      containerEl: { remove: vi.fn() },
    }) as TerminalTab;

    tab.dispose();

    expect(linkProviders).toEqual([]);
    expect(terminalDispose).toHaveBeenCalledTimes(1);
  });

  it("detaches the tracked webgl addon before terminal teardown", () => {
    const order: string[] = [];
    const addonEntries = [{ instance: null as unknown }, { instance: { dispose: vi.fn() } }];
    const webglAddon = new mocks.MockWebglAddon();
    webglAddon.dispose.mockImplementation(() => {
      throw new Error("webgl dispose should not be called directly during tab close");
    });
    addonEntries[0].instance = webglAddon;
    const unicodeDispose = vi.fn(() => {
      order.push("unicode");
      addonEntries.splice(
        addonEntries.findIndex((entry) => entry.instance === unicodeAddon),
        1,
      );
    });
    const unicodeAddon = { dispose: unicodeDispose };
    addonEntries[1].instance = unicodeAddon;
    const addonManagerDispose = vi.fn(() => {
      if (addonEntries.length > 0) {
        throw new TypeError("Cannot read properties of undefined (reading '_isDisposed')");
      }
      order.push("addon-manager");
    });
    const terminalDispose = vi.fn(() => {
      addonManagerDispose();
      order.push("terminal");
    });
    const tab = Object.assign(Object.create(TerminalTab.prototype), {
      _sessionTracker: { dispose: vi.fn(() => order.push("tracker")) },
      _stateTimer: null,
      _resizeDebounce: null,
      _spawnTimeout: null,
      _documentCleanups: [],
      resizeObserver: { disconnect: vi.fn(() => order.push("resize-observer")) },
      process: null,
      fitAddon: undefined,
      searchAddon: undefined,
      webLinksAddon: undefined,
      linkProviderDisposable: null,
      unicode11Addon: unicodeAddon,
      webglAddon,
      webglContextLossListener: null,
      terminal: {
        _addonManager: { _addons: addonEntries },
        dispose: terminalDispose,
      },
      containerEl: { parentElement: {}, remove: vi.fn(() => order.push("container")) },
    }) as TerminalTab & {
      trackWebglAddon: (addon: InstanceType<typeof mocks.MockWebglAddon>) => void;
      webglContextLossListener: { dispose: ReturnType<typeof vi.fn> } | null;
    };

    tab.trackWebglAddon(webglAddon);
    const webglListener = tab.webglContextLossListener;
    const originalDispose = webglListener?.dispose;
    if (webglListener && originalDispose) {
      webglListener.dispose = vi.fn(() => {
        order.push("webgl-listener");
        originalDispose();
      });
    }

    expect(webglAddon.getHandlerCount()).toBe(1);

    expect(() => tab.dispose()).not.toThrow();

    expect(webglAddon.dispose).not.toHaveBeenCalled();
    expect(webglListener?.dispose).toHaveBeenCalledTimes(1);
    expect(webglAddon.getHandlerCount()).toBe(0);
    expect(addonEntries).toEqual([]);
    expect(addonManagerDispose).toHaveBeenCalledTimes(1);
    expect(order).toEqual([
      "tracker",
      "resize-observer",
      "webgl-listener",
      "unicode",
      "addon-manager",
      "terminal",
      "container",
    ]);
  });

  it("does not touch xterm's private addon manager for older restored tabs", () => {
    const order: string[] = [];
    const addonManagerDispose = vi.fn(() => order.push("addon-manager"));
    const tab = Object.assign(Object.create(TerminalTab.prototype), {
      _sessionTracker: { dispose: vi.fn(() => order.push("tracker")) },
      _stateTimer: null,
      _resizeDebounce: null,
      _documentCleanups: [vi.fn(() => order.push("cleanup"))],
      resizeObserver: { disconnect: vi.fn(() => order.push("resize-observer")) },
      process: null,
      fitAddon: undefined,
      searchAddon: undefined,
      webLinksAddon: undefined,
      unicode11Addon: undefined,
      webglAddon: null,
      webglContextLossListener: null,
      terminal: {
        _addonManager: { dispose: addonManagerDispose },
        dispose: vi.fn(() => order.push("terminal")),
      },
      containerEl: { parentElement: {}, remove: vi.fn(() => order.push("container")) },
    }) as TerminalTab;

    tab.dispose();

    expect(order).toEqual(["tracker", "cleanup", "resize-observer", "terminal", "container"]);
    expect(addonManagerDispose).not.toHaveBeenCalled();
  });

  it("rehydrates legacy addon refs so restored tabs can close cleanly", () => {
    const fitAddon = {
      dispose: vi.fn(),
      activate: vi.fn(),
      fit: vi.fn(),
      proposeDimensions: vi.fn(),
      constructor: { name: "" },
    };
    const searchAddon = {
      dispose: vi.fn(),
      activate: vi.fn(),
      findNext: vi.fn(),
      findPrevious: vi.fn(),
      clearDecorations: vi.fn(),
      constructor: { name: "c" },
    };
    const webLinksAddon = {
      _handler: vi.fn(),
      _options: {},
      dispose: vi.fn(),
      activate: vi.fn(),
      constructor: { name: "" },
    };
    const unicode11Addon = {
      dispose: vi.fn(),
      activate: Object.assign(vi.fn(), {
        toString: () => "activate(e){e.unicode.register(new t.UnicodeV11)}",
      }),
      constructor: { name: "" },
    };
    const webglAddon = new mocks.MockWebglAddon();
    const addonEntries = [
      { instance: fitAddon, isDisposed: false },
      { instance: searchAddon, isDisposed: false },
      { instance: webLinksAddon, isDisposed: false },
      { instance: unicode11Addon, isDisposed: false },
      { instance: webglAddon, isDisposed: false },
    ];
    const wrapAddonDispose = <T extends { dispose: () => void }>(entry: {
      instance: T;
      isDisposed: boolean;
    }) => {
      const originalDispose = entry.instance.dispose.bind(entry.instance);
      entry.instance.dispose = vi.fn(() => {
        if (entry.isDisposed) return;
        entry.isDisposed = true;
        originalDispose();
        const index = addonEntries.indexOf(entry);
        if (index !== -1) addonEntries.splice(index, 1);
      });
    };
    addonEntries.forEach((entry) => wrapAddonDispose(entry as never));

    const addonManagerDispose = vi.fn(() => {
      if (addonEntries.length > 0) {
        throw new TypeError("Cannot read properties of undefined (reading '_isDisposed')");
      }
    });
    const terminalDispose = vi.fn(() => addonManagerDispose());
    const resizeObserver = { disconnect: vi.fn(), observe: vi.fn() };
    const containerEl = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      hasClass: vi.fn(() => false),
      querySelector: vi.fn(() => null),
      remove: vi.fn(),
      parentElement: {},
    };
    const parentEl = { appendChild: vi.fn() };

    vi.spyOn(TerminalTab.prototype as never, "startStateTracking").mockImplementation(() => {});

    const restored = TerminalTab.fromStored(
      {
        id: "term-1",
        taskPath: "task.md",
        label: "Claude",
        agentSessionId: "session-1",
        sessionType: "claude",
        terminal: {
          focus: vi.fn(),
          scrollToBottom: vi.fn(),
          cols: 80,
          _addonManager: { _addons: addonEntries },
          dispose: terminalDispose,
        } as any,
        fitAddon: undefined as any,
        searchAddon: undefined as any,
        webLinksAddon: undefined,
        linkProviderDisposable: null,
        unicode11Addon: undefined,
        webglAddon: null,
        webglContextLossListener: null,
        containerEl: containerEl as any,
        process: null,
        documentListeners: [],
        resizeObserver: resizeObserver as any,
      },
      parentEl as any,
    );

    const legacyWebglListener = (restored as any).webglContextLossListener as {
      dispose: ReturnType<typeof vi.fn>;
    } | null;

    expect(() => restored.dispose()).not.toThrow();
    expect((restored as any).fitAddon).toBeUndefined();
    expect(addonEntries).toEqual([]);
    expect(fitAddon.dispose).toHaveBeenCalledTimes(1);
    expect(searchAddon.dispose).toHaveBeenCalledTimes(1);
    expect(webLinksAddon.dispose).toHaveBeenCalledTimes(1);
    expect(unicode11Addon.dispose).toHaveBeenCalledTimes(1);
    expect(webglAddon.dispose).not.toHaveBeenCalled();
    expect(webglAddon.onContextLoss).toHaveBeenCalledTimes(1);
    expect(legacyWebglListener?.dispose).toHaveBeenCalledTimes(1);
    expect(webglAddon.getHandlerCount()).toBe(0);
    expect(addonManagerDispose).toHaveBeenCalledTimes(1);
    expect(containerEl.remove).toHaveBeenCalledTimes(1);
  });

  it("skips the addon manager fallback when tracked addon refs are available", () => {
    const fitDispose = vi.fn();
    const addonManagerDispose = vi.fn();
    const terminalDispose = vi.fn();
    const tab = Object.assign(Object.create(TerminalTab.prototype), {
      _sessionTracker: { dispose: vi.fn() },
      _stateTimer: null,
      _resizeDebounce: null,
      _documentCleanups: [],
      resizeObserver: { disconnect: vi.fn() },
      process: null,
      fitAddon: { dispose: fitDispose },
      searchAddon: undefined,
      webLinksAddon: undefined,
      unicode11Addon: undefined,
      webglAddon: null,
      webglContextLossListener: null,
      terminal: {
        _addonManager: { dispose: addonManagerDispose },
        dispose: terminalDispose,
      },
      containerEl: { remove: vi.fn() },
    }) as TerminalTab;

    tab.dispose();

    expect(fitDispose).toHaveBeenCalledTimes(1);
    expect(addonManagerDispose).not.toHaveBeenCalled();
    expect(terminalDispose).toHaveBeenCalledTimes(1);
  });

  it("reports renderer and process diagnostics for live tabs", () => {
    const querySelectorAll = vi.fn(() => []);
    const hasBlankRenderSurface = vi.fn(() => true);
    const tab = Object.assign(Object.create(TerminalTab.prototype), {
      id: "term-1",
      label: "Claude",
      agentSessionId: "session-1",
      sessionType: "claude",
      process: {
        pid: 321,
        killed: false,
        exitCode: null,
        signalCode: null,
      },
      spawnTime: Date.now() - 2000,
      webglAddon: { dispose: vi.fn() },
      terminal: {
        element: {
          querySelectorAll,
        },
      },
      containerEl: {
        hasClass: vi.fn(() => false),
        querySelectorAll: vi.fn(() => []),
      },
      _agentState: "idle",
      _isResumableAgent: true,
      _isDisposed: false,
      _readTerminalScreen: vi.fn(() => ["line 1", "line 2"]),
      hasRenderableSessionContent: vi.fn(() => true),
      hasBlankRenderSurface,
      getTrackedWebglAddonEntry: vi.fn(() => ({ isDisposed: true })),
    }) as TerminalTab;

    const diagnostics = tab.getDiagnostics();

    expect(diagnostics).toMatchObject({
      tabId: "term-1",
      label: "Claude",
      sessionId: "session-1",
      sessionType: "claude",
      claudeState: "idle",
      isResumableAgent: true,
      isVisible: true,
      isDisposed: false,
      process: {
        pid: 321,
        status: "alive",
      },
      renderer: {
        canvasCount: 0,
        hasRenderableContent: true,
        hasBlankRenderSurface: true,
        trackedWebglAddonPresent: true,
        trackedWebglAddonDisposed: true,
        staleDisposedWebglOwnership: true,
      },
      buffer: {
        screenLineCount: 2,
        screenTail: ["[redacted:6 chars]", "[redacted:6 chars]"],
      },
      derived: {
        blankButLiveRenderer: true,
        staleDisposedWebglOwnership: true,
      },
    });
    expect(querySelectorAll).toHaveBeenCalledTimes(1);
    expect(hasBlankRenderSurface).not.toHaveBeenCalled();
  });
});

describe("resolvePtyWrapperPath", () => {
  beforeEach(() => {
    mocks.fsModule.existsSync.mockReset();
    mocks.fsModule.existsSync.mockReturnValue(false);
  });

  it("prefers the runtime plugin install directory when the wrapper exists there", () => {
    const pluginDir = "/vault/.obsidian/plugins/work-terminal";
    const expected = `${pluginDir}/pty-wrapper.py`;
    mocks.fsModule.existsSync.mockImplementation((candidate: string) => candidate === expected);

    expect(resolvePtyWrapperPath(pluginDir)).toBe(expected);
    expect(mocks.fsModule.existsSync).toHaveBeenCalledWith(expected);
  });

  it("falls back to the bundled dirname path when the plugin directory copy is missing", () => {
    const bundledPath = mocks.pathModule.join(__dirname, "pty-wrapper.py");
    mocks.fsModule.existsSync.mockImplementation((candidate: string) => candidate === bundledPath);

    expect(resolvePtyWrapperPath("/vault/.obsidian/plugins/work-terminal")).toBe(bundledPath);
  });

  it("returns the plugin directory candidate when no wrapper candidate exists", () => {
    const pluginDir = "/vault/.obsidian/plugins/work-terminal";

    expect(resolvePtyWrapperPath(pluginDir)).toBe(`${pluginDir}/pty-wrapper.py`);
  });
});

describe("TerminalTab WebGL recovery", () => {
  beforeEach(() => {
    mocks.MockWebglAddon.instances.length = 0;
    vi.stubGlobal("ResizeObserver", MockResizeObserver as unknown as typeof ResizeObserver);
    vi.stubGlobal("requestAnimationFrame", ((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }) as typeof requestAnimationFrame);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(TerminalTab.prototype as never, "startStateTracking").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("stashes the live webgl addon reference for hot reload recovery", () => {
    const addon = new mocks.MockWebglAddon();
    const tab = Object.create(TerminalTab.prototype) as TerminalTab & Record<string, unknown>;

    Object.assign(tab, {
      id: "term-1",
      taskPath: "task.md",
      label: "Claude",
      agentSessionId: "session-1",
      sessionType: "claude",
      terminal: {},
      fitAddon: {},
      searchAddon: {},
      containerEl: new FakeElement(),
      process: null,
      webglAddon: addon,
      webglContextLossListener: null,
      _documentCleanups: [],
      resizeObserver: new MockResizeObserver(() => {}),
      _stateTimer: null,
    });

    (
      tab as unknown as {
        trackWebglAddon: (addon: InstanceType<typeof mocks.MockWebglAddon>) => void;
      }
    ).trackWebglAddon(addon);

    const stored = tab.stash();

    expect(stored.webglAddon).toBe(addon);
    expect(stored.webglContextLossListener).not.toBeNull();
    expect(addon.getHandlerCount()).toBe(1);
  });

  it("moves the context-loss handler to the restored tab during hot reload recovery", () => {
    const addon = new mocks.MockWebglAddon();
    const originalTab = Object.create(TerminalTab.prototype) as TerminalTab &
      Record<string, unknown>;
    const containerEl = new FakeElement() as unknown as HTMLElement;
    const parentEl = new FakeElement() as unknown as HTMLElement;

    Object.assign(originalTab, {
      id: "term-1",
      taskPath: "task.md",
      label: "Claude",
      agentSessionId: "session-1",
      sessionType: "claude",
      terminal: {
        focus: vi.fn(),
        scrollToBottom: vi.fn(),
        refresh: vi.fn(),
        cols: 80,
        rows: 24,
      },
      fitAddon: {},
      searchAddon: {},
      containerEl,
      process: null,
      webglAddon: null,
      webglContextLossListener: null,
      _documentCleanups: [],
      resizeObserver: new MockResizeObserver(() => {}),
      _stateTimer: null,
    });

    (
      originalTab as unknown as {
        trackWebglAddon: (addon: InstanceType<typeof mocks.MockWebglAddon>) => void;
      }
    ).trackWebglAddon(addon);

    expect(addon.getHandlerCount()).toBe(1);

    const stored = originalTab.stash();

    expect(stored.webglContextLossListener).not.toBeNull();
    expect(addon.getHandlerCount()).toBe(1);

    const tab = TerminalTab.fromStored(stored, parentEl);

    expect(
      (tab as unknown as { webglAddon: InstanceType<typeof mocks.MockWebglAddon> | null })
        .webglAddon,
    ).toBe(addon);
    expect(addon.onContextLoss).toHaveBeenCalledTimes(2);
    expect(addon.getHandlerCount()).toBe(1);

    addon.emitContextLoss();

    expect(addon.dispose).toHaveBeenCalledTimes(1);
    expect(
      (tab as unknown as { webglAddon: InstanceType<typeof mocks.MockWebglAddon> | null })
        .webglAddon,
    ).toBeNull();
    expect(addon.getHandlerCount()).toBe(0);
  });

  it("recovers a restored tab when its carried webgl addon is already disposed", () => {
    const staleAddon = new mocks.MockWebglAddon();
    const storedListener = { dispose: vi.fn() };
    const loadedAddons: unknown[] = [];
    const fit = vi.fn();
    const refresh = vi.fn();
    const scrollToBottom = vi.fn();
    const focus = vi.fn();
    const containerEl = new FakeElement() as unknown as HTMLElement;
    const parentEl = new FakeElement() as unknown as HTMLElement;
    const addonEntries = [{ instance: staleAddon, isDisposed: true }];
    const stored = {
      id: "term-1",
      taskPath: "task.md",
      label: "Claude",
      agentSessionId: "session-1",
      sessionType: "claude" as const,
      terminal: {
        focus,
        scrollToBottom,
        refresh,
        cols: 80,
        rows: 24,
        element: {
          querySelectorAll: vi.fn((selector: string) => {
            if (selector === ".xterm-screen canvas") return [];
            return [];
          }),
        },
        loadAddon: vi.fn((addon: unknown) => loadedAddons.push(addon)),
        buffer: {
          active: {
            baseY: 0,
            cursorY: 0,
            getLine: (index: number) =>
              index === 0 ? { translateToString: () => "prompt>" } : null,
          },
        },
        _addonManager: {
          _addons: addonEntries,
        },
      },
      fitAddon: { fit },
      searchAddon: {},
      containerEl,
      process: { killed: false, exitCode: null, signalCode: null },
      webglAddon: staleAddon,
      webglContextLossListener: storedListener,
      documentListeners: [],
      resizeObserver: new MockResizeObserver(() => {}) as unknown as ResizeObserver,
    };

    const tab = TerminalTab.fromStored(stored, parentEl);

    tab.show();

    expect(storedListener.dispose).toHaveBeenCalledTimes(1);
    expect(parentEl.appendChild).toHaveBeenCalledWith(containerEl);
    expect(containerEl.removeClass).toHaveBeenCalledWith("hidden");
    expect(loadedAddons).toHaveLength(1);
    expect(loadedAddons[0]).toBeInstanceOf(mocks.MockWebglAddon);
    expect((tab as unknown as { webglAddon: unknown }).webglAddon).toBe(loadedAddons[0]);
    expect(staleAddon.getHandlerCount()).toBe(0);
    expect(fit).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenNthCalledWith(1, 0, 23);
    expect(refresh).toHaveBeenNthCalledWith(2, 0, 23);
    expect(scrollToBottom).toHaveBeenCalledTimes(3);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(
      (
        tab.terminal as unknown as {
          _addonManager: { _addons: Array<{ instance: unknown; isDisposed?: boolean }> };
        }
      )._addonManager._addons.some((entry) => entry.instance === staleAddon),
    ).toBe(false);
    expect(
      (
        tab.terminal as unknown as {
          _addonManager: { _addons: Array<{ instance: unknown; isDisposed?: boolean }> };
        }
      )._addonManager._addons,
    ).toBe(addonEntries);
  });

  it("restores a null webgl addon reference for repeated reload cycles", () => {
    const containerEl = new FakeElement() as unknown as HTMLElement;
    const parentEl = new FakeElement() as unknown as HTMLElement;
    const stored = {
      id: "term-1",
      taskPath: "task.md",
      label: "Claude",
      agentSessionId: "session-1",
      sessionType: "claude" as const,
      terminal: {
        focus: vi.fn(),
        scrollToBottom: vi.fn(),
        refresh: vi.fn(),
        cols: 80,
        rows: 24,
      },
      fitAddon: {},
      searchAddon: {},
      containerEl,
      process: null,
      webglAddon: null,
      webglContextLossListener: null,
      documentListeners: [],
      resizeObserver: new MockResizeObserver(() => {}) as unknown as ResizeObserver,
    };

    const tab = TerminalTab.fromStored(stored, parentEl);

    expect(
      (tab as unknown as { webglAddon: InstanceType<typeof mocks.MockWebglAddon> | null })
        .webglAddon,
    ).toBeNull();
    expect(tab.stash().webglAddon).toBeNull();
  });

  it("rebinds a legacy-restored webgl addon to the new tab's context-loss handler", () => {
    const addon = new mocks.MockWebglAddon();
    const terminalRefresh = vi.fn();
    const containerEl = new FakeElement() as unknown as HTMLElement;
    const parentEl = new FakeElement() as unknown as HTMLElement;
    const stored = {
      id: "term-1",
      taskPath: "task.md",
      label: "Claude",
      agentSessionId: "session-1",
      sessionType: "claude" as const,
      terminal: {
        focus: vi.fn(),
        scrollToBottom: vi.fn(),
        refresh: terminalRefresh,
        cols: 80,
        rows: 24,
        _addonManager: {
          _addons: [{ instance: addon, isDisposed: false }],
        },
      },
      fitAddon: {},
      searchAddon: {},
      containerEl,
      process: null,
      webglAddon: null,
      webglContextLossListener: null,
      documentListeners: [],
      resizeObserver: new MockResizeObserver(() => {}) as unknown as ResizeObserver,
    };

    const tab = TerminalTab.fromStored(stored, parentEl);

    expect(
      (tab as unknown as { webglAddon: InstanceType<typeof mocks.MockWebglAddon> | null })
        .webglAddon,
    ).toBe(addon);
    expect(addon.onContextLoss).toHaveBeenCalledTimes(1);
    expect(addon.getHandlerCount()).toBe(1);

    addon.emitContextLoss();

    expect(addon.dispose).toHaveBeenCalledTimes(1);
    expect(
      (tab as unknown as { webglAddon: InstanceType<typeof mocks.MockWebglAddon> | null })
        .webglAddon,
    ).toBeNull();
    expect(addon.getHandlerCount()).toBe(0);
    expect(terminalRefresh).toHaveBeenCalledWith(0, 23);
  });

  it("disposes a created webgl addon if terminal.loadAddon throws", () => {
    const tab = Object.create(TerminalTab.prototype) as TerminalTab & Record<string, unknown>;
    tab.terminal = {
      loadAddon: vi.fn(() => {
        throw new Error("load failed");
      }),
    } as never;
    tab.webglAddon = null;
    tab.webglContextLossListener = null;

    (tab as unknown as { loadWebglAddon: () => void }).loadWebglAddon();

    expect(mocks.MockWebglAddon.instances).toHaveLength(1);
    expect(mocks.MockWebglAddon.instances[0].dispose).toHaveBeenCalledTimes(1);
    expect(mocks.MockWebglAddon.instances[0].getHandlerCount()).toBe(0);
    expect(
      (tab as unknown as { webglAddon: InstanceType<typeof mocks.MockWebglAddon> | null })
        .webglAddon,
    ).toBeNull();
  });

  it("recovers a visible blank renderer when the tracked webgl addon is already disposed", () => {
    const staleAddon = new mocks.MockWebglAddon();
    const loadedAddons: unknown[] = [];
    const fit = vi.fn();
    const refresh = vi.fn();
    const scrollToBottom = vi.fn();
    const focus = vi.fn();
    const screenLines = [{ translateToString: () => "prompt>" }];
    const terminalElement = {
      querySelectorAll: vi.fn((selector: string) => {
        if (selector === ".xterm-screen canvas") return [];
        return [];
      }),
    };
    const containerEl = new FakeElement() as unknown as HTMLElement;
    const tab = Object.create(TerminalTab.prototype) as TerminalTab & Record<string, unknown>;

    Object.assign(tab, {
      _isDisposed: false,
      webglAddon: staleAddon,
      webglContextLossListener: { dispose: vi.fn() },
      fitAddon: { fit },
      process: { killed: false },
      containerEl,
      terminal: {
        rows: 24,
        cols: 80,
        element: terminalElement,
        loadAddon: vi.fn((addon: unknown) => loadedAddons.push(addon)),
        refresh,
        scrollToBottom,
        focus,
        buffer: {
          active: {
            baseY: 0,
            cursorY: 0,
            getLine: (index: number) => screenLines[index] ?? null,
          },
        },
        _addonManager: {
          _addons: [{ instance: staleAddon, isDisposed: true }],
        },
      },
    });

    tab.show();

    expect(containerEl.removeClass).toHaveBeenCalledWith("hidden");
    expect(loadedAddons).toHaveLength(1);
    expect(loadedAddons[0]).toBeInstanceOf(mocks.MockWebglAddon);
    expect((tab as unknown as { webglAddon: unknown }).webglAddon).toBe(loadedAddons[0]);
    expect(staleAddon.getHandlerCount()).toBe(0);
    expect(fit).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenNthCalledWith(1, 0, 23);
    expect(refresh).toHaveBeenNthCalledWith(2, 0, 23);
    expect(scrollToBottom).toHaveBeenCalledTimes(2);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(
      (
        tab.terminal as unknown as {
          _addonManager: { _addons: Array<{ instance: unknown; isDisposed?: boolean }> };
        }
      )._addonManager._addons.some((entry) => entry.instance === staleAddon),
    ).toBe(false);
  });

  it("does not reload webgl when the visible renderer is healthy", () => {
    const addon = new mocks.MockWebglAddon();
    const loadAddon = vi.fn();
    const refresh = vi.fn();
    const tab = Object.create(TerminalTab.prototype) as TerminalTab & Record<string, unknown>;

    Object.assign(tab, {
      _isDisposed: false,
      webglAddon: addon,
      webglContextLossListener: { dispose: vi.fn() },
      fitAddon: { fit: vi.fn() },
      process: { killed: false },
      containerEl: new FakeElement(),
      terminal: {
        rows: 24,
        cols: 80,
        element: {
          querySelectorAll: vi.fn((selector: string) => {
            if (selector === ".xterm-screen canvas") return [{}, {}, {}];
            return [];
          }),
        },
        loadAddon,
        refresh,
        scrollToBottom: vi.fn(),
        focus: vi.fn(),
        buffer: {
          active: {
            baseY: 0,
            cursorY: 0,
            getLine: () => ({ translateToString: () => "prompt>" }),
          },
        },
        _addonManager: {
          _addons: [{ instance: addon, isDisposed: true }],
        },
      },
    });

    tab.show();

    expect(loadAddon).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect((tab as unknown as { webglAddon: unknown }).webglAddon).toBe(addon);
  });

  it("does not recover when the process has already exited and the buffer is empty", () => {
    const staleAddon = new mocks.MockWebglAddon();
    const loadAddon = vi.fn();
    const refresh = vi.fn();
    const tab = Object.create(TerminalTab.prototype) as TerminalTab & Record<string, unknown>;

    Object.assign(tab, {
      _isDisposed: false,
      webglAddon: staleAddon,
      webglContextLossListener: { dispose: vi.fn() },
      fitAddon: { fit: vi.fn() },
      process: { killed: false, exitCode: 0, signalCode: null },
      containerEl: new FakeElement(),
      terminal: {
        rows: 24,
        cols: 80,
        element: {
          querySelectorAll: vi.fn((selector: string) => {
            if (selector === ".xterm-screen canvas") return [];
            return [];
          }),
        },
        loadAddon,
        refresh,
        scrollToBottom: vi.fn(),
        focus: vi.fn(),
        buffer: {
          active: {
            baseY: 0,
            cursorY: 0,
            getLine: () => null,
          },
        },
        _addonManager: {
          _addons: [{ instance: staleAddon, isDisposed: true }],
        },
      },
    });

    tab.show();

    expect(loadAddon).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect((tab as unknown as { webglAddon: unknown }).webglAddon).toBe(staleAddon);
  });
});

describe("TerminalTab auto-scroll on write", () => {
  beforeEach(() => {
    mocks.MockWebglAddon.instances.length = 0;
    vi.restoreAllMocks();
    mocks.injectXtermCss.mockClear();
    mocks.attachScrollButton.mockClear();
    mocks.attachBubbleCapture.mockClear();
    mocks.attachCapturePhase.mockClear();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe = vi.fn();
        disconnect = vi.fn();
      },
    );
    vi.stubGlobal("requestAnimationFrame", ((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    }) as typeof requestAnimationFrame);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(TerminalTab.prototype as never, "startStateTracking").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function createTabWithMockTerminal({ deferCallbacks = false } = {}) {
    const onDataHandlers: Array<(data: string) => void> = [];
    const scrollToBottom = vi.fn();
    const pendingCallbacks: Array<() => void> = [];
    const write = vi.fn((data: unknown, callback?: () => void) => {
      if (callback) {
        if (deferCallbacks) {
          pendingCallbacks.push(callback);
        } else {
          callback();
        }
      }
    });

    const bufferActive = { viewportY: 100, baseY: 100 };

    const terminal = {
      onData: vi.fn((handler: (data: string) => void) => {
        onDataHandlers.push(handler);
      }),
      scrollToBottom,
      write,
      buffer: { active: bufferActive },
    };

    const tab = Object.assign(Object.create(TerminalTab.prototype), {
      id: "term-1",
      taskPath: "task.md",
      label: "Shell",
      sessionType: "shell",
      terminal,
      containerEl: new FakeElement(),
      process: null,
      _isDisposed: false,
      _userScrolledUp: false,
      _programmaticScrollGuards: 0,
      _sessionTracker: null,
      _renameDecoder: { write: () => "", end: () => "" },
      _renameLineBuffer: "",
      _renamePattern: /^\s*[^\w]*Session renamed to:\s*(.+?)\s*$/,
      _recentCleanLines: [],
    }) as TerminalTab;

    /** Flush all deferred write callbacks in order */
    const flushCallbacks = () => {
      while (pendingCallbacks.length > 0) {
        pendingCallbacks.shift()!();
      }
    };

    return { tab, terminal, scrollToBottom, bufferActive, pendingCallbacks, flushCallbacks };
  }

  function createMockProcess() {
    const stdoutHandlers: Record<string, Array<(...args: unknown[]) => void>> = {};
    const procHandlers: Record<string, Array<(...args: unknown[]) => void>> = {};
    return {
      stdout: {
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          (stdoutHandlers[event] ??= []).push(handler);
        }),
      },
      stderr: { on: vi.fn() },
      stdin: { write: vi.fn(), destroyed: false },
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        (procHandlers[event] ??= []).push(handler);
      }),
      killed: false,
      exitCode: null,
      signalCode: null,
      emitStdout(data: Buffer) {
        for (const handler of stdoutHandlers["data"] ?? []) handler(data);
      },
    };
  }

  it("always auto-scrolls to bottom on stdout data by default", () => {
    const { tab, scrollToBottom } = createTabWithMockTerminal();
    const proc = createMockProcess();

    (tab as any).wireProcess(proc);
    scrollToBottom.mockClear();

    proc.emitStdout(Buffer.from("hello"));

    expect(scrollToBottom).toHaveBeenCalledTimes(1);
  });

  it("does not auto-scroll when _userScrolledUp flag is set", () => {
    const { tab, scrollToBottom } = createTabWithMockTerminal();
    const proc = createMockProcess();

    (tab as any).wireProcess(proc);
    scrollToBottom.mockClear();

    // Simulate user having scrolled up (set by wheel/touchmove/keydown listeners)
    tab._userScrolledUp = true;

    proc.emitStdout(Buffer.from("hello"));

    expect(scrollToBottom).not.toHaveBeenCalled();
  });

  it("resumes auto-scroll when _userScrolledUp flag is cleared", () => {
    const { tab, scrollToBottom } = createTabWithMockTerminal();
    const proc = createMockProcess();

    (tab as any).wireProcess(proc);
    scrollToBottom.mockClear();

    // User scrolled up
    tab._userScrolledUp = true;
    proc.emitStdout(Buffer.from("hello"));
    expect(scrollToBottom).not.toHaveBeenCalled();

    // User scrolls back to bottom (flag cleared by scroll/button handler)
    tab._userScrolledUp = false;
    proc.emitStdout(Buffer.from("world"));
    expect(scrollToBottom).toHaveBeenCalledTimes(1);
  });

  it("auto-scrolls all deferred writes when user has not scrolled up", () => {
    const { tab, scrollToBottom, flushCallbacks } = createTabWithMockTerminal({
      deferCallbacks: true,
    });
    const proc = createMockProcess();

    (tab as any).wireProcess(proc);
    scrollToBottom.mockClear();

    // Two writes arrive while user has not scrolled up
    proc.emitStdout(Buffer.from("chunk-1"));
    proc.emitStdout(Buffer.from("chunk-2"));

    expect(scrollToBottom).not.toHaveBeenCalled();

    // Flush all deferred callbacks - both should auto-scroll
    flushCallbacks();
    expect(scrollToBottom).toHaveBeenCalledTimes(2);
  });

  it("suppresses all deferred writes when user scrolls up before flush", () => {
    const { tab, scrollToBottom, flushCallbacks } = createTabWithMockTerminal({
      deferCallbacks: true,
    });
    const proc = createMockProcess();

    (tab as any).wireProcess(proc);
    scrollToBottom.mockClear();

    // Writes arrive
    proc.emitStdout(Buffer.from("chunk-1"));
    proc.emitStdout(Buffer.from("chunk-2"));

    // User scrolls up before callbacks fire
    tab._userScrolledUp = true;

    flushCallbacks();
    expect(scrollToBottom).not.toHaveBeenCalled();
  });

  it("keeps the native scroll guard active until the write frame settles", () => {
    const rafCallbacks: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", ((cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    }) as typeof requestAnimationFrame);

    const { tab, flushCallbacks } = createTabWithMockTerminal({
      deferCallbacks: true,
    });
    const proc = createMockProcess();

    (tab as any).wireProcess(proc);

    proc.emitStdout(Buffer.from("chunk-1"));
    expect(tab._programmaticScrollGuards).toBe(1);

    flushCallbacks();
    expect(tab._programmaticScrollGuards).toBe(1);

    const clearGuard = rafCallbacks.shift();
    expect(clearGuard).toBeDefined();
    clearGuard?.(0);

    expect(tab._programmaticScrollGuards).toBe(0);
  });
});

describe("TerminalTab user scroll detection", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", ((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    }) as typeof requestAnimationFrame);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function createTabWithViewport() {
    const viewportEl = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const containerEl = {
      querySelector: vi.fn((selector: string) =>
        selector === ".xterm-viewport" ? viewportEl : null,
      ),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const bufferActive = { viewportY: 100, baseY: 100 };
    const terminal = {
      buffer: { active: bufferActive },
    };

    const tab = Object.assign(Object.create(TerminalTab.prototype), {
      terminal,
      containerEl,
      _userScrolledUp: false,
      _programmaticScrollGuards: 0,
      _isDisposed: false,
      _documentCleanups: [],
    }) as TerminalTab;

    return { tab, viewportEl, bufferActive };
  }

  it("sets _userScrolledUp when wheel event fires and viewport is not at bottom", () => {
    const { tab, viewportEl, bufferActive } = createTabWithViewport();

    tab._wireUserScrollDetection();

    // Find the wheel listener
    const wheelCall = viewportEl.addEventListener.mock.calls.find(
      (c: unknown[]) => c[0] === "wheel",
    );
    expect(wheelCall).toBeDefined();
    const wheelHandler = wheelCall[1] as () => void;

    // Simulate user scrolling up
    bufferActive.viewportY = 50;
    wheelHandler();

    expect(tab._userScrolledUp).toBe(true);
  });

  it("clears _userScrolledUp when user scrolls back to bottom", () => {
    const { tab, viewportEl, bufferActive } = createTabWithViewport();

    tab._wireUserScrollDetection();
    tab._userScrolledUp = true;

    const wheelCall = viewportEl.addEventListener.mock.calls.find(
      (c: unknown[]) => c[0] === "wheel",
    );
    const wheelHandler = wheelCall[1] as () => void;

    // User scrolls back to bottom
    bufferActive.viewportY = 100;
    wheelHandler();

    expect(tab._userScrolledUp).toBe(false);
  });

  it("ignores native scroll-to-bottom events while programmatic writes are settling", () => {
    const { tab, viewportEl, bufferActive } = createTabWithViewport();

    tab._wireUserScrollDetection();
    tab._userScrolledUp = true;
    tab._programmaticScrollGuards = 1;

    const scrollCall = viewportEl.addEventListener.mock.calls.find(
      (c: unknown[]) => c[0] === "scroll",
    );
    expect(scrollCall).toBeDefined();
    const scrollHandler = scrollCall[1] as () => void;

    bufferActive.viewportY = 100;
    scrollHandler();

    expect(tab._userScrolledUp).toBe(true);
  });

  it("does nothing when no viewport element exists", () => {
    const containerEl = {
      querySelector: vi.fn(() => null),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const tab = Object.assign(Object.create(TerminalTab.prototype), {
      terminal: { buffer: { active: { viewportY: 100, baseY: 100 } } },
      containerEl,
      _userScrolledUp: false,
      _programmaticScrollGuards: 0,
      _isDisposed: false,
      _documentCleanups: [],
    }) as TerminalTab;

    // Should not throw
    tab._wireUserScrollDetection();
    expect(tab._userScrolledUp).toBe(false);
  });
});

describe("TerminalTab deferred session detection and state tracking", () => {
  beforeEach(() => {
    mocks.MockCopilotSessionDetector.instances.length = 0;
    mocks.setCopilotSessionDetectorStartImpl(null);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("_detectResumableAgent returns true when _sessionDetector is active but no session ID", () => {
    const tab = Object.assign(Object.create(TerminalTab.prototype), {
      sessionType: "copilot-with-context",
      agentSessionId: null,
      _sessionDetector: { start: vi.fn(), stop: vi.fn() }, // fake active detector
    }) as TerminalTab;

    const result = (
      tab as never as { _detectResumableAgent: () => boolean }
    )._detectResumableAgent();
    expect(result).toBe(true);
  });

  it("startStateTracking starts timer when _sessionDetector is active (deferred detection)", () => {
    const tab = Object.assign(Object.create(TerminalTab.prototype), {
      sessionType: "copilot-with-context",
      agentSessionId: null,
      _sessionDetector: { start: vi.fn(), stop: vi.fn() },
      _stateTimer: null,
      _agentState: null,
      _recentCleanLines: null,
      _suppressActiveUntil: 0,
      _isResumableAgent: false,
      terminal: { buffer: { active: { cursorY: 0 } } },
    }) as TerminalTab;

    tab.startStateTracking();

    expect((tab as never as { _isResumableAgent: boolean })._isResumableAgent).toBe(true);
    expect((tab as never as { _stateTimer: unknown })._stateTimer).not.toBeNull();

    // Clean up the interval
    clearInterval((tab as never as { _stateTimer: ReturnType<typeof setInterval> })._stateTimer);
  });

  it("startStateTracking is idempotent when synchronous deferred detection fires first", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const tab = Object.assign(Object.create(TerminalTab.prototype), {
      sessionType: "copilot-with-context",
      agentSessionId: null,
      spawnTime: Date.now(),
      _sessionDetector: null,
      _stateTimer: null,
      _agentState: null,
      _recentCleanLines: null,
      _suppressActiveUntil: 0,
      _isResumableAgent: false,
      terminal: { buffer: { active: { cursorY: 0 } } },
    }) as TerminalTab;

    mocks.setCopilotSessionDetectorStartImpl((detector) => {
      detector.onSessionDetected?.("session-123");
    });

    (tab as never as { _initDeferredSessionDetector: () => void })._initDeferredSessionDetector();
    const firstTimer = (tab as never as { _stateTimer: ReturnType<typeof setInterval> })
      ._stateTimer;

    tab.startStateTracking();

    expect((tab as never as { agentSessionId: string | null }).agentSessionId).toBe("session-123");
    expect((tab as never as { _sessionDetector: unknown })._sessionDetector).toBeNull();

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect((tab as never as { _stateTimer: ReturnType<typeof setInterval> })._stateTimer).toBe(
      firstTimer,
    );

    clearInterval(firstTimer);
  });
});
