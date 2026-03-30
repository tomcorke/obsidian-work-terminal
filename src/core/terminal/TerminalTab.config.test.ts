// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockTerminal {
    static lastOptions: Record<string, unknown> | null = null;

    cols = 80;
    rows = 24;
    unicode = { activeVersion: "" };
    buffer = {
      active: {
        baseY: 0,
        cursorY: 0,
        getLine: () => null,
      },
    };

    constructor(options: Record<string, unknown>) {
      MockTerminal.lastOptions = options;
    }

    loadAddon = vi.fn();
    open = vi.fn();
    focus = vi.fn();
    scrollToBottom = vi.fn();
    onResize = vi.fn();
    registerLinkProvider = vi.fn(() => ({ dispose: vi.fn() }));
    write = vi.fn();
  }

  return {
    MockTerminal,
    injectXtermCss: vi.fn(),
    attachScrollButton: vi.fn(),
    attachBubbleCapture: vi.fn(),
    attachCapturePhase: vi.fn(() => vi.fn()),
    electronShell: { openExternal: vi.fn() },
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

vi.mock("../agents/AgentSessionTracker", () => ({
  AgentSessionTracker: class {
    dispose(): void {}
  },
}));

vi.mock("../agents/AgentStateDetector", () => ({
  hasAgentActiveIndicator: () => false,
  hasAgentWaitingIndicator: () => false,
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: mocks.MockTerminal,
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = vi.fn();
  },
}));

vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class {},
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class {},
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    dispose = vi.fn();
    onContextLoss = vi.fn(() => ({ dispose: vi.fn() }));
  },
}));

vi.mock("@xterm/addon-unicode11", () => ({
  Unicode11Addon: class {},
}));

import { TerminalTab } from "./TerminalTab";

class MockResizeObserver {
  observe = vi.fn();
  disconnect = vi.fn();

  constructor(_callback: ResizeObserverCallback) {}
}

describe("TerminalTab keyboard configuration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("ResizeObserver", MockResizeObserver as unknown as typeof ResizeObserver);
    Object.defineProperty(HTMLElement.prototype, "addClass", {
      configurable: true,
      value(this: HTMLElement, cls: string) {
        this.classList.add(cls);
      },
    });
    vi.spyOn(TerminalTab.prototype as never, "startStateTracking").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    mocks.MockTerminal.lastOptions = null;
  });

  it("leaves macOS Option available for printable characters", () => {
    const parentEl = document.createElement("div");

    new TerminalTab(parentEl, "/bin/zsh", "~/repo", "Shell", null, "shell");

    expect(mocks.MockTerminal.lastOptions?.macOptionIsMeta).toBe(false);
  });
});
