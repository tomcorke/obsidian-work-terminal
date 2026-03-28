import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  injectXtermCss,
  attachScrollButton,
  attachBubbleCapture,
  attachCapturePhase,
  MockWebglAddon,
} = vi.hoisted(() => {
  const injectXtermCss = vi.fn();
  const attachScrollButton = vi.fn();
  const attachBubbleCapture = vi.fn();
  const attachCapturePhase = vi.fn(() => vi.fn());

  class MockWebglAddon {
    static instances: MockWebglAddon[] = [];

    dispose = vi.fn();
    onContextLoss = vi.fn((handler: () => void) => {
      this.handlers.push(handler);
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
  }

  return {
    injectXtermCss,
    attachScrollButton,
    attachBubbleCapture,
    attachCapturePhase,
    MockWebglAddon,
  };
});

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
  WebglAddon: MockWebglAddon,
}));

vi.mock("@xterm/addon-unicode11", () => ({
  Unicode11Addon: class {},
}));

vi.mock("./XtermCss", () => ({
  injectXtermCss,
}));

vi.mock("./ScrollButton", () => ({
  attachScrollButton,
}));

vi.mock("./KeyboardCapture", () => ({
  attachBubbleCapture,
  attachCapturePhase,
}));

vi.mock("../utils", () => ({
  expandTilde: (value: string) => value,
  stripAnsi: (value: string) => value,
  electronRequire: () => ({ shell: { openExternal: vi.fn() } }),
}));

vi.mock("../claude/ClaudeSessionTracker", () => ({
  ClaudeSessionTracker: class {},
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

describe("TerminalTab WebGL recovery", () => {
  beforeEach(() => {
    MockWebglAddon.instances.length = 0;
    vi.clearAllMocks();
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

  it("stashes the live webgl addon reference for hot reload recovery", () => {
    const addon = new MockWebglAddon();
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
      _documentCleanups: [],
      resizeObserver: new MockResizeObserver(() => {}),
      _stateTimer: null,
    });

    expect(tab.stash().webglAddon).toBe(addon);
  });

  it("re-subscribes the restored webgl addon so recovered tabs still handle context loss", () => {
    const addon = new MockWebglAddon();
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
      webglAddon: addon,
      documentListeners: [],
      resizeObserver: new MockResizeObserver(() => {}) as unknown as ResizeObserver,
    };

    const tab = TerminalTab.fromStored(stored, parentEl);

    expect((tab as unknown as { webglAddon: MockWebglAddon | null }).webglAddon).toBe(addon);
    expect(addon.onContextLoss).toHaveBeenCalledTimes(1);

    addon.emitContextLoss();

    expect(addon.dispose).toHaveBeenCalledTimes(1);
    expect((tab as unknown as { webglAddon: MockWebglAddon | null }).webglAddon).toBeNull();
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
      documentListeners: [],
      resizeObserver: new MockResizeObserver(() => {}) as unknown as ResizeObserver,
    };

    const tab = TerminalTab.fromStored(stored, parentEl);

    expect((tab as unknown as { webglAddon: MockWebglAddon | null }).webglAddon).toBeNull();
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

    (tab as unknown as { loadWebglAddon: () => void }).loadWebglAddon();

    expect(MockWebglAddon.instances).toHaveLength(1);
    expect(MockWebglAddon.instances[0].dispose).toHaveBeenCalledTimes(1);
    expect((tab as unknown as { webglAddon: MockWebglAddon | null }).webglAddon).toBeNull();
  });
});
