import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockWebglAddon {
    static instances: MockWebglAddon[] = [];

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

  return {
    injectXtermCss: vi.fn(),
    attachScrollButton: vi.fn(),
    attachBubbleCapture: vi.fn(),
    attachCapturePhase: vi.fn(() => vi.fn()),
    electronShell: { openExternal: vi.fn() },
    MockWebglAddon,
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
    return {};
  },
}));

vi.mock("../claude/ClaudeSessionTracker", () => ({
  ClaudeSessionTracker: class {
    dispose(): void {}
  },
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {},
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

import { TerminalTab } from "./TerminalTab";

class FakeElement {
  appendChild = vi.fn();
  addEventListener = vi.fn();
  remove = vi.fn();
  hasClass = vi.fn(() => false);
  addClass = vi.fn();
}

class MockResizeObserver {
  observe = vi.fn();
  disconnect = vi.fn();

  constructor(_callback: ResizeObserverCallback) {}
}

describe("TerminalTab hot-reload addon handling", () => {
  beforeEach(() => {
    mocks.MockWebglAddon.instances.length = 0;
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
  });

  it("stashes addon references needed to preserve disposal order after reload", () => {
    const fitAddon = { dispose: vi.fn(), fit: vi.fn() };
    const searchAddon = { dispose: vi.fn() };
    const webLinksAddon = { dispose: vi.fn() };
    const unicode11Addon = { dispose: vi.fn() };
    const webglAddon = { dispose: vi.fn() };
    const resizeObserver = { disconnect: vi.fn(), observe: vi.fn() };

    const tab = Object.assign(Object.create(TerminalTab.prototype), {
      id: "term-1",
      taskPath: "task.md",
      label: "Claude",
      claudeSessionId: "session-1",
      sessionType: "claude",
      terminal: {},
      fitAddon,
      searchAddon,
      webLinksAddon,
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
    const unicode11Addon = { dispose: vi.fn() };
    const webglAddon = { dispose: vi.fn(), onContextLoss: vi.fn(() => ({ dispose: vi.fn() })) };
    const resizeObserver = { disconnect: vi.fn(), observe: vi.fn() };
    const addEventListener = vi.fn();
    const containerEl = {
      addEventListener,
      hasClass: vi.fn(() => false),
    };
    const parentEl = { appendChild: vi.fn() };

    const restored = TerminalTab.fromStored(
      {
        id: "term-1",
        taskPath: "task.md",
        label: "Claude",
        claudeSessionId: "session-1",
        sessionType: "claude",
        terminal: terminal as any,
        fitAddon: fitAddon as any,
        searchAddon: searchAddon as any,
        webLinksAddon: webLinksAddon as any,
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
    expect((restored as any).unicode11Addon).toBe(unicode11Addon);
    expect((restored as any).webglAddon).toBe(webglAddon);
    expect(parentEl.appendChild).toHaveBeenCalledWith(containerEl);
    expect(scrollToBottom).toHaveBeenCalled();
  });

  it("drains xterm's addon manager before terminal disposal for older restored tabs", () => {
    const order: string[] = [];
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
        _addonManager: { dispose: vi.fn(() => order.push("addon-manager")) },
        dispose: vi.fn(() => order.push("terminal")),
      },
      containerEl: { remove: vi.fn(() => order.push("container")) },
    }) as TerminalTab;

    tab.dispose();

    expect(order).toEqual([
      "tracker",
      "cleanup",
      "resize-observer",
      "addon-manager",
      "terminal",
      "container",
    ]);
  });
});

describe("TerminalTab WebGL recovery", () => {
  beforeEach(() => {
    mocks.MockWebglAddon.instances.length = 0;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(TerminalTab.prototype as never, "startStateTracking").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stashes the live webgl addon reference for hot reload recovery", () => {
    const addon = new mocks.MockWebglAddon();
    const tab = Object.create(TerminalTab.prototype) as TerminalTab & Record<string, unknown>;

    Object.assign(tab, {
      id: "term-1",
      taskPath: "task.md",
      label: "Claude",
      claudeSessionId: "session-1",
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
      claudeSessionId: "session-1",
      sessionType: "claude",
      terminal: {
        focus: vi.fn(),
        scrollToBottom: vi.fn(),
        cols: 80,
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

  it("restores a null webgl addon reference for repeated reload cycles", () => {
    const containerEl = new FakeElement() as unknown as HTMLElement;
    const parentEl = new FakeElement() as unknown as HTMLElement;
    const stored = {
      id: "term-1",
      taskPath: "task.md",
      label: "Claude",
      claudeSessionId: "session-1",
      sessionType: "claude" as const,
      terminal: {
        focus: vi.fn(),
        scrollToBottom: vi.fn(),
        cols: 80,
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
});
