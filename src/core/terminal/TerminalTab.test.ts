import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  injectXtermCss: vi.fn(),
  attachScrollButton: vi.fn(),
  attachBubbleCapture: vi.fn(),
  attachCapturePhase: vi.fn(() => vi.fn()),
}));

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
  electronRequire: vi.fn(),
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
  WebglAddon: class {},
}));

vi.mock("@xterm/addon-unicode11", () => ({
  Unicode11Addon: class {},
}));

import { TerminalTab } from "./TerminalTab";

describe("TerminalTab hot-reload addon handling", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.injectXtermCss.mockClear();
    mocks.attachScrollButton.mockClear();
    mocks.attachBubbleCapture.mockClear();
    mocks.attachCapturePhase.mockClear();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        disconnect = vi.fn();
        observe = vi.fn();
      },
    );
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
    const webglAddon = { dispose: vi.fn() };
    const resizeObserver = { disconnect: vi.fn(), observe: vi.fn() };
    const addEventListener = vi.fn();
    const containerEl = {
      addEventListener,
      hasClass: vi.fn(() => false),
    };
    const parentEl = { appendChild: vi.fn() };

    vi.spyOn(TerminalTab.prototype as any, "startStateTracking").mockImplementation(() => {});

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
